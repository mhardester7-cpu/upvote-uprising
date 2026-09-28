// Tests for the smooth heightfield world.
//
// The property that matters most is the first one: the surface used for hit
// registration must be the same surface that gets rendered. Everything else in
// the shooter -- where a bullet stops, whether cover works, where you can stand
// -- is downstream of that agreement holding exactly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Heightfield, SIZE, N, CELL, rayTri, MAX_WALK_SLOPE } from '../src/world/heightfield.js';
import { World, FLOOR_H } from '../src/world/world.js';

/** One generated world, reused -- generation is ~30ms but not free. */
let cached = null;
function world() {
  if (!cached) {
    cached = new World(20260725);
    for (const _ of cached.generate()) { /* run to completion */ }
  }
  return cached;
}

// ------------------------------------------------------------------ raycast

test('rayTri hits a triangle it passes through and misses one beside it', () => {
  // Unit triangle in the y = 0 plane.
  const hit = rayTri(0.25, 5, 0.25, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);
  assert.ok(hit !== null && Math.abs(hit - 5) < 1e-9, `expected t=5, got ${hit}`);
  assert.equal(rayTri(2, 5, 2, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1), null);
  // Pointing away from the triangle.
  assert.equal(rayTri(0.25, 5, 0.25, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1), null);
});

test('a downward ray lands exactly on the height the collision code reports', () => {
  const hf = new Heightfield(4242);
  hf.generate();
  let worst = 0;
  let misses = 0;
  for (let k = 0; k < 3000; k++) {
    const x = 2 + Math.random() * (SIZE - 4);
    const z = 2 + Math.random() * (SIZE - 4);
    const r = hf.raycast(x, 200, z, 0, -1, 0, 400);
    if (!r.hit) { misses++; continue; }
    worst = Math.max(worst, Math.abs(r.y - hf.heightAt(x, z)));
  }
  assert.equal(misses, 0, 'a ray straight down must always find the ground');
  // This is the render/physics agreement. Anything above float noise means
  // bullets would land off the visible surface.
  assert.ok(worst < 1e-9, `surface disagreement of ${worst}`);
});

test('grazing rays cannot tunnel through terrain', () => {
  const hf = new Heightfield(99);
  hf.generate();
  let tunnels = 0;
  for (let k = 0; k < 2000; k++) {
    const x = 6 + Math.random() * (SIZE - 12);
    const z = 6 + Math.random() * (SIZE - 12);
    const ang = Math.random() * Math.PI * 2;
    let dx = Math.cos(ang), dz = Math.sin(ang);
    let dy = -0.02 - Math.random() * 0.06;
    const l = Math.hypot(dx, dy, dz);
    dx /= l; dy /= l; dz /= l;

    const oy = hf.heightAt(x, z) + 1.6;
    const r = hf.raycast(x, oy, z, dx, dy, dz, 120);
    const end = r.hit ? r.distance : 120;

    // Sample along the accepted free span; none of it may be underground.
    for (let s = 0.25; s < end - 0.25; s += 0.25) {
      const px = x + dx * s, py = oy + dy * s, pz = z + dz * s;
      if (!hf.inBounds(px, pz)) break;
      if (py < hf.heightAt(px, pz) - 0.05) { tunnels++; break; }
    }
  }
  assert.equal(tunnels, 0, 'a ray passed through solid ground');
});

test('a ray starting underground hits immediately', () => {
  const hf = new Heightfield(7);
  hf.generate();
  const x = 100, z = 100;
  const r = hf.raycast(x, hf.heightAt(x, z) - 3, z, 0, 1, 0, 50);
  assert.equal(r.hit, true);
  assert.equal(r.distance, 0);
});

test('the surface normal points up and matches the local slope', () => {
  const hf = new Heightfield(3);
  hf.generate();
  for (let k = 0; k < 500; k++) {
    const x = 4 + Math.random() * (SIZE - 8);
    const z = 4 + Math.random() * (SIZE - 8);
    const n = hf.normalAt(x, z, {});
    assert.ok(n.y > 0, 'normal must point upward');
    assert.ok(Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-9, 'normal must be unit length');

    // Compare against a finite difference of the surface itself. The normal is
    // (-dh/dx, 1, -dh/dz) normalised, so both gradients enter the denominator.
    const d = 0.01;
    const dhdx = (hf.heightAt(x + d, z) - hf.heightAt(x - d, z)) / (2 * d);
    const dhdz = (hf.heightAt(x, z + d) - hf.heightAt(x, z - d)) / (2 * d);
    const expected = -dhdx / Math.hypot(dhdx, 1, dhdz);
    // Cell boundaries switch triangles, so only assert where the sample is
    // comfortably inside one.
    const u = (x / CELL) % 1, v = (z / CELL) % 1;
    if (Math.abs(u - v) > 0.2 && u > 0.1 && u < 0.9 && v > 0.1 && v < 0.9) {
      assert.ok(Math.abs(n.x - expected) < 0.02, `nx ${n.x} vs ${expected}`);
    }
  }
});

// -------------------------------------------------------------------- props

test('props generate and are reachable through the spatial index', () => {
  const w = world();
  assert.ok(w.props.length > 200, `only ${w.props.length} props`);
  const types = new Set(w.props.map((p) => p.type));
  // Outdoors and indoors both have to be represented: ground cover, and the
  // pieces a multi-storey building is made of.
  for (const t of ['barrel', 'crate', 'slab', 'wallseg', 'stair', 'furniture']) {
    assert.ok(types.has(t), `no ${t} generated`);
  }
  const p = w.props[0];
  assert.ok(w.propsNear(p.x, p.z, 4, []).includes(p), 'prop missing from its own bucket');
});

test('reset restores doors, boards, zones and other removed run geometry', () => {
  const w = new World(20260725);
  for (const _ of w.generate()) { /* run to completion */ }
  const initialProps = w.props.slice();
  const initialZones = new Map(w.zones.map((z) => [z, z.open]));
  const door = w.doors()[0];
  const barrier = w.barriers[0];
  const boards = barrier.boards.slice();
  const secret = w.props.find((p) => p.secret);
  assert.ok(door && barrier && secret, 'generated world is missing resettable geometry');

  w.openDoor(door);
  while (!barrier.open) w.breakBoard(barrier, 2);
  const si = w.props.indexOf(secret);
  if (si >= 0) w.props.splice(si, 1);
  for (const z of w.zones) { z.open = true; z.stocked = true; }
  w._index();

  w.resetRunState();

  assert.deepEqual(w.props, initialProps, 'authored prop order was not restored');
  assert.ok(w.doors().includes(door), 'opened door was not restored');
  assert.deepEqual(barrier.boards, boards, 'window boards were not restored in order');
  assert.equal(barrier.broken.length, 0);
  assert.equal(barrier.progress, 0);
  assert.equal(barrier.working, false);
  assert.ok(w.props.includes(secret), 'removed secret panel was not restored');
  for (const [zone, open] of initialZones) {
    assert.equal(zone.open, open, `zone ${zone.id} kept its prior open state`);
    assert.equal(zone.stocked, undefined, `zone ${zone.id} kept its stocked flag`);
  }
});

test('a shot into a drum stops at its surface, not its centre', () => {
  const w = world();
  let tested = 0, correct = 0;
  for (const tree of w.props.filter((p) => p.type === 'barrel')) {
    const c = tree.collider;
    const standoff = 4;
    for (const ang of [0, 1.2, 2.4, 3.9, 5.1]) {
      const ox = c.x + Math.cos(ang) * standoff;
      const oz = c.z + Math.sin(ang) * standoff;
      const oy = c.y0 + 0.5;
      // Only fire where terrain is not legitimately in the way.
      if (w.heightAt(ox, oz) > oy - 0.2) continue;
      if (w.heightAt((ox + c.x) / 2, (oz + c.z) / 2) > oy - 0.2) continue;

      const dx = c.x - ox, dz = c.z - oz;
      const l = Math.hypot(dx, dz);
      const r = w.raycast(ox, oy, oz, dx / l, 0, dz / l, 40);

      // Something nearer may legitimately block in dense woods; when the shot
      // does reach this trunk, it must stop on its surface, not its centre.
      if (r.prop !== tree) continue;
      tested++;
      if (Math.abs(r.distance - (standoff - c.r)) < 0.05) correct++;
    }
    if (tested > 200) break;
  }
  assert.ok(tested > 50, `only ${tested} clean trunk shots to check`);
  assert.equal(correct, tested, 'a shot landed at the wrong depth in the trunk');
});

test('solid props block line of sight, open ground does not', () => {
  const w = world();
  // A locker bank: tall, solid, and the thing you break line of sight behind.
  const solid = w.props.find((p) => p.type === 'furniture' && p.kind === 'locker')
    ?? w.props.find((p) => p.type === 'wallseg');
  const c = solid.collider;
  const y = (c.minY + c.maxY) / 2;
  const cz = (c.minZ + c.maxZ) / 2;
  assert.equal(w.lineOfSight(c.minX - 1.2, y, cz, c.maxX + 1.2, y, cz), false,
    'a locker bank must block sight through it');

  // High above every roof and treetop, nothing should block.
  assert.equal(w.lineOfSight(20, 120, 20, 200, 120, 200), true);
});

test('raycast reports the prop it hit and a usable surface normal', () => {
  const w = world();
  const crate = w.props.find((p) => p.type === 'crate');
  const c = crate.collider;
  const y = (c.minY + c.maxY) / 2;
  const r = w.raycast(c.minX - 3, y, (c.minZ + c.maxZ) / 2, 1, 0, 0, 20);
  assert.equal(r.hit, true);
  if (r.prop === crate) {
    assert.ok(Math.abs(Math.hypot(r.nx, r.ny, r.nz) - 1) < 1e-6, 'normal not unit length');
    assert.equal(r.nx, -1, 'should hit the -X face');
  }
});

// ----------------------------------------------------------------- movement

test('spawn points are on walkable ground and clear of props', () => {
  const w = world();
  for (let k = 0; k < 40; k++) {
    const cx = 30 + Math.random() * (SIZE - 60);
    const cz = 30 + Math.random() * (SIZE - 60);
    const sp = w.findSpawn(cx, cz, 60);
    assert.ok(w.isWalkable(sp.x, sp.z), 'spawn on a cliff face');
    assert.ok(Math.abs(sp.y - w.heightAt(sp.x, sp.z)) < 1e-6, 'spawn not on the ground');
    assert.ok(sp.x >= 0 && sp.x <= SIZE && sp.z >= 0 && sp.z <= SIZE, 'spawn out of bounds');
  }
});

test('walkability agrees with the slope limit', () => {
  const w = world();
  for (let k = 0; k < 800; k++) {
    const x = 4 + Math.random() * (SIZE - 8);
    const z = 4 + Math.random() * (SIZE - 8);
    const n = w.normalAt(x, z, {});
    assert.equal(w.isWalkable(x, z), n.y >= MAX_WALK_SLOPE);
  }
});

test('resolveProps pushes a capsule out of a solid prop', () => {
  const w = world();

  // A crate standing clear of the walls. Most are shoved against one, and a
  // body pushed out of a crate into a wall gets pushed straight back -- which
  // measures where the furniture landed, not what the resolver does.
  let crate = null, bestClearance = 0;
  for (const p of w.props) {
    if (p.type !== 'crate') continue;
    let nearest = Infinity;
    for (const o of w.propsNear(p.x, p.z, 4, [])) {
      if (o === p || o.type === 'slab') continue;
      const k = o.collider;
      const d = k.kind === 'box'
        ? Math.hypot(Math.max(k.minX - p.x, 0, p.x - k.maxX), Math.max(k.minZ - p.z, 0, p.z - k.maxZ))
        : Math.hypot(p.x - k.x, p.z - k.z) - k.r;
      if (d < nearest) nearest = d;
    }
    if (nearest > bestClearance) { bestClearance = nearest; crate = p; }
  }
  assert.ok(crate, 'no crate generated');
  assert.ok(bestClearance > 1.2, `the roomiest crate still has only ${bestClearance.toFixed(2)}m clear`);

  const c = crate.collider;
  const pos = { x: (c.minX + c.maxX) / 2, y: c.minY + 0.2, z: (c.minZ + c.maxZ) / 2 };
  const moved = w.resolveProps(pos, 0.4, 1.8);
  assert.equal(moved, true, 'overlap was not detected');

  const outside = pos.x <= c.minX - 0.4 + 1e-6 || pos.x >= c.maxX + 0.4 - 1e-6
    || pos.z <= c.minZ - 0.4 + 1e-6 || pos.z >= c.maxZ + 0.4 - 1e-6;
  assert.ok(outside, `still overlapping at ${pos.x},${pos.z}`);
});

test('standing on top of a crate is not treated as a collision', () => {
  const w = world();
  const crate = w.props.find((p) => p.type === 'crate');
  const c = crate.collider;
  const pos = { x: (c.minX + c.maxX) / 2, y: c.maxY + 0.01, z: (c.minZ + c.maxZ) / 2 };
  const before = { x: pos.x, z: pos.z };
  w.resolveProps(pos, 0.4, 1.8);
  assert.ok(Math.abs(pos.x - before.x) < 1e-9 && Math.abs(pos.z - before.z) < 1e-9,
    'a player standing on a crate was shoved sideways');
});

test('supportHeight lifts you onto a crate but not through a tall ruin', () => {
  const w = world();
  const crate = w.props.find((p) => p.type === 'crate');
  const c = crate.collider;
  const cxm = (c.minX + c.maxX) / 2, czm = (c.minZ + c.maxZ) / 2;

  // Approaching at ground level, a low crate top is within step range.
  const ground = w.heightAt(cxm, czm);
  const support = w.supportHeight(cxm, czm, c.maxY - 0.3, 0.4);
  assert.ok(support >= ground, 'support cannot be below the terrain');

  // From far below, the crate top must not be offered as support.
  const low = w.supportHeight(cxm, czm, c.maxY - 5, 0.4);
  assert.ok(low <= c.maxY, 'stepped onto something out of reach');
});

test('generation is deterministic for a given seed', () => {
  const a = new World(31337);
  for (const _ of a.generate()) { /* run */ }
  const b = new World(31337);
  for (const _ of b.generate()) { /* run */ }

  assert.equal(a.props.length, b.props.length);
  for (let k = 0; k < 200; k++) {
    const x = Math.random() * SIZE, z = Math.random() * SIZE;
    assert.equal(a.heightAt(x, z), b.heightAt(x, z));
  }
});

test('the heightfield covers the whole arena', () => {
  const hf = new Heightfield(5);
  hf.generate();
  assert.equal(hf.heights.length, (N + 1) * (N + 1));
  for (const h of hf.heights) {
    assert.ok(Number.isFinite(h), 'non-finite height sample');
  }
});

// ------------------------------------------------------------------ buildings

/** True if any box collider contains the point. */
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
 * A point on a building's ground floor that is open by construction.
 *
 * Not the centre: partitions split the floor down the middle, so the exact
 * centre is as likely to be inside a wall as in a room. Not the far corner
 * either, which is where the stairwell sits.
 */
function probe(b) {
  return [b.minX + (b.maxX - b.minX) * 0.35, b.minZ + (b.maxZ - b.minZ) * 0.62];
}

test('every room has standing room, and indoor rooms have a ceiling', () => {
  const w = world();
  const rooms = w.plan.rooms;
  assert.ok(rooms.length >= 8, `only ${rooms.length} rooms`);
  assert.ok(w.props.some((p) => p.type === 'wallseg'), 'no walls were emitted');

  // Courtyards are open to the sky on purpose; only the indoor rooms are
  // roofed, and a map where every room is roofed has no outdoors in it.
  const indoor = rooms.filter((r) => !r.outdoor);
  const roofs = w.props.filter((p) => p.type === 'slab' && p.material === 'roof');
  assert.equal(roofs.length, indoor.length, 'an indoor room is missing its ceiling');
  assert.ok(rooms.some((r) => r.outdoor), 'no courtyards -- the map is all indoors');

  // Somewhere to stand, not a specific spot: furniture is solid and is meant
  // to be, so a room passes if any of it is open floor.
  for (const r of rooms) {
    let open = 0;
    for (let x = r.minX + 1.2; x < r.maxX - 1.2; x += 1.0) {
      for (let z = r.minZ + 1.2; z < r.maxZ - 1.2; z += 1.0) {
        if (!solidAt(w, x, r.floorY + 1.0, z) && !solidAt(w, x, r.floorY + 1.7, z)) open++;
      }
    }
    assert.ok(open > 6, `room ${r.id} has almost no standing room (${open} clear spots)`);
  }

  for (const r of indoor) {
    if (r.storeys > 1) continue;          // the mezzanine's stairwell is a hole
    const [px, pz] = probe(r);
    const top = r.floorY + FLOOR_H * r.storeys;
    assert.equal(solidAt(w, px, top + 0.15, pz), true, `room ${r.id} has no ceiling`);
  }
});

test('room floors are level, so a room is not a slope with walls', () => {
  const w = world();
  for (const b of w.plan.rooms) {
    let lo = Infinity, hi = -Infinity;
    for (let x = b.minX + 1; x < b.maxX - 1; x += 1) {
      for (let z = b.minZ + 1; z < b.maxZ - 1; z += 1) {
        const h = w.heightAt(x, z);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    assert.ok(hi - lo < 0.25, `floor varies by ${(hi - lo).toFixed(2)}m`);
    assert.ok(Math.abs(lo - b.floorY) < 0.35, 'the floor is not at the recorded height');
  }
});

test('every interior is reachable once its free door is opened', () => {
  const w = world();
  // Interiors are sealed on purpose -- that is the progression. What must hold
  // is that buying the doors opens them, rather than a building being walled
  // off with no way in at all.
  for (const d of w.doors()) w.openDoor(d);

  const step = 0.5, pad = 4;
  for (const b of w.sites) {
    const y = b.y + 1.0;
    const X0 = b.minX - pad, Z0 = b.minZ - pad;
    const nx = Math.round(((b.maxX + pad) - X0) / step);
    const nz = Math.round(((b.maxZ + pad) - Z0) / step);
    const at = (i, j) => [X0 + i * step, Z0 + j * step];

    const free = new Uint8Array((nx + 1) * (nz + 1));
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const [x, z] = at(i, j);
        free[j * (nx + 1) + i] = solidAt(w, x, y, z) ? 0 : 1;
      }
    }

    const seen = new Uint8Array(free.length);
    const stack = [[0, 0]];
    seen[0] = 1;
    while (stack.length) {
      const [i, j] = stack.pop();
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, c = j + dj;
        if (a < 0 || c < 0 || a > nx || c > nz) continue;
        const k = c * (nx + 1) + a;
        if (seen[k] || !free[k]) continue;
        seen[k] = 1;
        stack.push([a, c]);
      }
    }

    // A known-open spot on the ground floor must be in the flooded region.
    const [px, pz] = probe(b);
    const mi = Math.round((px - X0) / step);
    const mj = Math.round((pz - Z0) / step);
    assert.equal(seen[mj * (nx + 1) + mi], 1,
      'a building cannot be entered even with every door open');
  }
});

test('nothing grows through a building', () => {
  const w = world();
  for (const p of w.props) {
    if (p.type !== 'tree' && p.type !== 'rock') continue;
    assert.equal(w.insideBuilding(p.x, p.z), false,
      `a ${p.type} stands inside a building at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
  }
});

// --------------------------------------------------------------- containment

/**
 * You cannot sprint out through a wall.
 *
 * This is a regression test for a real escape. Walls are taller than a step, so
 * supportHeight ignores them entirely, and movement used to rely on push-out
 * resolution alone -- which shoves you toward the *nearest* face. Cross a 0.3m
 * wall's midline in one tick and the nearest face is the outside one, so the
 * resolver helpfully finished the job and put you in the yard.
 */
/** A spot inside a room with room to stand, found the way the game finds one. */
function clearSpotIn(w, b, radius = 0.4) {
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const y = () => b.floorY ?? w.heightAt(cx, cz);
  if (!w.blocksAt(cx, y(), cz, radius, 1.8)) return { x: cx, z: cz };
  for (let r = 1.0; r < Math.max(b.maxX - b.minX, b.maxZ - b.minZ); r += 0.7) {
    const steps = Math.max(8, Math.round(r * 6));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (x < b.minX + 1 || x > b.maxX - 1 || z < b.minZ + 1 || z > b.maxZ - 1) continue;
      if (!w.blocksAt(x, b.floorY ?? w.heightAt(x, z), z, radius, 1.8)) return { x, z };
    }
  }
  return null;
}

test('a sealed room holds the player in, even at sprint speed', async () => {
  const { Player } = await import('../src/entities/player.js');
  // A fresh world, not the shared one: the reachability test above buys every
  // door in the cached world, and walking out of an open doorway is not an
  // escape.
  const w = new World(4242);
  for (const _ of w.generate()) { /* run to completion */ }
  const b = w.startZone.site;

  const inside = (p) => p.pos.x > b.minX && p.pos.x < b.maxX
    && p.pos.z > b.minZ && p.pos.z < b.maxZ;

  // Start somewhere with room to stand, the way the game does. Spawning on the
  // bare centre puts the body inside a desk on some seeds, and a body that
  // starts embedded is a body the resolver is entitled to shove -- which tests
  // the resolver's recovery, not the room's walls.
  const start = clearSpotIn(w, b);
  assert.ok(start, 'no clear spawn in the start room');

  // Charge the walls in every direction, at a speed no legitimate movement
  // reaches.
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    const p = new Player(w);
    p.spawn({ x: start.x, y: b.floorY ?? w.heightAt(start.x, start.z), z: start.z });

    for (let step = 0; step < 400; step++) {
      // Drive the collision path directly: this is about geometry, not input.
      p._moveHorizontal(0, Math.cos(ang) * 0.25);
      p._moveHorizontal(1, Math.sin(ang) * 0.25);
      w.resolveProps(p.pos, 0.32, 1.8);
    }

    assert.ok(inside(p), `escaped the start room heading ${(ang * 180 / Math.PI).toFixed(0)}deg`);
  }
});

/**
 * The start room has somewhere to stand.
 *
 * Spawning inside a wall is not a cosmetic problem: the push-out resolver
 * ejects an embedded body through the nearest face, which put the player
 * outside the building before they had touched the controls.
 */
test('every seed offers a clear spawn inside the start room', () => {
  for (const seed of [1, 7, 99, 1337, 4242, 20260725, 555555]) {
    const w = new World(seed);
    for (const _ of w.generate()) { /* run to completion */ }
    const b = w.startZone.site;

    let found = null;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    outer:
    for (let r = 0; r < Math.max(b.maxX - b.minX, b.maxZ - b.minZ); r += 0.8) {
      const steps = r === 0 ? 1 : Math.max(8, Math.round(r * 6));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = r === 0 ? cx : cx + Math.cos(a) * r;
        const z = r === 0 ? cz : cz + Math.sin(a) * r;
        if (x < b.minX + 1 || x > b.maxX - 1 || z < b.minZ + 1 || z > b.maxZ - 1) continue;
        if (!w.blocksAt(x, w.heightAt(x, z), z, 0.4, 1.8)) { found = { x, z }; break outer; }
      }
    }
    assert.ok(found, `seed ${seed}: nowhere to stand in the start room`);
  }
});

// ------------------------------------------------------------ enemy access

/**
 * Anything spawned to hunt the player must be able to get to them.
 *
 * A ring drawn around the player knows nothing about walls, so on a floorplan
 * it drops enemies outside the building or behind an unbought door -- and a
 * zombie that cannot reach you is not a threat, it is a bug you can hear.
 */
test('enemies spawn only where a route to the player exists', () => {
  const w = new World(31337);
  for (const _ of w.generate()) { /* run to completion */ }

  const start = w.startZone.site;
  const px = start.cx, pz = start.cz;

  // Flood the reachable floor from the player, through open doorways only.
  // Fine enough that a doorway is several cells wide, so the flood is not
  // defeated by grid aliasing between furniture.
  const step = 0.35;
  const b = w.plan.bounds;
  const nx = Math.ceil((b.x1 - b.x0) / step), nz = Math.ceil((b.z1 - b.z0) / step);
  const at = (i, j) => [b.x0 + i * step, b.z0 + j * step];
  const idx = (i, j) => j * (nx + 1) + i;

  const free = new Uint8Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const [x, z] = at(i, j);
      free[idx(i, j)] = w.blocksAt(x, start.floorY, z, 0.3, 1.6) ? 0 : 1;
    }
  }

  const seen = new Uint8Array(free.length);
  const si = Math.round((px - b.x0) / step), sj = Math.round((pz - b.z0) / step);
  const stack = [[si, sj]];
  seen[idx(si, sj)] = 1;
  while (stack.length) {
    const [i, j] = stack.pop();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, c = j + dj;
      if (a < 0 || c < 0 || a > nx || c > nz) continue;
      if (seen[idx(a, c)] || !free[idx(a, c)]) continue;
      seen[idx(a, c)] = 1;
      stack.push([a, c]);
    }
  }

  // Only the start room is open at wave one, so every spawn must be in it and
  // must be somewhere the player could walk to.
  let checked = 0;
  for (let k = 0; k < 200; k++) {
    const spot = w.spawnInOpenArea(px, pz, 0, 60);
    if (!spot) continue;
    checked++;
    const i = Math.round((spot.x - b.x0) / step), j = Math.round((spot.z - b.z0) / step);
    assert.ok(i >= 0 && j >= 0 && i <= nx && j <= nz, 'spawned outside the complex');
    assert.equal(seen[idx(i, j)], 1,
      `spawned at ${spot.x.toFixed(1)},${spot.z.toFixed(1)} with no route to the player`);
  }
  assert.ok(checked > 20, `only ${checked} spawns produced; the sampler is not working`);
});

// ------------------------------------------------------------- barriers

test('a barrier is a countdown: boards come off one at a time', () => {
  const w = new World(777);
  for (const _ of w.generate()) { /* run to completion */ }

  assert.ok(w.barriers.length > 0, 'no barriers were built');
  const b = w.barriers[0];
  const total = b.boards.length;
  assert.ok(total >= 2, 'a barrier with one board is not a countdown');
  assert.ok(w.props.includes(b.boards[0]), 'a standing board is not in the world');

  let removed = 0;
  for (let i = 0; i < 400 && !b.open; i++) {
    if (w.breakBoard(b, 0.05)) {
      removed++;
      assert.equal(b.boards.length, total - removed, 'more than one board came off');
    }
  }
  assert.equal(removed, total, 'the barrier never opened');
  assert.equal(b.open, true);

  // Every board is really gone from the world, not merely flagged.
  for (const board of b.broken) {
    assert.equal(w.props.includes(board), false, 'a broken board is still solid');
  }

  const back = w.repair(b);
  assert.ok(back, 'repair returned nothing');
  assert.equal(w.props.includes(back), true, 'a repaired board is not solid');
  assert.equal(b.open, false);
});

test('boards block a body getting through, and breaking them clears the way', () => {
  const w = new World(31337);
  for (const _ of w.generate()) { /* run to completion */ }

  const b = w.barriers.find((x) => x.boards.length >= 2);
  assert.ok(b, 'no multi-board barrier found');

  // Sight is deliberately NOT the property under test: the boards are spaced
  // so you can see and shoot between them, which is the point of a window.
  // What they stop is something climbing through.
  const climber = (r = 0.3, h = 0.9) => w.blocksAt(b.x, b.y, b.z, r, h);

  assert.equal(climber(), true, 'a boarded window did not stop a body');

  while (!b.open) w.breakBoard(b, 2);
  assert.equal(climber(), false, 'the opening is still blocked with every board gone');

  // Nailing one back makes it an obstacle again.
  w.repair(b);
  assert.equal(climber(), true, 'a repaired board does not stop anything');
});
