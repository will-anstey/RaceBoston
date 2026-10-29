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
      const g = RB.game, l = g.map.landmarks.find((m) => m.name === name);
      g.inputOverride = { brake: 1 };
      g.state = 'paused'; g.menu.hide(); g.hud.show(false);
      g.car.x = l.x; g.car.z = l.z;
      g.camera.position.set(l.x + ox, oy, l.z + oz); g.camera.lookAt(l.x, ty, l.z); g.camera.fov = fov; g.camera.updateProjectionMatrix();
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
        f.x = p.x - fx * 120 + fz * 55; f.z = p.z - fz * 120 - fx * 55; f.y = p.y + 18;
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
