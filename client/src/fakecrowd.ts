/**
 * Dev-only crowd dressing: `?crowd=N` spawns N client-side wandering aliens
 * (ids `fake:n`) so screenshots and FPS measurements exercise a populated
 * street without N real connections. NEVER part of the protocol — the server
 * knows nothing about these; they are ignored by snapshot reconciliation.
 */

import type { PlayerSnapshot, World } from "../../protocol/protocol.ts";
import type { Scene3D } from "./world3d.ts";
import { mulberry32, pick, rfloat } from "./seeded.ts";

const NAMES = [
  "zix-popseller",
  "old-mara",
  "three-eyes",
  "wek",
  "lantern-jo",
  "broth-uncle",
  "neon-pip",
  "gleep",
  "salt-witch",
  "kepple",
];

const LINES = [
  "fresh skewers, two pops!",
  "the rooftop hides something…",
  "best broth on the street",
  "ghosts drink free (nothing)",
  "jade court paid off for me once",
  "mind the steam",
  "pops or walk on",
  "saw a wisp slip behind the crates",
];

interface FakePlayer {
  snap: PlayerSnapshot;
  vx: number;
  vz: number;
  nextTurn: number;
  nextChat: number;
}

export class FakeCrowd {
  private fakes: FakePlayer[] = [];
  private rng = mulberry32(0xba2aa7);

  constructor(
    private scene: Scene3D,
    private world: World,
    count: number,
  ) {
    const rng = this.rng;
    for (let i = 0; i < count; i++) {
      this.fakes.push({
        snap: {
          id: `fake:${i}`,
          name: NAMES[i % NAMES.length]!,
          kind: i % 4 === 3 ? "ghost" : "body",
          x: rfloat(rng, -24, 24),
          y: 0,
          z: rfloat(rng, -6, 6),
        },
        vx: 0,
        vz: 0,
        nextTurn: 0,
        nextChat: 4000 + i * 3500,
      });
    }
  }

  update(tMs: number, dtMs: number): void {
    const dt = dtMs / 1000;
    for (const f of this.fakes) {
      if (tMs > f.nextTurn) {
        f.nextTurn = tMs + rfloat(this.rng, 1500, 5000);
        const speed = rfloat(this.rng, 0, 2.6);
        const a = rfloat(this.rng, 0, Math.PI * 2);
        f.vx = Math.sin(a) * speed;
        f.vz = Math.cos(a) * speed;
      }
      f.snap.x = Math.max(-28, Math.min(28, f.snap.x + f.vx * dt));
      f.snap.z = Math.max(-6.5, Math.min(7, f.snap.z + f.vz * dt));
      if (tMs > f.nextChat && f.snap.kind === "body") {
        f.nextChat = tMs + rfloat(this.rng, 9000, 22000);
        this.scene.showChat(f.snap.id, pick(this.rng, LINES));
      }
    }
    this.scene.applyFake(this.fakes.map((f) => f.snap));
  }
}
