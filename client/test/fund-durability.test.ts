/**
 * Fund-durability harness for the NB browser wallet (audit 2026-06-17, keeper:pops).
 *
 * These tests pin the SAFE invariants the wallet must hold for the user's
 * imported pops. Most are RED today — they reproduce the burn/loss paths from
 * `plans/nb-wallet-fund-audit-20260617.md` (F1, F3, F4, F5, F6). As each fix
 * lands (seed + write-ahead recovery, guarded writes, import dedup, web-locks,
 * pending-present stash) the matching test goes GREEN.
 *
 * No live mint: a `FakeMint` models spend state, and `FakeCashuWallet` models
 * cashu-ts `send()` semantics (selected inputs are spent at the mint, outputs
 * get FRESH random secrets — exactly why a lost output is unrecoverable without
 * a seed). The REAL `createCashuPopWallet` (fetch-with-pop) and the REAL
 * `localInventory` / `addProofs` / `getBalance` (../src/wallet.ts) are under test.
 *
 * Run: `bun test client/test/fund-durability.test.ts`
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCashuPopWallet } from "@mpp-jams/fetch-with-pop";
import type { Proof } from "@cashu/cashu-ts";
import {
  addProofs,
  getBalance,
  InventoryWriteError,
  localInventory,
  pendingPresentationBalance,
  type StoredProof,
} from "../src/wallet.ts";

const MINT = "https://mint.example";
const UNIT = "pop_1781713156";
const INVENTORY_KEY = "bazaar:inventory";
const slot = (m: string, u: string) => `${m}\n${u}`;

/* --------------------------- controllable localStorage -------------------- */

interface FaultStorage extends Storage {
  /** Make the next `setItem` throw a QuotaExceededError (storage full / disabled). */
  __failNextSet(): void;
}

function installFaultStorage(): FaultStorage {
  const store = new Map<string, string>();
  let failNextSet = false;
  const ls: FaultStorage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? (store.get(k) as string) : null),
    key: (i) => [...store.keys()][i] ?? null,
    removeItem: (k) => void store.delete(k),
    setItem: (k, v) => {
      if (failNextSet) {
        failNextSet = false;
        const e = new Error("QuotaExceededError");
        e.name = "QuotaExceededError";
        throw e;
      }
      store.set(k, String(v));
    },
    __failNextSet: () => {
      failNextSet = true;
    },
  };
  (globalThis as { localStorage: Storage }).localStorage = ls;
  return ls;
}

/* ------------------------------- fake mint -------------------------------- */

/** Models the mint's spent-secret set. The wallet marks inputs spent here. */
class FakeMint {
  readonly spent = new Set<string>();
  isSpent(secret: string): boolean {
    return this.spent.has(secret);
  }
}

let outCounter = 0;
const freshSecret = () => `out-${outCounter++}-${Math.round(performance.now())}`;
const proof = (amount: number, secret = freshSecret()): Proof =>
  ({ id: "00ad268c4d1f5826", amount, secret, C: `C-${secret}` }) as unknown as Proof;

/**
 * The recoverable balance = inventory proofs the user can ACTUALLY still spend
 * (secret not already spent at the mint). This is the honest measure of held
 * value; a proof sitting in localStorage whose secret the mint has burned is
 * worth nothing.
 */
function recoverableBalance(mint: FakeMint): number {
  const raw = localStorage.getItem(INVENTORY_KEY);
  if (!raw) return 0;
  const map = JSON.parse(raw) as Record<string, StoredProof[]>;
  const proofs = map[slot(MINT, UNIT)] ?? [];
  return proofs
    .filter((p) => !mint.isSpent(p.secret))
    .reduce((s, p) => s + p.amount, 0);
}

/* ----------------------------- fake cashu wallet -------------------------- */

type SendMode = "ok" | "crashAfterSpend";

/** Structural cashu-ts `Wallet` stub with controllable swap behavior. */
function fakeCashuWallet(mint: FakeMint, mode: SendMode = "ok") {
  return {
    mint: { mintUrl: MINT },
    unit: UNIT,
    // No keyChain → normalizePopProofIds is a no-op (ids pass through).
    async loadMint(): Promise<void> {},
    async send(amount: number, proofs: Proof[]) {
      // The mint rejects any input it has already spent (double-spend guard).
      for (const p of proofs) {
        if (mint.isSpent(p.secret)) {
          throw new Error(`Token already spent: ${p.secret}`);
        }
      }
      // The swap is processed at the mint: inputs are burned NOW...
      for (const p of proofs) mint.spent.add(p.secret);
      // ...modeling a tab-close / OOM / network drop AFTER the mint committed
      // but BEFORE the client received & persisted the outputs.
      if (mode === "crashAfterSpend") {
        throw new Error("connection lost during swap round-trip");
      }
      const total = proofs.reduce((s, p) => s + (p.amount as unknown as number), 0);
      // Outputs carry FRESH random secrets — unrecoverable if lost (no seed).
      const send = [proof(amount)];
      const keep = total - amount > 0 ? [proof(total - amount)] : [];
      return { keep, send };
    },
  };
}

const decodePaymentRequest = (_: string) => ({
  amount: 0,
  unit: UNIT,
  mints: [MINT],
});
const getEncodedToken = (t: { proofs: Proof[] }) => JSON.stringify(t.proofs);

function popWalletWith(mint: FakeMint, mode: SendMode = "ok") {
  return createCashuPopWallet({
    wallet: fakeCashuWallet(mint, mode),
    inventory: localInventory,
    decodePaymentRequest,
    getEncodedToken,
  });
}

/* --------------------------------- setup ---------------------------------- */

beforeEach(() => {
  outCounter = 0;
  installFaultStorage();
});
afterEach(() => {
  localStorage.clear();
});

/* --------------------------------- tests ---------------------------------- */

describe("NB wallet fund durability", () => {
  test("F1: a crash during the swap round-trip must not destroy held value", async () => {
    const mint = new FakeMint();
    addProofs(MINT, UNIT, [proof(64), proof(32), proof(4)]); // 100 held
    expect(getBalance(MINT, UNIT).balance).toBe(100);

    const pop = popWalletWith(mint, "crashAfterSpend");
    await expect(pop.payPopRequest({ amount: 10, unit: UNIT, mints: [MINT] }))
      .rejects.toThrow();

    // SAFE INVARIANT: the user can still spend their 100. RED today — the inputs
    // were burned at the mint and the change has random, unpersisted secrets, so
    // the recoverable balance is 0. Fix = seed + write-ahead restore.
    expect(recoverableBalance(mint)).toBe(100);
  });

  test("F3: a storage write failure after the swap must not silently burn value", async () => {
    const mint = new FakeMint();
    addProofs(MINT, UNIT, [proof(64), proof(32), proof(4)]); // 100 held
    const pop = popWalletWith(mint, "ok");

    // Storage is full: the post-swap commit() will throw (uncaught in wallet.ts).
    (localStorage as FaultStorage).__failNextSet();
    await expect(pop.payPopRequest({ amount: 10, unit: UNIT, mints: [MINT] }))
      .rejects.toThrow();

    // SAFE INVARIANT: a failed inventory write must not lose the swapped value.
    // RED today — inputs are spent, the commit was lost, recoverable is 0.
    expect(recoverableBalance(mint)).toBe(100);
  });

  test("F4: importing the same proof twice must not double-count", () => {
    // importToken delegates to addProofs, which appends unconditionally with no
    // dedup by (id, secret, C). Same harm via the addProofs seam.
    const p = proof(10, "stable-secret-A");
    addProofs(MINT, UNIT, [p]);
    addProofs(MINT, UNIT, [p]); // same proof again

    // SAFE INVARIANT: the balance reflects spendable value, not paste count.
    // RED today — getBalance reports 20; the second copy is a duplicate the mint
    // will reject at spend. Fix = dedup on secret (ideally NUT-07 checkState).
    expect(getBalance(MINT, UNIT).balance).toBe(10);
  });

  test("F5: concurrent inventory writers must not clobber each other (lost update)", () => {
    addProofs(MINT, UNIT, [proof(50, "base")]); // 50 held

    // Two tabs each import a fresh token concurrently (the real concurrent path
    // is addProofs). Before the fix, readMap()/writeMap() was an UNGUARDED
    // read-modify-write over one key: a tab writing back a snapshot it read
    // before the other tab's commit dropped that commit (last writer wins).
    // The fix re-reads + merges by (id, secret, C) on every write (under a Web
    // Lock where available), so two independent appends both survive.
    addProofs(MINT, UNIT, [proof(30, "tabA")]); // tab A imports +30
    addProofs(MINT, UNIT, [proof(20, "tabB")]); // tab B imports +20

    // SAFE INVARIANT: both imports survive (50 + 30 + 20). Belt-and-braces: a
    // re-merge of a STALE snapshot (a writer that still holds the pre-tabA view)
    // must NOT resurrect dropped state or clobber — addProofs reconciles it.
    addProofs(MINT, UNIT, [proof(50, "base")]); // dup of base: a no-op (deduped)
    expect(getBalance(MINT, UNIT).balance).toBe(100);
  });

  test("F5b: commit must not clobber a concurrent import or resurrect a consumed input", () => {
    // The load-bearing F5 mechanism (audit:128): a tab that loads the slot for a
    // swap, then commits, must merge against the LIVE slot rather than overwrite
    // the snapshot it read. Otherwise a second tab's import (landing between this
    // tab's load and its commit) is silently dropped, or a consumed input revived.
    addProofs(MINT, UNIT, [proof(50, "base")]); // 50 held

    // Tab A loads `base` for a swap (records the consume-once input snapshot).
    const loaded = localInventory.load(MINT, UNIT) as Proof[];
    expect(loaded.reduce((s, p) => s + (p.amount as unknown as number), 0)).toBe(50);

    // Tab B imports a fresh token AFTER A's load but BEFORE A's commit.
    addProofs(MINT, UNIT, [proof(30, "tabB")]); // concurrent import, +30

    // Tab A finishes: `base` swapped for 40 change, a 10 token produced.
    localInventory.commit(MINT, UNIT, [proof(40, "changeA")], [proof(10, "tokenA")]);

    // SAFE INVARIANT: Tab B's concurrent import SURVIVES (a blind overwrite would
    // drop it, leaving 40), the consumed `base` is NOT resurrected, and the
    // produced token is stashed pending (recoverable, not stranded).
    const map = JSON.parse(
      localStorage.getItem(INVENTORY_KEY) as string,
    ) as Record<string, StoredProof[]>;
    const secrets = (map[slot(MINT, UNIT)] ?? []).map((p) => p.secret);
    expect(secrets).toContain("tabB"); // concurrent import preserved
    expect(secrets).toContain("changeA"); // own change persisted
    expect(secrets).not.toContain("base"); // consumed input not revived
    expect(getBalance(MINT, UNIT).balance).toBe(70); // 40 change + 30 concurrent
    expect(pendingPresentationBalance(MINT, UNIT)).toBe(10); // token recoverable
  });

  test("F6: a token produced but never presented must remain recoverable", async () => {
    const mint = new FakeMint();
    addProofs(MINT, UNIT, [proof(64), proof(32), proof(4)]); // 100 held
    const pop = popWalletWith(mint, "ok");

    // Swap succeeds and commits: the `send` proofs leave inventory. In payer.ts
    // this token lives only in a local var; a terminal present-failure (or a
    // tab close during the POST) drops it. It is UNSPENT at the verifier, so it
    // is still valid value the user owns.
    const token = await pop.payPopRequest({ amount: 10, unit: UNIT, mints: [MINT] });
    expect(token).toBeTruthy();

    // Simulate the present failing terminally: the token is never redeemed.
    // SAFE INVARIANT: total recoverable value (inventory + the pending-present
    // stash) is still 100. The fix persists the produced token to a pending
    // store at commit (before presenting); the payer re-imports it on any
    // terminal non-200 and clears it only on a confirmed 200. So the 10 sits in
    // the pending store, fully recoverable, never stranded.
    const pendingStash = pendingPresentationBalance(MINT, UNIT);
    expect(pendingStash).toBe(10); // the produced-but-unpresented token
    expect(recoverableBalance(mint) + pendingStash).toBe(100);
  });

  test("F2: a commit write-failure on the spend path surfaces loudly and stashes the value", async () => {
    const mint = new FakeMint();
    addProofs(MINT, UNIT, [proof(64), proof(32), proof(4)]); // 100 held
    const pop = popWalletWith(mint, "ok");

    // The swap succeeds at the mint (inputs spent, outputs produced), but the
    // post-swap inventory write throws (storage full). The fix must NOT return as
    // if the spend succeeded: it raises a loud, typed error carrying the
    // recoverable proofs AND stashes keep+send so the value is not silently lost.
    (localStorage as FaultStorage).__failNextSet();
    const err = await pop
      .payPopRequest({ amount: 10, unit: UNIT, mints: [MINT] })
      .then(() => null)
      .catch((e) => e);

    expect(err).toBeInstanceOf(InventoryWriteError);
    const iwe = err as InventoryWriteError;
    // The change (90) + the produced token (10) are carried for recovery.
    expect(iwe.keep.reduce((s, p) => s + p.amount, 0)).toBe(90);
    expect(iwe.send.reduce((s, p) => s + p.amount, 0)).toBe(10);
    // SAFE INVARIANT: the value is stashed recoverably, not dropped. (The
    // localStorage inventory still shows a burn — recovering THAT needs the seed,
    // which is Phase 2 / F1 / F3 — but the pending stash makes the produced value
    // recoverable now, and the loud error stops a silent success.)
    expect(pendingPresentationBalance(MINT, UNIT)).toBe(100);
  });
});
