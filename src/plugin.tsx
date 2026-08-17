/**
 * TWAP execution module — Orderly Network marketplace plugin.
 *
 * A DEX installs this plugin into its `OrderlyAppProvider`:
 *
 *   import { registerTwapExec } from "twap-plugin";
 *   <OrderlyAppProvider plugins={[registerTwapExec()]} ... />
 *
 * TWAP is offered as a custom order type through the SDK's own extension points:
 * the order-type dropdowns accept a non-built-in id, and the host then reports it
 * back as `selectedCustomTypeId`. So TWAP appears in the Advanced list next to
 * Stop Limit / Scaled / …, and selecting it swaps the order form body and submit
 * for ours — the trader never sees two competing order forms.
 *
 * NOTE: the interceptor `component(Original, props, api)` is NOT itself a React
 * component — do not call hooks in it. It renders a child that owns hook usage.
 */
import * as React from "react";
import type { OrderlyPlugin } from "@orderly.network/plugin-core";

import { TwapOrderPanel } from "./OrderForm.js";
import { BotPanel } from "./BotPanel.js";
import { TWAP_TYPE_ID } from "./mode.js";

/** Id of the data-list tab. Distinct from the order type — the tab holds every
 *  strategy the module offers, of which TWAP is the first. */
const BOT_TAB_ID = "twap-bot";

/** <style> element id for the one CSS rule that pins the Bot trigger last. */
const BOT_TAB_ORDER_STYLE_ID = "twap-bot-tab-order";

/** Runtime injector targets (see @orderly.network/ui-order-entry). */
const ADVANCED_SELECT_TARGET = "Trading.OrderEntry.AdvancedSelect";
const MOBILE_TYPE_SELECT_TARGET = "Trading.OrderEntry.MobileTypeSelect";
const BODY_TARGET = "Trading.OrderEntry.Body";
const BUY_SELL_SWITCH_TARGET = "Trading.OrderEntry.BuySellSwitch";
const DATA_LIST_DESKTOP_TABS = "Trading.DataList.Desktop.Tabs";
const DATA_LIST_MOBILE_TABS = "Trading.DataList.Mobile.Tabs";

const TWAP_OPTION = { value: TWAP_TYPE_ID, label: "TWAP" };

/**
 * Add TWAP to an order-type dropdown. The host routes a non-built-in value to
 * `onExtraSelect`, so we only have to contribute the option and mirror the
 * choice locally for the slots the host does not hand it to.
 */
function withTwapOption(Original: React.ComponentType<any>, props: any) {
  const items = Array.isArray(props?.items) ? props.items : [];
  if (items.some((i: any) => i?.value === TWAP_TYPE_ID)) {
    return <Original {...props} />;
  }
  return (
    <Original
      {...props}
      items={[...items, TWAP_OPTION]}
      onValueChange={(value: string) => props?.onValueChange?.(value)}
    />
  );
}

/**
 * Append the Bot tab to the host's data list. Its own tabs only know about
 * exchange orders, so a ticket would otherwise be visible only as scattered
 * child fills with nothing showing the order that produced them.
 *
 * A COMPONENT, not an inline builder, because the interceptor runs on every
 * render of the host's data-list slot — and that slot re-renders several times
 * a second on a trading page (order book, mark price, positions all tick).
 * Building `items` and the `<BotPanel/>` element inline there handed the host a
 * brand-new array and element identity on every tick, so the whole tab strip
 * re-rendered (and BotPanel could remount) continuously — the flicker PM saw.
 * Here the appended item and the panel are memoized on `symbol` alone, so
 * between market ticks the host receives the exact same references and leaves
 * the tab strip untouched.
 */
function DataListWithBot({
  Original,
  props,
}: {
  Original: React.ComponentType<any>;
  props: any;
}) {
  const hostItems: any[] = Array.isArray(props?.items) ? props.items : [];
  const symbol = props?.symbol;

  // BotPanel and the injected item are referentially STABLE: the tab registers
  // exactly once and never re-registers, so the host's tab strip is never
  // churned. Content churn (a fresh element every render) was the flicker.
  const panel = React.useMemo(() => <BotPanel symbol={symbol} />, [symbol]);
  const botItem = React.useMemo(
    () => ({ id: BOT_TAB_ID, title: "Bot", content: panel }),
    [panel],
  );
  const items = React.useMemo(
    () => (hostItems.some((i) => i?.id === BOT_TAB_ID) ? hostItems : [...hostItems, botItem]),
    [hostItems, botItem],
  );

  // Keep the Bot tab visually LAST — with CSS, NOT by touching registration.
  //
  // The host orders triggers by an insertion-ordered map and moves any tab to
  // the END whenever its content re-registers (its content ref changes). The
  // built-in tabs carry live data and re-register on every update, so a stable
  // injected tab drifts ahead of them and lands first. Re-registering our tab
  // to chase the end just made it visibly bounce first↔last (the host's
  // delete+re-add is not batched into one commit).
  //
  // So leave registration untouched (stable = zero churn = zero flicker) and
  // pin the position purely visually: the trigger row is `display:flex`, and
  // Radix names each trigger `…-trigger-<value>`, so one `order` rule on our
  // trigger renders it last wherever it sits in the map. One <style> in <head>.
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(BOT_TAB_ORDER_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = BOT_TAB_ORDER_STYLE_ID;
    style.textContent = `[id$="-trigger-${BOT_TAB_ID}"]{order:9999}`;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, []);

  return <Original {...props} items={items} />;
}

/**
 * The order form body: the whole TWAP form while our type is selected, the
 * host's own body otherwise.
 *
 * Everything TWAP needs lives here — quantity, duration, maker/taker and the
 * submit — because the host does not render its submit section for a custom
 * order type, so a plugin's body has to be self-contained.
 */
function OrderEntryBody({
  Original,
  props,
  api,
}: {
  Original: React.ComponentType<any>;
  props: any;
  api: any;
}) {
  if ((props?.selectedCustomTypeId ?? null) !== TWAP_TYPE_ID) {
    return <Original {...props} />;
  }
  return <TwapOrderPanel symbol={props?.symbol} api={api} />;
}

/**
 * Returns the plugin descriptor consumed by `OrderlyAppProvider`'s `plugins` prop.
 * `id` must equal `pluginId` in `.orderly-manifest.json`.
 */
export function registerTwapExec(): OrderlyPlugin {
  return {
    name: "TWAP Execution",
    id: "twap-exec",
    // Keep in sync with package.json on every release.
    version: "2.0.3",
    // Host SDK compatibility gate. Matches the value published Orderly plugins
    // use (e.g. Starchild's `>=2.10.1`) — a permissive floor rather than a
    // capped range, so a host on any current SDK keeps loading us instead of
    // being gated out by an upper bound. It is advisory today (plugin-core
    // 3.1.8 does not enforce it); the hard requirement is the `@orderly.network/*`
    // v3 peer dependencies. We build and test against 3.1.8.
    orderlyVersion: ">=2.10.1",
    interceptors: [
      {
        target: ADVANCED_SELECT_TARGET,
        component: (Original: React.ComponentType<any>, props: any) =>
          withTwapOption(Original, props),
      },
      {
        target: MOBILE_TYPE_SELECT_TARGET,
        component: (Original: React.ComponentType<any>, props: any) =>
          withTwapOption(Original, props),
      },
      {
        // Our body carries its own Buy/Sell, so hide the host's for this type
        // rather than leaving two side controls that can disagree.
        target: BUY_SELL_SWITCH_TARGET,
        component: (Original: React.ComponentType<any>, props: any) =>
          (props?.selectedCustomTypeId ?? null) === TWAP_TYPE_ID ? null : (
            <Original {...props} />
          ),
      },
      {
        target: DATA_LIST_DESKTOP_TABS,
        component: (Original: React.ComponentType<any>, props: any) => (
          <DataListWithBot Original={Original} props={props} />
        ),
      },
      {
        target: DATA_LIST_MOBILE_TABS,
        component: (Original: React.ComponentType<any>, props: any) => (
          <DataListWithBot Original={Original} props={props} />
        ),
      },
      {
        target: BODY_TARGET,
        component: (Original: React.ComponentType<any>, props: any, api: any) => (
          <OrderEntryBody Original={Original} props={props} api={api} />
        ),
      },
    ],
  };
}

export default registerTwapExec;
