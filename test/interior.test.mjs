// Tests for the interiors: the storeys, the way up them, and the ways out.
//
// These are all the same question asked four ways -- is the inside of the
// building a place a body can actually be? A floorplan can be correct on paper
// and unplayable in practice for reasons that never show up in a screenshot: a
// flight of stairs with a hole at the top, a wall you can stand on, a pocket of
// floor you cannot walk out of. Every one of those shipped at least once, so
// every one of them has a test here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world/world.js';
import { Player } from '../src/entities/player.js';
import { chamferedBox } from '../src/render/archmesh.js';
import {
  levelsOf, levelY, stairWell, doorwayCenter,
  FLOOR_H, SLAB_T, DOOR_W, DOOR_H,
} from '../src/world/complex.js';
import { ENEMY_TYPES } from '../src/entities/enemy.js';
import { BuildingRenderer } from '../src/render/buildings.js';

let cached = null;
function world() {
  if (!cached) {
    cached = new World(20260725);
    for (const _ of cached.generate()) { /* run to completion */ }
  }
  return cached;
}

const DT = 1 / 60;
const input = (held) => ({ moveAxis: null, actionDown: (k) => !!held[k] });

/** Drive a player from a standing start for `ticks` frames. */
function run(w, at, yaw, held, ticks) {
  const p = new Player(w);
  p.spawn(at);
  p.yaw = yaw;
  let highestStanding = p.pos.y;
  for (let i = 0; i < ticks; i++) {
    p.update(DT, input(held));
    if (p.onGround) highestStanding = Math.max(highestStanding, p.pos.y);
  }
  return { p, highestStanding };
}

// ------------------------------------------------------------------ geometry

test('every face of a chamfered box is wound to face outwards', () => {
  // Backface culling drops a triangle wound the wrong way round, and what you
  // see through the hole is the inside of the far face -- which is exactly what
  // a see-through table looks like. The normals are the reference: they were
  // always right, and it was the corner order that was not.
  for (const dims of [[2.4, 1.1, 0.6], [0.4, 3.4, 8.2], [1.0, 1.0, 1.0]]) {
    const g = chamferedBox(...dims, 0.038, 1.2);
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i += 9) {
      const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
      const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
      const facing = (uy * vz - uz * vy) * n[i]
        + (uz * vx - ux * vz) * n[i + 1]
        + (ux * vy - uy * vx) * n[i + 2];
      assert.ok(facing > 0, `triangle ${i / 9} of a ${dims.join('x')} box faces inwards`);
    }
  }
});

test('every storey of every room has a floor and a way up to it', () => {
  const w = world();
  const multi = w.plan.rooms.filter((r) => r.storeys > 1);
  assert.ok(multi.length > 0, 'no room has an upper storey at all');

  for (const r of multi) {
    for (let k = 1; k < r.storeys; k++) {
      const well = stairWell(r, k);
      assert.ok(well, `room ${r.id} storey ${k} has no stairwell`);

      const slabs = w.props.filter((p) => p.type === 'slab' && p.room === r.id && p.storey === k);
      assert.ok(slabs.length > 0, `room ${r.id} storey ${k} has no floor`);

      const stairs = w.props.filter((p) => p.type === 'stair' && p.room === r.id && p.storey === k);
      assert.ok(stairs.length > 0, `room ${r.id} storey ${k} has no flight`);

      // The top tread has to finish level with the floor it serves, or you
      // arrive at the top of the stairs and step into a hole.
      const highest = Math.max(...stairs.map((s) => s.collider.maxY));
      assert.ok(Math.abs(highest - levelY(r, k)) < 0.02,
        `room ${r.id} flight ${k} tops out at ${highest.toFixed(2)}, floor is at ${levelY(r, k).toFixed(2)}`);
    }
  }
});

test('a player can walk up every flight in the building', () => {
  const w = world();
  for (const r of w.plan.rooms.filter((x) => x.storeys > 1)) {
    for (let k = 1; k < r.storeys; k++) {
      const well = stairWell(r, k);
      const base = levelY(r, k - 1);
      const { p } = run(w, {
        x: (well.minX + well.maxX) / 2,
        y: base + 0.4,
        z: well.dir > 0 ? well.minZ + 0.25 : well.maxZ - 0.25,
      }, well.dir > 0 ? Math.PI : 0, { forward: true }, 240);

      assert.ok(p.pos.y >= levelY(r, k) - 0.05,
        `room ${r.id} flight ${k}: walked to ${p.pos.y.toFixed(2)}, wanted ${levelY(r, k).toFixed(2)}`);
    }
  }
});

// ------------------------------------------------------------------- escapes

test('airborne step allowance cannot turn a head-on jump into a wall climb', () => {
  // Elevated parkour routes are now intentional. Keep the original collision
  // regression focused on its actual bug: granting the ground step in midair.
  const wallTop = 1.8;
  const w = {
    inBounds: () => true, isWalkable: () => true, resolveProps() {},
    ceilingAt: () => Infinity, lineOfSight: () => true,
    blocksAt: (_x, y, z, half, _height, step = 0.65) => z - half < 0 && y + step < wallTop,
    supportHeight: (_x, z, y, half, lift = 0.65) => z - half < 0 && y + lift >= wallTop ? wallTop : 0,
  };
  const { p, highestStanding } = run(w, { x: 0, y: 0, z: 2 }, 0,
    { forward: true, jump: true, sprint: true }, 300);
  assert.equal(highestStanding, 0, 'airborne step allowance lifted the player onto the wall');
  assert.ok(p.pos.z >= p.half, 'jumping tunneled through a solid wall');
});

test('a courtyard is walled higher than anything in it can be jumped from', () => {
  const w = world();
  const yards = w.plan.rooms.filter((r) => r.outdoor);
  assert.ok(yards.length > 0, 'no courtyards generated');

  for (const r of yards) {
    // Nothing standable in the open air may be tall enough to start a chain.
    for (const p of w.props) {
      if (p.room !== r.id) continue;
      if (p.type !== 'furniture' && p.type !== 'crate') continue;
      const height = p.collider.maxY - r.floorY;
      assert.ok(height <= 1.15,
        `a ${p.kind ?? p.type} ${height.toFixed(2)}m tall stands in courtyard ${r.id}`);
    }

    // And its walls run well past the storey, rather than stopping at it.
    const walls = w.props.filter((p) => p.type === 'wallseg' && p.room === r.id);
    const top = Math.max(...walls.map((p) => p.collider.maxY));
    assert.ok(top >= r.floorY + FLOOR_H + 1.2,
      `courtyard ${r.id} is walled to ${(top - r.floorY).toFixed(2)}m`);
  }
});

// -------------------------------------------------------------------- stuck

test('nowhere a body can stand is somewhere it cannot walk out of', () => {
  const w = world();
  const stuck = [];

  for (const r of w.plan.rooms) {
    for (const floorY of (r.outdoor ? [r.floorY] : levelsOf(r))) {
      for (let i = 0; i < 40; i++) {
        const x = r.minX + 0.6 + ((i * 7919) % 997) / 997 * (r.maxX - r.minX - 1.2);
        const z = r.minZ + 0.6 + ((i * 104729) % 991) / 991 * (r.maxZ - r.minZ - 1.2);
        // Only somewhere a body could legitimately be standing.
        if (w.blocksAt(x, floorY, z, 0.32, 1.8)) continue;
        // And never actually inside anything.
        assert.ok(!w.blocksAt(x, floorY, z, 0.02, 1.8),
          `a legal stand at ${x.toFixed(1)},${floorY.toFixed(1)},${z.toFixed(1)} is inside a solid`);

        let best = 0;
        for (let d = 0; d < 8 && best < 0.5; d++) {
          const { p } = run(w, { x, y: floorY, z }, (d / 8) * Math.PI * 2, { forward: true }, 60);
          best = Math.max(best, Math.hypot(p.pos.x - x, p.pos.z - z));
        }
        if (best < 0.5) stuck.push(`${r.id}@${x.toFixed(1)},${z.toFixed(1)}`);
      }
    }
  }

  assert.equal(stuck.length, 0, `wedged in: ${stuck.slice(0, 5).join(' ')}`);
});

test('jumping under a mezzanine does not fire the player across the room', () => {
  const w = world();
  // The resolver used to push a body out of whatever it overlapped along the
  // shortest horizontal axis. A head clipping the underside of a floor slab
  // that covers a whole room made that axis metres long, so a jump under a
  // mezzanine threw the player through the exterior wall.
  const r = w.plan.rooms.find((x) => x.storeys > 1 && !x.outdoor);
  assert.ok(r, 'no multi-storey room');

  for (let i = 0; i < 30; i++) {
    const x = r.minX + 1.5 + ((i * 7919) % 997) / 997 * (r.maxX - r.minX - 3);
    const z = r.minZ + 1.5 + ((i * 104729) % 991) / 991 * (r.maxZ - r.minZ - 3);
    if (w.blocksAt(x, r.floorY, z, 0.32, 1.8)) continue;

    const p = new Player(w);
    p.spawn({ x, y: r.floorY, z });
    let jumped = 0;
    for (let t = 0; t < 120; t++) {
      const before = { x: p.pos.x, z: p.pos.z };
      p.update(DT, input({ jump: true }));
      jumped = Math.max(jumped, Math.hypot(p.pos.x - before.x, p.pos.z - before.z));
    }
    // Standing still and jumping, nothing should move you horizontally at all.
    assert.ok(jumped < 0.4,
      `a standing jump at ${x.toFixed(1)},${z.toFixed(1)} moved the player ${jumped.toFixed(2)}m sideways`);
  }
});

// ---------------------------------------------------------------- furnishing

test('every storey is furnished, and none of it blocks a doorway', () => {
  const w = world();

  for (const r of w.plan.rooms) {
    if (r.outdoor) continue;
    for (let k = 0; k < r.storeys; k++) {
      const on = w.props.filter((p) => p.room === r.id && p.storey === k
        && (p.type === 'furniture' || p.type === 'crate' || p.type === 'barrel'));
      assert.ok(on.length > 0, `room ${r.id} storey ${k} is unfurnished`);
    }
  }

  // A doorway with a desk in it is a door that does not open, and on this map
  // doorways are bought.
  for (const l of w.plan.links) {
    const mid = doorwayCenter(l);
    const cx = l.axis === 'x' ? l.at : mid;
    const cz = l.axis === 'x' ? mid : l.at;
    for (const p of w.propsNear(cx, cz, 3, [])) {
      if (p.type !== 'furniture' && p.type !== 'crate' && p.type !== 'barrel') continue;
      if ((p.storey ?? 0) !== 0) continue;         // doorways are cut at ground level
      const c = p.collider;
      const d = c.kind === 'box'
        ? Math.hypot(Math.max(c.minX - cx, 0, cx - c.maxX), Math.max(c.minZ - cz, 0, cz - c.maxZ))
        : Math.hypot(cx - c.x, cz - c.z) - c.r;
      assert.ok(d >= DOOR_W / 2,
        `a ${p.type} sits ${d.toFixed(2)}m from the middle of a doorway between ${l.a} and ${l.b}`);
    }
  }
});

test('two pieces of furniture never make a pocket a body cannot leave', () => {
  const w = world();
  const pieces = w.props.filter((p) => p.type === 'furniture' && p.collider.kind === 'box');

  for (const a of pieces) {
    for (const b of w.propsNear(a.x, a.z, 3, [])) {
      if (b === a || b.type !== 'furniture' || b.collider.kind !== 'box') continue;
      if ((a.storey ?? 0) !== (b.storey ?? 0)) continue;
      const ca = a.collider, cb = b.collider;
      const gapX = Math.max(cb.minX - ca.maxX, ca.minX - cb.maxX);
      const gapZ = Math.max(cb.minZ - ca.maxZ, ca.minZ - cb.maxZ);
      const gap = Math.max(gapX, gapZ);
      // Either they are clear of each other by more than a body's width, or
      // they do not face each other at all.
      assert.ok(gap > 0.64 || gapX > 0.64 || gapZ > 0.64,
        `two pieces on storey ${a.storey ?? 0} leave a ${gap.toFixed(2)}m slot`);
    }
  }
});

// ------------------------------------------------------------------ windows

test('boarded windows are a ground-floor thing, and upper ones let nobody in', () => {
  const w = world();

  for (const b of w.barriers) {
    const rel = b.y - b.room.floorY;
    assert.ok(rel < FLOOR_H,
      `a barrier sits ${rel.toFixed(2)}m up, on a storey a zombie would fall through`);
  }

  // Upper storeys are still opened up -- daylight and sightlines -- but the
  // opening is shorter than a body, so it is not a way in or a way out.
  const w2 = w;
  for (const r of w2.plan.rooms.filter((x) => x.storeys > 1 && !x.outdoor)) {
    const level = levelY(r, 1);
    const shell = w2.props.filter((p) => p.type === 'wallseg' && p.room === r.id
      && p.material === 'shell'
      && p.collider.minY >= level - 0.01 && p.collider.minY < level + FLOOR_H);
    if (!shell.length) continue;
    // Sill course and head course both exist, and the gap between them is
    // shorter than the 1.8m a body needs.
    const sills = shell.filter((p) => p.collider.maxY < level + 2.2).map((p) => p.collider.maxY);
    const heads = shell.filter((p) => p.collider.minY > level + 1.4).map((p) => p.collider.minY);
    if (!sills.length || !heads.length) continue;
    const opening = Math.min(...heads) - Math.min(...sills);
    assert.ok(opening < 1.8,
      `room ${r.id} has a ${opening.toFixed(2)}m opening on its first floor`);
  }
});

// ------------------------------------------------------------------ headroom

test('every enemy fits through every door and under every ceiling', () => {
  const w = world();
  const headroom = FLOOR_H - SLAB_T;

  // The narrowest thing anything has to walk through, other than a doorway.
  const wells = [];
  for (const r of w.plan.rooms) {
    for (let k = 1; k < r.storeys; k++) {
      const s = stairWell(r, k);
      if (s) wells.push(Math.min(s.maxX - s.minX, s.maxZ - s.minZ));
    }
  }
  const stairW = Math.min(...wells);

  for (const t of Object.values(ENEMY_TYPES)) {
    assert.ok(t.width < DOOR_W - 0.3, `${t.label} (${t.width} wide) will not fit a ${DOOR_W} doorway`);
    assert.ok(t.height < DOOR_H - 0.1, `${t.label} (${t.height} tall) will not fit under a ${DOOR_H} door head`);
    assert.ok(t.height < headroom - 0.2, `${t.label} does not clear a ${headroom.toFixed(2)}m ceiling`);
    assert.ok(t.width < stairW - 0.3, `${t.label} will not fit a ${stairW.toFixed(2)}m stairwell`);
  }

  // And the rooms really do have that headroom, rather than the walls simply
  // being taller than the ceiling they meet.
  for (const r of w.plan.rooms) {
    if (r.outdoor) continue;
    for (const y of levelsOf(r)) {
      const above = w.ceilingAt(r.cx, r.cz, y, 0.6);
      assert.ok(above - y >= headroom - 0.01,
        `room ${r.id} has ${(above - y).toFixed(2)}m of headroom`);
    }
  }
});

test('no pilaster stands in a doorway', () => {
  const w = world();
  // The relief is placed on a fixed pitch along each wall. A pier that lands on
  // an opening is a post in the middle of a door you have paid to unlock.
  const renderer = new BuildingRenderer({ add() {}, remove() {} }, w);
  for (const l of w.plan.links) {
    const mid = doorwayCenter(l);
    const x = l.axis === 'x' ? l.at : mid;
    const z = l.axis === 'x' ? mid : l.at;
    assert.ok(renderer._inOpening(x, z, 0.5),
      `the middle of the doorway between ${l.a} and ${l.b} does not read as an opening`);
  }
});
