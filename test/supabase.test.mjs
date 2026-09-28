// The Supabase REST client.
//
// This talks to a server none of these tests can reach, so what is verified
// here is the half that is ours: the shape of the requests, which token goes on
// which call, and that failures surface the API's own message instead of a
// generic one. A stub fetch stands in for the network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Supabase, SupabaseError } from '../src/net/supabase.js';

const URL = 'https://proj.supabase.co';
const KEY = 'anon-key-123';

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** Records every call and replies from a queue. */
function stubFetch(replies) {
  const calls = [];
  const queue = [...replies];
  global.fetch = async (url, opts = {}) => {
    calls.push({
      url,
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
      body: opts.body ? JSON.parse(opts.body) : null,
    });
    const next = queue.shift() ?? { status: 200, body: {} };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (next.body === undefined ? '' : JSON.stringify(next.body)),
    };
  };
  return calls;
}

const SESSION = {
  access_token: 'access-abc',
  refresh_token: 'refresh-xyz',
  user: { id: 'user-1', email: 'p@example.com' },
};

test('a client with no url or key is not configured and never calls out', async () => {
  const sb = new Supabase('', '', memStorage());
  const calls = stubFetch([]);

  assert.equal(sb.configured, false);
  // restore() runs on every boot, so it has to be safe with no config at all.
  assert.equal(await sb.restore(), null);
  // Signed out, so these short-circuit before they reach the network.
  assert.equal(await sb.fetchProfile(), null);
  assert.equal(await sb.saveProfile({ credits: 1 }), null);
  assert.equal(calls.length, 0, 'an unconfigured client must not hit the network');

  // Anything that does reach the transport says why rather than failing obscurely.
  await assert.rejects(
    () => sb.signIn('p@example.com', 'hunter22'),
    (err) => err instanceof SupabaseError && /not configured/i.test(err.message),
  );
});

test('sign-in posts the password grant and keeps the session', async () => {
  const sb = new Supabase(URL, KEY, memStorage());
  const calls = stubFetch([{ status: 200, body: SESSION }]);

  await sb.signIn('p@example.com', 'hunter22');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${URL}/auth/v1/token?grant_type=password`);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.apikey, KEY);
  assert.deepEqual(calls[0].body, { email: 'p@example.com', password: 'hunter22' });
  assert.equal(sb.signedIn, true);
  assert.equal(sb.user.id, 'user-1');
});

test('a sign-up that needs email confirmation is reported, not treated as success', async () => {
  const sb = new Supabase(URL, KEY, memStorage());
  // Supabase returns a user but no tokens when confirmation is required.
  stubFetch([{ status: 200, body: { user: { id: 'u2' } } }]);

  const res = await sb.signUp('new@example.com', 'hunter22');
  assert.equal(res.needsConfirmation, true);
  assert.equal(sb.signedIn, false, 'no session means not signed in');
});

test('a sign-up that returns tokens signs you straight in', async () => {
  const sb = new Supabase(URL, KEY, memStorage());
  stubFetch([{ status: 200, body: SESSION }]);

  const res = await sb.signUp('new@example.com', 'hunter22');
  assert.equal(res.needsConfirmation, false);
  assert.equal(sb.signedIn, true);
});

test('the refresh token is persisted, and the access token never is', async () => {
  const storage = memStorage();
  const sb = new Supabase(URL, KEY, storage);
  stubFetch([{ status: 200, body: SESSION }]);

  await sb.signIn('p@example.com', 'hunter22');

  const saved = JSON.parse(storage.getItem('blockstrike.session'));
  assert.equal(saved.refresh_token, 'refresh-xyz');
  assert.equal(saved.access_token, undefined, 'short-lived token must not be stored');
});

test('an unwritable storage backend does not turn sign-in success into failure', async () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota exceeded'); },
    removeItem: () => { throw new Error('storage disabled'); },
  };
  const sb = new Supabase(URL, KEY, storage);
  stubFetch([{ status: 200, body: SESSION }]);

  await sb.signIn('p@example.com', 'hunter22');
  assert.equal(sb.signedIn, true);
  assert.equal(sb.user.id, 'user-1');
});

test('restore exchanges a stored refresh token for a fresh session', async () => {
  const storage = memStorage({
    'blockstrike.session': JSON.stringify({ refresh_token: 'refresh-xyz' }),
  });
  const sb = new Supabase(URL, KEY, storage);
  const calls = stubFetch([{ status: 200, body: SESSION }]);

  await sb.restore();

  assert.equal(calls[0].url, `${URL}/auth/v1/token?grant_type=refresh_token`);
  assert.deepEqual(calls[0].body, { refresh_token: 'refresh-xyz' });
  assert.equal(sb.signedIn, true);
});

test('a refresh that is rejected signs the player out quietly', async () => {
  const storage = memStorage({
    'blockstrike.session': JSON.stringify({ refresh_token: 'stale' }),
  });
  const sb = new Supabase(URL, KEY, storage);
  stubFetch([{ status: 400, body: { error: 'invalid_grant' } }]);

  // A stale token on boot is normal, not an error the player should see.
  assert.equal(await sb.restore(), null);
  assert.equal(sb.signedIn, false);
  assert.equal(storage.getItem('blockstrike.session'), null, 'dead token is cleared');
});

test('a corrupt stored session does not throw on boot', async () => {
  const sb = new Supabase(URL, KEY, memStorage({ 'blockstrike.session': '{{{' }));
  assert.equal(await sb.restore(), null);
});

test('profile reads are scoped to the caller and use the access token', async () => {
  const sb = new Supabase(URL, KEY, memStorage());
  const calls = stubFetch([
    { status: 200, body: SESSION },
    { status: 200, body: [{ id: 'user-1', credits: 42 }] },
  ]);

  await sb.signIn('p@example.com', 'hunter22');
  const row = await sb.fetchProfile();

  const get = calls[1];
  assert.match(get.url, /\/rest\/v1\/profiles\?select=\*&id=eq\.user-1$/);
  assert.equal(get.headers.Authorization, 'Bearer access-abc',
    'must authenticate as the user, not as anon');
  assert.equal(row.credits, 42);
});

test('an account with no row yet reads as null rather than throwing', async () => {
  const sb = new Supabase(URL, KEY, memStorage());
  stubFetch([{ status: 200, body: SESSION }, { status: 200, body: [] }]);
  await sb.signIn('p@example.com', 'hunter22');
  assert.equal(await sb.fetchProfile(), null);
});

test('saving upserts against the caller id and asks for the row back', async () => {
  const sb = new Supabase(URL, KEY, memStorage());
  const calls = stubFetch([
    { status: 200, body: SESSION },
    { status: 200, body: [{ id: 'user-1', credits: 7 }] },
  ]);

  await sb.signIn('p@example.com', 'hunter22');
  await sb.saveProfile({ credits: 7 });

  const post = calls[1];
  assert.equal(post.method, 'POST');
  assert.equal(post.url, `${URL}/rest/v1/profiles`);
  assert.match(post.headers.Prefer, /merge-duplicates/);
  assert.equal(post.body.id, 'user-1', 'the row is keyed by the auth user');
  assert.equal(post.body.credits, 7);
  assert.ok(post.body.updated_at, 'writes are stamped');
});

test('reads and writes are refused while signed out', async () => {
  const sb = new Supabase(URL, KEY, memStorage());
  const calls = stubFetch([]);
  assert.equal(await sb.fetchProfile(), null);
  assert.equal(await sb.saveProfile({ credits: 1 }), null);
  assert.equal(calls.length, 0, 'no request should be attempted');
});

test('an API error surfaces the message the API actually sent', async () => {
  const sb = new Supabase(URL, KEY, memStorage());
  stubFetch([{ status: 400, body: { error_description: 'Invalid login credentials' } }]);

  await assert.rejects(
    () => sb.signIn('p@example.com', 'wrong'),
    (err) => {
      assert.ok(err instanceof SupabaseError);
      assert.equal(err.status, 400);
      assert.equal(err.message, 'Invalid login credentials');
      return true;
    },
  );
});

test('signing out clears the session even if revoking fails', async () => {
  const storage = memStorage();
  const sb = new Supabase(URL, KEY, storage);
  stubFetch([{ status: 200, body: SESSION }, { status: 500, body: { message: 'boom' } }]);

  await sb.signIn('p@example.com', 'hunter22');
  await sb.signOut();

  assert.equal(sb.signedIn, false, 'a failed revoke must not strand the player');
  assert.equal(storage.getItem('blockstrike.session'), null);
});
