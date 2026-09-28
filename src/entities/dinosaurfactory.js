// The dinosaur factory and its locally owned raptor ally.
//
// World generation authors the factory as furniture so doors, bullets,
// navigation and players agree on its footprint. This module supplies the
// detailed cloning pod, interaction state, the animated CC0 raptor, and its
// small companion AI. Like the nugget serving, each player owns their factory
// state: a co-op client never deletes or commandeers somebody else's ally.

import * as THREE from '../../vendor/three.module.js';
import { MAP_COMPLEX, PROP_FURNITURE } from '../world/world.js';
import { photoSurface } from '../render/photosets.js';
import { NavGrid, NAV_UNREACHED } from '../world/navgrid.js';

export const DINOSAUR_FACTORY_KIND = 'dinosaur_factory';
export const DINOSAUR_FACTORY_COST = 1500;
export const DINOSAUR_FACTORY_RANGE = 3.25;
export const DINOSAUR_PRODUCTION_TIME = 4.4;
export const DINOSAUR_MODEL = 'assets/creatures/velociraptor/Velociraptor.fbx';
export const DINOSAUR_SKIN = 'assets/creatures/dinosaur_skin/lizard_skin.png';
export const DINOSAUR_BITE_DAMAGE = 42;
export const DINOSAUR_ATTACK_RANGE = 1.75;
export const DINOSAUR_TARGET_RANGE = 18;
export const DINOSAUR_FACTORY_INSTRUCTIONS = Object.freeze([
  'DINOSAUR FACTORY',
  'GET CLOSE + PRESS E  •  COST 1,500',
  'HATCHES AN ALLY THAT HUNTS ZOMBIES',
]);

const DINO_HEIGHT = 1.65;
const DINO_RADIUS = 0.43;
const DINO_SPEED = 4.8;
export const DINOSAUR_MAX_CATCHUP_SPEED = 10.2;
/** Both the procedural raptor and prepared FBX face local -Z. */
export const DINOSAUR_MODEL_FORWARD_OFFSET = Math.PI;
// A flow field remains valid while its goal cell and geometry remain valid.
// Three refresh opportunities per second are plenty while the player moves;
// standing still performs no repeat sweeps at all.
const NAV_REFRESH = 0.32;
const TRAIL_SPACING = 0.62;
const TRAIL_LIMIT = 220;
const BITE_TIME = 0.76;
const BITE_IMPACT = 0.34;
const HATCH_FRONT = 1.72;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (v) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
const angleDelta = (from, to) => {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/** World-space direction in which a local -Z dinosaur visual is looking. */
export function dinosaurRenderedForward(renderYaw) {
  return { x: -Math.sin(renderYaw), z: -Math.cos(renderYaw) };
}

/** The shared physical factory authored into this World. */
export function findDinosaurFactoryProp(world) {
  if (!world || world.mapId !== MAP_COMPLEX || !Array.isArray(world.props)) return null;
  return world.props.find((prop) => prop.type === PROP_FURNITURE
    && prop.kind === DINOSAUR_FACTORY_KIND) ?? null;
}

/** Map arbitrary author clip names onto the motions the companion AI needs. */
export function classifyDinosaurClips(clips = []) {
  const result = {};
  const wants = ['idle', 'walk', 'run', 'attack', 'jump', 'death', 'hit'];
  for (const clip of clips) {
    const name = String(clip?.name ?? '').toLowerCase();
    for (const key of wants) {
      if (!result[key] && name.includes(key)) result[key] = clip;
    }
  }
  return result;
}

function loadTexture(url) {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  return new THREE.TextureLoader().loadAsync(url).then((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    // The source is genuine high-resolution lizard skin. Repeating it too
    // often turns the visible scales into television noise at gameplay range.
    texture.repeat.set(1.35, 1.35);
    texture.anisotropy = 8;
    return texture;
  }).catch(() => null);
}

/** Load the bundled animated CC0 source. Kept dynamic for headless tests. */
export async function loadDinosaurAsset() {
  if (typeof window === 'undefined') return { model: null, clips: [], skinTexture: null };
  try {
    const { loadModelFile } = await import('../render/loadmodel.js');
    const modelUrl = new URL(`../../${DINOSAUR_MODEL}`, import.meta.url).href;
    const skinUrl = new URL(`../../${DINOSAUR_SKIN}`, import.meta.url).href;
    const [{ scene, animations }, skinTexture] = await Promise.all([
      loadModelFile(modelUrl),
      loadTexture(skinUrl),
    ]);
    return { model: scene, clips: animations ?? [], skinTexture };
  } catch (error) {
    console.warn('Animated velociraptor unavailable; using factory-safe fallback', error);
    return { model: null, clips: [], skinTexture: null };
  }
}

function owned(entity, object) {
  if (object.geometry) entity._geometries.add(object.geometry);
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) if (material) entity._materials.add(material);
  return object;
}

function box(entity, parent, sx, sy, sz, material, x, y, z) {
  const mesh = owned(entity, new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material));
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(entity, parent, radius, height, material, x, y, z, segments = 24) {
  const mesh = owned(entity, new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, segments), material,
  ));
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function machineMaterial() {
  const photo = photoSurface('plate');
  return new THREE.MeshStandardMaterial({
    color: photo ? 0x9da7aa : 0x6e787c,
    map: photo?.map ?? null,
    normalMap: photo?.normalMap ?? null,
    aoMap: photo?.armMap ?? null,
    roughnessMap: photo?.armMap ?? null,
    metalnessMap: photo?.armMap ?? null,
    roughness: 0.4,
    metalness: 0.76,
  });
}

function makeLabelTexture() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 272;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
  grad.addColorStop(0, '#061912');
  grad.addColorStop(0.5, '#123929');
  grad.addColorStop(1, '#061912');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#58ff9c'; ctx.lineWidth = 8; ctx.strokeRect(6, 6, 1012, 260);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#dcffe8'; ctx.font = '800 70px system-ui, sans-serif';
  ctx.fillText(DINOSAUR_FACTORY_INSTRUCTIONS[0], 512, 67);
  ctx.fillStyle = '#75ffab'; ctx.font = '700 39px system-ui, sans-serif';
  ctx.fillText(DINOSAUR_FACTORY_INSTRUCTIONS[1], 512, 147);
  ctx.fillStyle = '#d1ffe0'; ctx.font = '600 31px system-ui, sans-serif';
  ctx.fillText(DINOSAUR_FACTORY_INSTRUCTIONS[2], 512, 216);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function fallbackRaptor(entity) {
  const root = new THREE.Group();
  root.name = 'procedural-raptor-fallback';
  const skin = new THREE.MeshStandardMaterial({
    color: 0x526f43, roughness: 0.92, metalness: 0,
    bumpMap: entity.skinTexture, bumpScale: entity.skinTexture ? 0.035 : 0,
    map: entity.skinTexture,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x172219, roughness: 0.88 });
  const ivory = new THREE.MeshStandardMaterial({ color: 0xd9d1b3, roughness: 0.74 });
  for (const m of [skin, dark, ivory]) entity._materials.add(m);

  const torso = owned(entity, new THREE.Mesh(new THREE.SphereGeometry(0.52, 22, 14), skin));
  torso.scale.set(1.38, 0.75, 0.72); torso.position.y = 0.93; root.add(torso);
  const neck = owned(entity, new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.35, 0.82, 16), skin));
  neck.rotation.z = -0.82; neck.position.set(0, 1.2, -0.48); root.add(neck);
  const head = owned(entity, new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.32, 0.72), skin));
  head.position.set(0, 1.47, -0.86); root.add(head);
  const jaw = owned(entity, new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.13, 0.62), dark));
  jaw.position.set(0, 1.32, -0.91); root.add(jaw);

  entity._fallbackLegs = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(side * 0.33, 0.78, 0.12); root.add(hip);
    const thigh = owned(entity, new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.12, 0.65, 12), skin));
    thigh.rotation.z = side * 0.22; thigh.position.y = -0.25; hip.add(thigh);
    const shin = owned(entity, new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.07, 0.62, 12), dark));
    shin.position.set(side * 0.08, -0.73, -0.08); hip.add(shin);
    const foot = owned(entity, new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.1, 0.48), dark));
    foot.position.set(side * 0.08, -1.02, -0.18); hip.add(foot);
    entity._fallbackLegs.push(hip);
  }
  entity._fallbackTail = [];
  for (let i = 0; i < 5; i++) {
    const segment = owned(entity, new THREE.Mesh(
      new THREE.CylinderGeometry(0.19 - i * 0.03, 0.15 - i * 0.027, 0.68, 12), skin,
    ));
    segment.rotation.x = Math.PI / 2;
    segment.position.set(0, 0.96 - i * 0.035, 0.68 + i * 0.56);
    root.add(segment); entity._fallbackTail.push(segment);
  }
  return root;
}

function ensureDinosaurUVs(geometry) {
  if (geometry.attributes.uv || !geometry.attributes.position) return !!geometry.attributes.uv;
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();
  const p = geometry.attributes.position;
  const n = geometry.attributes.normal;
  const b = geometry.boundingBox;
  const sx = Math.max(1e-5, b.max.x - b.min.x);
  const sy = Math.max(1e-5, b.max.y - b.min.y);
  const sz = Math.max(1e-5, b.max.z - b.min.z);
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (ax >= ay && ax >= az) {
      uv[i * 2] = (p.getZ(i) - b.min.z) / sz;
      uv[i * 2 + 1] = (p.getY(i) - b.min.y) / sy;
    } else if (ay >= az) {
      uv[i * 2] = (p.getX(i) - b.min.x) / sx;
      uv[i * 2 + 1] = (p.getZ(i) - b.min.z) / sz;
    } else {
      uv[i * 2] = (p.getX(i) - b.min.x) / sx;
      uv[i * 2 + 1] = (p.getY(i) - b.min.y) / sy;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return true;
}

export function prepareLoadedRaptor(entity, model) {
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  if (!Number.isFinite(size.y) || size.y <= 1e-5) return null;

  let texturedMeshes = 0;
  model.traverse((object) => {
    if (!object.isMesh) return;
    entity._geometries.add(object.geometry);
    object.castShadow = object.receiveShadow = true;
    const source = Array.isArray(object.material) ? object.material : [object.material];
    const hasUVs = ensureDinosaurUVs(object.geometry);
    const materials = source.map((original) => {
      const material = original?.clone?.() ?? new THREE.MeshStandardMaterial({ color: 0x657b4a });
      const protectedPart = /eye|tooth|teeth|tongue|claw|nail/i
        .test(`${object.name ?? ''} ${material.name ?? ''}`);
      if (!protectedPart && entity.skinTexture && hasUVs) {
        material.map = entity.skinTexture;
        material.bumpMap = entity.skinTexture;
        material.bumpScale = 0.034;
        material.color?.setHex?.(0xffffff);
        material.userData = { ...material.userData, dinosaurSkin: true };
        texturedMeshes++;
      }
      if ('roughness' in material) material.roughness = protectedPart ? 0.48 : 0.9;
      if ('metalness' in material) material.metalness = 0;
      // FBXLoader commonly yields MeshPhongMaterial. Its authored plastic
      // highlight otherwise washes the photograph blue-white under the game's
      // key light even though the texture is correctly attached.
      if ('shininess' in material) material.shininess = protectedPart ? 18 : 3;
      material.specular?.setHex?.(protectedPart ? 0x4d5148 : 0x161912);
      material.needsUpdate = true;
      entity._materials.add(material);
      return material;
    });
    object.material = Array.isArray(object.material) ? materials : materials[0];
  });

  const centred = new THREE.Group();
  model.position.set(-(bounds.min.x + bounds.max.x) * 0.5, -bounds.min.y,
    -(bounds.min.z + bounds.max.z) * 0.5);
  centred.add(model);
  const holder = new THREE.Group();
  holder.name = 'loaded-animated-velociraptor';
  holder.userData.dinosaurSkinTexture = entity.skinTexture ?? null;
  holder.userData.texturedMeshCount = texturedMeshes;
  holder.scale.setScalar(DINO_HEIGHT / size.y);
  // Quaternius authors the raptor looking down +Z; the game convention is -Z.
  holder.rotation.y = Math.PI;
  holder.add(centred);
  return { holder, animatedRoot: model };
}

export class DinosaurAlly {
  constructor(world, { model = null, clips = [], skinTexture = null } = {}) {
    this.world = world;
    this.skinTexture = skinTexture;
    this._geometries = new Set();
    this._materials = new Set();
    this.mesh = new THREE.Group();
    this.mesh.name = 'factory-velociraptor-ally';
    this.mesh.visible = false;
    this.pos = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.mode = 'stored';
    this.state = 'idle';
    this.attackAge = BITE_TIME;
    this.attackApplied = false;
    this.target = null;
    this.walkPhase = 0;
    this.disposed = false;
    this.nav = null;
    this._navStamp = -1;
    this._navTimer = 0;
    this._navGoal = null;
    this._trail = [];
    this._stuckFor = 0;
    this._recoveryCount = 0;

    const loaded = model ? prepareLoadedRaptor(this, model) : null;
    this.visual = loaded?.holder ?? fallbackRaptor(this);
    this.mesh.add(this.visual);
    this.usesLoadedModel = !!loaded;

    this.mixer = loaded && clips.length ? new THREE.AnimationMixer(loaded.animatedRoot) : null;
    this.actions = {};
    const classified = classifyDinosaurClips(clips);
    if (this.mixer) {
      for (const [name, clip] of Object.entries(classified)) {
        const action = this.mixer.clipAction(clip);
        if (name === 'attack' || name === 'death' || name === 'jump' || name === 'hit') {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        }
        this.actions[name] = action;
      }
      this._animation = null;
      this._play('idle', 0);
    }
  }

  get active() { return this.mode === 'active'; }

  _syncTransform() {
    this.mesh.position.set(this.pos.x, this.pos.y, this.pos.z);
    // AI yaw is the direction of travel (+Z at zero); the visual's authored
    // nose is -Z, so rotate it half a turn instead of moonwalking toward goals.
    this.mesh.rotation.y = this.yaw + DINOSAUR_MODEL_FORWARD_OFFSET;
  }

  _play(name, fade = 0.14) {
    if (!this.mixer || this._animation === name) return;
    const next = this.actions[name] ?? this.actions.idle;
    if (!next) return;
    const previous = this.actions[this._animation];
    next.enabled = true;
    next.reset().setEffectiveWeight(1).play();
    if (name === 'attack') next.setDuration(BITE_TIME);
    if (previous && previous !== next) previous.crossFadeTo(next, fade, true);
    this._animation = name;
  }

  beginIncubation(x, y, z, yaw) {
    this.mode = 'incubating';
    this.pos = { x, y, z };
    this.yaw = yaw;
    this._syncTransform();
    this.mesh.scale.setScalar(0.08);
    this.mesh.visible = true;
    this._play('idle', 0.08);
  }

  setGrowth(value) {
    if (this.mode !== 'incubating') return;
    const s = 0.08 + smoothstep(value) * 0.92;
    this.mesh.scale.setScalar(s);
  }

  hatch(x, y, z, yaw) {
    this.mode = 'active';
    this.pos = { x, y, z };
    this.yaw = yaw;
    this._syncTransform();
    this.mesh.scale.setScalar(1);
    this.mesh.visible = true;
    this.attackAge = BITE_TIME;
    this.target = null;
    this._play('idle', 0.12);
  }

  reset() {
    this.mode = 'stored';
    this.target = null;
    this.mesh.visible = false;
    this.mesh.scale.setScalar(1);
    this.attackAge = BITE_TIME;
    this.attackApplied = false;
    this._trail.length = 0;
    this._stuckFor = 0;
    this._navTimer = 0;
    this._navGoal = null;
  }

  _visibleTarget(enemy) {
    const dy = enemy.pos.y - this.pos.y;
    if (!enemy.alive || Math.abs(dy) > 3.2) return false;
    const dx = enemy.pos.x - this.pos.x;
    const dz = enemy.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > DINOSAUR_TARGET_RANGE) return false;
    if (!this.world.raycast || dist < 2.2) return true;
    const aimY = this.pos.y + DINO_HEIGHT * 0.56;
    const targetY = enemy.pos.y + enemy.type.height * 0.5;
    const len = Math.hypot(dx, targetY - aimY, dz) || 1;
    const hit = this.world.raycast(this.pos.x, aimY, this.pos.z,
      dx / len, (targetY - aimY) / len, dz / len, len);
    return !hit.hit || hit.distance >= len - enemy.type.width;
  }

  _nearestEnemy(enemies) {
    let best = null;
    let bestSq = DINOSAUR_TARGET_RANGE * DINOSAUR_TARGET_RANGE;
    for (const enemy of enemies ?? []) {
      if (!this._visibleTarget(enemy)) continue;
      const d = (enemy.pos.x - this.pos.x) ** 2 + (enemy.pos.z - this.pos.z) ** 2;
      if (d < bestSq) { bestSq = d; best = enemy; }
    }
    return best;
  }

  _groundAt(x, z) {
    const base = this.world.heightAt(x, z);
    if (!this.world.supportHeight) return base;
    return this.world.supportHeight(x, z, Math.max(this.pos.y, base) + 1.0, DINO_RADIUS, 0.9);
  }

  _clearAt(x, z) {
    const y = this._groundAt(x, z);
    if (this.world.inBounds && !this.world.inBounds(x, z)) return null;
    if (this.world.blocksAt?.(x, y, z, DINO_RADIUS, DINO_HEIGHT, 0.88)) return null;
    return y;
  }

  _moveToward(tx, tz, dt, stopAt, speedLimit = DINO_SPEED) {
    const dx = tx - this.pos.x;
    const dz = tz - this.pos.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= stopAt) return 0;
    const wantedYaw = Math.atan2(dx, dz);
    const step = Math.min(speedLimit * dt, distance - stopAt);
    const oldX = this.pos.x, oldZ = this.pos.z;

    // A centre-line path can skim a jamb or a desk even when the body does not
    // fit. Probe a compact steering fan and choose the clear step that makes
    // the most progress, which lets the companion round a door frame instead
    // of running in place against it forever.
    const offsets = [0, 0.24, -0.24, 0.48, -0.48, 0.78, -0.78, 1.08, -1.08];
    let best = null;
    let bestScore = -Infinity;
    for (const offset of offsets) {
      const heading = wantedYaw + offset;
      const nx = oldX + Math.sin(heading) * step;
      const nz = oldZ + Math.cos(heading) * step;
      const y = this._clearAt(nx, nz);
      if (y == null) continue;
      const remaining = Math.hypot(tx - nx, tz - nz);
      const score = distance - remaining - Math.abs(offset) * step * 0.075;
      if (score > bestScore) { bestScore = score; best = { x: nx, y, z: nz, heading }; }
    }

    if (!best || bestScore < -step * 0.08) {
      this.yaw += angleDelta(this.yaw, wantedYaw) * Math.min(1, dt * 8);
      return 0;
    }
    this.pos.x = best.x; this.pos.y = best.y; this.pos.z = best.z;
    this.yaw += angleDelta(this.yaw, best.heading) * Math.min(1, dt * 12);
    return Math.hypot(best.x - oldX, best.z - oldZ) / Math.max(dt, 1e-4);
  }

  _recordPlayer(player) {
    const point = { x: player.pos.x, y: player.pos.y, z: player.pos.z };
    const last = this._trail[this._trail.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.z - last.z) >= TRAIL_SPACING
      || Math.abs(point.y - last.y) > 0.7) {
      this._trail.push(point);
      if (this._trail.length > TRAIL_LIMIT) this._trail.splice(0, this._trail.length - TRAIL_LIMIT);
    }
    while (this._trail.length > 1
      && Math.hypot(this._trail[0].x - this.pos.x, this._trail[0].z - this.pos.z) < 0.92) {
      this._trail.shift();
    }
  }

  _segmentClear(point) {
    const dx = point.x - this.pos.x, dz = point.z - this.pos.z;
    const distance = Math.hypot(dx, dz);
    const samples = Math.ceil(distance / 0.34);
    for (let i = 1; i <= samples; i++) {
      const t = i / samples;
      if (this._clearAt(this.pos.x + dx * t, this.pos.z + dz * t) == null) return false;
    }
    return true;
  }

  _routeToward(tx, ty, tz, dt, useTrail) {
    // Prefer the route the player demonstrably walked when its next breadcrumb
    // has a clear segment. It naturally takes the same centre line through a
    // doorway and preserves the order of a ninety-degree turn.
    // Once only the current player point remains and the desired formation
    // point is clear, drop the breadcrumb: otherwise the ally crowds the
    // player's feet instead of settling into its intended trailing position.
    const goalClear = useTrail && this._segmentClear({ x: tx, y: ty, z: tz });
    const trail = useTrail && (this._trail.length > 1 || !goalClear) ? this._trail[0] : null;
    if (trail && Math.hypot(trail.x - this.pos.x, trail.z - this.pos.z) > 0.3
      && this._segmentClear(trail)) {
      return { ...trail, trail: true };
    }

    if (this.world.plan) {
      if (!this.nav) {
        this.nav = new NavGrid(this.world);
        this._navStamp = this.world.props?.length ?? 0;
        this._navTimer = 0;
      }
      const stamp = this.world.props?.length ?? 0;
      if (stamp !== this._navStamp) {
        this._navStamp = stamp;
        this.nav.rebuild();
        this._navTimer = 0;
      }
      this._navTimer -= dt;
      const shifted = !this._navGoal
        || Math.hypot(tx - this._navGoal.x, tz - this._navGoal.z) > 0.48
        || Math.abs(ty - this._navGoal.y) > 0.7;
      const needsSweep = !this._navGoal || shifted || this._stuckFor > 0.8;
      if (needsSweep && this._navTimer <= 0) {
        this.nav.update(tx, tz, ty);
        this._navGoal = { x: tx, y: ty, z: tz };
        this._navTimer = NAV_REFRESH;
      }
      const step = this.nav.stepFrom(this.pos.x, this.pos.z, this.pos.y);
      if (step) return { x: step.x, y: step.y, z: step.z, nav: true };
    }

    // The trail is a second, player-authored route. It is especially useful at
    // tight ninety-degree door approaches where a coarse grid cell can be on
    // the correct side of the wall but too close to a jamb for the raptor.
    if (trail && Math.hypot(trail.x - this.pos.x, trail.z - this.pos.z) > 0.3) {
      return { ...trail, trail: true };
    }
    return null;
  }

  _catchupSpeed(player) {
    const distance = Math.hypot(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
    return DINO_SPEED + (DINOSAUR_MAX_CATCHUP_SPEED - DINO_SPEED)
      * smoothstep((distance - 8) / 22);
  }

  _nudgeFromStuck() {
    if (!this.nav || this._stuckFor < 2.4) return false;
    const here = this.nav.distanceAt(this.pos.x, this.pos.z, this.pos.y);
    let best = null;
    for (const radius of [0.42, 0.68, 0.94]) {
      for (let i = 0; i < 16; i++) {
        const angle = i / 16 * Math.PI * 2;
        const x = this.pos.x + Math.sin(angle) * radius;
        const z = this.pos.z + Math.cos(angle) * radius;
        const y = this._clearAt(x, z);
        if (y == null) continue;
        const distance = this.nav.distanceAt(x, z, y);
        if (distance === NAV_UNREACHED || distance >= here) continue;
        if (!best || distance < best.distance) best = { x, y, z, distance };
      }
      if (best) break;
    }
    if (!best) {
      this.nav.rebuild();
      this._navTimer = 0;
      return false;
    }
    // This is a sub-metre correction after sustained collision, not the old
    // long-range teleport to the player's heels. It rescues a body whose
    // centre has rounded into a jamb while remaining visually local.
    this.pos.x = best.x; this.pos.y = best.y; this.pos.z = best.z;
    this._stuckFor = 0;
    this._recoveryCount++;
    return true;
  }

  _fallbackPose(dt, speed) {
    if (!this._fallbackLegs) return;
    this.walkPhase += dt * (speed > 0.2 ? 10 : 2.2);
    const stride = speed > 0.2 ? 0.48 : 0.05;
    this._fallbackLegs[0].rotation.x = Math.sin(this.walkPhase) * stride;
    this._fallbackLegs[1].rotation.x = -Math.sin(this.walkPhase) * stride;
    for (let i = 0; i < this._fallbackTail.length; i++) {
      this._fallbackTail[i].rotation.z = Math.sin(this.walkPhase * 0.55 + i * 0.45) * 0.11;
    }
    this.visual.position.y = speed > 0.2 ? Math.abs(Math.sin(this.walkPhase)) * 0.025 : 0;
  }

  /** Tick follow/target/attack behavior and return a bite event when one lands. */
  update(dt, player, enemies, damageEnemy) {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return null;
    this.mixer?.update(dt);
    if (!this.active || !player?.alive) {
      this._fallbackPose(dt, 0);
      return null;
    }

    this._recordPlayer(player);
    if (!this.target?.alive || !this._visibleTarget(this.target)) this.target = this._nearestEnemy(enemies);

    if (this.attackAge < BITE_TIME) {
      this.attackAge += dt;
      this.state = 'attack';
      this._play('attack', 0.08);
      let event = null;
      if (!this.attackApplied && this.attackAge >= BITE_IMPACT) {
        this.attackApplied = true;
        const target = this.target;
        if (target?.alive && Math.hypot(target.pos.x - this.pos.x,
          target.pos.z - this.pos.z) <= DINOSAUR_ATTACK_RANGE + 0.7) {
          const result = damageEnemy?.(target, DINOSAUR_BITE_DAMAGE) ?? null;
          event = { kind: 'bite', enemy: target, damage: DINOSAUR_BITE_DAMAGE,
            killed: !!result?.killed };
        }
      }
      if (this.attackAge >= BITE_TIME) this._play('idle', 0.1);
      this._fallbackPose(dt, 0);
      return event;
    }

    let tx, tz, stopAt;
    if (this.target?.alive) {
      tx = this.target.pos.x; tz = this.target.pos.z; stopAt = DINOSAUR_ATTACK_RANGE;
      const d = Math.hypot(tx - this.pos.x, tz - this.pos.z);
      if (d <= DINOSAUR_ATTACK_RANGE + 0.12) {
        this.attackAge = 0;
        this.attackApplied = false;
        this.state = 'attack';
        this._play('attack', 0.08);
        return null;
      }
    } else {
      const behind = player.yaw + Math.PI;
      tx = player.pos.x + Math.sin(behind) * 2.25;
      tz = player.pos.z + Math.cos(behind) * 2.25;
      stopAt = 1.05;
    }

    const targetY = this.target?.alive ? this.target.pos.y : player.pos.y;
    const route = this._routeToward(tx, targetY, tz, dt, !this.target?.alive);
    const moveTarget = route ?? { x: tx, y: targetY, z: tz };
    const speedLimit = this.target?.alive ? DINO_SPEED : this._catchupSpeed(player);
    let speed = this._moveToward(moveTarget.x, moveTarget.z, dt,
      route ? 0.08 : stopAt, speedLimit);
    const remaining = Math.hypot(tx - this.pos.x, tz - this.pos.z);
    if (speed < 0.12 && remaining > stopAt + 0.35) this._stuckFor += dt;
    else this._stuckFor = Math.max(0, this._stuckFor - dt * 2);
    if (this._nudgeFromStuck()) speed = Math.max(speed, DINO_SPEED);
    this._syncTransform();
    this.state = speed > 3.2 ? 'run' : speed > 0.15 ? 'walk' : 'idle';
    this._play(this.state, 0.16);
    if (this.actions[this.state]) this.actions[this.state].setEffectiveTimeScale(
      this.state === 'run' ? Math.max(0.82, speed / DINO_SPEED) : 1,
    );
    this._fallbackPose(dt, speed);
    return null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer?.stopAllAction();
    for (const geometry of this._geometries) geometry.dispose?.();
    for (const material of this._materials) material.dispose?.();
    this.skinTexture?.dispose?.();
    this._geometries.clear(); this._materials.clear();
  }
}

export class DinosaurFactory {
  constructor(prop, world, asset = {}) {
    if (!prop?.collider) throw new TypeError('DinosaurFactory requires its furniture prop');
    this.prop = prop;
    this.world = world;
    this.x = prop.x; this.y = prop.y; this.z = prop.z; this.yaw = prop.rot ?? 0;
    this.productionAge = DINOSAUR_PRODUCTION_TIME;
    this.producing = false;
    this.disposed = false;
    this._idle = 0;
    this._geometries = new Set();
    this._materials = new Set();

    // The entity root stays in world coordinates because the ally leaves the
    // machine. Only factoryRoot carries the authored prop transform.
    this.mesh = new THREE.Group();
    this.mesh.name = 'dinosaur-factory-system';
    this.mesh.userData.kind = DINOSAUR_FACTORY_KIND;
    this.factoryRoot = new THREE.Group();
    this.factoryRoot.position.set(this.x, this.y, this.z);
    this.factoryRoot.rotation.y = this.yaw;
    this.mesh.add(this.factoryRoot);

    const metal = machineMaterial();
    const dark = new THREE.MeshStandardMaterial({ color: 0x111719, roughness: 0.34, metalness: 0.88 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x080b0c, roughness: 0.92, metalness: 0.05 });
    const bio = new THREE.MeshStandardMaterial({
      color: 0x49f58d, emissive: 0x0b7b3d, emissiveIntensity: 1.5,
      roughness: 0.28, metalness: 0.12,
    });
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x9dffd1, emissive: 0x063d22, emissiveIntensity: 0.32,
      roughness: 0.06, metalness: 0, transparent: true, opacity: 0.2,
      depthWrite: false, side: THREE.DoubleSide,
    });
    for (const material of [metal, dark, rubber, bio, glass]) this._materials.add(material);

    // Back bank, side refrigeration towers and a heavy floor plinth.
    box(this, this.factoryRoot, 2.72, 2.72, 0.48, metal, 0, 1.36, -0.36);
    box(this, this.factoryRoot, 2.78, 0.18, 1.18, dark, 0, 0.09, -0.02);
    for (const side of [-1, 1]) {
      box(this, this.factoryRoot, 0.53, 2.32, 0.66, dark, side * 1.05, 1.21, -0.04);
      for (let i = 0; i < 5; i++) {
        box(this, this.factoryRoot, 0.37, 0.045, 0.035, bio,
          side * 1.05, 0.48 + i * 0.34, 0.31);
      }
    }

    // Central glass incubation vessel, real rings and overhead injector.
    cylinder(this, this.factoryRoot, 0.54, 1.82, glass, 0, 1.22, 0.08, 32);
    for (const y of [0.3, 2.13]) {
      const ring = owned(this, new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.065, 10, 32), dark));
      ring.rotation.x = Math.PI / 2; ring.position.set(0, y, 0.08);
      ring.castShadow = true; this.factoryRoot.add(ring);
    }
    cylinder(this, this.factoryRoot, 0.13, 0.48, metal, 0, 2.48, 0.08, 18);
    const injector = cylinder(this, this.factoryRoot, 0.055, 0.34, bio, 0, 2.2, 0.08, 14);
    injector.userData.injector = true;
    cylinder(this, this.factoryRoot, 0.49, 0.08, bio, 0, 0.27, 0.08, 28);

    // Split hatch doors pivot out so the release is legible from down the room.
    this.leftDoor = new THREE.Group(); this.leftDoor.position.set(-0.53, 1.2, 0.54);
    this.rightDoor = new THREE.Group(); this.rightDoor.position.set(0.53, 1.2, 0.54);
    box(this, this.leftDoor, 0.52, 1.72, 0.07, glass, 0.26, 0, 0);
    box(this, this.rightDoor, 0.52, 1.72, 0.07, glass, -0.26, 0, 0);
    this.factoryRoot.add(this.leftDoor, this.rightDoor);

    // Angled control desk and cycle-progress display.
    box(this, this.factoryRoot, 0.82, 0.68, 0.46, metal, 0.94, 0.52, 0.53);
    const panel = box(this, this.factoryRoot, 0.68, 0.28, 0.04, bio, 0.94, 0.78, 0.77);
    panel.rotation.x = -0.33;
    this.progressBar = box(this, this.factoryRoot, 0.48, 0.035, 0.025, bio, 0.94, 0.8, 0.805);

    const labelTexture = makeLabelTexture();
    this.labelTexture = labelTexture;
    const labelMaterial = new THREE.MeshBasicMaterial({
      color: labelTexture ? 0xffffff : 0x58ff9c,
      map: labelTexture,
      toneMapped: false,
    });
    this._materials.add(labelMaterial);
    const label = owned(this, new THREE.Mesh(new THREE.PlaneGeometry(2.34, 0.62), labelMaterial));
    label.name = 'dinosaur-factory-instructions';
    label.userData.instructions = [...DINOSAUR_FACTORY_INSTRUCTIONS];
    label.position.set(0, 2.4, -0.105); this.factoryRoot.add(label);
    this.instructionLabel = label;

    this.statusMaterial = bio;
    this.ally = new DinosaurAlly(world, asset);
    this.mesh.add(this.ally.mesh);
  }

  get ready() { return !this.disposed && !this.producing && !this.ally.active; }
  get deployed() { return this.ally.active; }

  inRange(player) {
    if (this.disposed || !player?.pos) return false;
    const dx = Number(player.pos.x) - this.x;
    const dz = Number(player.pos.z) - this.z;
    const front = dx * Math.sin(this.yaw) + dz * Math.cos(this.yaw);
    const side = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
    const py = Number(player.pos.y) + (Number(player.height) || 1.8) * 0.5;
    return Number.isFinite(front) && Number.isFinite(side) && Number.isFinite(py)
      && front > -0.15 && front < DINOSAUR_FACTORY_RANGE
      && Math.abs(side) < 1.8
      && Math.abs(py - (this.y + 1.25)) < 2.3;
  }

  prompt(coins = Infinity) {
    if (this.producing) {
      return `CLONING VELOCIRAPTOR · ${Math.min(99,
        Math.round(this.productionAge / DINOSAUR_PRODUCTION_TIME * 100))}%`;
    }
    if (this.ally.active) return 'VELOCIRAPTOR DEPLOYED · HUNTING WITH YOU';
    return coins >= DINOSAUR_FACTORY_COST
      ? `CLONE VELOCIRAPTOR (${DINOSAUR_FACTORY_COST})`
      : `DINOSAUR FACTORY · NEED ${DINOSAUR_FACTORY_COST - coins} COINS`;
  }

  start() {
    if (!this.ready) return false;
    this.producing = true;
    this.productionAge = 0;
    const x = this.x + Math.sin(this.yaw) * 0.14;
    const z = this.z + Math.cos(this.yaw) * 0.14;
    this.ally.beginIncubation(x, this.y + 0.27, z, this.yaw);
    return true;
  }

  update(dt, player, enemies, damageEnemy) {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return null;
    this._idle += dt;
    let event = null;
    if (this.producing) {
      this.productionAge = Math.min(DINOSAUR_PRODUCTION_TIME, this.productionAge + dt);
      const t = this.productionAge / DINOSAUR_PRODUCTION_TIME;
      this.ally.setGrowth(clamp01((t - 0.08) / 0.68));
      const open = smoothstep(clamp01((t - 0.68) / 0.22));
      this.leftDoor.rotation.y = -open * 1.18;
      this.rightDoor.rotation.y = open * 1.18;
      this.progressBar.scale.x = Math.max(0.02, t);
      this.progressBar.position.x = 0.7 + 0.24 * this.progressBar.scale.x;
      this.statusMaterial.emissiveIntensity = 1.6 + Math.sin(this._idle * 15) * 0.55;
      this.ally.mixer?.update(dt);
      this.ally._fallbackPose(dt, 0);

      if (this.productionAge >= DINOSAUR_PRODUCTION_TIME) {
        this.producing = false;
        const x = this.x + Math.sin(this.yaw) * HATCH_FRONT;
        const z = this.z + Math.cos(this.yaw) * HATCH_FRONT;
        // The hatch sits on a building slab. Terrain-only heightAt() would
        // bury the new companion under that floor before its first AI tick.
        const y = this.ally._groundAt(x, z);
        this.ally.hatch(x, y, z, this.yaw);
        event = { kind: 'hatched' };
      }
    } else if (this.ally.active) {
      event = this.ally.update(dt, player, enemies, damageEnemy);
      this.statusMaterial.emissiveIntensity = 1.05 + Math.sin(this._idle * 2.8) * 0.18;
    } else {
      this.statusMaterial.emissiveIntensity = 1.35 + Math.sin(this._idle * 3.4) * 0.22;
      this.progressBar.scale.x = 1;
      this.progressBar.position.x = 0.94;
    }
    return event;
  }

  reset() {
    if (this.disposed) return;
    this.producing = false;
    this.productionAge = DINOSAUR_PRODUCTION_TIME;
    this.leftDoor.rotation.y = 0; this.rightDoor.rotation.y = 0;
    this.progressBar.scale.x = 1; this.progressBar.position.x = 0.94;
    this.ally.reset();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ally.dispose();
    for (const geometry of this._geometries) geometry.dispose?.();
    for (const material of this._materials) material.dispose?.();
    this.labelTexture?.dispose?.();
    this._geometries.clear(); this._materials.clear();
  }
}

export async function createDinosaurFactory(world, options = {}) {
  const prop = findDinosaurFactoryProp(world);
  if (!prop) return null;
  const asset = options.asset ?? await loadDinosaurAsset();
  return new DinosaurFactory(prop, world, asset);
}
