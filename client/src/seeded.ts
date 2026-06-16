/**
 * Tiny deterministic RNG (pure, DOM-free — unit-tested). Everything
 * procedural in the bazaar (alien bodies, sign glyphs, stall palettes)
 * derives from string seeds through this, so a session id always grows the
 * same alien on every client.
 */

/** FNV-1a 32-bit string hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small fast seeded PRNG, returns a () => [0,1) function. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded RNG straight from a string. */
export function rngFrom(seed: string): () => number {
  return mulberry32(hashString(seed));
}

/** Pick one element (seeded). */
export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length]!;
}

/** Integer in [min, max] inclusive (seeded). */
export function rint(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Float in [min, max) (seeded). */
export function rfloat(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}
