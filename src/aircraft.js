// The aircraft you can fly: their specifications (dimensions, weights,
// engines, aerodynamics, handling) and their models: a fuselage of elliptical
// rings, tapered swept wings with flaps and ailerons that move, engines with
// spinning fans or propellers, a tail with elevators and a rudder, landing
// gear that retracts, cabin windows, a livery, and nav lights, beacons and
// strobes. The blimp has an envelope with BOODYEAR down each side and a sign
// that lights up at night.
//
// Model frame = body frame: nose toward -z, +x right, +y up, origin at the
// centre of gravity, which sits on the fuselage centreline; the ground under
// her at rest is at y = -cgH.

import * as THREE from 'three';
import { makeLightMaterial } from './airport.js';
import { globalUniforms } from './materials.js';

const DEG = Math.PI / 180;
const KT = 0.514444;

// Flap settings: lift added at a given angle of attack (cl), to the maximum
// lift (clmax), drag (cd) and the limit speed (vfe, m/s).
const flapsFrom = (rows) => rows.map(([name, cl, clmax, cd, vfe]) => ({ name, cl, clmax, cd, vfe: vfe ? vfe * KT : Infinity }));

// Speeds below are in m/s (written as knots * KT); masses in kg, thrust in N
// per engine, power in W per engine.
export const AIRCRAFT = {
  c172: {
    name: 'Cessna 172 Skyhawk', short: 'Cessna 172', cls: 'light', engine: 'piston', airline: null,
    desc: 'Four-seat trainer with a high wing. Lifts off at 55 kt, cruises at 120 kt and lands on almost anything.',
    len: 8.28, span: 11.0, height: 2.72, wingArea: 16.2, empty: 767, load: 1000, seats: 0, paxMass: 85,
    engines: 1, power: 134e3, thrust: 2650, idle: 0.07, spoolUp: 0.45, spoolDown: 0.35, reverser: false, spoilers: false,
    cl0: 0.32, cla: 4.6, clmax: 1.6, cd0: 0.031, e: 0.74, cyb: 0.9, mcrit: 0.6,
    flaps: flapsFrom([['UP', 0, 0, 0, 0], ['10°', 0.22, 0.22, 0.007, 110], ['20°', 0.42, 0.4, 0.02, 85], ['FULL', 0.55, 0.5, 0.042, 85]]),
    toFlap: 1, flapRate: 0.35, gearRetract: false, gearCd: 0, gearTime: 1,
    vr: 55 * KT, vref: 65 * KT, vclimb: 74 * KT, vcruise: 120 * KT, vmo: 163 * KT, mmo: 0.3, ceiling: 4100,
    rates: { roll: 1.1, pitch: 0.42, yaw: 0.4 }, k: { roll: 6, pitch: 6, yaw: 4 }, kAlpha: 3, nUp: 1.6, nDn: 1.0,
    steer: 0.55,
    fus: { zNose: 2.35, W: 1.12, H: 1.42, noseR: 0.5, tailUp: 0.42, prop: true, boxy: 0.35 },
    cgH: 1.1,
    wing: { pos: 'high', y: 0.76, zLE: -0.55, cr: 1.63, ct: 1.13, sweep: 0, dihedral: 1.7, thick: 0.13, struts: true, flapSpan: [0.06, 0.55], ailSpan: [0.58, 0.95] },
    eng: [{ kind: 'nose', x: 0, y: 0.12, z: -2.15, d: 1.93, blades: 2 }],
    hs: { y: 0.16, zLE: 4.6, cr: 1.15, ct: 0.75, semi: 1.7, sweep: 6, dihedral: 0 },
    vf: { zLE: 3.85, cr: 1.5, ct: 0.75, h: 1.55, sweep: 38, y0: 0.45 },
    gear: { nose: -1.38, mains: [1.27, 0.32], wheelR: 0.24, axles: 1, pants: true, squash: 0.1 },
    livery: { base: 0xf4f4f2, belly: 0xf4f4f2, stripe: 0xc8102e, stripe2: 0x1f3d6e, tail: 0xc8102e, engine: 0xf4f4f2 },
    cockpit: { x: -0.3, y: 0.38, z: -0.75 }, doorZ: -0.5, cam: 13,
  },
  c402: {
    name: 'Cessna 402C', short: 'Cessna 402', cls: 'commuter', engine: 'piston', airline: 'Vineyard Sound Air',
    desc: 'Twin-engine island hopper with nine seats, the classic Boston to the islands commuter. VR 90 kt, cruise 185 kt.',
    len: 11.09, span: 13.45, height: 3.49, wingArea: 20.98, empty: 1850, load: 2950, seats: 9, paxMass: 90,
    engines: 2, power: 242e3, thrust: 4200, idle: 0.07, spoolUp: 0.5, spoolDown: 0.4, reverser: false, spoilers: false,
    cl0: 0.27, cla: 4.9, clmax: 1.55, cd0: 0.028, e: 0.76, cyb: 0.9, mcrit: 0.6,
    flaps: flapsFrom([['UP', 0, 0, 0, 0], ['15°', 0.3, 0.3, 0.012, 150], ['FULL', 0.62, 0.6, 0.045, 130]]),
    toFlap: 1, flapRate: 0.3, gearRetract: true, gearCd: 0.014, gearTime: 5,
    vr: 90 * KT, vref: 95 * KT, vclimb: 110 * KT, vcruise: 185 * KT, vmo: 230 * KT, mmo: 0.45, ceiling: 7900,
    rates: { roll: 0.9, pitch: 0.32, yaw: 0.32 }, k: { roll: 5, pitch: 5, yaw: 3.5 }, kAlpha: 2.8, nUp: 1.4, nDn: 0.9,
    steer: 0.6,
    fus: { zNose: 4.4, W: 1.42, H: 1.55, noseR: 0.35, tailUp: 0.4, pointy: true },
    cgH: 1.3,
    wing: { pos: 'low', y: -0.55, zLE: -0.9, cr: 2.1, ct: 1.0, sweep: 2, dihedral: 5, thick: 0.15, tipTanks: true, flapSpan: [0.08, 0.5], ailSpan: [0.55, 0.92] },
    eng: [{ kind: 'prop', x: 2.25, y: -0.02, z: -2.2, d: 1.94, blades: 3, nacLen: 3.2, nacD: 0.75 }],
    hs: { y: 0.3, zLE: 5.15, cr: 1.35, ct: 0.85, semi: 2.65, sweep: 5, dihedral: 0 },
    vf: { zLE: 4.3, cr: 1.9, ct: 0.95, h: 1.9, sweep: 36, y0: 0.5 },
    gear: { nose: -3.05, mains: [1.95, 0.42], wheelR: 0.3, axles: 1, squash: 0.12 },
    livery: { base: 0xf6f6f4, belly: 0xd9dde2, stripe: 0x0b7a75, stripe2: 0x1f3d6e, tail: 0x0b7a75, engine: 0xf6f6f4 },
    cockpit: { x: -0.35, y: 0.42, z: -2.05 }, doorZ: 2.0, door: 'aft', cam: 17,
  },
  e175: {
    name: 'Embraer E175', short: 'E175', cls: 'regional', engine: 'jet', airline: 'Minuteman Regional',
    desc: '76-seat regional jet. VR about 130 kt, approach 125 kt. Short-field friendly.',
    len: 31.68, span: 28.65, height: 9.73, wingArea: 72.72, empty: 21890, load: 34500, seats: 76, paxMass: 95,
    engines: 2, thrust: 63000, idle: 0.2, spoolUp: 3.2, spoolDown: 2.4, reverser: true, spoilers: true,
    cl0: 0.25, cla: 5.0, clmax: 1.45, cd0: 0.02, e: 0.8, cyb: 1.0, mcrit: 0.76,
    flaps: flapsFrom([['UP', 0, 0, 0, 0], ['1', 0.25, 0.32, 0.006, 230], ['2', 0.42, 0.55, 0.013, 215], ['3', 0.56, 0.72, 0.021, 200], ['5', 0.74, 0.92, 0.033, 180], ['FULL', 0.9, 1.1, 0.052, 165]]),
    toFlap: 2, flapRate: 0.25, gearRetract: true, gearCd: 0.018, gearTime: 7,
    vr: 132 * KT, vref: 125 * KT, vclimb: 250 * KT, vcruise: 290 * KT, vmo: 320 * KT, mmo: 0.82, ceiling: 12500,
    rates: { roll: 0.5, pitch: 0.2, yaw: 0.16 }, k: { roll: 3.6, pitch: 3.5, yaw: 2.4 }, kAlpha: 2.2, nUp: 1.1, nDn: 0.8,
    steer: 1.1,
    fus: { zNose: 14.2, W: 3.0, H: 3.35, noseR: 0.25, tailUp: 0.5 },
    cgH: 2.75,
    wing: { pos: 'low', y: -1.15, zLE: -2.6, cr: 5.3, ct: 1.3, sweep: 26, dihedral: 5, thick: 0.11, winglet: 'blend', flapSpan: [0.1, 0.62], ailSpan: [0.66, 0.93] },
    eng: [{ kind: 'jet', x: 4.95, y: -1.38, z: -3.4, d: 1.62, l: 3.6 }],
    hs: { y: 0.9, zLE: 13.6, cr: 3.0, ct: 1.25, semi: 5.0, sweep: 30, dihedral: 6 },
    vf: { zLE: 11.4, cr: 4.6, ct: 2.1, h: 5.2, sweep: 40, y0: 1.3 },
    gear: { nose: -11.1, mains: [2.6, 1.25], wheelR: 0.55, axles: 1, squash: 0.13 },
    livery: { base: 0xf4f5f7, belly: 0xc9ced4, stripe: 0xc8102e, stripe2: 0x1f3d6e, tail: 0x1f3d6e, engine: 0xc8102e },
    cockpit: { x: -0.55, y: 0.75, z: -12.0 }, doorZ: -10.6, cam: 44,
  },
  a320: {
    name: 'Airbus A320neo', short: 'A320', cls: 'narrowbody', engine: 'jet', airline: 'Hub Airways',
    desc: 'The 180-seat workhorse. VR 140 kt, approach 133 kt. Fly-by-wire keeps her out of the stall.',
    len: 37.57, span: 35.8, height: 11.76, wingArea: 122.6, empty: 44300, load: 66000, seats: 180, paxMass: 95,
    engines: 2, thrust: 120000, idle: 0.2, spoolUp: 3.5, spoolDown: 2.6, reverser: true, spoilers: true,
    cl0: 0.25, cla: 5.2, clmax: 1.45, cd0: 0.019, e: 0.82, cyb: 1.0, mcrit: 0.77,
    flaps: flapsFrom([['UP', 0, 0, 0, 0], ['1', 0.22, 0.4, 0.005, 230], ['1+F', 0.45, 0.75, 0.012, 215], ['2', 0.6, 0.92, 0.02, 200], ['3', 0.73, 1.05, 0.03, 185], ['FULL', 0.9, 1.2, 0.05, 177]]),
    toFlap: 2, flapRate: 0.22, gearRetract: true, gearCd: 0.02, gearTime: 8,
    vr: 140 * KT, vref: 133 * KT, vclimb: 250 * KT, vcruise: 300 * KT, vmo: 350 * KT, mmo: 0.82, ceiling: 12100,
    rates: { roll: 0.28, pitch: 0.14, yaw: 0.12 }, k: { roll: 3.2, pitch: 3.2, yaw: 2.2 }, kAlpha: 2, nUp: 1.0, nDn: 0.8,
    steer: 1.2,
    fus: { zNose: 16.9, W: 3.95, H: 4.14, noseR: 0.22, tailUp: 0.52 },
    cgH: 3.25,
    wing: { pos: 'low', y: -1.45, zLE: -3.1, cr: 6.1, ct: 1.5, sweep: 27, dihedral: 5.1, thick: 0.11, winglet: 'sharklet', flapSpan: [0.1, 0.66], ailSpan: [0.69, 0.93] },
    eng: [{ kind: 'jet', x: 5.75, y: -1.55, z: -4.6, d: 2.36, l: 4.5 }],
    hs: { y: 1.0, zLE: 15.7, cr: 3.8, ct: 1.55, semi: 6.2, sweep: 30, dihedral: 6 },
    vf: { zLE: 13.3, cr: 5.6, ct: 2.4, h: 6.3, sweep: 34, y0: 1.6 },
    gear: { nose: -12.7, mains: [3.8, 0.95], wheelR: 0.6, axles: 1, squash: 0.14 },
    livery: { base: 0xf4f5f7, belly: 0xbfc6ce, stripe: 0x1d3d8f, stripe2: 0xc9a227, tail: 0x1d3d8f, engine: 0xc9a227 },
    cockpit: { x: -0.6, y: 0.85, z: -14.7 }, doorZ: -13.6, cam: 52,
  },
  b789: {
    name: 'Boeing 787-9 Dreamliner', short: '787-9', cls: 'widebody', engine: 'jet', airline: 'Beacon Air',
    desc: '296-seat long-haul twin with flexing wings. VR about 155 kt, approach 145 kt.',
    len: 62.81, span: 60.12, height: 17.02, wingArea: 377, empty: 128850, load: 200000, seats: 296, paxMass: 100,
    engines: 2, thrust: 320000, idle: 0.2, spoolUp: 4.2, spoolDown: 3, reverser: true, spoilers: true,
    cl0: 0.24, cla: 5.0, clmax: 1.45, cd0: 0.018, e: 0.83, cyb: 1.0, mcrit: 0.8,
    flaps: flapsFrom([['UP', 0, 0, 0, 0], ['1', 0.2, 0.38, 0.005, 255], ['5', 0.38, 0.6, 0.01, 235], ['15', 0.52, 0.78, 0.018, 215], ['20', 0.62, 0.9, 0.024, 205], ['25', 0.76, 1.03, 0.034, 185], ['30', 0.88, 1.15, 0.046, 180]]),
    toFlap: 2, flapRate: 0.2, gearRetract: true, gearCd: 0.018, gearTime: 9,
    vr: 155 * KT, vref: 145 * KT, vclimb: 250 * KT, vcruise: 310 * KT, vmo: 340 * KT, mmo: 0.9, ceiling: 13100,
    rates: { roll: 0.2, pitch: 0.1, yaw: 0.09 }, k: { roll: 2.6, pitch: 2.6, yaw: 1.8 }, kAlpha: 1.8, nUp: 0.9, nDn: 0.7,
    steer: 1.2,
    fus: { zNose: 28.6, W: 5.77, H: 5.97, noseR: 0.25, tailUp: 0.5 },
    cgH: 4.5,
    wing: { pos: 'low', y: -2.2, zLE: -5.5, cr: 10.2, ct: 1.9, sweep: 32, dihedral: 6.5, flex: 1.8, thick: 0.1, winglet: 'raked', flapSpan: [0.1, 0.65], ailSpan: [0.68, 0.9] },
    eng: [{ kind: 'jet', x: 9.75, y: -1.95, z: -8.0, d: 3.55, l: 6.8, chevrons: true }],
    hs: { y: 1.2, zLE: 26.0, cr: 6.4, ct: 2.3, semi: 10.4, sweep: 36, dihedral: 7 },
    vf: { zLE: 23.0, cr: 8.6, ct: 3.5, h: 10.0, sweep: 40, y0: 2.4 },
    gear: { nose: -22.6, mains: [4.9, 3.1], wheelR: 0.66, axles: 2, squash: 0.16 },
    livery: { base: 0xf4f5f7, belly: 0xc4ccd4, stripe: 0x0b7a75, stripe2: 0x2a9fd6, tail: 0x0b7a75, engine: 0xf4f5f7 },
    cockpit: { x: -0.65, y: 1.25, z: -25.9 }, doorZ: -23.2, cam: 82,
  },
  a388: {
    name: 'Airbus A380-800', short: 'A380', cls: 'super', engine: 'jet', airline: 'Commonwealth Atlantic',
    desc: 'The double-decker: 525 seats, four engines, 80 m of wing. VR about 150 kt, approach 140 kt. Needs a long runway.',
    len: 72.72, span: 79.75, height: 24.09, wingArea: 845, empty: 277000, load: 420000, seats: 525, paxMass: 100,
    engines: 4, thrust: 310000, idle: 0.2, spoolUp: 4.6, spoolDown: 3.2, reverser: true, spoilers: true,
    cl0: 0.22, cla: 4.7, clmax: 1.4, cd0: 0.02, e: 0.82, cyb: 1.0, mcrit: 0.8,
    flaps: flapsFrom([['UP', 0, 0, 0, 0], ['1', 0.22, 0.4, 0.006, 263], ['1+F', 0.42, 0.72, 0.012, 222], ['2', 0.6, 0.9, 0.021, 220], ['3', 0.74, 1.05, 0.031, 196], ['FULL', 0.9, 1.2, 0.05, 182]]),
    toFlap: 2, flapRate: 0.18, gearRetract: true, gearCd: 0.022, gearTime: 10,
    vr: 150 * KT, vref: 140 * KT, vclimb: 250 * KT, vcruise: 300 * KT, vmo: 340 * KT, mmo: 0.89, ceiling: 13100,
    rates: { roll: 0.17, pitch: 0.08, yaw: 0.07 }, k: { roll: 2.2, pitch: 2.2, yaw: 1.6 }, kAlpha: 1.6, nUp: 0.8, nDn: 0.7,
    steer: 1.1,
    fus: { zNose: 32.6, W: 7.14, H: 8.41, noseR: 0.3, tailUp: 0.46, decks: 2 },
    cgH: 6.2,
    wing: { pos: 'low', y: -3.1, zLE: -8.6, cr: 17.6, ct: 3.6, sweep: 33.5, dihedral: 5.6, flex: 1.0, thick: 0.1, winglet: 'fence', flapSpan: [0.1, 0.6], ailSpan: [0.65, 0.93] },
    eng: [{ kind: 'jet', x: 15.4, y: -2.6, z: -12.2, d: 3.3, l: 6.4 }, { kind: 'jet', x: 25.9, y: -1.75, z: -6.0, d: 3.3, l: 6.4 }],
    hs: { y: 1.8, zLE: 30.4, cr: 9.6, ct: 3.6, semi: 15.3, sweep: 34, dihedral: 6 },
    vf: { zLE: 26.0, cr: 13.5, ct: 4.6, h: 14.0, sweep: 40, y0: 3.4 },
    gear: { nose: -26.4, mains: [6.2, 4.2], wheelR: 0.7, axles: 2, body: [2.6, 6.8], squash: 0.18 },
    livery: { base: 0xf4f5f7, belly: 0xc6cbd2, stripe: 0x7a1c1c, stripe2: 0xc9a227, tail: 0x7a1c1c, engine: 0xc9a227 },
    cockpit: { x: -0.7, y: 0.9, z: -29.4 }, doorZ: -26.8, cam: 100,
  },
  blimp: {
    name: 'Boodyear Glimp', short: 'Glimp', cls: 'blimp', engine: 'blimp', airline: null,
    desc: 'The Boodyear Glimp: 60 m of airship, 35 mph in the cruise and nearly 60 flat out. Drifts with the wind, sees the whole game from overhead.',
    len: 60, span: 15, height: 17, wingArea: 420, empty: 6800, load: 11000, seats: 6, paxMass: 85,
    engines: 2, thrust: 3600, idle: 0, spoolUp: 1.2, spoolDown: 1.2, reverser: false, spoilers: false,
    cl0: 0, cla: 0.9, clmax: 0.5, cd0: 0.028, e: 0.5, cyb: 0.5, heavy: 0.006,
    flaps: flapsFrom([['-', 0, 0, 0, 0]]), toFlap: 0, flapRate: 1, gearRetract: false, gearCd: 0, gearTime: 1,
    vr: 6, vref: 4, vclimb: 10, vcruise: 18, vmo: 26, mmo: 0.2, ceiling: 3000,
    rates: { roll: 0, pitch: 0.08, yaw: 0.14 }, k: { roll: 1, pitch: 1, yaw: 1 }, kAlpha: 1, nUp: 1, nDn: 1,
    steer: 0.3,
    fus: { zNose: 30, W: 15, H: 15 },
    cgH: 10.3,
    gear: { nose: -1.5, mains: [0.9, 1.8], wheelR: 0.35, axles: 1, squash: 0.25 },
    livery: { base: 0xd8dde3, belly: 0xc2c8cf, stripe: 0x1d3d8f, stripe2: 0xf2c12e, tail: 0x1d3d8f, engine: 0x9aa1a8 },
    cockpit: { x: -0.4, y: -8.2, z: -2.4 }, cam: 85,
  },
};
export const AIRCRAFT_ORDER = ['c172', 'c402', 'e175', 'a320', 'b789', 'a388'];

// The fuselage as elliptical rings from nose to tail: { z, rx, ry, y (centre) }.
// (Shared by the model and the physics, so the tail strikes where it looks.)
export function fuselageRings(T, NR = 34) {
  const F = T.fus, W = F.W, H = F.H, zN = -F.zNose, zT = T.len - F.zNose;
  const tailUp = (F.tailUp || 0.4) * H;
  const noseL = Math.min(T.len * 0.13, F.pointy ? 3.2 : Math.max(1.2, H * 1.05)), tailL = T.len * (T.cls === 'light' ? 0.5 : T.cls === 'commuter' ? 0.34 : 0.37);
  const rings = [];
  for (let i = 0; i <= NR; i++) {
    const t = i / NR, z = zN + t * T.len;
    let sx = 1, sy = 1, y = 0;
    if (z < zN + noseL) {
      const u = (z - zN) / noseL;                                     // 0 at the tip
      const k = F.pointy ? Math.pow(u, 0.75) : Math.sqrt(Math.max(0, 1 - (1 - u) ** 2));
      sx = Math.max(0.04, k); sy = Math.max(0.04, k * (F.pointy ? 0.8 : 1));
      y = -(1 - k) * H * (F.pointy ? 0.12 : 0.18);                   // (the nose sits a little low)
    } else if (z > zT - tailL) {
      const u = (z - (zT - tailL)) / tailL;                           // 0 where the taper starts
      sx = 1 - 0.86 * Math.pow(u, 1.25); sy = 1 - 0.78 * Math.pow(u, 1.1);
      y = tailUp * Math.pow(u, 1.6) * 0.9;
    }
    if (F.boxy && z > zN + noseL) sy *= 1 + F.boxy * 0.1;
    rings.push({ z, rx: Math.max(0.03, (W / 2) * sx), ry: Math.max(0.03, (H / 2) * sy), y });
  }
  return { rings, noseL, tailL, zN, zT, tailUp };
}

// Derived geometry the physics needs: the tail-strike angle and the parts
// that must not touch the ground (with a radius for buildings).
for (const [id, T] of Object.entries(AIRCRAFT)) {
  T.id = id;
  const F = T.fus, H = F.H, L = T.len, zT = L - F.zNose, yG = -T.cgH;
  if (T.engine === 'blimp') {
    T.parts = [['nosecone', 0, 0, -F.zNose, 2], ['tail', 0, -H * 0.3, zT - 4, 2], ['belly', 0, -H / 2, 0, 3], ['top', 0, H / 2, 0, 3],
      ['finL', -H * 0.62, 0, zT - 6, 1], ['finR', H * 0.62, 0, zT - 6, 1], ['gondola', 0, -T.cgH + 0.6, 0, 1.5]];
    T.tailStrike = 0.5;
    continue;
  }
  const w = T.wing, tipZ = w.zLE + Math.tan(w.sweep * DEG) * (T.span / 2) + w.ct * 0.5;
  const tipY = w.y + Math.tan(w.dihedral * DEG) * (T.span / 2) + (w.flex || 0);
  // The tail point: the bit of the fuselage's underside that touches first as she rotates on her mains.
  const fr = fuselageRings(T), zm = T.gear.mains[1];
  let tailZ = zT * 0.62, tailY = -H / 2, best = Infinity;
  for (const r of fr.rings) {
    if (r.z <= zm + 1) continue;
    const by = r.y - r.ry, a = Math.atan2(by - yG, r.z - zm);
    if (a < best) { best = a; tailZ = r.z; tailY = by; }
  }
  const last = fr.rings[fr.rings.length - 1];
  T.parts = [
    ['nosecone', 0, -H * 0.15, -F.zNose + 0.4, 0.6], ['tail', 0, tailY, tailZ, 0.5], ['tailcone', 0, last.y - last.ry, zT - 0.3, 0.5],
    ['belly', 0, -H / 2, 0, Math.max(0.6, F.W * 0.35)], ['wingL', -T.span / 2, tipY, tipZ, 0.5], ['wingR', T.span / 2, tipY, tipZ, 0.5],
    ['fin', 0, T.height - T.cgH - 0.2, T.vf.zLE + T.vf.cr * 0.6 + Math.tan(T.vf.sweep * DEG) * T.vf.h, 0.6],
  ];
  for (const e of T.eng) {
    if (e.kind === 'jet') for (const s of [-1, 1]) T.parts.push(['engine', s * e.x, e.y - e.d / 2, e.z, e.d * 0.35]);
    if (e.kind === 'nose') T.parts.push(['prop', 0, e.y - e.d / 2 + 0.05, e.z, 0.3]);
  }
  // Pitch at which the tail touches with the mains on the ground (legs squashed).
  T.tailStrike = Math.atan2(tailY - yG, tailZ - T.gear.mains[1]);
}

// ============================================================== helpers
function colorAll(g, hex) {
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[3 * i] = c.r; a[3 * i + 1] = c.g; a[3 * i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function merge(parts) {
  const geos = parts.filter(Boolean).map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of geos) { if (!g.attributes.normal) g.computeVertexNormals(); if (!g.attributes.color) colorAll(g, 0xffffff); }
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3); nrm.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

const box = (w, h, d, x, y, z, hex) => colorAll(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);
// Cylinder along z.
const cylZ = (r0, r1, len, x, y, z, hex, seg = 16, open = false) => colorAll(new THREE.CylinderGeometry(r1, r0, len, seg, 1, open).rotateX(Math.PI / 2).translate(x, y, z), hex);
// Cylinder along x (wheels, axles).
const cylX = (r, len, x, y, z, hex, seg = 14) => colorAll(new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2).translate(x, y, z), hex);

// A beam between two points.
function strut(a, b, r, hex, seg = 6) {
  const d = new THREE.Vector3().subVectors(b, a), L = d.length();
  const g = new THREE.CylinderGeometry(r, r, L, seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return colorAll(g, hex);
}

// A tube of rings: rings = [{ z, rx, ry, y }] tail to nose or nose to tail,
// coloured per vertex by colorAt(angle (0 = top, + toward the right), z).
function tube(rings, seg, colorAt) {
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  rings.forEach((r) => {
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const x = Math.sin(a) * r.rx, y = Math.cos(a) * r.ry + (r.y || 0);
      pos.push(x, y, r.z);
      c.setHex(colorAt(a, r.z, y - (r.y || 0), r));
      col.push(c.r, c.g, c.b);
    }
  });
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let k = 0; k < seg; k++) {
      const a = i * (seg + 1) + k, b = a + 1, d = a + seg + 1, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// A tapered lifting surface from sections: each section is { x, y, z (LE), c (chord), t (thickness) };
// for a wing x runs out along the span; for a fin, vertical = true and y runs up.
function surface(sections, hex, vertical = false) {
  const pos = [], idx = [];
  // Airfoil-ish outline: LE, upper 30%, upper TE, lower TE, lower 30%.
  const prof = [[0, 0], [0.3, 1], [1, 0.12], [1, -0.12], [0.3, -0.6]];
  sections.forEach((s) => {
    for (const [u, v] of prof) {
      const th = s.c * s.t * 0.5 * v;
      if (vertical) pos.push(s.x + th, s.y, s.z + u * s.c);
      else pos.push(s.x, s.y + th, s.z + u * s.c);
    }
  });
  const P = prof.length;
  for (let i = 0; i + 1 < sections.length; i++) {
    for (let k = 0; k < P; k++) {
      const a = i * P + k, b = i * P + ((k + 1) % P), c = (i + 1) * P + k, d = (i + 1) * P + ((k + 1) % P);
      idx.push(a, b, d, a, d, c);
    }
  }
  // Caps at both ends.
  for (const i of [0, sections.length - 1]) for (let k = 1; k + 1 < P; k++) idx.push(i * P, i * P + k, i * P + k + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  return colorAll(ng, hex);
}

// A flat panel (flap, aileron, elevator, rudder) built in its hinge frame:
// hinge along +x from 0 to len, chord back along +z, at a slight thickness.
function panel(len, c0, c1, t, hex, vertical = false) {
  const g = vertical ? new THREE.BoxGeometry(t, len, 1) : new THREE.BoxGeometry(len, t, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const along = vertical ? (p.getY(i) + len / 2) / len : (p.getX(i) + len / 2) / len;
    const zc = (p.getZ(i) + 0.5) * (c0 + (c1 - c0) * along);
    p.setZ(i, zc);
    if (vertical) p.setY(i, p.getY(i) + len / 2); else p.setX(i, p.getX(i) + len / 2);
  }
  g.computeVertexNormals();
  return colorAll(g, hex);
}

// ================================================================ models
const mats = {};
function materials() {
  if (mats.body) return mats;
  mats.body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.2, envMapIntensity: 1.1, side: THREE.DoubleSide });
  mats.metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.65, side: THREE.DoubleSide });
  mats.glass = new THREE.MeshStandardMaterial({ color: 0x111820, roughness: 0.08, metalness: 0.7, emissive: 0xffe2b0, emissiveIntensity: 0, side: THREE.DoubleSide });
  mats.cockpit = new THREE.MeshStandardMaterial({ color: 0x0b1118, roughness: 0.05, metalness: 0.8, side: THREE.DoubleSide });
  mats.tyre = new THREE.MeshStandardMaterial({ color: 0x141518, roughness: 0.9 });
  mats.blur = new THREE.MeshBasicMaterial({ color: 0x20242a, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
  mats.fan = new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.4, metalness: 0.8, side: THREE.DoubleSide });
  return mats;
}

export function setAircraftNight(night) { materials().glass.emissiveIntensity = night > 0.3 ? 1.1 * night : 0; }

// Hinged parts: a group at the hinge, turned so its x runs along the hinge line.
function hinge(parent, origin, dir, mesh) {
  const g = new THREE.Group();
  g.position.copy(origin);
  const d = dir.clone().normalize();
  g.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d);
  g.add(mesh);
  parent.add(g);
  return g;
}

export function buildAircraft(type) {
  const T = AIRCRAFT[type];
  if (T.engine === 'blimp') return buildBlimp(T);
  const M = materials(), L = T.livery, F = T.fus;
  const root = new THREE.Group();
  root.name = 'aircraft-' + type;
  const body = [], fus = [], glass = [], metal = [], cockpitGlass = [];
  const W = F.W, H = F.H, zN = -F.zNose, zT = T.len - F.zNose;
  const tailUp = (F.tailUp || 0.4) * H;
  // ---- fuselage: elliptical rings, a rounded (or pointed) nose, an upswept tail cone.
  const { rings, noseL, tailL } = fuselageRings(T);
  const ringAt = (z) => { let best = rings[0]; for (const r of rings) if (Math.abs(r.z - z) < Math.abs(best.z - z)) best = r; return best; };
  const windowY = H * (F.decks === 2 ? -0.1 : 0.12);
  fus.push(tube(rings, 28, (a, z, y) => {
    const below = y < -H * 0.28;
    if (z > zT - tailL * 0.55 && y > 0) return L.tail;                    // the tail end in livery colours
    if (Math.abs(y - (windowY - H * 0.13)) < H * 0.035 && z > zN + noseL * 0.6 && z < zT - tailL * 0.5) return L.stripe;
    if (Math.abs(y - (windowY - H * 0.19)) < H * 0.02 && z > zN + noseL * 0.6 && z < zT - tailL * 0.5) return L.stripe2;
    return below ? L.belly : L.base;
  }));
  // Cockpit windows: a dark band round the nose.
  {
    const zc = zN + noseL * (F.pointy ? 0.95 : 0.78), r = ringAt(zc);
    const wz = noseL * (F.pointy ? 0.35 : 0.3);
    const g = new THREE.CylinderGeometry(1, 1, wz, 20, 1, true, -1.25, 2.5);
    g.rotateX(Math.PI / 2);
    g.scale(r.rx * 1.015, r.ry * 1.015, 1);
    g.translate(0, r.y + r.ry * 0.0, zc);
    // Keep only the upper part (the windscreen).
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) if (p.getY(i) < r.y + r.ry * 0.25) p.setY(i, r.y + r.ry * 0.25 + (p.getY(i) - r.y - r.ry * 0.25) * 0.15);
    g.computeVertexNormals();
    cockpitGlass.push(g);
  }
  // Cabin windows: a row down each side (two for the double-decker).
  if (T.seats > 0) {
    const pitch = T.cls === 'commuter' ? 0.95 : T.cls === 'regional' ? 0.8 : 0.53;
    const decks = F.decks === 2 ? [windowY + H * 0.22, windowY - H * 0.15] : [windowY];
    const wz0 = zN + noseL * 1.25, wz1 = zT - tailL * 0.75;
    const ww = T.cls === 'commuter' ? 0.42 : 0.26, wh = T.cls === 'commuter' ? 0.32 : 0.36;
    for (const wy of decks) {
      for (let z = wz0; z < wz1; z += pitch) {
        if (Math.abs(z - T.doorZ) < 1.2) continue;
        const r = ringAt(z);
        const yy = wy + r.y;
        const xr = r.rx * Math.sqrt(Math.max(0, 1 - ((yy - r.y) / r.ry) ** 2)) + 0.015;
        for (const s of [-1, 1]) glass.push(box(0.03, wh, ww, s * xr, yy, z, 0xffffff));
      }
    }
    // Doors: outlines on the left side.
    for (const dz of [T.doorZ, T.cls !== 'commuter' ? zT - tailL * 0.95 : null]) {
      if (dz === null) continue;
      const r = ringAt(dz);
      const xr = r.rx + 0.02;
      for (const [dx, dy, w, h] of [[0, 0.95, 0.06, 0.06], [0, -0.95, 0.06, 0.06]]) glass.push(box(0.02, h, 1.0, -xr, windowY + r.y + dy * 0.9, dz, 0xffffff), box(0.02, 1.85, w, -xr, windowY + r.y, dz + (dy > 0 ? 0.5 : -0.5), 0xffffff));
    }
  }
  // ---- wings
  const w = T.wing, semi = T.span / 2;
  const sw = Math.tan(w.sweep * DEG), dh = Math.tan(w.dihedral * DEG);
  const rootX = w.pos === 'high' ? W * 0.3 : W * 0.42;
  const wingAt = (f) => {           // f: 0 at the root, 1 at the tip
    const x = rootX + (semi - rootX) * f;
    const flex = (w.flex || 0) * f * f;
    return { x, y: w.y + (x - rootX) * dh + flex, z: w.zLE + (x - rootX) * sw, c: w.cr + (w.ct - w.cr) * f };
  };
  const pivots = { flaps: [], ailerons: [], elevators: [], rudder: null, props: [], fans: [], gear: [] };
  for (const s of [-1, 1]) {
    const secs = [];
    for (const f of [0, 0.25, 0.5, 0.75, 1]) { const p = wingAt(f); secs.push({ x: s * p.x, y: p.y, z: p.z, c: p.c, t: w.thick * (1.25 - 0.45 * f) }); }
    // The inboard trailing edge (flaps) and outboard (ailerons) are separate panels.
    body.push(surface(secs.map((q) => ({ ...q, c: q.c * 0.78 })), 0xd8dce1));
    // Wing root fairing (belly) for low wings.
    if (w.pos === 'low' && s > 0) fus.push(box(W * 0.7, H * 0.18, w.cr * 1.15, 0, w.y - H * 0.02, w.zLE + w.cr * 0.5, L.belly));
    for (const [kind, span] of [['flaps', w.flapSpan], ['ailerons', w.ailSpan]]) {
      const a = wingAt(span[0]), b = wingAt(span[1]);
      const ha = new THREE.Vector3(s * a.x, a.y, a.z + a.c * 0.78), hb = new THREE.Vector3(s * b.x, b.y, b.z + b.c * 0.78);
      const len = ha.distanceTo(hb);
      const dir = s > 0 ? new THREE.Vector3().subVectors(hb, ha) : new THREE.Vector3().subVectors(ha, hb);
      const origin = s > 0 ? ha : hb;
      const c0 = (s > 0 ? a.c : b.c) * 0.22, c1 = (s > 0 ? b.c : a.c) * 0.22;
      const m = new THREE.Mesh(panel(len, c0, c1, Math.max(0.04, a.c * w.thick * 0.2), kind === 'flaps' ? 0xc8cdd3 : 0xd8dce1), M.body);
      // The panel's chord runs along the hinge frame's +z; undo the sweep so it points straight back.
      const g = hinge(root, origin, dir, m);
      g.userData.side = s;
      pivots[kind].push(g);
      castAll(m);
    }
    // Winglets and tips.
    const tip = wingAt(1);
    if (w.winglet === 'blend' || w.winglet === 'sharklet') {
      const hgt = w.winglet === 'sharklet' ? T.span * 0.068 : T.span * 0.06;
      body.push(surface([{ x: s * tip.x, y: tip.y, z: tip.z, c: tip.c, t: 0.08 }, { x: s * (tip.x + hgt * 0.15), y: tip.y + hgt, z: tip.z + tip.c * 0.55, c: tip.c * 0.42, t: 0.06 }], L.tail, true));
    } else if (w.winglet === 'fence') {
      body.push(surface([{ x: s * tip.x, y: tip.y - 1.1, z: tip.z + 0.3, c: tip.c * 0.8, t: 0.06 }, { x: s * tip.x, y: tip.y + 1.6, z: tip.z + 0.8, c: tip.c * 0.55, t: 0.06 }], L.tail, true));
    } else if (w.winglet === 'raked') {
      const r0 = wingAt(0.92);
      body.push(surface([{ x: s * r0.x, y: r0.y, z: r0.z, c: r0.c * 0.78, t: 0.07 }, { x: s * (tip.x + 1.2), y: tip.y + 0.25, z: tip.z + tip.c * 0.9, c: tip.c * 0.4, t: 0.05 }]));
    }
    if (w.tipTanks) body.push(cylZ(0.22, 0.22, 2.6, s * (tip.x + 0.1), tip.y, tip.z + 0.4, L.stripe, 12), colorAll(new THREE.SphereGeometry(0.22, 10, 6).translate(s * (tip.x + 0.1), tip.y, tip.z - 0.9), L.stripe));
    // Struts for the high wing.
    if (w.struts) {
      const p = wingAt(0.48);
      metal.push(strut(new THREE.Vector3(s * W * 0.45, -H * 0.38, w.zLE + 0.4), new THREE.Vector3(s * p.x, p.y - 0.05, p.z + p.c * 0.25), 0.05, 0xe6e8ea));
    }
  }
  // ---- engines
  for (const e of T.eng) {
    for (const s of e.kind === 'nose' ? [0] : [-1, 1]) {
      const x = s * e.x;
      if (e.kind === 'jet') {
        const r = e.d / 2, Lc = e.l;
        // Nacelle: a lipped intake, the fan cowl and a tapering core.
        const prof = [[r * 0.9, -Lc / 2], [r, -Lc / 2 + 0.15], [r * 1.02, -Lc * 0.15], [r * 0.92, Lc * 0.25], [r * 0.62, Lc * 0.42], [r * 0.42, Lc * 0.55]];
        const pts = prof.map(([rr, zz]) => new THREE.Vector2(rr, zz));
        const lathe = new THREE.LatheGeometry(pts, 22).rotateX(Math.PI / 2).translate(x, e.y, e.z);
        body.push(colorAll(lathe, L.engine));
        if (e.chevrons) body.push(cylZ(r * 0.62, r * 0.58, 0.4, x, e.y, e.z + Lc * 0.44, 0x9aa1a8, 22, true));
        // Pylon up to the wing.
        const f = (e.x - rootX) / (semi - rootX), wp = wingAt(Math.max(0, f));
        body.push(box(0.35, Math.max(0.3, wp.y - e.y - r * 0.4), Lc * 0.75, x, (wp.y + e.y + r * 0.4) / 2, e.z + Lc * 0.15, 0xd0d4d9));
        // The fan: dark disc with a spinner, turning.
        const fan = new THREE.Group();
        fan.position.set(x, e.y, e.z - Lc / 2 + 0.35);
        const disc = new THREE.Mesh(new THREE.CircleGeometry(r * 0.88, 24), M.fan);
        fan.add(disc);
        for (let k = 0; k < 6; k++) {
          const bl = new THREE.Mesh(new THREE.BoxGeometry(r * 0.08, r * 0.82, 0.04).translate(0, r * 0.45, -0.03), M.fan);
          bl.rotation.z = (k / 6) * Math.PI * 2;
          bl.rotation.y = 0.5;
          fan.add(bl);
        }
        const spin = new THREE.Mesh(new THREE.ConeGeometry(r * 0.26, r * 0.5, 14).rotateX(-Math.PI / 2).translate(0, 0, -r * 0.2), new THREE.MeshStandardMaterial({ color: 0xc9cdd2, metalness: 0.7, roughness: 0.3 }));
        fan.add(spin);
        root.add(fan);
        pivots.fans.push(fan);
      } else {
        // Propeller: nacelle (or the nose), spinner and blades, plus a blur disc at speed.
        const d = e.d;
        if (e.kind === 'prop') {
          const nl = e.nacLen, nr = e.nacD / 2;
          const prof = [[nr * 0.5, -nl / 2], [nr, -nl / 2 + 0.35], [nr, nl * 0.2], [nr * 0.45, nl / 2]];
          body.push(colorAll(new THREE.LatheGeometry(prof.map(([rr, zz]) => new THREE.Vector2(rr, zz)), 16).rotateX(Math.PI / 2).translate(x, e.y, e.z + nl / 2 - 0.1), L.engine));
        }
        const prop = new THREE.Group();
        prop.position.set(x, e.y, e.z - (e.kind === 'nose' ? 0.05 : 0.15));
        const spinner = new THREE.Mesh(new THREE.ConeGeometry(e.kind === 'nose' ? 0.2 : 0.17, 0.42, 14).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: e.kind === 'nose' ? 0xf4f4f2 : 0xd0d4d8, metalness: 0.4, roughness: 0.35 }));
        prop.add(spinner);
        const blades = new THREE.Group();
        for (let k = 0; k < e.blades; k++) {
          const b = new THREE.Mesh(colorAll(new THREE.BoxGeometry(0.11, d / 2 - 0.12, 0.03).translate(0, d / 4 + 0.08, 0.05), 0x1a1c1f), M.metal);
          b.rotation.z = (k / e.blades) * Math.PI * 2;
          b.rotation.y = 0.35;
          blades.add(b);
        }
        prop.add(blades);
        const blur = new THREE.Mesh(new THREE.CircleGeometry(d / 2, 28), M.blur);
        blur.position.z = 0.05;
        blur.renderOrder = 6;
        prop.add(blur);
        prop.userData = { blades, blur, dir: s >= 0 ? 1 : -1 };
        root.add(prop);
        pivots.props.push(prop);
      }
    }
  }
  // ---- tail: horizontal stabiliser with elevators, fin with the rudder
  const hs = T.hs, hsw = Math.tan(hs.sweep * DEG), hdh = Math.tan(hs.dihedral * DEG);
  for (const s of [-1, 1]) {
    const secs = [0, 1].map((f) => { const x = W * 0.12 + (hs.semi - W * 0.12) * f; return { x: s * x, y: hs.y + x * hdh, z: hs.zLE + x * hsw, c: (hs.cr + (hs.ct - hs.cr) * f) * 0.72, t: 0.1 }; });
    body.push(surface(secs, 0xe2e5e9));
    const a = secs[0], b = secs[1];
    const ha = new THREE.Vector3(a.x, a.y, a.z + a.c), hb = new THREE.Vector3(b.x, b.y, b.z + b.c);
    const len = ha.distanceTo(hb);
    const origin = s > 0 ? ha : hb, dir = s > 0 ? hb.clone().sub(ha) : ha.clone().sub(hb);
    const m = new THREE.Mesh(panel(len, (s > 0 ? a.c : b.c) * 0.4, (s > 0 ? b.c : a.c) * 0.4, 0.05, 0xd6dade), M.body);
    castAll(m);
    pivots.elevators.push(hinge(root, origin, dir, m));
  }
  {
    const vf = T.vf, vsw = Math.tan(vf.sweep * DEG);
    const secs = [0, 1].map((f) => ({ x: 0, y: vf.y0 + vf.h * f, z: vf.zLE + vf.h * f * vsw, c: (vf.cr + (vf.ct - vf.cr) * f) * 0.7, t: 0.11 }));
    body.push(surface(secs, L.tail, true));
    const a = secs[0], b = secs[1];
    const ha = new THREE.Vector3(0, a.y, a.z + a.c), hb = new THREE.Vector3(0, b.y, b.z + b.c);
    const m = new THREE.Mesh(panel(ha.distanceTo(hb), a.c * 0.43, b.c * 0.43, 0.06, L.tail, false), M.body);
    castAll(m);
    pivots.rudder = hinge(root, ha, hb.clone().sub(ha), m);
    pivots.rudder.userData.vertical = true;
    // Dorsal fillet.
    body.push(surface([{ x: 0, y: vf.y0 - H * 0.12, z: vf.zLE - vf.cr * 0.4, c: vf.cr * 0.5, t: 0.08 }, { x: 0, y: vf.y0 + vf.h * 0.12, z: vf.zLE + vf.h * 0.12 * vsw - vf.cr * 0.05, c: vf.cr * 0.15, t: 0.05 }], L.tail, true));
  }
  // ---- landing gear (legs that swing up when it retracts)
  const gr = T.gear, yG = -T.cgH, wr = gr.wheelR;
  const leg = (x, z, wheels, axles, wide) => {
    const g = new THREE.Group();
    const top = new THREE.Vector3(x, w.pos === 'high' && Math.abs(x) > 0.1 ? -H * 0.32 : -H * 0.3, z);
    g.position.copy(top);
    const parts = [];
    const bottom = yG + wr - top.y;
    parts.push(strut(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, bottom, 0), Math.max(0.05, wr * 0.22), 0x8a8f96));
    for (let ax = 0; ax < axles; ax++) {
      const az = axles > 1 ? (ax - (axles - 1) / 2) * wr * 2.3 : 0;
      for (let k = 0; k < wheels; k++) {
        const wx = wheels > 1 ? (k - (wheels - 1) / 2) * wr * (wide ? 1.9 : 1.1) : 0;
        parts.push(cylX(wr, wr * 0.7, wx, bottom, az, 0x16171a));
      }
      if (axles > 1) parts.push(box(wr * 0.3, wr * 0.3, wr * 2.3 * (axles - 1) + wr, 0, bottom + wr * 0.1, 0, 0x8a8f96));
    }
    if (gr.pants) parts.push(box(wr * 1.1, wr * 1.5, wr * 3.2, 0, bottom + wr * 0.25, 0, L.stripe));
    const mesh = new THREE.Mesh(merge(parts), M.metal);
    castAll(mesh);
    g.add(mesh);
    g.userData.dir = Math.abs(x) < 0.01 ? -1 : 1;     // nose leg folds forward, mains inboard
    g.userData.side = Math.sign(x);
    root.add(g);
    pivots.gear.push(g);
    return g;
  };
  const big = T.cls === 'widebody' || T.cls === 'super';
  leg(0, gr.nose, 2, 1, false);
  for (const s of [-1, 1]) leg(s * gr.mains[0], gr.mains[1], T.cls === 'light' ? 1 : 2, gr.axles, big);
  if (gr.body) for (const s of [-1, 1]) leg(s * gr.body[0], gr.body[1], 2, 3, true);
  // ---- assemble
  const bodyMesh = new THREE.Mesh(merge(body), M.body);
  const fusMesh = new THREE.Mesh(merge(fus), M.body);
  const glassMesh = glass.length ? new THREE.Mesh(merge(glass), M.glass) : null;
  const cockpitMesh = new THREE.Mesh(merge(cockpitGlass), M.cockpit);
  const metalMesh = metal.length ? new THREE.Mesh(merge(metal), M.metal) : null;
  for (const m of [bodyMesh, fusMesh, glassMesh, cockpitMesh, metalMesh]) if (m) { castAll(m); root.add(m); }
  // ---- lights
  const tip = wingAt(1);
  const lights = {
    navL: [-(tip.x + 0.1), tip.y, tip.z + tip.c * 0.3], navR: [tip.x + 0.1, tip.y, tip.z + tip.c * 0.3], tail: [0, ringAt(zT).y + 0.1, zT + 0.15],
    beaconTop: [0, H / 2 + 0.12, 0.05 * T.len], beaconBot: [0, -H / 2 - 0.12, -0.05 * T.len],
    landL: [-W * 0.7, w.y, w.zLE + 0.2], landR: [W * 0.7, w.y, w.zLE + 0.2], taxi: [0, yG + wr * 2.5, gr.nose - 0.3],
    logoL: [-hs.semi * 0.6, hs.y + 0.3, hs.zLE + 1], logoR: [hs.semi * 0.6, hs.y + 0.3, hs.zLE + 1],
  };
  const lp = makeLights(lights, T);
  root.add(lp.points);
  return { root, type, T, pivots, body: bodyMesh, fuselage: fusMesh, glass: glassMesh, cockpit: cockpitMesh, lights: lp, eye: T.cockpit, inside: [fusMesh, glassMesh, cockpitMesh].filter(Boolean) };
}

function castAll(m) { m.castShadow = true; m.receiveShadow = true; }

// Nav lights (red left, green right, white tail), red beacons, white strobes,
// landing and taxi lights, in the model's own frame.
function makeLights(L, T) {
  const list = [
    [L.navL, 0xff2a1a, 1.4, 0, 0], [L.navR, 0x2aff6a, 1.4, 0, 0], [L.tail, 0xffffff, 1.1, 0, 0],
    [L.beaconTop, 0xff2a1a, 2.2, 1, 1.1], [L.beaconBot, 0xff2a1a, 2.2, 1, 1.1],
    [L.navL, 0xffffff, 3.4, 1, 1.25], [L.navR, 0xffffff, 3.4, 1, 1.25],
    [L.landL, 0xfff2d8, 5.5, 0, 0], [L.landR, 0xfff2d8, 5.5, 0, 0], [L.taxi, 0xfff2d8, 3, 0, 0],
  ];
  const n = list.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), anim = new Float32Array(n * 2);
  const c = new THREE.Color();
  list.forEach(([p, hex, s, mode, rate], i) => {
    pos.set(p, i * 3); c.setHex(hex); col.set([c.r, c.g, c.b], i * 3); size[i] = s * Math.max(1, T.span / 30); anim[2 * i] = mode; anim[2 * i + 1] = rate;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aAnim', new THREE.BufferAttribute(anim, 2));
  const mat = makeLightMaterial(0.35);
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false;
  points.renderOrder = 9;
  return { points, mat, size, base: Float32Array.from(size), land: [7, 8], taxi: 9 };
}

// Move the moving parts to match the body: control surfaces, flaps, gear,
// propellers and fans, lights.
export function poseAircraft(m, b, dt, night, camera = null) {
  const T = m.T, P = m.pivots, s = b.surf;
  m.root.position.copy(b.pos);
  m.root.quaternion.copy(b.q);
  if (T.engine === 'blimp') { poseBlimp(m, b, dt, night); return; }
  const flapT = b.flapPos / Math.max(1, T.flaps.length - 1);
  for (const g of P.flaps) g.children[0].rotation.x = flapT * 0.62;
  for (const g of P.ailerons) g.children[0].rotation.x = -s.aileron * 0.32 * g.userData.side;
  for (const g of P.elevators) g.children[0].rotation.x = -s.elevator * 0.35;
  if (P.rudder) P.rudder.children[0].rotation.x = s.rudder * 0.4;
  // Gear: the legs fold up as it retracts, and vanish once stowed.
  for (const g of P.gear) {
    const up = 1 - b.gearPos;
    g.visible = b.gearPos > 0.02;
    if (g.userData.dir < 0) g.rotation.x = up * 1.45;
    else g.rotation.z = -g.userData.side * up * 1.5;
  }
  // Props and fans.
  for (const p of P.props) {
    p.rotation.z = b.prop * 7 * p.userData.dir;
    const fast = b.n1 > 0.25;
    p.userData.blades.visible = !fast || (camera && camera.position.distanceToSquared(m.root.position) > 3000);
    p.userData.blur.visible = fast;
  }
  for (const f of P.fans) f.rotation.z += dt * (6 + b.n1 * 60);
  // Lights: landing lights on near the ground and below 10,000 ft, the taxi light on the ground.
  const L = m.lights;
  const land = b.agl < 3000 && (b.onGround ? b.throttle > 0.5 : true);
  for (const i of L.land) L.size[i] = land ? L.base[i] : 0;
  L.size[L.taxi] = b.onGround && b.speed < 25 ? L.base[L.taxi] : 0;
  m.lights.points.geometry.attributes.aSize.needsUpdate = true;
  setAircraftNight(night);
}

// ================================================================= blimp
// The Boodyear Glimp: a silver-blue envelope with the name down both sides
// and a lit sign at night, a gondola slung underneath, two props and a
// cruciform tail.
const SIGN_LINES = ['BOODYEAR', 'GO SOX!', 'WICKED AWESOME', 'PAHK THE CAH', 'RACE BOSTON', 'BOODYEAR'];

function blimpTexture() {
  const cv = document.createElement('canvas');
  cv.width = 2048; cv.height = 512;
  const ctx = cv.getContext('2d');
  // Envelope: light silver with a blue band and the name in yellow, outlined.
  ctx.fillStyle = '#d9dee4'; ctx.fillRect(0, 0, 2048, 512);
  ctx.fillStyle = '#1d3d8f'; ctx.fillRect(0, 150, 2048, 212);
  ctx.fillStyle = '#f2c12e'; ctx.fillRect(0, 140, 2048, 12); ctx.fillRect(0, 360, 2048, 12);
  ctx.font = '900 italic 168px Inter, "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 14; ctx.strokeStyle = '#0b1220';
  ctx.strokeText('BOODYEAR', 1024, 262);
  ctx.fillStyle = '#f2c12e';
  ctx.fillText('BOODYEAR', 1024, 262);
  // A little ghost on either side of the name.
  for (const gx of [300, 1748]) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(gx, 235, 46, Math.PI, 0);
    ctx.lineTo(gx + 46, 300);
    for (let k = 0; k < 4; k++) ctx.lineTo(gx + 46 - (k + 0.5) * 23, k % 2 ? 300 : 284);
    ctx.lineTo(gx - 46, 300);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#0b1220';
    ctx.beginPath(); ctx.arc(gx - 16, 236, 8, 0, Math.PI * 2); ctx.arc(gx + 16, 236, 8, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function signTexture() {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 128;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData = { cv, line: -1 };
  return tex;
}

function drawSign(tex, i) {
  const { cv } = tex.userData;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#05070a'; ctx.fillRect(0, 0, cv.width, cv.height);
  // LED dots.
  ctx.font = '900 92px Inter, "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = i % 2 ? '#ffd447' : '#7fd4ff';
  ctx.fillText(SIGN_LINES[i % SIGN_LINES.length], cv.width / 2, cv.height / 2 + 4);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  for (let x = 0; x < cv.width; x += 8) ctx.fillRect(x, 0, 3, cv.height);
  for (let y = 0; y < cv.height; y += 8) ctx.fillRect(0, y, cv.width, 3);
  tex.needsUpdate = true;
}

function buildBlimp(T) {
  const M = materials();
  const root = new THREE.Group();
  root.name = 'aircraft-blimp';
  const Lb = T.len, R = T.fus.W / 2, zN = -T.fus.zNose, zT = Lb - T.fus.zNose;
  // Envelope: a lathe along z, fat in front, tapering aft.
  const prof = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const r = R * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.82)), 0.72);
    prof.push(new THREE.Vector2(Math.max(0.05, r), zN + t * Lb));
  }
  const env = new THREE.LatheGeometry(prof, 40);
  env.rotateX(Math.PI / 2);
  // UVs: u along the length, v around: the name on both sides.
  const p = env.attributes.position, uv = env.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i), x = p.getX(i), y = p.getY(i);
    const u = (z - zN) / Lb;
    const ang = Math.atan2(y, Math.abs(x));             // -pi/2 bottom .. pi/2 top, mirrored per side
    const v = 0.5 + ang / Math.PI;
    uv.setXY(i, x > 0 ? 1 - u : u, v);
  }
  env.computeVertexNormals();
  const tex = blimpTexture();
  const envMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0.15 });
  const envMesh = new THREE.Mesh(env, envMat);
  castAll(envMesh);
  root.add(envMesh);
  // The night sign: a panel on each side, lit.
  const sTex = signTexture();
  drawSign(sTex, 0);
  const signMat = new THREE.MeshBasicMaterial({ map: sTex, toneMapped: false, transparent: true, opacity: 0.95 });
  const signs = [];
  for (const s of [-1, 1]) {
    const sm = new THREE.Mesh(new THREE.PlaneGeometry(Lb * 0.42, R * 0.42), signMat);
    sm.position.set(s * (R * 0.985), -R * 0.42, zN + Lb * 0.47);
    sm.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    sm.rotation.x = s * 0.0;
    sm.renderOrder = 4;
    root.add(sm);
    signs.push(sm);
  }
  // Fins: a cross of four, blue with yellow trim.
  const parts = [];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4 * 0;
    const g = new THREE.BufferGeometry();
    const r0 = R * 0.42, r1 = R * 1.05, z0 = zT - Lb * 0.24, z1 = zT - Lb * 0.04;
    const pts = [[r0, z0], [r1, z0 + Lb * 0.09], [r1, z1], [r0 * 0.4, zT - 1]];
    const pos = [];
    const P = ([rr, zz]) => [Math.sin(a) * rr, Math.cos(a) * rr, zz];
    for (const [i0, i1, i2] of [[0, 1, 2], [0, 2, 3]]) pos.push(...P(pts[i0]), ...P(pts[i1]), ...P(pts[i2]));
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    parts.push(colorAll(g, k % 2 ? 0x1d3d8f : 0x1d3d8f));
  }
  const finMesh = new THREE.Mesh(merge(parts), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, side: THREE.DoubleSide }));
  castAll(finMesh);
  root.add(finMesh);
  // Gondola with windows, slung under the middle.
  const gy = -T.cgH + 1.25;
  const gond = [];
  gond.push(box(2.2, 2.0, 8.5, 0, gy + 1.0, -2, 0xe9ecef));
  gond.push(colorAll(new THREE.SphereGeometry(1.1, 14, 10).scale(1, 0.9, 1.6).translate(0, gy + 1.05, -6.4), 0xe9ecef));
  gond.push(box(2.0, 0.5, 8.0, 0, gy + 2.2, -2, 0x1d3d8f));
  gond.push(strut(new THREE.Vector3(0, gy + 0.05, -1.8), new THREE.Vector3(0, -T.cgH + 0.35, -1.8), 0.08, 0x8a8f96));
  gond.push(cylX(0.35, 0.25, 0, -T.cgH + 0.35, -1.8, 0x16171a));
  const gm = new THREE.Mesh(merge(gond), M.body);
  castAll(gm);
  root.add(gm);
  const gw = [];
  for (const s of [-1, 1]) for (let k = 0; k < 5; k++) gw.push(box(0.03, 0.7, 1.0, s * 1.11, gy + 1.3, -5.0 + k * 1.5, 0xffffff));
  gw.push(box(1.6, 0.8, 0.03, 0, gy + 1.3, -7.95, 0xffffff));
  const gwin = new THREE.Mesh(merge(gw), M.glass);
  root.add(gwin);
  // Props on outriggers either side of the gondola.
  const props = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(merge([strut(new THREE.Vector3(s * 1.0, gy + 1.4, -1), new THREE.Vector3(s * 3.4, gy + 1.6, -0.4), 0.12, 0xb7bcc2), cylZ(0.38, 0.32, 1.9, s * 3.4, gy + 1.6, -0.4, 0x9aa1a8, 12)]), M.metal);
    root.add(arm);
    const prop = new THREE.Group();
    prop.position.set(s * 3.4, gy + 1.6, 0.6);
    const blades = new THREE.Group();
    for (let k = 0; k < 3; k++) {
      const b = new THREE.Mesh(colorAll(new THREE.BoxGeometry(0.14, 1.15, 0.04).translate(0, 0.62, 0), 0x2a2d31), M.metal);
      b.rotation.z = (k / 3) * Math.PI * 2; b.rotation.y = 0.4;
      blades.add(b);
    }
    prop.add(blades);
    const blur = new THREE.Mesh(new THREE.CircleGeometry(1.25, 24), M.blur);
    prop.add(blur);
    prop.userData = { blades, blur, dir: s };
    root.add(prop);
    props.push(prop);
  }
  const lights = makeLights({
    navL: [-R * 0.95, 0, zN + Lb * 0.4], navR: [R * 0.95, 0, zN + Lb * 0.4], tail: [0, 0, zT + 0.2],
    beaconTop: [0, R + 0.2, 0], beaconBot: [0, gy, -2], landL: [-0.5, gy + 0.2, -7], landR: [0.5, gy + 0.2, -7], taxi: [0, gy, -7],
  }, T);
  root.add(lights.points);
  return { root, type: 'blimp', T, pivots: { props, flaps: [], ailerons: [], elevators: [], rudder: null, fans: [], gear: [] }, body: envMesh, glass: gwin, cockpit: gm, lights, signs, signTex: sTex, signMat, eye: T.cockpit, signT: 0, signI: 0, inside: [gm, gwin] };
}

function poseBlimp(m, b, dt, night) {
  for (const p of m.pivots.props) {
    p.rotation.z += dt * (4 + Math.abs(b.n1) * 40) * p.userData.dir * Math.sign(b.blimpThrottle || 1);
    p.userData.blur.visible = Math.abs(b.n1) > 0.2;
  }
  // The sign: brighter at night, a new message every few seconds.
  m.signT += dt;
  if (m.signT > 4) { m.signT = 0; m.signI++; drawSign(m.signTex, m.signI); }
  m.signMat.opacity = 0.35 + 0.6 * Math.max(night, 0.15);
  m.signMat.color.setScalar(0.6 + 1.4 * night);
  const L = m.lights;
  for (const i of L.land) L.size[i] = b.agl < 200 ? L.base[i] : 0;
  L.size[L.taxi] = 0;
  L.points.geometry.attributes.aSize.needsUpdate = true;
  setAircraftNight(night);
}

export function disposeAircraft(m) {
  m.root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material && !Object.values(mats).includes(o.material)) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
  m.root.removeFromParent();
}

export { globalUniforms };
