// The authoritative game simulation: enemies, waves, and the shared economy.
//
// This module is deliberately free of Three.js and of anything browser-only, so
// exactly the same code runs in two places:
//
//   - single player: the client constructs a GameSim and ticks it locally
//   - multiplayer:   the server constructs a GameSim, ticks it, and streams
//                    snapshots to every client in the room
//
// Having one implementation rather than two is the whole point. A wave table
// that drifts between client and server is the classic way co-op modes rot, so
// there is only ever one wave table.
//
// What the sim owns vs. what a client owns
// ----------------------------------------
// The sim owns everything that must agree between players: enemy positions and
// health, the wave clock, and the shared coin pot. A client keeps ownership of
// its own player -- movement, weapons, potions -- because aiming latency is the
// thing players feel first, and round-tripping movement to a server would ruin
// it. Loot (chests, stones, pickups) is instanced per player: the world seed is
// shared so everyone sees chests in the same places, but opening one is a local
// event, which means co-op partners never race each other for a drop.

import { NavGrid, NAV_UNREACHED } from '../world/navgrid.js';
import { World, FLOOR_H, MAP_ARENA, MAP_COMPLEX } from '../world/world.js';
import { clearBarrierWork, barrierInward, REACH as BARRIER_REACH } from '../world/barriers.js';
import { Enemy, ENEMY_TYPES } from '../entities/enemy.js';
import { MODE, normalizeMode, FFA_KILL_TARGET, FFA_RESPAWN, FFA_POST_MATCH } from '../net/protocol.js';
import { bananaVendingInRange, VENDING_SHAKE_SECONDS } from '../world/drummertower.js';

/** Fixed simulation rate. Both the local and networked sims run at this rate. */
export const SIM_RATE = 60;
export const SIM_DT = 1 / SIM_RATE;

/** Events the sim emits outward. Clients turn these into sound and pixels. */
export const EV = {
  WAVE_START: 'waveStart',
  WAVE_CLEAR: 'waveClear',
  ENEMY_KILLED: 'enemyKilled',
  ENEMY_SHOT: 'enemyShot',
  ENEMY_RELOCATED: 'enemyRelocated',
  PLAYER_HURT: 'playerHurt',
  PLAYER_POISONED: 'playerPoisoned',
  PLAYER_DOWNED: 'playerDowned',
  PLAYER_REVIVED: 'playerRevived',
  PLAYER_DIED: 'playerDied',
  PLAYER_FRAGGED: 'playerFragged',   // FFA: { by, to, headshot }
  PLAYER_RESPAWN: 'playerRespawn',   // FFA: { to, x, y, z }
  MATCH_OVER: 'matchOver',           // FFA: { winner, name, kills }
  MATCH_RESET: 'matchReset',         // FFA: next round starting
  COINS: 'coins',
  /** A board came off a window; carries whether that emptied the barrier. */
  BARRIER: 'barrier',
  EXPLOSION: 'explosion',
  BOSS_SPAWN: 'bossSpawn',
  BOSS_DEAD: 'bossDead',
  BANANA_VENDING: 'bananaVending',
};

/** Simultaneous live enemies. Above this the arena stops being readable. */
const MAX_LIVE = 14;
/** Per extra player, the sim allows a few more bodies and a bigger wave. */
const MAX_LIVE_PER_PLAYER = 5;

/** The complete co-op wave roster, including the milestone mini-boss. */
export const WAVE_ENEMY_TYPES = Object.freeze(['grunt', 'runner', 'clippy']);

/** Seconds an enemy may fail to close the gap before it is teleported. */
const STUCK_LIMIT = 6;
/**
 * Seconds an enemy may spend wedged inside solid geometry before the same.
 *
 * Much shorter than STUCK_LIMIT because there is nothing to wait for: a body
 * inside a wall is not about to work its way out, and it is visible from across
 * the room while it tries.
 */
const EMBED_LIMIT = 1.5;
/**
 * Seconds a body stays committed to a flight of stairs.
 *
 * A climb has to be a commitment. Re-deciding every tick puts a zombie halfway
 * up a flight where the field -- which is read at whatever storey its feet
 * happen to round to -- tells it to go back down, and it treadmills there
 * forever. Long enough for the slowest thing in the roster to walk a storey.
 */
const CLIMB_LIMIT = 9;
/** How close counts as having arrived at one end of a flight. */
const CLIMB_ARRIVED = 2.2;

/**
 * Seconds between waves.
 *
 * Short on purpose: this is only the walk-to-the-armoury window, not the
 * shopping time. The clock stops entirely while the shop is open (see
 * holdBreak), so browsing costs nothing and this does not have to budget for
 * it. Twenty-five seconds of standing around with nothing left to kill read as
 * dead air between rounds.
 */
const WAVE_BREAK = 10.0;
/**
 * Grace before the very first wave.
 *
 * Was 2.0, which is not a warning -- in co-op the client spends most of that
 * rebuilding the world from the room seed, so a joining player's loading screen
 * would clear onto zombies already walking at them. Longer than a mid-run break
 * on purpose: the first one is the only one you have not been shown the map for.
 */
const OPENING_BREAK = 9.0;

/** A downed player has this long to be revived before they are out. */
export const BLEED_OUT = 30;

/**
 * FFA: how long the sim's verdict on a player outranks their own client's.
 *
 * Has to cover a full round trip plus one state interval -- the age of the
 * oldest report that can still be in flight when the sim rules on someone --
 * with room to spare on a bad connection. Nothing is lost inside the window:
 * the client keeps reporting, and whatever it says is taken as soon as it ends.
 */
const STATE_HOLD = 0.6;
/**
 * FFA: the fastest a duellist's client may report itself healing, per second.
 *
 * Comfortably above the game's own regen (18/s, and about double that under
 * every perk at once), so a player who backs off and recovers is never held
 * back by it -- and comfortably below what any weapon in the game puts out, so
 * a client that is not applying its own damage still loses the fight.
 */
const HEAL_RATE = 40;
/** How close a rescuer must stand, and how long the revive takes. */
export const REVIVE_RANGE = 2.6;
export const REVIVE_TIME = 3.0;

/**
 * A player as the simulation sees them.
 *
 * This is a shadow, not the real thing: the authoritative Player object lives
 * on that player's own machine. The sim needs just enough to run enemy AI
 * against -- a position, a hitbox, and whether they are still standing.
 */
export class SimPlayer {
  constructor(id, name) {
    this.id = id;
    this.name = name || 'PLAYER';
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.health = 100;
    this.maxHealth = 100;
    this.alive = true;
    /** Downed players are alive-but-helpless: enemies ignore them. */
    this.down = false;
    this.bleed = 0;
    this.reviveProgress = 0;
    this.reviverId = null;
    this.score = 0;
    this.kills = 0;
    /**
     * FFA only: this player's own purse, and the clock ticking them back in.
     *
     * Coins are shared in co-op and personal here -- a pot both duellists spend
     * from would mean every frag you earn funds the gun your opponent shoots you
     * with next.
     */
    this.coins = 0;
    this.respawn = 0;
    /**
     * FFA only: seconds during which the sim's verdict on this player's health
     * and pulse outranks their own client's report of it. See applyPlayerState.
     */
    this.stateHold = 0;
    /** Sim time of this player's last state report, for the heal rate limit. */
    this.lastReportAt = 0;
    this.weapon = 'PISTOL';
    this.moving = false;
    this.sprinting = false;
    this.ready = false;
    /** Set by the sim when it wants the owning client to take damage. */
    this._sim = null;
  }

  /** Enemies call this. It reports upward rather than deciding anything. */
  damage(amount, source) {
    if (!this.alive || this.down) return;
    this._sim?._emit(EV.PLAYER_HURT, {
      to: this.id,
      amount,
      from: source?.id ?? null,
      // Direction is sent so the client can apply knockback and a hit
      // indicator without needing to look the attacker up.
      dx: source ? this.pos.x - source.pos.x : 0,
      dz: source ? this.pos.z - source.pos.z : 0,
    });
  }

  applyPoison(total, duration) {
    if (!this.alive || this.down) return;
    this._sim?._emit(EV.PLAYER_POISONED, { to: this.id, total, duration });
  }

  get height() { return 1.8; }
  get half() { return 0.35; }
}

export class GameSim {
  /**
   * @param seed world seed; identical seeds produce identical terrain
   * @param opts.onEvent called with (type, payload) for anything worth showing
   * @param opts.mode MODE.COOP (default) or MODE.FFA
   */
  constructor(seed = 20260725, opts = {}) {
    this.seed = seed | 0;
    /**
     * Which rule set this world runs. Fixed for the sim's lifetime: the wave
     * clock, the shared pot and the revive system are all co-op assumptions,
     * and a match that swapped between them mid-round would have to unwind all
     * three on live players.
     */
    this.mode = normalizeMode(opts.mode);
    /** FFA only: set once someone reaches the kill target. */
    this.winnerId = null;
    this.postMatch = 0;
    // The client generates its world progressively so it can draw a loading
    // bar, and hands the finished one in here. The server has no frame budget
    // to protect, so it lets the sim build its own.
    // A duel runs on the authored map and a horde run on a generated one. The
    // mode picks the floorplan because the two want opposite things from it:
    // co-op wants somewhere you have not memorised, versus wants somewhere both
    // players have and that is provably fair to each of them.
    this.world = opts.world
      || new World(this.seed, { map: this.isFFA ? MAP_ARENA : MAP_COMPLEX });
    this.generated = !!opts.world;
    this.onEvent = opts.onEvent || null;

    this.players = new Map();       // id -> SimPlayer
    this.enemies = [];
    this.nextEnemyId = 1;

    this.wave = 0;
    this.waveKills = 0;
    this.waveTotal = 0;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    /**
     * A free-for-all has no wave clock to run, so it must not sit in a break
     * either. The break is not idle state on a client: it freezes the streak,
     * holds every potion timer, and owns the HUD's prompt line -- so a duel that
     * started on a break it could never leave was one where a potion never
     * counted down and the prompt permanently advertised an armoury countdown
     * over the top of the door and chest prompts.
     */
    this.waveBreak = this.isFFA ? 0 : OPENING_BREAK;
    /** Client-set: someone is in the armoury, so the break must not run out. */
    this.holdBreak = false;
    this.elapsed = 0;
    this.running = false;

    /** Shared across the party: everyone spends from the same pot. */
    this.coins = 0;
    this.score = 0;
    /** -1 until the authoritative, one-shot rooftop machine is triggered. */
    this.vendingTime = -1;
    this._vendingColliderRemoved = false;

    this._events = [];
    this._rngState = this.seed >>> 0;
    this._lastSpawn = null;
  }

  /** Generate terrain. Synchronous -- the server has no frame budget to keep. */
  generate() {
    if (this.generated) return this;
    for (const _ of this.world.generate()) { /* drain */ }
    this.generated = true;
    return this;
  }

  /** Put this simulation back at the opening countdown of a fresh run. */
  resetRun() {
    this.enemies.length = 0;
    this.nextEnemyId = 1;
    this.wave = 0;
    this.waveKills = 0;
    this.waveTotal = 0;
    this.spawnQueue.length = 0;
    this.spawnTimer = 0;
    this.waveBreak = this.isFFA ? 0 : OPENING_BREAK;
    this.holdBreak = false;
    this.elapsed = 0;
    this.running = true;
    this.coins = 0;
    this.score = 0;
    this.vendingTime = -1;
    this._vendingColliderRemoved = false;
    this.winnerId = null;
    this.postMatch = 0;
    this._events.length = 0;
    this._rngState = this.seed >>> 0;
    this._lastSpawn = null;
    this.nav = null;
    this._routes?.clear();
    this._navStamp = undefined;
    this._navTimer = 0;
    this._navSwept = false;

    for (const p of this.players.values()) {
      p.health = p.maxHealth;
      p.alive = true;
      p.down = false;
      p.bleed = 0;
      p.reviveProgress = 0;
      p.reviverId = null;
      p.score = 0;
      p.kills = 0;
      p.coins = 0;
      p.respawn = 0;
      p.stateHold = 0;
      p.lastReportAt = 0;
    }
  }

  // ------------------------------------------------------------------ events

  _emit(type, payload) {
    this._events.push({ type, ...payload });
    this.onEvent?.(type, payload);
  }

  /** Drain queued events. The server sends these to clients each snapshot. */
  drainEvents() {
    if (this._events.length === 0) return null;
    const out = this._events;
    this._events = [];
    return out;
  }

  // ----------------------------------------------------------------- players

  addPlayer(id, name) {
    const p = new SimPlayer(id, name);
    p._sim = this;
    // Someone joining a duel in progress is spawning into a live fight, so they
    // go through the same picker a respawn does. findSpawn's spiral starts at
    // the middle of the map, which on the versus map is the middle of the
    // street -- the one place nobody should ever appear.
    const spot = (this.isFFA && this._authoredSpawn(p)) || this.world.findSpawn();
    p.pos.x = spot.x; p.pos.y = spot.y; p.pos.z = spot.z;
    this.players.set(id, p);
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  /**
   * Apply a client's report of where it is and how it is doing.
   *
   * A client owns its own body, so in co-op every field here is taken as read:
   * the only thing it can lie about is a fight against AI it shares with nobody.
   *
   * A free-for-all cannot work that way. These reports are a fifth of a second
   * stale by the time they land, so the echo of "I am fine" that was already in
   * flight when a lethal shot landed would arrive just after it and put the
   * corpse back on its feet -- alive again for a few frames, long enough to be
   * shot a second time and credit the shooter two kills for one death, and long
   * enough for the health the sim had just taken off to come back. So while the
   * sim has recently ruled on a duellist -- hurt, killed or dropped back in --
   * its own numbers stand, and a client may never report itself back to life.
   *
   * Past that window a duellist's health is still only believed downward at
   * face value. "I am at full health" is the claim a client repeats constantly,
   * and taking it as read means a tab that has stopped applying its own damage
   * -- throttled in the background, on a bad line, running an old build --
   * reports the damage away between shots and cannot be killed at all. Upward
   * is therefore rate limited to something no honest client exceeds and no
   * duel's damage output loses to.
   */
  applyPlayerState(id, s) {
    const p = this.players.get(id);
    if (!p) return;
    if (s.pos && [s.pos.x, s.pos.y, s.pos.z].every(Number.isFinite)) {
      // Never allow one malformed client to poison the shared simulation with
      // NaN, Infinity, objects, or coordinates large enough to make collision
      // maths overflow. Movement remains client-owned; this is a type and
      // resource boundary, not server-side movement prediction.
      const size = Number.isFinite(this.world?.size) ? this.world.size : 512;
      p.pos.x = Math.max(0, Math.min(size, s.pos.x));
      p.pos.y = Math.max(-100, Math.min(1_000, s.pos.y));
      p.pos.z = Math.max(0, Math.min(size, s.pos.z));
    }
    if (Number.isFinite(s.yaw)) p.yaw = ((s.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    if (Number.isFinite(s.pitch)) p.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, s.pitch));
    const held = this.isFFA && p.stateHold > 0;
    if (Number.isFinite(s.health) && !held) {
      const health = Math.max(0, Math.min(p.maxHealth, s.health));
      if (!this.isFFA || health <= p.health) {
        p.health = health;
      } else {
        const since = Math.max(0, this.elapsed - p.lastReportAt);
        p.health = Math.min(health, p.health + HEAL_RATE * since);
      }
    }
    // Advanced whether or not the report was taken, so a held window does not
    // bank an allowance that is spent the instant it lifts.
    p.lastReportAt = this.elapsed;
    if (typeof s.alive === 'boolean' && !held) {
      // Dying is always the client's to report -- a fall, its own rocket. Only
      // the sim gets to undo it.
      if (!this.isFFA || !s.alive || p.alive) p.alive = s.alive;
    }
    if (typeof s.weapon === 'string') p.weapon = s.weapon.replace(/[^A-Z0-9 _-]/gi, '').slice(0, 24) || 'PISTOL';
    if (typeof s.moving === 'boolean') p.moving = s.moving;
    if (typeof s.sprinting === 'boolean') p.sprinting = s.sprinting;
  }

  /** Anyone still upright and able to shoot. */
  activePlayers() {
    const out = [];
    for (const p of this.players.values()) if (p.alive && !p.down) out.push(p);
    return out;
  }

  /** Nearest target for an enemy, or null if the party is wiped. */
  nearestPlayer(x, z) {
    let best = null, bestD = Infinity;
    for (const p of this.players.values()) {
      if (!p.alive || p.down) continue;
      const d = (p.pos.x - x) ** 2 + (p.pos.z - z) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /**
   * Settle the shared banana-machine interaction once for the whole room.
   * The server validates the requesting player's latest body position; clients
   * only ask, so simultaneous key presses cannot create divergent storms.
   */
  activateBananaVending(playerId) {
    if (this.vendingTime >= 0) return false;
    const player = this.players.get(playerId);
    const tower = this.world?.drummerTower;
    if (!player || !bananaVendingInRange(tower, player)) return false;
    this.vendingTime = 0;
    const vending = tower.bananaVending;
    this._emit(EV.BANANA_VENDING, {
      by: playerId,
      x: vending.x,
      y: vending.y + 1.05,
      z: vending.z,
    });
    return true;
  }

  _updateBananaVending(dt) {
    if (this.vendingTime < 0) return;
    this.vendingTime += dt;
    if (!this._vendingColliderRemoved && this.vendingTime >= VENDING_SHAKE_SECONDS) {
      this.world.destroyBananaVendingMachine?.();
      this._vendingColliderRemoved = true;
    }
  }

  // ------------------------------------------------------------------ downed

  get isFFA() { return this.mode === MODE.FFA; }

  /**
   * One player shooting another. FFA only -- co-op has no friendly fire, and
   * adding it through this door would make every stray shotgun pellet in a
   * corridor a betrayal.
   *
   * The shooter's client traced the hit and reports it; the sim decides what it
   * is worth and who gets credit. That split is the same one the co-op damage
   * path already uses, and it is what keeps two clients from disagreeing about
   * who died.
   */
  hitPlayer(byId, targetId, amount, headshot = false) {
    if (!this.isFFA || this.winnerId) return false;
    const target = this.players.get(targetId);
    const by = this.players.get(byId);
    if (!target || !by || target === by) return false;
    if (!Number.isFinite(amount) || amount <= 0) return false;
    if (!by.alive || by.down) return false;
    if (!target.alive || target.down) return false;

    target.health = Math.max(0, target.health - amount);
    target.stateHold = STATE_HOLD;
    this._emit(EV.PLAYER_HURT, {
      to: targetId,
      amount,
      from: byId,
      dx: target.pos.x - by.pos.x,
      dz: target.pos.z - by.pos.z,
    });
    if (target.health > 0) return true;

    // A frag, not a down: there is nobody on your team to pick you up.
    by.kills += 1;
    by.score += headshot ? 150 : 100;
    // Kills still pay, or the armoury and the mystery box would be dead weight
    // in a mode with no zombies to farm. Into the shooter's own purse, which is
    // what encodePlayer puts on the wire and spendCoinsFor settles against.
    by.coins += headshot ? 140 : 100;
    this._emit(EV.PLAYER_FRAGGED, { by: byId, to: targetId, headshot });

    target.alive = false;
    target.down = false;
    target.respawn = FFA_RESPAWN;
    target.stateHold = STATE_HOLD;
    this._emit(EV.PLAYER_DIED, { to: targetId });

    if (by.kills >= FFA_KILL_TARGET) {
      this.winnerId = byId;
      this.postMatch = FFA_POST_MATCH;
      this._emit(EV.MATCH_OVER, { winner: byId, name: by.name, kills: by.kills });
    }
    return true;
  }

  /**
   * Pick an authored spawn point, furthest from anyone alive to shoot at it.
   *
   * Straight "furthest from the nearest enemy" is not enough on a mirrored map.
   * With one opponent standing in the middle of the street every anchor scores
   * about the same, and the tie breaks arbitrarily -- which over a match means
   * a player repeatedly landing in the house their killer is already holding.
   * Scoring the *sum* of inverse distances instead makes a crowded side score
   * badly even when no single opponent is close, so a respawn drifts to the
   * quiet end of the map rather than the merely-not-adjacent one.
   */
  _authoredSpawn(p) {
    const spawns = this.world.spawns;
    if (!spawns?.length) return null;

    const foes = [...this.players.values()]
      .filter((q) => q !== p && q.alive && !q.down);

    let best = null, bestScore = Infinity;
    for (const s of spawns) {
      let score = 0;
      for (const q of foes) {
        const d = Math.hypot(q.pos.x - s.x, q.pos.z - s.z);
        // Anything inside a few metres is a spawn kill however the rest of the
        // map looks, so the near term has to dominate rather than average out.
        score += 1 / Math.max(4, d);
        if (d < 12) score += 4;
      }
      // Never the exact anchor twice running: two players respawning in the
      // same second would otherwise both take the best one and land on top of
      // each other.
      if (s === this._lastSpawn) score += 0.5;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    this._lastSpawn = best;
    return best ? { x: best.x, y: best.y, z: best.z } : null;
  }

  /** Drop a dead FFA player back in, away from whoever is still fighting. */
  _respawnPlayer(p) {
    const spot = this._authoredSpawn(p)
      || this._findSpawnSpot(18, 46) || this.world.findSpawn();
    p.pos.x = spot.x; p.pos.y = spot.y; p.pos.z = spot.z;
    p.health = p.maxHealth;
    p.alive = true;
    p.down = false;
    p.bleed = 0;
    p.respawn = 0;
    // Their client is still reporting a corpse for another round trip. Without
    // the hold, that echo lands on a player who has just been stood up, puts
    // them back down with no respawn clock left to run, and leaves them dead for
    // good.
    p.stateHold = STATE_HOLD;
    this._emit(EV.PLAYER_RESPAWN, { to: p.id, x: spot.x, y: spot.y, z: spot.z });
  }

  /** FFA: respawn timers, and the lull after someone wins. */
  _updateFFA(dt) {
    for (const p of this.players.values()) {
      if (p.stateHold > 0) p.stateHold -= dt;
      if (p.alive) continue;
      // A death the sim did not rule on -- a client that reported itself dead in
      // its state without the message that starts the clock, because the message
      // was dropped or the build is old -- still has to come back. Without this
      // it is dead for the rest of the match, which is a worse outcome than any
      // packet loss should be able to cause.
      if (!(p.respawn > 0)) { p.respawn = FFA_RESPAWN; continue; }
      p.respawn -= dt;
      // Nobody comes back mid-victory screen; the round is over.
      if (p.respawn <= 0 && !this.winnerId) this._respawnPlayer(p);
    }

    if (!this.winnerId) return;
    this.postMatch -= dt;
    if (this.postMatch > 0) return;

    // Fresh round, same room and same map. Everyone back to zero.
    this.winnerId = null;
    this.postMatch = 0;
    for (const p of this.players.values()) {
      p.kills = 0;
      p.score = 0;
      p.coins = 0;
      this._respawnPlayer(p);
    }
    this._emit(EV.MATCH_RESET, {});
  }

  /** Put a player into the bleed-out state instead of killing them outright. */
  downPlayer(id) {
    const p = this.players.get(id);
    // In a free-for-all there is no rescue, so a death is a death. Whoever shot
    // them has already been credited in hitPlayer; this is the self-inflicted
    // case -- a rocket at your own feet, or a fall.
    if (this.isFFA) {
      const q = this.players.get(id);
      if (!q || !q.alive) return;
      q.alive = false;
      q.health = 0;
      q.respawn = FFA_RESPAWN;
      q.stateHold = STATE_HOLD;
      this._emit(EV.PLAYER_DIED, { to: id });
      return;
    }
    if (!p || p.down || !p.alive) return;
    p.down = true;
    p.bleed = BLEED_OUT;
    p.reviveProgress = 0;
    p.health = 0;
    this._emit(EV.PLAYER_DOWNED, { to: id });
  }

  _updateDowned(dt) {
    // A solo player has nobody to pick them up, so downing them would just be a
    // slower death screen. Solo goes straight to dead; co-op gets the rescue.
    const solo = this.players.size <= 1;

    for (const p of this.players.values()) {
      if (!p.down) continue;

      if (solo) { this._killPlayer(p); continue; }

      // Someone standing close enough revives them. The rescuer is recorded so
      // the client can draw a progress ring on the right person.
      let rescuer = null;
      for (const o of this.players.values()) {
        if (o === p || !o.alive || o.down) continue;
        const d = Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z);
        if (d <= REVIVE_RANGE) { rescuer = o; break; }
      }

      if (rescuer) {
        p.reviverId = rescuer.id;
        p.reviveProgress += dt;
        if (p.reviveProgress >= REVIVE_TIME) {
          p.down = false;
          p.alive = true;
          p.bleed = 0;
          p.reviveProgress = 0;
          p.reviverId = null;
          p.health = 50;
          this._emit(EV.PLAYER_REVIVED, { to: p.id, by: rescuer.id });
          // A completed rescue is authoritative. Do not then advance the
          // bleed-out clock and emit PLAYER_DIED on the very same tick when a
          // last-moment revive happens to cross both thresholds together.
          continue;
        }
      } else {
        p.reviverId = null;
        // Progress decays rather than resetting, so a rescuer driven off by a
        // brute has not wasted the attempt entirely.
        p.reviveProgress = Math.max(0, p.reviveProgress - dt * 0.5);
      }

      p.bleed -= dt;
      if (p.bleed <= 0) this._killPlayer(p);
    }
  }

  _killPlayer(p) {
    p.down = false;
    p.alive = false;
    p.health = 0;
    p.bleed = 0;
    p.reviveProgress = 0;
    p.reviverId = null;
    this._emit(EV.PLAYER_DIED, { to: p.id });
  }

  /** Bring a dead player back at the start of a wave (co-op respawn). */
  respawnPlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    // Choose a living teammate before reviving this body. Marking it alive
    // first made the first map entry select its own corpse as the anchor, so a
    // wave respawn could happen back at the death site rather than by the
    // teammate who survived.
    const anchor = [...this.players.values()].find((q) => q !== p && q.alive && !q.down);
    p.alive = true;
    p.down = false;
    p.health = p.maxHealth;
    p.bleed = 0;
    p.reviveProgress = 0;
    p.reviverId = null;
    const spot = anchor
      ? (this._findSpawnSpot(6, 14, anchor) || { x: anchor.pos.x, y: anchor.pos.y, z: anchor.pos.z })
      : this.world.findSpawn();
    p.pos.x = spot.x; p.pos.y = spot.y; p.pos.z = spot.z;
  }

  // ----------------------------------------------------------------- enemies

  enemyById(id) {
    for (const e of this.enemies) if (e.id === id) return e;
    return null;
  }

  /**
   * Apply damage from a player. Returns a result the caller can score against,
   * or null if the shot referenced an enemy that is already gone.
   *
   * In co-op this is trusted client input. That is a deliberate choice: the
   * mode is strictly cooperative against AI, so the only thing a cheater can
   * do is spoil their own game. Validating every shot server-side would cost
   * far more than it protects.
   */
  damageEnemy(enemyId, amount, byPlayerId, opts = {}) {
    const e = this.enemyById(enemyId);
    if (!e || !e.alive) return null;
    if (!Number.isFinite(amount) || amount <= 0) return null;

    // Where the shot came from decides whether a shield or a boss's armour
    // applies. The shooter's own position is good enough for the arc test, so
    // it is looked up here rather than sent over the wire.
    const origin = opts.origin || this.players.get(byPlayerId)?.pos || null;
    const killed = e.damage(amount, { origin, headshot: opts.headshot });
    if (!killed) return { killed: false, enemy: e };

    this.waveKills += 1;
    const p = this.players.get(byPlayerId);
    // The killer's streak tier and a headshot bonus both scale the payout. They
    // are applied here rather than on the client so that every player in the
    // room sees the same number added to the same shared total.
    const base = e.type.score;
    const bonus = opts.headshot ? Math.round(base * 0.5) : 0;
    const score = Math.round((base + bonus) * (opts.scoreScale || 1));
    const coins = Math.round(score * 0.35);
    if (p) { p.score += score; p.kills += 1; }
    this.score += score;
    this.addCoins(coins);

    if (e.type.boss || e.type.miniboss) {
      this._emit(EV.BOSS_DEAD, { id: e.id, type: e.type.id, label: e.type.label });
    }

    this._emit(EV.ENEMY_KILLED, {
      id: e.id,
      type: e.type.id,
      by: byPlayerId ?? null,
      headshot: !!opts.headshot,
      x: e.pos.x, y: e.pos.y, z: e.pos.z,
      score, coins,
    });
    return { killed: true, enemy: e, score, coins };
  }

  /**
   * The five-stone wave wipe. Kills everything standing and empties the spawn
   * queue -- leaving the queue would refill the arena a second later and make
   * the payoff feel like nothing happened.
   *
   * Awards no score and drops no loot: it is a comeback button, not a farm.
   */
  snap(byPlayerId = null) {
    let killed = 0;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.damage(1e9);
      this.waveKills += 1;
      killed += 1;
      this._emit(EV.ENEMY_KILLED, {
        id: e.id, type: e.type.id, by: byPlayerId, headshot: false,
        x: e.pos.x, y: e.pos.y, z: e.pos.z,
        score: 0, coins: 0, quiet: true,
      });
    }
    this.waveKills += this.spawnQueue.length;
    this.spawnQueue.length = 0;
    return killed;
  }

  /**
   * A bloater going off. Hurts players and other enemies alike -- friendly fire
   * between the horde is the reason a pack of them is a liability to itself,
   * and the reason luring one into a crowd is worth doing.
   */
  detonate(source) {
    const t = source.type;
    const x = source.pos.x, y = source.pos.y + t.height * 0.5, z = source.pos.z;
    const radius = t.explodeRadius;

    this._emit(EV.EXPLOSION, { x, y, z, radius, source: source.id });

    for (const e of this.enemies) {
      if (!e.alive || e === source) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.y + e.type.height * 0.5 - y, e.pos.z - z);
      if (d > radius) continue;
      // No origin, so armour and shields do not apply: blast does not care
      // which way anything is facing.
      e.damage(t.explodeDamage * (1 - d / radius) * 0.8);
    }

    for (const p of this.players.values()) {
      if (!p.alive || p.down) continue;
      const d = Math.hypot(p.pos.x - x, p.pos.y + 0.9 - y, p.pos.z - z);
      if (d > radius) continue;
      this._emit(EV.PLAYER_HURT, {
        to: p.id,
        amount: t.explodeDamage * (1 - d / radius),
        from: source.id,
        dx: p.pos.x - x, dz: p.pos.z - z,
      });
    }
  }

  addCoins(n) {
    this.coins = Math.max(0, this.coins + n);
    this._emit(EV.COINS, { coins: this.coins });
  }

  spendCoins(n) {
    if (this.coins < n) return false;
    this.coins -= n;
    this._emit(EV.COINS, { coins: this.coins });
    return true;
  }

  /**
   * Settle a purchase against one player's own purse.
   *
   * The free-for-all counterpart to spendCoins: there is no party to share a
   * pot with, and the two things the pot pays for -- doors and the armoury --
   * are exactly what a duel is fought over.
   */
  spendCoinsFor(id, n) {
    const p = this.players.get(id);
    if (!p || p.coins < n) return false;
    p.coins -= n;
    return true;
  }

  // ------------------------------------------------------------------- waves

  /**
   * Wave composition.
   *
   * Difficulty mostly comes from a larger horde. Wave five adds one
   * Clippy mini-boss: still a close-range chaser, so it does not reintroduce
   * gunfire, poison, explosions, shields, or directional boss armour.
   */
  _composeWave(n) {
    // Wave one teaches the walker. From wave two onward the same stable 3:1
    // mix keeps runners present without quietly making each individual zombie
    // stronger as the number on the HUD rises.
    const table = this.wave < 2
      ? [{ type: 'grunt', weight: 1 }]
      : [{ type: 'grunt', weight: 3 }, { type: 'runner', weight: 1 }];

    const total = table.reduce((a, e) => a + e.weight, 0);
    const queue = [];
    for (let i = 0; i < n; i++) {
      let r = Math.random() * total;
      let picked = table[0].type;
      for (const e of table) {
        r -= e.weight;
        if (r <= 0) { picked = e.type; break; }
      }
      queue.push(picked);
    }
    // Lead with the milestone enemy so the health bar and announcement arrive
    // while the horde is still a threat, not after the wave is effectively won.
    if (this.wave === 5) queue.unshift('clippy');
    return queue;
  }

  /** Boss waves were removed; later waves are harder because they are larger. */
  get isBossWave() { return false; }

  startWave() {
    this.wave += 1;
    this.waveKills = 0;

    const party = Math.max(1, this.players.size);
    // Wave size grows with the party, but sub-linearly: four players are much
    // more than four times as effective as one, so a linear scale would make
    // big lobbies trivial early and unplayable later.
    const scale = 1 + (party - 1) * 0.6;
    // Keep growing well past the old 22-body ceiling. A cap still bounds the
    // length of an extreme late-game wave, while the live cap below controls
    // how many bodies have to be rendered and navigated at the same instant.
    const n = Math.min(Math.round(64 * scale), Math.round((4 + this.wave * 2.2) * scale));
    this.spawnQueue = this._composeWave(n);

    this.waveTotal = this.spawnQueue.length;
    this.spawnTimer = 0;

    // Anyone who died last wave gets another go at the start of the next.
    for (const p of this.players.values()) if (!p.alive) this.respawnPlayer(p.id);

    this._emit(EV.WAVE_START, {
      wave: this.wave, total: this.waveTotal, boss: this.isBossWave,
    });
  }

  get maxLive() {
    const solo = Math.min(30, MAX_LIVE + Math.floor(Math.max(0, this.wave - 1) / 2));
    return solo + Math.max(0, this.players.size - 1) * MAX_LIVE_PER_PLAYER;
  }

  _updateWaves(dt) {
    if (this.waveBreak > 0) {
      // The break holds while someone is actually in the armoury. A fixed few
      // seconds was never a shopping window -- by the time the wave-clear
      // banner faded it had already run out, so the armoury read as broken.
      //
      // Holding it also means a wave can never start underneath an open shop,
      // which is what used to strand the mouse cursor on screen and drop the
      // player into the pause menu: the shop is closed by the player now, and
      // that keypress is a user gesture, so the pointer lock comes straight
      // back. Set by the client; the sim only honours it.
      if (!this.holdBreak) {
        this.waveBreak -= dt;
        if (this.waveBreak <= 0) this.startWave();
      }
      return;
    }

    if (this.spawnQueue.length > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        const live = this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
        if (live < this.maxLive) {
          this.spawnEnemy(this.spawnQueue.shift());
          this.spawnTimer = 0.45;
        } else {
          this.spawnTimer = 0.8;
        }
      }
    }

    const anyAlive = this.enemies.some((e) => e.alive);
    if (this.spawnQueue.length === 0 && !anyAlive && this.wave > 0) {
      const bonus = 250 * this.wave;
      this.score += bonus;
      this.addCoins(Math.round(bonus * 0.4));
      this.waveBreak = WAVE_BREAK;
      this._emit(EV.WAVE_CLEAR, { wave: this.wave, bonus });
    }
  }

  // -------------------------------------------------------------- barriers

  /**
   * Everything a body needs to know about one window: which storey it is in,
   * where you stand outside it, and where you land inside it.
   *
   * Recomputed on the nav timer rather than per enemy per tick. Each one costs
   * a handful of clearance probes, and forty windows against fourteen zombies
   * sixty times a second is thousands of them for an answer that changes only
   * when a door is bought or a room is furnished.
   */
  _refreshBarrierRoutes() {
    if (!this._routes) this._routes = new Map();
    this._routes.clear();
    for (const b of this.world.barriers ?? []) {
      const route = this._computeBarrierRoute(b);
      if (route) this._routes.set(b, route);
    }
  }

  _barrierRoute(b) { return this._routes?.get(b) ?? null; }

  _computeBarrierRoute(b) {
    const r = b.room;
    if (!r) return null;
    // A window into a room nobody has opened is not a way in: whatever came
    // through it would be sealed in a room the player cannot reach, which is
    // the failure this whole spawn path exists to prevent.
    const zone = this.world.zones?.find((z) => z.id === r.id);
    if (zone && !zone.open) return null;

    const inward = barrierInward(b);
    // Windows sit in a band on one storey; which one is decided by where the
    // boards are, so this keeps working if the builder starts putting them on
    // upper floors as well.
    const level = Math.max(0, Math.round((b.y - r.floorY) / FLOOR_H));
    const y = r.floorY + FLOOR_H * level;

    let inside = null;
    for (const d of [1.7, 2.4, 3.1]) {
      const x = b.x + inward.x * d, z = b.z + inward.z * d;
      if (this.world.blocksAt(x, y, z, 0.35, 1.7)) continue;
      inside = { x, y, z };
      break;
    }
    if (!inside) return null;

    let out = null;
    for (const d of [1.7, 2.4, 3.1]) {
      const x = b.x - inward.x * d, z = b.z - inward.z * d;
      if (!this.world.inBounds(x, z)) continue;
      if (this.world.blocksAt(x, y, z, 0.35, 1.7)) continue;
      out = { x, y, z };
      break;
    }
    if (!out) return null;

    return { level, y, inward, in: inside, out };
  }

  /**
   * Where this particular body would land if it climbed through.
   *
   * Checked against its own size rather than a nominal one: the landing that
   * fits a runner is inside a desk for a brute, and a teleport that ends with a
   * body inside furniture is worse than one that never happens.
   */
  _landingFor(b, e) {
    const route = this._barrierRoute(b);
    if (!route) return null;
    for (const d of [1.4, 2.0, 2.8, 3.6]) {
      const x = b.x + route.inward.x * d, z = b.z + route.inward.z * d;
      if (this.world.blocksAt(x, route.y, z, e.half + 0.05, e.type.height)) continue;
      return { x, y: route.y, z };
    }
    return null;
  }

  /**
   * Let an enemy tear at a barrier it is standing against.
   *
   * Only when the way in is genuinely blocked -- an enemy that already has a
   * route ignores the window and comes through the door, which is what stops
   * every zombie in the map queueing at the same pane.
   *
   * @returns true if this enemy spent the tick working, so it should not also
   *          move this tick
   */
  _workBarriers(e, target, dt) {
    const barriers = this.world.barriers;
    if (!barriers || !barriers.length) return false;
    // A vault is already committed. Enemy.update() owns it until it lands;
    // restarting it every tick would pin progress at zero outside the window.
    if (e.vault) return false;

    // The window it was sent to, if it is standing at it; otherwise whichever
    // is nearest. Open or shut either way -- checking line of sight first and
    // bailing out was wrong in exactly the case that counts, because the
    // instant the last board comes off the enemy CAN see the player through
    // the hole, so it took the early exit and never climbed through the window
    // it had just spent five seconds opening.
    //
    // Only windows with a route are candidates. A window into a room nobody
    // has bought is not a way in, it is a way to seal yourself in a room the
    // player will never open, and a zombie that tore one down would spend the
    // rest of the wave in there.
    const REACH_SQ = 3.0 * 3.0;
    let best = null, bestD = REACH_SQ;
    if (e.breach && this._barrierRoute(e.breach)
      && (e.breach.x - e.pos.x) ** 2 + (e.breach.z - e.pos.z) ** 2 < REACH_SQ) {
      best = e.breach;
    } else {
      for (const b of barriers) {
        if (!this._barrierRoute(b)) continue;
        const d = (b.x - e.pos.x) ** 2 + (b.z - e.pos.z) ** 2;
        if (d < bestD) { bestD = d; best = b; }
      }
    }
    if (!best) return false;

    const r = best.room;
    const outside = r
      && !(e.pos.x > r.minX && e.pos.x < r.maxX && e.pos.z > r.minZ && e.pos.z < r.maxZ);
    if (!outside) return false;

    const atWindow = (best.x - e.pos.x) ** 2 + (best.z - e.pos.z) ** 2
      <= BARRIER_REACH * BARRIER_REACH;

    // Once the boards are off, climb through.
    //
    // Tearing a barrier down has to actually let you in or the whole mechanic
    // is theatre: the sill under a window is over a metre up and the step-up
    // limit is 0.65, so a breached window is still a wall to anything walking.
    // Zombies vault it. The player cannot -- which is the asymmetry the genre
    // runs on, and the reason a window is a way in rather than a way out.
    //
    // Where they land is checked first. Dropping a body 1.1m inside the wall
    // put brutes inside the sill course and everything else inside whatever
    // desk was pushed up against the window.
    if (best.open) {
      // Keep walking toward the opening until the body is close enough to
      // actually touch the sill. Starting a vault from the old 3m search radius
      // made even the smooth version look like a long-range lunge.
      if (!atWindow) return false;
      // Nowhere legal on the far side -- a room packed to the window -- means
      // it stays outside and keeps trying. Standing at a hole it cannot use
      // is recoverable; being teleported inside a desk is not.
      const landing = this._landingFor(best, e);
      if (landing) {
        e.beginVault(landing.x, landing.y, landing.z);
      }
      return false;   // Enemy.update advances the traverse on this tick
    }

    // A body that already has a way in walks it, rather than stopping to work
    // on a window nobody is behind. Being on the outside field -- or on no
    // field at all -- is exactly the condition "the only way in is a window".
    const nav = this.nav;
    if (nav && nav.reachable(e.pos.x, e.pos.z, e.pos.y)
      && !nav.outside(e.pos.x, e.pos.z, e.pos.y)) return false;

    // REACH was previously documentation only: zombies could prise boards off
    // from anywhere inside the broader 3m candidate radius. Make the visible
    // hands and the collision rule agree.
    if (!atWindow) return false;

    if (this.world.breakBoard(best, dt)) {
      this._emit(EV.BARRIER, { x: best.x, y: best.y, z: best.z, open: best.open });
      // Patch the mask where the board was rather than letting the prop count
      // trip a full rebuild. A breach is a dozen board removals in a row, from
      // as many windows at once, and a whole-map rebuild on each of them is a
      // visible hitch every time a zombie makes progress.
      if (nav) {
        nav.rebuildAt(best.x - 2.5, best.z - 2.5, best.x + 2.5, best.z + 2.5);
        this._navStamp = this.world.props.length;
        this._navTimer = 0;
      }
    }
    return true;
  }

  /**
   * The window this body is coming in through.
   *
   * Sticky: a zombie that keeps re-picking the nearest window walks the outside
   * of the building sideways forever, because "nearest" flips every time it
   * rounds a corner.
   */
  _assignBreach(e) {
    if (e.breach && this._barrierRoute(e.breach)) return e.breach;

    let best = null, bestD = Infinity;
    for (const b of this.world.barriers ?? []) {
      if (!this._barrierRoute(b)) continue;
      const d = (b.x - e.pos.x) ** 2 + (b.z - e.pos.z) ** 2;
      if (d < bestD) { bestD = d; best = b; }
    }
    e.breach = best;
    return best;
  }

  // ------------------------------------------------------------ navigation

  /**
   * Keep the flow field pointed at the player.
   *
   * Rebuilt on a timer rather than every tick: one sweep costs a few
   * milliseconds and the player cannot outrun a field refreshed five times a
   * second. The walkable mask is only re-derived when the geometry actually
   * moved -- a door bought or a barrier breached -- because that is the only
   * thing that changes it.
   */
  _updateNav(dt) {
    const p = this.activePlayers()[0] || this.players.values().next().value;
    if (!p || !this.world.plan) return;

    if (!this.nav) this.nav = new NavGrid(this.world);

    // Geometry changes are rare and always go through the world, so a count of
    // them is enough to know the mask is stale.
    const stamp = (this.world.props?.length ?? 0);
    if (stamp !== this._navStamp) {
      this._navStamp = stamp;
      this.nav.rebuild();
      this._navTimer = 0;
    }

    this._navTimer = (this._navTimer ?? 0) - dt;
    if (this._navTimer > 0) return;
    this._navTimer = 0.2;
    this._sweep(p);
  }

  _sweep(p) {
    this._refreshBarrierRoutes();
    // The windows are handed to the sweep rather than resolved before it,
    // because whether a window is a usable way in depends on whether the room
    // behind it turned out to be reachable -- which is what the sweep is
    // working out.
    const seeds = [];
    for (const route of this._routes.values()) {
      seeds.push({ x: route.out.x, z: route.out.z, level: route.level, inside: route.in });
    }
    this.nav.update(p.pos.x, p.pos.z, p.pos.y, seeds);
    this._navSwept = true;
  }

  /**
   * The field, built on demand.
   *
   * Spawning happens inside the tick, after the field has been swept, but a
   * caller placing enemies without ticking -- a test, a server priming a room
   * -- still has to get a verified spot rather than a guess.
   */
  _ensureNav() {
    const p = this.activePlayers()[0] || this.players.values().next().value;
    if (!p || !this.world.plan) return null;
    if (!this.nav) {
      this.nav = new NavGrid(this.world);
      this._navStamp = this.world.props?.length ?? 0;
    }
    if (!this._navSwept) this._sweep(p);
    return this.nav;
  }

  /**
   * A point to walk toward: the next cell along the flow field, or the player.
   *
   * The proxy carries the real player's identity in everything but position, so
   * damage, attack range and target-switching all behave exactly as before --
   * only the direction of travel changes.
   */
  _steerTarget(e, target, dt) {
    const nav = this.nav;
    if (!nav) return target;

    // Partway up a flight of stairs: finish it.
    const climbing = this._climbStep(e, dt);
    if (climbing) return this._aim(e, target, climbing);

    // A body with no field, or one on the outside field, has no route the
    // shortcuts below are allowed to take -- the wall between it and the player
    // is exactly what it can see through and cannot walk through.
    const stranded = !nav.reachable(e.pos.x, e.pos.z, e.pos.y)
      || nav.outside(e.pos.x, e.pos.z, e.pos.y);
    const sameStorey = Math.abs(target.pos.y - e.pos.y) < FLOOR_H * 0.6;

    if (!stranded && sameStorey) {
      const dx = target.pos.x - e.pos.x, dz = target.pos.z - e.pos.z;
      if (dx * dx + dz * dz < 9) return target;   // last few metres: go direct
      if (this.world.lineOfSight(
        e.pos.x, e.pos.y + 1.0, e.pos.z,
        target.pos.x, target.pos.y + 1.0, target.pos.z)) return target;
    }

    const step = nav.stepFrom(e.pos.x, e.pos.z, e.pos.y);
    if (step?.flight) {
      e.climb = { flight: step.flight, up: step.up, timer: CLIMB_LIMIT };
      const c = this._climbStep(e, 0);
      if (c) return this._aim(e, target, c);
    }
    if (step) return this._aim(e, target, step);

    // Nowhere downhill. Either it is standing at the window it has to break, or
    // it has ended up somewhere with no route at all -- fallen out of the
    // building, or spawned on ground the field never reached. Both answers are
    // the same: walk to a window and start pulling boards off.
    const b = this._assignBreach(e);
    if (b) return this._aim(e, target, b);
    return target;
  }

  /**
   * Where a body committed to a flight should be walking, or null if it is not
   * on one any more.
   *
   * Two legs: get to the end of the flight it is starting from, then walk the
   * treads to the other end. Enemies climb by walking -- a riser is well inside
   * the step-up they take in stride -- so the whole job here is aiming them
   * along the flight instead of at a player standing over their head.
   */
  _climbStep(e, dt) {
    const c = e.climb;
    if (!c) return null;

    c.timer -= dt;
    const goal = c.up ? c.flight.head : c.flight.foot;
    const entry = c.up ? c.flight.foot : c.flight.head;

    const toGoal = Math.hypot(e.pos.x - goal.x, e.pos.z - goal.z);
    const arrived = toGoal < CLIMB_ARRIVED && Math.abs(e.pos.y - goal.y) < 0.9;
    const strayed = Math.min(toGoal, Math.hypot(e.pos.x - entry.x, e.pos.z - entry.z)) > 16;
    if (arrived || strayed || c.timer <= 0) { e.climb = null; return null; }

    // Still on the storey it started from and not yet at the treads: line up
    // with them first, or it walks into the side of the flight.
    const onEntry = Math.abs(e.pos.y - entry.y) < 0.9
      && Math.hypot(e.pos.x - entry.x, e.pos.z - entry.z) > 1.6;
    return onEntry ? entry : goal;
  }

  /**
   * Point the enemy at somewhere that is not the player, without letting
   * anything downstream notice.
   *
   * Aiming at the next cell centre -- less than a metre away -- put the proxy
   * inside the enemy's own attack range, so it stood swinging at a patch of
   * floor while the player took no damage. Keeping the direction but the true
   * distance means everything downstream of position, attack range included,
   * behaves as if the player were simply over there. The height stays the
   * player's, because that is what decides whether a swing can land at all.
   */
  _aim(e, target, at) {
    const sx = at.x - e.pos.x, sz = at.z - e.pos.z;
    const sl = Math.hypot(sx, sz);
    const range = Math.hypot(target.pos.x - e.pos.x, target.pos.z - e.pos.z);
    if (sl < 1e-3 || range < 0.5) return target;

    if (!e._navProxy) e._navProxy = { pos: { x: 0, y: 0, z: 0 } };
    const proxy = e._navProxy;
    // Delegate everything but position to the real player, so a hit that does
    // land is a hit on them and not on a scratch object.
    Object.setPrototypeOf(proxy, target);
    proxy.pos.x = e.pos.x + (sx / sl) * range;
    proxy.pos.z = e.pos.z + (sz / sl) * range;
    proxy.pos.y = target.pos.y;
    return proxy;
  }

  /**
   * Where a *player* goes: inside the opened area, on a ring around whoever is
   * still standing. Respawns and the free-for-all both use it.
   *
   * Enemies do not -- see _enemySpawnSpot. Putting a body back into the room
   * the fight is in is right for a player being revived into it and wrong for
   * a zombie, which is supposed to have to break in.
   */
  _findSpawnSpot(minDist, maxDist, anchor) {
    const p = anchor || this.activePlayers()[0] || this.players.values().next().value;
    if (!p) return null;

    // Inside the opened part of the map first. A ring drawn around the player
    // does not know about walls, so on a floorplan it drops enemies outside the
    // building or behind a door nobody has bought -- where they path into the
    // back of it and never arrive. The opened region is reachable by
    // definition: the player walked it.
    const inside = this.world.spawnInOpenArea?.(p.pos.x, p.pos.z, minDist, maxDist);
    if (inside) return inside;

    for (let attempt = 0; attempt < 32; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = minDist + Math.random() * (maxDist - minDist);
      const x = p.pos.x + Math.cos(ang) * dist;
      const z = p.pos.z + Math.sin(ang) * dist;
      if (x < 8 || z < 8 || x > this.world.size - 8 || z > this.world.size - 8) continue;
      if (!this.world.isWalkable(x, z)) continue;

      const near = this.world.propsNear(x, z, 2.0, []);
      let blocked = false;
      for (const pr of near) {
        const c = pr.collider;
        const d = c.kind === 'box'
          ? Math.hypot(Math.max(c.minX - x, 0, x - c.maxX), Math.max(c.minZ - z, 0, z - c.maxZ))
          : Math.hypot(x - c.x, z - c.z) - c.r;
        if (d < 1.4) { blocked = true; break; }
      }
      if (blocked) continue;

      return { x, y: this.world.heightAt(x, z), z };
    }
    return null;
  }

  /**
   * Where a zombie comes from.
   *
   * Outside, next to a boarded window that opens into somewhere the player can
   * be reached from. That is the whole premise of the mode and it used to be
   * the one thing the spawner would not do: it dropped every wave *inside* the
   * opened area, so they materialised in the room with the player and the
   * boarded-window mechanic -- the reason the map is shaped the way it is --
   * never ran once.
   *
   * Whatever comes back is verified before it is returned. A body has a route
   * from it, or it is not a spawn point: the flow field reaches the outside
   * face of every usable window, so "the field knows this cell" and "something
   * standing here can reach the player" are the same statement.
   *
   * @param e the enemy being placed, because a spot that fits a runner does not
   *          necessarily fit a brute
   */
  _enemySpawnSpot(anchor, e) {
    const p = anchor || this.activePlayers()[0] || this.players.values().next().value;
    if (!p) return null;
    const nav = this._ensureNav();

    const outside = this._windowApproachSpot(p, e, nav);
    if (outside) return outside;

    // Every window of every open room already breached, or none of them usable.
    // Coming in through the opening is fine at that point -- but it still has
    // to be somewhere with a route, which the ring spawn cannot promise.
    const inside = this._reachableIndoorSpot(p, e, nav, 8, 40);
    if (inside) return inside;

    return this._findSpawnSpot(22, 44, p);
  }

  /**
   * Open ground outside a window, at a stand-off.
   *
   * The stand-off matters as much as the window does: something that appears
   * against the glass has already arrived, and half the tension of the mechanic
   * is the walk in. Lateral jitter spreads a wave across the face of the
   * building rather than stacking it in one column.
   */
  _windowApproachSpot(p, e, nav, minDist = 12) {
    const w = this.world;
    const half = e ? e.half : 0.45;
    const height = e ? e.type.height : 1.8;

    const usable = [];
    for (const b of w.barriers ?? []) {
      const route = this._barrierRoute(b);
      if (!route) continue;
      // The field only reaches the outside of a window it decided was a way in.
      if (nav && !nav.reachable(route.out.x, route.out.z, route.out.y)) continue;
      const d = Math.hypot(b.x - p.pos.x, b.z - p.pos.z);
      // Boarded windows first. A breached one is a hole they walk through, and
      // the pressure of the mode comes from the ones that are still a clock.
      usable.push({ b, route, d, score: d + (b.open ? 26 : 0) });
    }
    if (!usable.length) return null;
    usable.sort((a, c) => a.score - c.score);

    // The near half of the list: close enough that they arrive while the wave
    // is still the current wave, spread enough that they do not all use one
    // pane.
    const pool = usable.slice(0, Math.max(3, Math.ceil(usable.length * 0.5)));

    for (let attempt = 0; attempt < 40; attempt++) {
      const c = pool[Math.floor(Math.random() * pool.length)];
      const inw = c.route.inward;
      const back = 3.5 + Math.random() * 5.5;
      const side = (Math.random() - 0.5) * 5.0;
      const x = c.b.x - inw.x * back + inw.z * side;
      const z = c.b.z - inw.z * back + inw.x * side;
      if (Math.hypot(x - p.pos.x, z - p.pos.z) < minDist) continue;
      if (!w.inBounds(x, z) || !w.isWalkable(x, z)) continue;
      const y = w.heightAt(x, z);
      if (nav && !nav.reachable(x, z, y)) continue;
      if (w.blocksAt(x, y, z, half + 0.25, height)) continue;
      return { x, y, z, barrier: c.b };
    }

    // Nowhere to stand back: the doorstep of the furthest usable window will
    // do. Still outside, still has to break in.
    for (const c of [...pool].sort((a, b2) => b2.d - a.d)) {
      const { x, z } = c.route.out;
      const y = w.heightAt(x, z);
      if (w.blocksAt(x, y, z, half + 0.1, height)) continue;
      return { x, y, z, barrier: c.b };
    }
    return null;
  }

  /** A spot in the opened interior that the field agrees is reachable. */
  _reachableIndoorSpot(p, e, nav, minDist, maxDist) {
    const half = e ? e.half : 0.45;
    const height = e ? e.type.height : 1.8;
    for (let i = 0; i < 24; i++) {
      const s = this.world.spawnInOpenArea?.(p.pos.x, p.pos.z, minDist, maxDist);
      if (!s) break;
      if (nav && (!nav.reachable(s.x, s.z, s.y) || nav.outside(s.x, s.z, s.y))) continue;
      if (this.world.blocksAt(s.x, s.y, s.z, half + 0.2, height)) continue;
      return s;
    }
    return null;
  }

  /**
   * Standing room near a point, on the same storey, with a route out of it.
   *
   * Used for the boss's adds, which have to arrive beside it or the fight
   * becomes a distraction from across the map -- but must not arrive inside a
   * wall to do it.
   */
  _spotNear(origin, radius, e) {
    const w = this.world;
    for (let i = 0; i < 24; i++) {
      const ang = Math.random() * Math.PI * 2;
      const d = radius * (0.6 + Math.random() * 0.7);
      const x = origin.x + Math.cos(ang) * d;
      const z = origin.z + Math.sin(ang) * d;
      if (!w.inBounds(x, z) || !w.isWalkable(x, z)) continue;
      const y = w.supportHeight(x, z, origin.y + 0.6, e.half);
      if (Math.abs(y - origin.y) > 1.2) continue;
      if (w.blocksAt(x, y, z, e.half + 0.2, e.type.height)) continue;
      if (this.nav && !this.nav.reachable(x, z, y)) continue;
      return { x, y, z };
    }
    return null;
  }

  /**
   * Somewhere to put a body that has got itself somewhere impossible.
   *
   * Indoors first: a rescue that puts it back outside makes it re-open the
   * window it has just come through, which from the player's side looks like
   * the zombie that was in the room with them simply vanished.
   */
  _rescueSpot(e, target) {
    const p = target || this.activePlayers()[0] || this.players.values().next().value;
    if (!p) return null;
    const nav = this._ensureNav();
    return this._nudgeSpot(e, nav)
      || this._reachableIndoorSpot(p, e, nav, 6, 30)
      || this._windowApproachSpot(p, e, nav, 6);
  }

  /**
   * Forgive the stuck timers of anything that is getting closer.
   *
   * Measured in flow-field steps rather than metres, so it counts progress
   * through the building rather than progress across the map: a zombie that
   * has just come down a flight is nearer the player than it was, even though
   * it may be standing further away in a straight line.
   */
  _creditProgress(e, dt) {
    const nav = this.nav;
    if (!nav) return;
    const d = nav.distanceAt(e.pos.x, e.pos.z, e.pos.y);
    // No route at all: leave the timers alone. That body genuinely does need
    // rescuing, and the rescue is what gives it one.
    if (!(d < NAV_UNREACHED)) { e._progress = undefined; return; }

    if (e._progress === undefined || d < e._progress) {
      e._progress = d;
      e.stuckTimer = 0;
    }
  }

  /**
   * The shortest move that gets a wedged body back onto its route.
   *
   * Tried before anything else, and it is the difference between a rescue and a
   * punishment. A zombie that has spent forty seconds walking in through a
   * window, crossing the ground floor and climbing a flight is one snag away
   * from being teleported to a fresh spawn outside the building -- which throws
   * all of that away and starts it again, and from the player's side reads as
   * the horde never arriving at all. Traced on seed 20260725 with the player
   * two floors up: nineteen rescues in a minute, and not one zombie ever
   * reached them.
   *
   * So the first question is not "where else could this body go" but "what is
   * the nearest place it could stand that is no further from the player than it
   * already is". A metre sideways off the corner it is caught on keeps every
   * bit of the ground it has made.
   */
  _nudgeSpot(e, nav) {
    if (!nav) return null;
    const w = this.world;
    const here = nav.distanceAt(e.pos.x, e.pos.z, e.pos.y);
    const half = e.half + 0.15;

    let best = null, bestD = here;
    for (const radius of [1.0, 1.8, 2.8, 4.0]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + radius;
        const x = e.pos.x + Math.cos(a) * radius;
        const z = e.pos.z + Math.sin(a) * radius;
        if (!w.inBounds(x, z)) continue;

        // Its own storey, or the one either side of it: a body wedged at the
        // top of a flight is rescued onto the floor it was climbing to.
        for (const dy of [0, FLOOR_H, -FLOOR_H]) {
          const y = w.supportHeight(x, z, e.pos.y + dy + 0.6, e.half);
          if (Math.abs(y - (e.pos.y + dy)) > 1.0) continue;
          if (w.blocksAt(x, y, z, half, e.type.height)) continue;

          const d = nav.distanceAt(x, z, y);
          if (d >= bestD) continue;              // no better than where it is
          bestD = d;
          best = { x, y, z };
        }
      }
      // Near and good enough beats far and perfect: stop at the first ring
      // that offers real progress.
      if (best) return best;
    }
    return best;
  }

  spawnEnemy(type) {
    const active = this.activePlayers();
    const anchor = active[Math.floor(Math.random() * Math.max(1, active.length))];

    const e = new Enemy(type, this.world);
    e.id = this.nextEnemyId++;

    // Bosses and mini-bosses gain health on later waves; the rest keep their tuning
    // and the wave gets harder by sending more of them instead.
    if (e.type.boss) {
      // Floored at 1: bosses normally only appear on multiples of five, but a
      // boss summoned any other way must not come out weaker than its base.
      const tier = Math.max(1, Math.floor(this.wave / 5));
      e.maxHealth = Math.round(e.type.health * (1 + (tier - 1) * 0.45));
      e.health = e.maxHealth;
      this._emit(EV.BOSS_SPAWN, { id: e.id, health: e.maxHealth });
    } else if (e.type.miniboss) {
      const tier = Math.max(1, Math.floor(this.wave / 5));
      e.maxHealth = Math.round(e.type.health * (1 + (tier - 1) * 0.25));
      e.health = e.maxHealth;
      this._emit(EV.BOSS_SPAWN, {
        id: e.id, health: e.maxHealth, type: e.type.id, label: e.type.label,
      });
    }
    e.onShoot = (x0, y0, z0, x1, y1, z1, didHit) => {
      this._emit(EV.ENEMY_SHOT, { id: e.id, x0, y0, z0, x1, y1, z1, hit: didHit });
    };
    e.onDetonate = (self) => this.detonate(self);
    e.onSummon = (self, count) => {
      for (let i = 0; i < count; i++) {
        const add = this.spawnEnemy(Math.random() < 0.5 ? 'runner' : 'grunt');
        // Adds arrive beside the boss rather than on the usual ring, so the
        // fight stays a fight rather than a distraction from across the map.
        // If there is nowhere legal beside it -- a boss fighting in a doorway,
        // or on a stair -- they keep the verified spot they were spawned on
        // and walk in, which is slower but is at least somewhere they can walk
        // from.
        const spotNear = this._spotNear(self.pos, 4, add);
        if (spotNear) add.relocate(spotNear.x, spotNear.y, spotNear.z);
      }
    };

    const spot = this._enemySpawnSpot(anchor, e)
      || (anchor ? this.world.findSpawn(anchor.pos.x, anchor.pos.z, 30) : this.world.findSpawn());
    e.spawn(spot.x, spot.y, spot.z);
    // Remember the window it was put outside of, so it goes to that one rather
    // than re-deciding as it walks and drifting along the face of the building.
    if (spot.barrier) e.breach = spot.barrier;
    this.enemies.push(e);
    return e;
  }

  // -------------------------------------------------------------------- tick

  tick(dt) {
    if (!this.running) return;

    this._updateBananaVending(dt);
    this._updateNav(dt);
    // `working` is a per-tick fact about a barrier, so it starts every tick
    // false and is set again by whoever is actually prising at it.
    clearBarrierWork(this.world.barriers);

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];

      // Each enemy chases whoever is closest, re-evaluated every tick so they
      // switch targets naturally when a player runs past them.
      const target = e.alive ? this.nearestPlayer(e.pos.x, e.pos.z) : null;

      // Steer along the flow field rather than straight at the player.
      //
      // Close in, or with a clear line, head at them directly -- the field is
      // for getting through the building, not for the last two metres, and
      // routing an attack through a grid cell makes contact feel mushy.
      const steer = (e.alive && target) ? this._steerTarget(e, target, dt) : target;

      // A zombie held off by boards works on them instead of walking into
      // them. This is what makes a barrier a countdown rather than a wall:
      // the pressure is visible, audible, and arrives one board at a time.
      if (e.alive && target && this._workBarriers(e, target, dt)) continue;

      e.update(dt, steer || target || IDLE_TARGET);

      // Two different failures, one answer. Stuck is "cannot make progress";
      // embedded is "is inside something". Either way it goes somewhere a route
      // has been checked from, rather than back onto the ring spawn -- which
      // could and did drop it somewhere exactly as bad.
      // Closing on the player is not being stuck, whatever the anchor says.
      //
      // The anchor test asks whether a body has covered ground, which is the
      // wrong question on a staircase: a flight is under three metres across in
      // plan, so a zombie can climb a whole storey without ever getting far
      // enough from where it started to clear the test. The field distance
      // knows better -- it counts steps to the player through the building, so
      // it falls while a body is walking a corridor, climbing a flight, or
      // waiting its turn at a doorway, and only stops falling when the body has
      // genuinely stopped getting anywhere.
      if (e.alive) this._creditProgress(e, dt);

      if (e.alive && (e.stuckTimer > STUCK_LIMIT || e.embedTimer > EMBED_LIMIT)) {
        const spot = this._rescueSpot(e, target);
        if (spot) {
          e.relocate(spot.x, spot.y, spot.z);
          if (spot.barrier) e.breach = spot.barrier;
          this._emit(EV.ENEMY_RELOCATED, { id: e.id, x: spot.x, y: spot.y, z: spot.z });
        } else {
          e.stuckTimer = 0;
          e.embedTimer = 0;
        }
      }

      // Corpses linger briefly so the client can play the topple, then go.
      if (!e.alive && e.deathTimer <= -0.6) this.enemies.splice(i, 1);
    }

    // A free-for-all has no monsters, so the wave clock and the revive system
    // both go quiet: there is nothing to spawn, and nobody on your side to pick
    // you up. Respawn timers and the score race take their place.
    if (this.isFFA) {
      this._updateFFA(dt);
    } else {
      this._updateDowned(dt);
      this._updateWaves(dt);
    }
    this.elapsed += dt;
  }

  // -------------------------------------------------------------- networking

  /** Everything a joining client needs before it can render anything. */
  fullState() {
    return {
      mode: this.mode,
      winnerId: this.winnerId,
      postMatch: r2(this.postMatch),
      seed: this.seed,
      wave: this.wave,
      waveKills: this.waveKills,
      waveTotal: this.waveTotal,
      waveBreak: this.waveBreak,
      coins: this.coins,
      score: this.score,
      vending: r2(this.vendingTime),
      enemies: this.enemies.map(encodeEnemy),
      players: [...this.players.values()].map(encodePlayer),
    };
  }

  /** The per-frame delta. Small enough to send many times a second. */
  snapshot() {
    return {
      mode: this.mode,
      winnerId: this.winnerId,
      postMatch: r2(this.postMatch),
      wave: this.wave,
      waveKills: this.waveKills,
      waveTotal: this.waveTotal,
      waveBreak: this.waveBreak,
      coins: this.coins,
      score: this.score,
      vending: r2(this.vendingTime),
      enemies: this.enemies.map(encodeEnemy),
      players: [...this.players.values()].map(encodePlayer),
    };
  }
}

/**
 * A stand-in target for when every player is dead or downed. Enemies keep
 * running their normal update against it, which keeps them milling around
 * instead of freezing mid-stride while the party bleeds out.
 */
const IDLE_TARGET = {
  pos: { x: 0, y: 0, z: 0 },
  vel: { x: 0, y: 0, z: 0 },
  alive: false,
  height: 1.8,
  half: 0.35,
  damage() {},
  applyPoison() {},
};

/**
 * Wire formats. Positions are rounded to a centimetre and angles to about a
 * fifth of a degree: past that the numbers are longer than the precision is
 * worth, and this runs many times a second.
 */
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

export function encodeEnemy(e) {
  return {
    i: e.id,
    t: e.type.id,
    x: r2(e.pos.x), y: r2(e.pos.y), z: r2(e.pos.z),
    r: r3(e.yaw),
    h: Math.round(e.health),
    a: e.alive ? 1 : 0,
    w: r2(e.walkPhase),
    k: r2(e.attackTimer),
    m: r2(e.aimTimer),
    d: r2(e.deathTimer),
    // Bosses carry a wave-scaled maximum, and a lit bloater fuse is the one
    // piece of enemy state a player must never miss, so both go on the wire.
    mh: e.maxHealth,
    f: e.fuse >= 0 ? r2(e.fuse) : -1,
    // Normalised vault progress lets clients pose the body through the opening
    // while position interpolation carries the authoritative arc.
    v: e.vault ? r2(e.vault.progress) : -1,
  };
}

export function encodePlayer(p) {
  return {
    i: p.id,
    n: p.name,
    x: r2(p.pos.x), y: r2(p.pos.y), z: r2(p.pos.z),
    r: r3(p.yaw), p: r3(p.pitch),
    h: Math.round(p.health),
    a: p.alive ? 1 : 0,
    dn: p.down ? 1 : 0,
    bl: r2(p.bleed),
    rv: r2(p.reviveProgress),
    s: p.score,
    kl: p.kills,
    // FFA: the respawn clock, so a dead player's client can count itself in,
    // and their own purse -- shared coins are a co-op idea, and a duellist has
    // to be able to see what their frags have paid for.
    rs: r2(p.respawn || 0),
    c: p.coins | 0,
    wp: p.weapon,
    mv: p.moving ? 1 : 0,
    sp: p.sprinting ? 1 : 0,
  };
}

export { ENEMY_TYPES };
