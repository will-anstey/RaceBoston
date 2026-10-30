// Train mode end to end: an autopilot drives every line (both directions)
// from its first stop to its last, running at the limit and braking for the
// stopping marks. Each line must finish with every stop made close to its
// mark, without tripping the train protection, on a sensible track profile
// (no grade over 16%: ramps beside level crossings and portals are steep,
// but a step in the track would be steeper).
//
//   node tools/test-trains.mjs [filter]     e.g. "Red" or "Green-E"
//
// Runs 8x faster than real time (the train physics steps at 60 Hz).

import path from 'node:path';
import { startServer, launch, shotsDir, sleep } from './browser.mjs';

const filter = process.argv[2] || '';
const SPEEDUP = 8;
const server = await startServer(8128);
const { browser, page, logs } = await launch({ width: 1280, height: 720 });
let failed = 0, total = 0;
try {
  await page.goto(server.url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.RB && RB.game && RB.game.ready, { timeout: 120000 });
  const lines = await page.evaluate(async (filter) => {
    const { trainLines } = await import('./src/trainmode.js');
    return trainLines(RB.game.map).filter((l) => l.key.includes(filter)).map((l) => ({ i: l.i, name: `${l.title}: ${l.from} -> ${l.to}`, stops: l.stops, len: l.len }));
  }, filter);
  await page.evaluate((speedup) => {
    const tm = RB.game.trainMode;
    tm.timeScale = speedup;
    tm.autopilot = (r) => {
      const t = r.train, st = r.stops[r.next];
      let throttle = 0, brake = 0, handbrake = false;
      if (r.phase === 'running') {
        const d = st ? st.s - t.head : 1e9;
        const need = d > 0.3 ? (t.v * t.v) / (2 * (d - 0.3)) : 9;
        const aheadNeed = r.ahead ? (t.v * t.v - r.ahead.v * r.ahead.v) / (2 * Math.max(1, r.ahead.d - 15)) : 0;
        if (need > 0.8 || aheadNeed > 0.75) brake = Math.min(1, Math.max(need, aheadNeed) / 1.3 + 0.05);
        else if (t.v > r.limit - 0.4) brake = 0.25;
        else if (t.v < r.limit - 1.3) throttle = 1;
        if (d < 1.5 && t.v < 0.6) brake = 1;
        handbrake = need > 1.15;
      }
      return { throttle, brake, handbrake };
    };
  }, SPEEDUP);
  for (const l of lines) {
    total++;
    const t0 = Date.now();
    const prof = await page.evaluate((i) => {
      const g = RB.game;
      g.beginTrain(i);
      // Track profile: steepest grade and depth range along the drive.
      const pts = g.trainMode.run.train.pts, T = g.map.terrain;
      let grade = 0, lo = Infinity, hi = -Infinity;
      for (let k = 1; k < pts.length; k++) {
        const ds = Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
        if (ds > 4) grade = Math.max(grade, Math.abs(pts[k].y - pts[k - 1].y) / ds);
        const rel = pts[k].y - T.h(pts[k].x, pts[k].z);
        lo = Math.min(lo, rel); hi = Math.max(hi, rel);
      }
      return { grade, lo, hi };
    }, l.i);
    let s = null, shot = false;
    const budget = (l.len / 6 + l.stops * 12) / SPEEDUP * 1000 + 30000;
    while (Date.now() - t0 < budget) {
      await sleep(1000);
      s = await page.evaluate(() => RB.game.debugState());
      if (s.state === 'results' || !s.train) break;
      if (!shot && s.train.rel < -5 && s.train.v > 8) {
        shot = true;
        await page.screenshot({ path: path.join(shotsDir, `train_${l.i}.png`) });
      }
    }
    const r = await page.evaluate(() => {
      const run = RB.game.trainMode.run;
      return run && { phase: run.phase, time: run.time, results: run.results, overspeed: run.overspeed, trips: run.trips, stops: run.stops.length };
    });
    const made = r ? r.results.filter((x) => !x.missed) : [];
    const worst = made.reduce((m, x) => Math.max(m, Math.abs(x.d)), 0);
    const missed = r ? r.results.filter((x) => x.missed).map((x) => x.name) : ['?'];
    const ok = r && r.phase === 'done' && made.length === r.stops - 1 && worst <= 4 && r.trips === 0 && r.overspeed < 5 && prof.grade < 0.16;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${l.name}  -- ${r ? `${r.phase}, ${made.length}/${r.stops - 1} stops (worst ${worst.toFixed(1)} m${missed.length ? ', missed ' + missed.join(', ') : ''}), ${Math.round(r.time)} s, ${r.overspeed.toFixed(1)} s over the limit, ${r.trips} trips` : 'no run'}; grade max ${(prof.grade * 100).toFixed(1)}%, ${prof.lo.toFixed(1)}..${prof.hi.toFixed(1)} m vs the ground; ${((Date.now() - t0) / 1000).toFixed(0)} s real`);
    await page.evaluate(() => RB.game.toMenu());
  }
} catch (err) {
  failed++;
  console.log('FAIL  exception', err.stack);
} finally {
  const errors = logs.filter((x) => /\[(error|pageerror)\]/.test(x));
  if (errors.length) { failed++; console.log('FAIL  console errors', errors.slice(0, 5).join(' | ')); }
  console.log(`\n${total - Math.min(failed, total)}/${total} lines passed`);
  await browser.close();
  server.proc.kill();
  process.exit(failed ? 1 : 0);
}
