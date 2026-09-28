// Loadouts: what you bring to a versus match.
//
// Co-op hands you a pistol and makes you earn everything else. That is the
// whole co-op loop -- killing pays, doors open freely, and the gun you are holding on
// wave nine is a record of how the run went. It is also completely wrong for a
// match against another player, for one reason: the player who found the
// railgun first wins, and finding it was luck. A duel decided by a box roll is
// not a duel.
//
// So a versus player picks a loadout before the match and respawns with it
// intact, every time, for the whole match. Nothing on the map upgrades you. The
// map hands out position; the loadout hands out equipment; and the only
// variable left between two players is which of them is better.
//
// Balance note: these are deliberately NOT "the best guns". Every set is one
// primary, one sidearm and the pickaxe, and each primary is strong at exactly
// one range and bad outside it -- which is what makes the map's three lanes
// mean something. A set that was good everywhere would make the street the
// only lane worth walking.

import { WEAPONS } from './weapons.js';

/**
 * The picks.
 *
 * `primary` is what the player spawns holding. `sidearm` is the fallback, and
 * every set gets the pickaxe because it is the mining tool as well as a melee
 * weapon -- a player who cannot break a board is a player who can be sealed in.
 *
 * Ammo is `full`: the primary's magazine plus its normal reserve. Respawning
 * with a partial magazine punishes the player who just lost a fight twice.
 */
export const LOADOUTS = [
  {
    id: 'ranger',
    name: 'RANGER',
    blurb: 'Rifle and pistol. Good on the street, fine anywhere.',
    primary: 'rifle',
    sidearm: 'pistol',
  },
  {
    id: 'raider',
    name: 'RAIDER',
    blurb: 'SMG and pistol. Owns the houses, loses the street.',
    primary: 'smg',
    sidearm: 'pistol',
  },
  {
    id: 'breacher',
    name: 'BREACHER',
    blurb: 'Shotgun and deagle. One room, one direction, no argument.',
    primary: 'shotgun',
    sidearm: 'deagle',
  },
  {
    id: 'overwatch',
    name: 'OVERWATCH',
    blurb: 'Sniper and SMG. Holds a window; dies in a doorway.',
    primary: 'sniper',
    sidearm: 'microsmg',
  },
];

/** Everything a loadout grants, melee included. */
export const LOADOUT_MELEE = 'pickaxe';

export const DEFAULT_LOADOUT = LOADOUTS[0].id;

/** Look one up by id, falling back to the default rather than throwing. */
export function loadoutById(id) {
  return LOADOUTS.find((l) => l.id === id) ?? LOADOUTS[0];
}

/**
 * The weapon ids a loadout grants, primary first.
 *
 * Order matters: the caller draws the first one, so a Breacher spawns holding
 * the shotgun rather than whichever weapon happens to sit in the lowest slot.
 */
export function loadoutWeapons(id) {
  const l = loadoutById(id);
  return [l.primary, l.sidearm, LOADOUT_MELEE];
}

/**
 * Validate the table against the weapon list.
 *
 * Called by the tests rather than at import time. A loadout naming a weapon
 * that has been renamed or removed would otherwise fail silently as a player
 * who spawns holding nothing, which is the kind of bug that only shows up in a
 * live match.
 *
 * @returns array of human-readable problems; empty means the table is sound
 */
export function validateLoadouts() {
  const problems = [];
  const byId = new Map(WEAPONS.map((w) => [w.id, w]));
  for (const l of LOADOUTS) {
    for (const [role, wid] of [['primary', l.primary], ['sidearm', l.sidearm]]) {
      const def = byId.get(wid);
      if (!def) { problems.push(`${l.id}: ${role} "${wid}" is not a weapon`); continue; }
      if (def.melee) problems.push(`${l.id}: ${role} "${wid}" is a melee weapon`);
    }
    if (l.primary === l.sidearm) problems.push(`${l.id}: primary and sidearm are both "${l.primary}"`);
  }
  if (!byId.has(LOADOUT_MELEE)) problems.push(`melee "${LOADOUT_MELEE}" is not a weapon`);
  const ids = LOADOUTS.map((l) => l.id);
  if (new Set(ids).size !== ids.length) problems.push('duplicate loadout ids');
  return problems;
}
