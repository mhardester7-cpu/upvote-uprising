// The chicken-nugget dispenser: a permanent, local healing station in the
// complex's start room.
//
// Its collider is authored with the furniture in world/buildings.js, so the
// server, navigation, bullets and every client agree on its footprint. This
// file owns only the detailed art, interaction state and serving animation.
// Like chests and potions, the serving is instanced per player: in co-op nobody
// can consume another player's cooldown or race them to the tray.

import * as THREE from '../../vendor/three.module.js';
import { MAP_COMPLEX, PROP_FURNITURE } from '../world/world.js';
import { photoSurface } from '../render/photosets.js';

export const NUGGET_DISPENSER_KIND = 'nugget_dispenser';
export const NUGGET_DISPENSER_RANGE = 2.65;
export const NUGGET_HEAL = 25;
export const NUGGET_COUNT = 6;
export const NUGGET_RESTOCK = 30;
export const MAX_FLOOR_NUGGETS = 96;
export const NUGGET_PHOTO = 'assets/textures/chicken_nuggets/chicken_nuggets.webp';

const SERVE_TIME = 2.45;
const FLAP_OPEN_TIME = 0.48;
const NUGGET_FLOOR_Y = 0.095;
const NUGGET_GRAVITY = 9.81;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (v) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

/** The collider record generated into this world's start room. */
export function findNuggetDispenserProp(world) {
  if (!world || world.mapId !== MAP_COMPLEX || !Array.isArray(world.props)) return null;
  return world.props.find((prop) => prop.type === PROP_FURNITURE
    && prop.kind === NUGGET_DISPENSER_KIND) ?? null;
}

function loadPhotoTexture() {
  // TextureLoader needs a browser Image implementation. Tests and stripped art
  // bundles take the amber sign fallback and keep the full gameplay feature.
  if (typeof Image === 'undefined') return null;
  try {
    const texture = new THREE.TextureLoader().load(NUGGET_PHOTO);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  } catch {
    return null;
  }
}

function nuggetGeometry(seed) {
  // A softly bevelled, irregular puck reads like formed breaded chicken. A
  // sphere reads like a potato and the old low-poly icosahedron read like a
  // glowing rock, however good its texture was. These three deterministic
  // outlines keep the stock from looking cloned while sharing one licensed
  // photorealistic food image for the crumb surface.
  const points = [];
  const count = 10;
  for (let i = 0; i < count; i++) {
    const a = i / count * Math.PI * 2;
    const wobble = 1 + 0.075 * Math.sin(a * 3 + seed * 1.9)
      + 0.045 * Math.sin(a * 5 - seed * 2.7);
    points.push(new THREE.Vector2(Math.cos(a) * 0.19 * wobble,
      Math.sin(a) * 0.125 * wobble));
  }
  const shape = new THREE.Shape();
  const last = points[points.length - 1];
  shape.moveTo((last.x + points[0].x) * 0.5, (last.y + points[0].y) * 0.5);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const next = points[(i + 1) % points.length];
    shape.quadraticCurveTo(p.x, p.y, (p.x + next.x) * 0.5, (p.y + next.y) * 0.5);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.105,
    steps: 1,
    curveSegments: 4,
    bevelEnabled: true,
    bevelThickness: 0.035,
    bevelSize: 0.027,
    bevelSegments: 4,
  });
  geometry.center();
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Key displacement off the original position, not the buffer index.
    // Bevelled geometry repeats positions along material seams; an index-keyed
    // offset pulls those copies apart. Equal positions need equal displacement.
    const px = v.x, py = v.y, pz = v.z;
    const d = 1 + 0.027 * Math.sin(px * 47 + py * 31 + pz * 23 + seed * 7.7)
      + 0.018 * Math.sin(px * 91 - py * 53 + pz * 67 + seed * 3.1);
    v.multiplyScalar(d);
    // Formed nuggets are gently domed rather than perfectly extruded biscuits.
    // Keep the torn perimeter irregular, but swell the two broad faces so they
    // catch soft highlights like breading over chicken instead of flat card.
    const radial = Math.min(1, Math.hypot(px / 0.2, py / 0.135));
    const crown = (1 - radial) * (1 - radial);
    if (Math.abs(pz) > 0.035) v.z += Math.sign(pz) * crown * (0.022 + seed * 0.002);
    pos.setXYZ(i, v.x, v.y, v.z);

    // Subtle warm face-to-face variation modulates the food photograph. It is
    // deliberately close to white: the source photo supplies the actual crumb
    // colour, while this only prevents six copies looking digitally identical.
    const k = 0.91 + 0.08 * Math.sin(px * 61 + py * 43 - pz * 37 + seed * 11.9);
    colors[i * 3] = k;
    colors[i * 3 + 1] = k * 0.94;
    colors[i * 3 + 2] = k * 0.83;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // ExtrudeGeometry's stock cap UVs are measured in model metres. Normalise
  // them to the nugget bounds so the deliberate photo crop covers each piece
  // instead of sampling one almost-flat pixel from the source image.
  const uv = geometry.attributes.uv;
  if (uv) {
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    const width = Math.max(0.001, bounds.max.x - bounds.min.x);
    const height = Math.max(0.001, bounds.max.y - bounds.min.y);
    for (let i = 0; i < uv.count; i++) {
      v.fromBufferAttribute(pos, i);
      uv.setXY(i, (v.x - bounds.min.x) / width, (v.y - bounds.min.y) / height);
    }
    uv.needsUpdate = true;
  }
  geometry.computeVertexNormals();
  return geometry;
}

function makeCasingMaterial() {
  const photo = photoSurface('plate');
  return new THREE.MeshStandardMaterial({
    color: photo ? 0xa8adb0 : 0x747b80,
    map: photo?.map ?? null,
    normalMap: photo?.normalMap ?? null,
    aoMap: photo?.armMap ?? null,
    roughnessMap: photo?.armMap ?? null,
    metalnessMap: photo?.armMap ?? null,
    roughness: 0.42,
    metalness: 0.72,
  });
}

function owned(entity, object) {
  if (object.geometry) entity._geometries.add(object.geometry);
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) if (material) entity._materials.add(material);
  return object;
}

function box(entity, sx, sy, sz, material, x, y, z) {
  const mesh = owned(entity, new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material));
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  entity.mesh.add(mesh);
  return mesh;
}

export class NuggetDispenser {
  constructor(prop, { photoTexture = undefined } = {}) {
    if (!prop?.collider) throw new TypeError('NuggetDispenser requires its furniture prop');

    this.prop = prop;
    this.x = prop.x;
    this.y = prop.y;
    this.z = prop.z;
    this.yaw = prop.rot ?? 0;
    this.cooldown = 0;
    this._serveAge = SERVE_TIME;
    this._idle = 0;
    this.disposed = false;
    this._geometries = new Set();
    this._materials = new Set();

    this.mesh = new THREE.Group();
    this.mesh.name = 'chicken-nugget-dispenser';
    this.mesh.userData.kind = NUGGET_DISPENSER_KIND;
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.rotation.y = this.yaw;

    this._photoTexture = photoTexture === undefined ? loadPhotoTexture() : photoTexture;
    this._signTexture = this._photoTexture?.clone?.() ?? null;
    if (this._signTexture) {
      // The fascia is much wider than the photograph. Crop it like CSS
      // object-fit: cover instead of stretching the food to twice its width.
      this._signTexture.wrapS = this._signTexture.wrapT = THREE.ClampToEdgeWrapping;
      this._signTexture.repeat.set(1, 0.56);
      this._signTexture.offset.set(0, 0.22);
      this._signTexture.needsUpdate = true;
    }
    this._crumbTexture = this._photoTexture?.clone?.() ?? null;
    if (this._crumbTexture) {
      // Crop tightly into the central breading rather than wrapping the black
      // slate and cut face around a nugget. UV 0..1 now samples only this small
      // patch of the verified CC0 food photograph.
      this._crumbTexture.wrapS = this._crumbTexture.wrapT = THREE.RepeatWrapping;
      this._crumbTexture.repeat.set(0.34, 0.38);
      this._crumbTexture.offset.set(0.29, 0.19);
      this._crumbTexture.needsUpdate = true;
    }
    this._crumbBumpTexture = this._crumbTexture?.clone?.() ?? null;
    if (this._crumbBumpTexture) {
      // A colour photograph used as height data must be sampled linearly. A
      // separate clone lets the albedo stay sRGB while the crumb relief does
      // not get gamma-shaped into glossy lumps.
      this._crumbBumpTexture.colorSpace = THREE.NoColorSpace;
      this._crumbBumpTexture.needsUpdate = true;
    }

    const casing = makeCasingMaterial();
    const trim = new THREE.MeshStandardMaterial({
      color: 0x161b1e, roughness: 0.32, metalness: 0.88,
    });
    const trayMat = new THREE.MeshStandardMaterial({
      color: 0xb9bdbe, roughness: 0.24, metalness: 0.92,
    });
    const warm = new THREE.MeshStandardMaterial({
      color: 0xffb329, roughness: 0.48, metalness: 0.26,
      emissive: 0x7d2600, emissiveIntensity: 0.75,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x080a0b, roughness: 0.72, metalness: 0.22,
    });
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xb9e3e8, roughness: 0.08, metalness: 0.02,
      transparent: true, opacity: 0.23, depthWrite: false,
    });
    this._nuggetMaterials = [0xfff7e8, 0xffe7c6, 0xf3d09b].map((tone) => (
      new THREE.MeshStandardMaterial({
        color: tone,
        map: this._crumbTexture,
        bumpMap: this._crumbBumpTexture,
        bumpScale: this._crumbTexture ? 0.018 : 0,
        vertexColors: true,
        roughness: 0.93, metalness: 0,
      })
    ));
    for (const material of [casing, trim, trayMat, warm, dark, glass, ...this._nuggetMaterials]) {
      this._materials.add(material);
    }

    // ---- steel body and warm-food cabinet ------------------------------
    box(this, 1.25, 2.05, 0.72, casing, 0, 1.025, 0);
    box(this, 1.08, 0.88, 0.035, dark, 0, 1.36, 0.378);
    box(this, 1.0, 0.05, 0.48, trayMat, 0, 0.91, 0.06);

    // Three low-power heating elements behind the display bin. Emissive strips
    // sell warmth without adding dynamic lights and recompiling room shaders.
    for (const x of [-0.31, 0, 0.31]) {
      box(this, 0.19, 0.025, 0.025, warm, x, 1.02, 0.348);
    }

    this._nuggetGeometries = [0, 1, 2].map((seed) => {
      const geometry = nuggetGeometry(seed);
      this._geometries.add(geometry);
      return geometry;
    });

    // A visible stock of real 3D nuggets behind the glass. Their small random
    // turns break the repeated silhouette even though they share three meshes.
    for (let i = 0; i < 10; i++) {
      const nugget = new THREE.Mesh(this._nuggetGeometries[i % 3], this._nuggetMaterials[i % 3]);
      nugget.position.set(-0.4 + (i % 5) * 0.2, 1.09 + Math.floor(i / 5) * 0.2,
        0.29 + (i % 2) * 0.018);
      nugget.rotation.set((i % 3 - 1) * 0.16, i * 1.73, (i % 4 - 2) * 0.12);
      nugget.castShadow = true;
      this.mesh.add(nugget);
    }

    const glassPane = owned(this, new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.84, 0.025), glass));
    glassPane.position.set(0, 1.36, 0.405);
    this.mesh.add(glassPane);

    // ---- photographed header card --------------------------------------
    // A warm backer remains visible while the image loads and is the complete
    // fallback in a build that intentionally omits optional art.
    box(this, 1.04, 0.31, 0.038, warm, 0, 1.84, 0.38);
    if (this._signTexture) {
      const signMat = new THREE.MeshBasicMaterial({ map: this._signTexture, toneMapped: false });
      this._materials.add(signMat);
      const sign = owned(this, new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.275), signMat));
      sign.position.set(0, 1.84, 0.402);
      this.mesh.add(sign);
    }

    // ---- hatch, tray and control ---------------------------------------
    this.flap = new THREE.Group();
    this.flap.position.set(0, 0.89, 0.405);
    const flapPlate = owned(this, new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.34, 0.055), trim));
    flapPlate.position.y = -0.17;
    flapPlate.castShadow = true;
    this.flap.add(flapPlate);
    this.mesh.add(this.flap);

    this.tray = new THREE.Group();
    this.tray.position.set(0, 0.55, 0.47);
    const trayBase = owned(this, new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.075, 0.58), trayMat));
    trayBase.position.z = 0.18;
    trayBase.castShadow = trayBase.receiveShadow = true;
    this.tray.add(trayBase);
    for (const x of [-0.43, 0.43]) {
      const rail = owned(this, new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.12, 0.58), trim));
      rail.position.set(x, 0.055, 0.18);
      this.tray.add(rail);
    }
    this.mesh.add(this.tray);

    const ring = owned(this, new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.024, 10, 26), trayMat));
    ring.position.set(0.42, 0.72, 0.416);
    this.mesh.add(ring);
    const button = owned(this, new THREE.Mesh(new THREE.CylinderGeometry(0.077, 0.083, 0.075, 24), warm));
    button.rotation.x = Math.PI / 2;
    button.position.set(0.42, 0.72, 0.45);
    this.mesh.add(button);

    this.statusMaterial = new THREE.MeshStandardMaterial({
      color: 0x55ee88, roughness: 0.28, metalness: 0.2,
      emissive: 0x22cc66, emissiveIntensity: 1.6,
    });
    this._materials.add(this.statusMaterial);
    this.statusLamp = owned(this, new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 12, 8), this.statusMaterial,
    ));
    this.statusLamp.position.set(-0.42, 0.72, 0.43);
    this.mesh.add(this.statusLamp);

    this.stockBar = owned(this, new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.032, 0.026), warm));
    this.stockBar.position.set(-0.19, 0.72, 0.424);
    this.mesh.add(this.stockBar);

    // Physical servings are a small persistent simulation, not an animation
    // that blinks out after the heal. Bodies are allocated as needed up to a
    // generous cap. Once full, gameplay servings still heal, but no landed
    // nugget is stolen from the floor to fake another ejection: a piece that
    // lands belongs to this run until the run/world resets.
    this._nuggetBodies = [];
    this._servingSerial = 0;
    this.serving = [];
    for (let i = 0; i < NUGGET_COUNT; i++) {
      const body = this._createNuggetBody(i);
      this.serving.push(body.mesh);
    }

    // Feet and a shallow kick plate stop the cabinet reading as a box resting
    // directly on the slab.
    box(this, 1.12, 0.19, 0.61, trim, 0, 0.105, -0.015);
    for (const x of [-0.47, 0.47]) box(this, 0.11, 0.09, 0.52, dark, x, 0.045, -0.01);
  }

  get ready() { return !this.disposed && this.cooldown <= 1e-6; }
  get settledNuggets() {
    return this._nuggetBodies.filter((body) => body.state === 'settled').map((body) => body.mesh);
  }

  _createNuggetBody(variant = 0) {
    const index = variant % this._nuggetGeometries.length;
    const mesh = new THREE.Mesh(this._nuggetGeometries[index], this._nuggetMaterials[index]);
    mesh.visible = false;
    mesh.castShadow = mesh.receiveShadow = true;
    this.mesh.add(mesh);
    const body = {
      mesh,
      state: 'inactive',
      age: 0,
      delay: 0,
      serial: -1,
      settledAt: -Infinity,
      velocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(),
      bounces: 0,
    };
    this._nuggetBodies.push(body);
    return body;
  }

  _acquireNuggetBody(variant) {
    let body = this._nuggetBodies.find((candidate) => candidate.state === 'inactive');
    if (!body && this._nuggetBodies.length < MAX_FLOOR_NUGGETS) {
      body = this._createNuggetBody(variant);
    }
    // At capacity, suppress new visual bodies. Moving or hiding one of the
    // settled pieces would violate the visible promise that nuggets persist.
    return body ?? null;
  }

  _prepareServing() {
    const serial = ++this._servingSerial;
    this.serving = [];
    for (let i = 0; i < NUGGET_COUNT; i++) {
      const body = this._acquireNuggetBody(i);
      if (!body) continue;
      body.state = 'queued';
      body.age = 0;
      body.delay = 0.1 + i * 0.105;
      body.serial = serial;
      body.bounces = 0;
      const n = serial * 11 + i * 7;
      body.velocity.set(
        Math.sin(n * 1.91) * (0.34 + (i % 3) * 0.07),
        0.62 + (i % 2) * 0.16,
        1.45 + (i % 3) * 0.18,
      );
      body.angularVelocity.set(
        4.2 + (i % 3) * 1.1,
        (i % 2 ? -1 : 1) * (4.8 + i * 0.35),
        Math.cos(n) * 5.4,
      );
      body.mesh.visible = false;
      this.serving.push(body.mesh);
    }
  }

  _integrateNugget(body, duration) {
    let remaining = Math.max(0, duration);
    while (remaining > 1e-6 && body.state === 'flying') {
      const dt = Math.min(remaining, 1 / 60);
      remaining -= dt;
      body.velocity.y -= NUGGET_GRAVITY * dt;
      body.mesh.position.addScaledVector(body.velocity, dt);
      body.mesh.rotation.x += body.angularVelocity.x * dt;
      body.mesh.rotation.y += body.angularVelocity.y * dt;
      body.mesh.rotation.z += body.angularVelocity.z * dt;

      if (body.mesh.position.y > NUGGET_FLOOR_Y || body.velocity.y >= 0) continue;
      body.mesh.position.y = NUGGET_FLOOR_Y;
      body.bounces++;
      if (Math.abs(body.velocity.y) > 0.68 && body.bounces < 4) {
        body.velocity.y *= -0.31;
        body.velocity.x *= 0.72;
        body.velocity.z *= 0.72;
        body.angularVelocity.multiplyScalar(0.74);
        continue;
      }

      body.state = 'settled';
      body.settledAt = this._idle;
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      // ExtrudeGeometry's broad faces point along local Z. This rotation lays
      // the piece on a broad face with a small natural lean instead of leaving
      // a physically impossible nugget balanced upright on its crust.
      const lean = Math.sin(body.serial * 3.1 + body.mesh.id) * 0.075;
      body.mesh.rotation.x = Math.PI / 2 + lean;
      body.mesh.rotation.z = Math.cos(body.serial * 2.3 + body.mesh.id) * 0.06;
    }
  }

  /** True while the player is beside this machine on the same storey. */
  inRange(player) {
    if (this.disposed || !player?.pos) return false;
    const dx = Number(player.pos.x) - this.x;
    const dz = Number(player.pos.z) - this.z;
    const py = Number(player.pos.y) + (Number(player.height) || 1.8) * 0.5;
    return Number.isFinite(dx) && Number.isFinite(dz) && Number.isFinite(py)
      && dx * dx + dz * dz <= NUGGET_DISPENSER_RANGE * NUGGET_DISPENSER_RANGE
      && Math.abs(py - (this.y + 1.0)) < 2.2;
  }

  /**
   * Dispense one six-piece serving and apply its local heal.
   * @returns {{count:number, healed:number}|null} null while restocking/dead
   */
  dispense(player) {
    if (!this.ready || !player?.alive || typeof player.heal !== 'function') return null;
    const before = Number(player.health) || 0;
    player.heal(NUGGET_HEAL);
    this.cooldown = NUGGET_RESTOCK;
    this._serveAge = 0;
    this._prepareServing();
    return { count: NUGGET_COUNT, healed: Math.max(0, (Number(player.health) || 0) - before) };
  }

  prompt() {
    if (this.ready) return `6 CHICKEN NUGGETS · +${NUGGET_HEAL} HP`;
    return `NUGGETS RESTOCKING · ${Math.ceil(this.cooldown)}s`;
  }

  update(dt) {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return;
    this._idle += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this._serveAge = Math.min(SERVE_TIME, this._serveAge + dt);

    const ready = this.ready;
    this.statusMaterial.color.setHex(ready ? 0x55ee88 : 0xff9c35);
    this.statusMaterial.emissive.setHex(ready ? 0x22cc66 : 0xd53c05);
    this.statusMaterial.emissiveIntensity = (ready ? 1.55 : 1.1)
      + Math.sin(this._idle * (ready ? 3.2 : 6.5)) * 0.18;
    const stock = ready ? 1 : 1 - this.cooldown / NUGGET_RESTOCK;
    this.stockBar.scale.x = Math.max(0.025, stock);
    this.stockBar.position.x = -0.38 + 0.19 * this.stockBar.scale.x;

    const age = this._serveAge;
    const flapT = age < FLAP_OPEN_TIME ? smoothstep(age / FLAP_OPEN_TIME)
      : age < 1.5 ? 1
        : 1 - smoothstep((age - 1.5) / 0.48);
    this.flap.rotation.x = -flapT * 1.18;

    for (const body of this._nuggetBodies) {
      if (body.state === 'inactive' || body.state === 'settled') continue;
      const before = body.age;
      body.age += dt;
      if (body.state === 'queued' && body.age >= body.delay) {
        body.state = 'flying';
        body.mesh.visible = true;
        body.mesh.position.set(0, 0.84, 0.49);
        body.mesh.rotation.set(0.28 * body.serial, body.serial * 0.91, 0.17 * body.serial);
        this._integrateNugget(body, body.age - Math.max(before, body.delay));
      } else if (body.state === 'flying') {
        this._integrateNugget(body, dt);
      }
    }
  }

  reset() {
    if (this.disposed) return;
    this.cooldown = 0;
    this._serveAge = SERVE_TIME;
    this._idle = 0;
    this._servingSerial = 0;
    this.flap.rotation.x = 0;
    for (const body of this._nuggetBodies) {
      body.state = 'inactive';
      body.mesh.visible = false;
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
    }
    this.serving = [];
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this._geometries) geometry.dispose();
    for (const material of this._materials) material.dispose();
    this._crumbTexture?.dispose?.();
    this._crumbBumpTexture?.dispose?.();
    this._signTexture?.dispose?.();
    this._photoTexture?.dispose?.();
    this._geometries.clear();
    this._materials.clear();
  }
}

export function createNuggetDispenser(world, options = {}) {
  const prop = findNuggetDispenserProp(world);
  return prop ? new NuggetDispenser(prop, options) : null;
}
