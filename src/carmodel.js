// Procedural low-poly vehicle models. Cars face -z; +x is the right side.

import * as THREE from 'three';

// Side profiles: [forward s, height y] polygons (front is +s).
export const VEHICLES = {
  coupe: {
    label: 'Coupe', L: 4.5, W: 1.9,
    body: [[-2.22, 0.3], [-2.26, 0.62], [-2.16, 0.86], [-1.15, 0.93], [0.95, 0.9], [2.05, 0.72], [2.26, 0.5], [2.2, 0.3]],
    cabin: [[-1.42, 0.92], [-0.62, 1.27], [0.32, 1.29], [1.02, 0.9]],
    wheelR: 0.35, axles: [1.36, -1.34], track: 1.64, light: 0.62, tail: 0.74,
  },
  sedan: {
    label: 'Sedan', L: 4.65, W: 1.84,
    body: [[-2.3, 0.32], [-2.34, 0.7], [-2.24, 0.98], [-1.32, 1.02], [1.12, 1.0], [2.2, 0.84], [2.33, 0.6], [2.28, 0.32]],
    cabin: [[-1.38, 1.0], [-0.86, 1.46], [0.42, 1.48], [1.12, 1.0]],
    wheelR: 0.34, axles: [1.42, -1.38], track: 1.58, light: 0.7, tail: 0.86,
  },
  hatch: {
    label: 'Hatchback', L: 4.0, W: 1.76,
    body: [[-1.96, 0.32], [-2.0, 0.72], [-1.95, 1.0], [0.95, 1.0], [1.82, 0.84], [1.99, 0.6], [1.95, 0.32]],
    cabin: [[-1.93, 1.0], [-1.78, 1.5], [0.32, 1.52], [0.97, 1.0]],
    wheelR: 0.32, axles: [1.25, -1.25], track: 1.52, light: 0.7, tail: 0.9,
  },
  suv: {
    label: 'SUV', L: 4.8, W: 1.96,
    body: [[-2.36, 0.44], [-2.4, 0.92], [-2.34, 1.2], [1.28, 1.18], [2.22, 1.04], [2.4, 0.76], [2.35, 0.44]],
    cabin: [[-2.3, 1.18], [-2.18, 1.84], [0.62, 1.86], [1.3, 1.18]],
    wheelR: 0.4, axles: [1.48, -1.42], track: 1.66, light: 0.88, tail: 1.02,
  },
  pickup: {
    label: 'Pickup', L: 5.3, W: 2.0,
    body: [[-2.62, 0.48], [-2.66, 1.1], [-0.6, 1.12], [-0.55, 1.2], [1.2, 1.2], [2.35, 1.08], [2.62, 0.8], [2.58, 0.48]],
    cabin: [[-0.58, 1.18], [-0.48, 1.86], [0.68, 1.88], [1.28, 1.18]],
    wheelR: 0.42, axles: [1.62, -1.68], track: 1.7, light: 0.92, tail: 0.95, bed: true,
  },
  van: {
    label: 'Box truck', L: 6.6, W: 2.24,
    body: [[-3.3, 0.5], [-3.3, 1.1], [2.3, 1.1], [3.05, 1.02], [3.3, 0.72], [3.24, 0.5]],
    cabin: [[1.32, 1.1], [1.45, 2.3], [2.25, 2.25], [3.0, 1.16]],
    box: [-3.3, 1.32, 1.05, 3.1],
    wheelR: 0.45, axles: [2.35, -1.95], track: 1.86, light: 0.86, tail: 0.95,
  },
  bus: {
    label: 'Bus', L: 12.2, W: 2.55,
    body: [[-6.1, 0.42], [-6.1, 3.0], [5.95, 3.05], [6.1, 2.8], [6.1, 0.42]],
    windows: [-5.6, 5.9, 1.45, 2.65],
    wheelR: 0.5, axles: [3.9, -3.3], track: 2.1, light: 0.85, tail: 1.0,
  },
};
VEHICLES.taxi = { ...VEHICLES.sedan, label: 'Taxi', sign: true };
VEHICLES.police = { ...VEHICLES.sedan, label: 'Police', lightbar: true };

const geoCache = new Map();
const matCache = new Map();

function profileGeometry(profile, width, bevel = 0.07) {
  const shape = new THREE.Shape();
  profile.forEach(([s, y], i) => (i ? shape.lineTo(s, y) : shape.moveTo(s, y)));
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.1, width - 2 * bevel), bevelEnabled: bevel > 0,
    bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 2, curveSegments: 1,
  });
  // shape x = forward -> world -z ; extrude z -> world x
  g.rotateY(Math.PI / 2);
  g.translate(-(width - 2 * bevel) / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function colorize(g, hex) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[3 * i] = c.r; arr[3 * i + 1] = c.g; arr[3 * i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

// Merge non-indexed copies of geometries (position/normal/color only).
function merge(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let n = 0;
  for (const g of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
  const hasColor = parts.every((g) => g.attributes.color);
  const col = hasColor ? new Float32Array(n * 3) : null;
  let o = 0;
  for (const g of parts) {
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3);
    nrm.set(g.attributes.normal.array, o * 3);
    if (col) col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

function wheelGeometry(r) {
  const tire = new THREE.CylinderGeometry(r, r, 0.26, 16);
  tire.rotateZ(Math.PI / 2);
  colorize(tire, 0x161616);
  const hub = new THREE.CylinderGeometry(r * 0.62, r * 0.62, 0.27, 10);
  hub.rotateZ(Math.PI / 2);
  colorize(hub, 0xb9bcc0);
  const spoke = box(0.275, r * 0.18, r * 1.1, 0, 0, 0);
  colorize(spoke, 0x55585c);
  const spoke2 = box(0.275, r * 1.1, r * 0.18, 0, 0, 0);
  colorize(spoke2, 0x55585c);
  return merge([tire, hub, spoke, spoke2]);
}

// Returns cached geometries for a vehicle type.
function geometries(type) {
  if (geoCache.has(type)) return geoCache.get(type);
  const v = VEHICLES[type];
  const W = v.W;
  const paint = [];
  const glass = [];
  const detail = [];
  const lights = { head: [], tail: [] };
  if (type === 'bus') {
    paint.push(profileGeometry(v.body, W, 0.08));
    const [s0, s1, y0, y1] = v.windows;
    glass.push(box(W + 0.02, y1 - y0, s1 - s0, 0, (y0 + y1) / 2, -(s0 + s1) / 2));
    glass.push(box(W * 0.9, 1.25, 0.06, 0, 2.05, -6.12));
  } else {
    paint.push(profileGeometry(v.body, W));
    if (v.cabin) {
      const cab = profileGeometry(v.cabin, W - 0.22, 0.05);
      glass.push(cab);
      // roof panel
      const [, , r1, r2] = [0, 0, v.cabin[1], v.cabin[2]];
      const rl = r2[0] - r1[0];
      paint.push(box(W - 0.2, 0.06, rl + 0.08, 0, Math.max(r1[1], r2[1]) + 0.02, -(r1[0] + r2[0]) / 2));
    }
    if (v.box) {
      const [s0, y0, s1, y1] = v.box;
      const g = box(W + 0.05, y1 - y0, s1 - s0, 0, (y0 + y1) / 2, -(s0 + s1) / 2);
      colorize(g, 0xeeeeea);
      detail.push(g);
    }
    if (v.bed) {
      // open bed walls
      for (const sx of [-1, 1]) detail.push(colorize(box(0.08, 0.35, 2.0, sx * (W / 2 - 0.06), 1.28, 1.6), 0x222222));
    }
  }
  const front = v.L / 2, rear = -v.L / 2;
  // bumpers + grille
  detail.push(colorize(box(W * 0.96, 0.2, 0.16, 0, v.light - 0.28, -front - 0.02), 0x1e1f22));
  detail.push(colorize(box(W * 0.96, 0.2, 0.16, 0, v.tail - 0.36, -rear + 0.02), 0x1e1f22));
  detail.push(colorize(box(W * 0.5, 0.14, 0.05, 0, v.light - 0.02, -front - 0.01), 0x101114));
  // mirrors
  if (type !== 'bus') {
    const my = v.cabin ? v.cabin[0][1] + 0.12 : 1.2;
    const ms = v.cabin ? -(v.cabin[3][0] - 0.15) : -front + 1;
    for (const sx of [-1, 1]) detail.push(colorize(box(0.2, 0.12, 0.1, sx * (W / 2 + 0.08), my, ms), 0x1e1f22));
  }
  if (v.sign) detail.push(colorize(box(0.75, 0.24, 0.3, 0, v.cabin[1][1] + 0.16, -(v.cabin[1][0] + v.cabin[2][0]) / 2), 0xfff7cf));
  if (v.lightbar) {
    const y = v.cabin[1][1] + 0.1, s = -(v.cabin[1][0] + v.cabin[2][0]) / 2;
    detail.push(colorize(box(0.6, 0.12, 0.26, -0.32, y, s), 0xd0262d));
    detail.push(colorize(box(0.6, 0.12, 0.26, 0.32, y, s), 0x2050d8));
  }
  // lights
  for (const sx of [-1, 1]) {
    lights.head.push(box(0.36, 0.13, 0.06, sx * (W / 2 - 0.3), v.light, -front - 0.01));
    lights.tail.push(box(0.36, 0.12, 0.06, sx * (W / 2 - 0.28), v.tail, -rear + 0.01));
  }
  const wheel = wheelGeometry(v.wheelR);
  const wheels = [];
  for (const s of v.axles) for (const sx of [-1, 1]) wheels.push([sx * v.track / 2, v.wheelR, -s, s > 0]);
  const g = {
    paint: merge(paint.map((p) => p.index ? p.toNonIndexed() : p)),
    glass: merge(glass),
    detail: merge(detail),
    head: merge(lights.head),
    tail: merge(lights.tail),
    wheel,
    wheels,
  };
  // Static version with wheels baked in (for traffic).
  const baked = wheels.map(([x, y, z]) => wheel.clone().translate(x, y, z));
  g.detailStatic = merge([g.detail, ...baked]);
  geoCache.set(type, g);
  return g;
}

function material(key, make) {
  if (!matCache.has(key)) matCache.set(key, make());
  return matCache.get(key);
}

export function paintMaterial(hex) {
  return material('paint:' + hex, () => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.32, metalness: 0.55, envMapIntensity: 1.2 }));
}
const glassMat = () => material('glass', () => new THREE.MeshStandardMaterial({ color: 0x1a222c, roughness: 0.06, metalness: 0.5, envMapIntensity: 1.4 }));
const detailMat = () => material('detail', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 }));
const sharedHead = () => material('head', () => new THREE.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xfff1d0, emissiveIntensity: 0.6, roughness: 0.2 }));
const sharedTail = () => material('tail', () => new THREE.MeshStandardMaterial({ color: 0x5a0a0a, emissive: 0xff1a10, emissiveIntensity: 0.5, roughness: 0.3 }));

// Full model for the player: separate wheels and own light materials.
export function buildPlayerCar(type, color) {
  const g = geometries(type);
  const v = VEHICLES[type];
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0.6, envMapIntensity: 1.3 });
  const head = sharedHead().clone();
  const tail = sharedTail().clone();
  const meshes = [
    new THREE.Mesh(g.paint, paint), new THREE.Mesh(g.glass, glassMat()), new THREE.Mesh(g.detail, detailMat()),
    new THREE.Mesh(g.head, head), new THREE.Mesh(g.tail, tail),
  ];
  for (const m of meshes) { m.castShadow = true; m.receiveShadow = true; body.add(m); }
  const wheels = g.wheels.map(([x, y, z, front]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, z);
    const w = new THREE.Mesh(g.wheel, detailMat());
    w.castShadow = true;
    pivot.add(w);
    root.add(pivot);
    return { pivot, mesh: w, front };
  });
  return { root, body, wheels, paint, head, tail, spec: v };
}

// Cheap model for traffic: 3 draw calls, shared materials.
export function buildTrafficCar(type, color) {
  const g = geometries(type);
  const root = new THREE.Group();
  const m1 = new THREE.Mesh(g.paint, paintMaterial(color));
  const m2 = new THREE.Mesh(g.glass, glassMat());
  const m3 = new THREE.Mesh(g.detailStatic, detailMat());
  const m4 = new THREE.Mesh(g.tail, sharedTail());
  const m5 = new THREE.Mesh(g.head, sharedHead());
  m1.castShadow = true;
  m3.castShadow = true;
  root.add(m1, m2, m3, m4, m5);
  return { root, spec: VEHICLES[type] };
}

export function setNightLights(night) {
  const h = sharedHead(), t = sharedTail();
  h.emissiveIntensity = night ? 3.0 : 0.6;
  t.emissiveIntensity = night ? 1.6 : 0.5;
}
