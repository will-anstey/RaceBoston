// Icebreaker Tow: a cold snap has frozen the harbour, and a big ship is
// frozen in out in the ice. Take the icebreaker out to her, break her free
// (run your bow down both her sides), pass her a towline from your stern to
// her bow, and tow her in to her berth before the owners give up on you.
// She's many times your weight: take up the slack gently or the line parts,
// and she carries way long after you ease off. Groundings and bumps come off
// the fee.

import * as THREE from 'three';
import { AI_TYPES, BREAKER, buildBoat, placeBoat, disposeBoat, bumpHulls, CLUBS } from './boats.js';
import { makeBeam, makeLabel, drawLabel } from './ferry.js';
import { clamp, damp, wrapAngle, formatTime, formatDistance, loadJSON, saveJSON } from './util.js';

// Where she's frozen in, where she's bound and where you start: (s, d) along the harbour channel
// line; mass in icebreakers; time on the clock (s); the fee for bringing her in.
export const TOW_JOBS = [
  {
    id: 'tanker', ship: 'Bay Pioneer', type: 'tanker', livery: 0x2a3a4a, mass: 7, at: [1700, 250], heading: 0.5,
    berth: [320, 20], berthName: 'the Inner Harbor', start: [80, 60], time: 600, fee: 12000,
    blurb: 'A tanker frozen in off the Seaport: bring her back up the Inner Harbor',
  },
  {
    id: 'container', ship: 'Northern Light', type: 'container', livery: 0x1f4e9c, mass: 8, at: [4450, 300], heading: -0.3,
    berth: [3300, 270], berthName: 'Conley Terminal', start: [2600, 0], time: 720, fee: 15000,
    blurb: 'A container ship frozen in off Castle Island, for Conley Terminal',
  },
  {
    id: 'cruise', ship: 'Sea Aurora', type: 'cruise', livery: 0x1f4e9c, mass: 9, at: [5050, -340], heading: 0.2,
    berth: [3000, 200], berthName: 'the cruise terminal', start: [3700, 0], time: 900, fee: 20000,
    blurb: 'A cruise ship frozen in out in President Roads, for the Black Falcon cruise terminal',
  },
];

const LINE = 60;            // m, the towline's length
const K = 0.08;             // its stretch (per m, in icebreaker-weights of pull): a nylon hawser gives a lot
const C = 0.25;             // and damping
const PART = 2.6;           // the pull it parts at, held a moment (instantly at PART * 1.6)
const HOOK_Z = 13;          // the towing hook, ship-local, on the icebreaker's stern
const SEGS = 26;            // rope segments drawn

export class TowJob {
  constructor(bm, def) {
    this.bm = bm; this.g = bm.g; this.def = def;
    const B = this.g.boats, H = (this.P = B.harbor);
    this.ok = !!H;
    if (!H) return;
    const T = AI_TYPES[def.type], p = H.at(def.at[0], def.at[1], {}), h = H.heading(def.at[0], 1) + def.heading;
    this.root = new THREE.Group();
    this.g.scene.add(this.root);
    // The ship: a body of her own (world velocity, yaw rate), towed by the bow.
    const model = buildBoat(def.type, CLUBS[0], def.livery);
    this.root.add(model.root);
    const s = (this.ship = {
      type: def.type, T, model, x: p.x, z: p.z, heading: h, vx: 0, vz: 0, r: 0, level: this.g.map.terrain.h(p.x, p.z), y: 0, wakeAcc: 0,
      M: def.mass, len: T.len, beam: T.beam, pitch: 0, roll: 0,
      get fx() { return Math.sin(this.heading); }, get fz() { return -Math.cos(this.heading); },
      get speed() { return Math.hypot(this.vx, this.vz); },
    });
    s.y = s.level;
    const bp = H.at(def.berth[0], def.berth[1], {});
    this.berth = { x: bp.x, z: bp.z, h: H.heading(def.berth[0], -1) };
    this.stage = 'out'; this.t = 0; this.time = 0; this.clock = def.time; this.over = false; this.won = false;
    this.freed = false; this.clear = 0; this.tension = 0; this.strainT = 0; this.parts = 0; this.damage = 0; this.hookT = 0; this.berthT = 0;
    this.line = 0;   // 0..1, the line going across
    this.best = loadJSON('rb.towBest', {});
    this._buildRope();
    this._buildMarks();
    this.prev = { x: s.x, z: s.z, heading: s.heading };
  }

  _buildRope() {
    const geo = new THREE.CylinderGeometry(0.13, 0.13, 1, 6);
    geo.translate(0, 0.5, 0);
    this.rope = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xd9c9a0, roughness: 0.9 }), SEGS);
    this.rope.frustumCulled = false;
    this.rope.visible = false;
    this.root.add(this.rope);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._up = new THREE.Vector3(0, 1, 0); this._sc = new THREE.Vector3();
  }

  // A beam over the ship till she's under tow, then over her berth (and the berth outlined).
  _buildMarks() {
    this.beam = makeBeam();
    this.beam.scale.set(2.5, 1.6, 2.5);
    this.root.add(this.beam);
    this.label = makeLabel();
    this.label.scale.set(26, 9.8, 1);
    this.root.add(this.label);
    const T = this.ship.T, hl = T.len / 2 + 25, hw = T.beam / 2 + 25, b = this.berth, ax = Math.sin(b.h), az = -Math.cos(b.h), nx = -az, nz = ax;
    const pts = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw], [-hl, -hw]].map(([u, v]) => new THREE.Vector3(b.x + ax * u + nx * v, this.g.map.terrain.h(b.x, b.z) + 0.15, b.z + az * u + nz * v));
    this.outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x4dff88 }));
    this.outline.visible = false;
    this.root.add(this.outline);
  }

  startPose() {
    const H = this.P, p = H.at(this.def.start[0], this.def.start[1], {});
    const dir = Math.sign(this.def.at[0] - this.def.start[0]) || 1;
    return { x: p.x, z: p.z, h: Math.atan2(p.tx * dir, -p.tz * dir) };
  }

  begin() {
    const B = this.g.boats, s = this.ship;
    B.shipsHold = 'traffic';   // the port's closed to traffic: just the ships at anchor
    B.avoid = [{ x: s.x, z: s.z, r: s.len / 2 + 30 }];
    this._placeShip();
    this.g.audio.shipHorn?.(1.2);
  }

  // ------------------------------------------------------------ geometry
  _hook() { const b = this.bm.body; return [b.x - b.fx * HOOK_Z, b.z - b.fz * HOOK_Z]; }
  _bow() { const s = this.ship; return [s.x + s.fx * s.len / 2, s.z + s.fz * s.len / 2]; }

  // Ice broken round her hull: ten places, four along each side and her bow and stern. Each
  // looks across a band (3 to 13 m off her), so any pass close alongside counts.
  _checkFree() {
    const s = this.ship, ice = this.g.ice, nx = -s.fz, nz = s.fx, places = [];
    for (const u of [-0.4, -0.15, 0.1, 0.35]) for (const sd of [-1, 1]) places.push([0, 1, 2].map((k) => { const o = s.beam / 2 + 3 + k * 5; return [s.x + s.fx * u * s.len + nx * sd * o, s.z + s.fz * u * s.len + nz * sd * o]; }));
    for (const e of [-1, 1]) places.push([0, 1, 2].map((k) => { const o = s.len / 2 + 4 + k * 5; return [s.x + s.fx * e * o, s.z + s.fz * e * o]; }));
    this.clear = places.filter((pts) => pts.some(([x, z]) => !ice.solidAt(x, z))).length;
    if (!this.freed && this.clear >= 8) {
      this.freed = true;
      this.g.audio.checkpoint();
      this.g.hud.message('She\'s free!', this.stage === 'tow' ? 'Take up the slack gently' : 'Now pass her a line: your stern to her bow', 2200, '#7ee081');
    }
  }

  // ------------------------------------------------------------ physics (every step, with yours)
  substep(dt) {
    const b = this.bm.body, s = this.ship;
    if (this.stage !== 'tow' || this.line < 1) { this.tension = 0; this._drift(dt, 0, 0, 0, 0); return; }
    const [hx, hz] = this._hook(), [bx, bz] = this._bow();
    const dx = hx - bx, dz = hz - bz, d = Math.hypot(dx, dz) || 1e-3, ux = dx / d, uz = dz / d;
    // How fast the line's stretching: the hook running away from her bow (which swings as she turns).
    const nx = -s.fz, nz = s.fx, bvx = s.vx + nx * s.r * s.len / 2, bvz = s.vz + nz * s.r * s.len / 2;
    const rate = (b.vx - bvx) * ux + (b.vz - bvz) * uz;
    const T = d > LINE ? Math.max(0, K * (d - LINE) + C * rate) : 0;
    this.tension = T;
    // The pull: you held back, her bow drawn on (and round).
    b.vx -= ux * T * dt; b.vz -= uz * T * dt;
    this._drift(dt, ux * T, uz * T, bx, bz);
  }

  // Her motion: a pull (fx, fz) at the bow, hull drag (little end on, a lot sideways), ice at her bow.
  _drift(dt, fx, fz, px, pz) {
    const s = this.ship, M = s.M, f = [s.fx, s.fz], n = [-s.fz, s.fx];
    if (!this.freed) { s.vx = s.vz = s.r = 0; return; }
    let u = s.vx * f[0] + s.vz * f[1], v = s.vx * n[0] + s.vz * n[1];
    const pa = fx * f[0] + fz * f[1], pn = fx * n[0] + fz * n[1];
    const ice = this.g.ice.stateAt(s.x + f[0] * s.len * 0.5, s.z + f[1] * s.len * 0.5);
    const iceDrag = ice === 'solid' ? 0.3 * Math.min(1, Math.abs(u)) + 0.01 * u * u : ice === 'thin' ? 0.1 * Math.min(1, Math.abs(u)) : 0;
    u += ((pa - 0.032 * u * Math.abs(u) - 0.03 * u - Math.sign(u) * iceDrag) / M) * dt;
    v += (pn / M - 0.6 * v) * dt;
    const I = (M * s.len * s.len) / 12 * 0.5;
    s.r += ((pn * s.len) / 2 / I - 0.35 * s.r) * dt;
    s.heading = wrapAngle(s.heading + s.r * dt);
    const f2 = [Math.sin(s.heading), -Math.cos(s.heading)], n2 = [-f2[1], f2[0]];
    s.vx = f2[0] * u + n2[0] * v; s.vz = f2[1] * u + n2[1] * v;
    s.x += s.vx * dt; s.z += s.vz * dt;
    void px; void pz;
  }

  // Aground? Points along her keel and sides out of the water: back off, and that's damage.
  _ground() {
    const s = this.ship, cw = this.g.collision, f = [s.fx, s.fz], n = [-s.fz, s.fx];
    const pts = [];
    for (const u of [-0.48, -0.3, -0.1, 0.1, 0.3, 0.48]) pts.push([u, 0]);
    for (const u of [-0.35, 0, 0.35]) for (const sd of [-1, 1]) pts.push([u, sd * 0.45]);
    const hit = pts.some(([u, v]) => !cw.isWaterSurface(s.x + f[0] * u * s.len + n[0] * v * s.beam, s.z + f[1] * u * s.len + n[1] * v * s.beam));
    if (!hit) { this.prev.x = s.x; this.prev.z = s.z; this.prev.heading = s.heading; return; }
    const imp = s.speed;
    s.x = this.prev.x; s.z = this.prev.z; s.heading = this.prev.heading;
    s.vx *= -0.15; s.vz *= -0.15; s.r *= -0.15;
    if (imp > 0.4 && !this.aground) { this.damage += imp; this.g.hud.message('Aground!', 'Pull her off into deeper water', 1600, '#ff6b6b'); this.g.audio.crash(Math.min(1, imp / 4)); }
    this.aground = 2;
  }

  // ------------------------------------------------------------ per frame
  update(dt) {
    const g = this.g, b = this.bm.body, s = this.ship, hud = g.hud;
    this.time += dt; this.t += dt;
    if (!this.over) {
      this.clock -= dt;
      if (this.clock <= 0) { this.clock = 0; this._end(false); }
    }
    if (this.aground) this.aground = Math.max(0, this.aground - dt);
    this.freeT = (this.freeT || 0) - dt;
    if (this.freeT <= 0) { this.freeT = 0.4; this._checkFree(); }
    const [hx, hz] = this._hook(), [bx, bz] = this._bow(), hookDist = Math.hypot(hx - bx, hz - bz);
    this.hookDist = hookDist;
    if (!this.over) {
      if (this.stage === 'out' && Math.hypot(b.x - s.x, b.z - s.z) < s.len / 2 + 160) this.stage = this.freed ? 'hookup' : 'free';
      if (this.stage === 'free' && this.freed) this.stage = 'hookup';
      if (this.stage === 'hookup') {
        const ok = hookDist < 30 && b.speed < 1.5;
        this.hookT = ok ? this.hookT + dt : 0;
        if (this.hookT > 1.2) {
          this.stage = 'tow'; this.line = 0; this.t = 0;
          hud.message('Line across!', this.freed ? 'Take up the slack gently' : 'She won\'t move till she\'s free of the ice', 2000, '#bfe6ff');
          g.audio.oarlock?.();
        }
      }
      if (this.stage === 'tow') {
        this.line = Math.min(1, this.line + dt / 1.0);
        // The line parts if it's yanked or held over its strength.
        this.strainT = this.tension > PART ? this.strainT + dt : 0;
        if (this.tension > PART * 1.6 || this.strainT > 0.6) {
          this.parts++; this.stage = 'hookup'; this.tension = 0; this.strainT = 0; this.hookT = 0;
          hud.message('The towline parted!', 'Come back round to her bow for a new one', 2400, '#ff6b6b');
          g.audio.crash(0.6);
        }
        // Delivered: stopped in her berth.
        const inBerth = Math.hypot(s.x - this.berth.x, s.z - this.berth.z) < 70 && s.speed < 0.8;
        this.berthT = inBerth ? this.berthT + dt : 0;
        if (this.berthT > 3) this._end(true);
      }
    }
    // Ships at anchor are no softer than the bank; nor is she, for you.
    if (this.freed) {
      for (const o of g.boats.list) {
        if (!o.T.ship) continue;
        const ghost = { x: o.x, z: o.z, heading: o.heading, vx: 0, vz: 0, T: o.T };
        const imp = bumpHulls(s, ghost, s.M, 1e6);
        if (imp > 0.4) { this.damage += imp; hud.message('Collision!', `${s.T.name} hit ${o.T.name.toLowerCase()}`, 1400, '#ff6b6b'); }
      }
    }
    const before = { vx: s.vx, vz: s.vz };
    const imp = bumpHulls(b, s, 1, this.freed ? s.M : 1e6);
    if (!this.freed) { s.vx = before.vx; s.vz = before.vz; }
    if (imp > 1.5) {
      this.bm.camera.bump(Math.min(1, imp / 5)); g.audio.crash(Math.min(1, imp / 6));
      if (imp > 2.5) { this.damage += (imp - 2.5) * 0.3; hud.message('Easy!', 'You rammed her', 1000, '#ff6b6b'); }   // (only a real ramming costs)
    }
    if (this.freed) this._ground();
    g.boats.avoid = [{ x: s.x, z: s.z, r: s.len / 2 + 30 }];
    // Her wake, and the ice at her bow.
    if (this.freed) { g.boats._breakIce(s, dt, g.camera); g.boats._wake(s, dt); }
    this._placeShip();
    this._poseRope();
    this._poseMarks();
  }

  _placeShip() {
    const s = this.ship;
    s.level = this.g.map.terrain.h(s.x, s.z);
    s.y = s.level + 0.04 * Math.sin(this.time * 0.35);
    s.pitch = 0.0015 * Math.sin(this.time * 0.4); s.roll = 0.002 * Math.sin(this.time * 0.3);
    placeBoat(s.model, s);
  }

  // The line from the hook to her bow: taut, or sagging into the water when slack.
  _poseRope() {
    const R = this.rope;
    if (this.stage !== 'tow') { R.visible = false; return; }
    R.visible = true;
    const b = this.bm.body, s = this.ship, [hx, hz] = this._hook(), [bx, bz] = this._bow();
    const hy = b.y + BREAKER.deckY(HOOK_Z) + 0.8, by = s.y + ({ cruise: 13, container: 10, tanker: 8.5 }[s.type] ?? 9);
    const d = Math.hypot(hx - bx, hz - bz), sag = Math.max(0.3, (LINE - d) * 0.45), lvl = s.level + 0.05;
    const n = Math.max(1, Math.round(SEGS * this.line));
    const P = (k) => {
      const u = k / SEGS;
      return [bx + (hx - bx) * u, Math.max(lvl, by + (hy - by) * u - Math.sin(Math.PI * u) * sag), bz + (hz - bz) * u];
    };
    for (let k = 0; k < SEGS; k++) {
      if (k >= n) { this._m.makeScale(0, 0, 0); R.setMatrixAt(k, this._m); continue; }
      const [x0, y0, z0] = P(k), [x1, y1, z1] = P(k + 1);
      this._a.set(x0, y0, z0); this._b.set(x1 - x0, y1 - y0, z1 - z0);
      const len = this._b.length() || 1e-3;
      this._q.setFromUnitVectors(this._up, this._b.multiplyScalar(1 / len));
      this._m.compose(this._a, this._q, this._sc.set(1, len, 1));
      R.setMatrixAt(k, this._m);
    }
    R.instanceMatrix.needsUpdate = true;
  }

  _poseMarks() {
    const s = this.ship, B = this.berth, T = this.g.map.terrain, towing = this.stage === 'tow';
    const x = towing ? B.x : s.x, z = towing ? B.z : s.z;
    this.beam.visible = !this.over;
    this.beam.position.set(x, T.h(x, z), z);
    this.beam.material.uniforms.uColor.value.setHex(towing ? 0x4dff88 : 0xff8a3c);
    this.beam.material.uniforms.uTime.value = this.time;
    this.outline.visible = towing && !this.over;
    const text = towing ? `${this.def.berthName}|Her berth` : `${this.def.ship}|Frozen in`;
    if (text !== this.labelText) { this.labelText = text; const [a, c] = text.split('|'); drawLabel(this.label, a, [c], towing ? 0x4dff88 : 0xff8a3c, true); }
    this.label.position.set(x, T.h(x, z) + (towing ? 18 : s.T.len * 0.12 + 24), z);
    const far = this.label.position.distanceTo(this.g.camera.position);
    this.label.visible = !this.over && far > 90 && far < 3000;
  }

  // ------------------------------------------------------------ the end
  get feeNow() {
    const d = this.def;
    return Math.max(0, Math.round(d.fee - this.damage * 600 - this.parts * 1500));
  }

  _end(won) {
    if (this.over) return;
    this.over = true; this.won = won;
    const g = this.g, def = this.def, used = def.time - this.clock;
    const bonus = won ? Math.round(def.fee * 0.25 * clamp(this.clock / def.time, 0, 1)) : 0;
    const fee = won ? this.feeNow + bonus : 0;
    const prev = this.best[def.id] ?? null;
    const record = won && (prev === null || fee > prev);
    if (record) { this.best[def.id] = fee; saveJSON('rb.towBest', this.best); }
    if (won) { g.audio.finish(); g.audio.shipHorn?.(1.5); g.hud.message('Delivered!', `${def.ship} is in · $${fee.toLocaleString()}`, 2800, '#7ee081'); }
    else { g.audio.fail(); g.hud.message('Out of time', 'The owners have sent for another icebreaker', 2800, '#ff6b6b'); }
    this.stage = won ? 'done' : this.stage;
    const bm = this.bm, me = this;
    setTimeout(() => {
      if (bm.tow === me && bm.active) g.showResults({ tow: true, id: def.id, title: `Icebreaker Tow · ${def.ship}`, won, fee, bonus, used, damage: this.damage, parts: this.parts, record, prev, berth: def.berthName });
    }, 2400);
  }

  // ------------------------------------------------------------ HUD
  hud(metric) {
    const hud = this.g.hud, b = this.bm.body, s = this.ship, def = this.def, mph = (v) => `${Math.round(v * (metric ? 3.6 : 2.237))} ${metric ? 'km/h' : 'mph'}`;
    const toShip = Math.hypot(b.x - s.x, b.z - s.z) - s.len / 2, toBerth = Math.hypot(s.x - this.berth.x, s.z - this.berth.z);
    let sub;
    if (this.over) sub = this.won ? `${def.ship} is in` : 'Out of time';
    else if (this.stage === 'out') sub = `Out to the ${s.T.name.toLowerCase()} ${def.ship}, frozen in · ${formatDistance(Math.max(0, toShip), metric)}`;
    else if (this.stage === 'free') sub = `Break her out: run your bow down both her sides · ${this.clear}/10 clear`;
    else if (this.stage === 'hookup') sub = this.hookDist > 30 ? `Back your stern up to her bow to pass a line · ${Math.round(this.hookDist)} m` : b.speed > 1.5 ? `Slow down to pass the line · ${mph(b.speed)}` : 'Hold her there: passing the line...';
    else if (toBerth < 260) sub = `Bring her to a stop in her berth · she's making ${mph(s.speed)}`;
    else sub = `Tow her to ${def.berthName} · ${formatDistance(toBerth, metric)} · ${mph(s.speed)}`;
    const strain = clamp(this.tension / PART, 0, 1.4), col = strain > 1 ? '#ff6b6b' : strain > 0.75 ? '#ffd447' : '#7ee081';
    const meter = this.stage === 'tow' ? `<div class="throw" title="Line strain"><b style="left:${(Math.min(1, strain / 1.4) * 100).toFixed(1)}%;background:${col};box-shadow:0 0 6px ${col}"></b><i style="left:${(100 / 1.4).toFixed(1)}%;width:2px;background:#ff6b6b"></i></div>` : '';
    hud.setMission({
      title: `Icebreaker Tow · ${def.ship}`, sub, time: formatTime(this.clock), urgent: !this.over && this.clock < 60,
      extra: `${meter}${this.stage === 'tow' ? `<b>Line strain ${Math.round(strain * 100)}%</b> &middot; ` : ''}${this.parts ? `${this.parts} line${this.parts > 1 ? 's' : ''} parted &middot; ` : ''}W ahead · S astern · A D helm · H horn · C camera`,
    });
    const best = this.best[def.id];
    hud.setScore(`<div class="small">Fee</div><div class="big">$${this.feeNow.toLocaleString()}</div><div class="small">${best != null ? 'Best $' + best.toLocaleString() : 'to ' + def.berthName}</div>`);
    hud.setStreet('Boston Harbor', this.stage === 'tow' ? `Towing ${def.ship}` : 'Icebreaker Tow');
  }

  overlays() {
    const s = this.ship, B = this.berth, b = this.bm.body;
    const markers = [{ x: s.x, z: s.z, r: 8, color: this.stage === 'tow' ? '#ffd447' : '#ff8a3c', edge: true }, { x: B.x, z: B.z, r: 8, color: '#4dff88', edge: this.stage === 'tow' }];
    // The way in along the channel.
    const H = this.P, from = H.project(this.stage === 'tow' ? s.x : b.x, this.stage === 'tow' ? s.z : b.z, null, {}), to = H.project(this.stage === 'tow' ? B.x : s.x, this.stage === 'tow' ? B.z : s.z, null, {});
    const route = [[this.stage === 'tow' ? s.x : b.x, this.stage === 'tow' ? s.z : b.z]], dir = Math.sign(to.s - from.s) || 1;
    for (let u = from.s; dir * (to.s - u) > 0; u += dir * 60) { const k = clamp((u - from.s) / (to.s - from.s || 1), 0, 1), p = H.at(u, from.d + (to.d - from.d) * k, {}); route.push([p.x, p.z]); }
    route.push(this.stage === 'tow' ? [B.x, B.z] : [s.x, s.z]);
    return { route, routeColor: this.stage === 'tow' ? '#4dff88' : '#ff8a3c', markers };
  }

  dispose() {
    const B = this.g.boats;
    B.shipsHold = null; B.avoid = null;
    if (!this.root) return;
    disposeBoat(this.ship.model);
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => {
      if (!o.isMesh && !o.isSprite && !o.isLine) return;
      if (o.geometry && !o.isSprite) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { if (m && m.map) m.map.dispose(); m?.dispose(); }
    });
  }
}
