// Weapon skins: the shop's stock, and the code that repaints a gun.
//
// A skin is a palette, not a model. Every viewmodel is built from a handful of
// source colours -- receiver metal, dark furniture, wood, brass accent -- and a
// skin is a rule for mapping those roles onto new values. That is what lets one
// skin cover fourteen weapons without anyone authoring fourteen variants, and
// what keeps a skin from ever changing the silhouette the player aims with.
//
// Roles are recovered from the colour a part was built with (viewmodel.js
// records it on the material), so the weapon builders stay unaware skins exist.

import * as THREE from '../../vendor/three.module.js';
import { patternCanvas, roughnessCanvas } from './guntextures.js';

// The source palette, mirrored from viewmodel.js. These are match keys, not
// colours to draw -- if a builder's palette changes, a skin simply stops
// matching that role and falls through to the overall tint, which is why
// nothing breaks visually when someone adds a new part colour.
export const ROLE = {
  METAL: 0x6a727d,   // receivers, slides, frames
  DARK: 0x434a54,    // furniture, grips, barrels
  WOOD: 0x8a6238,    // stocks
  ACCENT: 0xd9b45f,  // magazines, front posts
  GOLD: 0xe8c357,
  STEEL: 0x9aa4b0,
  ENERGY: 0x4fd8ff,
  RAIL: 0xc08cff,
  RED: 0xff4436,
};

export const RARITY = {
  common: { label: 'COMMON', color: '#9aa6b2' },
  rare: { label: 'RARE', color: '#5fa8ff' },
  epic: { label: 'EPIC', color: '#c084fc' },
  legendary: { label: 'LEGENDARY', color: '#ffd700' },
};

/**
 * The catalogue.
 *
 * `roles` remaps specific source colours; `tint` multiplies anything the skin
 * does not name, so a skin never has to enumerate every part to look coherent.
 *
 * Prices are in credits, and a run pays out roughly score/10 -- so the cheapest
 * skin is a couple of decent runs and the legendaries are a project.
 */
export const SKINS = [
  {
    id: 'default',
    name: 'STANDARD ISSUE',
    blurb: 'Factory paint. Nothing to be ashamed of.',
    rarity: 'common',
    price: 0,
    isDefault: true,   // owned from first launch, never purchasable
  },
  {
    id: 'midnight',
    name: 'MIDNIGHT',
    blurb: 'Blued steel and black polymer. Reads as a shape, not a gun.',
    rarity: 'common',
    price: 400,
    roles: {
      [ROLE.METAL]: 0x2b3040,
      [ROLE.DARK]: 0x171a24,
      [ROLE.WOOD]: 0x2a2632,
      [ROLE.ACCENT]: 0x5b6478,
    },
    roughness: 0.34,
    metalness: 0.82,
    // Brushed steel blued almost black. Damascus banding rather than a
    // pattern, because this one is meant to read as the metal itself.
    pattern: { type: 'damascus', colors: [0x1a1e28, 0x424c60], seed: 11, grain: 0.07 },
    patternRepeat: 1.6,
  },
  {
    id: 'desert',
    name: 'DESERT COYOTE',
    blurb: 'Sun-bleached tan over a dust-worn receiver.',
    rarity: 'common',
    price: 400,
    roles: {
      [ROLE.METAL]: 0xbfa276,
      [ROLE.DARK]: 0x6f5c3f,
      [ROLE.WOOD]: 0x8c6a41,
      [ROLE.ACCENT]: 0x4e463a,
    },
    roughness: 0.78,
    metalness: 0.12,
    pattern: {
      type: 'camo', seed: 3, blobs: 30, scale: 1.15,
      colors: [0xbfa276, 0x8a7350, 0x5c4d36, 0x3f3628],
    },
    patternRepeat: 2.2,
    roughnessRange: [0.45, 0.92],
  },
  {
    id: 'woodland',
    name: 'WOODLAND',
    blurb: 'Old-issue greens. Disappears against a treeline you no longer have.',
    rarity: 'common',
    price: 550,
    roles: {
      [ROLE.METAL]: 0x5a6340,
      [ROLE.DARK]: 0x2c3220,
      [ROLE.WOOD]: 0x4a4028,
      [ROLE.ACCENT]: 0x8b8a5c,
    },
    roughness: 0.8,
    metalness: 0.1,
    pattern: {
      type: 'camo', seed: 21, blobs: 36,
      colors: [0x5a6340, 0x3c4530, 0x6f6b3e, 0x241f18],
    },
    patternRepeat: 2.4,
    roughnessRange: [0.5, 0.95],
  },
  {
    id: 'crimson',
    name: 'CRIMSON GUARD',
    blurb: 'Deep red furniture on a blacked-out frame.',
    rarity: 'rare',
    price: 900,
    roles: {
      [ROLE.METAL]: 0x8e1f22,
      [ROLE.DARK]: 0x2a1214,
      [ROLE.WOOD]: 0x3a171a,
      [ROLE.ACCENT]: 0xd8c9a0,
    },
    roughness: 0.4,
    metalness: 0.6,
    pattern: {
      type: 'tiger', seed: 8,
      colors: [0x8e1f22, 0x4a1013, 0x1d0a0b],
    },
    patternRepeat: 2.0,
    roughnessRange: [0.28, 0.7],
  },
  {
    id: 'arctic',
    name: 'ARCTIC SPLINTER',
    blurb: 'Splinter pattern in white and pale grey.',
    rarity: 'rare',
    price: 900,
    roles: {
      [ROLE.METAL]: 0xdfe6ee,
      [ROLE.DARK]: 0x8b98a8,
      [ROLE.WOOD]: 0xa9b6c4,
      [ROLE.ACCENT]: 0x5f7183,
    },
    roughness: 0.5,
    metalness: 0.45,
    pattern: {
      type: 'splinter', seed: 5,
      colors: [0xe8eef4, 0xb9c5d2, 0x8695a6, 0x5d6b7b],
    },
    patternRepeat: 1.8,
    roughnessRange: [0.3, 0.8],
  },
  {
    id: 'urban',
    name: 'URBAN DIGITAL',
    blurb: 'Pixelated greys, printed edge to edge.',
    rarity: 'rare',
    price: 1100,
    roles: {
      [ROLE.METAL]: 0x767d86,
      [ROLE.DARK]: 0x33383f,
      [ROLE.WOOD]: 0x4a5058,
      [ROLE.ACCENT]: 0x9aa3ad,
    },
    roughness: 0.62,
    metalness: 0.3,
    pattern: {
      type: 'digital', seed: 14, cell: 8,
      colors: [0x767d86, 0x4d545d, 0x2a2e34, 0xa8b0b9],
    },
    patternRepeat: 2.6,
    roughnessRange: [0.4, 0.85],
  },
  {
    id: 'carbon',
    name: 'CARBON FIBRE',
    blurb: 'Woven carbon with a hard specular sheen.',
    rarity: 'epic',
    price: 1800,
    roles: {
      [ROLE.METAL]: 0x23262b,
      [ROLE.DARK]: 0x121417,
      [ROLE.WOOD]: 0x1c1f24,
      [ROLE.ACCENT]: 0xc8ccd2,
    },
    roughness: 0.22,
    metalness: 0.95,
    pattern: { type: 'weave', colors: [0x15181c, 0x40474f], grain: false },
    patternRepeat: 4.0,
    roughnessRange: [0.12, 0.42],
  },
  {
    id: 'toxic',
    name: 'TOXIC',
    blurb: 'Warning green over hazard black. Not subtle.',
    rarity: 'epic',
    price: 1800,
    roles: {
      [ROLE.METAL]: 0x4a6b1f,
      [ROLE.DARK]: 0x202a12,
      [ROLE.WOOD]: 0x33401a,
      [ROLE.ACCENT]: 0xa3ff3c,
    },
    roughness: 0.45,
    metalness: 0.5,
    pattern: {
      type: 'camo', seed: 33, blobs: 28, scale: 0.85,
      colors: [0x3d5a19, 0x27380f, 0x6f9c2f, 0x9fdc3a],
    },
    patternRepeat: 2.2,
    roughnessRange: [0.3, 0.8],
    // A faint glow on the accent parts only, so it reads as luminous paint
    // rather than turning the whole gun into a lamp.
    emissive: { [ROLE.ACCENT]: 0x6aff00 },
    emissiveIntensity: 0.55,
  },
  {
    id: 'gilded',
    name: 'GILDED',
    blurb: 'Plated in gold, because the wave-twenty money had to go somewhere.',
    rarity: 'legendary',
    price: 4000,
    roles: {
      [ROLE.METAL]: 0xd4af37,
      [ROLE.DARK]: 0x6b5210,
      [ROLE.WOOD]: 0x3b2a12,
      [ROLE.ACCENT]: 0xfff2b0,
    },
    roughness: 0.16,
    metalness: 1.0,
    // Engraved rather than printed: damascus banding in two golds gives the
    // chased-metal look without needing a normal map.
    pattern: { type: 'damascus', colors: [0x9d7c1e, 0xffe89a], seed: 2, grain: 0.09 },
    patternRepeat: 2.0,
    roughnessRange: [0.08, 0.34],
  },
  {
    id: 'plasma',
    name: 'PLASMA CORE',
    blurb: 'Cold blue light bleeding out of the seams.',
    rarity: 'legendary',
    price: 4000,
    roles: {
      [ROLE.METAL]: 0x1b2b3a,
      [ROLE.DARK]: 0x0c1420,
      [ROLE.WOOD]: 0x14202e,
      [ROLE.ACCENT]: 0x4fd8ff,
    },
    roughness: 0.25,
    metalness: 0.85,
    pattern: { type: 'hex', colors: [0x12202e, 0x2f6d8c, 0x4fd8ff], grain: 0.03 },
    patternRepeat: 3.0,
    roughnessRange: [0.15, 0.5],
    emissive: { [ROLE.ACCENT]: 0x2fbfff, [ROLE.METAL]: 0x0a2233 },
    emissiveIntensity: 0.9,
  },
];

export const SKIN_BY_ID = new Map(SKINS.map((s) => [s.id, s]));
export const DEFAULT_SKIN = SKINS.find((s) => s.isDefault);

/** Skins a fresh profile already owns. */
export function startingSkins() {
  return SKINS.filter((s) => s.isDefault).map((s) => s.id);
}

const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/**
 * Repaint one weapon model.
 *
 * Materials are shared across weapons by colour (viewmodel.js caches them), so
 * writing to them directly would skin every gun at once. Each model therefore
 * gets its own clones the first time it is skinned, kept on the group and
 * reused afterwards -- switching skins must not allocate per frame, and a
 * player flipping through the shop is doing exactly that.
 *
 * @param group a weapon model group from ViewModel.models
 * @param skin  an entry from SKINS, or null/default to restore the original
 */
export function applySkin(group, skin) {
  if (!group) return;

  // First pass: remember the original material of every mesh, once.
  if (!group.userData.skinOriginals) {
    const originals = new Map();
    group.traverse((o) => {
      if (o.isMesh && o.material) originals.set(o, o.material);
    });
    group.userData.skinOriginals = originals;
    group.userData.skinClones = new Map();
  }

  const originals = group.userData.skinOriginals;
  const clones = group.userData.skinClones;

  if (!skin || skin.isDefault) {
    for (const [mesh, original] of originals) mesh.material = original;
    group.userData.skinId = 'default';
    return;
  }

  let cache = clones.get(skin.id);
  if (!cache) {
    cache = new Map();
    for (const [mesh, original] of originals) {
      // One clone per distinct source material, not per mesh -- a rifle has
      // twenty parts sharing four materials, and cloning per mesh would put
      // twenty near-identical programs on the GPU.
      for (const src of Array.isArray(original) ? original : [original]) {
        if (!cache.has(src)) cache.set(src, paint(src, skin));
      }
    }
    clones.set(skin.id, cache);
  }

  for (const [mesh, original] of originals) applyMaterials(mesh, original, cache);
  group.userData.skinId = skin.id;
}

/**
 * Every material on a mesh, as a list.
 *
 * A mesh built by this project has exactly one. A mesh that arrived in an FBX
 * or an OBJ can have several -- one per geometry group -- and `o.material` is
 * then an Array. The cosmetic system keys its clone cache on the material
 * object, so an Array walked in as if it were a material reached `.clone()` and
 * threw, which took the whole repaint down with it. Normalising here is what
 * lets a downloaded gun wear a skin at all.
 */
function materialsOf(mesh) {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/** Put a repainted set back on a mesh in the shape it had. */
function applyMaterials(mesh, original, cache) {
  mesh.material = Array.isArray(original)
    ? original.map((src) => cache.get(src) ?? src)
    : (cache.get(original) ?? original);
}

// One THREE texture per (pattern, repeat), shared by every material and every
// weapon that uses it. Baking a 256px canvas per part would be absurd.
const TEX_CACHE = new Map();

function texture(canvas, repeat) {
  if (!canvas) return null;
  const key = `${canvas.__id ??= ++texture.n}|${repeat}`;
  if (!TEX_CACHE.has(key)) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = 4;
    TEX_CACHE.set(key, t);
  }
  return TEX_CACHE.get(key);
}
texture.n = 0;

/** One repainted copy of a source material. */
/**
 * The source colour a skin's role map should be keyed against.
 *
 * A skin names roles by their STANDARD colour -- `roles: { [ROLE.METAL]: ... }`
 * -- but the model may have been built from a finish's palette instead, in
 * which case the receiver is not 0x6a727d any more and the lookup misses.
 * viewmodel records which slot each material came out of, so translate back to
 * the standard colour for that slot and the skin matches whatever finish is
 * underneath it.
 */
function roleKey(material) {
  const role = material.userData.baseRole;
  return (role && ROLE[role] !== undefined) ? ROLE[role] : material.userData.baseHex;
}

function paint(source, skin) {
  const m = source.clone();
  const base = roleKey(source);

  const mapped = skin.roles?.[base];
  if (mapped !== undefined) {
    m.color.copy(srgb(mapped));
  } else if (skin.tint !== undefined) {
    m.color.copy(srgb(base)).multiply(srgb(skin.tint));
  }

  if (skin.roughness !== undefined) m.roughness = skin.roughness;
  if (skin.metalness !== undefined) m.metalness = skin.metalness;

  // Only the big surfaces take the pattern. A real camo-wrapped weapon still
  // has black furniture and bare sights -- printing the camo over every part
  // flattens the gun into one shape and loses the read of where the grip is.
  const patterned = skin.patternRoles ?? [ROLE.METAL, ROLE.WOOD, ROLE.STEEL];
  if (skin.pattern && patterned.includes(base)) {
    const repeat = skin.patternRepeat ?? 2;
    const albedo = texture(patternCanvas(skin.pattern), repeat);
    if (albedo) {
      albedo.colorSpace = THREE.SRGBColorSpace;
      m.map = albedo;
      // The role colour has already been baked into the pattern's palette, so
      // leaving it multiplied on top would double-darken every part.
      m.color.setRGB(1, 1, 1);
    }
    const [lo, hi] = skin.roughnessRange ?? [0.3, 0.85];
    const rough = texture(roughnessCanvas(skin.pattern, lo, hi), repeat);
    if (rough) {
      m.roughnessMap = rough;
      // roughnessMap multiplies roughness, so the scalar has to be 1 or the
      // map's range gets squashed into nothing.
      m.roughness = 1;
    }
  }

  const glow = skin.emissive?.[base];
  if (glow !== undefined) {
    m.emissive = srgb(glow);
    m.emissiveIntensity = skin.emissiveIntensity ?? 0.6;
  }

  m.needsUpdate = true;
  // Clones are ours to free; the originals belong to the viewmodel's cache.
  m.userData.isSkinClone = true;
  return m;
}

/** Repaint every weapon the viewmodel holds. */
export function applySkinToAll(viewmodel, skinId) {
  const skin = SKIN_BY_ID.get(skinId) ?? DEFAULT_SKIN;
  for (const group of Object.values(viewmodel.models)) applySkin(group, skin);
  return skin;
}
