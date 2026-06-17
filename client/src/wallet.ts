/**
 * The browser pop wallet: a localStorage inventory + a cashu-ts-backed payer.
 *
 * The cashu-ts machinery (exact-amount NUT-03 swap via `Wallet.send`, the
 * v2-short-keyset `normalizePopProofIds` fix) is REUSED from
 * `@mpp-jams/fetch-with-pop`'s `createCashuPopWallet`, keeping the parts
 * the contract needs alive. (Its old flat 402 envelope is dead and
 * not imported; the wire lives in `charge01.ts`.)
 *
 * Storage patterns (denormalized number amounts, consume-once commit,
 * tolerant cashuB decode incl. the cdk short-keyset-id workaround) are ported
 * from the proven iframe-wallet (`iframe-wallet/src/wallet/{storage,wallet}.ts`).
 *
 * Mint URL + unit are RUNTIME values (from the server's /api/config, which
 * read them from the mint's /v1/keysets), never compiled in.
 */

import {
  Wallet,
  Mint,
  CheckStateEnum,
  decodePaymentRequest,
  getEncodedToken,
  getDecodedToken,
  type Proof,
} from "@cashu/cashu-ts";
import {
  createCashuPopWallet,
  type PopInventoryStore,
  type PopWallet,
} from "@mpp-jams/fetch-with-pop";

/** Stored proof: plain-number `amount` (cashu-ts `Amount` does not survive JSON). */
export interface StoredProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  [k: string]: unknown;
}

const INVENTORY_KEY = "bazaar:inventory";
/**
 * Pending-presentation store (F6): tokens that were PRODUCED by a swap (the
 * inputs are spent at the mint, fresh outputs minted) but not yet confirmed
 * consumed by a verifier (no 200). The proofs are unspent + fully recoverable;
 * we hold the encoded cashuB so a terminal present-failure or a restart can
 * re-import it. Cleared ONLY on a confirmed 200.
 */
const PENDING_KEY = "bazaar:pending-presentation";

type InventoryMap = Record<string, StoredProof[]>;

/** A produced-but-unpresented token, keyed by a generated id. */
export interface PendingPresentation {
  id: string;
  mintUrl: string;
  unit: string;
  /** The encoded cashuB token (the recoverable artifact). */
  token: string;
  /** The raw send proofs, so recovery needs no decode. */
  proofs: StoredProof[];
  /** Sum of `proofs` amounts (the value at risk). */
  amount: number;
  createdAt: number;
}

/**
 * Raised when a localStorage write FAILS on the spend path after the mint has
 * already swapped (F2). The change/token proofs are spent-or-produced at the
 * mint but could not be persisted: a value-at-risk event. Carries the proofs +
 * an encoded cashuB so the caller can surface a loud, recoverable error rather
 * than returning as if the pay succeeded.
 */
export class InventoryWriteError extends Error {
  readonly keep: StoredProof[];
  readonly send: StoredProof[];
  /** A cashuB encoding of `send` (the produced token) for immediate re-export. */
  readonly recoveryToken: string | null;
  constructor(message: string, opts: {
    keep: StoredProof[];
    send: StoredProof[];
    recoveryToken: string | null;
    cause?: unknown;
  }) {
    super(message);
    this.name = "InventoryWriteError";
    this.keep = opts.keep;
    this.send = opts.send;
    this.recoveryToken = opts.recoveryToken;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

const slot = (mintUrl: string, unit: string): string => `${mintUrl}\n${unit}`;

/** Stable identity of a proof for dedup/merge: keyset id + secret + signature. */
const proofKey = (p: { id: string; secret: string; C: string }): string =>
  `${p.id}\u0000${p.secret}\u0000${p.C}`;

const readRaw = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const readMap = (): InventoryMap => {
  const raw = readRaw(INVENTORY_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as InventoryMap;
  } catch {
    return {};
  }
};

/**
 * Write the inventory map. Guards `setItem` (F2): a `QuotaExceededError` /
 * Safari-private / disabled-storage throw is re-raised so callers on the spend
 * path treat it as value-at-risk rather than a silent burn. Never swallows.
 */
const writeMap = (map: InventoryMap): void => {
  localStorage.setItem(INVENTORY_KEY, JSON.stringify(map));
};

const amountToNumber = (a: number | { toNumber(): number }): number =>
  typeof a === "number" ? a : a.toNumber();

const denormalize = (proofs: Proof[]): StoredProof[] =>
  proofs.map((p) => ({
    ...(p as unknown as Record<string, unknown>),
    id: p.id,
    secret: p.secret,
    C: p.C,
    amount: amountToNumber(p.amount as unknown as number | { toNumber(): number }),
  }));

/**
 * Union `incoming` into `existing`, deduped by (id, secret, C) (F4). Existing
 * entries win (a re-paste of an already-held proof is a no-op, never a 2x).
 */
const mergeProofs = (
  existing: StoredProof[],
  incoming: StoredProof[],
): StoredProof[] => {
  const seen = new Set(existing.map(proofKey));
  const out = [...existing];
  for (const p of incoming) {
    const k = proofKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
};

/* --------------------------- cross-tab safety ------------------------------ */

/**
 * Run `fn` holding the inventory lock so a concurrent tab cannot interleave its
 * own load->swap->commit (F5). Uses the Web Locks API where available; degrades
 * to running `fn` directly otherwise (older browsers / non-DOM test env). The
 * re-read-and-merge in every mutator is the correctness floor under either mode
 * — the lock only narrows the window for a lost in-flight read.
 */
export const withInventoryLock = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks?.request) {
    return locks.request("bazaar:inventory", async () => fn()) as Promise<T>;
  }
  return fn();
};

let storageListenerInstalled = false;
/**
 * Notify when another tab mutates the shared inventory/pending keys (F5), so a
 * stale in-memory balance (e.g. the HUD) can be invalidated. Idempotent.
 */
export const onInventoryChanged = (cb: () => void): void => {
  if (storageListenerInstalled || typeof globalThis.addEventListener !== "function") {
    return;
  }
  storageListenerInstalled = true;
  globalThis.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === INVENTORY_KEY || e.key === PENDING_KEY || e.key === null) cb();
  });
};

/* ----------------------------- inventory ----------------------------------- */

/**
 * The proof set the LAST `load(slot)` returned — the swap's input set. `commit`
 * treats exactly these as consumed and re-reads the live slot to preserve any
 * proofs a concurrent tab added in between (F5). Cleared on commit (consume-once).
 */
const loadSnapshots = new Map<string, Set<string>>();

/** The consume-once inventory the cashu pop wallet swaps against. */
export const localInventory: PopInventoryStore = {
  load(mintUrl: string, unit: string): Proof[] {
    const proofs = (readMap()[slot(mintUrl, unit)] ?? []) as unknown as Proof[];
    // Remember exactly what we handed the swap, so commit consumes only these
    // and not a proof a concurrent tab imported after this load (F5).
    loadSnapshots.set(
      slot(mintUrl, unit),
      new Set((proofs as unknown as StoredProof[]).map(proofKey)),
    );
    return proofs;
  },
  /**
   * Persist a post-swap result with consume-once semantics, made concurrency-safe
   * (F5): re-read the LIVE slot and rebuild it as `keep` UNION any proofs that
   * were NOT part of this swap's loaded input set (a concurrent tab's import),
   * rather than blindly overwriting a stale snapshot. With no load snapshot
   * (commit called directly) it falls back to the original replace-with-keep.
   *
   * The `spent` (produced token) proofs are stashed to the pending store (F6):
   * unspent at the mint and recoverable until a verifier confirms a 200. The
   * caller (payer) clears the pending entry on 200 and re-imports on any terminal
   * non-200.
   *
   * On a write failure after the swap (F2) this throws {@link InventoryWriteError}
   * carrying the keep+send proofs so the caller surfaces a loud, recoverable
   * error instead of returning as if it succeeded.
   */
  commit(mintUrl: string, unit: string, keep: Proof[], spent: Proof[]): void {
    const keepD = denormalize(keep);
    const spentD = denormalize(spent);
    const key = slot(mintUrl, unit);

    // 1. Consume-once inventory update under a fresh re-read + merge (F5): the
    //    consumed set is exactly what this swap loaded; any proof now in the slot
    //    that was NOT loaded was added concurrently and must survive. A throw
    //    here means the mint already swapped but the change never persisted (F2).
    const consumed = loadSnapshots.get(key);
    try {
      const map = readMap();
      const current = map[key] ?? [];
      // survivors = proofs added since load (concurrent import). With no snapshot
      // every current proof is treated as consumed (original replace semantics).
      const survivors = consumed
        ? current.filter((p) => !consumed.has(proofKey(p)))
        : [];
      map[key] = mergeProofs(keepD, survivors);
      writeMap(map);
      loadSnapshots.delete(key);
    } catch (err) {
      // Value-at-risk (F2): inputs are spent, outputs produced, change unsaved.
      // Stash BOTH keep + send recoverably (the inventory write did NOT land, so
      // the change is at risk too), then surface a hard, loud error carrying the
      // proofs + an export-ready cashuB. NEVER return as if the spend succeeded.
      const recoveryToken = encodeTokenSafe(mintUrl, unit, [...keepD, ...spentD]);
      try {
        stashPendingPresentation(mintUrl, unit, [...keepD, ...spentD]);
      } catch {
        /* in-memory recovery via the thrown error below is the last resort */
      }
      throw new InventoryWriteError(
        `inventory write failed after swap — ${keepD.reduce((s, p) => s + p.amount, 0)} ${unit} change + ` +
          `${spentD.reduce((s, p) => s + p.amount, 0)} ${unit} token are at risk; export them now`,
        { keep: keepD, send: spentD, recoveryToken, cause: err },
      );
    }

    // 2. Stash the produced token to the pending-presentation store (F6): it is
    //    unspent + recoverable until a verifier confirms a 200. The payer clears
    //    it on 200 and re-imports it on any terminal non-200. A failure HERE
    //    (the token has no durable home) is also value-at-risk: surface it.
    if (spentD.length > 0) {
      try {
        stashPendingPresentation(mintUrl, unit, spentD);
      } catch (err) {
        const recoveryToken = encodeTokenSafe(mintUrl, unit, spentD);
        throw new InventoryWriteError(
          `produced token could not be stashed — ${spentD.reduce((s, p) => s + p.amount, 0)} ${unit} ` +
            `is at risk; export it now`,
          { keep: keepD, send: spentD, recoveryToken, cause: err },
        );
      }
    }
  },
};

/** Encode proofs as a cashuB for recovery, tolerating an encoder throw. */
const encodeTokenSafe = (
  mintUrl: string,
  unit: string,
  proofs: StoredProof[],
): string | null => {
  try {
    return getEncodedToken({ mint: mintUrl, proofs: proofs as unknown as Proof[], unit });
  } catch {
    return null;
  }
};

export const getBalance = (
  mintUrl: string,
  unit: string,
): { balance: number; proofCount: number } => {
  const proofs = readMap()[slot(mintUrl, unit)] ?? [];
  return {
    balance: proofs.reduce((sum, p) => sum + p.amount, 0),
    proofCount: proofs.length,
  };
};

/**
 * Append proofs to the (mint, unit) slot, deduped by (id, secret, C) (F4), under
 * a fresh re-read so a concurrent writer is merged not clobbered (F5). A
 * write failure throws (F2) — import is recoverable (the cashuB still exists) so
 * the caller surfaces an error rather than failing silent.
 */
export const addProofs = (
  mintUrl: string,
  unit: string,
  proofs: Proof[],
): void => {
  const map = readMap();
  const key = slot(mintUrl, unit);
  map[key] = mergeProofs(map[key] ?? [], denormalize(proofs));
  writeMap(map);
};

/* ----------------------- pending-presentation store ------------------------ */

const readPending = (): PendingPresentation[] => {
  const raw = readRaw(PENDING_KEY);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as PendingPresentation[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const writePending = (list: PendingPresentation[]): void => {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list));
};

let pendingCounter = 0;
const newPendingId = (): string =>
  `pp_${Date.now().toString(36)}_${(pendingCounter++).toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

/**
 * Stash a produced token to the pending-presentation store (F6) and return its
 * id. Stores both the raw proofs and an encoded cashuB so recovery never needs
 * a decode. Deduped by token string (re-stashing the same token is idempotent).
 */
export const stashPendingPresentation = (
  mintUrl: string,
  unit: string,
  proofs: StoredProof[],
): string => {
  let token: string;
  try {
    token = getEncodedToken({ mint: mintUrl, proofs: proofs as unknown as Proof[], unit });
  } catch {
    // Fall back to a structural encoding the recovery path can still re-import
    // via raw proofs; the token string is informational then.
    token = "";
  }
  const list = readPending();
  const existing = token ? list.find((e) => e.token === token && token !== "") : undefined;
  if (existing) return existing.id;
  const entry: PendingPresentation = {
    id: newPendingId(),
    mintUrl,
    unit,
    token,
    proofs,
    amount: proofs.reduce((s, p) => s + p.amount, 0),
    createdAt: Date.now(),
  };
  writePending([...list, entry]);
  return entry.id;
};

/** Total value sitting in the pending-presentation store (recoverable, F6). */
export const pendingPresentationBalance = (mintUrl?: string, unit?: string): number =>
  readPending()
    .filter((e) => (mintUrl ? e.mintUrl === mintUrl : true) && (unit ? e.unit === unit : true))
    .reduce((s, e) => s + e.amount, 0);

/** All currently-stranded pending tokens. */
export const listPendingPresentations = (): PendingPresentation[] => readPending();

/**
 * Find the pending entry for a produced token (the payer's handle). Matches on
 * the exact token string first (the live fast path, where the payer and the
 * stash share cashu-ts's encoder), then falls back to decoding the token and
 * matching by proof secret-set — so the correlation does not depend on byte-for-
 * byte encoder agreement.
 */
export const findPendingPresentationByToken = (
  token: string,
): PendingPresentation | undefined => {
  if (!token) return undefined;
  const list = readPending();
  const exact = list.find((e) => e.token !== "" && e.token === token);
  if (exact) return exact;
  // Fall back to secret-set equality against the token's proofs.
  let secrets: Set<string>;
  try {
    const decoded = decodeTokenTolerant(token);
    secrets = new Set((decoded.proofs ?? []).map((p) => p.secret));
  } catch {
    return undefined;
  }
  if (secrets.size === 0) return undefined;
  return list.find(
    (e) =>
      e.proofs.length === secrets.size &&
      e.proofs.every((p) => secrets.has(p.secret)),
  );
};

/**
 * Clear a pending entry — call ONLY after a confirmed 200 (the verifier redeemed
 * the token, so it is truly consumed). A `payment-expired` re-present does NOT
 * consume it, so do not clear on that path.
 */
export const clearPendingPresentation = (id: string): void => {
  const list = readPending();
  const next = list.filter((e) => e.id !== id);
  if (next.length !== list.length) writePending(next);
};

/**
 * Re-import every stranded pending token back into spendable inventory (F6):
 * called on a terminal non-200 present outcome and on startup. The proofs are
 * unspent at the mint, so this restores real value. Each reclaimed entry is
 * cleared from the pending store after its proofs are merged into inventory.
 * Returns the total value reclaimed.
 *
 * Optionally restrict to a single `id` (the just-failed present).
 */
export const reclaimPendingPresentations = (only?: string): number => {
  const list = readPending();
  let reclaimed = 0;
  const keep: PendingPresentation[] = [];
  for (const e of list) {
    if (only && e.id !== only) {
      keep.push(e);
      continue;
    }
    try {
      addProofs(e.mintUrl, e.unit, e.proofs as unknown as Proof[]);
      reclaimed += e.amount;
    } catch {
      // Could not re-import (storage failure): keep it pending so a later
      // startup retries rather than dropping the value.
      keep.push(e);
    }
  }
  if (keep.length !== list.length) writePending(keep);
  return reclaimed;
};

/* --------------- tolerant cashuB decode (cdk short keyset ids) ------------ */

/**
 * Pull keyset-id bytestrings (`t[].i`) out of a cashuB token's CBOR: a
 * minimal walk, no CBOR library. Ported from the proven iframe-wallet (which
 * ported it from the extension SW). Needed because cashu-ts
 * `getDecodedToken` throws on a cdk pop token carrying a v2 SHORT keyset id
 * unless seeded with keysetIds to expand against; the token's own ids
 * self-map.
 */
export const keysetIdsFromCashuB = (token: string): string[] => {
  const b64 = token
    .slice("cashuB".length)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const ids = new Set<string>();
  const td = new TextDecoder();
  let p = 0;
  let lastKey: string | null = null;

  const readLen = (ai: number): number => {
    if (ai < 24) return ai;
    if (ai === 24) return bytes[p++] as number;
    if (ai === 25) {
      const v = ((bytes[p] as number) << 8) | (bytes[p + 1] as number);
      p += 2;
      return v;
    }
    if (ai === 26) {
      const v =
        (((bytes[p] as number) << 24) |
          ((bytes[p + 1] as number) << 16) |
          ((bytes[p + 2] as number) << 8) |
          (bytes[p + 3] as number)) >>>
        0;
      p += 4;
      return v;
    }
    throw new Error("unsupported CBOR length");
  };

  const walk = (): void => {
    const ib = bytes[p++] as number;
    const major = ib >> 5;
    const ai = ib & 0x1f;
    switch (major) {
      case 0:
      case 1:
        readLen(ai);
        return;
      case 2: {
        const n = readLen(ai);
        const slice = bytes.subarray(p, p + n);
        p += n;
        if (lastKey === "i") {
          ids.add([...slice].map((b) => b.toString(16).padStart(2, "0")).join(""));
        }
        return;
      }
      case 3: {
        const n = readLen(ai);
        lastKey = td.decode(bytes.subarray(p, p + n));
        p += n;
        return;
      }
      case 4: {
        const n = readLen(ai);
        for (let k = 0; k < n; k++) walk();
        return;
      }
      case 5: {
        const n = readLen(ai);
        for (let k = 0; k < n; k++) {
          walk();
          walk();
          lastKey = null;
        }
        return;
      }
      default:
        throw new Error(`unsupported CBOR major type ${major}`);
    }
  };

  walk();
  return [...ids];
};

/** Decode a cashuB token, tolerating a v2 short keyset id (see above). */
export const decodeTokenTolerant = (
  token: string,
): ReturnType<typeof getDecodedToken> => {
  try {
    return getDecodedToken(token, []);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/short keyset id/i.test(msg)) throw err;
    return getDecodedToken(token, keysetIdsFromCashuB(token));
  }
};

/** Decode + validate a pasted cashuB's shape (unit match, non-empty). */
const decodeForImport = (
  token: string,
  unit: string,
): StoredProof[] => {
  const decoded = decodeTokenTolerant(token.trim());
  if (decoded.unit && decoded.unit !== unit) {
    throw new Error(
      `token unit "${decoded.unit}" does not match the active unit "${unit}"`,
    );
  }
  if (!decoded.proofs?.length) {
    throw new Error("token carries no proofs");
  }
  return denormalize(decoded.proofs);
};

/** Proofs in `proofs` already held in the (mint, unit) slot, by (id, secret, C). */
const duplicatesInInventory = (
  mintUrl: string,
  unit: string,
  proofs: StoredProof[],
): StoredProof[] => {
  const held = new Set((readMap()[slot(mintUrl, unit)] ?? []).map(proofKey));
  return proofs.filter((p) => held.has(proofKey(p)));
};

/**
 * Import a pasted cashuB into this origin's inventory (F4). Rejects an exact
 * re-paste (every proof already held by (id, secret, C)) with a clear message
 * instead of double-counting. Does NOT hit the network — for spent/duplicate
 * detection against the mint, use {@link importTokenChecked}. `addProofs` itself
 * dedups, so a partial overlap merges to the union (no inflation).
 *
 * The wallet's (mintUrl, unit) slot is authoritative; the embedded mint URL is a
 * hint, the unit must match the active one or the verifier would reject it.
 */
export const importToken = (
  token: string,
  mintUrl: string,
  unit: string,
): { added: number } => {
  const proofs = decodeForImport(token, unit);
  const dupes = duplicatesInInventory(mintUrl, unit, proofs);
  if (dupes.length === proofs.length) {
    throw new Error(
      "this token is already in your wallet (duplicate import ignored)",
    );
  }
  // addProofs merges by (id, secret, C): only the not-yet-held proofs are added,
  // so a partial overlap never inflates the balance.
  addProofs(mintUrl, unit, proofs as unknown as Proof[]);
  const added = proofs
    .filter((p) => !dupes.some((d) => proofKey(d) === proofKey(p)))
    .reduce((sum, p) => sum + p.amount, 0);
  return { added };
};

/** Checks proof spent/unspent state at the mint (NUT-07). */
export type ProofStateChecker = (
  proofs: StoredProof[],
) => Promise<{ unspent: StoredProof[]; spent: StoredProof[]; pending: StoredProof[] }>;

/**
 * Import with a NUT-07 mint state-check (F4, folds F7): decode, reject exact
 * duplicates, then ask the mint which proofs are actually UNSPENT and add only
 * those — a spent or pending token is rejected with a clear message rather than
 * silently inflating the balance off its embedded amounts. Falls back to the
 * offline dedup-only path if the state-check itself fails (mint unreachable):
 * better to import unchecked (recoverable) than to drop a valid token.
 */
export const importTokenChecked = async (
  token: string,
  mintUrl: string,
  unit: string,
  check: ProofStateChecker,
): Promise<{ added: number; rejected: number; checked: boolean }> => {
  const proofs = decodeForImport(token, unit);
  const dupes = duplicatesInInventory(mintUrl, unit, proofs);
  if (dupes.length === proofs.length) {
    throw new Error(
      "this token is already in your wallet (duplicate import ignored)",
    );
  }
  const fresh = proofs.filter(
    (p) => !dupes.some((d) => proofKey(d) === proofKey(p)),
  );

  let toAdd = fresh;
  let rejected = 0;
  let checked = false;
  try {
    const { unspent, spent, pending } = await check(fresh);
    checked = true;
    rejected = spent.length + pending.length;
    if (unspent.length === 0) {
      throw new Error(
        rejected > 0
          ? "this token has already been spent — nothing to import"
          : "the mint reports no spendable proofs in this token",
      );
    }
    toAdd = unspent;
  } catch (err) {
    // A thrown "already spent" is terminal; a network/availability failure is
    // not — fall back to the offline path so a valid token still imports.
    if (err instanceof Error && /already been spent|no spendable proofs/.test(err.message)) {
      throw err;
    }
    toAdd = fresh;
    checked = false;
  }

  addProofs(mintUrl, unit, toAdd as unknown as Proof[]);
  return {
    added: toAdd.reduce((sum, p) => sum + p.amount, 0),
    rejected,
    checked,
  };
};

/**
 * A {@link ProofStateChecker} backed by a cashu-ts `Wallet.checkProofsStates`
 * (NUT-07). Used by the live app to validate imports against the mint.
 */
export const buildProofStateChecker = (
  mintUrl: string,
  unit: string,
): ProofStateChecker => {
  const wallet = new Wallet(new Mint(mintUrl), { unit });
  return async (proofs: StoredProof[]) => {
    await wallet.loadMint();
    const states = await wallet.checkProofsStates(
      proofs.map((p) => ({ secret: p.secret, id: p.id })),
    );
    const unspent: StoredProof[] = [];
    const spent: StoredProof[] = [];
    const pending: StoredProof[] = [];
    proofs.forEach((p, i) => {
      const state = states[i]?.state;
      if (state === CheckStateEnum.SPENT) spent.push(p);
      else if (state === CheckStateEnum.PENDING) pending.push(p);
      else unspent.push(p);
    });
    return { unspent, spent, pending };
  };
};

/**
 * Build the PopWallet (exact-amount splitter): decodes creqA, swaps to
 * EXACTLY the requested amount against the mint (overpay would be RETAINED
 * by the verifier, never present more), commits the remainder.
 *
 * The produced wallet wraps `payPopRequest` in the inventory Web Lock (F5) so a
 * concurrent tab cannot interleave its own load->swap->commit.
 */
export const buildPopWallet = (mintUrl: string, unit: string): PopWallet => {
  const wallet = new Wallet(new Mint(mintUrl), { unit });
  const core = createCashuPopWallet({
    wallet,
    inventory: localInventory,
    decodePaymentRequest,
    getEncodedToken,
  });
  return {
    decodeRequest: (req) => core.decodeRequest(req),
    // Serialize the whole load->swap->commit critical section against other tabs.
    payPopRequest: (request) => withInventoryLock(() => core.payPopRequest(request)),
  };
};
