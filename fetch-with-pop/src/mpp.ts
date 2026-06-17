/**
 * The pop 402 payment handler.
 *
 * --- Attribution ---------------------------------------------------------
 * The single-retry control flow (parse challenge -> derive payment material ->
 * echo challenge -> re-fetch the same request with the credential header) is
 * adapted from @getalby/lightning-tools `src/402/mpp/mpp.ts`
 * (`handleMppChargePayment`), MIT, Copyright (c) 2023 Alby contributors. Where
 * Alby does `wallet.payInvoice -> preimage` and sets `payload:{preimage}`, this
 * does `wallet.payPopRequest -> cashuB token` and sets `payload:{token}`.
 *
 * The infinite-loop guard (bail if the retry would re-send an already-paid
 * request) is adapted from Coinbase x402's `wrapFetchWithPayment`
 * ("Payment already attempted"), Apache-2.0 — reimplemented, not copied.
 * -------------------------------------------------------------------------
 */

import { paymentEnvelope, type Envelope, type PopChallenge } from "./envelope.js";
import type { PopWallet } from "./wallet.js";

/** A `fetch`-compatible function. Injected so the handler is runtime-agnostic. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Options for {@link popPaymentHandler}. */
export interface PopHandlerOptions {
  /** The pop wallet that produces an exact-amount `cashuB…` token. */
  wallet: PopWallet;
  /**
   * Optional spend cap, in the request's unit. If the decoded request's amount
   * exceeds this, the handler throws instead of paying. Enforced before any
   * swap touches the mint.
   */
  maxAmount?: number;
  /**
   * Wire envelope to use. Defaults to the `Payment`/MPP envelope. Swap this for
   * a NUT-24 `X-Cashu` envelope without touching anything else. THIS is the
   * single seam for an alternate 402 wire scheme.
   */
  envelope?: Envelope;
  /** `fetch` implementation. Defaults to the ambient global `fetch`. */
  fetchImpl?: FetchLike;
}

const resolveFetch = (f?: FetchLike): FetchLike => {
  if (f) return f;
  if (typeof fetch !== "function") {
    throw new Error(
      "fetch-with-pop: no global fetch available; pass options.fetchImpl",
    );
  }
  return fetch;
};

/**
 * Pay a single pop 402 and return the retried (paid) response.
 *
 * Given the ALREADY-RECEIVED 402 `response`, this:
 *  1. detects the envelope's challenge on the response (returns the original
 *     response untouched if none — lets a dispatcher fall through);
 *  2. enforces the infinite-loop guard: if `init` already carries this
 *     envelope's payment header, throws (the server 402'd a paid request);
 *  3. extracts the inner `creqA…`, decodes it via the wallet;
 *  4. enforces `maxAmount`;
 *  5. asks the wallet to produce an exact-amount `cashuB…` token (NUT-03 swap);
 *  6. seals the credential into the request headers and re-`fetch`es.
 *
 * @param input the SAME request input that produced `response`.
 * @param init the SAME init; its `headers` are mutated to carry the credential.
 * @param response the 402 response already received for `input`/`init`.
 * @param options handler options.
 * @returns the response to the paid retry, or the original 402 if no challenge.
 */
export const popPaymentHandler = async (
  input: string | URL | Request,
  init: RequestInit | undefined,
  response: Response,
  options: PopHandlerOptions,
): Promise<Response> => {
  const envelope = options.envelope ?? paymentEnvelope;
  const doFetch = resolveFetch(options.fetchImpl);

  const challenge = envelope.detect(response);
  if (!challenge) {
    // Not our scheme — hand the original response back unchanged.
    return response;
  }

  const fetchArgs: RequestInit = init ?? {};
  const headers = new Headers(fetchArgs.headers ?? undefined);
  fetchArgs.headers = headers;

  // --- Infinite-loop guard (x402-style) --------------------------------
  // If we already attached a payment for this envelope and STILL got a
  // challenge, paying again would loop forever and burn pops. Bail loudly.
  if (envelope.isPaymentHeader(headers.get(envelope.paymentHeaderName))) {
    throw new Error(
      `fetch-with-pop: payment already attempted but the server re-issued a ${envelope.name} challenge; aborting to avoid a retry loop`,
    );
  }

  const cashuRequest = envelope.requestFrom(challenge);
  const popRequest = await options.wallet.decodeRequest(cashuRequest);

  if (
    options.maxAmount !== undefined &&
    popRequest.amount > options.maxAmount
  ) {
    throw new Error(
      `fetch-with-pop: request amount ${popRequest.amount} ${popRequest.unit} exceeds maxAmount ${options.maxAmount}`,
    );
  }

  const cashuToken = await options.wallet.payPopRequest(popRequest);

  envelope.applyPayment(challenge, headers, { cashuToken });

  // Consume-once: no caching of paid credentials. Re-fetch the SAME request,
  // now carrying the credential.
  const retryResp = await doFetch(input, fetchArgs);

  // --- Infinite-loop guard (x402-style) --------------------------------
  // We paid and retried with `Authorization: Payment`. If the server STILL
  // returns a challenge for this envelope, retrying again would loop forever
  // and burn pops. Bail loudly rather than paying twice for one resource.
  if (envelope.detect(retryResp)) {
    throw new Error(
      `fetch-with-pop: payment already attempted but the server re-issued a ${envelope.name} challenge; aborting to avoid a retry loop`,
    );
  }

  return retryResp;
};

/** Re-export for callers that want to special-case detection. */
export type { PopChallenge };
