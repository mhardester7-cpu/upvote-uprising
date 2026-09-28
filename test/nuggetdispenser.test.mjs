import test from 'node:test';
import assert from 'node:assert/strict';

import { World, MAP_ARENA, MAP_COMPLEX } from '../src/world/world.js';
import {
  NUGGET_COUNT,
  NUGGET_DISPENSER_KIND,
  NUGGET_DISPENSER_RANGE,
  NUGGET_HEAL,
  NUGGET_RESTOCK,
  MAX_FLOOR_NUGGETS,
  NuggetDispenser,
  createNuggetDispenser,
  findNuggetDispenserProp,
} from '../src/entities/nuggetdispenser.js';

function generated(seed, map = MAP_COMPLEX) {
  const world = new World(seed, { map });
  for (const _ of world.generate()) { /* drain */ }
  return world;
}

function frontOf(dispenser, distance = 1.5) {
  return {
    x: dispenser.x + Math.sin(dispenser.yaw) * distance,
    y: dispenser.y,
    z: dispenser.z + Math.cos(dispenser.yaw) * distance,
  };
}

function fakePlayer(pos, health = 60) {
  return {
    pos: { ...pos },
    height: 1.8,
    health,
    maxHealth: 100,
    alive: true,
    heal(amount) { this.health = Math.min(this.maxHealth, this.health + amount); },
  };
}

test('every co-op complex generates one shared physical nugget dispenser', () => {
  for (let seed = 1; seed <= 24; seed++) {
    const world = generated(seed);
    const props = world.props.filter((prop) => prop.kind === NUGGET_DISPENSER_KIND);
    assert.equal(props.length, 1, `seed ${seed} did not generate exactly one machine`);

    const prop = props[0];
    assert.equal(prop.room, world.plan.start, `seed ${seed} machine left the start room`);
    assert.equal(prop.storey, 0, `seed ${seed} machine left the ground floor`);
    assert.ok(prop.collider?.kind === 'box');
    assert.ok(prop.collider.maxY - prop.collider.minY >= 2,
      `seed ${seed} machine collider is not full height`);
    assert.equal(world.blocksAt(prop.x, prop.y, prop.z, 0.1, 1.8, 0), true,
      `seed ${seed} machine does not participate in world collision`);
  }
});

test('the competitive arena intentionally has no local healing machine', () => {
  const world = generated(99, MAP_ARENA);
  assert.equal(findNuggetDispenserProp(world), null);
  assert.equal(createNuggetDispenser(world, { photoTexture: null }), null);
});

test('the detailed entity is mounted over its authored collider and has a usable front', () => {
  const world = generated(20260827);
  const prop = findNuggetDispenserProp(world);
  const dispenser = new NuggetDispenser(prop, { photoTexture: null });

  assert.equal(dispenser.x, prop.x);
  assert.equal(dispenser.y, prop.y);
  assert.equal(dispenser.z, prop.z);
  assert.equal(dispenser.mesh.userData.kind, NUGGET_DISPENSER_KIND);
  assert.ok(dispenser.mesh.children.length > 20, 'machine art is just a placeholder box');
  assert.ok(dispenser._nuggetGeometries.every((geometry) => geometry.type === 'ExtrudeGeometry'),
    'serving pieces fell back to gem-like primitive geometry');

  const near = fakePlayer(frontOf(dispenser, NUGGET_DISPENSER_RANGE - 0.2));
  const far = fakePlayer(frontOf(dispenser, NUGGET_DISPENSER_RANGE + 0.2));
  assert.equal(dispenser.inRange(near), true);
  assert.equal(dispenser.inRange(far), false);
  dispenser.dispose();
});

test('one serving is six nuggets, heals once, and cannot bypass the restock clock', () => {
  const world = generated(73);
  const dispenser = createNuggetDispenser(world, { photoTexture: null });
  const player = fakePlayer(frontOf(dispenser), 60);

  const first = dispenser.dispense(player);
  assert.deepEqual(first, { count: NUGGET_COUNT, healed: NUGGET_HEAL });
  assert.equal(player.health, 60 + NUGGET_HEAL);
  assert.equal(dispenser.ready, false);
  assert.equal(dispenser.dispense(player), null, 'cooldown paid out a second serving');
  assert.equal(player.health, 60 + NUGGET_HEAL);

  dispenser.update(NUGGET_RESTOCK - 0.01);
  assert.equal(dispenser.ready, false, 'machine restocked early');
  dispenser.update(0.02);
  assert.equal(dispenser.ready, true, 'machine never restocked');

  player.health = player.maxHealth;
  const snack = dispenser.dispense(player);
  assert.deepEqual(snack, { count: NUGGET_COUNT, healed: 0 },
    'a full-health nugget lover should still get a serving');
  dispenser.dispose();
});

test('dispensing ejects tumbling nuggets that bounce, settle, and persist through restocking', () => {
  const world = generated(8128);
  const dispenser = createNuggetDispenser(world, { photoTexture: null });
  const player = fakePlayer(frontOf(dispenser));

  dispenser.dispense(player);
  dispenser.update(0.42);
  assert.ok(dispenser.flap.rotation.x < -0.4, 'serving hatch never opened');
  assert.ok(dispenser.serving.some((nugget) => nugget.visible),
    'no physical nugget left the chute');
  assert.ok(dispenser._nuggetBodies.some((body) => body.state === 'flying'
    && body.velocity.y < 0), 'served nuggets did not fall under gravity');
  assert.match(dispenser.prompt(), /RESTOCKING/);

  dispenser.update(3);
  assert.equal(dispenser.settledNuggets.length, NUGGET_COUNT);
  assert.ok(dispenser._nuggetBodies.every((body) => body.bounces >= 1),
    'nuggets snapped to the floor without a physical impact/bounce');
  assert.ok(dispenser.serving.every((nugget) => nugget.visible),
    'served nuggets disappeared after landing');
  assert.ok(dispenser.serving.every((nugget) => Math.abs(nugget.position.y - 0.095) < 0.001
    && nugget.position.z > 0.65), 'nuggets did not land on the floor in front of the machine');

  dispenser.update(NUGGET_RESTOCK);
  assert.equal(dispenser.ready, true);
  assert.equal(dispenser.settledNuggets.length, NUGGET_COUNT,
    'the settled serving was cleared by the cooldown');
  dispenser.reset();
  assert.equal(dispenser.ready, true);
  assert.match(dispenser.prompt(), /6 CHICKEN NUGGETS/);
  dispenser.dispose();
});

test('the safety cap suppresses new visuals without moving or removing settled nuggets', () => {
  const world = generated(481516);
  const dispenser = createNuggetDispenser(world, { photoTexture: null });
  const player = fakePlayer(frontOf(dispenser));
  const servingsToCap = MAX_FLOOR_NUGGETS / NUGGET_COUNT;

  for (let cycle = 0; cycle < servingsToCap; cycle++) {
    assert.ok(dispenser.dispense(player));
    dispenser.update(4);
    assert.ok(dispenser._nuggetBodies.length <= MAX_FLOOR_NUGGETS);
    assert.equal(dispenser._nuggetBodies.filter((body) => body.mesh.visible).length,
      (cycle + 1) * NUGGET_COUNT,
      `cycle ${cycle} unexpectedly removed visible nuggets`);
    dispenser.update(NUGGET_RESTOCK);
  }

  assert.equal(dispenser._nuggetBodies.length, MAX_FLOOR_NUGGETS);
  assert.equal(dispenser.settledNuggets.length, MAX_FLOOR_NUGGETS);
  const settledAtCap = dispenser.settledNuggets.map((mesh) => ({
    mesh,
    position: mesh.position.clone(),
    quaternion: mesh.quaternion.clone(),
  }));

  for (let overflow = 0; overflow < 3; overflow++) {
    assert.ok(dispenser.dispense(player), 'visual cap must not disable the gameplay serving');
    assert.equal(dispenser.serving.length, 0, 'the cap allocated an unbounded visual body');
    dispenser.update(4);
    dispenser.update(NUGGET_RESTOCK);
  }

  assert.equal(dispenser.settledNuggets.length, MAX_FLOOR_NUGGETS);
  for (const original of settledAtCap) {
    assert.ok(dispenser.settledNuggets.includes(original.mesh),
      `settled nugget ${original.mesh.id} disappeared at the cap`);
    assert.ok(original.mesh.position.distanceTo(original.position) < 1e-9,
      `settled nugget ${original.mesh.id} moved at the cap`);
    assert.ok(1 - Math.abs(original.mesh.quaternion.dot(original.quaternion)) < 1e-9,
      `settled nugget ${original.mesh.id} rotated at the cap`);
  }
  dispenser.dispose();
});
