// Weapon definitions and the state machine that drives them.
//
// The system owns timing (fire rate, reload, switch), ammo, and the accuracy
// model. It does not resolve hits -- it hands out shot directions and combat.js
// traces them. Keeping those apart means the same weapon data would work
// unchanged for a projectile weapon or a server-authoritative trace.
//
// Accuracy model: every shot leaves the muzzle inside a cone whose half-angle is
//   base + bloom + movement penalty + airborne penalty
// Bloom grows per shot and decays over time, so tapping stays accurate and
// holding the trigger does not.
//
// Aim down sights: every weapon declares an `ads` block. `adsSight` picks which
// overlay the HUD draws. 'iron' means the viewmodel itself carries the sight
// picture, including red dots and holographics. Only true magnified/special
// optics use a HUD overlay: 'scope', 'thermal', and the bazooka ranging sight.
// adsTime is deliberately short everywhere: raising the sights is the input the
// player feels most directly, so it is tuned for response, not for weight.
//
// Melee weapons set `melee: true` and are resolved by an arc sweep rather than a
// hitscan cone (see combat.js). They also set `noAmmo`, which is what makes them
// never empty and never reloadable.
//
// A slot is a key on the number row and the keys to its right. Slots are handed
// out on pickup rather than baked into the weapon: the first gun you carry
// answers to 1, the second to 2, and so on along the row.
//
// Fixed per-weapon slots made the row mostly holes. The rifle was always 4
// whether or not you had ever found one, so a run carrying three guns spread
// them over 2, 7 and 14 with nothing in between, and the weapons you actually
// had were the ones furthest from your fingers. Assigning on pickup keeps the
// carried set packed against the left of the row, where the easy keys are.
//
// A slot is held for the rest of the run once assigned. Re-packing the row
// after every pickup would look tidier and play far worse, because the key that
// draws your shotgun would move whenever you found something else.

export const FIRE_AUTO = 'auto';
export const FIRE_SEMI = 'semi';

/**
 * How many slots the row offers, and so how many weapons can be drawn by key.
 *
 * There are exactly as many slots as weapons, so a run that somehow found every
 * gun still has a key for each. Keep this in step with the `slot*` bindings in
 * engine/bindings.js.
 */
export const SLOT_COUNT = 17;

/**
 * Rarity tiers.
 *
 * Rarity used to be a single `legendary` boolean, which gave the game exactly
 * two rungs: gold, or nothing. Eleven of fifteen weapons sat on the same rung,
 * so a box roll could hand you a shotgun or a railgun with no way to tell at a
 * glance which one you had earned.
 *
 * Tier is now the one place rarity is decided, and three things read it: the
 * colour a weapon's name is drawn in, the mystery box's odds, and what the box
 * shouts on a reveal. `boxWeight` is the pull weight every entry of that tier
 * gets, so the odds follow from the ladder instead of being hand-typed per gun
 * and quietly drifting away from it.
 *
 * Tier is assigned by what a weapon is worth to a run, NOT by raw DPS. Two of
 * the legendaries look weak on a DPS table and are not: the railgun pierces
 * every enemy in a line at 400m, so its damage multiplies by however many are
 * lined up, and the golf club trades damage for knockback, reach and arc --
 * crowd control the knife cannot do at any rate of fire.
 */
export const TIER = {
  COMMON: 0,
  UNCOMMON: 1,
  RARE: 2,
  EPIC: 3,
  LEGENDARY: 4,
};

export const TIERS = [
  { id: 'common', name: 'COMMON', css: '#b6bfc7', hex: 0xb6bfc7, boxWeight: 20 },
  { id: 'uncommon', name: 'UNCOMMON', css: '#6fe08a', hex: 0x6fe08a, boxWeight: 14 },
  { id: 'rare', name: 'RARE', css: '#4db6ff', hex: 0x4db6ff, boxWeight: 9 },
  { id: 'epic', name: 'EPIC', css: '#c084fc', hex: 0xc084fc, boxWeight: 5 },
  { id: 'legendary', name: 'LEGENDARY', css: '#ffd24a', hex: 0xffd24a, boxWeight: 3 },
];

/** The tier record for a weapon def. Anything untiered reads as common. */
export function tierOf(def) {
  return TIERS[def?.tier ?? TIER.COMMON] ?? TIERS[TIER.COMMON];
}

/** Top of the ladder. Kept as a helper so call sites never compare numbers. */
export function isLegendary(def) { return (def?.tier ?? TIER.COMMON) === TIER.LEGENDARY; }

const DEG = Math.PI / 180;

/**
 * Shared melee defaults. A swing has no cone, no bloom and no falloff -- it
 * either reaches or it does not -- so the accuracy fields exist only to satisfy
 * code that reads them unconditionally.
 */
const MELEE_BASE = {
  melee: true,
  noAmmo: true,
  ads: false,
  pellets: 1,
  magSize: 1,
  reserveMax: 0,
  startReserve: 0,
  reloadTime: 0.4,
  falloffMin: 1,
  spreadBase: 0, spreadMoving: 0, spreadAir: 0,
  bloomPerShot: 0, bloomMax: 0, bloomDecay: 0,
};

export const WEAPONS = [
  {
    ...MELEE_BASE,
    id: 'pickaxe',
    name: 'PICKAXE',
    tier: TIER.COMMON,
    fireMode: FIRE_SEMI,
    damage: 42,
    headshotMultiplier: 1.6,
    rpm: 115,              // swing rate
    range: 3.4,
    falloffStart: 4, falloffEnd: 5,
    // Reaches wide, because a tool you have to line up perfectly is a tool you
    // stop using the moment a zombie is inside your hitbox.
    swingArc: 32 * DEG,
    // The one weapon that also digs. A pickaxe in a voxel arena that cannot
    // touch the voxels would be a strange thing to hand the player.
    mining: true,
    miningRange: 4.5,
    recoilPitch: 0.5 * DEG,
    recoilYaw: 0.2 * DEG,
    kick: 0.05,
    switchTime: 0.26,
    audio: 'swing',
  },
  {
    ...MELEE_BASE,
    id: 'knife',
    name: 'KNIFE',
    tier: TIER.UNCOMMON,
    unlockable: true,
    fireMode: FIRE_SEMI,
    damage: 58,
    headshotMultiplier: 3.0,   // a knife to the head is the whole point
    rpm: 170,
    range: 2.8,
    falloffStart: 3, falloffEnd: 4,
    swingArc: 26 * DEG,
    recoilPitch: 0.3 * DEG,
    recoilYaw: 0.15 * DEG,
    kick: 0.03,
    switchTime: 0.18,          // fastest thing in the game to bring up
    audio: 'stab',
  },
  {
    ...MELEE_BASE,
    id: 'golfclub',
    name: 'GOLF CLUB',
    tier: TIER.LEGENDARY,
    unlockable: true,
    fireMode: FIRE_SEMI,
    damage: 135,
    headshotMultiplier: 2.0,
    rpm: 58,                   // a full backswing takes a moment
    range: 4.0,
    falloffStart: 5, falloffEnd: 6,
    swingArc: 36 * DEG,
    // Sends them flying. This is the joke, and the joke is the reason to carry it.
    knockback: 19,
    knockbackUp: 9,
    recoilPitch: 1.4 * DEG,
    recoilYaw: 0.5 * DEG,
    kick: 0.14,
    switchTime: 0.42,
    audio: 'golf',
  },
  {
    id: 'pistol',
    name: 'PISTOL',
    tier: TIER.COMMON,
    fireMode: FIRE_SEMI,
    damage: 28,
    pellets: 1,
    headshotMultiplier: 2.2,
    rpm: 420,
    magSize: 15,
    reserveMax: 120,
    startReserve: 90,
    reloadTime: 1.25,
    range: 110,
    // Damage tapers between these ranges down to falloffMin of base damage.
    falloffStart: 30,
    falloffEnd: 75,
    falloffMin: 0.55,
    spreadBase: 0.35 * DEG,
    spreadMoving: 1.6 * DEG,
    spreadAir: 3.5 * DEG,
    bloomPerShot: 0.55 * DEG,
    bloomMax: 3.2 * DEG,
    bloomDecay: 5.0 * DEG,
    recoilPitch: 0.9 * DEG,
    recoilYaw: 0.32 * DEG,
    kick: 0.028,
    switchTime: 0.32,
    audio: 'pistol',
    // --- iron sights ---
    ads: true,
    adsSight: 'iron',
    adsFov: 64,
    adsSpread: 0.10 * DEG,
    adsMoveSpread: 0.7 * DEG,
    adsBloom: 0.5,          // aiming halves the bloom penalty, it does not erase it
    adsTime: 0.07,          // lightest gun, fastest to bring up
    adsSensitivity: 0.88,
  },
  {
    id: 'deagle',
    name: 'HAND CANNON',
    tier: TIER.LEGENDARY,
    unlockable: true,
    pickupAmmo: 35,
    fireMode: FIRE_SEMI,
    damage: 98,               // two body shots on anything short of a brute
    pellets: 1,
    headshotMultiplier: 2.6,
    rpm: 175,
    magSize: 7,
    reserveMax: 56,
    startReserve: 0,
    reloadTime: 1.85,
    range: 150,
    falloffStart: 55,
    falloffEnd: 110,
    falloffMin: 0.7,
    spreadBase: 0.5 * DEG,
    spreadMoving: 2.4 * DEG,
    spreadAir: 5.0 * DEG,
    bloomPerShot: 1.4 * DEG,
    bloomMax: 5.5 * DEG,
    bloomDecay: 5.5 * DEG,
    recoilPitch: 3.2 * DEG,   // wrist-breaking, on purpose
    recoilYaw: 0.7 * DEG,
    kick: 0.12,
    switchTime: 0.4,
    audio: 'deagle',
    // --- red dot mounted on the model ---
    ads: true,
    adsSight: 'iron',
    adsFov: 60,
    adsSpread: 0.06 * DEG,
    adsMoveSpread: 0.9 * DEG,
    adsBloom: 0.4,
    adsTime: 0.09,
    adsSensitivity: 0.8,
  },
  {
    id: 'smg',
    name: 'SMG',
    tier: TIER.UNCOMMON,
    unlockable: true,
    pickupAmmo: 150,
    fireMode: FIRE_AUTO,
    damage: 16,
    pellets: 1,
    headshotMultiplier: 1.8,
    rpm: 860,
    magSize: 32,
    reserveMax: 288,
    startReserve: 0,
    reloadTime: 1.75,
    range: 95,
    // Falls off hard past a room's width -- this is the close-quarters answer
    // that still has to lose to the rifle at distance.
    falloffStart: 22,
    falloffEnd: 58,
    falloffMin: 0.45,
    spreadBase: 0.55 * DEG,
    spreadMoving: 1.5 * DEG,
    spreadAir: 3.8 * DEG,
    bloomPerShot: 0.34 * DEG,
    bloomMax: 5.2 * DEG,
    bloomDecay: 7.5 * DEG,
    recoilPitch: 0.44 * DEG,
    recoilYaw: 0.3 * DEG,
    kick: 0.017,
    switchTime: 0.34,
    audio: 'smg',
    // --- holographic sight mounted on the model ---
    ads: true,
    adsSight: 'iron',
    adsFov: 66,
    adsSpread: 0.14 * DEG,
    adsMoveSpread: 0.8 * DEG,
    adsBloom: 0.6,
    adsTime: 0.07,
    adsSensitivity: 0.9,
  },
  {
    id: 'microsmg',
    name: 'MICRO SMG',
    tier: TIER.RARE,
    unlockable: true,
    pickupAmmo: 180,
    fireMode: FIRE_AUTO,
    damage: 12,
    pellets: 1,
    headshotMultiplier: 1.6,
    rpm: 1150,              // fastest conventional gun in the game
    magSize: 40,
    reserveMax: 320,
    startReserve: 0,
    reloadTime: 1.6,
    range: 70,
    falloffStart: 14,
    falloffEnd: 42,
    falloffMin: 0.4,
    // Sprays wildly from the hip; the laser is what makes it usable.
    spreadBase: 1.4 * DEG,
    spreadMoving: 2.2 * DEG,
    spreadAir: 4.5 * DEG,
    bloomPerShot: 0.3 * DEG,
    bloomMax: 6.5 * DEG,
    bloomDecay: 8.5 * DEG,
    recoilPitch: 0.3 * DEG,
    recoilYaw: 0.42 * DEG,
    kick: 0.012,
    switchTime: 0.28,
    audio: 'smg',
    // --- laser-assisted irons, mounted on the model ---
    ads: true,
    adsSight: 'iron',
    adsFov: 70,             // barely zooms; the laser is the upgrade, not magnification
    adsSpread: 0.3 * DEG,
    adsMoveSpread: 1.0 * DEG,
    adsBloom: 0.65,
    adsTime: 0.06,          // ties the knife for the fastest thing to raise
    adsSensitivity: 0.94,
  },
  {
    id: 'rifle',
    name: 'RIFLE',
    tier: TIER.RARE,
    // Found, not issued -- the player starts with a pistol and a pickaxe.
    unlockable: true,
    pickupAmmo: 120,
    fireMode: FIRE_AUTO,
    damage: 21,
    pellets: 1,
    headshotMultiplier: 2.0,
    rpm: 700,
    magSize: 30,
    reserveMax: 240,
    startReserve: 180,
    reloadTime: 2.05,
    range: 140,
    falloffStart: 45,
    falloffEnd: 100,
    falloffMin: 0.6,
    spreadBase: 0.3 * DEG,
    spreadMoving: 2.0 * DEG,
    spreadAir: 4.5 * DEG,
    bloomPerShot: 0.42 * DEG,
    bloomMax: 4.6 * DEG,
    bloomDecay: 6.5 * DEG,
    recoilPitch: 0.62 * DEG,
    recoilYaw: 0.26 * DEG,
    kick: 0.022,
    switchTime: 0.45,
    audio: 'rifle',
    // --- compact magnified optic ---
    // The real PSO-derived scope mounted by weaponmodels.js replaces the bare
    // carry-handle view. It is a low-power rifle optic, not the sniper's 8×:
    // enough zoom to make the glass meaningful without turning an automatic
    // rifle into a long-range bolt gun.
    ads: true,
    adsSight: 'scope',
    adsFov: 48,
    adsSpread: 0.08 * DEG,
    adsMoveSpread: 0.85 * DEG,
    // Keeps spray control meaningful: holding the trigger while aimed still
    // opens the cone, so the aimed rifle is not a strict upgrade to hip fire.
    adsBloom: 0.55,
    adsTime: 0.08,
    adsSensitivity: 0.85,
  },
  {
    id: 'laser',
    name: 'PULSE LASER',
    tier: TIER.EPIC,
    unlockable: true,
    pickupAmmo: 180,
    fireMode: FIRE_AUTO,
    damage: 20,
    pellets: 1,
    headshotMultiplier: 1.9,
    rpm: 620,
    magSize: 60,            // cells, not rounds
    reserveMax: 300,
    startReserve: 0,
    reloadTime: 2.2,        // swapping a cell is slow
    range: 190,
    // Light does not care how far it went. No falloff at all is the whole
    // identity of this gun, and it is what makes it worth its slow reload.
    falloffStart: 190,
    falloffEnd: 191,
    falloffMin: 1,
    spreadBase: 0.12 * DEG, // beams do not wander
    spreadMoving: 1.1 * DEG,
    spreadAir: 2.2 * DEG,
    bloomPerShot: 0.22 * DEG,
    bloomMax: 2.4 * DEG,
    bloomDecay: 5.5 * DEG,
    recoilPitch: 0.2 * DEG, // no recoiling mass, so almost no climb
    recoilYaw: 0.12 * DEG,
    kick: 0.009,
    switchTime: 0.42,
    audio: 'laser',
    beamColor: 0x4fd8ff,    // tracer + muzzle flash tint
    // --- energy holo sight mounted on the model ---
    ads: true,
    adsSight: 'iron',
    adsHoloColor: 'cyan',
    adsFov: 60,
    adsSpread: 0.02 * DEG,
    adsMoveSpread: 0.5 * DEG,
    adsBloom: 0.4,
    adsTime: 0.09,
    adsSensitivity: 0.82,
  },
  {
    id: 'minigun',
    name: 'MINIGUN',
    tier: TIER.LEGENDARY,
    unlockable: true,
    pickupAmmo: 300,
    fireMode: FIRE_AUTO,
    damage: 15,
    pellets: 1,
    headshotMultiplier: 1.5,
    rpm: 1500,
    magSize: 150,
    reserveMax: 600,
    startReserve: 0,
    reloadTime: 4.5,        // you do not want to run this dry
    range: 120,
    falloffStart: 35,
    falloffEnd: 90,
    falloffMin: 0.5,
    spreadBase: 1.1 * DEG,
    spreadMoving: 1.8 * DEG,
    spreadAir: 4.0 * DEG,
    bloomPerShot: 0.12 * DEG,
    bloomMax: 4.0 * DEG,
    bloomDecay: 5.0 * DEG,
    recoilPitch: 0.16 * DEG,
    recoilYaw: 0.5 * DEG,
    kick: 0.02,
    switchTime: 0.85,       // heaviest thing to bring up
    audio: 'minigun',
    // Barrels have to wind up before the first round leaves.
    spinUp: 0.55,
    // Carrying it slows you down; that is the price of 1500rpm.
    moveScale: 0.72,
    // --- iron ---
    ads: true,
    adsSight: 'iron',
    adsFov: 68,
    adsSpread: 0.7 * DEG,
    adsMoveSpread: 1.2 * DEG,
    adsBloom: 0.5,
    adsTime: 0.12,
    adsSensitivity: 0.85,
  },
  {
    id: 'shotgun',
    name: 'SHOTGUN',
    tier: TIER.UNCOMMON,
    unlockable: true,
    pickupAmmo: 30,
    fireMode: FIRE_SEMI,
    damage: 13,
    pellets: 9,
    headshotMultiplier: 1.5,
    rpm: 75,
    magSize: 6,
    reserveMax: 48,
    startReserve: 36,
    reloadTime: 2.6,
    range: 45,
    // Pellets bleed damage fast; this is the close-range answer.
    falloffStart: 8,
    falloffEnd: 26,
    falloffMin: 0.25,
    spreadBase: 4.2 * DEG,
    spreadMoving: 1.2 * DEG,
    spreadAir: 2.5 * DEG,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomDecay: 0,
    recoilPitch: 3.4 * DEG,
    recoilYaw: 0.5 * DEG,
    kick: 0.11,
    switchTime: 0.55,
    audio: 'shotgun',
    // --- bead sight ---
    // Aiming chokes the pattern rather than closing it: a pinpoint shotgun
    // would just be a worse rifle.
    ads: true,
    adsSight: 'iron',
    adsFov: 68,
    adsSpread: 2.6 * DEG,
    adsMoveSpread: 0.8 * DEG,
    adsBloom: 0,
    adsTime: 0.09,
    adsSensitivity: 0.92,
  },
  {
    id: 'sniper',
    name: 'INTERVENTION',
    tier: TIER.RARE,
    unlockable: true,
    pickupAmmo: 25,
    fireMode: FIRE_SEMI,
    damage: 115,              // body shot leaves a grunt dead, a brute hurting
    pellets: 1,
    headshotMultiplier: 2.5,  // headshot one-shots everything but a brute
    rpm: 48,                  // bolt action
    magSize: 5,
    reserveMax: 60,
    startReserve: 35,
    reloadTime: 2.6,
    range: 260,
    // Barely any falloff -- reaching across the arena is the whole point.
    falloffStart: 150,
    falloffEnd: 260,
    falloffMin: 0.85,
    // A body does not stop this round. Two more targets behind the first take
    // it, each for a third less than the one in front, which turns a lined-up
    // horde into the shot worth waiting for and rewards holding an angle down
    // a corridor over panicking at the nearest thing.
    pierce: 2,
    pierceFalloff: 0.66,
    // Punishing when fired from the hip; near-perfect when scoped.
    spreadBase: 2.6 * DEG,
    spreadMoving: 3.2 * DEG,
    spreadAir: 6.0 * DEG,
    bloomPerShot: 1.2 * DEG,
    bloomMax: 5.0 * DEG,
    bloomDecay: 4.0 * DEG,
    recoilPitch: 3.0 * DEG,
    recoilYaw: 0.35 * DEG,
    kick: 0.1,
    switchTime: 0.6,
    audio: 'sniper',
    // --- scope ---
    ads: true,
    adsSight: 'scope',
    adsFov: 18,
    adsSpread: 0.02 * DEG,     // effectively pinpoint while scoped
    adsMoveSpread: 0.9 * DEG,
    adsBloom: 0,               // bolt action; there is no spray to punish
    adsTime: 0.10,
    adsSensitivity: 0.32,      // slower aim to match the magnification
  },
  {
    id: 'railgun',
    name: 'RAILGUN',
    tier: TIER.LEGENDARY,
    unlockable: true,
    pickupAmmo: 16,
    fireMode: FIRE_SEMI,
    damage: 250,
    pellets: 1,
    headshotMultiplier: 2.0,   // it hardly matters; the body shot already kills
    rpm: 35,
    magSize: 4,
    reserveMax: 32,
    startReserve: 0,
    reloadTime: 3.1,
    range: 400,                // reaches clean across the arena and out of it
    falloffStart: 400,
    falloffEnd: 401,
    falloffMin: 1,
    // Punches straight through everything it hits, enemies included.
    pierce: true,
    beamColor: 0xc08cff,
    spreadBase: 1.8 * DEG,     // unusable from the hip
    spreadMoving: 3.0 * DEG,
    spreadAir: 5.5 * DEG,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomDecay: 0,
    recoilPitch: 4.0 * DEG,
    recoilYaw: 0.4 * DEG,
    kick: 0.16,
    switchTime: 0.7,
    audio: 'railgun',
    // --- thermal scope ---
    ads: true,
    adsSight: 'thermal',
    adsFov: 26,
    adsSpread: 0,              // literally perfect when scoped
    adsMoveSpread: 0.7 * DEG,
    adsBloom: 0,
    adsTime: 0.11,
    adsSensitivity: 0.4,
  },
  {
    id: 'portalgun',
    name: 'PORTAL GUN',
    tier: TIER.LEGENDARY,
    // A traversal tool, carried from the start and never ammo-gated. Primary
    // places blue; the existing secondary-fire/ADS binding places orange.
    portal: true,
    alternateFire: true,
    noAmmo: true,
    fireMode: FIRE_SEMI,
    damage: 0,
    pellets: 1,
    headshotMultiplier: 1,
    rpm: 240,
    magSize: 1,
    reserveMax: 0,
    startReserve: 0,
    reloadTime: 0,
    range: 120,
    falloffStart: 120,
    falloffEnd: 121,
    falloffMin: 1,
    spreadBase: 0,
    spreadMoving: 0,
    spreadAir: 0,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomDecay: 0,
    recoilPitch: 0.18 * DEG,
    recoilYaw: 0,
    kick: 0.025,
    switchTime: 0.38,
    audio: 'laser',
    // Secondary fire is the orange aperture, not an aim mode.
    ads: false,
  },
  {
    id: 'flamethrower',
    name: 'FLAMETHROWER',
    tier: TIER.LEGENDARY,
    unlockable: true,
    // The rarest thing in the game, and the only way to get one is off a body.
    // It is not in the box and not in the armoury: a weapon you cannot buy is
    // a weapon that means something when it falls.
    dropOnly: true,
    pickupAmmo: 120,
    fireMode: FIRE_AUTO,
    // A cone of burning fuel, built out of the hitscan machinery every other
    // gun uses: a wall of low-damage pellets at a very high rate, thrown wide
    // and dying completely at conversational range. That reads as flame and
    // behaves as flame -- devastating in a doorway, useless across a yard --
    // without a particle simulation deciding who takes damage.
    damage: 7,
    pellets: 3,
    // Fire does not care where it lands on you.
    headshotMultiplier: 1,
    rpm: 700,
    magSize: 100,           // fuel, not rounds
    reserveMax: 300,
    startReserve: 0,
    reloadTime: 3.4,        // changing a fuel tank is not a magazine swap
    range: 13,
    // Falls off a cliff, and to nothing. The whole balance of the gun is that
    // it deletes a room and cannot touch the next one.
    falloffStart: 6,
    falloffEnd: 13,
    falloffMin: 0.12,
    spreadBase: 7.5 * DEG,  // a cone, not a group
    spreadMoving: 1.0 * DEG,
    spreadAir: 1.4 * DEG,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomDecay: 0,
    // Almost no climb: the recoil of a flamethrower is the fuel pump.
    recoilPitch: 0.35 * DEG,
    recoilYaw: 0.28 * DEG,
    kick: 0.02,
    switchTime: 0.62,
    audio: 'flamethrower',
    beamColor: 0xff7a1e,
    // --- choke ---
    // Bringing it up does not aim it -- there is nothing to aim at this range.
    // It chokes the jet: a tighter, longer tongue of fire instead of a wide
    // wash, which is the difference between clearing a doorway and clearing a
    // room. The same trade the shotgun's bead makes, and for the same reason.
    ads: true,
    adsSight: 'iron',
    adsFov: 70,
    adsSpread: 3.2 * DEG,
    adsMoveSpread: 0.6 * DEG,
    adsBloom: 0,
    adsTime: 0.1,
    adsSensitivity: 0.95,
  },
  {
    id: 'bazooka',
    name: 'BAZOOKA',
    tier: TIER.EPIC,
    // Rare drop only -- the player does not start with this.
    unlockable: true,
    projectile: true,
    fireMode: FIRE_SEMI,
    damage: 0,            // all of its damage is splash
    pellets: 1,
    headshotMultiplier: 1,
    splashRadius: 7.5,
    splashDamage: 220,
    selfDamage: 0.45,
    rpm: 50,
    magSize: 1,
    reserveMax: 12,
    startReserve: 0,
    pickupAmmo: 4,        // rockets granted per pickup
    dropOnly: true,       // wave resupply skips it; drops are the only source
    reloadTime: 1.7,
    range: 200,
    falloffStart: 200,
    falloffEnd: 201,
    falloffMin: 1,
    spreadBase: 0.2 * DEG,
    spreadMoving: 0.8 * DEG,
    spreadAir: 1.5 * DEG,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomDecay: 0,
    recoilPitch: 4.2 * DEG,
    recoilYaw: 0.6 * DEG,
    kick: 0.14,
    switchTime: 0.7,
    audio: 'bazooka',
    // --- launcher ranging sight ---
    // Not iron sights: an open optical block with a ranging ladder, which is
    // what the HUD overlay draws.
    ads: true,
    adsSight: 'bazooka',
    adsFov: 52,
    adsSpread: 0.05 * DEG,
    adsMoveSpread: 0.4 * DEG,
    adsBloom: 0,
    adsTime: 0.09,
    adsSensitivity: 0.8,
  },
  {
    id: 'airstrike',
    name: 'AIRSTRIKE',
    tier: TIER.EPIC,
    unlockable: true,
    // Not a gun: firing designates a target and calls in a bombing run.
    designator: true,
    fireMode: FIRE_SEMI,
    damage: 0,
    pellets: 1,
    headshotMultiplier: 1,
    rpm: 30,
    magSize: 1,
    reserveMax: 3,
    startReserve: 0,
    pickupAmmo: 1,
    dropOnly: true,       // wave resupply skips it; drops are the only source
    reloadTime: 2.2,
    range: 300,
    falloffStart: 300,
    falloffEnd: 301,
    falloffMin: 1,
    spreadBase: 0,
    spreadMoving: 0,
    spreadAir: 0,
    bloomPerShot: 0,
    bloomMax: 0,
    bloomDecay: 0,
    recoilPitch: 0.4 * DEG,
    recoilYaw: 0.1 * DEG,
    kick: 0.03,
    switchTime: 0.5,
    audio: 'designator',
    // --- bombing run ---
    strikeDelay: 1.6,       // seconds between the call and the first bomb
    strikeCount: 10,
    strikeInterval: 0.22,
    strikeSpread: 9,        // metres of scatter around the designated point
    strikeHeight: 55,
    strikeSpeed: 70,
    splashRadius: 8.5,
    splashDamage: 240,
    selfDamage: 0.5,
  },
];

/** Runtime state for one carried weapon. */
class WeaponInstance {
  constructor(def) {
    this.def = def;
    // Unlockable weapons start unowned and empty; a pickup grants both.
    this.owned = !def.unlockable;
    this.ammo = def.unlockable ? 0 : def.magSize;
    this.reserve = def.startReserve;
    this.bloom = 0;

    // The key that draws this weapon, handed out on pickup. Zero means the
    // player is not carrying it, so no key should reach it.
    this.slot = 0;

    // Shop upgrades, per weapon and per run. Kept on the instance rather than
    // the definition so buying a scope for the rifle never touches the pistol,
    // and so a new run starts clean by rebuilding the instances.
    this.upgrades = { damage: 0, rate: 0, mag: 0 };
  }

  /** Extra rounds per magazine upgrade, always at least one. */
  get magStep() { return Math.max(1, Math.round(this.def.magSize * 0.25)); }
  get magSize() { return this.def.magSize + this.upgrades.mag * this.magStep; }
  get damageMult() { return 1 + this.upgrades.damage * 0.15; }
  get rateMult() { return 1 + this.upgrades.rate * 0.12; }
  get upgradeTotal() {
    return this.upgrades.damage + this.upgrades.rate + this.upgrades.mag;
  }

  get isFull() { return this.ammo >= this.magSize; }
  // A melee weapon is never empty and never reloadable, so every ammo-driven
  // path above it (auto-reload, dry fire, the HUD counter) falls away for free.
  get isEmpty() { return !this.def.noAmmo && this.ammo <= 0; }
  get canReload() { return !this.def.noAmmo && !this.isFull && this.reserve > 0; }
}

/** The loadout the player starts a run with: a pistol and a pickaxe. */
const START_INDEX = WEAPONS.findIndex((w) => w.id === 'pistol');
const MELEE_INDEX = WEAPONS.findIndex((w) => w.id === 'pickaxe');

export class WeaponSystem {
  constructor(audio) {
    this.audio = audio;
    this.weapons = WEAPONS.map((d) => new WeaponInstance(d));
    this._seedSlots();
    this.index = START_INDEX;      // the pistol; everything else is found
    this.lastIndex = MELEE_INDEX;  // Q flips straight to the pickaxe
    this.spin = 0;          // minigun barrel spin-up, 0..1
    this.cooldown = 0;      // time until the next shot is allowed
    this.reloadTimer = 0;
    this.switchTimer = 0;
    this.pendingIndex = -1; // weapon being switched to
    this.triggerHeld = false;

    // Aim-down-sights state. `adsT` ramps 0..1 so the FOV change, the accuracy
    // change and the overlay can all be driven from one value instead of
    // snapping. The ramp is advanced at display rate, not tick rate, so aiming
    // never waits on the next 60Hz step.
    this.aiming = false;
    this.adsT = 0;

    // External multipliers, driven by the kill-streak buffs and potion perks.
    // Kept here rather than baked into the weapon defs so buffs never mutate
    // the data table.
    this.fireRateScale = 1;
    this.reloadScale = 1;
    this.spreadScale = 1;
    this.infiniteAmmo = false;   // ENDLESS CLIP

    // Visual recoil, consumed by the viewmodel and camera.
    this.kickBack = 0;
    this.punchPitch = 0;
    this.punchYaw = 0;

    this.onFire = null;     // (weaponInstance, shots[]) -> void
    this.onDryFire = null;
    this.onReloadStart = null;
    this.onReloadEnd = null;
    this.onSwitch = null;
  }

  get current() { return this.weapons[this.index]; }
  get def() { return this.current.def; }
  get isReloading() { return this.reloadTimer > 0; }
  get isSwitching() { return this.switchTimer > 0; }
  get isBusy() { return this.isReloading || this.isSwitching; }

  get canAds() { return !!this.def.ads; }

  /** Which overlay the HUD should draw for this weapon's sights. */
  get adsSight() { return this.def.adsSight ?? 'iron'; }

  /** Current cone half-angle in radians, given player motion state. */
  spread(player) {
    const d = this.def;
    const w = this.current;
    const hspeed = Math.hypot(player.vel.x, player.vel.z);
    const moveFactor = Math.min(1, hspeed / 5.2);

    let s = d.spreadBase + w.bloom + d.spreadMoving * moveFactor;
    if (!player.onGround) s += d.spreadAir;

    // Aiming collapses the cone; blend by adsT so accuracy tracks the visible
    // sight picture rather than snapping the instant the button goes down.
    if (d.ads && this.adsT > 0) {
      let aimedS = d.adsSpread + d.adsMoveSpread * moveFactor + w.bloom * (d.adsBloom ?? 0);
      if (!player.onGround) aimedS += d.spreadAir * 0.5;
      s = s + (aimedS - s) * this.adsT;
    }
    // STEADY AIM tightens the finished cone rather than any one term, so it
    // helps the hip-fire shotgun and the scoped rifle by the same proportion.
    return s * this.spreadScale;
  }

  /** Mouse sensitivity multiplier for the current zoom level. */
  get lookScale() {
    if (!this.def.ads || this.adsT <= 0) return 1;
    return 1 + (this.def.adsSensitivity - 1) * this.adsT;
  }

  /**
   * Drive the aim-down-sights ramp. Call once per rendered frame rather than per
   * tick: this is pure presentation plus an accuracy blend, and running it at
   * display rate is what keeps the sights feeling attached to the mouse button.
   * @returns true while aimed in at all
   */
  updateAds(dt, wantAds) {
    const d = this.def;
    // Reloading, switching or a weapon with no sights all force the aim down.
    this.aiming = !!(d.ads && wantAds && !this.isBusy);
    const rate = dt / Math.max(0.01, d.adsTime ?? 0.09);
    if (this.aiming) this.adsT = Math.min(1, this.adsT + rate);
    else this.adsT = Math.max(0, this.adsT - rate);
    return this.adsT > 0;
  }

  /**
   * Weapons the player actually carries, in slot order.
   *
   * Sorted by slot rather than left in definition order, because slots are now
   * handed out in the order things were found: the two no longer agree, and the
   * HUD list reads as nonsense if it runs 1, 4, 2, 3.
   */
  get owned() {
    return this.weapons.filter((w) => w.owned).sort((a, b) => a.slot - b.slot);
  }

  /**
   * Give the starting loadout its keys.
   *
   * Runs over the definitions in order, so the pickaxe takes 1 and the pistol 2
   * every run. Everything found later queues up behind them.
   */
  _seedSlots() {
    for (const w of this.weapons) w.slot = 0;
    for (const w of this.weapons) if (w.owned) this._claimSlot(w);
  }

  /**
   * Put a weapon on the lowest free key.
   *
   * Lowest-free rather than a running counter: a counter would strand keys if a
   * weapon ever left the loadout, and this way the row stays packed by
   * construction. There are as many slots as weapons, so the search only fails
   * if SLOT_COUNT has drifted below the number of definitions.
   */
  _claimSlot(w) {
    if (w.slot) return w.slot;
    const taken = new Set(this.weapons.map((x) => x.slot));
    for (let slot = 1; slot <= SLOT_COUNT; slot++) {
      if (!taken.has(slot)) { w.slot = slot; return slot; }
    }
    return 0;
  }

  /**
   * Grant an unlockable weapon (or top it up if already held).
   * @returns true if this was a brand new pickup
   */
  pickUp(id) {
    const w = this.weapons.find((x) => x.def.id === id);
    if (!w) return false;
    const isNew = !w.owned;
    w.owned = true;
    // A first pickup claims the next key along; topping up an existing gun
    // must not move it, or the key you just learned would change under you.
    if (isNew) this._claimSlot(w);
    const rockets = w.def.pickupAmmo ?? w.magSize;
    if (isNew) {
      w.ammo = Math.min(w.magSize, rockets);
      w.reserve = Math.min(w.def.reserveMax, rockets - w.ammo);
    } else {
      w.reserve = Math.min(w.def.reserveMax, w.reserve + rockets);
    }
    return isNew;
  }

  /** Outgoing damage multiplier from the current weapon's own upgrades. */
  get damageMultiplier() { return this.current.damageMult; }

  /**
   * Replace everything held with a versus loadout, full on ammo.
   *
   * Not a variation on reset(): reset restores the co-op starting kit, where
   * unlockable weapons are deliberately unowned because finding them is the
   * game. Here the loadout *is* the kit, so anything not in it is taken away --
   * including the pistol, which a set may well not have asked for.
   *
   * Called on every respawn, not just at match start. A duellist who has to
   * re-earn their gun after each death is a duellist losing the next fight
   * because they lost the last one, which compounds a single mistake into a
   * whole match.
   *
   * @param ids weapon ids, the one to draw first
   * @returns the ids that were actually granted
   */
  applyLoadout(ids) {
    const wanted = [];
    for (const id of ids) {
      const w = this.weapons.find((x) => x.def.id === id);
      // A loadout naming a weapon that no longer exists must not silently leave
      // the player holding nothing; skip it and let the rest of the set stand.
      if (w && !wanted.includes(w)) wanted.push(w);
    }
    if (!wanted.length) return [];

    this.audio?.stopFlamethrower?.();

    for (const w of this.weapons) {
      w.owned = wanted.includes(w);
      w.slot = 0;
      w.bloom = 0;
      w.ammo = w.owned && !w.def.noAmmo ? w.magSize : 0;
      w.reserve = w.owned && !w.def.noAmmo ? w.def.reserveMax : 0;
    }

    // Keys follow the order the loadout lists them, so the primary is always 1
    // and the melee is always last -- the same three keys whatever the pick.
    for (const w of wanted) this._claimSlot(w);

    this.index = this.weapons.indexOf(wanted[0]);
    // Q flips to the melee weapon if the set has one, or to the sidearm.
    const melee = wanted.find((w) => w.def.melee);
    this.lastIndex = this.weapons.indexOf(melee ?? wanted[wanted.length - 1]);
    this.cooldown = 0;
    this.reloadTimer = 0;
    this.switchTimer = 0;
    this.pendingIndex = -1;
    this.spin = 0;
    this.aiming = false;
    this.adsT = 0;
    return wanted.map((w) => w.def.id);
  }

  reset() {
    this.audio?.stopFlamethrower?.();
    for (const w of this.weapons) {
      w.owned = !w.def.unlockable;
      w.ammo = w.def.unlockable ? 0 : w.magSize;
      w.reserve = w.def.startReserve;
      w.bloom = 0;
    }
    this._seedSlots();
    this.index = START_INDEX;
    this.lastIndex = MELEE_INDEX;
    this.cooldown = 0;
    this.reloadTimer = 0;
    this.switchTimer = 0;
    this.pendingIndex = -1;
    this.spin = 0;
    this.kickBack = 0;
    this.punchPitch = 0;
    this.punchYaw = 0;
    this.aiming = false;
    this.adsT = 0;
    this.fireRateScale = 1;
    this.reloadScale = 1;
    this.spreadScale = 1;
    this.infiniteAmmo = false;
    this.reloadTotal = 0;
  }

  /**
   * Resupply carried weapons. Skips melee (nothing to refill) and the drop-only
   * heavies, whose scarcity is the point. Note this keys off `dropOnly` rather
   * than `unlockable`: most guns are found now, and a found rifle still has to
   * benefit from a resupply.
   */
  addAmmo(fraction = 0.25) {
    for (const w of this.weapons) {
      if (!w.owned || w.def.dropOnly || w.def.noAmmo) continue;
      w.reserve = Math.min(w.def.reserveMax, w.reserve + Math.ceil(w.def.reserveMax * fraction));
    }
  }

  switchTo(i) {
    if (i < 0 || i >= this.weapons.length) return false;
    if (!this.weapons[i].owned) return false;
    if (i === this.index && this.pendingIndex < 0) return false;
    if (this.pendingIndex === i) return false;

    // A looping burner must die on the switch edge, not one simulation tick
    // later when the trigger state is sampled again.
    if (this.current.def.id === 'flamethrower') this.audio?.stopFlamethrower?.();

    // Switching cancels a reload -- the magazine simply stays where it was.
    this.reloadTimer = 0;
    this.pendingIndex = i;
    this.switchTimer = this.weapons[i].def.switchTime;
    this.audio?.switchWeapon();
    return true;
  }

  switchLast() { return this.switchTo(this.lastIndex); }

  /**
   * Draw the weapon on a slot key. One slot holds one weapon, so this is a
   * direct request for a specific gun rather than a cycle: pressing the key
   * twice does nothing the second time, and the key never draws something
   * else because of what you happened to press before it.
   */
  selectSlot(slot) {
    const i = this.weapons.findIndex((w) => w.owned && w.slot === slot);
    return i >= 0 ? this.switchTo(i) : false;
  }

  /**
   * The weapon a slot key holds, or null if nothing has claimed that key yet.
   *
   * Slot 0 means "not carried", so guard against it explicitly -- otherwise
   * asking for slot 0 would match the first weapon the player has never found.
   */
  weaponForSlot(slot) {
    if (!slot) return null;
    return this.weapons.find((w) => w.slot === slot) ?? null;
  }

  /** Scroll to the next owned weapon, skipping anything not picked up yet. */
  cycle(dir) {
    const n = this.weapons.length;
    const from = this.pendingIndex >= 0 ? this.pendingIndex : this.index;
    for (let step = 1; step <= n; step++) {
      const i = ((from + dir * step) % n + n) % n;
      if (this.weapons[i].owned) return this.switchTo(i);
    }
    return false;
  }

  startReload() {
    const w = this.current;
    if (this.isBusy || !w.canReload) return false;
    this.reloadTimer = w.def.reloadTime / Math.max(0.05, this.reloadScale);
    // Remember the actual duration so the reload animation matches a buffed
    // reload instead of running against the unmodified table value.
    this.reloadTotal = this.reloadTimer;
    this.audio?.reloadOut();
    this.onReloadStart?.(w);
    return true;
  }

  _finishReload() {
    const w = this.current;
    const need = w.magSize - w.ammo;
    const take = Math.min(need, w.reserve);
    w.ammo += take;
    w.reserve -= take;
    w.bloom = 0;
    this.audio?.reloadIn();
    this.onReloadEnd?.(w);
  }

  /**
   * Advance timers and resolve input.
   * @param player used for the spread calculation and view punch
   * @param wantFire trigger state this tick
   * @param firePressed trigger edge this tick (semi-auto gate)
   */
  update(dt, player, wantFire, firePressed, rng = Math.random) {
    this.triggerHeld = !!wantFire;
    const selected = this.current;
    this.audio?.setFlamethrower?.(selected.def.id === 'flamethrower'
      && wantFire && !selected.isEmpty && !this.isBusy);

    // Decay bloom and visual recoil.
    for (const w of this.weapons) {
      if (w.bloom > 0) w.bloom = Math.max(0, w.bloom - w.def.bloomDecay * dt);
    }
    this.kickBack *= Math.max(0, 1 - dt * 11);
    this.punchPitch *= Math.max(0, 1 - dt * 9);
    this.punchYaw *= Math.max(0, 1 - dt * 9);

    if (this.cooldown > 0) this.cooldown -= dt;

    if (this.switchTimer > 0) {
      this.switchTimer -= dt;
      // The swap lands halfway through the animation.
      if (this.switchTimer <= this.weapons[this.pendingIndex]?.def.switchTime * 0.5 && this.pendingIndex >= 0) {
        this.lastIndex = this.index;
        this.index = this.pendingIndex;
        this.pendingIndex = -1;
        this.onSwitch?.(this.current);
      }
      if (this.switchTimer <= 0) this.switchTimer = 0;
      return null;
    }

    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.reloadTimer = 0;
        this._finishReload();
      }
      return null;
    }

    const w = this.current;
    const d = w.def;

    // Auto-reload the instant an empty gun is asked to fire.
    if (wantFire && w.isEmpty) {
      if (w.canReload) {
        this.startReload();
      } else if (firePressed) {
        this.audio?.dryFire();
        this.onDryFire?.(w);
      }
      return null;
    }

    // Automatics fire on trigger state; everything else needs a fresh click.
    const gate = d.fireMode === FIRE_AUTO ? wantFire : firePressed;
    // Barrels have to come up to speed first, and spin back down when released.
    // Tracked before the gate so a released trigger still winds down.
    if (d.spinUp) {
      const rate = dt / d.spinUp;
      if (gate && !w.isEmpty) this.spin = Math.min(1, this.spin + rate);
      else this.spin = Math.max(0, this.spin - rate * 0.8);
      if (this.spin < 1) return null;
    } else if (this.spin > 0) {
      this.spin = Math.max(0, this.spin - dt * 3);
    }

    if (!gate || this.cooldown > 0 || w.isEmpty) return null;

    return this._fire(player, rng);
  }

  _fire(player, rng, alternate = false) {
    const w = this.current;
    const d = w.def;

    if (!this.infiniteAmmo && !d.noAmmo) w.ammo -= 1;
    this.cooldown = (60 / d.rpm) / Math.max(0.05, this.fireRateScale * w.rateMult);

    const dir = player.getLookDir({});
    // A swing has no cone: it sweeps an arc, and combat.js decides what it
    // reached. Handing it one exact direction keeps that decision in one place.
    const cone = d.melee ? 0 : this.spread(player);
    const shots = [];
    for (let i = 0; i < d.pellets; i++) {
      shots.push(cone > 0 ? spreadDirection(dir, cone, rng) : { x: dir.x, y: dir.y, z: dir.z });
    }

    // Bloom for the next shot, then view punch.
    w.bloom = Math.min(d.bloomMax, w.bloom + d.bloomPerShot);
    const pitchKick = d.recoilPitch * (0.75 + rng() * 0.5);
    const yawKick = d.recoilYaw * (rng() * 2 - 1);
    player.pitch = Math.min(Math.PI / 2 - 0.001, player.pitch + pitchKick);
    player.yaw += yawKick;
    this.punchPitch += pitchKick * 1.8;
    this.punchYaw += yawKick * 1.8;
    this.kickBack = Math.min(1, this.kickBack + d.kick * 8);

    this.audio?.shoot(d.audio);
    this.onFire?.(w, shots, cone, alternate);
    return { weapon: w, shots, cone, alternate };
  }

  /** Fire a weapon's secondary function through the same timing/recoil path. */
  fireAlternate(player, rng = Math.random) {
    const w = this.current;
    if (!w.def.alternateFire || this.isBusy || this.cooldown > 0 || w.isEmpty) return null;
    return this._fire(player, rng, true);
  }
}

/**
 * Perturb a unit direction into a cone of the given half-angle.
 * Samples uniformly over the cap so the pattern has no directional bias.
 */
export function spreadDirection(dir, halfAngle, rng = Math.random) {
  if (halfAngle <= 0) return { x: dir.x, y: dir.y, z: dir.z };

  // Build an orthonormal basis around dir.
  let ux, uy, uz;
  if (Math.abs(dir.y) < 0.99) { ux = 0; uy = 1; uz = 0; }
  else { ux = 1; uy = 0; uz = 0; }
  // t = normalize(cross(up, dir))
  let tx = uy * dir.z - uz * dir.y;
  let ty = uz * dir.x - ux * dir.z;
  let tz = ux * dir.y - uy * dir.x;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl; ty /= tl; tz /= tl;
  // b = cross(dir, t)
  const bx = dir.y * tz - dir.z * ty;
  const by = dir.z * tx - dir.x * tz;
  const bz = dir.x * ty - dir.y * tx;

  const cosMax = Math.cos(halfAngle);
  const cosTheta = 1 - rng() * (1 - cosMax);
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = rng() * Math.PI * 2;
  const a = Math.cos(phi) * sinTheta;
  const b2 = Math.sin(phi) * sinTheta;

  const x = dir.x * cosTheta + tx * a + bx * b2;
  const y = dir.y * cosTheta + ty * a + by * b2;
  const z = dir.z * cosTheta + tz * a + bz * b2;
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

/** Linear damage falloff between falloffStart and falloffEnd. */
export function damageAtRange(def, distance) {
  if (distance <= def.falloffStart) return def.damage;
  if (distance >= def.falloffEnd) return def.damage * def.falloffMin;
  const t = (distance - def.falloffStart) / (def.falloffEnd - def.falloffStart);
  return def.damage * (1 + t * (def.falloffMin - 1));
}
