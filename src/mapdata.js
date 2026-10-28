// Loads data/boston.json (produced by tools/build-map.mjs) and decodes it
// into typed arrays / plain objects. World units are meters: +x east, +z south.

export const RC = { MOTORWAY: 0, TRUNK: 1, PRIMARY: 2, SECONDARY: 3, TERTIARY: 4, RESIDENTIAL: 5, LIVING: 6, SERVICE: 7 };

export const AREA = {
  PARK: 1, GRASS: 2, PITCH: 3, GOLF: 4, CEMETERY: 5, WOOD: 6, PLAYGROUND: 7, TRACK: 8, SAND: 9,
  WETLAND: 10, GARDEN: 11, RAILYARD: 12, PARKING: 20, PLAZA: 21, PIER: 22, FUEL: 23,
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
    const [cls, flags, lanes, w10, sh10, nameIdx, speed, nodes, rail] = r;
    return {
      id, cls, lanes,
      oneway: !!(flags & 1), bridge: !!(flags & 2), link: !!(flags & 4), roundabout: !!(flags & 8),
      width: w10 / 10, shoulder: sh10 / 10,
      name: names[nameIdx] || '',
      speedLimit: speed,
      nodes: Int32Array.from(nodes),
      rail: rail || [],
    };
  });
  return {
    meta: raw.meta,
    nodes: Float32Array.from(raw.nodes),
    roads,
    paths: raw.paths.map(([cls, w10, bridge, pts]) => ({ cls, width: w10 / 10, bridge: !!bridge, pts: ring(pts) })),
    piers: (raw.piers || []).map(([w10, pts]) => ({ width: w10 / 10, pts: ring(pts) })),
    crossings: raw.crossings.map(ring),
    buildings: raw.buildings.map(([h10, m10, color, roof, style, flags, rings]) => ({
      h: h10 / 10, minH: m10 / 10, color, roof, style,
      solid: !(flags & 1) && !(flags & 8), part: !!(flags & 2), pitched: !!(flags & 4), hidden: !!(flags & 8),
      rings: rings.map(ring),
    })),
    land: raw.land.map((p) => p.map(ring)),
    water: raw.water.map((p) => p.map(ring)),
    areas: raw.areas.map(([type, p]) => ({ type, rings: p.map(ring) })),
    rail: raw.rail.map(([kind, bridge, pts]) => ({ kind, bridge: !!bridge, pts: ring(pts) })),
    trees: Float32Array.from(raw.trees),
    places: raw.places.map(([name, x, z, rank]) => ({ name, x, z, rank })),
    landmarks: raw.landmarks.map(([name, kind, x, z, node]) => ({ name, kind, x, z, node })),
    signals: Int32Array.from(raw.signals),
  };
}
