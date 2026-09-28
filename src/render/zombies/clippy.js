// CLIPPY -- milestone-wave mini-boss.
//
// The game can run with no downloaded art, so Clippy is a small procedural
// sculpture rather than a texture cutout. The wire is drawn as one continuous
// tube in the familiar doubled-back paperclip shape; the two stalk eyes sit in
// front of it and keep the silhouette readable from combat distance.
//
// Forward is +Z (enemy.yaw = atan2(dx, dz)).

import * as THREE from '../../../vendor/three.module.js';

const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

function tube(points, radius, material, segments = 48) {
  const path = new THREE.CatmullRomCurve3(
    points.map(([x, y, z = 0]) => new THREE.Vector3(x, y, z)),
    false,
    'centripetal',
  );
  return new THREE.Mesh(new THREE.TubeGeometry(path, segments, radius, 8, false), material);
}

export function buildClippyModel(type) {
  const H = type.height;
  const W = type.width;
  const g = new THREE.Group();
  const root = new THREE.Group();
  root.name = 'clippyRoot';
  g.add(root);

  const metal = new THREE.MeshStandardMaterial({
    color: srgb(type.bodyColor), roughness: 0.58, metalness: 0.48,
  });
  const metalDark = new THREE.MeshStandardMaterial({
    color: srgb(0x565a56), roughness: 0.62, metalness: 0.42,
  });
  const white = new THREE.MeshStandardMaterial({
    color: srgb(type.headColor), roughness: 0.5,
  });
  const black = new THREE.MeshStandardMaterial({
    color: srgb(type.accentColor), roughness: 0.58,
  });

  // Read front-to-back, this follows the classic Clippy silhouette: the loose
  // tip on the right drops around the large outer U, climbs the left side into
  // the hooked crown, then doubles back through the smaller inner U. The eyes
  // hide the two tight overlaps, just as they do in the original low-res art.
  const wire = tube([
    [W * 0.37, H * 0.48, -W * 0.035],
    [W * 0.34, H * 0.29, -W * 0.025],
    [W * 0.28, H * 0.13, -W * 0.015],
    [W * 0.14, H * 0.045, 0],
    [-W * 0.03, H * 0.025, 0],
    [-W * 0.20, H * 0.075, 0],
    [-W * 0.34, H * 0.20, 0],
    [-W * 0.41, H * 0.39, 0],
    [-W * 0.40, H * 0.62, 0],
    [-W * 0.34, H * 0.78, -W * 0.01],
    [-W * 0.23, H * 0.875, -W * 0.025],
    [-W * 0.09, H * 0.905, -W * 0.035],
    [W * 0.035, H * 0.855, -W * 0.045],
    [W * 0.105, H * 0.745, -W * 0.04],
    [W * 0.095, H * 0.61, -W * 0.025],
    [W * 0.105, H * 0.29, W * 0.005],
    [W * 0.055, H * 0.20, W * 0.015],
    [-W * 0.045, H * 0.165, W * 0.02],
    [-W * 0.145, H * 0.20, W * 0.025],
    [-W * 0.195, H * 0.30, W * 0.03],
    [-W * 0.205, H * 0.61, W * 0.04],
  ], W * 0.042, metal, 84);
  wire.name = 'paperclip';
  root.add(wire);

  // Rounded wire ends are conspicuous on a character made almost entirely of
  // wire. TubeGeometry leaves them sliced flat, which looks machined rather
  // than like the friendly bent rod in the reference.
  const tipGeo = new THREE.SphereGeometry(W * 0.043, 10, 8);
  for (const [name, x, y, z] of [
    ['wireTipOuter', W * 0.37, H * 0.48, -W * 0.035],
    ['wireTipInner', -W * 0.205, H * 0.61, W * 0.04],
  ]) {
    const tip = new THREE.Mesh(tipGeo, metal);
    tip.name = name;
    tip.position.set(x, y, z);
    root.add(tip);
  }

  // Eye stems are slightly darker so the white eyes do not dissolve into the
  // silver body. They lean apart just like the reference's uneven gaze.
  const stemL = tube([
    [-W * 0.205, H * 0.38, W * 0.055],
    [-W * 0.215, H * 0.53, W * 0.075],
    [-W * 0.235, H * 0.665, W * 0.10],
  ], W * 0.031, metalDark, 26);
  stemL.name = 'eyeStemL';
  root.add(stemL);

  const stemR = tube([
    [W * 0.105, H * 0.31, W * 0.06],
    [W * 0.135, H * 0.46, W * 0.085],
    [W * 0.205, H * 0.585, W * 0.11],
  ], W * 0.031, metalDark, 26);
  stemR.name = 'eyeStemR';
  root.add(stemR);

  const eyeGeo = new THREE.SphereGeometry(W * 0.18, 18, 14);
  const pupilGeo = new THREE.SphereGeometry(W * 0.092, 14, 10);
  for (const [name, x, y, z, pupilX, eyeScale] of [
    ['L', -W * 0.235, H * 0.68, W * 0.105, W * 0.018, 0.94],
    ['R', W * 0.205, H * 0.60, W * 0.115, -W * 0.018, 1.04],
  ]) {
    const eye = new THREE.Mesh(eyeGeo, white);
    eye.name = `eye${name}`;
    eye.scale.set(eyeScale * 1.05, eyeScale * 0.92, eyeScale * 0.60);
    eye.position.set(x, y, z);
    root.add(eye);

    const pupil = new THREE.Mesh(pupilGeo, black);
    pupil.name = `pupil${name}`;
    pupil.scale.set(0.88, 1.04, 0.42);
    pupil.position.set(x + pupilX, y - H * 0.012, z + W * 0.126);
    root.add(pupil);
  }

  // Heavy brows sell the mildly judgmental expression from the old assistant
  // and make its facing direction obvious even when the pupils are tiny.
  const browL = tube([
    [-W * 0.39, H * 0.765, W * 0.19],
    [-W * 0.27, H * 0.795, W * 0.205],
    [-W * 0.14, H * 0.775, W * 0.195],
  ], W * 0.027, black, 14);
  browL.name = 'browL';
  root.add(browL);

  const browR = tube([
    [W * 0.075, H * 0.685, W * 0.20],
    [W * 0.19, H * 0.72, W * 0.215],
    [W * 0.33, H * 0.685, W * 0.20],
  ], W * 0.027, black, 14);
  browR.name = 'browR';
  root.add(browR);

  // Invisible anchors keep mesh inspection consistent with the other models;
  // Clippy's renderer takes its dedicated animation branch before posing them.
  for (const name of ['legL', 'legR', 'armL', 'armR', 'torso', 'head']) {
    const anchor = new THREE.Object3D();
    anchor.name = name;
    root.add(anchor);
  }

  return g;
}
