// Drives the car along real routes through Boston's tunnels, trenches and
// bridges with a lane-following autopilot and checks that it stays on the
// road at the right level (no falls, no snags, no phantom walls).
//
//   node tools/test-3d-roads.mjs

import path from 'node:path';
import { startServer, launch, shotsDir, sleep } from './browser.mjs';

// Each trip follows a named road from a start point along its legal direction
// (toward `toward`) for `dist` meters, and must reach the given heights.
const TRIPS = [
  { name: 'Mass Pike: Back Bay trench + Prudential tunnel', road: 'Massachusetts Turnpike', start: [-2700, 690, 0], toward: [0, 950], dist: 2600, minY: -9 },
  { name: 'I-90 Ted Williams tunnel eastbound', road: 'Massachusetts Turnpike', start: [300, 1000, -7], toward: [2500, 600], dist: 2200, minY: -7 },
  { name: 'Big Dig I-93 north to the Zakim', road: 'Fitzgerald|I-93', start: [620, 950, -7], toward: [300, -1600], dist: 2700, minY: -7, maxY: 12 },
  { name: 'Zakim Bridge southbound', road: 'Fitzgerald|I-93', start: [120, -2150, 5], toward: [500, -600], dist: 1600, maxY: 12 },
  { name: 'Harvard Bridge into Cambridge', road: '^Massachusetts Avenue$', start: [-1960, 420, 0], toward: [-2400, -600], dist: 900, maxY: 2.5 },
  { name: 'Longfellow Bridge to Kendall', road: 'Longfellow|^Cambridge Street$|^Main Street$', start: [-470, -440, 0], toward: [-1400, -900], dist: 900, maxY: 5 },
  { name: 'Storrow Drive westbound', road: '^Storrow Drive$', start: [-480, -470, 0], toward: [-3500, 300], dist: 2600, minY: -4 },
  { name: 'Sumner Tunnel inbound under the harbor', road: 'Sumner Tunnel', start: [2150, -1350, -7], toward: [700, -1200], dist: 1300, minY: -6 },
  { name: 'Callahan Tunnel outbound', road: 'Callahan Tunnel', start: [950, -1260, -5], toward: [2300, -1300], dist: 1300, minY: -6 },
  { name: 'Huntington Avenue past the Pike ramps', road: '^Huntington Avenue$', start: [-880, 690, 0], toward: [-1600, 1300], dist: 1200 },
];
// Optional filter: node tools/test-3d-roads.mjs <name substring>
const only = process.argv[2];
if (only) TRIPS.splice(0, TRIPS.length, ...TRIPS.filter((t) => t.name.toLowerCase().includes(only.toLowerCase())));

const server = await startServer(8150);
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
let failed = 0;
try {
  await page.goto(server.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.RB && RB.game && RB.game.ready, { timeout: 120000 });
  await page.evaluate(() => { RB.game.setSetting('traffic', 0); RB.game.begin('free'); });
  for (const trip of TRIPS) {
    const r = await page.evaluate(async (trip) => {
      const g = RB.game, gr = g.graph, ny = g.map.nodeY;
      const re = new RegExp(trip.road);
      const roads = g.map.roads;
      // Start: nearest node on the named road, at the hinted height, whose
      // legal direction heads toward the target (picks the right carriageway).
      const headsToward = (n) => {
        for (let k = gr.adjStart[n]; k < gr.adjStart[n + 1]; k++) {
          const e = gr.adj[k];
          if (!gr.eLegal[e] || !re.test(roads[gr.eRoad[e]].name)) continue;
          const v = gr.eTo[e];
          const dx = gr.nx(v) - gr.nx(n), dz = gr.nz(v) - gr.nz(n);
          const tx = trip.toward[0] - gr.nx(n), tz = trip.toward[1] - gr.nz(n);
          if ((dx * tx + dz * tz) / ((Math.hypot(dx, dz) || 1) * (Math.hypot(tx, tz) || 1)) > 0.3) return true;
        }
        return false;
      };
      let a = -1, bd = Infinity;
      for (const r of roads) {
        if (!re.test(r.name)) continue;
        for (const n of r.nodes) {
          const d = (gr.nx(n) - trip.start[0]) ** 2 + (gr.nz(n) - trip.start[1]) ** 2 + ((ny[n] - trip.start[2]) * 25) ** 2;
          if (d < bd && headsToward(n)) { bd = d; a = n; }
        }
      }
      if (a < 0) return { err: 'road not found' };
      // Walk legal edges on the named road, steering toward `toward`.
      const path = [a];
      let prev = -1, cur = a, walked = 0;
      while (walked < trip.dist && path.length < 5000) {
        let best = -1, bs = -Infinity;
        for (let k = gr.adjStart[cur]; k < gr.adjStart[cur + 1]; k++) {
          const e = gr.adj[k];
          if (!gr.eLegal[e]) continue;
          const v = gr.eTo[e];
          if (v === prev || !re.test(roads[gr.eRoad[e]].name)) continue;
          const dx = gr.nx(v) - gr.nx(cur), dz = gr.nz(v) - gr.nz(cur);
          const l = Math.hypot(dx, dz) || 1;
          let sc = (dx * (trip.toward[0] - gr.nx(cur)) + dz * (trip.toward[1] - gr.nz(cur))) / (l * Math.hypot(trip.toward[0] - gr.nx(cur), trip.toward[1] - gr.nz(cur)) + 1e-6);
          if (prev >= 0) {
            const px = gr.nx(cur) - gr.nx(prev), pz = gr.nz(cur) - gr.nz(prev);
            sc += 1.5 * (px * dx + pz * dz) / ((Math.hypot(px, pz) || 1) * l);
          }
          if (sc > bs) { bs = sc; best = v; }
        }
        if (best < 0) break;
        walked += Math.hypot(gr.nx(best) - gr.nx(cur), gr.nz(best) - gr.nz(cur));
        prev = cur; cur = best; path.push(cur);
      }
      if (path.length < 3) return { err: 'walk too short' };
      const pts = path.map((n) => [gr.nx(n), gr.nz(n), ny[n]]);
      const h0 = Math.atan2(pts[1][0] - pts[0][0], -(pts[1][1] - pts[0][1]));
      g.placeCar(pts[0][0], pts[0][1], h0, pts[0][2]);
      let idx = 0, t = 0, minY = 0, maxY = 0, airT = 0, hits = 0, maxDev = 0, stuck = 0, levelErrT = 0, flight = 0, maxFlight = 0;
      const events = [];
      return await new Promise((resolve) => {
        const iv = setInterval(() => {
          const c = g.car;
          t += 0.033;
          // Progress only when close in x/z AND at the same level.
          while (idx < pts.length - 1) {
            const p = pts[idx + 1];
            const dxz = Math.hypot(p[0] - c.x, p[1] - c.z);
            const ahead = (p[0] - c.x) * Math.sin(c.heading) + (p[1] - c.z) * -Math.cos(c.heading);
            if ((dxz < 7 || ahead < 0) && Math.abs(p[2] - c.y) < 2.5 && dxz < 25) idx++; else break;
          }
          // Pure pursuit target ~8-20 m ahead along the route.
          let k = idx, acc = 0;
          const look = 7 + c.speed * 0.5;
          while (k < pts.length - 1 && acc < look) { acc += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]); k++; }
          const T = pts[k];
          let d = Math.atan2(T[0] - c.x, -(T[1] - c.z)) - c.heading;
          while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
          // Turn sharpness ahead for speed control.
          let bend = 0;
          for (let q = idx; q < Math.min(pts.length - 2, idx + 6); q++) {
            const a1 = Math.atan2(pts[q + 1][0] - pts[q][0], -(pts[q + 1][1] - pts[q][1]));
            const a2 = Math.atan2(pts[q + 2][0] - pts[q + 1][0], -(pts[q + 2][1] - pts[q + 1][1]));
            let db = Math.abs(a2 - a1); if (db > Math.PI) db = 2 * Math.PI - db;
            bend = Math.max(bend, db);
          }
          const vt = Math.max(7, 24 - bend * 26 - Math.abs(d) * 30);
          g.inputOverride = { throttle: c.speed < vt ? 1 : 0, brake: c.speed > vt + 3 ? 1 : 0, steer: Math.max(-1, Math.min(1, d * 2.2)) };
          // Deviation from the route polyline (x/z) and level.
          const a = pts[Math.max(0, idx)], b = pts[Math.min(pts.length - 1, idx + 1)];
          const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1;
          const tt = Math.max(0, Math.min(1, ((c.x - a[0]) * dx + (c.z - a[1]) * dz) / l2));
          const dev = Math.hypot(c.x - a[0] - dx * tt, c.z - a[1] - dz * tt);
          const ry = a[2] + (b[2] - a[2]) * tt;
          maxDev = Math.max(maxDev, dev);
          if (Math.abs(c.y - ry) > 2.5) {
            levelErrT += 0.033;
            if (levelErrT > 0.6 && !events.some((e) => e.startsWith('level'))) events.push(`level @${c.x.toFixed(0)},${c.z.toFixed(0)} car y=${c.y.toFixed(1)} road y=${ry.toFixed(1)} (${g.hud.streetName.textContent})`);
          } else levelErrT = 0;
          minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
          if (c.airborne) { airT += 0.033; flight += 0.033; maxFlight = Math.max(maxFlight, flight); } else flight = 0;
          if (c.impact > 4) { hits++; if (hits < 4) events.push(`hit ${c.impact.toFixed(1)} kind=${c.impactKind} @${c.x.toFixed(0)},${c.z.toFixed(0)} y=${c.y.toFixed(1)} (${g.hud.streetName.textContent})`); }
          if (c.speed < 1 && stuck > 1 && !events.some((e) => e.startsWith('slow'))) events.push(`slow @${c.x.toFixed(0)},${c.z.toFixed(0)} y=${c.y.toFixed(1)} (${g.hud.streetName.textContent})`);
          if (c.speed < 1) stuck += 0.033; else stuck = 0;
          if (idx >= pts.length - 2 || t > 240 || stuck > 5 || g.sinking || levelErrT > 3) {
            clearInterval(iv);
            g.inputOverride = { brake: 1 };
            resolve({
              done: idx >= pts.length - 2, t: +t.toFixed(1), len: Math.round(gr.pathLength(path)), progress: +(idx / (pts.length - 1)).toFixed(2),
              minY: +minY.toFixed(1), maxY: +maxY.toFixed(1), routeMinY: Math.min(...pts.map((p) => p[2])), routeMaxY: Math.max(...pts.map((p) => p[2])),
              airT: +airT.toFixed(2), maxFlight: +maxFlight.toFixed(2), hits, maxDev: +maxDev.toFixed(1), stuck: stuck > 5, sank: !!g.sinking,
              at: [Math.round(c.x), Math.round(c.z), +c.y.toFixed(1)], street: g.hud.streetName.textContent, events,
            });
          }
        }, 33);
      });
    }, trip);
    // Small hops over crests are fine; long flights mean the car left the road.
    const ok = r.done && !r.sank && r.hits <= 2 && r.maxFlight < 1.0 && r.airT < r.t * 0.04 && !r.events.some((e) => e.startsWith('level')) &&
      (trip.minY === undefined || r.minY <= trip.minY) && (trip.maxY === undefined || r.maxY >= trip.maxY);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${trip.name}: ${JSON.stringify(r)}`);
    await page.screenshot({ path: path.join(shotsDir, `road3d_${TRIPS.indexOf(trip)}.png`) });
  }
} catch (err) {
  failed = TRIPS.length;
  console.log('ERROR', err && err.stack ? err.stack : err);
} finally {
  const errors = logs.filter((l) => /\[(error|pageerror)\]/.test(l));
  if (errors.length) console.log(errors.slice(0, 5).join('\n'));
  await browser.close();
  server.proc.kill();
  console.log(`${TRIPS.length - failed}/${TRIPS.length} trips passed`);
  process.exit(failed ? 1 : 0);
}
