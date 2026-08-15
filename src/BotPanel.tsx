/**
 * Bot panel — the tab we add to the host's data list.
 *
 * The host's own tabs (Pending, Filled, Order history …) only know about
 * exchange orders, so a TWAP appears there as its individual child fills with
 * nothing tying them to the order that produced them. This lists the tickets
 * themselves, split the way an algo order is actually managed:
 *
 *   Running  — still working; the only thing you can act on (End)
 *   History  — finished, with how much of it filled and why it stopped
 *
 * The rows render through the SDK's own `DataTable`, not a hand-rolled table:
 * it is what the host's other tabs use, so this one scrolls, sorts, sizes and
 * themes exactly like Position history sitting next to it. A bespoke table
 * looks close until the list outgrows the panel and cannot be scrolled.
 *
 * TWAP sits under a strategy row because the panel is "Bot", not "TWAP": more
 * strategies land beside it later and the layout should not have to change.
 */
import * as React from "react";
import { useAccount, useConfig, useKeyStore, useWalletConnector } from "@orderly.network/hooks";
import { DataTable, type Column } from "@orderly.network/ui";

import {
  cancelTicket,
  authorize,
  peekSession,
  queryTickets,
  shortTicketId,
  NotSignedInError,
  type ExecVersion,
  type Session,
  type TicketProgress,
} from "./api.js";

/** Statuses a ticket can no longer leave. Everything else is still working. */
const TERMINAL = ["COMPLETE", "CANCEL", "EXPIRED"];
const POLL_SECONDS = 5;

function qty(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(6)));
}

function stamp(ms?: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

/** "PERP_ETH_USDC" → "ETH-PERP", the name this market carries everywhere else. */
function pair(symbol: string): string {
  const base = symbol.split("_")[1];
  return base ? `${base}-PERP` : symbol;
}

/**
 * "Total" for the Filled/Total column: v2's placed `size`, or v1's
 * `target_position` — read as a magnitude either way, since a target can be
 * negative (a short target) while the column is a plain quantity.
 */
function totalOf(t: TicketProgress): number {
  return Math.abs(t.exec_version === "v1" ? t.target_position : t.size);
}

/** "Filled" counterpart to `totalOf` — v2's `filled_size`, or v1's `executed_position`. */
function filledOf(t: TicketProgress): number {
  return Math.abs(t.exec_version === "v1" ? t.executed_position : t.filled_size);
}

function pctOf(t: TicketProgress): number {
  const total = totalOf(t);
  return total > 0 ? Math.min(100, (filledOf(t) / total) * 100) : 0;
}

/**
 * v1 has no `side` field — the ticket drives the account's position toward
 * `target_position`, so direction is whichever way still closes that gap.
 * v2 carries `side` outright.
 */
function sideOf(t: TicketProgress): string {
  if (t.exec_version === "v2") return t.side;
  return t.target_position - t.executed_position >= 0 ? "BUY" : "SELL";
}

/**
 * v1 predates `status: "EXPIRED"` and reports the same fact through
 * `is_expired` instead (see `TicketProgressV1` in api.ts) — fold it into the
 * same terminal name v2 uses so filtering and the Status column need only
 * ever look at one string.
 */
function statusOf(t: TicketProgress): string {
  if (t.exec_version === "v1" && t.is_expired && t.status !== "EXPIRED") return "EXPIRED";
  return t.status;
}

/** Percentage with the filled bar under it, as in the reference design. */
function Filled({ pct }: { pct: number }) {
  return (
    <div className="oui-flex oui-flex-col oui-gap-1">
      <span className="oui-tabular-nums">{pct.toFixed(2)}%</span>
      <span className="oui-h-[3px] oui-w-full oui-rounded oui-bg-base-5">
        <span
          className="oui-block oui-h-[3px] oui-rounded oui-bg-success"
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}

/**
 * The ticket id, shortened but copyable in full — it is what a trader quotes
 * when asking about an order, so truncating it without a way back is useless.
 */
function TicketId({ id }: { id: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      title={`${id} (click to copy)`}
      className="oui-font-mono oui-text-base-contrast-54 hover:oui-text-base-contrast"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(id)?.then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => undefined,
        );
      }}
    >
      {copied ? "copied" : shortTicketId(id)}
    </button>
  );
}

export function BotPanel({ symbol }: { symbol?: string }) {
  const [rows, setRows] = React.useState<TicketProgress[] | null>(null);
  // Which ticket API the panel talks to. Defaults to v2 (the current model,
  // what every new account is on); v1 is there for old accounts still on the
  // position-target model the server used before the split.
  const [execVersion, setExecVersion] = React.useState<ExecVersion>("v2");
  const [view, setView] = React.useState<"running" | "history">("running");
  const [onlyThisPair, setOnlyThisPair] = React.useState(false);
  const [needsSignIn, setNeedsSignIn] = React.useState(false);
  const [error, setError] = React.useState("");
  // Ticket ids whose End was clicked and is still settling. Cancelling is not
  // instant (request round-trip, then the next poll moves the ticket to
  // History), so the button locks and reads "Ending…" meanwhile — otherwise it
  // looks like nothing happened and gets clicked again.
  const [ending, setEnding] = React.useState<Set<string>>(() => new Set());

  const { state } = useAccount();
  const brokerId = useConfig<string>("brokerId");
  const address = state?.address;
  const keyStore = useKeyStore();
  const { connectedChain } = useWalletConnector();

  // Read-only: an existing session only. Looking at your own orders must never
  // pop a wallet signature — signing in is an explicit button below.
  //
  // Keyed by chain as well as account, because a session belongs to one Orderly
  // cluster: switching networks must show that cluster's orders rather than
  // keep presenting the previous one's.
  const chainId = connectedChain?.id ? Number(connectedChain.id) : undefined;
  const [session, setSession] = React.useState<Session | undefined>();
  React.useEffect(() => {
    setSession(
      address && brokerId && chainId ? peekSession(brokerId, address, chainId) : undefined,
    );
  }, [address, brokerId, chainId]);

  React.useEffect(() => {
    let cancelled = false;
    // Switching versions points at a different endpoint with a different
    // ticket shape — show loading rather than the other version's rows while
    // the first fetch under the new version is in flight.
    setRows(null);
    const load = async () => {
      try {
        const list = await queryTickets(session, 50, execVersion);
        if (cancelled) return;
        setRows(list);
        setNeedsSignIn(false);
        setError("");
      } catch (e: any) {
        if (cancelled) return;
        // No session is not a failure — it is a state with an action attached.
        if (e instanceof NotSignedInError) setNeedsSignIn(true);
        else setError(e?.message ?? String(e));
        setRows(null);
      }
    };
    load();
    // Running tickets change while the panel is open.
    const poll = setInterval(load, POLL_SECONDS * 1000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [session, execVersion]);

  const [busy, setBusy] = React.useState(false);

  const enableTwap = React.useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const orderlyKey = address ? keyStore.getOrderlyKey(address) : null;
      // Name what is actually missing. "Connect your wallet and enable trading
      // first" was true but useless when the wallet *was* connected and it was
      // the chain id that came back empty -- it sent people to re-do a step
      // they had already done.
      const missing = [
        !address && "wallet address",
        !brokerId && "broker id",
        !chainId && "chain id",
        !orderlyKey && "orderly trading key (enable trading on the exchange)",
      ].filter(Boolean);
      if (missing.length) {
        throw new Error(`Not available yet: ${missing.join(", ")}. Connect your wallet and enable trading first.`);
      }
      setSession(
        await authorize(
          brokerId!,
          address!,
          chainId!,
          orderlyKey!,
          keyStore.getAccountId(address!) ?? undefined,
        ),
      );
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [address, brokerId, chainId, keyStore]);

  // Adopt automatically — there is no signature behind it and the order form
  // already adopts on first place, so there is no "Enable TWAP" button: a click
  // with nothing on the other side of it is pure friction. While a session is
  // missing and a trading key is present, adopt silently; retry on a slow
  // cadence so a transient failure (Orderly briefly unreachable) recovers on
  // its own without a button and without hammering in a tight loop.
  React.useEffect(() => {
    if (!needsSignIn) return;
    const tryAdopt = () => {
      if (busy || !address || !brokerId || !chainId) return;
      if (!keyStore.getOrderlyKey(address)) return; // trading not enabled — nothing to adopt
      void enableTwap();
    };
    tryAdopt();
    const id = setInterval(tryAdopt, 10_000);
    return () => clearInterval(id);
  }, [needsSignIn, busy, address, brokerId, chainId, keyStore, enableTwap]);

  const end = React.useCallback(
    async (ticketId: string) => {
      setError("");
      // Lock this row's button immediately so the click registers and cannot be
      // repeated while the cancel is in flight.
      setEnding((s) => new Set(s).add(ticketId));
      try {
        await cancelTicket(ticketId, session, execVersion);
        // Stay locked on success: the ticket is still in Running until the next
        // poll moves it to History, and we do not want it clickable in between.
      } catch (e: any) {
        setError(`Could not end ${ticketId.slice(0, 10)}…: ${e?.message ?? e}`);
        // Unlock so the trader can retry a genuinely failed cancel.
        setEnding((s) => {
          const n = new Set(s);
          n.delete(ticketId);
          return n;
        });
      }
    },
    [session, execVersion],
  );

  const visible = (rows ?? [])
    .filter((t) => (view === "running" ? !TERMINAL.includes(statusOf(t)) : TERMINAL.includes(statusOf(t))))
    .filter((t) => !onlyThisPair || !symbol || t.symbol === symbol);

  // Drop "ending" marks once a ticket is no longer running (the poll has moved
  // it to History), so the set does not grow and a reused id never starts locked.
  React.useEffect(() => {
    setEnding((s) => {
      if (s.size === 0) return s;
      const running = new Set(
        (rows ?? []).filter((t) => !TERMINAL.includes(statusOf(t))).map((t) => t.ticket_id),
      );
      const next = new Set([...s].filter((id) => running.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [rows]);

  const runningCount = (rows ?? []).filter((t) => !TERMINAL.includes(statusOf(t))).length;

  const columns = React.useMemo<Column<TicketProgress>[]>(() => {
    const ticketId: Column<TicketProgress> = {
      title: "Ticket ID",
      dataIndex: "ticket_id",
      width: 150,
      render: (_v, r) => <TicketId id={r.ticket_id} />,
    };
    const endTime: Column<TicketProgress> = {
      title: "End time",
      dataIndex: "last_update_time_ms",
      width: 160,
      onSort: true,
      render: (_v, r) => (
        <span className="oui-text-base-contrast-54">{stamp(r.last_update_time_ms)}</span>
      ),
    };
    const rest: Column<TicketProgress>[] = [
      {
        title: "Pair",
        dataIndex: "symbol",
        width: 110,
        onSort: true,
        render: (_v, r) => pair(r.symbol),
      },
      {
        title: "Direction",
        dataIndex: "side",
        width: 90,
        // v2 rows carry `side` outright; v1 rows have none, so `sideOf` derives
        // it from whichever way still closes target_position - executed_position.
        render: (_v, r) => {
          const isBuy = sideOf(r) === "BUY";
          return (
            <span className={isBuy ? "oui-text-success" : "oui-text-danger"}>
              {isBuy ? "Buy" : "Sell"}
            </span>
          );
        },
      },
      {
        title: "Filled",
        dataIndex: "filled_size",
        width: 90,
        onSort: (a, b) => pctOf(a) - pctOf(b),
        render: (_v, r) => <Filled pct={pctOf(r)} />,
      },
      {
        // Unique dataIndex: it is the column's identity in DataTable, and the
        // "Filled" column above already uses `filled_size`. Two columns
        // sharing a dataIndex collided — the header rendered "Filled" several
        // times and the columns fell out of alignment ("跑版"). The render reads
        // the whole row, so the dataIndex need not map to a real field.
        //
        // Title names the v1/v2 fields it is actually reading — "Filled /
        // Total" for v2's filled_size/size, "Executed / Target" for v1's
        // executed_position/target_position — so the header matches the model
        // the active tab is on rather than implying every row has a `size`.
        title: execVersion === "v1" ? "Executed / Target position" : "Filled / Total amount",
        dataIndex: "filled_total",
        width: 170,
        render: (_v, r) => (
          <span className="oui-tabular-nums">
            {qty(filledOf(r))} / {qty(totalOf(r))}{" "}
            <span className="oui-text-base-contrast-36">{r.symbol.split("_")[1] ?? ""}</span>
          </span>
        ),
      },
      {
        title: "Initiated time",
        dataIndex: "start_time_ms",
        width: 160,
        onSort: true,
        render: (_v, r) => (
          <span className="oui-text-base-contrast-54">{stamp(r.start_time_ms)}</span>
        ),
      },
    ];

    if (view === "history") {
      return [
        ticketId,
        endTime,
        ...rest,
        {
          title: "Status",
          dataIndex: "status",
          width: 110,
          onSort: true,
          // The ticket's own status verbatim — NEW / OPEN / COMPLETE / CANCEL /
          // EXPIRED. It is the value the API, the logs and support all quote,
          // so renaming it here would only make those disagree. `statusOf`
          // folds v1's `is_expired` flag into "EXPIRED" so both versions read
          // the same way; anything else already matches its own `status`.
          render: (_v, r) => (
            <span className={statusOf(r) === "COMPLETE" ? "" : "oui-text-warning"}>
              {statusOf(r)}
            </span>
          ),
        },
      ];
    }

    return [
      ticketId,
      ...rest,
      {
        // Unique dataIndex (the "Ticket ID" column already uses `ticket_id`) —
        // see the Filled/Total note above; a shared dataIndex collided.
        title: "Actions",
        dataIndex: "actions",
        type: "action",
        width: 130,
        render: (_v, r) => {
          // A TWAP runs for minutes, so it has to be stoppable. Ending it keeps
          // whatever has already filled. While the cancel settles the button
          // locks and reads "Ending…" so it registers and is not double-clicked.
          const isEnding = ending.has(r.ticket_id);
          return (
            <span>
              <button
                disabled={isEnding}
                className={
                  isEnding
                    ? "oui-text-base-contrast-36 oui-cursor-not-allowed"
                    : "oui-text-warning hover:oui-underline"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isEnding) void end(r.ticket_id);
                }}
              >
                {isEnding ? "Ending…" : "End"}
              </button>
              {/* No "past window" tag here any more: expiry is now a terminal
                  hard-stop (specs/orderly-venue-v2.md §6.5.5) — a ticket that
                  hits its time_constraint_ms cancels its orders and moves to
                  status EXPIRED under History, so a row in Running can no
                  longer be "past its window but still working". */}
            </span>
          );
        },
      },
    ];
  }, [view, execVersion, end, ending]);

  return (
    <div className="oui-flex oui-h-full oui-min-h-0 oui-flex-col oui-text-xs">
      {/* Strategy row. TWAP is the only one today; the row is what lets another
          sit beside it without moving anything. */}
      <div className="oui-flex oui-items-center oui-gap-2 oui-border-b oui-border-base-6 oui-px-3 oui-py-2">
        <span className="oui-rounded oui-bg-base-5 oui-px-2 oui-py-1">TWAP</span>
      </div>

      {/* V1 (legacy, position-target) / V2 (current, delta) — the server was
          split in two, each version with its own endpoints and ticket shape.
          Default is V2: every new account is on it, and V1 exists only for
          accounts onboarded before the split. Switching refetches from that
          version's endpoints (see the effect keyed on `execVersion`) and swaps
          the columns below to match its ticket shape. */}
      <div className="oui-flex oui-items-center oui-gap-3 oui-border-b oui-border-base-6 oui-px-3 oui-py-2 oui-text-base-contrast-36">
        <span>Execution:</span>
        {(["v2", "v1"] as const).map((v) => (
          <button
            key={v}
            className={`oui-rounded oui-px-2 oui-py-1 oui-uppercase ${
              execVersion === v ? "oui-bg-base-5 oui-text-base-contrast" : "oui-text-base-contrast-54"
            }`}
            onClick={() => setExecVersion(v)}
          >
            {v}
          </button>
        ))}
      </div>

      {/* Running / History, and how fresh the numbers are. */}
      <div className="oui-flex oui-flex-wrap oui-items-center oui-gap-3 oui-px-3 oui-py-2">
        {(["running", "history"] as const).map((v) => (
          <button
            key={v}
            className={`oui-rounded oui-px-2 oui-py-1 ${
              view === v ? "oui-bg-base-5 oui-text-base-contrast" : "oui-text-base-contrast-54"
            }`}
            onClick={() => setView(v)}
          >
            {v === "running" ? `Running${runningCount ? ` (${runningCount})` : ""}` : "History"}
          </button>
        ))}
        <span className="oui-ml-auto oui-flex oui-items-center oui-gap-3 oui-text-base-contrast-36">
          {symbol && (
            <label className="oui-flex oui-items-center oui-gap-1">
              <input
                type="checkbox"
                checked={onlyThisPair}
                onChange={(e) => setOnlyThisPair(e.target.checked)}
              />
              Hide other pairs
            </label>
          )}
        </span>
      </div>

      {needsSignIn ? (
        // No button here — adoption is automatic (see the effect above). This
        // is only what shows while it happens or if it cannot: when trading is
        // not yet enabled there is no key to adopt, so point at the exchange's
        // own "Enable Trading" (its action, not ours); otherwise adoption is in
        // flight, or it errored and the effect will retry.
        <div className="oui-flex oui-flex-col oui-items-center oui-gap-2 oui-px-3 oui-py-8 oui-text-center oui-text-base-contrast-36">
          {address && !keyStore.getOrderlyKey(address) ? (
            <span>Enable trading on the exchange to place and track TWAP orders.</span>
          ) : (
            <span>{busy ? "Setting up TWAP…" : "Loading your TWAP orders…"}</span>
          )}
          {error && (
            <span className="oui-max-w-[420px] oui-text-danger">{error}</span>
          )}
        </div>
      ) : (
        <div className="oui-min-h-0 oui-flex-1 oui-overflow-x-auto">
          <DataTable<TicketProgress>
            columns={columns}
            dataSource={visible}
            loading={rows === null && !error}
            generatedRowKey={(r: any) => r.ticket_id}
            // The SDK owns the scroll container. `h-full` fills the tab when the
            // host bounds it; the max-h keeps the list scrollable rather than
            // pushing the page down if it does not. `overflow-x-auto` (here and
            // on the wrapper) makes the fixed-width columns SCROLL sideways when
            // the panel is narrower than their total, instead of overflowing and
            // knocking the header out of line with the body (the "跑版" PM saw).
            classNames={{
              root: "oui-h-full",
              scroll: "oui-h-full oui-max-h-[420px] oui-overflow-x-auto",
            }}
            emptyView={
              <div className="oui-py-8 oui-text-center oui-text-xs oui-text-base-contrast-36">
                {error
                  ? `Could not load your orders — ${error}`
                  : view === "running"
                    ? "No running bot orders."
                    : "No finished bot orders yet."}
              </div>
            }
          />
        </div>
      )}

      {error && rows && <div className="oui-px-3 oui-py-2 oui-text-danger">{error}</div>}
    </div>
  );
}
