// Races at sea: you against a field of the same boats, all on the course at
// once. Powerboats lap President Roads, tugs race down the Inner Harbor, the
// ferries dash out to Castle Island, the fishing fleet races home to the Fish
// Pier. A course is a line of gates, a pair of buoys each: pass them in
// order (outside the buoys doesn't count: go back). The other boats race
// with the same hull physics as yours, each on its own line, ease off for the
// hard turns, and everyone bumps everyone.

import * as THREE from 'three';
import { BoatBody, buildBoat, placeBoat, disposeBoat, bumpHulls, CLUBS, BOAT_TYPES } from './boats.js';
import { makeBeam } from './ferry.js';
import { clamp, wrapAngle, formatTime, formatDistance, loadJSON, saveJSON, mulberry32 } from './util.js';

// gates: (s, d) along the harbour channel line, in order; loop: laps of a circuit (gate 0 the
// start and finish line), else a run from the start line (gate 0) to the last gate.
export const SEA_RACES = [
  {
    id: 'powerboats', name: 'Powerboat Grand Prix', boat: 'motor', field: 6, laps: 2, loop: true, width: 70,
    blurb: 'Six powerboats, two laps round President Roads at 90 mph',
    gates: [[4900, 150], [5500, 420], [6200, 350], [6400, -250], [5800, -500], [5100, -300]],
    names: ['Blue Thunder', 'Harbor Hornet', 'Miss Seaport', 'Southie Flyer', 'Wavebreaker', 'Red Rocket', 'Quicksilver'],
  },
  {
    id: 'tugs', name: 'Tugboat Derby', boat: 'tug', field: 5, laps: 1, loop: false, width: 80,
    blurb: 'Five tugs flat out down the Inner Harbor, slaloming the buoys',
    gates: [[600, 0], [1000, 90], [1400, -70], [1800, 40]],
    names: ['Resolute', 'Tenacious', 'Endeavor', 'Mystic', 'Charlestown', 'Bulldog'],
  },
  {
    id: 'ferries', name: 'Harbor Ferry Dash', boat: 'ferryboat', field: 5, laps: 1, loop: false, width: 90,
    blurb: 'Catamarans at 35 knots, from Long Wharf out to Castle Island',
    gates: [[900, 120], [1500, 150], [2100, 60], [2700, 120], [3300, 140], [3900, 120]],
    names: ['Harbor Express', 'Bay Runner', 'Island Queen', 'Seaport Flyer', 'Spray', 'Harbor Belle'],
  },
  // The islands: gates by latitude and longitude (no harbour channel line there).
  {
    id: 'vineyard-sprint', region: 'vineyard', name: 'Nantucket Sound Sprint', boat: 'motor', field: 6, laps: 2, loop: true, width: 80,
    blurb: 'Two laps off Oak Bluffs and East Chop in open water',
    pts: [[41.4568, -70.5386], [41.4650, -70.5422], [41.4634, -70.5258], [41.4514, -70.5246], [41.4518, -70.5338]],
    names: ['Island Queen', 'Chappy Rocket', 'Menemsha Mako', 'East Chop Express', 'Inkwell', 'Gay Head Gale', 'Lagoon Runner'],
  },
  {
    id: 'nantucket-harbor', region: 'nantucket', name: 'Nantucket Harbor Run', boat: 'motor', field: 6, laps: 1, loop: false, width: 70,
    blurb: 'From Brant Point up the harbor past Pocomo, and back to town by Coatue',
    // Out along the south side and through the narrows, round the upper harbor, back on the Coatue side.
    pts: [[41.2920, -70.0790], [41.2965, -70.0640], [41.3030, -70.0480], [41.3135, -70.0420], [41.3215, -70.0300],
      [41.3165, -70.0440], [41.3055, -70.0540], [41.2985, -70.0680], [41.2885, -70.0880]],
    names: ['Sconset Swell', 'Coatue Flyer', 'Brant Point Bullet', 'Grey Lady', 'Madaket Mist', 'Rainbow Fleet'],
  },
  {
    id: 'trawlers', name: 'Fishing Fleet Run', boat: 'trawler', field: 5, laps: 1, loop: false, width: 80,
    blurb: 'Five trawlers race home from Castle Island to the Fish Pier',
    gates: [[3400, 220], [3050, 280], [2700, 220], [2380, 300]],
    names: ['Sea Hawk', 'Morning Star', 'Gloria Ann', 'Lucky Lady', 'Northern Dawn', 'Cape Ann'],
  },
];

const COUNTDOWN = 3.5;
const LIVERY = { motor: [0x1f4e9c, 0xf2c12e, 0x2a8c5a, 0x111111, 0xe0661e, 0x7a1f8c], tug: [0x1f4e9c, 0x2a6e4a, 0xf2c12e, 0x1c1c1c, 0xe0661e], ferryboat: [0x1f4e9c, 0x2a8c5a, 0xf2c12e, 0x1f7a7a, 0x7a1f8c], trawler: [0x1f4e9c, 0xb3261e, 0xf2c12e, 0x1f7a7a, 0x6b2a1f] };

export function ordinalOf(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return n + s;
}

export class SeaRace {
  constructor(bm, def) {
    this.bm = bm; this.g = bm.g; this.def = def;
    const B = this.g.boats, H = (this.P = B.harbor);
    this.ok = !!H || !!def.pts;
    if (!this.ok) return;
    this.rng = mulberry32((Date.now() & 0xffffff) ^ 0x1b873593);
    this.T = BOAT_TYPES[def.boat];
    this.gates = this._layGates();
    const n = this.gates.length;
    // The order to pass them: a circuit's gates from 1 round to the line, lap by lap; a run's in turn.
    this.seq = [];
    if (def.loop) for (let l = 0; l < def.laps; l++) for (let k = 1; k <= n; k++) this.seq.push(k % n);
    else for (let k = 0; k < n; k++) this.seq.push(k);
    this.root = new THREE.Group();
    this.g.scene.add(this.root);
    this._buildBuoys();
    this.beam = makeBeam();
    this.beam.material.uniforms.uColor.value.setHex(0xffc93c);
    this.beam.scale.set(1.6, 1.2, 1.6);
    this.root.add(this.beam);
    this.clock = 0; this.countdown = COUNTDOWN; this.lastBeep = 4; this.started = false; this.done = false;
    this.best = loadJSON('rb.seaRace', {});
    // The grid behind the start line: you in the second row.
    const g0 = this.gates[0], dir = [g0.dx, g0.dz], nrm = [g0.nx, g0.nz];
    const slots = [];
    for (let row = 0; row < 4; row++) for (const col of [-1, 1]) slots.push([28 + row * (this.T.len * 1.3 + 14), col * (this.T.beam / 2 + 9) * (1 + row % 2 * 0.25)]);
    const you = 2;
    this.racers = [];
    this.youSlot = slots[you];
    const names = def.names.slice();
    for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
    const skills = [0.995, 0.985, 0.975, 0.965, 0.955, 0.945].slice(0, def.field - 1);
    for (let i = skills.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [skills[i], skills[j]] = [skills[j], skills[i]]; }
    let si = 0;
    for (let k = 0; k < def.field; k++) {
      if (k === you) continue;
      const [back, side] = slots[k], skill = skills[si++];
      const body = new BoatBody(def.boat);
      body.T = { ...this.T, top: this.T.top * skill };   // (each boat a shade slower or quicker)
      const x = g0.x - dir[0] * back + nrm[0] * side, z = g0.z - dir[1] * back + nrm[1] * side;
      const h = Math.atan2(dir[0], -dir[1]);
      body.reset(x, z, h, this.g.map.terrain.h(x, z));
      const livery = LIVERY[def.boat][(si - 1) % LIVERY[def.boat].length];
      const model = buildBoat(def.boat, CLUBS[(si * 3) % CLUBS.length], livery);
      this.root.add(model.root);
      body.model = model; body.wakeAcc = 0;
      this.racers.push({ body, model, name: names[si - 1], skill, lane: (this.rng() - 0.5) * 1.4, k: 0, finish: null, inp: { throttle: 0, brake: 0, steer: 0, boost: false }, px: x, pz: z, bump: 0, color: livery });
    }
    this.you = { k: 0, finish: null, px: 0, pz: 0, missed: 0 };
  }

  // ------------------------------------------------------------ the course
  // Each gate across the way it's raced: centre, the line's direction (dx,
  // dz) and its across (nx, nz); buoys inside the water (narrowed if need be).
  _layGates() {
    const P = this.P, cw = this.g.collision, def = this.def, meta = this.g.map.meta;
    const pts = def.pts ? def.pts.map(([lat, lon]) => ({ x: (lon - meta.origin.lon) * meta.metersPerDegree.lon, z: -(lat - meta.origin.lat) * meta.metersPerDegree.lat }))
      : def.gates.map(([s, d]) => { const p = P.at(s, d, {}); return { x: p.x, z: p.z }; });
    return pts.map((p, i) => {
      const a = pts[def.loop ? (i - 1 + pts.length) % pts.length : Math.max(0, i - 1)], b = pts[def.loop ? (i + 1) % pts.length : Math.min(pts.length - 1, i + 1)];
      let dx = b.x - a.x, dz = b.z - a.z;
      if (i === 0 && !def.loop) { dx = pts[1].x - p.x; dz = pts[1].z - p.z; }
      if (i === pts.length - 1 && !def.loop) { dx = p.x - pts[i - 1].x; dz = p.z - pts[i - 1].z; }
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const nx = -dz, nz = dx;
      let hw = def.width / 2;
      while (hw > 20 && !(cw.isWaterSurface(p.x + nx * hw, p.z + nz * hw) && cw.isWaterSurface(p.x - nx * hw, p.z - nz * hw))) hw -= 5;
      return { ...p, dx, dz, nx, nz, hw, i };
    });
  }

  _buildBuoys() {
    const n = this.gates.length * 2, T = this.g.map.terrain;
    const geo = new THREE.CylinderGeometry(0.55, 0.75, 2.2, 12);
    geo.translate(0, 0.7, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.45, emissive: 0x202020 });
    const buoys = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4(), c = new THREE.Color();
    this.gates.forEach((gt, i) => {
      for (const sd of [-1, 1]) {
        const x = gt.x + gt.nx * gt.hw * sd, z = gt.z + gt.nz * gt.hw * sd, k = 2 * i + (sd > 0 ? 1 : 0);
        m.makeTranslation(x, T.h(x, z), z);
        buoys.setMatrixAt(k, m);
        // Red to port, green to starboard; the start and finish line in yellow.
        const line = i === 0 || (!this.def.loop && i === this.gates.length - 1);
        buoys.setColorAt(k, c.setHex(line ? 0xffc93c : sd > 0 ? 0x2a9d4a : 0xd62828));
      }
    });
    buoys.castShadow = true;
    this.root.add(buoys);
    this.buoys = buoys;
  }

  startPose() {
    const g0 = this.gates[0], [back, side] = this.youSlot;
    return { x: g0.x - g0.dx * back + g0.nx * side, z: g0.z - g0.dz * back + g0.nz * side, h: Math.atan2(g0.dx, -g0.dz) };
  }

  begin() {
    const B = this.g.boats;
    // The course is closed to traffic for the race.
    B.shipsHold = 'all';
    for (const b of B.list.slice()) if (b.P === B.harbor) B.remove(b);
    this.g.input.enabled = false;
    this.g.hud.toast(`Sea Race · ${this.def.name}`, `${this.def.field} boats · ${this.def.loop ? `${this.def.laps} laps` : 'start to finish'} · pass every gate between its buoys`, 4200);
  }

  // ------------------------------------------------------------ per step / frame
  // Each AI boat's helm, every physics step, after its own steer for the next gate.
  substep(dt) {
    if (!this.started) {
      for (const r of this.racers) { r.body.vx = r.body.vz = r.body.vF = r.body.vR = 0; }
      return;
    }
    for (const r of this.racers) if (!r.finish) r.body.step(dt, r.inp, this.bm.env);
  }

  update(dt) {
    const g = this.g, b = this.bm.body, hud = g.hud;
    if (!this.started) {
      this.countdown -= dt;
      const c = Math.ceil(this.countdown);
      if (c < this.lastBeep && c <= 3 && c >= 1) { this.lastBeep = c; hud.message(String(c), this.def.name, 800); g.audio.beep(false); }
      if (this.countdown <= 0) {
        this.started = true;
        g.input.enabled = true;
        hud.message('Go!', '', 900, '#7ee081');
        g.audio.beep(true);
      }
    } else if (!this.done) this.clock += dt;
    // The AI: aim for the next gate on your own line; ease off for a hard turn after it.
    for (const r of this.racers) {
      if (r.finish !== null || !this.started) { r.inp.throttle = 0; r.inp.brake = r.finish !== null ? 0.4 : 0; r.inp.steer = 0; }
      else this._helm(r, dt);
    }
    // Gates passed.
    this._gate(this.you, b, true);
    for (const r of this.racers) this._gate(r, r.body, false);
    // Hulls bump each other (and you).
    const all = [b, ...this.racers.map((r) => r.body)];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const imp = bumpHulls(all[i], all[j]);
      if (imp > 1.2 && i === 0) { this.bm.camera.bump(Math.min(1, imp / 6)); g.audio.crash(Math.min(1, imp / 8)); if (imp > 2.5) hud.message('Bump!', '', 700, '#ff6b6b'); }
    }
    // Pose the field; wakes.
    for (const r of this.racers) {
      placeBoat(r.model, r.body);
      g.boats._wake(r.body, dt);
    }
    // The next gate's beam (yours).
    const nx = this.you.k < this.seq.length ? this.gates[this.seq[this.you.k]] : null;
    this.beam.visible = !!nx && !this.done;
    if (nx) { this.beam.position.set(nx.x, g.map.terrain.h(nx.x, nx.z), nx.z); this.beam.material.uniforms.uTime.value = this.clock; }
  }

  _helm(r, dt) {
    const b = r.body, gt = this.gates[this.seq[r.k]], after = this.gates[this.seq[r.k + 1]] ?? null;
    // Stuck (on a bank, or wedged against another boat): back off and come round.
    r.stuck = b.speed < 1 && r.inp.throttle > 0.3 ? (r.stuck || 0) + dt : 0;
    if (r.stuck > 2.5) { r.backing = 2.2; r.stuck = 0; }
    if (r.backing > 0) {
      r.backing -= dt;
      const e = wrapAngle(Math.atan2(gt.x - b.x, -(gt.z - b.z)) - b.heading);
      r.inp.throttle = 0; r.inp.brake = 1; r.inp.steer = -Math.sign(e || 1); r.inp.boost = false;
      return;
    }
    // Rubber band: a little quicker well behind you, a little steadier well ahead.
    const lead = this._progress(r) - this._progress(this.you);
    b.T.top = this.T.top * r.skill * (lead > 1.2 ? 0.97 : lead < -1.2 ? 1.025 : 1);
    const ax = gt.x + gt.nx * gt.hw * 0.3 * r.lane, az = gt.z + gt.nz * gt.hw * 0.3 * r.lane;
    const dist = Math.hypot(ax - b.x, az - b.z), v = b.speed;
    const err = wrapAngle(Math.atan2(ax - b.x, -(az - b.z)) - b.heading);
    let thr = 1;
    if (Math.abs(err) > 0.9) thr = 0.35;   // pointing the wrong way: turn first
    if (after) {
      const turn = Math.abs(wrapAngle(Math.atan2(after.x - gt.x, -(after.z - gt.z)) - b.heading));
      const room = (v * v) / (this.T.accel * 2) + this.T.len * 2;
      if (dist < room && turn > 0.8) thr = Math.min(thr, 0.5);
    }
    r.inp.throttle = thr;
    r.inp.brake = 0;
    r.inp.steer = clamp(err * 2.2 - b.yawRate * 0.7, -1, 1);
    r.inp.boost = !this.T.noBoost && Math.abs(err) < 0.15 && v > 12;
  }

  // Through the next gate (between its buoys, the right way) since the last frame?
  _gate(who, body, you) {
    if (who.finish !== null || !this.started) { who.px = body.x; who.pz = body.z; return; }
    const gt = this.gates[this.seq[who.k]], f0 = (who.px - gt.x) * gt.dx + (who.pz - gt.z) * gt.dz, f1 = (body.x - gt.x) * gt.dx + (body.z - gt.z) * gt.dz;
    who.px = body.x; who.pz = body.z;
    if (!(f0 < 0 && f1 >= 0)) return;
    const across = Math.abs((body.x - gt.x) * gt.nx + (body.z - gt.z) * gt.nz);
    if (across > gt.hw + 4) {
      if (you) { this.g.hud.message('Missed the gate!', 'Go back between the buoys', 1500, '#ff6b6b'); this.g.audio.crash(0.2); }
      return;
    }
    who.k++;
    const lapDone = this.def.loop && this.seq[who.k - 1] === 0;
    if (who.k >= this.seq.length) {
      who.finish = this.clock;
      if (you) this._finish();
      return;
    }
    if (you) {
      const lap = this.def.loop ? Math.floor(who.k / this.gates.length) + 1 : 1;
      if (lapDone) this.g.hud.message(`Lap ${lap} of ${this.def.laps}`, `${formatTime(this.clock)} · ${ordinalOf(this.position())}`, 1500, '#ffd447');
      else this.g.hud.message(`Gate ${who.k} of ${this.seq.length}`, `${ordinalOf(this.position())} of ${this.def.field}`, 900, '#ffd447');
      this.g.audio.checkpoint();
    }
  }

  // Gates passed, plus the way along to the next one.
  _progress(who) {
    if (who.finish !== null) return this.seq.length + 1 + (1e4 - who.finish) * 1e-6;
    const body = who === this.you ? this.bm.body : who.body;
    const k = who.k, gt = this.gates[this.seq[k]], prev = k > 0 ? this.gates[this.seq[k - 1]] : null;
    const seg = prev ? Math.hypot(gt.x - prev.x, gt.z - prev.z) : 300;
    return k + 1 - clamp(Math.hypot(gt.x - body.x, gt.z - body.z) / seg, 0, 1);
  }

  position() {
    const mine = this._progress(this.you);
    return 1 + this.racers.filter((r) => this._progress(r) > mine).length;
  }

  // A boat's time at the line: as finished, or estimated from its progress and pace.
  _estimate(r) {
    if (r.finish !== null) return r.finish;
    const p = Math.max(0.2, this._progress(r));
    return this.clock * (this.seq.length / p);
  }

  _finish() {
    if (this.done) return;
    this.done = true;
    const g = this.g, def = this.def, time = this.you.finish;
    const times = this.racers.map((r) => ({ name: r.name, t: this._estimate(r) }));
    times.push({ name: 'Race Boston (you)', t: time, you: true });
    times.sort((a, b) => a.t - b.t);
    const place = times.findIndex((x) => x.you) + 1;
    const medal = place === 1 ? 'gold' : place === 2 ? 'silver' : place === 3 ? 'bronze' : null;
    const prev = this.best[def.id] ? this.best[def.id].time : null;
    const record = prev === null || time < prev;
    if (record) { this.best[def.id] = { time, place }; saveJSON('rb.seaRace', this.best); }
    g.audio.finish();
    g.hud.message('Finish!', `${formatTime(time)} · ${ordinalOf(place)} of ${times.length}${record ? ' · NEW BEST' : ''}`, 2600, '#ffd447');
    const bm = this.bm, me = this;
    setTimeout(() => {
      if (bm.seaRace === me && bm.active) g.showResults({ searace: true, id: def.id, title: `Sea Race · ${def.name}`, time, place, of: times.length, medal, record, prev, standings: times });
    }, 2300);
  }

  // R: back to the last gate you passed, pointed at the next.
  resetPose() {
    const k = this.you.k, gt = this.gates[this.seq[Math.max(0, k - 1)]], nx = this.gates[this.seq[Math.min(this.seq.length - 1, k)]];
    if (k === 0) return this.startPose();
    const h = Math.atan2(nx.x - gt.x, -(nx.z - gt.z));
    this.you.px = gt.x + gt.dx * 6; this.you.pz = gt.z + gt.dz * 6;
    return { x: gt.x + gt.dx * 6, z: gt.z + gt.dz * 6, h };
  }

  // ------------------------------------------------------------ HUD
  hud(metric) {
    const hud = this.g.hud, def = this.def, b = this.bm.body, k = this.you.k;
    const gt = k < this.seq.length ? this.gates[this.seq[k]] : null;
    const lap = def.loop ? Math.min(def.laps, Math.floor(k / this.gates.length) + 1) : 0;
    const sub = !this.started ? `On the grid · starting in ${Math.max(0, Math.ceil(this.countdown))}`
      : this.done ? 'Finished'
      : `${def.loop ? `Lap ${lap}/${def.laps} · ` : ''}Gate ${k + 1}/${this.seq.length} · ${formatDistance(gt ? Math.hypot(gt.x - b.x, gt.z - b.z) : 0, metric)}`;
    const T = b.T;
    hud.setMission({
      title: `Sea Race · ${def.name}`, sub, time: formatTime(this.clock),
      extra: `${T.diesel ? 'W ahead · S astern · A D helm · H horn' : 'W throttle · S reverse · A D steer · Shift boost'} · R back to the last gate · C camera`,
    });
    const best = this.best[def.id];
    hud.setScore(`<div class="small">Position</div><div class="big">${this.started ? ordinalOf(this.position()) : '-'}</div><div class="small">${best ? 'Best ' + formatTime(best.time) : `of ${def.field}`}</div>`);
    hud.setStreet('Boston Harbor', def.name);
  }

  overlays() {
    const k = this.you.k, route = [[this.bm.body.x, this.bm.body.z]];
    for (let i = k; i < Math.min(this.seq.length, k + this.gates.length); i++) { const gt = this.gates[this.seq[i]]; route.push([gt.x, gt.z]); }
    const next = k < this.seq.length ? this.seq[k] : -1;
    const markers = this.gates.map((gt, i) => ({ x: gt.x, z: gt.z, r: i === next ? 8 : 5, color: i === next ? '#ffc93c' : '#5ac8ff', edge: i === next }));
    for (const r of this.racers) markers.push({ x: r.body.x, z: r.body.z, r: 3, color: '#ff6b4a' });
    return { route, routeColor: '#ffc93c', markers };
  }

  dispose() {
    const B = this.g.boats;
    B.shipsHold = null;
    this.g.input.enabled = true;
    if (!this.root) return;
    for (const r of this.racers) disposeBoat(r.model);
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m?.dispose();
    });
  }
}
