// Synthesised sound: engine with simulated gears, tyre squeal, wind, crashes,
// splash, horn and UI chimes. No audio files needed.

import { clamp } from './util.js';

// Upshift speeds (m/s) for a 7-speed box that tops out around 200 mph.
const GEARS = [0, 9, 18, 28, 40, 54, 70];
const TOP = 92;

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
    // Train rumble: low filtered noise.
    this.rGain = ctx.createGain(); this.rGain.gain.value = 0;
    const rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 110; rf.Q.value = 0.7;
    noise().connect(rf).connect(this.rGain).connect(this.master);
    this.rpm = 900;
    this.gear = 1;
  }

  // Jet engines: broadband roar plus a faint turbine whine.
  setJet(level) {
    if (!this.ctx) return;
    if (!this.jGain) {
      const ctx = this.ctx;
      this.jGain = ctx.createGain(); this.jGain.gain.value = 0;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 520; f.Q.value = 0.5;
      const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; n.start();
      n.connect(f).connect(this.jGain).connect(this.master);
      this.jwGain = ctx.createGain(); this.jwGain.gain.value = 0;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 2300; o.start();
      o.connect(this.jwGain).connect(this.master);
    }
    const t = this.ctx.currentTime, l = Math.max(0, Math.min(1, level));
    this.jGain.gain.setTargetAtTime(l * 0.6, t, 0.25);
    this.jwGain.gain.setTargetAtTime(l * l * 0.025, t, 0.25);
  }

  // Rain on the city: a hiss with a softer patter under it (0..1).
  setRain(level) {
    if (!this.ctx) return;
    if (!this.rainGain) {
      const ctx = this.ctx;
      this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7500;
      const n1 = ctx.createBufferSource(); n1.buffer = this.noiseBuf; n1.loop = true; n1.start();
      n1.connect(hp).connect(lp).connect(this.rainGain);
      const pat = ctx.createBiquadFilter(); pat.type = 'bandpass'; pat.frequency.value = 420; pat.Q.value = 0.6;
      const g2 = ctx.createGain(); g2.gain.value = 0.6;
      const n2 = ctx.createBufferSource(); n2.buffer = this.noiseBuf; n2.loop = true; n2.loopStart = 0.7; n2.start(0, 0.7);
      n2.connect(pat).connect(g2).connect(this.rainGain);
      this.rainGain.connect(this.master);
    }
    this.rainGain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.22, this.ctx.currentTime, 0.6);
  }

  // A thunder roll: a crack, then a long low rumble (strength 0..1, nearer is louder).
  thunder(strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(90, t + 1.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.75 * strength, t + 0.06);
    g.gain.setTargetAtTime(0.35 * strength, t + 0.3, 0.4);
    g.gain.setTargetAtTime(0, t + 1.6, 1.1);
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 7);
  }

  setRumble(level) {
    if (this.ctx) this.rGain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.55, this.ctx.currentTime, 0.15);
  }

  // Wind while flying (overrides the driving wind level for this frame).
  setWind(speed) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.wGain.gain.setTargetAtTime(Math.min(1, speed / 140) ** 2 * 0.3, t, 0.2);
    this.wFilter.frequency.setTargetAtTime(200 + speed * 9, t, 0.2);
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
    const lo = GEARS[gear - 1], hi = GEARS[gear] ?? TOP;
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
    this.wGain.gain.setTargetAtTime(active ? clamp(car.speed / 85, 0, 1) ** 2 * 0.26 : 0, t, 0.2);
    this.wFilter.frequency.setTargetAtTime(250 + car.speed * 14, t, 0.2);
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

  // Rowing: the blades going in at the catch (a soft splash), the oarlocks
  // clunking at the release.
  oar(strength = 1) {
    const f = this._burst(0.32, 900, 0.07 * strength, 'bandpass', 0.9);
    if (f) f.frequency.exponentialRampToValueAtTime(320, this.ctx.currentTime + 0.3);
  }
  oarlock() { this._burst(0.06, 1900, 0.04, 'bandpass', 4); }

  // Water rushing past a hull (0..1).
  setHull(level) {
    if (!this.ctx) return;
    if (!this.hullGain) {
      const ctx = this.ctx;
      this.hullGain = ctx.createGain(); this.hullGain.gain.value = 0;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 650; f.Q.value = 0.4;
      const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; n.start(0, 1.1);
      n.connect(f).connect(this.hullGain).connect(this.master);
    }
    this.hullGain.gain.setTargetAtTime(clamp(level, 0, 1) * 0.12, this.ctx.currentTime, 0.2);
  }

  // Ice grinding and cracking under an icebreaker's bow (0..1, nearer is louder).
  setCrunch(level) {
    if (!this.ctx) return;
    if (!this.cGain) {
      const ctx = this.ctx;
      this.cGain = ctx.createGain(); this.cGain.gain.value = 0;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 380; f.Q.value = 1.2;
      const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; n.start(0, 0.4);
      n.connect(f).connect(this.cGain).connect(this.master);
    }
    const l = clamp(level, 0, 1);
    this.cGain.gain.setTargetAtTime(l * 0.35, this.ctx.currentTime, 0.3);
    if (l > 0.05 && Math.random() < l * 0.08) this._burst(0.08 + Math.random() * 0.2, 2200 + Math.random() * 1800, 0.05 + l * 0.12, 'bandpass', 2.5);
  }

  // A ship's diesel: a deep, lumpy throb that rises with the engine order (0..1).
  setDiesel(level, speed = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (!this.dGain) {
      this.dGain = ctx.createGain(); this.dGain.gain.value = 0;
      this.dFilter = ctx.createBiquadFilter(); this.dFilter.type = 'lowpass'; this.dFilter.frequency.value = 180; this.dFilter.Q.value = 1.5;
      this.dOsc = ctx.createOscillator(); this.dOsc.type = 'square'; this.dOsc.frequency.value = 32;
      this.dSub = ctx.createOscillator(); this.dSub.type = 'sawtooth'; this.dSub.frequency.value = 16;
      const g2 = ctx.createGain(); g2.gain.value = 0.6;
      this.dOsc.connect(this.dFilter); this.dSub.connect(g2).connect(this.dFilter);
      const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; n.start(0, 1.7);
      const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 260;
      const ng = ctx.createGain(); ng.gain.value = 0.35;
      n.connect(nf).connect(ng).connect(this.dFilter);
      this.dFilter.connect(this.dGain).connect(this.master);
      this.dOsc.start(); this.dSub.start();
    }
    const l = clamp(level, 0, 1);
    this.dOsc.frequency.setTargetAtTime(28 + l * 26 + speed * 6, t, 0.4);
    this.dSub.frequency.setTargetAtTime(14 + l * 13 + speed * 3, t, 0.4);
    this.dFilter.frequency.setTargetAtTime(140 + l * 260, t, 0.4);
    this.dGain.gain.setTargetAtTime(l > 0 ? 0.08 + l * 0.12 : 0, t, 0.3);
  }

  // The ship's horn: held while H is down, or a blast of a given length.
  setShipHorn(on) {
    if (!this.ctx) return;
    if (!this.shGain) {
      const ctx = this.ctx;
      this.shGain = ctx.createGain(); this.shGain.gain.value = 0;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700; f.Q.value = 0.8;
      for (const fr of [110, 138.6, 165]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fr; o.connect(f); o.start(); }
      f.connect(this.shGain).connect(this.master);
    }
    this.shGain.gain.setTargetAtTime(on ? 0.11 : 0, this.ctx.currentTime, on ? 0.05 : 0.12);
  }
  shipHorn(seconds = 1) {
    if (!this.ctx) return;
    this.setShipHorn(true);
    clearTimeout(this._shT);
    this._shT = setTimeout(() => this.setShipHorn(false), seconds * 1000);
  }

  checkpoint() { this.tone([880, 1320], 0.18, 'triangle', 0.2); }
  finish() { this.tone([523, 659, 784, 1047], 0.35, 'triangle', 0.22, 0.12); }
  beep(final) { this.tone([final ? 1046 : 523], final ? 0.5 : 0.22, 'square', 0.08); }
  cash() { this.tone([1568, 2093, 2637], 0.12, 'square', 0.06, 0.06); }
  fail() { this.tone([392, 330, 262], 0.3, 'sawtooth', 0.08, 0.16); }
  discover() { this.tone([659, 988, 1319], 0.25, 'sine', 0.16, 0.1); }
}
