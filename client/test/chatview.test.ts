/**
 * Chat bubble math: wrapping and the distance/time fade ("proximity chat").
 */

import { describe, expect, test } from "bun:test";
import {
  BUBBLE_FADE_MS,
  BUBBLE_FAR,
  BUBBLE_LIFE_MS,
  BUBBLE_NEAR,
  bubbleOpacity,
  wrapBubble,
} from "../src/chatview.ts";

describe("wrapBubble", () => {
  test("short text is one line, untouched", () => {
    expect(wrapBubble("fresh skewers!")).toEqual(["fresh skewers!"]);
  });

  test("wraps on word boundaries at the width", () => {
    const lines = wrapBubble("two pops a bowl best deal on the street", 12);
    expect(lines.length).toBeLessThanOrEqual(3);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(12);
  });

  test("hard-splits a single huge word", () => {
    const lines = wrapBubble("x".repeat(60), 24);
    expect(lines[0]!.length).toBe(24);
  });

  test("clips to max lines with ellipsis", () => {
    const text = Array(40).fill("word").join(" ");
    const lines = wrapBubble(text, 24, 3);
    expect(lines.length).toBe(3);
    expect(lines[2]!.endsWith("…")).toBe(true);
  });

  test("never returns empty array", () => {
    expect(wrapBubble("").length).toBe(1);
  });
});

describe("bubbleOpacity", () => {
  test("fresh and near = fully opaque", () => {
    expect(bubbleOpacity(0, 0)).toBe(1);
    expect(bubbleOpacity(1000, BUBBLE_NEAR - 1)).toBe(1);
  });

  test("dead bubbles are invisible", () => {
    expect(bubbleOpacity(BUBBLE_LIFE_MS, 0)).toBe(0);
    expect(bubbleOpacity(BUBBLE_LIFE_MS + 50, 0)).toBe(0);
    expect(bubbleOpacity(-5, 0)).toBe(0);
  });

  test("age fades the tail", () => {
    const midFade = bubbleOpacity(BUBBLE_LIFE_MS - BUBBLE_FADE_MS / 2, 0);
    expect(midFade).toBeGreaterThan(0.4);
    expect(midFade).toBeLessThan(0.6);
  });

  test("distance fades to zero at the far edge (proximity chat)", () => {
    expect(bubbleOpacity(0, BUBBLE_FAR)).toBe(0);
    expect(bubbleOpacity(0, BUBBLE_FAR + 10)).toBe(0);
    const mid = bubbleOpacity(0, (BUBBLE_NEAR + BUBBLE_FAR) / 2);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });

  test("age and distance multiply", () => {
    const both = bubbleOpacity(
      BUBBLE_LIFE_MS - BUBBLE_FADE_MS / 2,
      (BUBBLE_NEAR + BUBBLE_FAR) / 2,
    );
    expect(both).toBeGreaterThan(0.2);
    expect(both).toBeLessThan(0.3);
  });
});
