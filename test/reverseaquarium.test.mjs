import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from '../vendor/three.module.js';

import { World, MAP_ARENA, MAP_COMPLEX } from '../src/world/world.js';
import {
  FLOOR_H, SLAB_T, REVERSE_AQUARIUM_ROLE,
} from '../src/world/complex.js';
import {
  HUMAN_ENCLOSURE_MODELS, HUMAN_ENCLOSURE_PROPS,
} from '../src/world/buildings.js';
import { BuildingRenderer } from '../src/render/buildings.js';
import {
  AQUARIUM_BUBBLE_RADIUS,
  AQUARIUM_CENTRE_ABOVE_FLOOR,
  AQUARIUM_SIGN_LINES,
  AQUARIUM_TUBE_RADIUS,
  REVERSE_AQUARIUM_CAUSTICS,
  REVERSE_AQUARIUM_KIND,
  REVERSE_AQUARIUM_MODELS,
  ReverseAquarium,
  buildAquariumPath,
  createReverseAquarium,
  findReverseAquariumRoom,
  insideReverseAquarium,
  prepareLoadedFish,
  reverseAquariumClearance,
} from '../src/entities/reverseaquarium.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function generated(seed, map = MAP_COMPLEX) {
  const world = new World(seed, { map });
  for (const _ of world.generate()) { /* drain */ }
  return world;
}

test('every complex puts HUMAN OBSERVATION in one deeper indoor room', () => {
  for (let seed = 1; seed <= 64; seed++) {
    const world = generated(seed);
    const room = findReverseAquariumRoom(world);
    assert.ok(room, `seed ${seed}: missing reverse aquarium room`);
    assert.equal(world.plan.reverseAquariumRoom, room.id);
    assert.equal(room.role.id, REVERSE_AQUARIUM_ROLE);
    assert.equal(room.label, 'HUMAN OBSERVATION');
    assert.equal(room.outdoor, false, `seed ${seed}: fish conduit placed outdoors`);
    assert.notEqual(room.id, world.plan.start, `seed ${seed}: aquarium cluttered spawn`);
    assert.notEqual(room.id, world.plan.dinosaurFactoryRoom,
      `seed ${seed}: aquarium and cloning pod compete in one room`);
    assert.ok(room.depth >= 2, `seed ${seed}: aquarium replaced the first-unlock landmark`);

    const entrances = world.plan.links.filter((link) => link.a === room.id || link.b === room.id);
    assert.equal(entrances.length, 1, `seed ${seed}: refuge has more than one entrance`);
    assert.equal(entrances[0].price, 0, `seed ${seed}: enclosure entrance is not free`);
    assert.equal(entrances[0].reclosable, true, `seed ${seed}: enclosure cannot be sealed`);
    assert.equal(entrances[0].aquarium, true, `seed ${seed}: wrong shutter style`);
    assert.equal(insideReverseAquarium(room, {
      x: room.cx, y: room.floorY + 1, z: room.cz,
    }), true, `seed ${seed}: enclosure centre does not trigger its room mood`);
    assert.equal(insideReverseAquarium(room, {
      x: room.maxX + 0.01, y: room.floorY + 1, z: room.cz,
    }), false, `seed ${seed}: enclosure mood leaks through the wall`);
  }
});

test('the conduit stays inside its room at mid-height with player headroom', () => {
  for (let seed = 1; seed <= 32; seed++) {
    const world = generated(seed);
    const room = findReverseAquariumRoom(world);
    const { path, half, span } = buildAquariumPath(room);
    const longRoomSpan = Math.max(room.maxX - room.minX, room.maxZ - room.minZ);
    assert.ok(half + AQUARIUM_TUBE_RADIUS <= longRoomSpan / 2,
      `seed ${seed}: glass crosses an end wall`);
    assert.ok(span === longRoomSpan);
    for (let i = 0; i <= 40; i++) {
      const p = path.getPointAt(i / 40);
      assert.ok(Math.abs(p.x) + AQUARIUM_TUBE_RADIUS <= longRoomSpan / 2 + 1e-6,
        `seed ${seed}: curved tube left the room at sample ${i}`);
    }
    assert.ok(reverseAquariumClearance(room) >= 1.85,
      `seed ${seed}: observation chamber clips ordinary player headroom`);
    assert.ok(AQUARIUM_CENTRE_ABOVE_FLOOR >= FLOOR_H * 0.5
      && AQUARIUM_CENTRE_ABOVE_FLOOR <= FLOOR_H * 0.6,
    `seed ${seed}: conduit is not centred at mid-room height`);
    assert.ok(AQUARIUM_CENTRE_ABOVE_FLOOR + AQUARIUM_BUBBLE_RADIUS <= FLOOR_H - SLAB_T,
      `seed ${seed}: observation chamber clips the ceiling slab`);
  }
});

test('the arena intentionally has no human-observation landmark', async () => {
  const arena = generated(99, MAP_ARENA);
  assert.equal(findReverseAquariumRoom(arena), null);
  assert.equal(await createReverseAquarium(arena, { assets: { species: [] } }), null);
});

test('the complete fallback aquarium labels the joke and animates eight species', () => {
  const world = generated(20260827);
  const room = findReverseAquariumRoom(world);
  const aquarium = new ReverseAquarium(room, world, { species: [], causticsTexture: null });

  assert.equal(aquarium.mesh.userData.kind, REVERSE_AQUARIUM_KIND);
  assert.equal(aquarium.fish.length, REVERSE_AQUARIUM_MODELS.length);
  assert.equal(aquarium.loadedSpeciesCount, 0);
  assert.deepEqual(aquarium.sign.userData.lines, [...AQUARIUM_SIGN_LINES]);
  assert.equal(aquarium.signStand.userData.freestanding, true);
  assert.equal(aquarium.signStand.userData.facesFish, true);
  assert.ok(aquarium.mesh.children.length >= 20, 'landmark is only placeholder geometry');
  assert.ok(aquarium.bubbles.geometry.getAttribute('position').count >= 60);

  const docent = aquarium.fish[0];
  docent.progress = 0.489;
  const target = { pos: { x: room.cx, y: room.floorY, z: room.cz }, alive: true };
  aquarium.update(0.1, [target]);
  assert.ok(docent.observing > 2.6, 'docent fish did not stop to observe the player');
  assert.ok(docent.observedThisLap);
  assert.equal(docent.progress, 0.5, 'observing fish drifted out of the viewing bay');
  assert.ok(aquarium.fish.every((fish) => fish.observer), 'only one species observes people');
  assert.equal(docent.visual.rotation.z, 0, 'observing fish banks away from eye contact');

  const watched = new THREE.Vector3(target.pos.x, target.pos.y + 1.5, target.pos.z);
  aquarium.mesh.worldToLocal(watched);
  const expected = watched.sub(docent.root.position).normalize();
  const actual = new THREE.Vector3(0, 0, -1).applyQuaternion(docent.root.quaternion);
  assert.ok(actual.dot(expected) > 0.99999, 'fish head does not point directly at the player');

  const lights = [];
  aquarium.mesh.traverse((object) => { if (object.isLight) lights.push(object); });
  assert.ok(lights.length >= 5, 'human enclosure does not have a complete light rig');
  assert.equal(aquarium.habitatLights.length, 4);
  assert.ok(aquarium.light.intensity < 0.4, 'aquarium glow is still overly bright');
  assert.equal(aquarium.light.color.getHex(), 0x2f7780,
    'water spill lost its cold institutional tint');
  assert.ok(aquarium.habitatLights.every((light) => light.intensity < 0.8),
    'human-habitat pools are too bright for the enclosure mood');
  assert.ok(aquarium.habitatLights.every((light) => light.color.getHex() === 0xbfc276),
    'human-habitat fixtures are not sickly backrooms yellow');

  aquarium.mesh.updateMatrixWorld(true);
  const signBounds = new THREE.Box3().setFromObject(aquarium.signStand);
  const door = world.interactableDoors().find((prop) => prop.reclosable && prop.aquarium);
  const doorBounds = new THREE.Box3(
    new THREE.Vector3(door.collider.minX, door.collider.minY, door.collider.minZ),
    new THREE.Vector3(door.collider.maxX, door.collider.maxY, door.collider.maxZ),
  );
  assert.equal(signBounds.intersectsBox(doorBounds), false,
    'freestanding sign covers the refuge door');

  aquarium.reset();
  assert.equal(docent.observing, 0);
  assert.equal(docent.progress, docent.initialProgress);
  aquarium.dispose();
  assert.equal(aquarium.disposed, true);
  assert.equal(aquarium.fish.length, 0);
  assert.equal(aquarium._geometries.size, 0);
  assert.equal(aquarium._materials.size, 0);
});

test('downloaded X-axis fish are turned nose-first along local -Z', () => {
  const entity = { _materials: new Set(), _geometries: new Set() };
  const model = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2, 0.25, 0.45),
    new THREE.MeshStandardMaterial({ color: 0x6699aa }),
  );
  const nose = new THREE.Object3D();
  nose.position.x = 1;
  model.add(body, nose);

  const prepared = prepareLoadedFish(entity, {
    id: 'orientation-fixture', model, length: 1, clips: [],
  });
  assert.ok(prepared);
  prepared.holder.updateMatrixWorld(true);
  const nosePosition = nose.getWorldPosition(new THREE.Vector3());
  assert.ok(nosePosition.z < 0, 'downloaded fish nose points opposite its swim direction');
  assert.ok(Math.abs(nosePosition.z) > Math.abs(nosePosition.x) * 4,
    'downloaded fish still swims sideways');
});

test('downloaded Z-axis fish are turned nose-first along local -Z', () => {
  const entity = { _materials: new Set(), _geometries: new Set() };
  const model = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.45, 0.25, 2),
    new THREE.MeshStandardMaterial({ color: 0x6699aa }),
  );
  const nose = new THREE.Object3D();
  nose.position.z = 1;
  model.add(body, nose);

  const prepared = prepareLoadedFish(entity, {
    id: 'z-orientation-fixture', model, length: 1, clips: [],
  });
  assert.ok(prepared);
  prepared.holder.updateMatrixWorld(true);
  const nosePosition = nose.getWorldPosition(new THREE.Vector3());
  assert.ok(nosePosition.z < 0, 'Z-axis fish tail leads along its swim direction');
  assert.ok(Math.abs(nosePosition.z) > Math.abs(nosePosition.x) * 4,
    'Z-axis fish still swims sideways');
});

test('the human enclosure has a dense collection of real assets and a working refuge shutter', () => {
  assert.ok(HUMAN_ENCLOSURE_PROPS.length >= 14,
    'the reverse aquarium still has only a handful of human props');
  assert.equal(HUMAN_ENCLOSURE_MODELS.length, 4,
    'the habitat drifted back toward incoherent industrial clutter');
  assert.deepEqual(new Set(HUMAN_ENCLOSURE_PROPS.map((prop) => prop.zone)),
    new Set(['sleep', 'living', 'dining', 'hygiene', 'utility']));
  assert.equal(new Set(HUMAN_ENCLOSURE_PROPS.map((prop) => prop.id)).size,
    HUMAN_ENCLOSURE_PROPS.length, 'human habitat repeats the same semantic object');
  assert.ok(HUMAN_ENCLOSURE_PROPS.every((prop) => prop.w >= 0.5 && prop.w <= 2.2
    && prop.d >= 0.25 && prop.d <= 2.0 && prop.h >= 0.4 && prop.h <= 2.0),
  'a human habitat prop is outside believable real-world scale');
  assert.equal(HUMAN_ENCLOSURE_PROPS.some((prop) =>
    /ammo|artificial sunlight|sanitation plumbing|sleeping platform/i.test(prop.label)), false,
  'an industrial leftover is still mislabeled as a basic human need');
  assert.equal(HUMAN_ENCLOSURE_PROPS.some((prop) => prop.model === 'covered_car'), false,
    'the covered car returned to the human enclosure');
  for (let seed = 1; seed <= 32; seed++) {
    const world = generated(seed);
    const room = findReverseAquariumRoom(world);
    const props = world.props.filter((prop) =>
      prop.room === room.id && prop.kind === 'human_enclosure');
    assert.equal(props.length, HUMAN_ENCLOSURE_PROPS.length,
      `seed ${seed}: incomplete human habitat`);
    assert.equal(new Set(props.map((prop) => prop.enclosureId)).size, HUMAN_ENCLOSURE_PROPS.length,
      `seed ${seed}: repeated object replaced a habitat need`);
    for (const prop of props) {
      assert.ok(prop.collider.minX >= room.minX && prop.collider.maxX <= room.maxX
        && prop.collider.minZ >= room.minZ && prop.collider.maxZ <= room.maxZ,
      `seed ${seed}: ${prop.model} crosses an enclosure wall`);
    }

    const door = world.interactableDoors().find((prop) => prop.reclosable && prop.aquarium);
    assert.ok(door, `seed ${seed}: missing refuge shutter`);
    const x = (door.collider.minX + door.collider.maxX) / 2;
    const z = (door.collider.minZ + door.collider.maxZ) / 2;
    assert.ok(world.blocksAt(x, door.collider.minY, z, 0.1, 1.8),
      `seed ${seed}: closed shutter has no collision`);
    assert.ok(world.openDoor(door), `seed ${seed}: free shutter did not open`);
    assert.equal(world.interactableDoors().includes(door), true,
      `seed ${seed}: open shutter cannot be interacted with`);
    assert.equal(world.blocksAt(x, door.collider.minY, z, 0.1, 1.8), false,
      `seed ${seed}: open shutter still blocks passage`);
    assert.ok(world.closeDoor(door), `seed ${seed}: refuge shutter did not close`);
    assert.ok(world.blocksAt(x, door.collider.minY, z, 0.1, 1.8),
      `seed ${seed}: reclosed shutter has no collision`);
    assert.equal(world.zones.find((zone) => zone.id === door.zone)?.open, false,
      `seed ${seed}: sealed refuge remains an enemy spawn zone`);
  }
});

test('domestic habitat props render as recognisable multi-part furniture', () => {
  const renderer = new BuildingRenderer(new THREE.Scene(), {
    props: [], plan: { rooms: [], links: [] },
  });
  for (const def of HUMAN_ENCLOSURE_PROPS.filter((prop) => prop.shape)) {
    const parts = [];
    renderer._putHumanEnclosure({
      x: 0, y: 0, z: 0, rot: 0,
      sx: def.w, sy: def.h, sz: def.d,
      enclosureShape: def.shape,
    }, (material, part) => parts.push({ material, part }));
    assert.ok(parts.length >= 4, `${def.id} is still represented by one generic box`);
    assert.ok(new Set(parts.map((part) => part.material)).size >= 2,
      `${def.id} has no material cues distinguishing its parts`);
    assert.ok(parts.every(({ part }) => Object.values(part).every(Number.isFinite)),
      `${def.id} emitted invalid render dimensions`);
  }
});

test('all eight licensed model files and photographic caustics ship', () => {
  for (const spec of REVERSE_AQUARIUM_MODELS) {
    assert.ok(existsSync(path.join(ROOT, spec.path)), `${spec.path} is missing`);
  }
  assert.ok(existsSync(path.join(ROOT, REVERSE_AQUARIUM_CAUSTICS)),
    'aquarium caustics texture is missing');
  for (const prop of HUMAN_ENCLOSURE_MODELS) {
    assert.ok(existsSync(path.join(ROOT, 'assets/models', prop.model, 'scene.gltf')),
      `assets/models/${prop.model}/scene.gltf is missing`);
  }
});
