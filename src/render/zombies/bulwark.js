// BULWARK -- the shield zombie.
//
// This model has the hardest job in the roster: the player has to understand,
// without being told, that shooting the front is pointless. If that fails the
// enemy just feels like a bullet sponge and the whole archetype is wasted.
//
// So the shield is not a plate stuck on a zombie -- it is the enemy's entire
// front. It is taller than the torso, wider than the shoulders, and battered
// enough to read as something that has already stopped a lot of bullets. From
// the front you see shield and almost nothing else; from behind you see an
// entirely unprotected back, which is the answer.
//
// The riot-shield read is deliberate: a viewport slit, a reinforced rim, and
// the arm strapped through the back of it.
//
// Forward is +Z (enemy.yaw = atan2(dx, dz)).

import * as THREE from '../../../vendor/three.module.js';
import {
  mat, glowMat, bone, blob, chunk, lathe, plate,
  perturbNormal, plateSurface, BONE, GORE, RAG, MOUTH, STEEL,
} from '../anatomy.js';

const TRUNK = [
  [0.00, 0.03], [0.03, 0.60], [0.14, 0.72], [0.34, 0.82],
  [0.56, 0.94], [0.76, 0.98], [0.90, 0.86], [0.97, 0.58],
  [1.00, 0.30], [1.03, 0.02],
];

/**
 * The shield. A curved shell rather than a slab, with a rim, a viewing slit
 * and rivets, built as its own group so it can be positioned as one object.
 */
function buildShield(W) {
  const s = new THREE.Group();
  s.name = 'shield';

  const steel = mat(STEEL, 0.5, 0.6);
  const steelDark = mat(0x3c444c, 0.55, 0.5);
  const brass = mat(0x8a6a3a, 0.4, 0.75);

  // A gentle bow: the curvature radius is far larger than the shield itself,
  // so it reads as a slightly dished panel rather than a piece of a ball.
  // Sized to cover thigh to chin -- about 0.95m across and 1.05m tall on a
  // 0.8m-wide body. Any larger and it hides the head, which costs the model its
  // face and the player their headshot; any smaller and it stops reading as
  // cover worth walking around.
  const R = W * 1.8;
  const wide = Math.PI * 0.21;
  const tall = Math.PI * 0.235;

  const face = plate(R, wide, tall, steel, 0.04);
  face.name = 'shieldFace';
  // Dents. It has stopped a lot of bullets and should look like it.
  perturbNormal(face.geometry, W * 0.010, 16, 17);
  s.add(face);

  // Reinforced rim, top and bottom. Narrower and lighter than the first pass:
  // wide dark bands read as holes punched through the shield rather than as
  // trim on it.
  const rimSteel = mat(0x565f68, 0.45, 0.65);
  for (const sign of [1, -1]) {
    const rim = plate(R, wide * 0.98, Math.PI * 0.022, rimSteel, 0.05);
    rim.position.y = Math.sin(sign * tall * 0.45) * R;
    s.add(rim);
  }

  // Viewport slit across the upper third. This one detail is what makes it a
  // riot shield instead of a sheet of metal.
  const slit = plate(R * 0.995, wide * 0.55, Math.PI * 0.035, mat(0x0c1014, 1), 0.02);
  slit.position.y = Math.sin(tall * 0.24) * R;
  slit.position.z = 0.005;
  s.add(slit);

  // Rivets, placed by the same angles that defined the plate.
  const rivetGeo = new THREE.SphereGeometry(W * 0.020, 5, 4);
  for (let i = 0; i < 6; i++) {
    for (const sign of [1, -1]) {
      const r = new THREE.Mesh(rivetGeo, brass);
      r.position.copy(plateSurface(R, (i / 5 - 0.5) * wide * 0.86, sign * tall * 0.47, W * 0.01));
      s.add(r);
    }
  }

  // Vertical spine down the centre of the face.
  const spine = plate(R * 0.998, Math.PI * 0.022, tall * 0.92, steelDark, 0.10);
  spine.position.z = 0.004;
  s.add(spine);

  return s;
}

export function buildBulwarkModel(type) {
  const H = type.height;
  const W = type.width;
  const g = new THREE.Group();

  const flesh = mat(type.bodyColor, 0.92);
  const fleshDark = mat(type.accentColor, 0.95);
  const headMat = mat(type.headColor, 0.9);
  const boneMat = mat(BONE, 0.7);
  const ragMat = mat(RAG, 1);
  const goreMat = mat(GORE, 0.8);

  const legH = H * 0.44;
  const torsoH = H * 0.38;
  const headR = W * 0.16;

  // ---------------------------------------------------------------- torso
  const torso = lathe(TRUNK, torsoH, W * 0.46, flesh, 13);
  torso.name = 'torso';
  perturbNormal(torso.geometry, W * 0.02, 5, 9);
  torso.scale.set(1.06, 1, 0.86);
  torso.position.y = legH;
  g.add(torso);

  // Scraps of a uniform, so it reads as something that was once a person with
  // a job -- which is where the shield came from.
  const tabard = plate(W * 0.5, Math.PI * 0.8, Math.PI * 0.5, ragMat, 0.02);
  tabard.position.set(0, legH + torsoH * 0.42, -W * 0.04);
  tabard.rotation.y = Math.PI;
  g.add(tabard);

  // ---------------------------------------------------------------- head
  // Ducked down behind the shield rim.
  const head = blob(headR, 1.0, 1.05, 1.08, headMat, 9, 6);
  head.name = 'head';
  perturbNormal(head.geometry, headR * 0.08, 7, 4);
  head.position.set(0, legH + torsoH + headR * 0.62, -W * 0.06);
  head.rotation.x = 0.22;
  g.add(head);

  const jaw = blob(headR * 0.55, 1.0, 0.55, 0.85, headMat, 7, 5);
  jaw.position.set(0, head.position.y - headR * 0.60, head.position.z + headR * 0.34);
  g.add(jaw);

  const maw = blob(headR * 0.4, 1.0, 0.6, 0.5, mat(MOUTH, 1), 6, 5);
  maw.position.set(0, head.position.y - headR * 0.36, head.position.z + headR * 0.54);
  g.add(maw);

  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.14, 6, 5),
      glowMat(0xd8e8ff, 0x4a6a90, 0.6));
    eye.position.set(sx * headR * 0.34, head.position.y + headR * 0.10, head.position.z + headR * 0.72);
    g.add(eye);
  }

  // A battered helmet, matching the shield.
  const helm = plate(headR * 1.16, Math.PI * 2, Math.PI * 0.55, mat(0x4a525a, 0.5, 0.55));
  helm.position.copy(head.position);
  helm.position.y += headR * 0.16;
  g.add(helm);

  // ---------------------------------------------------------------- arms
  const armLen = torsoH * 0.95;
  const shoulderY = legH + torsoH * 0.84;

  // Left arm carries the shield, held across the body.
  const armL = bone(armLen, W * 0.10, fleshDark, 1, 7);
  armL.name = 'armL';
  armL.position.set(-W * 0.34, shoulderY, W * 0.08);
  armL.rotation.x = -0.62;
  g.add(armL);

  const shield = buildShield(W);
  // Positioned in front of the chest, covering from thigh to above the head --
  // this placement is the archetype.
  // Centred just below the chest so the head clears the top rim.
  shield.position.set(W * 0.08, legH + torsoH * 0.30, W * 0.34);
  g.add(shield);

  // Straps: the arm visibly goes through the back of the shield.
  const strapMat = mat(0x2e2620, 0.9);
  for (const dy of [0.12, -0.12]) {
    const strap = new THREE.Mesh(
      new THREE.TorusGeometry(W * 0.11, W * 0.02, 5, 10, Math.PI), strapMat);
    strap.position.set(-W * 0.10, legH + torsoH * (0.30 + dy), W * 0.26);
    strap.rotation.y = Math.PI / 2;
    g.add(strap);
  }

  // Right arm free, hanging, with a cleaver-ish claw.
  const armR = bone(armLen, W * 0.115, flesh, 1, 7);
  armR.name = 'armR';
  armR.position.set(W * 0.42, shoulderY, -W * 0.02);
  g.add(armR);

  const fist = chunk(W * 0.13, flesh, 27);
  fist.position.y = -armLen * 0.94;
  armR.add(fist);
  for (let i = 0; i < 3; i++) {
    const claw = new THREE.Mesh(new THREE.ConeGeometry(W * 0.028, W * 0.17, 5), boneMat);
    claw.position.set((i - 1) * W * 0.07, -armLen * 1.06, W * 0.04);
    claw.rotation.x = Math.PI * 0.1;
    armR.add(claw);
  }

  // Pauldron on the shield shoulder only.
  const pauldron = plate(W * 0.22, Math.PI * 1.3, Math.PI * 0.5, mat(0x4a525a, 0.5, 0.55));
  pauldron.position.set(-W * 0.40, shoulderY + W * 0.03, 0);
  g.add(pauldron);

  // ---------------------------------------------------------------- legs
  for (const [name, sx] of [['legL', -1], ['legR', 1]]) {
    const leg = bone(legH, W * 0.145, fleshDark, 1, 7);
    leg.name = name;
    leg.position.set(sx * W * 0.19, legH, 0);
    g.add(leg);

    const knee = chunk(W * 0.10, flesh, 60 + sx);
    knee.position.y = -legH * 0.52;
    leg.add(knee);

    const foot = blob(W * 0.15, 1.0, 0.5, 1.5, fleshDark, 7, 5);
    foot.position.set(0, -legH * 0.95, W * 0.08);
    leg.add(foot);
  }

  // Wounds on the unprotected back, hinting where it is soft.
  for (let i = 0; i < 4; i++) {
    const w = chunk(W * 0.055, goreMat, 70 + i);
    w.position.set((i % 2 ? 1 : -1) * W * 0.16, legH + torsoH * (0.3 + i * 0.16), -W * 0.36);
    g.add(w);
  }
  for (const sx of [-1, 1]) {
    const rib = bone(W * 0.22, W * 0.02, boneMat, 1, 5);
    rib.position.set(sx * W * 0.20, legH + torsoH * 0.66, -W * 0.30);
    rib.rotation.z = sx * 1.2;
    g.add(rib);
  }

  g.traverse((o) => { if (o.isMesh) o.castShadow = !o.name.startsWith('halo'); });
  return g;
}
