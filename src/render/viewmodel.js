// First-person weapon models: rounded, low-poly forms rather than box stacks.
//
// The viewmodel lives in its own scene and camera, rendered after the world with
// the depth buffer cleared. That is the standard fix for guns clipping into
// walls: the model is never in the world's depth range at all.

import * as THREE from '../../vendor/three.module.js';
import { CAMO_BY_ID } from './camos.js';
import { studioEnvironment } from './studioenv.js';

/** Shared with the weapon QA pages so they render the same finish as the game. */
export const VIEWMODEL_LIGHTING = Object.freeze({
  ambient: 0.52,
  key: 1.25,
  rim: 0.34,
  environment: 0.5,
});

/**
 * A rear notch the player can actually see through.
 *
 * Modelled to scale, a rear aperture is millimetres across with your eye behind
 * it, so in life you look *through* a blur. A virtual camera has infinite depth
 * of field and no eye relief, so the same geometry renders as a crisp lump of
 * metal parked over the target -- the grey spot you cannot see past. So the
 * notch is drawn wider and thinner than life: two slim uprights set well apart,
 * a floor that stops below the line of sight, and nothing in the middle.
 */
function rearNotch(g, y, z, { gap = 0.05, blade = 0.011, h = 0.05, color = DARK } = {}) {
  const depth = 0.018;
  const top = y + h * 0.22;
  const cy = top - h / 2;
  g.add(part(blade, h, depth, color, -gap, cy, z));
  g.add(part(blade, h, depth, color, gap, cy, z));
  const floorH = 0.010;
  g.add(part(gap * 2 + blade, floorH, depth, color, 0, y - h * 0.5 - floorH * 0.5, z));
}

const MAT_CACHE = new Map();
const FINISH_MAT_CACHE = new Map();
const FINISH_TEX_CACHE = new Map();
const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/** Physically-shaded metal/wood, cached by colour so parts share materials. */
// Metalness is deliberately moderate. A MeshStandardMaterial's metallic
// response is almost entirely environment reflection, and this scene has no
// environment map -- so high metalness just multiplies the base colour toward
// black. Mid metalness with low roughness keeps the directional key light's
// specular streak, which is the highlight that actually sells machined metal
// here. The defaults are mutable because a camo can change the finish itself
// -- GOLD PLATE is gold because of these two numbers, not its hex value.
let DEF_R = 0.38;
let DEF_M = 0.35;

/**
 * Which palette slot a colour came out of, if any.
 *
 * The colour alone is not enough to identify a part's role, because the palette
 * itself moves: put the woodland finish on and every receiver in the game is
 * built green, so a skin that remaps "receiver grey" matches nothing and
 * silently does nothing. That is exactly what a bought skin did to anyone
 * wearing a finish -- the profile said it was equipped and the gun was plain.
 * Recording the role at build time is what lets the two compose.
 */
function roleOf(color) {
  if (color === GUNMETAL) return 'METAL';
  if (color === DARK) return 'DARK';
  if (color === WOODGRIP) return 'WOOD';
  if (color === ACCENT) return 'ACCENT';
  if (color === GOLD) return 'GOLD';
  if (color === STEEL) return 'STEEL';
  if (color === ENERGY) return 'ENERGY';
  if (color === RAIL) return 'RAIL';
  if (color === RED) return 'RED';
  return null;
}

function mat(color, roughness = DEF_R, metalness = DEF_M) {
  const key = `${color}|${roughness}|${metalness}`;
  if (!MAT_CACHE.has(key)) {
    const m = new THREE.MeshStandardMaterial({
      color: srgb(color), roughness, metalness,
    });
    // The armoury repaints a finished weapon, and by then the only thing
    // distinguishing a receiver from a grip is the colour it was built with.
    // Recording the source values is what lets a skin remap by role.
    m.userData.baseHex = color;
    m.userData.baseRole = roleOf(color);
    m.userData.baseRoughness = roughness;
    m.userData.baseMetalness = metalness;
    MAT_CACHE.set(key, m);
  }
  return MAT_CACHE.get(key);
}

/**
 * Small deterministic finish maps for authored weapons.
 *
 * These are real UV textures rather than shader noise: they survive screenshots,
 * do not shimmer as the rifle moves, and work in the headless model tests where
 * an HTML canvas and TextureLoader do not exist. The map remains close to white
 * so it adds grain, wear and machining without replacing the equipped camo.
 */
function finishTexture(kind) {
  if (FINISH_TEX_CACHE.has(kind)) return FINISH_TEX_CACHE.get(kind);
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const hash = (x, y, salt = 0) => {
    let n = Math.imul(x + 17 + salt, 374761393) ^ Math.imul(y + 31, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const noise = hash(x, y) & 31;
      let value = 244;
      if (kind === 'cerakote') {
        value = 232 + Math.floor(noise * 0.55);
        // Sparse hairline wear marks interrupt the otherwise matte coating.
        if ((hash(x >> 1, y >> 1, 7) % 311) < 3 && (x + y) % 5 < 2) value = 178;
      } else if (kind === 'brushed') {
        value = 218 + Math.floor((hash(x >> 2, y, 3) & 31) * 0.8);
        if (y % 13 === 0) value -= 25;
      } else if (kind === 'polymer') {
        const stipple = hash(x, y, 11) % 9;
        value = stipple < 2 ? 188 : 226 + Math.floor(noise * 0.55);
      } else if (kind === 'rubber') {
        value = (x % 10 < 3) ? 178 : 225 + Math.floor(noise * 0.4);
      }
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, value));
      data[i + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.name = `weapon-finish:${kind}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(kind === 'brushed' ? 2 : 3, kind === 'rubber' ? 6 : 4);
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  FINISH_TEX_CACHE.set(kind, texture);
  return texture;
}

function finishMat(color, kind, roughness, metalness) {
  const key = `${color}|${kind}|${roughness}|${metalness}`;
  if (!FINISH_MAT_CACHE.has(key)) {
    const material = mat(color, roughness, metalness).clone();
    material.map = finishTexture(kind);
    material.userData.finishKind = kind;
    material.needsUpdate = true;
    FINISH_MAT_CACHE.set(key, material);
  }
  return FINISH_MAT_CACHE.get(key);
}

const WOOD_R = 0.85, WOOD_M = 0.05;

/**
 * Apply a camo palette. The builders below read these bindings at build time,
 * so a camo change is: swap the palette, throw the material cache away, and
 * rebuild the models. Nothing is retinted in place -- rebuilding five guns
 * takes single-digit milliseconds and cannot leave a part half-painted.
 */
function setPalette(camo) {
  GUNMETAL = camo.metal;
  DARK = camo.dark;
  POLYMER = camo.polymer;
  TAN = camo.furniture;
  WOODGRIP = camo.wood;
  DEF_R = camo.metalRoughness ?? 0.38;
  DEF_M = camo.metalMetalness ?? 0.35;
  for (const m of MAT_CACHE.values()) m.dispose();
  MAT_CACHE.clear();
  // Finishes multiply the active palette, so a camo change needs fresh base
  // colours while the reusable neutral texture maps themselves can stay.
  FINISH_MAT_CACHE.clear();
}

/**
 * A box with chamfered edges.
 *
 * Real gun bodies are slabs, so boxes are the right primitive -- but a hard
 * 90 degree edge is exactly what reads as "Minecraft". Subdividing and pushing
 * the corner vertices inward rounds the silhouette enough to catch a highlight
 * along every edge, which is what sells it as machined metal.
 */
function part(w, h, d, color, x = 0, y = 0, z = 0, opts = {}) {
  const bevel = opts.bevel ?? 0.22;
  const geo = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const b = bevel * Math.min(w, h, d);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Only true corners move; face centres and edge midpoints stay put.
    const onX = Math.abs(Math.abs(v.x) - hw) < 1e-6;
    const onY = Math.abs(Math.abs(v.y) - hh) < 1e-6;
    const onZ = Math.abs(Math.abs(v.z) - hd) < 1e-6;
    const edges = (onX ? 1 : 0) + (onY ? 1 : 0) + (onZ ? 1 : 0);
    if (edges >= 2) {
      if (onX) v.x -= Math.sign(v.x) * b;
      if (onY) v.y -= Math.sign(v.y) * b;
      if (onZ) v.z -= Math.sign(v.z) * b;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat(color, opts.roughness, opts.metalness));
  m.position.set(x, y, z);
  return m;
}

/**
 * Cylindrical part -- barrels, tubes, scopes, magazines.
 *
 * `opts.open` drops the end caps, and any optic the player looks *through* must
 * set it. CylinderGeometry is capped by default, so a sight tube built without
 * it puts a solid disc across the aim point: from behind you are looking at the
 * rear cap, not down the tube. That is invisible from the hip and total at full
 * zoom, which is exactly where it matters.
 */
function tube(r1, r2, len, color, x = 0, y = 0, z = 0, opts = {}) {
  const geo = new THREE.CylinderGeometry(
    r1, r2, len, opts.segments ?? 10, 1, !!opts.open);
  geo.rotateX(Math.PI / 2);   // lie along -Z, the direction the gun points
  const m = new THREE.Mesh(geo, mat(color, opts.roughness, opts.metalness));
  // An open tube shows its inner wall, which back-face culling would drop.
  // Cloned rather than mutating the shared cache entry, or opening one sight
  // would quietly turn every part sharing that colour double-sided.
  if (opts.open) {
    m.material = m.material.clone();
    m.material.side = THREE.DoubleSide;
  }
  m.position.set(x, y, z);
  return m;
}

/**
 * Mark the weapon's sight line and how close it comes to the eye when aimed.
 *
 * The ADS pose is derived from this rather than hand-tuned per weapon: cancelling
 * the anchor's lateral and vertical offset puts the sights exactly on the screen
 * centre, so moving a front post in the model can never desync the aim.
 *
 * @param y height of the aiming eye line above the model origin
 * @param z how far in front of the camera the weapon sits while aimed
 */
function sightLine(g, y, z, x = 0) {
  const s = new THREE.Object3D();
  s.position.set(x, y, 0);
  g.add(s);
  g.userData.sight = s;
  g.userData.adsZ = z;
}

/** Unlit, additive block -- for anything that should read as self-luminous. */
function glow(w, h, d, color, x = 0, y = 0, z = 0, opacity = 0.85) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  m.position.set(x, y, z);
  return m;
}

/**
 * A boxy optic with a real opening through it, plus the frame around it.
 *
 * Every projected sight in the game needs this: a solid housing centred on the
 * sight line blanks the screen the moment the player aims, which is a mistake
 * worth making only once.
 *
 * @param hw half-width of the window, hh half-height
 */
function opticFrame(g, y, z, hw, hh, color = DARK, bar = 0.013, depth = 0.07) {
  g.add(part(hw * 2 + bar * 2, bar, depth, color, 0, y + hh + bar / 2, z));  // hood
  g.add(part(hw * 2 + bar * 2, bar, depth, color, 0, y - hh - bar / 2, z));  // sill
  g.add(part(bar, hh * 2, depth, color, -hw - bar / 2, y, z));               // left
  g.add(part(bar, hh * 2, depth, color, hw + bar / 2, y, z));                // right
}

// Kept deliberately light: the viewmodel sits against bright outdoor terrain,
// and a true gunmetal reads as a black smear at this size.
let GUNMETAL = 0x6a727d;
let DARK = 0x434a54;
let WOODGRIP = 0x8a6238;
const ACCENT = 0xd9b45f;
const GOLD = 0xe8c357;
const STEEL = 0x9aa4b0;
const ENERGY = 0x4fd8ff;
const RAIL = 0xc08cff;
const RED = 0xff4436;

// Furniture palette: black metal, dark polymer, tan furniture, walnut. Guns
// read as real when the metal and the furniture are visibly different
// materials -- an all-black gun at this poly count is a silhouette.
let POLYMER = 0x3a3f46;
let TAN = 0x8d7f63;

/** Optic glass: faintly tinted, never cached (opacity is per-use). */
function glass(color, opacity) {
  const m = new THREE.MeshStandardMaterial({
    color: srgb(color), roughness: 0.12, metalness: 0,
    transparent: true, opacity, depthWrite: false,
  });
  // A ray through glass is still a clear sight picture. The ADS audit uses
  // this flag rather than guessing from the current opacity, which cosmetics
  // are allowed to change.
  m.userData.adsNonBlocking = true;
  return m;
}

/** Dark reflective scope glass for optics seen from the outside. */
function scopeLens(color, metalness = 0.38) {
  const material = new THREE.MeshStandardMaterial({
    color: srgb(color), roughness: 0.10, metalness,
    transparent: false, opacity: 1, depthWrite: true,
  });
  // The Intervention swaps to a HUD scope before the lens reaches the centre
  // ray. This marker also keeps clearance tooling from treating lens glass as
  // a design obstruction if that cutoff changes later.
  material.userData.adsNonBlocking = true;
  material.userData.scopeLens = true;
  return material;
}

/** A self-lit dot -- red-dot reticles, tritium sights, fiber beads. */
function glowDot(color, intensity = 2.0) {
  return new THREE.MeshStandardMaterial({
    color: srgb(color), emissive: srgb(color), emissiveIntensity: intensity,
    roughness: 0.4, metalness: 0,
  });
}

function reticleMat(color, opacity = 0.95) {
  const m = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // Reticle ink is supposed to cross the aim point; it is not an obstruction.
  m.userData.adsNonBlocking = true;
  return m;
}

function reticleDot(g, color, y, z, r = 0.006, opacity = 0.95) {
  const dot = new THREE.Mesh(new THREE.CircleGeometry(r, 14), reticleMat(color, opacity));
  dot.position.set(0, y, z);
  g.add(dot);
  return dot;
}

function reticleRing(g, color, y, z, r = 0.030, thickness = 0.0018, opacity = 0.78) {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(r, thickness, 6, 32),
    reticleMat(color, opacity),
  );
  ring.position.set(0, y, z);
  g.add(ring);
  return ring;
}

function reticleCross(g, color, y, z, span = 0.052, gap = 0.009, thickness = 0.002, opacity = 0.78) {
  const add = (w, h, x, yy) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), reticleMat(color, opacity));
    m.position.set(x, yy, z);
    g.add(m);
  };
  const arm = (span - gap) * 0.5;
  add(thickness, arm, 0, y + gap * 0.5 + arm * 0.5);
  add(thickness, arm, 0, y - gap * 0.5 - arm * 0.5);
  add(arm, thickness, -gap * 0.5 - arm * 0.5, y);
  add(arm, thickness, gap * 0.5 + arm * 0.5, y);
}

function buildPistol() {
  const g = new THREE.Group();

  // Slide: slim, with an undercut nose. Width is what sells a gun at this
  // camera angle -- a wide slide reads as a plank no matter what sits on it.
  g.add(part(0.050, 0.060, 0.295, GUNMETAL, 0, 0.012, -0.085));
  g.add(part(0.052, 0.014, 0.29, DARK, 0, 0.044, -0.085));       // top strap
  // Slide serrations: three grooves on the visible (left) face.
  for (let i = 0; i < 3; i++) {
    g.add(part(0.006, 0.045, 0.012, DARK, -0.024, 0.012, 0.038 - i * 0.022));
  }
  // Frame, recoil-spring housing and rail nose.
  g.add(part(0.046, 0.040, 0.20, POLYMER, 0, -0.030, -0.13));
  g.add(part(0.046, 0.026, 0.055, POLYMER, 0, -0.052, -0.20));
  // Trigger guard: three thin bars forming an open loop.
  g.add(part(0.012, 0.034, 0.012, POLYMER, 0, -0.068, -0.055));  // front post
  g.add(part(0.012, 0.012, 0.075, POLYMER, 0, -0.088, -0.02));   // bottom bar
  g.add(part(0.010, 0.026, 0.014, DARK, 0, -0.062, -0.012));     // trigger
  // Grip: raked back, with a flared magwell and base plate.
  const grip = part(0.052, 0.150, 0.068, POLYMER, 0, -0.105, 0.045);
  grip.rotation.x = -0.20;
  g.add(grip);
  g.add(part(0.058, 0.020, 0.076, DARK, 0, -0.175, 0.058));      // base plate
  // Hammer and beavertail.
  g.add(part(0.016, 0.030, 0.018, DARK, 0, 0.030, 0.062));
  g.add(part(0.040, 0.014, 0.030, POLYMER, 0, -0.010, 0.062));
  // Notch-and-post irons. The post tip and the notch floor share a height so
  // the sight picture lines up on the screen centre.
  g.add(part(0.02, 0.035, 0.02, ACCENT, 0, 0.055, -0.225));      // front post
  rearNotch(g, 0.070, 0.055, { gap: 0.042, blade: 0.010, h: 0.040 });
  // Tritium three-dot: two on the rear blades, one on the post, all facing
  // the eye. Tiny, but they read the instant the gun is raised in shade.
  for (const [x, z] of [[-0.031, 0.041], [0.031, 0.041], [0, -0.212]]) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.005, 6, 5), glowDot(0x7ee08a, 1.8));
    dot.position.set(x, 0.062, z);
    g.add(dot);
  }
  sightLine(g, 0.070, -0.30);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, -0.245);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  addHands(g, [0, -0.115, 0.045], null);
  return g;
}

function buildRifle() {
  const g = new THREE.Group();

  // Upper and lower receiver, slim, with a full-length top rail.
  g.add(part(0.044, 0.052, 0.30, DARK, 0, 0.012, -0.10));         // upper
  g.add(part(0.046, 0.048, 0.17, DARK, 0, -0.030, -0.065));       // lower
  g.add(part(0.038, 0.016, 0.30, GUNMETAL, 0, 0.048, -0.10));     // rail
  // Ejection port plate and bolt-release nub on the visible face.
  g.add(part(0.006, 0.028, 0.070, GUNMETAL, -0.023, 0.010, -0.06));
  g.add(part(0.008, 0.020, 0.030, GUNMETAL, -0.024, -0.010, 0.005));
  // Charging handle T at the rear of the rail.
  g.add(part(0.052, 0.012, 0.022, GUNMETAL, 0, 0.052, 0.048));
  // Barrel, gas block, and a slotted muzzle brake.
  g.add(tube(0.015, 0.015, 0.36, GUNMETAL, 0, 0.012, -0.44));
  g.add(part(0.028, 0.034, 0.030, DARK, 0, 0.020, -0.555));       // gas block
  g.add(tube(0.020, 0.019, 0.055, DARK, 0, 0.012, -0.625));       // brake body
  g.add(part(0.044, 0.006, 0.018, DARK, 0, 0.012, -0.625));       // brake ports
  // Handguard: octagonal, in tan, with vent strips along the sides.
  const guard = tube(0.031, 0.033, 0.24, TAN, 0, 0.008, -0.36,
    { segments: 8, roughness: 0.7, metalness: 0.05 });
  g.add(guard);
  for (const sx of [-1, 1]) {
    g.add(part(0.006, 0.014, 0.17, DARK, sx * 0.030, 0.008, -0.36));
  }
  // Magwell and a visibly curved magazine: two segments at different rakes.
  g.add(part(0.048, 0.045, 0.075, DARK, 0, -0.062, -0.135));
  const mag1 = part(0.040, 0.095, 0.062, POLYMER, 0, -0.115, -0.145);
  mag1.rotation.x = 0.18;
  g.add(mag1);
  const mag2 = part(0.038, 0.075, 0.058, POLYMER, 0, -0.185, -0.175);
  mag2.rotation.x = 0.42;
  g.add(mag2);
  // Trigger guard and trigger.
  g.add(part(0.010, 0.030, 0.010, DARK, 0, -0.062, -0.075));
  g.add(part(0.010, 0.010, 0.068, DARK, 0, -0.080, -0.045));
  g.add(part(0.009, 0.024, 0.012, GUNMETAL, 0, -0.058, -0.032));
  // Pistol grip, raked.
  const grip = part(0.042, 0.115, 0.055, TAN, 0, -0.098, 0.028);
  grip.rotation.x = -0.35;
  g.add(grip);
  // Buffer tube and an adjustable stock: comb, strut, butt pad.
  g.add(tube(0.019, 0.021, 0.15, DARK, 0, 0.012, 0.115, { segments: 8 }));
  g.add(part(0.040, 0.048, 0.130, TAN, 0, 0.010, 0.225));         // comb
  const strut = part(0.028, 0.075, 0.030, TAN, 0, -0.035, 0.245);
  strut.rotation.x = 0.35;
  g.add(strut);
  g.add(part(0.048, 0.105, 0.024, DARK, 0, -0.020, 0.295));       // butt pad
  // Protected front post, tipped level with the rear aperture.
  g.add(part(0.02, 0.045, 0.02, ACCENT, 0, 0.0825, -0.60));
  g.add(part(0.012, 0.055, 0.016, DARK, -0.03, 0.086, -0.60));    // ear L
  g.add(part(0.012, 0.055, 0.016, DARK, 0.03, 0.086, -0.60));     // ear R
  // Red-dot sight on a riser, centred on the sight line (y 0.105), so the
  // ADS pose puts the emitter exactly on the screen centre. Open tube, glass
  // both ends, glowing emitter inside -- the front post at the muzzle stays as
  // the backup iron and co-witnesses through the window.
  g.add(part(0.030, 0.026, 0.062, DARK, 0, 0.062, 0.015));        // riser
  const rdBody = tube(0.026, 0.029, 0.055, DARK, 0, 0.105, 0.015,
    { segments: 10, open: true });
  g.add(rdBody);
  g.add(tube(0.030, 0.030, 0.010, GUNMETAL, 0, 0.105, -0.014,
    { segments: 10, open: true }));
  const rdFront = new THREE.Mesh(new THREE.CircleGeometry(0.024, 12), glass(0x9fd8e6, 0.22));
  rdFront.position.set(0, 0.105, -0.041);
  rdFront.rotation.y = Math.PI;
  g.add(rdFront);
  const rdRear = new THREE.Mesh(new THREE.CircleGeometry(0.023, 12), glass(0x9fd8e6, 0.14));
  rdRear.position.set(0, 0.105, 0.043);
  g.add(rdRear);
  reticleDot(g, 0xff3b2f, 0.105, 0.008, 0.0055);
  // Brightness dial on the left flank, because real optics have controls.
  const rdKnob = tube(0.008, 0.008, 0.012, GUNMETAL, -0.032, 0.105, 0.015, { segments: 8 });
  rdKnob.rotation.y = Math.PI / 2;
  g.add(rdKnob);
  sightLine(g, 0.105, -0.26);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.012, -0.66);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  addHands(g, [0, -0.135, 0.028], [0, -0.045, -0.36]);
  return g;
}

function buildShotgun() {
  const g = new THREE.Group();

  g.add(part(0.052, 0.080, 0.30, DARK, 0, 0, -0.10));             // receiver
  g.add(part(0.006, 0.030, 0.075, GUNMETAL, -0.026, 0.005, -0.08)); // port plate
  g.add(tube(0.024, 0.024, 0.50, GUNMETAL, 0, 0.024, -0.52));     // barrel
  g.add(part(0.014, 0.008, 0.46, GUNMETAL, 0, 0.052, -0.50));     // vent rib
  g.add(tube(0.019, 0.019, 0.44, DARK, 0, -0.030, -0.49));        // tube magazine
  g.add(tube(0.022, 0.022, 0.020, DARK, 0, -0.003, -0.70));       // barrel clamp
  // Pump, ribbed: the wood sleeve plus two darker rings.
  const pump = tube(0.034, 0.034, 0.16, WOODGRIP, 0, -0.030, -0.40,
    { segments: 8, roughness: WOOD_R, metalness: WOOD_M });
  g.add(pump);
  const ring1 = tube(0.0355, 0.0355, 0.012, 0x5f4426, 0, -0.030, -0.44, { segments: 8 });
  const ring2 = tube(0.0355, 0.0355, 0.012, 0x5f4426, 0, -0.030, -0.36, { segments: 8 });
  g.add(ring1, ring2);
  g.userData.pump = pump;
  g.userData.pumpRings = [ring1, ring2];
  // Stock: angled wrist flowing into a combed butt with a recoil pad.
  const wrist = part(0.048, 0.075, 0.14, WOODGRIP, 0, -0.035, 0.10);
  wrist.rotation.x = 0.30;
  g.add(wrist);
  g.add(part(0.052, 0.100, 0.17, WOODGRIP, 0, -0.055, 0.225));    // butt
  g.add(part(0.050, 0.020, 0.17, WOODGRIP, 0, 0.002, 0.22));      // comb
  g.add(part(0.056, 0.105, 0.020, 0x2a2622, 0, -0.055, 0.315));   // recoil pad
  // Bead up front, shallow notch on the receiver: aiming a shotgun is about
  // pointing, so the sight picture stays deliberately open.
  // Fiber-optic bead: a lit green pipe in a steel saddle, the way modern
  // scatterguns actually wear them.
  g.add(part(0.022, 0.018, 0.030, GUNMETAL, 0, 0.062, -0.72));    // saddle
  const fiber = tube(0.006, 0.006, 0.026, 0x51e06a, 0, 0.074, -0.72, { segments: 6 });
  fiber.material = glowDot(0x51e06a, 2.2);
  g.add(fiber);
  rearNotch(g, 0.072, -0.02, { gap: 0.05, blade: 0.010, h: 0.038 });
  sightLine(g, 0.075, -0.26);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.024, -0.77);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  addHands(g, [0, -0.115, 0.06], [0, -0.055, -0.40]);
  return g;
}

function buildSniper() {
  const g = new THREE.Group();
  g.name = 'weapon:sniper:intervention';
  g.userData.variant = 'intervention';
  // Warmer than the shared rifle furniture in the standard finish, matching
  // the Intervention's signature desert-tan chassis. Custom finishes still
  // supply their own furniture colour through TAN.
  const CHASSIS = TAN === 0x8d7f63 ? 0xb28b55 : TAN;

  const add = (name, mesh) => {
    mesh.name = name;
    g.add(mesh);
    return mesh;
  };
  const rodBetween = (name, start, end, radius, color) => {
    const a = new THREE.Vector3(...start);
    const b = new THREE.Vector3(...end);
    const direction = b.clone().sub(a);
    const rod = tube(radius, radius, direction.length(), color,
      (a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5,
      { segments: 8 });
    rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize());
    return add(name, rod);
  };

  // An original low-poly take on a modern anti-materiel bolt action. The long
  // free-floating barrel, vented chassis and skeletal adjustable stock carry
  // the Intervention silhouette without depending on a downloaded gun model.
  add('receiver', part(0.086, 0.105, 0.34, CHASSIS, 0, -0.004, 0.005));
  add('receiver-sideplate', part(0.009, 0.070, 0.26, CHASSIS, -0.047, -0.002, -0.015));
  add('cylindrical-action', tube(0.052, 0.052, 0.50, CHASSIS, 0, 0.030, -0.235,
    { segments: 14, roughness: 0.52, metalness: 0.24 }));
  add('action-front-collar', tube(0.058, 0.058, 0.035, GUNMETAL,
    0, 0.030, -0.475, { segments: 14 }));
  add('top-rail', part(0.064, 0.014, 0.56, DARK, 0, 0.091, -0.10,
    { bevel: 0.10 }));
  for (let i = 0; i < 9; i++) {
    add(`rail-slot-${i}`, part(0.064, 0.008, 0.012, DARK, 0, 0.082,
      0.095 - i * 0.052, { bevel: 0.04 }));
  }

  // The M200's unmistakable open bridge hangs beneath the tubular action. Two
  // rails and angled end braces leave a real window instead of a solid fore-end.
  add('fore-end', part(0.088, 0.020, 0.40, CHASSIS, 0, -0.104, -0.34));
  add('fore-end-upper-rail', part(0.088, 0.018, 0.35, CHASSIS, 0, -0.035, -0.325));
  const frontBrace = add('fore-end-front-brace', part(0.086, 0.020, 0.115, CHASSIS,
    0, -0.068, -0.515));
  frontBrace.rotation.x = -0.54;
  const rearBrace = add('fore-end-rear-brace', part(0.086, 0.020, 0.105, CHASSIS,
    0, -0.068, -0.165));
  rearBrace.rotation.x = 0.48;
  add('fore-end-bottom-rail', part(0.060, 0.012, 0.34, DARK, 0, -0.120, -0.34));
  // Round lightening holes along the lower bridge are the strongest Intervention
  // read in profile. Dark cross-pins create the appearance of cut-through holes
  // from either side while remaining cheap, robust geometry.
  for (let i = 0; i < 6; i++) {
    const hole = add(`chassis-vent--1-${i}`, tube(0.012, 0.012, 0.094, 0x0e1115,
      0, -0.096, -0.455 + i * 0.055, { segments: 12 }));
    hole.rotation.y = Math.PI / 2;
  }

  // Long stepped tan barrel and perforated brake, matching the light-coloured
  // barrel assembly in the reference instead of the previous blue steel rod.
  add('barrel', tube(0.018, 0.022, 0.72, CHASSIS, 0, 0.030, -0.815,
    { segments: 14, roughness: 0.48, metalness: 0.30 }));
  add('barrel-collar', tube(0.031, 0.031, 0.052, CHASSIS, 0, 0.030, -0.500,
    { segments: 14 }));
  add('barrel-step', tube(0.025, 0.025, 0.030, GUNMETAL, 0, 0.030, -1.155,
    { segments: 14 }));
  add('muzzle-brake', tube(0.040, 0.032, 0.135, CHASSIS, 0, 0.030, -1.225,
    { segments: 14, roughness: 0.42, metalness: 0.34 }));
  for (let i = 0; i < 3; i++) {
    const port = add(`muzzle-port-${i}`, tube(0.010, 0.010, 0.086, 0x0e1115,
      0, 0.030, -1.190 - i * 0.035, { segments: 10 }));
    port.rotation.y = Math.PI / 2;
  }
  add('muzzle-bore', tube(0.021, 0.021, 0.010, DARK, 0, 0.030, -1.297,
    { segments: 12, open: true }));

  // Oversized five-round magazine, trigger loop, and a steep precision grip.
  add('magwell', part(0.075, 0.052, 0.120, CHASSIS, 0, -0.068, -0.045));
  const magazineAssembly = new THREE.Group();
  magazineAssembly.name = 'magazine-assembly';
  g.add(magazineAssembly);
  g.userData.magazine = magazineAssembly;
  const magazine = part(0.070, 0.155, 0.115, DARK, 0, -0.145, -0.075);
  magazine.name = 'magazine';
  magazine.rotation.x = 0.09;
  magazineAssembly.add(magazine);
  const floorplate = part(0.078, 0.018, 0.120, GUNMETAL, 0, -0.223, -0.082);
  floorplate.name = 'magazine-floorplate';
  magazineAssembly.add(floorplate);
  for (let i = 0; i < 3; i++) {
    const rib = part(0.074, 0.105, 0.008, GUNMETAL,
      0, -0.145, -0.112 + i * 0.045, { bevel: 0.05 });
    rib.name = `magazine-rib-${i}`;
    magazineAssembly.add(rib);
  }
  add('trigger-guard-front', part(0.012, 0.045, 0.012, DARK, 0, -0.078, 0.035));
  add('trigger-guard-bottom', part(0.012, 0.012, 0.090, DARK, 0, -0.102, 0.073));
  const trigger = add('trigger', part(0.010, 0.033, 0.012, GUNMETAL, 0, -0.071, 0.065));
  trigger.rotation.x = 0.22;
  // A shaped precision grip instead of a plain cuboid: palm swell, inset side
  // panels, thumb shelf and three front-strap grooves remain readable in the
  // close first-person pose even with no hand covering them.
  const grip = add('pistol-grip', part(0.056, 0.145, 0.070, POLYMER,
    0, -0.125, 0.135, { bevel: 0.34 }));
  grip.rotation.x = -0.28;
  const palmSwell = add('grip-palm-swell', part(0.061, 0.098, 0.026, POLYMER,
    0, -0.137, 0.166, { bevel: 0.40 }));
  palmSwell.rotation.x = -0.28;
  for (const side of [-1, 1]) {
    const panel = add(`grip-panel-${side}`, part(0.008, 0.100, 0.048, DARK,
      side * 0.030, -0.128, 0.137, { bevel: 0.32 }));
    panel.rotation.x = -0.28;
  }
  const thumbShelf = add('grip-thumb-shelf', part(0.074, 0.017, 0.042, POLYMER,
    0, -0.066, 0.121, { bevel: 0.32 }));
  thumbShelf.rotation.x = -0.18;
  for (let i = 0; i < 3; i++) {
    const groove = add(`grip-finger-groove-${i}`, part(0.060, 0.010, 0.016, DARK,
      0, -0.096 - i * 0.031, 0.101 + i * 0.009, { bevel: 0.40 }));
    groove.rotation.x = -0.28;
  }
  add('grip-cap', part(0.058, 0.018, 0.072, DARK, 0, -0.196, 0.155));

  // The complete bolt lives under one animated parent: lift, pull, push and
  // lock can move the shaft, handle and knob as one mechanical assembly.
  const bolt = new THREE.Group();
  bolt.name = 'bolt-cycle';
  bolt.position.set(0, 0, 0.075);
  bolt.userData.restZ = bolt.position.z;
  g.add(bolt);
  g.userData.bolt = bolt;
  const boltShaft = tube(0.015, 0.015, 0.20, GUNMETAL, 0, 0.026, -0.060,
    { segments: 12, roughness: 0.26, metalness: 0.60 });
  boltShaft.name = 'bolt-shaft';
  bolt.add(boltShaft);
  const boltArm = part(0.090, 0.014, 0.014, GUNMETAL, 0.052, 0.018, 0);
  boltArm.name = 'bolt-handle';
  boltArm.rotation.z = -0.48;
  bolt.add(boltArm);
  const boltKnob = tube(0.038, 0.038, 0.026, DARK, 0.096, -0.025, 0,
    { segments: 12 });
  boltKnob.rotation.y = Math.PI / 2;
  boltKnob.name = 'bolt-knob';
  bolt.add(boltKnob);
  add('safety', part(0.009, 0.018, 0.028, ACCENT, -0.039, 0.031, 0.085));

  // Hidden until the extraction stroke. It arcs out of the open action during
  // the bolt cycle, making the long pause between sniper shots feel purposeful.
  const casing = tube(0.006, 0.006, 0.038, ACCENT, 0.044, 0.055, -0.015,
    { segments: 10, roughness: 0.25, metalness: 0.72 });
  casing.name = 'spent-casing';
  casing.rotation.z = Math.PI / 2;
  casing.visible = false;
  g.add(casing);
  g.userData.casing = casing;

  // The real silhouette has two thin black telescoping rods, not solid tan
  // struts. Tan cheek and butt modules float on those rods with open air below.
  add('stock-hinge', part(0.072, 0.082, 0.060, CHASSIS, 0, -0.018, 0.145));
  add('stock-upper-strut', tube(0.009, 0.009, 0.47, DARK,
    0, 0.006, 0.385, { segments: 10 }));
  add('stock-lower-strut', tube(0.009, 0.009, 0.45, DARK,
    0, -0.050, 0.375, { segments: 10 }));
  add('stock-guide', tube(0.012, 0.012, 0.40, GUNMETAL,
    0, -0.102, 0.390, { segments: 10 }));
  add('cheek-rest', part(0.075, 0.042, 0.24, CHASSIS, 0, 0.066, 0.450));
  add('cheek-adjuster', tube(0.010, 0.010, 0.078, DARK,
    -0.048, 0.038, 0.450, { segments: 8 }));
  add('butt-frame', part(0.075, 0.170, 0.038, CHASSIS, 0, -0.024, 0.625));
  add('recoil-pad', part(0.083, 0.175, 0.025, POLYMER, 0, -0.024, 0.652));
  add('stock-monopod', part(0.023, 0.145, 0.023, DARK, 0, -0.155, 0.595));
  add('monopod-foot', tube(0.026, 0.026, 0.022, DARK,
    0, -0.230, 0.595, { segments: 10 }));

  // Compact tan optic with a straight objective bell and black rubber eye cup,
  // positioned over the receiver like the supplied reference.
  add('scope-main', tube(0.032, 0.032, 0.34, CHASSIS, 0, 0.163, -0.005,
    { segments: 14, roughness: 0.46, metalness: 0.28 }));
  add('scope-objective', tube(0.043, 0.034, 0.105, CHASSIS, 0, 0.163, -0.225,
    { segments: 14, open: true }));
  add('scope-eyepiece', tube(0.046, 0.038, 0.075, DARK, 0, 0.163, 0.205,
    { segments: 14, open: true }));
  for (let i = 0; i < 4; i++) {
    add(`scope-eye-rib-${i}`, tube(0.048, 0.048, 0.009, 0x1b1e22,
      0, 0.163, 0.220 + i * 0.014, { segments: 14, open: true }));
  }
  for (const [name, z] of [['front', -0.105], ['rear', 0.105]]) {
    add(`scope-mount-${name}`, part(0.034, 0.075, 0.030, DARK,
      0, 0.113, z));
    add(`scope-ring-${name}`, tube(0.037, 0.037, 0.025, DARK,
      0, 0.163, z, { segments: 12, open: true }));
  }
  const objectiveGlass = new THREE.Mesh(
    new THREE.CircleGeometry(0.0415, 24), scopeLens(0x173b46, 0.46));
  objectiveGlass.position.set(0, 0.163, -0.281);
  objectiveGlass.rotation.y = Math.PI;
  add('scope-objective-glass', objectiveGlass);
  const eyeGlass = new THREE.Mesh(
    new THREE.CircleGeometry(0.0365, 24), scopeLens(0x0c171b, 0.30));
  eyeGlass.position.set(0, 0.163, 0.247);
  add('scope-eye-glass', eyeGlass);
  // Small off-axis coatings suggest curved lens reflections without making the
  // entire aperture transparent. They sit just outside the opaque glass.
  const objectiveGlint = new THREE.Mesh(
    new THREE.CircleGeometry(0.010, 16), glass(0x65c4d7, 0.42));
  objectiveGlint.position.set(-0.012, 0.175, -0.282);
  objectiveGlint.rotation.y = Math.PI;
  add('scope-objective-glint', objectiveGlint);
  const eyeGlint = new THREE.Mesh(
    new THREE.CircleGeometry(0.008, 16), glass(0x568c99, 0.28));
  eyeGlint.position.set(-0.010, 0.174, 0.248);
  add('scope-eye-glint', eyeGlint);
  const elevation = add('scope-elevation', tube(0.017, 0.017, 0.032, GUNMETAL,
    0, 0.213, 0.000, { segments: 10 }));
  elevation.rotation.x = Math.PI / 2;
  const windage = add('scope-windage', tube(0.017, 0.017, 0.032, GUNMETAL,
    -0.050, 0.163, 0.000, { segments: 10 }));
  windage.rotation.y = Math.PI / 2;

  // Deployed forward bipod with splayed legs and dark rubber feet. Its high
  // collar and long legs are another instantly recognisable part of the M200.
  add('bipod-block', part(0.105, 0.055, 0.055, CHASSIS, 0, -0.020, -0.610));
  for (const side of [-1, 1]) {
    rodBetween(`bipod-leg-${side}`, [side * 0.040, -0.038, -0.610],
      [side * 0.180, -0.300, -0.660], 0.011, CHASSIS);
    const foot = add(`bipod-foot-${side}`, tube(0.026, 0.026, 0.050, DARK,
      side * 0.180, -0.306, -0.660, { segments: 10 }));
    foot.rotation.y = Math.PI / 2;
  }

  // Eye line runs through the optic; the physical model fades only at the end
  // of the ADS animation, so this anchor keeps the whole raise perfectly level.
  sightLine(g, 0.163, -0.22);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle-anchor';
  muzzle.position.set(0, 0.030, -1.302);
  g.add(muzzle);
  g.userData.muzzle = muzzle;

  // The Intervention is intentionally gun-only in first person. The supplied
  // tactical soldier is a complete skinned avatar, not a detachable arm, and
  // stretching the generic procedural sleeve to the bolt looked disconnected.
  g.userData.handsOmitted = true;

  // Give each real-world material its own surface response. These neutral
  // detail maps multiply the active finish colour, so bought skins and camo
  // still repaint the weapon without flattening its ceramic, steel, polymer
  // and rubber character.
  g.traverse((object) => {
    if (!object.isMesh || !object.material?.userData) return;
    const source = object.material;
    const base = source.userData.baseHex;
    if (base === CHASSIS) {
      object.material = finishMat(CHASSIS, 'cerakote', source.roughness, source.metalness);
    } else if (/recoil-pad|scope-eye-rib|bipod-foot|monopod-foot/.test(object.name)) {
      object.material = finishMat(base ?? DARK, 'rubber', source.roughness, source.metalness);
    } else if (base === POLYMER || /magazine|grip/.test(object.name)) {
      object.material = finishMat(base ?? POLYMER, 'polymer', source.roughness, source.metalness);
    } else if (base === GUNMETAL || base === STEEL || base === DARK) {
      object.material = finishMat(base, 'brushed', source.roughness, source.metalness);
    }
  });
  return g;
}

function buildBazooka() {
  const g = new THREE.Group();
  const TUBE = 0x4c6a45;
  // Launch tube as an actual tube, with a flared rear venturi and heat ribs.
  g.add(tube(0.062, 0.062, 0.86, TUBE, 0, 0.02, -0.26, { segments: 12, roughness: 0.6 }));
  g.add(tube(0.066, 0.082, 0.14, DARK, 0, 0.02, 0.22, { segments: 12 }));   // venturi
  g.add(tube(0.068, 0.068, 0.025, DARK, 0, 0.02, -0.66, { segments: 12 })); // muzzle ring
  g.add(tube(0.066, 0.066, 0.02, DARK, 0, 0.02, -0.40, { segments: 12 }));  // rib
  g.add(tube(0.066, 0.066, 0.02, DARK, 0, 0.02, -0.05, { segments: 12 }));  // rib
  // Grips and a shoulder rest under the tube.
  const grip = part(0.040, 0.115, 0.055, DARK, 0, -0.115, -0.10);
  grip.rotation.x = -0.25;
  g.add(grip);
  g.add(part(0.010, 0.010, 0.060, DARK, 0, -0.085, -0.135));      // trigger bar
  g.add(part(0.042, 0.085, 0.055, DARK, 0, -0.10, -0.42));        // fore grip
  g.add(part(0.055, 0.030, 0.16, DARK, 0, -0.052, 0.08));         // shoulder rest

  // Aiming sight: an open optical block standing clear of the tube, so the
  // player looks over the launcher rather than down it. Built as a frame with a
  // genuine window -- a solid housing centred on the sight line would blank the
  // screen the moment the player aimed. The ranging ladder is the HUD overlay.
  g.add(part(0.128, 0.014, 0.075, DARK, 0, 0.217, -0.34));        // hood
  g.add(part(0.128, 0.014, 0.075, DARK, 0, 0.093, -0.34));        // sill
  g.add(part(0.014, 0.138, 0.075, DARK, -0.057, 0.155, -0.34));   // frame L
  g.add(part(0.014, 0.138, 0.075, DARK, 0.057, 0.155, -0.34));    // frame R
  // Faint tinted pane across the window, plus the post that marks the aim point
  // just under the HUD reticle.
  const pane = new THREE.Mesh(
    new THREE.BoxGeometry(0.10, 0.11, 0.004),
    new THREE.MeshStandardMaterial({
      color: srgb(0x9fd8e6), roughness: 0.2, metalness: 0,
      transparent: true, opacity: 0.14, depthWrite: false,
    }));
  pane.position.set(0, 0.155, -0.372);
  g.add(pane);
  g.add(part(0.008, 0.04, 0.008, ACCENT, 0, 0.120, -0.34));       // aiming post
  // Held closer to the eye than the small arms, so the ranging ladder has room
  // to sit inside the window rather than spilling past the sill.
  sightLine(g, 0.155, -0.26);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -0.72);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  addHands(g, [0, -0.155, -0.09], [0, -0.13, -0.42]);
  return g;
}

/**
 * Hands and forearms.
 *
 * The forearm is the part that matters. A glove floating on a weapon reads as
 * a prop stuck to a prop -- what anchors a first-person weapon to a body is
 * the sleeve running from the wrist down toward the bottom corner of the
 * screen, the way an arm actually leaves the frame. The mitts themselves stay
 * simple spheres (they cannot fold inside-out, unlike bevelled boxes, which is
 * how the first attempt turned into spiked stars).
 */
export function addHands(g, grip, support) {
  const weapon = g;
  const glove = mat(0x2a2d31, 0.8, 0.05);
  const sleeve = mat(0x4a4f45, 0.95, 0.0);

  // Everything the hands add goes under one flagged group.
  //
  // The flag is what lets weaponmodels.js measure the *weapon* when it fits a
  // downloaded model to this one. A bounding box around this group includes an
  // arm running off the bottom of the screen, so fitting to it made every loaded
  // gun shorter than it should be and parked it wherever the arm dragged the
  // centroid -- and nothing downstream could tell the two apart afterwards.
  const body = new THREE.Group();
  body.name = 'hands';
  body.userData.hands = true;
  g.add(body);
  g = body;

  const UP = new THREE.Vector3(0, 1, 0);

  const hand = (pos, roll, forward, mirror = false, armDir = null) => {
    const side = mirror ? 1 : -1;
    // The hand, cuff and forearm share an identity transform so weapon-specific
    // animation can move the complete limb without tearing the glove away from
    // its sleeve. Child coordinates remain in gun space, preserving every
    // existing authored pose.
    const limb = new THREE.Group();
    g.add(limb);
    const h = new THREE.Group();

    const palmGeo = new THREE.SphereGeometry(0.052, 10, 8);
    const palm = new THREE.Mesh(palmGeo, glove);
    palm.scale.set(1.0, 1.2, 1.45);
    h.add(palm);

    // Finger mass, curled around the far side of whatever is held.
    const fingers = new THREE.Mesh(palmGeo, glove);
    fingers.scale.set(0.82, 0.85, 1.05);
    fingers.position.set(-side * 0.020, -0.048, -0.040);
    fingers.rotation.x = -0.55;
    h.add(fingers);

    const thumbGeo = new THREE.CapsuleGeometry(0.019, 0.042, 1, 6);
    const thumb = new THREE.Mesh(thumbGeo, glove);
    thumb.position.set(side * 0.042, 0.018, -0.012);
    thumb.rotation.z = -side * 1.0;
    thumb.rotation.x = -0.4;
    h.add(thumb);

    h.position.set(pos[0], pos[1], pos[2]);
    h.rotation.z = roll;
    h.rotation.x = forward;
    limb.add(h);

    // The forearm: a tapered sleeve from the wrist toward off-screen. Built in
    // gun space (not inside the hand group) so its direction is stated once,
    // in screen terms, instead of fighting the hand's own rotation.
    if (armDir) {
      const dir = new THREE.Vector3(...armDir).normalize();
      const arm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.033, 0.046, 0.34, 9), sleeve);
      arm.quaternion.setFromUnitVectors(UP, dir);
      arm.position.set(
        pos[0] + dir.x * -0.16, pos[1] + dir.y * -0.16, pos[2] + dir.z * -0.16);
      // Cylinder axis points along dir; shift so the narrow end meets the wrist.
      arm.position.addScaledVector(dir, 0.0);
      limb.add(arm);

      // Rolled cuff where glove meets sleeve.
      const cuffM = new THREE.Mesh(
        new THREE.CylinderGeometry(0.042, 0.044, 0.045, 9), sleeve);
      cuffM.quaternion.copy(arm.quaternion);
      cuffM.position.set(pos[0] + dir.x * -0.045, pos[1] + dir.y * -0.045, pos[2] + dir.z * -0.045);
      limb.add(cuffM);
    }
    limb.userData.hand = h;
    limb.userData.restPosition = limb.position.clone();
    limb.userData.restRotation = limb.rotation.clone();
    return limb;
  };

  // Arm directions point from elbow to wrist, in gun space: the trigger arm
  // comes up from the shoulder behind and below; the support arm crosses in
  // from below and slightly left.
  if (grip) {
    weapon.userData.triggerHand = hand(grip, -0.15, 0.25, false, [0.22, 0.92, -0.40]);
    weapon.userData.triggerHand.name = 'trigger-hand-limb';
  }
  if (support) {
    weapon.userData.supportHand = hand(support, 0.25, -0.2, true, [-0.14, 0.95, -0.30]);
    weapon.userData.supportHand.name = 'support-hand-limb';
  }
  return g;
}

// ----------------------------------------------------------------- melee tools
// No sight anchors: melee weapons never aim, so there is no sight picture to
// line up. They are posed further into frame than the guns because a swing has
// to be visible to be readable.

/**
 * Pickaxe.
 *
 * The haft is treated as a line and everything else is placed *on* it, rather
 * than each piece being positioned by hand. Hand-typed offsets are how the
 * previous head ended up floating a palm's width clear of the wood it is
 * supposed to be wedged into -- visible the moment the tool was held at any
 * angle but straight on.
 *
 * The head hangs off a group raked to match the haft, so its local axes are the
 * ones that actually mean something: -Z runs out along the haft, -Y is where
 * the pick goes, +Y the adze. Perpendicular is then a fact about the model
 * instead of a number that has to be re-derived every time the rake changes.
 */
function buildPickaxe() {
  const g = new THREE.Group();

  // The rake is steep on purpose. The head sits square to the haft, so a
  // shallow rake aims the pick at the floor -- correct, and unreadable in first
  // person. Standing the haft up swings that same perpendicular round to point
  // forward, which is the pose the tool is recognisable in.
  const TILT = 0.95;
  const S = Math.sin(TILT), C = Math.cos(TILT);
  const BUTT = [0, -0.34, 0.11];
  const LEN = 0.62;
  /** A point `d` along the haft, measured from the butt. */
  const at = (d) => [BUTT[0], BUTT[1] + S * d, BUTT[2] - C * d];

  // Haft in three tapered segments rather than one bar. A helve is thin at the
  // waist and swells at both ends, and that waist is most of why a pickaxe
  // reads as sprung timber instead of a length of pipe.
  const haft = (d0, d1, r0, r1, color = WOODGRIP, opts = {}) => {
    const mid = at((d0 + d1) / 2);
    const m = tube(r0, r1, d1 - d0, color, mid[0], mid[1], mid[2],
      { segments: 10, roughness: WOOD_R, metalness: WOOD_M, ...opts });
    m.rotation.x = TILT;
    return m;
  };
  g.add(haft(0.00, 0.24, 0.030, 0.023));
  g.add(haft(0.24, 0.46, 0.023, 0.022));
  // Runs a little past the head, so there is end grain showing inside the eye
  // for the wedge to be driven into rather than a wedge stuck onto steel.
  g.add(haft(0.46, LEN + 0.046, 0.022, 0.028));

  // Bound grip, and two raised turns of it. The bands are what give the lower
  // haft a sense of scale -- bare wood at this poly count has no features at
  // all, so the whole shaft reads as one smooth taper and the eye slides off.
  g.add(haft(0.03, 0.23, 0.032, 0.029, DARK, { roughness: 0.9, metalness: 0.05 }));
  g.add(haft(0.075, 0.095, 0.035, 0.035, DARK, { roughness: 0.9, metalness: 0.05 }));
  g.add(haft(0.175, 0.195, 0.035, 0.035, DARK, { roughness: 0.9, metalness: 0.05 }));

  // Butt cap, slightly proud of the wood so it catches an edge highlight.
  g.add(haft(-0.02, 0.01, 0.034, 0.034, GUNMETAL, { roughness: 0.5, metalness: 0.5 }));

  // ------------------------------------------------------------------- head
  const hp = at(LEN);
  const head = new THREE.Group();
  head.position.set(hp[0], hp[1], hp[2]);
  head.rotation.x = TILT;
  g.add(head);

  // The eye: the steel collar the haft passes through, and the only part of the
  // head that touches wood. Elongated along the haft, because that is the axis
  // it grips on.
  head.add(part(0.086, 0.118, 0.104, GUNMETAL, 0, 0, 0));
  head.add(part(0.094, 0.036, 0.036, DARK, 0, 0, -0.048));      // collar lip
  // The wedge driven into the haft's end grain to lock the head on. Sunk into
  // the collar, not perched on it -- a wedge standing proud reads as a snapped
  // off shard of something rather than a fastening.
  head.add(part(0.030, 0.080, 0.012, 0xdfe6ee, 0, 0, -0.046));

  /**
   * One limb of the head, raked `phi` off square and tapering as it goes.
   *
   * Built from tapered prisms rather than stacked boxes. A pick narrows
   * continuously from eye to point, and approximating that with boxes gives a
   * staircase -- each step visible, and every butt joint pulled open by the
   * chamfer `part` puts on the faces it makes. A prism just tapers.
   *
   * @param from [y, z] in head space; returns the far end in the same form
   */
  const limb = (from, len, r0, r1, phi, color = STEEL, segments = 6) => {
    const dy = -Math.cos(phi), dz = -Math.sin(phi);
    const m = tube(r0, r1, len, color,
      0, from[0] + dy * len / 2, from[1] + dz * len / 2, { segments });
    // A tube lies along its own Z, so square it onto the limb direction.
    // Note the sign: rotating by a about X sends +Z to (0, -sin a, cos a), so
    // the angle that aims -Z down the limb is phi - 90, not 90 - phi. Getting
    // that backwards mirrors each piece about its own root, which walks the
    // arm down the screen as a row of detached blocks.
    m.rotation.x = phi - Math.PI / 2;
    head.add(m);
    return [from[0] + dy * len, from[1] + dz * len];
  };

  // Pick arm: two tapering prisms, the outer one raked further forward than the
  // inner. A pick is a curve, and the curve is the whole silhouette from the
  // side -- which, given the rest pose yaws the tool, is the view you get.
  let p = limb([-0.030, 0], 0.20, 0.044, 0.028, 0.16);
  p = limb([p[0] + 0.012, p[1] + 0.002], 0.19, 0.028, 0.008, 0.52);
  // Worn point: bright steel, because the tip is the one part of a pick that
  // gets polished by use rather than left dark.
  limb([p[0] + 0.010, p[1] + 0.006], 0.055, 0.012, 0.001, 0.52, 0xdfe6ee);

  // Adze on the back: a chisel, tapering from a thick root to an edge that is
  // wide across the swing and almost nothing along it. This is what stops the
  // head reading as a hammer -- a pickaxe is asymmetric, and the asymmetry is
  // the whole reason you can tell which way it is pointing mid-swing.
  //
  // Boxes here rather than prisms: a chisel is not a spike, it is a slab that
  // widens one way while thinning the other, and only a box can do both at once.
  head.add(part(0.070, 0.096, 0.098, STEEL, 0, 0.066, 0));
  head.add(part(0.098, 0.082, 0.060, STEEL, 0, 0.132, 0.003));
  // The bevelled edge, cranked over so it catches the key light broadside.
  // Wider across than the eye and thinner along the haft than anything else on
  // the head: that contrast is the entire read, and it survives being small.
  const edge = part(0.124, 0.038, 0.028, 0xdfe6ee, 0, 0.184, 0.008);
  edge.rotation.x = 0.22;
  head.add(edge);

  return g;
}

function buildKnife() {
  const g = new THREE.Group();
  g.add(part(0.05, 0.06, 0.17, DARK, 0, -0.05, 0.03));       // grip
  g.add(part(0.11, 0.025, 0.03, GUNMETAL, 0, 0.005, -0.06)); // guard
  // Blade, with a bevel block along one edge so it catches the light.
  g.add(part(0.035, 0.075, 0.34, STEEL, 0, 0.02, -0.25));
  g.add(part(0.012, 0.03, 0.30, 0xdfe6ee, 0.016, 0.045, -0.24));
  g.add(part(0.03, 0.05, 0.06, STEEL, 0, 0.02, -0.44));      // point
  return g;
}

function buildGolfClub() {
  const g = new THREE.Group();
  const shaft = part(0.032, 0.032, 0.86, STEEL, 0, 0.02, -0.3);
  shaft.rotation.x = -0.16;
  g.add(shaft);
  g.add(part(0.05, 0.05, 0.2, DARK, 0, -0.06, 0.08));        // rubber grip
  // Wedge head, angled like a real face so it reads as a club and not a hammer.
  const head = part(0.24, 0.1, 0.11, 0xdfe6ee, 0.06, 0.16, -0.7);
  head.rotation.z = 0.2;
  head.rotation.y = -0.3;
  g.add(head);
  g.add(part(0.07, 0.05, 0.09, STEEL, -0.02, 0.13, -0.68));  // hosel
  return g;
}

// -------------------------------------------------------------------- sidearms

function buildDeagle() {
  const g = new THREE.Group();
  g.add(part(0.085, 0.095, 0.38, GOLD, 0, 0, -0.11));        // slab slide
  g.add(part(0.055, 0.05, 0.14, DARK, 0, -0.06, -0.26));     // underbarrel
  g.add(part(0.07, 0.17, 0.08, DARK, 0, -0.115, 0.05));      // grip
  g.add(part(0.055, 0.11, 0.055, GUNMETAL, 0, -0.11, 0.05)); // magazine
  // Slide cuts, which is what makes a hand cannon read as a hand cannon.
  for (const z of [-0.02, -0.08, -0.14]) {
    g.add(part(0.09, 0.02, 0.022, 0xb8912f, 0, 0.05, z));
  }
  // Red-dot: a short tube with a genuine window and a floating dot inside.
  opticFrame(g, 0.105, -0.09, 0.032, 0.032, DARK, 0.012, 0.09);
  reticleDot(g, RED, 0.105, -0.125, 0.0065);
  g.add(part(0.03, 0.035, 0.03, DARK, 0, 0.062, -0.09));     // mount
  sightLine(g, 0.105, -0.28);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -0.32);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

// ------------------------------------------------------------------------ smgs

function buildSmg() {
  const g = new THREE.Group();
  g.add(part(0.08, 0.1, 0.42, DARK, 0, 0, -0.1));            // receiver
  g.add(part(0.042, 0.042, 0.2, GUNMETAL, 0, 0.01, -0.4));   // stubby barrel
  g.add(part(0.05, 0.05, 0.12, DARK, 0, -0.03, -0.3));       // handguard
  g.add(part(0.065, 0.14, 0.075, DARK, 0, -0.1, 0.02));      // grip
  g.add(part(0.05, 0.2, 0.075, ACCENT, 0, -0.13, -0.1));     // long mag
  g.add(part(0.055, 0.075, 0.16, DARK, 0, -0.01, 0.2));      // folded stock
  g.add(part(0.07, 0.018, 0.24, DARK, 0, 0.058, -0.14));     // top rail
  // Holographic sight: a wide, short window -- the shape is what tells the
  // player at a glance that this is not an iron-sighted gun.
  opticFrame(g, 0.115, -0.16, 0.055, 0.038, 0x2b3036, 0.012, 0.085);
  g.add(glow(0.09, 0.058, 0.006, 0x6fe08a, 0, 0.115, -0.2, 0.14));  // glass tint
  reticleRing(g, 0x6fe08a, 0.115, -0.118, 0.024, 0.0016, 0.82);
  reticleDot(g, 0x6fe08a, 0.115, -0.118, 0.0048);
  g.add(part(0.04, 0.03, 0.06, DARK, 0, 0.078, -0.16));      // mount
  sightLine(g, 0.115, -0.26);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, -0.52);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

function buildMicroSmg() {
  const g = new THREE.Group();
  g.add(part(0.07, 0.095, 0.3, DARK, 0, 0, -0.06));          // tiny receiver
  g.add(part(0.034, 0.034, 0.13, GUNMETAL, 0, 0.01, -0.27));
  g.add(part(0.06, 0.13, 0.07, DARK, 0, -0.1, 0.03));        // grip
  g.add(part(0.045, 0.22, 0.06, ACCENT, 0, -0.14, -0.04));   // stick mag
  g.add(part(0.05, 0.02, 0.02, DARK, 0, 0.055, -0.02));      // vestigial irons
  g.add(part(0.016, 0.028, 0.016, ACCENT, 0, 0.06, -0.26));
  rearNotch(g, 0.070, 0.040, { gap: 0.046, blade: 0.010, h: 0.035 });
  // Laser module slung under the barrel, with the emitter lit. It reinforces
  // the sight picture without painting a fake dot over the world.
  g.add(part(0.05, 0.042, 0.11, 0x2b3036, 0, -0.055, -0.25));
  g.add(glow(0.022, 0.022, 0.012, RED, 0, -0.055, -0.31, 0.95));
  sightLine(g, 0.070, -0.30);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, -0.35);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

// -------------------------------------------------------------- energy weapons

function buildLaser() {
  const g = new THREE.Group();
  g.add(part(0.09, 0.1, 0.5, 0x39424e, 0, 0, -0.14));        // chassis
  // Emitter: a stack of rings that get brighter toward the aperture.
  g.add(part(0.055, 0.055, 0.3, STEEL, 0, 0.01, -0.5));
  for (let i = 0; i < 3; i++) {
    g.add(glow(0.075, 0.075, 0.022, ENERGY, 0, 0.01, -0.42 - i * 0.09, 0.5 + i * 0.18));
  }
  g.add(glow(0.05, 0.05, 0.02, 0xdff8ff, 0, 0.01, -0.66, 0.95));  // aperture
  // Cell, glowing through a cutaway -- the ammo counter you can see.
  g.add(part(0.06, 0.15, 0.1, 0x2b3036, 0, -0.11, -0.06));
  g.add(glow(0.03, 0.11, 0.11, ENERGY, 0, -0.11, -0.06, 0.55));
  g.add(part(0.065, 0.14, 0.075, DARK, 0, -0.1, 0.06));      // grip
  g.add(part(0.075, 0.085, 0.17, 0x39424e, 0, -0.02, 0.22));  // stock
  // Cooling fins along the top, ending at the optic.
  for (let i = 0; i < 4; i++) g.add(part(0.1, 0.02, 0.02, STEEL, 0, 0.062, -0.3 - i * 0.05));
  // Energy holo: an angular open sight with a cyan-lit window.
  opticFrame(g, 0.115, -0.1, 0.05, 0.042, 0x2b3036, 0.012, 0.085);
  g.add(glow(0.084, 0.066, 0.006, ENERGY, 0, 0.115, -0.14, 0.16));
  reticleRing(g, ENERGY, 0.115, -0.060, 0.026, 0.0016, 0.82);
  reticleCross(g, ENERGY, 0.115, -0.060, 0.060, 0.014, 0.0018, 0.76);
  reticleDot(g, ENERGY, 0.115, -0.060, 0.0045);
  g.add(part(0.038, 0.028, 0.06, DARK, 0, 0.08, -0.1));
  sightLine(g, 0.115, -0.26);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, -0.7);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

/** Paired-aperture projector: Aperture Science Handheld Portal Device. */
function buildPortalGun() {
  const g = new THREE.Group();
  g.name = 'weapon:portalgun';
  g.userData.variant = 'paired-aperture';

  const SHELL = 0xf2f6fa;       // Ceramic composite white cowl
  const CORE = 0x181c22;        // Anodized dark metal structural frame
  const ACCENT_DARK = 0x2b323c; // Secondary polymer casing
  const BLUE = 0x28a9ff;
  const ORANGE = 0xff8b24;

  const add = (name, mesh) => {
    mesh.name = name;
    g.add(mesh);
    return mesh;
  };

  const rodBetween = (name, start, end, radius, color) => {
    const a = new THREE.Vector3(...start);
    const b = new THREE.Vector3(...end);
    const direction = b.clone().sub(a);
    const r = tube(radius, radius, direction.length(), color,
      (a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5,
      { segments: 8 });
    r.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize());
    return add(name, r);
  };

  // --- Rear Cowl & Power Housing ----------------------------------------
  // Sleek curved white composite shell encasing the rear reactor base.
  const rearShell = add('rear-shell', new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 24), mat(SHELL)));
  rearShell.scale.set(0.115, 0.105, 0.19);
  rearShell.position.set(0, 0.02, 0.045);
  rearShell.material = finishMat(SHELL, 'cerakote', 0.28, 0.12);

  const rearCap = add('rear-cap', tube(0.043, 0.043, 0.014, CORE, 0, 0.02, 0.235, { segments: 32 }));
  rearCap.material = finishMat(CORE, 'brushed', 0.42, 0.65);

  // Top carry handle bar
  add('carry-handle-top', part(0.028, 0.016, 0.22, CORE, 0, 0.142, -0.02, { bevel: 0.2 }));
  add('carry-handle-post-f', part(0.024, 0.045, 0.022, CORE, 0, 0.118, -0.11));
  add('carry-handle-post-r', part(0.024, 0.045, 0.022, CORE, 0, 0.118, 0.08));

  // --- Pistol Grip & Trigger Assembly -----------------------------------
  const grip = add('grip-main', part(0.055, 0.20, 0.085, 0x1e2228, 0, -0.135, 0.03,
    { bevel: 0.35 }));
  grip.geometry.dispose();
  grip.geometry = new THREE.BoxGeometry(.055,.20,.085);
  grip.rotation.x = -0.22;
  grip.material = finishMat(0x1a1a1d, 'rubber', 0.85, 0.05);

  add('trigger-guard', part(0.018, 0.09, 0.11, CORE, 0, -0.095, -0.06, { bevel: 0.2 }));
  add('trigger', part(0.012, 0.042, 0.018, GUNMETAL, 0, -0.075, -0.045));

  // --- Central Containment Chamber & Singularity Core -------------------
  // Dark structural receiver rings bounding the transparent reactor tube.
  add('core-base-collar', tube(0.088, 0.088, 0.04, CORE, 0, 0.018, -0.11, { segments: 16 }));
  add('core-front-collar', tube(0.085, 0.085, 0.04, CORE, 0, 0.018, -0.42, { segments: 16 }));

  // Transparent quartz containment cylinder.
  const glassTube = add('containment-tube', tube(0.078, 0.078, 0.27, 0xd0e8ff, 0, 0.018, -0.265, {
    segments: 20, open: true,
  }));
  glassTube.material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.32,
    roughness: 0.06,
    metalness: 0.15,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // Miniature singularity core inside the tube (pulsing dynamic energy node).
  const coreGlow = add('singularity-core', new THREE.Mesh(new THREE.SphereGeometry(.035,24,16),
    new THREE.MeshStandardMaterial({color:BLUE,emissive:BLUE,emissiveIntensity:2,roughness:.16,metalness:.15})));
  coreGlow.position.set(0,.018,-.265);
  g.userData.coreGlow = coreGlow;

  // Luminous induction accelerator rings along the glass chamber.
  for (let i = 0; i < 3; i++) {
    const ringZ = -0.34 + i * 0.075;
    add(`induction-ring-${i}`, tube(0.082, 0.082, 0.016, 0xc87b38, 0, 0.018, ringZ,
      { segments: 24, open: true, roughness: 0.3, metalness: 0.7 }));
  }

  // Dual indicator lights on top of the rear shell (blue and orange status).
  const indBlue = add('indicator-blue', glow(0.018, 0.012, 0.028, BLUE, -0.038, 0.112, -0.02, 0.98));
  const indOrange = add('indicator-orange', glow(0.018, 0.012, 0.028, ORANGE, 0.038, 0.112, -0.02, 0.98));
  g.userData.indBlue = indBlue;
  g.userData.indOrange = indOrange;

  // Dual plasma conduit tubes running along the sides.
  rodBetween('plasma-conduit-left', [-0.072, 0.04, -0.08], [-0.068, 0.04, -0.44], 0.009, BLUE);
  rodBetween('plasma-conduit-right', [0.072, 0.04, -0.08], [0.068, 0.04, -0.44], 0.009, ORANGE);

  // --- Front Cowling & Barrel Assembly ---------------------------------
  // Sleek white upper hood extending over the front of the device.
  const frontCowl = add('front-cowl-upper', tube(0.074, 0.068, 0.22, SHELL, 0, 0.038, -0.52,
    { segments: 16 }));
  frontCowl.material = finishMat(SHELL, 'cerakote', 0.28, 0.12);
  frontCowl.rotation.x = -0.08;

  // Lower support chassis.
  add('front-cowl-lower', part(0.085, 0.035, 0.20, ACCENT_DARK, 0, -0.032, -0.52, { bevel: 0.25 }));

  // Central emitter barrel bore.
  add('barrel-core', tube(0.054, 0.054, 0.18, CORE, 0, 0.018, -0.54, { segments: 18 }));
  add('barrel-muzzle-ring', tube(0.058, 0.058, 0.025, GUNMETAL, 0, 0.018, -0.635,
    { segments: 20, open: true }));

  // --- Articulated Emitter Claws ----------------------------------------
  // Iconic 3-prong tripod claw arrangement (top, bottom-left, bottom-right).
  const clawAngles = [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3];
  const claws = [];

  clawAngles.forEach((angle, idx) => {
    const clawGroup = new THREE.Group();
    clawGroup.name = `emitter-claw-${idx}`;

    const radius = 0.075;
    const cx = Math.sin(angle) * radius;
    const cy = Math.cos(angle) * radius + 0.018;
    const cz = -0.55;
    clawGroup.position.set(cx, cy, cz);

    // Mount bracket hinge.
    clawGroup.add(part(0.024, 0.024, 0.04, CORE, 0, 0, 0, { bevel: 0.2 }));

    // Forward arm reaching toward the aperture.
    const arm = part(0.018, 0.020, 0.18, CORE, 0, 0, -0.09, { bevel: 0.3 });
    arm.material = finishMat(CORE, 'brushed', 0.38, 0.7);
    clawGroup.add(arm);

    // Inward-curved claw tip.
    const tip = part(0.014, 0.028, 0.045, CORE, 0, -Math.cos(angle) * 0.014, -0.19, { bevel: 0.25 });
    tip.material = finishMat(GUNMETAL, 'brushed', 0.35, 0.7);
    clawGroup.add(tip);

    // Energy node at claw tip.
    const nodeColor = idx === 0 ? 0xffffff : (idx === 1 ? BLUE : ORANGE);
    clawGroup.add(glow(0.016, 0.016, 0.035, nodeColor, 0, -Math.cos(angle) * 0.022, -0.20, 0.95));

    g.add(clawGroup);
    claws.push(clawGroup);
  });
  g.userData.claws = claws;

  // Serviceable machinery: inset panels, fasteners, rubber grip ribs and a
  // braided cable give the housing a manufactured scale rather than a toy shell.
  for (const side of [-1,1]) {
    const panel=add(`service-panel-${side}`,part(.009,.058,.125,CORE,side*.121,.02,.042,{bevel:.16}));
    panel.material=finishMat(CORE,'brushed',.46,.65);
    for(const z of [-.004,.083])for(const y of [.002,.041]){
      const bolt=add('captive-fastener',tube(.0045,.0045,.009,0x909b9e,side*.129,y,z,{segments:12}));
      bolt.rotation.y=Math.PI/2;
    }
    for(let i=0;i<5;i++)add('receiver-vent',part(.012,.005,.053,0x12191c,
      side*.086,.084-i*.008,.105,{bevel:.1}));
  }
  for(let i=0;i<7;i++){const rib=part(.056,.003,.086,0x303437,0,.065-i*.022,0,{bevel:.2});rib.name='grip-rib';grip.add(rib);}
  const cablePath=new THREE.CatmullRomCurve3([
    new THREE.Vector3(.085,.055,.11),new THREE.Vector3(.135,.075,-.02),
    new THREE.Vector3(.13,.11,-.29),new THREE.Vector3(.071,.06,-.47),
  ]);
  const cable=add('insulated-power-cable',new THREE.Mesh(new THREE.TubeGeometry(cablePath,40,.008,8,false),
    finishMat(0x20262a,'rubber',.75,.03)));
  for(const z of [-.112,-.418]){
    const seal=add('chamber-seal',new THREE.Mesh(new THREE.TorusGeometry(.085,.006,8,40),
      finishMat(0x7c878b,'brushed',.3,.85)));
    seal.position.set(0,.018,z);
  }
  const rearInset=add('rear-socket-inset',tube(.034,.034,.004,0x4c575b,0,.02,.246,{segments:24}));
  for(let i=0;i<4;i++)add('rear-socket-groove',part(.047,.003,.004,0x12191c,0,.007+i*.009,.25));
  for(const [idx,claw] of claws.entries()){
    const angle=clawAngles[idx];
    rodBetween(`claw-actuator-${idx}`,
      [Math.sin(angle)*.071,Math.cos(angle)*.071+.018,-.48],
      [Math.sin(angle)*.088,Math.cos(angle)*.088+.018,-.66],.006,0x9ca8ae);
    claw.rotation.z=-angle;
  }
  if(typeof document!=='undefined'){
    const label=document.createElement('canvas');label.width=512;label.height=128;
    const ctx=label.getContext('2d');ctx.fillStyle='#d5d8d4';ctx.fillRect(0,0,512,128);
    ctx.fillStyle='#283338';ctx.font='bold 36px monospace';ctx.fillText('APERTURE  /  07',20,48);
    ctx.font='20px monospace';ctx.fillText('PAIRED FIELD PROJECTOR',20,82);
    ctx.fillStyle='#ba772b';ctx.fillRect(20,105,472,6);
    const texture=new THREE.CanvasTexture(label);texture.colorSpace=THREE.SRGBColorSpace;
    const decal=add('serial-plate',new THREE.Mesh(new THREE.PlaneGeometry(.075,.019),
      new THREE.MeshStandardMaterial({map:texture,roughness:.6,metalness:.15})));
    decal.position.set(.045,.086,.098);decal.rotation.x=-.7;
  }

  // --- Muzzle & Sights --------------------------------------------------
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.018, -0.74);
  g.add(muzzle);
  g.userData.muzzle = muzzle;

  sightLine(g, 0.135, -0.28);
  return g;
}

/**
 * Flamethrower: a pair of fuel tanks, a pump, and a lit pilot.
 *
 * The pilot flame is the whole read. Every other weapon in the rack is inert
 * until it fires, so a nozzle with a live flame already burning at the tip is
 * the one silhouette you can identify from across a room -- and it tells you
 * the thing is on without a HUD line saying so.
 */
function buildFlamethrower() {
  const g = new THREE.Group();
  const TANK = 0x8a4a2c;
  const FLAME = 0xff7a1e;

  // Twin tanks, slung under and behind, with a bridging pipe between them.
  for (const side of [-1, 1]) {
    g.add(part(0.11, 0.11, 0.34, TANK, side * 0.075, -0.12, 0.22));
    g.add(part(0.05, 0.05, 0.06, STEEL, side * 0.075, -0.12, 0.03));
  }
  g.add(part(0.19, 0.04, 0.05, STEEL, 0, -0.12, 0.38));       // yoke
  g.add(part(0.03, 0.03, 0.3, GUNMETAL, 0, -0.06, 0.06));     // fuel line

  g.add(part(0.1, 0.12, 0.4, 0x4a5058, 0, -0.01, -0.06));     // pump body
  g.add(part(0.06, 0.14, 0.08, DARK, 0, -0.13, 0.08));        // grip
  g.add(part(0.05, 0.05, 0.16, DARK, 0, -0.1, -0.16));        // fore grip

  // Barrel: a plain tube, tapering to a ring of jets.
  g.add(part(0.062, 0.062, 0.44, GUNMETAL, 0, 0.01, -0.42));
  g.add(part(0.085, 0.085, 0.045, STEEL, 0, 0.01, -0.62));    // muzzle collar
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    g.add(part(0.018, 0.018, 0.05, ACCENT,
      Math.cos(a) * 0.05, 0.01 + Math.sin(a) * 0.05, -0.63));
  }

  // The pilot: a small always-lit flame just off the jets.
  g.add(glow(0.03, 0.05, 0.03, FLAME, 0.055, 0.05, -0.6, 0.9));
  g.add(glow(0.018, 0.03, 0.018, 0xffe08a, 0.055, 0.072, -0.6, 0.95));

  g.add(part(0.05, 0.02, 0.09, DARK, 0, 0.07, 0.06));         // rear sight block
  sightLine(g, 0.085, -0.3);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, -0.68);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

function buildRailgun() {
  const g = new THREE.Group();
  g.add(part(0.085, 0.11, 0.56, 0x39424e, 0, 0, -0.18));     // chassis
  // Twin rails with the accelerator gap between them -- the silhouette is the
  // whole read on this gun, so the rails run its entire length.
  for (const sx of [-0.055, 0.055]) {
    g.add(part(0.028, 0.05, 0.8, STEEL, sx, 0.035, -0.62));
    g.add(glow(0.014, 0.02, 0.78, RAIL, sx, 0.035, -0.62, 0.5));
  }
  // Coils stepping up the rails.
  for (let i = 0; i < 4; i++) {
    g.add(part(0.15, 0.075, 0.045, 0x2b3036, 0, 0.035, -0.36 - i * 0.17));
    g.add(glow(0.16, 0.026, 0.026, RAIL, 0, 0.035, -0.36 - i * 0.17, 0.55));
  }
  g.add(part(0.07, 0.15, 0.08, DARK, 0, -0.11, -0.02));      // grip
  g.add(part(0.085, 0.1, 0.22, 0x39424e, 0, -0.03, 0.2));    // stock
  g.add(part(0.06, 0.12, 0.09, 0x2b3036, 0, -0.1, -0.24));   // capacitor
  g.add(glow(0.03, 0.08, 0.1, RAIL, 0, -0.1, -0.24, 0.5));
  // Thermal scope: a big boxy housing with a real clear window. The HUD draws
  // the magnified thermal view, but the model still has to be something the
  // player can look through while it comes up.
  g.add(part(0.13, 0.02, 0.3, DARK, 0, 0.092, -0.2));        // mount plate
  opticFrame(g, 0.15, -0.2, 0.055, 0.05, 0x21262c, 0.014, 0.3);
  const pane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.098, 0.086),
    glass(0x9ad9a0, 0.16),
  );
  pane.position.set(0, 0.15, -0.34);
  g.add(pane);
  reticleCross(g, 0xb8ffb0, 0.15, -0.335, 0.064, 0.018, 0.0017, 0.68);
  reticleDot(g, 0xb8ffb0, 0.15, -0.335, 0.0048, 0.9);
  sightLine(g, 0.15, -0.22);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.035, -1.0);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

function buildMinigun() {
  const g = new THREE.Group();
  g.add(part(0.19, 0.19, 0.34, 0x39424e, 0, 0, 0.02));       // housing
  // Six barrels on a ring. Stored so the model can spin them with the wind-up.
  const barrels = new THREE.Group();
  barrels.name = 'barrels';
  barrels.position.set(0, 0.01, -0.36);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    barrels.add(part(0.045, 0.045, 0.66, GUNMETAL,
      Math.cos(a) * 0.062, Math.sin(a) * 0.062, 0));
  }
  barrels.add(part(0.15, 0.15, 0.05, DARK, 0, 0, -0.3));     // muzzle plate
  g.add(barrels);
  g.userData.barrels = barrels;
  g.add(part(0.075, 0.16, 0.09, DARK, 0, -0.14, 0.1));       // grip
  g.add(part(0.06, 0.06, 0.2, DARK, -0.13, -0.09, -0.1));    // fore grip
  // Ammo drum on the right, because the belt has to come from somewhere.
  g.add(part(0.16, 0.2, 0.2, 0x2b3036, 0.17, -0.06, 0.12));
  g.add(part(0.1, 0.05, 0.05, ACCENT, 0.09, -0.02, 0.06));   // belt feed
  g.add(part(0.022, 0.04, 0.022, ACCENT, 0, 0.115, -0.14));  // blade sight
  g.add(part(0.05, 0.02, 0.09, DARK, 0, 0.1, 0.06));
  sightLine(g, 0.118, -0.3);
  // A minigun is hip-braced, not shouldered behind its barrel cluster. Pulling
  // that cluster onto the centreline like a rifle surrounds the target with
  // housing even when the exact centre ray happens to remain open. Keep it low
  // and right during ADS: the player still sees the weapon and wind-up, while
  // the central target area stays completely unobstructed.
  g.userData.adsPoseOverride = { x: 0.10, y: -0.14, z: -0.38 };
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, -0.72);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  return g;
}

// Exported so the armoury can build its own copy of a weapon to photograph
// without borrowing the one the player is holding.
export const BUILDERS = {
  pickaxe: buildPickaxe, knife: buildKnife, golfclub: buildGolfClub,
  pistol: buildPistol, deagle: buildDeagle,
  smg: buildSmg, microsmg: buildMicroSmg,
  rifle: buildRifle, laser: buildLaser, minigun: buildMinigun,
  portalgun: buildPortalGun,
  shotgun: buildShotgun, sniper: buildSniper, railgun: buildRailgun,
  bazooka: buildBazooka, flamethrower: buildFlamethrower,
};

// Models are authored at roughly life size, then shrunk and pushed away from
// the near plane. Drawing them at 1:1 right in front of the camera makes the
// gun swallow a third of the screen.
export const MODEL_SCALE = 0.66;

/**
 * These HUD sights replace the physical optic at full ADS. A downloaded scope
 * is not guaranteed to have a genuinely open eyepiece (many are capped or have
 * opaque lens geometry), so leaving its body at screen centre can blank the
 * very target the overlay is meant to show. Iron and projected sights still
 * use the weapon model itself.
 */
export const ADS_MASKS_MODEL = new Set(['scope', 'thermal', 'bazooka']);

// Resting pose per weapon: bigger guns sit lower and further right.
export const REST = {
  pistol:  { x: 0.21, y: -0.17, z: -0.52, rx: 0.02, ry: 0.05 },
  deagle:  { x: 0.22, y: -0.18, z: -0.52, rx: 0.02, ry: 0.05 },
  smg:     { x: 0.23, y: -0.18, z: -0.52, rx: 0.02, ry: 0.06 },
  microsmg:{ x: 0.22, y: -0.17, z: -0.48, rx: 0.02, ry: 0.06 },
  rifle:   { x: 0.24, y: -0.19, z: -0.55, rx: 0.02, ry: 0.06 },
  laser:   { x: 0.24, y: -0.19, z: -0.56, rx: 0.02, ry: 0.06 },
  portalgun:{ x: 0.24, y: -0.19, z: -0.72, rx: 0.02, ry: 0.16 },
  shotgun: { x: 0.26, y: -0.20, z: -0.52, rx: 0.03, ry: 0.07 },
  sniper:  { x: 0.24, y: -0.19, z: -0.58, rx: 0.02, ry: 0.06 },
  railgun: { x: 0.25, y: -0.20, z: -0.60, rx: 0.02, ry: 0.06 },
  // Shouldered, so it sits higher and closer to centre than the small arms.
  bazooka: { x: 0.20, y: -0.13, z: -0.60, rx: 0.02, ry: 0.04 },
  // Hip-braced and huge; sits low and wide because it is a two-hand haul.
  minigun: { x: 0.27, y: -0.26, z: -0.58, rx: 0.03, ry: 0.05 },
  // Melee sits further into frame and canted, so a swing has room to read.
  pickaxe: { x: 0.28, y: -0.24, z: -0.50, rx: 0.06, ry: -0.30 },
  knife:   { x: 0.24, y: -0.20, z: -0.42, rx: 0.05, ry: -0.22 },
  golfclub:{ x: 0.30, y: -0.30, z: -0.52, rx: 0.05, ry: -0.34 },
};

// Where the weapon sits when aimed. Derived from the model's own sight anchor:
// cancelling the anchor offset (in world units, hence the scale) puts the sight
// line dead on the screen centre for every weapon.
export function weaponAdsPose(model) {
  if (model.userData.adsPoseOverride) return { ...model.userData.adsPoseOverride };
  const s = model.userData.sight;
  if (!s) return { x: 0, y: -0.038, z: -0.20 };

  // Resolved through the model's own frame rather than read straight off the
  // anchor. A built gun parents its sight directly to the group, so the two are
  // the same thing -- but a loaded model nests it under a holder that carries
  // the fitted scale and rotation, and reading `.position` there would cancel
  // an offset measured in the wrong units. Scaling by the model's actual scale
  // rather than the MODEL_SCALE constant closes the same gap: a loaded gun
  // carries the fit factor as well.
  model.updateMatrixWorld(true);
  const p = model.worldToLocal(s.getWorldPosition(new THREE.Vector3()));
  return {
    x: -p.x * model.scale.x,
    y: -p.y * model.scale.y,
    z: model.userData.adsZ ?? -0.24,
  };
}

/** True when the physical model belongs in the final ADS frame. */
export function weaponModelVisibleInAds(sight, ads) {
  return !ADS_MASKS_MODEL.has(sight) || ads < 0.92;
}

/**
 * Put an unanimated weapon at the exact pose used at full ADS.
 *
 * QA pages and unit tests call this instead of maintaining a second copy of
 * the pose arithmetic. Production resolves and caches the same pose in
 * `_buildModels` / `replaceModel`.
 */
export function poseWeaponForAds(model, sight = 'iron', ads = 1) {
  model.userData.ads ??= weaponAdsPose(model);
  const p = model.userData.ads;
  model.position.set(p.x, p.y, p.z);
  model.rotation.set(0, 0, 0);
  model.visible = weaponModelVisibleInAds(sight, ads);
  model.updateMatrixWorld(true);
  return model;
}

function hitMaterial(hit) {
  const material = hit.object?.material;
  if (!Array.isArray(material)) return material;
  return material[hit.face?.materialIndex ?? 0];
}

function blocksSight(hit) {
  const material = hitMaterial(hit);
  return material
    && material.visible !== false
    && material.colorWrite !== false
    && (material.opacity ?? 1) >= 0.35
    && !material.userData?.adsNonBlocking;
}

/**
 * Sample the central sight window from the actual aiming camera.
 *
 * `coverage` is the fraction of rays in a small square around the aim point
 * that hit opaque weapon geometry. A narrow front post may occupy a few rays;
 * a capped scope or a gun rotated across the camera occupies most of them.
 * Masked scope/thermal/RPG views return zero because the physical model is not
 * rendered in that final frame.
 */
export function auditAdsClearance(model, camera, { grid = 9, radiusNdc = 0.12 } = {}) {
  if (!model?.visible) {
    return { samples: grid * grid, blockedRays: 0, coverage: 0, centerBlocked: false };
  }

  model.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  let blockedRays = 0;
  let centerBlocked = false;
  const middle = Math.floor(grid / 2);
  for (let iy = 0; iy < grid; iy++) {
    for (let ix = 0; ix < grid; ix++) {
      const x = grid === 1 ? 0 : ((ix / (grid - 1)) * 2 - 1) * radiusNdc;
      const y = grid === 1 ? 0 : ((iy / (grid - 1)) * 2 - 1) * radiusNdc;
      ray.setFromCamera(new THREE.Vector2(x, y), camera);
      const blocked = ray.intersectObject(model, true).some(blocksSight);
      if (blocked) blockedRays++;
      if (ix === middle && iy === middle) centerBlocked = blocked;
    }
  }
  const samples = grid * grid;
  return { samples, blockedRays, coverage: blockedRays / samples, centerBlocked };
}

export class ViewModel {
  constructor() {
    this.scene = new THREE.Scene();
    // A narrower FOV than the world camera keeps the gun from fisheye-ing.
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 20);

    /**
     * Called after every model rebuild, for whoever owns the cosmetics.
     *
     * A hook rather than an import, because the viewmodel has no business
     * knowing what a skin is, who owns one, or which of several cosmetic
     * systems is currently on top. It knows only that it has just thrown the
     * painted models away and built plain ones.
     */
    this.onRefinish = null;

    // Dedicated lighting so the gun reads the same regardless of world time.
    this.scene.add(new THREE.AmbientLight(0xffffff, VIEWMODEL_LIGHTING.ambient));
    const key = new THREE.DirectionalLight(0xffffff, VIEWMODEL_LIGHTING.key);
    key.position.set(-0.4, 1, 0.6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, VIEWMODEL_LIGHTING.rim);
    rim.position.set(0.8, -0.2, -1);
    this.scene.add(rim);

    this.models = {};
    // Slots in this set must never reveal their generated model. It persists
    // through finish/camo rebuilds, which otherwise recreate every fallback.
    this.requiredExternalModels = new Set();
    this._buildModels();

    // Muzzle flash: a cross of two emissive planes plus a light.
    this.flash = new THREE.Group();
    const fmat = new THREE.MeshBasicMaterial({
      color: 0xffd98a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    });
    this.flashMat = fmat;
    for (let i = 0; i < 2; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), fmat);
      p.rotation.z = i * Math.PI / 2;
      this.flash.add(p);
    }
    this.flashLight = new THREE.PointLight(0xffcc77, 0, 2.5);
    this.flash.add(this.flashLight);
    this.scene.add(this.flash);
    this.flashTime = 0;
    this.flashTotal = 0.055;

    // A held flamethrower has a continuous first-person nozzle plume. World
    // particles carry the jet to its target; these nested additive cones keep
    // ignition visually welded to either the built or downloaded muzzle even
    // while the weapon bobs, recoils, and switches.
    this.flamePlume = new THREE.Group();
    this.flamePlume.name = 'held-flamethrower-plume';
    this.flamePlumeMeshes = [];
    const plumeLayers = [
      { length: 0.88, radius: 0.17, color: 0xff4b0d, opacity: 0.22 },
      { length: 0.67, radius: 0.115, color: 0xff9a22, opacity: 0.42 },
      { length: 0.42, radius: 0.058, color: 0xfff0a0, opacity: 0.82 },
    ];
    for (const layer of plumeLayers) {
      const material = new THREE.MeshBasicMaterial({
        color: layer.color, transparent: true, opacity: layer.opacity,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const mesh = new THREE.Mesh(
        new THREE.ConeGeometry(layer.radius, layer.length, 9, 2, true), material);
      // ConeGeometry runs on Y. +PI/2 puts its narrow tip at the nozzle and its
      // wider base down -Z, which is the viewmodel's authored muzzle direction.
      mesh.rotation.x = Math.PI / 2;
      mesh.position.z = -layer.length * 0.5;
      mesh.userData.baseOpacity = layer.opacity;
      mesh.userData.phase = this.flamePlumeMeshes.length * 2.1;
      this.flamePlume.add(mesh);
      this.flamePlumeMeshes.push(mesh);
    }
    this.flameLight = new THREE.PointLight(0xff7a24, 0, 3.2);
    this.flameLight.position.z = -0.24;
    this.flamePlume.add(this.flameLight);
    this.flamePlume.visible = false;
    this.scene.add(this.flamePlume);
    this.flameTime = 0;

    this.currentId = null;
    this.sway = { x: 0, y: 0 };
    this.bobT = 0;
    this.lower = 0;      // 0 = raised, 1 = fully lowered (switching)
    this.reloadT = 0;
    this.pumpT = 0;
    this.sniperCycleT = 0;
    this.sniperCycleTotal = 1.05;
    this.recoilPos = 0;
    this.recoilRot = 0;
    this.swingT = 0;      // melee swing, counts down from swingTotal
    this.swingTotal = 0.3;
    this.spinAngle = 0;   // minigun barrel rotation
  }

  /**
   * Start a melee swing.
   * @param duration matched to the weapon's cadence so a fast knife does not
   *   play a slow arc, and the animation never outlasts the next swing
   */
  triggerSwing(duration = 0.3) {
    this.swingTotal = Math.max(0.08, duration);
    this.swingT = this.swingTotal;
  }

  /** Start the Intervention's manual bolt cycle after its shot breaks. */
  triggerBoltCycle(duration = 1.05) {
    this.sniperCycleTotal = Math.max(0.65, duration);
    this.sniperCycleT = this.sniperCycleTotal;
  }

  _buildModels() {
    for (const [id, fn] of Object.entries(BUILDERS)) {
      const m = fn();
      m.scale.setScalar(MODEL_SCALE);
      m.visible = false;
      if (this.requiredExternalModels.has(id)) m.userData.replacementPending = true;
      // Resolved once at build time -- the sights never move relative to the
      // model, so there is nothing to recompute per frame.
      m.userData.ads = weaponAdsPose(m);
      this.scene.add(m);
      this.models[id] = m;
    }

    // Anything painted ON TOP of the base palette has to go back on now.
    //
    // A model rebuild is the one operation that silently undoes a skin: the
    // group holding the repainted materials is thrown away and replaced with a
    // freshly built one wearing the factory colours. That is why a skin bought
    // with credits vanished the moment a finish was changed -- the player owned
    // it, the profile said it was equipped, and the gun in their hands was
    // plain. Whoever owns the cosmetics decides what goes back on; this only
    // guarantees they are asked, every single time the models are rebuilt.
    this.onRefinish?.(this);
  }

  /**
   * Swap one weapon's model for another, keeping the pose contract intact.
   *
   * Used by weaponmodels.js to put a downloaded gun in the player's hands after
   * the built one is already there. The replacement has to arrive wearing
   * everything the rest of this class assumes: MODEL_SCALE applied, the ADS pose
   * resolved from its own sight anchor, hidden unless it is the weapon in hand.
   *
   * The built model is disposed here rather than kept as a fallback. Holding
   * fifteen spare guns in memory to guard against a swap that has already
   * succeeded is not a trade worth making, and a camo change rebuilds from
   * BUILDERS anyway -- which is why applyCamo re-adopts afterwards.
   */
  replaceModel(id, model) {
    const old = this.models[id];
    if (old) {
      this.scene.remove(old);
      old.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m?.dispose();
      });
    }
    model.scale.multiplyScalar(MODEL_SCALE);
    model.userData.ads = weaponAdsPose(model);
    model.visible = this.currentId === id;
    this.scene.add(model);
    this.models[id] = model;
  }

  /**
   * Repaint every weapon in a camo. Rebuilds the five models outright --
   * single-digit milliseconds, and unlike retinting in place it cannot leave
   * a part wearing the old finish.
   */
  applyCamo(camoId) {
    const camo = CAMO_BY_ID[camoId] || CAMO_BY_ID.standard;

    for (const m of Object.values(this.models)) {
      this.scene.remove(m);
      m.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        // Ad-hoc materials (glass, glow dots) are per-model; cached ones are
        // disposed wholesale by setPalette. Disposing twice is harmless.
        o.material.dispose();
      });
    }
    this.models = {};

    setPalette(camo);
    this._buildModels();

    // Re-show whatever was in hand, without replaying the raise animation.
    const cur = this.currentId;
    this.currentId = null;
    if (cur) {
      this.currentId = cur;
      this.models[cur].visible = true;
    }

    // A camo rebuilds from BUILDERS, which means it has just thrown away every
    // downloaded gun and put a box-built one back. Whoever installed them is
    // asked to do it again -- the same contract onRefinish has for skins, and
    // for the same reason: this class must not know what a cosmetic skin is.
    this.onReadopt?.(this);
  }

  /**
   * Give the viewmodel something to reflect.
   *
   * A metalness-1 receiver has no diffuse response at all -- every photon it
   * shows you is a reflection -- so in a scene with nothing to reflect it
   * renders black. PMREM needs a live renderer, which does not exist when this
   * class is constructed, so main.js hands one over during setup.
   */
  setRenderer(renderer) {
    this.scene.environment = studioEnvironment(renderer);
    this.scene.environmentIntensity = VIEWMODEL_LIGHTING.environment;
  }

  setSize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setWeapon(id) {
    if (this.currentId === id) return;
    for (const m of Object.values(this.models)) m.visible = false;
    this.currentId = id;
    if (this.models[id] && !this.models[id].userData.replacementPending) {
      this.models[id].visible = true;
    }
  }

  /** Keep one slot empty until replaceModel installs its downloaded art. */
  requireExternalModel(id) {
    this.requiredExternalModels.add(id);
    const model = this.models[id];
    if (!model || model.userData.external) return;
    model.userData.replacementPending = true;
    model.visible = false;
  }

  get model() { return this.models[this.currentId]; }

  /**
   * @param color muzzle flash tint. Energy weapons pass their beam colour, so a
   *   laser does not spit a yellow powder flash.
   */
  triggerFlash(color = 0xffd98a) {
    this.flashTotal = this.currentId === 'sniper' ? 0.085 : 0.055;
    this.flashTime = this.flashTotal;
    this.flashMat.color.setHex(color);
    this.flashLight.color.setHex(color);
    if (this.currentId === 'shotgun') this.pumpT = 0.36;
    if (this.currentId === 'sniper') this.triggerBoltCycle();
  }

  /**
   * @param look accumulated mouse delta this frame, for sway
   */
  update(dt, player, weapons, look) {
    const id = weapons.def.id;
    // During a switch, swap the model at the bottom of the lowering arc.
    const target = weapons.isSwitching && weapons.pendingIndex >= 0
      ? weapons.weapons[weapons.pendingIndex].def.id
      : id;

    const switching = weapons.isSwitching;
    const switchTotal = switching
      ? (weapons.pendingIndex >= 0 ? weapons.weapons[weapons.pendingIndex].def.switchTime : weapons.def.switchTime)
      : 0;

    if (switching) {
      // Triangle: 0 -> 1 -> 0 across the switch duration.
      const t = 1 - weapons.switchTimer / switchTotal;
      this.lower = t < 0.5 ? t * 2 : (1 - t) * 2;
      if (t >= 0.5) this.setWeapon(target);
    } else {
      this.lower += (0 - this.lower) * Math.min(1, dt * 12);
      this.setWeapon(id);
    }

    const rest = REST[this.currentId] || REST.rifle;
    const m = this.model;
    if (!m) return;
    if (m.userData.replacementPending) {
      // Installed art has not resolved yet (or genuinely failed). Never draw
      // the generated backup while waiting; gameplay may continue with empty
      // hands if a corrupt asset cannot be recovered.
      m.visible = false;
      this.flash.visible = false;
      this.flamePlume.visible = false;
      return;
    }

    // --- sway: the gun lags behind the camera ------------------------------
    const swayTargetX = Math.max(-1, Math.min(1, -look.dx * 9));
    const swayTargetY = Math.max(-1, Math.min(1, -look.dy * 9));
    this.sway.x += (swayTargetX - this.sway.x) * Math.min(1, dt * 9);
    this.sway.y += (swayTargetY - this.sway.y) * Math.min(1, dt * 9);

    // --- bob --------------------------------------------------------------
    this.bobT = player.bobPhase;
    const bobAmp = player.bobAmount * (player.sprinting ? 0.028 : 0.017);
    const bobX = Math.sin(this.bobT) * bobAmp;
    const bobY = -Math.abs(Math.cos(this.bobT)) * bobAmp * 0.9;

    // --- reload -----------------------------------------------------------
    let reloadDrop = 0, reloadRot = 0, reloadProgress = -1;
    if (weapons.isReloading) {
      const total = weapons.reloadTotal || weapons.def.reloadTime;
      const t = 1 - weapons.reloadTimer / total;
      reloadProgress = Math.max(0, Math.min(1, t));
      // Dip down, hold, come back up.
      const curve = t < 0.25 ? t / 0.25 : t > 0.8 ? (1 - t) / 0.2 : 1;
      reloadDrop = curve * 0.16;
      reloadRot = curve * 0.55;
    }

    // --- recoil -----------------------------------------------------------
    this.recoilPos += (weapons.kickBack * 0.09 - this.recoilPos) * Math.min(1, dt * 26);
    this.recoilRot += (weapons.kickBack * 0.26 - this.recoilRot) * Math.min(1, dt * 26);

    // --- Intervention bolt action ----------------------------------------
    // One deliberate gun-only mechanical beat per shot: recoil first, then the
    // bolt lifts and draws, the brass clears the action, and the next round
    // locks. No detached arm is introduced during the cycle.
    let sniperPos = { x: 0, y: 0, z: 0 };
    let sniperRot = { x: 0, y: 0, z: 0 };
    const smooth = (v) => {
      const x = Math.max(0, Math.min(1, v));
      return x * x * (3 - 2 * x);
    };
    const bolt = m.userData.bolt;
    const casing = m.userData.casing;
    const magazine = m.userData.magazine;

    if (this.currentId === 'sniper' && this.sniperCycleT > 0) {
      this.sniperCycleT = Math.max(0, this.sniperCycleT - dt);
      const t = 1 - this.sniperCycleT / this.sniperCycleTotal;
      const kick = t < 0.075
        ? Math.sin((t / 0.075) * Math.PI * 0.5)
        : t < 0.25 ? (1 - (t - 0.075) / 0.175) ** 2 : 0;
      sniperPos = { x: 0.008 * kick, y: -0.024 * kick, z: 0.14 * kick };
      sniperRot = { x: -0.18 * kick, y: 0.018 * kick, z: 0.035 * kick };

      const lift = smooth((t - 0.18) / 0.12);
      const pull = smooth((t - 0.30) / 0.17);
      const push = smooth((t - 0.58) / 0.18);
      const lock = smooth((t - 0.77) / 0.15);
      const extracted = pull * (1 - push);
      const unlocked = lift * (1 - lock);
      if (bolt) {
        bolt.position.z = bolt.userData.restZ + extracted * 0.15;
        bolt.rotation.z = -unlocked * 0.82;
      }

      if (casing) {
        const eject = (t - 0.43) / 0.29;
        if (eject >= 0 && eject <= 1) {
          const e = smooth(eject);
          casing.visible = true;
          casing.position.set(0.044 + e * 0.17,
            0.055 + Math.sin(e * Math.PI) * 0.17 + e * 0.06,
            -0.015 + e * 0.09);
          casing.rotation.set(e * 5.2, e * 3.1, Math.PI / 2 + e * 6.4);
        } else {
          casing.visible = false;
        }
      }
    } else if (this.currentId === 'sniper') {
      if (bolt) {
        bolt.position.z = bolt.userData.restZ;
        bolt.rotation.z = 0;
      }
      if (casing) casing.visible = false;
    }

    // The detachable box magazine drops cleanly during the sniper reload while
    // the broad whole-gun dip above keeps the action in frame. Reset every part
    // explicitly when the reload is interrupted.
    if (this.currentId === 'sniper' && reloadProgress >= 0) {
      const t = reloadProgress;
      const remove = smooth(t / 0.20);
      const insert = smooth((t - 0.56) / 0.25);
      const holdMag = remove * (1 - insert);
      if (magazine) {
        magazine.position.set(-0.026 * holdMag, -0.24 * holdMag, 0.055 * holdMag);
        magazine.rotation.z = 0.13 * holdMag;
      }
    } else if (this.currentId === 'sniper') {
      if (magazine) {
        magazine.position.set(0, 0, 0);
        magazine.rotation.z = 0;
      }
    }

    // --- Portal gun singularity pulse & claw recoil ----------------------
    if (this.currentId === 'portalgun') {
      m.userData.pulseTime = (m.userData.pulseTime ?? 0) + dt;
      const portals = player.portalSystem;
      for (const [kind, key] of [['blue', 'indBlue'], ['orange', 'indOrange']]) {
        if (m.userData[key]) m.userData[key].material.opacity = portals?.portals[kind] ? 1 : 0.22;
      }
      const core = m.userData.coreGlow;
      if (core) {
        const pulse = 1.0 + Math.sin(m.userData.pulseTime * 3.5) * 0.12;
        core.scale.setScalar(pulse);
        core.material.color.setHex(portals?.lastKind === 'orange' ? 0xff8b24 : 0x28a9ff);
        core.material.emissive?.copy(core.material.color);
      }
      const claws = m.userData.claws;
      if (claws) {
        const kick = this.flashTime > 0
          ? Math.sin((this.flashTime / Math.max(0.01, this.flashTotal)) * Math.PI) * 0.024
          : 0;
        for (const claw of claws) {
          claw.position.z = -0.55 + kick;
        }
      }
    }

    // --- pump action ------------------------------------------------------
    if (this.pumpT > 0) {
      this.pumpT = Math.max(0, this.pumpT - dt);
      const pump = m.userData.pump;
      if (pump) {
        const k = Math.sin((1 - this.pumpT / 0.36) * Math.PI);
        pump.position.z = -0.42 + k * 0.13;
      }
    }

    // --- minigun spin-up ---------------------------------------------------
    // Driven off the weapon system's own wind-up value, so the barrels visibly
    // reach speed at the exact moment the gun starts firing.
    const barrels = m.userData.barrels;
    if (barrels) {
      this.spinAngle += dt * (weapons.spin || 0) * 34;
      barrels.rotation.z = this.spinAngle;
    }

    // --- melee swing -------------------------------------------------------
    // A diagonal chop: wind up back and right, then sweep down across the view.
    // Applied as offsets on top of the rest pose so it composes with sway.
    let swingPos = { x: 0, y: 0, z: 0 };
    let swingRot = { x: 0, y: 0, z: 0 };
    if (this.swingT > 0) {
      this.swingT = Math.max(0, this.swingT - dt);
      const t = 1 - this.swingT / this.swingTotal;
      if (t < 0.28) {
        // Wind-up: pull back and cock the wrist.
        const k = t / 0.28;
        swingPos = { x: 0.06 * k, y: 0.05 * k, z: 0.1 * k };
        swingRot = { x: -0.5 * k, y: 0.35 * k, z: -0.3 * k };
      } else {
        // Strike: whip through and across, easing out on the follow-through.
        const k = (t - 0.28) / 0.72;
        const e = 1 - (1 - k) ** 3;
        swingPos = {
          x: 0.06 - 0.26 * e,
          y: 0.05 - 0.24 * e,
          z: 0.1 - 0.26 * e,
        };
        swingRot = {
          x: -0.5 + 1.75 * e,
          y: 0.35 - 0.8 * e,
          z: -0.3 + 1.15 * e,
        };
      }
    }

    // --- aim down sights ---------------------------------------------------
    // Blend the whole pose toward the aimed position, and damp sway and bob by
    // the same amount so an aimed shot is not fighting the idle animation.
    const adsRaw = weapons.adsT || 0;
    // The heavy rifle eases into its cheek weld instead of moving at a constant
    // rate. FOV, accuracy and input still use the authoritative raw ADS ramp.
    const ads = this.currentId === 'sniper' ? smooth(adsRaw) : adsRaw;
    const hold = 1 - ads;
    const lerp = (a, b) => a + (b - a) * ads;
    const aim = m.userData.ads;

    m.position.set(
      lerp(rest.x + this.sway.x * 0.035 + bobX, aim.x + bobX * 0.25) + swingPos.x + sniperPos.x,
      lerp(rest.y + this.sway.y * 0.03 + bobY, aim.y + bobY * 0.25) - this.lower * 0.42 - reloadDrop + swingPos.y + sniperPos.y,
      lerp(rest.z, aim.z) + this.recoilPos + swingPos.z + sniperPos.z,
    );
    m.rotation.set(
      lerp(rest.rx, 0) - (this.sway.y * 0.09) * hold - this.recoilRot - reloadRot + swingRot.x + sniperRot.x,
      lerp(rest.ry, 0) + (this.sway.x * 0.12) * hold + swingRot.y + sniperRot.y,
      this.lower * 0.5 + reloadRot * 0.4 + swingRot.z + sniperRot.z,
    );

    // Iron sights remain physical. Full-screen scope, thermal, and launcher
    // overlays replace the optic body only at the end of the raise, where an
    // imported capped lens would otherwise cover their target picture.
    m.visible = weaponModelVisibleInAds(weapons.adsSight, adsRaw);

    // --- muzzle flash -----------------------------------------------------
    if (this.flashTime > 0) {
      this.flashTime -= dt;
      const k = Math.max(0, this.flashTime / this.flashTotal);
      this.flashMat.opacity = k;
      this.flashLight.intensity = k * 5;
      const muzzle = m.userData.muzzle;
      if (muzzle) {
        muzzle.getWorldPosition(this.flash.position);
        this.flash.rotation.copy(m.rotation);
        const flashBoost = this.currentId === 'sniper' ? 1.45 : 1;
        const s = (0.7 + (1 - k) * 0.7) * flashBoost;
        this.flash.scale.setScalar(s);
      }
      this.flash.visible = true;
    } else {
      this.flashMat.opacity = 0;
      this.flashLight.intensity = 0;
      this.flash.visible = false;
    }

    // --- sustained flamethrower plume ------------------------------------
    const burning = this.currentId === 'flamethrower' && weapons.triggerHeld
      && !weapons.isBusy && !weapons.current.isEmpty;
    const flameMuzzle = burning ? m.userData.muzzle : null;
    if (flameMuzzle) {
      this.flameTime += dt;
      flameMuzzle.getWorldPosition(this.flamePlume.position);
      flameMuzzle.getWorldQuaternion(this.flamePlume.quaternion);
      for (let i = 0; i < this.flamePlumeMeshes.length; i++) {
        const layer = this.flamePlumeMeshes[i];
        const wave = Math.sin(this.flameTime * (31 + i * 6) + layer.userData.phase);
        const cross = Math.cos(this.flameTime * (23 + i * 4) + layer.userData.phase);
        layer.scale.set(1 + wave * 0.11, 0.92 + cross * 0.16, 1 - wave * 0.08);
        layer.material.opacity = layer.userData.baseOpacity * (0.86 + (wave + 1) * 0.07);
      }
      this.flameLight.intensity = 3.8 + Math.sin(this.flameTime * 37) * 0.65;
      this.flamePlume.visible = true;
    } else {
      this.flameLight.intensity = 0;
      this.flamePlume.visible = false;
    }
  }
}

/** A standalone weapon model, unposed and unparented. */
export function buildWeaponModel(id) {
  const fn = BUILDERS[id];
  return fn ? fn() : null;
}
