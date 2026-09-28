// Photographed PBR sets, packed into the formats the renderer already speaks.
//
// Everything else in this renderer draws its own textures (see texturelab.js).
// That is still the right default -- a procedural surface costs nothing to ship
// and retunes by editing a number -- but it has a ceiling: no amount of noise
// stacking produces gravel that reads as gravel. So this module is the one
// place that loads photographed surfaces off disk, and it is deliberately
// shaped to *feed the existing systems* rather than replace them:
//
//   The terrain shader is untouched. It samples two DataArrayTextures with a
//   fixed channel contract -- albedo RGB is sqrt(linear) with height in alpha,
//   surface is normal.xy / roughness / ao. So a photo set is decoded, converted
//   into exactly that packing, and handed over as if texturelab had baked it.
//   Six photographs in, same shader, same blend weights, same everything.
//
//   Props and walls get an ordinary MeshStandardMaterial. Poly Haven packs
//   ambient occlusion, roughness and metalness into the R, G and B of one `arm`
//   file, which happens to be precisely the channels three.js samples aoMap,
//   roughnessMap and metalnessMap from -- so one texture serves three maps with
//   no shader work at all.
//
// Nothing here is required. Every entry point resolves to null when the art is
// not on disk, and every caller treats null as "use the procedural version", so
// a clone with an empty assets/ tree plays exactly as it did before -- it just
// looks older. The art is fetched by `node tools/fetch-assets.mjs`, and
// assets/CREDITS.json is the marker for whether that has been run: it is
// written by the fetcher and ignored by git, so its absence is a reliable
// "no art pack here" rather than a guess.

import * as THREE from '../../vendor/three.module.js';

const ROOT = new URL('../../assets/', import.meta.url).href;

/** sRGB byte -> linear float. The exact curve, because the toe matters in shadow. */
function srgbToLinear(b) {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// 0..255 -> 0..255, sRGB in, sqrt(linear) out. Precomputed because the terrain
// pack runs it over six 512x512 images, which is 1.5M pixels of pow().
const SQRT_LINEAR = new Uint8Array(256);
for (let i = 0; i < 256; i++) SQRT_LINEAR[i] = Math.round(Math.sqrt(srgbToLinear(i)) * 255);

/**
 * What the fetcher installed, or null if it never ran.
 *
 * Read once and cached as a promise, so twenty callers during world build share
 * a single request. A failure resolves to null rather than rejecting: "no art
 * pack" is a normal state, not an error anybody should have to catch.
 */
let indexPromise = null;
export function assetIndex() {
  if (!indexPromise) {
    // Deliberately not force-cached, unlike the art it indexes: this file is
    // rewritten every time the pack changes, and a stale copy would have the
    // game quietly claiming assets it no longer ships.
    indexPromise = fetch(`${ROOT}CREDITS.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((rows) => (Array.isArray(rows) ? new Set(rows.map((r) => r.path)) : null))
      .catch(() => null);
  }
  return indexPromise;
}

/** Is this texture set on disk? Cheap: consults the index, never the network. */
async function hasTexture(name) {
  const index = await assetIndex();
  return !!index && index.has(`assets/textures/${name}`);
}

/** Is this model on disk? */
export async function hasModel(name) {
  const index = await assetIndex();
  return !!index && index.has(`assets/models/${name}/scene.gltf`);
}

// ------------------------------------------------------------------ decoding

/**
 * Decode one map of a set, or null if that map was not published.
 *
 * A missing map is ordinary -- not every Poly Haven set ships a displacement --
 * so this resolves to null instead of throwing, and every consumer has a
 * documented fallback for each channel it needs.
 */
async function loadBitmap(name, kind) {
  for (const ext of ['jpg', 'png']) {
    try {
      const res = await fetch(`${ROOT}textures/${name}/${kind}.${ext}`, { cache: 'force-cache' });
      if (!res.ok) continue;
      return await createImageBitmap(await res.blob());
    } catch { /* try the next extension */ }
  }
  return null;
}

/** Draw a bitmap into a square of `size` and read the pixels back. */
function rasterise(bitmap, size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}

// ------------------------------------------------------------------- terrain

/**
 * Pack photo sets into the terrain shader's two array textures.
 *
 * `names` is one texture-set name per shader layer, in LAYER order. A layer
 * whose set is missing is left as whatever `fallback` baked for it, so a
 * half-installed art pack degrades layer by layer instead of all at once.
 *
 * @param {string[]} names       texture set per layer, LAYER order
 * @param {{albedo:Uint8Array, surface:Uint8Array, size:number}} fallback
 *        procedurally baked bytes to start from, and the layer size to match
 * @returns {Promise<{albedo:THREE.DataArrayTexture, surface:THREE.DataArrayTexture}|null>}
 */
export async function terrainPhotoArrays(names, fallback) {
  const index = await assetIndex();
  if (!index) return null;

  const size = fallback.size;
  const texels = size * size;
  const alb = Uint8Array.from(fallback.albedo);
  const srf = Uint8Array.from(fallback.surface);
  let packed = 0;

  // Safari is particularly sensitive to a burst of ImageBitmap decodes. Keep
  // one terrain set live at a time and release its source images as soon as the
  // packed bytes exist; the DataArrayTextures are the cache that survives.
  for (let layer = 0; layer < names.length; layer++) {
    const name = names[layer];
    if (!name || !(await hasTexture(name))) continue;
    const bitmaps = await Promise.all([
      loadBitmap(name, 'diff'), loadBitmap(name, 'nor'), loadBitmap(name, 'arm'),
      loadBitmap(name, 'disp'), loadBitmap(name, 'rough'), loadBitmap(name, 'ao'),
    ]);
    const [diff, nor, arm, disp, rough, ao] = bitmaps;
    if (!diff) {
      for (const bitmap of bitmaps) bitmap?.close?.();
      continue;
    }

    let d, n, a, h, r, o;
    try {
      d = rasterise(diff, size);
      n = nor ? rasterise(nor, size) : null;
      a = arm ? rasterise(arm, size) : null;
      h = disp ? rasterise(disp, size) : null;
      r = rough ? rasterise(rough, size) : null;
      o = ao ? rasterise(ao, size) : null;
    } finally {
      for (const bitmap of bitmaps) bitmap?.close?.();
    }

    const off = layer * texels * 4;
    for (let i = 0; i < texels; i++) {
      const p = off + i * 4, q = i * 4;

      // Albedo: sRGB jpeg in, sqrt(linear) out, because the shader decodes with
      // one multiply (`decode(c) = c * c`).
      alb[p]     = SQRT_LINEAR[d[q]];
      alb[p + 1] = SQRT_LINEAR[d[q + 1]];
      alb[p + 2] = SQRT_LINEAR[d[q + 2]];
      // Alpha is the shared erosion height, not opacity. Displacement if the
      // set ships one; otherwise luminance, which correlates well enough with
      // depth on gravel and dirt to interlock the layer boundaries.
      alb[p + 3] = h ? h[q] : Math.round(d[q] * 0.299 + d[q + 1] * 0.587 + d[q + 2] * 0.114);

      // Surface: tangent normal xy (already 0..1 encoded, OpenGL handedness --
      // the fetcher prefers nor_gl for exactly this reason), then roughness and
      // ambient occlusion.
      if (n) { srf[p] = n[q]; srf[p + 1] = n[q + 1]; }
      srf[p + 2] = a ? a[q + 1] : r ? r[q] : srf[p + 2];
      srf[p + 3] = a ? a[q]     : o ? o[q] : srf[p + 3];
    }
    recentreHeight(alb, off, texels);
    packed++;
  }

  if (!packed) return null;
  return { albedo: arrayTexture(alb, size, names.length), surface: arrayTexture(srf, size, names.length) };
}

/**
 * Which photographed set stands in for each shader layer.
 *
 * Indices are LAYER order from texturelab.js, and the names are what the
 * fetcher installs. Two of these are deliberately not what their layer is
 * called: SNOW and SAND exist in the shader as blend slots rather than as
 * literal weather, and a wave-survival map set in an arid compound wants gravel
 * and coarse sand in those slots, not snowfall. Renaming the layers would touch
 * the shader, the blend field and the world generator; renaming the *art* costs
 * nothing and is reversible by editing this one line.
 */
export const TERRAIN_LAYER_SETS = [
  'dry_ground_01',      // GRASS  -- dry compacted earth, the baseline ground
  'dirt_floor',         // DIRT   -- loose dirt, the worn paths
  'cracked_red_ground', // ROCK   -- cracked arid earth on the slopes and cliffs
  'coast_sand_01',      // SAND   -- coarse sand in the low ground
  'gravel_concrete',    // SNOW   -- gravel over concrete, the made surfaces
  'asphalt_02',         // DETAIL -- asphalt grain, the shared high-frequency pass
];

/**
 * The terrain arrays, photographed where possible.
 *
 * Cached, because two lobbies in a row must not re-decode six jpegs, and
 * because the arrays are uploaded to the GPU once and shared by every chunk.
 */
let terrainPromise = null;
export function terrainPhotoTextures(size = 512, baked = null) {
  if (!terrainPromise) {
    terrainPromise = (async () => {
      const bytes = baked || (await import('./texturelab.js')).bakeTerrainBytes(size);
      return terrainPhotoArrays(TERRAIN_LAYER_SETS, bytes);
    })().catch((err) => {
      console.warn('[photosets] terrain photos unavailable:', err?.message ?? err);
      return null;
    });
  }
  return terrainPromise;
}

/**
 * Shift a layer's height channel so it averages 0.5.
 *
 * The terrain shader does not use this channel as a height -- it uses it as an
 * *erosion* term, `ero = height - 0.5`, and adds that to every blend weight to
 * turn a linear cross-fade into an interlocking boundary. The procedural bake
 * happened to produce a mean of about 0.5, so the term was unbiased and nobody
 * had to think about it.
 *
 * A photograph has no such courtesy: dark asphalt averages a third of that, and
 * dropped in raw it biases every weight in the blend downward by a constant.
 * That does not look like a broken height map, which is what makes it worth
 * fixing here -- it looks like the layer weights are subtly wrong, which is a
 * much harder thing to notice and a much harder thing to trace.
 */
function recentreHeight(alb, off, texels) {
  let sum = 0;
  for (let i = 0; i < texels; i++) sum += alb[off + i * 4 + 3];
  const shift = 128 - sum / texels;
  if (Math.abs(shift) < 1) return;
  for (let i = 0; i < texels; i++) {
    const p = off + i * 4 + 3;
    alb[p] = Math.max(0, Math.min(255, alb[p] + shift));
  }
}

/** Same settings texturelab uses, so a photo array behaves like a baked one. */
function arrayTexture(data, size, depth) {
  const t = new THREE.DataArrayTexture(data, size, size, depth);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipMapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// ----------------------------------------------------------------- materials

const loader = new THREE.TextureLoader();
const matCache = new Map();

function texture(name, kind, colorSpace, repeat) {
  return new Promise((resolve) => {
    loader.load(`${ROOT}textures/${name}/${kind}.jpg`, (t) => {
      t.colorSpace = colorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(repeat, repeat);
      // Terrain-scale tiling at a glancing angle is exactly where anisotropy
      // earns its cost; 4 is the sweet spot before it stops being visible.
      t.anisotropy = 4;
      resolve(t);
    }, undefined, () => resolve(null));
  });
}

/**
 * A photographed surface as an ordinary standard material.
 *
 * @param name  texture set, e.g. 'dirty_concrete'
 * @param opts.repeat  UV repeats across the mapped face
 * @returns {Promise<THREE.MeshStandardMaterial|null>} null when not installed
 */
export async function photoMaterial(name, opts = {}) {
  const repeat = opts.repeat ?? 1;
  const key = `${name}|${repeat}|${opts.color ?? 'x'}`;
  if (matCache.has(key)) return matCache.get(key);

  const promise = (async () => {
    if (!(await hasTexture(name))) return null;
    const [map, normalMap, armMap] = await Promise.all([
      texture(name, 'diff', THREE.SRGBColorSpace, repeat),
      texture(name, 'nor', THREE.NoColorSpace, repeat),
      texture(name, 'arm', THREE.NoColorSpace, repeat),
    ]);
    if (!map) return null;

    const mat = new THREE.MeshStandardMaterial({
      map,
      normalMap: normalMap || undefined,
      // One file, three maps: R is occlusion, G roughness, B metalness, which
      // is the channel each of these samplers reads by default.
      aoMap: armMap || undefined,
      roughnessMap: armMap || undefined,
      metalnessMap: armMap || undefined,
      roughness: opts.roughness ?? 1,
      metalness: opts.metalness ?? (armMap ? 1 : 0),
      color: opts.color ?? 0xffffff,
      dithering: true,
    });
    // Recorded so the armoury's role-based repainting keeps working on a
    // photographed surface the same way it does on a built one.
    mat.userData.photoSet = name;
    return mat;
  })();

  matCache.set(key, promise);
  return promise;
}

/**
 * Which photographed set stands in for each procedural surface kind.
 *
 * The keys are the `surf` names buildings.js already uses, so nothing there has
 * to learn a new vocabulary -- a role that has no photograph simply keeps the
 * canvas it was drawing before.
 *
 * `plaster` maps to a block wall rather than to plaster on purpose: the interior
 * partitions of a compound read as breeze-block in every reference for this kind
 * of map, and painted plaster is what made the complex feel like an office.
 */
export const SURFACE_SETS = {
  concrete: 'dirty_concrete',
  plaster: 'concrete_block_wall',
  metal: 'metal_plate',
  // Rusting military-green paint. The closest thing in the pack to issued kit,
  // and what the chest is painted with.
  milgreen: 'green_metal_rust',
};

const surfaceCache = new Map();

/**
 * Preload the building surfaces so they can be fetched synchronously later.
 *
 * Buildings are built in one synchronous pass -- geometry merged, materials
 * assigned, done -- and threading a promise through that would mean either
 * rebuilding the complex when the textures land or blocking the world build on
 * a fetch. Loading them up front, once, before the build starts, avoids both.
 */
export async function preloadSurfaces() {
  const index = await assetIndex();
  if (!index) return 0;
  let ready = 0;
  // Decode one material at a time. Peak memory matters more than parallel
  // throughput here because the caller needs all four before building walls.
  for (const [role, name] of Object.entries(SURFACE_SETS)) {
    if (!index.has(`assets/textures/${name}`)) continue;
    const [map, normalMap, armMap] = await Promise.all([
      texture(name, 'diff', THREE.SRGBColorSpace, 1),
      texture(name, 'nor', THREE.NoColorSpace, 1),
      texture(name, 'arm', THREE.NoColorSpace, 1),
    ]);
    if (!map) continue;
    surfaceCache.set(role, { map, normalMap, armMap });
    ready++;
  }
  return ready;
}

/**
 * A preloaded surface, or null.
 *
 * Synchronous by design: see preloadSurfaces. Returns the shared textures, not
 * copies -- every wall in the complex samples the same concrete, which is the
 * whole reason this costs one texture upload rather than forty.
 */
export function photoSurface(role) {
  return surfaceCache.get(role) ?? null;
}

/** Drop cached photographed materials. Called on world teardown. */
export function disposePhotoSets() {
  for (const p of matCache.values()) {
    Promise.resolve(p).then((m) => {
      if (!m) return;
      for (const k of ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap']) m[k]?.dispose();
      m.dispose();
    });
  }
  matCache.clear();
}
