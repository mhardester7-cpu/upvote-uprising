// Enemy AI: where they come from, how they get to you, and what fits indoors.
//
// These assert the three things that were wrong and are easy to break again:
//
//   Zombies come from OUTSIDE and break in. A spawner that puts them in the
//   room with the player is not a shortcut, it is a different game -- the
//   boarded window is the whole premise of the mode, and if nothing ever
//   arrives at one, none of it happens.
//
//   Wherever they are is where they can get to you from. Every spawn, every
//   rescue teleport, has to land somewhere with a route -- through a door or
//   through a window. A body with no route is a body that mills about in a
//   corner for the rest of the wave.
//
//   Everything in the roster fits through a door. An enemy too big for the
//   building is an enemy the player walks away from.

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world/world.js';
import { GameSim, WAVE_ENEMY_TYPES } from '../src/sim/gamesim.js';
import { ENEMY_TYPES, Enemy } from '../src/entities/enemy.js';
import { LocalSession } from '../src/net/session.js';
import { BOARD_TIME } from '../src/world/barriers.js';
import { WEAPONS, WeaponSystem } from '../src/combat/weapons.js';
import { ACTIONS } from '../src/engine/bindings.js';
import { NavGrid } from '../src/world/navgrid.js';
import { DOOR_W, DOOR_H, FLOOR_H, SLAB_T } from '../src/world/complex.js';
import { buildEnemyMesh, syncEnemyMesh, disposeEnemyMesh } from '../src/render/enemymesh.js';

/** A generated world plus a sim with one player standing in the start room. */
function scene(seed) {
  const w = new World(seed);
  for (const _ of w.generate()) { /* run to completion */ }
  const s = new GameSim(seed, { world: w });
  const p = s.addPlayer(1, 'PLAYER');
  const st = w.startZone.site;
  p.pos.x = st.cx; p.pos.y = st.floorY; p.pos.z = st.cz;
  s.running = true;
  s._ensureNav();
  return { w, s, p, st };
}

const outsideComplex = (w, x, z) => {
  const b = w.plan.bounds;
  return x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1;
};

// ------------------------------------------------------------------ spawning

test('co-op waves use the core horde plus one Clippy on wave five only', () => {
  assert.deepEqual(WAVE_ENEMY_TYPES, ['grunt', 'runner', 'clippy']);
  const sim = new GameSim(17);
  for (const wave of [1, 2, 4, 6, 9, 10, 15, 25, 50]) {
    sim.wave = wave;
    const queue = sim._composeWave(500);
    assert.ok(queue.every((type) => type === 'grunt' || type === 'runner'));
    assert.equal(queue.includes('clippy'), false, `wave ${wave} scheduled Clippy early`);
  }
  sim.wave = 5;
  const queue = sim._composeWave(500);
  assert.equal(queue.filter((type) => type === 'clippy').length, 1,
    'wave five did not schedule exactly one Clippy');
  assert.ok(queue.every((type) => WAVE_ENEMY_TYPES.includes(type)));
  sim.wave = 5;
  assert.equal(sim.isBossWave, false, 'wave five still schedules the abomination');
});

test('later levels get harder by sending a larger horde', () => {
  const sim = new GameSim(18);
  sim.wave = 0;
  sim.startWave();
  const openingTotal = sim.waveTotal;
  const openingLive = sim.maxLive;
  sim.wave = 19;
  sim.startWave();
  assert.ok(sim.waveTotal >= openingTotal * 6,
    `wave 20 has only ${sim.waveTotal} bodies after wave one had ${openingTotal}`);
  assert.ok(sim.maxLive > openingLive, 'the simultaneous horde never grows');
  assert.ok(sim.spawnQueue.every((type) => WAVE_ENEMY_TYPES.includes(type)));
});

test('Clippy is an unarmoured mini-boss with its own procedural silhouette', () => {
  const t = ENEMY_TYPES.clippy;
  assert.equal(t.miniboss, true);
  assert.equal(t.boss, undefined, 'Clippy accidentally inherited boss armour rules');

  const e = new Enemy('clippy', {
    blocksAt: () => false, resolveProps: () => false, supportHeight: () => 0,
  });
  e.damage(100, { origin: { x: 0, y: 0, z: 10 } });
  assert.equal(e.health, t.health - 100, 'Clippy reduced an ordinary frontal hit');

  const mesh = buildEnemyMesh('clippy');
  assert.ok(mesh.getObjectByName('paperclip'), 'the paperclip body is missing');
  assert.ok(mesh.getObjectByName('eyeL') && mesh.getObjectByName('eyeR'), 'Clippy lost its eyes');
  assert.ok(mesh.getObjectByName('pupilL') && mesh.getObjectByName('pupilR'), 'Clippy lost its pupils');
  e.group = mesh;
  e.pos = { x: 2, y: 0, z: 3 };
  e.vel = { x: t.speed, y: 0, z: 0 };
  assert.doesNotThrow(() => syncEnemyMesh(e, 1, 1 / 60));
  disposeEnemyMesh(mesh);
});

test('zombies spawn outside the complex, at a window, with a route in', () => {
  for (const seed of [20260725, 31337, 4242]) {
    const { w, s, p } = scene(seed);
    // Wave one: only the start room is open, and it has windows onto the
    // outside. Anything else would mean the level generator stopped putting the
    // player somewhere a horde can reach.
    assert.ok(w.barriers.some((b) => b.room.id === w.startZone.id),
      `seed ${seed}: the start room has no window to come in through`);

    let checked = 0;
    for (let i = 0; i < 40; i++) {
      const e = { half: 0.31, type: { height: 1.8 } };
      const spot = s._enemySpawnSpot(p, e);
      assert.ok(spot, `seed ${seed}: nowhere at all to spawn`);
      checked++;

      assert.ok(outsideComplex(w, spot.x, spot.z),
        `seed ${seed}: spawned at ${spot.x.toFixed(1)},${spot.z.toFixed(1)} which is inside the walls`);
      assert.ok(s.nav.reachable(spot.x, spot.z, spot.y),
        `seed ${seed}: spawned somewhere with no route to the player`);
      assert.ok(Math.hypot(spot.x - p.pos.x, spot.z - p.pos.z) > 8,
        `seed ${seed}: spawned on top of the player`);
      assert.equal(w.blocksAt(spot.x, spot.y, spot.z, 0.5, 1.8), false,
        `seed ${seed}: spawned inside something solid`);
    }
    assert.ok(checked === 40);
  }
});

test('a rescued enemy lands somewhere it can reach the player from', () => {
  const { s, p } = scene(20260725);
  const e = s.spawnEnemy('brute');
  for (let i = 0; i < 30; i++) {
    const spot = s._rescueSpot(e, p);
    assert.ok(spot, 'the rescue had nowhere to put it');
    assert.ok(s.nav.reachable(spot.x, spot.z, spot.y),
      'rescued to a spot with no route -- exactly the bug the rescue exists to fix');
    assert.equal(s.world.blocksAt(spot.x, spot.y, spot.z, e.half, e.type.height), false,
      'rescued into solid geometry');
  }
});

test('a zombie spawned outside tears the boards off and gets to the player', () => {
  const { w, s, p } = scene(20260725);
  const e = s.spawnEnemy('grunt');
  assert.ok(outsideComplex(w, e.pos.x, e.pos.z), 'did not start outside');
  assert.ok(e.breach, 'was not given a window to come in through');

  const boardsBefore = e.breach.boards.length;
  assert.ok(boardsBefore > 0, 'was sent at a window with nothing left to break');

  let closest = Infinity;
  for (let i = 0; i < 60 * 40 && closest > 3; i++) {
    s.tick(1 / 60);
    closest = Math.min(closest, Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z));
  }
  assert.ok(closest <= 3, `never arrived; got within ${closest.toFixed(1)}m`);
  assert.ok(w.barriers.some((b) => b.broken.length > 0), 'got in without breaking a single board');
});

test('an opened window is crossed as a visible vault, not a teleport', () => {
  const { w, s } = scene(20260725);
  const b = w.barriers.find((x) => x.room.id === w.startZone.id);
  assert.ok(b, 'the start room has no barrier to vault');
  while (!b.open) w.breakBoard(b, BOARD_TIME);

  s._refreshBarrierRoutes();
  const route = s._barrierRoute(b);
  assert.ok(route, 'the opened barrier has no route');

  const e = s.spawnEnemy('grunt');
  e.relocate(route.out.x, route.out.y, route.out.z);
  e.breach = b;
  const landing = s._landingFor(b, e);
  assert.ok(landing, 'there is nowhere legal to land');

  s.tick(1 / 60);
  assert.ok(e.vault, 'the body teleported instead of beginning a vault');
  assert.ok(Math.hypot(e.pos.x - landing.x, e.pos.z - landing.z) > 1,
    'the first vault tick already landed on the far side');

  let peak = e.pos.y;
  for (let i = 0; i < 90 && e.vault; i++) {
    s.tick(1 / 60);
    peak = Math.max(peak, e.pos.y);
  }
  assert.equal(e.vault, null, 'the vault never completed');
  assert.ok(peak > route.y + 1, `feet only cleared ${(peak - route.y).toFixed(2)}m of the sill`);
  assert.ok(e.pos.x > b.room.minX && e.pos.x < b.room.maxX
    && e.pos.z > b.room.minZ && e.pos.z < b.room.maxZ,
  'the vault did not finish inside the room');
});

test('a local session retains retired corpses until the renderer reclaims them', () => {
  const w = new World(20260725);
  for (const _ of w.generate()) { /* run to completion */ }
  const session = new LocalSession(w, 20260725);
  const e = session.sim.spawnEnemy('grunt');
  e.alive = false;
  e.deathTimer = -0.59;

  session.tick(0.02);
  assert.equal(session.enemies.includes(e), false, 'the sim did not retire the corpse');
  assert.deepEqual(session.removed, [e], 'the retired mesh owner was lost');

  // Fixed update may run more than once before one rendered frame. The queue
  // must survive those extra ticks or low frame rates leak corpses again.
  session.tick(0.02);
  assert.deepEqual(session.removed, [e], 'a later fixed tick erased the cleanup queue');

  session.reset();
  assert.equal(session.removed.length, 0);
  assert.ok(session.waveBreak > 2, 'restart skipped the full opening countdown');
});

// ------------------------------------------------------------------- barriers

test('a barrier reports being worked only on the ticks it is being worked', () => {
  const { w, s } = scene(20260725);
  const b = w.barriers.find((x) => x.boards.length > 0);

  b.working = true;                 // as if a zombie had been at it last tick
  s.tick(1 / 60);
  // Nothing is standing at it -- the first wave has not even started -- so the
  // renderer must be told it has stopped rather than left shaking forever.
  assert.equal(b.working, false, 'working stayed set with nobody working it');

  // And the board in progress is the one a renderer should be shaking.
  const front = b.boards[0];
  w.breakBoard(b, 0.1);
  assert.equal(b.working, true, 'working was not set by a zombie prising at it');
  assert.ok(b.progress > 0 && b.progress < 1, 'progress is not readable mid-board');
  assert.equal(b.boards[0], front, 'the board in progress changed without coming off');
});

// -------------------------------------------------------------------- stairs

test('the nav grid has a layer per storey and links them at the stairs', () => {
  const { w, s } = scene(20260725);
  const tallest = Math.max(...w.plan.rooms.map((r) => r.storeys ?? 1));
  assert.ok(tallest > 1, 'this seed has no upper floors to navigate');
  assert.equal(s.nav.levels, tallest, 'the grid does not cover every storey');
  assert.ok(s.nav.flights.length > 0, 'no stair flight was found to link the layers');

  for (const f of s.nav.flights) {
    assert.ok(f.to > f.from, 'a flight that does not gain a storey is not a flight');
    assert.ok(Math.abs(f.head.y - f.foot.y) > FLOOR_H - 0.5,
      'the two ends of a flight are on the same floor');
  }
});

test('a zombie downstairs is steered onto the flight when the player is above', () => {
  const { w, s, p } = scene(20260725);
  // It has to be a flight in a room the player has actually opened. Standing
  // them in a locked room is a state the game cannot reach, and a horde with
  // no route to it is the correct answer to it.
  const flight = s.nav.flights.find((f) => f.from === 0 && f.room === w.startZone.id);
  assert.ok(flight, 'the start room has no staircase to test with');
  const room = w.plan.rooms.find((r) => r.id === flight.room);

  // Player at the top of the flight; the horde is on the floor below.
  p.pos.x = flight.head.x; p.pos.y = flight.head.y; p.pos.z = flight.head.z;
  s._sweep(p);

  // Start well away from the treads, on the ground floor of the same room.
  let cur = { x: room.cx, z: room.cz, y: room.floorY };
  assert.ok(s.nav.reachable(cur.x, cur.z, cur.y),
    'the ground floor has no route to a player standing upstairs');

  let tookTheStairs = false;
  for (let i = 0; i < w.size * 2 && !tookTheStairs; i++) {
    const step = s.nav.stepFrom(cur.x, cur.z, cur.y);
    assert.ok(step, `the field ran out ${i} steps from the flight`);
    if (step.flight) { tookTheStairs = true; break; }
    cur = { x: step.x, z: step.z, y: step.y };
  }
  assert.ok(tookTheStairs, 'the field led nowhere near a staircase');

  // And the enemy actually walks up it: risers are inside the step-up it takes
  // in stride, so all it needs is to be aimed along the flight.
  const e = s.spawnEnemy('grunt');
  e.relocate(room.cx, room.floorY, room.cz);
  let top = e.pos.y;
  for (let i = 0; i < 60 * 120; i++) {
    s.tick(1 / 60);
    top = Math.max(top, e.pos.y);
    if (top > room.floorY + FLOOR_H - 0.8) break;
  }
  assert.ok(top > room.floorY + FLOOR_H - 0.8,
    `climbed only ${(top - room.floorY).toFixed(2)}m of a ${FLOOR_H}m storey`);
});

// ---------------------------------------------------------------------- size

test('every enemy fits through a doorway and under a ceiling', () => {
  // The clear height under a storey: the slab above hangs below the nominal
  // level, so a room is shorter inside than the storey pitch suggests.
  const ceiling = FLOOR_H - SLAB_T;

  for (const t of Object.values(ENEMY_TYPES)) {
    assert.ok(t.width < DOOR_W, `${t.label} is ${t.width} wide and the door is ${DOOR_W}`);
    assert.ok(t.height < DOOR_H, `${t.label} is ${t.height} tall and the door is ${DOOR_H}`);
    assert.ok(t.height < ceiling, `${t.label} is ${t.height} tall under a ${ceiling} ceiling`);
  }
});

test('the abomination fits, and is still the biggest thing on the map', () => {
  const boss = ENEMY_TYPES.boss;
  // Written against the numbers rather than the constants as well, so that
  // shrinking a doorway to fit the boss reads as the mistake it would be.
  assert.ok(boss.width <= 2.8, `boss is ${boss.width} wide; a doorway is 2.8`);
  assert.ok(boss.height <= 3.0, `boss is ${boss.height} tall; a doorway is 3.0 at most`);
  assert.ok(boss.height <= 3.4, `boss is ${boss.height} tall; a storey is 3.4`);

  for (const t of Object.values(ENEMY_TYPES)) {
    if (t === boss) continue;
    assert.ok(boss.height > t.height, `${t.label} is as tall as the boss`);
    assert.ok(boss.width >= t.width, `${t.label} is as wide as the boss`);
  }
  assert.ok(ENEMY_TYPES.brute.height < boss.height, 'the brute outgrew the boss');
});

// -------------------------------------------------------------------- the field

test('the field reaches the ground outside the walls, not just the floorplan', () => {
  const { w, s, p } = scene(20260725);
  // Every window that opens into a room the player can be reached from is a
  // seeded front, so the ground in front of it is navigable.
  const usable = w.barriers.filter((b) => s._barrierRoute(b));
  assert.ok(usable.length > 0, 'no window was treated as a way in');

  let reached = 0;
  for (const b of usable) {
    const r = s._barrierRoute(b);
    if (s.nav.reachable(r.out.x, r.out.z, r.out.y)) reached++;
  }
  assert.ok(reached > 0, 'the sweep never left the building');

  // And the inside of the complex is not on the outside field: the two are
  // distinguishable, which is what lets an enemy know it needs a window.
  assert.equal(s.nav.outside(p.pos.x, p.pos.z, p.pos.y), false,
    'the player reads as being outside the building');
});

test('a fresh grid is cheap enough to rebuild when the geometry moves', () => {
  const w = new World(20260725);
  for (const _ of w.generate()) { /* run to completion */ }
  const nav = new NavGrid(w);

  // A board coming off changes a couple of square metres, and during a breach
  // that happens several times a second. It must not cost a whole-map rebuild.
  const b = w.barriers[0];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) nav.rebuildAt(b.x - 2.5, b.z - 2.5, b.x + 2.5, b.z + 2.5);
  const patch = Number(process.hrtime.bigint() - t0) / 20 / 1e6;

  const t1 = process.hrtime.bigint();
  nav.rebuild();
  const full = Number(process.hrtime.bigint() - t1) / 1e6;

  assert.ok(patch * 8 < full,
    `patching costs ${patch.toFixed(2)}ms against ${full.toFixed(2)}ms for the lot`);
});

// -------------------------------------------------------------- the boss

test('the abomination calls in help three times, one per quarter of health', () => {
  const world = {
    supportHeight: () => 0, heightAt: () => 0, resolveProps: () => false,
    inBounds: () => true, isWalkable: () => true, blocksAt: () => false,
    lineOfSight: () => false, raycast: () => ({ hit: false, distance: 99 }),
  };
  const player = {
    pos: { x: 40, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    alive: true, half: 0.32, height: 1.8, damage() {}, applyPoison() {},
  };

  // Chipped down: one group of three at each quarter mark, and no more.
  const e = new Enemy('boss', world);
  e.spawn(0, 0, 0);
  const marks = [];
  e.onSummon = (self, n) => marks.push({ at: self.health / self.maxHealth, n });
  for (let i = 0; i < 600 && e.alive; i++) {
    e.damage(e.maxHealth * 0.01, null);
    e.update(1 / 60, player);
  }
  assert.equal(marks.length, 3, `summoned ${marks.length} times over a whole fight`);
  for (const m of marks) assert.equal(m.n, 3, 'a summon should bring three');
  for (const [i, want] of [0.75, 0.5, 0.25].entries()) {
    assert.ok(Math.abs(marks[i].at - want) < 0.06,
      `summon ${i + 1} fired at ${(marks[i].at * 100).toFixed(0)}% rather than ${want * 100}%`);
  }

  // A single hit big enough to cross two thresholds still calls in one group,
  // rather than emptying the rest of the fight's adds into the room at once.
  const e2 = new Enemy('boss', world);
  e2.spawn(0, 0, 0);
  let bursts = 0;
  e2.onSummon = () => bursts++;
  e2.damage(e2.maxHealth * 2.0, null);
  e2.update(1 / 60, player);
  assert.equal(bursts, 1, 'one hit should never fire two summons');
});

test('the flamethrower is a drop and only a drop', () => {
  const f = WEAPONS.find((w) => w.id === 'flamethrower');
  assert.ok(f, 'no flamethrower in the arsenal');
  // Not in the box, not in the armoury: a body is the only source.
  assert.equal(f.dropOnly, true, 'the flamethrower should not be buyable');
  assert.ok(f.range <= 15, `a ${f.range}m flamethrower is a rifle`);
  // It has to lose its bite at range, or it is simply the best gun in the game.
  assert.ok(f.falloffMin <= 0.2 && f.falloffEnd <= f.range,
    'the flame should die at the end of its reach');
  assert.ok(f.spreadBase > 4 * (Math.PI / 180), 'a flamethrower throws a cone, not a group');
  // And every gun needs a key, or it cannot be drawn once it is picked up.
  // Slots are claimed on pickup now, so the check is that finding it puts it
  // on a key that exists -- not that it owns one before anyone has seen it.
  const ws = new WeaponSystem(null);
  ws.pickUp('flamethrower');
  const slot = ws.weapons.find((w) => w.def.id === 'flamethrower').slot;
  assert.ok(slot >= 1, 'picking the flamethrower up gave it no key');
  assert.ok(ACTIONS.some((b) => b.id === `slot${slot}`),
    `slot ${slot} has no binding`);
});
