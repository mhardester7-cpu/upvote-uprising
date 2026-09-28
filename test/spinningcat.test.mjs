import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as THREE from '../vendor/three.module.js';
import { World, MAP_ARENA, MAP_COMPLEX } from '../src/world/world.js';
import {
  SPINNING_CAT_GIF_DURATION,
  SPINNING_CAT_MODEL,
  SpinningCat,
  createSpinningCat,
  findSpinningCatPlacement,
} from '../src/entities/spinningcat.js';

function generatedWorld(seed, map = MAP_COMPLEX) {
  const world = new World(seed, { map });
  for (const _ of world.generate()) { /* exhaust deterministic generator */ }
  return world;
}

function browserStubs() {
  const context = {
    clears: 0,
    draws: 0,
    clearRect() { this.clears++; },
    drawImage() { this.draws++; },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext() { return context; },
  };
  const image = {
    decoding: '',
    onload: null,
    onerror: null,
    _src: '',
    set src(value) {
      this._src = value;
      if (value) this.onload?.();
    },
    get src() { return this._src; },
  };
  return { context, canvas, image };
}

function catAsset() {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(1.4, 0.85, 0.65),
    new THREE.MeshStandardMaterial({ color: 0x55504a, metalness: 0.4, roughness: 0.25 }),
  );
  const head = new THREE.Object3D();
  head.name = 'test-cat-head';
  head.position.z = 0.58;
  const tail = new THREE.Object3D();
  tail.name = 'test-cat-tail';
  tail.position.z = -0.58;
  scene.add(mesh, head, tail);
  return {
    scene,
    animations: [
      new THREE.AnimationClip('AnimalArmature|AnimalArmature|Idle', 1, []),
      new THREE.AnimationClip('AnimalArmature|AnimalArmature|Walk', 1, []),
    ],
  };
}

function staticCatAsset() {
  const asset = catAsset();
  asset.animations = [];
  return asset;
}

function catCamera(placement, looking = true) {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(placement.x, placement.y + 1.6, placement.z + 4);
  camera.lookAt(
    placement.x + (looking ? 0 : 6),
    placement.y + 1.02,
    placement.z + (looking ? 0 : 4),
  );
  camera.updateMatrixWorld(true);
  return camera;
}

test('cat placement is clear and excludes every room with a community landmark', () => {
  const chosenRooms = new Set();
  for (let seed = 1; seed <= 48; seed++) {
    const world = generatedWorld(seed);
    const placement = findSpinningCatPlacement(world);
    const room = world.plan.rooms.find((candidate) => candidate.id === placement?.roomId);
    assert.ok(placement, `seed ${seed} has no cat placement`);
    const reserved = [
      world.plan.start,
      world.plan.dinosaurFactoryRoom,
      world.plan.reverseAquariumRoom,
      world.plan.drummerTowerRoom,
    ];
    assert.equal(reserved.includes(placement.roomId), false,
      `seed ${seed} put the cat in reserved room ${placement.roomId}`);
    assert.equal(['start', 'dinosaur_factory', 'reverse_aquarium', 'rhythm_tower']
      .includes(room.role?.id), false);
    assert.equal(room.outdoor, false, `seed ${seed} put the cat outdoors`);
    assert.ok(placement.x > room.minX && placement.x < room.maxX);
    assert.ok(placement.z > room.minZ && placement.z < room.maxZ);
    assert.equal(world.blocksAt(placement.x, placement.y, placement.z, 0.66, 1.9), false);
    assert.deepEqual(placement, findSpinningCatPlacement(generatedWorld(seed)));
    chosenRooms.add(placement.roomId);
  }
  assert.ok(chosenRooms.size >= 8, `cat only used ${chosenRooms.size} ordinary room slots`);
  assert.equal(findSpinningCatPlacement(generatedWorld(99, MAP_ARENA)), null);
});

test('the reveal waits for player gaze, then holds focus through the transition', () => {
  const world = generatedWorld(42);
  const placement = findSpinningCatPlacement(world);
  const stubs = browserStubs();
  const cat = new SpinningCat(placement, catAsset(), {
    canvasFactory: () => stubs.canvas,
    imageFactory: () => stubs.image,
  });

  cat.update(20, catCamera(placement, false));
  assert.equal(cat.phase, 'dormant', 'cat transformed while outside the centre of view');
  assert.equal(cat.billboard.visible, true, 'the 2D GIF is missing before the reveal');
  assert.equal(cat.model.visible, false, 'the 3D cat appeared before the GIF played');

  cat.update(0, catCamera(placement, true));
  assert.equal(cat.phase, 'gif');
  assert.equal(cat.focusActive, true);
  const player = {
    alive: true,
    pos: { x: placement.x, y: placement.y, z: placement.z + 4 },
    eyeY: placement.y + 1.64,
    yaw: 1.2,
    pitch: 0.4,
  };
  const oldYaw = player.yaw;
  assert.equal(cat.focusPlayer(player, 0.1), true);
  assert.notEqual(player.yaw, oldYaw, 'cinematic focus did not steer toward the cat');
  cat.dispose();
});

test('one witnessed 2D GIF pass transforms into the licensed 3D model', () => {
  const world = generatedWorld(20260829);
  const props = world.props;
  const stubs = browserStubs();
  const asset = catAsset();
  const cat = new SpinningCat(findSpinningCatPlacement(world), asset, {
    canvasFactory: () => stubs.canvas,
    imageFactory: () => stubs.image,
  });
  const camera = catCamera(cat.placement, true);

  assert.equal(cat.billboard.visible, true);
  assert.equal(cat.model.visible, false);
  assert.equal(cat.billboard.geometry.type, 'PlaneGeometry');
  cat.update(0, camera);
  cat.update(SPINNING_CAT_GIF_DURATION - 0.01, camera);
  assert.ok(stubs.context.draws > 0, 'the spinning GIF was never copied to the 2D card');
  assert.equal(cat.phase, 'gif');
  assert.equal(cat.billboard.visible, true);
  assert.equal(cat.model.visible, false, 'the 3D cat replaced the GIF too early');

  cat.update(0.02, camera);
  assert.equal(cat.phase, 'materialising');
  assert.equal(cat.billboard.visible, true, 'the last GIF frame vanished before the poof');
  assert.equal(cat.model.visible, false);

  cat.update(0.22, camera);
  assert.equal(cat.phase, 'materialising');
  assert.equal(cat.billboard.visible, false, 'the 2D card survived the transformation');
  assert.equal(cat.model.visible, true, 'the 3D cat did not replace the GIF');
  assert.equal(cat.halo.visible, true);
  assert.equal(cat.sparks.visible, true);

  cat.update(0.3, camera);
  assert.equal(cat.phase, 'model');
  assert.equal(cat.model.scale.x, 1);
  assert.equal(cat.billboard.visible, false);
  assert.equal(cat.halo.visible, false);
  assert.equal(cat.model.rotation.y, cat.modelRestYaw,
    'the materialised cat did not settle on its authored facing');
  assert.ok(cat.model.getObjectByProperty('isMesh', true), 'downloaded model has no mesh');
  assert.ok(cat.mixer, 'downloaded idle clip was not attached');
  assert.ok(cat.walkAction, 'downloaded walk clip was not attached');
  assert.equal(asset.scene.children[0].material.metalness, 0, 'fur retained metallic importer defaults');
  const size = new THREE.Box3().setFromObject(cat.modelSource).getSize(new THREE.Vector3());
  assert.ok(size.y > 0.55 && size.y <= 0.581,
    `materialised cat is ${size.y.toFixed(2)}m tall`);

  cat.update(20, camera);
  assert.equal(cat.phase, 'model', 'the supplied GIF unexpectedly looped back in');
  assert.equal(world.props, props, 'render-only cat replaced the world prop array');
  assert.ok(!props.includes(cat.mesh), 'cat entered the collision prop set');
  cat.dispose();
});

test('an animated cat asset wanders between clear points inside its selected room', () => {
  const world = generatedWorld(20260829);
  const placement = findSpinningCatPlacement(world);
  const room = world.plan.rooms.find((candidate) => candidate.id === placement.roomId);
  const stubs = browserStubs();
  const cat = new SpinningCat(placement, catAsset(), {
    world,
    canvasFactory: () => stubs.canvas,
    imageFactory: () => stubs.image,
  });
  const camera = catCamera(placement, true);

  cat.update(0, camera);
  cat.update(SPINNING_CAT_GIF_DURATION + 1.2, camera);
  const started = cat.mesh.position.clone();
  for (let i = 0; i < 40; i++) cat.update(0.1, camera);

  assert.ok(cat.mesh.position.distanceTo(started) > 0.4, 'cat stayed planted after transforming');
  assert.equal(cat._walking, true, 'cat did not blend into its authored walk cycle');
  assert.ok(cat.mesh.position.x > room.minX && cat.mesh.position.x < room.maxX);
  assert.ok(cat.mesh.position.z > room.minZ && cat.mesh.position.z < room.maxZ);
  assert.equal(world.blocksAt(
    cat._wanderTarget.x, room.floorY, cat._wanderTarget.z, 0.28, 0.62,
  ), false, 'cat selected a blocked wander destination');

  const head = cat.model.getObjectByName('test-cat-head');
  const tail = cat.model.getObjectByName('test-cat-tail');
  let checkedForwardStep = false;
  for (let i = 0; i < 80; i++) {
    const beforeStep = cat.mesh.position.clone();
    cat.update(0.05, camera);
    const travel = cat.mesh.position.clone().sub(beforeStep).setY(0);
    if (travel.lengthSq() < 1e-8) continue;
    travel.normalize();
    const facing = head.getWorldPosition(new THREE.Vector3())
      .sub(tail.getWorldPosition(new THREE.Vector3())).setY(0).normalize();
    const dot = facing.dot(travel);
    assert.ok(dot > 0.95, `cat moved sideways or tail-first (forward dot travel ${dot.toFixed(3)})`);
    checkedForwardStep = true;
  }
  assert.equal(checkedForwardStep, true, 'cat never took a verifiable forward step');
  cat.dispose();
});

test('a static realistic scan stays seated instead of sliding around the room', () => {
  const world = generatedWorld(20260829);
  const placement = findSpinningCatPlacement(world);
  const stubs = browserStubs();
  const cat = new SpinningCat(placement, staticCatAsset(), {
    world,
    canvasFactory: () => stubs.canvas,
    imageFactory: () => stubs.image,
  });
  const camera = catCamera(placement, true);

  cat.update(0, camera);
  cat.update(SPINNING_CAT_GIF_DURATION + 1.2, camera);
  const settled = cat.mesh.position.clone();
  for (let i = 0; i < 100; i++) cat.update(0.1, camera);

  assert.equal(cat.phase, 'model');
  assert.equal(cat.walkAction, null);
  assert.equal(cat.mesh.position.distanceTo(settled), 0,
    'a static scan must not moonwalk after the reveal');
  cat.dispose();
});

test('the bundled post-spin cat is a high-detail textured and animated quadruped', async () => {
  assert.equal(SPINNING_CAT_MODEL, 'assets/creatures/cat/maggie-animated-v3.glb');
  const bytes = readFileSync(new URL(
    '../assets/creatures/cat/maggie-animated-v3.glb', import.meta.url,
  ));
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
  assert.equal(bytes.readUInt32LE(4), 2, 'cat must be a GLB 2.0 file');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'cat GLB payload is truncated');
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  const triangles = gltf.meshes.flatMap((mesh) => mesh.primitives).reduce((sum, primitive) => {
    const accessor = primitive.indices === undefined
      ? gltf.accessors[primitive.attributes.POSITION] : gltf.accessors[primitive.indices];
    return sum + accessor.count / 3;
  }, 0);
  assert.ok(triangles > 150_000, `realistic cat has only ${triangles} triangles`);
  assert.ok((gltf.images?.length ?? 0) >= 15,
    'realistic cat lost its embedded fur, eye, or whisker textures');
  assert.ok(gltf.images.every((image) => /^image\//.test(image.mimeType)),
    'realistic cat contains a missing/external texture');
  assert.ok((gltf.skins?.length ?? 0) >= 1, 'realistic cat is not skinned');
  assert.equal(gltf.animations?.length ?? 0, 1, 'realistic cat must retain one walk cycle');
  assert.match(gltf.animations[0].name, /walk/i);
  assert.ok(gltf.animations[0].channels.length > 20,
    'realistic cat walk cycle does not animate the quadruped rig');

  const manifest = JSON.parse(readFileSync(
    new URL('../assets/manifest.json', import.meta.url), 'utf8',
  ));
  const entry = manifest.creatures.find((candidate) => candidate.id === 'realistic_cat');
  assert.equal(entry?.title, 'Cat named Maggie');
  assert.equal(entry?.author, 'ChamberSu1996');
  assert.equal(entry?.license, 'CC-BY');
  assert.equal(entry?.path, 'cat/maggie-animated-v3.glb');

  const world = generatedWorld(7);
  const stubs = browserStubs();
  let loads = 0;
  const cat = await createSpinningCat(world, {
    loadModel: async () => { loads++; return catAsset(); },
    canvasFactory: () => stubs.canvas,
    imageFactory: () => stubs.image,
  });
  assert.equal(loads, 1);
  assert.ok(cat);
  cat.dispose();
});

test('a failed GIF keeps the licensed 3D cat instead of hiding the landmark', () => {
  const world = generatedWorld(7);
  const stubs = browserStubs();
  const cat = new SpinningCat(findSpinningCatPlacement(world), catAsset(), {
    canvasFactory: () => stubs.canvas,
    imageFactory: () => stubs.image,
  });
  stubs.image.onerror();
  assert.equal(cat.phase, 'model');
  assert.equal(cat.billboard.visible, false);
  assert.equal(cat.model.visible, true);
  cat.dispose();
});
