// Builds all static 3D geometry for the map: ground layers, roads, sidewalks,
// crosswalks, rail, buildings, trees, bridge railings and landmark labels.

import * as THREE from 'three';
import earcut from '../vendor/earcut.js';
import { RC, AREA, SIDEWALK_W, hasSidewalk } from './mapdata.js';
import * as MAT from './materials.js';
import { hash32, nextFrame } from './util.js';
import { GeoBuilder, rgb, crossY, addPolygon, polyOffsets, ribbon, meshOf, roofPlan } from './geom.js';
import { buildStructures, segCategory, LIFT } from './structures.js';
import { buildLandmarks } from './landmarks.js';

export const LAND_COLOR = 0xb7b2a3;
const AREA_COLORS = {
  [AREA.PARK]: 0x76a650, [AREA.GRASS]: 0x86b25c, [AREA.PITCH]: 0x5f9f45, [AREA.GOLF]: 0x84bd5e,
  [AREA.CEMETERY]: 0x83a06b, [AREA.WOOD]: 0x5a8a40, [AREA.PLAYGROUND]: 0xc4ae86, [AREA.TRACK]: 0xa65a45,
  [AREA.SAND]: 0xe0cf9c, [AREA.WETLAND]: 0x7c9c6c, [AREA.GARDEN]: 0x7fb05a, [AREA.RAILYARD]: 0x958a7e, [AREA.DIRT]: 0xa8714a,
  [AREA.PARKING]: 0x87878a, [AREA.PLAZA]: 0xc8c0b2, [AREA.PIER]: 0x9b8a72, [AREA.FUEL]: 0x8c8c8e,
};
const PATH_COLORS = [0xd3c6a6, 0xcbc2b3, 0xa3a7a7, 0xb39f7b];
const CHUNK = 300;

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
  mats.concrete3d = MAT.makeFlatProp(0x9f9c95, { side: THREE.DoubleSide });
  mats.railing = MAT.makeFlatProp(0xb9bcbf, { side: THREE.DoubleSide, metalness: 0.3, roughness: 0.6 });
  mats.road3d = MAT.as3D(MAT.makeRoadMaterial());
  mats.roadTunnel = MAT.as3D(MAT.makeRoadMaterial({ tunnel: true }));
  mats.sidewalk3d = MAT.as3D(MAT.makeSidewalkMaterial());
  mats.rail3d = MAT.as3D(MAT.makeRailMaterial());
  mats.tunnel = MAT.makeTunnelMaterial();

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
    const rail3 = new GeoBuilder({ aUV: [Float32Array, 2, false] });
    const deck = new GeoBuilder({});
    for (const r of map.rail) {
      if (!r.ys) { ribbon(rail, r.pts, 1.45, 0, (u, s) => rail.attrs.aUV.buf.p2(u, s)); continue; }
      ribbon(rail3, r.pts, 1.45, LIFT, (u, s, seg, tb) => tb.attrs.aUV.buf.p2(u, s), null, null, null, r.ys);
      // simple slab under raised track
      const { ox, oz } = polyOffsets(r.pts);
      for (let i = 0; i + 1 < r.pts.length / 2; i++) {
        const ya = r.ys[i], yb = r.ys[i + 1];
        if (Math.max(ya, yb) < 0.3) continue;
        const P = (k, o, y) => [r.pts[2 * k] + ox[k] * o, y, r.pts[2 * k + 1] + oz[k] * o];
        for (const o of [-1.7, 1.7]) deck.quad(P(i, o, ya - 0.9), P(i + 1, o, yb - 0.9), P(i + 1, o, yb + LIFT), P(i, o, ya + LIFT));
        deck.quad(P(i, -1.7, ya - 0.9), P(i + 1, -1.7, yb - 0.9), P(i + 1, 1.7, yb - 0.9), P(i, 1.7, ya - 0.9));
      }
    }
    add(meshOf(rail.build(), mats.rail, -36));
    const g3 = rail3.build();
    if (g3) add(meshOf(g3, mats.rail3d, 0));
    const gd = deck.build();
    if (gd) add(meshOf(gd, mats.concrete3d, 0, { shadow: true }));
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
  const ny = map.nodeY;
  {
    const roadAttrs = () => ({ aUV: [Float32Array, 2, false], aRoad: [Float32Array, 4, false], aMark: [Uint8Array, 1, false] });
    const sideAttrs = () => ({ aUV: [Float32Array, 2, false], aSide: [Float32Array, 1, false] });
    const road = new GeoBuilder(roadAttrs()), road3 = new GeoBuilder(roadAttrs()), roadT = new GeoBuilder(roadAttrs());
    const side = new GeoBuilder(sideAttrs()), side3 = new GeoBuilder(sideAttrs());
    // Small roads first so bigger roads paint over them at junctions.
    const order = map.roads.slice().sort((a, b) => b.cls - a.cls);
    for (const r of order) {
      const base = roadPts(r);
      const baseY = Float32Array.from(r.nodes, (n) => ny[n]);
      const catOf = (ya, yb) => segCategory(r, ya, yb);
      const baseCats = [];
      for (let i = 0; i + 1 < r.nodes.length; i++) baseCats.push(catOf(baseY[i], baseY[i + 1]));
      const { prev, next } = endNeighbours(r);
      const hw = r.width / 2;
      if (hasSidewalk(r)) {
        const sw = (u, s, seg, tb) => { tb.attrs.aUV.buf.p2(u, s); tb.attrs.aSide.buf.p1(hw); };
        ribbon((i) => (baseCats[i] === 'flat' ? side : null), base, hw + SIDEWALK_W, 0, sw, prev, next);
        // Raised sidewalk strips on 3D roads (a full-width ribbon would z-fight the road).
        const strip = (i) => (baseCats[i] === 'flat' ? null : side3);
        emitStrips(strip, base, baseY, hw, hw + SIDEWALK_W, LIFT + 0.12, sw, prev, next);
      }
      // Insert cut points around junctions so paint can stop cleanly.
      const style = markStyle(r);
      let pts = base, ptsY = baseY, marks = null;
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
        const out = [], outY = [];
        let c = 0;
        for (let i = 0; i < ns.length; i++) {
          if (i > 0) {
            while (c < cuts.length && cuts[c] < sAt[i]) {
              if (cuts[c] > sAt[i - 1]) {
                const t = (cuts[c] - sAt[i - 1]) / (sAt[i] - sAt[i - 1]);
                out.push(base[2 * i - 2] + (base[2 * i] - base[2 * i - 2]) * t, base[2 * i - 1] + (base[2 * i + 1] - base[2 * i - 1]) * t);
                outY.push(baseY[i - 1] + (baseY[i] - baseY[i - 1]) * t);
              }
              c++;
            }
          }
          out.push(base[2 * i], base[2 * i + 1]);
          outY.push(baseY[i]);
        }
        pts = Float32Array.from(out);
        ptsY = Float32Array.from(outY);
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
      const pick = (i) => {
        const c = catOf(ptsY[i], ptsY[i + 1]);
        return c === 'flat' ? road : c === 'tunnel' ? roadT : road3;
      };
      const lifted = Float32Array.from(ptsY, (y, i) => y);
      ribbon(pick, pts, hw, 0, (u, s, seg, tb) => {
        tb.attrs.aUV.buf.p2(u, s);
        tb.attrs.aRoad.buf.p4(hw, r.lanes, style, r.shoulder);
        tb.attrs.aMark.buf.p1(marks ? marks[seg] : 0);
      }, prev, next, null, liftNonFlat(lifted, (i) => pick(i) !== road));
    }
    add(meshOf(side.build(), mats.sidewalk, -32));
    add(meshOf(road.build(), mats.road, -30));
    const g3 = road3.build();
    if (g3) add(meshOf(g3, mats.road3d, 0));
    const gt = roadT.build();
    if (gt) add(meshOf(gt, mats.roadTunnel, 0, { receive: false }));
    const gs = side3.build();
    if (gs) add(meshOf(gs, mats.sidewalk3d, 0));
  }
  // ------------------------------------------------- bridges / tunnels
  world.structures = buildStructures(map, graph, mats, add, {
    isGroundRoad: (x, z) => {
      const hit = graph.nearestRoad(x, z, 12);
      if (!hit) return false;
      const rd = map.roads[hit.road];
      const a = rd.nodes[hit.seg], b = rd.nodes[hit.seg + 1];
      const y = ny[a] + (ny[b] - ny[a]) * hit.t;
      return y < 2 && hit.dist < rd.width / 2 + SIDEWALK_W + 1.5;
    },
  });
  // ---------------------------------------------------- crosswalks
  {
    const cw = new GeoBuilder({ aUV: [Float32Array, 2, false] });
    for (const c of map.crossings) ribbon(cw, c, 1.5, 0, (u, s) => cw.attrs.aUV.buf.p2(u, s));
    add(meshOf(cw.build(), mats.crosswalk, -28));
  }
  progress(0.3, 'Raising buildings');
  await nextFrame();
  // Landmarks get custom textures/props; the generic builder skips them.
  world.landmarks = buildLandmarks(map, add);
  const skip = world.landmarks.handled, wallsDone = world.landmarks.wallsOnly;

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
    if (bd.hidden || skip.has(bi - 1)) continue;
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
    const bot = bd.minH;
    const top = bd.h;
    const plan = roofPlan(bd);
    const wallTop = plan.wallTop;
    const skipWalls = wallsDone.has(bi - 1);
    const col = b.attrs.color.buf, info = b.attrs.aInfo.buf, nrm = b.attrs.normal.buf;
    // walls
    for (const r of skipWalls ? [] : bd.rings) {
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1];
        if (ax === bx && az === bz) continue;
        const base = b.vcount;
        b.pos.p3(ax, bot, az); b.pos.p3(bx, bot, bz); b.pos.p3(bx, wallTop, bz); b.pos.p3(ax, wallTop, az);
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
    const tagged = plan.kind === 'pitched';
    const pitched = tagged || (plan.kind === 'flat' && bd.rings.length === 1 && n0 <= 12 && top < 16 && area < 320 && bot < 1 && style === 2 && (hsh >> 20) % 10 < 7);
    const roofCol = rgb(bd.roof >= 0 ? bd.roof : (pitched ? ROOF_PITCH : ROOF_FLAT)[(hsh >> 4) % 6]);
    if (plan.kind === 'dome') {
      addDomeRoof(b, outer, wallTop, plan.rh, roofCol, seed);
    } else if (pitched) {
      // Tagged roofs: OSM height includes the roof, so it starts at wallTop.
      const rh = tagged ? plan.rh : Math.min(3.6, Math.max(1.6, Math.sqrt(area) * 0.32));
      addPitchedRoof(b, outer, tagged ? wallTop : top, rh, roofCol, seed);
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
  const waterAt = makeWaterTest(map);
  for (const r of map.roads) {
    if (!r.bridge || r.cls > RC.TRUNK || /Leverett/.test(r.name) || (r.name && !/Fitzgerald|93/.test(r.name))) continue;
    // Sample the stretches over the Charles every 5 m.
    for (let i = 0; i + 1 < r.nodes.length; i++) {
      const a = r.nodes[i], b = r.nodes[i + 1];
      const ax = nodes[2 * a], az = nodes[2 * a + 1], bx = nodes[2 * b], bz = nodes[2 * b + 1];
      const L = Math.hypot(bx - ax, bz - az);
      for (let d = 0; d < L; d += 5) {
        const x = ax + ((bx - ax) * d) / L, z = az + ((bz - az) * d) / L;
        if (Math.hypot(x - cx0, z - cz0) < 260 && waterAt(x, z)) pts.push([x, z, map.nodeY[a] + ((map.nodeY[b] - map.nodeY[a]) * d) / L]);
      }
    }
  }
  if (pts.length < 10) return;
  const deckY = pts.reduce((s2, p) => s2 + p[2], 0) / pts.length;
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
    const apexY = 62 + deckY, topY = 90 + deckY;
    const footL = V(tx - px * half, 0, tz - pz * half), footR = V(tx + px * half, 0, tz + pz * half);
    const apex = V(tx, apexY, tz);
    beam(footL, apex, 2.6);
    beam(footR, apex, 2.6);
    beam(apex, V(tx, topY, tz), 2.2);
    beam(V(tx - px * half * 0.62, deckY - 1.5, tz - pz * half * 0.62), V(tx + px * half * 0.62, deckY - 1.5, tz + pz * half * 0.62), 2.2);
    // Cable fans toward the main span and the back span, to both deck edges.
    for (let k = 1; k <= 9; k++) {
      const y = apexY - deckY + 2 + k * 2.6;
      for (const dir of [-1, 1]) {
        const dist = 12 + k * 11;
        for (const e of [-1, 1]) {
          const dx = tx + ax * dir * dist + px * e * (half - 3), dz = tz + az * dir * dist + pz * e * (half - 3);
          cable.push(tx, y + deckY, tz, dx, deckY + 0.8, dz);
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

// Lift the vertices of non-flat segments by LIFT (keeps 3D roads above the ground mask).
function liftNonFlat(ys, isNonFlat) {
  const out = Float32Array.from(ys);
  for (let i = 0; i + 1 < ys.length; i++) if (isNonFlat(i)) { out[i] = ys[i] + LIFT; out[i + 1] = ys[i + 1] + LIFT; }
  return out;
}

// Two strips (left/right) between lateral offsets u0..u1 along a polyline with heights.
function emitStrips(pick, pts, ys, u0, u1, lift, perVertex, prev, next) {
  const { ox, oz, s, n } = polyOffsets(pts, prev, next);
  for (let i = 0; i + 1 < n; i++) {
    const tb = pick(i);
    if (!tb) continue;
    for (const sd of [-1, 1]) {
      const base = tb.vcount;
      const corners = sd < 0 ? [[i, -u1], [i, -u0], [i + 1, -u0], [i + 1, -u1]] : [[i, u0], [i, u1], [i + 1, u1], [i + 1, u0]];
      for (const [k, u] of corners) {
        tb.pos.p3(pts[2 * k] + ox[k] * u, ys[k] + lift, pts[2 * k + 1] + oz[k] * u);
        perVertex(u, s[k], i, tb);
      }
      tb.idx.p3(base, base + 1, base + 2);
      tb.idx.p3(base, base + 2, base + 3);
    }
  }
}

// Point-in-water test from the map polygons (sea = outside land, plus rivers/ponds).
function makeWaterTest(map) {
  const bbox = (rings) => {
    const r = rings[0];
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let i = 0; i < r.length; i += 2) { a = Math.min(a, r[i]); c = Math.max(c, r[i]); b = Math.min(b, r[i + 1]); d = Math.max(d, r[i + 1]); }
    return [a, b, c, d];
  };
  const inPoly = (x, z, rings) => {
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const zi = r[i + 1], zj = r[j + 1];
        if ((zi > z) !== (zj > z) && x < ((r[j] - r[i]) * (z - zi)) / (zj - zi) + r[i]) inside = !inside;
      }
    }
    return inside;
  };
  const land = map.land.map((p) => [p, bbox(p)]), water = map.water.map((p) => [p, bbox(p)]);
  const hit = (list, x, z) => list.some(([p, bb]) => x >= bb[0] && x <= bb[2] && z >= bb[1] && z <= bb[3] && inPoly(x, z, p));
  return (x, z) => hit(water, x, z) || !hit(land, x, z);
}

// Dome roof (OSM roof:shape=dome/onion): rings of the footprint shrinking to the top.
function addDomeRoof(b, ring, base, h, col, seed) {
  const n = ring.length / 2;
  const c = b.attrs.color.buf, info = b.attrs.aInfo.buf, nrm = b.attrs.normal.buf;
  let cx = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += ring[2 * i]; cz += ring[2 * i + 1]; }
  cx /= n; cz /= n;
  const STEPS = 6;
  const rows = [];
  for (let k = 0; k <= STEPS; k++) {
    const a = (k / STEPS) * Math.PI / 2;
    const s = Math.cos(a), y = base + Math.sin(a) * h;
    const row = [];
    for (let i = 0; i < n; i++) {
      const x = cx + (ring[2 * i] - cx) * s, z = cz + (ring[2 * i + 1] - cz) * s;
      b.pos.p3(x, y, z); c.p3(col[0], col[1], col[2]); info.p2(4, seed);
      const nx = (ring[2 * i] - cx), nz = (ring[2 * i + 1] - cz), l = Math.hypot(nx, nz) || 1;
      nrm.p3(Math.round((nx / l) * Math.cos(a) * 127), Math.round(Math.sin(a) * 127), Math.round((nz / l) * Math.cos(a) * 127));
      row.push(b.vcount - 1);
    }
    rows.push(row);
  }
  for (let k = 0; k < STEPS; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a0 = rows[k][i], a1 = rows[k][j], b0 = rows[k + 1][i], b1 = rows[k + 1][j];
      b.idx.p3(a0, a1, b1); b.idx.p3(a0, b1, b0);
    }
  }
}
