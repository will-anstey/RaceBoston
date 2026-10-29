// Visual effects: tyre skid marks (ring buffer of instanced quads).

import * as THREE from 'three';

export class SkidMarks {
  constructor(scene, count = 900) {
    const g = new THREE.PlaneGeometry(0.24, 1);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ color: 0x0d0d0f, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
    this.mesh = new THREE.InstancedMesh(g, m, count);
    this.mesh.count = 0;
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.n = count;
    this.i = 0;
    this.last = [null, null];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  clear() { this.mesh.count = 0; this.i = 0; this.last = [null, null]; }

  update(car, onRoad) {
    const active = car.skid > 0.35 && car.speed > 4 && onRoad;
    if (!active) { this.last[0] = this.last[1] = null; return; }
    const fx = car.fx, fz = car.fz, rx = -fz, rz = fx;
    const back = car.h.circles[0] * 0.9;
    for (let w = 0; w < 2; w++) {
      const side = w ? 0.78 : -0.78;
      const x = car.x + fx * back + rx * side, z = car.z + fz * back + rz * side;
      const prev = this.last[w];
      if (prev) {
        const dx = x - prev[0], dz = z - prev[1];
        const L = Math.hypot(dx, dz);
        if (L < 0.4) continue;
        if (L < 6) {
          this._q.setFromAxisAngle(this._up, Math.atan2(dx, dz));
          this._m.compose(this._p.set((x + prev[0]) / 2, car.y + (car.onDeck ? 0.08 : 0.03), (z + prev[1]) / 2), this._q, this._s.set(1, 1, L + 0.05));
          this.mesh.setMatrixAt(this.i, this._m);
          this.i = (this.i + 1) % this.n;
          this.mesh.count = Math.max(this.mesh.count, this.i === 0 ? this.n : this.i);
          this.mesh.instanceMatrix.needsUpdate = true;
        }
      }
      this.last[w] = [x, z];
    }
  }
}
