import test from 'node:test';
import assert from 'node:assert/strict';

import { authControlState } from '../src/ui/account.js';
import { normaliseProgress, Progress } from '../src/ui/progress.js';
import { isInteractiveControl } from '../src/engine/input.js';

test('enabling accounts enables signed-out auth controls', () => {
  assert.deepEqual(authControlState(true, false), {
    accountEntryHidden: false,
    accountEntryDisabled: false,
    signInHidden: false,
    signUpHidden: false,
    signOutHidden: true,
    signInDisabled: false,
    signUpDisabled: false,
    signOutDisabled: true,
    fieldsDisabled: false,
  });
  assert.equal(authControlState(true, true).signOutDisabled, false);
  assert.equal(authControlState(true, true).signOutHidden, false);
  assert.equal(authControlState(true, true).fieldsDisabled, true);
  assert.equal(authControlState(true, false, true).signInDisabled, true);
  assert.equal(authControlState(false, false).fieldsDisabled, true);
  assert.equal(authControlState(false, false).accountEntryHidden, true);
  assert.equal(authControlState(false, false).accountEntryDisabled, true);
});

test('corrupt persisted progress is normalised before UI arithmetic', () => {
  assert.deepEqual(normaliseProgress({
    bestScore: '1250',
    bestWave: -4,
    runs: 'not-a-number',
    kills: { bad: true },
    headshots: 8.9,
    bosses: Infinity,
    playtime: 62.8,
    camos: ['gold', 'gold', null, ''],
    camo: 'missing',
  }), {
    bestScore: 1250,
    bestWave: 0,
    runs: 0,
    kills: 0,
    headshots: 8,
    bosses: 0,
    playtime: 62,
    camos: ['standard', 'gold'],
    camo: 'standard',
  });
});

test('Progress safely loads a malformed browser record', () => {
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => JSON.stringify({ runs: {}, camos: 'gold', camo: 42 }),
      setItem() {},
    },
  });
  try {
    const progress = new Progress();
    assert.equal(progress.data.runs, 0);
    assert.deepEqual(progress.data.camos, ['standard']);
    assert.doesNotThrow(() => progress.recordRun({ score: 10, wave: 1 }));
    assert.match(progress.summaryHTML(), /RUNS <b>1<\/b>/);
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, value: original,
    });
  }
});

test('native menu controls are recognised even from nested event targets', () => {
  assert.equal(isInteractiveControl({ tagName: 'BUTTON' }), true);
  assert.equal(isInteractiveControl({ tagName: 'INPUT', type: 'checkbox' }), true);
  assert.equal(isInteractiveControl({ tagName: 'A', href: '/privacy.html' }), true);
  assert.equal(isInteractiveControl({ tagName: 'SPAN', closest: () => ({}) }), true);
  assert.equal(isInteractiveControl({ tagName: 'CANVAS', closest: () => null }), false);
});
