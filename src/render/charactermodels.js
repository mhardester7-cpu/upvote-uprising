// Skinned characters in place of the built ones.
//
// The nine enemies in src/render/zombies/ are capsules and spheres posed by
// hand: syncEnemyMesh swings four named limbs off `walkPhase` and winds the arms
// up before a hit lands. That is why they read at combat range -- the tells are
// authored, not incidental -- and it is also the ceiling. A capsule zombie is
// legible; it is not frightening.
//
// A downloaded character is a skinned mesh with its own clips, so the swap is
// larger than the weapon one: it replaces both the body and the animation. The
// design keeps the *simulation* untouched, which is the part that matters:
//
//   The sim decides everything. Position, yaw, whether a hit is winding up,
//   whether the fuse is lit, whether it is dead -- all of that stays in
//   entities/enemy.js and is read here, exactly as the procedural path reads it.
//   A character model chooses which clip to play; it never decides what happens.
//
//   Height is the contract. Each model is scaled so it stands as tall as the
//   capsule build it replaces, because every hitbox, muzzle height and camera
//   framing in the game was tuned against those. A downloaded zombie that
//   renders a head taller than its own hitbox is a gun that misses.
//
//   Clips are matched by name, loosely. Authors name them anything, so each
//   state has a list of patterns and the first clip that matches wins. A state
//   with no matching clip falls back to idle, and a model with no clips at all
//   is rejected outright -- a T-posing zombie sliding across the ground is worse
//   than a capsule that walks.
//
// Absent art leaves the procedural path completely untouched.

import * as THREE from '../../vendor/three.module.js';
import { loadModelFile } from './loadmodel.js';
import { clone as cloneSkinned } from '../../vendor/utils/SkeletonUtils.js';
import { assetIndex } from './photosets.js';
import {
  CHARACTER_CLIP_SPEED, RUN_ABOVE, classifyCharacterClips,
  locomotionPlaybackRate, locomotionState,
} from './zombieanimation.js';

export {
  CHARACTER_CLIP_SPEED, RUN_ABOVE, classifyCharacterClips,
  locomotionPlaybackRate, locomotionState,
} from './zombieanimation.js';

const ROOT = new URL('../../assets/', import.meta.url).href;

/**
 * Which manifest role dresses which enemy type.
 *
 * Deliberately not one model per type. Nine distinct realistic humanoids do not
 * exist for free, and more importantly the roster reads by *silhouette*: the
 * bulwark's shield and the boss's back core are the counterplay. Those two keep
 * their built models on purpose -- a generic zombie body would delete the tell
 * the fight is built around -- and the types that are "a zombie that moves
 * differently" share bodies, which is what they already look like anyway.
 */
export const CHARACTER_ROLES = {
  cinder_stalker: 'zombie',
  nyx_wraith: 'zombie',
  grunt: 'zombie',
  // Runners use this same textured, skinned body. Their dedicated installed
  // running clip and measured playback rate distinguish them from shamblers;
  // swapping the body itself for the old rigid build reintroduces the visual
  // downgrade this asset pipeline exists to prevent.
  runner: 'zombie',
  gunner: 'zombie',
  spitter: 'zombie',
  exploder: 'zombie',
  jumper: 'zombie',
  brute: 'zombie',
  // shielded (BULWARK) and boss (ABOMINATION) intentionally absent: their
  // silhouettes carry the counter, so they stay hand-built.
};

/**
 * Yaw correction per pack, in radians.
 *
 * `syncEnemyMesh` sets `rotation.y = atan2(dx, dz)`, which points a model's +Z
 * along its direction of travel, and every built zombie is modelled facing +Z
 * for that reason. A downloaded character faces whatever its author worked to,
 * and if that is -Z the whole horde walks at the player backwards.
 *
 * Keyed by role, because it is a fact about the pack rather than about the
 * enemy wearing it. Check a new one in tools/characterviewer.html: press "walk
 * a lap" and watch whether it faces where it is going.
 */
export const FACING = {
  // Mixamo-derived rigs already face +Z, which is the axis syncEnemyMesh points
  // along the direction of travel. A correction here is what made them charge
  // the player backwards.
  zombie: 0,
};

/**
 * Roughly how fast each locomotion clip carries a body, in metres per second.
 *
 * Used only when a clip has no root motion to measure -- which is most of them,
 * because animation packs are published "in place" so the engine can drive
 * position itself. A shamble is slow and a run is not, and that difference is
 * the whole point: with one figure for both, choosing the wrong clip and then
 * stretching it is what produces skating.
 */
const DEATH_WINDOW = 1.0;


/**
 * Re-point a clip's tracks at the skeleton actually in the mesh.
 *
 * Packs derived from Mixamo ship the mesh in one export and each animation in
 * its own, and the two do not agree on bone names: the mesh here rigs to
 * `CityDeadOutfitHips` while every clip addresses `mixamorigHips`. three.js
 * binds tracks by name, so without this all 56 tracks resolve to nothing and the
 * zombie crosses the map in a T-pose -- animating perfectly, against bones that
 * do not exist.
 *
 * The join is the suffix. Both naming schemes end in the same standard rig names
 * (Hips, Spine, LeftArm), so each track is matched to the bone whose name ends
 * the same way. A track with no match is dropped rather than left dangling.
 */
/**
 * The ground speed a locomotion clip was authored at, in metres per second.
 *
 * Read off the root translation track: horizontal distance from the first
 * keyframe to the last, over the clip's duration. Vertical motion is ignored on
 * purpose -- a walk cycle bobs, and bob is not travel.
 *
 * Returns 0 when the track says nothing useful (an in-place clip, or a single
 * frame) so the caller can fall back to an assumed figure. Reporting a real
 * zero would divide the playback rate by nothing.
 */
function authoredSpeed(track, duration) {
  const v = track.values;
  if (!v || v.length < 6 || !(duration > 0)) return 0;
  const dx = v[v.length - 3] - v[0];
  const dz = v[v.length - 1] - v[2];
  const distance = Math.hypot(dx, dz);
  // Under a centimetre of travel is an in-place clip with float noise in it.
  return distance < 0.01 ? 0 : distance / duration;
}

function bindClipToSkeleton(clip, boneNames) {
  const bySuffix = new Map();
  for (const name of boneNames) {
    // Longest match wins: "LeftHandIndex1" must not be claimed by "LeftHand".
    bySuffix.set(name.toLowerCase(), name);
  }
  const resolve = (node) => {
    if (bySuffix.has(node.toLowerCase())) return bySuffix.get(node.toLowerCase());
    const bare = node.replace(/^mixamorig\d*:?/i, '').toLowerCase();
    if (!bare) return null;
    let best = null;
    for (const [lower, real] of bySuffix) {
      if (lower.endsWith(bare) && (!best || real.length < best.length)) best = real;
    }
    return best;
  };

  const tracks = [];
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    const node = track.name.slice(0, dot);
    const prop = track.name.slice(dot);

    // Drop the root's translation, but measure it on the way out.
    //
    // These clips are exported with root motion baked in: the animation itself
    // walks the body forward, while the simulation is separately moving the
    // enemy toward the player. Both at once means the feet and the ground
    // disagree. The simulation owns position; the clip owns the pose.
    //
    // What the track is worth keeping for is the number inside it. How far the
    // root travels over the clip's duration IS the speed the cycle was authored
    // at, so the feet can be matched to the ground exactly rather than
    // approximately -- the difference between walking and skating.
    if (prop === '.position' && /^root$/i.test(node)) {
      clip.groundSpeed = authoredSpeed(track, clip.duration);
      continue;
    }

    const real = resolve(node);
    if (!real) continue;
    track.name = real + prop;
    tracks.push(track);
  }
  clip.tracks = tracks;
  return clip;
}

/**
 * Hook up textures the model ships beside itself but never references.
 *
 * An FBX carries material names and, often, nothing else -- this pack exports
 * `City_Infected_Man_Body1` with no maps at all, while the PNGs sitting in the
 * same folder are named after exactly those materials. So the material name is
 * the lookup key, and the naming convention does the rest.
 *
 * The occlusion/roughness/metallic map is one file carrying three channels in R,
 * G and B, which is precisely what three.js samples aoMap, roughnessMap and
 * metalnessMap from -- so one texture serves three slots, as it does everywhere
 * else in this pipeline.
 */
function applyCharacterTextures(scene, dir, prefix = '', materialFallbacks = {}) {
  const loader = new THREE.TextureLoader();
  const tried = new Map();
  const load = (file, colorSpace) => {
    if (!tried.has(file)) {
      tried.set(file, new Promise((resolve) => {
        loader.load(dir + encodeURIComponent(file), (t) => {
          t.colorSpace = colorSpace;
          // Left at the default (true), because FBX UVs are bottom-up. Forcing
          // the glTF convention here flipped every map vertically -- which does
          // not read as "upside down", it reads as the wrong colours in the
          // wrong places, skin where the jacket should be.
          resolve(t);
        }, undefined, () => resolve(null));
      }));
    }
    return tried.get(file);
  };

  const jobs = [];
  scene.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const swapped = mats.map((m) => {
      const fallback = materialFallbacks[m.name];
      const std = new THREE.MeshStandardMaterial({
        name: m.name,
        color: fallback?.color ?? (m.color ? m.color.clone() : 0xffffff),
        roughness: fallback?.roughness ?? 1,
        metalness: fallback?.metalness ?? 0,
      });
      // Some FBX exports carry deliberately untextured sub-materials. The
      // zombie pack's defaultPolygonShader1 is its two eyeballs; guessing the
      // usual body-map filenames produced three 404s and left bright white
      // eyes in every browser. A manifest fallback is an explicit instruction
      // to keep this material untextured and use its authored replacement.
      if (fallback) return std;
      jobs.push((async () => {
        const [colour, normal, orm] = await Promise.all([
          load(`${prefix}${m.name}_BaseColor.png`, THREE.SRGBColorSpace),
          load(`${prefix}${m.name}_Normal.png`, THREE.NoColorSpace),
          load(`${prefix}${m.name}_OcclusionRoughnessMetallic.png`, THREE.NoColorSpace),
        ]);
        if (colour) std.map = colour;
        if (normal) std.normalMap = normal;
        if (orm) {
          // Occlusion from R and roughness from G, which is what the packing
          // says. The metallic channel is deliberately NOT wired up: a body is
          // skin and cloth, nothing on it is metal, and trusting B turned the
          // zombie into a dark speckled mirror -- a metallic surface lit only by
          // an environment map reflects almost nothing and shows its roughness
          // map as glitter. Leaving metalness at zero is both correct for the
          // material and the safer reading of somebody else's packing order.
          std.aoMap = orm;
          std.roughnessMap = orm;
          std.metalness = 0;
        }
        std.needsUpdate = true;
      })());
      return std;
    });
    o.material = Array.isArray(o.material) ? swapped : swapped[0];
  });
  return Promise.all(jobs);
}

const prototypes = new Map();   // role -> {scene, clips, height} | null
let manifestPromise = null;

async function characterManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const [res, index] = await Promise.all([
        // The manifest changes whenever the art pack does, so it is read fresh
        // for the same reason CREDITS.json is -- see photosets.js.
        fetch(`${ROOT}manifest.json`, { cache: 'no-cache' }).catch(() => null),
        assetIndex(),
      ]);
      if (!res?.ok || !index) return new Map();
      const manifest = await res.json();
      const out = new Map();
      for (const entry of manifest.characters || []) {
        if (!entry.role) continue;
        // Manifest order is preference order and the first installed entry per
        // role wins -- the same contract weapons use, so a Sketchfab token
        // upgrades a character rather than duplicating it.
        const file = entry.source === 'sketchfab'
          ? `assets/characters/${entry.uid}/scene.gltf`
          : `assets/characters/${entry.id}/${entry.pick.split('/').pop()}`;
        if (!index.has(file) || out.has(entry.role)) continue;
        out.set(entry.role, { ...entry, file });
      }
      return out;
    })().catch(() => new Map());
  }
  return manifestPromise;
}

/**
 * Load every character the manifest offers, once.
 *
 * Called during world build. Returns the roles that came back usable, so the
 * caller can report what actually happened rather than what was intended.
 */
export async function preloadCharacters() {
  const manifest = await characterManifest();
  const loaded = [];
  await Promise.all([...manifest].map(async ([role, entry]) => {
    if (prototypes.has(role)) {
      if (prototypes.get(role)) loaded.push(role);
      return;
    }
    try {
      const base = new URL(`../../${entry.file}`, import.meta.url).href;
      const gltf = await loadModelFile(base);

      // Clips shipped as separate files, which is how every Mixamo-derived pack
      // is published: one export carries the mesh and each animation is its own
      // download. They share a skeleton, so the tracks bind to this mesh as they
      // are -- no retargeting, just a merge. Each clip is renamed after its file
      // because the exporter calls them all "mixamo.com", and the state matcher
      // below reads names.
      if (Array.isArray(entry.clips)) {
        const dir = base.slice(0, base.lastIndexOf('/') + 1);
        const extra = await Promise.all(entry.clips.map(async (file) => {
          try {
            const one = await loadModelFile(dir + encodeURIComponent(file));
            const name = file.replace(/\.[^.]+$/, '');
            return one.animations.map((clip) => { clip.name = name; return clip; });
          } catch (err) {
            console.warn(`[charactermodels] ${role}: clip "${file}" -- ${err?.message ?? err}`);
            return [];
          }
        }));
        gltf.animations = [...gltf.animations, ...extra.flat()];
      }

      // Every clip, however it arrived, is re-pointed at the bones this mesh
      // actually has. Cheap, and the difference between a horde and a parade of
      // T-poses.
      const boneNames = [];
      gltf.scene.traverse((o) => { if (o.isBone) boneNames.push(o.name); });
      if (boneNames.length) {
        gltf.animations = gltf.animations
          .map((clip) => bindClipToSkeleton(clip, boneNames))
          .filter((clip) => clip.tracks.length);
      }

      // Textures the pack ships but the FBX never names.
      if (entry.texturePrefix !== undefined) {
        await applyCharacterTextures(
          gltf.scene, base.slice(0, base.lastIndexOf('/') + 1), entry.texturePrefix,
          entry.materialFallbacks);
      }
      // A character with no clips would slide around in a T-pose. The built
      // capsules at least walk, so they win.
      if (!gltf.animations?.length) {
        console.warn(`[charactermodels] ${role}: no animation clips, keeping built model`);
        prototypes.set(role, null);
        return;
      }
      // And a character with no *locomotion* clip is the same problem wearing a
      // better disguise: playState falls back to idle, so the thing crosses the
      // room standing still, breathing, arriving at your face. An idle-only
      // model is a statue, and the built zombie at least walks -- so it wins
      // too. This is the rule that keeps a plausible-looking download from
      // quietly making the horde worse.
      const names = gltf.animations.map((c) => c.name).join(' ');
      const classified = classifyCharacterClips(gltf.animations);
      if (!classified.walk && !classified.run) {
        console.warn(`[charactermodels] ${role}: no walk or run clip (has: ${names}), keeping built model`);
        prototypes.set(role, null);
        return;
      }
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const height = box.max.y - box.min.y;
      if (!(height > 0)) { prototypes.set(role, null); return; }
      // Where the feet are, in the model's own units. NOT applied here: the
      // instance is scaled to the enemy's height, and a raw-unit offset written
      // before that scale never gets scaled with it -- which for a character
      // authored in centimetres launches it a hundred metres into the air.
      prototypes.set(role, {
        scene: gltf.scene, clips: gltf.animations, height, minY: box.min.y, credit: entry,
      });
      loaded.push(role);
    } catch (err) {
      console.warn(`[charactermodels] ${role}: ${err?.message ?? err}`);
      prototypes.set(role, null);
    }
  }));
  return loaded;
}

/** Is there a usable skinned model for this enemy type? */
export function hasCharacter(typeKey) {
  const role = CHARACTER_ROLES[typeKey];
  return !!(role && prototypes.get(role));
}

/**
 * Instance a character for one spawn.
 *
 * Skinned meshes cannot be cloned with Object3D.clone -- the copy would share
 * one skeleton, so every zombie in the wave would play the same frame of the
 * same clip in the same pose. SkeletonUtils.clone rebuilds the bone hierarchy
 * per instance, which is what makes a horde look like a horde.
 *
 * @param typeKey  ENEMY_TYPES key
 * @param wantHeight  the built model's height, in metres. The contract.
 * @returns {THREE.Group|null}
 */
export function buildCharacterMesh(typeKey, wantHeight) {
  const role = CHARACTER_ROLES[typeKey];
  const proto = role && prototypes.get(role);
  if (!proto) return null;

  const group = new THREE.Group();
  const body = cloneSkinned(proto.scene);
  const k = wantHeight > 0 ? wantHeight / proto.height : 1;
  body.scale.setScalar(k);
  // Feet on the origin, in the group's units: enemy.pos.y is the ground the
  // thing stands on, so anything else has it hovering or buried.
  body.position.y = -proto.minY * k;
  body.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    // Per-instance materials, so a hit flash lights up one zombie rather than
    // the whole wave -- the same reason the built path clones its materials.
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const cloned = mats.map((m) => m.clone());
    o.material = Array.isArray(o.material) ? cloned : cloned[0];
  });
  group.add(body);

  const mixer = new THREE.AnimationMixer(body);
  const actions = {};
  const classified = classifyCharacterClips(proto.clips);
  for (const [state, clip] of Object.entries(classified)) {
    actions[state] = mixer.clipAction(clip);
  }

  // Death plays once and holds the last frame: a corpse that loops back to
  // standing is the worst possible read.
  if (actions.death) {
    actions.death.loop = THREE.LoopOnce;
    actions.death.clampWhenFinished = true;
  }
  if (actions.attack) actions.attack.loop = THREE.LoopOnce;

  // The correction lives on the inner body, not on the group: syncEnemyMesh
  // writes `group.rotation.y` every frame from the enemy's yaw, so a correction
  // stored there would be overwritten before it was ever drawn.
  body.rotation.y += FACING[role] ?? 0;

  group.userData.character = {
    mixer, actions, current: null, height: wantHeight,
    // Metres per second the walk cycle was authored for, so the caller can match
    // playback to how fast this enemy actually moves.
    // The fallback for a clip whose state is not in CLIP_SPEED at all.
    clipSpeed: CHARACTER_CLIP_SPEED.walk,
  };
  group.userData.credit = proto.credit;
  return group;
}

/**
 * Cross-fade to a state. Cheap to call every frame; ignores repeats.
 *
 * Fades rather than cuts, because these clips come from different authors and
 * different mocap takes -- their rest poses do not line up, and a hard switch
 * pops the whole skeleton.
 */
export function playState(group, state, fade = 0.18) {
  const c = group.userData.character;
  if (!c) return;
  // classifyCharacterClips aliases missing locomotion states before actions
  // are built, but retain this guard for hand-built/test characters and old
  // cached prototypes. Moving must fail to another moving action, never idle.
  const next = c.actions[state]
    || ((state === 'walk' || state === 'run' || state === 'vault')
      ? (c.actions.run || c.actions.walk || c.actions.vault)
      : null)
    || c.actions.idle;
  if (!next || next === c.current) return;
  next.reset();
  next.enabled = true;
  next.setEffectiveWeight(1);

  // A death has to finish inside the window the simulation gives the corpse.
  // Capped, because past about 3x a collapse stops reading as a body falling
  // and starts reading as a glitch.
  next.timeScale = state === 'death'
    ? Math.min(3, Math.max(1, next.getClip().duration / DEATH_WINDOW))
    : 1;
  if (c.current) {
    next.crossFadeFrom(c.current, fade, false);
  }
  next.play();
  c.current = next;
  c.state = state;
}

/**
 * Advance a character's animation.
 *
 * @param speed  metres per second this enemy is actually moving at. The clip is
 *   played proportionally, because a walk cycle authored for a stroll and played
 *   by something charging reads as skating -- the feet have to agree with the
 *   ground. Clamped, because a clip run at 4x is a blur and one run at 0.1x
 *   looks frozen rather than slow.
 */
export function updateCharacter(group, dt, speed = null) {
  const c = group.userData.character;
  if (!c) return;
  if (speed == null) { c.mixer.update(dt); return; }

  // Match the cycle to the ground using the *playing* clip's own authored
  // speed, not one global guess: a run covers far more ground per second than a
  // walk, so a single constant for both guarantees that at least one of them
  // slides. The assumed figure is only for clips with no root motion to measure.
  const clip = c.current?.getClip();
  const rate = locomotionPlaybackRate(c.state, speed, clip?.groundSpeed, c.clipSpeed);
  c.mixer.update(dt * rate);
}

/** Free a character instance's per-instance materials and mixer bindings. */
export function disposeCharacter(group) {
  const c = group.userData.character;
  if (c) { c.mixer.stopAllAction(); c.mixer.uncacheRoot(c.mixer.getRoot()); }
  group.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) m?.dispose();
  });
}
