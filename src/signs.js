// Boston-style street name signs: a pole on a corner of every named
// intersection with two green blades (one per street, parallel to it).
// Poles and blank blades are instanced; the readable text is drawn only for
// the signs near the player, from a small dynamic canvas atlas.

import * as THREE from 'three';
import { RC, SIDEWALK_W, hasSidewalk } from './mapdata.js';
import { PointGrid } from './spatial.js';
import { SURF } from './collision.js';
import { globalUniforms } from './materials.js';

const ABBR = [
  [/\bStreet\b/g, 'St'], [/\bAvenue\b/g, 'Ave'], [/\bBoulevard\b/g, 'Blvd'], [/\bRoad\b/g, 'Rd'],
  [/\bPlace\b/g, 'Pl'], [/\bSquare\b/g, 'Sq'], [/\bDrive\b/g, 'Dr'], [/\bCourt\b/g, 'Ct'],
  [/\bTerrace\b/g, 'Ter'], [/\bParkway\b/g, 'Pkwy'], [/\bHighway\b/g, 'Hwy'], [/\bLane\b/g, 'Ln'],
  [/\bExtension\b/g, 'Ext'], [/\bNorth\b/g, 'N'], [/\bSouth\b/g, 'S'], [/\bEast\b/g, 'E'], [/\bWest\b/g, 'W'],
  [/\bSaint\b/g, 'St'], [/\bMount\b/g, 'Mt'],
];
export const abbreviate = (n) => ABBR.reduce((s, [re, r]) => s.replace(re, r), n).replace(/\s+/g, ' ').trim();

const BLADE_L = 1.55, BLADE_H = 0.24, BLADE_T = 0.03;
const CELL_W = 256, CELL_H = 40, ATLAS = 1024;
const COLS = ATLAS / CELL_W, ROWS = Math.floor(ATLAS / CELL_H);
const NEAR = 26, NEAR_R = 110;

export class StreetSigns {
  constructor(map, graph, scene, collision) {
    this.map = map;
    this.posts = this._place(map, graph, collision);
    this.group = new THREE.Group();
    this.group.name = 'street-signs';
    scene.add(this.group);
    this._buildStatic();
    this._buildAtlas();
    this.timer = 0;
  }

  _place(map, graph, cw) {
    const nodes = map.nodes, ny = map.nodeRel, roads = map.roads;
    const N = nodes.length / 2;
    // Per node: best (lowest class) road per distinct name, at grade only.
    const byNode = new Map();
    for (const r of roads) {
      if (r.cls > RC.LIVING || r.tunnel || r.bridge || !r.name || /^(I-|US-|Route )/.test(r.name)) continue;
      for (let i = 0; i < r.nodes.length; i++) {
        const n = r.nodes[i];
        if (Math.abs(ny[n]) > 0.3) continue;
        let m = byNode.get(n);
        if (!m) byNode.set(n, (m = new Map()));
        const cur = m.get(r.name);
        if (!cur || r.cls < cur.cls) m.set(r.name, r);
      }
    }
    const posts = [];
    const taken = new Set();
    const cellKey = (x, z) => Math.floor(x / 28) * 100003 + Math.floor(z / 28);
    // Bigger intersections first so they win the clustering.
    const cand = [...byNode].filter(([, m]) => m.size >= 2)
      .map(([n, m]) => [n, [...m.values()].sort((a, b) => a.cls - b.cls).slice(0, 2)])
      .sort((a, b) => (a[1][0].cls + a[1][1].cls) - (b[1][0].cls + b[1][1].cls));
    const dirsAt = (J, road) => {
      const out = [];
      for (let k = graph.adjStart[J]; k < graph.adjStart[J + 1]; k++) {
        const e = graph.adj[k];
        if (graph.eRoad[e] !== road.id) continue;
        const v = graph.eTo[e];
        const dx = nodes[2 * v] - nodes[2 * J], dz = nodes[2 * v + 1] - nodes[2 * J + 1];
        const l = Math.hypot(dx, dz) || 1;
        out.push([dx / l, dz / l]);
      }
      return out;
    };
    for (const [J, [A, B]] of cand) {
      const x = nodes[2 * J], z = nodes[2 * J + 1];
      const ck = cellKey(x, z);
      let near = false;
      for (let dx = -1; dx <= 1 && !near; dx++) for (let dz = -1; dz <= 1 && !near; dz++) if (taken.has(ck + dx * 100003 + dz)) near = true;
      if (near) continue;
      const da = dirsAt(J, A), db = dirsAt(J, B);
      if (!da.length || !db.length) continue;
      const wa = A.width / 2 + (hasSidewalk(A) ? SIDEWALK_W * 0.55 : 1.2);
      const wb = B.width / 2 + (hasSidewalk(B) ? SIDEWALK_W * 0.55 : 1.2);
      let spot = null;
      for (const a of da) {
        for (const b of db) {
          const cross = a[0] * b[1] - a[1] * b[0];
          if (Math.abs(cross) < 0.35) continue; // nearly parallel arms
          const px = x + a[0] * wb + b[0] * wa, pz = z + a[1] * wb + b[1] * wa;
          if (cw.surfaceAt(px, pz) & (SURF.BLDG | SURF.WATER | SURF.CUT)) continue;
          spot = [px, pz, a, b];
          break;
        }
        if (spot) break;
      }
      if (!spot) continue;
      taken.add(ck);
      const [px, pz, a, b] = spot;
      posts.push({ x: px, z: pz, y: map.terrain.h(px, pz), names: [abbreviate(A.name), abbreviate(B.name)], dirs: [Math.atan2(a[0], -a[1]), Math.atan2(b[0], -b[1])] });
    }
    return posts;
  }

  _buildStatic() {
    const P = this.posts.length;
    const pole = new THREE.CylinderGeometry(0.045, 0.055, 3.25, 6);
    pole.translate(0, 1.625, 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x5b6066, roughness: 0.5, metalness: 0.6 });
    const blade = new THREE.BoxGeometry(BLADE_L, BLADE_H, BLADE_T);
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0x0d6a3b, roughness: 0.55, metalness: 0.1 });
    this.poleMesh = new THREE.InstancedMesh(pole, poleMat, P);
    this.bladeMesh = new THREE.InstancedMesh(blade, bladeMat, P * 2);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    this.blades = [];
    this.posts.forEach((post, i) => {
      this.poleMesh.setMatrixAt(i, m.compose(p.set(post.x, post.y, post.z), q.identity(), s));
      post.dirs.forEach((h, k) => {
        // Blade's long axis (local x) along the street direction.
        const y = post.y + (k === 0 ? 3.12 : 2.84);
        q.setFromAxisAngle(up, Math.PI / 2 - h);
        this.bladeMesh.setMatrixAt(i * 2 + k, m.compose(p.set(post.x, y, post.z), q, s));
        this.blades.push({ post: i, k, x: post.x, y, z: post.z, h, name: post.names[k] });
      });
    });
    for (const im of [this.poleMesh, this.bladeMesh]) {
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = true;
      this.group.add(im);
    }
    this.grid = new PointGrid(this.map.meta.play, 40);
    this.posts.forEach((p) => this.grid.add(p.x, p.z, 0));
    this.grid.build();
  }

  _buildAtlas() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS;
    this.canvas.height = ATLAS;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.cells = new Map();      // name -> cell index
    this.cellName = new Array(COLS * ROWS).fill(null);
    this.cellUsed = new Float64Array(COLS * ROWS);
    this.mat = new THREE.MeshStandardMaterial({
      map: this.tex, roughness: 0.5, metalness: 0.0, emissiveMap: this.tex, emissive: 0xffffff, emissiveIntensity: 0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    });
    this.textGeo = new THREE.BufferGeometry();
    this.textMesh = new THREE.Mesh(this.textGeo, this.mat);
    this.textMesh.frustumCulled = false;
    this.group.add(this.textMesh);
  }

  _cellFor(name, now) {
    let c = this.cells.get(name);
    if (c !== undefined) { this.cellUsed[c] = now; return c; }
    // Evict the least recently used cell.
    let best = 0;
    for (let i = 1; i < this.cellUsed.length; i++) if (this.cellUsed[i] < this.cellUsed[best]) best = i;
    c = best;
    if (this.cellName[c] !== null) this.cells.delete(this.cellName[c]);
    this.cellName[c] = name;
    this.cells.set(name, c);
    this.cellUsed[c] = now;
    this._draw(c, name);
    this.dirty = true;
    return c;
  }

  _draw(c, name) {
    const ctx = this.ctx;
    const x0 = (c % COLS) * CELL_W, y0 = Math.floor(c / COLS) * CELL_H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, CELL_W, CELL_H);
    ctx.clip();
    ctx.fillStyle = '#0d6a3b';
    ctx.fillRect(x0, y0, CELL_W, CELL_H);
    ctx.strokeStyle = '#f4f7f2';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(x0 + 3, y0 + 3, CELL_W - 6, CELL_H - 6, 5);
    ctx.stroke();
    ctx.fillStyle = '#f7faf5';
    ctx.font = '700 27px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const w = ctx.measureText(name).width;
    const maxW = CELL_W - 18;
    const sx = Math.min(1, maxW / w);
    ctx.translate(x0 + CELL_W / 2, y0 + CELL_H / 2 + 1.5);
    ctx.scale(sx, 1);
    ctx.fillText(name, 0, 0);
    ctx.restore();
  }

  update(dt, x, z) {
    this.mat.emissiveIntensity = 0.55 * globalUniforms.uNight.value;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.35;
    const now = performance.now();
    const g = this.grid;
    const n = g.query(x, z, NEAR_R);
    const near = [];
    for (let k = 0; k < n; k++) {
      const i = g.result[k];
      const d = (g.pts[3 * i] - x) ** 2 + (g.pts[3 * i + 1] - z) ** 2;
      if (d < NEAR_R * NEAR_R) near.push([d, i]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const pick = near.slice(0, NEAR).map((v) => v[1]);
    const key = pick.join(',');
    if (key === this._lastKey) return;
    this._lastKey = key;
    // Faces on both sides of each blade.
    const pos = [], uv = [], nrm = [], idx = [];
    const hl = BLADE_L / 2 - 0.02, hh = BLADE_H / 2 - 0.01, off = BLADE_T / 2 + 0.004;
    for (const pi of pick) {
      for (let k = 0; k < 2; k++) {
        const b = this.blades[pi * 2 + k];
        const c = this._cellFor(b.name, now);
        const u0 = ((c % COLS) * CELL_W + 1) / ATLAS, u1 = ((c % COLS) * CELL_W + CELL_W - 1) / ATLAS;
        const v1 = 1 - (Math.floor(c / COLS) * CELL_H + 1) / ATLAS, v0 = 1 - (Math.floor(c / COLS) * CELL_H + CELL_H - 1) / ATLAS;
        // Local axes: long axis L along the street, normal Nn across it.
        const lx = Math.sin(b.h), lz = -Math.cos(b.h);
        const nx = -lz, nz = lx;
        for (const side of [1, -1]) {
          const base = pos.length / 3;
          const sx = side;
          for (const [a, yv, uu, vv] of [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]]) {
            const along = a * hl * sx;
            pos.push(b.x + lx * along + nx * off * side, b.y + yv * hh, b.z + lz * along + nz * off * side);
            uv.push(uu ? u1 : u0, vv ? v1 : v0);
            nrm.push(nx * side, 0, nz * side);
          }
          idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
    this.textGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.textGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    this.textGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    this.textGeo.setIndex(idx);
    this.textGeo.computeBoundingSphere();
    if (this.dirty) { this.tex.needsUpdate = true; this.dirty = false; }
  }
}
