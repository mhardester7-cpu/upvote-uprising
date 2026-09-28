// Shared modelling toolkit for the characters.
//
// The bespoke zombie models each grew their own copy of these helpers, which
// was fine while there were two of them and is not fine at nine. Everything
// here is the same toolkit the grunt established -- the house style is lathes,
// capsules and perturbed spheres, and specifically *not* boxes, because the
// arena moved off the voxel look and the characters have to sell that at a
// glance.
//
// Conventions every model in this game follows:
//
//   - origin at the feet, centred in X/Z, occupying y = 0 .. type.height
//   - forward is +Z, because enemy.yaw = atan2(dx, dz)
//   - meshes named legL/legR/armL/armR/torso/head must exist, and the four limb
//     origins sit at their joint -- the walk cycle drives `.rotation.x`, and a
//     limb whose origin is at its middle spins instead of swinging
//   - the group is cloned per spawn, and Object3D.clone() round-trips userData
//     through JSON, so no mesh references may be stored there

import * as THREE from '../../vendor/three.module.js';

// ------------------------------------------------------------------ material

/**
 * The renderer works in linear space with ACES tone mapping, so a raw hex
 * literal handed to a material comes out washed out and off-hue. Every colour
 * has to be declared as sRGB and converted.
 */
export function srgb(hex) {
  return new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
}

export function mat(hex, roughness = 0.95, metalness = 0, extra = null) {
  const m = new THREE.MeshStandardMaterial({ color: srgb(hex), roughness, metalness });
  if (extra) Object.assign(m, extra);
  return m;
}

/** Emissive material for anything that should catch the bloom pass. */
export function glowMat(hex, emissive = hex, intensity = 1.2) {
  return new THREE.MeshStandardMaterial({
    color: srgb(hex), roughness: 0.3, metalness: 0,
    emissive: srgb(emissive), emissiveIntensity: intensity,
  });
}

/**
 * Additive shell, for the halo around a glowing part. depthWrite is off so the
 * shell never occludes what is inside it.
 */
export function haloMat(hex, opacity = 0.22) {
  return new THREE.MeshBasicMaterial({
    color: srgb(hex), transparent: true, opacity,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

/** Shared palette. Bone is bone and a wound is a wound, on every tint. */
export const BONE = 0xd2c8a6;
export const GORE = 0x5e1f1c;
export const RAG = 0x3b3d30;
export const SOCKET = 0x0d1409;
export const MOUTH = 0x140b0b;
export const GUNMETAL = 0x2b3036;
export const STEEL = 0x6b737c;

// ------------------------------------------------------------------ geometry

/**
 * Cheap deterministic hash. Deliberately a pure function of position, so the
 * duplicated vertices along a lathe seam or at a sphere pole receive the same
 * displacement and the surface does not crack open.
 */
export function hash3(x, y, z, seed) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.129) * 43758.5453;
  return s - Math.floor(s);
}

/** Lumpy up an indexed surface by pushing vertices along their own normals. */
export function perturbNormal(geo, amp, freq = 6, seed = 1) {
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
export function perturbRadial(geo, amp, freq = 6, seed = 1) {
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
export function raggedHem(geo, hemY, drop, seed = 3) {
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
 * the default of 2, which twenty on-screen enemies cannot afford.
 */
export function bone(len, radius, material, capSegments = 1, radialSegments = 8) {
  const shaft = Math.max(0.01, len - radius * 2);
  const geo = new THREE.CapsuleGeometry(radius, shaft, capSegments, radialSegments);
  geo.translate(0, -len / 2, 0);
  return new THREE.Mesh(geo, material);
}

/** Squashed blob -- muscle bellies, feet, jaws, skulls. */
export function blob(radius, sx, sy, sz, material, wSeg = 8, hSeg = 5) {
  const geo = new THREE.SphereGeometry(radius, wSeg, hSeg);
  geo.scale(sx, sy, sz);
  return new THREE.Mesh(geo, material);
}

/** Angular chunk -- deltoids, knees, torn flesh flaps. 20 triangles each. */
export function chunk(radius, material, seed) {
  const geo = new THREE.IcosahedronGeometry(radius, 0);
  perturbRadial(geo, radius * 0.22, 9, seed);
  return new THREE.Mesh(geo, material);
}

/**
 * A body of revolution from a [heightFraction, radiusFraction] profile.
 * This is how every torso in the game is built: a profile reads as a shape you
 * can reason about, where a stack of primitives reads as a stack of primitives.
 */
export function lathe(profile, height, radius, material, segments = 12) {
  const points = profile.map(([v, r]) =>
    new THREE.Vector2(Math.max(0.001, r * radius), v * height));
  const geo = new THREE.LatheGeometry(points, segments);
  return new THREE.Mesh(geo, material);
}

/** Interpolate a [v, r] profile table at height fraction v. */
export function profileRadiusAt(profile, v) {
  for (let i = 1; i < profile.length; i++) {
    const [v1, r1] = profile[i];
    if (v > v1) continue;
    const [v0, r0] = profile[i - 1];
    const t = v1 === v0 ? 0 : (v - v0) / (v1 - v0);
    return r0 + (r1 - r0) * t;
  }
  return profile[profile.length - 1][1];
}

/**
 * A slightly bent armour plate: a sphere shell section, so it curves around the
 * body it sits on. Plating built from boxes is exactly what makes a model read
 * as programmer art, because nothing on a body is flat.
 */
export function plate(radius, arcWide, arcTall, material, thickness = 0.03) {
  // phiStart is offset by a quarter turn because THREE parameterises a sphere
  // with phi = 0 pointing along -X, not +Z. Without this every plate in the
  // game faces sideways, which is a very confusing thing to debug from a
  // screenshot.
  const geo = new THREE.SphereGeometry(
    radius, 10, 6,
    Math.PI / 2 - arcWide / 2, arcWide,
    Math.PI / 2 - arcTall / 2, arcTall,
  );
  // A sphere section sits a full `radius` away from the sphere's centre, so an
  // untranslated plate lands a metre in front of wherever it was positioned.
  // Shifting it back means `position` places the *surface*, which is the only
  // thing a caller ever wants to aim.
  geo.translate(0, 0, -radius);
  const m = new THREE.Mesh(geo, material);
  m.scale.z = 1 + thickness;
  return m;
}

/**
 * A point on a plate's surface, in that plate's local space. Lets rivets, slits
 * and trim be placed by the same two angles that defined the plate, instead of
 * by hand-solved coordinates.
 */
export function plateSurface(radius, yaw, pitch, lift = 0) {
  const r = radius + lift;
  return new THREE.Vector3(
    Math.sin(yaw) * r * Math.cos(pitch),
    Math.sin(pitch) * r,
    Math.cos(yaw) * Math.cos(pitch) * r - radius,
  );
}

/** Mark every mesh under a group as shadow-casting, except additive shells. */
export function castShadows(group) {
  group.traverse((o) => {
    if (o.isMesh) o.castShadow = !o.name.startsWith('halo');
  });
  return group;
}
