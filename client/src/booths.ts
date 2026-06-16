/**
 * Booth game UIs (Phase 1b), plain DOM/canvas overlays in the HUD layer:
 *   - riddle modal: a prompt + a text input (free; the server judges).
 *   - gacha pull: a short shrine-shake animation, then a fortune line and a
 *     win sparkle or a soft "not this time".
 *   - bell pendulum: a canvas overlay swinging from the server's seed/period;
 *     [E] rings it, the server judges the timing by ITS clock.
 *
 * These render RESULTS the server already decided; the only "logic" here is the
 * pendulum's *visual* sweep (cosmetic; authority is the server clock). No
 * payment logic lives here; paid plays go through payer.ts in main.ts.
 */

import type { BellPlay, GachaResult } from "../../protocol/protocol.ts";

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

export interface BoothCallbacks {
  /** Submit a riddle guess (free). */
  onAnswer(booth: string, text: string): void;
  /** The player rang the bell ([E]); POST the press. */
  onBellPress(): void;
}

export class BoothUI {
  /** The riddle modal: prompt + input. */
  private riddleModal = el("div", "hud-riddle");
  private riddlePrompt = el("div", "riddle-prompt");
  private riddleInput = document.createElement("input");
  private riddleFlavor = el("div", "riddle-flavor");
  private riddleBooth: string | null = null;

  /** The gacha overlay: a little shrine card + fortune. */
  private gachaModal = el("div", "hud-gacha");

  /** The bell overlay: a canvas pendulum + a press hint. */
  private bellModal = el("div", "hud-bell");
  private bellCanvas = document.createElement("canvas");
  private bellHint = el("div", "bell-hint");
  private bell: {
    booth: string;
    seed: number;
    periodMs: number;
    toleranceMs: number;
    /** performance.now() at the client's render-start (visual phase only). */
    t0: number;
    expiresAt: number;
    pressed: boolean;
  } | null = null;

  constructor(root: HTMLElement, cb: BoothCallbacks) {
    // Riddle modal.
    this.riddleModal.style.display = "none";
    const rTitle = el("div", "riddle-title");
    rTitle.textContent = "✦ The Riddle Lantern ✦";
    this.riddleInput.placeholder = "your answer… (Enter)";
    this.riddleInput.id = "riddle-input";
    this.riddleInput.maxLength = 64;
    this.riddleInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        const text = this.riddleInput.value.trim();
        if (text && this.riddleBooth) cb.onAnswer(this.riddleBooth, text);
        this.riddleInput.value = "";
        e.stopPropagation();
      } else if (e.key === "Escape") {
        this.closeRiddle();
        e.stopPropagation();
      } else {
        e.stopPropagation(); // typing must not drive the avatar
      }
    };
    const rClose = document.createElement("button");
    rClose.textContent = "Walk away";
    rClose.id = "riddle-close";
    rClose.onclick = () => this.closeRiddle();
    this.riddleModal.append(rTitle, this.riddlePrompt, this.riddleInput, this.riddleFlavor, rClose);

    // Gacha overlay.
    this.gachaModal.style.display = "none";

    // Bell overlay.
    this.bellModal.style.display = "none";
    this.bellCanvas.width = 280;
    this.bellCanvas.height = 200;
    this.bellCanvas.id = "bell-canvas";
    const bTitle = el("div", "bell-title");
    bTitle.textContent = "🔔 The Timing Bell 🔔";
    this.bellHint.textContent = "press [E] as the bob crosses the center";
    this.bellModal.append(bTitle, this.bellCanvas, this.bellHint);

    root.append(this.riddleModal, this.gachaModal, this.bellModal);
  }

  /* ------------------------------- riddle -------------------------------- */

  /** Open (or refresh) the riddle modal with a server prompt + focus it. */
  showRiddle(booth: string, prompt: string): void {
    this.riddleBooth = booth;
    this.riddlePrompt.textContent = prompt;
    this.riddleFlavor.textContent = "";
    this.riddleModal.style.display = "block";
    this.riddleInput.focus();
  }

  /** Flavor feedback on a wrong guess (modal stays open to retry). */
  riddleWrong(message: string): void {
    if (this.riddleModal.style.display === "none") return;
    this.riddleFlavor.textContent = message;
    this.riddleInput.focus();
  }

  /** Close the riddle modal (won, or walked away). */
  closeRiddle(): void {
    this.riddleModal.style.display = "none";
    this.riddleBooth = null;
    this.riddleInput.blur();
  }

  get riddleOpen(): boolean {
    return this.riddleModal.style.display !== "none";
  }

  /* -------------------------------- gacha -------------------------------- */

  /** Animate a gacha pull result: shrine shake -> fortune + (win sparkle). */
  showGacha(result: GachaResult): void {
    this.gachaModal.replaceChildren();
    const card = el("div", "gacha-card");
    card.classList.add("shake");
    const title = el("div", "gacha-title");
    title.textContent = result.win ? "★ THE SHRINE ANSWERS ★" : "the shrine is quiet";
    const fortune = el("div", "gacha-fortune");
    fortune.textContent = result.fortune;
    const verdict = el("div", result.win ? "gacha-win" : "gacha-lose");
    verdict.textContent = result.win
      ? result.soldOut
        ? "a win! …but the shrine is out of charms (restock pending)"
        : "a charm tumbles out — claim it from your prize"
      : `not this time — ${result.pity}/8 toward the next charm`;
    const close = document.createElement("button");
    close.textContent = "Step back";
    close.id = "gacha-close";
    close.onclick = () => (this.gachaModal.style.display = "none");
    card.append(title, fortune, verdict);
    if (result.win && !result.soldOut) card.append(makeSparkle());
    this.gachaModal.append(card, close);
    this.gachaModal.style.display = "block";
  }

  /* --------------------------------- bell -------------------------------- */

  /** Begin rendering a bell play from the server's handle. */
  startBell(play: BellPlay): void {
    this.bell = {
      booth: play.booth,
      seed: play.seed,
      periodMs: play.periodMs,
      toleranceMs: play.toleranceMs,
      t0: performance.now(),
      expiresAt: performance.now() + play.expiresInMs,
      pressed: false,
    };
    this.bellHint.textContent = "press [E] as the bob crosses the center";
    this.bellModal.style.display = "block";
  }

  get bellActive(): boolean {
    return this.bell !== null && !this.bell.pressed;
  }

  /** Mark the bell as pressed (server is judging); keep the overlay a beat. */
  bellPressed(): void {
    if (this.bell) this.bell.pressed = true;
  }

  /** Resolve the press with the server's verdict, then fade the overlay. */
  bellResult(hit: boolean, offsetMs: number, soldOut: boolean): void {
    this.bellHint.textContent = hit
      ? soldOut
        ? `RING! perfect (±${offsetMs}ms) — but the bell is out of charms`
        : `RING! you nailed it (±${offsetMs}ms) — claim your prize`
      : `clang… off by ${offsetMs}ms. The bob was elsewhere.`;
    window.setTimeout(() => this.closeBell(), 1800);
  }

  closeBell(): void {
    this.bell = null;
    this.bellModal.style.display = "none";
  }

  /** Per-frame: sweep the pendulum (visual only) + expire stale plays. */
  tick(): void {
    if (!this.bell) return;
    const now = performance.now();
    if (!this.bell.pressed && now > this.bell.expiresAt) {
      this.bellHint.textContent = "the moment passed — pay to ring again";
      this.bell.pressed = true;
      window.setTimeout(() => this.closeBell(), 1400);
      return;
    }
    this.drawPendulum(now);
  }

  private drawPendulum(now: number): void {
    const ctx = this.bellCanvas.getContext("2d");
    if (!ctx || !this.bell) return;
    const w = this.bellCanvas.width;
    const h = this.bellCanvas.height;
    ctx.clearRect(0, 0, w, h);

    // Phase: the seed offsets the starting angle so each play looks distinct;
    // the server still judges by elapsed wall time, so this is cosmetic.
    const elapsed = now - this.bell.t0;
    const seedPhase = (this.bell.seed % 1000) / 1000; // 0..1
    const theta = Math.sin((elapsed / this.bell.periodMs) * Math.PI * 2 + seedPhase * Math.PI * 2);
    const maxSwing = 0.8; // radians
    const angle = theta * maxSwing;

    const pivotX = w / 2;
    const pivotY = 24;
    const len = 130;
    const bobX = pivotX + Math.sin(angle) * len;
    const bobY = pivotY + Math.cos(angle) * len;

    // Sweet-spot band at the bottom center.
    ctx.strokeStyle = "rgba(125,255,168,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(pivotX, pivotY + len + 14);
    ctx.stroke();

    // Arm.
    ctx.strokeStyle = "#c8b48a";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(bobX, bobY);
    ctx.stroke();

    // Bob: glows green near the center crossing (the hit window cue).
    const nearCenter = Math.abs(Math.sin(angle)) < 0.12;
    ctx.fillStyle = nearCenter ? "#7dffa8" : "#ffb152";
    ctx.beginPath();
    ctx.arc(bobX, bobY, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#3a2c10";
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function makeSparkle(): HTMLElement {
  const s = el("div", "gacha-sparkle");
  s.textContent = "✶ ✦ ✶";
  return s;
}
