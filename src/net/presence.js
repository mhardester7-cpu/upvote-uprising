// Telling the server this browser is playing, and asking it how many others are.
//
// Co-op players are counted by their socket and need none of this. Solo play
// never contacts the server at all -- the whole match runs against a
// LocalSession -- so without a heartbeat the most common way to play the game
// is also completely invisible to it. That is what this module fixes, in the
// smallest way that is honest: one small POST every BEAT_SECONDS, and a
// goodbye when the tab goes away.
//
// What "playing" is taken to mean
// ------------------------------
// A visible tab. Beating stops when the page is hidden and resumes when it
// comes back, which is both more truthful -- a game minimised behind a browser
// window is not being played -- and unavoidable, since browsers throttle timers
// in background tabs to roughly once a minute and a beat that cannot be sent on
// time is a player who flickers out of the count anyway. Leaning into the
// throttle makes the number mean something rather than fighting it and losing.

import { BEAT_SECONDS, sanitizeClientId } from './protocol.js';

const ID_KEY = 'blockstrike.cid';

/**
 * This browser's durable id.
 *
 * Durable so that a player who beats from the menu and then joins a co-op room
 * is recognised as one person rather than counted twice, and so that two tabs
 * do not read as two players. It identifies nothing about the human: it is a
 * random value this browser made up, it is never tied to an account, and losing
 * it costs a slightly wrong count for one TTL and nothing else.
 */
let cachedId = null;

export function clientId() {
  if (cachedId) return cachedId;
  try {
    let id = localStorage.getItem(ID_KEY);
    // Storage can outlive old builds and can be edited or corrupted. Keeping
    // an id the server rejects makes every solo heartbeat fail forever.
    if (!sanitizeClientId(id)) {
      id = crypto.randomUUID();
      localStorage.setItem(ID_KEY, id);
    }
    cachedId = id;
  } catch {
    // Private mode, or storage switched off. A per-session id still counts this
    // player correctly for as long as the page is open, which is the whole
    // question being asked; it just cannot survive a reload. Caching it is what
    // keeps the heartbeat and the join message agreeing on who this is, which
    // is the difference between one player and two.
    cachedId = crypto.randomUUID();
  }
  return cachedId;
}

export class Presence {
  /**
   * @param onCount called with the live payload after every successful beat,
   *                so the menu can show the number without polling separately
   */
  constructor(onCount = null) {
    this.id = clientId();   // shared with the join message; see netclient.js
    this.onCount = onCount;
    this.latest = null;
    /** True while a socket is doing the counting for us. */
    this.suspended = false;
    this._timer = null;
    this._bound = false;
  }

  /** Begin beating, and keep beating while the tab is visible. */
  start() {
    if (this._bound) return this;
    this._bound = true;

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._stopTimer();
      else this._startTimer();
    });

    // pagehide beats unload: it is the one that fires on iOS, where a tab is
    // typically frozen rather than closed. Without it every phone player would
    // linger in the count for the full TTL after putting the game down.
    addEventListener('pagehide', () => this.leave());

    this._startTimer();
    return this;
  }

  stop() {
    this._stopTimer();
    this.leave();
  }

  /**
   * Hand counting over to a socket, or take it back.
   *
   * Called when the player enters and leaves a co-op room. The server would
   * de-duplicate this player anyway -- it knows the id on both paths -- but
   * going quiet while connected means it does not have to, and stops a room
   * full of players paying for beats nobody reads.
   */
  setConnected(connected) {
    this.suspended = !!connected;
    if (connected) {
      this._stopTimer();
      this.leave();
    } else {
      this._startTimer();
    }
  }

  /**
   * Beat now, then keep beating.
   *
   * Refusing to start while hidden is what makes becoming visible count
   * immediately. Starting the interval anyway -- which a page opened in a
   * background tab would do -- leaves a timer already in place by the time the
   * player switches to it, so this guard would find one and return without
   * beating, and a player staring at the menu would sit uncounted until the
   * interval next came round.
   */
  _startTimer() {
    if (this._timer || this.suspended || document.hidden) return;
    this.beat();
    this._timer = setInterval(() => this.beat(), BEAT_SECONDS * 1000);
  }

  _stopTimer() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /** One check-in. Failure is silent: the counter is not worth an error. */
  async beat() {
    if (this.suspended || document.hidden) return null;
    try {
      const res = await fetch('/api/beat', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.id }),
      });
      if (!res.ok) return null;
      this.latest = await res.json();
      this.onCount?.(this.latest);
      return this.latest;
    } catch {
      // Offline, or the server is restarting. The player is mid-game either
      // way and must not be told about it.
      return null;
    }
  }

  /**
   * Add one real gameplay start to the global counter.
   *
   * The id belongs to this run, not this player. Reusing it on every retry is
   * what makes an accepted request followed by a dropped response count once.
   * This runs in the background; analytics can never hold up the game itself.
   */
  async recordPlay(runId = crypto.randomUUID()) {
    const waits = [0, 1_000, 3_000];
    for (const wait of waits) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        const res = await fetch('/api/play', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId }),
        });
        // A malformed id will never become valid by retrying. A 503 can: it is
        // the normal answer while the durable store is briefly unavailable.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) return null;
        if (!res.ok) continue;

        const update = await res.json();
        this.latest = { ...(this.latest || {}), plays: update.plays };
        this.onCount?.(this.latest);
        return update.plays;
      } catch {
        // A short network interruption is exactly why the idempotency UUID and
        // retries exist. The last failure remains intentionally invisible.
      }
    }
    return null;
  }

  /**
   * Drop out of the count now rather than at the end of the TTL.
   *
   * sendBeacon because this runs while the page is being torn down, where a
   * normal fetch is routinely cancelled -- the browser queues a beacon and
   * sends it after the document is gone.
   */
  leave() {
    const body = JSON.stringify({ id: this.id, gone: true });
    try {
      if (navigator.sendBeacon?.(
        '/api/beat', new Blob([body], { type: 'application/json' }))) return;
    } catch { /* fall through to the fetch below */ }
    try {
      fetch('/api/beat', { method: 'POST', body, keepalive: true });
    } catch { /* nothing left to try, and the TTL covers it */ }
  }
}
