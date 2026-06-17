/**
 * Server-side / test helpers for constructing the pop 402 wire format.
 *
 * These mirror the verifier side so tests (and reference server impls) can
 * produce a valid `WWW-Authenticate: Payment` header and inspect a credential.
 * They live in the published surface because they are small, dependency-free,
 * and useful for anyone implementing the gate. Adapted from Alby's
 * `makeMppWwwAuthenticateHeader` / `encodeMppChargeRequest` (MIT).
 */

import { encodeBase64url, decodeBase64url, jcs } from "./envelope.js";

/** Build the inner base64url-encoded `request` auth-param from a `creqA…`. */
export const encodePopRequest = (cashuRequest: string): string =>
  encodeBase64url(jcs({ cashu_request: cashuRequest }));

/**
 * Build a `WWW-Authenticate: Payment …` header value for `method="cashu"`.
 *
 * @param args.id opaque challenge id.
 * @param args.realm protection space.
 * @param args.request base64url request auth-param (see {@link encodePopRequest}).
 * @param args.expires optional RFC 3339 expiry.
 */
export const makePopWwwAuthenticateHeader = (args: {
  id: string;
  realm: string;
  request: string;
  expires?: string;
}): string => {
  let header =
    `Payment id="${args.id}", realm="${args.realm}", method="cashu",` +
    ` intent="charge", request="${args.request}"`;
  if (args.expires) {
    header += `, expires="${args.expires}"`;
  }
  return header;
};

/**
 * Decode an `Authorization: Payment <credential>` header back to the credential
 * object, for verifier-side assertions in tests.
 */
export const decodePopCredential = (
  authorizationHeader: string,
): {
  challenge: Record<string, string>;
  payload: { token: string };
} => {
  const value = authorizationHeader.trim();
  const prefix = "payment ";
  if (!value.toLowerCase().startsWith(prefix)) {
    throw new Error("not a Payment Authorization header");
  }
  const token = value.slice(prefix.length).trim();
  return JSON.parse(decodeBase64url(token));
};
