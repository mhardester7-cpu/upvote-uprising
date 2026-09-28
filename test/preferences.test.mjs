import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readPreference, writePreference } from '../src/ui/preferences.js';

test('blocked browser storage cannot prevent menu preferences or game startup', () => {
  const original = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem() { throw new DOMException('blocked', 'SecurityError'); },
      setItem() { throw new DOMException('blocked', 'SecurityError'); },
    },
  });
  try {
    assert.equal(readPreference('test.private-mode', 'default'), 'default');
    assert.equal(writePreference('test.private-mode', 'runner'), 'runner');
    assert.equal(readPreference('test.private-mode', 'default'), 'runner');
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, value: original,
    });
  }
});

test('Solo and Host surface startup failures instead of leaving a frozen menu', () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(source, /try \{ this\.startGame\(\); \}\s*catch \(error\) \{ this\._launchFailed\(error\); \}/,
    'Solo startup exceptions still escape the click handler');
  assert.match(source, /this\.startCoop\('', 'coop',[\s\S]*?\.catch\(\(error\) => this\._launchFailed\(error\)\)/,
    'Host startup rejections still disappear as an unhandled promise');
  assert.match(source, /_mpStatus\(`Could not start:/,
    'startup recovery does not explain the failure in the visible menu');
});
