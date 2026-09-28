import test from 'node:test';
import assert from 'node:assert/strict';

import { World, MAP_COMPLEX } from '../src/world/world.js';
import { NUGGET_DISPENSER_KIND } from '../src/world/buildings.js';

function generated(seed) {
  const world = new World(seed, { map: MAP_COMPLEX });
  for (const _ of world.generate()) { /* drain */ }
  return world;
}

test('the start room contains its nugget landmark but no random ground-floor clutter', () => {
  for (let seed = 1; seed <= 64; seed++) {
    const world = generated(seed);
    const furnishings = world.props.filter((prop) => prop.room === world.plan.start
      && prop.storey === 0
      && (prop.type === 'furniture' || prop.type === 'crate' || prop.type === 'barrel'));

    assert.equal(furnishings.length, 1, `seed ${seed} added random start-room clutter`);
    assert.equal(furnishings[0].kind, NUGGET_DISPENSER_KIND,
      `seed ${seed} did not preserve the nugget dispenser landmark`);
  }
});
