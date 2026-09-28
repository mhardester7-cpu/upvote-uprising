import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import {
  acceptedEncoding, applySecurityHeaders, compressionMetadata, isInside,
  PUBLIC_CACHE_CONTROL, publicPath, readJsonBody, requestIsFresh, sameHostOrigin,
} from '../server/security.js';
import { GameServer } from '../server/gameserver.js';
import { GameSim } from '../src/sim/gamesim.js';
import { C2S, MODE } from '../src/net/protocol.js';

test('the static boundary serves the game and nothing repository-private', () => {
  assert.equal(publicPath('/'), 'index.html');
  assert.equal(publicPath('/src/main.js?cache=1'), 'src/main.js');
  assert.equal(publicPath('/vendor/three.module.js'), 'vendor/three.module.js');
  assert.equal(publicPath('/assets/models/example.glb'), 'assets/models/example.glb');
  assert.equal(publicPath('/privacy.html'), 'privacy.html');
  assert.equal(publicPath('/terms.html'), 'terms.html');

  for (const target of [
    '/.env', '/.git/config', '/server.js', '/server/live.html', '/package.json',
    '/package-lock.json', '/supabase/config.toml', '/tools/modelviewer.html',
    '/../server.js', '/%2e%2e/server.js', '/src/../server.js', '/src\\main.js',
    '/%E0%A4%A',
  ]) {
    assert.equal(publicPath(target), null, `${target} crossed the public boundary`);
  }
});

test('stable asset URLs revalidate after every deployment', () => {
  assert.equal(PUBLIC_CACHE_CONTROL, 'no-cache');
});

test('compression negotiation honors refused encodings and quality weights', () => {
  assert.equal(acceptedEncoding('br, gzip'), 'br');
  assert.equal(acceptedEncoding('br;q=0.4, gzip;q=1'), 'gzip');
  assert.equal(acceptedEncoding('br;q=0, gzip;q=0'), null);
  assert.equal(acceptedEncoding('gzip;q=0, *;q=0.5'), 'br');
  assert.equal(acceptedEncoding('identity'), null);
});

test('every negotiable response varies by encoding, including identity', () => {
  assert.deepEqual(compressionMetadata(true, 'gzip;q=0'), {
    encoding: null,
    vary: 'Accept-Encoding',
  });
  assert.deepEqual(compressionMetadata(true, 'gzip'), {
    encoding: 'gzip',
    vary: 'Accept-Encoding',
  });
  assert.deepEqual(compressionMetadata(false, 'gzip'), { encoding: null, vary: null });
});

test('ETag validators take precedence and support ordinary validator lists', () => {
  const etag = 'W/"abc-123"';
  const mtime = Date.parse('2026-08-30T12:00:00Z');
  assert.equal(requestIsFresh({ headers: { 'if-none-match': '"other", "abc-123"' } }, etag, mtime), true);
  assert.equal(requestIsFresh({ headers: { 'if-none-match': '*' } }, etag, mtime), true);
  assert.equal(requestIsFresh({
    headers: {
      'if-none-match': '"other"',
      'if-modified-since': 'Mon, 31 Aug 2026 12:00:00 GMT',
    },
  }, etag, mtime), false, 'a mismatched ETag must not fall through to the date');
});

test('JSON request limits count bytes rather than Unicode characters', async () => {
  const small = Readable.from([Buffer.from('{"ok":true}')]);
  assert.deepEqual(await readJsonBody(small, 20), { ok: true });

  const multibyte = Readable.from([Buffer.from(JSON.stringify({ value: '☃'.repeat(400) }))]);
  await assert.rejects(
    () => readJsonBody(multibyte, 1024),
    (err) => err?.status === 413,
  );
});

test('inside-root checks do not confuse a sibling prefix for a child', () => {
  assert.equal(isInside('/srv/game', '/srv/game/src/main.js'), true);
  assert.equal(isInside('/srv/game', '/srv/game-secrets/.env'), false);
});

test('browser WebSockets must originate from the host serving the game', () => {
  assert.equal(sameHostOrigin({ headers: { host: 'game.example' } }), true);
  assert.equal(sameHostOrigin({
    headers: { host: 'internal:8080', 'x-forwarded-host': 'game.example', origin: 'https://game.example' },
  }), true);
  assert.equal(sameHostOrigin({
    headers: { host: 'game.example', origin: 'https://attacker.example' },
  }), false);
  assert.equal(sameHostOrigin({ headers: { host: 'game.example', origin: 'not a url' } }), false);
});

test('every response receives the browser hardening policy', () => {
  const headers = new Map();
  applySecurityHeaders({ setHeader: (name, value) => headers.set(name.toLowerCase(), value) });
  const csp = headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /img-src[^;]*\bblob:/,
    'embedded GLB textures need blob image decoding');
  assert.match(csp, /connect-src[^;]*\bblob:/,
    'ImageBitmapLoader fetches embedded GLB textures through blob URLs');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.match(headers.get('permissions-policy'), /payment=\(\)/);
});

test('malformed player state cannot poison a shared simulation', () => {
  const sim = new GameSim(1234).generate();
  const player = sim.addPlayer(1, 'SAFE');
  const spawn = { ...player.pos };
  sim.applyPlayerState(1, {
    pos: { x: 'NaN', y: {}, z: Infinity },
    yaw: NaN,
    pitch: Infinity,
    health: -Infinity,
    weapon: '<script>'.repeat(20),
  });
  assert.deepEqual(player.pos, spawn);
  assert.equal(player.health, 100);
  assert.ok(Object.values(player.pos).every(Number.isFinite));

  sim.applyPlayerState(1, {
    pos: { x: -1e300, y: 1e300, z: 1e300 },
    yaw: 1e300,
    pitch: 1e300,
    health: 1e300,
  });
  assert.equal(player.pos.x, 0);
  assert.equal(player.pos.y, 1_000);
  assert.equal(player.pos.z, sim.world.size);
  assert.ok(Number.isFinite(player.yaw));
  assert.equal(player.pitch, Math.PI / 2);
  assert.equal(player.health, player.maxHealth);
});

test('a client cannot set a shared-pot armoury price to zero', () => {
  const server = new GameServer();
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
  };
  const conn = {
    room: null,
    id: null,
    name: 'BUYER',
    purchaseLevels: new Map(),
  };
  server._onJoin(socket, conn, { type: C2S.JOIN, room: '', name: 'BUYER', mode: MODE.COOP });
  conn.room.sim.coins = 2_000;

  server._handle(socket, conn, {
    type: C2S.BUY,
    item: 'damage',
    weapon: 'rifle',
    cost: 0,
  });
  assert.equal(conn.room.sim.coins, 1_500, 'the client-supplied zero price was trusted');
  assert.equal(socket.sent.at(-1).type, 'buyok');

  server._handle(socket, conn, {
    type: C2S.BUY,
    item: 'damage',
    weapon: 'rifle',
    cost: 0,
  });
  assert.equal(conn.room.sim.coins, 600, 'the server did not advance the upgrade price');

  server._handle(socket, conn, {
    type: C2S.BUY,
    item: 'mystery-box',
    cost: 0,
  });
  assert.equal(conn.room.sim.coins, 600, 'a forged world-interaction price was accepted');
  assert.equal(socket.sent.at(-1).type, 'error');
});

test('the server routes banana vending requests through the room simulation', () => {
  const server = new GameServer();
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
  };
  const conn = {
    room: null,
    id: null,
    name: 'SHAKER',
    purchaseLevels: new Map(),
  };
  server._onJoin(socket, conn, { type: C2S.JOIN, room: '', name: 'SHAKER', mode: MODE.COOP });
  const vending = conn.room.sim.world.drummerTower.bananaVending;
  const player = conn.room.sim.players.get(conn.id);
  player.pos = { x: vending.x, y: vending.y, z: vending.z + 1 };

  server._handle(socket, conn, { type: C2S.VENDING });

  assert.equal(conn.room.sim.vendingTime, 0);
  assert.equal(conn.room.sim.drainEvents()?.at(-1)?.type, 'bananaVending');
  server._handle(socket, conn, { type: C2S.VENDING });
  assert.equal(conn.room.sim.drainEvents(), null, 'a duplicate request emitted another room event');
});
