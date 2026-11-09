// Regenerates the README screenshots in docs/.
//   node tools/make-screenshots.mjs

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer, launch, sleep } from './browser.mjs';

const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
fs.mkdirSync(docs, { recursive: true });
const server = await startServer(8135);
const { browser, page, logs } = await launch({ width: 1600, height: 900 });
try {
  await page.goto(server.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.RB && RB.game && RB.game.ready, { timeout: 120000 });
  await page.evaluate(() => {
    // Place the car on the named road segment nearest to (x, z).
    window.placeOn = (pattern, x, z, reverse, back = 30, y = null) => {
      const g = RB.game, re = new RegExp(pattern);
      let best = null, bd = Infinity;
      for (const r of g.map.roads) {
        if (!re.test(r.name)) continue;
        for (let i = 0; i + 1 < r.nodes.length; i++) {
          const a = r.nodes[i], b = r.nodes[i + 1];
          const mx = (g.graph.nx(a) + g.graph.nx(b)) / 2, mz = (g.graph.nz(a) + g.graph.nz(b)) / 2;
          const d = (mx - x) ** 2 + (mz - z) ** 2 + (y === null ? 0 : ((g.map.nodeY[a] - y) * 30) ** 2);
          if (d < bd) { bd = d; best = { a, b, mx, mz }; }
        }
      }
      const [a, b] = reverse ? [best.b, best.a] : [best.a, best.b];
      const h = Math.atan2(g.graph.nx(b) - g.graph.nx(a), -(g.graph.nz(b) - g.graph.nz(a)));
      g.placeCar(best.mx - Math.sin(h) * back, best.mz + Math.cos(h) * back, h, g.map.nodeY[a]);
    };
    RB.game.setSetting('traffic', 30);
    RB.game.weather.setMode('clear', true);
    RB.game.begin('free');
    RB.game.hud.hintEl.style.opacity = '0';
  });
  const shots = [
    { file: 'screenshot-drive.jpg', road: '^Commonwealth Avenue$', x: -1100, z: 330, rev: true, tod: 'day', thr: 0.6, cam: 0 },
    { file: 'screenshot-bridge.jpg', road: '^Massachusetts Avenue$', x: -2050, z: 50, rev: false, tod: 'day', thr: 0.7, cam: 0 },
    { file: 'screenshot-zakim.jpg', road: 'Fitzgerald', x: 300, z: -1500, rev: false, tod: 'sunset', thr: 0.8, cam: 1, y: 19 },
    { file: 'screenshot-night.jpg', road: '^Boylston Street$', x: -900, z: 640, rev: false, tod: 'night', thr: 0.5, cam: 0 },
  ];
  for (const s of shots) {
    await page.evaluate((s) => {
      const g = RB.game;
      g.inputOverride = null;
      g.setSetting('tod', s.tod);
      g.chase.mode = s.cam;
      placeOn(s.road, s.x, s.z, s.rev, 30, s.y ?? null);
      g.inputOverride = { throttle: s.thr };
    }, s);
    await sleep(3200);
    await page.screenshot({ path: path.join(docs, s.file), type: 'jpeg', quality: 86 });
    console.log('wrote', s.file, await page.evaluate(() => RB.game.hud.streetName.textContent));
  }
  // Inside the Mass Pike tunnel under the Prudential.
  await page.evaluate(() => {
    const g = RB.game, ny = g.map.nodeY;
    g.inputOverride = null;
    g.setSetting('tod', 'day');
    g.chase.mode = 0;
    let best = null, bd = Infinity;
    for (const r of g.map.roads) {
      if (r.name !== 'Massachusetts Turnpike' || !r.tunnel) continue;
      for (let i = 0; i + 1 < r.nodes.length; i++) {
        const a = r.nodes[i], b = r.nodes[i + 1];
        const d = (g.graph.nx(a) + 1250) ** 2 + (g.graph.nz(a) - 700) ** 2;
        if (d < bd && g.graph.nx(b) > g.graph.nx(a)) { bd = d; best = [a, b]; }
      }
    }
    const [a, b] = best;
    g.placeCar(g.graph.nx(a), g.graph.nz(a), Math.atan2(g.graph.nx(b) - g.graph.nx(a), -(g.graph.nz(b) - g.graph.nz(a))), ny[a]);
    g.inputOverride = { throttle: 0.7 };
  });
  await sleep(3200);
  await page.screenshot({ path: path.join(docs, 'screenshot-tunnel.jpg'), type: 'jpeg', quality: 86 });
  console.log('wrote screenshot-tunnel.jpg', await page.evaluate(() => RB.game.car.y.toFixed(1)));
  // Landmarks from the air.
  for (const [file, name, ox, oy, oz, ty, fov] of [['screenshot-fenway.jpg', 'Fenway Park', 170, 110, 150, 0, 55], ['screenshot-statehouse.jpg', 'Massachusetts State House', 25, 34, 150, 20, 50]]) {
    await page.evaluate((name, ox, oy, oz, ty, fov) => {
      const g = RB.game, l = g.map.landmarks.find((m) => m.name === name), y0 = g.map.terrain.h(l.x, l.z);
      g.inputOverride = { brake: 1 };
      g.state = 'paused'; g.menu.hide(); g.hud.show(false);
      g.car.x = l.x; g.car.z = l.z;
      g.camera.position.set(l.x + ox, y0 + oy, l.z + oz); g.camera.lookAt(l.x, y0 + ty, l.z); g.camera.fov = fov; g.camera.updateProjectionMatrix();
    }, name, ox, oy, oz, ty, fov);
    await sleep(1800);
    await page.screenshot({ path: path.join(docs, file), type: 'jpeg', quality: 86 });
    console.log('wrote', file);
  }
  await page.evaluate(() => { const g = RB.game; g.state = 'play'; g.hud.show(true); });
  // A Red Line train crossing the Longfellow, seen from the air in fly mode.
  await page.evaluate(() => { RB.game.setSetting('traffic', 40); RB.game.beginFly(); RB.game.hud.show(false); });
  const redOk = await page.evaluate(async () => {
    const g = RB.game, T = g.trains, f = g.fly;
    const l = g.map.landmarks.find((m) => m.name === 'Longfellow Bridge');
    f.x = l.x; f.z = l.z + 60; f.y = 60; f.pitch = -0.5;
    for (let k = 0; k < 60; k++) {
      await new Promise((r) => setTimeout(r, 1000));
      for (const t of T.trains) {
        if (t.svc.id !== 'red') continue;
        const p = T._sample(t, t.head - t.length / 2, {});
        if (p.y < 4 || Math.hypot(p.x - l.x, p.z - l.z) > 400) continue;
        const q = T._sample(t, t.head, {});
        const dx = q.x - p.x, dz = q.z - p.z, n = Math.hypot(dx, dz) || 1;
        f.x = p.x + (-dz / n) * 45 + (dx / n) * 40; f.z = p.z + (dx / n) * 45 + (dz / n) * 40; f.y = p.y + 14;
        f.yaw = Math.atan2(p.x - f.x, -(p.z - f.z)); f.pitch = -0.22;
        return true;
      }
    }
    return false;
  });
  await sleep(500);
  if (redOk) await page.screenshot({ path: path.join(docs, 'screenshot-redline.jpg'), type: 'jpeg', quality: 86 });
  console.log('wrote screenshot-redline.jpg', redOk);
  // A jet on short final to 4R over the harbor, with the airport behind it.
  await page.evaluate(() => { RB.game.setSetting('planes', 4); });
  const finalOk = await page.evaluate(async () => {
    const g = RB.game, P = g.planes, f = g.fly, e = P.ends.get('4R');
    for (let k = 0; k < 480; k++) {
      const p = P.planes.find((q) => q.state === 'approach' && q.end === e && q.air.length - q.air.s < 1900 && q.air.length - q.air.s > 1300);
      if (p) {
        const fx = Math.sin(p.heading), fz = -Math.cos(p.heading);
        f.x = p.x - fx * 120 + fz * 55; f.z = p.z - fz * 120 - fx * 55; f.y = p.y + P.elev + 18;
        f.yaw = Math.atan2(p.x + fx * 250 - f.x, -(p.z + fz * 250 - f.z)); f.pitch = -0.1;
        return true;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  });
  await sleep(300);
  if (finalOk) await page.screenshot({ path: path.join(docs, 'screenshot-logan.jpg'), type: 'jpeg', quality: 86 });
  console.log('wrote screenshot-logan.jpg', finalOk);
  await page.evaluate(() => { RB.game.setSetting('planes', 2); RB.game.exitFly(false); RB.game.hud.show(true); });
  // Up Beacon Hill: Joy Street climbing toward the State House.
  await page.evaluate(() => {
    const g = RB.game, T = g.map.terrain;
    g.setSetting('tod', 'day');
    g.chase.mode = 0;
    const sh = g.map.landmarks.find((l) => l.name === 'Massachusetts State House');
    let best = null;
    for (const r of g.map.roads) {
      if (r.name !== 'Joy Street' || Math.hypot(g.graph.nx(r.nodes[0]) - sh.x, g.graph.nz(r.nodes[0]) - sh.z) > 600) continue;
      for (let i = 0; i + 1 < r.nodes.length; i++) {
        const a = r.nodes[i], b = r.nodes[i + 1], ha = T.h(g.graph.nx(a), g.graph.nz(a)), hb = T.h(g.graph.nx(b), g.graph.nz(b));
        if (!best || Math.min(ha, hb) < best.h) best = ha < hb ? { a, b, h: ha } : { a: b, b: a, h: hb };
      }
    }
    const { a, b } = best;
    g.placeCar(g.graph.nx(a), g.graph.nz(a), Math.atan2(g.graph.nx(b) - g.graph.nx(a), -(g.graph.nz(b) - g.graph.nz(a))));
    g.inputOverride = { throttle: 0.45 };
  });
  await sleep(3000);
  await page.screenshot({ path: path.join(docs, 'screenshot-hill.jpg'), type: 'jpeg', quality: 86 });
  console.log('wrote screenshot-hill.jpg');
  // The cab of a Green Line train pulling into Park Street.
  const cabOk = await page.evaluate(async () => {
    const g = RB.game, { trainLines } = await import('./src/trainmode.js');
    const l = trainLines(g.map).find((q) => q.ref === 'Green-D' && q.from === 'Union Square');
    if (!l) return false;
    g.inputOverride = null;
    g.setSetting('trains', 3);
    g.beginTrain(l.i);
    const r = g.trainMode.run, k = r.stops.findIndex((s) => s.name === 'Park Street');
    if (k < 0) return false;
    r.phase = 'running'; r.started = true; r.next = k;
    r.train.head = r.stops[k].s - 75; r.train.v = 4.2;
    g.trainMode.camera.snap();
    g.inputOverride = { brake: 0.1 };
    await new Promise((res) => setTimeout(res, 2600));
    return true;
  });
  if (cabOk) await page.screenshot({ path: path.join(docs, 'screenshot-subway.jpg'), type: 'jpeg', quality: 86 });
  console.log('wrote screenshot-subway.jpg', cabOk);
  await page.evaluate(() => { const g = RB.game; g.inputOverride = null; g.setSetting('trains', 2); g.begin('free'); });
  // Weather: a rainy night on Commonwealth Avenue, and Boylston Street under snow.
  for (const [file, w, tod, road, x, z] of [['screenshot-rain.jpg', 'rain', 'night', '^Commonwealth Avenue$', -1500, 250], ['screenshot-snow.jpg', 'snow', 'day', '^Boylston Street$', -900, 640]]) {
    await page.evaluate((w, tod, road, x, z) => {
      const g = RB.game;
      g.inputOverride = null;
      g.setSetting('tod', tod);
      g.weather.setMode(w, true);
      g.chase.mode = 0;
      placeOn(road, x, z, false);
      g.inputOverride = { throttle: 0.55 };
    }, w, tod, road, x, z);
    await sleep(3500);
    await page.screenshot({ path: path.join(docs, file), type: 'jpeg', quality: 86 });
    console.log('wrote', file);
  }
  await page.evaluate(() => { const g = RB.game; g.weather.setMode('clear', true); g.setSetting('tod', 'day'); });
  // The Head of the Charles: an eight closing on the Weeks Footbridge, spectators on the bridge.
  await page.evaluate(() => {
    const g = RB.game;
    g.inputOverride = null;
    g.ice.setLevel(0);
    g.beginBoat({ race: 'hoc-eight' });
    const bm = g.boatMode, r = bm.race, C = bm.course, m = C.marks.find((x) => /Weeks/.test(x.name));
    r.countdown = 0;
    window._shotS = m.s + 150;
    const p = bm.path.at(window._shotS, 0, {});
    bm.body.reset(p.x, p.z, Math.atan2(-p.tx, p.tz), g.map.terrain.h(p.x, p.z));
    r.t0 = 0; r.next = C.marks.indexOf(m); r.sPrev = window._shotS;
    bm.camera.mode = 0;
    bm.camera.snap();
    // Steer up the river line.
    clearInterval(window._ab);
    window._ab = setInterval(() => {
      const b = bm.body;
      if (!b) return;
      const pr = bm.path.project(b.x, b.z, window._shotS, {}), t = bm.path.at(pr.s - 40, 0, {});
      window._shotS = pr.s;
      let e = Math.atan2(t.x - b.x, -(t.z - b.z)) - b.heading;
      while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI;
      g.inputOverride = { throttle: 1, steer: Math.max(-1, Math.min(1, e * 2.5 - b.yawRate * 0.8)) };
    }, 50);
  });
  await sleep(6500);
  await page.screenshot({ path: path.join(docs, 'screenshot-hocr.jpg'), type: 'jpeg', quality: 86 });
  console.log('wrote screenshot-hocr.jpg');
  // The Icebreaker Ferry: passengers boarding at Magazine Beach.
  const ferryOk = await page.evaluate(async () => {
    const g = RB.game, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    clearInterval(window._ab);
    g.inputOverride = null;
    g.setSetting('tod', 'day');
    g.beginBoat({ ferry: 'ferry-bu' });
    const f = g.boatMode.ferry;
    for (let i = 0; i < 60 && !f.started; i++) await wait(250);
    // Moor at the landing with the most people waiting, and catch them walking aboard.
    const d = f.docks.filter((x) => f._pickupsAt(x).length).sort((a, c) => f._pickupsAt(c).length - f._pickupsAt(a).length)[0] || f.docks[1];
    const b = g.boatMode.body, h = Math.atan2(d.ax, -d.az), fx = Math.sin(h), fz = -Math.cos(h), rx = -fz, rz = fx;
    const A = f._dockPt(d, 1, 2 + 2), sgn = d.nx * rx + d.nz * rz < 0 ? 1 : -1;
    b.x = A.x - fx * 1.9 - rx * sgn * 3.45; b.z = A.z - fz * 1.9 - rz * sgn * 3.45; b.heading = h; b.vx = b.vz = 0;
    for (let i = 0; i < 80 && !(f.moor && f.moor.stage === 'on'); i++) await wait(250);
    await wait(2600);
    return !!f.moor;
  });
  await page.screenshot({ path: path.join(docs, 'screenshot-ferry.jpg'), type: 'jpeg', quality: 86 });
  console.log('wrote screenshot-ferry.jpg', ferryOk);
  await page.evaluate(() => RB.game.begin('free'));
  // A frozen Charles with an icebreaker at work below the Longfellow.
  await page.evaluate(() => {
    const g = RB.game;
    clearInterval(window._ab);
    g.inputOverride = null;
    g.begin('free');
    g.weather.setMode('snow', true);
    g.ice.setLevel(1);
  });
  await sleep(9000);
  const ib = await page.evaluate(() => {
    const g = RB.game, b = g.boats.list.find((x) => x.type === 'icebreaker');
    if (!b) return false;
    g.beginFly();
    g.fly.x = b.x - b.fx * 70 + -b.fz * 28; g.fly.z = b.z - b.fz * 70 + b.fx * 28; g.fly.y = b.y + 24;
    g.fly.yaw = Math.atan2(b.x - g.fly.x, -(b.z - g.fly.z)); g.fly.pitch = -0.27;
    g.hud.show(false);
    return true;
  });
  await sleep(2500);
  if (ib) await page.screenshot({ path: path.join(docs, 'screenshot-icebreaker.jpg'), type: 'jpeg', quality: 86 });
  console.log('wrote screenshot-icebreaker.jpg', ib);
  await page.evaluate(() => { const g = RB.game; g.hud.show(true); g.exitFly(false); g.weather.setMode('clear', true); g.ice.setLevel(0); g.begin('free'); });
  // Map with a GPS route across town.
  await page.evaluate(() => {
    const g = RB.game;
    g.inputOverride = { brake: 1 };
    g.setSetting('tod', 'day');
    g.chase.mode = 0;
    placeOn('^Charles Street$', -300, -20, false);
    const l = g.map.landmarks.find((m) => m.name === 'Fenway Park');
    g.missions.setWaypoint(l.x, l.z, l);
    g.bigmap.show(true, -1200, 300);
    g.bigmap.zoom = 1.9;
  });
  await sleep(900);
  await page.screenshot({ path: path.join(docs, 'screenshot-map.jpg'), type: 'jpeg', quality: 86 });
  console.log('wrote screenshot-map.jpg');
} finally {
  const errors = logs.filter((l) => /\[(error|pageerror)\]/.test(l));
  if (errors.length) console.log(errors.join('\n'));
  await browser.close();
  server.proc.kill();
}
