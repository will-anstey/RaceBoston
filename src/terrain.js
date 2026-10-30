// Ground height under any point (data/terrain.bin, built by tools/terrain.mjs)
// and draping: slicing flat map geometry on a grid aligned with the terrain
// so it follows the hills.

import * as THREE from 'three';
import { Buf } from './geom.js';

export class Terrain {
  // meta: { minX, minZ, step, w, h }; data: Float32Array heights or null (flat).
  constructor(meta, data) {
    this.minX = meta ? meta.minX : 0; this.minZ = meta ? meta.minZ : 0;
    this.step = meta ? meta.step : 10;
    this.w = meta && data ? meta.w : 0; this.h_ = meta && data ? meta.h : 0;
    this.data = data;
  }

  static decode(meta, buf) {
    const d = new Int16Array(buf), out = new Float32Array(meta.w * meta.h);
    for (let j = 0; j < meta.h; j++) {
      let v = 0;
      for (let i = 0; i < meta.w; i++) { const k = j * meta.w + i; v += d[k]; out[k] = v / 10; }
    }
    return new Terrain(meta, out);
  }

  // Height (m) at x, z; sea level outside the grid.
  h(x, z) {
    const H = this.data;
    if (!H) return 0;
    const fx = (x - this.minX) / this.step, fz = (z - this.minZ) / this.step;
    if (!(fx >= 0 && fz >= 0 && fx <= this.w - 1 && fz <= this.h_ - 1)) return 0;
    const i = Math.min(this.w - 2, fx | 0), j = Math.min(this.h_ - 2, fz | 0);
    const u = fx - i, v = fz - j, w = this.w, k = j * w + i;
    return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + w] * (1 - u) + H[k + w + 1] * u) * v;
  }

  // Smooth surface normal (central differences at the grid points, blended).
  normal(x, z, out = [0, 1, 0]) {
    const H = this.data;
    out[0] = 0; out[1] = 1; out[2] = 0;
    if (!H) return out;
    const fx = (x - this.minX) / this.step, fz = (z - this.minZ) / this.step;
    if (!(fx >= 1 && fz >= 1 && fx <= this.w - 2 && fz <= this.h_ - 2)) return out;
    const i = Math.min(this.w - 3, fx | 0), j = Math.min(this.h_ - 3, fz | 0);
    const u = fx - i, v = fz - j, w = this.w;
    let gx = 0, gz = 0;
    for (const [di, dj, wt] of [[0, 0, (1 - u) * (1 - v)], [1, 0, u * (1 - v)], [0, 1, (1 - u) * v], [1, 1, u * v]]) {
      const k = (j + dj) * w + i + di;
      gx += (H[k + 1] - H[k - 1]) * wt;
      gz += (H[k + w] - H[k - w]) * wt;
    }
    gx /= 2 * this.step; gz /= 2 * this.step;
    const l = Math.hypot(gx, 1, gz);
    out[0] = -gx / l; out[1] = 1 / l; out[2] = -gz / l;
    return out;
  }
}

// Clip a convex polygon of [x, z, b0, b1, b2] vertices to one side of an
// axis-aligned line (axis 0 = x, 1 = z); the crossing lands exactly on it.
function clipAxis(poly, axis, value, keepAbove) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = keepAbove ? a[axis] - value : value - a[axis];
    const db = keepAbove ? b[axis] - value : value - b[axis];
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t, a[4] + (b[4] - a[4]) * t];
      p[axis] = value;
      out.push(p);
    }
  }
  return out;
}

// Drape a flat geometry (position.y = height above the ground, usually a
// small lift) onto the terrain: every triangle is cut along grid lines (cell
// metres; `coarse` metres outside `fine` = {minX, maxX, minZ, maxZ}) so the
// pieces follow the ground, attributes are interpolated, and a terrain
// normal is added. `ground(x, z)` may override the terrain height (NaN = no).
// slice: false only sets heights (for ribbons already split every ~15 m).
export function drapeGeometry(geo, terrain, { cell = 20, coarse = 80, fine = null, ground = null, normals = true, slice = true } = {}) {
  if (!geo) return null;
  if (!slice) {
    const P = geo.attributes.position.array, n = P.length / 3, nrm = [0, 1, 0];
    const N = new Int8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = P[3 * i], z = P[3 * i + 2];
      let g = ground ? ground(x, z) : NaN;
      if (Number.isNaN(g)) g = terrain.h(x, z);
      P[3 * i + 1] += g;
      terrain.normal(x, z, nrm);
      N[3 * i] = Math.round(nrm[0] * 127); N[3 * i + 1] = Math.round(nrm[1] * 127); N[3 * i + 2] = Math.round(nrm[2] * 127);
    }
    if (normals) geo.setAttribute('normal', new THREE.BufferAttribute(N, 3, true));
    geo.attributes.position.needsUpdate = true;
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
  const pos = geo.attributes.position.array;
  const idx = geo.index ? geo.index.array : null;
  const names = Object.keys(geo.attributes).filter((n) => n !== 'position' && n !== 'normal');
  const src = names.map((n) => geo.attributes[n]);
  const outPos = new Buf(Float32Array), outIdx = new Buf(Uint32Array), outNrm = new Buf(Int8Array);
  const outAttr = src.map((a) => new Buf(a.array.constructor));
  const ox = terrain.minX, oz = terrain.minZ, nrm = [0, 1, 0];
  const triCount = idx ? idx.length / 3 : pos.length / 9;
  let nv = 0;
  const emit = (poly, i0, i1, i2) => {
    if (poly.length < 3) return;
    const base = nv;
    for (const p of poly) {
      const x = p[0], z = p[1];
      const rel = pos[3 * i0 + 1] * p[2] + pos[3 * i1 + 1] * p[3] + pos[3 * i2 + 1] * p[4];
      let g = ground ? ground(x, z) : NaN;
      if (Number.isNaN(g)) g = terrain.h(x, z);
      outPos.p3(x, g + rel, z);
      if (normals) {
        terrain.normal(x, z, nrm);
        outNrm.p3(Math.round(nrm[0] * 127), Math.round(nrm[1] * 127), Math.round(nrm[2] * 127));
      }
      for (let a = 0; a < src.length; a++) {
        const A = src[a], s = A.itemSize, arr = A.array, ob = outAttr[a], int = !(arr instanceof Float32Array);
        for (let c = 0; c < s; c++) {
          const v = arr[i0 * s + c] * p[2] + arr[i1 * s + c] * p[3] + arr[i2 * s + c] * p[4];
          ob.p1(int ? Math.round(v) : v);
        }
      }
      nv++;
    }
    for (let k = 1; k + 1 < poly.length; k++) outIdx.p3(base, base + k, base + k + 1);
  };
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx[3 * t] : 3 * t, i1 = idx ? idx[3 * t + 1] : 3 * t + 1, i2 = idx ? idx[3 * t + 2] : 3 * t + 2;
    const x0 = pos[3 * i0], z0 = pos[3 * i0 + 2], x1 = pos[3 * i1], z1 = pos[3 * i1 + 2], x2 = pos[3 * i2], z2 = pos[3 * i2 + 2];
    const cx = (x0 + x1 + x2) / 3, cz = (z0 + z1 + z2) / 3;
    const C = !fine || (cx >= fine.minX && cx <= fine.maxX && cz >= fine.minZ && cz <= fine.maxZ) ? cell : coarse;
    const tri = [[x0, z0, 1, 0, 0], [x1, z1, 0, 1, 0], [x2, z2, 0, 0, 1]];
    const minZ = Math.min(z0, z1, z2), maxZ = Math.max(z0, z1, z2), minX = Math.min(x0, x1, x2), maxX = Math.max(x0, x1, x2);
    const k0 = Math.floor((minZ - oz) / C), k1 = Math.floor((maxZ - oz) / C);
    for (let k = k0; k <= k1; k++) {
      const za = oz + k * C, zb = za + C;
      let band = tri;
      if (minZ < za) band = clipAxis(band, 1, za, true);
      if (maxZ > zb) band = clipAxis(band, 1, zb, false);
      if (band.length < 3) continue;
      let bx0 = Infinity, bx1 = -Infinity;
      for (const p of band) { if (p[0] < bx0) bx0 = p[0]; if (p[0] > bx1) bx1 = p[0]; }
      const m0 = Math.floor((bx0 - ox) / C), m1 = Math.floor((bx1 - ox) / C);
      for (let m = m0; m <= m1; m++) {
        const xa = ox + m * C, xb = xa + C;
        let cellPoly = band;
        if (bx0 < xa) cellPoly = clipAxis(cellPoly, 0, xa, true);
        if (bx1 > xb) cellPoly = clipAxis(cellPoly, 0, xb, false);
        emit(cellPoly, i0, i1, i2);
      }
    }
  }
  if (!nv) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(outPos.view(), 3));
  if (normals) g.setAttribute('normal', new THREE.BufferAttribute(outNrm.view(), 3, true));
  src.forEach((a, k) => g.setAttribute(names[k], new THREE.BufferAttribute(outAttr[k].view(), a.itemSize, a.normalized)));
  g.setIndex(new THREE.BufferAttribute(outIdx.view(), 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}
