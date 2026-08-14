/**
 * TWAP order form — rendered in place of the host's order-entry body
 * when the trader picks our TWAP order type.
 *
 * It follows the host's own layout (side, available, size, then the order's own
 * settings) so TWAP reads as one of the exchange's order types rather than a
 * bolted-on panel. Quantity is written through the host's order store, and the
 * asset info below (est. liq. price, fees) is the host's own — we do not
 * duplicate it.
 *
 * This IS a real React component (hooks allowed), rendered by the interceptor.
 */
import * as React from "react";
import {
  usePositionStream,
  useCollateral,
  useAccount,
  useConfig,
  useKeyStore,
  useWalletConnector,
  useOrderStore,
  useSymbolInfo,
  useMarkPriceBySymbol,
  useMarginModeBySymbol,
  useOrderbookStream,
  useMaxQty,
} from "@orderly.network/hooks";
import { AccountStatusEnum, MarginMode, OrderSide } from "@orderly.network/types";
import { Tooltip } from "@orderly.network/ui";

import {
  placeTicket,
  authorize,
  waitForExecutorReady,
  shortTicketId,
  peekSession,
  queryTickets,
  type Session,
  type Strategy,
} from "./api.js";

/** Duration presets → time_constraint in ms. */
const TIMEOUT_PRESETS: Array<{ label: string; ms: number }> = [
  { label: "5m", ms: 5 * 60_000 },
  { label: "30m", ms: 30 * 60_000 },
  { label: "1h", ms: 60 * 60_000 },
  { label: "6h", ms: 6 * 60 * 60_000 },
];

/**
 * Format a size for display at the market's own precision.
 *
 * Sizes are accumulated by repeated addition, so they carry binary
 * floating-point noise (0.0051 arrives as 0.005099999999999993). `dp` is the
 * instrument's `base_dp`, so we show exactly the precision it trades in rather
 * than an arbitrary cutoff. Trailing zeros are dropped.
 */
function formatQty(value: number, dp: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(dp)));
}

/** "PERP_ETH_USDC" → { base: "ETH", quote: "USDC" }. */
function splitSymbol(sym?: string): { base: string; quote: string } {
  const parts = (sym ?? "PERP_ETH_USDC").split("_");
  return { base: parts[1] ?? "ETH", quote: parts[2] ?? "USDC" };
}

/**
 * Symbol-shape check for whether the engine can trade this market — the
 * load-time fallback for the authoritative `broker_id` field (see the caller).
 *
 * Orderly symbols come in two shapes. An official listing is `PERP_<BASE>_USDC`
 * (three segments). A symbol with a fourth segment — `PERP_CTEST_USDC_alpix` —
 * is a permissionless / community listing (the suffix is the broker_id of
 * whoever listed it). Per Orderly (2026-08-11): every DEX can trade these, they
 * are not broker-exclusive — the one thing that sets them apart is that they
 * trade in **isolated-margin mode only**.
 *
 * We do not support them, and isolated-margin-only is the reason: the engine
 * trades cross-margin, and it also cannot round-trip the fourth segment (its
 * `Symbol` type is base+quote, so the order would go back out as
 * `PERP_CTEST_USDC` — a market that does not exist).
 *
 * The caller prefers the instrument's `broker_id` (`!= null` ⇔ permissionless)
 * once instrument info has loaded; this segment count only guards the window
 * before it arrives, so a 4-segment market never flashes a usable form.
 */
function isSupportedMarket(symbol: string): boolean {
  const parts = symbol.split("_");
  return parts.length === 3 && parts[0].toUpperCase() === "PERP";
}

export function TwapOrderPanel({ symbol, api }: { symbol?: string; api?: any }) {
  const { base, quote } = splitSymbol(symbol);

  // Duration starts empty (PRD §3.1: Timeout hr/min default 0) — the submit
  // button is disabled until a real window is set, and it resets back here.
  const [timeoutMs, setTimeoutMs] = React.useState<number>(0);
  // Default Taker (PRD v1.2 §3.5): most traders want the fill, and Taker fills
  // faster at the cost of price — the safer default for a one-shot TWAP.
  const [strategy, setStrategy] = React.useState<Strategy>("TAKER");
  // `status` is the B-line: an interim/error note under the button. `success`
  // is the B10 two-line confirmation, shown for 30s after a place (PRD §3.6-7).
  // `submitting` drives the A4 button state ("Placing order...", disabled).
  const [status, setStatus] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);
  const [success, setSuccess] = React.useState<{ ticketId: string } | null>(null);
  const successTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (successTimer.current) clearTimeout(successTimer.current);
    },
    [],
  );

  // Buy/Sell is owned here rather than read back from the host's switch: the
  // submit button states the direction, and it must never be able to disagree
  // with what we send. The host's own switch is hidden for this order type.
  const [side, setSide] = React.useState<"BUY" | "SELL">("BUY");

  // Quantity is written into the host's order store so its slider, max-qty and
  // validation stay in sync with what is typed here.
  const entry = useOrderStore((s: any) => s.entry);
  const actions = useOrderStore((s: any) => s.actions);
  const qty: string = entry?.order_quantity ?? "";

  // Orderly-native symbol for this market (e.g. "PERP_ETH_USDC").
  const orderlySymbol = symbol ?? `PERP_${base}_${quote}`;

  // Display precision for this market: the exchange's own base decimal places
  // (base_tick 0.0001 -> 4 dp for ETH), so sizes are not shown to a made-up
  // precision the instrument does not trade in.
  const symbolInfo = useSymbolInfo(orderlySymbol);
  const baseDp: number = (symbolInfo?.("base_dp", 4) as number | undefined) ?? 4;

  // A permissionless / community listing trades isolated-margin only. The engine
  // DOES handle these now (it tags the order ISOLATED and round-trips the
  // symbol's 4th segment), but only if the trader has put THIS market into
  // isolated margin on their own account — otherwise every slice fails
  // InsufficientMargin and the executor cancels the ticket. So the gate is the
  // account's per-symbol margin mode, not the market itself: `marginMode` is the
  // account setting, `isPermissionlessListing` is Orderly's own flag for the
  // market. The 4-segment symbol shape is the immediate signal before the hook
  // resolves, so the isolated-setup prompt never flashes a usable form first.
  const { marginMode, isPermissionlessListing } =
    useMarginModeBySymbol(orderlySymbol);
  const permissionless =
    isPermissionlessListing || !isSupportedMarket(orderlySymbol);
  const needsIsolatedSetup =
    permissionless && marginMode !== MarginMode.ISOLATED;

  // Qty (base) and order size (notional) are both editable and each converts to
  // the other using the mark price AT THE MOMENT OF ENTRY. Quantity stays the
  // single source of truth (the host store and our ticket use it); the notional
  // is local state so a ticking mark price never rewrites the figure the trader
  // just typed or is reading.
  // Conversion basis is the book mid — (best bid + best ask) / 2 — per PRD
  // §2/§3.3. It is a preview figure only (the execution price is set per slice by
  // the engine), so mark price is a fine fallback while the orderbook is still
  // loading or a thin market has an empty side. Best levels are found by min/max
  // rather than asks[0]/bids[0] so the result does not depend on the stream's
  // sort order, and zero-price padding levels are skipped.
  const markPrice = useMarkPriceBySymbol(orderlySymbol);
  const [orderbook] = useOrderbookStream(orderlySymbol);
  const midPrice = React.useMemo(() => {
    let bestAsk = Infinity;
    let bestBid = 0;
    for (const a of orderbook?.asks ?? []) {
      const p = a?.[0];
      if (typeof p === "number" && p > 0 && p < bestAsk) bestAsk = p;
    }
    for (const b of orderbook?.bids ?? []) {
      const p = b?.[0];
      if (typeof p === "number" && p > 0 && p > bestBid) bestBid = p;
    }
    return bestAsk < Infinity && bestBid > 0 ? (bestAsk + bestBid) / 2 : 0;
  }, [orderbook]);
  const price = midPrice > 0 ? midPrice : markPrice;
  const [notional, setNotionalState] = React.useState("");
  // The quantity that the order-size box last produced. While the live quantity
  // still equals it, the effect below leaves the typed order size untouched —
  // otherwise a coarse tick (e.g. ADA trades in whole units) would snap "$1"
  // back to the value of the rounded quantity ("$0.92") the instant it is typed.
  const notionalDrivenQty = React.useRef<string | null>(null);

  const setQuantity = (value: string) =>
    actions?.updateOrderByKey?.("order_quantity", value);
  const setNotional = (value: string) => {
    setNotionalState(value);
    if (!value) {
      notionalDrivenQty.current = "";
      return setQuantity("");
    }
    const usd = Number(value);
    if (!Number.isFinite(usd) || price <= 0) return;
    const nextQty = String(Number((usd / price).toFixed(baseDp)));
    notionalDrivenQty.current = nextQty;
    setQuantity(nextQty);
  };

  // Recompute the order size only when the QUANTITY changes for another reason —
  // typed in the Qty box, or the host slider / max button. Keyed on qty (not
  // markPrice) so a ticking price never moves it, and skipped when the quantity
  // is the one the order-size box just produced so the typed figure is kept.
  React.useEffect(() => {
    if (qty === notionalDrivenQty.current) return;
    if (!(Number(qty) > 0) || !(price > 0)) {
      if (!qty) setNotionalState("");
      return;
    }
    setNotionalState(String(Number((Number(qty) * price).toFixed(2))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qty]);

  // Timeout is entered as hours + minutes; the ticket carries milliseconds.
  const hours = String(Math.floor(timeoutMs / 3_600_000) || 0);
  const minutes = String(Math.floor((timeoutMs % 3_600_000) / 60_000) || 0);
  const setDuration = (h: string, m: string) => {
    // Hours cap at 168 (PRD §3.4 / C1); minutes ≥60 carry into hours naturally
    // because hours/minutes are re-derived from the stored ms.
    const clampedH = Math.min(Number(h) || 0, 168);
    const ms = clampedH * 3_600_000 + (Number(m) || 0) * 60_000;
    setTimeoutMs(Math.min(ms, 168 * 3_600_000));
  };

  // Live account state from the Orderly SDK (the panel is rendered inside
  // OrderlyAppProvider, so these stream hooks are in-context).
  //  - current signed position for this symbol → target_position is computed as
  //    an ABSOLUTE target off the real starting position, not a flat assumption.
  //  - free collateral → the "Available" figure shown under Buy/Sell.
  const [positionInfo] = usePositionStream(orderlySymbol);
  const currentPosition =
    positionInfo?.rows?.find((r) => r.symbol === orderlySymbol)?.position_qty ?? 0;
  const { freeCollateral } = useCollateral();
  const available = freeCollateral ?? 0;

  // Authenticated trader identity from the Orderly SDK session. The wallet
  // ADDRESS names the account our backend derives; the order then executes on
  // THIS trader's account, not a hardcoded one.
  const { state } = useAccount();
  const brokerId = useConfig<string>("brokerId");
  const address = state?.address;

  // The SDK keyStore holds the Orderly trading key that "Enable Trading"
  // delegated to this browser. Onboarding ADOPTS that key (see api.authorize)
  // instead of prompting the wallet for a second delegation — so placing a
  // TWAP costs zero signatures. The chain still comes from the connector: it
  // decides which Orderly cluster the account lives on.
  const keyStore = useKeyStore();
  const { connectedChain } = useWalletConnector();
  const chainId = connectedChain?.id ? Number(connectedChain.id) : undefined;

  // "Can place" = the trader has enabled trading (delegated an Orderly key).
  // Gate on that, NOT on `status === EnableTrading` alone — which is the bug
  // behind the client report (2026-08-14): after a reload the Orderly key is
  // restored from storage but the wallet is not reconnected yet, so the account
  // sits at EnableTradingWithoutConnected (-1). Orders are signed with the
  // delegated key, not the wallet, so trading DOES work in that state (it is why
  // the host's own order forms accept it) — but `=== EnableTrading (5)` excluded
  // it and left the TWAP button stuck "Connect wallet to trade". Accept the key
  // itself and both enabled-trading statuses.
  const hasOrderlyKey = !!(address && keyStore.getOrderlyKey(address));
  const isTradingEnabled =
    hasOrderlyKey ||
    state?.status === AccountStatusEnum.EnableTrading ||
    state?.status === AccountStatusEnum.EnableTradingWithoutConnected;

  // Max order quantity this account can afford for this market/side — the SDK
  // computes it from collateral, leverage, IMR and the existing position, so we
  // do not re-derive margin ourselves. Powers the B7 "Max quantity is …" line.
  const maxQty = useMaxQty(
    orderlySymbol,
    side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
  );

  // Count of the account's still-working TWAP tickets, for the B2 concurrency
  // cap (20, across all pairs). Read-only peek at the existing session — never
  // pops a signature — refreshed on a slow cadence since it changes rarely.
  const [activeCount, setActiveCount] = React.useState(0);
  React.useEffect(() => {
    const session =
      address && brokerId && chainId ? peekSession(brokerId, address, chainId) : undefined;
    if (!session) {
      setActiveCount(0);
      return;
    }
    let cancelled = false;
    const TERMINAL = ["COMPLETE", "CANCEL", "EXPIRED"];
    const load = () =>
      queryTickets(session)
        .then((ts) => {
          if (!cancelled) setActiveCount(ts.filter((t) => !TERMINAL.includes(t.status)).length);
        })
        .catch(() => undefined);
    load();
    const id = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [address, brokerId, chainId]);

  // §3.7.2 region B — the single line under the button. Computed reactively from
  // the current form state so it updates as the trader types, and priority-
  // ordered (only the highest applicable shows). `blocking` also disables the
  // submit button. B0 (not connected) shows nothing — the panel has its own
  // Connect wallet. B6 (post-split single slice) is intentionally omitted: the
  // executor owns per-slice min-notional, not the form. B9 (fail) / B10 (success)
  // are event-driven and handled separately.
  const gate = React.useMemo<{ text: string; tone: "red" | "grey"; blocking: boolean } | null>(() => {
    if (!isTradingEnabled) return null; // B0
    const size = Number(qty);
    const tradeDir = side === "BUY" ? 1 : -1;
    // A true reduce moves TOWARD zero without crossing it: opposite direction AND
    // no bigger than the current position. An order that overshoots (e.g. long 6,
    // sell 9 → short 3) is a FLIP — the part past zero opens fresh exposure, so it
    // is NOT reduce-exempt and must face the open-only gates (min notional /
    // balance) and a REDUCE_ONLY/pre-market block.
    const isReduce =
      currentPosition !== 0 &&
      Math.sign(currentPosition) !== tradeDir &&
      size <= Math.abs(currentPosition);
    const marketStatus = String(symbolInfo?.("status", "ACTIVE") ?? "ACTIVE");
    const isPretge = Boolean(symbolInfo?.("is_pretge", false));
    const minNotional = Number(symbolInfo?.("min_notional", 0)) || 0;
    const avail = freeCollateral ?? 0;

    // B1 — market not open for the intended direction.
    if (marketStatus === "REDUCE_ONLY" && !isReduce)
      return { text: `${base}-PERP is in reduce-only mode — you can only reduce or close a position`, tone: "red", blocking: true };
    if (marketStatus !== "ACTIVE" && marketStatus !== "REDUCE_ONLY")
      return { text: "Trading is currently unavailable for this market", tone: "red", blocking: true };
    if (isPretge && !isReduce)
      return { text: `${base}-PERP is a pre-market (pre-TGE) listing — you can only reduce or close a position`, tone: "red", blocking: true };
    // B2 — account-wide concurrency cap.
    if (activeCount >= 20)
      return { text: "You've reached the limit of 20 active TWAP orders. End an order to place a new one.", tone: "red", blocking: true };
    // B3 — no quantity.
    if (!Number.isFinite(size) || size <= 0)
      return { text: "Enter a quantity in the order form above", tone: "grey", blocking: true };
    // B4 — duration below the minimum.
    if (timeoutMs < 60_000)
      return { text: "Set a duration of at least 1 minute", tone: "grey", blocking: true };
    // B5 — opening below the exchange minimum notional (reduce is exempt).
    // Checked on the ACTUAL quantity: a typed order size rounds to the base step
    // (10 → 0.0053 ETH), and it is that rounded qty that trades, so `qty * price`
    // (≈ 9.999) is the real notional — correctly below a 10 minimum. The Order
    // size box still reading "10" is a display nicety, not the value that trades.
    if (!isReduce && minNotional > 0 && price > 0 && size * price < minNotional)
      return { text: `Minimum order size is ${minNotional} ${quote}`, tone: "red", blocking: true };
    // B7 — over the max this account can trade on this side. NOT exempted for a
    // "reduce": useMaxQty already folds in the current position and collateral,
    // so it is the true cap either way — an order that flips the position past it
    // is really an oversized open, and must be caught (an early bug let a
    // billions-size buy through because it was tagged reduce).
    if (maxQty > 0 && size > maxQty)
      return { text: `Insufficient balance. Max quantity is ${formatQty(maxQty, baseDp)} ${base}`, tone: "red", blocking: true };
    // B8 — no collateral to OPEN with (reducing/closing needs none).
    if (!isReduce && avail <= 0)
      return { text: "Insufficient balance. Deposit funds to continue.", tone: "red", blocking: true };
    return null; // B11 — nothing to say.
  }, [
    isTradingEnabled, qty, side, currentPosition, symbolInfo, timeoutMs, price,
    freeCollateral, maxQty, activeCount, base, quote, baseDp,
  ]);

  // Clear the interim/error (B9) line whenever the trader edits the form — the
  // reactive `gate` then takes over. Does not touch `success` (its own 30s
  // timer) or the in-flight "Placing…" (nothing changes mid-submit).
  React.useEffect(() => {
    setStatus("");
  }, [qty, notional, timeoutMs, side, strategy]);

  // Live progress is NOT tracked here. A placed ticket appears under Running in
  // the Bot tab, which follows every ticket on the account rather than only the
  // one this form last placed — mirroring it here would put the same order on
  // screen twice, with two things able to disagree about it.

  async function onSubmit() {
    // ── Validation split ──────────────────────────────────────────────────
    // ALL input validation lives in the reactive `gate` (B0–B8): connected,
    // market status / pre-market, concurrency (B2), quantity (B3), duration
    // (B4), min notional (B5), balance / max qty (B7/B8). It drives both the
    // button-disable and this guard, so they can never disagree. Re-check it
    // here because a click can race a state change.
    //
    // onSubmit owns ONLY what cannot be known until the request is sent:
    //   - credential rejected/expired  → re-adopt and retry once (NotSignedIn)
    //   - executor still provisioning  → 3009 → wait for ready, place again
    //   - any other placement failure  → B9 "Failed to place order: …"
    if (gate?.blocking) {
      setStatus(gate.text);
      return;
    }
    const size = Number(qty);
    // Ticket target is ABSOLUTE (executor computes the delta to trade).
    const target_position = currentPosition + (side === "BUY" ? size : -size);
    const ticket = {
      exchange: "orderly" as const,
      // Orderly-native symbol (e.g. "PERP_ETH_USDC") — matches the server's
      // instrument cache (GET /v1/public/info) and the executor's parser.
      symbol: orderlySymbol,
      target_position,
      time_constraint_ms: timeoutMs,
      strategy, // MAKER (rest at the touch) / TAKER (sliced IOC) — see api.Strategy
    };
    const hasWallet = !!(address && brokerId && chainId);

    // Real auth, no signature: the SDK keyStore's Orderly key — the one
    // "Enable Trading" already delegated — is re-read on EVERY submit and
    // adopted by the backend, so the order executes on THIS connected trader's
    // account. Re-reading matters: if the DEX rotated the key since last time,
    // authorize sees a fingerprint mismatch and re-adopts rather than letting
    // the executor sign with a stale key. With no wallet available (local/demo
    // harness) we fall back to the static key.
    const withSession = async () => {
      if (!hasWallet) return undefined;
      const orderlyKey = keyStore.getOrderlyKey(address);
      if (!orderlyKey) {
        // isTradingEnabled should make this unreachable; if storage was
        // cleared underneath us, say what actually fixes it.
        throw new Error("No Orderly trading key found — enable trading first");
      }
      setStatus("Enabling TWAP…");
      return await authorize(
        brokerId!,
        address!,
        chainId!,
        orderlyKey,
        keyStore.getAccountId(address!) ?? undefined,
      );
    };

    // Place, waiting out the one rejection that resolves itself. A trader who
    // just onboarded races the execution engine's discovery of their account
    // (up to a minute); the server answers 3009 "executor is not alive" until
    // then. That message reads as an outage — the 2026-08-11 report — when the
    // truth is "almost ready". So on 3009: say what is actually happening,
    // wait for the engine to report ready, and place again. Safe to resend —
    // a 3009-rejected placement wrote nothing.
    const placeWhenReady = async (session?: Session) => {
      try {
        return await placeTicket(ticket, session);
      } catch (e: any) {
        if (e?.name !== "ExecutorNotReadyError") throw e;
        setStatus("Setting up your account… this can take up to a minute");
        await waitForExecutorReady(session);
        setStatus("Placing…");
        return await placeTicket(ticket, session);
      }
    };

    // On a successful place: show the B10 two-line confirmation for 30s, empty
    // the form back to its initial state (each TWAP is independent — last one's
    // size/duration must not carry over), reset Side/Strategy to their defaults,
    // and bring the Bot → TWAP tab forward. (§3.6-6/7/8, §3.7.2 B10.)
    const onPlaced = (ticketId: string) => {
      setStatus("");
      setSuccess({ ticketId });
      if (successTimer.current) clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => setSuccess(null), 30_000);
      setQuantity("");
      setNotional("");
      setTimeoutMs(0);
      setSide("BUY");
      setStrategy("TAKER");
    };

    // A4: the button reads "Placing order..." and is disabled for the duration,
    // so a second click cannot place a duplicate. Any prior success clears — a
    // new submit replaces the old confirmation (§3.7.2 rules).
    setSuccess(null);
    if (successTimer.current) clearTimeout(successTimer.current);
    setSubmitting(true);
    try {
      let session = await withSession();
      setStatus("Placing…");
      try {
        const res = await placeWhenReady(session);
        onPlaced(res.ticket_id);
      } catch (e: any) {
        // The credential was rejected — it has already been dropped, so a second
        // attempt authorizes afresh. Worth one retry rather than a dead end: the
        // usual cause is a delegation that lapsed or a server that was
        // redeployed, and the trader can do nothing useful with either message.
        if (e?.name !== "NotSignedInError" || !hasWallet) throw e;
        session = await withSession();
        setStatus("Placing…");
        const res = await placeWhenReady(session);
        onPlaced(res.ticket_id);
      }
    } catch (e: any) {
      setStatus(
        e?.name === "NotSignedInError"
          ? "Failed: connect your wallet and enable trading, then try again"
          : `Failed to place order: ${e?.message ?? e}. Please try again.`,
      );
    } finally {
      setSubmitting(false);
    }
  }

  const btn = (active: boolean) =>
    `oui-px-2 oui-py-1 oui-rounded oui-text-sm ${active ? "oui-bg-primary oui-text-white" : "oui-bg-base-6"}`;

  // Say so instead of rendering a form that cannot work. A permissionless
  // listing trades isolated-margin only; the engine can work it, but only once
  // the trader has set THIS market to isolated margin on their account. Until
  // then every slice would fail InsufficientMargin and the executor would cancel
  // the ticket — so gate the form and tell them the one thing to do. The message
  // clears itself once they switch (the margin-mode hook updates live).
  if (needsIsolatedSetup) {
    return (
      <div className="oui-flex oui-flex-col oui-items-center oui-gap-1.5 oui-rounded-lg oui-bg-base-8 oui-p-4 oui-text-center oui-text-sm">
        <span className="oui-text-base-contrast">Set {base}-PERP to isolated margin</span>
        <span className="oui-text-xs oui-text-base-contrast-36">
          {base} is a permissionless listing, which trades in isolated-margin
          mode only. Switch this market to isolated margin in your account
          settings to run TWAP on it.
        </span>
      </div>
    );
  }

  return (
    <div className="oui-flex oui-flex-col oui-gap-2 oui-p-2 oui-rounded-lg oui-bg-base-8">
      {/* Buy / Sell — owned here so the submit button cannot state a direction
          different from the one we send. */}
      <div className="oui-grid oui-grid-cols-2 oui-gap-2">
        <button
          className={`oui-py-1 oui-rounded oui-text-sm ${
            side === "BUY" ? "oui-bg-success oui-text-white" : "oui-bg-base-6"
          }`}
          onClick={() => setSide("BUY")}
        >
          Buy
        </button>
        <button
          className={`oui-py-1 oui-rounded oui-text-sm ${
            side === "SELL" ? "oui-bg-danger oui-text-white" : "oui-bg-base-6"
          }`}
          onClick={() => setSide("SELL")}
        >
          Sell
        </button>
      </div>

      <div className="oui-flex oui-justify-between oui-text-xs oui-text-base-contrast-54">
        <span>Available</span>
        <span>
          {available.toFixed(2)} {quote}
        </span>
      </div>

      {/* Quantity in base units and the same order expressed as notional. Both
          edit the one order size — traders size either way round. */}
      <div className="oui-grid oui-grid-cols-2 oui-gap-2">
        <label className="oui-flex oui-flex-col oui-text-xs oui-gap-1">
          Qty
          <div className="oui-flex oui-items-center oui-gap-1 oui-border oui-rounded oui-px-2 oui-py-1">
            <input
              className="oui-w-full oui-min-w-0 oui-flex-1 oui-bg-transparent oui-outline-none"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="0"
            />
            <span className="oui-text-base-contrast-54">{base}</span>
          </div>
        </label>
        <label className="oui-flex oui-flex-col oui-text-xs oui-gap-1">
          Order size
          <div className="oui-flex oui-items-center oui-gap-1 oui-border oui-rounded oui-px-2 oui-py-1">
            <input
              className="oui-w-full oui-min-w-0 oui-flex-1 oui-bg-transparent oui-outline-none"
              inputMode="decimal"
              value={notional}
              onChange={(e) => setNotional(e.target.value)}
              placeholder="0"
            />
            <span className="oui-text-base-contrast-54">{quote}</span>
          </div>
        </label>
      </div>

      {/* Execution window: an exact hours/minutes entry plus the common presets. */}
      <div className="oui-flex oui-flex-col oui-gap-1">
        <span className="oui-text-xs">Timeout</span>
        <div className="oui-grid oui-grid-cols-2 oui-gap-2">
          <div className="oui-flex oui-items-center oui-gap-1 oui-border oui-rounded oui-px-2 oui-py-1">
            <input
              className="oui-w-full oui-min-w-0 oui-flex-1 oui-bg-transparent oui-outline-none oui-text-xs"
              inputMode="numeric"
              value={hours}
              onChange={(e) => setDuration(e.target.value, minutes)}
              placeholder="0"
            />
            <span className="oui-text-xs oui-text-base-contrast-54">hr</span>
          </div>
          <div className="oui-flex oui-items-center oui-gap-1 oui-border oui-rounded oui-px-2 oui-py-1">
            <input
              className="oui-w-full oui-min-w-0 oui-flex-1 oui-bg-transparent oui-outline-none oui-text-xs"
              inputMode="numeric"
              value={minutes}
              onChange={(e) => setDuration(hours, e.target.value)}
              placeholder="0"
            />
            <span className="oui-text-xs oui-text-base-contrast-54">min</span>
          </div>
        </div>
        <div className="oui-grid oui-grid-cols-4 oui-gap-2">
          {TIMEOUT_PRESETS.map((p) => (
            <button key={p.label} className={btn(timeoutMs === p.ms)} onClick={() => setTimeoutMs(p.ms)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Strategy: Maker / Taker */}
      <div className="oui-flex oui-flex-col oui-gap-1">
        <span className="oui-text-xs oui-flex oui-items-center oui-gap-1">
          Strategy
          {/* SDK Tooltip — Radix, rendered through a portal, so it never affects
              the form's layout (a hand-rolled absolutely-positioned tip did). */}
          <Tooltip
            content={
              <div className="oui-max-w-[240px] oui-text-2xs oui-leading-snug">
                <div>Taker: Fills faster, but usually at a worse price than Maker</div>
                <div className="oui-mt-1">Maker: Better price, but fills more slowly</div>
              </div>
            }
          >
            <span className="oui-inline-flex oui-h-3.5 oui-w-3.5 oui-items-center oui-justify-center oui-rounded-full oui-border oui-text-[10px] oui-text-base-contrast-54 oui-cursor-help">
              ?
            </span>
          </Tooltip>
        </span>
        <div className="oui-grid oui-grid-cols-2 oui-gap-2">
          <button className={btn(strategy === "MAKER")} onClick={() => setStrategy("MAKER")}>Maker</button>
          <button className={btn(strategy === "TAKER")} onClick={() => setStrategy("TAKER")}>Taker</button>
        </div>
      </div>

      {/* No Position (0 → 100 ADA) row: PRD v1.2 §3.6-9 explicitly drops it from
          the form — the engine targets an absolute position, but the trader
          reasons in "how much to trade", and the before/after line was cut. */}

      <button
        className={`oui-mt-1 oui-py-2 oui-rounded oui-text-white ${
          !isTradingEnabled || submitting || gate?.blocking
            ? "oui-bg-base-6 oui-cursor-not-allowed"
            : side === "BUY"
              ? "oui-bg-success"
              : "oui-bg-danger"
        }`}
        onClick={onSubmit}
        disabled={!isTradingEnabled || submitting || !!gate?.blocking}
      >
        {/* A4: while placing, the button reads "Placing order..." and is
            disabled so a second click cannot place a duplicate. Otherwise it
            keeps the direction text — greyed via the disabled styling — even
            when not connected (A1: the wallet entry lives in the panel's own
            Connect wallet, not in this button). */}
        {submitting
          ? "Placing order..."
          : `${side === "BUY" ? "Buy / Long" : "Sell / Short"} ${base}`}
      </button>

      {/* B10: the two-line confirmation, shown for 30s (or until the next place)
          — the ticket id, then where to watch it. It sits above the B-line so a
          success is never hidden by an input-gate note that reappears once the
          cleared form reads as "no quantity". */}
      {success ? (
        <div className="oui-flex oui-flex-col oui-text-xs">
          <span className="oui-text-success">
            Placed ticket {shortTicketId(success.ticketId)}
          </span>
          <span className="oui-text-base-contrast-54">
            View execution details in Bot → TWAP
          </span>
        </div>
      ) : status ? (
        // Interim progress ("Placing…", "Setting up your account…") or a B9
        // failure — takes the line while it is set; cleared when the trader next
        // edits the form (see the effect above).
        <div className="oui-text-xs oui-text-base-contrast-54">{status}</div>
      ) : gate ? (
        // The reactive B-line (B1–B8): red for a hard block, grey for an
        // input-not-ready hint. Only the highest-priority one is here.
        <div
          className={`oui-text-xs ${
            gate.tone === "red" ? "oui-text-danger" : "oui-text-base-contrast-54"
          }`}
        >
          {gate.text}
        </div>
      ) : null}
    </div>
  );
}
