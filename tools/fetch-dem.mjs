// Downloads elevation tiles for the map area: AWS Terrain Tiles (Mapzen
// "terrarium" PNGs, height = R*256 + G + B/256 - 32768 m), built mostly from
// USGS 3DEP data around Boston. Cached in tools/.cache/dem/; delete it to
// re-fetch.
//
//   node tools/fetch-dem.mjs
//
// Terrain data: https://registry.opendata.aws/terrain-tiles/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WATER_BBOX } from './config.mjs';

export const DEM_ZOOM = 15;
const here = path.dirname(fileURLToPath(import.meta.url));
export const demDir = path.join(here, '.cache', 'dem', String(DEM_ZOOM));
const URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// Web Mercator tile coordinates (fractional) for a lon/lat.
export function tileXY(lon, lat, z = DEM_ZOOM) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n];
}

export function demTiles(box = WATER_BBOX, pad = 0.004) {
  const [x0, y0] = tileXY(box.west - pad, box.north + pad);
  const [x1, y1] = tileXY(box.east + pad, box.south - pad);
  const out = [];
  for (let x = Math.floor(x0); x <= Math.floor(x1); x++) for (let y = Math.floor(y0); y <= Math.floor(y1); y++) out.push([x, y]);
  return out;
}

async function fetchTile(x, y) {
  const file = path.join(demDir, `${x}_${y}.png`);
  if (fs.existsSync(file)) return 'cached';
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(URL(DEM_ZOOM, x, y), { headers: { 'User-Agent': 'RaceBoston/1.0 (open-source browser driving game)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return 'ok';
    } catch (err) {
      if (attempt === 4) throw new Error(`tile ${x}/${y}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(demDir, { recursive: true });
  const tiles = demTiles();
  let done = 0, fetched = 0;
  const queue = tiles.slice();
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const [x, y] = queue.shift();
      if ((await fetchTile(x, y)) === 'ok') fetched++;
      if (++done % 40 === 0) console.log(`  ${done}/${tiles.length} tiles`);
    }
  }));
  console.log(`DEM: ${tiles.length} tiles at z${DEM_ZOOM} (${fetched} downloaded, ${tiles.length - fetched} cached) in ${path.relative(process.cwd(), demDir)}`);
}
