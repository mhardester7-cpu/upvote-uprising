import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';

import { AudioSystem, DRUMMER_BPM } from '../src/engine/audio.js';
import { Player } from '../src/entities/player.js';
import {
  BANANA_RAIN_COUNT, createDrummerTower, DRUMMER_BPM as VISUAL_BPM, DRUM_KIT_MODEL_URL,
  DRUM_KIT_STAGE_YAW, GORILLA_FUR_TEXTURE_URL, GORILLA_MODEL_URL, VENDING_BANANA_MODEL_URL,
  VENDING_MACHINE_MODEL_URL, VENDING_SHAKE_SECONDS,
} from '../src/render/drummertower.js';
import {
  onDrummerTowerDeck, PROP_DRUMMER_TOWER, TOWER_DECK_HEIGHT, TOWER_DECK_SIZE,
} from '../src/world/drummertower.js';
import { MAP_ARENA, World } from '../src/world/world.js';

function generated(seed = 20260725, opts = {}) {
  const world = new World(seed, opts);
  for (const _ of world.generate()) { /* finish deterministic generation */ }
  return world;
}

const held = (action) => ({
  moveAxis: null,
  actionDown: (candidate) => candidate === action,
  actionPressed: () => false,
});

function riggedGorillaFixture() {
  const scene = new THREE.Group();
  const root = new THREE.Bone(); root.name = 'GorillaRigRoot';
  const bones = [root];
  for (const side of ['Left', 'Right']) {
    const upper = new THREE.Bone(); upper.name = `Gorilla${side}UpperArm`;
    const fore = new THREE.Bone(); fore.name = `Gorilla${side}ForeArm`;
    const hand = new THREE.Bone(); hand.name = `Gorilla${side}Hand`;
    root.add(upper); upper.add(fore); fore.add(hand);
    bones.push(upper, fore, hand);
  }
  scene.add(root);
  const geometry = new THREE.BoxGeometry(1, 2, 1);
  const count = geometry.attributes.position.count;
  const joints = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(joints, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const gorilla = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  gorilla.name = 'anatomical-gorilla';
  scene.add(gorilla);
  scene.updateMatrixWorld(true);
  gorilla.bind(new THREE.Skeleton(bones));
  return scene;
}

test('a tall rhythm tower occupies the centre of every co-op complex', () => {
  for (const seed of [1, 42, 1337, 31337, 20260725]) {
    const world = generated(seed);
    const tower = world.drummerTower;
    assert.ok(tower, `seed ${seed}: missing rhythm tower`);
    assert.equal(tower.height, TOWER_DECK_HEIGHT);
    assert.equal(tower.deckSize, TOWER_DECK_SIZE);
    assert.ok(tower.deckSize >= 9.5, 'the performance platform is still too cramped');
    assert.ok(tower.deckY - tower.baseY >= 24, `seed ${seed}: tower is not tall`);
    assert.ok(Math.hypot(tower.x - world.size / 2, tower.z - world.size / 2) < world.size * .1,
      `seed ${seed}: tower is not central`);

    const room = world.plan.rooms.find((candidate) => candidate.id === tower.room);
    assert.equal(room?.outdoor, true, `seed ${seed}: a roof blocks the tower`);
    assert.equal(room?.role?.id, 'rhythm_tower');
    assert.notEqual(room.id, world.plan.start, 'tower replaced the onboarding room');
    assert.notEqual(room.id, world.plan.dinosaurFactoryRoom, 'tower replaced the dinosaur factory');
    assert.notEqual(room.id, world.plan.reverseAquariumRoom, 'tower replaced human observation');

    const pieces = world.props.filter((prop) => prop.type === PROP_DRUMMER_TOWER);
    assert.equal(pieces.filter((prop) => prop.towerPart === 'leg').length, 4);
    assert.equal(pieces.filter((prop) => prop.towerPart.startsWith('deck')).length, 3,
      'the deck must be split around a real hatch');
    assert.ok(pieces.some((prop) => prop.towerPart.startsWith('rail')),
      'the rooftop has no fall protection');
    const kitCollider = pieces.find((prop) => prop.towerPart === 'drum-kit')?.collider;
    const drummerCollider = pieces.find((prop) => prop.towerPart === 'drummer')?.collider;
    const vendingCollider = pieces
      .find((prop) => prop.towerPart === 'banana-vending-machine')?.collider;
    assert.ok(kitCollider && drummerCollider, 'performance collision bounds are missing');
    assert.ok(vendingCollider, 'banana vending machine has no physical footprint');
    assert.ok(drummerCollider.maxZ < kitCollider.minZ - 0.25,
      'the drummer and kit bounds overlap before animation even starts');
    assert.ok(vendingCollider.minX > drummerCollider.maxX + 0.25,
      'the banana machine is not actually beside and clear of the gorilla');
    const railInset = tower.deckSize / 2 - 0.2;
    assert.ok(drummerCollider.minZ > tower.z - railInset,
      'the enlarged drummer bounds still enter the north railing');
    assert.ok(kitCollider.maxZ < tower.z + railInset,
      'the kit still enters the south railing');
    assert.ok(vendingCollider.maxX < tower.x + railInset,
      'the banana machine enters the east railing');
  }
});

test('the versus arena does not gain an asymmetric co-op landmark', () => {
  const world = generated(20260725, { map: MAP_ARENA });
  assert.equal(world.drummerTower, null);
  assert.equal(world.props.some((prop) => prop.type === PROP_DRUMMER_TOWER), false);
});

test('the authored ladder carries a player to the deck and back down', () => {
  const world = generated();
  const ladder = world.drummerTower.ladder;
  const player = new Player(world);
  player.spawn({
    x: ladder.x,
    y: world.drummerTower.baseY,
    z: ladder.z + 0.65,
  });

  assert.equal(player.tryUseLadder(), true, 'ladder could not be mounted at its base');
  assert.equal(player.climbing, true);
  for (let tick = 0; tick < 540 && player.climbing; tick++) {
    player.update(1 / 60, held('forward'));
  }
  assert.equal(player.climbing, false, 'player never cleared the top of the ladder');
  assert.ok(Math.abs(player.pos.y - ladder.deckY) < 0.02,
    `ladder stopped at ${player.pos.y}, deck is ${ladder.deckY}`);
  assert.ok(Math.abs(world.supportHeight(
    player.pos.x, player.pos.z, player.pos.y, player.half, 0.1,
  ) - ladder.deckY) < 0.02, 'top dismount is not standing on the deck');

  player.ladderCooldown = 0;
  assert.equal(player.tryUseLadder(), true, 'ladder cannot be mounted from the roof');
  for (let tick = 0; tick < 620 && player.climbing; tick++) {
    player.update(1 / 60, held('back'));
  }
  assert.equal(player.climbing, false, 'player never reached the ladder base');
  assert.ok(Math.abs(player.pos.y - ladder.minY) < 0.02);
});

test('the tower performance is audible only after reaching the rooftop deck', () => {
  const tower = generated().drummerTower;
  assert.equal(onDrummerTowerDeck(tower, {
    x: tower.x, y: tower.baseY, z: tower.z,
  }), false, 'the drums leaked to ground level');
  assert.equal(onDrummerTowerDeck(tower, {
    x: tower.ladder.x, y: tower.deckY - 0.4, z: tower.ladder.z,
  }), false, 'the drums started before the ladder was cleared');
  assert.equal(onDrummerTowerDeck(tower, {
    x: tower.ladder.topX, y: tower.deckY, z: tower.ladder.topZ,
  }), true, 'the performance did not start on the top dismount');
  assert.equal(onDrummerTowerDeck(tower, {
    x: tower.x + tower.deckSize, y: tower.deckY, z: tower.z,
  }), false, 'the rooftop mix leaked beyond the tower rails');
});

test('the 3D performance is present and animated at the authored rooftop point', () => {
  const world = generated();
  const renderer = createDrummerTower(world);
  assert.ok(renderer?.mesh, 'tower renderer was not created');
  assert.ok(renderer.gorilla && renderer.kit, 'gorilla or drum kit is absent');
  assert.ok(renderer.vendingMachine, 'banana vending machine is absent');
  assert.equal(renderer.vendingMachine.name, 'banana-vending-machine-fallback');
  const before = renderer.leftArm.rotation.x;
  const speakerScales = renderer.speakerCones.map((cone) => cone.scale.clone());
  for (let i = 0; i < 12; i++) renderer.update(1 / 60);
  assert.notEqual(renderer.leftArm.rotation.x, before, 'drummer arms do not animate');
  assert.ok(renderer.proceduralGorilla.getObjectByName('gorilla-left-shoulder-seal'),
    'left fallback downstroke can open a hole at the shoulder');
  assert.ok(renderer.proceduralGorilla.getObjectByName('gorilla-right-shoulder-seal'),
    'right fallback downstroke can open a hole at the shoulder');
  assert.deepEqual(renderer.speakerCones.map((cone) => cone.scale), speakerScales,
    'speaker cones should remain static at their authored scale');
  assert.equal(VISUAL_BPM, DRUMMER_BPM, 'visible hits and audible hits use different tempos');
  renderer.dispose();
});

test('bundled CC0 models replace the procedural rooftop fallbacks', async () => {
  const world = generated();
  const requested = [];
  const requestedTextures = [];
  const furTexture = new THREE.Texture();
  const loadModel = async (url) => {
    requested.push(url);
    const scene = new THREE.Group();
    if (url === GORILLA_MODEL_URL) {
      return { scene: riggedGorillaFixture(), animations: [] };
    } else if (url === DRUM_KIT_MODEL_URL) {
      for (const name of ['Plane', 'bassdrum', 'hw_snare002']) {
        const part = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(),
        );
        part.name = name;
        scene.add(part);
      }
    } else if (url === VENDING_MACHINE_MODEL_URL) {
      const drink = new THREE.Mesh(
        new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial(),
      );
      drink.name = 'Drink_Vending_Machine';
      scene.add(drink);
      const food = new THREE.Mesh(
        new THREE.BoxGeometry(2.47, 2.51, 5.45), [
          new THREE.MeshStandardMaterial({ color: 0xffffff }),
          new THREE.MeshStandardMaterial({ color: 0x0f0f0f }),
          new THREE.MeshStandardMaterial({ color: 0x0fcc0f }),
        ],
      );
      food.name = 'Food_Vending_Machine';
      scene.add(food);
    } else if (url === VENDING_BANANA_MODEL_URL) {
      for (const name of ['Model_1', 'Model_2', 'Model_3']) {
        const part = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(),
        );
        part.name = name;
        scene.add(part);
      }
    }
    return { scene, animations: [] };
  };

  const renderer = createDrummerTower(world, {
    loadModel,
    loadTexture: async (url) => {
      requestedTextures.push(url);
      return furTexture;
    },
  });
  await renderer.ready;
  assert.deepEqual(new Set(requested), new Set([
    GORILLA_MODEL_URL, DRUM_KIT_MODEL_URL,
    VENDING_MACHINE_MODEL_URL, VENDING_BANANA_MODEL_URL,
  ]));
  assert.deepEqual(requestedTextures, [GORILLA_FUR_TEXTURE_URL]);
  assert.equal(renderer.proceduralGorilla.visible, false);
  assert.equal(renderer.proceduralKit.visible, false);
  assert.equal(renderer.gorilla.name, 'cc0-realistic-gorilla');
  assert.equal(renderer.kit.name, 'cc0-realistic-drum-kit');
  assert.equal(renderer.vendingMachine.name, 'cc0-banana-vending-machine');
  assert.equal(renderer.proceduralVendingMachine.visible, false);
  assert.equal(renderer.realVendingMachine.name, 'Food_Vending_Machine');
  assert.equal(renderer.vendingBananas.children.length, 4);
  assert.ok(renderer.vendingBananas.children.every((banana) => (
    banana.getObjectByName('Model_1') && !banana.getObjectByName('Model_3')
  )), 'machine stock is not made from the intact CC0 banana geometry');
  assert.ok(renderer.gorillaRig, 'the sourced gorilla did not expose a programmable armature');
  assert.ok(renderer.leftArm.isBone && renderer.rightArm.isBone,
    'drumming still uses detached stick pivots instead of arm bones');
  assert.ok(renderer.realGorilla.getObjectByProperty('isSkinnedMesh', true),
    'the gorilla geometry is not bound to its armature');
  assert.equal(renderer.gorillaRig.leftStick.parent, renderer.gorillaRig.leftHand,
    'the left stick is not held by the animated hand bone');
  assert.equal(renderer.gorillaRig.rightStick.parent, renderer.gorillaRig.rightHand,
    'the right stick is not held by the animated hand bone');
  assert.equal(renderer.gorillaRig.leftStick.geometry.type, 'LatheGeometry',
    'the left drumstick is still a plain cylinder');
  renderer.gorillaRig.leftStick.geometry.computeBoundingBox();
  const stickBounds = renderer.gorillaRig.leftStick.geometry.boundingBox;
  assert.ok(stickBounds.max.y - stickBounds.min.y > 1.05, 'drumstick is too short');
  assert.ok(stickBounds.max.x - stickBounds.min.x < 0.07, 'drumstick is implausibly thick');
  assert.equal(renderer.mats.furReal.map, furTexture,
    'the sourced fur photograph was not mapped onto the gorilla');
  assert.equal(renderer.mats.furReal.bumpMap, furTexture,
    'the fur photograph does not contribute surface relief');
  assert.equal(renderer.mats.furReal.side, THREE.DoubleSide,
    'close cameras can still see through back-facing gorilla triangles');
  for (const joint of ['left-shoulder', 'right-shoulder', 'left-elbow', 'right-elbow',
    'left-wrist', 'right-wrist']) {
    assert.ok(renderer.realGorilla.getObjectByName(`gorilla-${joint}-seal`),
      `${joint} opens a visible hole during the drumming animation`);
  }
  assert.ok(renderer.kit.position.z - renderer.gorilla.position.z > 2.2,
    'the performer is still interpenetrating the kit');
  assert.equal(renderer.kit.rotation.y, DRUM_KIT_STAGE_YAW,
    'the imported drum kit is facing away from the player approach');
  assert.equal(renderer.realDrumKit.getObjectByName('Plane').visible, false,
    'the source preview floor should not cover the rooftop');
  assert.equal(renderer.realDrumKit.getObjectByName('hw_snare002').material, renderer.mats.chrome);
  assert.equal(renderer.realDrumKit.getObjectByName('bassdrum').material, renderer.mats.drumRed);

  const vending = world.drummerTower.bananaVending;
  assert.equal(renderer.vendingInRange({ alive: true, pos: {
    x: vending.x, y: world.drummerTower.baseY, z: vending.z,
  } }), false, 'the ground floor can trigger a machine on the roof');
  assert.equal(renderer.vendingInRange({ alive: true, pos: {
    x: vending.x, y: vending.y, z: vending.z + 1.4,
  } }), true, 'the machine cannot be reached from its front');
  assert.equal(renderer.activateVendingMachine(), true);
  assert.equal(renderer.activateVendingMachine(), false, 'the one-shot event can be retriggered');
  const restPosition = renderer.vendingMachine.position.clone();
  const firstEvents = renderer.update(0.12);
  assert.ok(firstEvents.some((event) => event.type === 'vending-rattle'));
  assert.notDeepEqual(renderer.vendingMachine.position, restPosition,
    'the cabinet does not visibly shake before exploding');

  const events = [...firstEvents];
  for (let elapsed = 0; elapsed <= VENDING_SHAKE_SECONDS + 0.2; elapsed += 0.1) {
    events.push(...renderer.update(0.1));
  }
  assert.equal(events.filter((event) => event.type === 'vending-explosion').length, 1);
  assert.equal(renderer.vendingState, 'exploded');
  assert.equal(renderer.vendingMachine.visible, false);
  assert.equal(renderer.vendingDecor.visible, false);
  assert.equal(renderer.vendingDebris.length, 18);
  assert.equal(renderer.bananaRain.length, BANANA_RAIN_COUNT);
  assert.equal(renderer.bananaRainMeshes.length, 2);
  assert.ok(renderer.bananaRainMeshes.every((rain) => (
    rain.isInstancedMesh && rain.count === BANANA_RAIN_COUNT && rain.visible
  )), 'hundreds of real bananas are not drawn through instancing');
  assert.equal(
    world.props.some((prop) => prop.towerPart === 'banana-vending-machine'), false,
    'the exploded cabinet left an invisible collider behind',
  );
  const hidden = new THREE.Matrix4();
  renderer.bananaRainMeshes[0].getMatrixAt(0, hidden);
  renderer.update(0.8);
  const falling = new THREE.Matrix4();
  renderer.bananaRainMeshes[0].getMatrixAt(0, falling);
  assert.notDeepEqual(falling.elements, hidden.elements, 'banana instances never enter the storm');

  // A banana that misses the rooftop must stop on the actual terrain rather
  // than continuing below the world with its origin embedded in the ground.
  const groundBanana = renderer.bananaRain[0];
  groundBanana.delay = 0;
  groundBanana.revealed = true;
  groundBanana.settled = false;
  groundBanana.bounces = 3;
  groundBanana.position.set(
    world.drummerTower.x + world.drummerTower.deckSize,
    world.drummerTower.baseY + 0.2,
    world.drummerTower.z,
  );
  groundBanana.velocity.set(0, -8, 0);
  renderer._updateVending(0.1);
  assert.equal(groundBanana.settled, true);
  assert.ok(groundBanana.position.y > world.heightAt(
    groundBanana.position.x, groundBanana.position.z,
  ), 'the settled banana is still embedded in the terrain');

  for (const banana of renderer.bananaRain) {
    banana.revealed = true;
    banana.settled = true;
  }
  const settledVersion = renderer.bananaRainMeshes[0].instanceMatrix.version;
  renderer._updateVending(0.1);
  assert.equal(renderer.bananaRainMeshes[0].instanceMatrix.version, settledVersion,
    'the settled storm still uploads hundreds of transforms every frame');
  assert.equal(renderer.activateVendingMachine(), false, 'the exploded machine respawned');
  world.resetRunState();
  renderer.reset();
  assert.equal(renderer.vendingState, 'idle');
  assert.equal(renderer.vendingMachine.visible, true);
  assert.equal(renderer.vendingDecor.visible, true);
  assert.ok(renderer.bananaRainMeshes.every((rain) => !rain.visible));
  assert.ok(world.props.some((prop) => prop.towerPart === 'banana-vending-machine'),
    'a new run did not restore the machine collider');

  const before = renderer.leftArm.rotation.x;
  for (let i = 0; i < 12; i++) renderer.update(1 / 60);
  assert.notEqual(renderer.leftArm.rotation.x, before, 'real gorilla upper arms do not animate');
  assert.notEqual(renderer.gorillaRig.leftFore.rotation.x, 0,
    'real gorilla forearms do not articulate at the elbow');
  renderer.dispose();
});

test('a failed model load leaves a complete animated fallback', async () => {
  const world = generated();
  const failures = [];
  const renderer = createDrummerTower(world, {
    loadModel: async () => { throw new Error('offline'); },
    onAssetError: (label) => failures.push(label),
  });
  await renderer.ready;
  assert.deepEqual(new Set(failures), new Set([
    'gorilla', 'drum kit', 'banana vending machine', 'vending bananas',
  ]));
  assert.equal(renderer.proceduralGorilla.visible, true);
  assert.equal(renderer.proceduralKit.visible, true);
  assert.equal(renderer.proceduralVendingMachine.visible, true);
  assert.equal(renderer.gorilla, renderer.proceduralGorilla);
  assert.equal(renderer.kit, renderer.proceduralKit);
  renderer.dispose();
});

class Param {
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
  exponentialRampToValueAtTime(value) { this.value = value; }
}

class Node {
  constructor(kind) {
    this.kind = kind;
    this.connections = [];
    this.gain = new Param();
    this.frequency = new Param();
    this.Q = new Param();
    this.positionX = new Param(); this.positionY = new Param(); this.positionZ = new Param();
    this.playbackRate = new Param(1);
  }
  connect(node) { this.connections.push(node); return node; }
  start() {}
  stop() {}
}

test('the rooftop drummer emits a repeating distance-limited spatial kit', () => {
  const nodes = [];
  const make = (kind) => { const node = new Node(kind); nodes.push(node); return node; };
  const audio = new AudioSystem();
  audio.ctx = {
    currentTime: 4,
    createGain: () => make('gain'),
    createOscillator: () => make('oscillator'),
    createBiquadFilter: () => make('filter'),
    createBufferSource: () => make('buffer'),
    createPanner: () => make('panner'),
  };
  audio.master = make('master');
  audio.noiseBuffer = {};

  const source = { x: 64, y: 34, z: 64 };
  assert.equal(audio.updateDrummer(source, 0.15, true), true);
  assert.ok(nodes.some((node) => node.kind === 'oscillator'), 'kit has no tonal drum body');
  assert.ok(nodes.some((node) => node.kind === 'buffer'), 'kit has no snare/cymbal noise');
  const panners = nodes.filter((node) => node.kind === 'panner');
  assert.ok(panners.length >= 3, 'drum voices are not spatial');
  assert.ok(panners.every((node) => node.maxDistance >= 118 && node.maxDistance <= 150));
  assert.ok(panners.every((node) => node.positionY.value === source.y));
  audio.stopDrummer();
  assert.equal(audio.drummerActive, false);
});
