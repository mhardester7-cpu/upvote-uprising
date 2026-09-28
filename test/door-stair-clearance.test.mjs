// Doorways beside stairs must be holes in every gameplay system, not just art.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Player } from '../src/entities/player.js';
import { World } from '../src/world/world.js';
import { buildComplex, doorwayCenter, levelY, stairWell } from '../src/world/complex.js';
import { NavGrid } from '../src/world/navgrid.js';

// These include the original side-on blocked flights, rotated flights, and the
// all-four-faces case that needs a central stair with two guard rails.
const SEEDS = [2, 7, 10, 11, 13, 31, 44, 68, 1853, 20260725];

function generated(seed) {
  const world = new World(seed);
  for (const _ of world.generate()) { /* finish generation */ }
  return world;
}

function stairDoorways(world) {
  return world.plan.links.filter((link) => [link.a, link.b].some((id) => {
    const room = world.plan.rooms.find((candidate) => candidate.id === id);
    return (room?.storeys ?? 1) > 1;
  }));
}

function doorwayFrame(world, link) {
  const mid = doorwayCenter(link);
  return {
    x: link.axis === 'x' ? link.at : mid,
    z: link.axis === 'x' ? mid : link.at,
    nx: link.axis === 'x' ? 1 : 0,
    nz: link.axis === 'z' ? 1 : 0,
    axis: link.axis === 'x' ? 0 : 2,
    floorY: world.plan.rooms[0].floorY,
  };
}

test('stair-adjacent doors pass a walking capsule in both directions', () => {
  let checked = 0;
  for (const seed of SEEDS) {
    const world = generated(seed);
    for (const door of [...world.doors()]) world.openDoor(door);

    for (const link of stairDoorways(world)) {
      const f = doorwayFrame(world, link);

      // The whole crossing volume is clear for the exact player capsule.
      for (let along = -1.25; along <= 1.2501; along += 0.1) {
        assert.equal(world.blocksAt(
          f.x + f.nx * along, f.floorY, f.z + f.nz * along,
          0.32, 1.8, 0.65,
        ), false, `seed ${seed}: capsule blocked at door ${link.a}-${link.b}, offset ${along.toFixed(2)}`);
      }

      // Exercise the player's real per-axis movement contract, both ways.
      for (const direction of [-1, 1]) {
        const player = new Player(world);
        player.spawn({
          x: f.x - f.nx * direction * 1.2,
          y: f.floorY,
          z: f.z - f.nz * direction * 1.2,
        });
        for (let step = 0; step < 52; step++) {
          player._moveHorizontal(f.axis, direction * 0.05);
        }
        const crossed = (player.pos.x - f.x) * f.nx + (player.pos.z - f.z) * f.nz;
        assert.ok(crossed * direction > 1.0,
          `seed ${seed}: player did not cross door ${link.a}-${link.b} from direction ${direction}`);
      }
      checked++;
    }
  }
  assert.ok(checked > 100, `only exercised ${checked} stair-adjacent doorways`);
});

test('stair-adjacent doors pass eye-level shots and navigation', () => {
  let checked = 0;
  for (const seed of SEEDS) {
    const world = generated(seed);
    for (const door of [...world.doors()]) world.openDoor(door);
    const nav = new NavGrid(world);

    for (const link of stairDoorways(world)) {
      const f = doorwayFrame(world, link);
      const shot = world.raycast(
        f.x - f.nx * 1.6, f.floorY + 1.64, f.z - f.nz * 1.6,
        f.nx, 0, f.nz, 3.2,
      );
      assert.equal(shot.hit, false,
        `seed ${seed}: shot through door ${link.a}-${link.b} hit ${shot.prop?.type ?? 'terrain'}`);

      const sides = [-0.9, 0.9].map((along) => ({
        x: f.x + f.nx * along,
        z: f.z + f.nz * along,
      }));
      for (const side of sides) {
        const cell = nav.index(nav.toCellX(side.x), nav.toCellZ(side.z), 0);
        assert.equal(nav.blocked[cell], 0,
          `seed ${seed}: nav closes door ${link.a}-${link.b}`);
      }
      nav.update(sides[0].x, sides[0].z, f.floorY);
      assert.equal(nav.reachable(sides[1].x, sides[1].z, f.floorY), true,
        `seed ${seed}: nav cannot cross door ${link.a}-${link.b}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `only exercised ${checked} stair-adjacent doorways`);
});

test('every stair layout emits finite colliders and guarded central wells', () => {
  let rotated = 0;
  let central = 0;
  for (const seed of SEEDS) {
    const world = generated(seed);
    for (const room of world.plan.rooms.filter((candidate) => candidate.storeys > 1)) {
      if (room.stairCorner >= 4 && room.stairCorner < 8) rotated++;
      if (room.stairCorner >= 8) central++;
    }

    for (const prop of world.props) {
      const collider = prop.collider;
      if (!collider) continue;
      const values = collider.kind === 'box'
        ? [collider.minX, collider.minY, collider.minZ, collider.maxX, collider.maxY, collider.maxZ]
        : [collider.x, collider.z, collider.r, collider.y0, collider.y1];
      assert.ok(values.every(Number.isFinite),
        `seed ${seed}: ${prop.type} emitted a non-finite collider`);
    }
  }
  // The larger district no longer needs the same fallback corners for these
  // seeds. Exercise all layouts explicitly instead of relying on random size.
  for (let corner = 0; corner < 10; corner++) {
    const r={id:0,minX:0,minZ:0,maxX:24,maxZ:24,cx:12,cz:12,
      floorY:0,storeys:2,outdoor:false,stairCorner:corner};
    const pieces=buildComplex({rooms:[r],links:[],bounds:{x0:0,z0:0,x1:24,z1:24}});
    for(const p of pieces){const c=p.collider;
      assert.ok([c.minX,c.minY,c.minZ,c.maxX,c.maxY,c.maxZ].every(Number.isFinite));}
    if(corner>=4&&corner<8)rotated++;
    if(corner>=8)central++;
  }
  assert.ok(rotated >= 4);
  assert.ok(central >= 2);

  // Force the symmetric central-X variant too. It is a rare fallback, but its
  // two rail coordinates must never be mistaken for the single open-side field
  // used by a wall-backed flight (which would emit NaN collider bounds).
  const room = {
    id: 0, minX: 0, minZ: 0, maxX: 18, maxZ: 18,
    cx: 9, cz: 9, floorY: 0, storeys: 2, outdoor: false,
    stairCorner: 9,
  };
  const props = buildComplex({
    rooms: [room], links: [],
    bounds: { x0: 0, z0: 0, x1: 18, z1: 18 },
  });
  const rails = props.filter((prop) => prop.storey === 1 && prop.material === 'parapet');
  assert.equal(rails.length, 2, 'central-X stair should guard both open sides');
  for (const prop of props) {
    const c = prop.collider;
    assert.ok([c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ].every(Number.isFinite),
      `${prop.type} emitted a non-finite central-X collider`);
  }
});

test('reoriented and central stair flights remain walkable', () => {
  const input = { moveAxis: null, actionDown: (key) => key === 'forward' };
  let checked = 0;
  for (const seed of SEEDS) {
    const world = generated(seed);
    for (const room of world.plan.rooms.filter((candidate) => candidate.storeys > 1)) {
      for (let storey = 1; storey < room.storeys; storey++) {
        const well = stairWell(room, storey);
        const base = levelY(room, storey - 1);
        const alongX = well.axis === 'x';
        const player = new Player(world);
        player.spawn({
          x: alongX
            ? (well.dir > 0 ? well.minX + 0.25 : well.maxX - 0.25)
            : (well.minX + well.maxX) / 2,
          y: base + 0.4,
          z: alongX
            ? (well.minZ + well.maxZ) / 2
            : (well.dir > 0 ? well.minZ + 0.25 : well.maxZ - 0.25),
        });
        player.yaw = alongX
          ? (well.dir > 0 ? -Math.PI / 2 : Math.PI / 2)
          : (well.dir > 0 ? Math.PI : 0);
        for (let frame = 0; frame < 240; frame++) player.update(1 / 60, input);
        assert.ok(player.pos.y >= levelY(room, storey) - 0.05,
          `seed ${seed}: room ${room.id} flight ${storey} cannot be climbed`);
        checked++;
      }
    }
  }
  assert.ok(checked > 50, `only climbed ${checked} stair flights`);
});
