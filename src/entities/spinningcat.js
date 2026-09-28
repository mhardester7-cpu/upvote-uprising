// The tabby anomaly: a supplied animated GIF that resolves into a licensed,
// skinned domestic-cat model. The GIF is a one-shot transformation; after it
// finishes, the authored walk cycle drives a real quadruped roaming the room.

import * as THREE from '../../vendor/three.module.js';
import { MAP_COMPLEX } from '../world/world.js';

export const SPINNING_CAT_GIF_DURATION = 3.48;
export const SPINNING_CAT_GIF_URL = new URL(
  '../../assets/creatures/spinning-cat.gif', import.meta.url,
).href;
export const SPINNING_CAT_MODEL = 'assets/creatures/cat/maggie-animated-v3.glb';

const MATERIALISE_TIME = 0.48;
const MODEL_SWAP_POINT = 0.42;
const CAT_HEIGHT = 0.58;
const CAT_LENGTH = 1.12;
const WANDER_SPEED = 0.62;
const WANDER_MARGIN = 0.82;
const LOOK_DOT = Math.cos(THREE.MathUtils.degToRad(25));
const TMP_TO_CAT = new THREE.Vector3();
const TMP_LOOK = new THREE.Vector3();

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smoothstep = (value) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};
const angleDelta = (from, to) => {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
};

function mixRoomSeed(seed, roomId) {
  let value = ((seed >>> 0) ^ Math.imul((roomId + 1) >>> 0, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function placementInRoom(world, room) {
  const width = room.maxX - room.minX;
  const depth = room.maxZ - room.minZ;
  const roomSeed = mixRoomSeed(world.seed, room.id);
  const angle = roomSeed / 4294967296 * Math.PI * 2;
  const offset = Math.min(3.2, Math.max(1.4, Math.min(width, depth) * 0.2));
  const wantedX = room.cx + Math.cos(angle) * offset;
  const wantedZ = room.cz + Math.sin(angle) * offset;
  const floorY = room.floorY ?? world.heightAt(room.cx, room.cz);

  let best = null;
  const margin = 1.25;
  for (let x = room.minX + margin; x <= room.maxX - margin; x += 0.5) {
    for (let z = room.minZ + margin; z <= room.maxZ - margin; z += 0.5) {
      if (world.blocksAt(x, floorY, z, 0.66, 1.9)) continue;
      if (world.supportHeight
        && world.supportHeight(x, z, floorY, 0.66) < floorY - 0.05) continue;
      const score = Math.hypot(x - wantedX, z - wantedZ);
      if (!best || score < best.score) best = { x, z, score };
    }
  }
  if (!best) return null;

  return {
    x: best.x,
    y: floorY,
    z: best.z,
    // Maggie's authored nose points along local +Z, matching Three.js object
    // forward, so this turns her face (rather than her tail) into the room.
    yaw: Math.atan2(room.cx - best.x, room.cz - best.z),
    roomId: room.id,
  };
}

/**
 * Pick a clear patch in an ordinary indoor room.
 *
 * Community landmarks keep their own rooms: the start room, Dinosaur Factory,
 * Human Observation and Rhythm Tower are all excluded. Ranking the remaining
 * rooms with the world seed makes the choice stable for every co-op client.
 */
export function findSpinningCatPlacement(world) {
  if (!world || world.mapId !== MAP_COMPLEX || !world.plan?.rooms) return null;
  const reservedRooms = new Set([
    world.plan.start,
    world.plan.dinosaurFactoryRoom,
    world.plan.reverseAquariumRoom,
    world.plan.drummerTowerRoom,
  ]);
  const reservedRoles = new Set([
    'start', 'dinosaur_factory', 'reverse_aquarium', 'rhythm_tower',
  ]);
  const rooms = world.plan.rooms
    .filter((room) => !room.outdoor
      && !reservedRooms.has(room.id)
      && !reservedRoles.has(room.role?.id)
      && !room.drummerTower)
    .sort((a, b) => mixRoomSeed(world.seed, a.id) - mixRoomSeed(world.seed, b.id)
      || a.id - b.id);
  for (const room of rooms) {
    const placement = placementInRoom(world, room);
    if (placement) return placement;
  }
  return null;
}

function asObject3D(asset) {
  const object = asset?.scene ?? asset?.model ?? asset;
  return object?.isObject3D ? object : null;
}

function materialsOf(object) {
  return Array.isArray(object.material) ? object.material : [object.material];
}

function prepareModel(entity, asset) {
  const source = asObject3D(asset);
  if (!source) throw new Error('spinning cat asset has no Object3D scene');

  source.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
    if (object.geometry) entity._geometries.add(object.geometry);
    for (const material of materialsOf(object)) {
      if (!material) continue;
      entity._materials.add(material);
      // Domestic-cat fur is diffuse. Suppress metallic/specular importer
      // defaults while keeping every authored embedded colour/alpha texture.
      if ('metalness' in material) material.metalness = 0;
      if ('roughness' in material) material.roughness = 0.88;
      if ('envMapIntensity' in material) material.envMapIntensity = 0.72;
      for (const key of [
        'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
        'aoMap', 'alphaMap',
      ]) {
        if (material[key]?.isTexture) entity._modelTextures.add(material[key]);
      }
    }
  });

  source.updateMatrixWorld(true);
  let bounds = new THREE.Box3().setFromObject(source);
  let size = bounds.getSize(new THREE.Vector3());
  if (![size.x, size.y, size.z].every(Number.isFinite) || Math.max(size.x, size.y, size.z) < 1e-5) {
    throw new Error('spinning cat asset has invalid bounds');
  }

  // Slightly enlarged domestic-cat proportions for in-game readability.
  // Height is the most reliable anchor, while length guards against an
  // unexpectedly stretched file without changing Maggie's authored facing.
  const scale = Math.min(
    CAT_HEIGHT / Math.max(size.y, 1e-5),
    CAT_LENGTH / Math.max(size.x, size.z, 1e-5),
  );
  source.scale.multiplyScalar(scale);
  source.updateMatrixWorld(true);
  bounds = new THREE.Box3().setFromObject(source);
  const centre = bounds.getCenter(new THREE.Vector3());
  source.position.x -= centre.x;
  source.position.y -= bounds.min.y;
  source.position.z -= centre.z;

  const holder = new THREE.Group();
  holder.name = 'spinning-cat-model';
  holder.rotation.y = entity.placement.yaw;
  holder.add(source);
  entity.modelSource = source;
  entity.modelRestYaw = entity.placement.yaw;

  const clips = asset?.animations ?? asset?.clips ?? [];
  if (clips.length) {
    entity.mixer = new THREE.AnimationMixer(source);
    const idle = clips.find((clip) => /(?:^|\|)idle$/i.test(clip.name))
      ?? clips.find((clip) => /idle/i.test(clip.name));
    const walk = clips.find((clip) => /(?:^|\|)walk$/i.test(clip.name))
      ?? clips.find((clip) => /walk/i.test(clip.name));
    if (idle) {
      entity.idleAction = entity.mixer.clipAction(idle);
      entity.idleAction.play();
    }
    if (walk) {
      entity.walkAction = entity.mixer.clipAction(walk);
      // Maggie supplies an in-place walk but no separate idle clip. Freeze its
      // first authored pose while she pauses, then resume it only while moving.
      if (!entity.idleAction) {
        entity.walkAction.play();
        entity.walkAction.paused = true;
      }
    }
  }
  return holder;
}

export class SpinningCat {
  constructor(placement, asset, options = {}) {
    this.placement = placement;
    this._geometries = new Set();
    this._materials = new Set();
    this._modelTextures = new Set();
    this._time = 0;
    this._ready = false;
    this._failed = false;
    this._triggered = false;
    this._materialisationSettled = false;
    this._idleFramePainted = false;
    this._playId = 0;
    this.mixer = null;
    this.idleAction = null;
    this.walkAction = null;
    this._walking = false;
    this.world = options.world ?? null;
    this.room = this.world?.plan?.rooms?.find((room) => room.id === placement.roomId) ?? null;
    this._wanderTarget = new THREE.Vector3(placement.x, placement.y, placement.z);
    this._wanderPause = 0.9;
    this._rngState = ((Math.round(placement.x * 1000) * 73856093)
      ^ (Math.round(placement.z * 1000) * 19349663)) >>> 0;

    this.mesh = new THREE.Group();
    this.mesh.name = 'spinning-cat-anomaly';
    this.mesh.position.set(placement.x, placement.y, placement.z);

    this.canvas = (options.canvasFactory ?? (() => document.createElement('canvas')))();
    this.canvas.width = 320;
    this.canvas.height = 320;
    this.context = this.canvas.getContext('2d', { alpha: true });
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.billboardMaterial = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 1,
      alphaTest: 0.025,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this._materials.add(this.billboardMaterial);
    // The source GIF is a real photographed cat. Keeping it close to a real
    // cat's footprint makes the hand-off to the 3D animal feel continuous.
    const billboardGeometry = new THREE.PlaneGeometry(1.08, 1.08);
    this._geometries.add(billboardGeometry);
    this.billboard = new THREE.Mesh(billboardGeometry, this.billboardMaterial);
    this.billboard.name = 'spinning-cat-gif';
    this.billboard.position.y = 0.53;
    this.billboard.renderOrder = 4;
    this.mesh.add(this.billboard);

    this.model = prepareModel(this, asset);
    this.model.visible = false;
    this.mesh.add(this.model);

    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0x8fe9ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this._materials.add(glowMaterial);
    const glowGeometry = new THREE.TorusGeometry(0.83, 0.025, 8, 42);
    this._geometries.add(glowGeometry);
    this.glow = new THREE.Mesh(glowGeometry, glowMaterial);
    this.glow.name = 'spinning-cat-materialisation-ring';
    this.glow.rotation.x = Math.PI / 2;
    this.glow.position.y = 0.035;
    this.glow.visible = false;
    this.mesh.add(this.glow);

    const haloMaterial = glowMaterial.clone();
    haloMaterial.opacity = 0;
    this._materials.add(haloMaterial);
    this.halo = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.018, 8, 48), haloMaterial);
    this._geometries.add(this.halo.geometry);
    this.halo.name = 'spinning-cat-energy-halo';
    this.halo.position.y = 0.43;
    this.halo.visible = false;
    this.mesh.add(this.halo);

    const sparkPositions = new Float32Array(30 * 3);
    for (let i = 0; i < 30; i++) {
      const angle = i / 30 * Math.PI * 2;
      const radius = 0.27 + (i % 5) * 0.075;
      sparkPositions[i * 3] = Math.cos(angle) * radius;
      sparkPositions[i * 3 + 1] = 0.05 + (i % 10) * 0.095;
      sparkPositions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3));
    this._geometries.add(sparkGeometry);
    const sparkMaterial = new THREE.PointsMaterial({
      color: 0xd5faff, size: 0.055, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    this._materials.add(sparkMaterial);
    this.sparks = new THREE.Points(sparkGeometry, sparkMaterial);
    this.sparks.name = 'spinning-cat-transformation-sparks';
    this.sparks.visible = false;
    this.mesh.add(this.sparks);

    this.image = (options.imageFactory ?? (() => new Image()))();
    this.image.decoding = 'async';
    this.reset();
  }

  get phase() {
    if (this._failed) return 'model';
    if (!this._triggered) return 'dormant';
    if (!this._ready) return 'loading';
    if (this._time < SPINNING_CAT_GIF_DURATION) return 'gif';
    if (this._time < SPINNING_CAT_GIF_DURATION + MATERIALISE_TIME) return 'materialising';
    return 'model';
  }

  get focusActive() {
    return this._triggered && !this._failed && this.phase !== 'model';
  }

  _loadGif() {
    this._ready = false;
    const playId = ++this._playId;
    this.image.onload = () => {
      if (playId !== this._playId) return;
      this._ready = true;
      this._time = 0;
      this._idleFramePainted = false;
    };
    this.image.onerror = () => {
      if (playId !== this._playId) return;
      this._failed = true;
      this._triggered = true;
      this.billboard.visible = false;
      this.model.visible = true;
      this.model.scale.setScalar(1);
    };
    this.image.src = `${SPINNING_CAT_GIF_URL}?play=${playId}`;
  }

  reset() {
    this._time = 0;
    this._failed = false;
    this._triggered = false;
    this._materialisationSettled = false;
    this._idleFramePainted = false;
    this.mesh.position.set(this.placement.x, this.placement.y, this.placement.z);
    this._wanderTarget.copy(this.mesh.position);
    this._wanderPause = 0.9;
    this._setWalking(false, true);
    this.billboard.visible = true;
    this.billboard.scale.setScalar(1);
    this.billboardMaterial.opacity = 1;
    this.model.visible = false;
    this.model.scale.setScalar(0.001);
    this.model.position.y = 0;
    this.model.rotation.set(0, this.modelRestYaw, 0);
    this.glow.visible = false;
    this.halo.visible = false;
    this.sparks.visible = false;
    this.mixer?.setTime(0);
    if (this.context) this.context.clearRect(0, 0, 320, 320);
    this._loadGif();
  }

  /** The reveal is intentionally gaze-triggered; it never happens off-screen. */
  isObservedBy(camera) {
    if (!camera || this._triggered || !this._ready) return false;
    camera.getWorldDirection(TMP_LOOK);
    TMP_TO_CAT.set(
      this.placement.x - camera.position.x,
      this.placement.y + 0.5 - camera.position.y,
      this.placement.z - camera.position.z,
    );
    const distance = TMP_TO_CAT.length();
    if (distance > 13 || distance < 0.35) return false;
    TMP_TO_CAT.multiplyScalar(1 / distance);
    return TMP_LOOK.dot(TMP_TO_CAT) >= LOOK_DOT;
  }

  _beginReveal() {
    if (this._triggered || this._failed) return;
    this._triggered = true;
    this._time = 0;
    // A fresh URL restarts the browser's GIF clock at frame one. This is the
    // moment the player looked, rather than the earlier world-load time.
    this._loadGif();
  }

  /**
   * Hold the player's view on the anomaly while it transforms. Returning true
   * tells the frame loop to discard look input for this short cinematic beat.
   */
  focusPlayer(player, dt) {
    if (!this.focusActive || !player?.alive) return false;
    const dx = this.placement.x - player.pos.x;
    const dz = this.placement.z - player.pos.z;
    const horizontal = Math.hypot(dx, dz) || 0.001;
    const wantedYaw = Math.atan2(-dx, -dz);
    const wantedPitch = Math.atan2(this.placement.y + 0.5 - player.eyeY, horizontal);
    const amount = 1 - Math.exp(-Math.max(0, dt || 0) * 13);
    player.yaw += angleDelta(player.yaw, wantedYaw) * amount;
    player.pitch += (wantedPitch - player.pitch) * amount;
    return true;
  }

  update(dt, camera) {
    if (camera && this.billboard.visible) this.billboard.quaternion.copy(camera.quaternion);

    if (!this._triggered) {
      if (this._ready && !this._idleFramePainted && this.context) {
        this.context.clearRect(0, 0, 320, 320);
        this.context.drawImage(this.image, 0, 0, 320, 320);
        this.texture.needsUpdate = true;
        this._idleFramePainted = true;
      }
      if (this.isObservedBy(camera)) this._beginReveal();
      return;
    }

    if (this._ready && !this._failed) {
      this._time += Math.max(0, dt || 0);
      if (this._time < SPINNING_CAT_GIF_DURATION && this.context) {
        this.context.clearRect(0, 0, 320, 320);
        this.context.drawImage(this.image, 0, 0, 320, 320);
        this.texture.needsUpdate = true;
        this.billboard.scale.setScalar(1);
      }
    }

    const materialAge = this._failed
      ? MATERIALISE_TIME
      : this._time - SPINNING_CAT_GIF_DURATION;
    if (materialAge >= 0 && !this._materialisationSettled) {
      const transition = clamp01(materialAge / MATERIALISE_TIME);
      const gifExit = smoothstep(clamp01((transition - 0.2) / (MODEL_SWAP_POINT - 0.2)));
      const settle = smoothstep(clamp01(
        (transition - MODEL_SWAP_POINT) / (1 - MODEL_SWAP_POINT),
      ));
      const poofProgress = clamp01((transition - 0.25) / 0.75);
      const poof = Math.sin(poofProgress * Math.PI);
      // The flat GIF performs the supplied spin first. Only after its complete
      // pass does the burst replace it with the persistent realistic 3D cat.
      this.billboard.visible = transition < MODEL_SWAP_POINT;
      this.billboardMaterial.opacity = 1 - gifExit;
      this.billboard.scale.setScalar(1 + gifExit * 0.12);
      this.model.visible = transition >= MODEL_SWAP_POINT;
      if (this.model.visible) {
        this.model.scale.setScalar(0.86 + settle * 0.14 + Math.sin(settle * Math.PI) * 0.1);
        this.model.position.y = Math.sin(settle * Math.PI) * 0.08;
        this.model.rotation.y = this.modelRestYaw;
      }
      this.glow.visible = transition > 0.25 && transition < 1;
      this.glow.material.opacity = poof * 0.56;
      this.glow.scale.setScalar(0.45 + transition * 0.75);
      this.glow.rotation.z = this._time * 3.6;
      this.halo.visible = transition > 0.25 && transition < 1;
      this.halo.material.opacity = poof * 0.48;
      this.halo.rotation.set(transition * Math.PI, this._time * 5.2, transition * 0.7);
      this.halo.scale.setScalar(0.55 + transition * 0.45);
      this.sparks.visible = transition > 0.25 && transition < 1;
      this.sparks.material.opacity = poof * 0.82;
      this.sparks.rotation.y = -this._time * 4.8;
      this.sparks.position.y = transition * 0.16;
      if (transition >= 1) this._materialisationSettled = true;
    }

    if (this.model.visible) this.mixer?.update(Math.max(0, dt || 0));
    if (this.phase === 'model') this._updateWander(Math.max(0, dt || 0));
  }

  _random() {
    this._rngState = (this._rngState * 1664525 + 1013904223) >>> 0;
    return this._rngState / 4294967296;
  }

  _setWalking(walking, immediate = false) {
    if (walking === this._walking && !immediate) return;
    this._walking = walking;
    if (!this.walkAction) return;
    if (!this.idleAction) {
      if (immediate) this.walkAction.reset().play();
      else if (!this.walkAction.isRunning()) this.walkAction.play();
      this.walkAction.paused = !walking;
      return;
    }
    const from = walking ? this.idleAction : this.walkAction;
    const to = walking ? this.walkAction : this.idleAction;
    if (immediate) {
      from.stop();
      to.reset().play();
      return;
    }
    from.fadeOut(0.18);
    to.reset().fadeIn(0.18).play();
  }

  _pickWanderTarget() {
    if (!this.room || !this.world) return false;
    const y = this.room.floorY ?? this.placement.y;
    for (let attempt = 0; attempt < 20; attempt++) {
      const x = THREE.MathUtils.lerp(
        this.room.minX + WANDER_MARGIN,
        this.room.maxX - WANDER_MARGIN,
        this._random(),
      );
      const z = THREE.MathUtils.lerp(
        this.room.minZ + WANDER_MARGIN,
        this.room.maxZ - WANDER_MARGIN,
        this._random(),
      );
      const distance = Math.hypot(x - this.mesh.position.x, z - this.mesh.position.z);
      if (distance < 1.35 || this.world.blocksAt(x, y, z, 0.28, 0.62)) continue;
      if (this.world.lineOfSight
        && !this.world.lineOfSight(
          this.mesh.position.x, y + 0.28, this.mesh.position.z,
          x, y + 0.28, z,
        )) continue;
      this._wanderTarget.set(x, y, z);
      return true;
    }
    return false;
  }

  _updateWander(dt) {
    // Never translate a static mesh: roaming is enabled only when the bundled
    // animal supplies a genuine authored walk performance.
    if (!this.walkAction || !this.room || !this.world) return;
    const dx = this._wanderTarget.x - this.mesh.position.x;
    const dz = this._wanderTarget.z - this.mesh.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.08) {
      this._setWalking(false);
      this._wanderPause -= dt;
      if (this._wanderPause <= 0 && this._pickWanderTarget()) {
        this._wanderPause = 0;
        this._setWalking(true);
      }
      return;
    }

    // The prepared animal's nose is local +Z, so its face leads every step.
    const wantedYaw = Math.atan2(dx, dz);
    const turn = 1 - Math.exp(-dt * 7.5);
    this.model.rotation.y += angleDelta(this.model.rotation.y, wantedYaw) * turn;
    const forwardX = Math.sin(this.model.rotation.y);
    const forwardZ = Math.cos(this.model.rotation.y);
    const forwardAlignment = (forwardX * dx + forwardZ * dz) / distance;
    // Finish turning before translating. This prevents the in-place gait from
    // visibly skating sideways whenever a new wander destination is chosen.
    if (forwardAlignment < 0.96) {
      this._setWalking(false);
      return;
    }
    this._setWalking(true);
    const step = Math.min(distance, WANDER_SPEED * dt);
    this.mesh.position.x += dx / distance * step;
    this.mesh.position.z += dz / distance * step;
    this.mesh.position.y = this._wanderTarget.y;
    if (step >= distance - 1e-5) this._wanderPause = 0.8 + this._random() * 2.4;
  }

  dispose() {
    this._playId++;
    this.image.onload = null;
    this.image.onerror = null;
    this.image.src = '';
    this.mixer?.stopAllAction();
    this.mixer?.uncacheRoot(this.modelSource);
    this.texture.dispose();
    for (const texture of this._modelTextures) texture.dispose();
    for (const geometry of this._geometries) geometry.dispose();
    for (const material of this._materials) material.dispose();
    this._modelTextures.clear();
    this._geometries.clear();
    this._materials.clear();
  }
}

/** Load the bundled realistic animated source. Kept dynamic for headless tests. */
export async function loadSpinningCatAsset() {
  if (typeof window === 'undefined') return null;
  const { loadModelFile } = await import('../render/loadmodel.js');
  const modelUrl = new URL(`../../${SPINNING_CAT_MODEL}`, import.meta.url).href;
  return loadModelFile(modelUrl);
}

export async function createSpinningCat(world, options = {}) {
  const placement = findSpinningCatPlacement(world);
  if (!placement) return null;
  try {
    const asset = await (options.loadModel ?? loadSpinningCatAsset)();
    if (!asObject3D(asset)) return null;
    return new SpinningCat(placement, asset, { ...options, world });
  } catch (error) {
    console.warn('Realistic spinning cat unavailable; skipping anomaly', error);
    return null;
  }
}
