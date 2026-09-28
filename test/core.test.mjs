// Headless tests for the simulation core.
//
// Everything under test here is renderer-free by design -- world, raycast,
// combat, weapons and player physics import no Three.js -- so the rules of the
// game can be verified without a browser.
//
//   node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';

import { rayAABB } from '../src/world/raycast.js';
import { traceShot, resolveFire, HIT_ENEMY, HIT_WORLD, HIT_NONE } from '../src/combat/combat.js';
import {
  WeaponSystem, WEAPONS, SLOT_COUNT, spreadDirection, damageAtRange,
} from '../src/combat/weapons.js';
import { World } from '../src/world/world.js';
import { Player } from '../src/entities/player.js';
import { key as boundKey, ACTIONS } from '../src/engine/bindings.js';
import { ENEMY_TYPES } from '../src/entities/enemy.js';
import { PotionEffects, POTIONS, POTION_BY_ID } from '../src/entities/potion.js';
import { Chest, CHEST_LOOT, MIN_SPAWN_DIST, rollChestLoot, placeChests } from '../src/entities/chest.js';

// ---------------------------------------------------------------- test doubles

/**
 * Minimal world implementing just the raycast() contract combat.js needs:
 * empty space, optionally with a vertical wall plane at a given x.
 */
function emptyWorld({ wallX = null, range = 1e9 } = {}) {
  return {
    wallX,
    raycast(ox, oy, oz, dx, dy, dz, maxDist) {
      const miss = {
        hit: false, distance: maxDist,
        x: ox + dx * maxDist, y: oy + dy * maxDist, z: oz + dz * maxDist,
        nx: 0, ny: 1, nz: 0, prop: null,
      };
      if (this.wallX === null || Math.abs(dx) < 1e-9) return miss;
      const t = (this.wallX - ox) / dx;
      if (t < 0 || t > maxDist) return miss;
      return {
        hit: true, distance: t,
        x: ox + dx * t, y: oy + dy * t, z: oz + dz * t,
        nx: -Math.sign(dx), ny: 0, nz: 0, prop: null,
      };
    },
  };
}
/** Enemy stand-in exposing exactly what combat.js consumes. */
function fakeEnemy(x, y, z, { width = 0.62, height = 1.8, health = 100 } = {}) {
  return {
    alive: true,
    health,
    pos: { x, y, z },
    type: { width, height, bodyColor: 0, label: 'TEST' },
    _headH() { return height * 0.28; },
    bodyBox() {
      const h = width / 2, hh = this._headH();
      return { minX: x - h, maxX: x + h, minY: y, maxY: y + height - hh, minZ: z - h, maxZ: z + h };
    },
    headBox() {
      const hw = width * 0.31, hh = this._headH();
      return { minX: x - hw, maxX: x + hw, minY: y + height - hh, maxY: y + height, minZ: z - hw, maxZ: z + hw };
    },
    damage(amount) {
      this.health -= amount;
      if (this.health <= 0) { this.health = 0; this.alive = false; return true; }
      return false;
    },
  };
}

const RIFLE = WEAPONS.find((w) => w.id === 'rifle');
const SHOTGUN = WEAPONS.find((w) => w.id === 'shotgun');
const SNIPER = WEAPONS.find((w) => w.id === 'sniper');

// -------------------------------------------------------------------- raycast

test('ray-AABB returns the entry distance and rejects misses', () => {
  assert.ok(Math.abs(rayAABB(0, 0, 0, 1, 0, 0, 5, -1, -1, 6, 1, 1) - 5) < 1e-9);
  assert.equal(rayAABB(0, 0, 0, 1, 0, 0, 5, 10, 10, 6, 11, 11), -1);
  assert.equal(rayAABB(0, 0, 0, -1, 0, 0, 5, -1, -1, 6, 1, 1), -1, 'box behind the ray');
  assert.equal(rayAABB(5.5, 0, 0, 1, 0, 0, 5, -1, -1, 6, 1, 1), 0, 'origin inside the box');
});

// ------------------------------------------------------------ hit registration

test('a clean shot at an enemy body registers', () => {
  const w = emptyWorld();
  const e = fakeEnemy(20, 0, 5);
  const tr = traceShot(w, [e], 5, 0.9, 5, 1, 0, 0, RIFLE);
  assert.equal(tr.kind, HIT_ENEMY);
  assert.equal(tr.headshot, false);
  assert.equal(tr.enemy, e);
});

test('a shot at the head registers as a headshot with the multiplier applied', () => {
  const w = emptyWorld();
  const e = fakeEnemy(20, 0, 5);
  // 1.8 tall, head occupies the top 28% -> above y = 1.296
  const tr = traceShot(w, [e], 5, 1.7, 5, 1, 0, 0, RIFLE);
  assert.equal(tr.kind, HIT_ENEMY);
  assert.equal(tr.headshot, true);
  assert.ok(tr.damage > RIFLE.damage, 'headshot should out-damage a body shot');
  assert.ok(Math.abs(tr.damage - RIFLE.damage * RIFLE.headshotMultiplier) < 1e-6);
});

test('a wall between shooter and enemy blocks the shot', () => {
  const w = emptyWorld({ wallX: 12 });
  const e = fakeEnemy(20, 0, 5);
  const tr = traceShot(w, [e], 5, 0.9, 5, 1, 0, 0, RIFLE);
  assert.equal(tr.kind, HIT_WORLD, 'shot must stop at the wall, not reach the enemy');
  assert.equal(e.health, 100);
});

test('an enemy in front of a wall is still hit', () => {
  const w = emptyWorld({ wallX: 30 });
  const e = fakeEnemy(20, 0, 5);
  const tr = traceShot(w, [e], 5, 0.9, 5, 1, 0, 0, RIFLE);
  assert.equal(tr.kind, HIT_ENEMY);
});

test('the nearest of two stacked enemies takes the hit', () => {
  const w = emptyWorld();
  const near = fakeEnemy(15, 0, 5);
  const far = fakeEnemy(25, 0, 5);
  const tr = traceShot(w, [near, far], 5, 0.9, 5, 1, 0, 0, RIFLE);
  assert.equal(tr.enemy, near);
  // Order in the array must not matter.
  assert.equal(traceShot(w, [far, near], 5, 0.9, 5, 1, 0, 0, RIFLE).enemy, near);
});

// ------------------------------------------------------------- penetration

test('a non-piercing weapon stops at the first body', () => {
  const w = emptyWorld();
  const near = fakeEnemy(15, 0, 5);
  const far = fakeEnemy(25, 0, 5);
  const tr = traceShot(w, [near, far], 5, 0.9, 5, 1, 0, 0, RIFLE);
  assert.equal(tr.enemy, near);
  assert.deepEqual(tr.through, [], 'no pierce -> no collateral');
});

test('a sniper round carries through bodies, nearest first', () => {
  const w = emptyWorld();
  const a = fakeEnemy(15, 0, 5);
  const b = fakeEnemy(25, 0, 5);
  const c = fakeEnemy(35, 0, 5);
  // Deliberately out of depth order: the trace must sort, not trust the array.
  const tr = traceShot(w, [c, a, b], 5, 0.9, 5, 1, 0, 0, SNIPER);
  assert.equal(tr.enemy, a);
  assert.deepEqual(tr.through.map((h) => h.enemy), [b, c]);
  // Each body costs the round a fixed fraction of what it had left.
  assert.ok(tr.through[0].damage < tr.damage);
  assert.ok(tr.through[1].damage < tr.through[0].damage);
  assert.ok(Math.abs(tr.through[1].damage / tr.through[0].damage
    - SNIPER.pierceFalloff) < 1e-6);
});

test('pierce is a budget: a fourth body in the line takes nothing', () => {
  const w = emptyWorld();
  const line = [15, 25, 35, 45].map((x) => fakeEnemy(x, 0, 5));
  const tr = traceShot(w, line, 5, 0.9, 5, 1, 0, 0, SNIPER);
  assert.equal(tr.through.length, SNIPER.pierce);
  assert.ok(!tr.through.some((h) => h.enemy === line[3]));
});

test('a wall stops a piercing round even when bodies remain behind it', () => {
  const w = emptyWorld({ wallX: 20 });
  const near = fakeEnemy(15, 0, 5);
  const behind = fakeEnemy(30, 0, 5);
  const tr = traceShot(w, [near, behind], 5, 0.9, 5, 1, 0, 0, SNIPER);
  assert.equal(tr.enemy, near);
  assert.deepEqual(tr.through, [], 'geometry still stops everything');
  assert.equal(behind.health, 100);
});

test('a spent piercing round ends in the last body, an unspent one at the wall', () => {
  const w = emptyWorld({ wallX: 100 });
  const spent = [15, 25, 35].map((x) => fakeEnemy(x, 0, 5));
  // Three bodies exactly exhausts pierce, so the tracer dies in the last one.
  const trSpent = traceShot(w, spent, 5, 0.9, 5, 1, 0, 0, SNIPER);
  assert.ok(Math.abs(trSpent.end.x - trSpent.through[1].point.x) < 1e-9);

  // One body leaves pierce to spare, so the round runs on to the wall.
  const trOver = traceShot(w, [fakeEnemy(15, 0, 5)], 5, 0.9, 5, 1, 0, 0, SNIPER);
  assert.ok(Math.abs(trOver.end.x - 100) < 1e-9);
});

test('collateral is applied, not just reported', () => {
  const w = emptyWorld();
  const a = fakeEnemy(15, 0, 5, { health: 1000 });
  const b = fakeEnemy(25, 0, 5, { health: 1000 });
  const res = resolveFire(w, [a, b], { x: 5, y: 0.9, z: 5 },
    [{ x: 1, y: 0, z: 0 }], SNIPER);
  assert.equal(res.hits.length, 2, 'both bodies get a hit record');
  assert.ok(a.health < 1000 && b.health < 1000);
  assert.ok(1000 - b.health < 1000 - a.health, 'the second body takes less');
  assert.ok(Math.abs(res.totalDamage - ((1000 - a.health) + (1000 - b.health))) < 1e-6);
});

test('one sniper round through a queue can multi-kill', () => {
  const w = emptyWorld();
  const line = [15, 25, 35].map((x) => fakeEnemy(x, 0, 5, { health: 20 }));
  const res = resolveFire(w, line, { x: 5, y: 0.9, z: 5 },
    [{ x: 1, y: 0, z: 0 }], SNIPER);
  assert.equal(res.kills.length, 3);
  assert.ok(line.every((e) => !e.alive));
});

test('dead enemies are not hittable', () => {
  const w = emptyWorld();
  const e = fakeEnemy(20, 0, 5);
  e.alive = false;
  // Nothing else is out there, so the shot simply finds no target.
  const tr = traceShot(w, [e], 5, 0.9, 5, 1, 0, 0, RIFLE);
  assert.equal(tr.kind, HIT_NONE);
  assert.equal(e.health, 100);
});

test('shots beyond weapon range do not register', () => {
  const w = emptyWorld();
  const e = fakeEnemy(200, 0, 5);
  const tr = traceShot(w, [e], 5, 0.9, 5, 1, 0, 0, SHOTGUN); // 45m range
  assert.equal(tr.kind, HIT_NONE);
});

test('a shotgun blast aggregates pellet damage into one hit record', () => {
  const w = emptyWorld();
  const e = fakeEnemy(10, 0, 5, { health: 1000 });
  const shots = Array.from({ length: SHOTGUN.pellets }, () => ({ x: 1, y: 0, z: 0 }));
  const res = resolveFire(w, [e], { x: 5, y: 0.9, z: 5 }, shots, SHOTGUN);
  assert.equal(res.hits.length, 1, 'one enemy -> one hit record');
  assert.equal(res.hits[0].pellets, SHOTGUN.pellets);
  assert.ok(res.totalDamage > SHOTGUN.damage * 8);
  assert.equal(e.health, 1000 - res.totalDamage);
});

test('lethal damage marks a kill exactly once', () => {
  const w = emptyWorld();
  const e = fakeEnemy(10, 0, 5, { health: 20 });
  const shots = Array.from({ length: 9 }, () => ({ x: 1, y: 0, z: 0 }));
  const res = resolveFire(w, [e], { x: 5, y: 0.9, z: 5 }, shots, SHOTGUN);
  assert.equal(res.kills.length, 1);
  assert.equal(e.alive, false);
});

test('damage falls off with distance and never below the floor', () => {
  assert.equal(damageAtRange(RIFLE, 10), RIFLE.damage);
  const mid = damageAtRange(RIFLE, (RIFLE.falloffStart + RIFLE.falloffEnd) / 2);
  assert.ok(mid < RIFLE.damage && mid > RIFLE.damage * RIFLE.falloffMin);
  assert.ok(Math.abs(damageAtRange(RIFLE, 1000) - RIFLE.damage * RIFLE.falloffMin) < 1e-9);
});

// --------------------------------------------------------------------- spread

test('spread keeps shots inside the cone and returns unit vectors', () => {
  const dir = { x: 0, y: 0, z: -1 };
  const cone = 5 * Math.PI / 180;
  for (let i = 0; i < 2000; i++) {
    const s = spreadDirection(dir, cone);
    assert.ok(Math.abs(Math.hypot(s.x, s.y, s.z) - 1) < 1e-9, 'not normalised');
    const dot = s.x * dir.x + s.y * dir.y + s.z * dir.z;
    assert.ok(dot >= Math.cos(cone) - 1e-9, 'shot left the cone');
  }
});

test('zero spread returns the exact aim direction', () => {
  const s = spreadDirection({ x: 0, y: 0, z: -1 }, 0);
  assert.deepEqual(s, { x: 0, y: 0, z: -1 });
});

// -------------------------------------------------------------------- weapons

function fakePlayer() {
  return {
    vel: { x: 0, y: 0, z: 0 }, onGround: true, pitch: 0, yaw: 0,
    getLookDir: (o = {}) => { o.x = 0; o.y = 0; o.z = -1; return o; },
  };
}

/**
 * Put a weapon in the player's hands, loaded.
 *
 * Most of the arsenal is `unlockable` -- you start with a pistol and a pickaxe
 * and find the rest -- so a test cannot just point `index` at a weapon and fire:
 * an unowned instance is empty by construction. Granting first is what these
 * tests mean by "holding the rifle".
 *
 * @returns the index the system is now on
 */
function equip(ws, id) {
  const i = WEAPONS.findIndex((w) => w.id === id);
  assert.ok(i >= 0, `no such weapon: ${id}`);
  ws.pickUp(id);
  const w = ws.weapons[i];
  w.ammo = w.def.magSize;
  w.reserve = w.def.startReserve;
  ws.index = i;
  return i;
}

test('there are at least two distinct weapons with distinct behaviour', () => {
  assert.ok(WEAPONS.length >= 2);
  const ids = new Set(WEAPONS.map((w) => w.id));
  assert.equal(ids.size, WEAPONS.length);
  assert.ok(WEAPONS.some((w) => w.fireMode === 'auto'), 'need an automatic');
  assert.ok(WEAPONS.some((w) => w.pellets > 1), 'need a multi-pellet weapon');
});

test('automatic fire respects the configured rate of fire', () => {
  const ws = new WeaponSystem(null);
  equip(ws, 'rifle');
  const p = fakePlayer();
  const dt = 1 / 240;
  let shots = 0;
  for (let i = 0; i < 240; i++) {          // one second, held trigger
    if (ws.update(dt, p, true, i === 0)) shots++;
  }
  const expected = RIFLE.rpm / 60;         // ~11.67 shots/sec
  assert.ok(Math.abs(shots - expected) <= 1, `fired ${shots}, expected ~${expected.toFixed(1)}`);
});

test('semi-automatic fire needs a fresh click per shot', () => {
  const ws = new WeaponSystem(null);
  equip(ws, 'pistol');
  const p = fakePlayer();
  let shots = 0;
  // Clicked once on the first tick, then held down for a full second.
  for (let i = 0; i < 240; i++) {
    if (ws.update(1 / 240, p, true, i === 0)) shots++;
  }
  assert.equal(shots, 1, 'holding the trigger fired more than once');

  // A second click fires again.
  assert.ok(ws.update(1 / 240, p, true, true), 'a fresh click should fire');
});

test('firing consumes ammo and an empty magazine triggers a reload', () => {
  const ws = new WeaponSystem(null);
  equip(ws, 'rifle');
  const p = fakePlayer();
  const w = ws.current;
  const dt = 1 / 240;

  for (let i = 0; i < 2000 && w.ammo > 0; i++) ws.update(dt, p, true, i === 0);
  assert.equal(w.ammo, 0);

  ws.update(dt, p, true, true);
  assert.equal(ws.isReloading, true, 'empty gun should auto-reload');

  for (let i = 0; i < 2000 && ws.isReloading; i++) ws.update(dt, p, false, false);
  assert.equal(w.ammo, RIFLE.magSize);
  assert.equal(w.reserve, RIFLE.startReserve - RIFLE.magSize);
});

test('reserve ammo caps the reload when it runs low', () => {
  const ws = new WeaponSystem(null);
  equip(ws, 'rifle');
  const w = ws.current;
  w.ammo = 0;
  w.reserve = 7;
  ws.startReload();
  const p = fakePlayer();
  for (let i = 0; i < 2000 && ws.isReloading; i++) ws.update(1 / 240, p, false, false);
  assert.equal(w.ammo, 7);
  assert.equal(w.reserve, 0);
});

test('switching weapons takes time and lands on the requested weapon', () => {
  const ws = new WeaponSystem(null);
  const p = fakePlayer();
  const startIndex = ws.index;
  // You can only switch to a weapon you carry, so the shotgun has to be found
  // first -- switchTo refusing an unowned slot is itself the intended behaviour.
  ws.pickUp('shotgun');
  const target = WEAPONS.findIndex((w) => w.id === 'shotgun');

  assert.ok(ws.switchTo(target));
  assert.equal(ws.isSwitching, true);
  assert.equal(ws.update(1 / 240, p, true, true), null, 'cannot fire mid-switch');

  for (let i = 0; i < 2000 && ws.isSwitching; i++) ws.update(1 / 240, p, false, false);
  assert.equal(ws.index, target);
  assert.equal(ws.lastIndex, startIndex);
  assert.equal(ws.def.id, 'shotgun');

  ws.switchLast();
  for (let i = 0; i < 2000 && ws.isSwitching; i++) ws.update(1 / 240, p, false, false);
  assert.equal(ws.index, startIndex, 'Q should return to the previous weapon');
});

test('a shotgun trigger pull emits one direction per pellet', () => {
  const ws = new WeaponSystem(null);
  equip(ws, 'shotgun');
  const p = fakePlayer();
  const res = ws.update(1 / 240, p, true, true);
  assert.ok(res, 'shotgun did not fire');
  assert.equal(res.shots.length, SHOTGUN.pellets);
});

test('firing applies recoil to the player view', () => {
  const ws = new WeaponSystem(null);
  equip(ws, 'shotgun');
  const p = fakePlayer();
  ws.update(1 / 240, p, true, true);
  assert.ok(p.pitch > 0, 'recoil should raise the aim');
});

test('moving and jumping widen the cone', () => {
  const ws = new WeaponSystem(null);
  equip(ws, 'rifle');
  const still = fakePlayer();
  const moving = fakePlayer();
  moving.vel.x = 5.2;
  const airborne = fakePlayer();
  airborne.onGround = false;

  const a = ws.spread(still), b = ws.spread(moving), c = ws.spread(airborne);
  assert.ok(b > a, 'moving should be less accurate than standing');
  assert.ok(c > a, 'airborne should be less accurate than grounded');
});

// --------------------------------------------------------------- aim down sights

test('every gun offers sights, and HUD overlays are only for true optics', () => {
  // Melee never aims and the airstrike designator is not a gun, so neither owes
  // the HUD a sight picture. Everything else does.
  const guns = WEAPONS.filter((w) => !w.designator && !w.melee && !w.portal);
  const KINDS = ['iron', 'scope', 'bazooka', 'thermal'];
  for (const w of guns) {
    assert.equal(w.ads, true, `${w.id} has no sights`);
    assert.ok(KINDS.includes(w.adsSight), `${w.id} sight kind: ${w.adsSight}`);
    assert.ok(w.adsFov > 0 && w.adsFov < 78, `${w.id} should zoom in when aimed`);
    assert.ok(w.adsTime > 0 && w.adsTime <= 0.12, `${w.id} sights are slow to raise`);
  }
  // Melee is the other half of the contract: no sights at all, so the HUD has
  // nothing to draw and updateAds has nothing to ramp.
  for (const w of WEAPONS.filter((x) => x.melee)) {
    assert.equal(w.ads, false, `${w.id} should not aim`);
  }
  assert.equal(WEAPONS.find((w) => w.portal).ads, false,
    'secondary fire on the portal tool should place orange, not raise sights');

  // The bazooka gets its own launcher sight; the long guns get real optics.
  assert.equal(WEAPONS.find((w) => w.id === 'bazooka').adsSight, 'bazooka');
  assert.equal(WEAPONS.find((w) => w.id === 'sniper').adsSight, 'scope');
  assert.equal(WEAPONS.find((w) => w.id === 'railgun').adsSight, 'thermal');
  // Iron sights are the fallback, not a leftover: these are the weapons whose
  // own model carries the sight picture, including red dots and holographics.
  assert.deepEqual(
    WEAPONS.filter((w) => w.adsSight === 'iron').map((w) => w.id),
    ['pistol', 'deagle', 'smg', 'microsmg', 'laser', 'minigun', 'shotgun', 'flamethrower'],
  );
  assert.equal(WEAPONS.find((w) => w.id === 'rifle').adsSight, 'scope');
});

test('aiming tightens the cone and slows the look, and lowering restores both', () => {
  for (const id of ['pistol', 'rifle', 'shotgun', 'sniper', 'bazooka']) {
    const ws = new WeaponSystem(null);
    equip(ws, id);
    const p = fakePlayer();

    const hip = ws.spread(p);
    assert.equal(ws.lookScale, 1, `${id} hip fire should not scale the look`);

    // Ramp in. One adsTime worth of frames is enough to reach full aim.
    for (let i = 0; i < 40; i++) ws.updateAds(ws.def.adsTime / 20, true);
    assert.equal(ws.adsT, 1, `${id} never reached full aim`);
    assert.ok(ws.spread(p) < hip, `${id} aiming should tighten the cone`);
    assert.ok(ws.lookScale < 1, `${id} aiming should slow the look`);

    // ...and back out.
    for (let i = 0; i < 40; i++) ws.updateAds(ws.def.adsTime / 20, false);
    assert.equal(ws.adsT, 0, `${id} never lowered`);
    assert.equal(ws.lookScale, 1, `${id} look scale should reset`);
    assert.ok(Math.abs(ws.spread(p) - hip) < 1e-12, `${id} cone should reset`);
  }
});

test('the aim ramp takes its weapon\'s adsTime, independent of step size', () => {
  // The ramp is driven at display rate, so it has to reach the same place after
  // the same elapsed time whether that arrives in 60Hz or 240Hz slices.
  const at = (steps) => {
    const ws = new WeaponSystem(null);
    equip(ws, 'rifle');
    const dt = ws.def.adsTime / steps;
    for (let i = 0; i < steps; i++) ws.updateAds(dt, true);
    return ws.adsT;
  };
  assert.ok(Math.abs(at(4) - 1) < 1e-9, 'one adsTime should complete the ramp');
  assert.ok(Math.abs(at(16) - 1) < 1e-9, 'ramp should not depend on step count');

  // Half the time gets half way, so the FOV and overlay blends stay linear.
  const ws = new WeaponSystem(null);
  equip(ws, 'rifle');
  for (let i = 0; i < 8; i++) ws.updateAds(ws.def.adsTime / 16, true);
  assert.ok(Math.abs(ws.adsT - 0.5) < 1e-9, `half-way ramp was ${ws.adsT}`);
});

test('reloading and switching force the sights down', () => {
  const ws = new WeaponSystem(null);
  equip(ws, 'rifle');
  const p = fakePlayer();
  for (let i = 0; i < 40; i++) ws.updateAds(ws.def.adsTime / 20, true);
  assert.equal(ws.adsT, 1);

  ws.current.ammo = 1;
  assert.equal(ws.startReload(), true);
  ws.updateAds(1 / 240, true);
  assert.equal(ws.aiming, false, 'a reload should drop the aim');

  // Finish the reload, then confirm the sights come straight back up.
  for (let i = 0; i < 4000 && ws.isReloading; i++) ws.update(1 / 240, p, false, false);
  ws.updateAds(1 / 240, true);
  assert.equal(ws.aiming, true, 'aim should resume once the reload ends');

  ws.pickUp('shotgun');
  const shotgun = WEAPONS.findIndex((w) => w.id === 'shotgun');
  assert.equal(ws.switchTo(shotgun), true);
  ws.updateAds(1 / 240, true);
  assert.equal(ws.aiming, false, 'a weapon switch should drop the aim');
});

test('an aimed automatic still pays for spraying', () => {
  // adsBloom is what keeps the aimed rifle from being a strict upgrade: bloom
  // from held fire has to survive into the aimed cone.
  const ws = new WeaponSystem(null);
  equip(ws, 'rifle');
  const p = fakePlayer();
  for (let i = 0; i < 40; i++) ws.updateAds(ws.def.adsTime / 20, true);

  const first = ws.spread(p);
  for (let i = 0; i < 8; i++) {
    ws.cooldown = 0;
    ws.update(1 / 240, p, true, true);
  }
  assert.ok(ws.current.bloom > 0, 'held fire should still bloom while aimed');
  assert.ok(ws.spread(p) > first, 'aimed spray should open the cone');

  // The sniper is the exception -- a bolt action has no spray to punish.
  const sn = new WeaponSystem(null);
  equip(sn, 'sniper');
  for (let i = 0; i < 40; i++) sn.updateAds(sn.def.adsTime / 20, true);
  const before = sn.spread(p);
  sn.update(1 / 240, p, true, true);
  assert.ok(sn.current.bloom > 0, 'the sniper should still bloom for hip fire');
  assert.ok(Math.abs(sn.spread(p) - before) < 1e-12, 'scoped sniper ignores bloom');
});

/**
 * Minimal Input stand-in.
 *
 * `held` is a physical KeyboardEvent.code, because that is what these tests are
 * about -- "the key where W is moves you forward". actionDown resolves through
 * the real binding map rather than faking it, so a default-binding regression
 * would show up here too.
 */
const fakeInput = (held = null) => ({
  moveAxis: null,
  isDown: (c) => c === held,
  wasPressed: () => false,
  actionDown: (a) => !!held && boundKey(a) === held,
  actionPressed: () => false,
});

// -------------------------------------------------------------- world + physics

test('WASD moves the player in the direction they are facing', () => {
  const world = new World(31);
  for (const _ of world.generate()) { /* run to completion */ }

  // Fly the player so terrain cannot deflect the movement being measured.
  const run = (key, yaw) => {
    const p = new Player(world);
    p.spawn({ x: 80, y: 100, z: 80 });
    p.yaw = yaw;
    const input = fakeInput(key);
    for (let i = 0; i < 30; i++) {
      p.vel.y = 0;                 // cancel gravity; only horizontals matter
      p.update(1 / 60, input, true);
      p.pos.y = 100;
    }
    return { dx: p.pos.x - 80, dz: p.pos.z - 80 };
  };

  const fwd = (yaw) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

  for (const yaw of [0, Math.PI / 2, -Math.PI / 2, Math.PI, 0.7, -2.4]) {
    const f = fwd(yaw);
    const r = { x: Math.cos(yaw), z: -Math.sin(yaw) };

    const w = run('KeyW', yaw);
    const s = run('KeyS', yaw);
    const d = run('KeyD', yaw);
    const a = run('KeyA', yaw);

    // Project each result onto the expected axis; it must be clearly positive.
    assert.ok(w.dx * f.x + w.dz * f.z > 0.5, `W did not move forward at yaw ${yaw}`);
    assert.ok(s.dx * f.x + s.dz * f.z < -0.5, `S did not move backward at yaw ${yaw}`);
    assert.ok(d.dx * r.x + d.dz * r.z > 0.5, `D did not strafe right at yaw ${yaw}`);
    assert.ok(a.dx * r.x + a.dz * r.z < -0.5, `A did not strafe left at yaw ${yaw}`);

    // And W must not leak sideways.
    assert.ok(Math.abs(w.dx * r.x + w.dz * r.z) < 0.05, `W drifted sideways at yaw ${yaw}`);
  }
});

test('a player falls onto the ground and stops there', () => {
  const world = new World(12);
  for (const _ of world.generate()) { /* run to completion */ }
  const p = new Player(world);
  const spawn = world.findSpawn();
  p.spawn({ x: spawn.x, y: spawn.y + 2, z: spawn.z });

  const input = fakeInput();
  for (let i = 0; i < 400; i++) p.update(1 / 60, input, true);

  assert.equal(p.onGround, true, 'player never landed');
  assert.ok(Math.abs(p.vel.y) < 0.001);
  // Landed exactly on the surface, not sunk into it or hovering above it.
  assert.ok(Math.abs(p.pos.y - world.supportHeight(p.pos.x, p.pos.z, p.pos.y + 0.1, p.half)) < 0.01,
    'player did not settle on the ground');
});

test('player health clamps at zero and death fires once', () => {
  const world = new World(13);
  for (const _ of world.generate()) { /* run to completion */ }
  const p = new Player(world);
  p.spawn(world.findSpawn());

  let deaths = 0;
  p.onDeath = () => { deaths++; };
  p.damage(60);
  assert.equal(p.alive, true);
  p.damage(60);
  assert.equal(p.health, 0);
  assert.equal(p.alive, false);
  p.damage(60);
  assert.equal(deaths, 1, 'death should not re-fire on a corpse');
});

test('instant hazards bypass damage scaling and report their death source once', () => {
  const world = new World(1301);
  for (const _ of world.generate()) { /* run to completion */ }
  const p = new Player(world);
  p.spawn(world.findSpawn());
  p.damageScale = 0;

  const damageSources = [];
  const deathSources = [];
  p.onDamage = (_amount, source) => { damageSources.push(source); };
  p.onDeath = (source) => { deathSources.push(source); };

  assert.equal(p.kill('inevitable-snail'), true);
  assert.equal(p.health, 0);
  assert.equal(p.alive, false);
  assert.deepEqual(damageSources, ['inevitable-snail']);
  assert.deepEqual(deathSources, ['inevitable-snail']);
  assert.equal(p.kill('inevitable-snail'), false);
  assert.deepEqual(deathSources, ['inevitable-snail'], 'a corpse must not die twice');
});

// ------------------------------------------------------------ potions + chests

test('a potion applies its perk and drops it again when the timer runs out', () => {
  const fx = new PotionEffects();
  const swift = POTION_BY_ID.get('swift');

  assert.equal(fx.mods.speed, 1, 'no potion should mean no change');
  fx.apply(swift);
  assert.equal(fx.mods.speed, swift.speed);

  fx.update(swift.duration - 0.5);
  assert.equal(fx.mods.speed, swift.speed, 'expired early');
  fx.update(1);
  assert.equal(fx.mods.speed, 1, 'perk outlived its duration');
  assert.equal(fx.active.size, 0);
});

test('re-drinking a potion refreshes the timer instead of stacking the perk', () => {
  const fx = new PotionEffects();
  const swift = POTION_BY_ID.get('swift');

  fx.apply(swift);
  fx.update(swift.duration - 1);
  fx.apply(swift);

  assert.equal(fx.mods.speed, swift.speed, 'the perk doubled up');
  assert.equal(fx.active.size, 1);
  fx.update(swift.duration - 1);
  assert.equal(fx.mods.speed, swift.speed, 'the refresh did not extend the timer');
});

test('different potions compound, and expiry only removes its own perk', () => {
  const fx = new PotionEffects();
  const rapid = POTION_BY_ID.get('rapid');     // short
  const quick = POTION_BY_ID.get('quick');     // long
  assert.ok(quick.duration > rapid.duration, 'test assumes rapid expires first');

  fx.apply(rapid);
  fx.apply(quick);
  assert.equal(fx.mods.fireRate, rapid.fireRate);
  assert.equal(fx.mods.reload, quick.reload);

  fx.update(rapid.duration + 0.01);
  assert.equal(fx.mods.fireRate, 1, 'rapid should have gone');
  assert.equal(fx.mods.reload, quick.reload, 'quick should have survived');
});

test('potion flags and summed perks fold correctly', () => {
  const fx = new PotionEffects();
  fx.apply(POTION_BY_ID.get('endless'));
  fx.apply(POTION_BY_ID.get('leap'));
  fx.apply(POTION_BY_ID.get('vamp'));

  assert.equal(fx.mods.infiniteAmmo, true);
  assert.equal(fx.mods.noFall, true);
  assert.ok(fx.mods.lifesteal > 0);

  fx.clear();
  assert.equal(fx.mods.infiniteAmmo, false);
  assert.equal(fx.mods.noFall, false);
  assert.equal(fx.mods.lifesteal, 0);
});

test('every potion declares a name, a colour and a positive duration', () => {
  const ids = new Set();
  for (const p of POTIONS) {
    assert.ok(p.id && p.name && p.blurb, `${p.id} is missing display data`);
    assert.ok(p.duration > 0, `${p.id} has no duration`);
    assert.equal(typeof p.color, 'number');
    assert.ok(!ids.has(p.id), `duplicate potion id ${p.id}`);
    ids.add(p.id);
  }
});

test('a chest rolls one or two items, all from the loot table', () => {
  const kinds = new Set(CHEST_LOOT.map((e) => e.type));
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const loot = rollChestLoot();
    assert.ok(loot.length === 1 || loot.length === 2, `rolled ${loot.length} items`);
    for (const entry of loot) {
      assert.ok(kinds.has(entry.type), `unknown loot type ${entry.type}`);
      seen.add(entry.type);
    }
  }
  // Over 400 rolls the two headline drops should both have turned up.
  assert.ok(seen.has('potion'), 'potions never dropped');
  assert.ok(seen.has('map'), 'maps never dropped');
});

test('chests are placed on open ground, off the spawn plaza and apart', () => {
  const world = new World(777);
  for (const _ of world.generate()) { /* run to completion */ }
  const spawn = world.findSpawn();

  const chests = placeChests(world, spawn.x, spawn.z, 6);
  assert.ok(chests.length > 0, 'no chest could be placed at all');

  for (const c of chests) {
    assert.ok(Math.abs(c.y - world.heightAt(c.x, c.z)) < 0.01, 'chest is not on the ground');
    assert.ok(world.isWalkable(c.x, c.z), 'chest is on a cliff face');
    assert.ok(Math.hypot(c.x - spawn.x, c.z - spawn.z) >= MIN_SPAWN_DIST,
      'chest spawned on the plaza');
  }
});

test('a chest only pays out once', () => {
  const chest = new Chest(10, 5, 10);
  assert.ok(chest.open() !== null);
  assert.equal(chest.open(), null, 'a looted chest handed out a second roll');
  assert.equal(chest.opened, true);
});

test('an opened chest finishes its animation and reports itself spent', () => {
  const chest = new Chest(10, 5, 10);
  chest.update(0.2);
  assert.equal(chest.done, false, 'an untouched chest should never expire');

  chest.open();
  for (let i = 0; i < 200; i++) chest.update(1 / 60);
  assert.equal(chest.done, true, 'the chest never finished');
  assert.ok(chest.lid.rotation.x < -1, 'the lid never opened');
});

// --------------------------------------------------------------- potion perks

test('ENDLESS CLIP fires without draining the magazine', () => {
  const ws = new WeaponSystem(null);
  equip(ws, 'rifle');
  ws.infiniteAmmo = true;
  const p = fakePlayer();

  const before = ws.current.ammo;
  for (let i = 0; i < 240; i++) ws.update(1 / 240, p, true, i === 0);
  assert.equal(ws.current.ammo, before, 'infinite ammo still consumed rounds');

  ws.infiniteAmmo = false;
  for (let i = 0; i < 240; i++) ws.update(1 / 240, p, true, i === 0);
  assert.ok(ws.current.ammo < before, 'ammo should drain once the perk is off');
});

test('STEADY AIM tightens the cone by its multiplier', () => {
  const ws = new WeaponSystem(null);
  equip(ws, 'rifle');
  const p = fakePlayer();

  const base = ws.spread(p);
  ws.spreadScale = 0.35;
  assert.ok(Math.abs(ws.spread(p) - base * 0.35) < 1e-9, 'spread scale was not applied');
});

test('IRONSKIN scales incoming damage and LEAPING waives fall damage', () => {
  const world = new World(99);
  for (const _ of world.generate()) { /* run to completion */ }

  const p = new Player(world);
  p.spawn(world.findSpawn());
  p.damageScale = 0.45;
  p.damage(100);
  assert.ok(Math.abs(p.health - (p.maxHealth - 45)) < 1e-9, 'resistance was not applied');

  const faller = new Player(world);
  faller.spawn(world.findSpawn());
  faller.noFallDamage = true;
  faller.vel.y = -45;                       // well past the survivable drop
  const input = fakeInput();
  for (let i = 0; i < 240; i++) faller.update(1 / 60, input, true);
  assert.equal(faller.health, faller.maxHealth, 'LEAPING did not waive fall damage');
});

// ------------------------------------------------------------------- poison

test('poison bleeds its full dose over its duration and then stops', () => {
  const world = new World(21);
  for (const _ of world.generate()) { /* run to completion */ }
  const p = new Player(world);
  p.spawn(world.findSpawn());
  p.regenScale = 0;                      // isolate the poison from regen

  const input = fakeInput();
  p.applyPoison(24, 3);
  assert.equal(p.poisoned, true);

  const start = p.health;
  // Half the duration should have delivered about half the dose.
  for (let i = 0; i < 90; i++) p.update(1 / 60, input, true);
  const half = start - p.health;
  assert.ok(Math.abs(half - 12) < 1.5, `half-way damage was ${half}`);

  for (let i = 0; i < 120; i++) p.update(1 / 60, input, true);
  assert.equal(p.poisoned, false, 'poison outlasted its duration');
  assert.ok(Math.abs((start - p.health) - 24) < 0.5,
    `total poison damage was ${start - p.health}, expected 24`);

  // And it stays stopped.
  const after = p.health;
  for (let i = 0; i < 60; i++) p.update(1 / 60, input, true);
  assert.equal(p.health, after, 'poison kept ticking after expiring');
});

test('re-poisoning refreshes rather than stacking without bound', () => {
  const world = new World(22);
  for (const _ of world.generate()) { /* run to completion */ }
  const p = new Player(world);
  p.spawn(world.findSpawn());
  p.regenScale = 0;

  p.applyPoison(24, 3);
  for (let i = 0; i < 10; i++) p.applyPoison(24, 3);
  // Carry-over is capped at twice a single dose, so a swarm cannot chain-kill.
  assert.ok(p.poison.remaining <= 48 + 1e-6, `remaining was ${p.poison.remaining}`);
  assert.equal(p.poison.timeLeft, 3, 'refresh did not reset the clock');
});

test('a spitter poisons on contact and a grunt does not', () => {
  const world = new World(23);
  for (const _ of world.generate()) { /* run to completion */ }
  const spitter = ENEMY_TYPES.spitter;
  assert.ok(spitter, 'spitter type missing');
  assert.equal(spitter.poisonDuration, 3, 'poison should last 3 seconds');
  assert.ok(spitter.poisonDamage > 0);
  assert.ok(!ENEMY_TYPES.grunt.poisonDamage, 'a plain grunt must not poison');

  // Contact damage is deliberately low; the dose is the real threat.
  assert.ok(spitter.damage < ENEMY_TYPES.grunt.damage,
    'spitter should hit softer than a grunt on contact');
  assert.ok(spitter.poisonDamage > spitter.damage);
});

// ---------------------------------------------------------------- weapon slots

test('the starting loadout takes the first keys, and nothing else takes any', () => {
  const ws = new WeaponSystem(null);
  for (const w of ws.weapons) {
    if (w.owned) continue;
    assert.equal(w.slot, 0, `${w.def.id} holds a key without being carried`);
  }
  assert.deepEqual(ws.owned.map((w) => [w.def.id, w.slot]),
    [['pickaxe', 1], ['pistol', 2], ['portalgun', 3]],
    'a run should open with its weapon and traversal tool on consecutive keys');
});

test('pickups fill the keys in the order they are found', () => {
  const ws = new WeaponSystem(null);
  // Deliberately out of definition order: the key follows the order you found
  // things in, not the order they happen to be declared in.
  for (const id of ['flamethrower', 'knife', 'rifle']) ws.pickUp(id);

  assert.deepEqual(ws.owned.map((w) => [w.def.id, w.slot]),
    [['pickaxe', 1], ['pistol', 2], ['portalgun', 3],
      ['flamethrower', 4], ['knife', 5], ['rifle', 6]],
    'found weapons should queue up behind the starting loadout');
});

test('picking a weapon up again leaves its key where it was', () => {
  const ws = new WeaponSystem(null);
  ws.pickUp('rifle');
  ws.pickUp('shotgun');
  const rifle = ws.weapons.find((w) => w.def.id === 'rifle');

  assert.equal(rifle.slot, 4);
  ws.pickUp('rifle');           // a top-up, not a new gun
  assert.equal(rifle.slot, 4, 'a resupply moved the key out from under the player');
});

test('carrying everything uses every key exactly once', () => {
  const ws = new WeaponSystem(null);
  for (const def of WEAPONS) ws.pickUp(def.id);

  const slots = ws.weapons.map((w) => w.slot).sort((a, b) => a - b);
  assert.equal(slots.length, WEAPONS.length);
  assert.deepEqual(slots, Array.from({ length: WEAPONS.length }, (_, i) => i + 1),
    'every carried weapon needs its own key, with no holes and no clashes');
  assert.ok(WEAPONS.length <= SLOT_COUNT,
    'there are more weapons than slots, so the last ones found cannot be drawn');
});

test('a new run hands the keys back out from the start', () => {
  const ws = new WeaponSystem(null);
  ws.pickUp('railgun');
  assert.equal(ws.weapons.find((w) => w.def.id === 'railgun').slot, 4);

  ws.reset();
  assert.equal(ws.weapons.find((w) => w.def.id === 'railgun').slot, 0,
    'a weapon from last run kept its key');
  assert.deepEqual(ws.owned.map((w) => w.slot), [1, 2, 3]);
});

test('every slot is reachable from a key, and no key drives two slots', () => {
  const codes = new Map();
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const action = ACTIONS.find((a) => a.id === `slot${slot}`);
    assert.ok(action, `slot ${slot} has no binding, so its weapon cannot be drawn`);
    const clash = codes.get(action.def);
    assert.equal(clash, undefined,
      `${action.def} is bound to both slot${slot} and ${clash}`);
    codes.set(action.def, `slot${slot}`);
  }
});

test('a slot key draws exactly its own weapon, however often it is pressed', () => {
  const ws = new WeaponSystem(null);
  for (const def of WEAPONS) ws.pickUp(def.id);   // carry everything at once

  for (const held of ws.weapons) {
    // Pressing the same slot twice must not walk on to a different gun, which
    // is what the old cycle-within-a-group behaviour did.
    ws.selectSlot(held.slot);
    ws.switchTimer = 0;
    ws.index = ws.weapons.indexOf(held);
    ws.pendingIndex = -1;

    ws.selectSlot(held.slot);
    const landed = ws.pendingIndex >= 0 ? ws.weapons[ws.pendingIndex] : ws.current;
    assert.equal(landed.def.id, held.def.id,
      `slot ${held.slot} drew ${landed.def.id} instead of ${held.def.id}`);
  }
});

test('a key nothing has claimed is simply ignored', () => {
  const ws = new WeaponSystem(null);
  const before = ws.current.def.id;
  // Only 1, 2 and 3 are spoken for on a fresh run, so 4 reaches nothing yet.
  assert.equal(ws.selectSlot(4), false, 'drew a weapon that is not carried');
  assert.equal(ws.current.def.id, before, 'the carried weapon changed anyway');
  assert.equal(ws.weaponForSlot(4), null, 'an unclaimed key named a weapon');
});

test('slot zero is not a key, and never names a weapon', () => {
  const ws = new WeaponSystem(null);
  // Every un-found weapon sits on slot 0. If that were treated as a real key,
  // asking for it would hand back whichever of them came first.
  assert.equal(ws.weaponForSlot(0), null);
  assert.equal(ws.selectSlot(0), false);
});
