// Zones and the doors between them.
//
// The map is not one open arena you are dropped into. It is a set of rooms:
// you start in one small room with a pistol, and every other space is behind a
// door that is free to open. What is on the other side gets better the further
// out you explore.
//
// A zone is a rectangle. Doors sit on the boundary between two of them and
// carry a collider that is removed when opened, so an unopened door blocks
// movement and bullets exactly as a wall does.

export const PROP_DOOR = 'door';

/**
 * Tier drives the reward pool. Door prices intentionally stay at zero.
 */
export const TIERS = [
  { tier: 0, price: 0, label: 'START' },
  { tier: 1, price: 0, label: 'SECURED' },
  { tier: 2, price: 0, label: 'RESTRICTED' },
  { tier: 3, price: 0, label: 'HAZARD' },
  { tier: 4, price: 0, label: 'VAULT' },
];

/** Weapons that can be found in a zone of each tier, best last. */
export const TIER_WEAPONS = [
  ['pistol'],
  ['smg', 'microsmg', 'shotgun'],
  ['rifle', 'deagle', 'knife'],
  ['sniper', 'laser', 'bazooka'],
  ['minigun', 'railgun', 'golfclub'],
];

/**
 * Build the zone graph over a set of buildings.
 *
 * Zones are the buildings themselves plus the open ground, ordered by distance
 * from the start room so tiers rise as the player pushes outward. The start
 * room is the ground floor of the building nearest the centre -- small,
 * enclosed, and somewhere the first wave cannot surround you.
 *
 * @param sites building footprints from World
 * @param size  arena size
 */
export function buildZones(sites, size) {
  if (!sites.length) return { zones: [], doors: [], start: null };

  const cx = size / 2, cz = size / 2;
  const centre = (b) => ({ x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 });

  // Nearest building to the middle is where the run begins.
  const ordered = [...sites].sort((a, b) => {
    const ca = centre(a), cb = centre(b);
    return Math.hypot(ca.x - cx, ca.z - cz) - Math.hypot(cb.x - cx, cb.z - cz);
  });

  const zones = ordered.map((b, i) => {
    const c = centre(b);
    // Tier by rank, capped: with seven buildings the far ones share the top.
    const tier = Math.min(TIERS.length - 1, i === 0 ? 0 : Math.ceil(i / 2));
    return {
      id: i,
      site: b,
      x: c.x, z: c.z,
      tier,
      // The yard is opened by the first door out of the start room, so the
      // player is never sealed in with nothing to shoot.
      open: i === 0,
      label: TIERS[tier].label,
    };
  });

  // Doors: each zone is entered from the nearest earlier zone, which
  // gives a spanning tree rather than a ring. A tree means every zone has
  // exactly one authored entry route while keeping every door free.
  const doors = [];
  for (let i = 1; i < zones.length; i++) {
    const z = zones[i];
    let bestJ = 0, bestD = Infinity;
    for (let j = 0; j < i; j++) {
      const d = Math.hypot(zones[j].x - z.x, zones[j].z - z.z);
      if (d < bestD) { bestD = d; bestJ = j; }
    }
    doors.push({
      id: doors.length,
      from: bestJ,
      to: i,
      price: 0,
      opened: false,
    });
  }

  return { zones, doors, start: zones[0] };
}

/** Which zone a point falls in, or -1 for the open ground between them. */
export function zoneAt(zones, x, z) {
  for (const zn of zones) {
    const b = zn.site;
    if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return zn.id;
  }
  return -1;
}
