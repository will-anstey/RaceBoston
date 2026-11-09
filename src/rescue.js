// Harbor Rescue: a cold snap has frozen Boston Harbor and boats have capsized
// in the ice. Take the rescue icebreaker out, break your way to each one
// before the clock runs out and get everyone off. Bring her alongside an
// upturned hull and the people sitting on it climb across the plank; throw a
// life ring to anyone in the water (hold Space, let go at the right power)
// and they're reeled in and hoisted aboard.

import * as THREE from 'three';
import { BREAKER, buildWreck, placeBoat, disposeBoat, closestSegSeg } from './boats.js';
import { Crowd, makeBeam, makeLabel, drawLabel, makeGangway, PANTS, HATS, SKIN } from './ferry.js';
import { clamp, damp, formatTime, formatDistance, loadJSON, saveJSON, mulberry32, wrapAngle } from './util.js';

// Each call: where you start (s along the harbour channel), the time you
// have, and the boats in trouble: s and offset d (m, + toward the right bank
// facing out to sea) from the channel line, the hull, and how many are on it
// and in the water.
export const RESCUES = [
  {
    id: 'inner', name: 'Inner Harbor', blurb: 'A launch upturned in the ice off the North End', time: 165, start: 60,
    sites: [{ s: 760, d: 200, boat: 'motor', scale: 1.25, hull: 2, water: 1, place: 'in the Inner Harbor' }],
  },
  {
    id: 'seaport', name: 'Off the Seaport', blurb: 'Two boats over between the Seaport and Logan', time: 360, start: 60,
    sites: [
      { s: 1650, d: 260, boat: 'motor', scale: 1.5, hull: 1, water: 2, place: 'off the Seaport' },
      { s: 2100, d: -150, boat: 'dinghy', scale: 1.15, hull: 2, water: 1, place: 'off Logan' },
    ],
  },
  {
    id: 'roads', name: 'President Roads', blurb: 'Three wrecks strung out past Castle Island', time: 480, start: 3400,
    sites: [
      { s: 4100, d: 330, boat: 'motor', scale: 1.3, hull: 2, water: 1, place: 'off Castle Island' },
      { s: 5150, d: -320, boat: 'dinghy', scale: 1.15, hull: 1, water: 2, place: 'in President Roads' },
      { s: 5700, d: 420, boat: 'motor', scale: 1.7, hull: 3, water: 1, place: 'in the outer harbor' },
    ],
  },
];

const RANGE = 40;          // m: the longest throw
const GRAB = 2.5;          // m: lands this close and they have it
const REACH = 6;           // m: this close and they swim for it
const SWEEP = 1.4;         // s for the power meter to fill (then it falls back)
const REEL = 2.4;          // m/s reeling someone in
const HOIST = 1.7;         // s up the side onto the deck
const WALK = 1.5;          // m/s across the plank and the deck
const PLANK = 5.5;         // m: the furthest the plank reaches past the wreck's side
const SLIP = 3;            // m/s: any faster with someone on the line and they lose it
const VEST = [0xff6a1a, 0xf2c12e, 0xff4d2e];   // life jackets
const RAIL = [-9.5, -3.0];  // the foredeck's rails (ship-local z), where the rescue happens

// A life ring (red and white quarters) and its line, hidden, added to root.
export function makeLifeRing(root) {
  const g = new THREE.TorusGeometry(0.34, 0.085, 8, 24), n = g.attributes.position.count, col = new Float32Array(n * 3);
  const red = new THREE.Color(0xe8401c), white = new THREE.Color(0xf4f4f0), P = g.attributes.position;
  for (let k = 0; k < n; k++) {
    const c = Math.floor(((Math.atan2(P.getY(k), P.getX(k)) + Math.PI) / (Math.PI / 2)) + 0.5) % 2 ? red : white;
    col[3 * k] = c.r; col[3 * k + 1] = c.g; col[3 * k + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.visible = false;
  const N = 24, lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xf2efe6 }));
  line.frustumCulled = false;
  line.visible = false;
  root.add(mesh, line);
  return { mesh, line, N };
}

// A line from a to b with a sag in the middle, into a ring's line geometry.
export function hangLine(R, ax, ay, az, bx, by, bz, sag, floor = -Infinity) {
  const pos = R.line.geometry.attributes.position;
  for (let k = 0; k < R.N; k++) {
    const u = k / (R.N - 1);
    pos.setXYZ(k, ax + (bx - ax) * u, Math.max(floor, ay + (by - ay) * u - Math.sin(Math.PI * u) * sag), az + (bz - az) * u);
  }
  pos.needsUpdate = true;
  R.line.visible = true;
}

export class HarborRescue {
  constructor(bm, def) {
    this.bm = bm;
    this.g = bm.g;
    this.def = def;
    const B = this.g.boats;
    this.P = B.harbor;
    this.rng = mulberry32((Date.now() & 0xffffff) ^ 0x68e31da4);
    this.ok = false;
    if (!this.P) return;
    this.root = new THREE.Group();
    this.g.scene.add(this.root);
    this.crowd = new Crowd(this.root, 40);
    this.time = 0; this.clock = def.time; this.over = false; this.won = false;
    this.people = []; this.sites = []; this.saved = 0;
    this.slots = BREAKER.slots.map(() => null);
    for (const sd of def.sites) { const s = this._placeSite(sd); if (s) this.sites.push(s); }
    this.total = this.people.length;
    this.ok = this.sites.length === def.sites.length;
    this.best = loadJSON('rb.rescueBest', {});
    this.ring = this._makeRing();
    this.gangway = makeGangway();
    this.root.add(this.gangway);
    this.plank = null; this.charge = null; this.wasHold = false; this.near = null; this.tgt = null;
    this.plankT = 0; this.keepT = 0; this.careT = 0; this.slipT = 0;
    // The ship can't sail through a wreck; the icebreakers on patrol keep clear of them.
    bm.env.obstacles = this.sites.map((s) => s.obstacle);
    B.avoid = this.sites.map((s) => ({ x: s.x, z: s.z, r: 70 }));
    this._v = new THREE.Vector3();
  }

  get holding() { return !!this.plank; }

  // ------------------------------------------------------------ setting up
  // A wreck in open water off the channel, its people on the hull and in the ice round it.
  _placeSite(sd) {
    const P = this.P, cw = this.g.collision, ice = this.g.ice, T = this.g.map.terrain;
    const q = P.at(sd.s, 0, {});
    const reach = sd.d > 0 ? q.right : q.left;
    const d0 = Math.sign(sd.d) * Math.min(Math.abs(sd.d), Math.max(0, reach - 90));
    const clear = (x, z) => {
      if (!cw.isWaterSurface(x, z) || ice.waterAt(x, z) !== 'sea') return false;
      for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; for (const r of [15, 32]) if (!cw.isWaterSurface(x + Math.cos(a) * r, z + Math.sin(a) * r)) return false; }
      return true;
    };
    let at = null;
    for (const [ds, dd] of [[0, 0], [0, -30], [0, 30], [40, 0], [-40, 0], [0, -60], [0, 60], [80, 0], [-80, 0], [60, -60], [-60, 60], [0, -110], [0, 110], [140, 0], [-140, 0]]) {
      const p = P.at(sd.s + ds, d0 + dd, {});
      if (clear(p.x, p.z)) { at = p; break; }
    }
    if (!at) return null;
    const scale = sd.scale || 1, heading = this.rng() * Math.PI * 2;
    const model = buildWreck(sd.boat);
    model.root.scale.setScalar(scale);
    this.root.add(model.root);
    const level = T.h(at.x, at.z), Tb = model.T;
    const s = {
      def: sd, x: at.x, z: at.z, heading, model, level, scale,
      fx: Math.sin(heading), fz: -Math.cos(heading),
      len: Tb.len * scale, beam: Tb.beam * scale, rise: model.float * scale, list: (this.rng() < 0.5 ? -1 : 1) * (0.12 + this.rng() * 0.1),
      top: level + (model.float + model.depth) * scale, phase: this.rng() * 6,
      onHull: [], inWater: [], beam3: makeBeam(), label: makeLabel(), labelText: '',
    };
    s.obstacle = { cx: s.x, cz: s.z, ax: s.fx, az: s.fz, nx: -s.fz, nz: s.fx, hl: s.len / 2 + 0.4, hw: s.beam / 2 + 0.4 };
    s.beam3.position.set(s.x, level, s.z);
    s.beam3.material.uniforms.uColor.value.setHex(0xff5a3c);
    s.label.position.set(s.x, level + 9, s.z);
    this.root.add(s.beam3, s.label);
    // On the hull: along the keel, aft where it's broad.
    for (let k = 0; k < sd.hull; k++) {
      const p = this._person(s, 'hull');
      const u = s.len * (-0.3 + (sd.hull > 1 ? (0.38 * k) / (sd.hull - 1) : 0.15));
      p.x = s.x + s.fx * u; p.z = s.z + s.fz * u; p.y = s.top;
      p.u = u;
      p.h = wrapAngle(heading + (this.rng() < 0.5 ? 1 : -1) * Math.PI / 2 + (this.rng() - 0.5) * 0.8);
      s.onHull.push(p);
    }
    // In the water, each in a hole in the ice a little way off.
    for (let k = 0; k < sd.water; k++) {
      let x = s.x, z = s.z;
      for (let tries = 0; tries < 20; tries++) {
        const a = this.rng() * Math.PI * 2, r = 9 + this.rng() * 11;
        x = s.x + Math.sin(a) * r; z = s.z - Math.cos(a) * r;
        if (cw.isWaterSurface(x, z) && Math.abs((x - s.x) * -s.fz + (z - s.z) * s.fx) > s.beam / 2 + 2.5) break;
      }
      const p = this._person(s, 'water');
      p.x = x; p.z = z; p.y = level - 1.2;
      p.h = this.rng() * Math.PI * 2;
      // A thin column of light over each of them, to spot them by.
      p.beam = makeBeam();
      p.beam.scale.set(0.3, 0.45, 0.3);
      p.beam.material.uniforms.uColor.value.setHex(0xff8a3c);
      this.root.add(p.beam);
      s.inWater.push(p);
    }
    placeBoat(model, { x: s.x, y: level + s.rise, z: s.z, heading, pitch: 0, roll: Math.PI + s.list });
    return s;
  }

  _person(site, where) {
    const i = this.crowd.alloc(VEST[Math.floor(this.rng() * VEST.length)], PANTS[Math.floor(this.rng() * PANTS.length)], HATS[Math.floor(this.rng() * HATS.length)], SKIN[Math.floor(this.rng() * SKIN.length)], this.rng() < 0.6);
    const p = { i, site, where, x: 0, y: 0, z: 0, h: 0, phase: this.rng() * 6, scale: 0.92 + this.rng() * 0.16, path: null };
    this.people.push(p);
    return p;
  }

  _makeRing() {
    return { ...makeLifeRing(this.root), state: 'ready', x: 0, y: 0, z: 0, t: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), who: null };
  }

  startPose() {
    const p = this.P.at(this.def.start, 0, {});
    return { x: p.x, z: p.z, h: Math.atan2(p.tx, -p.tz) };
  }

  begin() {
    this._keepOpen();
    this.g.audio.shipHorn?.(1.2);
  }

  // Pools round the wrecks and the people in the water, kept from freezing over.
  _keepOpen() {
    const ice = this.g.ice;
    for (const s of this.sites) {
      if (!s.onHull.length && !s.inWater.length) continue;
      ice.breakAt(s.x, s.z, s.len / 2 + 4, 0);
      for (const p of s.inWater) ice.breakAt(p.x, p.z, 3.4, 0);
    }
  }

  // ------------------------------------------------------------ geometry
  _local(x, z) {
    const b = this.bm.body, c = Math.cos(b.heading), sn = Math.sin(b.heading), dx = x - b.x, dz = z - b.z;
    return [dx * c + dz * sn, -dx * sn + dz * c];
  }
  _world(lx, ly, lz, out = this._v) { return out.set(lx, ly, lz).applyMatrix4(this.bm.model.root.matrixWorld); }

  // The foredeck rail nearest a point: ship-local (x, z), the side, and the hand-height point in the world.
  _railFor(x, z) {
    const [lx, lz0] = this._local(x, z), sgn = lx >= 0 ? 1 : -1, lz = clamp(lz0, RAIL[0], RAIL[1]);
    const rx = sgn * (BREAKER.halfWidth(lz) - 0.12);
    return { lx: rx, lz, sgn, hand: this._world(rx, BREAKER.deckY(lz) + 1.15, lz, new THREE.Vector3()) };
  }

  // Alongside a wreck: the gap from the foredeck rail to its keel, where its people are.
  _alongside(s) {
    const b = this.bm.body, c = Math.cos(b.heading), sn = Math.sin(b.heading);
    const [wl] = this._local(s.x, s.z), sgn = wl >= 0 ? 1 : -1;
    const W = (lx, lz) => [b.x + lx * c - lz * sn, b.z + lx * sn + lz * c];
    const A0 = W(sgn * (BREAKER.halfWidth(RAIL[0]) - 0.1), RAIL[0]), A1 = W(sgn * (BREAKER.halfWidth(RAIL[1]) - 0.1), RAIL[1]);
    const k0 = s.len * -0.32, k1 = s.len * 0.1;
    const cc = closestSegSeg(A0[0], A0[1], A1[0], A1[1], s.x + s.fx * k0, s.z + s.fz * k0, s.x + s.fx * k1, s.z + s.fz * k1);
    return { s, sgn, gap: cc.d, kx: cc.bx, kz: cc.bz, rx: cc.ax, rz: cc.az, dist: Math.hypot(s.x - b.x, s.z - b.z) };
  }

  // ------------------------------------------------------------ per frame
  update(dt, inp) {
    this.time += dt;
    if (!this.over) {
      this.clock -= dt;
      if (this.clock <= 0) { this.clock = 0; this._end(false); }
    }
    this.keepT -= dt;
    if (this.keepT <= 0) { this.keepT = 12; this._keepOpen(); }
    if (!this.over) {
      if (this.plank) this._updatePlank(dt);
      else this._checkAlongside(dt);
      this._updateThrow(dt, inp);
    }
    this._mindSwimmers(dt);
    this._updateRing(dt);
    this._updatePeople(dt);
    this._updateSites();
  }

  // Close alongside a wreck with people on it, and slow: the plank goes across.
  _checkAlongside(dt) {
    const b = this.bm.body;
    let best = null;
    for (const s of this.sites) {
      if (!s.onHull.some((p) => p.where === 'hull')) continue;
      if (Math.hypot(s.x - b.x, s.z - b.z) > 90) continue;
      const a = this._alongside(s);
      if (!best || a.gap < best.gap) best = a;
    }
    this.near = best;
    const ok = best && best.gap < PLANK + best.s.beam / 2 && b.speed < 1.1;
    this.plankT = ok ? this.plankT + dt : 0;
    if (this.plankT > 0.4) this._startPlank(best);
  }

  _startPlank(a) {
    const s = a.s, [lx, lz] = this._local(a.rx, a.rz), z = clamp(lz, RAIL[0] + 0.3, RAIL[1] - 0.3), sgn = a.sgn;
    const queue = s.onHull.filter((p) => p.where === 'hull').sort((p, q) => Math.hypot(p.x - a.kx, p.z - a.kz) - Math.hypot(q.x - a.kx, q.z - a.kz));
    this.plank = { s, sgn, lz: z, kx: a.kx, kz: a.kz, ext: 0, stage: 'extend', queue, next: 0, crossing: 0 };
    this.charge = null;
    this.g.hud.message('Alongside', `${queue.length} climbing across`, 1400, '#bfe6ff');
    void lx;
  }

  // While the plank's across the ship is held still.
  holdShip(dt) {
    const b = this.bm.body;
    b.vx = b.vz = b.vF = b.vR = b.yawRate = 0;
    b.y = b.level + 0.03 * Math.sin(this.time * 0.8);
    b.pitch *= 0.95; b.roll *= 0.95;
  }

  // Plank ends: on the ship's rail (A, and a step inboard) and on the keel (B).
  _plankEnds() {
    const m = this.plank, hw = BREAKER.halfWidth(m.lz), y = BREAKER.deckY(m.lz);
    return {
      A: this._world(m.sgn * (hw - 0.05), y, m.lz, new THREE.Vector3()),
      Ain: this._world(m.sgn * (hw - 0.9), y, m.lz, new THREE.Vector3()),
      B: new THREE.Vector3(m.kx, m.s.top + 0.02, m.kz),
    };
  }

  _updatePlank(dt) {
    const m = this.plank;
    if (m.stage === 'extend') {
      m.ext = Math.min(1, m.ext + dt / 1.0);
      if (m.ext >= 1) { m.stage = 'cross'; m.t = 0; }
    } else if (m.stage === 'cross') {
      m.t -= dt;
      if (m.next < m.queue.length && m.t <= 0) {
        // The next one along the keel to the plank, up it and over the rail.
        const p = m.queue[m.next++], e = this._plankEnds();
        m.t = 1.3;
        m.crossing++;
        p.where = 'walk';
        this._walk(p, [new THREE.Vector3(p.x, p.y, p.z), e.B, e.A, e.Ain], WALK, () => { m.crossing--; this._onDeck(p, m.sgn * (BREAKER.halfWidth(m.lz) - 0.9), m.lz); });
      }
      if (m.next >= m.queue.length && m.crossing === 0) { m.stage = 'retract'; m.t = 0; }
    } else if (m.stage === 'retract') {
      m.ext = Math.max(0, m.ext - dt / 0.8);
      if (m.ext <= 0) {
        const left = m.s.onHull.filter((p) => p.where === 'hull').length + m.s.inWater.filter((p) => p.where !== 'deckwalk' && p.where !== 'aboard').length;
        this.plank = null;
        if (!this.over) this.g.hud.message('Off the hull', left ? `${left} still in the water` : 'On to the next', 1600, '#7ee081');
      }
    }
    this._poseGangway();
  }

  _poseGangway() {
    const g = this.gangway, m = this.plank;
    if (!m || m.ext <= 0.001) { g.visible = false; return; }
    const e = this._plankEnds(), E = e.A.clone().lerp(e.B, m.ext);
    g.visible = true;
    g.position.copy(e.A);
    g.lookAt(E);
    g.scale.set(1, 1, Math.max(0.05, e.A.distanceTo(E)));
  }

  // ------------------------------------------------------------ life ring
  // The nearest person in the water within a throw of the foredeck.
  _target() {
    let best = null;
    for (const p of this.people) {
      if (p.where !== 'water') continue;
      const r = this._railFor(p.x, p.z), d = Math.hypot(p.x - r.hand.x, p.z - r.hand.z);
      if (d <= RANGE && (!best || d < best.d)) best = { p, d, rail: r };
    }
    return best;
  }

  get power() {
    const t = this.charge ? this.charge.t : 0, u = (t / SWEEP) % 2;
    return u < 1 ? u : 2 - u;
  }

  // Space: hold to wind up, let go to throw; the power sets the distance.
  _updateThrow(dt, inp) {
    const hold = !!inp.handbrake, R = this.ring;
    this.tgt = R.state === 'ready' && !this.plank ? this._target() : null;
    if (this.charge) {
      this.charge.t += dt;
      if (!this.tgt) this.charge = null;
      else if (!hold) { this._throw(this.tgt, this.power); this.charge = null; }
    } else if (hold && !this.wasHold) {
      if (this.tgt) this.charge = { t: 0 };
      else if (R.state === 'ready' && !this.plank && this.people.some((p) => p.where === 'water')) this.g.hud.message('Too far to throw', `Get within ${RANGE} m of them`, 1200, '#bfe6ff');
    }
    this.wasHold = hold;
  }

  _throw(tgt, power) {
    const R = this.ring, from = tgt.rail.hand, b = this.bm.body;
    const dx = tgt.p.x - from.x, dz = tgt.p.z - from.z, d = Math.hypot(dx, dz) || 1;
    const range = Math.max(3, power * RANGE), side = (this.rng() - 0.5) * 1.2;
    const ux = dx / d, uz = dz / d;
    R.from.copy(from);
    R.to.set(from.x + ux * range - uz * side, tgt.p.site.level + 0.05, from.z + uz * range + ux * side);
    R.state = 'fly'; R.t = 0; R.dur = 0.55 + range / 26; R.apex = 1.5 + range * 0.12; R.who = null; R.lz = tgt.rail.lz; R.sgn = tgt.rail.sgn;
    R.mesh.visible = R.line.visible = true;
    this.g.audio.oarlock?.();
    void b;
  }

  _updateRing(dt) {
    const R = this.ring, b = this.bm.body;
    if (R.state === 'ready') { R.mesh.visible = R.line.visible = false; return; }
    // The line runs from the rail nearest the ring.
    const rail = this._railFor(R.x, R.z);
    const lvl = this.g.map.terrain.h(R.x, R.z) + 0.05;
    if (R.state === 'fly') {
      R.t += dt;
      const u = Math.min(1, R.t / R.dur);
      R.x = R.from.x + (R.to.x - R.from.x) * u; R.z = R.from.z + (R.to.z - R.from.z) * u;
      R.y = R.from.y + (R.to.y - R.from.y) * u + 4 * R.apex * u * (1 - u);
      R.mesh.rotation.set(R.t * 9, R.t * 4, 0);
      if (u >= 1) this._landed();
    } else if (R.state === 'float') {
      R.y = lvl + 0.03 * Math.sin(this.time * 2.3);
      R.mesh.rotation.set(Math.PI / 2, 0, 0);
      R.t += dt;
      if (R.who && R.who.where !== 'swim') R.who = null;
      if (!R.who && R.t > 0.6) R.state = 'back';
    } else if (R.state === 'back') {
      // A miss: hauled back across the water and the ice.
      const tx = rail.hand.x, tz = rail.hand.z, dx = tx - R.x, dz = tz - R.z, d = Math.hypot(dx, dz);
      const step = Math.min(d, 6.5 * dt);
      R.x += (dx / (d || 1)) * step; R.z += (dz / (d || 1)) * step;
      R.y = d < 5 ? rail.hand.y - 0.4 : lvl + 0.05;
      R.mesh.rotation.set(Math.PI / 2, 0, 0);
      if (d < 3.5) { R.state = 'ready'; }
    } else if (R.state === 'held') {
      const p = R.who;
      if (!p || (p.where !== 'line' && p.where !== 'hoist')) { R.state = p && p.where === 'water' ? 'back' : 'ready'; R.who = null; }
      else { R.x = p.x + Math.sin(p.h) * 0.35; R.z = p.z - Math.cos(p.h) * 0.35; R.y = p.where === 'hoist' ? p.y + 1.0 : lvl + 0.08; R.mesh.rotation.set(Math.PI / 2, 0, 0); }
    }
    R.mesh.visible = R.state !== 'ready';
    R.mesh.position.set(R.x, R.y, R.z);
    // The line: a sag while it's slack, taut while someone's on it.
    const pos = R.line.geometry.attributes.position, h = rail.hand, taut = R.state === 'held' ? 0.1 : R.state === 'fly' ? 0.25 : 0.6;
    const len = Math.hypot(R.x - h.x, R.z - h.z);
    for (let k = 0; k < R.N; k++) {
      const u = k / (R.N - 1);
      let y = h.y + (R.y - h.y) * u - Math.sin(Math.PI * u) * taut * Math.min(3, 0.3 + len * 0.05);
      if (R.state !== 'fly') y = Math.max(y, lvl + 0.02);
      pos.setXYZ(k, h.x + (R.x - h.x) * u, y, h.z + (R.z - h.z) * u);
    }
    pos.needsUpdate = true;
    R.line.visible = true;
    void b;
  }

  _landed() {
    const R = this.ring, g = this.g;
    R.state = 'float'; R.t = 0;
    g.boats.wakes.emit(R.x, R.to.y, R.z, 0, 0.9, 0.5, 3.5, 0, 0, 1.2);
    g.audio.oar?.(0.7);
    let best = null;
    for (const p of this.people) {
      if (p.where !== 'water') continue;
      const d = Math.hypot(p.x - R.x, p.z - R.z);
      if (d < REACH && (!best || d < best.d)) best = { p, d };
    }
    if (best && best.d < GRAB) this._grab(best.p);
    else if (best) {
      best.p.where = 'swim'; R.who = best.p;
      g.hud.message('Close!', 'They\'re swimming for it', 1100, '#ffd447');
    } else g.hud.message('Missed!', 'Reeling the ring back in', 1100, '#ff6b6b');
  }

  _grab(p) {
    const R = this.ring;
    p.where = 'line';
    R.state = 'held'; R.who = p;
    this.slipT = 0;
    this.g.audio.checkpoint();
    this.g.hud.message('Got it!', 'Reeling them in: hold her steady', 1400, '#7ee081');
  }

  // Anyone on the line is pulled in to the hull and hoisted aboard; too fast and they lose it.
  _reel(p, dt) {
    const b = this.bm.body, rail = this._railFor(p.x, p.z);
    if (b.speed > SLIP) {
      this.slipT += dt;
      if (this.slipT > 0.9) {
        p.where = 'water'; this.slipT = 0;
        this.g.ice.breakAt(p.x, p.z, 3.4, 0);
        this.g.hud.message('Too fast!', 'They lost the ring', 1400, '#ff6b6b');
        return;
      }
    } else this.slipT = 0;
    // To the water under the rail, just off the hull.
    const out = this._world(rail.sgn * (BREAKER.halfWidth(rail.lz) + 0.7), 0, rail.lz, new THREE.Vector3());
    const dx = out.x - p.x, dz = out.z - p.z, d = Math.hypot(dx, dz);
    const step = Math.min(d, REEL * dt);
    p.x += (dx / (d || 1)) * step; p.z += (dz / (d || 1)) * step;
    p.h = Math.atan2(dx, -dz);
    this.g.ice.breakAt(p.x, p.z, 1.8, 0);
    if (d < 0.6) {
      p.where = 'hoist'; p.t = 0; p.lz = rail.lz; p.sgn = rail.sgn;
      this.g.hud.message('Hoisting aboard', '', 900, '#bfe6ff');
    }
  }

  // Up on deck: walk to a place on the foredeck. Rescued!
  _onDeck(p, lx, lz) {
    let k = this.slots.findIndex((x) => x === null);
    if (k < 0) k = 0;
    this.slots[k] = p;
    const s = BREAKER.slots[k];
    p.where = 'deckwalk';
    p.dw = { x0: lx, z0: lz, x1: s[0], z1: s[1], t: 0, len: Math.hypot(s[0] - lx, s[1] - lz) || 0.1, slot: k };
    this.saved++;
    const site = p.site, i = site.onHull.indexOf(p), j = site.inWater.indexOf(p);
    if (i >= 0) site.onHull.splice(i, 1);
    if (j >= 0) site.inWater.splice(j, 1);
    this.g.audio.discover?.();
    if (this.saved >= this.total) this._end(true);
    else this.g.hud.toast(`Rescued ${this.saved} of ${this.total}`, 'Harbor Rescue', 1800);
  }

  _walk(p, pts, speed, done) { p.path = pts.map((v) => v.clone()); p.seg = 0; p.u = 0; p.speed = speed; p.done = done; }

  // Keep the hull off anyone in the water (and tell the skipper).
  _mindSwimmers(dt) {
    const b = this.bm.body, L = b.T.len * 0.48, hw = b.T.beam / 2 + 1.2;
    this.careT = Math.max(0, this.careT - dt);
    for (const p of this.people) {
      if (p.where !== 'water' && p.where !== 'swim') continue;   // (on the line they're pulled in to the hull)
      const ax = b.x - b.fx * L, az = b.z - b.fz * L, ux = b.fx * 2 * L, uz = b.fz * 2 * L;
      const t = clamp(((p.x - ax) * ux + (p.z - az) * uz) / (ux * ux + uz * uz), 0, 1);
      const cx = ax + ux * t, cz = az + uz * t, d = Math.hypot(p.x - cx, p.z - cz);
      if (d >= hw) continue;
      const nx = (p.x - cx) / (d || 1), nz = (p.z - cz) / (d || 1);
      p.x = cx + nx * hw; p.z = cz + nz * hw;
      if (this.careT <= 0 && b.speed > 1) { this.careT = 4; this.g.hud.message('Careful!', 'People in the water', 1200, '#ff6b6b'); }
    }
  }

  _updatePeople(dt) {
    const v = this._v, b = this.bm.body, t = this.time;
    for (const p of this.people) {
      let swing = 0, bob = 0, arms = null, moving = false;
      const lvl = p.site.level;
      if (p.where === 'hull') {
        const s = p.site;
        p.x = s.x + s.fx * p.u; p.z = s.z + s.fz * p.u; p.y = s.top + 0.01 * Math.sin(t * 1.1 + s.phase);
        // Waving at the ship as she comes up.
        const near = Math.hypot(b.x - p.x, b.z - p.z) < 260;
        if (near) p.h = wrapAngle(p.h + wrapAngle(Math.atan2(b.x - p.x, -(b.z - p.z)) - p.h) * damp(1.5, dt));
        arms = [-0.15, near ? Math.PI - 0.35 + 0.45 * Math.sin(t * 6 + p.phase) : 0.15];
      } else if (p.where === 'water' || p.where === 'swim') {
        p.y = lvl - 1.2 + 0.05 * Math.sin(t * 1.7 + p.phase);
        if (p.where === 'swim') {
          const R = this.ring, dx = R.x - p.x, dz = R.z - p.z, d = Math.hypot(dx, dz);
          p.x += (dx / (d || 1)) * Math.min(d, 0.9 * dt); p.z += (dz / (d || 1)) * Math.min(d, 0.9 * dt);
          p.h = Math.atan2(dx, -dz);
          this.g.ice.breakAt(p.x, p.z, 1.6, 0);
          arms = [Math.PI / 2 + 0.7 * Math.sin(t * 3 + p.phase), Math.PI / 2 - 0.7 * Math.sin(t * 3 + p.phase)];
          if (d < 0.7) this._grab(p);
        } else {
          p.h = wrapAngle(p.h + wrapAngle(Math.atan2(b.x - p.x, -(b.z - p.z)) - p.h) * damp(0.8, dt));
          const w = 0.4 * Math.sin(t * 5 + p.phase);
          arms = [Math.PI - 0.35 + w, Math.PI - 0.35 - w];
        }
      } else if (p.where === 'line') {
        this._reel(p, dt);
        p.y = lvl - 1.15 + 0.03 * Math.sin(t * 2 + p.phase);
        arms = [Math.PI / 2, Math.PI / 2];
      } else if (p.where === 'hoist') {
        // Up the side: from the water just off the hull to over the rail.
        p.t += dt;
        const u = Math.min(1, p.t / HOIST), e = u * u * (3 - 2 * u), hw = BREAKER.halfWidth(p.lz), deck = BREAKER.deckY(p.lz);
        const lx = p.sgn * (hw + 0.7 - (u > 0.75 ? ((u - 0.75) / 0.25) * 1.6 : 0)), ly = -1.15 + (deck + 1.15) * e;
        this._world(lx, ly, p.lz);
        p.x = v.x; p.y = v.y; p.z = v.z;
        p.h = wrapAngle(b.heading - p.sgn * Math.PI / 2);
        arms = [Math.PI - 0.2, Math.PI - 0.2];
        if (u >= 1) this._onDeck(p, p.sgn * (hw - 0.9), p.lz);
      } else if (p.where === 'walk' && p.path) {
        let left = p.speed * dt;
        while (left > 0 && p.path) {
          const a = p.path[p.seg], c = p.path[p.seg + 1], len = Math.hypot(c.x - a.x, c.z - a.z) || 1e-3;
          if (p.u + left < len) { p.u += left; left = 0; }
          else { left -= len - p.u; p.u = 0; p.seg++; if (p.seg >= p.path.length - 1) { const done = p.done; p.path = null; done?.(); } }
        }
        if (p.path) {
          const a = p.path[p.seg], c = p.path[p.seg + 1], len = Math.hypot(c.x - a.x, c.z - a.z) || 1e-3, u = p.u / len;
          p.x = a.x + (c.x - a.x) * u; p.y = a.y + (c.y - a.y) * u; p.z = a.z + (c.z - a.z) * u;
          p.h = wrapAngle(p.h + wrapAngle(Math.atan2(c.x - a.x, -(c.z - a.z)) - p.h) * damp(8, dt));
          moving = true;
        }
      } else if (p.where === 'deckwalk') {
        const w = p.dw;
        w.t = Math.min(1, w.t + (WALK * dt) / w.len);
        const lx = w.x0 + (w.x1 - w.x0) * w.t, lz = w.z0 + (w.z1 - w.z0) * w.t;
        this._world(lx, BREAKER.deckY(lz), lz);
        p.x = v.x; p.y = v.y; p.z = v.z;
        p.h = wrapAngle(b.heading + Math.atan2(w.x1 - w.x0, -(w.z1 - w.z0)));
        moving = true;
        if (w.t >= 1) { p.where = 'aboard'; p.lh = (this.rng() - 0.5) * 1.4; }
      } else if (p.where === 'aboard') {
        const s = BREAKER.slots[p.dw.slot];
        this._world(s[0], BREAKER.deckY(s[1]), s[1]);
        p.x = v.x; p.y = v.y; p.z = v.z;
        p.h = b.heading + p.lh;
        bob = 0.006 * Math.sin(t * 1.3 + p.i);
      }
      if (moving) { p.phase += dt * WALK * 5.2; swing = Math.sin(p.phase) * 0.55; bob = Math.abs(Math.cos(p.phase)) * 0.04; }
      if (p.beam) {
        p.beam.visible = !this.over && (p.where === 'water' || p.where === 'swim') && Math.hypot(p.x - b.x, p.z - b.z) > 16;
        p.beam.position.set(p.x, lvl, p.z);
        p.beam.material.uniforms.uTime.value = t;
      }
      this.crowd.pose(p.i, p.x, p.y, p.z, p.h, swing, bob, p.scale, arms);
    }
    this.crowd.flush();
  }

  // Beams and labels over the wrecks with people still to get off; the wrecks bob in their pools.
  _updateSites() {
    const cam = this.g.camera.position;
    for (const s of this.sites) {
      const hull = s.onHull.filter((p) => p.where === 'hull').length, water = s.inWater.length;
      const active = !this.over && hull + water > 0;
      s.beam3.visible = active && Math.hypot(s.x - this.bm.body.x, s.z - this.bm.body.z) > 70;   // (close to, it'd only tint the view)
      s.beam3.material.uniforms.uTime.value = this.time;
      const lines = [];
      if (hull) lines.push(`${hull} on the hull`);
      if (water) lines.push(`${water} in the water`);
      const text = lines.join('|') + active;
      if (text !== s.labelText) { s.labelText = text; drawLabel(s.label, active ? 'Capsized' : 'All clear', lines.length ? lines : ['Everyone off'], 0xff5a3c, active); }
      const d = s.label.position.distanceTo(cam);
      s.label.visible = active && d > 45 && d < 1500;
      placeBoat(s.model, { x: s.x, y: s.level + s.rise + 0.03 * Math.sin(this.time * 0.9 + s.phase), z: s.z, heading: s.heading, pitch: 0.01 * Math.sin(this.time * 0.7 + s.phase), roll: Math.PI + s.list + 0.02 * Math.sin(this.time * 0.8 + s.phase) });
    }
  }

  // ------------------------------------------------------------ the end
  _end(won) {
    if (this.over) return;
    this.over = true; this.won = won;
    this.charge = null;
    const g = this.g, def = this.def, left = this.clock;
    const prev = this.best[def.id] ?? null;
    const record = won && (prev === null || left > prev);
    if (record) { this.best[def.id] = left; saveJSON('rb.rescueBest', this.best); }
    const frac = left / def.time, medal = !won ? null : frac >= 0.3 ? 'gold' : frac >= 0.15 ? 'silver' : 'bronze';
    if (won) { g.audio.finish(); g.hud.message('Everyone\'s safe!', `${formatTime(left)} to spare`, 2600, '#7ee081'); }
    else { g.audio.fail(); g.hud.message('Out of time', `${this.saved} of ${this.total} rescued`, 2600, '#ff6b6b'); }
    const bm = this.bm, me = this;
    setTimeout(() => {
      if (bm.rescue === me && bm.active) g.showResults({ rescue: true, id: def.id, title: `Harbor Rescue · ${def.name}`, won, saved: this.saved, total: this.total, left, used: def.time - left, medal, record, prev });
    }, 2300);
  }

  // ------------------------------------------------------------ HUD
  _nextSite() {
    const b = this.bm.body;
    let best = null;
    for (const s of this.sites) {
      const n = s.onHull.filter((p) => p.where === 'hull').length + s.inWater.filter((p) => p.where === 'water' || p.where === 'swim').length;
      if (!n) continue;
      const d = Math.hypot(s.x - b.x, s.z - b.z);
      if (!best || d < best.d) best = { s, d, n };
    }
    return best;
  }

  hud(metric) {
    const hud = this.g.hud, b = this.bm.body, R = this.ring, m = this.plank, nx = this._nextSite();
    let sub;
    if (this.over) sub = this.won ? 'Everyone\'s safe' : 'Out of time';
    else if (m) sub = m.stage === 'extend' ? 'Putting the plank across' : m.stage === 'retract' ? 'Taking the plank in' : `Climbing across${m.queue.length - m.next ? ` (${m.queue.length - m.next} to go)` : ''}`;
    else if (R.state === 'held') sub = b.speed > SLIP ? 'Slow down! The line\'s slipping' : 'Reeling them in: hold her steady';
    else if (R.state === 'fly') sub = 'Life ring away...';
    else if (R.state === 'float' && R.who) sub = 'They\'re swimming for the ring';
    else if (R.state === 'back' || R.state === 'float') sub = 'Reeling the ring back in';
    else if (this.charge) sub = `Let go at the mark · ${Math.round(this.tgt.d)} m`;
    else if (this.tgt) sub = `In the water ${Math.round(this.tgt.d)} m off: hold Space, let go at the mark`;
    else if (this.near && this.near.dist < 120 && this.near.s.onHull.some((p) => p.where === 'hull')) {
      const n = this.near, gap = n.gap - n.s.beam / 2;
      sub = gap > PLANK ? `Come alongside the hull: foredeck to it · ${Math.round(gap)} m` : b.speed > 1.1 ? `Slow down for the plank · ${Math.round(b.speed * (metric ? 3.6 : 2.237))} ${metric ? 'km/h' : 'mph'}` : 'Hold her steady...';
    } else if (nx) sub = `${nx.n} to rescue ${nx.s.def.place} · ${formatDistance(nx.d, metric)}`;
    else sub = 'Everyone\'s aboard';
    let meter = '';
    if (this.tgt && !this.over) {
      const c = this.tgt.d / RANGE, g = GRAB / RANGE, r = REACH / RANGE;
      const pct = (x) => (clamp(x, 0, 1) * 100).toFixed(1);
      meter = `<div class="throw"><i style="left:${pct(c - r)}%;width:${pct(2 * r)}%"></i><u style="left:${pct(c - g)}%;width:${pct(2 * g)}%"></u>${this.charge ? `<b style="left:${pct(this.power)}%"></b>` : ''}</div>`;
    }
    const aboard = this.people.filter((p) => p.where === 'aboard' || p.where === 'deckwalk').length;
    hud.setMission({
      title: `Harbor Rescue · ${this.def.name}`, sub, time: formatTime(this.clock), urgent: !this.over && this.clock < 30,
      extra: `${meter}<b>Rescued ${this.saved}/${this.total}</b>${aboard ? ` &middot; ${aboard} aboard` : ''}` +
        `<br>W ahead · S astern · A D helm · H horn · come alongside a hull to take its people off · Space (hold, let go) throw a life ring`,
    });
    const best = this.best[this.def.id];
    hud.setScore(`<div class="small">Rescued</div><div class="big">${this.saved}/${this.total}</div><div class="small">${best != null ? 'Best ' + formatTime(best) + ' to spare' : this.sites.length + (this.sites.length === 1 ? ' boat' : ' boats') + ' over'}</div>`);
    hud.setStreet('Boston Harbor', nx && nx.d < 200 ? `Capsized ${nx.s.def.place}` : 'Harbor Rescue');
  }

  overlays() {
    const markers = [];
    for (const s of this.sites) {
      const n = s.onHull.filter((p) => p.where === 'hull').length + s.inWater.length;
      markers.push({ x: s.x, z: s.z, r: n ? 8 : 4, color: n ? '#ff5a3c' : '#8a94a6', label: n ? String(n) : '', edge: n > 0 });
    }
    return { markers };
  }

  // Swing the chase camera round to the people being rescued.
  aimCamera(cam, dt) {
    if (cam.mode > 1 || this.over) return;
    const R = this.ring, b = this.bm.body;
    let x = null, z = null;
    if (this.plank) { x = this.plank.kx; z = this.plank.kz; }
    else if (R.state !== 'ready') { x = R.x; z = R.z; }
    else if (this.charge && this.tgt) { x = this.tgt.p.x; z = this.tgt.p.z; }
    if (x === null) return;
    // (The chase camera looks along heading + yaw: from behind the rail, out toward them.)
    const rel = wrapAngle(Math.atan2(x - b.x, -(z - b.z)) - b.heading), look = cam.look;
    const want = clamp(rel, -2.3, 2.3) * 0.85;
    look.yaw += wrapAngle(want - look.yaw) * damp(1.6, dt);
    look.pitch += (-0.16 - look.pitch) * damp(1.6, dt);
    look.idle = 0;
  }

  dispose() {
    const B = this.g.boats;
    B.avoid = null;
    this.bm.env.obstacles = null;
    if (!this.root) return;
    for (const s of this.sites) disposeBoat(s.model);
    this.root.parent?.remove(this.root);
    this.crowd.dispose();
    this.root.traverse((o) => {
      if (!o.isMesh && !o.isSprite && !o.isLine) return;
      if (o.geometry && !o.isInstancedMesh && !o.isSprite) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mm of mats) { if (mm && mm.map) mm.map.dispose(); if (mm && !o.isInstancedMesh) mm.dispose(); }
    });
  }
}
