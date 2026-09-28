import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

const panelAt = html.indexOf('id="panel-patchnotes"');
const panelEnd = html.indexOf('<!-- key bindings -->', panelAt);
const panel = html.slice(panelAt, panelEnd);

test('the menu automatically carries a compact release card at its side', () => {
  assert.doesNotMatch(html, /id="btn-patchnotes"/);
  assert.match(panel, /aria-labelledby="patchnotes-title"/);
  assert.match(panel, /RELEASE 0\.0\.0/);
  assert.match(panel, /id="patchnotes-title">CHANGES/);
  assert.match(main, /_showMenuPanel\('menu'\)/);
  assert.match(html, /#overlay\.patch-open \{ gap:/);
});

test('patch 0.0.0 carries the three requested removal jokes verbatim', () => {
  assert.equal((panel.match(/data-change="removed"/g) ?? []).length, 3);
  assert.equal((panel.match(/class="patch-removed">REMOVED/g) ?? []).length, 3);
  assert.match(panel, /AQUARIUM OSHA[\s\S]*Fish may once again work without handrails\./);
  assert.match(panel, /ENEMY HR DEPARTMENT[\s\S]*Complaints now go directly to the final boss\./);
  assert.match(panel, /MR\. POOPY CAMEO[\s\S]*Removed after legal confirmed he was not available for this universe\./);
  assert.doesNotMatch(panel, /INTERNAL BUILD|zero player footage|DOCUMENTED PLAYTIME/);
});

test('release notes contain only the three requested removal jokes', () => {
  assert.equal((panel.match(/data-change="added"/g) ?? []).length, 0);
  assert.doesNotMatch(panel, /DAN DAN CAT|random indoor room|one full GIF pass/);
});

test('release card closes accessibly by button or Escape and fits narrow screens', () => {
  assert.match(panel, /id="btn-patchnotes-close"[\s\S]*aria-label="Close release notes"/);
  assert.match(main, /btn-patchnotes-close'[\s\S]*closePatchnotes/);
  assert.match(main, /_patchnotesDismissed = true;[\s\S]*_setPatchnotesVisible\(false\)/);
  assert.match(main, /event\.key !== 'Escape'[\s\S]*closePatchnotes\(\)/);
  assert.match(html, /@media \(max-width: 720px\) \{[\s\S]*#panel-patchnotes/);
});

test('release card is spent when play starts and stays hidden on pause', () => {
  const startAt = main.indexOf('  startGame(opts = {}) {');
  const pauseAt = main.indexOf('\n  pause() {', startAt);
  const resumeAt = main.indexOf('\n  resume() {', pauseAt);
  const start = main.slice(startAt, pauseAt);
  const pause = main.slice(pauseAt, resumeAt);
  assert.match(start, /_patchnotesDismissed = true;[\s\S]*_setPatchnotesVisible\(false\)/);
  assert.match(pause, /_setPatchnotesVisible\(false\)[\s\S]*panelPause\.classList\.remove\('hidden'\)/);
});
