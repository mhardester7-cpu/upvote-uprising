// Cosmetics: what the player bought has to be what they are holding.
//
// There are two of them and they stack. A FINISH is the palette the weapon
// models are built from, so changing one rebuilds every model. A SKIN is a
// repaint layered over whatever those models came out as. Both of the bugs
// below shipped, and both looked identical from the player's side -- money
// spent, profile says equipped, gun in hand is plain:
//
//   Rebuilding the models threw the repaint away and nothing put it back.
//
//   A skin names the roles it remaps by their STANDARD colour, so once a finish
//   had rebuilt the models in a different palette the lookup matched nothing
//   and the skin quietly did nothing at all.

import test from 'node:test';
import assert from 'node:assert/strict';

// three.js reads `self` when it loads; there is no DOM in a test runner.
globalThis.self ??= globalThis;

const { ViewModel } = await import('../src/render/viewmodel.js');
const { applySkinToAll, SKINS, SKIN_BY_ID } = await import('../src/game/skins.js');
const { CAMOS } = await import('../src/render/camos.js');

/** The first material colour on a weapon, which is enough to tell paint apart. */
function colourOf(viewmodel, id = 'pistol') {
  let hex = null;
  viewmodel.models[id].traverse((o) => {
    if (hex === null && o.isMesh && o.material?.color) hex = o.material.color.getHex();
  });
  return hex;
}

const A_SKIN = SKINS.find((s) => !s.isDefault).id;
const A_FINISH = CAMOS.find((c) => c.id !== 'standard').id;

test('a skin actually repaints the gun', () => {
  const vm = new ViewModel();
  const plain = colourOf(vm);
  applySkinToAll(vm, A_SKIN);
  assert.notEqual(colourOf(vm), plain, `${A_SKIN} left the gun looking standard`);
});

test('changing a finish does not strip the skin off', () => {
  const vm = new ViewModel();
  // What the game does: re-apply the equipped skin after every rebuild.
  vm.onRefinish = () => applySkinToAll(vm, A_SKIN);

  applySkinToAll(vm, A_SKIN);
  const skinned = colourOf(vm);

  vm.applyCamo(A_FINISH);
  assert.equal(colourOf(vm), skinned,
    `putting on the ${A_FINISH} finish changed what the ${A_SKIN} skin was painting`);
});

test('a skin matches its roles whatever finish is underneath', () => {
  // The role, not the raw colour, is what a skin keys on -- otherwise a skin
  // works on a standard weapon and silently fails on a finished one.
  for (const finish of CAMOS.map((c) => c.id)) {
    const vm = new ViewModel();
    vm.applyCamo(finish);
    const before = colourOf(vm);
    applySkinToAll(vm, A_SKIN);
    assert.notEqual(colourOf(vm), before,
      `${A_SKIN} did nothing on top of the ${finish} finish`);
  }
});

test('every weapon in the arsenal can wear every skin', () => {
  const vm = new ViewModel();
  for (const skin of SKINS) {
    applySkinToAll(vm, skin.id);
    for (const id of Object.keys(vm.models)) {
      let painted = 0;
      vm.models[id].traverse((o) => { if (o.isMesh && o.material) painted++; });
      assert.ok(painted > 0, `${id} has no materials to wear ${skin.id}`);
    }
  }
  // And the default puts everything back exactly as built.
  const vm2 = new ViewModel();
  const plain = colourOf(vm2);
  applySkinToAll(vm2, A_SKIN);
  applySkinToAll(vm2, SKIN_BY_ID.get('default')?.id ?? 'default');
  assert.equal(colourOf(vm2), plain, 'taking a skin off did not restore the gun');
});
