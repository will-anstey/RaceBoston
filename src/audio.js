// Synthesised sound: engine with simulated gears, tyre squeal, wind, crashes,
// splash, horn and UI chimes. No audio files needed.

import { clamp } from './util.js';

const GEARS = [0, 8, 16, 25, 35, 46];

export class AudioFX {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.volume = 0.8;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    this.master.connect(comp).connect(ctx.destination);

    const len = ctx.sampleRate * 2;
    const nb = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = nb;
    const noise = () => { const n = ctx.createBufferSource(); n.buffer = nb; n.loop = true; n.start(); return n; };

    // Engine: saw + square sub, soft clip, low-pass.
    this.eGain = ctx.createGain(); this.eGain.gain.value = 0;
    this.eFilter = ctx.createBiquadFilter(); this.eFilter.type = 'lowpass'; this.eFilter.frequency.value = 600; this.eFilter.Q.value = 2;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = (i / 255) * 2 - 1; curve[i] = Math.tanh(x * 2.2); }
    shaper.curve = curve;
    this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator(); this.o2.type = 'square';
    this.o3 = ctx.createOscillator(); this.o3.type = 'sawtooth';
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.3;
    const g3 = ctx.createGain(); g3.gain.value = 0.18;
    this.o1.connect(g1).connect(shaper);
    this.o2.connect(g2).connect(shaper);
    this.o3.connect(g3).connect(shaper);
    shaper.connect(this.eFilter).connect(this.eGain).connect(this.master);
    this.o1.start(); this.o2.start(); this.o3.start();

    // Tyre squeal.
    this.sGain = ctx.createGain(); this.sGain.gain.value = 0;
    const sf = ctx.createBiquadFilter(); sf.type = 'bandpass'; sf.frequency.value = 1700; sf.Q.value = 3.5;
    noise().connect(sf).connect(this.sGain).connect(this.master);
    // Wind / road noise.
    this.wGain = ctx.createGain(); this.wGain.gain.value = 0;
    this.wFilter = ctx.createBiquadFilter(); this.wFilter.type = 'lowpass'; this.wFilter.frequency.value = 400;
    noise().connect(this.wFilter).connect(this.wGain).connect(this.master);
    // Horn.
    this.hGain = ctx.createGain(); this.hGain.gain.value = 0;
    const hf = ctx.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 1800;
    for (const f of [392, 494]) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f; o.connect(hf); o.start(); }
    hf.connect(this.hGain).connect(this.master);
    this.rpm = 900;
    this.gear = 1;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  // car: Vehicle, inp: input state, active: whether driving is live.
  update(car, inp, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = Math.abs(car.vF);
    let gear = 1;
    for (let i = 1; i < GEARS.length; i++) if (v > GEARS[i]) gear = i + 1;
    if (car.vF < -0.5) gear = 1;
    const lo = GEARS[gear - 1], hi = GEARS[gear] ?? 62;
    const frac = clamp((v - lo) / (hi - lo), 0, 1);
    const throttle = active ? inp.throttle : 0;
    let rpm = 1000 + frac * 5200 + (gear === 1 ? 0 : 800 * (1 - frac));
    if (v < 1) rpm = 900 + throttle * 2200;
    if (car.onGrass && throttle && v < 8) rpm += 1500;
    this.rpm += (rpm - this.rpm) * 0.25;
    this.gear = gear;
    const f = (this.rpm / 60) * 2;
    this.o1.frequency.setTargetAtTime(f, t, 0.03);
    this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    this.o3.frequency.setTargetAtTime(f * 1.01 * 2, t, 0.03);
    this.eFilter.frequency.setTargetAtTime(300 + this.rpm * 0.35 + throttle * 900, t, 0.05);
    this.eGain.gain.setTargetAtTime(active ? 0.09 + throttle * 0.09 + (car.boosting ? 0.05 : 0) : 0.0, t, 0.08);
    const sk = active ? clamp(car.skid, 0, 1) * clamp(car.speed / 8, 0, 1) : 0;
    this.sGain.gain.setTargetAtTime(sk * 0.16, t, 0.05);
    this.wGain.gain.setTargetAtTime(active ? clamp(car.speed / 60, 0, 1) ** 2 * 0.22 : 0, t, 0.2);
    this.wFilter.frequency.setTargetAtTime(250 + car.speed * 18, t, 0.2);
    this.hGain.gain.setTargetAtTime(active && inp.horn ? 0.12 : 0, t, 0.02);
  }

  _burst(dur, freq, gain, type = 'lowpass', q = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(f).connect(g).connect(this.master);
    n.start(t, Math.random());
    n.stop(t + dur + 0.05);
    return f;
  }

  crash(intensity) {
    const i = clamp(intensity, 0, 1);
    this._burst(0.25 + i * 0.5, 500 + i * 900, 0.25 + i * 0.6);
    if (i > 0.4) this._burst(0.12, 3500, 0.12 * i, 'bandpass', 2);
  }

  splash() {
    const f = this._burst(1.4, 1200, 0.5, 'bandpass', 0.8);
    if (f) f.frequency.exponentialRampToValueAtTime(250, this.ctx.currentTime + 1.2);
  }

  tone(freqs, dur = 0.12, type = 'sine', gain = 0.18, gap = 0.09) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    freqs.forEach((fr, k) => {
      const t = ctx.currentTime + k * gap;
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = fr;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + dur + 0.02);
    });
  }

  checkpoint() { this.tone([880, 1320], 0.18, 'triangle', 0.2); }
  finish() { this.tone([523, 659, 784, 1047], 0.35, 'triangle', 0.22, 0.12); }
  beep(final) { this.tone([final ? 1046 : 523], final ? 0.5 : 0.22, 'square', 0.08); }
  cash() { this.tone([1568, 2093, 2637], 0.12, 'square', 0.06, 0.06); }
  fail() { this.tone([392, 330, 262], 0.3, 'sawtooth', 0.08, 0.16); }
  discover() { this.tone([659, 988, 1319], 0.25, 'sine', 0.16, 0.1); }
}
