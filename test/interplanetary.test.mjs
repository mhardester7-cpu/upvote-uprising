import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from '../vendor/three.module.js';
import {
  BANANA_DAMAGE,
  BANANA_DURATION,
  BANANA_FIRE_COOLDOWN,
  BANANA_THROW_DISTANCE,
  InterplanetaryTravel,
  JOHN_PORK_PLANET,
  JOHN_PORK_TEXTURE,
  PLANETS,
  SNAIL_KILL_DISTANCE,
  SNAIL_GROUND_OFFSET,
  SNAIL_MODEL_LENGTH,
  SNAIL_ASSET,
  SNAIL_START_MIN_DISTANCE,
  SNAIL_WARNING_DISTANCE,
  SNAIL_SPEED,
  SNAIL_VISUAL_SCALE,
  installRealisticSnail,
  measureRealisticSnailForward,
  prepareRealisticSnail,
  snailGroundHeight,
  snailSurfaceOrientation,
} from '../src/game/interplanetary.js';
import { World } from '../src/world/world.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function input(down = [], pressed = []) {
  return { actionDown: (a) => down.includes(a), actionPressed: (a) => pressed.includes(a) };
}

function harness() {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 1, 100);
  const world = {
    size: 128, heightAt: () => 0,
    inBounds: (x, z) => x > 0 && z > 0 && x < 128 && z < 128,
    blocksAt: () => false,
    plan: {
      start: 'spawn-room',
      rooms: [{
        id: 'spawn-room', minX: 106, maxX: 127, minZ: 106, maxZ: 127,
        floorY: 0,
      }],
    },
  };
  const player = {
    pos: { x: 120, y: 0, z: 120 }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
    alive: true,
    getLookDir(out) {
      const cp = Math.cos(this.pitch);
      out.x = -Math.sin(this.yaw) * cp; out.y = Math.sin(this.pitch); out.z = -Math.cos(this.yaw) * cp;
      return out;
    },
    spawn(p) { this.pos = { ...p }; this.vel = { x: 0, y: 0, z: 0 }; },
  };
  const audioCalls = [];
  const audio = {
    setShipEngine(power) { audioCalls.push(power); },
    stopShipEngine() { audioCalls.push(0); },
  };
  const flight = new InterplanetaryTravel(scene, new THREE.PerspectiveCamera(), player, world, {
    sky: { visible: true }, sun: { color: new THREE.Color() }, fill: { color: new THREE.Color() }, audio,
  });
  flight.reset(player.pos);
  return { flight, player, audioCalls };
}

function launchToSpace(flight, player) {
  assert.equal(flight.tryInteract(player), 'boarded');
  for (let i = 0; i < 30; i++) flight.update(1 / 60, input(), player);
  flight.update(1 / 60, input([], ['forward']), player);
  for (let i = 0; i < 205; i++) flight.update(1 / 60, input(), player);
  assert.equal(flight.mode, 'space');
  flight.navTarget = null;
}

test('walk/board/launch/fly/land/exit loop reaches both additional planets', () => {
  const { flight, player } = harness();
  const targets = {
    cinder: new THREE.Vector3(-145, 14, -265),
    nyx: new THREE.Vector3(195, -12, -350),
  };

  for (const [id, target] of Object.entries(targets)) {
    if (id === 'cinder') {
      assert.equal(flight.tryInteract(player), 'boarded');
    } else {
      // Landing puts the player safely outside the ship's wings. Walking back
      // to it starts a real second departure from the first destination.
      player.spawn({ x: flight.surfaceShip.position.x, y: 0, z: flight.surfaceShip.position.z });
      assert.equal(flight.tryInteract(player), 'boarded');
    }
    for (let i = 0; i < 30; i++) flight.update(1 / 60, input(), player);
    flight.update(1 / 60, input([], ['forward']), player);
    for (let i = 0; i < 205; i++) flight.update(1 / 60, input(), player);
    assert.equal(flight.mode, 'space');

    // A/D disengages the beginner-friendly nav lock; this route verifies the
    // player can still steer toward either world manually.
    flight.navTarget = null;
    player.yaw = Math.atan2(-target.x, -target.z);
    for (let i = 0; i < 900 && flight.mode === 'space'; i++) flight.update(1 / 60, input(['forward']), player);
    assert.equal(flight.mode, 'approach', `${id} should become landable`);
    const held = flight.shipPos.clone();
    for (let i = 0; i < 90; i++) flight.update(1 / 60, input(['forward']), player);
    assert.ok(flight.shipPos.distanceTo(held) < 0.001, `${id} approach should hold position until landing`);
    assert.equal(flight.speed, 0, `${id} approach should stop the ship`);
    assert.equal(flight.land(input([], ['jump'])), true);
    for (let i = 0; i < 230; i++) flight.update(1 / 60, input(), player);
    assert.equal(flight.current, id);
    assert.equal(flight.mode, 'surface', 'landing automatically disembarks the player');
  }

  player.spawn({ x: flight.surfaceShip.position.x, y: 0, z: flight.surfaceShip.position.z });
  assert.equal(flight.tryInteract(player), 'boarded', 'the landed ship can be boarded again');
  assert.equal(flight.tryInteract(player), 'exited', 'the player can still exit a landed ship manually');
  assert.equal(flight.mode, 'surface');
});

test('Cinder Reach uses John Pork as its complete spherical surface', () => {
  assert.equal(JOHN_PORK_PLANET, 'cinder');
  assert.equal(PLANETS.cinder.surface, JOHN_PORK_TEXTURE);
  assert.equal(PLANETS.nyx.surface, undefined);
  const texturePath = path.join(ROOT, JOHN_PORK_TEXTURE);
  assert.ok(existsSync(texturePath), 'John Pork planetary surface is missing');
  const png = readFileSync(texturePath);
  assert.equal(png[25], 2, 'John Pork surface must be an opaque truecolour map');
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20) * 2,
    'John Pork surface is not a 2:1 equirectangular sphere texture');

  const { flight } = harness();
  const cinder = flight.planetMeshes.get('cinder');
  assert.equal(cinder.userData.surfaceTexture, JOHN_PORK_TEXTURE);
  assert.equal(cinder.userData.body.userData.surfaceTexture, JOHN_PORK_TEXTURE);
  assert.equal(cinder.userData.body.name, 'john-pork-planet-surface');
  assert.equal(cinder.children.some((child) => child.name === 'john-pork-planet-face'), false,
    'the old sticker-like face decal still exists');
  const forward = new THREE.Vector3(1, 0, 0).applyQuaternion(cinder.userData.body.quaternion);
  assert.ok(forward.dot(new THREE.Vector3(145, -14, 265).normalize()) > 0.999,
    'the full John Pork surface is turned away from the arriving player');
  assert.equal(flight.planetMeshes.get('nyx').userData.surfaceTexture, null);
});

test('A/D steering turns and banks the ship in the matching direction', () => {
  const { flight, player } = harness();
  assert.equal(flight.tryInteract(player), 'boarded');
  for (let i = 0; i < 30; i++) flight.update(1 / 60, input(), player);
  flight.update(1 / 60, input([], ['forward']), player);
  for (let i = 0; i < 205; i++) flight.update(1 / 60, input(), player);
  flight.navTarget = null;

  const startYaw = player.yaw;
  for (let i = 0; i < 30; i++) flight.update(1 / 60, input(['right']), player);
  assert.ok(player.yaw < startYaw, 'D should yaw toward screen-right');
  assert.ok(flight.flightShip.rotation.z < 0, 'D should bank the right wing into the turn');

  const rightYaw = player.yaw;
  for (let i = 0; i < 60; i++) flight.update(1 / 60, input(['left']), player);
  assert.ok(player.yaw > rightYaw, 'A should yaw toward screen-left');
  assert.ok(flight.flightShip.rotation.z > 0, 'A should bank the left wing into the turn');
});

test('the on-screen stick can launch, throttle, and steer', () => {
  const { flight, player } = harness();
  assert.equal(flight.tryInteract(player), 'boarded');
  for (let i = 0; i < 30; i++) flight.update(1 / 60, input(), player);
  const stick = input(); stick.moveAxis = { x: 0, z: -1 };
  flight.update(1 / 60, stick, player);
  assert.equal(flight.mode, 'launch');
  for (let i = 0; i < 205; i++) flight.update(1 / 60, input(), player);
  flight.navTarget = null;
  const startYaw = player.yaw;
  const turn = input(); turn.moveAxis = { x: 0.8, z: -0.8 };
  for (let i = 0; i < 30; i++) flight.update(1 / 60, turn, player);
  assert.ok(player.yaw < startYaw, 'right stick deflection should turn right');
  assert.ok(flight.cruise > 28, 'forward stick deflection should raise cruise thrust');
});

test('Verdant parks the ship outside and parallel to the spaceport airlock', () => {
  const { flight, player } = harness();
  flight.world.plan = {
    outside: { minX: 48, maxX: 80, minZ: 60, maxZ: 72, cx: 64, cz: 66 },
  };
  flight.world.props = [{ escape: true, x: 64, z: 60 }];
  flight.reset(player.pos);

  assert.equal(flight.surfaceShip.position.x, 64);
  assert.ok(flight.surfaceShip.position.z > 60, 'the ship must be on the exterior side of the airlock');
  assert.ok(flight.surfaceShip.position.z < 72, 'the ship must remain inside the outdoor berth');
  assert.ok(Math.abs(flight.surfaceShip.rotation.y + Math.PI / 2) < 0.001,
    'the ship should park parallel to the exterior wall');
});

test('the surface Starling prompt appears only when the player is close', () => {
  const { flight, player } = harness();
  player.spawn({ x: flight.surfaceShip.position.x + 30, y: 0, z: flight.surfaceShip.position.z });
  assert.equal(flight.prompt(player), '', 'the Starling was advertised across the whole map');

  player.spawn({ x: flight.surfaceShip.position.x + 7, y: 0, z: flight.surfaceShip.position.z });
  assert.match(flight.prompt(player), /STARLING/, 'nearby players should be told what the ship is');
  assert.doesNotMatch(flight.prompt(player), /PRESS E/, 'boarding should not be offered outside reach');

  player.spawn({ x: flight.surfaceShip.position.x + 4, y: 0, z: flight.surfaceShip.position.z });
  assert.equal(flight.prompt(player), 'PRESS E — BOARD STARLING');
});

test('Verdant prefers the world-authored level landing pad', () => {
  const { flight, player } = harness();
  flight.world.spaceportLanding = { x: 14, y: 3.5, z: 44, yaw: 0.65 };
  flight.reset(player.pos);
  assert.deepEqual(flight.surfaceShip.position.toArray(), [14, 4.65, 44]);
  assert.equal(flight.surfaceShip.rotation.y, 0.65);
  assert.equal(flight.surfacePad.position.x, 14);
  assert.equal(flight.surfacePad.position.z, 44);
});

test('launch shows fire and fumes while engine sound follows flight power', () => {
  const { flight, player, audioCalls } = harness();
  assert.equal(flight.tryInteract(player), 'boarded');
  for (let i = 0; i < 30; i++) flight.update(1 / 60, input(), player);
  flight.update(1 / 60, input([], ['forward']), player);
  for (let i = 0; i < 20; i++) flight.update(1 / 60, input(), player);
  assert.equal(flight.mode, 'launch');
  assert.equal(flight.surfaceExhaust.visible, true);
  assert.ok(flight.launchSmoke.userData.particles.some((p) => p.mesh.visible), 'launch should leave expanding fumes');
  assert.ok(audioCalls.some((p) => p > 0.7), 'launch burn should drive an audible rocket motor');

  for (let i = 0; i < 190; i++) flight.update(1 / 60, input(), player);
  assert.equal(flight.mode, 'space');
  flight.update(1 / 60, input(['forward']), player);
  assert.equal(flight.flightExhaust.visible, true);
});

test('the inevitable snail starts in the player room and relentlessly pursues only on foot', () => {
  const { flight, player } = harness();
  const room = flight.world.plan.rooms[0];
  assert.equal(flight.snailSpawnRoomId, room.id);
  assert.ok(flight.snailPos.x >= room.minX && flight.snailPos.x <= room.maxX);
  assert.ok(flight.snailPos.z >= room.minZ && flight.snailPos.z <= room.maxZ);
  assert.ok(flight.snailDistance >= SNAIL_START_MIN_DISTANCE,
    'the same-room spawn must not be an immediate death');
  assert.equal(flight.snailMesh.parent, flight.scene, 'the snail belongs to the ground scene');
  assert.equal(flight.snailMesh.scale.x, SNAIL_VISUAL_SCALE,
    'the realistic shell/body should not retain its monster-sized placeholder scale');
  const silhouette = new THREE.Box3().setFromObject(flight.snailMesh)
    .getSize(new THREE.Vector3());
  assert.ok(Math.max(silhouette.x, silhouette.z) < 1,
    `the smaller snail is still ${Math.max(silhouette.x, silhouette.z).toFixed(2)}m long`);
  assert.ok(SNAIL_KILL_DISTANCE < 0.6, 'snail catch radius should match the smaller silhouette');

  let catches = 0;
  flight.onSnailCaught = () => { catches++; };
  const startDistance = flight.snailDistance;
  flight.update(1, input(), player);
  assert.ok(startDistance - flight.snailDistance >= SNAIL_SPEED * 0.99,
    'the pursuer should keep closing at its authored ground speed');

  flight.snailPos.set(
    player.pos.x,
    player.pos.y + SNAIL_GROUND_OFFSET,
    player.pos.z + SNAIL_KILL_DISTANCE + 0.02,
  );
  flight.update(0.1, input(), player);
  assert.equal(catches, 1, 'ground contact should trigger the instant-death callback');
  for (let i = 0; i < 10; i++) flight.update(0.1, input(), player);
  assert.equal(catches, 1, 'continued overlap must not re-fire death every frame');
});

test('the inevitable-snail HUD stays quiet until the pursuer is close', () => {
  const { flight } = harness();
  assert.ok(flight.snailDistance > SNAIL_WARNING_DISTANCE);
  assert.equal(flight.hudInfo(), null, 'the distant snail still occupies the HUD');

  flight.snailDistance = SNAIL_WARNING_DISTANCE;
  assert.equal(flight.hudInfo().title, 'INEVITABLE SNAIL');
  assert.match(flight.hudInfo().sub, /SNAIL 3 m/);

  flight.bananaTime = 12;
  assert.match(flight.hudInfo().sub, /SNAIL 3 m/,
    'the nearby warning disappeared while the banana gun was active');
  flight.snailDistance = SNAIL_WARNING_DISTANCE + 0.01;
  assert.doesNotMatch(flight.hudInfo().sub, /SNAIL/,
    'the banana HUD still advertises a distant snail');
});

test('the realistic snail keeps authored body and shell materials without metallic lighting', () => {
  assert.equal(SNAIL_ASSET, 'assets/creatures/inevitable_snail/snail-v2.glb');
  const source = new THREE.Group();
  const shellMaterial = new THREE.MeshStandardMaterial({
    name: 'Shell', color: 0xb97b42, metalness: 1, roughness: 0.08,
  });
  const bodyMaterial = new THREE.MeshStandardMaterial({
    name: 'Snail', color: 0x726849, metalness: 0.9, roughness: 0.1,
  });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 8), shellMaterial);
  shell.name = 'Shell';
  shell.position.set(-0.25, 0.5, 0);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.25, 0.35), bodyMaterial);
  body.name = 'Snail';
  body.position.set(0.3, 0.16, 0);
  source.add(shell, body);

  const prepared = prepareRealisticSnail(source);
  const box = new THREE.Box3().setFromObject(prepared);
  const size = box.getSize(new THREE.Vector3());
  assert.equal(prepared.userData.realisticSnail, true);
  assert.equal(shell.material, shellMaterial, 'shell material was replaced instead of corrected');
  assert.equal(body.material, bodyMaterial, 'body material was replaced instead of preserved');
  assert.equal(shellMaterial.metalness, 0);
  assert.equal(bodyMaterial.metalness, 0);
  assert.equal(shellMaterial.roughness, 0.38);
  assert.equal(bodyMaterial.roughness, 0.34);
  assert.equal(shellMaterial.envMapIntensity, 0.72);
  assert.equal(bodyMaterial.envMapIntensity, 0.5);
  assert.ok(Math.abs(Math.max(size.x, size.z) - SNAIL_MODEL_LENGTH) < 1e-6,
    `prepared snail is ${Math.max(size.x, size.z).toFixed(3)}m long`);
  assert.ok(Math.abs(box.min.y) < 1e-6, `prepared snail floats ${box.min.y.toFixed(3)}m above ground`);
});

test('the realistic snail measures a diagonal export and aligns its head to local +Z', () => {
  const source = new THREE.Group();
  const shell = new THREE.Group(); shell.name = 'Shell';
  shell.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.38, 8, 6), new THREE.MeshStandardMaterial(),
  ));
  const body = new THREE.Group(); body.name = 'Snail'; body.rotation.y = -0.61;
  const foot = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 0.22, 0.34), new THREE.MeshStandardMaterial(),
  );
  foot.position.y = 0.12;
  const stalks = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 1.1, 0.22), new THREE.MeshStandardMaterial(),
  );
  stalks.position.set(1.02, 0.62, 0);
  const headProbe = new THREE.Object3D(); headProbe.name = 'ProbeHead';
  headProbe.position.x = 1.1;
  const tailProbe = new THREE.Object3D(); tailProbe.name = 'ProbeTail';
  tailProbe.position.x = -1.1;
  body.add(foot, stalks, headProbe, tailProbe);
  source.add(shell, body);

  const measured = measureRealisticSnailForward(source);
  const authored = new THREE.Vector3(1, 0, 0)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), body.rotation.y);
  assert.ok(measured.dot(authored) > 0.995,
    `measured head points ${measured.toArray()} instead of ${authored.toArray()}`);

  const prepared = prepareRealisticSnail(source);
  prepared.updateMatrixWorld(true);
  const renderedForward = headProbe.getWorldPosition(new THREE.Vector3())
    .sub(tailProbe.getWorldPosition(new THREE.Vector3())).normalize();
  assert.ok(renderedForward.dot(new THREE.Vector3(0, 0, 1)) > 0.995,
    `axis-corrected head points ${renderedForward.toArray()} instead of local +Z`);
  assert.ok(Math.abs(prepared.userData.alignmentYaw + Math.atan2(
    measured.x, measured.z,
  )) < 1e-9);
});

test('the installed realistic snail is grounded and faces the direction it travels', () => {
  const source = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0x6c5c3e });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), material.clone());
  shell.name = 'Shell';
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.2, 0.3), material);
  body.name = 'Snail';
  const head = new THREE.Object3D(); head.name = 'HeadMarker'; head.position.x = 0.8;
  const tail = new THREE.Object3D(); tail.name = 'TailMarker'; tail.position.x = -0.8;
  source.add(shell, body, head, tail);

  const target = new THREE.Group();
  target.position.set(3, 4 + SNAIL_GROUND_OFFSET, 5);
  const detailed = installRealisticSnail(target, source);
  target.lookAt(9, target.position.y, 11);
  target.updateMatrixWorld(true);

  const worldBox = new THREE.Box3().setFromObject(target);
  assert.ok(Math.abs(worldBox.min.y - 4) < 1e-6,
    `installed snail floats ${worldBox.min.y - 4}m above terrain`);
  const forward = head.getWorldPosition(new THREE.Vector3())
    .sub(tail.getWorldPosition(new THREE.Vector3())).normalize();
  const travel = new THREE.Vector3(9 - target.position.x, 0, 11 - target.position.z).normalize();
  assert.ok(forward.dot(travel) > 0.999, 'snail head does not lead its pursuit movement');
  assert.equal(detailed.position.y, -SNAIL_GROUND_OFFSET);
});

test('the snail follows terrain height instead of floating toward player elevation', () => {
  const { flight, player } = harness();
  flight.world.heightAt = (x, z) => 2.4 + x * 0.01 - z * 0.005;
  flight.snailActive = true;
  flight.snailPos.set(40, 12, 44);
  player.pos = { x: 44, y: 9, z: 44 };
  flight.update(1, input(), player);
  const expected = flight.world.heightAt(flight.snailPos.x, flight.snailPos.z)
    + SNAIL_GROUND_OFFSET;
  assert.ok(Math.abs(flight.snailPos.y - expected) < 1e-9,
    `snail y=${flight.snailPos.y}, terrain anchor=${expected}`);
});

test('the snail crawls in its visible head direction while turning instead of sliding sideways', () => {
  const { flight, player } = harness();
  flight.snailActive = true;
  flight.snailPos.set(40, SNAIL_GROUND_OFFSET, 40);
  flight.snailMesh.position.copy(flight.snailPos);
  flight.snailMesh.quaternion.identity();
  player.pos = { x: 60, y: 0, z: 40 };

  const before = flight.snailPos.clone();
  flight.update(0.1, input(), player);
  const movement = flight.snailPos.clone().sub(before).setY(0).normalize();
  const visibleForward = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(flight.snailMesh.quaternion).setY(0).normalize();
  assert.ok(movement.dot(visibleForward) > 0.999999,
    `movement ${movement.toArray()} diverges from visible heading ${visibleForward.toArray()}`);
  assert.ok(movement.x > 0, 'the turning snail stopped making progress toward the player');
});

test('the snail cannot crawl through solid world props', () => {
  const { flight, player } = harness();
  flight.snailActive = true;
  flight.snailPos.set(40, SNAIL_GROUND_OFFSET, 40);
  flight.snailMesh.position.copy(flight.snailPos);
  flight.snailMesh.quaternion.setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), Math.PI / 2,
  );
  player.pos = { x: 45, y: 0, z: 40 };
  flight.world.blocksAt = (x, y, z, radius) => (
    x + radius > 41 && x - radius < 41.3 && z + radius > 37 && z - radius < 43
  );

  for (let i = 0; i < 240; i++) flight.update(1 / 60, input(), player);
  assert.ok(flight.snailPos.x <= 41 - 0.3 + 1e-6,
    `snail crossed the wall and reached x=${flight.snailPos.x}`);
});

test('the snail wall-follows around an obstacle instead of stopping forever', () => {
  const { flight, player } = harness();
  flight.snailActive = true;
  flight.snailPos.set(40, SNAIL_GROUND_OFFSET, 40);
  flight.snailMesh.position.copy(flight.snailPos);
  flight.snailMesh.quaternion.setFromAxisAngle(
    new THREE.Vector3(0, 1, 0), Math.PI / 2,
  );
  player.pos = { x: 46, y: 0, z: 40 };
  flight.world.blocksAt = (x, y, z, radius) => (
    x + radius > 41 && x - radius < 41.3 && z + radius > 37 && z - radius < 43
  );

  let closest = Infinity;
  for (let i = 0; i < 2_400; i++) {
    flight.update(1 / 60, input(), player);
    closest = Math.min(closest, flight.snailDistance);
  }

  assert.ok(flight.snailPos.x > 41.3 + 0.3,
    `snail never found the far side of the wall (x=${flight.snailPos.x})`);
  assert.ok(closest < 3,
    `snail routed around the wall but never resumed pursuit (${closest}m at best; `
      + `ended at ${flight.snailPos.x},${flight.snailPos.z})`);
});

test('the snail rests on floor support and aligns upright to sloped ground', () => {
  const supported = {
    heightAt: (x, z) => 0.2 * x - 0.1 * z,
    supportHeight: (x, z, fromY) => fromY > 2 ? 2 : 0.2 * x - 0.1 * z,
  };
  assert.equal(snailGroundHeight(supported, 4, 5, 2), 2,
    'the snail ignored a floor slab above terrain');

  const slope = { heightAt: (x, z) => 0.2 * x - 0.1 * z };
  const orientation = snailSurfaceOrientation(slope, 10, 10, 1, 1, 0);
  const renderedUp = new THREE.Vector3(0, 1, 0).applyQuaternion(orientation);
  const expectedUp = new THREE.Vector3(-0.2, 1, 0.1).normalize();
  assert.ok(renderedUp.dot(expectedUp) > 0.999,
    `snail up ${renderedUp.toArray()} does not match terrain ${expectedUp.toArray()}`);
  const renderedForward = new THREE.Vector3(0, 0, 1).applyQuaternion(orientation);
  const expectedForward = new THREE.Vector3(1, 0, 0)
    .addScaledVector(expectedUp, -new THREE.Vector3(1, 0, 0).dot(expectedUp))
    .normalize();
  assert.ok(renderedForward.dot(expectedForward) > 0.999,
    'the snail turns sideways while conforming to a slope');
});

test('the snail disappears aboard the Starling and never pursues the spacecraft', () => {
  const { flight, player } = harness();
  player.spawn({ x: flight.surfaceShip.position.x, y: 0, z: flight.surfaceShip.position.z });
  const parked = flight.snailPos.clone();
  assert.equal(flight.tryInteract(player), 'boarded');
  assert.equal(flight.snailActive, false);
  assert.equal(flight.snailMesh.visible, false);
  for (let i = 0; i < 30; i++) flight.update(1 / 60, input(), player);
  assert.deepEqual(flight.snailPos.toArray(), parked.toArray());

  flight.update(1 / 60, input([], ['forward']), player);
  for (let i = 0; i < 205; i++) flight.update(1 / 60, input(), player);
  assert.equal(flight.mode, 'space');
  const inFlight = flight.snailPos.clone();
  for (let i = 0; i < 60; i++) flight.update(1 / 60, input(['forward']), player);
  assert.deepEqual(flight.snailPos.toArray(), inFlight.toArray());
  assert.equal(flight.snailActive, false);
});

test('banana impact charges the ship, then exit starts a 30-second ground boomerang', () => {
  const { flight, player } = harness();
  launchToSpace(flight, player);
  flight.speed = 0;
  flight.cruise = 0;

  let charges = 0;
  let starts = 0;
  let fires = 0;
  let hits = 0;
  let ends = 0;
  flight.onBananaCharged = () => { charges++; };
  flight.onBananaStart = ({ duration }) => { starts++; assert.equal(duration, BANANA_DURATION); };
  flight.onBananaFire = () => { fires++; };
  flight.onSnailHit = () => { hits++; };
  flight.onBananaEnd = () => { ends++; };

  const pickup = flight.bananaAsteroids[0];
  pickup.mesh.position.copy(flight.shipPos);
  flight.update(1 / 60, input(), player);
  assert.equal(charges, 1);
  assert.equal(starts, 0, 'the ground-gun timer must not begin inside the spacecraft');
  assert.equal(flight.bananaCharged, true);
  assert.equal(flight.bananaTime, 0);
  assert.equal(pickup.active, false);
  assert.equal(flight.flightShip.visible, false);
  assert.equal(flight.bananaShip.visible, true);
  assert.match(flight.hudInfo().title, /BANANA CRAFT/);
  flight.update(0.2, input(['fire']), player);
  assert.equal(fires, 0, 'the banana gun must not fire from the ship');
  assert.equal(flight.bananaProjectiles.length, 0);

  // Touchdown automatically puts boots on the ground, which is the actual
  // disembark transition in the flight loop.
  flight.destination = { id: 'cinder' };
  flight._completeLanding(player);
  assert.equal(flight.mode, 'surface');
  assert.equal(starts, 1);
  assert.equal(flight.bananaCharged, false);
  assert.equal(flight.bananaTime, BANANA_DURATION);
  assert.equal(flight.bananaGunActive, true);
  assert.match(flight.hudInfo().title, /BANANA GUN/);
  const heldBanana = flight.bananaGunView.getObjectByName('unpeeled-banana');
  assert.equal(heldBanana.userData.unpeeled, true, 'the firearm banana should keep its peel intact');
  assert.ok(heldBanana.getObjectByName('whole-banana-peel'),
    'the peeled GLB must not replace the gun\'s intact peel geometry');
  assert.equal(heldBanana.userData.bananaScale, 0.13);
  assert.equal(heldBanana.rotation.x, Math.PI,
    'the banana should be rolled upright with its green stem hanging down');
  assert.equal(heldBanana.rotation.y, Math.PI / 3,
    'the blunt banana barrel should point forward at the enemy');
  assert.equal(heldBanana.rotation.z, 0.45,
    'the banana should roll its barrel level and angle its grip back toward the player');
  flight.bananaGunView.updateMatrixWorld(true);
  const barrel = heldBanana.getObjectByName('whole-banana-navel')
    .getWorldPosition(new THREE.Vector3());
  const grip = heldBanana.getObjectByName('whole-banana-stem-tip')
    .getWorldPosition(new THREE.Vector3());
  const bend = heldBanana.getObjectByName('whole-banana-peel')
    .localToWorld(new THREE.Vector3(0, -0.33, 0));
  assert.ok(barrel.z < grip.z,
    'the blunt barrel should be farther downrange than the green stem grip');
  assert.ok(barrel.x < bend.x && grip.x > bend.x,
    'the barrel should extend toward the crosshair while the grip tilts back toward the player');
  assert.ok(Math.abs(barrel.y - bend.y) < 0.025,
    'the barrel should project almost straight instead of sharply downward');
  assert.ok(grip.y < barrel.y,
    'the near green stem should hang below the forward barrel');
  assert.equal(flight.bananaGunView.getObjectByName('hands'), undefined,
    'no hand or arm should be visible with the banana gun');
  for (const attachment of [
    'banana-gun-receiver', 'banana-gun-grip', 'banana-gun-trigger-guard',
    'banana-gun-trigger', 'banana-gun-muzzle', 'banana-gun-front-sight',
  ]) {
    assert.equal(flight.bananaGunView.getObjectByName(attachment), undefined,
      `${attachment} makes the literal banana look like a conventional gun`);
  }
  assert.equal(flight.bananaShip.children.length, 3,
    'the banana craft should contain only the intact banana and two wings');
  assert.equal(flight.bananaShip.children[0], flight.bananaCraftHolder);
  assert.equal(flight.bananaShip.getObjectsByProperty('name', 'banana-craft-wing').length, 2);
  assert.equal(flight.bananaShip.userData.literalBanana, true);

  const movingAsteroid = flight.bananaAsteroids.find((rock) => rock.active);
  assert.ok(movingAsteroid.holder.userData.bananaScale >= 1.7,
    'banana asteroids should be substantially larger than the old pickups');
  assert.ok(movingAsteroid.velocity.length() > 2,
    'banana asteroids should have visible drift velocity in addition to tumbling');
  const asteroidStart = movingAsteroid.mesh.position.clone();
  flight._updateSpaceHazards(0.5);
  assert.ok(movingAsteroid.mesh.position.distanceTo(asteroidStart) > 1,
    'an active banana asteroid should visibly move through space');

  player.yaw = 0; player.pitch = 0;
  flight.snailPos.set(
    player.pos.x,
    player.pos.y + SNAIL_GROUND_OFFSET,
    player.pos.z - 4,
  );
  flight.snailMesh.position.copy(flight.snailPos);
  const beforeHit = Math.hypot(flight.snailPos.x - player.pos.x, flight.snailPos.z - player.pos.z);
  flight.update(1 / 60, input(['fire']), player);
  for (let i = 1; i < 24 && hits === 0; i++) flight.update(1 / 60, input(), player);
  assert.equal(fires, 1);
  assert.equal(hits, 1);
  assert.equal(flight.bananaProjectiles.length, 0, 'a banana is consumed when it hits the snail');
  assert.ok(Math.hypot(flight.snailPos.x - player.pos.x, flight.snailPos.z - player.pos.z) > beforeHit + 9,
    'the boomerang should throw the inevitable snail away from the player');
  assert.ok(flight.bananaFireClock <= BANANA_FIRE_COOLDOWN);

  flight.bananaTime = 0.01;
  flight.update(0.02, input(), player);
  assert.equal(ends, 1);
  assert.equal(flight.bananaTime, 0);
  assert.equal(flight.flightShip.visible, true);
  assert.equal(flight.bananaShip.visible, false);
});

test('banana boomerangs deal only two damage to ordinary enemies', () => {
  const { flight, player } = harness();
  flight.snailActive = false;
  flight.bananaTime = 5;

  const enemy = {
    alive: true,
    health: 100,
    pos: { x: player.pos.x, y: player.pos.y, z: player.pos.z - 4.8 },
    type: { width: 0.62, height: 1.8 },
  };
  let impact = null;
  flight.getBananaTargets = () => [enemy];
  flight.onBananaEnemyHit = (event) => {
    impact = event;
    enemy.health -= event.damage;
  };

  flight.update(1 / 60, input(['fire']), player);
  for (let i = 0; i < 20 && !impact; i++) flight.update(1 / 60, input(), player);

  assert.ok(impact, 'the boomerang passed through an ordinary enemy');
  assert.equal(impact.enemy, enemy);
  assert.equal(impact.damage, BANANA_DAMAGE);
  assert.equal(BANANA_DAMAGE, 2, 'the novelty banana should do only a very small amount of damage');
  assert.equal(enemy.health, 98);
  assert.equal(flight.bananaProjectiles.length, 0, 'the boomerang should be consumed on impact');
});

test('the outgoing banana converges on the centre crosshair before boomeranging', () => {
  const { flight, player } = harness();
  flight.snailActive = false;
  flight.bananaTime = 5;
  player.yaw = 0.37;
  player.pitch = 0.16;

  const eye = new THREE.Vector3(player.pos.x, player.pos.y + 1.55, player.pos.z);
  const look = new THREE.Vector3();
  player.getLookDir(look);
  const crosshairPoint = eye.clone().addScaledVector(look, BANANA_THROW_DISTANCE);

  // Half of the 1.3-second flight is the outbound turn point.
  flight.update(0.65, input(['fire']), player);
  assert.equal(flight.bananaProjectiles.length, 1);
  assert.ok(flight.bananaProjectiles[0].mesh.position.distanceTo(crosshairPoint) < 1e-6,
    'the outbound banana missed the actual centre aim ray');
});

test('every planetary berth is on real terrain and destinations build different maps', () => {
  for (const id of ['cinder', 'nyx']) {
    const p = PLANETS[id].landing;
    assert.ok(p.x > 0 && p.x < 128 && p.z > 0 && p.z < 128, `${id} berth must be inside the rendered map`);
  }

  const cinder = new World(4101, { planet: 'cinder' });
  const nyx = new World(4102, { planet: 'nyx' });
  for (const _ of cinder.generate()) { /* drain */ }
  for (const _ of nyx.generate()) { /* drain */ }

  assert.ok(cinder.inBounds(cinder.landing.x, cinder.landing.z));
  assert.ok(nyx.inBounds(nyx.landing.x, nyx.landing.z));
  assert.equal(cinder.landing.x, 17, 'Cinder approaches from the west');
  assert.equal(nyx.landing.z, 17, 'Nyx approaches from the north');
  assert.notDeepEqual(cinder.siteBounds, nyx.siteBounds, 'planet outposts use different footprints');
  assert.notEqual(
    Math.round(cinder.heightAt(9, 40) * 100),
    Math.round(nyx.heightAt(9, 40) * 100),
    'planet terrain profiles must not collapse to the same heightfield',
  );
});

test('the starting airlock has a flat, clear landing pad instead of a hill', () => {
  for (const seed of [20260725, 17, 4103]) {
    const world = new World(seed);
    for (const _ of world.generate()) { /* drain */ }
    const pad = world.spaceportLanding;
    assert.ok(pad, `seed ${seed} should author a Verdant spaceport berth`);
    assert.ok(world.inBounds(pad.x, pad.z));
    for (const dx of [-4.8, 0, 4.8]) for (const dz of [-4.8, 0, 4.8]) {
      assert.ok(Math.abs(world.heightAt(pad.x + dx, pad.z + dz) - pad.y) < 0.06,
        `seed ${seed} pad must stay level at ${dx},${dz}`);
    }
    assert.equal(world.blocksAt(pad.x, pad.y, pad.z, 3.6, 2.5), false,
      `seed ${seed} ship footprint must be clear`);
  }
});
