// Baby zombie -- the "runner": small, fast, and never alone.
//
// Silhouette brief: an oversized skull carried on a spindly, forward-pitched
// body, with arms far too long for it and hips slung low. At thirty metres the
// player should read "that's the fast one" from the head-to-body ratio alone,
// long before a single detail resolves. Everything here serves that read --
// the head is deliberately larger than its hitbox, the legs are stubby, and
// the arms hang past the knees so the thing looks permanently mid-lunge.
//
// Contract with entities/enemy.js (do not break these):
//   * The group's origin is at the FEET, centred in X/Z, spanning y = 0 .. H.
//   * FORWARD IS +Z. yaw = atan2(dx, dz) is applied straight to rotation.y, so
//     an unrotated model faces a player standing along +Z: face, jaw, claws,
//     the whole forward pitch and the toes all point that way.
//   * Meshes named legL / legR / armL / armR / torso / head must exist. The
//     walk cycle owns `.rotation.x` on the four limbs, so each limb's geometry
//     hangs from its own origin (the joint) and every baked-in pose angle
//     lives on `.rotation.y/.z` or on a child segment instead -- anything put
//     on a limb's rotation.x would be overwritten on the first frame.
//   * The prototype is cloned per spawn, and clone() round-trips userData
//     through JSON, so nothing here stores mesh references on userData.
//
// Budget: ~1250 triangles, 20 meshes. This one spawns in the largest numbers,
// so rigid sub-parts (skull + jaw + fangs, forearm + palm, shin + foot) are
// merged into their parent's geometry rather than added as extra meshes.

// One level deeper than the rest of src/, so the vendor hop is ../../../.
import * as THREE from '../../../vendor/three.module.js';

// The renderer works in linear space with ACES tone mapping, so every authored
// colour has to be declared as sRGB or it comes out washed out and chalky.
function color(hex) {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

function material(hex, roughness = 0.92, metalness = 0.0, extra = null) {
  const m = new THREE.MeshStandardMaterial({ color: color(hex), roughness, metalness });
  if (extra) Object.assign(m, extra);
  return m;
}

// Bone and eye tints are derived rather than taken from the type palette: the
// three type colours are all mid-value browns, and a corpse needs at least one
// value that pops for the face to read at distance.
const BONE = 0xd9c8a2;
const EYE = 0xfff3c0;

// --------------------------------------------------------------- geometry kit

/** Deterministic 0..1 hash of a point. Same input, same lump, every reload. */
function hash01(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

const q = (v) => Math.round(v * 10000) / 10000;

/**
 * Push vertices along their normals by a hash of their POSITION -- never their
 * index. Icosahedra come out of three.js non-indexed, so every corner appears
 * in several triangles; hashing the index would tear the surface into
 * confetti, while hashing the position moves all the copies together.
 */
function perturb(geo, amp, freq = 7) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = hash01(q(x) * freq, q(y) * freq, q(z) * freq) - 0.5;
    const d = h * amp * 2;
    p.setXYZ(i, x + n.getX(i) * d, y + n.getY(i) * d, z + n.getZ(i) * d);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Scale / rotate / translate a geometry in place, in that order. */
function place(geo, { s, rx, ry, rz, x = 0, y = 0, z = 0 } = {}) {
  if (s) geo.scale(s[0], s[1], s[2]);
  if (rx) geo.rotateX(rx);
  if (ry) geo.rotateY(ry);
  if (rz) geo.rotateZ(rz);
  geo.translate(x, y, z);
  return geo;
}

/**
 * Weld several geometries into one so a rigid cluster (skull + jaw + fangs)
 * costs one draw call instead of five. Only position and normal survive --
 * nothing here is textured, and dropping uv/tangent keeps the buffers small.
 */
function merge(parts) {
  let count = 0;
  const flat = parts.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const g of flat) count += g.attributes.position.count;

  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  let o = 0;
  for (const g of flat) {
    pos.set(g.attributes.position.array, o);
    nrm.set(g.attributes.normal.array, o);
    o += g.attributes.position.count * 3;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.computeBoundingSphere();

  // The sources were scratch: nothing outside this file ever sees them.
  for (const g of new Set([...parts, ...flat])) g.dispose();
  return out;
}

/** A blob: cheap, faceted, and never reads as a box. */
function blob(r, opts) {
  return place(new THREE.IcosahedronGeometry(r, 0), opts);
}

/**
 * A limb segment whose geometry hangs from y=0 down to y=-length, so the mesh
 * origin sits at the joint and rotation.x swings it instead of spinning it.
 */
function bone(length, radius, radial = 6) {
  const g = new THREE.CapsuleGeometry(radius, Math.max(0.001, length - radius * 2), 1, radial);
  g.translate(0, -length / 2, 0);
  return g;
}

/** A talon: thin open cone, root at the origin, tip hanging at y = -len. */
function claw(len, r, opts) {
  const g = new THREE.ConeGeometry(r, len, 3, 1, true);
  g.rotateX(Math.PI);            // apex points down instead of up
  g.translate(0, -len / 2, 0);
  return place(g, opts);
}

// ------------------------------------------------------------------- the mob

/**
 * Build the baby zombie prototype.
 * @param {object} type ENEMY_TYPES.runner
 * @returns {THREE.Group} origin at the feet, spanning y = 0 .. type.height
 */
export function buildRunnerModel(type) {
  const H = type.height;   // 1.5
  const W = type.width;    // 0.5

  const g = new THREE.Group();
  g.name = 'runner';

  const skinMat = material(type.bodyColor, 0.95);
  const headMat = material(type.headColor, 0.9);
  const darkMat = material(type.accentColor, 0.98);
  const boneMat = material(BONE, 0.62);
  const eyeMat = material(EYE, 0.25, 0.0);
  const ragMat = material(type.accentColor, 1.0, 0.0, { side: THREE.DoubleSide });

  // Proportions. Hips sit low and the head eats the top quarter -- that ratio
  // is the whole silhouette, so it is driven off H rather than hand-tuned.
  const hipY = 0.345 * H;
  const pitch = 0.30;              // forward lean of the whole upper body
  const torsoR = 0.265 * W;
  const torsoL = 0.20 * H;         // capsule barrel, caps add torsoR either end
  const torsoLift = torsoL / 2 + torsoR * 0.62;          // barrel centre, hip-relative
  const torsoTop = torsoLift + torsoL / 2 + torsoR;      // shoulder line, hip-relative

  // ------------------------------------------------------------------ pelvis
  const pelvis = new THREE.Mesh(
    perturb(blob(0.20 * W, { s: [1.25, 0.82, 1.0], y: hipY - 0.012 * H }), 0.006 * H),
    skinMat,
  );
  pelvis.name = 'pelvis';
  g.add(pelvis);

  // ------------------------------------------------------------------- torso
  // Pivoted at the hips and pitched forward, so the chest leads and the arms
  // it carries are already thrown out ahead of the feet.
  const torsoParts = [];
  const barrel = new THREE.CapsuleGeometry(torsoR, torsoL, 2, 8);
  barrel.translate(0, torsoLift, 0);
  perturb(barrel, 0.012 * H, 5);
  torsoParts.push(barrel);
  // Hunched trapezius: fills the gap where a neck should be. There isn't one.
  torsoParts.push(blob(0.20 * W, { s: [1.35, 0.7, 1.0], y: torsoTop * 0.92, z: -0.02 * H }));
  // Shoulder knuckles, riding high and narrow.
  for (const sx of [-1, 1]) {
    torsoParts.push(blob(0.155 * W, {
      s: [1.0, 0.9, 0.9], x: sx * (torsoR + 0.03 * H), y: torsoTop * 0.80, z: 0.008 * H,
    }));
  }
  const torso = new THREE.Mesh(merge(torsoParts), skinMat);
  torso.name = 'torso';
  torso.position.set(0, hipY, -0.01 * H);
  torso.rotation.x = pitch;
  g.add(torso);

  // Vertebrae pushing through the skin of the hunched back.
  const spineParts = [];
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    spineParts.push(blob(0.055 * W * (1 - t * 0.35), {
      s: [0.8, 1.0, 0.8],
      y: torsoTop * (0.28 + t * 0.6),
      z: -(torsoR * (0.92 - t * 0.12)),
    }));
  }
  const spine = new THREE.Mesh(merge(spineParts), boneMat);
  spine.name = 'spine';
  torso.add(spine);

  // What is left of a shirt: a torn skirt of cloth with a chewed hem.
  const ragTop = torsoTop * 0.52;
  const ragBottom = -0.02 * H;
  const ragGeo = new THREE.LatheGeometry([
    new THREE.Vector2(torsoR * 1.02, ragTop),
    new THREE.Vector2(torsoR * 1.16, (ragTop + ragBottom) * 0.5),
    new THREE.Vector2(torsoR * 1.06, ragBottom),
  ], 8);
  {
    // Tear the bottom ring upward by a per-vertex hash so the hem is jagged
    // rather than a machine-cut circle.
    const p = ragGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y > ragBottom + 0.001) continue;
      const h = hash01(q(p.getX(i)) * 9, 0, q(p.getZ(i)) * 9);
      p.setY(i, y + h * 0.085 * H);
    }
    p.needsUpdate = true;
    ragGeo.computeVertexNormals();
  }
  const rag = new THREE.Mesh(ragGeo, ragMat);
  rag.name = 'rag';
  torso.add(rag);

  // -------------------------------------------------------------------- head
  // Oversized on purpose: a baby zombie is mostly skull. It deliberately
  // overhangs its hitbox -- shots at the visual centre still land in the box,
  // and the exaggeration is what makes the type readable at range.
  const hr = 0.145 * H;
  const headParts = [];
  headParts.push(perturb(place(new THREE.IcosahedronGeometry(hr, 1), {
    s: [1.0, 0.95, 1.06],
  }), hr * 0.12, 9));
  // Heavy brow, sunken cheeks, undershot jaw.
  headParts.push(blob(hr * 0.30, { s: [1.7, 0.55, 0.8], y: hr * 0.22, z: hr * 0.80 }));
  headParts.push(blob(hr * 0.42, { s: [0.98, 0.62, 1.05], y: -hr * 0.58, z: hr * 0.44 }));
  for (const sx of [-1, 1]) {
    headParts.push(blob(hr * 0.17, { s: [0.7, 1.3, 1.0], x: sx * hr * 0.92, y: hr * 0.05 }));
  }
  const head = new THREE.Mesh(merge(headParts), headMat);
  head.name = 'head';
  // Sat so the lumpiest point of the skull just grazes y = H.
  head.position.set(0, H - hr * 1.23, 0.075 * H);
  head.rotation.set(-0.28, 0.0, 0.09);   // chin up, cocked -- always looking at you
  g.add(head);

  // Open maw. A dark void plus a ring of fangs reads as "screaming" from far
  // further away than any amount of modelled tongue would.
  const maw = new THREE.Mesh(
    blob(hr * 0.34, { s: [1.0, 0.78, 0.7], y: -hr * 0.44, z: hr * 0.72 }),
    darkMat,
  );
  maw.name = 'maw';
  head.add(maw);

  const teethParts = [];
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * hr * 0.20;
    teethParts.push(claw(hr * 0.26, hr * 0.062, { x, y: -hr * 0.26, z: hr * 0.80, rx: -0.25 }));
    teethParts.push(claw(hr * 0.20, hr * 0.055, {
      rz: Math.PI, x: x + hr * 0.1, y: -hr * 0.66, z: hr * 0.76, rx: 0.2,
    }));
  }
  const teeth = new THREE.Mesh(merge(teethParts), boneMat);
  teeth.name = 'teeth';
  head.add(teeth);

  // Small, deep-set, and far too pale.
  const eyes = new THREE.Mesh(merge([
    blob(hr * 0.155, { s: [1.0, 0.85, 0.8], x: -hr * 0.40, y: hr * 0.06, z: hr * 0.80 }),
    blob(hr * 0.155, { s: [1.0, 0.85, 0.8], x: hr * 0.40, y: hr * 0.06, z: hr * 0.80 }),
  ]), eyeMat);
  eyes.name = 'eyes';
  head.add(eyes);

  // -------------------------------------------------------------------- arms
  // Long enough to hang past the knees. Parented to the torso so the forward
  // pitch carries them out in front, which is what sells the sprint.
  const upperLen = 0.20 * H;
  const foreLen = 0.19 * H;
  const upperR = 0.105 * W;
  const foreR = 0.085 * W;
  // Elbow cocked hard: the forward lean rotates a hanging arm backwards, so the
  // reach has to be bought back at the elbow or the hands trail behind the hips.
  const elbow = -1.20;
  let handAnchor = null;      // right hand, in armR's local space (for the pistol)

  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(merge([
      bone(upperLen, upperR),
      blob(upperR * 1.5, { s: [1.0, 0.85, 0.95] }),   // deltoid over the joint
    ]), skinMat);
    arm.name = side < 0 ? 'armL' : 'armR';
    arm.position.set(side * (torsoR + upperR * 0.75), torsoTop * 0.80, 0.01 * H);
    // Rest pose lives on z/y only: rotation.x belongs to the walk cycle.
    arm.rotation.z = side * 0.24;
    arm.rotation.y = side * -0.12;
    torso.add(arm);

    const fore = new THREE.Mesh(merge([
      bone(foreLen, foreR),
      blob(foreR * 1.35, { s: [1.15, 0.62, 1.25], y: -foreLen - foreR * 0.2, z: 0.012 * H }),
    ]), skinMat);
    fore.name = side < 0 ? 'foreL' : 'foreR';
    fore.position.set(0, -upperLen, 0);
    fore.rotation.x = elbow;
    fore.rotation.z = side * -0.30;
    arm.add(fore);

    if (side > 0) {
      handAnchor = new THREE.Vector3(0, -foreLen, 0)
        .applyEuler(fore.rotation).add(fore.position);
    }

    // Splayed talons -- three fingers, fanned and curling forward.
    const clawParts = [];
    for (let i = 0; i < 3; i++) {
      const a = (i - 1) * 0.42;
      clawParts.push(claw(0.062 * H, 0.028 * W, {
        rx: -0.40, rz: a,
        x: Math.sin(a) * 0.035 * H,
        y: -foreLen - foreR * 0.5,
        z: 0.018 * H,
      }));
    }
    const claws = new THREE.Mesh(merge(clawParts), boneMat);
    claws.name = side < 0 ? 'clawsL' : 'clawsR';
    fore.add(claws);
  }

  // -------------------------------------------------------------------- legs
  // Stubby by design: short legs under a long body is the visual shorthand for
  // "scurrying", and it keeps the stride frequency looking high.
  const thighLen = 0.175 * H;
  const shinLen = 0.155 * H;
  const thighR = 0.115 * W;
  const shinR = 0.088 * W;
  const kneeY = hipY - thighLen;
  const shinTilt = 0.16;                       // ankle tucked back under the hip
  const cs = Math.cos(shinTilt), sn = Math.sin(shinTilt);

  // World-space -> shin-local, so the foot can be authored where it actually
  // has to sit (flat on the floor) and then merged into the tilted shin.
  const toShin = (geo, wy, wz) => {
    const dy = wy - kneeY;
    geo.rotateX(-shinTilt);
    geo.translate(0, dy * cs + wz * sn, -dy * sn + wz * cs);
    return geo;
  };

  const footR = 0.11 * W;
  const footFlat = 0.42;
  // Half the foot's height, plus a hair of lift: the bowed-out legs tilt the
  // sole a few degrees, and without the lift its outer edge cuts the floor.
  const footH = footR * footFlat + 0.009 * H;

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(merge([
      bone(thighLen, thighR),
      blob(thighR * 1.25, { s: [1.0, 0.9, 0.95] }),
    ]), darkMat);
    leg.name = side < 0 ? 'legL' : 'legR';
    leg.position.set(side * (0.21 * W), hipY, 0);
    leg.rotation.z = side * -0.09;   // knees bowed out, feral
    g.add(leg);

    const shin = new THREE.Mesh(merge([
      bone(shinLen, shinR),
      // Foot: a flat splay of a thing, authored so its underside lands on y=0.
      toShin(blob(footR, { s: [0.95, footFlat, 1.5] }), footH, 0.045 * H),
    ]), darkMat);
    shin.name = side < 0 ? 'shinL' : 'shinR';
    shin.position.set(0, -thighLen, 0);
    shin.rotation.x = shinTilt;
    leg.add(shin);

    const toeParts = [];
    for (let i = 0; i < 2; i++) {
      toeParts.push(toShin(
        claw(0.045 * H, 0.030 * W, { rx: -Math.PI * 0.42, rz: (i - 0.5) * 0.5 }),
        footH * 1.15, 0.10 * H,
      ));
    }
    const toes = new THREE.Mesh(merge(toeParts), boneMat);
    toes.name = side < 0 ? 'toesL' : 'toesR';
    shin.add(toes);
  }

  // ------------------------------------------------------------------- armed
  // Runners never carry one, but the branch stays so every zombie builder in
  // this folder honours the same type flag.
  if (type.armed) {
    const armR = g.getObjectByName('armR');
    const gun = new THREE.Group();
    gun.name = 'gun';

    const slide = new THREE.Mesh(
      place(new THREE.CylinderGeometry(0.028, 0.032, 0.20, 6), { rx: Math.PI / 2, z: -0.06 }),
      material(0x2b3036, 0.55, 0.65),
    );
    gun.add(slide);
    const grip = new THREE.Mesh(
      place(new THREE.CylinderGeometry(0.026, 0.034, 0.12, 6), { rx: 0.35, y: -0.07, z: 0.02 }),
      material(0x1a1e22, 0.8, 0.2),
    );
    gun.add(grip);

    // Hung off armR (not the forearm) because the aim animation drives armR;
    // the offset is the hand's resting spot in armR's own space, and the
    // counter-rotation cancels the cocked elbow so the muzzle points ahead.
    gun.position.copy(handAnchor);
    gun.rotation.set(-elbow, 0, 0);
    armR.add(gun);
  }

  return g;
}
