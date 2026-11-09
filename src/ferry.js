// Icebreaker Ferry: a shift at the helm of the river icebreaker, carrying
// commuters between landings on one reach of a frozen Charles. (The ship fits
// under the BU and Eliot bridges but not the low ones, so each route keeps to
// the reach between them.) Bring her alongside a landing and the gangway swings
// out: passengers for that stop walk off and up the bank, the people waiting
// walk aboard and stand on the foredeck, and you're away again. Fares pay by
// distance, tips for a quick, smooth crossing. Taking a group aboard buys
// the shift time for their trip, and delivering them a little more.

import * as THREE from 'three';
import { BoatBody, BREAKER } from './boats.js';
import { clamp, damp, formatTime, formatDistance, loadJSON, saveJSON, mulberry32, wrapAngle } from './util.js';
import { esc } from './hud.js';

// Landings (lat, lon) along each reach; a stop is moved a little along the
// bank if the ship wouldn't fit alongside it.
export const FERRY_ROUTES = [
  {
    id: 'ferry-bu', name: 'BU & MIT', blurb: 'River Street to the Harvard Bridge: the boathouses, Magazine Beach and BU', ref: [42.35325, -71.10777],
    stops: [['Riverside Boat Club', 42.35805, -71.11589], ['Magazine Beach', 42.35671, -71.11558], ['DeWolfe Boathouse', 42.35325, -71.10777],
      ['BU Sailing Pavilion', 42.35203, -71.11031], ['Deerfield Street Dock', 42.35112, -71.0977], ['MIT Boathouse', 42.3552, -71.0972]],
  },
  {
    id: 'ferry-esplanade', name: 'The Esplanade', blurb: 'Harvard Bridge to the Longfellow: the sailing pavilions and the Hatch Shell', ref: [42.3570, -71.0830],
    stops: [['Gloucester Street Landing', 42.35297, -71.08601], ['MIT Sailing Pavilion', 42.35843, -71.08768], ['Dartmouth Street Landing', 42.35471, -71.07961],
      ['Harvard Sailing Center', 42.36012, -71.08285], ['Hatch Shell', 42.3573, -71.07371]],
  },
  {
    id: 'ferry-upper', name: 'Upper Charles', blurb: 'Under the Eliot Bridge: Herter Park and the boat clubs', ref: [42.3700, -71.1320],
    stops: [['Henderson Boathouse', 42.3641, -71.14155], ['Herter Park', 42.36656, -71.13454], ['Cambridge Boat Club', 42.37217, -71.13397],
      ['Riverbend Park', 42.37411, -71.12938], ['Newell Boathouse', 42.36976, -71.12585]],
  },
];

export const L = 24, W = 4, TOP = 0.35;      // floating landing: length, width, deck above the water
const CAPACITY = BREAKER.slots.length;
const SHIFT = 150;                    // s on the clock to start
const WALK = 1.55;                    // m/s, passengers on the move
export const GAP = 0.5;                      // m between the gangway port and the landing, moored
export const RAMP_U = 7;                     // where the walkway ashore joins the landing
const PATIENCE = 200;                 // s a group waits before giving up
export const COAT = [0xb3261e, 0x1f3d6e, 0x2d2d2d, 0x2a6e4a, 0xe0a526, 0x6b3f8f, 0x8a5a33, 0x4f7fa8, 0xbfc3c7, 0xd96c8a, 0xc8102e, 0x22252b];
export const PANTS = [0x22252b, 0x2b3550, 0x4a4036, 0x3a3a3a, 0x5a5f66];
export const HATS = [0xc8102e, 0xf2c12e, 0x1f3d6e, 0xf4f4f0, 0x2a8c5a, 0x111111, 0xe8749a];
export const SKIN = [0xf1c27d, 0xe0ac84, 0xc68642, 0x8d5524, 0xffdbac];

export class FerryShift {
  constructor(bm, route) {
    this.bm = bm;
    this.g = bm.g;
    this.route = route;
    this.path = bm.path;
    this.rng = mulberry32((Date.now() & 0xffffff) ^ 0x2545f491);
    const P = this.path, B = this.g.boats;
    // The reach: the icebreakers' zone holding the route's reference point.
    const [rx, rz] = bm._xz(...route.ref);
    const sRef = P.project(rx, rz, null, {}).s;
    this.zone = B.zones.slice().sort((a, b) => dist1(sRef, a) - dist1(sRef, b))[0] || [40, P.length - 40];
    this.docks = [];
    for (const [name, lat, lon] of route.stops) {
      const d = this._placeDock(name, lat, lon);
      if (d && !this.docks.some((o) => Math.hypot(o.cx - d.cx, o.cz - d.cz) < L + 14)) this.docks.push(d);
    }
    this.docks.forEach((d, i) => { d.i = i; });
    this.time = 0; this.clock = SHIFT; this.started = false; this.over = false;
    this.money = 0; this.carried = 0; this.served = 0; this.trips = 0;
    this.people = []; this.groups = []; this.aboard = [];
    this.slots = BREAKER.slots.map(() => null);
    this.moor = null; this.near = null; this.dockT = 0; this.spawnT = 14; this.bumpT = 0;
    this.best = loadJSON('rb.ferryBest', {});
    this.root = new THREE.Group();
    this.g.scene.add(this.root);
    this.crowd = new Crowd(this.root, 150);
    this.gangway = makeGangway();
    this.root.add(this.gangway);
    this._buildDocks();
    // The ship can't sail through a landing; AI icebreakers keep off this reach.
    bm.env.obstacles = this.docks.map((d) => d.obstacle);
    B.raceRange = [this.zone[0] - 60, this.zone[1] + 60];
    for (const b of B.list.slice()) if (b.role !== 'race' && (b.role !== 'icebreaker' || (b.sMax > this.zone[0] && b.sMin < this.zone[1]))) B.remove(b);
    this._v = new THREE.Vector3();
  }

  get ok() { return this.docks.length >= 3; }
  get moored() { return !!this.moor; }

  // ------------------------------------------------------------ landings
  // A landing floats parallel to the bank a couple of metres out, with a
  // walkway ashore; the ship moors alongside its outer edge.
  _placeDock(name, lat, lon) { return placeLanding(this.g, this.path, this.zone, name, lat, lon); }

  _dockPt(d, u, v, y = d.y) { return dockPt(d, u, v, y); }

  _buildDocks() {
    const r = buildLandings(this.docks, this.root);
    this.dockMesh = r.mesh;
    this.lampMat = r.lampMat;
  }

  // ------------------------------------------------------------ the shift
  // Where the ship starts: moored at the first landing.
  startPose() {
    const d = this.docks[0], h = Math.atan2(d.ax, -d.az);
    const p = this._dockPt(d, BREAKER.gangZ, W / 2 + GAP + BREAKER.gangX);
    return { x: p.x, z: p.z, h };
  }

  // Passengers already waiting at the first three landings; the first lot board straight away.
  begin() {
    this._spawnGroup(this.docks[0], true);
    for (const d of this._shuffle(this.docks.slice(1)).slice(0, 2)) this._spawnGroup(d, true);
    this._moorAt(this.docks[0], true);
  }

  _shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  _spawnGroup(d, instant = false) {
    const free = d.spots.filter((s) => !s.used);
    const n = Math.min(free.length, 2 + Math.floor(this.rng() * this.rng() * 6));
    if (n < 2) return null;
    const others = this.docks.filter((o) => o !== d);
    const dest = others[Math.floor(this.rng() * others.length)];
    const grp = { from: d, dest, people: [], born: this.time, boardedAt: 0, bumps: 0, leaving: false };
    for (let k = 0; k < n; k++) {
      const spot = free.splice(Math.floor(this.rng() * free.length), 1)[0];
      spot.used = true;
      const p = this._person(grp);
      grp.people.push(p);
      p.spot = spot;
      const at = this._dockPt(d, spot.u, spot.v);
      p.face = Math.atan2(d.nx, -d.nz) + (this.rng() - 0.5) * 0.8;
      if (instant) { p.x = at.x; p.y = at.y; p.z = at.z; p.h = p.face; p.fade = 1; p.state = 'wait'; }
      else {
        // Down the walkway from the street.
        const start = new THREE.Vector3(d.inland[0] + d.ax * (this.rng() - 0.5) * 6, d.bankY, d.inland[1] + d.az * (this.rng() - 0.5) * 6);
        p.x = start.x; p.y = start.y; p.z = start.z; p.h = Math.atan2(d.nx, -d.nz); p.fade = 0;
        p.state = 'arrive';
        this._walk(p, [start, new THREE.Vector3(d.tx, d.bankY + 0.05, d.tz), this._dockPt(d, RAMP_U, -W / 2 + 0.4), at], 1.3 + this.rng() * 0.3, () => { p.state = 'wait'; }, k * 0.5);
      }
    }
    d.groups.push(grp);
    this.groups.push(grp);
    return grp;
  }

  _person(grp) {
    const i = this.crowd.alloc(COAT[Math.floor(this.rng() * COAT.length)], PANTS[Math.floor(this.rng() * PANTS.length)], HATS[Math.floor(this.rng() * HATS.length)], SKIN[Math.floor(this.rng() * SKIN.length)], this.rng() < 0.75);
    const p = { i, grp, state: 'wait', x: 0, y: 0, z: 0, h: 0, face: 0, phase: this.rng() * 6, fade: 1, fadeTo: 1, path: null, delay: 0, scale: 0.92 + this.rng() * 0.16 };
    this.people.push(p);
    return p;
  }

  _walk(p, pts, speed, done, delay = 0) {
    p.path = pts.map((v) => v.clone());
    p.seg = 0; p.u = 0; p.speed = speed; p.done = done; p.delay = delay;
  }

  // Who has business at this landing: passengers aboard for it, or a group waiting there that fits.
  _dropsAt(d) { return this.aboard.filter((p) => p.grp.dest === d); }
  _pickupsAt(d) { return d.groups.filter((gp) => !gp.leaving); }
  _active(d) { return this._dropsAt(d).length > 0 || this._pickupsAt(d).length > 0; }

  // ------------------------------------------------------------ docking
  // Gangway port on the landing side, in world space; and the ship's pose
  // relative to a landing.
  _alongside(d) {
    const b = this.bm.body, fx = b.fx, fz = b.fz, rx = -fz, rz = fx;
    const dx = d.cx - b.x, dz = d.cz - b.z, sgn = dx * rx + dz * rz > 0 ? 1 : -1;
    const Ax = b.x + fx * -BREAKER.gangZ + rx * sgn * BREAKER.gangX, Az = b.z + fz * -BREAKER.gangZ + rz * sgn * BREAKER.gangX;
    const u = (Ax - d.cx) * d.ax + (Az - d.cz) * d.az, v = (Ax - d.cx) * d.nx + (Az - d.cz) * d.nz;
    return { d, sgn, u, gap: v - W / 2, align: Math.abs(fx * d.ax + fz * d.az), dist: Math.hypot(dx, dz) };
  }

  _checkDock(dt) {
    const b = this.bm.body;
    let best = null;
    for (const d of this.docks) {
      if (Math.hypot(d.cx - b.x, d.cz - b.z) > 120) continue;
      const a = this._alongside(d);
      if (!best || a.dist < best.dist) best = a;
    }
    this.near = best;
    const ok = best && this._active(best.d) && best.gap > -0.5 && best.gap < 4.5 && Math.abs(best.u) < L / 2 - 1.5 && best.align > 0.9 && b.speed < 1.3;
    this.dockT = ok ? this.dockT + dt : 0;
    if (this.dockT > 0.35) this._moorAt(best.d);
  }

  _moorAt(d, instant = false) {
    const b = this.bm.body, a = this._alongside(d);
    // Lines out: she's pulled in square to the landing, the gangway port opposite a clear stretch.
    const along = Math.atan2(d.ax, -d.az), h = Math.cos(along - b.heading) >= 0 ? along : along + Math.PI;
    const u = clamp(a.u, -L / 2 + 2.5, L / 2 - 2.5);
    const fx = Math.sin(h), fz = -Math.cos(h), rx = -fz, rz = fx;
    const A = this._dockPt(d, u, W / 2 + GAP);
    const tx = A.x - fx * -BREAKER.gangZ - rx * a.sgn * BREAKER.gangX, tz = A.z - fz * -BREAKER.gangZ - rz * a.sgn * BREAKER.gangX;
    this.moor = { d, sgn: a.sgn, u, stage: instant ? 'extend' : 'in', t: 0, ext: 0, target: { x: tx, z: tz, h }, off: [], on: [], next: 0, pending: 0, delivered: [] };
    this.dockT = 0;
    if (instant) { b.x = tx; b.z = tz; b.heading = h; }
    else {
      this.g.audio.shipHorn?.(0.6);
      this.g.hud.message(d.name, 'Lines out', 1300, '#bfe6ff');
    }
  }

  // While moored the ship is held: eased onto her berth, then still.
  holdShip(dt) {
    const b = this.bm.body, m = this.moor;
    b.vx = b.vz = b.vF = b.vR = b.yawRate = 0;
    if (m.stage === 'in') {
      const k = damp(2.5, dt), T = m.target;
      b.x += (T.x - b.x) * k; b.z += (T.z - b.z) * k;
      b.heading = wrapAngle(b.heading + wrapAngle(T.h - b.heading) * k);
    }
    b.y = b.level + 0.02 * Math.sin(this.time * 0.8);
    b.pitch *= 0.95; b.roll *= 0.95;
  }

  // Gangway ends: the port on the ship (A, and a step inboard) and the landing (B, and a step in).
  _ends() {
    const m = this.moor, d = m.d, root = this.bm.model.root, s = m.sgn;
    const A = new THREE.Vector3(s * BREAKER.gangX, BREAKER.deckY(BREAKER.gangZ), BREAKER.gangZ).applyMatrix4(root.matrixWorld);
    const Ain = new THREE.Vector3(s * 2.5, BREAKER.deckY(BREAKER.gangZ), BREAKER.gangZ).applyMatrix4(root.matrixWorld);
    const u = (A.x - d.cx) * d.ax + (A.z - d.cz) * d.az;
    return { A, Ain, B: this._dockPt(d, u, W / 2 - 0.45), Bin: this._dockPt(d, u, W / 2 - 1.4), u };
  }

  _updateMoor(dt) {
    const m = this.moor, d = m.d, root = this.bm.model.root;
    m.t += dt;
    if (m.stage === 'in') {
      const b = this.bm.body, T = m.target;
      if ((Math.hypot(T.x - b.x, T.z - b.z) < 0.06 && Math.abs(wrapAngle(T.h - b.heading)) < 0.004) || m.t > 2.2) { m.stage = 'extend'; m.t = 0; }
    } else if (m.stage === 'extend') {
      m.ext = Math.min(1, m.ext + dt / 1.1);
      if (m.ext >= 1) {
        m.stage = 'off'; m.t = 0; m.next = 0;
        m.off = this._dropsAt(d).sort((a, b) => b.slotZ - a.slotZ);   // nearest the gangway first
      }
    } else if (m.stage === 'off') {
      // Off first: from their places on deck, over the gangway and up the bank.
      m.next -= dt;
      if (m.off.length && m.next <= 0) {
        m.next = 0.42;
        const p = m.off.shift(), e = this._ends();
        this._freeSlot(p);
        this.aboard.splice(this.aboard.indexOf(p), 1);
        p.state = 'alight';
        const from = this._worldOf(p);
        p.x = from.x; p.y = from.y; p.z = from.z;
        m.pending++;
        this._walk(p, [from, e.Ain, e.A, e.B, e.Bin, this._dockPt(d, RAMP_U, -W / 2 + 0.4), new THREE.Vector3(d.tx, d.bankY + 0.05, d.tz),
          new THREE.Vector3(d.inland[0] + d.ax * (this.rng() - 0.5) * 8, d.bankY, d.inland[1] + d.az * (this.rng() - 0.5) * 8)], WALK, () => { p.fadeTo = 0; });
        p.onLanding = () => { m.pending--; this._arrived(p, m); };
        p.landAt = 3;   // reaches the landing at the end of segment 3 (A -> B)
      }
      if (!m.off.length && m.pending <= 0) { this._pay(m); m.stage = 'on'; m.t = 0; m.next = 0.3; m.on = this._boarding(d); }
    } else if (m.stage === 'on') {
      // Then on: whole groups, while there's room, to their places on the foredeck.
      m.next -= dt;
      if (m.on.length && m.next <= 0) {
        m.next = 0.42;
        const p = m.on.shift(), e = this._ends();
        this._takeSlot(p);
        // Still coming down the walkway? Then by way of its foot.
        const pre = p.state === 'arrive' ? [this._dockPt(d, RAMP_U, -W / 2 + 0.4)] : [];
        p.state = 'board';
        m.pending++;
        if (p.spot) { p.spot.used = false; p.spot = null; }
        const side = m.sgn;
        this._walk(p, [new THREE.Vector3(p.x, p.y, p.z), ...pre, e.Bin, e.B, e.A, e.Ain], WALK, () => {
          // On deck: the walk to their place goes with the ship.
          const sl = BREAKER.slots[p.slot];
          p.state = 'deckwalk';
          p.dw = { x0: side * 2.5, z0: BREAKER.gangZ, x1: sl[0], z1: sl[1], t: 0 };
          p.dw.len = Math.hypot(p.dw.x1 - p.dw.x0, p.dw.z1 - p.dw.z0) || 0.1;
          m.pending--;
        });
        this.aboard.push(p);
      }
      if (!m.on.length && m.pending <= 0) { m.stage = 'retract'; m.t = 0; }
    } else if (m.stage === 'retract') {
      m.ext = Math.max(0, m.ext - dt / 0.9);
      if (m.ext <= 0) {
        this.moor = null;
        if (!this.started) { this.started = true; this.g.hud.message('All aboard!', 'The shift clock is running', 1600, '#7ee081'); }
        else this.g.hud.message('All aboard!', this._nextHint(), 1500, '#7ee081');
        this.g.audio.shipHorn?.(1.1);
      }
    }
    this._poseGangway();
  }

  // Groups waiting here that fit, in the order they arrived; their places are booked as they board.
  _boarding(d) {
    const out = [];
    let room = CAPACITY - this.aboard.length;
    for (const gp of this._pickupsAt(d).slice()) {
      if (gp.people.length > room) continue;
      room -= gp.people.length;
      gp.boardedAt = this.time;
      gp.allotted = 30 + Math.abs(gp.from.s - gp.dest.s) / 11;
      if (this.started) this.clock += Math.max(15, gp.allotted * 0.55);
      d.groups.splice(d.groups.indexOf(gp), 1);
      this.groups.splice(this.groups.indexOf(gp), 1);
      gp.aboard = true;
      out.push(...gp.people);
    }
    if (!out.length && this._pickupsAt(d).length) this.g.hud.toast('No room aboard', 'Drop some passengers off first', 2000);
    return out;
  }

  _arrived(p, m) {
    const gp = p.grp;
    gp.off = (gp.off || 0) + 1;
    if (gp.off === gp.people.length) m.delivered.push(gp);
  }

  // Fares for the groups that just got off: by river distance, a tip for a quick smooth trip.
  _pay(m) {
    if (!m.delivered.length) return;
    let total = 0, tips = 0, n = 0;
    for (const gp of m.delivered) {
      const k = gp.people.length, km = Math.abs(gp.from.s - gp.dest.s) / 1000;
      const fare = k * (3 + 2.4 * km);
      const spare = clamp((gp.allotted - (this.time - gp.boardedAt)) / gp.allotted, 0, 1);
      const tip = Math.max(0, fare * 0.5 * spare * (1 - 0.3 * gp.bumps));
      total += fare + tip; tips += tip; n += k;
      this.clock += 4 + 2 * k;
    }
    this.money += total;
    this.carried += n;
    this.served++;
    this.g.audio.cash();
    const bumped = m.delivered.some((gp) => gp.bumps);
    this.g.hud.message(`+$${total.toFixed(2)}`, `${n} passenger${n === 1 ? '' : 's'} · ${tips > 0.5 ? `tips $${tips.toFixed(2)}` : bumped ? 'no tip: a rough crossing' : 'no tip: too slow'}`, 2200, '#7ee081');
  }

  _takeSlot(p) {
    let k = this.slots.findIndex((x) => x === null);
    if (k < 0) k = 0;
    this.slots[k] = p;
    p.slot = k;
    p.slotZ = BREAKER.slots[k][1];
    return k;
  }

  _freeSlot(p) { if (p.slot !== undefined && this.slots[p.slot] === p) this.slots[p.slot] = null; }

  _worldOf(p) {
    const s = BREAKER.slots[p.slot];
    return new THREE.Vector3(s[0], BREAKER.deckY(s[1]), s[1]).applyMatrix4(this.bm.model.root.matrixWorld);
  }

  _poseGangway() {
    const g = this.gangway, m = this.moor;
    if (!m || m.ext <= 0.001) { g.visible = false; return; }
    const e = this._ends(), E = e.A.clone().lerp(e.B, m.ext);
    g.visible = true;
    g.position.copy(e.A);
    g.lookAt(E);
    g.scale.set(1, 1, Math.max(0.05, e.A.distanceTo(E)));
  }

  // ------------------------------------------------------------ per frame
  update(dt) {
    this.time += dt;
    const bm = this.bm, b = bm.body;
    if (this.started && !this.over) {
      this.clock -= dt;
      if (this.clock <= 0) { this.clock = 0; this._end(); }
    }
    // Every bump knocks the passengers about (and costs their tip).
    this.bumpT -= dt;
    if (!this.moor && bm.impact > 2.2 && this.aboard.length && this.bumpT <= 0) {
      this.bumpT = 1.2;
      const groups = new Set(this.aboard.map((p) => p.grp));
      for (const gp of groups) gp.bumps++;
      this.g.hud.message('Easy!', 'Your passengers are hanging on', 1200, '#ff6b6b');
    }
    // Groups that wait too long give up and walk off.
    for (const gp of this.groups.slice()) {
      if (gp.leaving || this.time - gp.born < PATIENCE || (this.moor && this.moor.d === gp.from)) continue;
      this._giveUp(gp);
    }
    // More passengers turn up.
    this.spawnT -= dt;
    if (this.spawnT <= 0 && !this.over) {
      this.spawnT = 16 + this.rng() * 14;
      const waiting = this.groups.filter((gp) => !gp.leaving);
      const cand = this.docks.filter((d) => d.groups.length < 2 && !(this.moor && this.moor.d === d));
      if (waiting.length < 4 && cand.length) this._spawnGroup(cand[Math.floor(this.rng() * cand.length)]);
    }
    if (this.moor) this._updateMoor(dt);
    else if (!this.over) this._checkDock(dt);
    this._updatePeople(dt);
    this._updateDocks();
    this.lampMat.emissiveIntensity = this.g.sky.nightAmount > 0.3 ? 2.5 : 0;
  }

  _giveUp(gp) {
    gp.leaving = true;
    const d = gp.from;
    d.groups.splice(d.groups.indexOf(gp), 1);
    this.groups.splice(this.groups.indexOf(gp), 1);
    for (const p of gp.people) {
      if (p.spot) { p.spot.used = false; p.spot = null; }
      p.state = 'leave';
      this._walk(p, [new THREE.Vector3(p.x, p.y, p.z), this._dockPt(d, RAMP_U, -W / 2 + 0.4), new THREE.Vector3(d.tx, d.bankY + 0.05, d.tz), new THREE.Vector3(d.inland[0], d.bankY, d.inland[1])], 1.3, () => { p.fadeTo = 0; }, this.rng() * 1.5);
    }
    this.g.hud.toast(`${gp.people.length} gave up waiting at ${d.name}`, 'Ferry', 2400);
  }

  _updatePeople(dt) {
    const root = this.bm.model.root, ship = this.bm.body, v = this._v;
    for (const p of this.people.slice()) {
      let moving = false;
      if (p.state === 'deckwalk') {
        const w = p.dw;
        w.t = Math.min(1, w.t + (WALK * dt) / w.len);
        const lx = w.x0 + (w.x1 - w.x0) * w.t, lz = w.z0 + (w.z1 - w.z0) * w.t;
        v.set(lx, BREAKER.deckY(lz), lz).applyMatrix4(root.matrixWorld);
        p.x = v.x; p.y = v.y; p.z = v.z;
        p.h = wrapAngle(ship.heading + Math.atan2(w.x1 - w.x0, -(w.z1 - w.z0)));
        moving = true;
        p.speed = WALK;
        if (w.t >= 1) { p.state = 'aboard'; p.lh = (this.rng() - 0.5) * 1.2 + (this.rng() < 0.25 ? (Math.PI / 2) * (w.x0 > 0 ? 1 : -1) : 0); }
      } else if (p.state === 'aboard') {
        const s = BREAKER.slots[p.slot];
        v.set(s[0], BREAKER.deckY(s[1]), s[1]).applyMatrix4(root.matrixWorld);
        p.x = v.x; p.y = v.y; p.z = v.z;
        p.h = ship.heading + p.lh;
      } else if (p.path) {
        if (p.delay > 0) p.delay -= dt;
        else {
          let left = p.speed * dt;
          while (left > 0 && p.path) {
            const a = p.path[p.seg], c = p.path[p.seg + 1];
            const len = Math.hypot(c.x - a.x, c.z - a.z) || 1e-3;
            if (p.u + left < len) { p.u += left; left = 0; }
            else {
              left -= len - p.u; p.u = 0; p.seg++;
              if (p.landAt === p.seg) { p.landAt = -1; p.onLanding?.(); }
              if (p.deckAt === p.seg) { p.deckAt = -1; p.onDeck?.(); }
              if (p.seg >= p.path.length - 1) { const done = p.done; p.path = null; done?.(); }
            }
          }
          if (p.path) {
            const a = p.path[p.seg], c = p.path[p.seg + 1], len = Math.hypot(c.x - a.x, c.z - a.z) || 1e-3, t = p.u / len;
            p.x = a.x + (c.x - a.x) * t; p.y = a.y + (c.y - a.y) * t; p.z = a.z + (c.z - a.z) * t;
            const want = Math.atan2(c.x - a.x, -(c.z - a.z));
            p.h = wrapAngle(p.h + wrapAngle(want - p.h) * damp(8, dt));
            moving = true;
          }
        }
      } else if (p.state === 'wait') p.h = wrapAngle(p.h + wrapAngle(p.face - p.h) * damp(2, dt));
      if (moving) p.phase += dt * p.speed * 5.2;
      p.fade += clamp(p.fadeTo - p.fade, -dt * 1.6, dt * 1.6);
      if (p.fadeTo === 0 && p.fade <= 0) {
        this.crowd.release(p.i);
        this.people.splice(this.people.indexOf(p), 1);
        continue;
      }
      const swing = moving ? Math.sin(p.phase) * 0.55 : 0;
      const bob = moving ? Math.abs(Math.cos(p.phase)) * 0.04 : 0.006 * Math.sin(this.time * 1.3 + p.i);
      this.crowd.pose(p.i, p.x, p.y, p.z, p.h, swing, bob, p.scale * Math.min(1, p.fade * 1.4));
    }
    this.crowd.flush();
  }

  _updateDocks() {
    const cam = this.g.camera.position;
    for (const d of this.docks) {
      const drops = this._dropsAt(d).length, picks = this._pickupsAt(d).reduce((n, gp) => n + gp.people.length, 0);
      const active = !this.over && !!(drops || picks);   // a boolean: three.js only hides visible === false
      const color = drops && picks ? 0x5ce1e6 : drops ? 0x5ac8ff : 0x4dff88;
      d.beam.visible = active && !(this.moor && this.moor.d === d);
      d.berth.visible = d.beam.visible;
      if (active) { d.beam.material.uniforms.uColor.value.setHex(color); d.berth.material.color.setHex(color); }
      d.beam.material.uniforms.uTime.value = this.time;
      const lines = [];
      if (picks) for (const gp of this._pickupsAt(d)) lines.push(`${gp.people.length} for ${gp.dest.name}`);
      if (drops) lines.unshift(`Drop off ${drops}`);
      const text = `${d.name}|${lines.slice(0, 3).join('|')}`;
      if (text !== d.labelText) { d.labelText = text; drawLabel(d.label, d.name, lines.slice(0, 3), color, active); }
      // Labels read from a distance; up close (alongside) they'd fill the view.
      const dist = d.label.position.distanceTo(cam);
      d.label.visible = dist > 32 && dist < 900 && !(this.moor && this.moor.d === d);
    }
  }

  _nextHint() {
    const t = this._target();
    return t ? `${t.label}` : 'Waiting for passengers';
  }

  // The nearest landing with something to do.
  _target() {
    const b = this.bm.body;
    let best = null;
    for (const d of this.docks) {
      if (!this._active(d)) continue;
      const dist = Math.hypot(d.cx - b.x, d.cz - b.z);
      if (best && best.dist <= dist) continue;
      const drops = this._dropsAt(d).length, picks = this._pickupsAt(d).reduce((n, gp) => n + gp.people.length, 0);
      best = { d, dist, label: drops ? `Drop ${drops} at ${d.name}` : `Pick up ${picks} at ${d.name}` };
    }
    return best;
  }

  _end() {
    if (this.over) return;
    this.over = true;
    const prev = this.best[this.route.id] ?? null;
    const record = this.money > (prev ?? 0);
    if (record) { this.best[this.route.id] = this.money; saveJSON('rb.ferryBest', this.best); }
    this.g.audio.fail();
    this.g.hud.message('Shift over', `$${this.money.toFixed(2)} · ${this.carried} passengers`, 2500, '#ff6b6b');
    const bm = this.bm, me = this;
    setTimeout(() => {
      if (bm.ferry === me && bm.active) this.g.showResults({ ferry: true, routeId: this.route.id, title: `Icebreaker Ferry · ${this.route.name}`, money: this.money, carried: this.carried, stops: this.served, record, prev });
    }, 2000);
  }

  // ------------------------------------------------------------ HUD
  hud(metric) {
    const hud = this.g.hud, b = this.bm.body, m = this.moor;
    let sub;
    if (this.over) sub = 'Shift over';
    else if (m) {
      const offN = this._dropsAt(m.d).length, onN = m.on.length;
      sub = m.stage === 'in' ? `Mooring at ${m.d.name}` : m.stage === 'off' ? `${m.d.name} · passengers getting off` : m.stage === 'on' || (m.stage === 'extend' && !offN) ? `${m.d.name} · boarding${onN ? ` (${onN} to go)` : ''}` : m.stage === 'retract' ? 'Casting off' : `${m.d.name} · gangway out`;
    } else {
      const n = this.near, t = this._target();
      if (n && n.dist < 80 && this._active(n.d)) {
        sub = n.align < 0.9 ? `Line up alongside ${n.d.name}` : Math.abs(n.u) > L / 2 - 1.5 ? `Bring the gangway (just ahead of the deckhouse) beside the landing` : n.gap > 4.5 ? `Closer in to ${n.d.name} · ${Math.round(n.gap)} m` : b.speed > 1.3 ? `Slow down to dock · ${Math.round(b.speed * (metric ? 3.6 : 2.237))} ${metric ? 'km/h' : 'mph'}` : 'Hold her steady...';
      } else sub = t ? `${t.label} · ${formatDistance(t.dist, metric)}` : 'Waiting for passengers';
    }
    const by = new Map();
    for (const p of this.aboard) by.set(p.grp.dest.name, (by.get(p.grp.dest.name) || 0) + 1);
    const aboard = [...by].map(([k, n]) => `${n} for ${esc(k)}`).join(', ');
    const waiting = this.docks.map((d) => [d.name, this._pickupsAt(d).reduce((n, gp) => n + gp.people.length, 0)]).filter(([, n]) => n).map(([k, n]) => `${esc(k)} ${n}`).join(' &middot; ');
    hud.setMission({
      title: `Icebreaker Ferry · ${this.route.name}`, sub, time: formatTime(this.clock), urgent: this.started && this.clock < 20,
      extra: `<b>Aboard ${this.aboard.length}/${CAPACITY}</b>${aboard ? ': ' + aboard : ''}${waiting ? `<br>Waiting: ${waiting}` : ''}` +
        `<br>W ahead · S astern · A D helm · H horn · stop alongside a <b style="color:#4dff88">green</b> (pick up) or <b style="color:#5ac8ff">blue</b> (drop off) landing`,
    });
    const best = this.best[this.route.id];
    hud.setScore(`<div class="small">Passengers ${this.carried}</div><div class="big">$${this.money.toFixed(2)}</div><div class="small">${best ? 'Best $' + best.toFixed(2) : 'Stops ' + this.served}</div>`);
    hud.setStreet('Charles River', this.moor ? this.moor.d.name : this.near && this.near.dist < 150 ? this.near.d.name : this.route.name);
  }

  overlays() {
    const markers = this.docks.map((d) => {
      const drops = this._dropsAt(d).length, picks = this._pickupsAt(d).reduce((n, gp) => n + gp.people.length, 0);
      const color = drops && picks ? '#5ce1e6' : drops ? '#5ac8ff' : picks ? '#4dff88' : '#8a94a6';
      return { x: d.cx, z: d.cz, r: drops || picks ? 8 : 5, color, label: drops || picks ? String(drops || picks) : '', edge: !!(drops || picks) };
    });
    return { markers };
  }

  // Swing the chase camera round to the landing side while people board.
  aimCamera(cam, dt) {
    const m = this.moor;
    if (!m || m.stage === 'in' || cam.mode > 1) return;
    const want = -m.sgn * 1.05, look = cam.look;
    look.yaw += wrapAngle(want - look.yaw) * damp(1.6, dt);
    look.pitch += (-0.12 - look.pitch) * damp(1.6, dt);
    look.idle = 0;
  }

  dispose() {
    this.root.parent?.remove(this.root);
    this.bm.env.obstacles = null;
    this.g.boats.raceRange = null;
    this.crowd.dispose();
    this.root.traverse((o) => {
      if (!o.isMesh && !o.isSprite) return;
      if (o.geometry && !o.isInstancedMesh && !o.isSprite) o.geometry.dispose();   // sprites share one geometry
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m && m.map) m.map.dispose(); if (m && !o.isInstancedMesh) m.dispose(); }
    });
  }
}

// ================================================================ landings
// A floating landing a couple of metres off the bank near (lat, lon), on the
// waterway P within the icebreaker reach `zone`: with room for the ship
// alongside, and a walkway up to dry ground. null if there's no room.
export function placeLanding(g, P, zone, name, lat, lon, maxBank = 650) {
  const cw = g.collision, T = g.map.terrain, [z0, z1] = zone, m = g.map.meta;
  const x = (lon - m.origin.lon) * m.metersPerDegree.lon, z = -(lat - m.origin.lat) * m.metersPerDegree.lat, pr = P.project(x, z, null, {});
  const side = pr.d >= 0 ? 1 : -1;
  const probe = new BoatBody('icebreaker'), env = { cw, ice: null };
  for (const ds of [0, 12, -12, 24, -24, 36, -36, 50, -50, 70, -70, 95, -95, 125, -125]) {
    const s = pr.s + ds;
    if (s < z0 + 30 || s > z1 - 30) continue;
    const c = P.at(s, 0, {}), bx = -c.tz * side, bz = c.tx * side;
    let bank = 0;
    for (let d = 4; d < maxBank; d += 0.5) if (!cw.isWaterSurface(c.x + bx * d, c.z + bz * d)) { bank = d; break; }
    if (bank < 25) continue;
    const ax = c.tx, az = c.tz, nx = -bx, nz = -bz;
    const mid = bank - 2.5 - W / 2, cx = c.x + bx * mid, cz = c.z + bz * mid;
    const at = (u, v) => [cx + ax * u + nx * v, cz + az * u + nz * v];
    if ([[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1], [-0.5, 0], [0.5, 0]].some(([u, v]) => !cw.isWaterSurface(...at((u * L) / 2, (v * W) / 2)))) continue;
    const level = T.h(cx, cz);
    probe.level = level;
    // Room for the ship alongside, and to pull in and out.
    const sv = W / 2 + GAP + BREAKER.gangX, h = Math.atan2(ax, -az);
    if (!probe.fits(env, ...at(0, sv), h) || !probe.fits(env, ...at(0, sv + 8), h)) continue;
    // The walkway ashore, from the landing's inner edge to dry ground.
    const [ix, iz] = at(RAMP_U, -W / 2);
    let land = 0;
    for (let d = 0.5; d < 14; d += 0.5) if (!cw.isWaterSurface(ix - nx * d, iz - nz * d)) { land = d; break; }
    if (!land) continue;
    const tx = ix - nx * (land + 1.5), tz = iz - nz * (land + 1.5);
    const y = level + TOP, bankY = Math.max(y + 0.2, T.h(tx, tz));
    const spots = [];
    for (let u = -5.6; u <= 5.2 + 1e-6; u += 1.2) for (const v of [-1.25, -0.35]) spots.push({ u: u + (v > -1 ? 0.6 : 0), v, used: false });
    return {
      name, s, side, cx, cz, ax, az, nx, nz, level, y, tx, tz, bankY, ix, iz,
      inland: [tx - nx * 8, tz - nz * 8],
      spots, groups: [],
      obstacle: { cx, cz, ax, az, nx, nz, hl: L / 2, hw: W / 2 },
    };
  }
  console.warn(`ferry: no room for a landing at ${name}`);
  return null;
}

export function dockPt(d, u, v, y = d.y) { return new THREE.Vector3(d.cx + d.ax * u + d.nx * v, y, d.cz + d.az * u + d.nz * v); }

// Pontoons, shelters, walkways, lamps and name boards for these landings;
// each also gets a beam, a berth outline and a label (hidden).
export function buildLandings(docks, root, title = 'ICEBREAKER FERRY') {
  const parts = [], lamps = [], M = new THREE.Matrix4(), up = new THREE.Vector3(0, 1, 0);
  // A box with its x along the landing (a) and z across it, centred at dock-local (u, y, v).
  const ob = (d, u, y, v, sx, sy, sz, hex) => {
    const a = new THREE.Vector3(d.ax, 0, d.az), zA = new THREE.Vector3().crossVectors(a, up);
    M.makeBasis(a, up, zA).setPosition(d.cx + d.ax * u + d.nx * v, y, d.cz + d.az * u + d.nz * v);
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.applyMatrix4(M);
    return colorize(g, hex);
  };
  const slab = (a, b, width, thick, hex) => {
    const len = a.distanceTo(b), g = new THREE.BoxGeometry(width, thick, len);
    M.lookAt(a, b, up).setPosition((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    g.applyMatrix4(M);
    return colorize(g, hex);
  };
  const signGeo = [];
  for (const d of docks) {
    const y0 = d.level;
    parts.push(ob(d, 0, y0 + 0.05, 0, L, 0.6, W, 0x8b6b4a));                           // pontoon
    parts.push(ob(d, 0, y0 + TOP + 0.04, W / 2 - 0.15, L, 0.1, 0.3, 0x5a4532));         // edge timber
    for (let u = -L / 2 + 1.5; u <= L / 2 - 1.5; u += 3) parts.push(ob(d, u, y0 + 0.05, W / 2 + 0.12, 0.6, 0.5, 0.25, 0x18191b)); // fenders
    for (const u of [-L / 2 + 1, -4, 4, L / 2 - 1]) parts.push(colorize(new THREE.CylinderGeometry(0.14, 0.17, 0.35, 8).translate(...dockPt(d, u, W / 2 - 0.4, y0 + TOP + 0.17).toArray()), 0x3a3d40));
    // Shelter with a bench.
    for (const [u, v] of [[-10.6, -1.75], [-10.6, -0.55], [-6.8, -1.75], [-6.8, -0.55]]) parts.push(ob(d, u, y0 + TOP + 1.15, v, 0.1, 2.3, 0.1, 0x4a4f54));
    parts.push(ob(d, -8.7, y0 + TOP + 2.35, -1.15, 4.4, 0.12, 1.7, 0x2f5f8a));
    parts.push(ob(d, -8.7, y0 + TOP + 0.24, -1.6, 3.2, 0.08, 0.45, 0x7a5a3c), ob(d, -8.7, y0 + TOP + 0.12, -1.6, 3.0, 0.24, 0.08, 0x4a4f54));
    // Walkway ashore with handrails.
    const foot = dockPt(d, RAMP_U, -W / 2 + 0.3, y0 + TOP), top = new THREE.Vector3(d.tx, d.bankY + 0.05, d.tz);
    parts.push(slab(foot, top, 2.0, 0.14, 0x8b6b4a));
    const ac = new THREE.Vector3(d.ax, 0, d.az);
    for (const sd of [-1, 1]) parts.push(slab(foot.clone().addScaledVector(ac, sd * 1.0).setY(foot.y + 1.0), top.clone().addScaledVector(ac, sd * 1.0).setY(top.y + 1.0), 0.05, 0.05, 0xd8dade));
    // A paved pad at the top, the sign and a lamp.
    parts.push(colorize(new THREE.BoxGeometry(4, 0.3, 4).applyMatrix4(M.makeRotationY(Math.atan2(d.ax, d.az))).translate(d.tx - d.nx * 1.5, d.bankY - 0.1, d.tz - d.nz * 1.5), 0x9a968c));
    const sp = top.clone().addScaledVector(ac, 2.2).addScaledVector(new THREE.Vector3(d.nx, 0, d.nz), -1.2), lp = top.clone().addScaledVector(ac, -2.2).addScaledVector(new THREE.Vector3(d.nx, 0, d.nz), -1.2);
    parts.push(colorize(new THREE.BoxGeometry(0.12, 3.2, 0.12).translate(sp.x, sp.y + 1.6, sp.z), 0x3a3d40));
    parts.push(colorize(new THREE.BoxGeometry(0.12, 4.2, 0.12).translate(lp.x, lp.y + 2.1, lp.z), 0x3a3d40));
    lamps.push(colorize(new THREE.BoxGeometry(0.45, 0.25, 0.45).translate(lp.x, lp.y + 4.3, lp.z), 0xfff1d0));
    d.signAt = sp;
    // Status: a light beam, the berth marked on the water, a floating label.
    d.beam = makeBeam();
    d.beam.position.copy(dockPt(d, 0, W / 2 + 4.5, d.level));
    d.berth = makeBerth(d);
    d.label = makeLabel();
    d.label.position.copy(dockPt(d, 0, 0, d.y + 7.5));
    d.sign = makeSign(d, ac, title);
    root.add(d.beam, d.berth, d.label, d.sign);
    d.labelText = '';
  }
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  const mesh = new THREE.Mesh(merge(parts), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const lampMat = new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffe6b0, emissiveIntensity: 0 });
  root.add(mesh, new THREE.Mesh(merge(lamps), lampMat));
  return { mesh, lampMat };
}

function dist1(s, z) { return s < z[0] ? z[0] - s : s > z[1] ? s - z[1] : 0; }

// ================================================================ people
// Everyone on the landings and the ship: instanced coats, heads, hats, arms
// and legs, posed each frame (legs and arms swing as they walk).
export class Crowd {
  constructor(parent, n) {
    this.n = n;
    const mat = () => new THREE.MeshStandardMaterial({ roughness: 0.85 });
    const legG = new THREE.BoxGeometry(0.16, 0.84, 0.18).translate(0, -0.42, 0);
    const armG = new THREE.BoxGeometry(0.11, 0.6, 0.12).translate(0, -0.3, 0);
    this.torso = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.64, 0.28), mat(), n);
    this.head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.125, 10, 8), mat(), n);
    this.hat = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.115, 0.13, 0.13, 10), mat(), n);
    this.legs = new THREE.InstancedMesh(legG, mat(), n * 2);
    this.arms = new THREE.InstancedMesh(armG, mat(), n * 2);
    this.all = [this.torso, this.head, this.hat, this.legs, this.arms];
    const zero = new THREE.Matrix4().makeScale(0, 0, 0), white = new THREE.Color(1, 1, 1);
    for (const m of this.all) {
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < m.count; i++) { m.setMatrixAt(i, zero); m.setColorAt(i, white); }
      parent.add(m);
    }
    this.torso.castShadow = this.legs.castShadow = true;
    this.free = [];
    for (let i = n - 1; i >= 0; i--) this.free.push(i);
    this._r = new THREE.Matrix4(); this._l = new THREE.Matrix4(); this._o = new THREE.Matrix4(); this._s = new THREE.Vector3();
    this._zero = zero; this._c = new THREE.Color();
  }

  alloc(coat, pants, hat, skin, hasHat) {
    const i = this.free.pop();
    if (i === undefined) return -1;
    const c = this._c;
    this.torso.setColorAt(i, c.setHex(coat));
    this.arms.setColorAt(2 * i, c); this.arms.setColorAt(2 * i + 1, c);
    this.legs.setColorAt(2 * i, c.setHex(pants)); this.legs.setColorAt(2 * i + 1, c);
    this.hat.setColorAt(i, c.setHex(hasHat ? hat : skin));
    this.head.setColorAt(i, c.setHex(skin));
    this.hasHat = this.hasHat || [];
    this.hasHat[i] = hasHat;
    for (const m of this.all) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    return i;
  }

  release(i) {
    if (i < 0) return;
    for (const m of [this.torso, this.head, this.hat]) m.setMatrixAt(i, this._zero);
    for (const m of [this.legs, this.arms]) { m.setMatrixAt(2 * i, this._zero); m.setMatrixAt(2 * i + 1, this._zero); }
    this.free.push(i);
  }

  // A person standing at (x, y, z) facing compass heading h (models face -z).
  // arms: optional [left, right] swing angles of their own (waving: about pi).
  pose(i, x, y, z, h, swing, bob, scale, arms = null) {
    if (i < 0) return;
    const R = this._r, Lm = this._l, O = this._o;
    R.makeRotationY(-h).scale(this._s.set(scale, scale, scale)).setPosition(x, y, z);
    const part = (mesh, k, lx, ly, lz, rx) => {
      Lm.makeRotationX(rx);
      Lm.setPosition(lx, ly, lz);
      O.multiplyMatrices(R, Lm);
      mesh.setMatrixAt(k, O);
    };
    part(this.torso, i, 0, 1.13 + bob, 0, 0);
    part(this.head, i, 0, 1.6 + bob, 0, 0);
    if (this.hasHat && this.hasHat[i]) part(this.hat, i, 0, 1.72 + bob, 0, 0);
    else this.hat.setMatrixAt(i, this._zero);
    part(this.legs, 2 * i, -0.11, 0.84, 0, swing);
    part(this.legs, 2 * i + 1, 0.11, 0.84, 0, -swing);
    part(this.arms, 2 * i, -0.3, 1.4 + bob, 0, arms ? arms[0] : -swing * 0.8);
    part(this.arms, 2 * i + 1, 0.3, 1.4 + bob, 0, arms ? arms[1] : swing * 0.8);
  }

  flush() { for (const m of this.all) m.instanceMatrix.needsUpdate = true; }

  dispose() { for (const m of this.all) { m.geometry.dispose(); m.material.dispose(); m.dispose(); } }
}

// ================================================================ props
function colorize(g, hex) {
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[3 * i] = c.r; a[3 * i + 1] = c.g; a[3 * i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function merge(parts) {
  const geos = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3); nrm.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

// The gangway: a metal plank with handrails along +z, scaled to length.
export function makeGangway() {
  const g = new THREE.Group(), mat = new THREE.MeshStandardMaterial({ color: 0x9aa1a6, roughness: 0.5, metalness: 0.4 });
  const plank = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.07, 1).translate(0, 0, 0.5), mat);
  plank.castShadow = true;
  g.add(plank);
  for (const x of [-0.56, 0.56]) g.add(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 1).translate(x, 0.95, 0.5), mat), new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 1).translate(x, 0.5, 0.5), mat));
  g.visible = false;
  return g;
}

// A column of light over a landing with business (as for race checkpoints).
export function makeBeam() {
  const geo = new THREE.CylinderGeometry(4, 4, 40, 40, 1, true).translate(0, 20, 0);
  const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0x4dff88) }, uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; varying float vEdge;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal); vEdge = 1.0 - abs(dot(n, normalize(-mv.xyz)));
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uTime; varying vec2 vUv; varying float vEdge;
      void main(){ float fade = pow(max(1.0 - vUv.y, 0.0), 1.6); float edge = pow(max(vEdge, 0.0), 2.5);
        float bands = 0.75 + 0.25 * sin(vUv.y * 50.0 - uTime * 4.0);
        gl_FragColor = vec4(uColor * 1.3, fade * (0.06 + 0.8 * edge) * bands); }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
  }));
  m.renderOrder = 10;
  m.visible = false;
  return m;
}

// The berth alongside a landing, outlined on the water.
function makeBerth(d) {
  const v0 = W / 2 + 0.4, v1 = v0 + 7.2 + 1.4, u0 = -L / 2 - 1, u1 = L / 2 + 1, t = 0.35;
  const quads = [[u0, v0, u1, v0 + t], [u0, v1 - t, u1, v1], [u0, v0, u0 + t, v1], [u1 - t, v0, u1, v1]];
  const pos = [];
  for (const [a, b, c, e] of quads) {
    const P = (u, v) => { const p = dockPt(d, u, v, d.level + 0.07); return [p.x, p.y, p.z]; };
    pos.push(...P(a, b), ...P(c, b), ...P(c, e), ...P(a, b), ...P(c, e), ...P(a, e));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x4dff88, transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  m.renderOrder = -29;
  m.visible = false;
  return m;
}

// Floating label over a landing: its name and who is waiting / getting off.
export function makeLabel() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 192;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  s.scale.set(13, 4.9, 1);
  s.renderOrder = 11;
  s.userData.canvas = cv;
  return s;
}

export function drawLabel(sprite, name, lines, color, active) {
  const cv = sprite.userData.canvas, ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const h = 60 + lines.length * 40;
  ctx.fillStyle = 'rgba(11, 18, 32, 0.78)';
  roundRect(ctx, 6, cv.height - h - 6, cv.width - 12, h, 18);
  ctx.fill();
  ctx.fillStyle = active ? '#' + color.toString(16).padStart(6, '0') : '#c7cfdd';
  ctx.font = '800 38px Inter, Segoe UI, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(name.toUpperCase(), cv.width / 2, cv.height - h + 26, cv.width - 30);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 31px Inter, Segoe UI, sans-serif';
  lines.forEach((l, k) => ctx.fillText(l, cv.width / 2, cv.height - h + 70 + k * 40, cv.width - 30));
  sprite.material.map.needsUpdate = true;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// The landing's name board on its post, readable from the river and the bank.
function makeSign(d, ac, title = 'ICEBREAKER FERRY') {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 160;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#12355b'; ctx.fillRect(0, 0, 512, 160);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(8, 8, 496, 4); ctx.fillRect(8, 148, 496, 4);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '700 30px Inter, Segoe UI, sans-serif';
  ctx.fillText(title, 256, 42);
  ctx.font = '800 44px Inter, Segoe UI, sans-serif';
  ctx.fillText(d.name, 256, 104, 480);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  // Two faces back to back, each reading the right way round.
  const g = new THREE.PlaneGeometry(2.8, 0.88), back = g.clone().rotateY(Math.PI);
  const both = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = g.attributes[name], b = back.attributes[name];
    const arr = new Float32Array(a.array.length * 2);
    arr.set(a.array); arr.set(b.array, a.array.length);
    both.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  const idx = Array.from(g.index.array);
  both.setIndex([...idx, ...idx.map((i) => i + g.attributes.position.count)]);
  const m = new THREE.Mesh(both, new THREE.MeshBasicMaterial({ map: tex }));
  m.position.set(d.signAt.x, d.signAt.y + 2.75, d.signAt.z);
  m.rotation.y = Math.atan2(d.nx, d.nz);
  return m;
}
