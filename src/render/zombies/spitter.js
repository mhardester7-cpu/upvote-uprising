// The SPITTER: a bloated, gas-filled zombie that hoses the player with venom.
//
// The whole design exists to answer one question in a quarter of a second at
// forty metres: "which one is the poison one?". The answer is the sacs. Six
// swollen venom bladders ride the spine and shoulders, they are the only
// genuinely bright thing on the model, and they sit high on the silhouette
// where nothing else competes with them. Everything else -- the wasted stick
// limbs, the sagging gut, the too-wide jaw -- is there to make the sacs look
// heavy and to keep the outline from reading as another grunt.
//
// Shape language, for anyone extending this: no boxes. The torso and the limbs
// are lathes, so the profile curve *is* the anatomy -- gut bulge, knee, calf,
// elbow -- and every large surface is run through roughen() afterwards so the
// skin is lumpy rather than injection-moulded.
//
// Static detail that never animates on its own (teeth, claws, spine spurs, jaw
// plates, fingers, the glow shells) is merged into a single buffer per material,
// so a spitter costs about thirty draw calls rather than seventy.
//
// --- integration notes ------------------------------------------------------
//
// FACING. This model faces +Z. Enemy.update() sets `yaw = atan2(dx, dz)` and
// syncEnemyMesh() applies it as `rotation.y`, which swings the +Z axis onto the
// direction of the player; the existing prototype's eye strip is likewise at
// positive z. `spitPoint` therefore sits on the +Z side of the head with an
// identity rotation, so it inherits the group's facing and
// `spitPoint.getWorldDirection(v)` is the direction to launch the venom along.
//
// HOW THE GLOW IS BUILT, AND WHY. syncEnemyMesh() writes `material.emissive` on
// every material of the model every frame to drive the red hit flash, so
// emissive is not usable here -- anything set would be stamped to black on the
// first frame. Instead the glow is the same two-part recipe the infinity stones
// and the chest beacons use:
//
//   1. a bright, high-value matte core (`glow*` meshes, MeshStandardMaterial),
//      which reads as luminous against the dark body under any lighting; plus
//   2. a slightly larger additive shell (`halo*` meshes, MeshBasicMaterial,
//      AdditiveBlending, depthWrite off), which is what actually pushes those
//      pixels past the bloom threshold.
//
// The threshold is a *linear* one: WebGLRenderer skips in-shader tone mapping
// when drawing into a render target, so UnrealBloomPass (threshold 0.90) sees
// linear HDR and OutputPass tone maps afterwards. A near-white acid green core
// plus an additive shell clears 0.90 comfortably, in sun or in shadow.
//
// >>> REQUIRED ONE-LINE CHANGE IN enemy.js <<<
// MeshBasicMaterial has no `emissive`, so the hit-flash loop must be guarded or
// it will throw on the first frame a spitter is alive:
//
//     for (const m of g.userData.materials) {
//       if (!m.emissive) continue;                       // <-- add this
//       m.emissive.setRGB(flash * 0.9, flash * 0.12, flash * 0.12);
//     }
//
// PULSE. `glowSac0..5` are separate meshes, so they can be breathed in and out
// by scale. For a global throb, animate `haloSacs`'s material opacity -- the
// same handle Chest.update() uses on its beacon.
//
// CLONING. Object3D.clone() round-trips userData through JSON, so nothing here
// stores object references there. Parts are found by `.name`.

// Three levels up, not two: this file sits one directory deeper than the rest
// of src/render, so the usual '../../vendor/...' would miss.
import * as THREE from '../../../vendor/three.module.js';

// Authoring reference. The body below is modelled at exactly this height; a
// type with a different one is handled by a single *uniform* scale on an inner
// group, so a limb's rotation.x can never pick up shear from its parents.
const REF_HEIGHT = 1.75;
const REF_WIDTH = 0.60;

// --------------------------------------------------------------------- utils

const color = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/**
 * Smooth, position-driven lump field in roughly [-1, 1].
 *
 * Deliberately built from sines of the *position* rather than of the vertex
 * index: duplicated vertices along a sphere's or lathe's UV seam share a
 * position, so they displace identically and the seam never cracks open.
 */
function lumps(x, y, z) {
  return (
    Math.sin(x * 9.1 + y * 4.3) * Math.cos(z * 7.7 - y * 5.1) * 0.62 +
    Math.sin(y * 13.9 + z * 6.1) * Math.cos(x * 11.3 + y * 3.3) * 0.38
  );
}

/** Push every vertex along its normal by the lump field. Diseased, not smooth. */
function roughen(geo, amount) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const d = lumps(x, y, z) * amount;
    pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Lathe from an array of [radius, height] pairs.
 *
 * Points must run bottom-to-top or the surface comes out inside out. Radii are
 * clamped off zero because a genuinely zero radius produces degenerate
 * triangles at the pole.
 */
function lathe(profile, segments) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-3), y));
  return new THREE.LatheGeometry(pts, segments);
}

/** Bake a position/rotation/scale into a geometry, ready for merging. */
function place(geo, pos, rot, scl) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0),
    ),
    new THREE.Vector3(scl ? scl[0] : 1, scl ? scl[1] : 1, scl ? scl[2] : 1),
  );
  geo.applyMatrix4(m);
  return geo;
}

/** Sphere, optionally squashed/offset/lumped, in one call. */
function blob(radius, wseg, hseg, scl, pos, rough) {
  const geo = new THREE.SphereGeometry(radius, wseg, hseg);
  if (scl || pos) place(geo, pos, null, scl);
  if (rough) roughen(geo, rough);
  return geo;
}

/**
 * The additive envelope around a glowing part.
 *
 * A bare icosahedron: its inradius is only 0.79 of its circumradius, so the
 * shell is oversized by 1/0.79 plus a margin to be certain it encloses the core
 * from every angle. Twenty triangles is plenty for something drawn at a third
 * of an alpha and then blurred by the bloom pass.
 */
function halo(radius, scl, pos) {
  return place(new THREE.IcosahedronGeometry(radius * 1.34, 0), pos, null, scl);
}

/**
 * Concatenate geometries that share a material into a single buffer.
 *
 * Each part keeps its own normals, so merging never smooths across a junction
 * the way a welded mesh would -- the jaw stays a distinct plate on the skull.
 * Polyhedron-derived geometry (the icosahedra) arrives non-indexed, so it gets
 * a trivial sequential index first.
 */
function mergeGeos(geos) {
  if (geos.length === 1) return geos[0];
  const parts = geos.map((g) => {
    if (g.index) return g;
    const n = g.attributes.position.count;
    const seq = new Uint32Array(n);
    for (let i = 0; i < n; i++) seq[i] = i;
    g.setIndex(new THREE.BufferAttribute(seq, 1));
    return g;
  });

  let vTotal = 0, iTotal = 0;
  for (const p of parts) { vTotal += p.attributes.position.count; iTotal += p.index.count; }

  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const idx = new Uint32Array(iTotal);

  let vo = 0, io = 0;
  for (const p of parts) {
    const n = p.attributes.position.count;
    pos.set(p.attributes.position.array, vo * 3);
    if (p.attributes.normal) nrm.set(p.attributes.normal.array, vo * 3);
    if (p.attributes.uv) uv.set(p.attributes.uv.array, vo * 2);
    const pi = p.index.array;
    for (let i = 0; i < pi.length; i++) idx[io + i] = pi[i] + vo;
    vo += n;
    io += pi.length;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/**
 * A drooping tendril: an open tapered tube that curves away from its root.
 * Hung from the jaw and the underside of the gut, these break up the outline
 * and sell "wet" without any transparency work.
 */
function tendril(len, rTop, rTip, sway) {
  const geo = new THREE.CylinderGeometry(rTop, rTip, len, 6, 2, true);
  geo.translate(0, -len / 2, 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, -pos.getY(i) / len));
    pos.setZ(i, pos.getZ(i) + sway * t * t);
    pos.setX(i, pos.getX(i) + sway * 0.35 * t * t * t);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** The bead of venom about to fall off the end of a tendril. */
function drip(len, rTip, sway) {
  return place(
    new THREE.IcosahedronGeometry(rTip * 2.0, 0),
    [sway * 0.35, -len, sway], null, [1, 1.5, 1],
  );
}

// ------------------------------------------------------------------ the build

/**
 * Build the SPITTER prototype.
 *
 * @param {object} type an ENEMY_TYPES entry (height, width, bodyColor,
 *                      headColor, accentColor).
 * @returns {THREE.Group} origin at the feet, centred in X/Z, spanning
 *                        y = 0 .. type.height, facing +Z.
 */
export function buildSpitterModel(type) {
  const root = new THREE.Group();
  root.name = 'spitter';

  const K = type.height / REF_HEIGHT;
  const body = new THREE.Group();
  body.scale.setScalar(K);
  root.add(body);

  // Authored width factor. A wider type widens the pear-shaped part of the
  // body rather than fattening the head, which is where the read lives.
  const wk = (type.width / K) / REF_WIDTH;

  // --- materials ---------------------------------------------------------
  // Rot is rough and completely non-metallic. The venom is the exception: near
  // white, barely shaded, and wrapped in an additive shell.
  const skinMat = new THREE.MeshStandardMaterial({
    color: color(type.bodyColor), roughness: 0.92, metalness: 0.0,
  });
  const headMat = new THREE.MeshStandardMaterial({
    color: color(type.headColor), roughness: 0.86, metalness: 0.0,
  });
  const darkMat = new THREE.MeshStandardMaterial({
    color: color(type.accentColor), roughness: 0.97, metalness: 0.0,
  });
  // Sac core. Deliberately far lighter than headColor -- the value gap between
  // the sacs and the body is the whole read, and it survives the hit-flash loop
  // because it lives in `color`, which nothing overwrites.
  const sacMat = new THREE.MeshStandardMaterial({
    color: color(0xe4ff8e), roughness: 0.34, metalness: 0.0,
  });
  const gooMat = new THREE.MeshStandardMaterial({
    color: color(0xeaffb4), roughness: 0.18, metalness: 0.0,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: color(0xfaffd8), roughness: 0.28, metalness: 0.0,
  });
  const boneMat = new THREE.MeshStandardMaterial({
    color: color(0xd3cfa6), roughness: 0.50, metalness: 0.0,
  });
  // The bloom trigger. Same idiom as the chest beacon and the stone halos:
  // additive, no depth write, double sided so the far wall of the shell adds a
  // second helping at the silhouette edge, which is where a gas envelope should
  // be brightest.
  const haloMat = new THREE.MeshBasicMaterial({
    color: color(0xd0ff6a), transparent: true, opacity: 0.42,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });

  const HIP_Y = 0.620;
  const WAIST_Y = 0.600;     // torso pivot
  const SHOULDER_Y = 1.180;
  const NECK = 0.720;        // top of the torso profile, in torso space

  // =======================================================================
  // TORSO -- one lathe, pear-shaped, hunched.
  // =======================================================================
  const torsoProfile = [
    [0.020, -0.170],
    [0.130, -0.140],
    [0.208, -0.092],
    [0.262, -0.014],
    [0.295,  0.078],   // widest point: the gut
    [0.288,  0.166],
    [0.256,  0.254],
    [0.228,  0.340],
    [0.214,  0.428],
    [0.224,  0.502],
    [0.238,  0.562],   // hunched shoulder mass
    [0.218,  0.626],
    [0.150,  0.684],
    [0.058,  NECK],
  ];
  const torsoGeo = lathe(torsoProfile, 11);
  torsoGeo.scale(wk, 1, wk);

  // Curve the whole thing forward: the gut hangs out over the hips and the
  // spine leans out over that, which is what makes the sacs on the back read as
  // a load being carried rather than as decals stuck on a cylinder.
  const spineZ = (y) => {
    const t = Math.min(1, Math.max(0, (y + 0.17) / (NECK + 0.17)));
    return 0.065 * Math.exp(-Math.pow((y - 0.07) / 0.17, 2)) + 0.13 * Math.pow(t, 2.2);
  };
  {
    const pos = torsoGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) + spineZ(pos.getY(i)));
    pos.needsUpdate = true;
  }
  roughen(torsoGeo, 0.016);

  const torso = new THREE.Mesh(torsoGeo, skinMat);
  torso.name = 'torso';
  torso.position.set(0, WAIST_Y, 0);
  body.add(torso);

  // --- the sacs ----------------------------------------------------------
  // The read. Six large bladders rather than a dozen small ones, because at
  // range a cluster of small glows blurs into a single smear while six distinct
  // lobes still reads as "covered in the stuff".
  const SACS = [
    // [x, y, extra offset behind the back, radius, y-stretch]
    [ 0.000, 0.238, 0.055, 0.148, 1.05],
    [-0.148, 0.408, 0.030, 0.126, 1.10],
    [ 0.148, 0.408, 0.030, 0.126, 1.10],
    [-0.210, 0.568, -0.048, 0.102, 1.00],
    [ 0.210, 0.568, -0.048, 0.102, 1.00],
    [ 0.000, 0.596, 0.030, 0.096, 0.92],
  ];
  const sacHalos = [];
  SACS.forEach(([x, y, back, r, ys], i) => {
    const m = new THREE.Mesh(
      blob(r, 10, 6, [wk, ys, 0.92], null, r * 0.10), sacMat,
    );
    m.name = `glowSac${i}`;
    // Sit it on the rear surface: ring centre, minus most of the ring radius,
    // so roughly two thirds of the sphere stays proud of the skin.
    m.position.set(x * wk, y, spineZ(y) - 0.20 * wk - back);
    torso.add(m);
    sacHalos.push(halo(r, [wk, ys, 0.92], [m.position.x, m.position.y, m.position.z]));
  });
  const sacHaloMesh = new THREE.Mesh(mergeGeos(sacHalos), haloMat);
  sacHaloMesh.name = 'haloSacs';
  torso.add(sacHaloMesh);

  // Smaller nodules crawling over the collar -- the infection spreading off the
  // main bladders.
  const nodules = [
    [-0.088, 0.646, -0.100, 0.052],
    [ 0.096, 0.640, -0.104, 0.044],
  ].map(([x, y, z, r]) => place(
    roughen(new THREE.SphereGeometry(r, 8, 5), r * 0.12),
    [x * wk, y, z + spineZ(y) * 0.6],
  ));
  const noduleMesh = new THREE.Mesh(mergeGeos(nodules), sacMat);
  noduleMesh.name = 'glowNodules';
  torso.add(noduleMesh);

  // A ridge of exposed vertebrae between the sacs. The back is otherwise all
  // bubbles; this gives the silhouette a hard edge to play the soft ones off.
  const spurs = [];
  for (let i = 0; i < 4; i++) {
    const y = 0.16 + i * 0.115;
    spurs.push(place(
      new THREE.ConeGeometry(0.030, 0.075, 6, 1, true),
      [0, y, spineZ(y) - 0.225 * wk], [-Math.PI * 0.42, 0, 0],
    ));
  }
  const spine = new THREE.Mesh(mergeGeos(spurs), darkMat);
  spine.name = 'spine';
  torso.add(spine);

  // Venom weeping off the underside of the gut.
  {
    const stalks = [], drips = [];
    [[-0.130, 0.150, 0.030], [0.145, 0.130, 0.030]].forEach(([x, len, sway], i) => {
      const at = [x * wk, -0.115, spineZ(-0.06) + 0.095];
      const rot = [0.25 + i * 0.10, 0, 0];
      stalks.push(place(tendril(len, 0.022, 0.011, sway), at, rot));
      drips.push(place(drip(len, 0.011, sway), at, rot));
    });
    const s = new THREE.Mesh(mergeGeos(stalks), skinMat);
    s.name = 'gutTendrils';
    torso.add(s);
    const d = new THREE.Mesh(mergeGeos(drips), gooMat);
    d.name = 'glowGutDrips';
    torso.add(d);
  }

  // =======================================================================
  // HEAD -- pivot at the neck, so rotating it nods rather than orbits.
  // =======================================================================
  // Cranium, jaw plates and cranial crest all live in one buffer. The maw is
  // deliberately left as a gap between the two plates so the throat glow shows
  // through from any angle rather than only head-on.
  const headParts = [
    // cranium
    blob(0.148, 10, 6, [wk, 1.12, 1.14], [0, 0.256, -0.010], 0.011),
    // upper jaw: wide, low, and hinged well forward -- a nozzle, not a bite
    blob(0.112, 9, 6, [1.46 * wk, 0.62, 1.46], [0, 0.184, 0.148], 0.008),
    // lower jaw, hanging open
    place(
      blob(0.104, 9, 6, [1.36 * wk, 0.56, 1.52], [0, 0.078, 0.158], 0.008),
      null, [-0.16, 0, 0],
    ),
    // cranial crest: two fused lumps running back over the skull
    blob(0.050, 8, 4, null, [-0.052, 0.378, -0.052], 0.006),
    blob(0.050, 8, 4, null, [0.052, 0.378, -0.052], 0.006),
  ];
  const head = new THREE.Mesh(mergeGeos(headParts), headMat);
  head.name = 'head';
  head.position.set(0, WAIST_Y + NECK, spineZ(NECK));
  body.add(head);

  // Dark mouth interior plus the two sunken eye sockets, so the gap between the
  // jaw plates reads as a hole and the eyes read as set deep.
  const maw = new THREE.Mesh(mergeGeos([
    blob(0.098, 8, 5, [1.30 * wk, 0.52, 1.34], [0, 0.134, 0.150]),
    place(new THREE.IcosahedronGeometry(0.052, 0), [-0.093 * wk, 0.286, 0.116], null, [1, 0.86, 0.7]),
    place(new THREE.IcosahedronGeometry(0.052, 0), [0.093 * wk, 0.286, 0.116], null, [1, 0.86, 0.7]),
  ]), darkMat);
  maw.name = 'maw';
  head.add(maw);

  // Venom welling up the throat: small, but framed by the dark maw, which makes
  // the head the second read after the back sacs.
  const throat = new THREE.Mesh(new THREE.IcosahedronGeometry(0.062, 0), gooMat);
  throat.name = 'glowThroat';
  throat.scale.set(1.2 * wk, 0.7, 1.0);
  throat.position.set(0, 0.134, 0.100);
  head.add(throat);

  // Eyes: tiny and set wide above the muzzle, so they punch through bloom as
  // points rather than blobs.
  const eyeMesh = new THREE.Mesh(mergeGeos([-1, 1].map((s) => place(
    new THREE.IcosahedronGeometry(0.028, 0), [s * 0.093 * wk, 0.286, 0.144],
  ))), eyeMat);
  eyeMesh.name = 'glowEyes';
  head.add(eyeMesh);

  // One additive buffer for everything glowing on the head.
  const headHalo = new THREE.Mesh(mergeGeos([
    halo(0.062, [1.2 * wk, 0.7, 1.0], [0, 0.134, 0.100]),
    halo(0.028, null, [-0.093 * wk, 0.286, 0.144]),
    halo(0.028, null, [0.093 * wk, 0.286, 0.144]),
  ]), haloMat);
  headHalo.name = 'haloHead';
  head.add(headHalo);

  // Teeth: irregular, sparse and open-ended (the bases sit inside the gum, so
  // there is nothing to cap). A full even set looks like dentures.
  const teeth = [];
  const tooth = () => new THREE.ConeGeometry(0.016, 0.058, 6, 1, true);
  [-0.105, -0.058, 0.0, 0.062].forEach((x, i) => {
    const s = i === 2 ? 1.25 : 1.0;
    teeth.push(place(
      tooth(),
      [x * wk, 0.166, 0.232 - Math.abs(x) * 0.42],
      [Math.PI + 0.22, 0, (i % 2 ? 1 : -1) * 0.12],
      [s, s, s],
    ));
  });
  [-0.062, 0.058].forEach((x, i) => {
    teeth.push(place(
      tooth(),
      [x * wk, 0.096, 0.236 - Math.abs(x) * 0.42],
      [-0.18, 0, (i % 2 ? -1 : 1) * 0.14],
      [0.85, 0.85, 0.85],
    ));
  });
  const toothMesh = new THREE.Mesh(mergeGeos(teeth), boneMat);
  toothMesh.name = 'teeth';
  head.add(toothMesh);

  // Glands behind the jaw: the reservoir feeding the mouth.
  const glandMesh = new THREE.Mesh(mergeGeos([-1, 1].map((s) => place(
    roughen(new THREE.SphereGeometry(0.060, 8, 4), 0.008),
    [s * 0.128 * wk, 0.312, -0.106], null, [1, 1.1, 1],
  ))), sacMat);
  glandMesh.name = 'glowGlands';
  head.add(glandMesh);

  // Drool hanging off the jaw line.
  {
    const stalks = [], drips = [];
    [[-0.145, 0.130, -0.050], [0.155, 0.110, 0.040]].forEach(([x, len, sway]) => {
      const at = [x * wk, 0.058, 0.148];
      const rot = [0.18, 0, 0];
      stalks.push(place(tendril(len, 0.016, 0.008, sway), at, rot));
      drips.push(place(drip(len, 0.008, sway), at, rot));
    });
    const s = new THREE.Mesh(mergeGeos(stalks), headMat);
    s.name = 'jawTendrils';
    head.add(s);
    const d = new THREE.Mesh(mergeGeos(drips), gooMat);
    d.name = 'glowJawDrips';
    head.add(d);
  }

  // --- spit point --------------------------------------------------------
  // Just outside the front of the maw. Identity rotation, so it inherits the
  // group's facing: +Z is forward (see the header note), and getWorldDirection
  // on this node gives the direction to launch along.
  const spitPoint = new THREE.Object3D();
  spitPoint.name = 'spitPoint';
  spitPoint.position.set(0, 0.140, 0.328);
  head.add(spitPoint);

  // =======================================================================
  // LEGS -- one lathe each, hip to ankle. Wasted, bandy, barely load bearing.
  // =======================================================================
  // The profile is authored with y = 0 at the hip and running downward, which
  // is what geometry.translate(0, -length/2, 0) achieves for a symmetric
  // primitive: the mesh origin ends up at the joint, so rotation.x swings the
  // limb instead of spinning it about its middle.
  const legProfile = [
    [0.030, -0.578],   // ankle
    [0.038, -0.500],
    [0.056, -0.428],   // calf
    [0.046, -0.354],
    [0.072, -0.280],   // knee
    [0.058, -0.192],
    [0.078, -0.090],
    [0.088, -0.018],   // hip
    [0.050,  0.022],
  ];

  function buildLeg(side) {
    const leg = new THREE.Mesh(roughen(lathe(legProfile, 8), 0.005), darkMat);
    leg.name = side < 0 ? 'legL' : 'legR';
    leg.position.set(side * 0.136 * wk, HIP_Y, 0);
    leg.rotation.z = side * 0.05;   // slightly bandy

    // Splayed foot. Its underside is what defines y = 0 for the whole model.
    const foot = new THREE.Mesh(
      blob(0.086, 8, 4, [0.95, 0.44, 1.72], [0, -0.576, 0.042], 0.005), skinMat,
    );
    foot.name = 'foot';
    leg.add(foot);

    const clawMesh = new THREE.Mesh(mergeGeos([-0.052, 0.0, 0.052].map((x) => place(
      new THREE.ConeGeometry(0.017, 0.062, 6, 1, true),
      [x, -0.588, 0.166], [-1.30, 0, 0],
    ))), boneMat);
    clawMesh.name = 'claws';
    leg.add(clawMesh);
    return leg;
  }

  body.add(buildLeg(-1));
  body.add(buildLeg(1));

  // =======================================================================
  // ARMS -- long, thin, hanging almost to the knees.
  // =======================================================================
  const armProfile = [
    [0.024, -0.700],   // wrist
    [0.032, -0.610],
    [0.030, -0.512],
    [0.042, -0.416],
    [0.054, -0.332],   // elbow
    [0.040, -0.240],
    [0.054, -0.132],
    [0.078, -0.030],   // shoulder, tying into the bloated deltoid
    [0.044,  0.020],
  ];

  function buildArm(side) {
    // Fingers share the arm's buffer: they are rigid relative to it, so there
    // is no reason to pay for extra draw calls per hand.
    const parts = [roughen(lathe(armProfile, 8), 0.004)];
    const fingerGeo = () => {
      const g = new THREE.CylinderGeometry(0.013, 0.006, 0.115, 6, 1, true);
      g.translate(0, -0.0575, 0);
      return g;
    };
    parts.push(place(fingerGeo(), [-0.026, -0.742, 0.016], [0.34, 0, -0.07]));
    parts.push(place(fingerGeo(), [0.024, -0.742, 0.016], [0.44, 0, 0.06]));
    parts.push(place(fingerGeo(), [0.002, -0.736, -0.020], [-0.55, 0, 0]));

    const arm = new THREE.Mesh(mergeGeos(parts), darkMat);
    arm.name = side < 0 ? 'armL' : 'armR';
    arm.position.set(side * 0.252 * wk, SHOULDER_Y, 0.030);
    arm.rotation.z = side * 0.10;

    const hand = new THREE.Mesh(
      blob(0.044, 8, 4, [1.0, 0.8, 1.15], [0, -0.716, 0.006], 0.004), skinMat,
    );
    hand.name = 'hand';
    arm.add(hand);
    return arm;
  }

  body.add(buildArm(-1));
  body.add(buildArm(1));

  return root;
}
