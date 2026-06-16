/**
 * Websocket client: session, intents out, snapshots in. Payments never ride
 * this socket — see payer.ts.
 */

import type {
  ClientMsg,
  GameConfig,
  ServerMsg,
  World,
} from "../../protocol/protocol.ts";

export interface NetHandlers {
  onHello(session: string, world: World, config: GameConfig): void;
  onState(msg: Extract<ServerMsg, { type: "state" }>): void;
  onEntitlement(gate: string): void;
  onPrize(chest: string, token: string): void;
  onChat(from: string, name: string, text: string): void;
  /** A riddle booth sent its current prompt (Phase 1b). */
  onRiddle(booth: string, prompt: string): void;
  /** A bell rang nearby (Phase 1b): `from` rang it, `hit` = they timed it. */
  onBellRing(booth: string, from: string, hit: boolean): void;
  onError(code: string, message: string): void;
  onClose(): void;
}

export class Net {
  private ws: WebSocket | null = null;
  session: string | null = null;

  constructor(private readonly handlers: NetHandlers) {}

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      switch (msg.type) {
        case "hello":
          this.session = msg.session;
          this.handlers.onHello(msg.session, msg.world, msg.config);
          break;
        case "state":
          this.handlers.onState(msg);
          break;
        case "entitlement":
          this.handlers.onEntitlement(msg.gate);
          break;
        case "prize":
          this.handlers.onPrize(msg.chest, msg.token);
          break;
        case "chat":
          this.handlers.onChat(msg.from, msg.name, msg.text);
          break;
        case "riddle":
          this.handlers.onRiddle(msg.booth, msg.prompt);
          break;
        case "bellring":
          this.handlers.onBellRing(msg.booth, msg.from, msg.hit);
          break;
        case "error":
          this.handlers.onError(msg.code, msg.message);
          break;
      }
    };
    ws.onclose = () => {
      this.session = null;
      this.handlers.onClose();
    };
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  join(name: string): void {
    this.send({ type: "join", name });
  }

  move(x: number, z: number): void {
    this.send({ type: "move", x, z });
  }

  jump(): void {
    this.send({ type: "jump" });
  }

  chat(text: string): void {
    this.send({ type: "chat", text });
  }

  interact(target: string): void {
    this.send({ type: "interact", target });
  }

  answer(booth: string, text: string): void {
    this.send({ type: "answer", booth, text });
  }
}
