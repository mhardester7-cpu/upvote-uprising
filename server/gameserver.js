// The multiplayer server: room registry, socket handling, and the master loop.
//
// One process serves both the static game files and the WebSocket traffic, on a
// single port. That is not just convenience -- most managed hosts (Railway among
// them) route one port per service, so splitting the two would mean either two
// services or a proxy in front. Sharing the HTTP server sidesteps both.

import { WebSocketServer } from 'ws';
import { randomInt } from 'node:crypto';

import { Room, MAX_PLAYERS } from './room.js';
import { Presence } from './presence.js';
import {
  C2S, S2C, makeRoomCode, normalizeRoomCode, sanitizeName, sanitizeChat,
  sanitizeClientId, normalizeVisibility, MODE,
} from '../src/net/protocol.js';
import { WEAPONS } from '../src/combat/weapons.js';
import { sameHostOrigin } from './security.js';

/** How often every room is advanced. */
const LOOP_HZ = 60;

/**
 * Per-socket message budget. A client sending far above the protocol's rates is
 * either broken or hostile; either way the room should not pay for it.
 */
const RATE_WINDOW_MS = 1000;
const RATE_LIMIT = 180;

/** Hard resource ceilings for a public, account-free endpoint. */
const MAX_PAYLOAD = 16 * 1024;
const MAX_CONNECTIONS = 2_000;
export const MAX_ROOMS = 250;

/** Drop sockets that cannot consume snapshots instead of buffering forever. */
const MAX_BACKPRESSURE = 1 << 20;

/** Per-message budgets, separate from the broad connection budget above. */
const MESSAGE_LIMITS = {
  [C2S.JOIN]: [4, 10_000],
  [C2S.STATE]: [40, 1_000],
  [C2S.DAMAGE]: [60, 1_000],
  [C2S.HIT_PLAYER]: [1, 1_000], // FFA is not exposed in the public launch.
  [C2S.EXPLOSION]: [8, 1_000],
  [C2S.DOWN]: [4, 1_000],
  [C2S.SNAP]: [1, 10_000],
  [C2S.VENDING]: [4, 10_000],
  [C2S.BUY]: [12, 1_000],
  [C2S.READY]: [4, 1_000],
  [C2S.CHAT]: [6, 5_000],
  [C2S.PING]: [4, 5_000],
};

const WEAPON_IDS = new Set(WEAPONS.map((weapon) => weapon.id));
const DOOR_PRICES = new Set([750, 1_000, 1_250, 1_500, 1_750, 2_000, 2_750, 4_500]);

/**
 * How often the live count is sampled for its peak.
 *
 * The master loop runs at 60Hz and the sample walks every tracked client, so
 * sampling every tick would spend real CPU counting people instead of
 * simulating them. Two seconds is far finer than anything the peak is used for.
 */
const PRESENCE_SAMPLE_MS = 2000;

export class GameServer {
  constructor() {
    this.rooms = new Map();          // code -> Room
    this.wss = null;
    this.timer = null;
    this.heartbeatTimer = null;
    /**
     * Solo players, who hold no socket and would otherwise be invisible here.
     * See presence.js for why they have to announce themselves.
     */
    this.presence = new Presence();
    this._lastPresenceSample = 0;
  }

  attach(httpServer) {
    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      maxPayload: MAX_PAYLOAD,
      perMessageDeflate: false,
      verifyClient: ({ req }, done) => {
        if (!sameHostOrigin(req)) {
          done(false, 403, 'Origin refused');
          return;
        }
        if (this.wss?.clients.size >= MAX_CONNECTIONS) {
          done(false, 503, 'Server full');
          return;
        }
        done(true);
      },
    });
    this.wss.on('connection', (socket, req) => this._onConnection(socket, req));

    this.timer = setInterval(() => this._loop(), 1000 / LOOP_HZ);
    // A stray interval should never be the reason a process refuses to exit.
    this.timer.unref?.();

    // Ping is what turns isAlive from a comment into a liveness check. Mobile
    // networks routinely leave half-open TCP sessions behind; without this,
    // every one remains in its room and in memory until the process restarts.
    this.heartbeatTimer = setInterval(() => {
      for (const socket of this.wss.clients) {
        if (!socket.isAlive) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        socket.ping();
      }
    }, 30_000);
    this.heartbeatTimer.unref?.();
    return this;
  }

  close() {
    clearInterval(this.timer);
    clearInterval(this.heartbeatTimer);
    for (const socket of this.wss?.clients ?? []) socket.terminate();
    this.wss?.close();
  }

  // ------------------------------------------------------------------- rooms

  /** An existing room, or null. */
  findRoom(code) {
    const norm = normalizeRoomCode(code);
    return norm ? this.rooms.get(norm) ?? null : null;
  }

  /** Find a room by code, or create it. Codes are generated when absent. */
  getOrCreateRoom(code, mode, visibility) {
    const norm = normalizeRoomCode(code);
    if (norm && this.rooms.has(norm)) return this.rooms.get(norm);

    let finalCode = norm;
    if (!finalCode) {
      if (this.rooms.size >= MAX_ROOMS) return null;
      const secureRandom = () => randomInt(0, 0x100000000) / 0x100000000;
      do { finalCode = makeRoomCode(secureRandom); } while (this.rooms.has(finalCode));
    }
    // Distinct seed per room, so two lobbies are not the same map.
    const seed = (Math.floor(Math.random() * 0x7fffffff)) | 0;
    const room = new Room(finalCode, seed, mode, visibility);
    this.rooms.set(finalCode, room);
    console.log(
      `  [room ${finalCode}] created (seed ${seed}, ${room.sim.mode}, ${room.visibility})`);
    return room;
  }

  /**
   * The public lobby browser.
   *
   * Private rooms are absent entirely -- that is the whole of what private
   * means here. Full ones are kept and flagged rather than hidden, because a
   * list that silently drops them reads as "nobody is playing" on exactly the
   * busy server where the opposite is true.
   *
   * Ordered the way someone looking for a game wants it: rooms they can
   * actually join first, then the ones that have not started yet -- joining
   * before the first wave means nothing has happened without you -- then the
   * fullest, because a room with people in it is a better game than an empty
   * one waiting on a host who may have wandered off.
   */
  listRooms() {
    const out = [];
    for (const r of this.rooms.values()) {
      if (r.isEmpty || !r.isPublic) continue;
      out.push(r.listing());
    }
    return out.sort((a, b) => (
      (a.full ? 1 : 0) - (b.full ? 1 : 0)
      || (a.started ? 1 : 0) - (b.started ? 1 : 0)
      || b.players - a.players
    )).slice(0, 20);
  }

  // ---------------------------------------------------------------- presence

  /**
   * The client ids of everyone currently holding a socket, private rooms
   * included.
   *
   * Private is about who can *find* a room, not about whether the people in it
   * are playing -- a headcount that skipped them would under-report the server
   * every time friends played together with the listing turned off. What stays
   * private is the code, and that is enforced in live() rather than here.
   *
   * Keyed by client id so two tabs from one browser count once. A member with
   * no cid -- an older client, or one with storage disabled -- falls back to a
   * key unique to their seat, because the alternative is every such player
   * collapsing into a single phantom.
   */
  connectedIds() {
    const ids = new Set();
    for (const room of this.rooms.values()) {
      for (const m of room.members.values()) {
        ids.add(m.cid || `seat:${room.code}:${m.id}`);
      }
    }
    return ids;
  }

  /**
   * Everything the live counter and its dashboard need, in one object.
   *
   * The aggregate numbers cover every room; the `rooms` array is the public
   * lobby and nothing else. Keeping both in one payload is what lets the
   * dashboard say "14 playing across 3 rooms" while still refusing to name the
   * private room two of them are in.
   */
  live(now = Date.now()) {
    const snap = this.presence.snapshot(this.connectedIds(), now);
    let rooms = 0;
    for (const r of this.rooms.values()) if (!r.isEmpty) rooms++;
    return {
      ...snap,
      rooms,
      publicRooms: this.listRooms(),
      uptimeSec: Math.round(process.uptime()),
    };
  }

  _loop() {
    const now = Date.now();

    // Sample the count on a timer so the peak reflects when people actually
    // played, not when somebody happened to be watching the dashboard.
    if (now - this._lastPresenceSample >= PRESENCE_SAMPLE_MS) {
      this._lastPresenceSample = now;
      this.presence.snapshot(this.connectedIds(), now);
    }

    for (const [code, room] of this.rooms) {
      if (room.expired(now)) {
        this.rooms.delete(code);
        console.log(`  [room ${code}] collected`);
        continue;
      }
      if (!room.isEmpty) room.update();
    }
  }

  // ----------------------------------------------------------------- sockets

  _onConnection(socket, req) {
    // Per-connection state. The socket is not in a room until it says JOIN.
    const conn = {
      room: null,
      id: null,
      name: 'PLAYER',
      alive: true,
      count: 0,
      windowStart: Date.now(),
      limits: new Map(),
      purchaseLevels: new Map(),
    };
    socket.conn = conn;

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Text messages only');
        return;
      }
      // Rate limit before parsing, so a flood costs as little as possible.
      const now = Date.now();
      if (now - conn.windowStart > RATE_WINDOW_MS) {
        conn.windowStart = now;
        conn.count = 0;
      }
      if (++conn.count > RATE_LIMIT) {
        socket.close(1008, 'Rate limit');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;   // malformed frames are dropped silently
      }
      if (!msg || typeof msg.type !== 'string') return;
      if (!this._withinMessageLimit(conn, msg.type, now)) return;

      try {
        this._handle(socket, conn, msg);
      } catch (err) {
        console.error('  message handler failed:', err?.message);
      }
    });

    const drop = () => {
      if (conn.room && conn.id != null) conn.room.leave(conn.id);
      conn.room = null;
    };
    socket.on('close', drop);
    socket.on('error', drop);

    // Liveness: a socket that stops answering pings is gone even if TCP has not
    // noticed yet, which is common behind mobile networks and load balancers.
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
  }

  _withinMessageLimit(conn, type, now) {
    const rule = MESSAGE_LIMITS[type];
    if (!rule) return true;
    const [limit, windowMs] = rule;
    let state = conn.limits.get(type);
    if (!state || now - state.started >= windowMs) {
      state = { started: now, count: 0 };
      conn.limits.set(type, state);
    }
    state.count += 1;
    return state.count <= limit;
  }

  _handle(socket, conn, msg) {
    switch (msg.type) {
      case C2S.JOIN: return this._onJoin(socket, conn, msg);
      case C2S.PING: {
        const t = Number(msg.t);
        if (Number.isFinite(t)) return this._send(socket, S2C.PONG, { t });
        return;
      }
      default:
        break;
    }

    // Everything else requires membership in a room.
    const room = conn.room;
    if (!room || conn.id == null) return;

    switch (msg.type) {
      case C2S.STATE:
        room.sim.applyPlayerState(conn.id, msg);
        break;

      case C2S.DAMAGE: {
        const amount = Number(msg.amount);
        if (!Number.isFinite(amount) || amount <= 0) break;
        room.sim.damageEnemy(msg.id, Math.min(amount, 1_000), conn.id, { headshot: !!msg.headshot });
        break;
      }

      // Competitive PvP is intentionally not exposed in the public launch.
      // Client-authoritative hit reports are acceptable against AI, but not
      // against another person whose match they can ruin.
      case C2S.HIT_PLAYER:
        break;

      case C2S.EXPLOSION: {
        // Splash is resolved server-side so every client agrees on who died.
        const { x, y, z } = msg;
        const radius = Number(msg.radius), damage = Number(msg.damage);
        if (![x, y, z, radius, damage].every(Number.isFinite)) break;
        if (radius <= 0 || damage <= 0) break;
        this._resolveExplosion(room, conn.id, x, y, z, radius, damage);
        break;
      }

      case C2S.DOWN:
        room.sim.downPlayer(conn.id);
        break;

      case C2S.SNAP:
        // Gathering all five stones is hard enough that the payoff is shared:
        // one player's snap clears the wave for the whole room.
        room.sim.snap(conn.id);
        break;

      case C2S.VENDING:
        room.sim.activateBananaVending(conn.id);
        break;

      case C2S.BUY: {
        // The pot is shared, so the server is the only thing that can settle
        // two players spending the last of it at the same moment. The effect
        // is applied by the client, but only once this confirmation lands.
        //
        // In a free-for-all there is no shared pot: a duellist spends what their
        // own frags paid them, so the purchase is settled against their purse.
        const quote = this._quotePurchase(conn, room, msg);
        if (!quote) {
          this._send(socket, S2C.ERROR, { message: 'That purchase is not available.' });
          break;
        }
        const paid = room.sim.spendCoins(quote.cost);
        if (paid) {
          if (quote.levelKey) {
            conn.purchaseLevels.set(quote.levelKey, (conn.purchaseLevels.get(quote.levelKey) ?? 0) + 1);
          }
          this._send(socket, S2C.BUY_OK, { item: quote.item });
        } else {
          this._send(socket, S2C.ERROR, { message: 'Not enough coins.' });
        }
        break;
      }

      case C2S.READY:
        // The client has its world built and is standing in it. Until at least
        // one member says this, the room holds the clock so the opening grace is
        // not spent on a loading screen.
        room.setReady(conn.id, msg.ready !== false);
        break;

      case C2S.CHAT: {
        const text = sanitizeChat(msg.text);
        if (!text) break;
        room.broadcast(S2C.CHAT, { id: conn.id, name: conn.name, text });
        break;
      }

      default:
        break;
    }
  }

  /**
   * Re-price the between-wave armoury on the server.
   *
   * World interactions carry a narrow item id and accept only authored prices.
   * Catalogue items are priced from their id and level. In both cases a
   * browser cannot spend zero coins from devtools and still mutate the shared
   * pot as though it had paid the real price.
   */
  _quotePurchase(conn, room, msg) {
    const sent = Number(msg.cost);
    if (!Number.isFinite(sent) || sent < 0 || sent > 100_000) return null;

    const item = typeof msg.item === 'string' ? msg.item : '';
    if (!item) return null;

    if (item === 'door') {
      return DOOR_PRICES.has(sent) ? { item, cost: sent, levelKey: null } : null;
    }
    if (item === 'mystery-box') return { item, cost: 950, levelKey: null };
    if (item === 'dinosaur-factory') return { item, cost: 1_500, levelKey: null };

    const weapon = WEAPON_IDS.has(msg.weapon) ? msg.weapon : null;
    const levelled = (base, step, max, key) => {
      const level = conn.purchaseLevels.get(key) ?? 0;
      if (level >= max) return null;
      return { item, cost: base + level * step, levelKey: key };
    };

    switch (item) {
      case 'ammo': return { item, cost: 180 + room.sim.wave * 25, levelKey: null };
      case 'medkit': return { item, cost: 200 + room.sim.wave * 30, levelKey: null };
      case 'potion': return { item, cost: 450, levelKey: null };
      case 'vitality': return levelled(600, 350, 4, 'vitality');
      case 'damage': return weapon ? levelled(500, 400, 5, `damage:${weapon}`) : null;
      case 'rate': return weapon ? levelled(450, 350, 5, `rate:${weapon}`) : null;
      case 'mag': return weapon ? levelled(400, 300, 4, `mag:${weapon}`) : null;
      case 'bazooka': return levelled(1_200, 0, 1, 'bazooka');
      case 'airstrike': return levelled(2_200, 0, 1, 'airstrike');
      default: return null;
    }
  }

  /**
   * Apply splash damage to everything in range, falling off linearly. Mirrors
   * the client's own explosion maths so the feedback a shooter sees locally
   * matches what the server actually awards.
   */
  _resolveExplosion(room, byId, x, y, z, radius, damage) {
    const r = Math.min(radius, 30);
    const dmg = Math.min(damage, 1000);
    for (const e of [...room.sim.enemies]) {
      if (!e.alive) continue;
      const cx = e.pos.x, cy = e.pos.y + e.type.height * 0.5, cz = e.pos.z;
      const d = Math.hypot(cx - x, cy - y, cz - z);
      if (d > r) continue;
      const falloff = 1 - d / r;
      room.sim.damageEnemy(e.id, dmg * falloff, byId, { splash: true });
    }

    // In a free-for-all the blast has to reach players too, or the rocket
    // launcher and the airstrike -- both of which a duellist can buy out of the
    // armoury -- are money spent on scenery. hitPlayer rules on each one, so a
    // splash frag is credited and scored exactly like a bullet.
    if (!room.sim.isFFA) return;
    for (const p of [...room.sim.players.values()]) {
      if (p.id === byId || !p.alive || p.down) continue;
      const d = Math.hypot(p.pos.x - x, p.pos.y + 0.9 - y, p.pos.z - z);
      if (d > r) continue;
      room.sim.hitPlayer(byId, p.id, dmg * (1 - d / r), false);
    }
  }

  _onJoin(socket, conn, msg) {
    if (conn.room) return;   // already in a room

    const name = sanitizeName(msg.name);
    const wanted = normalizeRoomCode(msg.room);

    // Hosting (no code) allocates one. Joining names a specific room, and a
    // code matching nothing has to say so: quietly creating it instead drops
    // the player into their own empty world that looks exactly like a
    // successful join, which is indistinguishable from co-op being broken.
    let room;
    if (!wanted) {
      // Only the host chooses, and that goes for both the rule set and whether
      // the room is listed. A joiner's request for either is ignored on purpose:
      // the room already exists, and honouring the joiner would mean flipping it
      // under the players already in it -- including quietly delisting a public
      // game, or publishing one somebody opened privately.
      // Co-op is the launch surface. PvP still exists behind internal tests,
      // but is not safe to expose until hit validation is server-authoritative.
      room = this.getOrCreateRoom('', MODE.COOP, normalizeVisibility(msg.visibility));
      if (!room) {
        this._send(socket, S2C.ERROR, { message: 'The server is at room capacity. Try again soon.' });
        return;
      }
    } else {
      room = this.findRoom(wanted);
      if (!room) {
        this._send(socket, S2C.ERROR, {
          message: `No room called ${wanted}. Check the code, or host a game.`,
        });
        return;
      }
    }

    if (room.isFull) {
      this._send(socket, S2C.ERROR, { message: 'That room is full.' });
      return;
    }

    const id = room.join(socket, name, sanitizeClientId(msg.cid));
    conn.room = room;
    conn.id = id;
    conn.name = name;

    this._send(socket, S2C.WELCOME, {
      id,
      room: room.code,
      seed: room.seed,
      mode: room.sim.mode,
      state: room.sim.fullState(),
    });
    console.log(`  [room ${room.code}] ${name} joined (${room.size}/${MAX_PLAYERS})`);
  }

  _send(socket, type, payload) {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > MAX_BACKPRESSURE) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify({ type, ...payload }));
  }
}
