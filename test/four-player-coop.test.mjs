// Four real WebSocket clients in one live co-op room.
//
// Unit tests cover room membership and simulation rules separately. This test
// keeps the actual network boundary in the loop: origin verification, JOIN /
// WELCOME, 20 Hz state reports, authoritative snapshots, ping/pong and leave
// cleanup all run through ws exactly as they do for four browser tabs.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

import WebSocket from 'ws';

import { GameServer } from '../server/gameserver.js';
import { C2S, S2C, SNAPSHOT_HZ, STATE_HZ, MODE, VISIBILITY } from '../src/net/protocol.js';

const CLIENT_COUNT = 4;
const LOAD_SECONDS = 2.25;

class TestClient {
  constructor(url, origin) {
    this.socket = new WebSocket(url, { headers: { Origin: origin } });
    this.messages = [];
    this.snapshots = [];
    this.closed = null;

    this.socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      const receivedAt = performance.now();
      const entry = { message, receivedAt, bytes: Buffer.byteLength(raw) };
      this.messages.push(entry);
      if (message.type === S2C.SNAPSHOT) this.snapshots.push(entry);
    });
    this.socket.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
  }

  opened(timeoutMs = 5_000) {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket did not open')), timeoutMs);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  send(type, payload = {}) {
    assert.equal(this.socket.readyState, WebSocket.OPEN, `socket closed before ${type}`);
    this.socket.send(JSON.stringify({ type, ...payload }));
  }

  async waitFor(type, predicate = () => true, timeoutMs = 5_000) {
    const find = () => this.messages.find(({ message }) => (
      message.type === type && predicate(message)
    ));
    const existing = find();
    if (existing) return existing.message;

    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const entry = find();
      if (entry) return entry.message;
      if (this.closed) break;
    }
    throw new Error(`Timed out waiting for ${type}`);
  }

  close() {
    if (this.socket.readyState <= WebSocket.OPEN) this.socket.close(1000, 'test complete');
  }

  async waitClosed(timeoutMs = 2_000) {
    const deadline = performance.now() + timeoutMs;
    while (!this.closed && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(this.closed, 'WebSocket did not close');
    return this.closed;
  }
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

test('four-player co-op stays synchronized under an active horde', async (t) => {
  const httpServer = http.createServer((_req, res) => res.writeHead(204).end());
  const game = new GameServer().attach(httpServer);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });

  const { port } = httpServer.address();
  const origin = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/ws`;
  const clients = [];

  t.after(async () => {
    for (const client of clients) client.close();
    game.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const join = async (room, index) => {
    const client = new TestClient(url, origin);
    clients.push(client);
    await client.opened();
    client.send(C2S.JOIN, {
      room,
      name: `PLAYER ${index + 1}`,
      mode: MODE.COOP,
      visibility: VISIBILITY.PRIVATE,
      cid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    });
    const welcome = await client.waitFor(S2C.WELCOME);
    return { client, welcome };
  };

  const first = await join('', 0);
  const seats = [first];
  for (let i = 1; i < CLIENT_COUNT; i++) seats.push(await join(first.welcome.room, i));

  assert.deepEqual(seats.map(({ welcome }) => welcome.id), [1, 2, 3, 4]);
  assert.ok(seats.every(({ welcome }) => welcome.room === first.welcome.room));
  assert.ok(seats.every(({ welcome }) => welcome.seed === first.welcome.seed));
  assert.ok(seats.every(({ welcome }) => welcome.mode === MODE.COOP));

  const room = game.findRoom(first.welcome.room);
  assert.equal(room.size, CLIENT_COUNT);

  // Exercise the busiest legitimate snapshot for this party size, not just an
  // empty opening countdown. maxLive is the actual cap the wave system uses.
  room.sim.wave = 12;
  while (room.sim.enemies.length < room.sim.maxLive) {
    room.sim.spawnEnemy(room.sim.enemies.length % 4 === 0 ? 'runner' : 'grunt');
  }
  room.sim.waveTotal = room.sim.enemies.length;
  const activeHorde = room.sim.enemies.length;
  assert.ok(activeHorde >= 25, `stress horde was unexpectedly small: ${activeHorde}`);

  for (const { client } of seats) {
    client.send(C2S.READY, { ready: true });
    client.send(C2S.PING, { t: Date.now() });
  }

  await Promise.all(seats.map(({ client }) => client.waitFor(
    S2C.SNAPSHOT,
    (message) => message.s.players.length === CLIENT_COUNT
      && message.s.enemies.length === activeHorde,
  )));
  await Promise.all(seats.map(({ client }) => client.waitFor(S2C.PONG)));

  // Start measurements after every socket has joined and received the loaded
  // state, so connection setup cannot make the cadence look better or worse.
  for (const { client } of seats) client.snapshots.length = 0;
  const lastSent = Array.from({ length: CLIENT_COUNT }, () => ({ x: 0, z: 0 }));
  let step = 0;
  const stateTimer = setInterval(() => {
    step += 1;
    for (let i = 0; i < seats.length; i++) {
      const x = 42 + i * 5 + Math.sin(step * 0.08 + i) * 2;
      const z = 48 + i * 4 + Math.cos(step * 0.08 + i) * 2;
      lastSent[i] = { x, z };
      seats[i].client.send(C2S.STATE, {
        pos: { x, y: 0, z },
        yaw: step * 0.015 + i * 0.2,
        pitch: Math.sin(step * 0.04) * 0.25,
        health: 100,
        alive: true,
        weapon: i === 3 ? 'FLAMETHROWER' : 'RIFLE',
        moving: true,
        sprinting: i % 2 === 0,
      });
    }
  }, 1_000 / STATE_HZ);

  await new Promise((resolve) => setTimeout(resolve, LOAD_SECONDS * 1_000));
  clearInterval(stateTimer);
  await new Promise((resolve) => setTimeout(resolve, 120));

  const measurements = [];
  for (let i = 0; i < seats.length; i++) {
    const { client } = seats[i];
    assert.equal(client.closed, null, `player ${i + 1} was disconnected under normal load`);

    const count = client.snapshots.length;
    const minimum = Math.floor(LOAD_SECONDS * SNAPSHOT_HZ * 0.72);
    assert.ok(count >= minimum,
      `player ${i + 1} received ${count} snapshots; expected at least ${minimum}`);

    const gaps = client.snapshots.slice(1).map((entry, index) => (
      entry.receivedAt - client.snapshots[index].receivedAt
    ));
    const medianGap = percentile(gaps, 0.5);
    const p95Gap = percentile(gaps, 0.95);
    assert.ok(medianGap <= 80,
      `player ${i + 1} median snapshot gap was ${medianGap.toFixed(1)} ms`);
    assert.ok(p95Gap <= 180,
      `player ${i + 1} p95 snapshot gap was ${p95Gap.toFixed(1)} ms`);

    const latest = client.snapshots.at(-1).message.s;
    assert.equal(latest.players.length, CLIENT_COUNT);
    assert.equal(latest.enemies.length, activeHorde);
    for (let p = 0; p < CLIENT_COUNT; p++) {
      const row = latest.players.find((player) => player.i === p + 1);
      assert.ok(row, `player ${p + 1} missing from player ${i + 1}'s snapshot`);
      assert.ok(Math.abs(row.x - lastSent[p].x) < 0.4);
      assert.ok(Math.abs(row.z - lastSent[p].z) < 0.4);
    }

    const bytes = client.snapshots.reduce((sum, entry) => sum + entry.bytes, 0);
    const bytesPerSecond = bytes / LOAD_SECONDS;
    assert.ok(bytesPerSecond < 512 * 1024,
      `player ${i + 1} snapshot stream used ${Math.round(bytesPerSecond / 1024)} KiB/s`);
    measurements.push({ count, medianGap, p95Gap, bytesPerSecond });
  }

  t.diagnostic(
    `four clients / ${activeHorde} zombies: `
    + `${Math.min(...measurements.map((m) => m.count))} snapshots minimum, `
    + `${Math.max(...measurements.map((m) => m.medianGap)).toFixed(1)} ms worst median gap, `
    + `${Math.max(...measurements.map((m) => m.p95Gap)).toFixed(1)} ms worst p95 gap, `
    + `${Math.max(...measurements.map((m) => m.bytesPerSecond / 1024)).toFixed(1)} KiB/s per client`,
  );

  // A departing fourth player must disappear promptly for all three peers;
  // otherwise its expensive skinned mesh survives as a visible ghost.
  const leaving = seats.pop().client;
  leaving.close();
  assert.equal((await leaving.waitClosed()).code, 1000);
  await Promise.all(seats.map(({ client }) => client.waitFor(
    S2C.PLAYER_LEAVE, (message) => message.id === 4,
  )));
  await Promise.all(seats.map(({ client }) => client.waitFor(
    S2C.SNAPSHOT, (message) => message.s.players.length === 3,
  )));
  assert.equal(room.size, 3);
});
