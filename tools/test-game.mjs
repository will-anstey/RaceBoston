// End-to-end test: boots the game in headless Chrome and exercises driving,
// collisions, water, hills, traffic, trains and train mode, a race, a taxi
// fare, the map and night mode.
//
//   node tools/test-game.mjs            (screenshots -> tools/screenshots/)

import path from 'node:path';
import { startServer, launch, shotsDir, sleep } from './browser.mjs';
import { decodePNG } from './png.mjs';

const server = await startServer(8125);
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const shot = async (name) => { await page.screenshot({ path: path.join(shotsDir, `${name}.png`) }); };
const st = () => page.evaluate(() => RB.game.debugState());
const drive = (inp) => page.evaluate((i) => { RB.game.inputOverride = i; }, inp);

try {
  const t0 = Date.now();
  await page.goto(server.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.RB && RB.game && RB.game.ready, { timeout: 120000 });
  check('game loads', true, `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await sleep(1500);
  await shot('t01_menu');

  // ---- free roam start (clear weather: Dynamic can start in snow, with the river frozen)
  await page.evaluate(() => { const g = RB.game; g.setSetting('weather', 'clear'); g.weather.setMode('clear', true); g.ice.setLevel(0); g.begin('free'); });
  await sleep(1200);
  let s = await st();
  check('free roam starts', s.state === 'play' && s.mode === 'free', `street="${s.street}" area="${s.area}"`);
  await shot('t02_start');

  // ---- acceleration
  const start = { x: s.x, z: s.z };
  await drive({ throttle: 1 });
  await sleep(3000);
  s = await st();
  check('accelerates', s.speed > 12, `speed ${s.speed.toFixed(1)} m/s after 3s`);
  await shot('t03_driving');
  // ---- steering
  const h0 = s.heading;
  await drive({ throttle: 0.6, steer: 1 });
  await sleep(1200);
  s = await st();
  check('steers right', Math.abs(s.heading - h0) > 0.3, `heading change ${(s.heading - h0).toFixed(2)} rad`);
  // ---- braking
  // (1.3 s of simulated driving: a slow frame under load doesn't count against the brakes.)
  const b0 = await st(), vBefore = b0.speed;
  await drive({ brake: 1 });
  for (let i = 0; i < 60; i++) { await sleep(50); s = await st(); if (s.sim - b0.sim >= 1.3) break; }
  check('brakes hard', s.speed < 3, `speed ${vBefore.toFixed(1)} -> ${s.speed.toFixed(2)} m/s in ${(s.sim - b0.sim).toFixed(2)} s`);
  await sleep(1500);
  s = await st();
  check('reverses when holding brake', s.vF < -1, `vF ${s.vF.toFixed(2)}`);
  check('moved from start', Math.hypot(s.x - start.x, s.z - start.z) > 20);

  // ---- building collision: aim at the nearest solid wall from a road.
  const wall = await page.evaluate(() => {
    const g = RB.game, map = g.map;
    // Find a building near the spawn with a long wall; stand 12 m in front of it.
    for (const b of map.buildings) {
      if (!b.solid || b.h < 8) continue;
      const r = b.rings[0];
      for (let i = 0; i + 3 < r.length; i += 2) {
        const ax = r[i], az = r[i + 1], bx = r[i + 2], bz = r[i + 3];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 14) continue;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        if (Math.hypot(mx - g.car.x, mz - g.car.z) > 600) continue;
        // outward normal for outer ring
        const nx = -(bz - az) / L, nz = (bx - ax) / L;
        const px = mx + nx * 14, pz = mz + nz * 14;
        if (g.collision.surfaceAt(px, pz) & 16) continue;
        let clear = true;
        for (let d = 2; d <= 14; d += 2) if (g.collision.surfaceAt(mx + nx * d, mz + nz * d) & 16) clear = false;
        // No trees or other walls on the approach.
        const T = g.collision.trees;
        for (let d = 1; d <= 16 && clear; d += 1.5) {
          const qx = mx + nx * d, qz = mz + nz * d;
          const k = T.query(qx, qz, 3);
          for (let j = 0; j < k; j++) { const t = T.result[j]; if (Math.hypot(T.pts[3 * t] - qx, T.pts[3 * t + 1] - qz) < 2.5) clear = false; }
        }
        if (clear && g.collision.segmentBlocked(mx + nx * 0.6, mz + nz * 0.6, px, pz) < 1) clear = false;
        // Every car circle must start clear of walls (side walls included).
        const o = {}, hx = -nx, hz = -nz;
        for (let d = 3; d <= 16 && clear; d += 1) {
          for (const off of g.car.h.circles) if (g.collision.resolveCircle(mx + nx * d + hx * off, mz + nz * d + hz * off, g.car.h.radius + 0.6, o) && Math.abs(o.nx * nx + o.nz * nz) < 0.9) clear = false;
        }
        if (!clear) continue;
        const heading = Math.atan2(-nx, nz);
        g.placeCar(px, pz, heading);
        return { mx, mz, nx, nz };
      }
    }
    return null;
  });
  if (wall) {
    await drive({ throttle: 1 });
    await sleep(2500);
    s = await st();
    const inside = await page.evaluate(() => (RB.game.collision.surfaceAt(RB.game.car.x, RB.game.car.z) & 16) !== 0);
    const dist = (s.x - wall.mx) * wall.nx + (s.z - wall.mz) * wall.nz;
    check('wall stops the car', !inside && dist > 0.5 && dist < 4, `distance to wall plane ${dist.toFixed(2)} m, speed ${s.speed.toFixed(1)}`);
    await shot('t04_wall');
  } else check('wall stops the car', false, 'no test wall found');
  await drive(null);

  // ---- water: drive into the Charles from the Esplanade.
  const water = await page.evaluate(() => {
    const g = RB.game;
    // Search for a water cell next to land near the Esplanade.
    for (let x = -1600; x < -400; x += 7) {
      for (let z = -250; z < 250; z += 7) {
        if (g.collision.isWater(x, z) && !g.collision.isWater(x, z + 25) && !(g.collision.surfaceAt(x, z + 25) & 16)) {
          g.placeCar(x, z + 20, 0);
          return { x, z };
        }
      }
    }
    return null;
  });
  if (water) {
    await drive({ throttle: 1 });
    // Watch for the splash (it may come at once, and respawn within 2 s).
    let sankOrRespawned = false;
    for (let i = 0; i < 11; i++) { await sleep(200); s = await st(); if (s.sinking > 0) sankOrRespawned = true; }
    await shot('t05_splash');
    await drive(null);
    await sleep(2200);
    const s2 = await st();
    const dry = await page.evaluate(() => !RB.game.collision.isWater(RB.game.car.x, RB.game.car.z));
    check('splash in the Charles + respawn', sankOrRespawned && s2.sinking === 0 && dry, `sinking=${s.sinking.toFixed(2)} then ${s2.sinking}`);
  } else check('splash in the Charles + respawn', false, 'no water edge found');

  // ---- traffic
  await page.evaluate(() => RB.game.respawn());
  await sleep(3000);
  s = await st();
  check('traffic spawns', s.traffic >= 10, `${s.traffic} AI cars`);
  await shot('t06_traffic');

  // ---- ram a (stopped) AI car
  const target = await page.evaluate(() => {
    const g = RB.game, cw = g.collision;
    // Any AI car at grade with a clear 20 m run-up straight behind it.
    for (const t of g.traffic.cars) {
      if (t.wrecked || Math.abs(t.y - g.map.terrain.h(t.x, t.z)) > 0.3) continue;
      const px = t.x - Math.sin(t.heading) * 20, pz = t.z + Math.cos(t.heading) * 20;
      if (cw.segmentBlocked(px, pz, t.x, t.z, 1) < 1 || cw.surfaceAt(px, pz) & 16) continue;
      if (g.traffic.cars.some((o) => o !== t && Math.hypot(o.x - px, o.z - pz) < 8)) continue;
      t.personality = 0; t.speed = 0;
      window.__target = t;
      g.placeCar(px, pz, t.heading);
      return { x: t.x, z: t.z };
    }
    return null;
  });
  if (target) {
    await drive({ throttle: 1 });
    await sleep(3500);
    const r = await page.evaluate(() => {
      const t = window.__target, c = RB.game.car;
      return { wrecked: t.wrecked, gap: Math.hypot(t.x - c.x, t.z - c.z), moved: Math.hypot(t.vx, t.vz) };
    });
    check('ramming knocks an AI car', r.wrecked && r.gap > 2.5, `wrecked=${r.wrecked} gap ${r.gap.toFixed(1)} m`);
    await shot('t06b_crash');
    await drive(null);
  } else check('ramming knocks an AI car', false, 'no AI car with a clear run-up');

  // ---- every leg of every race has a drivable route on the graph
  const legCheck = await page.evaluate(async () => {
    const mod = await import('/src/missions.js');
    const g = RB.game, bad = [];
    let n = 0;
    for (const race of mod.RACES) {
      const stops = race.stops.map((s) => g.missions.stopPos(s));
      stops.forEach((s, i) => { if (!s) bad.push(race.id + ':missing ' + race.stops[i]); });
      for (let i = 0; i + 1 < stops.length; i++) {
        if (!stops[i] || !stops[i + 1]) continue;
        n++;
        if (!g.graph.route(stops[i].node, stops[i + 1].node, { strict: true })) bad.push(`${race.id}:${race.stops[i]}->${race.stops[i + 1]}`);
      }
    }
    return { n, bad };
  });
  check('all race legs routable (legal one-way routes)', legCheck.bad.length === 0, `${legCheck.n} legs${legCheck.bad.length ? ' bad: ' + legCheck.bad.join(', ') : ''}`);
  // The GPS may cut the wrong way down a one-way street, never up a ramp or a
  // highway, and checkpoints sit on ordinary streets.
  const gpsCheck = await page.evaluate(async () => {
    const mod = await import('/src/missions.js');
    const g = RB.game, gr = g.graph, roads = g.map.roads, bad = [];
    for (const race of mod.RACES) {
      const stops = race.stops.map((s) => g.missions.stopPos(s));
      stops.forEach((s, i) => { if (s && gr.nodeClass[s.node] <= 1) bad.push(`${race.id}: ${race.stops[i]} on a highway`); });
      for (let i = 0; i + 1 < stops.length; i++) {
        if (!stops[i] || !stops[i + 1]) continue;
        const p = gr.route(stops[i].node, stops[i + 1].node) || [];
        for (let k = 0; k + 1 < p.length; k++) {
          for (const e of gr.outEdges(p[k], false)) {
            if (gr.eTo[e] !== p[k + 1] || gr.eLegal[e]) continue;
            const r = roads[gr.eRoad[e]];
            if (r.link || r.cls <= 1) bad.push(`${race.id}: wrong way on ${r.name || 'a ramp'}`);
          }
        }
      }
    }
    return [...new Set(bad)];
  });
  check('GPS keeps races off highways the wrong way', gpsCheck.length === 0, gpsCheck.slice(0, 4).join(', '));
  // Bridge pillars must stand clear of every road under the deck.
  const pillarCheck = await page.evaluate(() => {
    const g = RB.game, map = g.map, sg = g.graph.segGrid, s = sg.segs, Y = map.nodeY;
    let n = 0;
    for (const [x, z, r] of g.world.structures.pillars) {
      const m = sg.query(x, z, 30);
      for (let k = 0; k < m; k++) {
        const i = sg.result[k], road = map.roads[sg.meta[i]], seg = sg.meta2[i];
        const dx = s[4 * i + 2] - s[4 * i], dz = s[4 * i + 3] - s[4 * i + 1], l2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - s[4 * i]) * dx + (z - s[4 * i + 1]) * dz) / l2));
        const y = Y[road.nodes[seg]] + (Y[road.nodes[seg + 1]] - Y[road.nodes[seg]]) * t;
        if (y < 2 && Math.hypot(x - s[4 * i] - dx * t, z - s[4 * i + 1] - dz * t) < road.width / 2 + r) { n++; break; }
      }
    }
    return { n, total: g.world.structures.pillars.length };
  });
  check('no bridge pillars in road lanes', pillarCheck.n === 0, `${pillarCheck.n} of ${pillarCheck.total} pillars stand in a road`);
  // GPS progress: step a car 1.5 m either side of the route from the Storrow
  // exit, round the Beacon Street hairpin and back up Mugar Way (just beyond
  // the ramp's wall). The next route node must stay just ahead of the car:
  // not stalled behind it, not skipped ahead to the return leg.
  const gpsTrack = await page.evaluate(() => {
    const g = RB.game, m = g.missions, c = g.car;
    g.placeCar(-684, -42, 72 * Math.PI / 180, -1.8);
    const st = m.stopPos('Hatch Shell');
    m.setRouteTarget(st.x, st.z);
    const line = m.route.slice(1, -1).map((p) => p.slice());
    const S = [0];
    for (let i = 1; i < line.length; i++) S.push(S[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    const sOf = (p) => { const k = line.findIndex((q) => q[0] === p[0] && q[1] === p[1]); return k < 0 ? null : S[k]; };
    let ahead = 0, behind = 0, n = 0;
    for (const side of [1.5, -1.5]) {
      c.x = line[0][0]; c.z = line[0][1]; c.y = line[0][2];
      m.setRouteTarget(st.x, st.z);
      for (let i = 0; i + 1 < line.length && S[i] < 420; i++) {
        const a = line[i], b = line[i + 1], L = S[i + 1] - S[i];
        if (L < 0.01) continue;
        const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
        for (let d = 0; d < L; d += 1.5) {
          c.x = a[0] + ux * d - uz * side; c.z = a[1] + uz * d + ux * side; c.y = a[2] + (b[2] - a[2]) * d / L;
          c.heading = Math.atan2(ux, -uz);
          m._updateRoute(0.02);
          const s = sOf(m.route[1]);
          if (s === null) continue;
          n++;
          ahead = Math.max(ahead, s - (S[i] + d));
          behind = Math.max(behind, S[i] + d - s);
        }
      }
    }
    m.setRouteTarget(null);
    return { n, ahead, behind };
  });
  check('GPS keeps pace through a hairpin', gpsTrack.n > 200 && gpsTrack.ahead < 30 && gpsTrack.behind < 3,
    `next node at most ${gpsTrack.ahead.toFixed(1)} m ahead, ${gpsTrack.behind.toFixed(1)} m behind (${gpsTrack.n} steps)`);

  // ---- sports car: 200 mph top speed, unchanged launch (physics on a flat stub world)
  const perf = await page.evaluate(async () => {
    const { Vehicle, HANDLING } = await import('/src/vehicle.js');
    const flat = { surfaceAt: () => 2, groundAt: () => 0, groundHeight: (x, z, y, o) => { o.h = 0; o.deck = false; o.inCut = false; return 0; }, resolveCircle: () => false };
    const run = (id) => {
      const v = new Vehicle(HANDLING[id]);
      const inp = { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false };
      let t = 0, t60 = null;
      for (let k = 0; k < 150 * 60; k++) { v.step(1 / 150, inp, flat); t += 1 / 150; if (t60 === null && v.speed >= 60 / 2.23694) t60 = t; }
      return { t60, top: v.speed * 2.23694 };
    };
    return { coupe: run('coupe'), taxi: run('taxi'), suv: run('suv') };
  });
  check('sports car tops out at 200 mph', perf.coupe.top >= 199 && perf.coupe.top <= 203, `${perf.coupe.top.toFixed(1)} mph`);
  check('sports car keeps its launch (0-60 < 3.5 s)', perf.coupe.t60 < 3.5, `0-60 ${perf.coupe.t60.toFixed(2)} s (was 3.39 s); taxi ${perf.taxi.t60.toFixed(2)} s / ${perf.taxi.top.toFixed(0)} mph, SUV ${perf.suv.t60.toFixed(2)} s / ${perf.suv.top.toFixed(0)} mph`);

  // ---- terrain: real hills, and the car follows them
  const hills = await page.evaluate(() => {
    const g = RB.game, T = g.map.terrain, lm = (n) => g.map.landmarks.find((l) => l.name === n);
    const at = (n) => { const l = lm(n); return l ? +T.h(l.x, l.z).toFixed(1) : null; };
    let top = { h: -1 };
    for (let x = -4000; x < -2500; x += 20) for (let z = 2000; z < 3600; z += 20) { const h = T.h(x, z); if (h > top.h) top = { h, x, z }; }
    // The inner harbor off Long Wharf: water, at sea level.
    let sea = Infinity;
    for (let x = 1200; x <= 2000; x += 40) for (let z = -1200; z <= -400; z += 40) sea = Math.min(sea, T.h(x, z));
    return { mission: +top.h.toFixed(1), stateHouse: at('Massachusetts State House'), bunker: at('Bunker Hill Monument'), copley: at('Copley Square'), harbor: +sea.toFixed(1) };
  });
  check('terrain: Mission Hill, Beacon Hill and Bunker Hill rise above Back Bay', hills.mission > 40 && hills.stateHouse > 18 && hills.bunker > 18 && hills.copley < 8 && hills.harbor <= 0.5,
    `Mission Hill ${hills.mission} m, State House ${hills.stateHouse} m, Bunker Hill ${hills.bunker} m, Copley ${hills.copley} m, harbor ${hills.harbor} m`);
  // Up Joy Street from Cambridge Street to the State House (not Somerville's Joy Street).
  await page.evaluate(() => RB.game.begin('free'));
  const hill = await page.evaluate(async () => {
    const g = RB.game, gr = g.graph, T = g.map.terrain;
    let best = null;
    const sh = g.map.landmarks.find((l) => l.name === 'Massachusetts State House');
    for (const r of g.map.roads) {
      if (r.name !== 'Joy Street' || Math.hypot(gr.nx(r.nodes[0]) - sh.x, gr.nz(r.nodes[0]) - sh.z) > 600) continue;
      for (let i = 0; i + 1 < r.nodes.length; i++) {
        const a = r.nodes[i], b = r.nodes[i + 1], ga = T.h(gr.nx(a), gr.nz(a)), gb = T.h(gr.nx(b), gr.nz(b));
        if (!best || Math.min(ga, gb) < best.g) best = ga < gb ? { a, b, g: ga } : { a: b, b: a, g: gb };
      }
    }
    if (!best) return null;
    const { a, b } = best;
    g.placeCar(gr.nx(a), gr.nz(a), Math.atan2(gr.nx(b) - gr.nx(a), -(gr.nz(b) - gr.nz(a))));
    const y0 = g.car.y;
    let minRel = Infinity, maxY = y0, air = 0;
    g.inputOverride = { throttle: 0.7 };
    for (let k = 0; k < 60; k++) {
      await new Promise((r) => setTimeout(r, 100));
      const c = g.car;
      minRel = Math.min(minRel, c.y - T.h(c.x, c.z));
      maxY = Math.max(maxY, c.y);
      if (c.airborne) air++;
    }
    g.inputOverride = null;
    return { y0, climbed: maxY - y0, minRel, air, speed: g.car.speed };
  });
  if (hill) check('drives up Beacon Hill (Joy Street) on the ground', hill.climbed > 3 && hill.minRel > -0.3 && hill.air < 5, `climbed ${hill.climbed.toFixed(1)} m from ${hill.y0.toFixed(1)} m, lowest ${hill.minRel.toFixed(2)} m vs the ground, ${hill.air} airborne samples, ${hill.speed.toFixed(1)} m/s`);
  else check('drives up Beacon Hill (Joy Street) on the ground', false, 'Joy Street not found');
  await shot('t05a_hill');

  // ---- 3D roads: ride the Harvard Bridge deck over the Charles, and the Pike tunnel
  // Heights here are relative to the ground (rel): y = rel + terrain.
  const onRoad = async (re, x, z, rel) => page.evaluate((re, x, z, rel) => {
    const g = RB.game, gr = g.graph, ny = g.map.nodeY, nr = g.map.nodeRel;
    let best = null, bd = Infinity;
    for (const r of g.map.roads) {
      if (!new RegExp(re).test(r.name)) continue;
      for (let i = 0; i + 1 < r.nodes.length; i++) {
        const a = r.nodes[i], b = r.nodes[i + 1];
        const d = (gr.nx(a) - x) ** 2 + (gr.nz(a) - z) ** 2 + ((nr[a] - rel) * 30) ** 2;
        if (d < bd) { bd = d; best = [a, b, r]; }
      }
    }
    const [a, b, r] = best;
    let h = Math.atan2(gr.nx(b) - gr.nx(a), -(gr.nz(b) - gr.nz(a)));
    g.placeCar(gr.nx(a), gr.nz(a), h, ny[a]);
    return { y: g.car.y, nodeY: ny[a], nodeRel: nr[a], name: r.name };
  }, re, x, z, rel);
  const relOf = (s) => page.evaluate((x, y, z) => y - RB.game.map.terrain.h(x, z), s.x, s.y, s.z);
  await page.evaluate(() => RB.game.begin('free'));
  let at = await onRoad('^Massachusetts Avenue$', -2100, 100, 3);
  await drive({ throttle: 0.5 });
  await sleep(2500);
  s = await st();
  let rel = await relOf(s);
  check('drives on the Harvard Bridge deck above the Charles', at.nodeRel > 2 && rel > 2 && s.onDeck && s.sinking === 0, `deck node ${at.nodeRel.toFixed(1)} m up, car ${rel.toFixed(1)} m above the ground/water, splash=${s.sinking > 0}`);
  await shot('t05b_bridge_deck');
  // Climb onto the bridge from street level (not teleported onto the deck).
  const climb = await page.evaluate(() => {
    const g = RB.game, gr = g.graph, ny = g.map.nodeRel;
    // Walk Mass Ave north from an at-grade node in Back Bay until the deck starts.
    let start = -1, bd = Infinity;
    for (const r of g.map.roads) if (r.name === 'Massachusetts Avenue') for (const n of r.nodes) {
      if (Math.abs(ny[n]) > 0.01) continue;
      const d = (gr.nx(n) + 1940) ** 2 + (gr.nz(n) - 330) ** 2;
      if (d < bd) { bd = d; start = n; }
    }
    let prev = -1, cur = start, path = [start], deck = 0;
    for (let k = 0; k < 60; k++) {
      let best = -1, bz = Infinity;
      for (let e = gr.adjStart[cur]; e < gr.adjStart[cur + 1]; e++) {
        const ed = gr.adj[e], v = gr.eTo[ed];
        if (v === prev || !gr.eLegal[ed] || g.map.roads[gr.eRoad[ed]].name !== 'Massachusetts Avenue') continue;
        if (gr.nz(v) < bz) { bz = gr.nz(v); best = v; }
      }
      if (best < 0) break;
      prev = cur; cur = best; path.push(cur);
      if (ny[cur] > 2.5 && ++deck >= 6) break;   // a few nodes onto the deck, out over the river
    }
    const a = path[0], b = path[1];
    g.placeCar(gr.nx(a), gr.nz(a), Math.atan2(gr.nx(b) - gr.nx(a), -(gr.nz(b) - gr.nz(a))));
    window.__climb = path.map((n) => [gr.nx(n), gr.nz(n)]);
    return { n: path.length, top: ny[path[path.length - 1]] };
  });
  await page.evaluate(() => {
    const g = RB.game, pts = window.__climb;
    window.__maxY = 0;
    window.__ci = setInterval(() => {
      const c = g.car;
      let k = 0, bd = Infinity;
      pts.forEach((p, i) => { const d = Math.hypot(p[0] - c.x, p[1] - c.z); if (d < bd) { bd = d; k = i; } });
      const T = pts[Math.min(pts.length - 1, k + 2)];
      let d = Math.atan2(T[0] - c.x, -(T[1] - c.z)) - c.heading;
      while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      g.inputOverride = { throttle: c.speed < 15 ? 1 : 0, steer: Math.max(-1, Math.min(1, d * 2)) };
      window.__maxY = Math.max(window.__maxY, c.y - g.map.terrain.h(c.x, c.z));
    }, 33);
  });
  await sleep(9000);
  const cl = await page.evaluate(() => { clearInterval(window.__ci); RB.game.inputOverride = null; return { maxY: window.__maxY, y: RB.game.car.y, deck: RB.game.car.onDeck, sink: RB.game.sinking }; });
  check('climbs the Harvard Bridge from street level', cl.maxY > 2.5 && cl.sink === 0, `route to deck ${climb.top.toFixed(1)} m over ${climb.n} nodes; car reached ${cl.maxY.toFixed(1)} m up, splash=${cl.sink > 0}`);
  at = await onRoad('^Massachusetts Turnpike$', -1100, 650, -11);
  await drive({ throttle: 0.5 });
  await sleep(2500);
  s = await st();
  rel = await relOf(s);
  check('drives in the Mass Pike tunnel under Back Bay', at.nodeRel < -5 && rel < -5 && s.sinking === 0 && s.street === 'Massachusetts Turnpike', `node ${at.nodeRel.toFixed(1)} m, car ${rel.toFixed(1)} m below the ground, street "${s.street}"`);
  await shot('t05c_tunnel');
  await drive(null);
  const extras = await page.evaluate(() => {
    let props = 0;
    RB.game.world.landmarks.props.traverse((o) => { if (o.isMesh || o.isInstancedMesh) props++; });
    return { posts: RB.game.signs.posts.length, lm: RB.game.world.landmarks.handled.size, props, field: !!RB.game.world.landmarks.field };
  });
  check('street signs at intersections', extras.posts > 1500, `${extras.posts} sign posts`);
  check('landmarks dressed (Fenway etc.)', extras.lm > 40 && extras.props > 30 && extras.field, `${extras.lm} landmark parts, ${extras.props} props, Fenway field ${extras.field}`);

  // ---- fly mode: G toggles, keys fly through buildings, Enter drops the car
  await page.evaluate(() => RB.game.begin('free'));
  await sleep(300);
  await page.keyboard.press('KeyG');
  await sleep(400);
  s = await st();
  check('G enters fly mode', s.state === 'fly' && s.fly, `state ${s.state}`);
  const f0 = s.fly;
  await page.keyboard.down('KeyW'); await page.keyboard.down('Space');
  await sleep(1500);
  await page.keyboard.up('KeyW'); await page.keyboard.up('Space');
  s = await st();
  check('flies forward and up', Math.hypot(s.fly.x - f0.x, s.fly.z - f0.z) > 15 && s.fly.y > f0.y + 10, `moved ${Math.hypot(s.fly.x - f0.x, s.fly.z - f0.z).toFixed(0)} m, climbed ${(s.fly.y - f0.y).toFixed(0)} m`);
  // Fly straight through a tall building (ghost: no collisions).
  const through = await page.evaluate(async () => {
    const g = RB.game, f = g.fly;
    const b = g.map.landmarks.find((l) => l.name === 'Prudential Tower');
    f.x = b.x - 80; f.z = b.z; f.y = 60; f.yaw = Math.PI / 2; f.pitch = 0;
    await new Promise((r) => setTimeout(r, 50));
    return { x0: f.x, bx: b.x };
  });
  await page.keyboard.down('KeyW'); await page.keyboard.down('ShiftLeft');
  await sleep(2000);
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft');
  s = await st();
  check('flies through buildings', s.fly.x > through.bx + 20, `x ${through.x0.toFixed(0)} -> ${s.fly.x.toFixed(0)} past the Prudential at ${through.bx.toFixed(0)}`);
  await shot('t16_fly');
  await page.keyboard.press('Enter');
  await sleep(600);
  s = await st();
  const dropped = await page.evaluate(() => { const c = RB.game.car, r = RB.game.graph.nearestRoad3D(c.x, c.z, c.y, 8); return !!r; });
  check('Enter drops the car onto a road below', s.state === 'play' && dropped, `state ${s.state}, street "${s.street}", y ${s.y.toFixed(1)}`);

  // ---- trains run on the surface network
  await page.evaluate(() => { RB.game.setSetting('traffic', 40); });
  const tr = await page.evaluate(async () => {
    const g = RB.game, T = g.trains;
    const l = g.map.landmarks.find((m) => m.name === 'Longfellow Bridge');
    g.placeCar(l.x - 60, l.z + 40, 0.9);
    const seen = new Set(), moved = [];
    const start = new Map();
    // Which services spawn is random: watch until a Red Line train and two moving ones turn up (45 s at most).
    for (let k = 0; k < 45; k++) {
      await new Promise((r) => setTimeout(r, 1000));
      for (const t of T.trains) {
        seen.add(t.svc.id);
        if (!start.has(t)) start.set(t, t.head);
        else if (t.head - start.get(t) > 30) moved.push(t.svc.id);
      }
      if (k >= 10 && seen.has('red') && new Set(moved).size >= 2) break;
    }
    return { seen: [...seen], moved: [...new Set(moved)], n: T.trains.length, boxes: T.carBoxes.length / 9 };
  });
  check('trains spawn and run (Red Line near the Longfellow)', tr.n >= 3 && tr.moved.length >= 2 && tr.seen.includes('red'), `${tr.n} trains / ${tr.boxes} cars; seen ${tr.seen.join(', ')}; moving ${tr.moved.join(', ')}`);
  const block = await page.evaluate(async () => {
    const g = RB.game, T = g.trains;
    // Park the car on the track ahead of a moving surface train: it must be pushed off, not overlap.
    // An at-grade train (one on a viaduct would just pass over the car).
    const t = T.trains.find((q) => Math.abs(T._relAt(T._sample(q, q.head, {}))) < 0.3 && Math.abs(T._relAt(T._sample(q, q.head - q.length, {}))) < 0.3 && q.v > 3);
    if (!t) return null;
    const p = T._sample(t, t.head + 2, {});
    g.placeCar(p.x, p.z, 0, p.y);
    await new Promise((r) => setTimeout(r, 2500));
    const c = g.car;
    let minD = Infinity;
    for (let i = 0; i < T.carBoxes.length; i += 9) {
      const B = T.carBoxes;
      const along = Math.max(-B[i + 5], Math.min(B[i + 5], (c.x - B[i]) * B[i + 3] + (c.z - B[i + 2]) * B[i + 4]));
      minD = Math.min(minD, Math.hypot(c.x - (B[i] + B[i + 3] * along), c.z - (B[i + 2] + B[i + 4] * along)) - B[i + 6]);
    }
    return { gap: minD, svc: t.svc.id };
  });
  if (block) check('trains are solid', block.gap > 0.4, `car-to-${block.svc} clearance ${block.gap.toFixed(2)} m`);
  else check('trains are solid', false, 'no surface train found');

  // ---- the subway: tunnels, stations with platforms and name boards
  const sub = await page.evaluate(() => {
    const w = RB.game.world.rail, R = RB.game.map.railRel;
    let under = 0;
    for (let i = 0; i < R.length; i++) if (R[i] < -5.6) under++;
    return { platforms: w.platforms.length, underPlat: w.platforms.filter((p) => p.underground).length, names: new Set(w.platforms.map((p) => p.name)).size, under, routes: RB.game.map.railRoutes.length };
  });
  check('subway tunnels and stations', sub.under > 4000 && sub.platforms > 100 && sub.underPlat > 40 && sub.names > 40 && sub.routes >= 16, `${sub.under} tunnel track nodes, ${sub.platforms} platforms (${sub.underPlat} underground) at ${sub.names} stations, ${sub.routes} drivable routes`);

  // ---- drag to look around (car)
  await page.evaluate(() => { RB.game.begin('free'); RB.game.respawn(); });
  await sleep(500);
  await page.mouse.move(640, 360);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) { await page.mouse.move(640 + k * 30, 360 - k * 6); await sleep(16); }
  const dragCar = await page.evaluate(() => ({ yaw: RB.game.chase.look.yaw, pitch: RB.game.chase.look.pitch }));
  await page.mouse.up();
  await sleep(4200);
  const backCar = await page.evaluate(() => RB.game.chase.look.yaw);
  check('drag to look around the car (and it eases back)', dragCar.yaw > 0.8 && dragCar.pitch > 0.1 && Math.abs(backCar) < 0.15, `yaw ${dragCar.yaw.toFixed(2)} pitch ${dragCar.pitch.toFixed(2)} rad while dragging, ${backCar.toFixed(2)} rad 4 s after release`);

  // ---- train mode: menu, drive the Red Line from Harvard to Central
  await page.evaluate(() => { RB.game.toMenu(); RB.game.menu.show('lines'); });
  await sleep(400);
  const lineRows = await page.evaluate(() => document.querySelectorAll('#menu [data-act="train"]').length);
  await shot('t17_train_lines');
  const red = await page.evaluate(async () => {
    const { trainLines } = await import('./src/trainmode.js');
    const l = trainLines(RB.game.map).find((q) => q.ref === 'Red' && q.from === 'Harvard');
    return l ? l.i : -1;
  });
  check('train lines menu', lineRows >= 16 && red >= 0, `${lineRows} lines listed`);
  await page.evaluate((i) => RB.game.beginTrain(i), red);
  await sleep(800);
  s = await st();
  check('train mode starts at the first station', s.state === 'train' && s.train && s.train.phase === 'boarding' && s.train.v === 0, `state ${s.state}, phase ${s.train && s.train.phase}`);
  // Autopilot (each physics step): run at the limit and brake for the stopping mark.
  await page.evaluate(() => {
    RB.game.trainMode.autopilot = (r) => {
      const t = r.train, st = r.stops[r.next];
      let throttle = 0, brake = 0, handbrake = false;
      if (r.phase === 'running') {
        const d = st ? st.s - t.head : 1e9, need = d > 0.3 ? (t.v * t.v) / (2 * (d - 0.3)) : 9;
        const aheadNeed = r.ahead ? (t.v * t.v - r.ahead.v * r.ahead.v) / (2 * Math.max(1, r.ahead.d - 15)) : 0;
        if (need > 0.8 || aheadNeed > 0.75) brake = Math.min(1, Math.max(need, aheadNeed) / 1.3 + 0.05);
        else if (t.v > r.limit - 0.4) brake = 0.25;
        else if (t.v < r.limit - 1.3) throttle = 1;
        if (d < 1.5 && t.v < 0.6) brake = 1;
        handbrake = need > 1.15;
      }
      return { throttle, brake, handbrake };
    };
  });
  let deepest = 0, camUnder = false, sawAI = 0;
  const tStart = Date.now();
  await page.evaluate(() => RB.game.setSetting('trains', 3));
  while (Date.now() - tStart < 180000) {
    await sleep(1000);
    s = await st();
    if (!s.train) break;
    deepest = Math.min(deepest, s.train.rel);
    const v = await page.evaluate(() => {
      const g = RB.game, c = g.camera.position, T = g.map.terrain, tr = g.trains;
      const ai = tr.trains.filter((t) => tr._relAt(tr._sample(t, t.head, {})) < -5).length;
      return { camUnder: c.y < T.h(c.x, c.z) - 3, ai };
    });
    if (v.camUnder) camUnder = true;
    sawAI = Math.max(sawAI, v.ai);
    if (s.train.results.length) break;
  }
  const leg = s.train && s.train.results[0];
  check('drives the Red Line underground to Central and stops at the platform', !!leg && !leg.missed && Math.abs(leg.d) < 4 && deepest < -5 && camUnder, leg ? `${leg.name}: stopped ${leg.d.toFixed(1)} m from the mark, deepest ${deepest.toFixed(1)} m below ground, cab camera underground ${camUnder}` : `no stop after ${((Date.now() - tStart) / 1000).toFixed(0)} s`);
  check('AI trains run in the tunnels in train mode', sawAI > 0, `${sawAI} AI trains underground`);
  await sleep(1500);
  await shot('t18_train_station');
  s = await st();
  check('doors open at the station', s.train && s.train.phase === 'boarding', `phase ${s.train && s.train.phase}`);
  // Drag to look around from the cab.
  await page.mouse.move(640, 360);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) { await page.mouse.move(640 - k * 35, 360); await sleep(16); }
  const dragTrain = await page.evaluate(() => RB.game.trainMode.camera.look.yaw);
  await shot('t19_train_look');
  await page.mouse.up();
  check('drag to look around from the train cab', dragTrain < -0.8, `yaw ${dragTrain.toFixed(2)} rad`);
  await page.keyboard.press('KeyC');
  await sleep(1200);
  await shot('t20_train_chase');
  await page.evaluate(() => { RB.game.trainMode.autopilot = null; RB.game.setSetting('trains', 2); RB.game.begin('free'); RB.game.respawn(); });
  await sleep(500);
  s = await st();
  check('leaving train mode returns to the car', s.state === 'play' && !s.train, `state ${s.state}`);

  // ---- Logan: parked aircraft, arrivals landing, departures taking off (Max density)
  await page.evaluate(() => { RB.game.setSetting('planes', 4); });
  const life = await page.evaluate(async () => {
    const P = RB.game.planes, seen = new Set(), t0 = performance.now();
    while (performance.now() - t0 < 300000) {
      for (const p of P.planes) seen.add(p.state);
      if (seen.has('rollout') && (seen.has('takeoff') || seen.has('climb'))) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return { seen: [...seen], secs: Math.round((performance.now() - t0) / 1000), stats: P.stats(), stands: P.stands.length };
  });
  check('Logan has parked planes at stands', (life.stats.parked || 0) > life.stands * 0.5, `${life.stats.parked} parked at ${life.stands} stands`);
  check('planes land and take off', life.seen.includes('rollout') && (life.seen.includes('takeoff') || life.seen.includes('climb')), `states seen in ${life.secs}s: ${life.seen.join(', ')}`);
  await page.evaluate(() => { RB.game.setSetting('planes', 0); });
  s = await st();
  check('planes setting Off clears the sky', s.planes.total === 0, `${s.planes.total} planes`);
  await page.evaluate(() => { RB.game.setSetting('planes', 2); });

  // ---- race: teleport through checkpoints
  await page.evaluate(() => RB.game.begin('race', 'backbay'));
  await sleep(500);
  s = await st();
  check('race countdown', s.mode === 'race' && s.race && !s.race.started);
  await shot('t07_race_start');
  await sleep(4200);
  s = await st();
  check('race started', s.race.started, `route points ${s.route}`);
  await drive({ throttle: 1 });
  await sleep(2000);
  await shot('t08_race_drive');
  const n = await page.evaluate(() => RB.game.missions.race.stops.length);
  for (let i = 1; i < n; i++) {
    await page.evaluate(() => {
      const r = RB.game.missions.race;
      const t = r.stops[r.next];
      RB.game.placeCar(t.x, t.z, RB.game.car.heading);
    });
    await sleep(250);
  }
  await sleep(500);
  s = await st();
  check('race completes', s.race && s.race.done, `time ${s.race && s.race.time.toFixed(1)}s`);
  await sleep(2200);
  s = await st();
  check('results screen', s.state === 'results');
  await shot('t09_results');
  await drive(null);

  // ---- taxi fare
  await page.evaluate(() => RB.game.begin('taxi'));
  await sleep(800);
  for (const stage of ['pickup', 'drop']) {
    await page.evaluate(() => {
      const t = RB.game.missions.taxi;
      const p = t.stage === 'pickup' ? t.pickup : t.drop;
      RB.game.placeCar(p.x, p.z, RB.game.car.heading);
    });
    await sleep(1400);
    if (stage === 'pickup') await shot('t10_taxi_pickup');
  }
  s = await st();
  check('taxi fare pays out', s.taxi && s.taxi.money > 0, `$${s.taxi && s.taxi.money.toFixed(2)}, stage ${s.taxi && s.taxi.stage}`);

  // ---- map
  await page.evaluate(() => { RB.game.begin('free'); RB.game.missions.setWaypoint(RB.game.map.landmarks[0].x, RB.game.map.landmarks[0].z, RB.game.map.landmarks[0]); RB.game.bigmap.show(true, RB.game.car.x, RB.game.car.z); });
  await sleep(800);
  await shot('t11_bigmap');
  await page.evaluate(() => RB.game.bigmap.show(false));
  s = await st();
  check('GPS route to waypoint', s.route > 2, `${s.route} route points`);

  // ---- every settings value renders without errors
  const sweep = await page.evaluate(async () => {
    const g = RB.game, frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const tried = [];
    for (const [k, vals] of [['quality', ['low', 'medium', 'ultra', 'high']], ['traffic', [0, 40, 26]], ['trains', [0, 1, 3, 4, 2]], ['planes', [0, 1, 3, 4, 2]], ['metric', [true, false]], ['labels', [false, true]], ['arrow', [false, true]], ['boats', [0, 1, 3, 2]], ['weather', ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog', 'dynamic']]]) {
      for (const v of vals) { g.setSetting(k, v); await frames(); tried.push(`${k}=${v}`); }
    }
    for (const c of ['taxi', 'suv', 'coupe']) { g.selectCar(c); await frames(); tried.push('car=' + c); }
    return tried.length;
  });
  check('settings sweep', sweep === 37, `${sweep} combinations rendered`);

  // ---- weather: rain and snow fall, roads get wet / snowy and slippery, T cycles it,
  // and a rainy night still renders (a NaN in the HDR buffer would black out the frame).
  const meanBrightness = async () => {
    const img = decodePNG(await page.screenshot({ type: 'png' }));
    let sum = 0, n = 0;
    for (let i = 0; i < img.data.length; i += img.bpp * 97) { sum += img.data[i] + img.data[i + 1] + img.data[i + 2]; n++; }
    return sum / n / 3;
  };
  await page.evaluate(() => { const g = RB.game; g.begin('free'); g.respawn(); g.weather.setMode('rain', true); g.setSetting('tod', 'night'); });
  await drive({ throttle: 0.6 });
  await sleep(2500);
  s = await st();
  const rainLight = await meanBrightness();
  await shot('t12b_rain_night');
  check('rain: falling, wet roads, less grip, post-processing on', s.weather.rainOn && s.weather.wet > 0.9 && s.weather.grip < 0.9 && s.weather.post, `rain drawn ${s.weather.rainOn}, wet ${s.weather.wet.toFixed(2)}, grip x${s.weather.grip.toFixed(2)}, post ${s.weather.post}`);
  check('rainy night frame renders (no black-out)', rainLight > 8, `mean brightness ${rainLight.toFixed(1)} / 255`);
  await page.evaluate(() => { RB.game.weather.setMode('snow', true); RB.game.setSetting('tod', 'day'); });
  await sleep(2000);
  s = await st();
  await shot('t12c_snow');
  check('snow: falling and settled, slippery', s.weather.snowOn && s.weather.cover > 0.9 && s.weather.grip < 0.75, `snow drawn ${s.weather.snowOn}, cover ${s.weather.cover.toFixed(2)}, grip x${s.weather.grip.toFixed(2)}`);
  await page.keyboard.press('KeyT');
  await sleep(300);
  s = await st();
  check('T cycles the weather', s.weather.mode === 'fog' && s.weather.type === 'fog', `now ${s.weather.mode}`);
  await page.evaluate(() => RB.game.setSetting('weather', 'clear'));
  await drive(null);

  // ---- on the water: boats, rowing, the Head of the Charles, river ice
  await page.evaluate(() => { const g = RB.game; g.setSetting('weather', 'clear'); g.weather.setMode('clear', true); g.ice.setLevel(0); g.setSetting('tod', 'day'); g.begin('free'); });
  const steerBoat = () => page.evaluate(() => {
    // Autopilot: steer along the river line (upstream in a race).
    clearInterval(window._ab);
    window._ab = setInterval(() => {
      const g = RB.game, bm = g.boatMode, b = bm.body;
      if (!b) return;
      const P = bm.path, pr = P.project(b.x, b.z, window._abS ?? null, {});
      window._abS = pr.s;
      const dir = bm.race ? -1 : window._abDir || 1, t = P.at(pr.s + dir * Math.max(25, b.T.len * 2.2), 0, {});
      let e = Math.atan2(t.x - b.x, -(t.z - b.z)) - b.heading;
      while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI;
      g.inputOverride = { throttle: 1, steer: Math.max(-1, Math.min(1, e * 2.5 - b.yawRate * 0.8)) };
    }, 50);
  });
  const onWater = await page.evaluate(() => {
    const g = RB.game;
    g.menu.show('water');
    const rows = document.querySelectorAll('#menu [data-act="regatta"], #menu [data-act="boat"]').length;
    const ferries = document.querySelectorAll('#menu [data-act="ferry"]').length;
    g.menu.hide();
    return { rows, ferries, river: g.boats.path ? g.boats.path.length : 0, course: g.boatMode.course };
  });
  check('On the Water menu and the Head of the Charles course', onWater.rows === 7 && onWater.ferries === 3 && onWater.river > 8000 && onWater.course && Math.abs(onWater.course.length - 4828) < 1 && onWater.course.marks.length === 7,
    `${onWater.rows} race and boat entries, ${onWater.ferries} ferry routes; river ${(onWater.river / 1000).toFixed(1)} km; course ${onWater.course ? onWater.course.marks.map((m) => m.name.split(' ')[0]).join(' > ') : 'none'}`);
  await page.evaluate(() => { window._abDir = 1; RB.game.beginBoat({ type: 'motor' }); });
  await steerBoat();
  await sleep(6000);
  s = await st();
  const crews = s.boats.filter((b) => b.role === 'crew').length;
  check('motorboat: planes off at speed on the Charles', s.state === 'boat' && s.boat && s.boat.speed > 12, `${s.boat && s.boat.speed.toFixed(1)} m/s`);
  check('crews out rowing on the river', crews >= 3, `${crews} crews, ${s.boats.length} boats in all`);
  // Steer straight at the bank: the hull stops at the water's edge.
  const bank = await page.evaluate(async () => {
    clearInterval(window._ab);
    const g = RB.game, b = g.boatMode.body, P = g.boatMode.path, pr = P.project(b.x, b.z, null, {}), p = P.at(pr.s, 0, {});
    // 30 m off the right bank, heading square at it.
    const q = P.at(pr.s, p.right - 30, {});
    b.reset(q.x, q.z, Math.atan2(-p.tz, -p.tx), g.map.terrain.h(q.x, q.z));
    g.inputOverride = { throttle: 1 };
    g.boatMode.peakImpact = 0;
    let hit = 0, dry = 0;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      hit = Math.max(hit, g.boatMode.peakImpact);
      if (!g.collision.isWaterSurface(b.x, b.z)) dry++;
    }
    g.inputOverride = null;
    return { hit, dry, speed: b.speed };
  });
  check('boats bounce off the bank', bank.hit > 1 && bank.dry === 0, `impact ${bank.hit.toFixed(1)} m/s, ${bank.dry} samples ashore`);
  await page.evaluate(() => RB.game.beginBoat({ type: 'eight' }));
  await steerBoat();
  await sleep(9000);
  s = await st();
  await shot('t16_eight');
  check('rowing an eight: stroke rate and speed', s.boat && s.boat.type === 'eight' && s.boat.rate > 25 && s.boat.speed > 6, `rate ${s.boat && s.boat.rate.toFixed(0)}, ${s.boat && s.boat.speed.toFixed(1)} m/s`);
  // E by the river takes a boat out; E by the bank goes ashore.
  const board = await page.evaluate(async () => {
    clearInterval(window._ab);
    const g = RB.game, P = g.boats.path, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    g.inputOverride = null;
    g.begin('free');
    for (let s = 7000; s < 8200; s += 25) {
      const p = P.at(s, 0, {}), q = P.at(s, p.right + 12, {});
      const road = g.graph.nearestRoad3D(q.x, q.z, g.map.terrain.h(q.x, q.z), 40);
      if (!road) continue;
      g.placeOnRoad(road, Math.atan2(p.tx, -p.tz));
      if (g.boatMode.findLaunch(g.car.x, g.car.z, g.car.heading, 'motor')) break;
    }
    g.settings.boat = 'motor';
    g.input.actions.add('board');
    await wait(800);
    const s1 = g.state;
    g.input.actions.add('board');
    await wait(800);
    return { s1, s2: g.state, street: g.hud.streetName.textContent };
  });
  check('E takes a boat out and goes ashore', board.s1 === 'boat' && board.s2 === 'play', `${board.s1} -> ${board.s2} on ${board.street}`);
  // The Head of the Charles: countdown, rolling start, split at a bridge, finish, results.
  await page.evaluate(() => RB.game.beginBoat({ race: 'hoc-eight' }));
  s = await st();
  check('Head of the Charles: countdown with a field of 10', s.boat && s.boat.race && !s.boat.race.started && s.boats.filter((b) => b.role === 'race').length === 9, `${s.boats.filter((b) => b.role === 'race').length} other crews`);
  await steerBoat();
  await sleep(9000);
  s = await st();
  check('Head of the Charles: over the start line, clock running', s.boat.race.started && s.boat.race.t0 !== null && s.boat.race.time > 1, `race time ${s.boat.race.time.toFixed(1)} s at ${Math.round(s.boat.race.start - s.boat.race.s)} m`);
  await page.evaluate(() => {
    const g = RB.game, bm = g.boatMode, r = bm.race, C = bm.course, p = bm.path.at(C.finish + 60, 0, {});
    bm.body.reset(p.x, p.z, Math.atan2(-p.tx, p.tz), g.map.terrain.h(p.x, p.z));
    bm.body.vx = bm.body.fx * 9; bm.body.vz = bm.body.fz * 9; bm.body.rate = 32;
    r.next = C.marks.length - 1; r.sPrev = C.finish + 60; window._abS = C.finish + 60;
  });
  await sleep(12000);
  s = await st();
  const res = await page.evaluate(() => document.querySelector('#menu').innerText);
  check('Head of the Charles: finish and standings', s.state === 'results' && /of 10/.test(res), res.split('\n').filter(Boolean).slice(0, 3).join(' / '));
  await page.evaluate(() => { clearInterval(window._ab); RB.game.inputOverride = null; });
  // The icebreaker: 60 mph flat out but slow to get going, and too tall for the Harvard Bridge.
  const ib = await page.evaluate(async () => {
    const { BoatBody } = await import('./src/boats.js');
    const env = { cw: { isWaterSurface: () => true, resolveCircle: () => false, deckAbove: () => Infinity, terrain: { h: () => 0 } }, ice: null };
    const b = new BoatBody('icebreaker'); b.reset(0, 0, 0, 0);
    let t = 0, t30 = null;
    while (t < 70) { b.step(1 / 150, { throttle: 1, brake: 0, steer: 0 }, env); t += 1 / 150; if (t30 === null && b.vF * 2.237 >= 30) t30 = t; }
    const top = b.vF * 2.237;
    const g = RB.game;
    g.beginBoat({ type: 'icebreaker' });
    const bm = g.boatMode, s = bm.body, P = bm.path, p = P.at(7070, 0, {});
    s.reset(p.x, p.z, Math.atan2(-p.tx, p.tz), g.map.terrain.h(p.x, p.z));
    s.vx = s.fx * 10; s.vz = s.fz * 10;
    g.inputOverride = { throttle: 1 };
    let minS = 1e9;
    for (let i = 0; i < 140; i++) { await new Promise((r) => setTimeout(r, 100)); minS = Math.min(minS, P.project(s.x, s.z, 7000, {}).s); }
    g.inputOverride = null;
    return { top, t30, bow: minS - s.T.len / 2 };
  });
  check('icebreaker: 60 mph top speed, slow to accelerate', ib.top > 59 && ib.top < 61 && ib.t30 > 8, `${ib.top.toFixed(1)} mph flat out, 0-30 mph in ${ib.t30.toFixed(1)} s`);
  check('icebreaker: stopped by a bridge too low for her', ib.bow > 6930, `bow stopped at s ${ib.bow.toFixed(0)} (Harvard Bridge deck at s 6919-6939)`);
  // Icebreaker Ferry: landings along the reach, passengers walk aboard, get off at their stop and pay.
  await page.evaluate(() => { RB.game.beginBoat({ ferry: 'ferry-bu' }); });
  const fy0 = (await st()).boat.ferry;
  let fy = fy0;
  for (let i = 0; i < 40 && !fy.started; i++) { await sleep(500); fy = (await st()).boat.ferry; }
  await shot('t18_ferry');
  check('Icebreaker Ferry: landings, and the first passengers walk aboard', fy0.docks >= 5 && fy.started && fy.aboard > 0 && fy.people > fy.aboard, `${fy0.docks} landings, ${fy.aboard} aboard, ${fy.people} people about`);
  await page.evaluate(() => {
    // Alongside the first group's stop, stopped: the lines go out.
    const g = RB.game, f = g.boatMode.ferry, b = g.boatMode.body, d = f.aboard[0].grp.dest;
    const h = Math.atan2(d.ax, -d.az), fx = Math.sin(h), fz = -Math.cos(h), rx = -fz, rz = fx;
    const A = f._dockPt(d, 1, 2 + 2), sgn = d.nx * rx + d.nz * rz < 0 ? 1 : -1;
    b.x = A.x - fx * 1.9 - rx * sgn * 3.45; b.z = A.z - fz * 1.9 - rz * sgn * 3.45; b.heading = h; b.vx = b.vz = 0;
  });
  for (let i = 0; i < 40 && fy.carried === 0; i++) { await sleep(500); fy = (await st()).boat.ferry; }
  check('Icebreaker Ferry: dock alongside, passengers get off and pay', fy.carried > 0 && fy.money > 0, `${fy.carried} delivered, $${fy.money.toFixed(2)}`);
  await page.evaluate(() => RB.game.begin('free'));

  // Ice: snow freezes the Charles, a car can drive on it, icebreakers cut channels you fall through.
  await page.evaluate(() => { const g = RB.game; g.begin('free'); g.setSetting('weather', 'snow'); g.weather.setMode('snow', true); g.ice.setLevel(0); });
  await sleep(3000);
  s = await st();
  check('snow starts freezing the Charles', s.ice.level > 0.02, `ice level ${s.ice.level.toFixed(3)} after 3 s`);
  await page.evaluate(() => { const g = RB.game, p = g.boats.path.at(7600, 0, {}); g.ice.setLevel(1); g.placeCar(p.x, p.z, Math.atan2(p.tx, -p.tz)); g.inputOverride = { throttle: 0.5 }; });
  await sleep(3000);
  s = await st();
  await shot('t17_ice');
  const breakers = s.boats.filter((b) => b.type === 'icebreaker').length;
  check('drive on the frozen Charles', s.ice.frozen && s.ice.onIce && s.sinking === 0 && s.speed > 2, `on ice ${s.ice.onIce}, speed ${s.speed.toFixed(1)} m/s, splash=${s.sinking > 0}`);
  check('icebreakers break the ice', breakers >= 1 && s.ice.broken > 50, `${breakers} icebreakers, ${s.ice.broken} cells broken`);
  const plunge = await page.evaluate(async () => {
    const g = RB.game, b = g.boats.list.find((x) => x.type === 'icebreaker');
    if (!b) return null;
    g.inputOverride = null;
    const x = b.x - b.fx * (b.T.len / 2 + 2), z = b.z - b.fz * (b.T.len / 2 + 2);
    const state = g.ice.stateAt(x, z);
    g.placeCar(x, z, b.heading);
    await new Promise((r) => setTimeout(r, 900));
    return { state, sinking: g.sinking };
  });
  check('a car falls into an icebreaker channel', plunge && plunge.state !== 'solid' && plunge.sinking > 0, plunge ? `channel ice ${plunge.state}, sinking ${plunge.sinking.toFixed(2)}` : 'no icebreaker');
  await page.evaluate(() => { const g = RB.game; g.setSetting('weather', 'clear'); g.weather.setMode('clear', true); g.ice.setLevel(0); g.begin('free'); g.respawn(); });
  await drive(null);

  // ---- night + perf
  await page.evaluate(() => RB.game.setSetting('tod', 'night'));
  await drive({ throttle: 0.7 });
  await sleep(2500);
  await shot('t12_night');
  await page.evaluate(() => RB.game.setSetting('tod', 'sunset'));
  await sleep(1500);
  await shot('t13_sunset');
  await page.evaluate(() => RB.game.setSetting('tod', 'day'));
  await drive(null);
  await sleep(1500);
  s = await st();
  check('frame rate', s.fps >= 30, `${s.fps} fps, ${s.calls} draw calls, ${(s.tris / 1e6).toFixed(2)}M tris`);
  // ---- phone layout with touch controls
  const phone = await browser.newPage();
  await phone.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  phone.on('pageerror', (e) => logs.push(`[pageerror] phone: ${e.message}`));
  await phone.goto(server.url, { waitUntil: 'load' });
  await phone.waitForFunction(() => window.RB && RB.game && RB.game.ready, { timeout: 120000 });
  await sleep(800);
  await phone.screenshot({ path: path.join(shotsDir, 't14_phone_menu.png') });
  await phone.evaluate(() => RB.game.begin('free'));
  await sleep(1500);
  const touchVisible = await phone.evaluate(() => !document.getElementById('touch').classList.contains('hidden'));
  await phone.screenshot({ path: path.join(shotsDir, 't15_phone_drive.png') });
  check('touch controls on phones', touchVisible);
  await phone.close();
} catch (err) {
  check('no exceptions in test', false, err.stack);
} finally {
  const errors = logs.filter((l) => /\[(error|pageerror)\]/.test(l));
  check('no console errors', errors.length === 0, errors.slice(0, 5).join(' | ').slice(0, 800));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await browser.close();
  server.proc.kill();
  process.exit(failed ? 1 : 0);
}
