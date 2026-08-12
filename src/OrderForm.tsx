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
 * Orderly has two kinds of symbol. Shared markets are `PERP_<BASE>_USDC`, and a
 * broker that lists its own adds a fourth segment naming itself —
 * `PERP_AAPL_USDC_mythos`. On mainnet that is 50 of 130 markets, nearly all of
 * them `mythos`, and nearly all of the equities.
 *
 * The engine cannot round-trip the fourth segment: its `Symbol` type holds a
 * base and a quote, so an order goes back out as `PERP_AAPL_USDC`, which is not
 * a market that exists. Two further things would need solving even then — those
 * markets require isolated margin, and several accept only POST_ONLY while the
 * strategy sends IOC.
 *
 * So this is checked here rather than left to fail later. Placing the ticket
 * would otherwise succeed, and it would sit at OPEN until its deadline with
 * nothing happening and nothing logged.
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

  // Order size can be entered either as a quantity or as notional; the mark
  // price converts between them and the quantity remains the single source of
  // truth (it is what the host's store and our ticket both use).
  const markPrice = useMarkPriceBySymbol(orderlySymbol);
  const setQuantity = (value: string) =>
    actions?.updateOrderByKey?.("order_quantity", value);
  const notional =
    Number(qty) > 0 && markPrice > 0 ? String(Number((Number(qty) * markPrice).toFixed(2))) : "";
  const setNotional = (value: string) => {
    const usd = Number(value);
    if (!value) return setQuantity("");
    if (!Number.isFinite(usd) || markPrice <= 0) return;
    setQuantity(String(Number((usd / markPrice).toFixed(baseDp))));
  };

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
  // ADDRESS drives our own session auth (challenge → sign → Bearer token); the
  // order then executes on THIS trader's account, not a hardcoded one.
  const { state } = useAccount();
  const brokerId = useConfig<string>("brokerId");
  const address = state?.address;

  // Sign through the wallet the trader actually connected (MetaMask,
  // WalletConnect, Binance, …) rather than a hardcoded injected provider, so
  // every wallet the host DEX supports works with this plugin.
  const { wallet, connectedChain } = useWalletConnector();
  const walletProvider = wallet?.provider as
    | { request(args: { method: string; params?: unknown[] }): Promise<any> }
    | undefined;
  const chainId = connectedChain?.id ? Number(connectedChain.id) : undefined;

  // Only allow submitting once the trader has completed Orderly's own login
  // ("Enable Trading"). Before that there is no account context: balances and
  // positions read 0, so a ticket would target a position we cannot see.
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
    // Ticket target is ABSOLUTE (executor computes the delta to trade).
    const target_position = currentPosition + (side === "BUY" ? size : -size);
    const ticket = {
      exchange: "orderly" as const,
      // Orderly-native symbol (e.g. "PERP_ETH_USDC") — matches the server's
      // instrument cache (GET /v1/public/info) and the executor's parser.
      symbol: orderlySymbol,
      target_position,
      time_constraint_ms: timeoutMs,
      strategy, // MAKER / TAKER hint for the execution engine
    };
    const hasWallet = !!(address && brokerId && walletProvider && chainId);

    // Real auth: one signature delegates a trading key to the executor and
    // returns the credential this order authenticates with, so it executes on
    // THIS connected trader's account. Already authorized? No prompt. With no
    // wallet available (local/demo harness) we fall back to the static key.
    const withSession = async () => {
      if (!hasWallet) return undefined;
      setStatus("Sign to enable TWAP…");
      return await authorize(brokerId!, address!, chainId!, walletProvider);
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
        setStatus(`Placed ${res.ticket_id.slice(0, 10)}… — see the Bot tab`);
      } catch (e: any) {
        // The credential was rejected — it has already been dropped, so a second
        // attempt authorizes afresh. Worth one retry rather than a dead end: the
        // usual cause is a delegation that lapsed or a server that was
        // redeployed, and the trader can do nothing useful with either message.
        if (e?.name !== "NotSignedInError" || !hasWallet) throw e;
        session = await withSession();
        setStatus("Placing…");
        const res = await placeWhenReady(session);
        setStatus(`Placed ${res.ticket_id.slice(0, 10)}… — see the Bot tab`);
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
    // Name the asset and the broker, and say the limit is this market rather
    // than the asset. Without that it reads as arbitrary: on the same exchange
    // TSLA works and AAPL does not, because TSLA is listed as a shared market
    // and AAPL only as `PERP_AAPL_USDC_mythos`. A trader who is not told this
    // concludes the panel is broken.
    const broker = orderlySymbol.split("_").slice(3).join("_");
    return (
      <div className="oui-flex oui-flex-col oui-items-center oui-gap-1.5 oui-rounded-lg oui-bg-base-8 oui-p-4 oui-text-center oui-text-sm">
        <span className="oui-text-base-contrast">TWAP is not available for {base}</span>
        <span className="oui-text-xs oui-text-base-contrast-36">
          This is a broker-exclusive market{broker ? ` (${broker})` : ""}. Smart execution supports
          shared markets only.
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
