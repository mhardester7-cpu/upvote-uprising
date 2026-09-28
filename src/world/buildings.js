// What goes in the rooms.
//
// complex.js owns the shell -- walls, floors, doors, stairs. This owns what
// stands on the floor once those exist. Kept apart because furniture is the
// part you tune constantly and the shell is the part that must not move.
//
// Every piece is cover as well as scenery: `h` is what the player stands on if
// they climb it, so a desk is something to vault and a locker bank is
// something to break line of sight behind.

import { rand2 } from './noise.js';
import {
  PROP_FURNITURE, DOOR_W, DINOSAUR_FACTORY_ROLE, REVERSE_AQUARIUM_ROLE,
  levelsOf, stairWell, doorwayCenter,
} from './complex.js';
import { PROP_BARREL, PROP_CRATE, BARREL_MODELS } from './world.js';


/**
 * Furniture catalogue.
 *
 * `h` is what the player stands on if they climb it, so these double as
 * traversal geometry: a desk is cover you can vault onto, a locker bank is
 * cover you cannot.
 */
/**
 * Round cover.
 *
 * Kept as a cylinder rather than a box on purpose: it is the only round
 * collider left indoors now the trees are gone, and a drum you can strafe
 * around reads differently from a crate you corner on.
 */
const DRUM = { kind: 'drum', r: 0.32, h: 0.88 };

const FURNITURE = [
  { kind: 'desk', w: 1.6, d: 0.8, h: 0.75, weight: 3 },
  { kind: 'table', w: 1.8, d: 1.0, h: 0.78, weight: 2 },
  { kind: 'shelf', w: 2.2, d: 0.45, h: 2.0, weight: 3 },
  { kind: 'locker', w: 1.2, d: 0.5, h: 1.9, weight: 2 },
  { kind: 'cabinet', w: 0.9, d: 0.6, h: 1.3, weight: 2 },
  { kind: 'sofa', w: 1.9, d: 0.85, h: 0.8, weight: 1 },
  { kind: 'counter', w: 2.4, d: 0.7, h: 1.05, weight: 1 },
  { kind: 'pallet', w: 1.2, d: 1.0, h: 0.55, weight: 2 },
];

/**
 * The one interactive furnishing. Its prop is authored here with the rest of
 * the furniture so movement, bullets, navigation and the server all agree on
 * the machine's footprint. The renderer deliberately skips this kind; the
 * interactive entity supplies the detailed body and animation over the same
 * collider.
 */
export const NUGGET_DISPENSER_KIND = 'nugget_dispenser';
const NUGGET_DISPENSER = { w: 1.25, d: 0.72, h: 2.05 };

/** A full-height cloning pod and control bank, authored as real cover. */
export const DINOSAUR_FACTORY_KIND = 'dinosaur_factory';
const DINOSAUR_FACTORY = { w: 2.8, d: 1.25, h: 2.8, hatch: 1.5 };

/**
 * A readable human habitat, organised into domestic zones at real-world scale.
 *
 * The old set called a warehouse cart a bed, an ammo can food, and loose pipe
 * modules sanitation. Worse, several target boxes had the model's length and
 * width reversed, so the uniform fitter shrank cars and equipment until they
 * looked like toys. Procedural domestic pieces now provide the things humans
 * actually live with; the four PBR utility props that remain use their measured
 * source proportions.
 */
export const HUMAN_ENCLOSURE_PROPS = Object.freeze([
  { id: 'bed', shape: 'bed', zone: 'sleep', label: 'bed',
    wall: 'north', slot: 0.18, w: 2.08, d: 1.02, h: 0.64 },
  { id: 'wardrobe', shape: 'wardrobe', zone: 'sleep', label: 'clothing storage',
    wall: 'north', slot: 0.52, w: 1.22, d: 0.58, h: 1.92 },
  { id: 'armchair', shape: 'armchair', zone: 'living', label: 'armchair',
    wall: 'north', slot: 0.82, w: 0.88, d: 0.88, h: 0.92 },
  { id: 'sofa', shape: 'sofa', zone: 'living', label: 'sofa',
    wall: 'west', slot: 0.22, w: 1.96, d: 0.88, h: 0.88 },
  { id: 'coffee-table', shape: 'coffee_table', zone: 'living', label: 'low table',
    wall: 'west', slot: 0.22, inset: 1.55, w: 1.08, d: 0.62, h: 0.44 },
  { id: 'television', shape: 'television', zone: 'living', label: 'television',
    wall: 'east', slot: 0.22, w: 1.04, d: 0.38, h: 1.26 },
  { id: 'dining-set', shape: 'dining_set', zone: 'dining', label: 'table and chairs',
    wall: 'south', slot: 0.26, w: 2.18, d: 1.72, h: 0.94 },
  { id: 'refrigerator', shape: 'refrigerator', zone: 'dining', label: 'food storage',
    wall: 'south', slot: 0.52, w: 0.78, d: 0.72, h: 1.82 },
  { id: 'toilet', shape: 'toilet', zone: 'hygiene', label: 'toilet',
    wall: 'east', slot: 0.70, w: 0.58, d: 0.72, h: 0.78 },
  { id: 'sink', shape: 'sink', zone: 'hygiene', label: 'wash basin',
    wall: 'east', slot: 0.88, w: 0.68, d: 0.52, h: 1.18 },
  { id: 'supply-cart', model: 'industrial_storage_cart', zone: 'utility', label: 'supply trolley',
    wall: 'west', slot: 0.56, w: 1.05, d: 0.72, h: 0.90 },
  { id: 'generator', model: 'portable_generator', zone: 'utility', label: 'emergency generator',
    wall: 'west', slot: 0.82, w: 1.38, d: 0.95, h: 0.97 },
  { id: 'toolbox', model: 'metal_toolbox', zone: 'utility', label: 'toolbox',
    wall: 'south', slot: 0.68, w: 0.63, d: 0.46, h: 0.55 },
  { id: 'water-can', model: 'metal_jerrycan_green', zone: 'utility', label: 'water can',
    wall: 'south', slot: 0.80, w: 0.61, d: 0.28, h: 0.82 },
]);

/** Installed files, retained as a focused export for asset checks and tools. */
export const HUMAN_ENCLOSURE_MODELS = Object.freeze(
  HUMAN_ENCLOSURE_PROPS.filter((prop) => prop.model),
);

/**
 * Nothing over this height stands in the open air.
 *
 * A courtyard has no ceiling, so anything tall enough to stand on is a step
 * toward the top of its wall, and the top of a wall is the roofs. Indoors the
 * ceiling settles the argument for us; outdoors the catalogue has to.
 */
const OUTDOOR_MAX_H = 1.1;

/** How far a piece of furniture keeps off a wall, a doorway, or a stairwell. */
const WALL_MARGIN = 1.0;
const DOOR_CLEAR = 1.6;
const WELL_CLEAR = 1.0;

function pickFurniture(r, maxH = Infinity) {
  const pool = FURNITURE.filter((f) => f.h <= maxH);
  if (!pool.length) return null;
  const total = pool.reduce((s, f) => s + f.weight, 0);
  let roll = r * total;
  for (const f of pool) {
    roll -= f.weight;
    if (roll <= 0) return f;
  }
  return pool[0];
}

/** Do two XZ rectangles overlap, allowing for a gap that has to stay walkable? */
function overlaps(a, b, gap = 0) {
  return a.minX < b.maxX + gap && a.maxX > b.minX - gap
    && a.minZ < b.maxZ + gap && a.maxZ > b.minZ - gap;
}

/**
 * Everywhere on one floor of one room that furniture must not stand.
 *
 * Three things, all of them the same bug from the player's side -- a room you
 * cannot walk across:
 *
 *   The doorways, because a desk in a doorway is a door that does not open,
 *   and on a map where doorways are bought that is a purchase that does
 *   nothing.
 *
 *   The stairwell on this floor, which is a hole, and the one on the floor
 *   above, whose flight lands here -- a locker at the foot of a flight makes
 *   the storey above unreachable.
 *
 *   The strip along every wall, so there is always a way round the outside of
 *   a room. A pocket between a shelf and a wall is body-sized and inescapable.
 */
function keepOutRects(plan, r, storey) {
  const rects = [];

  for (const k of [storey, storey + 1]) {
    const well = stairWell(r, k);
    if (well) {
      rects.push({
        minX: well.minX - WELL_CLEAR, maxX: well.maxX + WELL_CLEAR,
        minZ: well.minZ - WELL_CLEAR, maxZ: well.maxZ + WELL_CLEAR,
      });
    }
  }

  // Doorways are cut at ground level only, so only the ground floor has to
  // leave room for them.
  if (storey === 0) {
    for (const l of plan.links) {
      if (l.a !== r.id && l.b !== r.id) continue;
      const mid = doorwayCenter(l);
      const half = DOOR_W / 2 + DOOR_CLEAR;
      rects.push(l.axis === 'x'
        ? {
          minX: l.at - DOOR_CLEAR - 0.4, maxX: l.at + DOOR_CLEAR + 0.4,
          minZ: mid - half, maxZ: mid + half,
        }
        : {
          minX: mid - half, maxX: mid + half,
          minZ: l.at - DOOR_CLEAR - 0.4, maxZ: l.at + DOOR_CLEAR + 0.4,
        });

      // The first-room spaceport is a new player's primary landmark. Keep a
      // direct aisle from the room centre to its green shutter; ordinary doors
      // only need local clearance, but hiding this one behind a locker makes
      // the ship route look absent even though collision says it is open.
      if (l.escape) {
        const aisle = 1.35;
        rects.push(l.axis === 'x'
          ? {
            minX: Math.min(l.at, r.cx) - 0.4, maxX: Math.max(l.at, r.cx) + 0.4,
            minZ: mid - aisle, maxZ: mid + aisle,
          }
          : {
            minX: mid - aisle, maxX: mid + aisle,
            minZ: Math.min(l.at, r.cz) - 0.4, maxZ: Math.max(l.at, r.cz) + 0.4,
          });
      }
    }
  }

  return rects;
}

/** Pick a deterministic wall-adjacent footprint, facing into the room. */
function nuggetDispenserPlacement(r, blocked) {
  const { w, d } = NUGGET_DISPENSER;
  // Try the true corner bays first. A start room can have a door centred on
  // all four walls; the old 22/78% positions then clipped the last few
  // centimetres of every doorway keep-out rectangle and silently omitted the
  // guaranteed machine. Ten/ninety percent still leaves the wall margin but
  // uses the otherwise empty corner beside those centred openings.
  const along = [0.1, 0.9, 0.22, 0.78, 0.5, 0.35, 0.65];
  const candidates = [];

  for (const t of along) {
    const x = r.minX + WALL_MARGIN + w / 2
      + t * Math.max(0, (r.maxX - r.minX) - WALL_MARGIN * 2 - w);
    const z = r.minZ + WALL_MARGIN + d / 2;
    candidates.push({ x, z, yaw: 0,
      foot: { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 } });
    const southZ = r.maxZ - WALL_MARGIN - d / 2;
    candidates.push({ x, z: southZ, yaw: Math.PI,
      foot: { minX: x - w / 2, maxX: x + w / 2,
        minZ: southZ - d / 2, maxZ: southZ + d / 2 } });

    const sideZ = r.minZ + WALL_MARGIN + w / 2
      + t * Math.max(0, (r.maxZ - r.minZ) - WALL_MARGIN * 2 - w);
    const westX = r.minX + WALL_MARGIN + d / 2;
    candidates.push({ x: westX, z: sideZ, yaw: Math.PI / 2,
      foot: { minX: westX - d / 2, maxX: westX + d / 2,
        minZ: sideZ - w / 2, maxZ: sideZ + w / 2 } });
    const eastX = r.maxX - WALL_MARGIN - d / 2;
    candidates.push({ x: eastX, z: sideZ, yaw: -Math.PI / 2,
      foot: { minX: eastX - d / 2, maxX: eastX + d / 2,
        minZ: sideZ - w / 2, maxZ: sideZ + w / 2 } });
  }

  return candidates.find((candidate) => !blocked.some((rect) => overlaps(candidate.foot, rect)))
    ?? null;
}

/** Place the factory on a wall and reserve a clear lane for the pod doors. */
function dinosaurFactoryPlacement(r, blocked) {
  const { w, d, hatch } = DINOSAUR_FACTORY;
  const along = [0.08, 0.92, 0.25, 0.75, 0.5];
  const candidates = [];
  const add = (x, z, yaw, foot, reserve) => candidates.push({ x, z, yaw, foot, reserve });

  for (const t of along) {
    const x = r.minX + WALL_MARGIN + w / 2
      + t * Math.max(0, (r.maxX - r.minX) - WALL_MARGIN * 2 - w);
    const northZ = r.minZ + WALL_MARGIN + d / 2;
    let foot = { minX: x - w / 2, maxX: x + w / 2,
      minZ: northZ - d / 2, maxZ: northZ + d / 2 };
    add(x, northZ, 0, foot, { ...foot, maxZ: foot.maxZ + hatch });

    const southZ = r.maxZ - WALL_MARGIN - d / 2;
    foot = { minX: x - w / 2, maxX: x + w / 2,
      minZ: southZ - d / 2, maxZ: southZ + d / 2 };
    add(x, southZ, Math.PI, foot, { ...foot, minZ: foot.minZ - hatch });

    const z = r.minZ + WALL_MARGIN + w / 2
      + t * Math.max(0, (r.maxZ - r.minZ) - WALL_MARGIN * 2 - w);
    const westX = r.minX + WALL_MARGIN + d / 2;
    foot = { minX: westX - d / 2, maxX: westX + d / 2,
      minZ: z - w / 2, maxZ: z + w / 2 };
    add(westX, z, Math.PI / 2, foot, { ...foot, maxX: foot.maxX + hatch });

    const eastX = r.maxX - WALL_MARGIN - d / 2;
    foot = { minX: eastX - d / 2, maxX: eastX + d / 2,
      minZ: z - w / 2, maxZ: z + w / 2 };
    add(eastX, z, -Math.PI / 2, foot, { ...foot, minX: foot.minX - hatch });
  }

  return candidates.find((candidate) => !blocked.some((rect) => overlaps(candidate.reserve, rect)))
    ?? null;
}

/** Place one correctly oriented footprint against a requested room wall. */
function humanEnclosureCandidate(r, def, wall, slot) {
  const inset = def.inset ?? 0;
  const roomW = r.maxX - r.minX;
  const roomD = r.maxZ - r.minZ;
  let x; let z; let rot; let fw; let fd;
  if (wall === 'north' || wall === 'south') {
    fw = def.w; fd = def.d;
    x = r.minX + WALL_MARGIN + fw / 2
      + slot * Math.max(0, roomW - WALL_MARGIN * 2 - fw);
    z = wall === 'north'
      ? r.minZ + WALL_MARGIN + fd / 2 + inset
      : r.maxZ - WALL_MARGIN - fd / 2 - inset;
    rot = wall === 'north' ? 0 : Math.PI;
  } else {
    fw = def.d; fd = def.w;
    z = r.minZ + WALL_MARGIN + fd / 2
      + slot * Math.max(0, roomD - WALL_MARGIN * 2 - fd);
    x = wall === 'west'
      ? r.minX + WALL_MARGIN + fw / 2 + inset
      : r.maxX - WALL_MARGIN - fw / 2 - inset;
    rot = wall === 'west' ? Math.PI / 2 : -Math.PI / 2;
  }
  return {
    x, z, rot,
    foot: { minX: x - fw / 2, maxX: x + fw / 2, minZ: z - fd / 2, maxZ: z + fd / 2 },
  };
}

/** Lay out coherent domestic zones while preserving the central viewing aisle. */
function addHumanEnclosure(r, floorY, blocked, placed, out) {
  const w = r.maxX - r.minX;
  const d = r.maxZ - r.minZ;
  const centreClear = {
    minX: r.cx - Math.min(2.0, w * 0.16), maxX: r.cx + Math.min(2.0, w * 0.16),
    minZ: r.cz - Math.min(2.0, d * 0.16), maxZ: r.cz + Math.min(2.0, d * 0.16),
  };
  const reserved = [...blocked, centreClear];

  const walls = ['north', 'south', 'west', 'east'];
  const slots = [0.08, 0.20, 0.32, 0.44, 0.56, 0.68, 0.80, 0.92, 0.50];
  for (const def of HUMAN_ENCLOSURE_PROPS) {
    const wallOrder = [def.wall, ...walls.filter((wall) => wall !== def.wall)];
    const slotOrder = [def.slot, ...slots.filter((slot) => Math.abs(slot - def.slot) > 0.015)
      .sort((a, b) => Math.abs(a - def.slot) - Math.abs(b - def.slot))];
    let chosen = null;
    for (const wall of wallOrder) {
      for (const slot of slotOrder) {
        const candidate = humanEnclosureCandidate(r, def, wall, slot);
        if (reserved.some((rect) => overlaps(candidate.foot, rect))) continue;
        if (placed.some((rect) => overlaps(candidate.foot, rect, 0.55))) continue;
        chosen = candidate;
        break;
      }
      if (chosen) break;
    }
    if (!chosen) continue;
    placed.push(chosen.foot);
    out.push({
      type: PROP_FURNITURE,
      kind: 'human_enclosure', model: def.model, enclosureShape: def.shape,
      enclosureId: def.id, enclosureZone: def.zone, enclosureLabel: def.label,
      x: chosen.x, y: floorY, z: chosen.z,
      rot: chosen.rot, scale: 1, height: def.h,
      // Model fitting happens before the holder is quarter-turned, so retain
      // its authored axes here; the collider below is already in world axes.
      sx: def.w, sy: def.h, sz: def.d, room: r.id, storey: 0,
      collider: {
        kind: 'box', minX: chosen.foot.minX, minY: floorY, minZ: chosen.foot.minZ,
        maxX: chosen.foot.maxX, maxY: floorY + def.h, maxZ: chosen.foot.maxZ,
      },
    });
  }
}

/**
 * Furnish a planned complex.
 *
 * Density scales with room area rather than being a fixed count, so a corridor
 * gets a crate and a workshop gets a workshop. Courtyards are furnished too --
 * an empty yard is a killing field, and cover is what makes one fightable.
 *
 * Every storey is furnished, not just the ground. An upper floor with nothing
 * on it is not a quiet room, it is an unfinished one: no cover, no landmarks,
 * nothing to tell you which way you came up, and no reason to go there.
 */
export function addFurnishings(plan, out = []) {
  for (const r of plan.rooms) {
    // The steel tower, its hatch approach and the circulation lane around its
    // legs are the furnishing of this courtyard. Random crates here can block
    // the only ladder before a player has even found the landmark.
    if (r.drummerTower || r.parkour) continue;
    const levels = r.outdoor ? [r.floorY] : levelsOf(r);

    for (let storey = 0; storey < levels.length; storey++) {
      const floorY = levels[storey];
      const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
      const count = Math.max(1, Math.round((w * d) / 22));
      const maxH = r.outdoor ? OUTDOOR_MAX_H : Infinity;

      const blocked = keepOutRects(plan, r, storey);
      // Pieces already placed on this floor. Furniture that overlaps other
      // furniture is the other half of the wedged-in-a-pocket bug: two desks
      // in the same square metre make a crevice the resolver cannot push a
      // body out of, because whichever way it pushes is into the other desk.
      const placed = [];
      const salt = storey * 131;

      // One discoverable factory room owns one cloning pod. Its full machine
      // footprint is solid, while the larger reserved rectangle in front only
      // keeps random furniture out of the hatch and serving lane.
      if (!plan.arena && r.role?.id === DINOSAUR_FACTORY_ROLE && storey === 0) {
        const factory = dinosaurFactoryPlacement(r, blocked);
        if (factory) {
          const foot = factory.foot;
          placed.push(factory.reserve);
          out.push({
            type: PROP_FURNITURE,
            kind: DINOSAUR_FACTORY_KIND,
            x: factory.x, y: floorY, z: factory.z,
            rot: factory.yaw, scale: 1, height: DINOSAUR_FACTORY.h,
            sx: foot.maxX - foot.minX, sy: DINOSAUR_FACTORY.h, sz: foot.maxZ - foot.minZ,
            material: 'furniture', seed: 0.271828,
            room: r.id, storey,
            collider: {
              kind: 'box',
              minX: foot.minX, minY: floorY, minZ: foot.minZ,
              maxX: foot.maxX, maxY: floorY + DINOSAUR_FACTORY.h, maxZ: foot.maxZ,
            },
          });
        }
      }

      // One guaranteed machine, on the start room's ground floor. A duel does
      // not get it: a local healing station in an authoritative PvP mode would
      // let two clients disagree about who had consumed the shared serving.
      if (!plan.arena && r.id === plan.start && storey === 0) {
        const station = nuggetDispenserPlacement(r, blocked);
        if (station) {
          const foot = station.foot;
          placed.push(foot);
          out.push({
            type: PROP_FURNITURE,
            kind: NUGGET_DISPENSER_KIND,
            x: station.x, y: floorY, z: station.z,
            rot: station.yaw, scale: 1, height: NUGGET_DISPENSER.h,
            sx: foot.maxX - foot.minX, sy: NUGGET_DISPENSER.h, sz: foot.maxZ - foot.minZ,
            material: 'furniture', seed: 0.618,
            room: r.id, storey,
            collider: {
              kind: 'box',
              minX: foot.minX, minY: floorY, minZ: foot.minZ,
              maxX: foot.maxX, maxY: floorY + NUGGET_DISPENSER.h, maxZ: foot.maxZ,
            },
          });
        }
      }

      // The first room is an onboarding space, not a storage room. It already
      // has the nugget machine and the green spaceport airlock as deliberate
      // landmarks; rolling another table, drum or crate here both obscures the
      // route out and makes the guaranteed dispenser look like random clutter.
      // Upper storeys (when present) are still furnished normally.
      if (!plan.arena && r.id === plan.start && storey === 0) continue;

      // HUMAN OBSERVATION is curated rather than randomly furnished. Every
      // object is an installed textured model and every one describes a need a
      // fish might infer humans have: sleep, medicine, tools, light, storage,
      // transport, climate and enrichment.
      if (!plan.arena && r.role?.id === REVERSE_AQUARIUM_ROLE && storey === 0) {
        addHumanEnclosure(r, floorY, blocked, placed, out);
        continue;
      }

      for (let i = 0; i < count; i++) {
        // Several attempts per slot rather than one. A single try that lands on
        // a doorway used to mean one fewer piece in the room, so the more
        // cluttered the layout the emptier it got.
        for (let attempt = 0; attempt < 6; attempt++) {
          const seed = i * 3 + attempt * 97 + salt;
          const r1 = rand2(seed + 1, r.id * 17 + 2, 91);
          const r2 = rand2(seed + 2, r.id * 19 + 3, 92);
          const r3 = rand2(seed + 3, r.id * 23 + 5, 93);

          const def = pickFurniture(r3, maxH);
          if (!def) break;
          const along = r3 > 0.5;
          const fw = along ? def.w : def.d;
          const fd = along ? def.d : def.w;
          if (fw + WALL_MARGIN * 2 > w || fd + WALL_MARGIN * 2 > d) break;

          const x = r.minX + WALL_MARGIN + r1 * (w - WALL_MARGIN * 2 - fw);
          const z = r.minZ + WALL_MARGIN + r2 * (d - WALL_MARGIN * 2 - fd);
          const foot = { minX: x, maxX: x + fw, minZ: z, maxZ: z + fd };

          if (blocked.some((b) => overlaps(foot, b))) continue;
          // A body is 0.64 across; 0.9 between two pieces is a gap you can walk
          // through rather than one you get caught in.
          if (placed.some((p) => overlaps(foot, p, 0.9))) continue;
          placed.push(foot);

          // Every so often, a drum instead -- round cover, and the only
          // cylinder collider indoors.
          if (r3 > 0.86) {
            const cx = x + fw / 2, cz = z + fd / 2;
            out.push({
              type: PROP_BARREL,
              x: cx, y: floorY, z: cz,
              rot: r1 * Math.PI * 2, scale: 1, height: DRUM.h, seed: r3,
              // Art fitted to the collider below. Three drums rather than one,
              // because a store room is a row of them and a row of one mesh at
              // one rotation reads as wallpaper.
              sx: DRUM.r * 2, sy: DRUM.h, sz: DRUM.r * 2,
              // Keyed on r1, not r3: r3 is the roll that *gated* this placement
              // (r3 > 0.86), so using it again picks the same drum every time --
              // 73 barrels, all barrel_03.
              model: BARREL_MODELS[Math.floor(r1 * BARREL_MODELS.length) % BARREL_MODELS.length],
              room: r.id, storey,
              collider: {
                kind: 'cylinder', x: cx, z: cz, r: DRUM.r,
                y0: floorY, y1: floorY + DRUM.h,
              },
            });
            break;
          }

          // A low crate now and then: something to vault, and something to
          // stand on.
          if (r3 > 0.72) {
            const sz2 = 0.75 + r1 * 0.35;
            out.push({
              type: PROP_CRATE,
              x: x + sz2 / 2, y: floorY, z: z + sz2 / 2,
              rot: r2 * Math.PI * 2, scale: sz2, height: sz2, seed: r3,
              sx: sz2, sy: sz2, sz: sz2,
              // The scanned military crate is 21k triangles across ten meshes;
              // the wooden box is 324 across one. At 83 crates a map, making the
              // scan the common case would cost roughly 880k triangles and 420
              // draw calls for scenery nobody looks at twice. So it is the rare
              // one -- close enough to notice, seldom enough to afford.
              model: r1 < 0.2 ? 'old_military_crate' : 'kit_woodenbox',
              room: r.id, storey,
              collider: {
                kind: 'box',
                minX: x, minY: floorY, minZ: z,
                maxX: x + sz2, maxY: floorY + sz2, maxZ: z + sz2,
              },
            });
            break;
          }

          out.push({
            type: PROP_FURNITURE,
            x: x + fw / 2, y: floorY, z: z + fd / 2,
            rot: 0, scale: 1, height: def.h,
            sx: fw, sy: def.h, sz: fd,
            kind: def.kind, material: 'furniture', seed: r3,
            room: r.id, storey,
            collider: {
              kind: 'box',
              minX: x, minY: floorY, minZ: z,
              maxX: x + fw, maxY: floorY + def.h, maxZ: z + fd,
            },
          });
          break;
        }
      }
    }
  }
  return out;
}
