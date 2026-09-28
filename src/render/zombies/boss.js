// ABOMINATION -- the boss.
//
// It has one job the other models do not: teach its own fight from across the
// arena. A player who has never seen it should work out, without being told,
// that the front is armoured and the back is not.
//
// Everything in the silhouette serves that:
//   - a slab of bolted plate across the chest, shoulders and thighs, so the
//     front reads as *covered*
//   - a spine split open down the back with a molten core sitting in it, the
//     only bright thing on the model and visible through the bloom pass at
//     forty metres
//   - the head sunk between enormous trapezius humps, so there is no neck to
//     shoot and the eye is drawn past it to the core
//   - asymmetric arms: a huge armoured right, a withered left, which makes the
//     facing unambiguous even in silhouette
//
// Everything here is proportional to type.height and type.width, so the model
// follows the hitbox rather than the other way round. That matters: it was
// authored at 4.4m and the hitbox has since come down to 2.7 so the thing can
// actually get through a doorway, and a model that had baked its own scale in
// would now be a boss wearing the building.
//
// There is rarely more than one of them alive, so it can afford roughly four
// times the triangles of a grunt.
//
// Forward is +Z (enemy.yaw = atan2(dx, dz)).

import * as THREE from '../../../vendor/three.module.js';
import {
  srgb, mat, glowMat, haloMat, bone, blob, chunk, lathe, plate,
  perturbNormal, perturbRadial, BONE, GORE, MOUTH,
} from '../anatomy.js';

/** Bolt heads, repeated around the plating. Shared geometry, one draw setup. */
function rivets(count, radius, material, y, z, spread) {
  const g = new THREE.Group();
  const geo = new THREE.SphereGeometry(radius, 5, 4);
  for (let i = 0; i < count; i++) {
    const m = new THREE.Mesh(geo, material);
    const t = count === 1 ? 0.5 : i / (count - 1);
    m.position.set((t - 0.5) * spread, y, z);
    g.add(m);
  }
  return g;
}

// Trunk profile: enormous chest tapering to a comparatively small pelvis, so
// the mass sits high and the thing reads as top-heavy and slow.
const TRUNK = [
  [0.00, 0.02], [0.03, 0.62], [0.14, 0.74], [0.34, 0.86],
  [0.56, 1.00], [0.74, 1.04], [0.88, 0.92], [0.97, 0.62],
  [1.00, 0.34], [1.03, 0.02],
];

export function buildBossModel(type) {
  const H = type.height;
  // type.width is the collision box, which is deliberately generous so players
  // cannot clip past. Modelling to it produces a barrel, so the visual mass is
  // pulled in and the height is allowed to read instead.
  const W = type.width * 0.72;
  const g = new THREE.Group();

  // Deliberately spread across the value range. A single mid-red mass has no
  // internal contrast, so it reads as one silhouette-shaped blob no matter how
  // much geometry is in it: pale head, mid torso, near-black legs.
  const flesh = mat(type.bodyColor, 0.92);
  const fleshDark = mat(0x3a161c, 0.9);          // legs and underside
  const fleshPale = mat(0xb9737a, 0.85);         // head, so it separates
  const armour = mat(0x3a4048, 0.5, 0.55);       // cold steel against warm flesh
  const armourLip = mat(0x6d3a3a, 0.45, 0.6);
  const boneMat = mat(BONE, 0.7);
  const goreMat = mat(GORE, 0.75);
  const rivet = mat(0x8a6a3a, 0.4, 0.8);
  const coreMat = glowMat(0xffd24a, 0xff7a1e, 1.6);
  const emberMat = glowMat(0xffb03d, 0xff5a10, 1.1);

  // Proportions. Legs are short for the height -- a heavy thing is not leggy.
  const legH = H * 0.46;
  const torsoH = H * 0.36;
  const headR = W * 0.21;

  // ---------------------------------------------------------------- torso
  const torso = lathe(TRUNK, torsoH, W * 0.56, flesh, 14);
  torso.name = 'torso';
  perturbNormal(torso.geometry, W * 0.018, 5, 11);
  torso.scale.set(1.0, 1, 0.82);      // slab-sided, not barrel-round
  torso.position.y = legH;
  g.add(torso);

  // Trapezius humps swallowing the neck.
  for (const sx of [-1, 1]) {
    const hump = blob(W * 0.24, 1.05, 0.7, 0.9, flesh, 9, 6);
    hump.position.set(sx * W * 0.34, legH + torsoH * 0.88, -W * 0.04);
    torso.parent.add(hump);
  }

  // --- front plating -----------------------------------------------------
  // Curved shells, not boxes: the chest plate wraps the ribcage and catches a
  // highlight along its edge, which is what sells it as armour.
  const chestPlate = plate(W * 0.62, Math.PI * 0.85, Math.PI * 0.42, armour);
  chestPlate.rotation.x = -0.12;
  chestPlate.position.set(0, legH + torsoH * 0.60, W * 0.06);
  chestPlate.scale.set(1.02, 1, 0.9);
  g.add(chestPlate);

  const chestLip = plate(W * 0.64, Math.PI * 0.85, Math.PI * 0.07, armourLip);
  chestLip.rotation.x = -0.12;
  chestLip.position.set(0, legH + torsoH * 0.40, W * 0.06);
  chestLip.scale.set(1.02, 1, 0.9);
  g.add(chestLip);

  g.add(rivets(5, W * 0.035, rivet, legH + torsoH * 0.78, W * 0.52, W * 0.72));
  g.add(rivets(5, W * 0.035, rivet, legH + torsoH * 0.44, W * 0.50, W * 0.68));

  // Belly plate over the gut.
  const gutPlate = plate(W * 0.50, Math.PI * 0.7, Math.PI * 0.34, armour);
  gutPlate.position.set(0, legH + torsoH * 0.20, W * 0.10);
  g.add(gutPlate);

  // --- the weak point ----------------------------------------------------
  // A cracked-open spine with a molten core in it. Built as a recessed cavity
  // so the glow has somewhere to sit rather than floating on the surface.
  const cavity = blob(W * 0.36, 1.0, 1.25, 0.7, mat(0x180a0c, 0.95), 10, 7);
  cavity.position.set(0, legH + torsoH * 0.62, -W * 0.40);
  g.add(cavity);

  // Ribs peeled back around the opening, framing it.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const rib = bone(W * 0.34, W * 0.035, boneMat, 1, 5);
      rib.position.set(sx * W * 0.20, legH + torsoH * (0.82 - i * 0.14), -W * 0.40);
      rib.rotation.z = sx * (0.5 + i * 0.10);
      rib.rotation.x = -0.5;
      g.add(rib);
    }
  }

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(W * 0.26, 1), coreMat);
  core.name = 'core';
  perturbRadial(core.geometry, W * 0.03, 8, 21);
  core.position.set(0, legH + torsoH * 0.62, -W * 0.44);
  g.add(core);

  // Kept modest: too dense a halo flattens the faceted core behind it into a
  // plain orange disc, and the faceting is what makes it look molten.
  const halo = new THREE.Mesh(new THREE.SphereGeometry(W * 0.34, 12, 8), haloMat(0xff9b30, 0.15));
  halo.name = 'haloCore';
  halo.position.copy(core.position);
  g.add(halo);

  // Embers leaking from the cavity, so the core looks like it is under
  // pressure rather than merely switched on.
  for (let i = 0; i < 5; i++) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(W * 0.045, 5, 4), emberMat);
    e.name = 'ember';
    const a = (i / 5) * Math.PI * 2;
    e.position.set(Math.cos(a) * W * 0.28, legH + torsoH * (0.62 + Math.sin(a) * 0.22), -W * 0.46);
    g.add(e);
  }

  // ---------------------------------------------------------------- head
  // Sunk between the humps, tilted down. No neck to shoot.
  const head = blob(headR, 1.05, 1.0, 1.15, fleshPale, 10, 7);
  head.name = 'head';
  perturbNormal(head.geometry, headR * 0.07, 7, 5);
  head.position.set(0, legH + torsoH + headR * 0.86, W * 0.10);
  g.add(head);

  // Heavy brow shelf, and a jaw hanging open below it.
  const brow = plate(headR * 1.02, Math.PI * 1.1, Math.PI * 0.18, mat(type.accentColor, 0.85));
  brow.position.copy(head.position);
  brow.position.y += headR * 0.24;
  brow.rotation.x = -0.24;
  g.add(brow);

  const jaw = blob(headR * 0.62, 1.0, 0.62, 0.9, fleshPale, 8, 5);
  jaw.position.set(0, head.position.y - headR * 0.62, head.position.z + headR * 0.30);
  jaw.rotation.x = 0.3;
  g.add(jaw);

  const maw = blob(headR * 0.46, 1.0, 0.7, 0.6, mat(MOUTH, 1), 7, 5);
  maw.position.set(0, head.position.y - headR * 0.34, head.position.z + headR * 0.52);
  g.add(maw);

  // Tusks, so the head has a readable direction from any angle.
  for (const sx of [-1, 1]) {
    const tusk = new THREE.Mesh(new THREE.ConeGeometry(headR * 0.13, headR * 0.66, 6), boneMat);
    tusk.position.set(sx * headR * 0.40, head.position.y - headR * 0.34, head.position.z + headR * 0.50);
    tusk.rotation.x = Math.PI * 0.92;
    tusk.rotation.z = sx * 0.18;
    g.add(tusk);
  }

  // Two sunken eye coals. Emissive, but far dimmer than the core -- the core
  // has to stay the brightest thing on the model.
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.13, 6, 5),
      glowMat(0xffb84d, 0xff6a20, 0.9));
    eye.position.set(sx * headR * 0.38, head.position.y + headR * 0.06, head.position.z + headR * 0.72);
    g.add(eye);
  }

  // ---------------------------------------------------------------- arms
  // Asymmetric: an armoured right slab and a withered left. This is what makes
  // the facing readable in pure silhouette.
  const armLen = torsoH * 1.05;
  const shoulderY = legH + torsoH * 0.86;

  const armR = bone(armLen, W * 0.155, flesh, 1, 8);
  armR.name = 'armR';
  armR.position.set(W * 0.52, shoulderY, 0);
  g.add(armR);

  const armL = bone(armLen * 0.86, W * 0.10, fleshDark, 1, 7);   // withered
  armL.name = 'armL';
  armL.position.set(-W * 0.50, shoulderY, 0);
  g.add(armL);

  // Pauldron over the right shoulder only.
  const pauldron = plate(W * 0.30, Math.PI * 1.4, Math.PI * 0.55, armour);
  pauldron.position.set(W * 0.52, shoulderY + W * 0.04, 0);
  armR.parent.add(pauldron);

  // Forearm bracer and a fist, parented to the arm so they swing with it.
  const bracer = new THREE.Mesh(
    new THREE.CylinderGeometry(W * 0.19, W * 0.17, armLen * 0.30, 8), armour);
  bracer.position.y = -armLen * 0.66;
  armR.add(bracer);

  const fist = chunk(W * 0.21, flesh, 31);
  fist.position.y = -armLen * 0.96;
  armR.add(fist);

  const clawMat = mat(BONE, 0.6);
  for (let i = 0; i < 3; i++) {
    const claw = new THREE.Mesh(new THREE.ConeGeometry(W * 0.045, W * 0.30, 5), clawMat);
    claw.position.set((i - 1) * W * 0.13, -armLen * 1.10, W * 0.06);
    claw.rotation.x = Math.PI * 0.06;
    armR.add(claw);
  }

  const handL = chunk(W * 0.12, fleshDark, 32);
  handL.position.y = -armLen * 0.86 * 0.98;
  armL.add(handL);

  // ---------------------------------------------------------------- legs
  const legGap = W * 0.30;
  for (const [name, sx] of [['legL', -1], ['legR', 1]]) {
    const leg = bone(legH, W * 0.21, fleshDark, 1, 8);
    leg.name = name;
    leg.position.set(sx * legGap, legH, 0);
    g.add(leg);

    // Thigh plate, so the armoured read continues down the front.
    const thighPlate = plate(W * 0.26, Math.PI * 0.9, Math.PI * 0.5, armour);
    thighPlate.position.set(0, -legH * 0.26, W * 0.04);
    leg.add(thighPlate);

    // Knee and a splayed foot.
    const knee = chunk(W * 0.16, fleshDark, 40 + sx);
    knee.position.y = -legH * 0.54;
    leg.add(knee);

    const foot = blob(W * 0.24, 1.0, 0.5, 1.5, fleshDark, 8, 5);
    foot.name = 'foot';
    foot.position.set(0, -legH * 0.96, W * 0.14);
    leg.add(foot);

    for (let i = 0; i < 3; i++) {
      const toe = new THREE.Mesh(new THREE.ConeGeometry(W * 0.04, W * 0.16, 5), clawMat);
      toe.position.set((i - 1) * W * 0.10, -legH * 0.98, W * 0.34);
      toe.rotation.x = Math.PI * 0.5;
      leg.add(toe);
    }
  }

  // Gore where the plating meets flesh, tying the two materials together.
  for (let i = 0; i < 6; i++) {
    const w = chunk(W * 0.07, goreMat, 50 + i);
    const a = (i / 6) * Math.PI * 2;
    w.position.set(Math.cos(a) * W * 0.5, legH + torsoH * (0.3 + (i % 3) * 0.2), Math.sin(a) * W * 0.4);
    g.add(w);
  }

  g.traverse((o) => { if (o.isMesh) o.castShadow = !o.name.startsWith('halo'); });
  return g;
}
