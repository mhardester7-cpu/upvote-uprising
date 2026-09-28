// Armoury previews: photograph a real weapon wearing each finish.
//
// The shop used to show a two-stop CSS gradient per skin, which told the player
// almost nothing -- a camo and a flat paint look identical as a gradient, and
// the whole point of buying a finish is what it does to a gun. So each card
// gets an actual render: a weapon, lit on a turntable angle, wearing one of the
// available cosmetic finishes.
//
// One renderer and one scene serve every card, with a subject built per weapon
// on demand. Renders happen once, at shop build, and are kept as data URLs --
// so this costs a few frames on first open and nothing at all afterwards.

import * as THREE from '../../vendor/three.module.js';
import { buildWeaponModel } from '../render/viewmodel.js';
import { studioEnvironment } from '../render/studioenv.js';
import { applySkin, SKIN_BY_ID, ROLE } from '../game/skins.js';
import { CAMO_BY_ID } from '../render/camos.js';

const W = 384, H = 176;

// The rifle is the most legible silhouette in the arsenal: long enough to show
// a repeating pattern, and instantly readable as a gun at card size.
const DEFAULT_SUBJECT = 'rifle';

// Three states, and the difference matters: `undefined` means never attempted,
// `null` means an attempt failed and must not be retried per card, and an
// object is a live context.
let ctx;

/**
 * Lazily stand up the offscreen renderer.
 *
 * Returns null where WebGL is unavailable -- a browser that cannot make a
 * second context should still get a working shop, just with plain cards.
 */
function ensureContext() {
  if (ctx) return ctx;
  if (ctx === null) return null;   // a previous attempt already failed

  try {
    const renderer = new THREE.WebGLRenderer({
      alpha: true, antialias: true, preserveDrawingBuffer: true,
    });
    renderer.setSize(W, H, false);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const scene = new THREE.Scene();
    // Same reason as the viewmodel: the legendary finishes are metalness 1, and
    // metal with nothing to reflect renders black.
    scene.environment = studioEnvironment(renderer);
    scene.environmentIntensity = 1.0;

    // Three-point lighting. The rim is what separates a dark skin like Carbon
    // from the transparent background behind it.
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const key = new THREE.DirectionalLight(0xfff2df, 3.0);
    key.position.set(-0.7, 1.0, 0.9);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 1.1);
    fill.position.set(1.0, 0.1, 0.5);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 2.2);
    rim.position.set(0.4, 0.5, -1.2);
    scene.add(rim);

    ctx = { renderer, scene, subjects: new Map() };
    return ctx;
  } catch {
    ctx = null;
    return null;
  }
}

/**
 * The posed, framed model for one weapon, built once.
 *
 * Each subject carries its own camera. A shared one cannot work across weapons:
 * the fit below is derived from the model's own projected bounds, and a
 * distance that frames a rifle puts a knife somewhere behind the near plane.
 */
function subject(c, weaponId) {
  const hit = c.subjects.get(weaponId);
  if (hit) return hit;

  const model = buildWeaponModel(weaponId);
  if (!model) return null;

  const camera = new THREE.PerspectiveCamera(32, W / H, 0.01, 20);
  const pivot = new THREE.Group();
  pivot.add(model);
  pivot.visible = false;
  c.scene.add(pivot);

  // Frame the model from its own bounds, so this keeps working if a weapon is
  // ever remodelled.
  const centre = new THREE.Box3().setFromObject(model).getCenter(new THREE.Vector3());
  model.position.sub(centre);

  // Three-quarter view: down the barrel is unreadable, side-on is a plank.
  pivot.rotation.set(0.22, -0.72, 0.06);
  pivot.updateMatrixWorld(true);

  // Fit the camera to what the model actually projects to once rotated,
  // rather than to its unrotated bounds -- a rifle is mostly length, and
  // fitting the raw diagonal leaves it a speck in the middle of the card.
  const rotated = new THREE.Box3().setFromObject(pivot);
  const rs = rotated.getSize(new THREE.Vector3());
  const vHalf = THREE.MathUtils.degToRad(camera.fov) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  const dist = Math.max(
    (rs.x / 2) / Math.tan(hHalf),
    (rs.y / 2) / Math.tan(vHalf),
  ) * 1.12;   // a little air so the muzzle never touches the edge

  const rc = rotated.getCenter(new THREE.Vector3());
  camera.position.set(rc.x, rc.y, rc.z + dist);
  camera.lookAt(rc);

  const made = { model, pivot, camera };
  c.subjects.set(weaponId, made);
  return made;
}

/** Dress one subject, photograph it, and hand back a PNG data URL. */
function shoot(weaponId, dress) {
  const c = ensureContext();
  if (!c) return null;

  const s = subject(c, weaponId);
  if (!s) return null;

  // Only ever one subject in shot. They are all parked at the origin, so
  // leaving a previously photographed weapon visible puts a rifle through a
  // knife.
  for (const other of c.subjects.values()) other.pivot.visible = false;
  s.pivot.visible = true;

  dress(s.model);
  c.renderer.render(c.scene, s.camera);
  return c.renderer.domElement.toDataURL('image/png');
}

/**
 * Render one skin and return a PNG data URL, or null if previews are
 * unavailable on this device.
 */
export function renderSkinPreview(skin, weaponId = DEFAULT_SUBJECT) {
  return shoot(weaponId, (model) => applySkin(model, skin));
}

/**
 * A finish, shown on a gun, with whatever skin the player owns painted over it.
 *
 * A finish is a palette rather than a texture, so there is nothing to
 * photograph on its own -- and the honest question is not "what colour is this
 * finish" but "what would I be holding". Both a finish and a skin are role
 * maps, so the two merge cleanly: the finish supplies the base for every role,
 * the skin overrides the roles it names, and the skin's pattern goes on top.
 *
 * Deliberately NOT done by swapping the viewmodel's palette and rebuilding.
 * That path disposes every cached material, and the weapon in the player's
 * hands is holding those -- photographing a shop card would corrupt the gun
 * they are aiming with.
 */
export function previewFinish(camoId, skinId = null, weaponId = DEFAULT_SUBJECT) {
  const camo = CAMO_BY_ID[camoId] ?? CAMO_BY_ID.standard;
  const over = SKIN_BY_ID.get(skinId);

  const merged = {
    id: `finish:${camoId}:${skinId ?? 'none'}`,
    roles: {
      [ROLE.METAL]: camo.metal,
      [ROLE.DARK]: camo.dark,
      [ROLE.WOOD]: camo.wood,
      [ROLE.ACCENT]: camo.furniture,
      // A skin wins wherever it has an opinion, exactly as it does in game.
      ...(over && !over.isDefault ? over.roles : null),
    },
    roughness: camo.metalRoughness,
    metalness: camo.metalMetalness,
    pattern: over?.isDefault ? undefined : over?.pattern,
    patternRoles: over?.patternRoles,
    patternRepeat: over?.patternRepeat,
    tint: over?.isDefault ? undefined : over?.tint,
  };
  return shoot(weaponId, (model) => applySkin(model, merged));
}

/** Free the preview context once the cards have their images. */
export function disposePreviews() {
  if (!ctx) return;

  for (const { model } of ctx.subjects.values()) {
    model.traverse((o) => {
      if (!o.isMesh) return;
      // The geometry is this model's own. The material usually is not -- the
      // viewmodel caches materials by colour and the gun in the player's hands
      // is holding the same objects, so only the copies a finish made here are
      // ours to free.
      o.geometry.dispose();
      if (o.material?.userData.isSkinClone) {
        o.material.dispose();
      }
    });
  }
  ctx.subjects.clear();

  ctx.renderer.dispose();
  ctx.renderer.forceContextLoss?.();
  ctx = undefined;
}
