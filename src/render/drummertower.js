// A tall, climbable industrial tower with a live gorilla drummer on its deck.
// Collision and ladder traversal are authored in world/drummertower.js; this
// module is presentation only and may be rebuilt or disposed with the world.

import * as THREE from '../../vendor/three.module.js';
import { loadModelFile } from './loadmodel.js';
import {
  bananaVendingInRange, TOWER_DECK_SIZE, TOWER_HATCH_WIDTH,
  VENDING_SHAKE_SECONDS,
} from '../world/drummertower.js';

export const DRUMMER_BPM = 112;
export { VENDING_SHAKE_SECONDS };
export const BANANA_RAIN_COUNT = 320;
export const GORILLA_MODEL_URL = new URL(
  '../../assets/creatures/gorilla/gorilla-rigged.glb', import.meta.url,
).href;
export const GORILLA_FUR_TEXTURE_URL = new URL(
  '../../assets/creatures/gorilla/gorilla-fur-cc0.jpg', import.meta.url,
).href;
export const DRUM_KIT_MODEL_URL = new URL(
  '../../assets/models/realistic_drum_kit/drum-kit.glb', import.meta.url,
).href;
export const DRUM_KIT_STAGE_YAW = Math.PI;
export const VENDING_MACHINE_MODEL_URL = new URL(
  '../../assets/models/banana_vending_machine/Vending Machines.fbx', import.meta.url,
).href;
export const VENDING_BANANA_MODEL_URL = new URL(
  '../../assets/creatures/banana/banana.glb', import.meta.url,
).href;

const UP = new THREE.Vector3(0, 1, 0);
const TEMP_DIR = new THREE.Vector3();
const TEMP_MID = new THREE.Vector3();

function srgb(hex) { return new THREE.Color().setHex(hex, THREE.SRGBColorSpace); }

function material(hex, roughness = 0.65, metalness = 0.2, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color: srgb(hex), roughness, metalness, ...extra,
  });
}

function mesh(parent, geometry, mat, x, y, z, sx = 1, sy = 1, sz = 1) {
  const part = new THREE.Mesh(geometry, mat);
  part.position.set(x, y, z);
  part.scale.set(sx, sy, sz);
  part.castShadow = true;
  part.receiveShadow = true;
  parent.add(part);
  return part;
}

function beam(parent, geometry, mat, ax, ay, az, bx, by, bz, radiusScale = 1) {
  TEMP_DIR.set(bx - ax, by - ay, bz - az);
  const length = TEMP_DIR.length();
  if (length < 1e-5) return null;
  TEMP_MID.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  const part = new THREE.Mesh(geometry, mat);
  part.position.copy(TEMP_MID);
  part.quaternion.setFromUnitVectors(UP, TEMP_DIR.normalize());
  part.scale.set(radiusScale, length, radiusScale);
  part.castShadow = true;
  part.receiveShadow = true;
  parent.add(part);
  return part;
}

function canvasLabel() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, '#10171b');
  gradient.addColorStop(0.5, '#253037');
  gradient.addColorStop(1, '#10171b');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#d79b38';
  ctx.lineWidth = 12;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.fillStyle = '#f3c563';
  ctx.font = '900 82px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('RHYTHM TOWER', canvas.width / 2, canvas.height / 2 + 3);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function canvasBananaLabel() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#f5cf31';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#34250c';
  ctx.lineWidth = 14;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.fillStyle = '#241b0b';
  ctx.font = '900 82px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('BANANAS', canvas.width / 2, canvas.height / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function addBananaVendingFallback(root, geos, mats, position) {
  const machine = new THREE.Group();
  machine.name = 'banana-vending-machine-fallback';
  machine.position.copy(position);
  root.add(machine);

  mesh(machine, geos.box, mats.vendingYellow, 0, 1.08, 0, 1.02, 2.16, 0.94);
  mesh(machine, geos.box, mats.vendingDark, -0.1, 1.18, 0.486, 0.69, 1.02, 0.025);
  mesh(machine, geos.box, mats.vendingGlass, -0.1, 1.18, 0.504, 0.63, 0.94, 0.012);
  mesh(machine, geos.box, mats.vendingDark, 0.35, 1.3, 0.5, 0.17, 0.4, 0.035);
  mesh(machine, geos.box, mats.vendingDark, 0, 0.26, 0.5, 0.58, 0.19, 0.04);
  for (const y of [0.96, 1.27, 1.58]) {
    mesh(machine, geos.box, mats.vendingShelf, -0.1, y, 0.51, 0.66, 0.035, 0.035);
  }
  return machine;
}

function addDrumKit(root, geos, mats) {
  const kit = new THREE.Group();
  kit.position.set(0, 0, 0.92);
  root.add(kit);

  const shell = mats.drumRed;
  const chrome = mats.chrome;
  const head = mats.drumHead;
  const brass = mats.brass;

  const drum = (x, y, z, radius, depth, horizontal = true) => {
    const body = mesh(kit, geos.cylinder20, shell, x, y, z, radius, depth, radius);
    if (horizontal) body.rotation.x = Math.PI / 2;
    const rimA = mesh(kit, geos.cylinder16, chrome, x, y, z + depth / 2, radius * 1.035, 0.035, radius * 1.035);
    const rimB = mesh(kit, geos.cylinder16, chrome, x, y, z - depth / 2, radius * 1.035, 0.035, radius * 1.035);
    rimA.rotation.x = rimB.rotation.x = Math.PI / 2;
    const face = mesh(kit, geos.cylinder20, head, x, y, z + depth / 2 + 0.026,
      radius * 0.94, 0.025, radius * 0.94);
    face.rotation.x = Math.PI / 2;
    return body;
  };

  // Bass drum and three pitched toms make the silhouette read as a real kit
  // even from the courtyard twenty-four metres below.
  drum(0, 0.66, 0.58, 0.68, 0.56);
  const leftTom = drum(-0.49, 1.28, 0.22, 0.37, 0.38);
  const rightTom = drum(0.43, 1.32, 0.18, 0.42, 0.4);
  leftTom.rotation.x = rightTom.rotation.x = Math.PI / 2 - 0.22;
  const floorTom = mesh(kit, geos.cylinder20, shell, 0.93, 0.9, 0.78, 0.44, 0.62, 0.44);
  mesh(kit, geos.cylinder20, head, 0.93, 1.225, 0.78, 0.405, 0.025, 0.405);

  // Snare, hi-hat and cymbals on actual stands.
  mesh(kit, geos.cylinder20, chrome, -0.77, 1.02, 0.73, 0.39, 0.17, 0.39);
  mesh(kit, geos.cylinder20, head, -0.77, 1.115, 0.73, 0.36, 0.018, 0.36);
  const cymbals = [];
  const cymbal = (x, y, z, radius, tilt = 0) => {
    beam(kit, geos.beam, chrome, x, 0.12, z, x, y, z, 0.7);
    const disc = mesh(kit, geos.cylinder20, brass, x, y, z, radius, 0.035, radius);
    disc.rotation.z = tilt;
    const cap = mesh(kit, geos.sphere, chrome, x, y + 0.045, z, 0.065, 0.045, 0.065);
    cymbals.push(disc);
    return disc;
  };
  cymbal(-1.25, 1.5, 0.43, 0.47, -0.08);
  cymbal(1.35, 1.65, 0.34, 0.58, 0.12);
  const hiHat = cymbal(-1.02, 1.27, 1.18, 0.34, -0.03);
  const hiHatTop = mesh(kit, geos.cylinder20, brass, -1.02, 1.31, 1.18, 0.33, 0.025, 0.33);
  cymbals.push(hiHatTop);

  // Kick pedal and throne are small, but keep the setup from reading like
  // drums abandoned on the roof.
  beam(kit, geos.beam, chrome, 0, 0.12, 0.92, 0, 0.48, 0.78, 0.8);
  mesh(kit, geos.box, mats.rubber, 0, 0.12, 1.02, 0.24, 0.055, 0.46);
  beam(kit, geos.beam, chrome, 0, 0.12, -0.62, 0, 0.68, -0.62, 1);
  mesh(kit, geos.cylinder16, mats.rubber, 0, 0.72, -0.62, 0.42, 0.13, 0.42);

  return { kit, cymbals, hiHat, hiHatTop, floorTom };
}

function addGorilla(root, geos, mats) {
  const gorilla = new THREE.Group();
  gorilla.name = 'articulated-gorilla-fallback';
  gorilla.position.set(0, 0, -1.42);
  root.add(gorilla);

  // Broad shoulders, long forearms, short legs and a forward muzzle preserve
  // the unmistakable gorilla proportions of the reference clip.
  mesh(gorilla, geos.sphere, mats.fur, 0, 1.72, 0, 0.77, 0.98, 0.55);
  mesh(gorilla, geos.sphere, mats.furDark, 0, 1.13, -0.05, 0.61, 0.58, 0.47);
  mesh(gorilla, geos.sphere, mats.fur, 0, 2.45, 0.08, 0.49, 0.55, 0.43);
  mesh(gorilla, geos.sphere, mats.skin, 0, 2.49, 0.43, 0.36, 0.3, 0.12);
  mesh(gorilla, geos.sphere, mats.skinDark, 0, 2.27, 0.59, 0.35, 0.23, 0.22);
  mesh(gorilla, geos.sphere, mats.black, 0, 2.35, 0.79, 0.23, 0.12, 0.1);
  mesh(gorilla, geos.sphere, mats.fur, -0.43, 2.48, 0.03, 0.16, 0.2, 0.12);
  mesh(gorilla, geos.sphere, mats.fur, 0.43, 2.48, 0.03, 0.16, 0.2, 0.12);
  for (const x of [-0.16, 0.16]) {
    mesh(gorilla, geos.sphere, mats.eye, x, 2.56, 0.555, 0.052, 0.058, 0.035);
    mesh(gorilla, geos.sphere, mats.black, x, 2.56, 0.584, 0.022, 0.028, 0.018);
  }
  // Nostrils and a pale lower lip survive the dark face at long range.
  for (const x of [-0.075, 0.075]) {
    mesh(gorilla, geos.sphere, mats.skinDark, x, 2.35, 0.887, 0.032, 0.023, 0.018);
  }
  mesh(gorilla, geos.box, mats.lip, 0, 2.14, 0.797, 0.27, 0.045, 0.052);

  for (const x of [-0.32, 0.32]) {
    const leg = new THREE.Group();
    leg.position.set(x, 1.02, -0.05);
    gorilla.add(leg);
    mesh(leg, geos.cylinder12, mats.furDark, 0, -0.4, 0, 0.24, 0.82, 0.24);
    mesh(leg, geos.sphere, mats.skinDark, 0, -0.85, 0.19, 0.27, 0.16, 0.41);
  }

  const arms = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.name = side < 0 ? 'gorilla-left-arm' : 'gorilla-right-arm';
    arm.position.set(side * 0.66, 2.12, 0.05);
    gorilla.add(arm);
    // The shoulder follows the animated arm and overlaps both adjoining forms,
    // preventing the fallback drummer's downstroke from opening a visible seam.
    const shoulder = mesh(arm, geos.sphere, mats.fur, 0, -0.08, 0, 0.31, 0.33, 0.29);
    shoulder.name = side < 0 ? 'gorilla-left-shoulder-seal' : 'gorilla-right-shoulder-seal';
    mesh(arm, geos.cylinder12, mats.fur, 0, -0.48, 0, 0.23, 0.96, 0.23);
    mesh(arm, geos.sphere, mats.furDark, 0, -0.93, 0.03, 0.28, 0.3, 0.25);
    const stick = mesh(arm, geos.beam, mats.wood, 0, -1.18, 0.28, 0.065, 0.8, 0.065);
    stick.rotation.x = -0.28;
    arms.push(arm);
  }
  return { gorilla, leftArm: arms[0], rightArm: arms[1] };
}

function attachDrumstick(hand, geos, mats, side) {
  const stick = mesh(hand, geos.drumstick, mats.wood, side * 0.025, 0, 0.02);
  stick.name = side < 0 ? 'rigged-left-drumstick' : 'rigged-right-drumstick';
  stick.rotation.z = side * 0.08;
  // A narrow maker's band keeps the pale maple profile readable at distance
  // without turning it back into the oversized cylinders this replaced.
  mesh(stick, geos.cylinder16, mats.woodMark, 0, -0.14, 0, 0.024, 0.012, 0.024);
  return stick;
}

function disposeImportedScene(scene) {
  const geometries = new Set();
  const materials = new Set();
  scene?.traverse?.((part) => {
    if (part.geometry) geometries.add(part.geometry);
    for (const mat of Array.isArray(part.material) ? part.material : [part.material]) {
      if (mat) materials.add(mat);
    }
  });
  for (const geometry of geometries) geometry.dispose?.();
  for (const mat of materials) mat.dispose?.();
}

function strikePulse(step, hits, anticipation = 0.82, recovery = 0.68) {
  let strength = 0;
  for (const hit of hits) {
    let distance = (step - hit + 8) % 16 - 8;
    if (distance < -8) distance += 16;
    let phase = 0;
    if (distance < 0 && distance >= -anticipation) {
      phase = (distance + anticipation) / anticipation;
    } else if (distance >= 0 && distance <= recovery) {
      phase = 1 - distance / recovery;
    }
    const eased = phase * phase * (3 - 2 * phase);
    strength = Math.max(strength, eased);
  }
  return strength;
}

export class DrummerTowerRenderer {
  constructor(world, options = {}) {
    this.world = world;
    this.tower = world.drummerTower;
    this.mesh = new THREE.Group();
    this.mesh.name = 'rhythm-tower';
    this.time = 0;
    this.vendingState = 'idle';
    this.vendingTime = 0;
    this.vendingRattleAt = 0;
    this.vendingDebris = [];
    this.bananaRain = [];
    // The storm rewrites hundreds of instance transforms for a few seconds.
    // Keep its transform scratch objects alive instead of allocating them in
    // every frame (and once per banana for the scale vector).
    this._bananaBaseMatrix = new THREE.Matrix4();
    this._bananaPartMatrix = new THREE.Matrix4();
    this._bananaQuaternion = new THREE.Quaternion();
    this._bananaScale = new THREE.Vector3();
    this._bananaHiddenScale = new THREE.Vector3(0, 0, 0);
    this._bananaHiddenPosition = new THREE.Vector3();
    this._bananaCollisionRadius = 0.08;
    this._disposed = false;
    this._loadModel = options.loadModel ?? loadModelFile;
    this._loadTexture = options.loadTexture
      ?? (typeof document !== 'undefined'
        ? (url) => new THREE.TextureLoader().loadAsync(url)
        : null);
    this._onAssetError = options.onAssetError ?? ((label, error) => {
      console.warn(`Realistic ${label} unavailable; keeping procedural fallback`, error);
    });
    this._build();
    this._assetsPromise = null;
    this.ready = this.tower && !options.deferAssets
      ? this.loadAssets()
      : Promise.resolve(this);
  }

  /** Begin the optional photographed performance once, on the caller's schedule. */
  loadAssets() {
    if (!this.tower) return Promise.resolve(this);
    if (!this._assetsPromise) this._assetsPromise = this._loadPerformanceAssets();
    this.ready = this._assetsPromise;
    return this._assetsPromise;
  }

  _build() {
    const tower = this.tower;
    if (!tower) return;
    const base = tower.baseY;
    const deck = tower.deckY;
    const deckSize = tower.deckSize ?? TOWER_DECK_SIZE;
    const half = deckSize / 2;
    const hatchHalf = TOWER_HATCH_WIDTH / 2;

    this.geos = {
      box: new THREE.BoxGeometry(1, 1, 1),
      beam: new THREE.CylinderGeometry(0.035, 0.035, 1, 8),
      cylinder12: new THREE.CylinderGeometry(1, 1, 1, 12),
      cylinder16: new THREE.CylinderGeometry(1, 1, 1, 16),
      cylinder20: new THREE.CylinderGeometry(1, 1, 1, 20),
      drumstick: new THREE.LatheGeometry([
        new THREE.Vector2(0, -1.12),
        new THREE.Vector2(0.02, -1.1),
        new THREE.Vector2(0.028, -1.065),
        new THREE.Vector2(0.025, -1.02),
        new THREE.Vector2(0.014, -0.98),
        new THREE.Vector2(0.019, -0.88),
        new THREE.Vector2(0.023, -0.08),
        new THREE.Vector2(0.022, -0.025),
        new THREE.Vector2(0, 0),
      ], 18),
      sphere: new THREE.SphereGeometry(1, 16, 12),
    };
    this.mats = {
      steel: material(0x39464b, 0.46, 0.74),
      darkSteel: material(0x1d282d, 0.5, 0.68),
      galvanized: material(0x8b9798, 0.35, 0.78),
      safety: material(0xd79b38, 0.48, 0.5),
      chrome: material(0xc2cbca, 0.18, 0.92),
      drumRed: material(0x8d201d, 0.32, 0.58),
      drumHead: material(0xb8b4a8, 0.67, 0.08),
      brass: material(0xc99b35, 0.23, 0.83),
      rubber: material(0x171a1b, 0.92, 0.02),
      fur: material(0x242728, 0.98, 0, { flatShading: true }),
      // The source gorilla is a thin, low-poly shell. Double-sided rendering
      // prevents close player cameras and animated joints exposing culled
      // backfaces through that shell.
      furReal: material(0x4d5356, 0.94, 0, {
        side: THREE.DoubleSide,
        shadowSide: THREE.DoubleSide,
      }),
      furDark: material(0x121516, 0.99, 0, { flatShading: true }),
      skin: material(0x555a5b, 0.86, 0.02),
      skinDark: material(0x303536, 0.92, 0),
      eye: material(0xdcc98d, 0.25, 0.05),
      black: material(0x030404, 0.65, 0),
      lip: material(0x8f7569, 0.72, 0),
      wood: material(0xc29656, 0.66, 0.03),
      woodMark: material(0x4b2f1b, 0.72, 0),
      speaker: material(0x13191d, 0.76, 0.12),
      cone: material(0x252b2c, 0.87, 0.02),
      vendingYellow: material(0xd6ad20, 0.38, 0.34),
      vendingDark: material(0x17191a, 0.62, 0.42),
      vendingGlass: material(0xa9d9dc, 0.12, 0.04, {
        transparent: true, opacity: 0.25, depthWrite: false,
      }),
      vendingShelf: material(0x8f9897, 0.28, 0.78),
      bananaPeel: material(0xf2c51f, 0.66, 0.01),
      bananaTip: material(0x463312, 0.88, 0),
    };

    const structure = new THREE.Group();
    this.mesh.add(structure);
    mesh(structure, this.geos.box, this.mats.darkSteel,
      tower.x, base + 0.13, tower.z, deckSize + 0.55, 0.26, deckSize + 0.55);

    const leg = (deckSize - 1.4) / 2;
    for (const dx of [-leg, leg]) {
      for (const dz of [-leg, leg]) {
        mesh(structure, this.geos.box, this.mats.steel,
          tower.x + dx, base + tower.height / 2, tower.z + dz,
          0.48, tower.height, 0.48);
        mesh(structure, this.geos.box, this.mats.safety,
          tower.x + dx, base + 0.13, tower.z + dz, 0.86, 0.22, 0.86);
      }
    }

    // Six braced bays make the height legible; a plain 24m box reads as a
    // texture-scaled wall, while repeated human-scale bays read as tall.
    const bays = 6;
    for (let bay = 0; bay < bays; bay++) {
      const y0 = base + bay * tower.height / bays;
      const y1 = base + (bay + 1) * tower.height / bays;
      for (const z of [tower.z - leg, tower.z + leg]) {
        beam(structure, this.geos.beam, this.mats.steel,
          tower.x - leg, y0, z, tower.x + leg, y1, z, 1.25);
        beam(structure, this.geos.beam, this.mats.steel,
          tower.x + leg, y0, z, tower.x - leg, y1, z, 1.25);
        beam(structure, this.geos.beam, this.mats.darkSteel,
          tower.x - leg, y1, z, tower.x + leg, y1, z, 1.45);
      }
      for (const x of [tower.x - leg, tower.x + leg]) {
        beam(structure, this.geos.beam, this.mats.steel,
          x, y0, tower.z - leg, x, y1, tower.z + leg, 1.25);
        beam(structure, this.geos.beam, this.mats.steel,
          x, y0, tower.z + leg, x, y1, tower.z - leg, 1.25);
        beam(structure, this.geos.beam, this.mats.darkSteel,
          x, y1, tower.z - leg, x, y1, tower.z + leg, 1.45);
      }
    }

    const hatchInner = tower.z + half - 1.42;
    mesh(structure, this.geos.box, this.mats.galvanized,
      tower.x - (half + hatchHalf) / 2, deck - 0.17, tower.z,
      half - hatchHalf, 0.34, deckSize);
    mesh(structure, this.geos.box, this.mats.galvanized,
      tower.x + (half + hatchHalf) / 2, deck - 0.17, tower.z,
      half - hatchHalf, 0.34, deckSize);
    mesh(structure, this.geos.box, this.mats.galvanized,
      tower.x, deck - 0.17, (tower.z - half + hatchInner) / 2,
      TOWER_HATCH_WIDTH, 0.34, hatchInner - (tower.z - half));

    // Tubular guard rails, with the same south opening as the collider.
    const postY = deck + 0.65;
    const railTop = deck + 1.2;
    const railMid = deck + 0.65;
    const post = (x, z) => beam(structure, this.geos.beam, this.mats.safety,
      x, deck + 0.04, z, x, railTop, z, 1.15);
    for (const x of [tower.x - half, tower.x - half / 2, tower.x, tower.x + half / 2, tower.x + half]) {
      post(x, tower.z - half);
      if (Math.abs(x - tower.x) > hatchHalf + 0.1) post(x, tower.z + half);
    }
    for (const z of [tower.z - half / 2, tower.z, tower.z + half / 2]) {
      post(tower.x - half, z); post(tower.x + half, z);
    }
    for (const y of [railMid, railTop]) {
      beam(structure, this.geos.beam, this.mats.safety,
        tower.x - half, y, tower.z - half, tower.x + half, y, tower.z - half, 1.15);
      beam(structure, this.geos.beam, this.mats.safety,
        tower.x - half, y, tower.z - half, tower.x - half, y, tower.z + half, 1.15);
      beam(structure, this.geos.beam, this.mats.safety,
        tower.x + half, y, tower.z - half, tower.x + half, y, tower.z + half, 1.15);
      beam(structure, this.geos.beam, this.mats.safety,
        tower.x - half, y, tower.z + half, tower.x - hatchHalf, y, tower.z + half, 1.15);
      beam(structure, this.geos.beam, this.mats.safety,
        tower.x + hatchHalf, y, tower.z + half, tower.x + half, y, tower.z + half, 1.15);
    }
    void postY;

    this._buildLadder(structure);
    this._buildSign(structure);

    const stage = new THREE.Group();
    stage.position.set(tower.x, deck + 0.03, tower.z - 0.95);
    this.mesh.add(stage);
    const drums = addDrumKit(stage, this.geos, this.mats);
    const ape = addGorilla(stage, this.geos, this.mats);
    Object.assign(this, drums, ape);
    this.stage = stage;
    this.proceduralKit = drums.kit;
    this.proceduralGorilla = ape.gorilla;
    this.importedGeometries = new Set();
    this.importedMaterials = new Set();

    // A small PA stack makes the source of the map-wide sound visible.
    this.speakerCones = [];
    for (const x of [-3.55, 3.55]) {
      mesh(stage, this.geos.box, this.mats.speaker, x, 0.95, -2.22, 0.72, 1.55, 0.62);
      for (const y of [0.62, 1.22]) {
        const cone = mesh(stage, this.geos.cylinder20, this.mats.cone, x, y, -1.88, 0.23, 0.08, 0.23);
        cone.rotation.x = Math.PI / 2;
        this.speakerCones.push(cone);
      }
    }

    // The community-requested machine occupies a real authored collider beside
    // the drummer. Its detailed CC0 model replaces this complete fallback once
    // loaded; the separate decoration root keeps its marquee and real banana
    // stock visible regardless of asset arrival order.
    const vending = tower.bananaVending;
    const vendingPosition = new THREE.Vector3(
      vending.x - tower.x,
      vending.y - (deck + 0.03),
      vending.z - (tower.z - 0.95),
    );
    this.proceduralVendingMachine = addBananaVendingFallback(
      stage, this.geos, this.mats, vendingPosition,
    );
    this.vendingMachine = this.proceduralVendingMachine;
    this.vendingDecor = new THREE.Group();
    this.vendingDecor.name = 'banana-vending-decoration';
    this.vendingDecor.position.copy(vendingPosition);
    this.vendingRestPosition = vendingPosition.clone();
    stage.add(this.vendingDecor);
    const bananaLabel = canvasBananaLabel();
    if (bananaLabel) {
      this.bananaLabelTexture = bananaLabel;
      this.mats.bananaLabel = new THREE.MeshStandardMaterial({
        map: bananaLabel, emissiveMap: bananaLabel, emissive: srgb(0x5a4410),
        emissiveIntensity: 0.42, roughness: 0.38, metalness: 0.12,
      });
      this.bananaLabelGeometry = new THREE.PlaneGeometry(0.78, 0.25);
      const label = new THREE.Mesh(this.bananaLabelGeometry, this.mats.bananaLabel);
      label.name = 'banana-vending-marquee';
      label.position.set(0, 1.91, 0.53);
      label.castShadow = true;
      this.vendingDecor.add(label);
    }

    // Aviation beacon and a warm performance wash make the destination readable
    // from the start room at night or under heavy fog.
    this.beaconMat = new THREE.MeshStandardMaterial({
      color: srgb(0xff3b24), emissive: srgb(0xff210f), emissiveIntensity: 2.2,
      roughness: 0.24, metalness: 0.08,
    });
    this.beacon = mesh(this.mesh, this.geos.sphere, this.beaconMat,
      tower.x, deck + 3.2, tower.z - half + 0.55, 0.17, 0.17, 0.17);
    beam(this.mesh, this.geos.beam, this.mats.darkSteel,
      tower.x, deck + 1.15, tower.z - half + 0.55,
      tower.x, deck + 3.08, tower.z - half + 0.55, 1.35);
    // The former animated point beacon lit and unlit the entire roof in hard
    // pulses, which looked like a renderer flash rather than an aviation lamp.
    // The emissive lens stays readable without adding another global light.
    this.beaconLight = null;
    this.stageLight = new THREE.PointLight(0xffbb72, 4.2, 13, 1.35);
    this.stageLight.position.set(tower.x, deck + 3.5, tower.z + 0.2);
    this.mesh.add(this.stageLight);
  }

  async _loadPerformanceAssets() {
    await this._loadFurTexture();
    await Promise.all([
      this._loadPerformanceAsset('gorilla', GORILLA_MODEL_URL, (scene) => this._installGorilla(scene)),
      this._loadPerformanceAsset('drum kit', DRUM_KIT_MODEL_URL, (scene) => this._installDrumKit(scene)),
      this._loadPerformanceAsset(
        'banana vending machine', VENDING_MACHINE_MODEL_URL,
        (scene) => this._installVendingMachine(scene),
      ),
      this._loadPerformanceAsset(
        'vending bananas', VENDING_BANANA_MODEL_URL,
        (scene) => this._installVendingBananas(scene),
      ),
    ]);
    return this;
  }

  async _loadFurTexture() {
    if (!this._loadTexture) return;
    try {
      const texture = await this._loadTexture(GORILLA_FUR_TEXTURE_URL);
      if (this._disposed) {
        texture?.dispose?.();
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      this.furTexture = texture;
      this.mats.furReal.map = texture;
      this.mats.furReal.bumpMap = texture;
      this.mats.furReal.bumpScale = 0.045;
      this.mats.furReal.needsUpdate = true;
    } catch (error) {
      if (!this._disposed) this._onAssetError('gorilla fur texture', error);
    }
  }

  async _loadPerformanceAsset(label, url, install) {
    let scene;
    try {
      const loaded = await this._loadModel(url);
      scene = loaded?.scene;
      if (!scene?.traverse) throw new Error(`${label} file did not contain a scene`);
      if (this._disposed) {
        disposeImportedScene(scene);
        return;
      }
      install(scene);
    } catch (error) {
      if (!this._disposed) this._onAssetError(label, error);
    }
  }

  _prepareImportedScene(scene, pickMaterial, hiddenMesh = () => false) {
    const replacedMaterials = new Set();
    scene.traverse((part) => {
      if (!part.isMesh) return;
      if (hiddenMesh(part)) part.visible = false;
      if (part.geometry) this.importedGeometries.add(part.geometry);
      for (const mat of Array.isArray(part.material) ? part.material : [part.material]) {
        if (mat) replacedMaterials.add(mat);
      }
      part.material = pickMaterial(part);
      part.castShadow = true;
      part.receiveShadow = true;
    });
    for (const mat of replacedMaterials) mat.dispose?.();
  }

  _installGorilla(scene) {
    const rig = {
      leftUpper: scene.getObjectByName('GorillaLeftUpperArm'),
      leftFore: scene.getObjectByName('GorillaLeftForeArm'),
      leftHand: scene.getObjectByName('GorillaLeftHand'),
      rightUpper: scene.getObjectByName('GorillaRightUpperArm'),
      rightFore: scene.getObjectByName('GorillaRightForeArm'),
      rightHand: scene.getObjectByName('GorillaRightHand'),
    };
    if (Object.values(rig).some((bone) => !bone?.isBone)
        || !scene.getObjectByProperty('isSkinnedMesh', true)) {
      throw new Error('gorilla asset is missing its armature or skin weights');
    }
    this._prepareImportedScene(scene, () => this.mats.furReal);
    const gorilla = new THREE.Group();
    gorilla.name = 'cc0-realistic-gorilla';
    gorilla.position.copy(this.proceduralGorilla.position);
    scene.name = 'gorilla-model';
    scene.rotation.x = -Math.PI / 2;
    scene.scale.setScalar(0.78);
    scene.position.set(0, 0.04, 0);
    gorilla.add(scene);
    // The CC0 mesh uses disconnected low-poly sections around its hard-weighted
    // arm joints. Bone-driven seals stay inside those sections and close the
    // holes that otherwise open during the wind-up and downstroke poses.
    const sealJoint = (joint, name, sx, sy = sx, sz = sx) => {
      const seal = mesh(joint, this.geos.sphere, this.mats.furReal, 0, 0, 0, sx, sy, sz);
      seal.name = name;
      return seal;
    };
    sealJoint(rig.leftUpper, 'gorilla-left-shoulder-seal', 0.46, 0.42, 0.46);
    sealJoint(rig.rightUpper, 'gorilla-right-shoulder-seal', 0.46, 0.42, 0.46);
    sealJoint(rig.leftFore, 'gorilla-left-elbow-seal', 0.32, 0.29, 0.32);
    sealJoint(rig.rightFore, 'gorilla-right-elbow-seal', 0.32, 0.29, 0.32);
    sealJoint(rig.leftHand, 'gorilla-left-wrist-seal', 0.23, 0.2, 0.23);
    sealJoint(rig.rightHand, 'gorilla-right-wrist-seal', 0.23, 0.2, 0.23);
    rig.leftStick = attachDrumstick(rig.leftHand, this.geos, this.mats, -1);
    rig.rightStick = attachDrumstick(rig.rightHand, this.geos, this.mats, 1);
    this.stage.add(gorilla);
    this.proceduralGorilla.visible = false;
    this.gorilla = gorilla;
    this.realGorilla = scene;
    this.gorillaRig = rig;
    this.leftArm = rig.leftUpper;
    this.rightArm = rig.rightUpper;
  }

  _installDrumKit(scene) {
    this._prepareImportedScene(
      scene,
      (part) => part.name.startsWith('hw_') || part.name === 'Cube'
        ? this.mats.chrome
        : part.name === 'snare'
          ? this.mats.drumHead
          : this.mats.drumRed,
      (part) => part.name === 'Plane',
    );
    const kit = new THREE.Group();
    kit.name = 'cc0-realistic-drum-kit';
    kit.position.copy(this.proceduralKit.position);
    // Face the kick drum and front heads toward the player approach, leaving
    // the snare/toms on the gorilla's side of the kit.
    kit.rotation.y = DRUM_KIT_STAGE_YAW;
    scene.name = 'drum-kit-model';
    scene.rotation.x = -Math.PI / 2;
    scene.scale.setScalar(0.3);
    scene.position.set(0.05, 0.015, 0);
    kit.add(scene);
    this.stage.add(kit);
    this.proceduralKit.visible = false;
    this.kit = kit;
    this.realDrumKit = scene;
  }

  _installVendingMachine(scene) {
    const source = scene.getObjectByName('Food_Vending_Machine');
    if (!source?.isMesh) throw new Error('vending asset is missing its food machine mesh');

    source.removeFromParent();
    source.position.set(0, 0.4, 0);
    source.rotation.set(-Math.PI / 2, 0, 0);
    source.scale.setScalar(0.4);
    source.castShadow = true;
    source.receiveShadow = true;
    this.importedGeometries.add(source.geometry);
    for (const mat of Array.isArray(source.material) ? source.material : [source.material]) {
      if (mat) this.importedMaterials.add(mat);
    }

    // The authored FBX faces -Z after its Blender-to-Three axis correction.
    // Turn the complete prop toward the south ladder landing so its products,
    // keypad and delivery slot face the approaching player.
    const authored = new THREE.Group();
    authored.name = 'cc0-food-vending-model';
    authored.rotation.y = Math.PI;
    authored.add(source);
    const machine = new THREE.Group();
    machine.name = 'cc0-banana-vending-machine';
    machine.position.copy(this.proceduralVendingMachine.position);
    machine.add(authored);
    this.stage.add(machine);
    this.proceduralVendingMachine.visible = false;
    if (this.vendingState === 'exploded') machine.visible = false;
    this.vendingMachine = machine;
    this.realVendingMachine = source;
  }

  _installVendingBananas(scene) {
    const peel = scene.getObjectByName('Model_1');
    const tip = scene.getObjectByName('Model_2');
    if (!peel?.isMesh || !tip?.isMesh) {
      throw new Error('banana asset is missing its intact peel or end cap');
    }

    const replacedMaterials = new Set();
    for (const [part, mat] of [[peel, this.mats.bananaPeel], [tip, this.mats.bananaTip]]) {
      for (const old of Array.isArray(part.material) ? part.material : [part.material]) {
        if (old) replacedMaterials.add(old);
      }
      part.removeFromParent();
      part.material = mat;
      part.castShadow = true;
      part.receiveShadow = true;
      this.importedGeometries.add(part.geometry);
    }
    for (const mat of replacedMaterials) mat.dispose?.();

    const source = new THREE.Group();
    source.name = 'cc0-unpeeled-vending-banana';
    source.add(peel, tip);
    const stock = new THREE.Group();
    stock.name = 'real-banana-vending-stock';
    for (let index = 0; index < 4; index++) {
      const banana = source.clone(true);
      banana.name = `vending-banana-${index + 1}`;
      banana.scale.setScalar(0.04);
      banana.position.set(
        (index % 2 ? 0.2 : -0.2) + 0.015,
        (index < 2 ? 1.25 : 1.56) + 0.022,
        0.585 - 0.01,
      );
      banana.rotation.z = index % 2 ? -0.12 : 0.12;
      stock.add(banana);
    }
    this.vendingDecor.add(stock);
    this.vendingBananas = stock;
    this._buildBananaRain(peel, tip);
  }

  _buildBananaRain(peel, tip) {
    if (this.bananaRainMeshes) return;
    peel.updateMatrix();
    tip.updateMatrix();
    // Use a conservative source-space bound for floor contact. The imported
    // banana origin is not on its skin, so placing that origin at the terrain
    // height visibly buried part of every settled banana.
    const bananaBounds = new THREE.Box3();
    bananaBounds.makeEmpty();
    for (const part of [peel, tip]) {
      part.geometry.computeBoundingBox?.();
      if (!part.geometry.boundingBox) continue;
      bananaBounds.union(part.geometry.boundingBox.clone().applyMatrix4(part.matrix));
    }
    if (!bananaBounds.isEmpty()) {
      const sphere = bananaBounds.getBoundingSphere(new THREE.Sphere());
      if (Number.isFinite(sphere.radius) && sphere.radius > 0) {
        this._bananaCollisionRadius = sphere.radius;
      }
    }
    const peelRain = new THREE.InstancedMesh(
      peel.geometry, this.mats.bananaPeel, BANANA_RAIN_COUNT,
    );
    const tipRain = new THREE.InstancedMesh(
      tip.geometry, this.mats.bananaTip, BANANA_RAIN_COUNT,
    );
    for (const rain of [peelRain, tipRain]) {
      rain.name = rain === peelRain ? 'real-banana-rain-peels' : 'real-banana-rain-tips';
      // Hundreds of tiny moving shadow casters more than double the storm's
      // vertex work and produce unstable pinprick shadows. Sunlight on the
      // material is enough at this scale.
      rain.castShadow = false;
      rain.receiveShadow = false;
      rain.frustumCulled = false;
      rain.visible = false;
      rain.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.add(rain);
    }
    this.bananaRainMeshes = [peelRain, tipRain];
    this.bananaRainPartMatrices = [peel.matrix.clone(), tip.matrix.clone()];
    this._writeBananaRainMatrices();
  }

  vendingInRange(player) {
    return this.vendingState === 'idle' && bananaVendingInRange(this.tower, player);
  }

  activateVendingMachine(elapsed = 0) {
    if (this.vendingState !== 'idle') return false;
    if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;
    // A late co-op join receives durable state rather than the original event.
    // If the blast is already over, restore the destroyed machine without
    // replaying old sound, camera shake or a fresh banana storm.
    if (elapsed >= VENDING_SHAKE_SECONDS) {
      this.vendingState = 'exploded';
      this.vendingTime = elapsed - VENDING_SHAKE_SECONDS;
      this.world.destroyBananaVendingMachine?.();
      for (const object of [
        this.vendingMachine, this.proceduralVendingMachine, this.vendingDecor,
      ]) {
        if (!object) continue;
        object.position.copy(this.vendingRestPosition);
        object.rotation.set(0, 0, 0);
        object.visible = false;
      }
      return true;
    }
    this.vendingState = 'shaking';
    this.vendingTime = elapsed;
    this.vendingRattleAt = elapsed + 0.11;
    return true;
  }

  reset() {
    this.vendingState = 'idle';
    this.vendingTime = 0;
    this.vendingRattleAt = 0;
    for (const shard of this.vendingDebris) shard.mesh.removeFromParent();
    this.vendingDebris.length = 0;
    this.vendingFlash?.removeFromParent();
    this.vendingFlash = null;
    this.bananaRain.length = 0;
    for (const rain of this.bananaRainMeshes ?? []) rain.visible = false;
    for (const object of [this.vendingMachine, this.vendingDecor]) {
      if (!object) continue;
      object.position.copy(this.vendingRestPosition);
      object.rotation.set(0, 0, 0);
      object.visible = true;
    }
    if (this.realVendingMachine) this.proceduralVendingMachine.visible = false;
  }

  _explodeVendingMachine() {
    this.vendingState = 'exploded';
    this.vendingTime = 0;
    const vending = this.tower.bananaVending;
    this.world.destroyBananaVendingMachine?.();
    for (const object of [
      this.vendingMachine, this.proceduralVendingMachine, this.vendingDecor,
    ]) {
      if (!object) continue;
      object.position.copy(this.vendingRestPosition);
      object.rotation.set(0, 0, 0);
      object.visible = false;
    }

    for (let index = 0; index < 18; index++) {
      const panel = new THREE.Mesh(
        this.geos.box,
        index % 5 === 0 ? this.mats.vendingGlass
          : index % 3 === 0 ? this.mats.vendingYellow : this.mats.galvanized,
      );
      panel.name = `banana-vending-debris-${index + 1}`;
      panel.position.set(vending.x, vending.y + 0.35 + Math.random() * 1.55, vending.z);
      panel.scale.set(
        0.12 + Math.random() * 0.34,
        0.05 + Math.random() * 0.22,
        0.025 + Math.random() * 0.08,
      );
      panel.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      panel.castShadow = true;
      panel.receiveShadow = true;
      this.mesh.add(panel);
      const angle = Math.random() * Math.PI * 2;
      const speed = 3.4 + Math.random() * 7.2;
      this.vendingDebris.push({
        mesh: panel,
        velocity: new THREE.Vector3(
          Math.cos(angle) * speed, 5.5 + Math.random() * 7.5, Math.sin(angle) * speed,
        ),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 13,
          (Math.random() - 0.5) * 13,
          (Math.random() - 0.5) * 13,
        ),
        bounces: 0,
        settled: false,
      });
    }

    this.vendingFlash = new THREE.PointLight(0xffb32b, 18, 25, 1.4);
    this.vendingFlash.position.set(vending.x, vending.y + 1.1, vending.z);
    this.mesh.add(this.vendingFlash);
    this._startBananaRain();
  }

  _startBananaRain() {
    if (!this.bananaRainMeshes) return;
    const { x, z, deckY, deckSize = TOWER_DECK_SIZE } = this.tower;
    this.bananaRain.length = 0;
    for (let index = 0; index < BANANA_RAIN_COUNT; index++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.sqrt(Math.random()) * (deckSize * 1.25);
      this.bananaRain.push({
        position: new THREE.Vector3(
          x + Math.cos(angle) * radius,
          deckY + 15 + Math.random() * 24,
          z + Math.sin(angle) * radius,
        ),
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 2.4,
          -2.5 - Math.random() * 5,
          (Math.random() - 0.5) * 2.4,
        ),
        rotation: new THREE.Euler(
          Math.random() * Math.PI * 2,
          Math.random() * Math.PI * 2,
          Math.random() * Math.PI * 2,
        ),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
        ),
        delay: index * 0.024 + Math.random() * 0.7,
        scale: 0.032 + Math.random() * 0.016,
        bounces: 0,
        revealed: false,
        settled: false,
      });
    }
    for (const rain of this.bananaRainMeshes) rain.visible = true;
    this._writeBananaRainMatrices();
  }

  _writeBananaRainMatrices() {
    if (!this.bananaRainMeshes) return;
    const base = this._bananaBaseMatrix;
    const matrix = this._bananaPartMatrix;
    const quaternion = this._bananaQuaternion;
    for (let index = 0; index < BANANA_RAIN_COUNT; index++) {
      const banana = this.bananaRain[index];
      if (banana && this.vendingTime >= banana.delay) {
        banana.revealed = true;
        quaternion.setFromEuler(banana.rotation);
        this._bananaScale.setScalar(banana.scale);
        base.compose(banana.position, quaternion, this._bananaScale);
      } else {
        base.compose(
          this._bananaHiddenPosition, quaternion.identity(), this._bananaHiddenScale,
        );
      }
      for (let part = 0; part < this.bananaRainMeshes.length; part++) {
        matrix.multiplyMatrices(base, this.bananaRainPartMatrices[part]);
        this.bananaRainMeshes[part].setMatrixAt(index, matrix);
      }
    }
    for (const rain of this.bananaRainMeshes) rain.instanceMatrix.needsUpdate = true;
  }

  _updateVending(dt) {
    const events = [];
    if (this.vendingState === 'idle') return events;
    this.vendingTime += dt;
    const vending = this.tower.bananaVending;

    if (this.vendingState === 'shaking') {
      const ramp = Math.min(1, this.vendingTime / VENDING_SHAKE_SECONDS);
      const strength = 0.018 + ramp * ramp * 0.115;
      const dx = Math.sin(this.vendingTime * (37 + ramp * 25)) * strength;
      const dz = Math.sin(this.vendingTime * 51 + 1.7) * strength * 0.45;
      const tilt = Math.sin(this.vendingTime * 42) * strength * 0.32;
      for (const object of [this.vendingMachine, this.vendingDecor]) {
        if (!object) continue;
        object.position.set(
          this.vendingRestPosition.x + dx,
          this.vendingRestPosition.y,
          this.vendingRestPosition.z + dz,
        );
        object.rotation.z = tilt;
        object.rotation.y = -tilt * 0.42;
      }
      if (this.vendingTime >= this.vendingRattleAt) {
        events.push({ type: 'vending-rattle', x: vending.x, y: vending.y + 1.05, z: vending.z });
        this.vendingRattleAt += Math.max(0.1, 0.29 - ramp * 0.17);
      }
      if (this.vendingTime >= VENDING_SHAKE_SECONDS) {
        this._explodeVendingMachine();
        events.push({ type: 'vending-explosion', x: vending.x, y: vending.y + 1.05, z: vending.z });
      }
      return events;
    }

    if (this.vendingFlash) {
      this.vendingFlash.intensity = Math.max(0, this.vendingFlash.intensity - dt * 48);
      if (this.vendingFlash.intensity === 0 && this.vendingFlash.parent) {
        this.vendingFlash.removeFromParent();
      }
    }
    for (const shard of this.vendingDebris) {
      if (!shard.mesh.visible || shard.settled) continue;
      const previousY = shard.mesh.position.y;
      shard.velocity.y -= 15 * dt;
      shard.mesh.position.addScaledVector(shard.velocity, dt);
      shard.mesh.rotation.x += shard.spin.x * dt;
      shard.mesh.rotation.y += shard.spin.y * dt;
      shard.mesh.rotation.z += shard.spin.z * dt;
      const terrain = this.world.heightAt(shard.mesh.position.x, shard.mesh.position.z);
      const support = this.world.supportHeight?.(
        shard.mesh.position.x, shard.mesh.position.z, previousY, 0.08, 0.3,
      );
      const floor = Math.max(terrain, Number.isFinite(support) ? support : terrain) + 0.035;
      if (shard.mesh.position.y <= floor) {
        shard.mesh.position.y = floor;
        shard.bounces += 1;
        shard.velocity.y = Math.abs(shard.velocity.y) * 0.2;
        shard.velocity.x *= 0.7;
        shard.velocity.z *= 0.7;
        if (shard.bounces >= 3 || shard.velocity.y < 0.55) {
          shard.velocity.set(0, 0, 0);
          shard.spin.set(0, 0, 0);
          shard.settled = true;
        }
      }
    }

    let bananaMatricesDirty = false;
    for (const banana of this.bananaRain) {
      if (this.vendingTime < banana.delay) continue;
      if (!banana.revealed) bananaMatricesDirty = true;
      if (banana.settled) continue;
      const previousY = banana.position.y;
      banana.velocity.y -= 11.8 * dt;
      banana.position.addScaledVector(banana.velocity, dt);
      banana.rotation.x += banana.spin.x * dt;
      banana.rotation.y += banana.spin.y * dt;
      banana.rotation.z += banana.spin.z * dt;
      bananaMatricesDirty = true;

      // Collide with the highest real support below the previous position:
      // tower deck, prop tops, or terrain. Testing only the deck let every
      // banana outside its footprint continue through the world forever.
      const terrain = this.world.heightAt(banana.position.x, banana.position.z);
      const support = this.world.supportHeight?.(
        banana.position.x, banana.position.z, previousY, 0.06, 0.3,
      );
      const surface = Math.max(terrain, Number.isFinite(support) ? support : terrain);
      const floor = surface + Math.max(0.045, this._bananaCollisionRadius * banana.scale);
      if (banana.position.y <= floor && banana.bounces < 3) {
        banana.position.y = floor;
        banana.velocity.y = 0.72 + Math.abs(banana.velocity.y) * 0.16;
        banana.velocity.x *= 0.64;
        banana.velocity.z *= 0.64;
        banana.spin.multiplyScalar(0.68);
        banana.bounces += 1;
      } else if (banana.position.y <= floor) {
        banana.position.y = floor;
        banana.velocity.set(0, 0, 0);
        banana.spin.set(0, 0, 0);
        banana.settled = true;
      }
    }
    // Once the last banana settles, retain the final instance buffer without
    // rewriting and uploading it forever.
    if (bananaMatricesDirty) this._writeBananaRainMatrices();
    return events;
  }

  _buildLadder(parent) {
    const ladder = this.tower.ladder;
    const railBottom = ladder.minY;
    const railTop = ladder.maxY;
    const railX = ladder.width * 0.42;
    for (const dx of [-railX, railX]) {
      beam(parent, this.geos.beam, this.mats.galvanized,
        ladder.x + dx, railBottom, ladder.z,
        ladder.x + dx, railTop, ladder.z, 1.25);
    }

    const rungSpacing = 0.31;
    const rungCount = Math.floor((railTop - railBottom) / rungSpacing) + 1;
    const rungGeo = new THREE.CylinderGeometry(0.026, 0.026, 1, 8);
    const rungs = new THREE.InstancedMesh(rungGeo, this.mats.galvanized, rungCount);
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < rungCount; i++) {
      matrix.compose(
        new THREE.Vector3(ladder.x, railBottom + i * rungSpacing, ladder.z),
        rotation,
        new THREE.Vector3(1, ladder.width * 0.86, 1),
      );
      rungs.setMatrixAt(i, matrix);
    }
    rungs.castShadow = true;
    rungs.receiveShadow = true;
    parent.add(rungs);
    this.extraGeometries = [rungGeo];

    // OSHA-style fall cage: hoops, three vertical bands and standoffs. It is
    // visual only; collision uses a friendly body-width ladder volume.
    const cageStart = railBottom + 2.25;
    const cageEnd = this.tower.deckY - 0.45;
    const hoopGeo = new THREE.TorusGeometry(0.69, 0.025, 5, 18, Math.PI * 1.55);
    const hoopCount = Math.max(1, Math.floor((cageEnd - cageStart) / 1.15) + 1);
    const hoops = new THREE.InstancedMesh(hoopGeo, this.mats.safety, hoopCount);
    const hoopMatrix = new THREE.Matrix4();
    const hoopQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, -0.28 * Math.PI));
    for (let i = 0; i < hoopCount; i++) {
      hoopMatrix.compose(
        new THREE.Vector3(ladder.x, cageStart + i * 1.15, ladder.z + 0.18),
        hoopQuat,
        new THREE.Vector3(1, 1, 1),
      );
      hoops.setMatrixAt(i, hoopMatrix);
    }
    hoops.castShadow = true;
    parent.add(hoops);
    this.extraGeometries.push(hoopGeo);
    for (const dx of [-0.62, 0, 0.62]) {
      const dz = dx === 0 ? 0.86 : 0.48;
      beam(parent, this.geos.beam, this.mats.safety,
        ladder.x + dx, cageStart, ladder.z + dz,
        ladder.x + dx, cageEnd, ladder.z + dz, 0.75);
    }
  }

  _buildSign(parent) {
    const texture = canvasLabel();
    if (!texture) return;
    this.labelTexture = texture;
    const signMat = new THREE.MeshStandardMaterial({
      map: texture, emissiveMap: texture, emissive: srgb(0x4b3212),
      emissiveIntensity: 0.36, roughness: 0.5, metalness: 0.25,
    });
    this.mats.sign = signMat;
    this.signGeometry = new THREE.PlaneGeometry(4.8, 1.2);
    const half = (this.tower.deckSize ?? TOWER_DECK_SIZE) / 2;
    for (const side of [-1, 1]) {
      const sign = new THREE.Mesh(this.signGeometry, signMat);
      sign.position.set(
        this.tower.x + side * (half - 0.42),
        this.tower.baseY + 4.1,
        this.tower.z,
      );
      sign.rotation.y = side < 0 ? -Math.PI / 2 : Math.PI / 2;
      sign.castShadow = true;
      parent.add(sign);
    }
  }

  update(dt) {
    if (!this.tower || !this.gorilla) return [];
    const frameDt = Math.max(0, dt || 0);
    const vendingEvents = this._updateVending(frameDt);
    this.time += frameDt;
    const beat = this.time * DRUMMER_BPM / 60;
    const step = (beat * 4) % 16;
    const left = strikePulse(step, [4, 12, 14]);
    const right = strikePulse(step, [0, 2, 6, 8, 10, 15]);
    const kick = strikePulse(step, [0, 3, 7, 8, 10, 11], 0.25, 0.72);
    const crash = strikePulse(step, [0], 0.5, 0.9);

    if (this.gorillaRig) {
      const rig = this.gorillaRig;
      rig.leftUpper.rotation.set(-0.78 + left * 0.64, 0.12 - left * 0.1, -0.12 - left * 0.05);
      rig.leftFore.rotation.set(-0.48 + left * 0.38, 0.06, -0.05);
      // The wrists counter the stacked shoulder/elbow rotations so the sticks
      // rise diagonally on the wind-up and point into the kit at impact.
      rig.leftHand.rotation.set(0.58 - left * 0.42, 0, 0.06);
      rig.rightUpper.rotation.set(-0.72 + right * 0.6, -0.12 + right * 0.1, 0.12 + right * 0.05);
      rig.rightFore.rotation.set(-0.44 + right * 0.36, -0.06, 0.05);
      rig.rightHand.rotation.set(0.54 - right * 0.38, 0, -0.06);
    } else {
      this.leftArm.rotation.x = -0.77 + left * 0.62;
      this.leftArm.rotation.z = -0.16 - left * 0.08;
      this.rightArm.rotation.x = -0.7 + right * 0.58;
      this.rightArm.rotation.z = 0.16 + right * 0.08;
    }
    this.gorilla.position.y = Math.sin(beat * Math.PI * 2) * 0.025 - kick * 0.055;
    this.gorilla.rotation.y = Math.sin(beat * Math.PI) * 0.055;
    this.gorilla.rotation.x = -0.04 - kick * 0.05;
    if (this.realDrumKit) {
      this.realDrumKit.rotation.z = Math.sin(this.time * 27) * crash * 0.004;
    }
    this.cymbals.forEach((cymbal, index) => {
      const energy = index === 1 ? crash : index > 1 ? right * 0.25 : left * 0.18;
      cymbal.rotation.x = Math.sin(this.time * 23 + index) * energy * 0.12;
      cymbal.rotation.z += (Math.sin(this.time * 31 + index) * energy * 0.03 - cymbal.rotation.z * 0.025);
    });
    this.beaconMat.emissiveIntensity = 1.15;
    this.stageLight.intensity = 3.8;
    return vendingEvents;
  }

  dispose() {
    this._disposed = true;
    const geometries = new Set(Object.values(this.geos ?? {}));
    for (const geometry of this.extraGeometries ?? []) geometries.add(geometry);
    for (const geometry of this.importedGeometries ?? []) geometries.add(geometry);
    if (this.signGeometry) geometries.add(this.signGeometry);
    if (this.bananaLabelGeometry) geometries.add(this.bananaLabelGeometry);
    for (const geometry of geometries) geometry?.dispose?.();
    for (const mat of Object.values(this.mats ?? {})) mat?.dispose?.();
    for (const mat of this.importedMaterials ?? []) mat?.dispose?.();
    this.beaconMat?.dispose?.();
    this.furTexture?.dispose?.();
    this.labelTexture?.dispose?.();
    this.bananaLabelTexture?.dispose?.();
  }
}

export function createDrummerTower(world, options = {}) {
  return world?.drummerTower ? new DrummerTowerRenderer(world, options) : null;
}
