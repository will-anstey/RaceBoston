// Flight physics for the aircraft you fly (and the blimp): a rigid body with
// lift, drag, side force and thrust from the air it moves through (wind and
// gusts included), wheels on springs with brakes, nosewheel steering and
// tyre friction, and a fly-by-wire style control law: the stick asks for a
// roll rate and a load factor (let go and she holds her bank and flight
// path, turns are compensated up to 33 degrees of bank), the angle of attack
// is kept short of the stall, and the yaw damper keeps the turns coordinated.
// On the ground the stick pitches her directly, so you rotate at VR, and
// after touchdown the nose comes down gently on its own.
//
// Body frame: x right, y up, z back (the nose points along -z), origin at the
// centre of gravity. World: x east, y up, z south.

import * as THREE from 'three';
import { clamp } from './util.js';
import { AIRCRAFT } from './aircraft.js';

const G = 9.81;
const DEG = Math.PI / 180;
export const KT = 0.514444;          // m/s per knot
export const FT = 0.3048;            // m per foot
const RHO0 = 1.225;

// International Standard Atmosphere (troposphere and the bottom of the stratosphere).
export function atmosphere(h, out = {}) {
  const hh = clamp(h, -500, 20000);
  const T = hh < 11000 ? 288.15 - 0.0065 * hh : 216.65;
  const rho = hh < 11000 ? RHO0 * Math.pow(T / 288.15, 4.2559) : 0.3639 * Math.exp(-(hh - 11000) / 6341.6);
  out.rho = rho; out.sigma = rho / RHO0; out.a = Math.sqrt(401.87 * T);
  return out;
}

// Ground surfaces (from the world below: see FlightMode.ground).
export const GROUND = { SEA: 0, PAVED: 1, GRASS: 2, SAND: 3, WATER: 4, BUILDING: 5, ICE: 6 };
const ROLL = [0.02, 0.016, 0.065, 0.12, 0.02, 0.05, 0.01];      // rolling resistance
const GRIP = [0.5, 0.85, 0.5, 0.4, 0.5, 0.5, 0.12];             // tyre side / brake grip

const _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _r = new THREE.Vector3();
const _p = new THREE.Vector3(), _vp = new THREE.Vector3(), _fw = new THREE.Vector3(), _tq = new THREE.Vector3();
const _F = new THREE.Vector3(), _M = new THREE.Vector3(), _wW = new THREE.Vector3(), _ax = new THREE.Vector3();
const _qi = new THREE.Quaternion(), _dq = new THREE.Quaternion(), _e = new THREE.Euler();
const _ground = { h: 0, kind: 1, wet: 0 };

export class FlightBody {
  constructor(type, { mass = null } = {}) {
    this.type = type;
    const T = (this.T = AIRCRAFT[type]);
    this.mass = mass || T.load;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.w = new THREE.Vector3();        // body rates (rad/s) about body x (pitch up), y (yaw left), z (roll left)
    this.wind = new THREE.Vector3();     // the air's motion here (mean + gusts), m/s
    this.fwd = new THREE.Vector3(0, 0, -1); this.up = new THREE.Vector3(0, 1, 0); this.right = new THREE.Vector3(1, 0, 0);
    this.n1 = T.idle;                   // engine power, idle .. 1 (full)
    this.throttle = 0;
    this.flap = 0;                      // selected notch
    this.flapPos = 0;                   // where the flaps are (notch units, moving)
    this.gearDown = true; this.gearPos = 1;
    this.spoiler = 0;
    this.reverse = 0;
    this.brake = 0; this.parkBrake = false;
    this.steer = 0;
    this.surf = { elevator: 0, aileron: 0, rudder: 0 };   // control surface deflections (-1..1), for the model
    this.wheels = this._wheels();
    this.points = T.parts.map(([id, x, y, z, r]) => ({ id, x, y, z, r: r || 0.8 }));
    this.onGround = false; this.wheelsDown = false; this.noseDown = false;
    this.airTime = 0; this.groundTime = 0;
    this.alpha = 0; this.beta = 0; this.ias = 0; this.tas = 0; this.mach = 0; this.gload = 1; this.agl = 0;
    this.bankHold = 0; this.stall = 0; this.protect = false;
    this.lastTouch = null;              // the latest touchdown: { vs, ias, bank, pitch, ... }
    this.bounces = 0;
    this.contact = null;                // a part that isn't a wheel touching something: { part, speed, vs, kind }
    this.crashed = null;
    this.prop = 0;                      // propeller angle (for the model)
    this.thrustN = 0;
    this.atm = atmosphere(0);
    this.inertia = new THREE.Vector3(
      this.mass * (0.25 * T.len) ** 2,                                   // pitch
      this.mass * ((0.25 * T.len) ** 2 + (0.18 * T.span) ** 2),          // yaw
      this.mass * (0.18 * T.span) ** 2,                                  // roll
    );
  }

  // Wheels on springs: ~0.12 m of static squash, well damped.
  _wheels() {
    const T = this.T, gw = T.gear, m = this.mass;
    const zn = gw.nose, zm = gw.mains[1];
    const fn = zm / (zm - zn);                   // share of the weight on the nosewheel
    const d0 = gw.squash ?? 0.12;
    const list = [{ id: 'nose', x: 0, z: zn, share: fn, steer: true }];
    for (const s of [-1, 1]) list.push({ id: s < 0 ? 'left' : 'right', x: s * gw.mains[0], z: zm, share: (1 - fn) / 2, steer: false });
    for (const w of list) {
      // (A nose strut is stiffer than its share of the weight needs: she doesn't dive braking.)
      w.k = ((w.share * m * G) / d0) * (w.steer ? 3 : 1);
      w.c = 2 * 0.6 * Math.sqrt(w.k * w.share * m);
      w.y = -T.cgH - d0;                         // tyre bottom, legs fully extended
      w.load = 0; w.touch = false; w.spin = 0;
    }
    return list;
  }

  get speed() { return this.vel.length(); }
  get gs() { return Math.hypot(this.vel.x, this.vel.z); }
  get heading() { return Math.atan2(this.fwd.x, -this.fwd.z); }
  get track() { return this.gs > 1 ? Math.atan2(this.vel.x, -this.vel.z) : this.heading; }
  get pitch() { return Math.asin(clamp(this.fwd.y, -1, 1)); }
  get bank() { return Math.atan2(-this.right.y, this.up.y); }
  get vs() { return this.vel.y; }
  // Flight path angle (through the air would differ a little in wind).
  get gamma() { const h = this.gs; return h + Math.abs(this.vel.y) > 0.5 ? Math.atan2(this.vel.y, h) : 0; }
  get blimp() { return this.T.engine === 'blimp'; }

  // Put her down (or up): CG position, compass heading, speed along the nose.
  reset(x, y, z, heading, { speed = 0, pitch = 0, airborne = false, gear = !airborne || !this.T.gearRetract, flap = 0, throttle = 0 } = {}) {
    this.pos.set(x, y, z);
    _e.set(pitch, -heading, 0, 'YXZ');
    this.q.setFromEuler(_e);
    this._axes();
    this.vel.copy(this.fwd).multiplyScalar(speed);
    this.w.set(0, 0, 0);
    this.throttle = throttle; this.n1 = Math.max(this.T.idle, this.T.idle + (1 - this.T.idle) * throttle);
    this.flap = flap; this.flapPos = flap;
    this.gearDown = gear; this.gearPos = gear ? 1 : 0;
    this.spoiler = 0; this.reverse = 0; this.brake = 0; this.parkBrake = !airborne && speed < 0.1;
    this.steer = 0; this.bankHold = 0; this.stall = 0;
    this.onGround = !airborne; this.wheelsDown = !airborne;
    this.airTime = airborne ? 30 : 0; this.groundTime = airborne ? 0 : 30;
    this.lastTouch = null; this.contact = null; this.crashed = null; this.bounces = 0; this.touched = !airborne; this.prevWheels = !airborne;
    for (const w of this.wheels) { w.load = 0; w.touch = false; }
  }

  _axes() {
    this.fwd.set(0, 0, -1).applyQuaternion(this.q);
    this.up.set(0, 1, 0).applyQuaternion(this.q);
    this.right.set(1, 0, 0).applyQuaternion(this.q);
  }

  // World position of a body-frame point.
  worldPoint(x, y, z, out) { return out.set(x, y, z).applyQuaternion(this.q).add(this.pos); }

  // Velocity (world) of the point at offset r (world) from the CG.
  _pointVel(r, out) {
    _wW.copy(this.w).applyQuaternion(this.q);
    return out.crossVectors(_wW, r).add(this.vel);
  }

  // ------------------------------------------------------------- aero
  _flapAt(fp) {
    const F = this.T.flaps, i = clamp(Math.floor(fp), 0, F.length - 1), t = clamp(fp - i, 0, 1);
    const a = F[i], b = F[Math.min(F.length - 1, i + 1)];
    return { cl: a.cl + (b.cl - a.cl) * t, clmax: a.clmax + (b.clmax - a.clmax) * t, cd: a.cd + (b.cd - a.cd) * t };
  }

  // Lift coefficient at angle of attack a (rad).
  clOf(a, fl, spoil) {
    const T = this.T;
    const c0 = T.cl0 + fl.cl - spoil * 0.45, cmax = T.clmax + fl.clmax - spoil * 0.35;
    const aS = (cmax - c0) / T.cla;
    if (a < -0.25) return c0 - T.cla * 0.25 + (a + 0.25) * 1.2;
    if (a <= aS) return c0 + T.cla * a;
    return Math.max(cmax * 0.62, cmax - 2.2 * (a - aS));      // past the stall
  }

  stallAlpha(fp = this.flapPos, spoil = this.spoiler) {
    const T = this.T, fl = this._flapAt(fp);
    return (T.clmax + fl.clmax - spoil * 0.35 - (T.cl0 + fl.cl - spoil * 0.45)) / T.cla;
  }

  // Stall speed (EAS) at a mass and flap setting.
  stallSpeed(fp = this.flapPos, mass = this.mass) {
    const fl = this._flapAt(fp);
    return Math.sqrt((2 * mass * G) / (RHO0 * this.T.wingArea * (this.T.clmax + fl.clmax)));
  }
  // Rotation and approach speeds for this weight (takeoff / landing flaps).
  vr(mass = this.mass) { return Math.max(this.T.vr * Math.sqrt(mass / this.T.load), this.stallSpeed(this.T.toFlap, mass) * 1.1); }
  vref(mass = this.mass) { return Math.max(this.T.vref * Math.sqrt(mass / this.T.load), this.stallSpeed(this.T.flaps.length - 1, mass) * 1.23); }

  // ------------------------------------------------------------- thrust
  _thrust(V) {
    const T = this.T, sig = this.atm.sigma;
    if (T.engine === 'blimp') return T.engines * T.thrust * this.blimpThrottle;
    const p = clamp((this.n1 - T.idle * 0.6) / (1 - T.idle * 0.6), 0, 1);
    let F;
    if (T.engine === 'jet') {
      const M = V / this.atm.a;
      F = T.engines * T.thrust * Math.pow(sig, 0.8) * (1 - 0.9 * M + 0.6 * M * M) * Math.pow(p, 1.25);
    } else {
      const P = T.engines * T.power * Math.max(0.05, (sig - 0.12) / 0.88) * p;
      F = Math.min(T.engines * T.thrust * p, (0.82 * P) / Math.max(V, 6));
    }
    if (this.reverse > 0.02 && T.reverser) F = F * (1 - this.reverse) - T.engines * T.thrust * 0.4 * this.reverse * clamp((this.n1 - T.idle) / (1 - T.idle), 0, 1);
    return F;
  }

  // ------------------------------------------------------------- step
  // ctl: { throttle 0..1 (blimp: -0.5..1), elevator, aileron, rudder (-1..1:
  //        pull / right / right), brake 0..1, steer -1..1, reverse 0..1,
  //        speedbrake, trim (blimp ballast -1..1), assist }
  // env: { ground(x, z, out) -> {h, kind, wet}, wind(x, y, z, out, dt), obstacle(x, y, z, r) }
  step(dt, ctl, env) {
    if (this.crashed && this.crashed.stopped) return;
    const T = this.T, m = this.mass, blimp = this.blimp;
    this._axes();
    atmosphere(this.pos.y, this.atm);
    // ---- systems
    if (blimp) {
      this.throttle = clamp(ctl.throttle, -0.5, 1);
      this.blimpThrottle = (this.blimpThrottle || 0) + (this.throttle - (this.blimpThrottle || 0)) * (1 - Math.exp(-dt / T.spoolUp));
      this.n1 = Math.abs(this.blimpThrottle);
    } else {
      this.throttle = clamp(ctl.throttle, 0, 1);
      const want = T.idle + (1 - T.idle) * this.throttle;
      this.n1 += (want - this.n1) * (1 - Math.exp(-dt / (want > this.n1 ? T.spoolUp : T.spoolDown)));
    }
    if (this.flapPos !== this.flap) this.flapPos += clamp(this.flap - this.flapPos, -dt * T.flapRate, dt * T.flapRate);
    if (T.gearRetract) {
      if (!this.gearDown && this.wheelsDown) this.gearDown = true;          // (weight on wheels: it won't come up)
      this.gearPos = clamp(this.gearPos + ((this.gearDown ? 1 : -1) * dt) / T.gearTime, 0, 1);
    }
    this.reverse += ((ctl.reverse > 0 && this.wheelsDown && T.reverser ? ctl.reverse : 0) - this.reverse) * (1 - Math.exp(-dt / 0.8));
    // Ground spoilers on touchdown (thrust at idle), speed brakes in the air.
    const groundSpoil = this.wheelsDown && T.spoilers && this.throttle < 0.06 && this.groundTime > 0.25 && this.speed > 12 ? 1 : 0;
    this.spoiler += (Math.max(groundSpoil, ctl.speedbrake && T.spoilers ? 0.6 : 0) - this.spoiler) * (1 - Math.exp(-dt / 0.35));
    this.brake = clamp(ctl.brake, 0, 1);
    if (this.throttle > 0.05 || this.brake > 0.05) this.parkBrake = false;
    const steerMax = T.steer * (1 - clamp((this.gs - 3) / 15, 0, 0.9));
    this.steer += (clamp(ctl.steer, -1, 1) * steerMax - this.steer) * (1 - Math.exp(-dt / 0.15));

    // ---- the air
    env.wind(this.pos.x, this.pos.y, this.pos.z, this.wind, dt);
    _v.subVectors(this.vel, this.wind);                 // motion through the air (world)
    const V = _v.length();
    _qi.copy(this.q).invert();
    _a.copy(_v).applyQuaternion(_qi);                   // ...in body axes
    const u = -_a.z;
    this.alpha = V > 1 ? Math.atan2(-_a.y, Math.max(0.1, Math.abs(u))) : 0;
    this.beta = V > 1 ? Math.asin(clamp(_a.x / V, -1, 1)) : 0;
    const qd = 0.5 * this.atm.rho * V * V;
    this.tas = V; this.ias = V * Math.sqrt(this.atm.sigma); this.mach = V / this.atm.a;
    const fl = this._flapAt(this.flapPos);
    env.ground(this.pos.x, this.pos.z, _ground);
    const agl = Math.max(0, this.pos.y - T.cgH - Math.max(_ground.h, 0));
    this.agl = agl;
    this.groundKind = _ground.kind;
    const F = _F.set(0, 0, 0);
    if (blimp) {
      // A big envelope: little drag end-on, a lot side-on and up and down; the
      // fins give her a little lift when she pitches.
      const S = T.wingArea;
      _b.set(-0.5 * this.atm.rho * S * 0.55 * Math.abs(_a.x) * _a.x, -0.5 * this.atm.rho * S * 0.65 * Math.abs(_a.y) * _a.y + qd * S * 0.25 * this.alpha, -0.5 * this.atm.rho * S * T.cd0 * Math.abs(_a.z) * _a.z);
      F.add(_b.applyQuaternion(this.q));
      F.addScaledVector(this.fwd, this._thrust(V));
      this.thrustN = this._thrust(V);
      // Weight less buoyancy: a little heavy, trimmed with the ballonets.
      F.y -= m * G * (T.heavy - clamp(ctl.trim || 0, -1, 1) * 0.03);
      // Elevators at speed, the props swivelled up or down in the hover.
      F.y += clamp(ctl.elevator, -1, 1) * m * G * 0.02 * (0.6 + 0.4 * clamp(this.ias / 12, 0, 1));
    } else {
      // Ground effect: more lift and less induced drag within half a span of the ground.
      const ge = clamp(1 - agl / (0.5 * T.span), 0, 1);
      this.geF = 1 + 0.1 * ge * ge;                   // (the fly-by-wire law allows for it too)
      const CL = this.clOf(this.alpha, fl, this.spoiler) * this.geF;
      const AR = (T.span * T.span) / T.wingArea;
      const CDi = ((CL * CL) / (Math.PI * T.e * AR)) * (1 - 0.6 * ge * ge);
      const M = this.mach, mc = T.mcrit || 0.75, wave = M > mc ? 20 * (M - mc) ** 3 + 0.4 * (M - mc) ** 2 : 0;
      const CD = T.cd0 + CDi + fl.cd + (T.gearRetract ? this.gearPos * T.gearCd : 0) + this.spoiler * 0.06 + wave
        + Math.max(0, Math.abs(this.alpha) - this.stallAlpha()) * 0.9;
      this.cl = CL; this.cd = CD;
      if (V > 0.5) {
        const vd = _b.copy(_v).divideScalar(V);
        _fw.crossVectors(this.right, vd);                // lift: across the airflow, in the plane of symmetry
        const lf = _fw.length();
        if (lf > 1e-4) F.addScaledVector(_fw, (qd * T.wingArea * CL) / lf);
        F.addScaledVector(vd, -qd * T.wingArea * CD);
        F.addScaledVector(this.right, -qd * T.wingArea * T.cyb * this.beta);
      }
      this.thrustN = this._thrust(V);
      F.addScaledVector(this.fwd, this.thrustN);
      F.y -= m * G;
      this.dbg = { L: qd * T.wingArea * CL, D: qd * T.wingArea * CD, Th: this.thrustN, CL, CD, qd, beta: this.beta, wx: this.wind.x, wy: this.wind.y, wz: this.wind.z, ge };
    }

    // ---- wheels on the ground
    const Mc = _M.set(0, 0, 0);
    if (this.dbg) { this.dbg.fr = 0; this.dbg.fs = 0; this.dbg.N = 0; }
    let wheels = false, mains = false;
    const gearOut = !T.gearRetract || this.gearPos > 0.95;
    for (const wh of this.wheels) {
      wh.touch = false; wh.load = 0;
      if (!gearOut) continue;
      _r.set(wh.x, wh.y, wh.z).applyQuaternion(this.q);          // CG to the tyre (legs extended), world
      _p.copy(_r).add(this.pos);
      env.ground(_p.x, _p.z, _ground);
      const pen = _ground.h - _p.y;
      if (pen <= 0) continue;
      wh.touch = true; wheels = true;
      if (!wh.steer) mains = true;
      _r.y += pen;                                                  // (the contact patch)
      const vp = this._pointVel(_r, _vp);
      let N = wh.k * Math.min(pen, 1.2) - wh.c * vp.y;
      if (pen > 0.8) N += wh.k * 10 * (pen - 0.8);                  // bottomed out
      N = Math.max(0, N);
      wh.load = N;
      if (_ground.kind === GROUND.WATER || _ground.kind === GROUND.SEA) this._ditch(vp);
      // The tyre's rolling and side directions (the nosewheel steers).
      const sx = wh.steer ? Math.sin(this.steer) : 0, sz = wh.steer ? Math.cos(this.steer) : 1;
      let rx = this.fwd.x * sz + this.right.x * sx, rz = this.fwd.z * sz + this.right.z * sx;
      const rl = Math.hypot(rx, rz) || 1;
      rx /= rl; rz /= rl;
      const vRoll = vp.x * rx + vp.z * rz, vSide = vp.x * -rz + vp.z * rx;
      const grip = GRIP[_ground.kind] * (1 - 0.3 * (_ground.wet || 0));
      const brk = wh.steer ? 0 : Math.max(this.brake, this.parkBrake ? 1 : 0);
      const fRoll = -(ROLL[_ground.kind] + brk * grip * 0.8) * N * clamp(vRoll / 0.4, -1, 1);
      const fSide = -grip * N * clamp(vSide / 0.3, -1, 1);
      _b.set(rx * fRoll - rz * fSide, N, rz * fRoll + rx * fSide);
      F.add(_b);
      if (this.dbg) { this.dbg.fr = (this.dbg.fr || 0) + fRoll; this.dbg.fs = (this.dbg.fs || 0) + fSide; this.dbg.N = (this.dbg.N || 0) + N; this.dbg.kind = _ground.kind; }
      Mc.add(_tq.crossVectors(_r, _b));
      wh.spin += (vRoll / (T.gear.wheelR || 0.5)) * dt;
    }
    // Touchdown (and bounces): the first wheel down after time in the air.
    if (wheels && !this.prevWheels) {
      if (this.airTime > 3 && !this.touched) {
        this.touched = true;
        const nose = !mains;
        const vp = this._pointVel(_r.set(0, -T.cgH, nose ? T.gear.nose : T.gear.mains[1]).applyQuaternion(this.q), _vp);
        this.lastTouch = { vs: -vp.y, ias: this.ias, bank: this.bank, pitch: this.pitch, beta: this.beta, noseFirst: nose, x: this.pos.x, z: this.pos.z, heading: this.heading, track: this.track, kind: this.groundKind, t: this.clock || 0 };
        this.bounces = 0;
      } else if (this.touched && this.airTime > 0.25) this.bounces++;
    }
    this.prevWheels = wheels;
    this.wheelsDown = mains || (wheels && this.wheelsDown);
    this.noseDown = this.wheels[0].touch;
    // Parts that aren't wheels: a tail strike, a wingtip, the belly, an engine pod.
    this.contact = null;
    for (const pt of this.points) {
      _r.set(pt.x, pt.y, pt.z).applyQuaternion(this.q);
      _p.copy(_r).add(this.pos);
      env.ground(_p.x, _p.z, _ground);
      const pen = _ground.h - _p.y;
      let kind = pen > 0 ? _ground.kind : -1;
      if (kind < 0 && env.obstacle && env.obstacle(_p.x, _p.y, _p.z, pt.r)) kind = GROUND.BUILDING;
      if (kind < 0) continue;
      const vp = this._pointVel(_r, _vp);
      const sp = vp.length();
      if (!this.contact || sp > this.contact.speed) this.contact = { part: pt.id, speed: sp, vs: -vp.y, kind };
      if (kind === GROUND.BUILDING) continue;     // (the mode decides what a building strike does)
      if (kind === GROUND.WATER || kind === GROUND.SEA) this._ditch(vp);
      // Scraping along: a stiff spring and a lot of friction.
      const k = m * G * 5, N = Math.max(0, k * Math.min(pen, 1.5) - 0.9 * Math.sqrt(k * m) * vp.y);
      const hv = Math.hypot(vp.x, vp.z) || 1, fr = 0.45 * N * clamp(hv / 0.5, 0, 1);
      _b.set((-vp.x / hv) * fr, N, (-vp.z / hv) * fr);
      F.add(_b);
      Mc.add(_tq.crossVectors(_r, _b));
    }
    this.onGround = wheels || !!this.contact;
    if (wheels) { this.groundTime += dt; this.airTime = 0; }
    else { this.airTime += dt; this.groundTime = 0; if (this.airTime > 3) this.touched = false; }
    this.clock = (this.clock || 0) + dt;

    // ---- the control law
    if (blimp) this._blimpControl(dt, ctl);
    else this._control(dt, ctl, V, qd, fl, wheels);

    // ---- integrate
    _ax.copy(F).divideScalar(m);
    this.gload = (_ax.dot(this.up) + G * this.up.y) / G;
    this.vel.addScaledVector(_ax, dt);
    this.pos.addScaledVector(this.vel, dt);
    Mc.applyQuaternion(_qi);                     // contact torque into body axes
    const I = this.inertia;
    this.w.x += (Mc.x / I.x) * dt; this.w.y += (Mc.y / I.y) * dt; this.w.z += (Mc.z / I.z) * dt;
    const wl = this.w.length();
    if (wl > 1e-9) {
      _dq.setFromAxisAngle(_b.copy(this.w).divideScalar(wl), wl * dt);
      this.q.multiply(_dq).normalize();
    }
    this.prop = (this.prop + dt * (blimp ? 6 + this.n1 * 30 : 10 + this.n1 * 45)) % (Math.PI * 2);
    if (this.crashed) {
      this.vel.multiplyScalar(Math.exp(-dt * 1.5)); this.w.multiplyScalar(Math.exp(-dt * 2.5));
      if (this.speed < 0.6) this.crashed.stopped = true;
    }
  }

  _ditch(vp) {
    if (!this.crashed) this.crashed = { reason: 'water', speed: vp.length() };
  }

  // The fly-by-wire law: body-rate commands, tracked with an authority that
  // grows with dynamic pressure.
  _control(dt, ctl, V, qd, fl, wheels) {
    const T = this.T, w = this.w;
    const eff = clamp(qd / (0.5 * RHO0 * (T.vr * 0.75) ** 2), 0, 1.3);
    const phi = this.bank, theta = this.pitch, gam = this.gamma;
    const inAir = !wheels && this.airTime > 0.3;
    const blend = inAir ? clamp((this.airTime - 0.3) / 2.5, 0, 1) : 0;
    const e = clamp(ctl.elevator, -1, 1), a = clamp(ctl.aileron, -1, 1), r = clamp(ctl.rudder, -1, 1);
    const sf = this.surf, k12 = 1 - Math.exp(-dt / 0.12);
    sf.elevator += (e - sf.elevator) * k12;
    sf.aileron += (a - sf.aileron) * k12;
    sf.rudder += (clamp(r + (wheels ? ctl.steer * 0.5 : 0), -1, 1) - sf.rudder) * k12;
    // ---- roll (pilot P: + = right)
    let P;
    if (!inAir) { P = a * T.rates.roll * 0.4; this.bankHold = 0; }
    else if (Math.abs(a) > 0.03) { P = a * T.rates.roll; this.bankHold = null; }
    else {
      if (this.bankHold === null) this.bankHold = Math.abs(phi) < 7 * DEG ? 0 : clamp(phi, -33 * DEG, 33 * DEG);
      P = clamp(2.2 * (this.bankHold - phi), -T.rates.roll, T.rates.roll);
    }
    if (phi > 67 * DEG) P = Math.min(P, 2 * (67 * DEG - phi));
    if (phi < -67 * DEG) P = Math.max(P, 2 * (-67 * DEG - phi));
    // ---- pitch (pilot Q: + = nose up)
    // On the ground (and as she leaves it) the stick sets a pitch attitude:
    // full back rotates to just short of a tail strike and holds it; let go
    // and the nose comes down onto its wheel. In the air it asks for g: let
    // go and she holds her flight path.
    const Vs = Math.max(V, 15);
    const aStall = this.stallAlpha();
    const auth = wheels ? clamp((this.ias - T.vr * 0.6) / (T.vr * 0.3), 0, 1) : 1;
    const rotMax = wheels ? Math.min(T.tailStrike - 1.2 * DEG, 12 * DEG) : 15 * DEG;
    const thT = e >= 0 ? e * rotMax : e * 4 * DEG;
    let Qatt = clamp(2.2 * (thT - theta), -T.rates.pitch, T.rates.pitch);
    if (wheels && Qatt < 0) Qatt = Math.max(Qatt, -T.rates.pitch * 0.3);     // (lower the nose gently)
    Qatt *= auth;
    let Q;
    if (blend > 0) {
      const phic = clamp(phi, -33 * DEG, 33 * DEG);
      const n = Math.cos(gam) / Math.cos(phic) + (e > 0 ? e * T.nUp : e * T.nDn);
      const geF = this.geF || 1;                       // the extra lift in ground effect: no ballooning in the flare
      const clReq = (n * this.mass * G) / Math.max(1, qd * T.wingArea) / geF;
      const c0 = T.cl0 + fl.cl - this.spoiler * 0.45;
      const aProt = aStall - (ctl.assist === false ? -0.25 : 2.2 * DEG);
      const aWant = (clReq - c0) / T.cla;
      this.protect = aWant > aProt;
      const aReq = clamp(aWant, -6 * DEG, aProt);
      // The flight path curves with the lift she'll actually get at that angle.
      const nAch = ((c0 + T.cla * aReq) * geF * qd * T.wingArea) / (this.mass * G);
      const qss = (G * (nAch - Math.cos(gam) * Math.cos(phi))) / Vs;
      // (Just after liftoff the stick still pitches her at a rate, blending into the g law.)
      Q = (qss + T.kAlpha * (aReq - this.alpha)) * blend + e * T.rates.pitch * 0.6 * (1 - blend);
    } else {
      Q = Qatt;
      this.protect = false;
    }
    // The nose drops in a stall (with the protection off, or overwhelmed).
    if (inAir && this.alpha > aStall) Q -= (this.alpha - aStall) * 4;
    // Pitch attitude protection: no more than 25 degrees up or 15 down.
    if (inAir && ctl.assist !== false) {
      if (theta > 25 * DEG) Q = Math.min(Q, 2 * (25 * DEG - theta));
      if (theta < -15 * DEG) Q = Math.max(Q, 2 * (-15 * DEG - theta));
    }
    Q = clamp(Q, -T.rates.pitch * 1.6, T.rates.pitch * 1.6);
    // On the ground: stop rotating at the tail-strike angle.
    if (wheels && Q > 0 && this.pitch > T.tailStrike - 1.5 * DEG) Q *= clamp((T.tailStrike - this.pitch) / (1.5 * DEG), 0, 1);
    // ---- yaw (pilot R: + = right): coordinated turns, the yaw damper, the rudder.
    let R = r * T.rates.yaw;
    if (inAir) {
      const Om = (G * Math.tan(clamp(phi, -1.3, 1.3))) / Vs;
      // (Sideslip to the right, beta > 0: yaw right, into the airflow.)
      R += Om * Math.cos(phi) * Math.cos(theta) + this.beta * 2 * Math.min(1, eff);
    }
    // Body rates: pitch about +x, yaw about -y, roll about -z. The pitch
    // authority on the ground is weak unless the stick is moved, so the
    // wheels settle her.
    let kp = T.k.pitch * Math.min(eff, 1.2), ky = T.k.yaw * Math.min(eff, 1.2), kr = T.k.roll * Math.min(eff, 1.2);
    if (wheels) {
      ky *= clamp((this.ias - 20) / 40, 0, 1);
      if (Math.abs(e) < 0.05 && this.noseDown) kp *= 0.15;
      kr *= 0.3;
    }
    if (this.dbg) { this.dbg.Q = Q; this.dbg.P = P; this.dbg.R = R; this.dbg.blend = blend; this.dbg.kp = kp; this.dbg.wx = w.x; }
    w.x += (Q - w.x) * (1 - Math.exp(-dt * kp));
    w.y += (-R - w.y) * (1 - Math.exp(-dt * ky));
    w.z += (-P - w.z) * (1 - Math.exp(-dt * kr));
    this.stall = inAir ? clamp((this.alpha - aStall + 2 * DEG) / (3 * DEG), 0, 1) : 0;
  }

  // The blimp: the rudder turns her (and, slowly, the vectored props in the
  // hover); the elevators and the ballonets climb and descend her. She rolls
  // hardly at all.
  _blimpControl(dt, ctl) {
    const T = this.T, w = this.w;
    const r = clamp(ctl.rudder + ctl.aileron, -1, 1), e = clamp(ctl.elevator, -1, 1);
    const sp = clamp(this.ias / 14, 0, 1);
    const yaw = r * T.rates.yaw * (0.3 + 0.7 * sp);
    const sf = this.surf, k = 1 - Math.exp(-dt / 0.3);
    sf.elevator += (e - sf.elevator) * k; sf.rudder += (r - sf.rudder) * k; sf.aileron = 0;
    const pitchT = e * 7 * DEG * (0.4 + 0.6 * sp);
    w.x += ((pitchT - this.pitch) * 0.6 - w.x) * (1 - Math.exp(-dt * 0.9));
    w.y += (-yaw - w.y) * (1 - Math.exp(-dt * 0.7));
    w.z += (this.bank * 0.8 - w.z) * (1 - Math.exp(-dt * 1.5));
    this.stall = 0;
  }
}

// Wind at a point: the weather's mean wind (stronger aloft), gusts from a
// first-order random process per axis, and in thunderstorms convective cells
// of rising and sinking air, microburst outflow near the ground, and the odd
// violent jolt.
export class Turbulence {
  constructor() {
    this.g = new THREE.Vector3();
    this.cells = [];
    this.level = 0;           // how rough it is now (0..1), for the camera and the HUD
    this.jolt = 0;
  }

  // st: Weather.state; storm 0..1; cloud: { base, top } of the cloud layer or null
  sample(x, y, z, out, dt, st, storm, agl, cloud) {
    const mean = (1.5 + st.wind * 17) * (0.55 + 0.45 * clamp(agl / 600, 0, 1)) * (1 + 0.35 * clamp((y - 600) / 3000, 0, 1));
    const wx = Math.sin(st.windDir) * mean, wz = -Math.cos(st.windDir) * mean;
    // How rough: a little everywhere, more in cloud, rain and wind, a lot in a storm.
    const inCloud = cloud && y > cloud.base && y < cloud.top ? Math.min(1, (y - cloud.base) / 150, (cloud.top - y) / 150) : 0;
    let sigma = 0.3 + st.wind * 1.4 + st.rain * 1.1 + st.snow * 0.5 + inCloud * (0.5 + st.rain * 1.5) + storm * (2.4 + inCloud * 3.6);
    sigma *= 0.55 + 0.45 * clamp(agl / 300, 0, 1);                       // (calmer right down at the ground)
    this.level = clamp((sigma - 0.45) / 6, 0, 1);
    this.inCloud = inCloud;
    const L = 160 + clamp(agl, 0, 1500) * 0.3, tau = L / 45, tv = tau * 0.6;
    const g = this.g;
    g.x += (-g.x * dt) / tau + sigma * Math.sqrt((2 * dt) / tau) * gauss();
    g.y += (-g.y * dt) / tv + sigma * 0.8 * Math.sqrt((2 * dt) / tv) * gauss();
    g.z += (-g.z * dt) / tau + sigma * Math.sqrt((2 * dt) / tau) * gauss();
    let up = 0, ox = 0, oz = 0;
    this.jolt = Math.max(0, this.jolt - dt * 3);
    if (storm > 0.05) {
      // Storm cells: big columns of rising and sinking air drifting with the wind.
      while (this.cells.length < 6) {
        const a = Math.random() * Math.PI * 2, d = 500 + Math.random() * 7000;
        this.cells.push({ x: x + Math.cos(a) * d, z: z + Math.sin(a) * d, r: 600 + Math.random() * 1400, w: (Math.random() < 0.55 ? 1 : -1) * (5 + Math.random() * 9), life: 120 + Math.random() * 240 });
      }
      const low = clamp(agl / 300, 0, 1);
      for (let i = this.cells.length - 1; i >= 0; i--) {
        const c = this.cells[i];
        c.x += wx * dt; c.z += wz * dt; c.life -= dt;
        const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz);
        if (c.life <= 0 || d > 12000) { this.cells.splice(i, 1); continue; }
        const f = Math.exp(-((d / c.r) ** 2));
        up += c.w * f * storm * low;
        // Near the ground a downdraft spreads out: a microburst's outflow.
        if (c.w < 0) { const o = -c.w * f * storm * (1 - low) * 1.4 * Math.min(1, d / c.r); ox += (dx / (d || 1)) * o; oz += (dz / (d || 1)) * o; }
      }
      // Now and then a sharp jolt.
      if (Math.random() < dt * storm * (0.06 + inCloud * 0.3)) { this.jolt = 1; g.y += (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 5) * storm; g.x += gauss() * 3 * storm; }
    } else this.cells.length = 0;
    out.set(wx + g.x + ox, g.y + up, wz + g.z + oz);
    return out;
  }
}

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
