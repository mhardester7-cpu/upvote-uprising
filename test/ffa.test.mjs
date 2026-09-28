// Free-for-all rules.
//
// These assert the design, not the implementation: no monsters, friendly fire
// only in FFA, a frag credits exactly one shooter, and the match ends at the
// target. A future tuning pass that quietly breaks one of those should fail here
// rather than in a live room.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GameSim } from '../src/sim/gamesim.js';
import { GameServer } from '../server/gameserver.js';
import { C2S, MODE, FFA_KILL_TARGET, FFA_RESPAWN, normalizeMode } from '../src/net/protocol.js';

/** A tiny world stub: the FFA rules never consult terrain except to respawn. */
function sim(mode) {
  const s = new GameSim(4242, { mode });
  s.generate();
  return s;
}

function twoPlayers(s) {
  const a = s.addPlayer(1, 'ALPHA');
  const b = s.addPlayer(2, 'BRAVO');
  a.pos = { x: 40, y: 4, z: 40 };
  b.pos = { x: 46, y: 4, z: 40 };
  return [a, b];
}

test('a mode is coop unless FFA is asked for by name', () => {
  assert.equal(normalizeMode(undefined), MODE.COOP);
  assert.equal(normalizeMode('nonsense'), MODE.COOP);
  assert.equal(normalizeMode(MODE.FFA), MODE.FFA);
  assert.equal(sim().mode, MODE.COOP, 'default sim is co-op');
  assert.equal(sim(MODE.FFA).isFFA, true);
});

test('a free-for-all spawns no monsters and runs no wave clock', () => {
  const s = sim(MODE.FFA);
  twoPlayers(s);
  s.running = true;
  for (let i = 0; i < 60 * 60; i++) s.tick(1 / 60);   // a full minute
  assert.equal(s.enemies.length, 0, 'FFA spawned enemies');
  assert.equal(s.wave, 0, 'FFA advanced the wave counter');
});

test('co-op still spawns waves -- the FFA branch must not swallow them', () => {
  const s = sim(MODE.COOP);
  twoPlayers(s);
  s.running = true;
  for (let i = 0; i < 60 * 30; i++) s.tick(1 / 60);
  assert.ok(s.wave >= 1, 'co-op never started a wave');
  assert.ok(s.enemies.length > 0, 'co-op spawned nothing');
});

test('friendly fire exists only in a free-for-all', () => {
  const coop = sim(MODE.COOP);
  const [, cb] = twoPlayers(coop);
  assert.equal(coop.hitPlayer(1, 2, 50), false, 'co-op accepted a player hit');
  assert.equal(cb.health, 100, 'co-op partner lost health');

  const ffa = sim(MODE.FFA);
  const [, fb] = twoPlayers(ffa);
  assert.equal(ffa.hitPlayer(1, 2, 50), true);
  assert.equal(fb.health, 50);
});

test('a frag credits the shooter once, and only a real one', () => {
  const s = sim(MODE.FFA);
  const [a, b] = twoPlayers(s);

  // Shooting yourself pays nothing -- otherwise the target is farmable.
  assert.equal(s.hitPlayer(1, 1, 500), false);
  assert.equal(a.kills, 0);
  assert.equal(a.health, 100);

  s.hitPlayer(1, 2, 100);
  assert.equal(b.alive, false, 'target survived lethal damage');
  assert.equal(a.kills, 1);
  assert.ok(a.score > 0, 'a frag paid no score');
  assert.ok(a.coins > 0, 'a frag paid no coins -- the armoury would be dead weight');

  // A corpse cannot be farmed for more kills while it waits to respawn.
  assert.equal(s.hitPlayer(1, 2, 100), false);
  assert.equal(a.kills, 1, 'shooting a dead player credited another kill');
});

test('the dead come back, and only after the respawn window', () => {
  const s = sim(MODE.FFA);
  const [, b] = twoPlayers(s);
  s.running = true;
  s.hitPlayer(1, 2, 100);
  assert.equal(b.alive, false);

  for (let i = 0; i < Math.floor((FFA_RESPAWN - 0.5) * 60); i++) s.tick(1 / 60);
  assert.equal(b.alive, false, 'respawned early');

  for (let i = 0; i < 60; i++) s.tick(1 / 60);
  assert.equal(b.alive, true, 'never respawned');
  assert.equal(b.health, b.maxHealth, 'respawned hurt');
});

test('reaching the target ends the match and then starts a fresh one', () => {
  const s = sim(MODE.FFA);
  const [a, b] = twoPlayers(s);
  s.running = true;

  for (let k = 0; k < FFA_KILL_TARGET; k++) {
    b.alive = true;
    b.health = 100;
    s.hitPlayer(1, 2, 100);
  }
  assert.equal(a.kills, FFA_KILL_TARGET);
  assert.equal(s.winnerId, 1, 'nobody won at the target');

  const over = s._events.filter((e) => e.type === 'matchOver');
  assert.equal(over.length, 1, 'matchOver fired the wrong number of times');
  assert.equal(over[0].winner, 1);

  // Nobody respawns into a decided match...
  for (let i = 0; i < 60 * 5; i++) s.tick(1 / 60);
  assert.equal(s.winnerId, 1, 'match reset early');

  // ...and then the room rolls into another round with the score wiped.
  for (let i = 0; i < 60 * 30; i++) s.tick(1 / 60);
  assert.equal(s.winnerId, null, 'match never reset');
  assert.equal(a.kills, 0, 'kills carried into the next round');
  assert.equal(a.alive, true);
});

// ------------------------------------------------------- authority over a duel
//
// A player's own client owns their body, which works in co-op because the only
// thing it can misreport is a fight against AI. In a duel those reports are a
// fifth of a second stale, and the sim has to hold its own line against the ones
// that were already in flight when it ruled.

test('a stale client report cannot undo a hit or resurrect a corpse', () => {
  const s = sim(MODE.FFA);
  const [a, b] = twoPlayers(s);
  s.running = true;

  s.hitPlayer(1, 2, 60);
  // Bravo's client has not seen that hit yet and is still reporting full health.
  s.applyPlayerState(2, { health: 100, alive: true });
  assert.equal(b.health, 40, 'a stale report handed the damage back');

  s.hitPlayer(1, 2, 60);
  assert.equal(b.alive, false, 'the follow-up shot did not land');
  assert.equal(a.kills, 1);

  // The "I am fine" that was in flight when the lethal shot landed.
  s.applyPlayerState(2, { health: 100, alive: true });
  assert.equal(b.alive, false, 'a corpse was put back on its feet');
  assert.equal(s.hitPlayer(1, 2, 100), false, 'the corpse could be shot again');
  assert.equal(a.kills, 1, 'one death credited two frags');
});

test('a client that never applies its own damage still loses the fight', () => {
  // The background-tab case, and the cheat case, are the same shape: a client
  // that keeps insisting it is at full health while the sim knows better.
  const s = sim(MODE.FFA);
  const [a, b] = twoPlayers(s);
  s.running = true;

  let shots = 0;
  for (let i = 0; i < 60 * 6 && b.alive; i++) {
    s.tick(1 / 60);
    // A pistol's rate of fire, and a client reporting the damage away between
    // every shot as fast as the protocol allows.
    if (i % 15 === 0) { s.hitPlayer(1, 2, 25); shots++; }
    if (i % 3 === 0) s.applyPlayerState(2, { health: 100, alive: true });
  }

  assert.equal(b.alive, false, 'a client reported itself immortal');
  assert.ok(shots < 30, `took ${shots} pistol shots to land a kill`);
  assert.equal(a.kills, 1);
});

test('an honest client is never held back by the heal limit', () => {
  const s = sim(MODE.FFA);
  const [, b] = twoPlayers(s);
  s.running = true;
  s.hitPlayer(1, 2, 60);
  for (let i = 0; i < 60; i++) s.tick(1 / 60);   // the hold lifts

  // Regen, reported at the protocol's rate the way the client sends it.
  let health = b.health;
  for (let i = 0; i < 60 * 2; i++) {
    s.tick(1 / 60);
    if (i % 3 === 0) {
      health = Math.min(100, health + 18 * (3 / 60));
      s.applyPlayerState(2, { health, alive: true });
    }
  }
  assert.ok(Math.abs(b.health - health) < 1,
    `regen was throttled: sim ${b.health}, client ${health}`);
});

test('a respawn is not undone by the corpse report still in flight', () => {
  const s = sim(MODE.FFA);
  const [, b] = twoPlayers(s);
  s.running = true;
  s.hitPlayer(1, 2, 100);

  let guard = 0;
  while (!b.alive && guard++ < 60 * 20) s.tick(1 / 60);
  assert.equal(b.alive, true, 'never respawned');

  s.applyPlayerState(2, { health: 0, alive: false });
  assert.equal(b.alive, true, 'a stale corpse report dropped a respawned player');
  assert.ok(b.health > 0, 'a stale corpse report emptied their health');

  // Once the window has passed, a client reporting its own death is honoured
  // again -- that is how a fall or a rocket at your own feet is meant to read --
  // and it still comes back afterwards.
  for (let i = 0; i < 60; i++) s.tick(1 / 60);
  s.applyPlayerState(2, { health: 0, alive: false });
  assert.equal(b.alive, false, 'a client can no longer report its own death');
  for (let i = 0; i < 60 * (FFA_RESPAWN + 2); i++) s.tick(1 / 60);
  assert.equal(b.alive, true, 'a self-reported death left a player out for good');
});

test("frag coins are the shooter's own, and reach the wire", () => {
  const s = sim(MODE.FFA);
  const [a, b] = twoPlayers(s);

  s.hitPlayer(1, 2, 100);
  assert.ok(a.coins > 0, 'a frag paid the shooter nothing to spend');
  assert.equal(b.coins, 0, 'a frag paid the player who was shot');
  assert.equal(s.coins, 0, 'a frag paid the shared pot, which no duel spends from');

  const mine = s.snapshot().players.find((p) => p.i === 1);
  assert.equal(mine.c, a.coins, 'the purse never reached the client');

  assert.equal(s.spendCoinsFor(2, 50), false, 'spent coins Bravo never earned');
  assert.equal(s.spendCoinsFor(1, a.coins), true);
  assert.equal(a.coins, 0);
  assert.equal(s.spendCoinsFor(1, 1), false, 'spent an empty purse');
});

test('a free-for-all does not sit in a wave break it can never leave', () => {
  // The break is not idle state on a client: it freezes the streak, holds every
  // potion timer, and owns the prompt line the door and chest prompts share.
  assert.equal(sim(MODE.FFA).waveBreak, 0);
  assert.ok(sim(MODE.COOP).waveBreak > 0, 'co-op lost its opening grace');
});

// -------------------------------------------------------- public server boundary

function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    send(raw) { this.sent.push(JSON.parse(raw)); },
    last(type) { return [...this.sent].reverse().find((m) => m.type === type) ?? null; },
  };
}

/** Ask the public server for FFA the way a modified client would. */
function duel() {
  const server = new GameServer();
  const seats = [];
  for (const name of ['ALPHA', 'BRAVO']) {
    const socket = fakeSocket();
    const conn = { room: null, id: null, name, count: 0, windowStart: Date.now() };
    const code = seats.length ? seats[0].socket.last('welcome').room : '';
    server._onJoin(socket, conn, { type: C2S.JOIN, room: code, name, mode: MODE.FFA });
    seats.push({ socket, conn });
  }
  const room = seats[0].conn.room;
  return { server, room, sim: room.sim, seats };
}

test('the public server refuses to create client-authoritative PvP rooms', () => {
  const { server, sim, seats } = duel();
  const bravo = sim.players.get(2);
  assert.equal(sim.mode, MODE.COOP, 'a crafted host request exposed PvP');

  server._handle(seats[0].socket, seats[0].conn, {
    type: C2S.HIT_PLAYER, id: 2, amount: 1_000, headshot: true,
  });
  assert.equal(bravo.health, 100, 'the public boundary accepted a player hit');
  assert.equal(sim.players.get(1).kills, 0);
});

test('the mode is on the wire, or a joining client cannot know the rules', () => {
  const s = sim(MODE.FFA);
  twoPlayers(s);
  assert.equal(s.fullState().mode, MODE.FFA);
  assert.equal(s.snapshot().mode, MODE.FFA);
  // The respawn clock has to travel too, so a dead player's HUD can count in.
  s.hitPlayer(1, 2, 100);
  const bravo = s.snapshot().players.find((p) => p.i === 2);
  assert.ok(bravo.rs > 0, 'respawn clock missing from the snapshot');
});
