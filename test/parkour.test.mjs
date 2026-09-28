import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/entities/player.js';
import { World } from '../src/world/world.js';
import { PortalSystem } from '../src/game/portals.js';
import * as THREE from '../vendor/three.module.js';
const input = (...keys) => ({ actionDown: a => keys.includes(a) });
const flat = () => ({ inBounds: () => true, blocksAt: () => false,
  supportHeight: () => 0, isWalkable: () => true, resolveProps() {}, ceilingAt: () => Infinity });

test('held bunnyhops build bounded speed and releasing jump permits normal stopping', () => {
  const p = new Player(flat()); p.spawn({x:0,y:0,z:0}); p.onGround = true;
  let jumps = 0; p.onJump = () => jumps++;
  for(let i=0;i<360;i++) p.update(1/60,input('forward','sprint','jump'));
  assert.ok(jumps >= 8);
  assert.ok(Math.hypot(p.vel.x,p.vel.z) > 8);
  assert.ok(Math.hypot(p.vel.x,p.vel.z) <= 14.001);
  for(let i=0;i<240;i++) p.update(1/60,input());
  assert.ok(Math.hypot(p.vel.x,p.vel.z) < 0.01);
});

test('air steering preserves portal launch speed above the ordinary movement cap', () => {
  const p = new Player(flat()); p.spawn({x:0,y:12,z:0}); p.vel.z=-24;
  p.update(1/60,input('forward','right'));
  assert.ok(Math.hypot(p.vel.x,p.vel.z) >= 23.999);
});

test('wall run reduces falling, jump pushes away, and releasing movement detaches', () => {
  const w=flat(); w.raycast=(_x,_y,_z,dx) => dx > 0
    ? {hit:true,nx:-1,ny:0,nz:0,prop:{type:'wallseg'}} : {hit:false};
  const p=new Player(w); p.spawn({x:0,y:8,z:0});p.vel.z=-8;
  p.update(1/60,input('forward'));
  assert.equal(p.wallRunning,true); assert.ok(p.vel.y > -0.1);
  p.update(1/60,input('forward','jump'));
  assert.equal(p.wallRunning,false);assert.ok(p.vel.x < -5);assert.ok(p.vel.y > 8);
  p.spawn({x:0,y:20,z:0});p.vel.z=-8;
  for(let i=0;i<160;i++)p.update(1/60,input('forward'));
  assert.equal(p.wallRunning,true);
  for(let i=0;i<30;i++)p.update(1/60,input());
  assert.equal(p.wallRunning,false); assert.ok(p.vel.y < -1.5);
});

test('respawn clears wall state and traversal cooldown counts down on player ticks', () => {
  const p=new Player(flat());p.spawn({x:0,y:0,z:0});p._portalCooldown=.32;
  for(let i=0;i<21;i++)p.update(1/60,input());
  assert.equal(p._portalCooldown,0);
  p.wallTime=1;p.wallRoll=.1;p.wallCooldown=1;p.spawn({x:0,y:0,z:0});
  assert.equal(p.wallTime,0);assert.equal(p.wallRoll,0);assert.equal(p.wallCooldown,0);
});

test('courts generate deterministically with clear entrances and usable paired portals', () => {
  for(const seed of [20260725,1337,42]) {
    const w=new World(seed);for(const _ of w.generate()){}
    const rooms=w.plan.rooms.filter(r=>r.parkour);assert.ok(rooms.length);
    for(const r of rooms) {
      const p=new Player(w);p.spawn(r.parkourEntry);
      assert.equal(w.blocksAt(p.pos.x,p.pos.y,p.pos.z,p.half,p.height,0.05),false);
      const portals=new PortalSystem(new THREE.Scene(),w);
      // Target directly from its own clear ground-level lane.
      p.spawn({x:r.cx,y:r.floorY,z:r.minZ+7});
      assert.equal(portals.place('blue',p,{x:0,y:0,z:-1}).ok,true);
      p.spawn(r.portalProbe);
      assert.equal(portals.place('orange',p,{x:1,y:0,z:0}).ok,true);
      assert.equal(portals.ready,true);
      portals.clear();
    }
  }
});

test('fast portal launches cannot tunnel through a thin wall', () => {
  const w = flat();
  w.blocksAt = (_x, _y, z, half) => z - half < 0.1 && z + half > -0.1;
  const p = new Player(w);p.spawn({x:0,y:10,z:0.55});p.vel.z=-90;
  p.update(1/60,input());
  assert.ok(p.pos.z >= 0.42, `crossed wall to ${p.pos.z}`);
  assert.equal(p.vel.z,0);
});

test('all varied district levels are reachable by walking their actual stairs', () => {
  const w=new World(20260725);for(const _ of w.generate()){}
  const courts=w.plan.rooms.filter(r=>r.parkour);
  assert.equal(courts.length,8);
  assert.equal(w.size,384);
  for(const r of courts){
    assert.ok(r.parkourLevels>=3 && r.parkourLevels<=8);
    const stairX=r.maxX-6,stairStart=r.maxZ-7;
    for(let level=1;level<r.parkourLevels;level++){
      const p=new Player(w);p.spawn({x:stairX,y:r.floorY+(level-1)*5,z:stairStart+.25});
      for(let i=0;i<175;i++)p.update(1/60,input('forward'));
      assert.ok(p.pos.y>=r.floorY+level*5-.05,
        `${r.label} floor ${level+1}: reached ${p.pos.y-r.floorY}`);
    }
  }
});

test('wall running works on every orientation, doors, and curved wall colliders', () => {
  for(const type of ['wallseg','door','furniture','pillar'])for(let i=0;i<12;i++){
    const a=i*Math.PI/6,nx=Math.cos(a),nz=Math.sin(a);
    const w=flat();w.raycast=(_x,_y,_z,dx,_dy,dz)=>dx*nx+dz*nz<-.98
      ?{hit:true,nx,ny:0,nz,distance:.4,prop:{type,collider:{kind:type==='pillar'?'cylinder':'box'}}}:{hit:false};
    const p=new Player(w);p.spawn({x:0,y:10,z:0});
    p.yaw=Math.atan2(nz,-nx);p.vel.x=-nz*8;p.vel.z=nx*8;
    p.update(1/60,input('forward'));
    assert.equal(p.wallRunning,true,`${type} angle ${i} could not run`);
  }
});

test('huge districts have distinct structural families and no colored wall stripes',()=>{
 const w=new World(20260725);for(const _ of w.generate()){}
 const rooms=w.plan.rooms.filter(r=>r.parkour);
 assert.equal(new Set(rooms.map(r=>r.parkourTheme.shape)).size,8);
 assert.equal(new Set(rooms.map(r=>r.parkourTheme.material)).size,8);
 for(const r of rooms){
  const landmarks=w.props.filter(p=>p.room===r.id&&p.parkour);
  assert.ok(landmarks.length>50);
 }
 assert.ok(!w.plan.parkourDecor.some(p=>/stripe|band|dash/.test(p.name)));
});

test('parallel routes support a real wall run and a jump to the opposite wall',()=>{
 const w=new World(20260725);for(const _ of w.generate()){}
 const rooms=w.plan.rooms.filter(r=>r.wallRunLanes?.length);
 assert.ok(rooms.length>=10,'wall routes should extend beyond the eight showcase districts');
 for(const room of rooms){
  const lane=room.wallRunLanes.find(l=>l.x===room.cx)??room.wallRunLanes[0];
  const p=new Player(w);p.spawn({x:lane.x-lane.gap/2+.42,y:lane.y+1,z:lane.z0+1});
  p.yaw=Math.PI;p.vel.z=7;
  p.update(1/60,input('forward'));
  assert.equal(p.wallRunning,true,`${room.label}: cannot attach to route wall`);
  p.update(1/60,input('forward','jump'));
  assert.ok(p.vel.x>5,`${room.label}: jump did not push toward opposite wall`);
  let transferred=false;
  for(let i=0;i<75;i++){
   p.update(1/60,input('forward'));
   if(p.wallRunning&&p.wallNormal.x<-.9){transferred=true;break;}
  }
  assert.ok(transferred,`${room.label}: opposite wall was not reachable`);
 }
});

test('city blocks keep full clear alleys and use solid varied skyline masses',()=>{
 const w=new World(20260725);for(const _ of w.generate()){}
 const blocks=w.props.filter(p=>p.name==='city-block');
 assert.ok(blocks.length>=48);
 assert.ok(new Set(blocks.map(p=>p.sy)).size>=4);
 for(const r of w.plan.rooms.filter(r=>r.parkour))for(const lane of r.wallRunLanes){
  for(let z=lane.z0+.5;z<lane.z1-.5;z+=1){
   assert.equal(w.blocksAt(lane.x,lane.y+.05,z,.32,1.8,.05),false,
    `${r.label}: blocked alley at ${lane.x}, ${z}`);
  }
 }
 const facades=w.plan.parkourDecor.filter(p=>p.name==='weathered-facade');
 assert.ok(facades.length>100 && facades.length<1500);
 assert.ok(facades.every(p=>!p.collider && Math.abs(p.sy/4.2-Math.round(p.sy/4.2))<.001));
});


test('continuous wall runs sustain for 30 seconds at 30, 60 and 120 Hz',()=>{
 for(const hz of [30,60,120]){
  const w=flat();w.raycast=(_x,_y,_z,dx)=>dx>.98
   ?{hit:true,nx:-1,ny:0,nz:0,distance:.4}:{hit:false};
  const p=new Player(w);p.spawn({x:0,y:40,z:0});p.vel.z=-8;
  for(let i=0;i<hz*30;i++)p.update(1/hz,input('forward'));
  assert.equal(p.wallRunning,true);
  assert.ok(p.pos.y>26,'run should lose height slowly, not fall');
  assert.ok(-p.pos.z>=250,'running speed should carry the player through long routes');
  assert.ok(Math.abs(p.vel.z)<=14,'wall adhesion must not accumulate unlimited speed');
 }
});

test('actual city cross-streets preserve a wall run without a jump',()=>{
 const w=new World(20260725);for(const _ of w.generate()){}
 for(const hz of [30,60,120])for(const r of w.plan.rooms.filter(r=>r.parkour)){
  const lanes=r.wallRunLanes.filter(l=>l.x===r.cx).sort((a,b)=>a.z0-b.z0);
  if(lanes.length<2)continue;
  const a=lanes[0],b=lanes[1];
  const p=new Player(w);p.spawn({x:a.x-a.gap/2+.42,y:a.y+2,z:a.z1-2});
  p.yaw=Math.PI;p.vel.z=8.5;
  for(let i=0;i<Math.ceil((b.z0-a.z1+4)/8.5*hz);i++){
   p.update(1/hz,input('forward'));
   assert.equal(p.wallRunning,true,`${r.label} at ${hz} Hz lost wall near ${p.pos.z}`);
  }
  assert.ok(p.pos.z>b.z0);
 }
});

test('early wall jump is buffered but holding jump does not repeatedly launch',()=>{
 const w=flat();let contact=false;
 w.raycast=(_x,_y,_z,dx)=>contact&&dx>.98
  ?{hit:true,nx:-1,ny:0,nz:0,distance:.4}:{hit:false};
 const p=new Player(w);p.spawn({x:0,y:20,z:0});p.vel.z=-8;
 p.update(1/60,input('forward','jump'));
 for(let i=0;i<4;i++)p.update(1/60,input('forward','jump'));
 contact=true;p.update(1/60,input('forward','jump'));
 assert.ok(p.vel.x<=-6);assert.ok(p.vel.y>8);
 let jumps=0;p.onJump=()=>jumps++;
 for(let i=0;i<90;i++)p.update(1/60,input('forward','jump'));
 assert.equal(jumps,0);
});

test('wall grace expires over open space and movement lock cancels it',()=>{
 const w=flat();let contact=true;
 w.raycast=(_x,_y,_z,dx)=>contact&&dx>.98
  ?{hit:true,nx:-1,ny:0,nz:0,distance:.4}:{hit:false};
 const p=new Player(w);p.spawn({x:0,y:20,z:0});p.vel.z=-8;
 p.update(1/60,input('forward'));contact=false;
 for(let i=0;i<40;i++)p.update(1/60,input('forward'));
 assert.equal(p.wallRunning,false);assert.ok(p.vel.y<-1);
 contact=true;p.update(1/60,input('forward'));
 p.update(1/60,input('forward'),false);
 assert.equal(p.wallRunning,false);
});

test('steering away from a wall detaches instead of cancelling escape input',()=>{
 const w=flat();w.raycast=(_x,_y,_z,dx)=>dx>.98
  ?{hit:true,nx:-1,ny:0,nz:0,distance:.4}:{hit:false};
 const p=new Player(w);p.spawn({x:0,y:20,z:0});p.vel.z=-8;
 p.update(1/60,input('forward'));
 assert.equal(p.wallRunning,true);
 p.update(1/60,input('forward','left'));
 assert.equal(p.wallRunning,false);assert.ok(p.vel.x<0);
});
