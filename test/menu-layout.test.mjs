import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

const menuAt = html.indexOf('id="panel-menu"');
const menuEnd = html.indexOf('id="panel-auth"', menuAt);
const menu = html.slice(menuAt, menuEnd);

test('the front menu keeps controls on demand instead of showing a permanent legend', () => {
  assert.doesNotMatch(menu, /id="keys-desktop"/);
  assert.doesNotMatch(menu, /class="keys keys-touch"/);
  assert.doesNotMatch(menu, />W A S D</);
  assert.match(menu, /<div class="menu-actions">/);
  assert.match(menu, /id="btn-settings">CONTROLS<\/button>/);

  assert.match(html, /<div class="panel hidden" id="panel-settings">/);
  assert.match(html, /<div id="binds"><\/div>/);
  assert.match(main, /getElementById\('btn-settings'\)[\s\S]*settings\.open\('panel-menu'\)/);
});

test('menu panels stay within the viewport and scroll rather than clipping words', () => {
  assert.match(html, /max-height: calc\(100vh - 24px\); max-height: calc\(100dvh - 24px\);/);
  assert.match(html, /overflow-x: hidden; overflow-y: auto;/);
  assert.match(html, /#overlay \{[\s\S]*padding: 12px 0; overflow-x: hidden; overflow-y: auto;/);
});
