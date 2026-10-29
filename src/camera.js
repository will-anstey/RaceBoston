// Chase camera with several modes, building occlusion and speed effects.

import * as THREE from 'three';
import { clamp, damp, wrapAngle } from './util.js';

export const CAMERA_MODES = ['Chase', 'Far chase', 'Hood', 'Overhead'];

export class ChaseCamera {
  constructor(camera) {
    this.cam = camera;
    this.mode = 0;
    this.heading = 0;
    this.dist = 7;
    this.height = 2.6;
    this.shake = 0;
    this.pos = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.lookBack = false;
    this._init = false;
  }

  cycle() { this.mode = (this.mode + 1) % CAMERA_MODES.length; this._init = false; return CAMERA_MODES[this.mode]; }
  snap() { this._init = false; }
  bump(amount) { this.shake = Math.min(1.2, this.shake + amount); }

  update(dt, car, cw) {
    const speed = car.speed;
    // Follow heading, leaning toward the velocity direction while drifting.
    let targetH = car.heading;
    if (speed > 6 && car.vF > 0) {
      const velH = Math.atan2(car.vx, -car.vz);
      targetH = car.heading + wrapAngle(velH - car.heading) * 0.45;
    }
    if (car.vF < -2) targetH = car.heading;
    if (this.lookBack) targetH += Math.PI;
    if (!this._init) this.heading = targetH;
    this.heading = wrapAngle(this.heading + wrapAngle(targetH - this.heading) * damp(this.mode === 2 ? 30 : 5.5, dt));

    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    const cfx = car.fx, cfz = car.fz;
    let px, py, pz, tx, ty, tz;
    const cy = car.y;
    // Underground (tunnel or deep cut): keep the camera under the ceiling.
    const under = cy < -3;
    if (this.mode === 2) {
      // hood
      px = car.x + cfx * 0.3; py = cy + 1.3; pz = car.z + cfz * 0.3;
      tx = car.x + cfx * 30; ty = cy + 1.0; tz = car.z + cfz * 30;
      if (this.lookBack) { tx = car.x - cfx * 30; tz = car.z - cfz * 30; }
    } else if (this.mode === 3 && !under) {
      const hgt = 70 + speed * 1.2;
      px = car.x - fx * hgt * 0.35; py = cy + hgt; pz = car.z - fz * hgt * 0.35;
      tx = car.x + fx * 6; ty = cy; tz = car.z + fz * 6;
    } else {
      const far = this.mode === 1 && !under;
      let dist = (far ? 12.5 : 7.0) + speed * (far ? 0.06 : 0.045);
      let height = (far ? 5.2 : 2.5) + speed * 0.012;
      if (under) height = Math.min(height, 3.4);
      // Pull in when a building or tunnel wall would block the view.
      const bx = car.x - fx * dist, bz = car.z - fz * dist;
      const t = cw.segmentBlocked(car.x, car.z, bx, bz, cy + 1.6);
      if (t < 1) { dist = Math.max(2.2, dist * t - 0.6); if (!under) height += (1 - t) * 1.5; }
      if (!this._init) { this.dist = dist; this.height = height; }
      this.dist += (dist - this.dist) * damp(t < 1 ? 20 : 3, dt);
      this.height += (height - this.height) * damp(4, dt);
      px = car.x - fx * this.dist; py = cy + this.height; pz = car.z - fz * this.dist;
      tx = car.x + fx * 3; ty = cy + 1.1; tz = car.z + fz * 3;
    }
    if (!this._init) { this.pos.set(px, py, pz); this.target.set(tx, ty, tz); this._init = true; }
    const k = this.mode === 2 ? 1 : damp(14, dt);
    this.pos.x += (px - this.pos.x) * k; this.pos.y += (py - this.pos.y) * k; this.pos.z += (pz - this.pos.z) * k;
    this.target.x += (tx - this.target.x) * k; this.target.y += (ty - this.target.y) * k; this.target.z += (tz - this.target.z) * k;

    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = this.shake * this.shake * 0.45;
    const t = performance.now() / 1000;
    this.cam.position.set(
      this.pos.x + Math.sin(t * 51) * s, this.pos.y + Math.sin(t * 43 + 1) * s * 0.7, this.pos.z + Math.cos(t * 47) * s,
    );
    this.cam.lookAt(this.target);
    // FOV is vertical; widen it on portrait screens so the road stays visible.
    const portrait = this.cam.aspect < 1 ? 1 + (1 - this.cam.aspect) * 0.75 : 1;
    const fov = ((this.mode === 2 ? 72 : 62) + clamp(speed * 0.22, 0, 14) + (car.boosting ? 6 : 0)) * portrait;
    this.cam.fov += (fov - this.cam.fov) * damp(4, dt);
    this.cam.updateProjectionMatrix();
  }
}
