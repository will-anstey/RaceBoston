// Uniform-grid spatial indexes (CSR layout) for line segments and points.

import { segDist2 } from './util.js';

class GridBase {
  constructor(bounds, cell) {
    this.cell = cell;
    this.minX = bounds.minX - cell;
    this.minZ = bounds.minZ - cell;
    this.nx = Math.ceil((bounds.maxX - bounds.minX) / cell) + 3;
    this.nz = Math.ceil((bounds.maxZ - bounds.minZ) / cell) + 3;
    this.result = new Int32Array(1024);
    this.count = 0;
    this.stampId = 0;
  }
  cx(x) { return Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.minX) / this.cell))); }
  cz(z) { return Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.minZ) / this.cell))); }
  _push(i) {
    if (this.count >= this.result.length) {
      const r = new Int32Array(this.result.length * 2);
      r.set(this.result);
      this.result = r;
    }
    this.result[this.count++] = i;
  }
}

export class SegmentGrid extends GridBase {
  constructor(bounds, cell = 16) {
    super(bounds, cell);
    this._segs = [];
    this._meta = [];
    this._meta2 = [];
  }

  add(ax, az, bx, bz, meta = 0, meta2 = 0) {
    this._segs.push(ax, az, bx, bz);
    this._meta.push(meta);
    this._meta2.push(meta2);
  }

  build() {
    const n = this._meta.length;
    this.segs = Float32Array.from(this._segs);
    this.meta = Int32Array.from(this._meta);
    this.meta2 = Int32Array.from(this._meta2);
    this._segs = this._meta = this._meta2 = null;
    this.n = n;
    this.stamp = new Uint32Array(n);
    const ncell = this.nx * this.nz;
    const counts = new Uint32Array(ncell + 1);
    const visit = (fn) => {
      const c = this.cell, half = c * 0.7072;
      for (let i = 0; i < n; i++) {
        const ax = this.segs[4 * i], az = this.segs[4 * i + 1], bx = this.segs[4 * i + 2], bz = this.segs[4 * i + 3];
        const x0 = this.cx(Math.min(ax, bx)), x1 = this.cx(Math.max(ax, bx));
        const z0 = this.cz(Math.min(az, bz)), z1 = this.cz(Math.max(az, bz));
        const single = x0 === x1 && z0 === z1;
        for (let gz = z0; gz <= z1; gz++) {
          for (let gx = x0; gx <= x1; gx++) {
            if (!single) {
              const ccx = this.minX + (gx + 0.5) * c, ccz = this.minZ + (gz + 0.5) * c;
              if (segDist2(ccx, ccz, ax, az, bx, bz) > half * half) continue;
            }
            fn(gz * this.nx + gx, i);
          }
        }
      }
    };
    visit((cell) => counts[cell + 1]++);
    for (let i = 0; i < ncell; i++) counts[i + 1] += counts[i];
    this.start = counts;
    this.items = new Int32Array(counts[ncell]);
    const fill = counts.slice(0, ncell);
    visit((cell, i) => { this.items[fill[cell]++] = i; });
    return this;
  }

  // Collects unique segment indices near (x, z) into this.result[0..count).
  query(x, z, r) {
    this.count = 0;
    const id = ++this.stampId;
    const x0 = this.cx(x - r), x1 = this.cx(x + r), z0 = this.cz(z - r), z1 = this.cz(z + r);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cell = gz * this.nx + gx;
        for (let k = this.start[cell], e = this.start[cell + 1]; k < e; k++) {
          const i = this.items[k];
          if (this.stamp[i] === id) continue;
          this.stamp[i] = id;
          this._push(i);
        }
      }
    }
    return this.count;
  }

  // Nearest segment within maxR; optional filter(segIndex) -> bool.
  nearest(x, z, maxR, filter, out) {
    const n = this.query(x, z, maxR);
    let best = -1, bd = maxR * maxR;
    const tmp = { t: 0, x: 0, z: 0 };
    for (let k = 0; k < n; k++) {
      const i = this.result[k];
      if (filter && !filter(i)) continue;
      const s = this.segs;
      const d = segDist2(x, z, s[4 * i], s[4 * i + 1], s[4 * i + 2], s[4 * i + 3], tmp);
      if (d < bd) {
        bd = d; best = i;
        if (out) { out.t = tmp.t; out.x = tmp.x; out.z = tmp.z; }
      }
    }
    if (out) { out.index = best; out.dist = Math.sqrt(bd); }
    return best;
  }
}

export class PointGrid extends GridBase {
  constructor(bounds, cell = 16) {
    super(bounds, cell);
    this._pts = [];
  }
  add(x, z, r = 0) { this._pts.push(x, z, r); }
  build() {
    const n = this._pts.length / 3;
    this.pts = Float32Array.from(this._pts);
    this._pts = null;
    this.n = n;
    const ncell = this.nx * this.nz;
    const counts = new Uint32Array(ncell + 1);
    const cellOf = (i) => this.cz(this.pts[3 * i + 1]) * this.nx + this.cx(this.pts[3 * i]);
    for (let i = 0; i < n; i++) counts[cellOf(i) + 1]++;
    for (let i = 0; i < ncell; i++) counts[i + 1] += counts[i];
    this.start = counts;
    this.items = new Int32Array(n);
    const fill = counts.slice(0, ncell);
    for (let i = 0; i < n; i++) this.items[fill[cellOf(i)]++] = i;
    return this;
  }
  query(x, z, r) {
    this.count = 0;
    const x0 = this.cx(x - r), x1 = this.cx(x + r), z0 = this.cz(z - r), z1 = this.cz(z + r);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cell = gz * this.nx + gx;
        for (let k = this.start[cell], e = this.start[cell + 1]; k < e; k++) this._push(this.items[k]);
      }
    }
    return this.count;
  }
}

// Coarse raster of surface flags (water / road / grass ...) for O(1) lookups.
export class SurfaceMap {
  constructor(bounds, res = 2) {
    this.res = res;
    this.minX = bounds.minX;
    this.minZ = bounds.minZ;
    this.w = Math.ceil((bounds.maxX - bounds.minX) / res);
    this.h = Math.ceil((bounds.maxZ - bounds.minZ) / res);
    this.data = new Uint8Array(this.w * this.h);
  }
  get(x, z) {
    const xi = Math.floor((x - this.minX) / this.res), zi = Math.floor((z - this.minZ) / this.res);
    if (xi < 0 || zi < 0 || xi >= this.w || zi >= this.h) return 0;
    return this.data[zi * this.w + xi];
  }
  fill(v) { this.data.fill(v); }
  // Even-odd scanline fill of rings (Float32Array [x,z,...]).
  polygon(rings, bit, clear = false) {
    const res = this.res, w = this.w, d = this.data;
    let minZ = Infinity, maxZ = -Infinity;
    for (const r of rings) for (let i = 1; i < r.length; i += 2) { if (r[i] < minZ) minZ = r[i]; if (r[i] > maxZ) maxZ = r[i]; }
    const z0 = Math.max(0, Math.floor((minZ - this.minZ) / res)), z1 = Math.min(this.h - 1, Math.ceil((maxZ - this.minZ) / res));
    const xs = [];
    for (let zi = z0; zi <= z1; zi++) {
      const zc = this.minZ + (zi + 0.5) * res;
      xs.length = 0;
      for (const r of rings) {
        const n = r.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const az = r[2 * j + 1], bz = r[2 * i + 1];
          if ((az > zc) !== (bz > zc)) {
            const ax = r[2 * j], bx = r[2 * i];
            xs.push(ax + ((zc - az) * (bx - ax)) / (bz - az));
          }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      const row = zi * w;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil((xs[k] - this.minX) / res - 0.5));
        const xb = Math.min(w - 1, Math.floor((xs[k + 1] - this.minX) / res - 0.5));
        if (clear) for (let x = xa; x <= xb; x++) d[row + x] &= ~bit;
        else for (let x = xa; x <= xb; x++) d[row + x] |= bit;
      }
    }
  }
  // Thick polyline (Float32Array or array of [x,z]) with half-width hw.
  line(pts, hw, bit) {
    const res = this.res, w = this.w, d = this.data;
    const n = pts.length / 2;
    for (let i = 0; i + 1 < n; i++) {
      const ax = (pts[2 * i] - this.minX) / res, az = (pts[2 * i + 1] - this.minZ) / res;
      const bx = (pts[2 * i + 2] - this.minX) / res, bz = (pts[2 * i + 3] - this.minZ) / res;
      const h = hw / res;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - h)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + h));
      const z0 = Math.max(0, Math.floor(Math.min(az, bz) - h)), z1 = Math.min(this.h - 1, Math.ceil(Math.max(az, bz) + h));
      const h2 = h * h;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (segDist2(x + 0.5, z + 0.5, ax, az, bx, bz) <= h2) d[z * w + x] |= bit;
        }
      }
    }
  }
}
