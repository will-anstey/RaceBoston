// Terrain heightfield: elevation tiles (tools/fetch-dem.mjs) resampled to a
// 10 m grid over the whole map, cleaned up so it agrees with the OSM layers:
//   - the sea sits at 0 m and each inland water body at its own surface level
//   - open road cuts and trenches are filled from the ground around them
//     (the bare-earth model already has the Mass Pike trench; the road
//     elevation solver adds its own, relative to this ground)
//   - land is lightly smoothed, kept just above the water it borders, and
//     Logan's airfield is flattened so planes taxi on a level apron
//   - everything fades to sea level at the outer edge, where the far ground
//     plane takes over.

import fs from 'node:fs';
import path from 'node:path';
import { decodePNG } from './png.mjs';
import { tileXY, demDir } from './fetch-dem.mjs';

export const TERRAIN_STEP = 10;
const SMOOTH_SIGMA = 1.2;   // cells
const EDGE_FADE = 1200;     // m
const BANK = 0.3;           // land stays this far above adjacent water
const AIRPORT_BLEND = 8;    // cells

function terrariumTile(file) {
  const { w, h, bpp, data } = decodePNG(fs.readFileSync(file));
  const e = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) e[i] = data[i * bpp] * 256 + data[i * bpp + 1] + data[i * bpp + 2] / 256 - 32768;
  return e;
}

// Scanline fill of polygon rings ([x, z] points) over the grid points.
function fillRings(rings, g, cb) {
  const edges = [];
  let minZ = Infinity, maxZ = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      edges.push(a[0], a[1], b[0], b[1]);
      minZ = Math.min(minZ, a[1]); maxZ = Math.max(maxZ, a[1]);
    }
  }
  const j0 = Math.max(0, Math.ceil((minZ - g.minZ) / g.step)), j1 = Math.min(g.h - 1, Math.floor((maxZ - g.minZ) / g.step));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const zc = g.minZ + j * g.step;
    xs.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const az = edges[e + 1], bz = edges[e + 3];
      if ((az > zc) !== (bz > zc)) xs.push(edges[e] + ((zc - az) * (edges[e + 2] - edges[e])) / (bz - az));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.minX) / g.step)), i1 = Math.min(g.w - 1, Math.floor((xs[k + 1] - g.minX) / g.step));
      for (let i = i0; i <= i1; i++) cb(j * g.w + i);
    }
  }
}

// Grid points within `hw` of segment a-b.
function fillSegment(ax, az, bx, bz, hw, g, cb) {
  const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - g.minX) / g.step)), i1 = Math.min(g.w - 1, Math.ceil((Math.max(ax, bx) + hw - g.minX) / g.step));
  const j0 = Math.max(0, Math.floor((Math.min(az, bz) - hw - g.minZ) / g.step)), j1 = Math.min(g.h - 1, Math.ceil((Math.max(az, bz) + hw - g.minZ) / g.step));
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = g.minX + i * g.step, z = g.minZ + j * g.step;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      if (Math.hypot(x - ax - dx * t, z - az - dz * t) <= hw) cb(j * g.w + i);
    }
  }
}

// cuts: [ax, az, bx, bz, halfWidth] open road/rail cuts to fill over.
export function buildTerrain({ box, unproj, land, water, cuts, aerodromes, log }) {
  const step = TERRAIN_STEP;
  const minX = Math.floor(box.minX / step) * step, minZ = Math.floor(box.minZ / step) * step;
  const w = Math.ceil((box.maxX - minX) / step) + 1, h = Math.ceil((box.maxZ - minZ) / step) + 1;
  const g = { minX, minZ, step, w, h };
  const N = w * h;

  // ---- sample the elevation tiles (bilinear across tile edges)
  const tiles = new Map();
  let missing = 0;
  const pixel = (px, py) => {
    const tx = Math.floor(px / 256), ty = Math.floor(py / 256);
    const key = tx * 100000 + ty;
    let t = tiles.get(key);
    if (t === undefined) {
      const f = path.join(demDir, `${tx}_${ty}.png`);
      t = fs.existsSync(f) ? terrariumTile(f) : null;
      if (!t) missing++;
      tiles.set(key, t);
    }
    return t ? t[(py - ty * 256) * 256 + (px - tx * 256)] : 0;
  };
  const dem = new Float32Array(N);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [lon, lat] = unproj(minX + i * step, minZ + j * step);
      const [fx, fy] = tileXY(lon, lat);
      const gx = fx * 256 - 0.5, gy = fy * 256 - 0.5;
      const x0 = Math.floor(gx), y0 = Math.floor(gy), u = gx - x0, v = gy - y0;
      dem[j * w + i] = (pixel(x0, y0) * (1 - u) + pixel(x0 + 1, y0) * u) * (1 - v) + (pixel(x0, y0 + 1) * (1 - u) + pixel(x0 + 1, y0 + 1) * u) * v;
    }
  }
  if (missing) log(`terrain: ${missing} elevation tiles missing (run tools/fetch-dem.mjs)`);

  // ---- land / sea / inland water (kind 0 land, 1 sea, 2 + k water polygon k)
  const kind = new Int32Array(N).fill(1);
  for (const p of land) fillRings(p, g, (k) => { kind[k] = 0; });
  water.forEach((p, wi) => fillRings(p, g, (k) => { kind[k] = 2 + wi; }));
  // Inland water level: the lower quartile of the (hydro-flattened) surface.
  const samples = water.map(() => []);
  for (let k = 0; k < N; k++) if (kind[k] >= 2) samples[kind[k] - 2].push(dem[k]);
  const levels = water.map((p, wi) => {
    const s = samples[wi];
    if (!s.length) {
      // Too small for the grid: the lowest point of its shore.
      let lo = Infinity;
      for (const [x, z] of p[0]) {
        const i = Math.round((x - minX) / step), j = Math.round((z - minZ) / step);
        if (i >= 0 && j >= 0 && i < w && j < h) lo = Math.min(lo, dem[j * w + i]);
      }
      return Number.isFinite(lo) ? Math.max(0, lo - BANK) : 0;
    }
    s.sort((a, b) => a - b);
    return Math.max(0, Math.round(s[Math.floor(s.length * 0.25)] * 10) / 10);
  });

  // ---- fill open cuts from the ground around them
  const fill = new Uint8Array(N);
  for (const [ax, az, bx, bz, hw] of cuts) fillSegment(ax, az, bx, bz, hw + 8, g, (k) => { if (kind[k] === 0) fill[k] = 1; });
  const hgt = Float32Array.from(dem);
  {
    const free = [];
    for (let k = 0; k < N; k++) if (fill[k]) free.push(k);
    // Harmonic fill (SOR) with the surrounding land as the boundary.
    for (let it = 0; it < 400; it++) {
      let maxD = 0;
      for (const k of free) {
        const i = k % w, j = (k - i) / w;
        let s = 0, n = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          const q = jj * w + ii;
          if (kind[q] !== 0) continue;
          s += hgt[q]; n++;
        }
        if (!n) continue;
        const nv = hgt[k] + 1.6 * (s / n - hgt[k]);
        maxD = Math.max(maxD, Math.abs(nv - hgt[k]));
        hgt[k] = nv;
      }
      if (maxD < 0.01) break;
    }
    log(`terrain: filled ${free.length} grid points over open cuts`);
  }

  // ---- smooth land (normalised Gaussian over land points only)
  {
    const R = Math.ceil(SMOOTH_SIGMA * 3), K = [];
    for (let d = -R; d <= R; d++) K.push(Math.exp(-(d * d) / (2 * SMOOTH_SIGMA * SMOOTH_SIGMA)));
    const tmp = new Float32Array(N), tw = new Float32Array(N);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      let s = 0, sw = 0;
      for (let d = -R; d <= R; d++) {
        const ii = i + d;
        if (ii < 0 || ii >= w) continue;
        const q = j * w + ii;
        if (kind[q] !== 0) continue;
        s += hgt[q] * K[d + R]; sw += K[d + R];
      }
      tmp[j * w + i] = s; tw[j * w + i] = sw;
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (kind[k] !== 0) continue;
      let s = 0, sw = 0;
      for (let d = -R; d <= R; d++) {
        const jj = j + d;
        if (jj < 0 || jj >= h) continue;
        const q = jj * w + i;
        s += tmp[q] * K[d + R]; sw += tw[q] * K[d + R];
      }
      if (sw > 1e-6) hgt[k] = s / sw;
    }
  }

  // ---- flatten the airfield (median height, blended over ~80 m)
  for (const ring of aerodromes) {
    const inside = [];
    fillRings([ring], g, (k) => { if (kind[k] === 0) inside.push(k); });
    if (inside.length < 20) continue;
    const vals = inside.map((k) => hgt[k]).sort((a, b) => a - b);
    const E = vals[Math.floor(vals.length / 2)];
    const dist = new Float32Array(N).fill(Infinity);
    let front = inside;
    for (const k of inside) dist[k] = 0;
    for (let d = 1; d <= AIRPORT_BLEND && front.length; d++) {
      const next = [];
      for (const k of front) {
        const i = k % w, j = (k - i) / w;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          const q = jj * w + ii;
          if (dist[q] <= d) continue;
          dist[q] = d; next.push(q);
        }
      }
      front = next;
    }
    for (let k = 0; k < N; k++) {
      if (kind[k] !== 0 || !Number.isFinite(dist[k])) continue;
      const t = dist[k] / AIRPORT_BLEND, s = t * t * (3 - 2 * t);
      hgt[k] = E + (hgt[k] - E) * s;
    }
    log(`terrain: airfield flattened to ${E.toFixed(1)} m over ${inside.length} grid points`);
  }

  // ---- water at its level; land just above any water next to it
  for (let k = 0; k < N; k++) if (kind[k] >= 1) hgt[k] = kind[k] === 1 ? 0 : levels[kind[k] - 2];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i;
    if (kind[k] !== 0) continue;
    let floor = BANK;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
      const q = jj * w + ii;
      if (kind[q] >= 2) floor = Math.max(floor, levels[kind[q] - 2] + BANK);
    }
    if (hgt[k] < floor) hgt[k] = floor;
  }

  // ---- fade to sea level at the edge of the grid
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const d = Math.min(i, j, w - 1 - i, h - 1 - j) * step;
    if (d >= EDGE_FADE) continue;
    const t = d / EDGE_FADE, s = t * t * (3 - 2 * t);
    hgt[j * w + i] *= s;
  }

  let hi = -Infinity, hiAt = 0;
  for (let k = 0; k < N; k++) if (hgt[k] > hi) { hi = hgt[k]; hiAt = k; }
  log(`terrain: ${w}x${h} grid at ${step} m, highest ${hi.toFixed(1)} m at (${(minX + (hiAt % w) * step).toFixed(0)}, ${(minZ + Math.floor(hiAt / w) * step).toFixed(0)}); ${water.length} inland water levels`);
  return { ...g, heights: hgt, kind, levels };
}

// Int16 decimeters, delta-coded along rows (compresses well, decodes fast).
export function encodeTerrain(t) {
  const out = new Int16Array(t.w * t.h);
  for (let j = 0; j < t.h; j++) {
    let prev = 0;
    for (let i = 0; i < t.w; i++) {
      const v = Math.round(t.heights[j * t.w + i] * 10);
      out[j * t.w + i] = v - prev;
      prev = v;
    }
  }
  return Buffer.from(out.buffer);
}
