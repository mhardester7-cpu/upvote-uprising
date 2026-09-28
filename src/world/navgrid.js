// Navigation: a flow field over the walkable floor, one layer per storey.
//
// Enemies used to walk straight at the player. In an open field that is
// indistinguishable from pathfinding; inside a furnished building it means they
// jam against the first desk between them and their target and orbit it
// forever. A wave would spawn, close to about seven metres, and never arrive.
//
// A flow field rather than per-enemy A*, because every enemy in this game wants
// the same thing: to reach the player. One breadth-first sweep outward from the
// player labels every reachable cell with its distance, and then an enemy needs
// no path of its own -- it reads the cheapest neighbouring cell and steps to
// it. One sweep serves the whole horde, and it costs the same whether there are
// four zombies or forty.
//
// Three things make this more than a single grid:
//
//   STOREYS. A building with a mezzanine is not a 2D problem. One grid sampled
//   at the ground floor reads every stair tread above the step-up limit as a
//   wall, hides the upper storey completely, and -- worst of all -- projects a
//   player standing on the balcony down onto the floor below, so the field
//   leads the horde to the spot *underneath* them and they mill about there.
//   So there is one layer per storey, and the layers are joined where a stair
//   flight joins them. The sweep runs over the whole stack at once, which keeps
//   it one BFS for the whole horde.
//
//   THE GROUND OUTSIDE. The grid used to stop three metres past the plan, which
//   is enough for a body standing in a doorway and nothing else. Zombies come
//   from outside and break in, so the ground they cross to reach a window has
//   to be navigable too.
//
//   WINDOWS. A boarded window is not passable and never becomes passable -- the
//   sill is over a metre up, so even a stripped opening is a wall to anything
//   that walks. Rather than pretend otherwise, the sweep seeds a second front
//   on the *outside* face of every window that serves a room the player can be
//   reached from. Outside cells then flow to their nearest usable window, and a
//   finite distance anywhere on this grid means the same thing everywhere: a
//   route to the player exists, whether it ends in a doorway or a barrier.
//
// Doors and barriers change what is walkable, so the mask is rebuilt when the
// world says the geometry moved rather than every frame.

import { FLOOR_H, PROP_STAIR } from './complex.js';

const UNREACHED = 0xffff;
export { UNREACHED as NAV_UNREACHED };

/**
 * Where the outside field starts counting.
 *
 * Outside cells are seeded well above any distance the indoor sweep can
 * produce, so "which of these two cells is closer to the player" is still
 * answered by a plain comparison, and a caller can tell at a glance whether a
 * body is on the inside of the problem or the outside of it.
 */
export const NAV_OUTSIDE = 32000;

/**
 * Probe size for the walkable mask.
 *
 * Deliberately smaller than an enemy's half-width. Using the true radius closes
 * every doorway the grid samples slightly off-centre, and a floorplan whose
 * doors are all shut is worse than one where a body occasionally scrapes a
 * frame.
 */
const PROBE_R = 0.22;
const PROBE_H = 1.7;

/**
 * How far past the plan the grid reaches, so the approach ground is in it.
 *
 * A floor, not the whole story. Twelve metres covered the ground a zombie
 * crosses to reach a window, which used to be the only reason anything was
 * outside at all. The escape door made the entire perimeter somewhere the
 * *player* can stand, and a player on ground the grid does not cover is a
 * player the flow field cannot lead anything to -- the horde falls back to
 * walking straight at them, which means jamming against the outside of the
 * shell. So the grid is grown to the whole world below, and this is only what
 * it reaches for when the world turns out to be smaller than the plan plus a
 * margin.
 */
const PAD = 12;

/** Reused by the apron probe, which runs a few thousand times per rebuild. */
const SCRATCH = [];

export class NavGrid {
  /**
   * @param world the World to read geometry from
   * @param cell  grid spacing; small enough to fit a doorway, large enough to
   *              keep the sweep cheap
   */
  constructor(world, cell = 0.7) {
    this.world = world;
    this.cell = cell;

    const b = world.plan?.bounds;
    this.bounds = b ?? { x0: 0, z0: 0, x1: world.size, z1: world.size };
    // Span the whole world, not the plan plus a margin. Anywhere the player can
    // stand has to be somewhere the field can lead a body to, and the player is
    // clamped to the world rather than to the complex -- so the world is the
    // honest extent. It costs about a sixth more cells than the old margin did.
    const size = world.size ?? Math.max(this.bounds.x1, this.bounds.z1) + PAD;
    this.x0 = Math.min(0, this.bounds.x0 - PAD);
    this.z0 = Math.min(0, this.bounds.z0 - PAD);
    this.nx = Math.ceil((Math.max(size, this.bounds.x1 + PAD) - this.x0) / cell) + 1;
    this.nz = Math.ceil((Math.max(size, this.bounds.z1 + PAD) - this.z0) / cell) + 1;

    const rooms = world.plan?.rooms ?? [];
    this.floorY = rooms[0]?.floorY ?? 0;
    /** One layer per storey the tallest room has. */
    this.levels = Math.max(1, ...rooms.map((r) => r.storeys ?? 1));

    this.layer = this.nx * this.nz;
    const n = this.layer * this.levels;
    this.blocked = new Uint8Array(n);
    this.dist = new Uint16Array(n);
    this.queue = new Int32Array(n);

    /** Stair flights, and the cell pairs they join. */
    this.flights = [];
    this.portals = new Map();

    this.rebuild();
  }

  index(i, j, k = 0) { return k * this.layer + j * this.nx + i; }
  toCellX(x) { return Math.round((x - this.x0) / this.cell); }
  toCellZ(z) { return Math.round((z - this.z0) / this.cell); }
  worldX(i) { return this.x0 + i * this.cell; }
  worldZ(j) { return this.z0 + j * this.cell; }

  /** Walking surface of storey k. */
  levelY(k) { return this.floorY + FLOOR_H * k; }

  /** Which storey a body at this height is standing on. */
  levelFor(y) {
    const k = Math.round((y - this.floorY) / FLOOR_H);
    return Math.max(0, Math.min(this.levels - 1, k));
  }

  inGrid(i, j) { return i >= 0 && j >= 0 && i < this.nx && j < this.nz; }

  // ----------------------------------------------------------------- masking

  /**
   * Re-derive which cells a body can stand in, on every storey.
   *
   * The ground layer covers the whole padded extent; the upper layers cover
   * only the rooms that actually have that storey, because everywhere else
   * there is no floor to stand on. That is what keeps a three-layer grid from
   * costing three times a one-layer grid: the upper layers are a few hundred
   * cells each, not tens of thousands.
   */
  rebuild() {
    this.blocked.fill(1);
    this._sample(0, 0, this.nx - 1, this.nz - 1);
    this._collectFlights();
    this.dirty = false;
  }

  /**
   * Re-derive one patch of the mask.
   *
   * A board coming off a window changes about two square metres of the map, and
   * during a breach that happens every second and a half per zombie. Re-deriving
   * the whole thing each time is tens of milliseconds of hitch for a change that
   * fits in a hundred cells, which is exactly the sort of cost that only shows
   * up once there are fourteen of them working at once.
   */
  rebuildAt(minX, minZ, maxX, maxZ) {
    const i0 = Math.max(0, this.toCellX(minX) - 1);
    const j0 = Math.max(0, this.toCellZ(minZ) - 1);
    const i1 = Math.min(this.nx - 1, this.toCellX(maxX) + 1);
    const j1 = Math.min(this.nz - 1, this.toCellZ(maxZ) + 1);
    if (i1 < i0 || j1 < j0) return;

    for (let k = 0; k < this.levels; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) this.blocked[this.index(i, j, k)] = 1;
      }
    }
    this._sample(i0, j0, i1, j1);
    // Stairs do not move, but a flight's cells were forced open by the last
    // full rebuild and have just been re-derived from geometry that still calls
    // them walls.
    this._collectFlights();
  }

  /**
   * Fill in the mask over a cell range, on every storey.
   *
   * The ground layer covers the whole padded extent; the upper layers cover
   * only the rooms that actually have that storey, because everywhere else
   * there is no floor to stand on. That is what keeps a three-layer grid from
   * costing three times a one-layer grid: the upper layers are a few hundred
   * cells each, not tens of thousands.
   */
  _sample(i0, j0, i1, j1) {
    const w = this.world;

    // How far the built world actually reaches. Beyond it there is nothing but
    // terrain, and asking blocksAt about bare ground is the single most
    // expensive thing this sweep can do, so the question is skipped entirely.
    let px0 = Infinity, pz0 = Infinity, px1 = -Infinity, pz1 = -Infinity;
    for (const p of w.props ?? []) {
      const c = p.collider;
      if (!c) continue;
      const a0 = c.kind === 'box' ? c.minX : c.x - c.r;
      const a1 = c.kind === 'box' ? c.maxX : c.x + c.r;
      const b0 = c.kind === 'box' ? c.minZ : c.z - c.r;
      const b1 = c.kind === 'box' ? c.maxZ : c.z + c.r;
      if (a0 < px0) px0 = a0;
      if (a1 > px1) px1 = a1;
      if (b0 < pz0) pz0 = b0;
      if (b1 > pz1) pz1 = b1;
    }
    const near = PROBE_R + 1;

    const y0 = this.floorY;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = this.worldX(i), z = this.worldZ(j);
        const built = x > px0 - near && x < px1 + near && z > pz0 - near && z < pz1 + near;
        let free = !built || !w.blocksAt(x, y0, z, PROBE_R, PROBE_H);
        // Outside the shell the floor is terrain rather than a slab, so a cell
        // is only walkable if the ground there is both level with the building
        // and shallow enough to walk. Without this the field would route the
        // horde off the edge of the pad and down a hillside.
        if (free && !this._inPlan(x, z)) free = this._standableGround(x, z, y0);
        this.blocked[this.index(i, j, 0)] = free ? 0 : 1;
      }
    }

    for (let k = 1; k < this.levels; k++) {
      for (const r of w.plan?.rooms ?? []) {
        if ((r.storeys ?? 1) <= k) continue;
        const ly = r.floorY + FLOOR_H * k;
        const a0 = Math.max(i0, this.toCellX(r.minX));
        const a1 = Math.min(i1, this.toCellX(r.maxX));
        const b0 = Math.max(j0, this.toCellZ(r.minZ));
        const b1 = Math.min(j1, this.toCellZ(r.maxZ));
        for (let j = b0; j <= b1; j++) {
          for (let i = a0; i <= a1; i++) {
            const x = this.worldX(i), z = this.worldZ(j);
            // A mezzanine is a floor with a hole in it -- the stairwell. Asking
            // what would hold a body up here is what tells the two apart.
            if (w.supportHeight(x, z, ly, PROBE_R) < ly - 0.6) continue;
            if (w.blocksAt(x, ly, z, PROBE_R, PROBE_H)) continue;
            this.blocked[this.index(i, j, k)] = 0;
          }
        }
      }
    }
  }

  _inPlan(x, z) {
    const b = this.bounds;
    return x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1;
  }

  _standableGround(x, z, y) {
    const w = this.world;
    return w.inBounds(x, z) && w.isWalkable(x, z) && Math.abs(w.heightAt(x, z) - y) < 2.5;
  }

  // ------------------------------------------------------------------ stairs

  /**
   * Find the stair flights and wire the layers together at them.
   *
   * A flight is a run of short boxes, which is the only kind of slope this
   * world has. They are read back off the props rather than the plan so that
   * however the builder chooses to arrange a stairwell -- one flight per
   * storey, switchbacks, a shared well -- navigation follows it.
   */
  _collectFlights() {
    this.flights.length = 0;
    this.portals.clear();

    const rooms = this.world.plan?.rooms ?? [];
    const byRoom = new Map();
    for (const p of this.world.props ?? []) {
      if (p.type !== PROP_STAIR || !p.collider) continue;
      let list = byRoom.get(p.room);
      if (!list) { list = []; byRoom.set(p.room, list); }
      list.push(p);
    }

    for (const [roomId, steps] of byRoom) {
      const r = rooms.find((x) => x.id === roomId);
      if (!r) continue;
      steps.sort((a, b) => a.collider.maxY - b.collider.maxY);

      // Split the room's treads into flights. Consecutive treads of one flight
      // are adjacent, rise by one riser, and keep going the same way; anything
      // else -- a jump in height, a jump across the well, a reversal at a
      // half-landing -- is the next flight starting.
      let run = [steps[0]];
      for (let i = 1; i < steps.length; i++) {
        const s = steps[i], prev = run[run.length - 1];
        const gap = Math.hypot(s.x - prev.x, s.z - prev.z);
        const rise = s.collider.maxY - prev.collider.maxY;
        let sameWay = true;
        if (run.length >= 2) {
          const p2 = run[run.length - 2];
          sameWay = (prev.x - p2.x) * (s.x - prev.x) + (prev.z - p2.z) * (s.z - prev.z) > 0;
        }
        if (gap < 2.0 && rise < 1.0 && sameWay) run.push(s);
        else { this._addFlight(r, run); run = [s]; }
      }
      this._addFlight(r, run);
    }
  }

  _addFlight(r, steps) {
    // Two or three boxes is a kerb or a plinth, not a way upstairs.
    if (steps.length < 3) return;

    const bottom = steps[0], top = steps[steps.length - 1];
    const clamp = (k) => Math.max(0, Math.min(this.levels - 1, k));
    const from = clamp(Math.floor((bottom.collider.maxY - r.floorY) / FLOOR_H));
    const to = clamp(Math.round((top.collider.maxY - r.floorY) / FLOOR_H));
    if (to <= from) return;

    let dx = top.x - bottom.x, dz = top.z - bottom.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) return;
    dx /= len; dz /= len;

    // The treads read as a wall to the base mask -- every riser but the first
    // stands higher than the step-up window a standing body gets. That is the
    // right answer for someone standing on the floor below and the wrong one
    // for someone walking up, so the run is re-sampled from the treads
    // themselves: each one asks what would be in the way of a body *on* it,
    // where the next riser is a single step and a wall is still a wall.
    //
    // Sampling rather than simply opening the footprint matters. A flight sits
    // in a corner, its bottom tread flush with the wall behind it, so blanket
    // opening punches a doorway through the outside of the building -- and the
    // field then walks the whole horde into the back of it.
    for (const s of steps) {
      const c = s.collider;
      const ty = c.maxY;
      const i0 = Math.max(0, Math.ceil((c.minX - this.x0) / this.cell));
      const i1 = Math.min(this.nx - 1, Math.floor((c.maxX - this.x0) / this.cell));
      const j0 = Math.max(0, Math.ceil((c.minZ - this.z0) / this.cell));
      const j1 = Math.min(this.nz - 1, Math.floor((c.maxZ - this.z0) / this.cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = this.worldX(i), z = this.worldZ(j);
          if (this.world.blocksAt(x, ty, z, PROBE_R, PROBE_H)) continue;
          // The lower storey owns the whole run; the upper one owns only the
          // treads level with its floor, which is where you step off.
          const level = ty > r.floorY + FLOOR_H * to - 0.5 ? to : from;
          this.blocked[this.index(i, j, level)] = 0;
        }
      }
    }

    this._openApron(r, steps, from, to);

    const foot = this._flightEnd(steps, from, false)
      ?? this._openCellNear(bottom.x + dx * this.cell, bottom.z + dz * this.cell, from);
    const head = this._flightEnd(steps, to, true)
      ?? this._openCellNear(top.x + dx, top.z + dz, to);
    if (!foot || !head) return;
    foot.y = r.floorY + FLOOR_H * from;
    foot.level = from;
    head.y = r.floorY + FLOOR_H * to;
    head.level = to;

    const a = this.index(this.toCellX(foot.x), this.toCellZ(foot.z), from);
    const b = this.index(this.toCellX(head.x), this.toCellZ(head.z), to);

    const flight = { room: r.id, from, to, foot, head };
    this.flights.push(flight);
    // A portal is a two-way edge between the foot and the head. Reading it in
    // either direction is what lets the horde come down as well as go up.
    //
    // A cell can hold more than one: put two flights in one stairwell and the
    // head of the lower is a stride from the foot of the upper, which is the
    // whole point of a stairwell. Keyed to a list so the second one does not
    // silently replace the first and strand the top storey.
    this._addPortal(a, { index: b, to: head, flight, up: true });
    this._addPortal(b, { index: a, to: foot, flight, up: false });
  }

  /**
   * Open the floor immediately beside a flight.
   *
   * A staircase fills its well wall to wall, and the mask inflates every solid
   * by a body's radius before deciding whether a cell is free -- so the row of
   * cells running alongside the treads can round *into* the staircase and come
   * out blocked. One such row is a wall, and a wall down the open side of a
   * stairwell seals the flight off from the floor it serves: the sweep arrives
   * down the stairs, fills the well, and stops there. Measured on seed 4242,
   * that left a player on the second floor with a field that reached twenty
   * cells and a horde of six that never found the building.
   *
   * The staircase has to be the only thing in the cell. Anything else standing
   * there -- a wall, a locker, the balustrade -- is a real obstruction and the
   * cell stays shut. And there has to be a floor: the apron of a flight
   * arriving at a mezzanine is slab on three sides and open shaft on the
   * fourth.
   */
  _openApron(r, steps, from, to) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const s of steps) {
      const c = s.collider;
      if (c.minX < minX) minX = c.minX;
      if (c.maxX > maxX) maxX = c.maxX;
      if (c.minZ < minZ) minZ = c.minZ;
      if (c.maxZ > maxZ) maxZ = c.maxZ;
    }

    const pad = this.cell + PROBE_R;
    const i0 = Math.max(0, this.toCellX(minX - pad));
    const i1 = Math.min(this.nx - 1, this.toCellX(maxX + pad));
    const j0 = Math.max(0, this.toCellZ(minZ - pad));
    const j1 = Math.min(this.nz - 1, this.toCellZ(maxZ + pad));

    for (const level of [from, to]) {
      const ly = r.floorY + FLOOR_H * level;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = this.index(i, j, level);
          if (!this.blocked[k]) continue;
          const x = this.worldX(i), z = this.worldZ(j);
          if (this.world.supportHeight(x, z, ly, PROBE_R) < ly - 0.6) continue;
          if (this._blockedByOther(x, ly, z, r.id)) continue;
          this.blocked[k] = 0;
        }
      }
    }
  }

  /** Is anything other than this room's own staircase in the way here? */
  _blockedByOther(x, y, z, roomId) {
    for (const p of this.world.propsNear(x, z, PROBE_R + 2, SCRATCH)) {
      if (p.type === PROP_STAIR && p.room === roomId) continue;
      const c = p.collider;
      if (!c) continue;
      const cy0 = c.kind === 'box' ? c.minY : c.y0;
      const cy1 = c.kind === 'box' ? c.maxY : c.y1;
      if (y + PROBE_H <= cy0 || y >= cy1 - 0.05) continue;
      if (cy1 <= y + 0.65) continue;
      if (c.kind === 'cylinder') {
        const dx = x - c.x, dz = z - c.z;
        if (dx * dx + dz * dz < (c.r + PROBE_R) * (c.r + PROBE_R)) return true;
      } else if (x > c.minX - PROBE_R && x < c.maxX + PROBE_R
        && z > c.minZ - PROBE_R && z < c.maxZ + PROBE_R) {
        return true;
      }
    }
    return false;
  }

  _addPortal(cell, portal) {
    let list = this.portals.get(cell);
    if (!list) { list = []; this.portals.set(cell, list); }
    list.push(portal);
  }

  /** The cheapest way off this cell that crosses a storey, or null. */
  _bestPortal(cell, under) {
    const list = this.portals.get(cell);
    if (!list) return null;
    let best = null, bestD = under;
    for (const p of list) {
      if (this.blocked[p.index]) continue;
      const d = this.dist[p.index];
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /**
   * The first open cell over a flight, working in from one end.
   *
   * The end of a flight is not the end of its bottom tread: that tread is flush
   * with the wall behind it and its cells round into the wall, so the usable
   * end is the first tread far enough in to own a cell of its own.
   */
  _flightEnd(steps, level, reverse) {
    const order = reverse ? [...steps].reverse() : steps;
    for (const s of order) {
      const c = s.collider;
      const i0 = Math.max(0, Math.ceil((c.minX - this.x0) / this.cell));
      const i1 = Math.min(this.nx - 1, Math.floor((c.maxX - this.x0) / this.cell));
      const j0 = Math.max(0, Math.ceil((c.minZ - this.z0) / this.cell));
      const j1 = Math.min(this.nz - 1, Math.floor((c.maxZ - this.z0) / this.cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (this.blocked[this.index(i, j, level)]) continue;
          return { x: this.worldX(i), z: this.worldZ(j) };
        }
      }
    }
    return null;
  }

  /** The nearest open cell to a point on one layer, searched outward. */
  _openCellNear(x, z, level, span = 3) {
    const ci = this.toCellX(x), cj = this.toCellZ(z);
    let best = null, bestD = Infinity;
    for (let j = cj - span; j <= cj + span; j++) {
      for (let i = ci - span; i <= ci + span; i++) {
        if (!this.inGrid(i, j)) continue;
        if (this.blocked[this.index(i, j, level)]) continue;
        const d = (i - ci) ** 2 + (j - cj) ** 2;
        if (d < bestD) { bestD = d; best = { x: this.worldX(i), z: this.worldZ(j) }; }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------- sweep

  /**
   * Sweep outward from a point, labelling every reachable cell with its
   * distance in steps.
   *
   * Four-connected on purpose: an eight-connected sweep will happily cut a
   * corner diagonally through the gap where two walls meet, which is a gap no
   * body fits through. Stair portals are followed as an extra edge, so the
   * sweep crosses storeys wherever the building lets a body cross them.
   *
   * @param ty the target's height, which decides the storey it is swept from
   * @param seeds extra fronts to start from once the target's own sweep is
   *              exhausted -- the outside faces of the windows a zombie can
   *              break in through. A seed with an `inside` point is only used
   *              when that point turned out to be reachable, so a window into a
   *              room nobody has opened is not offered as a way in.
   */
  update(tx, tz, ty = this.floorY, seeds = null) {
    const { nx, nz, dist, blocked, queue } = this;
    dist.fill(UNREACHED);

    const level = this.levelFor(ty);
    let si = Math.max(0, Math.min(nx - 1, this.toCellX(tx)));
    let sj = Math.max(0, Math.min(nz - 1, this.toCellZ(tz)));

    // The target itself may be inside something -- standing against a wall
    // rounds into it. Start from the nearest open cell instead of giving up.
    let start = this.index(si, sj, level);
    if (blocked[start]) {
      let best = -1, bestD = Infinity;
      for (let j = Math.max(0, sj - 3); j <= Math.min(nz - 1, sj + 3); j++) {
        for (let i = Math.max(0, si - 3); i <= Math.min(nx - 1, si + 3); i++) {
          const k = this.index(i, j, level);
          if (blocked[k]) continue;
          const d = (i - si) ** 2 + (j - sj) ** 2;
          if (d < bestD) { bestD = d; best = k; }
        }
      }
      // A player who has fallen through the world, or is standing on a storey
      // that has no floor near them, still has to be chased. Drop to the
      // ground layer rather than leaving the whole horde with no field.
      if (best < 0 && level !== 0) {
        const k = this.index(si, sj, 0);
        if (!blocked[k]) best = k;
      }
      if (best < 0) return false;
      start = best;
    }

    let head = 0, tail = 0;
    queue[tail++] = start;
    dist[start] = 0;
    tail = this._flood(head, tail);

    // Everything the player's own sweep could not reach is either behind a door
    // nobody has bought or outside the walls. The outside gets its own front,
    // one per window that opens into somewhere the player can be reached from,
    // all at the same cost -- so an outside body walks to its *nearest* way in
    // rather than every one of them queueing at the same pane.
    if (seeds?.length) {
      head = tail = 0;
      for (const s of seeds) {
        if (s.inside && !this._reachedNear(s.inside)) continue;
        const i = this.toCellX(s.x), j = this.toCellZ(s.z);
        if (!this.inGrid(i, j)) continue;
        const k = this.index(i, j, s.level ?? 0);
        if (blocked[k] || dist[k] !== UNREACHED) continue;
        dist[k] = NAV_OUTSIDE;
        queue[tail++] = k;
      }
      this._flood(head, tail);
    }
    return true;
  }

  /**
   * Did the sweep reach anywhere near this point?
   *
   * Asked of the floor just inside a window, where a cell either way decides
   * whether the whole horde has a way into a room. The mask samples on a
   * seven-tenths grid with a probe narrower than a body, so the single cell a
   * point rounds to is a coarser answer than the question deserves.
   */
  _reachedNear(p, span = 2) {
    const level = this.levelFor(p.y ?? this.floorY);
    const ci = this.toCellX(p.x), cj = this.toCellZ(p.z);
    for (let j = cj - span; j <= cj + span; j++) {
      for (let i = ci - span; i <= ci + span; i++) {
        if (!this.inGrid(i, j)) continue;
        if (this.dist[this.index(i, j, level)] < UNREACHED) return true;
      }
    }
    return false;
  }

  /** The breadth-first sweep proper, over whatever is already on the queue. */
  _flood(head, tail) {
    const { nx, nz, layer, dist, blocked, queue, portals } = this;
    while (head < tail) {
      const k = queue[head++];
      const level = (k / layer) | 0;
      const c = k - level * layer;
      const j = (c / nx) | 0;
      const i = c - j * nx;
      const d = dist[k] + 1;

      if (i > 0) { const n = k - 1; if (!blocked[n] && dist[n] === UNREACHED) { dist[n] = d; queue[tail++] = n; } }
      if (i < nx - 1) { const n = k + 1; if (!blocked[n] && dist[n] === UNREACHED) { dist[n] = d; queue[tail++] = n; } }
      if (j > 0) { const n = k - nx; if (!blocked[n] && dist[n] === UNREACHED) { dist[n] = d; queue[tail++] = n; } }
      if (j < nz - 1) { const n = k + nx; if (!blocked[n] && dist[n] === UNREACHED) { dist[n] = d; queue[tail++] = n; } }

      const list = portals.get(k);
      if (list) {
        for (const p of list) {
          if (blocked[p.index] || dist[p.index] !== UNREACHED) continue;
          dist[p.index] = d;
          queue[tail++] = p.index;
        }
      }
    }
    return tail;
  }

  /** Distance in steps from a world position to the last swept target. */
  distanceAt(x, z, y = this.floorY) {
    const i = this.toCellX(x), j = this.toCellZ(z);
    if (!this.inGrid(i, j)) return UNREACHED;
    return this.dist[this.index(i, j, this.levelFor(y))];
  }

  /** True if a body here has any route to the last swept target at all. */
  reachable(x, z, y = this.floorY) {
    return this.distanceAt(x, z, y) < UNREACHED;
  }

  /** True if the only route from here is in through a window. */
  outside(x, z, y = this.floorY) {
    return this.distanceAt(x, z, y) >= NAV_OUTSIDE;
  }

  /**
   * Which way to walk from here, as a world position one step downhill.
   *
   * Returns null when this spot has no route -- the caller should fall back to
   * heading straight at the target rather than standing still, because a
   * zombie doing nothing reads as broken and a zombie walking into a wall at
   * least reads as a zombie.
   *
   * A step carries the storey it lands on, and when it crosses a stair flight
   * it carries the flight too, so the caller can commit the body to the climb
   * rather than re-deciding halfway up.
   */
  stepFrom(x, z, y = this.floorY) {
    const level = this.levelFor(y);
    const i = this.toCellX(x), j = this.toCellZ(z);
    if (i < 1 || j < 1 || i >= this.nx - 1 || j >= this.nz - 1) return null;

    const here = this.dist[this.index(i, j, level)];
    let best = here;
    let bi = -1, bj = -1, bk = -1;

    // Standing at the foot -- or head -- of a flight: take it.
    const mine = this._bestPortal(this.index(i, j, level), best);
    if (mine) {
      return {
        x: mine.to.x, z: mine.to.z, y: mine.to.y,
        level: mine.to.level, flight: mine.flight, up: mine.up,
      };
    }

    // Eight-connected when *reading* the field, so movement is not staircased,
    // but a diagonal is only taken when both of its orthogonal neighbours are
    // open -- that is what stops a body clipping the corner of a doorway.
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const k = this.index(i + di, j + dj, level);
        if (this.blocked[k]) continue;
        if (di && dj) {
          if (this.blocked[this.index(i + di, j, level)]
            || this.blocked[this.index(i, j + dj, level)]) continue;
        }
        const d = this.dist[k];
        if (d < best) { best = d; bi = i + di; bj = j + dj; bk = k; }
      }
    }

    if (bi < 0) return null;

    // The next cell is the foot of a flight and the flight is the cheap way on:
    // commit now rather than a metre later, so the body arrives at the treads
    // already lined up with them.
    const ahead = this._bestPortal(bk, this.dist[bk]);
    if (ahead) {
      return {
        x: ahead.to.x, z: ahead.to.z, y: ahead.to.y,
        level: ahead.to.level, flight: ahead.flight, up: ahead.up,
      };
    }

    return { x: this.worldX(bi), z: this.worldZ(bj), y: this.levelY(level), level };
  }
}
