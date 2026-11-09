// Visual effects: tyre skid marks (ring buffer of instanced quads), spray
// off wet tyres, and headlight beams that show in rain, snow and fog.

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

// Spray thrown up behind the rear wheels on a wet road: a pool of soft
// particles (one draw), simulated on the CPU.
export class TyreSpray {
  constructor(scene, count = 420) {
    this.n = count;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.age = new Float32Array(count).fill(9);
    this.life = new Float32Array(count).fill(1);
    this.alpha = new Float32Array(count);
    this.size = new Float32Array(count);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uColor: { value: new THREE.Color(0.75, 0.78, 0.82) } },
      vertexShader: /* glsl */ `
        attribute float aAlpha, aSize;
        uniform float uScale;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vA = aAlpha;
          gl_PointSize = aAlpha > 0.0 ? clamp(aSize * uScale / -mv.z, 1.0, 160.0) : 0.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vA;
        void main() {
          float r = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(uColor, smoothstep(0.5, 0.05, r) * vA);
        }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    scene.add(this.points);
    this.next = 0;
    this.carry = 0;
  }

  // wet: road wetness 0..1; light: brightness of the air (dark at night).
  update(dt, car, wet, onRoad, light, camera) {
    const emitting = onRoad && !car.airborne && wet > 0.25 && car.speed > 7;
    this.carry += emitting ? dt * Math.min(1, (car.speed - 7) / 30) * wet * 200 : 0;
    const fx = car.fx, fz = car.fz, rx = -fz, rz = fx, back = car.h.circles[0] * 0.95;
    while (this.carry >= 1) {
      this.carry -= 1;
      const i = this.next, side = i % 2 ? 0.8 : -0.8;
      this.next = (this.next + 1) % this.n;
      this.pos[3 * i] = car.x + fx * back + rx * side;
      this.pos[3 * i + 1] = car.y + 0.25;
      this.pos[3 * i + 2] = car.z + fz * back + rz * side;
      const k = 0.25 + Math.random() * 0.35, spread = (Math.random() - 0.5) * 3 + side * 1.5;
      this.vel[3 * i] = car.vx * k + rx * spread;
      this.vel[3 * i + 1] = 1.2 + Math.random() * 2.2;
      this.vel[3 * i + 2] = car.vz * k + rz * spread;
      this.age[i] = 0;
      this.life[i] = 0.5 + Math.random() * 0.5;
    }
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (this.age[i] >= this.life[i]) { this.alpha[i] = 0; continue; }
      any = true;
      const a = (this.age[i] += dt), t = a / this.life[i];
      const drag = Math.exp(-3 * dt);
      this.vel[3 * i] *= drag; this.vel[3 * i + 2] *= drag;
      this.vel[3 * i + 1] -= 6 * dt;
      this.pos[3 * i] += this.vel[3 * i] * dt;
      this.pos[3 * i + 1] += this.vel[3 * i + 1] * dt;
      this.pos[3 * i + 2] += this.vel[3 * i + 2] * dt;
      this.alpha[i] = 0.1 * (1 - t) * Math.min(1, t * 6);
      this.size[i] = 0.3 + t * 1.0;
    }
    this.points.visible = any;
    if (!any) return;
    this.mat.uniforms.uColor.value.setRGB(light, light * 1.02, light * 1.06);
    this.mat.uniforms.uScale.value = camera ? (innerHeight * camera.projectionMatrix.elements[5]) / 2 : 600;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }
}

// Soft light cones in front of the car: visible in the air when there's
// rain, snow or fog to catch the light (and faintly on a clear night).
export class HeadlightBeams {
  constructor(scene) {
    const len = 30;
    const g = new THREE.ConeGeometry(4.2, len, 24, 1, true);
    g.translate(0, -len / 2, 0);     // apex at the lamp
    g.rotateX(Math.PI / 2 - 0.05);    // pointing ahead (-z), dipped a little
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0 }, uLen: { value: len } },
      vertexShader: /* glsl */ `
        varying float vAlong;
        varying vec3 vN, vV;
        void main() {
          vAlong = clamp(-position.z / 30.0, 0.0, 1.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uStrength;
        varying float vAlong;
        varying vec3 vN, vV;
        void main() {
          float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
          // max(): interpolation can nudge vAlong past 1, and pow() of a negative is NaN.
          float a = uStrength * edge * pow(max(1.0 - vAlong, 0.0), 1.4) * smoothstep(0.0, 0.06, vAlong);
          gl_FragColor = vec4(vec3(1.0, 0.95, 0.85) * a, 1.0);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    this.group = new THREE.Group();
    for (const x of [-0.6, 0.6]) {
      const m = new THREE.Mesh(g, this.mat);
      m.position.x = x;
      m.frustumCulled = false;
      m.renderOrder = 6;
      this.group.add(m);
    }
    this.group.visible = false;
    scene.add(this.group);
  }

  update(car, strength) {
    this.group.visible = strength > 0.005;
    if (!this.group.visible) return;
    this.mat.uniforms.uStrength.value = strength;
    this.group.position.set(car.x + car.fx * 2.3, car.y + 0.7, car.z + car.fz * 2.3);
    this.group.rotation.set(0, -car.heading, 0, 'YXZ');
  }
}
