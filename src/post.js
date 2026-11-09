// Post-processing: the scene renders into a multisampled HDR target (with a
// stencil buffer, for the ground mask), then bloom on the bright lights, a
// grade pass (contrast and colour by time of day and weather, vignette, rain
// on the lens, a little chromatic aberration at speed, the lightning flash,
// film grain), ACES tone mapping to the screen, and FXAA where there's no MSAA.
// Off on Low quality: the scene renders straight to the screen as before.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { damp } from './util.js';

const GradeShader = {
  name: 'RBGradeShader',
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uSat: { value: 1 }, uContrast: { value: 1 }, uTint: { value: new THREE.Color(1, 1, 1) },
    uVignette: { value: 0.35 }, uAberr: { value: 0 }, uLens: { value: 0 }, uFlash: { value: 0 }, uGrain: { value: 0.02 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uTime, uSat, uContrast, uVignette, uAberr, uLens, uFlash, uGrain;
    uniform vec3 uTint;
    varying vec2 vUv;
    float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    // One layer of raindrops on the lens: a refraction offset (xy) and coverage (z).
    vec3 drops(vec2 uv, float cells, float t, float seed) {
      vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
      vec2 p = uv * aspect * cells;
      vec2 id = floor(p), f = fract(p) - 0.5;
      float n = h21(id + seed);
      if (n > uLens) return vec3(0.0);
      float life = fract(t * (0.08 + 0.12 * h21(id + seed + 9.1)) + n * 13.0);
      vec2 c = vec2(h21(id + seed + 1.7), h21(id + seed + 3.1)) * 0.6 - 0.3;
      float slide = step(0.65, h21(id + seed + 4.4));
      c.y += slide * (life * life * 0.9 - 0.2);
      float r = 0.1 + 0.16 * h21(id + seed + 5.3);
      vec2 e = f - c;
      e.y *= 1.0 + slide * 0.6;
      float d = length(e);
      float m = smoothstep(r, r * 0.55, d) * smoothstep(1.0, 0.75, life);
      return vec3(-e * m * (0.9 / cells) / aspect, m);
    }
    void main() {
      vec2 uv = vUv, off = vec2(0.0);
      float wet = 0.0;
      if (uLens > 0.001) {
        vec3 a = drops(uv, 7.0, uTime, 0.0), b = drops(uv, 13.0, uTime * 1.3, 17.0);
        off = a.xy + b.xy;
        wet = max(a.z, b.z);
      }
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);
      vec3 col;
      if (uAberr > 0.0005) {
        vec2 ca = d * r2 * uAberr;
        col = vec3(texture2D(tDiffuse, uv + off + ca).r, texture2D(tDiffuse, uv + off).g, texture2D(tDiffuse, uv + off - ca).b);
      } else col = texture2D(tDiffuse, uv + off).rgb;
      col *= 1.0 + wet * 0.12;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = max(mix(vec3(l), col, uSat), 0.0);
      col = 0.18 * pow(col / 0.18 + 1e-6, vec3(uContrast));
      col *= uTint;
      col += uFlash * vec3(0.5, 0.56, 0.7) * 0.25;
      col *= 1.0 - uVignette * smoothstep(0.1, 0.62, r2 * 1.9);
      col += (h21(uv * uRes + fract(uTime * 7.13) * 311.0) - 0.5) * uGrain * (sqrt(l) + 0.03);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.composer = null;
    this.size = new THREE.Vector2();
    // Smoothed grade values.
    this.g = { sat: 1, contrast: 1, tint: new THREE.Color(1, 1, 1), bloom: 0.3, lens: 0, aberr: 0 };
  }

  get enabled() { return !!this.composer; }

  // q: { post, msaa (0 = FXAA instead), bloom (strength scale) }
  configure(q) {
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
      for (const p of this.composer.passes) if (p.dispose) p.dispose();
      this.composer = null;
    }
    if (!q.post) return;
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    const rt = new THREE.WebGLRenderTarget(this.size.x, this.size.y, {
      type: THREE.HalfFloatType, samples: q.msaa, depthBuffer: true, stencilBuffer: true,
    });
    const c = (this.composer = new EffectComposer(r, rt));
    c.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.size.x, this.size.y), 0.3, 0.55, 0.92);
    c.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    c.addPass(this.grade);
    c.addPass(new OutputPass());
    if (!q.msaa) c.addPass(new FXAAPass());
    this.bloomScale = q.bloom ?? 1;
    this.setSize(window.innerWidth, window.innerHeight);
  }

  setSize(w, h) {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.renderer.getDrawingBufferSize(this.size);
    this.grade.uniforms.uRes.value.copy(this.size);
  }

  // look: { sat, contrast, tint (Color), bloom, threshold, vignette, lens, aberr, flash, grain }
  render(dt, look) {
    if (!this.composer) { this.renderer.render(this.scene, this.camera); return; }
    const g = this.g, k = damp(3, dt), u = this.grade.uniforms;
    g.sat += (look.sat - g.sat) * k;
    g.contrast += (look.contrast - g.contrast) * k;
    g.tint.lerp(look.tint, k);
    g.bloom += (look.bloom - g.bloom) * k;
    g.lens += (look.lens - g.lens) * damp(1.5, dt);
    g.aberr += (look.aberr - g.aberr) * damp(4, dt);
    u.uTime.value = performance.now() / 1000;
    u.uSat.value = g.sat; u.uContrast.value = g.contrast; u.uTint.value.copy(g.tint);
    u.uVignette.value = look.vignette; u.uLens.value = g.lens; u.uAberr.value = g.aberr;
    u.uFlash.value = look.flash; u.uGrain.value = look.grain;
    this.bloom.strength = g.bloom * this.bloomScale + look.flash * 0.6;
    this.bloom.threshold = look.threshold;
    this.composer.render(dt);
  }
}
