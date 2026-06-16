/**
 * Chat bubble presentation math: pure + DOM-free so bun can unit-test it.
 * The sprite plumbing lives in world3d.ts; these functions decide wrapping
 * and how a bubble fades with age and distance.
 */

/** Bubble lifetime, ms. */
export const BUBBLE_LIFE_MS = 7000;
/** Fade-out tail, ms (the last part of the life). */
export const BUBBLE_FADE_MS = 1600;
/** Full opacity inside this distance (world units)… */
export const BUBBLE_NEAR = 12;
/** …fades to zero at this distance ("proximity" chat). */
export const BUBBLE_FAR = 26;
/** Wrap width, characters. */
export const BUBBLE_WRAP = 24;
/** Max lines before ellipsis. */
export const BUBBLE_MAX_LINES = 3;

/** Word-wrap into at most maxLines lines of ~width chars (ellipsis beyond). */
export function wrapBubble(
  text: string,
  width: number = BUBBLE_WRAP,
  maxLines: number = BUBBLE_MAX_LINES,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // Hard-split words longer than the width.
    let rest = word;
    while (rest.length > width) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    line = rest;
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length > maxLines || (lines.length === maxLines && line && !lines.includes(line))) {
    lines.length = maxLines;
  }
  // Ellipsis when content was cut.
  const joined = lines.join(" ");
  const original = words.join(" ");
  if (joined.length < original.length && lines.length > 0) {
    const last = lines[lines.length - 1]!;
    lines[lines.length - 1] = `${last.slice(0, Math.max(0, width - 1))}…`;
  }
  return lines.length ? lines : [""];
}

/**
 * Bubble opacity in [0,1] from age and distance to the viewer's avatar.
 * Age fades the tail; distance fades linearly NEAR..FAR (proximity chat:
 * far speech reads as unintelligible market murmur, which the ambience
 * track supplies).
 */
export function bubbleOpacity(
  ageMs: number,
  dist: number,
  lifeMs: number = BUBBLE_LIFE_MS,
  fadeMs: number = BUBBLE_FADE_MS,
  near: number = BUBBLE_NEAR,
  far: number = BUBBLE_FAR,
): number {
  if (ageMs < 0 || ageMs >= lifeMs) return 0;
  const ageFactor = ageMs > lifeMs - fadeMs ? (lifeMs - ageMs) / fadeMs : 1;
  const distFactor = dist <= near ? 1 : dist >= far ? 0 : 1 - (dist - near) / (far - near);
  return Math.max(0, Math.min(1, ageFactor * distFactor));
}
