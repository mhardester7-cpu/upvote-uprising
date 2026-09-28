// Co-op partner rendering: the name tag, and the pose driven from net state.
//
// The supplied skinned body is loaded here; soldier.js remains its complete
// procedural fallback. This file also owns everything that changes frame to
// frame -- where the limbs point, what the tag says, and how a downed partner
// reads -- so network state never leaks into either static model description.

import * as THREE from '../../vendor/three.module.js';
import { clone as cloneSkinned } from '../../vendor/utils/SkeletonUtils.js';
import { loadModelFile } from './loadmodel.js';
import { buildRifle, buildSoldierMesh, playerColor } from './soldier.js';

export { playerColor };

const PLAYER_MODEL = new URL(
  '../../assets/characters/tactical_soldier/tactical_soldier.glb', import.meta.url).href;
const PLAYER_HEIGHT = 1.8;
const REQUIRED_BONES = [
  'Hips', 'Spine', 'Spine01', 'Spine02', 'Head',
  'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot',
  'RightUpLeg', 'RightLeg', 'RightFoot',
];

let playerPrototype = null;
let playerLoadPromise = null;

/**
 * Load and validate the project owner's supplied multiplayer avatar.
 *
 * This is deliberately awaited during world setup. Remote meshes are created
 * synchronously when a network snapshot arrives, and replacing a fallback body
 * underneath a live player would pop its pose and leak its first skeleton.
 */
export function preloadRemotePlayerModel() {
  if (playerLoadPromise) return playerLoadPromise;
  playerLoadPromise = (async () => {
    try {
      const gltf = await loadModelFile(PLAYER_MODEL);
      const bones = new Set();
      let skinned = null;
      gltf.scene.traverse((o) => {
        if (o.isBone) bones.add(o.name);
        if (o.isSkinnedMesh && !skinned) skinned = o;
      });
      const missing = REQUIRED_BONES.filter((name) => !bones.has(name));
      if (!skinned) throw new Error('the file has no skinned mesh');
      if (missing.length) throw new Error(`the rig is missing ${missing.join(', ')}`);

      const walk = gltf.animations.find((clip) => /walk/i.test(clip.name))
        || gltf.animations[0];
      if (!walk?.tracks?.length) throw new Error('the rig has no usable walk animation');

      // This export has a centimetre-scaled Armature parent but metre-scaled
      // skinned vertices. Box3 applies the parent scale to the bind-pose bounds
      // even though skinning cancels it at draw time, reporting 1.8cm for a
      // visibly 1.8m person. The geometry bounds are the honest authored size.
      if (!skinned.geometry.boundingBox) skinned.geometry.computeBoundingBox();
      const box = skinned.geometry.boundingBox;
      const height = box.max.y - box.min.y;
      if (!(height > 0)) throw new Error('the model has no measurable height');

      playerPrototype = {
        scene: gltf.scene,
        walk,
        height,
        minY: box.min.y,
      };
      return true;
    } catch (err) {
      console.warn(`[remoteplayer] supplied soldier unavailable: ${err?.message ?? err}`);
      playerPrototype = null;
      return false;
    }
  })();
  return playerLoadPromise;
}

export function hasRemotePlayerModel() {
  return !!playerPrototype;
}

function realisticMaterial(material) {
  const out = material.clone();

  // The source file wires the colour atlas into emissive at full white, which
  // makes cloth and skin glow independently of the room lighting. Keep the
  // photographed atlas as albedo and restore physically plausible response.
  if ('emissiveMap' in out) out.emissiveMap = null;
  if (out.emissive) out.emissive.set(0x000000);
  if ('emissiveIntensity' in out) out.emissiveIntensity = 0;
  if ('roughness' in out) out.roughness = 0.78;
  if ('metalness' in out) out.metalness = 0.035;
  if ('specularIntensity' in out) out.specularIntensity = 0.35;
  if (out.specularColor) out.specularColor.set(0x777777);
  out.side = THREE.FrontSide;
  out.needsUpdate = true;
  return out;
}

function buildLoadedPlayer(remote) {
  if (!playerPrototype) return null;

  const group = new THREE.Group();
  group.name = 'remotePlayer';
  const body = cloneSkinned(playerPrototype.scene);
  const scale = PLAYER_HEIGHT / playerPrototype.height;
  body.scale.setScalar(scale);
  body.position.y = -playerPrototype.minY * scale;

  const materials = new Set();
  body.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const source = Array.isArray(o.material) ? o.material : [o.material];
    const cloned = source.map((m) => realisticMaterial(m));
    for (const m of cloned) materials.add(m);
    o.material = Array.isArray(o.material) ? cloned : cloned[0];
  });
  group.add(body);

  const mixer = new THREE.AnimationMixer(body);
  const walk = mixer.clipAction(playerPrototype.walk);
  walk.setLoop(THREE.LoopRepeat, Infinity);
  walk.play();

  const bones = {};
  for (const name of REQUIRED_BONES) bones[name] = body.getObjectByName(name);

  // The generated clip contains a clean upright key near its first authored
  // frame but badly twists the torso later in the cycle. Use that trustworthy
  // key as the base and drive hands/feet through the real skeleton below.
  const baseTime = Math.min(0.034, playerPrototype.walk.duration * 0.04);
  mixer.setTime(baseTime);
  group.updateMatrixWorld(true);
  const leftAnkle = group.worldToLocal(
    bones.LeftFoot.getWorldPosition(new THREE.Vector3()));
  const rightAnkle = group.worldToLocal(
    bones.RightFoot.getWorldPosition(new THREE.Vector3()));
  const ankleY = Math.min(leftAnkle.y, rightAnkle.y);

  // Preserve the strong facing cue the previous avatar had. The network does
  // not transmit the equipped gun yet, so every partner carries this neutral
  // service rifle rather than guessing a weapon the other client may not own.
  const color = playerColor(remote.id);
  const accent = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.28,
    roughness: 0.42,
    metalness: 0.05,
  });
  materials.add(accent);
  const gunMount = new THREE.Group();
  gunMount.name = 'gunMount';
  gunMount.position.set(0.13, 1.22, 0.14);
  // buildRifle points down -Z; the avatar contract faces +Z.
  gunMount.rotation.y = Math.PI;
  const rifle = buildRifle(1, accent);
  rifle.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    const many = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of many) materials.add(m);
  });
  gunMount.add(rifle);
  const rightGrip = new THREE.Object3D();
  rightGrip.name = 'rightGrip';
  rightGrip.position.set(0, -0.10, 0.13);
  gunMount.add(rightGrip);
  const leftGrip = new THREE.Object3D();
  leftGrip.name = 'leftGrip';
  leftGrip.position.set(-0.08, -0.02, -0.24);
  gunMount.add(leftGrip);
  group.add(gunMount);

  group.userData.playerRig = {
    body, mixer, walk, bones, gunMount, rightGrip, leftGrip,
    duration: playerPrototype.walk.duration,
    baseTime,
    feet: {
      left: new THREE.Vector3(leftAnkle.x, ankleY, leftAnkle.z),
      right: new THREE.Vector3(rightAnkle.x, ankleY, rightAnkle.z),
    },
  };
  group.userData.color = color;
  group.userData.materials = [...materials];
  return group;
}

/**
 * Name tags are drawn to a canvas and shown on a sprite. A sprite always faces
 * the camera for free, which is exactly the behaviour a floating label wants.
 */
/** Paint the tag's text. Cheap enough to redo whenever the label changes. */
function paintNameTag(canvas, name, color, down) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const label = down ? `${name} - DOWN` : name;
  ctx.font = 'bold 34px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Outline first, fill second: a dark halo keeps the text legible against
  // both bright sky and dark terrain without needing a background plate.
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.strokeText(label, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = down ? '#ff5a4d' : '#' + color.toString(16).padStart(6, '0');
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
}

function buildNameTag(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;      // room for the longest name plus " - DOWN"
  canvas.height = 64;
  paintNameTag(canvas, name, color, false);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    depthTest: false,      // stays readable through terrain, like a HUD marker
    transparent: true,
    // Sprites take no light, but fog still applies -- and would grey a distant
    // tag out to nothing well before the distance cap below.
    fog: false,
  }));
  sprite.renderOrder = 999;
  sprite.userData.texture = tex;
  sprite.userData.canvas = canvas;
  sprite.userData.name = name;
  sprite.userData.color = color;
  sprite.userData.down = false;
  return sprite;
}

/** Tag size in world units at TAG_REFERENCE_DIST. 8:1, matching the canvas. */
const TAG_W = 4.6;
const TAG_H = 0.575;
/**
 * Distance at which a tag is drawn at its base size. Nearer than this it is
 * held still rather than ballooning in your face; further away it grows in
 * step with distance, which keeps it a near-constant size on screen.
 */
const TAG_REFERENCE_DIST = 14;
/**
 * Past this the tag stops growing. The arena is 160 blocks across, so this
 * covers the whole map -- a partner anywhere on it keeps a readable name,
 * which is the entire point of the tag.
 */
const TAG_MAX_DIST = 170;

export function buildRemotePlayerMesh(remote) {
  // The built soldier remains a deliberately complete fallback for a corrupt
  // or missing binary. Normal builds have already awaited preload and take the
  // skinned path here.
  const g = buildLoadedPlayer(remote) || buildSoldierMesh(remote);
  const tag = buildNameTag(remote.name, g.userData.color);
  tag.position.y = 2.22;
  g.add(tag);
  g.userData.tag = tag;
  return g;
}

export function disposeRemotePlayerMesh(group) {
  if (!group) return;
  const rig = group.userData.playerRig;
  if (rig) {
    rig.mixer.stopAllAction();
    rig.mixer.uncacheRoot(rig.body);
  }
  for (const m of new Set(group.userData.materials || [])) m.dispose();
  const tag = group.userData.tag;
  if (tag) {
    tag.userData.texture?.dispose();
    tag.material.dispose();
  }
}

const IK_JOINT = new THREE.Vector3();
const IK_END = new THREE.Vector3();
const IK_TO_END = new THREE.Vector3();
const IK_TO_TARGET = new THREE.Vector3();
const IK_DELTA = new THREE.Quaternion();
const IK_LIMITED = new THREE.Quaternion();
const IK_WORLD = new THREE.Quaternion();
const IK_PARENT = new THREE.Quaternion();
const IK_DESIRED = new THREE.Quaternion();
const IK_IDENTITY = new THREE.Quaternion();

/** Small CCD solve: rotate real arm/leg bones until the end joint meets a socket. */
function solveLimb(end, joints, target, iterations = 4, maxTurn = 0.48) {
  for (let pass = 0; pass < iterations; pass++) {
    for (const joint of joints) {
      joint.getWorldPosition(IK_JOINT);
      end.getWorldPosition(IK_END);
      IK_TO_END.subVectors(IK_END, IK_JOINT);
      IK_TO_TARGET.subVectors(target, IK_JOINT);
      if (IK_TO_END.lengthSq() < 1e-8 || IK_TO_TARGET.lengthSq() < 1e-8) continue;
      IK_TO_END.normalize();
      IK_TO_TARGET.normalize();
      IK_DELTA.setFromUnitVectors(IK_TO_END, IK_TO_TARGET);
      const angle = 2 * Math.acos(Math.min(1, Math.abs(IK_DELTA.w)));
      if (angle > maxTurn) {
        IK_LIMITED.copy(IK_IDENTITY).slerp(IK_DELTA, maxTurn / angle);
      } else {
        IK_LIMITED.copy(IK_DELTA);
      }
      joint.getWorldQuaternion(IK_WORLD);
      joint.parent.getWorldQuaternion(IK_PARENT);
      IK_DESIRED.copy(IK_LIMITED).multiply(IK_WORLD);
      joint.quaternion.copy(IK_PARENT.invert().multiply(IK_DESIRED));
      joint.updateMatrixWorld(true);
    }
  }
}

function syncLoadedPlayer(remote) {
  const g = remote.group;
  const rig = g.userData.playerRig;
  const hp = Math.max(-0.7, Math.min(0.7, remote.pitch || 0));

  // Reset to the clip's one clean upright key. Later frames in this generated
  // source over-rotate the spine and hips, so locomotion is solved through the
  // actual leg rig from this stable authored pose instead of playing those bad
  // extremes verbatim.
  rig.mixer.setTime(rig.baseTime);
  g.rotation.x = 0;
  rig.gunMount.position.y = 1.22;
  rig.gunMount.rotation.x = -hp;
  g.updateMatrixWorld(true);

  // Feet follow compact, grounded ellipses. Network walkPhase is distance-
  // driven, so the cycle remains in step even when packet timing varies.
  const phase = remote.moving ? Math.sin(remote.walkPhase) : 0;
  const stride = remote.moving ? 0.20 : 0;
  const liftLeft = remote.moving ? Math.max(0, phase) * 0.105 : 0;
  const liftRight = remote.moving ? Math.max(0, -phase) * 0.105 : 0;
  const leftTarget = rig.feet.left.clone();
  leftTarget.z += phase * stride;
  leftTarget.y += liftLeft;
  const rightTarget = rig.feet.right.clone();
  rightTarget.z -= phase * stride;
  rightTarget.y += liftRight;
  g.localToWorld(leftTarget);
  g.localToWorld(rightTarget);
  solveLimb(rig.bones.LeftFoot,
    [rig.bones.LeftLeg, rig.bones.LeftUpLeg], leftTarget, 4, 0.40);
  solveLimb(rig.bones.RightFoot,
    [rig.bones.RightLeg, rig.bones.RightUpLeg], rightTarget, 4, 0.40);

  // The weapon owns two explicit grip sockets. Solving each hand to its socket
  // is stable across pitch and walk poses and, unlike hard-coded Euler angles,
  // respects this imported rig's non-standard bone axes.
  rig.gunMount.updateMatrixWorld(true);
  solveLimb(rig.bones.RightHand,
    [rig.bones.RightForeArm, rig.bones.RightArm],
    rig.rightGrip.getWorldPosition(new THREE.Vector3()), 5, 0.42);
  solveLimb(rig.bones.LeftHand,
    [rig.bones.LeftForeArm, rig.bones.LeftArm],
    rig.leftGrip.getWorldPosition(new THREE.Vector3()), 5, 0.42);

  if (remote.down) {
    // Tip the fully posed body rather than letting its legs continue cycling.
    // The rifle stays in both hands and the label is counter-positioned below.
    g.rotation.x = Math.PI * 0.5;
    g.position.y = remote.pos.y + 0.25;
  }
}

/**
 * Push a remote player's networked state into their avatar.
 *
 * @param showTag false in a free-for-all. The tag is drawn with depth testing
 *   off so a partner stays findable through a hill, which is exactly right when
 *   you are trying to reach them and exactly wrong when they are hunting you:
 *   it hands both duellists a name floating over every wall on the map, and
 *   there is no version of a 1v1 that survives both players always knowing
 *   where the other is standing.
 */
export function syncRemotePlayerMesh(remote, camera, showTag = true) {
  const g = remote.group;
  if (!g) return;
  if (g.userData.tag) g.userData.tag.visible = showTag;

  g.visible = remote.alive;
  if (!remote.alive) return;

  g.position.set(remote.pos.x, remote.pos.y, remote.pos.z);
  // The model is built facing +Z (the enemy convention), but the player camera
  // faces -Z at yaw 0 -- so the body needs a half turn or every partner walks
  // around backwards: visor on the back of the head, rifle behind them, and
  // the shoulder straps reading as a second pair of arms.
  g.rotation.y = remote.yaw + Math.PI;

  if (g.userData.playerRig) {
    syncLoadedPlayer(remote);
  } else {

  const {
    legL, legR, armL, armR, head, visor, helmet, gunMount, foreL, foreR,
  } = g.userData.limbs;

  if (remote.down) {
    // Face down, arms out. Unmistakable from any angle, which is the whole
    // point: a partner who needs picking up has to be findable in a firefight.
    g.rotation.x = Math.PI * 0.5;
    g.position.y = remote.pos.y + 0.25;
    legL.rotation.x = legR.rotation.x = 0;
    legL.rotation.z = -0.2;
    legR.rotation.z = 0.2;
    armL.rotation.set(-0.3, 0, -0.9);
    armR.rotation.set(-0.3, 0, 0.9);
    if (foreL) foreL.rotation.set(-0.5, 0, 0);
    if (foreR) foreR.rotation.set(-0.5, 0, 0);
  } else {
    g.rotation.x = 0;
    const swing = Math.sin(remote.walkPhase) * (remote.moving ? 0.75 : 0.06);
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    legL.rotation.z = 0;
    legR.rotation.z = 0;

    // Both arms come up to the rifle and stay there. A soldier at the ready
    // does not swing their arms, and the two-handed hold is what makes the
    // weapon read as aimed rather than carried.
    // Clamped pitch, used by the head, the weapon mount and the arms alike.
    const hp = Math.max(-0.7, Math.min(0.7, remote.pitch));

    // Upper arms angled down and forward, elbows bent up to the weapon. The
    // bend is most of what separates "carrying a rifle" from "reaching".
    const p = Math.max(-0.9, Math.min(0.9, -remote.pitch));
    armR.rotation.set(-Math.PI * 0.18 + p * 0.6, -0.20, 0.26);
    armL.rotation.set(-Math.PI * 0.22 + p * 0.6, 0.34, -0.34);
    if (foreR) foreR.rotation.set(-Math.PI * 0.36, 0, -0.18);
    if (foreL) foreL.rotation.set(-Math.PI * 0.44, 0, 0.30);
    // The weapon aims where they are looking; the arms only have to look like
    // they are holding it.
    // Muzzle points along local +Z; tipping it up needs negative X rotation
    // when the player is looking up (positive pitch).
    if (gunMount) gunMount.rotation.x = -hp;

    // The head tracks pitch within a neck's worth of travel. Negative,
    // because for a +Z-forward model a positive X rotation tips the face
    // *down*, while positive player pitch means looking up.
    head.rotation.x = -hp;
    if (visor) visor.rotation.x = -hp;
    if (helmet) helmet.rotation.x = -hp * 0.8;
  }
  }

  // The tag is the only way to tell partners apart at a glance, so it is sized
  // to stay readable rather than faded out with distance. The previous build
  // hid it entirely past 70m and had it half-faded well before that, which on
  // a 160-block map meant a partner was usually anonymous.
  const tag = g.userData.tag;
  if (tag && camera) {
    if (tag.userData.down !== remote.down) {
      tag.userData.down = remote.down;
      paintNameTag(tag.userData.canvas, tag.userData.name, tag.userData.color, remote.down);
      tag.userData.texture.needsUpdate = true;
    }

    const d = camera.position.distanceTo(g.position);
    // Scale with distance so the label holds a near-constant screen size: a
    // sprite's apparent size is scale/distance, so scale must track distance.
    const k = Math.min(Math.max(d, TAG_REFERENCE_DIST), TAG_MAX_DIST) / TAG_REFERENCE_DIST;
    tag.scale.set(TAG_W * k, TAG_H * k, 1);
    tag.material.opacity = 1;

    // The group tips over when downed; counter-position so the tag stays above.
    // The offset scales too, or a distant tag ends up planted in the ground.
    tag.position.set(0, remote.down ? 0.6 : 2.22, remote.down ? -1.4 : 0);
  }
}
