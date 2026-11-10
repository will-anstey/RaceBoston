// Flying: the aircraft you're at the controls of (aircraft.js, flight.js),
// in the air or on the ground at an airport, and the world under her: the
// terrain, runways and grass, water, buildings and bridges to hit, the
// weather's wind and turbulence. Cameras (chase, far, cockpit, tower), the
// instruments (pfd.js), engine sound, touchdowns and their rating, crashes,
// time compression for long legs, and unlocking an island when you land there.
// An airline flight (airline.js) adds the gate, the passengers, the taxi
// routes and the clearances.

import * as THREE from 'three';
import { FlightBody, Turbulence, GROUND, KT, FT } from './flight.js';
import { AIRCRAFT, buildAircraft, poseAircraft, disposeAircraft } from './aircraft.js';
import { Airport, AIRPORT_DEFS } from './airports.js';
import { DragLook } from './camera.js';
import { PFD } from './pfd.js';
import { SURF } from './collision.js';
import { clamp, damp, wrapAngle, segDist2, formatDistance, loadJSON, saveJSON } from './util.js';

const STEP = 1 / 150;
const DEG = Math.PI / 180;
export const FLIGHT_CAMERAS = ['Chase', 'Far chase', 'Cockpit', 'Tower'];
const SIM_RATES = [1, 2, 4, 8, 16];
const NO_CTL = { throttle: 0, elevator: 0, aileron: 0, rudder: 0, brake: 1, steer: 0, reverse: 0, speedbrake: false, trim: 0, assist: true };

// Touchdown ratings by sink rate (feet per minute).
export function rateLanding(fpm) {
  if (fpm < 70) return { name: 'Butter', score: 100, color: '#7ee081' };
  if (fpm < 180) return { name: 'Smooth', score: 90, color: '#7ee081' };
  if (fpm < 320) return { name: 'Firm', score: 70, color: '#ffd447' };
  if (fpm < 520) return { name: 'Hard', score: 40, color: '#ffb020' };
  if (fpm < 800) return { name: 'Very hard', score: 15, color: '#ff6b6b' };
  return { name: 'Crunch', score: 0, color: '#ff3b3b' };
}

export class FlightMode {
  constructor(game) {
    this.g = game;
    this.active = false;
    this.body = null;
    this.model = null;
    this.job = null;
    this.camera = new FlightCamera(game.camera);
    this.turb = new Turbulence();
    const cv = document.getElementById('pfd');
    this.pfd = cv ? new PFD(cv) : null;
    this.env = { ground: (x, z, o) => this.ground(x, z, o), wind: (x, y, z, o, dt) => this.wind(x, y, z, o, dt), obstacle: (x, y, z, r) => this.obstacle(x, y, z, r) };
    this.ctl = { ...NO_CTL, brake: 0 };
    this.lever = 0;
    this.k = { pitch: 0, roll: 0, yaw: 0 };
    this.sim = 1;
    this.acc = 0;
    this.airports = {};
    this.unlocked = new Set(loadJSON('rb.unlocked', []));
    this._g = { h: 0, kind: 1, wet: 0 };
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3();
    this.cloud = null;
  }

  // ------------------------------------------------------------ airports
  airport(code) {
    if (this.airports[code]) return this.airports[code];
    const def = AIRPORT_DEFS[code];
    const R = def && this.g.regionFor ? this.g.regionFor(def.region) : def && def.region === 'boston' ? { map: this.g.map } : null;
    if (!R || !R.map) return null;
    const a = new Airport(def, R.map);
    if (!a.ok) return null;
    a.regionObj = R;
    this.airports[code] = a;
    return a;
  }

  // Airports loaded now (Logan always; the islands once their maps are in).
  loadedAirports() { return Object.keys(AIRPORT_DEFS).map((c) => this.airport(c)).filter(Boolean); }

  nearestAirport(x, z) {
    let best = null, bd = Infinity;
    for (const a of this.loadedAirports()) { const d = Math.hypot(a.x - x, a.z - z); if (d < bd) { bd = d; best = a; } }
    return best ? { airport: best, dist: bd } : null;
  }

  // ------------------------------------------------------------ start/stop
  // opts: { type, airport: 'BOS', at: 'runway' | 'ramp' | 'air' | 'mast' | 'stand', end: runway end name,
  //         job: an airline.js job (sets the start itself), mass }
  start(opts) {
    const g = this.g;
    this.stop();
    const type = opts.type || 'c172', T = AIRCRAFT[type];
    if (!T) return false;
    const ap = this.airport(opts.airport || 'BOS');
    if (!ap && opts.at !== 'air') return false;
    this.type = type;
    this.opts = opts;
    this.body = new FlightBody(type, { mass: opts.mass || T.load });
    this.model = buildAircraft(type);
    g.scene.add(this.model.root);
    this.active = true;
    this.sim = 1; this.acc = 0; this.simTime = 0;
    this.lever = 0; this.k.pitch = this.k.roll = this.k.yaw = 0;
    this.crash = null; this.crashAt = null; this.hitInfo = null; this.crashT = 0; this.touchMsg = null; this.damage = 0; this.strikes = 0;
    this.maxG = 1; this.minG = 1; this.maxBank = 0; this.overspeedT = 0; this.events = [];
    this.lastWheels = true; this.ap = ap;
    this.flightAirport = ap;
    this.hold = false;
    this.camera.mode = 0; this.camera.snap(); this.camera.look.reset();
    this.turb.g.set(0, 0, 0); this.turb.cells.length = 0;
    if (opts.job) {
      this.job = opts.job;
      this.job.begin(this);
    } else this._place(opts, ap);
    poseAircraft(this.model, this.body, 0, this.g.sky.nightAmount, g.camera);
    this.model.root.updateMatrixWorld(true);
    this.camera.snap();
    g.sky.farCap = 45000;
    return true;
  }

  // Where she starts: lined up on a runway, on the ramp, at a mooring mast or in the air.
  _place(opts, ap) {
    const b = this.body, T = b.T;
    if (opts.at === 'air' && opts.pose) {
      const p = opts.pose;
      b.reset(p.x, p.y, p.z, p.heading, { airborne: true, speed: p.speed || T.vclimb, gear: !T.gearRetract, flap: 0, throttle: 0.6 });
      this.lever = 0.6;
      return;
    }
    if (opts.at === 'mast' || T.engine === 'blimp') {
      const m = this.mastAt(ap);
      b.reset(m.x, ap.elev + T.cgH + 0.02, m.z, m.heading, {});
      this.moored = m;
      return;
    }
    if (opts.at === 'ramp' || opts.at === 'stand') {
      const st = opts.stand || this.freeStand(ap, T, opts.near) || ap.stands[0];
      const p = this.standPose(ap, st, T);
      b.reset(p.x, ap.elev + T.cgH + 0.01, p.z, p.heading, {});
      this.stand = st;
      return;
    }
    // Lined up on the runway end into the wind (or the one asked for).
    const w = this.g.weather;
    const need = this._runwayNeed(T, b.mass);
    const e = (opts.end && ap.ends.get(opts.end)) || ap.bestEnd(w.windDir + Math.PI, 3 + w.cur.wind * 16, need);
    const back = Math.min(60, e.length * 0.03) + 12;
    b.reset(e.x + e.fx * back, ap.elev + T.cgH + 0.01, e.z + e.fz * back, e.heading, { flap: T.toFlap });
    this.runwayEnd = e;
    // Airliners taxiing or holding round the end of the runway: out of the way.
    if (ap.code === 'BOS' && this.g.planes && this.g.planes.clearAround) this.g.planes.clearAround(b.pos.x, b.pos.z, T.span / 2 + 110);
  }

  // Ground roll needed for takeoff (m), roughly, with a margin: for picking a runway.
  _runwayNeed(T, mass) {
    const vr = T.vr * Math.sqrt(mass / T.load), F = T.engines * T.thrust * 0.8;
    const a = Math.max(0.5, F / mass - 0.25);
    return (vr * vr) / (2 * a) * 1.7 + 200;
  }

  // Where to put the nose on a stand: just short of its end.
  standPose(ap, st, T) {
    const stop = T.cls === 'light' || T.cls === 'commuter' ? 0 : 3;
    const nx = st.ex - st.fx * stop, nz = st.ez - st.fz * stop;
    const back = T.fus.zNose - 0.5;
    return { x: nx - st.fx * back, z: nz - st.fz * back, heading: st.heading, nx, nz };
  }

  // A stand she fits on (room for her wings) that no airliner is using.
  freeStand(ap, T, near = null, avoid = null) {
    const P = this.g.planes, need = T.span * 0.55;
    let best = null, bs = Infinity;
    for (const st of ap.stands) {
      if (st === avoid || (st.room || 99) < need) continue;
      if (ap.code === 'BOS' && P && P.standBusy && P.standBusy(st.ex, st.ez, T.span)) continue;
      const d = near ? Math.hypot(st.ex - near.x, st.ez - near.z) : Math.random() * 1000;
      if (d < bs) { bs = d; best = st; }
    }
    return best;
  }

  // The blimp's mooring mast: on the grass by the airfield.
  mastAt(ap) {
    if (ap.mast) return ap.mast;
    // A grassy spot near the field away from runways and taxiways.
    const cw = ap.regionObj.collision || this.g.collision, A = ap;
    let best = null, bs = -Infinity;
    for (let k = 0; k < 400; k++) {
      const a = (k / 400) * Math.PI * 2 * 7, r = 300 + (k % 40) * 30;
      const x = A.x + Math.cos(a) * r, z = A.z + Math.sin(a) * r;
      const v = cw.surfaceAt(x, z);
      if (!(v & SURF.GRASS) || v & (SURF.ROAD | SURF.PAVED | SURF.WATER | SURF.BLDG)) continue;
      let clear = 0;
      for (let q = 0; q < 12; q++) { const b2 = (q / 12) * Math.PI * 2; const s = cw.surfaceAt(x + Math.cos(b2) * 45, z + Math.sin(b2) * 45); if (s & SURF.GRASS && !(s & (SURF.ROAD | SURF.PAVED | SURF.WATER | SURF.BLDG))) clear++; }
      const rw = A.onRunway(x, z, 150) ? -1000 : 0;
      const s = clear * 10 + rw - r * 0.01;
      if (s > bs) { bs = s; best = { x, z }; }
    }
    if (!best) best = { x: A.x, z: A.z };
    const w = this.g.weather;
    best.heading = w.windDir + Math.PI;        // nose into the wind
    ap.mast = best;
    this._buildMast(best, ap.elev);
    return best;
  }

  // A mast stays where it's put (one per airport, built the first time the Glimp needs it).
  _buildMast(m, elev) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.5, metalness: 0.3 });
    const white = new THREE.MeshStandardMaterial({ color: 0xe8eaec, roughness: 0.6 });
    const H = AIRCRAFT.blimp.cgH - 0.4;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, H, 10).translate(0, H / 2, 0), mat);
    const truck = new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, 7).translate(0, 0.7, 2.5), white);
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.5, 0.8, 12).translate(0, H + 0.2, 0), mat);
    for (const o of [mast, truck, cup]) { o.castShadow = true; g.add(o); }
    g.position.set(m.x, elev, m.z);
    m.top = H; m.elev = elev;
    this.g.scene.add(g);
    m.mesh = g;
  }

  stop() {
    if (!this.body) return;
    const g = this.g;
    if (this.job) { this.job.dispose(); this.job = null; }
    if (this.model) disposeAircraft(this.model);
    this.model = null;
    this.body = null;
    this.active = false;
    this.moored = null;
    this.stand = null;
    if (g.planes && g.planes.setPlayer) g.planes.setPlayer(null);
    g.audio.setAircraft?.(null);
    g.sky.farCap = 8500;
    g.sky.setCloudFog?.(0);
    if (this.pfd) this.pfd.cv.classList.add('hidden');
    document.getElementById('speedo')?.classList.remove('hidden');
    g.minimap.zoomOverride = null;
  }

  // ------------------------------------------------------------ the world below
  // Region the point is in (Boston, or an island once loaded).
  regionAt(x, z) {
    const g = this.g;
    if (g.regionAt) return g.regionAt(x, z);
    const b = g.map.meta.water;
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ ? { map: g.map, collision: g.collision, boston: true } : null;
  }

  ground(x, z, out) {
    const R = this.regionAt(x, z);
    out.wet = this.g.weather.wet;
    if (!R) {
      const h = this.g.backdrop ? this.g.backdrop.heightAt(x, z) : 0;
      out.h = h; out.kind = h > 0.2 ? GROUND.GRASS : GROUND.SEA;
      return out;
    }
    const T = R.map.terrain, cw = R.collision;
    const h = T.h(x, z);
    out.h = h;
    const pb = R.map.meta.play;
    if (x < pb.minX || x > pb.maxX || z < pb.minZ || z > pb.maxZ) { out.kind = h < 0.15 ? GROUND.SEA : GROUND.GRASS; return out; }
    const v = cw.surface.get(x, z);
    if (v & SURF.WATER && !(v & (SURF.ROAD | SURF.PAVED | SURF.CUT))) {
      out.kind = R.boston && this.g.ice.level > 0.6 && this.g.ice.solidAt(x, z) ? GROUND.ICE : h < 0.15 ? GROUND.SEA : GROUND.WATER;
    } else if (v & (SURF.ROAD | SURF.PAVED)) out.kind = GROUND.PAVED;
    else if (v & SURF.BLDG) out.kind = GROUND.PAVED;
    else out.kind = (R.map.meta.region && R.map.meta.region !== 'boston') && !(v & SURF.GRASS) ? GROUND.SAND : GROUND.GRASS;
    return out;
  }

  // Buildings, bridge decks and railings, tunnel walls: anything solid at (x, y, z).
  obstacle(x, y, z, r) {
    const R = this.regionAt(x, z);
    if (!R || !R.collision) return false;
    const cw = R.collision, gh = R.map.terrain.h(x, z);
    if (y - gh > 300 || y < gh - 2) return false;
    const W = cw.walls, s = W.segs;
    const n = W.query(x, z, r);
    for (let k = 0; k < n; k++) {
      const i = W.result[k];
      if (W.y1[i] < y - r * 0.5 || W.y0[i] > y + r * 0.5) continue;
      if (segDist2(x, z, s[4 * i], s[4 * i + 1], s[4 * i + 2], s[4 * i + 3]) < r * r) return true;
    }
    const D = cw.decks, ds = D.segs;
    const m = D.query(x, z, r + 12);
    for (let k = 0; k < m; k++) {
      const i = D.result[k], hw = cw.deckHW[i];
      const tmp = this._tmp || (this._tmp = {});
      const d2 = segDist2(x, z, ds[4 * i], ds[4 * i + 1], ds[4 * i + 2], ds[4 * i + 3], tmp);
      if (d2 > (hw + r) * (hw + r)) continue;
      const dy = D.y0[i] + (D.y1[i] - D.y0[i]) * tmp.t;
      if (y > dy - 1.6 - r && y < dy + 0.4 + r * 0.3) return true;
    }
    return false;
  }

  // Cloud layer for the weather now: { base, top } (m) or null.
  cloudLayer() {
    const c = this.g.weather.cur;
    if (c.cloud < 0.55 && c.fog < 0.5) return null;
    if (c.fog > 0.6 && c.rain < 0.2) return { base: 0, top: 90 + 160 * c.fog };
    const base = 300 + (1 - c.rain) * 700 + (1 - c.cloud) * 600;
    const top = base + 900 + c.rain * 1800 + c.storm * 6000;
    return { base, top };
  }

  wind(x, y, z, out, dt) {
    const w = this.g.weather;
    return this.turb.sample(x, y, z, out, dt, w.state, w.cur.storm || 0, this.body ? this.body.agl : 0, this.cloud);
  }

  // ------------------------------------------------------------ controls
  _controls(dt, inp) {
    const I = this.g.input, b = this.body, T = b.T, st = this.g.settings;
    const k = (...c) => (I.has(...c) ? 1 : 0);
    const blimp = T.engine === 'blimp';
    const lo = blimp ? -0.5 : 0;
    const rate = T.engine === 'jet' ? 0.4 : 0.7;
    const up = k('KeyW') || I.touch.has('throttle'), dn = k('KeyS') || I.touch.has('brake');
    let pitch = k('ArrowDown') - k('ArrowUp');
    if (st.invertPitch) pitch = -pitch;
    let roll = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft') + (I.touch.has('right') ? 1 : 0) - (I.touch.has('left') ? 1 : 0);
    let yaw = k('KeyE') - k('KeyQ');
    let brake = k('Space') || I.touch.has('handbrake') ? 1 : 0;
    let leverRate = (up ? 1 : 0) - (dn ? 1 : 0);
    // Gamepad: left stick flies, triggers move the throttle, bumpers the rudder, A brakes.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let padPitch = 0, padRoll = 0;
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const ax = (i) => { const v = gp.axes[i] || 0; return Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88; };
      const bt = (i) => (gp.buttons[i] ? gp.buttons[i].value || (gp.buttons[i].pressed ? 1 : 0) : 0);
      padRoll = ax(0); padPitch = ax(1) * (st.invertPitch ? -1 : 1);
      leverRate += bt(7) - bt(6);
      yaw += bt(5) - bt(4);
      if (bt(0) > 0.5) brake = 1;
      break;
    }
    this.lever = clamp(this.lever + clamp(leverRate, -1, 1) * rate * dt, lo, 1);
    // Keys ramp in (a stick doesn't snap), the pad is direct.
    const kk = this.k, ramp = (cur, want, r) => cur + clamp(want - cur, -r * dt, r * dt);
    kk.pitch = ramp(kk.pitch, pitch, pitch ? 2.5 : 5);
    kk.roll = ramp(kk.roll, roll, roll ? 3 : 6);
    kk.yaw = ramp(kk.yaw, clamp(yaw, -1, 1), 4);
    const c = this.ctl;
    c.elevator = clamp(kk.pitch + padPitch, -1, 1);
    c.aileron = clamp(kk.roll + padRoll, -1, 1);
    // On the ground the same keys steer the nosewheel; Q/E are the rudder.
    c.steer = clamp(kk.roll + padRoll + kk.yaw * 0.6, -1, 1);
    c.rudder = clamp(kk.yaw, -1, 1);
    // S at idle on the ground: brakes, and reverse thrust on a jet.
    const idleDown = dn && this.lever <= lo + 0.001 && b.wheelsDown && !blimp;
    c.reverse = idleDown && T.reverser && b.speed > 3 ? 1 : 0;
    c.brake = Math.max(brake, idleDown ? 1 : 0);
    c.throttle = c.reverse ? 0.75 : this.lever;
    c.speedbrake = !!this.speedbrake;
    c.assist = st.flightAssist !== false;
    c.trim = blimp ? this.ballast || 0 : 0;
    if (this.ap) {
      // Any stick or throttle input takes it off (except in a test's autoland).
      if (!this.ap.test && (pitch || roll || yaw || up || dn || padPitch || padRoll)) { this.ap = null; this.g.hud.toast('Autopilot off', '', 1000); }
      else this._autopilot(dt, c);
    }
    if (this.hold || b.crashed) Object.assign(c, NO_CTL, { assist: c.assist });
    return c;
  }

  // ------------------------------------------------------------ autopilot
  // hold: { alt, heading, speed }: holds them (U in the air).
  // land: { end, airport }: flies the 3-degree approach to that runway end,
  // flares, touches down and brakes to a stop (the tests use it).
  toggleAutopilot() {
    const b = this.body;
    if (this.ap) { this.ap = null; this.g.hud.toast('Autopilot off', '', 1000); return; }
    if (b.onGround || b.agl < 150) { this.g.hud.toast('Autopilot', 'Engage it in the air, above 500 ft', 1500); return; }
    this.ap = { mode: 'hold', alt: b.pos.y, heading: b.track, speed: b.ias };
    this.g.hud.toast('Autopilot on', `Holding ${Math.round((b.pos.y - b.T.cgH) / FT / 100) * 100} ft, heading ${String(Math.round(((b.track / DEG) % 360 + 360) % 360)).padStart(3, '0')}, ${Math.round(b.ias / KT)} kt`, 2200);
  }

  // Taxi (tests): follow the job's route by the nosewheel, slowing for the
  // corners, and stop at the hold bar or on the stand mark.
  _autoTaxi(dt, c) {
    const b = this.body, T = b.T, j = this.job;
    c.elevator = 0; c.aileron = 0; c.rudder = 0; c.reverse = 0; c.speedbrake = false;
    if (!j || !j.route) { this.lever = 0; c.throttle = 0; c.brake = 1; c.steer = 0; return; }
    const P = j.route.path, s0 = j.routeS, v = b.gs;
    // Pure pursuit from the main gear to a point down the route.
    const L = T.gear.mains[1] - T.gear.nose, ld = Math.max(7, L * 1.1) + v * 1.8;
    const mg = b.worldPoint(0, 0, T.gear.mains[1], this._w);
    const sq = s0 + ld - L;
    let q = P.at(Math.min(P.length, sq));
    // Near the end, aim on past it along the last bit (a stand's lead-in line), so she arrives lined up.
    if (sq > P.length) { const ex = sq - P.length; q = { x: q.x + q.tx * ex, z: q.z + q.tz * ex }; }
    const alpha = wrapAngle(Math.atan2(q.x - mg.x, -(q.z - mg.z)) - b.heading);
    const delta = Math.atan2(2 * L * Math.sin(alpha), Math.max(ld, Math.hypot(q.x - mg.x, q.z - mg.z)));
    const smax = T.steer * (1 - clamp((v - 3) / 15, 0, 0.9));
    c.steer = clamp(delta / Math.max(0.05, smax), -1, 1);
    // Down a stand's lead-in: put the nosewheel on the line (Stanley-style: the
    // line's heading plus a correction for being off it), so she parks centred.
    // (Only on the lead-in line itself, once she's turned most of the way onto it.)
    const stand = j.phase === 'toGate' ? j.gate : j.phase === 'taxiIn' ? j.arrGate : null;
    let onLead = !!stand && P.length - s0 < Math.min(45, (stand.lead ? stand.lead.length : 30) + 4);
    if (onLead) {
      const nw = j._noseWheel(), qn = P.at(Math.min(P.length, s0 + 0.5));
      const he = wrapAngle(Math.atan2(qn.tx, -qn.tz) - b.heading);
      if (Math.abs(he) > 1.2) onLead = false;
      else {
        const off = (nw.x - qn.x) * -qn.tz + (nw.z - qn.z) * qn.tx;              // + = right of the line
        // (Gentle for a long wheelbase, softened at a crawl, and capped: else she swings past the line.)
        const kc = Math.min(1.4, 6 / Math.max(2, L));
        const corr = clamp(Math.atan2(kc * off, 2.5 + v), -0.6, 0.6);
        c.steer = clamp((he - corr) / Math.max(0.05, smax), -1, 1);
      }
    }
    // The way on is behind her (pure pursuit can't see it): slow right down and turn hard toward it.
    const behind = !onLead && Math.abs(alpha) > 1.75;
    if (behind) c.steer = alpha >= 0 ? 1 : -1;
    let vt = T.span > 40 ? 8 : 9;
    if (behind) vt = 2.5;
    if (P.length - s0 < 45 && (j.phase === 'toGate' || j.phase === 'taxiIn')) vt = Math.min(vt, 2.5);   // creep down the lead-in
    const bend = P.bendAhead(s0, 30 + v * 3);
    if (bend > 0.3) vt = Math.min(vt, 3 + 5 * (1 - Math.min(1, bend / 1.6)));
    let endS = P.length;
    if (j.phase === 'taxiOut' && j.hold && !j.cleared) endS = j.hold.s - 6;
    let left = endS - s0;
    // On the lead-in (the last bit of the route): stop with the nose on the mark.
    if (j.parkInfo && onLead) left = Math.min(left, j.parkInfo.along);
    vt = Math.min(vt, Math.sqrt(Math.max(0, 2 * 0.5 * (left - 0.4))));
    // Traffic: give way to an airliner moving across or along the way ahead.
    const P2 = this.g.planes;
    if (P2 && P2.planes && j.curAirport().code === 'BOS') {
      const fx = Math.sin(b.heading), fz = -Math.cos(b.heading);
      for (const p of P2.planes) {
        if (p.state === 'parked' || p.y > 5) continue;
        const dx = p.x - b.pos.x, dz = p.z - b.pos.z, ahead = dx * fx + dz * fz, lat = Math.abs(dx * -fz + dz * fx);
        if (ahead > 0 && ahead < 140 && lat < (T.span + p.T.span) / 2 + 8) vt = Math.min(vt, Math.max(0, (ahead - (T.len + p.T.len) / 2 - 20) * 0.15));
      }
    }
    const err = vt - v;
    this.lever = clamp(this.lever + err * 0.25 * dt, 0, T.engine === 'jet' ? 0.45 : 0.6);
    if (err < -0.6 || left < 0.6 || vt < 0.5) this.lever = 0;
    c.throttle = this.lever;
    c.brake = vt < 0.5 || left < 0.6 ? 1 : err < -0.8 ? clamp(-err * 0.4, 0, 1) : 0;
  }

  // Takeoff (tests): line up, full power, rotate at VR, climb out and clean up.
  _autoTakeoff(dt, c) {
    const b = this.body, T = b.T, A = this.ap;
    c.aileron = 0; c.rudder = 0; c.reverse = 0; c.brake = 0;
    const e = A.end;
    if (b.onGround) {
      const ax = e.fx, az = e.fz, dx = b.pos.x - e.x, dz = b.pos.z - e.z;
      const across = dx * -az + dz * ax;
      // Steer for a point down the centreline (further ahead as she speeds up); the nosewheel
      // loses its say with speed, so the rudder works with it.
      const he = wrapAngle(e.heading - Math.atan2(across, 30 + b.gs * 2.5) - b.heading);
      c.steer = clamp(he * 1.6, -1, 1);
      c.rudder = clamp(he * 2, -1, 1);
      // Lined up first, on the centreline and pointing down it: only then the power.
      const lined = Math.abs(wrapAngle(b.heading - e.heading)) < 0.12 && Math.abs(across) < 4;
      if (!lined && b.gs < 8) { this.lever = b.gs < 2.5 ? 0.3 : 0.12; c.throttle = this.lever; c.elevator = 0; return; }
      this.lever = Math.min(1, this.lever + dt * 0.5);
      c.throttle = this.lever;
      c.elevator = b.ias > b.vr() ? 0.85 : 0;
      return;
    }
    c.steer = 0;
    // Climb out at a steady pitch, then hand over to holding.
    c.elevator = b.agl < 40 ? 0.3 : 0;
    if (b.agl > 120 && T.gearRetract) b.gearDown = false;
    if (b.agl > 300) {
      if (b.flap > 0 && b.ias > T.flaps[Math.max(0, b.flap - 1)].vfe * 0.7) b.flap--;
      this.ap = { mode: 'hold', alt: b.pos.y + 300, heading: e.heading, speed: Math.min(T.vclimb, 250 * KT), test: true };
    }
    this.lever = 1; c.throttle = 1;
  }

  _autopilot(dt, c) {
    const b = this.body, T = b.T, A = this.ap;
    if (A.mode === 'taxi') { this._autoTaxi(dt, c); return; }
    if (A.mode === 'takeoff') { this._autoTakeoff(dt, c); return; }
    const gam = b.gamma, V = Math.max(10, b.ias);
    let gamD = 0, hdgD = A.heading ?? b.track, spd = A.speed ?? T.vcruise * 0.6, bankMax = 25 * DEG;
    if (A.mode === 'hold') {
      gamD = clamp(((A.alt - b.pos.y) * 0.004), -0.09, 0.09);
    } else if (A.mode === 'land') {
      const ap = A.airport, e = A.end;
      const a = ap.approach(e, b.pos.x, b.pos.y - T.cgH, b.pos.z, T.span);
      // Localizer: intercept and track the extended centreline.
      hdgD = e.heading + clamp(-a.across * 0.006, -0.5, 0.5);
      // Glideslope until the flare.
      const flareH = Math.max(4, T.span * 0.22);
      spd = b.vref() + 5 * KT;
      if (b.agl > flareH && !b.wheelsDown) {
        gamD = -3 * DEG + clamp(-a.dy * 0.012, -2.5 * DEG, 2.5 * DEG);
        if (a.along < 6000) { if (b.flap < T.flaps.length - 1 && b.ias < T.flaps[b.flap + 1].vfe - 3) b.flap++; b.gearDown = true; }
        bankMax = 15 * DEG;
      } else if (!b.wheelsDown) {
        // Flare: the sink rate tapers to about 2 ft/s at the wheels, power off.
        // (Floating far down the runway: put her on, a little firmer.)
        const aim = Math.min(400, e.length * 0.18, 110 + T.span * 5), long = -a.along - aim;
        const vsT = -clamp(0.55 + b.agl * 0.4, long > 500 ? 1.1 : 0.55, 4);
        gamD = Math.asin(clamp(vsT / Math.max(15, b.tas), -0.2, 0));
        spd = 0;
        bankMax = 3 * DEG;
      } else {
        // Rollout: nose down, reverse and brakes, steer the centreline.
        c.elevator = 0; c.aileron = 0;
        c.steer = clamp(-a.across * 0.08 - wrapAngle(b.heading - e.heading) * 2, -1, 1);
        c.rudder = c.steer * 0.5;
        this.lever = 0;
        c.throttle = 0;
        c.reverse = T.reverser && b.gs > 25 ? 1 : 0;
        if (c.reverse) c.throttle = 0.75;
        c.brake = b.noseDown ? 1 : 0;
        return;
      }
    }
    // Pitch: ask for the flight path through the stick (the FBW law does the rest);
    // in the flare, the nose comes up to land on the mains.
    // (In the flare the sink rates are small angles at this speed: a firmer hand near the runway.)
    // (Slower aircraft make bigger path angles for the same sink rate, so they need less of it.)
    const flareK = A.mode === 'land' && spd === 0 ? 5 + 22 * clamp(1 - b.agl / Math.max(4, T.span * 0.22), 0, 1) * clamp(V / 70, 0.3, 1) : 5;
    c.elevator = clamp((gamD - gam) * flareK, -1, 1);
    // (Nose up a little for the last few feet: she lands on the mains, not the nosewheel.
    // A light aircraft comes down nose-low with full flaps, so it gets a bit more.)
    if (A.mode === 'land' && spd === 0 && T.engine === 'piston' && b.agl < 2.5 && b.pitch < 2.5 * DEG) c.elevator = clamp(c.elevator + (2.5 * DEG - b.pitch) * 6, -1, 1);
    else if (A.mode === 'land' && spd === 0 && b.agl < 3 && b.pitch < 2 * DEG) c.elevator = clamp(Math.max(c.elevator, 0) + (2 * DEG - b.pitch) * 6, -1, 1);
    // Roll: bank toward the heading wanted.
    const dh = wrapAngle(hdgD - b.track);
    const phiD = clamp(dh * 2.2, -bankMax, bankMax);
    c.aileron = clamp((phiD - b.bank) * 2.5, -1, 1);
    c.rudder = 0;
    c.steer = 0;
    // Speed: throttle, and a little speed brake if it won't come down.
    if (spd > 0) {
      let inc = clamp((spd - b.ias) * 0.04, -0.5, 0.5) * dt + (gamD - gam) * 0.4 * dt;
      // Anti-windup: the lever doesn't run far ahead of what the engines are giving (they spool
      // up slowly); it can always come back.
      const spool = clamp((b.n1 - T.idle) / Math.max(0.05, 1 - T.idle), 0, 1);
      if (inc > 0 && this.lever > spool + 0.15) inc = 0;
      this.lever = clamp(this.lever + inc, T.engine === 'jet' ? 0.02 : 0, 1);
      c.speedbrake = A.mode === 'land' && b.ias > spd + 15 * KT && T.spoilers;
    } else this.lever = Math.max(0, this.lever - dt * 0.8);
    c.throttle = this.lever;
    c.brake = 0; c.reverse = 0;
  }

  // Edge-triggered keys while flying.
  action(name) {
    const b = this.body, T = b.T, hud = this.g.hud;
    switch (name) {
      case 'gear':
        if (!T.gearRetract) { hud.toast('Fixed gear', T.short + ' gear doesn\'t retract', 1200); return; }
        if (b.wheelsDown) { hud.toast('Weight on wheels', 'The gear stays down on the ground', 1300); return; }
        b.gearDown = !b.gearDown;
        hud.toast(b.gearDown ? 'Gear down' : 'Gear up', '', 1000);
        this.g.audio.tone?.([b.gearDown ? 440 : 520], 0.12, 'triangle', 0.08);
        break;
      case 'flapsUp': case 'flapsDown': {
        if (T.engine === 'blimp') { this.ballast = clamp((this.ballast || 0) + (name === 'flapsUp' ? 0.25 : -0.25), -1, 1); hud.toast(this.ballast > 0 ? 'Ballast out: lighter' : this.ballast < 0 ? 'Valving helium: heavier' : 'Trimmed', 'Glimp', 1000); return; }
        const n = T.flaps.length - 1;
        b.flap = clamp(b.flap + (name === 'flapsDown' ? 1 : -1), 0, n);
        hud.toast(`Flaps ${T.flaps[b.flap].name}`, b.ias > T.flaps[b.flap].vfe ? 'Too fast for this setting!' : '', 900);
        break;
      }
      case 'autopilot': this.toggleAutopilot(); break;
      case 'speedbrake':
        if (!T.spoilers) return;
        this.speedbrake = !this.speedbrake;
        hud.toast(this.speedbrake ? 'Speed brakes out' : 'Speed brakes in', '', 900);
        break;
      case 'faster': case 'slower': {
        const i = SIM_RATES.indexOf(this.sim);
        const ni = clamp(i + (name === 'faster' ? 1 : -1), 0, SIM_RATES.length - 1);
        if (ni > i && !this._canWarp()) { hud.toast('Time compression', 'Only in the air, above 1,000 ft and clear of trouble', 1600); return; }
        this.sim = SIM_RATES[ni];
        hud.toast(this.sim > 1 ? `Time ×${this.sim}` : 'Normal time', '[ slower · ] faster', 1100);
        break;
      }
    }
  }

  _canWarp() {
    const b = this.body;
    return b && !b.onGround && b.agl > 300 && !b.crashed && b.stall < 0.3 && (!this.job || this.job.canWarp());
  }

  // ------------------------------------------------------------ per frame
  update(dt, inp) {
    const g = this.g, b = this.body;
    if (!b) return;
    this.cloud = this.cloudLayer();
    const ctl = this._controls(dt, inp);
    if (this.job) this.job.preStep(dt);
    if (this.sim > 1 && !this._canWarp()) { this.sim = 1; g.hud.toast('Normal time', '', 900); }
    const sdt = dt * this.sim;
    if (!this.hold) {
      this.acc = Math.min(this.acc + sdt, STEP * 14 * this.sim);
      while (this.acc >= STEP) {
        b.step(STEP, ctl, this.env);
        this.simTime += STEP;
        this._track();
        this.acc -= STEP;
        if (this.crash) break;
      }
    } else this.acc = 0;
    this._events(dt);
    if (this.job) this.job.update(sdt, dt);
    poseAircraft(this.model, b, dt, g.sky.nightAmount, g.camera);
    // Moored blimp: nose to the mast, swinging with the wind.
    if (this.moored && b.T.engine === 'blimp') this._mooredUpdate(dt);
    this.model.root.updateMatrixWorld(true);
    this.camera.lookBack = false;
    this.camera.update(dt, b, this.model, this, g.collision);
    g.sky.setCloudFog?.(this._cloudFog());
    // Tell Logan's traffic where we are (runway occupancy, stopping for us).
    if (g.planes && g.planes.setPlayer) {
      const ap = this.airport('BOS');
      const rw = ap && b.agl < 40 ? ap.onRunway(b.pos.x, b.pos.z, 30) : null;
      g.planes.setPlayer({ x: b.pos.x, z: b.pos.z, y: b.pos.y - g.planes.elev - b.T.cgH, heading: b.heading, span: b.T.span, len: b.T.len, ri: rw ? rw.rw.ri : -1, ground: b.onGround });
    }
    this._sound(dt);
  }

  // Bookkeeping every physics step: comfort, limits.
  _track() {
    const b = this.body, T = b.T;
    if (!b.onGround) {
      this.maxG = Math.max(this.maxG, b.gload); this.minG = Math.min(this.minG, b.gload);
      this.maxBank = Math.max(this.maxBank, Math.abs(b.bank));
    }
    if (b.ias > T.vmo * 1.02 || b.mach > T.mmo + 0.01) this.overspeedT += STEP;
    // A hard enough contact ends the flight.
    if (!this.crash && b.contact) {
      const c = b.contact, kind = c.kind;
      // A building: in the air that's the end; on the ground a wing, fin or tail
      // brushing a terminal is a strike (damage), the nose into it at speed a crash.
      const wing = c.part === 'wingL' || c.part === 'wingR' || c.part === 'fin' || c.part === 'tail' || c.part === 'tailcone';
      if (kind === GROUND.BUILDING && !b.onGround && c.speed > 5) this._crash(wing ? 'Wing into a building' : 'Hit a building', c.speed);
      else if (kind === GROUND.BUILDING && b.onGround && !wing && c.speed > 8) { this.hitInfo = { part: c.part, x: Math.round(b.pos.x), z: Math.round(b.pos.z), routeS: this.job && this.job.routeS, off: this.job && this.job.offRoute }; this._crash('Taxied into a building', c.speed); }
      else if (kind === GROUND.BUILDING) { this._strike(wing ? (c.part === 'fin' ? 'Fin strike!' : 'Wingtip strike!') : 'Bumped a building', c); }
      else if ((kind === GROUND.WATER || kind === GROUND.SEA) && T.engine !== 'blimp') this._crash('Ditched in the water', c.speed);
      else if (c.vs > (c.part === 'belly' ? 5 : 3.5) || (c.speed > 25 && (c.part === 'nosecone' || c.part === 'prop' || c.part === 'fin'))) this._crash(c.part === 'wingL' || c.part === 'wingR' ? 'Cartwheeled on a wingtip' : 'Hit the ground', c.speed);
      else this._strike(c.part === 'tail' || c.part === 'tailcone' ? 'Tail strike!' : c.part === 'belly' ? (b.gearPos < 0.5 ? 'Gear-up landing!' : 'Belly scrape!') : c.part === 'engine' ? 'Engine pod strike!' : c.part === 'prop' ? 'Prop strike!' : c.part.startsWith('wing') ? 'Wingtip strike!' : 'Scrape!', c);
    }
    if (!this.crash && b.crashed) this._crash(b.crashed.reason === 'water' ? 'Ditched in the water' : 'Crashed', b.crashed.speed || b.speed);
    // Touchdown sink rate past the gear's limits.
    if (!this.crash && b.lastTouch && !b.lastTouch.rated) {
      b.lastTouch.rated = true;
      const fpm = (b.lastTouch.vs / FT) * 60;
      if (fpm > 1100) this._crash('The gear collapsed', b.speed);
    }
    // Midair or on the ground: Logan's airliners.
    if (!this.crash && this.g.planes && this.g.planes.planes) {
      const hit = this._planeHit();
      if (hit) this.hitInfo = { state: hit.plane.state, key: hit.plane.key, v: hit.plane.v, d: Math.hypot(hit.plane.x - b.pos.x, hit.plane.z - b.pos.z), mine: b.speed,
        parked: hit.plane.parkedAt ? +(performance.now() / 1000 - hit.plane.parkedAt).toFixed(1) : null, cleared: this.g.planes.lastClear, stand: hit.plane.stand && hit.plane.stand.ref,
        res: hit.plane.stand && (hit.plane.stand.reserved === this.g.planes.playerToken ? 'player' : !!hit.plane.stand.reserved), route: this.job && this.job.route ? this.job.route.path.pts.length : 0,
        at: [Math.round(b.pos.x), Math.round(b.pos.z)], them: [Math.round(hit.plane.x), Math.round(hit.plane.z)], now: +(performance.now() / 1000).toFixed(1),
        s: this.job ? Math.round(this.job.routeS) : null, off: this.job ? +(this.job.offRoute || 0).toFixed(1) : null, toRoute: this.job && this.job.route ? Math.round(polyDist(this.job.route.path.pts, hit.plane.x, hit.plane.z)) : null };
      if (hit) {
        if (b.speed + hit.speed > 9 || !b.onGround) this._crash(b.onGround ? 'Collided with an airliner' : 'Midair collision', b.speed);
        else if (!hit.plane.struckByPlayer) { hit.plane.struckByPlayer = true; this._strike('Wingtip strike on an airliner!', { part: 'wing', speed: b.speed }); }   // (a touch counts once)
      }
    }
  }

  _strike(msg, c) {
    const now = this.simTime;
    if (now - (this._strikeT || -9) < 2) return;
    this._strikeT = now;
    this.strikes++;
    this.damage += 1;
    this.g.hud.message(msg, c.speed > 1 ? 'Damage reported' : '', 1600, '#ffb020');
    this.g.audio.crash(0.35);
    this.camera.bump(0.5);
    if (this.job) this.job.onStrike(msg);
  }

  _crash(reason, speed) {
    const b = this.body;
    this.crash = { reason, speed, t: this.simTime };
    // Where and how (for the tests' reports): relative to the arrival runway when there is one.
    const j = this.job, e = j && j.arrEnd, ap = j && (j.to || j.from);
    const a = e && ap ? ap.approach(e, b.pos.x, b.pos.y - b.T.cgH, b.pos.z, b.T.span) : null;
    this.crashAt = { x: Math.round(b.pos.x), z: Math.round(b.pos.z), agl: +b.agl.toFixed(1), vs: +b.vs.toFixed(1), ias: Math.round(b.ias / KT), part: b.contact && b.contact.part, kind: b.contact && b.contact.kind,
      rwy: e ? e.name : null, along: a ? Math.round(a.along) : null, across: a ? Math.round(a.across) : null, flap: b.flap, gear: +b.gearPos.toFixed(2), ap: this.ap && this.ap.mode, phase: j && j.phase };
    if (!b.crashed) b.crashed = { reason };
    this.lever = 0;
    this.sim = 1;
    this.g.audio.crash(1);
    this.camera.bump(1.2);
    this.g.hud.message('Crashed', reason, 3200, '#ff3b3b');
    this._fire();
    if (this.job) this.job.onCrash(reason);
    else setTimeout(() => {
      if (this.active && this.crash && this.g.state === 'air') this.g.showResults({ flight: true, crashed: true, title: `${b.T.name}`, reason, airport: this.flightAirport ? this.flightAirport.short : '' });
    }, 3500);
  }

  // A fireball and smoke where she came down.
  _fire() {
    const b = this.body, g = this.g;
    if (this.fireFx) this.fireFx.removeFromParent();
    const grp = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const smoke = new THREE.MeshStandardMaterial({ color: 0x22252a, transparent: true, opacity: 0.55, depthWrite: false, roughness: 1 });
    const s = Math.max(4, b.T.span * 0.25);
    for (let k = 0; k < 7; k++) {
      const f = new THREE.Mesh(new THREE.SphereGeometry(s * (0.4 + Math.random() * 0.4), 10, 8), k < 3 ? mat : smoke);
      f.position.set((Math.random() - 0.5) * s, s * 0.2 + k * s * 0.35, (Math.random() - 0.5) * s);
      f.userData.k = k;
      grp.add(f);
    }
    grp.position.copy(b.pos);
    g.scene.add(grp);
    this.fireFx = grp;
    this.fireT = 0;
  }

  // Touching one of Logan's airliners: fuselages and wings as lines with a
  // height band each (a wing passes over a smaller jet's fuselage, not its fin).
  _planeHit() {
    const b = this.body, P = this.g.planes, T = b.T, elev = P.elev;
    const fx = b.fwd.x, fz = b.fwd.z, fl = Math.hypot(fx, fz) || 1;
    const ax = fx / fl, az = fz / fl;
    const gy = b.pos.y - T.cgH;                                     // her wheels' level
    const wingH = T.wing ? T.cgH + T.wing.y + Math.tan(T.wing.dihedral * DEG) * T.span * 0.3 : T.cgH;   // (the blimp: her envelope)
    const mine = [
      [b.pos.x - ax * T.len * 0.45, b.pos.z - az * T.len * 0.45, b.pos.x + ax * T.len * 0.45, b.pos.z + az * T.len * 0.45, T.fus.W / 2, T.cgH - T.fus.H / 2, T.cgH + T.fus.H / 2],
      [b.pos.x - az * T.span / 2, b.pos.z + ax * T.span / 2, b.pos.x + az * T.span / 2, b.pos.z - ax * T.span / 2, 0.6, wingH - 1, wingH + 1],
    ];
    for (const p of P.planes) {
      const dx = p.x - b.pos.x, dz = p.z - b.pos.z;
      const lim = (p.T.span + T.span) / 2 + 5;
      if (Math.abs(dx) > lim || Math.abs(dz) > lim) continue;
      const py = p.y + elev - gy;                                   // its wheels relative to ours
      const px = Math.sin(p.heading), pz = -Math.cos(p.heading), R = p.T.dia / 2, yc = py + R + p.T.clear;
      const theirs = [
        [p.x - px * p.T.len * 0.45, p.z - pz * p.T.len * 0.45, p.x + px * p.T.len * 0.45, p.z + pz * p.T.len * 0.45, R, yc - R, yc + R],
        [p.x - pz * p.T.span / 2, p.z + px * p.T.span / 2, p.x + pz * p.T.span / 2, p.z - px * p.T.span / 2, 0.6, yc - R * 0.9, yc - R * 0.2],
        [p.x + px * p.T.len * 0.38, p.z + pz * p.T.len * 0.38, p.x + px * p.T.len * 0.5, p.z + pz * p.T.len * 0.5, 0.4, yc, py + p.T.fin],
      ];
      for (const A of mine) for (const B of theirs) {
        if (A[6] < B[5] || A[5] > B[6]) continue;                  // different heights
        if (segSeg(A, B) < A[4] + B[4]) return { plane: p, speed: p.v || 0 };
      }
    }
    return null;
  }

  // Messages for touchdowns and strikes, the crash, unlocking an island.
  _events(dt) {
    const b = this.body, g = this.g;
    if (this.fireFx) {
      this.fireT += dt;
      for (const f of this.fireFx.children) { f.scale.setScalar(1 + Math.sin(this.fireT * 6 + f.userData.k) * 0.1 + this.fireT * 0.05 * (f.userData.k >= 3 ? 1 : 0)); f.position.y += dt * (f.userData.k >= 3 ? 2 : 0.3); }
    }
    if (b.lastTouch && b.lastTouch !== this._ratedTouch && !this.crash) {
      this._ratedTouch = b.lastTouch;
      const fpm = (b.lastTouch.vs / FT) * 60, r = rateLanding(fpm);
      b.lastTouch.fpm = fpm; b.lastTouch.rating = r;
      const ap = this.nearestAirport(b.pos.x, b.pos.z);
      const rw = ap && ap.dist < 6000 ? ap.airport.onRunway(b.pos.x, b.pos.z, 6, b.heading) : null;
      b.lastTouch.runway = rw ? rw.rw.ref : null;
      b.lastTouch.airport = ap && ap.dist < 6000 ? ap.airport : null;
      g.hud.message(`${r.name} landing`, `${Math.round(fpm)} fpm${rw ? '' : ' · off the runway!'}${b.lastTouch.noseFirst ? ' · nosewheel first!' : ''}`, 2400, r.color);
      g.audio.touchdown?.(Math.min(1, fpm / 600));
      if (this.job) this.job.onTouchdown(b.lastTouch);
    }
    // Landed on an island (down and slowed to taxi speed, having flown out there): it's unlocked.
    if (!this.crash && b.onGround && b.groundTime > 2 && b.gs < 15 && this.flownFar && this.simTime > 5) {
      const R = this.regionAt(b.pos.x, b.pos.z);
      const id = R && R.map && R.map.meta.region;
      if (id && id !== 'boston' && !this.unlocked.has(id) && this.flownFar) this.unlock(id);
    }
    if (!b.onGround && b.agl > 150) this.flownFar = true;
    // The Glimp: nose up to a mast (every airfield has one), slow and low, and
    // the ground crew takes her lines. A little power is fine: into the wind
    // she needs some to creep up to it.
    if (b.T.engine === 'blimp' && !this.moored && this.lever < 0.45 && b.gs < 3 && this.simTime > 8) {
      for (const ap of this.loadedAirports()) {
        if (Math.hypot(b.pos.x - ap.x, b.pos.z - ap.z) > 6000) continue;
        const m = this.mastAt(ap), nose = b.worldPoint(0, 0, -b.T.fus.zNose, this._v);
        const dy = nose.y - (ap.elev + m.top);
        if (Math.hypot(nose.x - m.x, nose.z - m.z) < 14 && dy > -3 && dy < 12) {
          this.moored = m;
          this.lever = 0;
          this.g.hud.message('Moored', `On the mast at ${ap.short}`, 2400, '#7ee081');
          this.g.audio.checkpoint();
          if (this.job) this.job.onMoored?.(ap);
        }
      }
    }
  }

  unlock(id) {
    this.unlocked.add(id);
    saveJSON('rb.unlocked', [...this.unlocked]);
    const name = id === 'vineyard' ? "Martha's Vineyard" : id === 'nantucket' ? 'Nantucket' : id;
    this.g.audio.finish();
    this.g.hud.message(`${name} unlocked!`, 'Start there from the menu: drive, sail and race the island', 4200, '#ffd447');
    if (this.job) this.job.onUnlock?.(id);
  }

  _mooredUpdate(dt) {
    const b = this.body, m = this.moored;
    // Held at the nose: she weathervanes about the mast.
    const nose = b.worldPoint(0, 0, -b.T.fus.zNose, this._v);
    const dx = m.x - nose.x, dz = m.z - nose.z;
    b.pos.x += dx * Math.min(1, dt * 2); b.pos.z += dz * Math.min(1, dt * 2);
    // The crew walks her down onto the mast cup.
    if (m.elev !== undefined) b.pos.y += (m.elev + m.top + 0.42 - nose.y) * Math.min(1, dt * 1.2);
    b.vel.multiplyScalar(Math.exp(-dt * 3));
    if (this.lever > 0.25) { this.moored = null; this.g.hud.message('Cast off!', 'The ground crew lets go of the lines', 1800, '#7ee081'); }
  }

  _cloudFog() {
    const c = this.cloud, cam = this.g.camera.position;
    if (!c) return 0;
    if (cam.y < c.base || cam.y > c.top) return 0;
    return Math.min(1, (cam.y - c.base) / 60, (c.top - cam.y) / 60);
  }

  _sound(dt) {
    const b = this.body, a = this.g.audio, T = b.T;
    a.setAircraft?.({ kind: T.engine, n1: b.n1, speed: b.tas, inside: this.camera.mode === 2, engines: T.engines, big: T.span > 40 ? 1 : T.span > 20 ? 0.6 : 0.2 });
    a.setWind(b.tas * (this.camera.mode === 2 ? 0.5 : 1));
    // Stall warning, overspeed.
    a.setWarn?.(b.stall > 0.6 && !b.onGround ? 'stall' : b.ias > T.vmo * 1.02 ? 'overspeed' : null);
    if (this.job && this.job.sound) this.job.sound(dt);
  }

  // The tower (and the odd callout), spoken if the browser can.
  say(text) {
    if (this.g.settings.voice === false || !this.g.settings.sound || typeof speechSynthesis === 'undefined') return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.1; u.pitch = 0.92; u.volume = 0.75;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch { /* no voice */ }
  }

  // ------------------------------------------------------------ queries
  pose(out = {}) {
    const b = this.body;
    out.x = b ? b.pos.x : 0; out.y = b ? b.pos.y - (b.T.cgH || 0) : 0; out.z = b ? b.pos.z : 0; out.heading = b ? b.heading : 0;
    return out;
  }

  // ------------------------------------------------------------ HUD
  hud(metric) {
    const g = this.g, b = this.body, T = b.T, hud = g.hud;
    if (this.pfd) {
      this.pfd.cv.classList.remove('hidden');
      document.getElementById('speedo')?.classList.add('hidden');
      this.pfd.draw(this._pfdState(metric));
    }
    // Location under her.
    this._locT = (this._locT || 0) - 1;
    if (this._locT <= 0) {
      this._locT = 15;
      const R = this.regionAt(b.pos.x, b.pos.z);
      if (R && R.map === g.map) {
        g.updateLocation(0.25, b.pos.x, b.pos.z, b.pos.y - b.agl);
        if (b.agl > 60) hud.setStreet('Over ' + (hud.streetName.textContent || R.map.meta.name || 'Boston'), hud.streetArea.textContent);
      } else hud.setStreet(this._seaName(b.pos.x, b.pos.z), R ? R.map.meta.name || '' : 'Atlantic Ocean');
    }
    if (this.job) { this.job.hud(metric); return; }
    const near = this.nearestAirport(b.pos.x, b.pos.z);
    const sub = this.crash ? this.crash.reason : this.moored ? 'Moored at the mast: W to throttle up and cast off'
      : b.onGround && b.speed < 1 ? `On the ground at ${near && near.dist < 5000 ? near.airport.short : 'an open field'}`
      : b.onGround ? (b.ias > T.vr * 0.9 ? 'Rotate! Pull back (↓)' : 'Rolling') : near ? `${near.airport.short} ${formatDistance(near.dist, metric)}` : 'Free flight';
    hud.setMission({
      title: `${T.engine === 'blimp' ? 'Glimp flight' : 'Free flight'} · ${T.short}`,
      sub,
      extra: this.keysHelp(),
    });
    hud.setScore(null);
  }

  keysHelp() {
    const T = this.body.T;
    if (T.engine === 'blimp') return 'W/S throttle (S reverses) · ↑↓ pitch: climb / descend · A D or Q E rudder · Z X ballast · Space brake<br>C camera · [ ] time · drag to look · Enter get out (on the ground)';
    return `W/S throttle${T.reverser ? ' (S at idle on the ground: reverse)' : ''} · ↑↓ pitch · A D roll / steer · Q E rudder · Space brakes<br>Z X flaps · ${T.gearRetract ? 'G gear · ' : ''}${T.spoilers ? 'B speed brakes · ' : ''}C camera · [ ] time · Enter get out (stopped)`;
  }

  _seaName(x, z) {
    const lat = this.g.map.meta.origin.lat - z / this.g.map.meta.metersPerDegree.lat;
    const lon = this.g.map.meta.origin.lon + x / this.g.map.meta.metersPerDegree.lon;
    if (lat > 42.05) return 'Massachusetts Bay';
    if (lat > 41.75 && lon > -70.5) return 'Cape Cod Bay';
    if (lat < 41.45 && lon > -70.6 && lat > 41.32 && lon < -70.0) return 'Nantucket Sound';
    if (lat > 41.4 && lon < -70.6 && lon > -70.95) return 'Vineyard Sound';
    if (lon < -70.75 && lat > 41.45) return 'Buzzards Bay';
    return 'Atlantic Ocean';
  }

  _pfdState(metric) {
    const b = this.body, T = b.T, w = this.g.weather;
    const vel = b.vel, sp = vel.length();
    // Flight path marker: velocity direction relative to the nose, in degrees.
    let fpv = null;
    if (sp > 8) {
      const inv = this._qi || (this._qi = new THREE.Quaternion());
      inv.copy(b.q).invert();
      const v = this._v.copy(vel).applyQuaternion(inv);
      fpv = { x: Math.atan2(v.x, -v.z), y: Math.atan2(v.y, Math.hypot(v.x, v.z)) };
    }
    this._lastIas = this._lastIas ?? b.ias;
    const accel = (b.ias - this._lastIas) * 60;
    this._lastIas = b.ias;
    this._accS = (this._accS || 0) + (accel - (this._accS || 0)) * 0.08;
    const fl = T.flaps[b.flap];
    const gearState = !T.gearRetract ? 'FIXED' : b.gearPos > 0.98 ? 'DOWN' : b.gearPos < 0.02 ? 'UP' : 'TRANSIT';
    let warn = null, red = false;
    if (this.crash) { warn = 'CRASHED'; red = true; }
    else if (b.stall > 0.6 && !b.onGround) { warn = 'STALL'; red = true; }
    else if (b.ias > T.vmo * 1.02 || b.mach > T.mmo + 0.01) { warn = 'OVERSPEED'; red = true; }
    else if (!b.onGround && b.agl < 150 && b.vs < -12) { warn = 'PULL UP'; red = true; }
    else if (!b.onGround && T.gearRetract && b.gearPos < 0.5 && b.agl < 250 && b.vs < -1 && b.flap >= T.flaps.length - 2) warn = 'GEAR NOT DOWN';
    else if (b.ias > fl.vfe * 1.03) warn = 'FLAP OVERSPEED';
    // A jet's takeoff configuration warning: power up on the ground with less than takeoff flap.
    else if (T.engine === 'jet' && b.onGround && b.throttle > 0.7 && b.flap < T.toFlap && b.gs > 2) { warn = 'CONFIG FLAPS'; red = true; }
    else if (b.protect && !b.onGround) warn = 'ALPHA PROT';
    else if (Math.abs(b.bank) > 45 * DEG && !b.onGround) warn = 'BANK ANGLE';
    else if (this.moored) warn = 'MOORED';
    const target = this.job ? this.job.navTarget() : null;
    const ils = this.job ? this.job.ils() : this._freeIls();
    return {
      metric, ias: b.ias, gs: b.gs, mach: b.mach, alt: b.pos.y - T.cgH, agl: b.agl, vs: b.vs, pitch: b.pitch, bank: b.bank, beta: b.beta,
      heading: b.heading, track: b.track, fpv, accel: this._accS, vr: b.onGround || b.agl < 30 ? b.vr() : null, vref: b.vref(), vs0: b.stallSpeed(b.flapPos),
      vmax: Math.min(T.vmo, T.mmo * b.atm.a * Math.sqrt(b.atm.sigma)), vfe: fl.vfe, overspeed: b.ias > T.vmo,
      engines: T.engines, jet: T.engine === 'jet', blimp: T.engine === 'blimp', n1: T.engine === 'blimp' ? b.blimpThrottle || 0 : b.n1, throttle: T.engine === 'blimp' ? this.lever : b.throttle, reverse: b.reverse,
      flaps: fl.name, flapMoving: Math.abs(b.flapPos - b.flap) > 0.02, gear: gearState, spoiler: b.spoiler, spoilersArmed: T.spoilers, brake: this.ctl.brake > 0.1 || b.parkBrake, parking: b.parkBrake,
      sim: this.sim, assist: this.ctl.assist, trim: this.ballast || 0, moored: !!this.moored,
      windFrom: Math.atan2(-b.wind.x, b.wind.z), windSpeed: Math.hypot(b.wind.x, b.wind.z), turb: this.turb.level, gload: b.gload,
      warn, warnRed: red, target, ils, course: target ? target.course : null,
    };
  }

  // In free flight: approach guidance to the runway she's lined up with.
  _freeIls() {
    const b = this.body;
    if (b.onGround || b.agl > 1500) return null;
    const n = this.nearestAirport(b.pos.x, b.pos.z);
    if (!n || n.dist > 20000) return null;
    const e = n.airport.alignedEnd(b.pos.x, b.pos.z, b.track);
    if (!e) return null;
    const a = n.airport.approach(e, b.pos.x, b.pos.y - b.T.cgH, b.pos.z, b.T.span);
    if (a.along < 200 || a.along > 18000) return null;
    return { loc: a.loc, gs: a.gsAng, end: e };
  }

  overlays() {
    if (this.job) return this.job.overlays();
    const markers = [];
    for (const a of this.loadedAirports()) markers.push({ x: a.x, z: a.z, r: 7, color: '#59d3ff', label: '✈', edge: false });
    return { markers };
  }
}

// ---------------------------------------------------------------- camera
class FlightCamera {
  constructor(camera) {
    this.cam = camera;
    this.mode = 0;
    this.look = new DragLook(-1.3, 1.0);
    this.pos = new THREE.Vector3(); this.tgt = new THREE.Vector3(); this.up = new THREE.Vector3(0, 1, 0);
    this._init = false;
    this.shake = 0;
    this.tower = null;
    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
  }
  cycle() { this.mode = (this.mode + 1) % FLIGHT_CAMERAS.length; this._init = false; this.tower = null; return FLIGHT_CAMERAS[this.mode]; }
  snap() { this._init = false; this.tower = null; }
  bump(a) { this.shake = Math.min(1.5, this.shake + a); }
  drag(dx, dy) { this.look.drag(dx, dy); }
  release() { this.look.release(); }

  update(dt, b, model, fm, cw) {
    const cam = this.cam, T = b.T, L = this.look;
    L.update(dt);
    const inside = this.mode === 2;
    for (const m of model.inside) m.visible = !inside;
    const D = T.cam, alt = b.pos.y;
    // Shake: turbulence, the stall buffet, a rough touchdown.
    this.shake = Math.max(0, this.shake - dt * 1.6);
    const turb = fm.turb.level * (b.onGround ? 0.2 : 1) + b.stall * 0.6 + fm.turb.jolt * 0.8 + (b.onGround && b.speed > 20 && b.groundKind !== GROUND.PAVED ? 0.25 : 0);
    const sh = (this.shake * this.shake * 0.5 + turb * 0.18) * (inside ? 0.6 : Math.max(0.4, D / 40));
    const t = performance.now() / 1000;
    const jx = Math.sin(t * 37) * sh * 0.5, jy = Math.sin(t * 29 + 1) * sh * 0.4, jz = Math.cos(t * 33) * sh * 0.5;
    let near = 0.4, fov = 60;
    if (inside) {
      // The pilot's seat: rolls and pitches with her; drag turns the head.
      const e = model.eye;
      const p = b.worldPoint(e.x, e.y, e.z, this._v);
      cam.position.set(p.x + jx * 0.05, p.y + jy * 0.05, p.z);
      this._e.set(L.pitch * 0.9, L.yaw, 0, 'YXZ');
      this._q.setFromEuler(this._e);
      cam.quaternion.copy(b.q).multiply(this._q);
      near = 0.12; fov = 68;
    } else if (this.mode === 3) {
      // Tower: a fixed spot ahead along the way she's going; jump ahead when she's passed it.
      const P = b.pos;
      if (!this.tower || P.distanceTo(this.tower) > Math.max(1800, D * 22)) {
        const tk = b.track, ahead = Math.max(300, b.speed * 9 + D * 3), side = D * 1.6 + 30;
        const x = P.x + Math.sin(tk) * ahead + Math.cos(tk) * side, z = P.z - Math.cos(tk) * ahead + Math.sin(tk) * side;
        const gh = fm.ground(x, z, { h: 0 }).h;
        this.tower = new THREE.Vector3(x, Math.max(gh + 2 + Math.min(40, D * 0.3), b.onGround ? gh + 3 : P.y - 15 - D * 0.3), z);
      }
      cam.position.copy(this.tower);
      cam.up.set(0, 1, 0);
      cam.lookAt(P);
      const dist = this.tower.distanceTo(P);
      fov = clamp(2 * Math.atan((T.span * 1.8 + 10) / dist) / DEG, 4, 60);
      near = Math.max(0.5, dist * 0.02);
    } else {
      // Chase: behind along the track, above; doesn't roll with her (a little lean).
      const far = this.mode === 1;
      const dist = D * (far ? 1.9 : 1) * (1 + Math.min(0.4, b.tas / 400));
      const hdg = b.gs > 6 ? b.track : b.heading;
      const pitch = clamp(b.pitch * 0.5, -0.5, 0.5);
      const orbit = hdg + L.yaw, elev = clamp(0.16 + (far ? 0.08 : 0) - L.pitch * 0.9 - pitch * 0.4, -0.6, 1.4);
      const ce = Math.cos(elev), se = Math.sin(elev);
      const px = b.pos.x - Math.sin(orbit) * ce * dist, py = b.pos.y + se * dist + dist * 0.04, pz = b.pos.z + Math.cos(orbit) * ce * dist;
      const tx = b.pos.x + b.fwd.x * dist * 0.12, ty = b.pos.y + dist * 0.06, tz = b.pos.z + b.fwd.z * dist * 0.12;
      if (!this._init) { this.pos.set(px, py, pz); this.tgt.set(tx, ty, tz); this._init = true; }
      const k = damp(b.onGround ? 6 : 4.5, dt), kt = damp(9, dt);
      this.pos.x += (px - this.pos.x) * k; this.pos.y += (py - this.pos.y) * k; this.pos.z += (pz - this.pos.z) * k;
      this.tgt.x += (tx - this.tgt.x) * kt; this.tgt.y += (ty - this.tgt.y) * kt; this.tgt.z += (tz - this.tgt.z) * kt;
      // Keep it off the ground.
      const gh = fm.ground(this.pos.x, this.pos.z, { h: 0 }).h;
      if (this.pos.y < gh + 1.5) this.pos.y = gh + 1.5;
      cam.position.set(this.pos.x + jx, this.pos.y + jy, this.pos.z + jz);
      const lean = clamp(-b.bank * 0.18, -0.25, 0.25);
      this.up.set(Math.cos(orbit) * Math.sin(lean), Math.cos(lean), Math.sin(orbit) * Math.sin(lean));
      cam.up.copy(this.up);
      cam.lookAt(this.tgt);
      near = Math.max(0.4, dist * 0.04);
      fov = 58 + clamp(b.tas / 12, 0, 8);
    }
    const portrait = cam.aspect < 1 ? 1 + (1 - cam.aspect) * 0.75 : 1;
    cam.fov += (fov * portrait - cam.fov) * (this.mode === 3 ? 1 : damp(4, dt));
    cam.near = near;
    cam.far = clamp(3600 + Math.max(0, alt) * 14, 3600, 60000);
    cam.updateProjectionMatrix();
    cam.up.set(0, 1, 0);
  }
}

// Distance from a point to a polyline [[x, z], ...].
function polyDist(pts, x, z) {
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / l2, 0, 1);
    d = Math.min(d, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return d;
}

function segSeg(A, B) {
  // Distance between 2D segments A=[ax,az,bx,bz] and B.
  const d = (p, q, r, s, t, u) => Math.sqrt(segDist2(p, q, r, s, t, u));
  const [a0, a1, a2, a3] = A, [b0, b1, b2, b3] = B;
  const cross = (x1, z1, x2, z2) => x1 * z2 - z1 * x2;
  const r = [a2 - a0, a3 - a1], s = [b2 - b0, b3 - b1], den = cross(r[0], r[1], s[0], s[1]);
  if (Math.abs(den) > 1e-9) {
    const t = cross(b0 - a0, b1 - a1, s[0], s[1]) / den, u = cross(b0 - a0, b1 - a1, r[0], r[1]) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(d(a0, a1, b0, b1, b2, b3), d(a2, a3, b0, b1, b2, b3), d(b0, b1, a0, a1, a2, a3), d(b2, b3, a0, a1, a2, a3));
}

export { KT, FT };
