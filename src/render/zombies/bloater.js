// BLOATER -- the walking bomb.
//
// The read has to be "get away from that one", and it has to happen at the far
// end of the arena, because by the time a bloater is close enough to identify
// by its face it is already too late.
//
// So the whole model is pressure:
//   - a grotesquely distended gut that is wider than the shoulders, which is
//     the opposite of every other zombie here and reads as wrong immediately
//   - translucent sacs over the chest and back, lit from inside, that swell
//     and flare once the fuse is lit
//   - stubby arms held out from the body, because the gut is in the way
//   - a small head lost on top of the mass, so the gut is what you look at
//
// Forward is +Z (enemy.yaw = atan2(dx, dz)).

import * as THREE from '../../../vendor/three.module.js';
import {
  mat, glowMat, haloMat, bone, blob, chunk, lathe,
  perturbNormal, BONE, GORE, MOUTH,
} from '../anatomy.js';

// Pear-shaped: narrow chest, enormous belly. The widest point is deliberately
// low, at about a third of the torso height.
const TRUNK = [
  [0.00, 0.04], [0.04, 0.72], [0.16, 1.00], [0.32, 1.10],
  [0.50, 1.02], [0.68, 0.84], [0.84, 0.74], [0.95, 0.52],
  [1.00, 0.26], [1.03, 0.02],
];

export function buildBloaterModel(type) {
  const H = type.height;
  const W = type.width;
  const g = new THREE.Group();

  const flesh = mat(type.bodyColor, 0.9);
  const fleshDark = mat(type.accentColor, 0.95);
  const headMat = mat(type.headColor, 0.88);
  const boneMat = mat(BONE, 0.7);
  const goreMat = mat(GORE, 0.8);

  // The sacs are the tell. Emissive so they survive being seen against bright
  // terrain, and semi-transparent so they read as full of something.
  const sacMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHex(0xcbe04a, THREE.SRGBColorSpace),
    roughness: 0.35, metalness: 0,
    emissive: new THREE.Color().setHex(0x9fbf20, THREE.SRGBColorSpace),
    emissiveIntensity: 0.8,
    transparent: true, opacity: 0.9,
  });

  const legH = H * 0.34;              // short legs under a heavy body
  const torsoH = H * 0.46;
  const headR = W * 0.17;

  // ---------------------------------------------------------------- torso
  const torso = lathe(TRUNK, torsoH, W * 0.52, flesh, 13);
  torso.name = 'torso';
  perturbNormal(torso.geometry, W * 0.03, 4, 7);   // lumpy, straining skin
  torso.position.y = legH;
  g.add(torso);

  // Split skin over the belly, showing the pressure underneath.
  for (let i = 0; i < 3; i++) {
    const split = blob(W * 0.13, 1.6, 0.5, 0.6, goreMat, 7, 5);
    split.position.set((i - 1) * W * 0.24, legH + torsoH * (0.26 + i * 0.06), W * 0.50);
    split.rotation.z = (i - 1) * 0.4;
    g.add(split);
  }

  // ---------------------------------------------------------------- sacs
  // Named 'sac' so syncEnemyMesh can pulse them when the fuse is lit.
  const sacs = [
    [0, legH + torsoH * 0.30, W * 0.46, W * 0.30],       // belly, the big one
    [-W * 0.34, legH + torsoH * 0.58, W * 0.26, W * 0.19],
    [W * 0.34, legH + torsoH * 0.58, W * 0.26, W * 0.19],
    [0, legH + torsoH * 0.44, -W * 0.44, W * 0.24],      // back
    [-W * 0.30, legH + torsoH * 0.20, -W * 0.30, W * 0.15],
  ];
  for (const [x, y, z, r] of sacs) {
    const sac = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), sacMat);
    sac.name = 'sac';
    sac.position.set(x, y, z);
    g.add(sac);

    // A dim shell so each sac has a halo rather than a hard edge.
    const h = new THREE.Mesh(new THREE.SphereGeometry(r * 1.3, 8, 6), haloMat(0xd6f050, 0.14));
    h.name = 'haloSac';
    h.position.set(x, y, z);
    g.add(h);
  }

  // ---------------------------------------------------------------- head
  // Small, sunk, and tipped back -- the neck cannot hold it up any more.
  const head = blob(headR, 1.0, 0.92, 1.05, headMat, 9, 6);
  head.name = 'head';
  perturbNormal(head.geometry, headR * 0.09, 7, 3);
  head.position.set(0, legH + torsoH + headR * 0.55, W * 0.02);
  head.rotation.x = -0.3;
  g.add(head);

  const maw = blob(headR * 0.52, 1.0, 0.8, 0.7, mat(MOUTH, 1), 7, 5);
  maw.position.set(0, head.position.y - headR * 0.34, head.position.z + headR * 0.62);
  g.add(maw);

  // Bile running from the mouth, which is the other half of the "this thing is
  // full of something" read.
  const drip = blob(headR * 0.22, 0.7, 1.8, 0.7, sacMat, 6, 5);
  drip.position.set(0, head.position.y - headR * 0.85, head.position.z + headR * 0.58);
  g.add(drip);

  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.15, 6, 5),
      glowMat(0xe8ff8c, 0x8fae20, 0.7));
    eye.position.set(sx * headR * 0.36, head.position.y + headR * 0.14, head.position.z + headR * 0.74);
    g.add(eye);
  }

  // ---------------------------------------------------------------- arms
  // Short and held wide, because the gut will not let them hang straight.
  const armLen = torsoH * 0.62;
  const shoulderY = legH + torsoH * 0.82;
  for (const [name, sx] of [['armL', -1], ['armR', 1]]) {
    const arm = bone(armLen, W * 0.10, fleshDark, 1, 7);
    arm.name = name;
    arm.position.set(sx * W * 0.42, shoulderY, 0);
    arm.rotation.z = sx * 0.42;        // pushed out by the belly
    g.add(arm);

    const hand = chunk(W * 0.10, flesh, 20 + sx);
    hand.position.y = -armLen * 0.96;
    arm.add(hand);
  }

  // ---------------------------------------------------------------- legs
  // Splayed and bowed under the weight.
  for (const [name, sx] of [['legL', -1], ['legR', 1]]) {
    const leg = bone(legH, W * 0.15, fleshDark, 1, 7);
    leg.name = name;
    leg.position.set(sx * W * 0.20, legH, 0);
    leg.rotation.z = sx * 0.12;
    g.add(leg);

    const foot = blob(W * 0.15, 1.0, 0.55, 1.5, fleshDark, 7, 5);
    foot.position.set(0, -legH * 0.95, W * 0.08);
    leg.add(foot);
  }

  // A couple of exposed ribs up top, tying it to the rest of the roster.
  for (const sx of [-1, 1]) {
    const rib = bone(W * 0.26, W * 0.022, boneMat, 1, 5);
    rib.position.set(sx * W * 0.22, legH + torsoH * 0.72, W * 0.30);
    rib.rotation.z = sx * 1.3;
    g.add(rib);
  }

  g.traverse((o) => { if (o.isMesh) o.castShadow = !o.name.startsWith('halo'); });
  return g;
}
