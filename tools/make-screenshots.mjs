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
    window.placeOn = (pattern, x, z, reverse, back = 30) => {
      const g = RB.game, re = new RegExp(pattern);
      let best = null, bd = Infinity;
      for (const r of g.map.roads) {
        if (!re.test(r.name)) continue;
        for (let i = 0; i + 1 < r.nodes.length; i++) {
          const a = r.nodes[i], b = r.nodes[i + 1];
          const mx = (g.graph.nx(a) + g.graph.nx(b)) / 2, mz = (g.graph.nz(a) + g.graph.nz(b)) / 2;
          const d = (mx - x) ** 2 + (mz - z) ** 2;
          if (d < bd) { bd = d; best = { a, b, mx, mz }; }
        }
      }
      const [a, b] = reverse ? [best.b, best.a] : [best.a, best.b];
      const h = Math.atan2(g.graph.nx(b) - g.graph.nx(a), -(g.graph.nz(b) - g.graph.nz(a)));
      g.placeCar(best.mx - Math.sin(h) * back, best.mz + Math.cos(h) * back, h);
    };
    RB.game.setSetting('traffic', 30);
    RB.game.begin('free');
    RB.game.hud.hintEl.style.opacity = '0';
  });
  const shots = [
    { file: 'screenshot-drive.jpg', road: '^Commonwealth Avenue$', x: -1100, z: 330, rev: true, tod: 'day', thr: 0.6, cam: 0 },
    { file: 'screenshot-bridge.jpg', road: '^Massachusetts Avenue$', x: -2050, z: 50, rev: false, tod: 'day', thr: 0.7, cam: 0 },
    { file: 'screenshot-zakim.jpg', road: 'Fitzgerald', x: 300, z: -1640, rev: false, tod: 'sunset', thr: 0.8, cam: 1 },
    { file: 'screenshot-night.jpg', road: '^Boylston Street$', x: -900, z: 640, rev: false, tod: 'night', thr: 0.5, cam: 0 },
  ];
  for (const s of shots) {
    await page.evaluate((s) => {
      const g = RB.game;
      g.inputOverride = null;
      g.setSetting('tod', s.tod);
      g.chase.mode = s.cam;
      placeOn(s.road, s.x, s.z, s.rev);
      g.inputOverride = { throttle: s.thr };
    }, s);
    await sleep(3200);
    await page.screenshot({ path: path.join(docs, s.file), type: 'jpeg', quality: 86 });
    console.log('wrote', s.file, await page.evaluate(() => RB.game.hud.streetName.textContent));
  }
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
