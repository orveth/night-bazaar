/**
 * draft-cashu-charge-01 payer codec: written FRESH against the pops repo's
 * `skills/payment-credential.md` (the audited wire description; source of
 * truth `pops/crates/pops-core-verify/src/envelope.rs` @ 7e366f0).
 *
 * fetch-with-pop's old flat `{cashu_request}` envelope is DEAD and nothing
 * here imports it. What this module does:
 *
 *   1. parse the 402's `WWW-Authenticate: Payment …` auth-params,
 *   2. decode + sanity-check the base64url-nopad `request` object
 *      (`methodDetails.paymentRequest` = the authoritative NUT-18 creqA),
 *   3. build the `Authorization: Payment <blob>` credential: a JCS-canonical
 *      (RFC 8785) JSON object, base64url-nopad, echoing EVERY issued
 *      challenge param verbatim (the server recomputes the HMAC `id` over the
 *      echo; a decode/re-encode of `request` would break it, so the b64 string
 *      is carried untouched).
 *
 * Cross-language guarantee: `client/test/charge01.test.ts` asserts this codec
 * produces byte-identical blobs to pops-core-verify's own canonical encoders
 * (golden vectors in `protocol/vectors/charge01-vectors.json`).
 */

/** The auth-params of a `WWW-Authenticate: Payment` challenge. */
export interface PaymentChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  /** The base64url-nopad request envelope: echo BYTE-FOR-BYTE, never re-encode. */
  request: string;
  expires?: string;
  digest?: string;
  opaque?: string;
  description?: string;
}

/** The decoded `request` object (charge-01 request envelope). */
export interface RequestObject {
  /** Exact amount required, as a decimal string. */
  amount: string;
  /** Currency unit, e.g. `pop_1781713156`. */
  currency: string;
  description?: string;
  externalId?: string;
  methodDetails: {
    /** The authoritative NUT-18 payment request (`creqA…`). */
    paymentRequest: string;
  };
}

export class Charge01Error extends Error {
  constructor(
    message: string,
    /** Machine-readable reason for the HUD / tests. */
    readonly code:
      | "bad-header"
      | "bad-request-object"
      | "challenge-expired"
      | "mismatched-request"
      | "unacceptable",
  ) {
    super(message);
    this.name = "Charge01Error";
  }
}

const KNOWN_PARAMS = [
  "id",
  "realm",
  "method",
  "intent",
  "request",
  "expires",
  "digest",
  "opaque",
  "description",
] as const;

/**
 * Parse a `WWW-Authenticate: Payment …` header value (port of envelope.rs
 * `parse_payment_params`): values MUST be double-quoted strings (our values
 * never contain quotes or commas, so a naive comma split is safe (same rule
 * as the Rust parser); unknown params are tolerated; the scheme prefix is
 * optional.
 */
export function parsePaymentChallenge(headerValue: string): PaymentChallenge {
  let rest = headerValue.trim();
  const firstWs = rest.search(/\s/);
  if (firstWs > 0 && rest.slice(0, firstWs).toLowerCase() === "payment") {
    rest = rest.slice(firstWs).trim();
  }

  const found: Partial<Record<(typeof KNOWN_PARAMS)[number], string>> = {};
  for (const piece of rest.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim() as (typeof KNOWN_PARAMS)[number];
    if (!KNOWN_PARAMS.includes(key)) continue;
    const raw = trimmed.slice(eq + 1).trim();
    // Strict quoted-string: exactly one matched pair, no interior quote.
    if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
      throw new Charge01Error(
        `WWW-Authenticate Payment \`${key}\` value must be a double-quoted string`,
        "bad-header",
      );
    }
    const inner = raw.slice(1, -1);
    if (inner.includes('"')) {
      throw new Charge01Error(
        `WWW-Authenticate Payment \`${key}\` value is garbled`,
        "bad-header",
      );
    }
    found[key] = inner;
  }

  for (const required of ["id", "realm", "method", "intent", "request"] as const) {
    if (found[required] === undefined) {
      throw new Charge01Error(
        `WWW-Authenticate Payment missing \`${required}\``,
        "bad-header",
      );
    }
  }
  return found as PaymentChallenge & Record<string, string>;
}

/* ----------------------------- base64url-nopad ---------------------------- */

const B64URL = /^[A-Za-z0-9_-]*$/;

/** Decode base64url-NOPAD (a padded blob is malformed under the grammar). */
export function b64urlDecode(b64: string): Uint8Array {
  if (b64.includes("=") || !B64URL.test(b64)) {
    throw new Charge01Error(
      "value is not base64url-nopad",
      "bad-request-object",
    );
  }
  const std = b64.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encode bytes as base64url-nopad. */
export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ------------------------------- JCS (RFC 8785) --------------------------- */

/**
 * JCS-serialize a JSON value: lexicographically sorted object keys (by UTF-16
 * code units, which `Array.prototype.sort` does natively, exactly RFC 8785's
 * ordering), minimal string escaping (native `JSON.stringify`), ECMAScript
 * number formatting (native; RFC 8785 §3.2.2.3 IS the ECMAScript
 * algorithm). Our wire objects carry only strings and nested objects, but the
 * implementation is general for safety.
 */
export function jcsSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Charge01Error("non-finite number in JCS input", "unacceptable");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(jcsSerialize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = entries
    .map(([k, v]) => `${JSON.stringify(k)}:${jcsSerialize(v)}`)
    .join(",");
  return `{${body}}`;
}

/* ------------------------------ request object ---------------------------- */

/** Decode the `request="…"` auth-param into its object. */
export function decodeRequestObject(b64: string): RequestObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(b64.trim())));
  } catch (e) {
    throw new Charge01Error(
      `request object does not decode: ${e instanceof Error ? e.message : e}`,
      "bad-request-object",
    );
  }
  const obj = parsed as Partial<RequestObject> | null;
  if (
    !obj ||
    typeof obj.amount !== "string" ||
    typeof obj.currency !== "string" ||
    typeof obj.methodDetails?.paymentRequest !== "string"
  ) {
    throw new Charge01Error(
      "request object missing amount/currency/methodDetails.paymentRequest",
      "bad-request-object",
    );
  }
  return obj as RequestObject;
}

/** What the wallet decoded from the authoritative creqA. */
export interface CreqaFacts {
  amount: number;
  unit: string;
  mints: string[];
}

/**
 * Client MUSTs before paying (payment-credential.md §1): the creqA must name
 * `a`/`u` and a non-empty `m`, and the top-level `amount`/`currency` must
 * agree with them (amount compared as integers). Also refuse a challenge
 * whose `expires` is already past; re-fetch instead.
 */
export function assertPayable(
  challenge: PaymentChallenge,
  requestObject: RequestObject,
  creqa: CreqaFacts,
  now: Date = new Date(),
): void {
  if (challenge.expires !== undefined) {
    const ts = Date.parse(challenge.expires);
    if (Number.isNaN(ts)) {
      throw new Charge01Error(
        `challenge expires ${challenge.expires} does not parse`,
        "challenge-expired",
      );
    }
    if (ts <= now.getTime()) {
      throw new Charge01Error(
        "challenge already expired — re-fetch the resource",
        "challenge-expired",
      );
    }
  }
  if (!Number.isInteger(creqa.amount) || creqa.amount <= 0) {
    throw new Charge01Error("creqA names no positive amount", "mismatched-request");
  }
  if (!creqa.unit) {
    throw new Charge01Error("creqA names no unit", "mismatched-request");
  }
  if (creqa.mints.length === 0) {
    throw new Charge01Error("creqA names no mints", "mismatched-request");
  }
  const topAmount = Number.parseInt(requestObject.amount, 10);
  if (!Number.isInteger(topAmount) || topAmount !== creqa.amount) {
    throw new Charge01Error(
      `top-level amount ${requestObject.amount} != creqA amount ${creqa.amount}`,
      "mismatched-request",
    );
  }
  if (requestObject.currency !== creqa.unit) {
    throw new Charge01Error(
      `top-level currency ${requestObject.currency} != creqA unit ${creqa.unit}`,
      "mismatched-request",
    );
  }
}

/* -------------------------------- credential ------------------------------ */

/**
 * Build the `Authorization` header value: `Payment ` + base64url-nopad over
 * the JCS-canonical credentials object. The challenge echo carries EVERY
 * param the 402 issued (and nothing it did not; absent optionals are omitted
 * from the JSON, matching serde's `skip_serializing_if`).
 */
export function buildCredential(
  challenge: PaymentChallenge,
  token: string,
): string {
  const echo: Record<string, string> = {
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
    request: challenge.request,
  };
  if (challenge.digest !== undefined) echo.digest = challenge.digest;
  if (challenge.opaque !== undefined) echo.opaque = challenge.opaque;
  if (challenge.expires !== undefined) echo.expires = challenge.expires;
  if (challenge.description !== undefined) echo.description = challenge.description;

  const credentials = {
    challenge: echo,
    payload: { token },
  };
  const blob = b64urlEncode(new TextEncoder().encode(jcsSerialize(credentials)));
  return `Payment ${blob}`;
}

/** Parse an RFC-9457 problem body, tolerantly (for HUD display + retry logic). */
export function problemSlug(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const type = (body as { type?: unknown }).type;
  if (typeof type !== "string") return undefined;
  const m = type.match(/\/problems\/([a-z0-9-]+)$/);
  return m ? m[1] : type;
}
