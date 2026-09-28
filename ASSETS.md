# Art pipeline

UPVOTE UPRISING draws almost everything in code — bevelled boxes, cylinders and canvas
textures. That is still the default and it is still the right one: a procedural
prop costs nothing to ship and retunes by editing a number.

This document covers the exception. Photographed surfaces, downloaded models and
skinned characters are installed on top of the procedural art, and every one of
them is optional. **A clone with an empty `assets/` tree plays exactly as it did
before** — it just looks older. Nothing in the pipeline can break the game by
being absent, slow or corrupt.

## Getting the art

```
node tools/fetch-assets.mjs     # reinstall everything that needs no account
```

That is [Poly Haven](https://polyhaven.com) — ground, sky, surfaces, props, all
CC0 — plus guns, creatures, audio and military-kit pieces from
[OpenGameArt](https://opengameart.org), which serves files directly. The release
tree includes the installed assets; the manifest and fetcher make that bundle
reproducible if an asset is removed or needs to be refreshed.

**Every weapon slot has a model after that one command**, except four that are
deliberately left procedural: the laser and the railgun, whose coloured emitters
are how the player tells them apart at a glance; the Intervention, whose long
vented chassis and skeletal stock are authored as its identity; and the golf
club, which nobody has modelled for free.

A better-looking pick exists for most slots on [Sketchfab](https://sketchfab.com),
whose download endpoint is a 401 without an account:

```
# 1. sign in at sketchfab.com (free)
# 2. copy the API token from sketchfab.com/settings/password
SKETCHFAB_TOKEN=<token> node tools/fetch-assets.mjs --sketchfab
```

Manifest order is preference order and the loader takes the first *installed*
entry per slot, with the account-gated picks listed above the open ones. So a
token upgrades a weapon rather than duplicating it, and having no token is not a
downgrade from anything — it is the next choice down. A test enforces that
ordering.

Other flags: `--only=terrain,env` to fetch one section, `--force` to
re-download what is already present.

## Licences, and the one that matters

Everything in the manifest is **CC0** or **CC-BY**, and a test asserts that —
NonCommercial, ShareAlike and NoDerivs are all one careless paste away and none
of them survives a commercial game.

CC-BY permits commercial use and modification. It does not touch your code, does
not force you to open anything, and does not restrict selling texture packs. It
obliges exactly one thing: **credit** — title, author, source, licence, plus a
note when the asset was modified.

That is why the credits are generated rather than written:

- `tools/fetch-assets.mjs` writes `assets/CREDITS.json` as it downloads, so the
  list cannot drift from what actually shipped. Nobody has to remember a row.
- `ATTRIBUTIONS.md` is the same data as text, regenerated on every fetch.
- `src/ui/credits.js` renders it into the **ART CREDITS** panel in the menu.
  The button hides itself when no art is installed, because procedural art owes
  nobody attribution.

One trap worth knowing: several Sketchfab uploads have "(CC0)" in the *title*
while the licence field says CC Attribution. The licence field binds. They are
credited as CC-BY.

CC-BY also forbids adding restrictions downstream, which for a browser game is a
feature rather than a problem: a player pulling a `.glb` out of the network tab
is exercising rights the licence grants them. That is exactly why marketplaces
whose EULAs forbid extractable distribution — Unity Asset Store, TurboSquid —
are not in this manifest at all.

## How each kind is wired in

`assets/manifest.json` is the source of truth: it maps each download to the slot
it fills and carries the attribution it owes.

| Kind | Lands in | Consumed by | Falls back to |
|---|---|---|---|
| Terrain photos | `assets/textures/<slug>/` | `render/photosets.js` → the terrain shader's texture arrays | the procedural bake in `texturelab.js`, per layer |
| Surfaces | `assets/textures/<slug>/` | `photosets.js` `photoMaterial()` | procedural canvas materials |
| Sky | `assets/env/<slug>.hdr` | `render/environment.js` → PMREM environment | `studioenv.js` gradient |
| Props | `assets/models/<slug>/scene.gltf` | `render/models.js`, scaled into the authored collider | nothing drawn on that collider |
| Weapons | `assets/weapons/<id>/` | `render/weaponmodels.js` → `viewmodel.replaceModel` | the `BUILDERS` gun |
| Characters | `assets/characters/<uid>/` | `render/charactermodels.js` → `enemymesh.js` | the capsule build in `render/zombies/` |
| Aquarium species | `assets/creatures/aquarium/`, `animated_fish_pack/` | `entities/reverseaquarium.js` | the procedural eight-fish school |
| Cat anomaly | `assets/creatures/spinning-cat.gif`, `cat/maggie-animated-v3.glb` | `entities/spinningcat.js` → one seed-selected indoor room | the landmark is skipped if the model is unavailable |

`assets/creatures/mr-balls.jpg` is original project artwork for an unfinished
Mr. Balls feature. It is not part of the downloadable third-party asset manifest.

Four contracts hold the whole thing together. They are the reason a swap is a
swap and not a rewrite:

**The collider wins.** A prop's box is decided in `src/world/`, which has never
heard of Three.js, and the model is scaled to fit it. What stops a bullet cannot
change when the art does.

**The built model is the ruler.** A downloaded weapon is scaled to the length of
the box-built gun it replaces, so every rest pose, ADS depth and `MODEL_SCALE`
value stays valid. A character is scaled to `type.height` — the same number the
simulation uses for the hitbox, so a downloaded body cannot be taller than what
bullets hit.

**Anchors are derived, then corrected.** `viewmodel.js` needs
`userData.muzzle` (flash, light and tracer origin) and `userData.sight` +
`adsZ` (where the eye goes when aiming). A downloaded mesh has neither, so both
are derived from its bounding box — and every measurement happens in one frame,
after the barrel axis has been squared onto -Z, because the whole point of "the
front face" is that it means the end of the barrel. Corrections go in `ALIGN` in
`render/weaponmodels.js`, authored with **`tools/weaponaligner.html`**: it draws
the loaded model over a wireframe of the built one it replaces, marks both
anchors, and prints the `ALIGN` block to paste back.

**Three formats, because free guns are not glTF.** FBX and OBJ are what hobbyists
export, so `weaponmodels.js` loads all three and the extension decides. Imported
Phong materials are rebuilt as `MeshStandardMaterial`, since that is what every
skin and texture pack in the armoury expects — and because Phong ignores the
environment map, which is most of what makes gun metal look like metal.

**Roles, not colours.** Skins and texture packs work by reading
`userData.baseHex` and `userData.baseRole` off each material — the palette slot a
part was built from. Imported materials have no such history, so
`weaponmodels.js` infers a role from the material name and writes both fields.
Get this wrong and a paid pack silently stops working on that gun, which is the
one failure here that costs money rather than looks. Optics and sight blades are
deliberately tagged `DARK` (the GRIP surface), which packs never wrap: pattern
across a sight picture is pattern where the player is trying to see.

## What is still procedural on purpose

- **The bulwark and the abomination.** Their silhouettes carry the counterplay —
  the frontal shield, the core on the back — and a generic humanoid body deletes
  the tell the fight is built around. A test enforces this.
- **The sky dome.** `sky.js` still draws what the player sees; the HDRI only
  supplies reflections and ambient light. The atmosphere stays art-directed and
  tunable while the lighting gets its realism from a measurement.
- **Weapon animation.** Recoil, sway, the reload dip and the melee swing are all
  transforms on the model group, so they work on a downloaded gun unchanged. The
  shotgun's animated `pump` is the exception: a single-mesh download has no pump
  to move.

## Adding an asset

1. Add a row to the right section of `assets/manifest.json`, with `title`,
   `author`, `license` and `page` filled in. An OpenGameArt row also needs `url`
   (the archive) and `pick` (which file inside it to use). The tests will tell
   you if the slot name does not exist or the pick is not a loadable format.
2. Run the fetcher.
3. For a weapon, open `tools/weaponaligner.html`, compare it against the built
   gun, and paste the printed correction into `ALIGN`.
4. Run `npm test`. `test/assets.test.mjs` checks the ids resolve and that every
   asset carries the attribution it owes.

## Known asset traps

Two failures worth recognising, because neither looks like what it is:

- **An OBJ with a stray line element loads as lines, not triangles.** OBJLoader
  types a whole object by the last element kind it saw, so two `l` entries left
  in an export silently discard 1,140 faces. `weaponmodels.js` measures across
  meshes only and rejects the model with a reason rather than putting an
  invisible gun in the player's hands; the fix is to use the FBX of the same
  model, which is what `microsmg` does.
- **A white specular colour is not a metal surface.** FBX exporters write white
  specular by default. Read literally it lands every gun at metalness 0.9, where
  a standard material has almost no diffuse response and the model looks washed
  out or black depending on the environment. The conversion caps it at 0.45.
