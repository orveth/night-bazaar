/**
 * The gate payer: drives one `POST <gate>` through the full charge-01 dance.
 *
 *   bare POST (with the ws session header)
 *     -> 402 + WWW-Authenticate: Payment
 *     -> decode + verify the request object & creqA (client MUSTs)
 *     -> wallet splits to EXACTLY the amount (overpay is retained by the
 *        verifier, so the swap-to-exact step is the money-safety line)
 *     -> retry same URL+method with Authorization: Payment <blob>
 *     -> 200 = entitlement granted server-side (ws will confirm)
 *
 * Failure handling per payment-credential.md §Outcomes:
 *   - 402 payment-expired: re-present the SAME token against the fresh
 *     challenge once; a second one means the token's keyset died, abandon.
 *   - 503: mint unreachable, token NOT consumed; retry same token once after
 *     Retry-After.
 *   - other 402/400: terminal for this attempt; surface the problem slug.
 */

import {
  assertPayable,
  buildCredential,
  decodeRequestObject,
  parsePaymentChallenge,
  problemSlug,
  type PaymentChallenge,
} from "./charge01.ts";
import type { PopWallet } from "@mpp-jams/fetch-with-pop";
import {
  clearPendingPresentation,
  findPendingPresentationByToken,
  reclaimPendingPresentations,
} from "./wallet.ts";
import { SESSION_HEADER } from "../../protocol/protocol.ts";

export interface PayGateResult {
  ok: boolean;
  status: number;
  /** Problem slug (or code) when not ok. */
  reason?: string;
  /** Pops actually spent (0 when the gate was already open / not 402-gated). */
  spent: number;
  /** The Payment-Receipt header on success, when present. */
  receipt?: string;
  /**
   * The parsed JSON body of the SUCCESS response, when present (Phase 1b: a
   * paid play's result (`GachaResult` / `BellPlay` ride here, since the paid
   * request IS the play). Additive read of data the success path already has;
   * the payment logic (challenge/retry/swap) is unchanged.
   */
  body?: unknown;
}

export interface PayGateOptions {
  /** Refuse to pay more than this many pops (HUD-confirmed budget). */
  maxAmount: number;
  /** The mint the wallet holds proofs at (must be in the challenge's set). */
  mintUrl: string;
  /**
   * The `pop_<ts>` unit the wallet holds. Declared to the server (the `unit`
   * query param) so it issues the challenge in THIS unit. The multi-unit
   * accept path: an older-but-still-valid unit is honored instead of being
   * forced onto the newest. Omit to let the server use its newest (mint-into)
   * unit (the fresh-player default).
   */
  unit?: string;
  fetchImpl?: typeof fetch;
}

/** Append `unit=<unit>` to a gate URL's query (multi-unit accept declaration). */
function withUnit(url: string, unit: string | undefined): string {
  if (!unit) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}unit=${encodeURIComponent(unit)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function payGate(
  url: string,
  sessionId: string,
  wallet: PopWallet,
  opts: PayGateOptions,
): Promise<PayGateResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  // Declare the held unit to the server (multi-unit accept). The same URL is
  // used for the bare 402 probe AND the authenticated retry, so the server
  // issues + verifies the challenge in the declared unit consistently.
  const gateUrl = withUnit(url, opts.unit);
  const post = (authorization?: string) =>
    doFetch(gateUrl, {
      method: "POST",
      headers: {
        [SESSION_HEADER]: sessionId,
        ...(authorization ? { authorization } : {}),
      },
    });

  // 1. Bare attempt: mock mode (or an already-open gate) answers 200 outright.
  const first = await post();
  if (first.ok) {
    return { ok: true, status: first.status, spent: 0, body: await bodyOf(first) };
  }
  if (first.status !== 402) {
    return {
      ok: false,
      status: first.status,
      spent: 0,
      reason: await reasonOf(first),
    };
  }

  // 2. Decode + verify the challenge (client MUSTs before paying).
  const challenge = challengeOf(first);
  const requestObject = decodeRequestObject(challenge.request);
  const creqa = await wallet.decodeRequest(requestObject.methodDetails.paymentRequest);
  assertPayable(challenge, requestObject, creqa);
  if (creqa.amount > opts.maxAmount) {
    return {
      ok: false,
      status: 402,
      spent: 0,
      reason: `price ${creqa.amount} exceeds the approved budget ${opts.maxAmount}`,
    };
  }
  if (creqa.mints.length > 0 && !creqa.mints.includes(opts.mintUrl)) {
    return {
      ok: false,
      status: 402,
      spent: 0,
      reason: `challenge accepts mints ${creqa.mints.join(", ")}; wallet holds ${opts.mintUrl}`,
    };
  }

  // 3. Split to EXACTLY the amount (consume-once; remainder stays home). The
  //    wallet stashes the produced token to the pending-presentation store
  //    during this call (F6): it is unspent + recoverable until a verifier
  //    confirms a 200.
  const token = await wallet.payPopRequest(creqa);
  const pending = findPendingPresentationByToken(token);

  // 4. Present; walk the documented retry edges with the SAME token. The token
  //    is consumed at the verifier ONLY on a 200 — clear the pending entry then.
  //    Every OTHER terminal exit (a 400/402, keyset death, a 503 that never
  //    recovers, an exception, a tab-close-equivalent abandonment) leaves the
  //    token unspent, so the `finally` re-imports it into spendable inventory:
  //    the produced value is never stranded (F6).
  let consumed = false;
  try {
    let presentAgainst = challenge;
    let expiredRetries = 0;
    let unreachableRetries = 0;
    for (;;) {
      const resp = await post(buildCredential(presentAgainst, token));
      if (resp.ok) {
        consumed = true; // 200: the verifier redeemed the token.
        return {
          ok: true,
          status: resp.status,
          spent: creqa.amount,
          receipt: resp.headers.get("payment-receipt") ?? undefined,
          body: await bodyOf(resp),
        };
      }
      if (resp.status === 503 && unreachableRetries === 0) {
        // Mint unreachable: token NOT consumed; retry once after Retry-After.
        unreachableRetries = 1;
        const after = Number.parseInt(resp.headers.get("retry-after") ?? "2", 10);
        await sleep(Math.min(after, 5) * 1000);
        continue;
      }
      if (resp.status === 402) {
        const slug = await reasonOf(resp);
        if (slug === "payment-expired" && expiredRetries === 0) {
          // Re-present the same token against the fresh challenge, once. A
          // payment-expired does NOT consume the token, so it stays pending.
          expiredRetries = 1;
          presentAgainst = challengeOf(resp);
          continue;
        }
        return { ok: false, status: 402, spent: creqa.amount, reason: slug };
      }
      return {
        ok: false,
        status: resp.status,
        spent: creqa.amount,
        reason: await reasonOf(resp),
      };
    }
  } finally {
    if (pending) {
      if (consumed) clearPendingPresentation(pending.id);
      else reclaimPendingPresentations(pending.id); // re-import the unspent token
    }
  }
}

function challengeOf(resp: Response): PaymentChallenge {
  const header = resp.headers.get("www-authenticate");
  if (!header) {
    throw new Error("402 without a WWW-Authenticate challenge");
  }
  return parsePaymentChallenge(header);
}

async function reasonOf(resp: Response): Promise<string> {
  try {
    const body = await resp.clone().json();
    return problemSlug(body) ?? `${resp.status}`;
  } catch {
    return `${resp.status}`;
  }
}

/** Parse a success body as JSON, tolerating an empty/non-JSON body. */
async function bodyOf(resp: Response): Promise<unknown> {
  try {
    return await resp.clone().json();
  } catch {
    return undefined;
  }
}
