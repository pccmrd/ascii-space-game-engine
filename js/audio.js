// audio.js — tiny WebAudio synth for event blips and thruster hum. Safe to construct headless (no-ops).

export class AudioBus {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.thrustOsc = null;
    this.thrustGain = null;
    this.thrustLevel = 0;
  }
  ensure() {
    if (this.ctx || typeof window === 'undefined') return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    } catch (e) { this.ctx = null; }
  }
  resume() { this.ensure(); if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  setEnabled(v) {
    this.enabled = v;
    if (this.master) this.master.gain.value = v ? 0.5 : 0;
  }
  beep(freq = 440, dur = 0.08, type = 'square', vol = 0.12, slideTo = null) {
    if (!this.enabled) return;
    this.ensure();
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }
  noise(dur = 0.25, vol = 0.2, cutoff = 900) {
    if (!this.enabled) return;
    this.ensure();
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0);
  }
  laser() { this.beep(880, 0.09, 'sawtooth', 0.08, 220); }
  mineTick() { this.beep(1400 + Math.random() * 600, 0.03, 'square', 0.04); }
  hit() { this.noise(0.12, 0.14, 1600); }
  explosion() { this.noise(0.55, 0.3, 700); this.beep(90, 0.4, 'sine', 0.22, 34); }
  pickup() { this.beep(660, 0.06, 'square', 0.09, 990); }
  scanDone() { this.beep(520, 0.1, 'sine', 0.1, 1040); this.beep(1040, 0.12, 'sine', 0.07); }
  dock() { this.beep(180, 0.18, 'triangle', 0.16, 90); this.beep(720, 0.1, 'sine', 0.1); }
  error() { this.beep(160, 0.12, 'square', 0.1, 110); }
  jump() { this.beep(300, 0.08, 'sine', 0.06, 420); }
  land() { this.noise(0.15, 0.12, 500); }
  uiOpen() { this.beep(440, 0.05, 'sine', 0.07, 560); }
  credits() { this.beep(880, 0.07, 'square', 0.09, 1320); }
  alarm() { this.beep(520, 0.15, 'square', 0.1, 380); }
  thrust(level) { // continuous hum, level 0..1
    if (!this.enabled) return;
    this.ensure();
    if (!this.ctx) return;
    this.thrustLevel = level;
    if (!this.thrustOsc) {
      this.thrustOsc = this.ctx.createOscillator();
      this.thrustGain = this.ctx.createGain();
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 220;
      this.thrustOsc.type = 'sawtooth';
      this.thrustOsc.frequency.value = 55;
      this.thrustGain.gain.value = 0;
      this.thrustOsc.connect(f); f.connect(this.thrustGain); this.thrustGain.connect(this.master);
      this.thrustOsc.start();
    }
    const t = this.ctx.currentTime;
    this.thrustGain.gain.setTargetAtTime(level * 0.05, t, 0.08);
    this.thrustOsc.frequency.setTargetAtTime(50 + level * 60, t, 0.1);
  }
  stopThrust() { this.thrust(0); }
}
