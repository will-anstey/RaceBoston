// Builds Retro Race Boston from the main game's map (../data/boston.json):
// pre-rendered 16-colour GIF map tiles, 16 car sprites, and a run-length
// coded collision grid + checkpoints as a plain JavaScript file (no JSON,
// so Netscape Navigator 4 can load it with a <script> tag).
//
//   node Retro/tools/build.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const map = JSON.parse(fs.readFileSync(path.join(root, '..', 'data', 'boston.json'), 'utf8'));

// Downtown Boston: Fenway to the waterfront, Charlestown's edge to the South End.
const MPP = 2;                 // metres per map pixel
const TILE = 256;
const TX = 9, TY = 6;          // tiles
const W = TX * TILE, H = TY * TILE;
const X0 = -2900, Z0 = -1500;  // world metres at map pixel (0, 0)
const CELL = 2;                // map pixels per collision cell (4 m)

// 16-colour palette.
const PAL = [
  [255, 0, 255],   // 0 transparent (sprites)
  [44, 84, 140],   // 1 water
  [196, 186, 160], // 2 land
  [104, 150, 80],  // 3 park
  [150, 132, 118], // 4 building
  [92, 92, 96],    // 5 road
  [222, 170, 70],  // 6 highway
  [160, 160, 156], // 7 plaza / parking
  [120, 104, 92],  // 8 building edge
  [200, 30, 40],   // 9 car red
  [30, 30, 40],    // 10 glass / tyres
  [250, 250, 250], // 11 white
  [140, 120, 96],  // 12 rail
  [80, 80, 84],    // 13 road edge
  [240, 210, 60],  // 14 yellow
  [0, 0, 0],       // 15 black
];

// ---------------------------------------------------------------- raster
const img = new Uint8Array(W * H).fill(1);
const px = (x) => (x - X0) / MPP, pz = (z) => (z - Z0) / MPP;

function fillRings(rings, color) {
  // Even-odd scanline fill over all rings.
  let y0 = Infinity, y1 = -Infinity;
  for (const r of rings) for (let i = 1; i < r.length; i += 2) { const y = pz(r[i]); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H - 1, Math.ceil(y1));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5, xs = [];
    for (const r of rings) {
      const n = r.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = px(r[2 * j]), ay = pz(r[2 * j + 1]), bx = px(r[2 * i]), by = pz(r[2 * i + 1]);
        if ((ay > yc) !== (by > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = a; x <= b; x++) img[y * W + x] = color;
    }
  }
}

function thickLine(ax, ay, bx, by, r, color, buf = img) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + r));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + r));
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / l2));
    const ex = x + 0.5 - ax - dx * t, ey = y + 0.5 - ay - dy * t;
    if (ex * ex + ey * ey <= r * r) buf[y * W + x] = color;
  }
}

for (const p of map.land) fillRings(p, 2);
for (const p of map.water) fillRings(p, 1);
const GREEN = new Set([1, 2, 3, 4, 5, 6, 7, 10, 11]), GREY = new Set([20, 21, 22, 24]);
for (const [type, p] of map.areas) {
  if (GREEN.has(type)) fillRings(p, 3);
  else if (GREY.has(type)) fillRings(p, 7);
}
const N = map.nodes;
for (const w of map.railWays || []) {
  if (w[1] & 8) continue; // tunnel
  const ns = w[3];
  for (let i = 1; i < ns.length; i++) thickLine(px(map.railNodes[2 * ns[i - 1]]), pz(map.railNodes[2 * ns[i - 1] + 1]), px(map.railNodes[2 * ns[i]]), pz(map.railNodes[2 * ns[i] + 1]), 1, 12);
}
for (const b of map.buildings) {
  if (b[5] & 8) continue;
  fillRings(b[6][0] ? [b[6][0]] : [], 4);
}
// Building outlines (one pixel darker edge) for a crisper look.
const edge = img.slice();
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
  const i = y * W + x;
  if (img[i] === 4 && (img[i - 1] !== 4 || img[i + W] !== 4)) edge[i] = 8;
}
img.set(edge);
// Roads: no tunnels; highways in yellow-orange, drawn last.
const drivable = [];
const roads = map.roads.filter((r) => !(r[1] & 16) && r[0] <= 7);
roads.sort((a, b) => b[0] - a[0]);
for (const r of roads) {
  const ns = r[7], hw = Math.max(2.2, r[3] / 10 / 2 / MPP);
  for (let i = 1; i < ns.length; i++) {
    const a = [px(N[2 * ns[i - 1]]), pz(N[2 * ns[i - 1] + 1])], b = [px(N[2 * ns[i]]), pz(N[2 * ns[i] + 1])];
    thickLine(a[0], a[1], b[0], b[1], hw + 0.8, 13);
    drivable.push([a, b, hw + 1]);
  }
}
for (const r of roads) {
  const ns = r[7], hw = Math.max(2.2, r[3] / 10 / 2 / MPP);
  for (let i = 1; i < ns.length; i++) {
    thickLine(px(N[2 * ns[i - 1]]), pz(N[2 * ns[i - 1] + 1]), px(N[2 * ns[i]]), pz(N[2 * ns[i] + 1]), hw, r[0] <= 1 ? 6 : 5);
  }
}

// ---------------------------------------------------------------- collision
// a = blocked (building, water), b = road, c = off road (slow).
const CW = W / CELL, CH = H / CELL;
const roadMask = new Uint8Array(W * H);
for (const [a, b, r] of drivable) thickLine(a[0], a[1], b[0], b[1], r, 1, roadMask);
const rows = [];
for (let cy = 0; cy < CH; cy++) {
  let s = '', run = 0, prev = '';
  for (let cx = 0; cx < CW; cx++) {
    const i = (cy * CELL + 1) * W + cx * CELL + 1, c = img[i];
    const t = roadMask[i] ? 'b' : c === 1 || c === 4 || c === 8 ? 'a' : 'c';
    if (t === prev) run++;
    else { if (prev) s += prev + run; prev = t; run = 1; }
  }
  rows.push(s + prev + run);
}

// ---------------------------------------------------------------- checkpoints
// A loop around downtown, each snapped to the nearest road pixel.
const LOOP = ['Boston Common', 'Massachusetts State House', 'TD Garden', 'Faneuil Hall', 'Old State House', 'South Station', 'Copley Square', 'Fenway Park'];
const snap = (x, y) => {
  let best = null, bd = Infinity;
  for (let r = 0; r < 60 && !best; r += 2) for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) {
    const X = Math.round(x + dx), Y = Math.round(y + dy);
    if (X < 0 || Y < 0 || X >= W || Y >= H || !roadMask[Y * W + X]) continue;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = [X, Y]; }
  }
  return best;
};
const checks = [];
for (const name of LOOP) {
  const l = map.landmarks.find((m) => m[0] === name);
  if (!l) continue;
  const p = snap(px(l[2]), pz(l[3]));
  if (p) checks.push([name, p[0], p[1]]);
}

// ---------------------------------------------------------------- GIF
function gif(w, h, pix, transparent) {
  const out = [];
  const b = (v) => out.push(v & 255), w16 = (v) => { b(v); b(v >> 8); };
  for (const c of 'GIF89a') b(c.charCodeAt(0));
  w16(w); w16(h); b(0xf3); b(0); b(0); // global colour table, 16 entries
  for (const c of PAL) { b(c[0]); b(c[1]); b(c[2]); }
  if (transparent) { b(0x21); b(0xf9); b(4); b(1); w16(0); b(0); b(0); }
  b(0x2c); w16(0); w16(0); w16(w); w16(h); b(0);
  // LZW, minimum code size 4.
  const MIN = 4, CLEAR = 1 << MIN, EOI = CLEAR + 1;
  b(MIN);
  const bytes = [];
  let acc = 0, nbits = 0, size = MIN + 1, next = EOI + 1, dict = new Map();
  const emit = (code) => { acc |= code << nbits; nbits += size; while (nbits >= 8) { bytes.push(acc & 255); acc >>= 8; nbits -= 8; } };
  emit(CLEAR);
  let cur = pix[0];
  for (let i = 1; i < pix.length; i++) {
    const k = cur * 256 + pix[i];
    if (dict.has(k)) { cur = dict.get(k); continue; }
    emit(cur);
    if (next < 4096) { dict.set(k, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(CLEAR); dict = new Map(); size = MIN + 1; next = EOI + 1; }
    cur = pix[i];
  }
  emit(cur); emit(EOI);
  if (nbits > 0) bytes.push(acc & 255);
  for (let i = 0; i < bytes.length; i += 255) { const n = Math.min(255, bytes.length - i); b(n); for (let k = 0; k < n; k++) b(bytes[i + k]); }
  b(0); b(0x3b);
  return Buffer.from(out);
}

const tilesDir = path.join(root, 'tiles');
fs.mkdirSync(tilesDir, { recursive: true });
let bytes = 0;
for (let ty = 0; ty < TY; ty++) for (let tx = 0; tx < TX; tx++) {
  const t = new Uint8Array(TILE * TILE);
  for (let y = 0; y < TILE; y++) t.set(img.subarray((ty * TILE + y) * W + tx * TILE, (ty * TILE + y) * W + tx * TILE + TILE), y * TILE);
  const g = gif(TILE, TILE, t, false);
  bytes += g.length;
  fs.writeFileSync(path.join(tilesDir, `t${tx}_${ty}.gif`), g);
}

// Car sprites: 16 headings (0 = up/north, clockwise), 16x16.
const S = 16;
for (let k = 0; k < 16; k++) {
  const a = (k / 16) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a), s = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // Rotate back into car space (u across, v along, v < 0 is the nose).
    const dx = x + 0.5 - S / 2, dy = y + 0.5 - S / 2;
    const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
    if (Math.abs(u) <= 3.2 && Math.abs(v) <= 6.5) s[y * S + x] = v > -3.5 && v < -1 && Math.abs(u) < 2.6 ? 10 : v > 3 && v < 4.6 && Math.abs(u) < 2.6 ? 10 : 9;
  }
  fs.writeFileSync(path.join(tilesDir, `car${k}.gif`), gif(S, S, s, true));
}
// Checkpoint flag 16x16.
{
  const s = new Uint8Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
    if (d < 7.5) s[y * S + x] = d < 5 ? 14 : 15;
  }
  fs.writeFileSync(path.join(tilesDir, 'check.gif'), gif(S, S, s, true));
}

// JavaScript 1.1 style for old browsers: no array literals, short lines
// (long rows are appended in pieces).
let js = `// Generated by tools/build.mjs from the main game's OpenStreetMap data.
var MAPW = ${W}, MAPH = ${H}, TILE = ${TILE}, TX = ${TX}, TY = ${TY}, CELL = ${CELL}, MPP = ${MPP};
var CHECKS = new Array();
${checks.map((c, i) => `CHECKS[${i}] = new Array("${c[0]}", ${c[1]}, ${c[2]});`).join('\n')}
var ROWS = new Array(${rows.length});
`;
rows.forEach((r, i) => {
  for (let k = 0; k < r.length; k += 160) js += `ROWS[${i}]${k ? '+' : ''}="${r.slice(k, k + 160)}";\n`;
});
fs.writeFileSync(path.join(root, 'data.js'), js);

// The same data as plain text for the Java applet (Navigator 3).
let txt = `MAP ${W} ${H} ${TILE} ${TX} ${TY} ${CELL} ${MPP}\n`;
for (const c of checks) txt += `CHECK ${c[1]} ${c[2]} ${c[0]}\n`;
txt += `ROWS ${rows.length}\n${rows.join('\n')}\n`;
fs.writeFileSync(path.join(root, 'retro.txt'), txt);

// Navigator 4 page: plain HTML 3.2 + positioned DIVs (layers), the map as a
// static table of tiles.
let table = '<table border="0" cellpadding="0" cellspacing="0">';
for (let ty = 0; ty < TY; ty++) {
  table += '<tr>';
  for (let tx = 0; tx < TX; tx++) table += `<td><img src="tiles/t${tx}_${ty}.gif" width="${TILE}" height="${TILE}" border="0"></td>`;
  table += '</tr>\n';
}
table += '</table>';
const html = `<html>
<head>
<title>Retro Race Boston</title>
<script language="JavaScript" src="data.js"></script>
<script language="JavaScript" src="game.js"></script>
<script language="JavaScript">
function rbBoot() {
  if (typeof rbStart == 'undefined' || typeof ROWS == 'undefined') {
    alert('Retro Race Boston could not load ' + (typeof ROWS == 'undefined' ? 'data.js' : 'game.js') + '. Check the server is running, then Reload.');
    return;
  }
  rbStart();
}
</script>
</head>
<body bgcolor="#101820" text="#ffffff" link="#f4c542" vlink="#f4c542" onload="rbBoot()" marginwidth="0" marginheight="0" leftmargin="0" topmargin="0">
<div id="view" style="position:absolute; left:8px; top:8px; width:448px; height:336px; clip:rect(0px 448px 336px 0px); overflow:hidden; background-color:#2c548c; layer-background-color:#2c548c">
<div id="map" style="position:absolute; left:0px; top:0px; width:${W}px; height:${H}px">${table}</div>
<div id="flag" style="position:absolute; left:-100px; top:-100px; width:16px; height:16px"><img src="tiles/check.gif" width="16" height="16"></div>
<div id="car" style="position:absolute; left:216px; top:152px; width:16px; height:16px"><img name="carimg" src="tiles/car0.gif" width="16" height="16"></div>
</div>
<div id="hud" style="position:absolute; left:8px; top:350px; width:640px; height:36px"><font face="Arial,Helvetica" size="2">Loading Boston...</font></div>
<div id="help" style="position:absolute; left:8px; top:388px; width:400px">
<font face="Arial,Helvetica" size="1" color="#b0b8c8"><b>RETRO RACE BOSTON</b> &nbsp; W accelerate, S brake, A D steer, R restart
(or I K J L). ${checks.length - 1} checkpoints, State House to Fenway Park. Map &copy; OpenStreetMap contributors.</font></div>
</body>
</html>
`;
fs.writeFileSync(path.join(root, 'nav4.html'), html);

// Java applet pages (Navigator 3 and later): pick the size for your screen.
const SIZES = [[640, 480, '1024x768 or bigger'], [448, 336, '800x600'], [320, 240, '640x480 (fastest)']];
for (const [w, h] of SIZES) {
  fs.writeFileSync(path.join(root, `play${w}.html`), `<html>
<head><title>Retro Race Boston</title></head>
<body bgcolor="#101820" text="#ffffff" link="#f4c542" vlink="#f4c542">
<center>
<applet code="RetroRace.class" width="${w}" height="${h}">
<font face="Arial,Helvetica">Retro Race Boston needs Java. In Navigator: Options, Network Preferences, Languages, tick Enable Java, then Reload.</font>
</applet>
<br><font face="Arial,Helvetica" size="2">Click the map, then: arrows or W A S D to drive, R to restart. &nbsp; <a href="index.html">Change size</a></font>
</center>
</body>
</html>
`);
}
fs.writeFileSync(path.join(root, 'index.html'), `<html>
<head><title>Retro Race Boston</title></head>
<body bgcolor="#101820" text="#ffffff" link="#f4c542" vlink="#f4c542">
<center>
<font face="Arial,Helvetica"><h1>RETRO RACE BOSTON</h1>
Race through downtown Boston: ${checks.length - 1} checkpoints from the State House to Fenway Park.<p>
Pick the size for your screen:<p>
${SIZES.map(([w, h, d]) => `<a href="play${w}.html"><b>${w} x ${h}</b></a> &nbsp; for a ${d} desktop<br>`).join('\n')}
<p><font size="2">Navigator 3 and later, with Java turned on. &nbsp; <a href="nav4.html">Navigator 4 version without Java</a>
<br>Map data &copy; OpenStreetMap contributors.</font></font>
</center>
</body>
</html>
`);
console.log(`map ${W}x${H} px (${(W * MPP / 1000).toFixed(1)} x ${(H * MPP / 1000).toFixed(1)} km), ${TX * TY} tiles ${(bytes / 1024).toFixed(0)} KB, data.js ${(js.length / 1024).toFixed(0)} KB, ${checks.length} checkpoints`);
