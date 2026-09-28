// Continuous heightfield terrain -- the replacement for the voxel grid.
//
// The single most important property here: the surface used for collision and
// hit registration is *the same triangulation that gets rendered*. Every cell
// of the grid is two triangles split along the (0,0)-(1,1) diagonal, and both
// heightAt() and raycast() evaluate those exact triangles. If collision used,
// say, bilinear interpolation while the mesh drew flat triangles, bullets would
// stop slightly off the visible ground -- the classic "I hit nothing" bug.
//
// Coordinates: x/z are world units, y is up. The grid has CELL-unit spacing and
// (N+1)^2 samples covering [0, SIZE] on both axes.

import { fbm2, value2, rand2 } from './noise.js';

// Arena is SIZE x SIZE world units. Prop scatter, spawn rings, the mesh and
// every placement pass derive from this, so it is the only number that has to
// move to resize the map.
export const SIZE = 384;
export const CELL = 1;          // metres per grid cell
export const N = SIZE / CELL;   // cells per side
export const MAX_HEIGHT = 70;

/** Height of the warehouse slab. Everything indoors is built up from here. */
export const FLOOR_Y = 2;

// Slopes steeper than this act as cliffs: you cannot walk up them.
export const MAX_WALK_SLOPE = Math.cos(52 * Math.PI / 180);

export const BIOME_GRASS = 0;
export const BIOME_ROCK = 1;
export const BIOME_SAND = 2;
export const BIOME_SNOW = 3;

export class Heightfield {
  constructor(seed = 1337, opts = {}) {
    this.seed = seed | 0;
    this.profile = opts.profile === 'cinder' || opts.profile === 'nyx' ? opts.profile : 'verdant';
    this.size = SIZE;
    this.cell = CELL;
    this.n = N;
    // (N+1)^2 corner samples.
    this.heights = new Float32Array((N + 1) * (N + 1));
    this.biome = new Uint8Array((N + 1) * (N + 1));
  }

  idx(i, j) { return j * (N + 1) + i; }

  /** Raw sample at a grid corner, clamped at the edges. */
  sample(i, j) {
    if (i < 0) i = 0; else if (i > N) i = N;
    if (j < 0) j = 0; else if (j > N) j = N;
    return this.heights[j * (N + 1) + i];
  }

  // ------------------------------------------------------------- generation

  /**
   * Building pads.
   *
   * A structure needs level ground under it, and levelling it after the fact
   * would leave the visible mesh disagreeing with the collision surface. So the
   * pads are handed in before generate() and the terrain is shaped around them:
   * dead flat inside the footprint, blended out over a short apron so the
   * building sits in the ground rather than on a plinth.
   *
   * @param pads [{ minX, minZ, maxX, maxZ, y, apron }]
   */
  setPads(pads) {
    this.pads = pads ?? [];
  }

  /**
   * Terrain shape: rolling ground outside, flat where a building stands.
   *
   * The outdoor relief is deliberately gentler than a landscape would be. This
   * is a map you fight across, and the buildings have to meet it at a sensible
   * angle -- dramatic hills would leave half of them buried and the other half
   * on stilts.
   */
  _shape(x, z) {
    const s = this.seed;

    // Broad ground swell plus a little detail. No ridges: creases read as
    // scenery, and everything here has to stay traversable.
    const swell = fbm2(x * 0.0055, z * 0.0055, s, 4);
    const roll = fbm2(x * 0.02, z * 0.02, s + 101, 3);
    const detail = fbm2(x * 0.08, z * 0.08, s + 303, 2);

    let h = FLOOR_Y - 3 + swell * 14 + roll * 4.5 + detail * 0.7;

    if (this.profile === 'cinder') {
      // Cinder is a broken volcanic shelf: broad caldera shoulders with rough,
      // low lava channels between them. Pads still win below, so the outpost
      // and its landing berth remain honestly walkable.
      const dx = x - SIZE * 0.53, dz = z - SIZE * 0.49;
      const ring = Math.exp(-Math.pow((Math.hypot(dx, dz) - 43) / 8.5, 2));
      const fissure = Math.abs(fbm2(x * 0.035, z * 0.035, s + 701, 3) * 2 - 1);
      h = FLOOR_Y - 5 + swell * 10 + roll * 3.2 + ring * 9 - Math.pow(1 - fissure, 4) * 3.5;
    } else if (this.profile === 'nyx') {
      // Nyx has long glacial pressure ridges instead of Cinder's circular
      // caldera. The directional terms make its silhouette visibly different
      // even before the blue-white surface treatment is applied.
      const shelf = fbm2(x * 0.010, z * 0.026, s + 811, 4);
      const ridge = Math.abs(fbm2(x * 0.012 + z * 0.004, z * 0.018, s + 919, 3) * 2 - 1);
      h = FLOOR_Y - 4 + shelf * 13 + roll * 2.4 + Math.pow(ridge, 3) * 8;
    }

    // A rim so the arena is visually enclosed and you cannot walk off it.
    const edge = Math.min(x, z, SIZE - x, SIZE - z);
    if (edge < 24) {
      const t = 1 - Math.max(0, edge) / 24;
      h += Math.pow(t, 2.0) * 34;
    }

    // Pads win over everything, blended out across their apron.
    for (const p of this.pads ?? []) {
      const dx = Math.max(p.minX - x, 0, x - p.maxX);
      const dz = Math.max(p.minZ - z, 0, z - p.maxZ);
      const d = Math.hypot(dx, dz);
      const apron = p.apron ?? 6;
      if (d >= apron) continue;
      // Smoothstep so the apron is a gentle ramp, not a step you cannot climb.
      const t = d / apron;
      const k = t * t * (3 - 2 * t);
      h = p.y * (1 - k) + h * k;
    }

    return Math.max(0.5, Math.min(MAX_HEIGHT, h));
  }

  generate() {
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const x = i * CELL, z = j * CELL;
        this.heights[this.idx(i, j)] = this._shape(x, z);
      }
    }
    this._classify();
  }

  /**
   * Level a rectangular pad, easing back to the natural ground over `feather`
   * units so a building sits on the hillside instead of on a plateau with
   * cliffs for edges.
   *
   * Callers flatten every pad first and re-run classify() once at the end,
   * because biome depends on local steepness and a pad changes the slope of
   * the cells around it as well as under it.
   */
  flatten(x0, z0, x1, z1, height, feather = 5) {
    const i0 = Math.max(0, Math.floor((x0 - feather) / CELL));
    const i1 = Math.min(N, Math.ceil((x1 + feather) / CELL));
    const j0 = Math.max(0, Math.floor((z0 - feather) / CELL));
    const j1 = Math.min(N, Math.ceil((z1 + feather) / CELL));

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = i * CELL, z = j * CELL;
        // How far outside the pad this sample sits; zero anywhere inside it.
        const dx = Math.max(0, x0 - x, x - x1);
        const dz = Math.max(0, z0 - z, z - z1);
        const d = Math.hypot(dx, dz);
        if (d > feather) continue;

        const t = d / feather;
        const k = 1 - t * t * (3 - 2 * t);   // 1 on the pad, 0 at the apron edge
        const at = this.idx(i, j);
        this.heights[at] += (height - this.heights[at]) * k;
      }
    }
  }

  /** Re-derive biomes. Public so a caller can flatten pads and then refresh. */
  classify() { this._classify(); }

  /**
   * Surface material per corner.
   *
   * Pads read as concrete apron; the ground between buildings is grass turning
   * to rock where it steepens. That split is what stops the site looking like
   * one continuous car park.
   */
  _classify() {
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const x = i * CELL, z = j * CELL;
        const h = this.sample(i, j);
        const dx = (this.sample(i + 1, j) - this.sample(i - 1, j)) / (2 * CELL);
        const dz = (this.sample(i, j + 1) - this.sample(i, j - 1)) / (2 * CELL);
        const steep = Math.hypot(dx, dz);

        let b = this.profile === 'cinder' ? BIOME_SAND
          : this.profile === 'nyx' ? BIOME_SNOW
            : BIOME_GRASS;
        if (steep > 0.85) b = BIOME_ROCK;
        if (this.profile === 'verdant' && h > 30 && steep < 1.2) b = BIOME_SNOW;
        // Hard-standing around every building, a little past its footprint.
        for (const p of this.pads ?? []) {
          if (x > p.minX - 3 && x < p.maxX + 3 && z > p.minZ - 3 && z < p.maxZ + 3) {
            b = BIOME_ROCK;
            break;
          }
        }
        this.biome[this.idx(i, j)] = b;
      }
    }
  }

  // -------------------------------------------------------------- sampling

  /**
   * Exact surface height at a world position.
   *
   * Picks the same triangle the mesher emits and evaluates its plane, so this
   * agrees with the rendered geometry to floating-point precision.
   */
  heightAt(x, z) {
    const fx = x / CELL, fz = z / CELL;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; else if (i > N - 1) i = N - 1;
    if (j < 0) j = 0; else if (j > N - 1) j = N - 1;

    const u = Math.min(1, Math.max(0, fx - i));
    const v = Math.min(1, Math.max(0, fz - j));

    const h00 = this.sample(i, j);
    const h10 = this.sample(i + 1, j);
    const h01 = this.sample(i, j + 1);
    const h11 = this.sample(i + 1, j + 1);

    // Diagonal runs (0,0)-(1,1). u > v is the triangle containing (1,0).
    if (u > v) return h00 + (h10 - h00) * u + (h11 - h10) * v;
    return h00 + (h11 - h01) * u + (h01 - h00) * v;
  }

  /** Unit surface normal, taken from the same triangle plane. */
  normalAt(x, z, out = {}) {
    const fx = x / CELL, fz = z / CELL;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; else if (i > N - 1) i = N - 1;
    if (j < 0) j = 0; else if (j > N - 1) j = N - 1;

    const u = Math.min(1, Math.max(0, fx - i));
    const v = Math.min(1, Math.max(0, fz - j));

    const h00 = this.sample(i, j);
    const h10 = this.sample(i + 1, j);
    const h01 = this.sample(i, j + 1);
    const h11 = this.sample(i + 1, j + 1);

    // Plane gradients for the triangle this point falls in.
    let dhdu, dhdv;
    if (u > v) { dhdu = h10 - h00; dhdv = h11 - h10; }
    else { dhdu = h11 - h01; dhdv = h01 - h00; }

    // Surface y = h(u,v); normal is (-dh/dx, 1, -dh/dz).
    const nx = -dhdu / CELL, ny = 1, nz = -dhdv / CELL;
    const l = Math.hypot(nx, ny, nz) || 1;
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  }

  /** True when the ground at this spot is shallow enough to stand and walk on. */
  isWalkable(x, z) {
    return this.normalAt(x, z, TMP_N).y >= MAX_WALK_SLOPE;
  }

  inBounds(x, z) {
    return x >= 0 && z >= 0 && x <= SIZE && z <= SIZE;
  }

  // --------------------------------------------------------------- raycast

  /**
   * Ray against the terrain surface.
   *
   * Walks the grid cell by cell in XZ (2D DDA) and does an exact ray-triangle
   * test in each. Stepping by a fixed distance instead would let a shallow ray
   * skim over a ridge it should have hit.
   *
   * @returns {{hit:boolean, distance:number, x,y,z, nx,ny,nz}}
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 400) {
    const miss = {
      hit: false, distance: maxDist,
      x: ox + dx * maxDist, y: oy + dy * maxDist, z: oz + dz * maxDist,
      nx: 0, ny: 1, nz: 0,
    };

    // Below the surface already: treat as an immediate hit so nothing can be
    // shot from inside a hill.
    if (this.inBounds(ox, oz) && oy < this.heightAt(ox, oz)) {
      const n = this.normalAt(ox, oz, {});
      return { hit: true, distance: 0, x: ox, y: oy, z: oz, nx: n.x, ny: n.y, nz: n.z };
    }

    let i = Math.floor(ox / CELL);
    let j = Math.floor(oz / CELL);

    const stepI = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepJ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

    const tDeltaI = stepI !== 0 ? Math.abs(CELL / dx) : Infinity;
    const tDeltaJ = stepJ !== 0 ? Math.abs(CELL / dz) : Infinity;

    const bound = (o, k, step) => (step > 0 ? (k + 1) * CELL - o : o - k * CELL);
    let tMaxI = stepI !== 0 ? bound(ox, i, stepI) * Math.abs(1 / dx) : Infinity;
    let tMaxJ = stepJ !== 0 ? bound(oz, j, stepJ) * Math.abs(1 / dz) : Infinity;

    let t = 0;
    const guard = Math.ceil(maxDist / CELL) * 2 + 8;

    for (let step = 0; step < guard; step++) {
      // Test the current cell before advancing.
      if (i >= 0 && j >= 0 && i < N && j < N) {
        const hit = this._cellHit(i, j, ox, oy, oz, dx, dy, dz, maxDist);
        if (hit) return hit;
      } else if (t > maxDist) {
        break;
      }

      // A ray heading up and already above the tallest terrain can never
      // come back down to it.
      if (dy > 0 && oy + dy * t > MAX_HEIGHT) break;

      if (tMaxI < tMaxJ) { i += stepI; t = tMaxI; tMaxI += tDeltaI; }
      else { j += stepJ; t = tMaxJ; tMaxJ += tDeltaJ; }

      if (t > maxDist) break;
      if (!isFinite(t)) break;
    }

    return miss;
  }

  /** Ray against the two triangles of one cell. Nearest wins. */
  _cellHit(i, j, ox, oy, oz, dx, dy, dz, maxDist) {
    const x0 = i * CELL, z0 = j * CELL;
    const x1 = x0 + CELL, z1 = z0 + CELL;

    const h00 = this.sample(i, j);
    const h10 = this.sample(i + 1, j);
    const h01 = this.sample(i, j + 1);
    const h11 = this.sample(i + 1, j + 1);

    // Same winding as the mesher: (v00,v11,v10) and (v00,v01,v11).
    let best = null;
    const a = rayTri(ox, oy, oz, dx, dy, dz,
      x0, h00, z0, x1, h11, z1, x1, h10, z0);
    if (a !== null && a <= maxDist) best = a;

    const b = rayTri(ox, oy, oz, dx, dy, dz,
      x0, h00, z0, x0, h01, z1, x1, h11, z1);
    if (b !== null && b <= maxDist && (best === null || b < best)) best = b;

    if (best === null) return null;

    const px = ox + dx * best, py = oy + dy * best, pz = oz + dz * best;
    const n = this.normalAt(px, pz, {});
    return { hit: true, distance: best, x: px, y: py, z: pz, nx: n.x, ny: n.y, nz: n.z };
  }
}

const TMP_N = {};

/**
 * Moller-Trumbore ray/triangle intersection.
 * @returns distance along the ray, or null. Backfaces count -- a shot from
 *          under an overhang should still stop on the ground above it.
 */
export function rayTri(
  ox, oy, oz, dx, dy, dz,
  ax, ay, az, bx, by, bz, cx, cy, cz,
) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;

  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;

  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-6 || u > 1 + 1e-6) return null;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;

  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-5 ? t : null;
}
