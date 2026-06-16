/**
 * Synthesized ambience — no audio files, the whole soundscape is WebAudio
 * nodes (asset budget: 0 bytes). Market murmur (filtered noise + wandering
 * voice-ish blips), lantern creaks, a noodle-stall sizzle that gets louder as
 * you approach (positional where cheap), a paid-door chime, a prize sparkle,
 * and a chat blip. Starts on the first user gesture (autoplay policy).
 */

export class BazaarAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sizzle: GainNode | null = null;
  private muted = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  /** Idempotent; call from a user-gesture handler. */
  start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    this.master.connect(ctx.destination);

    this.murmur();
    this.scheduleVoices();
    this.scheduleCreaks();
    this.sizzleLoop();
  }

  get started(): boolean {
    return this.ctx !== null;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.6, this.ctx.currentTime, 0.1);
    }
    return this.muted;
  }

  /** 4s looped noise buffer, lowpassed twice = crowd rumble. */
  private noiseBuffer(): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.02 * white) / 1.02;
      data[i] = brown * 3.2;
    }
    return buf;
  }

  private murmur(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    const gain = ctx.createGain();
    gain.gain.value = 0.16;
    // Slow swell so the crowd breathes.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain).connect(gain.gain);
    src.connect(lp).connect(gain).connect(this.master!);
    src.start();
    lfo.start();
  }

  /** Far-off voice-ish blips: short bandpassed saw chirps, random pan. */
  private scheduleVoices(): void {
    const ctx = this.ctx!;
    const tick = () => {
      if (!this.ctx) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      const f = 140 + Math.random() * 320;
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.linearRampToValueAtTime(f * (0.8 + Math.random() * 0.5), t + 0.18);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 500 + Math.random() * 600;
      bp.Q.value = 4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.025 + Math.random() * 0.02, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0004, t + 0.22 + Math.random() * 0.2);
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.random() * 1.6 - 0.8;
      osc.connect(bp).connect(g).connect(pan).connect(this.master!);
      osc.start(t);
      osc.stop(t + 0.5);
      this.timers.push(setTimeout(tick, 700 + Math.random() * 2600));
    };
    this.timers.push(setTimeout(tick, 1200));
  }

  /** Lantern/rope creaks: slow descending squeak, very quiet. */
  private scheduleCreaks(): void {
    const ctx = this.ctx!;
    const tick = () => {
      if (!this.ctx) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(90 + Math.random() * 40, t);
      osc.frequency.linearRampToValueAtTime(70, t + 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.02, t + 0.1);
      g.gain.linearRampToValueAtTime(0, t + 0.6);
      osc.connect(g).connect(this.master!);
      osc.start(t);
      osc.stop(t + 0.7);
      this.timers.push(setTimeout(tick, 6000 + Math.random() * 9000));
    };
    this.timers.push(setTimeout(tick, 4000));
  }

  /** Wok sizzle bound to distance from the noodle stall (set via update()). */
  private sizzleLoop(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    src.buffer = buf;
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 3200;
    this.sizzle = ctx.createGain();
    this.sizzle.gain.value = 0;
    src.connect(hp).connect(this.sizzle).connect(this.master!);
    src.start();
  }

  /** Per-frame: positional gain for the sizzle. */
  update(self: { x: number; z: number } | null, noodle: { x: number; z: number } | null): void {
    if (!this.ctx || !this.sizzle) return;
    let target = 0;
    if (self && noodle) {
      const d = Math.hypot(self.x - noodle.x, self.z - noodle.z);
      target = d < 11 ? 0.07 * (1 - d / 11) ** 2 : 0;
    }
    this.sizzle.gain.setTargetAtTime(target, this.ctx.currentTime, 0.25);
  }

  /** Two-strike temple bell — a court door opened for you. */
  chime(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const strike = (t: number, f: number, gain: number) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = f;
      const overtone = ctx.createOscillator();
      overtone.frequency.value = f * 2.76;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 1.6);
      const og = ctx.createGain();
      og.gain.setValueAtTime(gain * 0.3, t);
      og.gain.exponentialRampToValueAtTime(0.0006, t + 0.8);
      osc.connect(g).connect(this.master!);
      overtone.connect(og).connect(this.master!);
      osc.start(t);
      osc.stop(t + 1.8);
      overtone.start(t);
      overtone.stop(t + 1.0);
    };
    strike(ctx.currentTime, 524, 0.12);
    strike(ctx.currentTime + 0.22, 660, 0.1);
  }

  /** Ascending pentatonic glitter — a chest opened. */
  sparkle(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const notes = [660, 742, 880, 990, 1320];
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.09;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.07, t);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.5);
      osc.connect(g).connect(this.master!);
      osc.start(t);
      osc.stop(t + 0.6);
    });
  }

  /** Tiny chat blip. */
  blip(): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(1175, t + 0.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.035, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.16);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}
