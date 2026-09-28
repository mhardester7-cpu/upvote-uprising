// GRUNT -- the baseline zombie.
//
// A rotting but still-muscular humanoid, built entirely from lathes, capsules
// and spheres. Nothing here is a box: the arena moved off the voxel-mob look and
// the enemies have to sell that at a glance.
//
// The silhouette does the heavy lifting, because a grunt is usually read at 20+
// metres against bright terrain:
//   - hunched, forward-leaning chest with a heavy trapezius hump
//   - narrow waist under a broad ribcage, so the torso is a wedge, not a slab
//   - asymmetric arms -- the right one is longer and hangs slack
//   - a jutting, hanging jaw and two sunken eye pits
//
// Contract with entities/enemy.js:
//   - origin at the feet, centred in X/Z, occupying y = 0 .. type.height
//   - meshes named legL/legR/armL/armR/torso/head exist, and the four limb
//     origins sit at their joint, because the walk cycle drives `.rotation.x`
//     on them -- a limb whose origin is at its middle spins instead of swings
//   - the group is cloned per spawn, and Object3D.clone() round-trips userData
//     through JSON, so no mesh references are stored there
//
// Forward is +Z (enemy.yaw = atan2(dx, dz)).

// One level deeper than the rest of src/render, hence the extra '..'.
import * as THREE from '../../../vendor/three.module.js';

// ------------------------------------------------------------------ material

/**
 * The renderer works in linear space with ACES tone mapping, so a raw hex
 * literal handed to a material comes out washed out and off-hue. Every colour
 * has to be declared as sRGB and converted.
 */
function srgb(hex) {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

function mat(hex, roughness = 0.95, metalness = 0, extra = null) {
  const m = new THREE.MeshStandardMaterial({ color: srgb(hex), roughness, metalness });
  if (extra) Object.assign(m, extra);
  return m;
}

// Hardcoded companions to the per-type palette. These read the same on every
// zombie tint, which is the point: bone is bone and a wound is a wound.
const BONE = 0xd2c8a6;
const GORE = 0x5e1f1c;
const RAG = 0x3b3d30;
const SOCKET = 0x0d1409;
const MOUTH = 0x140b0b;
const EYE_GLOW = 0xeeff9c;
const GUNMETAL = 0x2b3036;

// ------------------------------------------------------------------ geometry

/**
 * Cheap deterministic hash. Deliberately a pure function of position, so the
 * duplicated vertices along a lathe seam or at a sphere pole receive the same
 * displacement and the surface does not crack open.
 */
function hash3(x, y, z, seed) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.129) * 43758.5453;
  return s - Math.floor(s);
}

/** Lumpy up an indexed surface by pushing vertices along their own normals. */
function perturbNormal(geo, amp, freq = 6, seed = 1) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const d = (hash3(x * freq, y * freq, z * freq, seed) - 0.5) * 2 * amp;
    pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Same idea, but displacing along the direction from the geometry origin.
 * Icosahedra are non-indexed -- every triangle owns private copies of its
 * vertices carrying per-face normals -- so a normal-based push would tear them
 * into confetti. Radial displacement keeps the shell welded.
 */
function perturbRadial(geo, amp, freq = 6, seed = 1) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const d = (hash3(x * freq, y * freq, z * freq, seed) - 0.5) * 2 * amp;
    const k = 1 + d / len;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Tear the bottom ring of a lathe into an uneven hem. Call before transforms. */
function raggedHem(geo, hemY, drop, seed = 3) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > hemY + 1e-4) continue;
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, y - hash3(x * 9, 0, z * 9, seed) * drop);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * A limb bone: a capsule whose origin sits at the JOINT and which hangs
 * straight down from it. `len` is the full end-to-end length including the
 * rounded caps, so callers can chain segments by their nominal length.
 *
 * capSegments is deliberately 1. CapsuleGeometry runs its caps through
 * CurvePath.getPoints(), which doubles the resolution for arc curves, so a
 * capsule costs (4 * capSegments + 1) * radialSegments * 2 triangles -- 144 at
 * the default of 2, which twenty on-screen grunts cannot afford.
 */
function bone(len, radius, material, capSegments = 1, radialSegments = 8) {
  const shaft = Math.max(0.01, len - radius * 2);
  const geo = new THREE.CapsuleGeometry(radius, shaft, capSegments, radialSegments);
  geo.translate(0, -len / 2, 0);
  return new THREE.Mesh(geo, material);
}

/** Squashed blob -- muscle bellies, feet, jaws, skulls. */
function blob(radius, sx, sy, sz, material, wSeg = 8, hSeg = 5) {
  const geo = new THREE.SphereGeometry(radius, wSeg, hSeg);
  geo.scale(sx, sy, sz);
  return new THREE.Mesh(geo, material);
}

/** Angular chunk -- deltoids, knees, torn flesh flaps. 20 triangles each. */
function chunk(radius, material, seed) {
  const geo = new THREE.IcosahedronGeometry(radius, 0);
  perturbRadial(geo, radius * 0.22, 9, seed);
  return new THREE.Mesh(geo, material);
}

// --------------------------------------------------------------------- build

// Waist-to-shoulder profile of the trunk, as [height fraction, radius fraction].
// Broad at the ribcage, pinched at the waist: the wedge is the whole read.
const TRUNK_PROFILE = [
  [0.00, 0.02], [0.02, 0.56], [0.11, 0.68], [0.30, 0.78],
  [0.52, 0.91], [0.72, 0.97], [0.86, 0.88], [0.96, 0.60],
  [1.00, 0.30], [1.03, 0.02],
];

/** Trunk radius fraction at a height fraction, by linear interpolation. */
function trunkRadiusAt(v) {
  for (let i = 1; i < TRUNK_PROFILE.length; i++) {
    const [v1, r1] = TRUNK_PROFILE[i];
    if (v > v1) continue;
    const [v0, r0] = TRUNK_PROFILE[i - 1];
    const t = v1 === v0 ? 0 : (v - v0) / (v1 - v0);
    return r0 + (r1 - r0) * t;
  }
  return 0.02;
}

/**
 * Build the grunt prototype.
 *
 * @param {object} type an ENEMY_TYPES entry (height, width, bodyColor, ...)
 * @returns {THREE.Group} origin at the feet, spanning y = 0 .. type.height
 */
export function buildGruntModel(type) {
  const H = type.height;
  const W = type.width;
  const halfW = W * 0.5;

  const g = new THREE.Group();

  // --- palette ---------------------------------------------------------
  // Limbs sit a shade darker than the trunk so the arms stay legible where
  // they cross the chest.
  const flesh = mat(type.bodyColor, 0.94);
  const fleshDark = mat(type.headColor, 0.96);
  const skin = mat(type.headColor, 0.9);
  const cloth = mat(type.accentColor, 1.0);
  const rag = mat(RAG, 1.0, 0, { side: THREE.DoubleSide });
  const boneMat = mat(BONE, 0.62);
  const goreMat = mat(GORE, 0.7);
  const socketMat = mat(SOCKET, 1.0);
  const mouthMat = mat(MOUTH, 1.0);
  // The eyes get their punch from a bright matte colour, NOT from emissive:
  // syncEnemyMesh() rewrites .emissive on every material each frame to drive
  // the hit flash, so anything parked there is stamped back to black. What
  // sells them is contrast -- two near-white pips sunk inside near-black
  // sockets under a heavy brow. The intended glow colour is recorded on the
  // material in case a bloom pass ever wants it; a plain number is all that
  // survives the material clone.
  const eyeMat = mat(EYE_GLOW, 1.0);
  eyeMat.userData.glowHex = EYE_GLOW;

  // --- skeleton anchors ------------------------------------------------
  const hipY = 0.470 * H;
  const shoulderY = 0.845 * H;
  const neckY = 0.855 * H;
  const torsoH = shoulderY - hipY;
  const thighLen = 0.205 * H;
  const shinLen = 0.195 * H;
  const kneeY = hipY - thighLen;
  const legX = W * 0.235;
  const shoulderX = W * 0.41;
  const shoulderZ = W * 0.10;
  const LEAN = 0.17;            // radians of forward hunch through the trunk

  // ================================================================== torso
  // Flattened front-to-back, then tipped forward about the waist -- which is
  // also the mesh origin, so any future torso animation pivots off the spine.
  const trunkGeo = new THREE.LatheGeometry(
    TRUNK_PROFILE.map(([v, r]) => new THREE.Vector2(r * halfW, v * torsoH)), 10,
  );
  perturbNormal(trunkGeo, W * 0.018, 7, 1);
  trunkGeo.scale(1, 1, 0.72);
  trunkGeo.rotateX(LEAN);

  const torso = new THREE.Mesh(trunkGeo, flesh);
  torso.name = 'torso';
  torso.position.y = hipY;
  g.add(torso);

  // The lean is baked into the trunk vertices, so anything parented to the
  // torso has to be carried through the same rotation by hand or it floats off
  // the chest. Place trunk details in un-leaned body space and pass them here.
  const leanCos = Math.cos(LEAN), leanSin = Math.sin(LEAN);
  const onTrunk = (obj, x, y, z) => {
    obj.position.set(x, y * leanCos - z * leanSin, y * leanSin + z * leanCos);
    obj.rotation.x += LEAN;
    torso.add(obj);
    return obj;
  };
  // Where the trunk's skin sits, at a given height fraction and side offset.
  const surfaceZ = (v, x) => {
    const r = trunkRadiusAt(v) * halfW;
    const k = Math.max(0, 1 - (x / r) * (x / r));
    return r * 0.72 * Math.sqrt(k);
  };

  // Trapezius hump. Two lumps riding high and forward on the shoulders are
  // most of what makes the silhouette read as hunched rather than upright.
  for (const sx of [-1, 1]) {
    const trap = chunk(W * 0.20, flesh, 11 + sx);
    trap.scale.set(1.2, 0.78, 0.95);
    onTrunk(trap, sx * W * 0.27, torsoH * 0.90, W * 0.04);
  }

  // Exposed ribcage: dark meat pushing out of the chest with three bone hoops
  // arcing over it. One side only -- symmetric damage looks manufactured.
  const cavity = blob(W * 0.26, 1.0, 1.25, 0.45, goreMat, 6, 4);
  cavity.rotation.y = -0.25;
  onTrunk(cavity, W * 0.13, torsoH * 0.60, surfaceZ(0.60, W * 0.13) - W * 0.10);

  for (const [v, r] of [[0.47, 0.94], [0.60, 0.98], [0.73, 0.93]]) {
    // Hoops slightly wider than the flesh they wrap, so they stay proud of it
    // even where the perturbation pushed the skin out.
    const rGeo = new THREE.TorusGeometry(r * halfW * 1.05, W * 0.026, 4, 6, Math.PI * 0.62);
    rGeo.rotateX(Math.PI / 2);
    rGeo.scale(1, 1, 0.70);
    const rib = new THREE.Mesh(rGeo, boneMat);
    rib.rotation.y = 0.14;
    onTrunk(rib, 0, v * torsoH, 0);
  }

  // Flesh peeled back at the edges of the wound.
  for (const [x, v, rot] of [[W * 0.30, 0.44, -0.7], [W * 0.02, 0.80, 0.5]]) {
    const flap = chunk(W * 0.10, fleshDark, 21 + v * 10);
    flap.scale.set(0.55, 1.6, 0.5);
    flap.rotation.z = rot;
    onTrunk(flap, x, v * torsoH, surfaceZ(v, x) - W * 0.02);
  }

  // Pelvis. Kept out of the torso mesh so it stays upright under the lean.
  const pelvis = blob(W * 0.30, 1.05, 0.78, 0.8, flesh, 8, 5);
  perturbRadial(pelvis.geometry, W * 0.012, 8, 5);
  pelvis.position.y = hipY - W * 0.04;
  g.add(pelvis);

  // =============================================================== clothing
  // A shredded vest and a hip wrap. Two draped lathes are enough to break up
  // the bare flesh and give the waist a hard edge in silhouette.
  //
  // The vest is a partial lathe: it wraps the back and the left flank and stops
  // short of the wound, because a full ring would sit outside the rib hoops and
  // hide the one detail the chest is built around. The cut edges read as torn.
  const vestGeo = new THREE.LatheGeometry(
    [[0.90, 0.94], [0.74, 1.05], [0.56, 1.00], [0.40, 0.90]]
      .map(([v, r]) => new THREE.Vector2(r * halfW + W * 0.012, v * torsoH)), 8, 1.75, 4.25,
  );
  raggedHem(vestGeo, 0.40 * torsoH, torsoH * 0.26, 3);
  vestGeo.scale(1, 1, 0.74);
  vestGeo.rotateX(LEAN);
  const vest = new THREE.Mesh(vestGeo, rag);
  vest.position.y = hipY;
  g.add(vest);

  const wrapGeo = new THREE.LatheGeometry([
    new THREE.Vector2(W * 0.32, 0.10 * H),
    new THREE.Vector2(W * 0.35, 0.02 * H),
    new THREE.Vector2(W * 0.33, -0.10 * H),
  ], 10);
  raggedHem(wrapGeo, -0.10 * H, 0.09 * H, 7);
  wrapGeo.scale(1, 1, 0.82);
  // Double sided: the legs swing through the open bottom of the wrap, so its
  // inside face is visible from below.
  const wrap = new THREE.Mesh(wrapGeo, mat(type.accentColor, 1.0, 0, { side: THREE.DoubleSide }));
  wrap.position.y = hipY;
  g.add(wrap);

  // =================================================================== head
  // Origin at the neck, so the head pivots off the spine and not its own
  // middle. Everything facial hangs off it as a child.
  const headR = W * 0.235;
  const hc = 0.046 * H;         // skull centre, in head-local space

  const skullGeo = new THREE.SphereGeometry(headR, 10, 8);
  skullGeo.scale(1.0, 1.02, 1.08);
  perturbNormal(skullGeo, headR * 0.05, 10, 2);
  skullGeo.translate(0, hc, headR * 0.05);

  const head = new THREE.Mesh(skullGeo, skin);
  head.name = 'head';
  head.position.set(0, neckY, W * 0.18);
  head.rotation.x = -0.14;      // chin thrust forward off the hunched neck
  g.add(head);

  // Heavy brow, so the eye pits sit in shadow.
  const brow = blob(headR * 0.52, 1.55, 0.42, 0.62, skin, 8, 4);
  brow.position.set(0, hc + headR * 0.26, headR * 0.64);
  brow.rotation.x = 0.25;
  head.add(brow);

  // Sunken sockets with a bright pip recessed inside each.
  for (const sx of [-1, 1]) {
    const socket = blob(headR * 0.29, 1.0, 1.0, 0.65, socketMat, 6, 4);
    socket.position.set(sx * headR * 0.40, hc + headR * 0.02, headR * 0.66);
    head.add(socket);

    const eye = blob(headR * 0.15, 1, 1, 1, eyeMat, 6, 4);
    eye.name = sx < 0 ? 'eyeL' : 'eyeR';
    eye.position.set(sx * headR * 0.40, hc + headR * 0.03, headR * 0.70);
    head.add(eye);
  }

  // Jaw hanging open on a dark mouth cavity.
  const mouth = blob(headR * 0.46, 0.9, 0.7, 0.6, mouthMat, 6, 4);
  mouth.position.set(0, hc - headR * 0.50, headR * 0.46);
  head.add(mouth);

  const jaw = blob(headR * 0.58, 0.9, 0.58, 1.05, skin, 8, 4);
  jaw.position.set(0, hc - headR * 0.74, headR * 0.40);
  jaw.rotation.x = 0.30;
  head.add(jaw);

  const toothGeo = new THREE.ConeGeometry(headR * 0.06, headR * 0.17, 4, 1, true);
  for (const [sx, up] of [[-0.55, 1], [-0.18, 1], [0.18, 1], [0.55, 1], [-0.34, -1], [0.34, -1]]) {
    const tooth = new THREE.Mesh(toothGeo, boneMat);
    tooth.position.set(sx * headR * 0.5, hc - headR * (up > 0 ? 0.38 : 0.68), headR * 0.62);
    tooth.rotation.x = up > 0 ? Math.PI : 0;
    head.add(tooth);
  }

  // Neck: short, thick, angled forward to bridge the leaning chest.
  const neckGeo = new THREE.CylinderGeometry(W * 0.15, W * 0.20, H * 0.10, 8, 1, true);
  neckGeo.rotateX(LEAN);
  const neck = new THREE.Mesh(neckGeo, mat(type.headColor, 0.96, 0, { side: THREE.DoubleSide }));
  neck.position.set(0, neckY - H * 0.035, W * 0.12);
  g.add(neck);

  // =================================================================== legs
  // Each leg is one mesh -- the thigh -- whose origin is the hip; the shin and
  // foot ride along as children, so `.rotation.x` swings the leg from the hip.
  const rThigh = W * 0.135;
  const rShin = W * 0.108;
  const footR = W * 0.13;
  const footSY = 0.85;

  for (const side of [-1, 1]) {
    const leg = bone(thighLen, rThigh, flesh);
    leg.name = side < 0 ? 'legL' : 'legR';
    leg.position.set(side * legX, hipY, 0);
    // The stance splay lives on Z: the walk cycle owns rotation.x and would
    // stamp on anything parked there.
    leg.rotation.z = side * 0.05;
    g.add(leg);

    const knee = chunk(W * 0.115, fleshDark, 31 + side);
    knee.scale.set(1, 0.85, 1.1);
    knee.position.y = -thighLen;
    leg.add(knee);

    const shin = bone(shinLen, rShin, fleshDark);
    shin.position.y = -thighLen;
    leg.add(shin);

    // Calf -- the one muscle cue on a leg that survives at distance.
    const calf = blob(W * 0.13, 0.85, 1.25, 0.9, fleshDark, 6, 4);
    calf.position.set(0, -shinLen * 0.38, -W * 0.05);
    shin.add(calf);

    // Foot, in shin-local space (the shin's origin is the knee). Placed so the
    // model's lowest point lands exactly on y = 0.
    // The +W*0.006 covers the stance splay, which would otherwise dip the
    // outside edge of the sole a few millimetres below the ground plane.
    const foot = blob(footR, 1.0, footSY, 1.9, cloth, 8, 4);
    foot.position.set(0, footR * footSY - kneeY + W * 0.006, W * 0.05);
    shin.add(foot);
  }

  // =================================================================== arms
  // Asymmetric on purpose: the right arm is longer and hangs slack, which is
  // the fastest 'this thing is wrong' read from across the arena.
  const rUpper = W * 0.125;
  const rFore = W * 0.105;
  let armR = null;
  let armRLen = 0;

  for (const side of [-1, 1]) {
    const long = side > 0 ? 1.14 : 1.0;
    const upperLen = 0.215 * H * long;
    const foreLen = 0.205 * H * long;

    const arm = bone(upperLen, rUpper, fleshDark);
    arm.name = side < 0 ? 'armL' : 'armR';
    arm.position.set(side * shoulderX, shoulderY, shoulderZ);
    // Same rule as the legs: the slack pose has to live off the X axis.
    arm.rotation.z = side * (side > 0 ? 0.09 : 0.06);
    arm.rotation.y = side * 0.08;
    g.add(arm);

    // Deltoid cap, hiding the shoulder seam and squaring the silhouette.
    const delt = chunk(W * 0.175, flesh, 41 + side);
    delt.position.y = -W * 0.02;
    arm.add(delt);

    // Torn sleeve on the upper arm only -- clothing remnants read better as
    // fragments than as a full garment.
    const sleeve = new THREE.Mesh(
      new THREE.CylinderGeometry(W * 0.16, W * 0.145, upperLen * 0.45, 8, 1, true), rag,
    );
    sleeve.position.y = -upperLen * 0.30;
    arm.add(sleeve);

    const fore = bone(foreLen, rFore, side > 0 ? fleshDark : flesh);
    fore.position.y = -upperLen;
    // Safe to pose on X: this is a child of the limb, not the limb itself.
    fore.rotation.x = side > 0 ? 0.10 : 0.24;
    arm.add(fore);

    // Bare bone showing on the long arm -- the flesh has rotted off it.
    if (side > 0) {
      const ulna = bone(foreLen * 0.62, rFore * 0.42, boneMat, 1, 6);
      ulna.position.set(rFore * 0.55, -foreLen * 0.28, 0);
      fore.add(ulna);
    }

    const hand = blob(W * 0.115, 0.85, 1.15, 0.8, side > 0 ? fleshDark : flesh, 6, 4);
    hand.position.y = -foreLen;
    fore.add(hand);

    // Three splayed fingers. Tiny, but they break the paddle-hand outline a
    // bare blob leaves you with.
    for (let f = 0; f < 3; f++) {
      const finger = bone(W * 0.16, W * 0.028, side > 0 ? fleshDark : flesh, 1, 3);
      finger.position.set((f - 1) * W * 0.05, -foreLen - W * 0.07, W * 0.02);
      finger.rotation.z = (f - 1) * 0.24;
      finger.rotation.x = 0.4;
      fore.add(finger);
    }

    if (side > 0) { armR = arm; armRLen = upperLen + foreLen; }
  }

  // Armed variants carry a visible pistol, so the player can tell which
  // silhouettes shoot back. The grunt never sets this.
  if (type.armed && armR) armR.add(buildPistol(armRLen));

  return g;
}

/** Chunky stylised pistol, hung off the end of the right arm. */
function buildPistol(armLen) {
  const gun = new THREE.Group();
  gun.name = 'gun';
  const metal = mat(GUNMETAL, 0.45, 0.6);

  const slideGeo = new THREE.CapsuleGeometry(0.038, 0.18, 1, 6);
  slideGeo.rotateX(Math.PI / 2);
  const slide = new THREE.Mesh(slideGeo, metal);
  slide.position.z = -0.09;
  gun.add(slide);

  const barrelGeo = new THREE.CylinderGeometry(0.017, 0.02, 0.1, 6, 1, true);
  barrelGeo.rotateX(Math.PI / 2);
  const barrel = new THREE.Mesh(barrelGeo, mat(GUNMETAL, 0.45, 0.6, { side: THREE.DoubleSide }));
  barrel.position.set(0, -0.01, -0.21);
  gun.add(barrel);

  const gripGeo = new THREE.CapsuleGeometry(0.033, 0.09, 1, 6);
  gripGeo.rotateX(0.3);
  const grip = new THREE.Mesh(gripGeo, mat(0x1a1e22, 0.9));
  grip.position.set(0, -0.08, 0.03);
  gun.add(grip);

  gun.position.set(0, -armLen - 0.03, -0.03);
  return gun;
}
