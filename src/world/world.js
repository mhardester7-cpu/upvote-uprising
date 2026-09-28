// World: the smooth heightfield plus everything standing on it.
//
// This is the single surface the rest of the game talks to. It owns terrain
// (Heightfield) and props (trees, rocks, ruins, crates), and exposes one
// raycast() that resolves against both, so combat.js never needs to know the
// difference between shooting a hillside and shooting a tree.
//
// Props carry analytic colliders -- a vertical cylinder or an AABB -- rather
// than being traced against their render meshes. A trunk is a cylinder to both
// the bullet and the player, which keeps hit registration cheap and, more
// importantly, keeps what blocks a shot identical to what blocks movement.

import { planParkour, buildParkour } from './parkour.js';
import { Heightfield, SIZE, MAX_WALK_SLOPE } from './heightfield.js';
import { rand2, fbm2 } from './noise.js';
import { rayAABB } from './raycast.js';
import { addFurnishings } from './buildings.js';
import { collectBarriers, workBarrier, repairBarrier } from './barriers.js';
import {
  planComplex, buildComplex, levelsOf, doorwayCenter,
  PROP_SLAB, PROP_WALLSEG, PROP_STAIR, PROP_FURNITURE, PROP_DOOR, PROP_WINDOW,
  FLOOR_H, SLAB_LIFT,
} from './complex.js';
import { planArena, ARENA_W, ARENA_D } from './arena.js';
import {
  buildDrummerTower, planDrummerTower, PROP_DRUMMER_TOWER,
} from './drummertower.js';

export { SIZE, MAX_WALK_SLOPE };

export const PROP_CRATE = 'crate';
export const PROP_CONTAINER = 'container';
/**
 * A prop drawn from a loaded model rather than from code.
 *
 * The collider is still authored here; `model` only names the art. See
 * render/models.js for why that split is the way round it is.
 */
export const PROP_VEHICLE = 'vehicle';

/**
 * Drums, by installed model.
 *
 * Three rather than one because a fuel dump is a row of them, and a row of the
 * same mesh at the same rotation reads as wallpaper. Chosen by the prop's own
 * seed so a given world always draws the same drum in the same place.
 */
export const BARREL_MODELS = ['Barrel_01', 'Barrel_02', 'barrel_03'];
export const PROP_BARREL = 'barrel';
export const PROP_TREE = 'tree';
export const PROP_ROCK = 'rock';
/**
 * Freestanding rubble walls.
 *
 * Nothing generates these any more -- the buildings took over the job of
 * giving the site hard cover. The type stays because the outdoor renderer
 * still knows how to draw one, and a ruined outbuilding is an obvious thing to
 * want back.
 */
export const PROP_RUIN = 'ruin';
/**
 * Single-storey shell pieces.
 *
 * Superseded by the multi-storey system in buildings.js, which emits slabs,
 * wall segments and doors instead. The names stay exported because the outdoor
 * renderer still has code paths for them and will simply receive none.
 */
export const PROP_WALL = 'wall';
export const PROP_ROOF = 'roof';

export { PROP_SLAB, PROP_WALLSEG, PROP_STAIR, PROP_FURNITURE, PROP_DOOR, PROP_WINDOW, FLOOR_H };
export { PROP_DRUMMER_TOWER };

/** How many buildings the site holds, and the street kept between them. */
const BUILDING_COUNT = 7;
const STREET = 8;

/** Props are bucketed into this XZ grid so queries touch only nearby ones. */
const BUCKET = 8;

/** Which floorplan a world is built from. */
export const MAP_COMPLEX = 'complex';
export const MAP_ARENA = 'arena';

export class World {
  /**
   * @param opts.map MAP_COMPLEX (default, generated from the seed) or
   *                 MAP_ARENA (the hand-authored versus map, seed-independent
   *                 apart from the terrain it is levelled into)
   */
  constructor(seed = 1337, opts = {}) {
    this.seed = seed | 0;
    this.planetProfile = opts.planet === 'cinder' || opts.planet === 'nyx' ? opts.planet : 'verdant';
    this.field = new Heightfield(seed, { profile: this.planetProfile });
    this.size = SIZE;
    this.props = [];
    this.buckets = new Map();
    this.mapId = opts.map === MAP_ARENA ? MAP_ARENA : MAP_COMPLEX;
    this.spaceportLanding = null;
  }

  // ------------------------------------------------------------ terrain API

  heightAt(x, z) { return this.field.heightAt(x, z); }
  normalAt(x, z, out) { return this.field.normalAt(x, z, out); }
  isWalkable(x, z) { return this.field.isWalkable(x, z); }
  inBounds(x, z) { return this.field.inBounds(x, z); }

  // ------------------------------------------------------------- generation

  *generate() {
    // Footprints first: the terrain has to know where the pads are before it
    // can level them, and levelling afterwards would leave the rendered ground
    // disagreeing with the collision surface.
    // The complex is planned before the terrain exists, because the terrain has
    // to be levelled under it. A facility on a hillside is a facility half
    // buried, and flattening afterwards leaves the drawn ground disagreeing
    // with the collision surface.
    // The complex is most of the map now that there is nothing else on it.
    // The versus map has a fixed footprint; the co-op one is sized off the
    // arena. Both are centred, because either way the terrain is levelled under
    // them and a pad against the map edge has nowhere to run its apron out to.
    const arena = this.mapId === MAP_ARENA;
    const cw = arena ? ARENA_W
      : this.planetProfile === 'cinder' ? SIZE * 0.50
        : this.planetProfile === 'nyx' ? SIZE * 0.58
          : SIZE * 0.74;
    const cd = arena ? ARENA_D
      : this.planetProfile === 'cinder' ? SIZE * 0.54
        : this.planetProfile === 'nyx' ? SIZE * 0.44
          : SIZE * 0.68;
    const cx0 = (SIZE - cw) / 2, cz0 = (SIZE - cd) / 2;
    const groundY = this._padHeight({ minX: cx0, minZ: cz0, maxX: cx0 + cw, maxZ: cz0 + cd });

    // Planetary maps reserve a real, level berth on the terrain mesh. Cinder
    // approaches from the west; Nyx from the north, so even their first view
    // of the outpost has a different composition.
    const landing = this.planetProfile === 'cinder' ? { x: 17, z: SIZE * 0.50 }
      : this.planetProfile === 'nyx' ? { x: SIZE * 0.50, z: 17 }
        : null;
    const landingPad = landing ? {
      minX: landing.x - 5.2, minZ: landing.z - 5.2,
      maxX: landing.x + 5.2, maxZ: landing.z + 5.2,
    } : null;
    const landingY = landingPad ? this._padHeight(landingPad) : 0;

    this.plan = arena
      ? planArena({ x0: cx0, z0: cz0, groundY })
      : planComplex({ x0: cx0, z0: cz0, w: cw, d: cd, seed: this.seed, groundY });
    // Reserve an open central room before the shell is emitted. Otherwise a
    // generated roof would sit four metres above the base of a 24 metre ladder.
    if (!arena) { planDrummerTower(this.plan); planParkour(this.plan); }

    // Verdant used to park the Starling on whatever terrain happened to be
    // outside the escape shutter. On seeds where the enclosing ridge passes
    // that wall, the ship was half hidden by a hill. Give the starting world
    // the same authored, level terrain berth as the destination planets and
    // align it with the first-room airlock that teaches the route to it.
    let spaceport = null;
    if (!arena && this.planetProfile === 'verdant' && this.plan.outside) {
      const link = this.plan.links.find((l) => l.escape);
      if (link) {
        const doorX = link.axis === 'x' ? link.at : doorwayCenter(link);
        const doorZ = link.axis === 'z' ? link.at : doorwayCenter(link);
        let nx = this.plan.outside.cx - doorX;
        let nz = this.plan.outside.cz - doorZ;
        const length = Math.hypot(nx, nz) || 1;
        nx /= length; nz /= length;
        spaceport = {
          x: doorX + nx * 8.2,
          z: doorZ + nz * 8.2,
          y: groundY,
          yaw: Math.atan2(-nz, nx),
        };
      }
    }
    const pads = [{
      minX: cx0 - 2, minZ: cz0 - 2, maxX: cx0 + cw + 2, maxZ: cz0 + cd + 2,
      y: groundY, apron: 10,
    }];
    if (landingPad) pads.push({ ...landingPad, y: landingY, apron: 8 });
    if (spaceport) {
      pads.push({
        minX: spaceport.x - 5.4, minZ: spaceport.z - 5.4,
        maxX: spaceport.x + 5.4, maxZ: spaceport.z + 5.4,
        y: groundY, apron: 8,
      });
    }
    this.field.setPads(pads);

    this.field.generate();
    // The pad level was estimated off raw terrain; read back what the finished
    // surface actually did so the floors sit exactly on it.
    const settled = this.heightAt(cx0 + cw / 2, cz0 + cd / 2);
    this.siteBounds = { minX: cx0, minZ: cz0, maxX: cx0 + cw, maxZ: cz0 + cd };
    this.landing = landing ? { ...landing, y: this.heightAt(landing.x, landing.z) } : null;
    this.spaceportLanding = spaceport
      ? { ...spaceport, y: this.heightAt(spaceport.x, spaceport.z) }
      : null;
    // The walking surface is one slab-lift above grade, so the floor and the
    // ground beneath it are never coplanar.
    for (const r of this.plan.rooms) r.floorY = settled + SLAB_LIFT;
    yield 0.55;

    this._scatterProps();
    yield 0.85;
    this._index();
    this._captureRunState();
    yield 1;
  }

  /** Remember geometry and zone flags that a fresh run must begin with. */
  _captureRunState() {
    this._initialProps = this.props.slice();
    this._initialPropSet = new Set(this._initialProps);
    this._reclosableDoors = this._initialProps.filter((p) => p.type === PROP_DOOR && p.reclosable);
    this._initialZones = new Map((this.zones ?? []).map((z) => [z, {
      open: !!z.open,
      stocked: z.stocked,
    }]));
  }

  /**
   * Restore every piece of world state mutated during a run.
   *
   * Doors, window boards and the secret panel are removed from `props` rather
   * than toggled, so resetting only counters leaves both collision and visuals
   * in the previous game. Rebuilding from the captured authored list restores
   * their original order while retaining scenery added later (planet dressing
   * is mounted after generation and is not run state).
   */
  resetRunState() {
    if (!this._initialProps) return;

    const laterProps = this.props.filter((p) => !this._initialPropSet.has(p));
    this.props.length = 0;
    this.props.push(...this._initialProps, ...laterProps);

    for (const b of this.barriers ?? []) {
      b.boards = [...b.boards, ...b.broken].sort((a, c) => a.y - c.y);
      b.broken.length = 0;
      b.progress = 0;
      b.working = false;
    }
    for (const [zone, state] of this._initialZones ?? []) {
      zone.open = state.open;
      if (state.stocked === undefined) delete zone.stocked;
      else zone.stocked = state.stocked;
    }
    this._index();
  }

  /**
   * Where a pad should sit, sampled before the terrain exists.
   *
   * setPads runs before generate(), so this cannot ask the heightfield -- it
   * evaluates the same shape function directly at the footprint's corners and
   * centre and takes the mean, which puts the pad in the ground rather than
   * perched on the highest corner.
   */
  _padHeight(b) {
    const f = this.field;
    const pts = [
      [b.minX, b.minZ], [b.maxX, b.minZ], [b.minX, b.maxZ], [b.maxX, b.maxZ],
      [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2],
    ];
    // Temporarily clear pads so the sample is of bare terrain, not of a
    // half-built set of pads influencing each other.
    const saved = f.pads;
    f.pads = [];
    let sum = 0;
    for (const [x, z] of pts) sum += f._shape(x, z);
    f.pads = saved;
    return sum / pts.length;
  }

  /**
   * Lay out the site: a handful of buildings, with ground between them.
   *
   * Buildings are chosen first because everything else defers to them -- the
   * terrain flattens under their pads, and the trees and clutter fill whatever
   * is left. Doing it the other way round gives you buildings sunk into hills
   * with a tree growing through the lobby.
   */
  _scatterProps() {
    const plan = this.plan;

    buildComplex(plan, this.props);
    this.drummerTower = buildDrummerTower(plan, this.props);
    addFurnishings(plan, this.props);
    buildParkour(plan, this.props);

    // Zones are the rooms. The rest of the game asks the world "what area is
    // this and what does it cost", and it should not have to know that an area
    // is a room in a floorplan rather than a building in a field.
    this.zones = plan.rooms.map((r) => ({
      id: r.id, site: r, x: r.cx, z: r.cz,
      tier: r.tier, label: r.label,
      // A room may declare itself already open, which is how the versus map
      // says "nothing here is bought". Everywhere else, only the start room is.
      open: r.open ?? (r.id === plan.start),
      outdoor: r.outdoor,
    }));
    // The ground outside the shell is a zone too, once its free door is opened.
    // There is no room behind it -- no slab, no roof, no walls -- but the rest
    // of the game asks zones where to put bodies and what to stock, and the
    // perimeter has to be able to answer both. Deliberately not added to
    // `sites` below: those are building footprints, and insideBuilding() saying
    // yes to open ground would put the outdoor scatter and the spawn checks
    // both on the wrong side of the wall.
    if (plan.outside) {
      this.zones.push({
        id: plan.outside.id, site: plan.outside,
        x: plan.outside.cx, z: plan.outside.cz,
        tier: plan.outside.tier, label: plan.outside.label,
        open: false, outdoor: true, exterior: true,
      });
    }

    this.startZone = this.zones.find((z) => z.id === plan.start);
    /**
     * Authored spawn points, or null on a generated map.
     *
     * A versus map cannot leave spawning to findSpawn's outward spiral: that
     * finds *somewhere legal*, which on a mirrored map is as likely to be six
     * metres behind the player who just killed you as anywhere else.
     */
    // Height comes off the room's slab, not off the terrain: the floor stands
    // SLAB_LIFT proud of the levelled ground, and spawning at grade drops a
    // player inside their own floor for the resolver to shove back out of.
    this.spawns = plan.spawns
      ? plan.spawns.map((s) => {
        const room = plan.rooms.find((r) => s.x >= r.minX && s.x <= r.maxX
          && s.z >= r.minZ && s.z <= r.maxZ);
        return { ...s, y: room ? room.floorY : this.heightAt(s.x, s.z) };
      })
      : null;
    // Kept under the old name so placement helpers that ask for footprints
    // still work.
    this.sites = plan.rooms;

    // Barriers are read back off the boards that were just emitted, so the
    // window a zombie tears at is the same geometry that stops a bullet.
    // The boards stay either way -- they are what fills a window opening, and
    // without them the shell has 36 holes in it. What the versus map does not
    // get is them being *registered* as barriers, because a barrier is
    // something that can be torn down. There are no zombies here to tear at
    // one, and the only thing a player could do with a ground-floor window is
    // pickaxe their way out of the arena onto open terrain, where the other
    // player cannot follow and they can still shoot back in.
    this.barriers = this.mapId === MAP_ARENA ? [] : collectBarriers(this.props, plan.rooms);

    // Authored hard cover. addFurnishings caps outdoor pieces at knee height,
    // for the good reason that anything taller in a walled yard is a step
    // toward the top of the wall -- but that leaves a 44m road with nothing on
    // it but crates. These are placed by hand, out in the middle where they
    // cannot be climbed into anything.
    // The wall round the lot. Four runs, each a single box: there is nothing
    // behind it to see and nothing in it to walk through, so it needs no
    // openings and no window band.
    const f = plan.fence;
    if (f) {
      const y = plan.rooms[0]?.floorY ?? this.heightAt(f.minX, f.minZ);
      const t = f.thickness;
      const runs = [
        [f.minX - t, f.minZ - t, f.maxX + t, f.minZ],
        [f.minX - t, f.maxZ, f.maxX + t, f.maxZ + t],
        [f.minX - t, f.minZ, f.minX, f.maxZ],
        [f.maxX, f.minZ, f.maxX + t, f.maxZ],
      ];
      for (const [minX, minZ, maxX, maxZ] of runs) {
        this.props.push({
          type: PROP_WALLSEG,
          x: (minX + maxX) / 2, y, z: (minZ + maxZ) / 2,
          rot: 0, scale: 1, height: f.height, seed: 0.5,
          sx: maxX - minX, sy: f.height, sz: maxZ - minZ,
          material: 'shell',
          collider: {
            kind: 'box',
            minX, minY: y, minZ, maxX, maxY: y + f.height, maxZ,
          },
        });
      }
    }

    // Vehicles. The prop carries a `model` name and nothing else about how it
    // is drawn -- the renderer picks that up and scales the art into this box.
    // The box is what the game actually agrees on, so it is decided here.
    for (const v of plan.vehicles ?? []) {
      const y = this.heightAt(v.x, v.z);
      this.props.push({
        type: PROP_VEHICLE, model: v.model,
        x: v.x, y, z: v.z,
        rot: v.rot ?? 0, scale: 1, height: v.sy, seed: 0.5,
        sx: v.sx, sy: v.sy, sz: v.sz,
        collider: {
          kind: 'box',
          minX: v.x - v.sx / 2, minY: y, minZ: v.z - v.sz / 2,
          maxX: v.x + v.sx / 2, maxY: y + v.sy, maxZ: v.z + v.sz / 2,
        },
      });
    }

    for (const c of plan.cover ?? []) {
      const room = plan.rooms.find((r) => c.x >= r.minX && c.x <= r.maxX
        && c.z >= r.minZ && c.z <= r.maxZ);
      this._addContainer(c.x, c.z, 0,
        { floorY: room?.floorY, alongX: c.alongX, tint: c.tint });
    }

    this._scatterOutdoors();
  }

  /**
   * Tear one board off a barrier.
   *
   * Breaking is a removal, not a flag: the board leaves the prop set entirely,
   * so movement, bullets and line of sight all agree it is gone without any of
   * them needing to know barriers exist.
   *
   * @returns true if a board came off this tick
   */
  breakBoard(barrier, dt) {
    const board = workBarrier(barrier, dt);
    if (!board) return false;
    const i = this.props.indexOf(board);
    if (i >= 0) this.props.splice(i, 1);
    this._index();
    return true;
  }

  /** Nail a board back up. @returns the restored board prop, or null */
  repair(barrier) {
    const board = repairBarrier(barrier);
    if (!board) return null;
    this.props.push(board);
    this._index();
    return board;
  }

  /**
   * Open a door: drop its collider and re-index.
   *
   * Re-indexing the whole prop set on a purchase is a few milliseconds once
   * per door, which is far cheaper than adding a "removed" check to the raycast
   * and collision inner loops that run thousands of times a frame.
   */
  openDoor(door) {
    const i = this.props.indexOf(door);
    if (i < 0) return false;
    this.props.splice(i, 1);
    this._index();
    const zn = this.zones?.find((z) => z.id === door.zone);
    if (zn) zn.open = true;
    return true;
  }

  /** Remove the tower machine after its one-shot explosion. */
  destroyBananaVendingMachine() {
    const machine = this.props.find((prop) => (
      prop.towerPart === 'banana-vending-machine'
    ));
    if (!machine) return false;
    this.props.splice(this.props.indexOf(machine), 1);
    this._index();
    return true;
  }

  /** Put a free refuge shutter back after it has been opened. */
  closeDoor(door) {
    if (!door?.reclosable || this.props.includes(door)) return false;
    this.props.push(door);
    this._index();
    const zone = this.zones?.find((z) => z.id === door.zone);
    // A closed enclosure is not eligible for enemy spawning. It remains
    // stocked; opening it again must never duplicate its rewards.
    if (zone) zone.open = false;
    return true;
  }

  /** True if (x, z) falls inside a building footprint, plus an optional margin. */
  insideBuilding(x, z, margin = 0) {
    for (const b of this.sites ?? []) {
      if (x >= b.minX - margin && x <= b.maxX + margin
        && z >= b.minZ - margin && z <= b.maxZ + margin) return true;
    }
    return false;
  }

  /**
   * A point inside an area the player has already opened.
   *
   * Enemies spawned on a ring around the player land wherever that ring falls,
   * which on a floorplan means outside the complex or inside a room nobody has
   * bought yet -- and then they path into the back of a locked door forever.
   * Spawning inside the opened region is what guarantees a route exists,
   * because the player walked it themselves.
   *
   * @returns {{x,y,z}|null}
   */
  spawnInOpenArea(px, pz, minDist, maxDist) {
    const open = (this.zones ?? []).filter((z) => z.open);
    if (!open.length) return null;

    // Two passes. The first honours the caller's stand-off; the second drops it.
    //
    // The stand-off is written for an open field -- spawn something 22 to 44
    // metres away so it walks in rather than appearing on top of you. No point
    // inside a single 25x15 room can satisfy that, so the first wave found
    // nowhere legal, fell back to the outdoor ring, and put every zombie
    // somewhere it could never reach the player: sixty seconds of wave one with
    // nothing arriving, no damage taken and no coins earned. Indoors the
    // opened area IS the constraint, and it is usually smaller than the ring.
    for (const relaxed of [false, true]) {
      const lo = relaxed ? 2.5 : minDist;
      const hi = relaxed ? Infinity : maxDist;

      for (let attempt = 0; attempt < 48; attempt++) {
        const zn = open[Math.floor(Math.random() * open.length)];
        const r = zn.site;
        const x = r.minX + 1.5 + Math.random() * Math.max(0.1, (r.maxX - r.minX) - 3);
        const z = r.minZ + 1.5 + Math.random() * Math.max(0.1, (r.maxZ - r.minZ) - 3);

        const d = Math.hypot(x - px, z - pz);
        if (d < lo || d > hi) continue;

        const y = r.floorY ?? this.heightAt(x, z);
        // Real clearance, not merely a body-sized gap. A room this densely
        // furnished has pockets between a desk and a wall that a body fits in
        // but cannot walk out of, and something spawned in one is stuck there.
        if (this.blocksAt(x, y, z, 0.9, 1.8)) continue;
        return { x, y, z };
      }
    }
    return null;
  }

  /**
   * A clear spot on the floor of some room, for anything that should be found
   * indoors rather than in a field.
   *
   * @param filter optional (room) => boolean, to restrict which rooms qualify
   */
  spotInRooms(filter = null, clearance = 0.8, avoid = [], minApart = 4) {
    const rooms = (this.plan?.rooms ?? []).filter((r) => !filter || filter(r));
    if (!rooms.length) return null;

    for (let attempt = 0; attempt < 200; attempt++) {
      const r = rooms[Math.floor(Math.random() * rooms.length)];
      // Any storey, not just the ground one. An upper floor with nothing worth
      // walking up to is a floor nobody walks up to, however well it is
      // furnished -- and the stairs are the one piece of the map that makes a
      // fight move vertically.
      const levels = levelsOf(r);
      const y = r.outdoor ? r.floorY : levels[Math.floor(Math.random() * levels.length)];

      const x = r.minX + 1.6 + Math.random() * Math.max(0.1, (r.maxX - r.minX) - 3.2);
      const z = r.minZ + 1.6 + Math.random() * Math.max(0.1, (r.maxZ - r.minZ) - 3.2);
      if (this.blocksAt(x, y, z, clearance, 1.6)) continue;
      // And on floor, not over the stairwell: the hole in an upper slab is
      // clear of obstructions in exactly the way an open shaft is.
      if (this.supportHeight(x, z, y, clearance) < y - 0.05) continue;

      let clash = false;
      for (const a of avoid) {
        if (Math.hypot(x - a.x, z - a.z) < minApart) { clash = true; break; }
      }
      if (clash) continue;

      return { x, y, z, room: r };
    }
    return null;
  }

  /** Every unopened door, for the HUD and the interaction check. */
  doors() {
    return this.props.filter((p) => p.type === PROP_DOOR);
  }

  /** Closed doors plus any opened shutter that can still be closed again. */
  interactableDoors() {
    const out = this.doors();
    for (const door of this._reclosableDoors ?? []) {
      if (!out.includes(door)) out.push(door);
    }
    return out;
  }

  /**
   * Choose building footprints.
   *
   * Deterministic from the seed and computed before the heightfield runs, so
   * the pads can be levelled as part of generating the terrain rather than
   * carved out of it afterwards.
   */
  _chooseSites() {
    const s = this.seed;
    const sites = [];
    const margin = 18;

    for (let i = 0; i < 240 && sites.length < BUILDING_COUNT; i++) {
      const w = 14 + rand2(i, 3, s + 201) * 12;
      const d = 12 + rand2(i, 5, s + 202) * 11;
      const x = margin + rand2(i, 7, s + 203) * (SIZE - margin * 2 - w);
      const z = margin + rand2(i, 11, s + 204) * (SIZE - margin * 2 - d);

      const minX = x, minZ = z, maxX = x + w, maxZ = z + d;

      // Keep a walkable street between neighbours, and keep the spawn plaza
      // clear so the player never starts inside a lobby.
      const cx = SIZE / 2, cz = SIZE / 2;
      if (minX < cx + 14 && maxX > cx - 14 && minZ < cz + 14 && maxZ > cz - 14) continue;

      let clash = false;
      for (const o of sites) {
        if (minX < o.maxX + STREET && maxX > o.minX - STREET
          && minZ < o.maxZ + STREET && maxZ > o.minZ - STREET) { clash = true; break; }
      }
      if (clash) continue;

      sites.push({
        i: sites.length, minX, minZ, maxX, maxZ,
        floors: 2 + Math.floor(rand2(i, 13, s + 205) * 3),
        // Filled in once the terrain exists.
        y: 0,
      });
    }
    return sites;
  }

  /**
   * Outside the walls.
   *
   * Deliberately empty. The forest and the yard full of crates were a second
   * map competing with the first: they pulled the fight out of the building,
   * they were where most of the glitching happened, and they made the complex
   * read as a shed someone left in a wood. The facility is the level now, and
   * what is outside it is scenery you look at through a window.
   */
  /**
   * Dress the ground outside the shell.
   *
   * This used to be empty on purpose, and the purpose was sound: open ground
   * with nothing on it is open ground you can be shot across, and that is what
   * makes leaving the building a decision. What was missing is that a bare
   * plain does not read as a *place* -- the complex looked like it had been
   * dropped on a golf course.
   *
   * So the dressing is deliberately a perimeter rather than a scatter. Pieces
   * sit in a ring outside the shell and nothing is placed in the open middle
   * distance, which keeps the crossing honest: cover exists where a compound
   * would actually have it -- at the walls, at the approach, at the corners --
   * and the run between two buildings is still a run.
   *
   * Every piece is skipped rather than forced if it would land inside the
   * building, off the pad, on a slope, or on top of something already there.
   * A missing sandbag is invisible; a sandbag inside a wall is a bug report.
   */
  _scatterOutdoors() {
    if (this.mapId === MAP_ARENA) return;   // the versus map is authored by hand

    const bounds = this.siteBounds ?? {
      minX: SIZE * 0.13, minZ: SIZE * 0.16,
      maxX: SIZE * 0.87, maxZ: SIZE * 0.84,
    };
    const x0 = bounds.minX, z0 = bounds.minZ;
    const x1 = bounds.maxX, z1 = bounds.maxZ;
    const OUT = 4.5;    // how far outside the shell the ring sits

    // What goes where, in ring coordinates. `t` runs 0..1 along each edge.
    const EDGE_KIT = [
      { model: 'kit_sandsack',      sx: 2.0, sy: 0.9, sz: 1.0, every: 0.24, jitter: 0.05 },
      { model: 'kit_concreteblock', sx: 1.6, sy: 1.0, sz: 0.8, every: 0.31, jitter: 0.04 },
      { model: 'kit_barrier',       sx: 3.0, sy: 1.1, sz: 0.6, every: 0.47, jitter: 0.03 },
    ];
    // One of each, at the corners, so the compound has landmarks to navigate by.
    const CORNER_KIT = [
      { model: 'kit_snipertower',  sx: 3.4, sy: 6.5, sz: 3.4 },
      { model: 'kit_radiostation', sx: 3.0, sy: 5.0, sz: 3.0 },
      { model: 'kit_gastank',      sx: 2.6, sy: 3.0, sz: 2.6 },
      { model: 'kit_medictent',    sx: 4.0, sy: 2.6, sz: 3.2 },
    ];

    const edges = [
      { ax: x0 - OUT, az: z0 - OUT, bx: x1 + OUT, bz: z0 - OUT },   // north
      { ax: x1 + OUT, az: z0 - OUT, bx: x1 + OUT, bz: z1 + OUT },   // east
      { ax: x1 + OUT, az: z1 + OUT, bx: x0 - OUT, bz: z1 + OUT },   // south
      { ax: x0 - OUT, az: z1 + OUT, bx: x0 - OUT, bz: z0 - OUT },   // west
    ];

    let n = 0;
    edges.forEach((e, ei) => {
      for (const kit of EDGE_KIT) {
        for (let t = 0.08 + (ei * 0.06); t < 0.94; t += kit.every) {
          const j = rand2(ei, Math.round(t * 100), this.seed + 91) - 0.5;
          const x = e.ax + (e.bx - e.ax) * (t + j * kit.jitter);
          const z = e.az + (e.bz - e.az) * (t + j * kit.jitter);
          // Face the wall: the long axis runs along the edge it defends.
          const rot = (e.ax === e.bx) ? Math.PI / 2 : 0;
          if (this._placeKit(kit, x, z, rot)) n++;
        }
      }
    });

    // Corners, pulled a little further out so a tower is not against the wall.
    const corners = [
      [x0 - OUT * 1.6, z0 - OUT * 1.6], [x1 + OUT * 1.6, z0 - OUT * 1.6],
      [x1 + OUT * 1.6, z1 + OUT * 1.6], [x0 - OUT * 1.6, z1 + OUT * 1.6],
    ];
    corners.forEach(([x, z], i) => {
      const kit = CORNER_KIT[i % CORNER_KIT.length];
      // A landmark is worth a search. These are the tallest things outside the
      // shell and the only pieces a player navigates by, so one unlucky metre of
      // slope should not delete the tower entirely -- which is exactly what a
      // single attempt did: all four corners came back empty on every seed.
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const dx = Math.sign(x - cx), dz = Math.sign(z - cz);
      for (const step of [0, 2, -2, 4, -4, 6]) {
        if (this._placeKit(kit, x + dx * step, z + dz * step, i * Math.PI / 2)) { n++; break; }
      }
    });

    // Light poles on the long edges, spaced wider than the cover so they read
    // as infrastructure rather than as more clutter.
    for (let t = 0.2; t < 0.9; t += 0.28) {
      for (const [ax, az, bx, bz] of [
        [x0 - OUT, z0 - OUT, x1 + OUT, z0 - OUT],
        [x0 - OUT, z1 + OUT, x1 + OUT, z1 + OUT],
      ]) {
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        if (this._placeKit({ model: 'kit_lightpole', sx: 0.6, sy: 5.0, sz: 0.6 }, x, z, 0)) n++;
      }
    }

    this.outdoorKit = n;
  }

  /**
   * Stand one kit piece on the ground, or decline to.
   *
   * Returns false rather than throwing or forcing: the caller is walking a ring
   * and every position is a suggestion. The checks are the whole value here --
   * inside the shell, off the map, on a slope, or overlapping something already
   * placed are all ways to turn dressing into a bug.
   */
  _placeKit(kit, x, z, rot = 0) {
    const margin = 3;
    if (x < margin || z < margin || x > SIZE - margin || z > SIZE - margin) return false;
    if (this.insideBuilding(x, z, 1.5)) return false;

    // Keep the whole takeoff lane free of perimeter dressing. This check uses
    // the authored berth directly because the spatial prop index is not built
    // until scattering finishes.
    if (this.spaceportLanding) {
      const clearance = 6.6 + Math.max(kit.sx, kit.sz) * 0.5;
      if (Math.hypot(x - this.spaceportLanding.x, z - this.spaceportLanding.z) < clearance) return false;
    }

    // Flat enough to stand on. A tower on a 30-degree slope floats at one
    // corner and buries the other.
    const y = this.heightAt(x, z);
    const span = Math.max(kit.sx, kit.sz) * 0.5;
    for (const [dx, dz] of [[span, 0], [-span, 0], [0, span], [0, -span]]) {
      if (Math.abs(this.heightAt(x + dx, z + dz) - y) > 0.9) return false;
    }

    // Clear of anything already standing here.
    const near = this.propsNear(x, z, span + 1.2);
    for (const p of near) {
      if (Math.hypot(p.x - x, p.z - z) < span + (p.sx ? Math.max(p.sx, p.sz) * 0.5 : 0.8)) return false;
    }

    const hx = (rot ? kit.sz : kit.sx) * 0.5;
    const hz = (rot ? kit.sx : kit.sz) * 0.5;
    this.props.push({
      type: PROP_VEHICLE, model: kit.model,
      x, y, z, rot,
      sx: kit.sx, sy: kit.sy, sz: kit.sz,
      collider: {
        kind: 'box',
        minX: x - hx, minY: y - 0.3, minZ: z - hz,
        maxX: x + hx, maxY: y + kit.sy, maxZ: z + hz,
      },
    });
    return true;
  }

  _addTree(x, z, r) {
    const y = this.heightAt(x, z);
    const height = 6 + r * 7;
    const trunkR = 0.30 + r * 0.22;
    this.props.push({
      type: PROP_TREE, x, y, z,
      rot: r * Math.PI * 2,
      scale: 0.85 + r * 0.5,
      height,
      // Only the trunk blocks. Foliage is visual, so shots through a canopy
      // still connect -- leaves eating bullets reads as a bug to players.
      collider: { kind: 'cylinder', x, z, r: trunkR, y0: y, y1: y + height * 0.7 },
    });
  }

  _addRock(x, z, r) {
    const y = this.heightAt(x, z);
    const rad = 0.9 + r * 2.0;
    this.props.push({
      type: PROP_ROCK, x, y, z,
      rot: r * Math.PI * 2,
      scale: rad, height: rad * 1.3,
      collider: { kind: 'cylinder', x, z, r: rad * 0.8, y0: y - 0.5, y1: y + rad },
    });
  }

  /**
   * A 20ft box.
   *
   * `r` used to mean two things at once -- which way round it stands, and which
   * of the five paint jobs it wears -- which is fine for scatter and useless
   * for placing one by hand: asking for it side-on also picked the colour.
   * Both are overridable now, and `r` is only the fallback for whichever is
   * left unsaid.
   *
   * @param opts.floorY stand it on a room's slab rather than on raw terrain
   * @param opts.alongX force the orientation
   * @param opts.tint   force the paint, 0..4
   */
  _addContainer(x, z, r, opts = {}) {
    const y = opts.floorY ?? this.heightAt(x, z);
    const alongX = opts.alongX ?? (r > 0.5);
    const seed = opts.tint != null ? (opts.tint + 0.5) / 5 : r;
    const len = 6.1, wid = 2.44, hgt = 2.59;   // a real 20ft box, near enough
    const hx = (alongX ? len : wid) * 0.5;
    const hz = (alongX ? wid : len) * 0.5;
    this.props.push({
      type: PROP_CONTAINER, x, y, z,
      rot: alongX ? 0 : Math.PI / 2,
      scale: 1, height: hgt, seed,
      sx: hx * 2, sy: hgt, sz: hz * 2,
      // Art, fitted to the box below rather than deciding it. A missing model
      // leaves the collider standing with nothing drawn on it, which is the
      // trade made everywhere else here -- see render/models.js.
      model: 'kit_container01',
      collider: {
        kind: 'box',
        minX: x - hx, minY: y - 0.3, minZ: z - hz,
        maxX: x + hx, maxY: y + hgt, maxZ: z + hz,
      },
    });
  }

  _addBarrel(x, z, r) {
    const y = this.heightAt(x, z);
    const hgt = 0.88;
    this.props.push({
      type: PROP_BARREL, x, y, z,
      rot: r * Math.PI * 2, scale: 1, height: hgt, seed: r,
      sx: 0.64, sy: hgt, sz: 0.64,
      model: BARREL_MODELS[Math.floor(r * BARREL_MODELS.length) % BARREL_MODELS.length],
      collider: { kind: 'cylinder', x, z, r: 0.32, y0: y - 0.2, y1: y + hgt },
    });
  }

  _addCrate(x, z, r) {
    const y = this.heightAt(x, z);
    const sz = 0.8 + r * 0.7;
    this.props.push({
      type: PROP_CRATE, x, y, z,
      rot: r * Math.PI * 2,
      scale: sz, height: sz, seed: r,
      sx: sz, sy: sz, sz,
      model: r < 0.2 ? 'old_military_crate' : 'kit_woodenbox',
      collider: {
        kind: 'box',
        minX: x - sz / 2, minY: y - 0.2, minZ: z - sz / 2,
        maxX: x + sz / 2, maxY: y + sz, maxZ: z + sz / 2,
      },
    });
  }

  /** Bucket props by XZ cell for fast local queries. */
  _index() {
    this.buckets.clear();
    for (const p of this.props) {
      const c = p.collider;
      const minX = c.kind === 'box' ? c.minX : c.x - c.r;
      const maxX = c.kind === 'box' ? c.maxX : c.x + c.r;
      const minZ = c.kind === 'box' ? c.minZ : c.z - c.r;
      const maxZ = c.kind === 'box' ? c.maxZ : c.z + c.r;
      for (let j = Math.floor(minZ / BUCKET); j <= Math.floor(maxZ / BUCKET); j++) {
        for (let i = Math.floor(minX / BUCKET); i <= Math.floor(maxX / BUCKET); i++) {
          const k = i + ',' + j;
          let list = this.buckets.get(k);
          if (!list) { list = []; this.buckets.set(k, list); }
          list.push(p);
        }
      }
    }
  }

  /** Props whose bucket overlaps the given XZ circle. */
  propsNear(x, z, radius, out = []) {
    out.length = 0;
    for (let j = Math.floor((z - radius) / BUCKET); j <= Math.floor((z + radius) / BUCKET); j++) {
      for (let i = Math.floor((x - radius) / BUCKET); i <= Math.floor((x + radius) / BUCKET); i++) {
        const list = this.buckets.get(i + ',' + j);
        if (!list) continue;
        for (const p of list) if (!out.includes(p)) out.push(p);
      }
    }
    return out;
  }

  /**
   * The ladder a player can reach from this position, or null.
   *
   * The top check includes the inside edge of the hatch as well as the rails'
   * plane, so the same ladder can be used to come back down instead of being a
   * one-way trip.
   */
  ladderNear(x, y, z, range = 1.15) {
    const ladder = this.drummerTower?.ladder;
    if (!ladder || y < ladder.minY - 0.6 || y > ladder.maxY + 0.35) return null;
    const shaftDistance = Math.hypot(x - ladder.x, z - ladder.z);
    const topDistance = Math.hypot(x - ladder.topX, z - ladder.topZ);
    if (shaftDistance <= range || (y > ladder.deckY - 1.25 && topDistance <= range + 0.35)) {
      return ladder;
    }
    return null;
  }

  // ---------------------------------------------------------------- raycast

  /**
   * Trace against terrain and props; nearest hit wins.
   * @returns {{hit, distance, x, y, z, nx, ny, nz, prop}}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 400) {
    const ground = this.field.raycast(ox, oy, oz, dx, dy, dz, maxDist);
    let best = ground.hit ? ground.distance : maxDist;
    let hit = ground.hit ? {
      hit: true, distance: ground.distance,
      x: ground.x, y: ground.y, z: ground.z,
      nx: ground.nx, ny: ground.ny, nz: ground.nz, prop: null,
    } : null;

    // Walk the ray's buckets rather than testing every prop in the world.
    const seen = SCRATCH_A;
    seen.length = 0;
    const span = Math.min(best, maxDist);
    const steps = Math.ceil(span / BUCKET) + 1;
    for (let s = 0; s <= steps; s++) {
      const t = Math.min(span, s * BUCKET);
      const px = ox + dx * t, pz = oz + dz * t;
      for (let j = Math.floor((pz - BUCKET) / BUCKET); j <= Math.floor((pz + BUCKET) / BUCKET); j++) {
        for (let i = Math.floor((px - BUCKET) / BUCKET); i <= Math.floor((px + BUCKET) / BUCKET); i++) {
          const list = this.buckets.get(i + ',' + j);
          if (!list) continue;
          for (const p of list) {
            if (seen.includes(p)) continue;
            seen.push(p);
            const r = rayProp(ox, oy, oz, dx, dy, dz, p.collider, best);
            if (r && r.t < best) {
              best = r.t;
              hit = {
                hit: true, distance: r.t,
                x: ox + dx * r.t, y: oy + dy * r.t, z: oz + dz * r.t,
                nx: r.nx, ny: r.ny, nz: r.nz, prop: p,
              };
            }
          }
        }
      }
    }

    if (hit) return hit;
    return {
      hit: false, distance: maxDist,
      x: ox + dx * maxDist, y: oy + dy * maxDist, z: oz + dz * maxDist,
      nx: 0, ny: 1, nz: 0, prop: null,
    };
  }

  /** Unobstructed line between two points? */
  lineOfSight(x0, y0, z0, x1, y1, z1) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    return !this.raycast(x0, y0, z0, dx / len, dy / len, dz / len, len - 0.05).hit;
  }

  // -------------------------------------------------------------- collision

  /**
   * Push a vertical capsule out of any prop it overlaps. Boxes resolve along
   * their shallowest axis, which keeps sliding along a wall smooth rather than
   * snagging on corners.
   * @returns true if the position was moved
   */
  /**
   * Would a body standing here be inside something solid?
   *
   * "Solid" excludes anything low enough to climb, because those are handled by
   * supportHeight lifting the player onto them rather than by refusing the move.
   *
   * This exists because push-out resolution alone cannot hold a thin wall. A
   * resolver that waits until you are already inside and then shoves you toward
   * the nearest face will shove you straight out the far side the moment your
   * centre crosses the wall's midline -- which at sprint speed takes a single
   * tick through a 0.3m wall. Refusing the move in the first place is what
   * actually makes a wall a wall.
   */
  blocksAt(x, y, z, radius, height, stepUp = 0.65) {
    const near = this.propsNear(x, z, radius + 4, SCRATCH_B);
    for (const p of near) {
      const c = p.collider;
      const cy0 = c.kind === 'box' ? c.minY : c.y0;
      const cy1 = c.kind === 'box' ? c.maxY : c.y1;

      // Above your head, or entirely below your feet: not in the way.
      if (y + height <= cy0 || y >= cy1 - 0.05) continue;
      // Low enough to step onto rather than be stopped by.
      if (cy1 <= y + stepUp) continue;

      if (c.kind === 'cylinder') {
        const dx = x - c.x, dz = z - c.z;
        if (dx * dx + dz * dz < (c.r + radius) * (c.r + radius)) return true;
      } else if (x > c.minX - radius && x < c.maxX + radius
        && z > c.minZ - radius && z < c.maxZ + radius) {
        return true;
      }
    }
    return false;
  }

  resolveProps(pos, radius, height) {
    const near = this.propsNear(pos.x, pos.z, radius + 4, SCRATCH_B);
    let moved = false;

    for (const p of near) {
      const c = p.collider;
      const cy0 = c.kind === 'box' ? c.minY : c.y0;
      const cy1 = c.kind === 'box' ? c.maxY : c.y1;
      // Standing on top of it is not a collision.
      if (pos.y + height <= cy0 || pos.y >= cy1 - 0.05) continue;

      if (c.kind === 'cylinder') {
        const dx = pos.x - c.x, dz = pos.z - c.z;
        const d = Math.hypot(dx, dz);
        const minD = c.r + radius;
        if (d >= minD) continue;
        if (d < 1e-5) { pos.x += minD; moved = true; continue; }
        const push = (minD - d) / d;
        pos.x += dx * push;
        pos.z += dz * push;
        moved = true;
      } else {
        const minX = c.minX - radius, maxX = c.maxX + radius;
        const minZ = c.minZ - radius, maxZ = c.maxZ + radius;
        if (pos.x <= minX || pos.x >= maxX || pos.z <= minZ || pos.z >= maxZ) continue;

        // Only ever push out the side the body is already on.
        //
        // Pushing to the nearest face is the obvious rule and it is wrong: a
        // body pressed legitimately against the inside of a wall sits nearer
        // the *outer* face of the radius-expanded box, so the resolver shoves
        // it straight through and out of the building. Half the charge
        // directions escaped a sealed room that way. Comparing against the
        // solid's centre line instead means a resolver can never move a body
        // across the thing it is resolving against -- the worst it can do is
        // fail to separate, which is recoverable, rather than teleport someone
        // outside, which is not.
        const midX = (c.minX + c.maxX) / 2;
        const midZ = (c.minZ + c.maxZ) / 2;
        const dLeft = pos.x <= midX ? pos.x - minX : Infinity;
        const dRight = pos.x >= midX ? maxX - pos.x : Infinity;
        const dBack = pos.z <= midZ ? pos.z - minZ : Infinity;
        const dFront = pos.z >= midZ ? maxZ - pos.z : Infinity;

        // Downward is in the running too, and it has to be.
        //
        // Jump under a mezzanine and the top of your head enters the slab by a
        // couple of centimetres. Every horizontal way out of a slab that covers
        // a whole room is metres away, so the resolver picked one and fired the
        // body five metres sideways -- through the exterior wall and out of the
        // building. A head that has clipped a ceiling is two centimetres from
        // being resolved downward, and the shortest way out of a solid is the
        // only way out that is never a teleport.
        //
        // Only downward. Pushing a body UP out of something is how a resolver
        // puts people on top of the furniture and through the floor above;
        // standing on things is supportHeight's job, and it has rules about
        // what is climbable that this has no way to know.
        const dUp = pos.y + height - cy0;      // head into the underside

        const m = Math.min(dLeft, dRight, dBack, dFront, dUp);
        if (!Number.isFinite(m)) continue;
        if (m === dUp) pos.y = cy0 - height;
        else if (m === dLeft) pos.x = minX;
        else if (m === dRight) pos.x = maxX;
        else if (m === dBack) pos.z = minZ;
        else pos.z = maxZ;
        moved = true;
      }
    }
    return moved;
  }

  /**
   * Lowest solid underside above a body's feet: the ceiling it can jump into.
   *
   * The counterpart to supportHeight, and needed for the same reason. Without
   * it a jump under a floor slab ends with a head inside the slab, and the only
   * thing that then notices is the push-out resolver -- which sees a body
   * inside a room-sized box and looks for the nearest way out of it sideways.
   *
   * @returns Infinity when there is nothing overhead
   */
  ceilingAt(x, z, fromY, radius = 0.35) {
    let best = Infinity;
    const near = this.propsNear(x, z, radius + 2, SCRATCH_C);
    for (const p of near) {
      const c = p.collider;
      if (c.kind !== 'box') continue;
      if (x < c.minX - radius || x > c.maxX + radius) continue;
      if (z < c.minZ - radius || z > c.maxZ + radius) continue;
      // Only things genuinely overhead. A collider whose underside is at or
      // below the feet is the floor, or something being stood on.
      if (c.minY > fromY + 0.05 && c.minY < best) best = c.minY;
    }
    return best;
  }

  /**
   * Highest standable surface under a point: terrain, or the top of a box prop
   * it is over. Lets the player walk up onto crates and low ruins.
   *
   * `lift` is how far above the feet a surface may be and still count as
   * something you are standing on. On the ground it is the step height, which
   * is what walking onto a crate is. In the air it has to be much smaller, or
   * every jump ends with the jumper snapped up onto whatever they passed
   * beside -- and since the allowance is measured from wherever the feet
   * happen to be, "whatever they passed beside" includes the top of a wall.
   * Keep it in step with the `stepUp` handed to blocksAt: one decides what you
   * are stopped by and the other decides what you end up on top of, and they
   * have to agree or a body is refused a move and then lifted through it.
   */
  supportHeight(x, z, fromY, radius = 0.35, lift = 0.65) {
    let best = this.heightAt(x, z);
    const near = this.propsNear(x, z, radius + 2, SCRATCH_C);
    for (const p of near) {
      const c = p.collider;
      if (c.kind !== 'box') continue;
      if (x < c.minX - radius || x > c.maxX + radius) continue;
      if (z < c.minZ - radius || z > c.maxZ + radius) continue;
      if (c.maxY <= fromY + lift && c.maxY > best) best = c.maxY;
    }
    return best;
  }

  // --------------------------------------------------------------- spawning

  /** Open, walkable ground, spiralling outward from a preferred point. */
  findSpawn(cx = SIZE / 2, cz = SIZE / 2, maxRadius = 70) {
    for (let r = 0; r < maxRadius; r += 1.5) {
      const steps = Math.max(1, Math.floor(r * 4));
      for (let a = 0; a < steps; a++) {
        const ang = (a / steps) * Math.PI * 2;
        const x = cx + Math.cos(ang) * r;
        const z = cz + Math.sin(ang) * r;
        if (x < 10 || z < 10 || x > SIZE - 10 || z > SIZE - 10) continue;
        if (!this.isWalkable(x, z)) continue;

        const y = this.heightAt(x, z);
        const near = this.propsNear(x, z, 2.0, SCRATCH_C);
        let blocked = false;
        for (const p of near) {
          const c = p.collider;
          const cy0 = c.kind === 'box' ? c.minY : c.y0;
          const cy1 = c.kind === 'box' ? c.maxY : c.y1;
          if (y + 1.8 <= cy0 || y >= cy1) continue;
          const d = c.kind === 'box'
            ? Math.hypot(
              Math.max(c.minX - x, 0, x - c.maxX),
              Math.max(c.minZ - z, 0, z - c.maxZ))
            : Math.hypot(x - c.x, z - c.z) - c.r;
          if (d < 1.3) { blocked = true; break; }
        }
        if (blocked) continue;
        return { x, y, z };
      }
    }
    return { x: cx, y: this.heightAt(cx, cz), z: cz };
  }
}

const SCRATCH_A = [];
const SCRATCH_B = [];
const SCRATCH_C = [];

/** Ray against one prop collider. Returns {t, nx, ny, nz} or null. */
function rayProp(ox, oy, oz, dx, dy, dz, c, maxT) {
  if (c.kind === 'box') {
    const t = rayAABB(ox, oy, oz, dx, dy, dz, c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ);
    if (t < 0 || t > maxT) return null;
    const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
    const e = 1e-3;
    let nx = 0, ny = 0, nz = 0;
    if (Math.abs(px - c.minX) < e) nx = -1;
    else if (Math.abs(px - c.maxX) < e) nx = 1;
    else if (Math.abs(py - c.minY) < e) ny = -1;
    else if (Math.abs(py - c.maxY) < e) ny = 1;
    else if (Math.abs(pz - c.minZ) < e) nz = -1;
    else nz = 1;
    return { t, nx, ny, nz };
  }

  // Infinite cylinder in XZ, then clamped to its y span.
  const rx = ox - c.x, rz = oz - c.z;
  const a = dx * dx + dz * dz;

  if (a < 1e-9) {
    // Vertical ray: only a cap can be hit.
    if (Math.hypot(rx, rz) > c.r || Math.abs(dy) < 1e-9) return null;
    const capY = dy > 0 ? c.y0 : c.y1;
    const t = (capY - oy) / dy;
    if (t < 1e-4 || t > maxT) return null;
    return { t, nx: 0, ny: dy > 0 ? -1 : 1, nz: 0 };
  }

  const b = 2 * (rx * dx + rz * dz);
  const cc = rx * rx + rz * rz - c.r * c.r;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);

  let t = (-b - sq) / (2 * a);
  if (t < 1e-4) t = (-b + sq) / (2 * a);
  if (t < 1e-4 || t > maxT) return null;

  const y = oy + dy * t;
  if (y < c.y0 || y > c.y1) {
    // Missed the side wall within its span; try the caps.
    if (Math.abs(dy) < 1e-9) return null;
    const capY = y < c.y0 ? c.y0 : c.y1;
    const tc = (capY - oy) / dy;
    if (tc < 1e-4 || tc > maxT) return null;
    const px = ox + dx * tc - c.x, pz = oz + dz * tc - c.z;
    if (px * px + pz * pz > c.r * c.r) return null;
    return { t: tc, nx: 0, ny: capY === c.y1 ? 1 : -1, nz: 0 };
  }

  return { t, nx: (ox + dx * t - c.x) / c.r, ny: 0, nz: (oz + dz * t - c.z) / c.r };
}
