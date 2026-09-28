// The client half of the co-op link: one socket, a snapshot buffer, and the
// bookkeeping that turns a 20Hz packet stream into something smooth enough to
// render at 144fps.
//
// Interpolation strategy
// ----------------------
// Remote entities are rendered on a deliberate delay -- one snapshot interval
// plus a small cushion -- and interpolated between the two snapshots that
// straddle that delayed clock. Rendering "now" would mean extrapolating past
// the newest packet and constantly correcting, which reads as jitter. Trading a
// tenth of a second of latency for motion that never snaps is the right deal
// for everything except your own player, which is simulated locally and never
// waits for the server at all.

import { C2S, S2C, SNAPSHOT_HZ, STATE_HZ } from './protocol.js';
import { clientId } from './presence.js';

/** How far behind the newest snapshot remote entities are rendered. */
const INTERP_DELAY_MS = (1000 / SNAPSHOT_HZ) * 1.6;

/** Snapshots kept for interpolation. Two is the minimum; more absorbs jitter. */
const BUFFER_MAX = 12;

export const NET = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  JOINED: 'joined',
  CLOSED: 'closed',
  ERROR: 'error',
};

export class NetClient {
  constructor() {
    this.socket = null;
    this.status = NET.IDLE;
    this.selfId = null;
    this.room = null;
    this.seed = null;
    /** Which rule set the room handed us. The host chose it; we obey. */
    this.mode = 'coop';
    this.wave = 0;
    this.waveBreak = 0;
    this.error = null;

    /** Ring of { t, s } snapshots, oldest first. */
    this.buffer = [];
    /** Server events not yet consumed by the game. */
    this.pending = [];
    /** Chat lines not yet consumed. */
    this.chat = [];
    /** Confirmed purchases, awaiting the client applying their effects. */
    this.purchases = [];
    /** Non-fatal server messages, for the feed. */
    this.notices = [];

    this.ping = 0;
    this._pingTimer = 0;
    this._stateTimer = 0;
    this._stateInterval = 1 / STATE_HZ;

    /** Offset between the server clock and ours, so buffered times line up. */
    this._clockOffset = null;

    this.onJoin = null;      // (id, name)
    this.onLeave = null;     // (id, name)
    this.onStatus = null;    // (status)
  }

  get connected() { return this.status === NET.JOINED; }

  /**
   * Connect and join a room. An empty code asks the server to allocate one.
   * Resolves once the server has sent WELCOME.
   *
   * `mode` and `visibility` are the host's choices and are ignored by the
   * server when a code names a room that already exists.
   */
  connect(room, name, mode = 'coop', visibility = 'private') {
    return new Promise((resolve, reject) => {
      // Same host, same port -- the game server carries both. wss:// whenever
      // the page itself is https, or browsers refuse the mixed-content upgrade.
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/ws`;

      let settled = false;
      this._setStatus(NET.CONNECTING);

      let socket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        this.error = err?.message || 'Could not open a connection.';
        this._setStatus(NET.ERROR);
        reject(new Error(this.error));
        return;
      }
      this.socket = socket;

      const fail = (message) => {
        if (settled) return;
        settled = true;
        this.error = message;
        this._setStatus(NET.ERROR);
        reject(new Error(message));
      };

      const timeout = setTimeout(() => {
        fail('The server did not answer in time.');
        socket.close();
      }, 10_000);

      socket.onopen = () => {
        socket.send(JSON.stringify({
          // `cid` is for the headcount only: it lets the server see that the
          // player who was beating from the menu and the socket that just
          // arrived are one person, rather than counting them twice for a TTL.
          type: C2S.JOIN, room: room || '', name, mode, visibility, cid: clientId(),
        }));
      };

      socket.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }

        if (msg.type === S2C.WELCOME) {
          clearTimeout(timeout);
          this.selfId = msg.id;
          this.room = msg.room;
          this.seed = msg.seed;
          this.mode = msg.mode || 'coop';
          // Kept so the caller can tell an opened room from one already mid-wave
          // and warn the player before anything shoots at them.
          this.wave = msg.state?.wave ?? 0;
          this.waveBreak = msg.state?.waveBreak ?? 0;
          this.buffer.length = 0;
          if (msg.state) this._pushSnapshot(msg.state, Date.now());
          this._setStatus(NET.JOINED);
          settled = true;
          resolve(msg);
          return;
        }

        if (msg.type === S2C.ERROR) {
          fail(msg.message || 'The server refused the connection.');
          socket.close();
          return;
        }

        this._handle(msg);
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        fail('Could not reach the server.');
      };

      socket.onclose = () => {
        clearTimeout(timeout);
        if (!settled) { fail('The connection closed before joining.'); return; }
        if (this.status === NET.JOINED) this._setStatus(NET.CLOSED);
      };
    });
  }

  disconnect() {
    if (this.socket && this.socket.readyState <= 1) this.socket.close();
    this.socket = null;
    this.status = NET.IDLE;
    this.selfId = null;
    this.buffer.length = 0;
    this.pending.length = 0;
  }

  _setStatus(s) {
    this.status = s;
    this.onStatus?.(s);
  }

  _handle(msg) {
    switch (msg.type) {
      case S2C.SNAPSHOT:
        this._pushSnapshot(msg.s, msg.t);
        if (msg.e) for (const ev of msg.e) this.pending.push(ev);
        break;

      case S2C.PLAYER_JOIN:
        this.onJoin?.(msg.id, msg.name);
        break;

      case S2C.PLAYER_LEAVE:
        this.onLeave?.(msg.id, msg.name);
        break;

      case S2C.CHAT:
        this.chat.push({ id: msg.id, name: msg.name, text: msg.text });
        break;

      case S2C.PONG:
        this.ping = Date.now() - msg.t;
        break;

      case S2C.BUY_OK:
        this.purchases.push(msg.item);
        break;

      case S2C.ERROR:
        // Errors after joining are non-fatal (a refused purchase, say), so
        // they go on the feed rather than tearing the connection down.
        this.notices.push(msg.message);
        break;

      default:
        break;
    }
  }

  _pushSnapshot(state, serverTime) {
    const t = serverTime || Date.now();
    // Track the server clock so buffered timestamps can be compared against a
    // local clock without assuming the two machines agree.
    const offset = Date.now() - t;
    this._clockOffset = this._clockOffset === null
      ? offset
      : this._clockOffset * 0.9 + offset * 0.1;

    this.buffer.push({ t, s: state });
    if (this.buffer.length > BUFFER_MAX) this.buffer.shift();
  }

  /** The newest snapshot, for state that should not be interpolated. */
  get latest() {
    return this.buffer.length ? this.buffer[this.buffer.length - 1].s : null;
  }

  /**
   * The two snapshots straddling the delayed render clock, plus the blend
   * factor between them. Returns null while the buffer is still filling.
   */
  interpolationWindow() {
    if (this.buffer.length === 0) return null;
    if (this.buffer.length === 1) return { a: this.buffer[0].s, b: this.buffer[0].s, k: 0 };

    const renderTime = Date.now() - (this._clockOffset ?? 0) - INTERP_DELAY_MS;

    for (let i = this.buffer.length - 1; i > 0; i--) {
      const b = this.buffer[i], a = this.buffer[i - 1];
      if (a.t <= renderTime && renderTime <= b.t) {
        const span = b.t - a.t;
        const k = span > 0 ? (renderTime - a.t) / span : 0;
        return { a: a.s, b: b.s, k };
      }
    }

    // Behind the whole buffer (a long stall) or ahead of it (packets late):
    // clamp to the nearest end rather than inventing motion.
    if (renderTime < this.buffer[0].t) {
      return { a: this.buffer[0].s, b: this.buffer[0].s, k: 0 };
    }
    const last = this.buffer[this.buffer.length - 1].s;
    return { a: last, b: last, k: 0 };
  }

  /** Drain server events. The game turns these into sound and effects. */
  drainEvents() {
    if (this.pending.length === 0) return null;
    const out = this.pending;
    this.pending = [];
    return out;
  }

  drainPurchases() {
    if (this.purchases.length === 0) return null;
    const out = this.purchases;
    this.purchases = [];
    return out;
  }

  drainNotices() {
    if (this.notices.length === 0) return null;
    const out = this.notices;
    this.notices = [];
    return out;
  }

  drainChat() {
    if (this.chat.length === 0) return null;
    const out = this.chat;
    this.chat = [];
    return out;
  }

  // -------------------------------------------------------------- outbound

  send(type, payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type, ...payload }));
  }

  /** Report our own position, throttled to the protocol's rate. */
  reportState(player, dt, extra = {}) {
    this._stateTimer -= dt;
    if (this._stateTimer > 0) return;
    this._stateTimer = this._stateInterval;

    this.send(C2S.STATE, {
      pos: { x: player.pos.x, y: player.pos.y, z: player.pos.z },
      yaw: player.yaw,
      pitch: player.pitch,
      health: Math.round(player.health),
      alive: player.alive,
      ...extra,
    });

    this._pingTimer -= this._stateInterval;
    if (this._pingTimer <= 0) {
      this._pingTimer = 2;
      this.send(C2S.PING, { t: Date.now() });
    }
  }

  damageEnemy(id, amount, headshot) {
    this.send(C2S.DAMAGE, { id, amount, headshot: !!headshot });
  }

  /** Free-for-all: a hit this client traced onto another player. */
  hitPlayer(id, amount, headshot) {
    this.send(C2S.HIT_PLAYER, { id, amount, headshot: !!headshot });
  }

  explosion(x, y, z, radius, damage) {
    this.send(C2S.EXPLOSION, { x, y, z, radius, damage });
  }

  reportDown() { this.send(C2S.DOWN, {}); }

  /**
   * Tell the room the world is built and play has started.
   *
   * The room will not run its clock until it hears this, so the pre-wave grace
   * belongs to a player who can see the map instead of to terrain generation.
   */
  reportReady(ready = true) { this.send(C2S.READY, { ready }); }

  sendChat(text) { this.send(C2S.CHAT, { text }); }
}
