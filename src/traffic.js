// AI traffic: cars follow lanes on the OSM road graph (respecting one-way
// streets), keep their distance, slow for corners, stop at traffic signals,
// and get knocked around when the player hits them.

import * as THREE from 'three';
import { buildTrafficCar } from './carmodel.js';
import { RC, CLASS_SPEED } from './mapdata.js';
import { clamp, hash01, wrapAngle } from './util.js';

const TYPES = [['sedan', 30], ['hatch', 22], ['suv', 20], ['taxi', 8], ['pickup', 7], ['van', 5], ['police', 3], ['bus', 3]];
const COLORS = [0xe9e9e6, 0x1c1c1e, 0x8a8f96, 0x2b4a8b, 0x8b1e24, 0xc9c9c3, 0x4f5f50, 0x3a3f4a, 0xb8a27a, 0x6b2f2f, 0x1f5f8b, 0xd0d4d8, 0x2e6b4f, 0x9a9da1];
const FIXED = { taxi: 0xf2c12e, police: 0xf2f2f2, bus: 0xe0b52a };
const SIGNAL_CYCLE = 34;

function pickType(r) {
  let total = 0;
  for (const [, w] of TYPES) total += w;
  let x = r * total;
  for (const [t, w] of TYPES) { if ((x -= w) < 0) return t; }
  return 'sedan';
}

export class Traffic {
  constructor(game) {
    this.g = game;
    this.graph = game.graph;
    this.map = game.map;
    this.cars = [];
    this.pool = new Map();
    this.target = 26;
    this.spawnTimer = 0;
    this.time = 0;
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    game.scene.add(this.group);
    this._buildSignals();
  }

  setDensity(n) { this.target = n; }

  // ------------------------------------------------------------ signals
  _buildSignals() {
    const g = this.graph, map = this.map;
    const isSignal = new Uint8Array(g.N);
    this.signalPhase = new Float32Array(g.N);
    for (const n of map.signals) {
      isSignal[n] = 1;
      const cx = Math.floor(g.nx(n) / 70), cz = Math.floor(g.nz(n) / 70);
      this.signalPhase[n] = hash01(cx * 73856093 ^ cz * 19349663) * SIGNAL_CYCLE;
    }
    this.isSignal = isSignal;
    // Visual heads: one per approach (incoming edge) at each signal node.
    const heads = [];
    for (const n of map.signals) {
      for (let k = g.adjStart[n]; k < g.adjStart[n + 1]; k++) {
        const e = g.adj[k];
        // Edge n->v reversed is the approach v->n; it must be legal.
        const v = g.eTo[e];
        let legal = false;
        for (let k2 = g.adjStart[v]; k2 < g.adjStart[v + 1]; k2++) {
          const e2 = g.adj[k2];
          if (g.eTo[e2] === n && g.eLegal[e2]) { legal = true; break; }
        }
        if (!legal) continue;
        const road = map.roads[g.eRoad[e]];
        if (road.cls > RC.LIVING) continue;
        const dx = g.nx(n) - g.nx(v), dz = g.nz(n) - g.nz(v);
        const L = Math.hypot(dx, dz);
        if (L < 1) continue;
        const fx = dx / L, fz = dz / L;
        const rx = -fz, rz = fx;
        const off = road.width / 2 + 1.2;
        heads.push({ node: n, x: g.nx(n) - fx * 3 + rx * off, z: g.nz(n) - fz * 3 + rz * off, h: Math.atan2(fx, -fz), grp: this._group(fx, fz), hw: road.width / 2 });
      }
    }
    this.heads = heads;
    const N = heads.length;
    const poleGeo = new THREE.CylinderGeometry(0.09, 0.11, 5.6, 6);
    poleGeo.translate(0, 2.8, 0);
    const armGeo = new THREE.BoxGeometry(1, 0.1, 0.1);
    const headGeo = new THREE.BoxGeometry(0.36, 1.0, 0.3);
    const lampGeo = new THREE.CircleGeometry(0.11, 10);
    const dark = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6, metalness: 0.4 });
    this.poles = new THREE.InstancedMesh(poleGeo, dark, N);
    this.arms = new THREE.InstancedMesh(armGeo, dark, N);
    this.headMesh = new THREE.InstancedMesh(headGeo, dark, N);
    this.lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ toneMapped: false, fog: true }), N * 3);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    heads.forEach((hd, i) => {
      q.setFromAxisAngle(up, -hd.h);
      this.poles.setMatrixAt(i, m.compose(p.set(hd.x, 0, hd.z), q, s.set(1, 1, 1)));
      // Arm reaches over the road toward the travel lanes.
      const reach = Math.min(hd.hw + 0.6, 6);
      // Arm points left (toward the road centre): local +x -> (-cos h, -sin h).
      const rx = -Math.cos(hd.h), rz = -Math.sin(hd.h);
      const aq = new THREE.Quaternion().setFromAxisAngle(up, Math.PI - hd.h);
      this.arms.setMatrixAt(i, m.compose(p.set(hd.x + rx * reach / 2, 5.5, hd.z + rz * reach / 2), aq, s.set(reach, 1, 1)));
      const hx = hd.x + rx * reach * 0.8, hz = hd.z + rz * reach * 0.8;
      this.headMesh.setMatrixAt(i, m.compose(p.set(hx, 5.0, hz), q, s.set(1, 1, 1)));
      // Lamps face the approaching driver (+travel direction reversed).
      const fx = Math.sin(hd.h), fz = -Math.cos(hd.h);
      const lq = new THREE.Quaternion().setFromAxisAngle(up, -hd.h);
      for (let k = 0; k < 3; k++) {
        this.lamps.setMatrixAt(i * 3 + k, m.compose(p.set(hx - fx * 0.16, 5.32 - k * 0.32, hz - fz * 0.16), lq, s.set(1, 1, 1)));
      }
      hd.hx = hx; hd.hz = hz;
    });
    for (const im of [this.poles, this.arms, this.headMesh, this.lamps]) {
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      this.group.add(im);
    }
    this.poles.castShadow = this.arms.castShadow = this.headMesh.castShadow = true;
    const c = new THREE.Color(0x111111);
    for (let i = 0; i < N * 3; i++) this.lamps.setColorAt(i, c);
    this.lampState = new Int8Array(N).fill(-1);
    this._signalTimer = 0;
  }

  _group(fx, fz) {
    // 0 = mostly north/south travel, 1 = mostly east/west.
    return Math.abs(fz) >= Math.abs(fx) ? 0 : 1;
  }

  // 0 green, 1 yellow, 2 red for approach group at node n.
  signalState(n, grp) {
    const t = (this.time + this.signalPhase[n]) % SIGNAL_CYCLE;
    const h = SIGNAL_CYCLE / 2;
    const local = grp === 0 ? t : (t + h) % SIGNAL_CYCLE;
    return local < h - 3 ? 0 : local < h ? 1 : 2;
  }

  _updateSignalVisuals(px, pz) {
    const COL = [[0x2a0a0a, 0xff2a1a], [0x2a220a, 0xffc21a], [0x0a2a12, 0x2aff6a]];
    const c = new THREE.Color();
    let dirty = false;
    for (let i = 0; i < this.heads.length; i++) {
      const hd = this.heads[i];
      if (Math.abs(hd.x - px) > 400 || Math.abs(hd.z - pz) > 400) continue;
      const st = this.signalState(hd.node, hd.grp);
      if (this.lampState[i] === st) continue;
      this.lampState[i] = st;
      dirty = true;
      // lamp 0 = red (top), 1 = yellow, 2 = green
      const lit = st === 2 ? 0 : st === 1 ? 1 : 2;
      for (let k = 0; k < 3; k++) this.lamps.setColorAt(i * 3 + k, c.setHex(COL[k][k === lit ? 1 : 0]));
    }
    if (dirty) this.lamps.instanceColor.needsUpdate = true;
  }

  // -------------------------------------------------------- lane geometry
  _laneOffset(road, laneIdx) {
    const drive = Math.max(2.6, road.width - 2 * road.shoulder);
    const lw = drive / road.lanes;
    if (road.oneway) {
      const k = Math.min(laneIdx, road.lanes - 1);
      return -drive / 2 + (k + 0.5) * lw;
    }
    const per = Math.max(1, Math.floor(road.lanes / 2));
    const k = Math.min(laneIdx, per - 1);
    return (k + 0.5) * lw;
  }

  _edgeRoad(a, b) {
    const g = this.graph;
    for (let k = g.adjStart[a]; k < g.adjStart[a + 1]; k++) {
      const e = g.adj[k];
      if (g.eTo[e] === b) return e;
    }
    return -1;
  }

  // Lane point at path index i (mitred offset between segments).
  _lanePoint(c, i) {
    const g = this.graph, p = c.path;
    const n = p[i];
    const x = g.nx(n), z = g.nz(n);
    let ix = 0, iz = 0, ox = 0, oz = 0, offIn = 0, offOut = 0, hasIn = false, hasOut = false;
    if (i > 0) {
      ix = x - g.nx(p[i - 1]); iz = z - g.nz(p[i - 1]);
      const l = Math.hypot(ix, iz) || 1; ix /= l; iz /= l; hasIn = true;
      offIn = c.offs[i - 1];
    }
    if (i + 1 < p.length) {
      ox = g.nx(p[i + 1]) - x; oz = g.nz(p[i + 1]) - z;
      const l = Math.hypot(ox, oz) || 1; ox /= l; oz /= l; hasOut = true;
      offOut = c.offs[i];
    }
    if (!hasIn) { ix = ox; iz = oz; offIn = offOut; }
    if (!hasOut) { ox = ix; oz = iz; offOut = offIn; }
    const n1x = -iz, n1z = ix, n2x = -oz, n2z = ox;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-3) { mx = n2x; mz = n2z; } else { mx /= ml; mz /= ml; }
    const sc = 1 / Math.max(0.5, mx * n2x + mz * n2z);
    const off = (offIn + offOut) / 2;
    return [x + mx * off * sc, z + mz * off * sc];
  }

  // Extend a car's path so it has at least `ahead` nodes beyond index 1.
  _extend(c) {
    const g = this.graph, roads = this.map.roads;
    while (c.path.length < 6) {
      const L = c.path.length;
      const a = c.path[L - 2], b = c.path[L - 1];
      const inx = g.nx(b) - g.nx(a), inz = g.nz(b) - g.nz(a);
      const il = Math.hypot(inx, inz) || 1;
      let best = -1, bw = -1, back = -1;
      const curRoad = roads[g.eRoad[this._edgeRoad(a, b)]] || null;
      for (let k = g.adjStart[b]; k < g.adjStart[b + 1]; k++) {
        const e = g.adj[k];
        if (!g.eLegal[e]) continue;
        const v = g.eTo[e];
        const r = roads[g.eRoad[e]];
        if (v === a) { back = e; continue; }
        if (r.cls >= RC.SERVICE && (!curRoad || curRoad.cls < RC.SERVICE)) continue;
        const ox = g.nx(v) - g.nx(b), oz = g.nz(v) - g.nz(b);
        const ol = Math.hypot(ox, oz) || 1;
        const cos = (inx * ox + inz * oz) / (il * ol);
        if (cos < -0.5) continue;
        let w = 0.3 + Math.max(0, cos) * 2.5 + (curRoad && r.name && r.name === curRoad.name ? 2 : 0) + (r.cls <= RC.SECONDARY ? 0.6 : 0);
        w *= 0.4 + Math.random();
        if (w > bw) { bw = w; best = e; }
      }
      if (best < 0) best = back;
      if (best < 0) return false;
      const road = roads[g.eRoad[best]];
      c.path.push(g.eTo[best]);
      c.offs.push(this._laneOffset(road, c.laneIdx));
      c.roadsOnPath.push(g.eRoad[best]);
    }
    return true;
  }

  _segment(c) {
    // Cache lane points for segment 0..1 and the corner sizes.
    const P0 = this._lanePoint(c, 0), P1 = this._lanePoint(c, 1), P2 = this._lanePoint(c, 2);
    const L = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]) || 0.01;
    const L2 = Math.hypot(P2[0] - P1[0], P2[1] - P1[1]) || 0.01;
    c.P0 = P0; c.P1 = P1; c.P2 = P2; c.L = L;
    c.D1 = Math.min(7, L / 2, L2 / 2);
    // Turn angle at node 1.
    const ax = (P1[0] - P0[0]) / L, az = (P1[1] - P0[1]) / L, bx = (P2[0] - P1[0]) / L2, bz = (P2[1] - P1[1]) / L2;
    c.turn = Math.acos(clamp(ax * bx + az * bz, -1, 1));
    c.dir = [ax, az];
  }

  // ------------------------------------------------------------ spawning
  _spawn() {
    const g = this.graph, car = this.g.car, cam = this.g.camera;
    const camF = new THREE.Vector3();
    cam.getWorldDirection(camF);
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = Math.random() * Math.PI * 2, d = 70 + Math.random() * 260;
      const x = car.x + Math.sin(a) * d, z = car.z - Math.cos(a) * d;
      const n = g.nearestNode(x, z, RC.RESIDENTIAL, 120, true);
      if (n < 0) continue;
      const nx = g.nx(n), nz = g.nz(n);
      const dist = Math.hypot(nx - car.x, nz - car.z);
      if (dist < 60) continue;
      const vis = ((nx - cam.position.x) * camF.x + (nz - cam.position.z) * camF.z) / dist;
      if (vis > 0.5 && dist < 150) continue;
      const outs = [];
      for (let k = g.adjStart[n]; k < g.adjStart[n + 1]; k++) {
        const e = g.adj[k];
        if (g.eLegal[e] && this.map.roads[g.eRoad[e]].cls <= RC.RESIDENTIAL) outs.push(e);
      }
      if (!outs.length) continue;
      const e = outs[Math.floor(Math.random() * outs.length)];
      // Don't spawn on top of another car.
      if (this.cars.some((o) => Math.abs(o.x - nx) < 14 && Math.abs(o.z - nz) < 14)) continue;
      this._create(n, e);
      return;
    }
  }

  _create(n, e) {
    const g = this.graph;
    const r = Math.random();
    const type = pickType(r);
    const color = FIXED[type] ?? COLORS[Math.floor(Math.random() * COLORS.length)];
    const key = type + ':' + color;
    let model = this.pool.get(key)?.pop();
    if (!model) model = buildTrafficCar(type, color);
    model.key = key;
    const road = this.map.roads[g.eRoad[e]];
    const c = {
      model, type, spec: model.spec,
      path: [n, g.eTo[e]], offs: [0], roadsOnPath: [g.eRoad[e]],
      laneIdx: Math.random() < 0.6 ? 0 : 1, s: 0,
      speed: 0, vx: 0, vz: 0, heading: 0, x: g.nx(n), z: g.nz(n),
      personality: 0.82 + Math.random() * 0.3, stuck: 0, ghost: 0,
      wrecked: false, wreckTime: 0, spin: 0, hazard: 0,
      len: model.spec.L, wid: model.spec.W,
    };
    c.offs[0] = this._laneOffset(road, c.laneIdx);
    if (!this._extend(c)) { this._release(c); return; }
    this._segment(c);
    c.s = Math.min(c.L * 0.3, 4);
    this._pose(c);
    c.speed = CLASS_SPEED[road.cls] * 0.6;
    this.group.add(model.root);
    this.cars.push(c);
  }

  _release(c) {
    this.group.remove(c.model.root);
    if (!this.pool.has(c.model.key)) this.pool.set(c.model.key, []);
    this.pool.get(c.model.key).push(c.model);
  }

  clear() {
    for (const c of this.cars) this._release(c);
    this.cars.length = 0;
  }

  // Position/heading from path + s, with Bezier-rounded corners.
  _pose(c) {
    const { P0, P1, P2, L, D1 } = c;
    const D0 = c.D0 ?? 0;
    let x, z, tx, tz;
    if (c.s > L - D1 && D1 > 0.5) {
      // Entering corner around P1.
      const A = [P1[0] - c.dir[0] * D1, P1[1] - c.dir[1] * D1];
      const l2 = Math.hypot(P2[0] - P1[0], P2[1] - P1[1]) || 1;
      const B = [P1[0] + ((P2[0] - P1[0]) / l2) * D1, P1[1] + ((P2[1] - P1[1]) / l2) * D1];
      const t = clamp((c.s - (L - D1)) / (2 * D1), 0, 0.5);
      [x, z, tx, tz] = bezier(A, P1, B, t);
    } else if (c.s < D0 && D0 > 0.5 && c.prevA) {
      const t = clamp(0.5 + c.s / (2 * D0), 0.5, 1);
      [x, z, tx, tz] = bezier(c.prevA, P0, c.prevB, t);
    } else {
      x = P0[0] + c.dir[0] * c.s; z = P0[1] + c.dir[1] * c.s;
      tx = c.dir[0]; tz = c.dir[1];
    }
    c.x = x; c.z = z;
    c.heading = Math.atan2(tx, -tz);
  }

  _advance(c) {
    // Move to the next segment, remembering the corner for continuity.
    const D1 = c.D1;
    const l2 = Math.hypot(c.P2[0] - c.P1[0], c.P2[1] - c.P1[1]) || 1;
    c.prevA = [c.P1[0] - c.dir[0] * D1, c.P1[1] - c.dir[1] * D1];
    c.prevB = [c.P1[0] + ((c.P2[0] - c.P1[0]) / l2) * D1, c.P1[1] + ((c.P2[1] - c.P1[1]) / l2) * D1];
    c.s -= c.L;
    c.path.shift(); c.offs.shift(); c.roadsOnPath.shift();
    if (!this._extend(c)) return false;
    this._segment(c);
    c.D0 = D1;
    return true;
  }

  // -------------------------------------------------------------- update
  update(dt) {
    this.time += dt;
    const player = this.g.car;
    const px = player.x, pz = player.z;
    this._signalTimer -= dt;
    if (this._signalTimer <= 0) { this._signalTimer = 0.25; this._updateSignalVisuals(px, pz); }

    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.cars.length < this.target) { this.spawnTimer = 0.15; this._spawn(); }
    while (this.cars.length > this.target) this._release(this.cars.pop());

    const roads = this.map.roads, g = this.graph;
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const dP = Math.hypot(c.x - px, c.z - pz);
      if (dP > 480 || (c.wrecked && c.wreckTime > 25 && dP > 120) || c.stuck > 30) {
        this._release(c);
        this.cars.splice(i, 1);
        continue;
      }
      if (c.wrecked) { this._updateWreck(c, dt); continue; }
      const road = roads[c.roadsOnPath[0]];
      let target = CLASS_SPEED[road.cls] * c.personality;
      if (road.cls >= RC.RESIDENTIAL) target = Math.min(target, 10.5);
      // Corner speed.
      const remain = c.L - c.s;
      if (c.turn > 0.35) {
        const vc = Math.max(4.2, 15 * Math.pow(1 - c.turn / Math.PI, 1.6));
        const vAllowed = Math.sqrt(vc * vc + 2 * 3.2 * Math.max(0, remain - c.D1));
        target = Math.min(target, vAllowed);
      }
      // Traffic signal at the next node.
      const nextNode = c.path[1];
      if (this.isSignal[nextNode] && remain > 3.5) {
        const st = this.signalState(nextNode, this._group(c.dir[0], c.dir[1]));
        if (st === 2 || (st === 1 && remain > 14)) {
          const stopD = Math.max(0, remain - 8);
          target = Math.min(target, Math.sqrt(2 * 4 * stopD) * (stopD < 0.5 ? 0 : 1));
        }
      }
      // Follow the car in front (including the player).
      const fx = Math.sin(c.heading), fz = -Math.cos(c.heading);
      let gap = Infinity;
      const consider = (ox, oz, oh, olen, solid) => {
        const dx = ox - c.x, dz = oz - c.z;
        const ahead = dx * fx + dz * fz;
        if (ahead <= 0 || ahead > 40) return;
        const lat = Math.abs(dx * -fz + dz * fx);
        if (lat > (solid ? 2.6 : 2.0)) return;
        if (!solid && Math.cos(oh - c.heading) < 0.2) return;
        gap = Math.min(gap, ahead - olen / 2 - c.len / 2);
      };
      if (c.ghost <= 0) for (const o of this.cars) if (o !== c) consider(o.x, o.z, o.heading, o.len, o.wrecked);
      consider(px, pz, player.heading, 4.5, true);
      if (gap < Infinity) {
        const safe = Math.max(0, (gap - 2.5) * 1.1);
        target = Math.min(target, safe);
      }
      // Integrate speed.
      const acc = target > c.speed ? 2.6 : -7.5;
      c.speed = clamp(c.speed + acc * dt, Math.min(c.speed, target), Math.max(c.speed, target));
      if (c.speed < 0.3) {
        c.stuck += dt;
        if (c.stuck > 9) c.ghost = 3;
      } else c.stuck = Math.max(0, c.stuck - dt * 2);
      c.ghost -= dt;
      c.s += c.speed * dt;
      let ok = true;
      while (c.s > c.L && ok) ok = this._advance(c);
      if (!ok) { c.stuck = 99; continue; }
      const ox = c.x, oz = c.z;
      this._pose(c);
      c.vx = (c.x - ox) / Math.max(dt, 1e-4);
      c.vz = (c.z - oz) / Math.max(dt, 1e-4);
      this._collidePlayer(c);
      this._render(c);
    }
  }

  _updateWreck(c, dt) {
    c.wreckTime += dt;
    const sp = Math.hypot(c.vx, c.vz);
    if (sp > 0) {
      const dec = Math.min(sp, 7 * dt);
      c.vx -= (c.vx / sp) * dec;
      c.vz -= (c.vz / sp) * dec;
    }
    c.spin *= Math.exp(-2.5 * dt);
    c.x += c.vx * dt;
    c.z += c.vz * dt;
    c.heading += c.spin * dt;
    // Wrecks still collide with buildings.
    const out = { depth: 0, nx: 0, nz: 0 };
    if (this.g.collision.resolveCircle(c.x, c.z, c.wid / 2 + 0.2, out)) {
      c.x += out.nx * out.depth; c.z += out.nz * out.depth;
      const vn = c.vx * out.nx + c.vz * out.nz;
      if (vn < 0) { c.vx -= 1.3 * vn * out.nx; c.vz -= 1.3 * vn * out.nz; }
    }
    this._collidePlayer(c);
    this._render(c);
    c.hazard += dt;
    c.model.root.children[3].visible = Math.floor(c.hazard * 2.5) % 2 === 0;
  }

  _render(c) {
    const r = c.model.root;
    r.position.set(c.x, 0, c.z);
    r.rotation.y = -c.heading;
  }

  _collidePlayer(c) {
    const p = this.g.car;
    const dx0 = c.x - p.x, dz0 = c.z - p.z;
    if (dx0 * dx0 + dz0 * dz0 > 100) return;
    const pf = [Math.sin(p.heading), -Math.cos(p.heading)];
    const cf = [Math.sin(c.heading), -Math.cos(c.heading)];
    const half = Math.max(0, c.len / 2 - c.wid / 2);
    const rr = c.wid / 2 + 0.05;
    const steps = c.len > 7 ? 4 : 2;
    let hit = false, maxImpact = 0;
    for (const po of p.h.circles) {
      for (let k = 0; k < steps; k++) {
        const co = steps === 1 ? 0 : -half + (2 * half * k) / (steps - 1);
        const ax = p.x + pf[0] * po, az = p.z + pf[1] * po;
        const bx = c.x + cf[0] * co, bz = c.z + cf[1] * co;
        const dx = ax - bx, dz = az - bz;
        const d = Math.hypot(dx, dz);
        const min = p.h.radius + rr;
        if (d >= min || d < 1e-4) continue;
        const nx = dx / d, nz = dz / d;
        const pen = min - d;
        const mP = p.h.mass, mC = c.wrecked ? 1300 * (c.len / 4.6) : 3000 * (c.len / 4.6);
        const wP = mC / (mP + mC);
        p.x += nx * pen * (c.wrecked ? wP : 1);
        p.z += nz * pen * (c.wrecked ? wP : 1);
        if (c.wrecked) { c.x -= nx * pen * (1 - wP); c.z -= nz * pen * (1 - wP); }
        const rvx = p.vx - c.vx, rvz = p.vz - c.vz;
        const vn = rvx * nx + rvz * nz;
        if (vn < 0) {
          const j = -(1 + 0.3) * vn;
          p.vx += j * wP * nx; p.vz += j * wP * nz;
          const kick = j * (1 - wP);
          if (!c.wrecked && -vn > 4.5) this._wreck(c);
          if (c.wrecked) {
            c.vx -= kick * nx; c.vz -= kick * nz;
            c.spin += clamp(co * (cf[0] * nz - cf[1] * nx) * kick * 0.25, -3, 3);
          }
          p.yawRate *= 0.6;
          maxImpact = Math.max(maxImpact, -vn);
        }
        hit = true;
      }
    }
    if (hit && maxImpact > p.impact) { p.impact = maxImpact; p.impactKind = 5; }
  }

  _wreck(c) {
    c.wrecked = true;
    c.wreckTime = 0;
    c.vx = Math.sin(c.heading) * c.speed;
    c.vz = -Math.cos(c.heading) * c.speed;
    c.speed = 0;
  }

  // Positions for the minimap.
  positions() { return this.cars.map((c) => [c.x, c.z]); }
}

function bezier(A, P, B, t) {
  const u = 1 - t;
  const x = u * u * A[0] + 2 * u * t * P[0] + t * t * B[0];
  const z = u * u * A[1] + 2 * u * t * P[1] + t * t * B[1];
  let tx = 2 * u * (P[0] - A[0]) + 2 * t * (B[0] - P[0]);
  let tz = 2 * u * (P[1] - A[1]) + 2 * t * (B[1] - P[1]);
  const l = Math.hypot(tx, tz) || 1;
  return [x, z, tx / l, tz / l];
}
