// Loads data/boston.json (produced by tools/build-map.mjs) and decodes it
// into typed arrays / plain objects. World units are meters: +x east, +z south.

import { Terrain } from './terrain.js';

export const RC = { MOTORWAY: 0, TRUNK: 1, PRIMARY: 2, SECONDARY: 3, TERTIARY: 4, RESIDENTIAL: 5, LIVING: 6, SERVICE: 7 };

export const AREA = {
  PARK: 1, GRASS: 2, PITCH: 3, GOLF: 4, CEMETERY: 5, WOOD: 6, PLAYGROUND: 7, TRACK: 8, SAND: 9,
  WETLAND: 10, GARDEN: 11, RAILYARD: 12, DIRT: 13, PARKING: 20, PLAZA: 21, PIER: 22, FUEL: 23, APRON: 24,
};

// Airport taxi-graph way kinds (tools/aero.mjs).
export const AERO = { RUNWAY: 0, TAXIWAY: 1, TAXILANE: 2, LEADIN: 3, CONNECTOR: 4 };

// Rail: which trains run on a way, and node / way flags (tools/build-map.mjs).
export const RAIL_SVC = { RED: 1, ORANGE: 2, BLUE: 4, GREEN: 8, COMMUTER: 16, AMTRAK: 32, FREIGHT: 64 };
export const RAIL_NODE = { PORTAL: 1, STOP: 2, BUFFER: 4, EDGE: 8 };
export const RAIL_WAY = { BRIDGE: 1, YARD: 2, CROSSOVER: 4, TUNNEL: 8 };

// Landmark ids assigned by tools/build-map.mjs.
export const LANDMARK = {
  FENWAY: 1, GREEN_MONSTER: 2, STATE_HOUSE: 3, HANCOCK: 4, PRUDENTIAL: 5, CUSTOM_HOUSE: 6, OLD_NORTH: 7,
  TRINITY: 8, BUNKER_HILL: 9, CONSTITUTION: 10, FANEUIL: 11, QUINCY: 12, BPL: 13, TD_GARDEN: 14,
  GREAT_DOME: 15, MOTHER_CHURCH: 16, OLD_STATE_HOUSE: 17, SYMPHONY: 18,
};

export const SIDEWALK_W = 2.4;
export const hasSidewalk = (r) => r.cls >= RC.PRIMARY && r.cls <= RC.LIVING && !r.link;

// Typical travel speed (m/s) per road class for AI and route timing.
export const CLASS_SPEED = [26, 20, 14.5, 13.5, 12.5, 10.5, 7, 6];

export async function loadMap(url, onProgress) {
  // The terrain grid is a sibling binary file; fetch it alongside the JSON.
  const terrainBuf = fetch(url.replace(/[^/]*$/, 'terrain.bin')).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  const total = Number(res.headers.get('X-Raw-Length')) || Number(res.headers.get('Content-Length')) || 8.0e6;
  let text;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress?.(Math.min(1, got / Math.max(total, got * 1.02)));
    }
    const all = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    text = new TextDecoder().decode(all);
  } else {
    text = await res.text();
  }
  onProgress?.(1);
  const raw = JSON.parse(text);
  const tm = raw.meta.terrain, buf = await terrainBuf;
  const ok = tm && buf && buf.byteLength === tm.w * tm.h * 2;
  if (!ok) console.warn('data/terrain.bin missing or out of date (run tools/build-map.mjs); using flat ground');
  return decode(raw, ok ? Terrain.decode(tm, buf) : new Terrain(null, null));
}

const ring = (a) => Float32Array.from(a);

// Ground reference under raised roads and track: smoothed along them from
// where they meet the ground, so a deck doesn't step with a riverbank or a
// seawall underneath it. G: terrain at each node (updated in place).
function deckGround(G, rel, chains) {
  const N = G.length, up = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (rel[i] > 0.3) up[i] = 1;
  const deg = new Uint16Array(N + 1);
  for (const c of chains) for (let i = 0; i + 1 < c.length; i++) if (up[c[i]] || up[c[i + 1]]) { deg[c[i] + 1]++; deg[c[i + 1] + 1]++; }
  for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
  const nb = new Int32Array(deg[N]), fill = deg.slice(0, N);
  for (const c of chains) for (let i = 0; i + 1 < c.length; i++) if (up[c[i]] || up[c[i + 1]]) { nb[fill[c[i]]++] = c[i + 1]; nb[fill[c[i + 1]]++] = c[i]; }
  const list = [];
  for (let i = 0; i < N; i++) if (up[i] && deg[i + 1] > deg[i]) list.push(i);
  const next = new Float32Array(N);
  for (let pass = 0; pass < 120; pass++) {
    for (const i of list) {
      let s = G[i];
      for (let k = deg[i]; k < deg[i + 1]; k++) s += G[nb[k]];
      next[i] = s / (deg[i + 1] - deg[i] + 1);
    }
    for (const i of list) G[i] = next[i];
  }
}

function decode(raw, terrain) {
  const names = raw.names;
  const roads = raw.roads.map((r, id) => {
    const [cls, flags, lanes, w10, sh10, nameIdx, speed, nodes, layer] = r;
    return {
      id, cls, lanes, layer: layer || 0,
      oneway: !!(flags & 1), bridge: !!(flags & 2), link: !!(flags & 4), roundabout: !!(flags & 8),
      tunnel: !!(flags & 16), depressed: !!(flags & 32),
      width: w10 / 10, shoulder: sh10 / 10,
      name: names[nameIdx] || '',
      speedLimit: speed,
      nodes: Int32Array.from(nodes),
    };
  });
  // Road heights: nodeRel above/below the ground (the elevation solver's
  // output), nodeG the ground there, nodeY = nodeRel + nodeG (world height).
  const nodes = Float32Array.from(raw.nodes);
  const N = nodes.length / 2;
  const nodeRel = new Float32Array(N), nodeG = new Float32Array(N), nodeY = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    nodeRel[i] = raw.elev ? raw.elev[i] / 10 : 0;
    nodeG[i] = terrain.h(nodes[2 * i], nodes[2 * i + 1]);
  }
  deckGround(nodeG, nodeRel, roads.map((r) => r.nodes));
  for (let i = 0; i < N; i++) nodeY[i] = nodeRel[i] + nodeG[i];
  const buildings = raw.buildings.map(([h10, m10, color, roof, style, flags, rings, landmark, roofH10, stands]) => ({
    h: h10 / 10, minH: m10 / 10, color, roof, style,
    solid: !(flags & 1) && !(flags & 8), part: !!(flags & 2), pitched: !!(flags & 4), hidden: !!(flags & 8), dome: !!(flags & 16),
    rings: rings.map(ring), landmark: landmark || 0, roofH: (roofH10 || 0) / 10, stands: !!stands,
  }));
  // Buildings stand on the lowest ground under their footprint.
  for (const b of buildings) {
    const r = b.rings[0];
    let lo = Infinity;
    for (let i = 0; i < r.length; i += 2) lo = Math.min(lo, terrain.h(r[i], r[i + 1]));
    b.base = Number.isFinite(lo) ? lo : 0;
  }
  return {
    meta: raw.meta,
    terrain,
    nodes,
    nodeY, nodeRel, nodeG,
    roads,
    paths: raw.paths.map(([cls, w10, bridge, pts]) => ({ cls, width: w10 / 10, bridge: !!bridge, pts: ring(pts) })),
    piers: (raw.piers || []).map(([w10, pts]) => ({ width: w10 / 10, pts: ring(pts) })),
    crossings: raw.crossings.map(ring),
    buildings,
    land: raw.land.map((p) => p.map(ring)),
    water: raw.water.map((p) => p.map(ring)),
    waterLevels: Float32Array.from(raw.waterLevels || raw.water.map(() => 0), (v) => v / 10),
    waterHole: Uint8Array.from(raw.waterHole || raw.water.map(() => 0)),
    areas: raw.areas.map(([type, p]) => ({ type, rings: p.map(ring) })),
    ...decodeRail(raw, terrain),
    aero: decodeAero(raw.aero),
    trees: Float32Array.from(raw.trees),
    places: raw.places.map(([name, x, z, rank]) => ({ name, x, z, rank })),
    landmarks: raw.landmarks.map(([name, kind, x, z, node]) => ({ name, kind, x, z, node })),
    signals: Int32Array.from(raw.signals),
  };
}

function decodeRail(raw, terrain) {
  const railNodes = Float32Array.from(raw.railNodes || []);
  // As for roads: railRel relative to the ground, railY in the world.
  const railRel = Float32Array.from(raw.railY || [], (e) => e / 10);
  const railFlags = Uint8Array.from(raw.railFlags || []);
  const railWays = (raw.railWays || []).map(([kind, flags, svc, nodes, speed10]) => ({ kind, flags, svc, nodes: Int32Array.from(nodes), speed: (speed10 || 0) / 10, tunnel: !!(flags & RAIL_WAY.TUNNEL) }));
  const railG = Float32Array.from(railRel, (r, i) => terrain.h(railNodes[2 * i], railNodes[2 * i + 1]));
  deckGround(railG, railRel, railWays.map((w) => w.nodes));
  const railY = Float32Array.from(railRel, (r, i) => r + railG[i]);
  // Polylines for drawing track (with heights where raised).
  const rail = railWays.map((w) => {
    const pts = new Float32Array(w.nodes.length * 2), ys = new Float32Array(w.nodes.length), rels = new Float32Array(w.nodes.length);
    let raised = false;
    w.nodes.forEach((n, i) => { pts[2 * i] = railNodes[2 * n]; pts[2 * i + 1] = railNodes[2 * n + 1]; ys[i] = railY[n]; rels[i] = railRel[n]; if (Math.abs(railRel[n]) > 0.02) raised = true; });
    return { kind: w.kind, bridge: !!(w.flags & RAIL_WAY.BRIDGE), tunnel: w.tunnel, pts, ys: raised ? ys : null, rels: raised ? rels : null };
  });
  // Lines you can drive: ordered track nodes and named stops, per direction.
  const railRoutes = (raw.railRoutes || []).map(([ref, name, colour, nodes, stops]) => ({
    ref, name, colour, nodes: Int32Array.from(nodes), stops: stops.map(([node, nm]) => ({ node, name: nm })),
  }));
  // Station platforms: outline, height above the rail, track node beside each vertex.
  const railPlatforms = (raw.railPlatforms || []).map(([name, ph10, ring, nodes]) => ({ name, ph: ph10 / 10, ring: Float32Array.from(ring), nodes: Int32Array.from(nodes) }));
  return { railNodes, railY, railRel, railFlags, railWays, rail, railRoutes, railPlatforms };
}

function decodeAero(a) {
  if (!a) return null;
  return {
    nodes: Float32Array.from(a.nodes),
    ways: a.ways.map(([kind, w10, nodes]) => ({ kind, width: w10 / 10, nodes: Int32Array.from(nodes) })),
    runways: a.runways.map(([ref, w10, nodes, e0, e1]) => ({ ref, width: w10 / 10, nodes: Int32Array.from(nodes), ends: [e0, e1] })),
    stands: a.stands.map(([ref, nodes]) => ({ ref, nodes: Int32Array.from(nodes) })),
    holds: Int32Array.from(a.holds || []),
    gates: a.gates || [],
    fence: (a.fence || []).map((r) => Float32Array.from(r)),
  };
}
