// Static collision data: building walls and bridge railings (segments), tree
// trunks (circles), map bounds, and a surface raster (water / grass / road).

import { SegmentGrid, PointGrid, SurfaceMap } from './spatial.js';
import { AREA, SIDEWALK_W, hasSidewalk } from './mapdata.js';
import { segDist2 } from './util.js';

export const SURF = { WATER: 1, ROAD: 2, GRASS: 4, PAVED: 8, BLDG: 16 };
const GREEN = new Set([AREA.PARK, AREA.GRASS, AREA.PITCH, AREA.GOLF, AREA.CEMETERY, AREA.WOOD, AREA.GARDEN, AREA.WETLAND, AREA.PLAYGROUND]);
const PAVED = new Set([AREA.PARKING, AREA.PLAZA, AREA.FUEL, AREA.TRACK, AREA.RAILYARD]);

export class CollisionWorld {
  constructor(map, world) {
    const b = map.meta.play;
    this.bounds = b;
    this.walls = new SegmentGrid(b, 10);
    for (const bd of map.buildings) {
      if (!bd.solid) continue;
      for (const r of bd.rings) {
        const n = r.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          this.walls.add(r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1], 0);
        }
      }
    }
    for (const [ax, az, bx, bz] of world.railSegments) this.walls.add(ax, az, bx, bz, 1);
    this.walls.build();

    this.trees = new PointGrid(b, 10);
    for (let i = 0; i < map.trees.length; i += 2) this.trees.add(map.trees[i], map.trees[i + 1], 0.32);
    this.trees.build();

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
    for (const p of map.paths) s.line(p.pts, p.width / 2 + 0.3, SURF.PAVED);
    const nodes = map.nodes;
    for (const r of map.roads) {
      const pts = new Float32Array(r.nodes.length * 2);
      r.nodes.forEach((n, i) => { pts[2 * i] = nodes[2 * n]; pts[2 * i + 1] = nodes[2 * n + 1]; });
      s.line(pts, r.width / 2 + (hasSidewalk(r) ? SIDEWALK_W : 0.6), SURF.ROAD);
    }
    for (const bd of map.buildings) if (bd.solid) s.polygon(bd.rings, SURF.BLDG);
    this._tmp = { t: 0, x: 0, z: 0 };
  }

  surfaceAt(x, z) { return this.surface.get(x, z); }

  isWater(x, z) {
    const v = this.surface.get(x, z);
    return (v & SURF.WATER) && !(v & (SURF.ROAD | SURF.PAVED)) ? true : false;
  }

  outOfBounds(x, z, margin = 0) {
    const b = this.bounds;
    return x < b.minX + margin || x > b.maxX - margin || z < b.minZ + margin || z > b.maxZ - margin;
  }

  // Deepest contact of a circle against static geometry. Fills out {depth, nx, nz, kind}.
  resolveCircle(x, z, r, out) {
    let best = 0, nx = 0, nz = 0, kind = 0;
    const W = this.walls, s = W.segs, tmp = this._tmp;
    const n = W.query(x, z, r + 0.05);
    for (let k = 0; k < n; k++) {
      const i = W.result[k];
      const ax = s[4 * i], az = s[4 * i + 1], bx = s[4 * i + 2], bz = s[4 * i + 3];
      const d2 = segDist2(x, z, ax, az, bx, bz, tmp);
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2);
      const depth = r - d;
      if (depth <= best) continue;
      best = depth;
      kind = W.meta[i] === 1 ? 2 : 1;
      if (d > 1e-4) { nx = (x - tmp.x) / d; nz = (z - tmp.z) / d; }
      else {
        const l = Math.hypot(bx - ax, bz - az) || 1;
        nx = -(bz - az) / l; nz = (bx - ax) / l;
      }
    }
    const T = this.trees;
    const m = T.query(x, z, r + 0.5);
    for (let k = 0; k < m; k++) {
      const i = T.result[k];
      const tx = T.pts[3 * i], tz = T.pts[3 * i + 1], tr = T.pts[3 * i + 2];
      const dx = x - tx, dz = z - tz;
      const d = Math.hypot(dx, dz);
      const depth = r + tr - d;
      if (depth <= best || d < 1e-5) continue;
      best = depth; nx = dx / d; nz = dz / d; kind = 3;
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

  // True if the straight line a->b crosses a wall (used for camera occlusion).
  segmentBlocked(ax, az, bx, bz) {
    const W = this.walls, s = W.segs;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const n = W.query(mx, mz, Math.hypot(bx - ax, bz - az) / 2 + 1);
    let tBest = 1;
    for (let k = 0; k < n; k++) {
      const i = W.result[k];
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
