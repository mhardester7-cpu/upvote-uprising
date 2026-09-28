import test from 'node:test';
import assert from 'node:assert/strict';

import * as THREE from '../vendor/three.module.js';
import {
  PortalSystem, portalBasis, transformPortalVector,
  transformPortalViewPosition,
  PORTAL_HALF_HEIGHT, PORTAL_HALF_WIDTH,
} from '../src/game/portals.js';
import { WeaponSystem, WEAPONS } from '../src/combat/weapons.js';
import { traceShot, HIT_ENEMY } from '../src/combat/combat.js';
import { Rocket } from '../src/combat/projectile.js';
import { Player } from '../src/entities/player.js';
import { Enemy } from '../src/entities/enemy.js';
import { World } from '../src/world/world.js';

function playerAt(x, y, z, yaw = 0, pitch = 0) {
  return {
    pos: { x, y, z }, prevPos: { x, y, z },
    vel: { x: 0, y: 0, z: 0 },
    yaw, pitch, alive: true, onGround: false, ladder: null,
    height: 1.8, half: 0.32,
    get eyeY() { return this.pos.y + 1.64; },
    getLookDir(out = {}) {
      const cp = Math.cos(this.pitch);
      out.x = -Math.sin(this.yaw) * cp;
      out.y = Math.sin(this.pitch);
      out.z = -Math.cos(this.yaw) * cp;
      return out;
    },
  };
}

function record(kind, center, normal, preferredUp = { x: 0, y: 1, z: 0 }) {
  return { kind, center: new THREE.Vector3(center.x, center.y, center.z),
    ...portalBasis(normal, preferredUp) };
}

function linkedRayFixture() {
  const sourceWall = { type: 'wall', collider: { kind: 'box' } };
  const destinationWall = { type: 'wall', collider: { kind: 'box' } };
  const farWall = { type: 'wall', collider: { kind: 'box' } };
  const world = {
    lineOfSight: () => true,
    raycast(ox, oy, oz, dx, dy, dz, range) {
      const hits = [];
      const add = (t, x, y, z, nx, ny, nz, prop) => {
        if (t >= 0 && t <= range) hits.push({ hit: true, distance: t, x, y, z, nx, ny, nz, prop });
      };
      if (dz < -1e-6 && oz >= 0) {
        const t = oz / -dz;
        add(t, ox + dx * t, oy + dy * t, 0, 0, 0, 1, sourceWall);
      }
      if (dx < -1e-6 && ox >= 10) {
        const t = (10 - ox) / dx;
        add(t, 10, oy + dy * t, oz + dz * t, 1, 0, 0, destinationWall);
      }
      if (dx > 1e-6 && ox <= 20) {
        const t = (20 - ox) / dx;
        add(t, 20, oy + dy * t, oz + dz * t, -1, 0, 0, farWall);
      }
      hits.sort((a, b) => a.distance - b.distance);
      return hits[0] ?? {
        hit: false, distance: range,
        x: ox + dx * range, y: oy + dy * range, z: oz + dz * range,
        nx: 0, ny: 0, nz: 0, prop: null,
      };
    },
  };
  const system = new PortalSystem(null, world);
  system.portals.blue = {
    ...record('blue', { x: 0, y: 0.9, z: 0 }, { x: 0, y: 0, z: 1 }),
    prop: sourceWall,
  };
  system.portals.orange = {
    ...record('orange', { x: 10, y: 0.9, z: 0 }, { x: 1, y: 0, z: 0 }),
    prop: destinationWall,
  };
  return { system, farWall };
}

test('portal bases are orthonormal on walls, floors, and ceilings', () => {
  for (const normal of [
    { x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  ]) {
    const basis = portalBasis(normal);
    assert.ok(Math.abs(basis.right.length() - 1) < 1e-9);
    assert.ok(Math.abs(basis.up.length() - 1) < 1e-9);
    assert.ok(Math.abs(basis.normal.length() - 1) < 1e-9);
    assert.ok(Math.abs(basis.right.dot(basis.up)) < 1e-9);
    assert.ok(Math.abs(basis.right.dot(basis.normal)) < 1e-9);
    assert.ok(Math.abs(basis.up.dot(basis.normal)) < 1e-9);
  }
});

test('the portal gun is carried, ammo-free, and has two timed fire modes', () => {
  const def = WEAPONS.find((w) => w.id === 'portalgun');
  assert.ok(def?.portal);
  assert.equal(def.noAmmo, true);
  assert.equal(def.alternateFire, true);

  const weapons = new WeaponSystem(null);
  const portal = weapons.weapons.find((w) => w.def.id === 'portalgun');
  weapons.index = weapons.weapons.indexOf(portal);
  const player = playerAt(0, 0, 0);
  const fired = [];
  weapons.onFire = (_weapon, _shots, _cone, alternate) => fired.push(alternate);

  assert.ok(weapons.update(1 / 60, player, true, true, () => 0.5));
  weapons.cooldown = 0;
  assert.ok(weapons.fireAlternate(player, () => 0.5));
  assert.deepEqual(fired, [false, true]);
  assert.equal(portal.ammo, 1, 'placing portals consumed an ammo counter');
});

test('placement traces and validates the complete flat oval', () => {
  const wall = { type: 'wall', collider: { kind: 'box' } };
  const world = {
    raycast(ox, oy, oz, dx, dy, dz, range) {
      if (dz >= -0.9) return { hit: false, distance: range,
        x: ox + dx * range, y: oy + dy * range, z: oz + dz * range };
      const distance = oz / -dz;
      if (distance < 0 || distance > range) return { hit: false, distance: range };
      return { hit: true, distance, x: ox + dx * distance, y: oy + dy * distance, z: 0,
        nx: 0, ny: 0, nz: 1, prop: wall };
    },
  };
  const scene = new THREE.Scene();
  const system = new PortalSystem(scene, world);
  const result = system.place('blue', playerAt(0, 0, 4));

  assert.equal(result.ok, true);
  assert.equal(scene.children.includes(result.portal.group), true);
  assert.ok(Math.abs(result.portal.center.y - 0.94) < 1e-9,
    'wall portal was not lowered from eye height to fit the body');
  assert.equal(PORTAL_HALF_WIDTH > 0.7, true);
  assert.equal(PORTAL_HALF_HEIGHT > 1.1, true);
});

test('placement succeeds against an authored wall in the generated game world', () => {
  const world = new World(20260725);
  for (const _ of world.generate()) { /* drain deterministic generation */ }
  const wall = world.props.find((prop) => {
    const c = prop.collider;
    return c?.kind === 'box'
      && c.maxX - c.minX > PORTAL_HALF_WIDTH * 2.5
      && c.maxY - c.minY > PORTAL_HALF_HEIGHT * 2.2
      && c.maxZ - c.minZ < 0.8;
  });
  assert.ok(wall, 'generated complex has no portal-sized wall');
  const c = wall.collider;
  const player = playerAt((c.minX + c.maxX) * 0.5, c.minY + 0.22, c.maxZ + 0.55);
  const system = new PortalSystem(new THREE.Scene(), world);

  const result = system.place('blue', player, { x: 0, y: 0, z: -1 });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.hit.prop, wall);
  assert.ok(result.portal.center.y - PORTAL_HALF_HEIGHT > c.minY - 0.05);
  assert.ok(result.portal.center.y + PORTAL_HALF_HEIGHT < c.maxY + 0.05);
});

test('wall traversal rotates view and preserves incoming momentum', () => {
  const system = new PortalSystem(null, null);
  system.portals.blue = record('blue', { x: 0, y: 0.9, z: 0 }, { x: 0, y: 0, z: 1 });
  system.portals.orange = record('orange', { x: 10, y: 0.9, z: 0 }, { x: -1, y: 0, z: 0 });
  const player = playerAt(0, 0, 0.32);
  player.vel.z = -13;

  assert.equal(system.tryTraverse(player), true);
  assert.ok(player.pos.x < 10, 'player did not emerge on the outward side of the exit');
  assert.ok(player.vel.x < -12.99, 'forward speed was not rotated through the exit');
  assert.ok(Math.abs(Math.hypot(player.vel.x, player.vel.y, player.vel.z) - 13) < 1e-9);
  const look = player.getLookDir({});
  assert.ok(look.x < -0.999, 'camera did not turn to face out of the destination');
  assert.equal(system.tryTraverse(player), false, 'exit cooldown allowed an immediate loop');
});

test('the real player collision path yields a blocked wall move to its portal', () => {
  const world = {
    inBounds: () => true,
    blocksAt: (x, _y, z, radius) => x < 5 && z - radius < 0,
    supportHeight: () => 0,
    isWalkable: () => true,
    resolveProps: () => false,
    ceilingAt: () => Infinity,
  };
  const system = new PortalSystem(null, world);
  system.portals.blue = record('blue', { x: 0, y: 0.9, z: 0 }, { x: 0, y: 0, z: 1 });
  system.portals.orange = record('orange', { x: 10, y: 0.9, z: 0 }, { x: -1, y: 0, z: 0 });
  const player = new Player(world);
  player.spawn({ x: 0, y: 0, z: 0.35 });
  player.onGround = true;
  player.portalSystem = system;
  const input = {
    moveAxis: null,
    actionDown: (action) => action === 'forward',
    actionPressed: () => false,
  };

  for (let i = 0; i < 4 && player.pos.x === 0; i++) player.update(1 / 60, input, true);
  assert.ok(player.pos.x > 9 && player.pos.x < 10,
    'wall collision stopped movement instead of handing it to the aperture');
  assert.ok(player.vel.x < 0, 'the real movement update lost transformed exit momentum');
});

test('falling through a floor portal launches outward from a wall portal', () => {
  const system = new PortalSystem(null, null);
  system.portals.blue = record('blue', { x: 0, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
  system.portals.orange = record('orange', { x: 8, y: 0.9, z: 4 }, { x: 0, y: 0, z: 1 });
  const player = playerAt(0, 0, 0);
  player.vel.y = -20;

  assert.equal(system.tryTraverse(player), true);
  assert.ok(player.vel.z > 19.99, 'downward momentum did not become outward launch speed');
  assert.ok(player.pos.z > 4, 'body was not placed clear of the destination plane');
});

test('portal vector transforms are reversible across the pair', () => {
  const a = record('blue', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  const b = record('orange', { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  const v = new THREE.Vector3(3, -2, -7);
  const through = transformPortalVector(a, b, v);
  const back = transformPortalVector(b, a, through);
  assert.ok(back.distanceTo(v) < 1e-9);
});

test('live portal views render from the paired side and restore renderer state', () => {
  const source = record('blue', { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 });
  const destination = record('orange', { x: 10, y: 1, z: 0 }, { x: 1, y: 0, z: 0 });
  for (const portal of [source, destination]) {
    portal.group = new THREE.Group();
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(1), new THREE.MeshBasicMaterial());
    portal.group.add(mouth);
    portal.group.userData.mouth = mouth;
    portal.target = { texture: { name: portal.kind }, dispose() {} };
  }

  const system = new PortalSystem(null, null);
  system.portals.blue = source;
  system.portals.orange = destination;
  const main = new THREE.PerspectiveCamera(78, 16 / 9, 0.05, 500);
  main.position.set(0, 1, 3);
  main.updateMatrixWorld(true);
  const mapped = transformPortalViewPosition(source, destination, main.position);
  assert.ok(mapped.distanceTo(new THREE.Vector3(7, 1, 0)) < 1e-9);

  const targets = [];
  const views = [];
  const renderer = {
    autoClear: false,
    shadowMap: { autoUpdate: true },
    getRenderTarget: () => 'main-target',
    setRenderTarget: (target) => targets.push(target),
    clear() {},
    render(_scene, camera) {
      assert.equal(source.group.visible, false);
      assert.equal(destination.group.visible, false);
      views.push({ position: camera.position.clone(), look: camera.getWorldDirection(new THREE.Vector3()) });
    },
  };

  assert.equal(system.renderViews(renderer, {}, main), true);
  assert.equal(views.length, 1);
  assert.ok(views[0].position.distanceTo(new THREE.Vector3(7, 1, 0)) < 1e-9);
  assert.ok(views[0].look.x > 0.999, 'entrance view does not face outward from its exit');
  assert.equal(targets.at(-1), 'main-target');
  assert.equal(renderer.autoClear, false);
  assert.equal(renderer.shadowMap.autoUpdate, true);
  assert.equal(source.group.visible, true);
  assert.equal(destination.group.visible, true);
  assert.equal(source.group.userData.mouth.material.map, source.target.texture);
  assert.equal(destination.group.userData.mouth.material.map, null, 'off-screen exit must not render');
  assert.equal(system.renderViews(renderer, {}, main),false,'same-frame calls must obey the pass budget');
  system.time+=1/30;
  main.rotation.y=Math.PI;main.updateMatrixWorld(true);
  assert.equal(system.renderViews(renderer,{},main),false,'looking away must skip portal passes');
  main.rotation.y=0;main.updateMatrixWorld(true);
  system.world={raycast:()=>({hit:true,distance:.5})};
  assert.equal(system.renderViews(renderer,{},main),false,'occluded portals must skip portal passes');
  system.world=null;
  assert.equal(system.renderViews(renderer,{},main),true);
  assert.equal(views.length,2);
  for(let i=0;i<60;i++){system.time+=1/60;system.renderViews(renderer,{},main);}
  assert.ok(views.length<=32,'portal refreshes exceeded 30 per simulated second');

});

test('portal views sharpen only after sustained frame headroom and fall back quickly', () => {
  const system = new PortalSystem(null, null);
  assert.equal(system.viewQuality, 1);
  for (let i = 0; i < 70; i++) {
    system.time += 1 / 120;
    system.setFrameTime(1 / 120);
  }
  assert.equal(system.viewQuality, 2, 'fast display should earn the high-quality target');
  for (let i = 0; i < 20; i++) {
    system.time += 1 / 30;
    system.setFrameTime(1 / 30);
  }
  assert.equal(system.viewQuality, 0, 'slow display should promptly protect gameplay');
});

test('linked raycasts continue from the exit and stop at the next real wall', () => {
  const { system, farWall } = linkedRayFixture();
  const path = system.raycastSegments(0, 0.9, 3, 0, 0, -1, 30);
  assert.equal(path.hops, 1);
  assert.equal(path.segments.length, 2);
  assert.equal(path.segments[0].portal, 'blue');
  assert.equal(path.hit.prop, farWall);
  assert.ok(Math.abs(path.end.x - 20) < 1e-9);
  assert.ok(path.endDirection.x > 0.999);
});

test('hitscan fire can damage an enemy visible through a portal', () => {
  const { system } = linkedRayFixture();
  const enemy = {
    alive: true,
    pos: { x: 15, y: 0, z: 0 },
    type: { height: 1.8 },
    headBox: () => ({ minX: 14.75, minY: 1.4, minZ: -0.2, maxX: 15.25, maxY: 1.8, maxZ: 0.2 }),
    bodyBox: () => ({ minX: 14.65, minY: 0, minZ: -0.3, maxX: 15.35, maxY: 1.4, maxZ: 0.3 }),
  };
  const pistol = WEAPONS.find((w) => w.id === 'pistol');
  const trace = traceShot(system, [enemy], 0, 0.9, 3, 0, 0, -1, pistol);
  assert.equal(trace.kind, HIT_ENEMY);
  assert.equal(trace.enemy, enemy);
  assert.ok(trace.point.x > 14 && trace.point.x < 15);
  assert.equal(trace.path.length, 2, 'tracer did not split at the linked apertures');
});

test('rockets cross an aperture and retain speed along the rotated exit path', () => {
  const { system } = linkedRayFixture();
  const def = WEAPONS.find((w) => w.id === 'bazooka');
  const rocket = new Rocket(0, 0.9, 1, 0, 0, -1, def);
  const impact = rocket.update(0.05, system, []);
  assert.equal(impact, null);
  assert.equal(rocket.alive, true);
  assert.ok(rocket.x > 11, 'rocket did not spend its remaining step beyond the exit');
  assert.ok(rocket.dx > 0.999 && Math.abs(rocket.dz) < 1e-9,
    'rocket direction was not rotated through the portal');
  assert.ok(Math.abs(rocket.speed - 42) < 1e-9, 'portal changed projectile speed');
});

test('zombies traverse portals, preserve speed, and update yaw', () => {
  const system = new PortalSystem(null, null);
  system.portals.blue = record('blue', { x: 0, y: 0.9, z: 0 }, { x: 0, y: 0, z: 1 });
  system.portals.orange = record('orange', { x: 10, y: 0.9, z: 0 }, { x: -1, y: 0, z: 0 });

  const zombie = new Enemy('grunt', { inBounds: () => true, supportHeight: () => 0, isWalkable: () => true });
  zombie.pos = { x: 0, y: 0, z: 0.35 };
  zombie.vel = { x: 0, y: 0, z: -8 };
  zombie.yaw = Math.PI; // facing south (-Z) toward the portal
  zombie.alive = true;

  assert.equal(system.tryTraverse(zombie), true, 'zombie failed to traverse portal');
  assert.ok(zombie.pos.x < 10, 'zombie did not exit on the outward side');
  assert.ok(zombie.vel.x < -7.9, 'zombie velocity was not rotated through exit');
  assert.ok(zombie._portalCooldown > 0.2, 'zombie did not receive portal cooldown');
  assert.equal(system.tryTraverse(zombie), false, 'cooldown allowed immediate re-entry loop');
});

test('zombie movement update hands off wall collision to portal traversal', () => {
  const world = {
    inBounds: () => true,
    blocksAt: () => false,
    heightAt: () => 0,
    supportHeight: () => 0,
    isWalkable: (_x, z) => z >= 0,
    resolveProps: () => false,
  };
  const system = new PortalSystem(null, world);
  system.portals.blue = record('blue', { x: 0, y: 0.9, z: 0 }, { x: 0, y: 0, z: 1 });
  system.portals.orange = record('orange', { x: 12, y: 0.9, z: 0 }, { x: -1, y: 0, z: 0 });
  world.portalSystem = system;

  const zombie = new Enemy('grunt', world);
  zombie.pos = { x: 0, y: 0, z: 0.35 };
  zombie.vel = { x: 0, y: 0, z: -6 };
  zombie.onGround = true;

  // Integrate zombie motion: approaching z=0 hits the portal
  zombie._integrate(1 / 60, 0, 10);
  assert.ok(zombie.pos.x < 12 && zombie.pos.x > 11, 'zombie was not teleported through wall portal');
  assert.ok(zombie.vel.x < 0, 'zombie lost momentum during traversal');
});

test('wall placement clamps away from floor and supports multi-segment wall panels', () => {
  const wall1 = { type: 'wall', collider: { kind: 'box' } };
  const wall2 = { type: 'wall', collider: { kind: 'box' } };
  const world = {
    raycast(ox, oy, oz, dx, dy, dz, range) {
      if (dy < -0.9) {
        // Floor at y = 0
        return { hit: true, distance: oy, x: ox, y: 0, z: oz, nx: 0, ny: 1, nz: 0 };
      }
      if (dz < -0.8) {
        // Multi-segment wall at z = 0
        const prop = ox > 0 ? wall1 : wall2;
        const dist = oz / -dz;
        return { hit: true, distance: dist, x: ox + dx * dist, y: oy + dy * dist, z: 0,
          nx: 0, ny: 0, nz: 1, prop };
      }
      return { hit: false, distance: range };
    },
  };

  const scene = new THREE.Scene();
  const system = new PortalSystem(scene, world);
  const player = playerAt(0, 0, 3);

  // Aim low near floor: center should clamp upward so portal bottom stays above floor (y >= 0)
  const result = system.place('blue', player, { x: 0, y: -0.4, z: -0.9 });
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.portal.center.y - PORTAL_HALF_HEIGHT >= 0,
    'portal bottom penetrated floor');
});


test('an obstructed exit refuses traversal without moving the player', () => {
  const system = new PortalSystem(null, {blocksAt:()=>true});
  system.portals.blue = record('blue', {x:0,y:0.9,z:0}, {x:0,y:0,z:1});
  system.portals.orange = record('orange', {x:10,y:0.9,z:0}, {x:-1,y:0,z:0});
  const player = playerAt(0,0,0.32);player.vel.z=-12;
  const before={...player.pos};
  assert.equal(system.tryTraverse(player),false);
  assert.deepEqual(player.pos,before);
  assert.equal(player.vel.z,-12);
});

test('virtual camera position uses the same rigid transform as view direction', () => {
  const a=record('blue',{x:0,y:0,z:0},{x:0,y:1,z:0});
  const b=record('orange',{x:10,y:3,z:2},{x:1,y:0,z:0});
  const eye=new THREE.Vector3(1,4,2);
  const expected=b.center.clone().add(transformPortalVector(a,b,eye.clone().sub(a.center)));
  const mapped=transformPortalViewPosition(a,b,eye);
  assert.ok(mapped.distanceTo(expected)<1e-9);
  assert.ok(transformPortalViewPosition(b,a,mapped).distanceTo(eye)<1e-9);
});

test('walking through both placed portals exits safely in every generated district', () => {
  const world=new World(20260725);for(const _ of world.generate()){}
  for(const room of world.plan.rooms.filter(r=>r.parkour)){
    const player=new Player(world), system=new PortalSystem(null,world);player.portalSystem=system;
    player.spawn({x:room.cx,y:room.floorY,z:room.minZ+7});
    assert.equal(system.place('blue',player,{x:0,y:0,z:-1}).ok,true);
    player.spawn(room.portalProbe);assert.equal(system.place('orange',player,{x:1,y:0,z:0}).ok,true);
    let count=0;system.onTraverse=()=>count++;
    for(const kind of ['blue','orange']){
      const source=system.portals[kind],destination=system.portals[kind==='blue'?'orange':'blue'];
      player.spawn({x:source.center.x+source.normal.x*2,y:room.floorY,z:source.center.z+source.normal.z*2});
      player.yaw=Math.atan2(source.normal.x,source.normal.z);
      const before=count;
      for(let i=0;i<120&&count===before;i++){
        system.update(1/60);player.update(1/60,{actionDown:a=>a==='forward'});
      }
      assert.equal(count,before+1,`${room.label}: could not walk into ${kind}`);
      assert.ok(Math.hypot(player.pos.x-destination.center.x,player.pos.z-destination.center.z)<1);
      assert.equal(world.blocksAt(player.pos.x,player.pos.y,player.pos.z,player.half,player.height,.05),false);
      for(let i=0;i<24;i++)system.update(1/60);
    }
  }
});

test('off-centre floor entry emerges above ground at a wall exit',()=>{
  const system=new PortalSystem(null,{blocksAt:(_x,y)=>y<0});
  system.portals.blue=record('blue',{x:0,y:0,z:0},{x:0,y:1,z:0},{x:0,y:0,z:1});
  system.portals.orange=record('orange',{x:10,y:1.2,z:0},{x:1,y:0,z:0});
  const player=playerAt(0,0,-.6);player.vel.y=-20;
  assert.equal(system.tryTraverse(player),true);
  assert.ok(player.pos.y>=0,'exit placed feet below the floor');
  assert.ok(player.vel.x>19.9);
});

test('touching the visible side of a portal recentres the player at the exit',()=>{
  const system=new PortalSystem(null,null);
  system.portals.blue=record('blue',{x:0,y:1.2,z:0},{x:0,y:0,z:1});
  system.portals.orange=record('orange',{x:10,y:1.2,z:0},{x:1,y:0,z:0});
  const player=playerAt(.65,0,.4);player.vel.z=-8;
  assert.equal(system.tryTraverse(player),true);
  assert.ok(player.pos.x>10);
});

test('airborne portal entry takes priority over wall-run adhesion',()=>{
  const world={inBounds:()=>true,blocksAt:()=>false,supportHeight:()=>0,
    ceilingAt:()=>Infinity,resolveProps(){},isWalkable:()=>true,
    raycast:()=>({hit:true,nx:1,ny:0,nz:0,distance:.5,prop:{type:'wallseg'}})};
  const system=new PortalSystem(null,world);
  system.portals.blue=record('blue',{x:0,y:2,z:0},{x:1,y:0,z:0});
  system.portals.orange=record('orange',{x:10,y:2,z:0},{x:1,y:0,z:0});
  const p=new Player(world);p.portalSystem=system;p.spawn({x:.5,y:1,z:0});
  p.vel={x:-5,y:0,z:-5};p.yaw=Math.PI/4;
  p.update(1/60,{actionDown:a=>a==='forward'});
  assert.ok(p.pos.x>10,'wall adhesion cancelled the inward velocity');
  assert.equal(p.wallRunning,false);
});

test('placing a blocked exit retains the previous usable portal',()=>{
  const world=new World(20260725);for(const _ of world.generate()){}
  const room=world.plan.rooms.find(r=>r.parkour),p=new Player(world),s=new PortalSystem(null,world);
  p.spawn({x:room.cx,y:room.floorY,z:room.minZ+7});
  assert.equal(s.place('blue',p,{x:0,y:0,z:-1}).ok,true);
  const prior=s.portals.blue;world.blocksAt=()=>true;
  const rejected=s.place('blue',p,{x:0,y:0,z:-1});
  assert.equal(rejected.ok,false);assert.match(rejected.reason,/EXIT BLOCKED/);
  assert.equal(s.portals.blue,prior);
});
