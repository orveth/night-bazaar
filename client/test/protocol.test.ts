/**
 * TS side of the shared protocol fixtures: every fixture must conform to the
 * discriminated unions in protocol.ts. (The Rust side round-trips the same
 * file through serde — `server/src/protocol.rs` tests.)
 */

import { describe, expect, test } from "bun:test";
import fixtures from "../../protocol/fixtures/messages.json";
import type { ClientMsg, ServerMsg } from "../../protocol/protocol.ts";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

function checkClient(msg: ClientMsg): void {
  switch (msg.type) {
    case "join":
      expect(isStr(msg.name)).toBe(true);
      return;
    case "move":
      expect(isNum(msg.x) && isNum(msg.z)).toBe(true);
      return;
    case "jump":
      return; // no payload
    case "chat":
      expect(isStr(msg.text)).toBe(true);
      return;
    case "interact":
      expect(isStr(msg.target)).toBe(true);
      return;
    case "answer":
      expect(isStr(msg.booth) && isStr(msg.text)).toBe(true);
      return;
    default:
      throw new Error(`unknown client msg ${(msg as { type: string }).type}`);
  }
}

function checkServer(msg: ServerMsg): void {
  switch (msg.type) {
    case "hello":
      expect(isStr(msg.session)).toBe(true);
      expect(Array.isArray(msg.world.courts)).toBe(true);
      expect(msg.world.courts.length).toBeGreaterThan(0);
      for (const c of msg.world.courts) {
        expect(isNum(c.price) && isStr(c.gate)).toBe(true);
        expect(isNum(c.bounds.minX) && isNum(c.door.x1)).toBe(true);
      }
      for (const chest of msg.world.chests) {
        expect(isStr(chest.id) && isStr(chest.court)).toBe(true);
        expect(isNum(chest.x) && isNum(chest.y) && isNum(chest.z)).toBe(true);
      }
      // Phase 1a: stalls ride the world; footprints are the shared occluders.
      expect(Array.isArray(msg.world.stalls)).toBe(true);
      for (const s of msg.world.stalls) {
        expect(isStr(s.id) && isStr(s.kind)).toBe(true);
        expect(isNum(s.x) && isNum(s.z) && isNum(s.rot)).toBe(true);
        expect(
          isNum(s.footprint.minX) &&
            isNum(s.footprint.maxX) &&
            isNum(s.footprint.minZ) &&
            isNum(s.footprint.maxZ),
        ).toBe(true);
        expect(s.footprint.minX).toBeLessThan(s.footprint.maxX);
        expect(s.footprint.minZ).toBeLessThan(s.footprint.maxZ);
      }
      // Phase 1b: playable booths.
      expect(Array.isArray(msg.world.booths)).toBe(true);
      for (const b of msg.world.booths) {
        expect(isStr(b.id) && isStr(b.kind) && isStr(b.court)).toBe(true);
        expect(isNum(b.x) && isNum(b.z) && isNum(b.price)).toBe(true);
        expect(b.price).toBeGreaterThanOrEqual(0);
      }
      expect(isStr(msg.config.unit) && isStr(msg.config.mintUrl)).toBe(true);
      expect(["live", "mock"]).toContain(msg.config.mode);
      // Multi-unit accept: acceptedUnits, when present, is a list of pop units
      // and MUST include the mint-into unit.
      if (msg.config.acceptedUnits !== undefined) {
        expect(Array.isArray(msg.config.acceptedUnits)).toBe(true);
        for (const u of msg.config.acceptedUnits) expect(isStr(u)).toBe(true);
        expect(msg.config.acceptedUnits).toContain(msg.config.unit);
      }
      return;
    case "state":
      expect(isNum(msg.tick)).toBe(true);
      for (const p of msg.players) {
        expect(["ghost", "body"]).toContain(p.kind);
        expect(isNum(p.x) && isNum(p.y) && isNum(p.z) && isStr(p.name)).toBe(true);
      }
      for (const c of msg.chests) {
        expect(typeof c.claimed).toBe("boolean");
      }
      return;
    case "entitlement":
      expect(isStr(msg.gate)).toBe(true);
      return;
    case "prize":
      expect(isStr(msg.chest) && isStr(msg.token)).toBe(true);
      return;
    case "chat":
      expect(isStr(msg.from) && isStr(msg.name) && isStr(msg.text)).toBe(true);
      expect(msg.text.length).toBeLessThanOrEqual(200);
      return;
    case "riddle":
      expect(isStr(msg.booth) && isStr(msg.prompt)).toBe(true);
      return;
    case "bellring":
      expect(isStr(msg.booth) && isStr(msg.from)).toBe(true);
      expect(typeof msg.hit).toBe("boolean");
      return;
    case "error":
      expect(isStr(msg.code) && isStr(msg.message)).toBe(true);
      return;
    default:
      throw new Error(`unknown server msg ${(msg as { type: string }).type}`);
  }
}

describe("shared protocol fixtures", () => {
  test("every client fixture conforms to ClientMsg", () => {
    const msgs = fixtures.clientMsgs as ClientMsg[];
    expect(msgs.length).toBeGreaterThan(0);
    msgs.forEach(checkClient);
  });

  test("every server fixture conforms to ServerMsg", () => {
    const msgs = fixtures.serverMsgs as unknown as ServerMsg[];
    expect(msgs.length).toBeGreaterThan(0);
    msgs.forEach(checkServer);
  });
});
