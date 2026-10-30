// Hand-dressed landmarks. OSM tells us which buildings these are (by name,
// building parts, or lying inside Fenway Park's outline); here they get
// procedural textures (canvas) and the props OSM doesn't model: the State
// House's gold dome, Fenway's seating bowl, Green Monster and light towers,
// the Custom House clocks, Bunker Hill's obelisk, USS Constitution's masts...

import * as THREE from 'three';
import earcut from '../vendor/earcut.js';
import { LANDMARK, AREA } from './mapdata.js';
import { globalUniforms } from './materials.js';
import { roofPlan } from './geom.js';

const L = LANDMARK;

// ------------------------------------------------------------- textures
function canvasTex(w, h, draw, { repeat = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function noise(ctx, w, h, amt, seed = 1) {
  const img = ctx.getImageData(0, 0, w, h);
  let s = seed * 9301 + 49297;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 9301 + 49297) % 233280;
    const n = (s / 233280 - 0.5) * amt;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

function bricks(ctx, x0, y0, w, h, base = [150, 64, 48], bw = 24, bh = 9) {
  for (let y = y0, row = 0; y < y0 + h; y += bh, row++) {
    for (let x = x0 - (row % 2) * (bw / 2); x < x0 + w; x += bw) {
      const v = Math.random() * 26 - 13;
      ctx.fillStyle = `rgb(${base[0] + v},${base[1] + v * 0.6},${base[2] + v * 0.5})`;
      ctx.fillRect(x + 1, y + 1, bw - 2, bh - 2);
    }
  }
}

function archWindow(ctx, x, y, w, h, frame = '#efe9dc', glass = '#26313a') {
  ctx.fillStyle = frame;
  ctx.beginPath();
  ctx.moveTo(x - 4, y + h + 4); ctx.lineTo(x - 4, y + w / 2); ctx.arc(x + w / 2, y + w / 2, w / 2 + 4, Math.PI, 0); ctx.lineTo(x + w + 4, y + h + 4); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = glass;
  ctx.beginPath();
  ctx.moveTo(x, y + h); ctx.lineTo(x, y + w / 2); ctx.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0); ctx.lineTo(x + w, y + h); ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = frame; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h); ctx.moveTo(x, y + h * 0.55); ctx.lineTo(x + w, y + h * 0.55); ctx.stroke();
}

const TEX = {};
function textures() {
  if (TEX.ready) return TEX;
  TEX.ready = true;
  // Red-brick facade bay: 4 m x 3.6 m (one floor) with an arched window.
  TEX.brick = canvasTex(256, 232, (c, w, h) => {
    c.fillStyle = '#7d3a2c'; c.fillRect(0, 0, w, h);
    bricks(c, 0, 0, w, h);
    archWindow(c, 78, 52, 100, 150);
    c.fillStyle = '#e8e0cf'; c.fillRect(0, h - 10, w, 10);
    noise(c, w, h, 14, 3);
  });
  // Fenway's brick facade: big arched gates at street level, windows above. 7 m x 13 m.
  TEX.fenway = canvasTex(256, 476, (c, w, h) => {
    c.fillStyle = '#7d3a2c'; c.fillRect(0, 0, w, h);
    bricks(c, 0, 0, w, h, [148, 58, 42], 22, 8);
    c.fillStyle = '#2e2a26';
    c.beginPath(); c.moveTo(48, h); c.lineTo(48, h - 150); c.arc(128, h - 150, 80, Math.PI, 0); c.lineTo(208, h); c.closePath(); c.fill();
    c.fillStyle = '#1f4f33'; // green gate grille
    for (let x = 56; x < 202; x += 12) c.fillRect(x, h - 220, 4, 220);
    c.fillRect(48, h - 120, 160, 6);
    c.fillStyle = '#e5ddcb'; c.fillRect(0, h - 268, w, 12);
    for (let k = 0; k < 2; k++) archWindow(c, 44 + k * 100, 60, 68, 120, '#e5ddcb', '#1d2a33');
    c.fillStyle = '#e5ddcb'; c.fillRect(0, 0, w, 16);
    noise(c, w, h, 12, 5);
  });
  // Green stadium seats: rows every ~0.9 m, aisle every 8 m.
  TEX.seats = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#7c7f7c'; c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 16) {
      c.fillStyle = '#1b5b35';
      for (let x = 0; x < w; x += 9) c.fillRect(x + 1, y + 3, 7, 9);
      c.fillStyle = '#5f625f'; c.fillRect(0, y + 13, w, 3);
    }
    c.fillStyle = '#8d908c'; c.fillRect(120, 0, 16, h);
    noise(c, w, h, 10, 7);
  });
  // The Green Monster with the hand-operated scoreboard.
  TEX.monster = canvasTex(1024, 256, (c, w, h) => {
    c.fillStyle = '#1d4a2e'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 2;
    for (let x = 0; x < w; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    const sx = 360, sy = 40;
    c.fillStyle = '#163a24'; c.fillRect(sx - 12, sy - 14, 560, 170);
    c.fillStyle = '#f4f1e6'; c.font = '700 22px Helvetica, Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    const cols = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'R', 'H', 'E'];
    cols.forEach((t, i) => c.fillText(t, sx + 120 + i * 34, sy + 6));
    c.textAlign = 'left'; c.font = '700 20px Helvetica, Arial, sans-serif';
    c.fillText('VISITORS', sx, sy + 46); c.fillText('BOSTON', sx, sy + 96);
    const score = [[0, 0, 1, 0, 0, 2, 0, 0, 0, 3, 8, 1], [1, 0, 0, 3, 0, 0, 1, 0, '', 5, 11, 0]];
    c.textAlign = 'center';
    score.forEach((row, r) => row.forEach((v, i) => {
      c.fillStyle = '#0d0d0d'; c.fillRect(sx + 108 + i * 34, sy + 30 + r * 50, 26, 32);
      c.fillStyle = '#f4f1e6'; c.fillText(String(v), sx + 121 + i * 34, sy + 47 + r * 50);
    }));
    c.fillStyle = '#f4f1e6'; c.font = '700 16px Helvetica, Arial, sans-serif'; c.textAlign = 'left';
    c.fillText('BALL  STRIKE  OUT', sx + 120, sy + 140);
    c.fillStyle = '#e8c020'; c.fillRect(0, 0, w, 6);
    c.fillStyle = '#f4f1e6'; c.font = '800 34px Helvetica, Arial, sans-serif'; c.textAlign = 'left'; c.fillText('310', 40, 220);
    noise(c, w, h, 8, 9);
  }, { repeat: false });
  // Light granite with tall arched windows (BPL, Quincy Market, Custom House base). 6 m x 8 m.
  TEX.granite = canvasTex(256, 342, (c, w, h) => {
    c.fillStyle = '#cfc9bb'; c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(80,70,60,0.25)'; c.lineWidth = 2;
    for (let y = 0; y < h; y += 26) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    for (let y = 0, r = 0; y < h; y += 26, r++) for (let x = (r % 2) * 40; x < w; x += 80) { c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + 26); c.stroke(); }
    archWindow(c, 70, 70, 116, 230, '#e3ddcf', '#2a3238');
    noise(c, w, h, 10, 11);
  });
  // Brownstone / sandstone (Trinity Church). 5 m x 6 m.
  TEX.sandstone = canvasTex(256, 308, (c, w, h) => {
    c.fillStyle = '#9a6a45'; c.fillRect(0, 0, w, h);
    for (let y = 0, r = 0; y < h; y += 22, r++) for (let x = (r % 2) * 30 - 30; x < w; x += 60) {
      const v = Math.random() * 30 - 15;
      c.fillStyle = `rgb(${150 + v},${100 + v * 0.7},${66 + v * 0.5})`;
      c.fillRect(x + 2, y + 2, 56, 18);
    }
    archWindow(c, 88, 90, 80, 170, '#6e4a33', '#1f2328');
    noise(c, w, h, 12, 13);
  });
  // Vertical-strip office facade (Prudential): 3 m x 4 m.
  TEX.pru = canvasTex(128, 170, (c, w, h) => {
    c.fillStyle = '#d6d2c4'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#28323c'; c.fillRect(22, 0, 84, h);
    c.fillStyle = '#d6d2c4'; for (let y = 0; y < h; y += 42) c.fillRect(22, y, 84, 7);
    noise(c, w, h, 8, 17);
  });
  // Mirror-glass curtain wall mullions (200 Clarendon).
  TEX.mirror = canvasTex(128, 128, (c, w, h) => {
    c.fillStyle = '#9bb8d2'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#5d7590';
    c.fillRect(0, 0, w, 3); c.fillRect(0, 0, 3, h); c.fillRect(0, 64, w, 2); c.fillRect(64, 0, 2, h);
  });
  // USS Constitution hull: black with the white gun stripe and gun ports.
  TEX.hull = canvasTex(512, 128, (c, w, h) => {
    c.fillStyle = '#121212'; c.fillRect(0, 0, w, h);
    c.fillStyle = '#efefe8'; c.fillRect(0, 44, w, 26);
    c.fillStyle = '#121212'; for (let x = 10; x < w; x += 32) c.fillRect(x, 48, 14, 18);
    c.fillStyle = '#7a4a2a'; c.fillRect(0, 112, w, 16);
    c.fillStyle = '#c9a24a'; c.fillRect(0, 8, w, 4);
  });
  return TEX;
}

// ------------------------------------------------------------ geometry
class Mesh {
  constructor() { this.p = []; this.n = []; this.uv = []; }
  tri(a, b, c, ua, ub, uc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    this.p.push(...a, ...b, ...c); this.n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz); this.uv.push(...ua, ...ub, ...uc);
  }
  quad(a, b, c, d, ua, ub, uc, ud) { this.tri(a, b, c, ua, ub, uc); this.tri(a, c, d, ua, uc, ud); }
  geometry() {
    if (!this.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

// Walls + roof with UVs in meters/tile; topAt(x, z) gives per-vertex roof height.
function extrude(m, rings, bot, topAt, tileW, tileH, roof = true) {
  walls(m, rings, bot, topAt, tileW, tileH);
  if (roof) roofTop(m, rings, topAt, tileW);
}

function walls(m, rings, bot, topAt, tileW, tileH) {
  for (const r of rings) {
    const n = r.length / 2;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.01) continue;
      const ta = topAt(ax, az), tb = topAt(bx, bz);
      const u0 = s / tileW, u1 = (s + len) / tileW;
      m.quad([ax, bot, az], [bx, bot, bz], [bx, tb, bz], [ax, ta, az], [u0, 0], [u1, 0], [u1, (tb - bot) / tileH], [u0, (ta - bot) / tileH]);
      s += len;
    }
  }
}

function roofTop(m, rings, topAt, tileW) {
  const flat = [], holes = [];
  rings.forEach((r, k) => { if (k) holes.push(flat.length / 2); for (const v of r) flat.push(v); });
  const tri = earcut(flat, holes.length ? holes : null, 2);
  for (let i = 0; i < tri.length; i += 3) {
    const P = (k) => [flat[2 * k], topAt(flat[2 * k], flat[2 * k + 1]), flat[2 * k + 1]];
    const U = (k) => [flat[2 * k] / tileW, flat[2 * k + 1] / tileW];
    let a = tri[i], b = tri[i + 1], c = tri[i + 2];
    const A = P(a), B = P(b), Cc = P(c);
    // Face up.
    if ((B[2] - A[2]) * (Cc[0] - A[0]) - (B[0] - A[0]) * (Cc[2] - A[2]) < 0) [b, c] = [c, b];
    m.tri(P(a), P(b), P(c), U(a), U(b), U(c));
  }
}

function centroid(r) {
  let x = 0, z = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) { x += r[2 * i]; z += r[2 * i + 1]; }
  return [x / n, z / n];
}
function radiusOf(r, cx, cz) {
  let m = 0;
  for (let i = 0; i < r.length; i += 2) m = Math.max(m, Math.hypot(r[i] - cx, r[i + 1] - cz));
  return m;
}

// ------------------------------------------------------------ skins
const SKIN = {
  brick: { tex: 'brick', w: 4, h: 3.6, roof: 0x5d5752 },
  fenway: { tex: 'fenway', w: 7, h: 13, roof: 0x3f4a44 },
  seats: { tex: 'seats', w: 8, h: 8, roof: null },
  granite: { tex: 'granite', w: 6, h: 8, roof: 0x8e8a82 },
  sandstone: { tex: 'sandstone', w: 5, h: 6, roof: 0x9a4a2c },
  pru: { tex: 'pru', w: 3, h: 4, roof: 0x8f8c84 },
  mirror: { tex: 'mirror', w: 3, h: 3, roof: 0x6f8aa3, metal: 0.92, rough: 0.05 },
  hull: { tex: 'hull', w: 60, h: 7, roof: 0x8a6a48 },
};

function skinFor(bd) {
  switch (bd.landmark) {
    case L.FENWAY: return bd.stands ? 'seats' : 'fenway';
    case L.STATE_HOUSE: case L.FANEUIL: case L.OLD_NORTH: case L.SYMPHONY: case L.OLD_STATE_HOUSE: return 'brick';
    case L.HANCOCK: return 'mirror';
    case L.PRUDENTIAL: return 'pru';
    case L.CUSTOM_HOUSE: case L.QUINCY: case L.BPL: case L.MOTHER_CHURCH: return 'granite';
    case L.TRINITY: return 'sandstone';
    default: return null;
  }
}

// =====================================================================
export function buildLandmarks(map, add) {
  const T = textures();
  const meshes = {};
  const get = (k) => (meshes[k] ||= new Mesh());
  const props = new THREE.Group();
  props.name = 'landmark-props';
  const handled = new Set();
  const byId = new Map();
  map.buildings.forEach((bd, i) => {
    if (!bd.landmark || bd.hidden) return;
    if (!byId.has(bd.landmark)) byId.set(bd.landmark, []);
    byId.get(bd.landmark).push(i);
  });
  const fenwayField = findField(map);

  const wallsOnly = new Set();
  // Props are built around y = 0; hang each landmark's in a group at its ground.
  const at = (y) => { const g = new THREE.Group(); g.position.y = y; props.add(g); return g; };
  const parts = (id) => (byId.get(id) || []).map((i) => [i, map.buildings[i]]);
  const tallest = (id) => parts(id).reduce((best, [, b]) => (!best || b.h > best.h ? b : best), null);
  // ---- group-level replacements
  const bunker = parts(L.BUNKER_HILL);
  if (bunker.length) { buildObelisk(bunker.map(([, b]) => b), at(Math.min(...bunker.map(([, b]) => b.base)))); for (const [i] of bunker) handled.add(i); }
  for (const [i, b] of parts(L.CONSTITUTION)) { buildShip(b, at(b.base), T); handled.add(i); }
  for (const [i, b] of parts(L.GREAT_DOME)) { buildDome(b, at(b.base), 0xd3ccbd, b.minH, b.h); handled.add(i); }
  for (const [i, b] of parts(L.GREEN_MONSTER)) { buildMonster(b, fenwayField, at(b.base), T); handled.add(i); }
  // State House: OSM stacks drum/dome/lantern parts; swap them for a gilded dome.
  const shParts = parts(L.STATE_HOUSE);
  if (shParts.length) {
    const lantern = tallest(L.STATE_HOUSE);
    const [lx, lz] = centroid(lantern.rings[0]);
    const domeParts = shParts.filter(([, b]) => { const [x, z] = centroid(b.rings[0]); return Math.hypot(x - lx, z - lz) < 14 && b.h > 21; });
    // World heights: the parts step down Beacon Hill.
    const base = Math.max(...shParts.filter(([i]) => !domeParts.some(([j]) => j === i)).map(([, b]) => b.base + b.h));
    let drumR = 9;
    for (const [, b] of domeParts) {
      const r = b.rings[0];
      let a = Infinity, c = -Infinity, d = Infinity, e = -Infinity;
      for (let k = 0; k < r.length; k += 2) { a = Math.min(a, r[k]); c = Math.max(c, r[k]); d = Math.min(d, r[k + 1]); e = Math.max(e, r[k + 1]); }
      if (b.h < lantern.h) drumR = Math.max(drumR === 9 ? 0 : drumR, Math.min(c - a, e - d) / 2);
    }
    if (domeParts.length >= 2) {
      for (const [i] of domeParts) handled.add(i);
      buildGoldDome(props, lx, lz, base, Math.max(6, Math.min(12, drumR)), lantern.base + lantern.h);
    } else {
      const { origin, metersPerDegree: m } = map.meta;
      buildGoldDome(props, (-71.06374 - origin.lon) * m.lon, -(42.35817 - origin.lat) * m.lat, lantern.base + lantern.h, 8, lantern.base + lantern.h + 20);
    }
  }
  // ---- textured walls (and flat roofs) for everything else
  for (const [id, list] of byId) {
    for (const i of list) {
      if (handled.has(i)) continue;
      const bd = map.buildings[i];
      const skin = skinFor(bd);
      if (!skin) continue;
      const plan = roofPlan(bd);
      let topAt = () => plan.wallTop;
      const g0 = bd.base;
      if (id === L.FENWAY && skin === 'seats' && fenwayField) {
        // Slope stands down toward the field.
        const [fx, fz] = fenwayField.center;
        const r = bd.rings[0];
        let dMin = Infinity, dMax = 0;
        for (let k = 0; k < r.length; k += 2) { const d = Math.hypot(r[k] - fx, r[k + 1] - fz); dMin = Math.min(dMin, d); dMax = Math.max(dMax, d); }
        const low = Math.min(3, bd.h * 0.3);
        topAt = (x, z) => { const t = Math.max(0, Math.min(1, (Math.hypot(x - fx, z - fz) - dMin) / Math.max(1, dMax - dMin))); return low + (bd.h - low) * Math.pow(t, 0.9); };
      }
      if (skin === 'seats') {
        // Brick outside (one facade per wall height), seats on the sloped top.
        walls(get('fenway'), bd.rings, g0 + bd.minH, (x, z) => g0 + topAt(x, z), SKIN.fenway.w, Math.max(8, bd.h - bd.minH));
        roofTop(get('seats'), bd.rings, (x, z) => g0 + topAt(x, z), SKIN.seats.w);
        handled.add(i);
        continue;
      }
      const S = SKIN[skin];
      walls(get(skin), bd.rings, g0 + bd.minH, (x, z) => g0 + topAt(x, z), S.w, skin === 'fenway' ? Math.max(8, plan.wallTop - bd.minH) : S.h);
      if (plan.kind === 'flat') { roofTop(get('roof:' + skin), bd.rings, (x, z) => g0 + topAt(x, z), 20); handled.add(i); }
      else wallsOnly.add(i);
    }
  }
  // ---- per-landmark props
  const ch = tallest(L.CUSTOM_HOUSE);
  if (ch) buildClockTower(at(ch.base), ch, T);
  const pru = tallest(L.PRUDENTIAL);
  if (pru) buildMast(at(pru.base), pru, 52);
  const fan = tallest(L.FANEUIL);
  if (fan) buildGrasshopper(at(fan.base), fan);
  if (fenwayField) buildFenwayExtras(map, fenwayField, at(map.terrain.h(...fenwayField.center)), byId);

  // Materials per skin.
  for (const [k, m] of Object.entries(meshes)) {
    const g = m.geometry();
    if (!g) continue;
    let mat;
    if (k.startsWith('roof:')) {
      const S = SKIN[k.slice(5)];
      mat = new THREE.MeshStandardMaterial({ color: S.roof, roughness: 0.8, metalness: S.metal ? 0.6 : 0 });
    } else {
      const S = SKIN[k];
      mat = new THREE.MeshStandardMaterial({ map: T[S.tex], roughness: S.rough ?? 0.85, metalness: S.metal ?? 0, envMapIntensity: S.metal ? 1.6 : 1 });
    }
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    add(mesh);
  }
  add(props);
  return { handled, wallsOnly, props, field: fenwayField };
}

// ---------------------------------------------------------------- Fenway
function findField(map) {
  const fen = map.landmarks.find((l) => l.name === 'Fenway Park');
  if (!fen) return null;
  let best = null;
  for (const a of map.areas) {
    if (a.type !== AREA.PITCH) continue;
    const [cx, cz] = centroid(a.rings[0]);
    if (Math.hypot(cx - fen.x, cz - fen.z) > 150) continue;
    let ar = 0;
    const r = a.rings[0];
    for (let i = 0, n = r.length / 2; i < n; i++) { const j = (i + 1) % n; ar += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1]; }
    ar = Math.abs(ar / 2);
    if (!best || ar > best.area) best = { rings: a.rings, area: ar, center: [cx, cz] };
  }
  if (!best) return null;
  // Home plate: the smallest dirt patch near the infield centre is the mound;
  // home is ~18.4 m from it, away from the field centroid.
  let mound = null;
  for (const a of map.areas) {
    if (a.type !== AREA.DIRT) continue;
    const [cx, cz] = centroid(a.rings[0]);
    if (Math.hypot(cx - best.center[0], cz - best.center[1]) > 80) continue;
    const rr = radiusOf(a.rings[0], cx, cz);
    if (rr < 6 && (!mound || rr < mound.r)) mound = { x: cx, z: cz, r: rr };
  }
  if (mound) {
    const dx = mound.x - best.center[0], dz = mound.z - best.center[1], l = Math.hypot(dx, dz) || 1;
    best.home = [mound.x + (dx / l) * 18.4, mound.z + (dz / l) * 18.4];
    best.mound = [mound.x, mound.z];
  }
  return best;
}

function buildMonster(bd, field, props, T) {
  const r = bd.rings[0];
  // Longest edge facing the field gets the scoreboard.
  const n = r.length / 2;
  const [fx, fz] = field ? field.center : centroid(r);
  const mGreen = new THREE.MeshStandardMaterial({ color: 0x1d4a2e, roughness: 0.75 });
  const mBoard = new THREE.MeshStandardMaterial({ map: T.monster, roughness: 0.7 });
  const g = new Mesh(), board = new Mesh();
  let bestLen = 0, bi = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const nx = -(bz - az) / len, nz = (bx - ax) / len;
    const facing = (fx - mx) * nx + (fz - mz) * nz > 0;
    if (facing && len > bestLen) { bestLen = len; bi = i; }
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1];
    const m = i === bi ? board : g;
    m.quad([ax, 0, az], [bx, 0, bz], [bx, bd.h, bz], [ax, bd.h, az], [0, 0], [1, 0], [1, 1], [0, 1]);
  }
  roofTop(g, bd.rings, () => bd.h, 10);
  for (const [m, mat] of [[g, mGreen], [board, mBoard]]) {
    const geo = m.geometry();
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    props.add(mesh);
  }
}

function buildFenwayExtras(map, field, props, byId) {
  // Light towers around the bowl.
  const stands = (byId.get(L.FENWAY) || []).map((i) => map.buildings[i]).filter((b) => b.stands);
  const [cx, cz] = field.center;
  // Towers stand on the upper rim of the seating bowl.
  let R = 0, n = 0;
  for (const p of stands) for (let k = 0; k < p.rings[0].length; k += 2) { R += Math.hypot(p.rings[0][k] - cx, p.rings[0][k + 1] - cz); n++; }
  R = n ? Math.min(95, Math.max(60, (R / n) * 1.05)) : 75;
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8b8f92, roughness: 0.5, metalness: 0.6 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xf4f2e8, emissive: 0xfff4d6, emissiveIntensity: 0.2, roughness: 0.3 });
  lampMat.userData.fenwayLamp = true;
  const home = field.home || [cx, cz];
  const away = Math.atan2(cx - home[0], -(cz - home[1]));
  for (let k = 0; k < 6; k++) {
    // Spread around the stands (skip the outfield behind the Monster).
    const a = away + Math.PI + (k - 2.5) * 0.55;
    const x = cx + Math.sin(a) * R, z = cz - Math.cos(a) * R;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 40, 8), poleMat);
    pole.position.set(x, 20, z);
    const bank = new THREE.Mesh(new THREE.BoxGeometry(9, 4.5, 0.8), lampMat);
    bank.position.set(x, 41, z);
    bank.lookAt(cx, 20, cz);
    props.add(pole, bank);
  }
  // Foul poles (the Pesky Pole is in right).
  if (field.home) {
    const yel = new THREE.MeshStandardMaterial({ color: 0xf2c418, roughness: 0.5 });
    const [hx, hz] = field.home;
    const base = Math.atan2(cx - hx, -(cz - hz));
    for (const s of [-1, 1]) {
      const a = base + s * Math.PI / 4;
      const d = s < 0 ? 94.5 : 92;
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 14, 8), yel);
      p.position.set(hx + Math.sin(a) * d, 7, hz - Math.cos(a) * d);
      props.add(p);
    }
    // White foul lines and bases.
    const white = new THREE.MeshBasicMaterial({ color: 0xf2f2ec });
    for (const s of [-1, 1]) {
      const a = base + s * Math.PI / 4;
      const len = s < 0 ? 94 : 91;
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.12, len), white);
      line.rotation.set(-Math.PI / 2, 0, -a);
      line.position.set(hx + (Math.sin(a) * len) / 2, 0.13, hz - (Math.cos(a) * len) / 2);
      line.renderOrder = -27;
      props.add(line);
    }
    for (const [ang, dist] of [[-Math.PI / 4, 27.4], [0, 38.8], [Math.PI / 4, 27.4], [0, 0]]) {
      const a = base + ang;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.4), white);
      b.position.set(hx + Math.sin(a) * dist, 0.15, hz - Math.cos(a) * dist);
      b.rotation.y = -base;
      props.add(b);
    }
  }
  // "FENWAY PARK" marquee over the Jersey Street gate.
  const sign = signPlate('FENWAY PARK', '#1d4a2e', '#f4f1e6', 1024, 200);
  sign.scale.set(14, 2.7, 1);
  const jersey = map.roads.find((r) => /^Jersey Street$/.test(r.name));
  let sx = cx + 70, sz = cz + 40, face = 0;
  if (jersey) {
    // Point on Jersey Street nearest the park, then step 10 m toward the park.
    let bd2 = Infinity;
    for (const n of jersey.nodes) {
      const x = map.nodes[2 * n], z = map.nodes[2 * n + 1];
      const d = Math.hypot(x - cx, z - cz);
      if (d < bd2) { bd2 = d; sx = x; sz = z; }
    }
    const l = Math.hypot(cx - sx, cz - sz) || 1;
    sx += ((cx - sx) / l) * 9; sz += ((cz - sz) / l) * 9;
    face = Math.atan2(sx - cx, -(sz - cz));
  }
  sign.position.set(sx, 11, sz);
  sign.rotation.y = -face + Math.PI;
  props.add(sign);
}

function signPlate(text, bg, fg, w, h) {
  const tex = canvasTex(w, h, (c) => {
    c.fillStyle = bg; c.fillRect(0, 0, w, h);
    c.strokeStyle = fg; c.lineWidth = 10; c.strokeRect(14, 14, w - 28, h - 28);
    c.fillStyle = fg; c.font = `800 ${Math.round(h * 0.55)}px Georgia, "Times New Roman", serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, w / 2, h / 2 + 6);
  }, { repeat: false });
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.25, side: THREE.DoubleSide, roughness: 0.5 });
  mat.userData.neon = true;
  return new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
}

// --------------------------------------------------------------- props
function buildGoldDome(props, x, z, roofY, drumR, topY) {
  const gold = new THREE.MeshStandardMaterial({ color: 0xd4a537, metalness: 1, roughness: 0.22, envMapIntensity: 1.8 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf0ece2, roughness: 0.7 });
  const drumH = Math.max(3, (topY - roofY) * 0.22);
  const domeR = drumR * 0.88;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(drumR, drumR * 1.03, drumH, 36), white);
  drum.position.set(x, roofY + drumH / 2, z);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(drumR * 1.04, drumR * 1.04, 0.6, 36), white);
  ring.position.set(x, roofY + drumH, z);
  const domeH = Math.min(domeR * 1.05, topY - roofY - drumH - 3.5);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(domeR, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), gold);
  dome.scale.y = Math.max(0.5, domeH / domeR);
  dome.position.set(x, roofY + drumH, z);
  const lanternY = roofY + drumH + domeH;
  const lanternH = Math.max(2, topY - lanternY - 1.6);
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, lanternH, 12), white);
  lantern.position.set(x, lanternY + lanternH / 2, z);
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.2, 12), gold);
  cone.position.set(x, lanternY + lanternH + 1.1, z);
  for (const m of [drum, ring, dome, lantern, cone]) { m.castShadow = true; m.receiveShadow = true; props.add(m); }
}

function buildClockTower(props, bd, T) {
  buildClocks(props, bd);
  // OSM stops the shaft at ~100 m; add the stepped top and pyramid (151 m).
  const r = bd.rings[0];
  const [cx, cz] = centroid(r);
  let a = Infinity, c = -Infinity, d = Infinity, e = -Infinity;
  for (let k = 0; k < r.length; k += 2) { a = Math.min(a, r[k]); c = Math.max(c, r[k]); d = Math.min(d, r[k + 1]); e = Math.max(e, r[k + 1]); }
  const w = Math.min(c - a, e - d);
  if (bd.h > 140) return;
  const stone = new THREE.MeshStandardMaterial({ map: T.granite, roughness: 0.85 });
  T.granite.repeat.set(1, 1);
  const stage = new THREE.Mesh(new THREE.BoxGeometry(w * 0.82, 12, w * 0.82), stone);
  stage.position.set(cx, bd.h + 6, cz);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x6f8f86, roughness: 0.6, metalness: 0.3 });
  const pyr = new THREE.Mesh(new THREE.ConeGeometry(w * 0.6, 151 - bd.h - 18, 4), roofMat);
  pyr.rotation.y = Math.PI / 4;
  pyr.position.set(cx, bd.h + 12 + (151 - bd.h - 18) / 2, cz);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 6, 6), roofMat);
  mast.position.set(cx, 148, cz);
  for (const m of [stage, pyr, mast]) { m.castShadow = true; props.add(m); }
}

function buildClocks(props, bd) {
  const r = bd.rings[0];
  const [cx, cz] = centroid(r);
  const tex = canvasTex(256, 256, (c) => {
    c.fillStyle = '#c9a24a'; c.beginPath(); c.arc(128, 128, 126, 0, 7); c.fill();
    c.fillStyle = '#f3efe2'; c.beginPath(); c.arc(128, 128, 112, 0, 7); c.fill();
    c.fillStyle = '#1b1b1b';
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      c.save(); c.translate(128, 128); c.rotate(a); c.fillRect(-3, -104, 6, 18); c.restore();
    }
    c.lineCap = 'round'; c.strokeStyle = '#1b1b1b';
    c.lineWidth = 8; c.beginPath(); c.moveTo(128, 128); c.lineTo(128 + 55 * Math.sin(1.9), 128 - 55 * Math.cos(1.9)); c.stroke();
    c.lineWidth = 5; c.beginPath(); c.moveTo(128, 128); c.lineTo(128 + 88 * Math.sin(0.1), 128 - 88 * Math.cos(0.1)); c.stroke();
  }, { repeat: false });
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.15, roughness: 0.5 });
  mat.userData.neon = true;
  // One clock on each of the four longest faces, a few meters under the top.
  const n = r.length / 2;
  const faces = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1];
    faces.push({ len: Math.hypot(bx - ax, bz - az), mx: (ax + bx) / 2, mz: (az + bz) / 2, ax, az, bx, bz });
  }
  faces.sort((a, b) => b.len - a.len);
  const size = Math.min(6, faces[0].len * 0.55);
  for (const f of faces.slice(0, 4)) {
    const nx = -(f.bz - f.az) / f.len, nz = (f.bx - f.ax) / f.len;
    const out = (f.mx - cx) * nx + (f.mz - cz) * nz > 0 ? 1 : -1;
    const m = new THREE.Mesh(new THREE.CircleGeometry(size / 2, 32), mat);
    m.position.set(f.mx + nx * out * 0.15, bd.h - size * 0.9, f.mz + nz * out * 0.15);
    m.lookAt(f.mx + nx * out * 10, bd.h - size * 0.9, f.mz + nz * out * 10);
    props.add(m);
  }
}

function buildMast(props, bd, h) {
  const [cx, cz] = centroid(bd.rings[0]);
  const mat = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.7, roughness: 0.4 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 1.1, h, 8), mat);
  mast.position.set(cx, bd.h + h / 2, cz);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
  beacon.position.set(cx, bd.h + h + 0.6, cz);
  beacon.userData.blink = true;
  props.add(mast, beacon);
}

function buildGrasshopper(props, bd) {
  const [cx, cz] = centroid(bd.rings[0]);
  const gold = new THREE.MeshStandardMaterial({ color: 0xd4a537, metalness: 1, roughness: 0.25 });
  const y = bd.h;
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2, 4), gold);
  rod.position.set(cx, y + 1, cz);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.35, 0.35), gold);
  body.position.set(cx, y + 2.1, cz);
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.5), gold);
  leg.position.set(cx - 0.2, y + 1.9, cz);
  leg.rotation.z = 0.5;
  props.add(rod, body, leg);
}

function buildDomeOn(props, bd, color, radius) {
  const [cx, cz] = centroid(bd.rings[0]);
  const y = bd.h + (bd.roofH || 0) * 0.6;
  buildDome({ rings: [Float32Array.from(circle(cx, cz, radius))] }, props, color, y - 1, y + radius);
}

function circle(cx, cz, r, n = 24) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r); }
  return out;
}

function buildDome(bd, props, color, bot, top) {
  const r = bd.rings[0];
  const [cx, cz] = centroid(r);
  const rad = radiusOf(r, cx, cz) * 0.95;
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: color === 0x5f8f7a ? 0.4 : 0 });
  const h = Math.max(2, top - bot);
  const drumH = Math.max(0, h - rad);
  if (drumH > 0.5) {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, drumH, 32), mat);
    drum.position.set(cx, bot + drumH / 2, cz);
    props.add(drum);
  }
  const dome = new THREE.Mesh(new THREE.SphereGeometry(rad, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  dome.scale.y = Math.min(1, h / rad);
  dome.position.set(cx, bot + drumH, cz);
  dome.castShadow = true;
  props.add(dome);
}

function buildObelisk(list, props) {
  // Footprint of all parts together.
  let a = Infinity, c = -Infinity, d = Infinity, e = -Infinity, h = 0;
  for (const b of list) {
    h = Math.max(h, b.h);
    const r = b.rings[0];
    for (let k = 0; k < r.length; k += 2) { a = Math.min(a, r[k]); c = Math.max(c, r[k]); d = Math.min(d, r[k + 1]); e = Math.max(e, r[k + 1]); }
  }
  const cx = (a + c) / 2, cz = (d + e) / 2;
  const base = Math.min(10, Math.max(6, Math.min(c - a, e - d)));
  const top = base * 0.53, shaftH = h - 4;
  const r0 = list[0].rings[0];
  const ang = Math.atan2(r0[3] - r0[1], r0[2] - r0[0]);
  const g = new THREE.CylinderGeometry(top / Math.SQRT2, base / Math.SQRT2, shaftH, 4, 1);
  g.rotateY(Math.PI / 4);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc7c3b8, roughness: 0.85, flatShading: true });
  const shaft = new THREE.Mesh(g, mat);
  shaft.position.set(cx, shaftH / 2, cz);
  shaft.rotation.y = -ang;
  const capG = new THREE.ConeGeometry(top / Math.SQRT2, 4, 4);
  capG.rotateY(Math.PI / 4);
  const cap = new THREE.Mesh(capG, mat);
  cap.position.set(cx, shaftH + 2, cz);
  cap.rotation.y = -ang;
  shaft.castShadow = cap.castShadow = true;
  shaft.receiveShadow = true;
  props.add(shaft, cap);
}

function buildShip(bd, props, T) {
  const r = bd.rings[0];
  // Long axis from the footprint's principal direction.
  const [cx, cz] = centroid(r);
  let sxx = 0, sxz = 0, szz = 0;
  for (let i = 0; i < r.length; i += 2) { const dx = r[i] - cx, dz = r[i + 1] - cz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ax = Math.cos(ang), az = Math.sin(ang);
  let lo = Infinity, hi = -Infinity, wmax = 0;
  for (let i = 0; i < r.length; i += 2) {
    const s = (r[i] - cx) * ax + (r[i + 1] - cz) * az;
    lo = Math.min(lo, s); hi = Math.max(hi, s);
    wmax = Math.max(wmax, Math.abs(-(r[i] - cx) * az + (r[i + 1] - cz) * ax));
  }
  const hull = new Mesh();
  extrude(hull, bd.rings, -1.5, () => 5.5, 60, 7, false);
  const deck = new Mesh();
  roofTop(deck, bd.rings, () => 5.5, 10);
  const hullMesh = new THREE.Mesh(hull.geometry(), new THREE.MeshStandardMaterial({ map: T.hull, roughness: 0.6 }));
  const deckMesh = new THREE.Mesh(deck.geometry(), new THREE.MeshStandardMaterial({ color: 0xa47e56, roughness: 0.9 }));
  hullMesh.castShadow = deckMesh.castShadow = true;
  props.add(hullMesh, deckMesh);
  const wood = new THREE.MeshStandardMaterial({ color: 0x6a4a2e, roughness: 0.8 });
  const canvasMat = new THREE.MeshStandardMaterial({ color: 0xece5d2, roughness: 0.9, side: THREE.DoubleSide });
  const len = hi - lo;
  const masts = [[0.28, 46], [0.52, 52], [0.74, 41]];
  const rig = [];
  for (const [f, mh] of masts) {
    const s = lo + len * f;
    const x = cx + ax * s, z = cz + az * s;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.45, mh, 8), wood);
    mast.position.set(x, 5.5 + mh / 2, z);
    mast.castShadow = true;
    props.add(mast);
    for (const [hf, yl] of [[0.35, 0.42], [0.6, 0.32], [0.82, 0.22]]) {
      const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, len * yl, 6), wood);
      yard.rotation.z = Math.PI / 2;
      yard.rotation.y = -ang + Math.PI / 2;
      yard.position.set(x, 5.5 + mh * hf, z);
      props.add(yard);
      // Furled sail bundle under the yard.
      const sail = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, len * yl * 0.9, 8), canvasMat);
      sail.rotation.copy(yard.rotation);
      sail.position.set(x, 5.5 + mh * hf - 0.4, z);
      props.add(sail);
    }
    rig.push(x, 5.5 + mh, z, cx + ax * lo, 6, cz + az * lo, x, 5.5 + mh, z, cx + ax * hi, 6, cz + az * hi);
    for (const sd of [-1, 1]) rig.push(x, 5.5 + mh * 0.8, z, x - az * wmax * sd, 5.6, z + ax * wmax * sd);
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(rig, 3));
  props.add(new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0x2b2118 })));
  // Flag at the stern.
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.8), new THREE.MeshStandardMaterial({ color: 0xb3262e, side: THREE.DoubleSide }));
  flag.position.set(cx + ax * (lo - 1), 9, cz + az * (lo - 1));
  flag.rotation.y = -ang;
  props.add(flag);
}

// Night: stadium lights, signs and clocks glow; mast beacon blinks.
export function updateLandmarks(lm, t) {
  if (!lm) return;
  const night = globalUniforms.uNight.value;
  lm.props.traverse((o) => {
    const m = o.material;
    if (!m) return;
    if (m.userData.fenwayLamp) m.emissiveIntensity = 0.2 + night * 3.5;
    if (m.userData.neon) m.emissiveIntensity = 0.2 + night * 0.9;
    if (o.userData.blink) o.visible = Math.sin(t * 3) > -0.2;
  });
}
