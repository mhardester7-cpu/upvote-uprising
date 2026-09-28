// Potions: timed perks pulled out of chests.
//
// Every perk is expressed as a plain multiplier (or a flag) that some existing
// system already reads -- speed, reload, fire rate, spread, damage. Nothing here
// mutates a weapon or player value directly, for the same reason the kill-streak
// buffs do not: a buff that edits the data table can never be cleanly undone
// when it expires.
//
// Potions multiply with the streak buffs rather than replacing them, so drinking
// during a streak is the peak of a run instead of a sidegrade.

/**
 * Perk table. `duration` is seconds. Anything omitted is neutral (1x / false).
 *
 * Durations are tuned against the effect's swing: the ones that trivialise a
 * fight (ENDLESS CLIP, STRENGTH) run short, the quality-of-life ones run long.
 */
export const POTIONS = [
  {
    id: 'swift', name: 'SWIFTNESS', color: 0x46d8ff, duration: 25,
    speed: 1.5, blurb: 'MOVE +50%',
  },
  {
    id: 'quick', name: 'QUICK HANDS', color: 0xffc94d, duration: 30,
    reload: 2.0, blurb: 'RELOAD 2x',
  },
  {
    id: 'rapid', name: 'RAPID FIRE', color: 0xff7a3d, duration: 20,
    fireRate: 1.45, blurb: 'FIRE RATE +45%',
  },
  {
    id: 'strength', name: 'STRENGTH', color: 0xff4d6a, duration: 20,
    damage: 1.6, blurb: 'DAMAGE +60%',
  },
  {
    id: 'iron', name: 'IRONSKIN', color: 0x9fb4c7, duration: 28,
    resist: 0.45, blurb: 'DAMAGE TAKEN -55%',
  },
  {
    id: 'regen', name: 'REGENERATION', color: 0x6fe08a, duration: 20,
    regen: 4.0, blurb: 'RAPID HEALING',
  },
  {
    id: 'leap', name: 'LEAPING', color: 0xb27dff, duration: 30,
    jump: 1.45, noFall: true, blurb: 'HIGH JUMP / NO FALL DMG',
  },
  {
    id: 'endless', name: 'ENDLESS CLIP', color: 0xffe14d, duration: 14,
    infiniteAmmo: true, blurb: 'AMMO DOES NOT DRAIN',
  },
  {
    id: 'steady', name: 'STEADY AIM', color: 0x7ad4ff, duration: 25,
    spread: 0.35, blurb: 'SPREAD -65%',
  },
  {
    id: 'vamp', name: 'VAMPIRISM', color: 0xd0392f, duration: 22,
    lifesteal: 0.18, blurb: 'HEAL 18% OF DAMAGE DEALT',
  },
];

export const POTION_BY_ID = new Map(POTIONS.map((p) => [p.id, p]));

/** Everything a potion can change, at its no-potion value. */
const NEUTRAL = {
  speed: 1, reload: 1, fireRate: 1, damage: 1, resist: 1, regen: 1,
  jump: 1, spread: 1, lifesteal: 0, infiniteAmmo: false, noFall: false,
};

const MULTIPLIED = ['speed', 'reload', 'fireRate', 'damage', 'resist', 'regen', 'jump', 'spread'];
const SUMMED = ['lifesteal'];
const FLAGS = ['infiniteAmmo', 'noFall'];

/** Pick a random potion definition. */
export function randomPotion(rng = Math.random) {
  return POTIONS[Math.floor(rng() * POTIONS.length)];
}

/**
 * Tracks which perks are running and folds them into one set of multipliers.
 *
 * The fold is cached in `mods` and only recomputed when the active set changes,
 * because the game reads these values several times per tick.
 */
export class PotionEffects {
  constructor() {
    this.active = new Map();      // id -> { def, time }
    this.mods = { ...NEUTRAL };
    this.onExpire = null;
  }

  /**
   * Drink a potion. Re-drinking one that is already running refreshes the
   * timer rather than stacking the perk -- two SWIFTNESS bottles should mean a
   * longer sprint, not a player moving at twice sprint speed.
   */
  apply(def) {
    const current = this.active.get(def.id);
    this.active.set(def.id, {
      def,
      time: Math.max(def.duration, current ? current.time : 0),
    });
    this._recompute();
    return def;
  }

  update(dt) {
    if (this.active.size === 0) return;
    let changed = false;
    for (const [id, entry] of this.active) {
      entry.time -= dt;
      if (entry.time > 0) continue;
      this.active.delete(id);
      this.onExpire?.(entry.def);
      changed = true;
    }
    if (changed) this._recompute();
  }

  clear() {
    this.active.clear();
    this._recompute();
  }

  has(id) { return this.active.has(id); }

  /** Active perks, soonest to expire first -- the order the HUD wants. */
  get list() {
    return [...this.active.values()].sort((a, b) => a.time - b.time);
  }

  _recompute() {
    const m = this.mods;
    Object.assign(m, NEUTRAL);
    for (const { def } of this.active.values()) {
      for (const k of MULTIPLIED) if (def[k] !== undefined) m[k] *= def[k];
      for (const k of SUMMED) if (def[k] !== undefined) m[k] += def[k];
      for (const k of FLAGS) if (def[k]) m[k] = true;
    }
  }
}
