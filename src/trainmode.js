// Train mode: drive a line from its first stop to its last. Power and brake,
// keep to the speed limit (curves are slower; the train protection trips the
// emergency brake if you're well over), and stop with the train along each
// platform to let the passengers on and off.

import * as THREE from 'three';
import { clamp, damp, loadJSON, saveJSON } from './util.js';
import { serviceOfRef, RAIL_COVER } from './railworld.js';
import { DragLook } from './camera.js';

const ACCEL = 1.15;          // m/s², full power from a standstill
const BRAKE = 1.3;           // m/s², full service brake
const EMERGENCY = 2.6;       // m/s², emergency brake
const LAT_ACC = 1.3;         // m/s² sideways at a curve's limit
const DWELL = 9;             // s with the doors open
const STOP_EARLY = 6, STOP_LATE = 4;   // m short of / past the stopping mark that still count
const MISS = 14;             // m past the mark: missed the stop
const OVER = 0.9;            // m/s over the limit before it counts against you
const TRIP = 3.6;            // m/s over: the train protection trips the emergency brake
// Line speeds (mph): in tunnels, in the open, and the slowest a curve takes them down to.
const LINE_MPH = { red: [45, 55, 25], orange: [45, 55, 25], blue: [45, 50, 25], green: [30, 35, 20], commuter: [50, 70, 30] };
const MPH = 0.44704;
export const TRAIN_CAMERAS = ['Cab', 'Chase', 'Far chase'];
const ORDER = ['red', 'orange', 'blue', 'green', 'commuter'];

export const lineName = (ref) => (/^Green-/.test(ref) ? `Green Line ${ref.slice(6)}` : /^CR-/.test(ref) ? 'Commuter Rail' : `${ref} Line`);

// Drivable lines for the menu: one entry per route direction.
export function trainLines(map) {
  const P = map.railNodes;
  return map.railRoutes.map((r, i) => {
    let len = 0;
    for (let k = 1; k < r.nodes.length; k++) len += Math.hypot(P[2 * r.nodes[k]] - P[2 * r.nodes[k - 1]], P[2 * r.nodes[k] + 1] - P[2 * r.nodes[k - 1] + 1]);
    return { i, ref: r.ref, svc: serviceOfRef(r.ref), title: lineName(r.ref), from: r.stops[0].name, to: r.stops[r.stops.length - 1].name, stops: r.stops.length, len, key: `${r.ref}|${r.stops[0].name}|${r.stops[r.stops.length - 1].name}` };
  }).sort((a, b) => ORDER.indexOf(a.svc) - ORDER.indexOf(b.svc) || a.ref.localeCompare(b.ref) || a.from.localeCompare(b.from));
}

const _a = {}, _b = {}, _c = {}, _d = {};

export class TrainMode {
  constructor(game) {
    this.g = game;
    this.camera = new TrainCamera(game.camera);
    this.best = loadJSON('rb.trainBest', {});
    this.run = null;
    // Test hooks: run faster than real time, and drive by a function of the run.
    this.timeScale = 1;
    this.autopilot = null;
  }

  get active() { return !!this.run; }

  start(index) {
    const g = this.g, map = g.map, trains = g.trains, route = map.railRoutes[index];
    const line = trainLines(map).find((l) => l.i === index);
    const svc = trains.service(serviceOfRef(route.ref));
    const { cars, gap, length } = trains.consist(svc);
    const pts = trains.pathAlong(route.nodes, svc.bit, length + 80, 160);
    const train = { svc, cars, gap, length, pts, head: 0, v: 0, player: true, stops: [], endS: null, dwell: 0, life: 0 };
    const stops = this._stopMarks(route, pts, length);
    train.head = stops[0].s;
    // AI trains run in the tunnels too, but keep off this line.
    const avoid = new Set();
    for (const p of pts) if (p.node >= 0) avoid.add(p.node);
    trains.trains = trains.trains.filter((o) => !o.pts.some((p) => p.node >= 0 && avoid.has(p.node)));
    trains.player = train;
    trains.underground = true;
    trains.avoid = avoid;
    const lim = this._limits(svc, pts);
    this.run = {
      index, route, line, svc, train, stops, lim, next: 1, phase: 'boarding', timer: DWELL * 0.6, time: 0, started: false,
      results: [], overspeed: 0, trips: 0, tripped: false, limit: lim[0], ahead: null, msgCool: 0,
      mapRoute: pts.filter((p, i) => i % 2 === 0 || i === pts.length - 1).map((p) => [p.x, p.z]),
    };
    this.camera.snap();
    g.hud.message(stops[0].name, `${line.title} to ${line.to}`, 2600, '#fff');
  }

  stop() {
    const trains = this.g.trains;
    trains.player = null;
    trains.underground = false;
    trains.avoid = null;
    this.run = null;
  }

  // Where the head of the train should stop at each route stop: just short
  // of the far end of the platform beside it (so the whole train fits), or
  // at the stop position itself.
  _stopMarks(route, pts, length) {
    const plats = this.g.world.rail.platforms;
    const idx = new Map();
    pts.forEach((p, i) => { if (p.node >= 0 && !idx.has(p.node)) idx.set(p.node, i); });
    const out = [];
    let from = 0;
    for (const st of route.stops) {
      let i = -1;
      for (let k = from; k < pts.length; k++) if (pts[k].node === st.node) { i = k; break; }
      if (i < 0) i = idx.get(st.node) ?? from;
      from = i;
      const p = pts[i];
      // Platform vertices beside the track within 250 m, projected onto it.
      let s1 = -Infinity;
      for (const pf of plats) {
        if (p.x < pf.bb[0] - 80 || p.x > pf.bb[2] + 80 || p.z < pf.bb[1] - 80 || p.z > pf.bb[3] + 80) continue;
        if (Math.abs(pf.base + 0.25 - p.y) > 3) continue;
        const r = pf.ring;
        let hits = 0, far = -Infinity;
        for (let v = 0; v < r.length; v += 2) {
          const q = projectPath(pts, r[v], r[v + 1], p.s - 250, p.s + 250);
          if (q && q.d < 6.5) { hits++; far = Math.max(far, q.s); }
        }
        if (hits >= 2 && far > p.s - 40) s1 = Math.max(s1, far);
      }
      out.push({ name: st.name, node: st.node, s: Number.isFinite(s1) ? s1 - 3 : p.s, x: p.x, z: p.z });
    }
    // Room for the whole train behind the first mark.
    out[0].s = Math.max(out[0].s, length + 5);
    return out;
  }

  // Speed limit at each track point: line speed (slower in tunnels), lower
  // in curves but never below the line's slowest.
  _limits(svc, pts) {
    const R = this.g.map.railRel;
    const [tun, open, slow] = (LINE_MPH[svc.id] || LINE_MPH.commuter).map((m) => m * MPH);
    const n = pts.length, raw = new Float32Array(n), lim = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i], v = p.node >= 0 && R[p.node] < RAIL_COVER ? tun : open;
      const a = pts[Math.max(0, i - 2)], b = pts[Math.min(n - 1, i + 2)];
      raw[i] = Math.min(v, Math.sqrt(LAT_ACC * circumradius(a.x, a.z, p.x, p.z, b.x, b.z)));
    }
    // Posted in 5 mph steps, holding the lowest within 30 m.
    const MPH5 = 5 * MPH;
    for (let i = 0, j0 = 0, j1 = 0; i < n; i++) {
      while (pts[j0].s < pts[i].s - 30) j0++;
      while (j1 + 1 < n && pts[j1 + 1].s <= pts[i].s + 30) j1++;
      let v = Infinity;
      for (let j = j0; j <= j1; j++) v = Math.min(v, raw[j]);
      lim[i] = Math.max(slow, Math.floor(v / MPH5 + 0.02) * MPH5);
    }
    return lim;
  }

  // Lowest limit over the front 25 m of the train, and the lower limit ahead
  // that needs the hardest braking from speed v0 (the first one if none does).
  _limitAt(s, v0) {
    const r = this.run, pts = r.train.pts, lim = r.lim;
    let i = searchS(pts, s - 25), v = Infinity;
    for (; i < pts.length && pts[i].s <= s + 2; i++) v = Math.min(v, lim[i]);
    if (!Number.isFinite(v)) v = lim[Math.min(lim.length - 1, i)];
    let ahead = null, worst = 0;
    for (; i < pts.length && pts[i].s < s + 450; i++) {
      if (lim[i] >= v - 1.1 || (ahead && lim[i] >= ahead.v)) continue;
      const d = pts[i].s - s, need = (v0 * v0 - lim[i] * lim[i]) / (2 * Math.max(5, d));
      if (!ahead || need > worst) { worst = Math.max(worst, need); ahead = { v: lim[i], d }; }
    }
    return { v, ahead };
  }

  // Fixed 60 Hz steps (several when running faster than real time).
  update(dt, inp) {
    const total = dt * this.timeScale, n = Math.max(1, Math.ceil(total * 60 - 1e-6));
    for (let i = 0; i < n && this.run && this.run.phase !== 'done'; i++) this._step(total / n, this.autopilot ? this.autopilot(this.run) : inp);
  }

  _step(dt, inp) {
    const r = this.run;
    const g = this.g, t = r.train, trains = g.trains, hud = g.hud;
    if (r.started) r.time += dt;
    r.msgCool -= dt;
    const end = t.pts[t.pts.length - 1].s - 2;
    // Controls: power only with the doors shut; the emergency brake holds
    // until you're back under the limit with the power off.
    const boarding = r.phase === 'boarding';
    const power = boarding || r.tripped ? 0 : inp.throttle;
    const brake = inp.brake;
    const emerg = inp.handbrake || r.tripped;
    r.power = power; r.brake = emerg ? 1 : brake; r.emerg = emerg;
    if (boarding) {
      t.v = 0;
      r.timer -= dt;
      if (r.timer <= 0) this._depart();
    } else {
      const a = trains.sample(t, t.head, _a), b = trains.sample(t, t.head - 20, _b);
      const grade = (a.y - b.y) / 20;
      const vmax = (LINE_MPH[t.svc.id] || LINE_MPH.commuter)[1] * MPH * 1.3;
      let acc = power * ACCEL * clamp(1.35 - t.v / vmax, 0, 1) - brake * BRAKE - (emerg ? EMERGENCY : 0);
      // Gradients matter a little (the brake controller makes up most of it).
      acc -= 0.02 + 0.00035 * t.v * t.v + 9.81 * grade * 0.45;
      t.v = Math.max(0, t.v + acc * dt);
      if (t.v < 0.05 && power === 0) t.v = 0;   // holding brake
      t.head = Math.min(end, t.head + t.v * dt);
      if (t.head >= end) t.v = 0;
    }
    // Speed limit and the train protection.
    const L = this._limitAt(t.head, t.v);
    r.limit = L.v; r.ahead = L.ahead;
    if (t.v > L.v + OVER) r.overspeed += dt;
    if (!r.tripped && t.v > L.v + TRIP) {
      r.tripped = true; r.trips++;
      hud.message('Overspeed', 'Emergency brake', 1800, '#ff6b6b');
      g.audio.fail();
    } else if (r.tripped && t.v < L.v && inp.throttle === 0) r.tripped = false;
    // Stations.
    const st = r.stops[r.next];
    if (!boarding && st) {
      const d = t.head - st.s;
      if (t.v < 0.12 && d >= -STOP_EARLY && d <= STOP_LATE) this._arrive(st, d);
      else if (d > MISS) {
        r.results.push({ name: st.name, missed: true, pts: 0 });
        hud.message('Missed stop', st.name, 2200, '#ff6b6b');
        g.audio.fail();
        r.next++;
        if (r.next >= r.stops.length) this._finish();
      } else if (t.v < 0.12 && d < -STOP_EARLY && d > -80 && r.msgCool <= 0) {
        hud.message('Pull forward', `${Math.round(-d - STOP_EARLY)} m to the platform`, 1400);
        r.msgCool = 3;
      }
    }
    if (t.head >= end && r.phase === 'running' && r.next < r.stops.length) this._finish();
  }

  _arrive(st, d) {
    const r = this.run, g = this.g;
    const pts = Math.round(100 * clamp(1 - Math.abs(d) / STOP_EARLY, 0, 1));
    r.results.push({ name: st.name, d, pts });
    r.phase = 'boarding';
    r.timer = r.next === r.stops.length - 1 ? 2.5 : DWELL;
    r.train.v = 0;
    const how = Math.abs(d) < 1 ? 'Perfect stop!' : `${Math.abs(d).toFixed(1)} m ${d < 0 ? 'short' : 'past the mark'}`;
    g.hud.message(st.name, `${how} · +${pts}`, 2400, Math.abs(d) < 1 ? '#7ee081' : '#fff');
    g.audio.tone([784, 659], 0.32, 'sine', 0.16, 0.22);
  }

  // Doors close: on to the next stop (r.next is the stop we're at, once started).
  _depart() {
    const r = this.run, g = this.g;
    if (r.started) r.next++;
    r.started = true;
    if (r.next >= r.stops.length) { this._finish(); return; }
    r.phase = 'running';
    g.audio.tone([659, 523], 0.28, 'sine', 0.14, 0.2);
    g.hud.toast(`Next stop: ${r.stops[r.next].name}`, 'Doors closed', 2200);
  }

  _finish() {
    const r = this.run, g = this.g;
    if (r.phase === 'done') return;
    r.phase = 'done';
    const scored = r.stops.length - 1;
    const made = r.results.filter((x) => !x.missed).length;
    const score = Math.max(0, Math.round(r.results.reduce((a, x) => a + x.pts, 0) - r.overspeed * 4 - r.trips * 25));
    const max = scored * 100;
    const medal = score >= max * 0.9 ? 'gold' : score >= max * 0.7 ? 'silver' : score >= max * 0.45 ? 'bronze' : null;
    const key = r.line.key, prev = this.best[key];
    const record = !prev || score > prev.score;
    if (record) { this.best[key] = { score, time: r.time }; saveJSON('rb.trainBest', this.best); }
    g.audio.finish();
    g.showResults({ train: true, title: `${r.line.title} to ${r.line.to}`, score, max, medal, record, prev: prev ? prev.score : null, made, scored, time: r.time, overspeed: r.overspeed, trips: r.trips, index: r.index });
  }

  // ---- HUD
  hud(metric) {
    const r = this.run, g = this.g, hud = g.hud;
    if (!r) return;
    const t = r.train, mph = (v) => (metric ? `${Math.round(v * 3.6)} km/h` : `${Math.round(v * 2.23694)} mph`);
    hud.setSpeed(t.v, metric);
    hud.setGear(r.emerg ? 'EB' : r.brake > 0 ? 'B' : r.power > 0 ? 'P' : 'N');
    hud.setBoost(Math.max(r.power || 0, r.brake || 0), (r.brake || 0) > 0);
    const st = r.stops[r.next];
    let sub;
    if (r.phase === 'done') sub = 'End of the line';
    else if (r.phase === 'boarding') sub = r.started ? `Doors open · ${Math.ceil(r.timer)} s` : `Boarding at ${r.stops[0].name} · ${Math.ceil(r.timer)} s`;
    else if (st) {
      // "Brake for" once a normal stop needs most of the service brake.
      const d = st.s - t.head, brakeAt = (t.v * t.v) / (2 * BRAKE * 0.8) + 30;
      sub = d < 60 && d > -STOP_LATE ? `Stop at ${st.name} · ${Math.max(0, d).toFixed(0)} m`
        : d < brakeAt ? `Brake for ${st.name} · ${Math.round(d)} m`
        : `Next: ${st.name} · ${d > 950 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'}`;
    }
    const over = t.v > r.limit + OVER;
    const ahead = r.ahead ? ` &middot; ${mph(r.ahead.v)} in ${Math.round(r.ahead.d / 10) * 10} m` : '';
    hud.setMission({
      title: `${r.line.title} to ${r.line.to}`, sub, time: formatClock(r.time), urgent: over,
      extra: `<b style="color:${over ? '#ff6b6b' : '#f4c542'}">Limit ${mph(r.limit)}</b>${ahead}<br>W power · S brake · Space emergency · C camera · drag to look`,
    });
    const done = r.results.filter((x) => !x.missed).length;
    const score = Math.max(0, Math.round(r.results.reduce((a, x) => a + x.pts, 0) - r.overspeed * 4 - r.trips * 25));
    hud.setScore(`Score <b>${score}</b> &middot; Stops ${done}/${r.stops.length - 1}`);
    hud.setStreet(r.line.title, st && r.phase !== 'done' ? `Next: ${st.name}` : r.line.to);
  }

  // Minimap overlays: the line ahead and its stops.
  overlays() {
    const r = this.run;
    if (!r) return {};
    const color = { red: '#da291c', orange: '#ed8b00', blue: '#2f6fe0', green: '#18a558', commuter: '#a3509a' }[r.svc.id];
    const markers = [];
    for (let i = r.next; i < r.stops.length; i++) {
      const s = r.stops[i];
      markers.push({ x: s.x, z: s.z, r: i === r.next ? 8 : 5, color: i === r.next ? '#ffc93c' : '#5ac8ff', edge: i === r.next });
    }
    return { route: r.mapRoute, routeColor: color, markers };
  }

  // Head position and heading, for the minimap and the world's focus.
  pose(out = {}) {
    const t = this.run.train, trains = this.g.trains;
    const a = trains.sample(t, t.head, _c), b = trains.sample(t, t.head - 10, _d);
    out.x = a.x; out.y = a.y; out.z = a.z;
    out.heading = Math.atan2(a.x - b.x, -(a.z - b.z));
    return out;
  }
}

// ------------------------------------------------------------------ camera
// Cab (the driver's view; drag turns your head), chase (above and behind the
// front car; drag orbits it) and a far chase outside. Underground the chase
// keeps under the tunnel ceiling and inside the walls.
class TrainCamera {
  constructor(cam) {
    this.cam = cam;
    this.mode = 0;
    this.look = new DragLook(-1.0, 0.6);
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this._init = false;
  }

  cycle() { this.mode = (this.mode + 1) % TRAIN_CAMERAS.length; this._init = false; return TRAIN_CAMERAS[this.mode]; }
  snap() { this._init = false; this.look.reset(); }
  drag(dx, dy) { this.look.drag(dx, dy); }
  release() { this.look.release(); }

  update(dt, trains, t, cw, under) {
    const look = this.look;
    look.update(dt);
    const a = trains.sample(t, t.head + 6, _a), b = trains.sample(t, t.head - 8, _b);
    let dx = a.x - b.x, dz = a.z - b.z;
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    const heading = Math.atan2(dx, -dz), climb = Math.atan2(a.y - b.y, L);
    let px, py, pz, tx, ty, tz;
    if (this.mode === 0) {
      // Just inside the windscreen (closer than the near plane to the cab's own end wall).
      const f = trains.sample(t, t.head - 0.25, _c);
      const h = heading + look.yaw, p = climb * 0.7 + look.pitch * 0.8 - 0.035;
      px = f.x; py = f.y + t.svc.hgt - 1.0; pz = f.z;
      tx = px + Math.sin(h) * Math.cos(p) * 40; ty = py + Math.sin(p) * 40; tz = pz - Math.cos(h) * Math.cos(p) * 40;
    } else {
      const far = this.mode === 2 && !under;
      const c = trains.sample(t, t.head - 9, _c);
      let dist = far ? 36 : 17, hgt = far ? 14 : 6.5;
      if (under) { dist = 13; hgt = 2.9; }
      const r0 = Math.hypot(dist, hgt);
      const el = clamp(Math.atan2(hgt, dist) - look.pitch, 0.02, under ? Math.atan2(2.9, 9) : 1.35);
      const orbit = heading + look.yaw;
      let ox = -Math.sin(orbit) * r0 * Math.cos(el), oz = Math.cos(orbit) * r0 * Math.cos(el);
      const cy = c.y + 1.5;
      // Walls (tunnels, buildings) pull the camera in.
      const k = cw.segmentBlocked(c.x, c.z, c.x + ox, c.z + oz, cy + r0 * Math.sin(el), true);
      if (k < 1) { const f = Math.max(0.12, k - 0.6 / r0); ox *= f; oz *= f; }
      px = c.x + ox; pz = c.z + oz; py = cy + r0 * Math.sin(el);
      tx = c.x + dx * 16; ty = c.y + 2.2; tz = c.z + dz * 16;
    }
    if (!under) py = Math.max(py, cw.groundAt(px, pz) + 1.2);
    if (!this._init) { this.pos.set(px, py, pz); this.target.set(tx, ty, tz); this._init = true; }
    const k = this.mode === 0 ? 1 : damp(9, dt);
    this.pos.x += (px - this.pos.x) * k; this.pos.y += (py - this.pos.y) * k; this.pos.z += (pz - this.pos.z) * k;
    this.target.x += (tx - this.target.x) * k; this.target.y += (ty - this.target.y) * k; this.target.z += (tz - this.target.z) * k;
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.target);
    const portrait = this.cam.aspect < 1 ? 1 + (1 - this.cam.aspect) * 0.75 : 1;
    const fov = (this.mode === 0 ? 66 : 60) * portrait;
    this.cam.fov += (fov - this.cam.fov) * damp(4, dt);
    this.cam.updateProjectionMatrix();
  }
}

// ------------------------------------------------------------------ helpers
function circumradius(ax, az, bx, bz, cx, cz) {
  const ab = Math.hypot(bx - ax, bz - az), bc = Math.hypot(cx - bx, cz - bz), ca = Math.hypot(ax - cx, az - cz);
  const cross = Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax));
  return cross < 1e-6 ? Infinity : (ab * bc * ca) / (2 * cross);
}

// First point index with s >= s0.
function searchS(pts, s0) {
  let lo = 0, hi = pts.length - 1;
  if (s0 <= pts[0].s) return 0;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].s < s0) lo = m; else hi = m; }
  return hi;
}

// Closest point of the path to (x, z) between s0 and s1: { s, d }.
function projectPath(pts, x, z, s0, s1) {
  let best = null;
  for (let i = Math.max(0, searchS(pts, s0) - 1); i + 1 < pts.length && pts[i].s <= s1; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
    const f = clamp(((x - a.x) * dx + (z - a.z) * dz) / l2, 0, 1);
    const d = Math.hypot(x - a.x - dx * f, z - a.z - dz * f);
    if (!best || d < best.d) best = { s: a.s + (b.s - a.s) * f, d };
  }
  return best;
}

function formatClock(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
