// Boats on the Charles: the river's centre line (RiverPath), hull physics for
// the boat you drive (BoatBody: motorboat, rowboat, single scull, eight),
// procedural models with animated oars and rowers, and the AI river traffic
// (Boats): crews out rowing, coach launches and motorboats, and, once the
// river freezes, icebreakers cutting channels through it. Plus foam wakes and
// broken ice slabs. Models face -z; headings are compass angles as for cars.

import * as THREE from 'three';
import { clamp, damp, wrapAngle, mulberry32 } from './util.js';

// Boats you can take out. Rowing speeds are faster than real life (a real
// eight does the Head of the Charles at ~6 m/s) so a race takes minutes, not
// a quarter of an hour.
export const BOAT_TYPES = {
  motor: {
    name: 'Motorboat', desc: 'Outboard runabout: 90 mph flat out, Shift for more punch', motor: true,
    // Thrust is accel * (1 - (v / top)^curve): top (40.2 m/s, 90 mph) is the true top speed; hull
    // drag only slows it off the throttle. Shift is more thrust, not more speed.
    len: 6.4, beam: 2.4, top: 40.2, accel: 8, curve: 3.5, reverse: 3.2, drag: 0.006, turnR: 11, maxYaw: 1.0, lat: 2.2, cam: 1.25, eyeF: -0.4, eyeH: 1.75,
  },
  dinghy: {
    name: 'Rowboat', desc: 'A wooden rowboat with a pair of oars: no hurry', row: true, scull: true, seats: 1,
    len: 3.8, beam: 1.35, rate: 24, sprintRate: 30, speed: 2.9, sprint: 3.7, drag: 0.1, back: 1.0, turnR: 5, spin: 0.75, lat: 6, cam: 0.85, eyeF: 1.5, eyeH: 1.15,
  },
  single: {
    name: 'Single scull', desc: 'One sculler in 8 m of carbon fibre', row: true, scull: true, seats: 1,
    len: 8.2, beam: 0.32, rate: 30, sprintRate: 37, speed: 8.2, sprint: 10.2, drag: 0.016, back: 1.0, turnR: 22, spin: 0.38, lat: 9, cam: 1.2, eyeF: 3.5, eyeH: 0.85,
  },
  eight: {
    name: 'Eight', desc: 'Eight rowers and a cox: the fastest boat on the river', row: true, seats: 8, cox: true,
    len: 17.6, beam: 0.62, rate: 32, sprintRate: 39, speed: 10.2, sprint: 12.6, drag: 0.011, back: 1.2, turnR: 46, spin: 0.22, lat: 9, cam: 2.3, eyeF: -7.1, eyeH: 1.0,
  },
  // A 26 m river icebreaker: 60 mph flat out but slow to get going (0-30 in about 11 s, 0-50 in
  // 21 s) and slow to stop (about 165 m from 60 mph). Ice slows it a little and breaks; only a
  // bridge too low for its 6.4 m superstructure (or a bank) stops it. A bow thruster turns it
  // when it's barely moving, for docking.
  icebreaker: {
    name: 'Icebreaker', desc: 'A 26 m river icebreaker: 60 mph flat out, slow to get going, and ice is no obstacle', motor: true, breaker: true, noBoost: true,
    len: 26, beam: 7.2, top: 26.8, accel: 1.3, curve: 3, reverse: 1.4, drag: 0.0012, turnR: 40, maxYaw: 0.32, wash: 0.12, thruster: 0.14, yawResp: 1.1, lat: 1.3,
    airDraft: 6.6, speed: 2.6, cam: 3.0, camLift: 7, eyeF: 0.7, eyeH: 5.4,
  },
};
export const BOAT_ORDER = ['motor', 'dinghy', 'single', 'eight', 'icebreaker'];
// River traffic only.
const AI_TYPES = {
  ...BOAT_TYPES,
  four: { ...BOAT_TYPES.eight, name: 'Four', seats: 4, cox: false, len: 13.4, beam: 0.55, speed: 9.2, sprint: 11.2 },
  launch: { ...BOAT_TYPES.motor, name: 'Coach launch', len: 5.2, beam: 1.9, top: 12 },
};
// Air draft of the icebreakers (mast top 6.4 m, plus a margin): they only work the reaches
// between bridges they fit under. Clearance is to the road surface, so a deck's slab comes off.
const AIR_DRAFT = BOAT_TYPES.icebreaker.airDraft;
export const SLAB = 1.3;

// The icebreaker's deck, for passengers: deck height along the hull (bow sheer rises), the
// gangway port either side just forward of the deckhouse, and standing room on the foredeck.
export const BREAKER = {
  sheer: 2.0, gangX: 3.45, gangZ: -1.9,
  deckY(z) { const t = (z + 13) / 26; return 2.0 + 0.7 * Math.max(0, 1 - t / 0.5) ** 2 + 0.01; },
  halfWidth(z) { const t = (z + 13) / 26; return 3.6 * (t < 0.32 ? Math.sin((Math.PI / 2) * (t / 0.32)) ** 0.75 : 1 - 0.14 * Math.max(0, (t - 0.75) / 0.25)); },
  slots: [-6.9, -5.9, -4.9, -3.9, -2.9].flatMap((z) => [-1.8, -0.6, 0.6, 1.8].map((x) => [x, z])),
};

// Crew colours: jersey, oar blade, blade tip.
export const CLUBS = [
  { name: 'Harvard', jersey: 0xa51c30, blade: 0xa51c30, tip: 0xffffff },
  { name: 'Boston University', jersey: 0xcc0000, blade: 0xffffff, tip: 0xcc0000 },
  { name: 'MIT', jersey: 0x8a1c2b, blade: 0x9a9b9c, tip: 0x8a1c2b },
  { name: 'Northeastern', jersey: 0x1a1a1a, blade: 0xd41b2c, tip: 0x1a1a1a },
  { name: 'Riverside BC', jersey: 0x1f4e9c, blade: 0x1f4e9c, tip: 0xf2c12e },
  { name: 'Cambridge BC', jersey: 0x1d6b3a, blade: 0x1d6b3a, tip: 0xffffff },
  { name: 'Union BC', jersey: 0x0b2a5b, blade: 0xffffff, tip: 0x0b2a5b },
  { name: 'Community Rowing', jersey: 0xf28c28, blade: 0x26377a, tip: 0xf28c28 },
  { name: 'Boston College', jersey: 0x8b1e3f, blade: 0xbc9b6a, tip: 0x8b1e3f },
  { name: 'Yale', jersey: 0x00356b, blade: 0x00356b, tip: 0xffffff },
  { name: 'Princeton', jersey: 0xf58025, blade: 0x1a1a1a, tip: 0xf58025 },
  { name: 'Leander', jersey: 0xe8749a, blade: 0xe8749a, tip: 0xffffff },
];
export const PLAYER_CLUB = { name: 'Race Boston', jersey: 0xc8102e, blade: 0xc8102e, tip: 0xffd447 };
const SHELL_COLORS = [0xf4f1e8, 0xf2d23a, 0xf4f1e8, 0xb8c4cf, 0xf4f1e8, 0x2b2f36];

// ================================================================ the river
// Centre line [x, z, bank distance right, left (facing downstream)] every 10 m,
// from the upstream edge of the map (s = 0) down to the Museum of Science dam.
// Lateral offsets d are measured toward the right bank, along (-tz, tx).
export class RiverPath {
  constructor(flat) {
    const n = (this.n = Math.floor(flat.length / 4));
    this.x = new Float32Array(n); this.z = new Float32Array(n);
    this.right = new Float32Array(n); this.left = new Float32Array(n);
    this.s = new Float32Array(n); this.tx = new Float32Array(n); this.tz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = flat[4 * i]; this.z[i] = flat[4 * i + 1]; this.right[i] = flat[4 * i + 2]; this.left[i] = flat[4 * i + 3];
      if (i) this.s[i] = this.s[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      const dx = this.x[b] - this.x[a], dz = this.z[b] - this.z[a], l = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / l; this.tz[i] = dz / l;
    }
    this.length = n ? this.s[n - 1] : 0;
  }

  index(s) {
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.s[m] <= s) lo = m; else hi = m; }
    return Math.min(lo, Math.max(0, this.n - 2));
  }

  at(s, d = 0, out = {}) {
    s = clamp(s, 0, this.length);
    const i = this.index(s), j = Math.min(this.n - 1, i + 1);
    const t = clamp((s - this.s[i]) / (this.s[j] - this.s[i] || 1), 0, 1);
    let tx = this.tx[i] + (this.tx[j] - this.tx[i]) * t, tz = this.tz[i] + (this.tz[j] - this.tz[i]) * t;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    out.x = this.x[i] + (this.x[j] - this.x[i]) * t - tz * d;
    out.z = this.z[i] + (this.z[j] - this.z[i]) * t + tx * d;
    out.tx = tx; out.tz = tz; out.i = i;
    out.right = this.right[i] + (this.right[j] - this.right[i]) * t;
    out.left = this.left[i] + (this.left[j] - this.left[i]) * t;
    return out;
  }

  // Nearest point on the line: distance along it (s), lateral offset (d), and how far off it is.
  project(x, z, hint = null, out = {}) {
    let i0 = 0, i1 = this.n - 2;
    if (hint !== null && hint !== undefined) { const k = this.index(hint); i0 = Math.max(0, k - 30); i1 = Math.min(this.n - 2, k + 30); }
    let best = Infinity, bs = 0, bd = 0;
    for (let i = i0; i <= i1; i++) {
      const ax = this.x[i], az = this.z[i], dx = this.x[i + 1] - ax, dz = this.z[i + 1] - az, l2 = dx * dx + dz * dz || 1e-9;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
      const cx = ax + dx * t, cz = az + dz * t, d2 = (x - cx) ** 2 + (z - cz) ** 2;
      if (d2 < best) { best = d2; const l = Math.sqrt(l2); bs = this.s[i] + t * l; bd = ((x - cx) * -dz + (z - cz) * dx) / l; }
    }
    out.s = bs; out.d = bd; out.dist = Math.sqrt(best);
    return out;
  }

  // Compass heading along the line (dir +1 downstream, -1 upstream).
  heading(s, dir) {
    const p = this.at(s, 0, this._h || (this._h = {}));
    return Math.atan2(p.tx * dir, -p.tz * dir);
  }
}

// ================================================================ models
function col(g, hex) {
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[3 * i] = c.r; a[3 * i + 1] = c.g; a[3 * i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function merge(parts) {
  const geos = parts.filter(Boolean).map((g) => (g.index ? g.toNonIndexed() : g));
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
function box(w, h, d, x, y, z, hex) { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return col(g, hex); }
function cyl(rt, rb, h, x, y, z, hex, seg = 12) { const g = new THREE.CylinderGeometry(rt, rb, h, seg); g.translate(x, y, z); return col(g, hex); }
function ball(r, x, y, z, hex) { const g = new THREE.SphereGeometry(r, 10, 7); g.translate(x, y, z); return col(g, hex); }
// A square bar from one point to another.
function bar(ax, ay, az, bx, by, bz, t, hex) {
  const L = Math.hypot(bx - ax, by - ay, bz - az), g = new THREE.BoxGeometry(t, t, L);
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(ax, ay, az), new THREE.Vector3(bx, by, bz), new THREE.Vector3(0, 1, 0));
  m.setPosition((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  g.applyMatrix4(m);
  return col(g, hex);
}

// Loft a hull through stations [z, half width, depth below the water, sheer
// above it] from bow (-z) to stern. Each section runs gunwale - keel - gunwale;
// full > 1 makes the sections boxier. Colours by height: bottom below boot,
// top above, stripe above stripeY.
function hullGeo(stations, { top, bottom, boot = 0.02, stripe = null, stripeY = Infinity, full = 1, deck = null, deckAt = () => false, transom = false }) {
  const K = 5, per = 2 * K + 1, pos = [], cols = [], idx = [];
  const C = (hex) => new THREE.Color(hex);
  const cTop = C(top), cBot = C(bottom), cStr = stripe !== null ? C(stripe) : null;
  for (const [z, w, d, sh] of stations) {
    for (let k = -K; k <= K; k++) {
      const a = (Math.abs(k) / K) * (Math.PI / 2);
      const x = Math.sign(k) * w * Math.pow(Math.sin(a), 1 / full);
      const y = -d + (sh + d) * Math.pow(1 - Math.cos(a), 1 / full);
      pos.push(x, y, z);
      const c = y < boot ? cBot : cStr && y > stripeY ? cStr : cTop;
      cols.push(c.r, c.g, c.b);
    }
  }
  for (let r = 0; r + 1 < stations.length; r++) {
    for (let k = 0; k + 1 < per; k++) {
      const a = r * per + k, b = a + 1, c = a + per, e = c + 1;
      idx.push(a, c, b, b, c, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const parts = [g];
  // Decks over the covered parts, and a transom across the stern.
  const dk = [], dc = [];
  if (deck !== null) {
    const cd = C(deck);
    for (let r = 0; r + 1 < stations.length; r++) {
      const [z0, w0, , s0] = stations[r], [z1, w1, , s1] = stations[r + 1];
      if (!deckAt(z0) || !deckAt(z1)) continue;
      dk.push(-w0, s0 + 0.01, z0, w0, s0 + 0.01, z0, w1, s1 + 0.01, z1, -w0, s0 + 0.01, z0, w1, s1 + 0.01, z1, -w1, s1 + 0.01, z1);
      for (let q = 0; q < 6; q++) dc.push(cd.r, cd.g, cd.b);
    }
  }
  if (transom) {
    const st = stations[stations.length - 1], base = (stations.length - 1) * per;
    const cy = (st[3] - st[2]) / 2;
    for (let k = 0; k + 1 < per; k++) {
      dk.push(0, cy, st[0], pos[3 * (base + k)], pos[3 * (base + k) + 1], st[0], pos[3 * (base + k + 1)], pos[3 * (base + k) + 4], st[0]);
      for (let q = 0; q < 3; q++) dc.push(cTop.r, cTop.g, cTop.b);
    }
  }
  if (dk.length) {
    const t = new THREE.BufferGeometry();
    t.setAttribute('position', new THREE.Float32BufferAttribute(dk, 3));
    t.setAttribute('color', new THREE.Float32BufferAttribute(dc, 3));
    t.computeVertexNormals();
    parts.push(t);
  }
  return parts;
}

// A seated figure facing +z (toward a shell's stern), pelvis at the origin.
const figureCache = new Map();
function figureGeo(jersey, standing = false) {
  const key = jersey + (standing ? 's' : '');
  if (figureCache.has(key)) return figureCache.get(key);
  const skin = 0xe0ac84, shorts = 0x22252b, lift = standing ? 0.55 : 0;
  const parts = [
    box(0.36, 0.5, 0.22, 0, 0.33 + lift, 0, jersey),
    ball(0.11, 0, 0.71 + lift, 0.02, skin),
    box(0.07, 0.07, 0.42, 0.17, 0.46 + lift, 0.2, skin),
    box(0.07, 0.07, 0.42, -0.17, 0.46 + lift, 0.2, skin),
  ];
  if (standing) parts.push(box(0.3, 0.6, 0.16, 0, 0.32, 0, shorts));
  else parts.push(box(0.32, 0.12, 0.46, 0, 0.06, 0.22, shorts), box(0.28, 0.32, 0.1, 0, -0.05, 0.47, skin));
  const g = merge(parts);
  figureCache.set(key, g);
  return g;
}

// An oar along +x from its pin: handle inboard, blade (squared: face along z) outboard.
const oarCache = new Map();
function oarGeo(inboard, outboard, club) {
  const key = `${inboard}:${outboard}:${club.blade}:${club.tip}`;
  if (oarCache.has(key)) return oarCache.get(key);
  const L = inboard + outboard, sx = (outboard - 0.45 - inboard) / 2;
  const g = merge([
    box(L - 0.45, 0.04, 0.04, sx, 0, 0, 0xe9e9e4),
    box(0.3, 0.05, 0.05, -inboard + 0.15, 0, 0, 0x2a2a2a),
    box(0.4, 0.2, 0.02, outboard - 0.3, 0, 0, club.blade),
    box(0.1, 0.2, 0.022, outboard - 0.05, 0, 0, club.tip),
  ]);
  oarCache.set(key, g);
  return g;
}

let MATS = null;
function mats() {
  if (MATS) return MATS;
  MATS = {
    body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.05, side: THREE.DoubleSide, envMapIntensity: 1.1 }),
    crew: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }),
    oar: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4 }),
    glass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.5, emissive: 0xffd9a0, emissiveIntensity: 0 }),
  };
  return MATS;
}
export function setBoatNightLights(on) { mats().glass.emissiveIntensity = on ? 0.9 : 0; }

// Stations for a pointed shell, max beam a little aft of centre.
function shellStations(L, B, depth, sheer, n = 22) {
  const st = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, f = Math.sin(Math.PI * Math.pow(t, 0.92));
    st.push([-L / 2 + t * L, Math.max(0.006, (B / 2) * Math.pow(f, 0.7)), Math.max(0.01, depth * Math.pow(f, 0.5)), sheer + 0.04 * (1 - f)]);
  }
  return st;
}
// Pointed bow, transom stern (motorboats, rowboat, icebreaker).
function planingStations(L, B, depth, sheer, bowRise, sternW = 0.9, n = 16, bowLen = 0.45) {
  const st = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w = t < bowLen ? Math.sin((Math.PI / 2) * (t / bowLen)) ** 0.75 : 1 - (1 - sternW) * Math.max(0, (t - 0.75) / 0.25);
    st.push([-L / 2 + t * L, Math.max(0.02, (B / 2) * w), depth * (0.35 + 0.65 * Math.min(1, t / 0.3)), sheer + bowRise * Math.max(0, 1 - t / 0.5) ** 2]);
  }
  return st;
}

// Seats, pins and oars of a rowing boat: z of each seat, pin positions, sweep range.
function rigOf(type) {
  const T = AI_TYPES[type];
  if (type === 'dinghy') return { seats: [0.1], pins: [[-0.64, 0.5, 0.42], [0.64, 0.5, 0.42]], inboard: 0.55, outboard: 1.75, catch: 0.75, finish: -0.6, seatY: 0.2, slide: 0, lean: 0.35 };
  if (type === 'single') return { seats: [0.2], pins: [[-0.8, 0.33, 0.62], [0.8, 0.33, 0.62]], inboard: 0.88, outboard: 2.0, catch: 1.05, finish: -0.72, seatY: 0.06, slide: 0.32, lean: 0.4 };
  const n = T.seats, seats = [], pins = [], sp = 1.32;
  for (let k = 0; k < n; k++) seats.push(-((n - 1) * sp) / 2 + k * sp - (T.cox ? 0.7 : 0));
  // Sweep oars alternate sides; the stroke seat (nearest the stern) rows on port.
  for (let k = 0; k < n; k++) pins.push([(n - 1 - k) % 2 === 0 ? -0.86 : 0.86, 0.36, seats[k] + 0.42]);
  return { seats, pins, inboard: 1.15, outboard: 2.55, catch: 0.9, finish: -0.66, seatY: 0.08, slide: 0.33, lean: 0.42, sweep: true };
}

const hullCache = new Map();
export function buildBoat(type, club = PLAYER_CLUB, hullColor = 0xf4f1e8) {
  const T = AI_TYPES[type], M = mats();
  const root = new THREE.Group(), body = [], glass = [];
  const m = { root, type, T, rig: null, crew: null, oars: null, rest: 0 };
  if (T.row) {
    const rig = (m.rig = rigOf(type));
    if (type === 'dinghy') {
      body.push(...hullGeo(planingStations(T.len, T.beam, 0.32, 0.42, 0.12, 0.72, 14, 0.4), { top: 0xf0ede4, bottom: 0x2d5c7a, stripe: 0x7a4a26, stripeY: 0.36, deck: null, transom: true }));
      body.push(box(1.25, 0.05, 0.26, 0, 0.2, rig.seats[0], 0x8a5a33), box(1.0, 0.05, 0.22, 0, 0.18, 1.3, 0x8a5a33), box(0.8, 0.04, 2.6, 0, -0.1, 0.1, 0x7a4a26));
    } else {
      const sheer = type === 'single' ? 0.11 : 0.13;
      const deckFrom = type === 'single' ? -T.len / 2 + T.len * 0.27 : rig.seats[0] - 1.0;
      const deckTo = type === 'single' ? T.len / 2 - T.len * 0.22 : (T.cox ? T.len / 2 - 1.2 : rig.seats[rig.seats.length - 1] + 1.0);
      body.push(...hullGeo(shellStations(T.len, T.beam, type === 'single' ? 0.14 : 0.2, sheer), {
        top: hullColor, bottom: hullColor, boot: -1, deck: 0x30343b, deckAt: (z) => z < deckFrom || z > deckTo,
      }));
      // Riggers out to each pin, and the seats.
      for (const [x, y, z] of rig.pins) {
        body.push(box(Math.abs(x), 0.03, 0.04, x / 2, y - 0.04, z, 0x6b7076));
        body.push(box(0.025, 0.16, 0.025, x, y + 0.04, z, 0x2a2a2a));
        body.push(box(0.03, 0.03, 0.5, x * 0.55, y - 0.06, z - 0.22, 0x6b7076));
      }
      for (const z of rig.seats) body.push(box(0.24, 0.04, 0.6, 0, sheer - 0.05, z, 0x2a2a2a));
    }
    const fig = figureGeo(club.jersey);
    const crew = (m.crew = new THREE.InstancedMesh(fig, M.crew, rig.seats.length + (T.cox ? 1 : 0)));
    crew.castShadow = true;
    root.add(crew);
    const oars = (m.oars = new THREE.InstancedMesh(oarGeo(rig.inboard, rig.outboard, club), M.oar, rig.sweep ? rig.pins.length : 2));
    oars.castShadow = true;
    root.add(oars);
    if (T.cox) {
      const mx = new THREE.Matrix4().makeRotationY(Math.PI).scale(new THREE.Vector3(0.85, 0.85, 0.85)).setPosition(0, 0.02, T.len / 2 - 1.55);
      crew.setMatrixAt(rig.seats.length, mx);
    }
  } else if (type === 'icebreaker') {
    // Low enough (mast top 6.4 m) to fit under the Eliot Bridge.
    const sh = BREAKER.sheer;
    body.push(...hullGeo(planingStations(T.len, T.beam, 2.8, sh, 0.7, 0.86, 18, 0.32), { top: 0xb3261e, bottom: 0x161616, boot: 0.35, stripe: 0xf2f2ee, stripeY: sh - 0.25, full: 2.6, deck: 0x55595c, deckAt: () => true, transom: true }));
    const top = sh + 2.2;
    body.push(
      box(5.6, 2.2, 9.5, 0, sh + 1.1, 3.6, 0xf2f2ee),
      box(6.0, 1.7, 4.2, 0, top + 0.85, 1.8, 0xf2f2ee),
      box(0.2, 0.45, 0.2, 0, top + 1.92, 1.3, 0x2a2a2a),
      box(1.6, 0.1, 0.28, 0, top + 2.12, 1.3, 0x2a2a2a),
      cyl(0.8, 0.9, 1.6, 0, top + 0.8, 6.7, 0x1a1a1a),
      cyl(0.83, 0.83, 0.4, 0, top + 1.25, 6.7, 0xb3261e),
      box(2.4, 0.7, 1.6, 0, sh + 0.35, -8.2, 0x4a4f52),
      box(0.9, 0.7, 2.6, 2.3, top + 0.35, 5.6, 0xf26b1d),
      box(0.9, 0.7, 2.6, -2.3, top + 0.35, 5.6, 0xf26b1d),
      cyl(0.22, 0.25, 0.5, 2.6, sh + 0.25, -6.2, 0x1a1a1a, 8),
      cyl(0.22, 0.25, 0.5, -2.6, sh + 0.25, -6.2, 0x1a1a1a, 8),
      box(5.4, 0.5, 0.15, 0, sh + 0.25, 11.6, 0xf2f2ee),
    );
    // Rails round the foredeck, open at the gangway port beside the deckhouse.
    for (const sd of [-1, 1]) {
      let prev = null;
      for (let z = -10.6; z <= -2.7 + 1e-6; z += 0.99) {
        const x = sd * (BREAKER.halfWidth(z) - 0.1), y = BREAKER.deckY(z);
        body.push(box(0.05, 1.0, 0.05, x, y + 0.5, z, 0xd8dade));
        if (prev) body.push(bar(prev[0], prev[1] + 1.0, prev[2], x, y + 1.0, z, 0.05, 0xd8dade), bar(prev[0], prev[1] + 0.5, prev[2], x, y + 0.5, z, 0.035, 0xd8dade));
        prev = [x, y, z];
      }
    }
    glass.push(box(6.06, 0.6, 4.26, 0, top + 1.05, 1.8, 0x1b2735), box(5.66, 0.4, 9.56, 0, sh + 1.35, 3.6, 0x1b2735));
  } else {
    const launch = type === 'launch';
    const sh = launch ? 0.62 : 0.78;
    body.push(...hullGeo(planingStations(T.len, T.beam, launch ? 0.3 : 0.45, sh, launch ? 0.1 : 0.22, 0.88), {
      top: launch ? 0xa2abb2 : 0xf4f4f0, bottom: launch ? 0x8d969c : 0x1b2a3a, boot: 0.05, stripe: launch ? null : hullColor, stripeY: sh - 0.16, full: launch ? 1.6 : 1.2,
      deck: launch ? null : 0xf4f4f0, deckAt: (z) => z < -T.len / 2 + T.len * 0.3, transom: true,
    }));
    const zs = T.len / 2;
    body.push(
      box(T.beam * 0.8, 0.05, T.len * 0.62, 0, 0.12, zs - T.len * 0.33, launch ? 0x7d868c : 0xd9d4c4),
      box(0.42, 0.75, 0.5, 0, 0.62, zs + 0.24, 0x16181b),
      box(0.16, 0.75, 0.26, 0, 0.12, zs + 0.3, 0x3a3d40),
    );
    if (launch) body.push(box(0.6, 0.75, 0.45, 0.45, 0.5, zs - 1.6, 0x7d868c));
    else {
      body.push(box(0.75, 0.85, 0.55, 0.48, 0.55, 0.15, 0xf4f4f0), box(0.55, 0.42, 0.5, 0.48, 0.36, 0.95, 0xe8e2d0), box(1.9, 0.38, 0.5, 0, 0.32, zs - 0.55, 0xe8e2d0));
      glass.push(box(0.82, 0.34, 0.05, 0.48, 1.1, -0.14, 0x1e2d3a));
    }
    const drv = new THREE.Mesh(figureGeo(club.jersey, launch), M.crew);
    drv.position.set(0.48, launch ? 0.12 : 0.52, launch ? zs - 1.1 : 0.95);
    drv.rotation.y = Math.PI;
    drv.castShadow = true;
    root.add(drv);
  }
  const key = `${type}:${hullColor}`;
  if (!hullCache.has(key)) hullCache.set(key, { body: merge(body), glass: glass.length ? merge(glass) : null });
  const geo = hullCache.get(key);
  const hullMesh = new THREE.Mesh(geo.body, M.body);
  hullMesh.castShadow = true;
  hullMesh.receiveShadow = true;
  root.add(hullMesh);
  if (geo.glass) root.add(new THREE.Mesh(geo.glass, M.glass));
  m.hull = hullMesh;
  if (m.rig) poseBoat(m, 0.5, 0.4, 1);
  return m;
}

const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const ease = (t) => t * t * (3 - 2 * t);

// Rowers and oars at stroke phase 0..1 (drive for phase < Dr, then the
// recovery), blended toward resting with the blades flat on the water.
export function poseBoat(m, phase, Dr, rest) {
  const rig = m.rig;
  if (!rig) return;
  let th, e, feather, slide, lean;
  const hp = rig.pins[0][1], reach = rig.outboard - 0.3;
  const down = Math.asin(clamp((hp + 0.1) / reach, -1, 1)), up = Math.asin(clamp((hp - 0.22) / reach, -1, 1));
  if (phase < Dr) {
    const u = phase / Dr;
    th = rig.catch + (rig.finish - rig.catch) * ease(u);
    e = down; feather = 0;
    slide = rig.slide * (1 - 2 * ease(Math.min(1, u / 0.7)));
    lean = rig.lean * (0.8 - 1.4 * ease(clamp((u - 0.2) / 0.8, 0, 1)));
  } else {
    const u = (phase - Dr) / (1 - Dr);
    th = rig.finish + (rig.catch - rig.finish) * ease(u);
    e = up + (down - up) * (u < 0.08 ? 1 - u / 0.08 : u > 0.92 ? (u - 0.92) / 0.08 : 0);
    feather = u < 0.1 ? u / 0.1 : u > 0.85 ? 1 - (u - 0.85) / 0.15 : 1;
    lean = rig.lean * (-0.6 + 1.4 * ease(Math.min(1, u / 0.45)));
    slide = rig.slide * (-1 + 2 * ease(clamp((u - 0.3) / 0.7, 0, 1)));
  }
  if (rest > 0) {
    th += (-0.15 - th) * rest; e += (Math.asin(clamp((hp - 0.02) / reach, -1, 1)) - e) * rest;
    feather += (1 - feather) * rest; slide += (-rig.slide * 0.6 - slide) * rest; lean += (-0.05 - lean) * rest;
  }
  for (let k = 0; k < rig.seats.length; k++) {
    _m.makeRotationX(lean).setPosition(0, rig.seatY, rig.seats[k] + slide);
    m.crew.setMatrixAt(k, _m);
  }
  m.crew.instanceMatrix.needsUpdate = true;
  const pins = rig.sweep ? rig.pins : rig.pins;
  for (let k = 0; k < pins.length; k++) {
    const [px, py, pz] = pins[k], s = Math.sign(px);
    _x.set(s * Math.cos(th) * Math.cos(e), -Math.sin(e), -Math.sin(th) * Math.cos(e)).normalize();
    _y.copy(_up).addScaledVector(_x, -_up.dot(_x)).normalize();
    _z.crossVectors(_x, _y);
    // Feathered: the blade turns flat for the recovery.
    const f = feather * Math.PI / 2 * s;
    const cy = Math.cos(f), sy = Math.sin(f);
    const yx = _y.x * cy + _z.x * sy, yy = _y.y * cy + _z.y * sy, yz = _y.z * cy + _z.z * sy;
    _y.set(yx, yy, yz);
    _z.crossVectors(_x, _y);
    _m.makeBasis(_x, _y, _z).setPosition(px, py, pz);
    m.oars.setMatrixAt(k, _m);
  }
  m.oars.instanceMatrix.needsUpdate = true;
}

// Geometry is shared through hullCache; only the per-boat instance buffers go.
export function disposeBoat(m) {
  m.root.parent?.remove(m.root);
  m.crew?.dispose();
  m.oars?.dispose();
}

// ================================================================ physics
// The boat you drive: thrust from the engine or the oars (each stroke a surge),
// quadratic hull drag, a keel against side-slip, yaw from the rudder (or
// spinning the boat by rowing one side), and collisions with the banks, piers,
// bridge piles and solid ice.
export class BoatBody {
  constructor(type) {
    this.type = type;
    this.T = BOAT_TYPES[type];
    this.boost = 1;
    this.boosting = false;
    this.camScale = this.T.cam; this.camLift = this.T.camLift ?? 0; this.eyeF = this.T.eyeF; this.eyeH = this.T.eyeH;
    this._out = { depth: 0, nx: 0, nz: 0, kind: 0 };
    this.reset(0, 0, 0, 0);
  }

  reset(x, z, heading, level) {
    this.x = x; this.z = z; this.heading = heading; this.level = level; this.y = level;
    this.vx = this.vz = this.vF = this.vR = 0; this.yawRate = 0; this.steer = 0;
    this.phase = 0.5; this.rate = 0; this.drive = 0; this.rowing = false; this.rest = 1; this.Dr = 0.4;
    this.pitch = 0; this.roll = 0; this.impact = 0; this.iceState = 'none'; this.strokes = 0;
    this.onGrass = false; this.skid = 0; this.airborne = false; this.onDeck = false;
  }

  get speed() { return Math.hypot(this.vx, this.vz); }
  get fx() { return Math.sin(this.heading); }
  get fz() { return -Math.cos(this.heading); }

  // env: { cw, ice, time }
  step(dt, inp, env) {
    const T = this.T;
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading), rx = -fz, rz = fx;
    let vF = this.vx * fx + this.vz * fz, vR = this.vx * rx + this.vz * rz;
    this.steer += clamp(clamp(inp.steer, -1, 1) - this.steer, -2.5 * dt, 2.5 * dt);
    let a = 0, yawT;
    const bx = this.x + fx * T.len * 0.45, bz = this.z + fz * T.len * 0.45;
    const ice = env.ice ? env.ice.stateAt(bx, bz) : 'none';
    this.iceState = ice;
    if (T.motor) {
      const boosting = !T.noBoost && !!inp.boost && this.boost > 0.01 && inp.throttle > 0 && vF > -1;
      this.boost = boosting ? Math.max(0, this.boost - dt / 5) : Math.min(1, this.boost + dt / 12);
      this.boosting = boosting;
      if (inp.throttle > 0) a += vF < -0.5 ? T.accel * 1.4 * inp.throttle : inp.throttle * T.accel * (boosting ? 1.6 : 1) * (1 - Math.pow(clamp(vF / T.top, 0, 1), T.curve));
      else a -= T.drag * vF * Math.abs(vF) + 0.35 * Math.sign(vF) * Math.min(1, Math.abs(vF));
      if (inp.brake > 0) a -= vF > 0.5 ? T.accel * 1.1 * inp.brake : T.reverse * inp.brake * (1 - clamp(-vF / 5, 0, 1));
      if (vF > T.top) a -= (vF - T.top) * 2;
      const wash = (inp.throttle + inp.brake * 0.6) * (1 - clamp(Math.abs(vF) / 6, 0, 1));
      // Wider turns flat out, so it stays controllable at 90 mph.
      const cap = T.maxYaw / (1 + Math.max(0, Math.abs(vF) - 15) / 40);
      let y = this.steer * (vF / T.turnR + wash * (T.wash ?? 0.7) * (vF < -0.3 ? -1 : 1));
      if (T.thruster) y += this.steer * T.thruster * (1 - clamp(Math.abs(vF) / 3, 0, 1));
      yawT = clamp(y, -cap, cap);
    } else {
      const rowing = inp.throttle > 0.1 && !(inp.brake > 0.1);
      const sprint = rowing && !!inp.boost && this.boost > 0.02;
      this.boosting = sprint;
      this.boost = sprint ? Math.max(0, this.boost - dt / 14) : Math.min(1, this.boost + dt / (rowing ? 40 : 16));
      const target = rowing ? (sprint ? T.sprintRate : T.rate) : 0;
      this.rate += (target - this.rate) * damp(target > this.rate ? 1.3 : 2.5, dt);
      if (target === 0 && this.rate < 0.5) this.rate = 0;
      const Dr = (this.Dr = clamp(0.36 + (this.rate - 18) * 0.005, 0.34, 0.48));
      const was = this.phase;
      if (rowing || this.rate > 6) this.phase = (this.phase + (dt * Math.max(this.rate, 12)) / 60) % 1;
      else if (inp.brake > 0.1 && vF < 0.3) this.phase = (this.phase + 1 - dt * 0.35) % 1;
      if (was > this.phase && rowing) this.strokes++;
      this.rowing = rowing || this.rate > 6;
      this.rest += ((this.rowing || inp.brake > 0.1 ? 0 : 1) - this.rest) * damp(2.5, dt);
      const f = this.rowing && this.phase < Dr ? Math.sin((Math.PI * this.phase) / Dr) : 0;
      this.drive = f;
      const vt = this.rate <= T.rate ? T.speed * (this.rate / T.rate) : T.speed + (T.sprint - T.speed) * clamp((this.rate - T.rate) / (T.sprintRate - T.rate), 0, 1);
      // Each stroke's push, sized so drag balances it at the target speed; a
      // linear part makes the first strokes off the line count.
      const lin = 0.9 / T.speed;
      a += ((T.drag * vt * vt + lin * vt) / ((Dr * 2) / Math.PI)) * f;
      a -= T.drag * vF * Math.abs(vF) + lin * vF + 0.05 * Math.sign(vF) * Math.min(1, Math.abs(vF));
      if (inp.brake > 0.1) {
        if (vF > 0.25) a -= (1.8 + 0.25 * vF) * inp.brake;   // hold water: blades squared in the river
        else a += clamp((-T.back - vF) * 1.5, -1.2, 0.3);     // back it down
      }
      a -= Math.abs(this.steer) * 0.06 * vF;
      yawT = Math.abs(vF) > 1.2 ? (this.steer * vF) / T.turnR : this.steer * T.spin;
    }
    // Slush and broken slabs drag at the hull; new ice has to be pushed
    // through (a race course is kept clear). An icebreaker rams solid ice,
    // losing a few mph.
    if (T.breaker) {
      if (ice === 'solid') a -= Math.sign(vF) * (0.25 * Math.min(1, Math.abs(vF)) + 0.0003 * vF * vF);
      else if (ice === 'thin') a -= Math.sign(vF) * 0.08 * Math.min(1, Math.abs(vF));
    } else if (!env.clearCourse) {
      if (ice === 'brash') a -= T.drag * 0.6 * vF * Math.abs(vF) + 0.08 * vF;
      else if (ice === 'thin') {
        a -= T.drag * 1.5 * vF * Math.abs(vF) + 0.3 * vF;
        if (env.ice && Math.abs(vF) > 0.4) env.ice.breakAt(bx, bz, T.beam / 2 + 0.8, 12);
      }
    }
    const vF0 = vF;
    vF += a * dt;
    if (!(inp.throttle > 0) && !(inp.brake > 0) && Math.abs(vF) < 0.05) vF = 0;
    if (inp.brake > 0.1 && vF0 > 0.3 && vF < 0 && !T.motor) vF = 0;
    vR *= Math.exp(-T.lat * dt);
    this.yawRate += (yawT - this.yawRate) * damp(T.yawResp ?? (T.motor ? 3.5 : 2.2), dt);
    const px = this.x, pz = this.z, ph = this.heading;
    this.vx = fx * vF + rx * vR;
    this.vz = fz * vF + rz * vR;
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.vF = vF; this.vR = vR;
    this._collide(env, px, pz, ph);
    // Float at the water surface, with a little chop and motion.
    const T0 = env.cw.terrain;
    const lvl = Math.min(T0.h(this.x, this.z), T0.h(this.x + fx * T.len * 0.4, this.z + fz * T.len * 0.4), T0.h(this.x - fx * T.len * 0.4, this.z - fz * T.len * 0.4));
    this.level += (lvl - this.level) * damp(3, dt);
    const t = env.time || 0, sp = Math.abs(this.vF);
    if (T.breaker) {
      // A heavy hull: a little squat and lean, and a shudder ramming the ice.
      const shudder = ice === 'solid' && sp > 1 ? 0.004 * Math.sin(t * 13) : 0;
      this.pitch += (-0.012 * clamp(sp / 20, 0, 1) + 0.003 * Math.sin(t * 0.9) + shudder - this.pitch) * damp(2.5, dt);
      this.roll += (clamp(-this.yawRate * sp * 0.005, -0.05, 0.05) + 0.004 * Math.sin(t * 0.7) - this.roll) * damp(1.5, dt);
      this.y = this.level + 0.03 * Math.sin(t * 0.8);
    } else if (T.motor) {
      const plane = clamp(sp / 5, 0, 1) * (1 - clamp((sp - 9) / 8, 0, 0.7));
      this.pitch += (-(0.075 * plane + 0.012 * Math.sin(t * 7.3) * clamp(sp / 12, 0, 1)) - this.pitch) * damp(4, dt);
      this.roll += (clamp(-this.yawRate * sp * 0.012, -0.2, 0.2) - this.roll) * damp(3, dt);
      this.y = this.level + 0.02 * Math.sin(t * 2.1) + 0.04 * clamp(sp / 10, 0, 1) + 0.03 * Math.sin(t * 9.1) * clamp(sp / 15, 0, 1);
    } else {
      this.pitch += (0.004 * this.drive - this.pitch) * damp(6, dt);
      this.roll += (clamp(this.steer * 0.025 + 0.012 * Math.sin(t * 1.7) + (this.drive - 0.3) * 0.006, -0.06, 0.06) - this.roll) * damp(4, dt);
      this.y = this.level + 0.015 * Math.sin(t * 1.9 + this.x * 0.1);
    }
  }

  // Water this hull can be in: not aground, not in solid ice (unless it's an
  // icebreaker), and not under a bridge too low for it.
  _wet(env, x, z) {
    if (!env.cw.isWaterSurface(x, z)) return false;
    const T = this.T;
    if (env.ice && !T.breaker && env.ice.solidAt(x, z)) return false;
    if (T.airDraft && env.cw.deckAbove(x, z, this.level) - SLAB - this.level < T.airDraft) return false;
    return true;
  }

  // First hull point that is aground, in ice or against a pile: its normal.
  _hullHit(env) {
    const T = this.T, fx = Math.sin(this.heading), fz = -Math.cos(this.heading), rx = -fz, rz = fx;
    const n = Math.max(3, Math.ceil(T.len / 2) + 1), out = this._out;
    for (let k = 0; k < n; k++) {
      const u = -0.5 + k / (n - 1), off = u * T.len * 0.94;
      const x = this.x + fx * off, z = this.z + fz * off;
      const w = (T.beam / 2) * (T.motor ? (u > 0.25 ? 1 - (u - 0.25) * 2.4 : 1) : Math.max(0.3, 1 - (2 * u) ** 2));
      if (!this._wet(env, x, z)) return this._normal(env, x, z);
      if (T.beam > 1) {
        for (const sd of [-1, 1]) {
          const sx = x + rx * w * sd * 0.9, sz = z + rz * w * sd * 0.9;
          if (!this._wet(env, sx, sz)) return this._normal(env, sx, sz);
        }
      }
      if (env.cw.resolveCircle(x, z, Math.max(0.2, w) + 0.1, out, this.level)) return { nx: out.nx, nz: out.nz };
      if (env.obstacles) { const o = obstacleHit(env.obstacles, x, z, Math.max(0.2, w) + 0.1); if (o) return o; }
    }
    return null;
  }

  _normal(env, x, z) {
    let nx = 0, nz = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
      if (this._wet(env, x + dx * 3, z + dz * 3)) { nx += dx; nz += dz; }
    }
    const l = Math.hypot(nx, nz);
    if (l < 1e-3) { const v = Math.hypot(this.vx, this.vz) || 1; return { nx: -this.vx / v, nz: -this.vz / v }; }
    return { nx: nx / l, nz: nz / l };
  }

  _collide(env, px, pz, ph) {
    this.impact = 0;
    let hit = this._hullHit(env);
    // Fenders: slide along a landing instead of sticking to it.
    for (let it = 0; it < 4 && hit && hit.soft; it++) {
      this.x += hit.nx * (hit.depth + 0.005); this.z += hit.nz * (hit.depth + 0.005);
      const vn = this.vx * hit.nx + this.vz * hit.nz;
      if (vn < 0) { this.vx -= 1.15 * vn * hit.nx; this.vz -= 1.15 * vn * hit.nz; this.impact = Math.max(this.impact, -vn); }
      hit = this._hullHit(env);
    }
    if (!hit) {
      const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
      this.vF = this.vx * fx + this.vz * fz; this.vR = this.vx * -fz + this.vz * fx;
      return;
    }
    const { nx, nz } = hit;
    this.x = px; this.z = pz; this.heading = ph;
    // Already wedged (ice closed in, a bad spawn): slide out along the normal.
    if (this._hullHit(env)) { this.x += nx * 0.04; this.z += nz * 0.04; }
    const vn = this.vx * nx + this.vz * nz, heavy = this.T.breaker;
    if (vn < 0) { this.vx -= (heavy ? 1.1 : 1.2) * vn * nx; this.vz -= (heavy ? 1.1 : 1.2) * vn * nz; this.impact = -vn; }
    this.vx *= heavy ? 0.8 : 0.85; this.vz *= heavy ? 0.8 : 0.85; this.yawRate *= 0.3;
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    this.vF = this.vx * fx + this.vz * fz;
    this.vR = this.vx * -fz + this.vz * fx;
  }

  // Free water for this hull here (spawning, boarding).
  fits(env, x, z, heading) {
    const sx = this.x, sz = this.z, sh = this.heading;
    this.x = x; this.z = z; this.heading = heading;
    const ok = !this._hullHit(env);
    this.x = sx; this.z = sz; this.heading = sh;
    return ok;
  }
}

// Oriented boxes the hull can't enter (ferry landings): centre, along axis a,
// across axis n, half sizes hl / hw. A hit returns the push-out normal and
// depth; it's soft (fendered): the hull is pushed clear rather than stopped.
function obstacleHit(list, x, z, r) {
  for (const o of list) {
    const dx = x - o.cx, dz = z - o.cz, u = dx * o.ax + dz * o.az, v = dx * o.nx + dz * o.nz;
    const pu = o.hl + r - Math.abs(u), pv = o.hw + r - Math.abs(v);
    if (pu > 0 && pv > 0) return pv < pu ? { nx: o.nx * Math.sign(v || 1), nz: o.nz * Math.sign(v || 1), depth: pv, soft: true } : { nx: o.ax * Math.sign(u || 1), nz: o.az * Math.sign(u || 1), depth: pu, soft: true };
  }
  return null;
}

// Place a model at a body's pose.
export function placeBoat(m, b) {
  m.root.position.set(b.x, b.y, b.z);
  m.root.rotation.set(b.pitch || 0, -b.heading, b.roll || 0, 'YXZ');
}

// ================================================================ effects
// Foam on the water: streaky quads that spread, drift apart (the arms of a
// wake) and fade, aged on the GPU from a ring buffer.
class Wakes {
  constructor(scene, n = 1600) {
    this.n = n; this.next = 0; this.lo = n; this.hi = -1;
    const corner = new Float32Array(n * 8), center = new Float32Array(n * 12), data = new Float32Array(n * 16), drift = new Float32Array(n * 12), idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      corner.set([-1, -1, 1, -1, 1, 1, -1, 1], i * 8);
      idx.set([4 * i, 4 * i + 2, 4 * i + 1, 4 * i, 4 * i + 3, 4 * i + 2], i * 6);
      for (let k = 0; k < 4; k++) data[i * 16 + k * 4 + 1] = -1e4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(center, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
    g.setAttribute('aData', new THREE.BufferAttribute(data, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aDrift', new THREE.BufferAttribute(drift, 3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.center = center; this.data = data; this.drift = drift; this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLight: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec2 aCorner;
        attribute vec4 aData;   // heading, birth, width, strength * 100 + life / 100
        attribute vec3 aDrift;  // drift velocity x, z; length / width
        uniform float uTime;
        varying vec2 vUv; varying float vA; varying float vSeed;
        void main() {
          float age = uTime - aData.y, life = fract(aData.w) * 100.0, str = floor(aData.w) / 100.0;
          float t = clamp(age / max(life, 0.01), 0.0, 1.0);
          float w = aData.z * (0.6 + 1.4 * sqrt(t)), l = w * aDrift.z;
          vec2 c = aCorner * vec2(w, l);
          float h = aData.x;
          vec2 f = vec2(sin(h), -cos(h)), r = vec2(-f.y, f.x);
          vec2 d = aDrift.xy * 3.0 * (1.0 - exp(-max(age, 0.0) / 3.0));
          vec3 p = position + vec3(r * c.x + f * c.y + d, 0.0).xzy;
          vA = age < 0.0 || age > life ? 0.0 : str * (1.0 - t) * (1.0 - t) * min(1.0, age * 5.0);
          vUv = aCorner; vSeed = aData.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uLight;
        varying vec2 vUv; varying float vA; varying float vSeed;
        float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
        void main() {
          float r = length(vUv);
          if (r > 1.0 || vA < 0.002) discard;
          // Streaks along the boat's path, broken up by noise.
          vec2 q = vec2(vUv.x * 5.0, vUv.y * 1.4) + vSeed * 3.1;
          float n = vn(q) * 0.65 + vn(q * 2.7) * 0.35;
          float a = vA * smoothstep(1.0, 0.25, r) * smoothstep(0.3, 0.75, n);
          gl_FragColor = vec4(vec3(0.92, 0.95, 0.97) * uLight, a);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -30;
    scene.add(this.mesh);
    this.time = 0;
  }

  // A patch of foam: width, strength 0..1, life (s), drift (m/s), length / width.
  emit(x, y, z, heading, size, strength, life, dx = 0, dz = 0, stretch = 2.2) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    for (let k = 0; k < 4; k++) {
      this.center.set([x, y + 0.04, z], i * 12 + k * 3);
      this.data.set([heading, this.time, size, Math.round(clamp(strength, 0, 1) * 100) + Math.min(0.99, life / 100)], i * 16 + k * 4);
      this.drift.set([dx, dz, stretch], i * 12 + k * 3);
    }
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;
  }

  update(time, light) {
    this.time = time;
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uLight.value = light;
    if (this.hi < 0) return;
    const g = this.geo;
    for (const [name, size] of [['position', 12], ['aData', 16], ['aDrift', 12]]) {
      const A = g.attributes[name];
      A.clearUpdateRanges();
      A.addUpdateRange(this.lo * size, (this.hi - this.lo + 1) * size);
      A.needsUpdate = true;
    }
    this.lo = this.n; this.hi = -1;
  }
}

// Slabs of broken ice shouldered aside by an icebreaker's bow.
class IceSlabs {
  constructor(scene, n = 120) {
    this.n = n;
    const g = new THREE.BoxGeometry(1, 0.22, 0.8);
    this.mesh = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0xdde8ef, roughness: 0.35, metalness: 0 }), n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.p = new Float32Array(n * 3); this.v = new Float32Array(n * 3); this.r = new Float32Array(n * 3); this.w = new Float32Array(n * 3);
    this.age = new Float32Array(n).fill(99); this.s = new Float32Array(n).fill(1);
    this.next = 0;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._v = new THREE.Vector3(); this._sc = new THREE.Vector3();
  }
  emit(x, y, z, vx, vz, size) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.p.set([x, y, z], i * 3);
    this.v.set([vx, 0.6 + Math.random() * 0.8, vz], i * 3);
    this.r.set([Math.random() * 0.3, Math.random() * 6.3, Math.random() * 0.3], i * 3);
    this.w.set([(Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 1.4], i * 3);
    this.age[i] = 0; this.s[i] = size;
  }
  update(dt) {
    let count = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] > 10) continue;
      count = i + 1;
      const a = (this.age[i] += dt);
      const k = i * 3, P = this.p, V = this.v, R = this.r, W = this.w;
      V[k] *= Math.exp(-0.8 * dt); V[k + 2] *= Math.exp(-0.8 * dt);
      V[k + 1] -= 3 * dt;
      P[k] += V[k] * dt; P[k + 1] += V[k + 1] * dt; P[k + 2] += V[k + 2] * dt;
      const floor = this.base - Math.max(0, a - 6) * 0.15;
      if (P[k + 1] < floor) { P[k + 1] = floor; V[k + 1] = 0; W[k] *= 0.9; W[k + 2] *= 0.9; R[k] *= 0.97; R[k + 2] *= 0.97; }
      R[k] += W[k] * dt; R[k + 1] += W[k + 1] * dt; R[k + 2] += W[k + 2] * dt;
    }
    for (let i = 0; i < count; i++) {
      const k = i * 3;
      const s = this.age[i] > 10 ? 0 : this.s[i];
      this._q.setFromEuler(this._e.set(this.r[k], this.r[k + 1], this.r[k + 2]));
      this._m.compose(this._v.set(this.p[k], this.p[k + 1], this.p[k + 2]), this._q, this._sc.set(s, s, s));
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.count = count;
    if (count) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ================================================================ AI boats
class AIBoat {
  constructor(boats, type, opts = {}) {
    this.B = boats;
    this.type = type;
    this.T = AI_TYPES[type];
    this.club = opts.club || CLUBS[Math.floor(boats.rng() * CLUBS.length)];
    this.model = buildBoat(type, this.club, opts.hull ?? SHELL_COLORS[Math.floor(boats.rng() * SHELL_COLORS.length)]);
    boats.g.scene.add(this.model.root);
    this.role = opts.role || 'crew';
    this.s = opts.s ?? 0; this.d = opts.d ?? 0; this.dir = opts.dir ?? 1;
    this.v = opts.v ?? 0; this.vt = opts.vt ?? this.T.speed ?? 3;
    this.lane = opts.lane ?? 0.4;
    this.sMin = opts.sMin ?? 40; this.sMax = opts.sMax ?? boats.path.length - 40;
    this.phase = boats.rng(); this.rate = this.T.rate || 0; this.rest = 0;
    this.turn = null; this.pass = 0; this.follow = opts.follow || null;
    this.x = 0; this.z = 0; this.y = 0; this.heading = 0; this.pitch = 0; this.roll = 0;
    this.wakeAcc = boats.rng() * 2; this.bump = 0; this.breaking = 0;
    this.name = opts.name || this.club.name;
    this.pose(0);
  }

  get speed() { return Math.abs(this.v); }
  get fx() { return Math.sin(this.heading); }
  get fz() { return -Math.cos(this.heading); }

  margin() { return this.T.row ? (this.model.rig.outboard + 1.0) + 2.5 : this.T.beam / 2 + 5; }

  step(dt) {
    const B = this.B, P = B.path, T = this.T;
    if (this.turn) {
      const tr = this.turn;
      tr.t += dt;
      const u = Math.min(1, tr.t / tr.dur);
      this.v += (0.4 - this.v) * damp(1.5, dt);
      this.heading = tr.h0 + tr.sign * Math.PI * u * u * (3 - 2 * u);
      if (u >= 1) { this.dir = -this.dir; this.turn = null; this.pass++; }
      this._place(true);
      return;
    }
    let vt = this.vt * (this.bump > 0 ? 0.3 : 1);
    this.bump = Math.max(0, this.bump - dt);
    // Ice closing in: everything but an icebreaker stops dead.
    const ice = B.g.ice;
    if (this.role !== 'icebreaker' && this.role !== 'race' && ice && ice.level > 0.2 && ice.solidAt(this.x + this.fx * T.len * 0.5, this.z + this.fz * T.len * 0.5)) { vt = 0; this.v *= 0.9; }
    if (this.follow && !this.follow.dead) {
      // Coach launch: ride alongside a crew, a little behind.
      const f = this.follow;
      this.dir = f.dir;
      const gap = f.s - this.dir * 18 - this.s;
      vt = clamp(f.v + gap * this.dir * 0.4, 0, this.T.top);
    }
    const player = B.playerBody;
    if (player && this.role !== 'race' && this.role !== 'icebreaker') {
      const ahead = (player.x - this.x) * this.fx + (player.z - this.z) * this.fz;
      const side = Math.abs((player.x - this.x) * -this.fz + (player.z - this.z) * this.fx);
      if (ahead > 0 && ahead < 35 && side < 8) vt = Math.min(vt, Math.max(0, (ahead - 12) * 0.25));
    }
    this.v += (vt - this.v) * damp(T.row ? 0.6 : 0.9, dt);
    this.s += this.dir * this.v * dt;
    const p = P.at(this.s, 0, B._p);
    const m = this.margin();
    let want;
    if (this.role === 'icebreaker') want = [0, 0.45, -0.45, 0.22, -0.22][this.pass % 5] * Math.min(p.right, p.left);
    else if (this.follow && !this.follow.dead) want = this.follow.d + (this.follow.d > 0 ? -1 : 1) * 14;
    else if (this.role === 'race') want = this.lane;
    else want = this.dir > 0 ? this.lane * p.right : -this.lane * p.left;
    want = B.avoidPillars(this.s + this.dir * 22, want, this.T.row ? this.model.rig.outboard + 1.2 : T.beam / 2 + 1.5);
    want = clamp(want, -(p.left - m), p.right - m);
    if (p.left + p.right < 2 * m) want = (p.right - p.left) / 2;
    const dd = clamp(want - this.d, -1.5 * dt, 1.5 * dt);
    this.d += dd;
    if (this.role !== 'race' && ((this.dir < 0 && this.s < this.sMin) || (this.dir > 0 && this.s > this.sMax))) {
      // Spin and row back the other way, turning toward the wider side.
      this.turn = { t: 0, dur: T.row ? 14 : this.type === 'icebreaker' ? 34 : 6, h0: this.heading, sign: (this.d > 0) === (this.dir > 0) ? -1 : 1 };
    }
    this._place(false, dd / Math.max(dt, 1e-3));
  }

  _place(keepHeading, lat = 0) {
    const B = this.B, q = B.path.at(this.s, this.d, B._q);
    this.x = q.x; this.z = q.z;
    if (!keepHeading) this.heading = Math.atan2(q.tx * this.dir, -q.tz * this.dir) + Math.atan2(lat * this.dir, Math.max(1, this.v)) * 0.8;
    this.level = B.g.map.terrain.h(this.x, this.z);
    this.y = this.level + (this.T.row ? 0.01 * Math.sin(B.time * 1.7 + this.phase * 9) : 0.02 * Math.sin(B.time * 1.3 + this.phase * 5));
  }

  pose(dt) {
    const m = this.model, T = this.T;
    if (T.row) {
      const rate = this.v > 0.6 ? clamp((T.rate * this.v) / (T.speed * 0.85), 16, T.sprintRate) : 0;
      this.rate += (rate - this.rate) * damp(1.5, dt);
      if (this.rate > 6) this.phase = (this.phase + (dt * this.rate) / 60) % 1;
      this.rest += ((this.rate > 6 ? 0 : 1) - this.rest) * damp(2, dt);
      const Dr = clamp(0.36 + (this.rate - 18) * 0.005, 0.34, 0.48);
      if (this.visible) poseBoat(m, this.phase, Dr, this.rest);
      this.pitch = this.rate > 6 && this.phase < Dr ? 0.003 * Math.sin((Math.PI * this.phase) / Dr) : 0;
    } else {
      this.pitch = this.type === 'icebreaker' ? 0.004 * Math.sin(this.B.time * 0.7) : -0.05 * clamp(this.v / 8, 0, 1);
      this.roll = this.type === 'icebreaker' ? 0.006 * Math.sin(this.B.time * 0.5 + 1) : 0;
    }
    placeBoat(m, this);
  }

  dispose() { this.dead = true; disposeBoat(this.model); }
}

const CREWS = [0, 4, 8, 12], LAUNCHES = [0, 1, 2, 3], MOTORS = [0, 1, 3, 4], BREAKERS = [0, 1, 2, 3];

export class Boats {
  constructor(game) {
    this.g = game;
    this.path = game.map.river && game.map.river.length >= 8 ? new RiverPath(game.map.river) : null;
    this.list = [];
    this.density = 2;
    this.rng = mulberry32(20261108);
    this.time = 0;
    this.wakes = new Wakes(game.scene);
    this.slabs = new IceSlabs(game.scene);
    this.slabs.base = 0;
    this.ambient = true;
    this.playerBody = null;
    this._p = {}; this._q = {}; this._f = {};
    this.focusS = null;
    this.crunch = 0;
    if (this.path) this._analyse(game.collision);
  }

  setDensity(n) { this.density = clamp(n | 0, 0, 3); }

  // One of each boat, out of the way, for the renderer to compile their
  // shaders at load (else the first crew on screen hitches the frame).
  warmup() {
    const out = [];
    for (const type of ['eight', 'single', 'dinghy', 'motor', 'launch', 'icebreaker']) {
      const m = buildBoat(type, CLUBS[0]);
      m.root.position.set(this.g.camera.position.x, -50, this.g.camera.position.z);
      this.g.scene.add(m.root);
      out.push(m);
    }
    return out;
  }
  coolDown(list) { for (const m of list) disposeBoat(m); }

  // Bridge clearance and piles along the river; the reaches icebreakers work.
  _analyse(cw) {
    const P = this.path, T = this.g.map.terrain, n = P.n;
    this.clear = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = P.x[i], z = P.z[i], lvl = T.h(x, z);
      let c = Infinity;
      for (const d of [-14, -7, 0, 7, 14]) c = Math.min(c, cw.deckAbove(x - P.tz[i] * d, z + P.tx[i] * d, lvl) - lvl);
      this.clear[i] = c;
    }
    // Piles near the line, as (s, d) pairs bucketed every 10 m.
    this.piles = new Map();
    const G = cw.trees, seen = new Set(), pr = {};
    for (let i = 0; i < n; i += 2) {
      const m = G.query(P.x[i], P.z[i], Math.max(P.right[i], P.left[i]) + 10);
      for (let k = 0; k < m; k++) {
        const j = G.result[k];
        if (seen.has(j)) continue;
        seen.add(j);
        const x = G.pts[3 * j], z = G.pts[3 * j + 1];
        if (!cw.isWaterSurface(x, z)) continue;
        P.project(x, z, P.s[i], pr);
        if (pr.dist > 400) continue;
        const key = Math.floor(pr.s / 10);
        if (!this.piles.has(key)) this.piles.set(key, []);
        this.piles.get(key).push(pr.d, G.pts[3 * j + 2]);
      }
    }
    // Icebreaker reaches: between the bridges too low for them.
    this.zones = [];
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const ok = i < n && this.clear[i] - SLAB > AIR_DRAFT;
      if (ok && start < 0) start = i;
      if (!ok && start >= 0) {
        const s0 = P.s[start] + 45, s1 = P.s[i - 1] - 45;
        if (s1 - s0 > 250) this.zones.push([s0, s1]);
        start = -1;
      }
    }
  }

  // Shift a lateral offset off any pile near s (keeps half-width w clear).
  avoidPillars(s, d, w) {
    const list = this.piles.get(Math.floor(s / 10));
    const near = this.piles.get(Math.floor(s / 10) + 1);
    let out = d;
    for (const L of [list, near]) {
      if (!L) continue;
      for (let k = 0; k < L.length; k += 2) {
        const pd = L[k], r = L[k + 1] + w;
        if (Math.abs(out - pd) < r) out = out < pd ? pd - r : pd + r;
      }
    }
    return out;
  }

  _visible(x, z, cam) {
    const dx = x - cam.position.x, dz = z - cam.position.z, d = Math.hypot(dx, dz);
    if (d < 60) return true;
    if (d > 900) return false;
    cam.getWorldDirection(this._dir || (this._dir = new THREE.Vector3()));
    return (dx * this._dir.x + dz * this._dir.z) / d > 0.35;
  }

  add(type, opts) { const b = new AIBoat(this, type, opts); this.list.push(b); return b; }
  remove(b) { const i = this.list.indexOf(b); if (i >= 0) this.list.splice(i, 1); b.dispose(); }
  clearRole(role) { for (const b of this.list.filter((x) => x.role === role)) this.remove(b); }

  _spawnS(cam, lo, hi) {
    for (let k = 0; k < 12; k++) {
      const s = lo + this.rng() * (hi - lo);
      const p = this.path.at(s, 0, this._p);
      if (!this._visible(p.x, p.z, cam) || k === 11) return s;
    }
    return lo;
  }

  update(dt, focus, cam) {
    if (!this.path) return;
    this.time += dt;
    const P = this.path, ice = this.g.ice;
    const f = P.project(focus.x, focus.z, null, this._f);
    const near = f.dist < 1500 || this.list.some((b) => b.role === 'race');
    const d = this.density, lvl = ice ? ice.level : 0;
    const want = {
      crew: near && this.ambient && lvl < 0.12 ? CREWS[d] : 0,
      launch: near && this.ambient && lvl < 0.12 ? LAUNCHES[d] : 0,
      motor: near && this.ambient && lvl < 0.12 ? MOTORS[d] : 0,
      icebreaker: near && lvl > 0.45 && this.zones.length ? Math.min(BREAKERS[d] + (this.ambient ? 0 : 1), this.zones.length) : 0,
    };
    const lo = Math.max(40, f.s - 1300), hi = Math.min(P.length - 40, f.s + 1300);
    // Cull: too many, too far, or frozen in (out of sight).
    for (const b of this.list.slice()) {
      if (b.role === 'race') continue;
      const rr = this.raceRange;
      const far = Math.abs(b.s - f.s) > 1700 || !near || (rr && b.role === 'icebreaker' && b.sMax > rr[0] && b.sMin < rr[1]);
      const count = this.list.filter((x) => x.role === b.role).length;
      if ((far || count > want[b.role] || (b.role !== 'icebreaker' && lvl > 0.2)) && !this._visible(b.x, b.z, cam)) this.remove(b);
    }
    const count = (role) => this.list.filter((x) => x.role === role).length;
    if (count('crew') < want.crew) {
      const type = this.rng() < 0.5 ? 'eight' : this.rng() < 0.6 ? 'single' : 'four';
      const T = AI_TYPES[type];
      const b = this.add(type, { role: 'crew', s: this._spawnS(cam, lo, hi), dir: this.rng() < 0.5 ? 1 : -1, lane: 0.2 + this.rng() * 0.35, vt: T.speed * (0.55 + this.rng() * 0.3) });
      b.v = b.vt;
    }
    if (count('launch') < want.launch) {
      const crews = this.list.filter((x) => x.role === 'crew' && !this.list.some((l) => l.follow === x));
      if (crews.length) {
        const c = crews[Math.floor(this.rng() * crews.length)];
        const b = this.add('launch', { role: 'launch', s: c.s - c.dir * 18, d: c.d, dir: c.dir, follow: c, club: c.club, hull: 0xa2abb2 });
        b.v = c.v;
      }
    }
    if (count('motor') < want.motor) {
      // Pleasure boats keep to the wide basin below the BU Bridge.
      const basin = Math.max(lo, P.length * 0.6);
      const b = this.add('motor', { role: 'motor', s: this._spawnS(cam, basin, Math.max(basin + 10, hi)), dir: this.rng() < 0.5 ? 1 : -1, lane: 0.3 + this.rng() * 0.4, vt: 6 + this.rng() * 8, sMin: P.length * 0.58, hull: [0xc8102e, 0x1f3d6e, 0x2a8c5a, 0xf2c12e][Math.floor(this.rng() * 4)] });
      b.v = b.vt;
    }
    if (count('icebreaker') < want.icebreaker) {
      // The reaches nearest the focus that don't already have a ship.
      const used = new Set(this.list.filter((x) => x.role === 'icebreaker').map((x) => x.zone));
      // (During a race, only reaches clear of the course.)
      const rr = this.raceRange;
      const zs = this.zones.map((z, i) => ({ z, i, dist: f.s < z[0] ? z[0] - f.s : f.s > z[1] ? f.s - z[1] : 0 }))
        .filter((z) => !used.has(z.i) && !(rr && z.z[1] > rr[0] && z.z[0] < rr[1])).sort((a, b) => a.dist - b.dist);
      if (zs.length) {
        const { z, i } = zs[0];
        const b = this.add('icebreaker', { role: 'icebreaker', s: this._spawnS(cam, z[0], z[1]), dir: this.rng() < 0.5 ? 1 : -1, vt: AI_TYPES.icebreaker.speed, sMin: z[0], sMax: z[1], club: { jersey: 0x1d2c4a } });
        b.zone = i;
        b.v = b.vt;
      }
    }

    const light = this.light ?? 1;
    this.crunch = 0;
    for (const b of this.list) {
      b.visible = this._visible(b.x, b.z, cam);
      b.model.root.visible = b.visible || Math.hypot(b.x - cam.position.x, b.z - cam.position.z) < 1200;
      b.step(dt);
      b.pose(dt);
      this._wake(b, dt);
      if (b.role === 'icebreaker') this._breakIce(b, dt, cam);
    }
    this.wakes.update(this.time, light);
    this.slabs.update(dt);
  }

  // Foam behind each moving boat: a trail from the stern and, for anything
  // with an engine, the two arms of a wake spreading out behind.
  _wake(b, dt) {
    const T = b.T, sp = b.speed;
    if (sp < 0.6 || !b.model.root.visible) return;
    b.wakeAcc += sp * dt;
    const step = T.row ? 1.1 : b.type === 'icebreaker' ? 2.5 : Math.max(1.2, sp * 0.06);
    while (b.wakeAcc >= step) {
      b.wakeAcc -= step;
      this.emitWake(b, sp);
    }
  }

  emitWake(b, sp) {
    const T = b.T, fx = b.fx, fz = b.fz, rx = -fz, rz = fx, back = T.len * 0.5;
    const x = b.x - fx * back, z = b.z - fz * back, y = b.level ?? b.y;
    if (b.type === 'icebreaker') {
      this.wakes.emit(x, y, z, b.heading, 3.0, 0.32, 10, 0, 0, 2.5);
      for (const sd of [-1, 1]) this.wakes.emit(x + rx * sd * T.beam * 0.4, y, z + rz * sd * T.beam * 0.4, b.heading, 1.4, 0.22, 9, rx * sd * 0.8, rz * sd * 0.8, 3);
    } else if (T.motor) {
      const k = clamp(sp / 15, 0, 1);
      this.wakes.emit(x, y, z, b.heading, 0.9 + k * 0.7, 0.45 + k * 0.45, 5 + k * 4, 0, 0, 3);
      // Wake arms: spreading at about a third of the boat's speed.
      for (const sd of [-1, 1]) this.wakes.emit(x + rx * sd * T.beam * 0.45, y, z + rz * sd * T.beam * 0.45, b.heading + sd * 0.35, 0.4 + k * 0.35, 0.3 + k * 0.4, 4 + k * 4, rx * sd * sp * 0.12, rz * sd * sp * 0.12, 4);
      // Spray off the bow when planing.
      if (sp > 7) for (const sd of [-1, 1]) this.wakes.emit(b.x + fx * T.len * 0.2 + rx * sd * T.beam * 0.55, y, b.z + fz * T.len * 0.2 + rz * sd * T.beam * 0.55, b.heading + sd * 0.7, 0.35, 0.35 * k, 2.5, rx * sd * 1.5, rz * sd * 1.5, 2.5);
    } else {
      this.wakes.emit(x, y, z, b.heading, T.beam * 0.6 + 0.2, 0.09 + clamp(sp / 12, 0, 0.1), 5, 0, 0, 3.2);
      // Puddles where the blades came out.
      if (b.model?.rig && b.rate > 6 && Math.random() < 0.22) {
        const rig = b.model.rig, pin = rig.pins[Math.floor(Math.random() * rig.pins.length)];
        const s = Math.sign(pin[0]), off = Math.abs(pin[0]) + rig.outboard * 0.85;
        this.wakes.emit(b.x + rx * s * off - fx * (pin[2] + 0.8), y, b.z + rz * s * off - fz * (pin[2] + 0.8), b.heading, 0.3, 0.28, 4, 0, 0, 1);
      }
    }
  }

  // An icebreaker's bow and hull break the sheet; slabs tumble off the bow.
  _breakIce(b, dt, cam) {
    const ice = this.g.ice;
    if (!ice || ice.level < 0.3) return;
    const fx = b.fx, fz = b.fz, T = b.T;
    let n = 0;
    for (const u of [0.48, 0.2, -0.15, -0.45]) n += ice.breakAt(b.x + fx * T.len * u, b.z + fz * T.len * u, T.beam / 2 + 2.6);
    b.breaking = (b.breaking || 0) + (Math.min(1, n / 6) - (b.breaking || 0)) * damp(3, dt);
    const dist = Math.hypot(b.x - cam.position.x, b.z - cam.position.z);
    // More slabs the faster it goes.
    if (b.breaking > 0.05 && dist < 300 && Math.random() < dt * (14 + b.speed * 1.5) * b.breaking) {
      const sd = Math.random() < 0.5 ? -1 : 1, rx = -fz, rz = fx;
      const x = b.x + fx * T.len * 0.47 + rx * sd * (T.beam * 0.35 + Math.random() * 2);
      const z = b.z + fz * T.len * 0.47 + rz * sd * (T.beam * 0.35 + Math.random() * 2);
      this.slabs.base = b.y + 0.05;
      const sp = b.speed * 0.5;
      this.slabs.emit(x, b.y + 0.3, z, rx * sd * (1.2 + Math.random() + sp * 0.15) + fx * sp, rz * sd * (1.2 + Math.random() + sp * 0.15) + fz * sp, 0.8 + Math.random() * 1.6);
    }
    this.crunch = Math.max(this.crunch, b.breaking * Math.max(0, 1 - dist / 260));
  }

  // Push the player's boat out of AI hulls. Returns the impact speed.
  collidePlayer(body) {
    let impact = 0;
    const T = body.T;
    for (const b of this.list) {
      const dx = b.x - body.x, dz = b.z - body.z;
      const reach = (b.T.len + T.len) / 2 + 2;
      if (dx * dx + dz * dz > reach * reach) continue;
      const c = closestSegSeg(
        body.x - body.fx * T.len * 0.47, body.z - body.fz * T.len * 0.47, body.x + body.fx * T.len * 0.47, body.z + body.fz * T.len * 0.47,
        b.x - b.fx * b.T.len * 0.47, b.z - b.fz * b.T.len * 0.47, b.x + b.fx * b.T.len * 0.47, b.z + b.fz * b.T.len * 0.47,
      );
      const r = (T.beam + b.T.beam) / 2 + 0.25;
      if (c.d >= r) continue;
      let nx = c.ax - c.bx, nz = c.az - c.bz;
      const l = Math.hypot(nx, nz);
      if (l < 1e-4) { nx = -dx; nz = -dz; } else { nx /= l; nz /= l; }
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      const depth = r - c.d;
      body.x += nx * depth; body.z += nz * depth;
      const bvx = b.fx * b.v, bvz = b.fz * b.v;
      const vn = (body.vx - bvx) * nx + (body.vz - bvz) * nz;
      if (vn < 0) {
        const heavy = b.type === 'icebreaker' ? 1 : 0.5;
        body.vx -= (1 + 0.2) * vn * nx * heavy; body.vz -= (1 + 0.2) * vn * nz * heavy;
        impact = Math.max(impact, -vn);
        b.bump = 1.5;
      }
    }
    return impact;
  }

  // An icebreaker shoves a car on the ice aside.
  collideCar(car) {
    let impact = 0;
    for (const b of this.list) {
      if (b.type !== 'icebreaker') continue;
      const dx = car.x - b.x, dz = car.z - b.z;
      if (dx * dx + dz * dz > 30 * 30 || Math.abs(car.y - b.y) > 4) continue;
      const along = dx * b.fx + dz * b.fz, side = dx * -b.fz + dz * b.fx;
      const hl = b.T.len / 2 + 1.2, hw = b.T.beam / 2 + 1.1;
      if (Math.abs(along) > hl || Math.abs(side) > hw) continue;
      const push = (hw - Math.abs(side)) * Math.sign(side || 1);
      car.x += -b.fz * push; car.z += b.fx * push;
      const vn = car.vx * -b.fz * Math.sign(side || 1) + car.vz * b.fx * Math.sign(side || 1);
      if (vn < 1) { car.vx += -b.fz * Math.sign(side || 1) * (1 - vn); car.vz += b.fx * Math.sign(side || 1) * (1 - vn); }
      impact = Math.max(impact, 3);
    }
    return impact;
  }

  // Minimap dots.
  positions() {
    return this.list.map((b) => [b.x, b.z, b.type === 'icebreaker' ? '#ff6b4a' : b.role === 'race' ? '#ffd447' : '#e8f4ff']);
  }

  setNight(on) { setBoatNightLights(on); }

  clearAll() { for (const b of this.list.slice()) this.remove(b); }
}

function closestSegSeg(ax, az, bx, bz, cx, cz, dx, dz) {
  const ux = bx - ax, uz = bz - az, vx = dx - cx, vz = dz - cz, wx = ax - cx, wz = az - cz;
  const a = ux * ux + uz * uz, b = ux * vx + uz * vz, c = vx * vx + vz * vz, d = ux * wx + uz * wz, e = vx * wx + vz * wz;
  const D = a * c - b * b;
  let s = D > 1e-6 ? clamp((b * e - c * d) / D, 0, 1) : 0;
  let t = c > 1e-6 ? clamp((b * s + e) / c, 0, 1) : 0;
  s = a > 1e-6 ? clamp((b * t - d) / a, 0, 1) : 0;
  const px = ax + ux * s, pz = az + uz * s, qx = cx + vx * t, qz = cz + vz * t;
  return { d: Math.hypot(px - qx, pz - qz), ax: px, az: pz, bx: qx, bz: qz };
}
