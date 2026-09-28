import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const travel = await readFile(new URL('../src/game/interplanetary.js', import.meta.url), 'utf8');

const loadStart = main.indexOf('  async load() {');
const loadEnd = main.indexOf('\n  // ------------------------------------------------------------------ co-op', loadStart);
const load = main.slice(loadStart, loadEnd);

test('the initial loading screen fully hides unfinished fallback art', () => {
  assert.match(html, /<div id="overlay" class="asset-loading">/);
  assert.match(html, /#overlay\.asset-loading\s*\{[^}]*background:\s*rgb\(8, 10, 14\)/);
  assert.match(html, /body:not\(\.assets-ready\) canvas\s*\{[^}]*visibility:\s*hidden/);
  assert.match(load, /panelLoad\.classList\.add\('hidden'\)[\s\S]*overlay\.classList\.remove\('asset-loading'\)/);
});

test('the menu stays blocked until every model-backed startup system settles', () => {
  const requiredStart = main.indexOf('  async _loadRequiredWorldArt(');
  const requiredEnd = main.indexOf('\n  /**\n   * Upgrade fallbacks', requiredStart);
  const requiredArt = main.slice(requiredStart, requiredEnd);
  const required = [
    'this.travel?.loadHazardAssets()',
    'this._mountImportantButton()',
    'this._mountSpinningCat()',
    'preloadRemotePlayerModel()',
    'this._mountDinosaurFactory()',
    'this.drummerTower?.loadAssets()',
    'this._mountWorldModels()',
    'this.travel?.loadDetailedShip()',
    'this._loadSkyEnvironment()',
    'this._mountReverseAquarium()',
  ];
  for (const call of required) {
    assert.ok(requiredArt.includes(call), `startup gate does not await ${call}`);
  }
  assert.match(requiredArt, /for \(let index = 0; index < steps\.length; index\+\+\)[\s\S]*await work\(\)[\s\S]*await pause\(\)/,
    'startup art is not decoded sequentially with browser yields');
  const gate = load.indexOf('await this._loadRequiredWorldArt({');
  const weapons = load.indexOf('await this._adoptWeapons();');
  const warm = load.indexOf('await this._warmStartingWeapon();');
  const ready = load.indexOf('this.assetsReady = true;');
  const canvas = load.indexOf("document.body.classList.add('assets-ready');");
  const menu = load.indexOf("this._showMenuPanel('menu');");
  assert.ok(gate >= 0 && gate < weapons && weapons < warm
    && warm < ready && ready < canvas && canvas < menu,
    'the menu becomes available before startup assets finish');
});

test('the starting weapon is uploaded to the GPU before the canvas is revealed', () => {
  const start = main.indexOf('  async _warmStartingWeapon() {');
  const end = main.indexOf('\n  // ------------------------------------------------------------ state moves', start);
  const warm = main.slice(start, end);
  assert.match(warm, /model\.userData\.replacementPending/);
  assert.match(warm, /renderer\.initTexture\(value\)/);
  assert.match(warm, /renderer\.compileAsync/);
});

test('world rebuilds use the pooled interior-light rig that actually exists', () => {
  assert.doesNotMatch(main, /this\._buildInteriorLights\(/,
    'startup still calls the removed one-light-per-room implementation');
  assert.match(main, /this\._lightInteriors\(\)/);
  assert.match(main, /this\._updateInteriorLights\(frameDt\)/);
});

test('flight art exposes one readiness promise for ship, snail, and banana assets', () => {
  const readyAt = travel.indexOf('this.ready = typeof window');
  const getterAt = travel.indexOf('\n  get piloting', readyAt);
  const block = travel.slice(readyAt, getterAt);
  assert.match(block, /this\.loadDetailedShip\(\)/);
  assert.match(block, /this\.loadHazardAssets\(\)/);
  assert.match(block, /Promise\.all\(/);
});

test('a run cannot begin before the startup gate reports ready', () => {
  const start = main.indexOf('  startGame(opts = {}) {');
  const pause = main.indexOf('\n  pause() {', start);
  assert.match(main.slice(start, pause), /if \(!this\.assetsReady\) return false;/);
  assert.match(main, /viewmodel\.requireExternalModel\(this\.weapons\.def\.id\)/);
});
