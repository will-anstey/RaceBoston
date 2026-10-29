// Converts the raw Overpass downloads in tools/.cache into the compact game
// map at data/boston.json, plus a PNG preview at tools/.cache/preview.png.
//
//   node tools/build-map.mjs
//
// Map data (c) OpenStreetMap contributors, available under the ODbL.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PLAY_BBOX, WATER_BBOX, ORIGIN } from './config.mjs';
import * as G from './geo.mjs';
import { solveElevations, ROAD_FLAGS } from './elevation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '.cache');
const outFile = path.join(here, '..', 'data', 'boston.json');

function load(name) {
  const f = path.join(cacheDir, name + '.json');
  if (!fs.existsSync(f)) {
    console.warn(`!! missing ${name}.json - run tools/fetch-osm.mjs`);
    return [];
  }
  return JSON.parse(fs.readFileSync(f, 'utf8')).elements;
}

// ---------------------------------------------------------------- projection
const phi = (ORIGIN.lat * Math.PI) / 180;
const M_LAT = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
const M_LON = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
const px = (lon) => (lon - ORIGIN.lon) * M_LON;
const pz = (lat) => -(lat - ORIGIN.lat) * M_LAT;
const proj = (g) => [px(g.lon), pz(g.lat)];
const toBox = (b) => ({ minX: px(b.west), maxX: px(b.east), minZ: pz(b.north), maxZ: pz(b.south) });
const PLAY = toBox(PLAY_BBOX);
const WBOX = toBox(WATER_BBOX);
const grow = (b, m) => ({ minX: b.minX - m, maxX: b.maxX + m, minZ: b.minZ - m, maxZ: b.maxZ + m });
const PLAY_M = grow(PLAY, 40);
const inBox = (b, x, z) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
const geoKey = (g) => g.lat.toFixed(7) + ',' + g.lon.toFixed(7);
const r1 = (v) => Math.round(v * 10) / 10;
const flat = (ring) => {
  const a = new Array(ring.length * 2);
  ring.forEach((p, i) => { a[2 * i] = r1(p[0]); a[2 * i + 1] = r1(p[1]); });
  return a;
};
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ----------------------------------------------------- polygons from elements
function polygonsOf(el) {
  if (el.type === 'way') {
    const g = (el.geometry || []).filter(Boolean);
    if (g.length < 4 || geoKey(g[0]) !== geoKey(g[g.length - 1])) return [];
    return [[G.orientOuter(g.slice(0, -1).map(proj))]];
  }
  if (el.type === 'relation') {
    const outers = [], inners = [];
    for (const m of el.members || []) {
      if (m.type !== 'way' || !m.geometry) continue;
      const g = m.geometry.filter(Boolean);
      (m.role === 'inner' ? inners : outers).push(g);
    }
    const oR = G.assembleRings(outers, geoKey).map((r) => G.orientOuter(r.map(proj)));
    const iR = G.assembleRings(inners, geoKey).map((r) => G.orientHole(r.map(proj)));
    const polys = oR.map((o) => [o]);
    for (const h of iR) {
      const owner = polys.find((p) => G.pointInRing(h[0][0], h[0][1], p[0]));
      if (owner) owner.push(h);
    }
    return polys;
  }
  return [];
}

function clipPolygon(poly, box) {
  const bb = G.ringBBox(poly[0]);
  if (!G.bboxOverlap(bb, box)) return null;
  const inside = bb.minX >= box.minX && bb.maxX <= box.maxX && bb.minZ >= box.minZ && bb.maxZ <= box.maxZ;
  if (inside) return poly;
  const outer = G.clipRing(poly[0], box);
  if (outer.length < 3) return null;
  const holes = poly.slice(1).map((h) => G.clipRing(h, box)).filter((h) => h.length >= 3);
  return [outer, ...holes];
}

function simplifyPolygon(poly, tol) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    let r = G.simplifyRing(poly[i], tol);
    if (r.length < 3) { if (i === 0) return null; continue; }
    r = i === 0 ? G.orientOuter(r) : G.orientHole(r);
    out.push(r);
  }
  return out;
}

// ------------------------------------------------------------------- raster
// 1 m raster over the play area, used to classify surfaces for tree placement,
// bridge railings and the preview image.
const RW = Math.ceil(PLAY.maxX - PLAY.minX), RH = Math.ceil(PLAY.maxZ - PLAY.minZ);
const R = new Uint8Array(RW * RH);
const B_WATER = 1, B_ROAD = 2, B_BLDG = 4, B_PATH = 8, B_GREEN = 16, B_RAIL = 32, B_NOTREE = 64, B_PAVED = 128;

function rasterPolygon(rings, op, bit) {
  const edges = [];
  let minZ = Infinity, maxZ = -Infinity;
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      edges.push(a[0] - PLAY.minX, a[1] - PLAY.minZ, b[0] - PLAY.minX, b[1] - PLAY.minZ);
      minZ = Math.min(minZ, a[1] - PLAY.minZ); maxZ = Math.max(maxZ, a[1] - PLAY.minZ);
    }
  }
  const z0 = Math.max(0, Math.floor(minZ)), z1 = Math.min(RH - 1, Math.ceil(maxZ));
  const xs = [];
  for (let zi = z0; zi <= z1; zi++) {
    const zc = zi + 0.5;
    xs.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const ax = edges[e], az = edges[e + 1], bx = edges[e + 2], bz = edges[e + 3];
      if ((az > zc) !== (bz > zc)) xs.push(ax + ((zc - az) * (bx - ax)) / (bz - az));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(RW - 1, Math.floor(xs[k + 1] - 0.5));
      const row = zi * RW;
      if (op === 'set') for (let x = xa; x <= xb; x++) R[row + x] |= bit;
      else for (let x = xa; x <= xb; x++) R[row + x] &= ~bit;
    }
  }
}

function rasterLine(pts, hw, bit) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0] - PLAY.minX, az = pts[i][1] - PLAY.minZ;
    const bx = pts[i + 1][0] - PLAY.minX, bz = pts[i + 1][1] - PLAY.minZ;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw)), x1 = Math.min(RW - 1, Math.ceil(Math.max(ax, bx) + hw));
    const z0 = Math.max(0, Math.floor(Math.min(az, bz) - hw)), z1 = Math.min(RH - 1, Math.ceil(Math.max(az, bz) + hw));
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
    const hw2 = hw * hw;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const cx = x + 0.5, cz = z + 0.5;
        let t = ((cx - ax) * dx + (cz - az) * dz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = cx - (ax + t * dx), ez = cz - (az + t * dz);
        if (ex * ex + ez * ez <= hw2) R[z * RW + x] |= bit;
      }
    }
  }
}

function rasterAt(x, z) {
  const xi = Math.floor(x - PLAY.minX), zi = Math.floor(z - PLAY.minZ);
  if (xi < 0 || zi < 0 || xi >= RW || zi >= RH) return 0;
  return R[zi * RW + xi];
}

function rasterAny(x, z, rad, mask) {
  for (let dz = -rad; dz <= rad; dz++)
    for (let dx = -rad; dx <= rad; dx++) if (rasterAt(x + dx, z + dz) & mask) return true;
  return false;
}

// ================================================================ COASTLINE
function buildLand(coastWays, box) {
  // Work in (x, n) with n = north = -z so that CCW means land-on-left.
  const ways = coastWays.filter((w) => w.nodes && w.geometry).map((w) => ({
    nodes: w.nodes,
    pts: w.geometry.map((g) => [px(g.lon), -pz(g.lat)]),
  }));
  const startMap = new Map();
  ways.forEach((w, i) => startMap.set(w.nodes[0], i));
  const endSet = new Set(ways.map((w) => w.nodes[w.nodes.length - 1]));
  const used = new Set();
  const chains = [];
  const walk = (i) => {
    let pts = [], cur = i, closed = false;
    while (cur !== undefined) {
      if (used.has(cur)) { closed = cur === i; break; }
      used.add(cur);
      const w = ways[cur];
      pts = pts.length ? pts.concat(w.pts.slice(1)) : w.pts.slice();
      cur = startMap.get(w.nodes[w.nodes.length - 1]);
    }
    return { pts, closed };
  };
  ways.forEach((w, i) => { if (!used.has(i) && !endSet.has(w.nodes[0])) chains.push(walk(i)); });
  ways.forEach((w, i) => { if (!used.has(i)) chains.push(walk(i)); });

  const B = { minX: box.minX, maxX: box.maxX, minN: -box.maxZ, maxN: -box.minZ };
  const inside = (p) => p[0] > B.minX && p[0] < B.maxX && p[1] > B.minN && p[1] < B.maxN;
  const Wd = B.maxX - B.minX, Ht = B.maxN - B.minN, PER = 2 * (Wd + Ht);
  const eps = 1e-6;
  const tOf = (p) => {
    if (Math.abs(p[1] - B.minN) < eps) return p[0] - B.minX;
    if (Math.abs(p[0] - B.maxX) < eps) return Wd + (p[1] - B.minN);
    if (Math.abs(p[1] - B.maxN) < eps) return Wd + Ht + (B.maxX - p[0]);
    return 2 * Wd + Ht + (B.maxN - p[1]);
  };
  const corners = [
    { t: 0, p: [B.minX, B.minN] }, { t: Wd, p: [B.maxX, B.minN] },
    { t: Wd + Ht, p: [B.maxX, B.maxN] }, { t: 2 * Wd + Ht, p: [B.minX, B.maxN] },
  ];
  // Snap a dangling chain end (broken coastline) onto the nearest boundary.
  const snapToBoundary = (p) => {
    const d = [p[1] - B.minN, B.maxX - p[0], B.maxN - p[1], p[0] - B.minX];
    const k = d.indexOf(Math.min(...d));
    return k === 0 ? [p[0], B.minN] : k === 1 ? [B.maxX, p[1]] : k === 2 ? [p[0], B.maxN] : [B.minX, p[1]];
  };
  // Liang-Barsky segment clip; returns [t0, t1] or null.
  const clipSeg = (a, b) => {
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0], dn = b[1] - a[1];
    const p = [-dx, dx, -dn, dn], q = [a[0] - B.minX, B.maxX - a[0], a[1] - B.minN, B.maxN - a[1]];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; continue; }
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return [t0, t1];
  };
  const at = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const snapExact = (p) => {
    const q = p.slice();
    if (Math.abs(q[0] - B.minX) < 1e-4) q[0] = B.minX;
    if (Math.abs(q[0] - B.maxX) < 1e-4) q[0] = B.maxX;
    if (Math.abs(q[1] - B.minN) < 1e-4) q[1] = B.minN;
    if (Math.abs(q[1] - B.maxN) < 1e-4) q[1] = B.maxN;
    return q;
  };

  const pieces = [], islands = [];
  for (const ch of chains) {
    let pts = ch.pts;
    if (ch.closed) {
      const k = pts.findIndex((p) => !inside(p));
      if (k < 0) { islands.push(pts.slice(0, -1)); continue; }
      pts = pts.slice(k, -1).concat(pts.slice(0, k + 1));
    }
    let cur = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const c = clipSeg(a, b);
      if (!c) continue;
      const [ta, tb] = c;
      if (ta > 0) cur = { pts: [snapExact(at(a, b, ta))], entry: true };
      else if (!cur) cur = { pts: [a], entry: false };
      cur.pts.push(tb < 1 ? snapExact(at(a, b, tb)) : b);
      if (tb < 1) { cur.exit = true; pieces.push(cur); cur = null; }
    }
    if (cur) { cur.exit = false; pieces.push(cur); }
  }
  let broken = 0;
  for (const p of pieces) {
    if (!p.entry) { p.pts.unshift(snapToBoundary(p.pts[0])); broken++; }
    if (!p.exit) { p.pts.push(snapToBoundary(p.pts[p.pts.length - 1])); broken++; }
    p.tIn = tOf(p.pts[0]);
    p.tOut = tOf(p.pts[p.pts.length - 1]);
  }
  if (broken) console.warn(`  coastline: ${broken} dangling ends snapped to the boundary`);

  const rings = [];
  const remaining = new Set(pieces);
  while (remaining.size) {
    const first = remaining.values().next().value;
    remaining.delete(first);
    const ring = first.pts.slice();
    let cur = first;
    for (let guard = 0; guard < 10000; guard++) {
      const te = cur.tOut;
      let best = first, bestD = ((first.tIn - te) % PER + PER) % PER;
      for (const q of remaining) {
        const d = ((q.tIn - te) % PER + PER) % PER;
        if (d < bestD) { bestD = d; best = q; }
      }
      const cs = corners
        .map((c) => ({ c, d: ((c.t - te) % PER + PER) % PER }))
        .filter((o) => o.d > 0 && o.d < bestD)
        .sort((a, b) => a.d - b.d);
      for (const o of cs) ring.push(o.c.p.slice());
      if (best === first) break;
      ring.push(...best.pts);
      remaining.delete(best);
      cur = best;
    }
    rings.push(ring);
  }
  const toXZ = (ring) => ring.map((p) => [p[0], -p[1]]);
  const land = [];
  for (const r of rings) land.push([G.orientOuter(toXZ(r))]);
  for (const r of islands) {
    const xz = toXZ(r);
    // CCW island rings (land on the left) have negative x/z area.
    if (G.signedAreaXZ(xz) < 0) land.push([xz]);
  }
  log(`coastline: ${ways.length} ways -> ${chains.length} chains -> ${pieces.length} pieces -> ${land.length} land polygons`);
  return land;
}

// ==================================================================== ROADS
const DRIVE = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 5,
  living_street: 6, service: 7, busway: 7,
  motorway_link: 0, trunk_link: 1, primary_link: 2, secondary_link: 3, tertiary_link: 4,
};
const PATHS = { footway: 0, path: 0, bridleway: 0, pedestrian: 1, cycleway: 2, track: 3 };
const LANE_W = [3.6, 3.5, 3.3, 3.2, 3.1, 3.0, 3.0, 2.9];

const isTunnel = (t) => (t.tunnel && t.tunnel !== 'no') || t.location === 'underground' || parseFloat(t.layer) < 0;
const isBridge = (t) => t.bridge && t.bridge !== 'no';
// Drivable roads: real tunnels are kept (and get elevations); passages under buildings are not.
const tunnelKind = (t) => (t.tunnel === 'building_passage' ? 'passage' : (t.tunnel && t.tunnel !== 'no') || t.location === 'underground' ? 'tunnel' : '');
const layerOf = (t) => { const l = parseInt(t.layer, 10); return Number.isFinite(l) ? Math.max(-4, Math.min(4, l)) : 0; };
const MAX_SEG = 15;

function roadSpec(t) {
  const hw = t.highway;
  const cls = DRIVE[hw];
  const isLink = hw.endsWith('_link');
  let oneway = 0;
  const ow = t.oneway;
  if (ow === 'yes' || ow === '1' || ow === 'true') oneway = 1;
  else if (ow === '-1' || ow === 'reverse') oneway = -1;
  else if (ow !== 'no' && (hw === 'motorway' || hw === 'motorway_link' || t.junction === 'roundabout' || t.junction === 'circular')) oneway = 1;
  let lanes = parseInt(t.lanes, 10);
  if (!(lanes >= 1 && lanes <= 10)) {
    if (isLink) lanes = 1;
    else if (cls === 0) lanes = oneway ? 3 : 6;
    else if (cls === 1) lanes = oneway ? 2 : 4;
    else if (cls <= 3) lanes = 2;
    else if (cls <= 5) lanes = oneway ? 1 : 2;
    else if (cls === 6) lanes = 1;
    else lanes = oneway || t.service === 'parking_aisle' || t.service === 'driveway' || t.service === 'alley' ? 1 : 2;
  }
  let laneW = LANE_W[cls];
  if (cls === 7) laneW = t.service ? 2.7 : 2.9;
  let shoulder = 0;
  if (cls <= 1) shoulder = isLink ? 0.8 : 1.2;
  else if (cls <= 5 && !isLink) shoulder = 1.1;
  let width = lanes * laneW + 2 * shoulder;
  if (cls === 7) width = Math.max(width, 3.6);
  const tw = parseFloat(t.width);
  if (tw >= 3 && tw <= 40 && !/['"]|ft/.test(t.width)) {
    width = tw;
    shoulder = Math.max(0, (width - lanes * laneW) / 2);
  }
  return { cls, oneway, lanes, width, shoulder, isLink, roundabout: t.junction === 'roundabout' || t.junction === 'circular' };
}

function roadName(t) {
  if (t.name) return t.name;
  if (t.ref) return t.ref.split(';')[0].replace(/^I /, 'I-').replace(/^US /, 'US-').replace(/^MA /, 'Route ');
  return '';
}

function buildRoads(els) {
  const nodeIndex = new Map();
  const nodes = [];
  const names = [''], nameIdx = new Map([['', 0]]);
  const roads = [], paths = [], crossings = [];
  const nameOf = (n) => {
    if (!nameIdx.has(n)) { nameIdx.set(n, names.length); names.push(n); }
    return nameIdx.get(n);
  };
  const nodeOf = (id, g) => {
    let i = nodeIndex.get(id);
    if (i === undefined) {
      i = nodes.length / 2;
      nodeIndex.set(id, i);
      nodes.push(r1(px(g.lon)), r1(pz(g.lat)));
    }
    return i;
  };
  // Split a way into runs whose segments touch the (padded) play area.
  const runs = (geom) => {
    const out = [];
    let cur = null;
    for (let i = 0; i + 1 < geom.length; i++) {
      const a = proj(geom[i]), b = proj(geom[i + 1]);
      if (inBox(PLAY_M, a[0], a[1]) || inBox(PLAY_M, b[0], b[1])) {
        if (!cur) { cur = [i]; out.push(cur); }
        cur.push(i + 1);
      } else cur = null;
    }
    return out;
  };
  let skipped = 0;
  for (const el of els) {
    const t = el.tags || {};
    const hw = t.highway;
    if (!el.geometry || el.geometry.length < 2) continue;
    if (t.area === 'yes' || t.indoor === 'yes') { skipped++; continue; }
    if (hw in DRIVE) {
      if (t.access === 'no' && hw === 'service') { skipped++; continue; }
      const tk = tunnelKind(t);
      if (tk === 'passage') { skipped++; continue; }
      const s = roadSpec(t);
      let layer = layerOf(t);
      const bridge = isBridge(t);
      // Garage ramps / loading-dock tunnels on service roads are left out.
      if (tk === 'tunnel' && s.cls >= 7) { skipped++; continue; }
      const tunnel = tk === 'tunnel';
      // Minor lanes tagged below grade are usually passages; keep them at grade.
      if (!tunnel && layer < 0 && s.cls >= 5) layer = 0;
      const depressed = !tunnel && !bridge && layer < 0;
      let ids = el.nodes, geom = el.geometry;
      if (s.oneway === -1) { ids = ids.slice().reverse(); geom = geom.slice().reverse(); s.oneway = 1; }
      for (const run of runs(geom)) {
        // Densify long segments so elevations can vary smoothly along them.
        const idx = [];
        for (let j = 0; j < run.length; j++) {
          if (j > 0) {
            const a = proj(geom[run[j - 1]]), b = proj(geom[run[j]]);
            const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const extra = Math.ceil(L / MAX_SEG) - 1;
            for (let q = 1; q <= extra; q++) {
              const f = q / (extra + 1);
              idx.push(nodes.length / 2);
              nodes.push(r1(a[0] + (b[0] - a[0]) * f), r1(a[1] + (b[1] - a[1]) * f));
            }
          }
          idx.push(nodeOf(ids[run[j]], geom[run[j]]));
        }
        const F = ROAD_FLAGS;
        const flags = (s.oneway ? F.ONEWAY : 0) | (bridge ? F.BRIDGE : 0) | (s.isLink ? F.LINK : 0) | (s.roundabout ? F.ROUNDABOUT : 0) |
          (tunnel ? F.TUNNEL : 0) | (depressed ? F.DEPRESSED : 0);
        roads.push({
          cls: s.cls, flags, lanes: s.lanes, width: s.width, shoulder: s.shoulder, layer,
          name: nameOf(roadName(t)), speed: parseInt(t.maxspeed, 10) || 0, nodes: idx, id: el.id,
        });
      }
    } else if (hw in PATHS || (hw === 'footway' && t.footway === 'crossing')) {
      if (isTunnel(t)) { skipped++; continue; }
      if (t.footway === 'sidewalk' || t.footway === 'traffic_island' || t.level && t.level !== '0') { skipped++; continue; }
      const pts = el.geometry.map(proj).filter((p) => inBox(PLAY_M, p[0], p[1]));
      if (pts.length < 2) continue;
      if (t.footway === 'crossing' || t.cycleway === 'crossing' || t.path === 'crossing') {
        const len = pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
        if (len < 45) crossings.push(pts);
        continue;
      }
      const cls = PATHS[hw];
      let w = [2.0, 4.5, 2.2, 3.0][cls];
      const tw = parseFloat(t.width);
      if (tw >= 1 && tw <= 15) w = tw;
      paths.push({ cls, width: w, bridge: isBridge(t), pts: G.simplifyLine(pts, 0.15) });
    }
  }
  log(`roads: ${roads.length} drivable, ${paths.length} paths, ${crossings.length} crossings, ${nodes.length / 2} nodes (skipped ${skipped})`);
  return { nodes, roads, paths, crossings, names, nodeIndex };
}

// ================================================================ BUILDINGS
const COLOR_NAMES = {
  white: 0xf2f0ea, black: 0x2b2b2b, gray: 0x9a9a9a, grey: 0x9a9a9a, darkgray: 0x6e6e6e, darkgrey: 0x6e6e6e,
  lightgray: 0xc8c8c8, lightgrey: 0xc8c8c8, silver: 0xbfc1c2, red: 0xa0453a, darkred: 0x7a2e26, maroon: 0x6e2b25,
  brown: 0x8a5a3c, tan: 0xc9ad85, beige: 0xd9ccaa, ivory: 0xece6d2, cream: 0xe8dfc4, yellow: 0xd8c46a,
  orange: 0xc77c3d, pink: 0xd9a6a0, salmon: 0xd59078, blue: 0x5c7fa6, lightblue: 0x9db8cf, navy: 0x2f3e5c,
  green: 0x5f8a5a, darkgreen: 0x355a3a, olive: 0x7c7a4a, teal: 0x3f7f7f, purple: 0x6f5a85, gold: 0xc7a650,
  sandybrown: 0xd4a06a, khaki: 0xc8bd8a, wheat: 0xe2cfa4, linen: 0xeee6dc, slategray: 0x6f7f8f,
};
const PALETTE = {
  brick: [0x8b4a3c, 0x9c5543, 0x7d4235, 0xa3624a, 0xb27258, 0x8e5545, 0x96604c],
  stone: [0xd8cfb8, 0xc9bea3, 0xe1d9c6, 0xcfc2a4, 0xbfb49a, 0xd4c8ae],
  gray: [0xa7a9ac, 0x8f9396, 0xbcbfc2, 0x9da3a8, 0xb5b1aa],
  clapboard: [0xc9d3d6, 0xd9cfa8, 0xbac7b1, 0xe2d8c9, 0xaab9c8, 0xd6b9a3, 0xe8e4da, 0x9fb3a6, 0xc4b0c7],
  glass: [0x6f8aa3, 0x5d7a94, 0x86a0b6, 0x7891a0, 0x4f6a80, 0x92a8b8],
  concrete: [0xb8b4ab, 0xa9a59c, 0xc6c2b8, 0x9e9a92],
};

function parseColor(c) {
  if (!c) return null;
  c = c.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (/^#[0-9a-f]{6}$/.test(c)) return parseInt(c.slice(1), 16);
  if (/^#[0-9a-f]{3}$/.test(c)) return parseInt(c[1] + c[1] + c[2] + c[2] + c[3] + c[3], 16);
  return COLOR_NAMES[c] ?? null;
}

function parseLength(v) {
  if (v == null) return NaN;
  const s = String(v).trim().toLowerCase();
  const ft = s.match(/^([\d.]+)\s*(ft|feet|')/);
  if (ft) return parseFloat(ft[1]) * 0.3048;
  const fi = s.match(/^(\d+)'\s*(\d+)"?$/);
  if (fi) return parseInt(fi[1], 10) * 0.3048 + parseInt(fi[2], 10) * 0.0254;
  return parseFloat(s);
}

const HOUSE = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'bungalow']);
const SMALL = new Set(['garage', 'garages', 'shed', 'carport', 'hut', 'kiosk', 'service', 'toilets', 'cabin']);
const SKIP_BUILDING = new Set(['roof', 'canopy', 'carport', 'construction_site', 'bridge', 'no', 'collapsed', 'ruins', 'demolished', 'proposed']);

function buildingStyle(t, h, id) {
  const r = G.hash32(id);
  const pick = (arr) => arr[r % arr.length];
  const type = t.building || t['building:part'] || 'yes';
  const mat = (t['building:material'] || '').toLowerCase();
  if (mat === 'brick') return { color: pick(PALETTE.brick), style: 1 };
  if (mat === 'glass') return { color: pick(PALETTE.glass), style: 3 };
  if (mat === 'concrete') return { color: pick(PALETTE.concrete), style: 0 };
  if (mat === 'wood') return { color: pick(PALETTE.clapboard), style: 2 };
  if (h > 55) return (r >> 8) % 3 ? { color: pick(PALETTE.glass), style: 3 } : { color: pick(PALETTE.concrete), style: 0 };
  if (HOUSE.has(type)) return (r >> 8) % 4 ? { color: pick(PALETTE.clapboard), style: 2 } : { color: pick(PALETTE.brick), style: 1 };
  if (SMALL.has(type)) return { color: pick(PALETTE.gray), style: 4 };
  if (type === 'industrial' || type === 'warehouse' || type === 'parking') return { color: pick(PALETTE.concrete), style: 4 };
  if (type === 'church' || type === 'cathedral') return { color: pick(PALETTE.stone), style: 1 };
  if (h > 28) {
    const k = (r >> 8) % 10;
    return k < 4 ? { color: pick(PALETTE.glass), style: 3 } : k < 7 ? { color: pick(PALETTE.concrete), style: 0 } : { color: pick(PALETTE.stone), style: 0 };
  }
  const k = (r >> 8) % 20;
  if (k < 9) return { color: pick(PALETTE.brick), style: 1 };
  if (k < 13) return { color: pick(PALETTE.stone), style: 1 };
  if (k < 16) return { color: pick(PALETTE.clapboard), style: 2 };
  return { color: pick(PALETTE.gray), style: 0 };
}

// Landmark styles (client renders these with custom textures / props).
export const LANDMARK = {
  FENWAY: 1, GREEN_MONSTER: 2, STATE_HOUSE: 3, HANCOCK: 4, PRUDENTIAL: 5, CUSTOM_HOUSE: 6, OLD_NORTH: 7,
  TRINITY: 8, BUNKER_HILL: 9, CONSTITUTION: 10, FANEUIL: 11, QUINCY: 12, BPL: 13, TD_GARDEN: 14,
  GREAT_DOME: 15, MOTHER_CHURCH: 16, OLD_STATE_HOUSE: 17, SYMPHONY: 18,
};
const LANDMARK_NAMES = [
  [/^Massachusetts State House$/, LANDMARK.STATE_HOUSE], [/^200 Clarendon$/, LANDMARK.HANCOCK],
  [/^Prudential Tower$/, LANDMARK.PRUDENTIAL], [/^Custom House Tower$/, LANDMARK.CUSTOM_HOUSE],
  [/^Old North Church$/, LANDMARK.OLD_NORTH], [/^Trinity Church$/, LANDMARK.TRINITY],
  [/^Bunker Hill Monument$/, LANDMARK.BUNKER_HILL], [/^USS Constitution$/, LANDMARK.CONSTITUTION],
  [/^Faneuil Hall$/, LANDMARK.FANEUIL], [/^Quincy Market$/, LANDMARK.QUINCY],
  [/^Boston Public Library$/, LANDMARK.BPL], [/^TD Garden$/, LANDMARK.TD_GARDEN],
  [/^Great Dome$/, LANDMARK.GREAT_DOME], [/^First Church of Christ Scientist$/, LANDMARK.MOTHER_CHURCH],
  [/^Old State House$/, LANDMARK.OLD_STATE_HOUSE], [/^Symphony Hall$/, LANDMARK.SYMPHONY],
  [/^Green Monster$/, LANDMARK.GREEN_MONSTER],
];
const PITCHED = /gabled|hipped|pyramidal|gambrel|mansard|half-hipped|skillion/;

// Fenway Park's stadium outline (leisure=stadium relation), if downloaded.
const FENWAY_POLY = (() => {
  const f = path.join(cacheDir, 'fenway.json');
  if (!fs.existsSync(f)) return null;
  const el = JSON.parse(fs.readFileSync(f, 'utf8')).elements.find((e) => e.type === 'relation');
  return el ? polygonsOf(el)[0] || null : null;
})();
const inFenway = (x, z) => !!FENWAY_POLY && G.pointInPolygon(x, z, FENWAY_POLY);

function buildBuildings(els) {
  const items = [];
  for (const el of els) {
    const t = el.tags || {};
    const isPart = !!t['building:part'] && !t.building;
    const type = t.building || t['building:part'];
    if (!type || SKIP_BUILDING.has(type) && !isPart) continue;
    if (t['building:part'] === 'no') continue;
    if (parseFloat(t.layer) < 0 || t.location === 'underground') continue;
    let height = parseLength(t.height ?? t['building:height'] ?? t.est_height);
    const levels = parseFloat(t['building:levels']);
    const roofLevels = parseFloat(t['roof:levels']) || 0;
    if (!(height > 0)) {
      if (levels > 0) height = (levels + roofLevels * 0.5) * 3.2 + 1.0;
      else if (SMALL.has(type)) height = 3.2;
      else if (HOUSE.has(type)) height = 8 + (G.hash32(el.id) % 40) / 10;
      else height = 9 + (G.hash32(el.id) % 70) / 10;
    }
    height = Math.min(height, 400);
    let minH = parseLength(t.min_height);
    const minLevel = parseFloat(t['building:min_level']);
    if (!(minH >= 0)) minH = minLevel > 0 ? minLevel * 3.2 : 0;
    if (minH >= height - 0.3) continue;
    const st = buildingStyle(t, height, el.id);
    const col = parseColor(t['building:colour']);
    const roofCol = parseColor(t['roof:colour']);
    const shape = (t['roof:shape'] || '').toLowerCase();
    const dome = /dome|onion/.test(shape);
    let roofH = parseLength(t['roof:height']);
    if (!(roofH > 0) && (PITCHED.test(shape) || dome)) roofH = NaN; // decided per polygon below
    let landmark = 0;
    for (const [re, id] of LANDMARK_NAMES) if (re.test(t.name || '')) landmark = id;
    for (let poly of polygonsOf(el)) {
      poly = clipPolygon(poly, PLAY_M);
      if (!poly) continue;
      poly = simplifyPolygon(poly, 0.25);
      if (!poly) continue;
      const area = -G.signedAreaXZ(poly[0]);
      if (area < 6) continue;
      // S3DB: height includes the roof. Spires get tall pyramids.
      let rh = 0;
      if (roofH > 0) rh = roofH;
      else if (Number.isNaN(roofH)) {
        const span = height - minH;
        rh = dome ? Math.min(span * 0.5, Math.sqrt(area / Math.PI)) : shape === 'pyramidal' && area < 150 ? span * 0.6 : Math.min(5, span * 0.3);
      }
      rh = Math.min(rh, (height - minH) * 0.9);
      const [cx, cz] = G.centroid(poly[0]);
      items.push({
        id: el.id, isPart, height, minH, poly, area,
        color: col ?? st.color, hasColor: col != null, roof: roofCol ?? -1, style: st.style,
        roofShape: shape, type, dome, roofH: rh,
        landmark: landmark || (inFenway(cx, cz) ? LANDMARK.FENWAY : 0),
      });
    }
  }
  // Simple 3D Buildings: hide outlines that contain building:part elements.
  const CELL = 60;
  const grid = new Map();
  const cellKey = (cx, cz) => cx * 100003 + cz;
  items.forEach((b, i) => {
    if (b.isPart) return;
    const bb = G.ringBBox(b.poly[0]);
    b.bb = bb;
    for (let cx = Math.floor(bb.minX / CELL); cx <= Math.floor(bb.maxX / CELL); cx++)
      for (let cz = Math.floor(bb.minZ / CELL); cz <= Math.floor(bb.maxZ / CELL); cz++) {
        const k = cellKey(cx, cz);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
  });
  let hidden = 0;
  for (const p of items) {
    if (!p.isPart) continue;
    const [cx, cz] = G.centroid(p.poly[0]);
    for (const i of grid.get(cellKey(Math.floor(cx / CELL), Math.floor(cz / CELL))) || []) {
      const o = items[i];
      if (cx >= o.bb.minX && cx <= o.bb.maxX && cz >= o.bb.minZ && cz <= o.bb.maxZ && G.pointInPolygon(cx, cz, o.poly)) {
        o.partArea = (o.partArea || 0) + p.area;
        // Parts inherit the outline's explicit colour and landmark identity.
        if (!p.hasColor && o.hasColor) p.color = o.color;
        if (!p.landmark && o.landmark) p.landmark = o.landmark;
      }
    }
  }
  // S3DB says outlines with parts aren't rendered, but many outlines only have
  // a part or two mapped (a dome, a tower): keep those so the building exists.
  for (const o of items) if (!o.isPart && o.partArea && o.partArea >= o.area * 0.55) { o.hidden = true; hidden++; }
  const out = items.filter((b) => !b.hidden);
  log(`buildings: ${out.length} (hid ${hidden} outlines replaced by parts)`);
  return { buildings: out, grid, CELL };
}

// ==================================================================== AREAS
const AREA = { park: 1, grass: 2, pitch: 3, golf: 4, cemetery: 5, wood: 6, playground: 7, track: 8, sand: 9, wetland: 10, garden: 11, railyard: 12, dirt: 13, parking: 20, plaza: 21, pier: 22, fuel: 23 };
function areaTypeOf(t) {
  const l = t.leisure, u = t.landuse, n = t.natural;
  if (t.man_made === 'pier' || t.man_made === 'breakwater') return AREA.pier;
  if (t.amenity === 'parking') {
    if (/underground|multi-storey|rooftop/.test(t.parking || '') || parseFloat(t.layer) < 0) return 0;
    return AREA.parking;
  }
  if (t.amenity === 'fuel') return AREA.fuel;
  if (t.highway === 'pedestrian' || t.place === 'square' || t['area:highway']) return AREA.plaza;
  if (l === 'pitch') return /dirt|clay|sand/.test(t.surface || '') ? AREA.dirt : AREA.pitch;
  if (l === 'track') return AREA.track;
  if (l === 'playground') return AREA.playground;
  if (l === 'golf_course') return AREA.golf;
  if (l === 'garden' || u === 'flowerbed' || u === 'allotments') return AREA.garden;
  if (l === 'park' || l === 'common' || l === 'recreation_ground' || l === 'dog_park' || l === 'nature_reserve' || u === 'recreation_ground' || u === 'village_green') return AREA.park;
  if (u === 'cemetery' || t.amenity === 'grave_yard') return AREA.cemetery;
  if (u === 'forest' || n === 'wood' || n === 'scrub' || n === 'heath') return AREA.wood;
  if (u === 'grass' || u === 'meadow' || u === 'greenfield' || n === 'grassland') return AREA.grass;
  if (n === 'sand' || n === 'beach') return t.layer ? AREA.dirt : AREA.sand;
  if (n === 'wetland') return AREA.wetland;
  if (u === 'railway') return AREA.railyard;
  return 0;
}

function buildAreas(els) {
  const out = [];
  const pierLines = [];
  for (const el of els) {
    const t = el.tags || {};
    const type = areaTypeOf(t);
    if (!type) continue;
    if (type === AREA.pier && el.type === 'way' && el.geometry && geoKey(el.geometry[0]) !== geoKey(el.geometry[el.geometry.length - 1])) {
      if (t.man_made === 'pier') {
        const w = parseFloat(t.width) || 5;
        pierLines.push({ width: Math.min(Math.max(w, 2), 20), pts: el.geometry.map(proj) });
      }
      continue;
    }
    const box = type >= 20 && type !== AREA.pier ? PLAY_M : WBOX;
    for (let poly of polygonsOf(el)) {
      poly = clipPolygon(poly, box);
      if (!poly) continue;
      poly = simplifyPolygon(poly, 0.4);
      if (!poly) continue;
      const area = -G.signedAreaXZ(poly[0]);
      if (area < 15) continue;
      out.push({ type, poly, area });
    }
  }
  // Large areas first so smaller features (pitches, gardens) draw on top.
  out.sort((a, b) => b.area - a.area);
  log(`areas: ${out.length}, pier lines: ${pierLines.length}`);
  return { areas: out, pierLines };
}

// ==================================================================== WATER
function buildWater(els) {
  const out = [];
  for (const el of els) {
    const t = el.tags || {};
    if (t.natural === 'coastline') continue;
    if (t.water === 'fountain' && el.type === 'way') { /* keep small fountains */ }
    if (parseFloat(t.layer) < 0 || t.tunnel) continue;
    for (let poly of polygonsOf(el)) {
      poly = clipPolygon(poly, WBOX);
      if (!poly) continue;
      poly = simplifyPolygon(poly, 0.5);
      if (!poly) continue;
      if (-G.signedAreaXZ(poly[0]) < 10) continue;
      out.push(poly);
    }
  }
  log(`water polygons: ${out.length}`);
  return out;
}

// ===================================================================== RAIL
// Service bits for rail ways (which trains run on them).
export const RAIL_SVC = { RED: 1, ORANGE: 2, BLUE: 4, GREEN: 8, COMMUTER: 16, AMTRAK: 32, FREIGHT: 64 };

function railServices(transit) {
  const map = new Map();
  for (const r of transit) {
    if (r.type !== 'relation') continue;
    const t = r.tags || {};
    const n = `${t.name || ''} ${t.ref || ''}`.toLowerCase();
    let bit = 0;
    if (t.route === 'subway') bit = n.includes('red') ? RAIL_SVC.RED : n.includes('orange') ? RAIL_SVC.ORANGE : n.includes('blue') ? RAIL_SVC.BLUE : 0;
    else if (t.route === 'light_rail' || t.route === 'tram') bit = n.includes('green') ? RAIL_SVC.GREEN : 0;
    else if (t.route === 'train') bit = /amtrak|acela|downeaster|lake shore|northeast regional/.test(n) ? RAIL_SVC.AMTRAK : RAIL_SVC.COMMUTER;
    if (!bit) continue;
    for (const m of r.members || []) if (m.type === 'way') map.set(m.ref, (map.get(m.ref) || 0) | bit);
  }
  return map;
}

// Rail network: nodes (OSM nodes + 10 m densified points), ways with service
// masks, and node flags for tunnel portals, stops, buffer stops and map edges.
export const RAIL_NODE = { PORTAL: 1, STOP: 2, BUFFER: 4, EDGE: 8 };
export const RAIL_WAY = { BRIDGE: 1, YARD: 2, CROSSOVER: 4 };
function buildRail(els, transit) {
  const svcMap = railServices(transit);
  const stopIds = new Set(), bufferIds = new Set();
  for (const e of transit) {
    if (e.type !== 'node') continue;
    const t = e.tags || {};
    if (t.railway === 'buffer_stop') bufferIds.add(e.id);
    else if (/^(stop|station|halt|tram_stop)$/.test(t.railway || '') || t.public_transport === 'stop_position') stopIds.add(e.id);
  }
  const nodeIndex = new Map(), nodes = [], osmId = [], ways = [];
  const tunnelNodes = new Set();
  const nodeOf = (id, g) => {
    let i = nodeIndex.get(id);
    if (i === undefined) { i = nodes.length / 2; nodeIndex.set(id, i); nodes.push(r1(px(g.lon)), r1(pz(g.lat))); osmId.push(id); }
    return i;
  };
  for (const el of els) {
    const t = el.tags || {};
    if (!el.geometry || !el.nodes) continue;
    if (isTunnel(t)) { for (const id of el.nodes) tunnelNodes.add(id); continue; }
    const kind = t.railway === 'rail' ? 0 : t.railway === 'subway' ? 1 : 2;
    let svc = svcMap.get(el.id) || 0;
    if (!svc) {
      const nm = `${t.name || ''} ${t.operator || ''}`;
      if (/Red Line/.test(nm)) svc = RAIL_SVC.RED;
      else if (/Orange Line/.test(nm)) svc = RAIL_SVC.ORANGE;
      else if (/Blue Line/.test(nm)) svc = RAIL_SVC.BLUE;
      else if (/Green Line/.test(nm)) svc = RAIL_SVC.GREEN;
      else if (/Grand Junction/.test(nm)) svc = RAIL_SVC.FREIGHT;
    }
    const flags = (isBridge(t) ? RAIL_WAY.BRIDGE : 0) | (/yard|siding|spur/.test(t.service || '') ? RAIL_WAY.YARD : 0) | (t.service === 'crossover' ? RAIL_WAY.CROSSOVER : 0);
    // Split into runs inside the padded play area; densify every 10 m.
    const g = el.geometry;
    let run = null;
    const flush = () => { if (run && run.length >= 2) ways.push({ kind, flags, svc, nodes: run }); run = null; };
    for (let i = 0; i < g.length; i++) {
      const p = proj(g[i]);
      const inside = inBox(PLAY_M, p[0], p[1]);
      const prevIn = i > 0 && inBox(PLAY_M, ...proj(g[i - 1]));
      if (!inside && !prevIn) { flush(); continue; }
      if (!run) run = [];
      if (run.length) {
        const a = proj(g[i - 1]);
        const L = Math.hypot(p[0] - a[0], p[1] - a[1]);
        const extra = Math.ceil(L / 10) - 1;
        for (let q = 1; q <= extra; q++) {
          const f = q / (extra + 1);
          run.push(nodes.length / 2);
          nodes.push(r1(a[0] + (p[0] - a[0]) * f), r1(a[1] + (p[1] - a[1]) * f));
          osmId.push(-1);
        }
      } else if (i > 0 && !inBox(PLAY_M, ...proj(g[i - 1]))) {
        run.push(nodeOf(el.nodes[i - 1], g[i - 1]));
      }
      run.push(nodeOf(el.nodes[i], g[i]));
      if (!inside) flush();
    }
    flush();
  }
  const N = nodes.length / 2;
  const flags = new Uint8Array(N);
  const deg = new Uint16Array(N);
  for (const w of ways) for (let i = 0; i < w.nodes.length; i++) deg[w.nodes[i]] += i === 0 || i === w.nodes.length - 1 ? 1 : 2;
  for (let i = 0; i < N; i++) {
    const id = osmId[i];
    if (id >= 0 && tunnelNodes.has(id)) flags[i] |= RAIL_NODE.PORTAL;
    if (id >= 0 && stopIds.has(id)) flags[i] |= RAIL_NODE.STOP;
    if (id >= 0 && bufferIds.has(id)) flags[i] |= RAIL_NODE.BUFFER;
    const x = nodes[2 * i], z = nodes[2 * i + 1];
    if (deg[i] === 1 && !(flags[i] & RAIL_NODE.PORTAL) && !inBox(grow(PLAY, -60), x, z)) flags[i] |= RAIL_NODE.EDGE;
  }
  log(`rail: ${ways.length} ways, ${N} nodes, ${[...flags].filter((f) => f & RAIL_NODE.PORTAL).length} portals, ${[...flags].filter((f) => f & RAIL_NODE.STOP).length} stops, ${[...flags].filter((f) => f & RAIL_NODE.BUFFER).length} buffers`);
  return { nodes, ways, flags };
}

// Rail heights: bridge chains ramp up from where they meet at-grade track
// (or a tunnel portal) to a deck that clears what they cross.
function railElevations(rail, deckAt) {
  const { nodes, ways, flags } = rail;
  const N = nodes.length / 2;
  const elev = new Float32Array(N);
  const onBridge = new Uint8Array(N), onGround = new Uint8Array(N), deck = new Float32Array(N);
  const nbr = Array.from({ length: N }, () => []);
  for (const w of ways) {
    const b = w.flags & RAIL_WAY.BRIDGE;
    const d = b ? deckAt(w) : 0;
    for (let i = 0; i < w.nodes.length; i++) {
      const n = w.nodes[i];
      if (b) { onBridge[n] = 1; deck[n] = Math.max(deck[n], d); } else onGround[n] = 1;
      if (b && i) {
        const a = w.nodes[i - 1];
        const L = Math.hypot(nodes[2 * n] - nodes[2 * a], nodes[2 * n + 1] - nodes[2 * a + 1]);
        nbr[a].push(n, L); nbr[n].push(a, L);
      }
    }
  }
  // Multi-source Dijkstra (simple, small graph) from bridge nodes touching ground/portals/ends.
  const dist = new Float64Array(N).fill(Infinity);
  const q = [];
  for (let i = 0; i < N; i++) {
    if (!onBridge[i]) continue;
    if (onGround[i] || flags[i] & (RAIL_NODE.PORTAL | RAIL_NODE.EDGE) || nbr[i].length <= 2) { dist[i] = 0; q.push(i); }
  }
  while (q.length) {
    let bi = 0;
    for (let k = 1; k < q.length; k++) if (dist[q[k]] < dist[q[bi]]) bi = k;
    const u = q.splice(bi, 1)[0];
    for (let k = 0; k < nbr[u].length; k += 2) {
      const v = nbr[u][k], nd = dist[u] + nbr[u][k + 1];
      if (nd < dist[v]) { if (dist[v] === Infinity) q.push(v); dist[v] = nd; }
    }
  }
  for (let i = 0; i < N; i++) if (onBridge[i] && !onGround[i]) elev[i] = deck[i] * Math.min(1, (Number.isFinite(dist[i]) ? dist[i] : 0) / 55);
  return elev;
}

// =================================================================== PLACES
function buildPlaces(els) {
  const out = [];
  const seen = new Set();
  for (const el of els) {
    const t = el.tags || {};
    if (!t.name || el.lat == null) continue;
    const [x, z] = proj(el);
    if (!inBox(grow(PLAY, 500), x, z)) continue;
    const key = t.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rank = { city: 0, town: 0, suburb: 1, quarter: 2, neighbourhood: 3 }[t.place] ?? 3;
    out.push([t.name, r1(x), r1(z), rank]);
  }
  log(`places: ${out.length}`);
  return out;
}

// ================================================================ LANDMARKS
// Display name, OSM name pattern, kind. Coordinates come from OSM; the
// fallback lat/lon is only used if the landmark query is missing.
const LANDMARKS = [
  ['Fenway Park', /^Fenway Park$/, 'stadium', 42.34646, -71.09755],
  ['TD Garden', /^TD Garden$/, 'arena', 42.36628, -71.06222],
  ['Massachusetts State House', /^Massachusetts State House$/, 'historic', 42.35873, -71.06374],
  ['Faneuil Hall', /^Faneuil Hall$/, 'historic', 42.36008, -71.05612],
  ['Quincy Market', /^Quincy Market$/, 'market', 42.36013, -71.05475],
  ['Old North Church', /Old North Church/, 'historic', 42.36633, -71.05445],
  ['New England Aquarium', /^New England Aquarium$/, 'museum', 42.35914, -71.04958],
  ['South Station', /^South Station$/, 'station', 42.35228, -71.05514],
  ['North Station', /^North Station$/, 'station', 42.36557, -71.06116],
  ['Boston Public Library', /^Boston Public Library/, 'library', 42.34936, -71.07801],
  ['Trinity Church', /^Trinity Church$/, 'church', 42.34995, -71.07502],
  ['Prudential Tower', /^Prudential (Tower|Center)$/, 'tower', 42.34716, -71.08214],
  ['200 Clarendon (Hancock Tower)', /^(200 Clarendon|John Hancock Tower)$/, 'tower', 42.34913, -71.07487],
  ['Bunker Hill Monument', /^Bunker Hill Monument$/, 'monument', 42.37634, -71.06082],
  ['USS Constitution', /^USS Constitution$/, 'ship', 42.37244, -71.05667],
  ['Museum of Fine Arts', /^Museum of Fine Arts/, 'museum', 42.33938, -71.09404],
  ['Isabella Stewart Gardner Museum', /^Isabella Stewart Gardner Museum$/, 'museum', 42.33826, -71.09908],
  ['Museum of Science', /^Museum of Science$/, 'museum', 42.36773, -71.07096],
  ['MIT', /^Massachusetts Institute of Technology$/, 'university', 42.35983, -71.09211],
  ['Northeastern University', /^Northeastern University$/, 'university', 42.33986, -71.08914],
  ['Boston University', /^Boston University$/, 'university', 42.35048, -71.10541],
  ['Symphony Hall', /^Symphony Hall$/, 'venue', 42.34262, -71.08573],
  ['Boston Common', /^Boston Common$/, 'park', 42.35504, -71.06560],
  ['Public Garden', /^(Boston )?Public Garden$/, 'park', 42.35409, -71.07031],
  ['Institute of Contemporary Art', /^Institute of Contemporary Art/, 'museum', 42.35289, -71.04288],
  ['Convention Center', /^Boston Convention and Exhibition Center$/, 'venue', 42.34576, -71.04446],
  ['Copley Square', /^Copley Square$/, 'square', 42.34990, -71.07707],
  ['Kenmore Square', /^Kenmore Square$/, 'square', 42.34900, -71.09530],
  ['Old State House', /^Old State House$/, 'historic', 42.35871, -71.05746],
  ['Paul Revere House', /^Paul Revere House$/, 'historic', 42.36373, -71.05368],
  ['Hatch Shell', /^Hatch Memorial Shell$/, 'venue', 42.35722, -71.07399],
  ["Children's Museum", /^Boston Children's Museum$/, 'museum', 42.35192, -71.04997],
  ['Kendall Square', /^Kendall Square$/, 'square', 42.36255, -71.08637],
  ['Zakim Bridge', /^Leonard P\. Zakim Bunker Hill Memorial Bridge$/, 'bridge', 42.36860, -71.06200],
  ['Longfellow Bridge', /^Longfellow Bridge$/, 'bridge', 42.36181, -71.07523],
  ['Harvard Bridge', /^Harvard Bridge$/, 'bridge', 42.35415, -71.09140],
  ['City Hall', /^Boston City Hall$/, 'civic', 42.36041, -71.05801],
  ['Custom House Tower', /^Custom House Tower$/, 'tower', 42.35915, -71.05370],
  ['Chinatown Gate', /^Chinatown Gate$/, 'monument', 42.35111, -71.05975],
  ['Tea Party Museum', /^Boston Tea Party Ships/, 'museum', 42.35218, -71.05129],
  ['Mass General Hospital', /^Massachusetts General Hospital$/, 'hospital', 42.36252, -71.06882],
  ['Castle Island', /^Castle Island$/, 'park', 42.33790, -71.01221],
  ['Christian Science Plaza', /^Christian Science Plaza$/, 'square', 42.34436, -71.08458],
];

function buildLandmarks(els, roadData) {
  const found = new Map();
  for (const el of els) {
    const t = el.tags || {};
    const c = el.center || (el.lat != null ? el : null);
    if (!t.name || !c) continue;
    for (const [disp, re, , flat, flon] of LANDMARKS) {
      if (!re.test(t.name)) continue;
      // Names like "Boston Public Library" match many branches: only accept
      // matches near the expected spot, then prefer "important" tags.
      const dist = Math.hypot(px(c.lon) - px(flon), pz(c.lat) - pz(flat));
      if (dist > 900) continue;
      const score = (t.tourism ? 4 : 0) + (t.historic ? 3 : 0) + (t.building ? 2 : 0) + (t.leisure ? 2 : 0) + (t.amenity ? 1 : 0) + (el.type !== 'node' ? 1 : 0) - dist / 150;
      const prev = found.get(disp);
      if (!prev || score > prev.score) found.set(disp, { score, lat: c.lat, lon: c.lon });
    }
  }
  const { nodes, roads } = roadData;
  // Nodes usable as destinations: on named, non-service, non-motorway roads.
  const good = new Uint8Array(nodes.length / 2);
  for (const r of roads) if (r.cls >= 2 && r.cls <= 6) for (const n of r.nodes) good[n] = 1;
  const out = [];
  for (const [disp, , kind, flat, flon] of LANDMARKS) {
    const f = found.get(disp) || { lat: flat, lon: flon };
    const x = px(f.lon), z = pz(f.lat);
    if (!inBox(PLAY, x, z)) continue;
    let best = -1, bd = Infinity;
    for (let i = 0; i < good.length; i++) {
      if (!good[i]) continue;
      const d = (nodes[2 * i] - x) ** 2 + (nodes[2 * i + 1] - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    out.push([disp, kind, r1(x), r1(z), best]);
    if (!found.has(disp)) console.warn(`  landmark not found in OSM, using fallback: ${disp}`);
  }
  log(`landmarks: ${out.length}`);
  return out;
}

// ===================================================================== MAIN
const roadData = buildRoads(load('roads'));
const waterEls = load('water');
const land = buildLand(waterEls.filter((e) => e.tags && e.tags.natural === 'coastline'), WBOX)
  .map((p) => simplifyPolygon(p, 0.5)).filter(Boolean);
const water = buildWater(waterEls);
const { buildings } = buildBuildings(load('buildings'));
const { areas, pierLines } = buildAreas([...load('green'), ...load('paved')]);
const rail = buildRail(load('rail'), load('transit'));
const railPts = (w) => w.nodes.map((n) => [rail.nodes[2 * n], rail.nodes[2 * n + 1]]);
const places = buildPlaces(load('places'));

// ---- raster: water / land / features
R.fill(B_WATER);
for (const p of land) rasterPolygon(p, 'clear', B_WATER);
for (const p of water) rasterPolygon(p, 'set', B_WATER);
for (const a of areas) {
  if (a.type === AREA.pier) { rasterPolygon(a.poly, 'clear', B_WATER); rasterPolygon(a.poly, 'set', B_PAVED); continue; }
  if ([AREA.park, AREA.grass, AREA.golf, AREA.cemetery, AREA.wood, AREA.garden, AREA.wetland].includes(a.type)) rasterPolygon(a.poly, 'set', B_GREEN);
  else rasterPolygon(a.poly, 'set', B_NOTREE);
}
for (const pl of pierLines) { rasterLine(pl.pts, pl.width / 2, B_PAVED); }
// Pier lines only count as piers where they actually cross water.
log('raster: base layers done');
const { nodes } = roadData;
const roadPts = (r) => r.nodes.map((n) => [nodes[2 * n], nodes[2 * n + 1]]);

// ---- road elevations (bridges, ramps, trenches, tunnels)
const SIDEWALK = 2.4;
const hasSidewalk = (r) => r.cls >= 2 && r.cls <= 6 && !(r.flags & 4);
const isWaterAt = (x, z) => !!(rasterAt(x, z) & B_WATER) && !(rasterAt(x, z) & B_PAVED);
const { elev } = solveElevations(roadData, { isWater: isWaterAt, railLines: rail.ways.filter((w) => !(w.flags & 1)).map(railPts), log });

for (const b of buildings) if (b.minH < 3) rasterPolygon(b.poly, 'set', B_BLDG);
for (const r of roadData.roads) {
  if (r.flags & ROAD_FLAGS.TUNNEL) continue; // underground: trees and parks above are fine
  const pts = roadPts(r);
  rasterLine(pts, r.width / 2 + (hasSidewalk(r) ? SIDEWALK : 0.3), B_ROAD);
}
// Rail bridges: match an adjacent road bridge deck (e.g. the Red Line on the
// Longfellow), else clear water (3 m) or roads (6.5 m).
const bridgeNodes = [];
for (const r of roadData.roads) if (r.flags & ROAD_FLAGS.BRIDGE) for (const n of r.nodes) if (elev[n] > 0.5) bridgeNodes.push([nodes[2 * n], nodes[2 * n + 1], elev[n]]);
const railY = railElevations(rail, (w) => {
  const pts = railPts(w);
  let wet = false, road = false;
  for (const p of pts) { if (isWaterAt(p[0], p[1])) wet = true; if (rasterAt(p[0], p[1]) & B_ROAD) road = true; }
  // Share a road deck only when the track runs on it (within ~15 m of a deck node).
  const mid = pts[Math.floor(pts.length / 2)];
  let match = 0;
  for (const [x, z, e] of bridgeNodes) if (Math.hypot(x - mid[0], z - mid[1]) < 15) match = Math.max(match, e);
  return match || (wet ? 3.0 : road ? 6.5 : 1.0);
});
for (const p of roadData.paths) rasterLine(p.pts, p.width / 2, B_PATH);
for (const w of rail.ways) rasterLine(railPts(w), 2.0, B_RAIL);
log('raster: roads/buildings done');

// ---- buildings blocking roads: make them non-solid
{
  const CELL = 40;
  const grid = new Map();
  buildings.forEach((b, i) => {
    if (b.minH >= 3) return;
    const bb = G.ringBBox(b.poly[0]);
    b.bb = bb;
    for (let cx = Math.floor(bb.minX / CELL); cx <= Math.floor(bb.maxX / CELL); cx++)
      for (let cz = Math.floor(bb.minZ / CELL); cz <= Math.floor(bb.maxZ / CELL); cz++) {
        const k = cx * 100003 + cz;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(i);
      }
  });
  let blocked = 0, hidden = 0;
  for (const r of roadData.roads) {
    if (r.cls === 7) continue;
    // Tunnels and trenches pass under buildings; they don't make them hollow.
    if (r.flags & (ROAD_FLAGS.TUNNEL | ROAD_FLAGS.DEPRESSED)) continue;
    const pts = roadPts(r);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const ea = elev[r.nodes[i]], eb = elev[r.nodes[i + 1]];
      if (Math.min(ea, eb) < -1) continue;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(len / 1.5));
      for (let k = 0; k <= steps; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / steps, z = a[1] + ((b[1] - a[1]) * k) / steps;
        const e = ea + ((eb - ea) * k) / steps;
        for (const bi of grid.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) || []) {
          const bd = buildings[bi];
          if (bd.hide) continue;
          if (x < bd.bb.minX || x > bd.bb.maxX || z < bd.bb.minZ || z > bd.bb.maxZ) continue;
          if (G.pointInPolygon(x, z, bd.poly)) {
            if (!bd.noCollide) { bd.noCollide = true; blocked++; }
            // Elevated roads passing through a building: hide the building.
            if (e > 2 && bd.height > e - 1.5 && bd.height < 40) { bd.hide = true; hidden++; }
          }
        }
      }
    }
  }
  log(`buildings overlapping drivable roads (made non-solid): ${blocked}, hidden under elevated roads: ${hidden}`);
}

// ---- trees: mapped + procedural in parks
const treeEls = load('trees');
const trees = [];
const treeOk = (x, z) => inBox(PLAY, x, z) && !rasterAny(x, z, 1, B_ROAD | B_BLDG | B_WATER | B_RAIL | B_NOTREE | B_PAVED) && !(rasterAt(x, z) & B_PATH);
let mapped = 0;
for (const el of treeEls) {
  if (el.type === 'node') {
    const [x, z] = proj(el);
    if (treeOk(x, z)) { trees.push(r1(x), r1(z)); mapped++; }
  } else if (el.geometry) {
    const pts = el.geometry.map(proj);
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.round(len / 8));
      for (let k = 0; k < n; k++) {
        const x = a[0] + ((b[0] - a[0]) * k) / n, z = a[1] + ((b[1] - a[1]) * k) / n;
        if (treeOk(x, z)) { trees.push(r1(x), r1(z)); mapped++; }
      }
    }
  }
}
// Density (m^2 per tree) for procedural trees.
const DENSITY = { [AREA.park]: 260, [AREA.wood]: 45, [AREA.garden]: 160, [AREA.cemetery]: 220, [AREA.golf]: 900, [AREA.grass]: 1400 };
const treeGridCell = 10;
const treeGrid = new Set();
const tgKey = (x, z) => Math.floor(x / treeGridCell) * 100003 + Math.floor(z / treeGridCell);
for (let i = 0; i < trees.length; i += 2) treeGrid.add(tgKey(trees[i], trees[i + 1]));
let procedural = 0;
areas.forEach((a, ai) => {
  const dens = DENSITY[a.type];
  if (!dens) return;
  const bb = G.ringBBox(a.poly[0]);
  if (!G.bboxOverlap(bb, PLAY)) return;
  const target = Math.min(4000, Math.floor(a.area / dens));
  const rnd = G.mulberry32(ai * 7919 + 17);
  let placed = 0;
  for (let tries = 0; tries < target * 6 && placed < target; tries++) {
    const x = bb.minX + rnd() * (bb.maxX - bb.minX), z = bb.minZ + rnd() * (bb.maxZ - bb.minZ);
    if (!G.pointInPolygon(x, z, a.poly) || !treeOk(x, z)) continue;
    // Skip cells that already have a mapped tree so mapped rows stay tidy.
    const k = tgKey(x, z);
    if (treeGrid.has(k) && rnd() < 0.85) continue;
    trees.push(r1(x), r1(z));
    placed++;
  }
  procedural += placed;
});
log(`trees: ${mapped} mapped + ${procedural} procedural`);

// ---- traffic signals (on drivable road nodes)
const signals = [];
for (const el of load('signals')) {
  if (el.tags && el.tags.highway === 'traffic_signals') {
    const i = roadData.nodeIndex.get(el.id);
    if (i !== undefined) signals.push(i);
  }
}
log(`traffic signals: ${signals.length}`);

const landmarks = buildLandmarks(load('landmarks'), roadData);

// ===================================================================== WRITE
const out = {
  meta: {
    origin: ORIGIN,
    metersPerDegree: { lat: M_LAT, lon: M_LON },
    play: { minX: r1(PLAY.minX), maxX: r1(PLAY.maxX), minZ: r1(PLAY.minZ), maxZ: r1(PLAY.maxZ) },
    water: { minX: r1(WBOX.minX), maxX: r1(WBOX.maxX), minZ: r1(WBOX.minZ), maxZ: r1(WBOX.maxZ) },
    attribution: 'Map data © OpenStreetMap contributors (ODbL)',
    built: new Date().toISOString(),
  },
  names: roadData.names,
  nodes: roadData.nodes,
  // per-node elevation in decimeters (parallel to nodes)
  elev: Array.from(elev, (e) => Math.round(e * 10)),
  // [class, flags(1 oneway,2 bridge,4 link,8 roundabout,16 tunnel,32 depressed), lanes, width*10, shoulder*10, nameIndex, speedLimitMph, [node...], layer]
  roads: roadData.roads.map((r) => [r.cls, r.flags, r.lanes, Math.round(r.width * 10), Math.round(r.shoulder * 10), r.name, r.speed, r.nodes, r.layer]),
  // [class, width*10, bridge, [x,z,...]]
  paths: roadData.paths.map((p) => [p.cls, Math.round(p.width * 10), p.bridge ? 1 : 0, flat(p.pts)]),
  piers: pierLines.map((p) => [Math.round(p.width * 10), flat(p.pts)]),
  crossings: roadData.crossings.map(flat),
  // [height*10, minHeight*10, color, roofColor, style, flags(1 noCollide,2 part,4 pitched,8 hidden,16 dome), [[outer], [hole]...], landmark, roofHeight*10]
  buildings: buildings.map((b) => [
    Math.round(b.height * 10), Math.round(b.minH * 10), b.color, b.roof, b.style,
    (b.noCollide || b.minH >= 3 ? 1 : 0) | (b.isPart ? 2 : 0) | (PITCHED.test(b.roofShape) ? 4 : 0) | (b.hide ? 8 : 0) | (b.dome ? 16 : 0),
    b.poly.map(flat), b.landmark || 0, Math.round((b.roofH || 0) * 10), /grandstand|bleachers/.test(b.type) ? 1 : 0,
  ]),
  land: land.map((p) => p.map(flat)),
  water: water.map((p) => p.map(flat)),
  // [type, [[outer], [hole]...]]
  areas: areas.map((a) => [a.type, a.poly.map(flat)]),
  // Rail network: node x,z; node elevation*10; node flags (1 portal, 2 stop, 4 buffer, 8 map edge);
  // ways [kind(0 rail,1 subway,2 light rail), flags(1 bridge,2 yard,4 crossover), services, [node...]]
  railNodes: rail.nodes,
  railY: Array.from(railY, (e) => Math.round(e * 10)),
  railFlags: Array.from(rail.flags),
  railWays: rail.ways.map((w) => [w.kind, w.flags, w.svc, w.nodes]),
  trees,
  places,
  landmarks,
  signals,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync(outFile, json);
log(`wrote ${outFile}: ${(json.length / 1e6).toFixed(2)} MB (${(zlib.gzipSync(json).length / 1e6).toFixed(2)} MB gzipped)`);

// ================================================================== PREVIEW
{
  const S = 4; // meters per preview pixel
  const W = Math.floor(RW / S), H = Math.floor(RH / S);
  const img = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    img[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      let c = [226, 222, 212];
      const v = R[(y * S + 1) * RW + x * S + 1];
      if (v & B_GREEN) c = [150, 190, 120];
      if (v & B_WATER) c = [80, 130, 190];
      if (v & B_PAVED) c = [180, 170, 150];
      if (v & B_RAIL) c = [140, 120, 110];
      if (v & B_PATH) c = [200, 190, 160];
      if (v & B_BLDG) c = [150, 110, 100];
      if (v & B_ROAD) c = [60, 60, 66];
      const o = y * (W * 3 + 1) + 1 + x * 3;
      img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2];
    }
  }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (buf) => { let c = -1; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(img)), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(cacheDir, 'preview.png'), png);
  log(`preview: ${W}x${H} -> tools/.cache/preview.png`);
}
