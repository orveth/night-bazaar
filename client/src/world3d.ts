/**
 * Three.js scene, Phase 1a: the night-market look. WebGPURenderer with its
 * automatic WebGL2 fallback (`?webgl=1` forces the fallback for A/B), and a
 * post chain that blooms ONLY the emissive MRT channel — lanterns, neon and
 * portals glow, the rest stays inky.
 *
 * Avatars: ghosts are translucent drifting wisps; bodies are procedural
 * aliens seeded by session id (alien.ts). Chat floats as bubbles that fade
 * with distance and time (chatview.ts math).
 *
 * World geometry renders FROM the server's `World` (scenery.ts) so the
 * picture never disagrees with the movement rules.
 */

import * as THREE from "three/webgpu";
import { emissive, mrt, output, pass } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import type { PlayerSnapshot, World } from "../../protocol/protocol.ts";
import { alienParamsFromSeed, buildAlien } from "./alien.ts";
import { BUBBLE_LIFE_MS, bubbleOpacity, wrapBubble } from "./chatview.ts";
import { buildScenery, type Scenery } from "./scenery.ts";
import { bubbleTexture, nameTagTexture } from "./textures.ts";
import { rngFrom } from "./seeded.ts";

interface Bubble {
  sprite: THREE.Sprite;
  bornMs: number;
}

interface AvatarBundle {
  group: THREE.Group;
  /** The wisp or alien — swapped when kind flips. */
  visual: THREE.Group;
  tag: THREE.Sprite;
  target: THREE.Vector3;
  kind: string;
  name: string;
  heading: number;
  phase: number;
  moving: number; // smoothed 0..1
  bubble: Bubble | null;
}

export class Scene3D {
  readonly renderer: InstanceType<typeof THREE.WebGPURenderer>;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly backendName: "webgpu" | "webgl";
  /** null = bloom disabled (?nobloom=1 escape hatch for odd GPUs). */
  private post: InstanceType<typeof THREE.PostProcessing> | null = null;
  private scenery: Scenery;
  private avatars = new Map<string, AvatarBundle>();
  private selfId: string | null = null;
  private timeMs = 0;
  private fpsFrames = 0;
  private fpsT0 = 0;
  fps = 0;
  /** Debug/screenshot camera pin: when set, overrides the chase camera. */
  cine: { pos: [number, number, number]; look: [number, number, number] } | null = null;

  /** Async because WebGPURenderer needs an awaited init() before rendering. */
  static async create(canvas: HTMLCanvasElement, world: World): Promise<Scene3D> {
    const forceWebGL = new URLSearchParams(location.search).has("webgl");
    const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
    await renderer.init();
    return new Scene3D(canvas, world, renderer);
  }

  private constructor(
    _canvas: HTMLCanvasElement,
    world: World,
    renderer: InstanceType<typeof THREE.WebGPURenderer>,
  ) {
    this.renderer = renderer;
    this.backendName = (
      (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend
    )
      ? "webgpu"
      : "webgl";
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;

    this.camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 220);
    this.camera.position.set(0, 8.5, -15);
    this.camera.lookAt(0, 1.8, 4);
    addEventListener("resize", () => {
      renderer.setSize(innerWidth, innerHeight);
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    });

    // Night air: deep indigo, exponential fog for depth stacking.
    this.scene.background = new THREE.Color(0x0a0712);
    this.scene.fog = new THREE.FogExp2(0x0d0918, 0.018);
    this.scene.add(new THREE.HemisphereLight(0x4a3f78, 0x1a1426, 1.35));

    // Capped light pools: 5 warm street lanterns + one accent per court.
    const lamp = (x: number, z: number, color: number, intensity: number, dist: number) => {
      const l = new THREE.PointLight(color, intensity, dist, 1.8);
      l.position.set(x, 3.3, z);
      this.scene.add(l);
    };
    lamp(-22, -2, 0xff9540, 58, 20);
    lamp(-11, 3, 0xff7a30, 50, 19);
    lamp(0, -3, 0xffa050, 58, 20);
    lamp(11, 3, 0xff7a30, 50, 19);
    lamp(22, -2, 0xff9540, 58, 20);
    for (const court of world.courts) {
      const cx = (court.bounds.minX + court.bounds.maxX) / 2;
      const cz = (court.bounds.minZ + court.bounds.maxZ) / 2;
      lamp(cx, cz, court.id === "jade" ? 0x2bff96 : 0xff2e44, 40, 20);
    }

    this.scenery = buildScenery(world);
    this.scene.add(this.scenery.group);

    // Post chain: bloom fed by the emissive MRT target only.
    if (!new URLSearchParams(location.search).has("nobloom")) {
      const scenePass = pass(this.scene, this.camera);
      scenePass.setMRT(mrt({ output, emissive }));
      const outColor = scenePass.getTextureNode();
      const emissivePass = scenePass.getTextureNode("emissive");
      const bloomPass = bloom(emissivePass, 0.55, 0.35, 0.0);
      this.post = new THREE.PostProcessing(renderer);
      this.post.outputNode = outColor.add(bloomPass);
    }
    (window as unknown as Record<string, unknown>).__scene3d = this; // debug handle
  }

  get noodlePos(): { x: number; z: number } | null {
    return this.scenery.noodlePos;
  }

  /** Tint a court's walls + drop its portal once this client is entitled. */
  markCourtOpen(courtId: string): void {
    this.scenery.markCourtOpen(courtId);
  }

  setSelf(id: string): void {
    this.selfId = id;
  }

  /** Reconcile avatars + chest states from a snapshot; positions lerp in tick(). */
  applySnapshot(
    players: PlayerSnapshot[],
    chests: { id: string; claimed: boolean }[],
  ): void {
    const seen = new Set<string>();
    for (const p of players) {
      seen.add(p.id);
      this.upsert(p);
    }
    for (const [id, bundle] of this.avatars) {
      if (!seen.has(id) && !id.startsWith("fake:")) {
        this.dropAvatar(id, bundle);
      }
    }
    for (const c of chests) {
      this.scenery.setChestClaimed(c.id, c.claimed);
    }
  }

  /** Dev dressing (?crowd=N): client-side wanderers, never swept by snapshots. */
  applyFake(players: PlayerSnapshot[]): void {
    for (const p of players) this.upsert(p);
  }

  private dropAvatar(id: string, bundle: AvatarBundle): void {
    this.scene.remove(bundle.group);
    this.avatars.delete(id);
  }

  private upsert(p: PlayerSnapshot): void {
    let bundle = this.avatars.get(p.id);
    if (!bundle) {
      bundle = this.makeAvatar(p);
      this.avatars.set(p.id, bundle);
    }
    bundle.target.set(p.x, p.y ?? 0, p.z);
    if (bundle.kind !== p.kind || bundle.name !== p.name) {
      this.styleAvatar(bundle, p);
    }
    // Snap, don't glide, across respawn-scale jumps (ghost -> body teleport).
    if (bundle.group.position.distanceTo(bundle.target) > 8) {
      bundle.group.position.copy(bundle.target);
    }
  }

  private makeAvatar(p: PlayerSnapshot): AvatarBundle {
    const group = new THREE.Group();
    group.position.set(p.x, p.y ?? 0, p.z);
    this.scene.add(group);
    const bundle: AvatarBundle = {
      group,
      visual: new THREE.Group(),
      tag: new THREE.Sprite(),
      target: new THREE.Vector3(p.x, p.y ?? 0, p.z),
      kind: "",
      name: "",
      heading: 0,
      phase: rngFrom(p.id)() * Math.PI * 2,
      moving: 0,
      bubble: null,
    };
    group.add(bundle.visual, bundle.tag);
    this.styleAvatar(bundle, p);
    return bundle;
  }

  private styleAvatar(bundle: AvatarBundle, p: PlayerSnapshot): void {
    const kindChanged = bundle.kind !== p.kind;
    const isSelf = p.id === this.selfId;
    if (kindChanged) {
      bundle.kind = p.kind;
      bundle.group.remove(bundle.visual);
      bundle.visual = p.kind === "ghost" ? makeWisp(p.id, isSelf) : buildAlien(alienParamsFromSeed(p.id));
      bundle.group.add(bundle.visual);
    }
    if (bundle.name !== p.name || kindChanged) {
      bundle.name = p.name;
      bundle.group.remove(bundle.tag);
      const accent = isSelf ? "#7dffa8" : p.kind === "ghost" ? "#8fa8e8" : "#ffb152";
      const { tex, w } = nameTagTexture(p.name, accent);
      const mat = new THREE.SpriteMaterial({
        map: tex,
        depthTest: false,
        transparent: true,
        opacity: p.kind === "ghost" ? 0.72 : 0.95,
      });
      bundle.tag = new THREE.Sprite(mat);
      bundle.tag.scale.set(w / 52, 44 / 52, 1);
      bundle.tag.position.y = 2.55;
      bundle.group.add(bundle.tag);
    }
  }

  /** Float a chat bubble over a player (replaces any current one). */
  showChat(from: string, text: string): void {
    const bundle = this.avatars.get(from);
    if (!bundle) return;
    if (bundle.bubble) {
      bundle.group.remove(bundle.bubble.sprite);
      disposeSprite(bundle.bubble.sprite);
    }
    const { tex, w, h } = bubbleTexture(wrapBubble(text));
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    const scale = 1 / 46;
    sprite.scale.set(w * scale, h * scale, 1);
    sprite.position.y = 3.15 + (h * scale) / 2;
    bundle.group.add(sprite);
    bundle.bubble = { sprite, bornMs: this.timeMs };
  }

  /** Per-frame: smooth everyone toward their snapshot target, follow self. */
  tick(dtMs: number): void {
    this.timeMs += dtMs;
    const t = this.timeMs / 1000;
    const alpha = Math.min(1, dtMs / 120); // ~120ms smoothing window
    const selfPos = this.selfPosition();

    for (const bundle of this.avatars.values()) {
      const before = bundle.group.position.clone();
      bundle.group.position.lerp(bundle.target, alpha);
      const moved = bundle.group.position.distanceTo(before);
      const speed = moved / Math.max(1e-6, dtMs / 1000);
      bundle.moving += ((speed > 0.6 ? 1 : 0) - bundle.moving) * Math.min(1, dtMs / 200);

      if (bundle.kind === "ghost") {
        // Wisps drift: hover bob + slow spin.
        bundle.visual.position.y = 0.3 + Math.sin(t * 1.6 + bundle.phase) * 0.12;
        bundle.visual.rotation.y += dtMs / 4200;
      } else {
        // Bodies face their motion + walk-bob (visual only; jumps come from
        // the server-authoritative y in the snapshot target).
        const dx = bundle.target.x - bundle.group.position.x;
        const dz = bundle.target.z - bundle.group.position.z;
        if (dx * dx + dz * dz > 0.0004) {
          const want = Math.atan2(dx, dz) + Math.PI;
          let diff = want - bundle.heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          bundle.heading += diff * Math.min(1, dtMs / 140);
          bundle.visual.rotation.y = bundle.heading;
        }
        bundle.visual.position.y =
          bundle.moving * Math.abs(Math.sin(t * 8 + bundle.phase)) * 0.06;
      }

      if (bundle.bubble) {
        const age = this.timeMs - bundle.bubble.bornMs;
        const dist = selfPos
          ? Math.hypot(bundle.group.position.x - selfPos.x, bundle.group.position.z - selfPos.z)
          : 0;
        const opacity = bubbleOpacity(age, dist);
        (bundle.bubble.sprite.material as THREE.SpriteMaterial).opacity = opacity;
        bundle.bubble.sprite.visible = opacity > 0.01;
        if (age > BUBBLE_LIFE_MS) {
          bundle.group.remove(bundle.bubble.sprite);
          disposeSprite(bundle.bubble.sprite);
          bundle.bubble = null;
        }
      }
    }

    this.scenery.update(this.timeMs, dtMs);

    // Camera: chase the self avatar low through the alley; idle ghosts-eye
    // dolly before a session exists. `cine` pins it for screenshots.
    if (this.cine) {
      this.camera.position.set(...this.cine.pos);
      this.camera.lookAt(...this.cine.look);
    } else if (this.selfId && this.avatars.has(this.selfId)) {
      const p = this.avatars.get(this.selfId)!.group.position;
      this.camera.position.lerp(
        new THREE.Vector3(p.x, 7.4, p.z - 11.5),
        Math.min(1, dtMs / 250),
      );
      this.camera.lookAt(p.x, 1.6, p.z + 2.5);
    } else {
      this.camera.position.lerp(
        new THREE.Vector3(Math.sin(t * 0.08) * 6, 8.5, -15),
        Math.min(1, dtMs / 600),
      );
      this.camera.lookAt(Math.sin(t * 0.08) * 6, 1.8, 4);
    }

    if (this.post) {
      this.post.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    this.fpsFrames++;
    if (this.timeMs - this.fpsT0 > 1000) {
      this.fps = Math.round((this.fpsFrames * 1000) / (this.timeMs - this.fpsT0));
      this.fpsFrames = 0;
      this.fpsT0 = this.timeMs;
      this.publishStats();
    }
  }

  private publishStats(): void {
    const info = this.renderer.info as unknown as {
      render?: { drawCalls?: number; calls?: number; triangles?: number };
    };
    (window as unknown as Record<string, unknown>).__bazaar = {
      backend: this.backendName,
      fps: this.fps,
      drawCalls: info.render?.drawCalls ?? info.render?.calls ?? -1,
      triangles: info.render?.triangles ?? -1,
      avatars: this.avatars.size,
    };
  }

  selfPosition(): { x: number; z: number } | null {
    if (!this.selfId) return null;
    const self = this.avatars.get(this.selfId);
    return self ? { x: self.group.position.x, z: self.group.position.z } : null;
  }
}

/* --------------------------------- wisp ----------------------------------- */

/** Ghost = a translucent teardrop wisp with a faint inner core. */
function makeWisp(seed: string, isSelf: boolean): THREE.Group {
  const rng = rngFrom(seed);
  const pts: THREE.Vector2[] = [];
  const H = 1.5;
  for (let i = 0; i <= 10; i++) {
    const v = i / 10;
    const r = Math.sin(Math.min(1, v * 1.15) * Math.PI) ** 0.8 * 0.34 * (1 - v * 0.3);
    pts.push(new THREE.Vector2(Math.max(0.001, r), v * H));
  }
  const geo = new THREE.LatheGeometry(pts, 10);
  const hue = isSelf ? 0.36 : 0.6 + rng() * 0.08;
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(hue, 0.5, 0.7),
    emissive: new THREE.Color().setHSL(hue, 0.7, 0.5),
    emissiveIntensity: 0.5,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    roughness: 0.4,
  });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geo, mat));
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 8, 6),
    new THREE.MeshStandardMaterial({
      color: 0x0c0a14,
      emissive: new THREE.Color().setHSL(hue, 0.8, 0.65),
      emissiveIntensity: 1.6,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }),
  );
  core.position.y = 0.95;
  group.add(core);
  return group;
}

function disposeSprite(sprite: THREE.Sprite): void {
  const mat = sprite.material as THREE.SpriteMaterial;
  mat.map?.dispose();
  mat.dispose();
}
