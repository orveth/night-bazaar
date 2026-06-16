/**
 * The night-market set: street, stalls (kitbashed from primitives, batched
 * into few draw calls), court gates with in-world price signage, lantern
 * strings, steam, skyline, chests. Everything is procedural: the only
 * "assets" are canvas textures drawn at boot.
 *
 * SERVER TRUTH: stall footprints and court walls come straight from the
 * `World` the server sent in `hello`; the visual geometry COVERS the
 * footprints so the camera never disagrees with the movement rules.
 */

import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { BoothSpec, ChestSpec, CourtSpec, StallSpec, World } from "../../protocol/protocol.ts";
import { rngFrom, pick, rfloat, rint } from "./seeded.ts";
import { awningTexture, dotTexture, groundTexture, signTexture } from "./textures.ts";

/* ------------------------------ materials --------------------------------- */

const MAT_SPECS: Record<string, () => THREE.MeshStandardMaterial> = {
  "wood.dark": () => std(0x4a2e1c, { roughness: 0.85 }),
  "wood.mid": () => std(0x6b3f26, { roughness: 0.8 }),
  "wood.warm": () => std(0x8a5230, { roughness: 0.75 }),
  panel: () => std(0x352342, { roughness: 0.9 }),
  metal: () => std(0x4e4e5e, { roughness: 0.45, metalness: 0.6 }),
  masonry: () => std(0x52405e, { roughness: 0.9 }),
  lacquer: () => std(0x8a1411, { roughness: 0.35 }),
  "lacquer.dark": () => std(0x5c0e0c, { roughness: 0.4 }),
  ice: () => std(0xdfeaf2, { roughness: 0.2, emissive: 0x4a6a7a, emissiveIntensity: 0.15 }),
  fish: () => std(0xb8c8d8, { roughness: 0.35 }),
  mask: () => std(0xe8d8c0, { roughness: 0.6 }),
  "fruit.orange": () => std(0xff9a3c, { roughness: 0.55 }),
  "fruit.green": () => std(0x9adb5c, { roughness: 0.55 }),
  bulb: () => glow(0xffd9a0, 2.2),
  "paper.red": () => glow(0xff4a22, 1.5, 0xb33018),
  "paper.gold": () => glow(0xffb152, 1.4, 0xb37b3a),
  "paper.teal": () => glow(0x2ee6c8, 1.3, 0x1d8a78),
  "glow.potion": () => glow(0x58ffba, 1.8, 0x174a32),
  ember: () => glow(0xff7a1a, 1.8, 0x4a2008),
  "trim.jade": () => glow(0x2bff96, 0.8, 0x0d3a22),
  "trim.crimson": () => glow(0xff2e44, 0.8, 0x3a0d12),
  window: () => glow(0xffc97a, 1.0, 0x3a2c14),
  "window.teal": () => glow(0x6ae8ff, 0.9, 0x143a44),
};

function std(
  color: number,
  extra: Partial<{
    roughness: number;
    metalness: number;
    emissive: number;
    emissiveIntensity: number;
  }> = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: extra.roughness ?? 0.7,
    metalness: extra.metalness ?? 0,
    emissive: extra.emissive ?? 0x000000,
    emissiveIntensity: extra.emissiveIntensity ?? 0,
    flatShading: true,
  });
}

/** Emissive-led material: near-black body, the emissive channel does the work
 * (feeds the bloom MRT). */
function glow(emissive: number, intensity: number, body = 0x121016): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: body,
    emissive,
    emissiveIntensity: intensity,
    roughness: 0.6,
    flatShading: true,
  });
}

/* ------------------------------- batcher ----------------------------------
 * Bakes transformed primitives into ONE merged geometry per material key;
 * the whole static market lands in ~30 draw calls. */

class Batcher {
  private byKey = new Map<string, THREE.BufferGeometry[]>();
  private mats = new Map<string, THREE.MeshStandardMaterial>();

  material(key: string): THREE.MeshStandardMaterial {
    let m = this.mats.get(key);
    if (!m) {
      const spec = MAT_SPECS[key];
      m = spec ? spec() : std(0xff00ff);
      this.mats.set(key, m);
    }
    return m;
  }

  add(key: string, geom: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
    const g = geom.clone().applyMatrix4(matrix);
    let list = this.byKey.get(key);
    if (!list) {
      list = [];
      this.byKey.set(key, list);
    }
    list.push(g);
  }

  box(key: string, size: [number, number, number], m: THREE.Matrix4): void {
    this.add(key, new THREE.BoxGeometry(...size), m);
  }

  cyl(key: string, rt: number, rb: number, h: number, m: THREE.Matrix4, seg = 8): void {
    this.add(key, new THREE.CylinderGeometry(rt, rb, h, seg), m);
  }

  sphere(key: string, r: number, m: THREE.Matrix4, w = 8, h = 6): void {
    this.add(key, new THREE.SphereGeometry(r, w, h), m);
  }

  build(into: THREE.Group): void {
    for (const [key, geoms] of this.byKey) {
      const merged = mergeGeometries(geoms, false);
      if (!merged) continue;
      into.add(new THREE.Mesh(merged, this.material(key)));
    }
    this.byKey.clear();
  }
}

const M = () => new THREE.Matrix4();
const at = (x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, s = 1): THREE.Matrix4 =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(s, s, s),
  );

/* ------------------------------- scenery ---------------------------------- */

export interface ChestHandle {
  group: THREE.Group;
  lid: THREE.Mesh;
  glowMat: THREE.MeshStandardMaterial;
  bodyMat: THREE.MeshStandardMaterial;
  sparkles: THREE.Points;
  claimed: boolean;
}

export interface Scenery {
  group: THREE.Group;
  /** Per-frame animation (lantern sway, steam, portal shimmer, sparkles). */
  update(tMs: number, dtMs: number): void;
  markCourtOpen(courtId: string): void;
  setChestClaimed(id: string, claimed: boolean): void;
  /** Front of the noodle stall (positional sizzle audio), if present. */
  noodlePos: { x: number; z: number } | null;
}

export function buildScenery(world: World): Scenery {
  const group = new THREE.Group();
  const updaters: ((tMs: number, dtMs: number) => void)[] = [];
  const batch = new Batcher();
  const dot = dotTexture();

  buildGroundAndSky(world, group, batch, updaters, dot);
  let noodlePos: { x: number; z: number } | null = null;
  const steamSpots: { x: number; y: number; z: number }[] = [];
  for (const stall of world.stalls) {
    const front = buildStall(stall, group, batch);
    if (stall.kind === "noodle" || stall.kind === "dumpling") {
      steamSpots.push({ x: front.x, y: 1.3, z: front.z });
      if (stall.kind === "noodle") noodlePos = { x: front.x, z: front.z };
    }
  }
  // One loose street vent (steam from below the slabs).
  steamSpots.push({ x: 5.0, y: 0.2, z: 5.5 });
  for (const spot of steamSpots.slice(0, 3)) {
    group.add(makeSteam(spot, dot, updaters));
  }

  const courtFx = new Map<string, { walls: THREE.MeshStandardMaterial; portal: THREE.MeshStandardMaterial }>();
  for (const court of world.courts) {
    courtFx.set(court.id, buildCourt(court, world, group, batch, updaters));
  }

  buildLanternStrings(world, group, batch, updaters);

  const chests = new Map<string, ChestHandle>();
  for (const chest of world.chests) {
    const handle = buildChest(chest, dot);
    chests.set(chest.id, handle);
    group.add(handle.group);
  }
  updaters.push((tMs) => {
    for (const c of chests.values()) {
      if (c.claimed) continue;
      c.glowMat.emissiveIntensity = 1.4 + Math.sin(tMs / 320) * 0.5;
      const mat = c.sparkles.material as THREE.PointsMaterial;
      mat.opacity = 0.65 + Math.sin(tMs / 180) * 0.3;
    }
  });

  // Playable booths (Phase 1b): a distinctive prop + a pulsing marker glow.
  for (const booth of world.booths) {
    buildBooth(booth, group, batch, dot, updaters);
  }

  batch.build(group);

  return {
    group,
    noodlePos,
    update(tMs, dtMs) {
      for (const u of updaters) u(tMs, dtMs);
    },
    markCourtOpen(courtId) {
      const fx = courtFx.get(courtId);
      if (!fx) return;
      fx.walls.color.setHex(0x2e5b48);
      fx.walls.opacity = 0.5;
      fx.walls.transparent = true;
      fx.walls.needsUpdate = true;
      fx.portal.opacity = 0.10;
      fx.portal.emissiveIntensity = 2.4;
    },
    setChestClaimed(id, claimed) {
      const c = chests.get(id);
      if (!c || c.claimed === claimed) return;
      c.claimed = claimed;
      c.glowMat.emissiveIntensity = claimed ? 0.05 : 1.4;
      c.bodyMat.color.setHex(claimed ? 0x3a3226 : 0x6b4a1d);
      c.sparkles.visible = !claimed;
      c.lid.rotation.x = claimed ? -1.1 : 0; // looted chests gape open + dark
    },
  };
}

/* ------------------------------ ground + sky ------------------------------ */

function buildGroundAndSky(
  world: World,
  group: THREE.Group,
  batch: Batcher,
  updaters: ((t: number, dt: number) => void)[],
  dot: THREE.Texture,
): void {
  const s = world.street;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(s.maxX - s.minX + 24, s.maxZ - s.minZ + 10),
    new THREE.MeshStandardMaterial({
      color: 0xcfc6dd,
      map: groundTexture(),
      roughness: 0.32,
      metalness: 0.18,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((s.minX + s.maxX) / 2, 0, (s.minZ + s.maxZ) / 2);
  group.add(ground);

  for (const court of world.courts) {
    const b = court.bounds;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(b.maxX - b.minX, b.maxZ - b.minZ),
      new THREE.MeshStandardMaterial({
        color: 0x6a6276,
        map: groundTexture(`court-${court.id}`),
        roughness: 0.4,
        metalness: 0.12,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((b.minX + b.maxX) / 2, 0.02, (b.minZ + b.maxZ) / 2);
    group.add(floor);
  }

  // Stars (fog off; they live beyond it).
  {
    const n = 240;
    const pos = new Float32Array(n * 3);
    const rng = rngFrom("stars");
    for (let i = 0; i < n; i++) {
      const a = rfloat(rng, -Math.PI, Math.PI);
      const r = rfloat(rng, 40, 110);
      pos[i * 3] = Math.sin(a) * r;
      pos[i * 3 + 1] = rfloat(rng, 24, 80);
      pos[i * 3 + 2] = Math.cos(a) * r;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x9fb0e8,
      size: 0.5,
      map: dot,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      fog: false,
    });
    group.add(new THREE.Points(geo, mat));
  }

  // A low haze moon.
  {
    const moonMat = new THREE.SpriteMaterial({
      map: dot,
      color: 0xc8d4ff,
      transparent: true,
      opacity: 0.5,
      fog: false,
      depthWrite: false,
    });
    const moon = new THREE.Sprite(moonMat);
    moon.scale.setScalar(26);
    moon.position.set(-34, 44, 90);
    group.add(moon);
  }

  // Kowloon skyline silhouettes behind the courts (north) with lit windows
  // and two big rooftop neon boards.
  const rng = rngFrom("skyline");
  for (let i = 0; i < 9; i++) {
    const w = rfloat(rng, 7, 13);
    const h = rfloat(rng, 8, 612 / 40);
    const x = -36 + i * 9 + rfloat(rng, -2, 2);
    const z = rfloat(rng, 34, 44);
    batch.box("panel", [w, h, 6], at(x, h / 2, z));
    const windows = rint(rng, 4, 9);
    for (let k = 0; k < windows; k++) {
      const key = rng() > 0.3 ? "window" : "window.teal";
      batch.box(
        key,
        [0.7, 0.9, 0.1],
        at(x + rfloat(rng, -w / 2 + 1, w / 2 - 1), rfloat(rng, 1.5, h - 1), z - 3.05),
      );
    }
  }
  for (const [i, color] of (["#ff2e9e", "#2ee6c8"] as const).entries()) {
    const tex = signTexture({
      glyphs: 4,
      subtitle: "",
      color,
      vertical: true,
      seed: `skyline-neon-${i}`,
    });
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0b0810,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 1.5,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 9), mat);
    m.position.set(i === 0 ? -16 : 18, 12, 33.4);
    m.rotation.y = Math.PI;
    group.add(m);
    updaters.push((tMs) => {
      // neon flicker
      mat.emissiveIntensity =
        1.5 + (Math.sin(tMs / 90 + i * 9) > 0.96 ? -0.9 : 0) + Math.sin(tMs / 700 + i) * 0.12;
    });
  }

  // NOTE: no south backdrop; the chase camera lives south of the street
  // (z ≈ player − 11.5) looking north; anything tall back there would sit
  // INSIDE the camera frustum and curtain the whole frame (found the hard
  // way: a 9-unit wall at minZ−4 blacked out the entire scene).
}

/* -------------------------------- stalls ---------------------------------- */

const AWNINGS: [string, string][] = [
  ["#b3382e", "#6e1c16"],
  ["#2e8a7a", "#175048"],
  ["#c8862e", "#7a4d16"],
  ["#5c3a8a", "#33205c"],
];
const SIGN_COLORS = ["#ff5a3c", "#ffb152", "#2ee6c8", "#ff2e9e", "#9aff5c", "#6ae8ff"];

const awningMats = new Map<number, THREE.MeshStandardMaterial>();
function awningMat(i: number): THREE.MeshStandardMaterial {
  let m = awningMats.get(i);
  if (!m) {
    const [a, b] = AWNINGS[i % AWNINGS.length]!;
    m = new THREE.MeshStandardMaterial({
      map: awningTexture(a, b),
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    awningMats.set(i, m);
  }
  return m;
}

/** Build one stall; returns its front-center (steam/audio anchor). */
function buildStall(
  stall: StallSpec,
  group: THREE.Group,
  batch: Batcher,
): { x: number; z: number } {
  const rng = rngFrom(stall.id);
  const fp = stall.footprint;
  const cx = (fp.minX + fp.maxX) / 2;
  const cz = (fp.minZ + fp.maxZ) / 2;
  const W = fp.maxX - fp.minX;
  const D = fp.maxZ - fp.minZ;
  // Local space: front = +z, then rotate by stall.rot about the footprint
  // center. rot 0 faces north (south row), rot ~PI faces south (north row).
  const place = (
    lx: number,
    ly: number,
    lz: number,
    ry = 0,
    rx = 0,
    rz = 0,
    s = 1,
  ): THREE.Matrix4 =>
    at(cx, 0, cz, stall.rot).multiply(at(lx, ly, lz, ry, rx, rz, s));
  const front = {
    x: cx + Math.sin(stall.rot) * (D / 2 + 0.4) * 1 + Math.cos(stall.rot) * 0,
    z: cz + Math.cos(stall.rot) * (D / 2 + 0.4),
  };

  if (stall.kind === "crates") {
    // A pile, not a shop: stacked boxes + barrels screening the alley nook.
    for (let i = 0; i < 7; i++) {
      const s = rfloat(rng, 0.7, 1.2);
      batch.box(
        "wood.mid",
        [s, s, s],
        place(rfloat(rng, -W / 3, W / 3), s / 2 + (i > 4 ? 0.95 : 0), rfloat(rng, -D / 3, D / 3), rfloat(rng, 0, 1.2)),
      );
    }
    batch.cyl("wood.dark", 0.45, 0.5, 1.1, place(W / 4, 0.55, -D / 4));
    batch.cyl("wood.dark", 0.45, 0.5, 1.1, place(W / 4, 1.65, -D / 4));
    return front;
  }

  const roofH = stall.kind === "potion" ? 3.0 : rfloat(rng, 2.9, 3.3);
  const awningIdx = rint(rng, 0, AWNINGS.length - 1);

  // Frame: 4 posts, counter, back wall, side panels, roof slab.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      batch.box("wood.dark", [0.14, roofH, 0.14], place(sx * (W / 2 - 0.15), roofH / 2, sz * (D / 2 - 0.12)));
    }
  }
  batch.box("wood.warm", [W * 0.92, 1.0, D * 0.5], place(0, 0.5, D * 0.16));
  batch.box("wood.mid", [W * 0.92, 0.08, D * 0.56], place(0, 1.04, D * 0.16)); // counter top
  batch.box("panel", [W * 0.96, roofH - 0.5, 0.1], place(0, (roofH - 0.5) / 2 + 0.1, -D / 2 + 0.1));
  batch.box("wood.dark", [W, 0.12, D * 0.92], place(0, roofH, 0)); // roof slab
  // Sloped awning over the counter.
  const awn = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.08, D * 0.72), awningMat(awningIdx));
  awn.geometry.applyMatrix4(at(0, 0, 0, 0, -Math.PI / 2 + 0.32));
  awn.geometry.applyMatrix4(place(0, roofH - 0.42, D * 0.32));
  group.add(awn);
  // Valance strip on the awning's front lip.
  batch.box("lacquer.dark", [W * 1.08, 0.18, 0.04], place(0, roofH - 0.62, D * 0.58));

  // The bare bulb under the awning (emissive only; street point lights do
  // the actual lighting).
  batch.sphere("bulb", 0.09, place(0, roofH - 0.9, D * 0.22));

  // Neon shop sign: vertical at a front post, or horizontal over the lip.
  const signColor = pick(rng, SIGN_COLORS);
  const vertical = rng() > 0.42;
  const tex = signTexture({
    glyphs: vertical ? rint(rng, 2, 3) : rint(rng, 2, 4),
    subtitle: "",
    color: signColor,
    vertical,
    seed: `sign-${stall.id}`,
  });
  const signMat = new THREE.MeshStandardMaterial({
    color: 0x0b0810,
    emissive: 0xffffff,
    emissiveMap: tex,
    emissiveIntensity: 1.35,
    side: THREE.DoubleSide,
  });
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(vertical ? 0.62 : W * 0.7, vertical ? 1.9 : 0.6),
    signMat,
  );
  sign.applyMatrix4(
    vertical
      ? place(-W / 2 + 0.18, roofH - 1.25, D / 2 + 0.05)
      : place(0, roofH + 0.5, D * 0.46),
  );
  group.add(sign);

  // Kind clutter on the counter (y just above the top).
  const top = 1.1;
  switch (stall.kind) {
    case "noodle": {
      batch.cyl("metal", 0.34, 0.3, 0.5, place(-W * 0.22, top + 0.25, D * 0.16));
      batch.cyl("metal", 0.26, 0.24, 0.4, place(W * 0.1, top + 0.2, D * 0.2));
      for (let i = 0; i < 5; i++)
        batch.cyl("mask", 0.09, 0.07, 0.08, place(W * (0.28 + 0.07 * i), top + 0.04, D * 0.1));
      break;
    }
    case "fish": {
      batch.box("ice", [W * 0.6, 0.12, D * 0.4], place(0, top + 0.06, D * 0.16));
      for (let i = 0; i < 6; i++) {
        const m = place(
          rfloat(rng, -W * 0.26, W * 0.26),
          top + 0.16,
          D * rfloat(rng, 0.04, 0.28),
          rfloat(rng, 0, 3),
        ).multiply(new THREE.Matrix4().makeScale(1, 0.45, 0.32));
        batch.sphere("fish", 0.22, m);
      }
      break;
    }
    case "lantern": {
      for (let i = 0; i < 6; i++) {
        const key = pick(rng, ["paper.red", "paper.gold", "paper.teal"]);
        const m = place(rfloat(rng, -W * 0.3, W * 0.3), top + 0.16, D * rfloat(rng, 0, 0.3));
        batch.sphere(key, rfloat(rng, 0.12, 0.2), m);
      }
      // hanging minis from the lip
      for (let i = 0; i < 4; i++) {
        batch.sphere(
          pick(rng, ["paper.red", "paper.gold"]),
          0.12,
          place(-W * 0.36 + i * W * 0.24, roofH - 1.0, D * 0.5),
        );
      }
      break;
    }
    case "tea": {
      for (let i = 0; i < 7; i++)
        batch.cyl("mask", 0.06, 0.05, 0.1, place(-W * 0.3 + i * 0.18, top + 0.05, D * 0.2));
      batch.cyl("metal", 0.16, 0.14, 0.3, place(W * 0.25, top + 0.15, D * 0.12));
      break;
    }
    case "trinket": {
      batch.box("wood.mid", [W * 0.7, 0.06, 0.3], place(0, top + 0.5, -D * 0.1));
      for (let i = 0; i < 6; i++) {
        const key = pick(rng, ["glow.potion", "paper.teal", "paper.gold"]);
        batch.cyl(key, 0.05, 0.06, rfloat(rng, 0.12, 0.24), place(-W * 0.3 + i * 0.12, top + 0.6, -D * 0.1));
      }
      break;
    }
    case "skewer": {
      batch.box("metal", [W * 0.55, 0.16, 0.36], place(0, top + 0.1, D * 0.18));
      for (let i = 0; i < 6; i++)
        batch.cyl("wood.dark", 0.012, 0.012, 0.5, place(-W * 0.2 + i * 0.08, top + 0.32, D * 0.18, 0, 0.5));
      for (let i = 0; i < 3; i++)
        batch.sphere("ember", 0.05, place(-W * 0.16 + i * 0.14, top + 0.13, D * 0.18));
      break;
    }
    case "potion": {
      for (let i = 0; i < 7; i++) {
        batch.cyl(
          "glow.potion",
          rfloat(rng, 0.05, 0.08),
          0.08,
          rfloat(rng, 0.18, 0.34),
          place(rfloat(rng, -W * 0.32, W * 0.32), top + 0.14, D * rfloat(rng, 0, 0.26)),
        );
      }
      batch.box("wood.mid", [W * 0.6, 0.05, 0.26], place(0, top + 0.55, -D * 0.08));
      for (let i = 0; i < 4; i++)
        batch.cyl("glow.potion", 0.05, 0.06, 0.2, place(-W * 0.22 + i * 0.15, top + 0.68, -D * 0.08));
      break;
    }
    case "fruit": {
      for (const [bx, key] of [
        [-W * 0.22, "fruit.orange"],
        [W * 0.12, "fruit.green"],
      ] as const) {
        batch.box("wood.mid", [0.8, 0.18, 0.6], place(bx, top + 0.09, D * 0.16));
        for (let i = 0; i < 6; i++) {
          batch.sphere(
            key,
            0.1,
            place(bx + rfloat(rng, -0.26, 0.26), top + 0.26, D * 0.16 + rfloat(rng, -0.16, 0.16)),
          );
        }
      }
      break;
    }
    case "dumpling": {
      for (let i = 0; i < 3; i++)
        batch.cyl("mask", 0.3 - i * 0.01, 0.3, 0.14, place(-W * 0.2, top + 0.08 + i * 0.15, D * 0.18));
      batch.cyl("metal", 0.3, 0.28, 0.2, place(W * 0.18, top + 0.1, D * 0.18));
      break;
    }
    case "mask": {
      for (let i = 0; i < 5; i++) {
        const m = place(-W * 0.32 + i * W * 0.16, roofH - 1.1 - (i % 2) * 0.3, -D * 0.1).multiply(
          new THREE.Matrix4().makeScale(1, 1.3, 0.35),
        );
        batch.sphere(pick(rng, ["mask", "fruit.orange", "paper.teal"]), 0.16, m);
      }
      break;
    }
    case "incense": {
      batch.box("metal", [0.5, 0.1, 0.5], place(0, top + 0.05, D * 0.12));
      for (let i = 0; i < 8; i++) {
        const lean = rfloat(rng, -0.18, 0.18);
        batch.cyl("wood.dark", 0.008, 0.008, 0.5, place(rfloat(rng, -0.15, 0.15), top + 0.32, D * 0.12, 0, lean, lean));
        batch.sphere("ember", 0.022, place(Math.sin(lean) * -0.5 + rfloat(rng, -0.15, 0.15), top + 0.56, D * 0.12));
      }
      break;
    }
    default:
      break;
  }

  // Roof clutter so rooftops read lived-in (and the rooftop chest has props).
  for (let i = 0; i < rint(rng, 1, 3); i++) {
    const s = rfloat(rng, 0.4, 0.7);
    batch.box("wood.mid", [s, s, s], place(rfloat(rng, -W * 0.3, W * 0.3), roofH + s / 2 + 0.06, rfloat(rng, -D * 0.2, D * 0.2), rfloat(rng, 0, 1)));
  }

  // South-row stalls show the camera their BACKS; dress them: a rooftop
  // neon board facing the camera + a warm bulb string along the back edge,
  // so the foreground band reads as stacked Kowloon signage, not black boxes.
  if (Math.abs(stall.rot) < 0.1) {
    const backTex = signTexture({
      glyphs: rint(rng, 2, 3),
      subtitle: "",
      color: pick(rng, SIGN_COLORS),
      vertical: rng() > 0.5,
      seed: `back-${stall.id}`,
    });
    const vertical = backTex.image.height > backTex.image.width;
    const backMat = new THREE.MeshStandardMaterial({
      color: 0x0b0810,
      emissive: 0xffffff,
      emissiveMap: backTex,
      emissiveIntensity: 1.1,
      side: THREE.DoubleSide,
    });
    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(vertical ? 0.7 : 2.0, vertical ? 2.0 : 0.7),
      backMat,
    );
    back.applyMatrix4(
      place(rfloat(rng, -W * 0.25, W * 0.25), roofH + 1.15, -D / 2 + 0.06, Math.PI),
    );
    group.add(back);
    for (let i = 0; i < 4; i++) {
      batch.sphere("bulb", 0.06, place(-W * 0.38 + (i * W * 0.76) / 3, roofH + 0.12, -D / 2 + 0.1));
    }
  }

  return front;
}

/* ------------------------------ court + gate ------------------------------ */

const WALL_H = 2.4;
const WALL_T = 0.4;

function buildCourt(
  court: CourtSpec,
  world: World,
  group: THREE.Group,
  batch: Batcher,
  updaters: ((t: number, dt: number) => void)[],
): { walls: THREE.MeshStandardMaterial; portal: THREE.MeshStandardMaterial } {
  const b = court.bounds;
  const isJade = court.id === "jade";
  const accentHex = isJade ? 0x2bff96 : 0xff2e44;
  const accentCss = isJade ? "#2bff96" : "#ff4a5c";
  const trimKey = isJade ? "trim.jade" : "trim.crimson";

  // Walls (EXACT server segments, one merged mesh, own material for tinting).
  const wallMat = std(0x4d3a78, { roughness: 0.85 });
  const segs: THREE.BoxGeometry[] = [];
  const seg = (cx2: number, cz2: number, sx: number, sz: number) => {
    const g = new THREE.BoxGeometry(sx, WALL_H, sz);
    g.applyMatrix4(at(cx2, WALL_H / 2, cz2));
    segs.push(g);
  };
  seg((b.minX + court.door.x1) / 2, b.minZ, court.door.x1 - b.minX, WALL_T);
  seg((court.door.x2 + b.maxX) / 2, b.minZ, b.maxX - court.door.x2, WALL_T);
  seg((b.minX + b.maxX) / 2, b.maxZ, b.maxX - b.minX, WALL_T);
  seg(b.minX, (b.minZ + b.maxZ) / 2, WALL_T, b.maxZ - b.minZ);
  seg(b.maxX, (b.minZ + b.maxZ) / 2, WALL_T, b.maxZ - b.minZ);
  const wallsGeo = mergeGeometries(segs, false)!;
  group.add(new THREE.Mesh(wallsGeo, wallMat));

  // Emissive trim along the wall tops (visible over the fog, sells the court).
  const trim = (cx2: number, cz2: number, sx: number, sz: number) =>
    batch.box(trimKey, [sx, 0.07, sz], at(cx2, WALL_H + 0.05, cz2));
  trim((b.minX + court.door.x1) / 2, b.minZ, court.door.x1 - b.minX, 0.12);
  trim((court.door.x2 + b.maxX) / 2, b.minZ, b.maxX - court.door.x2, 0.12);
  trim((b.minX + b.maxX) / 2, b.maxZ, b.maxX - b.minX, 0.12);
  trim(b.minX, (b.minZ + b.maxZ) / 2, 0.12, b.maxZ - b.minZ);
  trim(b.maxX, (b.minZ + b.maxZ) / 2, 0.12, b.maxZ - b.minZ);

  // THE GATE: lacquered torii over the door gap + hanging price sign + portal.
  const doorCx = (court.door.x1 + court.door.x2) / 2;
  const doorW = court.door.x2 - court.door.x1;
  batch.box("lacquer", [0.5, 4.1, 0.5], at(court.door.x1 - 0.45, 2.05, b.minZ));
  batch.box("lacquer", [0.5, 4.1, 0.5], at(court.door.x2 + 0.45, 2.05, b.minZ));
  batch.box("lacquer", [doorW + 2.6, 0.45, 0.7], at(doorCx, 4.0, b.minZ));
  batch.box("lacquer.dark", [doorW + 1.6, 0.3, 0.55], at(doorCx, 3.25, b.minZ));
  batch.box("paper.gold", [doorW + 2.6, 0.08, 0.72], at(doorCx, 4.26, b.minZ));
  // String of tiny gate bulbs under the lintel.
  for (let i = 0; i <= 6; i++) {
    batch.sphere("paper.gold", 0.07, at(court.door.x1 - 0.3 + ((doorW + 0.6) * i) / 6, 3.05 - Math.sin((i / 6) * Math.PI) * 0.18, b.minZ + 0.18));
  }

  // In-world price signage (the contract's "court gate signage" shot).
  const tex = signTexture({
    glyphs: 2,
    subtitle: `${court.id.toUpperCase()} · ${court.price} pops`,
    color: accentCss,
    vertical: false,
    seed: `gate-${court.id}`,
  });
  const signMat = new THREE.MeshStandardMaterial({
    color: 0x0b0810,
    emissive: 0xffffff,
    emissiveMap: tex,
    emissiveIntensity: 1.5,
    side: THREE.DoubleSide,
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(doorW * 0.92, 1.05), signMat);
  sign.position.set(doorCx, 2.55, b.minZ - 0.08);
  sign.rotation.y = Math.PI;
  group.add(sign);
  // Tall vertical neon beside the gate (Kowloon stack).
  const sideTex = signTexture({
    glyphs: 3,
    subtitle: "",
    color: accentCss,
    vertical: true,
    seed: `gate-side-${court.id}`,
  });
  const sideMat = new THREE.MeshStandardMaterial({
    color: 0x0b0810,
    emissive: 0xffffff,
    emissiveMap: sideTex,
    emissiveIntensity: 1.3,
    side: THREE.DoubleSide,
  });
  const side = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 2.6), sideMat);
  side.position.set(court.door.x2 + 1.15, 2.4, b.minZ - 0.3);
  group.add(side);

  // Portal shimmer in the doorway (drops when the door opens for you).
  const portalMat = new THREE.MeshStandardMaterial({
    color: 0x0a0812,
    emissive: accentHex,
    emissiveIntensity: 1.2,
    transparent: true,
    opacity: 0.32,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const portal = new THREE.Mesh(new THREE.PlaneGeometry(doorW, 2.9), portalMat);
  portal.position.set(doorCx, 1.45, b.minZ);
  group.add(portal);
  updaters.push((tMs) => {
    portalMat.emissiveIntensity =
      portalMat.opacity < 0.2
        ? 2.2 + Math.sin(tMs / 300) * 0.3
        : 1.1 + Math.sin(tMs / 450 + doorCx) * 0.35;
  });

  // Court interior dressing: pedestal braziers + wall banners.
  const cx = (b.minX + b.maxX) / 2;
  for (const sx of [-1, 1]) {
    const bx = cx + sx * (b.maxX - b.minX) * 0.3;
    batch.cyl("masonry", 0.32, 0.42, 0.9, at(bx, 0.45, b.maxZ - 2));
    batch.sphere("ember", 0.22, at(bx, 1.0, b.maxZ - 2));
  }
  const bannerMat = new THREE.MeshStandardMaterial({
    color: isJade ? 0x14532e : 0x58121b,
    emissive: accentHex,
    emissiveIntensity: 0.12,
    side: THREE.DoubleSide,
    roughness: 0.9,
  });
  for (const off of [-0.25, 0.25]) {
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.0), bannerMat);
    banner.position.set(cx + off * (b.maxX - b.minX), 1.35, b.maxZ - 0.25);
    group.add(banner);
  }

  return { walls: wallMat, portal: portalMat };
}

/* ----------------------------- lantern strings ---------------------------- */

function buildLanternStrings(
  world: World,
  group: THREE.Group,
  batch: Batcher,
  updaters: ((t: number, dt: number) => void)[],
): void {
  interface Hung {
    base: THREE.Vector3;
    phase: number;
    amp: number;
    inst: number; // which instanced mesh
    index: number;
  }
  const xs = [-27, -20.5, -14, -7, -2, 3.5, 10, 17, 23.5, 28];
  const rng = rngFrom("lanterns");
  const hungs: Hung[] = [];
  const counts = [0, 0, 0];

  const lineMat = new THREE.LineBasicMaterial({ color: 0x241a14 });
  for (const x of xs) {
    const y0 = rfloat(rng, 4.0, 4.8);
    const y1 = rfloat(rng, 4.0, 4.8);
    const z0 = world.street.minZ - 2.2;
    const z1 = world.street.maxZ + 0.4;
    const sag = rfloat(rng, 0.8, 1.3);
    const pts: THREE.Vector3[] = [];
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const y = y0 + (y1 - y0) * t - sag * (1 - (2 * t - 1) ** 2);
      pts.push(new THREE.Vector3(x, y, z0 + (z1 - z0) * t));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    for (let i = 1; i < n; i += 1) {
      if (rng() > 0.82) continue; // gaps feel hand-strung
      const p = pts[i]!;
      const r = rng();
      const inst = r < 0.55 ? 0 : r < 0.85 ? 1 : 2;
      hungs.push({
        base: new THREE.Vector3(p.x, p.y - 0.34, p.z),
        phase: rfloat(rng, 0, Math.PI * 2),
        amp: rfloat(rng, 0.05, 0.16),
        inst,
        index: counts[inst]!++,
      });
    }
  }

  // Street-edge poles where strings anchor south (north ends melt into the
  // court walls / fog).
  for (const x of xs) {
    if (rng() > 0.55) continue;
    batch.cyl("wood.dark", 0.07, 0.09, 4.6, at(x, 2.3, world.street.minZ - 2.2));
  }

  const mkInst = (count: number, color: number, emissive: number, scaleY: number) => {
    const geo = new THREE.SphereGeometry(0.27, 10, 8);
    geo.applyMatrix4(new THREE.Matrix4().makeScale(1, scaleY, 1));
    const mat = glow(emissive, 1.15, color);
    const inst = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return inst;
  };
  const instances = [
    mkInst(counts[0]!, 0x701408, 0xff3a1a, 0.82), // red round
    mkInst(counts[1]!, 0x6e4a10, 0xffb152, 1.15), // gold tall
    mkInst(counts[2]!, 0x0e4a40, 0x2ee6c8, 0.9), // teal accents
  ];
  for (const inst of instances) group.add(inst);

  // Caps batched once (static; the sway is too subtle to move the caps).
  for (const h of hungs) {
    batch.cyl("wood.dark", 0.07, 0.09, 0.09, at(h.base.x, h.base.y + 0.26, h.base.z));
  }

  const m4 = M();
  updaters.push((tMs) => {
    const t = tMs / 1000;
    for (const h of hungs) {
      const sway = Math.sin(t * 1.1 + h.phase) * h.amp;
      const bob = Math.cos(t * 0.9 + h.phase * 1.7) * 0.03;
      m4.makeRotationZ(sway * 0.7);
      m4.setPosition(h.base.x + sway, h.base.y + bob, h.base.z);
      instances[h.inst]!.setMatrixAt(h.index, m4);
    }
    for (const inst of instances) inst.instanceMatrix.needsUpdate = true;
  });
}

/* --------------------------------- steam ---------------------------------- */

function makeSteam(
  spot: { x: number; y: number; z: number },
  dot: THREE.Texture,
  updaters: ((t: number, dt: number) => void)[],
): THREE.Points {
  const N = 26;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const life = new Float32Array(N);
  const seed = new Float32Array(N);
  const rng = rngFrom(`steam-${spot.x}-${spot.z}`);
  for (let i = 0; i < N; i++) {
    life[i] = rng() * 2.4;
    seed[i] = rng() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.7,
    map: dot,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
  });
  const points = new THREE.Points(geo, mat);
  points.position.set(spot.x, spot.y, spot.z);
  updaters.push((_tMs, dtMs) => {
    const dt = dtMs / 1000;
    for (let i = 0; i < N; i++) {
      life[i] = (life[i]! + dt) % 2.4;
      const t = life[i]! / 2.4;
      pos[i * 3] = Math.sin(seed[i]! + t * 3) * 0.3 * t;
      pos[i * 3 + 1] = t * 2.2;
      pos[i * 3 + 2] = Math.cos(seed[i]! * 1.3 + t * 2) * 0.25 * t;
      const a = (1 - t) * 0.5 * Math.min(1, t * 6);
      col[i * 3] = a * 0.7;
      col[i * 3 + 1] = a * 0.74;
      col[i * 3 + 2] = a * 0.82;
    }
    geo.attributes.position!.needsUpdate = true;
    geo.attributes.color!.needsUpdate = true;
  });
  return points;
}

/* --------------------------------- chests --------------------------------- */

function buildChest(chest: ChestSpec, dot: THREE.Texture): ChestHandle {
  const group = new THREE.Group();
  // Elevated chests rest on the stall roof slab (top ≈ chest.y - 0.34).
  const base = chest.y > 0 ? chest.y - 0.34 : 0;
  group.position.set(chest.x, base, chest.z);

  const bodyMat = std(0x6b4a1d, { roughness: 0.5 });
  const glowMat = glow(0xffd34d, 1.4, 0x3a2c10);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.55, 0.65), bodyMat);
  body.position.y = 0.28;
  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.99, 0.22, 0.69), bodyMat);
  lid.position.y = 0.62;
  const band = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.1, 0.7), glowMat);
  band.position.y = 0.45;
  const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 0.08), glowMat);
  clasp.position.set(0, 0.45, 0.36);
  group.add(body, lid, band, clasp);

  const N = 8;
  const pos = new Float32Array(N * 3);
  const rng = rngFrom(`sparkle-${chest.id}`);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = rfloat(rng, -0.6, 0.6);
    pos[i * 3 + 1] = rfloat(rng, 0.7, 1.6);
    pos[i * 3 + 2] = rfloat(rng, -0.5, 0.5);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const sparkles = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      color: 0xffe28a,
      size: 0.35,
      map: dot,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  group.add(sparkles);

  return { group, lid, glowMat, bodyMat, sparkles, claimed: false };
}

/* --------------------------------- booths --------------------------------- */

/** Build a playable booth's prop + a pulsing marker beacon at (x, z). The
 * prop is kitbashed from primitives (batched), distinct per kind; the beacon
 * is a small emissive sprite that pulses so the booth reads as interactive. */
function buildBooth(
  booth: BoothSpec,
  group: THREE.Group,
  batch: Batcher,
  dot: THREE.Texture,
  updaters: ((t: number, dt: number) => void)[],
): void {
  const x = booth.x;
  const z = booth.z;
  const accent =
    booth.kind === "riddle" ? 0xffd34d : booth.kind === "gacha" ? 0xff4ad3 : 0x6ae8ff;
  const accentKey =
    booth.kind === "riddle" ? "paper.gold" : booth.kind === "gacha" ? "paper.red" : "paper.teal";

  if (booth.kind === "riddle") {
    // A tall lantern post crowned with a glowing paper lantern.
    batch.cyl("wood.dark", 0.08, 0.1, 2.6, at(x, 1.3, z));
    batch.box("wood.dark", [0.5, 0.08, 0.08], at(x, 2.55, z));
    const lantern = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 12, 10).applyMatrix4(new THREE.Matrix4().makeScale(1, 1.25, 1)),
      glow(0xffd34d, 1.8, 0x4a3410),
    );
    lantern.position.set(x, 2.2, z);
    group.add(lantern);
    updaters.push((tMs) => {
      (lantern.material as THREE.MeshStandardMaterial).emissiveIntensity =
        1.6 + Math.sin(tMs / 360) * 0.5;
    });
  } else if (booth.kind === "gacha") {
    // A little shrine: stepped base, two posts, a torii-ish lintel, an orb.
    batch.box("lacquer", [1.3, 0.2, 1.0], at(x, 0.1, z));
    batch.box("lacquer.dark", [1.0, 0.18, 0.8], at(x, 0.29, z));
    for (const sx of [-1, 1]) batch.box("lacquer", [0.12, 1.6, 0.12], at(x + sx * 0.45, 1.1, z));
    batch.box("lacquer", [1.4, 0.16, 0.2], at(x, 1.95, z));
    batch.box(accentKey, [1.5, 0.06, 0.22], at(x, 2.08, z));
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 12), glow(0xff4ad3, 2.0, 0x4a103a));
    orb.position.set(x, 1.3, z);
    group.add(orb);
    updaters.push((tMs) => {
      orb.position.y = 1.3 + Math.sin(tMs / 500) * 0.08;
      (orb.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.8 + Math.sin(tMs / 240) * 0.6;
    });
  } else {
    // The bell: a frame with a hanging bell (the timing target).
    for (const sx of [-1, 1]) batch.cyl("wood.warm", 0.08, 0.1, 2.2, at(x + sx * 0.5, 1.1, z, 0, 0, sx * 0.12));
    batch.box("wood.dark", [1.4, 0.12, 0.12], at(x, 2.1, z));
    const bell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.16, 0.5, 12).applyMatrix4(at(0, 0, 0, 0, Math.PI, 0)),
      glow(0x6ae8ff, 1.4, 0x14323a),
    );
    bell.position.set(x, 1.6, z);
    group.add(bell);
    updaters.push((tMs) => {
      bell.rotation.z = Math.sin(tMs / 700) * 0.12;
      (bell.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.3 + Math.sin(tMs / 300) * 0.4;
    });
  }

  // The shared marker beacon: a pulsing emissive disc on the ground so the
  // booth reads as a place you can DO something.
  const beaconMat = new THREE.SpriteMaterial({
    map: dot,
    color: accent,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const beacon = new THREE.Sprite(beaconMat);
  beacon.scale.setScalar(2.2);
  beacon.position.set(x, 0.1, z);
  group.add(beacon);

  // A faint floor ring of points to mark the interact spot.
  const N = 16;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    pos[i * 3] = x + Math.cos(a) * 1.4;
    pos[i * 3 + 1] = 0.05;
    pos[i * 3 + 2] = z + Math.sin(a) * 1.4;
  }
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const ring = new THREE.Points(
    ringGeo,
    new THREE.PointsMaterial({
      color: accent,
      size: 0.28,
      map: dot,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  group.add(ring);

  updaters.push((tMs) => {
    beaconMat.opacity = 0.55 + Math.sin(tMs / 280) * 0.3;
    (ring.material as THREE.PointsMaterial).opacity = 0.45 + Math.sin(tMs / 200 + 1) * 0.25;
  });
}
