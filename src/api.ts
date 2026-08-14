/**
 * Client for the smart-execution backend that runs the TWAP algorithm.
 *
 * # How a request proves who it is
 *
 * The browser holds an ECDSA P-256 keypair (see `./signing`). Its public half is
 * bound to the trader's account during onboarding, at the moment Orderly
 * confirms the wallet signed `AddOrderlyKey`; every later request is signed with
 * the private half. So nothing secret is ever transmitted: intercepting a
 * request yields a signature over that one call at that one instant.
 *
 * Three things this replaced, and why:
 *
 * - A **SIWE sign-in**, which asked the trader for a second wallet signature to
 *   establish what the delegation establishes anyway.
 * - A **bearer token**, which was one secret sent on every request and therefore
 *   worth stealing once. A signature is worth stealing for thirty seconds, for
 *   one request that has already happened.
 * - An **`AddOrderlyKey` wallet prompt** of our own. The DEX's "Enable Trading"
 *   flow already delegated an Orderly trading key to this browser; asking the
 *   wallet to sign a second delegation for our executor was one more prompt
 *   proving a fact already proven. Onboarding now *adopts* that existing key:
 *   the plugin reads it from the SDK's keyStore and hands it to the backend
 *   once, over TLS, where it is encrypted at rest and used server-side — a TWAP
 *   must keep working after the tab closes, so the signer cannot live here. The
 *   backend accepts it only after Orderly confirms the key is a live trading
 *   key of this exact account, which is what stops anyone from onboarding an
 *   account whose key they do not hold.
 *
 * (A static `X-API-Key` fallback via `globalThis` remains for local harnesses
 * with no wallet.)
 */

import { getOrCreateKey, dropKey, signRequest, type RequestKey } from "./signing.js";

/**
 * The hosted execution backend. Installing this package is the whole
 * configuration: a DEX adds it to `plugins` and its traders can place TWAPs.
 *
 * Requiring a URL here was wrong for a marketplace module. The installing DEX
 * has no way to know what to put — the backend is ours, not theirs — and the
 * plugin threw at the first call until they guessed it.
 */
const DEFAULT_SERVER_URL = "https://blockfill-api.quantech.services";

/**
 * Base URL to prefix every request with. Resolved at CALL time, because a host
 * page that does override it sets the global after this module is imported.
 *
 * Three cases, and the middle one is the interesting one:
 *
 * - **Unset** — `DEFAULT_SERVER_URL`. The case that matters, because it is what
 *   every marketplace install does.
 * - **An absolute URL** (`https://exec.example.com`) — talk to that host
 *   instead, for self-hosting or a staging backend. It has to be https: the DEX
 *   page is served over https and browsers block http requests from an https
 *   page. `http://localhost` is the exception browsers make, which is worth
 *   knowing because it lets local testing pass in a configuration that would be
 *   blocked anywhere real.
 * - **An empty string** — send relative paths, so requests go to the DEX's own
 *   origin and something in front (a reverse proxy, or Vite's `proxy` in dev)
 *   forwards `/execution`. Deliberate, not missing — which is why the check
 *   below distinguishes `""` from unset rather than testing for falsiness.
 */
function twapServerUrl(): string {
  const url = (globalThis as any).TWAP_SERVER_URL;
  return url === undefined || url === null ? DEFAULT_SERVER_URL : url;
}

/**
 * Execution style for a ticket — the trader's two choices, named by fee side
 * because the whole panel is already a TWAP: a "TWAP" option inside it only
 * confused people. "MAKER" rests PostOnly clips at the L1 touch (maker fees,
 * with a taker sweep near the deadline so the window still holds); "TAKER"
 * crosses the spread as sliced IOC. The server maps these to executor
 * strategies (maker_l1 / signal_twap); it also still accepts "TWAP", the name
 * this option carried in 1.2.0–1.4.0.
 */
export type Strategy = "MAKER" | "TAKER";

/**
 * An onboarded account. Carries no secret — the signing key stays in IndexedDB
 * and `brokerId`/`address` are how we find it again.
 */
export interface Session {
  account_id: string;
  brokerId: string;
  address: string;
  /**
   * The chain the wallet was on when this delegation was signed, which is what
   * decides the Orderly cluster it belongs to.
   *
   * Carried in the session because `account_id` does not distinguish them — the
   * same wallet has the same id on testnet and mainnet — and because it is how
   * the right signing key is found again (`getOrCreateKey`).
   */
  chain_id: number;
  /** When the delegation lapses and the trader must re-enable trading. */
  expires_at: number;
  /**
   * Fingerprint (short SHA-256) of the Orderly key secret this session was
   * built by adopting — NOT the secret, and not derivable back into it.
   *
   * It exists to make rotation detectable: if the DEX re-creates its Orderly
   * key (trader re-ran "Enable Trading", cleared storage, key expired), the
   * backend is still holding the old one and every order it signs will be
   * rejected. `authorize` compares the SDK's current key against this and
   * re-adopts on mismatch instead of returning the stale session. A session
   * from before this field existed never matches, which safely forces one
   * re-adopt (no prompt — adoption is silent).
   */
  key_fp?: string;
}

/**
 * The slice of the SDK's `OrderlyKeyPair` that adoption needs. `secretKey` is
 * base58 of the 32-byte ed25519 seed, stored by the SDK either bare or with an
 * `ed25519:` prefix — both are in the wild and both are accepted.
 */
export interface OrderlyKeyPairLike {
  secretKey: string;
}

/**
 * Minimal EIP-1193 provider.
 *
 * @deprecated No longer used by `authorize` — onboarding adopts the DEX's
 * existing Orderly key instead of asking the wallet to sign a new delegation.
 * The type is kept so imports of it do not break.
 */
export interface WalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<any>;
}

const sessionCache = new Map<string, Session>();

function sessionKey(brokerId: string, address: string, chainId: number): string {
  return `${brokerId}:${address.toLowerCase()}:${chainId}`;
}

/**
 * Sessions also survive a reload in `localStorage`.
 *
 * In memory alone they did not: a TWAP keeps working server-side while the tab
 * is closed, so after a refresh the trader still has live orders — but with an
 * empty cache every read-only call went out unauthenticated and the history
 * came back empty, which reads as "you have no orders".
 *
 * What is stored is not a credential: account id, broker, address and expiry.
 * The secret that authenticates a request never leaves IndexedDB, and is not
 * readable by script even there (see `./signing`).
 *
 * The prefix keeps its original name through the rename to twap-plugin, for the
 * same reason `DB_NAME` does — a session pointing at a signing key must find it.
 */
const SESSION_STORE_PREFIX = "blockfill.session.";

function storage(): Storage | undefined {
  // Undefined during SSR, and access can throw when cookies are blocked.
  try {
    return (globalThis as any).localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a stored session is usable — which means every field, not just an
 * unexpired date.
 *
 * `brokerId` and `address` are checked because they are how the signing key is
 * found, and because a session written by an older build does not have them:
 * it stored a bearer token instead. Such a record looked perfectly live by its
 * expiry and then failed deep inside a request with "Cannot read properties of
 * undefined (reading 'toLowerCase')". Treating a shape we no longer understand
 * as absent sends the trader back through onboarding, which is the only thing
 * that can fix it anyway.
 */
function isLive(session?: Session): boolean {
  return (
    !!session?.account_id &&
    !!session.brokerId &&
    !!session.address &&
    // A session written before sessions knew about clusters has no chain, and
    // there is no safe value to assume: guessing wrong means signing with the
    // other cluster's key, or worse, being taken for the other cluster. Same
    // reasoning as the missing-`brokerId` case above — a shape we no longer
    // understand is treated as absent.
    Number.isFinite(session.chain_id) &&
    session.expires_at - Date.now() > 60_000
  );
}

function rememberSession(key: string, session: Session): void {
  sessionCache.set(key, session);
  try {
    storage()?.setItem(SESSION_STORE_PREFIX + key, JSON.stringify(session));
  } catch {
    /* storage full or blocked — the in-memory cache still works this session */
  }
}

function recallSession(key: string): Session | undefined {
  const store = storage();
  if (!store) return undefined;
  try {
    const raw = store.getItem(SESSION_STORE_PREFIX + key);
    if (!raw) return undefined;
    const session = JSON.parse(raw) as Session;
    if (isLive(session)) return session;
    store.removeItem(SESSION_STORE_PREFIX + key);
  } catch {
    /* unparseable — treat as absent */
  }
  return undefined;
}

/**
 * Drop a session the server has stopped accepting.
 *
 * Not-yet-expired is not the same as still valid: the server may have been
 * redeployed, the delegation revoked, or the account onboarded again from
 * another browser. Without this the panel kept presenting a dead credential
 * every five seconds and rendering the 401 as a load failure, which reads as
 * "something is broken" rather than "sign in again".
 */
function forgetSession(): void {
  sessionCache.clear();
  const store = storage();
  if (!store) return;
  try {
    for (let i = store.length - 1; i >= 0; i--) {
      const k = store.key(i);
      if (k?.startsWith(SESSION_STORE_PREFIX)) store.removeItem(k);
    }
  } catch {
    /* blocked — the in-memory clear above is what matters this session */
  }
}

/**
 * The current session, if one is still valid. Unlike `authorize` this never
 * touches the network or the SDK keyStore — use it for read-only calls, which
 * must work with whatever is already established.
 */
export function peekSession(
  brokerId: string,
  address: string,
  chainId: number,
): Session | undefined {
  const key = sessionKey(brokerId, address, chainId);
  const cached = sessionCache.get(key);
  if (isLive(cached)) return cached;

  const stored = recallSession(key);
  if (stored) sessionCache.set(key, stored);
  return stored;
}

/**
 * Short fingerprint of an Orderly key secret: first 8 bytes of its SHA-256,
 * hex. Enough to detect "a different key than last time" — its only job — and
 * one-way, so storing it in `localStorage` alongside the session leaks nothing
 * about the secret it fingerprints.
 */
async function fingerprintSecret(normalizedSecret: string): Promise<string> {
  const subtle = (globalThis as any).crypto?.subtle as SubtleCrypto | undefined;
  if (!subtle) {
    throw new Error("Web Crypto unavailable — TWAP needs an https:// page");
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(normalizedSecret));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The SDK stores the secret bare or `ed25519:`-prefixed; compare and send one form. */
function normalizeOrderlySecret(secret: string): string {
  const s = secret.trim();
  return s.startsWith("ed25519:") ? s.slice("ed25519:".length) : s;
}

/**
 * Authorize TWAP for `address` under `brokerId`, reusing a stored
 * authorization when there is one.
 *
 * No wallet prompt, ever: instead of asking the trader to sign a second
 * `AddOrderlyKey`, this adopts the Orderly trading key the DEX's own "Enable
 * Trading" flow already delegated. `orderlyKey` is that key, read from the
 * SDK's keyStore by the caller (a React hook, so it cannot be reached from
 * here). Its secret goes to the backend exactly once, over TLS; the backend
 * verifies with Orderly that it is a live trading key of this very account —
 * possession of it is what proves the caller may act for the account — then
 * stores it encrypted so the executor can keep signing after the tab closes.
 *
 * The browser's own request-signing key (`getOrCreateKey`, P-256) is unchanged
 * and still authenticates every later call; its public half rides along and is
 * bound to the account when the adopt clears.
 *
 * A cached session is reused only while it was built from the *same* Orderly
 * key: the caller re-reads the SDK key on every call, and if the DEX rotated
 * it (re-enabled trading, cleared storage) the fingerprint no longer matches
 * and we silently re-adopt rather than let the executor keep signing with a
 * key Orderly may be about to stop honouring.
 *
 * `expectedAccountId` is the SDK's own idea of the account (when the caller
 * has it): a pure client-side sanity check that the wallet/broker pair we
 * derived server-side is the account the DEX session believes it is in.
 *
 * The executor hot-onboards the account within ~60s of this returning.
 */
export async function authorize(
  brokerId: string,
  address: string,
  chain_id: number,
  orderlyKey: OrderlyKeyPairLike,
  expectedAccountId?: string,
): Promise<Session> {
  const key = sessionKey(brokerId, address, chain_id);
  const secret = normalizeOrderlySecret(orderlyKey?.secretKey ?? "");
  if (!secret) {
    // No key in the SDK store: "Enable Trading" has not run (or its storage
    // was cleared). Nothing to adopt — and nothing to prove possession with.
    throw new Error("No Orderly trading key found — enable trading on the exchange first");
  }
  const fp = await fingerprintSecret(secret);

  const cached = peekSession(brokerId, address, chain_id);
  if (cached && cached.key_fp === fp) return cached;

  const requestKey = await getOrCreateKey(brokerId, address, chain_id);
  const res = await fetch(`${twapServerUrl()}/execution/v1/onboard/adopt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wallet_address: address,
      broker_id: brokerId,
      chain_id,
      client_public_key: requestKey.publicKey,
      orderly_key: secret,
    }),
  });
  if (!res.ok) throw new Error(`onboard/adopt ${res.status}: ${await res.text()}`);
  const { account_id, expiration_ms } = (await res.json()) as {
    account_id: string;
    expiration_ms: number;
  };

  if (expectedAccountId && account_id.toLowerCase() !== expectedAccountId.toLowerCase()) {
    // The server derives the account from (wallet, broker); the SDK knows the
    // account its session actually trades. Disagreement means the ticket
    // would target a different account than the one on screen — refuse.
    throw new Error(
      `Account mismatch: exchange session is ${expectedAccountId}, TWAP resolved ${account_id}`,
    );
  }

  const session: Session = {
    account_id,
    brokerId,
    address,
    chain_id,
    expires_at: expiration_ms,
    key_fp: fp,
  };
  rememberSession(key, session);
  return session;
}

/**
 * Send an authenticated request.
 *
 * Everything goes through here so the signed path and the requested path are
 * the same string by construction. Signing `pathAndQuery` separately from
 * building the URL is the obvious way to write this and the obvious way to get
 * a signature that verifies nowhere: any difference in encoding or parameter
 * order, and the server rebuilds different bytes.
 */
async function call(
  method: string,
  pathAndQuery: string,
  session?: Session,
): Promise<Response> {
  let headers: Record<string, string>;
  if (session) {
    const requestKey: RequestKey = await getOrCreateKey(
      session.brokerId,
      session.address,
      session.chain_id,
    );
    headers = await signRequest(requestKey, session.account_id, method, pathAndQuery);
  } else {
    // Local/demo harness with no wallet: the static key path.
    const apiKey = (globalThis as any).TWAP_SESSION_TOKEN ?? "";
    const user = (globalThis as any).TWAP_USER_ID ?? "";
    if (!apiKey || !user) throw new NotSignedInError();
    headers = { "X-API-Key": apiKey, "X-User-Id": user };
  }
  return await fetch(`${twapServerUrl()}${pathAndQuery}`, { method, headers });
}

/**
 * Drop everything identifying this browser to the server, so the next call
 * onboards afresh: the stored session *and* the signing key it refers to.
 *
 * Both, because they are only meaningful together — a key the server no longer
 * has a binding for verifies nothing, and would fail silently forever.
 */
async function forgetAll(session?: Session): Promise<void> {
  forgetSession();
  if (session) await dropKey(session.brokerId, session.address, session.chain_id);
}

export interface TicketProgress {
  ticket_id: string;
  symbol: string;
  /** Trade direction: "BUY" or "SELL". */
  side: string;
  /** Absolute delta size the ticket was placed for — not a target position. */
  size: number;
  /** Cumulative size filled so far. `remaining = size - filled_size`. */
  filled_size: number;
  /**
   * NEW | OPEN | COMPLETE | CANCEL | EXPIRED. EXPIRED is now a real terminal
   * status written by the executor once the ticket's time window elapses (it
   * no longer keeps working past its deadline), so a finished ticket's status
   * alone says why it stopped — there is no separate "still running past its
   * window" state to track here.
   */
  status: string;
  start_time_ms: number;
  time_constraint_ms: number;
  /** Last state change — for a finished ticket, when it ended. */
  last_update_time_ms: number;
  cancel_reason?: string | null;
}

/**
 * Ticket id shortened for display — first 10 and last 4, the form used both in
 * the Bot tab's ID column and the "Placed …" confirmation, so the two never
 * disagree about how an id looks.
 */
export const shortTicketId = (id: string): string => `${id.slice(0, 10)}…${id.slice(-4)}`;

const TICKETS = "/execution/v1/tickets";

/** Fetch one ticket so the panel can show how far execution has got. */
export async function queryTicket(
  ticketId: string,
  session?: Session,
): Promise<TicketProgress | null> {
  const qs = new URLSearchParams({ exchange: "orderly", ticket_id: ticketId });
  const res = await call("GET", `${TICKETS}/queryAllTickets?${qs}`, session);
  if (!res.ok) return null;
  const body = (await res.json()) as { tickets?: TicketProgress[] };
  return body.tickets?.find((t) => t.ticket_id === ticketId) ?? null;
}

/**
 * The account's in-flight ticket for a symbol, if any.
 *
 * A TWAP keeps working after the page is closed, so on mount the panel asks
 * whether one is already running rather than showing nothing until the trader
 * places another.
 */
export async function queryOpenTicket(
  symbol: string,
  session?: Session,
): Promise<TicketProgress | null> {
  const qs = new URLSearchParams({ exchange: "orderly", symbol });
  const res = await call("GET", `${TICKETS}/queryOpenTickets?${qs}`, session);
  if (!res.ok) return null;
  const body = (await res.json()) as { tickets?: TicketProgress[] };
  return body.tickets?.[0] ?? null;
}

/** Stop a working ticket. It keeps whatever has already filled. */
export async function cancelTicket(ticketId: string, session?: Session): Promise<void> {
  const qs = new URLSearchParams({ exchange: "orderly", ticket_id: ticketId });
  const res = await call("DELETE", `${TICKETS}/cancelTicket?${qs}`, session);
  if (res.status === 401 || res.status === 403) {
    await forgetAll(session);
    throw new NotSignedInError();
  }
  if (!res.ok) throw new Error(`cancelTicket ${res.status}: ${await res.text()}`);
}

/**
 * Thrown when a call needs an account and there is no session to name one.
 * A distinct type so the UI can offer to sign in instead of reporting an
 * error — or worse, rendering an empty list as "you have no orders".
 */
export class NotSignedInError extends Error {
  constructor() {
    super("not signed in");
    this.name = "NotSignedInError";
  }
}

/**
 * Thrown when the server rejects an order with code 3009 ("executor is not
 * alive") — the account's execution context is not provisioned right now.
 *
 * For a trader who just onboarded this is the NORMAL case, not a failure: the
 * executor discovers a new account moments after onboarding returns
 * (see `authorize`), and the first order often races that discovery. Two
 * traders hit exactly this on 2026-08-11; one was told "executor is not
 * alive", concluded the product was down, and never placed again.
 *
 * A distinct type so the UI can wait for the executor and retry instead of
 * showing that message. Retrying is safe: a 3009-rejected placement is
 * rejected before anything is written, so no duplicate order can result.
 */
export class ExecutorNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorNotReadyError";
  }
}

/** Executor lifecycle status, as reported by the server. */
export type ExecutorStatus = "RUNNING" | "PAUSED" | "SHUTDOWN";

/**
 * The server's error body is `{code, message}`. `code` is what distinguishes
 * "not provisioned yet" (3009, worth waiting out) from everything else — the
 * HTTP status alone cannot: 503 is also what a proxy says when the backend is
 * down, and that body is not JSON at all.
 */
function parseErrorCode(body: string): number | undefined {
  try {
    const code = (JSON.parse(body) as { code?: unknown }).code;
    return typeof code === "number" ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This account's executor status. `SHUTDOWN` covers "not provisioned yet" —
 * the server reports a missing execution context the same way as a stopped
 * one, so a fresh onboarding reads SHUTDOWN until the executor picks the
 * account up, then RUNNING.
 */
export async function executorStatus(session?: Session): Promise<ExecutorStatus> {
  const res = await call("GET", "/execution/v1/executor/status", session);
  if (!res.ok) throw new Error(`executorStatus ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { status?: ExecutorStatus };
  if (body.status !== "RUNNING" && body.status !== "PAUSED" && body.status !== "SHUTDOWN") {
    throw new Error(`executorStatus: unrecognized status ${JSON.stringify(body)}`);
  }
  return body.status;
}

/**
 * Wait until this account's executor reports `RUNNING`, polling
 * `executorStatus` every few seconds.
 *
 * The 90s ceiling is the executor's discovery worst case with margin: it
 * re-reads the onboarded-accounts roster at least once a minute, and
 * provisioning an account takes about a second. `PAUSED` fails immediately —
 * a paused account is an operator's decision that polling will not reverse,
 * and waiting the full window before saying so helps nobody.
 */
export async function waitForExecutorReady(
  session?: Session,
  timeoutMs = 90_000,
  intervalMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // Status-read failures (a blip, a 502) are treated as "not ready yet"
    // rather than thrown: this function's caller has already decided to wait,
    // and the deadline bounds how long a persistent failure can stall them.
    const status = await executorStatus(session).catch(() => undefined);
    if (status === "RUNNING") return;
    if (status === "PAUSED") {
      throw new Error("Execution for this account is paused. Contact support to resume.");
    }
    if (Date.now() >= deadline) {
      throw new ExecutorNotReadyError(
        "The execution engine did not pick up this account in time. Please try again in a minute.",
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * This account's tickets, newest first — the TWAP order history.
 *
 * Throws rather than returning `[]` on failure: an empty list is a real answer
 * ("no orders yet") and must not be indistinguishable from a failed request.
 */
export async function queryTickets(session?: Session, limit = 50): Promise<TicketProgress[]> {
  const qs = new URLSearchParams({ exchange: "orderly", limit: String(limit) });
  const res = await call("GET", `${TICKETS}/queryAllTickets?${qs}`, session);
  // A rejected credential is a state with an action attached, not a load
  // failure: drop it and say so, so the panel offers the button again instead
  // of showing "could not load your orders" until someone clears storage by
  // hand. Anything else really is a failure and keeps its message.
  if (res.status === 401 || res.status === 403) {
    await forgetAll(session);
    throw new NotSignedInError();
  }
  if (!res.ok) throw new Error(`queryAllTickets ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { tickets?: TicketProgress[] };
  // Dedupe by ticket_id: the server can return the same ticket twice (a stale
  // copy alongside the live one), which shows as duplicate rows and a React
  // duplicate-key warning in the table. Keep the freshest copy per id.
  const byId = new Map<string, TicketProgress>();
  for (const t of body.tickets ?? []) {
    const prev = byId.get(t.ticket_id);
    if (!prev || (t.last_update_time_ms ?? 0) >= (prev.last_update_time_ms ?? 0)) {
      byId.set(t.ticket_id, t);
    }
  }
  return [...byId.values()].sort((a, b) => b.start_time_ms - a.start_time_ms);
}

export interface PlaceTicketParams {
  exchange: "orderly";
  /** Orderly-native symbol, e.g. "PERP_ETH_USDC" (matches the server instrument cache). */
  symbol: string;
  /** Trade direction: "BUY" or "SELL". */
  side: "BUY" | "SELL";
  /** Absolute delta size to execute (must be > 0) — NOT a target position. */
  size: number;
  /** Execution deadline in ms (0 = immediate / market). */
  time_constraint_ms: number;
  /** Execution style — see [`Strategy`]. Omitted = TWAP. */
  strategy?: Strategy;
}

export interface PlaceTicketResponse {
  ticket_id: string;
  start_time_ms: number;
  status: string;
}

/**
 * POST /execution/v1/tickets/placeTicket. With a `session`, signs the request
 * with this browser's key. Without one, falls back to the static `globalThis`
 * key (demo/local only).
 */
export async function placeTicket(
  params: PlaceTicketParams,
  session?: Session,
): Promise<PlaceTicketResponse> {
  const qs = new URLSearchParams({
    exchange: params.exchange,
    symbol: params.symbol,
    side: params.side,
    size: String(params.size),
    time_constraint_ms: String(params.time_constraint_ms),
    ...(params.strategy ? { strategy: params.strategy } : {}),
  });

  const res = await call("POST", `${TICKETS}/placeTicket?${qs}`, session);

  // A rejected credential here read as "API key is invalid or missing", which
  // points at configuration and is the wrong thing to go and check. Drop it so
  // the next attempt re-authorizes, and say what to do.
  if (res.status === 401 || res.status === 403) {
    await forgetAll(session);
    throw new NotSignedInError();
  }
  if (!res.ok) {
    const body = await res.text();
    // 3009 and ONLY 3009: "not provisioned yet" is worth waiting out (see
    // ExecutorNotReadyError). Its neighbors are not — 3011 (paused) is an
    // operator's decision, and any other failure retried on a timer would
    // just fail again with the same message, later.
    if (parseErrorCode(body) === 3009) {
      throw new ExecutorNotReadyError(`placeTicket ${res.status}: ${body}`);
    }
    throw new Error(`placeTicket ${res.status}: ${body}`);
  }
  return (await res.json()) as PlaceTicketResponse;
}
