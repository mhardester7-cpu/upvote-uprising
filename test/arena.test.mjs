// The authored versus map, and the loadouts played on it.
//
// A generated map is tested for properties -- every room reachable, nothing
// growing through a wall. An authored one has to be tested for those AND for
// the promise it exists to make: that the two halves are identical. Symmetry is
// the one thing a human typing coordinates gets wrong, and the one thing a
// player will notice within a single match.

import test from 'node:test';
import assert from 'node:assert/strict';

import { planArena, ARENA_W, ARENA_D } from '../src/world/arena.js';
import { World, MAP_ARENA, MAP_COMPLEX } from '../src/world/world.js';
import { buildComplex, doorwayCenter } from '../src/world/complex.js';
import { GameSim } from '../src/sim/gamesim.js';
import { MODE } from '../src/net/protocol.js';
import {
  LOADOUTS, DEFAULT_LOADOUT, loadoutById, loadoutWeapons, validateLoadouts,
} from '../src/combat/loadouts.js';
import { WeaponSystem, WEAPONS } from '../src/combat/weapons.js';

const plan = planArena({ x0: 0, z0: 0, groundY: 0 });
/** Mirror an x coordinate about the map's centre line. */
const mx = (x) => ARENA_W - x;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ------------------------------------------------------------------- layout

test('the plan is the shape the rest of the engine consumes', () => {
  assert.ok(plan.rooms.length > 0);
  for (const r of plan.rooms) {
    for (const k of ['id', 'minX', 'maxX', 'minZ', 'maxZ', 'cx', 'cz', 'area',
      'floorY', 'outdoor', 'storeys', 'depth', 'tier', 'label']) {
      assert.ok(k in r, `room ${r.id} is missing ${k}`);
    }
    assert.ok(r.maxX > r.minX && r.maxZ > r.minZ, `room ${r.id} is inside out`);
  }
  for (const l of plan.links) {
    assert.ok(l.axis === 'x' || l.axis === 'z');
    assert.ok(l.hi > l.lo, 'a link spans a range');
    assert.ok(plan.rooms.some((r) => r.id === l.a), 'link a names a real room');
    assert.ok(plan.rooms.some((r) => r.id === l.b), 'link b names a real room');
  }
  assert.ok(plan.rooms.some((r) => r.id === plan.start));
});

test('the buildings stand apart on open ground, and never intersect', () => {
  // The opposite of the tiled floorplan the co-op map uses. If the rooms ever
  // add up to the whole lot again, the outdoor space has become a set of walled
  // cells and the map is a compound rather than two houses on a plot.
  const total = plan.rooms.reduce((s, r) => s + r.area, 0);
  assert.ok(total < ARENA_W * ARENA_D * 0.6,
    `buildings cover ${total} of ${ARENA_W * ARENA_D} -- that is a compound, not a lot`);

  for (let i = 0; i < plan.rooms.length; i++) {
    for (let j = i + 1; j < plan.rooms.length; j++) {
      const a = plan.rooms[i], b = plan.rooms[j];
      const overlap = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX))
        * Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
      assert.equal(overlap, 0, `rooms ${a.label} and ${b.label} overlap`);
    }
  }

  // And every one of them has to be inside the lot.
  for (const r of plan.rooms) {
    assert.ok(r.minX >= plan.bounds.x0 && r.maxX <= plan.bounds.x1, `${r.label} is off the lot`);
    assert.ok(r.minZ >= plan.bounds.z0 && r.maxZ <= plan.bounds.z1, `${r.label} is off the lot`);
  }
});

test('every building is a shell, so it has real outside walls', () => {
  // Without this the houses are built out of thin interior partitions with no
  // windows, because "exterior" otherwise means "on the plan bounds" and none
  // of these are.
  for (const r of plan.rooms) {
    assert.equal(r.shell, true, `${r.label} must be a shell`);
    assert.equal(r.outdoor, false, `${r.label} is a building, not a yard`);
  }
});

test('the map is a mirror image of itself', () => {
  // Every room must have a partner that is its reflection, with the same roof,
  // the same storeys and the same footprint.
  for (const r of plan.rooms) {
    const twin = plan.rooms.find((o) => near(o.minX, mx(r.maxX)) && near(o.maxX, mx(r.minX))
      && near(o.minZ, r.minZ) && near(o.maxZ, r.maxZ));
    assert.ok(twin, `room ${r.label} (${r.minX}..${r.maxX}) has no mirror`);
    assert.equal(twin.outdoor, r.outdoor, `${r.label}: mirror differs in roof`);
    assert.equal(twin.storeys, r.storeys, `${r.label}: mirror differs in storeys`);
  }
});

test('every doorway has a mirrored doorway', () => {
  // Stair clearance may move a door within its shared wall span, so reflect
  // the actual opening centre consumed by buildComplex.
  const mid = (l) => doorwayCenter(l);
  const key = (l) => (l.axis === 'x'
    ? `x@${mx(l.at).toFixed(3)}:${mid(l).toFixed(3)}`
    : `z@${l.at.toFixed(3)}:${mx(mid(l)).toFixed(3)}`);
  const have = new Set(plan.links.map((l) => (l.axis === 'x'
    ? `x@${l.at.toFixed(3)}:${mid(l).toFixed(3)}`
    : `z@${l.at.toFixed(3)}:${mid(l).toFixed(3)}`)));
  for (const l of plan.links) {
    assert.ok(have.has(key(l)),
      `doorway ${l.axis}@${l.at} mid ${mid(l)} has no mirror`);
  }
});

test('nothing on the versus map is bought', () => {
  for (const l of plan.links) assert.equal(l.price, 0, 'a versus doorway is free');
  for (const r of plan.rooms) {
    assert.equal(r.open, true, `${r.label} should start open`);
    assert.equal(r.role.weapons, 0, `${r.label} should hand out no weapons`);
  }
  // And the props that come out of it contain no doors to buy.
  const props = buildComplex(plan, []);
  assert.equal(props.filter((p) => p.type === 'door').length, 0);
});

test('both sides get the same number of spawn points, mirrored', () => {
  assert.ok(plan.spawns.length >= 4, 'a single spawn per side is campable');
  const west = plan.spawns.filter((s) => s.side === 0);
  const east = plan.spawns.filter((s) => s.side === 1);
  assert.equal(west.length, east.length);
  for (const s of west) {
    assert.ok(east.some((o) => near(o.x, mx(s.x)) && near(o.z, s.z)),
      `spawn at ${s.x},${s.z} has no mirror`);
  }
});

test('spawns are spread between the buildings and the ground behind them', () => {
  const mid = (plan.bounds.x0 + plan.bounds.x1) / 2;
  let inside = 0;
  for (const s of plan.spawns) {
    const room = plan.rooms.find((r) => s.x >= r.minX && s.x <= r.maxX
      && s.z >= r.minZ && s.z <= r.maxZ);
    if (room) inside += 1;
    // Nobody spawns in the middle: it is the one place both players are
    // already looking at.
    assert.ok(Math.abs(s.x - mid) > 10, `spawn at ${s.x} is out in the turnaround`);
  }
  assert.ok(inside > 0, 'some spawns should be indoors');
  assert.ok(inside < plan.spawns.length,
    'all spawns indoors means losing the house means respawning back in it');
});

test('no house is a one-door box', () => {
  // Openings per building, counting a door onto open ground (a link whose two
  // ends are the same room) as well as the internal one to its wing.
  const doors = new Map(plan.rooms.map((r) => [r.id, 0]));
  for (const l of plan.links) {
    doors.set(l.a, doors.get(l.a) + 1);
    if (l.b !== l.a) doors.set(l.b, doors.get(l.b) + 1);
  }
  for (const r of plan.rooms) {
    assert.ok(doors.get(r.id) >= 2,
      `${r.label} has ${doors.get(r.id)} way(s) in -- that is a room you can hold alone`);
  }
});

test('the house and its wing are joined, and the wings face outward', () => {
  const house = plan.rooms.find((r) => r.label === 'WEST HOUSE');
  const wing = plan.rooms.find((r) => r.label === 'WEST WING');
  assert.ok(house && wing);
  const joined = plan.links.some((l) => (l.a === house.id && l.b === wing.id)
    || (l.a === wing.id && l.b === house.id));
  assert.ok(joined, 'the wing must be reachable from the house');

  // The wing hangs off the side away from the middle. Facing it inward would
  // give one player a covered approach to the turnaround.
  const mid = (plan.bounds.x0 + plan.bounds.x1) / 2;
  assert.ok(Math.abs(wing.cx - mid) > Math.abs(house.cx - mid),
    'the wing should sit further from the middle than the house it hangs off');
});

test('the lot is walled, and the cover cannot be climbed over it', () => {
  assert.ok(plan.fence, 'an open lot with no edge is a map you can walk out of');
  assert.ok(plan.fence.height > 3.5, 'a low wall is a wall you get over');
  for (const c of plan.cover) {
    const half = 6.1 / 2;   // a 20ft box, longest side
    const gap = Math.min(
      c.x - half - plan.fence.minX, plan.fence.maxX - half - c.x,
      c.z - half - plan.fence.minZ, plan.fence.maxZ - half - c.z);
    assert.ok(gap > 6, `cover at ${c.x},${c.z} is ${gap.toFixed(1)}m from the wall -- a ladder out`);
    assert.ok(near(c.x, mx(c.x)), 'cover must sit on the mirror line');
  }
});

test('the arena emits its authored cover as real geometry', () => {
  const w = new World(4242, { map: MAP_ARENA });
  for (const _ of w.generate()) { /* drain */ }
  const containers = w.props.filter((p) => p.type === 'container');
  assert.equal(containers.length, plan.cover.length);
  for (const c of containers) {
    assert.ok(c.collider, 'cover must actually stop a bullet and a body');
    assert.ok(c.collider.maxY > c.collider.minY);
  }
});

// -------------------------------------------------------------------- world

test('the arena world builds, and is the map that was asked for', () => {
  const w = new World(4242, { map: MAP_ARENA });
  for (const _ of w.generate()) { /* drain */ }
  assert.equal(w.mapId, MAP_ARENA);
  assert.ok(w.props.length > 0, 'the arena emits geometry');
  assert.ok(w.spawns?.length > 0, 'the arena exposes spawn points');
  // Spawn heights come off the slab, not the terrain, or a player starts the
  // match embedded in their own floor.
  for (const s of w.spawns) {
    assert.ok(Number.isFinite(s.y), 'spawn has a height');
    assert.ok(s.y >= w.heightAt(s.x, s.z) - 1e-6, 'spawn sits on or above grade');
  }
});

test('the versus shell cannot be torn open', () => {
  const w = new World(4242, { map: MAP_ARENA });
  for (const _ of w.generate()) { /* drain */ }
  // The boards are still there, filling the window openings...
  const boards = w.props.filter((p) => p.type === 'window');
  assert.ok(boards.length > 0, 'windows are still boarded');
  // ...but nothing can work them loose, which on a map with no zombies would
  // only ever be a player cutting themselves an exit from the arena.
  assert.deepEqual(w.barriers, [], 'a versus map registers no breakable barrier');

  // And the co-op map must still have them, or this fix broke the horde loop.
  const coop = new World(4242);
  for (const _ of coop.generate()) { /* drain */ }
  assert.ok(coop.barriers.length > 0, 'co-op still boards its windows breakably');
});

test('a generated world is unchanged by the arena existing', () => {
  const w = new World(4242);
  for (const _ of w.generate()) { /* drain */ }
  assert.equal(w.mapId, MAP_COMPLEX);
  assert.equal(w.spawns, null, 'a generated map has no authored spawns');
  assert.ok(w.props.length > 0);
});

test('the arena is identical whatever the seed', () => {
  const shape = (seed) => {
    const w = new World(seed, { map: MAP_ARENA });
    for (const _ of w.generate()) { /* drain */ }
    return w.plan.rooms.map((r) => `${r.label}:${r.minX},${r.minZ},${r.maxX},${r.maxZ}`).join('|');
  };
  assert.equal(shape(1), shape(999999), 'the versus map must not vary by seed');
});

test('a free-for-all sim runs on the arena and co-op does not', () => {
  const ffa = new GameSim(7, { mode: MODE.FFA }).generate();
  assert.equal(ffa.world.mapId, MAP_ARENA);
  const coop = new GameSim(7, { mode: MODE.COOP }).generate();
  assert.equal(coop.world.mapId, MAP_COMPLEX);
});

test('a respawn goes to the end of the map the other player is not at', () => {
  const sim = new GameSim(7, { mode: MODE.FFA }).generate();
  const hunter = sim.addPlayer('a', 'HUNTER');
  const prey = sim.addPlayer('b', 'PREY');

  // Park the hunter on a known spawn anchor and make sure the prey is not put
  // anywhere near it.
  const camped = sim.world.spawns[0];
  hunter.pos.x = camped.x; hunter.pos.y = camped.y; hunter.pos.z = camped.z;
  hunter.alive = true;

  for (let i = 0; i < 8; i++) {
    sim._respawnPlayer(prey);
    const d = Math.hypot(prey.pos.x - camped.x, prey.pos.z - camped.z);
    assert.ok(d > 12, `respawned ${d.toFixed(1)}m from a live opponent`);
  }
});

// ----------------------------------------------------------------- loadouts

test('every loadout names weapons that exist and are not melee', () => {
  assert.deepEqual(validateLoadouts(), []);
});

test('the default loadout is one of the loadouts', () => {
  assert.ok(LOADOUTS.some((l) => l.id === DEFAULT_LOADOUT));
  assert.equal(loadoutById(DEFAULT_LOADOUT).id, DEFAULT_LOADOUT);
});

test('an unknown loadout id falls back rather than throwing', () => {
  assert.equal(loadoutById('no-such-kit').id, LOADOUTS[0].id);
  assert.ok(loadoutWeapons('no-such-kit').length > 0);
});

test('applying a loadout grants exactly that kit, loaded', () => {
  const ws = new WeaponSystem(null);
  const ids = loadoutWeapons('breacher');
  const granted = ws.applyLoadout(ids);
  assert.deepEqual(granted, ids);

  const owned = ws.owned.map((w) => w.def.id).sort();
  assert.deepEqual(owned, [...ids].sort(), 'nothing outside the loadout is owned');
  // Notably the pistol, which every co-op run starts with and this set does not.
  assert.ok(!owned.includes('pistol'));

  for (const w of ws.owned) {
    if (w.def.noAmmo) continue;
    assert.equal(w.ammo, w.magSize, `${w.def.id} spawns with a full magazine`);
    assert.equal(w.reserve, w.def.reserveMax, `${w.def.id} spawns with full reserve`);
  }
});

test('a loadout draws its primary, not whatever sits in the lowest slot', () => {
  const ws = new WeaponSystem(null);
  for (const l of LOADOUTS) {
    ws.applyLoadout(loadoutWeapons(l.id));
    assert.equal(ws.current.def.id, l.primary, `${l.id} should spawn holding its primary`);
  }
});

test('respawning re-applies the kit rather than compounding it', () => {
  const ws = new WeaponSystem(null);
  ws.applyLoadout(loadoutWeapons('overwatch'));
  const sniper = ws.owned.find((w) => w.def.id === 'sniper');
  sniper.ammo = 0;
  sniper.reserve = 0;

  ws.applyLoadout(loadoutWeapons('overwatch'));
  assert.equal(ws.owned.length, 3, 'a second application does not stack weapons');
  assert.equal(ws.owned.find((w) => w.def.id === 'sniper').ammo, sniper.magSize);
});

test('switching loadout between spawns takes the old kit away', () => {
  const ws = new WeaponSystem(null);
  ws.applyLoadout(loadoutWeapons('overwatch'));
  assert.ok(ws.owned.some((w) => w.def.id === 'sniper'));
  ws.applyLoadout(loadoutWeapons('raider'));
  assert.ok(!ws.owned.some((w) => w.def.id === 'sniper'), 'the old primary is gone');
  assert.ok(ws.owned.some((w) => w.def.id === 'smg'));
});

test('every loadout weapon is reachable by its own key', () => {
  const ws = new WeaponSystem(null);
  for (const l of LOADOUTS) {
    ws.applyLoadout(loadoutWeapons(l.id));
    const slots = ws.owned.map((w) => w.slot);
    assert.equal(new Set(slots).size, slots.length, `${l.id}: two weapons share a key`);
    for (const s of slots) assert.ok(s >= 1, `${l.id}: a weapon has no key`);
  }
});

test('the loadouts between them cover every fighting range', () => {
  // Not a style rule: if every set carried the same effective range, the map's
  // three lanes would collapse into one worth walking.
  const ranges = LOADOUTS.map((l) => WEAPONS.find((w) => w.id === l.primary).range);
  assert.ok(Math.max(...ranges) / Math.min(...ranges) >= 3,
    'the primaries are too alike for the lanes to mean anything');
});
