// River ice. While it snows the Charles freezes from the banks inward and
// the ponds ice over; once the snow stops it all thaws again. When the sheet
// has closed right across the river it carries a car (slippery!), while boats
// are locked in except where icebreakers have cut a channel, which freezes
// over again within a few minutes.
//
// The state lives on a 4 m grid over the Charles, shared with the water
// shader (materials.js):
//   tIceShore (R8, linear):    distance to the bank in metres, 0 off the river
//   tIceBroken (RGBA, nearest): A = broken, R = when (2 s ticks, mod 256)

import * as THREE from 'three';
import { globalUniforms, iceUniforms } from './materials.js';
import { clamp } from './util.js';

const CELL = 4;
const TICK = 2;               // seconds per broken-ice clock tick
export const ICE_OPEN = 30;   // s a fresh channel stays open water
export const ICE_REFREEZE = 150; // s until a channel carries a car again
const THICK = 0.4;            // freeze level where shelf ice carries a car
const CLOSED = 0.8;           // freeze level where the sheet spans the river
const FREEZE_TIME = 80;       // s of snow from open water to frozen hard
const THAW_TIME = 170;        // s from frozen to open once the snow stops

export class RiverIce {
  constructor(map) {
    this.map = map;
    this.level = 0;
    this.clock = 0;
    this.ponds = [];
    const charles = [];
    map.water.forEach((p, i) => {
      const k = map.waterKind[i];
      if (k === 1) charles.push(p);
      if (k === 2) this.ponds.push({ rings: p, bb: ringsBox(p) });
    });
    // Grid over the Charles inside the map (the river beyond freezes evenly).
    const play = map.meta.play;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of charles) { const b = ringsBox(p); x0 = Math.min(x0, b[0]); z0 = Math.min(z0, b[1]); x1 = Math.max(x1, b[2]); z1 = Math.max(z1, b[3]); }
    if (!charles.length) { x0 = z0 = 0; x1 = z1 = CELL; }
    x0 = Math.max(x0, play.minX - 300); x1 = Math.min(x1, play.maxX + 300);
    z0 = Math.max(z0, play.minZ - 300); z1 = Math.min(z1, play.maxZ + 300);
    const W = (this.W = Math.max(1, Math.ceil((x1 - x0) / CELL))), H = (this.H = Math.max(1, Math.ceil((z1 - z0) / CELL)));
    this.x0 = x0; this.z0 = z0;
    const mask = new Uint8Array(W * H);
    for (const p of charles) fill(mask, W, H, x0, z0, p);
    const d = bankDistance(mask, W, H);
    this.shore = new Uint8Array(W * H);
    for (let k = 0; k < d.length; k++) this.shore[k] = mask[k] ? clamp(Math.round(d[k]), 1, 255) : 0;
    this.broken = new Uint8Array(W * H * 4);
    this.brokenList = [];
    this.rowMin = new Int32Array(H).fill(W);
    this.rowMax = new Int32Array(H).fill(-1);
    this.dirty = false;
    this.fullUpload = false;
    this.sweepTimer = 0;

    const shoreTex = new THREE.DataTexture(this.shore, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    shoreTex.minFilter = shoreTex.magFilter = THREE.LinearFilter;
    shoreTex.unpackAlignment = 1;   // one byte per texel, rows of any width
    shoreTex.needsUpdate = true;
    const brokenTex = (this.tex = new THREE.DataTexture(this.broken, W, H, THREE.RGBAFormat, THREE.UnsignedByteType));
    brokenTex.minFilter = brokenTex.magFilter = THREE.NearestFilter;
    brokenTex.needsUpdate = true;
    iceUniforms.tIceShore.value = shoreTex;
    iceUniforms.tIceBroken.value = brokenTex;
    iceUniforms.uIceBox.value.set(x0, z0, 1 / (W * CELL), 1 / (H * CELL));
    this._apply();
  }

  // How far out from the bank the sheet reaches (m); everything once closed.
  get front() { return this.level <= 0.001 ? -1 : Math.pow(this.level / CLOSED, 1.6) * 262; }
  get frozen() { return this.level >= CLOSED; }
  get forming() { return this.level > 0.02; }

  // Snap straight to frozen or open (weather set instantly, tests).
  setLevel(v) {
    this.level = clamp(v, 0, 1);
    if (this.level < 0.2) this.clearBroken();
    this._apply();
  }

  // Freeze while it snows, faster on a snow-covered city; thaw otherwise.
  update(dt, weather) {
    this.clock += dt;
    const st = weather.state;
    const cold = st.snow > 0.2;
    if (cold) this.level = Math.min(1, this.level + (dt / FREEZE_TIME) * (0.45 + 0.55 * st.cover));
    else this.level = Math.max(0, this.level - dt / THAW_TIME);
    if (this.level < 0.2 && this.brokenList.length) this.clearBroken();
    this.sweepTimer -= dt;
    if (this.sweepTimer <= 0) { this.sweepTimer = 15; this._sweep(); }
    this._apply();
    this._flush();
  }

  _apply() {
    globalUniforms.uIce.value = this.level;
    globalUniforms.uIceFront.value = this.front;
    globalUniforms.uIceEpoch.value = (this.clock / TICK) % 256;
  }

  _cell(x, z) {
    const i = Math.floor((x - this.x0) / CELL), j = Math.floor((z - this.z0) / CELL);
    return i < 0 || j < 0 || i >= this.W || j >= this.H ? -1 : j * this.W + i;
  }

  // Seconds since the cell was broken (Infinity if it never was).
  _age(k) {
    if (!this.broken[4 * k + 3]) return Infinity;
    const now = Math.floor(this.clock / TICK) & 255;
    return ((now - this.broken[4 * k] + 256) & 255) * TICK;
  }

  // Ice here is under the surface: 'none' (open water), 'brash' (a fresh
  // channel full of broken slabs), 'thin' (refreezing or still forming) or
  // 'solid' (carries a car, stops a boat).
  stateAt(x, z) {
    if (this.level <= 0.001) return 'none';
    const k = this._cell(x, z);
    if (k >= 0 && this.shore[k]) {
      const s = this.shore[k];
      if (s > this.front) return this.level > 0.15 && s < this.front + 120 ? 'brash' : 'none';
      const age = this._age(k);
      if (age < ICE_OPEN) return 'brash';
      if (age < ICE_REFREEZE) return 'thin';
      return this.level >= THICK ? 'solid' : 'thin';
    }
    if (this._inPond(x, z)) return this.level > 0.55 ? 'solid' : this.level > 0.3 ? 'thin' : 'none';
    return 'none';
  }

  solidAt(x, z) { return this.level >= THICK && this.stateAt(x, z) === 'solid'; }

  _inPond(x, z) {
    for (const p of this.ponds) {
      const b = p.bb;
      if (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3] && inRings(x, z, p.rings)) return true;
    }
    return false;
  }

  // Break the ice in a disc (an icebreaker's bow, a channel for a race).
  // ago: seconds already elapsed since it broke (0 = fresh).
  breakAt(x, z, r, ago = 0) {
    if (this.level <= 0.02) return 0;
    const W = this.W, tick = (Math.floor((this.clock - ago) / TICK) + 256 * 64) & 255;
    const i0 = Math.max(0, Math.floor((x - r - this.x0) / CELL)), i1 = Math.min(W - 1, Math.floor((x + r - this.x0) / CELL));
    const j0 = Math.max(0, Math.floor((z - r - this.z0) / CELL)), j1 = Math.min(this.H - 1, Math.floor((z + r - this.z0) / CELL));
    let n = 0;
    for (let j = j0; j <= j1; j++) {
      const cz = this.z0 + (j + 0.5) * CELL - z;
      let lo = W, hi = -1;
      for (let i = i0; i <= i1; i++) {
        const cx = this.x0 + (i + 0.5) * CELL - x;
        if (cx * cx + cz * cz > r * r) continue;
        const k = j * W + i;
        if (!this.shore[k] || this.shore[k] > this.front + 4) continue;
        if (!this.broken[4 * k + 3]) this.brokenList.push(k);
        else if (this.broken[4 * k] === tick) continue;
        this.broken[4 * k] = tick;
        this.broken[4 * k + 3] = 255;
        if (i < lo) lo = i;
        if (i > hi) hi = i;
        n++;
      }
      if (hi >= lo) { this.rowMin[j] = Math.min(this.rowMin[j], lo); this.rowMax[j] = Math.max(this.rowMax[j], hi); this.dirty = true; }
    }
    return n;
  }

  // Forget channels that have frozen over again (keeps the clock from wrapping).
  _sweep() {
    if (!this.brokenList.length) return;
    const keep = [];
    for (const k of this.brokenList) {
      if (this._age(k) > ICE_REFREEZE + 160) { this.broken[4 * k + 3] = 0; this.broken[4 * k] = 0; this.fullUpload = true; }
      else keep.push(k);
    }
    this.brokenList = keep;
  }

  clearBroken() {
    for (const k of this.brokenList) { this.broken[4 * k] = 0; this.broken[4 * k + 3] = 0; }
    if (this.brokenList.length) this.fullUpload = true;
    this.brokenList = [];
  }

  _flush() {
    const tex = this.tex;
    if (this.fullUpload) {
      tex.clearUpdateRanges();
      tex.needsUpdate = true;
      this.fullUpload = false;
    } else if (this.dirty) {
      for (let j = 0; j < this.H; j++) {
        if (this.rowMax[j] < 0) continue;
        tex.addUpdateRange((j * this.W + this.rowMin[j]) * 4, (this.rowMax[j] - this.rowMin[j] + 1) * 4);
      }
      tex.needsUpdate = true;
    }
    if (this.dirty) { this.rowMin.fill(this.W); this.rowMax.fill(-1); this.dirty = false; }
  }
}

function ringsBox(rings) {
  const r = rings[0];
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i < r.length; i += 2) { a = Math.min(a, r[i]); c = Math.max(c, r[i]); b = Math.min(b, r[i + 1]); d = Math.max(d, r[i + 1]); }
  return [a, b, c, d];
}

function inRings(x, z, rings) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const zi = r[i + 1], zj = r[j + 1];
      if ((zi > z) !== (zj > z) && x < ((r[j] - r[i]) * (z - zi)) / (zj - zi) + r[i]) inside = !inside;
    }
  }
  return inside;
}

// Even-odd scanline fill of a polygon (Float32Array rings) into the grid.
function fill(mask, W, H, x0, z0, rings) {
  const xs = [];
  const b = ringsBox(rings);
  const j0 = Math.max(0, Math.floor((b[1] - z0) / CELL)), j1 = Math.min(H - 1, Math.ceil((b[3] - z0) / CELL));
  for (let j = j0; j <= j1; j++) {
    const z = z0 + (j + 0.5) * CELL;
    xs.length = 0;
    for (const r of rings) {
      for (let i = 0, k = r.length - 2; i < r.length; k = i, i += 2) {
        const za = r[k + 1], zb = r[i + 1];
        if ((za > z) === (zb > z)) continue;
        xs.push(r[k] + ((z - za) / (zb - za)) * (r[i] - r[k]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const i0 = Math.max(0, Math.ceil((xs[n] - x0) / CELL - 0.5)), i1 = Math.min(W - 1, Math.floor((xs[n + 1] - x0) / CELL - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * W + i] = 1;
    }
  }
}

// Distance (m) from each river cell to the bank, 3-4 chamfer. The grid edge
// is not a bank (the river runs on past it).
function bankDistance(mask, W, H) {
  const BIG = 1e9, d = new Float32Array(W * H);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? BIG : 0;
  const A = CELL, B = CELL * Math.SQRT2;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (!d[k]) continue;
    let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + A);
    if (j > 0) { v = Math.min(v, d[k - W] + A); if (i > 0) v = Math.min(v, d[k - W - 1] + B); if (i + 1 < W) v = Math.min(v, d[k - W + 1] + B); }
    d[k] = v;
  }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i;
    if (!d[k]) continue;
    let v = d[k];
    if (i + 1 < W) v = Math.min(v, d[k + 1] + A);
    if (j + 1 < H) { v = Math.min(v, d[k + W] + A); if (i + 1 < W) v = Math.min(v, d[k + W + 1] + B); if (i > 0) v = Math.min(v, d[k + W - 1] + B); }
    d[k] = v;
  }
  for (let k = 0; k < d.length; k++) if (d[k] >= BIG) d[k] = 255;
  return d;
}
