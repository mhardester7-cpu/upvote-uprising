import test from 'node:test';
import assert from 'node:assert/strict';

import { WEAPONS } from '../src/combat/weapons.js';
import {
  CHEST_GUN_IDS, CHEST_LOOT, CHEST_WEAPON_WEIGHT, rollChestLoot,
} from '../src/entities/chest.js';

const FIREARM_IDS = WEAPONS
  .filter((weapon) => !weapon.melee && !weapon.designator)
  .map((weapon) => weapon.id);

test('every ranged firearm is in chests at one equal weight', () => {
  assert.deepEqual(CHEST_GUN_IDS, FIREARM_IDS);
  assert.ok(CHEST_GUN_IDS.includes('flamethrower'));

  const weaponRows = CHEST_LOOT.filter((entry) => entry.type === 'weapon');
  const byId = new Map(weaponRows.map((entry) => [entry.id, entry]));
  for (const id of FIREARM_IDS) {
    assert.equal(byId.get(id)?.weight, CHEST_WEAPON_WEIGHT, `${id} is missing or rarity-weighted`);
  }
  assert.equal(new Set(weaponRows.map((entry) => entry.weight)).size, 1,
    'chest weapon entries do not have equal probability');

  // Airstrike is intentionally retained as a designator reward, not counted as
  // a gun; knife is likewise retained as the existing melee reward.
  assert.ok(!CHEST_GUN_IDS.includes('airstrike'));
  assert.equal(byId.get('airstrike')?.weight, CHEST_WEAPON_WEIGHT);
  assert.ok(!CHEST_GUN_IDS.includes('knife'));
  assert.equal(byId.get('knife')?.weight, CHEST_WEAPON_WEIGHT);

  assert.deepEqual(CHEST_LOOT.filter((entry) => entry.type !== 'weapon'), [
    { type: 'potion', weight: 22 },
    { type: 'map', weight: 12 },
    { type: 'ammo', weight: 14 },
  ], 'support chest behavior changed');
});

test('a deterministic large sample gives every gun the same observed chance', () => {
  // Fixed LCG: this is a repeatable distribution check, not a flaky Math.random
  // smoke test. It catches a selection algorithm that applies hidden rarity
  // after the equal-weight table has been declared.
  let state = 0x51a7c0de;
  const rng = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const counts = new Map(FIREARM_IDS.map((id) => [id, 0]));
  for (let chest = 0; chest < 60000; chest++) {
    for (const item of rollChestLoot(rng)) {
      if (counts.has(item.id)) counts.set(item.id, counts.get(item.id) + 1);
    }
  }
  const values = [...counts.values()];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  for (const [id, count] of counts) {
    assert.ok(Math.abs(count - mean) / mean < 0.065,
      `${id} observed ${count} drops versus equal-weight mean ${mean.toFixed(1)}`);
  }
});
