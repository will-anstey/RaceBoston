// Airports you can fly from and to: Logan, and (once their maps are loaded)
// Martha's Vineyard and Nantucket. Each is built from its map's aeroways:
// runways with named ends, the taxi graph (taxiways, taxilanes, stand
// lead-in lines), stands. Routes for taxiing, where to hold short, which
// runway to use with the wind, and the approach path to it.

import { TaxiGraph, makeGroundPath } from './planes.js';
import { AERO } from './mapdata.js';
import { wrapAngle, clamp } from './util.js';

export const AIRPORT_DEFS = {
  BOS: { code: 'BOS', name: 'Logan International', city: 'Boston', short: 'Logan', region: 'boston', lat: 42.3656, lon: -71.0096 },
  MVY: { code: 'MVY', name: "Martha's Vineyard Airport", city: "Martha's Vineyard", short: "Martha's Vineyard", region: 'vineyard', lat: 41.3931, lon: -70.6143 },
  ACK: { code: 'ACK', name: 'Nantucket Memorial Airport', city: 'Nantucket', short: 'Nantucket', region: 'nantucket', lat: 41.2531, lon: -70.0602 },
};

// The 3-degree glidepath meets the runway this far (m) above its aiming point:
// about 50 ft over the threshold, with a little room for the flare.
export const GP_OVER = 4;

export function xzOf(meta, lat, lon) {
  return [(lon - meta.origin.lon) * meta.metersPerDegree.lon, -(lat - meta.origin.lat) * meta.metersPerDegree.lat];
}

export class Airport {
  // map: the region's decoded map (its aero data, terrain and meta).
  constructor(def, map) {
    this.def = def; this.code = def.code; this.name = def.name; this.short = def.short; this.region = def.region;
    const A = map.aero;
    this.ok = !!A && A.runways.length > 0;
    [this.x, this.z] = xzOf(map.meta, def.lat, def.lon);
    if (!this.ok) return;
    this.A = A;
    this.graph = new TaxiGraph(A);
    const G = this.graph, near = (x, z) => Math.hypot(x - this.x, z - this.z) < 5000;
    // Runways (only this airport's: an island map can hold another airfield).
    this.runways = [];
    A.runways.forEach((r, ri) => {
      const pts = Array.from(r.nodes, (n) => [G.px(n), G.pz(n)]);
      const mid = pts[pts.length >> 1];
      if (!near(mid[0], mid[1])) return;
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      this.runways.push({ ri, ref: r.ref, width: r.width, nodes: Array.from(r.nodes), pts, length: L, ends: [] });
    });
    this.ok = this.runways.length > 0;
    if (!this.ok) return;
    this.ends = new Map();
    for (const rw of this.runways) {
      A.runways[rw.ri].ends.forEach((name, e) => {
        const nodes = e === 0 ? rw.nodes.slice() : rw.nodes.slice().reverse();
        const p0 = [G.px(nodes[0]), G.pz(nodes[0])], p1 = [G.px(nodes[nodes.length - 1]), G.pz(nodes[nodes.length - 1])];
        const l = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
        const end = { name, rw, nodes, x: p0[0], z: p0[1], fx: (p1[0] - p0[0]) / l, fz: (p1[1] - p0[1]) / l, heading: Math.atan2(p1[0] - p0[0], -(p1[1] - p0[1])), length: rw.length };
        // Where a departure joins: the first node from the end with a taxiway off it.
        end.entry = nodes.find((n) => G.taxiNeighbours(n).length > 0) ?? nodes[0];
        rw.ends.push(end);
        this.ends.set(name, end);
      });
    }
    this.elev = map.terrain.h(this.x, this.z);
    // Stands: nose toward the stand end of each lead-in line.
    this.stands = (A.stands || []).map((st, i) => {
      const nodes = Array.from(st.nodes), n = nodes.length;
      const ex = G.px(nodes[n - 1]), ez = G.pz(nodes[n - 1]), bx = G.px(nodes[n - 2]), bz = G.pz(nodes[n - 2]);
      const l = Math.hypot(ex - bx, ez - bz) || 1;
      return { i, ref: st.ref || '', nodes, taxiNode: nodes[0], ex, ez, fx: (ex - bx) / l, fz: (ez - bz) / l, heading: Math.atan2(ex - bx, -(ez - bz)), lead: makeGroundPath(nodes.map((k) => [G.px(k), G.pz(k)])) };
    }).filter((st) => near(st.ex, st.ez) && this.graph.route(st.taxiNode, this.runways[0].ends[0].entry));
    // Room around each stand (to the nearest other stand), for picking one a big jet fits.
    for (const a of this.stands) {
      let d = Infinity;
      for (const b of this.stands) if (a !== b) d = Math.min(d, Math.hypot(a.ex - b.ex, a.ez - b.ez));
      a.room = d;
    }
    // No stands mapped (a small field): parking spots along the apron by the taxiways.
    if (!this.stands.length) this.stands = this._rampSpots();
  }

  // Spots on the apron: the taxilane / apron-side nodes farthest from the
  // runways, each facing back toward the taxiway it came from.
  _rampSpots() {
    const G = this.graph, out = [];
    const rwDist = (x, z) => {
      let d = Infinity;
      for (const rw of this.runways) for (let i = 0; i + 1 < rw.pts.length; i++) d = Math.min(d, segDist(x, z, rw.pts[i], rw.pts[i + 1]));
      return d;
    };
    const cands = [];
    for (let n = 0; n < G.N; n++) {
      if (G.onRunway[n] >= 0) continue;
      const nb = G.taxiNeighbours(n);
      if (!nb.length) continue;
      const x = G.px(n), z = G.pz(n);
      if (Math.hypot(x - this.x, z - this.z) > 3000) continue;
      const d = rwDist(x, z);
      if (d < 150) continue;
      cands.push({ n, x, z, d, nb });
    }
    cands.sort((a, b) => b.d - a.d);
    for (const c of cands) {
      if (out.some((s) => Math.hypot(s.ex - c.x, s.ez - c.z) < 60)) continue;
      // Face away from the neighbour: pull in nose first along that last bit of taxiway.
      const m = c.nb[0], bx = G.px(m), bz = G.pz(m), l = Math.hypot(c.x - bx, c.z - bz) || 1;
      const fx = (c.x - bx) / l, fz = (c.z - bz) / l;
      out.push({ i: out.length, ref: String(out.length + 1), nodes: [m, c.n], taxiNode: m, ex: c.x + fx * 25, ez: c.z + fz * 25, fx, fz, heading: Math.atan2(fx, -fz), lead: makeGroundPath([[bx, bz], [c.x + fx * 25, c.z + fz * 25]]), room: 60, ramp: true });
      if (out.length >= 8) break;
    }
    return out;
  }

  nearestNode(x, z, filter = null) {
    const G = this.graph;
    let best = -1, bd = Infinity;
    for (let n = 0; n < G.N; n++) {
      if (filter && !filter(n)) continue;
      const d = (G.px(n) - x) ** 2 + (G.pz(n) - z) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  // A taxi route from where the aircraft is (heading h) to node `to`, as a
  // ground path starting at the aircraft. Prefers a start node ahead of the nose.
  routeFrom(x, z, h, to, extra = [], speed = 0) {
    const G = this.graph, fx = Math.sin(h), fz = -Math.cos(h);
    let best = -1, bs = Infinity;
    // Still rolling down a runway: on to an exit ahead with room to slow for it
    // (no U-turns at speed), the one that makes the shortest way to `to`.
    const on = speed > 4 ? this.onRunway(x, z, 10, h) : null;
    if (on) {
      const exits = [];
      for (let n = 0; n < G.N; n++) {
        if (G.onRunway[n] !== on.rw.ri || G.taxiNeighbours(n).length === 0) continue;
        const ahead = (G.px(n) - x) * fx + (G.pz(n) - z) * fz;
        if (ahead >= Math.max(15, (speed * speed) / 3)) exits.push({ n, ahead });
      }
      exits.sort((a, b) => a.ahead - b.ahead);
      for (const ex of exits.slice(0, 4)) {
        const nodes = G.route(ex.n, to);
        if (!nodes) continue;
        // Not back up the runway behind her.
        if (nodes.length > 1 && G.onRunway[nodes[1]] === on.rw.ri && (G.px(nodes[1]) - G.px(ex.n)) * fx + (G.pz(nodes[1]) - G.pz(ex.n)) * fz < 0) continue;
        let len = ex.ahead;
        for (let i = 1; i < nodes.length; i++) len += Math.hypot(G.px(nodes[i]) - G.px(nodes[i - 1]), G.pz(nodes[i]) - G.pz(nodes[i - 1]));
        if (len < bs) { bs = len; best = ex.n; }
      }
      bs = Infinity;
    }
    if (best < 0) for (let n = 0; n < G.N; n++) {
      if (G.onRunway[n] >= 0 && G.taxiNeighbours(n).length === 0) continue;
      const dx = G.px(n) - x, dz = G.pz(n) - z, d = Math.hypot(dx, dz);
      if (d > 400) continue;
      const ahead = (dx * fx + dz * fz) / (d || 1);
      const s = d * (ahead > 0.2 ? 1 : 2.5);
      if (s < bs) { bs = s; best = n; }
    }
    if (best < 0) best = this.nearestNode(x, z);
    const nodes = G.route(best, to);
    if (!nodes) return null;
    const pts = [[x, z], ...nodes.map((n) => [G.px(n), G.pz(n)]), ...extra];
    return { nodes: [-1, ...nodes, ...extra.map(() => -1)], path: makeGroundPath(pts, [-1, ...nodes, ...extra.map(() => -1)]) };
  }

  // Runway end for taking off or landing: into the wind among runways long
  // enough (need, m); ties go to the longer one.
  bestEnd(windFromHeading, windSpeed, need = 0) {
    let best = null, bs = -Infinity;
    for (const e of this.ends.values()) {
      const head = Math.cos(wrapAngle(windFromHeading - e.heading)) * windSpeed;
      const s = head * 3 + (e.length >= need ? 1000 : -1000 + e.length * 0.1) + e.length * 0.002;
      if (s > bs) { bs = s; best = e; }
    }
    return best;
  }

  // Hold-short point on a route heading for runway end `e`: well clear of the runway edge.
  holdOn(route, e) {
    const P = route.path, G = this.graph;
    for (let i = 1; i < route.nodes.length; i++) {
      const n = route.nodes[i];
      if (n >= 0 && G.onRunway[n] === e.rw.ri) {
        const s = Math.max(0, P.s[i] - e.rw.width / 2 - 45);
        return { s, node: n, at: P.at(s) };
      }
    }
    return null;
  }

  // Which runway (and where along it) a point is on: { rw, end, along, across } or null.
  // heading: where two runways cross, the one she's lined up with.
  onRunway(x, z, margin = 4, heading = null) {
    let best = null, bs = Infinity;
    for (const rw of this.runways) {
      const e = rw.ends[0];
      const dx = x - e.x, dz = z - e.z, along = dx * e.fx + dz * e.fz, across = dx * -e.fz + dz * e.fx;
      if (!(along >= -60 && along <= rw.length + 60 && Math.abs(across) <= rw.width / 2 + margin)) continue;
      const s = heading === null ? 0 : 1 - Math.abs(Math.cos(wrapAngle(heading - e.heading)));
      if (s < bs) { bs = s; best = { rw, along, across }; }
    }
    return best;
  }

  // The 3-degree approach to runway end e: lateral and vertical deviation of
  // a point, its distance to the threshold, and the glidepath height there.
  // span: the aircraft's wingspan (small ones aim closer to the threshold).
  approach(e, x, y, z, span = 36) {
    const dx = x - e.x, dz = z - e.z;
    const along = -(dx * e.fx + dz * e.fz);              // m before the threshold
    const across = dx * -e.fz + dz * e.fx;
    const aim = Math.min(400, e.length * 0.18, 110 + span * 5);   // aiming point past the threshold
    const gs = (along + aim) * Math.tan(3 * Math.PI / 180) + this.elev + GP_OVER;
    return { along, across, gs, dy: y - gs, loc: Math.atan2(across, Math.max(30, along + e.length)), gsAng: Math.atan2(y - this.elev - GP_OVER, Math.max(30, along + aim)) - 3 * Math.PI / 180 };
  }

  // Runway end the aircraft looks lined up for (heading within 30°, ahead of it, within 25 km).
  alignedEnd(x, z, h) {
    let best = null, bd = Infinity;
    for (const e of this.ends.values()) {
      const dx = x - e.x, dz = z - e.z, before = -(dx * e.fx + dz * e.fz), across = Math.abs(dx * -e.fz + dz * e.fx);
      if (before < -e.length * 0.3 || before > 25000) continue;
      if (Math.abs(wrapAngle(h - e.heading)) > 0.55) continue;
      const score = across + Math.abs(before) * 0.05;
      if (score < bd) { bd = score; best = e; }
    }
    return best;
  }
}

function segDist(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
  const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / l2, 0, 1);
  return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
}

export { AERO };
