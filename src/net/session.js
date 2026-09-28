// Sessions: the one surface the game talks to for enemies, waves, and coins.
//
// LocalSession ticks a GameSim in this tab. NetSession reads a GameSim that is
// being ticked on the server. The game itself cannot tell them apart, which is
// the point -- single player exercises the same reconcile-and-render path that
// co-op depends on, so the networked mode is not a rarely-trodden side branch.
//
// The division of labour in co-op is the standard one for a PvE shooter:
//
//   your player   simulated locally, never waits for the server
//   your shots    resolved locally for instant feedback, reported upward
//   enemies       owned by the server, interpolated here
//   score/coins   awarded by the server, so both players agree on the total
//
// Local shot resolution means a hitmarker appears on the frame you click. The
// server's snapshot corrects enemy health a moment later. Scoring only ever
// happens on the server's word, so a predicted kill that the server disagrees
// with costs a splash of blood, not points.

import { GameSim, SIM_DT, EV } from '../sim/gamesim.js';
import { ENEMY_TYPES } from '../entities/enemy.js';
import { NetClient } from './netclient.js';
import { C2S } from './protocol.js';

export { EV };

/** Shared empty list, so the no-PvP path allocates nothing per frame. */
const EMPTY = [];

/**
 * A server-owned enemy as this client sees it: interpolated position, and the
 * same two hitboxes the real Enemy exposes so local hit detection is identical.
 */
export class NetEnemy {
  constructor(id, typeId) {
    this.id = id;
    this.type = ENEMY_TYPES[typeId] || ENEMY_TYPES.grunt;
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.health = this.type.health;
    this.maxHealth = this.type.health;
    this.alive = true;
    this.walkPhase = 0;
    this.attackTimer = 0;
    this.aimTimer = 0;
    this.deathTimer = 0;
    this.hitFlash = 0;
    this.stuckTimer = 0;
    this.fuse = -1;
    this.enraged = false;
    this.vault = null;
    this.group = null;
    this._portalCooldown = 0;
  }

  get half() { return this.type.width * 0.5; }
  get height() { return this.type.height; }
  _headHeight() { return this.type.height * 0.28; }

  bodyBox() {
    const h = this.half;
    const headH = this._headHeight();
    return {
      minX: this.pos.x - h, maxX: this.pos.x + h,
      minY: this.pos.y, maxY: this.pos.y + this.type.height - headH,
      minZ: this.pos.z - h, maxZ: this.pos.z + h,
    };
  }

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

  center(out = {}) {
    out.x = this.pos.x;
    out.y = this.pos.y + this.type.height * 0.55;
    out.z = this.pos.z;
    return out;
  }

  /**
   * Predicted damage. Health is advisory here -- the server's snapshot is the
   * truth and will overwrite it -- but applying it immediately is what makes a
   * health bar drain on the frame the shot lands.
   */
  damage(amount) {
    if (!this.alive) return false;
    this.health -= amount;
    this.hitFlash = 1;
    if (this.health <= 0) {
      this.health = 0;
      // Deliberately *not* setting alive = false: the server decides when an
      // enemy dies. Predicting the kill locally would double-count it against
      // the authoritative enemyKilled event a moment later.
      return false;
    }
    return false;
  }

  applyNet(a, b, k, dt = 0) {
    const oldX = this.pos.x;
    const oldY = this.pos.y;
    const oldZ = this.pos.z;
    this.pos.x = a.x + (b.x - a.x) * k;
    this.pos.y = a.y + (b.y - a.y) * k;
    this.pos.z = a.z + (b.z - a.z) * k;
    if (dt > 0) {
      this.vel.x = (this.pos.x - oldX) / dt;
      this.vel.y = (this.pos.y - oldY) / dt;
      this.vel.z = (this.pos.z - oldZ) / dt;
    } else {
      this.vel.x = this.vel.y = this.vel.z = 0;
    }
    this.yaw = lerpAngle(a.r, b.r, k);
    this.walkPhase = b.w;
    this.attackTimer = b.k;
    this.aimTimer = b.m;
    this.deathTimer = b.d;
    this.health = b.h;
    this.maxHealth = b.mh || this.maxHealth;
    this.fuse = b.f;
    this.enraged = !!this.type.enrageAt && this.health <= this.maxHealth * this.type.enrageAt;
    this.alive = b.a === 1;
    const av = a.v ?? -1;
    const bv = b.v ?? -1;
    if (bv >= 0) {
      // Progress is pose data, just like position. Snapping it to the newest
      // 20 Hz snapshot made the planted takeoff and landing stutter in co-op
      // even while the body itself moved smoothly between snapshots.
      const from = av >= 0 ? av : 0;
      this.vault = { progress: from + (bv - from) * k };
    } else if (av >= 0 && k < 1) {
      // Let the last airborne snapshot finish its landing pose while position
      // interpolates to the first grounded one, then release the state.
      this.vault = { progress: av + (1 - av) * k };
    } else {
      this.vault = null;
    }
  }
}

/**
 * A player's hitbox, in the shape combat.js expects from an enemy type. Slimmer
 * than a grunt: a human silhouette that was as wide as a zombie would make
 * free-for-all duels feel like shooting barns.
 */
const REMOTE_HITBOX = { id: 'player', width: 0.62, height: 1.8, label: 'PLAYER', bodyColor: 0xffcf4d };
const REMOTE_HEAD = REMOTE_HITBOX.height * 0.28;

/** A co-op partner -- or, in a free-for-all, a target. */
export class RemotePlayer {
  constructor(id, name) {
    this.id = id;
    this.name = name || 'PLAYER';
    this.pos = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;
    this.health = 100;
    this.alive = true;
    this.down = false;
    this.bleed = 0;
    this.reviveProgress = 0;
    this.score = 0;
    this.kills = 0;
    this.weapon = 'PISTOL';
    this.moving = false;
    this.walkPhase = 0;
    this.group = null;
    this.label = null;
    /** FFA: seconds until they drop back in, straight off the wire. */
    this.respawn = 0;
  }

  /**
   * Hitbox shims, so a remote player can be handed to combat.js's tracer
   * alongside the zombies.
   *
   * traceShot only ever asks a target for `alive`, `type.height`, `pos`,
   * `bodyBox()` and `headBox()`. Satisfying that here means free-for-all fire
   * reuses the exact tracing, range falloff and headshot logic the co-op guns
   * already use, instead of growing a second, subtly different hit path that
   * would drift from it.
   */
  get type() { return REMOTE_HITBOX; }

  bodyBox() {
    const half = REMOTE_HITBOX.width * 0.5;
    return {
      minX: this.pos.x - half, maxX: this.pos.x + half,
      minY: this.pos.y, maxY: this.pos.y + REMOTE_HITBOX.height - REMOTE_HEAD,
      minZ: this.pos.z - half, maxZ: this.pos.z + half,
    };
  }

  headBox() {
    const hw = REMOTE_HITBOX.width * 0.31;
    return {
      minX: this.pos.x - hw, maxX: this.pos.x + hw,
      minY: this.pos.y + REMOTE_HITBOX.height - REMOTE_HEAD,
      maxY: this.pos.y + REMOTE_HITBOX.height,
      minZ: this.pos.z - hw, maxZ: this.pos.z + hw,
    };
  }

  /**
   * Never applies damage locally. Two clients each concluding they killed the
   * other is precisely the disagreement the authoritative sim exists to settle,
   * so a hit is reported upward and the server rules on it.
   */
  damage() { return false; }

  applyNet(a, b, k, dt) {
    this.pos.x = a.x + (b.x - a.x) * k;
    this.pos.y = a.y + (b.y - a.y) * k;
    this.pos.z = a.z + (b.z - a.z) * k;
    this.yaw = lerpAngle(a.r, b.r, k);
    this.pitch = a.p + (b.p - a.p) * k;
    this.health = b.h;
    this.alive = b.a === 1;
    this.down = b.dn === 1;
    this.bleed = b.bl;
    this.reviveProgress = b.rv;
    this.score = b.s;
    this.kills = b.kl;
    this.respawn = b.rs ?? 0;
    this.weapon = b.wp;
    this.moving = b.mv === 1;
    this.name = b.n || this.name;

    // Drive the walk cycle off actual travel, so a partner's legs match how
    // fast they are really moving rather than a flag that says "moving".
    const speed = Math.hypot(b.x - a.x, b.z - a.z);
    this.walkPhase += (this.moving ? Math.max(speed * 6, 4) : 0) * (dt || 0.016) * 1.6;
  }
}

/** Shortest-arc angle blend, so yaw never spins the long way round PI. */
function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

// --------------------------------------------------------------------------

/** Single player: a GameSim ticked right here. */
export class LocalSession {
  constructor(world, seed) {
    this.multiplayer = false;
    this.sim = new GameSim(seed, { world });
    this.sim.running = true;
    this.selfId = 1;
    this.sim.addPlayer(this.selfId, 'YOU');
    this.remotes = [];
    /** Bodies retired by the sim but still owning a render mesh. */
    this.removed = [];
    this.ping = 0;
    this.room = null;
  }

  get world() { return this.sim.world; }
  get enemies() { return this.sim.enemies; }
  get wave() { return this.sim.wave; }
  get waveKills() { return this.sim.waveKills; }
  get waveTotal() { return this.sim.waveTotal; }
  get waveBreak() { return this.sim.waveBreak; }
  get coins() { return this.sim.coins; }
  get score() { return this.sim.score; }
  get vendingTime() { return this.sim.vendingTime; }

  reset() {
    this.removed.length = 0;
    this.sim.resetRun();
  }

  /** Push the real player's state into the sim so enemies chase the truth. */
  reportState(player, dt) {
    const p = this.sim.players.get(this.selfId);
    if (!p) return;
    p.pos.x = player.pos.x; p.pos.y = player.pos.y; p.pos.z = player.pos.z;
    p.yaw = player.yaw;
    p.pitch = player.pitch;
    p.health = player.health;
    p.alive = player.alive;
    void dt;
  }

  tick(dt) {
    // GameSim removes a corpse from its array once the topple has played. Keep
    // the retired object until the renderer has reclaimed its mesh; looking in
    // sim.enemies after tick can never find something that was just spliced.
    const before = this.sim.enemies.slice();
    this.sim.tick(dt);
    const live = new Set(this.sim.enemies);
    for (const e of before) if (!live.has(e)) this.removed.push(e);
  }

  /** Interpolation is meaningless locally; the sim is already current. */
  interpolate() {}

  damageEnemy(enemy, amount, opts = {}) {
    return this.sim.damageEnemy(enemy.id, amount, this.selfId, opts);
  }

  explosion(x, y, z, radius, damage) {
    for (const e of [...this.sim.enemies]) {
      if (!e.alive) continue;
      const d = Math.hypot(e.pos.x - x, e.pos.y + e.type.height * 0.5 - y, e.pos.z - z);
      if (d > radius) continue;
      this.sim.damageEnemy(e.id, damage * (1 - d / radius), this.selfId, { splash: true });
    }
  }

  snap() { return this.sim.snap(this.selfId); }
  activateBananaVending() { return this.sim.activateBananaVending(this.selfId); }
  /** Single player is always co-op rules: there is nobody else to shoot. */
  get mode() { return this.sim.mode; }
  get isFFA() { return false; }
  get pvpTargets() { return EMPTY; }
  hitPlayer() {}
  reportDown() {}
  sendChat() {}
  drainEvents() { return this.sim.drainEvents(); }
  drainChat() { return null; }
  addCoins(n) { this.sim.addCoins(n); }
  spendCoins(n) { return this.sim.spendCoins(n); }
  disconnect() {}
}

// --------------------------------------------------------------------------

/** Co-op: enemies and waves come from the server. */
export class NetSession {
  constructor(net, world) {
    this.multiplayer = true;
    this.net = net;
    this._world = world;
    this.selfId = net.selfId;
    this.room = net.room;

    this.enemies = [];
    this._byId = new Map();
    this.remotes = [];
    this._remoteById = new Map();

    this.wave = 0;
    this.waveKills = 0;
    this.waveTotal = 0;
    this.waveBreak = 0;
    this.coins = 0;
    this.score = 0;
    this.vendingTime = -1;

    /** Ids that appeared or vanished since the last frame, for mesh upkeep. */
    this.added = [];
    this.removed = [];
    this.remotesAdded = [];
    this.remotesRemoved = [];
  }

  get world() { return this._world; }
  get ping() { return this.net.ping; }

  reset() {}

  reportState(player, dt) {
    this.net.reportState(player, dt, {
      weapon: player._weaponName || 'PISTOL',
      moving: Math.hypot(player.vel.x, player.vel.z) > 1.2,
      sprinting: !!player.sprinting,
    });
  }

  /** The server ticks the sim; nothing to advance here. */
  tick() {}

  /**
   * Rebuild the visible entity lists from the snapshot buffer. Called once per
   * rendered frame rather than per simulation tick, because this is purely
   * about what is on screen.
   */
  interpolate(dt) {
    const win = this.net.interpolationWindow();
    if (!win) return;
    const { a, b, k } = win;

    // Scalars come from the newest snapshot: blending a wave counter would only
    // make it briefly wrong.
    this.wave = b.wave;
    this.waveKills = b.waveKills;
    this.waveTotal = b.waveTotal;
    this.waveBreak = b.waveBreak;
    this.coins = b.coins;
    this.score = b.score;
    this.vendingTime = b.vending ?? -1;

    this._syncEnemies(a, b, k, dt);
    this._syncPlayers(a, b, k, dt);

    // A free-for-all has no shared pot and no shared tally: both are personal,
    // so they come off our own row rather than the room's totals. Read after
    // the player sync, which is what sets `self`.
    if (this.isFFA && this.self) {
      this.coins = this.self.c ?? 0;
      this.score = this.self.s ?? 0;
    }
  }

  _syncEnemies(a, b, k, dt) {
    this.added.length = 0;
    this.removed.length = 0;

    const prev = new Map();
    for (const e of a.enemies) prev.set(e.i, e);

    const seen = new Set();
    for (const ne of b.enemies) {
      seen.add(ne.i);
      let e = this._byId.get(ne.i);
      if (!e) {
        e = new NetEnemy(ne.i, ne.t);
        this._byId.set(ne.i, e);
        this.enemies.push(e);
        this.added.push(e);
        // A brand new enemy has no previous sample to blend from, so it starts
        // exactly where the server says rather than sliding in from the origin.
        e.applyNet(ne, ne, 0);
        continue;
      }
      e.applyNet(prev.get(ne.i) || ne, ne, k, dt);
      e.hitFlash = Math.max(0, e.hitFlash - dt * 5);
    }

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (seen.has(e.id)) continue;
      this.enemies.splice(i, 1);
      this._byId.delete(e.id);
      this.removed.push(e);
    }
  }

  _syncPlayers(a, b, k, dt) {
    this.remotesAdded.length = 0;
    this.remotesRemoved.length = 0;

    const prev = new Map();
    for (const p of a.players) prev.set(p.i, p);

    const seen = new Set();
    for (const np of b.players) {
      if (np.i === this.selfId) { this.self = np; continue; }
      seen.add(np.i);
      let rp = this._remoteById.get(np.i);
      if (!rp) {
        rp = new RemotePlayer(np.i, np.n);
        this._remoteById.set(np.i, rp);
        this.remotes.push(rp);
        this.remotesAdded.push(rp);
        rp.applyNet(np, np, 0, dt);
        continue;
      }
      rp.applyNet(prev.get(np.i) || np, np, k, dt);
    }

    for (let i = this.remotes.length - 1; i >= 0; i--) {
      const rp = this.remotes[i];
      if (seen.has(rp.id)) continue;
      this.remotes.splice(i, 1);
      this._remoteById.delete(rp.id);
      this.remotesRemoved.push(rp);
    }
  }

  damageEnemy(enemy, amount, opts = {}) {
    // Predict locally for feel, report upward for truth.
    enemy.damage(amount);
    this.net.damageEnemy(enemy.id, amount, opts.headshot);
    return { killed: false, enemy };
  }

  explosion(x, y, z, radius, damage) {
    this.net.explosion(x, y, z, radius, damage);
  }

  get mode() { return this.net.mode; }
  get isFFA() { return this.net.mode === 'ffa'; }

  /**
   * Who this client may shoot. Empty in co-op, which is what keeps a stray
   * shotgun pellet in a corridor from being a betrayal -- friendly fire is not
   * disabled downstream, it simply never has a target to find.
   */
  get pvpTargets() { return this.isFFA ? this.remotes : EMPTY; }

  /** Predicted nothing, reported everything -- the server rules on the kill. */
  hitPlayer(remote, amount, opts = {}) {
    this.net.hitPlayer(remote.id, amount, opts.headshot);
  }

  snap() {
    this.net.send(C2S.SNAP, {});
    // Report what is on screen right now; the server's wipe lands a moment
    // later and the real count arrives with it.
    return this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
  }

  activateBananaVending() {
    this.net.send(C2S.VENDING, {});
    return true;
  }

  reportDown() { this.net.reportDown(); }
  sendChat(text) { this.net.sendChat(text); }
  drainEvents() { return this.net.drainEvents(); }
  drainChat() { return this.net.drainChat(); }

  addCoins() { /* the server owns the pot */ }
  spendCoins(n, item) {
    this.net.send(C2S.BUY, { cost: n, item });
    return this.coins >= n;
  }

  disconnect() { this.net.disconnect(); }
}

export { NetClient, SIM_DT };
