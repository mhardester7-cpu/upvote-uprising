// Architecture geometry: chamfered boxes, merged, with world-scale UVs.
//
// Two things were making the buildings read as voxel, and neither was polygon
// count.
//
// The first is that every edge was a razor-sharp 90 degrees. Nothing in the
// world has a perfectly sharp arris -- concrete is cast against a form and
// pulls a slight round, steel is rolled, timber is planed. That tiny chamfer
// catches a highlight along every edge, and a lit edge is the single strongest
// cue that a surface is a real object rather than a cell in a grid. This is the
// same reason the weapon models bevel their parts.
//
// The second is that the pieces were instanced copies of one unit cube scaled
// to size. That scales the UVs with the box, so a 6m wall and a 0.6m desk both
// got one tile of texture stretched over them -- the aggregate on the wall
// ended up ten times the size of the aggregate on the desk. Sizing UVs from
// world dimensions instead means a 5cm stone is a 5cm stone everywhere, which
// is what lets the eye judge scale at all.
//
// Instancing cannot do either of those, because both need the piece's real
// size at build time. So architecture is merged into one geometry per material
// instead: a few hundred boxes become a handful of draw calls, and each keeps
// its own bevel and its own texture scale.

import * as THREE from '../../vendor/three.module.js';

/**
 * A box with chamfered edges and UVs measured in world units.
 *
 * Written out face by face rather than by subdividing a cube, because a chamfer
 * needs its own narrow quads along each edge and its own normals -- the whole
 * point is that the bevel shades differently from the faces it joins.
 *
 * @param bevel chamfer width, clamped so it can never swallow a thin piece
 * @param tile  world size of one texture repeat
 */
export function chamferedBox(sx, sy, sz, bevel = 0.035, tile = 1) {
  const b = Math.min(bevel, sx * 0.32, sy * 0.32, sz * 0.32);
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const ix = hx - b, iy = hy - b, iz = hz - b;

  const pos = [];
  const nor = [];
  const uv = [];

  // One quad, wound counter-clockwise seen from outside.
  //
  // The winding is derived rather than trusted. Writing twenty-six quads by
  // hand and getting every corner order right is not a thing that happens: the
  // two X faces and half the chamfers were wound backwards, which face culling
  // then dropped -- so a wall or a desk vanished from the side you were
  // standing on and showed you the inside of its far face instead. The normal
  // is the thing that is actually known to be correct here, so the triangle
  // order is checked against it and reversed when the two disagree. A quad
  // written the wrong way round now costs nothing.
  const quad = (a, c, d, e, n, uw, uh) => {
    const ux = c[0] - a[0], uy = c[1] - a[1], uz = c[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const facing = (uy * vz - uz * vy) * n[0]
      + (uz * vx - ux * vz) * n[1]
      + (ux * vy - uy * vx) * n[2];
    const corners = facing >= 0
      ? [[a, 0, 0], [c, uw, 0], [d, uw, uh], [a, 0, 0], [d, uw, uh], [e, 0, uh]]
      : [[a, 0, 0], [d, uw, uh], [c, uw, 0], [a, 0, 0], [e, 0, uh], [d, uw, uh]];

    for (const [p, u, v] of corners) {
      pos.push(p[0], p[1], p[2]);
      nor.push(n[0], n[1], n[2]);
      uv.push(u, v);
    }
  };

  const uwX = sx / tile, uwY = sy / tile, uwZ = sz / tile;

  // ---- the six faces, inset by the chamfer -----------------------------
  quad([-ix, -iy, hz], [ix, -iy, hz], [ix, iy, hz], [-ix, iy, hz], [0, 0, 1], uwX, uwY);
  quad([ix, -iy, -hz], [-ix, -iy, -hz], [-ix, iy, -hz], [ix, iy, -hz], [0, 0, -1], uwX, uwY);
  quad([hx, -iy, -iz], [hx, -iy, iz], [hx, iy, iz], [hx, iy, -iz], [1, 0, 0], uwZ, uwY);
  quad([-hx, -iy, iz], [-hx, -iy, -iz], [-hx, iy, -iz], [-hx, iy, iz], [-1, 0, 0], uwZ, uwY);
  quad([-ix, hy, iz], [ix, hy, iz], [ix, hy, -iz], [-ix, hy, -iz], [0, 1, 0], uwX, uwZ);
  quad([-ix, -hy, -iz], [ix, -hy, -iz], [ix, -hy, iz], [-ix, -hy, iz], [0, -1, 0], uwX, uwZ);

  // ---- the twelve edge chamfers ---------------------------------------
  const s = Math.SQRT1_2;
  // Along X, at each Y/Z corner.
  for (const [sy_, sz_] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    quad(
      [-ix, iy * sy_, hz * sz_], [ix, iy * sy_, hz * sz_],
      [ix, hy * sy_, iz * sz_], [-ix, hy * sy_, iz * sz_],
      [0, s * sy_, s * sz_], uwX, b / tile,
    );
  }
  // Along Y, at each X/Z corner.
  for (const [sx_, sz_] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    quad(
      [ix * sx_, -iy, hz * sz_], [hx * sx_, -iy, iz * sz_],
      [hx * sx_, iy, iz * sz_], [ix * sx_, iy, hz * sz_],
      [s * sx_, 0, s * sz_], b / tile, uwY,
    );
  }
  // Along Z, at each X/Y corner.
  for (const [sx_, sy_] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    quad(
      [ix * sx_, hy * sy_, -iz], [hx * sx_, iy * sy_, -iz],
      [hx * sx_, iy * sy_, iz], [ix * sx_, hy * sy_, iz],
      [s * sx_, s * sy_, 0], b / tile, uwZ,
    );
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/**
 * Accumulates transformed geometry into one buffer per material.
 *
 * Merging rather than instancing is what buys the per-piece bevel and per-piece
 * UV scale; the cost is that a piece cannot be moved afterwards, which suits
 * architecture exactly.
 */
export class Merger {
  constructor(chunkSize = Infinity) {
    this.chunkSize = chunkSize;
    this.materialKeys = new Map();
    this.groups = new Map();
  }

  /** Add a chamfered box at a position, optionally rotated about Y. */
  addBox(key, { x, y, z, sx, sy, sz, rot = 0, bevel = 0.035, tile = 1 }) {
    const g = chamferedBox(sx, sy, sz, bevel, tile);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rot, 0)),
      new THREE.Vector3(1, 1, 1),
    );
    g.applyMatrix4(m);
    this.add(key, g);
  }

  /** Add an arbitrary geometry, already positioned. */
  add(key, geometry) {
    const materialKey=key;
    if(Number.isFinite(this.chunkSize)) {
      geometry.computeBoundingBox();
      const centre=geometry.boundingBox.getCenter(new THREE.Vector3());
      key+=`@${Math.floor(centre.x/this.chunkSize)},${Math.floor(centre.z/this.chunkSize)}`;
    }
    this.materialKeys.set(key,materialKey);
    if (!this.groups.has(key)) this.groups.set(key, []);
    this.groups.get(key).push(geometry);
  }

  /** Fold each group into a single BufferGeometry. */
  build() {
    const out = new Map();
    for (const [key, parts] of this.groups) {
      if (!parts.length) continue;
      const geometry=mergeGeometries(parts);
      geometry.userData.materialKey=this.materialKeys.get(key);
      out.set(key, geometry);
      for (const p of parts) p.dispose();
    }
    this.groups.clear();
    this.materialKeys.clear();
    return out;
  }
}

/**
 * Concatenate geometries that share an attribute layout.
 *
 * Hand-rolled because three's BufferGeometryUtils is not vendored here, and the
 * job is only ever position/normal/uv.
 */
function mergeGeometries(parts) {
  let total = 0;
  for (const p of parts) total += p.attributes.position.count;

  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);

  let v = 0;
  for (const p of parts) {
    const n = p.attributes.position.count;
    pos.set(p.attributes.position.array, v * 3);
    nor.set(p.attributes.normal.array, v * 3);
    uv.set(p.attributes.uv.array, v * 2);
    v += n;
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  return g;
}
