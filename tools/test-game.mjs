// End-to-end test: boots the game in headless Chrome and exercises driving,
// collisions, water, traffic, a race, a taxi fare, the map and night mode.
//
//   node tools/test-game.mjs            (screenshots -> tools/screenshots/)

import path from 'node:path';
import { startServer, launch, shotsDir, sleep } from './browser.mjs';

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

  // ---- free roam start
  await page.evaluate(() => RB.game.begin('free'));
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
  const vBefore = (await st()).speed;
  await drive({ brake: 1 });
  await sleep(1300);
  s = await st();
  check('brakes hard', s.speed < 3, `speed ${vBefore.toFixed(1)} -> ${s.speed.toFixed(2)} m/s in 1.3s`);
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
    await sleep(2200);
    s = await st();
    const sankOrRespawned = s.sinking > 0;
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
      if (t.wrecked || Math.abs(t.y) > 0.3) continue;
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

  // ---- sports car: 200 mph top speed, unchanged launch (physics on a flat stub world)
  const perf = await page.evaluate(async () => {
    const { Vehicle, HANDLING } = await import('/src/vehicle.js');
    const flat = { surfaceAt: () => 2, groundHeight: (x, z, y, o) => { o.h = 0; o.deck = false; o.inCut = false; return 0; }, resolveCircle: () => false };
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

  // ---- 3D roads: ride the Harvard Bridge deck over the Charles, and the Pike tunnel
  const onRoad = async (re, x, z, y) => page.evaluate((re, x, z, y) => {
    const g = RB.game, gr = g.graph, ny = g.map.nodeY;
    let best = null, bd = Infinity;
    for (const r of g.map.roads) {
      if (!new RegExp(re).test(r.name)) continue;
      for (let i = 0; i + 1 < r.nodes.length; i++) {
        const a = r.nodes[i], b = r.nodes[i + 1];
        const d = (gr.nx(a) - x) ** 2 + (gr.nz(a) - z) ** 2 + ((ny[a] - y) * 30) ** 2;
        if (d < bd) { bd = d; best = [a, b, r]; }
      }
    }
    const [a, b, r] = best;
    let h = Math.atan2(gr.nx(b) - gr.nx(a), -(gr.nz(b) - gr.nz(a)));
    g.placeCar(gr.nx(a), gr.nz(a), h, ny[a]);
    return { y: g.car.y, nodeY: ny[a], name: r.name };
  }, re, x, z, y);
  await page.evaluate(() => RB.game.begin('free'));
  let at = await onRoad('^Massachusetts Avenue$', -2100, 100, 3);
  await drive({ throttle: 0.5 });
  await sleep(2500);
  s = await st();
  check('drives on the Harvard Bridge deck above the Charles', at.nodeY > 2 && s.y > 2 && s.onDeck && s.sinking === 0, `deck node y ${at.nodeY.toFixed(1)}, car y ${s.y.toFixed(1)}, splash=${s.sinking > 0}`);
  await shot('t05b_bridge_deck');
  // Climb onto the bridge from street level (not teleported onto the deck).
  const climb = await page.evaluate(() => {
    const g = RB.game, gr = g.graph, ny = g.map.nodeY;
    // Walk Mass Ave north from an at-grade node in Back Bay until the deck starts.
    let start = -1, bd = Infinity;
    for (const r of g.map.roads) if (r.name === 'Massachusetts Avenue') for (const n of r.nodes) {
      if (Math.abs(ny[n]) > 0.01) continue;
      const d = (gr.nx(n) + 1940) ** 2 + (gr.nz(n) - 330) ** 2;
      if (d < bd) { bd = d; start = n; }
    }
    let prev = -1, cur = start, path = [start];
    for (let k = 0; k < 40; k++) {
      let best = -1, bz = Infinity;
      for (let e = gr.adjStart[cur]; e < gr.adjStart[cur + 1]; e++) {
        const ed = gr.adj[e], v = gr.eTo[ed];
        if (v === prev || !gr.eLegal[ed] || g.map.roads[gr.eRoad[ed]].name !== 'Massachusetts Avenue') continue;
        if (gr.nz(v) < bz) { bz = gr.nz(v); best = v; }
      }
      if (best < 0) break;
      prev = cur; cur = best; path.push(cur);
      if (ny[cur] > 2.5) break;
    }
    const a = path[0], b = path[1];
    g.placeCar(gr.nx(a), gr.nz(a), Math.atan2(gr.nx(b) - gr.nx(a), -(gr.nz(b) - gr.nz(a))), 0);
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
      window.__maxY = Math.max(window.__maxY, c.y);
    }, 33);
  });
  await sleep(9000);
  const cl = await page.evaluate(() => { clearInterval(window.__ci); RB.game.inputOverride = null; return { maxY: window.__maxY, y: RB.game.car.y, deck: RB.game.car.onDeck, sink: RB.game.sinking }; });
  check('climbs the Harvard Bridge from street level', cl.maxY > 2.5 && cl.sink === 0, `route to deck ${climb.top.toFixed(1)} m over ${climb.n} nodes; car reached ${cl.maxY.toFixed(1)} m, splash=${cl.sink > 0}`);
  at = await onRoad('^Massachusetts Turnpike$', -1100, 650, -11);
  await drive({ throttle: 0.5 });
  await sleep(2500);
  s = await st();
  check('drives in the Mass Pike tunnel under Back Bay', at.nodeY < -5 && s.y < -5 && s.sinking === 0 && s.street === 'Massachusetts Turnpike', `node y ${at.nodeY.toFixed(1)}, car y ${s.y.toFixed(1)}, street "${s.street}"`);
  await shot('t05c_tunnel');
  await drive(null);
  const extras = await page.evaluate(() => ({ posts: RB.game.signs.posts.length, lm: RB.game.world.landmarks.handled.size, props: RB.game.world.landmarks.props.children.length, field: !!RB.game.world.landmarks.field }));
  check('street signs at intersections', extras.posts > 1500, `${extras.posts} sign posts`);
  check('landmarks dressed (Fenway etc.)', extras.lm > 40 && extras.props > 30 && extras.field, `${extras.lm} landmark parts, ${extras.props} props, Fenway field ${extras.field}`);

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
    for (const [k, vals] of [['quality', ['low', 'medium', 'ultra', 'high']], ['traffic', [0, 40, 26]], ['metric', [true, false]], ['labels', [false, true]], ['arrow', [false, true]]]) {
      for (const v of vals) { g.setSetting(k, v); await frames(); tried.push(`${k}=${v}`); }
    }
    for (const c of ['taxi', 'suv', 'coupe']) { g.selectCar(c); await frames(); tried.push('car=' + c); }
    return tried.length;
  });
  check('settings sweep', sweep === 16, `${sweep} combinations rendered`);

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
