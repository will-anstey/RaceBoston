// Taken aboard: a small boat frozen in (the canoe, the rowboat or a single
// scull) is lifted out by the icebreaker that answered its call. Once she has
// broken the ice round you she stops close by and a life ring comes across on
// a line: you're hauled alongside and hoisted up onto her deck. Then the deck
// crane swings out, lines go on your boat and it's lifted aboard onto the
// foredeck. She takes you to the nearest landing and puts you ashore, and you
// carry on in the car from the street above it.

import * as THREE from 'three';
import { BREAKER, CRANE, setCrane, craneTip, placeBoat, PLAYER_CLUB } from './boats.js';
import { Crowd, placeLanding, buildLandings, dockPt, drawLabel, makeGangway, FERRY_ROUTES, W as LW, GAP, RAMP_U, PANTS, SKIN } from './ferry.js';
import { makeLifeRing, hangLine } from './rescue.js';
import { clamp, damp, wrapAngle, formatDistance } from './util.js';

// Landings round the harbour where the icebreakers put people ashore.
export const HARBOR_LANDINGS = [
  ['Long Wharf', 42.3603, -71.0478],
  ['Charlestown Navy Yard', 42.3725, -71.054],
  ['Piers Park', 42.3637, -71.0367],
  ['Fan Pier', 42.354, -71.043],
  ['Logan Airport Dock', 42.3613, -71.0293],
  ['Black Falcon Pier', 42.3437, -71.0284],
  ['Castle Island', 42.3384, -71.0118],
];

const TOW = 1.4;                       // m/s, hauling the boat alongside
const HOIST = 2.2;                     // s up the side and over the rail
const WALK = 1.4;                      // m/s on deck and ashore
const TRANSIT = 9;                     // m/s, under way to the landing
const LUFF_OUT = 0.8;                  // the boom's angle reaching out over the side
const DECK = { x: 1.9, z: -6.3 };      // where the boat sits on the foredeck (x toward its side)
const SPOTS = [[0.6, -4.4], [1.8, -4.4]];   // where you stand on deck (x away from the boat)
const KEEL = { canoe: 0.13, dinghy: 0.33, single: 0.15 };   // keel below the boat's waterline
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const ease = (t) => t * t * (3 - 2 * t);
const TEXT = {
  stop: (p) => `${p.ib.name} is stopping beside you`,
  throw: () => 'Life ring!',
  catch: () => 'Got it',
  tow: () => 'Hauling you alongside',
  hoist: () => 'Up you come',
  craneOut: (p) => `Swinging the crane out over your ${p.boatName}`,
  lines: (p) => `Lines on your ${p.boatName}`,
  lift: (p) => `Hoisting your ${p.boatName} aboard`,
  swing: (p) => `Hoisting your ${p.boatName} aboard`,
  lower: (p) => `Setting your ${p.boatName} down on deck`,
  release: () => 'All aboard',
  berth: (p) => `Coming alongside ${p.landing.name}`,
  gangway: (p) => `${p.landing.name}: the gangway's going out`,
  ashore: () => 'Going ashore',
};

export class Pickup {
  constructor(bm, ib) {
    this.bm = bm; this.g = bm.g; this.ib = ib;
    this.body = bm.body; this.model = bm.model; this.T = bm.body.T;
    this.boatName = this.T.name.toLowerCase();
    this.stage = 'stop'; this.t = 0; this.time = 0; this.breakT = 0;
    this.crane = ib.model.crane;
    this.rOut = CRANE.boom * Math.cos(LUFF_OUT);
    // In the world: the ring, its line, the gangway and the landing. In the
    // ship's own frame (so nothing lags her): the people, the crane's lines,
    // and your boat once it's off the water.
    this.root = new THREE.Group();
    this.g.scene.add(this.root);
    this.onShip = new THREE.Group();
    ib.model.root.add(this.onShip);
    this.crowd = new Crowd(this.onShip, 4);
    this.ring = makeLifeRing(this.root);
    this.gangway = makeGangway();
    this.root.add(this.gangway);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x262626 }));
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.onShip.add(this.lines);
    this.people = [];
    this.landing = null; this.berth = null; this.finished = false; this.ext = 0; this.stowing = false;
    this.yLift = BREAKER.deckY(CRANE.z) + 1.7;
    this.yDeck = BREAKER.deckY(DECK.z) + (KEEL[bm.type] ?? 0.2) + 0.1;
    this._inv = new THREE.Matrix4(); this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this.cam = {};
    // Slow to a stop where she is, on her way round you.
    ib.free = { pts: [[ib.x + ib.fx * 14, ib.z + ib.fz * 14]], v: 1.5, stop: 12 };
    this.g.hud.message('Hold on', `${ib.name} will take you aboard`, 2400, '#bfe6ff');
  }

  // ------------------------------------------------------------ frames
  _ship() { const r = this.ib.model.root; r.updateMatrixWorld(); return r.matrixWorld; }
  _toWorld(lx, ly, lz, out = new THREE.Vector3()) { return out.set(lx, ly, lz).applyMatrix4(this._ship()); }
  _toLocal(v, out = new THREE.Vector3()) { this._inv.copy(this._ship()).invert(); return out.copy(v).applyMatrix4(this._inv); }
  _go(stage) { this.stage = stage; this.t = 0; }
  _hold() { this.ib.free = { pts: [[this.ib.x, this.ib.z]], v: 0, stop: 99 }; this.ib.v = 0; }
  get onBoard() { return this.stage !== 'stop' && this.stage !== 'throw' && this.stage !== 'catch' && this.stage !== 'tow'; }

  // ------------------------------------------------------------ per frame
  update(dt) {
    const ib = this.ib, g = this.g, c = this.crane, t = (this.t += dt);
    this.time += dt;
    if (this.finished) return;
    if (ib.dead || !ib.help) { this.bm.endPickup(); return; }
    switch (this.stage) {
      case 'stop':
        if (ib.v < 0.25 || t > 10) {
          this._hold();
          const L = this._toLocal(this._a.set(this.body.x, this.body.y, this.body.z));
          this.sgn = L.x >= 0 ? 1 : -1;
          this.rel = Math.abs(wrapAngle(this.body.heading - ib.heading)) < Math.PI / 2 ? 0 : Math.PI;
          this._aimThrow();
          this._go('throw');
        }
        break;
      case 'throw':
        if (t >= this.throwDur) {
          g.boats.wakes.emit(this.throwTo.x, this.throwTo.y, this.throwTo.z, 0, 0.8, 0.5, 3, 0, 0, 1.2);
          g.audio.oar?.(0.6);
          this._go('catch');
        }
        break;
      case 'catch':
        if (t > 0.9) { this._go('tow'); g.hud.message('Got it', 'Hauling you alongside', 1500, '#7ee081'); }
        break;
      case 'tow': this._tow(dt); break;
      case 'hoist':
        if (this.people.every((p) => p.state !== 'hoist') && this.people.length >= this.model.rig.seats.length) {
          this.c0 = { phi: c.phi, alpha: c.alpha };
          const dx = this.sgn * DECK.x, dz = DECK.z - CRANE.z;
          this.phiDeck = Math.atan2(dx, -dz);
          this.alphaDeck = Math.acos(clamp(Math.hypot(dx, dz) / CRANE.boom, 0, 1));
          this._go('craneOut');
        }
        break;
      case 'craneOut': {
        const u = ease(Math.min(1, t / 3));
        setCrane(c, this.c0.phi + wrapAngle(this.sgn * Math.PI / 2 - this.c0.phi) * u, this.c0.alpha + (LUFF_OUT - this.c0.alpha) * u);
        if (t >= 3) this._go('lines');
        break;
      }
      case 'lines':
        if (t >= 2.4) { this._liftOff(); this._go('lift'); g.hud.message('Lines on', `Lifting your ${this.boatName} aboard`, 1600, '#bfe6ff'); }
        break;
      case 'lift': if (t >= 3.5) this._go('swing'); break;
      case 'swing': {
        const u = ease(Math.min(1, t / 3.5));
        setCrane(c, this.sgn * Math.PI / 2 + wrapAngle(this.phiDeck - this.sgn * Math.PI / 2) * u, LUFF_OUT + (this.alphaDeck - LUFF_OUT) * u);
        if (t >= 3.5) this._go('lower');
        break;
      }
      case 'lower': if (t >= 2.5) this._go('release'); break;
      case 'release': if (t >= 1.2) this._planTrip(); break;
      case 'transit': this._transit(); break;
      case 'berth': this._berthing(dt); break;
      case 'gangway':
        this.ext = Math.min(1, this.ext + dt / 1.1);
        if (this.ext >= 1) this._disembark();
        break;
    }
    if (this.stowing) this._stow();
    this._poseBoat();
    this._poseRing();
    this._poseLines();
    this._posePeople(dt);
    this._poseGangway();
    if (this.landing) {
      const d = this.landing, far = d.label.position.distanceTo(g.camera.position);
      d.beam.material.uniforms.uTime.value = this.time;
      d.label.visible = far > 32 && far < 1200;
    }
  }

  // ------------------------------------------------------------ the ring and the tow
  _aimThrow() {
    const lz = -7.4, b = this.body, hw = BREAKER.halfWidth(lz);
    const from = this._toWorld(this.sgn * (hw - 0.12), BREAKER.deckY(lz) + 1.15, lz);
    const dx = b.x - from.x, dz = b.z - from.z, d = Math.hypot(dx, dz) || 1, off = b.T.beam / 2 + 0.7;
    this.throwFrom = from;
    this.throwTo = new THREE.Vector3(b.x - (dx / d) * off, b.level + 0.05, b.z - (dz / d) * off);
    this.throwDur = 0.55 + d / 26;
    this.throwApex = 1.5 + d * 0.12;
    this.g.audio.beep?.(false);
  }

  // Hauled in on the line to lie alongside, under the crane, square to her.
  _tow(dt) {
    const b = this.body, ib = this.ib;
    const A = this._toWorld(this.sgn * this.rOut, 0, CRANE.z, this._b);
    const dx = A.x - b.x, dz = A.z - b.z, d = Math.hypot(dx, dz), step = Math.min(d, TOW * dt);
    b.x += (dx / (d || 1)) * step; b.z += (dz / (d || 1)) * step;
    const e = wrapAngle(ib.heading + this.rel - b.heading);
    b.heading = wrapAngle(b.heading + clamp(e, -0.4 * dt, 0.4 * dt));
    b.level = this.g.map.terrain.h(b.x, b.z);
    b.y = b.level + 0.015 * Math.sin(this.time * 1.9);
    b.vx = b.vz = b.vF = b.vR = b.yawRate = 0; b.pitch = 0; b.roll = 0.01 * Math.sin(this.time * 1.3);
    this.breakT -= dt;
    if (this.breakT <= 0) { this.breakT = 0.3; this.g.ice.breakAt(b.x, b.z, b.T.len / 2 + 1.5, 0); }
    if (d < 0.3 && Math.abs(e) < 0.04) {
      this._go('hoist');
      this._startHoist(0);
      this.g.hud.message('Alongside', 'Up you come', 1400, '#bfe6ff');
    }
  }

  // One of you, out of the boat and up the side on the line.
  _startHoist(k) {
    const m = this.model, rig = m.rig;
    m.root.updateMatrixWorld();
    const L = this._toLocal(this._a.set(0, rig.seatY + 0.05, rig.seats[k]).applyMatrix4(m.root.matrixWorld));
    m.crew.setMatrixAt(k, ZERO);
    m.crew.instanceMatrix.needsUpdate = true;
    if (m.paddles) m.paddles[k].visible = false;
    const z1 = clamp(L.z, -10.2, -3.4);
    const i = this.crowd.alloc(PLAYER_CLUB.jersey, PANTS[k % PANTS.length], PLAYER_CLUB.tip, SKIN[(k * 2 + 1) % SKIN.length], true);
    this.people.push({
      i, k, state: 'hoist', t: 0, x0: L.x, y0: L.y, z0: L.z, z1, x1: this.sgn * (BREAKER.halfWidth(z1) - 0.9),
      sx: -this.sgn * SPOTS[k][0], sz: SPOTS[k][1], x: L.x, y: L.y, z: L.z, h: -this.sgn * Math.PI / 2, phase: k * 2, path: null,
    });
  }

  // ------------------------------------------------------------ the lift
  // The lines are on: from here your boat rides in the ship's frame.
  _liftOff() {
    const m = this.model;
    m.root.updateMatrixWorld();
    const L = this._toLocal(this._a.setFromMatrixPosition(m.root.matrixWorld));
    this.onShip.add(m.root);
    m.root.position.copy(L);
    m.root.rotation.set(0, -this.rel, 0, 'YXZ');
    this.y0 = L.y;
  }

  _poseBoat() {
    const m = this.model, b = this.body, st = this.stage;
    if (!m) return;
    if (!this.onBoard || st === 'hoist' || st === 'craneOut' || st === 'lines') {
      if (m.root.parent !== this.onShip) placeBoat(m, b);
      return;
    }
    const tip = craneTip(this.crane, this._b), t = this.t;
    const deck = st === 'release' || st === 'transit' || st === 'berth' || st === 'gangway' || st === 'ashore';
    let x = tip.x, z = tip.z, y = this.yLift;
    if (st === 'lift') y = this.y0 + (this.yLift - this.y0) * ease(Math.min(1, t / 3.5));
    else if (st === 'lower') y = this.yLift + (this.yDeck - this.yLift) * ease(Math.min(1, t / 2.5));
    if (deck) { x = this.sgn * DECK.x; z = DECK.z; y = this.yDeck; }
    m.root.position.set(x, y, z);
    const sway = deck ? 0 : 1;
    m.root.rotation.set(0.02 * Math.sin(this.time * 1.3) * sway, -this.rel + 0.03 * Math.sin(this.time * 0.9) * sway, 0.03 * Math.sin(this.time * 1.7) * sway, 'YXZ');
    // The body goes with it (the focus, the map).
    const w = this._toWorld(x, y, z, this._a);
    b.x = w.x; b.y = w.y; b.z = w.z; b.heading = wrapAngle(this.ib.heading + this.rel);
  }

  // The crane's two lines, from the boom tip to lifting eyes fore and aft on your boat.
  _poseLines() {
    const st = this.stage, show = st === 'lines' || st === 'lift' || st === 'swing' || st === 'lower' || st === 'release';
    this.lines.visible = show;
    if (!show) return;
    const m = this.model, tip = craneTip(this.crane, this._b), pos = this.lines.geometry.attributes.position;
    const u = st === 'lines' ? ease(Math.min(1, this.t / 2)) : st === 'release' ? 1 - ease(Math.min(1, this.t / 1.2)) : 1;
    m.root.updateMatrixWorld();
    for (let k = 0; k < 2; k++) {
      const eye = this._toLocal(this._a.set(0, 0.35, (k ? 1 : -1) * this.T.len * 0.36).applyMatrix4(m.root.matrixWorld));
      pos.setXYZ(2 * k, tip.x, tip.y - 0.35, tip.z);
      pos.setXYZ(2 * k + 1, tip.x + (eye.x - tip.x) * u, tip.y - 0.35 + (eye.y - tip.y + 0.35) * u, tip.z + (eye.z - tip.z) * u);
    }
    pos.needsUpdate = true;
  }

  // Back to stowed once your boat's down.
  _stow() {
    const c = this.crane, k = Math.min(1, this.t / 3);
    if (!this.s0) this.s0 = { phi: c.phi, alpha: c.alpha };
    const u = ease(k);
    setCrane(c, this.s0.phi + wrapAngle(CRANE.stowSlew - this.s0.phi) * u, this.s0.alpha + (CRANE.stowLuff - this.s0.alpha) * u);
    if (k >= 1) this.stowing = false;
  }

  // ------------------------------------------------------------ the ring
  _poseRing() {
    const R = this.ring, st = this.stage, m = this.model;
    let x, y, z;
    if (st === 'throw') {
      const u = Math.min(1, this.t / this.throwDur), F = this.throwFrom, T = this.throwTo;
      x = F.x + (T.x - F.x) * u; z = F.z + (T.z - F.z) * u; y = F.y + (T.y - F.y) * u + 4 * this.throwApex * u * (1 - u);
      R.mesh.rotation.set(this.t * 9, this.t * 4, 0);
    } else if (st === 'catch' || st === 'tow' || (st === 'hoist' && this.people[0] && this.people[0].state === 'hoist')) {
      // In your hands.
      let hand;
      if (st === 'hoist') { const p = this.people[0]; hand = this._toWorld(p.x, p.y + 2.0, p.z, this._a); }
      else { m.root.updateMatrixWorld(); hand = this._a.set(0, m.rig.seatY + 0.75, m.rig.seats[0] - 0.35).applyMatrix4(m.root.matrixWorld); }
      const u = st === 'catch' ? ease(Math.min(1, this.t / 0.9)) : 1, T = this.throwTo;
      x = T.x + (hand.x - T.x) * u; y = T.y + (hand.y - T.y) * u; z = T.z + (hand.z - T.z) * u;
      R.mesh.rotation.set(Math.PI / 2, 0, 0);
    } else { R.mesh.visible = R.line.visible = false; return; }
    R.mesh.visible = true;
    R.mesh.position.set(x, y, z);
    const F = this.throwFrom, tight = st === 'tow' || st === 'hoist';
    hangLine(R, F.x, F.y, F.z, x, y, z, tight ? 0.12 : 0.5 + 0.03 * Math.hypot(x - F.x, z - F.z), this.body.level + 0.03);
  }

  // ------------------------------------------------------------ people
  _posePeople(dt) {
    const t = this.time;
    for (const p of this.people) {
      let swing = 0, bob = 0, arms = null, moving = false;
      if (p.state === 'hoist') {
        // Straight up the side to clear the rail, then in over it onto the deck.
        p.t += dt;
        const u = Math.min(1, p.t / HOIST), deck = BREAKER.deckY(p.z1), xo = this.sgn * (BREAKER.halfWidth(p.z1) + 0.45), top = deck + 1.3;
        if (u < 0.65) {
          const e = ease(u / 0.65);
          p.x = p.x0 + (xo - p.x0) * e; p.y = p.y0 + (top - p.y0) * e; p.z = p.z0 + (p.z1 - p.z0) * e;
        } else {
          const e = ease((u - 0.65) / 0.35);
          p.x = xo + (p.x1 - xo) * e; p.y = top - 1.3 * e; p.z = p.z1;
        }
        arms = [Math.PI - 0.15, Math.PI - 0.15];
        if (u >= 1) {
          p.state = 'deckwalk';
          p.dw = { x0: p.x, z0: p.z, x1: p.sx, z1: p.sz, t: 0, len: Math.hypot(p.sx - p.x, p.sz - p.z) || 0.1 };
          this.g.audio.checkpoint?.();
          if (p.k + 1 < this.model.rig.seats.length) this._startHoist(p.k + 1);
        }
      } else if (p.state === 'deckwalk') {
        const w = p.dw;
        w.t = Math.min(1, w.t + (WALK * dt) / w.len);
        p.x = w.x0 + (w.x1 - w.x0) * w.t; p.z = w.z0 + (w.z1 - w.z0) * w.t; p.y = BREAKER.deckY(p.z);
        p.h = Math.atan2(w.x1 - w.x0, -(w.z1 - w.z0));
        moving = true;
        if (w.t >= 1) { p.state = 'aboard'; p.h = this.sgn * 0.5; }
      } else if (p.state === 'aboard') {
        p.y = BREAKER.deckY(p.z);
        bob = 0.006 * Math.sin(t * 1.3 + p.k);
        // Watching your boat come aboard.
        if (this.stage !== 'transit') p.h += wrapAngle(Math.atan2(this.sgn * 3, -1) - p.h) * damp(2, dt);
      } else if (p.state === 'off' && p.path) {
        if (p.delay > 0) p.delay -= dt;
        else {
          let left = WALK * dt;
          while (left > 0 && p.path) {
            const a = p.path[p.seg], c = p.path[p.seg + 1], len = a.distanceTo(c) || 1e-3;
            if (p.u + left < len) { p.u += left; left = 0; }
            else { left -= len - p.u; p.u = 0; p.seg++; if (p.seg >= p.path.length - 1) { p.path = null; p.done?.(); } }
          }
          if (p.path) {
            const a = p.path[p.seg], c = p.path[p.seg + 1], u = p.u / (a.distanceTo(c) || 1e-3);
            p.x = a.x + (c.x - a.x) * u; p.y = a.y + (c.y - a.y) * u; p.z = a.z + (c.z - a.z) * u;
            p.h = wrapAngle(p.h + wrapAngle(Math.atan2(c.x - a.x, -(c.z - a.z)) - p.h) * damp(8, dt));
            moving = true;
          }
        }
      }
      if (moving) { p.phase += dt * WALK * 5.2; swing = Math.sin(p.phase) * 0.55; bob = Math.abs(Math.cos(p.phase)) * 0.04; }
      this.crowd.pose(p.i, p.x, p.y, p.z, p.h, swing, bob, 1, arms);
    }
    this.crowd.flush();
  }

  // ------------------------------------------------------------ to the landing
  // The nearest landing on her reach (or, failing that, a new one at the
  // nearest bank with a street behind it), and the way there.
  _planTrip() {
    const ib = this.ib, g = this.g, B = g.boats, P = ib.P, info = B.infoFor(P), m = g.map.meta;
    const zone = info.zones[ib.zone] || [40, P.length - 40], harbor = P === B.harbor, reach = harbor ? 1300 : 650;
    const xz = (lat, lon) => [(lon - m.origin.lon) * m.metersPerDegree.lon, -(lat - m.origin.lat) * m.metersPerDegree.lat];
    const cands = (harbor ? HARBOR_LANDINGS : FERRY_ROUTES.flatMap((r) => r.stops))
      .map(([name, lat, lon]) => { const [x, z] = xz(lat, lon); return { name, lat, lon, dist: Math.hypot(x - ib.x, z - ib.z) }; })
      .sort((a, b) => a.dist - b.dist);
    let d = null;
    for (const c of cands.slice(0, 5)) if (!d) d = placeLanding(g, P, zone, c.name, c.lat, c.lon, reach);
    if (!d) {
      const sh = B.shoreFrom(ib.x, ib.z);
      if (sh) {
        const T = g.map.terrain, r = g.graph.nearestRoad3D(sh.x + sh.ux * 10, sh.z + sh.uz * 10, T.h(sh.x, sh.z), 90);
        const name = (r && g.map.roads[r.road].name) || 'the bank';
        d = placeLanding(g, P, zone, name, m.origin.lat - sh.z / m.metersPerDegree.lat, m.origin.lon + sh.x / m.metersPerDegree.lon, reach);
      }
    }
    if (!d) {
      // Nowhere to land her: straight ashore at the nearest bank.
      this.finished = true;
      this.bm.leaveAboard();
      g.goAshore({ road: null, heading: this.body.heading, toast: ['Put ashore on the bank', `Thanks to the icebreaker ${ib.name}`] });
      return;
    }
    this.landing = d;
    buildLandings([d], this.root, harbor ? 'HARBOR LANDING' : 'ICEBREAKER FERRY');
    d.beam.visible = true;
    d.beam.material.uniforms.uColor.value.setHex(0x4dff88);
    d.berth.visible = true;
    d.berth.material.color.setHex(0x4dff88);
    d.label.visible = true;
    drawLabel(d.label, d.name, ['Your stop'], 0x4dff88, true);
    // Her berth: the gangway port beside the landing, heading the way she's going.
    const along = Math.atan2(d.ax, -d.az), pathH = P.heading(d.s, Math.sign(d.s - ib.s) || 1);
    const h = Math.cos(along - pathH) >= 0 ? along : along + Math.PI;
    const fx = Math.sin(h), fz = -Math.cos(h), rx = -fz, rz = fx;
    const sgn = rx * -d.nx + rz * -d.nz > 0 ? 1 : -1;
    const A = dockPt(d, 0, LW / 2 + GAP);
    const tx = A.x - rx * sgn * BREAKER.gangX + fx * BREAKER.gangZ, tz = A.z - rz * sgn * BREAKER.gangX + fz * BREAKER.gangZ;
    const pre = [tx - fx * 45 + d.nx * 6, tz - fz * 45 + d.nz * 6];
    // Along the waterway, easing over to the landing's side, clear of bridge piles.
    const pts = [], s1 = P.project(tx, tz, d.s, {}), dir = Math.sign(s1.s - ib.s) || 1;
    for (let u = ib.s + dir * 45; dir * (s1.s - dir * 80 - u) > 0; u += dir * 45) {
      const k = Math.min(1, Math.abs(u - ib.s) / 220);
      const lane = B.avoidPillars(info, u, ib.d + (s1.d - ib.d) * k, ib.T.beam / 2 + 1.5);
      const p = P.at(u, lane, {});
      pts.push([p.x, p.z]);
    }
    pts.push(pre, [tx, tz]);
    ib.free = { pts, v: TRANSIT, stop: 1.2, pass: 16 };
    this.berth = { tx, tz, h, sgn, pre };
    this.stowing = true; this.s0 = null;
    this._go('transit');
    g.hud.message(`Bound for ${d.name}`, 'E to skip ahead', 2400, '#7ee081');
  }

  _transit() {
    const ib = this.ib, B = this.berth;
    if (ib.free.arrived || (Math.hypot(ib.x - B.tx, ib.z - B.tz) < 2.5 && ib.v < 1.6)) {
      this._hold();
      this.landing.beam.visible = this.landing.berth.visible = false;   // (she's there: they'd only fill the view)
      this._go('berth');
    }
  }

  // E while she's under way: on to the landing.
  skip() {
    if (this.stage !== 'transit') return false;
    const ib = this.ib, B = this.berth;
    ib.x = B.pre[0]; ib.z = B.pre[1]; ib.heading = B.h; ib.v = 3;
    ib.s = ib.P.project(ib.x, ib.z, null, {}).s;
    ib.free = { pts: [[B.tx, B.tz]], v: TRANSIT, stop: 1.2 };
    ib.pose(0);
    this.bm.camera.snap();
    return true;
  }

  // Eased in square to the landing, then the gangway goes across.
  _berthing(dt) {
    const ib = this.ib, B = this.berth, k = damp(2.2, dt);
    ib.v = 0;
    ib.x += (B.tx - ib.x) * k; ib.z += (B.tz - ib.z) * k;
    ib.heading = wrapAngle(ib.heading + wrapAngle(B.h - ib.heading) * k);
    ib.free.pts = [[ib.x, ib.z]];
    if (this.t > 2.6) {
      const d = this.landing, A = this._toWorld(B.sgn * BREAKER.gangX, BREAKER.deckY(BREAKER.gangZ), BREAKER.gangZ);
      const u = (A.x - d.cx) * d.ax + (A.z - d.cz) * d.az;
      this.gang = { A, B: dockPt(d, u, LW / 2 - 0.45), Bin: dockPt(d, u, LW / 2 - 1.4) };
      this.ext = 0;
      this.g.audio.shipHorn?.(0.6);
      this.g.hud.message(d.name, 'Lines out', 1300, '#bfe6ff');
      this._go('gangway');
    }
  }

  _poseGangway() {
    const G = this.gangway, m = this.gang;
    if (!m || this.ext <= 0.001) { G.visible = false; return; }
    const E = m.A.clone().lerp(m.B, this.ext);
    G.visible = true;
    G.position.copy(m.A);
    G.lookAt(E);
    G.scale.set(1, 1, Math.max(0.05, m.A.distanceTo(E)));
  }

  // Over the gangway, along the landing and up the walkway to the street.
  _disembark() {
    const d = this.landing, B = this.berth, gw = this.gang;
    this._go('ashore');
    const ashore = [gw.A, gw.B, gw.Bin, dockPt(d, RAMP_U, -LW / 2 + 0.4), new THREE.Vector3(d.tx, d.bankY + 0.05, d.tz), new THREE.Vector3(d.inland[0], d.bankY, d.inland[1])].map((v) => this._toLocal(v));
    // (Round the stern of your boat, sitting on deck, to the gangway port.)
    const round = new THREE.Vector3(0, BREAKER.deckY(-2.1), -2.1), port = new THREE.Vector3(B.sgn * 2.5, BREAKER.deckY(BREAKER.gangZ), BREAKER.gangZ);
    for (const p of this.people) {
      p.state = 'off';
      p.path = [new THREE.Vector3(p.x, p.y, p.z), round.clone(), port.clone(), ...ashore.map((v) => v.clone())];
      p.seg = 0; p.u = 0; p.delay = p.k * 1.1;
      // You: once you're up on the street, back to the car.
      if (p.k === 0) p.done = () => this._finish();
      p.path.length -= 1;   // (stop at the top of the walkway)
    }
  }

  _finish() {
    if (this.finished) return;
    this.finished = true;
    const d = this.landing, g = this.g, T = g.map.terrain;
    const road = g.graph.nearestRoad3D(d.inland[0], d.inland[1], T.h(d.inland[0], d.inland[1]), 120);
    this.bm.leaveAboard();
    g.goAshore({ road, heading: Math.atan2(-d.nx, d.nz), toast: [`Dropped off at ${d.name}`, `Thanks to the icebreaker ${this.ib.name}`] });
  }

  // Your boat stays on her deck when you go ashore.
  handOver() {
    const m = this.model;
    if (!m) return;
    if (m.root.parent === this.onShip) this.ib.model.root.attach(m.root);
    this.ib.cargo = m;
    this.model = null;
  }

  // ------------------------------------------------------------ camera, HUD, map
  // The chase camera follows your boat until you're aboard, then the ship.
  camTarget() {
    if (!this.onBoard) return this.body;
    const ib = this.ib, c = this.cam;
    c.x = ib.x; c.y = ib.y; c.z = ib.z; c.heading = ib.heading; c.fx = ib.fx; c.fz = ib.fz;
    c.vx = ib.fx * ib.v; c.vz = ib.fz * ib.v; c.vF = ib.v; c.speed = Math.abs(ib.v);
    c.camScale = 3.0; c.camLift = 7; c.eyeF = 0.7; c.eyeH = 5.4; c.boosting = false;
    return c;
  }

  // Swing round to watch: the ship from your boat, then your boat coming aboard.
  aimCamera(cam, dt) {
    if (cam.mode > 1 || this.stage === 'transit' || this.stage === 'ashore') return;
    const ib = this.ib, b = this.body, look = cam.look;
    let rel;
    if (!this.onBoard) rel = wrapAngle(Math.atan2(ib.x - b.x, -(ib.z - b.z)) - b.heading) * 0.6;
    else if (this.stage === 'berth' || this.stage === 'gangway') rel = (this.berth.sgn * Math.PI) / 2 * 0.8;
    else rel = clamp(wrapAngle(Math.atan2(b.x - ib.x, -(b.z - ib.z)) - ib.heading), -2.3, 2.3) * 0.85;
    look.yaw += wrapAngle(rel - look.yaw) * damp(1.4, dt);
    look.pitch += (-0.18 - look.pitch) * damp(1.4, dt);
    look.idle = 0;
  }

  hud(metric) {
    const hud = this.g.hud, ib = this.ib, d = this.landing;
    hud.setSpeed(ib.v, metric);
    hud.setGear(this.stage === 'gangway' || this.stage === 'ashore' ? 'MOOR' : ib.v > 0.3 ? 'AHD' : 'STOP');
    hud.setBoost(Math.min(1, ib.v / 12), false);
    const sub = this.stage === 'transit' ? `Bound for ${d.name} · ${formatDistance(Math.hypot(d.cx - ib.x, d.cz - ib.z), metric)}` : (TEXT[this.stage] || (() => ''))(this);
    hud.setMission({
      title: `Aboard the icebreaker ${ib.name}`, sub,
      extra: `${this.stage === 'transit' ? '<b style="color:#7ee081">E skip ahead to the landing</b> · ' : ''}C camera · drag to look · M map · Esc menu`,
    });
    hud.setScore(null);
    hud.setStreet(ib.P === this.g.boats.harbor ? 'Boston Harbor' : 'Charles River', d ? d.name : `Icebreaker ${ib.name}`);
  }

  overlays() {
    const d = this.landing, ib = this.ib;
    if (!d) return { markers: [{ x: ib.x, z: ib.z, r: 6, color: '#ff6b4a', edge: true }] };
    return { route: [[ib.x, ib.z], [d.cx, d.cz]], routeColor: '#7ee081', markers: [{ x: d.cx, z: d.cz, r: 8, color: '#4dff88', edge: true }] };
  }

  dispose() {
    const m = this.model;
    // Your boat (if it's still yours) goes back to the world for boat mode to clear away.
    if (m && m.root.parent === this.onShip) this.g.scene.attach(m.root);
    if (!this.finished && this.crane) setCrane(this.crane, CRANE.stowSlew, CRANE.stowLuff);
    this.onShip.parent?.remove(this.onShip);
    this.root.parent?.remove(this.root);
    this.crowd.dispose();
    for (const g of [this.root, this.onShip]) {
      g.traverse((o) => {
        if (!o.isMesh && !o.isSprite && !o.isLine) return;
        if (o.isInstancedMesh) return;   // (the crowd's own)
        if (o.geometry && !o.isSprite) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mm of mats) { if (mm && mm.map) mm.map.dispose(); mm?.dispose(); }
      });
    }
  }
}
