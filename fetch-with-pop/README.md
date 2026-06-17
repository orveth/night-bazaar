# @mpp-jams/fetch-with-pop

Browser-free, runtime-agnostic `fetch` wrapper that transparently auto-pays HTTP
`402` **"Payment"** (draft-httpauth-payment / MPP) challenges with
`method="cashu"`, using Cashu **PoP** credentials. "Alby for pops" — the reusable
protocol core a browser extension (or CLI, or agent) wraps.

It ports the battle-tested 402 envelope from
[`@getalby/lightning-tools`](https://github.com/getAlby/js-lightning-tools)
`src/402/` (MIT) — header parse, base64url, JCS (RFC 8785) canonicalization,
challenge echo, single-retry — and swaps the lightning `preimage` payload for a
Cashu `cashu_token` payload. The token engine is
[`@cashu/cashu-ts`](https://github.com/cashubtc/cashu-ts).

## The scheme

1. Server returns `402` with
   `WWW-Authenticate: Payment id="…", realm="…", method="cashu", intent="charge", request="<base64url(JSON{cashu_request:"creqA…"})>"`
   and `Cache-Control: no-store`.
2. The inner `creqA…` is a NUT-18 payment request naming the **exact** amount +
   unit (`pop_<ts>`) + mints.
3. The client carves a `cashuB…` token worth **exactly** that amount via a
   holder-side NUT-03 swap (keeping the remainder), then retries the **same**
   request with
   `Authorization: Payment <base64url(JCS{challenge:{…}, payload:{cashu_token:"cashuB…"}})>`.
4. The verifier swaps-to-charge; over- **or** under-amount is rejected.

## Usage

```ts
import { Wallet, Mint, decodePaymentRequest, getEncodedToken } from "@cashu/cashu-ts";
import { fetchWithPop, createCashuPopWallet } from "@mpp-jams/fetch-with-pop";

// cashu-ts v4: class is `Wallet` (not `CashuWallet`); unit is the POP unit.
const mint = new Mint("https://mint.example");
const cashuTsWallet = new Wallet(mint, { unit: "pop_1782668279" });

const wallet = createCashuPopWallet({
  wallet: cashuTsWallet,
  inventory: {
    load: (mintUrl, unit) => loadUnspentPops(mintUrl, unit), // your store
    commit: (mintUrl, unit, keep, _spent) => saveUnspentPops(mintUrl, unit, keep),
  },
  decodePaymentRequest, // from @cashu/cashu-ts
  getEncodedToken,      // from @cashu/cashu-ts
});

const res = await fetchWithPop("https://api.example/paywalled", undefined, {
  wallet,
  maxAmount: 100, // optional spend cap, in the request's unit
});
// res is the paid response (or the original non-402 response, untouched).
```

`fetchWithPop(input, init, { wallet, maxAmount?, envelope?, fetchImpl? })` is a
drop-in `fetch`. For an already-received 402 there is a standalone
`popPaymentHandler(input, init, response, options)`.

## Public API

- `fetchWithPop(input, init, options)` — drop-in `fetch` that auto-pays pop 402s.
- `popPaymentHandler(input, init, response, options)` — pay a single 402 you
  already have in hand.
- `createCashuPopWallet(deps)` — a `PopWallet` backed by cashu-ts: decode the
  NUT-18 request, NUT-03 swap to exact amount, keep change, encode `cashuB`.
- `paymentEnvelope` — the wire-format codec (the swappable seam, see below).
- `PopWallet` / `PopRequest` / `PopInventoryStore` — the wallet seam interfaces.
- Test/server helpers: `makePopWwwAuthenticateHeader`, `encodePopRequest`,
  `decodePopCredential`.

## The swappable envelope seam

Everything touching the **402 wire format** lives behind the `Envelope`
interface in [`src/envelope.ts`](./src/envelope.ts). The default is
`paymentEnvelope` (`WWW-Authenticate: Payment` / `Authorization: Payment`).

To support the Cashu-native **NUT-24 `X-Cashu`** scheme (request + payment both
in a single `X-Cashu` header, no JCS challenge echo), implement a second
`Envelope` and pass it as `options.envelope` to `fetchWithPop` /
`popPaymentHandler`. **No other code changes** — the handler and wrapper speak
only `detect` / `requestFrom` / `applyPayment` / `isPaymentHeader`.

## Browser-free

No DOM or `chrome.*` APIs. Uses only Web-standard globals (`fetch`, `Request`,
`Response`, `Headers`, `atob`/`btoa`, `TextEncoder`/`TextDecoder`) present in
Node 18+ and browsers. A `fetchImpl` option lets you inject any `fetch`.

## License

MIT. Ports MIT-licensed code from `@getalby/lightning-tools`; see [LICENSE](./LICENSE).
