// The world beyond the detailed maps, for the view from the air: a coarse
// height grid (data/backdrop.*, 300 m) of eastern Massachusetts, Cape Cod,
// Buzzards Bay and the islands drawn as low land, and the open ocean laid
// over everything else at sea level. Under the detailed maps (Boston and the
// islands) the backdrop is left out, and it eases down to sea level toward
// their edges so the two meet.

import * as THREE from 'three';
import { makeWaterMaterial } from './materials.js';
import { clamp, hash01 } from './util.js';

const FADE = 1800;        // m: the backdrop eases down to sea level this far from a detailed map

export class Backdrop {
  static async load(base = 'data/') {
    try {
      const [meta, buf] = await Promise.all([
        fetch(base + 'backdrop.json').then((r) => (r.ok ? r.json() : null)),
        fetch(base + 'backdrop.bin').then((r) => (r.ok ? r.arrayBuffer() : null)),
      ]);
      if (!meta || !buf || buf.byteLength !== meta.w * meta.h * 2) return null;
      return new Backdrop(meta, buf);
    } catch { return null; }
  }

  constructor(meta, buf) {
    Object.assign(this, { minX: meta.minX, minZ: meta.minZ, step: meta.step, w: meta.w, h: meta.h });
    this.boxes = meta.boxes || [];
    const d = new Int16Array(buf), H = (this.H = new Float32Array(meta.w * meta.h));
    for (let j = 0; j < meta.h; j++) { let v = 0; for (let i = 0; i < meta.w; i++) { const k = j * meta.w + i; v += d[k]; H[k] = v / 10; } }
    // Ease down to the sea toward each detailed map (where its own ground takes over).
    for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) {
      const x = this.minX + i * this.step, z = this.minZ + j * this.step, k = j * this.w + i;
      const d0 = this.boxDist(x, z);
      if (d0 < FADE && H[k] > 0) H[k] *= Math.max(0, d0) / FADE;
    }
  }

  // Signed distance (m) from a point to the nearest detailed map's box (negative inside).
  boxDist(x, z) {
    let best = Infinity;
    for (const b of this.boxes) {
      const dx = Math.max(b.minX - x, 0, x - b.maxX), dz = Math.max(b.minZ - z, 0, z - b.maxZ);
      const inside = x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ;
      const d = inside ? -Math.min(x - b.minX, b.maxX - x, z - b.minZ, b.maxZ - z) : Math.hypot(dx, dz);
      if (d < best) best = d;
    }
    return best;
  }

  // Ground height (sea floor negative; well under the sea off the grid).
  heightAt(x, z) {
    const fx = (x - this.minX) / this.step, fz = (z - this.minZ) / this.step;
    if (!(fx >= 0 && fz >= 0 && fx <= this.w - 1 && fz <= this.h - 1)) return -20;
    const i = Math.min(this.w - 2, fx | 0), j = Math.min(this.h - 2, fz | 0), u = fx - i, v = fz - j, k = j * this.w + i, H = this.H, w = this.w;
    return (H[k] * (1 - u) + H[k + 1] * u) * (1 - v) + (H[k + w] * (1 - u) + H[k + w + 1] * u) * v;
  }

  // Land meshes (tiles of 32 x 32 cells, coast and land only) and the ocean.
  build(scene) {
    const group = new THREE.Group();
    group.name = 'backdrop';
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0, flatShading: false });
    const TILE = 32, S = this.step, H = this.H, w = this.w;
    const c = new THREE.Color(), sand = new THREE.Color(0xd9c9a0), grass = new THREE.Color(0x6e8f4e), wood = new THREE.Color(0x4b6b3a), town = new THREE.Color(0x9a978d), rock = new THREE.Color(0x8a8576), seabed = new THREE.Color(0x3d5a5a);
    this.tiles = [];
    for (let tj = 0; tj < this.h - 1; tj += TILE) {
      for (let ti = 0; ti < this.w - 1; ti += TILE) {
        const pos = [], col = [], nrm = [], idx = [];
        const map = new Map();
        const vert = (i, j) => {
          const key = j * w + i;
          if (map.has(key)) return map.get(key);
          const x = this.minX + i * S, z = this.minZ + j * S, y = H[key];
          pos.push(x, Math.max(y, -12), z);
          // Normal from neighbours.
          const hx = H[j * w + Math.min(w - 1, i + 1)] - H[j * w + Math.max(0, i - 1)], hz = H[Math.min(this.h - 1, j + 1) * w + i] - H[Math.max(0, j - 1) * w + i];
          const n = new THREE.Vector3(-hx / (2 * S), 1, -hz / (2 * S)).normalize();
          nrm.push(n.x, n.y, n.z);
          // Colour: sand by the water, then fields and woods (noise), towns near Boston, darker sea floor.
          const r = hash01(i * 7919 + j * 104729), r2 = hash01(i * 31 + j * 1777 + 5);
          if (y < 0.3) c.copy(seabed).lerp(sand, clamp((y + 4) / 4.3, 0, 1));
          else if (y < 3) c.copy(sand).lerp(grass, (y - 0.3) / 2.7);
          else {
            c.copy(grass).lerp(wood, clamp(0.35 + (r - 0.5) * 0.9 + (r2 - 0.5) * 0.4, 0, 1));
            const dBos = Math.hypot(x, z);
            if (dBos < 30000) c.lerp(town, clamp(1 - dBos / 30000, 0, 0.75) * (0.4 + 0.6 * r2));
            if (y > 60) c.lerp(rock, clamp((y - 60) / 80, 0, 0.5));
          }
          col.push(c.r, c.g, c.b);
          const vi = pos.length / 3 - 1;
          map.set(key, vi);
          return vi;
        };
        let any = false;
        for (let j = tj; j < Math.min(this.h - 1, tj + TILE); j++) {
          for (let i = ti; i < Math.min(w - 1, ti + TILE); i++) {
            const k = j * w + i;
            const hmax = Math.max(H[k], H[k + 1], H[k + w], H[k + w + 1]);
            if (hmax < -1.5) continue;                             // open sea: the ocean covers it
            const cx = this.minX + (i + 0.5) * S, cz = this.minZ + (j + 0.5) * S;
            if (this.boxDist(cx, cz) < -S) continue;              // under a detailed map
            const a = vert(i, j), b = vert(i + 1, j), d = vert(i, j + 1), e = vert(i + 1, j + 1);
            idx.push(a, d, b, b, d, e);
            any = true;
          }
        }
        if (!any) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        g.setIndex(idx);
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, mat);
        m.receiveShadow = false;
        m.renderOrder = -66;
        group.add(m);
        this.tiles.push(m);
      }
    }
    // The ocean: a big sheet just under the detailed maps' own water.
    const ox = this.minX + (this.w * S) / 2, oz = this.minZ + (this.h * S) / 2, R = 320000;
    const og = new THREE.PlaneGeometry(R, R, 8, 8).rotateX(-Math.PI / 2).translate(ox, -0.25, oz);
    const ocean = new THREE.Mesh(og, makeWaterMaterial());
    ocean.renderOrder = -67;
    ocean.material.polygonOffset = true; ocean.material.polygonOffsetFactor = 2; ocean.material.polygonOffsetUnits = 4;
    group.add(ocean);
    this.ocean = ocean;
    scene.add(group);
    this.group = group;
    return group;
  }

  // A small map image (one pixel a cell) for the big map.
  art() {
    if (this._art) return this._art;
    const cv = document.createElement('canvas');
    cv.width = this.w; cv.height = this.h;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(this.w, this.h);
    for (let k = 0; k < this.H.length; k++) {
      const land = this.H[k] > 0.3;
      img.data[4 * k] = land ? 0x35 : 0x1d; img.data[4 * k + 1] = land ? 0x3c : 0x4a; img.data[4 * k + 2] = land ? 0x49 : 0x73; img.data[4 * k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this._art = { canvas: cv, minX: this.minX - this.step / 2, minZ: this.minZ - this.step / 2, maxX: this.minX + (this.w - 0.5) * this.step, maxZ: this.minZ + (this.h - 0.5) * this.step };
    return this._art;
  }
}
