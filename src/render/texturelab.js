// Procedural material textures, baked on the CPU into typed arrays.
//
// There is no asset pipeline here, so every surface in the game is generated
// from noise at load time. Two decisions shape this module:
//
//   1. Nothing touches `document`. Textures are built straight into typed
//      arrays and handed to DataTexture/DataArrayTexture, so the render modules
//      stay importable in a headless test process.
//
//   2. The noise is *tileable*. A texture that repeats across a 256m terrain
//      with a visible seam every tile is worse than no texture at all, so the
//      lattice hash wraps at a period that doubles with each octave.
//
// Albedo is stored as sqrt(linear) rather than sRGB or raw linear: sqrt spends
// the 8 bits roughly where sRGB does, and decoding is a single multiply in the
// shader instead of a pow.

import * as THREE from '../../vendor/three.module.js';

// ------------------------------------------------------------------- noise

function ihash(x, y, s) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (s | 0) * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise on a lattice that wraps every `p` units. */
function vnoise(x, y, p, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = fade(x - xi), yf = fade(y - yi);
  const x0 = ((xi % p) + p) % p, y0 = ((yi % p) + p) % p;
  const x1 = (x0 + 1) % p, y1 = (y0 + 1) % p;
  const a = ihash(x0, y0, s), b = ihash(x1, y0, s);
  const c = ihash(x0, y1, s), d = ihash(x1, y1, s);
  const t = a + (b - a) * xf;
  const u = c + (d - c) * xf;
  return t + (u - t) * yf;
}

// A hard rule for everything below: no term inside a tiling texture may run
// slower than about six cycles across the tile. A two- or three-cycle fBm is
// not "large-scale variation", it *is* the tile, and it shows up in-game as
// corduroy stripes marching across the ground at the repeat distance. All the
// genuinely large-scale variation comes from world-space sources instead -- the
// coarse detail layer at 23m and the per-vertex tint at ~48m -- neither of
// which repeats.

/** Tileable fBm. `p` is the period at the base octave. */
export function fbmT(x, y, p, s, oct = 4, gain = 0.5) {
  let v = 0, n = 0, a = 1, f = 1;
  for (let i = 0; i < oct; i++) {
    v += a * vnoise(x * f, y * f, p * f, s + i * 7919);
    n += a;
    a *= gain;
    f *= 2;
  }
  return v / n;
}

/** Ridged variant -- creases instead of blobs; reads as cracks and strata. */
export function ridgeT(x, y, p, s, oct = 4) {
  let v = 0, n = 0, a = 1, f = 1;
  for (let i = 0; i < oct; i++) {
    const r = 1 - Math.abs(vnoise(x * f, y * f, p * f, s + i * 5417) * 2 - 1);
    v += a * r * r;
    n += a;
    a *= 0.5;
    f *= 2;
  }
  return v / n;
}

/**
 * Tileable cellular (Worley) F1 distance. Used for pebbles and gravel, where
 * value noise reads as fog rather than discrete stones.
 */
export function cellT(x, y, p, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  let best = 4;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ((xi + i) % p + p) % p, cy = ((yi + j) % p + p) % p;
      const px = i + ihash(cx, cy, s);
      const py = j + ihash(cx, cy, s + 101);
      const dx = px - xf, dy = py - yf;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best));
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, t) => {
  const x = clamp01((t - a) / (b - a));
  return x * x * (3 - 2 * x);
};
const mix = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------- baking

/**
 * Bake one material layer.
 *
 * @param {number} size texture side in texels
 * @param {(u:number,v:number,o:object)=>void} gen fills
 *        {r,g,b} linear albedo, {h} height 0..1, {rough}, {ao}
 * @param {number} bump normal-map strength
 * @param {Uint8Array} alb destination albedo (RGB = sqrt(linear), A = height)
 * @param {Uint8Array} srf destination surface (RG = normal xy, B = rough, A = ao)
 * @param {number} off texel offset into the destinations (for array layers)
 */
export function bakeLayer(size, gen, bump, alb, srf, off = 0) {
  const H = new Float32Array(size * size);
  const o = { r: 0.5, g: 0.5, b: 0.5, h: 0.5, rough: 0.9, ao: 1 };
  const enc = (v) => Math.max(0, Math.min(255, Math.round(Math.sqrt(clamp01(v)) * 255)));

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      o.r = 0.5; o.g = 0.5; o.b = 0.5; o.h = 0.5; o.rough = 0.9; o.ao = 1;
      gen(i / size, j / size, o);
      const k = j * size + i;
      H[k] = o.h;
      const p = (off + k) * 4;
      alb[p] = enc(o.r); alb[p + 1] = enc(o.g); alb[p + 2] = enc(o.b);
      alb[p + 3] = Math.round(clamp01(o.h) * 255);
      srf[p + 2] = Math.round(clamp01(o.rough) * 255);
      srf[p + 3] = Math.round(clamp01(o.ao) * 255);
    }
  }

  // Central differences on the wrapped height field, encoded as a two-channel
  // tangent-space normal; the shader rebuilds z.
  const m = size - 1;
  for (let j = 0; j < size; j++) {
    const jm = (j + m) % size, jp = (j + 1) % size;
    for (let i = 0; i < size; i++) {
      const im = (i + m) % size, ip = (i + 1) % size;
      const dx = (H[j * size + ip] - H[j * size + im]) * bump;
      const dy = (H[jp * size + i] - H[jm * size + i]) * bump;
      const len = Math.hypot(dx, dy, 1);
      const p = (off + j * size + i) * 4;
      srf[p] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      srf[p + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
    }
  }
}

function arrayTexture(data, size, depth) {
  const t = new THREE.DataArrayTexture(data, size, size, depth);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

export function plainTexture(data, w, h, { srgbSqrt = true, repeat = true } = {}) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  if (!srgbSqrt) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------- terrain layer set

/**
 * Layer indices in the terrain texture array. The order is load-bearing: the
 * terrain shader's blend weights are indexed by these.
 */
export const LAYER = {
  GRASS: 0,
  DIRT: 1,
  ROCK: 2,
  SAND: 3,
  SNOW: 4,
  DETAIL: 5,
};
export const LAYER_COUNT = 6;

/** World metres per texture repeat, per layer. */
export const LAYER_SCALE = [2.4, 2.0, 3.2, 2.8, 3.6, 1.0];

// -- Dry grass and turf. Streaked, because blades lie down in a direction, and
// crosshatched by a second streak field so the lie is not uniform.
function genGrass(u, v, o) {
  const blade = fbmT(u * 44, v * 11, 44, 11, 3, 0.55);
  const blade2 = fbmT(v * 40 + 3.3, u * 12, 40, 23, 3, 0.55);
  const clump = fbmT(u * 9, v * 9, 9, 31, 3);
  const patch = fbmT(u * 7, v * 7, 7, 47, 2);

  const h = clamp01(mix(blade, blade2, 0.45) * 0.9 + clump * 0.5 - 0.20);
  // Dry khaki through to a damper green, driven by the broad patch noise.
  const dry = clamp01(patch * 1.5 - 0.25);
  const r = mix(0.135, 0.300, dry);
  const g = mix(0.195, 0.285, dry);
  const b = mix(0.062, 0.098, dry);
  // Gaps between blades show the soil beneath.
  const soil = smooth(0.45, 0.05, h);
  const lit = 0.50 + 0.95 * h;
  o.r = mix(r, 0.098, soil) * lit;
  o.g = mix(g, 0.076, soil) * lit;
  o.b = mix(b, 0.052, soil) * lit;
  o.h = h;
  o.rough = 0.86 - h * 0.10;
  o.ao = 0.40 + 0.60 * clamp01(h * 1.3);
}

// -- Packed earth with small stones trodden into it.
function genDirt(u, v, o) {
  const grain = fbmT(u * 40, v * 40, 40, 61, 4, 0.55);
  const lumps = fbmT(u * 10, v * 10, 10, 71, 3);
  const stones = 1 - cellT(u * 14, v * 14, 14, 83);
  const stoneMask = smooth(0.55, 0.86, stones);
  const crack = 1 - ridgeT(u * 6, v * 6, 6, 97, 3);

  let h = clamp01(lumps * 0.55 + grain * 0.3 + stoneMask * 0.5 - crack * 0.18);
  const tone = clamp01(lumps * 1.2 - 0.1);
  let r = mix(0.105, 0.215, tone);
  let g = mix(0.072, 0.150, tone);
  let b = mix(0.048, 0.094, tone);
  // Stones read cooler and lighter than the soil holding them.
  r = mix(r, 0.190, stoneMask * 0.85);
  g = mix(g, 0.183, stoneMask * 0.85);
  b = mix(b, 0.166, stoneMask * 0.85);
  const dark = 0.62 + 0.62 * grain;
  o.r = r * dark; o.g = g * dark; o.b = b * dark;
  o.h = h;
  o.rough = mix(0.94, 0.72, stoneMask);
  o.ao = 0.55 + 0.45 * clamp01(h * 1.4);
}

// -- Fractured stone: strata, cracks and a little quartz.
function genRock(u, v, o) {
  const strata = fbmT(u * 7, v * 17, 7, 131, 4, 0.6);
  const crack = ridgeT(u * 8, v * 8, 8, 149, 4);
  const grain = fbmT(u * 48, v * 48, 48, 163, 3, 0.55);
  const chip = cellT(u * 11, v * 11, 11, 179);

  const crackMask = smooth(0.62, 0.94, crack);
  const h = clamp01(0.34 + strata * 0.42 + chip * 0.3 + grain * 0.16 - crackMask * 0.62);

  const tone = clamp01(strata * 1.25 - 0.12);
  let r = mix(0.082, 0.205, tone);
  let g = mix(0.079, 0.198, tone);
  let b = mix(0.075, 0.186, tone);
  // Quartz flecks: sparse, bright, and slightly smoother than the matrix.
  const quartz = smooth(0.90, 0.98, grain);
  r = mix(r, 0.38, quartz); g = mix(g, 0.38, quartz); b = mix(b, 0.37, quartz);
  const shade = 1 - crackMask * 0.58;
  o.r = r * shade; o.g = g * shade; o.b = b * shade;
  o.h = h;
  o.rough = mix(0.80, 0.52, quartz) - crackMask * 0.06;
  o.ao = 0.4 + 0.6 * clamp01(h * 1.2);
}

// -- Wind-rippled sand.
function genSand(u, v, o) {
  const wobble = fbmT(u * 7, v * 7, 7, 211, 3);
  const ripple = 0.5 + 0.5 * Math.sin((v * 18 + wobble * 5.0) * Math.PI * 2);
  const grain = fbmT(u * 90, v * 90, 90, 223, 2, 0.5);
  const dune = fbmT(u * 9, v * 9, 9, 233, 3);

  const h = clamp01(ripple * 0.42 + dune * 0.42 + grain * 0.16);
  const tone = clamp01(dune * 1.3 - 0.1);
  const base = 0.62 + 0.42 * h;
  o.r = mix(0.235, 0.330, tone) * base;
  o.g = mix(0.186, 0.264, tone) * base;
  o.b = mix(0.118, 0.170, tone) * base;
  o.h = h;
  o.rough = 0.95 - grain * 0.06;
  o.ao = 0.72 + 0.28 * h;
}

// -- Wind-packed snow with a crust.
function genSnow(u, v, o) {
  const dune = fbmT(u * 8, v * 8, 8, 251, 4, 0.55);
  const crust = fbmT(u * 22, v * 22, 22, 269, 3, 0.5);
  const sparkle = fbmT(u * 120, v * 120, 120, 277, 1);

  const h = clamp01(dune * 0.72 + crust * 0.34 - 0.06);
  const shade = 0.72 + 0.34 * h;
  const glint = smooth(0.86, 0.99, sparkle);
  o.r = (0.60 + glint * 0.35) * shade;
  o.g = (0.64 + glint * 0.34) * shade;
  o.b = (0.72 + glint * 0.30) * shade;
  o.h = h;
  o.rough = mix(0.55, 0.18, glint);
  o.ao = 0.80 + 0.20 * h;
}

// -- Neutral break-up layer, sampled at two very different scales.
function genDetail(u, v, o) {
  // The one exception to the six-cycle rule: this layer is sampled at 23m as
  // well as 0.85m, and at that scale a four-cycle blob is a 6m patch of
  // discolouration -- exactly the large-scale variation the tiled layers are
  // forbidden from carrying themselves.
  const broad = fbmT(u * 4, v * 4, 4, 313, 2);
  const fine = fbmT(u * 32, v * 32, 32, 307, 4, 0.55);
  const pebble = 1 - cellT(u * 11, v * 11, 11, 311);
  const h = clamp01(fine * 0.6 + smooth(0.6, 0.95, pebble) * 0.55);
  const g = 0.5 + (fine - 0.5) * 0.42 + (broad - 0.5) * 0.34;
  o.r = g; o.g = g; o.b = g;
  o.h = h;
  o.rough = 0.5 + (fine - 0.5) * 0.4;
  o.ao = 0.7 + 0.3 * h;
}

const LAYER_GEN = [
  [genGrass, 3.2],
  [genDirt, 3.6],
  [genRock, 5.5],
  [genSand, 2.2],
  [genSnow, 2.4],
  [genDetail, 3.0],
];

let terrainSet = null;
const bakedBytes = new Map();

/**
 * Bake the terrain layers to raw bytes.
 *
 * Exposed separately from the textures because photosets.js overwrites
 * individual layers with photographed surfaces before the arrays are uploaded.
 * Working from the baked bytes rather than from nothing is what lets a
 * half-installed art pack degrade one layer at a time: any layer the art pack
 * does not cover keeps the procedural bake underneath it.
 *
 * @returns {{albedo:Uint8Array, surface:Uint8Array, size:number}}
 */
export function bakeTerrainBytes(size = 256) {
  if (bakedBytes.has(size)) return bakedBytes.get(size);
  const texels = size * size;
  const albedo = new Uint8Array(texels * LAYER_COUNT * 4);
  const surface = new Uint8Array(texels * LAYER_COUNT * 4);
  for (let l = 0; l < LAYER_COUNT; l++) {
    const [gen, bump] = LAYER_GEN[l];
    bakeLayer(size, gen, bump, albedo, surface, l * texels);
  }
  const out = { albedo, surface, size };
  bakedBytes.set(size, out);
  return out;
}

/**
 * Build (once) the terrain texture arrays.
 *
 * @param {number} size texels per side; 256 costs roughly 150ms to bake.
 * @returns {{albedo:THREE.DataArrayTexture, surface:THREE.DataArrayTexture}}
 */
export function terrainTextures(size = 256) {
  if (terrainSet) return terrainSet;
  const { albedo, surface } = bakeTerrainBytes(size);
  terrainSet = {
    albedo: arrayTexture(albedo, size, LAYER_COUNT),
    surface: arrayTexture(surface, size, LAYER_COUNT),
  };
  return terrainSet;
}

// --------------------------------------------------------------- prop maps

function bakePair(size, gen, bump) {
  const alb = new Uint8Array(size * size * 4);
  const srf = new Uint8Array(size * size * 4);
  bakeLayer(size, gen, bump, alb, srf, 0);
  return {
    albedo: plainTexture(alb, size, size),
    surface: plainTexture(srf, size, size),
  };
}

// -- Bark. Vertical fissures, so it is generated stretched along v.
function genBark(u, v, o) {
  const fissure = ridgeT(u * 9, v * 2.2, 9, 401, 4);
  const grain = fbmT(u * 30, v * 7, 30, 409, 3, 0.55);
  const knot = fbmT(u * 6, v * 6, 6, 419, 2);
  const deep = smooth(0.42, 0.95, fissure);

  const h = clamp01(0.55 + grain * 0.35 - deep * 0.75);
  const tone = clamp01(knot * 1.3 - 0.15);
  const shade = 0.38 + 0.85 * h;
  o.r = mix(0.140, 0.235, tone) * shade;
  o.g = mix(0.100, 0.166, tone) * shade;
  o.b = mix(0.070, 0.112, tone) * shade;
  // Moss creeps into the fissures on the shaded side of the trunk.
  const moss = smooth(0.55, 0.95, deep) * smooth(0.35, 0.75, knot);
  o.r = mix(o.r, 0.070, moss * 0.8);
  o.g = mix(o.g, 0.110, moss * 0.8);
  o.b = mix(o.b, 0.048, moss * 0.8);
  o.h = h;
  o.rough = 0.92 - deep * 0.05;
  o.ao = 0.35 + 0.65 * clamp01(h * 1.25);
}

// -- Weathered concrete: exposed aggregate, stains, pitting.
function genConcrete(u, v, o) {
  const agg = 1 - cellT(u * 16, v * 16, 16, 503);
  const pit = cellT(u * 30, v * 30, 30, 509);
  const stain = fbmT(u * 6, v * 6, 6, 521, 4, 0.6);
  const grime = fbmT(u * 12, v * 12, 12, 523, 3);

  const aggMask = smooth(0.62, 0.9, agg);
  const pitMask = smooth(0.30, 0.05, pit);
  const h = clamp01(0.62 + aggMask * 0.3 - pitMask * 0.7 + grime * 0.12);

  const base = mix(0.200, 0.320, clamp01(stain * 1.4 - 0.2));
  let r = base * 1.00, g = base * 0.99, b = base * 0.94;
  // Aggregate is darker and slightly warmer than the cement around it.
  r = mix(r, 0.130, aggMask * 0.7); g = mix(g, 0.123, aggMask * 0.7); b = mix(b, 0.112, aggMask * 0.7);
  // Rain streaks and dirt collecting in the pits.
  const dirty = clamp01(grime * 1.4 - 0.35) + pitMask * 0.5;
  r = mix(r, 0.088, clamp01(dirty) * 0.6);
  g = mix(g, 0.074, clamp01(dirty) * 0.6);
  b = mix(b, 0.058, clamp01(dirty) * 0.6);
  o.r = r; o.g = g; o.b = b;
  o.h = h;
  o.rough = 0.90 - aggMask * 0.08;
  o.ao = 0.45 + 0.55 * clamp01(h * 1.3);
}

// -- Rough sawn planks with rusted banding and split grain.
function genPlank(u, v, o) {
  const PLANKS = 5;
  const band = v * PLANKS;
  const bi = Math.floor(band);
  const bf = band - bi;
  const jitter = ihash(bi, 7, 601);
  const grain = fbmT(u * 26 + jitter * 10, (bi + bf * 0.35) * 4, 26, 607, 4, 0.55);
  const split = ridgeT(u * 18 + jitter * 5, v * 3, 18, 613, 3);
  const wear = fbmT(u * 6, v * 6, 6, 617, 3);

  // Gap between planks: a dark, deep groove.
  const gap = Math.min(smooth(0.0, 0.06, bf), smooth(1.0, 0.94, bf));
  const h = clamp01((0.55 + grain * 0.4 + smooth(0.6, 0.95, split) * 0.2) * gap);

  const tone = clamp01(grain * 1.3 - 0.15 + jitter * 0.25);
  const shade = (0.45 + 0.75 * h) * (0.72 + 0.42 * gap);
  o.r = mix(0.165, 0.300, tone) * shade;
  o.g = mix(0.103, 0.187, tone) * shade;
  o.b = mix(0.056, 0.103, tone) * shade;
  // Weathering greys the exposed face.
  const grey = clamp01(wear * 1.5 - 0.5);
  o.r = mix(o.r, 0.140, grey * 0.5);
  o.g = mix(o.g, 0.132, grey * 0.5);
  o.b = mix(o.b, 0.118, grey * 0.5);
  o.h = h;
  o.rough = 0.88 + grain * 0.08;
  o.ao = 0.30 + 0.70 * clamp01(h * 1.2);
}

// -- Pitted, rusted steel.
function genRust(u, v, o) {
  const pit = 1 - cellT(u * 13, v * 13, 13, 701);
  const flake = fbmT(u * 20, v * 20, 20, 709, 4, 0.6);
  const patch = fbmT(u * 7, v * 7, 7, 719, 3);

  const rusted = clamp01(patch * 1.6 - 0.3 + flake * 0.35);
  const pitMask = smooth(0.55, 0.9, pit) * rusted;
  const h = clamp01(0.7 - pitMask * 0.6 + flake * 0.18);

  // Bare steel where the rust has not taken; orange oxide where it has.
  const steel = [0.170, 0.178, 0.190];
  const oxide = [0.225, 0.092, 0.036];
  const t = clamp01(rusted * 1.2);
  o.r = mix(steel[0], oxide[0], t) * (0.6 + 0.6 * h);
  o.g = mix(steel[1], oxide[1], t) * (0.6 + 0.6 * h);
  o.b = mix(steel[2], oxide[2], t) * (0.6 + 0.6 * h);
  o.h = h;
  o.rough = mix(0.42, 0.95, t);
  o.ao = 0.45 + 0.55 * clamp01(h * 1.3);
}

const propCache = new Map();
function cached(key, build) {
  let v = propCache.get(key);
  if (!v) { v = build(); propCache.set(key, v); }
  return v;
}

export const barkTextures = () => cached('bark', () => bakePair(256, genBark, 4.5));
export const rockTextures = () => cached('rockprop', () => bakePair(256, genRock, 5.0));
export const concreteTextures = () => cached('concrete', () => bakePair(256, genConcrete, 3.0));
export const plankTextures = () => cached('plank', () => bakePair(256, genPlank, 4.0));
export const rustTextures = () => cached('rust', () => bakePair(128, genRust, 3.5));

// ------------------------------------------------------------ alpha cutouts

/**
 * A leaf-cluster card: RGB is a leaf-green albedo, A is the cutout mask.
 *
 * Alpha-cut cards are the whole reason foliage stops looking like a solid blob.
 * The mask is a scatter of ellipse leaves rather than noise, because a noise
 * cutout reads as a torn rag at any distance.
 */
export function leafCard(size = 128) {
  return cached('leaf', () => {
    const data = new Uint8Array(size * size * 4);
    const LEAVES = 46;
    const leaves = [];
    for (let i = 0; i < LEAVES; i++) {
      const a = ihash(i, 1, 811), b = ihash(i, 2, 811), c = ihash(i, 3, 811);
      const d = ihash(i, 4, 811), e = ihash(i, 5, 811);
      // Bias toward the middle so the card silhouette is a cluster, not a grid.
      leaves.push({
        x: 0.5 + (a - 0.5) * 0.92,
        y: 0.5 + (b - 0.5) * 0.92,
        rx: 0.055 + c * 0.055,
        ry: 0.030 + d * 0.032,
        rot: e * Math.PI * 2,
        tone: ihash(i, 6, 811),
      });
    }

    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const u = (i + 0.5) / size, v = (j + 0.5) / size;
        let a = 0, tone = 0.5, depth = 0;
        for (const L of leaves) {
          const dx = u - L.x, dy = v - L.y;
          const cs = Math.cos(L.rot), sn = Math.sin(L.rot);
          const px = (dx * cs + dy * sn) / L.rx;
          const py = (-dx * sn + dy * cs) / L.ry;
          const r = px * px + py * py;
          if (r < 1) {
            a = 1;
            depth += 1;
            tone = L.tone;
            // Midrib: a slightly darker line down the leaf.
            if (Math.abs(py) < 0.16) tone *= 0.72;
          }
        }
        // Radial fade of the cluster keeps the card from ending on a hard edge.
        const rad = Math.hypot(u - 0.5, v - 0.5) * 2;
        if (rad > 0.98) a = 0;

        const k = (j * size + i) * 4;
        // Overlapping leaves darken, but only so far: a canopy interior that
        // goes to black reads as a hole punched in the tree.
        const shade = 0.66 + 0.34 * (1 - Math.min(1, (depth - 1) * 0.35));
        const g = mix(0.105, 0.235, tone) * shade;
        const enc = (x) => Math.round(Math.sqrt(clamp01(x)) * 255);
        data[k] = enc(g * 0.58);
        data[k + 1] = enc(g);
        data[k + 2] = enc(g * 0.30);
        data[k + 3] = a > 0 ? 255 : 0;
      }
    }
    const t = plainTexture(data, size, size, { repeat: false });
    return t;
  });
}

/**
 * A conifer sprig card: needles leaving a central stem in opposed pairs.
 *
 * A separate texture from leafCard because the broadleaf ellipses are the wrong
 * shape at a pine's scale -- a pine crown built from leaf clusters reads as a
 * dying oak. The needles are drawn as tapered segments off a woody stem, and
 * they are paired rather than scattered because the regular herringbone is the
 * cue that says "conifer" before any colour does.
 *
 * Runs darker and bluer than leafCard: pine holds far less light than a summer
 * broadleaf, and that value gap is what keeps the two species apart in a mixed
 * stand once both are alpha-cut cards.
 */
export function needleCard(size = 256) {
  return cached('needle', () => {
    const data = new Uint8Array(size * size * 4);

    // A whole branch spray, not a single sprig. This card covers 1.5-3m of
    // crown in world space, so one stem's worth of needles drawn across it puts
    // metre-long needles on the tree and the pine comes out looking like a fern.
    // Five sub-stems fanning off a main axis, each carrying many short needles,
    // is what gives the fine dense texture a conifer actually has at this range.
    //
    // Needles are spaced closer than their own width on purpose. Individually
    // drawn hairline needles are the obvious way to build this and it does not
    // work: at one texel wide they average away under the first mip and the
    // crown disappears entirely past ~20m, because alphaTest 0.5 then fails
    // everywhere. Overlapping them into a continuous band with serrated edges
    // keeps a solid interior at every mip level and leaves the needle detail
    // where it actually reads -- on the silhouette.
    const STEMS = 5;
    const PER_STEM = 24;
    const stems = [];
    const needles = [];
    for (let s = 0; s < STEMS; s++) {
      const g = (s + 0.5) / STEMS;             // 0 lowest sub-stem, 1 highest
      const sa = ihash(s, 7, 613);
      // Sub-stems leave the main axis alternately left and right.
      const sgn0 = s % 2 === 0 ? 1 : -1;
      const fan = (0.50 + sa * 0.30) * sgn0;
      const slen = 0.30 - g * 0.14;
      const bx = 0.5, by = 0.06 + g * 0.62;
      const ex = bx + Math.sin(fan) * slen, ey = by + Math.cos(fan) * slen;
      stems.push({ bx, by, ex, ey });

      for (let i = 0; i < PER_STEM; i++) {
        const f = (i + 0.5) / PER_STEM;
        const a = ihash(s * 31 + i, 1, 613), b = ihash(s * 31 + i, 2, 613);
        // ~11% of the card, so on a 2m card these land near 20cm.
        const len = (0.115 - f * 0.045) * (0.82 + a * 0.40);
        const lift = 0.70 + b * 0.40;
        const nx = bx + (ex - bx) * f, ny = by + (ey - by) * f;
        for (const sgn of [-1, 1]) {
          needles.push({
            x0: nx, y0: ny,
            dx: sgn * Math.sin(fan + sgn * lift) * len,
            dy: Math.cos(fan + sgn * lift) * len,
            wid: 0.0125 + a * 0.0050,
            tone: ihash(s * 31 + i, sgn > 0 ? 3 : 4, 613),
          });
        }
      }
    }

    const segHit = (u, v, ax, ay, bx, by, w) => {
      const px = u - ax, py = v - ay;
      const dx = bx - ax, dy = by - ay;
      const L2 = dx * dx + dy * dy;
      let s = (px * dx + py * dy) / L2;
      s = clamp01(s);
      return Math.hypot(px - dx * s, py - dy * s) < w;
    };

    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const u = (i + 0.5) / size, v = (j + 0.5) / size;
        let alpha = 0, tone = 0.5, woody = false;

        // The woody axis and the sub-stems it carries. Kept thin: at this card's
        // world size anything thicker reads as a branch glued across the crown.
        if (Math.abs(u - 0.5) < 0.010 && v > 0.03 && v < 0.72) {
          alpha = 1; tone = 0.25; woody = true;
        }
        for (const S of stems) {
          if (segHit(u, v, S.bx, S.by, S.ex, S.ey, 0.007)) {
            alpha = 1; tone = 0.25; woody = true;
          }
        }

        for (const N of needles) {
          const px = u - N.x0, py = v - N.y0;
          const L2 = N.dx * N.dx + N.dy * N.dy;
          let s = (px * N.dx + py * N.dy) / L2;
          s = clamp01(s);
          const qx = px - N.dx * s, qy = py - N.dy * s;
          // Taper along the needle so the tips come to a point rather than
          // stopping square.
          if (Math.hypot(qx, qy) < N.wid * (1 - s * 0.72)) {
            alpha = 1; tone = N.tone; woody = false;
          }
        }

        const k = (j * size + i) * 4;
        const g = woody
          ? 0.058
          : mix(0.078, 0.172, tone);
        const enc = (x) => Math.round(Math.sqrt(clamp01(x)) * 255);
        // Bluer than the broadleaf card (B factor 0.44 against its 0.30): the
        // cold cast is most of what makes a conifer read as one at distance.
        data[k] = enc(g * (woody ? 0.92 : 0.54));
        data[k + 1] = enc(g);
        data[k + 2] = enc(g * (woody ? 0.62 : 0.44));
        data[k + 3] = alpha > 0 ? 255 : 0;
      }
    }
    return plainTexture(data, size, size, { repeat: false });
  });
}

/**
 * A grass-tuft card: a fan of tapered blades on a transparent background.
 * The blades reach the bottom edge of the card so the tuft meets the ground.
 */
export function grassCard(w = 96, h = 96) {
  return cached('grasscard', () => {
    const data = new Uint8Array(w * h * 4);
    const BLADES = 17;
    const blades = [];
    for (let i = 0; i < BLADES; i++) {
      const a = ihash(i, 1, 907), b = ihash(i, 2, 907), c = ihash(i, 3, 907);
      blades.push({
        x0: 0.08 + (i + a) / BLADES * 0.84,
        bend: (b - 0.5) * 0.50,
        top: 0.42 + c * 0.58,
        wid: 0.013 + a * 0.013,
        tone: b,
      });
    }
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const u = (i + 0.5) / w;
        // DataTexture is not flipped on upload, so row 0 is uv.y = 0. Putting
        // the base of the blade there keeps uv.y usable as "height up the
        // blade", which is what the wind shader bends by.
        const t = (j + 0.5) / h;             // 0 at the base, 1 at the top
        let a = 0, tone = 0.5, hgt = 0;
        for (const B of blades) {
          if (t > B.top) continue;
          const s = t / B.top;
          const cx = B.x0 + B.bend * s * s;
          const wid = B.wid * (1 - s * 0.85);
          if (Math.abs(u - cx) < wid) { a = 1; tone = B.tone; hgt = s; }
        }
        const k = (j * w + i) * 4;
        // Blades darken toward the base, where light does not reach.
        const shade = 0.44 + 0.60 * hgt;
        const g = mix(0.140, 0.290, tone) * shade;
        const enc = (x) => Math.round(Math.sqrt(clamp01(x)) * 255);
        data[k] = enc(g * 0.78);
        data[k + 1] = enc(g);
        data[k + 2] = enc(g * 0.30);
        data[k + 3] = a > 0 ? 255 : 0;
      }
    }
    return plainTexture(data, w, h, { repeat: false });
  });
}

/**
 * Radial darkening used as a contact-shadow decal where props meet the ground.
 * White at the rim, dark at the centre, meant for multiply blending.
 */
export function contactDecal(size = 64) {
  return cached('contact', () => {
    const data = new Uint8Array(size * size * 4);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const u = (i + 0.5) / size * 2 - 1, v = (j + 0.5) / size * 2 - 1;
        const r = Math.hypot(u, v);
        // Break the rim with noise so the decal is not a perfect circle.
        const wob = fbmT(u * 2 + 2, v * 2 + 2, 8, 953, 3) * 0.28;
        const k = smooth(1.0, 0.18, r + wob);
        const dark = 1 - k * 0.62;
        const c = Math.round(clamp01(dark) * 255);
        const p = (j * size + i) * 4;
        data[p] = c; data[p + 1] = c; data[p + 2] = c; data[p + 3] = 255;
      }
    }
    return plainTexture(data, size, size, { repeat: false });
  });
}

// -------------------------------------------------------------- glsl chunks

/**
 * Replacement for three's <map_fragment>. Albedo maps out of this module are
 * sqrt(linear), so decoding is one multiply rather than the pow that an sRGB
 * texture would cost -- and it keeps 8-bit precision where the eye wants it.
 */
export const SQRT_MAP_FRAGMENT = /* glsl */`
  #ifdef USE_MAP
    vec4 sampledDiffuseColor = texture2D(map, vMapUv);
    diffuseColor.rgb *= sampledDiffuseColor.rgb * sampledDiffuseColor.rgb;
    diffuseColor.a *= sampledDiffuseColor.a;
  #endif
`;

/**
 * The packed surface map: RG = tangent normal, B = roughness, A = ambient
 * occlusion. One texture instead of three, with z rebuilt rather than stored.
 *
 * It is bound as the material's `normalMap`, purely so three sets up the
 * tangent frame and the UV varying for us; the chunks below then reinterpret
 * the other two channels. Assign in this order -- roughness resolves before the
 * normal chunks and leaves `surfTex` in scope for them.
 */
export const SURFACE_PARS = /* glsl */`
  float gSurfAO;
`;

/** Replacement for <roughnessmap_fragment>; also stashes AO for later. */
export const SURFACE_ROUGH = /* glsl */`
  vec4 surfTex = texture2D(normalMap, vNormalMapUv);
  float roughnessFactor = clamp(roughness * (0.40 + 1.20 * surfTex.z), 0.05, 1.0);
  gSurfAO = surfTex.w;
`;

/** Replacement for <normal_fragment_maps>. */
export const SURFACE_NORMAL = /* glsl */`
  vec3 mapN = vec3((surfTex.xy * 2.0 - 1.0) * normalScale, 1.0);
  mapN.z = sqrt(max(1e-4, 1.0 - dot(mapN.xy, mapN.xy)));
  normal = normalize(tbn * mapN);
`;

/** Replacement for <aomap_fragment>. */
export const SURFACE_AO = /* glsl */`
  reflectedLight.indirectDiffuse *= gSurfAO;
  reflectedLight.directDiffuse *= mix(1.0, gSurfAO, 0.30);
`;

/** Free the cached CPU-side texture set. Called by the render modules' dispose. */
export function disposeTextures() {
  if (terrainSet) {
    terrainSet.albedo.dispose();
    terrainSet.surface.dispose();
    terrainSet = null;
  }
  for (const v of propCache.values()) {
    if (v.albedo) { v.albedo.dispose(); v.surface.dispose(); } else v.dispose();
  }
  propCache.clear();
}
