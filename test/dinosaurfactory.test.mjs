import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as THREE from '../vendor/three.module.js';
import { World, MAP_ARENA, MAP_COMPLEX } from '../src/world/world.js';
import {
  DINOSAUR_ATTACK_RANGE,
  DINOSAUR_BITE_DAMAGE,
  DINOSAUR_FACTORY_COST,
  DINOSAUR_FACTORY_INSTRUCTIONS,
  DINOSAUR_FACTORY_KIND,
  DINOSAUR_FACTORY_RANGE,
  DINOSAUR_MAX_CATCHUP_SPEED,
  DINOSAUR_MODEL,
  DINOSAUR_MODEL_FORWARD_OFFSET,
  DINOSAUR_PRODUCTION_TIME,
  DINOSAUR_SKIN,
  DinosaurAlly,
  DinosaurFactory,
  classifyDinosaurClips,
  createDinosaurFactory,
  dinosaurRenderedForward,
  findDinosaurFactoryProp,
} from '../src/entities/dinosaurfactory.js';
import { DINOSAUR_FACTORY_ROLE } from '../src/world/complex.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function generated(seed, map = MAP_COMPLEX) {
  const world = new World(seed, { map });
  for (const _ of world.generate()) { /* drain */ }
  return world;
}

function frontOf(factory, distance = 1.5) {
  return {
    x: factory.x + Math.sin(factory.yaw) * distance,
    y: factory.y,
    z: factory.z + Math.cos(factory.yaw) * distance,
  };
}

function playerAt(pos) {
  return { pos: { ...pos }, height: 1.8, yaw: 0, alive: true };
}

function openWorld(blocksAt = () => false) {
  return {
    heightAt: () => 0,
    supportHeight: () => 0,
    inBounds: (x, z) => x > -100 && x < 100 && z > -100 && z < 100,
    blocksAt,
    raycast: () => ({ hit: false, distance: Infinity }),
  };
}

test('every co-op complex generates one indoor dinosaur factory room and collider', () => {
  for (let seed = 1; seed <= 32; seed++) {
    const world = generated(seed);
    const props = world.props.filter((prop) => prop.kind === DINOSAUR_FACTORY_KIND);
    assert.equal(props.length, 1, `seed ${seed} did not generate exactly one factory`);

    const prop = props[0];
    const room = world.plan.rooms.find((candidate) => candidate.id === prop.room);
    assert.equal(world.plan.dinosaurFactoryRoom, room.id);
    assert.equal(room.role.id, DINOSAUR_FACTORY_ROLE);
    assert.equal(room.label, 'DINOSAUR FACTORY');
    assert.equal(room.outdoor, false, `seed ${seed} put cloning equipment outdoors`);
    assert.equal(prop.storey, 0);
    assert.equal(prop.collider?.kind, 'box');
    assert.ok(prop.collider.maxY - prop.collider.minY >= 2.7);
    assert.equal(world.blocksAt(prop.x, prop.y, prop.z, 0.1, 1.8, 0), true,
      `seed ${seed} factory does not participate in collision`);
  }
});

test('every generated route puts the factory one free door beyond spawn as a room-two choice', () => {
  for (let seed = 1; seed <= 64; seed++) {
    const world = generated(seed);
    const room = world.plan.rooms.find((candidate) =>
      candidate.id === world.plan.dinosaurFactoryRoom);
    assert.ok(room, `seed ${seed}: no dinosaur factory room`);
    assert.equal(room.depth, 1, `seed ${seed}: factory is not a room-two choice`);
    const entrance = world.plan.links.find((link) =>
      (link.a === world.plan.start && link.b === room.id)
      || (link.b === world.plan.start && link.a === room.id));
    assert.ok(entrance, `seed ${seed}: factory is not directly connected to spawn`);
    assert.equal(entrance.barrier, true, `seed ${seed}: factory route lost its physical door`);
    assert.equal(entrance.price, 0, `seed ${seed}: factory entrance is not free`);
    assert.ok(world.props.some((prop) => prop.type === 'door' && prop.link === entrance),
      `seed ${seed}: factory entrance has no door prop`);
    assert.equal(room.role.id, DINOSAUR_FACTORY_ROLE);
  }
});

test('the competitive arena intentionally has no local dinosaur companion', async () => {
  const world = generated(99, MAP_ARENA);
  assert.equal(findDinosaurFactoryProp(world), null);
  assert.equal(await createDinosaurFactory(world, { asset: {} }), null);
});

test('the detailed factory has a usable front, physical pod, doors and control bank', () => {
  const world = generated(20260827);
  const prop = findDinosaurFactoryProp(world);
  const factory = new DinosaurFactory(prop, world, {});

  assert.equal(factory.mesh.userData.kind, DINOSAUR_FACTORY_KIND);
  assert.ok(factory.factoryRoot.children.length >= 20, 'factory is only placeholder geometry');
  assert.ok(factory.leftDoor && factory.rightDoor && factory.progressBar);
  assert.equal(factory.instructionLabel.name, 'dinosaur-factory-instructions');
  assert.deepEqual(factory.instructionLabel.userData.instructions, [
    'DINOSAUR FACTORY',
    'GET CLOSE + PRESS E  •  COST 1,500',
    'HATCHES AN ALLY THAT HUNTS ZOMBIES',
  ]);
  assert.deepEqual(factory.instructionLabel.userData.instructions, [...DINOSAUR_FACTORY_INSTRUCTIONS]);
  assert.equal(factory.inRange(playerAt(frontOf(factory, DINOSAUR_FACTORY_RANGE - 0.2))), true);
  assert.equal(factory.inRange(playerAt(frontOf(factory, DINOSAUR_FACTORY_RANGE + 0.2))), false);
  assert.match(factory.prompt(DINOSAUR_FACTORY_COST), /CLONE VELOCIRAPTOR/);
  assert.match(factory.prompt(DINOSAUR_FACTORY_COST - 250), /NEED 250 COINS/);
  factory.dispose();
});

test('the cloning cycle grows, opens, and hatches on the room floor', () => {
  const world = generated(473);
  const factory = new DinosaurFactory(findDinosaurFactoryProp(world), world, {});
  const player = playerAt(frontOf(factory));

  assert.equal(factory.start(), true);
  assert.equal(factory.start(), false, 'a second cycle started while the first was running');
  factory.update(DINOSAUR_PRODUCTION_TIME * 0.5, player, [], () => null);
  assert.equal(factory.producing, true);
  assert.ok(factory.ally.mesh.visible);
  assert.ok(factory.ally.mesh.scale.x > 0.1 && factory.ally.mesh.scale.x < 1);
  assert.match(factory.prompt(), /CLONING VELOCIRAPTOR/);

  const event = factory.update(DINOSAUR_PRODUCTION_TIME * 0.51, player, [], () => null);
  assert.equal(event?.kind, 'hatched');
  assert.equal(factory.deployed, true);
  assert.ok(Math.abs(factory.leftDoor.rotation.y) > 0.8);
  assert.ok(Math.abs(factory.ally.pos.y - factory.y) < 0.08,
    'the raptor hatched below or above the indoor slab');
  assert.match(factory.prompt(), /DEPLOYED/);
  factory.dispose();
});

test('the raptor seeks a nearby zombie and lands one bite at the attack impact frame', () => {
  const world = generated(8128);
  // Isolate companion movement from unrelated room furniture while keeping the
  // real generated support-height behavior used by the hatch.
  world.blocksAt = () => false;
  world.raycast = () => ({ hit: false, distance: Infinity });
  const factory = new DinosaurFactory(findDinosaurFactoryProp(world), world, {});
  const player = playerAt(frontOf(factory, 2.5));
  factory.start();
  factory.update(DINOSAUR_PRODUCTION_TIME, player, [], () => null);

  const enemy = {
    id: 17,
    alive: true,
    pos: {
      x: factory.ally.pos.x + Math.sin(factory.yaw) * (DINOSAUR_ATTACK_RANGE - 0.1),
      y: factory.ally.pos.y,
      z: factory.ally.pos.z + Math.cos(factory.yaw) * (DINOSAUR_ATTACK_RANGE - 0.1),
    },
    type: { height: 1.8, width: 0.7 },
  };
  const bites = [];
  const damage = (target, amount) => {
    bites.push({ target, amount });
    return { killed: false, enemy: target };
  };

  factory.update(1 / 60, player, [enemy], damage);
  let biteEvent = null;
  for (let i = 0; i < 9; i++) {
    biteEvent ??= factory.update(0.05, player, [enemy], damage);
  }
  assert.equal(bites.length, 1, 'bite damage was missing or applied more than once');
  assert.equal(bites[0].target, enemy);
  assert.equal(bites[0].amount, DINOSAUR_BITE_DAMAGE);
  assert.equal(biteEvent?.kind, 'bite');
  assert.equal(factory.ally.state, 'attack');
  factory.dispose();
});

test('the raptor visual faces the same direction it runs instead of moonwalking', () => {
  const ally = new DinosaurAlly(openWorld(), {});
  ally.hatch(0, 0, 0, 0);
  const player = playerAt({ x: 0, y: 0, z: 12 });
  player.yaw = Math.PI;

  ally.update(0.1, player, [], () => null);
  const forward = dinosaurRenderedForward(ally.mesh.rotation.y);
  const travel = Math.hypot(ally.pos.x, ally.pos.z);
  assert.ok(travel > 0.1, 'the raptor did not move');
  assert.ok((forward.x * ally.pos.x + forward.z * ally.pos.z) / travel > 0.96,
    'the visible nose points opposite the direction of travel');
  assert.ok(Math.abs(ally.mesh.rotation.y - (ally.yaw + DINOSAUR_MODEL_FORWARD_OFFSET)) < 1e-9);
  ally.dispose();
});

test('a distant companion catches up at bounded running speed without teleporting', () => {
  const ally = new DinosaurAlly(openWorld(), {});
  ally.hatch(0, 0, 0, 0);
  const player = playerAt({ x: 0, y: 0, z: 50 });
  player.yaw = Math.PI;
  let greatestStep = 0;
  const dt = 0.05;
  for (let i = 0; i < 140; i++) {
    const before = { ...ally.pos };
    ally.update(dt, player, [], () => null);
    greatestStep = Math.max(greatestStep,
      Math.hypot(ally.pos.x - before.x, ally.pos.z - before.z));
  }
  assert.ok(Math.hypot(player.pos.x - ally.pos.x, player.pos.z - ally.pos.z) < 4,
    'the companion never caught the far-away player');
  assert.ok(greatestStep <= DINOSAUR_MAX_CATCHUP_SPEED * dt + 1e-6,
    'catch-up used a visible long-range teleport');
  ally.dispose();
});

test('player breadcrumbs lead the companion around a wall corner and through its doorway', () => {
  // A wall blocks the direct diagonal. Its opening is beyond z=5, so the
  // player-authored route must first go north, then turn east through the gap.
  const blocked = (x, _y, z, radius) => x + radius > 2.6 && x - radius < 3.4
    && z - radius < 5.0;
  const ally = new DinosaurAlly(openWorld(blocked), {});
  ally.hatch(0, 0, 0, 0);
  const player = playerAt({ x: 0, y: 0, z: 0 });
  player.yaw = -Math.PI / 2;

  for (let z = 0.7; z <= 6.3; z += 0.7) {
    player.pos.z = z;
    ally._recordPlayer(player);
  }
  for (let x = 0.7; x <= 7; x += 0.7) {
    player.pos.x = x;
    ally._recordPlayer(player);
  }

  for (let i = 0; i < 260; i++) ally.update(0.05, player, [], () => null);
  assert.ok(ally.pos.x > 5.5 && ally.pos.z > 5.0,
    `raptor remained stuck before the corner at (${ally.pos.x}, ${ally.pos.z})`);
  assert.ok(Math.hypot(player.pos.x - ally.pos.x, player.pos.z - ally.pos.z) < 3.6,
    'raptor did not finish catching the player after the doorway turn');
  ally.dispose();
});

test('the real facility nav carries the ally through opened doors and several room corners', () => {
  const world = generated(20260827);
  for (const door of [...world.doors()]) world.openDoor(door);
  const factory = new DinosaurFactory(findDinosaurFactoryProp(world), world, {});
  const hatchPlayer = playerAt(frontOf(factory));
  factory.start();
  factory.update(DINOSAUR_PRODUCTION_TIME, hatchPlayer, [], () => null);

  const factoryRoom = world.plan.rooms.find((room) => room.id === factory.prop.room);
  const destination = world.plan.rooms
    .filter((room) => room.id !== factoryRoom.id && room.storeys >= 1)
    .sort((a, b) => Math.hypot(b.cx - factoryRoom.cx, b.cz - factoryRoom.cz)
      - Math.hypot(a.cx - factoryRoom.cx, a.cz - factoryRoom.cz))[0];
  const player = playerAt({ x: destination.cx, y: destination.floorY, z: destination.cz });
  player.yaw = 0;
  const initialDistance = Math.hypot(player.pos.x - factory.ally.pos.x,
    player.pos.z - factory.ally.pos.z);
  assert.ok(initialDistance > 70, 'fixture does not exercise a genuinely distant multi-room route');

  const dt = 0.05;
  let maxStep = 0;
  for (let i = 0; i < Math.ceil((initialDistance * 3 / DINOSAUR_MAX_CATCHUP_SPEED + 20) / dt); i++) {
    const before = { ...factory.ally.pos };
    factory.update(dt, player, [], () => null);
    maxStep = Math.max(maxStep, Math.hypot(factory.ally.pos.x - before.x,
      factory.ally.pos.z - before.z));
  }
  assert.ok(Math.hypot(player.pos.x - factory.ally.pos.x,
    player.pos.z - 2.25 - factory.ally.pos.z) < 1.1,
  `ally ${JSON.stringify(factory.ally.pos)} goal ${JSON.stringify(player.pos)} initial ${initialDistance}`);
  assert.ok(maxStep <= DINOSAUR_MAX_CATCHUP_SPEED * dt + 1e-6,
    'multi-room recovery teleported the ally');
  factory.dispose();
});

test('a stationary follow goal does not repeatedly rebuild the companion flow field', () => {
  const world = generated(317);
  for (const door of [...world.doors()]) world.openDoor(door);
  const factory = new DinosaurFactory(findDinosaurFactoryProp(world), world, {});
  const factoryRoom = world.plan.rooms.find((room) => room.id === factory.prop.room);
  const destination = world.plan.rooms
    .filter((room) => room.id !== factoryRoom.id)
    .sort((a, b) => Math.hypot(b.cx - factoryRoom.cx, b.cz - factoryRoom.cz)
      - Math.hypot(a.cx - factoryRoom.cx, a.cz - factoryRoom.cz))[0];
  const player = playerAt({ x: destination.cx, y: destination.floorY, z: destination.cz });
  factory.start();
  factory.update(DINOSAUR_PRODUCTION_TIME, player, [], () => null);
  factory.update(0.05, player, [], () => null);
  assert.ok(factory.ally.nav, 'companion navigation was not lazily initialized');

  const originalUpdate = factory.ally.nav.update.bind(factory.ally.nav);
  let sweeps = 0;
  factory.ally.nav.update = (...args) => { sweeps++; return originalUpdate(...args); };
  for (let i = 0; i < 100; i++) factory.update(0.05, player, [], () => null);
  assert.equal(sweeps, 0, 'stationary player caused unnecessary full-field sweeps');
  factory.dispose();
});

test('the loaded ally visibly binds the reptile texture to its actual body material', () => {
  const model = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1.4, 2.8),
    new THREE.MeshStandardMaterial({ name: 'Raptor_Body', color: 0x222222 }),
  );
  body.name = 'VelociraptorBody';
  model.add(body);
  const skinTexture = new THREE.Texture();
  skinTexture.name = 'real-lizard-skin';
  const ally = new DinosaurAlly(openWorld(), { model, skinTexture });

  let texturedBody = null;
  ally.visual.traverse((object) => {
    if (object.name === 'VelociraptorBody') texturedBody = object;
  });
  assert.ok(texturedBody, 'loaded body mesh was lost during preparation');
  assert.equal(texturedBody.material.map, skinTexture);
  assert.equal(texturedBody.material.bumpMap, skinTexture);
  assert.equal(texturedBody.material.userData.dinosaurSkin, true);
  assert.equal(texturedBody.material.color.getHex(), 0xffffff,
    'a dark material tint hides the photographic skin');
  assert.ok(ally.visual.userData.texturedMeshCount >= 1,
    'runtime reported no visibly textured FBX material');
  ally.dispose();
});

test('the bundled CC0 velociraptor and real reptile skin are installed and credited', () => {
  const model = path.join(ROOT, DINOSAUR_MODEL);
  const skin = path.join(ROOT, DINOSAUR_SKIN);
  assert.equal(existsSync(model), true);
  assert.equal(existsSync(skin), true);
  assert.ok(statSync(model).size > 900_000, 'velociraptor FBX is missing or truncated');
  assert.ok(statSync(skin).size > 150_000, 'photographic reptile texture is missing or truncated');

  // FBX is binary, but animation stack names are stored as readable strings.
  // Verify the exact motions the runtime classifies and cross-fades between.
  const fbx = readFileSync(model).toString('latin1');
  for (const clip of ['Idle', 'Walk', 'Run', 'Attack', 'Jump', 'Death']) {
    assert.ok(fbx.includes(`Velociraptor_${clip}`), `FBX has no ${clip} animation`);
  }

  const clips = classifyDinosaurClips([
    new THREE.AnimationClip('Armature|Velociraptor_Idle', 1, []),
    new THREE.AnimationClip('Armature|Velociraptor_Run', 1, []),
    new THREE.AnimationClip('Armature|Velociraptor_Attack', 1, []),
  ]);
  assert.deepEqual(Object.keys(clips), ['idle', 'run', 'attack']);

  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'assets/manifest.json'), 'utf8'));
  const dinosaurAssets = manifest.creatures.filter((entry) =>
    entry.id === 'animated_velociraptor' || entry.id === 'bearded_dragon_skin');
  assert.equal(dinosaurAssets.length, 2);
  assert.ok(dinosaurAssets.every((entry) => entry.source === 'direct'));
  assert.ok(dinosaurAssets.every((entry) => entry.license === 'CC0'));
  assert.ok(dinosaurAssets.some((entry) => entry.author === 'Quaternius'));
  assert.ok(dinosaurAssets.some((entry) => entry.author === 'RooMan93'));
});
