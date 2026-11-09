// On the water: take a boat (motorboat, rowboat, single scull, eight or the
// icebreaker) out on the Charles or the harbour, from a dock or straight from
// the car (E near the water; E near the bank to go ashore); race the Head of
// the Charles: three miles upstream from the BU boathouse to past the Eliot
// Bridge, crews starting one after another, timed bridge to bridge; or work a
// shift on the Icebreaker Ferry (ferry.js).

import * as THREE from 'three';
import { BoatBody, BOAT_TYPES, buildBoat, poseBoat, placeBoat, disposeBoat, PLAYER_CLUB, CLUBS } from './boats.js';
import { ChaseCamera } from './camera.js';
import { SURF } from './collision.js';
import { clamp, formatTime, formatDistance, loadJSON, saveJSON, mulberry32 } from './util.js';
import { esc } from './hud.js';
import { FerryShift, FERRY_ROUTES } from './ferry.js';

const STEP = 1 / 150;
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false, horn: false, lookBack: false };
export const BOAT_CAMERAS = ['Chase', 'Far chase', 'Helm', 'Overhead'];

// Course of the Head of the Charles (lat, lon). The start is just below the
// BU DeWolfe Boathouse; the finish is three miles up, past the Eliot Bridge.
const HOCR = {
  start: [42.35325, -71.10777],
  marks: [
    ['Boston University Bridge', 42.35239, -71.11066],
    ['River Street Bridge', 42.36123, -71.11677],
    ['Western Avenue Bridge', 42.36425, -71.11693],
    ['Weeks Footbridge', 42.36848, -71.11814],
    ['Anderson Memorial Bridge', 42.36897, -71.1232],
    ['Eliot Bridge', 42.37173, -71.13293],
  ],
  length: 4828,
};
export const REGATTAS = [
  { id: 'hoc-eight', boat: 'eight', name: 'Head of the Charles', event: 'Championship Eights', blurb: 'Eight rowers and a cox, three miles upstream under six bridges.' },
  { id: 'hoc-single', boat: 'single', name: 'Head of the Charles', event: 'Championship Singles', blurb: 'Just you and two oars against the clock.' },
];
const INTERVAL = 12;      // s between crews at the start
const YOU = 5;            // your place in the start order (bow 6 of 10)
const LINE_T = 7;         // about when you cross the start line after GO
const BUOY_PENALTY = 5;

// Where boats are launched from the menu: (lat, lon, direction +1 downstream / -1 up).
const LAUNCH = {
  motor: [42.3596, -71.0728, 1, 'Community Boating, the Esplanade'],
  dinghy: [42.3575, -71.0772, -1, 'the Charles River Basin'],
  single: [42.35325, -71.10777, -1, 'the BU boathouse'],
  eight: [42.35325, -71.10777, -1, 'the BU boathouse'],
  icebreaker: [42.3570, -71.0830, 1, 'the Esplanade'],
};

export class BoatMode {
  constructor(game) {
    this.g = game;
    this.active = false;
    this.body = null;
    this.model = null;
    this.race = null;
    this.camera = new ChaseCamera(game.camera);
    this.best = loadJSON('rb.regatta', {});
    this.path = game.boats.path;
    this.env = { cw: game.collision, ice: game.ice, time: 0 };
    this.course = this.path ? this._course() : null;
    this.acc = 0;
    this.props = null;
    this._pr = {};
    this.locTimer = 0;
  }

  _xz(lat, lon) {
    const m = this.g.map.meta;
    return [(lon - m.origin.lon) * m.metersPerDegree.lon, -(lat - m.origin.lat) * m.metersPerDegree.lat];
  }

  _course() {
    const P = this.path, pr = {};
    const [sx, sz] = this._xz(...HOCR.start);
    const start = Math.min(P.length - 60, P.project(sx, sz, null, pr).s + 30);
    const finish = Math.max(40, start - HOCR.length);
    const marks = HOCR.marks.map(([name, lat, lon]) => {
      const [x, z] = this._xz(lat, lon);
      return { name, s: P.project(x, z, null, pr).s };
    }).filter((m) => m.s < start - 20 && m.s > finish + 20).sort((a, b) => b.s - a.s);
    marks.push({ name: 'Finish', s: finish, finish: true });
    return { start, finish, length: start - finish, marks };
  }

  get available() { return !!this.course; }

  // ------------------------------------------------------------ start/stop
  // opts: { type, race: regatta id, ferry: ferry route id, at: { x, z, heading } }
  start({ type = 'motor', race = null, ferry = null, at = null } = {}) {
    if (!this.path) return false;
    const g = this.g;
    this.stop();
    const def = race ? REGATTAS.find((r) => r.id === race) : null;
    if (def) type = def.boat;
    const route = ferry ? FERRY_ROUTES.find((r) => r.id === ferry) : null;
    if (route) type = 'icebreaker';
    this.type = type;
    const body = (this.body = new BoatBody(type));
    this.model = buildBoat(type, PLAYER_CLUB, type === 'motor' ? 0xc8102e : 0xf4f1e8);
    body.model = this.model;
    body.wakeAcc = 0;
    g.scene.add(this.model.root);
    g.boats.playerBody = body;
    let x, z, h;
    if (route) {
      this.ferry = new FerryShift(this, route);
      if (!this.ferry.ok) { this.ferry.dispose(); this.ferry = null; disposeBoat(this.model); this.model = this.body = null; g.boats.playerBody = null; return false; }
      ({ x, z, h } = this.ferry.startPose());
    } else if (def) {
      const p = this.path.at(this.course.start + 40, 0, {});
      x = p.x; z = p.z; h = Math.atan2(-p.tx, p.tz);
    } else if (at) ({ x, z, heading: h } = at);
    else {
      const [lat, lon, dir] = LAUNCH[type];
      const [lx, lz] = this._xz(lat, lon);
      const pr = this.path.project(lx, lz, null, {});
      const q = this.path.at(pr.s, 0, {});
      const p = this.path.at(pr.s, clamp(pr.d, -Math.max(0, q.left - 25), Math.max(0, q.right - 25)), {});
      x = p.x; z = p.z; h = Math.atan2(p.tx * dir, -p.tz * dir);
    }
    // On a frozen river, launch into open water: an icebreaker's channel
    // (or a lead cut from the dock). The icebreaker makes its own way.
    if (!def && !BOAT_TYPES[type].breaker && g.ice.level > 0.3) {
      const pr = this.path.project(x, z, null, {});
      const ib = g.boats.list.filter((o) => o.type === 'icebreaker').sort((a, c) => Math.abs(a.s - pr.s) - Math.abs(c.s - pr.s))[0];
      if (!at && ib) {
        const p = this.path.at(ib.s - ib.dir * 45, ib.d, {});
        x = p.x; z = p.z; h = ib.heading;
      } else if (pr.dist < 400) {
        for (let ds = -160; ds <= 160; ds += 6) { const p = this.path.at(pr.s + ds, pr.d * 0.5, {}); g.ice.breakAt(p.x, p.z, 14, 0); }
        g.ice.breakAt(x, z, 14, 0);
      }
    }
    if (!route) ({ x, z, h } = this._settle(x, z, h));
    body.reset(x, z, h, g.map.terrain.h(x, z));
    this.active = true;
    this.acc = 0;
    this.camera.mode = 0;
    this.camera.snap();
    this.camera.resetLook();
    this.frozenIn = 0;
    if (def) this._startRace(def);
    placeBoat(this.model, body);
    this.model.root.updateMatrixWorld(true);
    if (this.ferry) this.ferry.begin();
    return true;
  }

  stop() {
    if (!this.body) return;
    const g = this.g;
    if (this.race) { g.boats.clearRole('race'); g.boats.ambient = true; g.boats.raceRange = null; }
    this.env.clearCourse = false;
    this.race = null;
    if (this.ferry) { this.ferry.dispose(); this.ferry = null; }
    g.audio.setDiesel?.(0);
    disposeBoat(this.model);
    this.model = null;
    this.body = null;
    g.boats.playerBody = null;
    this.active = false;
    if (this.props) this.props.group.visible = false;
    g.hud.setScore(null);
  }

  // A clear spot near (x, z) for this hull, searching along the river.
  _settle(x, z, h) {
    const b = this.body, env = this.env;
    if (b.fits(env, x, z, h)) return { x, z, h };
    const P = this.path, pr = P.project(x, z, null, {});
    for (const ds of [0, 15, -15, 30, -30, 60, -60]) {
      for (const dd of [0, 6, -6, 12, -12, 20, -20]) {
        const p = P.at(pr.s + ds, pr.d * 0.5 + dd, {});
        const hh = Math.cos(Math.atan2(p.tx, -p.tz) - h) > 0 ? Math.atan2(p.tx, -p.tz) : Math.atan2(-p.tx, p.tz);
        if (b.fits(env, p.x, p.z, hh)) return { x: p.x, z: p.z, h: hh };
      }
    }
    return { x, z, h };
  }

  // Water to launch into near the car (E in free roam): { x, z, heading } or null.
  findLaunch(cx, cz, heading, type) {
    const b = new BoatBody(type), env = this.env, cw = this.g.collision;
    const P = this.path, pr = P ? P.project(cx, cz, null, {}) : null;
    const onRiver = pr && pr.dist < 300;
    for (const r of [6, 10, 15, 21, 28, 36, 45]) {
      for (let k = 0; k < 16; k++) {
        const a = heading + (k / 16) * Math.PI * 2;
        const x = cx + Math.sin(a) * r, z = cz - Math.cos(a) * r;
        if (!cw.isWaterSurface(x, z)) continue;
        let h = a;
        if (onRiver) {
          const q = P.at(P.project(x, z, pr.s, {}).s, 0, {});
          const along = Math.atan2(q.tx, -q.tz);
          h = Math.cos(along - heading) >= 0 ? along : along + Math.PI;
        }
        if (b.fits(env, x, z, h)) return { x, z, heading: h };
      }
    }
    return null;
  }

  // Dry land near the boat to step ashore onto: a road position for the car.
  findShore(far = false) {
    const g = this.g, b = this.body, cw = g.collision, T = g.map.terrain;
    for (const r of far ? [6, 12, 20, 30, 45, 70, 100, 150, 220, 320, 450] : [4, 7, 11, 16, 22, 30]) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2, x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r;
        const v = cw.surfaceAt(x, z);
        if (cw.isWaterSurface(x, z) || v & SURF.BLDG) continue;
        const road = g.graph.nearestRoad3D(x, z, T.h(x, z), 80);
        if (road) return road;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ the race
  _startRace(def) {
    const g = this.g, B = g.boats, C = this.course, T = BOAT_TYPES[def.boat];
    for (const b of B.list.slice()) B.remove(b);
    B.ambient = false;
    B.raceRange = [C.finish - 200, C.start + 700];
    const rng = mulberry32((Date.now() & 0xffffff) ^ 0x5bd1e995);
    const clubs = CLUBS.slice();
    for (let i = clubs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [clubs[i], clubs[j]] = [clubs[j], clubs[i]]; }
    const field = [];
    for (let k = 0; k < 10; k++) {
      if (k === YOU) { field.push({ bow: k + 1, you: true, name: 'Race Boston' }); continue; }
      const club = clubs.pop();
      // Average pace: the best crews beat a steady paddle at the cruising rate.
      const pace = T.speed * (0.94 + rng() * 0.12) * (k < YOU ? 1.01 : 1);
      const lineT = LINE_T + (k - YOU) * INTERVAL;
      const s = lineT <= 0 ? C.start - pace * -lineT : C.start + 25 + pace * lineT;
      const b = B.add(def.boat, { role: 'race', s, d: 0, dir: -1, vt: pace, club, lane: 0, name: club.name });
      b.v = pace;
      field.push({ bow: k + 1, boat: b, club, pace, name: club.name, crossedAt: lineT <= 0 ? lineT : null, finishT: null });
    }
    const buoys = this._buoys();
    this.race = {
      def, field, buoys, clock: 0, countdown: 3.5, lastBeep: 4, started: false, done: false,
      t0: null, time: 0, penalty: 0, splits: [], next: 0, sPrev: C.start + 40, recut: 0,
      bestSplits: (this.best[def.id] && this.best[def.id].splits) || null,
    };
    g.input.enabled = false;
    this._showProps(true);
    this.env.clearCourse = true;
    // Frozen river: the course is cleared for the race.
    this._cutChannel();
    g.hud.toast(`${def.name} · ${def.event}`, `Head race · bow ${YOU + 1} of 10 · crews start ${INTERVAL} s apart · ${formatDistance(C.length, g.settings.metric)}`, 4200);
  }

  // Half-width of the buoyed course at s.
  _courseHW(s) {
    const p = this.path.at(s, 0, this._pr);
    return clamp(Math.min(p.right, p.left) - 9, 10, 34);
  }

  _buoys() {
    const C = this.course, out = [];
    for (let s = C.start - 60; s > C.finish + 40; s -= 110) {
      const hw = this._courseHW(s);
      for (const sd of [-1, 1]) {
        const p = this.path.at(s, sd * hw, {});
        if (this.g.collision.isWaterSurface(p.x, p.z)) out.push({ x: p.x, z: p.z, s, hit: 0, side: sd });
      }
    }
    return out;
  }

  // Keep the course open on a frozen river: all of it at the start, then
  // (every 45 s) the stretch around the field near you.
  _cutChannel(around = null) {
    const ice = this.g.ice, C = this.course;
    if (!ice || ice.level < 0.25) return;
    const hi = around === null ? C.start + 600 : Math.min(C.start + 600, around + 1000);
    const lo = around === null ? C.finish - 150 : Math.max(C.finish - 150, around - 900);
    for (let s = hi; s > lo; s -= 7) {
      const p = this.path.at(s, 0, this._pr);
      ice.breakAt(p.x, p.z, this._courseHW(s) + 6, 0);
    }
  }

  _updateRace(dt) {
    const r = this.race, g = this.g, hud = g.hud, C = this.course, b = this.body;
    if (!r.started) {
      r.countdown -= dt;
      const c = Math.ceil(r.countdown);
      if (c < r.lastBeep && c <= 3 && c >= 1) { r.lastBeep = c; hud.message(String(c), 'Bow ' + (YOU + 1), 800); g.audio.beep(false); }
      if (r.countdown <= 0) {
        r.started = true;
        g.input.enabled = true;
        // A rolling start, as in a real head race: already up to pressure.
        const b = this.body, v = b.T.speed * 0.8;
        b.vx = b.fx * v; b.vz = b.fz * v; b.vF = v; b.rate = b.T.rate; b.rest = 0; b.phase = 0;
        hud.message('Row!', 'Up to the start line', 1100, '#7ee081');
        g.audio.beep(true);
      }
      return;
    }
    r.clock += dt;
    r.recut -= dt;
    const pr = this.path.project(b.x, b.z, r.sPrev, this._pr);
    const s = pr.s;
    if (r.recut <= 0) { r.recut = 45; this._cutChannel(s); }
    if (r.t0 === null && s < C.start) { r.t0 = r.clock; hud.message('Start', 'The clock is running', 1000, '#ffd447'); g.audio.checkpoint(); }
    if (r.t0 !== null && !r.done) r.time = r.clock - r.t0;
    // Bridges and the finish.
    const m = C.marks[r.next];
    if (m && r.t0 !== null && s < m.s && r.sPrev >= m.s) {
      const t = r.time + r.penalty;
      r.splits.push(t);
      const ref = r.bestSplits && r.bestSplits[r.next];
      const diff = ref ? ` (${t - ref >= 0 ? '+' : '-'}${Math.abs(t - ref).toFixed(1)})` : '';
      r.next++;
      if (m.finish) { this._finishRace(); return; }
      hud.message(m.name, `${formatTime(t)}${diff} · place ${this._place(t, s)}`, 1500, '#ffd447');
      g.audio.checkpoint();
    }
    r.sPrev = s;
    // Buoys: +5 s each.
    for (const by of r.buoys) {
      if (by.hit > 0) { by.hit -= dt; continue; }
      if (Math.abs(by.s - s) > 20) continue;
      if (hullDist(b, by.x, by.z) < 0.9) {
        by.hit = 6;
        r.penalty += BUOY_PENALTY;
        hud.message('Buoy!', `+${BUOY_PENALTY} s penalty`, 1300, '#ff6b6b');
        g.audio.crash(0.25);
      }
    }
    this._driveField(dt);
  }

  // AI crews: hold their pace, pass slower boats on the wider side.
  _driveField(dt) {
    const r = this.race, C = this.course, b = this.body;
    const others = r.field.filter((f) => f.boat);
    for (const f of others) {
      const a = f.boat;
      if (f.crossedAt === null && a.s < C.start) f.crossedAt = r.clock;
      if (f.finishT === null && a.s < C.finish) { f.finishT = r.clock - f.crossedAt; a.vt = 3; }
      if (f.finishT !== null) { a.lane = a.d; continue; }
      a.vt = f.pace * (1 + 0.025 * Math.sin(r.clock / 23 + f.bow));
      // Anyone close ahead in our water?
      let block = null;
      for (const o of others) if (o !== f && o.boat.s < a.s && a.s - o.boat.s < 30 && Math.abs(o.boat.d - a.d) < 7) block = o.boat;
      const ps = this._pr2 || (this._pr2 = {});
      this.path.project(b.x, b.z, a.s, ps);
      if (ps.s < a.s && a.s - ps.s < 30 && Math.abs(ps.d - a.d) < 7) block = { d: ps.d };
      const hw = this._courseHW(a.s) - 4;
      a.lane = block ? clamp(block.d > 0 ? block.d - 9 : block.d + 9, -hw, hw) : a.lane * Math.exp(-dt / 6);
    }
  }

  // Place on time at this point of the course (every crew holds its pace).
  _place(t, s) {
    const r = this.race, dist = Math.max(1, this.course.start - s);
    let ahead = 0;
    for (const f of r.field) if (f.boat && dist / f.pace < t) ahead++;
    return ordinal(ahead + 1);
  }

  // A crew's final time: as rowed, or projected at its pace.
  _estimate(f) {
    const r = this.race, C = this.course;
    if (f.finishT !== null) return f.finishT;
    if (f.crossedAt === null) return C.length / f.pace;
    return r.clock - f.crossedAt + Math.max(0, f.boat.s - C.finish) / f.pace;
  }

  _finishRace() {
    const r = this.race, g = this.g, def = r.def;
    r.done = true;
    const time = r.time + r.penalty;
    const times = r.field.filter((f) => f.boat).map((f) => ({ name: f.name, t: this._estimate(f), bow: f.bow }));
    times.push({ name: 'Race Boston (you)', t: time, bow: YOU + 1, you: true });
    times.sort((a, b) => a.t - b.t);
    const place = times.findIndex((x) => x.you) + 1;
    const medal = place === 1 ? 'gold' : place === 2 ? 'silver' : place === 3 ? 'bronze' : null;
    const prev = this.best[def.id] ? this.best[def.id].time : null;
    const record = prev === null || time < prev;
    if (record) { this.best[def.id] = { time, splits: r.splits.slice(), place }; saveJSON('rb.regatta', this.best); }
    g.audio.finish();
    g.hud.message('Finish!', `${formatTime(time)} · ${ordinal(place)} of ${times.length}${record ? ' · NEW BEST' : ''}`, 2600, '#ffd447');
    setTimeout(() => {
      if (this.race === r && this.active) g.showResults({ regatta: true, raceId: def.id, title: `${def.name} · ${def.event}`, time, place, of: times.length, medal, record, prev, penalty: r.penalty, standings: times.slice(0, 10) });
    }, 2200);
  }

  // ------------------------------------------------------------ per frame
  update(dt, inp) {
    const g = this.g, b = this.body, r = this.race, fy = this.ferry;
    if (!b) return;
    this.env.time += dt;
    let control = inp;
    if (r && (!r.started || r.done)) control = NO_INPUT;
    if (fy && fy.over) control = NO_INPUT;
    if (this.frozenIn > 2) control = NO_INPUT;
    this.acc = Math.min(this.acc + dt, STEP * 10);
    let impact = 0;
    const ph0 = b.phase;
    if (fy && fy.moored) { fy.holdShip(dt); this.acc = 0; control = NO_INPUT; }   // lines out: she's held alongside
    while (this.acc >= STEP) {
      b.step(STEP, control, this.env);
      impact = Math.max(impact, b.impact);
      this.acc -= STEP;
    }
    this.control = control;
    impact = Math.max(impact, g.boats.collidePlayer(b));
    this.impact = impact;
    this.peakImpact = Math.max(this.peakImpact || 0, impact);   // for tests: the hardest hit so far
    if (impact > 0.7) {
      g.audio.crash(Math.min(1, impact / 7));
      this.camera.bump(Math.min(1, impact / 6));
      if (r && impact > 1.5 && !r.done) g.hud.message(b.T.row ? 'Crab!' : 'Bump!', '', 900, '#ff6b6b');
    }
    // Catch and release, heard from the boat.
    if (b.T.row && b.rowing) {
      if (b.phase < ph0) g.audio.oar(0.5 + b.T.seats * 0.06);
      else if (ph0 < b.Dr && b.phase >= b.Dr) g.audio.oarlock();
    }
    placeBoat(this.model, b);
    this.model.root.updateMatrixWorld(true);
    if (b.T.row) poseBoat(this.model, b.phase, b.Dr, b.rest);
    g.boats._wake(b, dt);
    if (b.T.breaker) {
      g.boats._breakIce(b, dt, g.camera);
      g.audio.setDiesel?.(0.25 + 0.75 * Math.max(control.throttle || 0, (control.brake || 0) * 0.8), b.speed / b.T.top);
      g.audio.setShipHorn?.(!!inp.horn);
    }
    if (r) this._updateRace(dt);
    if (fy) { fy.update(dt); fy.aimCamera(this.camera, dt); }
    // Frozen in: the river closed around the boat.
    const stuck = !b.T.breaker && g.ice.level > 0.6 && b.speed < 0.3 && this._iceAround();
    this.frozenIn = stuck ? this.frozenIn + dt : 0;
    if (this.frozenIn > 2 && !this._frozeMsg) { this._frozeMsg = true; g.hud.message('Frozen in!', 'Press E to walk ashore across the ice', 3000, '#bfe6ff'); }
    if (!stuck) this._frozeMsg = false;
    this.camera.lookBack = inp.lookBack;
    this.camera.update(dt, b, g.collision);
  }

  _iceAround() {
    const b = this.body, ice = this.g.ice;
    let n = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (ice.solidAt(b.x + Math.cos(a) * (b.T.len / 2 + 3), b.z + Math.sin(a) * (b.T.len / 2 + 3))) n++;
    }
    return n >= 6;
  }

  // R: back to clear water on the river line.
  reset() {
    const b = this.body;
    if (!b || (this.ferry && this.ferry.moored)) return;
    const pr = this.path.project(b.x, b.z, null, {});
    if (pr.dist > 400) return;
    const p = this.path.at(pr.s, 0, {});
    let h = Math.atan2(p.tx, -p.tz);
    if (Math.cos(h - b.heading) < 0) h += Math.PI;
    const q = this._settle(p.x, p.z, h);
    b.reset(q.x, q.z, q.h, this.g.map.terrain.h(q.x, q.z));
    this.camera.snap();
  }

  pose(out = {}) {
    const b = this.body;
    out.x = b ? b.x : 0; out.y = b ? b.y : 0; out.z = b ? b.z : 0; out.heading = b ? b.heading : 0;
    return out;
  }

  // ------------------------------------------------------------ HUD
  hud(metric) {
    const g = this.g, hud = g.hud, b = this.body, T = b.T, r = this.race;
    hud.setSpeed(b.speed, metric);
    // The ship shows its engine order instead of a gear.
    const c = this.control || {};
    hud.setGear(T.row ? (b.rate > 6 ? String(Math.round(b.rate)) : 'EZ') : T.breaker ? (this.ferry && this.ferry.moored ? 'MOOR' : c.brake > 0 ? 'AST' : c.throttle > 0 ? 'AHD' : 'STOP') : b.vF < -0.5 ? 'R' : 'D');
    hud.setBoost(T.noBoost ? b.speed / T.top : b.boost, b.boosting);
    if (this.ferry) { this.ferry.hud(metric); return; }
    const split = T.row && b.speed > 0.5 ? `${formatTime(500 / b.speed).slice(0, -1)} /500m` : '';
    const keys = T.row ? 'W row · Shift power ten · S hold water / back · A D steer' : T.breaker ? 'W ahead · S astern · A D helm (the bow thruster turns her when stopped) · H horn' : 'W throttle · S reverse · A D steer · Shift boost';
    this.locTimer -= 1 / 60;
    if (this.locTimer <= 0) {
      this.locTimer = 0.25;
      g.updateLocation(0.25, b.x, b.z, b.y);
      const pr = this.path.project(b.x, b.z, null, this._pr);
      hud.setStreet(pr.dist < Math.max(pr.d > 0 ? this.path.at(pr.s).right : this.path.at(pr.s).left, 40) + 30 ? 'Charles River' : 'Boston Harbor', hud.streetArea.textContent);
    }
    if (r) {
      const C = this.course, pr = this.path.project(b.x, b.z, r.sPrev, {});
      const m = C.marks[r.next];
      const sub = !r.started ? `Bow ${YOU + 1} · starting in ${Math.max(0, Math.ceil(r.countdown))}`
        : r.t0 === null ? `Start line in ${Math.max(0, Math.round(pr.s - C.start))} m`
        : r.done ? 'Finished' : m ? `${m.name} · ${formatDistance(Math.max(0, pr.s - m.s), metric)}` : '';
      const pen = r.penalty ? ` &middot; <b style="color:#ff6b6b">+${r.penalty} s</b>` : '';
      hud.setMission({
        title: `${r.def.name} · ${r.def.event}`, sub, time: r.t0 === null ? '0:00.00' : formatTime(r.time + r.penalty),
        extra: `${split ? split + ' &middot; ' : ''}Rate ${Math.round(b.rate)}${pen} &middot; ${formatDistance(Math.max(0, pr.s - C.finish), metric)} to go<br>${keys} · C camera`,
      });
      const place = r.t0 !== null && !r.done ? this._place(r.time + r.penalty, pr.s) : '-';
      const best = this.best[r.def.id];
      hud.setScore(`<div class="small">Place</div><div class="big">${place}</div><div class="small">${best ? 'Best ' + formatTime(best.time) : 'Bow ' + (YOU + 1) + ' of 10'}</div>`);
      return;
    }
    const near = this._shoreNear();
    hud.setMission({
      title: `On the water · ${T.name}`,
      sub: g.ice.frozen ? 'The Charles is frozen: icebreakers are out' : g.ice.forming ? 'Ice is forming on the river' : split || 'The Charles River',
      extra: `${keys} · C camera<br>${near ? '<b style="color:#7ee081">E go ashore</b>' : 'Get near the bank and press E to go ashore'} · M map · Esc menu`,
    });
    hud.setScore(null);
  }

  _shoreNear() {
    this._shoreT = (this._shoreT || 0) - 1;
    if (this._shoreT > 0) return this._shoreCache;
    this._shoreT = 20;
    const b = this.body, cw = this.g.collision;
    let near = false;
    for (let k = 0; k < 12 && !near; k++) {
      const a = (k / 12) * Math.PI * 2;
      for (const r of [b.T.beam / 2 + 3, 10, 18]) if (!cw.isWaterSurface(b.x + Math.cos(a) * r, b.z + Math.sin(a) * r)) { near = true; break; }
    }
    return (this._shoreCache = near);
  }

  overlays() {
    if (this.ferry) return this.ferry.overlays();
    const r = this.race;
    if (!r || r.done) return { markers: [] };
    const C = this.course, P = this.path, b = this.body;
    const s0 = this.path.project(b.x, b.z, r.sPrev, {}).s;
    const route = [[b.x, b.z]];
    for (let s = Math.min(s0, C.start); s > C.finish; s -= 20) { const p = P.at(s, 0, {}); route.push([p.x, p.z]); }
    const f = P.at(C.finish, 0, {});
    route.push([f.x, f.z]);
    const markers = C.marks.slice(r.next).map((m, i) => { const p = P.at(m.s, 0, {}); return { x: p.x, z: p.z, r: i === 0 ? 8 : 5, color: m.finish ? '#ff4d5a' : i === 0 ? '#ffc93c' : '#5ac8ff', edge: i === 0 }; });
    return { route, routeColor: '#ffc93c', markers };
  }

  // ------------------------------------------------------------ race props
  // Buoys along the course, start and finish towers with banners, and
  // crowds on the banks and bridges.
  _showProps(on) {
    if (on && !this.props) this.props = this._buildProps();
    if (!this.props) return;
    this.props.group.visible = on;
    if (on) this._layBuoys();
  }

  _layBuoys() {
    const r = this.race, P = this.props, T = this.g.map.terrain, m = new THREE.Matrix4();
    P.buoys.count = r.buoys.length;
    r.buoys.forEach((by, i) => { m.makeTranslation(by.x, T.h(by.x, by.z), by.z); P.buoys.setMatrixAt(i, m); });
    P.buoys.instanceMatrix.needsUpdate = true;
  }

  _buildProps() {
    const g = this.g, C = this.course, Pth = this.path, cw = g.collision, T = g.map.terrain;
    const group = new THREE.Group();
    g.scene.add(group);
    // Buoys: orange cans with a white band.
    const bg = new THREE.CylinderGeometry(0.32, 0.4, 0.9, 10);
    bg.translate(0, 0.25, 0);
    const buoys = new THREE.InstancedMesh(bg, new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.45, emissive: 0x401400 }), 200);
    buoys.count = 0;
    buoys.castShadow = true;
    group.add(buoys);
    // Start and finish: striped towers either side and a banner across.
    for (const [s, text, color] of [[C.start, 'START', '#2f9e44'], [C.finish, 'FINISH', '#c8102e']]) {
      const hw = this._courseHW(s) + 3, a = Pth.at(s, -hw, {}), b = Pth.at(s, hw, {});
      for (const p of [a, b]) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 7, 12), new THREE.MeshStandardMaterial({ color, roughness: 0.5 }));
        t.position.set(p.x, T.h(p.x, p.z) + 3.4, p.z);
        t.castShadow = true;
        group.add(t);
      }
      const cv = document.createElement('canvas');
      cv.width = 1024; cv.height = 128;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = color; ctx.fillRect(0, 0, 1024, 128);
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 italic 74px Inter, Segoe UI, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`${text} · HEAD OF THE CHARLES`, 512, 68);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const w = Math.hypot(b.x - a.x, b.z - a.z);
      // One face each way, so it reads from both directions.
      const geo = new THREE.PlaneGeometry(w, Math.min(5, w / 8)), mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      for (const flip of [0, Math.PI]) {
        const banner = new THREE.Mesh(geo, mat);
        banner.position.set((a.x + b.x) / 2, T.h(a.x, a.z) + 7.4, (a.z + b.z) / 2);
        banner.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x) + flip;
        group.add(banner);
      }
    }
    // Crowds: on the banks around each bridge and the finish, and along the bridges.
    const bodies = [], rng = mulberry32(99);
    const spot = (x, z, y, fx, fz) => bodies.push([x, y, z, Math.atan2(fx, fz)]);
    for (const m of [{ s: C.start }, ...C.marks]) {
      for (let s = m.s - 130; s <= m.s + 130; s += 3.2) {
        for (const sd of [-1, 1]) {
          if (rng() < 0.35) continue;
          const p = Pth.at(s, 0, {}), reach = sd > 0 ? p.right : p.left;
          const q = Pth.at(s, sd * (reach + 3 + rng() * 9), {});
          const v = cw.surfaceAt(q.x, q.z);
          if (cw.isWaterSurface(q.x, q.z) || v & (SURF.BLDG | SURF.ROAD)) continue;
          spot(q.x, q.z, T.h(q.x, q.z), p.x - q.x, p.z - q.z);
        }
      }
      if (m.finish) continue;
      // Along the bridge railings, looking down the course.
      const p0 = Pth.at(m.s, 0, {}), lvl = T.h(p0.x, p0.z);
      for (const off of [-7, -4, 4, 7]) {
        for (let d = -Math.max(p0.left, 30); d <= Math.max(p0.right, 30); d += 1.3) {
          if (rng() < 0.3) continue;
          const q = Pth.at(m.s + off, d, {});
          const h = cw.deckAbove(q.x, q.z, lvl);
          if (!isFinite(h) || h - lvl > 30) continue;
          const tt = Pth.at(m.s + off + Math.sign(off) * 30, 0, {});
          spot(q.x, q.z, h, tt.x - q.x, tt.z - q.z);
        }
      }
    }
    const n = Math.min(bodies.length, 2600);
    const torso = new THREE.BoxGeometry(0.44, 0.62, 0.26); torso.translate(0, 1.12, 0);
    const legs = new THREE.BoxGeometry(0.36, 0.82, 0.22); legs.translate(0, 0.41, 0);
    const legC = new THREE.Color(0x2a2d36);
    const tcol = new Float32Array(torso.attributes.position.count * 3).fill(1), lcol = new Float32Array(legs.attributes.position.count * 3);
    for (let i = 0; i < lcol.length; i += 3) { lcol[i] = legC.r; lcol[i + 1] = legC.g; lcol[i + 2] = legC.b; }
    torso.setAttribute('color', new THREE.BufferAttribute(tcol, 3));
    legs.setAttribute('color', new THREE.BufferAttribute(lcol, 3));
    const bodyGeo = mergeSimple([torso, legs]);
    const people = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }), n);
    const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 8, 6).translate(0, 1.58, 0), new THREE.MeshStandardMaterial({ color: 0xd9a27c, roughness: 0.7 }), n);
    const shirts = [0xc8102e, 0x1f3d6e, 0xf2c12e, 0x2a8c5a, 0xffffff, 0x8a1c2b, 0x333842, 0xe8749a, 0xf28c28, 0x5ac8ff, 0x7a5c3c];
    const mm = new THREE.Matrix4(), c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const [x, y, z, h] = bodies[i];
      const sc = 0.9 + rng() * 0.2;
      mm.makeRotationY(h).scale(new THREE.Vector3(sc, sc, sc)).setPosition(x, y, z);
      people.setMatrixAt(i, mm);
      heads.setMatrixAt(i, mm);
      people.setColorAt(i, c.setHex(shirts[Math.floor(rng() * shirts.length)]));
    }
    people.castShadow = true;
    group.add(people, heads);
    return { group, buoys };
  }
}

function mergeSimple(geos) {
  const gs = geos.map((g) => g.toNonIndexed());
  let n = 0;
  for (const g of gs) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of gs) {
    pos.set(g.attributes.position.array, o * 3); nrm.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

// Distance from a point to the boat's keel line.
function hullDist(b, x, z) {
  const L = b.T.len * 0.48, ax = b.x - b.fx * L, az = b.z - b.fz * L, dx = b.fx * 2 * L, dz = b.fz * 2 * L;
  const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t)) - b.T.beam / 2;
}

export function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return n + s;
}

export function regattaLabel(id) {
  const r = REGATTAS.find((x) => x.id === id);
  return r ? `${r.name} · ${r.event}` : '';
}

export { esc };
