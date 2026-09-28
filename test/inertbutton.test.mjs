import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as THREE from '../vendor/three.module.js';
import { World, MAP_ARENA, MAP_COMPLEX } from '../src/world/world.js';
import {
  INERT_BUTTON_MODEL,
  INERT_BUTTON_PRESS_TIME,
  INERT_BUTTON_RANGE,
  InertButton,
  ImportantButton,
  createInertButton,
  findInertButtonMount,
} from '../src/entities/inertbutton.js';

function generatedWorld(seed, map = MAP_COMPLEX) {
  const world = new World(seed, { map });
  for (const _ of world.generate()) { /* exhaust deterministic generator */ }
  return world;
}

function mountFingerprint(mount) {
  return {
    x: mount.x,
    y: mount.y,
    z: mount.z,
    nx: mount.nx,
    nz: mount.nz,
    yaw: mount.yaw,
    roomId: mount.roomId,
    lowMount: mount.lowMount,
    wall: {
      x: mount.wall.x,
      y: mount.wall.y,
      z: mount.wall.z,
      sx: mount.wall.sx,
      sy: mount.wall.sy,
      sz: mount.wall.sz,
    },
  };
}

function targetPoint(button) {
  return {
    x: button.mount.x + button.mount.nx * button._targetZ,
    y: button.mount.y,
    z: button.mount.z + button.mount.nz * button._targetZ,
  };
}

function playerAimingAt(button, distance = 2, horizontalOffset = 0) {
  const target = targetPoint(button);
  const tangentX = -button.mount.nz, tangentZ = button.mount.nx;
  const eye = {
    x: target.x + button.mount.nx * distance,
    y: target.y,
    z: target.z + button.mount.nz * distance,
  };
  const aimed = {
    x: target.x + tangentX * horizontalOffset,
    y: target.y,
    z: target.z + tangentZ * horizontalOffset,
  };
  const raw = { x: aimed.x - eye.x, y: aimed.y - eye.y, z: aimed.z - eye.z };
  const length = Math.hypot(raw.x, raw.y, raw.z);
  return {
    pos: { x: eye.x, y: eye.y - 1.64, z: eye.z },
    eyeY: eye.y,
    height: 1.8,
    getLookDir(out = {}) {
      out.x = raw.x / length;
      out.y = raw.y / length;
      out.z = raw.z / length;
      return out;
    },
  };
}

test('mount selection is deterministic, room-facing, and available across generated complex maps', () => {
  for (let seed = 1; seed <= 36; seed++) {
    const world = generatedWorld(seed);
    const mount = findInertButtonMount(world);
    assert.ok(mount, `seed ${seed} has no button mount`);
    assert.ok(world.props.includes(mount.wall), `seed ${seed} chose geometry outside world props`);
    assert.equal(mount.wall.room, world.plan.start, `seed ${seed} did not use the start room`);
    assert.equal(Math.hypot(mount.nx, mount.nz), 1, `seed ${seed} normal is not unit length`);

    const room = world.plan.rooms.find((candidate) => candidate.id === world.plan.start);
    const inward = (room.cx - mount.x) * mount.nx + (room.cz - mount.z) * mount.nz;
    assert.ok(inward > 0, `seed ${seed} mount faces out of the room`);
  }

  const first = findInertButtonMount(generatedWorld(74591));
  const second = findInertButtonMount(generatedWorld(74591));
  assert.deepEqual(mountFingerprint(first), mountFingerprint(second));
});

test('the versus arena intentionally has no inert landmark', () => {
  const arena = generatedWorld(99, MAP_ARENA);
  assert.equal(findInertButtonMount(arena), null);
  assert.equal(InertButton.fromWorld(arena), null);
});

test('procedural construction and pressing never register or mutate a world prop', () => {
  const world = generatedWorld(20260825);
  const props = world.props;
  const propCount = props.length;
  const buckets = world.buckets;
  const bucketSizes = [...buckets].map(([key, values]) => [key, values.length]);
  const barriers = world.barriers;
  const barrierSnapshot = barriers.map((barrier) => ({
    open: barrier.open,
    health: barrier.health,
    boards: barrier.boards?.length,
  }));

  const button = InertButton.fromWorld(world);
  assert.ok(button);
  assert.equal(button.usesLoadedModel, false);
  assert.ok(!props.includes(button), 'entity itself entered the collision prop set');
  assert.ok(!props.includes(button.mesh), 'render mesh entered the collision prop set');

  button.press();
  button.update(0.08);
  button.update(1);
  button.reset();

  assert.equal(world.props, props);
  assert.equal(world.props.length, propCount);
  assert.equal(world.buckets, buckets);
  assert.deepEqual([...world.buckets].map(([key, values]) => [key, values.length]), bucketSizes);
  assert.equal(world.barriers, barriers);
  assert.deepEqual(barrierSnapshot, barriers.map((barrier) => ({
    open: barrier.open,
    health: barrier.health,
    boards: barrier.boards?.length,
  })));
  button.dispose();
});

test('look targeting uses an analytic face, range limit, and existing-world occlusion only', () => {
  const world = generatedWorld(42);
  const button = InertButton.fromWorld(world);
  const calls = [];
  const clearWorld = {
    raycast(...args) {
      calls.push(args);
      return { hit: false, distance: args[6] };
    },
  };

  assert.equal(button.targetedBy(playerAimingAt(button), clearWorld), true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0][6] < 2 && calls[0][6] > 1.8,
    `occlusion ray should stop before the button, got ${calls[0][6]}`);

  assert.equal(button.targetedBy(playerAimingAt(button, INERT_BUTTON_RANGE + 0.1), clearWorld), false,
    'button was targetable outside its range');
  assert.equal(button.targetedBy(playerAimingAt(button, 2, 1.1), clearWorld), false,
    'view ray outside the face was accepted');

  const away = playerAimingAt(button);
  away.getLookDir = (out = {}) => {
    out.x = button.mount.nx;
    out.y = 0;
    out.z = button.mount.nz;
    return out;
  };
  assert.equal(button.isTargeted(away, clearWorld), false, 'backward view ray was accepted');

  const blockedWorld = {
    raycast(...args) {
      return { hit: true, distance: args[6] * 0.5 };
    },
  };
  assert.equal(button.targetedBy(playerAimingAt(button), blockedWorld), false,
    'solid cover did not hide the button');
  button.dispose();
});

test('press visibly depresses the cap and returns exactly to rest without retained state', () => {
  const world = generatedWorld(7);
  const button = InertButton.fromWorld(world);
  const restZ = button.cap.position.z;
  const restRingScale = button.ring.scale.x;

  assert.equal(button.press(), true);
  button.update(0.055);
  assert.ok(button.cap.position.z < restZ - 0.02, 'cap did not visibly depress');
  assert.ok(button.ring.scale.x > restRingScale, 'press overlay did not react');

  button.update(INERT_BUTTON_PRESS_TIME + 0.5);
  assert.equal(button.cap.position.z, restZ);
  assert.equal(button.ring.scale.x, restRingScale);
  assert.equal(button._pressing, false);

  // Repeated presses restart the same transient animation; there is no count,
  // latch, result, reward, event callback or persistent state to accumulate.
  for (let i = 0; i < 5; i++) {
    button.press();
    button.update(INERT_BUTTON_PRESS_TIME + 0.01);
  }
  assert.equal(button.cap.position.z, restZ);
  assert.equal(button._pressing, false);
  button.dispose();
});

test('async factory consumes the bundled model name but leaves cached GLB resources shared', async () => {
  const world = generatedWorld(31415);
  const source = new THREE.Group();
  const geometry = new THREE.BoxGeometry(3, 4, 1);
  const material = new THREE.MeshStandardMaterial({ color: 0x223344 });
  const sourceMesh = new THREE.Mesh(geometry, material);
  source.add(sourceMesh);

  let geometryDisposals = 0, materialDisposals = 0, requestedName = null;
  geometry.addEventListener('dispose', () => { geometryDisposals++; });
  material.addEventListener('dispose', () => { materialDisposals++; });

  const button = await createInertButton(world, {
    loadModel: async (name) => {
      requestedName = name;
      return { scene: source };
    },
  });

  assert.equal(requestedName, INERT_BUTTON_MODEL);
  assert.equal(button.usesLoadedModel, true);
  assert.ok(button.modelRoot);
  assert.equal(source.parent, null, 'factory reparented the cached model');
  const cloneMesh = button.modelRoot.getObjectByProperty('isMesh', true);
  assert.ok(cloneMesh);
  assert.notEqual(cloneMesh, sourceMesh);
  assert.equal(cloneMesh.geometry, geometry, 'model clone unexpectedly duplicated cached geometry');

  button.dispose();
  assert.equal(geometryDisposals, 0, 'entity disposed shared GLB geometry');
  assert.equal(materialDisposals, 0, 'entity disposed shared GLB material');
  geometry.dispose();
  material.dispose();
});

test('a failed or disabled model load always leaves a deterministic procedural button', async () => {
  const world = generatedWorld(8675309);
  const failed = await createInertButton(world, {
    loadModel: async () => { throw new Error('bad glb'); },
  });
  assert.ok(failed);
  assert.equal(failed.usesLoadedModel, false);
  assert.ok(failed.mesh.getObjectByName('inert-button-cap'));

  const disabled = await createInertButton(world, { loadModel: false });
  assert.ok(disabled);
  assert.equal(disabled.usesLoadedModel, false);
  assert.deepEqual(mountFingerprint(failed.mount), mountFingerprint(disabled.mount));
  failed.dispose();
  disabled.dispose();
});

test('dispose releases only instance-owned fallback and overlay resources', () => {
  const world = generatedWorld(1234);
  const button = InertButton.fromWorld(world);
  let geometryDisposals = 0, materialDisposals = 0;
  button.cap.geometry.addEventListener('dispose', () => { geometryDisposals++; });
  button.cap.material.addEventListener('dispose', () => { materialDisposals++; });

  button.dispose();
  button.dispose();
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
  assert.equal(button.press(), false);
});

test('ImportantButton is the documented alias of InertButton', () => {
  assert.equal(ImportantButton, InertButton);
});

test('the game mounts, prompts, animates, and voices the wall button', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /import \{ createInertButton \} from '\.\/entities\/inertbutton\.js'/);
  assert.match(main, /\['button', 'wall button', \(\) => this\._mountImportantButton\(\)\]/,
    'the startup asset gate should await the wall button before play');
  assert.match(main, /this\.importantButton\?\.targetedBy\(this\.player, this\.world\)/);
  assert.match(main, /this\.audio\.buttonMoan\(\)/);
  assert.match(main, /this\.importantButton\?\.update\(frameDt\)/);
  assert.match(main, /PRIORITY OVERRIDE/);
});
