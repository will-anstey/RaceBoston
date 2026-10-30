// Materials. Most are MeshStandardMaterial with small shader patches that add
// procedural detail (windows, lane markings, curbs, waves) without textures.

import * as THREE from 'three';

export const globalUniforms = {
  uTime: { value: 0 },
  uNight: { value: 0 },
};

const HASH = /* glsl */ `
float rbHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float rbNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rbHash12(i), rbHash12(i + vec2(1.0, 0.0)), u.x),
             mix(rbHash12(i + vec2(0.0, 1.0)), rbHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float rbLine(float d, float w, float fw) {
  return 1.0 - smoothstep(w - fw, w + fw, abs(d));
}
`;

// Applies GLSL snippets to a built-in material.
function patch(mat, key, { uniforms = {}, vPars = '', vMain = '', fPars = '', fMain = '', fNormal = '', colorVertex = null, constNormal = false }) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, globalUniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\n${vPars}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${vMain}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n{
        vec4 rbW = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          rbW = instanceMatrix * rbW;
        #endif
        vWPos = (modelMatrix * rbW).xyz;
      }`);
    if (colorVertex !== null) shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', colorVertex);
    // Flat map layers have no normal attribute; shadows need a valid one.
    // Layers draped on the terrain carry real normals instead.
    if (constNormal && !mat.userData.terrainNormals) shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform float uNight;\nvarying vec3 vWPos;\n${HASH}\n${fPars}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${fNormal}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${fMain}`);
  };
  mat.customProgramCacheKey = () => key + (mat.userData.terrainNormals ? ':n' : '');
  return mat;
}

// Vertex colours are stored as sRGB bytes; convert to linear in the shader.
const SRGB_COLOR_VERTEX = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR )
  vColor = vec4(1.0);
#endif
#ifdef USE_COLOR_ALPHA
  vColor *= vec4(pow(color.rgb, vec3(2.2)), color.a);
#elif defined( USE_COLOR )
  vColor.rgb *= pow(color.rgb, vec3(2.2));
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.rgb *= instanceColor.rgb;
#endif
`;

// ------------------------------------------------------------------ ground
// Map layers draped on the ground mesh are drawn in a fixed order without
// writing depth (no z-fighting between coplanar roads, sidewalks and parks),
// pulled slightly toward the camera so they win against the ground itself,
// and lit with the terrain's normals.
export function flatLayer(mat, order) {
  mat.depthWrite = false;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -4;
  mat.flatShading = false;
  mat.userData.order = order;
  mat.userData.terrainNormals = true;
  return mat;
}

// The ground mesh itself: opaque, writes depth (hills hide what is behind
// them and keep tunnels out of sight), smooth-shaded with terrain normals.
export function terrainLayer(mat) {
  mat.depthWrite = true;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = 1;
  mat.polygonOffsetUnits = 2;
  mat.flatShading = false;
  mat.userData.terrainNormals = true;
  return mat;
}

export function makeGroundMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true });
  return patch(m, 'rb-ground', {
    constNormal: true,
    colorVertex: SRGB_COLOR_VERTEX,
    fMain: /* glsl */ `
      {
        float fw = length(fwidth(vWPos.xz));
        float big = rbNoise(vWPos.xz * 0.045) * 0.6 + rbNoise(vWPos.xz * 0.17) * 0.4;
        float fine = rbHash12(floor(vWPos.xz * 1.5));
        float fineAmt = 1.0 - smoothstep(0.2, 0.9, fw);
        diffuseColor.rgb *= 0.9 + big * 0.18 + (fine - 0.5) * 0.08 * fineAmt;
      }
    `,
  });
}

export function makeWaterMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x2f5f86, roughness: 0.06, metalness: 0.0, envMapIntensity: 1.1, flatShading: true });
  return patch(m, 'rb-water', {
    constNormal: true,
    fNormal: /* glsl */ `
      {
        vec2 p = vWPos.xz;
        float t = uTime;
        float dist = length(vWPos - cameraPosition);
        float amp = 1.0 - smoothstep(150.0, 900.0, dist);
        vec2 g = vec2(0.0);
        g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 0.35 + t * 1.1) * 0.035;
        g += vec2(-0.5, 0.86) * cos(dot(p, vec2(-0.5, 0.86)) * 0.6 + t * 1.7) * 0.025;
        g += vec2(0.2, -0.98) * cos(dot(p, vec2(0.2, -0.98)) * 1.3 + t * 2.3) * 0.018;
        g += vec2(-0.93, -0.35) * cos(dot(p, vec2(-0.93, -0.35)) * 2.1 + t * 2.9) * 0.012;
        g *= amp;
        vec3 wn = normalize(vec3(-g.x, 1.0, -g.y));
        normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
      }
    `,
    fMain: /* glsl */ `
      {
        float sparkle = rbNoise(vWPos.xz * 0.08 + uTime * 0.05);
        diffuseColor.rgb *= 0.85 + sparkle * 0.3;
      }
    `,
  });
}

// --------------------------------------------------------------- buildings
export function makeBuildingMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.0, flatShading: true });
  return patch(m, 'rb-building', {
    colorVertex: SRGB_COLOR_VERTEX,
    vPars: 'attribute vec2 aInfo; varying vec2 vInfo; varying vec3 vWN; varying float vAlong;',
    vMain: /* glsl */ `
      vInfo = aInfo;
      vWN = normalize(mat3(modelMatrix) * normal);
      vec2 rbT = normalize(vec2(-vWN.z, vWN.x) + vec2(1e-5));
      vAlong = dot((modelMatrix * vec4(position, 1.0)).xz, rbT);
    `,
    fPars: 'varying vec2 vInfo; varying vec3 vWN; varying float vAlong;',
    fMain: /* glsl */ `
      {
        vec3 wn = normalize(vWN);
        float wall = 1.0 - smoothstep(0.25, 0.5, abs(wn.y));
        float style = floor(vInfo.x + 0.5);
        float seed = vInfo.y;
        vec2 cell; vec2 win; float glassy = 0.0;
        if (style < 0.5)      { cell = vec2(3.3, 3.8); win = vec2(0.62, 0.52); }
        else if (style < 1.5) { cell = vec2(2.6, 3.3); win = vec2(0.40, 0.52); }
        else if (style < 2.5) { cell = vec2(3.3, 3.0); win = vec2(0.32, 0.46); }
        else if (style < 3.5) { cell = vec2(1.55, 3.9); win = vec2(0.9, 0.8); glassy = 1.0; }
        else                  { cell = vec2(6.5, 4.6); win = vec2(0.6, 0.2); }
        float along = vAlong + seed * 0.731;
        vec2 g = vec2(along, vWPos.y - 0.6) / cell;
        vec2 id = floor(g);
        vec2 f = fract(g) - 0.5;
        vec2 fw = fwidth(g);
        float mx = rbLine(f.x, win.x * 0.5, fw.x);
        float my = rbLine(f.y, win.y * 0.5, fw.y);
        float mask = mx * my * step(0.0, g.y);
        float aa = max(fw.x, fw.y);
        float lod = smoothstep(0.12, 0.55, aa);
        mask = mix(mask, win.x * win.y * 0.9, lod);
        mask *= wall;
        float r = mix(rbHash12(id + seed * 3.17), 0.45, lod);
        vec3 glass = mix(vec3(0.05, 0.065, 0.085), vec3(0.2, 0.25, 0.3), r * 0.7);
        glass = mix(glass, diffuseColor.rgb * 0.55 + vec3(0.02, 0.04, 0.07), glassy * 0.6);
        // Slight grime toward the street and banding per floor.
        float base = mix(0.78, 1.0, smoothstep(0.0, 3.0, vWPos.y));
        float floorBand = 1.0 - 0.05 * rbLine(fract(g.y) - 0.98, 0.04, fw.y) * wall * (1.0 - glassy);
        diffuseColor.rgb *= base * floorBand;
        // Roof detail: subtle tar/gravel noise.
        float roofN = rbNoise(vWPos.xz * 0.7) * 0.12 + rbHash12(floor(vWPos.xz * 2.0)) * 0.05;
        diffuseColor.rgb *= mix(1.0, 0.9 + roofN, 1.0 - wall);
        diffuseColor.rgb = mix(diffuseColor.rgb, glass, mask);
        roughnessFactor = mix(roughnessFactor, 0.08, mask);
        metalnessFactor = mix(metalnessFactor, 0.15 + glassy * 0.35, mask);
        float lit = mix(step(0.6, rbHash12(id * 1.31 + seed + 7.7)), 0.4, lod);
        vec3 warm = mix(vec3(1.0, 0.72, 0.38), vec3(0.72, 0.84, 1.0), step(0.8, r));
        float glow = mix(0.18 + 0.5 * rbHash12(id * 0.73 + seed), 0.35, lod);
        totalEmissiveRadiance += warm * mask * lit * uNight * uNight * glow;
      }
    `,
  });
}

// ------------------------------------------------------------------- roads
// uv = (lateral meters from centreline, meters along road)
// aRoad = (halfWidth, lanes, style, shoulder); aMark = 1 where markings allowed.
export function makeRoadMaterial({ tunnel = false } = {}) {
  const m = new THREE.MeshStandardMaterial({ color: 0x3a3b3f, roughness: 0.92, metalness: 0, flatShading: true });
  if (tunnel) m.defines = { RB_TUNNEL: '' };
  return patch(m, tunnel ? 'rb-road-tunnel' : 'rb-road', {
    constNormal: true,
    vPars: 'attribute vec4 aRoad; attribute float aMark; attribute vec2 aUV; varying vec4 vRoad; varying float vMark; varying vec2 vRUV;',
    vMain: 'vRoad = aRoad; vMark = aMark; vRUV = aUV;',
    fPars: 'varying vec4 vRoad; varying float vMark; varying vec2 vRUV;',
    fMain: /* glsl */ `
      {
        float u = vRUV.x, v = vRUV.y;
        float hw = vRoad.x, lanes = max(vRoad.y, 1.0), style = floor(vRoad.z + 0.5), sh = vRoad.w;
        float fu = max(fwidth(u), 0.002), fv = max(fwidth(v), 0.002);
        float fwp = length(fwidth(vWPos.xz));
        // Asphalt: large patches + fine grain + darker tyre lanes.
        float patchN = rbNoise(vWPos.xz * 0.06);
        float grain = rbHash12(floor(vWPos.xz * 3.0)) * (1.0 - smoothstep(0.15, 0.6, fwp));
        vec3 col = diffuseColor.rgb * (0.9 + patchN * 0.16 + (grain - 0.5) * 0.1);
        col *= 1.0 - 0.18 * (1.0 - smoothstep(hw - 0.35, hw, abs(u))) * smoothstep(hw - 0.9, hw - 0.35, abs(u));
        float paintW = 0.0, paintY = 0.0;
        if (style > 0.5 && vMark > 0.5) {
          float drive = max(hw - sh, 1.2);
          float laneW = 2.0 * drive / lanes;
          float dash = rbLine(fract(v / 12.0) - 0.15, 0.15, fv / 12.0);
          // edge lines
          if (sh > 0.4) paintW = max(paintW, rbLine(abs(u) - (drive - 0.1), 0.07, fu));
          if (style == 1.0 || style == 4.0) {
            // two-way: double yellow centre line + dashed white lane lines
            paintY = max(paintY, rbLine(abs(u) - 0.13, 0.055, fu));
            float perSide = floor(lanes * 0.5 + 0.01);
            for (int k = 1; k < 5; k++) {
              if (float(k) >= perSide) break;
              paintW = max(paintW, rbLine(abs(u) - float(k) * laneW, 0.06, fu) * dash);
            }
          } else {
            // one-way: dashed white lane lines; yellow left edge on highways
            for (int k = 1; k < 8; k++) {
              if (float(k) >= lanes) break;
              paintW = max(paintW, rbLine(u + drive - float(k) * laneW, 0.06, fu) * dash);
            }
            if (style == 3.0) paintY = max(paintY, rbLine(u + drive - 0.1, 0.07, fu));
          }
          float fade = 1.0 - smoothstep(0.25, 0.7, fu * 6.0);
          paintW *= fade; paintY *= fade;
        }
        vec3 white = vec3(0.82, 0.82, 0.78);
        vec3 yellow = vec3(0.78, 0.55, 0.12);
        col = mix(col, white, paintW * 0.92);
        col = mix(col, yellow, paintY * 0.92);
        diffuseColor.rgb = col;
        roughnessFactor = mix(roughnessFactor, 0.7, max(paintW, paintY));
        // Street lights: warm pools along both kerbs at night.
        if (uNight > 0.01) {
          float k = fract(v / 34.0) - 0.5;
          float pool = exp(-k * k * 34.0 * 34.0 / 70.0);
          float side = 0.35 + 0.65 * smoothstep(0.0, hw, abs(u));
          totalEmissiveRadiance += col * vec3(1.0, 0.8, 0.55) * pool * side * uNight * 1.6;
          totalEmissiveRadiance += col * vec3(0.55, 0.6, 0.75) * uNight * 0.12;
        }
        #ifdef RB_TUNNEL
          // Tunnel: little daylight, sodium lamp pools every 9 m.
          diffuseColor.rgb *= 0.3;
          float tk = fract(v / 9.0) - 0.5;
          totalEmissiveRadiance += col * vec3(1.0, 0.78, 0.5) * (0.18 + 1.6 * exp(-tk * tk * 70.0));
        #endif
      }
    `,
  });
}

// Runway with FAA-style markings. aUV = (lateral m, m along from the chain
// start), aRwy = (half width of the marked runway, runway length).
export function makeRunwayMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x35373b, roughness: 0.9, metalness: 0, flatShading: true });
  return patch(m, 'rb-runway', {
    constNormal: true,
    vPars: 'attribute vec2 aUV; attribute vec2 aRwy; varying vec2 vRUV; varying vec2 vRwy;',
    vMain: 'vRUV = aUV; vRwy = aRwy;',
    fPars: 'varying vec2 vRUV; varying vec2 vRwy;',
    fMain: /* glsl */ `
      {
        float u = vRUV.x, v = vRUV.y, hw = vRwy.x, L = vRwy.y;
        float au = abs(u), d = min(v, L - v);
        float fu = max(fwidth(u), 0.003), fv = max(fwidth(v), 0.003);
        float detail = 1.0 - smoothstep(0.35, 1.4, max(fu, fv));
        vec3 col = diffuseColor.rgb * (0.86 + rbNoise(vWPos.xz * 0.04) * 0.2 + (rbHash12(floor(vWPos.xz * 2.0)) - 0.5) * 0.06 * detail);
        col = mix(col, col * 1.45 + 0.03, smoothstep(hw - 0.15, hw + 0.15, au));              // lighter shoulders
        float rub = smoothstep(200.0, 330.0, d) * (1.0 - smoothstep(650.0, 1100.0, d)) * (1.0 - smoothstep(8.0, 15.0, au));
        col *= 1.0 - 0.5 * rub * (0.55 + 0.45 * rbNoise(vec2(u * 0.6, v * 0.025)));           // tyre rubber
        float paint = rbLine(au - (hw - 1.0), 0.45, fu);                                       // edge stripes
        float inThr = step(6.0, d) * step(d, 51.0) * step(3.0, au) * step(au, hw - 3.0);
        float keys = rbLine(fract((au - 3.0) / 3.6) - 0.25, 0.25, fu / 3.6);
        paint = max(paint, inThr * mix(0.5, keys, detail));                                    // threshold piano keys
        paint = max(paint, step(115.0, d) * rbLine(u, 0.45, fu) * step(fract(v / 60.0), 0.6)); // centreline dashes
        paint = max(paint, step(305.0, d) * step(d, 350.0) * step(6.5, au) * step(au, 15.5));  // aiming point
        float tdz = 0.0;
        for (int k = 0; k < 5; k++) {
          float c = k == 0 ? 150.0 : 300.0 + 150.0 * float(k);
          tdz = max(tdz, step(c, d) * step(d, c + 22.0));
        }
        float bars = mix(0.5, rbLine(fract((au - 6.5) / 2.2) - 0.25, 0.25, fu / 2.2), detail) * step(6.5, au) * step(au, 12.5);
        paint = max(paint, tdz * bars * step(d, 920.0) * (1.0 - step(300.0, d) * step(d, 360.0)));
        paint *= 1.0 - smoothstep(hw - 0.1, hw + 0.2, au);
        col = mix(col, vec3(0.86, 0.86, 0.84), paint * 0.93);
        diffuseColor.rgb = col;
        roughnessFactor = mix(roughnessFactor, 0.65, paint);
      }
    `,
  });
}

// Taxiway: yellow centreline, double yellow edge lines (aTwy.y = 1).
export function makeTaxiwayMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x3d3e42, roughness: 0.9, metalness: 0, flatShading: true });
  return patch(m, 'rb-taxiway', {
    constNormal: true,
    vPars: 'attribute vec2 aUV; attribute vec2 aTwy; varying vec2 vRUV; varying vec2 vTwy;',
    vMain: 'vRUV = aUV; vTwy = aTwy;',
    fPars: 'varying vec2 vRUV; varying vec2 vTwy;',
    fMain: /* glsl */ `
      {
        float u = vRUV.x, hw = vTwy.x, au = abs(u);
        float fu = max(fwidth(u), 0.003);
        float fwp = length(fwidth(vWPos.xz));
        vec3 col = diffuseColor.rgb * (0.88 + rbNoise(vWPos.xz * 0.05) * 0.18 + (rbHash12(floor(vWPos.xz * 2.0)) - 0.5) * 0.06 * (1.0 - smoothstep(0.3, 1.0, fwp)));
        float paint = rbLine(u, 0.09, fu);
        paint = max(paint, vTwy.y * max(rbLine(au - (hw - 0.55), 0.08, fu), rbLine(au - (hw - 0.9), 0.08, fu)));
        paint *= 1.0 - smoothstep(0.15, 0.6, fu * 5.0);
        col = mix(col, vec3(0.86, 0.62, 0.1), paint * 0.92);
        diffuseColor.rgb = col;
      }
    `,
  });
}

// Depth-tested variant of a flat-layer material for elevated / sunken roads.
export function as3D(mat) {
  mat.depthWrite = true;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -4;
  return mat;
}

// Tiled tunnel walls and ceiling with rows of lamps.
// aUV = (meters along, height above road); ceiling uses v >= 8.
export function makeTunnelMaterial() {
  // Front-facing only: walls face the road and the ceiling faces down, so
  // nothing of the tunnel shows from above through openings in the ground.
  const m = new THREE.MeshStandardMaterial({ color: 0xd8d4ca, roughness: 0.55, metalness: 0, flatShading: true });
  return patch(m, 'rb-tunnel', {
    constNormal: true,
    vPars: 'attribute vec2 aUV; varying vec2 vRUV;',
    vMain: 'vRUV = aUV;',
    fPars: 'varying vec2 vRUV;',
    fMain: /* glsl */ `
      {
        float u = vRUV.x, v = vRUV.y;
        float fu = max(fwidth(u), 0.002), fv = max(fwidth(v), 0.002);
        float detail = 1.0 - smoothstep(0.05, 0.25, max(fu, fv));
        float tile = rbLine(fract(u / 1.2) - 0.5, 0.47, fu / 1.2) * rbLine(fract(v / 0.6) - 0.5, 0.44, fv / 0.6);
        vec3 col = diffuseColor.rgb * mix(0.82, 1.0, mix(0.6, tile, detail));
        col *= mix(0.45, 1.0, smoothstep(0.0, 1.4, v));          // road grime
        col = mix(col, vec3(0.75, 0.62, 0.2), rbLine(v - 1.1, 0.12, fv) * step(v, 7.0)); // safety stripe
        diffuseColor.rgb = col * 0.38;
        float lampWall = rbLine(fract(u / 8.0) - 0.5, 0.12, fu / 8.0) * rbLine(v - 4.7, 0.1, fv);
        float lampCeil = rbLine(fract(u / 6.0) - 0.5, 0.2, fu / 6.0) * rbLine(v - 10.0, 0.25, fv);
        totalEmissiveRadiance += vec3(1.0, 0.82, 0.55) * (lampWall + lampCeil) * 3.5;
        totalEmissiveRadiance += col * 0.08;
      }
    `,
  });
}

// uv.x = lateral distance, aSide = road half width (curb position)
export function makeSidewalkMaterial() {
  return makeSidewalkMaterialImpl();
}
function makeSidewalkMaterialImpl() {
  const m = new THREE.MeshStandardMaterial({ color: 0xbdb8ae, roughness: 0.95, metalness: 0, flatShading: true });
  return patch(m, 'rb-sidewalk', {
    constNormal: true,
    vPars: 'attribute vec2 aUV; attribute float aSide; varying vec2 vRUV; varying float vSide;',
    vMain: 'vRUV = aUV; vSide = aSide;',
    fPars: 'varying vec2 vRUV; varying float vSide;',
    fMain: /* glsl */ `
      {
        float u = abs(vRUV.x) - vSide;
        float fu = max(fwidth(u), 0.002), fv = max(fwidth(vRUV.y), 0.002);
        float curb = 1.0 - smoothstep(0.22 - fu, 0.22 + fu, u);
        float gutter = 1.0 - smoothstep(0.0, 0.05 + fu, u);
        float joint = rbLine(fract(vRUV.y / 1.6) - 0.5, 0.02, fv / 1.6) * (1.0 - smoothstep(0.08, 0.3, fv));
        vec3 col = diffuseColor.rgb;
        col *= 1.0 - joint * 0.16;
        col = mix(col, vec3(0.82, 0.8, 0.76), curb * 0.6);
        col = mix(col, col * 0.55, gutter);
        float n = rbNoise(vWPos.xz * 0.4);
        diffuseColor.rgb = col * (0.93 + n * 0.12);
        if (uNight > 0.01) {
          float k = fract(vRUV.y / 34.0) - 0.5;
          float pool = exp(-k * k * 34.0 * 34.0 / 70.0);
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.8, 0.55) * pool * uNight * 1.2;
        }
      }
    `,
  });
}

export function makeCrosswalkMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xdcdcd4, roughness: 0.7, metalness: 0, transparent: false, flatShading: true });
  return patch(m, 'rb-crosswalk', {
    constNormal: true,
    vPars: 'attribute vec2 aUV; varying vec2 vRUV;',
    vMain: 'vRUV = aUV;',
    fPars: 'varying vec2 vRUV;',
    fMain: /* glsl */ `
      {
        float fv = max(fwidth(vRUV.y), 0.002);
        float bar = rbLine(fract(vRUV.y / 1.1) - 0.5, 0.27, fv / 1.1);
        bar *= 1.0 - smoothstep(0.25, 0.6, fv * 3.0);
        if (bar < 0.02) discard;
        diffuseColor.rgb *= 0.92 + rbNoise(vWPos.xz * 2.0) * 0.12;
      }
    `,
  });
}

// uv = (lateral meters from the track centreline, meters along).
// tunnel: dimmed daylight and lamp pools (subway tunnels).
export function makeRailMaterial({ tunnel = false } = {}) {
  const m = new THREE.MeshStandardMaterial({ color: 0x6c645c, roughness: 0.95, metalness: 0, flatShading: true });
  if (tunnel) m.defines = { RB_TUNNEL: '' };
  return patch(m, tunnel ? 'rb-rail-tunnel' : 'rb-rail', {
    constNormal: true,
    vPars: 'attribute vec2 aUV; varying vec2 vRUV;',
    vMain: 'vRUV = aUV;',
    fPars: 'varying vec2 vRUV;',
    fMain: /* glsl */ `
      {
        float u = vRUV.x, v = vRUV.y;
        float fu = max(fwidth(u), 0.002), fv = max(fwidth(v), 0.002);
        float detail = 1.0 - smoothstep(0.08, 0.3, max(fu, fv));
        vec3 col = diffuseColor.rgb * (0.85 + rbHash12(floor(vWPos.xz * 4.0)) * 0.25 * detail);
        float tie = rbLine(fract(v / 0.65) - 0.5, 0.13, fv / 0.65) * step(abs(u), 1.25) * detail;
        col = mix(col, vec3(0.24, 0.18, 0.14), tie);
        float rail = rbLine(abs(u) - 0.72, 0.045, fu);
        col = mix(col, vec3(0.62, 0.63, 0.65), rail);
        diffuseColor.rgb = col;
        metalnessFactor = mix(metalnessFactor, 0.7, rail);
        roughnessFactor = mix(roughnessFactor, 0.35, rail);
        #ifdef RB_TUNNEL
          // Tunnel: little daylight, pools of light under the lamps every 6 m.
          diffuseColor.rgb *= 0.3;
          float tk = fract(v / 6.0) - 0.5;
          totalEmissiveRadiance += col * vec3(1.0, 0.85, 0.62) * (0.16 + 0.85 * exp(-tk * tk * 30.0));
        #endif
      }
    `,
  });
}

export function makeBasicStandard(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, flatShading: true, ...opts });
}

// Flat-shaded material for normal-less geometry (railings, simple props).
export function makeFlatProp(color, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true, ...opts });
  return patch(m, 'rb-prop', { constNormal: true });
}

// Vertex-coloured standard material with sRGB byte colours (trees, props).
export function makeVertexColorMaterial(opts = {}) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, flatShading: true, ...opts });
  return patch(m, 'rb-vcol-' + (opts.name || ''), { colorVertex: SRGB_COLOR_VERTEX });
}
