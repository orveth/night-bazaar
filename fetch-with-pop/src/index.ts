/**
 * @mpp-jams/fetch-with-pop
 *
 * Browser-free, runtime-agnostic fetch wrapper that transparently auto-pays
 * HTTP 402 "Payment" (draft-httpauth-payment / MPP) challenges with
 * `method="cashu"`, using Cashu PoP credentials.
 *
 * Public API:
 *  - {@link fetchWithPop}        drop-in `fetch` wrapper that auto-pays pop 402s
 *  - {@link popPaymentHandler}   standalone handler for an already-received 402
 *  - {@link createCashuPopWallet} cashu-ts-backed {@link PopWallet}
 *  - {@link paymentEnvelope}     the swappable wire-format seam (Payment/MPP)
 *
 * Wire-scheme seam: everything touching the 402 wire format is behind the
 * {@link Envelope} interface in `envelope.ts`. A NUT-24 `X-Cashu` variant is a
 * second `Envelope` passed via the `envelope` option — no other code changes.
 */

// Main wrapper
export { fetchWithPop } from "./fetch-with-pop.js";
export type { FetchWithPopOptions } from "./fetch-with-pop.js";

// Standalone handler
export { popPaymentHandler } from "./mpp.js";
export type { PopHandlerOptions, FetchLike } from "./mpp.js";

// Wallet seam + cashu-ts implementation
export { createCashuPopWallet } from "./wallet.js";
export type {
  PopWallet,
  PopRequest,
  PopInventoryStore,
  CashuTsWalletLike,
  CashuPopWalletDeps,
  DecodePaymentRequestFn,
  EncodeTokenFn,
} from "./wallet.js";

// Envelope seam (swap for a NUT-24 X-Cashu envelope here)
export {
  paymentEnvelope,
  encodeBase64url,
  decodeBase64url,
  jcs,
} from "./envelope.js";
export type { Envelope, PopChallenge, PaymentMaterial } from "./envelope.js";

// Server/test helpers
export {
  encodePopRequest,
  makePopWwwAuthenticateHeader,
  decodePopCredential,
} from "./testing.js";
