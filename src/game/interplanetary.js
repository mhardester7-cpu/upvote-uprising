// Interplanetary flight: a compact flight layer that sits on top of the
// existing FPS world.  Landing deliberately returns to the same World and
// Player physics, so planets never introduce a second set of collision rules.

import * as THREE from '../../vendor/three.module.js';

const UP = new THREE.Vector3(0, 1, 0);
const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const TARGET_Q = new THREE.Quaternion();
const TARGET_EULER = new THREE.Euler();

const saturate = (v) => Math.max(0, Math.min(1, v));
const smooth = (v) => { const t = saturate(v); return t * t * (3 - 2 * t); };

/** Seconds the banana boomerang remains active after the pilot disembarks. */
export const BANANA_DURATION = 30;
/** Ground pursuit is intentionally slow, but never pauses while the player is on foot. */
export const SNAIL_SPEED = 0.45;
/** The readable gameplay snail is roughly 80cm long, with a contact-sized catch radius. */
export const SNAIL_VISUAL_SCALE = 0.16;
export const SNAIL_MODEL_LENGTH = 0.82;
export const SNAIL_GROUND_OFFSET = 0.1;
export const SNAIL_KILL_DISTANCE = 0.48;
export const BANANA_PICKUP_RADIUS = 6.25;
export const BANANA_FIRE_COOLDOWN = 0.38;
/** The outbound half of the boomerang follows the centre crosshair to this range. */
export const BANANA_THROW_DISTANCE = 20;
/** A novelty weapon first: one hit removes only 2% of a basic zombie's health. */
export const BANANA_DAMAGE = 2;
export const SNAIL_START_MIN_DISTANCE = 7;
/** Only interrupt the HUD once the pursuer is an immediate nearby threat. */
export const SNAIL_WARNING_DISTANCE = 3;
const SNAIL_HIT_RADIUS = 0.62;
const SNAIL_TERRAIN_SAMPLE = 0.32;
const SNAIL_TURN_RATE = 5.5;
const SNAIL_COLLISION_RADIUS = 0.3;
const SNAIL_COLLISION_HEIGHT = 0.36;
const SNAIL_MAX_MOVE_STEP = 0.18;

// Dedicated scratch state keeps the ground alignment allocation-free. The
// flight camera uses the generic TMP values above during the same frame.
const SNAIL_UP = new THREE.Vector3();
const SNAIL_FORWARD = new THREE.Vector3();
const SNAIL_RIGHT = new THREE.Vector3();
const SNAIL_BASIS = new THREE.Matrix4();
const SNAIL_TARGET_Q = new THREE.Quaternion();
const SNAIL_COLLISION_POS = new THREE.Vector3();
const SNAIL_NAV_TARGET = new THREE.Vector3();

export const SNAIL_ASSET = 'assets/creatures/inevitable_snail/snail-v2.glb';

export const JOHN_PORK_PLANET = 'cinder';
export const JOHN_PORK_TEXTURE = 'assets/textures/planets/john_pork_surface.png';

export const PLANETS = {
  verdant: {
    id: 'verdant', name: 'VERDANT PRIME', color: 0x4e9a72, cloud: 0xd9f3e9,
    atmosphere: 0x82d8e6, tint: '#ffffff', fog: 0xbfe4f7,
    landing: { x: 28, z: 28 }, prop: 0x79cf9a,
  },
  cinder: {
    id: 'cinder', name: 'CINDER REACH', color: 0xb74a29, cloud: 0xf2b16c,
    atmosphere: 0xff8b4b, tint: '#f3a16f', fog: 0xd98256,
    landing: { x: 17, z: 64 }, prop: 0xff9d4a, creatures: ['cinder_stalker', 'cinder_stalker', 'cinder_stalker'],
    surface: JOHN_PORK_TEXTURE,
  },
  nyx: {
    id: 'nyx', name: 'NYX GLACIER', color: 0x596ca8, cloud: 0xd8e8ff,
    atmosphere: 0x9f7cff, tint: '#9aabdf', fog: 0x877dc0,
    landing: { x: 64, z: 17 }, prop: 0x8eeeff, creatures: ['nyx_wraith', 'nyx_wraith', 'nyx_wraith', 'nyx_wraith'],
  },
};

const DESTINATIONS = [
  { id: 'cinder', pos: new THREE.Vector3(-145, 14, -265), radius: 31 },
  { id: 'nyx', pos: new THREE.Vector3(195, -12, -350), radius: 39 },
];

function makeShip() {
  const g = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0x2a3543, metalness: 0.78, roughness: 0.28 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xd9e9ef, metalness: 0.66, roughness: 0.24 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x5fdcff, emissive: 0x0a2840, emissiveIntensity: 1.2, metalness: 0.4, roughness: 0.12 });
  const engine = new THREE.MeshStandardMaterial({ color: 0x56dfff, emissive: 0x36baff, emissiveIntensity: 2.5, roughness: 0.2 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.76, 1.12, 4.4, 10), hull);
  body.rotation.x = Math.PI / 2; body.position.z = 0.1; g.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.77, 1.75, 10), trim);
  nose.rotation.x = -Math.PI / 2; nose.position.z = -2.95; g.add(nose);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.61, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  canopy.scale.set(0.92, 0.55, 1.25); canopy.position.set(0, 0.55, -0.55); g.add(canopy);
  for (const s of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.14, 1.45), trim);
    wing.position.set(s * 1.35, -0.1, 0.55); wing.rotation.z = s * 0.12; g.add(wing);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 1.15), hull);
    fin.position.set(s * 0.58, 0.53, 1.43); fin.rotation.z = s * 0.48; g.add(fin);
  }
  for (const s of [-0.43, 0.43]) {
    const thruster = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.72, 10), engine);
    thruster.rotation.x = Math.PI / 2; thruster.position.set(s, -0.08, 2.25); g.add(thruster);
  }
  g.userData.engine = engine;
  g.scale.setScalar(0.92);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function makeWholeBananaGeometry() {
  const along = 40;
  const around = 14;
  const positions = [];
  const indices = [];
  for (let i = 0; i <= along; i++) {
    const t = i / along;
    const x = (t - 0.5) * 3.2;
    const y = 3.15 * (t - 0.5) ** 2 - 0.33;
    const radius = 0.11 + 0.21 * Math.sin(Math.PI * t) ** 0.62;
    const tangent = new THREE.Vector3(3.2, 6.3 * (t - 0.5), 0).normalize();
    const normal = new THREE.Vector3(-tangent.y, tangent.x, 0);
    for (let j = 0; j <= around; j++) {
      const angle = j / around * Math.PI * 2;
      positions.push(
        x + normal.x * Math.cos(angle) * radius,
        y + normal.y * Math.cos(angle) * radius,
        Math.sin(angle) * radius * 0.9,
      );
    }
  }
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * (around + 1) + j;
      const b = a + around + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A complete, deliberately unpeeled banana used by every banana gameplay form. */
function makeBananaFallback() {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    color: 0xf0c72b, roughness: 0.61, metalness: 0.015,
  });
  const ridge = new THREE.MeshStandardMaterial({ color: 0xd9a91c, roughness: 0.72 });
  const end = new THREE.MeshStandardMaterial({ color: 0x4b3211, roughness: 0.9 });
  const fruit = new THREE.Mesh(makeWholeBananaGeometry(), skin);
  fruit.name = 'whole-banana-peel';
  g.add(fruit);

  // Raised longitudinal seams make the peel read clearly even in the small
  // first-person version, without opening it into the peeled asset it replaces.
  for (const z of [-0.23, 0.23]) {
    const points = [];
    for (let i = 1; i < 40; i++) {
      const t = i / 40;
      const radius = 0.11 + 0.21 * Math.sin(Math.PI * t) ** 0.62;
      points.push(new THREE.Vector3(
        (t - 0.5) * 3.2,
        3.15 * (t - 0.5) ** 2 - 0.33 + radius * 0.2,
        z * Math.sin(Math.PI * t),
      ));
    }
    const seam = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 36, 0.018, 5, false),
      ridge,
    );
    seam.name = 'whole-banana-peel-seam';
    g.add(seam);
  }

  const navel = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 8), end);
  navel.name = 'whole-banana-navel';
  navel.position.set(-1.62, 0.47, 0);
  navel.scale.set(0.65, 0.9, 0.9);
  g.add(navel);

  const stemDirection = new THREE.Vector3(3.2, 3.15, 0).normalize();
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.115, 0.38, 10), ridge);
  stem.name = 'whole-banana-stem';
  stem.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), stemDirection);
  stem.position.set(1.6, 0.47, 0).addScaledVector(stemDirection, 0.17);
  g.add(stem);
  const stemTip = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 7), end);
  stemTip.name = 'whole-banana-stem-tip';
  stemTip.position.copy(stem.position).addScaledVector(stemDirection, 0.2);
  g.add(stemTip);

  g.scale.setScalar(1.08);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function makeBananaHolder(scale = 1) {
  const holder = new THREE.Group();
  holder.name = 'unpeeled-banana';
  holder.userData.bananaScale = scale;
  holder.userData.unpeeled = true;
  const visual = makeBananaFallback(); visual.scale.multiplyScalar(scale);
  holder.add(visual);
  return holder;
}

function makeBananaPlaneWing(side) {
  const rootFront = side * 0.28;
  const rootRear = side * 0.34;
  const tipFront = side * 2.18;
  const tipRear = side * 1.82;
  const top = -0.26;
  const bottom = -0.36;
  const positions = [
    rootFront, top, -0.38, tipFront, top, 0.08, tipRear, top, 0.86, rootRear, top, 0.72,
    rootFront, bottom, -0.38, tipFront, bottom, 0.08, tipRear, bottom, 0.86, rootRear, bottom, 0.72,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]);
  geometry.computeVertexNormals();
  const wing = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: 0xf0c72b, roughness: 0.61, metalness: 0.015,
  }));
  wing.name = 'banana-craft-wing';
  wing.castShadow = true;
  wing.receiveShadow = true;
  return wing;
}

/** The charged craft is an intact banana with only two airplane wings. */
export function makeBananaCraft(holder) {
  const g = new THREE.Group();
  g.name = 'banana-craft';
  holder.rotation.y = Math.PI / 2;
  g.add(holder);
  g.add(makeBananaPlaneWing(-1), makeBananaPlaneWing(1));
  g.userData.literalBanana = true;
  g.visible = false;
  return g;
}

/** An intact banana presented downrange as the whole weapon. */
export function makeBananaGun(holder) {
  const g = new THREE.Group();
  g.name = 'banana-gun';
  holder.position.set(0, 0, -0.08);
  // Aim the blunt end downrange while keeping the reference image's upright
  // roll: the green stem is the near, downward grip and the thick bend is the
  // top of the pistol. The local banana runs from blunt -X to stem +X.
  holder.rotation.set(Math.PI, Math.PI / 3, 0.45);
  g.add(holder);
  g.userData.literalBanana = true;
  g.position.set(0.21, -0.17, -0.52);
  g.rotation.set(0.02, 0, -0.02);
  g.visible = false;
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

/** Complete pursuit-safe fallback while the realistic GLB is still loading. */
function makeSnail() {
  const g = new THREE.Group();
  const flesh = new THREE.MeshPhysicalMaterial({
    color: 0x5d5a43, roughness: 0.76, metalness: 0,
    clearcoat: 0.12, clearcoatRoughness: 0.68,
  });
  const eye = new THREE.MeshStandardMaterial({ color: 0x10110f, roughness: 0.48 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.82, 24, 14), flesh);
  body.scale.set(1.02, 0.34, 2.55); body.position.set(0, -0.3, 0.3); g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.68, 20, 12), flesh);
  head.scale.set(0.92, 0.7, 1.05); head.position.set(0, 0.02, 1.78); g.add(head);
  for (const x of [-0.38, 0.38]) {
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 1.14, 8), flesh);
    stalk.position.set(x, 0.67, 2.12); stalk.rotation.x = -0.6; stalk.rotation.z = x * -0.16; g.add(stalk);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), eye);
    pupil.position.set(x * 1.16, 1.13, 2.47); g.add(pupil);
  }
  const shellMount = new THREE.Group(); shellMount.name = 'snail-shell-mount';
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(1.3, 28, 18),
    new THREE.MeshStandardMaterial({ color: 0x765331, roughness: 0.84, metalness: 0.01 }),
  );
  shell.scale.set(0.42, 1, 1); shell.rotation.z = Math.PI / 2; shellMount.add(shell);
  shellMount.position.set(0, 0.5, -0.35); g.add(shellMount);
  g.userData.shellMount = shellMount;
  // The procedural body was originally a monster-sized placeholder. Scaling
  // the complete animal keeps the photogrammetry shell and feelers in the same
  // proportions while bringing the silhouette down to a large, readable snail.
  g.scale.setScalar(SNAIL_VISUAL_SCALE);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function pointInRootSpace(object, x, y, z, inverseRoot, relative, out) {
  relative.multiplyMatrices(inverseRoot, object.matrixWorld);
  return out.set(x, y, z).applyMatrix4(relative);
}

/**
 * Measure the authored animal's actual head direction in the source scene.
 *
 * The bundled Sketchfab export is not axis-aligned: its long body axis is
 * diagonal after the FBX conversion transforms are applied. Assuming it faces
 * +X leaves it about 36 degrees sideways in game. Principal-component analysis
 * finds the body axis, then the taller end (eye stalks and head) selects its
 * forward sign. Named markers remain useful for small fixture models in tests.
 */
export function measureRealisticSnailForward(source, body = source?.getObjectByName?.('Snail')) {
  if (!source?.isObject3D || !body) {
    throw new Error('realistic snail asset is missing its body');
  }
  source.updateMatrixWorld(true);
  const inverseRoot = source.matrixWorld.clone().invert();
  const relative = new THREE.Matrix4();
  const headMarker = source.getObjectByName('HeadMarker');
  const tailMarker = source.getObjectByName('TailMarker');
  if (headMarker && tailMarker) {
    const head = pointInRootSpace(headMarker, 0, 0, 0,
      inverseRoot, relative, new THREE.Vector3());
    const tail = pointInRootSpace(tailMarker, 0, 0, 0,
      inverseRoot, relative, new THREE.Vector3());
    head.sub(tail).setY(0);
    if (head.lengthSq() > 1e-8) return head.normalize();
  }

  const points = [];
  body.traverse((object) => {
    if (!object.isMesh) return;
    const position = object.geometry?.getAttribute?.('position');
    if (!position) return;
    relative.multiplyMatrices(inverseRoot, object.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      points.push(new THREE.Vector3(
        position.getX(i), position.getY(i), position.getZ(i),
      ).applyMatrix4(relative));
    }
  });
  if (points.length < 8) throw new Error('realistic snail body has no usable geometry');

  let meanX = 0, meanZ = 0;
  for (const p of points) { meanX += p.x; meanZ += p.z; }
  meanX /= points.length; meanZ /= points.length;
  let xx = 0, xz = 0, zz = 0;
  for (const p of points) {
    const x = p.x - meanX, z = p.z - meanZ;
    xx += x * x; xz += x * z; zz += z * z;
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz);
  const axis = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
  let lo = Infinity, hi = -Infinity;
  const projected = points.map((p) => {
    const along = (p.x - meanX) * axis.x + (p.z - meanZ) * axis.z;
    lo = Math.min(lo, along); hi = Math.max(hi, along);
    return { along, y: p.y };
  });
  const endSpan = Math.max(1e-6, (hi - lo) * 0.24);
  const endHeight = (positive) => {
    const values = projected
      .filter((p) => positive ? p.along >= hi - endSpan : p.along <= lo + endSpan)
      .map((p) => p.y)
      .sort((a, b) => a - b);
    return values[Math.floor((values.length - 1) * 0.9)] ?? -Infinity;
  };
  // A snail's eye stalks make the head end unambiguously taller than its tail.
  if (endHeight(true) < endHeight(false)) axis.negate();
  return axis;
}

/**
 * Turn the isolated Sketchfab animal into a correctly grounded game visual.
 * The source includes separate authored shell/body PBR materials; preserving
 * them is what fixes the old metallic shell and grafted procedural body.
 */
export function prepareRealisticSnail(source, targetLength = SNAIL_MODEL_LENGTH) {
  if (!source?.isObject3D) throw new Error('realistic snail asset has no scene');
  const shell = source.getObjectByName('Shell');
  const body = source.getObjectByName('Snail');
  if (!shell || !body) throw new Error('realistic snail asset is missing its body or shell');

  source.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      const isShell = /shell/i.test(material.name || object.name);
      if ('metalness' in material) material.metalness = 0;
      // Preserve the embedded colour, normal and roughness textures. Only the
      // physically impossible metallic response is removed; modest roughness
      // and stronger image-based light keep the shell lacquered and the living
      // foot moist instead of making both surfaces look like dry clay.
      if ('roughness' in material) material.roughness = isShell ? 0.38 : 0.34;
      if ('envMapIntensity' in material) material.envMapIntensity = isShell ? 0.72 : 0.5;
      if ('aoMapIntensity' in material) material.aoMapIntensity = 0.85;
      material.needsUpdate = true;
    }
  });

  const authoredForward = measureRealisticSnailForward(source, body);
  const alignmentYaw = -Math.atan2(authoredForward.x, authoredForward.z);
  const aligned = new THREE.Group();
  aligned.name = 'realistic-snail-axis-correction';
  aligned.rotation.y = alignmentYaw;
  aligned.add(source);
  const wrapper = new THREE.Group();
  wrapper.name = 'realistic-snail';
  wrapper.add(aligned);
  wrapper.updateMatrixWorld(true);

  let box = new THREE.Box3().setFromObject(wrapper);
  let size = box.getSize(new THREE.Vector3());
  if (![size.x, size.y, size.z].every(Number.isFinite)
      || Math.max(size.x, size.y, size.z) < 0.001) {
    throw new Error('realistic snail asset has invalid bounds');
  }
  const scale = targetLength / Math.max(size.x, size.z);
  aligned.scale.multiplyScalar(scale);
  wrapper.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(wrapper);
  const centre = box.getCenter(new THREE.Vector3());
  aligned.position.x -= centre.x;
  aligned.position.y -= box.min.y;
  aligned.position.z -= centre.z;
  wrapper.userData.realisticSnail = true;
  wrapper.userData.targetLength = targetLength;
  wrapper.userData.authoredForward = authoredForward.toArray();
  wrapper.userData.alignmentYaw = alignmentYaw;
  return wrapper;
}

/** Replace the generated fallback while preserving its terrain-grounded anchor. */
export function installRealisticSnail(target, source) {
  if (!target?.isObject3D) throw new Error('realistic snail target is not an Object3D');
  const detailed = prepareRealisticSnail(source);
  // The outer pursuit group sits SNAIL_GROUND_OFFSET above terrain so the
  // procedural fallback's slightly negative body clears the ground. The GLB
  // is already grounded to y=0, so cancel that legacy lift for this child.
  detailed.position.y = -SNAIL_GROUND_OFFSET;

  target.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry?.dispose?.();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material?.dispose?.();
  });
  target.clear();
  target.scale.setScalar(1);
  target.add(detailed);
  target.userData.realisticSnail = true;
  return detailed;
}

/** Highest nearby support the snail can actually rest on, including floor slabs. */
export function snailGroundHeight(world, x, z, fromY = 0) {
  const terrain = Number(world?.heightAt?.(x, z));
  const base = Number.isFinite(terrain) ? terrain : 0;
  if (typeof world?.supportHeight !== 'function') return base;
  const support = Number(world.supportHeight(
    x, z, Math.max(Number(fromY) || 0, base) + 0.42, 0.22, 0.5,
  ));
  return Number.isFinite(support) ? support : base;
}

/**
 * Face local +Z along the pursuit line while local +Y follows the ground.
 * This replaces lookAt plus a fake side-to-side roll: the former exposed any
 * asset-axis error, and the latter made a legless animal appear to crab-walk.
 */
export function snailSurfaceOrientation(
  world, x, z, fromY, forwardX, forwardZ, out = new THREE.Quaternion(),
) {
  const sample = SNAIL_TERRAIN_SAMPLE;
  const left = snailGroundHeight(world, x - sample, z, fromY);
  const rightHeight = snailGroundHeight(world, x + sample, z, fromY);
  const back = snailGroundHeight(world, x, z - sample, fromY);
  const front = snailGroundHeight(world, x, z + sample, fromY);
  // Clamp sudden prop edges. The animal should follow a surface, not tip onto
  // its side because one normal sample happened to land beyond a floor slab.
  const dx = THREE.MathUtils.clamp((rightHeight - left) / (sample * 2), -0.8, 0.8);
  const dz = THREE.MathUtils.clamp((front - back) / (sample * 2), -0.8, 0.8);
  SNAIL_UP.set(-dx, 1, -dz).normalize();

  SNAIL_FORWARD.set(forwardX, 0, forwardZ);
  if (SNAIL_FORWARD.lengthSq() < 1e-8) SNAIL_FORWARD.set(0, 0, 1);
  SNAIL_FORWARD.normalize();
  SNAIL_FORWARD.addScaledVector(SNAIL_UP, -SNAIL_FORWARD.dot(SNAIL_UP));
  if (SNAIL_FORWARD.lengthSq() < 1e-8) SNAIL_FORWARD.set(0, 0, 1);
  SNAIL_FORWARD.normalize();
  SNAIL_RIGHT.crossVectors(SNAIL_UP, SNAIL_FORWARD).normalize();
  // Rebuild forward after the cross product so all three axes are exactly
  // orthogonal even on a steep diagonal grade.
  SNAIL_FORWARD.crossVectors(SNAIL_RIGHT, SNAIL_UP).normalize();
  SNAIL_BASIS.makeBasis(SNAIL_RIGHT, SNAIL_UP, SNAIL_FORWARD);
  return out.setFromRotationMatrix(SNAIL_BASIS);
}

function makeLandingPad() {
  const g = new THREE.Group();
  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(5.15, 5.55, 0.2, 48),
    new THREE.MeshStandardMaterial({
      color: 0x27343e, metalness: 0.78, roughness: 0.34, emissive: 0x071620,
    }),
  );
  deck.receiveShadow = true; g.add(deck);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(4.35, 0.09, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0x75d8ee, toneMapped: false }),
  );
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.12; g.add(ring);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xd7eef2, toneMapped: false });
  for (let i = 0; i < 4; i++) {
    const marker = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.035, 1.25), markerMat);
    const a = i * Math.PI / 2;
    marker.position.set(Math.cos(a) * 3.45, 0.125, Math.sin(a) * 3.45);
    marker.rotation.y = -a; g.add(marker);
  }
  return g;
}

/** Bright nested plumes, kept separate from the async-replaced ship model. */
function makeExhaustFX(vertical = false) {
  const g = new THREE.Group();
  const outerMat = new THREE.MeshBasicMaterial({
    color: 0xff6a18, transparent: true, opacity: 0.76,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const innerMat = new THREE.MeshBasicMaterial({
    color: 0xa7f4ff, transparent: true, opacity: 0.94,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const plumes = [];
  for (const x of [-1.32, 1.32]) {
    const plume = new THREE.Group();
    const outer = new THREE.Mesh(new THREE.ConeGeometry(vertical ? 0.56 : 0.43, vertical ? 4.2 : 3.0, 12, 1, true), outerMat.clone());
    const inner = new THREE.Mesh(new THREE.ConeGeometry(vertical ? 0.28 : 0.22, vertical ? 2.55 : 1.85, 10, 1, true), innerMat.clone());
    if (vertical) {
      outer.rotation.z = Math.PI; inner.rotation.z = Math.PI;
      plume.position.set(x, -1.72, 0.45);
    } else {
      outer.rotation.x = Math.PI / 2; inner.rotation.x = Math.PI / 2;
      plume.position.set(x, -0.08, 2.08);
    }
    plume.add(outer, inner); g.add(plume);
    plumes.push({ plume, outer, inner });
  }
  const light = new THREE.PointLight(0xff7a28, 0, 13, 2);
  light.position.set(0, vertical ? -1.5 : -0.08, vertical ? 0.4 : 2.2);
  g.add(light);
  g.userData.plumes = plumes; g.userData.light = light;
  g.visible = false;
  return g;
}

function makeSmokeTrail() {
  const g = new THREE.Group();
  // A tiny generated radial texture gives every puff a soft edge without
  // adding another downloaded asset or requiring Canvas in headless tests.
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5) / size * 2 - 1;
    const dy = (y + 0.5) / size * 2 - 1;
    const r = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const boundary = 0.88 + Math.sin(angle * 3 + 0.7) * 0.08 + Math.cos(angle * 5 - 0.4) * 0.055;
    const edge = saturate((boundary - r) * 2.25);
    const noise = 0.82 + Math.sin(x * 1.73 + y * 2.41) * 0.09 + Math.cos(x * 3.11 - y) * 0.05;
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.round(255 * edge * edge * noise);
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
  const particles = [];
  for (let i = 0; i < 64; i++) {
    const material = new THREE.SpriteMaterial({
      map: texture, color: i % 3 ? 0xa6abad : 0x747b7f,
      transparent: true, opacity: 0, depthWrite: false,
    });
    material.rotation = i * 2.39996;
    const mesh = new THREE.Sprite(material);
    mesh.visible = false; g.add(mesh);
    particles.push({ mesh, age: 99, life: 1, velocity: new THREE.Vector3() });
  }
  g.userData.particles = particles;
  return g;
}

/**
 * Fit the authored CC0 hull to the flight layer and retain emissive engines.
 *
 * The FBX is intentionally not baked into a second format: its original
 * textures load directly through the same model pipeline as the game's props,
 * while the small procedural landing gear and exhaust stay readable during
 * the launch camera's rapid exposure changes.
 */
function detailedShip(source) {
  const g = new THREE.Group();
  const hull = source.clone(true);
  // The source was authored for an un-tonemapped Unity scene. Its near-white
  // material tints wash out under UPVOTE UPRISING's bright outdoor exposure, so keep
  // every authored detail map while bringing the base metals into this game's
  // darker, weathered palette.
  hull.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const tune = (original) => {
      const role = `${original.name} ${original.map?.name ?? ''}`.toLowerCase();
      const material = new THREE.MeshStandardMaterial({
        name: original.name,
        map: original.map ?? null,
        color: 0x69737a,
        metalness: 0.48,
        roughness: 0.52,
        side: original.side,
      });
      if (role.includes('glass')) {
        material.color.setHex(0x234b60);
        material.emissive.setHex(0x082635);
        material.emissiveIntensity = 0.45;
        material.transparent = true; material.opacity = 0.76; material.depthWrite = false;
      } else if (role.includes('burner')) {
        material.color.setHex(0x263f4a);
        material.emissive.setHex(0x0c5a78);
        material.emissiveIntensity = 0.7;
      } else if (role.includes('pipe')) {
        material.color.setHex(0x323a40);
      } else if (role.includes('external')) {
        material.color.setHex(0x3d474e);
      } else {
        material.color.setHex(0x50585e);
      }
      return material;
    };
    o.material = Array.isArray(o.material) ? o.material.map(tune) : tune(o.material);
  });
  hull.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(hull);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const scale = 8.2 / Math.max(size.x, size.z, 0.001);
  // FBXLoader preserves the file's centimetre-to-metre root scale. Scaling
  // that root directly would replace the conversion and inflate the hull by
  // 100x, so normalization belongs on a fresh wrapper around it.
  const visual = new THREE.Group();
  visual.add(hull);
  visual.scale.setScalar(scale);
  visual.position.set(-centre.x * scale, -centre.y * scale, -centre.z * scale);
  g.add(visual);

  const gearMat = new THREE.MeshStandardMaterial({ color: 0x20272d, metalness: 0.82, roughness: 0.3 });
  const engine = new THREE.MeshStandardMaterial({
    color: 0x89ecff, emissive: 0x36baff, emissiveIntensity: 2.5, roughness: 0.18,
  });
  for (const x of [-2.45, 2.45]) {
    for (const z of [-0.65, 0.72]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.72, 8), gearMat);
      leg.position.set(x, -0.62, z); leg.rotation.z = x < 0 ? -0.18 : 0.18; g.add(leg);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.11, 0.42), gearMat);
      foot.position.set(x + Math.sign(x) * 0.08, -0.98, z); g.add(foot);
    }
  }
  for (const x of [-1.32, 1.32]) {
    const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.32, 0.7, 12), engine);
    exhaust.rotation.x = Math.PI / 2; exhaust.position.set(x, -0.08, 1.62); g.add(exhaust);
  }
  g.userData.engine = engine;
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function planetMaps(def) {
  const width = 512, height = 256;
  const pixels = new Uint8Array(width * height * 4);
  const relief = new Uint8Array(width * height * 4);
  const clouds = new Uint8Array(width * height * 4);
  const low = new THREE.Color(def.id === 'cinder' ? 0x4b160d : 0x23345f);
  const high = new THREE.Color(def.id === 'cinder' ? 0xd26b38 : 0xb9d9f2);
  const ice = new THREE.Color(0xe8f3ff);

  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const lon = x / width * Math.PI * 2;
    const lat = (y / (height - 1) - 0.5) * Math.PI;
    // Continuous longitude terms avoid the seam a random bitmap puts down the
    // back of a sphere. Several frequencies create continent-scale masses and
    // smaller erosion without shipping a large photographic texture.
    const broad = Math.sin(lon * 2.0 + Math.sin(lat * 3.1) * 1.3) * 0.28
      + Math.sin(lon * 5.0 - lat * 4.2) * 0.18
      + Math.cos(lon * 11.0 + lat * 7.0) * 0.09
      + Math.sin(lon * 23.0 - lat * 13.0) * 0.045
      + Math.cos(lon * 47.0 + lat * 31.0) * 0.022
      + Math.sin(lon * 91.0 - lat * 53.0) * 0.012;
    const elevation = saturate(0.5 + broad);
    const polar = Math.pow(Math.abs(Math.sin(lat)), 3.2);
    const fissure = Math.abs(Math.sin(lon * (def.id === 'cinder' ? 13 : 9) + lat * 17 + broad * 8));
    let c;
    if (def.id === 'cinder') {
      c = low.clone().lerp(high, elevation * 0.82);
      if (fissure < 0.055 && elevation < 0.62) c.lerp(new THREE.Color(0xff8a3a), 0.72);
      c.lerp(new THREE.Color(0x2a0f0b), polar * 0.35);
    } else {
      c = low.clone().lerp(high, elevation * 0.72).lerp(ice, polar * 0.72);
      if (fissure < 0.075) c.lerp(new THREE.Color(0x17264e), 0.68);
    }
    pixels[i] = Math.round(c.r * 255); pixels[i + 1] = Math.round(c.g * 255);
    pixels[i + 2] = Math.round(c.b * 255); pixels[i + 3] = 255;
    const h = Math.round((0.18 + elevation * 0.72) * 255);
    relief[i] = relief[i + 1] = relief[i + 2] = h; relief[i + 3] = 255;

    const cloudNoise = saturate(0.46 + Math.sin(lon * 4 - lat * 3 + broad * 9) * 0.25
      + Math.cos(lon * 9 + lat * 6) * 0.12
      + Math.sin(lon * 27 - lat * 19 + broad * 17) * 0.08
      + Math.cos(lon * 61 + lat * 37) * 0.035);
    const alpha = cloudNoise > 0.58 ? Math.pow((cloudNoise - 0.58) / 0.42, 1.7) : 0;
    clouds[i] = clouds[i + 1] = clouds[i + 2] = 235;
    clouds[i + 3] = Math.round(alpha * (def.id === 'cinder' ? 100 : 150));
  }

  const texture = (data, color = false) => {
    const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { map: texture(pixels, true), relief: texture(relief), clouds: texture(clouds, true) };
}

export function makePlanet(def, radius, facing = { x: 0, y: 0, z: 1 }) {
  const group = new THREE.Group();
  const maps = planetMaps(def);
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 64, 40),
    new THREE.MeshStandardMaterial({
      map: maps.map, displacementMap: maps.relief, displacementScale: radius * 0.028,
      displacementBias: -radius * 0.012, roughness: 0.94, metalness: 0.01,
    }),
  );
  body.name = def.surface ? 'john-pork-planet-surface' : `${def.id}-planet-surface`;
  body.userData.surfaceTexture = def.surface ?? null;
  if (def.surface) {
    // The equirectangular face is centred on local +X. Rotate the whole mapped
    // globe so John Pork looks toward the system origin and the arriving ship.
    const direction = new THREE.Vector3(
      Number(facing.x) || 0, Number(facing.y) || 0, Number(facing.z) || 0,
    );
    if (direction.lengthSq() < 1e-8) direction.set(1, 0, 0);
    body.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction.normalize());
    if (typeof Image !== 'undefined') {
      const url = new URL(`../../${def.surface}`, import.meta.url).href;
      const surface = new THREE.TextureLoader().load(url, () => {
        body.material.map = surface;
        body.material.needsUpdate = true;
      }, undefined, (error) => {
        console.warn(`Planet surface unavailable: ${def.surface}`, error);
      });
      surface.colorSpace = THREE.SRGBColorSpace;
      surface.wrapS = THREE.RepeatWrapping;
      surface.minFilter = THREE.LinearMipmapLinearFilter;
      surface.magFilter = THREE.LinearFilter;
      surface.anisotropy = 8;
    }
  }
  const bands = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.009, 64, 40),
    new THREE.MeshStandardMaterial({
      map: maps.clouds, transparent: true, opacity: def.surface ? 0.14 : 0.48, depthWrite: false,
      roughness: 1, metalness: 0, emissive: new THREE.Color(def.cloud).multiplyScalar(0.08),
    }),
  );
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.04, 56, 36),
    new THREE.MeshBasicMaterial({
      color: def.atmosphere, transparent: true, opacity: 0.18, side: THREE.BackSide,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }),
  );
  group.add(body, bands, glow);
  group.userData.body = body;
  group.userData.clouds = bands;
  group.userData.surfaceTexture = def.surface ?? null;
  return group;
}

function makeStars() {
  const count = 1100;
  const pts = new Float32Array(count * 3);
  let state = 0x5f3759df;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = 0; i < count; i++) {
    // Independent deterministic samples avoid the visible diagonal spirals
    // created when azimuth and height advance with related golden ratios.
    const a = random() * Math.PI * 2;
    const y = random() * 2 - 1;
    const r = 540 + random() * 155;
    const xy = Math.sqrt(1 - y * y);
    pts[i * 3] = Math.cos(a) * xy * r;
    pts[i * 3 + 1] = y * r;
    pts[i * 3 + 2] = Math.sin(a) * xy * r;
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xdcecff, size: 1.1, sizeAttenuation: false, transparent: true, opacity: 0.9 }));
}

/** Ship interaction, space physics, arrival capture, and surface theming. */
export class InterplanetaryTravel {
  constructor(scene, camera, player, world, {
    terrain, sky, sun, fill, audio, viewmodel, deferAssets = false,
  } = {}) {
    this.scene = scene; this.camera = camera; this.player = player; this.world = world;
    this.terrain = terrain; this.sky = sky; this.sun = sun; this.fill = fill; this.audio = audio;
    this.viewmodel = viewmodel;
    this.current = 'verdant';
    this.mode = 'surface';
    this.boardDelay = 0;
    this.transition = 0;
    this.speed = 0;
    this.cruise = 28;
    this.destination = null;
    this.navTarget = null;
    this.shipPos = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    this.launchY = 0;
    this.reveal = 0;
    this.visualRoll = 0;
    this.landingStart = new THREE.Vector3();
    this.landingEnd = new THREE.Vector3();
    this.fxTime = 0;
    this.smokeClock = 0;
    this.smokeCursor = 0;
    this.bananaCharged = false;
    this.bananaTime = 0;
    this.bananaFireClock = 0;
    this.bananaProjectiles = [];
    this.bananaHolders = new Set();
    this.snailPos = new THREE.Vector3();
    this.snailActive = false;
    this.snailStun = 0;
    this.snailDistance = Infinity;
    this.snailCaught = false;
    this.snailPlaced = false;
    this.snailAvoidSide = 0;
    this.snailAvoidX = 0;
    this.snailAvoidZ = 0;
    this._hazardAssetsPromise = null;
    this._detailedShipPromise = null;

    this.surfaceShip = makeShip();
    this.scene.add(this.surfaceShip);
    this.surfaceShip.visible = false;
    this.surfacePad = makeLandingPad();
    this.scene.add(this.surfacePad); this.surfacePad.visible = false;
    this.surfaceExhaust = makeExhaustFX(true); this.scene.add(this.surfaceExhaust);
    this.launchSmoke = makeSmokeTrail(); this.scene.add(this.launchSmoke);

    this.surfaceFX = new THREE.Group(); this.scene.add(this.surfaceFX);
    this.atmoDome = new THREE.Mesh(
      new THREE.SphereGeometry(595, 32, 18),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: THREE.BackSide, depthWrite: false }),
    );
    this.atmoDome.renderOrder = -990; this.scene.add(this.atmoDome);

    // The atmosphere fills the frame at the moment the renderer swaps between
    // the ground scene and space. Fading this camera-centred shell produces a
    // continuous cloud/haze crossing instead of exposing that hard scene swap.
    this.transitionVeil = new THREE.Mesh(
      new THREE.SphereGeometry(0.72, 28, 18),
      new THREE.MeshBasicMaterial({
        color: PLANETS.verdant.atmosphere, transparent: true, opacity: 0,
        side: THREE.BackSide, depthTest: false, depthWrite: false, toneMapped: false,
      }),
    );
    this.transitionVeil.renderOrder = 10000;
    this.transitionVeil.visible = false;
    this.scene.add(this.transitionVeil);

    this.spaceRoot = new THREE.Group(); this.spaceRoot.position.set(0, 900, 0); this.scene.add(this.spaceRoot);
    this.spaceRoot.visible = false;
    this.spaceRoot.add(makeStars());
    const spaceFill = new THREE.AmbientLight(0x8299c0, 0.34);
    const spaceSun = new THREE.DirectionalLight(0xffd6b0, 2.65);
    spaceSun.position.set(-180, 130, 90);
    this.spaceRoot.add(spaceFill, spaceSun);
    this.flightShip = makeShip(); this.spaceRoot.add(this.flightShip);
    this.bananaCraftHolder = makeBananaHolder(1.34);
    this.bananaHolders.add(this.bananaCraftHolder);
    this.bananaShip = makeBananaCraft(this.bananaCraftHolder); this.spaceRoot.add(this.bananaShip);
    this.bananaGunHolder = makeBananaHolder(0.13);
    this.bananaHolders.add(this.bananaGunHolder);
    this.bananaGunView = makeBananaGun(this.bananaGunHolder);
    this.viewmodel?.scene?.add(this.bananaGunView);
    this.flightExhaust = makeExhaustFX(false); this.spaceRoot.add(this.flightExhaust);
    // The snail belongs to the playable surface, never to the spacecraft scene.
    this.snailMesh = makeSnail(); this.snailMesh.visible = false; this.scene.add(this.snailMesh);
    this.bananaAsteroids = this._buildBananaAsteroids();
    this.planetMeshes = new Map();
    for (const d of DESTINATIONS) {
      // The optional mapped surface faces the system origin, where the
      // Starling begins its approach, so it reads before the landing prompt.
      const m = makePlanet(PLANETS[d.id], d.radius, d.pos.clone().negate());
      m.position.copy(d.pos); this.spaceRoot.add(m); this.planetMeshes.set(d.id, m);
    }
    // A caller that does not defer art can await one promise for the detailed
    // ship, snail and banana. The game defers here so it can decode these
    // batches sequentially behind its opaque startup curtain.
    this.ready = typeof window === 'undefined' || deferAssets
      ? Promise.resolve(this)
      : Promise.all([
        this.loadDetailedShip(),
        this.loadHazardAssets(),
      ]).then(() => this);
  }

  get piloting() { return this.mode !== 'surface'; }
  get inSpace() {
    return this.mode === 'space' || this.mode === 'approach'
      || (this.mode === 'launch' && this.transition > 0.72);
  }
  get bananaActive() { return this.bananaTime > 0; }
  get bananaGunActive() { return this.mode === 'surface' && this.bananaActive; }
  get bananaCraftActive() { return this.piloting && this.bananaCharged; }

  /** Load the realistic pursuer/banana once, when the game can spare a batch. */
  loadHazardAssets() {
    if (typeof window === 'undefined') return Promise.resolve(this);
    if (!this._hazardAssetsPromise) {
      this._hazardAssetsPromise = this._loadHazardAssets().catch((error) => {
        console.warn('CC0 hazard art unavailable; using gameplay-safe fallbacks', error);
      }).then(() => this);
    }
    return this._hazardAssetsPromise;
  }

  /** Load the detailed spacecraft once, independently from the gameplay shell. */
  loadDetailedShip() {
    if (typeof window === 'undefined') return Promise.resolve(this);
    if (!this._detailedShipPromise) {
      this._detailedShipPromise = this._loadDetailedShip().then(() => this);
    }
    return this._detailedShipPromise;
  }

  reset(spawn) {
    this.current = PLANETS[this.world.planetProfile] ? this.world.planetProfile : 'verdant';
    this.mode = 'surface'; this.speed = 0; this.destination = null; this.navTarget = null;
    this.reveal = 0; this.visualRoll = 0; this.transitionVeil.visible = false;
    this._resetHazards(false);
    this._clearPropulsion();
    this.applyTheme(this.current);
    // Verdant's ship is earned through the existing outer progression door.
    // Destination worlds instead use their authored, level landing pads.
    const at = this.current === 'verdant' ? this._spaceportBerth(spawn) : (this.world.landing ?? spawn);
    this._placeSurfaceShip(at, at.y, at.yaw);
    this._spawnSurfaceSnail(this.player, true);
  }

  async _loadDetailedShip() {
    try {
      // Kept dynamic because the vendored browser loaders use the import map;
      // Node's headless physics tests deliberately never need to resolve it.
      const { loadModelFile } = await import('../render/loadmodel.js');
      const url = new URL('../../assets/models/starling/Ship.fbx', import.meta.url).href;
      const { scene } = await loadModelFile(url);
      // This CC0 pack contains one assembled exterior plus modular corridor
      // pieces for authors building an interior. Only the named cargo hull is
      // the spacecraft; mounting the full file would pile every loose doorway
      // and wall panel into the berth with it.
      const authoredHull = scene.getObjectByName('CargoX1046') ?? scene;
      for (const target of [this.surfaceShip, this.flightShip]) {
        const replacement = detailedShip(authoredHull);
        target.clear();
        target.scale.setScalar(1);
        for (const child of [...replacement.children]) target.add(child);
        target.userData.engine = replacement.userData.engine;
      }
    } catch (error) {
      // The generated hull is a complete fallback, so a missing optional art
      // file cannot make flight unavailable on a slow or partially cached load.
      console.warn('Starling model unavailable; using flight-safe fallback', error);
    }
  }

  /** Replace the pursuit-safe snail stand-in with its installed CC0 mesh. */
  async _loadHazardAssets() {
    const { loadModelFile } = await import('../render/loadmodel.js');
    const [snail] = await Promise.allSettled([
      loadModelFile(new URL(`../../${SNAIL_ASSET}`, import.meta.url).href),
    ]);

    if (snail.status === 'fulfilled') {
      try {
        installRealisticSnail(this.snailMesh, snail.value.scene);
      } catch (error) {
        console.warn('Realistic snail could not be prepared; using pursuit-safe fallback', error);
      }
    } else {
      console.warn('Realistic snail unavailable; using pursuit-safe fallback', snail.reason);
    }

  }

  _buildBananaAsteroids() {
    // Two sit close to the assisted lines to Cinder and Nyx; the others make
    // manual detours through the system worth paying attention to.
    const positions = [
      [-52, 5, -94], [-103, 10, -190], [66, -3, -119], [132, -8, -238],
      [-8, 22, -165], [92, 26, -280],
    ];
    return positions.map((p, i) => {
      const mesh = new THREE.Group();
      const holder = makeBananaHolder(1.7 + (i % 3) * 0.22);
      holder.rotation.set(i * 0.61, i * 1.13, i * 0.37);
      mesh.add(holder); this.bananaHolders.add(holder);
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(4.3, 16, 10),
        new THREE.MeshBasicMaterial({
          color: 0xffd83d, transparent: true, opacity: 0.1,
          blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        }),
      );
      halo.name = 'banana-asteroid-halo';
      mesh.add(halo); mesh.position.set(...p); this.spaceRoot.add(mesh);
      const velocity = new THREE.Vector3(
        0.9 + (i % 3) * 0.35,
        i % 2 ? 0.42 : -0.36,
        i % 2 ? 1.05 : -0.85,
      ).normalize().multiplyScalar(2.4 + i * 0.18);
      return {
        mesh, holder, active: true, respawn: 0,
        spin: 0.38 + i * 0.075, index: i, velocity,
        home: mesh.position.clone(), driftCenter: mesh.position.clone(), driftRange: 18 + i * 2,
      };
    });
  }

  _spaceportBerth(spawn) {
    if (this.world.spaceportLanding) return { ...this.world.spaceportLanding };
    const outside = this.world.plan?.outside;
    const door = this.world.props?.find?.((p) => p.escape);
    if (!outside || !door) return this._nearClear(spawn, 2.8);

    // Centre the pad in the outdoor zone, then bias it away from the doorway.
    // This keeps the open shutter, the boarding circle and the ship's wings
    // from fighting for the same few metres of collision space.
    let nx = outside.cx - door.x;
    let nz = outside.cz - door.z;
    const length = Math.hypot(nx, nz) || 1;
    nx /= length; nz /= length;
    const at = {
      x: door.x + nx * 7.4,
      z: door.z + nz * 7.4,
      // Park parallel to the shell. Facing straight outward points a cockpit
      // at the world's enclosing ridge on some seeds and makes launch feel as
      // though it begins in a wall.
      yaw: Math.atan2(-nz, nx),
    };
    at.y = this.world.heightAt(at.x, at.z);
    return at;
  }

  _nearClear(origin, radius = 3) {
    const candidates = [];
    for (let r = radius; r < 11; r += 1.2) {
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2;
        candidates.push({ x: origin.x + Math.cos(a) * r, y: origin.y, z: origin.z + Math.sin(a) * r });
      }
    }
    for (const p of candidates) {
      if (!this.world.inBounds(p.x, p.z)) continue;
      if (!this.world.blocksAt(p.x, p.y, p.z, 1.45, 2.2)) return p;
    }
    return { x: origin.x, y: origin.y, z: origin.z };
  }

  // A landed Starling is deliberately substantial in the scene. Put the
  // player beyond its wings before returning to the first-person camera so a
  // touchdown cannot leave the cockpit geometry or a landing crystal filling
  // the whole view.
  _disembarkSpot(origin) {
    const start = this.current === 'cinder' ? -1.25 : this.current === 'nyx' ? 0.25 : 0.55;
    for (let r = 10.5; r <= 16; r += 1.5) {
      for (let i = 0; i < 16; i++) {
        const a = start + i / 16 * Math.PI * 2;
        const p = { x: origin.x + Math.cos(a) * r, y: origin.y, z: origin.z + Math.sin(a) * r };
        if (!this.world.inBounds(p.x, p.z) || this.world.blocksAt(p.x, p.y, p.z, 1.45, 2.2)) continue;
        const clearOfProps = this.surfaceFX.children.every((o) => Math.hypot(p.x - o.position.x, p.z - o.position.z) > 3.4);
        if (clearOfProps) return p;
      }
    }
    return this._nearClear(origin, 10.5);
  }

  _placeSurfaceShip(at, yOverride = null, yaw = Math.PI) {
    const y = yOverride ?? this.world.heightAt(at.x, at.z);
    this.surfaceShip.position.set(at.x, y + 1.15, at.z);
    this.surfaceShip.rotation.set(0, yaw, 0);
    this.surfacePad.position.set(at.x, y + 0.04, at.z);
    this.surfaceShip.visible = true; this.surfacePad.visible = true; this.spaceRoot.visible = false;
  }

  _clearPropulsion() {
    this.surfaceExhaust.visible = false;
    this.flightExhaust.visible = false;
    for (const p of this.launchSmoke.userData.particles) {
      p.age = 99; p.mesh.visible = false; p.mesh.material.opacity = 0;
    }
    this.audio?.stopShipEngine?.();
  }

  _emitSmoke() {
    const particles = this.launchSmoke.userData.particles;
    const p = particles[this.smokeCursor++ % particles.length];
    const n = this.smokeCursor;
    const side = n % 2 ? -1 : 1;
    const yaw = this.surfaceShip.rotation.y;
    const lx = side * 1.22;
    const jitterX = Math.sin(n * 12.9898) * 0.92;
    const jitterZ = Math.cos(n * 8.317) * 0.92;
    p.mesh.position.set(
      this.surfaceShip.position.x + Math.cos(yaw) * lx + jitterX * 0.34,
      this.surfaceShip.position.y - 1.48,
      this.surfaceShip.position.z - Math.sin(yaw) * lx + jitterZ * 0.34,
    );
    // Hot gas keeps rising after it leaves the nozzle. Inheriting part of the
    // ship's climb keeps several soft puffs in the launch camera at once while
    // still letting the Starling pull decisively away from the trail.
    p.velocity.set(jitterX, 12 + smooth(this.transition) * 34, jitterZ);
    p.age = 0; p.life = 1.25 + (n % 7) * 0.09;
    p.mesh.scale.setScalar(1.02); p.mesh.material.opacity = 0.68; p.mesh.visible = true;
  }

  _updatePropulsion(dt, surfacePower = 0, flightPower = 0, smoke = false) {
    this.fxTime += dt;
    const animate = (fx, power, ship) => {
      fx.visible = power > 0.025;
      fx.position.copy(ship.position); fx.quaternion.copy(ship.quaternion);
      if (!fx.visible) return;
      const banana = fx === this.flightExhaust && this.bananaCraftActive;
      const flicker = 0.9 + Math.sin(this.fxTime * 42) * 0.08 + Math.sin(this.fxTime * 73) * 0.035;
      for (let i = 0; i < fx.userData.plumes.length; i++) {
        const { plume, outer, inner } = fx.userData.plumes[i];
        // A charged craft is one banana with one flame at its blunt end. Keep
        // the Starling's twin exhaust layout only for the ordinary ship.
        plume.visible = !banana || i === 0;
        if (fx === this.flightExhaust) {
          plume.position.set(banana ? 0 : (i ? 1.32 : -1.32), banana ? 0.68 : -0.08, banana ? 2.28 : 2.08);
        }
        if (!plume.visible) continue;
        const stagger = 1 + Math.sin(this.fxTime * 58 + i * 2.4) * 0.06;
        const width = 0.72 + power * 0.32;
        plume.scale.setScalar(width);
        outer.scale.y = (0.28 + power * 0.88) * flicker * stagger;
        inner.scale.y = (0.34 + power * 0.72) * flicker;
        outer.material.opacity = 0.36 + power * 0.48;
        inner.material.opacity = 0.52 + power * 0.45;
      }
      fx.userData.light.intensity = power * 5.2;
    };
    animate(this.surfaceExhaust, surfacePower, this.surfaceShip);
    animate(this.flightExhaust, flightPower, this._flightVisual());

    this.smokeClock -= dt;
    if (smoke && surfacePower > 0.15 && this.smokeClock <= 0) {
      this.smokeClock = 0.022;
      this._emitSmoke();
    }
    for (const p of this.launchSmoke.userData.particles) {
      if (!p.mesh.visible) continue;
      p.age += dt;
      if (p.age >= p.life) { p.mesh.visible = false; continue; }
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.velocity.y += 1.15 * dt;
      const t = p.age / p.life;
      p.mesh.scale.setScalar(1.02 + t * 4.4);
      p.mesh.material.opacity = 0.66 * (1 - t) * (1 - t * 0.35);
    }
    this.audio?.setShipEngine?.(Math.max(surfacePower, flightPower));
  }

  _flightVisual() { return this.bananaCraftActive ? this.bananaShip : this.flightShip; }

  _syncFlightVisual() {
    const banana = this.bananaCraftActive;
    this.flightShip.visible = !banana;
    this.bananaShip.visible = banana;
    this.bananaShip.position.copy(this.flightShip.position);
    this.bananaShip.quaternion.copy(this.flightShip.quaternion);
  }

  _setEngineIntensity(value) {
    if (this.flightShip.userData.engine) this.flightShip.userData.engine.emissiveIntensity = value;
    if (this.bananaShip.userData.engine) this.bananaShip.userData.engine.emissiveIntensity = value;
  }

  _clearBananaProjectiles() {
    for (const shot of this.bananaProjectiles) {
      shot.mesh.parent?.remove(shot.mesh);
      this.bananaHolders.delete(shot.holder);
    }
    this.bananaProjectiles.length = 0;
  }

  _resetHazards() {
    this.bananaCharged = false; this.bananaTime = 0; this.bananaFireClock = 0;
    this._clearBananaProjectiles();
    this.flightShip.visible = true; this.bananaShip.visible = false;
    this.snailActive = false; this.snailCaught = false; this.snailStun = 0;
    this.snailPlaced = false; this.snailAvoidSide = 0;
    this.snailAvoidX = 0; this.snailAvoidZ = 0;
    this.snailDistance = Infinity; this.snailMesh.visible = false;
    for (const rock of this.bananaAsteroids) {
      rock.active = true; rock.respawn = 0; rock.mesh.visible = true;
      rock.mesh.position.copy(rock.home);
      rock.driftCenter.copy(rock.home);
    }
  }

  _orientSurfaceSnail(target, dt = 0, immediate = false) {
    if (!target) return;
    const forwardX = Number(target.x) - this.snailPos.x;
    const forwardZ = Number(target.z) - this.snailPos.z;
    if (!Number.isFinite(forwardX) || !Number.isFinite(forwardZ)
        || forwardX * forwardX + forwardZ * forwardZ < 1e-8) return;
    snailSurfaceOrientation(
      this.world, this.snailPos.x, this.snailPos.z, this.snailPos.y,
      forwardX, forwardZ, SNAIL_TARGET_Q,
    );
    if (immediate) this.snailMesh.quaternion.copy(SNAIL_TARGET_Q);
    else this.snailMesh.quaternion.slerp(
      SNAIL_TARGET_Q, 1 - Math.exp(-Math.max(0, dt) * SNAIL_TURN_RATE),
    );
  }

  /** Put the opening pursuer in the same authored room as the player. */
  _spawnSurfaceSnail(player, opening = false) {
    const p = player?.pos ?? player;
    if (!p) return;
    const rooms = this.world.plan?.rooms ?? [];
    let room = null;
    if (opening) {
      // Prefer containment over the plan id. It keeps this correct for an
      // authored alternate spawn while still falling back to the start room.
      room = rooms.find((r) => p.x >= r.minX && p.x <= r.maxX
        && p.z >= r.minZ && p.z <= r.maxZ)
        ?? rooms.find((r) => r.id === this.world.plan?.start)
        ?? null;
    }

    const clear = (x, y, z) => {
      if (this.world.inBounds && !this.world.inBounds(x, z)) return false;
      return !this.world.blocksAt?.(x, y, z, 0.78, 1.45);
    };
    let spot = null;
    if (room && Number.isFinite(room.minX) && Number.isFinite(room.maxX)
      && Number.isFinite(room.minZ) && Number.isFinite(room.maxZ)) {
      const floorY = room.floorY ?? this.world.heightAt(p.x, p.z);
      const candidates = [];
      for (let x = room.minX + 1.6; x <= room.maxX - 1.6; x += 1.25) {
        for (let z = room.minZ + 1.6; z <= room.maxZ - 1.6; z += 1.25) {
          if (!clear(x, floorY, z)) continue;
          const distance = Math.hypot(x - p.x, z - p.z);
          const visible = !this.world.lineOfSight
            || this.world.lineOfSight(p.x, p.y + 0.8, p.z, x, floorY + 0.8, z);
          candidates.push({ x, y: floorY, z, distance, visible });
        }
      }
      // Ten metres is readable in the room without making the opening contact
      // immediate. When a compact room cannot provide it, take its safest
      // clear point instead of violating the same-room guarantee.
      const safe = candidates.filter((candidate) => candidate.distance >= SNAIL_START_MIN_DISTANCE);
      const pool = safe.length ? safe : candidates;
      pool.sort((a, b) => {
        if (safe.length) {
          const scoreA = Math.abs(a.distance - 10) + (a.visible ? 0 : 4);
          const scoreB = Math.abs(b.distance - 10) + (b.visible ? 0 : 4);
          return scoreA - scoreB;
        }
        return b.distance - a.distance;
      });
      spot = pool[0] ?? null;
    }

    // Planetary berths are outdoors rather than inside the authored start
    // room. Search a deterministic ring around the newly disembarked player.
    if (!spot) {
      for (const distance of [12, 9, 15]) {
        for (let i = 0; i < 16; i++) {
          const angle = (i / 16) * Math.PI * 2 + Math.PI * 0.375;
          const x = p.x + Math.cos(angle) * distance;
          const z = p.z + Math.sin(angle) * distance;
          if (this.world.inBounds && !this.world.inBounds(x, z)) continue;
          const y = this.world.heightAt(x, z);
          if (clear(x, y, z)) { spot = { x, y, z }; break; }
        }
        if (spot) break;
      }
    }
    if (!spot) {
      const max = (this.world.size ?? 128) - 2;
      const x = THREE.MathUtils.clamp(p.x + 8, 2, max);
      const z = THREE.MathUtils.clamp(p.z + 8, 2, max);
      spot = { x, y: this.world.heightAt(x, z), z };
    }

    const groundY = snailGroundHeight(this.world, spot.x, spot.z, spot.y);
    this.snailPos.set(spot.x, groundY + SNAIL_GROUND_OFFSET, spot.z);
    this.snailMesh.position.copy(this.snailPos);
    this._orientSurfaceSnail(p, 0, true);
    this.snailActive = true; this.snailPlaced = true;
    this.snailCaught = false; this.snailStun = 0; this.snailAvoidSide = 0;
    this.snailAvoidX = 0; this.snailAvoidZ = 0;
    this.snailDistance = Math.hypot(spot.x - p.x, spot.z - p.z);
    this.snailMesh.visible = true;
    this.snailSpawnRoomId = room?.id ?? null;
  }

  _hideSurfaceSnail() {
    this.snailActive = false;
    this.snailDistance = Infinity;
    this.snailMesh.visible = false;
  }

  _resumeSurfaceSnail(player) {
    if (!this.snailPlaced) { this._spawnSurfaceSnail(player); return; }
    this.snailActive = true; this.snailCaught = false;
    const groundY = snailGroundHeight(
      this.world, this.snailPos.x, this.snailPos.z, this.snailPos.y,
    );
    this.snailPos.y = groundY + SNAIL_GROUND_OFFSET;
    this.snailMesh.position.copy(this.snailPos);
    this._orientSurfaceSnail(player.pos, 0, true);
    this.snailMesh.visible = true;
    this.snailDistance = Math.hypot(
      player.pos.x - this.snailPos.x,
      player.pos.z - this.snailPos.z,
    );
  }

  _activateBanana(rock) {
    rock.active = false; rock.respawn = 44; rock.mesh.visible = false;
    const fresh = !this.bananaCharged;
    this.bananaCharged = true;
    this._syncFlightVisual();
    this.audio?.pickup?.();
    this.onBananaCharged?.({ fresh });
  }

  _activateGroundBanana() {
    if (!this.bananaCharged) return false;
    this.bananaCharged = false;
    this.bananaTime = BANANA_DURATION;
    this.bananaFireClock = 0;
    this._syncFlightVisual();
    this.onBananaStart?.({ duration: BANANA_DURATION });
    return true;
  }

  _endBanana() {
    if (!this.bananaActive) return;
    this.bananaTime = 0;
    this._clearBananaProjectiles();
    this.onBananaEnd?.();
  }

  _fireBanana(player) {
    this.bananaFireClock = BANANA_FIRE_COOLDOWN;
    const holder = makeBananaHolder(0.22);
    holder.rotation.y = Math.PI / 2;
    this.bananaHolders.add(holder);
    const mesh = new THREE.Group(); mesh.add(holder);
    const look = new THREE.Vector3();
    player.getLookDir(look); look.normalize();
    const eyeY = Number.isFinite(player.eyeY) ? player.eyeY : player.pos.y + 1.55;
    const eye = new THREE.Vector3(player.pos.x, eyeY, player.pos.z);
    const right = new THREE.Vector3(-look.z, 0, look.x);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0); else right.normalize();
    // Spawn beside and below the eye, where the held banana's muzzle appears,
    // then converge on the centre ray. A parallel ray from this offset stays
    // visibly below/right of the crosshair for its entire flight.
    mesh.position.copy(eye)
      .addScaledVector(look, 0.7)
      .addScaledVector(right, 0.18);
    mesh.position.y -= 0.16;
    const aimPoint = eye.clone().addScaledVector(look, BANANA_THROW_DISTANCE);
    const direction = aimPoint.sub(mesh.position);
    const outboundDistance = direction.length();
    direction.normalize();
    const aimOrigin = eye.clone().addScaledVector(look, 0.7);
    this.scene.add(mesh);
    this.bananaProjectiles.push({
      mesh, holder, age: 0, origin: mesh.position.clone(),
      direction, right, outboundDistance, aimOrigin, look,
      collisionPoint: aimOrigin.clone(),
    });
    this.audio?.bananaFire?.();
    this.onBananaFire?.();
  }

  _removeBananaShot(index) {
    const shot = this.bananaProjectiles[index];
    shot.mesh.parent?.remove(shot.mesh);
    this.bananaHolders.delete(shot.holder);
    this.bananaProjectiles.splice(index, 1);
  }

  _knockBackSnail(player) {
    TMP.set(this.snailPos.x - player.pos.x, 0, this.snailPos.z - player.pos.z);
    if (TMP.lengthSq() < 1e-6) {
      player.getLookDir(TMP); TMP.y = 0; TMP.multiplyScalar(-1);
    }
    TMP.normalize();
    this.snailAvoidSide = 0;
    this.snailAvoidX = 0;
    this.snailAvoidZ = 0;
    this._moveSurfaceSnail(TMP.x * 12, TMP.z * 12);
    this.snailStun = 1.8;
    this.snailCaught = false;
    this.audio?.snailHit?.();
    this.onSnailHit?.();
  }

  /**
   * Move the pursuit body without tunnelling through thin prop colliders.
   * Long banana knockbacks are subdivided; ordinary pursuit steps use the same
   * path so a wall is never merely a visual obstacle. If a diagonal is blocked,
   * trying each axis separately gives the slow crawler natural wall sliding.
   */
  _moveSurfaceSnail(dx, dz) {
    const distance = Math.hypot(dx, dz);
    if (!(distance > 0)) return false;
    const steps = Math.max(1, Math.ceil(distance / SNAIL_MAX_MOVE_STEP));
    const stepX = dx / steps;
    const stepZ = dz / steps;
    let moved = false;
    const clear = (x, z) => {
      const y = snailGroundHeight(this.world, x, z, this.snailPos.y);
      return !this.world.blocksAt?.(
        x, y, z,
        SNAIL_COLLISION_RADIUS, SNAIL_COLLISION_HEIGHT, 0.18,
      );
    };

    for (let i = 0; i < steps; i++) {
      const nextX = this.snailPos.x + stepX;
      const nextZ = this.snailPos.z + stepZ;
      if (clear(nextX, nextZ)) {
        this.snailPos.x = nextX;
        this.snailPos.z = nextZ;
        moved = true;
        continue;
      }
      const canX = Math.abs(stepX) > 1e-8 && clear(nextX, this.snailPos.z);
      const canZ = Math.abs(stepZ) > 1e-8 && clear(this.snailPos.x, nextZ);
      if (canX) { this.snailPos.x = nextX; moved = true; }
      else if (canZ) { this.snailPos.z = nextZ; moved = true; }
      else break;
    }

    const margin = SNAIL_COLLISION_RADIUS;
    const max = (this.world.size ?? 128) - margin;
    this.snailPos.x = THREE.MathUtils.clamp(this.snailPos.x, margin, max);
    this.snailPos.z = THREE.MathUtils.clamp(this.snailPos.z, margin, max);
    // Resolve any pre-existing overlap (for example an old saved pursuit
    // position after world geometry changed) without allowing a pass-through.
    const ground = snailGroundHeight(
      this.world, this.snailPos.x, this.snailPos.z, this.snailPos.y,
    );
    SNAIL_COLLISION_POS.set(this.snailPos.x, ground, this.snailPos.z);
    this.world.resolveProps?.(
      SNAIL_COLLISION_POS, SNAIL_COLLISION_RADIUS, SNAIL_COLLISION_HEIGHT,
    );
    this.snailPos.x = SNAIL_COLLISION_POS.x;
    this.snailPos.z = SNAIL_COLLISION_POS.z;
    return moved;
  }

  _snailClearAt(x, z) {
    const y = snailGroundHeight(this.world, x, z, this.snailPos.y);
    return !this.world.blocksAt?.(
      x, y, z,
      SNAIL_COLLISION_RADIUS, SNAIL_COLLISION_HEIGHT, 0.18,
    );
  }

  /**
   * Pick a stable wall-following target when the direct pursuit line is solid.
   * Remembering the chosen side prevents the crawler from alternating left and
   * right every frame. Once several probes toward the player are clear it turns
   * back in, so an ordinary wall is routed around rather than treated as a
   * permanent stopping point.
   */
  _snailPursuitTarget(player) {
    const dx = player.x - this.snailPos.x;
    const dz = player.z - this.snailPos.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-6) return player;
    const dirX = dx / distance;
    const dirZ = dz / distance;
    let directClear = true;
    for (let probe = SNAIL_MAX_MOVE_STEP; probe <= Math.min(1.08, distance); probe += SNAIL_MAX_MOVE_STEP) {
      if (!this._snailClearAt(
        this.snailPos.x + dirX * probe,
        this.snailPos.z + dirZ * probe,
      )) {
        directClear = false;
        break;
      }
    }
    if (directClear) {
      this.snailAvoidSide = 0;
      this.snailAvoidX = 0;
      this.snailAvoidZ = 0;
      return player;
    }

    if (this.snailAvoidSide && this._snailClearAt(
      this.snailPos.x + this.snailAvoidX * SNAIL_MAX_MOVE_STEP,
      this.snailPos.z + this.snailAvoidZ * SNAIL_MAX_MOVE_STEP,
    )) {
      return SNAIL_NAV_TARGET.set(
        this.snailPos.x + this.snailAvoidX * 2,
        this.snailPos.y,
        this.snailPos.z + this.snailAvoidZ * 2,
      );
    }

    const preferred = this.snailAvoidSide || 1;
    for (const side of [preferred, -preferred]) {
      const tangentX = -dirZ * side;
      const tangentZ = dirX * side;
      if (!this._snailClearAt(
        this.snailPos.x + tangentX * SNAIL_MAX_MOVE_STEP,
        this.snailPos.z + tangentZ * SNAIL_MAX_MOVE_STEP,
      )) continue;
      this.snailAvoidSide = side;
      this.snailAvoidX = tangentX;
      this.snailAvoidZ = tangentZ;
      return SNAIL_NAV_TARGET.set(
        this.snailPos.x + tangentX * 2,
        this.snailPos.y,
        this.snailPos.z + tangentZ * 2,
      );
    }
    return player;
  }

  _bananaEnemyAt(point) {
    const targets = this.getBananaTargets?.() ?? [];
    for (const enemy of targets) {
      if (!enemy?.alive || !enemy.pos) continue;
      const height = enemy.type?.height ?? 1.8;
      const width = enemy.type?.width ?? 0.62;
      const closestY = THREE.MathUtils.clamp(point.y, enemy.pos.y - 0.2, enemy.pos.y + height + 0.2);
      const radius = Math.max(0.58, width * 0.72);
      if (
        (point.x - enemy.pos.x) ** 2
        + (point.y - closestY) ** 2
        + (point.z - enemy.pos.z) ** 2
        <= radius ** 2
      ) return enemy;
    }
    return null;
  }

  _updateBananaShots(dt, player) {
    for (let i = this.bananaProjectiles.length - 1; i >= 0; i--) {
      const shot = this.bananaProjectiles[i];
      shot.age += dt;
      const t = shot.age;
      const phase = Math.min(1, t / 1.3);
      const outbound = Math.min(1, phase * 2);
      const returning = Math.max(0, (phase - 0.5) * 2);
      const travel = phase <= 0.5
        ? outbound * shot.outboundDistance
        : (1 - returning) * shot.outboundDistance;
      // The shot travels straight through the crosshair on its outbound leg.
      // Only the return curls aside, after it has already reached the aim point.
      const returnArc = Math.sin(returning * Math.PI);
      shot.mesh.position.copy(shot.origin)
        .addScaledVector(shot.direction, travel)
        .addScaledVector(shot.right, returnArc * 2.4);
      shot.mesh.position.y += returnArc * 0.7;
      // Gameplay stays exactly on the camera-centre ray even while the visible
      // mesh eases over from the lower-right muzzle. That keeps close targets
      // under the crosshair just as accurate as distant ones.
      const aimTravel = phase <= 0.5
        ? outbound * (BANANA_THROW_DISTANCE - 0.7)
        : (1 - returning) * (BANANA_THROW_DISTANCE - 0.7);
      if (phase <= 0.5) {
        shot.collisionPoint.copy(shot.aimOrigin).addScaledVector(shot.look, aimTravel);
      } else {
        // Once it curls home, collide where the returning banana is visible.
        shot.collisionPoint.copy(shot.mesh.position);
      }
      shot.mesh.rotation.x += dt * 5.2;
      shot.mesh.rotation.z += dt * 8.6;
      if (this.snailActive && Math.hypot(
        shot.collisionPoint.x - this.snailPos.x,
        shot.collisionPoint.z - this.snailPos.z,
      ) < SNAIL_HIT_RADIUS) {
        this._knockBackSnail(player);
        this._removeBananaShot(i);
        continue;
      }
      const enemy = this._bananaEnemyAt(shot.collisionPoint);
      if (enemy) {
        this.audio?.bananaHit?.();
        this.onBananaEnemyHit?.({
          enemy,
          damage: BANANA_DAMAGE,
          point: shot.collisionPoint.clone(),
          origin: { x: player.pos.x, y: player.eyeY ?? player.pos.y, z: player.pos.z },
        });
        this._removeBananaShot(i);
        continue;
      }
      if (phase >= 1) this._removeBananaShot(i);
    }
  }

  _updateGroundHazards(dt, input, player) {
    this.bananaFireClock = Math.max(0, this.bananaFireClock - dt);
    if (this.bananaActive) {
      this.bananaTime = Math.max(0, this.bananaTime - dt);
      if (this.bananaTime <= 0) {
        // Preserve the active state long enough for _endBanana to see it.
        this.bananaTime = Number.EPSILON;
        this._endBanana();
      } else if (this.bananaFireClock <= 0 && input.actionDown('fire')) {
        this._fireBanana(player);
      }
    }
    this._updateBananaShots(dt, player);

    if (!this.snailActive || player.alive === false) return;
    this.snailStun = Math.max(0, this.snailStun - dt);
    const pursuitTarget = this._snailPursuitTarget(player.pos);
    TMP.set(pursuitTarget.x - this.snailPos.x, 0, pursuitTarget.z - this.snailPos.z);
    this.snailDistance = TMP.length();
    if (this.snailDistance > 1e-5) {
      TMP.normalize();
      this._orientSurfaceSnail(pursuitTarget, dt);
      // Advance along the direction the animal visibly faces. Directly moving
      // toward the target while the model eased through a turn still produced
      // a short sideways slide. It now slows for sharp turns and accelerates
      // as its head comes onto the pursuit line, like a real crawling animal.
      TMP2.set(0, 0, 1).applyQuaternion(this.snailMesh.quaternion).setY(0);
      if (TMP2.lengthSq() < 1e-8) TMP2.copy(TMP);
      else TMP2.normalize();
      const turnProgress = Math.max(0, TMP2.dot(TMP));
      const step = Math.min(
        Math.hypot(player.pos.x - this.snailPos.x, player.pos.z - this.snailPos.z),
        SNAIL_SPEED * (this.snailStun > 0 ? 0.14 : 1) * turnProgress * dt,
      );
      this._moveSurfaceSnail(TMP2.x * step, TMP2.z * step);
    }
    // Snap to the support beneath the foot. Easing this value made the model
    // float uphill and sink downhill even though the horizontal pursuit was
    // correct, especially across the facility's floor-slab edges.
    const groundY = snailGroundHeight(
      this.world, this.snailPos.x, this.snailPos.z, this.snailPos.y,
    );
    this.snailPos.y = groundY + SNAIL_GROUND_OFFSET;
    this.snailDistance = Math.hypot(player.pos.x - this.snailPos.x, player.pos.z - this.snailPos.z);
    this.snailMesh.position.copy(this.snailPos);
    if (this.snailDistance <= SNAIL_KILL_DISTANCE && !this.snailCaught) {
      this.snailCaught = true;
      this.onSnailCaught?.();
    }
  }

  _updateSpaceHazards(dt) {

    for (const rock of this.bananaAsteroids) {
      if (!rock.active) {
        rock.respawn -= dt;
        if (rock.respawn <= 0) {
          // Re-enter ahead and off the current line, so the same pickup never
          // blinks back into the ship that just collected it.
          TMP.set(this.forward.z, 0, -this.forward.x).normalize();
          rock.mesh.position.copy(this.shipPos)
            .addScaledVector(this.forward, 105 + rock.index * 13)
            .addScaledVector(TMP, ((rock.index % 3) - 1) * 18);
          rock.mesh.position.y += ((rock.index % 4) - 1.5) * 5;
          rock.driftCenter.copy(rock.mesh.position);
          rock.active = true; rock.mesh.visible = true;
        }
        continue;
      }
      if (this.shipPos.distanceTo(rock.mesh.position) < BANANA_PICKUP_RADIUS) {
        this._activateBanana(rock);
        continue;
      }
      rock.mesh.position.addScaledVector(rock.velocity, dt);
      if (rock.mesh.position.distanceToSquared(rock.driftCenter) > rock.driftRange ** 2) {
        rock.velocity.negate();
        rock.mesh.position.addScaledVector(rock.velocity, dt * 2);
      }
      rock.mesh.rotation.x += dt * rock.spin;
      rock.mesh.rotation.y += dt * (rock.spin * 1.37);
    }
  }

  _surfaceDistance(player) {
    return Math.hypot(player.pos.x - this.surfaceShip.position.x, player.pos.z - this.surfaceShip.position.z);
  }

  prompt(player) {
    if (this.mode === 'surface') {
      const distance = this._surfaceDistance(player);
      if (distance < 5.2) return 'PRESS E — BOARD STARLING';
      // The HUD prompt is contextual, not a permanent quest marker. Keeping a
      // ship label on screen from the opposite side of the complex hid every
      // local interaction prompt and made the berth feel as though it were in
      // the room with the player. Identify the Starling only once it is close
      // enough to be the thing the player is actually approaching.
      if (distance < 8.5) return 'STARLING — APPROACH TO BOARD';
      return '';
    }
    if (this.mode === 'boarded') return 'W — LAUNCH   |   E — EXIT SHIP';
    if (this.mode === 'launch') return 'ASCENDING THROUGH ATMOSPHERE';
    if (this.mode === 'approach') return `SPACE — LAND ON ${PLANETS[this.destination.id].name}`;
    if (this.mode === 'space') return 'W/S — THRUST & BRAKE   A/D OR MOUSE — STEER   SHIFT — BOOST';
    if (this.mode === 'landing') return 'ATMOSPHERIC ENTRY';
    return '';
  }

  hudInfo() {
    if (this.mode === 'surface') {
      const snailClose = this.snailActive
        && Number.isFinite(this.snailDistance)
        && this.snailDistance <= SNAIL_WARNING_DISTANCE;
      const snail = `SNAIL ${Math.max(0, Math.round(this.snailDistance))} m`;
      if (this.bananaActive) return {
        title: `BANANA GUN  ${this.bananaTime.toFixed(1)}s`,
        sub: `MOUSE 1 — THROW BOOMERANG${snailClose ? `  |  ${snail}` : ''}`,
      };
      if (snailClose) return {
        title: 'INEVITABLE SNAIL',
        sub: `${snail} — IT FOLLOWS WHILE YOU ARE ON FOOT`,
      };
      return null;
    }
    if (this.mode === 'boarded') return { title: 'STARLING — READY', sub: `DOCKED AT ${PLANETS[this.current].name}` };
    if (this.mode === 'launch') return { title: 'ASCENT BURN', sub: 'BREAKING THE ATMOSPHERE' };
    if (this.mode === 'landing') return {
      title: this.bananaCharged ? 'BANANA CHARGE STORED' : 'ENTRY VECTOR',
      sub: this.bananaCharged
        ? 'GUN ARMS WHEN YOU DISEMBARK'
        : `DESCENDING TO ${PLANETS[this.destination.id].name}`,
    };
    if (this.mode === 'approach') return {
      title: PLANETS[this.destination.id].name,
      sub: this.bananaCharged
        ? 'LANDING WINDOW OPEN — PRESS SPACE  |  BANANA GUN READY ON EXIT'
        : 'LANDING WINDOW OPEN — PRESS SPACE',
    };
    let nearest = null;
    for (const d of DESTINATIONS) {
      const dist = Math.max(0, this.shipPos.distanceTo(d.pos) - d.radius);
      if (!nearest || dist < nearest.dist) nearest = { ...d, dist };
    }
    if (this.bananaCharged) {
      return {
        title: 'BANANA CRAFT — CHARGED',
        sub: 'LAND AND DISEMBARK TO ARM THE 30-SECOND BANANA GUN',
      };
    }
    return {
      title: `STARLING  ${Math.round(this.speed)} km/s`,
      sub: `${PLANETS[nearest.id].name}  ${Math.round(nearest.dist)} km`,
    };
  }

  tryInteract(player) {
    if (this.mode === 'surface' && this._surfaceDistance(player) < 5.2) {
      this.mode = 'boarded'; this.boardDelay = 0.28;
      player.vel.x = player.vel.y = player.vel.z = 0;
      this._hideSurfaceSnail();
      if (this.bananaActive) this._endBanana();
      return 'boarded';
    }
    if (this.mode === 'boarded') {
      this.mode = 'surface';
      this.audio?.stopShipEngine?.();
      const exit = this._disembarkSpot({ x: this.surfaceShip.position.x, y: this.surfaceShip.position.y - 1.15, z: this.surfaceShip.position.z });
      player.spawn(exit);
      player.yaw = this.current === 'cinder' ? -Math.PI * 0.75
        : this.current === 'nyx' ? Math.PI
          : -Math.PI / 2;
      this._resumeSurfaceSnail(player);
      this._activateGroundBanana();
      return 'exited';
    }
    return null;
  }

  update(dt, input, player) {
    if (this.mode === 'surface') {
      this._updatePropulsion(dt);
      this._updateGroundHazards(dt, input, player);
      if (this.reveal > 0) {
        this.reveal = Math.max(0, this.reveal - dt / 1.05);
        this.transitionVeil.material.opacity = 0.9 * smooth(this.reveal);
        this.transitionVeil.visible = this.reveal > 0;
      }
      return;
    }
    player.vel.x = player.vel.y = player.vel.z = 0;
    this.boardDelay -= dt;

    if (this.mode === 'boarded') {
      this._updatePropulsion(dt, 0.11);
      // W is deliberately the launch key and the throttle key. A short arming
      // delay prevents the final walking keypress from accidentally launching.
      const stickLaunch = (input.moveAxis?.z ?? 0) < -0.35;
      if (this.boardDelay <= 0 && (input.actionPressed('forward') || input.actionDown('forward') || stickLaunch)) {
        this.mode = 'launch'; this.transition = 0; this.launchY = this.surfaceShip.position.y;
        this.transitionVeil.material.color.setHex(PLANETS[this.current].atmosphere);
        this.transitionVeil.material.opacity = 0;
        this.transitionVeil.visible = true;
      }
      return;
    }

    if (this.mode === 'launch') {
      this.transition += dt / 3.15;
      const t = Math.min(1, this.transition);
      const eased = smooth(t);
      this.surfaceShip.position.y = this.launchY + 188 * eased;
      this.surfaceShip.rotation.x = -0.22 * smooth(t / 0.68);
      this._updatePropulsion(dt, 0.72 + t * 0.28, 0, true);
      this.transitionVeil.material.opacity = 0.9 * smooth((t - 0.25) / 0.55);
      if (t >= 1) {
        this.mode = 'space'; this.surfaceShip.visible = false; this.surfacePad.visible = false;
        this.surfaceExhaust.visible = false;
        this.spaceRoot.visible = true; this.shipPos.set(0, 0, 0); this.speed = 22; this.cruise = 28;
        player.getLookDir(this.forward);
        this.flightShip.position.copy(this.shipPos);
        this._resetHazards(true);
        this.reveal = 1;
        // A gentle nav lock means a new pilot can complete a first trip by
        // simply launching. Steering with A/D immediately takes manual control.
        this.navTarget = DESTINATIONS.find((d) => d.id !== this.current) || DESTINATIONS[0];
      }
      return;
    }

    if (this.mode === 'landing') {
      this.transition += dt / 3.65;
      this._updatePropulsion(dt, 0, 0.58 + smooth(this.transition) * 0.24);
      this.transitionVeil.material.opacity = 0.92 * smooth((this.transition - 0.34) / 0.56);
      if (this.transition >= 1) this._completeLanding(player);
      return;
    }

    if (this.mode === 'approach') {
      // Arrival is an orbital hold, not a label pasted over continued flight.
      // Without this stop the ship can coast straight through the planet while
      // a new player is still reading the landing prompt.
      this.speed = 0; this.cruise = 0;
      this._setEngineIntensity(1.25);
      this._updatePropulsion(dt, 0, 0.14);
      this._updateSpaceHazards(dt);
      this._syncFlightVisual();
      return;
    }

    // Keyboard steering works with the existing movement bindings, while
    // mouse look keeps the familiar FPS feel for pitch and fine aiming.
    if (this.reveal > 0) {
      this.reveal = Math.max(0, this.reveal - dt / 1.1);
      this.transitionVeil.material.opacity = 0.84 * smooth(this.reveal);
      this.transitionVeil.visible = this.reveal > 0;
    }
    // Positive steering means right. The FPS yaw convention becomes more
    // negative to look right, and the hull banks into that same turn.
    const keySteer = (input.actionDown('right') ? 1 : 0) - (input.actionDown('left') ? 1 : 0);
    const steer = THREE.MathUtils.clamp(keySteer + (input.moveAxis?.x ?? 0), -1, 1);
    if (steer) this.navTarget = null;
    player.yaw -= steer * dt * 0.95;
    const keyThrust = (input.actionDown('forward') ? 1 : 0) - (input.actionDown('back') ? 1 : 0);
    const thrust = THREE.MathUtils.clamp(keyThrust - (input.moveAxis?.z ?? 0), -1, 1);
    const max = input.actionDown('sprint') ? 118 : 72;
    // A gentle cruise keeps the distances cinematic rather than tedious;
    // W/S still move the requested cruise speed up and down in a familiar way.
    this.cruise = THREE.MathUtils.clamp(this.cruise + thrust * 38 * dt, 0, max);
    this.speed += (this.cruise - this.speed) * Math.min(1, dt * 2.7);
    player.getLookDir(this.forward);
    if (this.navTarget) {
      TMP2.copy(this.navTarget.pos).sub(this.shipPos).normalize();
      this.forward.lerp(TMP2, Math.min(1, dt * 0.55)).normalize();
      player.yaw = Math.atan2(-this.forward.x, -this.forward.z);
      player.pitch = Math.asin(this.forward.y);
    }
    this.shipPos.addScaledVector(this.forward, this.speed * dt);
    this.flightShip.position.copy(this.shipPos);
    this.visualRoll += (-steer * 0.34 - this.visualRoll) * (1 - Math.exp(-dt * 5.5));
    this.flightShip.rotation.set(player.pitch * 0.42, player.yaw, this.visualRoll);
    this._setEngineIntensity(1.6 + this.speed / 28);
    this._updatePropulsion(dt, 0, 0.28 + saturate(this.speed / max) * 0.72);
    this._updateSpaceHazards(dt);
    this._syncFlightVisual();

    let closest = null;
    for (const d of DESTINATIONS) {
      const dist = this.shipPos.distanceTo(d.pos) - d.radius;
      if (!closest || dist < closest.dist) closest = { ...d, dist };
    }
    if (closest && closest.dist < 17) {
      this.destination = closest;
      this.mode = 'approach';
      this.speed = 0; this.cruise = 0;
    }
  }

  land(input) {
    if (this.mode !== 'approach' || !input.actionPressed('jump')) return false;
    this.mode = 'landing'; this.transition = 0; this.speed = 0;
    this.landingStart.copy(this.shipPos);
    TMP.copy(this.shipPos).sub(this.destination.pos).normalize();
    this.landingEnd.copy(this.destination.pos).addScaledVector(TMP, this.destination.radius + 2.5);
    this.transitionVeil.material.color.setHex(PLANETS[this.destination.id].atmosphere);
    this.transitionVeil.material.opacity = 0;
    this.transitionVeil.visible = true;
    return true;
  }

  _completeLanding(player) {
    const def = PLANETS[this.destination.id];
    // Solo swaps in a deterministic world authored for this planet before the
    // ship touches down. The callback returns the berth on that new terrain;
    // network play keeps the shared server world and uses the safe fallback.
    const prepared = this.onPrepareSurface?.(def);
    if (prepared?.world) this.world = prepared.world;
    if (prepared?.terrain) this.terrain = prepared.terrain;
    this.current = def.id; this.applyTheme(def.id);
    const berth = prepared?.landing ?? this.world.landing ?? def.landing;
    const pad = { ...berth, y: this.world.heightAt(berth.x, berth.z) };
    this._placeSurfaceShip(pad, pad.y);
    player.spawn(this._disembarkSpot(pad));
    player.yaw = def.id === 'cinder' ? -Math.PI * 0.75
      : def.id === 'nyx' ? Math.PI
        : -Math.PI / 2;
    player.pitch = 0;
    // Touchdown should put boots on the ground immediately. The landed ship
    // remains interactable beside the player for the next departure.
    this.mode = 'surface'; this.boardDelay = 0; this.destination = null; this.navTarget = null;
    this._clearBananaProjectiles();
    this._spawnSurfaceSnail(player);
    this._activateGroundBanana();
    this._clearPropulsion();
    this.reveal = 1; this.transitionVeil.material.opacity = 0.9; this.transitionVeil.visible = true;
    this.onLanded?.(def, pad);
  }

  applyTheme(id) {
    const def = PLANETS[id]; if (!def) return;
    this.terrain?.setPlanetTint(def.tint);
    this.scene.fog.color.setHex(def.fog);
    if (this.sun) this.sun.color.setHex(id === 'cinder' ? 0xffc18a : id === 'nyx' ? 0xc4bcff : 0xfff0cf);
    if (this.fill) this.fill.color.setHex(id === 'cinder' ? 0xff8b5a : id === 'nyx' ? 0x7f8cff : 0x86b6ff);
    this.atmoDome.material.color.setHex(def.atmosphere);
    this.atmoDome.material.opacity = id === 'verdant' ? 0 : 0.13;
    this._rebuildSurfaceProps(def);
  }

  _rebuildSurfaceProps(def) {
    this.surfaceFX.clear();
    if (def.id === 'verdant') return;
    const cx = def.landing.x, cz = def.landing.z;
    if (def.id === 'cinder') {
      const basalt = new THREE.MeshStandardMaterial({ color: 0x251713, roughness: 0.94, metalness: 0.04 });
      const lava = new THREE.MeshStandardMaterial({ color: 0x61200c, emissive: 0xff4816, emissiveIntensity: 2.2, roughness: 0.42 });
      // Two broken caldera arcs leave a readable route from the landing pad to
      // the outpost, rather than surrounding the player with a generic ring.
      for (let i = 0; i < 20; i++) {
        const side = i < 10 ? -1 : 1;
        const row = i % 10;
        const x = cx + 10 + row * 4.0;
        const z = cz + side * (12 + Math.sin(row * 0.85) * 4.5);
        if (!this.world.inBounds(x, z) || this.world.blocksAt(x, this.world.heightAt(x, z), z, 1.7, 4)) continue;
        const m = new THREE.Mesh(new THREE.DodecahedronGeometry(1.25 + (row % 3) * 0.42, 0), basalt);
        m.scale.y = 1.7 + (row % 4) * 0.34;
        m.position.set(x, this.world.heightAt(x, z) + m.scale.y * 0.6, z);
        m.rotation.set(row * 0.17, row * 1.31, side * 0.12); m.castShadow = true;
        this.surfaceFX.add(m);
      }
      for (const [dx, dz] of [[11, -5], [18, 7], [27, -8]]) {
        const x = cx + dx, z = cz + dz;
        if (!this.world.inBounds(x, z)) continue;
        const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.42, 0.12, 12), lava);
        vent.position.set(x, this.world.heightAt(x, z) + 0.07, z);
        this.surfaceFX.add(vent);
        const light = new THREE.PointLight(0xff5a24, 2.6, 13, 1.5);
        light.position.set(x, vent.position.y + 0.35, z); this.surfaceFX.add(light);
      }
    } else {
      const ice = new THREE.MeshPhysicalMaterial({
        color: 0xb8dcff, emissive: 0x173c70, emissiveIntensity: 0.32,
        roughness: 0.22, metalness: 0.02, transmission: 0.08, transparent: true, opacity: 0.9,
      });
      // Nyx forms parallel pressure ridges running away from the northern
      // berth. They frame long sightlines and are deliberately unlike the
      // lateral volcanic arcs on Cinder.
      for (let lane = -2; lane <= 2; lane++) {
        for (let step = 0; step < 7; step++) {
          const x = cx + lane * 7.5 + Math.sin(step * 1.7 + lane) * 1.4;
          const z = cz + 12 + step * 6.2;
          if (!this.world.inBounds(x, z) || this.world.blocksAt(x, this.world.heightAt(x, z), z, 1.4, 4.5)) continue;
          const shard = new THREE.Mesh(new THREE.ConeGeometry(0.72 + (step % 2) * 0.3, 3.5 + (step % 3), 5), ice);
          shard.position.set(x, this.world.heightAt(x, z) + 1.8, z);
          shard.rotation.set(lane * 0.055, lane * 0.22, Math.sin(step) * 0.1);
          shard.castShadow = true; this.surfaceFX.add(shard);
        }
      }
    }
  }

  render(camera, player, dt) {
    this.atmoDome.position.copy(camera.position);
    this.transitionVeil.position.copy(camera.position);
    if (this.mode === 'surface') {
      this.bananaGunView.visible = this.bananaGunActive && player.alive !== false;
      if (this.bananaGunView.visible) {
        const sway = Math.sin(this.fxTime * 2.4) * 0.006;
        // Match the ordinary sidearm's first-person rest pose: low-right,
        // compact, and almost square to the crosshair like a presented pistol.
        this.bananaGunView.position.set(0.21 + sway, -0.17 - Math.abs(sway) * 0.7, -0.52);
        this.bananaGunView.rotation.set(0.02 + sway * 0.8, 0, -0.02 - sway * 0.5);
      }
      return false;
    }
    this.bananaGunView.visible = false;
    if (this.mode === 'boarded') {
      const s = this.surfaceShip.position;
      TMP.set(-Math.sin(this.surfaceShip.rotation.y), 0, -Math.cos(this.surfaceShip.rotation.y));
      camera.position.copy(s).addScaledVector(TMP, -7.4).addScaledVector(UP, 2.5);
      TMP2.copy(s).addScaledVector(TMP, 5).addScaledVector(UP, 1);
      camera.lookAt(TMP2);
      return true;
    }
    if (this.mode === 'launch') {
      const s = this.surfaceShip.position;
      TMP.set(-Math.sin(this.surfaceShip.rotation.y), 0, -Math.cos(this.surfaceShip.rotation.y));
      // Pull farther back and aim below the centreline during ascent. The old
      // cockpit framing cut the engines off at the bottom of the viewport,
      // hiding the most important part of a rocket launch: the fire and smoke.
      camera.position.copy(s).addScaledVector(TMP, -10.4).addScaledVector(UP, 3.25);
      TMP2.copy(s).addScaledVector(TMP, 4.8).addScaledVector(UP, -0.65);
      camera.lookAt(TMP2);
      return true;
    }
    if (this.mode === 'landing') {
      const target = this.planetMeshes.get(this.destination.id);
      const t = smooth(this.transition);
      TMP.lerpVectors(this.landingStart, this.landingEnd, t);
      this.flightShip.position.copy(TMP);
      this._syncFlightVisual();
      this.flightExhaust.position.copy(this._flightVisual().position);
      this.flightExhaust.quaternion.copy(this._flightVisual().quaternion);
      TMP2.copy(this.destination.pos).sub(TMP).normalize();
      camera.position.copy(this.spaceRoot.position).add(TMP).addScaledVector(TMP2, -8).addScaledVector(UP, 3);
      camera.lookAt(this.spaceRoot.position.x + TMP.x + TMP2.x * 7,
        this.spaceRoot.position.y + TMP.y + TMP2.y * 7,
        this.spaceRoot.position.z + TMP.z + TMP2.z * 7);
      if (target) target.userData.clouds.rotation.y += dt * 0.18;
      return true;
    }
    // Space is third person so the player always sees the ship they are flying.
    player.getLookDir(this.forward);
    TMP.copy(this.spaceRoot.position).add(this.shipPos);
    camera.position.copy(TMP).addScaledVector(this.forward, -8).addScaledVector(UP, 2.8);
    TARGET_EULER.set(player.pitch * 0.72, player.yaw, 0);
    TARGET_Q.setFromEuler(TARGET_EULER);
    camera.quaternion.slerp(TARGET_Q, 1 - Math.exp(-dt * 7.5));
    for (const m of this.planetMeshes.values()) m.userData.clouds.rotation.y += dt * 0.035;
    return true;
  }

  setSpaceVisuals(active) {
    if (active) {
      this.sky.visible = false; this.scene.background = new THREE.Color(0x02040c);
      this.scene.fog.near = 5000; this.scene.fog.far = 6000;
    } else {
      this.sky.visible = true; this.scene.background = null;
      this.scene.fog.near = 85; this.scene.fog.far = 260;
    }
  }

  dispose() {
    this._clearPropulsion();
    this._clearBananaProjectiles();
    this.viewmodel?.scene?.remove(this.bananaGunView);
    for (const o of [this.surfaceShip, this.surfacePad, this.surfaceExhaust, this.launchSmoke,
      this.surfaceFX, this.atmoDome, this.transitionVeil, this.snailMesh, this.spaceRoot]) this.scene.remove(o);
  }
}
