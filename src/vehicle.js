// Arcade vehicle dynamics on the x/z plane. Heading is a compass angle:
// 0 = north (-z), +PI/2 = east (+x). Forward = (sin h, -cos h).

import { clamp, wrapAngle } from './util.js';
import { SURF } from './collision.js';

// Engine thrust is accel * (1 - (v / maxSpeed)^curve): maxSpeed is the true top
// speed (aero drag only applies off-throttle). The coupe does 0-60 mph in about
// 3.3 s like before, and now keeps pulling to 200 mph (89.4 m/s).
export const HANDLING = {
  coupe: { maxSpeed: 90.2, accel: 8.5, curve: 3.5, brake: 19, grip: 10, maxLat: 13, wheelbase: 2.7, steer: 0.62, mass: 1300 },
  taxi: { maxSpeed: 48.5, accel: 7.2, curve: 2.6, brake: 16, grip: 9, maxLat: 11.5, wheelbase: 2.8, steer: 0.6, mass: 1500 },
  suv: { maxSpeed: 46, accel: 6.8, curve: 2.6, brake: 15, grip: 8.4, maxLat: 10.5, wheelbase: 2.9, steer: 0.58, mass: 2100 },
};

const DEFAULTS = {
  maxSpeed: 58, accel: 8.5, curve: 2.6, brake: 16, reverseAccel: 6, maxReverse: 13, drag: 0.00085, rolling: 0.25,
  grip: 9, gripHandbrake: 1.6, maxLat: 12, handbrakeDecel: 5.5, wheelbase: 2.7, steer: 0.6,
  wheelR: 0.35, radius: 0.98, circles: [-1.42, 0, 1.42], mass: 1400,
};
const GRAVITY = 24;

export class Vehicle {
  constructor(handling = {}, dims = {}) {
    this.h = { ...DEFAULTS, ...handling, ...dims };
    this.boost = 1;
    this.boosting = false;
    this._out = { depth: 0, nx: 0, nz: 0, kind: 0 };
    this.reset(0, 0, 0);
  }

  reset(x, z, heading, y = 0) {
    this.x = x; this.z = z; this.heading = heading;
    this.y = y; this.vy = 0; this.airborne = false; this.airTime = 0; this.landImpact = 0;
    this.slopePitch = 0; this.slopeRoll = 0; this.onDeck = false; this.inCut = false;
    this._g = this._g || { h: 0, deck: false, inCut: false };
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
    const atGround = !this.onDeck && Math.abs(this.y - cw.groundAt(this.x, this.z)) < 0.4;
    const onGrass = atGround && !!(surf & SURF.GRASS) && !(surf & (SURF.ROAD | SURF.PAVED));
    if (this.airborne) { this.stepAir(dt, cw); return; }
    const gripMul = onGrass ? 0.72 : 1;
    const speedAbs = Math.abs(vF);

    // Steering: less lock at speed, rate-limited.
    const steerLimit = h.steer / (1 + speedAbs / 14);
    const target = clamp(inp.steer, -1, 1) * steerLimit;
    this.steer += clamp(target - this.steer, -3.2 * dt, 3.2 * dt);

    // Boost meter: more thrust, same top speed.
    const boosting = !!inp.boost && this.boost > 0.01 && inp.throttle > 0 && vF > -1;
    this.boost = boosting ? Math.max(0, this.boost - dt / 4.5) : Math.min(1, this.boost + dt / 14);
    this.boosting = boosting;
    const vmax = h.maxSpeed * (onGrass ? 0.5 : 1);

    // Longitudinal forces.
    let a = 0;
    if (inp.throttle > 0) {
      if (vF < -0.5) a += h.brake * inp.throttle;
      else {
        const r = clamp(vF / vmax, 0, 1);
        a += inp.throttle * h.accel * (boosting ? 1.6 : 1) * (1 - Math.pow(r, h.curve));
      }
    } else {
      a -= h.drag * vF * Math.abs(vF);
    }
    if (inp.brake > 0) {
      if (vF > 0.5) a -= h.brake * inp.brake;
      else if (vF > -h.maxReverse) a -= h.reverseAccel * inp.brake;
    }
    // Gravity along slopes (gentle, arcade).
    a -= GRAVITY * 0.35 * Math.sin(this.slopePitch);
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
    this.followGround(dt, cw);
    this.collideStatic(cw);
  }

  // Track the road surface; leave it (go airborne) when it drops away faster
  // than the car would fall, e.g. cresting a ramp at speed.
  followGround(dt, cw) {
    const g = this._g;
    cw.groundHeight(this.x, this.z, this.y, g);
    this.onDeck = g.deck; this.inCut = g.inCut;
    const yPred = this.y + this.vy * dt - 0.5 * GRAVITY * dt * dt;
    // Vertical speed the road itself implies (slope x forward speed). Steps
    // (kerbs, ramp edges) snap the car up without launching it.
    const vSlope = this.vF * Math.tan(this.slopePitch);
    if (yPred > g.h + 0.06) {
      this.y = yPred;
      this.vy -= GRAVITY * dt;
      this.airborne = true;
      this.airTime = 0;
    } else {
      this.vy = clamp((g.h - this.y) / dt, vSlope - 1.5, vSlope + 1.5);
      this.y = g.h;
    }
    // Visual/physical slope from the surface just ahead and behind.
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    const L = 1.4, gf = this._gf || (this._gf = {}), gb = this._gb || (this._gb = {});
    const hf = cw.groundHeight(this.x + fx * L, this.z + fz * L, this.y, gf);
    const hb = cw.groundHeight(this.x - fx * L, this.z - fz * L, this.y, gb);
    const target = Math.abs(hf - hb) < 2.5 ? Math.atan2(hf - hb, 2 * L) : 0;
    this.slopePitch += (target - this.slopePitch) * Math.min(1, 12 * dt);
    // Lean with a cross-slope (visual only; kerbs and deck edges don't count).
    const W = 0.8, gl = this._gl || (this._gl = {}), gr = this._gr || (this._gr = {});
    const hr = cw.groundHeight(this.x - fz * W, this.z + fx * W, this.y, gr);
    const hl = cw.groundHeight(this.x + fz * W, this.z - fx * W, this.y, gl);
    const roll = Math.abs(hr - hl) < 0.5 ? Math.atan2(hr - hl, 2 * W) : 0;
    this.slopeRoll += (roll - this.slopeRoll) * Math.min(1, 10 * dt);
  }

  stepAir(dt, cw) {
    this.airTime += dt;
    this.vy -= GRAVITY * dt;
    const sp = Math.hypot(this.vx, this.vz);
    const drag = 1 - Math.min(1, this.h.drag * sp * dt);
    this.vx *= drag; this.vz *= drag;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y += this.vy * dt;
    this.heading = wrapAngle(this.heading + this.yawRate * dt);
    this.yawRate *= Math.exp(-1.5 * dt);
    this.steer *= Math.exp(-3 * dt);
    const fx = Math.sin(this.heading), fz = -Math.cos(this.heading);
    this.vF = this.vx * fx + this.vz * fz;
    this.vR = this.vx * -fz + this.vz * fx;
    this.wheelSpin += (this.vF / this.h.wheelR) * dt;
    this.skid = 0;
    // Nose follows the flight path.
    const fp = Math.atan2(this.vy, Math.max(4, Math.abs(this.vF)));
    this.slopePitch += (fp * 0.6 - this.slopePitch) * Math.min(1, 3 * dt);
    const g = this._g;
    cw.groundHeight(this.x, this.z, this.y + 0.2, g);
    if (this.y <= g.h) {
      this.landImpact = Math.max(0, -this.vy);
      this.y = g.h;
      this.vy = 0;
      this.airborne = false;
      this.onDeck = g.deck; this.inCut = g.inCut;
    }
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
        if (!cw.resolveCircle(cx, cz, h.radius, out, this.y)) continue;
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
