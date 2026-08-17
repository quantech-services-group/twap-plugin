# twap-plugin

TWAP algorithmic execution as an **Orderly Network SDK plugin**.

Adds a TWAP order type and a **Bot** tab to an Orderly-SDK DEX front-end. Instead
of sending the whole order at once, it works the order over a duration you choose,
slicing it and placing it as taker. The panel replaces the order-entry body for
the TWAP order type and leaves every other order type untouched; the Bot tab lists
the resulting tickets (Running / History) with their fill progress and duration.

## Install

The plugin is bundled into your own Orderly-SDK front-end (there is no marketplace
install — you host the front-end and register the plugin in it):

```tsx
import { registerTwapExec } from "twap-plugin";

<OrderlyAppProvider brokerId="…" plugins={[registerTwapExec()]}>
  …
</OrderlyAppProvider>
```

That is the whole setup. The execution backend is hosted for you and already
pointed at; the plugin reads the active symbol and account from the Orderly SDK
context and uses whatever `brokerId` your app already has. Requires the
`@orderly.network/*` v3 SDK (declared as `orderlyVersion: "^3.0.0"`).

A trader's first TWAP asks their wallet to sign Orderly's `AddOrderlyKey` once,
delegating for 30 days. Nothing reusable is stored in their browser.

## Execution

Every ticket runs **taker**: sliced market/IOC orders paced across the duration.
(A maker mode exists in the code but is hidden until it paces across the whole
window rather than filling as fast as the touch is hit.)

Duration is entered as hours + minutes (1 minute to 168 hours); the server
enforces the same bounds. The Bot tab shows each ticket's window as `2h 5m` /
`6h` / `5m`.

## Markets

All official Orderly perps (`PERP_<BASE>_USDC`) are supported. A permissionless /
community listing (a fourth symbol segment, e.g. `PERP_CTEST_USDC_<suffix>`) is
also supported, but it trades **isolated-margin only** — so the form asks the
trader to set that market to isolated margin on their account first, and only then
renders the order form (otherwise every slice would fail on margin).

## How a request proves who it is

The browser generates an ECDSA P-256 keypair the first time you enable TWAP. Its
public half is bound to your account at the moment Orderly confirms your wallet
signed `AddOrderlyKey`; every later request carries a signature over that exact
call. Nothing reusable crosses the network — a captured request yields a
signature for one call at one instant.

The private key lives in IndexedDB as a non-extractable `CryptoKey`: script on
the page can ask it to sign but cannot read it out. Clearing site data or moving
to another browser means onboarding again.

## Layout

| File | What it is |
|---|---|
| `src/plugin.tsx` | `registerTwapExec()` — the interceptor descriptor |
| `src/OrderForm.tsx` | `TwapOrderPanel` — the TWAP order form |
| `src/BotPanel.tsx` | `BotPanel` — the Bot tab (Running / History tickets) |
| `src/api.ts` | the backend client |
| `src/signing.ts` | keypair generation, storage and request signing |
| `src/mode.ts` | the TWAP order-type id |

## Development

```bash
npm install
npm run build      # tsc → dist/
npm pack           # inspect the tarball before publishing
```
