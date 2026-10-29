// Road network graph built from the OSM drivable ways: adjacency, connected
// components, nearest-road lookups and A* routing for GPS / AI traffic.

import { MinHeap } from './util.js';
import { SegmentGrid, PointGrid } from './spatial.js';
import { RC } from './mapdata.js';

const CLASS_COST = [0.72, 0.8, 0.9, 0.95, 1.0, 1.12, 1.4, 3.0];

export class RoadGraph {
  constructor(map) {
    this.map = map;
    const nodes = map.nodes;
    const N = (this.N = nodes.length / 2);
    this.nodes = nodes;

    // Directed edges: every segment in both directions; one-way legality kept separately.
    const ef = [], et = [], er = [], es = [], el = [], ed = [];
    const deg = new Uint8Array(N);
    for (const r of map.roads) {
      const ns = r.nodes;
      for (let i = 0; i + 1 < ns.length; i++) {
        const a = ns[i], b = ns[i + 1];
        if (a === b) continue;
        const len = Math.hypot(nodes[2 * b] - nodes[2 * a], nodes[2 * b + 1] - nodes[2 * a + 1]);
        if (deg[a] < 255) deg[a]++;
        if (deg[b] < 255) deg[b]++;
        ef.push(a, b); et.push(b, a); er.push(r.id, r.id); es.push(i, i); el.push(len, len); ed.push(1, 0);
      }
    }
    const E = ef.length;
    this.eFrom = Int32Array.from(ef);
    this.eTo = Int32Array.from(et);
    this.eRoad = Int32Array.from(er);
    this.eSeg = Int32Array.from(es);
    this.eLen = Float32Array.from(el);
    this.eFwd = Uint8Array.from(ed);
    this.eLegal = new Uint8Array(E);
    for (let e = 0; e < E; e++) this.eLegal[e] = this.eFwd[e] || !map.roads[this.eRoad[e]].oneway ? 1 : 0;
    this.deg = deg;

    const start = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) start[this.eFrom[e] + 1]++;
    for (let i = 0; i < N; i++) start[i + 1] += start[i];
    const adj = new Int32Array(E);
    const fill = start.slice(0, N);
    for (let e = 0; e < E; e++) adj[fill[this.eFrom[e]]++] = e;
    this.adjStart = start;
    this.adj = adj;

    // Connected components (undirected). The largest is the playable network.
    const comp = new Int32Array(N).fill(-1);
    const sizes = [];
    const stack = [];
    for (let s = 0; s < N; s++) {
      if (comp[s] >= 0 || start[s] === start[s + 1]) continue;
      const c = sizes.length;
      let size = 0;
      comp[s] = c;
      stack.push(s);
      while (stack.length) {
        const u = stack.pop();
        size++;
        for (let k = start[u]; k < start[u + 1]; k++) {
          const v = this.eTo[adj[k]];
          if (comp[v] < 0) { comp[v] = c; stack.push(v); }
        }
      }
      sizes.push(size);
    }
    this.comp = comp;
    this.mainComp = sizes.indexOf(Math.max(...sizes));
    this.inSCC = this._legalSCC();

    const bounds = map.meta.play;
    // Segment index for "which road am I on" queries.
    this.segGrid = new SegmentGrid(bounds, 24);
    for (const r of map.roads) {
      const ns = r.nodes;
      for (let i = 0; i + 1 < ns.length; i++) {
        const a = ns[i], b = ns[i + 1];
        this.segGrid.add(nodes[2 * a], nodes[2 * a + 1], nodes[2 * b], nodes[2 * b + 1], r.id, i);
      }
    }
    this.segGrid.build();

    // Main-network nodes for snapping (exclude service roads where possible).
    this.nodeGrid = new PointGrid(bounds, 40);
    this.nodeClass = new Uint8Array(N).fill(255);
    for (const r of map.roads) for (const n of r.nodes) this.nodeClass[n] = Math.min(this.nodeClass[n], r.cls);
    for (let i = 0; i < N; i++) {
      if (comp[i] === this.mainComp) this.nodeGrid.add(nodes[2 * i], nodes[2 * i + 1], i);
    }
    this.nodeGrid.build();

    this._g = new Float64Array(N);
    this._prev = new Int32Array(N);
    this._stamp = new Uint32Array(N);
    this._closed = new Uint32Array(N);
    this._sid = 0;
  }

  // Largest strongly connected component of the one-way-legal graph
  // (iterative Kosaraju). Any two nodes in it have a legal route between them.
  _legalSCC() {
    const N = this.N, E = this.eFrom.length;
    const start = this.adjStart, adj = this.adj;
    // Reverse legal adjacency.
    const rStart = new Int32Array(N + 1);
    for (let e = 0; e < E; e++) if (this.eLegal[e]) rStart[this.eTo[e] + 1]++;
    for (let i = 0; i < N; i++) rStart[i + 1] += rStart[i];
    const rAdj = new Int32Array(rStart[N]);
    const fill = rStart.slice(0, N);
    for (let e = 0; e < E; e++) if (this.eLegal[e]) rAdj[fill[this.eTo[e]]++] = this.eFrom[e];
    // Pass 1: finish order on the forward graph.
    const order = new Int32Array(N);
    let oc = 0;
    const seen = new Uint8Array(N);
    const stackN = new Int32Array(N), stackK = new Int32Array(N);
    for (let s = 0; s < N; s++) {
      if (seen[s] || start[s] === start[s + 1]) continue;
      let sp = 0;
      stackN[0] = s; stackK[0] = start[s]; seen[s] = 1;
      while (sp >= 0) {
        const u = stackN[sp];
        let k = stackK[sp];
        let pushed = false;
        while (k < start[u + 1]) {
          const e = adj[k++];
          if (!this.eLegal[e]) continue;
          const v = this.eTo[e];
          if (!seen[v]) {
            stackK[sp] = k;
            seen[v] = 1;
            sp++;
            stackN[sp] = v; stackK[sp] = start[v];
            pushed = true;
            break;
          }
        }
        if (!pushed) { order[oc++] = u; sp--; }
      }
    }
    // Pass 2: components on the reverse graph in reverse finish order.
    const comp = new Int32Array(N).fill(-1);
    const sizes = [];
    for (let i = oc - 1; i >= 0; i--) {
      const s = order[i];
      if (comp[s] >= 0) continue;
      const c = sizes.length;
      let size = 0, sp = 0;
      stackN[0] = s; comp[s] = c;
      while (sp >= 0) {
        const u = stackN[sp--];
        size++;
        for (let k = rStart[u]; k < rStart[u + 1]; k++) {
          const v = rAdj[k];
          if (comp[v] < 0) { comp[v] = c; stackN[++sp] = v; }
        }
      }
      sizes.push(size);
    }
    const main = sizes.indexOf(Math.max(...sizes));
    const inSCC = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (comp[i] === main) inSCC[i] = 1;
    this.sccSize = sizes[main];
    return inSCC;
  }

  nx(i) { return this.nodes[2 * i]; }
  nz(i) { return this.nodes[2 * i + 1]; }

  // Nearest main-network node; maxClass limits to bigger roads (e.g. RC.LIVING).
  // legal=true restricts to the strongly connected one-way-legal network.
  nearestNode(x, z, maxClass = RC.SERVICE, radius = 400, legal = false, filter = null, y = null) {
    for (let r = 60; r <= radius * 2; r *= 2) {
      const n = this.nodeGrid.query(x, z, r);
      let best = -1, bd = Infinity;
      for (let k = 0; k < n; k++) {
        const p = this.nodeGrid.result[k];
        const node = this.nodeGrid.pts[3 * p + 2];
        if (this.nodeClass[node] > maxClass) continue;
        if (legal && !this.inSCC[node]) continue;
        if (filter && !filter(node)) continue;
        let d = (this.nodeGrid.pts[3 * p] - x) ** 2 + (this.nodeGrid.pts[3 * p + 1] - z) ** 2;
        if (y !== null) d += ((this.map.nodeY[node] - y) * 4) ** 2;
        if (d < bd) { bd = d; best = node; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  // Nearest road segment: returns { road, seg, t, x, z, dist } or null.
  nearestRoad(x, z, maxDist = 40, filter) {
    const out = {};
    const g = this.segGrid;
    const i = g.nearest(x, z, maxDist, filter ? (s) => filter(this.map.roads[g.meta[s]]) : null, out);
    if (i < 0) return null;
    return { road: g.meta[i], seg: g.meta2[i], t: out.t, x: out.x, z: out.z, dist: out.dist };
  }

  // Nearest road segment preferring ones at a similar height to y (so the
  // street name / respawn picks the tunnel you're in, not the street above).
  nearestRoad3D(x, z, y, maxDist = 40, filter) {
    const g = this.segGrid, s = g.segs, ny = this.map.nodeY, roads = this.map.roads;
    const n = g.query(x, z, maxDist);
    let best = null, bs = Infinity;
    for (let k = 0; k < n; k++) {
      const i = g.result[k];
      const road = roads[g.meta[i]];
      if (filter && !filter(road)) continue;
      const ax = s[4 * i], az = s[4 * i + 1], bx = s[4 * i + 2], bz = s[4 * i + 3];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const px = ax + dx * t, pz = az + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d > maxDist) continue;
      const seg = g.meta2[i];
      const ry = ny[road.nodes[seg]] + (ny[road.nodes[seg + 1]] - ny[road.nodes[seg]]) * t;
      const score = d * d + ((ry - y) * 4) ** 2;
      if (score < bs) { bs = score; best = { road: g.meta[i], seg, t, x: px, z: pz, dist: d, y: ry }; }
    }
    return best;
  }

  // Is (x, z) within `margin` of the carriageway of any road lower than
  // maxY? Every level counts, so a deck can't hide the street under it.
  roadBelow(x, z, maxY, margin = 0) {
    const g = this.segGrid, s = g.segs, ny = this.map.nodeY, roads = this.map.roads;
    const n = g.query(x, z, 24 + margin);
    for (let k = 0; k < n; k++) {
      const i = g.result[k];
      const road = roads[g.meta[i]];
      const ax = s[4 * i], az = s[4 * i + 1], bx = s[4 * i + 2], bz = s[4 * i + 3];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      if (Math.hypot(x - ax - dx * t, z - az - dz * t) > road.width / 2 + margin) continue;
      const seg = g.meta2[i];
      if (ny[road.nodes[seg]] + (ny[road.nodes[seg + 1]] - ny[road.nodes[seg]]) * t < maxY) return true;
    }
    return false;
  }

  // A* route between nodes; returns node index array or null.
  // Wrong-way travel on one-way streets is allowed but penalised (GPS), or
  // forbidden entirely (traffic) with strict=true. Never on highways or ramps:
  // those are walled and lead nowhere a driver would go backwards.
  route(from, to, { strict = false, wrongWay = 4 } = {}) {
    if (from < 0 || to < 0) return null;
    if (from === to) return [from];
    const sid = ++this._sid;
    const g = this._g, prev = this._prev, stamp = this._stamp, closed = this._closed;
    const tx = this.nx(to), tz = this.nz(to);
    const h = (n) => Math.hypot(this.nx(n) - tx, this.nz(n) - tz) * 0.72;
    const heap = new MinHeap();
    stamp[from] = sid; g[from] = 0; prev[from] = -1;
    heap.push(from, h(from));
    const roads = this.map.roads;
    let iter = 0;
    while (heap.size) {
      const u = heap.pop();
      if (closed[u] === sid) continue;
      closed[u] = sid;
      if (u === to) break;
      if (++iter > 400000) return null;
      const gu = g[u];
      for (let k = this.adjStart[u], e2 = this.adjStart[u + 1]; k < e2; k++) {
        const e = this.adj[k];
        const legal = this.eLegal[e];
        if (strict && !legal) continue;
        const v = this.eTo[e];
        if (closed[v] === sid) continue;
        const road = roads[this.eRoad[e]], cls = road.cls;
        if (!legal && (road.link || cls <= RC.TRUNK)) continue;
        const cost = this.eLen[e] * CLASS_COST[cls] * (legal ? 1 : wrongWay);
        const gv = gu + cost;
        if (stamp[v] !== sid || gv < g[v]) {
          stamp[v] = sid; g[v] = gv; prev[v] = u;
          heap.push(v, gv + h(v));
        }
      }
    }
    if (closed[to] !== sid) return null;
    const path = [];
    for (let n = to; n !== -1; n = prev[n]) path.push(n);
    path.reverse();
    return path;
  }

  pathLength(path) {
    let s = 0;
    for (let i = 0; i + 1 < path.length; i++) s += Math.hypot(this.nx(path[i + 1]) - this.nx(path[i]), this.nz(path[i + 1]) - this.nz(path[i]));
    return s;
  }

  // Outgoing directed edges from node n (optionally only legal ones).
  *outEdges(n, legalOnly = true) {
    for (let k = this.adjStart[n]; k < this.adjStart[n + 1]; k++) {
      const e = this.adj[k];
      if (!legalOnly || this.eLegal[e]) yield e;
    }
  }
}
