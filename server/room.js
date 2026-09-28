// A room: one GameSim, its connected players, and the loop that drives both.
//
// Each room is an independent world. It generates terrain from its own seed on
// creation, ticks its simulation at a fixed rate, and streams a snapshot to
// every member at a lower rate. Rooms are created on demand and disposed the
// moment the last player leaves, so an idle server holds nothing.

import { GameSim, SIM_DT } from '../src/sim/gamesim.js';
import { S2C, SNAPSHOT_HZ, normalizeVisibility, VISIBILITY } from '../src/net/protocol.js';

/** Players per room. Beyond this the arena stops being legible. */
export const MAX_PLAYERS = 8;

/**
 * How long the room will wait for a client to report itself ready before
 * starting anyway.
 *
 * A safety net, not the normal path: a client that never sends READY -- an old
 * build, a lost message -- must not leave the room frozen forever.
 */
const READY_TIMEOUT_MS = 20_000;

/** A room with nobody in it is torn down after this long. */
const EMPTY_GRACE_MS = 30_000;

/** A slow receiver may miss a snapshot; it may not retain unbounded memory. */
const MAX_BACKPRESSURE = 1 << 20;

export class Room {
  constructor(code, seed, mode, visibility) {
    this.code = code;
    this.seed = seed;
    this.sim = new GameSim(seed, { mode }).generate();
    this.members = new Map();       // id -> { id, socket, name }
    this.nextMemberId = 1;
    this.emptyAt = Date.now();
    this.createdAt = Date.now();
    /** Listed in the public browser, or reachable only by its code. */
    this.visibility = normalizeVisibility(visibility);
    /**
     * Whoever is currently the face of the room in the lobby list.
     *
     * A room is easier to pick out of a list by who is in it than by four
     * random letters, so the listing carries a name. It follows the members
     * rather than being fixed at creation: a list still advertising the player
     * who opened the room and left an hour ago is worse than no name at all.
     */
    this.host = '';

    /**
     * Member ids that have reported their world built and play started.
     *
     * The clock used to start the instant someone joined, which meant the
     * opening grace was burning while the joining client was still generating
     * terrain from the room seed -- so the loading screen cleared straight onto
     * a wave that had already begun walking in.
     */
    this.ready = new Set();
    this.firstJoinAt = 0;

    this._accum = 0;
    this._lastTick = Date.now();
    this._snapAccum = 0;
    this._snapInterval = 1 / SNAPSHOT_HZ;
  }

  /**
   * A client reporting that its world is built and it is standing in it.
   *
   * The first ready member starts the simulation clock, so the opening grace is
   * spent by a player who can see the map rather than by a loading screen.
   */
  setReady(id, ready = true) {
    if (!this.members.has(id)) return;
    if (ready) this.ready.add(id); else this.ready.delete(id);
    if (ready) this._startClockIfReady();
  }

  _startClockIfReady() {
    if (this.sim.running || this.isEmpty) return;
    this.sim.running = true;
    // Reset rather than trust the stale value: the room object may have been
    // sitting idle since it was created, and a stale _lastTick would hand the
    // first update() a huge elapsed and eat the whole opening grace at once.
    this._lastTick = Date.now();
    this._accum = 0;
  }

  get size() { return this.members.size; }
  get isFull() { return this.members.size >= MAX_PLAYERS; }
  get isEmpty() { return this.members.size === 0; }
  get isPublic() { return this.visibility === VISIBILITY.PUBLIC; }

  /** How the lobby browser describes this room. Public rooms only. */
  listing() {
    return {
      code: this.code,
      host: this.host,
      mode: this.sim.mode,
      players: this.size,
      max: MAX_PLAYERS,
      full: this.isFull,
      wave: this.sim.wave,
      // A room nobody has started yet is still gathering, which is the one a
      // newcomer most wants to join: nothing has happened without them.
      started: this.sim.running,
    };
  }

  /** True once a room has been empty long enough to be worth collecting. */
  expired(now = Date.now()) {
    return this.isEmpty && now - this.emptyAt > EMPTY_GRACE_MS;
  }

  // ----------------------------------------------------------------- members

  /**
   * `cid` is the client's own durable id, used only by the presence count to
   * recognise that the player who was beating from the menu a moment ago and
   * the socket that just joined are one person. It is never trusted for
   * anything: the member id below is what the simulation and the protocol use,
   * and that one is allocated here rather than claimed by the client.
   */
  join(socket, name, cid = '') {
    const id = this.nextMemberId++;
    this.members.set(id, { id, socket, name, cid });
    this.sim.addPlayer(id, name);
    if (!this.host) this.host = name;

    // Later arrivals drop into a run that is already going, which is what makes
    // a room worth keeping alive between players coming and going. The *first*
    // arrival no longer starts the clock here -- setReady() does, once the
    // client says it is actually in the world.
    if (!this.firstJoinAt) this.firstJoinAt = Date.now();

    this.broadcast(S2C.PLAYER_JOIN, { id, name }, id);
    return id;
  }

  leave(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    this.ready.delete(id);
    this.sim.removePlayer(id);
    this.broadcast(S2C.PLAYER_LEAVE, { id, name: m.name });
    // The listing takes the name of whoever is still here.
    if (this.host === m.name) {
      this.host = this.members.values().next().value?.name ?? '';
    }
    if (this.isEmpty) {
      this.emptyAt = Date.now();
      // A reconnect within the grace period keeps the run, but it is still a
      // new loading client. Stale readiness and the original first-join time
      // would otherwise start the clock immediately, before its world exists.
      this.ready.clear();
      this.firstJoinAt = 0;
      // Nobody left to simulate for. Freezing rather than tearing down keeps a
      // reconnect within the grace period landing back in the same run.
      this.sim.running = false;
    }
  }

  // ------------------------------------------------------------------- comms

  send(socket, type, payload) {
    if (socket.readyState !== 1) return;   // 1 === WebSocket.OPEN
    if (socket.bufferedAmount > MAX_BACKPRESSURE) {
      socket.terminate?.();
      return;
    }
    socket.send(JSON.stringify({ type, ...payload }));
  }

  broadcast(type, payload, exceptId = null) {
    const msg = JSON.stringify({ type, ...payload });
    for (const m of this.members.values()) {
      if (m.id === exceptId) continue;
      if (m.socket.readyState !== 1) continue;
      if (m.socket.bufferedAmount > MAX_BACKPRESSURE) {
        m.socket.terminate?.();
        continue;
      }
      m.socket.send(msg);
    }
  }

  // -------------------------------------------------------------------- loop

  /**
   * Advance the simulation by real elapsed time, then broadcast if a snapshot
   * is due. Ticks are accumulated and clamped: if the event loop stalls, the
   * room catches up over a bounded number of steps rather than trying to
   * simulate the whole gap at once and stalling further.
   */
  update() {
    const now = Date.now();
    // Nobody has reported ready in a reasonable time: start regardless rather
    // than leave a room that can never begin.
    if (!this.sim.running && this.firstJoinAt && now - this.firstJoinAt > READY_TIMEOUT_MS) {
      this._startClockIfReady();
    }
    let elapsed = (now - this._lastTick) / 1000;
    this._lastTick = now;
    if (elapsed > 0.25) elapsed = 0.25;

    this._accum += elapsed;
    let steps = 0;
    while (this._accum >= SIM_DT && steps < 15) {
      this.sim.tick(SIM_DT);
      this._accum -= SIM_DT;
      steps++;
    }

    this._snapAccum += elapsed;
    if (this._snapAccum >= this._snapInterval) {
      this._snapAccum = 0;
      this._broadcastSnapshot();
    }
  }

  _broadcastSnapshot() {
    if (this.isEmpty) return;
    const events = this.sim.drainEvents();
    const msg = JSON.stringify({
      type: S2C.SNAPSHOT,
      s: this.sim.snapshot(),
      e: events || undefined,
      t: Date.now(),
    });
    for (const m of this.members.values()) {
      if (m.socket.readyState !== 1) continue;
      if (m.socket.bufferedAmount > MAX_BACKPRESSURE) {
        m.socket.terminate?.();
        continue;
      }
      m.socket.send(msg);
    }
  }
}
