// The co-op partner: the character you see when someone else is in your game.
//
// It has to answer three questions instantly, at range, in a firefight:
// who is that, which way are they facing, and are they in trouble. So the
// model is built around those and nothing else.
//
//   WHO      One colour per player, derived from their id, carried on the
//            gear -- helmet, vest, shoulders, knees -- while the fatigues and
//            skin stay neutral. Tinting the whole body makes eight players
//            into eight jellybeans; tinting the kit keeps them soldiers who
//            happen to be on different squads.
//   FACING   A visor, a chest rig, and a rifle held in both hands across the
//            body. The gun is the single strongest facing cue at distance,
//            which is why it is modelled properly rather than suggested.
//   TROUBLE  Handled by the pose in syncSoldierMesh: a downed partner falls
//            face-down with their arms out, unmistakable from any angle.
//
// Same contract as the enemies: origin at the feet, forward is +Z, limbs named
// legL/legR/armL/armR with their origins at the joint.

import * as THREE from '../../vendor/three.module.js';
import { mat, bone, blob, lathe, plate, GUNMETAL } from './anatomy.js';

/**
 * Squad colours: distinct hues, spaced around the wheel and matched for
 * value so no player is harder to see than another.
 */
const SQUAD = [
  0x4db6ff,  // blue
  0xffb03d,  // amber
  0x6fe08a,  // green
  0xff6ba8,  // pink
  0xc08aff,  // violet
  0xff7a4d,  // orange
  0x54e0d0,  // teal
  0xe8e45c,  // yellow
];

export function playerColor(id) {
  return SQUAD[Math.abs(id | 0) % SQUAD.length];
}

// Neutral kit, shared by everyone. Only the accents take the squad colour.
const FATIGUE = 0x4a4f45;
const FATIGUE_DARK = 0x33372f;
const WEBBING = 0x2b2e28;
const SKIN = 0xc98f63;
const BOOT = 0x1e1f1c;

// A soldier's torso: broad chest, tucked waist.
const TRUNK = [
  [0.00, 0.05], [0.04, 0.68], [0.18, 0.80], [0.40, 0.88],
  [0.62, 0.98], [0.80, 1.00], [0.92, 0.88], [0.99, 0.56],
  [1.00, 0.30], [1.02, 0.02],
];

/**
 * The rifle. Modelled rather than suggested, because at twenty metres the gun
 * is what tells you which way a partner is pointing.
 */
export function buildRifle(scale, accentMat) {
  const g = new THREE.Group();
  g.name = 'gun';

  const metal = mat(GUNMETAL, 0.42, 0.7);
  const polymer = mat(0x24282c, 0.75, 0.1);

  // Receiver.
  const receiver = new THREE.Mesh(
    new THREE.BoxGeometry(0.062, 0.085, 0.30).toNonIndexed(), metal);
  receiver.position.z = -0.02;
  g.add(receiver);

  // Barrel and handguard.
  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.014, 0.30, 7), metal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = -0.30;
  g.add(barrel);

  const guard = new THREE.Mesh(
    new THREE.CylinderGeometry(0.030, 0.026, 0.22, 8), polymer);
  guard.rotation.x = Math.PI / 2;
  guard.position.z = -0.24;
  g.add(guard);

  // Muzzle device, so the end of the barrel is not just a flat disc.
  const muzzle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.020, 0.018, 0.05, 7), metal);
  muzzle.rotation.x = Math.PI / 2;
  muzzle.position.z = -0.45;
  g.add(muzzle);

  // Magazine, curved forward.
  const magazine = new THREE.Mesh(
    new THREE.BoxGeometry(0.036, 0.16, 0.062).toNonIndexed(), polymer);
  magazine.position.set(0, -0.10, 0.02);
  magazine.rotation.x = 0.22;
  g.add(magazine);

  // Pistol grip.
  const grip = new THREE.Mesh(
    new THREE.BoxGeometry(0.038, 0.11, 0.05).toNonIndexed(), polymer);
  grip.position.set(0, -0.085, 0.13);
  grip.rotation.x = -0.30;
  g.add(grip);

  // Stock.
  const stock = new THREE.Mesh(
    new THREE.BoxGeometry(0.046, 0.070, 0.20).toNonIndexed(), polymer);
  stock.position.set(0, -0.008, 0.21);
  g.add(stock);

  // Optic on a low rail -- the accent colour appears here so a partner's
  // squad reads even when only the gun is visible around cover.
  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(0.030, 0.016, 0.20).toNonIndexed(), metal);
  rail.position.set(0, 0.052, -0.03);
  g.add(rail);

  const optic = new THREE.Mesh(
    new THREE.CylinderGeometry(0.020, 0.020, 0.085, 8), metal);
  optic.rotation.x = Math.PI / 2;
  optic.position.set(0, 0.078, -0.05);
  g.add(optic);

  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.017, 8), accentMat);
  lens.position.set(0, 0.078, -0.093);
  lens.rotation.y = Math.PI;
  g.add(lens);

  g.scale.setScalar(scale);
  return g;
}

/** Build the avatar for one remote player. */
export function buildSoldierMesh(remote) {
  const color = playerColor(remote.id);
  const g = new THREE.Group();

  const H = 1.8;
  const W = 0.42;

  const accent = mat(color, 0.55, 0.15);
  const accentGlow = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHex(color, THREE.SRGBColorSpace),
    roughness: 0.3, metalness: 0,
    emissive: new THREE.Color().setHex(color, THREE.SRGBColorSpace),
    emissiveIntensity: 0.9,
  });
  const cloth = mat(FATIGUE, 0.95);
  const clothDark = mat(FATIGUE_DARK, 0.95);
  const webbing = mat(WEBBING, 0.9);
  const skin = mat(SKIN, 0.8);
  const bootMat = mat(BOOT, 0.7);
  const glove = mat(0x1f2320, 0.85);

  const legH = H * 0.47;
  const torsoH = H * 0.34;
  const headR = W * 0.42;

  // ---------------------------------------------------------------- torso
  const torso = lathe(TRUNK, torsoH, W * 0.54, cloth, 12);
  torso.name = 'torso';
  torso.scale.set(1.1, 1, 0.78);      // chests are wider than they are deep
  torso.position.y = legH;
  g.add(torso);

  // Plate carrier over the chest, in the squad colour. This is the main
  // identity read: a big flat area of colour at chest height.
  const carrier = plate(W * 0.62, Math.PI * 0.78, Math.PI * 0.46, accent, 0.06);
  carrier.position.set(0, legH + torsoH * 0.58, W * 0.20);
  carrier.scale.set(1.05, 1, 1);
  g.add(carrier);

  // Pouches across the front of the carrier.
  for (let i = 0; i < 3; i++) {
    const pouch = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.20, W * 0.17, W * 0.10).toNonIndexed(), webbing);
    pouch.position.set((i - 1) * W * 0.24, legH + torsoH * 0.36, W * 0.30);
    g.add(pouch);
  }

  // Shoulder straps joining the carrier front to back.
  for (const sx of [-1, 1]) {
    const strap = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.13, W * 0.06, W * 0.62).toNonIndexed(), webbing);
    strap.position.set(sx * W * 0.28, legH + torsoH * 0.92, 0);
    g.add(strap);
  }

  // A small pack on the back, so the silhouette is not symmetrical front/back.
  const pack = blob(W * 0.34, 1.0, 1.15, 0.55, clothDark, 8, 6);
  pack.position.set(0, legH + torsoH * 0.58, -W * 0.34);
  g.add(pack);

  // ---------------------------------------------------------------- head
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(W * 0.15, W * 0.17, W * 0.16, 7), skin);
  neck.position.y = legH + torsoH * 0.98;
  g.add(neck);

  const head = blob(headR, 0.92, 1.02, 1.0, skin, 10, 7);
  head.name = 'head';
  head.position.y = legH + torsoH + headR * 0.72;
  g.add(head);

  // Collar, so the neck rises out of clothing instead of out of a tube of skin.
  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(W * 0.24, W * 0.28, W * 0.14, 9), clothDark);
  collar.position.y = legH + torsoH * 0.99;
  g.add(collar);

  // Helmet: a proper combat-helmet dome, lathed so it has the real profile --
  // near-vertical sides dropping past the temples, a slight flare at the rim,
  // and a shallow crown. A scaled sphere reads as a bathing cap; the flare and
  // the deep sides are what read as ballistic shell.
  const HELMET_PROFILE = [
    [0.00, 1.06], [0.08, 1.10], [0.20, 1.08], [0.45, 1.00],
    [0.70, 0.82], [0.88, 0.55], [0.98, 0.28], [1.00, 0.02],
  ];
  const helmet = lathe(HELMET_PROFILE, headR * 1.05, headR * 1.02, accent, 14);
  helmet.name = 'helmet';
  helmet.scale.z = 1.12;    // longer front-to-back, like the real shell
  helmet.position.set(0, head.position.y - headR * 0.10, -headR * 0.05);
  g.add(helmet);

  // Rim trim in dark webbing, following the shell's lower edge.
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(headR * 1.06, headR * 0.055, 5, 14), webbing);
  rim.rotation.x = Math.PI / 2;
  rim.scale.set(1, 1.12, 1);
  rim.position.set(0, head.position.y - headR * 0.06, -headR * 0.05);
  g.add(rim);

  // Chinstrap: two thin bands meeting under the jaw. Small, but it is the
  // detail that says the helmet is worn rather than balanced.
  const strapArc = new THREE.Mesh(
    new THREE.TorusGeometry(headR * 0.92, headR * 0.045, 4, 10, Math.PI), webbing);
  strapArc.rotation.z = Math.PI;
  strapArc.position.set(0, head.position.y + headR * 0.05, headR * 0.05);
  g.add(strapArc);

  // Visor: dark, glossy, wrapping the eye line. The strongest facing cue on
  // the head at any distance where the face itself is a few pixels.
  const visor = plate(headR * 1.02, Math.PI * 1.05, Math.PI * 0.26,
    mat(0x0e1418, 0.18, 0.75), 0.04);
  visor.name = 'visor';
  visor.position.set(0, head.position.y + headR * 0.04, 0);
  g.add(visor);

  // A thin lit strip along the visor, in squad colour: reads at night, at
  // distance, and through the bloom pass.
  const strip = plate(headR * 1.05, Math.PI * 0.8, Math.PI * 0.045, accentGlow, 0.03);
  strip.position.set(0, head.position.y + headR * 0.10, 0);
  g.add(strip);

  // ---------------------------------------------------------------- arms
  const armLen = torsoH * 0.98;
  const shoulderY = legH + torsoH * 0.90;

  // The upper arm stops at the elbow, which is the whole length it should ever
  // have been: bone() hangs from its origin, the forearm mounts at 0.48 and is
  // 0.52 long, and 0.48 + 0.52 is the armLen this is all scaled from. Built at
  // the full armLen instead, the shaft ran straight past the elbow to the wrist
  // and stayed there when the forearm rotated up to the rifle -- a bare stub
  // jutting out of each elbow, which is what read as a second pair of arms.
  const upperLen = armLen * 0.48;
  for (const [name, sx] of [['armL', -1], ['armR', 1]]) {
    const arm = bone(upperLen, W * 0.15, cloth, 1, 7);
    arm.name = name;
    arm.position.set(sx * (W * 0.56), shoulderY, 0);
    g.add(arm);

    // Shoulder pad in squad colour, so identity survives being seen from behind.
    const pad = plate(W * 0.21, Math.PI * 1.5, Math.PI * 0.6, accent, 0.05);
    pad.position.set(0, W * 0.02, 0);
    pad.rotation.y = sx * Math.PI * 0.5;
    arm.add(pad);

    // Elbow, forearm and a gloved hand -- three shapes is the minimum for an
    // arm to stop reading as a sausage.
    const elbow = blob(W * 0.13, 1, 1, 1, clothDark, 7, 5);
    elbow.position.y = -armLen * 0.46;
    arm.add(elbow);

    // The forearm is its own segment hanging off the elbow, so the arm can be
    // bent. A single straight bone held out at the gun reads as a zombie
    // reaching, which is the one pose these characters must not share.
    const forearm = bone(armLen * 0.52, W * 0.115, clothDark, 1, 7);
    forearm.name = name === 'armL' ? 'foreL' : 'foreR';
    forearm.position.y = -armLen * 0.48;
    arm.add(forearm);

    const hand = blob(W * 0.115, 1.0, 1.2, 0.9, glove, 7, 5);
    hand.position.y = -armLen * 0.50;
    forearm.add(hand);
  }

  // The rifle is mounted on the body, not on the arm.
  //
  // Parenting it to the hand seems natural and is a trap: the arm has to swing
  // ~76 degrees to reach a firing pose, and the weapon inherits every bit of
  // that, so it ends up aimed at the player's own boots. Mounting it on a body
  // mount that only pitches keeps the muzzle where the partner is actually
  // looking, and the arms are then posed to meet it.
  const gunMount = new THREE.Group();
  gunMount.name = 'gunMount';
  gunMount.position.set(W * 0.30, legH + torsoH * 0.74, W * 0.30);
  // The rifle is modelled pointing -Z; these characters face +Z.
  gunMount.rotation.y = Math.PI;
  const rifle = buildRifle(1, accentGlow);
  gunMount.add(rifle);
  g.add(gunMount);

  // ---------------------------------------------------------------- legs
  for (const [name, sx] of [['legL', -1], ['legR', 1]]) {
    const leg = bone(legH * 0.98, W * 0.165, cloth, 1, 7);
    leg.name = name;
    leg.position.set(sx * W * 0.26, legH, 0);
    g.add(leg);

    // Knee pad in squad colour.
    const knee = plate(W * 0.17, Math.PI * 1.0, Math.PI * 0.55, accent, 0.05);
    knee.position.set(0, -legH * 0.50, W * 0.02);
    leg.add(knee);

    const shin = bone(legH * 0.46, W * 0.13, clothDark, 1, 7);
    shin.position.y = -legH * 0.52;
    leg.add(shin);

    // Boot: a wedge, longer than it is wide, so the feet have direction.
    const boot = blob(W * 0.15, 1.0, 0.62, 1.7, bootMat, 7, 5);
    boot.position.set(0, -legH * 0.93, W * 0.10);
    leg.add(boot);

    const sole = new THREE.Mesh(
      new THREE.BoxGeometry(W * 0.26, W * 0.05, W * 0.50).toNonIndexed(), mat(0x121312, 0.95));
    sole.position.set(0, -legH * 0.99, W * 0.10);
    leg.add(sole);
  }

  // Belt, tying the two halves together.
  const belt = new THREE.Mesh(
    new THREE.CylinderGeometry(W * 0.46, W * 0.46, W * 0.12, 12), webbing);
  belt.scale.set(1.1, 1, 0.8);
  belt.position.y = legH + torsoH * 0.06;
  g.add(belt);

  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  g.userData.limbs = {
    legL: g.getObjectByName('legL'), legR: g.getObjectByName('legR'),
    armL: g.getObjectByName('armL'), armR: g.getObjectByName('armR'),
    torso, head, helmet, visor,
    gunMount: g.getObjectByName('gunMount'),
    foreL: g.getObjectByName('foreL'), foreR: g.getObjectByName('foreR'),
  };
  g.userData.color = color;
  g.userData.materials = [
    accent, accentGlow, cloth, clothDark, webbing, skin, bootMat, glove,
  ];
  return g;
}
