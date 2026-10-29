// Infers road elevations from OSM bridge/tunnel/layer tags.
//
// OSM has no heights, only vertical order. We fix the elevation of nodes we
// can reason about and interpolate the rest along the road graph:
//   - bridge interiors: high enough to clear whatever they cross
//     (6.5 m over roads, 3 m over water, 1 m otherwise; highways by layer)
//   - local bridges over at-grade highways stay near grade and the highway
//     drops into a trench instead (Back Bay's Mass Pike)
//   - tunnel interiors: -7.5 m per layer; portals -5.6 m
//   - at-grade intersections of local streets: 0
// Everything else is solved as a harmonic function (weighted by 1/length),
// which turns approach roads and highway ramps into smooth linear ramps.

const DECK_ROAD = 6.5, DECK_WATER = 3.0, DECK_MIN = 1.0, DECK_OVER_HIGHWAY = 0.4;
const TRENCH = -6.0, TUNNEL = -7.5, PORTAL = -5.6, DEPRESSED = -5.0;
const MAX_GRADE = 0.11;
// Weak spring toward grade so long free highway stretches settle at 0
// a couple of hundred meters away from any structure.
const LAMBDA = 1 / 1500;

export const ROAD_FLAGS = { ONEWAY: 1, BRIDGE: 2, LINK: 4, ROUNDABOUT: 8, TUNNEL: 16, DEPRESSED: 32 };
const F = ROAD_FLAGS;

function segIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return false;
  const qx = cx - ax, qz = cz - az;
  const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}

export function solveElevations({ nodes, roads }, { isWater, railLines = [], log = () => {} }) {
  const N = nodes.length / 2;
  const nx = (i) => nodes[2 * i], nz = (i) => nodes[2 * i + 1];
  const isLocal = (r) => r.cls >= 2;
  const isGroundLocal = (r) => r.cls >= 2 && r.cls <= 6 && !(r.flags & (F.BRIDGE | F.TUNNEL | F.DEPRESSED)) && r.layer === 0;
  const kindLayer = (r) => (r.flags & F.TUNNEL ? Math.min(-1, r.layer) : r.flags & F.BRIDGE ? Math.max(1, r.layer) : r.flags & F.DEPRESSED ? Math.min(-1, r.layer) : r.layer);

  // ---- adjacency + per-node stats
  const deg = new Uint16Array(N), groundEdges = new Uint16Array(N), tunnelEdges = new Uint16Array(N), otherEdges = new Uint16Array(N);
  const nbr = new Array(N);
  for (let i = 0; i < N; i++) nbr[i] = [];
  for (const r of roads) {
    const gl = isGroundLocal(r), tun = !!(r.flags & F.TUNNEL);
    for (let i = 0; i + 1 < r.nodes.length; i++) {
      const a = r.nodes[i], b = r.nodes[i + 1];
      if (a === b) continue;
      const w = 1 / Math.max(0.5, Math.hypot(nx(b) - nx(a), nz(b) - nz(a)));
      nbr[a].push(b, w); nbr[b].push(a, w);
      deg[a]++; deg[b]++;
      if (gl) { groundEdges[a]++; groundEdges[b]++; }
      if (tun) { tunnelEdges[a]++; tunnelEdges[b]++; } else { otherEdges[a]++; otherEdges[b]++; }
    }
  }

  // ---- segment grid for crossing detection
  const C = 40;
  const grid = new Map();
  const segs = [];
  const addSeg = (ax, az, bx, bz, info) => {
    const k = segs.length;
    segs.push({ ax, az, bx, bz, ...info });
    for (let gx = Math.floor(Math.min(ax, bx) / C); gx <= Math.floor(Math.max(ax, bx) / C); gx++)
      for (let gz = Math.floor(Math.min(az, bz) / C); gz <= Math.floor(Math.max(az, bz) / C); gz++) {
        const key = gx * 100003 + gz;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(k);
      }
  };
  roads.forEach((r, ri) => {
    for (let i = 0; i + 1 < r.nodes.length; i++) {
      const a = r.nodes[i], b = r.nodes[i + 1];
      addSeg(nx(a), nz(a), nx(b), nz(b), { ri, a, b, rail: false });
    }
  });
  for (const rl of railLines) for (let i = 0; i + 1 < rl.length; i++) addSeg(rl[i][0], rl[i][1], rl[i + 1][0], rl[i + 1][1], { ri: -1, rail: true });

  // ---- bridge deck heights from what they cross
  const deck = new Float32Array(roads.length);
  const trenchNodes = new Set();
  const crossAt = roads.map(() => []);   // bridge way -> segment indices with a crossing
  roads.forEach((r, ri) => {
    if (!(r.flags & F.BRIDGE)) return;
    let d = DECK_MIN;
    if (!isLocal(r)) d = Math.max(d, DECK_ROAD * Math.max(1, r.layer));
    let overWater = false;
    for (let i = 0; i + 1 < r.nodes.length; i++) {
      const a = r.nodes[i], b = r.nodes[i + 1];
      for (let k = 1; k < 4; k++) if (isWater(nx(a) + ((nx(b) - nx(a)) * k) / 4, nz(a) + ((nz(b) - nz(a)) * k) / 4)) overWater = true;
    }
    if (overWater) d = Math.max(d, DECK_WATER);
    deck[ri] = d;
  });
  // Two passes so stacked bridges (interchanges) settle.
  let trenches = 0;
  for (let pass = 0; pass < 2; pass++) {
    roads.forEach((r, ri) => {
      if (!(r.flags & F.BRIDGE)) return;
      const myLayer = kindLayer(r);
      for (let i = 0; i + 1 < r.nodes.length; i++) {
        const a = r.nodes[i], b = r.nodes[i + 1];
        const ax = nx(a), az = nz(a), bx = nx(b), bz = nz(b);
        const seen = new Set();
        for (let gx = Math.floor(Math.min(ax, bx) / C); gx <= Math.floor(Math.max(ax, bx) / C); gx++)
          for (let gz = Math.floor(Math.min(az, bz) / C); gz <= Math.floor(Math.max(az, bz) / C); gz++) {
            for (const k of grid.get(gx * 100003 + gz) || []) {
              if (seen.has(k)) continue;
              seen.add(k);
              const s = segs[k];
              if (s.ri === ri) continue;
              if (!s.rail && (s.a === a || s.a === b || s.b === a || s.b === b)) continue;
              if (!segIntersect(ax, az, bx, bz, s.ax, s.az, s.bx, s.bz)) continue;
              if (pass === 0) crossAt[ri].push(i);
              if (s.rail) { deck[ri] = Math.max(deck[ri], DECK_MIN); continue; }
              const lo = roads[s.ri];
              const loLayer = kindLayer(lo);
              if (loLayer >= myLayer) continue;      // we are the lower one
              if (lo.flags & F.TUNNEL) continue;     // tunnels are underground anyway
              if (isLocal(r) && lo.cls <= 1 && !(lo.flags & F.BRIDGE)) {
                // Street over an at-grade highway: sink the highway instead.
                deck[ri] = Math.max(deck[ri], DECK_OVER_HIGHWAY);
                if (pass === 0) { trenchNodes.add(s.a); trenchNodes.add(s.b); trenches++; }
              } else {
                const below = lo.flags & F.BRIDGE ? deck[s.ri] : lo.flags & F.DEPRESSED ? DEPRESSED : 0;
                deck[ri] = Math.max(deck[ri], below + DECK_ROAD);
              }
            }
          }
      }
    });
  }

  // ---- fixed constraints
  const fixed = new Uint8Array(N);
  const target = new Float32Array(N);
  const prio = new Uint8Array(N);
  const fix = (n, v, p) => {
    if (p < prio[n]) return;
    if (p === prio[n] && fixed[n]) { target[n] = Math.abs(v) > Math.abs(target[n]) ? v : target[n]; return; }
    fixed[n] = 1; target[n] = v; prio[n] = p;
  };
  // At-grade local intersections and dead ends.
  for (let i = 0; i < N; i++) {
    if ((groundEdges[i] >= 2 && deg[i] >= 3) || (groundEdges[i] >= 1 && deg[i] === 1)) fix(i, 0, 1);
  }
  for (const n of trenchNodes) fix(n, TRENCH, 2);
  // Distance along each way, for ramp zones near its ends.
  const along = (r) => {
    const out = [0];
    for (let i = 1; i < r.nodes.length; i++) out.push(out[i - 1] + Math.hypot(nx(r.nodes[i]) - nx(r.nodes[i - 1]), nz(r.nodes[i]) - nz(r.nodes[i - 1])));
    return out;
  };
  // Pin interior nodes of a way: everywhere `must` says so, plus the middle
  // section away from the ends (leaving ramp zones free to interpolate).
  const pinWay = (r, value, p, rampMax, must) => {
    const ns = r.nodes, last = ns.length - 1;
    if (last < 2) return;
    const s2 = along(r), L = s2[last];
    const ramp = Math.min(rampMax, L * 0.3);
    let pinned = 0;
    for (let i = 1; i < last; i++) {
      if ((s2[i] >= ramp && L - s2[i] >= ramp) || (must && must(i))) { fix(ns[i], value, p); pinned++; }
    }
    if (!pinned) fix(ns[Math.floor(last / 2)], value, p);
  };
  roads.forEach((r, ri) => {
    const ns = r.nodes, last = ns.length - 1;
    if (r.flags & F.BRIDGE) {
      // Full deck height where it actually crosses something or spans water.
      const near = new Set();
      for (const seg of crossAt[ri]) for (let k = Math.max(1, seg - 1); k <= Math.min(last - 1, seg + 2); k++) near.add(k);
      const s2 = along(r), L = s2[last];
      const waterPin = (i) => isLocal(r) && s2[i] > 10 && L - s2[i] > 10 && isWater(nx(ns[i]), nz(ns[i]));
      pinWay(r, deck[ri], 4, isLocal(r) ? 18 : 30, (i) => near.has(i) || waterPin(i));
    } else if (r.flags & F.TUNNEL) {
      const depth = TUNNEL * (1 + 0.5 * (Math.max(1, -r.layer) - 1));
      // Short tunnel links between other tunnel ways just interpolate.
      const s2 = along(r);
      const tunnelBothEnds = tunnelEdges[ns[0]] > 1 && tunnelEdges[ns[last]] > 1;
      if (!(s2[last] < 50 && tunnelBothEnds)) pinWay(r, depth, 4, 45);
      for (const e of [ns[0], ns[last]]) {
        // Portal: where the tunnel meets the surface network.
        if (otherEdges[e] > 0 && tunnelEdges[e] > 0 && groundEdges[e] === 0) fix(e, PORTAL, 3);
      }
    } else if (r.flags & F.DEPRESSED) {
      pinWay(r, DEPRESSED * Math.max(1, -r.layer), 3, 30);
    }
  });

  // ---- keep pinned heights reachable: cap by graph distance to grade
  const dist0 = new Float64Array(N).fill(Infinity);
  {
    const hn = [], hd = [];
    const push = (n, d) => {
      let i = hn.length; hn.push(n); hd.push(d);
      while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= d) break; hn[i] = hn[p]; hd[i] = hd[p]; i = p; }
      hn[i] = n; hd[i] = d;
    };
    const pop = () => {
      const top = hn[0], ln = hn.pop(), ld = hd.pop();
      if (hn.length) {
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r2 = l + 1;
          let m = i, md = ld;
          if (l < hn.length && hd[l] < md) { m = l; md = hd[l]; }
          if (r2 < hn.length && hd[r2] < md) { m = r2; md = hd[r2]; }
          if (m === i) break;
          hn[i] = hn[m]; hd[i] = hd[m]; i = m;
        }
        hn[i] = ln; hd[i] = ld;
      }
      return top;
    };
    for (let i = 0; i < N; i++) if (fixed[i] && prio[i] === 1) { dist0[i] = 0; push(i, 0); }
    while (hn.length) {
      const d0 = hd[0], u = pop();
      if (d0 > dist0[u]) continue;
      const nb = nbr[u];
      for (let k = 0; k < nb.length; k += 2) {
        const v = nb[k], nd = d0 + 1 / nb[k + 1];
        if (nd < dist0[v]) { dist0[v] = nd; push(v, nd); }
      }
    }
  }
  let capped = 0;
  for (let i = 0; i < N; i++) {
    if (!fixed[i] || prio[i] <= 1) continue;
    const cap = MAX_GRADE * dist0[i];
    if (Math.abs(target[i]) > cap) { target[i] = Math.sign(target[i]) * cap; capped++; }
  }
  // Adjacent pins from different ways (e.g. layer 1 deck meeting layer 2 deck).
  for (let pass = 0; pass < 40; pass++) {
    let changed = false;
    for (let a = 0; a < N; a++) {
      if (!fixed[a] || prio[a] <= 1) continue;
      const nb = nbr[a];
      for (let k = 0; k < nb.length; k += 2) {
        const b = nb[k];
        if (!fixed[b] || prio[b] <= 1) continue;
        const lim = MAX_GRADE / nb[k + 1];
        const d = target[a] - target[b];
        if (Math.abs(d) <= lim + 1e-6) continue;
        if (Math.abs(target[a]) > Math.abs(target[b])) target[a] = target[b] + Math.sign(d) * lim;
        else target[b] = target[a] - Math.sign(d) * lim;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // ---- harmonic interpolation for free nodes (SOR)
  const elev = new Float32Array(N);
  for (let i = 0; i < N; i++) if (fixed[i]) elev[i] = target[i];
  const free = [];
  for (let i = 0; i < N; i++) if (!fixed[i] && nbr[i].length) free.push(i);
  const omega = 1.9;
  let it = 0, maxDelta = 0;
  for (it = 0; it < 4000; it++) {
    maxDelta = 0;
    for (const i of free) {
      const nb = nbr[i];
      let s = 0, w = 0;
      for (let k = 0; k < nb.length; k += 2) { s += elev[nb[k]] * nb[k + 1]; w += nb[k + 1]; }
      const v = s / (w + LAMBDA);
      const nv = elev[i] + omega * (v - elev[i]);
      const d = Math.abs(nv - elev[i]);
      if (d > maxDelta) maxDelta = d;
      elev[i] = nv;
    }
    if (maxDelta < 2e-4) break;
  }

  // ---- final gradient limiter on free nodes
  for (let pass = 0; pass < 60; pass++) {
    let changed = 0;
    for (const i of free) {
      const nb = nbr[i];
      let lo = -Infinity, hi = Infinity;
      for (let k = 0; k < nb.length; k += 2) {
        const lim = (MAX_GRADE * 1.25) / nb[k + 1];
        lo = Math.max(lo, elev[nb[k]] - lim);
        hi = Math.min(hi, elev[nb[k]] + lim);
      }
      let v = elev[i];
      if (lo > hi) v = (lo + hi) / 2;
      else v = Math.min(hi, Math.max(lo, v));
      if (Math.abs(v - elev[i]) > 1e-4) { elev[i] = v; changed++; }
    }
    if (!changed) break;
  }

  // ---- stats
  let nonZero = 0, maxSlope = 0;
  const slopes = [];
  for (let i = 0; i < N; i++) if (Math.abs(elev[i]) > 0.05) nonZero++;
  for (const r of roads) {
    for (let i = 0; i + 1 < r.nodes.length; i++) {
      const a = r.nodes[i], b = r.nodes[i + 1];
      const L = Math.hypot(nx(b) - nx(a), nz(b) - nz(a));
      if (L < 1) continue;
      const sl = Math.abs(elev[b] - elev[a]) / L;
      if (sl > 0.005) slopes.push(sl);
      if (sl > maxSlope) maxSlope = sl;
    }
  }
  slopes.sort((p, q) => p - q);
  const p95 = slopes.length ? slopes[Math.floor(slopes.length * 0.95)] : 0;
  log(`elevation: ${free.length} free nodes solved in ${it} iterations; ${nonZero} non-zero nodes; ${trenches} trench crossings; ${capped} pins capped; slope p95 ${(p95 * 100).toFixed(1)}% max ${(maxSlope * 100).toFixed(0)}%`);
  return { elev, deck };
}

// Elevation profile for a decorative rail bridge (trapezoid ramps inside the way).
export function railProfile(pts, deckH) {
  const n = pts.length;
  const s = [0];
  for (let i = 1; i < n; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = s[n - 1];
  const ramp = Math.min(60, L / 3);
  return s.map((v) => deckH * Math.min(1, v / ramp, (L - v) / ramp));
}
