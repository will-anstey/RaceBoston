// Aircraft at Logan: arrivals join a 3-degree glidepath to 4R, flare, roll
// out, exit and taxi to a stand; departures push back, taxi (holding short of
// active runways until cleared), take off from 4L and climb out, turning
// toward their destinations over the city; overflights cross at altitude.
// All motion follows OSM taxiways and runways.

import * as THREE from 'three';
import { AERO } from './mapdata.js';
import { clamp, wrapAngle, MinHeap } from './util.js';
import { globalUniforms } from './materials.js';
import { ACTIVE, makeLightMaterial } from './airport.js';

const DEG = Math.PI / 180;
const GS = Math.tan(3 * DEG);
const TYPES = {
  narrow: { len: 37.6, span: 35.8, dia: 3.95, fin: 11.8, clear: 1.6, eng: [0.33], eDia: 2.0, eLen: 4.4, cr: 0.17, sweep: 25, winglet: true, vApp: 70, vRot: 72, accel: 2.1, climb: 7, weight: 6, cap: 220 },
  wide: { len: 56.7, span: 60.1, dia: 5.75, fin: 17.0, clear: 2.3, eng: [0.3], eDia: 3.0, eLen: 6.3, cr: 0.18, sweep: 31, winglet: false, vApp: 76, vRot: 80, accel: 1.8, climb: 6, weight: 2, cap: 90 },
  regional: { len: 31.7, span: 26.0, dia: 3.0, fin: 9.7, clear: 1.2, eng: [0.32], eDia: 1.45, eLen: 3.4, cr: 0.16, sweep: 23, winglet: true, vApp: 65, vRot: 66, accel: 2.3, climb: 7.5, weight: 3, cap: 140 },
};
const TYPE_KEYS = Object.keys(TYPES);
const LIVERIES = [0x1d3d8f, 0xc8102e, 0x0b7a75, 0xf28c28, 0x5b2a86, 0x1f8a4c, 0x2a9fd6, 0xc9a227, 0x6b6e73, 0x0f1f3d, 0xd84a8a, 0x7a1c1c];
// Per density level: parked fraction of stands, seconds between arrivals and
// departures, overflights aloft, max departures taxiing at once.
const DENSITY = [
  { park: 0, arr: Infinity, dep: Infinity, over: 0, maxDep: 0 },
  { park: 0.45, arr: 170, dep: 165, over: 1, maxDep: 2 },
  { park: 0.6, arr: 110, dep: 105, over: 2, maxDep: 3 },
  { park: 0.72, arr: 75, dep: 72, over: 4, maxDep: 4 },
  { park: 0.85, arr: 52, dep: 50, over: 6, maxDep: 6 },
];
const EXIT_HEADINGS = [300, 245, 215, 190, 150, 30, 60, 330];

// =============================================================== models
function col(g, hex) {
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[3 * i] = c.r; a[3 * i + 1] = c.g; a[3 * i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function merge(parts) {
  const geos = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of geos) { if (!g.attributes.normal) g.computeVertexNormals(); if (!g.attributes.color) col(g, 0xffffff); }
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), cc = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3); nrm.set(g.attributes.normal.array, o * 3); cc.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(cc, 3));
  out.computeBoundingSphere();
  return out;
}
// Thin hexahedron from 4 root and 4 tip corners (flat-shaded).
function slab(rLE, rTE, tLE, tTE, tr, tt) {
  // r/t = root/tip; LE/TE = leading/trailing edge points [x,y,z]; tr/tt = half thickness
  const up = (p, h) => [p[0], p[1] + h, p[2]];
  const v = [up(rLE, tr), up(rTE, tr * 0.4), up(tTE, tt * 0.4), up(tLE, tt), up(rLE, -tr), up(rTE, -tr * 0.4), up(tTE, -tt * 0.4), up(tLE, -tt)];
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [3, 7, 6, 2], [0, 1, 5, 4]];
  const p = [];
  for (const [a, b, c, d] of faces) p.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}
// Vertical fin: like slab but thickness along x.
function fin(rLE, rTE, tLE, tTE, th) {
  const sx = (p, s) => [p[0] + s, p[1], p[2]];
  const v = [sx(rLE, th), sx(rTE, th * 0.3), sx(tTE, th * 0.2), sx(tLE, th * 0.5), sx(rLE, -th), sx(rTE, -th * 0.3), sx(tTE, -th * 0.2), sx(tLE, -th * 0.5)];
  const faces = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 3, 7, 4], [1, 5, 6, 2], [3, 2, 6, 7], [0, 4, 5, 1]];
  const p = [];
  for (const [a, b, c, d] of faces) p.push(...v[a], ...v[b], ...v[c], ...v[a], ...v[c], ...v[d]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}
function box(w, h, d, x, y, z, hex) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return col(g, hex); }
function cyl(r, len, x, y, z, hex, seg = 14, open = true) { const g = new THREE.CylinderGeometry(r, r * 0.92, len, seg, 1, open); g.rotateX(Math.PI / 2); g.translate(x, y, z); return col(g, hex); }

// Local frame: nose toward -z, +x right wing, y = 0 at the ground with gear down.
function buildModel(T) {
  const L = T.len, R = T.dia / 2, yc = R + T.clear, semi = T.span / 2;
  const base = [], liv = [], glass = [], gear = [];
  // Fuselage (lathe: axis along y, then rotated so +y -> -z).
  const noseL = 0.11 * L, tailL = 0.24 * L;
  const prof = [];
  const N = 26;
  for (let i = 0; i <= N; i++) {
    const h = -L / 2 + (L * i) / N; // tail -> nose
    let r = R;
    if (h > L / 2 - noseL) { const t = (L / 2 - h) / noseL; r = R * Math.sqrt(Math.max(0, 1 - (1 - t) ** 2)); }
    else if (h < -L / 2 + tailL) { const t = (-L / 2 + tailL - h) / tailL; r = R * (1 - 0.8 * Math.pow(t, 1.25)); }
    prof.push(new THREE.Vector2(Math.max(0.05, r), h));
  }
  const fus = new THREE.LatheGeometry(prof, 16);
  fus.rotateX(-Math.PI / 2);
  // Upswept tail cone; belly a little grey.
  const fp = fus.attributes.position, fc = new Float32Array(fp.count * 3);
  const white = new THREE.Color(0xf3f4f6), belly = new THREE.Color(0xc4c8ce);
  for (let i = 0; i < fp.count; i++) {
    const z = fp.getZ(i), y = fp.getY(i);
    const t = clamp((z - (L / 2 - tailL)) / tailL, 0, 1);
    fp.setY(i, y + yc + R * 0.55 * Math.pow(t, 1.6));
    const c = y < -R * 0.35 ? belly : white;
    fc[3 * i] = c.r; fc[3 * i + 1] = c.g; fc[3 * i + 2] = c.b;
  }
  fus.setAttribute('color', new THREE.BufferAttribute(fc, 3));
  fus.computeVertexNormals();
  base.push(fus);
  // Cockpit and cabin windows.
  glass.push(box(R * 1.15, 0.5, noseL * 0.35, 0, yc + R * 0.42, -L / 2 + noseL * 0.62, 0x182029));
  for (const s of [-1, 1]) glass.push(box(0.08, 0.34, 0.7 * L, s * (R - 0.02), yc + R * 0.2, -0.04 * L, 0x182029));
  for (const s of [-1, 1]) liv.push(box(0.08, 0.32, 0.78 * L, s * (R - 0.01), yc - R * 0.12, -0.03 * L, 0xffffff));
  // Wings (low, swept, with dihedral).
  const cr = T.cr * L, ct = cr * 0.28, zr = 0.02 * L, yr = yc - R * 0.6;
  const wingPts = (s) => {
    const rLE = [s * R * 0.7, yr, zr - cr / 2], rTE = [s * R * 0.7, yr, zr + cr / 2];
    const sw = Math.tan(T.sweep * DEG) * (semi - R * 0.7);
    const ty = yr + (semi - R * 0.7) * Math.tan(5 * DEG);
    const tLE = [s * semi, ty, zr - cr / 2 + sw], tTE = [s * semi, ty, zr - cr / 2 + sw + ct];
    return { rLE, rTE, tLE, tTE, ty, sw };
  };
  for (const s of [-1, 1]) {
    const w = wingPts(s);
    base.push(col(slab(w.rLE, w.rTE, w.tLE, w.tTE, cr * 0.06, ct * 0.06), 0xd2d6db));
    if (T.winglet) liv.push(col(fin(w.tLE, w.tTE, [w.tLE[0], w.ty + 2.2, w.tLE[2] + ct * 0.6], [w.tTE[0], w.ty + 2.2, w.tTE[2]], 0.08), 0xffffff));
    // Engines under the wing.
    for (const f of T.eng) {
      const ex = s * (R * 0.7 + f * (semi - R * 0.7));
      const ef = (Math.abs(ex) - R * 0.7) / (semi - R * 0.7);
      const leZ = zr - cr / 2 + w.sw * ef;
      const ey = yr + (Math.abs(ex) - R * 0.7) * Math.tan(5 * DEG) - T.eDia * 0.62;
      const ez = leZ - T.eLen * 0.2;
      liv.push(cyl(T.eDia / 2, T.eLen, ex, ey, ez, 0xffffff));
      glass.push(cyl(T.eDia / 2 * 0.86, 0.15, ex, ey, ez - T.eLen / 2 + 0.05, 0x101317, 14, false));
      base.push(box(0.3, T.eDia * 0.55, T.eLen * 0.6, ex, ey + T.eDia * 0.55, ez + T.eLen * 0.15, 0xc9cdd2));
      T._eng = T._eng || [];
      if (s > 0) T._eng.push([ex, ey, ez]);
    }
  }
  // Horizontal stabiliser.
  const hz = L / 2 - 0.09 * L, hy = yc + R * 0.35, hcr = 0.11 * L, hct = 0.045 * L, hsemi = 0.2 * T.span;
  for (const s of [-1, 1]) {
    const sw = Math.tan(32 * DEG) * hsemi;
    base.push(col(slab([s * R * 0.25, hy, hz - hcr / 2], [s * R * 0.25, hy, hz + hcr / 2], [s * hsemi, hy + hsemi * 0.1, hz - hcr / 2 + sw], [s * hsemi, hy + hsemi * 0.1, hz - hcr / 2 + sw + hct], 0.25, 0.1), 0xe7e9ec));
  }
  // Vertical fin (livery colour).
  const fy = yc + R * 0.7, fh = T.fin - fy, fcr = 0.18 * L, fct = 0.07 * L, fsw = Math.tan(38 * DEG) * fh;
  const fz0 = L / 2 - 0.2 * L;
  liv.push(fin([0, fy, fz0], [0, fy, fz0 + fcr], [0, T.fin, fz0 + fsw], [0, T.fin, fz0 + fsw + fct], 0.22));
  // Landing gear.
  const gy = (yc - R) / 2;
  gear.push(box(0.25, yc - R, 0.25, 0, gy, -0.38 * L, 0x2b2d31), box(0.5, 0.75, 0.75, 0, 0.38, -0.38 * L, 0x15161a));
  for (const s of [-1, 1]) {
    const gx = s * R * 1.25;
    gear.push(box(0.35, yc - R + 0.4, 0.35, gx, gy + 0.2, 0.06 * L, 0x2b2d31));
    gear.push(box(0.9, 1.1, 1.2 * (T === TYPES.wide ? 2.2 : 1), gx, 0.55, 0.06 * L, 0x15161a));
  }
  // Light positions (local).
  const w = wingPts(1);
  T.lights = {
    left: [-semi, w.ty, w.tLE[2] + ct * 0.5], right: [semi, w.ty, w.tLE[2] + ct * 0.5],
    tail: [0, yc + R * 0.55, L / 2 + 0.2], beaconTop: [0, yc + R + 0.15, 0.05 * L], beaconBot: [0, yc - R - 0.15, -0.05 * L],
    landL: [-R * 1.6, yr, zr - cr / 2], landR: [R * 1.6, yr, zr - cr / 2], taxi: [0, 1.2, -0.38 * L - 0.4],
  };
  T.yc = yc; T.R = R;
  return { base: merge(base), liv: merge(liv), glass: merge(glass), gear: merge(gear) };
}

// ========================================================== taxi graph
class TaxiGraph {
  constructor(A) {
    const N = (this.N = A.nodes.length / 2);
    this.x = A.nodes;
    this.onRunway = new Int16Array(N).fill(-1);
    const from = [], to = [], kind = [], rwy = [];
    const addEdge = (a, b, k, r) => { if (a === b) return; from.push(a, b); to.push(b, a); kind.push(k, k); rwy.push(r, r); };
    for (const w of A.ways) for (let i = 0; i + 1 < w.nodes.length; i++) addEdge(w.nodes[i], w.nodes[i + 1], w.kind, -1);
    A.runways.forEach((r, ri) => {
      for (const n of r.nodes) this.onRunway[n] = ri;
      for (let i = 0; i + 1 < r.nodes.length; i++) addEdge(r.nodes[i], r.nodes[i + 1], AERO.RUNWAY, ri);
    });
    const E = from.length;
    this.from = Int32Array.from(from); this.to = Int32Array.from(to); this.kind = Uint8Array.from(kind);
    this.len = new Float32Array(E);
    for (let e = 0; e < E; e++) this.len[e] = Math.hypot(this.px(this.to[e]) - this.px(this.from[e]), this.pz(this.to[e]) - this.pz(this.from[e]));
    const start = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) start[this.from[e] + 1]++;
    for (let i = 0; i < N; i++) start[i + 1] += start[i];
    const adj = new Int32Array(E), fill = start.slice(0, N);
    for (let e = 0; e < E; e++) adj[fill[this.from[e]]++] = e;
    this.start = start; this.adj = adj;
    this._g = new Float64Array(N); this._prev = new Int32Array(N); this._stamp = new Uint32Array(N); this._closed = new Uint32Array(N); this._sid = 0;
  }
  px(n) { return this.x[2 * n]; }
  pz(n) { return this.x[2 * n + 1]; }
  // A*: runway edges and other stands' lead-ins are expensive (cross, don't taxi along).
  route(a, b) {
    if (a < 0 || b < 0) return null;
    const sid = ++this._sid, g = this._g, prev = this._prev, st = this._stamp, cl = this._closed;
    const tx = this.px(b), tz = this.pz(b);
    const heap = new MinHeap();
    st[a] = sid; g[a] = 0; prev[a] = -1; heap.push(a, 0);
    while (heap.size) {
      const u = heap.pop();
      if (cl[u] === sid) continue;
      cl[u] = sid;
      if (u === b) break;
      for (let k = this.start[u]; k < this.start[u + 1]; k++) {
        const e = this.adj[k], v = this.to[e];
        if (cl[v] === sid) continue;
        const kd = this.kind[e];
        const f = kd === AERO.RUNWAY ? 25 : kd === AERO.LEADIN ? (v === b ? 1 : 60) : kd === AERO.TAXILANE ? 1.15 : 1;
        const nv = g[u] + this.len[e] * f;
        if (st[v] !== sid || nv < g[v]) { st[v] = sid; g[v] = nv; prev[v] = u; heap.push(v, nv + Math.hypot(this.px(v) - tx, this.pz(v) - tz)); }
      }
    }
    if (cl[b] !== sid) return null;
    const out = [];
    for (let n = b; n !== -1; n = prev[n]) out.push(n);
    return out.reverse();
  }
  // Taxi (non-runway) neighbours of a node.
  taxiNeighbours(n) {
    const out = [];
    for (let k = this.start[n]; k < this.start[n + 1]; k++) { const e = this.adj[k]; if (this.kind[e] !== AERO.RUNWAY) out.push(this.to[e]); }
    return out;
  }
}

// ============================================================== planes
export class Planes {
  constructor(game, airport) {
    this.g = game;
    const A = (this.A = game.map.aero);
    this.planes = [];
    this.level = 2;
    this.d = DENSITY[2];
    this.timers = { arr: 8, dep: 12, over: 2 };
    this.group = new THREE.Group();
    this.group.name = 'planes';
    game.scene.add(this.group);
    this.elev = 0;
    if (!A || !airport) { this.disabled = true; return; }
    this.graph = new TaxiGraph(A);
    this.center = { x: 0, z: 0 };
    // Runway geometry and named ends.
    this.runways = A.runways.map((r, ri) => {
      const pts = Array.from(r.nodes, (n) => [this.graph.px(n), this.graph.pz(n)]);
      const s = [0];
      for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      return { ri, ref: r.ref, width: r.width, nodes: Array.from(r.nodes), pts, s, length: s[s.length - 1], ends: r.ends };
    });
    let cx = 0, cz = 0;
    for (const r of this.runways) { cx += (r.pts[0][0] + r.pts[r.pts.length - 1][0]) / 2; cz += (r.pts[0][1] + r.pts[r.pts.length - 1][1]) / 2; }
    this.center = { x: cx / this.runways.length, z: cz / this.runways.length };
    // The simulation runs with y = 0 on the airfield (flattened in the
    // terrain); the group is lifted to its height in the world.
    this.elev = game.map.terrain.h(this.center.x, this.center.z);
    this.group.position.y = this.elev;
    this.ends = new Map();
    for (const r of this.runways) {
      r.ends.forEach((name, e) => {
        const nodes = e === 0 ? r.nodes.slice() : r.nodes.slice().reverse();
        const p0 = [this.graph.px(nodes[0]), this.graph.pz(nodes[0])], p1 = [this.graph.px(nodes[nodes.length - 1]), this.graph.pz(nodes[nodes.length - 1])];
        const l = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
        this.ends.set(name, { name, r, nodes, x: p0[0], z: p0[1], fx: (p1[0] - p0[0]) / l, fz: (p1[1] - p0[1]) / l, heading: Math.atan2(p1[0] - p0[0], -(p1[1] - p0[1])) });
      });
    }
    this.arrEnds = ACTIVE.arrive.map((n) => this.ends.get(n)).filter(Boolean);
    this.depEnds = ACTIVE.depart.map((n) => this.ends.get(n)).filter(Boolean);
    this.active = new Set([...this.arrEnds, ...this.depEnds].map((e) => e.r.ri));
    this.occ = this.runways.map(() => new Set());
    // Departure entry: the first node from the end with a taxi connection.
    for (const e of this.depEnds) e.entry = e.nodes.find((n) => this.graph.taxiNeighbours(n).length > 0) ?? e.nodes[0];
    // Stands: nose toward the stand end of the lead-in.
    this.stands = A.stands.map((st) => {
      const nodes = Array.from(st.nodes);
      const n = nodes.length;
      const ex = this.graph.px(nodes[n - 1]), ez = this.graph.pz(nodes[n - 1]);
      const bx = this.graph.px(nodes[n - 2]), bz = this.graph.pz(nodes[n - 2]);
      const l = Math.hypot(ex - bx, ez - bz) || 1;
      return { ref: st.ref, nodes, taxiNode: nodes[0], ex, ez, fx: (ex - bx) / l, fz: (ez - bz) / l, heading: Math.atan2(ex - bx, -(ez - bz)), occupant: null, reserved: null };
    }).filter((st) => this.graph.route(st.taxiNode, this.depEnds[0]?.entry ?? st.taxiNode));
    this._buildRendering();
    this.setDensity(2, true);
  }

  // ------------------------------------------------------------- density
  setDensity(level, initial = false) {
    if (this.disabled) return;
    this.level = clamp(level | 0, 0, DENSITY.length - 1);
    this.d = DENSITY[this.level];
    if (this.level === 0) { this.planes.length = 0; for (const s of this.stands) { s.occupant = s.reserved = null; } for (const o of this.occ) o.clear(); return; }
    // Park planes up to the target fraction (or remove extras).
    const want = Math.round(this.stands.length * this.d.park);
    const parked = this.planes.filter((p) => p.state === 'parked');
    if (parked.length > want) {
      for (const p of parked.slice(0, parked.length - want)) this._remove(p);
    } else {
      const free = this.stands.filter((s) => !s.occupant && !s.reserved);
      shuffle(free);
      for (const st of free.slice(0, want - parked.length)) this._park(this._newPlane(), st);
    }
    if (initial || this.planes.filter((p) => p.state !== 'parked').length === 0) {
      // Something to look at right away: arrivals already on approach and an overflight.
      for (const f of [0.55, 0.8]) { const p = this._spawnArrival(); if (p) p.air.s = p.air.length * f; }
      for (let k = 0; k < this.d.over; k++) { const p = this._spawnOverflight(); if (p) p.air.s = p.air.length * (0.25 + 0.5 * Math.random()); }
      this.timers.dep = 3;
    }
  }

  _newPlane() {
    let r = Math.random() * TYPE_KEYS.reduce((a, k) => a + TYPES[k].weight, 0), key = 'narrow';
    for (const k of TYPE_KEYS) { if ((r -= TYPES[k].weight) < 0) { key = k; break; } }
    if (this.planes.filter((p) => p.key === key).length >= TYPES[key].cap - 2) key = 'narrow';
    return {
      key, T: TYPES[key], color: new THREE.Color(LIVERIES[Math.floor(Math.random() * LIVERIES.length)]),
      state: 'parked', x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, v: 0, gear: true, landing: false,
      path: null, s: 0, holds: [], timer: 0, stuck: 0, ghost: 0, id: Math.random(),
    };
  }

  _remove(p) {
    const i = this.planes.indexOf(p);
    if (i >= 0) this.planes.splice(i, 1);
    if (p.stand) { if (p.stand.occupant === p) p.stand.occupant = null; if (p.stand.reserved === p) p.stand.reserved = null; }
    for (const o of this.occ) o.delete(p);
  }

  _park(p, st) {
    p.state = 'parked'; p.stand = st; st.occupant = p; st.reserved = null;
    const off = p.T.len / 2 + 2;
    p.x = st.ex - st.fx * off; p.z = st.ez - st.fz * off; p.y = 0;
    p.heading = st.heading; p.pitch = p.roll = 0; p.v = 0; p.gear = true; p.landing = false;
    p.parkedAt = performance.now() / 1000;
    if (!this.planes.includes(p)) this.planes.push(p);
  }

  // ------------------------------------------------------------- arrivals
  _spawnArrival() {
    const end = this.arrEnds[Math.floor(Math.random() * this.arrEnds.length)];
    if (!end) return null;
    const free = this.stands.filter((s) => !s.occupant && !s.reserved);
    if (!free.length) return null;
    const st = free[Math.floor(Math.random() * free.length)];
    const p = this._newPlane();
    p.stand = st; st.reserved = p;
    p.end = end;
    // Touchdown 450 m past the threshold; 3-degree glidepath back to a fix 9 km out,
    // joined by a curve from an entry point off to one side.
    const td = [end.x + end.fx * 450, end.z + end.fz * 450];
    const F = [end.fx, end.fz];
    const fafD = 9000, faf = [td[0] - F[0] * fafD, td[1] - F[1] * fafD];
    const side = Math.random() < 0.5 ? -1 : 1, ang = side * (55 + Math.random() * 65) * DEG;
    const bx = -F[0], bz = -F[1];
    const dir = [bx * Math.cos(ang) - bz * Math.sin(ang), bx * Math.sin(ang) + bz * Math.cos(ang)];
    const entry = [faf[0] + dir[0] * 7500, faf[1] + dir[1] * 7500];
    const ctrl = [faf[0] - F[0] * 3800, faf[1] - F[1] * 3800];
    const entryY = 950 + Math.random() * 450, fafY = fafD * GS;
    // Keep ~1 minute between arrivals at the runway: extend the join if needed.
    const eta = (pp) => { let t = 0; for (let i = 1; i < pp.length; i++) t += Math.hypot(pp[i][0] - pp[i - 1][0], pp[i][1] - pp[i - 1][1], pp[i][2] - pp[i - 1][2]) / ((pp[i][3] + pp[i - 1][3]) / 2); return t; };
    let latest = -Infinity;
    for (const q of this.planes) if (q.state === 'approach' && q.end === end) latest = Math.max(latest, (q.air.length - q.air.s) / Math.max(60, q.v));
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40, u = 1 - t;
      const x = u * u * entry[0] + 2 * u * t * ctrl[0] + t * t * faf[0];
      const z = u * u * entry[1] + 2 * u * t * ctrl[1] + t * t * faf[1];
      const e = t * t * (3 - 2 * t);
      pts.push([x, entryY + (fafY - entryY) * e, z, 115 + (80 - 115) * t]);
    }
    for (let i = 1; i <= 60; i++) {
      const d = fafD * (1 - i / 60);
      const y = d > 110 ? d * GS : GS * 110 * Math.pow(d / 110, 1.7);
      pts.push([td[0] - F[0] * d, y, td[1] - F[1] * d, 80 - 12 * (i / 60)]);
    }
    const gap = latest + 62 - eta(pts);
    if (gap > 0) {
      const ext = Math.min(30000, gap * 118);
      pts.unshift([entry[0] + dir[0] * ext, Math.min(2200, entryY + ext * 0.04), entry[1] + dir[1] * ext, 118]);
    }
    p.air = makeAirPath(pts);
    p.state = 'approach'; p.gear = false; p.landing = true;
    this._placeOnAir(p);
    this.planes.push(p);
    return p;
  }

  // ----------------------------------------------------------- departures
  _startDeparture() {
    const end = this.depEnds[Math.floor(Math.random() * this.depEnds.length)];
    if (!end) return false;
    const parked = this.planes.filter((p) => p.state === 'parked');
    if (!parked.length) return false;
    parked.sort((a, b) => a.parkedAt - b.parkedAt);
    for (const p of parked.slice(0, 6)) {
      const route = this.graph.route(p.stand.taxiNode, end.entry);
      if (!route) continue;
      p.end = end;
      // Pushback path: from the parked position back along the lead-in to the taxi node.
      const lead = p.stand.nodes.slice().reverse().map((n) => [this.graph.px(n), this.graph.pz(n)]);
      lead[0] = [p.x, p.z];
      p.push = makeGroundPath(lead);
      p.route = route;
      p.state = 'pushback'; p.s = 0; p.v = 0; p.timer = 0;
      return true;
    }
    return false;
  }

  _beginTaxiFromStand(p) {
    // Route to the departure entry, then the runway to the far end (takeoff roll).
    const nodes = p.route.slice();
    const pts = nodes.map((n) => [this.graph.px(n), this.graph.pz(n)]);
    pts[0] = [p.x, p.z];
    const runwayStart = pts.length - 1;
    const rn = p.end.nodes, k = rn.indexOf(p.end.entry);
    for (let i = k + 1; i < rn.length; i++) { nodes.push(rn[i]); pts.push([this.graph.px(rn[i]), this.graph.pz(rn[i])]); }
    p.path = makeGroundPath(pts, nodes);
    p.takeoffS = p.path.s[runwayStart];
    p.s = 0;
    p.holds = this._holdsFor(p, p.path, p.end.r.ri);
    p.state = 'taxi';
    if (p.stand) { p.stand.occupant = null; p.stand = null; }
  }

  // Hold-short events for active runways along a ground path.
  _holdsFor(p, path, depRw = -1, onRw = -1) {
    const holds = [];
    const n = path.nodes;
    if (!n) return holds;
    for (let i = 0; i < n.length; i++) {
      const ri = n[i] < 0 ? -1 : this.graph.onRunway[n[i]];
      if (ri < 0 || !this.active.has(ri)) continue;
      if (ri === onRw && i <= 2) continue; // already on it (landing rollout)
      if (i > 0 && this.graph.onRunway[n[i - 1]] === ri) continue;
      const hw = this.runways[ri].width / 2;
      let j = i;
      while (j + 1 < n.length && this.graph.onRunway[n[j + 1]] === ri) j++;
      const takeoff = ri === depRw && j === n.length - 1;
      holds.push({ ri, sHold: Math.max(0, path.s[i] - hw - 55), sClear: takeoff ? Infinity : path.s[j] + hw + 25, sNode: path.s[i], takeoff, cleared: false });
    }
    return holds;
  }

  // ---------------------------------------------------------- overflights
  _spawnOverflight() {
    const a = Math.random() * Math.PI * 2, b = a + Math.PI + (Math.random() - 0.5) * 0.9;
    const R = 15000;
    const c = this.g.map.meta.play;
    const mx = (c.minX + c.maxX) / 2 + (Math.random() - 0.5) * 3000, mz = (c.minZ + c.maxZ) / 2 + (Math.random() - 0.5) * 3000;
    const y = 1500 + Math.random() * 2200, v = 130 + Math.random() * 70;
    const p = this._newPlane();
    p.state = 'overfly'; p.gear = false; p.landing = false;
    p.air = makeAirPath([[mx + Math.sin(a) * R, y, mz - Math.cos(a) * R, v], [mx + Math.sin(b) * R, y + (Math.random() - 0.5) * 300, mz - Math.cos(b) * R, v]]);
    this._placeOnAir(p);
    this.planes.push(p);
    return p;
  }

  // ---------------------------------------------------------- clearances
  // May plane p enter runway ri (crossing, or lining up for takeoff)?
  // `at` is where a crossing meets the runway: it only needs the runway clear
  // there, so traffic that has passed that point, a departure that will be
  // airborne before reaching it, or a plane taxiing well away doesn't block it.
  _canEnter(p, ri, takeoff, at = null) {
    const rw = this.runways[ri], r0 = rw.pts[0], r1 = rw.pts[rw.pts.length - 1];
    const ux = (r1[0] - r0[0]) / rw.length, uz = (r1[1] - r0[1]) / rw.length;
    const along = (x, z) => (x - r0[0]) * ux + (z - r0[1]) * uz;
    for (const q of this.occ[ri]) {
      if (q === p) continue;
      // Airborne traffic never blocks; a departure well down the runway doesn't block a lineup.
      if (q.state === 'climb' || q.y > 20) continue;
      if (takeoff && q.state === 'takeoff' && q.s - q.takeoffS > 1300) continue;
      if (at) {
        const d = along(at.x, at.z) - along(q.x, q.z);
        const toRoll = q.state === 'taxi' && q.holds && q.holds.some((h) => h.takeoff && h.cleared && h.ri === ri);
        if (q.state === 'taxi' && !toRoll) { if (Math.abs(d) > 150) continue; } // crossing or turning off elsewhere
        else {
          const roll = toRoll || q.state === 'lineup' || q.state === 'takeoff';
          const fx = roll ? q.end.fx : Math.sin(q.heading), fz = roll ? q.end.fz : -Math.cos(q.heading);
          const ahead = d * (Math.sign(fx * ux + fz * uz) || 1);
          if (ahead < -60 || (roll && ahead > 1800)) continue; // already past it, or airborne before it
        }
      }
      return false;
    }
    // Arrivals to this runway soon?
    const window = takeoff ? 75 : 45;
    for (const q of this.planes) {
      if (q.state !== 'approach' || !q.end || q.end.r.ri !== ri) continue;
      const remain = q.air.length - q.air.s;
      if (remain / Math.max(40, q.v) < window) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- update
  update(dt, focus) {
    if (this.disabled) return;
    const d = this.d;
    if (this.level > 0) {
      this.timers.arr -= dt; this.timers.dep -= dt; this.timers.over -= dt;
      if (this.timers.arr <= 0) { this.timers.arr = d.arr * (0.8 + Math.random() * 0.4); this._spawnArrival(); }
      const deps = this.planes.filter((p) => p.state === 'pushback' || p.state === 'pivot' || p.state === 'taxi' && p.end && this.depEnds.includes(p.end) || p.state === 'lineup');
      if (this.timers.dep <= 0 && deps.length < d.maxDep) { this.timers.dep = d.dep * (0.8 + Math.random() * 0.4); this._startDeparture(); }
      if (this.timers.over <= 0) {
        this.timers.over = 6;
        if (this.planes.filter((p) => p.state === 'overfly').length < d.over) this._spawnOverflight();
      }
    }
    const car = this.g.car;
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const p = this.planes[i];
      switch (p.state) {
        case 'parked': break;
        case 'approach': this._updApproach(p, dt); break;
        case 'rollout': this._updRollout(p, dt); break;
        case 'pushback': this._updPushback(p, dt); break;
        case 'pivot': this._updPivot(p, dt); break;
        case 'taxi': this._updTaxi(p, dt, car); break;
        case 'lineup': this._updLineup(p, dt); break;
        case 'takeoff': this._updTakeoff(p, dt); break;
        case 'climb': case 'goaround': this._updClimb(p, dt); break;
        case 'overfly': this._updOverfly(p, dt); break;
      }
    }
    this._render();
  }

  _placeOnAir(p) {
    const a = p.air, q = a.at(a.s);
    p.x = q.x; p.y = q.y; p.z = q.z; p.v = q.v;
    const t = a.at(Math.min(a.length, a.s + 30));
    const dx = t.x - q.x, dz = t.z - q.z, dy = t.y - q.y;
    const h = Math.atan2(dx, -dz);
    const turn = wrapAngle(h - (p.heading ?? h));
    p.heading = h;
    const bank = clamp((turn / Math.max(1e-3, 0.016)) * 0.4, -0.45, 0.45);
    p.roll += (-bank - p.roll) * 0.05;
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz)) + (p.state === 'approach' ? 5.5 * DEG : 2 * DEG);
  }

  _updApproach(p, dt) {
    const a = p.air;
    a.s += p.v * dt;
    const remain = a.length - a.s;
    if (remain < 2600 && !p.gear) p.gear = true;
    // Claim the runway 2 km out (holds crossings and lineups), but only decide
    // on a go-around near the threshold, as a controller would.
    const ri = p.end.r.ri;
    if (remain < 2200 && !p.claimed) { p.claimed = true; this.occ[ri].add(p); }
    if (remain < 800 && !p.checked) {
      p.checked = true;
      if ([...this.occ[ri]].some((q) => q !== p && q.state !== 'approach')) { this._goAround(p); return; }
    }
    if (remain <= 0) {
      // Touchdown: roll out along the runway from the touchdown point.
      const e = p.end, td = [e.x + e.fx * 450, e.z + e.fz * 450];
      const pts = [td], nodes = [-1];
      for (const n of e.nodes) {
        const x = this.graph.px(n), z = this.graph.pz(n);
        if ((x - e.x) * e.fx + (z - e.z) * e.fz > 470) { pts.push([x, z]); nodes.push(n); }
      }
      p.path = makeGroundPath(pts, nodes);
      p.s = 0; p.y = 0; p.state = 'rollout'; p.timer = 0; p.exit = null;
      this.occ[e.r.ri].add(p);
      return;
    }
    this._placeOnAir(p);
    if (remain < 500) p.pitch += (Math.min(1, (500 - remain) / 400) * 1.5) * DEG; // flare
  }

  _updRollout(p, dt) {
    p.timer += dt;
    p.pitch = Math.max(0, 5 * DEG * (1 - p.timer / 3));
    p.roll *= 0.9;
    if (!p.exit) {
      p.v = Math.max(16, p.v - (p.timer < 12 ? 2.7 : 1.6) * dt);
      if (p.v < 30) this._pickExit(p);
    }
    if (p.exit) { this._updTaxi(p, dt, this.g.car); return; }
    p.s += p.v * dt;
    if (p.s >= p.path.length - 1) {
      p.v = Math.max(5, p.v - 3 * dt);
      this._pickExit(p, true);
      if (!p.exit) { this._remove(p); return; } // nowhere to go: tidy away
    }
    this._placeOnGround(p);
  }

  _pickExit(p, force = false) {
    const path = p.path, need = force ? 0 : (p.v * p.v - 12 * 12) / (2 * 2.2);
    for (let i = 1; i < path.nodes.length; i++) {
      const n = path.nodes[i];
      if (n < 0 || path.s[i] < p.s + need) continue;
      const nb = this.graph.taxiNeighbours(n);
      if (!nb.length) continue;
      // Prefer exits angled forward (high-speed turnoffs).
      const fx = Math.sin(p.heading), fz = -Math.cos(p.heading);
      const ok = nb.some((m) => { const dx = this.graph.px(m) - this.graph.px(n), dz = this.graph.pz(m) - this.graph.pz(n); return (dx * fx + dz * fz) / (Math.hypot(dx, dz) || 1) > -0.3; });
      if (!ok && !force) continue;
      const route = this.graph.route(n, p.stand.taxiNode);
      if (!route || route.length < 2) continue;
      const nodes = [-1, ...route, ...p.stand.nodes.slice(1)];
      const pts = [[p.x, p.z], ...route.map((m) => [this.graph.px(m), this.graph.pz(m)]), ...p.stand.nodes.slice(1).map((m) => [this.graph.px(m), this.graph.pz(m)])];
      p.path = makeGroundPath(pts, nodes);
      p.s = 0;
      p.exit = n;
      p.parkS = p.path.length - (p.T.len / 2 + 2);
      p.holds = this._holdsFor(p, p.path, -1, p.end.r.ri);
      // Leave the landing runway once clear of it.
      p.releaseRw = { ri: p.end.r.ri, s: p.path.s[1] + p.end.r.width / 2 + 45 };
      p.state = 'taxi';
      return;
    }
  }

  _goAround(p) {
    p.state = 'goaround'; p.gear = true; p.timer = 0;
    p.gamma = 0; p.targetHeading = p.heading + (Math.random() < 0.5 ? -1 : 1) * 60 * DEG;
    if (p.stand && p.stand.reserved === p) p.stand.reserved = null;
    p.stand = null;
    for (const o of this.occ) o.delete(p);
  }

  _updPushback(p, dt) {
    const path = p.push;
    p.v = Math.min(1.6, p.v + 0.5 * dt);
    p.s += p.v * dt;
    if (p.s >= path.length) { p.state = 'pivot'; p.timer = 0; return; }
    const q = path.at(p.s);
    p.x = q.x; p.z = q.z;
    p.heading = Math.atan2(-q.tx, q.tz); // nose opposite the direction of travel
    if (p.stand && p.s > 15) { p.stand.occupant = null; }
  }

  _updPivot(p, dt) {
    p.timer += dt;
    const n0 = p.route[0], n1 = p.route[Math.min(1, p.route.length - 1)];
    const want = Math.atan2(this.graph.px(n1) - this.graph.px(n0), -(this.graph.pz(n1) - this.graph.pz(n0)));
    const d = wrapAngle(want - p.heading);
    p.heading = wrapAngle(p.heading + clamp(d, -0.09 * dt, 0.09 * dt)); // tug turns ~5 deg/s
    if (Math.abs(d) < 0.03 || p.timer > 20) { p.heading = want; this._beginTaxiFromStand(p); p.v = 0; }
  }

  _updTaxi(p, dt, car) {
    const path = p.path;
    // Speed limits: bends ahead, lead-in lines, the end of the path, holds, traffic.
    let vt = p.exit && p.v > 12 ? p.v : 11;
    const look = 25 + p.v * 3;
    const bend = path.bendAhead(p.s, look);
    if (bend > 0.35) vt = Math.min(vt, 3.5 + 8 * (1 - Math.min(1, bend / 1.6)));
    const endS = p.parkS ?? (p.takeoffS ?? path.length);
    const stopAt = (sStop) => Math.sqrt(2 * 1.2 * Math.max(0, sStop - p.s));
    vt = Math.min(vt, stopAt(endS));
    if (p.parkS && p.s > p.parkS - 70) vt = Math.min(vt, 3.5);
    for (const h of p.holds) {
      if (h.cleared || p.s > h.sHold + 1) continue;
      if (p.s > h.sHold - 120) {
        if (this._canEnter(p, h.ri, h.takeoff, h.takeoff ? null : path.at(h.sNode))) { h.cleared = true; this.occ[h.ri].add(p); }
        else vt = Math.min(vt, stopAt(h.sHold));
      }
      break;
    }
    for (const h of p.holds) if (h.cleared && !h.takeoff && p.s > h.sClear) this.occ[h.ri].delete(p);
    if (p.releaseRw && p.s > p.releaseRw.s) { this.occ[p.releaseRw.ri].delete(p); p.releaseRw = null; }
    // Other aircraft ahead, and the player's car.
    const fx = Math.sin(p.heading), fz = -Math.cos(p.heading);
    if (p.ghost <= 0) {
      for (const q of this.planes) {
        if (q === p || q.y > 5 || q.state === 'parked') continue;
        const dx = q.x - p.x, dz = q.z - p.z;
        if (Math.abs(dx) > 160 || Math.abs(dz) > 160) continue;
        const ahead = dx * fx + dz * fz, lat = Math.abs(dx * -fz + dz * fx);
        if (ahead <= 0 || ahead > 150 || lat > Math.max(18, (p.T.span + q.T.span) * 0.3)) continue;
        vt = Math.min(vt, stopAt(p.s + ahead - (p.T.len + q.T.len) / 2 - 18));
      }
    }
    if (car && Math.abs(car.y - this.elev - p.y) < 4) {
      const dx = car.x - p.x, dz = car.z - p.z;
      const ahead = dx * fx + dz * fz, lat = Math.abs(dx * -fz + dz * fx);
      if (ahead > 0 && ahead < 90 && lat < p.T.span / 2 + 3) vt = Math.min(vt, stopAt(p.s + ahead - p.T.len / 2 - 8));
    }
    const acc = vt > p.v ? 0.9 : -2.0;
    p.v = clamp(p.v + acc * dt, Math.min(p.v, vt), Math.max(p.v, vt));
    if (p.v < 0.2) { p.stuck += dt; if (p.stuck > 35) { p.ghost = 12; p.stuck = 0; } } else p.stuck = Math.max(0, p.stuck - dt);
    p.ghost -= dt;
    p.s += p.v * dt;
    p.pitch *= 0.9; p.roll *= 0.9;
    this._placeOnGround(p);
    if (p.takeoffS !== undefined && p.s >= p.takeoffS - 0.5) {
      p.state = 'lineup'; p.timer = 0; p.v = 0; p.s = p.takeoffS;
    } else if (p.parkS !== undefined && p.s >= p.parkS - 0.5 && p.v < 1) {
      const st = p.stand;
      p.parkS = undefined; p.exit = null;
      if (st) this._park(p, st); else this._remove(p);
    }
  }

  _updLineup(p, dt) {
    p.timer += dt;
    // Make sure the runway is ours, then spool up and go.
    const ri = p.end.r.ri;
    if (!this.occ[ri].has(p)) { if (this._canEnter(p, ri, true)) this.occ[ri].add(p); else return; }
    const want = p.end.heading;
    p.heading = wrapAngle(p.heading + clamp(wrapAngle(want - p.heading), -0.3 * dt, 0.3 * dt));
    if (p.timer > 6 && Math.abs(wrapAngle(want - p.heading)) < 0.05) { p.state = 'takeoff'; p.timer = 0; }
  }

  _updTakeoff(p, dt) {
    p.timer += dt;
    p.v += p.T.accel * dt;
    p.s += p.v * dt;
    this._placeOnGround(p);
    p.heading = p.end.heading; // runway is straight; ignore the taxiway's corner blend
    if (p.v > p.T.vRot) {
      p.pitch = Math.min(9 * DEG, p.pitch + 3 * DEG * dt);
      if (p.pitch > 6 * DEG) {
        p.state = 'climb'; p.gamma = 2 * DEG; p.timer = 0;
        p.targetHeading = EXIT_HEADINGS[Math.floor(Math.random() * EXIT_HEADINGS.length)] * DEG;
      }
    }
    if (p.s > p.path.length + 200) { p.state = 'climb'; p.gamma = 3 * DEG; p.timer = 0; p.targetHeading = p.heading; }
  }

  _updClimb(p, dt) {
    p.timer += dt;
    const vMax = p.T.vRot + 22;
    p.v = Math.min(vMax, p.v + 1.4 * dt);
    const gMax = (p.state === 'goaround' ? 6 : p.T.climb) * DEG * (p.y > 2400 ? 0.3 : 1);
    p.gamma += clamp(gMax - p.gamma, -0.02 * dt, 0.03 * dt);
    p.y += p.v * Math.sin(p.gamma) * dt;
    if (p.timer > 7) p.gear = false;
    if (p.timer > 25) p.landing = false;
    if (p.y > 60) for (const o of this.occ) o.delete(p);
    let rate = 0;
    if (p.y > 320) {
      const d = wrapAngle(p.targetHeading - p.heading);
      rate = clamp(d, -2.6 * DEG, 2.6 * DEG);
      p.heading = wrapAngle(p.heading + rate * dt);
    }
    const hv = p.v * Math.cos(p.gamma);
    p.x += Math.sin(p.heading) * hv * dt;
    p.z += -Math.cos(p.heading) * hv * dt;
    p.pitch += (p.gamma + 4 * DEG - p.pitch) * Math.min(1, 2 * dt);
    p.roll += (-rate * 8 - p.roll) * Math.min(1, 1.5 * dt);
    if (Math.hypot(p.x - this.center.x, p.z - this.center.z) > 17000 || p.y > 3800) this._remove(p);
  }

  _updOverfly(p, dt) {
    p.air.s += p.v * dt;
    if (p.air.s >= p.air.length) { this._remove(p); return; }
    this._placeOnAir(p);
  }

  _placeOnGround(p) {
    const q = p.path.at(p.s);
    p.x = q.x; p.z = q.z; p.y = 0;
    // The path already blends tangents through corners; ease the rest.
    const want = Math.atan2(q.tx, -q.tz);
    p.heading = wrapAngle(p.heading + wrapAngle(want - p.heading) * 0.35);
  }

  // ------------------------------------------------------------ rendering
  _buildRendering() {
    const baseMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.25, envMapIntensity: 1.2, side: THREE.DoubleSide });
    const livMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2, envMapIntensity: 1.1, side: THREE.DoubleSide });
    this.glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.1, metalness: 0.6, emissive: 0xffe2b0, emissiveIntensity: 0, side: THREE.DoubleSide });
    this.meshes = {};
    for (const key of TYPE_KEYS) {
      const T = TYPES[key];
      const geo = buildModel(T);
      const mk = (g, mat) => {
        const m = new THREE.InstancedMesh(g, mat, T.cap);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.frustumCulled = false;
        m.castShadow = true;
        m.receiveShadow = true;
        m.count = 0;
        this.group.add(m);
        return m;
      };
      const liv = mk(geo.liv, livMat);
      liv.setColorAt(0, new THREE.Color(1, 1, 1));
      this.meshes[key] = { base: mk(geo.base, baseMat), liv, glass: mk(geo.glass, this.glassMat), gear: mk(geo.gear, baseMat) };
    }
    // Dynamic nav / beacon / strobe / landing lights.
    const cap = 600 * 9;
    this.lightGeo = new THREE.BufferGeometry();
    this.lPos = new Float32Array(cap * 3); this.lCol = new Float32Array(cap * 3); this.lSize = new Float32Array(cap); this.lAnim = new Float32Array(cap * 2);
    this.lightGeo.setAttribute('position', new THREE.BufferAttribute(this.lPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lightGeo.setAttribute('color', new THREE.BufferAttribute(this.lCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lightGeo.setAttribute('aSize', new THREE.BufferAttribute(this.lSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.lightGeo.setAttribute('aAnim', new THREE.BufferAttribute(this.lAnim, 2).setUsage(THREE.DynamicDrawUsage));
    this.lightMat = makeLightMaterial(0.3);
    this.lightPts = new THREE.Points(this.lightGeo, this.lightMat);
    this.lightPts.frustumCulled = false;
    this.lightPts.renderOrder = 9;
    this.group.add(this.lightPts);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._v = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1); this._lv = new THREE.Vector3();
    this._c = { red: new THREE.Color(0xff2a1a), green: new THREE.Color(0x2aff6a), white: new THREE.Color(0xffffff), warm: new THREE.Color(0xfff2d8) };
  }

  _render() {
    if (this.disabled) return;
    const counts = {};
    for (const key of TYPE_KEYS) counts[key] = { n: 0, g: 0 };
    let li = 0;
    const night = globalUniforms.uNight.value;
    this.glassMat.emissiveIntensity = night * 1.1;
    const L = (local, color, size, mode = 0, param = 0) => {
      if (li >= this.lSize.length) return;
      this._lv.set(local[0], local[1], local[2]).applyMatrix4(this._m);
      this.lPos[3 * li] = this._lv.x; this.lPos[3 * li + 1] = this._lv.y; this.lPos[3 * li + 2] = this._lv.z;
      this.lCol[3 * li] = color.r; this.lCol[3 * li + 1] = color.g; this.lCol[3 * li + 2] = color.b;
      this.lSize[li] = size; this.lAnim[2 * li] = mode; this.lAnim[2 * li + 1] = param;
      li++;
    };
    for (const p of this.planes) {
      const M = this.meshes[p.key], c = counts[p.key];
      if (c.n >= p.T.cap) continue;
      this._e.set(p.pitch, -p.heading, p.roll, 'YXZ');
      this._q.setFromEuler(this._e);
      this._m.compose(this._v.set(p.x, p.y, p.z), this._q, this._s);
      M.base.setMatrixAt(c.n, this._m); M.liv.setMatrixAt(c.n, this._m); M.glass.setMatrixAt(c.n, this._m);
      M.liv.setColorAt(c.n, p.color);
      if (p.gear) M.gear.setMatrixAt(c.g++, this._m);
      c.n++;
      const T = p.T.lights, C = this._c, parked = p.state === 'parked';
      if (!parked) {
        L(T.left, C.red, 1.3); L(T.right, C.green, 1.3); L(T.tail, C.white, 1.1);
        L(T.beaconTop, C.red, 2.2, 1, 1.1); L(T.beaconBot, C.red, 2.2, 1, 1.1);
        if (p.y > 0 || p.state === 'takeoff' || p.state === 'rollout') { L(T.left, C.white, 3.5, 1, 1.3); L(T.right, C.white, 3.5, 1, 1.3); }
        if (p.landing || p.state === 'lineup' || p.state === 'takeoff') { L(T.landL, C.warm, 6, 0); L(T.landR, C.warm, 6, 0); }
        if (p.state === 'taxi' || p.state === 'lineup') L(T.taxi, C.warm, 3.2, 0);
      }
    }
    for (const key of TYPE_KEYS) {
      const M = this.meshes[key], c = counts[key];
      for (const part of ['base', 'liv', 'glass']) { M[part].count = c.n; M[part].instanceMatrix.needsUpdate = true; }
      if (M.liv.instanceColor) M.liv.instanceColor.needsUpdate = true;
      M.gear.count = c.g; M.gear.instanceMatrix.needsUpdate = true;
    }
    this.lightGeo.setDrawRange(0, li);
    for (const k of ['position', 'color', 'aSize', 'aAnim']) this.lightGeo.attributes[k].needsUpdate = true;
  }

  // -------------------------------------------------------------- queries
  positions() {
    return this.disabled ? [] : this.planes.map((p) => [p.x, p.z, p.heading, p.y > 3 ? 1 : 0]);
  }

  // Loudness of jet engines near (x, z).
  noise(x, y, z) {
    if (this.disabled) return 0;
    let lv = 0;
    for (const p of this.planes) {
      const thrust = p.state === 'takeoff' || p.state === 'climb' || p.state === 'goaround' ? 1 : p.state === 'approach' ? 0.4 : p.state === 'rollout' ? 0.75 : p.state === 'overfly' ? 0.25 : p.state === 'parked' ? 0.02 : 0.15;
      const d = Math.hypot(p.x - x, p.y + this.elev - y, p.z - z);
      lv += thrust / (1 + (d / 260) ** 2);
    }
    return Math.min(1, lv);
  }

  // Aircraft on the ground are solid to the player's car.
  collidePlayer(car) {
    if (this.disabled) return;
    const h = car.h, fx = Math.sin(car.heading), fz = -Math.cos(car.heading);
    let hit = 0;
    for (const p of this.planes) {
      if (p.y > 2 || Math.abs(car.y - this.elev - p.y) > 3) continue;
      const dx0 = car.x - p.x, dz0 = car.z - p.z;
      if (Math.abs(dx0) > p.T.len || Math.abs(dz0) > p.T.len) continue;
      const ax = Math.sin(p.heading), az = -Math.cos(p.heading);
      const hl = p.T.len / 2 - p.T.R, rr = p.T.R * 0.9;
      // Fuselage capsule and the two engines.
      const engines = (p.T._eng || []).flatMap(([ex, , ez]) => [[ex, ez], [-ex, ez]]);
      for (const off of h.circles) {
        const px = car.x + fx * off, pz = car.z + fz * off;
        const shapes = [[0, hl, rr]].concat(engines.map(([ex, ez]) => [ex, ez, p.T.eDia / 2]));
        for (let k = 0; k < shapes.length; k++) {
          let cx, cz, r;
          if (k === 0) {
            const along = clamp((px - p.x) * ax + (pz - p.z) * az, -hl, hl);
            cx = p.x + ax * along; cz = p.z + az * along; r = rr;
          } else {
            const [ex, ez, er] = shapes[k];
            // local (x right, z back) -> world
            cx = p.x + Math.cos(p.heading) * ex - ax * ez; cz = p.z + Math.sin(p.heading) * ex - az * ez; r = er;
          }
          let nx = px - cx, nz = pz - cz;
          const d = Math.hypot(nx, nz), pen = h.radius + r - d;
          if (pen <= 0) continue;
          if (d < 1e-4) { nx = -az; nz = ax; } else { nx /= d; nz /= d; }
          car.x += nx * pen; car.z += nz * pen;
          const pvx = ax * p.v, pvz = az * p.v;
          const vn = (car.vx - pvx) * nx + (car.vz - pvz) * nz;
          if (vn < 0) { car.vx -= 1.3 * vn * nx; car.vz -= 1.3 * vn * nz; car.yawRate *= 0.5; hit = Math.max(hit, -vn); }
        }
      }
    }
    if (hit > car.impact) { car.impact = hit; car.impactKind = 6; }
  }

  stats() {
    const c = {};
    for (const p of this.planes) c[p.state] = (c[p.state] || 0) + 1;
    return { total: this.planes.length, ...c };
  }
}

// =============================================================== paths
// 2D ground path with arc length, sampling and bend lookahead.
function makeGroundPath(pts, nodes = null) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const length = s[s.length - 1];
  const turn = pts.map((_, i) => {
    if (i === 0 || i === pts.length - 1) return 0;
    const a = Math.atan2(pts[i][0] - pts[i - 1][0], -(pts[i][1] - pts[i - 1][1]));
    const b = Math.atan2(pts[i + 1][0] - pts[i][0], -(pts[i + 1][1] - pts[i][1]));
    return Math.abs(wrapAngle(b - a));
  });
  const idx = (q) => { let lo = 0, hi = s.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= q) lo = m; else hi = m; } return lo; };
  return {
    pts, s, length, nodes,
    at(q) {
      q = clamp(q, 0, length);
      const i = Math.min(idx(q), pts.length - 2);
      const a = pts[i], b = pts[i + 1], L = s[i + 1] - s[i] || 1e-6;
      const t = (q - s[i]) / L;
      // Smooth heading through corners by blending neighbouring tangents.
      const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
      let bx = tx, bz = tz;
      const R = 14;
      if (q > s[i + 1] - R && i + 2 < pts.length) {
        const c = pts[i + 2], L2 = s[i + 2] - s[i + 1] || 1e-6, w = (q - (s[i + 1] - R)) / (2 * R);
        bx = tx + ((c[0] - b[0]) / L2 - tx) * w; bz = tz + ((c[1] - b[1]) / L2 - tz) * w;
      } else if (q < s[i] + R && i > 0) {
        const c = pts[i - 1], L0 = s[i] - s[i - 1] || 1e-6, w = 0.5 - (q - s[i]) / (2 * R);
        bx = tx + ((a[0] - c[0]) / L0 - tx) * w; bz = tz + ((a[1] - c[1]) / L0 - tz) * w;
      }
      const bl = Math.hypot(bx, bz) || 1;
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx: bx / bl, tz: bz / bl };
    },
    bendAhead(q, look) {
      let m = 0;
      for (let i = idx(q) + 1; i < pts.length && s[i] < q + look; i++) m = Math.max(m, turn[i]);
      return m;
    },
  };
}

// 3D flight path [x, y, z, speed] with arc length.
function makeAirPath(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const length = s[s.length - 1];
  return {
    s: 0, length,
    at(q) {
      q = clamp(q, 0, length);
      let lo = 0, hi = s.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= q) lo = m; else hi = m; }
      const a = pts[lo], b = pts[Math.min(lo + 1, pts.length - 1)], L = s[lo + 1] - s[lo] || 1e-6, t = (q - s[lo]) / L;
      return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + (b[2] - a[2]) * t, v: a[3] + (b[3] - a[3]) * t };
    },
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
