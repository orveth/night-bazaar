/**
 * The procedural alien generator must be deterministic (same session id =
 * same alien on every client) and actually varied across ids.
 */

import { describe, expect, test } from "bun:test";
import { alienParamsFromSeed } from "../src/alienparams.ts";
import { hashString, mulberry32, rngFrom } from "../src/seeded.ts";

describe("seeded rng", () => {
  test("hashString is stable and spread", () => {
    expect(hashString("a3f0c2d14b8e4f6a")).toBe(hashString("a3f0c2d14b8e4f6a"));
    expect(hashString("a")).not.toBe(hashString("b"));
  });

  test("mulberry32 reproduces sequences", () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    for (let i = 0; i < 16; i++) expect(a()).toBe(b());
  });

  test("values stay in [0,1)", () => {
    const rng = rngFrom("bounds");
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("alienParamsFromSeed", () => {
  test("deterministic per seed", () => {
    const a = alienParamsFromSeed("session-abc123");
    const b = alienParamsFromSeed("session-abc123");
    expect(a).toEqual(b);
  });

  test("params stay inside their designed ranges", () => {
    for (let i = 0; i < 200; i++) {
      const p = alienParamsFromSeed(`seed-${i}`);
      expect(p.hue).toBeGreaterThanOrEqual(0);
      expect(p.hue).toBeLessThan(1);
      expect(p.accentHue).toBeGreaterThanOrEqual(0);
      expect(p.accentHue).toBeLessThan(1);
      expect([0, 1, 2]).toContain(p.shape);
      expect(p.eyes).toBeGreaterThanOrEqual(1);
      expect(p.eyes).toBeLessThanOrEqual(3);
      expect(p.antennae).toBeGreaterThanOrEqual(0);
      expect(p.antennae).toBeLessThanOrEqual(3);
      expect(p.height).toBeGreaterThan(0.5);
      expect(p.height).toBeLessThan(1.5);
      expect(p.width).toBeGreaterThan(0.5);
      expect(p.width).toBeLessThan(1.5);
    }
  });

  test("a crowd of sessions is actually varied", () => {
    const shapes = new Set<number>();
    const eyes = new Set<number>();
    const hues = new Set<number>();
    for (let i = 0; i < 64; i++) {
      const p = alienParamsFromSeed(`session-${i}-${i * 7}`);
      shapes.add(p.shape);
      eyes.add(p.eyes);
      hues.add(Math.round(p.hue * 12));
    }
    expect(shapes.size).toBe(3);
    expect(eyes.size).toBe(3);
    expect(hues.size).toBeGreaterThan(6);
  });
});
