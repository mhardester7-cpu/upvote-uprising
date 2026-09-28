// The central rhythm tower: deterministic placement, collision and ladder data.
//
// Rendering deliberately lives elsewhere.  The records emitted here are the
// authoritative version of the landmark: bullets hit the steelwork, the deck
// can be stood on, the railings stop a careless sidestep, and Player consumes
// the same ladder record that the renderer uses for its rails and rungs.

export const PROP_DRUMMER_TOWER = 'drummer_tower';
export const DRUMMER_TOWER_ROLE = 'rhythm_tower';

export const TOWER_DECK_HEIGHT = 24;
export const TOWER_DECK_SIZE = 9.6;
export const TOWER_HATCH_WIDTH = 1.25;
/** Seconds between shaking the machine and its one-shot explosion. */
export const VENDING_SHAKE_SECONDS = 1.45;
/** Horizontal interaction reach shared by rendering and the authoritative sim. */
export const VENDING_INTERACT_RANGE = 2.05;

/** True when a living body is close enough to trigger the rooftop machine. */
export function bananaVendingInRange(tower, body) {
  const vending = tower?.bananaVending;
  const pos = body?.pos ?? body;
  if (!vending || !pos || body?.alive === false || body?.down) return false;
  return Math.hypot(pos.x - vending.x, pos.z - vending.z) <= VENDING_INTERACT_RANGE
    && pos.y >= vending.y - 0.65 && pos.y <= vending.y + 2.8;
}

/** True only once a body has reached the playable rooftop deck. */
export function onDrummerTowerDeck(tower, body) {
  if (!tower || !body || !Number.isFinite(tower.deckY)) return false;
  const half = (tower.deckSize ?? TOWER_DECK_SIZE) / 2;
  return body.y >= tower.deckY - 0.18
    && body.y <= tower.deckY + 3.6
    && Math.abs(body.x - tower.x) <= half + 0.08
    && Math.abs(body.z - tower.z) <= half + 0.08;
}

const LEG_SPAN = TOWER_DECK_SIZE - 1.4;
const LEG_SIZE = 0.48;
const DECK_THICKNESS = 0.34;
const RAIL_HEIGHT = 1.12;
const RAIL_THICKNESS = 0.12;
const ROOM_MARGIN = 1.45;

const box = (minX, minY, minZ, maxX, maxY, maxZ) => ({
  kind: 'box', minX, minY, minZ, maxX, maxY, maxZ,
});

function distanceToRoom(room, x, z) {
  const dx = x < room.minX ? room.minX - x : x > room.maxX ? x - room.maxX : 0;
  const dz = z < room.minZ ? room.minZ - z : z > room.maxZ ? z - room.maxZ : 0;
  return Math.hypot(dx, dz);
}

function roomFitsTower(room) {
  return room.maxX - room.minX >= TOWER_DECK_SIZE + ROOM_MARGIN * 2
    && room.maxZ - room.minZ >= TOWER_DECK_SIZE + ROOM_MARGIN * 2;
}

/**
 * Reserve the room nearest the literal centre of the generated map.
 *
 * The tower is open to the sky, so a generated roof cannot be left over it.
 * Special authored rooms are kept intact; when one happens to own the centre,
 * the nearest ordinary room wins instead.  The returned X/Z stays as close to
 * the true centre as that room's walls allow.
 */
export function planDrummerTower(plan) {
  if (!plan || plan.arena || !plan.rooms?.length || !plan.bounds) return null;

  const mapX = (plan.bounds.x0 + plan.bounds.x1) / 2;
  const mapZ = (plan.bounds.z0 + plan.bounds.z1) / 2;
  const forbidden = new Set(['start', 'dinosaur_factory', 'reverse_aquarium']);
  const candidates = plan.rooms
    .filter((room) => roomFitsTower(room) && !forbidden.has(room.role?.id))
    .sort((a, b) => {
      const ad = distanceToRoom(a, mapX, mapZ);
      const bd = distanceToRoom(b, mapX, mapZ);
      // If both rooms contain the centre, retain an existing courtyard before
      // opening a new roof.  The tie-break remains stable across clients.
      return ad - bd || Number(b.outdoor) - Number(a.outdoor) || a.id - b.id;
    });
  const room = candidates[0];
  if (!room) return null;

  const inset = TOWER_DECK_SIZE / 2 + ROOM_MARGIN;
  const x = Math.max(room.minX + inset, Math.min(room.maxX - inset, mapX));
  const z = Math.max(room.minZ + inset, Math.min(room.maxZ - inset, mapZ));

  room.outdoor = true;
  room.storeys = 1;
  room.drummerTower = true;
  room.role = {
    id: DRUMMER_TOWER_ROLE,
    name: 'RHYTHM TOWER',
    chests: 1,
    weapons: 1,
  };
  room.label = room.role.name;

  const tower = { room: room.id, x, z };
  plan.drummerTowerRoom = room.id;
  plan.drummerTower = tower;
  return tower;
}

function pushBox(out, tower, part, minX, minY, minZ, maxX, maxY, maxZ) {
  out.push({
    type: PROP_DRUMMER_TOWER,
    towerPart: part,
    room: tower.room,
    x: (minX + maxX) / 2,
    y: minY,
    z: (minZ + maxZ) / 2,
    sx: maxX - minX,
    sy: maxY - minY,
    sz: maxZ - minZ,
    rot: 0,
    scale: 1,
    height: maxY - minY,
    collider: box(minX, minY, minZ, maxX, maxY, maxZ),
  });
}

/** Emit the landmark's solid pieces and finish its shared ladder record. */
export function buildDrummerTower(plan, out = []) {
  const authored = plan?.drummerTower;
  if (!authored) return null;
  const room = plan.rooms.find((candidate) => candidate.id === authored.room);
  if (!room) return null;

  const baseY = room.floorY;
  const deckY = baseY + TOWER_DECK_HEIGHT;
  const halfDeck = TOWER_DECK_SIZE / 2;
  const halfLeg = LEG_SPAN / 2;
  const halfLegSize = LEG_SIZE / 2;
  const hatchHalf = TOWER_HATCH_WIDTH / 2;
  const hatchInnerZ = authored.z + halfDeck - 1.42;
  const deckBottom = deckY - DECK_THICKNESS;
  const tower = {
    ...authored,
    baseY,
    deckY,
    deckSize: TOWER_DECK_SIZE,
    height: TOWER_DECK_HEIGHT,
  };

  // Four load-bearing legs.  Cross-bracing is visual and intentionally has no
  // collision; catching a shoulder on a 5 cm brace would feel less realistic,
  // not more.
  for (const dx of [-halfLeg, halfLeg]) {
    for (const dz of [-halfLeg, halfLeg]) {
      pushBox(out, tower, 'leg',
        authored.x + dx - halfLegSize, baseY,
        authored.z + dz - halfLegSize,
        authored.x + dx + halfLegSize, deckBottom,
        authored.z + dz + halfLegSize);
    }
  }

  // The top deck has a real hatch at the ladder instead of a fake ladder that
  // ends underneath one solid slab.
  pushBox(out, tower, 'deck-left',
    authored.x - halfDeck, deckBottom, authored.z - halfDeck,
    authored.x - hatchHalf, deckY, authored.z + halfDeck);
  pushBox(out, tower, 'deck-right',
    authored.x + hatchHalf, deckBottom, authored.z - halfDeck,
    authored.x + halfDeck, deckY, authored.z + halfDeck);
  pushBox(out, tower, 'deck-centre',
    authored.x - hatchHalf, deckBottom, authored.z - halfDeck,
    authored.x + hatchHalf, deckY, hatchInnerZ);

  const railY0 = deckY + 0.08;
  const railY1 = railY0 + RAIL_HEIGHT;
  // North, east and west are continuous.  The south railing leaves a body-wide
  // gateway aligned with the hatch and ladder.
  pushBox(out, tower, 'rail-north',
    authored.x - halfDeck, railY0, authored.z - halfDeck - RAIL_THICKNESS / 2,
    authored.x + halfDeck, railY1, authored.z - halfDeck + RAIL_THICKNESS / 2);
  pushBox(out, tower, 'rail-west',
    authored.x - halfDeck - RAIL_THICKNESS / 2, railY0, authored.z - halfDeck,
    authored.x - halfDeck + RAIL_THICKNESS / 2, railY1, authored.z + halfDeck);
  pushBox(out, tower, 'rail-east',
    authored.x + halfDeck - RAIL_THICKNESS / 2, railY0, authored.z - halfDeck,
    authored.x + halfDeck + RAIL_THICKNESS / 2, railY1, authored.z + halfDeck);
  pushBox(out, tower, 'rail-south-left',
    authored.x - halfDeck, railY0, authored.z + halfDeck - RAIL_THICKNESS / 2,
    authored.x - hatchHalf, railY1, authored.z + halfDeck + RAIL_THICKNESS / 2);
  pushBox(out, tower, 'rail-south-right',
    authored.x + hatchHalf, railY0, authored.z + halfDeck - RAIL_THICKNESS / 2,
    authored.x + halfDeck, railY1, authored.z + halfDeck + RAIL_THICKNESS / 2);

  // Simplified solid footprints under the detailed kit and performer. They
  // preserve a clear landing lane from the south hatch while preventing the
  // player from walking through the bass drum or the gorilla's legs.
  pushBox(out, tower, 'drum-kit',
    authored.x - 1.72, deckY, authored.z - 1.05,
    authored.x + 1.72, deckY + 1.82, authored.z + 1.15);
  pushBox(out, tower, 'drummer',
    authored.x - 1.05, deckY, authored.z - 3.62,
    authored.x + 1.05, deckY + 3.05, authored.z - 1.35);

  // A compact banana machine sits beside the drummer, clear of the kit,
  // speaker stack and ladder landing. The renderer mounts the sourced FBX and
  // banana GLB over this footprint; collision remains stable if either asset
  // is unavailable or still loading.
  tower.bananaVending = {
    x: authored.x + 2.65,
    y: deckY,
    z: authored.z - 2,
    width: 1.08,
    height: 2.2,
    depth: 1.08,
  };
  pushBox(out, tower, 'banana-vending-machine',
    tower.bananaVending.x - tower.bananaVending.width / 2,
    deckY,
    tower.bananaVending.z - tower.bananaVending.depth / 2,
    tower.bananaVending.x + tower.bananaVending.width / 2,
    deckY + tower.bananaVending.height,
    tower.bananaVending.z + tower.bananaVending.depth / 2);

  // The canonical ladder is on the south face.  `normal` points away from the
  // structure; Player uses the inverse as the facing direction while attached.
  tower.ladder = {
    id: 'rhythm-tower-ladder',
    x: authored.x,
    z: authored.z + halfDeck + 0.1,
    normalX: 0,
    normalZ: 1,
    minY: baseY + 0.05,
    maxY: deckY + 0.92,
    deckY,
    topX: authored.x,
    topZ: hatchInnerZ - 0.52,
    width: TOWER_HATCH_WIDTH,
  };
  tower.drummer = {
    x: authored.x,
    y: deckY,
    z: authored.z - 1.88,
  };
  tower.sound = {
    x: authored.x,
    y: deckY + 1.25,
    z: authored.z + 0.28,
  };

  plan.drummerTower = tower;
  return tower;
}
