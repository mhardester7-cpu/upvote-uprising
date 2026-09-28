// GUNNER: the risen remains of a police marksman -- the one zombie that shoots
// back, so its silhouette has to say so from across the arena.
//
// Three read-at-a-glance cues carry that job, in order of how far away they
// survive: the tall peaked cap, the radio whip antenna arcing off the shoulder,
// and the pistol itself. Everything else (plate carrier, webbing, torn coat
// skirt, jackboots) is there to break up the human outline so a gunner never
// gets mistaken for a grunt in a crowd.
//
// Construction rules this file follows, because the animation code depends on
// them:
//   * origin at the FEET, centred in X/Z, model occupies y = 0 .. type.height
//   * `legL`, `legR`, `armL`, `armR`, `torso`, `head` exist by `.name`
//   * every limb's geometry is shifted so the MESH ORIGIN SITS AT THE JOINT --
//     the walk cycle only ever writes `.rotation.x`, so a limb pivoting about
//     its middle is the classic way this goes wrong
//   * nothing is stashed in `userData`: the prototype is cloned per spawn and
//     `Object3D.clone()` round-trips userData through JSON, which would turn any
//     mesh reference into garbage. The caller re-resolves limbs by name.
//
// Facing: +Z is FORWARD (the face, the cap peak and the chest rig all point that
// way), matching `syncEnemyMesh`, which sets `rotation.y = atan2(dx, dz)` -- so
// local +Z ends up aimed at the player.

// One directory deeper than the rest of src/render, hence the third '..'.
import * as THREE from '../../../vendor/three.module.js';

// ----------------------------------------------------------------- helpers

/**
 * The renderer works in linear space with ACES tone mapping, so a raw hex is
 * always too bright and too washed out. Every colour in this file goes through
 * here.
 */
function col(hex) {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

/** Scale a hex colour's channels, so shades derive from the type palette. */
function tint(hex, k) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

function mat(hex, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: col(hex), roughness: 0.9, metalness: 0, ...opts,
  });
}

function mesh(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** 32-bit integer hash -> [0,1). Deterministic, so every gunner is identical. */
function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1)
    ^ Math.imul(iz, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Push vertices along their normals by a hashed amount, which is what stops the
 * capsules and spheres reading as clean gym-fit mannequin parts.
 *
 * The hash keys off the QUANTISED POSITION rather than the vertex index on
 * purpose: three's primitives duplicate vertices along UV seams and at poles,
 * and index-keyed noise would pull those copies apart and tear a visible slit
 * down the model.
 */
function perturb(geo, amount, seed = 1) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = hash3(
      Math.round(x * 2048), Math.round(y * 2048), Math.round(z * 2048), seed,
    ) - 0.5;
    const d = r * 2 * amount;
    p.setXYZ(i, x + n.getX(i) * d, y + n.getY(i) * d, z + n.getZ(i) * d);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/**
 * Tear the bottom ring off an open cylinder: the cheapest convincing rag hem
 * there is, at zero extra triangles. Used for the coat skirt and the sleeves.
 */
function tearHem(geo, drop, seed = 7) {
  const p = geo.attributes.position;
  let minY = Infinity;
  for (let i = 0; i < p.count; i++) minY = Math.min(minY, p.getY(i));
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > minY + 1e-4) continue;
    const x = p.getX(i), z = p.getZ(i);
    const r = hash3(Math.round(x * 2048), 0, Math.round(z * 2048), seed);
    p.setXYZ(i, x * (1 + r * 0.12), y + (r - 0.75) * drop, z * (1 + r * 0.12));
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** An n-sided prism along Y. Rounder than a box for the same triangle budget. */
function prism(rx, rz, len, seg) {
  const g = new THREE.CylinderGeometry(1, 1, 1, seg);
  g.rotateY(Math.PI / seg);   // land a flat face on top instead of an edge
  g.scale(rx, len, rz);
  return g;
}

// ------------------------------------------------------------------ pistol

/**
 * Service pistol, built in its own frame: BARREL DOWN +Z, sights UP +Y, origin
 * at the web of the shooting hand.
 *
 * The mount below rotates that frame by +90 degrees about X, which maps the
 * barrel onto the arm's local -Y -- the direction the arm hangs. So:
 *   * arm at rest  -> muzzle points at the ground, sights facing forward,
 *                     exactly how a hand hanging at the hip carries a pistol
 *   * arm at -90 X -> arm swings out along the model's forward axis and the
 *                     barrel comes level, pointing +Z at the player with the
 *                     sights on top. This is the pose the player must read.
 */
function buildPistol(M, u) {
  const g = new THREE.Group();
  g.name = 'gun';

  // Slide: an octagonal prism, so the highlight rolls along a chamfer instead
  // of snapping across a hard box edge.
  const slide = prism(0.023 * u, 0.026 * u, 0.185 * u, 8);
  slide.rotateX(Math.PI / 2);
  g.add(mesh(slide, M.steel, 0, 0.062 * u, 0.030 * u));

  // Dust cover / frame under the slide.
  g.add(mesh(
    new THREE.BoxGeometry(0.038 * u, 0.038 * u, 0.112 * u),
    M.gunmetal, 0, 0.028 * u, 0.020 * u,
  ));

  // Raked grip -- six sided, filling the fist.
  const grip = prism(0.021 * u, 0.026 * u, 0.105 * u, 6);
  const gripMesh = mesh(grip, M.gunmetal, 0, -0.038 * u, -0.050 * u);
  gripMesh.rotation.x = 0.26;
  g.add(gripMesh);

  // Magazine floorplate: the one warm colour on the gun, which is what makes
  // the pistol legible against a near-black uniform.
  const magPlate = mesh(
    new THREE.BoxGeometry(0.046 * u, 0.012 * u, 0.058 * u),
    M.brass, 0, -0.092 * u, -0.070 * u,
  );
  magPlate.rotation.x = 0.26;
  g.add(magPlate);

  // Trigger guard: a half torus swung down and forward of the grip.
  const guard = new THREE.TorusGeometry(0.028 * u, 0.006 * u, 4, 8, Math.PI);
  guard.rotateY(Math.PI / 2);
  guard.rotateZ(Math.PI);       // flip the arc into the lower half
  g.add(mesh(guard, M.gunmetal, 0, 0.006 * u, -0.008 * u));

  // Muzzle, standing proud of the slide so the barrel reads end-on.
  const barrel = new THREE.CylinderGeometry(0.011 * u, 0.011 * u, 0.030 * u, 8);
  barrel.rotateX(Math.PI / 2);
  g.add(mesh(barrel, M.steel, 0, 0.060 * u, 0.132 * u));

  // Irons and hammer. Tiny, but they are what sell "levelled weapon" in
  // profile once the arm comes up.
  g.add(mesh(new THREE.BoxGeometry(0.042 * u, 0.011 * u, 0.013 * u),
    M.gunmetal, 0, 0.085 * u, -0.046 * u));                    // rear sight
  g.add(mesh(new THREE.BoxGeometry(0.010 * u, 0.014 * u, 0.010 * u),
    M.gunmetal, 0, 0.086 * u, 0.108 * u));                     // front post
  const hammer = mesh(new THREE.BoxGeometry(0.012 * u, 0.026 * u, 0.011 * u),
    M.steel, 0, 0.084 * u, -0.062 * u);
  hammer.rotation.x = -0.35;
  g.add(hammer);

  return g;
}

// ------------------------------------------------------------------- model

/**
 * Build the gunner prototype.
 *
 * @param {object} type ENEMY_TYPES.gunner
 * @returns {THREE.Group} origin at the feet, occupying y = 0 .. type.height
 */
export function buildGunnerModel(type) {
  const H = type?.height ?? 1.8;
  const W = type?.width ?? 0.62;
  // Authored against the nominal 1.8 x 0.62 gunner. `u` scales every length,
  // `wu` only the lateral placement, so the model still reads correctly if the
  // type is ever retuned.
  const u = H / 1.8;
  const wu = W / 0.62;

  const BODY = type?.bodyColor ?? 0x4a6f8a;
  const HEAD = type?.headColor ?? 0x3c5c74;
  const ACC = type?.accentColor ?? 0x17242e;

  const M = {
    tunic: mat(BODY, { roughness: 0.95 }),
    tunicDark: mat(tint(BODY, 0.72), { roughness: 0.95 }),
    rag: mat(tint(BODY, 0.6), { roughness: 1.0, side: THREE.DoubleSide }),
    flesh: mat(HEAD, { roughness: 0.82, flatShading: true }),
    fleshSmooth: mat(HEAD, { roughness: 0.82 }),
    gear: mat(ACC, { roughness: 0.72, metalness: 0.12 }),
    gearFlat: mat(ACC, { roughness: 0.7, metalness: 0.12, flatShading: true }),
    strap: mat(tint(ACC, 1.9), { roughness: 0.85 }),
    steel: mat(0x9aa2ac, { roughness: 0.24, metalness: 0.95, flatShading: true }),
    gunmetal: mat(0x2c333b, { roughness: 0.36, metalness: 0.85 }),
    brass: mat(0xb8913f, { roughness: 0.34, metalness: 0.8 }),
    eye: mat(0xf2e7a6, { roughness: 0.45 }),
  };

  const g = new THREE.Group();

  // Vertical anchors. Kept a touch short-legged and heavy-chested: the model
  // has to sit inside the game's hitboxes, where the head box owns the top 28%.
  const yHip = 0.62 * u;
  const yWaist = 0.72 * u;
  const yShoulder = 1.25 * u;
  const yHeadC = 1.55 * u;

  const xLeg = 0.145 * wu;
  const xArm = 0.205 * wu;

  // ------------------------------------------------------------- torso ----
  // Pivot at the waist rather than the chest centre, so anything that later
  // wants to hunch this thing over gets a bend instead of a shear.
  const torsoGeo = new THREE.CapsuleGeometry(0.155 * u, 0.30 * u, 4, 10);
  torsoGeo.scale(1.30, 1, 0.86);
  perturb(torsoGeo, 0.008 * u, 11);
  torsoGeo.translate(0, 0.30 * u, 0);
  const torso = mesh(torsoGeo, M.tunic, 0, yWaist, 0);
  torso.name = 'torso';
  g.add(torso);

  // Plate carrier. Sits a few millimetres proud of the tunic so it catches its
  // own rim light and doesn't z-fight.
  const vestGeo = new THREE.SphereGeometry(0.155 * u, 8, 6);
  vestGeo.scale(1.34, 1.45, 0.80);
  perturb(vestGeo, 0.006 * u, 12);
  torso.add(mesh(vestGeo, M.gear, 0, 0.33 * u, 0.012 * u));

  // Bandolier across the chest and a duty belt at the waist: two hard
  // horizontals that stop the torso reading as one smooth blob.
  const bandGeo = new THREE.TorusGeometry(0.185 * u, 0.022 * u, 4, 8);
  bandGeo.rotateX(Math.PI / 2);
  bandGeo.scale(1.16, 1, 0.82);
  const band = mesh(bandGeo, M.strap, 0, 0.34 * u, 0);
  band.rotation.z = 0.38;
  torso.add(band);

  const beltGeo = new THREE.TorusGeometry(0.17 * u, 0.026 * u, 4, 10);
  beltGeo.rotateX(Math.PI / 2);
  beltGeo.scale(1.2, 1, 0.86);
  torso.add(mesh(beltGeo, M.gear, 0, 0.02 * u, 0));

  // Belt kit: two pouches and a spare magazine, all off-centre so the rig
  // looks worn rather than issued.
  const pouchGeo = new THREE.IcosahedronGeometry(0.052 * u, 0);
  pouchGeo.scale(1, 0.9, 0.6);
  const pouchA = mesh(pouchGeo, M.gearFlat, -0.10 * u, 0.03 * u, 0.125 * u);
  pouchA.rotation.y = 0.3;
  torso.add(pouchA);
  const pouchB = mesh(pouchGeo, M.gearFlat, 0.12 * u, 0.01 * u, 0.105 * u);
  pouchB.rotation.y = -0.5;
  torso.add(pouchB);
  const spareMag = new THREE.IcosahedronGeometry(0.032 * u, 0);
  spareMag.scale(0.8, 1.1, 0.6);
  torso.add(mesh(spareMag, M.brass, 0.02 * u, 0.035 * u, 0.14 * u));

  // Shoulder pads, faceted so they read as armour and not as muscle.
  const padGeo = new THREE.IcosahedronGeometry(0.10 * u, 1);
  padGeo.scale(1, 0.62, 0.9);
  for (const sx of [-1, 1]) {
    const pad = mesh(padGeo, M.gearFlat, sx * 0.175 * wu, 0.52 * u, 0);
    pad.rotation.z = sx * 0.35;
    torso.add(pad);
  }

  // Radio on the back plate plus the whip antenna. At 30 metres the antenna is
  // often the only part of a gunner the player can see, and it is enough.
  torso.add(mesh(
    new THREE.BoxGeometry(0.09 * u, 0.13 * u, 0.05 * u),
    M.gearFlat, -0.09 * u, 0.40 * u, -0.135 * u,
  ));
  const antGeo = new THREE.CylinderGeometry(0.004 * u, 0.008 * u, 0.40 * u, 4, 1, true);
  antGeo.translate(0, 0.20 * u, 0);
  const antenna = mesh(antGeo, M.gearFlat, -0.09 * u, 0.46 * u, -0.15 * u);
  antenna.rotation.set(-0.30, 0, -0.12);
  torso.add(antenna);

  // Collar of the tunic, torn open at the throat.
  const collarGeo = new THREE.CylinderGeometry(0.085 * u, 0.115 * u, 0.09 * u, 10, 1, true);
  tearHem(collarGeo, 0.03 * u, 21);
  torso.add(mesh(collarGeo, M.tunicDark, 0, 0.60 * u, 0));

  // -------------------------------------------------------------- hips ----
  const hipGeo = new THREE.SphereGeometry(0.16 * u, 8, 6);
  hipGeo.scale(1.18, 0.72, 0.92);
  perturb(hipGeo, 0.007 * u, 13);
  g.add(mesh(hipGeo, M.gear, 0, 0.68 * u, 0));

  // Skirt of the greatcoat, hem shredded. Hangs over the thighs and gives the
  // gunner a wider, heavier lower silhouette than the grunt.
  const skirtGeo = new THREE.CylinderGeometry(0.185 * u, 0.235 * u, 0.26 * u, 10, 1, true);
  tearHem(skirtGeo, 0.10 * u, 5);
  g.add(mesh(skirtGeo, M.rag, 0, 0.665 * u, 0));

  // -------------------------------------------------------------- legs ----
  // Origin at the HIP: geometry pushed down by half the cylinder plus one cap
  // radius, so the capsule's top pole lands exactly on the pivot.
  const legR0 = 0.085 * u;
  const legLen = 0.35 * u;                       // cylinder section
  const legGeo = new THREE.CapsuleGeometry(legR0, legLen, 3, 8);
  legGeo.scale(1, 1, 0.95);
  perturb(legGeo, 0.006 * u, 17);
  legGeo.translate(0, -(legLen / 2 + legR0), 0);   // total drop: 0.52u

  const legL = mesh(legGeo, M.gear, -xLeg, yHip, 0);
  legL.name = 'legL';
  legL.rotation.z = -0.05;                        // slack, splayed stance

  // Jackboot: a faceted ellipsoid toe-cap over a flat sole, ending at y = 0.
  const bootGeo = new THREE.IcosahedronGeometry(0.085 * u, 1);
  bootGeo.scale(0.95, 0.85, 1.5);
  perturb(bootGeo, 0.006 * u, 19);
  const boot = mesh(bootGeo, M.gearFlat, 0, -0.545 * u, 0.03 * u);
  legL.add(boot);
  const soleGeo = new THREE.CylinderGeometry(0.085 * u, 0.078 * u, 0.03 * u, 6);
  soleGeo.scale(1, 1, 1.5);
  const sole = mesh(soleGeo, M.gearFlat, 0, -0.600 * u, 0.03 * u);
  legL.add(sole);

  g.add(legL);

  const legR = legL.clone();
  legR.name = 'legR';
  legR.position.x = xLeg;
  legR.rotation.z = 0.05;
  g.add(legR);

  // -------------------------------------------------------------- arms ----
  // Same joint-origin trick at the shoulder. Bare forearms, torn sleeve over
  // the top half -- the uniform is falling off this thing.
  const armR0 = 0.062 * u;
  const armLen = 0.43 * u;
  const armGeo = new THREE.CapsuleGeometry(armR0, armLen, 3, 8);
  perturb(armGeo, 0.005 * u, 23);
  armGeo.translate(0, -(armLen / 2 + armR0), 0);   // total drop: 0.554u

  const armL = mesh(armGeo, M.fleshSmooth, -xArm, yShoulder, 0);
  armL.name = 'armL';
  armL.rotation.z = -0.16;                         // hangs away from the body

  const sleeveGeo = new THREE.CylinderGeometry(0.078 * u, 0.070 * u, 0.24 * u, 6, 1, true);
  tearHem(sleeveGeo, 0.05 * u, 29);
  armL.add(mesh(sleeveGeo, M.tunic, 0, -0.12 * u, 0));

  const handGeo = new THREE.IcosahedronGeometry(0.055 * u, 0);
  handGeo.scale(0.85, 1, 0.9);
  armL.add(mesh(handGeo, M.flesh, 0, -0.575 * u, 0));

  g.add(armL);

  const armR = armL.clone();
  armR.name = 'armR';
  armR.position.x = xArm;
  // Kept near vertical: every degree of roll here is a degree the pistol is off
  // the model's forward axis once the aim pose swings the arm out.
  armR.rotation.z = 0.05;
  g.add(armR);

  // The pistol rides the right hand. +90 X maps the gun's +Z barrel onto the
  // arm's local -Y, which is the axis the aim pose points straight forward.
  //
  // Note this is forced, not a preference: `armR.rotation.x = -PI/2` swings the
  // arm's hanging axis onto +Z whichever way the model faces, so the gun has to
  // come level along +Z, and therefore the FACE has to be on +Z too. That
  // matches `syncEnemyMesh` (`rotation.y = atan2(dx, dz)`) and the old
  // prototype, whose eye strip also sat at +Z.
  const gun = buildPistol(M, u);
  gun.position.set(0, -0.572 * u, 0.012 * u);
  gun.rotation.x = Math.PI / 2;
  armR.add(gun);

  // -------------------------------------------------------------- head ----
  const neckGeo = new THREE.CylinderGeometry(0.055 * u, 0.07 * u, 0.13 * u, 8, 1, true);
  g.add(mesh(neckGeo, M.fleshSmooth, 0, 1.36 * u, 0));

  const headGeo = new THREE.IcosahedronGeometry(0.152 * u, 1);
  headGeo.scale(0.95, 1.08, 1.0);
  perturb(headGeo, 0.012 * u, 31);                 // gaunt, uneven skull
  const head = mesh(headGeo, M.flesh, 0, yHeadC, 0);
  head.name = 'head';
  head.rotation.set(0.06, 0, 0.07);                // cocked, broken-necked
  g.add(head);

  // Slack jaw, hanging open.
  const jawGeo = new THREE.SphereGeometry(0.085 * u, 6, 4);
  jawGeo.scale(0.92, 0.62, 1.05);
  perturb(jawGeo, 0.006 * u, 33);
  const jaw = mesh(jawGeo, M.flesh, 0, -0.10 * u, 0.055 * u);
  jaw.rotation.x = 0.22;
  head.add(jaw);

  // Eyes: pale and matte rather than emissive -- the hit flash writes every
  // material's emissive channel each frame, so anything glowing here would be
  // stamped back to black.
  const eyeGeo = new THREE.IcosahedronGeometry(0.024 * u, 0);
  for (const sx of [-1, 1]) {
    head.add(mesh(eyeGeo, M.eye, sx * 0.058 * u, 0.022 * u, 0.128 * u));
  }

  // Peaked cap: tall crown, hard peak, brass shield. Sits crooked. This is the
  // single strongest cue that the thing under it is holding a gun.
  const cap = new THREE.Group();
  cap.position.set(0, 1.602 * u, 0);
  cap.rotation.set(0.05, 0.08, 0.10);
  g.add(cap);

  const crownProfile = [
    new THREE.Vector2(0.175 * u, 0),
    new THREE.Vector2(0.182 * u, 0.035 * u),
    new THREE.Vector2(0.170 * u, 0.105 * u),
    new THREE.Vector2(0.140 * u, 0.155 * u),
    new THREE.Vector2(0.005 * u, 0.168 * u),
  ];
  const crownGeo = new THREE.LatheGeometry(crownProfile, 10);
  crownGeo.scale(1, 1, 0.94);
  perturb(crownGeo, 0.005 * u, 37);
  cap.add(mesh(crownGeo, M.gearFlat, 0, 0, 0));

  // Peak: an ellipse disc buried in the crown at the back so only the front
  // half projects.
  const peakGeo = new THREE.CylinderGeometry(0.155 * u, 0.155 * u, 0.016 * u, 10);
  peakGeo.scale(1.12, 1, 1.05);
  const peak = mesh(peakGeo, M.gearFlat, 0, 0.012 * u, 0.085 * u);
  peak.rotation.x = -0.20;
  cap.add(peak);

  const badgeGeo = new THREE.IcosahedronGeometry(0.034 * u, 0);
  badgeGeo.scale(0.9, 1.1, 0.35);
  cap.add(mesh(badgeGeo, M.brass, 0, 0.085 * u, 0.168 * u));

  return g;
}
