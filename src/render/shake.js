// Camera shake, driven by trauma rather than by explicit shake events.
//
// The trauma model (Squirrel Eiserloh's, widely used) is: callers add trauma,
// trauma decays linearly, and the offset applied each frame is proportional to
// trauma *squared*. Squaring is what makes it feel right -- a small knock reads
// as a twitch rather than a rattle, and only a genuinely big hit shakes the
// screen hard, so the loud moments stay loud.
//
// Offsets come from smooth noise sampled along separate lines rather than from
// Math.random() per frame. Random per frame is high-frequency jitter, which
// reads as a broken display; smooth noise reads as a camera being pushed.
//
// This is kept apart from the weapon's recoil punch on purpose. Recoil is
// directional and the player should be able to learn and compensate for it;
// shake is undirected and must never feel like something to fight.

/** Trauma decays to nothing in roughly this many seconds from full. */
const DECAY_PER_SECOND = 1.35;

/** Ceilings, in radians and metres. */
const MAX_PITCH = 0.075;
const MAX_YAW = 0.075;
const MAX_ROLL = 0.11;
const MAX_OFFSET = 0.16;

/**
 * Cheap smooth noise: a sum of two sines at incommensurate frequencies. Not
 * statistically noise, but it never repeats on a timescale anyone will notice
 * and it costs a fraction of a real noise lookup.
 */
function wobble(t, seed) {
  return Math.sin(t * 13.7 + seed * 4.1) * 0.6
       + Math.sin(t * 31.3 + seed * 9.7) * 0.4;
}

export class Shake {
  constructor() {
    this.trauma = 0;
    this.time = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.roll = 0;
    this.offsetX = 0;
    this.offsetY = 0;
  }

  /**
   * Add trauma. Additive and clamped, so several hits in one frame stack into
   * one bigger shake instead of the loudest simply winning.
   */
  add(amount) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt) {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - DECAY_PER_SECOND * dt);

    const k = this.trauma * this.trauma;
    if (k <= 0) {
      this.pitch = this.yaw = this.roll = 0;
      this.offsetX = this.offsetY = 0;
      return;
    }

    const t = this.time;
    this.pitch = MAX_PITCH * k * wobble(t, 1);
    this.yaw = MAX_YAW * k * wobble(t, 2);
    this.roll = MAX_ROLL * k * wobble(t, 3);
    this.offsetX = MAX_OFFSET * k * wobble(t, 4);
    this.offsetY = MAX_OFFSET * k * wobble(t, 5);
  }

  reset() {
    this.trauma = 0;
    this.pitch = this.yaw = this.roll = 0;
    this.offsetX = this.offsetY = 0;
  }
}

/**
 * Trauma per event. Tuned as a set: the numbers only mean anything relative to
 * each other, and they are gathered here so the mix can be judged in one place
 * rather than hunted through the code.
 */
export const TRAUMA = {
  shot: 0.045,          // your own gun, on top of the recoil punch
  shotHeavy: 0.11,      // shotgun and sniper
  hurt: 0.30,           // taking a hit
  explosionNear: 0.75,
  explosionFar: 0.22,
  kill: 0.05,
  bossKill: 0.9,
  bossSlam: 0.45,
};
