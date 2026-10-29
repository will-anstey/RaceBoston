// Geometry building helpers shared by the world and structure builders.

import * as THREE from 'three';
import earcut from '../vendor/earcut.js';

// Growable typed array.
export class Buf {
  constructor(Type = Float32Array, n = 4096) { this.T = Type; this.a = new Type(n); this.n = 0; }
  grow(k) {
    if (this.n + k <= this.a.length) return;
    let len = this.a.length * 2;
    while (len < this.n + k) len *= 2;
    const b = new this.T(len);
    b.set(this.a);
    this.a = b;
  }
  p1(a) { this.grow(1); this.a[this.n++] = a; }
  p2(a, b) { this.grow(2); const A = this.a; A[this.n++] = a; A[this.n++] = b; }
  p3(a, b, c) { this.grow(3); const A = this.a; A[this.n++] = a; A[this.n++] = b; A[this.n++] = c; }
  p4(a, b, c, d) { this.grow(4); const A = this.a; A[this.n++] = a; A[this.n++] = b; A[this.n++] = c; A[this.n++] = d; }
  view() { return this.a.slice(0, this.n); }
}

// Indexed geometry accumulator with arbitrary extra attributes:
// attrs = { name: [TypedArrayCtor, itemSize, normalized] }.
export class GeoBuilder {
  constructor(attrs) {
    this.pos = new Buf(Float32Array);
    this.idx = new Buf(Uint32Array);
    this.attrs = {};
    for (const [name, [Type, size, normalized]] of Object.entries(attrs || {})) this.attrs[name] = { buf: new Buf(Type), size, normalized };
  }
  get vcount() { return this.pos.n / 3; }
  // Quad from 4 points ([x,y,z]); both=true adds the back face too.
  quad(p0, p1, p2, p3, both = false) {
    const base = this.vcount;
    for (const p of [p0, p1, p2, p3]) this.pos.p3(p[0], p[1], p[2]);
    this.idx.p3(base, base + 1, base + 2); this.idx.p3(base, base + 2, base + 3);
    if (both) { this.idx.p3(base, base + 2, base + 1); this.idx.p3(base, base + 3, base + 2); }
    return base;
  }
  // Quad whose front face points along (nx, ny, nz).
  quadFacing(p0, p1, p2, p3, nx, ny, nz) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    // Vertex order is kept (callers push per-vertex attributes in that order).
    const base = this.vcount;
    for (const p of [p0, p1, p2, p3]) this.pos.p3(p[0], p[1], p[2]);
    if (cx * nx + cy * ny + cz * nz >= 0) { this.idx.p3(base, base + 1, base + 2); this.idx.p3(base, base + 2, base + 3); }
    else { this.idx.p3(base, base + 2, base + 1); this.idx.p3(base, base + 3, base + 2); }
    return base;
  }
  build() {
    if (!this.pos.n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.view(), 3));
    for (const [name, a] of Object.entries(this.attrs)) g.setAttribute(name, new THREE.BufferAttribute(a.buf.view(), a.size, a.normalized));
    g.setIndex(new THREE.BufferAttribute(this.idx.view(), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

// How a building's roof is drawn, and where its walls stop (OSM heights include the roof).
export function roofPlan(bd) {
  const n0 = bd.rings[0].length / 2;
  const single = bd.rings.length === 1;
  if (bd.dome && single && bd.roofH > 0.3) return { kind: 'dome', wallTop: bd.h - bd.roofH, rh: bd.roofH };
  if (bd.pitched && single && n0 <= 24 && bd.roofH > 0.3) return { kind: 'pitched', wallTop: bd.h - bd.roofH, rh: bd.roofH };
  return { kind: 'flat', wallTop: bd.h, rh: 0 };
}
export const crossY = (ax, az, bx, bz, cx, cz) => (bz - az) * (cx - ax) - (bx - ax) * (cz - az);

// Triangulate a polygon (Float32Array rings) into a builder at height y.
export function addPolygon(b, rings, y, color) {
  const flat = [];
  const holes = [];
  for (let k = 0; k < rings.length; k++) {
    if (k) holes.push(flat.length / 2);
    const r = rings[k];
    for (let i = 0; i < r.length; i++) flat.push(r[i]);
  }
  const tri = earcut(flat, holes.length ? holes : null, 2);
  if (!tri.length) return;
  const base = b.vcount;
  const n = flat.length / 2;
  const col = color === undefined ? null : rgb(color);
  for (let i = 0; i < n; i++) {
    b.pos.p3(flat[2 * i], y, flat[2 * i + 1]);
    if (col) b.attrs.color.buf.p3(col[0], col[1], col[2]);
  }
  for (let i = 0; i < tri.length; i += 3) {
    let a = tri[i], c1 = tri[i + 1], c2 = tri[i + 2];
    if (crossY(flat[2 * a], flat[2 * a + 1], flat[2 * c1], flat[2 * c1 + 1], flat[2 * c2], flat[2 * c2 + 1]) < 0) [c1, c2] = [c2, c1];
    b.idx.p3(base + a, base + c1, base + c2);
  }
}

// Mitred unit offsets (pointing right of travel) for a flat [x,z,...] polyline.
export function polyOffsets(pts, prev, next) {
  const n = pts.length / 2;
  const ox = new Float32Array(n), oz = new Float32Array(n), s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let ix = 0, iz = 0, jx = 0, jz = 0, hasIn = false, hasOut = false;
    if (i > 0) { ix = pts[2 * i] - pts[2 * i - 2]; iz = pts[2 * i + 1] - pts[2 * i - 1]; hasIn = true; }
    else if (prev) { ix = pts[0] - prev[0]; iz = pts[1] - prev[1]; hasIn = true; }
    if (i < n - 1) { jx = pts[2 * i + 2] - pts[2 * i]; jz = pts[2 * i + 3] - pts[2 * i + 1]; hasOut = true; }
    else if (next) { jx = next[0] - pts[2 * i]; jz = next[1] - pts[2 * i + 1]; hasOut = true; }
    let li = Math.hypot(ix, iz), lj = Math.hypot(jx, jz);
    if (!hasIn || li < 1e-6) { ix = jx; iz = jz; li = lj; }
    if (!hasOut || lj < 1e-6) { jx = ix; jz = iz; lj = li; }
    if (li < 1e-6) { ix = 1; iz = 0; li = 1; jx = 1; jz = 0; lj = 1; }
    ix /= li; iz /= li; jx /= lj; jz /= lj;
    const n1x = -iz, n1z = ix, n2x = -jz, n2z = jx;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) { mx = n2x; mz = n2z; } else { mx /= ml; mz /= ml; }
    const scale = 1 / Math.max(0.4, mx * n2x + mz * n2z);
    ox[i] = mx * scale; oz[i] = mz * scale;
    if (i > 0) s[i] = s[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  }
  return { ox, oz, s, n };
}

// Ribbon of quads along a polyline. `b` is a builder or a function
// (segIndex) => builder|null; perVertex(u, s, segIndex, builder) adds
// attributes; ys (optional) gives a per-point height added to y.
export function ribbon(b, pts, hw, y, perVertex, prev, next, segFilter, ys) {
  if (pts.length < 4) return;
  const { ox, oz, s, n } = polyOffsets(pts, prev, next);
  const pick = typeof b === 'function' ? b : () => b;
  for (let i = 0; i + 1 < n; i++) {
    if (segFilter && !segFilter(i)) continue;
    const tb = pick(i);
    if (!tb) continue;
    const base = tb.vcount;
    for (const [k, side] of [[i, -1], [i, 1], [i + 1, 1], [i + 1, -1]]) {
      tb.pos.p3(pts[2 * k] + ox[k] * hw * side, y + (ys ? ys[k] : 0), pts[2 * k + 1] + oz[k] * hw * side);
      perVertex(side * hw, s[k], i, tb);
    }
    tb.idx.p3(base, base + 1, base + 2);
    tb.idx.p3(base, base + 2, base + 3);
  }
}

export function meshOf(geo, mat, order, { shadow = false, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = order;
  m.castShadow = shadow;
  m.receiveShadow = receive;
  m.matrixAutoUpdate = false;
  m.updateMatrix();
  return m;
}
