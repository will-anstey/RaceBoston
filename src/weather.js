// Weather: clear, cloudy, rain, thunderstorm, snow and fog, or Dynamic (it
// changes every few minutes). Conditions blend smoothly; the roads get wet
// over half a minute of rain and take a couple of minutes to dry, and snow
// settles and melts slowly. Rain streaks and snowflakes are drawn around
// the camera on the GPU (one draw each), thunderstorms flash and rumble.
//
// Drives: globalUniforms uWet / uSnow / uRain / uFlash (surfaces, see
// materials.js), the sky (clouds, light, fog), the grade, sound and grip.

import * as THREE from 'three';
import { globalUniforms } from './materials.js';
import { damp } from './util.js';

export const WEATHERS = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'];
export const WEATHER_NAMES = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Thunderstorm', snow: 'Snow', fog: 'Fog' };
// cloud cover, rain, snowfall, fog, wind, lightning
const TYPES = {
  clear: { cloud: 0.2, rain: 0, snow: 0, fog: 0, wind: 0.15, storm: 0 },
  cloudy: { cloud: 0.78, rain: 0, snow: 0, fog: 0.1, wind: 0.35, storm: 0 },
  rain: { cloud: 0.93, rain: 0.55, snow: 0, fog: 0.3, wind: 0.4, storm: 0 },
  storm: { cloud: 1, rain: 1, snow: 0, fog: 0.4, wind: 0.85, storm: 1 },
  snow: { cloud: 0.9, rain: 0, snow: 0.7, fog: 0.4, wind: 0.3, storm: 0 },
  fog: { cloud: 0.6, rain: 0, snow: 0, fog: 1, wind: 0.05, storm: 0 },
};
// Dynamic: how likely each comes next.
const ODDS = { clear: 3, cloudy: 3, rain: 2, storm: 1, snow: 1, fog: 1 };

const precipVert = /* glsl */ `
attribute vec4 aSeed;     // xyz: place in the box, w: per-drop random
attribute vec2 aCorner;   // x: side (-1, 1), y: along the streak (0, 1)
uniform float uTime, uAmount, uBox, uHeight, uLen, uWidth, uSnowy;
uniform vec3 uFall;       // fall direction (wind included)
uniform vec3 uOffset;     // how far the air has carried everything so far
varying float vA;
varying vec2 vC;
void main() {
  vA = 0.0;
  vC = aCorner;
  if (aSeed.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 box = vec3(uBox * 2.0, uHeight, uBox * 2.0);
  vec3 p = aSeed.xyz * box + uOffset * (0.8 + aSeed.w * 0.4);
  // Flakes wander.
  p.x += uSnowy * sin(uTime * (0.7 + aSeed.w) + aSeed.y * 40.0) * 0.6;
  p.z += uSnowy * cos(uTime * (0.6 + aSeed.w) + aSeed.x * 40.0) * 0.6;
  // Wrap into the box around the camera.
  vec3 origin = cameraPosition - vec3(uBox, uHeight * 0.45, uBox);
  p = origin + mod(p - origin, box);
  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  vec3 w;
  if (uSnowy > 0.5) {
    // Round flakes facing the camera.
    vec3 right = normalize(cross(toCam, vec3(0.0, 1.0, 0.0)));
    vec3 up = normalize(cross(right, toCam));
    w = p + (right * aCorner.x + up * (aCorner.y * 2.0 - 1.0)) * uWidth;
  } else {
    // Streaks along the fall, as wide as a drop (a little wider far away).
    vec3 dir = normalize(uFall);
    vec3 side = normalize(cross(dir, toCam));
    w = p + side * aCorner.x * uWidth * (1.0 + dist * 0.015) + dir * (aCorner.y - 0.5) * uLen;
  }
  vA = smoothstep(uBox, uBox * 0.55, dist) * smoothstep(0.4, 2.0, dist);
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;
const precipFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity, uSnowy;
varying float vA;
varying vec2 vC;
void main() {
  float a;
  if (uSnowy > 0.5) a = smoothstep(1.0, 0.3, length(vec2(vC.x, vC.y * 2.0 - 1.0)));
  else a = (1.0 - abs(vC.x)) * smoothstep(0.0, 0.35, vC.y) * smoothstep(1.0, 0.6, vC.y);
  gl_FragColor = vec4(uColor, a * vA * uOpacity);
}`;

function precipMesh(count, snowy) {
  const seed = new Float32Array(count * 16), corner = new Float32Array(count * 8), idx = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const s = [Math.random(), Math.random(), Math.random(), Math.random()];
    const c = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
    for (let k = 0; k < 4; k++) { seed.set(s, (i * 4 + k) * 4); corner.set(c[k], (i * 4 + k) * 2); }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const g = new THREE.BufferGeometry();
  // Positions are computed in the shader; the attribute only sizes the draw.
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 12), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uAmount: { value: 0 }, uBox: { value: snowy ? 22 : 34 }, uHeight: { value: snowy ? 22 : 34 },
      uLen: { value: 0.75 }, uWidth: { value: snowy ? 0.055 : 0.008 }, uSnowy: { value: snowy ? 1 : 0 },
      uFall: { value: new THREE.Vector3(0, -1, 0) }, uOffset: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color(0.7, 0.74, 0.8) }, uOpacity: { value: snowy ? 0.9 : 0.32 },
    },
    vertexShader: precipVert, fragmentShader: precipFrag,
    transparent: true, depthWrite: false, fog: false,
  });
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.renderOrder = 5;
  m.visible = false;
  return m;
}

export class Weather {
  constructor(game) {
    this.g = game;
    this.mode = 'dynamic';
    this.type = 'clear';
    this.cur = { ...TYPES.clear };
    this.wet = 0; this.cover = 0; this.flash = 0;
    this.windDir = Math.random() * Math.PI * 2;
    this.nextChange = 150;
    this.nextBolt = 8;
    this.flashes = [];
    this.thunder = [];
    this.rate = 0.06;
    this.density = 1;          // share of drops drawn (graphics quality)
    this.onChange = null;      // (type) => {} when Dynamic moves on
    this.rain = precipMesh(16000, false);
    this.snow = precipMesh(12000, true);
    game.scene.add(this.rain, this.snow);
  }

  // 'dynamic' or one of WEATHERS; instant skips the blend (menus, tests).
  setMode(mode, instant = false) {
    this.mode = mode;
    if (mode !== 'dynamic') this.setType(mode, instant);
    else { this.nextChange = 150 + Math.random() * 150; this.rate = 0.06; }
  }

  setType(type, instant = false) {
    this.type = TYPES[type] ? type : 'clear';
    this.rate = instant ? 1e6 : 0.25;
    if (instant) {
      Object.assign(this.cur, TYPES[this.type]);
      this.wet = this.cur.rain > 0 ? 1 : 0;
      this.cover = this.cur.snow > 0 ? 1 : 0;
    }
  }

  // How much grip the tyres have: less on wet roads, a lot less on snow.
  get grip() { return 1 - 0.16 * this.wet - 0.38 * this.cover; }
  // Dark enough for headlights.
  get gloomy() { return Math.max(this.cur.rain, this.cur.snow, this.cur.fog * 0.8, (this.cur.cloud - 0.7) * 2) > 0.45; }

  update(dt, camera, underground) {
    // Dynamic: on to something else every few minutes.
    if (this.mode === 'dynamic') {
      this.nextChange -= dt;
      if (this.nextChange <= 0) {
        this.nextChange = 150 + Math.random() * 180;
        let r = Math.random() * Object.values(ODDS).reduce((a, b) => a + b, 0);
        for (const [k, w] of Object.entries(ODDS)) {
          if ((r -= w) < 0) { if (k !== this.type) { this.setType(k); if (this.onChange) this.onChange(k); } break; }
        }
        this.rate = 0.06;
      }
    }
    const t = TYPES[this.type], c = this.cur, k = Math.min(1, damp(this.rate, dt));
    for (const key in t) c[key] += (t[key] - c[key]) * k;
    // Surfaces: wet in ~30 s of rain, dry in ~2 min; snow settles in a minute, melts in three (faster in rain).
    if (c.rain > 0.05) this.wet = Math.min(1, this.wet + dt * c.rain / 20);
    else this.wet = Math.max(0, this.wet - dt / 120);
    if (c.snow > 0.05) this.cover = Math.min(1, this.cover + dt * c.snow / 45);
    else this.cover = Math.max(0, this.cover - dt * (1 + c.rain * 3) / 180);
    if (this.cover > 0.2) this.wet = Math.max(this.wet, this.cover * 0.5);
    this.windDir += (Math.random() - 0.5) * dt * 0.05;
    this.lightning(dt, c.storm);
    const U = globalUniforms;
    U.uWet.value = this.wet; U.uSnow.value = this.cover; U.uRain.value = c.rain; U.uFlash.value = this.flash;
    // Precipitation around the camera (none in tunnels).
    const time = performance.now() / 1000, night = U.uNight.value;
    const wx = Math.sin(this.windDir) * c.wind, wz = -Math.cos(this.windDir) * c.wind;
    const light = (0.62 - night * 0.45) + this.flash * 2.5;
    for (const [m, amount, fall, wind] of [[this.rain, c.rain, 9.5, 5], [this.snow, c.snow, 1.3, 2.2]]) {
      m.visible = amount > 0.01 && !underground;
      const u = m.material.uniforms;
      u.uTime.value = time;
      u.uAmount.value = amount * this.density;
      u.uFall.value.set(wx * wind, -fall, wz * wind);
      if (m.visible) u.uOffset.value.addScaledVector(u.uFall.value, dt);
      u.uColor.value.setRGB(light, light * 1.04, light * 1.12);
    }
  }

  // Thunderstorms: flashes (a few flickers each), thunder a moment later.
  lightning(dt, storm) {
    this.flash = 0;
    const now = performance.now() / 1000;
    if (storm > 0.5) {
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.nextBolt = 6 + Math.random() * 16;
        const dist = 0.3 + Math.random() * 0.7;
        for (let i = 0, t = now; i < 2 + Math.floor(Math.random() * 3); i++, t += 0.06 + Math.random() * 0.16) this.flashes.push([t, 0.6 + Math.random() * 0.4 * (1.2 - dist)]);
        this.thunder.push([now + dist * 3.5, 1.1 - dist * 0.6]);
      }
    }
    this.flashes = this.flashes.filter(([t]) => now - t < 0.25);
    for (const [t, s] of this.flashes) if (now >= t) this.flash = Math.max(this.flash, s * Math.exp(-(now - t) * 18));
    while (this.thunder.length && this.thunder[0][0] <= now) {
      const [, s] = this.thunder.shift();
      this.g.audio.thunder(s);
    }
  }

  // Values the sky, grade and sound use.
  get state() {
    const c = this.cur;
    return { cloud: c.cloud, rain: c.rain, snow: c.snow, fog: c.fog, wind: c.wind, windDir: this.windDir, flash: this.flash, wet: this.wet, cover: this.cover };
  }
}
