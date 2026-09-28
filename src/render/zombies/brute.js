// The BRUTE -- the heavy of the zombie roster.
//
// Everything in this file serves one job: the silhouette. A player who sees this
// shape crest a ridge at forty metres should change plan before they have had
// time to read the health bar. So the character is all in the proportions -- an
// enormous swollen upper body, knuckle-dragging arms, trunk legs, and a tiny
// sunken head buried in the valley between two mountainous shoulders. It is
// deliberately asymmetric: the left side has mutated further and ends in a club
// of fused bone, which stops the shape reading as a symmetrical toy and sells
// "this thing grew wrong" from any angle.
//
// Contracts the simulation depends on, none of which are optional:
//   * origin at the FEET, centred in X/Z, occupying y = 0 .. type.height
//   * meshes named legL / legR / armL / armR / torso / head
//   * limb geometry translated so the mesh origin sits ON the joint -- the walk
//     cycle drives `.rotation.x`, and a limb pivoting about its own middle looks
//     like a propeller
//   * the head must physically sit inside the top 28% of the height and stay on
//     the centre line, because the head hitbox is derived from the type dims and
//     not from this model; a head on a jutting neck means headshots miss the art
//   * nothing may be stashed in `userData` -- the prototype is cloned per spawn
//     and `Object3D.clone()` round-trips userData through JSON, so object
//     references there do not survive. The caller re-resolves limbs by name.
//
// No boxes anywhere. Every mass is a sphere, a lathe-derived capsule, a tapered
// cylinder or a cone, then pushed around by a cheap deterministic noise field so
// nothing reads as machined.

// NOTE: three levels up, not two -- this file sits one directory deeper than the
// rest of src/render, so the usual '../../vendor/...' would miss.
import * as THREE from '../../../vendor/three.module.js';

// ---------------------------------------------------------------- materials

/**
 * Standard material with the colour converted out of sRGB.
 *
 * The renderer works in linear space with ACES tone mapping, so handing a raw
 * hex straight to `color` washes every mid tone out by about a stop.
 */
function mat(hex, roughness = 0.9, metalness = 0.0) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHex(hex, THREE.SRGBColorSpace),
    roughness,
    metalness,
  });
}

// -------------------------------------------------------------- deformation

/**
 * Smooth, seamless, deterministic wobble field.
 *
 * Sampled purely from position, which matters: sphere and cylinder seams carry
 * duplicated vertices that share a position, so both copies get an identical
 * offset and the surface never splits open along the seam.
 */
function lump(x, y, z, f) {
  return Math.sin(x * f * 1.7 + y * f * 0.9 + 1.3)
    * Math.sin(y * f * 1.31 - z * f * 1.9 + 2.1)
    * Math.sin(z * f * 2.13 + x * f * 0.71 + 0.4);
}

/**
 * Push a closed convex blob in and out along its own radius.
 *
 * Normals are rewritten as the normalised position rather than recomputed from
 * the faces. That is strictly the *sphere's* normal, not the deformed surface's,
 * but it is continuous across the UV seam -- `computeVertexNormals` is not, and
 * a bright hairline down every growth is far worse than slightly soft shading on
 * the lumps.
 */
function bulge(geo, amp, freq, seed) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z);
    if (len < 1e-6) continue;
    const d = 1 + lump(x + seed, y - seed * 0.7, z + seed * 0.5, freq) * amp;
    pos.setXYZ(i, x * d, y * d, z * d);
    nrm.setXYZ(i, x / len, y / len, z / len);
  }
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
  return geo;
}

/**
 * Vary a limb segment's thickness along its length, radially in XZ only.
 *
 * Y is left alone and the shipped normals are kept: the displacement is small
 * enough that the original normals stay honest, and keeping them sidesteps the
 * same seam problem `bulge` works around.
 */
function swell(geo, amp, freq, seed) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (Math.hypot(x, z) < 1e-6) continue;
    const d = 1 + lump(x + seed, y + seed * 0.5, z - seed, freq) * amp;
    pos.setXYZ(i, x * d, y, z * d);
  }
  pos.needsUpdate = true;
  return geo;
}

// ------------------------------------------------------------------- shapes

let SEED = 0;

/**
 * A lumpy ellipsoid: the workhorse of the whole model.
 *
 * Built as a unit sphere so the noise is the same scale on every mass, then
 * squashed into place by scaling the *geometry* rather than the mesh, which
 * keeps child offsets and bounding boxes in plain world units.
 */
function blob(rx, ry, rz, material, wseg = 10, hseg = 8, amp = 0.13) {
  const geo = new THREE.SphereGeometry(1, wseg, hseg);
  bulge(geo, amp, 2.3, (SEED++) * 7.31);
  geo.scale(rx, ry, rz);
  return new THREE.Mesh(geo, material);
}

/**
 * One limb bone. Open-ended -- the joints are capped by blobs anyway -- and
 * translated so the mesh origin lands on the joint at the TOP of the segment,
 * which is the entire reason `.rotation.x` swings the limb instead of spinning
 * it about its waistline.
 */
function bone(rTop, rBot, len, material, radial = 10) {
  const geo = new THREE.CylinderGeometry(rTop, rBot, len, radial, 2, true);
  swell(geo, 0.1, 2.4, (SEED++) * 4.17);
  geo.translate(0, -len / 2, 0);
  return new THREE.Mesh(geo, material);
}

/** A claw, tusk or spur. Origin at the base, growing along its local +Y. */
function spur(radius, len, material, radial = 5) {
  const geo = new THREE.ConeGeometry(radius, len, radial, 1);
  geo.translate(0, len / 2, 0);
  return new THREE.Mesh(geo, material);
}

// --------------------------------------------------------------------- fuse

/** Concatenate same-attribute indexed geometries into one buffer. */
function mergeGeometries(geos) {
  if (geos.length === 1) return geos[0];

  let vcount = 0, icount = 0;
  for (const g of geos) {
    vcount += g.attributes.position.count;
    icount += g.index.count;
  }

  const pos = new Float32Array(vcount * 3);
  const nrm = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const idx = vcount > 65535 ? new Uint32Array(icount) : new Uint16Array(icount);

  let vo = 0, io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    nrm.set(g.attributes.normal.array, vo * 3);
    uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/**
 * Collapse a rigid body part into one mesh per material.
 *
 * A brute assembled naively is ninety-odd little meshes, which is ninety draw
 * calls and -- because the game clones every material per spawn so hit flashes
 * stay local -- ninety material clones each time one walks in. Baking each
 * part's local transforms into its geometry and concatenating by material takes
 * that to four or five, at zero cost to the shape.
 *
 * The primary material becomes the part's own geometry so the part is a real
 * Mesh that can be named and rotated; the rest ride along as children.
 *
 * @param parts array of Mesh with local transforms already set
 * @param primary the material that should own the root mesh
 */
function fuse(parts, primary, name) {
  const byMat = new Map([[primary, []]]);
  for (const m of parts) {
    m.updateMatrix();
    const geo = m.geometry.clone().applyMatrix4(m.matrix);
    if (!byMat.has(m.material)) byMat.set(m.material, []);
    byMat.get(m.material).push(geo);
  }

  const root = new THREE.Mesh(mergeGeometries(byMat.get(primary)), primary);
  root.name = name;
  byMat.delete(primary);
  for (const [material, geos] of byMat) {
    root.add(new THREE.Mesh(mergeGeometries(geos), material));
  }
  return root;
}

// -------------------------------------------------------------------- model

/**
 * Build the brute prototype.
 *
 * @param {object} type an ENEMY_TYPES entry (brute)
 * @returns {THREE.Group} origin at the feet, spanning y = 0 .. type.height
 */
export function buildBruteModel(type) {
  SEED = 11;   // fixed, so the prototype is byte-identical run to run

  const H = type.height;   // 2.5 -- tallest thing short of the boss
  const W = type.width;    // 0.95

  const skin = mat(type.bodyColor, 0.92);
  const dark = mat(type.headColor, 0.88);
  const deep = mat(type.accentColor, 0.95);
  // Growths read as newer, wetter tissue than the hide around them: a lighter
  // violet and a much lower roughness, so they catch a rim off the sun.
  const growth = mat(0x9a63c4, 0.55);
  const boneMat = mat(0xcbbfa4, 0.55);
  const clawMat = mat(0xe6dcc6, 0.4);
  const eyeMat = mat(0xffae4a, 0.25);

  const g = new THREE.Group();
  g.name = 'brute';

  // Joint heights, all as fractions of the type dimensions so that retuning the
  // brute's size in enemy.js cannot silently break the model or the hitboxes.
  const HIP_Y = H * 0.38;        // 0.950
  const WAIST_Y = H * 0.36;      // 0.900 -- the torso mesh's origin
  const SHOULDER_Y = H * 0.825;  // 2.062
  const HEAD_Y = H * 0.845;      // 2.112 -- sits mid-band of the top 28%

  // --------------------------------------------------------------- legs
  // Trunk-like: barely any taper, the knee lost inside the mass, splayed at the
  // ankles. The whole leg is one fused part, so the hip swing carries shin, foot
  // and claws without a second pivot to keep in sync.
  const LEG_TILT = 0.09;   // bow-legged: feet planted wider than the hips
  const buildLeg = (side) => {
    const p = [];

    const thigh = bone(W * 0.30, W * 0.23, H * 0.22, skin, 10);
    p.push(thigh);

    const hipBall = blob(W * 0.31, W * 0.29, W * 0.30, skin, 8, 6);
    hipBall.position.y = -H * 0.02;
    p.push(hipBall);

    const knee = blob(W * 0.25, W * 0.22, W * 0.24, dark, 8, 6, 0.16);
    knee.position.y = -H * 0.212;
    p.push(knee);

    const shin = bone(W * 0.23, W * 0.19, H * 0.14, dark, 10);
    shin.position.y = -H * 0.208;
    p.push(shin);

    // A growth clinging to the outer thigh. Mirrored per side rather than
    // duplicated, so the two legs never look like the same leg twice.
    const nodule = blob(W * 0.13, W * 0.11, W * 0.12, growth, 6, 5, 0.24);
    nodule.position.set(side * W * 0.20, -H * 0.09, -W * 0.05);
    p.push(nodule);

    // Foot: a splayed slab, sole flat on the ground plane (local -HIP_Y). The
    // foot and its claws cancel the leg's bow, so the sole stays level with the
    // ground instead of rolling onto its inside edge and sinking through it.
    const sole = -HIP_Y;
    const foot = blob(W * 0.24, H * 0.05, W * 0.34, deep, 8, 6, 0.05);
    foot.position.set(0, sole + H * 0.0545, W * 0.05);
    foot.rotation.z = -side * LEG_TILT;
    p.push(foot);

    for (const tx of [-0.13, 0, 0.13]) {
      const claw = spur(W * 0.05, W * 0.17, clawMat, 5);
      claw.position.set(W * tx, sole + H * 0.032, W * 0.30);
      claw.rotation.set(Math.PI * 0.56, 0, -side * LEG_TILT);  // raked forward
      p.push(claw);
    }

    return fuse(p, skin, side < 0 ? 'legL' : 'legR');
  };

  const legL = buildLeg(-1);
  legL.position.set(-W * 0.27, HIP_Y, 0);
  legL.rotation.z = -LEG_TILT;
  g.add(legL);

  const legR = buildLeg(1);
  legR.position.set(W * 0.27, HIP_Y, 0);
  legR.rotation.z = LEG_TILT;
  g.add(legR);

  // -------------------------------------------------------------- torso
  // Origin at the waist, so a future lean or flinch bends at the right place.
  // Head and arms hang off it as children and inherit that lean for free; the
  // caller resolves everything by name, so the nesting is invisible to it.
  const tp = [];

  /** Torso-local Y for a world height. */
  const ty = (worldY) => worldY - WAIST_Y;

  const trunk = blob(W * 0.55, H * 0.26, W * 0.43, skin, 11, 9, 0.15);
  trunk.position.y = H * 0.25;
  tp.push(trunk);

  const pelvis = blob(W * 0.45, H * 0.10, W * 0.38, dark, 8, 6);
  pelvis.position.set(0, ty(H * 0.40), 0);
  tp.push(pelvis);

  // Distended gut, slung forward and low. Half of why the thing reads as slow.
  const gut = blob(W * 0.52, H * 0.16, W * 0.45, skin, 10, 8, 0.16);
  gut.position.set(0, ty(H * 0.50), W * 0.08);
  tp.push(gut);

  // Chest: the widest mass in the model by a distance.
  const chest = blob(W * 0.66, H * 0.16, W * 0.44, skin, 10, 8, 0.14);
  chest.position.set(0, ty(H * 0.745), -W * 0.02);
  tp.push(chest);

  // Hunched back, riding higher than the skull does.
  const hump = blob(W * 0.50, H * 0.14, W * 0.30, skin, 8, 6, 0.17);
  hump.position.set(0, ty(H * 0.825), -W * 0.24);
  tp.push(hump);

  // Mutated ridge down the spine: nodules, plus a short row of bone spurs laid
  // back over it rather than standing up like a stegosaur.
  for (const [nx, nyH, nz, r] of [
    [-0.13, 0.85, -0.34, 0.13], [0.16, 0.78, -0.36, 0.11],
    [-0.05, 0.69, -0.36, 0.10], [0.20, 0.61, -0.30, 0.09],
  ]) {
    const n = blob(W * r, W * r * 0.85, W * r * 0.9, growth, 6, 4, 0.26);
    n.position.set(W * nx, ty(H * nyH), W * nz);
    tp.push(n);
  }

  for (const [sx, syH, len] of [[-0.20, 0.83, 0.30], [0.10, 0.76, 0.24], [-0.06, 0.69, 0.19]]) {
    const s = spur(W * 0.06, W * len, boneMat, 5);
    s.position.set(W * sx, ty(H * syH), -W * 0.36);
    s.rotation.x = -0.9;   // swept back off the spine, away from the body
    tp.push(s);
  }

  // --------------------------------------------------- shoulders / trapezius
  // The tallest masses on the model. The head sits down in the valley between
  // them, which is the silhouette this whole enemy trades on.
  for (const sx of [-1, 1]) {
    const big = sx < 0 ? 1.14 : 1.0;   // the left side has mutated further

    const delt = blob(W * 0.35 * big, H * 0.145 * big, W * 0.34 * big, skin, 10, 8, 0.15);
    delt.position.set(sx * W * 0.49, ty(SHOULDER_Y), 0);
    tp.push(delt);

    const trap = blob(W * 0.30 * big, H * 0.085 * big, W * 0.28 * big, skin, 8, 6, 0.15);
    trap.position.set(sx * W * 0.34, ty(H * 0.868), -W * 0.06);
    tp.push(trap);

    // Barnacle cluster capping each shoulder.
    for (let i = 0; i < 2; i++) {
      const a = i * 2.3 + (sx < 0 ? 0.6 : 1.9);
      const r = W * (0.08 + 0.022 * i);
      const node = blob(r, r * 0.9, r, growth, 6, 4, 0.28);
      node.position.set(
        sx * W * 0.42 + Math.cos(a) * W * 0.13,
        ty(H * 0.895),
        Math.sin(a) * W * 0.13,
      );
      tp.push(node);
    }

    const shoulderSpur = spur(W * 0.075, W * 0.26 * big, boneMat, 6);
    shoulderSpur.position.set(sx * W * 0.44, ty(H * 0.885), -W * 0.12);
    shoulderSpur.rotation.set(-0.7, 0, sx * 0.5);
    tp.push(shoulderSpur);
  }

  // A neck exists mostly to fill the hole; the head is all but socketed into
  // the chest.
  const neck = blob(W * 0.26, H * 0.055, W * 0.26, dark, 8, 6, 0.12);
  neck.position.set(0, ty(H * 0.785), -W * 0.02);
  tp.push(neck);

  const torso = fuse(tp, skin, 'torso');
  torso.position.y = WAIST_Y;
  g.add(torso);

  // --------------------------------------------------------------- head
  // Small, low, and pulled back between the shoulders. Nothing on the face juts
  // forward far enough to drag the visual head off the narrow head hitbox.
  const hp = [];

  const skull = blob(W * 0.25, H * 0.105, W * 0.25, dark, 12, 10, 0.12);
  hp.push(skull);

  // Heavy brow shading two small sunken eyes -- the only warm colour anywhere on
  // the model, so the face is findable at range without a neon head.
  const brow = blob(W * 0.26, H * 0.036, W * 0.13, dark, 8, 5, 0.10);
  brow.position.set(0, H * 0.028, W * 0.15);
  brow.rotation.x = -0.25;
  hp.push(brow);

  for (const sx of [-1, 1]) {
    const socket = blob(W * 0.075, W * 0.06, W * 0.05, deep, 5, 4, 0.08);
    socket.position.set(sx * W * 0.09, H * 0.004, W * 0.16);
    hp.push(socket);

    const eye = blob(W * 0.042, W * 0.036, W * 0.03, eyeMat, 6, 4, 0.05);
    eye.position.set(sx * W * 0.09, H * 0.004, W * 0.185);
    hp.push(eye);
  }

  // Underslung jaw, wider than the cranium: a face that is mostly bite.
  const jaw = blob(W * 0.22, H * 0.05, W * 0.19, dark, 8, 6, 0.14);
  jaw.position.set(0, -H * 0.05, W * 0.09);
  hp.push(jaw);

  for (const sx of [-1, 1]) {
    const tusk = spur(W * 0.042, W * 0.18, clawMat, 5);
    tusk.position.set(sx * W * 0.11, -H * 0.045, W * 0.13);
    tusk.rotation.x = 0.3;    // leaning forward over the muzzle (+Z is front)
    hp.push(tusk);
  }

  // A crooked little crown, so even a head this small still has a read.
  for (const [cx, cz, cl] of [[-0.09, -0.04, 0.14], [0.06, -0.08, 0.17]]) {
    const crown = spur(W * 0.035, W * cl, boneMat, 4);
    crown.position.set(W * cx, H * 0.072, W * cz);
    crown.rotation.set(-0.35, 0, cx * 2.2);
    hp.push(crown);
  }

  const head = fuse(hp, dark, 'head');
  head.position.set(0, ty(HEAD_Y), W * 0.02);
  torso.add(head);

  // --------------------------------------------------------------- arms
  // Knuckle-draggers: long enough that the fists hang past the knees. Only the
  // Z tilt is baked in, because the walk cycle owns rotation.x outright and any
  // baseline pitch set here would just be overwritten on the first frame.
  const buildArm = (side) => {
    const p = [];
    const big = side < 0 ? 1.14 : 1.0;
    const upperLen = H * 0.23 * big;
    const foreLen = H * 0.20 * big;

    const upper = bone(W * 0.26 * big, W * 0.22 * big, upperLen, skin, 10);
    p.push(upper);

    const cap = blob(W * 0.29 * big, W * 0.27 * big, W * 0.28 * big, skin, 8, 6);
    cap.position.y = -H * 0.012;
    p.push(cap);

    const elbow = blob(W * 0.25 * big, W * 0.23 * big, W * 0.24 * big, dark, 8, 6, 0.16);
    elbow.position.y = -upperLen + H * 0.012;
    p.push(elbow);

    // The forearm WIDENS toward the fist instead of tapering. Weight at the far
    // end of the swing is what makes it look like it would take a wall with it.
    const fore = bone(W * 0.23 * big, W * 0.30 * big, foreLen, dark, 10);
    fore.position.y = -upperLen + H * 0.014;
    p.push(fore);

    const wristY = -upperLen - foreLen + H * 0.014;

    const fist = blob(W * 0.33 * big, W * 0.31 * big, W * 0.33 * big, dark, 10, 8, 0.18);
    fist.position.y = wristY - W * 0.19 * big;
    p.push(fist);

    if (side < 0) {
      // Left arm is the club: a slab of fused bone erupting along the forearm
      // and out past the knuckles. Kept tucked in toward the body rather than
      // flung wide, or the silhouette stops reading as a body at all.
      const plate = blob(W * 0.15, H * 0.13, W * 0.15, boneMat, 8, 6, 0.20);
      plate.position.set(-W * 0.17, wristY + H * 0.07, -W * 0.03);
      plate.rotation.z = 0.2;
      p.push(plate);

      for (const [sy, sl, sr] of [[0.05, 0.28, 0.07], [-0.07, 0.23, 0.06]]) {
        const s = spur(W * sr, W * sl, boneMat, 5);
        s.position.set(-W * 0.20, wristY + H * sy, -W * 0.04);
        s.rotation.z = Math.PI * 0.72;   // raked down and outward, not sideways
        p.push(s);
      }

      const clubTip = spur(W * 0.10, W * 0.32, boneMat, 6);
      clubTip.position.set(-W * 0.08, wristY - W * 0.32, 0);
      clubTip.rotation.z = Math.PI * 0.92;
      p.push(clubTip);
    } else {
      // The right arm keeps a hand -- knuckle nubs and claws -- so the asymmetry
      // reads as "one arm mutated", not "one arm is missing".
      for (let i = 0; i < 3; i++) {
        const kx = (i - 1) * W * 0.14;
        const knuckle = blob(W * 0.08, W * 0.07, W * 0.08, dark, 6, 4, 0.15);
        knuckle.position.set(kx, wristY - W * 0.21, W * 0.23);
        p.push(knuckle);

        const claw = spur(W * 0.042, W * 0.17, clawMat, 5);
        claw.position.set(kx, wristY - W * 0.26, W * 0.27);
        claw.rotation.x = Math.PI * 0.62;
        p.push(claw);
      }
    }

    // Growths creeping down from the shoulder on both arms.
    const n = blob(W * 0.10, W * 0.09, W * 0.10, growth, 6, 4, 0.26);
    n.position.set(side * W * 0.15, -H * 0.06, -W * 0.08);
    p.push(n);

    const arm = fuse(p, skin, side < 0 ? 'armL' : 'armR');
    return { arm, reach: upperLen + foreLen + W * 0.4 * big };
  };

  const left = buildArm(-1);
  left.arm.position.set(-W * 0.50, ty(SHOULDER_Y), 0);
  left.arm.rotation.z = -0.11;
  torso.add(left.arm);

  const right = buildArm(1);
  right.arm.position.set(W * 0.48, ty(SHOULDER_Y), 0);
  right.arm.rotation.z = 0.11;
  torso.add(right.arm);

  // Armed types carry a visible sidearm on the right hand so the player can tell
  // at a glance which silhouettes shoot back. The brute does not, but the branch
  // stays so every zombie builder honours the same contract.
  if (type.armed) {
    const gun = new THREE.Group();
    gun.name = 'gun';

    const gunMetal = mat(0x2b3036, 0.45, 0.6);
    const gunDark = mat(0x1a1e22, 0.6, 0.3);

    // Barrel down +Z: the model's front. The AI yaws the whole group with
    // `atan2(dx, dz)`, so an unrotated brute is already looking at the player.
    const slide = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.26, 6), gunMetal);
    slide.rotation.x = Math.PI / 2;
    slide.position.z = 0.09;
    gun.add(slide);

    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.042, 0.15, 6), gunDark);
    grip.position.set(0, -0.08, -0.02);
    grip.rotation.x = 0.2;
    gun.add(grip);

    gun.position.set(0, -right.reach * 0.86, 0.06);
    right.arm.add(gun);
  }

  return g;
}
