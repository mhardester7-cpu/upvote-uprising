// Weapon camos: palette swaps for the viewmodel.
//
// There are no textures in this renderer, so a camo is a finish, not a
// pattern: it recolours the three material families every gun is built from --
// metal, dark hardware, and furniture -- plus the metal's shininess, which is
// what makes GOLD PLATE an actual gold gun rather than a yellow one.
//
// Camos are account-wide (they apply to every weapon at once) and persist in
// the saved profile. They are deliberately cosmetic only: a finish that also
// shot harder would poison both systems at once.

export const CAMOS = [
  {
    id: 'standard', name: 'STANDARD ISSUE', cost: 0,
    blurb: 'Factory finish',
    metal: 0x6a727d, dark: 0x434a54, polymer: 0x3a3f46,
    furniture: 0x8d7f63, wood: 0x8a6238,
  },
  {
    id: 'woodland', name: 'WOODLAND', cost: 800,
    blurb: 'Greens for the treeline',
    metal: 0x59635a, dark: 0x39443c, polymer: 0x2f3a2e,
    furniture: 0x4e5c3a, wood: 0x5a6a40,
  },
  {
    id: 'desert', name: 'DESERT', cost: 800,
    blurb: 'Dust and tan',
    metal: 0x8d8168, dark: 0x6b6152, polymer: 0x7d7260,
    furniture: 0xa8916a, wood: 0x9a825c,
  },
  {
    id: 'arctic', name: 'ARCTIC', cost: 800,
    blurb: 'Whiteout finish',
    metal: 0xb4bcc4, dark: 0x848d96, polymer: 0x9aa2ab,
    furniture: 0xd6dbe0, wood: 0xc4c9cf,
  },
  {
    id: 'nightops', name: 'NIGHT OPS', cost: 1200,
    blurb: 'Murdered out',
    metal: 0x33373d, dark: 0x22262b, polymer: 0x282c31,
    furniture: 0x3a3e44, wood: 0x30343a,
  },
  {
    id: 'crimson', name: 'CRIMSON', cost: 1800,
    blurb: 'Deep red furniture over black',
    metal: 0x4a4448, dark: 0x2e282c, polymer: 0x3c2a30,
    furniture: 0x7a2f36, wood: 0x6e2a30,
  },
  {
    id: 'gold', name: 'GOLD PLATE', cost: 6000,
    blurb: 'For wave-20 money',
    metal: 0xd4af37, dark: 0x9a7c28, polymer: 0x2b2f36,
    furniture: 0x32363c, wood: 0x2c3036,
    // The finish, not just the colour: low roughness and high metalness are
    // what make it gleam under the viewmodel's key light.
    metalRoughness: 0.22, metalMetalness: 0.85,
  },
];

export const CAMO_BY_ID = Object.fromEntries(CAMOS.map((c) => [c.id, c]));
