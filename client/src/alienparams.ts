/**
 * Procedural alien PARAMETERS: pure and DOM/three-free so bun can unit-test
 * determinism. The same session id grows the same alien on every client.
 * The mesh builder that consumes these lives in alien.ts (three-dependent).
 */

import { hashString, mulberry32, rfloat, rint } from "./seeded.ts";

export interface AlienParams {
  /** Base skin hue [0,1): saturated odd colors. */
  hue: number;
  /** Accent hue (belly, antenna tips). */
  accentHue: number;
  /** 0 = round blob, 1 = tall taper, 2 = squat wide. */
  shape: 0 | 1 | 2;
  /** Overall height scale. */
  height: number;
  /** Body width scale. */
  width: number;
  /** 1..3 eyes. */
  eyes: number;
  /** Eye radius scale. */
  eyeSize: number;
  /** 0..3 antennae. */
  antennae: number;
  /** Antenna lean, radians. */
  antennaLean: number;
  /** Glowing belly patch. */
  belly: boolean;
  /** Side ear-fins. */
  fins: boolean;
}

export function alienParamsFromSeed(seed: string): AlienParams {
  const rng = mulberry32(hashString(seed));
  const hue = rng();
  return {
    hue,
    accentHue: (hue + rfloat(rng, 0.28, 0.62)) % 1,
    shape: rint(rng, 0, 2) as 0 | 1 | 2,
    height: rfloat(rng, 0.85, 1.25),
    width: rfloat(rng, 0.8, 1.3),
    eyes: rint(rng, 1, 3),
    eyeSize: rfloat(rng, 0.8, 1.5),
    antennae: rint(rng, 0, 3),
    antennaLean: rfloat(rng, -0.45, 0.45),
    belly: rng() > 0.45,
    fins: rng() > 0.55,
  };
}
