import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { PlayCounter, validRunId } from '../server/playcounter.js';

const RUN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function reply(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); },
  };
}

test('only UUID run keys can reach the durable counter', () => {
  assert.equal(validRunId(RUN), true);
  for (const bad of ['', 'a-player-name', '../../stats', 'x'.repeat(200), null]) {
    assert.equal(validRunId(bad), false);
  }
});

test('the counter hydrates and records through the atomic database RPC', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return calls.length === 1 ? reply([{ plays: 41 }]) : reply(42);
  };
  const counter = new PlayCounter({
    url: 'https://project.example',
    anonKey: 'public-key',
    secretKey: 'server-secret',
    fetchImpl,
  });

  assert.equal(await counter.init(), 41);
  assert.equal(counter.total, 41);
  assert.equal(await counter.record(RUN), 42);
  assert.equal(counter.total, 42);
  assert.match(calls[0].url, /game_stats\?key=eq\.global&select=plays$/);
  assert.match(calls[1].url, /rpc\/record_game_play$/);
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_run_id: RUN });
  assert.equal(calls[0].options.headers.apikey, 'public-key');
  assert.equal(calls[1].options.headers.apikey, 'server-secret');
  assert.equal(calls[1].options.headers.Authorization, undefined);
});

test('bad ids fail before making a database request', async () => {
  let called = false;
  const counter = new PlayCounter({
    url: 'https://project.example',
    anonKey: 'public-key',
    secretKey: 'server-secret',
    fetchImpl: async () => { called = true; return reply(1); },
  });
  await assert.rejects(counter.record('not-a-run'), /Invalid run id/);
  assert.equal(called, false);
});

test('a publishable key can read the total but cannot record a play', async () => {
  const counter = new PlayCounter({
    url: 'https://project.example',
    anonKey: 'public-key',
    fetchImpl: async () => reply([{ plays: 9 }]),
  });

  assert.equal(await counter.init(), 9);
  assert.equal(counter.writeConfigured, false);
  await assert.rejects(counter.record(RUN), /not configured/);
});

test('the menu places durable plays beside concurrent users and records after reset', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const presence = await readFile(new URL('../src/net/presence.js', import.meta.url), 'utf8');
  const privacy = await readFile(new URL('../privacy.html', import.meta.url), 'utf8');
  const migration = await readFile(
    new URL('../supabase/migrations/20260827183000_game_play_counter.sql', import.meta.url),
    'utf8',
  );
  const hardening = await readFile(
    new URL('../supabase/migrations/20260828022000_harden_server_functions.sql', import.meta.url),
    'utf8',
  );

  assert.match(html, /id="live-stats"[\s\S]*id="livecount"[\s\S]*id="playcount"/);
  assert.match(main, /this\.session\.reset\(\);[\s\S]{0,500}this\.presence\?\.recordPlay\(\)/);
  assert.match(presence, /fetch\('\/api\/play'/);
  assert.match(migration, /on conflict \(id\) do nothing/i);
  assert.match(migration, /set plays = plays \+ 1/i);
  assert.doesNotMatch(migration, /\b(?:player_id|browser_id|ip_address)\b/i);
  assert.match(hardening, /revoke all on function public\.handle_new_user\(\)/i);
  assert.match(hardening, /revoke all on function public\.record_game_play\(uuid\)/i);
  assert.match(hardening, /grant execute on function public\.record_game_play\(uuid\)[\s\S]*to service_role/i);
  assert.doesNotMatch(hardening, /grant execute[\s\S]*to (?:anon|authenticated)/i);
  assert.match(privacy, /Aggregate play count:/);
  assert.match(privacy, /not\s+connected to a browser identifier, account, display name, room/);
});
