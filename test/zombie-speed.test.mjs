import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ENEMY_TYPES } from '../src/entities/enemy.js';

test('animated enemies do not move faster than their locomotion clips can show', () => {
  // These are the conservative speeds used when an in-place animation has no
  // root travel to measure. updateCharacter allows at most 1.7x playback; past
  // that, faster simulation movement becomes visible foot sliding again.
  const WALK_SPEED = 0.9;
  const RUN_SPEED = 2.6;
  const RUN_ABOVE = 1.9;
  const MAX_RATE = 1.7;
  const src = readFileSync(new URL('../src/render/charactermodels.js', import.meta.url), 'utf8');
  const block = src.match(/export const CHARACTER_ROLES = \{([\s\S]*?)\};/)[1];
  const mapped = [...block.matchAll(/^\s*(\w+):\s*'[\w-]+'/gm)].map((m) => m[1]);

  for (const type of mapped) {
    const enemy = ENEMY_TYPES[type];
    const clipSpeed = enemy.speed >= RUN_ABOVE ? RUN_SPEED : WALK_SPEED;
    assert.ok(enemy.speed <= clipSpeed * MAX_RATE,
      `${enemy.label} moves at ${enemy.speed}m/s, beyond its clip's ${MAX_RATE}x limit`);
  }
});
