import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('front menu does not publish personal social profiles', () => {
  assert.doesNotMatch(html, /social-banner|data-platform=/i);
  assert.doesNotMatch(html, /instagram\.com|youtube\.com\/@|tiktok\.com\/@|reddit\.com\/user\//i);
});
