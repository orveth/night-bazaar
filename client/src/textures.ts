/**
 * Procedural canvas textures: the whole art budget is code (zero downloaded
 * assets). Glyph signs are fake hanzi: seeded stroke scribbles in a grid that
 * read as signage from a distance without being any real script.
 */

import * as THREE from "three/webgpu";
import { rngFrom, rfloat, rint } from "./seeded.ts";

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function asTexture(c: HTMLCanvasElement, repeat?: [number, number]): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/** Wet asphalt/cobble street: dark noise + faint slab grid + puddle sheens. */
export function groundTexture(seed = "bazaar-ground"): THREE.CanvasTexture {
  const rng = rngFrom(seed);
  const [c, g] = canvas(512, 512);
  g.fillStyle = "#262138";
  g.fillRect(0, 0, 512, 512);
  // grain
  for (let i = 0; i < 9000; i++) {
    const v = rint(rng, 0, 34);
    g.fillStyle = `rgba(${48 + v},${42 + v},${68 + v},0.5)`;
    g.fillRect(rfloat(rng, 0, 512), rfloat(rng, 0, 512), 2, 2);
  }
  // slab grid
  g.strokeStyle = "rgba(0,0,0,0.5)";
  g.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    const off = i * 64 + rfloat(rng, -3, 3);
    g.beginPath();
    g.moveTo(off, 0);
    g.lineTo(off, 512);
    g.stroke();
    g.beginPath();
    g.moveTo(0, off);
    g.lineTo(512, off);
    g.stroke();
  }
  // puddles: cool sheen blotches that catch the lantern light
  for (let i = 0; i < 14; i++) {
    const x = rfloat(rng, 0, 512);
    const y = rfloat(rng, 0, 512);
    const r = rfloat(rng, 18, 60);
    const grad = g.createRadialGradient(x, y, 2, x, y, r);
    grad.addColorStop(0, "rgba(86,96,158,0.30)");
    grad.addColorStop(1, "rgba(86,96,158,0)");
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(x, y, r, r * 0.6, rfloat(rng, 0, Math.PI), 0, Math.PI * 2);
    g.fill();
  }
  return asTexture(c, [6, 2]);
}

/** Striped awning canvas, neutral light/dark; tinted per stall by material color. */
export function awningTexture(colorA: string, colorB: string): THREE.CanvasTexture {
  const [c, g] = canvas(128, 64);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = i % 2 === 0 ? colorA : colorB;
    g.fillRect(i * 16, 0, 16, 64);
  }
  // grime along the lower edge
  g.fillStyle = "rgba(0,0,0,0.25)";
  g.fillRect(0, 48, 128, 16);
  return asTexture(c, [2, 1]);
}

/** One fake glyph: seeded strokes in a square cell; reads as hanzi-ish. */
function drawGlyph(
  g: CanvasRenderingContext2D,
  rng: () => number,
  x: number,
  y: number,
  size: number,
): void {
  const strokes = rint(rng, 3, 6);
  g.lineWidth = Math.max(2, size / 9);
  g.lineCap = "square";
  for (let i = 0; i < strokes; i++) {
    const horizontal = rng() > 0.45;
    const a = rfloat(rng, 0.08, 0.92);
    const b1 = rfloat(rng, 0.05, 0.5);
    const b2 = rfloat(rng, 0.5, 0.95);
    g.beginPath();
    if (horizontal) {
      g.moveTo(x + b1 * size, y + a * size);
      g.lineTo(x + b2 * size, y + a * size);
      if (rng() > 0.6) g.lineTo(x + b2 * size, y + Math.min(0.95, a + 0.25) * size);
    } else {
      g.moveTo(x + a * size, y + b1 * size);
      g.lineTo(x + a * size, y + b2 * size);
      if (rng() > 0.6) g.lineTo(x + Math.max(0.05, a - 0.25) * size, y + b2 * size);
    }
    g.stroke();
  }
}

export interface SignSpec {
  /** Glyph row (fake script), drawn big. */
  glyphs: number;
  /** Latin subtitle under the glyphs (price tags etc.). Empty = none. */
  subtitle: string;
  /** CSS color of glyphs/border (the neon tube color). */
  color: string;
  /** Vertical (Kowloon shop-sign) or horizontal (gate lintel) layout. */
  vertical: boolean;
  seed: string;
}

/** Neon sign canvas: near-black board, glowing glyphs + border. */
export function signTexture(spec: SignSpec): THREE.CanvasTexture {
  const rng = rngFrom(spec.seed);
  const cell = 56;
  const pad = 12;
  const sub = spec.subtitle ? 26 : 0;
  const w = spec.vertical ? cell + pad * 2 : cell * spec.glyphs + pad * 2;
  const h = spec.vertical ? cell * spec.glyphs + pad * 2 + sub : cell + pad * 2 + sub;
  const [c, g] = canvas(w, h);
  g.fillStyle = "#0b0810";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = spec.color;
  g.lineWidth = 3;
  g.strokeRect(3, 3, w - 6, h - 6);
  g.strokeStyle = spec.color;
  g.shadowColor = spec.color;
  g.shadowBlur = 10;
  for (let i = 0; i < spec.glyphs; i++) {
    const gx = spec.vertical ? pad : pad + i * cell;
    const gy = spec.vertical ? pad + i * cell : pad;
    drawGlyph(g, rng, gx + 6, gy + 6, cell - 12);
  }
  if (spec.subtitle) {
    g.shadowBlur = 6;
    g.font = "bold 17px ui-monospace, monospace";
    g.fillStyle = spec.color;
    g.textAlign = "center";
    g.fillText(spec.subtitle, w / 2, h - 10);
  }
  return asTexture(c);
}

/** Soft radial dot: particle sprite for steam/sparkles. */
export function dotTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.32)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return asTexture(c);
}

/** Styled name tag sprite texture. */
export function nameTagTexture(
  text: string,
  accent: string,
): { tex: THREE.CanvasTexture; w: number; h: number } {
  const [measureC] = canvas(8, 8);
  const mg = measureC.getContext("2d")!;
  mg.font = "600 26px ui-monospace, monospace";
  const tw = Math.ceil(mg.measureText(text).width);
  const w = tw + 36;
  const h = 44;
  const [c, g] = canvas(w, h);
  g.font = "600 26px ui-monospace, monospace";
  // pill
  g.fillStyle = "rgba(8,6,14,0.72)";
  g.beginPath();
  g.roundRect(2, 4, w - 4, h - 10, 12);
  g.fill();
  g.strokeStyle = accent;
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = "#f4eee2";
  g.fillText(text, 18, 31);
  return { tex: asTexture(c), w, h };
}

/** Chat bubble sprite texture (pre-wrapped lines). */
export function bubbleTexture(lines: string[]): {
  tex: THREE.CanvasTexture;
  w: number;
  h: number;
} {
  const font = "500 24px ui-monospace, monospace";
  const [measureC] = canvas(8, 8);
  const mg = measureC.getContext("2d")!;
  mg.font = font;
  const tw = Math.max(40, ...lines.map((l) => Math.ceil(mg.measureText(l).width)));
  const lh = 30;
  const w = tw + 36;
  const h = lines.length * lh + 26 + 12; // + tail
  const [c, g] = canvas(w, h);
  g.font = font;
  g.fillStyle = "rgba(244,238,226,0.92)";
  g.beginPath();
  g.roundRect(2, 2, w - 4, h - 16, 14);
  g.fill();
  // tail
  g.beginPath();
  g.moveTo(w / 2 - 9, h - 15);
  g.lineTo(w / 2, h - 2);
  g.lineTo(w / 2 + 9, h - 15);
  g.fill();
  g.fillStyle = "#1c1426";
  lines.forEach((l, i) => g.fillText(l, 18, 32 + i * lh));
  return { tex: asTexture(c), w, h };
}
