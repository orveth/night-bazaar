/**
 * DOM HUD: wallet panel (import a cashuB, balance), status line, contextual
 * action prompt, prize modal, chat log + input (Phase 1a), FPS corner.
 * Plain DOM, no framework.
 */

export interface HudCallbacks {
  onImport(token: string): void;
  onSetName(name: string): void;
  onChat(text: string): void;
}

export class Hud {
  private balanceEl = el("div", "hud-balance");
  private statusEl = el("div", "hud-status");
  private promptEl = el("div", "hud-prompt");
  private modeEl = el("div", "hud-mode");
  private walletPanel = el("div", "hud-wallet");
  private prizeModal = el("div", "hud-prize");
  private chatPanel = el("div", "hud-chat");
  private chatLog = el("div", "hud-chat-log");
  private chatInput = document.createElement("input");
  private fpsEl = el("div", "hud-fps");

  constructor(root: HTMLElement, cb: HudCallbacks) {
    const top = el("div", "hud-top");
    top.append(this.balanceEl, this.modeEl);

    const nameInput = document.createElement("input");
    nameInput.placeholder = "name…";
    nameInput.maxLength = 24;
    nameInput.id = "name-input";
    nameInput.onchange = () => cb.onSetName(nameInput.value);

    const tokenBox = document.createElement("textarea");
    tokenBox.placeholder = "paste a cashuB… token to fund your wallet";
    tokenBox.id = "token-import";
    const importBtn = document.createElement("button");
    importBtn.textContent = "Import token";
    importBtn.id = "import-btn";
    importBtn.onclick = () => {
      const t = tokenBox.value.trim();
      if (t) cb.onImport(t);
      tokenBox.value = "";
    };
    this.walletPanel.append(nameInput, tokenBox, importBtn);

    this.chatInput.placeholder = "say something… (Enter)";
    this.chatInput.maxLength = 200;
    this.chatInput.id = "chat-input";
    this.chatInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        const text = this.chatInput.value.trim();
        if (text) cb.onChat(text);
        this.chatInput.value = "";
        this.chatInput.blur();
        e.stopPropagation();
      } else if (e.key === "Escape") {
        this.chatInput.blur();
        e.stopPropagation();
      }
    };
    this.chatPanel.append(this.chatLog, this.chatInput);

    this.promptEl.style.display = "none";
    this.prizeModal.style.display = "none";
    root.append(
      top,
      this.walletPanel,
      this.statusEl,
      this.promptEl,
      this.prizeModal,
      this.chatPanel,
      this.fpsEl,
    );
  }

  focusChat(): void {
    this.chatInput.focus();
  }

  /** Ghosts read but cannot speak — reflect it in the input affordance. */
  setKind(kind: "ghost" | "body"): void {
    this.chatInput.disabled = kind === "ghost";
    this.chatInput.placeholder =
      kind === "ghost" ? "ghosts can read… buy a body to speak" : "say something… (Enter)";
  }

  chatLine(name: string, text: string): void {
    const line = el("div", "hud-chat-line");
    const who = el("span", "hud-chat-name");
    who.textContent = name;
    const what = el("span", "hud-chat-text");
    what.textContent = ` ${text}`;
    line.append(who, what);
    this.chatLog.append(line);
    while (this.chatLog.children.length > 6) this.chatLog.firstChild?.remove();
  }

  fps(text: string): void {
    this.fpsEl.textContent = text;
  }

  setBalance(balance: number, unit: string): void {
    this.balanceEl.textContent = `◉ ${balance} ${unit}`;
    this.balanceEl.dataset.balance = String(balance);
  }

  setMode(mode: string): void {
    this.modeEl.textContent = mode === "mock" ? "MOCK MODE — gates are free" : "live";
    this.modeEl.classList.toggle("mock", mode === "mock");
  }

  status(text: string): void {
    this.statusEl.textContent = text;
  }

  /** Contextual prompt ("[E] pay 50 — Jade Court"); empty hides it. */
  prompt(text: string | null): void {
    if (text) {
      this.promptEl.textContent = text;
      this.promptEl.style.display = "block";
    } else {
      this.promptEl.style.display = "none";
    }
  }

  /** Show the prize token with a copy button. */
  showPrize(token: string): void {
    this.prizeModal.replaceChildren();
    const h = el("div", "prize-title");
    h.textContent = "★ The chest opens — real ecash inside ★";
    const pre = document.createElement("textarea");
    pre.value = token;
    pre.readOnly = true;
    pre.id = "prize-token";
    const copy = document.createElement("button");
    copy.textContent = "Copy token";
    copy.onclick = () => {
      void navigator.clipboard?.writeText(token);
      copy.textContent = "Copied";
    };
    const close = document.createElement("button");
    close.textContent = "Close";
    close.onclick = () => (this.prizeModal.style.display = "none");
    this.prizeModal.append(h, pre, copy, close);
    this.prizeModal.style.display = "block";
  }
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}
