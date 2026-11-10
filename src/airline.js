// An airline flight, gate to gate. You start on a remote stand with the
// engines running and taxi to the gate, where the passengers board (over a
// jet bridge at Logan's terminals, otherwise walking out across the apron and
// up the stairs). A tug pushes a jet back; then you taxi to the runway the
// tower gives you (into the wind, and long enough), hold short until you're
// cleared, line up and take off. Fly to the destination (J skips ahead to the
// approach), land, taxi to the arrival gate and the passengers get off. The
// pay depends on the landing, how comfortable the ride was and how tidily
// you taxied and parked.

import * as THREE from 'three';
import { AIRCRAFT } from './aircraft.js';
import { AIRPORT_DEFS } from './airports.js';
import { Crowd, COAT, PANTS, HATS, SKIN } from './ferry.js';
import { makeLightMaterial } from './airport.js';
import { rateLanding, FT, KT } from './flightmode.js';
import { clamp, wrapAngle, formatDistance, formatTime, loadJSON, saveJSON, mulberry32 } from './util.js';
import { makeGroundPath } from './planes.js';

const DEG = Math.PI / 180;
const TAXI_LIMIT = 30 * KT;

// The flights on offer: the aircraft, from, to. Island routes need the island unlocked.
export function flightOffers(unlocked) {
  const isl = (c) => c === 'BOS' || unlocked.has(AIRPORT_DEFS[c].region);
  const all = [
    { id: 'c402-mvy', type: 'c402', from: 'BOS', to: 'MVY', name: 'Island hop to the Vineyard' },
    { id: 'c402-ack', type: 'c402', from: 'BOS', to: 'ACK', name: 'Island hop to Nantucket' },
    { id: 'e175-mvy', type: 'e175', from: 'BOS', to: 'MVY', name: "Regional jet to Martha's Vineyard" },
    { id: 'e175-ack', type: 'e175', from: 'BOS', to: 'ACK', name: 'Regional jet to Nantucket' },
    { id: 'a320-ack', type: 'a320', from: 'BOS', to: 'ACK', name: 'Summer jet to Nantucket' },
    { id: 'a320-mvy', type: 'a320', from: 'BOS', to: 'MVY', name: "Summer jet to Martha's Vineyard" },
    { id: 'b789-bos', type: 'b789', from: 'BOS', to: 'BOS', name: 'Dreamliner sightseeing over Boston Harbor' },
    { id: 'b789-ack', type: 'b789', from: 'BOS', to: 'ACK', name: 'Dreamliner to Nantucket (tight!)' },
    { id: 'a388-bos', type: 'a388', from: 'BOS', to: 'BOS', name: 'Superjumbo circuit of Logan' },
    { id: 'a388-ack', type: 'a388', from: 'BOS', to: 'ACK', name: 'Superjumbo dare: Nantucket\'s 6,300 ft runway' },
    { id: 'c402-mvy-ack', type: 'c402', from: 'MVY', to: 'ACK', name: 'Vineyard to Nantucket' },
    { id: 'c402-ack-bos', type: 'c402', from: 'ACK', to: 'BOS', name: 'Nantucket home to Logan' },
    { id: 'c402-mvy-bos', type: 'c402', from: 'MVY', to: 'BOS', name: 'The Vineyard home to Logan' },
    { id: 'e175-ack-bos', type: 'e175', from: 'ACK', to: 'BOS', name: 'Nantucket to Logan' },
    { id: 'a320-mvy-bos', type: 'a320', from: 'MVY', to: 'BOS', name: "Martha's Vineyard to Logan" },
  ];
  return all.map((o) => ({ ...o, locked: !isl(o.from) }));
}

export class FlightJob {
  // offer: { id, type, from, to, name }
  constructor(offer) {
    this.offer = offer;
    this.T = AIRCRAFT[offer.type];
    this.rng = mulberry32((Date.now() & 0xffffff) ^ 0x7f4a7c15);
    const T = this.T;
    this.pax = T.seats ? Math.round(T.seats * (0.72 + this.rng() * 0.26)) : 0;
    this.phase = 'toGate';
    this.root = new THREE.Group();
    this.t = 0;
    this.clock = 0;
    this.taxiOver = 0;
    this.incursions = 0;
    this.notes = [];
  }

  // Takeoff mass: empty, passengers and bags, fuel for the trip and reserves.
  mass() {
    const T = this.T, trip = this.offer.from === this.offer.to ? 150 : Math.max(100, this.distKm);
    const fuel = T.cls === 'commuter' ? 300 : T.cls === 'regional' ? 2600 + trip * 9 : T.cls === 'narrowbody' ? 4200 + trip * 14 : T.cls === 'widebody' ? 14000 + trip * 30 : 26000 + trip * 52;
    return T.empty + this.pax * T.paxMass + fuel + (T.cls === 'commuter' ? 90 : 400);
  }

  begin(fm) {
    this.fm = fm; this.g = fm.g;
    const g = this.g;
    g.scene.add(this.root);
    this.from = fm.airport(this.offer.from);
    this.to = fm.airport(this.offer.to);
    if (!this.from) throw new Error('departure airport not loaded');
    this.distKm = this.to ? Math.hypot(this.to.x - this.from.x, this.to.z - this.from.z) / 1000 : 50;
    const b = fm.body;
    b.mass = this.mass();
    // The gate first (near the terminal), then somewhere to start from away from it.
    this.gate = this._pickGate(this.from);
    let start = this._pickStart(this.from, this.gate);
    if (start === this.gate) {
      // A small field with nowhere else for her to start from: she's on the gate, boarding.
      const pg = fm.standPose(this.from, this.gate, this.T);
      b.reset(pg.x, this.from.elev + this.T.cgH + 0.01, pg.z, this.gate.heading, {});
      fm.lever = 0;
      this.startStand = start;
      this._buildLights();
      this.taxiStart = 0;
      this._onGate('boarding', this.gate, { along: 0, lat: 0, herr: 0 });
      this.fm.g.hud.toast(`${this.offer.name}`, `${this.T.airline || ''} ${this.T.short} · ${this.pax} passengers · boarding at gate ${this.gate.ref || ''}`, 4200);
      return;
    }
    const p = fm.standPose(this.from, start, this.T);
    b.reset(p.x, this.from.elev + this.T.cgH + 0.01, p.z, start.heading, {});
    // Point her out of the stand (as if pushed back already): along the lead-in, reversed.
    const lead = start.lead;
    if (lead && lead.length > 20) {
      const q = lead.at(Math.max(0, lead.length - Math.min(lead.length - 5, this.T.len * 0.6 + 15)));
      b.reset(q.x, this.from.elev + this.T.cgH + 0.01, q.z, Math.atan2(-q.tx, q.tz), {});
    } else {
      // A short ramp spot: turned round by the ground crew, the tail where the nose mark is.
      const tail = this.T.len - this.T.fus.zNose;
      b.reset(p.nx - start.fx * tail, this.from.elev + this.T.cgH + 0.01, p.nz - start.fz * tail, start.heading + Math.PI, {});
    }
    fm.lever = 0;
    this.startStand = start;
    // On an island ramp: now she's placed, the gate she can taxi onto cleanly from here.
    if (this.from.code !== 'BOS') { const nw = this._noseWheel(); this.gate = this._pickGate(this.from, { x: nw.x, z: nw.z, heading: b.heading, speed: 0, exclude: start }); }
    this._routeTo(this.gate.taxiNode, this._standTail(this.gate));
    this.fm.g.hud.toast(`${this.offer.name}`, `${this.T.airline || ''} ${this.T.short} · ${this.pax} passengers · taxi to gate ${this.gate.ref || ''}`, 4200);
    this._say(`${this._callsign()}, taxi to gate ${this.gate.ref || ''} via the green lights.`);
    this._buildLights();
    this.taxiStart = 0;
  }

  _callsign() { return (this.T.airline || 'Race Boston').split(' ')[0] + ' ' + (100 + Math.floor(this.rng() * 800)); }

  // Gates: terminal stands at Logan (a big jet at E), the spots nearest the terminal elsewhere.
  // from (an arrival): pick among the nearest by the taxi there, no hairpin onto the lead-in.
  _pickGate(ap, from = null) {
    const T = this.T, need = T.span * 0.55, P = this.g.planes;
    const terminal = { x: ap.x, z: ap.z };
    let list = ap.stands.filter((s) => (s.room || 99) >= need);
    if (ap.code === 'BOS') {
      const pre = T.cls === 'widebody' || T.cls === 'super' ? /^E/ : T.cls === 'commuter' ? /^C/ : /^[BC]/;
      const pick = list.filter((s) => pre.test(s.ref) && !(P && P.standBusy && P.standBusy(s.ex, s.ez, T.span)));
      if (pick.length) list = pick;
      else list = list.filter((s) => /^[ABCE]/.test(s.ref));
    }
    if (from && from.exclude) list = list.filter((s) => s !== from.exclude);
    // A jet on a ramp: a spot with a lead-in near her length, if there is one.
    if (ap.code !== 'BOS' && T.engine === 'jet') { const long = list.filter((s) => !s.lead || s.lead.length >= T.len * 0.75); if (long.length) list = long; }
    list.sort((a, b) => Math.hypot(a.ex - terminal.x, a.ez - terminal.z) - Math.hypot(b.ex - terminal.x, b.ez - terminal.z));
    let g = list[Math.floor(this.rng() * Math.min(4, list.length))] || ap.stands[0];
    if (from && list.length > 1) {
      // The way in to each of the nearest: length, plus a lot for a sharp turn onto its lead-in.
      let bs = Infinity;
      for (const st of list.slice(0, 6)) {
        const r = ap.routeFrom(from.x, from.z, from.heading, st.taxiNode, [], from.speed);
        if (!r || !st.lead) continue;
        const pts = r.path.pts, n = pts.length, a = pts[n - 1], b0 = pts[Math.max(0, n - 2)];
        const q = st.lead.at(0), inH = Math.atan2(a[0] - b0[0], -(a[1] - b0[1])), leadH = Math.atan2(q.tx, -q.tz);
        const turn = Math.abs(wrapAngle(leadH - inH));
        const score = r.path.length + (turn > 1.75 ? 3000 : turn * 120 * Math.max(1, T.len / 15)) + this.rng() * 40;
        if (score < bs) { bs = score; g = st; }
      }
    }
    if (ap.code === 'BOS' && P && P.reserveStand) P.reserveStand(g.ex, g.ez, T.span);
    return g;
  }

  // Somewhere to start from: a cargo or remote stand at Logan, a far spot elsewhere.
  _pickStart(ap, gate) {
    const T = this.T, need = T.span * 0.55, P = this.g.planes;
    let list = ap.stands.filter((s) => s !== gate && (s.room || 99) >= need && !(ap.code === 'BOS' && P && P.standBusy && P.standBusy(s.ex, s.ez, T.span)));
    if (ap.code === 'BOS') { const cargo = list.filter((s) => /^(NC|SC|D|J)/.test(s.ref)); if (cargo.length) list = cargo; }
    list = list.filter((s) => Math.hypot(s.ex - gate.ex, s.ez - gate.ez) > 250);
    if (!list.length) return gate;
    const st = list[Math.floor(this.rng() * list.length)];
    if (ap.code === 'BOS' && P && P.reserveStand) P.reserveStand(st.ex, st.ez, T.span);
    return st;
  }

  // The stand's lead-in from its taxi node to where the nose stops.
  _standTail(st) {
    const p = this.fm.standPose(this.curAirport(), st, this.T);
    const pts = [];
    const L = st.lead;
    if (L) for (let s = 8; s < L.length - 4; s += 10) { const q = L.at(s); pts.push([q.x, q.z]); }
    pts.push([p.x + st.fx * (this.T.fus.zNose - 0.5), p.z + st.fz * (this.T.fus.zNose - 0.5)]);
    return pts;
  }

  curAirport() { return this.phase === 'taxiIn' || this.phase === 'deboard' || this.phase === 'done' || this.phase === 'rollout' ? this.arr || this.to : this.from; }

  // The nosewheel: what follows the taxiway centreline.
  _noseWheel(out = this._nw || (this._nw = new THREE.Vector3())) { return this.fm.body.worldPoint(0, 0, this.T.gear.nose, out); }

  _routeTo(node, extra = []) {
    const ap = this.curAirport(), b = this.fm.body, n = this._noseWheel();
    this.route = ap.routeFrom(n.x, n.z, b.heading, node, extra, b.onGround ? b.gs : 0);
    this.routeS = 0;
    // At Logan: the ground controller keeps the way clear of parked airliners.
    if (this.route && ap.code === 'BOS' && this.g.planes && this.g.planes.clearRoute) this.g.planes.clearRoute(this.route.path.pts, this.T.span);
  }

  // ------------------------------------------------------------ lights
  // Green centreline lights along the route ahead; a red stop bar at the hold.
  _buildLights() {
    const n = 220;
    const g = new THREE.BufferGeometry();
    this.lp = new Float32Array(n * 3); this.lc = new Float32Array(n * 3); this.ls = new Float32Array(n); this.la = new Float32Array(n * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.lp, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.lc, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.ls, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAnim', new THREE.BufferAttribute(this.la, 2));
    this.lightMat = makeLightMaterial(0.9);
    this.lights = new THREE.Points(g, this.lightMat);
    this.lights.frustumCulled = false;
    this.lights.renderOrder = 9;
    this.root.add(this.lights);
  }

  _updateLights() {
    const ap = this.curAirport(), b = this.fm.body;
    let k = 0;
    const put = (x, z, col, size, anim = 0) => {
      if (k >= this.ls.length) return;
      this.lp[3 * k] = x; this.lp[3 * k + 1] = ap.elev + 0.35; this.lp[3 * k + 2] = z;
      this.lc[3 * k] = col[0]; this.lc[3 * k + 1] = col[1]; this.lc[3 * k + 2] = col[2];
      this.ls[k] = size; this.la[2 * k] = anim; this.la[2 * k + 1] = anim ? 0.9 : 0;
      k++;
    };
    const ground = b.onGround && b.speed < 45;
    if (this.route && ground && ['toGate', 'taxiOut', 'hold', 'taxiIn'].includes(this.phase)) {
      const P = this.route.path, s0 = this.routeS, end = this.phase === 'taxiOut' && this.hold ? this.hold.s : P.length;
      for (let s = Math.ceil(s0 / 14) * 14 + 14; s < Math.min(end, s0 + 900); s += 14) { const q = P.at(s); put(q.x, q.z, [0.25, 1, 0.45], 1.8); }
    }
    // Stop bar across the taxiway at the hold point (red until cleared).
    if (this.hold && (this.phase === 'taxiOut' || this.phase === 'hold')) {
      const q = this.hold.at, rx = -q.tz, rz = q.tx;
      for (let i = -3; i <= 3; i++) put(q.x + rx * i * 3, q.z + rz * i * 3, this.cleared ? [0.25, 1, 0.45] : [1, 0.12, 0.08], 2.6);
    }
    this.lights.geometry.setDrawRange(0, k);
    for (const a of ['position', 'color', 'aSize', 'aAnim']) this.lights.geometry.attributes[a].needsUpdate = true;
  }

  // ------------------------------------------------------------ per frame
  preStep(dt) {
    if (this.phase === 'pushback') this._pushback(dt);
  }

  update(sdt, dt) {
    const fm = this.fm, b = fm.body, g = this.g;
    this.t += dt; this.clock += sdt;
    if (this.over) return;
    // Route progress: the nearest point a little way ahead (it only moves forward).
    if (this.route) {
      const P = this.route.path, n = this._noseWheel();
      let best = this.routeS, bd = Infinity;
      for (let s = this.routeS; s < Math.min(P.length, this.routeS + 80); s += 1.5) {
        const q = P.at(s), d = Math.hypot(q.x - n.x, q.z - n.z);
        if (d < bd) { bd = d; best = s; }
      }
      this.routeS = best;
      this.offRoute = bd;
    }
    if (b.onGround && b.speed > TAXI_LIMIT && ['toGate', 'taxiOut', 'taxiIn'].includes(this.phase)) this.taxiOver += sdt;
    switch (this.phase) {
      case 'toGate': this._park('boarding'); break;
      case 'boarding': this._board(dt); break;
      case 'taxiOut': this._taxiOut(dt); break;
      case 'hold': this._holding(dt); break;
      case 'cleared': this._cleared(dt); break;
      case 'enroute': this._enroute(dt); break;
      case 'approach': this._approach(dt); break;
      case 'rollout': this._rollout(dt); break;
      case 'taxiIn': this._park('deboard'); break;
      case 'deboard': this._board(dt, true); break;
    }
    this._updateLights();
    this._walkers(dt);
    if (this.bridge) this._poseBridge(dt);
  }

  // Pulling onto a stand: stop with the nose on the mark, lined up.
  _park(next) {
    const fm = this.fm, b = fm.body, st = next === 'boarding' ? this.gate : this.arrGate, ap = this.curAirport();
    if (!st) return;
    const p = fm.standPose(ap, st, this.T);
    const noseX = b.pos.x + b.fwd.x * (this.T.fus.zNose - 0.5), noseZ = b.pos.z + b.fwd.z * (this.T.fus.zNose - 0.5);
    const dx = p.nx - noseX, dz = p.nz - noseZ;
    const along = dx * st.fx + dz * st.fz, lat = dx * -st.fz + dz * st.fx;
    const herr = Math.abs(wrapAngle(b.heading - st.heading));
    this.parkInfo = { along, lat, herr, dist: Math.hypot(dx, dz) };
    const big = this.T.span > 40 ? 1.6 : 1;
    // A jet bridge needs her lined up; a ramp spot just needs her on it (the score still counts the error).
    const bridge = ap.code === 'BOS' && this.T.engine === 'jet' && /^[ABCE]/.test(st.ref || '');
    const latOk = (bridge ? 2.5 : Math.max(4, this.T.span * 0.25)) * big, herrOk = (bridge ? 12 : 40) * DEG;
    const onLead = this.route && this.route.path.length - this.routeS < (st.lead ? st.lead.length : 30) + 6 && herr < 70 * DEG;
    if (onLead && this.parkInfo.dist < 30 && along < -4 * big) this._note('overran');
    if (Math.abs(along) < 3 * big && Math.abs(lat) < latOk && herr < herrOk && b.speed < 0.5) this._onGate(next, st, { along: Math.abs(along), lat: Math.abs(lat), herr });
  }

  // Parked on stand st: the doors open and the passengers get on (or off).
  _onGate(next, st, err) {
    const fm = this.fm, b = fm.body;
    b.parkBrake = true;
    fm.lever = 0;
    this.parkErr = err;
    this.phase = next;
    this.t = 0;
    this.route = null;
    this.boardT = 0;
    this.boarded = next === 'boarding' ? 0 : this.pax;
    this._openDoors(st);
    this.g.hud.message('On the gate', next === 'boarding' ? `Boarding ${this.pax} passengers` : `${this.pax} passengers getting off`, 2200, '#7ee081');
    this.g.audio.cash();
  }

  // The jet bridge (at a Logan terminal) or stairs, and the walkers.
  _openDoors(st) {
    const ap = this.curAirport(), T = this.T, b = this.fm.body;
    this.walkers = this.walkers || [];
    this.useBridge = ap.code === 'BOS' && T.engine === 'jet' && /^[ABCE]/.test(st.ref || '');
    if (!this.crowd) this.crowd = new Crowd(this.root, 40);
    const door = b.worldPoint(-T.fus.W / 2 - 0.2, T.engine === 'jet' ? T.fus.H * 0.05 : -T.fus.H * 0.25, T.doorZ, new THREE.Vector3());
    this.door = door;
    // Where people come from: the terminal beyond the stand, off to the door side.
    const rx = -b.fwd.z, rz = b.fwd.x;                 // her right (flat)
    const term = new THREE.Vector3(st.ex + st.fx * (this.useBridge ? 12 : 30) - rx * 10, ap.elev, st.ez + st.fz * (this.useBridge ? 12 : 30) - rz * 10);
    this.term = term;
    if (this.useBridge) this._buildBridge(term, door);
    else if (T.engine === 'jet') this._buildStairs(door, rx, rz);
  }

  _buildBridge(term, door) {
    if (this.bridge) this.bridge.removeFromParent();
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.55, metalness: 0.3 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.15, metalness: 0.6, emissive: 0xffe2b0, emissiveIntensity: 0.4 * this.g.sky.nightAmount });
    const tunnel = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.8, 1).translate(0, 0, 0.5), mat);
    const win = new THREE.Mesh(new THREE.BoxGeometry(2.62, 0.7, 0.98).translate(0, 0.45, 0.5), glass);
    const rot = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 3.4, 16), mat);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1, 0.5).translate(0, -0.5, 0), mat);
    tunnel.castShadow = rot.castShadow = leg.castShadow = true;
    const arm = new THREE.Group();
    arm.add(tunnel, win);
    g.add(rot, arm, leg);
    this.root.add(g);
    this.bridge = { g, arm, rot, leg, term: term.clone(), door: door.clone(), ext: 0 };
  }

  _poseBridge(dt) {
    const B = this.bridge, want = this.phase === 'boarding' || this.phase === 'deboard' ? 1 : 0;
    B.ext += clamp(want - B.ext, -dt * 0.35, dt * 0.35);
    if (B.ext <= 0.001 && !want) { B.g.removeFromParent(); this.bridge = null; return; }
    const y = Math.max(B.door.y - 1.2, this.curAirport().elev + 2.5);
    const t = B.term, d = B.door;
    const full = Math.hypot(d.x - t.x, d.z - t.z) - 1.2;
    const L = 6 + (full - 6) * B.ext;
    const ang = Math.atan2(d.x - t.x, d.z - t.z);
    B.rot.position.set(t.x, y, t.z);
    B.arm.position.set(t.x, y, t.z);
    B.arm.rotation.set(0, ang, 0);
    B.arm.scale.set(1, 1, L);
    B.leg.position.set(t.x + Math.sin(ang) * L * 0.85, y - 1.4, t.z + Math.cos(ang) * L * 0.85);
    B.leg.scale.set(1, y - this.curAirport().elev - 1.4, 1);
  }

  _buildStairs(door, rx, rz) {
    if (this.stairs) this.stairs.removeFromParent();
    const g = new THREE.Group(), elev = this.curAirport().elev;
    const H = Math.max(1, door.y - elev - 0.3), run = H * 1.25;
    const mat = new THREE.MeshStandardMaterial({ color: 0xe8eaec, roughness: 0.6 });
    const truck = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, run + 2).translate(0, 0.8, 0), new THREE.MeshStandardMaterial({ color: 0xf2c12e, roughness: 0.6 }));
    const flight = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.2, Math.hypot(H, run)), mat);
    flight.position.set(0, 1.6 + (H - 1.6) / 2, 0);
    flight.rotation.x = Math.atan2(H - 1.6, run);
    g.add(truck, flight);
    g.position.set(door.x - rx * (run / 2 + 1), elev, door.z - rz * (run / 2 + 1));
    g.rotation.y = Math.atan2(rx, rz);
    for (const o of g.children) o.castShadow = true;
    this.root.add(g);
    this.stairs = g;
  }

  _board(dt, off = false) {
    const T = this.T;
    const total = 8 + this.pax * (T.cls === 'super' ? 0.055 : 0.07);
    this.boardT += dt;
    const done = Math.min(this.pax, Math.floor((this.boardT / total) * this.pax));
    if (!off) this.boarded = done; else this.boarded = this.pax - done;
    // Spawn walkers along the way (as many as the crowd has room for).
    this._spawnT = (this._spawnT || 0) - dt;
    if (this.pax && done < this.pax && this._spawnT <= 0 && !this.useBridge) {
      this._spawnT = total / this.pax * (this.pax > 100 ? 3 : 1);
      this._addWalker(off);
    }
    if (this.boardT >= total + (this.useBridge ? 1 : 3)) {
      if (this.stairs) { this.stairs.removeFromParent(); this.stairs = null; }
      if (!off) {
        // A jet parked nose-in can't turn out on its own: a tug pushes it back (any stand). Props taxi out.
        this.g.hud.message('Boarding complete', T.engine === 'jet' ? 'Pushback approved' : 'Taxi when ready', 2200, '#7ee081');
        this._say(T.engine === 'jet' ? (this.useBridge ? 'Pushback approved, face north.' : 'Pushback approved.') : 'Taxi to the runway via the green lights.');
        if (T.engine === 'jet') this._startPushback(); else this._startTaxiOut();
      } else this._finish();
    }
  }

  _addWalker(off) {
    if (!this.crowd) return;
    const r = this.rng;
    const i = this.crowd.alloc(COAT[(r() * COAT.length) | 0], PANTS[(r() * PANTS.length) | 0], HATS[(r() * HATS.length) | 0], SKIN[(r() * SKIN.length) | 0], r() < 0.3);
    if (i < 0) return;
    const elev = this.curAirport().elev, d = this.door, t = this.term;
    const b = this.fm.body, rx = -b.fwd.z, rz = b.fwd.x;
    const foot = new THREE.Vector3(d.x - rx * (this.stairs ? (d.y - elev) * 1.25 + 2 : 1.2), elev, d.z - rz * (this.stairs ? (d.y - elev) * 1.25 + 2 : 1.2));
    const top = new THREE.Vector3(d.x - rx * 0.4, d.y - (this.T.engine === 'jet' ? 1.1 : 0.4), d.z - rz * 0.4);
    const pts = [new THREE.Vector3(t.x + (r() - 0.5) * 4, elev, t.z + (r() - 0.5) * 4), foot, top];
    if (off) pts.reverse();
    this.walkers.push({ i, pts, s: 0, speed: 1.3 + r() * 0.4, phase: r() * 6 });
  }

  _walkers(dt) {
    if (!this.walkers || !this.crowd) return;
    for (let k = this.walkers.length - 1; k >= 0; k--) {
      const w = this.walkers[k];
      w.s += w.speed * dt;
      let s = w.s, seg = 0;
      while (seg < w.pts.length - 1 && s > w.pts[seg].distanceTo(w.pts[seg + 1])) { s -= w.pts[seg].distanceTo(w.pts[seg + 1]); seg++; }
      if (seg >= w.pts.length - 1) { this.crowd.release(w.i); this.walkers.splice(k, 1); continue; }
      const a = w.pts[seg], bb = w.pts[seg + 1], L = a.distanceTo(bb) || 1, t = s / L;
      const x = a.x + (bb.x - a.x) * t, y = a.y + (bb.y - a.y) * t, z = a.z + (bb.z - a.z) * t;
      const h = Math.atan2(bb.x - a.x, -(bb.z - a.z));
      const ph = (w.s * 2.2 + w.phase);
      this.crowd.pose(w.i, x, y, z, h, Math.sin(ph) * 0.5, Math.abs(Math.sin(ph)) * 0.04, 1);
    }
    this.crowd.flush();
  }

  // ---- pushback: a tug backs her down the lead-in, then turns her to face the taxiway.
  _startPushback() {
    const fm = this.fm, b = fm.body, st = this.gate, L = st.lead, T = this.T;
    this.phase = 'pushback';
    fm.hold = true;
    // The nose goes back down the lead-in from where it is, past the taxi node by about a length.
    const nose = b.worldPoint(0, 0, -(T.fus.zNose - 1), new THREE.Vector3());
    const pts = [[nose.x, nose.z]];
    let s0 = L.length;
    for (let s = L.length; s >= 0; s -= 1) { const q = L.at(s); if ((q.x - nose.x) * st.fx + (q.z - nose.z) * st.fz < 0) { s0 = s; break; } }
    for (let s = s0; s >= 0; s -= 4) { const q = L.at(s); pts.push([q.x, q.z]); }
    const q0 = L.at(0);
    pts.push([q0.x - q0.tx * T.len * 0.5, q0.z - q0.tz * T.len * 0.5]);
    this.push = { path: makeGroundPath(pts), s: 0, v: 0, done: false };
    this.tug = this._makeTug();
  }

  _makeTug() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.3, 5).translate(0, 0.8, 0), new THREE.MeshStandardMaterial({ color: 0xf2c12e, roughness: 0.6 }));
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 1.6).translate(0, 1.9, 1.2), new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.2, metalness: 0.5 }));
    body.castShadow = true;
    g.add(body, cab);
    this.root.add(g);
    return g;
  }

  _pushback(dt) {
    const fm = this.fm, b = fm.body, P = this.push, T = this.T, ap = this.from;
    P.v = Math.min(1.8, P.v + 0.5 * dt);
    if (!P.done) {
      P.s += P.v * dt;
      const L = P.path.length;
      const q = P.path.at(Math.min(L, P.s));
      // Nose follows the path; she points back up it (tail first).
      const h = Math.atan2(-q.tx, q.tz);
      const arm = T.fus.zNose - 1;
      const cx = q.x - Math.sin(h) * arm, cz = q.z + Math.cos(h) * arm;
      b.reset(cx, ap.elev + T.cgH + 0.01, cz, h, {});
      b.parkBrake = false;
      if (P.s >= L) { P.done = true; P.turnFrom = h; }
    } else {
      // Turn to face along the taxiway the route will start on (worked out once).
      if (P.want === undefined) {
        const route = this.from.routeFrom(b.pos.x, b.pos.z, b.heading, this._depEnd().entry);
        const q = route && route.path.length > 40 ? route.path.at(40) : null;
        P.want = q ? Math.atan2(q.x - b.pos.x, -(q.z - b.pos.z)) : b.heading;
      }
      const d = wrapAngle(P.want - b.heading);
      const h = b.heading + clamp(d, -0.08 * dt, 0.08 * dt);
      b.reset(b.pos.x, b.pos.y, b.pos.z, h, {});
      if (Math.abs(d) < 0.05 || (P.turnT = (P.turnT || 0) + dt) > 25) {
        fm.hold = false;
        b.parkBrake = true;
        this.tug.removeFromParent(); this.tug = null;
        this._startTaxiOut();
        this.g.hud.message('Pushback complete', 'Set the brakes off with a little power', 2000, '#7ee081');
      }
    }
    if (this.tug) {
      const nose = b.worldPoint(0, -T.cgH, -T.fus.zNose - 3, new THREE.Vector3());
      this.tug.position.set(nose.x, ap.elev, nose.z);
      this.tug.rotation.y = -b.heading + Math.PI;
    }
  }

  _depEnd() {
    if (this.depEnd) return this.depEnd;
    const w = this.g.weather, ap = this.from;
    this.depEnd = ap.bestEnd(w.windDir + Math.PI, 3 + w.cur.wind * 16, this.fm._runwayNeed(this.T, this.fm.body.mass));
    return this.depEnd;
  }

  _startTaxiOut() {
    const e = this._depEnd();
    this.phase = 'taxiOut';
    this.cleared = false;
    // To the runway end, and on to the lineup point. Where the taxiway joins a little way down
    // and there's runway enough from there, line up just past the join (no backtracking).
    const G = this.from.graph, ea = (G.px(e.entry) - e.x) * e.fx + (G.pz(e.entry) - e.z) * e.fz;
    const a0 = ea > 30 && ea < 400 && e.length - ea - 30 >= this.fm._runwayNeed(this.T, this.fm.body.mass) ? ea + 30 : 40;
    const lineup = [[e.x + e.fx * a0, e.z + e.fz * a0], [e.x + e.fx * (a0 + 50), e.z + e.fz * (a0 + 50)]];
    this._routeTo(e.entry, lineup);
    this.hold = this.route ? this.from.holdOn(this.route, e) : null;
    // The first officer runs the before-taxi checklist: flaps to the takeoff setting (Z X still move them).
    const b = this.fm.body, T = this.T;
    if (b.flap !== T.toFlap) { b.flap = T.toFlap; this.g.hud.message(`Flaps ${T.flaps[T.toFlap].name} for takeoff`, 'Set by the first officer · Z X to change', 2400, '#59d3ff'); }
    this.g.hud.toast(`Taxi to runway ${e.name}`, `Hold short · ${formatDistance(e.length, this.g.settings.metric)} of runway`, 3200);
    this._say(`Taxi to runway ${spell(e.name)}, hold short.`);
  }

  _taxiOut(dt) {
    const b = this.fm.body;
    if (!this.hold) { this.phase = 'cleared'; this.cleared = true; return; }
    const P = this.route.path;
    // At the stop bar: stop and wait for the tower.
    if (this.routeS > this.hold.s - 25) {
      if (b.speed < 1.5) { this.phase = 'hold'; this.t = 0; this.g.hud.toast(`Holding short of runway ${this._depEnd().name}`, 'Waiting for takeoff clearance', 2400); }
      else if (this.routeS > this.hold.s + 3) { this._note('incursion'); this.phase = 'hold'; this.t = 4; }
    }
    void P;
  }

  _holding(dt) {
    const e = this._depEnd(), P = this.g.planes;
    if (this.t < 3) return;
    // Clear if nothing's on the runway or about to land on it.
    const ok = this.from.code !== 'BOS' || !P || !P.runwayBusy || !P.runwayBusy(e.rw.ri);
    if (!ok) {
      if (!this._toldWait) { this._toldWait = true; this.g.hud.toast('Hold short', 'Traffic on the runway', 2000); this._say('Hold short, traffic on final.'); }
      this.t = 1.5;
      return;
    }
    this.phase = 'cleared';
    this.cleared = true;
    const w = this.g.weather, wind = `wind ${String(Math.round(((w.windDir + Math.PI) / DEG + 360) % 360)).padStart(3, '0')} at ${Math.round((3 + w.cur.wind * 16) / KT)}`;
    this.g.hud.message(`Cleared for takeoff`, `Runway ${e.name} · ${wind}`, 2600, '#7ee081');
    this._say(`${this._callsign()}, ${wind}, runway ${spell(e.name)}, cleared for takeoff.`);
    this.g.audio.checkpoint();
    if (this.from.code === 'BOS' && P && P.claimRunway) P.claimRunway(e.rw.ri, true);
  }

  _cleared(dt) {
    const b = this.fm.body;
    if (!b.onGround && b.agl > 60) {
      this.phase = 'enroute';
      this.takeoffT = this.clock;
      if (this.from.code === 'BOS' && this.g.planes && this.g.planes.claimRunway) this.g.planes.claimRunway(this._depEnd().rw.ri, false);
      this.g.hud.toast('Airborne', this.to && this.offer.to !== this.offer.from ? `Head for ${this.to.short}` : 'Fly a circuit and land back at Logan', 3000);
      this._say(this.to === this.from ? 'Contact departure. Report back for landing.' : `Contact departure. Fly heading ${String(Math.round(this._bearing() / DEG)).padStart(3, '0')} for ${this.to ? this.to.short : 'your destination'}.`);
      this.g.audio.checkpoint();
    }
  }

  _bearing() {
    const b = this.fm.body, d = this.to || this.from;
    return ((Math.atan2(d.x - b.pos.x, -(d.z - b.pos.z)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  }

  _arrEnd() {
    if (this.arrEnd) return this.arrEnd;
    const ap = this.to || this.from, w = this.g.weather;
    const need = this.T.cls === 'super' ? 2400 : this.T.cls === 'widebody' ? 2000 : this.T.cls === 'narrowbody' ? 1500 : this.T.cls === 'regional' ? 1300 : 600;
    this.arrEnd = ap.bestEnd(w.windDir + Math.PI, 3 + w.cur.wind * 16, need);
    return this.arrEnd;
  }

  _enroute(dt) {
    const b = this.fm.body, ap = this.to || this.from;
    if (!this.to && this.offer.to !== this.offer.from) { this.to = this.fm.airport(this.offer.to); return; }
    const d = Math.hypot(ap.x - b.pos.x, ap.z - b.pos.z);
    // The sightseeing flights: at least 6 minutes or 15 km away before coming back.
    const away = this.offer.to === this.offer.from ? (this.farthest = Math.max(this.farthest || 0, d)) > 9000 || this.clock - this.takeoffT > 360 : true;
    if (d < 26000 && away) {
      this.phase = 'approach';
      const e = this._arrEnd();
      this.g.hud.toast(`${ap.short} · runway ${e.name}`, `Expect runway ${e.name} · ${formatDistance(e.length, this.g.settings.metric)}`, 3600);
      this._say(`${this._callsign()}, expect runway ${spell(e.name)} at ${ap.short}.`);
    }
  }

  _approach(dt) {
    const b = this.fm.body, ap = this.to || this.from, e = this._arrEnd();
    const a = ap.approach(e, b.pos.x, b.pos.y - this.T.cgH, b.pos.z, this.T.span);
    if (!this.landClear && a.along < 9000 && a.along > 0 && Math.abs(a.across) < 1500) {
      this.landClear = true;
      this.g.hud.message('Cleared to land', `Runway ${e.name}`, 2200, '#7ee081');
      this._say(`Runway ${spell(e.name)}, cleared to land.`);
      if (ap.code === 'BOS' && this.g.planes && this.g.planes.claimRunway) this.g.planes.claimRunway(e.rw.ri, true);
    }
  }

  onTouchdown(t) {
    if (this.phase !== 'approach' && this.phase !== 'enroute' && this.phase !== 'rollout') return;
    // Landed somewhere: here is the destination now (a diversion counts).
    const ap = t.airport;
    if (!ap) { this._note('offfield'); return; }
    if (!this.touch) this.touch = t;
    if (ap !== (this.to || this.from)) { this.diverted = ap; this.g.hud.toast(`Diverted to ${ap.short}`, 'They\'ll take it', 2400); }
    this.arr = ap;
    this.phase = 'rollout';
    if (!t.runway) this._note('offrunway');
  }

  _rollout(dt) {
    const b = this.fm.body, ap = this.arr;
    if (!b.onGround) { if (b.agl > 30) { this.phase = 'approach'; this.touch = null; this.arr = null; this.g.hud.toast('Go around', 'Climb out and come round again', 2000); } return; }
    if (b.gs < 14 && !this.arrGate) {
      // Free a gate at the arrival airport and route to it.
      const nw = this._noseWheel();
      this.arrGate = this._pickGate(ap, { x: nw.x, z: nw.z, heading: b.heading, speed: b.gs });
      this.phase = 'taxiIn';
      this._routeTo(this.arrGate.taxiNode, this._standTail(this.arrGate));
      if (ap.code === 'BOS' && this.g.planes && this.g.planes.claimRunway) this.g.planes.claimRunway(this._arrEnd().rw.ri, false);
      this.g.hud.toast(`Welcome to ${ap.short}`, `Taxi to gate ${this.arrGate.ref || ''}`, 3000);
      this._say(`Welcome to ${ap.short}. Taxi to gate ${this.arrGate.ref || ''}.`);
    }
  }

  _finish() {
    this.phase = 'done';
    this.over = true;
    const r = this.results();
    this.g.audio.finish();
    setTimeout(() => { if (this.fm.job === this && this.g.state === 'air') this.g.showResults(r); }, 1500);
  }

  _note(what) {
    if (this.notes.includes(what) && what !== 'incursion') return;
    this.notes.push(what);
    const msg = { overran: 'Past the stop mark', incursion: 'Runway incursion!', offrunway: 'Off the runway!', offfield: 'Landed in a field!' }[what];
    if (what === 'incursion') this.incursions++;
    if (msg) this.g.hud.message(msg, '', 1600, '#ff6b6b');
  }

  onStrike() { this.strikes = (this.strikes || 0) + 1; }
  onCrash(reason) {
    this.over = true;
    setTimeout(() => { if (this.fm.job === this && this.g.state === 'air') this.g.showResults({ flight: true, crashed: true, title: this.offer.name, reason, type: this.T.short }); }, 3500);
  }

  // Pay and the scorecard.
  results() {
    const fm = this.fm, T = this.T, t = this.touch;
    const land = t ? rateLanding(t.fpm || 0) : { name: '-', score: 0 };
    let comfort = 100;
    if (fm.maxG > 1.35) comfort -= (fm.maxG - 1.35) * 90;
    if (fm.minG < 0.6) comfort -= (0.6 - fm.minG) * 120;
    if (fm.maxBank > 35 * DEG) comfort -= (fm.maxBank / DEG - 35) * 1.5;
    comfort -= fm.strikes * 15 + fm.turb.level * 0;
    comfort = clamp(Math.round(comfort), 0, 100);
    const taxi = clamp(Math.round(100 - this.taxiOver * 3 - this.incursions * 40), 0, 100);
    const park = this.parkErr ? clamp(Math.round(100 - this.parkErr.along * 12 - this.parkErr.lat * 15 - this.parkErr.herr / DEG * 2), 0, 100) : 0;
    const dist = this.arr ? Math.hypot(this.arr.x - this.from.x, this.arr.z - this.from.z) / 1000 : 0;
    const fare = Math.max(60, 25 + dist * 0.45) * Math.max(1, this.pax) * (T.cls === 'commuter' ? 2.2 : 1);
    const score = Math.round(land.score * 0.35 + comfort * 0.3 + taxi * 0.15 + park * 0.2);
    const pay = Math.round(fare * (0.6 + score / 250) - fm.damage * fare * 0.08);
    const key = this.offer.id;
    const best = loadJSON('rb.flightBest', {});
    const prev = best[key];
    const record = !prev || score > prev.score;
    if (record) { best[key] = { score, pay }; saveJSON('rb.flightBest', best); }
    return {
      flight: true, title: this.offer.name, type: T.short, pax: this.pax, from: this.from.short, to: (this.arr || this.to || this.from).short, diverted: this.diverted ? this.diverted.short : null,
      landing: t ? { fpm: Math.round(t.fpm || 0), name: land.name } : null, comfort, taxi, park, score, pay, record, prev: prev ? prev.score : null,
      time: this.clock, grade: score >= 90 ? 'gold' : score >= 75 ? 'silver' : score >= 55 ? 'bronze' : null,
    };
  }

  canWarp() { return this.phase === 'enroute' || (this.phase === 'approach' && this.fm.body.agl > 900); }

  // J: jump to the approach (12 km out on the glidepath, slowed down, flaps out).
  skip() {
    if (this.phase !== 'enroute' && this.phase !== 'approach') return false;
    if (!this.to && this.offer.to !== this.offer.from) this.to = this.fm.airport(this.offer.to);
    if (!this.to && this.offer.to !== this.offer.from) { this.g.hud.toast('Still loading the island', 'Try again in a moment', 1500); return false; }
    const ap = this.to || this.from, fm = this.fm, b = fm.body, T = this.T;
    if (!ap) return false;
    const e = this._arrEnd();
    const d = T.cls === 'light' || T.cls === 'commuter' ? 7000 : 13000;
    const x = e.x - e.fx * d, z = e.z - e.fz * d, y = ap.elev + 15 + (d + 300) * Math.tan(3 * DEG) + T.cgH + 60;
    const flap = Math.max(1, T.flaps.length - 3);
    b.reset(x, y, z, e.heading, { airborne: true, speed: b.vref() + 25 * KT, flap, gear: !T.gearRetract, throttle: 0.45 });
    fm.lever = 0.45;
    this.phase = 'approach';
    this.g.hud.message(`Approach to ${ap.short}`, `Runway ${e.name} · ${formatDistance(d, this.g.settings.metric)} out · slow down, gear and flaps`, 3200, '#59d3ff');
    fm.camera.snap();
    return true;
  }

  // ------------------------------------------------------------ HUD
  navTarget() {
    const b = this.fm.body, metric = this.g.settings.metric;
    let x, z, label;
    if (this.phase === 'enroute' || this.phase === 'approach') {
      const ap = this.to || this.from;
      if (!ap) return null;
      const e = this.phase === 'approach' ? this._arrEnd() : null;
      x = e ? e.x : ap.x; z = e ? e.z : ap.z; label = e ? `RWY ${e.name}` : ap.code;
    } else if (this.route) {
      const P = this.route.path, q = P.at(P.length);
      x = q.x; z = q.z; label = this.phase === 'taxiOut' ? `RWY ${this._depEnd().name}` : `GATE ${(this.phase === 'taxiIn' ? this.arrGate : this.gate)?.ref || ''}`;
    } else return null;
    const d = Math.hypot(x - b.pos.x, z - b.pos.z), brg = Math.atan2(x - b.pos.x, -(z - b.pos.z));
    return { label, dist: formatDistance(d, metric), brg: `${String(Math.round(((brg / DEG) + 360) % 360)).padStart(3, '0')}°`, course: brg };
  }

  ils() {
    if (this.phase !== 'approach' && this.phase !== 'enroute') return null;
    const b = this.fm.body, ap = this.to || this.from;
    if (!ap || this.phase !== 'approach') return null;
    const e = this._arrEnd(), a = ap.approach(e, b.pos.x, b.pos.y - this.T.cgH, b.pos.z, this.T.span);
    if (a.along < 100 || a.along > 30000) return null;
    return { loc: a.loc, gs: a.gsAng, end: e };
  }

  hud(metric) {
    const g = this.g, hud = g.hud, b = this.fm.body, T = this.T;
    const P = this.parkInfo;
    let sub = '', extra = '';
    const kt = (v) => `${Math.round(v / KT)} kt`;
    switch (this.phase) {
      case 'toGate': case 'taxiIn': {
        const st = this.phase === 'toGate' ? this.gate : this.arrGate;
        sub = `Taxi to gate ${st.ref || ''}${this.phase === 'toGate' ? ' for your passengers' : ''}`;
        extra = P && P.dist < 60 ? `<b style="color:${Math.abs(P.lat) < 1.5 ? '#7ee081' : '#ffd447'}">STOP in ${Math.max(0, P.along).toFixed(1)} m · ${P.lat > 0.4 ? 'steer right ' + P.lat.toFixed(1) : P.lat < -0.4 ? 'steer left ' + (-P.lat).toFixed(1) : 'on the line'}</b>` : `Follow the green lights · taxi under ${kt(TAXI_LIMIT)} (${kt(b.gs)})`;
        break;
      }
      case 'boarding': sub = `Boarding: ${this.boarded}/${this.pax}`; extra = this.useBridge ? 'The jet bridge is on' : 'Passengers walking out to the aircraft'; break;
      case 'deboard': sub = `Passengers off: ${this.pax - this.boarded}/${this.pax}`; extra = 'Welcome to ' + (this.arr || this.to || this.from).short; break;
      case 'pushback': sub = 'Pushback'; extra = 'The tug has her'; break;
      case 'taxiOut': sub = `Taxi to runway ${this._depEnd().name} and hold short`; extra = `Stop at the red stop bar · ${kt(b.gs)}`; break;
      case 'hold': sub = `Holding short of runway ${this._depEnd().name}`; extra = 'Waiting for the tower'; break;
      case 'cleared': sub = `Cleared for takeoff runway ${this._depEnd().name}`; extra = `Line up, flaps ${T.flaps[T.toFlap].name}, full power (W), rotate at VR ${kt(b.vr())} (pull ↓)`; break;
      case 'enroute': {
        const ap = this.to || this.from, d = ap ? Math.hypot(ap.x - b.pos.x, ap.z - b.pos.z) : 0;
        sub = `To ${ap ? ap.name : 'destination'} · ${formatDistance(d, metric)}`;
        extra = `Heading ${String(Math.round(this._bearing() / DEG)).padStart(3, '0')}° · [ ] time · J skip to the approach`;
        break;
      }
      case 'approach': {
        const ap = this.to || this.from, e = this._arrEnd(), a = ap.approach(e, b.pos.x, b.pos.y - T.cgH, b.pos.z, T.span);
        sub = `${this.landClear ? 'Cleared to land' : 'Approach'} runway ${e.name} · ${formatDistance(Math.max(0, a.along), metric)}`;
        extra = `VREF ${kt(b.vref())} · ${a.dy > 30 ? 'above the glidepath' : a.dy < -30 ? 'below the glidepath' : 'on the glidepath'} · gear ${b.gearPos > 0.98 ? 'down' : 'UP'} · flaps ${T.flaps[b.flap].name}`;
        break;
      }
      case 'rollout': sub = 'Slow down and exit the runway'; extra = this.touch ? `Touchdown ${Math.round(this.touch.fpm)} fpm · ${this.touch.rating.name}` : ''; break;
      case 'done': sub = 'Flight complete'; break;
    }
    hud.setMission({ title: `${T.airline || 'Flight'} · ${T.short} · ${this.offer.from}→${this.offer.to}`, sub, extra: `${extra}<br>${this.fm.keysHelp()}` });
    hud.setScore(this.pax ? `<div class="small">Passengers</div><div class="big">${this.pax}</div><div class="small">${formatTime(this.clock).replace(/\.\d+$/, '')}</div>` : null);
  }

  overlays() {
    const o = { markers: [], route: null, routeColor: '#7ee081' };
    if (this.route && ['toGate', 'taxiOut', 'hold', 'taxiIn'].includes(this.phase)) {
      const P = this.route.path, pts = [];
      for (let s = this.routeS; s <= P.length; s += 20) { const q = P.at(s); pts.push([q.x, q.z]); }
      const q = P.at(P.length); pts.push([q.x, q.z]);
      o.route = pts;
    }
    if (this.phase === 'enroute' || this.phase === 'approach') {
      const ap = this.to || this.from, b = this.fm.body;
      if (ap) {
        o.route = [[b.pos.x, b.pos.z], [ap.x, ap.z]];
        o.routeColor = '#ff5ad1';
        o.markers.push({ x: ap.x, z: ap.z, r: 8, color: '#ff5ad1', edge: true, label: '✈' });
        if (this.phase === 'approach') { const e = this._arrEnd(); o.markers.push({ x: e.x, z: e.z, r: 5, color: '#ffd447', edge: false }); }
      }
    }
    const st = this.phase === 'taxiIn' ? this.arrGate : this.phase === 'toGate' ? this.gate : null;
    if (st) o.markers.push({ x: st.ex, z: st.ez, r: 7, color: '#7ee081', edge: true });
    return o;
  }

  _say(text) { this.fm.say?.(text); }

  sound() {}

  dispose() {
    const P = this.g && this.g.planes;
    if (P && P.releaseStands) P.releaseStands();
    if (P && P.claimRunway) P.claimRunway(-1, false);
    if (this.crowd) { this.crowd.dispose(); this.crowd = null; }
    this.root.removeFromParent();
    this.fm && (this.fm.hold = false);
  }
}

// Runway names spoken: "22R" -> "two two right".
function spell(name) {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
  return name.replace(/\d/g, (d) => words[+d] + ' ').replace('L', 'left').replace('R', 'right').replace('C', 'center').trim();
}
