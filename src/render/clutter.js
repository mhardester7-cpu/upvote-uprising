// Ground clutter: grass tufts, dry weeds, pebbles and twigs.
//
// On open ground this is the single biggest realism win available -- a
// perfectly textured field still reads as a painted plane until something
// stands up off it and catches the light edge-on.
//
// Streaming model: a fixed ring of tiles centred on the camera, each tile
// owning a contiguous block of instances. When the camera crosses a tile
// boundary the tiles that fell off the back are re-seeded with the contents of
// the tiles that came on at the front, so the instance count is constant, no
// memory is allocated per frame, and only the rewritten span is re-uploaded.
// Contents are hashed from the tile's world coordinates, so revisiting a patch
// of ground finds the same grass.
//
// Nothing here touches the heightfield. Clutter is placed *on* the surface the
// collision code reports and never blocks anything: it is decoration, and a
// player who walks through it should feel nothing.

import * as THREE from '../../vendor/three.module.js';
import { SIZE, N } from '../world/heightfield.js';
import { grassCard, SQRT_MAP_FRAGMENT } from './texturelab.js';
import { getAtmosphereUniforms, ATMOSPHERE_PARS, AERIAL_FOG_FRAGMENT } from './sky.js';
import { onFrame } from './framehooks.js';

const TILE = 8;                 // metres per streaming tile
const RING = 5;                 // tiles from the centre; radius = TILE * RING
const GRID = RING * 2 + 1;      // 11 x 11 tiles
// ~1.7 tufts per square metre inside the ring. Below about one per square metre
// the ground shows through between them and reads as a lawn with weeds rather
// than as a sward.
const TUFTS_PER_TILE = 110;
const DEBRIS_PER_TILE = 8;

const GRASS_COUNT = GRID * GRID * TUFTS_PER_TILE;
const DEBRIS_COUNT = GRID * GRID * DEBRIS_PER_TILE;

/** Cheap deterministic hash; same shape as the world's, different constants. */
function hash(x, y, s) {
  let h = (x | 0) * 668265263 + (y | 0) * 374761393 + (s | 0) * 2246822519;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

// ------------------------------------------------------------------ geometry

/**
 * A tuft: two crossed cards, pivoted at the base.
 *
 * Normals point straight up rather than out of the card. Grass shaded by its
 * true card normal goes black on every blade edge-on to the sun; shading it as
 * if it were the ground it grows out of is both cheaper and closer to what a
 * dense sward actually looks like.
 */
function tuftGeometry() {
  const pos = [];
  const uv = [];
  const idx = [];
  const nrm = [];
  const planes = 2;
  for (let p = 0; p < planes; p++) {
    const a = (p / planes) * Math.PI;
    const cx = Math.cos(a) * 0.5, cz = Math.sin(a) * 0.5;
    const base = p * 4;
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let k = 0; k < 4; k++) nrm.push(0, 1, 0);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** A pebble: a squashed, lumpy icosahedron. */
function pebbleGeometry() {
  const g = new THREE.IcosahedronGeometry(0.5, 0);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = Math.sin(v.x * 17.3 + v.y * 9.1 + v.z * 5.7) * 0.5 + 0.5;
    v.multiplyScalar(0.72 + n * 0.5);
    v.y *= 0.62;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// -------------------------------------------------------------------- shader

export const WIND_PARS = /* glsl */`
  uniform float uTime;
  uniform vec2 uWindDir;
  uniform float uWindAmp;
  varying float vBlade;
  varying vec3 vWPos;
`;

// Replaces <project_vertex>. The sway has to be applied *after* the instance
// matrix, or every tuft leans along its own random yaw and the field looks like
// it is being stirred rather than blown.
export const WIND_PROJECT = /* glsl */`
  vec4 mvPosition = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
  #endif
  vWPos = (modelMatrix * mvPosition).xyz;
  float ph = vWPos.x * 0.33 + vWPos.z * 0.41;
  // Two detuned waves: one gust period, one flutter, so the motion never
  // settles into a visible beat.
  float sway = sin(uTime * 1.55 + ph) * 0.66 + sin(uTime * 0.81 + ph * 1.73) * 0.34;
  float amp = pow(clamp(vBlade, 0.0, 1.0), 1.8) * uWindAmp;
  mvPosition.xz += uWindDir * (sway * amp);
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;
`;

/**
 * Material for anything made of alpha-cut cards that moves in the wind: grass
 * tufts, weeds, tree foliage.
 *
 * @param {THREE.Texture|null} map sqrt-encoded albedo with a cutout alpha
 * @param {{alphaTest?:number, side?:number, windAmp?:number,
 *          roughness?:number, key?:string}} opts
 */
export function foliageMaterial(map, opts = {}) {
  const {
    alphaTest = 0.42, side = THREE.DoubleSide, windAmp = 0.11,
    roughness = 0.92, key = 'clutter',
  } = opts;
  const atm = getAtmosphereUniforms();
  const mat = new THREE.MeshStandardMaterial({
    map: map || null,
    color: 0xffffff,
    roughness,
    metalness: 0,
    side,
    alphaTest: map ? alphaTest : 0,
    transparent: false,
  });

  const uniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.82, 0.57) },
    uWindAmp: { value: windAmp },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.tSkyR = atm.tSkyR;
    shader.uniforms.tSkyM = atm.tSkyM;
    shader.uniforms.tSunT = atm.tSunT;
    shader.uniforms.uSunDir = atm.uSunDir;
    shader.uniforms.uSkyGain = atm.uSkyGain;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WIND_PARS}`)
      // The tuft geometry runs y = 0 at the base to y = 1 at the tip, so the
      // object-space height is the bend weight -- no uv attribute needed, which
      // keeps the same shader valid for the untextured debris.
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBlade = position.y;')
      .replace('#include <project_vertex>', WIND_PROJECT);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WIND_PARS}\n${ATMOSPHERE_PARS}`)
      .replace('#include <map_fragment>', SQRT_MAP_FRAGMENT)
      // Cards are double sided but shaded as ground, so the usual backface
      // normal flip has to go: it would light the far side of every blade as
      // though it were pointing at the floor.
      .replace('#include <normal_fragment_begin>', `
        float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
        vec3 normal = normalize(vNormal);
        vec3 nonPerturbedNormal = normal;
      `)
      .replace('#include <fog_fragment>', AERIAL_FOG_FRAGMENT);
  };
  mat.customProgramCacheKey = () => `${key}-${side}-${map ? 'cut' : 'solid'}`;
  return mat;
}

// ---------------------------------------------------------------- streaming

export class GroundClutter {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../world/heightfield.js').Heightfield} field
   * @param {{grass:Float32Array,dirt:Float32Array,sand:Float32Array,snow:Float32Array,rock:Float32Array}} blend
   *        the terrain's per-corner layer weights, so clutter only grows where
   *        the ground it is standing on actually looks like it should support it
   */
  constructor(scene, field, blend) {
    this.scene = scene;
    this.field = field;
    this.blend = blend;
    this.group = new THREE.Group();
    this.group.name = 'clutter';
    this.meshes = [];
    this.density = 1;
    this.unhook = null;

    // Tile coordinates currently held by each slot; NaN means "never filled".
    this.slotX = new Int32Array(GRID * GRID).fill(0x7fffffff);
    this.slotZ = new Int32Array(GRID * GRID).fill(0x7fffffff);
    this.centre = { x: 0x7fffffff, z: 0x7fffffff };

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
    this._n = {};
  }

  build() {
    const card = grassCard();

    this.grass = new THREE.InstancedMesh(tuftGeometry(), foliageMaterial(card), GRASS_COUNT);
    // Grass casting shadows costs an extra alpha-tested pass over thousands of
    // instances and buys almost nothing at this blade size; receiving them is
    // what actually matters, so tufts go dark under trees.
    this.grass.castShadow = false;
    this.grass.receiveShadow = true;
    this.grass.frustumCulled = false;
    this.grass.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.debris = new THREE.InstancedMesh(
      pebbleGeometry(),
      foliageMaterial(null, { side: THREE.FrontSide, windAmp: 0, key: 'debris' }),
      DEBRIS_COUNT,
    );
    this.debris.castShadow = false;
    this.debris.receiveShadow = true;
    this.debris.frustumCulled = false;
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (const m of [this.grass, this.debris]) {
      // Allocate the colour attribute up front; setColorAt on a null attribute
      // allocates lazily and would stall on the first tile refresh.
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(m.count * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
      this.meshes.push(m);
    }

    this.scene.add(this.group);

    // Park every instance at zero scale so nothing pops in before the first
    // camera position is known.
    this._m.makeScale(0, 0, 0);
    for (let i = 0; i < GRASS_COUNT; i++) this.grass.setMatrixAt(i, this._m);
    for (let i = 0; i < DEBRIS_COUNT; i++) this.debris.setMatrixAt(i, this._m);
    this.grass.instanceMatrix.needsUpdate = true;
    this.debris.instanceMatrix.needsUpdate = true;

    this.unhook = onFrame((ctx) => this.update(ctx.camera, ctx.time));
  }

  /** Sample the terrain's blend weights at a world position. */
  _weights(x, z, out) {
    const w = N + 1;
    const i = Math.max(0, Math.min(N, Math.round(x)));
    const j = Math.max(0, Math.min(N, Math.round(z)));
    const k = j * w + i;
    out.grass = this.blend.grass[k];
    out.dirt = this.blend.dirt[k];
    out.rock = this.blend.rock[k];
    out.snow = this.blend.snow[k];
    out.sand = this.blend.sand[k];
    return out;
  }

  /**
   * Re-seed one tile.
   * @returns {[number, number]} the instance range touched, per mesh kind
   */
  _fillTile(slot, tx, tz) {
    const f = this.field;
    const M = this._m, Q = this._q, E = this._e, P = this._p, S = this._s, C = this._c;
    const wts = this._n;
    const ox = tx * TILE, oz = tz * TILE;

    const g0 = slot * TUFTS_PER_TILE;
    for (let i = 0; i < TUFTS_PER_TILE; i++) {
      const rx = hash(tx * 73856093 + i, tz, 17);
      const rz = hash(tx, tz * 19349663 + i, 29);
      const x = ox + rx * TILE;
      const z = oz + rz * TILE;

      let ok = x > 0.5 && z > 0.5 && x < SIZE - 0.5 && z < SIZE - 0.5;
      let scale = 0;
      if (ok) {
        const n = f.normalAt(x, z, wts.n || (wts.n = {}));
        this._weights(x, z, wts);
        // Density follows the grass layer, with a little dry growth allowed on
        // bare earth; nothing grows on rock, snow or anything steep.
        const cover = wts.grass + wts.dirt * 0.22;
        const steep = 1 - n.y;
        const roll = hash(tx * 83492791 + i, tz * 6151, 41);
        ok = n.y > 0.72 && roll < cover * this.density * 1.15
          && wts.snow < 0.3 && wts.rock < 0.35;
        if (ok) {
          const sz = 0.24 + hash(i, tx * 31 + tz, 53) * 0.26;
          const tall = 0.22 + hash(i, tx + tz * 37, 59) * 0.30;
          scale = sz;
          E.set(0, hash(i, tx * 7 + tz * 13, 67) * Math.PI * 2, 0);
          Q.setFromEuler(E);
          // Sunk very slightly so the card's bottom edge is never visible
          // hovering over a slope.
          P.set(x, f.heightAt(x, z) - 0.03 - steep * 0.12, z);
          S.set(sz, tall, sz);
          M.compose(P, Q, S);

          // Colour drifts toward straw where the ground is dry and toward a
          // deeper green where the grass layer is strong. The spread matters
          // more than the midpoint: a field of tufts all the same green is the
          // single clearest tell that they came out of one instanced mesh.
          const dry = Math.min(1, (1 - Math.min(1, wts.grass * 1.25))
            + (hash(i, tx * 17 + tz * 23, 79) - 0.5) * 0.55);
          const v = 0.62 + hash(i, tx * 11 + tz * 3, 71) * 0.72;
          C.setRGB(
            (0.62 + Math.max(0, dry) * 0.70) * v,
            (0.98 - Math.max(0, dry) * 0.14) * v,
            (0.48 - Math.max(0, dry) * 0.22) * v,
          );
          this.grass.setColorAt(g0 + i, C);
        }
      }
      if (scale === 0) M.makeScale(0, 0, 0);
      this.grass.setMatrixAt(g0 + i, M);
    }

    const d0 = slot * DEBRIS_PER_TILE;
    for (let i = 0; i < DEBRIS_PER_TILE; i++) {
      const rx = hash(tx * 2654435761 + i, tz, 83);
      const rz = hash(tx, tz * 40503 + i, 97);
      const x = ox + rx * TILE;
      const z = oz + rz * TILE;

      let placed = false;
      if (x > 0.5 && z > 0.5 && x < SIZE - 0.5 && z < SIZE - 0.5) {
        const n = f.normalAt(x, z, this._n.n || (this._n.n = {}));
        this._weights(x, z, wts);
        // Stones collect where the soil is bare or the ground is stony.
        const cover = wts.dirt * 0.8 + wts.rock + wts.sand * 0.4;
        const roll = hash(tx * 101 + i, tz * 103, 109);
        if (n.y > 0.66 && roll < cover * this.density && wts.snow < 0.4) {
          const sz = 0.10 + hash(i, tx * 5 + tz, 113) * 0.26;
          E.set(hash(i, tx, 127) * 3.0, hash(i, tz, 131) * 6.3, hash(i, tx + tz, 137) * 3.0);
          Q.setFromEuler(E);
          P.set(x, f.heightAt(x, z) - sz * 0.28, z);
          S.set(sz, sz * 0.82, sz * 1.1);
          M.compose(P, Q, S);
          const v = 0.55 + hash(i, tx * 3 + tz * 5, 139) * 0.7;
          C.setRGB(0.085 * v, 0.079 * v, 0.070 * v);
          this.debris.setColorAt(d0 + i, C);
          placed = true;
        }
      }
      if (!placed) M.makeScale(0, 0, 0);
      this.debris.setMatrixAt(d0 + i, M);
    }
  }

  /**
   * Re-centre the ring on the camera and animate the wind.
   * Wired automatically through framehooks.js; safe to call directly too.
   */
  update(camera, time) {
    if (!this.grass || !camera) return;

    for (const m of this.meshes) {
      const u = m.material.userData.uniforms;
      if (u) u.uTime.value = time;
    }

    const cx = Math.round(camera.position.x / TILE);
    const cz = Math.round(camera.position.z / TILE);
    if (cx === this.centre.x && cz === this.centre.z) return;
    this.centre.x = cx;
    this.centre.z = cz;

    let gMin = Infinity, gMax = -Infinity, dMin = Infinity, dMax = -Infinity;

    for (let j = -RING; j <= RING; j++) {
      for (let i = -RING; i <= RING; i++) {
        const tx = cx + i, tz = cz + j;
        // Toroidal slot mapping: a tile always lands in the same slot, so
        // scrolling only ever rewrites the tiles that actually changed.
        const sx = ((tx % GRID) + GRID) % GRID;
        const sz = ((tz % GRID) + GRID) % GRID;
        const slot = sz * GRID + sx;
        if (this.slotX[slot] === tx && this.slotZ[slot] === tz) continue;
        this.slotX[slot] = tx;
        this.slotZ[slot] = tz;
        this._fillTile(slot, tx, tz);
        gMin = Math.min(gMin, slot * TUFTS_PER_TILE);
        gMax = Math.max(gMax, (slot + 1) * TUFTS_PER_TILE);
        dMin = Math.min(dMin, slot * DEBRIS_PER_TILE);
        dMax = Math.max(dMax, (slot + 1) * DEBRIS_PER_TILE);
      }
    }

    if (gMax > gMin) {
      // Upload only the span that moved; a full re-upload of every instance
      // matrix on each tile crossing is 400KB of pointless bus traffic.
      setRange(this.grass.instanceMatrix, gMin * 16, (gMax - gMin) * 16);
      setRange(this.grass.instanceColor, gMin * 3, (gMax - gMin) * 3);
      setRange(this.debris.instanceMatrix, dMin * 16, (dMax - dMin) * 16);
      setRange(this.debris.instanceColor, dMin * 3, (dMax - dMin) * 3);
    }
  }

  /**
   * Clutter density, 0..1. The cheapest meaningful quality dial in the scene:
   * 0 removes two instanced draw calls and ~30k triangles.
   */
  setDensity(amount) {
    this.density = Math.max(0, Math.min(1, amount));
    // Force a full re-seed on the next update.
    this.slotX.fill(0x7fffffff);
    this.centre.x = 0x7fffffff;
    for (const m of this.meshes) m.visible = this.density > 0;
  }

  /** Wind strength in metres of tip deflection. */
  setWind(amp, dirX = 0.82, dirZ = 0.57) {
    for (const m of this.meshes) {
      const u = m.material.userData.uniforms;
      if (!u) continue;
      u.uWindAmp.value = amp;
      u.uWindDir.value.set(dirX, dirZ);
    }
  }

  dispose() {
    if (this.unhook) { this.unhook(); this.unhook = null; }
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
      m.dispose();
    }
    this.meshes.length = 0;
    this.scene.remove(this.group);
  }
}

function setRange(attr, offset, count) {
  if (!attr) return;
  // r160 replaced the single updateRange with a list; support both so this
  // keeps working if the vendored three is bumped.
  if (attr.addUpdateRange) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(offset, count);
  } else if (attr.updateRange) {
    attr.updateRange.offset = offset;
    attr.updateRange.count = count;
  }
  attr.needsUpdate = true;
}
