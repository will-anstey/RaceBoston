// Trains on the surface and elevated rail network: Red Line over the
// Longfellow, Green Line down Huntington and Comm Ave, commuter rail into
// North and South Station, Amtrak, Orange Line, Grand Junction freight.
// Trains follow the OSM track graph (preferring track their line uses),
// dwell at stops, reverse at terminals, and dive into / emerge from tunnel
// portals (the ground mask hides them once they're underground).

import * as THREE from 'three';
import { RAIL_SVC, RAIL_NODE, RAIL_WAY } from './mapdata.js';
import { clamp } from './util.js';
import { globalUniforms } from './materials.js';

const SERVICES = [
  { id: 'red', bit: RAIL_SVC.RED, color: 0xda291c, model: 'metro', cars: 6, len: 21.2, wid: 3.05, hgt: 3.7, speed: 18, dwell: 14, weight: 4 },
  { id: 'orange', bit: RAIL_SVC.ORANGE, color: 0xed8b00, model: 'metro', cars: 6, len: 19.8, wid: 3.05, hgt: 3.7, speed: 18, dwell: 14, weight: 3 },
  { id: 'blue', bit: RAIL_SVC.BLUE, color: 0x003da5, model: 'metro', cars: 6, len: 14.8, wid: 2.8, hgt: 3.5, speed: 17, dwell: 12, weight: 2 },
  // Green Line: two articulated LRVs = four 11 m sections.
  { id: 'green', bit: RAIL_SVC.GREEN, color: 0x00843d, model: 'lrv', cars: 4, len: 11.2, wid: 2.65, hgt: 3.6, speed: 11, dwell: 12, weight: 4, gap: 0.25 },
  { id: 'commuter', bit: RAIL_SVC.COMMUTER, color: 0x80276c, model: 'bilevel', cars: 6, len: 25.9, wid: 3.2, hgt: 4.6, speed: 21, dwell: 24, weight: 4, loco: 'mbta' },
  { id: 'amtrak', bit: RAIL_SVC.AMTRAK, color: 0x1d4f91, model: 'coach', cars: 6, len: 25.9, wid: 3.2, hgt: 4.1, speed: 23, dwell: 24, weight: 1, loco: 'amtrak' },
  { id: 'freight', bit: RAIL_SVC.FREIGHT, color: 0x6b3f2a, model: 'boxcar', cars: 7, len: 16.5, wid: 3.1, hgt: 4.1, speed: 8, dwell: 0, weight: 1, loco: 'freight' },
];
const LOCO_LEN = 20.5;
const MAX_PER_SVC = 12;
const LOOKAHEAD = 320;

// ---------------------------------------------------------------- models
function boxGeo(w, h, d, x, y, z, color) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
function merge(parts) {
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nrm.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

// Returns { body, glass } geometries for a car (front = -z, rail at y = 0).
function carModel(kind, svc, len) {
  const W = svc.wid, H = svc.hgt, L = len;
  const body = [], glass = [];
  const floor = 1.0;
  // Bogies and underframe.
  for (const z of [-L * 0.36, L * 0.36]) body.push(boxGeo(W * 0.78, 0.75, 2.6, 0, 0.45, z, 0x1b1c1f));
  body.push(boxGeo(W * 0.9, 0.35, L * 0.9, 0, 0.82, 0, 0x2a2c30));
  const side = (y0, y1, color, inset = 0) => body.push(boxGeo(W + 0.02 - inset, y1 - y0, L - 0.1, 0, (y0 + y1) / 2, 0, color));
  // Window band: a row of separate panes along both sides.
  const panes = (y0, y1, pitch, frac, z0 = -L / 2 + 1.2, z1 = L / 2 - 1.2) => {
    for (let z = z0 + pitch / 2; z < z1; z += pitch) glass.push(boxGeo(W + 0.06, y1 - y0, pitch * frac, 0, (y0 + y1) / 2, z, 0x1a232c));
  };
  if (kind === 'metro') {
    side(floor, H - 0.2, 0xc4c9ce);
    side(floor + 0.15, floor + 0.55, svc.color, -0.02);
    body.push(boxGeo(W * 0.92, 0.22, L - 0.4, 0, H - 0.09, 0, 0x9ea4a9));
    panes(floor + 0.95, floor + 1.85, 1.9, 0.7);
    for (const s of [-1, 1]) body.push(boxGeo(W * 0.95, H - floor - 0.3, 0.12, 0, (floor + H - 0.2) / 2, s * (L / 2 - 0.02), svc.color));
    for (const s of [-1, 1]) glass.push(boxGeo(W * 0.6, 0.9, 0.14, 0, floor + 1.45, s * (L / 2 - 0.02), 0x1a232c));
  } else if (kind === 'lrv') {
    side(floor, H - 0.25, 0xe4e6e1);
    side(floor, floor + 0.7, svc.color, -0.02);
    body.push(boxGeo(W * 0.9, 0.3, L - 0.6, 0, H - 0.12, 0, 0x8d9296));
    panes(floor + 0.9, floor + 2.0, 1.6, 0.78);
    // Pantograph frame on the roof.
    body.push(boxGeo(0.08, 0.08, 2.2, -0.5, H + 0.75, 0, 0x2a2c30), boxGeo(0.08, 0.08, 2.2, 0.5, H + 0.75, 0, 0x2a2c30));
    body.push(boxGeo(1.6, 0.06, 0.25, 0, H + 0.82, 0, 0x2a2c30));
    for (const s of [-1, 1]) glass.push(boxGeo(W * 0.85, 1.2, 0.14, 0, floor + 1.5, s * (L / 2 - 0.05), 0x172029));
  } else if (kind === 'bilevel') {
    side(floor, H - 0.3, 0xc3c7cb);
    side(floor + 0.2, floor + 0.45, svc.color, -0.02);
    side(H - 0.75, H - 0.55, svc.color, -0.02);
    body.push(boxGeo(W * 0.9, 0.32, L - 0.5, 0, H - 0.15, 0, 0xa6abb0));
    panes(floor + 0.75, floor + 1.4, 1.5, 0.72);
    panes(floor + 1.95, floor + 2.6, 1.5, 0.72);
  } else if (kind === 'coach') {
    side(floor, H - 0.3, 0xc6c9cc);
    side(floor + 0.35, floor + 0.62, 0x1d4f91, -0.02);
    side(floor + 0.62, floor + 0.72, 0xb3262e, -0.02);
    body.push(boxGeo(W * 0.9, 0.35, L - 0.5, 0, H - 0.15, 0, 0xa9adb1));
    panes(floor + 1.0, floor + 1.85, 1.8, 0.72);
  } else if (kind === 'boxcar') {
    side(floor, H, svc.color);
    for (let z = -L / 2 + 1; z < L / 2; z += 1.4) body.push(boxGeo(W + 0.06, H - floor - 0.2, 0.08, 0, (floor + H) / 2, z, 0x4e2e1f));
    body.push(boxGeo(2.6, H - floor - 0.4, 0.1, W / 2 + 0.02, (floor + H) / 2, 0, 0x553322));
  } else if (kind === 'loco') {
    const paint = svc.loco === 'mbta' ? 0x3b3e46 : svc.loco === 'amtrak' ? 0xbfc3c7 : 0x23374f;
    const stripe = svc.loco === 'mbta' ? svc.color : svc.loco === 'amtrak' ? 0xb3262e : 0xe8b623;
    side(floor, H - 0.25, paint);
    side(floor + 0.3, floor + 0.65, stripe, -0.02);
    body.push(boxGeo(W * 0.9, 0.3, L - 0.6, 0, H - 0.1, 0, 0x55595f));
    // Cab at the front with a windscreen.
    glass.push(boxGeo(W * 0.85, 0.8, 0.15, 0, H - 1.15, -L / 2 - 0.02, 0x1a232c));
    glass.push(boxGeo(W + 0.05, 0.7, 2.2, 0, H - 1.15, -L / 2 + 1.4, 0x1a232c));
    body.push(boxGeo(W * 0.9, 0.5, 0.25, 0, floor + 0.3, -L / 2 - 0.1, stripe));
  }
  return { body: merge(body), glass: glass.length ? merge(glass) : null };
}

// ------------------------------------------------------------- rail graph
class RailNet {
  constructor(map) {
    this.x = map.railNodes;
    this.y = map.railY;
    this.flags = map.railFlags;
    this.ways = map.railWays;
    const N = this.y.length;
    this.N = N;
    const count = new Uint32Array(N + 1);
    for (const w of this.ways) for (let i = 0; i + 1 < w.nodes.length; i++) { count[w.nodes[i] + 1]++; count[w.nodes[i + 1] + 1]++; }
    for (let i = 0; i < N; i++) count[i + 1] += count[i];
    this.start = count;
    this.to = new Int32Array(count[N]);
    this.way = new Int32Array(count[N]);
    const fill = count.slice(0, N);
    this.ways.forEach((w, wi) => {
      for (let i = 0; i + 1 < w.nodes.length; i++) {
        const a = w.nodes[i], b = w.nodes[i + 1];
        this.to[fill[a]] = b; this.way[fill[a]++] = wi;
        this.to[fill[b]] = a; this.way[fill[b]++] = wi;
      }
    });
    // Running edges for spawning, per service bit (no yards or crossovers).
    this.spawnEdges = new Map();
    this.ways.forEach((w, wi) => {
      if (!w.svc || w.flags & (RAIL_WAY.YARD | RAIL_WAY.CROSSOVER)) return;
      for (let bit = 1; bit <= 64; bit <<= 1) {
        if (!(w.svc & bit)) continue;
        if (!this.spawnEdges.has(bit)) this.spawnEdges.set(bit, []);
        const list = this.spawnEdges.get(bit);
        for (let i = 0; i + 1 < w.nodes.length; i++) list.push(w.nodes[i], w.nodes[i + 1]);
      }
    });
  }
  px(n) { return this.x[2 * n]; }
  pz(n) { return this.x[2 * n + 1]; }

  // Next node from `cur` arriving from `prev` for a train with service bit `bit`.
  next(prev, cur, bit) {
    const dx = this.px(cur) - this.px(prev), dz = this.pz(cur) - this.pz(prev);
    const dl = Math.hypot(dx, dz) || 1;
    let best = -1, bw = 0;
    for (let k = this.start[cur]; k < this.start[cur + 1]; k++) {
      const v = this.to[k];
      if (v === prev) continue;
      const w = this.ways[this.way[k]];
      const ex = this.px(v) - this.px(cur), ez = this.pz(v) - this.pz(cur);
      const cos = (dx * ex + dz * ez) / (dl * (Math.hypot(ex, ez) || 1));
      if (cos < 0.55) continue; // trains can't take sharp switches
      let wt = Math.pow(Math.max(0, cos), 6) * (0.6 + Math.random() * 0.4);
      if (w.svc & bit) wt *= 6;
      else if (w.svc) wt *= 1.5;
      if (w.flags & RAIL_WAY.YARD) wt *= 0.25;
      if (w.flags & RAIL_WAY.CROSSOVER) wt *= 0.15;
      if (wt > bw) { bw = wt; best = v; }
    }
    return best;
  }
}

// ---------------------------------------------------------------- trains
export class Trains {
  constructor(game) {
    this.g = game;
    this.net = new RailNet(game.map);
    this.trains = [];
    this.target = 7;
    this.timer = 0;
    this.group = new THREE.Group();
    this.group.name = 'trains';
    game.scene.add(this.group);
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.45, envMapIntensity: 1.1 });
    this.glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.6, envMapIntensity: 1.4, emissive: 0xffe2b0, emissiveIntensity: 0 });
    // Instanced meshes per service (cars) and per loco type.
    this.meshes = new Map();
    const mk = (key, geo, cap) => {
      const body = new THREE.InstancedMesh(geo.body, bodyMat, cap);
      body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      body.frustumCulled = false;
      body.castShadow = true;
      body.receiveShadow = true;
      body.count = 0;
      this.group.add(body);
      let glass = null;
      if (geo.glass) {
        glass = new THREE.InstancedMesh(geo.glass, this.glassMat, cap);
        glass.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        glass.frustumCulled = false;
        glass.count = 0;
        this.group.add(glass);
      }
      this.meshes.set(key, { body, glass, n: 0 });
    };
    for (const s of SERVICES) {
      mk(s.id, carModel(s.model, s, s.len), MAX_PER_SVC * s.cars);
      if (s.loco) mk('loco:' + s.id, carModel('loco', s, LOCO_LEN), MAX_PER_SVC);
    }
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3(1, 1, 1);
    this.carBoxes = [];
  }

  setDensity(trafficSetting) {
    this.target = trafficSetting <= 0 ? 0 : trafficSetting <= 12 ? 4 : trafficSetting <= 26 ? 7 : 10;
  }

  clear() { this.trains.length = 0; }

  // ---- path helpers
  _pt(n) { return { x: this.net.px(n), y: this.net.y[n], z: this.net.pz(n), s: 0, node: n }; }

  // Virtual track past a portal (descending) or the map edge (level).
  _virtual(a, b, kind, step = 20) {
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    const dy = kind === 'portal' ? -step * 0.075 : 0;
    return { x: b.x + (dx / l) * step, y: Math.max(-40, b.y + dy), z: b.z + (dz / l) * step, s: b.s + Math.hypot(step, dy), node: -1, virtual: kind };
  }

  _extend(t) {
    const pts = t.pts;
    while (pts[pts.length - 1].s - t.head < LOOKAHEAD && t.endS === null) {
      const b = pts[pts.length - 1], a = pts[pts.length - 2];
      if (b.virtual || b.node < 0) { pts.push(this._virtual(a, b, b.virtual || 'edge')); continue; }
      const n = a.node >= 0 ? this.net.next(a.node, b.node, t.svc.bit) : -1;
      if (n < 0) {
        const f = this.net.flags[b.node];
        if (f & RAIL_NODE.PORTAL) { pts.push(this._virtual(a, b, 'portal')); continue; }
        if (f & RAIL_NODE.EDGE) { pts.push(this._virtual(a, b, 'edge')); continue; }
        t.endS = b.s; // terminal: stop at the buffer and reverse
        break;
      }
      const p = this._pt(n);
      p.s = b.s + Math.hypot(p.x - b.x, p.y - b.y, p.z - b.z);
      if (this.net.flags[n] & RAIL_NODE.STOP && t.svc.dwell > 0 && p.s > t.head + 5) t.stops.push(p.s);
      pts.push(p);
    }
    // Drop track well behind the tail.
    const tail = t.head - t.length - 30;
    let cut = 0;
    while (cut + 2 < pts.length && pts[cut + 1].s < tail) cut++;
    if (cut) pts.splice(0, cut);
  }

  _sample(t, s, out) {
    const pts = t.pts;
    let lo = 0, hi = pts.length - 1;
    if (s <= pts[0].s) { lo = 0; hi = 1; }
    else if (s >= pts[hi].s) { lo = hi - 1; }
    else while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].s <= s) lo = mid; else hi = mid; }
    const a = pts[lo], b = pts[Math.min(lo + 1, pts.length - 1)];
    const f = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
    out.x = a.x + (b.x - a.x) * f; out.y = a.y + (b.y - a.y) * f; out.z = a.z + (b.z - a.z) * f;
    return out;
  }

  // ---- spawning
  // Edges of a service within the spawn ring around the focus.
  _nearEdges(bit, focus) {
    const E = this.net.spawnEdges.get(bit) || [], out = [];
    for (let e = 0; e < E.length; e += 2) {
      const a = E[e];
      const d = Math.hypot(this.net.px(a) - focus.x, this.net.pz(a) - focus.z);
      if (d > 120 && d < 1500) out.push(E[e], E[e + 1]);
    }
    return out;
  }

  _spawn(focus) {
    const net = this.net;
    const cam = this.g.camera;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    // Weighted pick among services with track nearby, so short visible
    // stretches (the Red Line on the Longfellow) still get trains.
    const near = SERVICES.map((s) => [s, this._nearEdges(s.bit, focus)]).filter(([s, e]) => e.length && this.trains.filter((t) => t.svc === s).length < MAX_PER_SVC);
    if (!near.length) return;
    for (let attempt = 0; attempt < 30; attempt++) {
      let r = Math.random() * near.reduce((acc, [s]) => acc + s.weight, 0);
      let pick = near[0];
      for (const n of near) { if ((r -= n[0].weight) < 0) { pick = n; break; } }
      const [svc, E] = pick;
      const e = 2 * Math.floor(Math.random() * (E.length / 2));
      let a = E[e], b = E[e + 1];
      const mx = (net.px(a) + net.px(b)) / 2, mz = (net.pz(a) + net.pz(b)) / 2;
      const d = Math.hypot(mx - focus.x, mz - focus.z);
      // Don't pop into view nearby (unless next to a portal, where it's underground).
      const nearPortal = net.flags[a] & RAIL_NODE.PORTAL || net.flags[b] & RAIL_NODE.PORTAL;
      const vis = ((mx - cam.position.x) * fwd.x + (mz - cam.position.z) * fwd.z) / Math.max(1, Math.hypot(mx - cam.position.x, mz - cam.position.z));
      if (!nearPortal && vis > 0.45 && d < 650) continue;
      if (Math.random() < 0.5) [a, b] = [b, a];
      const t = this._make(svc, a, b);
      if (!t) continue;
      // Keep trains apart on the same track.
      const h = this._sample(t, t.head, {});
      if (this.trains.some((o) => { const q = this._sample(o, o.head - o.length / 2, {}); return Math.hypot(q.x - h.x, q.z - h.z) < o.length + t.length; })) continue;
      this.trains.push(t);
      return;
    }
  }

  _make(svc, a, b) {
    const net = this.net;
    const cars = [];
    const n = svc.cars;
    for (let i = 0; i < n; i++) cars.push(svc.loco && i === 0 ? { key: 'loco:' + svc.id, len: LOCO_LEN } : { key: svc.id, len: svc.len });
    const gap = svc.gap ?? 0.9;
    const length = cars.reduce((acc, c) => acc + c.len, 0) + gap * (n - 1);
    // Walk backward from a (away from b) to lay the train's body.
    const back = [this._pt(b), this._pt(a)];
    let acc = Math.hypot(back[1].x - back[0].x, back[1].z - back[0].z);
    while (acc < length + 40) {
      const q = back[back.length - 2], p = back[back.length - 1];
      if (p.node < 0) { const v = this._virtual(q, p, p.virtual); acc += 20; back.push(v); continue; }
      const nx = net.next(q.node, p.node, svc.bit);
      if (nx < 0) {
        const f = net.flags[p.node];
        if (f & (RAIL_NODE.PORTAL | RAIL_NODE.EDGE)) { const v = this._virtual(q, p, f & RAIL_NODE.PORTAL ? 'portal' : 'edge'); acc += 20; back.push(v); continue; }
        return null; // would hang off a buffer stop
      }
      const pt = this._pt(nx);
      acc += Math.hypot(pt.x - p.x, pt.z - p.z);
      back.push(pt);
    }
    const pts = back.reverse();
    pts[0].s = 0;
    for (let i = 1; i < pts.length; i++) pts[i].s = pts[i - 1].s + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
    const t = {
      svc, cars, gap, length, pts, head: pts[pts.length - 1].s, v: svc.speed * 0.7,
      stops: [], endS: null, dwell: 0, served: -1, life: 0,
    };
    this._extend(t);
    return t;
  }

  _reverse(t) {
    const pts = t.pts;
    const total = pts[pts.length - 1].s;
    const tail = t.head - t.length;
    t.pts = pts.slice().reverse().map((p) => ({ ...p, s: total - p.s }));
    t.head = total - tail;
    t.cars.reverse();
    t.endS = null;
    t.stops = [];
    t.v = 0;
    // Stops already on the (reversed) track ahead.
    for (const p of t.pts) if (p.node >= 0 && this.net.flags[p.node] & RAIL_NODE.STOP && p.s > t.head + 5) t.stops.push(p.s);
    this._extend(t);
  }

  // ---- update
  update(dt, focus) {
    this.timer -= dt;
    if (this.timer <= 0 && this.trains.length < this.target) { this.timer = 1.5; this._spawn(focus); }
    const tmp = {}, tmp2 = {};
    for (let i = this.trains.length - 1; i >= 0; i--) {
      const t = this.trains[i];
      t.life += dt;
      // Speed: line speed, slower in curves, braking for stops and buffers.
      let vt = t.svc.speed;
      const bend = this._bendAhead(t);
      vt = Math.min(vt, Math.max(5, t.svc.speed * (1 - bend * 2.2)));
      const nextStop = t.stops.length ? t.stops[0] : Infinity;
      const stopAt = Math.min(nextStop, t.endS === null ? Infinity : t.endS - 2);
      if (stopAt < Infinity) vt = Math.min(vt, Math.sqrt(2 * 0.8 * Math.max(0, stopAt - t.head)));
      if (t.dwell > 0) {
        t.dwell -= dt;
        vt = 0;
        if (t.dwell <= 0) {
          if (t.endS !== null && Math.abs(t.head - (t.endS - 2)) < 3) { this._reverse(t); continue; }
          t.stops.shift();
        }
      } else if (stopAt - t.head < 0.8 && t.v < 0.6) {
        t.v = 0;
        t.dwell = t.endS !== null && stopAt === t.endS - 2 ? 25 : t.svc.dwell;
      }
      const acc = vt > t.v ? 0.75 : -1.1;
      t.v = clamp(t.v + acc * dt, Math.min(t.v, vt), Math.max(t.v, vt));
      if (t.dwell <= 0) t.head += t.v * dt;
      while (t.stops.length && t.stops[0] < t.head - 1) t.stops.shift();
      this._extend(t);
      // Despawn: fully underground, or far from the focus.
      const hp = this._sample(t, t.head, tmp), tp = this._sample(t, t.head - t.length, tmp2);
      const far = Math.min(Math.hypot(hp.x - focus.x, hp.z - focus.z), Math.hypot(tp.x - focus.x, tp.z - focus.z)) > 1900;
      const buried = hp.y < -6 && tp.y < -6;
      const lost = t.life > 600 && t.v < 0.1 && t.dwell <= 0;
      if (far || (buried && t.life > 3) || lost) this.trains.splice(i, 1);
    }
    this._render();
  }

  _bendAhead(t) {
    const a = this._sample(t, t.head, {}), b = this._sample(t, t.head + 25, {}), c = this._sample(t, t.head + 50, {});
    const ux = b.x - a.x, uz = b.z - a.z, vx = c.x - b.x, vz = c.z - b.z;
    const cos = (ux * vx + uz * vz) / ((Math.hypot(ux, uz) || 1) * (Math.hypot(vx, vz) || 1));
    return Math.acos(clamp(cos, -1, 1));
  }

  _render() {
    for (const m of this.meshes.values()) m.n = 0;
    this.carBoxes.length = 0;
    const f = {}, r = {};
    const night = globalUniforms.uNight.value;
    this.glassMat.emissiveIntensity = night * 1.3;
    for (const t of this.trains) {
      let s = t.head;
      for (const car of t.cars) {
        const sf = s - car.len * 0.14, sr = s - car.len * 0.86;
        this._sample(t, sf, f);
        this._sample(t, sr, r);
        const cx = (f.x + r.x) / 2, cy = (f.y + r.y) / 2, cz = (f.z + r.z) / 2;
        const dx = f.x - r.x, dz = f.z - r.z, dy = f.y - r.y;
        const yaw = Math.atan2(dx, -dz);
        const pitch = Math.atan2(dy, Math.hypot(dx, dz));
        const m = this.meshes.get(car.key);
        if (m && m.n < m.body.instanceMatrix.count) {
          this._e.set(pitch, -yaw, 0, 'YXZ');
          this._q.setFromEuler(this._e);
          this._m.compose(this._p.set(cx, cy, cz), this._q, this._s);
          m.body.setMatrixAt(m.n, this._m);
          if (m.glass) m.glass.setMatrixAt(m.n, this._m);
          m.n++;
        }
        const hl = car.len / 2, l = Math.hypot(dx, dz) || 1;
        this.carBoxes.push(cx, cy, cz, dx / l, dz / l, hl, t.svc.wid / 2, t.v, t.svc.color);
        s -= car.len + t.gap;
      }
    }
    for (const m of this.meshes.values()) {
      m.body.count = m.n;
      m.body.visible = m.n > 0;
      m.body.instanceMatrix.needsUpdate = true;
      if (m.glass) { m.glass.count = m.n; m.glass.visible = m.n > 0; m.glass.instanceMatrix.needsUpdate = true; }
    }
  }

  // Trains are immovable: push the player's car out and bounce it.
  collidePlayer(car) {
    const B = this.carBoxes, h = car.h;
    const fx = Math.sin(car.heading), fz = -Math.cos(car.heading);
    let hit = 0;
    for (let i = 0; i < B.length; i += 9) {
      const cx = B[i], cy = B[i + 1], cz = B[i + 2], dx = B[i + 3], dz = B[i + 4], hl = B[i + 5], hw = B[i + 6], tv = B[i + 7];
      if (Math.abs(car.y - cy) > 3 || Math.abs(car.x - cx) > hl + 6 || Math.abs(car.z - cz) > hl + 6) continue;
      for (const off of h.circles) {
        const px = car.x + fx * off, pz = car.z + fz * off;
        const along = clamp((px - cx) * dx + (pz - cz) * dz, -hl, hl);
        const qx = cx + dx * along, qz = cz + dz * along;
        let nx = px - qx, nz = pz - qz;
        const d = Math.hypot(nx, nz);
        const pen = h.radius + hw - d;
        if (pen <= 0) continue;
        if (d < 1e-4) { nx = -dz; nz = dx; } else { nx /= d; nz /= d; }
        car.x += nx * pen; car.z += nz * pen;
        const rvx = car.vx - dx * tv, rvz = car.vz - dz * tv;
        const vn = rvx * nx + rvz * nz;
        if (vn < 0) {
          car.vx -= 1.25 * vn * nx; car.vz -= 1.25 * vn * nz;
          car.yawRate *= 0.5;
          hit = Math.max(hit, -vn);
        }
      }
    }
    if (hit > car.impact) { car.impact = hit; car.impactKind = 6; }
  }

  // Minimap dots: [x, z, color] per car.
  positions() {
    const out = [], B = this.carBoxes;
    for (let i = 0; i < B.length; i += 9) out.push([B[i], B[i + 2], B[i + 8]]);
    return out;
  }

  // Loudness for the rumble sound near the focus point.
  rumble(x, z) {
    let level = 0;
    const B = this.carBoxes;
    for (let i = 0; i < B.length; i += 9) {
      const d = Math.hypot(B[i] - x, B[i + 2] - z);
      if (d < 140) level += Math.min(1, Math.abs(B[i + 7]) / 15) * Math.exp(-d / 35);
    }
    return Math.min(1, level);
  }
}
