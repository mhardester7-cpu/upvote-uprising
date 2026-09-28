// Saved-data rules.
//
// These matter more than most tests here: a bug in this file does not show up
// as a crash, it shows up as a player losing an evening's progress. The merge
// rules and the corrupt-save handling are the two places that can do that
// quietly, so both are pinned down.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ProfileStore, emptyProfile, normalise, merge, CREDITS_PER_SCORE,
} from '../src/game/profile.js';
import { SKINS, SKIN_BY_ID, DEFAULT_SKIN, startingSkins } from '../src/game/skins.js';

/** localStorage stand-in. */
function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _dump: () => Object.fromEntries(m),
  };
}

// -------------------------------------------------------------------- catalog

test('every skin has a distinct id, a known rarity and a sane price', () => {
  const ids = new Set(SKINS.map((s) => s.id));
  assert.equal(ids.size, SKINS.length, 'duplicate skin id');

  for (const s of SKINS) {
    assert.ok(s.name, `${s.id} has no name`);
    assert.ok(['common', 'rare', 'epic', 'legendary'].includes(s.rarity), `${s.id} rarity`);
    assert.ok(Number.isInteger(s.price) && s.price >= 0, `${s.id} price`);
    // Only the free default may cost nothing; a 0-credit skin in the shop
    // would be bought instantly and read as a bug.
    if (!s.isDefault) assert.ok(s.price > 0, `${s.id} is free but not the default`);
  }
});

test('exactly one skin is the default, and it is what a new player owns', () => {
  const defaults = SKINS.filter((s) => s.isDefault);
  assert.equal(defaults.length, 1);
  assert.deepEqual(startingSkins(), [DEFAULT_SKIN.id]);

  const p = emptyProfile();
  assert.deepEqual(p.ownedSkins, [DEFAULT_SKIN.id]);
  assert.equal(p.equippedSkin, DEFAULT_SKIN.id);
  assert.equal(p.credits, 0);
});

// ------------------------------------------------------------------ normalise

test('a corrupt save costs the bad field, not the profile', () => {
  const p = normalise({
    credits: 'not a number',
    ownedSkins: 'not an array',
    equippedSkin: 'no-such-skin',
    bestScore: -50,
    totalKills: 12,
  });
  assert.equal(p.credits, 0);
  assert.deepEqual(p.ownedSkins, [DEFAULT_SKIN.id], 'default must survive');
  assert.equal(p.equippedSkin, DEFAULT_SKIN.id);
  assert.equal(p.bestScore, 0, 'negative score is not a score');
  assert.equal(p.totalKills, 12, 'the valid field is kept');
});

test('normalise drops skins that no longer exist but keeps the rest', () => {
  const real = SKINS.find((s) => !s.isDefault).id;
  const p = normalise({ ownedSkins: [real, 'retired-skin'], equippedSkin: real });
  assert.ok(p.ownedSkins.includes(real));
  assert.ok(!p.ownedSkins.includes('retired-skin'));
  assert.equal(p.equippedSkin, real);
});

test('you cannot have a skin equipped that you do not own', () => {
  const notOwned = SKINS.find((s) => !s.isDefault).id;
  const p = normalise({ ownedSkins: [], equippedSkin: notOwned });
  assert.equal(p.equippedSkin, DEFAULT_SKIN.id);
});

// ---------------------------------------------------------------------- merge

test('signing in keeps both sides: no progress is thrown away', () => {
  const a = SKINS[1].id, b = SKINS[2].id;
  const guest = normalise({ credits: 300, ownedSkins: [a], bestScore: 900, totalKills: 40, runs: 3 });
  const cloud = normalise({ credits: 500, ownedSkins: [b], bestScore: 400, totalKills: 10, runs: 1 });

  const m = merge(guest, cloud);
  assert.equal(m.credits, 800, 'earned currency from both sides is real');
  assert.ok(m.ownedSkins.includes(a) && m.ownedSkins.includes(b), 'union of unlocks');
  assert.equal(m.bestScore, 900, 'best is the better of the two');
  assert.equal(m.totalKills, 50);
  assert.equal(m.runs, 4);
});

test('merging is not order-dependent for the values that are maxed or summed', () => {
  const x = normalise({ credits: 120, bestScore: 700, bestWave: 4, totalKills: 9, runs: 2 });
  const y = normalise({ credits: 80, bestScore: 300, bestWave: 9, totalKills: 5, runs: 1 });
  const ab = merge(x, y), ba = merge(y, x);
  assert.equal(ab.credits, ba.credits);
  assert.equal(ab.bestScore, ba.bestScore);
  assert.equal(ab.bestWave, ba.bestWave);
  assert.equal(ab.totalKills, ba.totalKills);
  assert.equal(ab.runs, ba.runs);
});

test('a merge never leaves you wearing something the merge did not grant', () => {
  const owned = SKINS[1].id;
  const guest = normalise({ ownedSkins: [owned], equippedSkin: owned });
  // The cloud claims an skin id that no longer exists in the catalogue.
  const cloud = normalise({ ownedSkins: [], equippedSkin: 'gone' });
  const m = merge(guest, cloud);
  assert.ok(m.ownedSkins.includes(m.equippedSkin), 'equipped must be owned');
});

// ------------------------------------------------------------------ purchases

test('buying deducts, grants and equips -- and refuses when short', () => {
  const store = new ProfileStore(null, memStorage());
  const skin = SKINS.find((s) => !s.isDefault);

  const broke = store.buy(skin.id);
  assert.equal(broke.ok, false);
  assert.match(broke.reason, /NEED/);
  assert.equal(store.owns(skin.id), false, 'a failed buy must grant nothing');

  store.data.credits = skin.price;
  const bought = store.buy(skin.id);
  assert.equal(bought.ok, true);
  assert.equal(store.credits, 0, 'price is deducted exactly');
  assert.equal(store.owns(skin.id), true);
  assert.equal(store.equippedSkin, skin.id, 'buying equips it');

  // Buying twice must not charge twice.
  store.data.credits = skin.price;
  const again = store.buy(skin.id);
  assert.equal(again.ok, false);
  assert.equal(store.credits, skin.price, 'no double charge');
});

test('you can only equip what you own', () => {
  const store = new ProfileStore(null, memStorage());
  const skin = SKINS.find((s) => !s.isDefault);
  assert.equal(store.equip(skin.id).ok, false);
  assert.equal(store.equippedSkin, DEFAULT_SKIN.id);
});

test('a run pays out on score and updates the records', () => {
  const store = new ProfileStore(null, memStorage());
  const earned = store.recordRun({ score: 2500, wave: 7, kills: 31 });

  assert.equal(earned, Math.floor(2500 * CREDITS_PER_SCORE));
  assert.equal(store.credits, earned);
  assert.equal(store.data.bestScore, 2500);
  assert.equal(store.data.bestWave, 7);
  assert.equal(store.data.totalKills, 31);
  assert.equal(store.data.runs, 1);

  // A worse run still banks credits and kills, but must not lower the records.
  store.recordRun({ score: 100, wave: 1, kills: 2 });
  assert.equal(store.data.bestScore, 2500, 'a bad run cannot lower your best');
  assert.equal(store.data.bestWave, 7);
  assert.equal(store.data.totalKills, 33);
  assert.equal(store.data.runs, 2);
});

// ----------------------------------------------------------------- guest save

test('guest progress round-trips through storage', async () => {
  const storage = memStorage();
  const skin = SKINS.find((s) => !s.isDefault);

  const first = new ProfileStore(null, storage);
  await first.load();
  first.data.credits = skin.price;
  first.buy(skin.id);
  first.recordRun({ score: 1000, wave: 3, kills: 10 });

  // A fresh store over the same storage is what a page reload looks like.
  const second = new ProfileStore(null, storage);
  await second.load();
  assert.equal(second.owns(skin.id), true, 'unlock survived the reload');
  assert.equal(second.equippedSkin, skin.id);
  assert.equal(second.credits, first.credits);
  assert.equal(second.data.bestScore, 1000);
});

test('a store with no saved data starts clean rather than throwing', async () => {
  const store = new ProfileStore(null, memStorage({ 'blockstrike.guest': '{{{ not json' }));
  await store.load();
  assert.equal(store.credits, 0);
  assert.equal(store.owns(DEFAULT_SKIN.id), true);
  assert.equal(store.isGuest, true);
});
