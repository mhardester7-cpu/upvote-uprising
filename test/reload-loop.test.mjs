import test from 'node:test';
import assert from 'node:assert/strict';

import { WeaponSystem, WEAPONS } from '../src/combat/weapons.js';
import {
  installReloadSafety,
  MAX_SAFE_RELOAD_SECONDS,
} from '../src/game/reload-safety.js';

installReloadSafety();

function fakePlayer() {
  return {
    vel: { x: 0, y: 0, z: 0 },
    onGround: true,
    pitch: 0,
    yaw: 0,
    getLookDir(out) {
      out.x = 0; out.y = 0; out.z = -1;
      return out;
    },
  };
}

function equip(system, id) {
  const index = system.weapons.findIndex((weapon) => weapon.def.id === id);
  assert.ok(index >= 0, `missing weapon ${id}`);
  system.weapons[index].owned = true;
  system.index = index;
  system.pendingIndex = -1;
  system.switchTimer = 0;
  system.reloadTimer = 0;
  return system.weapons[index];
}

function runUntilReloadEnds(system, player, seconds = MAX_SAFE_RELOAD_SECONDS + 1) {
  const dt = 1 / 60;
  const ticks = Math.ceil(seconds / dt);
  for (let i = 0; i < ticks && system.isReloading; i++) {
    system.update(dt, player, false, false);
  }
}

test('every reloadable weapon completes from empty in bounded time', () => {
  const player = fakePlayer();

  for (const def of WEAPONS) {
    if (def.noAmmo || !(def.reserveMax > 0)) continue;
    const system = new WeaponSystem(null);
    const weapon = equip(system, def.id);
    weapon.ammo = 0;
    weapon.reserve = Math.max(1, Math.min(def.reserveMax, weapon.magSize * 2));

    assert.equal(system.startReload(), true, `${def.id} should begin a reload`);
    assert.ok(Number.isFinite(system.reloadTimer), `${def.id} reload timer must be finite`);
    assert.ok(system.reloadTimer <= MAX_SAFE_RELOAD_SECONDS,
      `${def.id} reload exceeded the safety bound`);

    runUntilReloadEnds(system, player);
    assert.equal(system.isReloading, false, `${def.id} stayed stuck reloading`);
    assert.ok(weapon.ammo > 0, `${def.id} finished without loading a round`);
  }
});

test('a NaN reload multiplier cannot create a non-terminating reload', () => {
  const system = new WeaponSystem(null);
  const player = fakePlayer();
  const weapon = equip(system, 'rifle');
  weapon.ammo = 0;
  weapon.reserve = weapon.magSize * 2;
  system.reloadScale = Number.NaN;

  assert.equal(system.startReload(), true);
  assert.ok(Number.isFinite(system.reloadTimer), 'reload timer remained NaN');
  assert.ok(system.reloadTimer <= MAX_SAFE_RELOAD_SECONDS);

  runUntilReloadEnds(system, player);
  assert.equal(system.isReloading, false);
  assert.equal(weapon.ammo, weapon.magSize);
});

test('a zero reload multiplier falls back to neutral speed instead of a 20x wait', () => {
  const system = new WeaponSystem(null);
  const weapon = equip(system, 'minigun');
  weapon.ammo = 0;
  weapon.reserve = weapon.magSize * 2;
  system.reloadScale = 0;

  assert.equal(system.startReload(), true);
  assert.ok(system.reloadTimer <= weapon.def.reloadTime + 1e-9,
    `zero reload scale produced a ${system.reloadTimer}s reload`);
});

test('a poisoned infinite timer is repaired while the reload is in progress', () => {
  const system = new WeaponSystem(null);
  const player = fakePlayer();
  const weapon = equip(system, 'shotgun');
  weapon.ammo = 0;
  weapon.reserve = weapon.magSize * 2;

  assert.equal(system.startReload(), true);
  system.reloadTimer = Infinity;
  system.reloadTotal = Infinity;

  system.update(1 / 60, player, false, false);
  assert.ok(Number.isFinite(system.reloadTimer), 'infinite timer survived a gameplay tick');
  assert.ok(system.reloadTimer <= MAX_SAFE_RELOAD_SECONDS);

  runUntilReloadEnds(system, player);
  assert.equal(system.isReloading, false);
  assert.ok(weapon.ammo > 0);
});

test('a zero-progress reload is repaired once instead of restarting forever', () => {
  const system = new WeaponSystem(null);
  const player = fakePlayer();
  const weapon = equip(system, 'pistol');
  weapon.ammo = 0;
  weapon.reserve = weapon.magSize * 2;
  let starts = 0;
  system.onReloadStart = () => { starts++; };

  // Reproduce the pathological state directly: the countdown finishes, but the
  // underlying completion path fails to transfer ammunition. Before the safety
  // guard, an empty gun held on fire could enter the same reload again forever.
  system._finishReload = () => {};

  assert.equal(system.startReload(), true);
  for (let i = 0; i < 600 && system.isReloading; i++) {
    system.update(1 / 60, player, true, false);
  }

  assert.equal(system.isReloading, false);
  assert.ok(weapon.ammo > 0, 'safety completion did not transfer any ammo');
  assert.equal(starts, 1, 'the failed reload restarted instead of terminating');
});
