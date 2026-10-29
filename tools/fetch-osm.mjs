// Downloads raw OpenStreetMap data for central Boston from the Overpass API.
// Results are cached in tools/.cache/*.json; delete a file to re-fetch it.
//
//   node tools/fetch-osm.mjs [--force]
//
// Map data (c) OpenStreetMap contributors, available under the ODbL.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAY_BBOX, WATER_BBOX } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, '.cache');
fs.mkdirSync(cacheDir, { recursive: true });

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const bb = (b) => `${b.south},${b.west},${b.north},${b.east}`;
const P = bb(PLAY_BBOX);
const W = bb(WATER_BBOX);

const QUERIES = {
  roads: `
    way["highway"](${P});
    out geom;`,
  buildings: `
    (
      way["building"](${P});
      relation["building"]["type"="multipolygon"](${P});
      way["building:part"](${P});
      relation["building:part"]["type"="multipolygon"](${P});
    );
    out geom;`,
  water: `
    (
      way["natural"="water"](${W});
      relation["natural"="water"](${W});
      way["waterway"="riverbank"](${W});
      relation["waterway"="riverbank"](${W});
      way["landuse"~"^(basin|reservoir)$"](${W});
      way["natural"="coastline"](${W});
    );
    out geom;`,
  green: `
    (
      way["leisure"~"^(park|garden|pitch|golf_course|playground|common|recreation_ground|dog_park|nature_reserve|track)$"](${W});
      relation["leisure"~"^(park|garden|pitch|golf_course|common|recreation_ground|nature_reserve)$"](${W});
      way["landuse"~"^(grass|recreation_ground|cemetery|forest|meadow|village_green|greenfield|allotments|flowerbed|railway)$"](${W});
      relation["landuse"~"^(grass|recreation_ground|cemetery|forest|meadow|village_green)$"](${W});
      way["natural"~"^(wood|scrub|grassland|heath|wetland|sand|beach)$"](${W});
      relation["natural"~"^(wood|scrub|grassland|wetland|beach)$"](${W});
      way["amenity"~"^(grave_yard)$"](${W});
    );
    out geom;`,
  paved: `
    (
      way["amenity"="parking"](${P});
      relation["amenity"="parking"](${P});
      way["highway"="pedestrian"]["area"="yes"](${P});
      relation["highway"="pedestrian"](${P});
      way["place"="square"](${P});
      way["man_made"~"^(pier|breakwater)$"](${W});
      relation["man_made"="pier"](${W});
      way["area:highway"](${P});
      way["amenity"="fuel"](${P});
    );
    out geom;`,
  rail: `
    way["railway"~"^(rail|light_rail|tram|subway|narrow_gauge)$"](${P});
    out geom;`,
  trees: `
    (
      node["natural"="tree"](${P});
      way["natural"="tree_row"](${P});
    );
    out geom;`,
  places: `
    node["place"~"^(neighbourhood|suburb|quarter|city|town)$"](${W});
    out body;`,
  // Transit routes (which rail ways are the Red Line, Green Line, commuter
  // rail...) and the stops where trains dwell.
  transit: `
    (
      relation["type"="route"]["route"~"^(subway|light_rail|train|tram)$"](${P});
      node["railway"~"^(stop|station|halt|tram_stop)$"](${P});
      node["public_transport"="stop_position"](${P});
    );
    out body;`,
  // Stadium outline, used to recognise Fenway Park's building parts.
  fenway: `
    relation["name"="Fenway Park"]["leisure"="stadium"](${P});
    out geom;`,
  signals: `
    node["highway"~"^(traffic_signals|stop|crossing)$"](${P});
    out body;`,
  landmarks: `
    nwr["name"~"^(Fenway Park|TD Garden|Massachusetts State House|Faneuil Hall|Old North Church|New England Aquarium|South Station|North Station|Boston Public Library|Trinity Church|Prudential Tower|Prudential Center|John Hancock Tower|200 Clarendon|Bunker Hill Monument|USS Constitution|Museum of Fine Arts|Isabella Stewart Gardner Museum|Museum of Science|Massachusetts Institute of Technology|Northeastern University|Boston University|Symphony Hall|Boston Common|Public Garden|Boston Public Garden|Institute of Contemporary Art|Boston Convention and Exhibition Center|Quincy Market|Copley Square|Kenmore Square|Old State House|Paul Revere House|Hatch Memorial Shell|Boston Children's Museum|Kendall Square|Charles River Esplanade|Leonard P. Zakim Bunker Hill Memorial Bridge|Longfellow Bridge|Harvard Bridge|Boston University Bridge|Christian Science Plaza|The Mother Church|Copley Place|Boston City Hall|City Hall Plaza|Custom House Tower|Chinatown Gate|Boston Tea Party Ships & Museum|Massachusetts General Hospital|Lechmere|Haymarket|Back Bay|Bay Village|Castle Island|Fort Point|Seaport Common|Harpoon Brewery|Boston Logan International Airport)"](${W});
    out center tags;`,
};

async function runQuery(name, body) {
  const out = path.join(cacheDir, `${name}.json`);
  if (fs.existsSync(out) && !process.argv.includes('--force')) {
    console.log(`[cache] ${name}`);
    return;
  }
  const query = `[out:json][timeout:240];\n${body}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'RaceBoston/1.0 (open-source browser driving game)',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const json = JSON.parse(text);
      if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
      fs.writeFileSync(out, text);
      console.log(`[ok] ${name}: ${json.elements.length} elements, ${(text.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    } catch (err) {
      console.warn(`[retry] ${name} via ${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
  throw new Error(`Failed to fetch ${name}`);
}

for (const [name, body] of Object.entries(QUERIES)) {
  await runQuery(name, body);
}
console.log('Done.');
