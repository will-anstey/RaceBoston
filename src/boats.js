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
  // Small boats (small: true) are light enough for an icebreaker's crane to lift aboard.
  canoe: {
    name: 'Canoe', desc: 'A tandem canoe, two of you paddling: quiet, and close to the water', row: true, paddle: true, small: true, seats: 2,
    len: 5.2, beam: 0.9, rate: 34, sprintRate: 42, speed: 2.7, sprint: 3.4, drag: 0.1, back: 0.9, turnR: 6, spin: 0.7, lat: 6, cam: 0.95, eyeF: -1.4, eyeH: 1.05,
  },
  dinghy: {
    name: 'Rowboat', desc: 'A wooden rowboat with a pair of oars: no hurry', row: true, scull: true, small: true, seats: 1,
    len: 3.8, beam: 1.35, rate: 24, sprintRate: 30, speed: 2.9, sprint: 3.7, drag: 0.1, back: 1.0, turnR: 5, spin: 0.75, lat: 6, cam: 0.85, eyeF: 1.5, eyeH: 1.15,
  },
  single: {
    name: 'Single scull', desc: 'One sculler in 8 m of carbon fibre', row: true, scull: true, small: true, seats: 1,
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
    name: 'Icebreaker', desc: 'A 26 m river icebreaker: 60 mph flat out, slow to get going, and ice is no obstacle', motor: true, diesel: true, breaker: true, noBoost: true,
    len: 26, beam: 7.2, top: 26.8, accel: 1.3, curve: 3, reverse: 1.4, drag: 0.0012, turnR: 40, maxYaw: 0.32, wash: 0.12, thruster: 0.14, yawResp: 1.1, lat: 1.3,
    airDraft: 6.6, speed: 2.6, cam: 3.0, camLift: 7, eyeF: 0.7, eyeH: 5.4,
  },
  // Sea boats (sea: true) keep to the harbour, like the ships the AI sails. Diesels: W ahead,
  // S astern, H the horn; thrusters (the tug's are strong) turn them when they're stopped.
  tug: {
    name: 'Tugboat', desc: 'A harbor tug: 15 knots, a big push, and she turns on a dime', motor: true, diesel: true, sea: true, ship: true, noBoost: true,
    len: 28, beam: 10, top: 8, accel: 1.1, curve: 3, reverse: 1.8, drag: 0.002, turnR: 24, maxYaw: 0.45, wash: 0.25, thruster: 0.24, yawResp: 1.5, lat: 1.6,
    airDraft: 12, speed: 4.5, cam: 2.9, camLift: 6.5, eyeF: 3.5, eyeH: 7.4,
  },
  ferryboat: {
    name: 'Harbor ferry', desc: 'A catamaran ferry: 35 knots across the harbor, wide in the turns', motor: true, diesel: true, sea: true, ship: true, noBoost: true,
    len: 36, beam: 11, top: 18, accel: 1.6, curve: 3, reverse: 1.5, drag: 0.0015, turnR: 70, maxYaw: 0.32, wash: 0.12, thruster: 0.1, yawResp: 1.2, lat: 1.4,
    airDraft: 10, speed: 12, cam: 3.3, camLift: 7, eyeF: 2.8, eyeH: 8.0,
  },
  trawler: {
    name: 'Fishing boat', desc: 'A stern trawler out of the Fish Pier: steady at 12 knots', motor: true, diesel: true, sea: true, ship: true, noBoost: true,
    len: 24, beam: 7, top: 6.5, accel: 0.85, curve: 3, reverse: 1.2, drag: 0.002, turnR: 24, maxYaw: 0.42, wash: 0.2, thruster: 0.1, yawResp: 1.3, lat: 1.5,
    airDraft: 9, speed: 4, cam: 2.7, camLift: 5, eyeF: 4, eyeH: 5.2,
  },
};
export const BOAT_ORDER = ['motor', 'canoe', 'dinghy', 'single', 'eight', 'icebreaker', 'tug', 'ferryboat', 'trawler'];
// The player's colours, by boat (a hull, or a ship's livery).
export const PLAYER_LIVERY = { motor: 0xc8102e, canoe: 0x2e6b3f, tug: 0xc8102e, ferryboat: 0xc8102e, trawler: 0x2a6e4a };
// River traffic only.
export const AI_TYPES = {
  ...BOAT_TYPES,
  four: { ...BOAT_TYPES.eight, name: 'Four', seats: 4, cox: false, len: 13.4, beam: 0.55, speed: 9.2, sprint: 11.2 },
  launch: { ...BOAT_TYPES.motor, name: 'Coach launch', len: 5.2, beam: 1.9, top: 12 },
  // Ships at sea: they keep to the harbour. (big: they don't turn round in the channel.)
  cruise: { name: 'Cruise ship', ship: true, big: true, len: 240, beam: 32, speed: 5.5 },
  container: { name: 'Container ship', ship: true, big: true, len: 210, beam: 30, speed: 6 },
  tanker: { name: 'Tanker', ship: true, big: true, len: 180, beam: 30, speed: 5 },
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
// A canoe: pointed both ends, the sheer sweeping up at bow and stern.
function canoeStations(L, B, depth, sheer, n = 24) {
  const st = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, f = Math.sin(Math.PI * t);
    st.push([-L / 2 + t * L, Math.max(0.01, (B / 2) * Math.pow(f, 0.55)), Math.max(0.02, depth * Math.pow(f, 0.35)), sheer + 0.17 * (1 - f) ** 2]);
  }
  return st;
}

// A canoe paddle hanging down from its T-grip (origin): shaft, then the blade.
const paddleCache = new Map();
function paddleGeo(club) {
  const key = club.blade + ':' + club.tip;
  if (!paddleCache.has(key)) paddleCache.set(key, merge([
    box(0.034, 1.08, 0.034, 0, -0.56, 0, 0x9a6b3e),
    box(0.15, 0.045, 0.045, 0, 0, 0, 0x5a3a22),
    box(0.19, 0.5, 0.018, 0, -1.33, 0, club.blade),
    box(0.19, 0.07, 0.02, 0, -1.6, 0, club.tip),
  ]));
  return paddleCache.get(key);
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
  if (T.paddle) {
    // Two paddlers facing the bow, the bow paddler on the right and the stern on the left.
    const sheer = 0.27, wood = 0x8a5a33;
    body.push(...hullGeo(canoeStations(T.len, T.beam, 0.12, sheer), {
      top: hullColor, bottom: hullColor, boot: -1, stripe: wood, stripeY: sheer - 0.035, full: 1.15, deck: wood, deckAt: (z) => Math.abs(z) > T.len / 2 - 0.55,
    }));
    body.push(box(0.68, 0.035, 0.22, 0, 0.1, -1.55, wood), box(0.74, 0.035, 0.24, 0, 0.1, 1.75, wood), box(0.84, 0.035, 0.07, 0, 0.22, 0.05, wood));
    const rig = (m.rig = { seats: [-1.55, 1.75], sides: [1, -1], pins: [], inboard: 0, outboard: 0.85, seatY: 0.12, paddle: true });
    const crew = (m.crew = new THREE.InstancedMesh(figureGeo(club.jersey), M.crew, 2));
    crew.castShadow = true;
    for (let k = 0; k < 2; k++) crew.setMatrixAt(k, new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, rig.seatY, rig.seats[k]));
    root.add(crew);
    m.paddles = [0, 1].map(() => {
      const pm = new THREE.Mesh(paddleGeo(club), M.oar);
      pm.matrixAutoUpdate = false;
      pm.castShadow = true;
      root.add(pm);
      return pm;
    });
  } else if (T.row) {
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
  } else if (T.ship) {
    if (!hullCache.has(`${type}:${hullColor}`)) { const p = shipParts(type, hullColor); body.push(...p.body); glass.push(...p.glass); }   // (built once per livery)
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
  if (type === 'icebreaker') { m.crane = makeCrane(); root.add(m.crane.root); }
  if (m.rig) poseBoat(m, 0.5, 0.4, 1);
  return m;
}

// The icebreaker's deck crane, on a pedestal at the fore end of the foredeck:
// it slews (about the vertical) and luffs (the boom up and down) to lift a
// small boat aboard. Stowed, the boom lies aft over the foredeck.
export const CRANE = { z: -9.6, post: 2.4, pivot: 0.45, boom: 6, stowSlew: Math.PI, stowLuff: -0.06 };
function makeCrane() {
  const M = mats(), y0 = BREAKER.deckY(CRANE.z);
  const root = new THREE.Group(), slew = new THREE.Group(), luff = new THREE.Group();
  root.position.set(0, y0, CRANE.z);
  const post = new THREE.Mesh(merge([cyl(0.3, 0.36, CRANE.post, 0, CRANE.post / 2, 0, 0xf2f2ee), cyl(0.42, 0.42, 0.12, 0, 0.06, 0, 0x55595c)]), M.body);
  slew.position.y = CRANE.post;
  const house = new THREE.Mesh(merge([box(0.62, 0.55, 0.85, 0, 0.27, 0.12, 0xf26b1d), box(0.3, 0.3, 0.4, 0, 0.5, 0.42, 0x2a2a2a)]), M.body);
  luff.position.y = CRANE.pivot;
  const L = CRANE.boom;
  const boom = new THREE.Mesh(merge([box(0.24, 0.28, L, 0, 0, -L / 2, 0xf2b01d), box(0.3, 0.34, 0.3, 0, 0, -L + 0.12, 0x2a2a2a), box(0.06, 0.4, 0.06, 0, -0.32, -L + 0.12, 0x2a2a2a)]), M.body);
  post.castShadow = house.castShadow = boom.castShadow = true;
  luff.add(boom);
  slew.add(house, luff);
  root.add(post, slew);
  const c = { root, slew, luff, phi: CRANE.stowSlew, alpha: CRANE.stowLuff };
  setCrane(c, c.phi, c.alpha);
  return c;
}

// phi: slew from dead ahead toward starboard (+x); alpha: the boom's angle above level.
export function setCrane(c, phi, alpha) {
  c.phi = phi; c.alpha = alpha;
  c.slew.rotation.y = -phi;
  c.luff.rotation.x = alpha;
}

// The boom tip, ship-local.
export function craneTip(c, out = new THREE.Vector3()) {
  const r = CRANE.boom * Math.cos(c.alpha), y = BREAKER.deckY(CRANE.z) + CRANE.post + CRANE.pivot + CRANE.boom * Math.sin(c.alpha);
  return out.set(Math.sin(c.phi) * r, y, CRANE.z - Math.cos(c.phi) * r);
}

// ================================================================ ships
// Ships for the harbour, merged per type and colour: hull, superstructure
// (with window bands in the glass material, lit at night), and the gear of
// the trade: lifeboats, containers, pipework, fenders, a fishing gantry.
const CONTAINER_COLORS = [0xb3261e, 0x1f4e9c, 0x2a8c5a, 0xe0661e, 0x8a9096, 0xe8e8e2, 0xe0b02e, 0x7a4a26, 0x1f7a7a, 0x5a2a6e, 0x3a3d40];
const WIN = 0x24344a;
function shipParts(type, hullColor) {
  const body = [], glass = [], T = AI_TYPES[type];
  const L = T.len, B = T.beam;
  // Half-width of a planing hull at z, from its stations (to keep deck cargo on board).
  const hw = (z, bowLen) => { const t = (z + L / 2) / L; return (B / 2) * (t < bowLen ? Math.sin((Math.PI / 2) * (t / bowLen)) ** 0.75 : 1); };
  if (type === 'cruise') {
    const sh = 12;
    body.push(...hullGeo(planingStations(L, B, 8, sh, 3, 0.94, 26, 0.3), { top: 0xf4f4f0, bottom: 0x1b2a44, boot: 2.2, stripe: hullColor, stripeY: sh - 1.4, full: 1.8, deck: 0xc9c2b6, deckAt: () => true, transom: true }));
    for (let k = 0; k < 8; k++) {
      const y0 = sh + k * 3, front = -L / 2 + 40 + k * 5, back = L / 2 - 18 - Math.max(0, k - 4) * 9, w = B - 2 - (k > 5 ? 3 : 0);
      body.push(box(w, 3, back - front, 0, y0 + 1.5, (front + back) / 2, 0xf4f4f0));
      glass.push(box(w + 0.14, 1.25, back - front - 4, 0, y0 + 1.6, (front + back) / 2, WIN));
    }
    // The bridge across the front of the top decks, with wings.
    const fz = -L / 2 + 40 + 6 * 5 + 4;
    body.push(box(B + 3, 2.8, 7, 0, sh + 19.4, fz, 0xf4f4f0));
    glass.push(box(B + 3.1, 1.3, 7.1, 0, sh + 19.8, fz - 0.05, WIN));
    // Funnel, mast and radar, and a pool on the top deck.
    body.push(box(9, 11, 17, 0, sh + 24 + 5.5, 62, hullColor), box(9.3, 1.6, 17.3, 0, sh + 24 + 11.6, 62, 0x1a1a1a));
    body.push(box(1, 7, 1, 0, sh + 27.5, fz + 4, 0xe0e0e0), box(7, 0.4, 1.2, 0, sh + 30, fz + 4, 0x2a2a2a));
    body.push(box(10, 0.4, 16, 0, sh + 24.2, 18, 0x2aa8d8), box(12, 0.3, 30, 0, sh + 24.1, 18, 0xb8b0a2));
    // Lifeboats along both sides.
    for (let z = -60; z <= 52; z += 9.5) for (const sd of [-1, 1]) body.push(box(3.4, 2.6, 8.4, sd * (B / 2 + 0.2), sh + 4.3, z, 0xf2a01d));
  } else if (type === 'container') {
    const sh = 9;
    body.push(...hullGeo(planingStations(L, B, 10, sh, 3, 0.9, 24, 0.28), { top: hullColor, bottom: 0x8e2b1f, boot: 1.6, stripe: 0xf2f2ee, stripeY: sh - 0.45, full: 2.2, deck: 0x4a4f54, deckAt: () => true, transom: true }));
    // The house aft: accommodation, bridge with wings, funnel.
    const hz = L / 2 - 30;
    body.push(box(24, 16, 12, 0, sh + 8, hz, 0xf2f2ee), box(B + 2, 2.4, 5, 0, sh + 15, hz - 4, 0xf2f2ee), box(6, 9, 8, 0, sh + 19, hz + 9, hullColor), box(6.2, 1.2, 8.2, 0, sh + 24, hz + 9, 0x1a1a1a));
    for (const y of [4.5, 8.5, 12]) glass.push(box(24.12, 1, 12.12, 0, sh + y, hz, WIN));
    glass.push(box(B + 2.1, 1.1, 5.1, 0, sh + 15.3, hz - 4, WIN));
    // Containers, bay by bay forward of the house: 40 ft boxes, stacked two to five high.
    const rng = mulberry32(0x5eed + (hullColor & 0xffff));
    for (let z = -L / 2 + 30; z < hz - 13; z += 13) {
      const tiers = 2 + Math.floor(rng() * 4);
      for (let r = 0; r < 11; r++) {
        const x = (r - 5) * 2.5;
        if (Math.abs(x) + 1.25 > hw(z - 6, 0.28) - 0.8) continue;
        const n = tiers - (Math.abs(r - 5) > 3 ? 1 : 0) - (rng() < 0.15 ? 1 : 0);
        for (let k = 0; k < n; k++) body.push(box(2.42, 2.55, 12.1, x, sh + 1.32 + k * 2.6, z, CONTAINER_COLORS[Math.floor(rng() * CONTAINER_COLORS.length)]));
      }
    }
  } else if (type === 'tanker') {
    const sh = 7;
    body.push(...hullGeo(planingStations(L, B, 10, sh, 2.5, 0.92, 24, 0.25), { top: hullColor, bottom: 0x8e2b1f, boot: 2.4, stripe: 0xf2f2ee, stripeY: sh - 0.4, full: 2.4, deck: 0x7a3326, deckAt: () => true, transom: true }));
    const hz = L / 2 - 24;
    // Pipework down the middle under a catwalk, the manifold amidships.
    body.push(box(2.2, 1.0, L - 60, 0, sh + 0.6, -12, 0x8a9096), box(2.4, 0.15, L - 60, 0, sh + 2.2, -12, 0x6b7076));
    for (let z = -L / 2 + 30; z < hz - 10; z += 12) body.push(box(0.2, 1.6, 0.2, 1, sh + 1.4, z, 0x6b7076), box(0.2, 1.6, 0.2, -1, sh + 1.4, z, 0x6b7076));
    for (const x of [-9, -5, 5, 9]) body.push(box(1.1, 2.4, 7, x, sh + 1.2, -8, 0x8a9096));
    body.push(box(4, 3.5, 4, 0, sh + 1.75, -L / 2 + 22, 0xd0d0d0));
    body.push(box(24, 13, 12, 0, sh + 6.5, hz, 0xf2f2ee), box(B + 1, 2.4, 5, 0, sh + 12.6, hz - 4, 0xf2f2ee), box(5, 7, 7, 0, sh + 16.5, hz + 8, 0xc8102e), box(5.2, 1.2, 7.2, 0, sh + 20.4, hz + 8, 0x1a1a1a));
    for (const y of [4, 8]) glass.push(box(24.12, 1, 12.12, 0, sh + y, hz, WIN));
    glass.push(box(B + 1.1, 1.1, 5.1, 0, sh + 12.9, hz - 4, WIN));
  } else if (type === 'tug') {
    const sh = 2.4;
    body.push(...hullGeo(planingStations(L, B, 3.2, sh, 1.0, 0.85, 16, 0.3), { top: hullColor, bottom: 0x1c1c1c, boot: 0.8, stripe: 0xf2f2ee, stripeY: sh - 0.3, full: 1.6, deck: 0x4a4f54, deckAt: () => true, transom: true }));
    // Fenders: a black rubber band round her, and thick ones on the bow for pushing.
    for (const sd of [-1, 1]) body.push(box(0.5, 0.7, L * 0.62, sd * (B / 2 - 0.05), 1.55, 1.5, 0x1c1c1c));
    body.push(box(3.4, 1.4, 1.2, 0, 1.6, -L / 2 + 0.9, 0x1c1c1c));
    body.push(box(6.5, 2.6, 8, 0, sh + 1.3, -2.5, 0xf2f2ee), box(5.4, 2.2, 4.4, 0, sh + 3.7, -3.5, 0xf2f2ee), box(5.8, 0.25, 4.8, 0, sh + 4.9, -3.5, 0x2a2a2a));
    glass.push(box(5.5, 1.0, 4.5, 0, sh + 3.9, -3.5, WIN), box(6.6, 0.8, 8.1, 0, sh + 1.6, -2.5, WIN));
    for (const sd of [-1, 1]) body.push(cyl(0.5, 0.55, 3.2, sd * 1.6, sh + 3.2, 1.6, hullColor, 10), cyl(0.56, 0.56, 0.5, sd * 1.6, sh + 4.9, 1.6, 0x1a1a1a, 10));
    body.push(box(0.25, 4.4, 0.25, 0, sh + 7.2, -4, 0xdddddd), box(3, 1.2, 2, 0, sh + 0.6, 8, 0x2a8c5a), box(0.5, 0.9, 0.5, 0, sh + 0.45, 11.8, 0x1a1a1a));
  } else if (type === 'ferryboat') {
    // A catamaran: two hulls under a cross-deck, a cabin with windows all round, the wheelhouse on top.
    for (const sd of [-1, 1]) for (const g of hullGeo(planingStations(L, 3.0, 1.6, 2.2, 0.6, 0.9, 16, 0.35), { top: 0xf2f2ee, bottom: 0x1c1c1c, boot: 0.4, stripe: hullColor, stripeY: 1.7, full: 1.4, transom: true })) body.push(g.translate(sd * 3.9, 0, 0));
    body.push(box(11, 0.7, L - 3, 0, 2.5, 0.8, 0xf2f2ee), box(11.06, 0.55, L - 3, 0, 2.0, 0.8, hullColor));
    body.push(box(10.2, 2.7, 24, 0, 4.2, 1.8, 0xf2f2ee), box(8, 2.3, 10, 0, 6.7, -2.8, 0xf2f2ee), box(8.4, 0.25, 10.4, 0, 7.9, -2.8, 0x2a2a2a));
    glass.push(box(10.3, 1.25, 23, 0, 4.45, 1.8, WIN), box(8.1, 1.0, 9.6, 0, 6.95, -2.8, WIN));
    body.push(box(0.2, 2.6, 0.2, 0, 9.2, -5, 0xdddddd), box(9.6, 0.9, 0.12, 0, 3.4, L / 2 - 2, 0xd8dade));
  } else if (type === 'trawler') {
    const sh = 2.4;
    body.push(...hullGeo(planingStations(L, B, 2.6, sh, 1.4, 0.8, 16, 0.38), { top: hullColor, bottom: 0x8e2b1f, boot: 0.6, stripe: 0xf2f2ee, stripeY: sh - 0.25, full: 1.4, deck: 0x6b6b60, deckAt: () => true, transom: true }));
    body.push(box(4.2, 2.6, 4.6, 0, sh + 1.3, -4, 0xf2f2ee), box(4.5, 0.25, 4.9, 0, sh + 2.65, -4, 0x2a2a2a));
    glass.push(box(4.3, 0.9, 4.7, 0, sh + 2.0, -4, WIN));
    // Mast with outrigger booms, the A-frame gantry over the stern, the net drum.
    body.push(box(0.3, 6.5, 0.3, 0, sh + 3.2, -1.2, 0xdddddd));
    for (const sd of [-1, 1]) body.push(bar(0, sh + 5.8, -1.2, sd * 6.5, sh + 2.2, 0.5, 0.14, 0xdddddd), bar(sd * 2.7, sh, L / 2 - 1.2, sd * 1.0, sh + 5.2, L / 2 - 2.6, 0.24, 0xf2b01d));
    body.push(box(2.4, 0.32, 0.32, 0, sh + 5.2, L / 2 - 2.6, 0xf2b01d), box(3.2, 1.7, 1.7, 0, sh + 0.9, L / 2 - 6.5, 0x2a8c5a), box(3.6, 0.5, 0.6, 0, sh + 0.25, L / 2 - 4.5, 0xe0661e));
  }
  return { body, glass };
}

// An upturned hull (Harbor Rescue): keel up, red antifouling, and a band of
// white topsides showing at the waterline. Float it `float` (x scale) up.
export function buildWreck(type) {
  const T = AI_TYPES[type], key = 'wreck:' + type, dinghy = type === 'dinghy';
  if (!hullCache.has(key)) {
    const st = dinghy ? planingStations(T.len, T.beam, 0.32, 0.42, 0.12, 0.72, 14, 0.4) : planingStations(T.len, T.beam, 0.45, 0.78, 0.22, 0.88);
    hullCache.set(key, { body: merge(hullGeo(st, { top: 0xf4f4f0, bottom: 0x8e2b1f, boot: 0.02, full: dinghy ? 1 : 1.2, transom: true })) });
  }
  const root = new THREE.Group(), hull = new THREE.Mesh(hullCache.get(key).body, mats().body);
  hull.castShadow = true;
  hull.receiveShadow = true;
  root.add(hull);
  return { root, type, T, hull, depth: dinghy ? 0.32 : 0.45, float: 0.14 };
}

const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const ease = (t) => t * t * (3 - 2 * t);

// Rowers and oars at stroke phase 0..1 (drive for phase < Dr, then the
// recovery), blended toward resting with the blades flat on the water.
export function poseBoat(m, phase, Dr, rest) {
  const rig = m.rig;
  if (!rig) return;
  if (m.paddles) { posePaddles(m, phase, Dr, rest); return; }
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

// Canoe paddles: in at the catch by the paddler's knee, pulled back along
// the side, out and swung forward feathered; at rest, across the gunwales.
const _zb = new THREE.Vector3(0, 0, 1);
function posePaddles(m, phase, Dr, rest) {
  const rig = m.rig, B = m.T.beam;
  for (let k = 0; k < m.paddles.length; k++) {
    const s = rig.sides[k], z0 = rig.seats[k];
    let bz, by, gz, gy, feather;
    if (phase < Dr) {
      const u = ease(phase / Dr);
      bz = z0 - 0.8 + 1.2 * u; by = -0.3; gz = z0 - 0.25 + 0.3 * u; gy = 0.95 - 0.1 * u; feather = 0;
    } else {
      const u = ease((phase - Dr) / (1 - Dr));
      bz = z0 + 0.4 - 1.2 * u; by = 0.1 + 0.18 * Math.sin(Math.PI * u); gz = z0 + 0.05 - 0.3 * u; gy = 0.85 + 0.1 * u;
      feather = u < 0.15 ? u / 0.15 : u > 0.85 ? (1 - u) / 0.15 : 1;
    }
    let gx = s * 0.1, bx = s * (B / 2 + 0.17);
    if (rest > 0) {
      gx += (-s * 0.28 - gx) * rest; gy += (0.38 - gy) * rest; gz += (z0 - 0.3 - gz) * rest;
      bx += (s * (B / 2 + 0.8) - bx) * rest; by += (0.3 - by) * rest; bz += (z0 - 0.45 - bz) * rest; feather += (1 - feather) * rest;
    }
    gy += rig.seatY;
    _y.set(gx - bx, gy - by, gz - bz).normalize();   // up the shaft, from the blade to the grip
    _x.crossVectors(_y, _zb).normalize();            // the blade's width, across the stroke
    _z.crossVectors(_x, _y);
    // Feathered: turned edge-on for the recovery.
    const f = (feather * Math.PI) / 2, cf = Math.cos(f), sf = Math.sin(f);
    const xx = _x.x * cf + _z.x * sf, xy = _x.y * cf + _z.y * sf, xz = _x.z * cf + _z.z * sf;
    _x.set(xx, xy, xz);
    _z.crossVectors(_x, _y);
    const pm = m.paddles[k];
    pm.matrix.makeBasis(_x, _y, _z).setPosition(gx, gy, gz);
    pm.matrixWorldNeedsUpdate = true;
  }
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
    // The waterway it follows: the Charles (default) or the harbour channel.
    this.P = opts.path || boats.path;
    this.info = boats.infoFor(this.P);
    this.sMin = opts.sMin ?? 40; this.sMax = opts.sMax ?? this.P.length - 40;
    this.free = null; this.help = null;
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
    const B = this.B, P = this.P, T = this.T;
    if (this.help) this._stepHelp(dt);
    if (this.free) { this._stepFree(dt); return; }
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
    if (T.ship) { this._stepShip(dt); return; }
    let vt = this.vt * (this.bump > 0 ? 0.3 : 1);
    this.bump = Math.max(0, this.bump - dt);
    // Ice closing in: everything but an icebreaker stops dead.
    const ice = B.g.ice;
    if (this.type !== 'icebreaker' && this.role !== 'race' && ice && ice.level > 0.2 && ice.solidAt(this.x + this.fx * T.len * 0.5, this.z + this.fz * T.len * 0.5)) { vt = 0; this.v *= 0.9; }
    if (this.follow && !this.follow.dead) {
      // Coach launch: ride alongside a crew, a little behind.
      const f = this.follow;
      this.dir = f.dir;
      const gap = f.s - this.dir * 18 - this.s;
      vt = clamp(f.v + gap * this.dir * 0.4, 0, this.T.top);
    }
    const player = B.playerBody;
    if (player && this.role !== 'race' && this.type !== 'icebreaker') {
      const ahead = (player.x - this.x) * this.fx + (player.z - this.z) * this.fz;
      const side = Math.abs((player.x - this.x) * -this.fz + (player.z - this.z) * this.fx);
      if (ahead > 0 && ahead < 35 && side < 8) vt = Math.min(vt, Math.max(0, (ahead - 12) * 0.25));
    }
    // Patrols turn back short of anything marked to keep clear of (a rescue's capsized boats).
    if (this.role === 'icebreaker' && B.avoid) {
      for (const a of B.avoid) {
        const dx = a.x - this.x, dz = a.z - this.z;
        if (dx * dx + dz * dz < (a.r + 45) ** 2 && dx * this.fx + dz * this.fz > 0) {
          this.turn = { t: 0, dur: 34, h0: this.heading, sign: (this.d > 0) === (this.dir > 0) ? -1 : 1 };
          this._place(true);
          return;
        }
      }
    }
    this.v += (vt - this.v) * damp(T.row ? 0.6 : 0.9, dt);
    this.s += this.dir * this.v * dt;
    const p = P.at(this.s, 0, B._p);
    const m = this.margin();
    let want;
    if (this.role === 'icebreaker') want = [0, 0.45, -0.45, 0.22, -0.22][this.pass % 5] * Math.min(p.right, p.left, 400);
    else if (this.role === 'rescue') want = this.help.lane;
    else if (this.follow && !this.follow.dead) want = this.follow.d + (this.follow.d > 0 ? -1 : 1) * 14;
    else if (this.role === 'race') want = this.lane;
    else want = this.dir > 0 ? this.lane * p.right : -this.lane * p.left;
    want = B.avoidPillars(this.info, this.s + this.dir * 22, want, this.T.row ? this.model.rig.outboard + 1.2 : T.beam / 2 + 1.5);
    if (P === B.harbor) want = B.clearOfShips(this, want);
    want = clamp(want, -(p.left - m), p.right - m);
    if (p.left + p.right < 2 * m) want = (p.right - p.left) / 2;
    const lat = this.role === 'rescue' ? 3 : 1.5;
    const dd = clamp(want - this.d, -lat * dt, lat * dt);
    this.d += dd;
    this._dt = dt;
    if (this.role !== 'race' && this.role !== 'rescue' && ((this.dir < 0 && this.s < this.sMin) || (this.dir > 0 && this.s > this.sMax))) {
      // Spin and row back the other way, turning toward the wider side.
      this.turn = { t: 0, dur: T.row ? 14 : this.type === 'icebreaker' ? 34 : 6, h0: this.heading, sign: (this.d > 0) === (this.dir > 0) ? -1 : 1 };
    }
    this._place(false, dd / Math.max(dt, 1e-3));
  }

  // Ships keep to starboard of the channel line. Big ones are slow to change
  // speed, ease off behind a slower ship ahead, and stop at the end of their
  // run (alongside a terminal, or out to sea); tugs keep station off a big
  // ship's bow; small craft turn round at the ends. At anchor they just swing.
  _stepShip(dt) {
    const B = this.B, P = this.P, T = this.T, ice = B.g.ice;
    if (this.role === 'anchored') {
      this.v = 0;
      this.heading = this.h0 + 0.04 * Math.sin(B.time * 0.03 + this.phase * 6);
      this.level = B.g.map.terrain.h(this.x, this.z);
      this.y = this.level + 0.04 * Math.sin(B.time * 0.35 + this.phase * 5);
      return;
    }
    let vt = this.vt * (ice && ice.level > 0.45 ? 0.6 : 1);   // (ramming the ice)
    const f = this.follow && !this.follow.dead ? this.follow : null;
    if (f) {
      this.dir = f.dir;
      const gap = f.s + f.dir * f.T.len * 0.3 - this.s;
      vt = clamp(f.v + gap * this.dir * 0.3, 0, T.top || T.speed * 1.5);
    } else {
      this.follow = null;
      for (const o of B.list) {
        if (o === this || !o.T.ship || o.P !== P || o.follow === this) continue;
        const ahead = (o.s - this.s) * this.dir, room = (o.T.len + T.len) / 2 + 120;
        if (ahead > 0 && ahead < room && Math.abs(o.d - this.d) < (o.T.beam + T.beam) / 2 + 12) vt = Math.min(vt, Math.max(0, o.v * (ahead - room * 0.6) / (room * 0.4)));
      }
    }
    if ((this.dir < 0 && this.s < this.sMin) || (this.dir > 0 && this.s > this.sMax)) {
      if (T.big) { vt = 0; this.arrived = (this.arrived || 0) + dt; }
      else if (!f) { this.turn = { t: 0, dur: 26, h0: this.heading, sign: (this.d > 0) === (this.dir > 0) ? -1 : 1 }; this._place(true); return; }
    }
    this.v += (vt - this.v) * damp(T.big ? 0.12 : 0.5, dt);
    this.s += this.dir * this.v * dt;
    const p = P.at(this.s, 0, B._p), m = T.beam / 2 + 12;
    let want = f ? f.d + this.side * (f.T.beam / 2 + T.beam / 2 + 9) : this.dir * this.shipLane;
    if (!f) want = B.clearOfShips(this, want);
    want = clamp(want, -(p.left - m), p.right - m);
    if (p.left + p.right < 2 * m) want = (p.right - p.left) / 2;
    const lat = T.big ? 0.8 : 2, dd = clamp(want - this.d, -lat * dt, lat * dt);
    this.d += dd;
    this._dt = dt;
    this._place(false, dd / Math.max(dt, 1e-3));
  }

  // Steer for a list of points (answering a call for help: round the boat in
  // trouble, then in to the bank), passing each in turn and stopping at the
  // last. s and d follow along, so it can take up the waterway again after.
  _stepFree(dt) {
    const f = this.free, B = this.B;
    while (f.pts.length > 1 && Math.hypot(f.pts[0][0] - this.x, f.pts[0][1] - this.z) < (f.pass ?? 14)) f.pts.shift();
    const [tx, tz] = f.pts[0], last = f.pts.length === 1, stop = f.stop ?? 0;
    const dx = tx - this.x, dz = tz - this.z, dist = Math.hypot(dx, dz);
    const err = wrapAngle(Math.atan2(dx, -dz) - this.heading), turn = f.turn ?? 0.38;
    if (dist > 1) this.heading = wrapAngle(this.heading + clamp(err, -turn * dt, turn * dt));
    // Slow for a sharp turn, and to a stop at the last point (unless chasing a moving one).
    let vt = f.v * (0.35 + 0.65 * Math.max(0, Math.cos(err)));
    if (last && !f.chase) vt = dist < stop ? 0 : Math.min(vt, Math.max(0.6, (dist - stop) * 0.25));
    this.v += (vt - this.v) * damp(0.8, dt);
    this.x += Math.sin(this.heading) * this.v * dt;
    this.z -= Math.cos(this.heading) * this.v * dt;
    const pr = this.P.project(this.x, this.z, this.s, this._pf || (this._pf = {}));
    this.s = pr.s; this.d = pr.d;
    this.dir = Math.cos(this.P.heading(this.s, 1) - this.heading) >= 0 ? 1 : -1;
    this.level = B.g.map.terrain.h(this.x, this.z);
    this.y = this.level + 0.02 * Math.sin(B.time * 1.3 + this.phase * 5);
    f.arrived = last && dist < stop + 2.5 && this.v < 0.5;
  }

  // Answering a call for help: up the waterway to the boat frozen in, once
  // round it (the sheet inside her turn cracks up as she goes), then out
  // ahead cutting a channel to the nearest bank, peeling off short of it so
  // the boat can follow her in and land. She waits there till it has.
  _stepHelp(dt) {
    const h = this.help, B = this.B, pl = B.playerBody, ice = B.g.ice;
    if (!pl || (h.phase !== 'pickup' && (!ice || ice.level < 0.25))) { this.endHelp(); return; }
    h.t += dt;
    if (h.phase === 'pickup') return;   // (taking a small boat aboard: pickup.js has the helm)
    const dx = this.x - pl.x, dz = this.z - pl.z;
    h.dist = Math.hypot(dx, dz);
    // Round the boat wide enough that her stern, swinging as she turns away, keeps clear of it.
    const R = (h.R = Math.max(pl.T.len / 2 + 14, 22));
    const a = Math.atan2(dx, -dz);   // bearing of the icebreaker from the boat
    if (h.phase === 'approach') {
      if (h.dist < 160) { h.phase = 'close'; h.t = 0; }
      else {
        this.free = null;
        const pr = this.P.project(pl.x, pl.z, this.s, h.pr || (h.pr = {}));
        const ds = pr.s - this.s;
        if (!this.turn && Math.abs(ds) > 30 && Math.sign(ds) !== this.dir) this.turn = { t: 0, dur: 10, h0: this.heading, sign: (this.d > 0) === (this.dir > 0) ? -1 : 1 };
        this.vt = Math.abs(ds) > 260 ? 10 : 7;
        h.lane = pr.d;
      }
    }
    if (h.phase === 'close') {
      // Straight in to the nearest point of a circle round the boat.
      this.turn = null;
      const ex = pl.x + Math.sin(a) * R, ez = pl.z - Math.cos(a) * R;
      this.free = { pts: [[ex, ez]], v: h.dist > 60 ? 7 : 5, chase: true };
      if (Math.hypot(this.x - ex, this.z - ez) < 7 || h.dist < R + 5) {
        h.phase = 'around'; h.t = 0; h.sweep = 0; h.prevA = a;
        h.sign = Math.sin(wrapAngle(this.heading - a)) > 0 ? 1 : -1;   // round the way she's heading
        h.shore = pl.T.small ? null : B.shoreFrom(pl.x, pl.z);
        h.arrived = true;
      }
    } else if (h.phase === 'around') {
      h.sweep += wrapAngle(a - h.prevA) * h.sign;
      h.prevA = a;
      const ta = a + h.sign * 0.6;
      this.free = { pts: [[pl.x + Math.sin(ta) * R, pl.z - Math.cos(ta) * R]], v: 5, chase: true, turn: 0.45 };
      const n = Math.ceil((R - 3) / 4);
      for (let k = 0; k <= n; k++) { const u = (k / n) * (R - 3); ice.breakAt(pl.x + Math.sin(a) * u, pl.z - Math.cos(a) * u, 4.2, 0); }
      // Round at least once-ish, then curve away out toward the bank (leaving the circle a
      // little before its bearing, so she bears off gently rather than pivoting).
      // A small boat she'll take aboard: once all the way round.
      const sh = h.shore, toShore = sh ? Math.abs(wrapAngle(a - Math.atan2(sh.ux, -sh.uz) + h.sign * 0.55)) : 0;
      const done = pl.T.small ? h.sweep > Math.PI * 2 - 0.2 || h.t > 80 : (h.sweep > Math.PI * 1.25 && toShore < 0.3) || h.sweep > Math.PI * 3.4 || h.t > 90;
      if (done) {
        ice.breakAt(pl.x, pl.z, pl.T.len / 2 + 4, 0);
        if (pl.T.small) h.phase = 'pickup';
        else this._planLead(h, pl);
      }
    }
    if (h.phase === 'lead' || h.phase === 'wait') {
      const sh = h.shore;
      if (sh) {
        // Cut the way in a little ahead of her (all of it once she peels off), and keep it open.
        const along = (this.x - h.ox) * sh.ux + (this.z - h.oz) * sh.uz + 16;
        const goal = h.phase === 'wait' || this.free.pts.length === 1 ? sh.D : clamp(along, 0, sh.D);
        if (goal > h.front) {
          const to = Math.min(goal, h.front + Math.max(6 * dt, along - h.front));
          for (let u = h.front; u <= to; u += 4) ice.breakAt(h.ox + sh.ux * u, h.oz + sh.uz * u, CHANNEL, 0);
          h.front = to;
        }
        h.keep = (h.keep || 0) + dt;
        if (h.keep > 18) {
          h.keep = 0;
          for (let u = 0; u <= h.front; u += 4) ice.breakAt(h.ox + sh.ux * u, h.oz + sh.uz * u, CHANNEL, 0);
        }
        // The broken ice in and beside the channel is loose: a bump against its edge can't wedge the boat.
        const off = Math.abs((pl.x - h.ox) * -sh.uz + (pl.z - h.oz) * sh.ux), u0 = (pl.x - h.ox) * sh.ux + (pl.z - h.oz) * sh.uz;
        h.loose = (h.loose || 0) - dt;
        if (h.loose <= 0 && off < CHANNEL + 12 && u0 > -20 && u0 < sh.D + 10) { h.loose = 0.4; ice.breakAt(pl.x, pl.z, pl.T.len / 2 + 3, 0); }
        h.toShore = Math.hypot(pl.x - sh.x, pl.z - sh.z);
        h.safe = h.toShore < 26;
      }
      if (h.phase === 'lead' && (this.free.arrived || h.t > 160)) { h.phase = 'wait'; h.t = 0; }
      if (h.phase === 'wait') {
        this.free = { pts: [[this.x, this.z]], v: 0, stop: 6 };
        if (h.t > 200 || (sh && h.toShore > 600)) this.endHelp();
      }
    }
  }

  // The way to the bank: out from the boat toward the nearest shore, then
  // aside, short of it, to leave the landing clear.
  _planLead(h, pl) {
    const sh = h.shore, cw = this.B.g.collision;
    h.phase = 'lead'; h.t = 0; h.ox = pl.x; h.oz = pl.z; h.front = 0;
    if (!sh) { h.phase = 'wait'; this.free = { pts: [[this.x, this.z]], v: 0, stop: 6 }; return; }
    const pts = [], px = -sh.uz, pz = sh.ux;
    // Out along the way in (first well clear of the boat), then aside short of the bank.
    if (sh.D > h.R + 70) pts.push([pl.x + sh.ux * (h.R + 30), pl.z + sh.uz * (h.R + 30)]);
    if (sh.D > h.R + 45) pts.push([pl.x + sh.ux * (sh.D - 34), pl.z + sh.uz * (sh.D - 34)]);
    const first = (this.x - pl.x) * px + (this.z - pl.z) * pz >= 0 ? 1 : -1;
    const wet = (x, z) => { for (let k = 0; k < 8; k++) { const t = (k / 8) * Math.PI * 2; if (!cw.isWaterSurface(x + Math.cos(t) * 11, z + Math.sin(t) * 11)) return false; } return cw.isWaterSurface(x, z); };
    let aside = null;
    for (const back of [24, 40, 60]) {
      for (const sd of [first, -first]) {
        const off = this.T.len + 10, x = sh.x - sh.ux * back + px * sd * off, z = sh.z - sh.uz * back + pz * sd * off;
        if (!aside && wet(x, z)) aside = [x, z];
      }
    }
    pts.push(aside || [pl.x + sh.ux * Math.max(0, sh.D - 45), pl.z + sh.uz * Math.max(0, sh.D - 45)]);
    this.free = { pts, v: 4, stop: 4 };
  }

  // Back to patrolling her reach.
  endHelp() {
    this.help = null; this.free = null; this.turn = null;
    this.role = 'icebreaker';
    this.vt = AI_TYPES.icebreaker.speed;
    this.rejoin = true;
  }

  _place(keepHeading, lat = 0) {
    const B = this.B, q = this.P.at(this.s, this.d, B._q);
    this.x = q.x; this.z = q.z;
    if (!keepHeading) {
      let h = Math.atan2(q.tx * this.dir, -q.tz * this.dir) + Math.atan2(lat * this.dir, Math.max(1, this.v)) * 0.8;
      // Swinging back onto the waterway after a rescue: not in one jump.
      if (this.rejoin) {
        const e = wrapAngle(h - this.heading);
        if (Math.abs(e) < 0.03) this.rejoin = false;
        else h = this.heading + clamp(e, -0.25 * (this._dt || 0.016), 0.25 * (this._dt || 0.016));
      }
      this.heading = h;
    }
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
    } else if (T.ship) {
      const t = this.B.time + this.phase * 9;
      this.pitch = (T.big ? 0.0015 : 0.006) * Math.sin(t * (T.big ? 0.35 : 0.9)) - (T.big ? 0 : 0.015 * clamp(this.v / 10, 0, 1));
      this.roll = (T.big ? 0.002 : 0.012) * Math.sin(t * (T.big ? 0.27 : 0.7));
    } else {
      this.pitch = this.type === 'icebreaker' ? 0.004 * Math.sin(this.B.time * 0.7) : -0.05 * clamp(this.v / 8, 0, 1);
      this.roll = this.type === 'icebreaker' ? 0.006 * Math.sin(this.B.time * 0.5 + 1) : 0;
    }
    placeBoat(m, this);
  }

  dispose() {
    this.dead = true;
    if (this.cargo) disposeBoat(this.cargo);   // a boat she lifted aboard
    disposeBoat(this.model);
  }
}

// Half-width of the channel an icebreaker cuts to lead a boat in to the bank.
const CHANNEL = 9;
// Icebreakers' names, for the radio.
const BREAKER_NAMES = ['Frostline', 'Winter Hawk', 'Snowy Owl', "Nor'easter", 'Kestrel', 'Harbor Bear', 'Ice Queen', 'Cold Spring'];

// Ships' liveries (hull, or stripe and funnel), and the anchorage in President Roads (s, d).
const SHIP_LIVERY = {
  cruise: [0x1f4e9c, 0xc8102e, 0x1f7a7a], container: [0x1f2d3d, 0x1f4e9c, 0x2a6e4a, 0x6b2a1f], tanker: [0x1c1c1c, 0x2a3a4a, 0x5a1f1a],
  tug: [0xb3261e, 0x1f4e9c], ferryboat: [0x1f4e9c, 0x2a8c5a], trawler: [0x1f4e9c, 0x2a6e4a, 0xb3261e],
};
const ANCHORAGE = [[6250, 480], [6900, -440], [5400, -560], [5850, 800], [6550, 950], [7250, 380], [5000, 640], [6100, -950], [7000, 900]];
// Ships in and around the harbour by boat density: at anchor, under way (big), tugs, ferries,
// fishing boats. Many (3) is a busy port: twenty-odd ships about the harbour.
const SHIPS = { anchored: [0, 1, 2, 6], big: [0, 1, 1, 4], tug: [0, 1, 2, 5], ferryboat: [0, 1, 1, 3], trawler: [0, 0, 1, 6] };

const CREWS = [0, 4, 8, 12], LAUNCHES = [0, 1, 2, 3], MOTORS = [0, 1, 3, 4], BREAKERS = [0, 1, 2, 3], HARBOR_BREAKERS = [0, 1, 2, 3];

export class Boats {
  constructor(game) {
    this.g = game;
    this.path = game.map.river && game.map.river.length >= 8 ? new RiverPath(game.map.river) : null;
    this.harbor = game.map.harbor && game.map.harbor.length >= 8 ? new RiverPath(game.map.harbor) : null;
    this.infos = new Map();
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
    this._fh = {};
    if (this.path) {
      const info = this._analyse(game.collision, this.path);
      this.clear = info.clear; this.piles = info.piles; this.zones = info.zones;
    }
    if (this.harbor) this._analyse(game.collision, this.harbor);
  }

  infoFor(P) { return this.infos.get(P) || { clear: [], piles: new Map(), zones: [] }; }

  // The waterway a point is on: the Charles or the harbour (or the nearer).
  pathFor(x, z) {
    const w = this.g.ice ? this.g.ice.waterAt(x, z) : null;
    if (w === 'river' && this.path) return this.path;
    if (w === 'sea' && this.harbor) return this.harbor;
    const a = this.path ? this.path.project(x, z, null, {}).dist : Infinity, b = this.harbor ? this.harbor.project(x, z, null, {}).dist : Infinity;
    return a <= b ? this.path : this.harbor;
  }

  setDensity(n) { this.density = clamp(n | 0, 0, 3); }

  // One of each boat, out of the way, for the renderer to compile their
  // shaders at load (else the first crew on screen hitches the frame).
  warmup() {
    const out = [];
    const list = ['eight', 'single', 'dinghy', 'canoe', 'motor', 'launch', 'icebreaker'].map((t) => [t, undefined]);
    // Every ship livery too (and their geometry, cached: the container ship is hundreds of boxes).
    for (const [t, cols] of Object.entries(SHIP_LIVERY)) for (const c of cols) list.push([t, c]);
    for (const [type, hull] of list) {
      const m = buildBoat(type, CLUBS[0], hull);
      m.root.position.set(this.g.camera.position.x, -400, this.g.camera.position.z);
      this.g.scene.add(m.root);
      out.push(m);
    }
    return out;
  }
  coolDown(list) { for (const m of list) disposeBoat(m); }

  // Bridge clearance and piles along a waterway; the reaches icebreakers work.
  _analyse(cw, P) {
    const T = this.g.map.terrain, n = P.n;
    const info = { clear: new Float32Array(n), piles: new Map(), zones: [] };
    this.infos.set(P, info);
    for (let i = 0; i < n; i++) {
      const x = P.x[i], z = P.z[i], lvl = T.h(x, z);
      let c = Infinity;
      for (const d of [-14, -7, 0, 7, 14]) c = Math.min(c, cw.deckAbove(x - P.tz[i] * d, z + P.tx[i] * d, lvl) - lvl);
      info.clear[i] = c;
    }
    // Piles near the line, as (s, d) pairs bucketed every 10 m.
    const piles = info.piles;
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
        if (!piles.has(key)) piles.set(key, []);
        piles.get(key).push(pr.d, G.pts[3 * j + 2]);
      }
    }
    // Icebreaker reaches: between the bridges too low for them.
    let start = -1;
    for (let i = 0; i <= n; i++) {
      const ok = i < n && info.clear[i] - SLAB > AIR_DRAFT;
      if (ok && start < 0) start = i;
      if (!ok && start >= 0) {
        const s0 = P.s[start] + 45, s1 = P.s[i - 1] - 45;
        if (s1 - s0 > 250) info.zones.push([s0, s1]);
        start = -1;
      }
    }
    return info;
  }

  // Shift a lateral offset off any pile near s (keeps half-width w clear).
  avoidPillars(info, s, d, w) {
    const list = info.piles.get(Math.floor(s / 10));
    const near = info.piles.get(Math.floor(s / 10) + 1);
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

  _visible(x, z, cam, far = 900) {
    const dx = x - cam.position.x, dz = z - cam.position.z, d = Math.hypot(dx, dz);
    if (d < 60) return true;
    if (d > far) return false;
    cam.getWorldDirection(this._dir || (this._dir = new THREE.Vector3()));
    return (dx * this._dir.x + dz * this._dir.z) / d > 0.35;
  }

  add(type, opts) {
    if (type === 'icebreaker' && !opts.name) opts = { ...opts, name: BREAKER_NAMES[(this._names = (this._names || 0) + 1) % BREAKER_NAMES.length] };
    const b = new AIBoat(this, type, opts);
    this.list.push(b);
    return b;
  }
  remove(b) { const i = this.list.indexOf(b); if (i >= 0) this.list.splice(i, 1); b.dispose(); }
  clearRole(role) { for (const b of this.list.filter((x) => x.role === role)) this.remove(b); }

  // A spot along P out of sight of the camera (strict: or null; else anywhere).
  _spawnS(cam, lo, hi, P = this.path, far = 900, strict = false) {
    for (let k = 0; k < 12; k++) {
      const s = lo + this.rng() * (hi - lo);
      const p = P.at(s, 0, this._p);
      if (!this._visible(p.x, p.z, cam, far)) return s;
      if (k === 11) return strict ? null : s;
    }
    return lo;
  }

  // A lateral offset for b on the harbour channel that keeps clear of the ships near it.
  clearOfShips(b, want) {
    for (const o of this.list) {
      if (o === b || !o.T.ship || o.P !== b.P || o.follow === b || b.follow === o) continue;
      if (Math.abs(o.s - b.s) > (o.T.len + b.T.len) / 2 + 150) continue;
      const gap = (o.T.beam + b.T.beam) / 2 + 18;
      if (Math.abs(want - o.d) < gap) want = want < o.d ? o.d - gap : o.d + gap;
    }
    return want;
  }

  // Ships at sea, only ever in the harbour: at anchor in President Roads, big
  // ones in to their terminals or out to sea (a tug with each), harbor ferries
  // and fishing boats (in port while the harbour's frozen).
  _ships(fh, nearH, lvl, cam) {
    const H = this.harbor, d = this.density, frozen = lvl > 0.45;
    const want = {}, hold = this.shipsHold;
    for (const k in SHIPS) want[k] = nearH && !(frozen && (k === 'ferryboat' || k === 'trawler')) && hold !== 'all' && !(hold === 'traffic' && k !== 'anchored') ? SHIPS[k][d] : 0;
    const kind = (b) => (b.role === 'anchored' ? 'anchored' : b.T.big ? 'big' : b.type);
    const ships = this.list.filter((b) => b.T.ship);
    for (const b of ships) {
      const k = kind(b), n = this.list.filter((x) => x.T.ship && kind(x) === k).length;
      const done = b.arrived > 90 || !nearH || Math.abs(b.s - fh.s) > 4800;
      if ((done || n > want[k]) && !this._visible(b.x, b.z, cam, 4500)) this.remove(b);
    }
    const live = this.list.filter((b) => b.T.ship), n = (k) => live.filter((b) => kind(b) === k).length;
    const pick = (a) => a[Math.floor(this.rng() * a.length)];
    const clearOf = (x, z, r) => live.every((o) => Math.hypot(o.x - x, o.z - z) > r + o.T.len / 2) && (!this.avoid || this.avoid.every((a) => Math.hypot(a.x - x, a.z - z) > a.r + r + 150));
    const lo = Math.max(60, fh.s - 3200), hi = Math.min(H.length - 80, fh.s + 3200);
    if (n('anchored') < want.anchored) {
      for (const [s0, d0] of ANCHORAGE) {
        const type = pick(['container', 'tanker']), T = AI_TYPES[type], p = H.at(s0, d0, {}), h = H.heading(s0, 1) + 0.5;
        if (!clearOf(p.x, p.z, T.len / 2 + 60) || this._visible(p.x, p.z, cam, 4500) || !this._waterFor(p.x, p.z, h, T)) continue;
        const b = this.add(type, { path: H, role: 'anchored', s: s0, d: d0, dir: 1, vt: 0, hull: pick(SHIP_LIVERY[type]) });
        b.x = p.x; b.z = p.z; b.heading = b.h0 = h; b.level = this.g.map.terrain.h(p.x, p.z); b.y = b.level;
        break;
      }
    } else if (n('big') < want.big) {
      const type = pick(['cruise', 'container', 'tanker']), T = AI_TYPES[type];
      const berth = { cruise: 2650, container: 2950, tanker: 160 }[type], dir = this.rng() < 0.5 ? -1 : 1;
      const s = hi > berth + 300 ? this._spawnS(cam, Math.max(lo, berth + 300), hi, H, 4500, true) : null, p = s !== null ? H.at(s, dir * 45, {}) : null;
      if (p && clearOf(p.x, p.z, T.len / 2 + 120)) {
        const b = this.add(type, { path: H, role: 'ship', s, d: dir * 45, dir, vt: T.speed, sMin: berth, sMax: H.length - 80, hull: pick(SHIP_LIVERY[type]) });
        b.shipLane = 45; b.v = b.vt;
      }
    } else if (n('tug') < want.tug) {
      // With a big ship that hasn't one, or about the harbour on her own.
      const big = live.find((o) => o.T.big && o.role === 'ship' && !o.arrived && !live.some((t) => t.follow === o)), T = AI_TYPES.tug;
      if (big) {
        const side = this.rng() < 0.5 ? -1 : 1, s = big.s + big.dir * big.T.len * 0.3, dd = big.d + side * (big.T.beam / 2 + T.beam / 2 + 9), p = H.at(s, dd, {});
        if (!this._visible(p.x, p.z, cam, 4500)) {
          const b = this.add('tug', { path: H, role: 'ship', s, d: dd, dir: big.dir, vt: T.speed, follow: big, sMin: 300, sMax: 5200, hull: pick(SHIP_LIVERY.tug) });
          b.side = side; b.v = big.v; b.shipLane = 80;
        }
      } else {
        const s = Math.min(hi, 5200) > Math.max(lo, 300) ? this._spawnS(cam, Math.max(lo, 300), Math.min(hi, 5200), H, 4500, true) : null, dir = this.rng() < 0.5 ? -1 : 1, p = s !== null ? H.at(s, dir * 80, {}) : null;
        if (p && clearOf(p.x, p.z, 60)) { const b = this.add('tug', { path: H, role: 'ship', s, d: dir * 80, dir, vt: T.speed, sMin: 300, sMax: 5200, hull: pick(SHIP_LIVERY.tug) }); b.shipLane = 80; b.v = b.vt; }
      }
    } else if (n('ferryboat') < want.ferryboat) {
      const T = AI_TYPES.ferryboat, s = this._spawnS(cam, Math.max(lo, 150), hi, H, 4500, true), dir = this.rng() < 0.5 ? -1 : 1, p = s !== null ? H.at(s, dir * 70, {}) : null;
      if (p && clearOf(p.x, p.z, 60)) { const b = this.add('ferryboat', { path: H, role: 'ship', s, d: dir * 70, dir, vt: T.speed, sMin: 150, sMax: H.length - 80, hull: pick(SHIP_LIVERY.ferryboat) }); b.shipLane = 70; b.v = b.vt; }
    } else if (n('trawler') < want.trawler) {
      const T = AI_TYPES.trawler, s = Math.min(hi, 7400) > Math.max(lo, 1500) ? this._spawnS(cam, Math.max(lo, 1500), Math.min(hi, 7400), H, 4500, true) : null, dir = this.rng() < 0.5 ? -1 : 1, lane = 120 + this.rng() * 200, p = s !== null ? H.at(s, dir * lane, {}) : null;
      if (p && clearOf(p.x, p.z, 60) && this._waterFor(p.x, p.z, H.heading(s, dir), T)) { const b = this.add('trawler', { path: H, role: 'ship', s, d: dir * lane, dir, vt: T.speed, sMin: 1500, sMax: 7400, hull: pick(SHIP_LIVERY.trawler) }); b.shipLane = lane; b.v = b.vt; }
    }
  }

  // Open water all round a hull of type T at (x, z) heading h.
  _waterFor(x, z, h, T) {
    const cw = this.g.collision, fx = Math.sin(h), fz = -Math.cos(h), rx = -fz, rz = fx;
    for (const u of [-0.5, -0.25, 0, 0.25, 0.5]) for (const v of [-0.6, 0, 0.6]) {
      if (!cw.isWaterSurface(x + fx * u * (T.len + 30) + rx * v * (T.beam + 20), z + fz * u * (T.len + 30) + rz * v * (T.beam + 20))) return false;
    }
    return true;
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
    // The harbour: icebreakers work its main channel once the sea freezes.
    const H = this.harbor, fh = H ? H.project(focus.x, focus.z, null, this._fh) : null;
    const nearH = !!fh && fh.dist < 2200;
    const wantH = nearH && lvl > 0.45 ? HARBOR_BREAKERS[d] : 0;
    // Cull: too many, too far, or frozen in (out of sight).
    for (const b of this.list.slice()) {
      if (b.role === 'race' || b.role === 'rescue' || b.T.ship) continue;   // (ships: _ships)
      const rr = this.raceRange, sea = b.P === H;
      const far = sea ? Math.abs(b.s - fh.s) > 2600 || !nearH : Math.abs(b.s - f.s) > 1700 || !near || (rr && b.role === 'icebreaker' && b.sMax > rr[0] && b.sMin < rr[1]);
      const count = this.list.filter((x) => x.role === b.role && (x.P === H) === sea).length;
      if ((far || count > (sea ? wantH : want[b.role]) || (b.role !== 'icebreaker' && lvl > 0.2)) && !this._visible(b.x, b.z, cam)) this.remove(b);
    }
    const count = (role) => this.list.filter((x) => x.role === role && x.P !== H).length;
    if (H && fh) this._ships(fh, nearH, lvl, cam);
    if (H && this.list.filter((x) => x.role === 'icebreaker' && x.P === H).length < wantH) {
      const info = this.infoFor(H), zs = info.zones;
      if (zs.length) {
        const z = zs[Math.floor(this.rng() * zs.length)];
        const s = this._spawnS(cam, Math.max(z[0], fh.s - 1800), Math.min(z[1], fh.s + 1800), H), p = H.at(s, 0, this._p);
        // (Not on top of a rescue: try again next frame.)
        if (!this.avoid || this.avoid.every((a) => Math.hypot(a.x - p.x, a.z - p.z) > a.r + 220)) {
          const b = this.add('icebreaker', { path: H, role: 'icebreaker', s, dir: this.rng() < 0.5 ? 1 : -1, vt: AI_TYPES.icebreaker.speed, sMin: z[0], sMax: z[1], club: { jersey: 0x1d2c4a } });
          b.zone = zs.indexOf(z);
          b.v = b.vt;
        }
      }
    }
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
      const used = new Set(this.list.filter((x) => x.role === 'icebreaker' && x.P === P).map((x) => x.zone));
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
      b.model.root.visible = b.visible || Math.hypot(b.x - cam.position.x, b.z - cam.position.z) < (b.T.ship ? 5000 : 1200);
      b.step(dt);
      b.pose(dt);
      this._wake(b, dt);
      if (b.type === 'icebreaker' || b.T.ship) this._breakIce(b, dt, cam);
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
    const step = T.row ? 1.1 : b.type === 'icebreaker' ? 2.5 : T.ship ? Math.max(2.5, T.beam * 0.15) : Math.max(1.2, sp * 0.06);
    while (b.wakeAcc >= step) {
      b.wakeAcc -= step;
      this.emitWake(b, sp);
    }
  }

  emitWake(b, sp) {
    const T = b.T, fx = b.fx, fz = b.fz, rx = -fz, rz = fx, back = T.len * 0.5;
    const x = b.x - fx * back, z = b.z - fz * back, y = b.level ?? b.y;
    if (T.ship) {
      // A broad wash astern, the arms spreading, and a bow wave.
      const k = clamp(sp / 8, 0, 1), w = T.beam;
      this.wakes.emit(x, y, z, b.heading, w * 0.18, 0.26 + k * 0.1, 14, 0, 0, 2.5);
      for (const sd of [-1, 1]) this.wakes.emit(x + rx * sd * w * 0.42, y, z + rz * sd * w * 0.42, b.heading + sd * 0.3, w * 0.07, 0.22, 12, rx * sd * sp * 0.15, rz * sd * sp * 0.15, 3);
      if (sp > 1.5) for (const sd of [-1, 1]) this.wakes.emit(b.x + fx * T.len * 0.45 + rx * sd * w * 0.3, y, b.z + fz * T.len * 0.45 + rz * sd * w * 0.3, b.heading + sd * 0.6, w * 0.06, 0.25 * k, 6, rx * sd * 1.2, rz * sd * 1.2, 2.5);
    } else if (b.type === 'icebreaker') {
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
      if (b.model?.rig && b.model.rig.pins.length && b.rate > 6 && Math.random() < 0.22) {
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
    if (b.speed < 0.3) { b.breaking = Math.max(0, (b.breaking || 0) - dt * 3); return; }   // stopped: nothing to break
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

  // The nearest bank to (x, z) straight across the water, with a road near
  // it to step ashore onto: { x, z (the landing, just off it), ux, uz (the
  // way in), D (how far) } or null. The map's edge isn't a bank.
  shoreFrom(x, z, maxR = 1300) {
    const g = this.g, cw = g.collision, play = g.map.meta.play, T = g.map.terrain;
    let best = null;
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2, ux = Math.sin(a), uz = -Math.cos(a);
      for (let r = 5; r <= maxR && (!best || r < best.D + 5); r += 4) {
        const px = x + ux * r, pz = z + uz * r;
        if (px < play.minX || px > play.maxX || pz < play.minZ || pz > play.maxZ) break;
        if (cw.isWaterSurface(px, pz)) continue;
        if (g.graph.nearestRoad3D(px, pz, T.h(px, pz), 80)) best = { ux, uz, D: Math.max(0, r - 6) };
        break;
      }
    }
    if (best) { best.x = x + best.ux * best.D; best.z = z + best.uz * best.D; }
    return best;
  }

  // A boat frozen in radios for help: the nearest icebreaker working that
  // reach (or a fresh one from along it) comes to break it out and lead it
  // to the bank. Returns { ok, boat } or { ok: false, why }.
  callHelp(body) {
    const ice = this.g.ice;
    if (!ice || ice.level < 0.3) return { ok: false, why: 'no ice' };
    const P = this.pathFor(body.x, body.z);
    if (!P) return { ok: false, why: 'far' };
    const pr = P.project(body.x, body.z, null, {}), q = P.at(pr.s, 0, {});
    if (pr.dist > Math.max(q.right, q.left) + 80) return { ok: false, why: 'far' };
    const zones = this.infoFor(P).zones, zi = zones.findIndex((z) => pr.s >= z[0] - 40 && pr.s <= z[1] + 40);
    if (zi < 0) return { ok: false, why: 'reach' };
    const z = zones[zi];
    let b = this.list.find((x) => x.role === 'rescue' && x.P === P);
    if (!b) b = this.list.filter((x) => x.role === 'icebreaker' && x.P === P && x.zone === zi && Math.abs(x.s - pr.s) < 700).sort((a, c) => Math.abs(a.s - pr.s) - Math.abs(c.s - pr.s))[0];
    if (!b) {
      const up = pr.s - z[0], down = z[1] - pr.s;
      const s = clamp(pr.s + (down >= up ? 1 : -1) * Math.min(380, Math.max(up, down) - 20), z[0], z[1]);
      b = this.add('icebreaker', { path: P, role: 'icebreaker', s, d: pr.d * 0.5, dir: s < pr.s ? 1 : -1, vt: 7, sMin: z[0], sMax: z[1], club: { jersey: 0x1d2c4a } });
      b.zone = zi; b.v = 4;
    }
    if (b.role !== 'rescue') { b.role = 'rescue'; b.help = { phase: 'approach', t: 0 }; b.turn = null; }
    return { ok: true, boat: b };
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
        const heavy = b.type === 'icebreaker' || b.T.ship ? 1 : 0.5;
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
      if (b.type !== 'icebreaker' && !b.T.ship) continue;
      const dx = car.x - b.x, dz = car.z - b.z, reach = b.T.len / 2 + 10;
      if (dx * dx + dz * dz > reach * reach || Math.abs(car.y - b.y) > 4) continue;
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
    return this.list.map((b) => [b.x, b.z, b.type === 'icebreaker' ? '#ff6b4a' : b.T.ship ? '#c9d3e0' : b.role === 'race' ? '#ffd447' : '#e8f4ff']);
  }

  setNight(on) { setBoatNightLights(on); }

  clearAll() { for (const b of this.list.slice()) this.remove(b); }
}

// Two hulls (anything with x, z, heading, vx, vz and T.len / T.beam) pushed
// apart, sharing the push by mass and bouncing the closing speed. Returns
// the impact speed (0 if they don't touch).
export function bumpHulls(a, b, ma = 1, mb = 1) {
  const dx = b.x - a.x, dz = b.z - a.z, reach = (a.T.len + b.T.len) / 2 + 2;
  if (dx * dx + dz * dz > reach * reach) return 0;
  const afx = Math.sin(a.heading), afz = -Math.cos(a.heading), bfx = Math.sin(b.heading), bfz = -Math.cos(b.heading);
  const la = a.T.len * 0.47, lb = b.T.len * 0.47;
  const c = closestSegSeg(a.x - afx * la, a.z - afz * la, a.x + afx * la, a.z + afz * la, b.x - bfx * lb, b.z - bfz * lb, b.x + bfx * lb, b.z + bfz * lb);
  const r = (a.T.beam + b.T.beam) / 2 + 0.2;
  if (c.d >= r) return 0;
  let nx = c.bx - c.ax, nz = c.bz - c.az;
  const l = Math.hypot(nx, nz);
  if (l < 1e-4) { nx = dx; nz = dz; }
  const nl = Math.hypot(nx, nz) || 1;
  nx /= nl; nz /= nl;
  const depth = r - c.d, wa = mb / (ma + mb), wb = ma / (ma + mb);
  a.x -= nx * depth * wa; a.z -= nz * depth * wa;
  b.x += nx * depth * wb; b.z += nz * depth * wb;
  const vn = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (vn >= 0) return 0;
  const j = -1.3 * vn;
  a.vx -= nx * j * wa; a.vz -= nz * j * wa;
  b.vx += nx * j * wb; b.vz += nz * j * wb;
  return -vn;
}

export function closestSegSeg(ax, az, bx, bz, cx, cz, dx, dz) {
  const ux = bx - ax, uz = bz - az, vx = dx - cx, vz = dz - cz, wx = ax - cx, wz = az - cz;
  const a = ux * ux + uz * uz, b = ux * vx + uz * vz, c = vx * vx + vz * vz, d = ux * wx + uz * wz, e = vx * wx + vz * wz;
  const D = a * c - b * b;
  let s = D > 1e-6 ? clamp((b * e - c * d) / D, 0, 1) : 0;
  let t = c > 1e-6 ? clamp((b * s + e) / c, 0, 1) : 0;
  s = a > 1e-6 ? clamp((b * t - d) / a, 0, 1) : 0;
  const px = ax + ux * s, pz = az + uz * s, qx = cx + vx * t, qz = cz + vz * t;
  return { d: Math.hypot(px - qx, pz - qz), ax: px, az: pz, bx: qx, bz: qz };
}
