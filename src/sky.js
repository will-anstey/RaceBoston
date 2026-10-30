// Sky dome, sun/moon light with a car-following shadow camera, fog and an
// environment map for reflections. Supports day / sunset / night presets.

import * as THREE from 'three';
import { globalUniforms } from './materials.js';

const PRESETS = {
  day: {
    top: 0x3f7fd0, horizon: 0xc6dbee, bottom: 0x8d8f88, sun: 0xfff1db, sunI: 3.1,
    az: 215, el: 52, hemiSky: 0xc4dcf5, hemiGround: 0x77705f, hemiI: 0.55, env: 0.85,
    fog: 0xc3d6e6, fogNear: 350, fogFar: 3000, night: 0, exposure: 1.0, glow: 0.35, stars: 0,
  },
  sunset: {
    top: 0x2c4b85, horizon: 0xf2a066, bottom: 0x4a3f38, sun: 0xffb26e, sunI: 2.6,
    az: 255, el: 9, hemiSky: 0xf2b78c, hemiGround: 0x3d3530, hemiI: 0.5, env: 0.7,
    fog: 0xd9a27f, fogNear: 300, fogFar: 2600, night: 0.25, exposure: 1.05, glow: 1.3, stars: 0,
  },
  night: {
    top: 0x03060f, horizon: 0x1a2744, bottom: 0x0b0e14, sun: 0xa8bcff, sunI: 0.55,
    az: 140, el: 38, hemiSky: 0x4a5c8c, hemiGround: 0x1a1a20, hemiI: 1.0, env: 0.45,
    fog: 0x141e33, fogNear: 180, fogFar: 2100, night: 1, exposure: 1.3, glow: 0.12, stars: 1,
  },
};
export const PRESET_NAMES = Object.keys(PRESETS);

const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const skyFrag = /* glsl */ `
uniform vec3 uTop, uHorizon, uBottom, uSunDir, uSunColor;
uniform float uGlow, uStars;
varying vec3 vDir;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHorizon, uBottom, smoothstep(0.0, -0.12, h));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 900.0) * 6.0 + pow(s, 8.0) * uGlow * 0.6 + pow(s, 64.0) * 0.6);
  if (uStars > 0.0 && h > 0.02) {
    vec2 sp = d.xz / (d.y + 0.25) * 260.0;
    vec2 cell = floor(sp);
    float st = step(0.9965, h21(cell));
    float tw = 0.6 + 0.4 * sin(h21(cell + 3.0) * 50.0);
    float dd = length(fract(sp) - 0.5);
    col += vec3(st * tw * smoothstep(0.35, 0.0, dd) * smoothstep(0.02, 0.3, h)) * uStars;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Sky {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.uniforms = {
      uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uBottom: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() },
      uGlow: { value: 0.3 }, uStars: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: skyVert, fragmentShader: skyFrag,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(3000, 48, 24), mat);
    this.dome.renderOrder = -100;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.shadowExtent = 120;
    this.setShadowQuality(2048);
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.5);
    scene.add(this.hemi);
    scene.fog = new THREE.Fog(0xcccccc, 300, 3000);

    this.sunDir = new THREE.Vector3();
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envTarget = null;
    this.preset = null;
  }

  setShadowQuality(size) {
    const s = this.sun.shadow;
    this.sun.castShadow = size > 0;
    if (!size) return;
    if (s.map) { s.map.dispose(); s.map = null; }
    s.mapSize.set(size, size);
    const e = this.shadowExtent;
    Object.assign(s.camera, { left: -e, right: e, top: e, bottom: -e, near: 1, far: 1400 });
    s.camera.updateProjectionMatrix();
    s.bias = -0.0004;
    s.normalBias = 0.45;
  }

  setPreset(name) {
    const p = PRESETS[name] || PRESETS.day;
    this.preset = name;
    const u = this.uniforms;
    u.uTop.value.setHex(p.top);
    u.uHorizon.value.setHex(p.horizon);
    u.uBottom.value.setHex(p.bottom);
    u.uSunColor.value.setHex(p.sun);
    u.uGlow.value = p.glow;
    u.uStars.value = p.stars;
    const az = THREE.MathUtils.degToRad(p.az), el = THREE.MathUtils.degToRad(p.el);
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    u.uSunDir.value.copy(this.sunDir);
    this.sun.color.setHex(p.sun);
    this.hemi.color.setHex(p.hemiSky);
    this.hemi.groundColor.setHex(p.hemiGround);
    this.fogBase = { near: p.fogNear, far: p.fogFar, color: p.fog };
    this.lightBase = { sun: p.sunI, hemi: p.hemiI };
    this.renderer.toneMappingExposure = p.exposure;
    globalUniforms.uNight.value = p.night;
    this.isNight = p.night > 0.9;
    this.nightAmount = p.night;
    this.envIntensity = p.env;
    this._buildEnv();
    this._applyLight();
  }

  // In a tunnel: daylight barely reaches (tunnels and stations have their own
  // lamps) and the distance fades to dark.
  setUnderground(on) {
    if (on === !!this.under) return;
    this.under = on;
    this._applyLight();
  }

  _applyLight() {
    const u = this.under, b = this.lightBase, f = this.fogBase;
    this.sun.intensity = b.sun * (u ? 0.22 : 1);
    this.hemi.intensity = b.hemi * (u ? 0.45 : 1);
    this.scene.environmentIntensity = this.envIntensity * (u ? 0.3 : 1);
    this.scene.fog.color.setHex(u ? 0x0b0c0e : f.color);
    this.scene.fog.near = u ? 90 : f.near;
    this.scene.fog.far = u ? 650 : f.far;
  }

  _buildEnv() {
    const envScene = new THREE.Scene();
    const dome = new THREE.Mesh(this.dome.geometry, this.dome.material);
    envScene.add(dome);
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = this.pmrem.fromScene(envScene, 0.02, 1, 5000);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = this.envIntensity;
  }

  get fogFar() { return this.scene.fog.far; }

  // See further the higher you fly (altitude in meters; 0 restores the preset).
  setFogBoost(alt) {
    if (!this.fogBase || this.under) return;
    const a = Math.max(0, alt);
    this.scene.fog.near = this.fogBase.near + a * 1.6;
    this.scene.fog.far = Math.min(8500, this.fogBase.far + a * 4);
  }

  // Keep the dome around the camera and the shadow box around the focus.
  update(camera, focus) {
    this.dome.position.copy(camera.position);
    const e = this.shadowExtent;
    const texel = (2 * e) / this.sun.shadow.mapSize.x;
    const d = this.sunDir;
    const fwd = _v1.copy(d).negate();
    const right = _v2.crossVectors(fwd, _up).normalize();
    const upL = _v3.crossVectors(right, fwd);
    let x = focus.dot(right), y = focus.dot(upL);
    const z = focus.dot(fwd);
    x = Math.round(x / texel) * texel;
    y = Math.round(y / texel) * texel;
    const snapped = _v4.set(0, 0, 0).addScaledVector(right, x).addScaledVector(upL, y).addScaledVector(fwd, z);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(d, 700);
    this.sun.target.updateMatrixWorld();
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
