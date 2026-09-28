// Enemy rendering: prototypes, per-instance meshes, and the animation sync.
//
// Split out from entities/enemy.js so the simulation stays free of Three.js.
// The authoritative server runs the same Enemy class headlessly; only the
// client ever loads this file.

import * as THREE from '../../vendor/three.module.js';
import { ENEMY_TYPES } from '../entities/enemy.js';
import { buildGruntModel } from './zombies/grunt.js';
import { buildRunnerModel } from './zombies/runner.js';
import { buildGunnerModel } from './zombies/gunner.js';
import { buildBruteModel } from './zombies/brute.js';
import { buildSpitterModel } from './zombies/spitter.js';
import { buildBossModel } from './zombies/boss.js';
import { buildBloaterModel } from './zombies/bloater.js';
import { buildBulwarkModel } from './zombies/bulwark.js';
import { buildLeaperModel } from './zombies/leaper.js';
import { buildClippyModel } from './zombies/clippy.js';
import { applyZombieSkin } from './zombieskin.js';
import {
  hasCharacter, buildCharacterMesh, playState, updateCharacter, disposeCharacter,
} from './charactermodels.js';
import { sampleRunnerGait } from './runneranimation.js';
import { locomotionState, sampleVaultPose } from './zombieanimation.js';

export { sampleVaultPose } from './zombieanimation.js';

const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/**
 * A stable collapse style derived from the authoritative enemy id.
 *
 * It deliberately uses a small fixed table instead of Math.random(): a network
 * client must make the same corpse fall the same way, and a replay should not
 * change merely because it rendered on another frame boundary.
 */
function deathStyle(enemy) {
  const styles = [
    { axis: 'x', sign: 1, yaw: -0.30, rate: 0.92 },
    { axis: 'z', sign: 1, yaw: 0.18, rate: 1.08 },
    { axis: 'x', sign: -1, yaw: 0.42, rate: 1.00 },
    { axis: 'z', sign: -1, yaw: -0.16, rate: 0.96 },
  ];
  return styles[Math.abs(enemy.id ?? 0) % styles.length];
}

/** Apply the shared root pose, plus planted limb beats on procedural bodies. */
function applyVaultPose(enemy, group, limbs = null) {
  if (!enemy.alive || !enemy.vault) return;
  const side = Math.abs(enemy.id ?? 0) % 2 ? 1 : -1;
  const pose = sampleVaultPose(enemy.vault.progress, side);
  group.rotation.x = pose.pitch;
  group.rotation.z = pose.roll;
  group.scale.y = 1 - pose.crouch * 0.10;

  if (!limbs) return;
  const lead = side > 0 ? limbs.legR : limbs.legL;
  const trail = side > 0 ? limbs.legL : limbs.legR;
  lead.rotation.x = pose.leadLeg;
  trail.rotation.x = pose.trailLeg;
  limbs.armL.rotation.x = pose.armL;
  limbs.armR.rotation.x = pose.armR;
}

function limbMat(color) {
  return new THREE.MeshStandardMaterial({ color: srgb(color), roughness: 0.72, metalness: 0.04 });
}

/**
 * Rounded capsule-ish part. Capsules and spheres are what stop these reading
 * as stacked cubes; the silhouette is what the eye judges at combat range, so
 * the limbs matter more than the surface detail.
 */
function capsule(radius, length, mat) {
  return new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 10), mat);
}

// One prototype per enemy type, cloned per spawn. Cloning shares geometry, so
// spawning a wave costs nothing but a handful of material clones.
const PROTOTYPES = new Map();

/**
 * Build the visual for an enemy. Limbs are named so the walk cycle can find
 * them again after cloning.
 */
export function buildEnemyMesh(type) {
  if (!PROTOTYPES.has(type)) PROTOTYPES.set(type, buildPrototype(type));

  // A downloaded skinned character stands in for the capsule build when the art
  // pack has one for this type. Scaled to `type.height`, which is not a guess
  // about the art -- it is the same number the simulation uses for the hitbox,
  // so a downloaded body cannot end up taller than what bullets hit.
  // `type` is the ENEMY_TYPES key, not the record -- see the call in main.js.
  if (hasCharacter(type)) {
    // Guarded, because this runs once per spawn and a wave spawns several at
    // once. Everything else in the art pipeline treats a failure as "use the
    // procedural version", but this call site did not -- so a single bad
    // reference inside buildCharacterMesh threw on every spawn and took the
    // frame with it, which reads as the game freezing the instant a wave
    // starts rather than as a missing zombie. A capsule that walks is always
    // better than a game that stops.
    let skinned = null;
    try {
      skinned = buildCharacterMesh(type, ENEMY_TYPES[type].height);
    } catch (err) {
      console.warn(`[enemymesh] ${type}: character build failed, using built model:`, err?.message ?? err);
    }
    if (skinned) {
      // The limb table is what syncEnemyMesh poses by hand. A skinned character
      // is posed by its own clips instead, so the absence of limbs is the signal
      // rather than a special case flag.
      skinned.userData.limbs = null;
      return skinned;
    }
  }

  const g = PROTOTYPES.get(type).clone();

  // Re-resolve the limb references, which clone() does not carry across.
  const named = {};
  g.traverse((o) => { if (o.name) named[o.name] = o; });
  g.userData.limbs = {
    legL: named.legL, legR: named.legR,
    armL: named.armL, armR: named.armR,
    torso: named.torso, head: named.head,
  };

  // Each enemy needs its own materials so a hit flash affects only that one --
  // but only one clone per distinct source material. The detailed models carry
  // 40+ meshes over a dozen materials; cloning per mesh would triple the shader
  // variants for nothing.
  const remap = new Map();
  g.userData.materials = [];
  g.traverse((o) => {
    if (!o.isMesh) return;
    let m = remap.get(o.material);
    if (!m) {
      m = o.material.clone();
      remap.set(o.material, m);
      g.userData.materials.push(m);
    }
    o.material = m;
    // Additive shells are envelopes around a glowing core, not solid geometry.
    o.castShadow = !o.name.startsWith('halo');
  });
  return g;
}

/** Dispose the per-instance materials created by buildEnemyMesh. */
export function disposeEnemyMesh(group) {
  if (group?.userData?.character) { disposeCharacter(group); return; }
  if (!group?.userData?.materials) return;
  for (const m of group.userData.materials) m.dispose();
  group.userData.materials.length = 0;
}

/**
 * Map simulation state onto a clip, in priority order.
 *
 * The order is the point. Death outranks everything because a corpse must stop
 * acting; a wind-up outranks locomotion because the wind-up is the tell the
 * player is reading to decide whether to back off, and losing it to a walk cycle
 * would delete the counterplay the fight is built on. Run-versus-walk is last
 * and is decided by measured ground speed. That same measurement drives clip
 * playback below, so feet and world motion stay locked in solo and co-op.
 */
function syncCharacterState(enemy, g, dt) {
  const t = enemy.type;
  const speed = Math.hypot(enemy.vel?.x ?? 0, enemy.vel?.z ?? 0);
  let state = locomotionState(speed);

  if (!enemy.alive) {
    state = 'death';
  } else if (enemy.vault) {
    // Prefer a dedicated vault/jump when installed, otherwise the classifier
    // aliases this to run (or walk). It must stay a moving performance while
    // the authoritative arc carries the body through the opening.
    state = 'vault';
  } else if (enemy.attackTimer > t.attackCooldown * 0.6
             || (t.ranged && enemy.aimTimer > 0)) {
    state = 'attack';
  }

  const enteringDeath = state === 'death' && g.userData.character.state !== 'death';
  playState(g, state);
  if (enteringDeath && g.userData.character.current) {
    g.userData.character.current.timeScale *= deathStyle(enemy).rate;
  }
  // Locomotion plays at the speed the enemy actually moves; an attack or a death
  // is a fixed performance and must not be sped up because the thing is fast.
  updateCharacter(g, dt,
    state === 'walk' || state === 'run' || state === 'vault' ? speed : null);

  // Not every pack ships a death clip -- Quaternius' zombies have idle, walk and
  // attack -- and playState falls back to idle, which would leave a corpse
  // standing there breathing. So when there is nothing to play, borrow the
  // built path's topple: the body falls the same way the capsules always have.
  if (!enemy.alive && !g.userData.character.actions.death) {
    const k = 1 - Math.max(0, enemy.deathTimer) / 0.5;
    const style = deathStyle(enemy);
    g.rotation[style.axis] = style.sign * k * Math.PI * 0.5;
    g.position.y = enemy.pos.y + Math.sin(k * Math.PI) * 0.1;
  }

  // Even one installed death clip stops looking cloned when bodies face
  // different world directions as they collapse.
  if (!enemy.alive) g.rotation.y = enemy.yaw + deathStyle(enemy).yaw;

  // The fuse pulse is the one tell that has to survive the swap, because a
  // bloater about to detonate is information the player cannot afford to miss.
  if (t.explodes && enemy.fuse >= 0) {
    const k = 1 - enemy.fuse / t.fuse;
    const pulse = 0.5 + Math.abs(Math.sin(k * 18)) * 0.5;
    g.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m?.emissive) m.emissive.setRGB(pulse * 0.9, pulse * 0.2, 0);
        }
      }
    });
  }
}

/**
 * Bespoke models, one per character. Types absent from this table fall back to
 * the generic humanoid below, so a half-finished roster still runs.
 */
const CUSTOM_MODELS = {
  grunt: buildGruntModel,
  runner: buildRunnerModel,
  gunner: buildGunnerModel,
  brute: buildBruteModel,
  spitter: buildSpitterModel,
  boss: buildBossModel,
  exploder: buildBloaterModel,
  shielded: buildBulwarkModel,
  jumper: buildLeaperModel,
  clippy: buildClippyModel,
};

function buildPrototype(type) {
  const custom = CUSTOM_MODELS[type];
  const g = custom ? custom(ENEMY_TYPES[type]) : buildGenericPrototype(type);
  // The models are authored in flat colour, which is what made the horde read as
  // untextured plastic. Skinning happens here, on the prototype, so the UV
  // rewrite is paid once per enemy type rather than once per spawn.
  // Clippy is polished office-supply metal, not decomposing skin. Keeping its
  // authored materials also makes the bright eyes survive the zombie UV pass.
  if (type !== 'clippy') applyZombieSkin(g);
  return g;
}

function syncClippy(enemy, g) {
  const root = g.getObjectByName('clippyRoot');
  if (!root) return;
  const speed = Math.hypot(enemy.vel?.x ?? 0, enemy.vel?.z ?? 0);
  const moving = Math.min(1, speed / Math.max(0.01, enemy.type.speed));
  const hop = Math.max(0, Math.sin(enemy.walkPhase * 1.4)) * 0.085 * moving;
  root.position.y = hop;
  root.rotation.x = 0;
  root.rotation.y = 0;
  root.rotation.z = Math.sin(enemy.walkPhase * 0.7) * 0.075 * moving;

  // A quick forward snap during the melee wind-up reads as the paperclip
  // trying to clamp the player, without inventing limbs it does not have.
  const cooldown = enemy.type.attackCooldown;
  if (enemy.attackTimer > cooldown * 0.6) {
    const k = (enemy.attackTimer - cooldown * 0.6) / (cooldown * 0.4);
    root.rotation.x = -0.28 * k;
  }

  if (!enemy.alive) {
    const k = 1 - Math.max(0, enemy.deathTimer) / 0.5;
    g.rotation.z = (Math.abs(enemy.id ?? 0) % 2 ? 1 : -1) * k * Math.PI * 0.5;
    g.position.y = enemy.pos.y + Math.sin(k * Math.PI) * 0.12;
  }

  const flash = enemy.hitFlash;
  for (const m of g.userData.materials) {
    if (m.emissive) m.emissive.setRGB(flash * 0.9, flash * 0.12, flash * 0.12);
  }
}

function buildGenericPrototype(type) {
  const t = ENEMY_TYPES[type];
  const g = new THREE.Group();

  const H = t.height;
  const W = t.width;
  const headR = W * 0.34;
  const bodyH = H - headR * 2;
  const legH = bodyH * 0.46;
  const torsoH = bodyH - legH;

  const bodyMat = limbMat(t.bodyColor);
  const headMat = limbMat(t.headColor);
  const darkMat = limbMat(t.accentColor);

  // Torso: a capsule, tapered by scaling, so shoulders and waist differ.
  const torso = capsule(W * 0.32, torsoH * 0.62, bodyMat);
  torso.name = 'torso';
  torso.scale.set(1.15, 1, 0.78);
  torso.position.y = legH + torsoH * 0.5;
  g.add(torso);

  // Neck, so the head does not float off the shoulders.
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(W * 0.13, W * 0.16, headR * 0.6, 8), darkMat);
  neck.position.y = legH + torsoH * 0.94;
  g.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 14, 10), headMat);
  head.name = 'head';
  head.scale.set(1, 1.08, 0.94);
  head.position.y = bodyH + headR;
  g.add(head);

  // Brow ridge: a flattened band that gives the face a clear facing direction.
  const brow = new THREE.Mesh(
    new THREE.SphereGeometry(headR * 0.92, 12, 8,
      0, Math.PI * 2, Math.PI * 0.30, Math.PI * 0.16), darkMat);
  brow.position.y = bodyH + headR;
  brow.scale.set(1, 1.08, 0.98);
  g.add(brow);

  // Eyes, set into the front of the skull.
  const eyeGeo = new THREE.SphereGeometry(headR * 0.17, 8, 6);
  const eyeMat = new THREE.MeshStandardMaterial({
    color: srgb(0xf4f1e4), roughness: 0.35, emissive: srgb(0x552211), emissiveIntensity: 0.4,
  });
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(sx * headR * 0.36, bodyH + headR * 1.06, headR * 0.80);
    g.add(eye);
  }

  // --- limbs. Geometry is shifted so the mesh origin sits at the joint,
  // which lets rotation.x swing the limb instead of spinning it in place.
  const legR_ = W * 0.15;
  const legGeo = new THREE.CapsuleGeometry(legR_, legH * 0.62, 4, 8);
  legGeo.translate(0, -legH * 0.5, 0);

  const legL = new THREE.Mesh(legGeo, darkMat);
  legL.name = 'legL';
  legL.position.set(-W * 0.20, legH, 0);
  g.add(legL);

  const legR = legL.clone();
  legR.name = 'legR';
  legR.position.x = W * 0.20;
  g.add(legR);

  const armR_ = W * 0.115;
  const armLen = torsoH * 0.92;
  const armGeo = new THREE.CapsuleGeometry(armR_, armLen * 0.6, 4, 8);
  armGeo.translate(0, -armLen * 0.5, 0);

  const armL = new THREE.Mesh(armGeo, headMat);
  armL.name = 'armL';
  armL.position.set(-(W * 0.36 + armR_), legH + torsoH * 0.92, 0);
  g.add(armL);

  const armR = armL.clone();
  armR.name = 'armR';
  armR.position.x = W * 0.36 + armR_;
  g.add(armR);

  // --- archetype tells --------------------------------------------------
  // Each of these exists so the counter-play is readable from the silhouette
  // before the name plate is: a shield you must walk around, a core you must
  // get behind, a sac that tells you to back off.

  if (t.shield) {
    // A slab held out front. Deliberately wider than the body so the arc it
    // protects is obvious from any angle you might shoot it from.
    const shieldMat = new THREE.MeshStandardMaterial({
      color: srgb(0x39424d), roughness: 0.35, metalness: 0.7,
    });
    const shield = new THREE.Mesh(new THREE.BoxGeometry(W * 1.5, H * 0.55, 0.12), shieldMat);
    shield.name = 'shield';
    shield.position.set(0, legH + torsoH * 0.55, W * 0.62);
    g.add(shield);

    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(W * 1.56, H * 0.06, 0.16),
      new THREE.MeshStandardMaterial({ color: srgb(0xd8c15a), roughness: 0.4, metalness: 0.5 }));
    rim.position.set(0, legH + torsoH * 0.55 + H * 0.26, W * 0.62);
    g.add(rim);
  }

  if (t.explodes) {
    // Pressure sacs. Emissive so they bloom, which reads as "about to go off"
    // even at the edge of vision.
    const sacMat = new THREE.MeshStandardMaterial({
      color: srgb(0xcbe04a), roughness: 0.5,
      emissive: srgb(0x9fbf20), emissiveIntensity: 0.7,
    });
    for (const [sx, sy, sz, r] of [
      [0, legH + torsoH * 0.72, W * 0.30, W * 0.30],
      [-W * 0.34, legH + torsoH * 0.45, W * 0.18, W * 0.20],
      [W * 0.34, legH + torsoH * 0.45, W * 0.18, W * 0.20],
    ]) {
      const sac = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), sacMat);
      sac.name = 'sac';
      sac.position.set(sx, sy, sz);
      g.add(sac);
    }
  }

  if (t.boss) {
    // The weak point: a glowing core on its back. Everything about the fight
    // is arranged around getting behind this, so it is the brightest thing on
    // the model and visible from a long way off.
    const coreMat = new THREE.MeshStandardMaterial({
      color: srgb(0xffd24a), roughness: 0.25,
      emissive: srgb(0xff8a1e), emissiveIntensity: 1.4,
    });
    const core = new THREE.Mesh(new THREE.SphereGeometry(W * 0.30, 14, 10), coreMat);
    core.name = 'core';
    core.position.set(0, legH + torsoH * 0.62, -W * 0.42);
    g.add(core);

    // A dim shell around it so the glow has a shape rather than being a blob.
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(W * 0.42, 12, 8),
      new THREE.MeshBasicMaterial({
        color: srgb(0xff9b30), transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
    halo.name = 'haloCore';
    halo.position.copy(core.position);
    g.add(halo);

    // Armour plating over the front, the visual half of the armor multiplier.
    const plateMat = new THREE.MeshStandardMaterial({
      color: srgb(0x4a2028), roughness: 0.5, metalness: 0.45,
    });
    const plate = new THREE.Mesh(new THREE.BoxGeometry(W * 0.95, torsoH * 0.75, 0.16), plateMat);
    plate.position.set(0, legH + torsoH * 0.6, W * 0.34);
    g.add(plate);
  }

  // Armed types carry a visible pistol, so the player can tell at a glance
  // which silhouettes shoot back.
  if (t.armed) {
    const gun = new THREE.Group();
    gun.name = 'gun';
    const gunMat = new THREE.MeshStandardMaterial({
      color: srgb(0x2b3036), roughness: 0.45, metalness: 0.6,
    });
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.26), gunMat);
    slide.position.z = -0.11;
    gun.add(slide);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.13, 0.07), gunMat);
    grip.position.set(0, -0.09, 0.02);
    gun.add(grip);
    gun.position.set(0, -armLen * 0.52, -0.05);
    armR.add(gun);
  }

  return g;
}

/** Push simulation state into the Three.js group. */
export function syncEnemyMesh(enemy, alpha = 1, dt = 0) {
  const g = enemy.group;
  if (!g) return;
  g.position.set(enemy.pos.x, enemy.pos.y, enemy.pos.z);
  // Clear root pose from the previous frame before applying a vault or death.
  // Without this, the last non-zero vault roll can leak into normal walking.
  g.rotation.set(0, enemy.yaw, 0);
  g.scale.set(1, 1, 1);

  if (enemy.type.id === 'clippy') {
    syncClippy(enemy, g);
    return;
  }

  // Skinned characters read the same simulation state, but express it by
  // choosing a clip instead of by rotating four named limbs. Everything below
  // this branch is the hand-posed path and stays exactly as it was.
  if (g.userData.character) {
    syncCharacterState(enemy, g, dt);
    applyVaultPose(enemy, g);
    return;
  }

  const { legL, legR, armL, armR } = g.userData.limbs;
  if (enemy.type.id === 'runner') {
    const speed = Math.hypot(enemy.vel?.x ?? 0, enemy.vel?.z ?? 0);
    const gait = sampleRunnerGait(enemy.walkPhase, speed, enemy.type.speed);
    legL.rotation.x = gait.legL;
    legR.rotation.x = gait.legR;
    armL.rotation.x = gait.armL;
    armR.rotation.x = gait.armR;
    if (g.userData.limbs.torso) g.userData.limbs.torso.rotation.x = gait.torsoPitch;
    g.position.y += gait.bob;
  } else {
    const swing = Math.sin(enemy.walkPhase) * 0.7;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    armL.rotation.x = -swing * 0.6;
    armR.rotation.x = swing * 0.6;
  }

  // Wind up the arms just before a swing lands.
  const t = enemy.type.attackCooldown;
  if (enemy.attackTimer > t * 0.6) {
    const k = (enemy.attackTimer - t * 0.6) / (t * 0.4);
    armL.rotation.x = -1.6 * k;
    armR.rotation.x = -1.6 * k;
  }

  // Gunners raise the pistol while aiming -- the tell that a shot is coming.
  if (enemy.type.ranged) {
    const aim = enemy.aimTimer > 0
      ? 1 - enemy.aimTimer / Math.max(0.01, enemy.type.rangedWarmup)
      : 0;
    if (aim > 0) armR.rotation.x = -Math.PI / 2 * Math.min(1, aim * 1.6);
  }

  if (!enemy.alive) {
    // Alternate forward, backward and both sideways collapses instead of
    // stamping the same topple onto every corpse in the horde.
    const k = 1 - Math.max(0, enemy.deathTimer) / 0.5;
    const style = deathStyle(enemy);
    g.rotation.y = enemy.yaw + style.yaw;
    g.rotation[style.axis] = style.sign * k * Math.PI * 0.5;
    g.position.y = enemy.pos.y + Math.sin(k * Math.PI) * 0.1;
  }

  applyVaultPose(enemy, g, g.userData.limbs);

  // A lit fuse is the one piece of enemy state the player must not miss, so it
  // drives a hard pulse rather than a subtle one.
  if (enemy.type.explodes && enemy.fuse >= 0) {
    const k = 1 - enemy.fuse / enemy.type.fuse;
    const beat = 0.5 + 0.5 * Math.sin(k * k * 60);
    for (const o of g.children) {
      if (o.name !== 'sac') continue;
      o.material.emissiveIntensity = 0.7 + beat * 4;
      o.scale.setScalar(1 + beat * 0.25 * k);
    }
  }

  // The boss core breathes, and flares once it is enraged.
  if (enemy.type.boss) {
    const rage = enemy.health <= enemy.maxHealth * enemy.type.enrageAt;
    const pulse = 0.5 + 0.5 * Math.sin(enemy.walkPhase * (rage ? 6 : 2));
    for (const o of g.children) {
      if (o.name === 'core') o.material.emissiveIntensity = (rage ? 2.4 : 1.2) + pulse * 0.8;
      else if (o.name === 'haloCore') o.material.opacity = (rage ? 0.34 : 0.2) + pulse * 0.14;
    }
  }

  const flash = enemy.hitFlash;
  for (const m of g.userData.materials) {
    // Additive glow shells are MeshBasicMaterial, which has no emissive channel
    // -- writing to it would throw on the first frame a spitter is alive.
    if (!m.emissive) continue;
    m.emissive.setRGB(flash * 0.9, flash * 0.12, flash * 0.12);
  }

  void alpha;
}
