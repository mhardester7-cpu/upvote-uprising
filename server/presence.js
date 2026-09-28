// Who is playing right now.
//
// Two kinds of player reach this server and only one of them holds a socket. A
// co-op player is connected, so the room they are in already knows they are
// there and counting them is exact. A solo player never connects at all --
// main.js builds a LocalSession and the entire match runs in their browser --
// so the only way to know they exist is for them to say so.
//
// Hence the heartbeat: a solo client posts a short beat every BEAT_SECONDS, and
// anybody whose last beat is recent counts as playing. That turns "playing now"
// into a question of recency rather than of connection state, and the TTL is
// what turns a stream of beats back into a single number.
//
// Everything here lives in memory and dies with the process, which is the right
// trade for a live gauge: it answers "who is playing right now", a question
// whose answer is worthless an hour later and not worth a table. Two
// consequences worth knowing rather than discovering: a deploy resets the peak,
// and the count is per-process. railway.json pins numReplicas to 1, so there is
// exactly one process to ask -- running two would mean each reports its own
// share and something has to add them up.
//
// NOTE ON TRUST
//
// The beat endpoint is public and unauthenticated, so somebody determined can
// inflate the number by posting invented client ids. That is a deliberate
// trade, the same one the profiles table makes: the alternative is
// authenticating players who have not signed in, which is most of them, to
// protect a number that decorates a menu. What this module must not allow is
// that person exhausting the server's memory, which is what MAX_TRACKED and the
// pruning pass below are for.

import { BEAT_SECONDS } from '../src/net/protocol.js';

/**
 * How long a single beat keeps someone in the count.
 *
 * Three beats' worth, so two can go missing -- to a dropped request, a garbage
 * collection pause, a phone changing cell towers -- without the player blinking
 * out of the number and back into it. Much longer and the count holds people
 * well after they have closed the tab; much shorter and it flickers for anyone
 * on a bad connection, which reads as the server being broken.
 */
export const TTL_MS = BEAT_SECONDS * 3 * 1000;

/**
 * Ceiling on how many clients are tracked at once.
 *
 * Reached only by abuse -- it is far above any real concurrent population for
 * this game -- and the point is that hitting it costs new beats rather than the
 * process. Bounded memory under a public write endpoint is worth more here than
 * counting the twenty-thousand-and-first player correctly.
 */
export const MAX_TRACKED = 20_000;

/** Client ids are opaque to us; this is only a bound on what we will store. */
const MAX_ID_LENGTH = 64;

export class Presence {
  constructor({ ttlMs = TTL_MS, maxTracked = MAX_TRACKED } = {}) {
    this.ttlMs = ttlMs;
    this.maxTracked = maxTracked;
    /** client id -> epoch ms of their last beat. */
    this.beats = new Map();
    /** Highest concurrent count seen since this process started. */
    this.peak = 0;
    /** When that happened, or null if nobody has played yet. */
    this.peakAt = null;
    this.startedAt = Date.now();
  }

  /**
   * Record that a client is alive.
   *
   * Returns false when the beat was refused -- a malformed id, or the table
   * being full of them -- so a caller can answer honestly rather than pretend.
   */
  beat(id, now = Date.now()) {
    const key = String(id ?? '').trim().slice(0, MAX_ID_LENGTH);
    if (!key) return false;

    // Only new ids can grow the table, so only they have to pay for the check.
    // An id already present is a client that was going to cost this memory
    // anyway, and refusing its beat would drop a real player from the count.
    if (!this.beats.has(key) && this.beats.size >= this.maxTracked) {
      this._prune(now);
      if (this.beats.size >= this.maxTracked) return false;
    }

    this.beats.set(key, now);
    return true;
  }

  /**
   * Drop a client immediately, without waiting out the TTL.
   *
   * Sent by a client that is leaving on purpose -- closing the tab, or entering
   * a co-op room where its socket takes over the counting. Best-effort by
   * nature: a browser killed outright never sends it, which is exactly the case
   * the TTL exists to cover.
   */
  forget(id) {
    return this.beats.delete(String(id ?? '').trim().slice(0, MAX_ID_LENGTH));
  }

  /**
   * Client ids whose last beat still counts, pruning the expired as it goes.
   *
   * Pruning rides along with a pass that has to walk the table anyway, which is
   * what keeps beat() O(1): sweeping on every beat instead would make a busy
   * server quadratic in its own popularity. Deleting from a Map while iterating
   * it is well-defined -- entries removed before they are reached are simply
   * not visited.
   */
  activeIds(now = Date.now()) {
    const live = new Set();
    for (const [id, seen] of this.beats) {
      if (now - seen > this.ttlMs) this.beats.delete(id);
      else live.add(id);
    }
    return live;
  }

  _prune(now = Date.now()) {
    for (const [id, seen] of this.beats) {
      if (now - seen > this.ttlMs) this.beats.delete(id);
    }
  }

  /**
   * The live picture, and the moment the peak is allowed to rise.
   *
   * `coopIds` is the set of client ids currently holding a socket. Someone who
   * just left the menu for a co-op room sits in both sets for up to the TTL --
   * their last solo beat outlives the moment they connected -- so the sets are
   * subtracted rather than added. Adding them would make every single join look
   * briefly like two people arriving, which is precisely the error this number
   * exists to avoid.
   */
  snapshot(coopIds = new Set(), now = Date.now()) {
    const active = this.activeIds(now);

    let solo = 0;
    for (const id of active) if (!coopIds.has(id)) solo++;

    const coop = coopIds.size;
    const players = coop + solo;

    if (players > this.peak) {
      this.peak = players;
      this.peakAt = now;
    }

    return {
      players,
      coop,
      solo,
      peak: this.peak,
      peakAt: this.peakAt,
      since: this.startedAt,
    };
  }
}
