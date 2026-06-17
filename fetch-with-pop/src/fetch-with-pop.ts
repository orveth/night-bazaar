/**
 * `fetchWithPop` — a drop-in `fetch` wrapper that transparently auto-pays pop
 * 402s.
 *
 * --- Attribution ---------------------------------------------------------
 * The wrapper shape (force `cache:"no-store"`, do the initial fetch, inspect
 * `www-authenticate`, dispatch to a method handler, otherwise return the
 * original response) mirrors @getalby/lightning-tools `src/402/fetch402.ts`,
 * MIT, Copyright (c) 2023 Alby contributors.
 * -------------------------------------------------------------------------
 */

import { paymentEnvelope, type Envelope } from "./envelope.js";
import {
  popPaymentHandler,
  type FetchLike,
  type PopHandlerOptions,
} from "./mpp.js";
import type { PopWallet } from "./wallet.js";

/** Options for {@link fetchWithPop}. */
export interface FetchWithPopOptions {
  /** The pop wallet that produces an exact-amount `cashuB…` token. */
  wallet: PopWallet;
  /** Optional spend cap in the request's unit; enforced before any swap. */
  maxAmount?: number;
  /**
   * Wire envelope. Defaults to `Payment`/MPP. Swap for a NUT-24 `X-Cashu`
   * envelope here to change wire schemes with zero other code changes.
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
 * A drop-in `fetch` that auto-pays pop 402 challenges.
 *
 * Flow:
 *  1. force `cache: "no-store"` (pop challenges are consume-once; a cached 402
 *     or cached paid response would corrupt the protocol), do the initial fetch;
 *  2. if the response is not a pop 402 for the active envelope, return it
 *     unchanged;
 *  3. otherwise pay exactly once (see {@link popPaymentHandler}) and return the
 *     retried response.
 *
 * The returned `Response` is the caller's to consume. On a non-402 (or a 402
 * that does not match the envelope) the body is untouched and fully readable.
 *
 * @param input request input, as for `fetch`.
 * @param init request init, as for `fetch`. `headers` is normalized to a
 *   `Headers` object and reused on the paid retry.
 * @param options pop wallet + optional cap/envelope/fetch.
 */
export const fetchWithPop = async (
  input: string | URL | Request,
  init: RequestInit | undefined,
  options: FetchWithPopOptions,
): Promise<Response> => {
  if (!options?.wallet) {
    throw new Error("fetch-with-pop: options.wallet is required");
  }
  const envelope = options.envelope ?? paymentEnvelope;
  const doFetch = resolveFetch(options.fetchImpl);

  const fetchArgs: RequestInit = init ? { ...init } : {};
  // Consume-once: never serve a pop 402 (or its paid retry) from cache.
  fetchArgs.cache = "no-store";
  const headers = new Headers(fetchArgs.headers ?? undefined);
  fetchArgs.headers = headers;

  const initResp = await doFetch(input, fetchArgs);

  // Cheap pre-check: only 402s can carry a pop challenge. Detection itself is
  // delegated to the envelope (which also tolerates a non-402 with the header).
  const challenge = envelope.detect(initResp);
  if (!challenge) {
    return initResp;
  }

  const handlerOptions: PopHandlerOptions = {
    wallet: options.wallet,
    envelope,
    fetchImpl: doFetch,
    ...(options.maxAmount !== undefined ? { maxAmount: options.maxAmount } : {}),
  };

  return popPaymentHandler(input, fetchArgs, initResp, handlerOptions);
};

export type { PopWallet };
