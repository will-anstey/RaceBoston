// Logan Airport: runways, taxiways, apron pavement, stand lead-in lines,
// hold-short bars, runway designations and airfield lighting.

import * as THREE from 'three';
import { GeoBuilder, ribbon, polyOffsets, meshOf, rgb } from './geom.js';
import * as MAT from './materials.js';
import { globalUniforms } from './materials.js';
import { AERO } from './mapdata.js';

// Active runway ends (NE flow): arrivals on 4R, departures on 4L.
export const ACTIVE = { arrive: ['4R'], depart: ['4L'] };
const APRON_RGB = rgb(0xa9a8a2);
const YELLOW_RGB = rgb(0xd9a21a);

// ---------------------------------------------------------------- lights
// Point sprites with a size in meters (clamped to a few pixels so distant
// lights stay visible), additive glow, fog, and animation modes:
// aAnim.x = 0 steady, 1 flash (aAnim.y = rate Hz), 2 sequenced (aAnim.y = 0..1 position).
const lightVert = /* glsl */ `
attribute vec3 color;
attribute float aSize;
attribute vec2 aAnim;
uniform float uTime, uNight, uScale, uDay, uFogNear, uFogFar;
varying vec3 vColor;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float on = 1.0;
  if (aAnim.x > 0.5 && aAnim.x < 1.5) on = step(0.88, fract(uTime * aAnim.y + position.x * 0.0137 + position.z * 0.0091));
  else if (aAnim.x > 1.5) on = 1.0 - step(0.06, abs(fract(uTime * 2.0) - aAnim.y));
  float vis = mix(uDay, 1.0, uNight);
  if (aAnim.x > 0.5) vis = max(vis, 0.8);
  float dist = -mv.z;
  vA = on * vis * (1.0 - smoothstep(uFogNear, uFogFar * 1.8, dist));
  gl_PointSize = vA > 0.001 ? clamp(aSize * uScale / dist, 1.6, 48.0) : 0.0;
  vColor = color;
  gl_Position = projectionMatrix * mv;
}`;
const lightFrag = /* glsl */ `
varying vec3 vColor;
varying float vA;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, r);
  gl_FragColor = vec4(vColor * a * a * vA * 1.6, 1.0);
}`;

export function makeLightMaterial(day = 0.12) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: globalUniforms.uTime, uNight: globalUniforms.uNight,
      uScale: { value: 500 }, uDay: { value: day }, uFogNear: { value: 300 }, uFogFar: { value: 3000 },
    },
    vertexShader: lightVert, fragmentShader: lightFrag,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

// Keep a light material's pixel scale and fog in sync with the camera.
export function updateLightMaterial(mat, camera, renderer, fog) {
  const h = renderer.domElement.height;
  mat.uniforms.uScale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  if (fog) { mat.uniforms.uFogNear.value = fog.near; mat.uniforms.uFogFar.value = fog.far; }
}

class LightBuf {
  constructor() { this.p = []; this.c = []; this.s = []; this.a = []; }
  add(x, y, z, color, size = 1.4, mode = 0, param = 0) {
    this.p.push(x, y, z);
    const c = new THREE.Color(color);
    this.c.push(c.r, c.g, c.b);
    this.s.push(size);
    this.a.push(mode, param);
  }
  points(mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(this.s, 1));
    g.setAttribute('aAnim', new THREE.Float32BufferAttribute(this.a, 2));
    g.computeBoundingSphere();
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 8;
    return pts;
  }
}

// ------------------------------------------------------------- geometry
// drape(geometry) lays a flat layer (y = lift) on the terrain.
export function buildAirport(map, add, mats, drape = (g) => g) {
  const A = map.aero;
  if (!A) return null;
  const pts = (nodes) => {
    const a = new Float32Array(nodes.length * 2);
    nodes.forEach((n, i) => { a[2 * i] = A.nodes[2 * n]; a[2 * i + 1] = A.nodes[2 * n + 1]; });
    return a;
  };
  mats.runway = MAT.flatLayer(MAT.makeRunwayMaterial(), 0);
  mats.taxiway = MAT.flatLayer(MAT.makeTaxiwayMaterial(), 0);

  // Apron pavement around taxilanes and stands (aprons are only partly mapped).
  const pave = new GeoBuilder({ color: [Uint8Array, 3, true] });
  const paveCol = () => pave.attrs.color.buf.p3(APRON_RGB[0], APRON_RGB[1], APRON_RGB[2]);
  for (const w of A.ways) {
    if (w.kind === AERO.TAXILANE) ribbon(pave, pts(w.nodes), 26, 0.04, paveCol);
    else if (w.kind === AERO.LEADIN || w.kind === AERO.CONNECTOR) ribbon(pave, pts(w.nodes), 30, 0.04, paveCol);
  }
  for (const st of A.stands) {
    // Pad around the stand end for the parked aircraft's wings and tail.
    const p = pts(st.nodes), n = st.nodes.length;
    const ex = p[2 * n - 2], ez = p[2 * n - 1];
    const ring = [];
    for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; ring.push(ex + Math.cos(a) * 34, ez + Math.sin(a) * 34); }
    const base = pave.vcount;
    for (let k = 0; k < 16; k++) { pave.pos.p3(ring[2 * k], 0.04, ring[2 * k + 1]); paveCol(); }
    for (let k = 1; k < 15; k++) pave.idx.p3(base, base + k + 1, base + k);
  }
  const pg = pave.build();
  if (pg) add(meshOf(drape(pg), mats.ground, -44));

  // Taxiways and taxilanes.
  const tw = new GeoBuilder({ aUV: [Float32Array, 2, false], aTwy: [Float32Array, 2, false] });
  for (const w of A.ways) {
    if (w.kind !== AERO.TAXIWAY && w.kind !== AERO.TAXILANE) continue;
    const hw = w.width / 2, edges = w.kind === AERO.TAXIWAY ? 1 : 0;
    ribbon(tw, pts(w.nodes), hw, 0.06, (u, s, seg, tb) => { tb.attrs.aUV.buf.p2(u, s); tb.attrs.aTwy.buf.p2(hw, edges); });
  }
  const tg = tw.build();
  if (tg) add(meshOf(drape(tg), mats.taxiway, -29.6));

  // Runways (with paved shoulders).
  const rw = new GeoBuilder({ aUV: [Float32Array, 2, false], aRwy: [Float32Array, 2, false] });
  const runways = A.runways.map((r) => {
    const p = pts(r.nodes);
    let L = 0;
    for (let i = 1; i < r.nodes.length; i++) L += Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
    const hw = r.width / 2;
    ribbon(rw, p, hw + 7.5, 0.07, (u, s, seg, tb) => { tb.attrs.aUV.buf.p2(u, s); tb.attrs.aRwy.buf.p2(hw, L); });
    return { ...r, pts: p, length: L };
  });
  const rg = rw.build();
  if (rg) add(meshOf(drape(rg), mats.runway, -29.4));

  // Yellow stand lead-in lines and hold-short bars.
  const paint = new GeoBuilder({ color: [Uint8Array, 3, true] });
  const yel = () => paint.attrs.color.buf.p3(YELLOW_RGB[0], YELLOW_RGB[1], YELLOW_RGB[2]);
  for (const st of A.stands) ribbon(paint, pts(st.nodes), 0.12, 0.09, yel);
  addHoldBars(A, runways, paint, yel);
  const ptg = paint.build();
  if (ptg) add(meshOf(drape(ptg), mats.ground, -29.2));

  // Runway designation numbers at both ends.
  addDesignations(runways, add, drape);

  // Airfield lighting, standing on the ground (or the water off the runway ends).
  const lightBuf = new LightBuf();
  const lights = { add: (x, y, z, ...rest) => lightBuf.add(x, map.terrain.h(x, z) + y, z, ...rest) };
  const lightMat = makeLightMaterial(0.1);
  for (const r of runways) {
    const { ox, oz, s, n } = polyOffsets(r.pts);
    const hw = r.width / 2 + 1.2;
    const at = (d) => {
      let i = 1;
      while (i < n - 1 && s[i] < d) i++;
      const t = Math.max(0, Math.min(1, (d - s[i - 1]) / Math.max(1e-6, s[i] - s[i - 1])));
      return [r.pts[2 * i - 2] + (r.pts[2 * i] - r.pts[2 * i - 2]) * t, r.pts[2 * i - 1] + (r.pts[2 * i + 1] - r.pts[2 * i - 1]) * t, ox[i] + (ox[i] ? 0 : 0), oz[i]];
    };
    for (let d = 0; d <= r.length; d += 60) {
      const [x, z, nx, nz] = at(d);
      lights.add(x + nx * hw, 0.4, z + nz * hw, 0xfff6e0, 1.5);
      lights.add(x - nx * hw, 0.4, z - nz * hw, 0xfff6e0, 1.5);
    }
    for (let d = 30; d < r.length; d += 30) { const [x, z] = at(d); lights.add(x, 0.2, z, 0xf4f4ff, 1.1); }
    for (const [d, color] of [[0, 0x2aff6a], [r.length, 0x2aff6a]]) {
      const [x, z, nx, nz] = at(d);
      for (let k = -8; k <= 8; k++) lights.add(x + nx * k * 2.8, 0.4, z + nz * k * 2.8, color, 1.4);
    }
    // Approach lights with a sequenced "rabbit" for active arrival ends.
    r.ends.forEach((name, e) => {
      if (!ACTIVE.arrive.includes(name)) return;
      const sx = e === 0 ? r.pts[0] : r.pts[2 * n - 2], sz = e === 0 ? r.pts[1] : r.pts[2 * n - 1];
      const tx = e === 0 ? r.pts[2] - r.pts[0] : r.pts[2 * n - 4] - r.pts[2 * n - 2];
      const tz = e === 0 ? r.pts[3] - r.pts[1] : r.pts[2 * n - 3] - r.pts[2 * n - 1];
      const tl = Math.hypot(tx, tz) || 1;
      const dx = -tx / tl, dz = -tz / tl, px = -dz, pz = dx;
      const N = 30;
      for (let k = 1; k <= N; k++) {
        const x = sx + dx * k * 30, z = sz + dz * k * 30;
        for (let j = -2; j <= 2; j++) lights.add(x + px * j * 1.2, 1.0, z + pz * j * 1.2, 0xfff4dc, 1.3);
        if (k === 10) for (let j = -7; j <= 7; j++) lights.add(x + px * j * 1.5, 1.0, z + pz * j * 1.5, 0xfff4dc, 1.3);
        lights.add(x, 1.6, z, 0xffffff, 4.5, 2, 1 - k / N);
      }
    });
  }
  for (const w of A.ways) {
    if (w.kind !== AERO.TAXIWAY) continue;
    const p = pts(w.nodes);
    const { ox, oz, s, n } = polyOffsets(p);
    const hw = w.width / 2 + 0.8;
    for (let i = 0; i + 1 < n; i++) {
      const L = s[i + 1] - s[i];
      for (let d = 0; d < L; d += 30) {
        const t = d / L, x = p[2 * i] + (p[2 * i + 2] - p[2 * i]) * t, z = p[2 * i + 1] + (p[2 * i + 3] - p[2 * i + 1]) * t;
        lights.add(x + ox[i] * hw, 0.3, z + oz[i] * hw, 0x3d6bff, 1.0);
        lights.add(x - ox[i] * hw, 0.3, z - oz[i] * hw, 0x3d6bff, 1.0);
      }
    }
  }
  const lp = lightBuf.points(lightMat);
  add(lp);
  return { runways, lightMat, lights: lp, count: lightBuf.s.length };
}

function addHoldBars(A, runways, b, col) {
  // Node -> incident taxi segment direction.
  const dir = new Map();
  for (const w of A.ways) {
    if (w.kind !== AERO.TAXIWAY && w.kind !== AERO.TAXILANE) continue;
    for (let i = 0; i < w.nodes.length; i++) {
      const a = w.nodes[Math.max(0, i - 1)], c = w.nodes[Math.min(w.nodes.length - 1, i + 1)];
      if (a === c) continue;
      dir.set(w.nodes[i], [A.nodes[2 * c] - A.nodes[2 * a], A.nodes[2 * c + 1] - A.nodes[2 * a + 1], w.width / 2]);
    }
  }
  const rwyPts = runways.flatMap((r) => Array.from(r.nodes, (n) => [A.nodes[2 * n], A.nodes[2 * n + 1]]));
  const quad = (pts) => { const base = b.vcount; for (const [x, z] of pts) { b.pos.p3(x, 0.09, z); col(); } b.idx.p3(base, base + 2, base + 1); b.idx.p3(base, base + 3, base + 2); };
  for (const h of A.holds) {
    const d = dir.get(h);
    if (!d) continue;
    const x = A.nodes[2 * h], z = A.nodes[2 * h + 1];
    let [tx, tz, hw] = d;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    // Point the "runway side" toward the nearest runway node.
    let best = null, bd = Infinity;
    for (const p of rwyPts) { const dd = (p[0] - x) ** 2 + (p[1] - z) ** 2; if (dd < bd) { bd = dd; best = p; } }
    if (best && (best[0] - x) * tx + (best[1] - z) * tz < 0) { tx = -tx; tz = -tz; }
    const px = -tz, pz = tx;
    const line = (off, dashed) => {
      const cx = x + tx * off, cz = z + tz * off;
      for (let a = -hw; a < hw; a += dashed ? 2 : hw * 2) {
        const a1 = Math.min(hw, a + (dashed ? 1 : hw * 2));
        quad([[cx + px * a - tx * 0.1, cz + pz * a - tz * 0.1], [cx + px * a1 - tx * 0.1, cz + pz * a1 - tz * 0.1], [cx + px * a1 + tx * 0.1, cz + pz * a1 + tz * 0.1], [cx + px * a + tx * 0.1, cz + pz * a + tz * 0.1]]);
      }
    };
    line(-0.9, false); line(-0.45, false); line(0.45, true); line(0.9, true);
  }
}

function addDesignations(runways, add, drape) {
  const names = [...new Set(runways.flatMap((r) => r.ends))];
  const cell = 128, cols = 4, rows = Math.ceil(names.length / cols);
  const c = document.createElement('canvas');
  c.width = cell * cols; c.height = cell * rows;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  names.forEach((nm, i) => {
    const x = (i % cols) * cell + cell / 2, y = Math.floor(i / cols) * cell;
    const num = nm.replace(/[LRC]$/, ''), letter = nm.slice(num.length);
    ctx.save();
    ctx.translate(x, y + (letter ? cell * 0.3 : cell / 2));
    ctx.scale(0.7, letter ? 1.0 : 1.5);
    ctx.font = `800 ${letter ? 52 : 60}px "Arial Narrow", Arial, sans-serif`;
    ctx.fillText(num, 0, 0);
    ctx.restore();
    if (letter) {
      ctx.save();
      ctx.translate(x, y + cell * 0.76);
      ctx.scale(0.7, 1.0);
      ctx.font = '800 52px "Arial Narrow", Arial, sans-serif';
      ctx.fillText(letter, 0, 0);
      ctx.restore();
    }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.4, transparent: false, depthWrite: false, roughness: 0.7, color: 0xdcdcda });
  mat.userData.order = 0;
  const b = new GeoBuilder({ uv: [Float32Array, 2, false] });
  for (const r of runways) {
    const n = r.nodes.length;
    r.ends.forEach((nm, e) => {
      const i = names.indexOf(nm);
      const u0 = (i % cols) / cols, u1 = u0 + 1 / cols;
      const v1 = 1 - Math.floor(i / cols) / rows, v0 = v1 - 1 / rows;
      const ex = e === 0 ? r.pts[0] : r.pts[2 * n - 2], ez = e === 0 ? r.pts[1] : r.pts[2 * n - 1];
      const ax = e === 0 ? r.pts[2] : r.pts[2 * n - 4], az = e === 0 ? r.pts[3] : r.pts[2 * n - 3];
      const l = Math.hypot(ax - ex, az - ez) || 1;
      const fx = (ax - ex) / l, fz = (az - ez) / l;   // toward the runway (away from this end)
      const rx = -fz, rz = fx;                         // pilot's right... (left-handed in x/z)
      const d0 = 60, d1 = 60 + 22, w = 9;
      const P = (d, a) => [ex + fx * d + rx * a, 0.11, ez + fz * d + rz * a];
      const base = b.vcount;
      for (const p of [P(d0, -w), P(d0, w), P(d1, w), P(d1, -w)]) b.pos.p3(p[0], p[1], p[2]);
      // Bottom of the text toward the threshold, reading left-to-right for the pilot.
      b.attrs.uv.buf.p2(u1, v0); b.attrs.uv.buf.p2(u0, v0); b.attrs.uv.buf.p2(u0, v1); b.attrs.uv.buf.p2(u1, v1);
      b.idx.p3(base, base + 2, base + 1); b.idx.p3(base, base + 3, base + 2);
    });
  }
  const g = b.build();
  if (g) {
    add(meshOf(drape(g), mat, -29.0));
  }
}
