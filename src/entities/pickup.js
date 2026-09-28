// Ground drops: a spinning, bobbing item the player walks over to collect.
//
// Pickups are deliberately loud -- a beacon of light plus motion -- because a
// rare drop the player never notices may as well not exist.
//
// Three kinds share the class because they share all their behaviour (bob,
// spin, expire, collect); only the model and the beacon colour differ, so the
// variation lives in a prototype table rather than in subclasses.

import * as THREE from '../../vendor/three.module.js';
import { WEAPONS, tierOf } from '../combat/weapons.js';
import { BUILDERS } from '../render/viewmodel.js';

export const PICKUP_RADIUS = 1.9;
export const PICKUP_LIFETIME = 45;
/** Chest loot lingers longer -- you may still be fighting when it lands. */
export const LOOT_LIFETIME = 75;

export const PICKUP_WEAPON = 'weapon';
export const PICKUP_POTION = 'potion';
export const PICKUP_MAP = 'map';

const PROTOS = new Map();

/**
 * Clone the exact model the armoury is rendering, but detach it from viewmodel
 * state before it is fitted to the world pickup.
 *
 * Geometry and materials get their own copies because the viewmodel disposes
 * its current model whenever a finish changes. Textures remain shared: they
 * are immutable assets and are by far the expensive part.
 */
function cloneWeaponForPickup(source) {
  const weapon = source.clone(true);
  const materials = new Map();
  weapon.traverse((part) => {
    if (!part.isMesh) return;
    part.geometry = part.geometry?.clone();
    const cloneMaterial = (material) => {
      if (!material) return material;
      if (!materials.has(material)) materials.set(material, material.clone());
      return materials.get(material);
    };
    part.material = Array.isArray(part.material)
      ? part.material.map(cloneMaterial) : cloneMaterial(part.material);
  });

  // Viewmodels carry their current hip/ADS pose on the root. Ground loot needs
  // only the authored weapon-space model.
  weapon.position.set(0, 0, 0);
  weapon.quaternion.identity();
  weapon.scale.set(1, 1, 1);
  weapon.visible = true;
  return weapon;
}

/** Additive glow column plus a point light, shared by every pickup kind. */
function addBeacon(g, color, radius = 0.16, height = 6) {
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  beam.position.y = height * 0.43;
  g.add(beam);

  // No point light. Pickups spawn and vanish constantly, so this was the worst
  // offender of the lot: every drop and every collect recompiled the scene.
}

function buildWeaponProto(weaponId, renderedModel = null) {
  const g = new THREE.Group();

  const builder = BUILDERS[weaponId];
  if (renderedModel || builder) {
    // The prize is the prize. Use the model the armoury actually resolved for
    // this run (downloaded asset, current materials and all), rather than
    // rebuilding the old procedural stand-in beside it.
    const weapon = renderedModel ? cloneWeaponForPickup(renderedModel) : builder();

    // The procedural fallback is a first-person model and some older builders
    // include round glove/forearm masses. Those are useful in hand and look like
    // detached black blobs on the floor, so they never belong to ground loot.
    const hands = weapon.getObjectByName('hands');
    hands?.parent?.remove(hands);

    weapon.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(weapon);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const fit = 1.05 / Math.max(size.x, size.y, size.z, 0.001);
    weapon.scale.setScalar(fit);
    weapon.position.set(-centre.x * fit, -box.min.y * fit - 0.08, -centre.z * fit);
    weapon.name = `loot-weapon:${weaponId}`;
    g.add(weapon);

    const def = WEAPONS.find((candidate) => candidate.id === weaponId);
    const color = tierOf(def).hex;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.44, 0.018, 6, 28),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.72,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.12;
    g.add(ring);
    addBeacon(g, color);
    g.userData.weaponModel = weaponId;
    g.userData.weaponAsset = renderedModel
      ? (renderedModel.userData.external ? 'downloaded' : 'viewmodel')
      : 'procedural';
    return g;
  }

  // The airstrike designator has no physical viewmodel. It keeps the supply
  // case fallback rather than pretending some unrelated gun is the reward.
  const crate = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 0.4, 0.55),
    new THREE.MeshLambertMaterial({ color: 0x4c6a45, emissive: 0x16250f }),
  );
  g.add(crate);

  // Bands, so it reads as a supply crate rather than a plain cube.
  const bandMat = new THREE.MeshLambertMaterial({ color: 0xd9b45f, emissive: 0x3a2c08 });
  const bandA = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.09, 0.58), bandMat);
  bandA.position.y = 0.1;
  g.add(bandA);
  const bandB = bandA.clone();
  bandB.position.y = -0.1;
  g.add(bandB);

  addBeacon(g, 0xffd070);
  return g;
}

/**
 * Make future pickups use the model already resolved by the live viewmodel.
 * Existing pickup prototypes are replaced without disposing them because live
 * drops may still share their geometry.
 */
export function installPickupWeaponModel(weaponId, renderedModel) {
  if (!weaponId || !renderedModel) return false;
  PROTOS.set(`${PICKUP_WEAPON}:${weaponId}`, buildWeaponProto(weaponId, renderedModel));
  return true;
}

/** A stubby flask, tinted to whatever perk it carries. */
function buildPotionProto(color) {
  const g = new THREE.Group();

  const glass = new THREE.MeshLambertMaterial({
    color, emissive: color, emissiveIntensity: 0.7,
    transparent: true, opacity: 0.9,
  });

  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.23, 0), glass);
  body.position.y = -0.04;
  g.add(body);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, 0.18, 6), glass);
  neck.position.y = 0.2;
  g.add(neck);

  const cork = new THREE.Mesh(
    new THREE.CylinderGeometry(0.085, 0.085, 0.09, 6),
    new THREE.MeshLambertMaterial({ color: 0xa8794a, emissive: 0x2a1a08 }),
  );
  cork.position.y = 0.32;
  g.add(cork);

  addBeacon(g, color, 0.13);
  return g;
}

/** A rolled scroll with gold end caps. */
function buildMapProto() {
  const g = new THREE.Group();

  const paper = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.14, 0.62, 8),
    new THREE.MeshLambertMaterial({ color: 0xe6d3a3, emissive: 0x3a3020 }),
  );
  paper.rotation.z = Math.PI / 2;
  g.add(paper);

  const capMat = new THREE.MeshLambertMaterial({ color: 0xe8b34a, emissive: 0x4a3208 });
  for (const sx of [-0.33, 0.33]) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.07, 8), capMat);
    cap.rotation.z = Math.PI / 2;
    cap.position.x = sx;
    g.add(cap);
  }

  // Ribbon around the middle, so a scroll is not mistaken for a rolled rug.
  const ribbon = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.08, 8), capMat);
  ribbon.rotation.z = Math.PI / 2;
  g.add(ribbon);

  addBeacon(g, 0xffe6a0, 0.13);
  return g;
}

/** Prototypes are cached per (kind, colour) so cloning stays cheap. */
function protoFor(spec) {
  const variant = spec.type === PICKUP_POTION ? spec.color
    : spec.type === PICKUP_WEAPON ? spec.kind : '';
  const key = `${spec.type}:${variant}`;
  if (!PROTOS.has(key)) {
    if (spec.type === PICKUP_POTION) PROTOS.set(key, buildPotionProto(spec.color));
    else if (spec.type === PICKUP_MAP) PROTOS.set(key, buildMapProto());
    else PROTOS.set(key, buildWeaponProto(spec.kind));
  }
  return PROTOS.get(key);
}

export class Pickup {
  /**
   * @param spec {type, kind, color?, target?, lifetime?}
   *   kind   -- weapon id or potion id
   *   target -- for maps, the stone id the map leads to
   */
  constructor(spec, x, y, z) {
    this.type = spec.type;
    this.kind = spec.kind ?? null;
    this.color = spec.color ?? 0xffd070;
    this.target = spec.target ?? null;
    this.x = x; this.y = y; this.z = z;
    this.life = spec.lifetime ?? PICKUP_LIFETIME;
    this.taken = false;
    this.phase = Math.random() * Math.PI * 2;
    this.eject = spec.ejectFrom ? {
      x: spec.ejectFrom.x, y: spec.ejectFrom.y, z: spec.ejectFrom.z,
      time: 0, duration: 0.62,
    } : null;

    this.mesh = protoFor(spec).clone();
    this.mesh.position.set(
      this.eject?.x ?? x,
      this.eject?.y ?? y + 0.5,
      this.eject?.z ?? z,
    );
  }

  /** Replace a live drop after the armoury's rendered model finishes loading. */
  refreshWeaponVisual() {
    if (this.type !== PICKUP_WEAPON) return false;
    const previous = this.mesh;
    const next = protoFor({ type: this.type, kind: this.kind }).clone();
    next.position.copy(previous.position);
    next.quaternion.copy(previous.quaternion);
    next.scale.copy(previous.scale);
    next.visible = previous.visible;
    if (previous.parent) {
      previous.parent.add(next);
      previous.parent.remove(previous);
    }
    this.mesh = next;
    return true;
  }

  update(dt) {
    this.life -= dt;
    this.phase += dt;
    this.mesh.rotation.y = this.phase * 1.5;

    if (this.eject) {
      const launch = this.eject;
      launch.time = Math.min(launch.duration, launch.time + dt);
      const t = launch.time / launch.duration;
      const travel = 1 - (1 - t) ** 2;
      this.mesh.position.x = launch.x + (this.x - launch.x) * travel;
      this.mesh.position.z = launch.z + (this.z - launch.z) * travel;
      this.mesh.position.y = launch.y + (this.y + 0.55 - launch.y) * travel
        + Math.sin(t * Math.PI) * 1.25;
      this.mesh.rotation.z = Math.sin(t * Math.PI) * 0.38;
      if (t >= 1) {
        this.eject = null;
        this.mesh.rotation.z = 0;
      }
    } else {
      this.mesh.position.y = this.y + 0.55 + Math.sin(this.phase * 2.2) * 0.12;
    }

    // Blink out over the last few seconds so expiry is never a surprise.
    if (this.life < 5) this.mesh.visible = Math.sin(this.life * 14) > -0.35;
    return this.life > 0;
  }

  /** True when the player is close enough to collect. */
  inRange(player) {
    if (this.eject) return false;
    const dx = player.pos.x - this.x;
    const dz = player.pos.z - this.z;
    const dy = (player.pos.y + player.height * 0.5) - (this.y + 0.5);
    return dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS && Math.abs(dy) < 2.5;
  }
}

let ROCKET_PROTO = null;

/** Small glowing shell with a trail-friendly shape, used for rockets in flight. */
export function buildRocketMesh() {
  if (!ROCKET_PROTO) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.14, 0.44),
      new THREE.MeshLambertMaterial({ color: 0x8a3a2a, emissive: 0x481109 }),
    );
    g.add(body);
    const flame = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.1, 0.3),
      new THREE.MeshBasicMaterial({
        color: 0xffc766, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    flame.position.z = 0.34;
    g.add(flame);
    // No light on the rocket either -- one recompile per shot fired.
    ROCKET_PROTO = g;
  }
  return ROCKET_PROTO.clone();
}
