// Sky dome with a cloud layer, sun/moon light with a car-following shadow
// camera, fog and an environment map for reflections. Day / sunset / night
// presets, changed by the weather: cloud cover dims the sun and greys the
// sky, rain, snow and fog close in the fog, lightning lights it all up.

import * as THREE from 'three';
import { globalUniforms } from './materials.js';

const PRESETS = {
  // over*: the sky and fog under full overcast; cloudLit / cloudShade: cloud
  // tops and undersides; grade: saturation, contrast, tint, bloom, bloom threshold.
  day: {
    top: 0x3f7fd0, horizon: 0xc6dbee, bottom: 0x8d8f88, sun: 0xfff1db, sunI: 3.1,
    az: 215, el: 52, hemiSky: 0xc4dcf5, hemiGround: 0x77705f, hemiI: 0.55, env: 0.85,
    fog: 0xc3d6e6, fogNear: 350, fogFar: 3000, night: 0, exposure: 1.0, glow: 0.35, stars: 0,
    overTop: 0x7c8794, overHorizon: 0xa7afb7, overFog: 0xa3abb3, cloudLit: 0xffffff, cloudShade: 0x8d96a1,
    grade: [1.1, 1.06, [1, 1, 1], 0.22, 2.4],
  },
  sunset: {
    top: 0x2c4b85, horizon: 0xf2a066, bottom: 0x4a3f38, sun: 0xffb26e, sunI: 2.6,
    az: 255, el: 9, hemiSky: 0xf2b78c, hemiGround: 0x3d3530, hemiI: 0.5, env: 0.7,
    fog: 0xd9a27f, fogNear: 300, fogFar: 2600, night: 0.25, exposure: 1.05, glow: 1.3, stars: 0,
    overTop: 0x55546a, overHorizon: 0x9a8580, overFog: 0x8f7f7c, cloudLit: 0xffc49a, cloudShade: 0x5e4f58,
    grade: [1.12, 1.05, [1.04, 0.99, 0.94], 0.34, 1.7],
  },
  night: {
    top: 0x03060f, horizon: 0x1a2744, bottom: 0x0b0e14, sun: 0xa8bcff, sunI: 0.55,
    az: 140, el: 38, hemiSky: 0x4a5c8c, hemiGround: 0x1a1a20, hemiI: 1.0, env: 0.45,
    fog: 0x141e33, fogNear: 180, fogFar: 2100, night: 1, exposure: 1.3, glow: 0.12, stars: 1,
    overTop: 0x0b0d13, overHorizon: 0x1d222c, overFog: 0x1b2029, cloudLit: 0x2c3548, cloudShade: 0x0b0e15,
    grade: [0.96, 1.08, [0.95, 0.98, 1.06], 0.45, 1.15],
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
uniform vec3 uTop, uHorizon, uBottom, uSunDir, uSunColor, uCloudLit, uCloudShade;
uniform float uGlow, uStars, uCloud, uFlash, uFogMix;
uniform vec3 uFogColor;
uniform vec2 uCloudOff;
varying vec3 vDir;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHorizon, uBottom, smoothstep(0.0, -0.12, h));
  float s = max(dot(d, uSunDir), 0.0);
  // Clouds on a layer ~1.5 km up, thinning into the haze at the horizon.
  float dens = 0.0;
  if (h > 0.0 && uCloud > 0.01) {
    vec2 cp = d.xz / (h + 0.05) * 1.5 + uCloudOff;
    float n = fbm(cp * 0.55);
    float th = mix(0.78, 0.18, uCloud);
    dens = smoothstep(th, th + 0.28, n) * smoothstep(0.0, 0.16, h);
    dens = max(dens, smoothstep(0.75, 1.0, uCloud) * smoothstep(-0.02, 0.1, h) * 0.85);
    float lit = clamp(0.35 + (n - th) * 1.6, 0.0, 1.0);
    vec3 cc = mix(uCloudShade, uCloudLit, lit * (1.0 - dens * 0.45));
    cc += uSunColor * pow(s, 6.0) * (1.0 - dens) * 0.9;       // silver linings near the sun
    cc += vec3(0.75, 0.8, 1.0) * uFlash * (0.6 + dens);
    col = mix(col, cc, dens);
  }
  float clear = 1.0 - dens * 0.96;
  col += uSunColor * (pow(s, 900.0) * 6.0 * clear + pow(s, 8.0) * uGlow * 0.6 * (1.0 - uCloud * 0.6) + pow(s, 64.0) * 0.6 * clear);
  if (uStars > 0.0 && h > 0.02) {
    vec2 sp = d.xz / (d.y + 0.25) * 260.0;
    vec2 cell = floor(sp);
    float st = step(0.9965, h21(cell));
    float tw = 0.6 + 0.4 * sin(h21(cell + 3.0) * 50.0);
    float dd = length(fract(sp) - 0.5);
    col += vec3(st * tw * smoothstep(0.35, 0.0, dd) * smoothstep(0.02, 0.3, h)) * uStars * clear;
  }
  // Fog, rain and snow haze swallow the sky, most at the horizon.
  col = mix(col, uFogColor, uFogMix * (1.0 - 0.45 * clamp(h, 0.0, 1.0)));
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
      uCloud: { value: 0.2 }, uFlash: { value: 0 }, uCloudOff: { value: new THREE.Vector2() },
      uFogColor: { value: new THREE.Color() }, uFogMix: { value: 0 },
      uCloudLit: { value: new THREE.Color(1, 1, 1) }, uCloudShade: { value: new THREE.Color(0.5, 0.5, 0.5) },
    };
    this.wx = { cloud: 0.2, rain: 0, snow: 0, fog: 0, wind: 0.15, windDir: 0.7, flash: 0, wet: 0, cover: 0 };
    this.alt = 0;
    this.farCap = 8500;      // the furthest the fog lets you see (flying: much further)
    this.cloudFog = 0;       // inside a cloud layer (0..1)
    this.envCloud = -1;
    this.envTime = 0;
    this._c = new THREE.Color();
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
    this.p = p;
    const u = this.uniforms;
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
    globalUniforms.uNight.value = p.night;
    this.isNight = p.night > 0.9;
    this.nightAmount = p.night;
    this.envIntensity = p.env;
    this._applyLight();
    this._buildEnv();
  }

  // Weather (see weather.js state): applied every frame; cheap except for
  // the reflection map, rebuilt now and then as the cloud cover changes.
  setWeather(w, dt) {
    this.wx = w;
    const u = this.uniforms;
    u.uCloud.value = w.cloud;
    u.uFlash.value = w.flash;
    u.uCloudOff.value.x += Math.sin(w.windDir) * (0.02 + w.wind * 0.08) * dt;
    u.uCloudOff.value.y -= Math.cos(w.windDir) * (0.02 + w.wind * 0.08) * dt;
    this._applyLight();
    const now = performance.now();
    if (Math.abs(w.cloud - this.envCloud) > 0.08 && now - this.envTime > 2000) this._buildEnv();
  }

  // Colour grade for the post-processing (see post.js), by time of day and weather.
  look(out) {
    const [sat, con, tint, bloom, thr] = this.p.grade, w = this.wx, u = this.under;
    out.sat = sat * (1 - 0.2 * w.cloud * w.cloud) * (1 - 0.1 * w.fog);
    out.contrast = con * (1 - 0.06 * w.fog - 0.03 * w.rain);
    out.tint.setRGB(tint[0] * (1 - 0.03 * w.rain), tint[1], tint[2] * (1 + 0.04 * w.rain + 0.03 * w.snow));
    out.bloom = u ? 0.4 : bloom + 0.12 * w.rain + 0.1 * w.fog;
    out.threshold = u ? 0.9 : thr * (1 - 0.45 * w.cloud);
    out.flash = w.flash;
    return out;
  }

  // In a tunnel: daylight barely reaches (tunnels and stations have their own
  // lamps) and the distance fades to dark.
  setUnderground(on) {
    if (on === !!this.under) return;
    this.under = on;
    this._applyLight();
  }

  _applyLight() {
    const u = this.under, b = this.lightBase, f = this.fogBase, p = this.p, w = this.wx, U = this.uniforms;
    const over = w.cloud * w.cloud, c = this._c;
    // The sky greys over; the sun goes in.
    U.uTop.value.setHex(p.top).lerp(c.setHex(p.overTop), over * 0.9);
    U.uHorizon.value.setHex(p.horizon).lerp(c.setHex(p.overHorizon), over * 0.9);
    U.uCloudLit.value.setHex(p.cloudLit).multiplyScalar(1 - 0.35 * w.rain);
    U.uCloudShade.value.setHex(p.cloudShade).multiplyScalar(1 - 0.45 * w.rain);
    this.sun.intensity = b.sun * (1 - 0.85 * Math.pow(w.cloud, 1.6)) * (u ? 0.22 : 1);
    this.hemi.intensity = (b.hemi * (1 + 0.45 * w.cloud) + w.flash * 5) * (u ? 0.45 : 1);
    this.scene.environmentIntensity = (this.envIntensity * (1 - 0.3 * w.cloud) + w.flash) * (u ? 0.3 : 1);
    this.renderer.toneMappingExposure = p.exposure * (1 + 0.12 * w.cloud);
    // Fog: greyer and closer in rain, snow and fog; deeper the higher you fly.
    const fog = this.scene.fog, a = this.alt;
    if (u) { fog.color.setHex(0x0b0c0e); fog.near = 90; fog.far = 650; return; }
    fog.color.setHex(f.color).lerp(c.setHex(p.overFog), Math.min(1, over * 0.7 + w.fog * 0.6 + w.snow * 0.3));
    fog.color.lerp(c.setRGB(1, 1, 1), w.flash * 0.25);
    const thin = Math.max(0.07, 1 - 0.45 * w.rain - 0.42 * w.snow - 0.93 * w.fog);
    fog.near = Math.max(2, f.near * Math.max(0.01, 1 - 0.6 * w.rain - 0.5 * w.snow - 0.99 * w.fog)) + a * 1.6 * thin;
    fog.far = Math.min(this.farCap, Math.max(150, f.far * thin) + a * 4 * thin);
    U.uFogMix.value = Math.min(0.97, w.fog * 0.95 + w.rain * 0.35 + w.snow * 0.45) * Math.max(0, 1 - a / 600);
    // Inside a cloud: a grey-white blank a hundred metres deep.
    const cf = this.cloudFog;
    if (cf > 0.001) {
      fog.color.lerp(c.setRGB(0.72, 0.75, 0.8).multiplyScalar(1 - 0.45 * w.rain - 0.6 * p.night), cf);
      fog.near = fog.near * (1 - cf);
      fog.far = fog.far + (110 - fog.far) * cf;
      U.uFogMix.value = Math.max(U.uFogMix.value, cf);
    }
    U.uFogColor.value.copy(fog.color);
  }

  _buildEnv() {
    const envScene = new THREE.Scene();
    const dome = new THREE.Mesh(this.dome.geometry, this.dome.material);
    envScene.add(dome);
    // Reflections without the lightning (it would freeze into the map).
    const flash = this.uniforms.uFlash.value;
    this.uniforms.uFlash.value = 0;
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = this.pmrem.fromScene(envScene, 0.02, 1, 5000);
    this.uniforms.uFlash.value = flash;
    this.scene.environment = this.envTarget.texture;
    this.envCloud = this.wx.cloud;
    this.envTime = performance.now();
  }

  get fogFar() { return this.scene.fog.far; }

  setCloudFog(k) {
    if (Math.abs(k - this.cloudFog) < 0.005) return;
    this.cloudFog = k;
    if (this.fogBase) this._applyLight();
  }

  // See further the higher you fly (altitude in meters; 0 restores the preset).
  setFogBoost(alt) {
    this.alt = Math.max(0, alt);
    if (this.fogBase) this._applyLight();
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
