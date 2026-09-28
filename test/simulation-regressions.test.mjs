// Cross-cutting simulation lifecycle regressions.
//
// These use a deliberately tiny world because the rules under test are player
// state transitions, not terrain generation. Keeping terrain out makes the
// edge cases explicit and the suite fast.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GameSim, REVIVE_TIME, EV,
} from '../src/sim/gamesim.js';
import { MODE } from '../src/net/protocol.js';
import { VENDING_SHAKE_SECONDS } from '../src/world/drummertower.js';
import { Player } from '../src/entities/player.js';
import { Enemy } from '../src/entities/enemy.js';

function tinyWorld() {
  return {
    size: 128,
    props: [],
    barriers: [],
    spawns: [
      { x: 10, y: 0, z: 10 },
      { x: 110, y: 0, z: 110 },
    ],
    findSpawn() { return { x: 64, y: 0, z: 64 }; },
    heightAt() { return 0; },
    supportHeight() { return 0; },
    inBounds() { return true; },
  };
}

test('a last-moment co-op revive leaves one living player and one verdict', () => {
  const sim = new GameSim(1, { world: tinyWorld() });
  const downed = sim.addPlayer(1, 'DOWNED');
  const rescuer = sim.addPlayer(2, 'RESCUER');
  downed.pos = { x: 10, y: 0, z: 10 };
  rescuer.pos = { x: 11, y: 0, z: 10 };

  sim.downPlayer(downed.id);
  // This is the normal network sequence: the owning client reaches zero and
  // reports its local body dead while the shared sim represents it as downed.
  downed.alive = false;
  downed.bleed = REVIVE_TIME;
  sim._updateDowned(REVIVE_TIME);

  assert.equal(downed.down, false);
  assert.equal(downed.alive, true, 'the sim revived health but retained the dead flag');
  assert.equal(downed.health, 50);
  assert.equal(downed.bleed, 0);
  assert.deepEqual(sim._events.map((event) => event.type), [EV.PLAYER_DOWNED, EV.PLAYER_REVIVED],
    'one tick issued contradictory revived/dead verdicts');
});

test('a wave respawn anchors beside a survivor, never its own corpse', () => {
  const sim = new GameSim(2, { world: tinyWorld() });
  const dead = sim.addPlayer(1, 'FIRST-IN-MAP');
  const survivor = sim.addPlayer(2, 'SURVIVOR');
  dead.alive = false;
  dead.pos = { x: 20, y: 0, z: 20 };
  survivor.pos = { x: 90, y: 0, z: 90 };

  let anchor = null;
  sim._findSpawnSpot = (_min, _max, chosen) => {
    anchor = chosen;
    return { x: chosen.pos.x + 1, y: chosen.pos.y, z: chosen.pos.z };
  };
  sim.respawnPlayer(dead.id);

  assert.equal(anchor, survivor);
  assert.deepEqual(dead.pos, { x: 91, y: 0, z: 90 });
});

test('a fresh run restores participant life state', () => {
  const sim = new GameSim(3, { world: tinyWorld() });
  const player = sim.addPlayer(1, 'PLAYER');
  player.alive = false;
  player.down = true;
  player.health = 0;
  player.reviverId = 99;

  sim.resetRun();

  assert.equal(player.alive, true);
  assert.equal(player.down, false);
  assert.equal(player.health, player.maxHealth);
  assert.equal(player.reviverId, null);
});

test('the rooftop vending event is authoritative, range checked, and one shot', () => {
  const world = tinyWorld();
  let destroyed = 0;
  world.drummerTower = {
    bananaVending: { x: 20, y: 8, z: 30 },
  };
  world.destroyBananaVendingMachine = () => { destroyed++; return true; };
  const sim = new GameSim(31, { world });
  const first = sim.addPlayer(1, 'FIRST');
  const second = sim.addPlayer(2, 'SECOND');

  first.pos = { x: 50, y: 8, z: 30 };
  assert.equal(sim.activateBananaVending(first.id), false, 'a remote request bypassed range validation');
  first.pos = { x: 20, y: 8, z: 31.4 };
  second.pos = { x: 20, y: 8, z: 31.2 };
  assert.equal(sim.activateBananaVending(first.id), true);
  assert.equal(sim.activateBananaVending(second.id), false,
    'simultaneous co-op requests created a second event');
  assert.deepEqual(sim.drainEvents(), [{
    type: EV.BANANA_VENDING, by: 1, x: 20, y: 9.05, z: 30,
  }]);
  assert.equal(sim.snapshot().vending, 0, 'late joiners cannot discover the triggered machine');

  sim.running = true;
  sim.tick(VENDING_SHAKE_SECONDS + 0.01);
  assert.equal(destroyed, 1, 'the authoritative collider survived the visual explosion');
  sim.tick(1);
  assert.equal(destroyed, 1, 'the collider was destroyed more than once');
});

test('a new FFA round clears the previous round economy and timer', () => {
  const sim = new GameSim(4, { world: tinyWorld(), mode: MODE.FFA });
  const a = sim.addPlayer(1, 'ALPHA');
  const b = sim.addPlayer(2, 'BRAVO');
  a.coins = 900;
  b.coins = 400;
  a.kills = 20;
  sim.winnerId = a.id;
  sim.postMatch = 0.01;

  sim._updateFFA(0.02);

  assert.equal(sim.winnerId, null);
  assert.equal(sim.postMatch, 0);
  assert.equal(a.coins, 0);
  assert.equal(b.coins, 0);
  assert.equal(a.kills, 0);
  assert.equal(sim._events.at(-1)?.type, EV.MATCH_RESET);
});

test('invalid damage cannot heal, corrupt health, or award a frag', () => {
  const world = tinyWorld();
  const player = new Player(world);
  player.health = 60;
  player.damage(-20);
  player.damage(Number.NaN);
  assert.equal(player.health, 60);
  player.heal(Number.NaN);
  player.applyPoison(Number.POSITIVE_INFINITY, 5);
  assert.equal(player.health, 60);
  assert.equal(player.poison, null);

  const enemy = new Enemy('grunt', world);
  const enemyHealth = enemy.health;
  assert.equal(enemy.damage(-10), false);
  assert.equal(enemy.damage(Number.NaN), false);
  assert.equal(enemy.health, enemyHealth);

  const duel = new GameSim(5, { world, mode: MODE.FFA });
  const shooter = duel.addPlayer(1, 'SHOOTER');
  const target = duel.addPlayer(2, 'TARGET');
  assert.equal(duel.hitPlayer(shooter.id, target.id, Number.NaN), false);
  assert.equal(target.health, target.maxHealth);
  assert.equal(shooter.kills, 0);

  shooter.alive = false;
  assert.equal(duel.hitPlayer(shooter.id, target.id, 100), false,
    'a dead player was still allowed to deal a hitscan hit');
  assert.equal(target.alive, true);
});

test('respawning clears poison left over from the previous life', () => {
  const player = new Player(tinyWorld());
  player.applyPoison(30, 10);
  assert.ok(player.poison);
  player.damage(1_000, 'enemy');
  assert.equal(player.alive, false);

  player.spawn({ x: 4, y: 0, z: 7 });

  assert.equal(player.alive, true);
  assert.equal(player.health, player.maxHealth);
  assert.equal(player.poison, null);
});
