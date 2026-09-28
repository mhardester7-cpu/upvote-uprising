// CUL-DE-SAC: the hand-authored versus map.
//
// Every other map in this game is grown from a seed by planComplex, which is
// right for co-op -- a horde map wants to be somewhere you have not memorised.
// A versus map wants the opposite. Both players must know it perfectly, and
// they must know it is fair, which a subdivision of a rectangle can never
// promise: one seed gives one player a two-storey overwatch and the other a
// cupboard.
//
// So this one is typed out. It emits the shape planComplex does -- rooms and
// the links between them -- which is the whole reason it is short: buildComplex
// already turns that into walls, slabs, stairs and doorways, addFurnishings
// already puts cover in it, and the navigation grid already paths across it.
//
// The layout
// ----------
// Two L-shaped houses standing on open ground, facing each other across a
// turnaround, with a wall round the lot:
//
//        +--------------------------------------------------+  z=0
//        |                                                  |
//        |   +------------+            +------------+       |  z=12
//        |   |            |            |            |       |
//        |   |  HOUSE     |  ~~~~~~~~  |     HOUSE  |       |
//        |   |  (2 up)    |  turnaround|     (2 up) |       |  z=28
//        |   +--------+---+            +---+--------+       |
//        |   | WING   |                    |   WING |       |  z=38
//        |   +--------+                    +--------+       |
//        |                                                  |
//        +--------------------------------------------------+  z=52
//        x=0    6     18  22           42  46    58        64
//
// The important structural point, and the one the first version of this file
// got wrong: the outdoor space is NOT a room. In a tiled floorplan every
// courtyard is a walled cell, which turns a lot with two houses on it into one
// compound with rooms in it -- corridors and pens instead of buildings and
// ground between them. Here the ground is simply ground: the heightfield is
// flattened under the lot and the houses stand on it.
//
// That is what `shell: true` on a room is for. Exterior normally means "on the
// plan bounds", which is right for a tiling and useless for a building in the
// middle of a lot -- it would be built out of thin interior partitions with no
// windows in them. A shell room treats every face with nothing against it as an
// outside wall, and leaves the face where its wing joins on as a shared one.
//
// The wings point away from each other on purpose. Facing them inward would
// give each player a covered approach to the middle, and the middle is supposed
// to be the place you have to expose yourself to cross.
//
// Only the west half is typed out; the east is reflected from it by mx(), so
// the two can never drift apart.

import { assignStairCorners } from './complex.js';

/** The lot. Small on purpose: this is a map you cross, not one you tour. */
export const ARENA_W = 64;
export const ARENA_D = 52;

/** The line the whole map reflects about. */
const MID_X = ARENA_W / 2;

/** How high the wall round the lot stands, and how thick. */
export const FENCE_H = 4.2;
const FENCE_T = 0.6;

/**
 * Buildings, west side only.
 *
 * `key` is what the links below refer to, so the lot can be re-proportioned
 * without renumbering anything. Ids are assigned after mirroring.
 */
const WEST = [
  // The house proper: two storeys, because an upstairs window over the
  // turnaround is the position worth fighting for, and both sides get one.
  { key: 'w_house', label: 'WEST HOUSE', minX: 6, maxX: 22, minZ: 12, maxZ: 28, storeys: 2 },
  // The wing, single storey, hanging off the back corner away from the middle.
  { key: 'w_wing', label: 'WEST WING', minX: 6, maxX: 18, minZ: 28, maxZ: 38 },
];

/**
 * Doorways.
 *
 * An `axis: 'x'` link is a gap in a wall standing at x = `at`, spanning z from
 * `lo` to `hi`; 'z' is the transpose, and the opening is punched at the
 * midpoint of that span.
 *
 * A link whose two ends are the same room is a door onto open ground. There is
 * no room out there to name as the far side -- that is the whole point of the
 * layout -- and buildComplex only ever uses a link to decide where to leave a
 * gap, so naming the room twice punches the opening and creates nothing else.
 */
const WEST_LINKS = [
  // House into its wing.
  { a: 'w_house', b: 'w_wing', axis: 'z', at: 28, lo: 8, hi: 16 },
  // Front door, onto the turnaround. This is the one that gets watched.
  { a: 'w_house', b: 'w_house', axis: 'x', at: 22, lo: 16, hi: 24 },
  // Back door and side door, so the house is not a one-entrance box. Three ways
  // in means no single doorway is worth holding.
  { a: 'w_house', b: 'w_house', axis: 'x', at: 6, lo: 14, hi: 22 },
  { a: 'w_house', b: 'w_house', axis: 'z', at: 12, lo: 10, hi: 18 },
  // And the wing's own door out the back.
  { a: 'w_wing', b: 'w_wing', axis: 'z', at: 38, lo: 8, hi: 16 },
  { a: 'w_wing', b: 'w_wing', axis: 'x', at: 18, lo: 30, hi: 36 },
];

/**
 * Hard cover, as 20ft containers.
 *
 * Two flanking the turnaround, standing across the map so they break the long
 * sightline down the middle rather than lying along it. Both sit on the centre
 * line, so each is its own mirror image and the middle stays symmetric without
 * needing a partner.
 *
 * Kept well clear of the perimeter on purpose: a 2.6m box parked against a
 * 4.2m wall is a ladder out of the map.
 */
const COVER = [
  { x: MID_X, z: 16, alongX: true, tint: 0 },
  { x: MID_X, z: 36, alongX: true, tint: 1 },
];

/**
 * The vehicle standing in the turnaround.
 *
 * The one thing on the map that is a loaded model rather than code. Everything
 * else here is a box because everything else here IS a box; a truck written out
 * of boxes reads as a box with wheels drawn on it.
 *
 * These dimensions are the collider, not the model. The art is scaled to fit
 * them (see render/models.js), so what stops a bullet is decided here in a file
 * that has never heard of Three.js, and swapping the model cannot change it.
 *
 * Parked across the crossing so it splits the middle into two ways round
 * instead of one open run, and dead on the centre line so it is its own mirror
 * image.
 */
const VEHICLE = {
  model: 'delivery',
  x: MID_X, z: 26,
  // Long axis across the map, so it blocks the straight run between the houses.
  sx: 6.2, sy: 2.7, sz: 2.5,
  rot: Math.PI / 2,
};

/**
 * Spawn anchors, west side only.
 *
 * Deliberately not one per side. A single spawn is a spawn you can camp, and on
 * a lot this size camping one end is the whole match. Two are inside the
 * building and two are out on the ground behind it, so a player who has lost
 * the house does not keep respawning inside it.
 *
 * None is near the middle: the turnaround is the one place nobody should ever
 * appear, because it is the one place both players are already looking at.
 */
const WEST_SPAWNS = [
  { x: 14, z: 20 },   // in the house
  { x: 11, z: 33 },   // in the wing
  { x: 3, z: 7 },     // open ground, back corner
  { x: 3, z: 45 },    // open ground, other back corner
];

/** Reflect an x coordinate across the centre line. */
const mx = (x) => ARENA_W - x;

export function planArena({ x0 = 0, z0 = 0, groundY = 0 } = {}) {
  const rooms = [];
  const byKey = new Map();

  /** Register a room, translating plan-local coordinates into world ones. */
  const add = (r) => {
    const room = {
      id: rooms.length,
      key: r.key,
      minX: x0 + r.minX, maxX: x0 + r.maxX,
      minZ: z0 + r.minZ, maxZ: z0 + r.maxZ,
      cx: x0 + (r.minX + r.maxX) / 2,
      cz: z0 + (r.minZ + r.maxZ) / 2,
      area: (r.maxX - r.minX) * (r.maxZ - r.minZ),
      floorY: groundY,
      outdoor: false,
      // Every building on this map stands on open ground, so every one of them
      // is a shell -- see the note at the top of the file.
      shell: true,
      storeys: r.storeys ?? 1,
      // Depth drives nothing here -- there is no progression to price -- but
      // buildComplex reads it to choose which room hides the secret panel, and
      // the HUD reads the label.
      depth: 1,
      tier: 0,
      open: true,
      label: r.label,
      role: { id: 'arena', name: r.label, chests: 0, weapons: 0 },
    };
    rooms.push(room);
    byKey.set(r.key, room);
    return room;
  };

  for (const r of WEST) add(r);
  // The east side is the west side reflected, so the two can never drift apart.
  // Reflecting swaps which face is min and which is max, hence the min/max.
  for (const r of WEST) {
    add({
      ...r,
      key: r.key.replace(/^w_/, 'e_'),
      label: r.label.replace('WEST', 'EAST'),
      minX: Math.min(mx(r.minX), mx(r.maxX)),
      maxX: Math.max(mx(r.minX), mx(r.maxX)),
    });
  }

  const links = [];
  const link = (a, b, axis, at, lo, hi) => {
    const ra = byKey.get(a), rb = byKey.get(b);
    links.push({
      a: ra.id, b: rb.id, axis,
      at: (axis === 'x' ? x0 : z0) + at,
      lo: (axis === 'x' ? z0 : x0) + lo,
      hi: (axis === 'x' ? z0 : x0) + hi,
      // Free, always. A door somebody has to buy is a door that is shut for one
      // player and open for another, which on a mirrored map destroys the only
      // property this layout exists to guarantee.
      price: 0,
      zone: rb.id,
    });
  };

  for (const l of WEST_LINKS) link(l.a, l.b, l.axis, l.at, l.lo, l.hi);
  // Mirror them. An 'x' link's wall reflects to the far side of the lot and its
  // span is untouched; a 'z' link's wall stays where it is and the span along
  // it reflects instead.
  for (const l of WEST_LINKS) {
    const twin = (k) => (byKey.has(k.replace(/^w_/, 'e_')) ? k.replace(/^w_/, 'e_') : k);
    if (l.axis === 'x') {
      link(twin(l.a), twin(l.b), 'x', mx(l.at), l.lo, l.hi);
    } else {
      link(twin(l.a), twin(l.b), 'z', l.at, mx(l.hi), mx(l.lo));
    }
  }

  // Authored doors need the same guaranteed approach clearance as generated
  // ones because the stairs use the same solid tread geometry.
  assignStairCorners(rooms, links);

  const spawns = [];
  for (const s of WEST_SPAWNS) {
    spawns.push({ x: x0 + s.x, z: z0 + s.z, side: 0 });
    spawns.push({ x: x0 + mx(s.x), z: z0 + s.z, side: 1 });
  }

  return {
    rooms,
    links,
    cover: COVER.map((c) => ({ ...c, x: x0 + c.x, z: z0 + c.z })),
    vehicles: [{ ...VEHICLE, x: x0 + VEHICLE.x, z: z0 + VEHICLE.z }],
    /**
     * The wall round the lot.
     *
     * Emitted as props by World rather than as rooms, because a room would
     * bring a floor slab and a set of interior walls with it -- which is
     * exactly the tiled compound this layout exists to get away from. All the
     * lot needs is an edge that cannot be walked over.
     */
    fence: {
      minX: x0, minZ: z0, maxX: x0 + ARENA_W, maxZ: z0 + ARENA_D,
      height: FENCE_H, thickness: FENCE_T,
    },
    // Only used as the fallback "somewhere already open"; versus spawning goes
    // through the anchors above.
    start: byKey.get('w_house').id,
    bounds: { x0, z0, x1: x0 + ARENA_W, z1: z0 + ARENA_D },
    spawns,
    arena: true,
  };
}
