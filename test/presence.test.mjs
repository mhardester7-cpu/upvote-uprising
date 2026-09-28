// The live headcount: who is counted, who is counted twice, and who is never named.
//
// The number this produces is shown to every player on the menu, so the ways it
// can be wrong are worth pinning down. Three of them matter: a solo player who
// joins a room must not become two people, a player who closed the tab must
// stop counting, and a private room must contribute its players to the total
// without ever contributing its code to the listing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Presence, TTL_MS, MAX_TRACKED } from '../server/presence.js';
import { GameServer } from '../server/gameserver.js';
import { C2S, VISIBILITY, sanitizeClientId } from '../src/net/protocol.js';

const T0 = 1_700_000_000_000;

function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
    last(type) { return [...this.sent].reverse().find((m) => m.type === type) ?? null; },
  };
}

function join(server, { room = '', name = 'PLAYER', cid = '', visibility } = {}) {
  const socket = fakeSocket();
  const conn = { room: null, id: null, name, count: 0, windowStart: Date.now() };
  server._onJoin(socket, conn, { type: C2S.JOIN, room, name, cid, visibility });
  return { socket, conn };
}

// ------------------------------------------------------------------ recency

test('a beat counts, and stops counting once it goes stale', () => {
  const p = new Presence();

  p.beat('alice', T0);
  assert.equal(p.snapshot(new Set(), T0).players, 1);

  // Still inside the window: two missed beats are survivable on purpose.
  assert.equal(p.snapshot(new Set(), T0 + TTL_MS - 1).players, 1);

  // Past it: the tab is gone and so is the player.
  assert.equal(p.snapshot(new Set(), T0 + TTL_MS + 1).players, 0);
});

test('a stale beat is dropped from the table, not just from the count', () => {
  const p = new Presence();
  p.beat('alice', T0);
  p.snapshot(new Set(), T0 + TTL_MS + 1);
  assert.equal(p.beats.size, 0, 'expired entries must not accumulate');
});

test('beating again keeps a player alive indefinitely', () => {
  const p = new Presence();
  let now = T0;
  for (let i = 0; i < 20; i++) {
    p.beat('alice', now);
    now += TTL_MS - 1000;
  }
  assert.equal(p.snapshot(new Set(), now).players, 1);
});

test('a goodbye drops a player immediately rather than at the TTL', () => {
  const p = new Presence();
  p.beat('alice', T0);
  p.forget('alice');
  assert.equal(p.snapshot(new Set(), T0).players, 0);
});

test('a malformed id is refused rather than stored', () => {
  const p = new Presence();
  assert.equal(p.beat('', T0), false);
  assert.equal(p.beat(null, T0), false);
  assert.equal(p.beats.size, 0);
});

// ---------------------------------------------------------------- de-duping

test('a solo player who joins a room is one player, not two', () => {
  const p = new Presence();

  // Beating from the menu.
  p.beat('alice', T0);
  assert.deepEqual(
    pick(p.snapshot(new Set(), T0)), { players: 1, coop: 0, solo: 1 });

  // A moment later they are in a room. Their last menu beat is still inside
  // the TTL -- this is the window where a naive sum reports two of them.
  assert.deepEqual(
    pick(p.snapshot(new Set(['alice']), T0 + 1000)), { players: 1, coop: 1, solo: 0 });
});

test('distinct solo and co-op players add up', () => {
  const p = new Presence();
  p.beat('alice', T0);
  p.beat('bob', T0);
  assert.deepEqual(
    pick(p.snapshot(new Set(['carol', 'dave']), T0)),
    { players: 4, coop: 2, solo: 2 },
  );
});

const pick = ({ players, coop, solo }) => ({ players, coop, solo });

// -------------------------------------------------------------------- peak

test('peak records the high-water mark and when it happened', () => {
  const p = new Presence();
  p.beat('alice', T0);
  p.beat('bob', T0);
  p.snapshot(new Set(), T0);
  assert.equal(p.peak, 2);
  assert.equal(p.peakAt, T0);

  // Everyone leaves; the peak is history, not a live reading.
  const later = T0 + TTL_MS + 1;
  const snap = p.snapshot(new Set(), later);
  assert.equal(snap.players, 0);
  assert.equal(snap.peak, 2);
  assert.equal(snap.peakAt, T0, 'peak time must not drift to the latest sample');
});

// ------------------------------------------------------------------- bounds

test('the table is capped, so a public endpoint cannot exhaust memory', () => {
  const p = new Presence({ maxTracked: 10 });
  for (let i = 0; i < 50; i++) p.beat(`spam-${i}`, T0);
  assert.equal(p.beats.size, 10);
  assert.equal(p.snapshot(new Set(), T0).players, 10);
});

test('reaching the cap does not lock out players already being tracked', () => {
  const p = new Presence({ maxTracked: 2 });
  p.beat('alice', T0);
  p.beat('bob', T0);
  assert.equal(p.beat('mallory', T0), false, 'a new id at the cap is refused');
  assert.equal(p.beat('alice', T0 + 100), true, 'an existing id must still beat');
  assert.equal(p.beats.get('alice'), T0 + 100);
});

test('the cap makes room by first dropping the expired', () => {
  const p = new Presence({ maxTracked: 2 });
  p.beat('alice', T0);
  p.beat('bob', T0);
  // Both are long gone; a newcomer should not be turned away on their behalf.
  assert.equal(p.beat('carol', T0 + TTL_MS + 1), true);
  assert.equal(p.beats.size, 1);
});

test('MAX_TRACKED is far above any real population', () => {
  assert.ok(MAX_TRACKED >= 10_000);
});

// ----------------------------------------------------------------- id shape

test('client ids are accepted only in the shape the client generates', () => {
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  assert.equal(sanitizeClientId(uuid), uuid);
  assert.equal(sanitizeClientId(' ' + uuid + ' '), uuid);

  for (const bad of ['', null, undefined, 'short', '../../etc', '<script>', 'a'.repeat(200)]) {
    assert.equal(sanitizeClientId(bad), '', `should reject ${JSON.stringify(bad)}`);
  }
});

test('the browser replaces a stored client id the server would reject', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const stored = new Map([['blockstrike.cid', 'corrupt-value']]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
    },
  });

  try {
    const browserPresence = await import(`../src/net/presence.js?corrupt-id=${Date.now()}`);
    const id = browserPresence.clientId();
    assert.notEqual(id, 'corrupt-value');
    assert.equal(sanitizeClientId(id), id);
    assert.equal(stored.get('blockstrike.cid'), id);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('the join path and the beat path agree on which ids are valid', () => {
  // If these ever diverged, a player could be tracked under one id by their
  // socket and another by their heartbeat, and the de-duplication above would
  // silently stop working -- the exact bug that is hardest to notice in
  // production, because the number merely looks a bit high.
  const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const p = new Presence();
  p.beat(sanitizeClientId(uuid), T0);

  const server = new GameServer();
  join(server, { name: 'ALICE', cid: sanitizeClientId(uuid) });
  assert.deepEqual(pick(p.snapshot(server.connectedIds(), T0)),
    { players: 1, coop: 1, solo: 0 });
});

// ------------------------------------------------------- the server's view

test('two tabs from one browser are one player', () => {
  const server = new GameServer();
  const cid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const host = join(server, { name: 'ALICE', cid });
  const first = host.socket.last('welcome').room;
  join(server, { room: first, name: 'ALICE2', cid });

  assert.equal(server.connectedIds().size, 1);
});

test('a client with no id still counts as its own player', () => {
  const server = new GameServer();
  const host = join(server, { name: 'ALICE' });
  const first = host.socket.last('welcome').room;
  join(server, { room: first, name: 'BOB' });

  // Falling back to a shared key would collapse every storage-less client into
  // one phantom player, which under-reports exactly the browsers most likely to
  // be in use on a locked-down machine.
  assert.equal(server.connectedIds().size, 2);
});

test('private rooms are counted in the total but never named', () => {
  const server = new GameServer();
  join(server, { name: 'ALICE', visibility: VISIBILITY.PRIVATE });

  const live = server.live();
  assert.equal(live.players, 1, 'a private player is still a player');
  assert.equal(live.coop, 1);
  assert.equal(live.rooms, 1, 'the room is counted');
  assert.deepEqual(live.publicRooms, [], 'and never listed');

  const serialised = JSON.stringify(live);
  const code = [...server.rooms.keys()][0];
  assert.ok(!serialised.includes(code), 'a private room code must not reach the client');
});

test('public rooms are both counted and listed', () => {
  const server = new GameServer();
  join(server, { name: 'ALICE', visibility: VISIBILITY.PUBLIC });

  const live = server.live();
  assert.equal(live.players, 1);
  assert.equal(live.publicRooms.length, 1);
  assert.equal(live.publicRooms[0].host, 'ALICE');
});

test('live() reports solo and co-op players together', () => {
  const server = new GameServer();
  join(server, { name: 'ALICE', cid: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' });
  server.presence.beat('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

  const live = server.live();
  assert.equal(live.coop, 1);
  assert.equal(live.solo, 1);
  assert.equal(live.players, 2);
});

test('an empty server reports zero rather than throwing', () => {
  const live = new GameServer().live();
  assert.equal(live.players, 0);
  assert.equal(live.rooms, 0);
  assert.deepEqual(live.publicRooms, []);
});
