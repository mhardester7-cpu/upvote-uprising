// Reload hardening for live-browser edge cases.
//
// The normal WeaponSystem state machine is intentionally small and deterministic,
// but a live player reported getting trapped in a reload forever. A reload has
// only two ways to look infinite: its timer stops being a finite countdown, or
// the reload completes without transferring a round and auto-reload immediately
// starts the same empty state again. Both are cheap invariants to enforce here.

import { WeaponSystem } from '../combat/weapons.js';

/** No current weapon legitimately takes more than 4.5s to reload. */
export const MAX_SAFE_RELOAD_SECONDS = 10;
export const MIN_SAFE_RELOAD_SECONDS = 0.04;

let installed = false;

function finitePositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeDuration(system, weapon) {
  const base = finitePositive(weapon?.def?.reloadTime, 1);
  // A zero/NaN multiplier used to turn into either a 20x-slow reload or NaN.
  // Neither is a useful failure mode. Neutral speed is the safe fallback.
  const scale = finitePositive(system.reloadScale, 1);
  return Math.min(
    MAX_SAFE_RELOAD_SECONDS,
    Math.max(MIN_SAFE_RELOAD_SECONDS, base / Math.max(0.05, scale)),
  );
}

function snapshot(weapon) {
  return {
    weapon,
    ammo: Number(weapon?.ammo),
    reserve: Number(weapon?.reserve),
  };
}

function madeProgress(before) {
  if (!before?.weapon) return true;
  const ammo = Number(before.weapon.ammo);
  const reserve = Number(before.weapon.reserve);
  return (Number.isFinite(ammo) && Number.isFinite(before.ammo) && ammo > before.ammo)
    || (Number.isFinite(reserve) && Number.isFinite(before.reserve) && reserve < before.reserve);
}

/** Last-resort transfer if a completed reload somehow made no ammo progress. */
function finishFiniteReload(before) {
  const weapon = before?.weapon;
  if (!weapon || weapon.def?.noAmmo) return false;
  const ammo = Number(weapon.ammo);
  const reserve = Number(weapon.reserve);
  const capacity = Number(weapon.magSize);
  if (![ammo, reserve, capacity].every(Number.isFinite)) return false;
  const need = Math.max(0, capacity - ammo);
  const take = Math.min(need, Math.max(0, reserve));
  if (!(take > 0)) return false;
  weapon.ammo = ammo + take;
  weapon.reserve = reserve - take;
  weapon.bloom = 0;
  return true;
}

/**
 * Install once. The wrapper deliberately leaves normal reloads untouched and
 * only intervenes when an invariant is broken.
 */
export function installReloadSafety() {
  if (installed) return;
  installed = true;

  const proto = WeaponSystem.prototype;
  const startReload = proto.startReload;
  const update = proto.update;
  const switchTo = proto.switchTo;
  const reset = proto.reset;
  const applyLoadout = proto.applyLoadout;

  proto.startReload = function safeStartReload(...args) {
    const weapon = this.current;

    // If the previous attempt completed without moving ammo, do not immediately
    // enter the exact same animation again while the fire button is still held.
    // Releasing fire clears this latch in update(), so the player is never
    // permanently locked out of trying again.
    const blocked = this._reloadRetryBlock;
    if (blocked?.weapon === weapon
      && blocked.ammo === Number(weapon?.ammo)
      && blocked.reserve === Number(weapon?.reserve)) return false;
    this._reloadRetryBlock = null;

    const ok = startReload.apply(this, args);
    if (!ok) return false;

    if (!Number.isFinite(this.reloadTimer)
      || this.reloadTimer <= 0
      || this.reloadTimer > MAX_SAFE_RELOAD_SECONDS) {
      this.reloadTimer = safeDuration(this, weapon);
      this.reloadTotal = this.reloadTimer;
    }

    this._reloadSafety = {
      ...snapshot(weapon),
      elapsed: 0,
    };
    return true;
  };

  proto.update = function safeReloadUpdate(dt, player, wantFire, firePressed, rng) {
    // A release is the natural reset edge for any failed auto-reload attempt.
    if (!wantFire) this._reloadRetryBlock = null;

    if (this._reloadSafety) {
      // A corrupted/non-finite timer is the only state that can literally stay
      // reloading forever. Bring it back to a bounded countdown immediately.
      if (!Number.isFinite(this.reloadTimer)
        || this.reloadTimer > MAX_SAFE_RELOAD_SECONDS) {
        this.reloadTimer = safeDuration(this, this._reloadSafety.weapon ?? this.current);
        this.reloadTotal = this.reloadTimer;
      }

      const step = Number(dt);
      if (Number.isFinite(step) && step > 0) this._reloadSafety.elapsed += step;
      if (this._reloadSafety.elapsed > MAX_SAFE_RELOAD_SECONDS + 0.25) {
        // Force the normal WeaponSystem completion path on this tick. This keeps
        // its sound/callback behavior intact instead of inventing a second end.
        this.reloadTimer = Math.min(
          Number.isFinite(this.reloadTimer) ? this.reloadTimer : MIN_SAFE_RELOAD_SECONDS,
          MIN_SAFE_RELOAD_SECONDS,
        );
      }
    }

    const before = this._reloadSafety;
    const wasReloading = this.isReloading;
    const result = update.call(this, dt, player, wantFire, firePressed, rng);

    if (wasReloading && !this.isReloading && before) {
      // A valid reload always increases ammo or decreases reserve. If neither
      // happened, repair finite ammo state once. If even that is impossible,
      // block automatic re-entry until the trigger is released instead of
      // replaying the same reload animation forever.
      if (!madeProgress(before) && !finishFiniteReload(before)) {
        this._reloadRetryBlock = snapshot(before.weapon);
      }
      this._reloadSafety = null;
    }

    return result;
  };

  proto.switchTo = function safeSwitchTo(...args) {
    const result = switchTo.apply(this, args);
    if (result) {
      this._reloadSafety = null;
      this._reloadRetryBlock = null;
    }
    return result;
  };

  proto.reset = function safeReset(...args) {
    const result = reset.apply(this, args);
    this._reloadSafety = null;
    this._reloadRetryBlock = null;
    return result;
  };

  proto.applyLoadout = function safeApplyLoadout(...args) {
    const result = applyLoadout.apply(this, args);
    this._reloadSafety = null;
    this._reloadRetryBlock = null;
    return result;
  };
}
