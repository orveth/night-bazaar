/**
 * Wire-envelope codec for the HTTP-402 "Payment" (draft-httpauth-payment / MPP)
 * scheme.
 *
 * --- Attribution ---------------------------------------------------------
 * The base64url helpers, the JCS (RFC 8785) canonicalizer, the
 * WWW-Authenticate parameter parser, and the challenge-echo credential shape
 * are ported from @getalby/lightning-tools (src/402/mpp/utils.ts), MIT,
 * Copyright (c) 2023 Alby contributors <hello@getalby.com>. They have been
 * generalized so the payload is method-agnostic (lightning -> { preimage },
 * cashu -> { token }; renamed from cashu_token per draft-cashu-charge-01 round 4). See LICENSE for full terms.
 * -------------------------------------------------------------------------
 *
 * THE SWAPPABLE SEAM
 * ==================
 * Everything that touches the *wire format* of the 402 negotiation lives in
 * this file behind the {@link Envelope} interface and the {@link paymentEnvelope}
 * implementation. The handler in `mpp.ts` and the wrapper in `fetch-with-pop.ts`
 * speak ONLY in terms of:
 *
 *   - `envelope.detect(response)`     -> PopChallenge | null
 *   - `envelope.requestFrom(challenge)` -> the inner NUT-18 `creqA…` string
 *   - `envelope.applyPayment(challenge, headers, { cashuToken })`
 *
 * To support the Cashu-native NUT-24 `X-Cashu` scheme (request and payment both
 * in a single `X-Cashu` header, no JCS challenge echo) you implement a second
 * `Envelope` (e.g. `xCashuEnvelope`) and pass it in via the handler's
 * `envelope` option. NOTHING else in the package changes. This file is the only
 * place that knows about `WWW-Authenticate: Payment`, `Authorization: Payment`,
 * base64url, or JCS.
 */

/** The decoded 402 challenge, independent of which wire envelope produced it. */
export interface PopChallenge {
  /** Opaque challenge id, echoed back verbatim. */
  id: string;
  /** Protection space / resource identifier. */
  realm: string;
  /** Payment method. For this package, always `"cashu"`. */
  method: string;
  /** Intent verb. For the pop scheme, `"charge"`. */
  intent: string;
  /**
   * The inner request descriptor as carried on the wire. For the
   * `Payment`/MPP envelope this is the base64url-encoded JSON wrapper around the
   * NUT-18 request; see {@link decodeCashuRequest} for extraction.
   */
  request: string;
  /** Optional RFC 3339 expiry, echoed back when present. */
  expires?: string;
}

/** Extra payment material a handler hands the envelope to seal the credential. */
export interface PaymentMaterial {
  /** A `cashuB…` token worth exactly the challenge's amount. */
  cashuToken: string;
}

/**
 * The wire-format boundary. One implementation == one 402 scheme.
 *
 * Implement this once per scheme; the rest of the package is scheme-agnostic.
 */
export interface Envelope {
  /** Human-readable name, used in error messages. */
  readonly name: string;
  /**
   * Inspect a response for this envelope's 402 challenge.
   *
   * @returns the parsed challenge, or `null` if this response does not carry a
   *   challenge this envelope understands (lets a dispatcher fall through).
   */
  detect(response: Response): PopChallenge | null;
  /**
   * Extract the inner NUT-18 payment-request string (`creqA…`) from a challenge.
   */
  requestFrom(challenge: PopChallenge): string;
  /**
   * Seal the payment into the retry request by mutating `headers`.
   *
   * The handler will re-`fetch` after this returns. Mutating the shared
   * `Headers` object (rather than returning a new one) matches the Alby control
   * flow where `fetchArgs.headers` is the same object across the retry.
   */
  applyPayment(
    challenge: PopChallenge,
    headers: Headers,
    material: PaymentMaterial,
  ): void;
  /**
   * Name of the request header this envelope sets to carry payment. Exposed so
   * the loop-guard can detect an already-paid retry without knowing the scheme.
   */
  readonly paymentHeaderName: string;
  /**
   * Given a header value (the value of {@link paymentHeaderName} on an
   * outgoing request), report whether it already carries a payment for this
   * envelope. Used by the infinite-loop guard.
   */
  isPaymentHeader(headerValue: string | null): boolean;
}

/* ------------------------------------------------------------------------- *
 * base64url (ported from Alby src/402/mpp/utils.ts)                          *
 * ------------------------------------------------------------------------- */

/** Decode a base64url string (no padding required) to a UTF-8 string. */
export const decodeBase64url = (input: string): string => {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
};

/** Encode a UTF-8 string to base64url without padding. */
export const encodeBase64url = (input: string): string => {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
};

/* ------------------------------------------------------------------------- *
 * JCS — JSON Canonicalization Scheme, RFC 8785 (ported from Alby)            *
 * ------------------------------------------------------------------------- */

/**
 * Produce compact JSON with object keys sorted lexicographically at every
 * level. The verifier recomputes this exact byte string to authenticate the
 * challenge echo, so it must match the server's canonicalization.
 */
export const jcs = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + (value as unknown[]).map(jcs).join(",") + "]";
  }
  const keys = Object.keys(value as object).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) + ":" + jcs((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
};

/* ------------------------------------------------------------------------- *
 * WWW-Authenticate parameter parsing (ported from Alby)                      *
 * ------------------------------------------------------------------------- */

/**
 * Parse the auth-params out of a `WWW-Authenticate: Payment …` header.
 *
 * Accepts the documented pop format:
 *
 *   Payment id="<id>", realm="<realm>", method="cashu",
 *           intent="charge", request="<base64url>" [, expires="<rfc3339>"]
 *
 * Returns the raw param map, or `null` if the header is not a `Payment` scheme
 * header at all (so a dispatcher can fall through to another envelope).
 */
const parsePaymentParams = (header: string): Record<string, string> | null => {
  if (!header.trimStart().toLowerCase().startsWith("payment")) {
    return null;
  }
  const rest = header
    .slice(header.toLowerCase().indexOf("payment") + "payment".length)
    .trim();
  const result: Record<string, string> = {};
  const regex = /(\w+)=("([^"]*)"|'([^']*)'|([^,\s]*))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rest)) !== null) {
    const key = match[1] as string;
    result[key] = match[3] ?? match[4] ?? match[5] ?? "";
  }
  return result;
};

/* ------------------------------------------------------------------------- *
 * The Payment / MPP envelope implementation                                  *
 * ------------------------------------------------------------------------- */

/** Inner JSON wrapper that the `request` auth-param base64url-decodes into. */
interface PaymentRequestWrapper {
  /** NUT-18 encoded payment request, `creqA…`. */
  cashu_request: string;
}

/**
 * Build the JCS-canonical, base64url-encoded credential for the
 * `Authorization: Payment` header. Echoes every challenge auth-param and
 * carries the cashu token as the payload.
 *
 * Keys are sorted lexicographically at every level per JCS; the verifier
 * recomputes this to authenticate the echo.
 */
const buildPaymentCredential = (
  challenge: PopChallenge,
  cashuToken: string,
): string => {
  const challengeEcho: Record<string, string> = {
    id: challenge.id,
    intent: challenge.intent,
    method: challenge.method,
    realm: challenge.realm,
    request: challenge.request,
  };
  if (challenge.expires) {
    challengeEcho.expires = challenge.expires;
  }
  const credential = {
    challenge: challengeEcho,
    payload: { token: cashuToken },
  };
  return encodeBase64url(jcs(credential));
};

/**
 * The HTTP-402 "Payment" (draft-httpauth-payment / MPP) envelope, restricted to
 * `method="cashu"`, `intent="charge"`.
 *
 * THIS is the swappable seam. A NUT-24 `X-Cashu` variant is a sibling object
 * implementing {@link Envelope}; no handler/wrapper code changes.
 */
export const paymentEnvelope: Envelope = {
  name: "Payment (draft-httpauth-payment, method=cashu)",
  paymentHeaderName: "Authorization",

  detect(response: Response): PopChallenge | null {
    const header = response.headers.get("www-authenticate");
    if (!header) return null;
    const params = parsePaymentParams(header);
    if (!params) return null;
    if (
      params.method !== "cashu" ||
      params.intent !== "charge" ||
      !params.id ||
      !params.realm ||
      !params.request
    ) {
      return null;
    }
    return {
      id: params.id,
      realm: params.realm,
      method: params.method,
      intent: params.intent,
      request: params.request,
      ...(params.expires ? { expires: params.expires } : {}),
    };
  },

  requestFrom(challenge: PopChallenge): string {
    let wrapper: PaymentRequestWrapper;
    try {
      wrapper = JSON.parse(decodeBase64url(challenge.request));
    } catch {
      throw new Error(
        "fetch-with-pop: `request` auth-param is not valid base64url-encoded JSON",
      );
    }
    if (!wrapper || typeof wrapper.cashu_request !== "string") {
      throw new Error(
        "fetch-with-pop: decoded request is missing the `cashu_request` (creqA…) field",
      );
    }
    return wrapper.cashu_request;
  },

  applyPayment(
    challenge: PopChallenge,
    headers: Headers,
    material: PaymentMaterial,
  ): void {
    const credential = buildPaymentCredential(challenge, material.cashuToken);
    headers.set("Authorization", `Payment ${credential}`);
  },

  isPaymentHeader(headerValue: string | null): boolean {
    return (
      !!headerValue &&
      headerValue.trimStart().toLowerCase().startsWith("payment ")
    );
  },
};
