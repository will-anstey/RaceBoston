// The Charles for boats: a centre line from the upstream edge of the map to
// the Museum of Science dam that keeps well clear of both banks, with the
// distance to the bank on each side. The river polygons are rasterised at
// CELL metres, every cell gets its distance to the bank (chamfer transform)
// and Dijkstra finds the cheapest path, where cells near a bank cost more.

const CELL = 4;

export function buildRiverLine(polys, box, log = () => {}) {
  const W = Math.ceil((box.maxX - box.minX) / CELL), H = Math.ceil((box.maxZ - box.minZ) / CELL);
  const mask = new Uint8Array(W * H);
  for (const p of polys) fillPolygon(mask, W, H, box, p);
  const dist = chamfer(mask, W, H);
  let cells = 0;
  for (let i = 0; i < mask.length; i++) cells += mask[i];
  log(`river: ${polys.length} Charles polygons, ${(cells * CELL * CELL / 1e6).toFixed(2)} km² of water`);

  // Ends: the deepest cell near the west edge, and near the dam in the east.
  const best = (test) => {
    let bi = -1, bd = 0;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (mask[k] && dist[k] > bd && test(box.minX + (i + 0.5) * CELL, box.minZ + (j + 0.5) * CELL)) { bd = dist[k]; bi = k; }
    }
    return bi;
  };
  let maxX = -Infinity;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (mask[j * W + i]) maxX = Math.max(maxX, box.minX + (i + 0.5) * CELL);
  const from = best((x) => x < box.minX + 140);
  const to = best((x) => x > maxX - 90);
  if (from < 0 || to < 0) { log('river: no centre line (ends not found)'); return null; }

  const path = dijkstra(mask, dist, W, H, from, to);
  if (!path) { log('river: no centre line (not connected)'); return null; }
  // Cell centres -> world, smoothed, resampled every 10 m.
  let pts = path.map((k) => [box.minX + ((k % W) + 0.5) * CELL, box.minZ + (Math.floor(k / W) + 0.5) * CELL]);
  for (let pass = 0; pass < 6; pass++) {
    const q = pts.map((p) => p.slice());
    for (let i = 2; i + 2 < pts.length; i++) for (let a = 0; a < 2; a++) q[i][a] = (pts[i - 2][a] + 2 * pts[i - 1][a] + 3 * pts[i][a] + 2 * pts[i + 1][a] + pts[i + 2][a]) / 9;
    pts = q;
  }
  pts = resample(pts, 10);
  // Distance to the bank on each side: to the right (-tz, tx) and left facing downstream.
  const wet = (x, z) => {
    const i = Math.floor((x - box.minX) / CELL), j = Math.floor((z - box.minZ) / CELL);
    return i >= 0 && j >= 0 && i < W && j < H && mask[j * W + i] === 1;
  };
  const out = [];
  for (let n = 0; n < pts.length; n++) {
    const a = pts[Math.max(0, n - 1)], b = pts[Math.min(pts.length - 1, n + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    const [x, z] = pts[n];
    const reach = (s) => {
      let d = 0;
      while (d < 400 && wet(x + -tz * s * (d + 2), z + tx * s * (d + 2))) d += 2;
      return d;
    };
    out.push(Math.round(x * 10) / 10, Math.round(z * 10) / 10, reach(1), reach(-1));
  }
  log(`river: centre line ${(pts.length * 10 / 1000).toFixed(1)} km, ${pts.length} points`);
  return out;
}

function fillPolygon(mask, W, H, box, rings) {
  const edges = [];
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    edges.push((a[0] - box.minX) / CELL, (a[1] - box.minZ) / CELL, (b[0] - box.minX) / CELL, (b[1] - box.minZ) / CELL);
  }
  const xs = [];
  for (let j = 0; j < H; j++) {
    const y = j + 0.5;
    xs.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const y0 = edges[e + 1], y1 = edges[e + 3];
      if ((y0 > y) === (y1 > y)) continue;
      xs.push(edges[e] + ((y - y0) / (y1 - y0)) * (edges[e + 2] - edges[e]));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * W + i] = 1;
    }
  }
}

// Distance (m) from each water cell to the nearest dry one, 3-4 chamfer.
export function chamfer(mask, W, H) {
  const BIG = 1e9, d = new Float32Array(W * H);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? BIG : 0;
  const A = CELL, B = CELL * Math.SQRT2;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (!d[k]) continue;
    let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + A); else v = Math.min(v, A);
    if (j > 0) { v = Math.min(v, d[k - W] + A); if (i > 0) v = Math.min(v, d[k - W - 1] + B); if (i + 1 < W) v = Math.min(v, d[k - W + 1] + B); } else v = Math.min(v, A);
    d[k] = v;
  }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const k = j * W + i;
    if (!d[k]) continue;
    let v = d[k];
    if (i + 1 < W) v = Math.min(v, d[k + 1] + A); else v = Math.min(v, A);
    if (j + 1 < H) { v = Math.min(v, d[k + W] + A); if (i + 1 < W) v = Math.min(v, d[k + W + 1] + B); if (i > 0) v = Math.min(v, d[k + W - 1] + B); } else v = Math.min(v, A);
    d[k] = v;
  }
  return d;
}

// Cheapest 8-connected path; a step costs its length times (1 + 900 / d²),
// so the line keeps ~30 m off a bank where the river allows it. Dry cells
// are passable at a high price (polygon seams under bridges).
function dijkstra(mask, dist, W, H, from, to) {
  const N = W * H, cost = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
  const heap = new Int32Array(N * 4), hk = new Float64Array(N * 4);
  let size = 0;
  const push = (k, c) => {
    let i = size++;
    while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= c) break; heap[i] = heap[p]; hk[i] = hk[p]; i = p; }
    heap[i] = k; hk[i] = c;
  };
  const pop = () => {
    const top = heap[0], last = heap[--size], lc = hk[size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && hk[c + 1] < hk[c]) c++;
      if (hk[c] >= lc) break;
      heap[i] = heap[c]; hk[i] = hk[c]; i = c;
    }
    heap[i] = last; hk[i] = lc;
    return top;
  };
  cost[from] = 0;
  push(from, 0);
  const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];
  while (size) {
    const c0 = hk[0], k = pop();
    if (c0 > cost[k]) continue;
    if (k === to) break;
    const i = k % W, j = (k - i) / W;
    for (let n = 0; n < 8; n++) {
      const ii = i + DI[n], jj = j + DJ[n];
      if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
      const kk = jj * W + ii;
      const d = dist[kk];
      const w = (n < 4 ? 1 : Math.SQRT2) * (mask[kk] ? 1 + 900 / (d * d + 1) : 400);
      const nc = c0 + w;
      if (nc < cost[kk]) { cost[kk] = nc; prev[kk] = k; if (size < heap.length) push(kk, nc); }
    }
  }
  if (!isFinite(cost[to])) return null;
  const out = [];
  for (let k = to; k >= 0; k = prev[k]) out.push(k);
  return out.reverse();
}

function resample(pts, step) {
  const out = [pts[0].slice()];
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const L = Math.hypot(bx - ax, bz - az);
    let s = step - carry;
    while (s <= L) { out.push([ax + ((bx - ax) * s) / L, az + ((bz - az) * s) / L]); s += step; }
    carry = L - (s - step);
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(last[0] - out[out.length - 1][0], last[1] - out[out.length - 1][1]) > step * 0.3) out.push(last.slice());
  return out;
}
