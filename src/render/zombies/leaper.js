// LEAPER -- the pouncer.
//
// Reads as coiled. Everything about it says it is about to cover ground:
//   - permanently crouched, torso pitched forward over bent legs
//   - enormous thigh and calf muscle, far out of proportion to the arms
//   - long grasping forearms held forward, ready to land on you
//   - a narrow, forward-thrust head, so the silhouette has a clear direction
//
// It is the smallest of the roster and moves fastest, so it is built lighter
// than the others: fewer segments, no lathe on the limbs. What matters is the
// pose, and the pose is baked into the rest position rather than animated.
//
// Forward is +Z (enemy.yaw = atan2(dx, dz)).

import * as THREE from '../../../vendor/three.module.js';
import {
  mat, glowMat, haloMat, bone, blob, chunk, lathe,
  perturbNormal, BONE, GORE, MOUTH,
} from '../anatomy.js';

// Narrow and deep rather than broad: a runner's chest, not a brawler's.
const TRUNK = [
  [0.00, 0.04], [0.05, 0.62], [0.20, 0.78], [0.42, 0.90],
  [0.62, 0.92], [0.80, 0.82], [0.92, 0.62], [1.00, 0.30],
  [1.03, 0.02],
];

export function buildLeaperModel(type) {
  const H = type.height;
  const W = type.width;
  const g = new THREE.Group();

  const flesh = mat(type.bodyColor, 0.9);
  const fleshDark = mat(type.accentColor, 0.95);
  const headMat = mat(type.headColor, 0.88);
  const boneMat = mat(BONE, 0.65);
  const goreMat = mat(GORE, 0.8);
  const sinew = mat(0x6b2f86, 0.85);

  // Crouched, so the standing height is spent on a low body and long limbs.
  const legH = H * 0.40;
  const torsoH = H * 0.40;
  const headR = W * 0.16;

  // ---------------------------------------------------------------- torso
  const torso = lathe(TRUNK, torsoH, W * 0.42, flesh, 12);
  torso.name = 'torso';
  perturbNormal(torso.geometry, W * 0.02, 6, 13);
  torso.scale.set(0.88, 1, 1.1);      // deep chest, narrow across
  torso.position.y = legH;
  // Pitched forward: the single biggest contributor to the coiled read.
  torso.rotation.x = 0.42;
  g.add(torso);

  // Spine ridge along the hunched back.
  for (let i = 0; i < 5; i++) {
    const v = 0.28 + i * 0.14;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(W * 0.05, W * 0.16, 5), boneMat);
    spike.position.set(0, legH + torsoH * v, -W * 0.30 + i * W * 0.045);
    spike.rotation.x = -0.9;
    g.add(spike);
  }

  // Exposed ribcage down the flanks.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const rib = bone(W * 0.24, W * 0.02, boneMat, 1, 5);
      rib.position.set(sx * W * 0.24, legH + torsoH * (0.46 + i * 0.14), W * 0.10);
      rib.rotation.z = sx * 1.25;
      rib.rotation.x = 0.3;
      g.add(rib);
    }
  }

  // ---------------------------------------------------------------- head
  // Thrust forward on a stretched neck, low and level -- a hunting posture.
  const neck = bone(W * 0.24, W * 0.06, sinew, 1, 6);
  neck.position.set(0, legH + torsoH * 0.90, W * 0.06);
  neck.rotation.x = -1.35;
  g.add(neck);

  const head = blob(headR, 0.85, 0.85, 1.35, headMat, 9, 6);
  head.name = 'head';
  perturbNormal(head.geometry, headR * 0.08, 8, 6);
  head.position.set(0, legH + torsoH * 0.96, W * 0.34);
  head.rotation.x = 0.2;
  g.add(head);

  // A long jaw split wide -- the thing lands mouth-first.
  const jaw = blob(headR * 0.6, 0.8, 0.5, 1.3, headMat, 8, 5);
  jaw.position.set(0, head.position.y - headR * 0.5, head.position.z + headR * 0.30);
  jaw.rotation.x = 0.45;
  g.add(jaw);

  const maw = blob(headR * 0.46, 0.75, 0.7, 1.0, mat(MOUTH, 1), 7, 5);
  maw.position.set(0, head.position.y - headR * 0.22, head.position.z + headR * 0.44);
  g.add(maw);

  const fangMat = mat(BONE, 0.55);
  for (let i = 0; i < 4; i++) {
    const sx = i < 2 ? -1 : 1;
    const fang = new THREE.Mesh(new THREE.ConeGeometry(headR * 0.09, headR * 0.42, 5), fangMat);
    fang.position.set(sx * headR * (0.2 + (i % 2) * 0.16),
      head.position.y - headR * 0.30, head.position.z + headR * (0.7 - (i % 2) * 0.3));
    fang.rotation.x = Math.PI;
    g.add(fang);
  }

  // Eyes: the brightest thing on the model, so it can be picked out mid-air.
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.17, 6, 5),
      glowMat(0xe0a8ff, 0xa040d0, 1.3));
    eye.position.set(sx * headR * 0.30, head.position.y + headR * 0.24, head.position.z + headR * 0.62);
    g.add(eye);

    const halo = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.30, 6, 5), haloMat(0xc060ff, 0.20));
    halo.name = 'haloEye';
    halo.position.copy(eye.position);
    g.add(halo);
  }

  // ---------------------------------------------------------------- arms
  // Long, thin, and held forward. The walk cycle swings these from the joint.
  const armLen = torsoH * 1.15;
  const shoulderY = legH + torsoH * 0.78;
  for (const [name, sx] of [['armL', -1], ['armR', 1]]) {
    const arm = bone(armLen, W * 0.075, fleshDark, 1, 6);
    arm.name = name;
    arm.position.set(sx * W * 0.32, shoulderY, W * 0.14);
    arm.rotation.x = -0.75;           // reaching ahead
    arm.rotation.z = sx * 0.18;
    g.add(arm);

    const hand = chunk(W * 0.085, flesh, 80 + sx);
    hand.position.y = -armLen * 0.94;
    arm.add(hand);

    // Three long hooks per hand.
    for (let i = 0; i < 3; i++) {
      const claw = new THREE.Mesh(new THREE.ConeGeometry(W * 0.022, W * 0.22, 5), fangMat);
      claw.position.set((i - 1) * W * 0.055, -armLen * 1.08, W * 0.03);
      claw.rotation.x = Math.PI * 0.12;
      arm.add(claw);
    }
  }

  // ---------------------------------------------------------------- legs
  // The engine. Deliberately overbuilt relative to everything else.
  for (const [name, sx] of [['legL', -1], ['legR', 1]]) {
    const leg = bone(legH, W * 0.115, fleshDark, 1, 7);
    leg.name = name;
    leg.position.set(sx * W * 0.22, legH, 0);
    g.add(leg);

    // Thigh belly, high on the limb.
    const thigh = blob(W * 0.17, 1.0, 1.5, 1.1, flesh, 8, 6);
    thigh.position.set(0, -legH * 0.24, -W * 0.02);
    leg.add(thigh);

    // Calf, lower and behind -- a digitigrade suggestion without the rig.
    const calf = blob(W * 0.13, 0.9, 1.4, 1.0, flesh, 8, 6);
    calf.position.set(0, -legH * 0.62, -W * 0.06);
    leg.add(calf);

    // Long splayed foot, so the landing looks survivable.
    const foot = blob(W * 0.13, 0.9, 0.45, 1.9, fleshDark, 7, 5);
    foot.position.set(0, -legH * 0.95, W * 0.12);
    leg.add(foot);

    for (let i = 0; i < 3; i++) {
      const toe = new THREE.Mesh(new THREE.ConeGeometry(W * 0.022, W * 0.14, 5), fangMat);
      toe.position.set((i - 1) * W * 0.06, -legH * 0.97, W * 0.30);
      toe.rotation.x = Math.PI * 0.5;
      leg.add(toe);
    }
  }

  // A few open wounds, tying it to the roster's shared vocabulary.
  for (let i = 0; i < 3; i++) {
    const w = chunk(W * 0.05, goreMat, 90 + i);
    w.position.set((i % 2 ? 1 : -1) * W * 0.20, legH + torsoH * (0.4 + i * 0.2), W * 0.16);
    g.add(w);
  }

  g.traverse((o) => { if (o.isMesh) o.castShadow = !o.name.startsWith('halo'); });
  return g;
}
