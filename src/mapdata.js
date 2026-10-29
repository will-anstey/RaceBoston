// Loads data/boston.json (produced by tools/build-map.mjs) and decodes it
// into typed arrays / plain objects. World units are meters: +x east, +z south.

export const RC = { MOTORWAY: 0, TRUNK: 1, PRIMARY: 2, SECONDARY: 3, TERTIARY: 4, RESIDENTIAL: 5, LIVING: 6, SERVICE: 7 };

export const AREA = {
  PARK: 1, GRASS: 2, PITCH: 3, GOLF: 4, CEMETERY: 5, WOOD: 6, PLAYGROUND: 7, TRACK: 8, SAND: 9,
  WETLAND: 10, GARDEN: 11, RAILYARD: 12, DIRT: 13, PARKING: 20, PLAZA: 21, PIER: 22, FUEL: 23,
};

// Rail: which trains run on a way, and node / way flags (tools/build-map.mjs).
export const RAIL_SVC = { RED: 1, ORANGE: 2, BLUE: 4, GREEN: 8, COMMUTER: 16, AMTRAK: 32, FREIGHT: 64 };
export const RAIL_NODE = { PORTAL: 1, STOP: 2, BUFFER: 4, EDGE: 8 };
export const RAIL_WAY = { BRIDGE: 1, YARD: 2, CROSSOVER: 4 };

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
  return decode(JSON.parse(text));
}

const ring = (a) => Float32Array.from(a);

function decode(raw) {
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
  const nodeY = new Float32Array(raw.nodes.length / 2);
  if (raw.elev) for (let i = 0; i < nodeY.length; i++) nodeY[i] = raw.elev[i] / 10;
  return {
    meta: raw.meta,
    nodes: Float32Array.from(raw.nodes),
    nodeY,
    roads,
    paths: raw.paths.map(([cls, w10, bridge, pts]) => ({ cls, width: w10 / 10, bridge: !!bridge, pts: ring(pts) })),
    piers: (raw.piers || []).map(([w10, pts]) => ({ width: w10 / 10, pts: ring(pts) })),
    crossings: raw.crossings.map(ring),
    buildings: raw.buildings.map(([h10, m10, color, roof, style, flags, rings, landmark, roofH10, stands]) => ({
      h: h10 / 10, minH: m10 / 10, color, roof, style,
      solid: !(flags & 1) && !(flags & 8), part: !!(flags & 2), pitched: !!(flags & 4), hidden: !!(flags & 8), dome: !!(flags & 16),
      rings: rings.map(ring), landmark: landmark || 0, roofH: (roofH10 || 0) / 10, stands: !!stands,
    })),
    land: raw.land.map((p) => p.map(ring)),
    water: raw.water.map((p) => p.map(ring)),
    areas: raw.areas.map(([type, p]) => ({ type, rings: p.map(ring) })),
    ...decodeRail(raw),
    trees: Float32Array.from(raw.trees),
    places: raw.places.map(([name, x, z, rank]) => ({ name, x, z, rank })),
    landmarks: raw.landmarks.map(([name, kind, x, z, node]) => ({ name, kind, x, z, node })),
    signals: Int32Array.from(raw.signals),
  };
}

function decodeRail(raw) {
  const railNodes = Float32Array.from(raw.railNodes || []);
  const railY = Float32Array.from(raw.railY || [], (e) => e / 10);
  const railFlags = Uint8Array.from(raw.railFlags || []);
  const railWays = (raw.railWays || []).map(([kind, flags, svc, nodes]) => ({ kind, flags, svc, nodes: Int32Array.from(nodes) }));
  // Polylines for drawing track (with heights where raised).
  const rail = railWays.map((w) => {
    const pts = new Float32Array(w.nodes.length * 2), ys = new Float32Array(w.nodes.length);
    let raised = false;
    w.nodes.forEach((n, i) => { pts[2 * i] = railNodes[2 * n]; pts[2 * i + 1] = railNodes[2 * n + 1]; ys[i] = railY[n]; if (Math.abs(ys[i]) > 0.02) raised = true; });
    return { kind: w.kind, bridge: !!(w.flags & RAIL_WAY.BRIDGE), pts, ys: raised ? ys : null };
  });
  return { railNodes, railY, railFlags, railWays, rail };
}
