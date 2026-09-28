// HUMAN OBSERVATION: the aquarium is the visitor and the players are the exhibit.
//
// The world plan assigns one deeper indoor room to the landmark. This module is
// deliberately render-only: the conduit sits at eye-catching mid-room height
// while remaining above player headroom, so adding collision would make
// navigation pay for geometry no body can reach. Every
// downloaded model is optional; an empty assets tree still gets a complete
// procedural school and the same observation behaviour.

import * as THREE from '../../vendor/three.module.js';
import { MAP_COMPLEX } from '../world/world.js';
import { FLOOR_H, REVERSE_AQUARIUM_ROLE } from '../world/complex.js';
import { photoSurface } from '../render/photosets.js';

export const REVERSE_AQUARIUM_KIND = 'reverse_aquarium';
export const REVERSE_AQUARIUM_CAUSTICS =
  'assets/textures/reverse_aquarium/caustics.webp';
export const REVERSE_AQUARIUM_MODELS = Object.freeze([
  { id: 'barramundi', path: 'assets/creatures/aquarium/BarramundiFish.glb', length: 1.03, speed: 0.044 },
  { id: 'fish-amber', path: 'assets/creatures/animated_fish_pack/Fish1.fbx', length: 0.72, speed: 0.052 },
  { id: 'fish-blue', path: 'assets/creatures/animated_fish_pack/Fish2.fbx', length: 0.68, speed: 0.058 },
  { id: 'fish-striped', path: 'assets/creatures/animated_fish_pack/Fish3.fbx', length: 0.66, speed: 0.061 },
  { id: 'shark', path: 'assets/creatures/animated_fish_pack/Shark.fbx', length: 1.08, speed: 0.042 },
  { id: 'manta', path: 'assets/creatures/animated_fish_pack/Manta ray.fbx', length: 0.88, speed: 0.045 },
  { id: 'dolphin', path: 'assets/creatures/animated_fish_pack/Dolphin.fbx', length: 0.98, speed: 0.048 },
  { id: 'whale', path: 'assets/creatures/animated_fish_pack/Whale.fbx', length: 1.12, speed: 0.036 },
]);

export const AQUARIUM_TUBE_RADIUS = 0.38;
export const AQUARIUM_BUBBLE_RADIUS = 0.45;
export const AQUARIUM_CENTRE_ABOVE_FLOOR = 2.35;
export const AQUARIUM_LOWEST_POINT =
  AQUARIUM_CENTRE_ABOVE_FLOOR - AQUARIUM_BUBBLE_RADIUS - 0.02;
export const AQUARIUM_SIGN_LINES = Object.freeze([
  'HUMAN OBSERVATION',
  'SUBJECT HABITAT 04  •  LIVE SPECIMENS',
  'DO NOT TAP — HUMANS MAY STARTLE',
]);

const FORWARD = new THREE.Vector3(0, 0, -1);
const VEC = new THREE.Vector3();
const QUAT = new THREE.Quaternion();

function clamp01(value) { return Math.max(0, Math.min(1, value)); }

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** The authored room, or null on the arena and old/generated plans. */
export function findReverseAquariumRoom(world) {
  if (!world || world.mapId !== MAP_COMPLEX || !world.plan?.rooms) return null;
  const id = world.plan.reverseAquariumRoom;
  return world.plan.rooms.find((room) => room.id === id
    && room.role?.id === REVERSE_AQUARIUM_ROLE) ?? null;
}

/** Local-space path; callers can inspect it without creating WebGL state. */
export function buildAquariumPath(room) {
  if (!room) return null;
  const alongX = (room.maxX - room.minX) >= (room.maxZ - room.minZ);
  const span = Math.max(room.maxX - room.minX, room.maxZ - room.minZ);
  const half = Math.max(3.2, span / 2 - 0.48);
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-half, 0.01, 0),
    new THREE.Vector3(-half * 0.62, 0.01, 0.08),
    new THREE.Vector3(-half * 0.25, -0.01, -0.04),
    new THREE.Vector3(0, -0.02, 0),
    new THREE.Vector3(half * 0.25, -0.01, 0.05),
    new THREE.Vector3(half * 0.62, 0.01, -0.07),
    new THREE.Vector3(half, 0.01, 0),
  ], false, 'catmullrom', 0.35);
  return { path, alongX, half, span };
}

/** Vertical clearance from the floor to the landmark's lowest glass surface. */
export function reverseAquariumClearance(room) {
  return room ? AQUARIUM_LOWEST_POINT : 0;
}

/** True only while a body is standing inside the authored human enclosure. */
export function insideReverseAquarium(room, position) {
  if (!room || !position) return false;
  return position.x >= room.minX && position.x <= room.maxX
    && position.z >= room.minZ && position.z <= room.maxZ
    && position.y >= room.floorY && position.y <= room.floorY + FLOOR_H;
}

function track(entity, object) {
  if (object.geometry) entity._geometries.add(object.geometry);
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) if (material) entity._materials.add(material);
  return object;
}

function metalMaterial() {
  const photo = photoSurface('plate');
  return new THREE.MeshStandardMaterial({
    color: photo ? 0xaeb8bb : 0x59676b,
    map: photo?.map ?? null,
    normalMap: photo?.normalMap ?? null,
    aoMap: photo?.armMap ?? null,
    roughnessMap: photo?.armMap ?? null,
    metalnessMap: photo?.armMap ?? null,
    roughness: 0.34,
    metalness: 0.78,
  });
}

function makeSignTexture() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1400; canvas.height = 360;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, '#031317');
  gradient.addColorStop(0.5, '#0b3038');
  gradient.addColorStop(1, '#031317');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#5deaff'; ctx.lineWidth = 10; ctx.strokeRect(7, 7, 1386, 346);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#d9fbff'; ctx.font = '800 82px system-ui, sans-serif';
  ctx.fillText(AQUARIUM_SIGN_LINES[0], 700, 88);
  ctx.fillStyle = '#71e5f4'; ctx.font = '700 42px system-ui, sans-serif';
  ctx.fillText(AQUARIUM_SIGN_LINES[1], 700, 192);
  ctx.fillStyle = '#ffd37b'; ctx.font = '800 47px system-ui, sans-serif';
  ctx.fillText(AQUARIUM_SIGN_LINES[2], 700, 290);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

async function loadCausticsTexture() {
  if (typeof Image === 'undefined') return null;
  try {
    const url = new URL(`../../${REVERSE_AQUARIUM_CAUSTICS}`, import.meta.url).href;
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(3.2, 2.1);
    texture.anisotropy = 8;
    return texture;
  } catch (error) {
    console.warn('Aquarium caustics unavailable; using lit water fallback', error);
    return null;
  }
}

/** Load every small CC0 species. Failure of one never rejects the landmark. */
export async function loadReverseAquariumAssets() {
  if (typeof window === 'undefined') return { species: [], causticsTexture: null };
  const { loadModelFile } = await import('../render/loadmodel.js');
  const species = await Promise.all(REVERSE_AQUARIUM_MODELS.map(async (spec) => {
    try {
      const loaded = await loadModelFile(new URL(`../../${spec.path}`, import.meta.url).href);
      return { ...spec, model: loaded.scene, clips: loaded.animations ?? [] };
    } catch (error) {
      console.warn(`Aquarium species unavailable: ${spec.path}`, error);
      return null;
    }
  }));
  return {
    species: species.filter(Boolean),
    causticsTexture: await loadCausticsTexture(),
  };
}

function materialArray(material) {
  return Array.isArray(material) ? material : [material];
}

/** Centre, orient and re-material a downloaded fish around local -Z. */
export function prepareLoadedFish(entity, asset) {
  const model = asset?.model;
  if (!model) return null;
  model.updateMatrixWorld(true);
  let bounds = new THREE.Box3().setFromObject(model);
  if (bounds.isEmpty()) return null;
  let size = bounds.getSize(new THREE.Vector3());

  // The installed packs use two authoring axes: Barramundi is lengthwise on X,
  // while the Quaternius FBX school is lengthwise on Z and points toward +Z.
  // Normalize both here so every downstream path/look quaternion can keep one
  // honest contract: the visible nose points along local -Z.
  const oriented = new THREE.Group();
  if (size.x >= size.z) oriented.rotation.y = Math.PI / 2; // +X -> -Z
  else oriented.rotation.y = Math.PI; // +Z -> -Z
  oriented.add(model);
  oriented.updateMatrixWorld(true);
  bounds = new THREE.Box3().setFromObject(oriented);
  size = bounds.getSize(new THREE.Vector3());
  const length = Math.max(size.x, size.z, 0.001);
  const scale = asset.length / length;
  oriented.scale.setScalar(scale);
  oriented.updateMatrixWorld(true);
  bounds = new THREE.Box3().setFromObject(oriented);

  // The holder's origin is the animal's centre, which makes path rotation and
  // the downward observation turn behave like swimming rather than orbiting.
  const centre = bounds.getCenter(new THREE.Vector3());
  oriented.position.sub(centre);
  const holder = new THREE.Group();
  holder.name = `loaded-aquarium-${asset.id}`;
  holder.add(oriented);

  let meshes = 0;
  model.traverse((object) => {
    if (!object.isMesh) return;
    meshes++;
    const converted = materialArray(object.material).map((source) => {
      const material = new THREE.MeshPhysicalMaterial({
        color: source?.color?.clone?.() ?? new THREE.Color(0x799aa0),
        map: source?.map ?? null,
        normalMap: source?.normalMap ?? null,
        normalScale: source?.normalScale?.clone?.() ?? new THREE.Vector2(1, 1),
        aoMap: source?.aoMap ?? null,
        roughnessMap: source?.roughnessMap ?? null,
        metalnessMap: source?.metalnessMap ?? null,
        emissiveMap: source?.emissiveMap ?? null,
        emissive: source?.emissive?.clone?.() ?? new THREE.Color(0),
        emissiveIntensity: source?.emissiveIntensity ?? 1,
        roughness: source?.roughness ?? 0.28,
        metalness: Math.min(0.08, source?.metalness ?? 0.02),
        clearcoat: 0.42,
        clearcoatRoughness: 0.22,
        envMapIntensity: 1.2,
        transparent: !!source?.transparent,
        opacity: source?.opacity ?? 1,
        alphaTest: source?.alphaTest ?? 0,
        side: source?.side ?? THREE.FrontSide,
      });
      entity._materials.add(material);
      return material;
    });
    object.material = Array.isArray(object.material) ? converted : converted[0];
    object.castShadow = object.receiveShadow = true;
    entity._geometries.add(object.geometry);
  });
  if (!meshes) return null;
  holder.userData.loaded = true;
  holder.userData.species = asset.id;
  return { holder, animatedRoot: model };
}

function fallbackFish(entity, index, length) {
  const root = new THREE.Group();
  root.name = `procedural-aquarium-fish-${index}`;
  const colours = [0xb86a3e, 0x467eb1, 0xc8a344, 0x708c91, 0x394f73, 0x537c88, 0x50567d];
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: colours[index % colours.length], roughness: 0.3, metalness: 0.02,
    clearcoat: 0.38, clearcoatRoughness: 0.24,
  });
  const finMat = new THREE.MeshStandardMaterial({
    color: 0x273d43, roughness: 0.52, metalness: 0.02,
    side: THREE.DoubleSide,
  });
  const eyeMat = new THREE.MeshPhysicalMaterial({ color: 0x090b0c, roughness: 0.08, clearcoat: 1 });
  entity._materials.add(bodyMat); entity._materials.add(finMat); entity._materials.add(eyeMat);

  const body = track(entity, new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 12), bodyMat));
  body.scale.set(length * 0.34, length * 0.25, length);
  body.castShadow = body.receiveShadow = true;
  root.add(body);

  const tailShape = new THREE.BufferGeometry();
  tailShape.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0, -length * 0.30, length * 0.35, length * 0.43,
    length * 0.30, length * 0.35, length * 0.43,
    0, 0, 0, length * 0.30, -length * 0.35, length * 0.43,
    -length * 0.30, -length * 0.35, length * 0.43,
  ], 3));
  tailShape.computeVertexNormals(); entity._geometries.add(tailShape);
  const tail = new THREE.Mesh(tailShape, finMat);
  tail.position.z = length * 0.40;
  root.add(tail);

  const fin = track(entity, new THREE.Mesh(new THREE.ConeGeometry(length * 0.18, length * 0.45, 3), finMat));
  fin.rotation.x = Math.PI / 2; fin.position.set(0, length * 0.20, length * 0.05);
  root.add(fin);
  for (const side of [-1, 1]) {
    const eye = track(entity, new THREE.Mesh(new THREE.SphereGeometry(length * 0.035, 10, 7), eyeMat));
    eye.position.set(side * length * 0.22, length * 0.08, -length * 0.38);
    root.add(eye);
  }
  root.userData.tail = tail;
  root.userData.loaded = false;
  return root;
}

function ring(entity, parent, material, x, radius, tube = 0.045) {
  const mesh = track(entity, new THREE.Mesh(
    new THREE.TorusGeometry(radius, tube, 10, 32), material,
  ));
  mesh.position.x = x;
  mesh.rotation.y = Math.PI / 2;
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export class ReverseAquarium {
  constructor(room, world, { species = [], causticsTexture = null } = {}) {
    if (!room) throw new TypeError('ReverseAquarium requires its authored room');
    this.room = room;
    this.world = world;
    this.disposed = false;
    this.elapsed = 0;
    this._geometries = new Set();
    this._materials = new Set();
    this._textures = new Set();
    if (causticsTexture) this._textures.add(causticsTexture);

    const route = buildAquariumPath(room);
    this.path = route.path;
    this.half = route.half;
    this.alongX = route.alongX;
    this.mesh = new THREE.Group();
    this.mesh.name = 'reverse-aquarium-system';
    this.mesh.userData.kind = REVERSE_AQUARIUM_KIND;
    this.mesh.position.set(room.cx, room.floorY + AQUARIUM_CENTRE_ABOVE_FLOOR, room.cz);
    this.mesh.rotation.y = route.alongX ? 0 : -Math.PI / 2;

    const metal = metalMaterial(); this._materials.add(metal);
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xbbeeff, roughness: 0.06, metalness: 0,
      transmission: 0.18, transparent: true, opacity: 0.17,
      depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.25,
    });
    const water = new THREE.MeshPhysicalMaterial({
      color: 0x38aebe,
      map: causticsTexture,
      emissiveMap: causticsTexture,
      emissive: new THREE.Color(0x082d39), emissiveIntensity: 0.48,
      roughness: 0.18, metalness: 0,
      transparent: true, opacity: 0.26, depthWrite: false,
      side: THREE.BackSide,
    });
    this._materials.add(glass); this._materials.add(water);

    const waterTube = track(this, new THREE.Mesh(
      new THREE.TubeGeometry(this.path, 80, AQUARIUM_TUBE_RADIUS - 0.035, 14, false), water,
    ));
    waterTube.renderOrder = 1; this.mesh.add(waterTube);
    const glassTube = track(this, new THREE.Mesh(
      new THREE.TubeGeometry(this.path, 80, AQUARIUM_TUBE_RADIUS, 16, false), glass,
    ));
    glassTube.renderOrder = 4; this.mesh.add(glassTube);
    this.waterMaterial = water;

    // The wider centre chamber is where each animal can deliberately stop and
    // look out. Glass alone can read as a fat pipe; a framed spherical bay
    // reads as an observation instrument.
    const bubble = track(this, new THREE.Mesh(
      new THREE.SphereGeometry(AQUARIUM_BUBBLE_RADIUS, 28, 18), glass,
    ));
    bubble.position.copy(this.path.getPointAt(0.5));
    bubble.scale.x = 1.18; bubble.renderOrder = 4; this.mesh.add(bubble);
    ring(this, this.mesh, metal, 0, AQUARIUM_BUBBLE_RADIUS * 1.02, 0.06);
    for (const t of [0.02, 0.16, 0.31, 0.69, 0.84, 0.98]) {
      const p = this.path.getPointAt(t);
      ring(this, this.mesh, metal, p.x, AQUARIUM_TUBE_RADIUS + 0.055);
    }

    // Heavy wall collars make the water route feel connected to unseen life
    // support rather than capped inside the room.
    const collarGeo = new THREE.CylinderGeometry(0.56, 0.56, 0.30, 28, 1, true);
    collarGeo.rotateZ(Math.PI / 2); this._geometries.add(collarGeo);
    for (const x of [-this.half, this.half]) {
      const collar = new THREE.Mesh(collarGeo, metal);
      collar.position.set(x, 0.01, 0); collar.castShadow = collar.receiveShadow = true;
      this.mesh.add(collar);
    }

    // Photographic caustics projected onto the slab are the cue that this is a
    // volume of real water, not merely cyan glass.
    const shortSpan = Math.min(room.maxX - room.minX, room.maxZ - room.minZ);
    const floorMat = new THREE.MeshBasicMaterial({
      color: causticsTexture ? 0x75dce8 : 0x388d99,
      map: causticsTexture, transparent: true, opacity: causticsTexture ? 0.055 : 0.025,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this._materials.add(floorMat);
    const floorGlow = track(this, new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(route.span * 0.72, 9.5), Math.min(shortSpan * 0.64, 6.0)),
      floorMat,
    ));
    floorGlow.rotation.x = -Math.PI / 2;
    floorGlow.position.y = -AQUARIUM_CENTRE_ABOVE_FLOOR + 0.022;
    floorGlow.renderOrder = 1; this.mesh.add(floorGlow);
    this.floorMaterial = floorMat;

    // Put the exhibit label on a low freestanding stake, facing the observation
    // tube like a placard the fish installed for themselves. Pick the side of
    // the room opposite the refuge shutter so the label can never cover its
    // sight line or opening.
    this.labelTexture = makeSignTexture();
    if (this.labelTexture) this._textures.add(this.labelTexture);
    const labelMat = new THREE.MeshBasicMaterial({
      color: this.labelTexture ? 0xffffff : 0x69e9f8,
      map: this.labelTexture, side: THREE.DoubleSide, toneMapped: false,
    });
    this._materials.add(labelMat);
    this.mesh.updateMatrixWorld(true);
    const door = world.interactableDoors?.().find((prop) => prop.reclosable && prop.aquarium);
    const doorLocal = door ? this.mesh.worldToLocal(new THREE.Vector3(
      (door.collider.minX + door.collider.maxX) / 2,
      (door.collider.minY + door.collider.maxY) / 2,
      (door.collider.minZ + door.collider.maxZ) / 2,
    )) : null;
    const signZ = doorLocal?.z > 0
      ? -Math.min(2.6, shortSpan * 0.22)
      : Math.min(2.6, shortSpan * 0.22);
    const signStand = new THREE.Group();
    signStand.name = 'human-observation-sign-stand';
    signStand.userData.freestanding = true;
    signStand.userData.facesFish = true;
    signStand.position.set(0, -AQUARIUM_CENTRE_ABOVE_FLOOR, signZ);
    signStand.rotation.y = signZ > 0 ? Math.PI : 0;

    const backing = track(this, new THREE.Mesh(
      new THREE.BoxGeometry(2.9, 0.86, 0.08), metal,
    ));
    backing.position.y = 1.27;
    backing.castShadow = backing.receiveShadow = true;
    signStand.add(backing);
    for (const x of [-0.88, 0.88]) {
      const stake = track(this, new THREE.Mesh(
        new THREE.BoxGeometry(0.07, 1.18, 0.07), metal,
      ));
      stake.position.set(x, 0.59, 0);
      stake.castShadow = stake.receiveShadow = true;
      signStand.add(stake);
    }
    const label = track(this, new THREE.Mesh(new THREE.PlaneGeometry(2.76, 0.7), labelMat));
    label.name = 'human-observation-sign';
    label.userData.lines = [...AQUARIUM_SIGN_LINES];
    label.position.set(0, 1.27, 0.045);
    signStand.add(label);
    this.mesh.add(signStand);
    this.signStand = signStand;
    this.sign = label;

    // The enclosure is maintained, but not for human comfort. Weak aquarium
    // spill and nicotine-yellow pools leave the habitat legible without
    // making it welcoming; their uneven pulse suggests an old fluorescent
    // ballast somewhere above the ceiling.
    const cyanLight = new THREE.PointLight(0x2f7780, 0.28, Math.min(6, shortSpan), 2);
    cyanLight.position.copy(this.path.getPointAt(0.5));
    cyanLight.position.y -= 0.12;
    this.mesh.add(cyanLight);
    this.light = cyanLight;
    this.habitatLights = [];
    const fixtureMat = new THREE.MeshStandardMaterial({
      color: 0x20231f, roughness: 0.43, metalness: 0.68,
      emissive: 0xb7b264, emissiveIntensity: 0.075,
    });
    this._materials.add(fixtureMat);
    const longSpan = Math.min(route.span, 10);
    const fixtureY = Math.max(1.28, room.floorY + 3.92 - this.mesh.position.y);
    for (const x of [-longSpan * 0.28, longSpan * 0.28]) {
      for (const z of [-shortSpan * 0.23, shortSpan * 0.23]) {
        const fixture = track(this, new THREE.Mesh(
          new THREE.BoxGeometry(0.54, 0.10, 0.26), fixtureMat,
        ));
        fixture.position.set(x, fixtureY, z);
        fixture.castShadow = true;
        this.mesh.add(fixture);

        const pool = new THREE.SpotLight(
          0xbfc276, 0.72, 5.8, Math.PI * 0.25, 0.70, 1.55,
        );
        pool.position.set(x, fixtureY - 0.04, z);
        pool.castShadow = true;
        pool.shadow.mapSize.set(512, 512);
        const target = new THREE.Object3D();
        target.position.set(x * 0.82, -AQUARIUM_CENTRE_ABOVE_FLOOR + 0.35, z * 0.72);
        pool.target = target;
        this.mesh.add(pool, target);
        this.habitatLights.push(pool);
      }
    }

    // Suspended particles and bubbles. One points draw call is cheaper and
    // more convincing through glass than dozens of translucent spheres.
    const rand = mulberry32((world.seed ^ (room.id * 0x9e3779b1)) >>> 0);
    const bubbleCount = 64;
    const positions = new Float32Array(bubbleCount * 3);
    this._bubbleRates = new Float32Array(bubbleCount);
    for (let i = 0; i < bubbleCount; i++) {
      const t = rand();
      const p = this.path.getPointAt(t);
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * (AQUARIUM_TUBE_RADIUS - 0.08);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y + Math.cos(a) * r;
      positions[i * 3 + 2] = p.z + Math.sin(a) * r;
      this._bubbleRates[i] = 0.025 + rand() * 0.055;
    }
    const bubbleGeo = new THREE.BufferGeometry();
    bubbleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const bubbleMat = new THREE.PointsMaterial({
      color: 0xd9fbff, size: 0.032, transparent: true, opacity: 0.72,
      depthWrite: false, sizeAttenuation: true,
    });
    this._geometries.add(bubbleGeo); this._materials.add(bubbleMat);
    this.bubbles = new THREE.Points(bubbleGeo, bubbleMat);
    this.bubbles.renderOrder = 3; this.mesh.add(this.bubbles);

    const available = new Map(species.map((asset) => [asset.id, asset]));
    this.fish = [];
    this.loadedSpeciesCount = 0;
    for (let i = 0; i < REVERSE_AQUARIUM_MODELS.length; i++) {
      const spec = REVERSE_AQUARIUM_MODELS[i];
      const asset = available.get(spec.id);
      const loaded = asset ? prepareLoadedFish(this, asset) : null;
      const visual = loaded?.holder ?? fallbackFish(this, i, spec.length);
      if (loaded) this.loadedSpeciesCount++;
      const root = new THREE.Group();
      root.name = `aquarium-swimmer-${spec.id}`;
      root.add(visual); root.renderOrder = 2;
      this.mesh.add(root);
      let mixer = null;
      if (loaded && asset.clips?.length) {
        mixer = new THREE.AnimationMixer(loaded.animatedRoot);
        const swim = asset.clips.find((clip) => /swim|idle/i.test(clip.name)) ?? asset.clips[0];
        mixer.clipAction(swim).play();
      }
      this.fish.push({
        spec, root, visual, mixer,
        initialProgress: (0.06 + i / REVERSE_AQUARIUM_MODELS.length) % 1,
        progress: (0.06 + i / REVERSE_AQUARIUM_MODELS.length) % 1,
        yOffset: (rand() - 0.5) * 0.20,
        zOffset: (rand() - 0.5) * 0.22,
        phase: rand() * Math.PI * 2,
        observing: 0,
        observedThisLap: false,
        observer: true,
      });
    }
    this._poseFish(0, []);
  }

  /** Nearest living body actually inside the observation room. */
  _nearestObserver(observers) {
    const centre = new THREE.Vector3();
    this.mesh.localToWorld(centre.copy(this.path.getPointAt(0.5)));
    let best = null; let bestD = Infinity;
    for (const body of observers ?? []) {
      const p = body?.pos ?? body?.position;
      if (!p || body.alive === false) continue;
      if (p.x < this.room.minX - 0.5 || p.x > this.room.maxX + 0.5
        || p.z < this.room.minZ - 0.5 || p.z > this.room.maxZ + 0.5) continue;
      const d = Math.hypot(p.x - centre.x, p.z - centre.z);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  _poseFish(dt, observers) {
    const watched = this._nearestObserver(observers);
    for (let i = 0; i < this.fish.length; i++) {
      const fish = this.fish[i];
      fish.mixer?.update(dt);
      const previous = fish.progress;

      if (fish.observing > 0) {
        fish.observing = Math.max(0, fish.observing - dt);
        fish.progress = 0.5;
      } else {
        fish.progress += dt * fish.spec.speed;
      }
      if (fish.progress >= 1) {
        fish.progress %= 1;
        fish.observedThisLap = false;
      }

      // Once per lap, every species stops in the spherical bay when there is
      // somebody in the enclosure worth observing.
      if (fish.observer && watched && !fish.observedThisLap
        && previous < 0.49 && fish.progress >= 0.49) {
        fish.progress = 0.5;
        fish.observing = 2.8;
        fish.observedThisLap = true;
      }

      const p = this.path.getPointAt(clamp01(fish.progress));
      p.y += fish.yOffset + Math.sin(this.elapsed * 1.4 + fish.phase) * 0.025;
      p.z += fish.zOffset + Math.sin(this.elapsed * 1.1 + fish.phase) * 0.018;
      fish.root.position.copy(p);

      if (fish.observing > 0 && watched) {
        const target = VEC.set(watched.x, Number(watched.y) + 1.5, watched.z);
        this.mesh.worldToLocal(target);
        const direction = target.sub(p).normalize();
        QUAT.setFromUnitVectors(FORWARD, direction);
        // Eye contact is gameplay feedback, not a slow steering hint. Snap to
        // the observer so the head is unmistakably aimed at them immediately.
        fish.root.quaternion.copy(QUAT);
      } else {
        const tangent = this.path.getTangentAt(clamp01(fish.progress)).normalize();
        QUAT.setFromUnitVectors(FORWARD, tangent);
        fish.root.quaternion.slerp(QUAT, Math.min(1, Math.max(0.18, dt * 4.5)));
      }
      const bank = Math.sin(this.elapsed * 1.7 + fish.phase) * 0.06;
      fish.visual.rotation.z = fish.observing > 0 ? 0 : bank;
      const tail = fish.visual.userData.tail;
      if (tail) tail.rotation.y = Math.sin(this.elapsed * 7.5 + fish.phase) * 0.34;
    }
  }

  update(dt, observers = []) {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return;
    this.elapsed += Math.min(dt, 0.1);
    this._poseFish(Math.min(dt, 0.1), observers);

    if (this.waterMaterial.map) {
      this.waterMaterial.map.offset.x = (this.waterMaterial.map.offset.x + dt * 0.012) % 1;
      this.waterMaterial.map.offset.y = (this.waterMaterial.map.offset.y + dt * 0.007) % 1;
    }
    this.floorMaterial.opacity = (this.floorMaterial.map ? 0.055 : 0.025)
      + Math.sin(this.elapsed * 0.72) * 0.008;
    this.light.intensity = 0.25 + Math.sin(this.elapsed * 0.84) * 0.035;
    for (let i = 0; i < this.habitatLights.length; i++) {
      const unstable = Math.sin(this.elapsed * 10.7 + i * 4.31)
        * Math.sin(this.elapsed * 2.13 + i * 1.17);
      const flicker = unstable > 0.82 ? 0.38 : 1;
      this.habitatLights[i].intensity = (0.66
        + Math.sin(this.elapsed * 0.31 + i * 1.7) * 0.055) * flicker;
    }

    const position = this.bubbles.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) {
      let y = position.getY(i) + this._bubbleRates[i] * dt;
      const x = position.getX(i);
      const pathPoint = this.path.getPointAt(clamp01((x + this.half) / (this.half * 2)));
      const ceiling = pathPoint.y + AQUARIUM_TUBE_RADIUS - 0.045;
      if (y > ceiling) y = pathPoint.y - AQUARIUM_TUBE_RADIUS + 0.045;
      position.setY(i, y);
    }
    position.needsUpdate = true;
  }

  reset() {
    if (this.disposed) return;
    this.elapsed = 0;
    for (const fish of this.fish) {
      fish.progress = fish.initialProgress;
      fish.observing = 0;
      fish.observedThisLap = false;
    }
    this._poseFish(0, []);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const fish of this.fish) fish.mixer?.stopAllAction();
    for (const geometry of this._geometries) geometry.dispose?.();
    for (const material of this._materials) material.dispose?.();
    for (const texture of this._textures) texture.dispose?.();
    this._geometries.clear(); this._materials.clear(); this._textures.clear();
    this.fish.length = 0;
  }
}

export async function createReverseAquarium(world, options = {}) {
  const room = findReverseAquariumRoom(world);
  if (!room) return null;
  const assets = options.assets ?? await loadReverseAquariumAssets();
  return new ReverseAquarium(room, world, assets);
}
