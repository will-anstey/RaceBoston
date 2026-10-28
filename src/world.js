// Builds all static 3D geometry for the map: ground layers, roads, sidewalks,
// crosswalks, rail, buildings, trees, bridge railings and landmark labels.

import * as THREE from 'three';
import earcut from '../vendor/earcut.js';
import { RC, AREA, SIDEWALK_W, hasSidewalk } from './mapdata.js';
import * as MAT from './materials.js';
import { hash32, hash01, mulberry32, nextFrame } from './util.js';

export const LAND_COLOR = 0xb7b2a3;
const AREA_COLORS = {
  [AREA.PARK]: 0x76a650, [AREA.GRASS]: 0x86b25c, [AREA.PITCH]: 0x5f9f45, [AREA.GOLF]: 0x84bd5e,
  [AREA.CEMETERY]: 0x83a06b, [AREA.WOOD]: 0x5a8a40, [AREA.PLAYGROUND]: 0xc4ae86, [AREA.TRACK]: 0xa65a45,
  [AREA.SAND]: 0xe0cf9c, [AREA.WETLAND]: 0x7c9c6c, [AREA.GARDEN]: 0x7fb05a, [AREA.RAILYARD]: 0x958a7e,
  [AREA.PARKING]: 0x87878a, [AREA.PLAZA]: 0xc8c0b2, [AREA.PIER]: 0x9b8a72, [AREA.FUEL]: 0x8c8c8e,
};
const PATH_COLORS = [0xd3c6a6, 0xcbc2b3, 0xa3a7a7, 0xb39f7b];
const CHUNK = 300;

// ------------------------------------------------------------ buffers
class Buf {
  constructor(Type = Float32Array, n = 4096) { this.T = Type; this.a = new Type(n); this.n = 0; }
  grow(k) {
    if (this.n + k <= this.a.length) return;
    let len = this.a.length * 2;
    while (len < this.n + k) len *= 2;
    const b = new this.T(len);
    b.set(this.a);
    this.a = b;
  }
  p1(a) { this.grow(1); this.a[this.n++] = a; }
  p2(a, b) { this.grow(2); const A = this.a; A[this.n++] = a; A[this.n++] = b; }
  p3(a, b, c) { this.grow(3); const A = this.a; A[this.n++] = a; A[this.n++] = b; A[this.n++] = c; }
  p4(a, b, c, d) { this.grow(4); const A = this.a; A[this.n++] = a; A[this.n++] = b; A[this.n++] = c; A[this.n++] = d; }
  view() { return this.a.slice(0, this.n); }
}

class GeoBuilder {
  constructor(attrs) {
    this.pos = new Buf(Float32Array);
    this.idx = new Buf(Uint32Array);
    this.attrs = {};
    for (const [name, [Type, size, normalized]] of Object.entries(attrs || {})) this.attrs[name] = { buf: new Buf(Type), size, normalized };
  }
  get vcount() { return this.pos.n / 3; }
  build() {
    if (!this.pos.n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.view(), 3));
    for (const [name, a] of Object.entries(this.attrs)) g.setAttribute(name, new THREE.BufferAttribute(a.buf.view(), a.size, a.normalized));
    g.setIndex(new THREE.BufferAttribute(this.idx.view(), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const crossY = (ax, az, bx, bz, cx, cz) => (bz - az) * (cx - ax) - (bx - ax) * (cz - az);

// Triangulate a polygon (Float32Array rings) into a builder at height y.
function addPolygon(b, rings, y, color) {
  const flat = [];
  const holes = [];
  for (let k = 0; k < rings.length; k++) {
    if (k) holes.push(flat.length / 2);
    const r = rings[k];
    for (let i = 0; i < r.length; i++) flat.push(r[i]);
  }
  const tri = earcut(flat, holes.length ? holes : null, 2);
  if (!tri.length) return;
  const base = b.vcount;
  const n = flat.length / 2;
  const [cr, cg, cb] = rgb(color);
  const col = b.attrs.color.buf;
  for (let i = 0; i < n; i++) {
    b.pos.p3(flat[2 * i], y, flat[2 * i + 1]);
    col.p3(cr, cg, cb);
  }
  for (let i = 0; i < tri.length; i += 3) {
    let a = tri[i], c1 = tri[i + 1], c2 = tri[i + 2];
    if (crossY(flat[2 * a], flat[2 * a + 1], flat[2 * c1], flat[2 * c1 + 1], flat[2 * c2], flat[2 * c2 + 1]) < 0) [c1, c2] = [c2, c1];
    b.idx.p3(base + a, base + c1, base + c2);
  }
}

// Computes mitred unit offsets (pointing right of travel) for a polyline.
function polyOffsets(pts, prev, next) {
  const n = pts.length / 2;
  const ox = new Float32Array(n), oz = new Float32Array(n), s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let ix = 0, iz = 0, jx = 0, jz = 0, hasIn = false, hasOut = false;
    if (i > 0) { ix = pts[2 * i] - pts[2 * i - 2]; iz = pts[2 * i + 1] - pts[2 * i - 1]; hasIn = true; }
    else if (prev) { ix = pts[0] - prev[0]; iz = pts[1] - prev[1]; hasIn = true; }
    if (i < n - 1) { jx = pts[2 * i + 2] - pts[2 * i]; jz = pts[2 * i + 3] - pts[2 * i + 1]; hasOut = true; }
    else if (next) { jx = next[0] - pts[2 * i]; jz = next[1] - pts[2 * i + 1]; hasOut = true; }
    let li = Math.hypot(ix, iz), lj = Math.hypot(jx, jz);
    if (!hasIn || li < 1e-6) { ix = jx; iz = jz; li = lj; }
    if (!hasOut || lj < 1e-6) { jx = ix; jz = iz; lj = li; }
    if (li < 1e-6) { ix = 1; iz = 0; li = 1; jx = 1; jz = 0; lj = 1; }
    ix /= li; iz /= li; jx /= lj; jz /= lj;
    const n1x = -iz, n1z = ix, n2x = -jz, n2z = jx;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-4) { mx = n2x; mz = n2z; } else { mx /= ml; mz /= ml; }
    const scale = 1 / Math.max(0.4, mx * n2x + mz * n2z);
    ox[i] = mx * scale; oz[i] = mz * scale;
    if (i > 0) s[i] = s[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  }
  return { ox, oz, s, n };
}

// Emits a flat ribbon: one quad per segment; perVertex(builder, side, s, segIndex) adds attributes.
function ribbon(b, pts, hw, y, perVertex, prev, next, segFilter) {
  if (pts.length < 4) return;
  const { ox, oz, s, n } = polyOffsets(pts, prev, next);
  for (let i = 0; i + 1 < n; i++) {
    if (segFilter && !segFilter(i)) continue;
    const base = b.vcount;
    for (const [k, side] of [[i, -1], [i, 1], [i + 1, 1], [i + 1, -1]]) {
      b.pos.p3(pts[2 * k] + ox[k] * hw * side, y, pts[2 * k + 1] + oz[k] * hw * side);
      perVertex(side * hw, s[k], i);
    }
    b.idx.p3(base, base + 1, base + 2);
    b.idx.p3(base, base + 2, base + 3);
  }
}

function meshOf(geo, mat, order, { shadow = false, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = order;
  m.castShadow = shadow;
  m.receiveShadow = receive;
  m.matrixAutoUpdate = false;
  m.updateMatrix();
  return m;
}

// =====================================================================
export async function buildWorld(map, graph, scene, progress = () => {}) {
  const world = {
    group: new THREE.Group(),
    buildingChunks: [],
    treeChunks: [],
    labels: [],
    railSegments: [],
    materials: {},
  };
  world.group.name = 'world';
  scene.add(world.group);
  const add = (m) => { if (m) world.group.add(m); return m; };
  const nodes = map.nodes;
  const play = map.meta.play;
  const wb = map.meta.water;

  const mats = world.materials;
  mats.ground = MAT.flatLayer(MAT.makeGroundMaterial(), 0);
  mats.water = MAT.flatLayer(MAT.makeWaterMaterial(), 0);
  mats.road = MAT.flatLayer(MAT.makeRoadMaterial(), 0);
  mats.sidewalk = MAT.flatLayer(MAT.makeSidewalkMaterial(), 0);
  mats.crosswalk = MAT.flatLayer(MAT.makeCrosswalkMaterial(), 0);
  mats.rail = MAT.flatLayer(MAT.makeRailMaterial(), 0);
  mats.building = MAT.makeBuildingMaterial();
  mats.tree = MAT.makeVertexColorMaterial({ name: 'tree', roughness: 0.95 });
  mats.concrete = MAT.makeFlatProp(0xa9a7a0);
  mats.railing = MAT.makeFlatProp(0xb9bcbf, { side: THREE.DoubleSide, metalness: 0.3, roughness: 0.6 });

  // ---------------------------------------------------- base planes
  {
    const outer = new GeoBuilder({ color: [Uint8Array, 3, true] });
    const S = 40000;
    addPolygon(outer, [Float32Array.from([-S, S, S, S, S, -S, -S, -S])], 0, LAND_COLOR);
    add(meshOf(outer.build(), mats.ground, -60));
    const sea = new GeoBuilder({});
    sea.pos.p3(wb.minX, 0, wb.minZ); sea.pos.p3(wb.maxX, 0, wb.minZ); sea.pos.p3(wb.maxX, 0, wb.maxZ); sea.pos.p3(wb.minX, 0, wb.maxZ);
    sea.idx.p3(0, 3, 2); sea.idx.p3(0, 2, 1);
    add(meshOf(sea.build(), mats.water, -55));
  }
  // ------------------------------------------------------- land
  {
    const land = new GeoBuilder({ color: [Uint8Array, 3, true] });
    for (const p of map.land) addPolygon(land, p, 0, LAND_COLOR);
    add(meshOf(land.build(), mats.ground, -50));
  }
  progress(0.05, 'Laying out parks');
  await nextFrame();
  // ------------------------------------------------------ areas
  {
    const areas = new GeoBuilder({ color: [Uint8Array, 3, true] });
    const piers = new GeoBuilder({ color: [Uint8Array, 3, true] });
    for (const a of map.areas) {
      const col = AREA_COLORS[a.type] ?? 0x999999;
      addPolygon(a.type === AREA.PIER ? piers : areas, a.rings, 0, col);
    }
    for (const p of map.piers) {
      const pc = rgb(AREA_COLORS[AREA.PIER]);
      ribbon(piers, p.pts, p.width / 2, 0, () => piers.attrs.color.buf.p3(...pc));
    }
    add(meshOf(areas.build(), mats.ground, -45));
    const water = new GeoBuilder({});
    for (const p of map.water) {
      const flat = [], holes = [];
      p.forEach((r, k) => { if (k) holes.push(flat.length / 2); for (const v of r) flat.push(v); });
      const tri = earcut(flat, holes.length ? holes : null, 2);
      const base = water.vcount;
      for (let i = 0; i < flat.length; i += 2) water.pos.p3(flat[i], 0, flat[i + 1]);
      for (let i = 0; i < tri.length; i += 3) {
        let a = tri[i], b = tri[i + 1], c = tri[i + 2];
        if (crossY(flat[2 * a], flat[2 * a + 1], flat[2 * b], flat[2 * b + 1], flat[2 * c], flat[2 * c + 1]) < 0) [b, c] = [c, b];
        water.idx.p3(base + a, base + b, base + c);
      }
    }
    add(meshOf(water.build(), mats.water, -40));
    add(meshOf(piers.build(), mats.ground, -38));
  }

  // ------------------------------------------------------- rail
  {
    const rail = new GeoBuilder({ aUV: [Float32Array, 2, false] });
    for (const r of map.rail) ribbon(rail, r.pts, 1.45, 0, (u, s) => rail.attrs.aUV.buf.p2(u, s));
    add(meshOf(rail.build(), mats.rail, -36));
  }
  // ------------------------------------------------------- paths
  {
    const paths = new GeoBuilder({ color: [Uint8Array, 3, true] });
    for (const p of map.paths) {
      const c = rgb(PATH_COLORS[p.cls] ?? PATH_COLORS[0]);
      ribbon(paths, p.pts, p.width / 2, 0, () => paths.attrs.color.buf.p3(c[0], c[1], c[2]));
    }
    add(meshOf(paths.build(), mats.ground, -34));
  }
  progress(0.15, 'Paving roads');
  await nextFrame();

  // ------------------------------------------------------- roads
  // Junction trim: no lane paint within this distance of intersections.
  const nodeHW = new Float32Array(nodes.length / 2);
  for (const r of map.roads) for (const n of r.nodes) nodeHW[n] = Math.max(nodeHW[n], r.width / 2);
  const deg = graph.deg;
  // Neighbour lookup for smooth mitres where two ways join end-to-end.
  const neighbourOf = (node, exclude) => {
    for (let k = graph.adjStart[node]; k < graph.adjStart[node + 1]; k++) {
      const v = graph.eTo[graph.adj[k]];
      if (v !== exclude) return v;
    }
    return -1;
  };
  const roadPts = (r) => {
    const a = new Float32Array(r.nodes.length * 2);
    for (let i = 0; i < r.nodes.length; i++) { a[2 * i] = nodes[2 * r.nodes[i]]; a[2 * i + 1] = nodes[2 * r.nodes[i] + 1]; }
    return a;
  };
  const endNeighbours = (r) => {
    const ns = r.nodes, k = ns.length;
    let prev = null, next = null;
    if (deg[ns[0]] === 2) {
      const v = neighbourOf(ns[0], ns[1]);
      if (v >= 0) prev = [nodes[2 * v], nodes[2 * v + 1]];
    }
    if (deg[ns[k - 1]] === 2) {
      const v = neighbourOf(ns[k - 1], ns[k - 2]);
      if (v >= 0) next = [nodes[2 * v], nodes[2 * v + 1]];
    }
    return { prev, next };
  };
  const markStyle = (r) => {
    if (r.cls >= RC.LIVING) return 0;
    if (r.cls === RC.RESIDENTIAL) return r.lanes >= 2 && !r.oneway && r.width > 9 ? 1 : 0;
    if (r.link) return r.cls <= RC.TRUNK ? 3 : 0;
    if (r.oneway) return r.cls <= RC.TRUNK ? 3 : r.lanes >= 2 ? 2 : 0;
    return r.cls <= RC.TRUNK ? 4 : 1;
  };
  {
    const road = new GeoBuilder({ aUV: [Float32Array, 2, false], aRoad: [Float32Array, 4, false], aMark: [Uint8Array, 1, false] });
    const side = new GeoBuilder({ aUV: [Float32Array, 2, false], aSide: [Float32Array, 1, false] });
    // Small roads first so bigger roads paint over them at junctions.
    const order = map.roads.slice().sort((a, b) => b.cls - a.cls);
    for (const r of order) {
      const base = roadPts(r);
      const { prev, next } = endNeighbours(r);
      const hw = r.width / 2;
      if (hasSidewalk(r)) {
        ribbon(side, base, hw + SIDEWALK_W, 0, (u, s) => { side.attrs.aUV.buf.p2(u, s); side.attrs.aSide.buf.p1(hw); }, prev, next);
      }
      // Insert cut points around junctions so paint can stop cleanly.
      const style = markStyle(r);
      let pts = base, marks = null;
      if (style) {
        const ns = r.nodes;
        const sAt = [0];
        for (let i = 1; i < ns.length; i++) sAt.push(sAt[i - 1] + Math.hypot(base[2 * i] - base[2 * i - 2], base[2 * i + 1] - base[2 * i - 1]));
        const L = sAt[sAt.length - 1];
        const zones = [];
        for (let i = 0; i < ns.length; i++) {
          if (deg[ns[i]] >= 3 || (deg[ns[i]] === 2 && (i === 0 || i === ns.length - 1) && nodeHW[ns[i]] > hw + 1)) {
            const trim = nodeHW[ns[i]] + 2.0;
            zones.push([sAt[i] - trim, sAt[i] + trim]);
          }
        }
        const cuts = [];
        for (const [a, b] of zones) { if (a > 0 && a < L) cuts.push(a); if (b > 0 && b < L) cuts.push(b); }
        cuts.sort((a, b) => a - b);
        const out = [];
        let c = 0;
        for (let i = 0; i < ns.length; i++) {
          if (i > 0) {
            while (c < cuts.length && cuts[c] < sAt[i]) {
              if (cuts[c] > sAt[i - 1]) {
                const t = (cuts[c] - sAt[i - 1]) / (sAt[i] - sAt[i - 1]);
                out.push(base[2 * i - 2] + (base[2 * i] - base[2 * i - 2]) * t, base[2 * i - 1] + (base[2 * i + 1] - base[2 * i - 1]) * t);
              }
              c++;
            }
          }
          out.push(base[2 * i], base[2 * i + 1]);
        }
        pts = Float32Array.from(out);
        // Mark per segment of the densified polyline.
        marks = [];
        let s = 0;
        for (let i = 0; i + 1 < pts.length / 2; i++) {
          const len = Math.hypot(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
          const mid = s + len / 2;
          marks.push(zones.some(([a, b]) => mid > a && mid < b) || len < 0.05 ? 0 : 1);
          s += len;
        }
      }
      const ra = road.attrs;
      ribbon(road, pts, hw, 0, (u, s, seg) => {
        ra.aUV.buf.p2(u, s);
        ra.aRoad.buf.p4(hw, r.lanes, style, r.shoulder);
        ra.aMark.buf.p1(marks ? marks[seg] : 0);
      }, prev, next);
    }
    add(meshOf(side.build(), mats.sidewalk, -32));
    add(meshOf(road.build(), mats.road, -30));
  }
  // ---------------------------------------------------- crosswalks
  {
    const cw = new GeoBuilder({ aUV: [Float32Array, 2, false] });
    for (const c of map.crossings) ribbon(cw, c, 1.5, 0, (u, s) => cw.attrs.aUV.buf.p2(u, s));
    add(meshOf(cw.build(), mats.crosswalk, -28));
  }
  progress(0.3, 'Raising buildings');
  await nextFrame();

  // ------------------------------------------------------ buildings
  const chunkKey = (x, z) => Math.floor((x - play.minX) / CHUNK) * 1000 + Math.floor((z - play.minZ) / CHUNK);
  const chunks = new Map();
  const getChunk = (x, z) => {
    const k = chunkKey(x, z);
    let c = chunks.get(k);
    if (!c) {
      c = new GeoBuilder({ color: [Uint8Array, 3, true], aInfo: [Uint8Array, 2, false], normal: [Int8Array, 3, true] });
      chunks.set(k, c);
    }
    return c;
  };
  const ROOF_FLAT = [0x8d8b86, 0x7d7b77, 0x9a9790, 0x6f6e6b, 0xa8a59c, 0x85837c];
  const ROOF_PITCH = [0x5b4a42, 0x4a4f55, 0x6a5444, 0x585a5e, 0x704a3c, 0x3f4247];
  let bi = 0;
  for (const bd of map.buildings) {
    if (++bi % 4000 === 0) { progress(0.3 + 0.45 * (bi / map.buildings.length), 'Raising buildings'); await nextFrame(); }
    if (bd.hidden) continue;
    const outer = bd.rings[0];
    const n0 = outer.length / 2;
    if (n0 < 3) continue;
    let cx = 0, cz = 0;
    for (let i = 0; i < n0; i++) { cx += outer[2 * i]; cz += outer[2 * i + 1]; }
    cx /= n0; cz /= n0;
    const b = getChunk(cx, cz);
    const hsh = hash32(Math.floor(cx * 7.3) * 92821 + Math.floor(cz * 3.1));
    const shade = 0.92 + (hsh % 1000) / 1000 * 0.16;
    const wc = rgb(bd.color).map((v) => Math.min(255, v * shade));
    const seed = (hsh >> 10) & 255;
    const style = bd.style;
    const top = bd.h, bot = bd.minH;
    const col = b.attrs.color.buf, info = b.attrs.aInfo.buf, nrm = b.attrs.normal.buf;
    // walls
    for (const r of bd.rings) {
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1];
        if (ax === bx && az === bz) continue;
        const base = b.vcount;
        b.pos.p3(ax, bot, az); b.pos.p3(bx, bot, bz); b.pos.p3(bx, top, bz); b.pos.p3(ax, top, az);
        const el = Math.hypot(bx - ax, bz - az);
        const wnx = Math.round((-(bz - az) / el) * 127), wnz = Math.round(((bx - ax) / el) * 127);
        for (let k = 0; k < 4; k++) { col.p3(wc[0], wc[1], wc[2]); info.p2(style, seed); nrm.p3(wnx, 0, wnz); }
        b.idx.p3(base, base + 1, base + 2);
        b.idx.p3(base, base + 2, base + 3);
      }
    }
    // roof
    let area = 0;
    for (let i = 0; i < n0; i++) { const j = (i + 1) % n0; area += outer[2 * i] * outer[2 * j + 1] - outer[2 * j] * outer[2 * i + 1]; }
    area = Math.abs(area / 2);
    const pitched = bd.rings.length === 1 && n0 <= 12 && top < 16 && area < 320 && bot < 1 &&
      (bd.pitched || (style === 2 && (hsh >> 20) % 10 < 7));
    const roofCol = rgb(bd.roof >= 0 ? bd.roof : (pitched ? ROOF_PITCH : ROOF_FLAT)[(hsh >> 4) % 6]);
    if (pitched) {
      const rh = Math.min(3.6, Math.max(1.6, Math.sqrt(area) * 0.32));
      addPitchedRoof(b, outer, top, rh, roofCol, seed);
    } else {
      const flat = [], holes = [];
      bd.rings.forEach((r, k) => { if (k) holes.push(flat.length / 2); for (const v of r) flat.push(v); });
      const tri = earcut(flat, holes.length ? holes : null, 2);
      const base = b.vcount;
      for (let i = 0; i < flat.length; i += 2) { b.pos.p3(flat[i], top, flat[i + 1]); col.p3(roofCol[0], roofCol[1], roofCol[2]); info.p2(style, seed); nrm.p3(0, 127, 0); }
      for (let i = 0; i < tri.length; i += 3) {
        let p = tri[i], q = tri[i + 1], s = tri[i + 2];
        if (crossY(flat[2 * p], flat[2 * p + 1], flat[2 * q], flat[2 * q + 1], flat[2 * s], flat[2 * s + 1]) < 0) [q, s] = [s, q];
        b.idx.p3(base + p, base + q, base + s);
      }
      // Bottom face for floating parts (overhangs, skybridges).
      if (bot > 0.5) {
        const base2 = b.vcount;
        for (let i = 0; i < flat.length; i += 2) { b.pos.p3(flat[i], bot, flat[i + 1]); col.p3(wc[0] * 0.7, wc[1] * 0.7, wc[2] * 0.7); info.p2(4, seed); nrm.p3(0, -127, 0); }
        for (let i = 0; i < tri.length; i += 3) {
          let p = tri[i], q = tri[i + 1], s = tri[i + 2];
          if (crossY(flat[2 * p], flat[2 * p + 1], flat[2 * q], flat[2 * q + 1], flat[2 * s], flat[2 * s + 1]) > 0) [q, s] = [s, q];
          b.idx.p3(base2 + p, base2 + q, base2 + s);
        }
      }
    }
  }
  for (const [, b] of chunks) {
    const g = b.build();
    if (!g) continue;
    const m = meshOf(g, mats.building, 0, { shadow: true, receive: true });
    m.userData.center = g.boundingSphere.center.clone();
    m.userData.radius = g.boundingSphere.radius;
    world.buildingChunks.push(m);
    add(m);
  }
  progress(0.78, 'Planting trees');
  await nextFrame();

  // ---------------------------------------------------------- trees
  {
    const treeGeo = makeTreeGeometry();
    const byChunk = new Map();
    const T = map.trees;
    for (let i = 0; i < T.length; i += 2) {
      const k = chunkKey(T[i], T[i + 1]);
      if (!byChunk.has(k)) byChunk.set(k, []);
      byChunk.get(k).push(i);
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const color = new THREE.Color();
    for (const [, list] of byChunk) {
      const im = new THREE.InstancedMesh(treeGeo, mats.tree, list.length);
      list.forEach((i, k) => {
        const x = T[i], z = T[i + 1];
        const h = hash32(Math.floor(x * 10) * 73856093 ^ Math.floor(z * 10) * 19349663);
        const s = 0.7 + ((h & 1023) / 1023) * 0.65;
        const sy = s * (0.85 + (((h >> 10) & 255) / 255) * 0.4);
        q.setFromAxisAngle(up, ((h >> 18) & 255) / 255 * Math.PI * 2);
        im.setMatrixAt(k, m4.compose(p.set(x, 0, z), q, sc.set(s, sy, s)));
        const g = ((h >> 4) & 255) / 255;
        color.setRGB(0.82 + g * 0.3, 0.9 + g * 0.2, 0.75 + g * 0.2);
        im.setColorAt(k, color);
      });
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      im.userData.center = im.boundingSphere.center.clone();
      world.treeChunks.push(im);
      add(im);
    }
  }

  // ----------------------------------------------- bridge railings
  {
    const rb = new GeoBuilder({});
    const fb = new GeoBuilder({});
    for (const r of map.roads) {
      if (!r.rail.length) continue;
      const base = roadPts(r);
      const off = r.width / 2 + (hasSidewalk(r) ? SIDEWALK_W : 0.3) + 0.15;
      const n = base.length / 2;
      const sAt = [0];
      for (let i = 1; i < n; i++) sAt.push(sAt[i - 1] + Math.hypot(base[2 * i] - base[2 * i - 2], base[2 * i + 1] - base[2 * i - 1]));
      for (const [s0, s1] of r.rail) {
        // Extract the sub-polyline between s0 and s1.
        const sub = [];
        const at = (s) => {
          let i = 1;
          while (i < n - 1 && sAt[i] < s) i++;
          const t = Math.min(1, Math.max(0, (s - sAt[i - 1]) / Math.max(1e-6, sAt[i] - sAt[i - 1])));
          return [base[2 * i - 2] + (base[2 * i] - base[2 * i - 2]) * t, base[2 * i - 1] + (base[2 * i + 1] - base[2 * i - 1]) * t];
        };
        sub.push(...at(s0));
        for (let i = 0; i < n; i++) if (sAt[i] > s0 && sAt[i] < s1) sub.push(base[2 * i], base[2 * i + 1]);
        sub.push(...at(s1));
        const pts = Float32Array.from(sub);
        const { ox, oz } = polyOffsets(pts);
        for (const sd of [-1, 1]) {
          const line = [];
          for (let i = 0; i < pts.length / 2; i++) line.push(pts[2 * i] + ox[i] * off * sd, pts[2 * i + 1] + oz[i] * off * sd);
          addRailing(rb, line, sd, fb);
          for (let i = 0; i + 2 < line.length; i += 2) world.railSegments.push([line[i], line[i + 1], line[i + 2], line[i + 3]]);
        }
      }
    }
    const g = rb.build();
    if (g) add(meshOf(g, mats.railing, 0, { shadow: true }));
    const gf = fb.build();
    if (gf) add(meshOf(gf, mats.concrete, 0));
  }

  addZakimTowers(world, map, add);

  // ----------------------------------------------- landmark labels
  for (const lm of map.landmarks) {
    let h = 12;
    for (const bd of map.buildings) {
      const r = bd.rings[0];
      if (bd.h + 10 <= h) continue;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < r.length; i += 2) {
        if (r[i] < minX) minX = r[i]; if (r[i] > maxX) maxX = r[i];
        if (r[i + 1] < minZ) minZ = r[i + 1]; if (r[i + 1] > maxZ) maxZ = r[i + 1];
      }
      if (lm.x >= minX - 15 && lm.x <= maxX + 15 && lm.z >= minZ - 15 && lm.z <= maxZ + 15) h = Math.max(h, bd.h + 10);
    }
    const label = makeLabel(lm.name);
    label.position.set(lm.x, Math.min(h, 120), lm.z);
    label.userData.landmark = lm;
    world.labels.push(label);
    add(label);
  }
  progress(0.9, 'Final touches');
  return world;
}

// The Zakim Bridge deck is in OSM but its cable-stayed towers are not, so
// derive the bridge axis from the I-93 deck over the Charles and add the two
// inverted-Y towers with fanned cables.
function addZakimTowers(world, map, add) {
  const { origin, metersPerDegree: mpd } = map.meta;
  const cx0 = (-71.0617 - origin.lon) * mpd.lon, cz0 = -(42.3686 - origin.lat) * mpd.lat;
  const nodes = map.nodes;
  const pts = [];
  for (const r of map.roads) {
    if (!r.bridge || !r.rail.length || r.cls > RC.TRUNK || /Leverett/.test(r.name) || (r.name && !/Fitzgerald|93/.test(r.name))) continue;
    // Sample the over-water stretches every 5 m.
    let s = 0;
    for (let i = 0; i + 1 < r.nodes.length; i++) {
      const a = r.nodes[i], b = r.nodes[i + 1];
      const ax = nodes[2 * a], az = nodes[2 * a + 1], bx = nodes[2 * b], bz = nodes[2 * b + 1];
      const L = Math.hypot(bx - ax, bz - az);
      for (let d = 0; d < L; d += 5) {
        const sd = s + d;
        if (!r.rail.some(([s0, s1]) => sd >= s0 && sd <= s1)) continue;
        const x = ax + ((bx - ax) * d) / L, z = az + ((bz - az) * d) / L;
        if (Math.hypot(x - cx0, z - cz0) < 260) pts.push([x, z]);
      }
      s += L;
    }
  }
  if (pts.length < 10) return;
  let mx = 0, mz = 0;
  for (const [x, z] of pts) { mx += x; mz += z; }
  mx /= pts.length; mz /= pts.length;
  let sxx = 0, sxz = 0, szz = 0;
  for (const [x, z] of pts) { sxx += (x - mx) ** 2; sxz += (x - mx) * (z - mz); szz += (z - mz) ** 2; }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ax = Math.cos(ang), az = Math.sin(ang);   // bridge axis
  const px = -az, pz = ax;                         // across the deck
  let lo = Infinity, hi = -Infinity;
  for (const [x, z] of pts) { const p = (x - mx) * px + (z - mz) * pz; lo = Math.min(lo, p); hi = Math.max(hi, p); }
  const half = Math.min(28, Math.max(14, (hi - lo) / 2 + 4));
  const mid = (lo + hi) / 2;
  const ccx = mx + px * mid, ccz = mz + pz * mid;
  const mat = MAT.makeFlatProp(0xe8e8e4, { roughness: 0.5 });
  const geos = [];
  const beam = (a, b, w) => {
    const d = new THREE.Vector3().subVectors(b, a);
    const g = new THREE.BoxGeometry(w, d.length(), w);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    geos.push(g.toNonIndexed());
  };
  const cable = [];
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  for (const s of [-1, 1]) {
    const tx = ccx + ax * s * 113, tz = ccz + az * s * 113;
    const apexY = 62, topY = 90;
    const footL = V(tx - px * half, 0, tz - pz * half), footR = V(tx + px * half, 0, tz + pz * half);
    const apex = V(tx, apexY, tz);
    beam(footL, apex, 2.6);
    beam(footR, apex, 2.6);
    beam(apex, V(tx, topY, tz), 2.2);
    beam(V(tx - px * half * 0.55, 24, tz - pz * half * 0.55), V(tx + px * half * 0.55, 24, tz + pz * half * 0.55), 1.6);
    // Cable fans toward the main span and the back span, to both deck edges.
    for (let k = 1; k <= 9; k++) {
      const y = apexY + 2 + k * 2.6;
      for (const dir of [-1, 1]) {
        const dist = 12 + k * 11;
        for (const e of [-1, 1]) {
          const dx = tx + ax * dir * dist + px * e * (half - 3), dz = tz + az * dir * dist + pz * e * (half - 3);
          cable.push(tx, y, tz, dx, 0.8, dz);
        }
      }
    }
  }
  const merged = new THREE.BufferGeometry();
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; }
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.computeBoundingSphere();
  const towers = new THREE.Mesh(merged, mat);
  towers.castShadow = true;
  towers.receiveShadow = true;
  add(towers);
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cable), 3));
  add(new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0xf2f2ee, transparent: true, opacity: 0.85 })));
}

// Bridge railing as an open frame (curb, posts, top rail) plus an outward-only
// fascia below the deck (seen from the deck it would paint over the road).
function addRailing(b, line, sd, fascia) {
  const n = line.length / 2;
  const { ox, oz } = polyOffsets(Float32Array.from(line));
  const quad = (bb, p0, p1, p2, p3, both) => {
    const base = bb.vcount;
    for (const p of [p0, p1, p2, p3]) bb.pos.p3(p[0], p[1], p[2]);
    bb.idx.p3(base, base + 1, base + 2); bb.idx.p3(base, base + 2, base + 3);
    if (both) { bb.idx.p3(base, base + 2, base + 1); bb.idx.p3(base, base + 3, base + 2); }
  };
  // Box spanning a->b (2D) between heights y0..y1 with half-width w (two-sided faces).
  const beam = (ax, az, bx, bz, y0, y1, w) => {
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
    const nx = (-dz / L) * w, nz = (dx / L) * w;
    const A0 = [ax - nx, y0, az - nz], A1 = [ax + nx, y0, az + nz], B0 = [bx - nx, y0, bz - nz], B1 = [bx + nx, y0, bz + nz];
    const A0t = [A0[0], y1, A0[2]], A1t = [A1[0], y1, A1[2]], B0t = [B0[0], y1, B0[2]], B1t = [B1[0], y1, B1[2]];
    quad(b, A1, B1, B1t, A1t, true);
    quad(b, A0, B0, B0t, A0t, true);
    quad(b, A0t, A1t, B1t, B0t, true);
    quad(b, A0, A1, A1t, A0t, true);
    quad(b, B0, B1, B1t, B0t, true);
  };
  let carry = 0;
  for (let i = 0; i + 1 < n; i++) {
    const ax = line[2 * i], az = line[2 * i + 1], bx = line[2 * i + 2], bz = line[2 * i + 3];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.01) continue;
    beam(ax, az, bx, bz, 0, 0.32, 0.16);
    beam(ax, az, bx, bz, 0.9, 1.02, 0.06);
    for (let d = carry; d < L; d += 2.4) {
      const t = d / L;
      const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
      const ux = (bx - ax) / L * 0.06, uz = (bz - az) / L * 0.06;
      beam(px - ux, pz - uz, px + ux, pz + uz, 0.3, 0.92, 0.06);
      carry = d + 2.4 - L;
    }
    // fascia, offset outward and facing outward only
    const o = 0.2 * sd;
    const p0 = [ax + ox[i] * o, -1.8, az + oz[i] * o], p1 = [bx + ox[i + 1] * o, -1.8, bz + oz[i + 1] * o];
    const p2 = [p1[0], 0.02, p1[2]], p3 = [p0[0], 0.02, p0[2]];
    if (sd > 0) quad(fascia, p0, p1, p2, p3, false);
    else quad(fascia, p0, p3, p2, p1, false);
  }
}

// Hip roof for 4-sided footprints, pyramid otherwise.
function addPitchedRoof(b, ring, top, rh, col, seed) {
  const n = ring.length / 2;
  const c = b.attrs.color.buf, info = b.attrs.aInfo.buf, nrm = b.attrs.normal.buf;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += ring[2 * i]; cz += ring[2 * i + 1]; }
  cx /= n; cz /= n;
  const vert = (x, y, z) => { b.pos.p3(x, y, z); c.p3(col[0], col[1], col[2]); info.p2(4, seed); nrm.p3(0, 127, 0); return b.vcount - 1; };
  if (n === 4) {
    const P = (i) => [ring[2 * (i % 4)], ring[2 * (i % 4) + 1]];
    const e0 = Math.hypot(P(1)[0] - P(0)[0], P(1)[1] - P(0)[1]);
    const e1 = Math.hypot(P(2)[0] - P(1)[0], P(2)[1] - P(1)[1]);
    const longFirst = e0 >= e1;
    const [a0, a1] = longFirst ? [P(0), P(1)] : [P(1), P(2)];
    const L = Math.max(e0, e1) / 2, S = Math.min(e0, e1) / 2;
    const ax = (a1[0] - a0[0]) / (2 * L), az = (a1[1] - a0[1]) / (2 * L);
    const k = Math.max(0, L - S);
    const r0 = [cx - ax * k, cz - az * k], r1 = [cx + ax * k, cz + az * k];
    const ridge = [vert(r0[0], top + rh, r0[1]), vert(r1[0], top + rh, r1[1])];
    const nearest = (p) => ((p[0] - r0[0]) ** 2 + (p[1] - r0[1]) ** 2 <= (p[0] - r1[0]) ** 2 + (p[1] - r1[1]) ** 2 ? 0 : 1);
    for (let i = 0; i < 4; i++) {
      const p = P(i), q = P(i + 1);
      const vi = vert(p[0], top, p[1]), vj = vert(q[0], top, q[1]);
      const ni = nearest(p), nj = nearest(q);
      if (ni === nj) b.idx.p3(vi, vj, ridge[ni]);
      else { b.idx.p3(vi, vj, ridge[nj]); b.idx.p3(vi, ridge[nj], ridge[ni]); }
    }
  } else {
    const apex = vert(cx, top + rh, cz);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const vi = vert(ring[2 * i], top, ring[2 * i + 1]), vj = vert(ring[2 * j], top, ring[2 * j + 1]);
      b.idx.p3(vi, vj, apex);
    }
  }
}

function makeTreeGeometry() {
  const parts = [];
  const crown = new THREE.IcosahedronGeometry(2.7, 0);
  crown.scale(1, 1.15, 1);
  crown.translate(0, 5.0, 0);
  const crown2 = new THREE.IcosahedronGeometry(1.9, 0);
  crown2.translate(0.9, 6.6, -0.4);
  const trunk = new THREE.CylinderGeometry(0.18, 0.3, 3.4, 5, 1, true);
  trunk.translate(0, 1.7, 0);
  parts.push([crown, [74, 112, 52]], [crown2, [86, 126, 60]], [trunk, [92, 72, 56]]);
  const pos = [], col = [];
  for (const [g0, c] of parts) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) { pos.push(p[i], p[i + 1], p[i + 2]); col.push(c[0], c[1], c[2]); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(col), 3, true));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function makeLabel(text) {
  const c = document.createElement('canvas');
  const fs = 44;
  const ctx = c.getContext('2d');
  ctx.font = `700 ${fs}px Inter, Segoe UI, Helvetica, Arial, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + 48;
  c.width = w;
  c.height = 84;
  ctx.font = `700 ${fs}px Inter, Segoe UI, Helvetica, Arial, sans-serif`;
  ctx.fillStyle = 'rgba(12,35,64,0.82)';
  const r = 20;
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, 66, r);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w / 2 - 10, 68); ctx.lineTo(w / 2 + 10, 68); ctx.lineTo(w / 2, 82); ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 24, 36);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const s = new THREE.Sprite(mat);
  const scale = 0.11;
  s.scale.set(w * scale, 84 * scale, 1);
  s.center.set(0.5, 0);
  s.renderOrder = 5;
  return s;
}
