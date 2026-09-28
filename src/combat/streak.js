// Kill streak and the buffs it grants.
//
// The streak decays on a short timer, so it rewards sustained aggression rather
// than a total kill count. It is deliberately frozen between waves: losing a
// streak to the spawn lull would punish the player for the game's pacing rather
// than for anything they did.

export const STREAK_WINDOW = 4;   // seconds without a kill before it resets

/**
 * Buff tiers, lowest first. The highest tier whose `at` is met applies -- the
 * values are absolute multipliers, not cumulative, so tuning one tier cannot
 * silently inflate the ones above it.
 */
export const STREAK_TIERS = [
  { at: 0,  name: '',            damage: 1.0,  fireRate: 1.0,  speed: 1.0,  reload: 1.0,  regen: 1.0, color: '#e8f0f2' },
  { at: 3,  name: 'HOT',         damage: 1.15, fireRate: 1.05, speed: 1.06, reload: 1.05, regen: 1.2, color: '#ffd98a' },
  { at: 6,  name: 'BLAZING',     damage: 1.3,  fireRate: 1.15, speed: 1.12, reload: 1.15, regen: 1.5, color: '#ffb04d' },
  { at: 10, name: 'RAMPAGE',     damage: 1.5,  fireRate: 1.28, speed: 1.18, reload: 1.3,  regen: 2.0, color: '#ff7a3d' },
  { at: 15, name: 'UNSTOPPABLE', damage: 1.8,  fireRate: 1.45, speed: 1.25, reload: 1.5,  regen: 2.6, color: '#ff4d4d' },
  { at: 22, name: 'GODLIKE',     damage: 2.2,  fireRate: 1.6,  speed: 1.32, reload: 1.7,  regen: 3.2, color: '#c04ae0' },
];

export class KillStreak {
  constructor() {
    this.count = 0;
    this.timer = 0;
    this.frozen = true;   // held until the first kill of a wave
    this.best = 0;
    this.onTierChange = null;
    this._tierIndex = 0;
  }

  reset() {
    this.count = 0;
    this.timer = 0;
    this.frozen = true;
    this.best = 0;
    this._tierIndex = 0;
  }

  /** The active buff tier. */
  get tier() { return STREAK_TIERS[this._tierIndex]; }

  /** Fraction of the decay window remaining, for the HUD meter. */
  get fraction() {
    if (this.count === 0) return 0;
    if (this.frozen) return 1;
    return Math.max(0, Math.min(1, this.timer / STREAK_WINDOW));
  }

  addKill() {
    this.count += 1;
    this.best = Math.max(this.best, this.count);
    this.timer = STREAK_WINDOW;
    this.frozen = false;   // the wave's first kill starts the clock
    this._refreshTier();
  }

  /**
   * Freeze the decay timer, e.g. between waves and before a wave's first kill.
   * A frozen streak neither decays nor expires.
   */
  setFrozen(frozen) {
    this.frozen = frozen;
    if (frozen) this.timer = STREAK_WINDOW;
  }

  update(dt) {
    if (this.count === 0 || this.frozen) return;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0;
      this.count = 0;
      this._refreshTier();
    }
  }

  _refreshTier() {
    let idx = 0;
    for (let i = 0; i < STREAK_TIERS.length; i++) {
      if (this.count >= STREAK_TIERS[i].at) idx = i;
    }
    if (idx !== this._tierIndex) {
      const previous = this._tierIndex;
      this._tierIndex = idx;
      // Only announce climbing, not the drop back to nothing.
      if (idx > previous) this.onTierChange?.(STREAK_TIERS[idx], this.count);
    }
  }
}
