// Arcade vehicle dynamics on the x/z plane. Heading is a compass angle:
// 0 = north (-z), +PI/2 = east (+x). Forward = (sin h, -cos h).

import { clamp, wrapAngle } from './util.js';
import { SURF } from './collision.js';

export const HANDLING = {
  coupe: { maxSpeed: 61, accel: 9.2, brake: 18, grip: 10, maxLat: 13, wheelbase: 2.7, steer: 0.62, mass: 1300 },
  taxi: { maxSpeed: 55, accel: 8.0, brake: 16, grip: 9, maxLat: 11.5, wheelbase: 2.8, steer: 0.6, mass: 1500 },
  suv: { maxSpeed: 52, accel: 7.6, brake: 15, grip: 8.4, maxLat: 10.5, wheelbase: 2.9, steer: 0.58, mass: 2100 },
};

const DEFAULTS = {
  maxSpeed: 58, accel: 8.5, brake: 16, reverseAccel: 6, maxReverse: 13, drag: 0.00085, rolling: 0.25,
  grip: 9, gripHandbrake: 1.6, maxLat: 12, handbrakeDecel: 5.5, wheelbase: 2.7, steer: 0.6,
  wheelR: 0.35, radius: 0.98, circles: [-1.42, 0, 1.42], mass: 1400,
};

export class Vehicle {
  constructor(handling = {}, dims = {}) {
    this.h = { ...DEFAULTS, ...handling, ...dims };
    this.boost = 1;
    this.boosting = false;
    this._out = { depth: 0, nx: 0, nz: 0, kind: 0 };
    this.reset(0, 0, 0);
  }

  reset(x, z, heading) {
    this.x = x; this.z = z; this.heading = heading;
    this.vx = 0; this.vz = 0; this.vF = 0; this.vR = 0;
    this.yawRate = 0; this.steer = 0;
    this.roll = 0; this.pitch = 0; this.wheelSpin = 0;
    this.impact = 0; this.impactKind = 0; this.skid = 0; this.accel = 0;
    this.onGrass = false; this.surface = 0;
  }

  get speed() { return Math.hypot(this.vx, this.vz); }
  get fx() { return Math.sin(this.heading); }
  get fz() { return -Math.cos(this.heading); }

  step(dt, inp, cw) {
    const h = this.h;
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    const rx = -fz, rz = fx;
    let vF = this.vx * fx + this.vz * fz;
    let vR = this.vx * rx + this.vz * rz;
    const surf = cw.surfaceAt(this.x, this.z);
    const onGrass = !!(surf & SURF.GRASS) && !(surf & (SURF.ROAD | SURF.PAVED));
    const gripMul = onGrass ? 0.72 : 1;
    const speedAbs = Math.abs(vF);

    // Steering: less lock at speed, rate-limited.
    const steerLimit = h.steer / (1 + speedAbs / 14);
    const target = clamp(inp.steer, -1, 1) * steerLimit;
    this.steer += clamp(target - this.steer, -3.2 * dt, 3.2 * dt);

    // Boost meter.
    const boosting = !!inp.boost && this.boost > 0.01 && inp.throttle > 0 && vF > -1;
    this.boost = boosting ? Math.max(0, this.boost - dt / 4.5) : Math.min(1, this.boost + dt / 14);
    this.boosting = boosting;
    const vmax = h.maxSpeed * (boosting ? 1.22 : 1) * (onGrass ? 0.5 : 1);

    // Longitudinal forces.
    let a = 0;
    if (inp.throttle > 0) {
      if (vF < -0.5) a += h.brake * inp.throttle;
      else {
        const r = clamp(vF / vmax, 0, 1);
        a += inp.throttle * h.accel * (boosting ? 1.65 : 1) * (1 - Math.pow(r, 1.8));
      }
    }
    if (inp.brake > 0) {
      if (vF > 0.5) a -= h.brake * inp.brake;
      else if (vF > -h.maxReverse) a -= h.reverseAccel * inp.brake;
    }
    a -= h.drag * vF * Math.abs(vF);
    a -= (h.rolling + (onGrass ? 2.2 : 0)) * Math.sign(vF) * Math.min(1, Math.abs(vF));
    if (Math.abs(vF) > vmax + 0.5) a -= Math.sign(vF) * 4;
    if (inp.handbrake) a -= Math.sign(vF) * Math.min(Math.abs(vF) / dt, h.handbrakeDecel);
    const vF0 = vF;
    vF += a * dt;
    if (inp.brake > 0 && vF0 > 0.5 && vF < 0) vF = 0;
    if (inp.throttle > 0 && vF0 < -0.5 && vF > 0) vF = 0;
    if (!(inp.throttle > 0) && !(inp.brake > 0) && Math.abs(vF) < 0.2) vF = 0;

    // Lateral grip: bleed sideways velocity, limited by max tyre force.
    const grip = (inp.handbrake ? h.gripHandbrake : h.grip) * gripMul;
    const maxLat = h.maxLat * gripMul * (inp.handbrake ? 0.45 : 1);
    const latDecel = Math.min(Math.abs(vR) * grip, maxLat) * dt;
    vR -= Math.sign(vR) * Math.min(Math.abs(vR), latDecel);
    vF -= Math.sign(vF) * Math.min(Math.abs(vF), Math.abs(vR) * 0.35 * dt);

    // Yaw follows the bicycle model, capped by available grip.
    let yawT = (vF * Math.tan(this.steer)) / h.wheelbase;
    const yawCap = (maxLat * (inp.handbrake ? 2.6 : 1.3)) / Math.max(3, Math.abs(vF));
    yawT = clamp(yawT, -yawCap, yawCap);
    if (inp.handbrake && Math.abs(vF) > 6) yawT *= 1.55;
    this.yawRate += (yawT - this.yawRate) * Math.min(1, (inp.handbrake ? 4.5 : 11) * dt);

    // Velocity stays in the old frame; the body rotates under it.
    this.vx = fx * vF + rx * vR;
    this.vz = fz * vF + rz * vR;
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.vF = vF;
    this.vR = vR;
    this.accel = a;

    // Visual body motion.
    const latAcc = vF * this.yawRate;
    this.roll += (clamp(latAcc * 0.011, -0.075, 0.075) - this.roll) * Math.min(1, 6 * dt);
    this.pitch += (clamp(a * 0.0055, -0.06, 0.05) - this.pitch) * Math.min(1, 6 * dt);
    this.wheelSpin += (vF / h.wheelR) * dt;
    this.skid = clamp((Math.abs(vR) - 1.5) / 5, 0, 1) + (inp.brake > 0 && vF > 12 ? 0.35 : 0) + (inp.handbrake && Math.abs(vF) > 5 ? 0.45 : 0);
    this.surface = surf;
    this.onGrass = onGrass;
    this.collideStatic(cw);
  }

  collideStatic(cw) {
    const out = this._out, h = this.h;
    let impact = 0, kind = 0;
    for (let iter = 0; iter < 3; iter++) {
      let any = false;
      const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
      for (let c = 0; c < h.circles.length; c++) {
        const off = h.circles[c];
        const cx = this.x + fx * off, cz = this.z + fz * off;
        if (!cw.resolveCircle(cx, cz, h.radius, out)) continue;
        any = true;
        this.x += out.nx * out.depth;
        this.z += out.nz * out.depth;
        this.applyImpulse(out.nx, out.nz, off, 0.22, 0.12);
        if (this._lastVn > impact) { impact = this._lastVn; kind = out.kind; }
      }
      if (!any) break;
    }
    this.impact = impact;
    this.impactKind = kind;
  }

  // Bounce off a surface with normal n at longitudinal offset `off`.
  // Friction is Coulomb-style: tangential loss is bounded by the normal impulse,
  // so scraping along a wall keeps most of the car's speed.
  applyImpulse(nx, nz, off, restitution, friction) {
    this._lastVn = 0;
    const vn = this.vx * nx + this.vz * nz;
    if (vn >= 0) return;
    const jn = -(1 + restitution) * vn;
    this.vx += jn * nx;
    this.vz += jn * nz;
    const tx = -nz, tz = nx;
    const vt = this.vx * tx + this.vz * tz;
    const dvt = Math.sign(vt) * Math.min(Math.abs(vt), jn * friction * 2.5);
    this.vx -= dvt * tx;
    this.vz -= dvt * tz;
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    const cross = off * (fx * nz - fz * nx);
    this.yawRate = this.yawRate * 0.7 + clamp(cross * -vn * 0.07, -1.8, 1.8);
    this._lastVn = -vn;
  }
}
