// Floating damage numbers.
//
// These exist to make weapon upgrades legible. Once damage can be bought, the
// player needs to see that the purchase changed something, and a number that
// climbs off a zombie's head is the most direct way to say so.
//
// Implementation notes worth keeping:
//
//   Elements are pooled. Creating and destroying DOM nodes during a firefight
//   is exactly the kind of churn that produces stutter on the frames that can
//   least afford it, so a fixed pool is allocated once and reused.
//
//   Positions are written as a transform, never as left/top. Transforms are
//   composited and do not trigger layout; left/top on twenty elements a second
//   would reflow the page repeatedly.
//
//   Damage accumulates per target for a short window rather than spawning one
//   number per pellet. A shotgun would otherwise throw nine numbers at once and
//   read as noise instead of information.

/** Pool size. Beyond this, the oldest number is recycled early. */
const POOL = 28;

/** How long a number lives, and how far it drifts upward over that life. */
const LIFETIME = 0.85;
const RISE = 58;

/** Hits on the same target inside this window merge into one number. */
const MERGE_WINDOW = 0.12;

export class DamageNumbers {
  constructor(container) {
    this.root = container;
    this.pool = [];
    this.active = [];

    for (let i = 0; i < POOL; i++) {
      const el = document.createElement('div');
      el.className = 'dmgnum';
      el.style.opacity = '0';
      this.root.appendChild(el);
      this.pool.push(el);
    }

    /** targetId -> the live entry still inside its merge window. */
    this._merging = new Map();
  }

  /**
   * Record damage on a target.
   *
   * @param targetId something stable per enemy, so pellets can be merged
   * @param amount   damage dealt
   * @param kind     'hit' | 'headshot' | 'kill' | 'weak'
   */
  add(targetId, amount, kind = 'hit') {
    const existing = this._merging.get(targetId);
    if (existing && existing.age < MERGE_WINDOW) {
      existing.amount += amount;
      // The louder classification wins: one headshot pellet in a spread makes
      // the whole cluster a headshot, which is what the player felt happen.
      if (kind !== 'hit') existing.kind = kind;
      existing.dirty = true;
      return;
    }

    const el = this.pool.pop() || this._recycleOldest();
    if (!el) return;

    const entry = {
      el, amount, kind, age: 0, targetId,
      x: 0, y: 0, dirty: true,
      // A little horizontal scatter so simultaneous numbers on a crowd do not
      // stack into an unreadable column.
      jitter: (Math.random() - 0.5) * 26,
    };
    this.active.push(entry);
    this._merging.set(targetId, entry);
  }

  _recycleOldest() {
    if (this.active.length === 0) return null;
    let oldest = 0;
    for (let i = 1; i < this.active.length; i++) {
      if (this.active[i].age > this.active[oldest].age) oldest = i;
    }
    const entry = this.active.splice(oldest, 1)[0];
    if (this._merging.get(entry.targetId) === entry) this._merging.delete(entry.targetId);
    return entry.el;
  }

  /**
   * Advance and reposition. `project` maps a world point to screen space and
   * returns null when the point should not be drawn.
   *
   * @param positions Map of targetId -> {x,y,z}, so numbers track a moving
   *   enemy instead of hanging in the air where it used to be.
   */
  update(dt, positions, project) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const e = this.active[i];
      e.age += dt;

      if (e.age >= LIFETIME) {
        e.el.style.opacity = '0';
        this.pool.push(e.el);
        this.active.splice(i, 1);
        if (this._merging.get(e.targetId) === e) this._merging.delete(e.targetId);
        continue;
      }

      const t = e.age / LIFETIME;

      if (e.dirty) {
        e.dirty = false;
        e.el.textContent = Math.max(1, Math.round(e.amount));
        e.el.className = 'dmgnum ' + e.kind;
      }

      const world = positions.get(e.targetId);
      if (world) {
        const p = project(world.x, world.y, world.z);
        if (p) { e.x = p.x; e.y = p.y; }
      }
      // If the target has gone (killed, despawned), the number keeps the last
      // position it had and finishes its rise there rather than vanishing.

      // Ease-out rise, so it leaps away from the hit and then settles.
      const rise = RISE * (1 - (1 - t) * (1 - t));
      // Fade only over the back half; fading from the first frame makes the
      // number hard to read at exactly the moment it matters.
      const alpha = t < 0.5 ? 1 : 1 - (t - 0.5) * 2;
      const scale = e.kind === 'hit' ? 1 : 1.25;
      const pop = 1 + Math.max(0, 0.35 - t) * 1.2;

      e.el.style.opacity = alpha.toFixed(3);
      e.el.style.transform =
        `translate(${(e.x + e.jitter).toFixed(1)}px, ${(e.y - rise).toFixed(1)}px) ` +
        `translate(-50%, -50%) scale(${(scale * pop).toFixed(3)})`;
    }
  }

  clear() {
    for (const e of this.active) {
      e.el.style.opacity = '0';
      this.pool.push(e.el);
    }
    this.active.length = 0;
    this._merging.clear();
  }
}
