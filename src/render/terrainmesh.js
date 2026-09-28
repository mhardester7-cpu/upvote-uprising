// Terrain mesh and its layered ground material.
//
// GEOMETRY IS UNCHANGED AND MUST STAY UNCHANGED. This emits exactly the
// triangulation Heightfield.heightAt/raycast evaluate -- per cell, (v00,v11,v10)
// and (v00,v01,v11) -- so what you see is what you shoot. Everything added here
// is shading: no displacement, no vertex offsets, no LOD that would move a
// surface away from the height the collision code reports.
//
// The material blends five ground layers -- dry grass, packed dirt, rock, sand,
// snow -- out of a texture array. Which ones are active at a vertex comes from
// the biome, the local slope and two scales of noise, baked into a vertex
// attribute; how hard the boundary between them is comes from a shared detail
// height sampled per pixel, which makes the transitions interlock instead of
// cross-fading like a slide dissolve.
//
// Rock is mapped triplanar and everything else top-down. That split is the
// whole trick for cliffs: top-down projection is correct for ground you can
// stand on and smears into vertical streaks on anything steep, and rock is the
// only layer that appears on steep faces.
//
// Chunked purely for frustum culling: one 256x256 mesh would always be drawn
// in full, whereas 64 chunks lets most of the map fall out of the frustum.

import * as THREE from '../../vendor/three.module.js';
import {
  N, CELL, BIOME_GRASS, BIOME_ROCK, BIOME_SAND, BIOME_SNOW,
} from '../world/heightfield.js';
import { fbm2 } from '../world/noise.js';
import { terrainTextures, LAYER, LAYER_SCALE } from './texturelab.js';
import { getAtmosphereUniforms, ATMOSPHERE_PARS, AERIAL_FOG_FRAGMENT } from './sky.js';
import { GroundClutter } from './clutter.js';

export const CHUNK_CELLS = 32;                      // cells per chunk side
export const CHUNKS = N / CHUNK_CELLS;              // chunks per side

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, t) => {
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
};

// Texture repeats per world metre, per layer.
const INV = LAYER_SCALE.map((s) => 1 / s);

// Detail layer repeats. The fine scale adds relief you can only see within a
// few metres; the coarse one is what actually defeats tiling, because a 23m
// modulation is far larger than any layer's repeat and so breaks the eye's
// lock onto the pattern.
const DETAIL_FINE = 1 / 0.85;
const DETAIL_COARSE = 1 / 23.0;

// --------------------------------------------------------------- the shader

const VERT_PARS = /* glsl */`
  attribute vec4 aBlend;
  attribute vec2 aMisc;
  varying vec4 vBlend;
  varying vec2 vMisc;
  varying vec3 vWPos;
  varying vec3 vWNormal;
`;

const VERT_BODY = /* glsl */`
  vBlend = aBlend;
  vMisc = aMisc;
  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vWNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

const FRAG_PARS = /* glsl */`
  uniform sampler2DArray tTerrainAlb;
  uniform sampler2DArray tTerrainSrf;
  uniform float uDetailFade;
  uniform vec3 uPlanetTint;

  varying vec4 vBlend;
  varying vec2 vMisc;
  varying vec3 vWPos;
  varying vec3 vWNormal;

  ${ATMOSPHERE_PARS}

  // Screen-space derivatives of the world XZ plane, taken once in uniform
  // control flow. Every layer fetch is a textureGrad against these: sampling
  // inside a per-pixel branch with implicit LOD gives undefined mip selection
  // right where the layers meet, which shows up as a bright seam.
  vec2 gDx, gDy;
  float gAO;

  vec4 fetchA(float layer, vec2 uv, float scl) {
    return textureGrad(tTerrainAlb, vec3(uv, layer), gDx * scl, gDy * scl);
  }
  vec4 fetchS(float layer, vec2 uv, float scl) {
    return textureGrad(tTerrainSrf, vec3(uv, layer), gDx * scl, gDy * scl);
  }

  // Albedo is stored as sqrt(linear), so decoding is one multiply.
  vec3 decode(vec3 c) { return c * c; }

  void addGround(float layer, float scl, float w,
                 inout vec3 alb, inout vec2 nrm, inout float rough, inout float ao) {
    vec2 uv = vWPos.xz * scl;
    vec4 a = fetchA(layer, uv, scl);
    vec4 s = fetchS(layer, uv, scl);
    alb += decode(a.rgb) * w;
    nrm += (s.xy * 2.0 - 1.0) * w;
    rough += s.z * w;
    ao += s.w * w;
  }
`;

const FRAG_BODY = /* glsl */`
  gDx = dFdx(vWPos.xz);
  gDy = dFdy(vWPos.xz);

  vec3 gn = normalize(vWNormal);
  float slope = 1.0 - clamp(gn.y, 0.0, 1.0);
  float viewDist = length(vWPos - cameraPosition);

  // Fine detail is faded out with distance: past ~50m a 0.85m pattern is
  // sub-pixel and only contributes shimmer.
  float fine = uDetailFade * (1.0 - smoothstep(16.0, 52.0, viewDist));

  vec4 dF = fetchA(${LAYER.DETAIL}.0, vWPos.xz * ${DETAIL_FINE.toFixed(5)}, ${DETAIL_FINE.toFixed(5)});
  vec4 dC = fetchA(${LAYER.DETAIL}.0, vWPos.xz * ${DETAIL_COARSE.toFixed(6)}, ${DETAIL_COARSE.toFixed(6)});
  vec4 dFs = fetchS(${LAYER.DETAIL}.0, vWPos.xz * ${DETAIL_FINE.toFixed(5)}, ${DETAIL_FINE.toFixed(5)});

  // Shared erosion term. Pushing every weight through the same high-frequency
  // height is what turns a linear cross-fade into an interlocking boundary.
  float ero = (dF.a - 0.5);

  float rockW = clamp(smoothstep(0.17, 0.44, slope) + vMisc.x, 0.0, 1.0);
  rockW = clamp(rockW * 1.55 - 0.28 + ero * 0.55, 0.0, 1.0);

  vec4 gw = clamp(vBlend * 1.4 - 0.16 + ero * 0.38, 0.0, 1.0);
  gw /= max(gw.x + gw.y + gw.z + gw.w, 1e-4);
  gw *= (1.0 - rockW);

  vec3 alb = vec3(0.0);
  vec2 nrm = vec2(0.0);
  float rough = 0.0;
  float ao = 0.0;

  if (gw.x > 0.004) addGround(${LAYER.GRASS}.0, ${INV[LAYER.GRASS].toFixed(5)}, gw.x, alb, nrm, rough, ao);
  if (gw.y > 0.004) addGround(${LAYER.DIRT}.0,  ${INV[LAYER.DIRT].toFixed(5)},  gw.y, alb, nrm, rough, ao);
  if (gw.z > 0.004) addGround(${LAYER.SAND}.0,  ${INV[LAYER.SAND].toFixed(5)},  gw.z, alb, nrm, rough, ao);
  if (gw.w > 0.004) addGround(${LAYER.SNOW}.0,  ${INV[LAYER.SNOW].toFixed(5)},  gw.w, alb, nrm, rough, ao);

  // Ground normal: whiteout blend of the sampled tangent normal with the
  // geometric one, so slopes keep their shape.
  vec2 gnrm = nrm * (0.55 + 0.45 * fine);
  vec3 groundN = normalize(vec3(gnrm.x + gn.x, gn.y, gnrm.y + gn.z));
  vec3 worldN = groundN;

  if (rockW > 0.004) {
    float rs = ${INV[LAYER.ROCK].toFixed(5)};
    vec3 an = abs(gn);
    vec3 bw = an * an * an * an;
    bw /= max(bw.x + bw.y + bw.z, 1e-4);

    vec3 ralb = vec3(0.0);
    float rrough = 0.0, rao = 0.0;
    vec3 rN = vec3(0.0);

    if (bw.y > 0.02) {
      vec2 uv = vWPos.xz * rs;
      vec4 a = fetchA(${LAYER.ROCK}.0, uv, rs);
      vec4 s = fetchS(${LAYER.ROCK}.0, uv, rs);
      vec2 t = s.xy * 2.0 - 1.0;
      ralb += decode(a.rgb) * bw.y; rrough += s.z * bw.y; rao += s.w * bw.y;
      rN += normalize(vec3(t.x + gn.x, gn.y, t.y + gn.z)) * bw.y;
    }
    if (bw.x > 0.02) {
      vec2 uv = vec2(vWPos.z, vWPos.y) * rs;
      vec4 a = fetchA(${LAYER.ROCK}.0, uv, rs);
      vec4 s = fetchS(${LAYER.ROCK}.0, uv, rs);
      vec2 t = s.xy * 2.0 - 1.0;
      ralb += decode(a.rgb) * bw.x; rrough += s.z * bw.x; rao += s.w * bw.x;
      rN += normalize(vec3(gn.x, t.y + gn.y, t.x + gn.z)) * bw.x;
    }
    if (bw.z > 0.02) {
      vec2 uv = vec2(vWPos.x, vWPos.y) * rs;
      vec4 a = fetchA(${LAYER.ROCK}.0, uv, rs);
      vec4 s = fetchS(${LAYER.ROCK}.0, uv, rs);
      vec2 t = s.xy * 2.0 - 1.0;
      ralb += decode(a.rgb) * bw.z; rrough += s.z * bw.z; rao += s.w * bw.z;
      rN += normalize(vec3(t.x + gn.x, t.y + gn.y, gn.z)) * bw.z;
    }

    alb = mix(alb, ralb, rockW);
    rough = mix(rough, rrough, rockW);
    ao = mix(ao, rao, rockW);
    worldN = normalize(mix(groundN, normalize(rN), rockW));
  }

  // Micro relief from the shared detail layer, only where it is visible.
  vec2 dn = (dFs.xy * 2.0 - 1.0) * 0.55 * fine;
  worldN = normalize(vec3(worldN.x + dn.x, worldN.y, worldN.z + dn.y));

  // Two scales of albedo modulation. The coarse one, at a 23m repeat, is doing
  // the heavy lifting against tiling -- it is far larger than any layer's own
  // repeat, so it breaks the eye's lock onto the pattern; the fine one only
  // survives up close. The per-vertex tint on top of them varies over ~48m and
  // does not repeat at all.
  float mF = dF.r * dF.r;
  float mC = dC.r * dC.r;
  float macro = (mC - 0.5);
  alb *= (1.0 + (mF - 0.5) * 0.42 * fine) * (1.0 + macro * 1.30) * vMisc.y;
  // A slight warm/cool swing with the same macro term: brightness alone still
  // reads as one material lit unevenly, whereas a hue shift reads as ground
  // that dried out differently in different places.
  alb.r *= 1.0 + macro * 0.30;
  alb.b *= 1.0 - macro * 0.34;

  gAO = clamp(ao, 0.0, 1.0);
`;

// -------------------------------------------------------------------- mesh

export class TerrainMesh {
  /**
   * @param textures optional pre-built arrays -- photographed sets from
   *   photosets.js, which must be awaited before the mesh exists because the
   *   material captures them at compile time. Omitted, the procedural bake is
   *   used, which is what happens whenever the art pack is not installed.
   */
  constructor(scene, field, textures = null) {
    this.scene = scene;
    this.field = field;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.textures = textures || terrainTextures(256);
    this.material = this._material();

    this.meshes = [];
    this.normals = this._buildNormalField();
    this.blend = this._buildBlendField();
    this.clutter = null;
    this.planetTint = new THREE.Color(1, 1, 1);
  }

  _material() {
    const atm = getAtmosphereUniforms();
    const tex = this.textures;

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0.0,
      dithering: true,
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.tTerrainAlb = { value: tex.albedo };
      shader.uniforms.tTerrainSrf = { value: tex.surface };
      shader.uniforms.uDetailFade = { value: 1 };
      shader.uniforms.uPlanetTint = { value: this.planetTint };
      // Shared objects, so the atmosphere stays in step across every material.
      shader.uniforms.tSkyR = atm.tSkyR;
      shader.uniforms.tSkyM = atm.tSkyM;
      shader.uniforms.tSunT = atm.tSunT;
      shader.uniforms.uSunDir = atm.uSunDir;
      shader.uniforms.uSkyGain = atm.uSkyGain;

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
        .replace('#include <map_fragment>', `${FRAG_BODY}\n  diffuseColor.rgb *= alb * uPlanetTint;`)
        .replace('#include <roughnessmap_fragment>',
          'float roughnessFactor = clamp(rough, 0.05, 1.0);')
        .replace('#include <normal_fragment_maps>',
          'normal = normalize((viewMatrix * vec4(worldN, 0.0)).xyz);')
        .replace('#include <aomap_fragment>', `
          reflectedLight.indirectDiffuse *= gAO;
          reflectedLight.directDiffuse *= mix(1.0, gAO, 0.35);
        `)
        .replace('#include <fog_fragment>', AERIAL_FOG_FRAGMENT);

      this.shader = shader;
    };
    // Distinguishes this program from any other MeshStandardMaterial.
    mat.customProgramCacheKey = () => 'terrain-layered-v1';
    return mat;
  }

  /**
   * Averaged vertex normals over the whole field.
   *
   * Accumulating each triangle's face normal into its three corners and
   * normalising at the end is what removes the cell-to-cell faceting; doing it
   * globally (not per chunk) also keeps chunk seams invisible.
   */
  _buildNormalField() {
    const f = this.field;
    const w = N + 1;
    const nx = new Float32Array(w * w);
    const ny = new Float32Array(w * w);
    const nz = new Float32Array(w * w);

    const add = (i, j, x, y, z) => {
      const k = j * w + i;
      nx[k] += x; ny[k] += y; nz[k] += z;
    };

    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const h00 = f.sample(i, j);
        const h10 = f.sample(i + 1, j);
        const h01 = f.sample(i, j + 1);
        const h11 = f.sample(i + 1, j + 1);

        // Triangle (v00, v11, v10)
        let ax = CELL, ay = h11 - h00, az = CELL;
        let bx = CELL, by = h10 - h00, bz = 0;
        let cx = ay * bz - az * by;
        let cy = az * bx - ax * bz;
        let cz = ax * by - ay * bx;
        add(i, j, cx, cy, cz); add(i + 1, j + 1, cx, cy, cz); add(i + 1, j, cx, cy, cz);

        // Triangle (v00, v01, v11)
        ax = 0; ay = h01 - h00; az = CELL;
        bx = CELL; by = h11 - h00; bz = CELL;
        cx = ay * bz - az * by;
        cy = az * bx - ax * bz;
        cz = ax * by - ay * bx;
        add(i, j, cx, cy, cz); add(i, j + 1, cx, cy, cz); add(i + 1, j + 1, cx, cy, cz);
      }
    }

    for (let k = 0; k < w * w; k++) {
      const l = Math.hypot(nx[k], ny[k], nz[k]) || 1;
      nx[k] /= l; ny[k] /= l; nz[k] /= l;
      if (ny[k] < 0) { nx[k] = -nx[k]; ny[k] = -ny[k]; nz[k] = -nz[k]; }
    }
    return { nx, ny, nz };
  }

  /**
   * Per-corner layer weights.
   *
   * The heightfield classifies biomes with hard thresholds, so raw weights jump
   * between neighbouring corners and the boundary lands inside a single 1m
   * cell. Box-blurring the weight field twice spreads each transition over
   * roughly three metres, which is what a real soil boundary looks like.
   */
  _buildBlendField() {
    const f = this.field;
    const w = N + 1;
    const n = w * w;
    let grass = new Float32Array(n);
    let dirt = new Float32Array(n);
    let sand = new Float32Array(n);
    let snow = new Float32Array(n);
    let rock = new Float32Array(n);
    const tint = new Float32Array(n);
    const { ny } = this.normals;

    for (let j = 0; j < w; j++) {
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        const slope = 1 - ny[k];
        // Broad: where the ground is worn back to earth. Fine: mottling.
        const broad = fbm2(i * 0.013, j * 0.013, 733, 3);
        const fineN = fbm2(i * 0.055, j * 0.055, 991, 3);
        const b = f.biome[k];

        let g = 0, d = 0, s = 0, w4 = 0, r = 0;
        if (b === BIOME_SAND) {
          s = 1;
          d = clamp01((fineN - 0.58) * 2.2) * 0.5;
          s -= d;
        } else if (b === BIOME_ROCK) {
          r = 0.5;
          d = 0.72; g = 0.28;
        } else if (b === BIOME_SNOW) {
          w4 = 1;
          r = smooth(0.28, 0.55, slope) * 0.6;
        } else {
          // Grass, thinning to bare earth on slopes and in the dry patches.
          d = clamp01(smooth(0.50, 0.26, broad) + slope * 1.15 + (fineN - 0.5) * 0.7);
          g = 1 - d;
        }
        grass[k] = g; dirt[k] = d; sand[k] = s; snow[k] = w4; rock[k] = r;
        // Broad brightness variation over ~48m, independent of which layer is
        // showing. World-space and non-repeating, which is what the tiled
        // layers cannot provide for themselves.
        tint[k] = 0.80 + fbm2(i * 0.021, j * 0.021, 1277, 3) * 0.44;
      }
    }

    const blur = (src) => {
      const out = new Float32Array(n);
      for (let j = 0; j < w; j++) {
        const j0 = Math.max(0, j - 1), j1 = Math.min(w - 1, j + 1);
        for (let i = 0; i < w; i++) {
          const i0 = Math.max(0, i - 1), i1 = Math.min(w - 1, i + 1);
          out[j * w + i] = (
            src[j0 * w + i0] + src[j0 * w + i] + src[j0 * w + i1] +
            src[j * w + i0] + src[j * w + i] + src[j * w + i1] +
            src[j1 * w + i0] + src[j1 * w + i] + src[j1 * w + i1]
          ) / 9;
        }
      }
      return out;
    };

    for (let pass = 0; pass < 2; pass++) {
      grass = blur(grass); dirt = blur(dirt); sand = blur(sand);
      snow = blur(snow); rock = blur(rock);
    }

    return { grass, dirt, sand, snow, rock, tint };
  }

  build() {
    for (let cz = 0; cz < CHUNKS; cz++) {
      for (let cx = 0; cx < CHUNKS; cx++) {
        const mesh = new THREE.Mesh(this._chunkGeometry(cx, cz), this.material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
        this.meshes.push(mesh);
      }
    }

    // Ground clutter lives with the terrain: it needs the same heightfield and
    // the same biome weights, and main.js has no separate hook to build it in.
    this.clutter = new GroundClutter(this.scene, this.field, this.blend);
    this.clutter.build();
  }

  _chunkGeometry(cx, cz) {
    const f = this.field;
    const { nx, ny, nz } = this.normals;
    const bl = this.blend;
    const w = N + 1;

    const i0 = cx * CHUNK_CELLS, j0 = cz * CHUNK_CELLS;
    // One extra row/column of vertices so chunks share their edge samples and
    // meet with no crack.
    const vw = CHUNK_CELLS + 1;

    const positions = new Float32Array(vw * vw * 3);
    const normals = new Float32Array(vw * vw * 3);
    const blend = new Float32Array(vw * vw * 4);
    const misc = new Float32Array(vw * vw * 2);

    for (let j = 0; j < vw; j++) {
      for (let i = 0; i < vw; i++) {
        const gi = i0 + i, gj = j0 + j;
        const o = (j * vw + i) * 3;
        const h = f.sample(gi, gj);

        positions[o] = gi * CELL;
        positions[o + 1] = h;
        positions[o + 2] = gj * CELL;

        const k = Math.min(w * w - 1, gj * w + gi);
        normals[o] = nx[k]; normals[o + 1] = ny[k]; normals[o + 2] = nz[k];

        const b = (j * vw + i) * 4;
        blend[b] = bl.grass[k];
        blend[b + 1] = bl.dirt[k];
        blend[b + 2] = bl.sand[k];
        blend[b + 3] = bl.snow[k];

        const m = (j * vw + i) * 2;
        misc[m] = bl.rock[k];
        misc[m + 1] = bl.tint[k];
      }
    }

    // Index buffer, matching the heightfield's diagonal exactly.
    const indices = new Uint32Array(CHUNK_CELLS * CHUNK_CELLS * 6);
    let p = 0;
    for (let j = 0; j < CHUNK_CELLS; j++) {
      for (let i = 0; i < CHUNK_CELLS; i++) {
        const v00 = j * vw + i;
        const v10 = v00 + 1;
        const v01 = v00 + vw;
        const v11 = v01 + 1;
        indices[p++] = v00; indices[p++] = v11; indices[p++] = v10;
        indices[p++] = v00; indices[p++] = v01; indices[p++] = v11;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('aBlend', new THREE.BufferAttribute(blend, 4));
    geo.setAttribute('aMisc', new THREE.BufferAttribute(misc, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * Fine ground detail multiplier, 0..1. Dropping this to 0 removes the
   * per-pixel micro relief and its two texture fetches.
   */
  setDetail(amount) {
    if (this.shader) this.shader.uniforms.uDetailFade.value = amount;
    if (this.clutter) this.clutter.setDensity(amount);
  }

  /** Retint the existing generated world after a planetary landing. */
  setPlanetTint(color) {
    this.planetTint.set(color);
    if (this.shader) this.shader.uniforms.uPlanetTint.value.copy(this.planetTint);
  }

  dispose() {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.meshes.length = 0;
    if (this.clutter) { this.clutter.dispose(); this.clutter = null; }
    // _rebuildWorld() drops a TerrainMesh and builds another on every seed
    // change, so the material and its compiled program have to go with it --
    // otherwise each new lobby leaks a shader program. The texture set itself
    // is cached in texturelab and shared, so it deliberately stays.
    this.material.dispose();
    this.scene.remove(this.group);
  }
}
