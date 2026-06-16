/**
 * Procedural weird-alien bodies. `alienParamsFromSeed` is pure and
 * deterministic (unit-tested): the same session id grows the same alien on
 * every client. The mesh builder kitbashes low-poly primitives from the
 * params — no downloaded models.
 */

import * as THREE from "three/webgpu";
import { hashString, mulberry32, rfloat } from "./seeded.ts";
import type { AlienParams } from "./alienparams.ts";

export { alienParamsFromSeed, type AlienParams } from "./alienparams.ts";

/* Shared geometries (built once). */
let geos: {
  sphere: THREE.SphereGeometry;
  cone: THREE.ConeGeometry;
  stick: THREE.CylinderGeometry;
} | null = null;

function sharedGeos() {
  geos ??= {
    sphere: new THREE.SphereGeometry(1, 10, 8),
    cone: new THREE.ConeGeometry(1, 1, 9),
    stick: new THREE.CylinderGeometry(0.04, 0.05, 1, 5),
  };
  return geos;
}

const skin = (hue: number, emissiveBoost = 0) =>
  new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(hue, 0.62, 0.52),
    emissive: new THREE.Color().setHSL(hue, 0.7, 0.32),
    emissiveIntensity: 0.12 + emissiveBoost,
    roughness: 0.55,
    flatShading: true,
  });

/**
 * Build the alien. Origin at the feet; total height ~1.7-2.2 units. Returns
 * the group; caller positions/rotates it.
 */
export function buildAlien(params: AlienParams): THREE.Group {
  const g = sharedGeos();
  const group = new THREE.Group();
  const skinMat = skin(params.hue);
  const accentMat = skin(params.accentHue, 0.5);

  const h = 1.25 * params.height;
  const w = 0.55 * params.width;

  // Body.
  const body = new THREE.Mesh(params.shape === 1 ? g.cone : g.sphere, skinMat);
  if (params.shape === 0) body.scale.set(w, h * 0.62, w * 0.92);
  if (params.shape === 1) body.scale.set(w * 1.15, h * 1.15, w * 1.05);
  if (params.shape === 2) body.scale.set(w * 1.45, h * 0.5, w * 1.2);
  body.position.y = params.shape === 1 ? h * 0.62 : h * 0.62;
  group.add(body);

  // Head.
  const headR = 0.34 * params.width * (params.shape === 2 ? 1.25 : 1);
  const head = new THREE.Mesh(g.sphere, skinMat);
  head.scale.setScalar(headR);
  head.position.y = body.position.y + h * (params.shape === 1 ? 0.72 : 0.55) + headR * 0.5;
  group.add(head);

  // Eyes face -z (the avatar's forward).
  const eyeR = 0.085 * params.eyeSize;
  const eyeWhite = new THREE.MeshStandardMaterial({
    color: 0xf8f4e8,
    emissive: 0xb8b09a,
    emissiveIntensity: 0.35,
    roughness: 0.3,
  });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x16101e, roughness: 0.4 });
  for (let i = 0; i < params.eyes; i++) {
    const off = (i - (params.eyes - 1) / 2) * eyeR * 2.6;
    const eye = new THREE.Mesh(g.sphere, eyeWhite);
    eye.scale.setScalar(eyeR);
    eye.position.set(off, head.position.y + (i % 2 === 0 ? 0 : eyeR), -headR * 0.82);
    const pupil = new THREE.Mesh(g.sphere, pupilMat);
    pupil.scale.setScalar(eyeR * 0.45);
    pupil.position.set(off, eye.position.y, eye.position.z - eyeR * 0.62);
    group.add(eye, pupil);
  }

  // Antennae with glowing tips.
  for (let i = 0; i < params.antennae; i++) {
    const off = (i - (params.antennae - 1) / 2) * 0.16;
    const stickLen = rfloat(mulberry32(hashString(`${params.hue}${i}`)), 0.3, 0.55);
    const stick = new THREE.Mesh(g.stick, skinMat);
    stick.scale.y = stickLen;
    stick.position.set(off, head.position.y + headR + stickLen / 2, 0);
    stick.rotation.z = params.antennaLean + off * 1.6;
    const tip = new THREE.Mesh(g.sphere, accentMat);
    tip.scale.setScalar(0.07);
    tip.position.set(
      off + Math.sin(stick.rotation.z) * stickLen,
      stick.position.y + (Math.cos(stick.rotation.z) * stickLen) / 2,
      0,
    );
    group.add(stick, tip);
  }

  // Glowing belly patch.
  if (params.belly) {
    const belly = new THREE.Mesh(g.sphere, accentMat);
    belly.scale.set(w * 0.5, h * 0.28, w * 0.3);
    belly.position.set(0, body.position.y - h * 0.05, -w * 0.78);
    group.add(belly);
  }

  // Ear fins.
  if (params.fins) {
    for (const side of [-1, 1]) {
      const fin = new THREE.Mesh(g.cone, accentMat);
      fin.scale.set(0.1, 0.3, 0.05);
      fin.position.set(side * headR * 1.05, head.position.y + headR * 0.3, 0);
      fin.rotation.z = side * -0.9;
      group.add(fin);
    }
  }

  // Stubby feet.
  const footMat = skin((params.hue + 0.04) % 1);
  for (const side of [-1, 1]) {
    const foot = new THREE.Mesh(g.sphere, footMat);
    foot.scale.set(0.16, 0.09, 0.22);
    foot.position.set(side * w * 0.45, 0.08, 0);
    group.add(foot);
  }

  return group;
}
