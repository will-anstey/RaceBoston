// 3D road structures built from node elevations: bridge decks (slab, fascia,
// pillars, railings), open cuts (retaining walls), covered tunnels (walls,
// ceiling, portals), plus the stencil/depth "ground mask" that hides anything
// underground except where the ground is actually cut open.
//
// Also returns the collision walls (with height ranges) and drivable surface
// segments the physics uses to find the road under a car at any level.

import * as THREE from 'three';
import { GeoBuilder, polyOffsets, meshOf } from './geom.js';
import { RC, SIDEWALK_W, hasSidewalk } from './mapdata.js';

export const COVER = -5.4;   // tunnel roads deeper than this get a ceiling
export const CEIL = 5.6;     // tunnel clearance
export const LIFT = 0.05;    // 3D road surfaces sit this far above their node height
export const PARAPET = 1.0;

// 'flat' (drawn in the depth-less ground layers), 'deck' (raised or a bridge),
// 'cut' (below grade, open to the sky) or 'tunnel' (below grade, covered).
export function segCategory(r, ya, yb) {
  if (r.tunnel && Math.max(ya, yb) <= COVER + 1e-3) return 'tunnel';
  if (!r.bridge && !r.tunnel && Math.abs(ya) < 0.02 && Math.abs(yb) < 0.02) return 'flat';
  if ((ya + yb) / 2 < -0.02 && !r.bridge) return 'cut';
  return 'deck';
}

export const roadEdge = (r) => r.width / 2 + (hasSidewalk(r) ? SIDEWALK_W : 0);

// Heights: decisions (deck / cut / tunnel, railings, the street check) use
// nodeRel, heights relative to the ground; geometry uses world heights
// (nodeY) with wall tops, ceilings and pillar feet taken from the terrain.
export function buildStructures(map, graph, mats, add, { isGroundRoad, openings = null }) {
  const nodes = map.nodes, ny = map.nodeY, nr = map.nodeRel, roads = map.roads, T = map.terrain;
  const N = nodes.length / 2;
  const out = { walls: [], surfaces: [], pillars: [], footprints: [] };
  const slab = new GeoBuilder({}), rails = new GeoBuilder({}), walls = new GeoBuilder({});
  const tunnel = new GeoBuilder({ aUV: [Float32Array, 2, false] });
  const stencil = openings || new GeoBuilder({});

  // Per-segment categories and per-node incident categories.
  const cats = roads.map((r) => {
    const c = [];
    for (let i = 0; i + 1 < r.nodes.length; i++) c.push(segCategory(r, nr[r.nodes[i]], nr[r.nodes[i + 1]]));
    return c;
  });
  const nodeTunnel = new Uint8Array(N), nodeOpen = new Uint8Array(N), nodeHW = new Float32Array(N);
  roads.forEach((r, ri) => {
    cats[ri].forEach((c, i) => {
      for (const n of [r.nodes[i], r.nodes[i + 1]]) {
        if (c === 'tunnel') nodeTunnel[n] = 1; else nodeOpen[n] = 1;
        nodeHW[n] = Math.max(nodeHW[n], roadEdge(r));
      }
    });
  });

  // Junction trimming: walls/railings on the side where another road branches off.
  const sideTrim = (r, ri, pts, s) => {
    const n = r.nodes.length;
    const trimL = new Uint8Array(n - 1), trimR = new Uint8Array(n - 1);
    for (let i = 0; i < n; i++) {
      const J = r.nodes[i];
      if (graph.deg[J] < 3 && !(i === 0 || i === n - 1)) continue;
      const k = Math.min(i, n - 2);
      let fx = pts[2 * (k + 1)] - pts[2 * k], fz = pts[2 * (k + 1) + 1] - pts[2 * k + 1];
      const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      let left = false, right = false;
      for (let e = graph.adjStart[J]; e < graph.adjStart[J + 1]; e++) {
        const edge = graph.adj[e];
        if (graph.eRoad[edge] === ri) continue;
        const v = graph.eTo[edge];
        let dx = nodes[2 * v] - nodes[2 * J], dz = nodes[2 * v + 1] - nodes[2 * J + 1];
        const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
        const side = dx * -fz + dz * fx; // + right, - left
        if (Math.abs(side) < 0.25) continue;
        if (side > 0) right = true; else left = true;
      }
      if (!left && !right) continue;
      const zone = nodeHW[J] + roadEdge(r) + 4;
      for (let q = 0; q < n - 1; q++) {
        const mid = (s[q] + s[q + 1]) / 2;
        if (Math.abs(mid - s[i]) < zone) { if (left) trimL[q] = 1; if (right) trimR[q] = 1; }
      }
    }
    return { trimL, trimR };
  };

  const C = 30;
  // Pass 1: drivable surfaces (used for "is there a deck over this wall" too).
  const decks = [];
  const lanes = [];    // [ax, az, bx, bz, ya, yb, laneHalfWidth, roadIndex, relA, relB] for every segment
  roads.forEach((r, ri) => {
    const ns = r.nodes;
    cats[ri].forEach((c, i) => {
      const a = ns[i], b = ns[i + 1];
      lanes.push([nodes[2 * a], nodes[2 * a + 1], nodes[2 * b], nodes[2 * b + 1], ny[a], ny[b], r.width / 2 + 0.4, ri, nr[a], nr[b]]);
      if (c === 'flat') return;
      const seg = [nodes[2 * a], nodes[2 * a + 1], nodes[2 * b], nodes[2 * b + 1], ny[a], ny[b], roadEdge(r) + 0.5, r.width / 2];
      out.surfaces.push(seg);
      if (c === 'deck' && Math.max(nr[a], nr[b]) > 0.2) decks.push(seg);
    });
  });
  // Is (x, z) at height y inside another road's lanes? Walls there would block it.
  const laneGrid = new Map();
  lanes.forEach((d, k) => {
    for (let gx = Math.floor(Math.min(d[0], d[2]) / C); gx <= Math.floor(Math.max(d[0], d[2]) / C); gx++)
      for (let gz = Math.floor(Math.min(d[1], d[3]) / C); gz <= Math.floor(Math.max(d[1], d[3]) / C); gz++) {
        const key = gx * 100003 + gz;
        if (!laneGrid.has(key)) laneGrid.set(key, []);
        laneGrid.get(key).push(k);
      }
  });
  const inOtherLanes = (x, z, y, ri) => {
    for (const k of laneGrid.get(Math.floor(x / C) * 100003 + Math.floor(z / C)) || []) {
      const d = lanes[k];
      if (d[7] === ri) continue;
      const dx = d[2] - d[0], dz = d[3] - d[1], l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - d[0]) * dx + (z - d[1]) * dz) / l2));
      if (Math.hypot(x - d[0] - dx * t, z - d[1] - dz * t) > d[6]) continue;
      if (Math.abs(d[4] + (d[5] - d[4]) * t - y) < 2.2) return true;
    }
    return false;
  };
  const blocked = (A, B, ya, yb, ri) => {
    for (const f of [0.15, 0.5, 0.85]) {
      if (inOtherLanes(A[0] + (B[0] - A[0]) * f, A[2] + (B[2] - A[2]) * f, ya + (yb - ya) * f, ri)) return true;
    }
    return false;
  };
  // Pieces of a cut or tunnel wall along A->B (own road ri at ya..yb, wall
  // top `top`) that keep clear of other roads' traffic. Where another road at
  // about the same level runs through (merges, gores, ramp mouths at street
  // level) the wall is dropped; where one passes over or under it, the wall
  // stops short of that road's cars but still fences its own. OSM layers
  // stack Big Dig ramps only a few meters apart, so a deeper tunnel's walls
  // would otherwise stand across the ramp above it, and a cut beside a
  // slightly lower tunnel would lose its wall and parapet altogether.
  // Returns [f0, f1, bottom, top] pieces.
  const seen = new Int32Array(lanes.length);
  let seenId = 0;
  const wallPieces = (A, B, ya, yb, top, ri) => {
    const yMin = Math.min(ya, yb), near = [];
    seenId++;
    for (let gx = Math.floor(Math.min(A[0], B[0]) / C) - 1; gx <= Math.floor(Math.max(A[0], B[0]) / C) + 1; gx++)
      for (let gz = Math.floor(Math.min(A[2], B[2]) / C) - 1; gz <= Math.floor(Math.max(A[2], B[2]) / C) + 1; gz++)
        for (const k of laneGrid.get(gx * 100003 + gz) || []) {
          if (seen[k] === seenId) continue;
          seen[k] = seenId;
          const d = lanes[k];
          if (d[7] !== ri && Math.max(d[4], d[5]) > yMin - 2.2 && Math.min(d[4], d[5]) < top + 0.1) near.push(d);
        }
    if (!near.length) return [[0, 1, -Infinity, top]];
    const n = Math.max(1, Math.ceil(Math.hypot(B[0] - A[0], B[2] - A[2]) / 3));
    const pieces = [];
    for (let q = 0; q < n; q++) {
      const f0 = q / n, f1 = (q + 1) / n;
      let lo = -Infinity, hi = top, drop = false;
      for (const f of [f0, (f0 + f1) / 2, f1]) {
        const x = A[0] + (B[0] - A[0]) * f, z = A[2] + (B[2] - A[2]) * f, y = ya + (yb - ya) * f;
        for (const d of near) {
          const dx = d[2] - d[0], dz = d[3] - d[1], l2 = dx * dx + dz * dz || 1;
          const u = Math.max(0, Math.min(1, ((x - d[0]) * dx + (z - d[1]) * dz) / l2));
          if (Math.hypot(x - d[0] - dx * u, z - d[1] - dz * u) > d[6] + 0.8) continue;
          const yo = d[4] + (d[5] - d[4]) * u, dy = yo - y;
          const street = Math.abs(d[8]) < 0.05 && Math.abs(d[9]) < 0.05;
          if (Math.abs(dy) < (street ? 2.2 : 0.6)) drop = true;
          else if (street) continue;
          else if (dy > 0) hi = Math.min(hi, yo - 0.1);
          else lo = Math.max(lo, yo + 1.6);
        }
      }
      if (drop || hi - Math.max(lo, yMin) < 0.3) lo = hi = null;
      const last = pieces[pieces.length - 1];
      if (last && last[2] === lo && last[3] === hi) last[1] = f1; else pieces.push([f0, f1, lo, hi]);
    }
    return pieces.filter((p) => p[3] !== null);
  };
  const deckGrid = new Map();
  decks.forEach((d, k) => {
    for (let gx = Math.floor(Math.min(d[0], d[2]) / C); gx <= Math.floor(Math.max(d[0], d[2]) / C); gx++)
      for (let gz = Math.floor(Math.min(d[1], d[3]) / C); gz <= Math.floor(Math.max(d[1], d[3]) / C); gz++) {
        const key = gx * 100003 + gz;
        if (!deckGrid.has(key)) deckGrid.set(key, []);
        deckGrid.get(key).push(k);
      }
  });
  const underDeck = (x, z) => {
    for (const k of deckGrid.get(Math.floor(x / C) * 100003 + Math.floor(z / C)) || []) {
      const d = decks[k];
      const dx = d[2] - d[0], dz = d[3] - d[1], l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - d[0]) * dx + (z - d[1]) * dz) / l2));
      if (Math.hypot(x - d[0] - dx * t, z - d[1] - dz * t) < d[6] + 0.5) return true;
    }
    return false;
  };

  // Pass 2: geometry.
  roads.forEach((r, ri) => {
    const c = cats[ri];
    if (c.every((k) => k === 'flat')) return;
    const ns = r.nodes, n = ns.length;
    const pts = new Float32Array(n * 2), ys = new Float32Array(n), rs = new Float32Array(n);
    for (let i = 0; i < n; i++) { pts[2 * i] = nodes[2 * ns[i]]; pts[2 * i + 1] = nodes[2 * ns[i] + 1]; ys[i] = ny[ns[i]]; rs[i] = nr[ns[i]]; }
    const { ox, oz, s } = polyOffsets(pts);
    const hw = r.width / 2, edge = roadEdge(r);
    const { trimL, trimR } = sideTrim(r, ri, pts, s);
    const P = (i, off, y) => [pts[2 * i] + ox[i] * off, y, pts[2 * i + 1] + oz[i] * off];
    // Ground at a point P(...) of this road.
    const gAt = (p) => T.h(p[0], p[2]);
    let pillarAcc = 11;
    for (let i = 0; i + 1 < n; i++) {
      const cat = c[i];
      if (cat === 'flat') continue;
      const ya = ys[i], yb = ys[i + 1], ra = rs[i], rb = rs[i + 1];
      const segLen = s[i + 1] - s[i];
      if (cat === 'deck') {
        const t = r.cls <= RC.TRUNK ? 1.3 : 0.7;
        if (Math.max(ra, rb) > 0.2) {
          // underside (faces down) and fascia on both edges
          slab.quad(P(i, -edge, ya - t), P(i + 1, -edge, yb - t), P(i + 1, edge, yb - t), P(i, edge, ya - t));
          slab.quad(P(i, -edge, ya - t), P(i + 1, -edge, yb - t), P(i + 1, -edge, yb + LIFT), P(i, -edge, ya + LIFT));
          slab.quad(P(i, edge, ya - t), P(i + 1, edge, yb - t), P(i + 1, edge, yb + LIFT), P(i, edge, ya + LIFT));
        }
        if (Math.min(ra, rb) > 0.45) {
          for (const sd of [-1, 1]) {
            if ((sd < 0 ? trimL : trimR)[i]) continue;
            const off = (edge + 0.15) * sd;
            const A = P(i, off, ya), B = P(i + 1, off, yb);
            if (blocked(A, B, ya, yb, ri)) continue;
            // Local bridges get open railings; highways and ramps jersey barriers.
            if (r.cls >= RC.PRIMARY && r.bridge) addRailing(rails, P(i, off, ya + LIFT), P(i + 1, off, yb + LIFT));
            else addBarrier(walls, P(i, off, ya + LIFT), P(i + 1, off, yb + LIFT), sd, ox[i], oz[i], ox[i + 1], oz[i + 1]);
            out.walls.push([A[0], A[2], B[0], B[2], Math.min(ya, yb) - 0.3, Math.max(ya, yb) + 1.1, 2]);
          }
        }
        // pillars every ~22 m under high decks, off any road below
        pillarAcc += segLen;
        while (pillarAcc >= 22) {
          pillarAcc -= 22;
          const f = Math.max(0, Math.min(1, 1 - pillarAcc / Math.max(segLen, 1e-3)));
          const y = ya + (yb - ya) * f;
          if (ra + (rb - ra) * f < 3.2) continue;
          const offs = edge > 7 ? [-(edge - 2), edge - 2] : [0];
          for (const o of offs) {
            const x = pts[2 * i] + (pts[2 * i + 2] - pts[2 * i]) * f + (ox[i] + (ox[i + 1] - ox[i]) * f) * o;
            const z = pts[2 * i + 1] + (pts[2 * i + 3] - pts[2 * i + 1]) * f + (oz[i] + (oz[i + 1] - oz[i]) * f) * o;
            if (isGroundRoad(x, z)) continue;
            addPillar(slab, x, z, T.h(x, z) - 0.3, y - t, 0.65);
            out.pillars.push([x, z, 0.75, y - t]);
          }
        }
      } else {
        pillarAcc = 11;
      }
      if (cat === 'cut') {
        for (const sd of [-1, 1]) {
          if ((sd < 0 ? trimL : trimR)[i]) continue;
          const off = (edge + 0.3) * sd;
          const A = P(i, off, ya), B = P(i + 1, off, yb);
          const mx = (pts[2 * i] + pts[2 * i + 2]) / 2 + ((ox[i] + ox[i + 1]) / 2) * off;
          const mz = (pts[2 * i + 1] + pts[2 * i + 3]) / 2 + ((oz[i] + oz[i + 1]) / 2) * off;
          const lip = underDeck(mx, mz) ? 0 : PARAPET;
          const topA = gAt(A) + lip, topB = gAt(B) + lip, top = Math.max(topA, topB);
          const L0 = P(i, off - 0.25 * sd, topA), L1 = P(i + 1, off - 0.25 * sd, topB);
          const R0 = P(i, off + 0.25 * sd, topA), R1 = P(i + 1, off + 0.25 * sd, topB);
          for (const [f0, f1, lo, t] of wallPieces(A, B, ya, yb, top, ri)) {
            const y0 = ya + (yb - ya) * f0, y1 = ya + (yb - ya) * f1;
            const t0 = Math.min(t, topA + (topB - topA) * f0), t1 = Math.min(t, topA + (topB - topA) * f1);
            const a = lerpP(A, B, f0), b = lerpP(A, B, f1);
            walls.quad([a[0], Math.max(y0 - 0.3, lo), a[2]], [b[0], Math.max(y1 - 0.3, lo), b[2]], [b[0], t1, b[2]], [a[0], t0, a[2]]);
            if (t === top && lip > 0) walls.quad(lerpP(L0, L1, f0), lerpP(L0, L1, f1), lerpP(R0, R1, f1), lerpP(R0, R1, f0));
            out.walls.push([a[0], a[2], b[0], b[2], Math.max(Math.min(y0, y1) - 0.5, lo), Math.max(t0, t1) + (lip > 0 ? 0 : -0.05), 6]);
          }
        }
        // Opening in the ground mesh: out to the walls, on the terrain surface.
        const w = edge + 0.8, wo = edge + 0.3;
        const corners = [P(i, -wo, 0), P(i, wo, 0), P(i + 1, wo, 0), P(i + 1, -wo, 0)];
        for (const q of corners) q[1] = gAt(q) + 0.03;
        stencil.quad(corners[0], corners[1], corners[2], corners[3]);
        out.footprints.push([P(i, -w, 0), P(i, w, 0), P(i + 1, w, 0), P(i + 1, -w, 0)]);
      } else if (cat === 'tunnel') {
        const wOff = edge + 0.4;
        // Ceiling: CEIL above the road but always just under the ground.
        const under = (k) => Math.min(gAt(P(k, -wOff - 0.9, 0)), gAt(P(k, 0, 0)), gAt(P(k, wOff + 0.9, 0))) - 0.06;
        const ca = Math.min(ya + CEIL, under(i)), cb = Math.min(yb + CEIL, under(i + 1));
        const uv = tunnel.attrs.aUV.buf;
        for (const sd of [-1, 1]) {
          if ((sd < 0 ? trimL : trimR)[i]) continue;
          const off = wOff * sd;
          const A = P(i, off, ya), B = P(i + 1, off, yb);
          const inx = -ox[i] * sd, inz = -oz[i] * sd;
          const top = Math.max(ca, cb);
          for (const [f0, f1, lo, t] of wallPieces(A, B, ya, yb, top, ri)) {
            const y0 = ya + (yb - ya) * f0, y1 = ya + (yb - ya) * f1;
            const c0 = Math.min(ca + (cb - ca) * f0, t), c1 = Math.min(ca + (cb - ca) * f1, t);
            const b0 = Math.max(y0 - 0.3, lo), b1 = Math.max(y1 - 0.3, lo);
            if (Math.min(c0 - b0, c1 - b1) < 0.3) continue;
            const a = lerpP(A, B, f0), b = lerpP(A, B, f1);
            tunnel.quadFacing([a[0], b0, a[2]], [b[0], b1, b[2]], [b[0], c1, b[2]], [a[0], c0, a[2]], inx, 0, inz);
            const s0 = s[i] + (s[i + 1] - s[i]) * f0, s1 = s[i] + (s[i + 1] - s[i]) * f1;
            uv.p2(s0, b0 - y0); uv.p2(s1, b1 - y1); uv.p2(s1, c1 - y1); uv.p2(s0, c0 - y0);
            out.walls.push([a[0], a[2], b[0], b[2], Math.max(Math.min(y0, y1) - 0.5, lo), Math.max(c0, c1), 7]);
          }
        }
        const cw = wOff + 0.9;
        tunnel.quadFacing(P(i, -cw, ca), P(i + 1, -cw, cb), P(i + 1, cw, cb), P(i, cw, ca), 0, -1, 0);
        uv.p2(s[i], 10 - cw); uv.p2(s[i + 1], 10 - cw); uv.p2(s[i + 1], 10 + cw); uv.p2(s[i], 10 + cw);
        // Portal headwall where the tunnel opens into a cut.
        for (const [k, dir] of [[i, -1], [i + 1, 1]]) {
          const J = ns[k];
          const opensHere = (k === i ? i === 0 || c[i - 1] !== 'tunnel' : i + 1 === n - 1 || c[i + 1] !== 'tunnel') && nodeOpen[J];
          if (!opensHere) continue;
          const y = ys[k], cy = Math.min(y + CEIL, under(k));
          const pw = cw + 1.5;
          const a = P(k, -pw, 0), b = P(k, pw, 0);
          a[1] = gAt(a); b[1] = gAt(b);
          // A little set back so it has thickness.
          const tx = (pts[2 * (i + 1)] - pts[2 * i]) / (segLen || 1) * 0.8 * dir, tz = (pts[2 * (i + 1) + 1] - pts[2 * i + 1]) / (segLen || 1) * 0.8 * dir;
          // Solid too, so cars on the ground above can't drive off into the
          // cut, except where a street crosses over the portal.
          for (const [f0, f1, lo] of wallPieces(a, b, a[1], b[1], Math.max(a[1], b[1]) + 0.9, ri)) {
            const p = lerpP(a, b, f0), q = lerpP(a, b, f1), bot = Math.max(cy, lo);
            const pt = p[1] + 0.9, qt = q[1] + 0.9;
            walls.quad([p[0], bot, p[2]], [q[0], bot, q[2]], [q[0], qt, q[2]], [p[0], pt, p[2]]);
            walls.quad([p[0], pt, p[2]], [q[0], qt, q[2]], [q[0] - tx, qt, q[2] - tz], [p[0] - tx, pt, p[2] - tz]);
            out.walls.push([p[0], p[2], q[0], q[2], bot, Math.max(pt, qt), 6]);
          }
        }
      }
    }
  });

  const mk = (b, mat, opts) => { const g = b.build(); if (g) add(meshOf(g, mat, 0, opts)); return g; };
  mk(slab, mats.concrete3d, { shadow: true });
  mk(rails, mats.railing, { shadow: true });
  mk(walls, mats.concrete3d, { shadow: true });
  mk(tunnel, mats.tunnel, { shadow: true, receive: false });

  if (!openings) addGroundMask(stencil, add);
  return out;
}

// Openings in the ground over cuts (road or rail). The land mesh writes depth
// everywhere (that keeps tunnels out of sight); where an opening is visible
// (depth tested, so a hill in front still hides it) mark it in the stencil,
// then push the depth there to the far plane so the cut below shows through.
export function addGroundMask(stencil, add) {
  const sg = stencil.build();
  if (!sg) return;
  const markMat = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, depthTest: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp, stencilZFail: THREE.KeepStencilOp, stencilFail: THREE.KeepStencilOp,
  });
  add(meshOf(sg, markMat, -58, { receive: false }));
  const clearMat = new THREE.ShaderMaterial({
    vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w * 0.99999; }',
    fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }',
    colorWrite: false, depthWrite: true, depthTest: true, depthFunc: THREE.AlwaysDepth,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc, stencilWriteMask: 0x00,
    stencilZPass: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilFail: THREE.KeepStencilOp,
  });
  add(meshOf(sg, clearMat, -57, { receive: false }));
}

const lerpP = (A, B, f) => [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];

function addRailing(b, A, B) {
  // Curb, top rail and posts along A->B (points at deck height).
  const dx = B[0] - A[0], dz = B[2] - A[2], L = Math.hypot(dx, dz) || 1;
  const nx = -dz / L, nz = dx / L;
  const beam = (y0, y1, w, t0 = 0, t1 = 1) => {
    const ax = A[0] + dx * t0, az = A[2] + dz * t0, bx = A[0] + dx * t1, bz = A[2] + dz * t1;
    const ay = A[1] + (B[1] - A[1]) * t0, by = A[1] + (B[1] - A[1]) * t1;
    const p = (x, y, z, s) => [x + nx * w * s, y, z + nz * w * s];
    b.quad(p(ax, ay + y0, az, -1), p(bx, by + y0, bz, -1), p(bx, by + y1, bz, -1), p(ax, ay + y1, az, -1));
    b.quad(p(ax, ay + y0, az, 1), p(bx, by + y0, bz, 1), p(bx, by + y1, bz, 1), p(ax, ay + y1, az, 1));
    b.quad(p(ax, ay + y1, az, -1), p(bx, by + y1, bz, -1), p(bx, by + y1, bz, 1), p(ax, ay + y1, az, 1));
  };
  beam(0, 0.32, 0.16);
  beam(0.9, 1.02, 0.06);
  for (let d = 2; d < L; d += 4.0) {
    const t = d / L, h = 0.06 / L;
    beam(0.3, 0.92, 0.06, t - h, t + h);
  }
}

// Solid concrete parapet (0.95 m) with a sloped inner face, along A->B.
function addBarrier(b, A, B, sd, oxa, oza, oxb, ozb) {
  const o = (pt, ox, oz, d, dy) => [pt[0] + ox * d * sd, pt[1] + dy, pt[2] + oz * d * sd];
  const ai = o(A, oxa, oza, -0.18, 0), bi = o(B, oxb, ozb, -0.18, 0);
  const at = o(A, oxa, oza, 0.05, 0.95), bt = o(B, oxb, ozb, 0.05, 0.95);
  const ao = o(A, oxa, oza, 0.25, 0.95), bo = o(B, oxb, ozb, 0.25, 0.95);
  const ag = o(A, oxa, oza, 0.25, -0.2), bg = o(B, oxb, ozb, 0.25, -0.2);
  b.quad(ai, bi, bt, at);
  b.quad(at, bt, bo, ao);
  b.quad(ao, bo, bg, ag);
}

function addPillar(b, x, z, y0, y1, r) {
  const c = [[-r, -r], [r, -r], [r, r], [-r, r]];
  for (let k = 0; k < 4; k++) {
    const p = c[k], q = c[(k + 1) % 4];
    b.quad([x + p[0], y0, z + p[1]], [x + q[0], y0, z + q[1]], [x + q[0], y1, z + q[1]], [x + p[0], y1, z + p[1]]);
  }
}
