// The player's saved data, and the two places it can live.
//
// Guest and account are deliberately the same object with different backing.
// The game asks for `profile.credits` and calls `profile.save()`; whether that
// lands in localStorage or in Postgres is not something the shop or the run
// summary should have to know.
//
// Guest play is the default and works with no network and no account. Signing
// in later does not throw that progress away -- see `merge()`, which is what
// makes "play now, decide later" an honest offer rather than a trap.

import { startingSkins, SKIN_BY_ID, DEFAULT_SKIN } from './skins.js';

const GUEST_KEY = 'blockstrike.guest';
/** Bumped when the shape changes, so an old save can be migrated not dropped. */
const VERSION = 1;

/** Credits paid per point of score. A good run is worth a few hundred. */
export const CREDITS_PER_SCORE = 0.1;

export function emptyProfile() {
  return {
    version: VERSION,
    credits: 0,
    ownedSkins: startingSkins(),
    equippedSkin: DEFAULT_SKIN.id,
    bestScore: 0,
    bestWave: 0,
    totalKills: 0,
    runs: 0,
  };
}

/**
 * Fold a loaded record into a complete profile.
 *
 * Anything missing or malformed falls back to the default rather than throwing:
 * a save written by an older build, or hand-edited in devtools, should cost the
 * player the corrupt field and nothing else.
 */
export function normalise(raw) {
  const base = emptyProfile();
  if (!raw || typeof raw !== 'object') return base;

  const owned = Array.isArray(raw.ownedSkins)
    ? raw.ownedSkins.filter((id) => SKIN_BY_ID.has(id))
    : [];
  // The default skin is always owned; losing it would leave the player unable
  // to un-equip whatever they are wearing.
  for (const id of startingSkins()) if (!owned.includes(id)) owned.push(id);

  const equipped = SKIN_BY_ID.has(raw.equippedSkin) && owned.includes(raw.equippedSkin)
    ? raw.equippedSkin
    : DEFAULT_SKIN.id;

  return {
    version: VERSION,
    credits: num(raw.credits, 0),
    ownedSkins: owned,
    equippedSkin: equipped,
    bestScore: num(raw.bestScore, 0),
    bestWave: num(raw.bestWave, 0),
    totalKills: num(raw.totalKills, 0),
    runs: num(raw.runs, 0),
  };
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Combine guest progress with an account's, taking the better of each.
 *
 * Signing in on a device where someone already played as a guest is the normal
 * case, not an edge case. Taking the max of every counter and the union of
 * owned skins means neither side loses anything -- the alternative, letting the
 * cloud row overwrite local play, is how a player loses an evening's progress.
 */
export function merge(a, b) {
  const A = normalise(a), B = normalise(b);
  const owned = [...new Set([...A.ownedSkins, ...B.ownedSkins])];
  return {
    version: VERSION,
    // Credits are summed rather than maxed: they are earned currency, and the
    // guest's earnings are as real as the account's.
    credits: A.credits + B.credits,
    ownedSkins: owned,
    // Prefer whatever the cloud had equipped, as long as it survived the merge.
    equippedSkin: owned.includes(B.equippedSkin) ? B.equippedSkin : A.equippedSkin,
    bestScore: Math.max(A.bestScore, B.bestScore),
    bestWave: Math.max(A.bestWave, B.bestWave),
    totalKills: A.totalKills + B.totalKills,
    runs: A.runs + B.runs,
  };
}

/** Column names in Postgres are snake_case; the game's fields are not. */
function toRow(p) {
  return {
    credits: p.credits,
    owned_skins: p.ownedSkins,
    equipped_skin: p.equippedSkin,
    best_score: p.bestScore,
    best_wave: p.bestWave,
    total_kills: p.totalKills,
    runs: p.runs,
  };
}

function fromRow(row) {
  if (!row) return null;
  return normalise({
    credits: row.credits,
    ownedSkins: row.owned_skins,
    equippedSkin: row.equipped_skin,
    bestScore: row.best_score,
    bestWave: row.best_wave,
    totalKills: row.total_kills,
    runs: row.runs,
  });
}

export class ProfileStore {
  /**
   * @param supabase a Supabase instance, or null for guest-only builds
   */
  constructor(supabase = null, storage = defaultStorage()) {
    this.supabase = supabase;
    this.storage = storage;
    this.data = emptyProfile();
    /** Fired after any change, so the HUD and shop can re-read. */
    this.onChange = null;
    this._saveTimer = null;
    this._pendingCloud = false;
  }

  get isGuest() { return !this.supabase?.signedIn; }
  get email() { return this.supabase?.user?.email ?? null; }
  get credits() { return this.data.credits; }
  get equippedSkin() { return this.data.equippedSkin; }

  owns(skinId) { return this.data.ownedSkins.includes(skinId); }

  // -------------------------------------------------------------- load / save

  /** Load guest data, then overlay the account's if one is signed in. */
  async load() {
    this.data = this._readLocal();
    if (this.supabase?.signedIn) await this._pullCloud();
    this.onChange?.(this.data);
    return this.data;
  }

  _readLocal() {
    try {
      return normalise(JSON.parse(this.storage.getItem(GUEST_KEY) ?? 'null'));
    } catch {
      return emptyProfile();
    }
  }

  async _pullCloud() {
    try {
      const row = await this.supabase.fetchProfile();
      const cloud = fromRow(row);
      // No row yet means this account has never saved: the local profile
      // becomes its starting point rather than being wiped.
      this.data = cloud ? merge(this.data, cloud) : this.data;
      await this._pushCloud();
    } catch (err) {
      // Offline or a bad row must not block play. The local copy stands and
      // the next save retries.
      this.error = err.message;
    }
  }

  async _pushCloud() {
    if (!this.supabase?.signedIn) return;
    try {
      await this.supabase.saveProfile(toRow(this.data));
      this.error = null;
    } catch (err) {
      this.error = err.message;
    }
  }

  /**
   * Persist.
   *
   * Local writes are immediate -- they are cheap and losing them is the worst
   * outcome. The cloud write is debounced, because equipping skins in the shop
   * would otherwise fire a request per click.
   */
  save({ immediate = false } = {}) {
    this.storage.setItem(GUEST_KEY, JSON.stringify(this.data));
    this.onChange?.(this.data);

    if (!this.supabase?.signedIn) return;
    if (immediate) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
      return this._pushCloud();
    }
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._pushCloud();
    }, 1500);
  }

  // ------------------------------------------------------------------ account

  /** Adopt a newly signed-in account, keeping guest progress. */
  async onSignIn() {
    await this._pullCloud();
    this.save({ immediate: true });
    this.onChange?.(this.data);
  }

  /** Drop back to the guest profile that is still in local storage. */
  onSignOut() {
    this.data = this._readLocal();
    this.onChange?.(this.data);
  }

  // ------------------------------------------------------------------ gameplay

  /** Bank a finished run. Returns the credits it paid out. */
  recordRun({ score = 0, wave = 0, kills = 0 } = {}) {
    const earned = Math.max(0, Math.floor(score * CREDITS_PER_SCORE));
    this.data.credits += earned;
    this.data.runs += 1;
    this.data.totalKills += kills;
    this.data.bestScore = Math.max(this.data.bestScore, score);
    this.data.bestWave = Math.max(this.data.bestWave, wave);
    this.save({ immediate: true });
    return earned;
  }

  /**
   * Buy a skin.
   * @returns {{ok: boolean, reason?: string}}
   */
  buy(skinId) {
    const skin = SKIN_BY_ID.get(skinId);
    if (!skin) return { ok: false, reason: 'NO SUCH SKIN' };
    if (this.owns(skinId)) return { ok: false, reason: 'ALREADY OWNED' };
    if (this.data.credits < skin.price) {
      return { ok: false, reason: `NEED ${skin.price - this.data.credits} MORE` };
    }

    this.data.credits -= skin.price;
    this.data.ownedSkins.push(skinId);
    this.data.equippedSkin = skinId;    // buying it means wanting to wear it
    this.save({ immediate: true });
    return { ok: true };
  }

  equip(skinId) {
    if (!this.owns(skinId)) return { ok: false, reason: 'NOT OWNED' };
    this.data.equippedSkin = skinId;
    this.save();
    return { ok: true };
  }
}

function defaultStorage() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem('__probe__');
      return localStorage;
    }
  } catch { /* fall through */ }

  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
}
