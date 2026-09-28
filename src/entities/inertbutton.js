// The important-looking button that deliberately does nothing.
//
// This entity is kept outside World.props on purpose.  World props are the
// shared collision contract used by players, bullets, navigation and line of
// sight; registering a joke prop there would make it affect the simulation even
// if its click handler were empty.  The button instead has a small analytic
// look target and a render-only press animation.

import * as THREE from '../../vendor/three.module.js';
import { MAP_COMPLEX, PROP_WALLSEG } from '../world/world.js';

export const INERT_BUTTON_MODEL = 'critical_button-v2';
export const INERT_BUTTON_RANGE = 2.6;

const PRESS_IN = 0.065;
const PRESS_HOLD = 0.04;
const PRESS_OUT = 0.22;
export const INERT_BUTTON_PRESS_TIME = PRESS_IN + PRESS_HOLD + PRESS_OUT;

const PRESS_DEPTH = 0.085;
const WALL_GAP = 0.012;
const OCCLUSION_EPSILON = 0.035;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (v) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

/**
 * Choose one stable piece of the start room wall and describe its room-facing
 * surface.  Nothing is added to the world and no random number is consumed.
 *
 * A full-height panel is preferred.  Windowed layouts occasionally have no
 * suitable full panel in the start room, in which case the solid sill below a
 * window is used and the art is made shorter to fit it.
 */
export function findInertButtonMount(world) {
  if (!world || world.mapId !== MAP_COMPLEX || !world.plan || !Array.isArray(world.props)) {
    return null;
  }

  const room = world.plan.rooms?.find((candidate) => candidate.id === world.plan.start);
  if (!room) return null;

  const walls = world.props.filter((prop) => {
    const c = prop.collider;
    return prop.type === PROP_WALLSEG
      && prop.room === room.id
      && !prop.secret
      && c?.kind === 'box'
      && Math.abs(prop.y - room.floorY) <= 0.08
      && Math.max(prop.sx ?? 0, prop.sz ?? 0) >= 1.2
      && (prop.sy ?? 0) >= 0.65;
  });

  const order = (a, b) => {
    const spanA = Math.max(a.sx, a.sz), spanB = Math.max(b.sx, b.sz);
    return spanB - spanA || a.x - b.x || a.z - b.z || a.sy - b.sy;
  };
  const full = walls.filter((prop) => prop.sy >= 2.4).sort(order);
  const lower = walls
    .filter((prop) => prop.y + prop.sy >= room.floorY + 0.9)
    .sort(order);
  const wall = full[0] ?? lower[0];
  if (!wall) return null;

  const c = wall.collider;
  const alongX = wall.sx >= wall.sz;
  let nx = 0, nz = 0, x = wall.x, z = wall.z;
  if (alongX) {
    nz = room.cz >= wall.z ? 1 : -1;
    z = nz > 0 ? c.maxZ : c.minZ;
  } else {
    nx = room.cx >= wall.x ? 1 : -1;
    x = nx > 0 ? c.maxX : c.minX;
  }

  const lowMount = wall.sy < 2.4;
  x += nx * WALL_GAP;
  z += nz * WALL_GAP;

  return {
    x,
    y: room.floorY + (lowMount ? 0.5 : 1.35),
    z,
    nx,
    nz,
    // Local +Z points off the wall and into the room.
    yaw: Math.atan2(nx, nz),
    roomId: room.id,
    wall,
    lowMount,
  };
}

function asObject3D(model) {
  const object = model?.scene ?? model;
  return object?.isObject3D ? object : null;
}

/** Add geometry/material to an entity-owned disposal set. */
function owned(entity, object) {
  if (object.geometry) entity._ownedGeometry.add(object.geometry);
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) if (material) entity._ownedMaterials.add(material);
  return object;
}

function shadowMeshes(root) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
}

/**
 * Clone and centre loaded art without taking ownership of its materials.
 * THREE.Object3D.clone intentionally shares geometry and material resources,
 * so disposing this entity must not invalidate the model cache.
 */
function attachLoadedModel(entity, model) {
  const source = asObject3D(model);
  if (!source) return false;

  let visual;
  try {
    visual = source.clone(true);
  } catch {
    return false;
  }

  // The downloaded emergency stop is authored for a horizontal control deck:
  // its +Y axis is the plunger travel.  Turn that axis out of the wall so the
  // same model reads correctly as a vertical wall-mounted control.
  visual.rotation.x = Math.PI / 2;
  visual.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(visual);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  if (![size.x, size.y, size.z, center.x, center.y, center.z].every(Number.isFinite)
      || Math.max(size.x, size.y, size.z) <= 1e-6) {
    return false;
  }

  const fitWidth = 1.2;
  const fitHeight = entity.lowMount ? 0.75 : 1.05;
  const fitDepth = 0.42;
  const scale = Math.min(
    fitWidth / Math.max(size.x, 1e-6),
    fitHeight / Math.max(size.y, 1e-6),
    fitDepth / Math.max(size.z, 1e-6),
  );

  const centred = new THREE.Group();
  centred.position.set(-center.x, -center.y, -center.z);
  centred.add(visual);

  const holder = new THREE.Group();
  holder.name = 'loaded-button-model';
  holder.scale.setScalar(scale);
  holder.position.z = 0.018 + size.z * scale / 2;
  holder.add(centred);
  shadowMeshes(visual);
  entity.mesh.add(holder);

  entity.modelRoot = holder;
  entity.usesLoadedModel = true;
  entity._housingFront = holder.position.z + size.z * scale / 2;
  return true;
}

function addProceduralHousing(entity) {
  const height = entity.lowMount ? 0.72 : 1.06;
  const width = entity.lowMount ? 1.12 : 1.24;

  const backMat = new THREE.MeshStandardMaterial({
    color: 0xf0b719, roughness: 0.58, metalness: 0.46,
    emissive: 0x321d00, emissiveIntensity: 0.42,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x161b20, roughness: 0.43, metalness: 0.78,
  });
  const boltMat = new THREE.MeshStandardMaterial({
    color: 0xb8c1c7, roughness: 0.28, metalness: 0.92,
  });

  const back = owned(entity, new THREE.Mesh(
    new THREE.BoxGeometry(width, height, 0.09), backMat,
  ));
  back.position.z = 0.045;
  back.castShadow = back.receiveShadow = true;
  entity.mesh.add(back);

  const casing = owned(entity, new THREE.Mesh(
    new THREE.BoxGeometry(width - 0.18, height - 0.18, 0.24), darkMat,
  ));
  casing.position.z = 0.165;
  casing.castShadow = casing.receiveShadow = true;
  entity.mesh.add(casing);

  // Chunky yellow edge blocks give the fallback the same emergency-equipment
  // silhouette as the bundled art without requiring a generated texture.
  const stripeH = 0.075;
  const blocks = 7;
  for (let i = 0; i < blocks; i++) {
    if (i % 2 === 0) continue;
    const stripe = owned(entity, new THREE.Mesh(
      new THREE.BoxGeometry(width / blocks + 0.01, stripeH, 0.018), darkMat,
    ));
    stripe.position.set(-width / 2 + (i + 0.5) * width / blocks, height / 2 - stripeH / 2, 0.101);
    entity.mesh.add(stripe);

    const lower = owned(entity, stripe.clone());
    // clone() shares resources already in the owned sets, which is intentional.
    lower.position.y = -height / 2 + stripeH / 2;
    entity.mesh.add(lower);
  }

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const bolt = owned(entity, new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 0.025, 10), boltMat,
      ));
      bolt.rotation.x = Math.PI / 2;
      bolt.position.set(sx * (width / 2 - 0.08), sy * (height / 2 - 0.08), 0.112);
      entity.mesh.add(bolt);
    }
  }

  entity._housingFront = 0.285;
}

function addPressOverlay(entity) {
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x7b858d, roughness: 0.22, metalness: 0.93,
    emissive: 0x171a1c, emissiveIntensity: 0.25,
  });
  const capMat = new THREE.MeshStandardMaterial({
    color: 0xe51b23, roughness: 0.24, metalness: 0.38,
    emissive: 0x7b0004, emissiveIntensity: 0.75,
  });
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xffbd31, roughness: 0.3, metalness: 0.22,
    emissive: 0xff6a00, emissiveIntensity: 1.25,
  });

  const ring = owned(entity, new THREE.Mesh(
    new THREE.TorusGeometry(0.36, 0.047, 10, 32), ringMat,
  ));
  ring.name = 'inert-button-ring';
  ring.position.z = entity._housingFront + 0.035;
  entity.mesh.add(ring);

  const cap = owned(entity, new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.325, 0.13, 32), capMat,
  ));
  cap.name = 'inert-button-cap';
  cap.rotation.x = Math.PI / 2;
  cap.position.z = entity._housingFront + 0.105;
  cap.castShadow = true;
  entity.mesh.add(cap);

  // A glowing pilot lamp sells importance without adding a dynamic light (and
  // therefore without changing the renderer's light count or shader variants).
  const lamp = owned(entity, new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 12, 8), lampMat,
  ));
  lamp.name = 'inert-button-pilot';
  lamp.position.set(0, entity.lowMount ? 0.275 : 0.43, entity._housingFront + 0.075);
  entity.mesh.add(lamp);

  entity.ring = ring;
  entity.cap = cap;
  entity.pilot = lamp;
  entity._capRestZ = cap.position.z;
  entity._ringRestZ = ring.position.z;
  entity._targetZ = cap.position.z + 0.065;
  entity._capMaterial = capMat;
  entity._ringMaterial = ringMat;
  entity._pilotMaterial = lampMat;
}

export class InertButton {
  /**
   * Build synchronously from a mount.  Pass already-loaded art as `model`, or
   * use createInertButton() to load the bundled model with a procedural fallback.
   */
  constructor(mount, { model = null } = {}) {
    if (!mount) throw new TypeError('InertButton requires a wall mount');

    this.mount = mount;
    this.lowMount = !!mount.lowMount;
    this.usesLoadedModel = false;
    this.modelRoot = null;
    this._ownedGeometry = new Set();
    this._ownedMaterials = new Set();
    this._pressAge = INERT_BUTTON_PRESS_TIME;
    this._pressing = false;
    this._idleTime = 0;
    this.disposed = false;

    this.mesh = new THREE.Group();
    this.mesh.name = 'inert-important-button';
    this.mesh.userData.kind = 'inert-button';
    this.mesh.position.set(mount.x, mount.y, mount.z);
    this.mesh.rotation.y = mount.yaw;

    if (!attachLoadedModel(this, model)) addProceduralHousing(this);
    addPressOverlay(this);

    this._targetHalfWidth = this.lowMount ? 0.58 : 0.65;
    this._targetHalfHeight = this.lowMount ? 0.4 : 0.58;
  }

  /** Synchronous convenience when art has already been loaded. */
  static fromWorld(world, options = {}) {
    const mount = findInertButtonMount(world);
    return mount ? new InertButton(mount, options) : null;
  }

  /** Async convenience matching createInertButton(). */
  static create(world, options = {}) {
    return createInertButton(world, options);
  }

  /**
   * Is the player's view ray inside the button face and unobstructed?
   *
   * This is intentionally analytic: the decorative model is never installed as
   * a collider or raycast prop.  An existing wall/prop may hide it, but the
   * button itself can never stop a player, bullet, enemy or line-of-sight test.
   */
  targetedBy(player, world, maxRange = INERT_BUTTON_RANGE) {
    if (this.disposed || !player?.pos || typeof player.getLookDir !== 'function') return false;

    const ox = Number(player.pos.x), oz = Number(player.pos.z);
    const oy = Number.isFinite(player.eyeY)
      ? player.eyeY
      : Number(player.pos.y) + (Number.isFinite(player.height) ? player.height * 0.91 : 1.64);
    const dir = player.getLookDir({});
    const length = Math.hypot(dir?.x ?? 0, dir?.y ?? 0, dir?.z ?? 0);
    if (![ox, oy, oz, length, maxRange].every(Number.isFinite) || length <= 1e-8 || maxRange <= 0) {
      return false;
    }

    const dx = dir.x / length, dy = dir.y / length, dz = dir.z / length;
    const cx = this.mount.x + this.mount.nx * this._targetZ;
    const cy = this.mount.y;
    const cz = this.mount.z + this.mount.nz * this._targetZ;
    const denominator = dx * this.mount.nx + dz * this.mount.nz;
    // The room-facing side is the only side that can be pressed.
    if (denominator >= -1e-6) return false;

    const distance = ((cx - ox) * this.mount.nx + (cz - oz) * this.mount.nz) / denominator;
    if (!Number.isFinite(distance) || distance <= 0 || distance > maxRange) return false;

    const hx = ox + dx * distance, hy = oy + dy * distance, hz = oz + dz * distance;
    const tangentX = -this.mount.nz, tangentZ = this.mount.nx;
    const horizontal = (hx - cx) * tangentX + (hz - cz) * tangentZ;
    if (Math.abs(horizontal) > this._targetHalfWidth || Math.abs(hy - cy) > this._targetHalfHeight) {
      return false;
    }

    if (typeof world?.raycast === 'function' && distance > OCCLUSION_EPSILON) {
      const clearDistance = distance - OCCLUSION_EPSILON;
      const hit = world.raycast(ox, oy, oz, dx, dy, dz, clearDistance);
      if (hit?.hit && (!Number.isFinite(hit.distance) || hit.distance <= clearDistance + 1e-6)) {
        return false;
      }
    }
    return true;
  }

  isTargeted(player, world, maxRange = INERT_BUTTON_RANGE) {
    return this.targetedBy(player, world, maxRange);
  }

  /** Restart the tiny local press animation.  There is no callback by design. */
  press() {
    if (this.disposed) return false;
    this._pressAge = 0;
    this._pressing = true;
    this._applyPressPose(0);
    return true;
  }

  update(dt) {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return;
    this._idleTime += dt;

    let amount = 0;
    if (this._pressing) {
      this._pressAge += dt;
      if (this._pressAge < PRESS_IN) {
        amount = smoothstep(this._pressAge / PRESS_IN);
      } else if (this._pressAge < PRESS_IN + PRESS_HOLD) {
        amount = 1;
      } else if (this._pressAge < INERT_BUTTON_PRESS_TIME) {
        amount = 1 - smoothstep((this._pressAge - PRESS_IN - PRESS_HOLD) / PRESS_OUT);
      } else {
        this._pressAge = INERT_BUTTON_PRESS_TIME;
        this._pressing = false;
      }
    }
    this._applyPressPose(amount);
  }

  reset() {
    if (this.disposed) return;
    this._pressAge = INERT_BUTTON_PRESS_TIME;
    this._pressing = false;
    this._idleTime = 0;
    this._applyPressPose(0);
  }

  _applyPressPose(amount) {
    this.cap.position.z = this._capRestZ - PRESS_DEPTH * amount;
    this.ring.position.z = this._ringRestZ - PRESS_DEPTH * amount * 0.18;
    const ringScale = 1 + amount * 0.055;
    this.ring.scale.setScalar(ringScale);
    this._capMaterial.emissiveIntensity = 0.75 + amount * 1.85;
    this._ringMaterial.emissiveIntensity = 0.25 + amount * 0.45;
    this._pilotMaterial.emissiveIntensity = 1.15
      + Math.sin(this._idleTime * 3.2) * 0.12
      + amount * 1.25;
  }

  /** Dispose only resources created by this instance, never shared GLB art. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this._ownedGeometry) geometry.dispose();
    for (const material of this._ownedMaterials) material.dispose();
    this._ownedGeometry.clear();
    this._ownedMaterials.clear();
  }
}

// A friendlier name for callers that want to use the gag in UI copy without
// changing the deliberately explicit implementation name.
export { InertButton as ImportantButton };

/**
 * Create the button and best-effort load its bundled GLB.  Tests and custom
 * bundles can inject `loadModel`; pass false for an immediate procedural build.
 */
export async function createInertButton(world, {
  model = null,
  modelName = INERT_BUTTON_MODEL,
  loadModel = undefined,
} = {}) {
  const mount = findInertButtonMount(world);
  if (!mount) return null;

  let art = model;
  if (!art && loadModel !== false) {
    try {
      const loader = typeof loadModel === 'function'
        ? loadModel
        : (await import('../render/models.js')).loadModel;
      art = await loader(modelName);
    } catch {
      // Missing/corrupt art is a visual downgrade, never a game-load failure.
      art = null;
    }
  }
  return new InertButton(mount, { model: art });
}
