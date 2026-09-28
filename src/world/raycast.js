// Ray primitives shared by hit registration.
//
// Terrain and prop tracing live in world/heightfield.js and world/world.js;
// what remains here is the box test used for entity hitboxes and AABB props.

const EPS = 1e-8;

/**
 * Slab test against an axis-aligned box.
 * @returns entry distance along the ray, or -1 for a miss. An origin already
 *          inside the box returns 0.
 */
export function rayAABB(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let tmin = 0;
  let tmax = Infinity;

  // x
  if (Math.abs(dx) < EPS) {
    if (ox < minX || ox > maxX) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv, t2 = (maxX - ox) * inv;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  // y
  if (Math.abs(dy) < EPS) {
    if (oy < minY || oy > maxY) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv, t2 = (maxY - oy) * inv;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }
  // z
  if (Math.abs(dz) < EPS) {
    if (oz < minZ || oz > maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv, t2 = (maxZ - oz) * inv;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }

  return tmin;
}
