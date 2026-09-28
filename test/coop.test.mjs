// Co-op joining, and the keyboard rule that made it reachable.
//
// Both halves of "we cannot join a room" live here: the server has to put two
// people who typed the same code into the same world, and the browser has to
// let them type the code in the first place.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GameServer } from '../server/gameserver.js';
import { isTextEntry } from '../src/engine/input.js';
import { normalizeRoomCode, makeRoomCode, ROOM_CODE_LENGTH } from '../src/net/protocol.js';

/** A socket stand-in that records what the server sent it. */
function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
    last(type) { return [...this.sent].reverse().find((m) => m.type === type) ?? null; },
  };
}

function fakeConn() {
  return { room: null, id: null, name: 'PLAYER', count: 0, windowStart: Date.now() };
}

/** Drive a join the way _onConnection would, and hand back both sides. */
function join(server, code, name = 'PLAYER') {
  const socket = fakeSocket();
  const conn = fakeConn();
  server._onJoin(socket, conn, { type: 'join', room: code, name });
  return { socket, conn };
}

// ------------------------------------------------------------------- joining

test('hosting with no code allocates a room', () => {
  const server = new GameServer();
  const { socket, conn } = join(server, '', 'HOST');

  const welcome = socket.last('welcome');
  assert.ok(welcome, 'host was never welcomed');
  assert.equal(welcome.room.length, ROOM_CODE_LENGTH);
  assert.ok(conn.room, 'host was not put in a room');
  assert.equal(server.rooms.size, 1);
});

test('two players using the same code land in one room on one map', () => {
  const server = new GameServer();
  const host = join(server, '', 'HOST');
  const code = host.socket.last('welcome').room;

  const guest = join(server, code, 'GUEST');
  const a = host.socket.last('welcome');
  const b = guest.socket.last('welcome');

  assert.ok(b, 'guest was never welcomed');
  assert.equal(b.room, a.room, 'guest landed in a different room');
  assert.equal(b.seed, a.seed, 'same room must mean the same terrain');
  assert.notEqual(b.id, a.id, 'players need distinct ids');
  assert.equal(server.rooms.size, 1, 'joining should not have created a room');
  assert.equal(host.conn.room, guest.conn.room);
});

test('a lowercase or padded code still finds the room', () => {
  const server = new GameServer();
  const code = join(server, '', 'HOST').socket.last('welcome').room;

  const guest = join(server, `  ${code.toLowerCase()} `, 'GUEST');
  assert.ok(guest.socket.last('welcome'), 'a sloppily typed code was rejected');
  assert.equal(server.rooms.size, 1);
});

test('an unknown code is refused instead of silently opening a new room', () => {
  const server = new GameServer();
  // Deliberately not hosting first: this is the mistyped-code case.
  const { socket, conn } = join(server, 'ZZZZ', 'LOST');

  assert.equal(socket.last('welcome'), null, 'a phantom room was joined');
  const err = socket.last('error');
  assert.ok(err, 'no error was reported');
  assert.match(err.message, /ZZZZ/);
  assert.equal(conn.room, null);
  assert.equal(server.rooms.size, 0, 'a room was created for a code nobody hosted');
});

test('generated room codes avoid glyphs that are ambiguous when read aloud', () => {
  for (let i = 0; i < 200; i++) {
    const code = makeRoomCode();
    assert.equal(code.length, ROOM_CODE_LENGTH);
    assert.doesNotMatch(code, /[OI01]/, `${code} contains an ambiguous glyph`);
    assert.equal(normalizeRoomCode(code), code, 'a fresh code should already be normal');
  }
});

// ------------------------------------------------------- typing vs. game keys

test('text fields keep their keystrokes, so a room code can be typed at all', () => {
  // The global keydown handler calls preventDefault(), which on an <input>
  // cancels the character insertion itself. Anything here that reports false
  // is a field the player cannot type into.
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT' }), true, 'type defaults to text');
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'password' }), true);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'email' }), true);
  assert.equal(isTextEntry({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTextEntry({ tagName: 'SELECT' }), true);
  assert.equal(isTextEntry({ tagName: 'DIV', isContentEditable: true }), true);
});

test('the game still owns the keyboard everywhere else', () => {
  assert.equal(isTextEntry(null), false);
  assert.equal(isTextEntry({ tagName: 'CANVAS' }), false);
  assert.equal(isTextEntry({ tagName: 'DIV' }), false);
  assert.equal(isTextEntry({ tagName: 'BODY' }), false);
  // Buttons are <input> elements that take no text: Space on a focused button
  // should still be the game's jump.
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'button' }), false);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(isTextEntry({ tagName: 'INPUT', type: 'range' }), false);
});
