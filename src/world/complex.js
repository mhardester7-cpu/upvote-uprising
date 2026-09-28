// The complex: one connected facility, generated as a floorplan.
//
// This replaces "some buildings standing in a field". The map *is* the
// structure -- rooms sharing walls, joined by doors you open -- and the
// outdoor spaces are courtyards carved into it rather than the terrain it sits
// on. That is how a Zombies map is laid out, and the reasons are mechanical
// rather than aesthetic:
//
//   A small start room with two exits makes the first route a decision.
//   One exit is no choice; four is no pressure.
//
//   The graph must contain LOOPS. This is the single most important property
//   and the easiest to get wrong: a horde is survived by running it in a
//   circuit, so a floorplan that is a tree is a floorplan of dead ends, and a
//   dead end is where a run ends. The spanning tree decides what you must buy;
//   the extra edges added afterwards are what make the place playable.
//
//   Rooms are small. 7-14m across with a 3m ceiling, corridors narrower still.
//   A 25m hall has no corners to break line of sight, and cover is what makes
//   a fight readable.
//
// Layout comes from binary subdivision, because splitting a rectangle is what
// naturally produces rooms that share whole walls -- and a shared wall is what
// a doorway can be punched through. Scattering rectangles and hoping they touch
// does not give you a floorplan, it gives you a warehouse district.

import { rand2 } from './noise.js';

export const PROP_DOOR = 'door';
export const PROP_SLAB = 'slab';
export const PROP_WALLSEG = 'wallseg';
export const PROP_STAIR = 'stair';
export const PROP_FURNITURE = 'furniture';
export const PROP_WINDOW = 'window';

/**
 * Storey height, and the pieces that must add up to it.
 *
 * A slab hangs below each walking surface, so the headroom in a room is
 * FLOOR_H minus SLAB_T -- 3.9m here. That is the number that matters, and it
 * is set by the largest thing that has to fight in the room rather than by the
 * player: an abomination is 2.7m tall and has to be able to rear and swing
 * under a ceiling, not scrape it. Raising the walls without raising this is
 * what leaves the rooms feeling like corridors with tall wallpaper.
 */
export const FLOOR_H = 4.2;
const SLAB_T = 0.3;
/** How far a floor slab stands proud of the levelled ground beneath it. */
const SLAB_LIFT = 0.06;
/** Exterior is thicker than interior, and both are thicker than the player. */
const WALL_EXT = 0.6;
const WALL_INT = 0.4;
/**
 * Door opening.
 *
 * Sized off the largest thing that has to walk through it rather than off the
 * player. An abomination that cannot fit through a doorway is a boss fought in
 * a car park, so the opening is set first and the biggest enemy is sized to
 * clear it -- 2.8 wide leaves room either side of a 1.3m body, and 2.9 high
 * clears a 2.7m one under a 3.1m ceiling.
 */
const DOOR_W = 2.8;
const DOOR_H = 3.2;
/** Window band on an exterior wall: sill height and head height. */
const SILL = 1.05;
const HEAD = 2.35;
/**
 * Upper-storey window band.
 *
 * Deliberately too short to climb through: a body is 1.8m tall, so an opening
 * 0.9m high can never have its feet above the sill and its head below the
 * head course at the same time. That is what lets an upper floor have daylight
 * and sightlines without becoming a way in or a way out -- the boarded ground
 * floor windows stay the only breach, which is where the whole barrier
 * mechanic lives.
 */
const UPPER_SILL = 1.5;
const UPPER_HEAD = 2.4;
const STEP_RISE = 0.42;
/**
 * How far a wall runs past the ceiling it meets.
 *
 * A wall that stops exactly at the slab leaves a ledge the width of the slab,
 * and a ledge is somewhere to stand. Running it up through the slab means the
 * top of every wall is buried in the floor above.
 */
const WALL_CAP = SLAB_T;
/**
 * A courtyard has no ceiling to bury its walls in, so it gets a parapet
 * instead. Without one, a yard is a room you can leave by climbing out of --
 * and a map with a way out that is not a door is a map with no doors.
 */
const PARAPET = 1.6;

/** Smallest room the subdivision will produce. */
const MIN_ROOM = 11;

/** Reward tiers still rise with depth even though traversal is free. */
const MAX_TIER = 5;

/** The first-room spaceport airlock is part of traversal, not a progression toll. */
export const SPACEPORT_PRICE = 0;
// Kept as a compatibility name for older callers that still call it the exit.
export const ESCAPE_PRICE = SPACEPORT_PRICE;

/**
 * Zone id for the ground outside the shell.
 *
 * Negative because room ids are array indices, so a negative id can never
 * collide with one however the floorplan is generated.
 */
export const OUTSIDE_ZONE = -1;

/**
 * How far out the perimeter zone reaches from the wall.
 *
 * This is the rectangle the game spawns and stocks in, not a fence -- there is
 * nothing stopping the player walking further. Twelve metres because that is
 * how far the navigation grid already extended past the plan for zombies
 * approaching a window, so the ground the player is most likely to fight on is
 * ground the flow field has always covered.
 */
const OUTSIDE_DEPTH = 12;
/**
 * What a room is for.
 *
 * Every room has a job and the prompt names it. "Open the armoury" gives the
 * player a useful destination; "open the area" says nothing. Roles are
 * assigned by depth so the useful ones are spread across the map rather than
 * clustered where you start.
 */
export const ROLES = [
  { id: 'stores', name: 'STORES', chests: 2, weapons: 1 },
  { id: 'armoury', name: 'ARMOURY', chests: 1, weapons: 2 },
  { id: 'workshop', name: 'WORKSHOP', chests: 1, weapons: 1 },
  { id: 'yard', name: 'LOADING YARD', chests: 2, weapons: 1 },
  { id: 'labs', name: 'LABS', chests: 1, weapons: 2 },
  { id: 'vault', name: 'VAULT', chests: 3, weapons: 2 },
];

/** The authored room and prop use the same stable id across world/render code. */
export const DINOSAUR_FACTORY_ROLE = 'dinosaur_factory';
export const REVERSE_AQUARIUM_ROLE = 'reverse_aquarium';

export const TIER_WEAPONS = [
  ['pistol'],
  ['smg', 'microsmg', 'shotgun'],
  ['rifle', 'deagle', 'knife'],
  ['sniper', 'laser'],
  ['bazooka', 'minigun'],
  ['railgun', 'golfclub'],
];

// --------------------------------------------------------------- subdivision

/**
 * Split a rectangle into rooms.
 *
 * Splits the long axis, so rooms stay roughly square rather than degenerating
 * into corridors -- except where a deliberate corridor is wanted, which the
 * caller gets by allowing one very uneven split.
 */
function subdivide(rect, depth, rand, out) {
  const w = rect.maxX - rect.minX;
  const d = rect.maxZ - rect.minZ;

  const canX = w >= MIN_ROOM * 2;
  const canZ = d >= MIN_ROOM * 2;
  if (depth <= 0 || (!canX && !canZ)) { out.push(rect); return; }

  const splitX = canX && canZ ? w >= d : canX;
  const span = splitX ? w : d;
  // Bias toward the middle but never past the minimum, so no room is a slot.
  const t = 0.36 + rand() * 0.28;
  const cut = (splitX ? rect.minX : rect.minZ) + Math.max(MIN_ROOM, Math.min(span - MIN_ROOM, span * t));

  const a = splitX
    ? { minX: rect.minX, minZ: rect.minZ, maxX: cut, maxZ: rect.maxZ }
    : { minX: rect.minX, minZ: rect.minZ, maxX: rect.maxX, maxZ: cut };
  const b = splitX
    ? { minX: cut, minZ: rect.minZ, maxX: rect.maxX, maxZ: rect.maxZ }
    : { minX: rect.minX, minZ: cut, maxX: rect.maxX, maxZ: rect.maxZ };

  subdivide(a, depth - 1, rand, out);
  subdivide(b, depth - 1, rand, out);
}

/** Shared edge between two rooms, or null if they only touch at a corner. */
function sharedEdge(a, b) {
  const eps = 0.01;
  // Vertical wall: a's right face against b's left, or the reverse.
  for (const [p, q] of [[a, b], [b, a]]) {
    if (Math.abs(p.maxX - q.minX) < eps) {
      const lo = Math.max(p.minZ, q.minZ), hi = Math.min(p.maxZ, q.maxZ);
      if (hi - lo > DOOR_W + 1.2) return { axis: 'x', at: p.maxX, lo, hi };
    }
    if (Math.abs(p.maxZ - q.minZ) < eps) {
      const lo = Math.max(p.minX, q.minX), hi = Math.min(p.maxX, q.maxX);
      if (hi - lo > DOOR_W + 1.2) return { axis: 'z', at: p.maxZ, lo, hi };
    }
  }
  return null;
}

// ------------------------------------------------------------------- layout

/**
 * Plan the whole facility.
 *
 * @returns { rooms, links, start } where a link with `barrier` has a free door
 */
export function planComplex({ x0, z0, w, d, seed, groundY }) {
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };

  const leaves = [];
  // Four splits: sixteen rooms at most. Deeper turns a floorplan into a
  // rabbit warren, and a map you cannot hold a mental picture of is one you
  // cannot run a horde around.
  subdivide({ minX: x0, minZ: z0, maxX: x0 + w, maxZ: z0 + d }, 4, rand, leaves);

  const rooms = leaves.map((r, i) => ({
    id: i, ...r,
    cx: (r.minX + r.maxX) / 2, cz: (r.minZ + r.maxZ) / 2,
    area: (r.maxX - r.minX) * (r.maxZ - r.minZ),
    floorY: groundY,
    outdoor: false,
    storeys: 1,
    depth: -1, tier: 0,
  }));

  // ---- adjacency -------------------------------------------------------
  const edges = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const e = sharedEdge(rooms[i], rooms[j]);
      if (e) edges.push({ a: i, b: j, ...e });
    }
  }

  const bounds = { x0, z0, x1: x0 + w, z1: z0 + d };

  // ---- the start room --------------------------------------------------
  // A compact room on the shell. It still wants two interior routes so the
  // opening decision remains interesting, but it now also owns the dedicated
  // airlock that puts interplanetary travel within the player's first room.
  const mx = x0 + w / 2, mz = z0 + d / 2;
  let start = 0, bestScore = Infinity;
  for (const r of rooms) {
    const degree = edges.filter((e) => e.a === r.id || e.b === r.id).length;
    const takesAirlock = roomSides(r, { bounds }).some((side) =>
      side.exterior && side.hi - side.lo >= DOOR_W + 1.2);
    if (!takesAirlock) continue;
    const score = r.area
      + Math.hypot(r.cx - mx, r.cz - mz) * 0.5
      + (degree < 2 ? 500 : 0)
      + Math.max(0, degree - 2) * 140;
    if (score < bestScore) { bestScore = score; start = r.id; }
  }

  // ---- depth from the start -------------------------------------------
  const adj = rooms.map(() => []);
  for (const e of edges) { adj[e.a].push(e); adj[e.b].push(e); }

  rooms[start].depth = 0;
  const queue = [start];
  while (queue.length) {
    const id = queue.shift();
    for (const e of adj[id]) {
      const other = e.a === id ? e.b : e.a;
      if (rooms[other].depth >= 0) continue;
      rooms[other].depth = rooms[id].depth + 1;
      queue.push(other);
    }
  }
  for (const r of rooms) {
    if (r.depth < 0) r.depth = 0;         // unreachable island; treat as start-tier
    r.tier = Math.min(MAX_TIER, r.depth);
    if (r.depth === 0) {
      r.role = { id: 'start', name: 'THE ROOM YOU WOKE IN', chests: 0, weapons: 0 };
    } else {
      // Deeper rooms draw from later roles, so exploration still improves the
      // reward pool even though opening the route costs nothing.
      const pick = Math.min(ROLES.length - 1, r.depth - 1 + (r.id % 2));
      r.role = ROLES[pick];
    }
    r.label = r.role.name;
  }

  // ---- which edges are barriers ---------------------------------------
  //
  // Every edge that first reaches a deeper room gets a physical, free door.
  // The rest are left as open passages, and those open edges are the loops --
  // the circuits you run a horde around once the area is unlocked.
  const links = [];
  const reached = new Set([start]);
  const sortedByDepth = [...rooms].sort((a, b) => a.depth - b.depth);
  const isBarrier = new Set();

  for (const r of sortedByDepth) {
    if (r.id === start) continue;
    // Cheapest way in: from an already-reached, shallower neighbour.
    let via = null;
    for (const e of adj[r.id]) {
      const other = e.a === r.id ? e.b : e.a;
      if (rooms[other].depth < r.depth && reached.has(other)) { via = e; break; }
    }
    if (!via) via = adj[r.id][0];
    if (via) { isBarrier.add(via); reached.add(r.id); }
  }

  for (const e of edges) {
    const deeper = rooms[e.a].depth > rooms[e.b].depth ? rooms[e.a] : rooms[e.b];
    links.push({
      a: e.a, b: e.b, axis: e.axis, at: e.at, lo: e.lo, hi: e.hi,
      // `barrier` controls geometry; price no longer does. Keeping those ideas
      // separate preserves the route-defining shutters while making every one
      // of them free to open.
      barrier: isBarrier.has(e),
      price: 0,
      zone: deeper.id,
    });
  }

  // The factory is the first landmark on the authored progression route: the
  // room immediately beyond the start room, i.e. room #2 in play order. A
  // deep branch made the feature technically present but functionally hidden
  // across the map. Prefer the widest depth-one room so the incubator and its
  // hatch lane still have generous clearance, with id as a deterministic tie.
  const firstUnlocks = rooms.filter((r) => r.depth === 1
    && adj[r.id]?.some((edge) => (edge.a === r.id ? edge.b : edge.a) === start));
  const factoryRoom = firstUnlocks
    .sort((a, b) => b.area - a.area || a.id - b.id)[0] ?? null;

  // ---- courtyards ------------------------------------------------------
  //
  // Open-air rooms cut into the plan, not ground the plan sits on. Walking out
  // of a corridor into daylight and still being inside the complex is the
  // indoor/outdoor weave; a building dropped in a field is not.
  for (const r of rooms) {
    if (r.id === start) continue;
    if (r.id === factoryRoom?.id) continue;
    if (r.depth === 0) continue;
    // Bigger rooms make better yards, and roughly a third of the map should be
    // open or the whole thing reads as corridors.
    if (r.area > 90 && rand() < 0.45) r.outdoor = true;
  }

  // Open-air rooms take open-air names. An "armoury" with no roof reads as a
  // mistake, and the prompt is the only thing telling the player what they are
  // paying for.
  const YARD_NAMES = ['LOADING YARD', 'MOTOR POOL', 'COURTYARD', 'SCRAP YARD'];
  for (const r of rooms) {
    if (!r.outdoor) continue;
    r.role = {
      ...r.role,
      id: 'yard',
      name: YARD_NAMES[r.id % YARD_NAMES.length],
    };
    r.label = r.role.name;
  }

  if (factoryRoom) {
    factoryRoom.role = {
      id: DINOSAUR_FACTORY_ROLE,
      name: 'DINOSAUR FACTORY',
      chests: 1,
      weapons: 1,
    };
    factoryRoom.label = factoryRoom.role.name;
  }

  // ---- reverse aquarium ------------------------------------------------
  //
  // The first unlock already belongs to the dinosaur factory, and spawn is
  // intentionally a clean teaching room. Put the second authored landmark in
  // the nearest deeper indoor room instead: close enough that most runs find
  // it, far enough that walking into HUMAN OBSERVATION is a reveal.
  //
  // This room is also a refuge. Select a room/link pair that can lose every
  // other opening without disconnecting the rest of the facility, then replace
  // those openings with ordinary walls. That gives the enclosure exactly one
  // entrance, whose free shutter can be closed again behind the player.
  const aquariumPool = rooms.filter((r) => r.id !== start
    && r.id !== factoryRoom?.id && !r.outdoor);
  const aquariumCandidates = (aquariumPool.filter((r) => r.depth >= 2).length
    ? aquariumPool.filter((r) => r.depth >= 2)
    : aquariumPool)
    .sort((a, b) => a.depth - b.depth || b.area - a.area || a.id - b.id);

  const remainsConnected = (room, keep) => {
    const kept = links.filter((link) =>
      (link.a !== room.id && link.b !== room.id) || link === keep);
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const at = queue.shift();
      for (const link of kept) {
        const next = link.a === at ? link.b : link.b === at ? link.a : null;
        if (next != null && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return seen.size === rooms.length;
  };

  let aquariumRoom = null;
  let aquariumEntry = null;
  for (const room of aquariumCandidates) {
    const entries = links.filter((link) => link.a === room.id || link.b === room.id)
      .sort((a, b) => {
        const ar = rooms[a.a === room.id ? a.b : a.a];
        const br = rooms[b.a === room.id ? b.b : b.a];
        return ar.depth - br.depth || a.price - b.price;
      });
    const entry = entries.find((link) => remainsConnected(room, link));
    if (entry) { aquariumRoom = room; aquariumEntry = entry; break; }
  }

  if (aquariumRoom && aquariumEntry) {
    for (let i = links.length - 1; i >= 0; i--) {
      const link = links[i];
      if ((link.a === aquariumRoom.id || link.b === aquariumRoom.id)
        && link !== aquariumEntry) links.splice(i, 1);
    }
    Object.assign(aquariumEntry, {
      barrier: true,
      price: 0,
      zone: aquariumRoom.id,
      reclosable: true,
      aquarium: true,
    });
    aquariumRoom.role = {
      id: REVERSE_AQUARIUM_ROLE,
      name: 'HUMAN OBSERVATION',
      chests: 1,
      weapons: 1,
    };
    aquariumRoom.label = aquariumRoom.role.name;
  }

  // ---- upper storey ----------------------------------------------------
  // One deep indoor room gets a second floor, so the map has somewhere to look
  // down from.
  const indoor = rooms.filter((r) => !r.outdoor).sort((a, b) => b.area - a.area);
  for (const r of indoor) {
    // Anything with room for a stairwell gets one. A facility that is one
    // storey everywhere is a floorplan; the point of a second is that a fight
    // can move vertically and you can look down on where you just were.
    //
    // "Room for a stairwell" is literal: every storey above the ground needs
    // its own well at its own corner (see stairWell), so a third storey costs a
    // second well and the room has to be wide enough for both.
    if (r.area > 120 && fitsWell(r)) r.storeys = 2;
  }
  if (indoor[0] && fitsWell(indoor[0], 2)) indoor[0].storeys = 3;

  // ---- the way out -----------------------------------------------------
  //
  // The spaceport airlock belongs to the room where a run begins. It remains a
  // real shutter in the exterior shell, so opening it is visible and collision
  // correct, but it no longer asks the player to clear the whole complex first.
  const way = chooseSpaceport(rooms, start, bounds);
  let outside = null;

  if (way) {
    const { room, side } = way;
    links.push({
      a: room.id, b: OUTSIDE_ZONE, escape: true,
      // The door hangs in the shell of `room`, but it opens the perimeter. Both
      // have to be recorded: the geometry is placed off the room's floor, and
      // the price is charged against the zone it unlocks.
      room: room.id, zone: OUTSIDE_ZONE,
      axis: side.axis, at: side.at, lo: side.lo, hi: side.hi,
      barrier: true,
      price: SPACEPORT_PRICE,
    });
    outside = perimeterZone(side, room);
  }

  // Stairs are solid cover. Place their first flight only after every interior
  // and exterior doorway is known, so no tread occupies an opening approach.
  assignStairCorners(rooms, links);

  return {
    rooms, links, start, outside, bounds,
    dinosaurFactoryRoom: factoryRoom?.id ?? null,
    reverseAquariumRoom: aquariumRoom?.id ?? null,
  };
}

/**
 * The starting room's exterior wall, chosen deterministically for co-op.
 */
function chooseSpaceport(rooms, start, bounds) {
  const room = rooms.find((r) => r.id === start);
  if (!room) return null;
  for (const side of roomSides(room, { bounds })) {
    if (!side.exterior || side.hi - side.lo < DOOR_W + 1.2) continue;
    return { room, side };
  }
  return null;
}

/**
 * The ground immediately outside the escape door, as a zone.
 *
 * A zone rather than a room: there is no slab out here, no roof and no walls,
 * and nothing should try to build any. What the rest of the game wants from a
 * zone is somewhere to spawn bodies and somewhere to put the reward, and a
 * rectangle of open ground answers both. Leaving `floorY` unset is what makes
 * everything placed here sample the terrain instead of a floor.
 */
function perimeterZone(side, room) {
  const out = side.outward;
  const lo = side.axis === 'x'
    ? { minX: out > 0 ? side.at : side.at - OUTSIDE_DEPTH, minZ: side.lo }
    : { minX: side.lo, minZ: out > 0 ? side.at : side.at - OUTSIDE_DEPTH };
  const hi = side.axis === 'x'
    ? { maxX: out > 0 ? side.at + OUTSIDE_DEPTH : side.at, maxZ: side.hi }
    : { maxX: side.hi, maxZ: out > 0 ? side.at + OUTSIDE_DEPTH : side.at };

  const rect = { ...lo, ...hi };
  return {
    id: OUTSIDE_ZONE,
    ...rect,
    cx: (rect.minX + rect.maxX) / 2,
    cz: (rect.minZ + rect.maxZ) / 2,
    area: (rect.maxX - rect.minX) * (rect.maxZ - rect.minZ),
    depth: room.depth + 1,
    // The perimeter is the farthest destination, so it uses the best reward
    // pool even though its airlock is free.
    tier: MAX_TIER,
    outdoor: true,
    storeys: 1,
    role: { id: 'spaceport', name: 'SPACEPORT BERTH', chests: 1, weapons: 1 },
    label: 'SPACEPORT BERTH',
  };
}

// ------------------------------------------------------------------ build

const push = (out, type, f) => out.push({ type, rot: 0, scale: 1, height: f.sy ?? 1, ...f });
const box = (minX, minY, minZ, maxX, maxY, maxZ) =>
  ({ kind: 'box', minX, minY, minZ, maxX, maxY, maxZ });

/**
 * Turn a plan into props.
 *
 * Walls are emitted per room edge and deduplicated by the caller-visible fact
 * that interior walls are shared: each wall is owned by the room on its low
 * side, so a shared wall is built once rather than twice in the same place.
 */
export function buildComplex(plan, out = []) {
  const { rooms, links } = plan;

  // Openings, indexed by the wall they punch through, so wall building can
  // leave gaps for them.
  const openings = new Map();
  const key = (axis, at) => `${axis}:${at.toFixed(3)}`;
  for (const l of links) {
    const mid = doorwayCenter(l);
    const k = key(l.axis, l.at);
    if (!openings.has(k)) openings.set(k, []);
    openings.get(k).push({ lo: mid - DOOR_W / 2, hi: mid + DOOR_W / 2, link: l });
  }

  for (const r of rooms) {
    const top = roofY(r);

    // ---- floor -------------------------------------------------------
    //
    // Every room gets a slab, indoors and out: a courtyard is still paved.
    //
    // floorY is the walking surface, so the slab hangs below it and its top
    // face IS the floor. The terrain underneath is set SLAB_LIFT lower, which
    // is what keeps the two from being coplanar -- two surfaces at exactly the
    // same height are a depth-buffer tie, and that was the floor flashing.
    //
    // Getting this the other way round -- floorY at grade, slab top above it --
    // put anything standing at floorY *inside* the slab, and the push-out
    // resolver then shoved it sideways off the slab and out of the room.
    push(out, PROP_SLAB, {
      x: r.cx, y: r.floorY - SLAB_T, z: r.cz,
      sx: r.maxX - r.minX, sy: SLAB_T, sz: r.maxZ - r.minZ,
      material: r.outdoor ? 'apron' : 'slab', room: r.id,
      collider: box(r.minX, r.floorY - SLAB_T, r.minZ, r.maxX, r.floorY, r.maxZ),
    });

    // ---- ceiling / roof ----------------------------------------------
    if (!r.outdoor) {
      push(out, PROP_SLAB, {
        x: r.cx, y: top, z: r.cz,
        sx: r.maxX - r.minX, sy: SLAB_T, sz: r.maxZ - r.minZ,
        material: 'roof', room: r.id,
        collider: box(r.minX, top, r.minZ, r.maxX, top + SLAB_T, r.maxZ),
      });
    }

    // ---- walls -------------------------------------------------------
    for (const side of roomSides(r, plan)) {
      const thick = side.exterior ? WALL_EXT : WALL_INT;
      const holes = (openings.get(key(side.axis, side.at)) ?? [])
        .filter((h) => h.lo >= side.lo - 0.01 && h.hi <= side.hi + 0.01);

      // A courtyard's walls go the full storey like everything else. A 2.6m
      // parapet reads as open sky, but it is also a wall you can crate-jump --
      // and a map you can leave by climbing is not a map with doors in it.
      // Open sky comes from having no ceiling, not from a short wall.
      //
      // How high is decided by both rooms the wall stands between, not just the
      // one building it. A wall built to its own room's ceiling and stopping
      // there leaves a step onto the taller neighbour beside it, and a step is
      // a way up onto the roofs.
      buildWall(out, side, thick, r.floorY, wallTopFor(r, side, plan), holes, r);
    }

    // ---- stairs and the storeys above --------------------------------
    buildStoreys(out, r);
  }

  // ---- the secret cache ----------------------------------------------
  //
  // One interior wall panel, in the deepest room, that is not a wall. It reads
  // as ordinary from across the room and only gives itself away close up, which
  // is the point: a secret you can spot from the doorway is a landmark, not a
  // secret. Opening it costs nothing -- the price was finding it.
  const deepest = rooms.filter((r) => !r.outdoor).sort((a, b) => b.depth - a.depth)[0];
  if (deepest) {
    const panels = out.filter((p) => p.type === PROP_WALLSEG
      && p.room === deepest.id && p.material === 'partition'
      && p.sy > 2.4 && Math.max(p.sx, p.sz) > 2.2);
    const panel = panels[Math.floor(panels.length / 2)] ?? panels[0];
    if (panel) {
      panel.secret = true;
      panel.material = 'secret';
    }
  }

  // ---- the barriers themselves ---------------------------------------
  for (const l of links) {
    // Open passages and physical doors are distinct even though both are free.
    if (!l.barrier && !l.escape && !l.reclosable) continue;
    const mid = doorwayCenter(l);
    // A barrier stands in the room it opens, so its zone names the room it is
    // placed off. The escape door opens ground that is not a room at all, so it
    // carries the room it hangs in separately.
    const room = rooms.find((x) => x.id === (l.room ?? l.zone));
    const y = room ? room.floorY : 0;
    // It has to fill the wall it is set into, and the shell is half again as
    // thick as a partition -- a shutter cut to interior thickness would leave a
    // gap either side of itself that you can see daylight through and shoot a
    // zombie through.
    const t = l.escape ? WALL_EXT : WALL_INT;
    const minX = l.axis === 'x' ? l.at - t / 2 : mid - DOOR_W / 2;
    const maxX = l.axis === 'x' ? l.at + t / 2 : mid + DOOR_W / 2;
    const minZ = l.axis === 'x' ? mid - DOOR_W / 2 : l.at - t / 2;
    const maxZ = l.axis === 'x' ? mid + DOOR_W / 2 : l.at + t / 2;
    push(out, PROP_DOOR, {
      x: (minX + maxX) / 2, y, z: (minZ + maxZ) / 2,
      sx: maxX - minX, sy: DOOR_H, sz: maxZ - minZ,
      material: l.escape ? 'escape' : l.aquarium ? 'aquariumDoor' : 'door',
      zone: l.zone, price: 0, link: l, escape: !!l.escape,
      reclosable: !!l.reclosable, aquarium: !!l.aquarium,
      collider: box(minX, y, minZ, maxX, y + DOOR_H, maxZ),
    });
  }

  return out;
}

// ------------------------------------------------------- levels and wells

/** Top of a room's shell: where its roof or its top slab sits. */
export function roofY(r) { return r.floorY + FLOOR_H * (r.storeys ?? 1); }

/** The walking surface of storey k, counting the ground floor as 0. */
export function levelY(r, k) { return r.floorY + FLOOR_H * k; }

/** Every walking surface in a room, ground floor first. */
export function levelsOf(r) {
  const out = [];
  for (let k = 0; k < (r.storeys ?? 1); k++) out.push(levelY(r, k));
  return out;
}

/**
 * Stairwell size.
 *
 * Wide enough for three bodies abreast, which is the point: a flight a metre
 * and a half across is a queue, and a queue on a staircase is a horde that
 * arrives one at a time no matter how well it is routed. It is also margin
 * against the navigation mask, which inflates solids by a body radius and can
 * round a whole row of cells beside a narrow flight into the staircase itself.
 */
const WELL_W = 4.2;
const WELL_D = 4.6;
/**
 * Landing at the foot of a flight.
 *
 * Without it the well starts flush with the room's edge, which puts the first
 * tread half inside the wall -- and since every tread above the first is too
 * tall to mount from the side, the only way onto the stairs is the sliver of
 * that tread left sticking out. A staircase with a twenty-centimetre entrance
 * is a staircase that reads as broken.
 */
const WELL_FOOT = 0.7;

/**
 * Clear volume immediately inside every ground-floor doorway.
 *
 * A stair flight is made from honest solid tread boxes. If one of those boxes
 * runs past a doorway, it blocks walking, shots and the navigation probe alike
 * -- exactly as it should. The layout therefore keeps the whole flight out of
 * the doorway approach rather than teaching those systems exceptions for it.
 */
const DOOR_APPROACH = 2.2;
const DOOR_BODY_CLEAR = 0.36;
const DOOR_LAYOUT_EPS = 0.05;

/** Actual centre of a doorway along its wall. */
export function doorwayCenter(link) {
  return Number.isFinite(link.doorAt) ? link.doorAt : (link.lo + link.hi) / 2;
}

/** The wall-adjacent positions/orientations, plus two central fallbacks. */
function stairCornerWell(r, corner) {
  if (corner === 8) {
    return {
      minX: r.cx - WELL_W / 2, maxX: r.cx + WELL_W / 2,
      minZ: r.cz - WELL_D / 2, maxZ: r.cz + WELL_D / 2,
      axis: 'z', dir: 1,
      railXs: [r.cx - WELL_W / 2, r.cx + WELL_W / 2],
    };
  }
  if (corner === 9) {
    return {
      minX: r.cx - WELL_D / 2, maxX: r.cx + WELL_D / 2,
      minZ: r.cz - WELL_W / 2, maxZ: r.cz + WELL_W / 2,
      axis: 'x', dir: 1,
      railZs: [r.cz - WELL_W / 2, r.cz + WELL_W / 2],
    };
  }

  const base = corner % 4;
  const nearMinZ = base === 0 || base === 2;
  const nearMaxX = base === 0 || base === 3;

  if (corner >= 4) {
    const minX = nearMaxX ? r.maxX - WELL_FOOT - WELL_D : r.minX + WELL_FOOT;
    const maxX = minX + WELL_D;
    const minZ = nearMinZ ? r.minZ : r.maxZ - WELL_W;
    const maxZ = minZ + WELL_W;
    return {
      minX, maxX, minZ, maxZ,
      axis: 'x', dir: nearMaxX ? -1 : 1,
      openZ: nearMinZ ? maxZ : minZ,
    };
  }

  const minX = nearMaxX ? r.maxX - WELL_W : r.minX;
  const maxX = minX + WELL_W;
  const minZ = nearMinZ ? r.minZ + WELL_FOOT : r.maxZ - WELL_FOOT - WELL_D;
  const maxZ = minZ + WELL_D;
  return {
    minX, maxX, minZ, maxZ,
    axis: 'z', dir: nearMinZ ? 1 : -1,
    // The guard rail belongs on the edge facing the room, not the wall. This
    // cannot be inferred from climb direction now all four corners are legal.
    openX: nearMaxX ? minX : maxX,
  };
}

/**
 * Nearest place to the shared-edge midpoint where this door clears both
 * rooms' stair approaches. Returns null when the current corner assignment
 * leaves no body-width interval at all.
 */
function doorPlacement(link, rooms, corners) {
  const half = DOOR_W / 2 + DOOR_BODY_CLEAR;
  let intervals = [[link.lo + half, link.hi - half]];
  if (intervals[0][1] < intervals[0][0]) return null;

  for (const id of new Set([link.a, link.b])) {
    const room = rooms.find((r) => r.id === id);
    const corner = corners.get(id);
    if (!room || corner === undefined) continue;
    const well = stairCornerWell(room, corner);
    const reachesWall = link.axis === 'x'
      ? well.minX < link.at + DOOR_APPROACH && well.maxX > link.at - DOOR_APPROACH
      : well.minZ < link.at + DOOR_APPROACH && well.maxZ > link.at - DOOR_APPROACH;
    if (!reachesWall) continue;

    const lo = (link.axis === 'x' ? well.minZ : well.minX) - half - DOOR_LAYOUT_EPS;
    const hi = (link.axis === 'x' ? well.maxZ : well.maxX) + half + DOOR_LAYOUT_EPS;
    const next = [];
    for (const [a, b] of intervals) {
      if (hi <= a || lo >= b) {
        next.push([a, b]);
      } else {
        if (lo > a) next.push([a, Math.min(b, lo)]);
        if (hi < b) next.push([Math.max(a, hi), b]);
      }
    }
    intervals = next;
    if (!intervals.length) return null;
  }

  const wanted = (link.lo + link.hi) / 2;
  let best = null;
  for (const [a, b] of intervals) {
    const at = Math.max(a, Math.min(b, wanted));
    const shift = Math.abs(at - wanted);
    if (!best || shift < best.shift) best = { at, shift };
  }
  return best;
}

/** Prefer a valid complete layout, then the smallest total door displacement. */
function stairLayoutScore(rooms, links, corners) {
  let blocked = 0;
  let displacement = 0;
  for (const link of links) {
    const placed = doorPlacement(link, rooms, corners);
    if (!placed) blocked++;
    else displacement += placed.shift * placed.shift;
  }
  return blocked * 1e6 + displacement;
}

/**
 * Pick stair corners as a layout constraint, after all doorways are known.
 *
 * Rooms influence one another across a shared doorway, so choosing each corner
 * in isolation can merely move a blockage into the neighbouring flight. Ten
 * deterministic coordinate-descent starts cover both run axes, all corners,
 * and a central fallback for a room with doors on every face.
 */
export function assignStairCorners(rooms, links) {
  const multi = rooms.filter((r) => (r.storeys ?? 1) > 1);
  if (!multi.length) return;

  let best = null;
  let bestScore = Infinity;
  for (let initial = 0; initial < 10; initial++) {
    const corners = new Map(multi.map((r) => [r.id,
      (r.storeys ?? 1) > 2 && initial >= 8 ? 0 : initial]));
    for (let pass = 0; pass < 8; pass++) {
      let changed = false;
      for (const room of multi) {
        const before = corners.get(room.id);
        let chosen = before;
        let score = Infinity;
        const choices = (room.storeys ?? 1) > 2 ? 8 : 10;
        for (let corner = 0; corner < choices; corner++) {
          corners.set(room.id, corner);
          const candidate = stairLayoutScore(rooms, links, corners);
          if (candidate < score) {
            score = candidate;
            chosen = corner;
          }
        }
        changed ||= before !== chosen;
        corners.set(room.id, chosen);
      }
      if (!changed) break;
    }

    const score = stairLayoutScore(rooms, links, corners);
    if (score < bestScore) {
      bestScore = score;
      best = new Map(corners);
    }
  }

  for (const room of multi) room.stairCorner = best?.get(room.id) ?? 0;
  for (const link of links) {
    const placed = doorPlacement(link, rooms, best ?? new Map());
    link.doorAt = placed?.at ?? (link.lo + link.hi) / 2;
  }
}

/**
 * The stairwell serving storey k, or null if there is no room for it.
 *
 * Each storey gets its OWN well, in a different corner from the one below.
 * Stacking every flight in one shaft looks tidy in plan and is unusable in
 * practice: the flight from the first floor to the second fills the same
 * volume you have to stand in to step off the flight from the ground, so you
 * arrive at the top of one staircase facing the underside of the next. Putting
 * them in opposite corners means each slab has exactly one hole -- the one the
 * flight arriving from below comes through -- and the flight leaving for the
 * storey above starts on solid floor.
 *
 * `axis` and `dir` say which way the flight climbs, so the top tread always
 * lands against the slab rather than over the hole.
 */
export function stairWell(r, k) {
  if (k < 1 || k >= (r.storeys ?? 1)) return null;
  if (!fitsWell(r, k)) return null;
  // Consecutive storeys use opposite corners so one flight cannot fill the
  // landing of the next. The first corner is selected after the room's doors
  // are known; older hand-built room objects retain corner zero.
  const first = Number.isInteger(r.stairCorner) ? r.stairCorner : 0;
  const opposite = [1, 0, 3, 2, 5, 4, 7, 6, 1, 0];
  return stairCornerWell(r, k % 2 === 1 ? first : opposite[first]);
}

/** Is there floor left over once k stairwells are cut out of this room? */
function fitsWell(r, k = 1) {
  const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
  // Two wells sit in opposite corners, so they only fight over the room's
  // width once -- but a floor whose slab is mostly hole is not a floor.
  return w > WELL_W * (k >= 2 ? 2 : 1) + 3.5 && d > WELL_D + WELL_FOOT + 3.5;
}

/** How high a wall on this side has to run to leave no ledge on either face. */
function wallTopFor(r, side, plan) {
  let cap = roofY(r) + (r.outdoor ? PARAPET : WALL_CAP);
  if (side.exterior) return cap;

  // Whoever is on the other side of this wall may have a taller ceiling, and
  // stopping short of it puts a walkable ledge against their wall.
  for (const o of plan.rooms) {
    if (o.id === r.id) continue;
    const touches = side.axis === 'x'
      ? (Math.abs(o.minX - side.at) < 0.01 || Math.abs(o.maxX - side.at) < 0.01)
        && Math.min(o.maxZ, side.hi) - Math.max(o.minZ, side.lo) > 0.1
      : (Math.abs(o.minZ - side.at) < 0.01 || Math.abs(o.maxZ - side.at) < 0.01)
        && Math.min(o.maxX, side.hi) - Math.max(o.minX, side.lo) > 0.1;
    if (!touches) continue;
    cap = Math.max(cap, roofY(o) + (o.outdoor ? PARAPET : WALL_CAP));
  }
  return cap;
}

/** The four sides of a room, flagged for whether they face outside the plan. */
/**
 * Does another room stand against this face?
 *
 * Only asked of `shell` rooms. A tiled plan never needs it -- every face that
 * is not on the bounds has a neighbour by construction -- but a freestanding
 * building has open ground on three sides and a wing joined to the fourth, and
 * only the joined one should be built as a shared partition.
 */
function abuts(r, side, plan) {
  const eps = 0.01;
  for (const o of plan.rooms) {
    if (o === r || o.id === r.id) continue;
    if (side.axis === 'x') {
      if (Math.abs((side.outward > 0 ? o.minX : o.maxX) - side.at) > eps) continue;
      if (Math.min(o.maxZ, side.hi) - Math.max(o.minZ, side.lo) > eps) return true;
    } else {
      if (Math.abs((side.outward > 0 ? o.minZ : o.maxZ) - side.at) > eps) continue;
      if (Math.min(o.maxX, side.hi) - Math.max(o.minX, side.lo) > eps) return true;
    }
  }
  return false;
}

function roomSides(r, plan) {
  const { x0, z0, x1, z1 } = plan.bounds;
  const eps = 0.01;
  const sides = [
    { axis: 'z', at: r.minZ, lo: r.minX, hi: r.maxX, exterior: Math.abs(r.minZ - z0) < eps, outward: -1 },
    { axis: 'z', at: r.maxZ, lo: r.minX, hi: r.maxX, exterior: Math.abs(r.maxZ - z1) < eps, outward: 1 },
    { axis: 'x', at: r.minX, lo: r.minZ, hi: r.maxZ, exterior: Math.abs(r.minX - x0) < eps, outward: -1 },
    { axis: 'x', at: r.maxX, lo: r.minZ, hi: r.maxZ, exterior: Math.abs(r.maxX - x1) < eps, outward: 1 },
  ];
  // A `shell` room is a building standing on open ground rather than a cell in
  // a tiling, so "exterior" cannot mean "on the plan bounds" for it -- by that
  // rule a house in the middle of a lot would be built out of thin interior
  // partitions with no windows in them. Every face with nothing against it is
  // an outside wall. The faces that DO have something against them are left
  // interior so the low-side rule still builds each shared wall exactly once.
  if (r.shell) {
    for (const s of sides) if (!s.exterior) s.exterior = !abuts(r, s, plan);
  }
  return sides;
}

/** One wall run, with gaps left for its doorways and a window band above. */
function buildWall(out, side, thick, y0, y1, holes, room) {
  // Only the room on a wall's low side builds it, or every interior wall is
  // built twice in the same place.
  if (side.outward < 0 && !side.exterior) return;

  const spans = [];
  let cursor = side.lo;
  for (const h of [...holes].sort((a, b) => a.lo - b.lo)) {
    if (h.lo > cursor) spans.push([cursor, h.lo]);
    cursor = Math.max(cursor, h.hi);
  }
  if (cursor < side.hi) spans.push([cursor, side.hi]);

  const material = side.exterior ? 'shell' : 'partition';

  for (const [a0, a1] of spans) {
    // Exterior runs get windows punched through them. Three jobs at once:
    // daylight reaches a perimeter room without a fixture, a blank slab of
    // concrete stops reading as a blank slab of concrete, and a boarded
    // opening is the shape a zombie map is built out of.
    //
    // Storey by storey, because a wall three floors tall with one row of
    // windows at the bottom is exactly what made the upper floors read as
    // unfinished: they were lit by nothing and looked out at nothing.
    if (!side.exterior || a1 - a0 <= 3.4) {
      emitWall(out, side, thick, a0, a1, y0, y1, material, room);
      continue;
    }

    let bandY = y0;
    for (let k = 0; k < (room.storeys ?? 1) && bandY < y1 - 0.05; k++) {
      const bandTop = Math.min(y1, y0 + FLOOR_H * (k + 1));
      if (bandTop - bandY <= HEAD + 0.2) {
        emitWall(out, side, thick, a0, a1, bandY, bandTop, material, room);
      } else if (k === 0) {
        // Ground floor only: a boarded opening a body can come through. Every
        // barrier in the game is one of these, and putting them on an upper
        // storey would mean a zombie tearing its way into a room whose floor it
        // then has to fall through.
        emitWindowedRun(out, side, thick, a0, a1, bandY, bandTop, material, room);
      } else {
        emitClerestory(out, side, thick, a0, a1, bandY, bandTop, material, room);
      }
      bandY = bandTop;
    }
    // The cap above the top storey -- the run buried in the roof slab, or a
    // courtyard's parapet.
    if (bandY < y1 - 0.05) emitWall(out, side, thick, a0, a1, bandY, y1, material, room);
  }
  // Header over each doorway, so an opening reads as a door rather than a
  // missing chunk of wall.
  for (const h of holes) {
    if (y1 > y0 + DOOR_H) {
      emitWall(out, side, thick, h.lo, h.hi, y0 + DOOR_H, y1, material, room);
    }
  }
}

/**
 * An exterior run with a row of boarded windows in it.
 *
 * The opening is a real hole -- light and sightlines pass through -- but the
 * boards across it are solid. That is deliberate on both counts: a hole with
 * nothing in it is a hole the player climbs out of, and glass you cannot see
 * past defeats the point of putting a window there.
 */
function emitWindowedRun(out, side, thick, a0, a1, y0, y1, material, room) {
  const run = a1 - a0;
  const bays = Math.max(1, Math.floor(run / 4.2));
  const bayW = run / bays;
  const winW = Math.min(2.4, bayW * 0.55);
  const pierW = (bayW - winW) / 2;

  // Sill course and header course run the whole length behind the openings.
  emitWall(out, side, thick, a0, a1, y0, y0 + SILL, material, room);
  emitWall(out, side, thick, a0, a1, y0 + HEAD, y1, material, room);

  for (let b = 0; b < bays; b++) {
    const bx = a0 + b * bayW;
    emitWall(out, side, thick, bx, bx + pierW, y0 + SILL, y0 + HEAD, material, room);
    emitWall(out, side, thick, bx + pierW + winW, bx + bayW, y0 + SILL, y0 + HEAD, material, room);

    // Boards across the opening: solid, with gaps you can see and shoot past.
    const w0 = bx + pierW, w1 = w0 + winW;
    const boards = 3;
    const gap = (HEAD - SILL) / boards;
    for (let k = 0; k < boards; k++) {
      const by = y0 + SILL + k * gap + gap * 0.18;
      emitWall(out, side, thick * 0.55, w0, w1, by, by + gap * 0.5, 'board', room, PROP_WINDOW);
    }
  }
}

/**
 * An upper-storey window band: a run of tall openings, unboarded.
 *
 * Left open on purpose. Boards exist to be torn off, and an upper floor is not
 * somewhere anything should be tearing its way into -- so the opening is sized
 * below the height a body needs instead of being blocked by something
 * breakable. You can see out of it, shoot out of it, and be shot through it,
 * and nothing walks through it in either direction.
 */
function emitClerestory(out, side, thick, a0, a1, y0, y1, material, room) {
  const run = a1 - a0;
  const bays = Math.max(1, Math.floor(run / 3.6));
  const bayW = run / bays;
  const winW = Math.min(2.0, bayW * 0.62);
  const pierW = (bayW - winW) / 2;

  const sill = Math.min(y0 + UPPER_SILL, y1 - 0.4);
  const head = Math.min(y0 + UPPER_HEAD, y1 - 0.15);

  emitWall(out, side, thick, a0, a1, y0, sill, material, room);
  emitWall(out, side, thick, a0, a1, head, y1, material, room);

  for (let b = 0; b < bays; b++) {
    const bx = a0 + b * bayW;
    emitWall(out, side, thick, bx, bx + pierW, sill, head, material, room);
    emitWall(out, side, thick, bx + pierW + winW, bx + bayW, sill, head, material, room);
  }
}

function emitWall(out, side, thick, a0, a1, y0, y1, material, room, type = PROP_WALLSEG) {
  if (a1 - a0 < 0.05 || y1 - y0 < 0.05) return;
  const minX = side.axis === 'x' ? side.at - thick / 2 : a0;
  const maxX = side.axis === 'x' ? side.at + thick / 2 : a1;
  const minZ = side.axis === 'x' ? a0 : side.at - thick / 2;
  const maxZ = side.axis === 'x' ? a1 : side.at + thick / 2;
  push(out, type, {
    x: (minX + maxX) / 2, y: y0, z: (minZ + maxZ) / 2,
    sx: maxX - minX, sy: y1 - y0, sz: maxZ - minZ,
    material, room: room.id, exterior: side.exterior,
    collider: box(minX, y0, minZ, maxX, y1, maxZ),
  });
}

/**
 * Every storey above the ground, with the flight up to each.
 *
 * A floor slab hangs BELOW the surface you walk on, exactly as the ground floor
 * does. Getting that the other way round -- slab top above the nominal level --
 * puts anything placed at that level inside the slab, and the push-out resolver
 * then shoves it sideways off the floor. Uniform levels are also what lets the
 * lighting, the furniture and the navigation all agree that storey k is at
 * floorY + FLOOR_H * k without each of them carrying its own correction.
 */
function buildStoreys(out, r) {
  for (let k = 1; k < (r.storeys ?? 1); k++) {
    const y = levelY(r, k);
    const well = stairWell(r, k);
    if (!well) break;                 // no well, no way up, no floor above

    // ---- the slab, minus the hole the flight comes through ------------
    //
    // The hole is what makes an upper floor part of the same room rather than a
    // separate box on top of it: you can see down onto the fight you just left,
    // and anything chasing you has a route rather than a ceiling.
    for (const p of subtractRect(r, well)) {
      if (p.maxX - p.minX < 0.5 || p.maxZ - p.minZ < 0.5) continue;
      push(out, PROP_SLAB, {
        x: (p.minX + p.maxX) / 2, y: y - SLAB_T, z: (p.minZ + p.maxZ) / 2,
        sx: p.maxX - p.minX, sy: SLAB_T, sz: p.maxZ - p.minZ,
        material: 'slab', room: r.id, storey: k,
        collider: box(p.minX, y - SLAB_T, p.minZ, p.maxX, y, p.maxZ),
      });
    }

    // ---- the flight ---------------------------------------------------
    //
    // Measured between walking surfaces, so the first tread is a step up from
    // the floor below and the last is level with the floor above. Treads are
    // short boxes because a ramp is invisible to collision -- there are no
    // sloped colliders in this world, by design.
    const base = levelY(r, k - 1);
    const rise = y - base;
    const steps = Math.max(1, Math.ceil(rise / STEP_RISE));
    const stepRise = rise / steps;
    const run = (well.axis === 'x'
      ? well.maxX - well.minX
      : well.maxZ - well.minZ) / steps;

    // The flight fills the well wall to wall, and its last tread finishes flush
    // with the slab. Both matter: a gap at the top is a slot you fall down on
    // the way off the stairs, and a gap at the side is an open shaft between
    // the treads and the wall.
    for (let i = 0; i < steps; i++) {
      const topY = base + (i + 1) * stepRise;
      // dir 1 climbs toward the positive run axis, dir -1 toward the negative;
      // either way the last tread lands against the slab rather than the hole.
      const along0 = well.dir > 0
        ? (well.axis === 'x' ? well.minX : well.minZ) + i * run
        : (well.axis === 'x' ? well.maxX : well.maxZ) - (i + 1) * run;
      const minX = well.axis === 'x' ? along0 : well.minX;
      const maxX = well.axis === 'x' ? along0 + run : well.maxX;
      const minZ = well.axis === 'x' ? well.minZ : along0;
      const maxZ = well.axis === 'x' ? well.maxZ : along0 + run;
      push(out, PROP_STAIR, {
        x: (minX + maxX) / 2, y: topY - stepRise, z: (minZ + maxZ) / 2,
        sx: maxX - minX, sy: stepRise, sz: maxZ - minZ, material: 'stair',
        room: r.id, storey: k,
        collider: box(minX, base - 0.2, minZ, maxX, topY, maxZ),
      });
    }

    // ---- balustrade ---------------------------------------------------
    //
    // A wall along the open side of the well. Without it the stairwell is a
    // three-metre hole in the floor with no edge, and walking the upper storey
    // means falling down it -- which reads as the floor being broken rather
    // than as an open plan. The end the flight arrives at stays open: that is
    // the way on and off.
    const rail = { y0: y, y1: y + 1.05 };
    const sides = well.axis === 'x'
      ? well.railZs ?? [well.openZ]
      : well.railXs ?? [well.openX ?? (well.dir > 0 ? well.minX : well.maxX)];
    for (const across of sides) {
      const bal = well.axis === 'x'
        ? {
          minX: well.minX, maxX: well.maxX,
          minZ: across - 0.09, maxZ: across + 0.09,
        }
        : {
          minX: across - 0.09, maxX: across + 0.09,
          minZ: well.minZ, maxZ: well.maxZ,
        };
      push(out, PROP_WALLSEG, {
        x: (bal.minX + bal.maxX) / 2, y: rail.y0, z: (bal.minZ + bal.maxZ) / 2,
        sx: bal.maxX - bal.minX, sy: rail.y1 - rail.y0, sz: bal.maxZ - bal.minZ,
        material: 'parapet', room: r.id, storey: k,
        collider: box(bal.minX, rail.y0, bal.minZ, bal.maxX, rail.y1, bal.maxZ),
      });
    }
  }
}

/** A room's footprint with a rectangle cut out of it, as up to four rects. */
function subtractRect(r, hole) {
  const parts = [];
  if (hole.minX > r.minX + 0.01) {
    parts.push({ minX: r.minX, maxX: hole.minX, minZ: r.minZ, maxZ: r.maxZ });
  }
  if (hole.maxX < r.maxX - 0.01) {
    parts.push({ minX: hole.maxX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ });
  }
  const x0 = Math.max(r.minX, hole.minX), x1 = Math.min(r.maxX, hole.maxX);
  if (hole.minZ > r.minZ + 0.01) {
    parts.push({ minX: x0, maxX: x1, minZ: r.minZ, maxZ: hole.minZ });
  }
  if (hole.maxZ < r.maxZ - 0.01) {
    parts.push({ minX: x0, maxX: x1, minZ: hole.maxZ, maxZ: r.maxZ });
  }
  return parts;
}

export { DOOR_W, DOOR_H, SILL, HEAD, WALL_EXT, WALL_INT, SLAB_T, SLAB_LIFT };
