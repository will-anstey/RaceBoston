// Regions: Boston and the islands you can fly out to (Martha's Vineyard,
// Nantucket), each a map of its own in the same world coordinates (the
// islands really are 100-150 km south-east of Boston Common). Boston loads at
// startup; an island loads in the background when you fly toward it, or when
// you start there. Each region has its own road graph, world, collision,
// minimap art, traffic and street signs; the game switches its references to
// whichever region you're in (main.js setRegion).

import { loadMap } from './mapdata.js';
import { RoadGraph } from './roadgraph.js';
import { buildWorld } from './world.js';
import { CollisionWorld } from './collision.js';
import { MapArt } from './hud.js';
import { Traffic } from './traffic.js';
import { StreetSigns } from './signs.js';
import { nextFrame } from './util.js';

// spawn: where a car starts (lat, lon, name); harbor: where a boat goes out.
export const REGION_INFO = {
  boston: { id: 'boston', name: 'Boston' },
  vineyard: {
    id: 'vineyard', name: "Martha's Vineyard", short: 'the Vineyard', file: 'data/vineyard.json', terrain: 'vineyard.terrain.bin',
    spawn: [41.4545, -70.6035, 'Vineyard Haven'],
    harbors: [['Vineyard Haven Harbor', 41.4600, -70.5985], ['Oak Bluffs Harbor', 41.4592, -70.5585], ['Edgartown Harbor', 41.3895, -70.5080], ['Menemsha Pond', 41.3560, -70.7600]],
  },
  nantucket: {
    id: 'nantucket', name: 'Nantucket', short: 'Nantucket', file: 'data/nantucket.json', terrain: 'nantucket.terrain.bin',
    spawn: [41.2840, -70.0990, 'Nantucket town'],
    harbors: [['Nantucket Harbor', 41.2905, -70.0870], ['Madaket Harbor', 41.2700, -70.2000], ['Polpis Harbor', 41.2950, -70.0220]],
  },
};
export const ISLANDS = ['vineyard', 'nantucket'];

export class Regions {
  constructor(game) {
    this.g = game;
    this.list = [];
    this.byId = {};
    this.loading = {};
  }

  // The region already loaded at startup.
  addBoston() {
    const g = this.g;
    const r = { id: 'boston', name: 'Boston', info: REGION_INFO.boston, boston: true, map: g.map, graph: g.graph, world: g.world, collision: g.collision, art: g.minimap.art, traffic: g.traffic, signs: g.signs, box: g.map.meta.water };
    g.map.landmarkByName = new Map(g.map.landmarks.map((l) => [l.name, l]));
    this.list.push(r);
    this.byId.boston = r;
    return r;
  }

  get(id) { return this.byId[id] || null; }

  // The region whose map holds (x, z) (its water box), if loaded.
  at(x, z) {
    for (const r of this.list) { const b = r.box; if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return r; }
    return null;
  }

  // Load an island (once): progress(p 0..1, text) while it builds.
  load(id, progress = null) {
    if (this.byId[id]) return Promise.resolve(this.byId[id]);
    if (this.loading[id]) return this.loading[id];
    const info = REGION_INFO[id], g = this.g;
    if (!info || !info.file) return Promise.resolve(null);
    const say = (p, t) => progress && progress(p, t);
    this.loading[id] = (async () => {
      say(0.02, `Flying out to ${info.name}…`);
      const map = await loadMap(info.file, (p) => say(p * 0.3, `Downloading ${info.name}…`), info.terrain);
      map.landmarkByName = new Map(map.landmarks.map((l) => [l.name, l]));
      await nextFrame();
      say(0.32, 'Connecting the roads');
      const graph = new RoadGraph(map);
      await nextFrame();
      const world = await buildWorld(map, graph, g.scene, (p, t) => say(0.34 + p * 0.5, t));
      world.group.visible = false;
      await nextFrame();
      say(0.86, 'Mapping obstacles');
      const collision = new CollisionWorld(map, world);
      collision.ice = null;
      await nextFrame();
      say(0.92, 'Drawing the map');
      const art = new MapArt(map, graph);
      await nextFrame();
      const signs = new StreetSigns(map, graph, g.scene, collision);
      signs.group.visible = false;
      const traffic = new Traffic(g, { graph, map, collision });
      traffic.setDensity(Math.round(g.settings.traffic * 0.6));
      traffic.group.visible = false;
      const r = { id, name: info.name, info, map, graph, world, collision, art, signs, traffic, box: map.meta.water };
      this.list.push(r);
      this.byId[id] = r;
      delete this.loading[id];
      say(1, `${info.name} ready`);
      g.onRegionLoaded?.(r);
      return r;
    })().catch((err) => { console.error(err); delete this.loading[id]; return null; });
    return this.loading[id];
  }

  // Distance (m) from a point to a region's box (0 inside).
  distTo(r, x, z) {
    const b = r.box;
    return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ));
  }
}

// An island's box before it's loaded (from the map config), for "is she heading there" checks.
export function islandBox(meta, id) {
  const B = { vineyard: { south: 41.235, west: -70.885, north: 41.5, east: -70.41 }, nantucket: { south: 41.205, west: -70.335, north: 41.42, east: -69.93 } }[id];
  if (!B) return null;
  const px = (lon) => (lon - meta.origin.lon) * meta.metersPerDegree.lon, pz = (lat) => -(lat - meta.origin.lat) * meta.metersPerDegree.lat;
  return { minX: px(B.west), maxX: px(B.east), minZ: pz(B.north), maxZ: pz(B.south) };
}
