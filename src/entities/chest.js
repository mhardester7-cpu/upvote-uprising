// Loot chests: the arena's reward for leaving cover.
//
// A chest is a stationary interactable rather than a walk-over pickup. The
// deliberate beat -- stand next to it, press E, watch the lid come up -- is what
// makes the roll feel like a roll; a crate you collect by walking through it
// would just be another ammo box.
//
// The chest itself knows nothing about what it contains. It rolls an abstract
// loot table and hands the entries back; the game decides what a 'map' or a
// 'potion' actually means, which keeps stone placement and the weapon table out
// of this file.

import * as THREE from '../../vendor/three.module.js';
import { photoSurface } from '../render/photosets.js';
import { WEAPONS } from '../combat/weapons.js';

export const CHEST_RADIUS = 2.6;      // how close the player must stand to open
export const LID_TIME = 0.55;         // seconds for the lid to swing fully open
export const CHEST_LINGER = 1.4;      // seconds an opened chest stays visible

/**
 * Nearest a chest may spawn to the player. Low enough that the first one is
 * findable on foot during the opening lull, far enough that it is still
 * somewhere you go rather than something you trip over.
 */
export const MIN_SPAWN_DIST = 14;

// Beacon tuning. The arena is 160 blocks across and the fog starts at 85, so a
// short dim column is invisible from anywhere worth standing -- this is sized
// against the infinity stones' beam, which is what players already read as
// "something is over there".
const BEAM_HEIGHT = 20;
const BEAM_RADIUS = 0.28;
const BEAM_OPACITY = 0.3;
const LIGHT_INTENSITY = 2.6;

/** Every actual firearm/design gun, excluding melee and the airstrike designator. */
export const CHEST_GUN_IDS = Object.freeze(WEAPONS
  .filter((weapon) => !weapon.melee && !weapon.designator)
  .map((weapon) => weapon.id));

/** One weight for every weapon roll until rarity is deliberately designed. */
export const CHEST_WEAPON_WEIGHT = 10;

/**
 * Weighted loot table. Every gun has exactly the same selection weight for
 * now—including the pistol, hand cannon, railgun, minigun and flamethrower.
 * Knife and airstrike were already chest rewards; they remain available at the
 * same weapon weight, but are deliberately not described as guns (airstrike is
 * a designator and knife is melee). Support-item weights are unchanged.
 */
export const CHEST_LOOT = [
  ...CHEST_GUN_IDS.map((id) => ({ type: 'weapon', id, weight: CHEST_WEAPON_WEIGHT })),
  { type: 'weapon', id: 'knife', weight: CHEST_WEAPON_WEIGHT },
  { type: 'weapon', id: 'airstrike', weight: CHEST_WEAPON_WEIGHT },
  // --- support ---
  { type: 'potion', weight: 22 },
  { type: 'map', weight: 12 },
  { type: 'ammo', weight: 14 },
];

const TOTAL_WEIGHT = CHEST_LOOT.reduce((sum, e) => sum + e.weight, 0);

/** One weighted draw from the table. */
function drawLoot(rng) {
  let roll = rng() * TOTAL_WEIGHT;
  for (const entry of CHEST_LOOT) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return CHEST_LOOT[0];
}

/**
 * Roll a chest's contents: usually one item, sometimes two.
 * @returns {Array<{type: string, id?: string}>}
 */
export function rollChestLoot(rng = Math.random) {
  const count = rng() < 0.3 ? 2 : 1;
  const loot = [];
  for (let i = 0; i < count; i++) loot.push(drawLoot(rng));
  return loot;
}

let PROTO = null;

function buildProto() {
  const g = new THREE.Group();

  // Painted steel where the art pack has it, flat colour where it does not.
  //
  // The chest keeps its shape and its gold straps on purpose. Those straps are
  // not decoration -- the comment above is the whole reason they exist: the
  // arena is full of crates, and the one you can open has to be tellable from
  // the ones you cannot at a glance. Swapping the box for a military crate model
  // would have made the readable object look like all the unreadable ones.
  // Giving it a real painted-steel surface fixes the flatness without touching
  // the silhouette that does the work.
  const skin = photoSurface('milgreen');
  const woodMat = skin
    ? new THREE.MeshStandardMaterial({
        map: skin.map,
        normalMap: skin.normalMap,
        aoMap: skin.armMap,
        roughnessMap: skin.armMap,
        roughness: 1,
        metalness: 0.35,
        emissive: 0x0d0a04,
      })
    : new THREE.MeshLambertMaterial({ color: 0x6b4526, emissive: 0x1a0e05 });
  const goldMat = new THREE.MeshLambertMaterial({ color: 0xe8b34a, emissive: 0x4a3208 });

  // ---- body ----
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.55, 0.66), woodMat);
  body.position.y = 0.275;
  body.castShadow = true;
  g.add(body);

  // Gold straps down the sides, so the silhouette reads as treasure and not as
  // one more crate -- the arena is already full of crates.
  for (const sx of [-0.31, 0.31]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.58, 0.69), goldMat);
    strap.position.set(sx, 0.275, 0);
    g.add(strap);
  }

  // ---- lid ----
  // Pivoted at the back top edge so it swings up and away from the player.
  const lidPivot = new THREE.Group();
  lidPivot.position.set(0, 0.55, -0.33);
  lidPivot.name = 'lid';
  g.add(lidPivot);

  const lid = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.26, 0.66), woodMat);
  lid.position.set(0, 0.13, 0.33);
  lid.castShadow = true;
  lidPivot.add(lid);

  for (const sx of [-0.31, 0.31]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.29, 0.69), goldMat);
    strap.position.set(sx, 0.13, 0.33);
    lidPivot.add(strap);
  }

  const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.22, 0.1), goldMat);
  clasp.position.set(0, 0.02, 0.66);
  lidPivot.add(clasp);

  // ---- beacon ----
  // Same language as the weapon pickups and the stones: a soft additive column
  // that survives being seen across the arena and through bloom.
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS, BEAM_HEIGHT, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffd070, transparent: true, opacity: BEAM_OPACITY,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  beam.position.y = BEAM_HEIGHT * 0.46;
  beam.name = 'beam';
  g.add(beam);

  // No point light. Every chest carrying its own light meant the scene's light
  // count changed each time one spawned or was cleaned up, and in three.js that
  // recompiles every material in the scene -- a ~40ms stall, which is what the
  // stutter around chests actually was. The additive beam plus bloom carries the
  // beacon on its own.

  return g;
}

export class Chest {
  constructor(x, y, z, yaw = 0) {
    this.x = x; this.y = y; this.z = z;
    this.opened = false;
    this.done = false;          // true once it has finished its open animation
    this.openT = 0;             // 0 shut, 1 fully open
    this.linger = CHEST_LINGER;
    this.phase = Math.random() * Math.PI * 2;

    if (!PROTO) PROTO = buildProto();
    this.mesh = PROTO.clone();
    this.mesh.position.set(x, y, z);
    this.mesh.rotation.y = yaw;

    // Object3D.clone() round-trips userData through JSON, so object references
    // stored there do not survive. Resolve the animated parts by name instead.
    this.lid = this.mesh.getObjectByName('lid');
    this.beam = this.mesh.getObjectByName('beam');
    // clone() shares materials, and each chest fades its own beacon, so this
    // one needs an instance of its own or every chest would dim together.
    this.beam.material = this.beam.material.clone();
  }

  update(dt) {
    this.phase += dt;

    if (!this.opened) {
      // Breathing glow while shut, so a chest tucked behind terrain still
      // catches the eye.
      const pulse = 0.8 + Math.sin(this.phase * 2.2) * 0.25;
      this.beam.material.opacity = BEAM_OPACITY * pulse;
      return;
    }

    if (this.openT < 1) {
      this.openT = Math.min(1, this.openT + dt / LID_TIME);
      // Ease out, with a touch of overswing at the end -- a lid that stops dead
      // on its mark looks like a menu animation rather than a hinge.
      const e = 1 - Math.pow(1 - this.openT, 3);
      this.lid.rotation.x = -(e * 1.95 + Math.sin(this.openT * Math.PI) * 0.12);
    }

    // Fade the beacon out once looted; a spent chest should stop advertising.
    this.linger -= dt;
    const k = Math.max(0, this.linger / CHEST_LINGER);
    this.beam.material.opacity = BEAM_OPACITY * k;
    if (this.linger <= 0) this.done = true;
  }

  /**
   * Release the one material this chest owns. Everything else is shared with
   * the prototype and must outlive it.
   */
  dispose() {
    this.beam.material.dispose();
  }

  /** True when the player is standing close enough to open it. */
  inRange(player) {
    const dx = player.pos.x - this.x;
    const dz = player.pos.z - this.z;
    const dy = (player.pos.y + player.height * 0.5) - (this.y + 0.5);
    return dx * dx + dz * dz < CHEST_RADIUS * CHEST_RADIUS && Math.abs(dy) < 3;
  }

  /**
   * Crack it open.
   * @returns the rolled loot, or null if it was already opened.
   */
  open(rng = Math.random) {
    if (this.opened) return null;
    this.opened = true;
    return rollChestLoot(rng);
  }
}

/**
 * Scatter chests across the arena.
 *
 * Same placement rules as the infinity stones -- off the spawn plaza, spread
 * apart, on open ground -- plus a check against `avoid`, so a chest never spawns
 * on top of a stone and hides it inside the lid.
 *
 * @param avoid array of {x, z} the chests should keep clear of
 */
export function placeChests(world, avoidX, avoidZ, count, avoid = []) {
  const chests = [];
  const minApart = world.size * 0.085;

  for (let i = 0; i < count; i++) {
    let best = null;
    for (let attempt = 0; attempt < 300; attempt++) {
      const x = 10 + Math.random() * (world.size - 20);
      const z = 10 + Math.random() * (world.size - 20);

      // Far enough out that a chest is something you go and find.
      if (Math.hypot(x - avoidX, z - avoidZ) < MIN_SPAWN_DIST) continue;

      let clash = false;
      for (const c of chests) {
        if (Math.hypot(x - c.x, z - c.z) < minApart) { clash = true; break; }
      }
      for (const a of avoid) {
        if (Math.hypot(x - a.x, z - a.z) < 4) { clash = true; break; }
      }
      if (clash) continue;

      // Must sit on ground you can walk to, and clear of trees and rubble.
      if (!world.isWalkable(x, z)) continue;
      let inProp = false;
      for (const pr of world.propsNear(x, z, 2.5, [])) {
        const c = pr.collider;
        const d = c.kind === 'box'
          ? Math.hypot(Math.max(c.minX - x, 0, x - c.maxX), Math.max(c.minZ - z, 0, z - c.maxZ))
          : Math.hypot(x - c.x, z - c.z) - c.r;
        if (d < 1.8) { inProp = true; break; }
      }
      if (inProp) continue;

      best = { x, y: world.heightAt(x, z), z };
      break;
    }
    // A chest that cannot be placed is simply skipped -- unlike the stones,
    // nothing downstream requires a fixed count.
    if (!best) continue;
    chests.push(new Chest(best.x, best.y, best.z, Math.random() * Math.PI * 2));
  }

  return chests;
}
