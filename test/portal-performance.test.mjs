import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import { Merger } from '../src/render/archmesh.js';
import { PortalSystem, clipPortalCamera } from '../src/game/portals.js';
import { World } from '../src/world/world.js';
import { Player } from '../src/entities/player.js';

test('spatial building batches let a camera reject distant geometry without losing material identity',()=>{
 const merger=new Merger(64);
 for(const x of [0,200])merger.addBox('stone',{x,y:1,z:0,sx:3,sy:2,sz:3});
 const geometries=[...merger.build().values()];
 assert.equal(geometries.length,2);
 assert.ok(geometries.every(g=>g.userData.materialKey==='stone'));
 const camera=new THREE.PerspectiveCamera(78,16/9,.05,80);
 camera.position.set(0,1,6);camera.updateMatrixWorld(true);
 const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4()
  .multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse));
 assert.equal(geometries.filter(g=>frustum.intersectsSphere(g.boundingSphere)).length,1);
 assert.equal(geometries[0].attributes.position.count,geometries[1].attributes.position.count);
 geometries.forEach(g=>g.dispose());
});

test('repositioning a portal reuses its render target and leaves the scene light count stable',()=>{
 const world=new World(20260725);for(const _ of world.generate()){}
 const room=world.plan.rooms.find(r=>r.parkour),scene=new THREE.Scene();
 const system=new PortalSystem(scene,world),player=new Player(world);
 player.spawn({x:room.cx,y:room.floorY,z:room.minZ+7});
 assert.ok(system.place('blue',player,{x:0,y:0,z:-1}).ok);
 const target=system.portals.blue.target;let disposals=0;
 target.addEventListener('dispose',()=>disposals++);
 for(let i=0;i<8;i++){
  assert.ok(system.place('blue',player,{x:0,y:0,z:-1}).ok);
  assert.equal(system.portals.blue.target,target);
 }
 let lights=0;scene.traverse(o=>{if(o.isLight)lights++;});
 assert.equal(lights,0,'placing portals should not trigger new lit shader variants');
 assert.equal(disposals,0);
 system.clear();assert.equal(disposals,1);
});

test('portal projection clips the wall behind the exit without clipping the destination',()=>{
 const camera=new THREE.PerspectiveCamera(78,16/9,.05,140);
 camera.position.set(0,1,-3);camera.lookAt(0,1,0);camera.updateMatrixWorld(true);
 clipPortalCamera(camera,new THREE.Plane(new THREE.Vector3(0,0,1),0));
 const behind=new THREE.Vector3(0,1,-.1).project(camera);
 const ahead=new THREE.Vector3(0,1,.1).project(camera);
 assert.ok(behind.z < -1,`wall behind exit was visible: ${behind.z}`);
 assert.ok(ahead.z >= -1 && ahead.z <= 1,`destination was clipped: ${ahead.z}`);
});
