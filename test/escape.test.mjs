// The way out.
//
// The complex is sealed on purpose, and almost every other test in this suite
// depends on that staying true -- parapets you cannot climb, upper windows too
// short to fit through, walls run up through the slab above. The escape door
// punches one hole in that shell, so the thing worth testing is not that the
// hole exists but that it is the ONLY one, that it is shut until somebody opens
// for it, and that once open it lets a body through in both directions.
//
// A door you can leave by but not come back through would be a trap rather than
// a door, and the perimeter is meant to be somewhere you visit.

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world/world.js';
import { SPACEPORT_PRICE, OUTSIDE_ZONE, PROP_DOOR } from '../src/world/complex.js';
import { NavGrid } from '../src/world/navgrid.js';

const SEEDS = [1, 7, 99, 1337, 4242, 20260725, 555555];

function built(seed) {
  const w = new World(seed);
  for (const _ of w.generate()) { /* run to completion */ }
  return w;
}

/** One generated world, reused -- generation is not free. */
let cached = null;
const world = () => (cached ??= built(20260725));

const escapeDoor = (w) => w.props.find((p) => p.type === PROP_DOOR && p.escape) ?? null;

function solidAt(w, x, y, z) {
  for (const p of w.props) {
    const c = p.collider;
    if (c.kind !== 'box') continue;
    if (x >= c.minX && x <= c.maxX && y >= c.minY && y <= c.maxY
      && z >= c.minZ && z <= c.maxZ) return true;
  }
  return false;
}

/**
 * Can a body at floor level get from `from` to anywhere outside the complex?
 *
 * A flood fill on a half-metre grid at chest height, which is the height that
 * decides whether a gap is a way through: a ground-floor window sits over a
 * metre up, so sampling here correctly reads an unboarded window as the wall it
 * is to anything that walks.
 */
function escapesFrom(w, from, y) {
  const b = w.plan.bounds;
  const step = 0.5, pad = 6;
  const X0 = b.x0 - pad, Z0 = b.z0 - pad;
  const nx = Math.round(((b.x1 + pad) - X0) / step);
  const nz = Math.round(((b.z1 + pad) - Z0) / step);
  const at = (i, j) => [X0 + i * step, Z0 + j * step];

  // Rasterize the same independent AABB predicate once. Scanning every prop
  // at every flood-fill visit becomes quadratic on a 384-metre facility.
  const blocked = new Uint8Array((nx + 1) * (nz + 1));
  for(const prop of w.props) {
    const c=prop.collider;
    if(c.kind!=='box'||y<c.minY||y>c.maxY)continue;
    const loX=Math.max(0,Math.ceil((c.minX-X0)/step));
    const hiX=Math.min(nx,Math.floor((c.maxX-X0)/step));
    const loZ=Math.max(0,Math.ceil((c.minZ-Z0)/step));
    const hiZ=Math.min(nz,Math.floor((c.maxZ-Z0)/step));
    for(let j=loZ;j<=hiZ;j++)for(let i=loX;i<=hiX;i++)blocked[j*(nx+1)+i]=1;
  }
  const seen = new Uint8Array((nx + 1) * (nz + 1));
  const si = Math.round((from.x - X0) / step);
  const sj = Math.round((from.z - Z0) / step);
  const stack = [[si, sj]];
  seen[sj * (nx + 1) + si] = 1;

  while (stack.length) {
    const [i, j] = stack.pop();
    const [x, z] = at(i, j);
    // Reached open ground beyond the shell: that is an escape.
    if (x < b.x0 - 1.5 || x > b.x1 + 1.5 || z < b.z0 - 1.5 || z > b.z1 + 1.5) return true;

    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, c = j + dj;
      if (a < 0 || c < 0 || a > nx || c > nz) continue;
      const k = c * (nx + 1) + a;
      if (seen[k]) continue;
      const [px, pz] = at(a, c);
      if (blocked[k]) continue;
      seen[k] = 1;
      stack.push([a, c]);
    }
  }
  return false;
}

/** A spot with room to stand, near a point, searched outward. */
function clearNear(w, x, z, y, radius = 0.4) {
  if (!w.blocksAt(x, y, z, radius, 1.8)) return { x, z };
  for (let r = 0.6; r < 6; r += 0.5) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (!w.blocksAt(px, y, pz, radius, 1.8)) return { x: px, z: pz };
    }
  }
  return null;
}

// -------------------------------------------------------------- the door

test('every generated door is physical and free, including the spaceport airlock', () => {
  for (const seed of SEEDS) {
    const w = built(seed);
    const escapes = w.props.filter((p) => p.type === PROP_DOOR && p.escape);
    assert.equal(escapes.length, 1, `seed ${seed} has ${escapes.length} escape doors`);
    assert.equal(escapes[0].price, SPACEPORT_PRICE, `seed ${seed} mispriced`);
    const doors = w.props.filter((p) => p.type === PROP_DOOR);
    assert.ok(doors.some((door) => !door.escape && !door.reclosable),
      `seed ${seed}: interior progression doors disappeared when made free`);
    for (const door of doors) assert.equal(door.price, 0, `seed ${seed}: ${door.zone} costs coins`);
    for (const link of w.plan.links.filter((candidate) => candidate.barrier)) {
      assert.ok(doors.some((door) => door.link === link),
        `seed ${seed}: free barrier link has no physical door`);
    }
  }
});

test('the escape door stands in the shell of an indoor room', () => {
  for (const seed of SEEDS) {
    const w = built(seed);
    const door = escapeDoor(w);
    const b = w.plan.bounds;
    const eps = 0.61;   // half the exterior wall thickness, plus rounding

    const onShell = Math.abs(door.x - b.x0) < eps || Math.abs(door.x - b.x1) < eps
      || Math.abs(door.z - b.z0) < eps || Math.abs(door.z - b.z1) < eps;
    assert.ok(onShell,
      `seed ${seed}: escape door at ${door.x.toFixed(1)},${door.z.toFixed(1)} is not on the perimeter`);

    // Escaping out of a courtyard would be walking from one open yard into
    // another. It has to lead out of a room with a roof on it.
    const room = w.plan.rooms.find((r) => r.id === door.link.room);
    assert.ok(room && !room.outdoor, `seed ${seed}: escape door opens off a courtyard`);
  }
});

test('the spaceport airlock opens directly from the starting room', () => {
  for (const seed of SEEDS) {
    const w = built(seed);
    const room = w.plan.rooms.find((r) => r.id === escapeDoor(w).link.room);
    assert.equal(room.id, w.plan.start, `seed ${seed}: the airlock is not in the first room`);
    assert.equal(room.depth, 0, `seed ${seed}: the first-room airlock has nonzero depth`);
  }
});

// ------------------------------------------------------------- the sealing

test('with the escape door shut, the complex is still sealed', () => {
  for (const seed of SEEDS) {
    const w = built(seed);
    const door = escapeDoor(w);

    // Open everything EXCEPT the way out. This is the state a player spends most
    // of a run in, and it is the one where the old guarantee has to still hold.
    for (const d of w.doors()) {
      if (d !== door) w.openDoor(d);
    }

    const start = w.startZone.site;
    const y = start.floorY + 1.0;
    const from = clearNear(w, start.cx, start.cz, start.floorY);
    assert.ok(from, `seed ${seed}: nowhere to stand in the start room`);

    assert.equal(escapesFrom(w, from, y), false,
      `seed ${seed}: got out of the complex without opening the escape door`);
  }
});

test('opening the escape door opens the only route out', () => {
  for (const seed of SEEDS) {
    const w = built(seed);
    for (const d of w.doors()) w.openDoor(d);

    const start = w.startZone.site;
    const y = start.floorY + 1.0;
    const from = clearNear(w, start.cx, start.cz, start.floorY);

    assert.equal(escapesFrom(w, from, y), true,
      `seed ${seed}: opened every door and still could not get out`);
  }
});

// ------------------------------------------------------------- both ways

test('the escape door is a door, not a one-way trip', async () => {
  const { Player } = await import('../src/entities/player.js');

  for (const seed of SEEDS) {
    const w = built(seed);
    const door = escapeDoor(w);
    const link = door.link;
    const room = w.plan.rooms.find((r) => r.id === link.room);
    w.openDoor(door);

    // The door's own outward normal, so this works whichever wall it landed on.
    const nx = link.axis === 'x' ? Math.sign(door.x - room.cx) : 0;
    const nz = link.axis === 'z' ? Math.sign(door.z - room.cz) : 0;

    // Ground-following, not just horizontal movement. The apron outside the
    // shell rises a couple of metres over the first few strides, and a body
    // driven purely sideways climbs it and never comes back down -- it then
    // arrives back at the doorway with its head above the opening and reads as
    // a threshold bug that is not there. Gravity is what the real loop applies
    // between frames, and settling onto the support each step is the cheapest
    // honest stand-in for it.
    const walk = (from, dirX, dirZ, steps = 260) => {
      const p = new Player(w);
      p.spawn({ x: from.x, y: from.y, z: from.z });
      for (let i = 0; i < steps; i++) {
        // Walking, not falling. The step-up allowance drops to 5cm in the air
        // and the floor slab stands 6cm proud of the ground outside, so a body
        // the movement code thinks is airborne cannot cross the threshold -- it
        // reads as a sealed doorway when the doorway is wide open.
        p.onGround = true;
        p._moveHorizontal(0, dirX * 0.06);
        p._moveHorizontal(1, dirZ * 0.06);
        w.resolveProps(p.pos, 0.32, 1.8);
        p.pos.y = w.supportHeight(p.pos.x, p.pos.z, p.pos.y + 0.5, 0.32);
      }
      return p.pos;
    };

    // Start just inside the doorway, walk out.
    const inX = door.x - nx * 1.6, inZ = door.z - nz * 1.6;
    const out = walk({ x: inX, y: room.floorY, z: inZ }, nx, nz);
    const gotOut = link.axis === 'x'
      ? Math.abs(out.x - door.x) > 2.0 && Math.sign(out.x - door.x) === nx
      : Math.abs(out.z - door.z) > 2.0 && Math.sign(out.z - door.z) === nz;
    assert.ok(gotOut, `seed ${seed}: could not walk out through an open escape door`);

    // Now the return leg, which is the half that a threshold step would break.
    const back = walk({ x: out.x, y: out.y, z: out.z }, -nx, -nz);
    const gotIn = link.axis === 'x'
      ? Math.sign(back.x - door.x) === -nx && Math.abs(back.x - door.x) > 1.0
      : Math.sign(back.z - door.z) === -nz && Math.abs(back.z - door.z) > 1.0;
    assert.ok(gotIn, `seed ${seed}: walked out and could not get back in`);
  }
});

// ------------------------------------------------------------ the perimeter

test('the perimeter is a zone that lies outside the shell but inside the world', () => {
  for (const seed of SEEDS) {
    const w = built(seed);
    const zone = w.zones.find((z) => z.id === OUTSIDE_ZONE);
    assert.ok(zone, `seed ${seed}: no perimeter zone`);

    const s = zone.site;
    const b = w.plan.bounds;

    // Entirely beyond the shell on the axis it opens from.
    const beyond = s.maxX <= b.x0 + 0.01 || s.minX >= b.x1 - 0.01
      || s.maxZ <= b.z0 + 0.01 || s.minZ >= b.z1 - 0.01;
    assert.ok(beyond, `seed ${seed}: the perimeter zone overlaps the complex`);

    // And still on the map: the player is clamped to the world, so a zone that
    // ran off the edge would spawn bodies somewhere nobody can reach.
    assert.ok(s.minX >= 0 && s.minZ >= 0 && s.maxX <= w.size && s.maxZ <= w.size,
      `seed ${seed}: the perimeter zone runs off the map`);

    // No floor of its own: out here the ground is terrain, and anything that
    // reads floorY would place chests at a height the hill is not at.
    assert.equal(s.floorY, undefined, `seed ${seed}: the perimeter has a slab`);
  }
});

test('the perimeter is shut until its free door is opened', () => {
  const w = built(4242);
  const zone = w.zones.find((z) => z.id === OUTSIDE_ZONE);
  assert.equal(zone.open, false, 'the perimeter starts open');

  w.openDoor(escapeDoor(w));
  assert.equal(zone.open, true, 'opening the escape door did not open the perimeter');
});

test('the exterior zone retains the deepest spawn tier', () => {
  const w = world();
  const zone = w.zones.find((z) => z.id === OUTSIDE_ZONE);
  const deepest = Math.max(...w.zones.filter((z) => z.id !== OUTSIDE_ZONE).map((z) => z.tier));
  assert.ok(zone.tier >= deepest,
    `the perimeter is tier ${zone.tier} but the complex reaches ${deepest}`);
});

// ------------------------------------------------------------ navigation

test('the flow field covers the ground the escape door opens onto', () => {
  for (const seed of SEEDS) {
    const w = built(seed);
    const zone = w.zones.find((z) => z.id === OUTSIDE_ZONE);
    const nav = new NavGrid(w);

    // Every corner of the perimeter, not just its centre: a grid that stopped
    // at the plan plus a margin covered the near edge and missed the far one,
    // which is exactly the half a player would retreat to.
    const s = zone.site;
    for (const [x, z] of [[s.minX, s.minZ], [s.maxX, s.minZ], [s.minX, s.maxZ],
      [s.maxX, s.maxZ], [s.cx, s.cz]]) {
      const i = nav.toCellX(x), j = nav.toCellZ(z);
      assert.ok(nav.inGrid(i, j),
        `seed ${seed}: ${x.toFixed(1)},${z.toFixed(1)} is off the navigation grid`);
    }
  }
});

test('the grid spans the whole world, so there is nowhere to kite from', () => {
  const w = world();
  const nav = new NavGrid(w);
  // The corners of the map. A player clamped to the world can stand on any of
  // them, and a body with no field walks straight at them into a wall.
  for (const [x, z] of [[0.5, 0.5], [w.size - 0.5, 0.5],
    [0.5, w.size - 0.5], [w.size - 0.5, w.size - 0.5]]) {
    assert.ok(nav.inGrid(nav.toCellX(x), nav.toCellZ(z)),
      `${x},${z} is off the navigation grid`);
  }
});
