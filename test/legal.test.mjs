import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONSENT_KEY, POLICY_VERSION, hasLegalConsent, saveLegalConsent,
} from '../src/ui/legal.js';

function storage() {
  const data = new Map();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test('legal acceptance is explicit, versioned and revocable', () => {
  const s = storage();
  assert.equal(hasLegalConsent(s), false);
  assert.equal(saveLegalConsent(true, s), true);
  assert.equal(s.data.get(CONSENT_KEY), 'accepted');
  assert.equal(hasLegalConsent(s), true);
  assert.equal(saveLegalConsent(false, s), false);
  assert.equal(hasLegalConsent(s), false);
  assert.match(CONSENT_KEY, new RegExp(POLICY_VERSION));
});

test('unavailable browser storage fails closed', () => {
  const blocked = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  assert.equal(hasLegalConsent(blocked), false);
  assert.equal(saveLegalConsent(true, blocked), true);
});
