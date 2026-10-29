// Static collision data in 3D: building walls, bridge railings, cut and tunnel
// walls (segments with a vertical extent), tree trunks and bridge pillars
// (circles at ground level), map bounds, a surface raster (water / grass /
// road / open cuts) and the elevated or sunken road surfaces the car can be on.

import { SegmentGrid, PointGrid, SurfaceMap } from './spatial.js';
import { AREA, SIDEWALK_W, hasSidewalk } from './mapdata.js';
import { segDist2 } from './util.js';
import { segCategory } from './structures.js';

export const SURF = { WATER: 1, ROAD: 2, GRASS: 4, PAVED: 8, BLDG: 16, CUT: 32 };
const GREEN = new Set([AREA.PARK, AREA.GRASS, AREA.PITCH, AREA.GOLF, AREA.CEMETERY, AREA.WOOD, AREA.GARDEN, AREA.WETLAND, AREA.PLAYGROUND]);
const PAVED = new Set([AREA.PARKING, AREA.PLAZA, AREA.FUEL, AREA.TRACK, AREA.RAILYARD, AREA.DIRT, AREA.APRON]);
const CAR_H = 1.5;
const STEP_UP = 0.9;

export class CollisionWorld {
  constructor(map, world) {
    const b = map.meta.play;
    const st = world.structures || { walls: [], surfaces: [], pillars: [], footprints: [] };
    this.bounds = b;
    this.walls = new SegmentGrid(b, 10);
    for (const bd of map.buildings) {
      if (!bd.solid) continue;
      for (const r of bd.rings) {
        const n = r.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          this.walls.add(r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1], 0, 0, bd.minH - 0.2, bd.h);
        }
      }
    }
    for (const [ax, az, bx, bz, y0, y1, kind] of st.walls) this.walls.add(ax, az, bx, bz, kind, 0, y0, y1);
    this.walls.build();

    this.trees = new PointGrid(b, 10);
    for (let i = 0; i < map.trees.length; i += 2) this.trees.add(map.trees[i], map.trees[i + 1], 0.32);
    for (const [x, z, r] of st.pillars) this.trees.add(x, z, r);
    this.trees.build();

    // Elevated / sunken road surfaces: [ax, az, bx, bz, ya, yb, halfWidth].
    this.decks = new SegmentGrid(b, 16);
    const hw = [], lw = [];
    for (const [ax, az, bx, bz, ya, yb, w, lane] of st.surfaces) { this.decks.add(ax, az, bx, bz, 0, 0, ya, yb); hw.push(w); lw.push(lane ?? w); }
    this.decks.build();
    this.deckHW = Float32Array.from(hw);
    this.deckLaneHW = Float32Array.from(lw);

    const s = (this.surface = new SurfaceMap(b, 2));
    s.fill(SURF.WATER);
    for (const p of map.land) s.polygon(p, SURF.WATER, true);
    for (const p of map.water) s.polygon(p, SURF.WATER);
    for (const a of map.areas) {
      if (a.type === AREA.PIER) s.polygon(a.rings, SURF.PAVED);
      else if (GREEN.has(a.type)) s.polygon(a.rings, SURF.GRASS);
      else if (PAVED.has(a.type)) { s.polygon(a.rings, SURF.PAVED); s.polygon(a.rings, SURF.GRASS, true); }
    }
    for (const p of map.piers) s.line(p.pts, p.width / 2, SURF.PAVED);
    // Airfield pavement: runways (with shoulders), taxiways, apron around stands.
    if (map.aero) {
      const A = map.aero, P = (nodes) => Float32Array.from(Array.from(nodes).flatMap((n) => [A.nodes[2 * n], A.nodes[2 * n + 1]]));
      for (const r of A.runways) s.line(P(r.nodes), r.width / 2 + 7.5, SURF.PAVED);
      for (const w of A.ways) s.line(P(w.nodes), w.kind === 2 ? 26 : w.kind >= 3 ? 30 : w.width / 2, SURF.PAVED);
    }
    for (const p of map.paths) s.line(p.pts, p.width / 2 + 0.3, SURF.PAVED);
    const nodes = map.nodes, ny = map.nodeY;
    // Only at-grade road segments count as "road" at ground level.
    for (const r of map.roads) {
      const w = r.width / 2 + (hasSidewalk(r) ? SIDEWALK_W : 0.6);
      for (let i = 0; i + 1 < r.nodes.length; i++) {
        const a = r.nodes[i], c = r.nodes[i + 1];
        if (segCategory(r, ny[a], ny[c]) !== 'flat') continue;
        s.line([nodes[2 * a], nodes[2 * a + 1], nodes[2 * c], nodes[2 * c + 1]], w, SURF.ROAD);
      }
    }
    for (const bd of map.buildings) if (bd.solid) s.polygon(bd.rings, SURF.BLDG);
    // Open cuts: there is no ground to stand on here.
    for (const q of st.footprints) s.polygon([Float32Array.from([q[0][0], q[0][2], q[1][0], q[1][2], q[2][0], q[2][2], q[3][0], q[3][2]])], SURF.CUT);
    this._tmp = { t: 0, x: 0, z: 0 };
  }

  surfaceAt(x, z) { return this.surface.get(x, z); }

  // Water only counts at ground level (not on decks, in cuts or in tunnels).
  isWater(x, z, y = 0, onDeck = false) {
    if (onDeck || y > 0.6 || y < -0.6) return false;
    const v = this.surface.get(x, z);
    return (v & SURF.WATER) && !(v & (SURF.ROAD | SURF.PAVED | SURF.CUT)) ? true : false;
  }

  outOfBounds(x, z, margin = 0) {
    const b = this.bounds;
    return x < b.minX + margin || x > b.maxX - margin || z < b.minZ + margin || z > b.maxZ - margin;
  }

  // Height of the surface a car at (x, y, z) stands on. Among the road decks
  // and ground at about the car's level, the one whose centreline the car is
  // laterally closest to (relative to its lane width) wins, which is how a
  // driver follows lanes through splits, merges and ramp starts. With nothing
  // at the car's level (falling, landing), the nearest surface below is used.
  // Fills {h, deck, inCut}.
  groundHeight(x, z, y, out) {
    const D = this.decks, s = D.segs, tmp = this._tmp;
    const n = D.query(x, z, 18);
    let lvH = NaN, lvScore = Infinity, lvDeck = false;
    let anyH = NaN, anyGap = Infinity, anyDeck = false;
    let nearH = NaN, nearD = Infinity;
    for (let k = 0; k < n; k++) {
      const i = D.result[k];
      const ax = s[4 * i], az = s[4 * i + 1], bx = s[4 * i + 2], bz = s[4 * i + 3];
      const d2 = segDist2(x, z, ax, az, bx, bz, tmp);
      const w = this.deckHW[i];
      const dx = bx - ax, dz = bz - az;
      const tu = ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9);
      // Height along the segment, extrapolated a little past its ends.
      const h = D.y0[i] + (D.y1[i] - D.y0[i]) * tu;
      if (h > y + STEP_UP) continue;
      if (d2 > w * w) {
        if (d2 < nearD) { nearD = d2; nearH = D.y0[i] + (D.y1[i] - D.y0[i]) * tmp.t; }
        continue;
      }
      const end = tu < 0 || tu > 1;
      const gap = Math.abs(h - y);
      const score = Math.sqrt(d2) / Math.max(1, this.deckLaneHW[i]) + (end ? 0.5 : 0);
      if (gap < 0.6 && score < lvScore) { lvScore = score; lvH = h; lvDeck = true; }
      const g2 = gap + (end ? 0.05 : 0);
      if (g2 < anyGap) { anyGap = g2; anyH = h; anyDeck = true; }
    }
    // A cut's footprint can bleed onto an at-grade street beside it; streets keep their ground.
    const bits = this.surface.get(x, z);
    const inCut = !!(bits & SURF.CUT) && !((bits & SURF.ROAD) && y > -0.6);
    if (!inCut && 0 <= y + STEP_UP) {
      const gap = Math.abs(y);
      const score = bits & SURF.ROAD ? 0.85 : 1.15;
      if (gap < 0.6 && score < lvScore) { lvScore = score; lvH = 0; lvDeck = false; }
      if (gap < anyGap) { anyGap = gap; anyH = 0; anyDeck = false; }
    }
    let h, deck;
    if (!Number.isNaN(lvH)) { h = lvH; deck = lvDeck; }
    else if (!Number.isNaN(anyH)) { h = anyH; deck = anyDeck; }
    else if (Number.isFinite(nearH)) { h = nearH; deck = true; } // in a cut, beside the road strip
    else { h = inCut ? y : 0; deck = false; }
    out.h = h; out.deck = deck; out.inCut = inCut;
    return h;
  }

  // Deepest contact of a circle against static geometry at height y.
  resolveCircle(x, z, r, out, y = 0) {
    let best = 0, nx = 0, nz = 0, kind = 0;
    const W = this.walls, s = W.segs, tmp = this._tmp;
    const n = W.query(x, z, r + 0.05);
    const yLo = y + 0.15, yHi = y + CAR_H;
    for (let k = 0; k < n; k++) {
      const i = W.result[k];
      if (W.y1[i] < yLo || W.y0[i] > yHi) continue;
      const ax = s[4 * i], az = s[4 * i + 1], bx = s[4 * i + 2], bz = s[4 * i + 3];
      const d2 = segDist2(x, z, ax, az, bx, bz, tmp);
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2);
      const depth = r - d;
      if (depth <= best) continue;
      best = depth;
      kind = W.meta[i] === 0 ? 1 : W.meta[i];
      if (d > 1e-4) { nx = (x - tmp.x) / d; nz = (z - tmp.z) / d; }
      else {
        const l = Math.hypot(bx - ax, bz - az) || 1;
        nx = -(bz - az) / l; nz = (bx - ax) / l;
      }
    }
    // Trees and pillars stand on the ground.
    if (y > -1 && y < 2.5 && !(this.surface.get(x, z) & SURF.CUT)) {
      const T = this.trees;
      const m = T.query(x, z, r + 1);
      for (let k = 0; k < m; k++) {
        const i = T.result[k];
        const tx = T.pts[3 * i], tz = T.pts[3 * i + 1], tr = T.pts[3 * i + 2];
        const dx = x - tx, dz = z - tz;
        const d = Math.hypot(dx, dz);
        const depth = r + tr - d;
        if (depth <= best || d < 1e-5) continue;
        best = depth; nx = dx / d; nz = dz / d; kind = 3;
      }
    }
    const b = this.bounds;
    let g = b.minX - (x - r);
    if (g > best) { best = g; nx = 1; nz = 0; kind = 4; }
    g = x + r - b.maxX;
    if (g > best) { best = g; nx = -1; nz = 0; kind = 4; }
    g = b.minZ - (z - r);
    if (g > best) { best = g; nx = 0; nz = 1; kind = 4; }
    g = z + r - b.maxZ;
    if (g > best) { best = g; nx = 0; nz = -1; kind = 4; }
    out.depth = best; out.nx = nx; out.nz = nz; out.kind = kind;
    return best > 0;
  }

  // Fraction t along a->b (2D) where it first crosses a wall spanning height y.
  segmentBlocked(ax, az, bx, bz, y = 1.5) {
    const W = this.walls, s = W.segs;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const n = W.query(mx, mz, Math.hypot(bx - ax, bz - az) / 2 + 1);
    let tBest = 1;
    for (let k = 0; k < n; k++) {
      const i = W.result[k];
      if (W.y1[i] < y - 0.5 || W.y0[i] > y + 0.5) continue;
      const t = segIntersect(ax, az, bx, bz, s[4 * i], s[4 * i + 1], s[4 * i + 2], s[4 * i + 3]);
      if (t >= 0 && t < tBest) tBest = t;
    }
    return tBest;
  }
}

// Returns t along p0->p1 where it crosses segment q0->q1, or -1.
function segIntersect(p0x, p0z, p1x, p1z, q0x, q0z, q1x, q1z) {
  const rx = p1x - p0x, rz = p1z - p0z, sx = q1x - q0x, sz = q1z - q0z;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const qpx = q0x - p0x, qpz = q0z - p0z;
  const t = (qpx * sz - qpz * sx) / den;
  const u = (qpx * rz - qpz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}
