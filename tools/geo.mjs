// Geometry helpers shared by the map build tools. All 2D points are [x, z]
// in meters (+x east, +z south). "Outer" rings are stored with negative
// signed area in x/z space (counter-clockwise when viewed on a north-up map).

export function signedAreaXZ(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function orientOuter(ring) {
  return signedAreaXZ(ring) > 0 ? ring.slice().reverse() : ring;
}

export function orientHole(ring) {
  return signedAreaXZ(ring) < 0 ? ring.slice().reverse() : ring;
}

export function dropClosingPoint(ring) {
  if (ring.length > 1) {
    const a = ring[0], b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring;
}

function perpDist(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

// Douglas-Peucker on an open polyline.
export function simplifyLine(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// Simplify a closed ring (no repeated closing point).
export function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring.slice();
  const closed = ring.concat([ring[0]]);
  const s = simplifyLine(closed, tol);
  s.pop();
  return s.length >= 3 ? s : ring.slice();
}

// Sutherland-Hodgman clip of a ring against an axis-aligned rectangle.
export function clipRing(ring, b) {
  const edges = [
    (p) => p[0] >= b.minX, (p) => p[0] <= b.maxX,
    (p) => p[1] >= b.minZ, (p) => p[1] <= b.maxZ,
  ];
  const isect = [
    (p, q) => lerpAt(p, q, 0, b.minX), (p, q) => lerpAt(p, q, 0, b.maxX),
    (p, q) => lerpAt(p, q, 1, b.minZ), (p, q) => lerpAt(p, q, 1, b.maxZ),
  ];
  let out = ring;
  for (let e = 0; e < 4 && out.length; e++) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      const cIn = edges[e](cur), pIn = edges[e](prev);
      if (cIn) {
        if (!pIn) out.push(isect[e](prev, cur));
        out.push(cur);
      } else if (pIn) {
        out.push(isect[e](prev, cur));
      }
    }
  }
  return out;
}

function lerpAt(p, q, axis, v) {
  const t = (v - p[axis]) / (q[axis] - p[axis]);
  const r = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  r[axis] = v;
  return r;
}

export function ringBBox(ring) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

export function bboxOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Even-odd test against a polygon given as [outer, ...holes].
export function pointInPolygon(x, z, rings) {
  let inside = false;
  for (const r of rings) if (pointInRing(x, z, r)) inside = !inside;
  return inside;
}

export function centroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f; cx += (p[0] + q[0]) * f; cz += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0, sz = 0;
    for (const p of ring) { sx += p[0]; sz += p[1]; }
    return [sx / ring.length, sz / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

// Join open way fragments (arrays of points with string keys) into closed rings.
export function assembleRings(fragments, keyOf) {
  const open = fragments.filter((f) => f.length >= 2).map((f) => f.slice());
  const rings = [];
  while (open.length) {
    let cur = open.pop();
    let guard = 0;
    while (keyOf(cur[0]) !== keyOf(cur[cur.length - 1]) && guard++ < 10000) {
      const endKey = keyOf(cur[cur.length - 1]);
      let found = -1, rev = false;
      for (let i = 0; i < open.length; i++) {
        if (keyOf(open[i][0]) === endKey) { found = i; break; }
        if (keyOf(open[i][open[i].length - 1]) === endKey) { found = i; rev = true; break; }
      }
      if (found < 0) break;
      const seg = open.splice(found, 1)[0];
      if (rev) seg.reverse();
      cur = cur.concat(seg.slice(1));
    }
    if (keyOf(cur[0]) === keyOf(cur[cur.length - 1])) cur.pop();
    if (cur.length >= 3) rings.push(cur);
  }
  return rings;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash32(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
