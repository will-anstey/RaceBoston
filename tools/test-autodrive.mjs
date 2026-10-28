// Drives races for real with a simple GPS-following autopilot to verify they
// are completable and to calibrate medal times.
//
//   node tools/test-autodrive.mjs [raceId ...]     (default: all races)

import path from 'node:path';
import { startServer, launch, shotsDir, sleep } from './browser.mjs';

const server = await startServer(8127);
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
let failures = 0;
try {
  await page.goto(server.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.RB && RB.game && RB.game.ready, { timeout: 120000 });
  const all = await page.evaluate(() => RB.game.menu && (window.__races = null, true));
  const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['backbay', 'freedom', 'river', 'seaport', 'campus', 'garden', 'grand'];
  for (const id of ids) {
    await page.evaluate((id) => {
      RB.game.setSetting('traffic', 12);
      RB.game.begin('race', id);
      clearInterval(window.__auto);
      const st = { stuck: 0, reverse: 0 };
      window.__autoStats = { crashes: 0, resets: 0, maxSpeed: 0 };
      window.__auto = setInterval(() => {
        const g = RB.game, c = g.car, m = g.missions;
        if (!m.race || !m.race.started || m.race.done) { g.inputOverride = null; return; }
        window.__autoStats.maxSpeed = Math.max(window.__autoStats.maxSpeed, c.speed);
        if (c.impact > 5) window.__autoStats.crashes++;
        if (st.reverse > 0) {
          st.reverse -= 0.033;
          g.inputOverride = { brake: 1, steer: st.revSteer };
          return;
        }
        const L = 6 + c.speed * 0.7;
        const p = m._routeAhead(L);
        if (!p) return;
        const ang = Math.atan2(p[0] - c.x, -(p[1] - c.z));
        let d = ang - c.heading;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const steer = Math.max(-1, Math.min(1, d * 1.8 - c.yawRate * 0.15));
        const p2 = m._routeAhead(L + 30);
        const a2 = Math.atan2(p2[0] - p[0], -(p2[1] - p[1]));
        let bend = Math.abs(a2 - ang);
        if (bend > Math.PI) bend = 2 * Math.PI - bend;
        const vt = Math.max(9, 36 - bend * 22 - Math.abs(d) * 16);
        g.inputOverride = { throttle: c.speed < vt ? 1 : 0, brake: c.speed > vt + 3 ? 1 : 0, steer, boost: c.speed < vt - 8 && Math.abs(d) < 0.1 };
        if (c.speed < 1.2) st.stuck += 0.033; else st.stuck = 0;
        if (st.stuck > 1.8) {
          st.stuck = 0; st.reverse = 1.1; st.revSteer = -Math.sign(d || 1);
          // Record what we are stuck on.
          const o = {}; let kinds = [];
          for (const off of c.h.circles) if (g.collision.resolveCircle(c.x + c.fx * off, c.z + c.fz * off, c.h.radius + 0.4, o)) kinds.push(['', 'building', 'railing', 'tree', 'bounds'][o.kind]);
          const tr = g.traffic.cars.some((t) => Math.hypot(t.x - c.x, t.z - c.z) < 7);
          (window.__stuckLog = window.__stuckLog || []).push(`${c.x.toFixed(0)},${c.z.toFixed(0)} ${kinds.join('/') || (tr ? 'traffic' : 'nothing?')} [${g.hud.streetName.textContent}]`);
        }
        if (st.stuckLong === undefined) st.stuckLong = 0;
      }, 33);
    }, id);
    const t0 = Date.now();
    let last = null, lastMove = Date.now(), lastPos = null, shots = 0;
    while (Date.now() - t0 < 14 * 60 * 1000) {
      await sleep(2000);
      last = await page.evaluate(() => ({ ...RB.game.debugState(), stats: window.__autoStats, info: RB.game.missions.race && RB.game.missions.race.info }));
      if (!last.race) break;
      if (last.race.done) break;
      if (lastPos && Math.hypot(last.x - lastPos.x, last.z - lastPos.z) > 5) lastMove = Date.now();
      lastPos = { x: last.x, z: last.z };
      if (Date.now() - lastMove > 20000) {
        // Truly stuck: use the in-game reset like a player would.
        await page.evaluate(() => { RB.game.respawn(); window.__autoStats.resets++; });
        lastMove = Date.now();
      }
      if ((Date.now() - t0) / 1000 > (shots + 1) * 30 && shots < 3) {
        shots++;
        await page.screenshot({ path: path.join(shotsDir, `auto_${id}_${shots}.png`) });
      }
    }
    const stuckLog = await page.evaluate(() => { const l = window.__stuckLog || []; window.__stuckLog = []; return l; });
    if (stuckLog.length) console.log(`  stuck ${stuckLog.length}x: ${stuckLog.slice(0, 12).join(' | ')}`);
    const ok = last && last.race && last.race.done;
    if (!ok) failures++;
    const info = last.info || {};
    console.log(`${ok ? 'DONE' : 'FAIL'}  ${id}: time ${last.race ? last.race.time.toFixed(1) : '?'}s  checkpoint ${last.race ? last.race.next : '?'}  ` +
      `route ${(info.length / 1000).toFixed(2)}km  gold ${info.gold?.toFixed(0)}s silver ${info.silver?.toFixed(0)}s bronze ${info.bronze?.toFixed(0)}s  ` +
      `crashes ${last.stats.crashes} resets ${last.stats.resets} vmax ${last.stats.maxSpeed.toFixed(0)}m/s fps ${last.fps}`);
    await page.evaluate(() => { clearInterval(window.__auto); RB.game.inputOverride = null; });
  }
} finally {
  const errors = logs.filter((l) => /\[(error|pageerror)\]/.test(l));
  if (errors.length) console.log('console errors:', errors.slice(0, 5).join('\n'));
  await browser.close();
  server.proc.kill();
  process.exit(failures ? 1 : 0);
}
