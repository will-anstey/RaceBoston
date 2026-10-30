// Chase camera with several modes, building occlusion and speed effects.

import * as THREE from 'three';
import { clamp, damp, wrapAngle } from './util.js';

export const CAMERA_MODES = ['Chase', 'Far chase', 'Hood', 'Overhead'];

// Pointer drag to look around: yaw / pitch offsets (radians; drag up looks
// up) that ease back once the pointer has been released for a moment.
export class DragLook {
  constructor(pitchMin = -1.15, pitchMax = 0.45) {
    this.yaw = 0; this.pitch = 0; this.idle = 99; this.dragging = false;
    this.min = pitchMin; this.max = pitchMax;
  }
  drag(dx, dy) {
    this.yaw = wrapAngle(this.yaw + dx);
    this.pitch = clamp(this.pitch - dy, this.min, this.max);
    this.idle = 0;
    this.dragging = true;
  }
  release() { this.dragging = false; }
  reset() { this.yaw = 0; this.pitch = 0; this.idle = 99; this.dragging = false; }
  update(dt) {
    this.idle += dt;
    if (this.dragging || this.idle < 1.5) return;
    const k = damp(2.2, dt);
    this.yaw -= this.yaw * k;
    this.pitch -= this.pitch * k;
  }
}

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
    // Drag to look: orbit around the car, or turn the driver's head in the hood view.
    this.look = new DragLook();
  }

  drag(dx, dy) { this.look.drag(dx, dy); }
  release() { this.look.release(); }
  resetLook() { this.look.reset(); }

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

    const look = this.look;
    look.update(dt);
    const orbit = wrapAngle(this.heading + look.yaw);
    const fx = Math.sin(orbit), fz = -Math.cos(orbit);
    const cfx = car.fx, cfz = car.fz;
    let px, py, pz, tx, ty, tz;
    const cy = car.y;
    // Underground (tunnel or deep cut): keep the camera under the ceiling.
    const under = cy - cw.groundAt(car.x, car.z) < -3;
    if (this.mode === 2) {
      // hood (drag turns the driver's head)
      const lh = Math.atan2(cfx, -cfz) + look.yaw + (this.lookBack ? Math.PI : 0);
      const lp = look.pitch * 0.6 - 0.01;
      px = car.x + cfx * 0.3; py = cy + 1.3; pz = car.z + cfz * 0.3;
      tx = px + Math.sin(lh) * Math.cos(lp) * 30; ty = py + Math.sin(lp) * 30; tz = pz - Math.cos(lh) * Math.cos(lp) * 30;
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
      // Dragging down swings the camera up over the car, dragging up lowers it to the road.
      const r0 = Math.hypot(this.dist, this.height), a0 = Math.atan2(this.height, this.dist);
      const a = clamp(a0 - look.pitch, 0.02, under ? Math.atan2(3.4, 2.2) : 1.35);
      px = car.x - fx * r0 * Math.cos(a); py = cy + r0 * Math.sin(a); pz = car.z - fz * r0 * Math.cos(a);
      tx = car.x + fx * 3; ty = cy + 1.1; tz = car.z + fz * 3;
    }
    // Never inside the hillside behind the car.
    if (!under) py = Math.max(py, cw.groundAt(px, pz) + 1.2);
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
