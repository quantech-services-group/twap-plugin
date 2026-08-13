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
} from "@orderly.network/hooks";
import { AccountStatusEnum } from "@orderly.network/types";

import {
  placeTicket,
  authorize,
  waitForExecutorReady,
  shortTicketId,
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
 * Whether the execution engine can trade this market.
 *
 * Orderly symbols come in two shapes. An official listing is `PERP_<BASE>_USDC`
 * (three segments). A symbol with a fourth segment — `PERP_CTEST_USDC_alpix` —
 * is NOT an official Orderly listing; the suffix is who requested the listing,
 * not who it belongs to. Per Orderly (2026-08-11): every DEX can trade these,
 * they are not broker-exclusive — the one thing that sets them apart is that
 * they trade in **isolated-margin mode only**.
 *
 * We do not support them, and isolated-margin-only is the reason: the engine
 * trades cross-margin, and it also cannot round-trip the fourth segment (its
 * `Symbol` type is base+quote, so the order would go back out as
 * `PERP_CTEST_USDC` — a market that does not exist).
 *
 * Checked here rather than left to fail later: placing the ticket would
 * otherwise succeed and then sit at OPEN until its deadline, doing nothing.
 */
function isSupportedMarket(symbol: string): boolean {
  const parts = symbol.split("_");
  return parts.length === 3 && parts[0].toUpperCase() === "PERP";
}

export function TwapOrderPanel({ symbol, api }: { symbol?: string; api?: any }) {
  const { base, quote } = splitSymbol(symbol);

  const [timeoutMs, setTimeoutMs] = React.useState<number>(TIMEOUT_PRESETS[1].ms);
  const [strategy, setStrategy] = React.useState<Strategy>("MAKER");
  const [status, setStatus] = React.useState<string>("");

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
  const supported = isSupportedMarket(orderlySymbol);

  // Display precision for this market: the exchange's own base decimal places
  // (base_tick 0.0001 -> 4 dp for ETH), so sizes are not shown to a made-up
  // precision the instrument does not trade in.
  const symbolInfo = useSymbolInfo(orderlySymbol);
  const baseDp: number = (symbolInfo?.("base_dp", 4) as number | undefined) ?? 4;

  // Qty (base) and order size (notional) are both editable and each converts to
  // the other using the mark price AT THE MOMENT OF ENTRY. Quantity stays the
  // single source of truth (the host store and our ticket use it); the notional
  // is local state so a ticking mark price never rewrites the figure the trader
  // just typed or is reading.
  const markPrice = useMarkPriceBySymbol(orderlySymbol);
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
    if (!Number.isFinite(usd) || markPrice <= 0) return;
    const nextQty = String(Number((usd / markPrice).toFixed(baseDp)));
    notionalDrivenQty.current = nextQty;
    setQuantity(nextQty);
  };

  // Recompute the order size only when the QUANTITY changes for another reason —
  // typed in the Qty box, or the host slider / max button. Keyed on qty (not
  // markPrice) so a ticking price never moves it, and skipped when the quantity
  // is the one the order-size box just produced so the typed figure is kept.
  React.useEffect(() => {
    if (qty === notionalDrivenQty.current) return;
    if (!(Number(qty) > 0) || !(markPrice > 0)) {
      if (!qty) setNotionalState("");
      return;
    }
    setNotionalState(String(Number((Number(qty) * markPrice).toFixed(2))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qty]);

  // Timeout is entered as hours + minutes; the ticket carries milliseconds.
  const hours = String(Math.floor(timeoutMs / 3_600_000) || 0);
  const minutes = String(Math.floor((timeoutMs % 3_600_000) / 60_000) || 0);
  const setDuration = (h: string, m: string) => {
    const ms = (Number(h) || 0) * 3_600_000 + (Number(m) || 0) * 60_000;
    setTimeoutMs(ms);
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

  // Only allow submitting once the trader has completed Orderly's own login
  // ("Enable Trading"). Before that there is no account context: balances and
  // positions read 0, so a ticket would target a position we cannot see. It is
  // also what guarantees the keyStore holds a trading key for us to adopt.
  const isTradingEnabled = state?.status === AccountStatusEnum.EnableTrading;

  // Live progress is NOT tracked here. A placed ticket appears under Running in
  // the Bot tab, which follows every ticket on the account rather than only the
  // one this form last placed — mirroring it here would put the same order on
  // screen twice, with two things able to disagree about it.

  async function onSubmit() {
    if (!isTradingEnabled) {
      setStatus("Connect your wallet and enable trading first");
      return;
    }
    const size = Number(qty);
    if (!Number.isFinite(size) || size <= 0) {
      setStatus("Enter a quantity in the order form above");
      return;
    }
    // Timeout must be a real TWAP window: at least a minute (below that there is
    // nothing to slice), at most a week.
    const MIN_TIMEOUT_MS = 60_000; // 1 minute
    const MAX_TIMEOUT_MS = 168 * 60 * 60_000; // 168 hours (7 days)
    if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      setStatus("Timeout must be between 1 minute and 168 hours");
      return;
    }
    // Notional gate — mirrors the executor. An order that OPENS or increases the
    // position must clear the exchange's minimum notional, or every slice falls
    // below the minimum, gets rejected, and the ticket sits doing nothing until
    // it expires. A REDUCE (trading against the current position) is exempt: you
    // can always close a position, however small the remainder.
    const tradeDir = side === "BUY" ? 1 : -1;
    const isReduce = currentPosition !== 0 && Math.sign(currentPosition) !== tradeDir;
    const minNotional = Number(symbolInfo?.("min_notional", 0)) || 0;
    if (!isReduce && minNotional > 0 && markPrice > 0 && size * markPrice < minNotional) {
      setStatus(
        `Order size must be at least ${minNotional} ${quote} (min notional), or reduce your position`,
      );
      return;
    }
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

    try {
      let session = await withSession();
      setStatus("Placing…");
      try {
        const res = await placeWhenReady(session);
        // Name the ticket so the trader can find this exact order in the Bot tab.
        setStatus(`Placed ${shortTicketId(res.ticket_id)}`);
      } catch (e: any) {
        // The credential was rejected — it has already been dropped, so a second
        // attempt authorizes afresh. Worth one retry rather than a dead end: the
        // usual cause is a delegation that lapsed or a server that was
        // redeployed, and the trader can do nothing useful with either message.
        if (e?.name !== "NotSignedInError" || !hasWallet) throw e;
        session = await withSession();
        setStatus("Placing…");
        const res = await placeWhenReady(session);
        setStatus(`Placed ${shortTicketId(res.ticket_id)}`);
      }
    } catch (e: any) {
      setStatus(
        e?.name === "NotSignedInError"
          ? "Failed: connect your wallet and enable trading, then try again"
          : `Failed: ${e?.message ?? e}`,
      );
    }
  }

  const btn = (active: boolean) =>
    `oui-px-2 oui-py-1 oui-rounded oui-text-sm ${active ? "oui-bg-primary oui-text-white" : "oui-bg-base-6"}`;

  // Say so instead of rendering a form that cannot work. The host DEX decides
  // which market is on screen, so this panel appears on markets the engine
  // cannot trade; letting someone fill the form in and submit would place a
  // ticket that sits at OPEN until its deadline, doing nothing.
  if (!supported) {
    // Say the limit is this market, not the asset, and why — otherwise it
    // reads as arbitrary (the same asset can have an official listing that
    // works and a non-official one that does not). A fourth segment marks a
    // non-official listing, which trades isolated-margin-only; the engine
    // trades cross-margin, so it cannot work these.
    return (
      <div className="oui-flex oui-flex-col oui-items-center oui-gap-1.5 oui-rounded-lg oui-bg-base-8 oui-p-4 oui-text-center oui-text-sm">
        <span className="oui-text-base-contrast">TWAP is not available for {base}</span>
        <span className="oui-text-xs oui-text-base-contrast-36">
          This market is not an official Orderly listing, so it trades in
          isolated-margin mode only, which smart execution does not support.
        </span>
        <span className="oui-text-xs oui-text-base-contrast-36">
          Use the exchange&apos;s own order types for {base}.
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
        <span className="oui-text-xs">Strategy</span>
        <div className="oui-grid oui-grid-cols-2 oui-gap-2">
          <button className={btn(strategy === "MAKER")} onClick={() => setStrategy("MAKER")}>Maker</button>
          <button className={btn(strategy === "TAKER")} onClick={() => setStrategy("TAKER")}>Taker</button>
        </div>
      </div>

      {/* Where this order leaves the position. The engine works to an absolute
          target, so state it before the trader commits. */}
      {Number(qty) > 0 && (
        <div className="oui-flex oui-justify-between oui-text-xs oui-text-base-contrast-54">
          <span>Position</span>
          <span>
            {formatQty(currentPosition, baseDp)} →{" "}
            {formatQty(currentPosition + (side === "BUY" ? Number(qty) : -Number(qty)), baseDp)} {base}
          </span>
        </div>
      )}

      <button
        className={`oui-mt-1 oui-py-2 oui-rounded oui-text-white ${
          !isTradingEnabled
            ? "oui-bg-base-6 oui-cursor-not-allowed"
            : side === "BUY"
              ? "oui-bg-success"
              : "oui-bg-danger"
        }`}
        onClick={onSubmit}
        disabled={!isTradingEnabled}
      >
        {isTradingEnabled
          ? `${side === "BUY" ? "Buy / Long" : "Sell / Short"} ${base}`
          : "Connect wallet to trade"}
      </button>

      {status && <div className="oui-text-xs oui-text-base-contrast-54">{status}</div>}
    </div>
  );
}
