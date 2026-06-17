/**
 * The PoP wallet seam.
 *
 * The 402 handler needs exactly one capability: given an inner NUT-18 request
 * (`creqA…`), produce a `cashuB…` token worth EXACTLY the requested amount in
 * the requested unit, from a held inventory of unspent pop proofs. How that
 * happens — live cashu-ts swap, a mock, a service-worker bridge — is behind the
 * {@link PopWallet} interface so the protocol core stays browser-free and
 * unit-testable with no live mint.
 */

import type { Proof } from "@cashu/cashu-ts";

/**
 * Description of what the verifier will accept, decoded from the inner NUT-18
 * `creqA…` request by the wallet (cashu-ts owns the decode).
 */
export interface PopRequest {
  /** Exact amount the produced token must be worth. */
  amount: number;
  /** Unit, e.g. `"pop_1782668279"` — NOT `"sat"`. */
  unit: string;
  /** Mints the token must originate from. May be empty if unconstrained. */
  mints: string[];
}

/**
 * The wallet a {@link fetchWithPop} caller supplies.
 *
 * `payPopRequest` is consume-once: it must perform a holder-side NUT-03 swap
 * against the mint to carve out a token of EXACTLY `request.amount`, keep the
 * remainder in inventory, and never hand back proofs it has already spent.
 */
export interface PopWallet {
  /**
   * Decode the inner NUT-18 request so the caller (and a spend guard) can read
   * the amount/unit/mints before paying.
   *
   * @param cashuRequest the `creqA…` string extracted from the 402 challenge.
   */
  decodeRequest(cashuRequest: string): PopRequest | Promise<PopRequest>;
  /**
   * Produce a `cashuB…` token worth exactly the decoded request's amount.
   *
   * Implementations swap against the mint (NUT-03), keep the change, and return
   * the encoded token. Throw if inventory is insufficient or the unit/mint is
   * not held.
   *
   * @param request the decoded request (from {@link decodeRequest}).
   * @returns the encoded `cashuB…` token string.
   */
  payPopRequest(request: PopRequest): Promise<string>;
}

/* ------------------------------------------------------------------------- *
 * cashu-ts-backed implementation                                            *
 * ------------------------------------------------------------------------- */

/**
 * Minimal structural view of the cashu-ts v4 `Wallet` we depend on. Declared
 * here (rather than importing the concrete class) so the core has no hard
 * runtime coupling and tests can pass a stub. The real `@cashu/cashu-ts`
 * `Wallet` satisfies this shape.
 *
 * NOTE on custom units: cashu-ts v4 `Wallet` is constructed as
 * `new Wallet(mint, { unit: "pop_<ts>" })`. The `unit` option is a plain string
 * with no special-casing — it filters the wallet's keychain to the pop keyset
 * during `loadMint()`. `send()` / `getEncodedToken()` operate purely in that
 * unit. (Verified empirically against cashu-ts 4.5.1.)
 */
export interface CashuTsWalletLike {
  /** Mint URL this wallet is bound to (cashu-ts exposes `wallet.mint.mintUrl`). */
  readonly mint: { mintUrl?: string } | { readonly mintUrl?: string };
  /** The unit this wallet is bound to, e.g. `"pop_1782668279"`. */
  readonly unit?: string;
  /**
   * The loaded keychain. Optional so tests can pass a bare stub. The real
   * cashu-ts `Wallet` exposes `wallet.keyChain.getAllKeysetIds()` after
   * `loadMint()`, returning every keyset id in CANONICAL form (a v2 keyset's
   * full 66-hex id, never the 16-hex short form). We read it to expand a
   * proof's short v2 keyset id to the full id cashu-ts's internal fee/keyset
   * lookup is keyed on — see {@link normalizePopProofIds}.
   */
  readonly keyChain?: { getAllKeysetIds(): string[] };
  /** Lazily loads keysets/keys; safe to call repeatedly. */
  loadMint(forceRefresh?: boolean): Promise<void>;
  /**
   * NUT-03 swap: carve `amount` out of `proofs`, returning the exact-amount
   * `send` proofs plus the `keep` remainder.
   */
  send(
    amount: number,
    proofs: Proof[],
    config?: { includeFees?: boolean },
  ): Promise<{ keep: Proof[]; send: Proof[] }>;
}

/** Decode helper signature, matched by cashu-ts `decodePaymentRequest`. */
export type DecodePaymentRequestFn = (encoded: string) => {
  amount?: { toNumber(): number } | number;
  unit?: string;
  mints?: string[];
};

/** Encode helper signature, matched by cashu-ts `getEncodedToken`. */
export type EncodeTokenFn = (token: {
  mint: string;
  proofs: Proof[];
  unit?: string;
}) => string;

/**
 * Inventory + persistence hooks the cashu-ts-backed wallet needs.
 *
 * Inventory is held by the CALLER (the extension's service worker, a CLI store,
 * a test array). The core never decides where pops live — it only asks for the
 * unspent set and reports back the post-swap remainder so the store can be
 * updated atomically (consume-once).
 */
export interface PopInventoryStore {
  /** Return the current unspent proofs for `(mintUrl, unit)`. */
  load(mintUrl: string, unit: string): Proof[] | Promise<Proof[]>;
  /**
   * Atomically replace the inventory for `(mintUrl, unit)` with `keep` after a
   * swap. The `spent` proofs (the token handed out) must never reappear.
   */
  commit(
    mintUrl: string,
    unit: string,
    keep: Proof[],
    spent: Proof[],
  ): void | Promise<void>;
}

/** Dependencies for {@link createCashuPopWallet}. */
export interface CashuPopWalletDeps {
  /**
   * A cashu-ts `Wallet` already bound to the pop unit, e.g.
   * `new Wallet(mint, { unit: "pop_1782668279" })`. The wallet's `unit` MUST
   * match the unit named by the 402's inner request.
   */
  wallet: CashuTsWalletLike;
  /** The held, unspent pop inventory + commit hook. */
  inventory: PopInventoryStore;
  /** cashu-ts `decodePaymentRequest`. Injected to keep the core decoupled. */
  decodePaymentRequest: DecodePaymentRequestFn;
  /** cashu-ts `getEncodedToken`. Injected to keep the core decoupled. */
  getEncodedToken: EncodeTokenFn;
}

const toNumber = (a: { toNumber(): number } | number | undefined): number => {
  if (a === undefined) return NaN;
  return typeof a === "number" ? a : a.toNumber();
};

const mintUrlOf = (wallet: CashuTsWalletLike): string => {
  const url = (wallet.mint as { mintUrl?: string }).mintUrl;
  if (!url) {
    throw new Error(
      "fetch-with-pop: cashu-ts wallet has no resolvable mint.mintUrl",
    );
  }
  return url;
};

/** A v2 *short* keyset id: `01` + 14 hex (8 bytes), per NUT-02. */
const SHORT_V2_KEYSET_ID = /^01[0-9a-f]{14}$/i;

/**
 * Expand v2 *short* keyset ids on `proofs` to the mint's full keyset id.
 *
 * A cdk pop mint issues proofs whose `id` is the 16-hex v2 SHORT keyset id
 * (`01` + 14 hex = the first 8 bytes of the keyset). cashu-ts keys its keychain
 * — and therefore its fee/keyset lookup inside `send()` (`getFeesForProofs` →
 * `keyChain.getKeyset(proof.id)`) — on the FULL 66-hex v2 id returned by
 * `/v1/keysets`. The short id misses, and `send()` throws "Could not get fee.
 * No keyset found for keyset id: <short>".
 *
 * We rewrite each short id to the unique loaded keyset id it prefixes, matching
 * what cashu-ts itself does when decoding a v2-short token (`getDecodedToken`'s
 * internal short→full mapping) — except the wallet's `decodeToken` was never on
 * this swap path, so the proofs reached `send()` still short.
 *
 * MINT-SAFE: the rewrite only touches the textual `id`; `secret`/`C` are
 * untouched, so the blinded-signature verification is unaffected. The cdk mint
 * deserializes a proof `id` of either length (8-byte v1/short OR 33-byte v2) to
 * the same internal keyset `Id` and looks the keyset up by `Id` equality
 * (cashu `nut02::Id::try_from` accepts `STRLEN_V1` or `STRLEN_V2`; the stored
 * keyset's canonical `Id` is the full v2 form). So a swap whose inputs carry the
 * full id resolves to the identical keyset the short id named, and the swap's
 * blinded outputs already carry the full id (cashu-ts binds to the canonical
 * keyset). This is the exact form cashu-ts sends after its own short→full
 * expansion in `receive()`.
 *
 * No-op when the wallet exposes no `keyChain` (test stubs), when an id is not a
 * v2 short id (v1 / already-full / non-hex stub ids pass through), or when the
 * prefix is absent/ambiguous among loaded ids (left as-is so the original
 * cashu-ts error still surfaces rather than a silently wrong rewrite).
 */
const normalizePopProofIds = (
  wallet: CashuTsWalletLike,
  proofs: Proof[],
): Proof[] => {
  const knownIds = wallet.keyChain?.getAllKeysetIds?.();
  if (!knownIds || knownIds.length === 0) return proofs;

  const expand = (id: string): string => {
    if (!SHORT_V2_KEYSET_ID.test(id)) return id;
    const lower = id.toLowerCase();
    const matches = knownIds.filter(
      (k) => k.toLowerCase().startsWith(lower) && k.length > id.length,
    );
    // Unique full id only — an ambiguous or missing prefix is left untouched.
    return matches.length === 1 ? (matches[0] as string) : id;
  };

  let rewrote = false;
  const out = proofs.map((p) => {
    const next = expand(p.id);
    if (next === p.id) return p;
    rewrote = true;
    return { ...p, id: next };
  });
  return rewrote ? out : proofs;
};

/**
 * Build a {@link PopWallet} backed by a cashu-ts v4 `Wallet`.
 *
 * The produced wallet:
 *  1. decodes the inner `creqA…` via cashu-ts `decodePaymentRequest`;
 *  2. validates the request's unit/mint against the bound wallet;
 *  3. loads unspent pop inventory from the store;
 *  4. performs a NUT-03 swap (`wallet.send(amount, proofs)`) to get an
 *     EXACT-amount `send` set + a `keep` remainder;
 *  5. commits `keep` back to inventory (consume-once: the `send` proofs leave);
 *  6. encodes the `send` proofs as a `cashuB…` token via `getEncodedToken`.
 *
 * cashu-ts `send()` swaps online when no exact-amount subset exists, so the
 * returned `send` proofs always sum to exactly `amount`.
 */
export const createCashuPopWallet = (deps: CashuPopWalletDeps): PopWallet => {
  const { wallet, inventory, decodePaymentRequest, getEncodedToken } = deps;

  return {
    decodeRequest(cashuRequest: string): PopRequest {
      const decoded = decodePaymentRequest(cashuRequest);
      const amount = toNumber(decoded.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(
          "fetch-with-pop: NUT-18 request does not name a positive amount",
        );
      }
      if (!decoded.unit) {
        throw new Error("fetch-with-pop: NUT-18 request does not name a unit");
      }
      return {
        amount,
        unit: decoded.unit,
        mints: decoded.mints ?? [],
      };
    },

    async payPopRequest(request: PopRequest): Promise<string> {
      // Guard: the bound wallet must be in the requested unit. A sat wallet
      // cannot satisfy a pop_<ts> request.
      if (wallet.unit && wallet.unit !== request.unit) {
        throw new Error(
          `fetch-with-pop: wallet unit "${wallet.unit}" does not match requested unit "${request.unit}"`,
        );
      }
      const mintUrl = mintUrlOf(wallet);
      // Guard: the mint we hold proofs at must be one the verifier accepts.
      if (request.mints.length > 0 && !request.mints.includes(mintUrl)) {
        throw new Error(
          `fetch-with-pop: held mint "${mintUrl}" is not among the request's accepted mints`,
        );
      }

      await wallet.loadMint();

      const loaded = await inventory.load(mintUrl, request.unit);
      const held = loaded.reduce((sum, p) => sum + toNumber(p.amount), 0);
      if (held < request.amount) {
        throw new Error(
          `fetch-with-pop: insufficient pop inventory (held ${held}, need ${request.amount} ${request.unit})`,
        );
      }

      // Expand v2 short keyset ids to the mint's full id so cashu-ts's internal
      // fee/keyset lookup in send() resolves (loadMint() ran above, so the
      // keychain is populated). Mint-safe: see normalizePopProofIds.
      const proofs = normalizePopProofIds(wallet, loaded);

      // NUT-03 swap: exact-amount `send`, remainder in `keep`.
      const { keep, send } = await wallet.send(request.amount, proofs);

      const produced = send.reduce((sum, p) => sum + toNumber(p.amount), 0);
      if (produced !== request.amount) {
        // Defensive: the verifier rejects over- OR under-amount, so never ship
        // a mismatched token.
        throw new Error(
          `fetch-with-pop: swap produced ${produced} ${request.unit}, expected exactly ${request.amount}`,
        );
      }

      // Consume-once: persist the remainder, drop the spent `send` proofs from
      // inventory BEFORE handing the token out.
      await inventory.commit(mintUrl, request.unit, keep, send);

      return getEncodedToken({ mint: mintUrl, proofs: send, unit: request.unit });
    },
  };
};
