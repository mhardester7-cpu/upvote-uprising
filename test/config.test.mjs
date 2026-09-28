import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ACCOUNTS_ENABLED, isConfigured, supabaseConfig,
} from '../src/net/config.js';

test('the public build fails closed to guest-only account configuration', () => {
  assert.equal(ACCOUNTS_ENABLED, false);
  assert.deepEqual(supabaseConfig(), { url: '', anonKey: '' });
  assert.equal(isConfigured(), false);
});

test('account entry and submission controls are hidden in the public markup', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['btn-account', 'btn-signin', 'btn-signup', 'btn-signout']) {
    assert.match(html, new RegExp(`<button[^>]*id="${id}"[^>]*hidden`), `${id} is visible`);
  }
  assert.match(html, /<div class="panel hidden" id="panel-auth">/);
});
