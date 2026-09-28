// Window barriers: the way in.
//
// A boarded window is the load-bearing idea of this genre. It is what stops the
// map being a shooting gallery with a door in it:
//
//   It makes a room have a *front*. A room with four sealed walls is a place to
//   hide; a room with two barriers is a place to hold, and holding a place is
//   the whole activity.
//
//   It puts a clock on standing still. Boards come off one at a time, so a
//   barrier is a countdown you can see and hear, and the pressure builds in a
//   place rather than arriving all at once.
//
//   It gives the player something to do with a lull. Boards can be put back,
//   which is why the gap between waves is spent working instead of waiting.
//
// A barrier owns its boards; the boards are ordinary wall props with colliders,
// so a board that is still up stops a body and a bullet exactly as a wall does.
// Breaking one is a removal, not a flag -- there is no separate "is this
// passable" rule for anything to disagree about.

/** Seconds a zombie spends prising one board off. */
export const BOARD_TIME = 1.5;
/** How close a zombie has to be to work on a barrier. */
export const REACH = 2.2;
/** Points for putting a board back, which is what makes repairing worth doing. */
export const REPAIR_REWARD = 10;

export class Barrier {
  /**
   * @param room   the room this barrier opens into
   * @param boards the board props across the opening, bottom first
   */
  constructor(room, boards, x, y, z, axis) {
    this.room = room;
    this.x = x; this.y = y; this.z = z;
    /** 'x' or 'z' -- which way the wall runs, so a climber knows where to go. */
    this.axis = axis;

    /** Still standing, in the order they will be torn off. */
    this.boards = boards.slice();
    /** Removed, kept so they can be nailed back up. */
    this.broken = [];

    /** Progress on the board currently being worked, 0..1. */
    this.progress = 0;
    /**
     * Set while a zombie is actually prising at this barrier, for the audio,
     * the HUD, and the renderer's shaking board.
     *
     * It is cleared at the top of every tick and set again by whoever works
     * the barrier during it, so it means "right now" rather than "at some
     * point". It used to be set and never reset, which left every barrier that
     * had ever been touched permanently rattling.
     */
    this.working = false;
  }

  get open() { return this.boards.length === 0; }
  get intact() { return this.broken.length === 0; }

  /** How exposed this barrier is, 0 boarded to 1 wide open. */
  get breach() {
    const total = this.boards.length + this.broken.length;
    return total === 0 ? 1 : this.broken.length / total;
  }
}

/**
 * Group the loose board props into barriers.
 *
 * Boards are emitted per opening but arrive as a flat list, so they are
 * clustered by the wall they sit in and their position along it. Anything
 * within a board's width of its neighbour belongs to the same window.
 */
export function collectBarriers(props, rooms) {
  const byOpening = new Map();

  for (const p of props) {
    if (p.material !== 'board') continue;
    // Openings are axis-aligned, so the wall line plus the span along it
    // identifies one window uniquely.
    const alongX = p.sx > p.sz;
    const axis = alongX ? 'z' : 'x';
    const line = alongX ? p.z : p.x;
    const along = alongX ? p.x : p.z;
    const key = `${axis}:${line.toFixed(2)}:${along.toFixed(2)}`;
    if (!byOpening.has(key)) byOpening.set(key, []);
    byOpening.get(key).push(p);
  }

  const barriers = [];
  for (const boards of byOpening.values()) {
    // Lowest board first: a barrier is torn from the bottom, because that is
    // the one in the way of climbing through.
    boards.sort((a, b) => a.y - b.y);
    const first = boards[0];
    const room = rooms.find((r) => r.id === first.room) ?? null;
    if (!room) continue;
    barriers.push(new Barrier(
      room, boards, first.x, first.y, first.z,
      first.sx > first.sz ? 'z' : 'x',
    ));
  }
  return barriers;
}

/**
 * Forget last tick's work.
 *
 * `working` is a per-tick fact, not a latch: a renderer that shakes a board
 * while it is being prised at has to be told when the prising stops, and the
 * only moment anyone knows that is the tick where nobody worked it. Called once
 * at the top of the sim tick, before any enemy gets a chance to set it again.
 */
export function clearBarrierWork(barriers) {
  for (const b of barriers ?? []) b.working = false;
}

/**
 * Which way is *into* the room a barrier serves, as a unit vector.
 *
 * A window is in a wall, so there are only two answers, and the room's centre
 * decides which. Everything that has to stand at a window -- a zombie spawning
 * outside it, one climbing through it -- needs this, so it lives with the
 * barrier rather than being re-derived by each caller.
 */
export function barrierInward(b) {
  const r = b.room;
  if (!r) return { x: 0, z: 1 };
  if (b.axis === 'z') return { x: 0, z: Math.sign(r.cz - b.z) || 1 };
  return { x: Math.sign(r.cx - b.x) || 1, z: 0 };
}

/**
 * Advance one zombie's work on a barrier.
 *
 * Returns the board that came off this tick, or null. The caller removes it
 * from the world -- this module decides *when*, the world decides what that
 * means for collision, and neither needs to know the other's business.
 */
export function workBarrier(barrier, dt) {
  if (barrier.open) return null;
  barrier.working = true;
  barrier.progress += dt / BOARD_TIME;
  if (barrier.progress < 1) return null;

  barrier.progress = 0;
  const board = barrier.boards.shift();
  barrier.broken.push(board);
  return board;
}

/**
 * Nail one board back up.
 *
 * @returns the board prop to put back, or null if the barrier is already whole
 */
export function repairBarrier(barrier) {
  if (barrier.intact) return null;
  const board = barrier.broken.pop();
  barrier.boards.unshift(board);
  barrier.progress = 0;
  return board;
}

/** The nearest barrier of an open room that still has boards, or null. */
export function nearestIntactBarrier(barriers, x, z, maxDist = 1e9) {
  let best = null, bestD = maxDist * maxDist;
  for (const b of barriers) {
    if (b.open) continue;
    const d = (b.x - x) ** 2 + (b.z - z) ** 2;
    if (d < bestD) { bestD = d; best = b; }
  }
  return best;
}
