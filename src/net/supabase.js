// A minimal Supabase client, written against the REST API directly.
//
// The official SDK is an npm package, and this project has no bundler and no
// node_modules -- it serves hand-vendored ES modules and maps bare specifiers
// through an importmap. Pulling the SDK in would mean either vendoring a large
// dependency tree or fetching from a CDN, and the game deliberately fetches
// nothing at runtime.
//
// What the game actually needs is small: sign up, sign in, refresh a session,
// and read/write one row per player. That is four endpoints, so this talks to
// them with fetch and keeps the whole surface auditable.
//
// The anon key is meant to be public -- it identifies the project, it does not
// authorise anything. Row-level security on the profiles table is what actually
// protects a player's row; see supabase/migrations.

const SESSION_KEY = 'blockstrike.session';

/** Thrown for any non-2xx response, carrying the API's own message. */
export class SupabaseError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.body = body;
  }
}

export class Supabase {
  /**
   * @param url     project URL, e.g. https://abcdefgh.supabase.co
   * @param anonKey the project's public anon key
   * @param storage injectable for tests; defaults to localStorage
   */
  constructor(url, anonKey, storage = defaultStorage()) {
    this.url = String(url ?? '').replace(/\/+$/, '');
    this.anonKey = anonKey ?? '';
    this.storage = storage;
    this.session = null;
    /** Called whenever the signed-in user changes, including sign-out. */
    this.onAuthChange = null;
  }

  /** True once a URL and key have been supplied. */
  get configured() { return !!(this.url && this.anonKey); }

  get user() { return this.session?.user ?? null; }
  get signedIn() { return !!this.session?.access_token; }

  // ------------------------------------------------------------------ session

  /**
   * Restore a session saved by a previous visit.
   *
   * Access tokens are short-lived, so a stored session is refreshed rather than
   * trusted. A refresh failure is not an error the player should see -- it just
   * means they are signed out again.
   */
  async restore() {
    if (!this.configured) return null;

    let saved = null;
    try {
      saved = JSON.parse(this.storage.getItem(SESSION_KEY) ?? 'null');
    } catch {
      saved = null;   // corrupt entry; treat as signed out
    }
    if (!saved?.refresh_token) return null;

    try {
      return await this._grant('refresh_token', { refresh_token: saved.refresh_token });
    } catch {
      this._setSession(null);
      return null;
    }
  }

  async signUp(email, password) {
    const data = await this._auth('signup', { email, password });
    // With email confirmation switched on, signup returns a user but no
    // session. Reporting that honestly is what stops the UI claiming success
    // and then silently failing to save.
    if (data.access_token) this._setSession(data);
    return { user: data.user ?? null, needsConfirmation: !data.access_token };
  }

  async signIn(email, password) {
    return this._grant('password', { email, password });
  }

  async signOut() {
    if (this.session?.access_token) {
      // Best-effort: a failed revoke must not strand the player signed in.
      try {
        await this._fetch('/auth/v1/logout', { method: 'POST', auth: true });
      } catch { /* ignore */ }
    }
    this._setSession(null);
  }

  async _grant(grantType, body) {
    const data = await this._auth(`token?grant_type=${grantType}`, body);
    this._setSession(data);
    return data;
  }

  async _auth(path, body) {
    return this._fetch(`/auth/v1/${path}`, { method: 'POST', body });
  }

  _setSession(data) {
    const changed = (this.session?.user?.id ?? null) !== (data?.user?.id ?? null);
    this.session = data;
    // Storage can become unwritable after the constructor probe (quota,
    // private-mode policy changes). A valid auth response must still establish
    // the in-memory session instead of turning success into an exception.
    try {
      if (data?.refresh_token) {
        this.storage.setItem(SESSION_KEY, JSON.stringify({
          refresh_token: data.refresh_token,
        }));
      } else {
        this.storage.removeItem(SESSION_KEY);
      }
    } catch { /* the session remains usable for this page */ }
    if (changed) this.onAuthChange?.(this.user);
  }

  // ----------------------------------------------------------------- profiles

  /**
   * The signed-in player's row, or null if they have never saved one.
   *
   * RLS restricts this to the caller's own row, so no user filter is needed --
   * and adding one would imply the client is what enforces the boundary.
   */
  async fetchProfile() {
    if (!this.signedIn) return null;
    const rows = await this._fetch(
      `/rest/v1/profiles?select=*&id=eq.${this.user.id}`,
      { auth: true },
    );
    return rows?.[0] ?? null;
  }

  /** Insert-or-update the player's row. */
  async saveProfile(fields) {
    if (!this.signedIn) return null;
    const rows = await this._fetch('/rest/v1/profiles', {
      method: 'POST',
      auth: true,
      headers: {
        // Upsert: one row per user, keyed by the auth user id.
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: { ...fields, id: this.user.id, updated_at: new Date().toISOString() },
    });
    return rows?.[0] ?? null;
  }

  // --------------------------------------------------------------------- http

  async _fetch(path, { method = 'GET', body, auth = false, headers = {} } = {}) {
    if (!this.configured) throw new SupabaseError('Supabase is not configured', 0, null);

    const res = await fetch(this.url + path, {
      method,
      headers: {
        apikey: this.anonKey,
        // The anon key is the fallback bearer: PostgREST needs some JWT to
        // evaluate RLS against, and the anon role is what an unauthenticated
        // caller gets.
        Authorization: `Bearer ${auth && this.session?.access_token
          ? this.session.access_token
          : this.anonKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }

    if (!res.ok) {
      const msg = parsed?.error_description || parsed?.msg || parsed?.message
        || parsed?.error || `Request failed (${res.status})`;
      throw new SupabaseError(msg, res.status, parsed);
    }
    return parsed;
  }
}

function defaultStorage() {
  // Private-mode Safari throws on access rather than returning null, and a
  // headless test has no localStorage at all, so fall back to memory.
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.getItem('__probe__');
      return localStorage;
    }
  } catch { /* fall through */ }

  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
}
