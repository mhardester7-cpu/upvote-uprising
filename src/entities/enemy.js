// Enemies: humanoid mobs that path toward the player and melee on contact.
//
// Each enemy exposes two hitboxes -- body and head -- in world space. combat.js
// traces against those, which is what makes headshots a real mechanic rather
// than a random multiplier.

import { rayAABB } from '../world/raycast.js';

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const smooth01 = (n) => {
  const t = clamp01(n);
  return t * t * (3 - 2 * t);
};

/**
 * Window-vault trajectory at normalised time `t`.
 *
 * The old curve moved immediately and rolled an upright body through the hole.
 * This one reserves readable beats for a planted load-up and a two-foot landing,
 * with the actual traverse concentrated between them. `travel` drives the
 * horizontal interpolation and `lift` is added to the line between floor
 * heights. Kept pure so the renderer/tests and authoritative sim agree on what
 * each phase means.
 */
export function sampleWindowVault(t) {
  const p = clamp01(t);
  let travel;
  if (p < 0.18) {
    travel = 0.025 * smooth01(p / 0.18);
  } else if (p < 0.82) {
    travel = 0.025 + 0.95 * smooth01((p - 0.18) / 0.64);
  } else {
    travel = 0.975 + 0.025 * smooth01((p - 0.82) / 0.18);
  }

  const airborne = clamp01((p - 0.14) / 0.72);
  const lift = (p <= 0.14 || p >= 0.86) ? 0 : Math.sin(Math.PI * airborne) * 1.14;
  return { travel, lift };
}

export const ENEMY_TYPES = {
  // Destination-only threats. These use the installed animated zombie asset
  // through charactermodels.js, but retain distinct combat tuning and colours.
  cinder_stalker: {
    id: 'cinder_stalker', label: 'CINDER STALKER',
    health: 135, speed: 1.5, width: 0.66, height: 1.9,
    damage: 16, attackRange: 2.15, attackCooldown: 0.82, score: 240,
    bodyColor: 0xb8462d, headColor: 0xe77a43, accentColor: 0x32120d,
  },
  nyx_wraith: {
    id: 'nyx_wraith', label: 'NYX WRAITH',
    health: 105, speed: 4.0, width: 0.58, height: 1.78,
    damage: 12, attackRange: 2.0, attackCooldown: 0.7, score: 260,
    bodyColor: 0x657bd0, headColor: 0xb8d8ff, accentColor: 0x151b43,
    leaps: true, leapCooldown: 3.5, leapRange: 15, leapMinRange: 5,
    leapSpeed: 11.5, leapRise: 7.6,
  },
  grunt: {
    id: 'grunt',
    label: 'GRUNT',
    health: 100,
    // The walk animation is a shamble, so the baseline horde must be one too.
    speed: 1.4,
    width: 0.62,
    height: 1.8,
    damage: 12,
    attackRange: 2.0,
    attackCooldown: 0.9,
    score: 100,
    bodyColor: 0x4e9a4a,
    headColor: 0x3f7d3c,
    accentColor: 0x1d2b1c,
  },
  runner: {
    id: 'runner',
    label: 'BABY ZOMBIE',
    // Small and fast -- and the best source of airstrike drops.
    baby: true,
    health: 55,
    speed: 4.0,
    width: 0.5,
    height: 1.5,
    damage: 8,
    attackRange: 1.8,
    attackCooldown: 0.6,
    score: 150,
    bodyColor: 0xc4703a,
    headColor: 0xa85a2c,
    accentColor: 0x33170c,
  },
  clippy: {
    id: 'clippy',
    label: 'CLIPPY',
    // A milestone-wave mini-boss. Tough enough to pull focus away from the
    // horde, but small enough to keep following the player through the level.
    // Unlike the Abomination it has no armour puzzle or summoned adds: the
    // readable paperclip silhouette and its relentless hop are the whole bit.
    miniboss: true,
    health: 650,
    speed: 2.25,
    width: 1.02,
    height: 2.2,
    damage: 24,
    attackRange: 2.35,
    attackCooldown: 1.05,
    score: 1250,
    bodyColor: 0x747873,
    headColor: 0xf5f4e9,
    accentColor: 0x171917,
  },
  gunner: {
    id: 'gunner',
    label: 'GUNNER',
    health: 80,
    speed: 1.15,
    width: 0.62,
    height: 1.8,
    damage: 9,
    attackRange: 2.0,
    attackCooldown: 1.0,
    score: 200,
    bodyColor: 0x4a6f8a,
    headColor: 0x3c5c74,
    accentColor: 0x17242e,
    // --- pistol ---
    ranged: true,
    rangedDamage: 7,
    rangedRange: 34,
    rangedCooldown: 1.5,
    rangedWarmup: 0.55,        // telegraph before the shot actually goes off
    // Deliberately terrible marksmanship: an 11 degree cone means most shots
    // miss at range, so gunners pressure the player rather than delete them.
    rangedSpread: 11 * Math.PI / 180,
    // They hang back instead of closing to melee.
    preferredRange: 13,
    armed: true,
  },
  spitter: {
    id: 'spitter',
    label: 'SPITTER',
    health: 90,
    speed: 1.5,
    width: 0.60,
    height: 1.75,
    // Weak on contact -- the threat is what it leaves behind.
    damage: 6,
    poisonDamage: 24,
    poisonDuration: 3,
    attackRange: 2.1,
    attackCooldown: 1.4,
    score: 220,
    bodyColor: 0x6f9c2f,
    headColor: 0x86b83a,
    accentColor: 0x24330f,
  },
  exploder: {
    id: 'exploder',
    label: 'BLOATER',
    // Fast, fragile, and lethal if you let it reach you. The counter is to
    // kill it early -- which is also what makes it dangerous in a pack, since
    // a detonation damages whatever else is standing nearby.
    health: 70,
    speed: 3.4,
    width: 0.72,
    height: 1.75,
    damage: 0,               // all of its damage is the detonation
    attackRange: 2.4,
    attackCooldown: 99,
    score: 260,
    bodyColor: 0x9ba83c,
    headColor: 0xb7c748,
    accentColor: 0x2e3410,
    explodes: true,
    fuse: 0.75,              // long enough to sprint out of, short enough to fear
    explodeRadius: 5.5,
    explodeDamage: 62,
  },
  shielded: {
    id: 'shielded',
    label: 'BULWARK',
    // Carries a riot shield. Shots into the frontal arc are nearly useless, so
    // it has to be flanked -- which is awkward alone and natural in co-op,
    // where one player holds its attention while another walks around it.
    health: 150,
    speed: 1.1,
    width: 0.8,
    height: 1.95,
    damage: 18,
    attackRange: 2.2,
    attackCooldown: 1.1,
    score: 280,
    bodyColor: 0x8a8f99,
    headColor: 0x6f747d,
    accentColor: 0x2b2f36,
    shield: true,
    shieldArc: Math.PI * 0.62,   // total width of the protected cone
    shieldReduction: 0.12,       // damage multiplier inside it
  },
  jumper: {
    id: 'jumper',
    label: 'LEAPER',
    // Closes distance in bounds rather than a run. Sniping it mid-air is the
    // most satisfying shot in the game, so the leap is telegraphed and slow
    // enough to punish.
    health: 65,
    speed: 1.5,
    width: 0.55,
    height: 1.6,
    damage: 14,
    attackRange: 1.9,
    attackCooldown: 0.8,
    score: 240,
    bodyColor: 0xb04ae0,
    headColor: 0x8f36bd,
    accentColor: 0x2a0f38,
    leaps: true,
    leapCooldown: 3.2,
    leapRange: 16,        // won't bother from further out than this
    leapMinRange: 5,      // nor from inside melee reach
    leapSpeed: 12,
    leapRise: 8.5,
  },
  boss: {
    id: 'boss',
    label: 'ABOMINATION',
    // The wave-five-multiple boss. Slow, armoured except for a glowing core on
    // its back -- which is the whole fight: keep moving, get behind it, empty
    // everything into the weak point.
    //
    // It used to be 4.4m tall and 2.0m wide, and that made the fight
    // impossible rather than hard: a doorway is 2.8 x 2.9 and the clear height
    // under a storey is 3.1, so it could not get through a door, up a stair or
    // under a ceiling. A boss that cannot follow you indoors is a boss you walk
    // away from. These are the numbers the doorways were sized for -- see
    // DOOR_W/DOOR_H in complex.js -- with headroom left over for the step-up it
    // takes in stride. It is still comfortably the biggest thing on the map:
    // taller than a brute and twice the frontage of a grunt.
    health: 2400,
    speed: 1.3,
    width: 1.3,
    height: 2.7,
    damage: 42,
    attackRange: 4.0,
    attackCooldown: 1.6,
    score: 3000,
    bodyColor: 0x7a2f3a,
    headColor: 0x8f3a46,
    accentColor: 0x1e0d11,
    boss: true,
    armor: 0.35,            // damage multiplier anywhere but the weak point
    weakPointMultiplier: 3.0,
    // Enrage: below this fraction of health it speeds up and hits harder.
    enrageAt: 0.35,
    enrageSpeed: 1.5,
    /**
     * Calls in help as it loses ground, rather than on a clock.
     *
     * Three summons in the whole fight, one as each quarter of its health
     * comes off, three zombies each time. Tying it to damage rather than to a
     * timer makes the adds a consequence of the fight going well: a clock
     * spawns the same help whether you are winning or hiding, which taught
     * players to hide. It also bounds the total -- twelve seconds of stalemate
     * used to mean adds forever.
     */
    summonAt: [0.75, 0.5, 0.25],
    summonCount: 3,
  },
  brute: {
    id: 'brute',
    label: 'BRUTE',
    // 2.5 x 0.95 clears a 2.8 x 2.9 doorway and a 3.1m ceiling, which is the
    // constraint every enemy in this table has to meet: anything that cannot
    // follow you through a door is scenery.
    health: 260,
    speed: 1.0,
    width: 0.95,
    height: 2.5,
    damage: 26,
    attackRange: 2.5,
    attackCooldown: 1.3,
    score: 300,
    bodyColor: 0x6b4b8a,
    headColor: 0x553a70,
    accentColor: 0x201430,
  },
};

const GRAVITY = 26;
const JUMP_SPEED = 7.6;
/**
 * How much height a jump actually buys.
 *
 * The arc peaks at JUMP_SPEED^2 / 2*GRAVITY, about 1.1m, and the step-up check
 * runs against the rising body, so a jump reaches roughly a step-up above its
 * own apex. Anything higher than this is not a ledge, it is a wall, and trying
 * to hop it is how a zombie ends up standing on a filing cabinet.
 */
const JUMP_REACH = 2.0;
/** Horizontal step-up, taken in stride: a stair riser is well inside this. */
const STEP = 1.1;

let NEXT_ID = 1;

export class Enemy {
  constructor(type, world) {
    this.id = NEXT_ID++;
    this.type = ENEMY_TYPES[type];
    this.world = world;
    this.pos = { x: 0, y: 0, z: 0 };      // feet position
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.health = this.type.health;
    this.maxHealth = this.type.health;
    this.alive = true;
    this.onGround = false;
    this.attackTimer = 0;
    this.hitFlash = 0;
    this.walkPhase = Math.random() * Math.PI * 2;
    // Stuck detection anchor: where this enemy last made real ground. The
    // timer only accrues while the enemy stays near the anchor, so it fires
    // for mobs wedged in terrain -- and never for one chasing a player who is
    // simply running away, which under the old closing-distance test looked
    // to the player like enemies despawning behind them and re-appearing at
    // their heels.
    this._anchorX = 0;
    this._anchorZ = 0;
    this.stuckTimer = 0;
    /**
     * Seconds spent with the body's centre line inside solid geometry.
     *
     * Separate from stuckTimer because it is a different failure: stuck means
     * "cannot make progress", embedded means "is somewhere no body should be"
     * -- wedged between two colliders, or shoved into a wall by two resolvers
     * disagreeing. It accrues even when the player is close enough to hit,
     * because an enemy inside a wall swinging at you is worse than one that is
     * merely lost.
     */
    this.embedTimer = 0;
    this.deathTimer = 0;
    this.group = null;

    // Navigation commitments, both owned by the sim rather than by this class:
    // the stair flight this body is partway up, and the boarded window it is
    // coming in through. They exist here so they survive a target switch --
    // abandoning a climb because a different player got closer is how a zombie
    // ends up walking off a mezzanine.
    this.climb = null;
    this.breach = null;
    /**
     * A short, collision-free move through an opened ground-floor window.
     *
     * This used to be an instant relocate from one side of the wall to the
     * other. Apart from looking like a flash, that put the body through the
     * sill and the header on the same frame. Keeping the transition here makes
     * it part of the authoritative position stream, so co-op sees the same
     * vault rather than interpolating a teleport.
     */
    this.vault = null;

    // Ranged attack state (gunners only).
    this.rangedTimer = Math.random() * 2;
    this.aimTimer = 0;
    this.onShoot = null;   // (fromX,fromY,fromZ, toX,toY,toZ, didHit) -> void

    // Bloaters: -1 means the fuse has not been lit.
    this.fuse = -1;
    this.onDetonate = null;      // (enemy) -> void

    // Leapers.
    this.leapTimer = 1 + Math.random() * 2;
    this.leaping = false;

    // Bosses.
    /** How many of the health-threshold summons have already been spent. */
    this.summonsUsed = 0;
    this.enraged = false;
    this.onSummon = null;        // (enemy, count) -> void

    this._portalCooldown = 0;
  }

  get half() { return this.type.width * 0.5; }
  get height() { return this.type.height; }

  spawn(x, y, z) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.health = this.maxHealth;
    this.alive = true;
    this._anchorX = x;
    this._anchorZ = z;
    this.stuckTimer = 0;
    this.embedTimer = 0;
    this.vault = null;
  }

  /** Move an existing enemy without healing it. Used to rescue stuck mobs. */
  relocate(x, y, z) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this._anchorX = x;
    this._anchorZ = z;
    this.stuckTimer = 0;
    this.embedTimer = 0;
    this.climb = null;
    this.vault = null;
  }

  /** Start a visible traverse through an already-open barrier. */
  beginVault(x, y, z) {
    if (this.vault) return false;
    const distance = Math.hypot(x - this.pos.x, z - this.pos.z);
    if (distance < 0.1) {
      this.relocate(x, y, z);
      return false;
    }

    this.vault = {
      fromX: this.pos.x, fromY: this.pos.y, fromZ: this.pos.z,
      toX: x, toY: y, toZ: z,
      elapsed: 0,
      // Long enough to read as a climb, while still getting a slow horde out
      // of the exposed opening before every body queues in the same frame.
      duration: Math.max(0.68, Math.min(0.92, distance / 4.6)),
      progress: 0,
    };
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.climb = null;
    this.breach = null;
    this.stuckTimer = 0;
    this.embedTimer = 0;
    return true;
  }

  _updateVault(dt) {
    const v = this.vault;
    if (!v) return;

    const oldX = this.pos.x, oldY = this.pos.y, oldZ = this.pos.z;
    v.elapsed = Math.min(v.duration, v.elapsed + dt);
    const t = v.elapsed / v.duration;
    const pose = sampleWindowVault(t);

    this.pos.x = v.fromX + (v.toX - v.fromX) * pose.travel;
    this.pos.z = v.fromZ + (v.toZ - v.fromZ) * pose.travel;
    // The sill is 1.05m high. Feet clear it at the middle of a tucked leap;
    // the renderer bends the limbs/torso instead of rolling a rigid standing
    // body almost ninety degrees through the header.
    this.pos.y = v.fromY + (v.toY - v.fromY) * pose.travel + pose.lift;
    this.yaw = Math.atan2(v.toX - v.fromX, v.toZ - v.fromZ);
    v.progress = t;

    const invDt = 1 / Math.max(dt, 1e-4);
    this.vel.x = (this.pos.x - oldX) * invDt;
    this.vel.y = (this.pos.y - oldY) * invDt;
    this.vel.z = (this.pos.z - oldZ) * invDt;
    this.walkPhase += Math.hypot(this.vel.x, this.vel.z) * dt * 2.2;
    this.onGround = false;

    if (t >= 1) {
      this.relocate(v.toX, v.toY, v.toZ);
      this.onGround = true;
    }
  }

  /** Body hitbox in world space (excludes the head slab). */
  bodyBox() {
    const h = this.half;
    const headH = this._headHeight();
    return {
      minX: this.pos.x - h, maxX: this.pos.x + h,
      minY: this.pos.y, maxY: this.pos.y + this.type.height - headH,
      minZ: this.pos.z - h, maxZ: this.pos.z + h,
    };
  }

  /** Head hitbox -- narrower than the body, so it must actually be aimed at. */
  headBox() {
    const hw = this.type.width * 0.31;
    const headH = this._headHeight();
    const top = this.pos.y + this.type.height;
    return {
      minX: this.pos.x - hw, maxX: this.pos.x + hw,
      minY: top - headH, maxY: top,
      minZ: this.pos.z - hw, maxZ: this.pos.z + hw,
    };
  }

  _headHeight() { return this.type.height * 0.28; }

  center(out = {}) {
    out.x = this.pos.x;
    out.y = this.pos.y + this.type.height * 0.55;
    out.z = this.pos.z;
    return out;
  }

  /**
   * Take a hit.
   *
   * `info.origin` is where the shot came from, which is what makes armour
   * directional: a bulwark's shield only covers the arc it is facing, and a
   * boss's weak point is the core on its back. Splash damage arrives without
   * an origin and is treated as coming from everywhere, so it ignores both --
   * which is the reason a rocket is the honest answer to a shield wall.
   */
  damage(amount, info = null) {
    if (!this.alive) return false;
    if (!Number.isFinite(amount) || amount <= 0) return false;

    const t = this.type;
    const origin = info?.origin;
    if (origin && (t.shield || t.boss)) {
      // Angle between where the enemy is looking and where the shot came from.
      const ax = origin.x - this.pos.x;
      const az = origin.z - this.pos.z;
      const toShooter = Math.atan2(ax, az);
      let d = toShooter - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const fromFront = Math.abs(d);

      if (t.shield && fromFront < t.shieldArc * 0.5) {
        amount *= t.shieldReduction;
      } else if (t.boss) {
        // The core sits on its back, so the arc that pays out is the one the
        // boss is facing away from.
        amount *= fromFront > Math.PI * 0.6 ? t.weakPointMultiplier : t.armor;
      }
    } else if (t.boss && !origin) {
      amount *= t.armor;
    }

    if (!Number.isFinite(amount) || amount <= 0) return false;

    this.health -= amount;
    this.hitFlash = 1;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.deathTimer = 0.5;
      return true; // killed
    }
    return false;
  }

  update(dt, player) {
    this.hitFlash = Math.max(0, this.hitFlash - dt * 5);
    if (this._portalCooldown > 0) this._portalCooldown = Math.max(0, this._portalCooldown - dt);

    // Finish a committed window traverse even if the body is killed halfway
    // through it. Otherwise its feet remain suspended over the sill for the
    // entire corpse lifetime.
    if (this.vault) {
      this._updateVault(dt);
      if (!this.alive) this.deathTimer -= dt;
      return;
    }

    if (!this.alive) {
      this.deathTimer -= dt;
      return;
    }

    if (this.attackTimer > 0) this.attackTimer -= dt;

    const dx = player.pos.x - this.pos.x;
    const dz = player.pos.z - this.pos.z;
    const dy = player.pos.y - this.pos.y;
    const distSq = dx * dx + dz * dz;
    const dist = Math.sqrt(distSq);

    this.yaw = Math.atan2(dx, dz);

    // How close this one wants to get. Gunners hold at their preferred range
    // instead of piling into melee; everything else closes to arm's length.
    // Declared here rather than beside the movement because the stuck check
    // below has to know the difference between a body that cannot move and one
    // that has arrived.
    const stopAt = this.type.ranged ? this.type.preferredRange : this.type.attackRange * 0.75;
    const holding = dist <= stopAt && !(this.type.ranged && dist < stopAt * 0.6);

    // Stuck means *not moving*, not merely not gaining. An enemy that covers
    // real ground -- even ground that takes it no closer, like one chasing a
    // sprinting player or circling a wall -- resets its anchor and is left
    // alone. Nor does one standing exactly where it means to stand: a gunner
    // holding thirteen metres out is doing its job, and counting that as stuck
    // teleported every gunner in the map every six seconds.
    const anchorDist = Math.hypot(this.pos.x - this._anchorX, this.pos.z - this._anchorZ);
    if (anchorDist > 2.5) {
      this._anchorX = this.pos.x;
      this._anchorZ = this.pos.z;
      this.stuckTimer = 0;
    } else if (!holding && dist > this.type.attackRange * 1.5) {
      this.stuckTimer += dt;
    }

    // Wedged inside something is a separate question from making no progress.
    // The probe is a bare line rather than the body's radius on purpose: a
    // zombie pressed against a wall is doing its job, and testing with the real
    // half-width would call every one of those embedded.
    const inSolid = this.world.blocksAt(
      this.pos.x, this.pos.y + 0.15, this.pos.z, 0.02, this.type.height * 0.7);
    this.embedTimer = inSolid ? this.embedTimer + dt : 0;

    // --- boss escalation ---------------------------------------------------
    if (this.type.boss) {
      if (!this.enraged && this.health <= this.maxHealth * this.type.enrageAt) {
        this.enraged = true;
      }
      // One summon per quarter of health lost, and never two at once: a shot
      // big enough to cross two thresholds still calls in one group, and the
      // threshold it skipped is spent rather than banked. Three groups is the
      // whole fight's worth.
      const marks = this.type.summonAt;
      const frac = this.health / this.maxHealth;
      if (this.summonsUsed < marks.length && frac <= marks[this.summonsUsed]) {
        while (this.summonsUsed < marks.length && frac <= marks[this.summonsUsed]) {
          this.summonsUsed++;
        }
        this.onSummon?.(this, this.type.summonCount);
      }
    }

    // --- bloater fuse ------------------------------------------------------
    // Lit by proximity, not by contact, so backing away actually saves you.
    if (this.type.explodes) {
      if (this.fuse < 0 && dist < this.type.attackRange && player.alive) {
        this.fuse = this.type.fuse;
      }
      if (this.fuse >= 0) {
        this.fuse -= dt;
        if (this.fuse <= 0) {
          this.onDetonate?.(this);
          this.alive = false;
          this.health = 0;
          this.deathTimer = 0.35;
          return;
        }
      }
    }

    // --- leap --------------------------------------------------------------
    if (this.type.leaps) {
      if (this.leapTimer > 0) this.leapTimer -= dt;
      if (this.leaping && this.onGround) this.leaping = false;

      const canLeap = this.leapTimer <= 0 && this.onGround && player.alive
        && dist < this.type.leapRange && dist > this.type.leapMinRange;
      if (canLeap) {
        const inv = 1 / (dist || 1);
        this.vel.x = dx * inv * this.type.leapSpeed;
        this.vel.z = dz * inv * this.type.leapSpeed;
        this.vel.y = this.type.leapRise;
        this.onGround = false;
        this.leaping = true;
        this.leapTimer = this.type.leapCooldown + Math.random();
      }
    }

    // --- attack ------------------------------------------------------------
    const reach = this.type.attackRange;
    if (dist < reach && Math.abs(dy) < this.type.height && this.attackTimer <= 0 && player.alive) {
      this.attackTimer = this.type.attackCooldown;
      player.damage(this.type.damage, this);
      // Toxic types leave a dose behind rather than hitting hard up front.
      if (this.type.poisonDamage) {
        player.applyPoison(this.type.poisonDamage, this.type.poisonDuration);
      }
      // Small knockback so the player is pushed out of a melee stack.
      const inv = dist > 0.001 ? 1 / dist : 0;
      player.vel.x += dx * inv * 3.2;
      player.vel.z += dz * inv * 3.2;
      player.vel.y += 1.6;
    }

    // --- ranged attack -----------------------------------------------------
    if (this.type.ranged && player.alive) this._updateRanged(dt, player, dist);

    // --- move --------------------------------------------------------------
    // A leaper in the air keeps the arc it committed to; steering mid-flight
    // would remove the only counterplay the move has.
    if (this.leaping) {
      this.vel.y -= GRAVITY * dt;
      this._integrate(dt, dy, dist);
      this.walkPhase += 0.1;
      return;
    }

    let wishX = 0, wishZ = 0;
    const inv = 1 / (dist || 1);
    if (dist > stopAt) {
      wishX = dx * inv;
      wishZ = dz * inv;
    } else if (this.type.ranged && dist < stopAt * 0.6) {
      // Too close -- back off so the pistol stays useful.
      wishX = -dx * inv;
      wishZ = -dz * inv;
    }

    const speed = this.type.speed * (this.enraged ? this.type.enrageSpeed : 1);
    const accel = this.onGround ? 26 : 8;
    this.vel.x += wishX * accel * dt;
    this.vel.z += wishZ * accel * dt;

    const hspeed = Math.hypot(this.vel.x, this.vel.z);
    if (hspeed > speed) {
      const k = speed / hspeed;
      this.vel.x *= k;
      this.vel.z *= k;
    }
    if (wishX === 0 && wishZ === 0 && this.onGround) {
      this.vel.x *= Math.max(0, 1 - dt * 10);
      this.vel.z *= Math.max(0, 1 - dt * 10);
    }

    this.vel.y -= GRAVITY * dt;
    this._integrate(dt, dy, dist);

    this.walkPhase += Math.hypot(this.vel.x, this.vel.z) * dt * 3.4;
  }

  /**
   * Sweep the enemy through the world for one step: horizontal first, then
   * props, then the vertical resolve. Gravity is the caller's business, because
   * a leaper in mid-flight integrates the same way but decides its own arc.
   *
   * @param dy   height of the target above us, used to decide when to hop
   * @param dist horizontal distance to the target, same
   */
  _integrate(dt, dy, dist) {
    if (this.vel.y < -55) this.vel.y = -55;

    if (this.world.portalSystem?.ready && this.world.portalSystem.tryTraverse(this)) {
      return;
    }

    const blockedX = this._moveHorizontal(0, this.vel.x * dt);
    const blockedZ = this._moveHorizontal(2, this.vel.z * dt);
    if (blockedX) this.vel.x = 0;
    if (blockedZ) this.vel.z = 0;

    // Props push them out the same way they push the player.
    this.world.resolveProps(this.pos, this.half, this.type.height);

    // Cliffs and cover are climbed by jumping -- same as the player would.
    // A leaper already in the air is mid-commitment and does not re-jump.
    //
    // Jumping at *anything* that blocks you is what put zombies on top of desks
    // and inside ceilings: a wall blocks you, and a jump into a wall is a jump
    // that lands you back where you were, or on the furniture beside it. So the
    // hop is only taken when there is something ahead a jump can actually get
    // on top of, or when the target is overhead and within reach.
    if (!this.leaping && this.onGround) {
      const wantUp = dy > 0.9 && dist < 3.5;
      if ((blockedX || blockedZ || wantUp) && this._mountableAhead(wantUp)) {
        this.vel.y = JUMP_SPEED;
        this.onGround = false;
      }
    }

    // ---- vertical ---------------------------------------------------------
    this.pos.y += this.vel.y * dt;
    const support = this.world.supportHeight(this.pos.x, this.pos.z, this.pos.y, this.half);
    if (this.pos.y <= support) {
      this.pos.y = support;
      this.vel.y = 0;
      this.onGround = true;
    } else if (this.pos.y - support < 0.15 && this.vel.y <= 0) {
      this.pos.y = support;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // Nothing should ever end up under the terrain; recover if it does.
    const floor = this.world.heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < floor - 0.5) {
      this.pos.y = floor;
      this.vel.y = 0;
    }
  }

  /**
   * Is there a ledge just ahead worth jumping onto?
   *
   * "Worth" means three things at once: it is higher than a stride but inside
   * what a jump reaches, there is head-room to stand on it, and it is in the
   * direction the body is already trying to go. Anything failing those is a
   * wall, and a wall is walked around rather than hopped at.
   *
   * @param overhead true when the target itself is above us, which lowers the
   *                 bar -- the ledge only has to exist, not to be in the way
   */
  _mountableAhead(overhead) {
    let dx = this.vel.x, dz = this.vel.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.2) { dx = Math.sin(this.yaw); dz = Math.cos(this.yaw); }
    else { dx /= len; dz /= len; }

    for (const reach of [0.55, 1.1]) {
      const x = this.pos.x + dx * reach;
      const z = this.pos.z + dz * reach;
      // Probe from high enough that supportHeight will admit a surface a jump
      // could reach; it only reports tops within a step of where it is asked.
      const top = this.world.supportHeight(x, z, this.pos.y + JUMP_REACH, this.half);
      const rise = top - this.pos.y;
      if (rise <= STEP || rise > JUMP_REACH) continue;
      // Landing on it has to leave the body somewhere it fits, or the jump ends
      // with a head inside the storey above.
      if (this.world.blocksAt(x, top + 0.05, z, this.half * 0.8, this.type.height * 0.9)) continue;
      return true;
    }
    return overhead && this.world.supportHeight(
      this.pos.x, this.pos.z, this.pos.y + JUMP_REACH, this.half) > this.pos.y + STEP;
  }

  // ----------------------------------------------------------------- ranged

  /**
   * Pistol fire. Uses the same hitscan discipline as the player's weapons:
   * the shot is traced against the world first, so a gunner cannot shoot the
   * player through a wall. Accuracy is intentionally poor.
   */
  _updateRanged(dt, player, dist) {
    const t = this.type;

    if (this.rangedTimer > 0) this.rangedTimer -= dt;

    const eyeX = this.pos.x;
    const eyeY = this.pos.y + t.height * 0.82;
    const eyeZ = this.pos.z;

    const px = player.pos.x;
    const py = player.pos.y + player.height * 0.55;
    const pz = player.pos.z;

    const inRange = dist < t.rangedRange && dist > 2.5;
    const canSee = inRange && this._hasLineOfSight(eyeX, eyeY, eyeZ, px, py, pz);

    // Wind up, then fire. Losing sight mid-aim aborts the shot.
    if (this.aimTimer > 0) {
      if (!canSee) { this.aimTimer = 0; return; }
      this.aimTimer -= dt;
      if (this.aimTimer <= 0) this._fireAt(player, eyeX, eyeY, eyeZ, px, py, pz);
      return;
    }

    if (canSee && this.rangedTimer <= 0) {
      this.aimTimer = t.rangedWarmup;
      this.rangedTimer = t.rangedCooldown + Math.random() * 0.7;
    }
  }

  _hasLineOfSight(x0, y0, z0, x1, y1, z1) {
    return this.world.lineOfSight(x0, y0, z0, x1, y1, z1);
  }

  _fireAt(player, ox, oy, oz, px, py, pz) {
    const t = this.type;
    let dx = px - ox, dy = py - oy, dz = pz - oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;

    // Scatter the shot inside the (generous) miss cone.
    const cone = t.rangedSpread;
    const ang = Math.random() * Math.PI * 2;
    const mag = Math.tan(cone) * Math.sqrt(Math.random());
    // Any two vectors perpendicular to the aim direction will do.
    let ux = -dz, uy = 0, uz = dx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    const ca = Math.cos(ang) * mag, sa = Math.sin(ang) * mag;
    let sx = dx + ux * ca + vx * sa;
    let sy = dy + uy * ca + vy * sa;
    let sz = dz + uz * ca + vz * sa;
    const sl = Math.hypot(sx, sy, sz) || 1;
    sx /= sl; sy /= sl; sz /= sl;

    // Trace: wall first, then the player box, nearest wins.
    const wall = this.world.raycast(ox, oy, oz, sx, sy, sz, t.rangedRange);
    const wallDist = wall.hit ? wall.distance : t.rangedRange;

    const h = player.half;
    const tp = rayAABB(ox, oy, oz, sx, sy, sz,
      player.pos.x - h, player.pos.y, player.pos.z - h,
      player.pos.x + h, player.pos.y + player.height, player.pos.z + h);

    const hit = tp >= 0 && tp <= wallDist;
    const end = hit ? tp : wallDist;

    if (hit) player.damage(t.rangedDamage, this);
    this.onShoot?.(ox, oy, oz, ox + sx * end, oy + sy * end, oz + sz * end, hit);
  }

  // --------------------------------------------------------------- collision

  /**
   * Same rules as the player: terrain is a surface to stand on, and anything
   * rising faster than the step height (or steeper than the walk limit) is a
   * wall. Keeping the two identical means enemies cannot path anywhere the
   * player could not follow.
   */
  _moveHorizontal(axis, amount) {
    if (amount === 0) return false;
    const key = axis === 0 ? 'x' : 'z';
    const before = this.pos[key];
    this.pos[key] += amount;

    if (!this.world.inBounds(this.pos.x, this.pos.z)) {
      this.pos[key] = before;
      return true;
    }

    const ground = this.world.supportHeight(this.pos.x, this.pos.z, this.pos.y, this.half);
    const rise = ground - this.pos.y;

    if (rise > 0 && rise <= STEP && this.world.isWalkable(this.pos.x, this.pos.z)) {
      this.pos.y = ground;
      return false;
    }
    if (rise > STEP || (rise > 0.05 && !this.world.isWalkable(this.pos.x, this.pos.z))) {
      if (this.world.portalSystem?.ready && this.world.portalSystem.tryTraverse(this)) {
        return false;
      }
      this.pos[key] = before;
      return true;
    }
    return false;
  }
}
