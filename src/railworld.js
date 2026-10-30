// Underground and sunken rail: subway tunnels (a box with tiled walls and
// lamps), open cuts down to the portals (retaining walls, floor, openings in
// the ground), portal headwalls, and station platforms from their OSM
// outlines with lights and name boards. Parallel tracks share one box, and
// the wall steps back behind a platform.

import * as THREE from 'three';
import earcut from '../vendor/earcut.js';
import { GeoBuilder, polyOffsets, meshOf, crossY } from './geom.js';

export const RAIL_CUT = -0.3;     // track this far below the ground is in a cut or tunnel
export const RAIL_COVER = -5.6;   // ...and covered (a tunnel) below this
const HALF = 2.4;                 // track centreline to tunnel wall
const CEIL = 5.0;                 // tunnel ceiling above the rail
const STATION_CEIL = 6.4;         // ...and in stations
const SHARE = 7.5;                // another track this close shares the box

export function serviceOfRef(ref) {
  if (/^Red/.test(ref)) return 'red';
  if (/^Orange/.test(ref)) return 'orange';
  if (/^Blue/.test(ref)) return 'blue';
  if (/^Green/.test(ref)) return 'green';
  return 'commuter';
}
export const LINE_COLOR = { red: '#da291c', orange: '#ed8b00', blue: '#003da5', green: '#00843d', commuter: '#80276c' };

// Grid of rail segments for lateral queries; pick(way) chooses the ways.
function segmentGrid(map, pick, C = 20) {
  const P = map.railNodes, Y = map.railY, grid = new Map(), segs = [];
  map.railWays.forEach((w, wi) => {
    if (!pick(w)) return;
    for (let i = 0; i + 1 < w.nodes.length; i++) {
      const a = w.nodes[i], b = w.nodes[i + 1], k = segs.length;
      segs.push([P[2 * a], P[2 * a + 1], P[2 * b], P[2 * b + 1], Y[a], Y[b], wi]);
      for (let gx = Math.floor(Math.min(P[2 * a], P[2 * b]) / C); gx <= Math.floor(Math.max(P[2 * a], P[2 * b]) / C); gx++)
        for (let gz = Math.floor(Math.min(P[2 * a + 1], P[2 * b + 1]) / C); gz <= Math.floor(Math.max(P[2 * a + 1], P[2 * b + 1]) / C); gz++) {
          const key = gx * 100003 + gz;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(k);
        }
    }
  });
  // Segments in the cells along a ray from (x, z) in direction (dx, dz).
  const along = (x, z, dx, dz, len) => {
    const out = new Set();
    for (let d = 0; d <= len + C; d += C / 2) {
      const k = grid.get(Math.floor((x + dx * Math.min(d, len)) / C) * 100003 + Math.floor((z + dz * Math.min(d, len)) / C));
      if (k) for (const s of k) out.add(s);
    }
    return out;
  };
  // Is there track within r of (x, z) at about height y?
  const near = (x, z, y, r) => {
    for (const k of along(x - r, z, 1, 0, 2 * r)) {
      const s = segs[k];
      const dx = s[2] - s[0], dz = s[3] - s[1], l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / l2));
      if (Math.hypot(x - s[0] - dx * t, z - s[1] - dz * t) < r && Math.abs(s[4] + (s[5] - s[4]) * t - y) < 2.5) return true;
    }
    return false;
  };
  return { segs, along, near };
}

// Distance along the ray (x, z) + d (dx, dz) to where it crosses segment a-b, or -1.
function rayHit(x, z, dx, dz, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az;
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-9) return -1;
  const d = ((ax - x) * ez - (az - z) * ex) / den;
  const u = ((ax - x) * dz - (az - z) * dx) / den;
  return u >= 0 && u <= 1 && d >= 0 ? d : -1;
}

function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length / 2 - 1; i < r.length / 2; j = i++) {
    const xi = r[2 * i], zi = r[2 * i + 1], xj = r[2 * j], zj = r[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// roadOver(x, z): a street at about ground level there (crossing over a cut).
export function buildRailStructures(map, mats, add, openings, roadOver = null) {
  const T = map.terrain, P = map.railNodes, Y = map.railY, R = map.railRel;
  // walls: solid for cars (cut walls, portals, surface platforms); tunnelWalls:
  // inside the tunnels, for the train camera only (cars never get in).
  const out = { walls: [], tunnelWalls: [], platforms: [] };
  const under = (n) => R[n] < RAIL_CUT;
  const ug = segmentGrid(map, (w) => Array.from(w.nodes).some(under));
  const surf = segmentGrid(map, (w) => !Array.from(w.nodes).some(under));
  const trackNear = (x, z, y, r) => ug.near(x, z, y, r) || surf.near(x, z, y, r);

  // ---- platforms: heights from the track beside each vertex
  const plats = map.railPlatforms.map((p) => {
    const n = p.ring.length / 2, ys = new Float32Array(n);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, rel = 0, base = Infinity;
    for (let i = 0; i < n; i++) {
      const x = p.ring[2 * i], z = p.ring[2 * i + 1], node = p.nodes[i];
      ys[i] = Y[node] + p.ph;
      base = Math.min(base, Y[node] - 0.25);
      rel += R[node] / n;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    return { ...p, ys, base, bb: [x0, z0, x1, z1], underground: rel < RAIL_COVER + 1 };
  });
  out.platforms = plats;
  // A platform beside the track at (x, z, y), going out along (dx, dz): its near and far edge.
  const platformSpan = (x, z, y, dx, dz) => {
    let best = null;
    for (const p of plats) {
      if (x + 18 < p.bb[0] || x - 18 > p.bb[2] || z + 18 < p.bb[1] || z - 18 > p.bb[3]) continue;
      const r = p.ring, n = r.length / 2;
      let lo = Infinity, hi = -Infinity, hy = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const d = rayHit(x, z, dx, dz, r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]);
        if (d < 0 || d > 18) continue;
        if (d < lo) { lo = d; hy = p.ys[i]; }
        hi = Math.max(hi, d);
      }
      if (lo > 4 || hi <= lo + 0.5 || Math.abs(hy - p.ph - y) > 2.5) continue;
      if (!best || lo < best.near) best = { near: lo, far: hi, p };
    }
    return best;
  };
  // Nearest other underground track crossing the ray between `from` and `to`,
  // running alongside (a line crossing at this level is not a shared box).
  const trackAcross = (x, z, y, dx, dz, from, to, wi) => {
    let best = Infinity;
    for (const k of ug.along(x, z, dx, dz, to)) {
      const s = ug.segs[k];
      if (s[6] === wi) continue;
      const d = rayHit(x, z, dx, dz, s[0], s[1], s[2], s[3]);
      if (d < from || d > to || d >= best) continue;
      const L = Math.hypot(s[2] - s[0], s[3] - s[1]) || 1;
      if (Math.abs((s[2] - s[0]) * dx + (s[3] - s[1]) * dz) / L > 0.45) continue;
      const f = Math.hypot(x + dx * d - s[0], z + dz * d - s[1]) / L;
      if (Math.abs(s[4] + (s[5] - s[4]) * f - y) > 2.5) continue;
      best = d;
    }
    return best;
  };

  // Inside a station's area (any platform nearby at about this level)?
  const stationNear = (x, z, y) => plats.some((p) => x > p.bb[0] - 9 && x < p.bb[2] + 9 && z > p.bb[1] - 9 && z < p.bb[3] + 9 && Math.abs(p.base + 0.25 - y) < 3);

  // ---- tunnels and cuts
  const tunnel = new GeoBuilder({ aUV: [Float32Array, 2, false] });
  const floorT = new GeoBuilder({ aUV: [Float32Array, 2, false] });
  const floorC = new GeoBuilder({ aUV: [Float32Array, 2, false] });
  const cutWall = new GeoBuilder({});
  const tuv = tunnel.attrs.aUV.buf;
  map.railWays.forEach((w, wi) => {
    const ns = w.nodes, n = ns.length;
    if (!Array.from(ns).some(under)) return;
    const pts = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { pts[2 * i] = P[2 * ns[i]]; pts[2 * i + 1] = P[2 * ns[i] + 1]; }
    const { ox, oz, s } = polyOffsets(pts);
    const Pt = (i, off, y) => [pts[2 * i] + ox[i] * off, y, pts[2 * i + 1] + oz[i] * off];
    const gAt = (p) => T.h(p[0], p[2]);
    // Cross-section at each node: wall offsets per side (past any platform),
    // or half way to the next track where two share a box.
    const sec = new Array(n);
    const section = (i) => {
      if (sec[i]) return sec[i];
      const x = pts[2 * i], z = pts[2 * i + 1], y = Y[ns[i]];
      const ol = Math.hypot(ox[i], oz[i]) || 1, nx = ox[i] / ol, nz = oz[i] / ol;
      const ext = [HALF, HALF], wall = [true, true];
      for (const [k, sd] of [[0, -1], [1, 1]]) {
        const pf = platformSpan(x, z, y, nx * sd, nz * sd);
        const start = pf ? pf.far : 0;
        const dn = trackAcross(x, z, y, nx * sd, nz * sd, Math.max(0.8, start), start + SHARE, wi);
        if (dn < Infinity) { ext[k] = dn / 2 + 0.05; wall[k] = false; }
        else ext[k] = Math.max(HALF, start + 0.25);
      }
      // Ceiling: higher in stations (decided by area, so tracks sharing a box
      // agree), and always just under the ground across the section.
      const l = Pt(i, -ext[0], 0), r = Pt(i, ext[1], 0);
      const lid = Math.min(T.h(l[0], l[2]), T.h(x, z), T.h(r[0], r[2])) - 0.4;
      const ceil = Math.min(y + (stationNear(x, z, y) ? STATION_CEIL : CEIL), lid);
      return (sec[i] = { ext, wall, ceil });
    };
    let prev = null;
    for (let i = 0; i + 1 < n; i++) {
      const a = ns[i], b = ns[i + 1];
      if (!under(a) && !under(b)) { prev = null; continue; }
      const ya = Y[a], yb = Y[b];
      const covered = Math.max(R[a], R[b]) <= RAIL_COVER;
      const A0 = section(i), B0 = section(i + 1);
      const ca = A0.ceil, cb = B0.ceil;
      for (const [k, sd] of [[0, -1], [1, 1]]) {
        if (!A0.wall[k] && !B0.wall[k]) continue;
        const A = Pt(i, A0.ext[k] * sd, ya), B = Pt(i + 1, B0.ext[k] * sd, yb);
        const inx = -(ox[i] + ox[i + 1]) * sd, inz = -(oz[i] + oz[i + 1]) * sd;
        if (covered) {
          tunnel.quadFacing([A[0], ya - 0.4, A[2]], [B[0], yb - 0.4, B[2]], [B[0], cb, B[2]], [A[0], ca, A[2]], inx, 0, inz);
          tuv.p2(s[i], -0.4); tuv.p2(s[i + 1], -0.4); tuv.p2(s[i + 1], cb - yb); tuv.p2(s[i], ca - ya);
          out.tunnelWalls.push([A[0], A[2], B[0], B[2], Math.min(ya, yb) - 0.5, Math.max(ca, cb), 7]);
        } else {
          // Open cut: retaining wall up to a parapet, solid for cars up top,
          // except where a street crosses over (no parapet, nothing to hit).
          const over = roadOver && (roadOver(A[0], A[2]) || roadOver(B[0], B[2]) || roadOver((A[0] + B[0]) / 2, (A[2] + B[2]) / 2));
          const lip = over ? -0.05 : 1.0, ta = gAt(A) + lip, tb = gAt(B) + lip;
          cutWall.quad([A[0], ya - 0.4, A[2]], [B[0], yb - 0.4, B[2]], [B[0], tb, B[2]], [A[0], ta, A[2]], true);
          if (!over) out.walls.push([A[0], A[2], B[0], B[2], Math.min(ya, yb) - 0.5, Math.max(ta, tb), 6]);
        }
      }
      const L0 = -A0.ext[0], R0 = A0.ext[1], L1 = -B0.ext[0], R1 = B0.ext[1];
      // Track bed out to the walls (the rails themselves are drawn by the world).
      const fl = covered ? floorT : floorC, fuv = fl.attrs.aUV.buf;
      fl.quadFacing(Pt(i, L0, ya - 0.03), Pt(i + 1, L1, yb - 0.03), Pt(i + 1, R1, yb - 0.03), Pt(i, R0, ya - 0.03), 0, 1, 0);
      fuv.p2(L0, s[i]); fuv.p2(L1, s[i + 1]); fuv.p2(R1, s[i + 1]); fuv.p2(R0, s[i]);
      if (covered) {
        tunnel.quadFacing(Pt(i, L0, ca), Pt(i + 1, L1, cb), Pt(i + 1, R1, cb), Pt(i, R0, ca), 0, -1, 0);
        tuv.p2(s[i], 10 + L0); tuv.p2(s[i + 1], 10 + L1); tuv.p2(s[i + 1], 10 + R1); tuv.p2(s[i], 10 + R0);
      } else if (openings) {
        // Hole in the ground mesh over the cut.
        const c = [Pt(i, L0, 0), Pt(i, R0, 0), Pt(i + 1, R1, 0), Pt(i + 1, L1, 0)];
        for (const q of c) q[1] = gAt(q) + 0.03;
        openings.quad(c[0], c[1], c[2], c[3]);
      }
      // Portal headwall where the cover starts, facing the open cut (flush
      // with the ground where a street runs over the portal).
      if (prev !== null && prev !== covered) {
        const wd = Math.max(A0.ext[0], A0.ext[1]) + 0.6;
        const L = Pt(i, -wd, 0), Rr = Pt(i, wd, 0), M = Pt(i, 0, 0);
        const over = roadOver && [L, M, Rr].some((p) => roadOver(p[0], p[2]));
        L[1] = gAt(L) + (over ? -0.05 : 1.0); Rr[1] = gAt(Rr) + (over ? -0.05 : 1.0);
        const lo = ca - 0.05;
        cutWall.quad([L[0], lo, L[2]], [Rr[0], lo, Rr[2]], Rr, L, true);
        if (!over) out.walls.push([L[0], L[2], Rr[0], Rr[2], lo, Math.max(L[1], Rr[1]), 6]);
      }
      prev = covered;
    }
  });
  const mk = (b, mat, opts) => { const g = b.build(); if (g) add(meshOf(g, mat, 0, opts)); };
  mk(tunnel, mats.tunnel, { receive: false });
  mk(floorT, mats.railTunnel, { receive: false });
  mk(floorC, mats.rail3d, {});
  mk(cutWall, mats.concrete3d, { shadow: true });

  // ---- platforms, lights and name boards
  const slabUp = new GeoBuilder({}), slabSurf = new GeoBuilder({}), edge = new GeoBuilder({}), lamps = new GeoBuilder({});
  const boards = [];
  for (const pf of plats) {
    const r = pf.ring, n = r.length / 2, ys = pf.ys;
    const slab = pf.underground ? slabUp : slabSurf;
    // Top (triangulated outline) and sides down to the track bed.
    const tri = earcut(Array.from(r), null, 2), base = slab.vcount;
    for (let i = 0; i < n; i++) slab.pos.p3(r[2 * i], ys[i], r[2 * i + 1]);
    for (let i = 0; i < tri.length; i += 3) {
      let a = tri[i], b = tri[i + 1], c = tri[i + 2];
      if (crossY(r[2 * a], r[2 * a + 1], r[2 * b], r[2 * b + 1], r[2 * c], r[2 * c + 1]) < 0) [b, c] = [c, b];
      slab.idx.p3(base + a, base + b, base + c);
    }
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += r[2 * i] / n; cz += r[2 * i + 1] / n; }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      slab.quad([ax, pf.base, az], [bx, pf.base, bz], [bx, ys[j], bz], [ax, ys[i], az], true);
      if (!pf.underground) out.walls.push([ax, az, bx, bz, pf.base, Math.max(ys[i], ys[j]), 6]);
      // Yellow strip along edges beside a track.
      let ix = -(bz - az) / L, iz = (bx - ax) / L;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      if (!pointInRing(mx + ix * 0.3, mz + iz * 0.3, r)) { ix = -ix; iz = -iz; }
      if (L > 3 && trackNear(mx - ix * 1.6, mz - iz * 1.6, (ys[i] + ys[j]) / 2 - pf.ph, 0.9)) {
        const w0 = 0.06, w1 = 0.66;
        edge.quad([ax + ix * w0, ys[i] + 0.012, az + iz * w0], [bx + ix * w0, ys[j] + 0.012, bz + iz * w0], [bx + ix * w1, ys[j] + 0.012, bz + iz * w1], [ax + ix * w1, ys[i] + 0.012, az + iz * w1], true);
      }
    }
    // Long axis of the platform.
    let sxx = 0, szz = 0, sxz = 0;
    for (let i = 0; i < n; i++) { const dx = r[2 * i] - cx, dz = r[2 * i + 1] - cz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
    const th = 0.5 * Math.atan2(2 * sxz, sxx - szz), ux = Math.cos(th), uz = Math.sin(th), vx = -uz, vz = ux;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const dx = r[2 * i] - cx, dz = r[2 * i + 1] - cz, u = dx * ux + dz * uz, v = dx * vx + dz * vz;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const len = u1 - u0;
    if (len < 6) continue;
    const yAt = (x, z) => {
      let best = Infinity, y = ys[0];
      for (let i = 0; i < n; i++) { const d = (r[2 * i] - x) ** 2 + (r[2 * i + 1] - z) ** 2; if (d < best) { best = d; y = ys[i]; } }
      return y;
    };
    // Station lights along the middle (underground).
    const vm = (v0 + v1) / 2;
    if (pf.underground) {
      const hw = Math.min(0.35, (v1 - v0) / 4);
      for (let u = u0 + 2; u < u1 - 1.6; u += 5.5) {
        const x = cx + ux * u + vx * vm, z = cz + uz * u + vz * vm, y = yAt(x, z) + 3.3;
        lamps.quadFacing([x - vx * hw, y, z - vz * hw], [x + vx * hw, y, z + vz * hw], [x + vx * hw + ux * 1.6, y, z + vz * hw + uz * 1.6], [x - vx * hw + ux * 1.6, y, z - vz * hw + uz * 1.6], 0, -1, 0);
      }
    }
    // Name boards: on the back wall facing the track, or hanging over an
    // island platform facing both ways.
    const count = Math.max(1, Math.round(len / 30));
    for (let k = 0; k < count; k++) {
      const u = u0 + (len * (k + 0.5)) / count;
      const px = cx + ux * u, pz = cz + uz * u;
      const top = yAt(px + vx * vm, pz + vz * vm), y = top - pf.ph;
      const plus = trackNear(px + vx * (v1 + 1.6), pz + vz * (v1 + 1.6), y, 1.2);
      const minus = trackNear(px + vx * (v0 - 1.6), pz + vz * (v0 - 1.6), y, 1.2);
      if (!plus && !minus) continue;
      if (plus && minus) {
        for (const sd of [1, -1]) boards.push({ pf, x: px + vx * (vm + sd * 0.03), y: top + 2.75, z: pz + vz * (vm + sd * 0.03), nx: vx * sd, nz: vz * sd, post: !pf.underground });
      } else {
        const sd = plus ? 1 : -1, back = plus ? v0 : v1;
        const inset = pf.underground ? -0.2 : 0.45;   // underground: on the wall just behind the edge
        boards.push({ pf, x: px + vx * (back + sd * inset), y: top + (pf.underground ? 2.3 : 2.5), z: pz + vz * (back + sd * inset), nx: vx * sd, nz: vz * sd, post: !pf.underground });
      }
    }
  }
  if (slabUp.vcount) add(meshOf(slabUp.build(), mats.stationUnder, 0, { receive: false }));
  if (slabSurf.vcount) add(meshOf(slabSurf.build(), mats.concrete3d, 0, { shadow: true }));
  const ge = edge.build();
  if (ge) add(meshOf(ge, new THREE.MeshStandardMaterial({ color: 0xe8c21a, roughness: 0.7, emissive: 0x3a3008, flatShading: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }), 0));
  const gl = lamps.build();
  if (gl) add(meshOf(gl, new THREE.MeshBasicMaterial({ color: 0xfff6e4 }), 0, { receive: false }));
  addBoards(boards, add, map);
  return out;
}

// Line colours for a station: the routes that stop there.
function stationLines(map) {
  const out = new Map();
  for (const r of map.railRoutes) {
    for (const st of r.stops) {
      if (!out.has(st.name)) out.set(st.name, new Set());
      out.get(st.name).add(serviceOfRef(r.ref));
    }
  }
  return out;
}

// All name boards in one mesh, with every station name on one canvas atlas.
function addBoards(boards, add, map) {
  const lines = stationLines(map);
  const names = [...new Set(boards.map((b) => b.pf.name).filter(Boolean))];
  if (!names.length) return;
  const SW = 512, SH = 128, COLS = 4, rows = Math.ceil(names.length / COLS);
  const c = document.createElement('canvas');
  c.width = SW * COLS; c.height = SH * rows;
  const ctx = c.getContext('2d');
  const slot = new Map();
  names.forEach((name, i) => {
    const x0 = (i % COLS) * SW, y0 = Math.floor(i / COLS) * SH;
    slot.set(name, i);
    ctx.fillStyle = '#16181b'; ctx.fillRect(x0, y0, SW, SH);
    const svcs = [...(lines.get(name) || [])];
    if (!svcs.length) svcs.push('commuter');
    svcs.forEach((sv, k) => { ctx.fillStyle = LINE_COLOR[sv]; ctx.fillRect(x0 + (SW * k) / svcs.length, y0, SW / svcs.length + 1, 16); });
    ctx.fillStyle = '#ffffff';
    let fs = 62;
    const font = () => `700 ${fs}px Helvetica, Arial, sans-serif`;
    ctx.font = font();
    while (ctx.measureText(name).width > 476 && fs > 24) { fs -= 3; ctx.font = font(); }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(name, x0 + SW / 2, y0 + 74);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const quads = new GeoBuilder({ uv: [Float32Array, 2, false] }), uv = quads.attrs.uv.buf;
  const posts = new GeoBuilder({});
  const HW = 1.7, HH = 0.425;
  for (const b of boards) {
    if (!slot.has(b.pf.name)) continue;
    // Facing (nx, nz); the reader's right is (nz, -nx).
    const rx = b.nz, rz = -b.nx, i = slot.get(b.pf.name);
    const u0 = (i % COLS) / COLS, u1 = u0 + 1 / COLS, v1 = 1 - Math.floor(i / COLS) / rows, v0 = v1 - 1 / rows;
    quads.quad([b.x - rx * HW, b.y - HH, b.z - rz * HW], [b.x + rx * HW, b.y - HH, b.z + rz * HW], [b.x + rx * HW, b.y + HH, b.z + rz * HW], [b.x - rx * HW, b.y + HH, b.z - rz * HW]);
    uv.p2(u0, v0); uv.p2(u1, v0); uv.p2(u1, v1); uv.p2(u0, v1);
    if (b.post) {
      // Two posts behind the board.
      for (const o of [-1.4, 1.4]) {
        const x = b.x + rx * o - b.nx * 0.06, z = b.z + rz * o - b.nz * 0.06, y0 = b.pf.base + b.pf.ph, y1 = b.y + 0.42;
        const w = 0.05;
        posts.quad([x - w, y0, z - w], [x + w, y0, z + w], [x + w, y1, z + w], [x - w, y1, z - w], true);
        posts.quad([x - w, y0, z + w], [x + w, y0, z - w], [x + w, y1, z - w], [x - w, y1, z + w], true);
      }
    }
  }
  const gq = quads.build();
  if (gq) add(meshOf(gq, new THREE.MeshBasicMaterial({ map: tex }), 0, { receive: false }));
  const gp = posts.build();
  if (gp) add(meshOf(gp, new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide, flatShading: true }), 0));
}
