# Upvote Uprising

**Upvote Uprising** is a browser game shaped by suggestions from a Reddit community series. Each community addition is recorded in [COMMUNITY_CHANGES.md](COMMUNITY_CHANGES.md).

[Play the live game](https://deadfall.up.railway.app/). Suggestions and pull requests are welcome; see [Contributing](#contributing).

A co-op wave-survival first-person shooter that runs in the browser. No build
step, no bundler, no framework: hand-written ES modules, Three.js from `vendor/`,
and a Node server that hosts both the static files and the multiplayer.

```
npm install
npm start          # http://localhost:5173
npm test
```

## Art

The game draws almost everything in code and runs fine that way. Photographed
ground, a real sky, downloaded props, guns and characters are an optional layer
on top:

```
node tools/fetch-assets.mjs                                       # reinstall account-free assets
SKETCHFAB_TOKEN=<token> node tools/fetch-assets.mjs --sketchfab   # optional upgrades
```

The first line needs nothing: Poly Haven and OpenGameArt both serve files
directly, and it installs photographed ground and sky, real props, a military
kit, and **a model for every weapon slot** but the two energy weapons and the
golf club. The second line is optional — Sketchfab has a better pick for most
slots but its download endpoint rejects anonymous requests, and the token is on
`sketchfab.com/settings/password`.

Much of this art is CC-BY, so the fetcher also writes the attribution the licence
obliges: `ATTRIBUTIONS.md`, and the **ART CREDITS** panel in the menu.
`tools/weaponaligner.html` is where a downloaded gun gets lined up with the built
one it replaces.

Nothing here is required. With an empty `assets/` tree every asset resolves to
the procedural version it replaces, so the game looks older and plays the same.
See [ASSETS.md](ASSETS.md).

## Playing

| Key | |
| --- | --- |
| `W A S D` | Move |
| Mouse | Look |
| Left click | Fire / place blue portal with the portal gun |
| Right click | Aim down sights / place orange portal with the portal gun |
| Number-row slots / wheel | Switch weapon |
| `Q` | Last weapon |
| `R` | Reload |
| `E` | Interact / use / buy |
| `B` | Armoury (between waves only) |
| `F` | Snap (once all five stones are gathered) |
| `Shift` | Sprint |
| `Space` | Hold to bunnyhop; release and tap again to jump off a wall |
| `Esc` | Pause |

The **PORTAL GUN** is carried from the start. Draw it from its numbered slot,
place one blue and one orange aperture on flat walls, floors, or ceilings, then
walk or fall into either end. Position, view direction, and momentum rotate
through the linked exit, so a fall into a floor portal can launch you from a
wall. Bullets and rockets follow the same linked path. Re-firing either colour
moves only that end of the link.

**Movement districts** — The world spans 384 × 384 metres, four times the
previous map area. Eight distinct districts range from three to eight levels:
SANDSTONE CITADEL, IRONWORKS, HANGING GARDENS, RED BRICK MILL,
WHITE OBSERVATORY, AMETHYST LABS, BASALT QUARRY, and CEDAR SKYPORT.
Brick and stone masonry, metal panels, timber grain, plaster and tiled floors
replace the uniform concrete and colored wall stripes. Colonnades, gantries,
planted terraces, chimneys, stepped pavilions, lab pods, quarry cuts and timber
canopies give each district its own silhouette and routes. Stairs, balconies
and bridges remain physical, with clear portal lanes and open launch shafts.
Parallel wall-running lanes now run through the movement districts and ordinary
rooms. Their opposing surfaces are 4.2 metres apart, with ten-metre runs and
three-metre crossing gaps. Wall runs sustain without a timer at 8.5 m/s with a
slow descent; a 0.42-second seam grace bridges those gaps. Moving away from the
wall or releasing movement detaches. Jump presses buffer for 0.14 seconds before
contact. Hold jump to bunnyhop; release and tap jump during
a wall run to transfer to the opposite wall. Decorative clutter yields to the
clear routes, while doors, stairs and interactive landmarks retain access.

Live portal views render only when visible and unobstructed, with at most one
auxiliary pass per frame and 30 refreshes per second. View textures scale with
distance and are reused when repositioning a portal; animation and traversal
still update with the game. Building geometry is batched spatially so distant
sections can be culled from the main camera and portal views.

The portal projector has ceramic and machined metal surfaces, service panels,
fasteners, a ribbed grip, power cabling, and a luminous reactor. Portals open
with an expanding aperture, animated energy filaments and orbital sparks;
firing sends a plasma streak and crossing triggers a brief energy/FOV pulse.

**Solo** — press `SOLO SURVIVAL`.

**Co-op** — type a name, press `HOST CO-OP`, and read out the six-character room
code. Anyone else opens the same URL, types the code, and presses `JOIN`. Rooms
start code-only; a host can deliberately enable the public checkbox to put the
chosen display name and room code in the lobby list.

Co-op is cooperative against the AI. The party shares a coin pot and a score,
waves scale with how many of you there are, and a player who drops to zero
health bleeds out for 30 seconds where a partner can revive them by standing
close. Solo has nobody coming, so zero health is simply the end.

Explore the deeper rooms to find the **DINOSAUR FACTORY**. For 1,500 coins its
glass incubation pod grows and releases an animated velociraptor companion that
follows you, hunts nearby zombies, and bites in time with its attack animation.
The starting room also contains a six-piece chicken-nugget dispenser.

One room deeper, **HUMAN OBSERVATION** turns the aquarium inside out: a lit,
mid-height water conduit carries a realistically textured Barramundi and seven
animated aquatic species. Each fish stops in the central viewing chamber and
looks directly at people below. A free shutter can be opened and closed to keep
zombies out, while realistic beds, medical gear, tools, storage, lighting and
other curious "human necessities" furnish the enclosure.

The **DAN DAN CAT** anomaly hides in one randomly selected indoor room other
than the starting room. To find it, search the indoor rooms and look directly at
the spinning two-dimensional cat—the reveal waits for your gaze, plays the GIF
once, then poofs into the larger animated cat.

The **inevitable snail** starts in the same room as the player and follows them
whenever they are on foot; touching it is instant death, while boarding the
Starling makes it disappear instead of chasing the spacecraft. In space, a
banana asteroid transforms the Starling and stores a charge. The 30-second
banana-boomerang gun arms only after the next landing puts the player back on
the ground.

## What you are fighting

| | |
| --- | --- |
| GRUNT | the baseline |
| BABY ZOMBIE | fast, fragile, best source of airstrike drops |
| GUNNER | hangs back and shoots; telegraphs before it fires |
| SPITTER | weak on contact, leaves poison behind |
| LEAPER | closes in bounds and cannot steer mid-flight, so the leap is punishable |
| BLOATER | lights a fuse on approach and detonates — hurting the horde too |
| BRUTE | 260 health, hits like a truck |
| BULWARK | frontal shield cuts damage to 12%; it has to be flanked |
| CLIPPY | a fast, heavy-hitting mini-boss leading wave five |

Each of these is built around a counter rather than a bigger health bar. The
bulwark is the clearest case: shooting it head-on is nearly useless, so either
you walk around it or you use splash, which ignores facing entirely. In co-op
that becomes a two-person job without anyone having to be told.

Clippy arrives at the front of wave five with its own health bar. It has
no armour gimmick or ranged attack: the pressure comes from a tougher, faster
melee threat entering while the ordinary horde is still alive.

## The armoury

Kills pay coins into a pot. Between waves, `B` opens the shop:

- **Consumables** — ammo, medkits, a random brew. These scale in price with the
  wave, so late in a run the pot is under real pressure.
- **Weapon upgrades** — damage, fire rate, magazine. These are *per weapon*, so
  investing in the rifle means the rifle is your answer for the rest of the run.
- **Vitality** — permanent maximum health, up to four levels.
- **Bazooka / airstrike** — if you would rather buy them than wait for a drop.

In co-op the pot is shared, so the shop is where a party actually has to talk to
each other.

## How it fits together

```
src/sim/gamesim.js     authoritative simulation: enemies, waves, economy
src/net/session.js     LocalSession (tick it here) / NetSession (server ticks it)
src/net/netclient.js   socket, snapshot buffer, interpolation
src/net/protocol.js    message names, shared by both sides
server/gameserver.js   room registry, socket handling
server/room.js         one room: a GameSim plus its members
src/entities/          player, enemies, pickups, chests, stones (no rendering)
src/render/            everything Three.js, plus camera shake
src/world/             heightfield terrain, props, raycasting
src/ui/                HUD, the armoury, damage numbers, saved progress
```

The important structural point is that `gamesim.js` imports nothing
browser-specific, so **the same simulation runs in the tab for single player and
on the server for co-op**. There is one wave table, one set of AI rules, and one
scoring path. Single player therefore exercises the same reconcile-and-render
code that multiplayer depends on, which is what keeps the networked mode honest.

Division of labour in co-op:

| | owned by |
| --- | --- |
| your movement and aim | your machine — it never waits for the server |
| your shots | resolved locally for feel, reported upward for scoring |
| enemies, waves | the server; clients interpolate on a ~80ms delay |
| score and coins | the server, so everyone agrees on the total |
| chests, stones, pickups | instanced per player from a shared world seed |

Damage is client-reported. The public launch is therefore co-op PvE only; the
server refuses requests to create the unfinished competitive mode. It validates
message rates, numeric state and shared-pot prices, but it cannot prove that a
reported shot really happened. A modified client can cheat or spoil a shared
room, so private codes are best for people you trust. Do not attach paid or
competitive rewards to a run until shots and world interactions are fully
server-authoritative. Explosions resolve server-side because splash decides who
died and everyone has to agree on that.

## Guest-only public launch

Account creation and sign-in are disabled in the public build. All progress is
guest progress saved only in that browser. `ACCOUNTS_ENABLED` in
`src/net/config.js` fails closed even when a local Supabase override exists, and
the account buttons remain hidden.

Before opening a hosted build to the public:

1. Apply the pending files in `supabase/migrations/` to the hosted project. The
   latest migrations tighten profile grants and policies, bound profile payloads,
   and remove the old paid-entitlement table.
2. In the hosted Supabase dashboard, disable new-user signups. The local config
   and hidden browser controls do not secure the hosted Auth API by themselves.
3. Add a monitored public contact address to `privacy.html` and `terms.html`.

`supabase/config.toml` controls local Supabase; editing it does not change an
already-hosted project. Before accounts are ever re-enabled, configure production
SMTP, email confirmation, password protections, recovery, and bot protection.

## Deploying to Railway

The server listens on `process.env.PORT` and serves the game and the WebSocket
on the same port, so it deploys as a single service with no extra configuration.

1. Push this repository to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, and pick it.
3. Wait for the build. Nixpacks detects Node and runs `npm start` on its own;
   `railway.json` pins the start command and the `/healthz` check regardless.
4. **Settings → Networking → Generate Domain.** That URL is the game.

The durable total-play counter also requires a server-only Supabase secret:

1. Create or select a server-only `sb_secret_...` key in the Upvote Uprising Supabase project.
2. Add it to the Railway service as `SUPABASE_SECRET_KEY`.
3. Never put that value in client code, source control, logs, or a browser. The
   public build contains only the low-privilege publishable key used to read the
   aggregate total.

Share the URL, host a game, read out the room code.

### Things worth knowing

- **Keep it at one replica.** Rooms live in memory, so two replicas means two
  players can join "the same" code and land in different worlds. `railway.json`
  sets `numReplicas: 1`. If you ever need to scale past one instance, rooms have
  to move to shared storage first.
- The process currently caps itself at **2,000 simultaneous sockets and 250
  rooms**. That is a resource-safety ceiling, not a promise that one Railway
  instance can deliver a good game at that load. Load-test before advertising
  any simultaneous-player target.
- **`wss://` is automatic.** The client picks its scheme from the page, so a
  Railway HTTPS domain gets a secure socket without configuration.
- **Idle rooms are collected** 30 seconds after the last player leaves. A
  reconnect inside that window rejoins the run already in progress.
- **`/healthz`** reports uptime and live room count; **`/api/rooms`** is the
  lobby listing.
- Railway sleeps a service with no traffic on some plans. The first visitor
  after a sleep waits for a cold start, which is a few seconds.

## Testing

`npm test` runs the Node test suite (world generation, combat maths, weapon
timing, multiplayer protocol and public-boundary security). Before a release,
also load the menu and start a run in a real WebGL browser; a browser smoke test
can catch CSP, module-resolution and GPU issues that Node cannot.

For a focused portal/movement visual review, run
`python3 -m http.server 5174 --bind 127.0.0.1` and open
`http://127.0.0.1:5174/tools/portalreview.html`. This development-only harness
uses the real generated world, player, weapon, portal system and building
renderer. It provides a linked-pair setup, two-way traversal check, overview,
and playable movement controls without starting a survival run. All doors are
open in the preview; Next district and Next floor offer quick access to the
full map. Play works without mouse capture using drag-to-look or arrow keys. The production
server intentionally does not serve development tools.

One thing that shows up under a software renderer and is worth knowing about:
the client clamps itself to five simulation steps per frame, so below roughly
12fps the single-player simulation runs slower than real time. The clamp is
deliberate — without it a stalled tab tries to catch up on its whole backlog at
once and stalls further — and the game is not playable at that framerate anyway.
Co-op is unaffected, because the server ticks on its own clock regardless of
what any client's framerate is doing.


## Contributing

Contributions are welcome. Open an issue to discuss a larger change, or send a
pull request for a focused fix, feature, documentation update, or gameplay idea.
Please include a short description of what changed and how you checked it.

The [community changes guide](COMMUNITY_CHANGES.md) is a good place to see what
players have already suggested and how to find it in the game.

This project is available under the MIT License; see [LICENSE](LICENSE).
