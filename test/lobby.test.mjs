// The public lobby: what the browser shows, and what it must never show.
//
// A listing is the only way a player finds a game they were not personally
// invited to, so the rules it encodes are the ones that decide whether a
// stranger can play at all: public rooms are visible, private ones are not,
// full ones say so rather than vanishing, and nobody joining a room can change
// what it is for the people already in it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GameServer } from '../server/gameserver.js';
import { MAX_PLAYERS } from '../server/room.js';
import { C2S, MODE, VISIBILITY, normalizeVisibility } from '../src/net/protocol.js';

function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
    last(type) { return [...this.sent].reverse().find((m) => m.type === type) ?? null; },
  };
}

/** Drive a join the way _onConnection would, and hand back both sides. */
function join(server, { room = '', name = 'PLAYER', mode, visibility } = {}) {
  const socket = fakeSocket();
  const conn = { room: null, id: null, name, count: 0, windowStart: Date.now() };
  server._onJoin(socket, conn, { type: C2S.JOIN, room, name, mode, visibility });
  return { socket, conn };
}

const codeOf = (seat) => seat.socket.last('welcome').room;

test('an explicitly public room is co-op even when a modified client asks for FFA', () => {
  const server = new GameServer();
  const host = join(server, {
    name: 'PLAYER', mode: MODE.FFA, visibility: VISIBILITY.PUBLIC,
  });

  const [row, ...rest] = server.listRooms();
  assert.equal(rest.length, 0, 'one room hosted, more than one listed');
  assert.equal(row.code, codeOf(host));
  assert.equal(row.host, 'PLAYER', 'the list does not say whose game it is');
  assert.equal(row.mode, MODE.COOP, 'the public launch exposed an unfinished PvP room');
  assert.equal(row.players, 1);
  assert.equal(row.max, MAX_PLAYERS);
  assert.equal(row.full, false);
  assert.equal(row.started, false, 'a room nobody has readied is still gathering');
});

test('a private room is not listed, but its code still works', () => {
  const server = new GameServer();
  const host = join(server, { name: 'HOST', visibility: VISIBILITY.PRIVATE });
  assert.deepEqual(server.listRooms(), [], 'a private room was advertised');

  const guest = join(server, { room: codeOf(host), name: 'FRIEND' });
  assert.ok(guest.socket.last('welcome'), 'a code-only room refused the code');
  assert.equal(server.rooms.size, 1);
  assert.deepEqual(server.listRooms(), [], 'joining published a private room');
});

test('a joiner cannot change what the room is for everyone already in it', () => {
  const server = new GameServer();
  const host = join(server, { name: 'HOST', mode: MODE.COOP, visibility: VISIBILITY.PRIVATE });
  join(server, {
    room: codeOf(host), name: 'GUEST', mode: MODE.FFA, visibility: VISIBILITY.PUBLIC,
  });

  const room = server.findRoom(codeOf(host));
  assert.equal(room.sim.mode, MODE.COOP, 'a joiner flipped the rule set');
  assert.equal(room.isPublic, false, 'a joiner published a private room');
  assert.deepEqual(server.listRooms(), []);
});

test('a full room is shown as full and refuses another player', () => {
  const server = new GameServer();
  const host = join(server, { name: 'P1', visibility: VISIBILITY.PUBLIC });
  const code = codeOf(host);
  for (let i = 2; i <= MAX_PLAYERS; i++) join(server, { room: code, name: `P${i}` });

  const [row] = server.listRooms();
  assert.equal(row.players, MAX_PLAYERS);
  assert.equal(row.full, true, 'a full room did not say so');

  const late = join(server, { room: code, name: 'LATE' });
  assert.equal(late.socket.last('welcome'), null, 'a ninth player got in');
  assert.match(late.socket.last('error').message, /full/i);
});

test('the list puts the games worth joining first', () => {
  const server = new GameServer();

  const gathering = join(server, { name: 'WAITING', visibility: VISIBILITY.PUBLIC });
  const running = join(server, { name: 'FIGHTING', visibility: VISIBILITY.PUBLIC });
  const busy = join(server, { name: 'CROWDED', visibility: VISIBILITY.PUBLIC });

  const runningRoom = server.findRoom(codeOf(running));
  runningRoom.setReady(1, true);                        // under way
  join(server, { room: codeOf(running), name: 'ALSO' }); // two players

  const busyCode = codeOf(busy);
  for (let i = 2; i <= MAX_PLAYERS; i++) join(server, { room: busyCode, name: `P${i}` });

  const order = server.listRooms().map((r) => r.host);
  assert.equal(order.at(-1), 'CROWDED', 'a full room was not sunk to the bottom');
  assert.ok(order.indexOf('WAITING') < order.indexOf('FIGHTING'),
    'a game that has not started should outrank one already under way');
  assert.deepEqual(order, ['WAITING', 'FIGHTING', 'CROWDED']);
  assert.equal(server.listRooms()[0].code, codeOf(gathering));
});

test('an emptied room leaves the list, and the name follows whoever is left', () => {
  const server = new GameServer();
  const host = join(server, { name: 'FIRST', visibility: VISIBILITY.PUBLIC });
  const code = codeOf(host);
  const guest = join(server, { room: code, name: 'SECOND' });
  const room = server.findRoom(code);

  room.leave(host.conn.id);
  assert.equal(server.listRooms()[0].host, 'SECOND',
    'the list still advertises a player who has gone');

  room.leave(guest.conn.id);
  assert.deepEqual(server.listRooms(), [], 'an empty room stayed on the list');
});

test('an emptied room does not carry readiness into a reconnect', () => {
  const server = new GameServer();
  const first = join(server, { name: 'FIRST' });
  const code = codeOf(first);
  const room = server.findRoom(code);
  room.setReady(first.conn.id, true);
  assert.equal(room.ready.has(first.conn.id), true);

  room.leave(first.conn.id);
  assert.equal(room.ready.size, 0, 'departed member remained in the readiness set');
  assert.equal(room.firstJoinAt, 0, 'the old loading deadline survived an empty room');

  const second = join(server, { room: code, name: 'SECOND' });
  assert.ok(second.socket.last('welcome'));
  assert.ok(room.firstJoinAt > 0, 'the reconnect did not receive a fresh loading deadline');
});

test('visibility fails closed to private for anything unrecognised', () => {
  assert.equal(normalizeVisibility(undefined), VISIBILITY.PRIVATE);
  assert.equal(normalizeVisibility('nonsense'), VISIBILITY.PRIVATE);
  assert.equal(normalizeVisibility(VISIBILITY.PUBLIC), VISIBILITY.PUBLIC);
  assert.equal(normalizeVisibility(VISIBILITY.PRIVATE), VISIBILITY.PRIVATE);
});
