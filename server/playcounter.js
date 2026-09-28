// Durable, global run count.
//
// Live presence intentionally lives in memory because it expires within
// seconds. A running total is different: it must survive deploys and server
// restarts, so Postgres owns the number. Each start carries an otherwise
// meaningless run UUID. The database stores that UUID solely as an idempotency
// key, which lets a client retry a timed-out request without counting the same
// play twice. It is never tied to a browser id, account, name, IP, or room.

import { PUBLIC_SUPABASE } from '../src/net/config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validRunId(value) {
  return typeof value === 'string' && UUID.test(value);
}

export class PlayCounter {
  constructor({
    url = process.env.SUPABASE_URL || PUBLIC_SUPABASE.url,
    anonKey = process.env.SUPABASE_ANON_KEY || PUBLIC_SUPABASE.anonKey,
    // A Supabase `sb_secret_...` key is preferred. The legacy service-role key
    // remains supported for deployments that have not migrated yet. Neither
    // may ever be compiled into or sent to the browser.
    secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.anonKey = String(anonKey || '');
    this.secretKey = String(secretKey || '');
    this.fetch = fetchImpl;
    /** Null means the durable value has not been loaded yet. */
    this.total = null;
  }

  get configured() {
    return !!(this.url && this.anonKey && this.fetch);
  }

  get writeConfigured() {
    return !!(this.url && this.secretKey && this.fetch);
  }

  /** Load the existing total without changing it. */
  async init() {
    if (!this.configured) return null;
    const rows = await this._request('/rest/v1/game_stats?key=eq.global&select=plays', {
      key: this.anonKey,
    });
    this.total = count(rows?.[0]?.plays);
    return this.total;
  }

  /**
   * Record one run and return the database's authoritative total.
   *
   * `record_game_play` performs the event insert and counter increment in one
   * transaction. Reusing a run id returns the current total without incrementing.
   */
  async record(runId) {
    if (!validRunId(runId)) {
      const err = new Error('Invalid run id');
      err.status = 400;
      throw err;
    }
    if (!this.writeConfigured) {
      const err = new Error('Play counter is not configured');
      err.status = 503;
      throw err;
    }

    const value = await this._request('/rest/v1/rpc/record_game_play', {
      method: 'POST',
      body: { p_run_id: runId },
      key: this.secretKey,
    });
    this.total = count(value);
    return this.total;
  }

  async _request(path, { method = 'GET', body, key } = {}) {
    const res = await this.fetch(this.url + path, {
      method,
      headers: {
        apikey: key,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (!res.ok) {
      const message = parsed?.message || parsed?.error || `Play counter request failed (${res.status})`;
      const err = new Error(message);
      err.status = 503;
      throw err;
    }
    return parsed;
  }
}

function count(value) {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid play total from database');
  return n;
}
