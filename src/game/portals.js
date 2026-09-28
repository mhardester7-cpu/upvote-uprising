// Paired player portals: placement, rendering, and momentum-preserving travel.
//
// Portals deliberately live outside the combat resolver. They do not deal
// damage and they are local traversal aids, so a shot only asks the world for
// a surface and movement calls tryTraverse() when the player reaches it.

import * as THREE from '../../vendor/three.module.js';

export const PORTAL_RANGE = 120;
export const PORTAL_HALF_WIDTH = 0.78;
export const PORTAL_HALF_HEIGHT = 1.16;

const COLORS = Object.freeze({ blue: 0x28a9ff, orange: 0xff8b24 });
const FORWARD = new THREE.Vector3(0, 0, 1);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const VIEW_WIDTH = 512;
const VIEW_HEIGHT = 288;
const VIEW_QUALITY = Object.freeze([
  { width: 320, refreshHz: 20 },
  { width: VIEW_WIDTH, refreshHz: 30 },
  { width: 768, refreshHz: 30 },
]);

/** Clip against the exit in projection space. Unlike renderer clipping planes,
 * this needs no additional material/shader variants when the gun is fired. */
export function clipPortalCamera(camera, plane) {
  const local=plane.clone().applyMatrix4(camera.matrixWorldInverse);
  const clip=new THREE.Vector4(local.normal.x,local.normal.y,local.normal.z,local.constant);
  const p=camera.projectionMatrix.elements;
  const q=new THREE.Vector4((Math.sign(clip.x)+p[8])/p[0],
    (Math.sign(clip.y)+p[9])/p[5],-1,(1+p[10])/p[14]);
  const denominator=clip.dot(q);
  if(Math.abs(denominator)<1e-6)return;
  clip.multiplyScalar(2/denominator);
  p[2]=clip.x;p[6]=clip.y;p[10]=clip.z+1;p[14]=clip.w;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

function vec(value) {
  return value?.isVector3
    ? value.clone()
    : new THREE.Vector3(value?.x ?? 0, value?.y ?? 0, value?.z ?? 0);
}

/** Stable right/up axes for an arbitrarily oriented portal plane. */
export function portalBasis(normalValue, preferredUpValue = WORLD_UP) {
  const normal = vec(normalValue).normalize();
  let up = vec(preferredUpValue);
  up.addScaledVector(normal, -up.dot(normal));
  if (up.lengthSq() < 1e-6) {
    up.set(0, 0, 1).addScaledVector(normal, -normal.z);
    if (up.lengthSq() < 1e-6) up.set(1, 0, 0).addScaledVector(normal, -normal.x);
  }
  up.normalize();
  const right = new THREE.Vector3().crossVectors(up, normal).normalize();
  up.crossVectors(normal, right).normalize();
  return { right, up, normal };
}

/**
 * Rotate a direction through a pair of portals. Crossing reverses the local
 * right and normal axes, the half-turn that makes inward momentum emerge out.
 */
export function transformPortalVector(source, destination, value) {
  const v = vec(value);
  const x = v.dot(source.right);
  const y = v.dot(source.up);
  const z = v.dot(source.normal);
  return new THREE.Vector3()
    .addScaledVector(destination.right, -x)
    .addScaledVector(destination.up, y)
    .addScaledVector(destination.normal, -z);
}

/** Camera position on the destination side for a viewer facing the entrance. */
export function transformPortalViewPosition(source, destination, value) {
  const rel = vec(value).sub(source.center);
  const x = rel.dot(source.right);
  const y = rel.dot(source.up);
  const z = rel.dot(source.normal);
  // Position and direction use the same rigid half-turn. The virtual eye
  // sits behind the exit plane; clipping removes the wall in front of it.
  return destination.center.clone()
    .addScaledVector(destination.right, -x)
    .addScaledVector(destination.up, y)
    .addScaledVector(destination.normal, -z);
}

function portalMesh(kind) {
  const color = COLORS[kind];
  const group = new THREE.Group();
  group.name = `portal:${kind}`;

  const mouth = new THREE.Mesh(
    new THREE.CircleGeometry(1, 64),
    new THREE.MeshBasicMaterial({
      color: kind === 'blue' ? 0x082548 : 0x481e08,
      transparent: true,
      opacity: 0.94,
      side: THREE.FrontSide,
      depthWrite: false,
      toneMapped: true,
    }),
  );
  // Project the destination image using screen coordinates, rather than
  // stretching an entire camera frame into the ellipse like a television.
  mouth.material.onBeforeCompile = (shader) => {
    shader.vertexShader = 'varying vec4 vPortalClip;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\nvPortalClip = gl_Position;');
    shader.fragmentShader = 'varying vec4 vPortalClip;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
      '#ifdef USE_MAP\ndiffuseColor *= texture2D(map, vPortalClip.xy / vPortalClip.w * 0.5 + 0.5);\n#endif');
  };
  mouth.scale.set(PORTAL_HALF_WIDTH, PORTAL_HALF_HEIGHT, 1);
  mouth.position.z = 0.012;
  mouth.renderOrder = 3;
  group.add(mouth);

  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.025, 12, 96),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 1.0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  halo.scale.set(PORTAL_HALF_WIDTH, PORTAL_HALF_HEIGHT, 1);
  halo.position.z = 0.025;
  halo.renderOrder = 4;
  group.add(halo);

  const inner = halo.clone();
  inner.material = halo.material.clone();
  inner.material.opacity = 0.55;
  inner.scale.multiplyScalar(0.92);
  inner.position.z = 0.032;
  group.add(inner);

  const glowRing = new THREE.Mesh(
    new THREE.RingGeometry(0.86, 1.06, 64),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.72,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  glowRing.scale.set(PORTAL_HALF_WIDTH, PORTAL_HALF_HEIGHT, 1);
  glowRing.position.z = 0.020;
  glowRing.renderOrder = 4;
  group.add(glowRing);

  // Animated filaments follow the elliptical aperture. Analytic noise keeps
  // the effect resolution-independent and avoids external sprite downloads.
  const energy = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 3.3), new THREE.ShaderMaterial({
    uniforms: { time: {value:0}, tint: {value:new THREE.Color(color)}, surge: {value:1} },
    vertexShader: `varying vec2 vUv;
      void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `varying vec2 vUv; uniform float time; uniform vec3 tint; uniform float surge;
      void main(){
        vec2 p=(vUv-.5)*vec2(2.2/0.78,3.3/1.16);
        float r=length(p), a=atan(p.y,p.x);
        float wav=sin(a*13.+time*7.)*.012+sin(a*29.-time*11.)*.006;
        float core=exp(-abs(r-1.+wav)*95.);
        float corona=exp(-abs(r-1.02)*17.)*.22;
        float threads=pow(max(0.,sin(a*8.-time*5.+r*29.)),14.)*
          exp(-abs(r-1.08+sin(a*3.+time)*.045)*30.);
        float inward=pow(max(0.,sin(a*6.+r*38.-time*8.)),20.)*
          smoothstep(.68,1.,r)*(1.-smoothstep(.98,1.08,r))*.25;
        float flash=surge*exp(-abs(r-(.85+(1.-surge)*.48))*35.);
        float alpha=core*.85+corona+threads*.65+inward+flash;
        if(alpha<.008)discard;
        gl_FragColor=vec4(mix(tint,vec3(1.),core*.45),alpha);
      }`,
    transparent:true,depthWrite:false,side:THREE.DoubleSide,
    blending:THREE.AdditiveBlending,toneMapped:false,
  }));
  energy.position.z=.055;energy.renderOrder=5;group.add(energy);
  const sparkPositions=new Float32Array(72*3);
  const sparkGeometry=new THREE.BufferGeometry();
  sparkGeometry.setAttribute('position',new THREE.BufferAttribute(sparkPositions,3));
  const sparks=new THREE.Points(sparkGeometry,new THREE.PointsMaterial({
    color,size:.035,transparent:true,opacity:.8,depthWrite:false,
    blending:THREE.AdditiveBlending,toneMapped:false,
  }));
  sparks.frustumCulled=false;group.add(sparks);
  group.userData.energy=energy;
  group.userData.sparks=sparks;
  group.userData.age=0;
  group.userData.surge=1;
  // Emissive filaments provide the glow without changing the scene light
  // count and recompiling every lit material each time a portal is placed.
  group.userData.mouth = mouth;
  group.userData.halo = halo;
  group.userData.inner = inner;
  group.userData.glowRing = glowRing;

  return group;
}

function disposeGroup(group) {
  group?.traverse((part) => {
    part.geometry?.dispose?.();
    if (Array.isArray(part.material)) part.material.forEach((m) => m.dispose?.());
    else part.material?.dispose?.();
  });
}

function viewTarget(kind) {
  const target = new THREE.WebGLRenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    depthBuffer: true,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });
  target.texture.name = `portal-view:${kind}`;
  target.texture.colorSpace = THREE.SRGBColorSpace;
  target.texture.generateMipmaps = false;
  return target;
}

export class PortalSystem {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.portals = { blue: null, orange: null };
    this.cooldown = 0;
    this.time = 0;
    this.transitPulse = 0;
    this.shotEffects = [];
    this.viewCamera = new THREE.PerspectiveCamera(78, VIEW_WIDTH / VIEW_HEIGHT, 0.05, 1000);
    this.viewFailed = false;
    this.lastViewTime = -Infinity;
    this.viewFrameTime = 1 / 60;
    this.viewQuality = 1;
    this.lastQualityChange = -Infinity;
    this.viewStats = { passes: 0, visible: 0, quality: 'balanced', refreshHz: 30 };
    this.onPlaced = null;
    this.onRejected = null;
    this.onTraverse = null;
    this.onBlocked = null;
    this.blockedCooldown = 0;
  }

  setWorld(world) {
    if (world === this.world) return;
    this.clear();
    this.world = world;
  }

  clear() {
    for(const fx of this.shotEffects){this.scene?.remove(fx.group);disposeGroup(fx.group);}
    this.shotEffects.length=0;
    this.transitPulse=0;
    for (const kind of ['blue', 'orange']) {
      const portal = this.portals[kind];
      if (!portal) continue;
      this.scene?.remove(portal.group);
      disposeGroup(portal.group);
      portal.target?.dispose?.();
      this.portals[kind] = null;
    }
    this.cooldown = 0;
    this.viewFailed = false;
    this.lastViewTime = -Infinity;
    this.viewStats = { passes: 0, visible: 0, quality: 'balanced', refreshHz: 30 };
  }

  get ready() { return !!(this.portals.blue && this.portals.orange); }

  /**
   * The main loop supplies display frame time, not simulation time. Portal
   * views use that headroom to sharpen close apertures on fast machines and
   * reduce their work before they can become a source of frame drops.
   */
  setFrameTime(frameDt) {
    if (!Number.isFinite(frameDt) || frameDt <= 0) return;
    const sample = Math.min(0.1, Math.max(1 / 240, frameDt));
    this.viewFrameTime += (sample - this.viewFrameTime) * 0.08;
    const desired = this.viewFrameTime < 1 / 56 ? 2
      : this.viewFrameTime < 1 / 38 ? 1 : 0;
    // Falling back needs to happen promptly. Raising resolution waits for a
    // sustained budget so a single fast frame cannot start a hitch cycle.
    if (desired < this.viewQuality
      || (desired > this.viewQuality && this.time - this.lastQualityChange > 0.9)) {
      this.viewQuality = desired;
      this.lastQualityChange = this.time;
    }
  }

  // World-compatible fallbacks let projectile and combat code accept this
  // object without special-casing every ordinary ray or line-of-sight query.
  raycast(...args) { return this.world.raycast(...args); }
  lineOfSight(...args) { return this.world.lineOfSight(...args); }

  _portalAtHit(hit, direction) {
    if (!this.ready || !hit?.hit) return null;
    for (const portal of [this.portals.blue, this.portals.orange]) {
      if (direction.dot(portal.normal) >= -1e-4) continue;
      const point = new THREE.Vector3(hit.x, hit.y, hit.z);
      const rel = point.sub(portal.center);
      if (Math.abs(rel.dot(portal.normal)) > 0.18) continue;
      if (Math.abs(rel.dot(portal.right)) > PORTAL_HALF_WIDTH * 0.96) continue;
      if (Math.abs(rel.dot(portal.up)) > PORTAL_HALF_HEIGHT * 0.96) continue;
      const alignment = hit.nx * portal.normal.x
        + hit.ny * portal.normal.y + hit.nz * portal.normal.z;
      if (alignment < 0.85) continue;
      return portal;
    }
    return null;
  }

  /**
   * A world ray expressed as linked straight segments. Hitscan rounds and
   * rockets consume the same representation, so both enter the exact aperture
   * the player sees and leave with the same half-turn transform.
   */
  raycastSegments(ox, oy, oz, dx, dy, dz, maxDist = 400, maxHops = 4) {
    let origin = new THREE.Vector3(ox, oy, oz);
    let direction = new THREE.Vector3(dx, dy, dz).normalize();
    let remaining = maxDist;
    let travelled = 0;
    let hops = 0;
    const segments = [];

    while (remaining > 1e-6) {
      const hit = this.world.raycast(
        origin.x, origin.y, origin.z,
        direction.x, direction.y, direction.z, remaining,
      );
      const length = hit.hit ? Math.max(0, Math.min(remaining, hit.distance)) : remaining;
      const end = hit.hit
        ? new THREE.Vector3(hit.x, hit.y, hit.z)
        : origin.clone().addScaledVector(direction, length);
      const portal = hops < maxHops ? this._portalAtHit(hit, direction) : null;
      segments.push({
        origin: { x: origin.x, y: origin.y, z: origin.z },
        direction: { x: direction.x, y: direction.y, z: direction.z },
        end: { x: end.x, y: end.y, z: end.z },
        length,
        offset: travelled,
        portal: portal?.kind ?? null,
      });
      travelled += length;
      remaining -= length;

      if (!portal || remaining <= 1e-6) {
        return {
          segments, hit, totalDistance: travelled, hops,
          end: { x: end.x, y: end.y, z: end.z },
          endDirection: { x: direction.x, y: direction.y, z: direction.z },
        };
      }

      const destination = portal.kind === 'blue' ? this.portals.orange : this.portals.blue;
      const rel = end.clone().sub(portal.center);
      const x = rel.dot(portal.right);
      const y = rel.dot(portal.up);
      origin = destination.center.clone()
        .addScaledVector(destination.right, -x)
        .addScaledVector(destination.up, y)
        .addScaledVector(destination.normal, 0.065);
      direction = transformPortalVector(portal, destination, direction).normalize();
      hops += 1;
    }

    return {
      segments, hit: { hit: false, distance: maxDist }, totalDistance: travelled, hops,
      end: { x: origin.x, y: origin.y, z: origin.z },
      endDirection: { x: direction.x, y: direction.y, z: direction.z },
    };
  }

  /** Place one end on the surface under the player's crosshair. */
  place(kind, player, direction = null) {
    if (!(kind in COLORS) || !this.world || !player) return { ok: false, reason: 'invalid' };
    const dir = direction ?? player.getLookDir({});
    const hit = this.world.raycast(
      player.pos.x, player.eyeY, player.pos.z,
      dir.x, dir.y, dir.z, PORTAL_RANGE,
    );
    if (!hit.hit) return this._reject(kind, 'NO SURFACE IN RANGE', hit);
    if (hit.prop?.collider?.kind === 'cylinder') {
      return this._reject(kind, 'PORTALS NEED A FLAT SURFACE', hit);
    }
    if (hit.prop?.type === 'door') {
      return this._reject(kind, 'PORTAL CANNOT ANCHOR TO A DOOR', hit);
    }

    const normal = new THREE.Vector3(hit.nx, hit.ny, hit.nz).normalize();
    const preferredUp = Math.abs(normal.y) > 0.85
      ? new THREE.Vector3(-dir.x, 0, -dir.z)
      : WORLD_UP;
    const basis = portalBasis(normal, preferredUp);
    const center = new THREE.Vector3(hit.x, hit.y, hit.z);

    // On vertical walls, lower the portal so the player body fits through, but
    // clamp against floor and ceiling so the aperture never extends underground
    // or through overhead slabs.
    if (Math.abs(normal.y) < 0.85) {
      center.addScaledVector(basis.up, -0.70);

      const probeOffset = 0.05;
      const downRay = this.world.raycast(
        center.x + normal.x * probeOffset, center.y, center.z + normal.z * probeOffset,
        0, -1, 0, 6.0,
      );
      if (downRay.hit) {
        const minCenterY = downRay.y + PORTAL_HALF_HEIGHT + 0.04;
        if (center.y < minCenterY) center.y = minCenterY;
      }

      const upRay = this.world.raycast(
        center.x + normal.x * probeOffset, center.y, center.z + normal.z * probeOffset,
        0, 1, 0, 6.0,
      );
      if (upRay.hit) {
        const maxCenterY = upRay.y - PORTAL_HALF_HEIGHT - 0.04;
        if (center.y > maxCenterY) center.y = maxCenterY;
      }
    }

    if (!this._surfaceFits(center, basis, hit.prop)) {
      return this._reject(kind, 'NOT ENOUGH FLAT SURFACE', hit);
    }
    // Anchoring a picture to a wall is not enough: the player's complete body
    // must also fit on its outward side before we replace an existing portal.
    const placement = {center, ...basis};
    if (!this._exitPosition(placement, 0, 0, player.height ?? 1.8, player.half ?? .32)) {
      return this._reject(kind, 'EXIT BLOCKED — CHOOSE A CLEAR WALL OR FLOOR', hit);
    }
    const other = this.portals[kind === 'blue' ? 'orange' : 'blue'];
    if (other && center.distanceTo(other.center) < PORTAL_HALF_HEIGHT * 1.7) {
      return this._reject(kind, 'PORTALS CANNOT OVERLAP', hit);
    }

    const prior = this.portals[kind];
    if (prior) {
      this.scene?.remove(prior.group);
      disposeGroup(prior.group);

    }
    const group = portalMesh(kind);
    group.position.copy(center).addScaledVector(normal, 0.018);
    const matrix = new THREE.Matrix4().makeBasis(basis.right, basis.up, basis.normal);
    group.quaternion.setFromRotationMatrix(matrix);
    this.scene?.add(group);

    const portal = {
      kind, center, ...basis, group, prop: hit.prop ?? null,
      target: prior?.target ?? viewTarget(kind),
    };
    this.portals[kind] = portal;
    this.lastKind = kind;
    this._animateShot(player, center, COLORS[kind]);
    this.onPlaced?.(kind, hit, this.ready);
    return { ok: true, kind, hit, portal, ready: this.ready };
  }

  _exitPosition(destination, x, y, height, half) {
    const extent = Math.abs(destination.normal.y)*height*.5
      + (Math.abs(destination.normal.x)+Math.abs(destination.normal.z))*half;
    const rightExtent = Math.abs(destination.right.y)*height*.5
      + (Math.abs(destination.right.x)+Math.abs(destination.right.z))*half;
    const upExtent = Math.abs(destination.up.y)*height*.5
      + (Math.abs(destination.up.x)+Math.abs(destination.up.z))*half;
    const clamp = (v,limit)=>Math.max(-Math.max(0,limit),Math.min(Math.max(0,limit),v));
    // A floor's lateral offset becomes height at a wall exit. Clamp to the
    // destination's body-sized opening instead of putting the feet underground.
    const ox=clamp(-x,PORTAL_HALF_WIDTH-rightExtent);
    const oy=clamp(y,PORTAL_HALF_HEIGHT-upExtent);
    for(const [rx,uy] of [[ox,oy],[0,0]]){
      const center=destination.center.clone().addScaledVector(destination.right,rx)
        .addScaledVector(destination.up,uy).addScaledVector(destination.normal,extent+.15);
      const foot=center.y-height*.5;
      if(this.world?.inBounds && !this.world.inBounds(center.x,center.z))continue;
      if(this.world?.heightAt && foot < this.world.heightAt(center.x,center.z)-.05)continue;
      if(this.world?.blocksAt?.(center.x,foot,center.z,half,height,.05))continue;
      return center;
    }
    return null;
  }

  _animateShot(player, end, color) {
    if(!this.scene)return;
    const start=new THREE.Vector3(player.pos.x,player.eyeY-.12,player.pos.z);
    const direction=end.clone().sub(start);const length=direction.length();
    const group=new THREE.Group();group.position.copy(start);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),direction.normalize());
    const beam=new THREE.Mesh(new THREE.CylinderGeometry(.014,.024,1,8),
      new THREE.MeshBasicMaterial({color,transparent:true,opacity:.8,depthWrite:false,
        blending:THREE.AdditiveBlending,toneMapped:false}));
    beam.geometry.rotateX(Math.PI/2);group.add(beam);
    const head=new THREE.Mesh(new THREE.SphereGeometry(.075,12,8),
      new THREE.MeshBasicMaterial({color,toneMapped:false}));group.add(head);
    this.scene.add(group);this.shotEffects.push({group,beam,head,length,age:0});
    if(this.shotEffects.length>8){const old=this.shotEffects.shift();this.scene.remove(old.group);disposeGroup(old.group);}
  }

  _reject(kind, reason, hit) {
    this.onRejected?.(kind, reason, hit);
    return { ok: false, kind, reason, hit };
  }

  /** The whole ellipse must land on the same sufficiently planar surface. */
  _surfaceFits(center, basis, prop) {
    // Test the perimeter as well as the centre so corners and thin ledges
    // cannot leave an aperture floating beyond its supporting surface.
    const samples = [[0, 0]];
    for (let i = 0; i < 12; i++) {
      const angle = i / 12 * Math.PI * 2;
      samples.push([Math.cos(angle) * PORTAL_HALF_WIDTH,
        Math.sin(angle) * PORTAL_HALF_HEIGHT]);
    }
    for (const [x, y] of samples) {
      const start = center.clone()
        .addScaledVector(basis.right, x)
        .addScaledVector(basis.up, y)
        .addScaledVector(basis.normal, 0.24);
      const h = this.world.raycast(
        start.x, start.y, start.z,
        -basis.normal.x, -basis.normal.y, -basis.normal.z, 0.55,
      );
      if (!h.hit) return false;
      if (h.prop?.type === 'door') return false;
      if (prop && h.prop && h.prop !== prop) {
        // Multi-segment walls and box colliders on the same plane are fully valid
        const isWallLike = (h.prop.type === prop.type)
          || (h.prop.collider?.kind === 'box' && prop.collider?.kind === 'box');
        if (!isWallLike) return false;
      }
      const alignment = h.nx * basis.normal.x + h.ny * basis.normal.y + h.nz * basis.normal.z;
      if (alignment < 0.86) return false;

      // Ensure the hit surface is coplanar with the portal plane
      const relX = h.x - center.x;
      const relY = h.y - center.y;
      const relZ = h.z - center.z;
      const planeDist = relX * basis.normal.x + relY * basis.normal.y + relZ * basis.normal.z;
      if (Math.abs(planeDist) > 0.24) return false;
    }
    return true;
  }

  update(dt) {
    this.time += dt;
    this.transitPulse=Math.max(0,this.transitPulse-dt*2.8);
    this.blockedCooldown=Math.max(0,this.blockedCooldown-dt);
    for(let i=this.shotEffects.length-1;i>=0;i--){
      const fx=this.shotEffects[i];fx.age+=dt;
      if(fx.age>.28){this.scene?.remove(fx.group);disposeGroup(fx.group);this.shotEffects.splice(i,1);continue;}
      const travel=Math.min(1,fx.age/.12)*fx.length;
      const trail=Math.min(travel,3.5);
      fx.beam.scale.z=Math.max(.001,trail);fx.beam.position.z=travel-trail*.5;
      fx.beam.material.opacity=Math.max(0,1-fx.age/.28)*.8;
      fx.head.position.z=travel;fx.head.scale.setScalar(Math.max(.01,1-fx.age/.28));
    }
    this.cooldown = Math.max(0, this.cooldown - dt);
    for (const kind of ['blue', 'orange']) {
      const p = this.portals[kind];
      if (!p) continue;
      const data=p.group.userData;
      data.age=(data.age??0)+dt;
      data.surge=Math.max(0,(data.surge??0)-dt*1.8);
      const open=Math.min(1,data.age/.45);
      p.group.scale.setScalar(Math.max(.015,1-Math.pow(1-open,3)));
      if(data.energy){
        data.energy.material.uniforms.time.value=this.time;
        data.energy.material.uniforms.surge.value=data.surge;
        const positions=data.sparks.geometry.attributes.position;
        for(let i=0;i<positions.count;i++){
          const phase=(this.time*(.38+(i%5)*.035)+i*.618)%1;
          const a=i*2.39996+this.time*(kind==='blue'?1:-1)*.55;
          const radius=1+phase*.28;
          positions.setXYZ(i,Math.cos(a)*PORTAL_HALF_WIDTH*radius,
            Math.sin(a)*PORTAL_HALF_HEIGHT*radius-phase*.16,.05+Math.sin(phase*Math.PI)*.18);
        }
        positions.needsUpdate=true;
      }
      const pulse = 0.5 + Math.sin(this.time * 5.5 + (kind === 'blue' ? 0 : Math.PI)) * 0.5;
      p.group.userData.halo.material.opacity = 0.85 + pulse * 0.15;
      p.group.userData.inner.rotation.z += dt * (kind === 'blue' ? 0.9 : -0.9);
      p.group.userData.glowRing.material.opacity = 0.55 + pulse * 0.35;

    }
  }

  /**
   * Render a budgeted visible destination view before the main world
   * pass. Portal geometry is hidden only for the auxiliary pass, which
   * prevents feedback recursion while leaving both emissive rings in the real
   * camera. A failed GPU allocation degrades to the original dark aperture.
   */
  renderViews(renderer, scene, mainCamera) {
    this.viewStats.passes=0;
    if (!this.ready || this.viewFailed || !renderer || !scene || !mainCamera) return false;
    const quality = VIEW_QUALITY[this.viewQuality];
    this.viewStats.quality = this.viewQuality === 2 ? 'high' : this.viewQuality === 1 ? 'balanced' : 'safe';
    this.viewStats.refreshHz = quality.refreshHz;
    const entries = [this.portals.blue, this.portals.orange];
    mainCamera.updateMatrixWorld(true);
    const frustum=new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(mainCamera.projectionMatrix,mainCamera.matrixWorldInverse));
    const visible=entries.filter(p=>{
      const offset=mainCamera.position.clone().sub(p.center);
      return offset.dot(p.normal)>.015 && offset.lengthSq()<120*120
        && frustum.intersectsSphere(new THREE.Sphere(p.center,1.5));
    });
    this.viewStats.visible=visible.length;
    if(!visible.length || this.time-this.lastViewTime<1/quality.refreshHz-1e-6)return false;
    // One auxiliary pass at most; if both mouths are visible, update the
    // oldest view first. Traversal and the main camera still run every frame.
    visible.sort((a,b)=>(a.lastViewTime??-Infinity)-(b.lastViewTime??-Infinity));
    const selected=visible.find(p=>{
      if(!this.world?.raycast)return true;
      const delta=p.center.clone().sub(mainCamera.position),distance=delta.length();
      delta.normalize();
      const hit=this.world.raycast(mainCamera.position.x,mainCamera.position.y,mainCamera.position.z,
        delta.x,delta.y,delta.z,distance);
      return !hit.hit || hit.distance>=distance-.2;
    });
    if(!selected)return false;
    const oldTarget = renderer.getRenderTarget();
    const oldAutoClear = renderer.autoClear;
    const oldShadowAuto = renderer.shadowMap?.autoUpdate;
    const oldLocalClipping = renderer.localClippingEnabled;
    const oldClippingPlanes = renderer.clippingPlanes;
    const visibilities = entries.map((p) => p.group.visible);

    try {
      for (const p of entries) p.group.visible = false;
      renderer.autoClear = false;
      if (renderer.shadowMap) renderer.shadowMap.autoUpdate = false;


      for (const source of [selected]) {
        const destination = source.kind === 'blue' ? this.portals.orange : this.portals.blue;
        const camera = this.viewCamera;
        camera.fov = mainCamera.fov;
        camera.aspect = mainCamera.aspect;
        camera.near = Math.max(0.025, mainCamera.near ?? 0.025);
        camera.far = Math.min(mainCamera.far,140);
        camera.position.copy(transformPortalViewPosition(source, destination, mainCamera.position));

        const look = mainCamera.getWorldDirection(new THREE.Vector3());
        const worldUp = new THREE.Vector3(0, 1, 0).applyQuaternion(mainCamera.quaternion);
        const mappedLook = transformPortalVector(source, destination, look).normalize();
        const mappedUp = transformPortalVector(source, destination, worldUp).normalize();
        camera.up.copy(mappedUp);
        camera.lookAt(camera.position.clone().add(mappedLook));
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);

        // Oblique clipping plane along exit portal plane ensures the wall behind
        // the exit portal never occludes the destination room.
        const clipPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          destination.normal,
          destination.center.clone().addScaledVector(destination.normal, -0.015),
        );
        clipPortalCamera(camera,clipPlane);

        // The target matches the screen aspect because the aperture samples
        // screen-projected UVs. Small distant mouths need very few pixels.
        const distance=mainCamera.position.distanceTo(source.center);
        const scale = distance < 6 ? 1 : distance < 18 ? .75 : .5;
        const targetWidth=Math.max(192,Math.round(quality.width * scale / 32) * 32);
        const targetHeight=Math.max(128,Math.round(targetWidth/mainCamera.aspect));
        if(source.target.width!==targetWidth||source.target.height!==targetHeight)
          source.target.setSize?.(targetWidth,targetHeight);
        renderer.setRenderTarget(source.target);
        renderer.clear(true, true, true);
        renderer.render(scene, camera);
        source.lastViewTime=this.time;
        this.lastViewTime=this.time;
        this.viewStats.passes++;
        const mouth = source.group.userData.mouth;
        const firstView = !mouth.material.map;
        mouth.material.map = source.target.texture;
        mouth.material.color.setHex(0xffffff);
        mouth.material.opacity = 1.0;
        if (firstView) mouth.material.needsUpdate = true;
      }
      return true;
    } catch (error) {
      this.viewFailed = true;
      for (const p of entries) {
        const mouth = p.group.userData.mouth;
        mouth.material.map = null;
        mouth.material.color.setHex(p.kind === 'blue' ? 0x061b35 : 0x351506);
        mouth.material.opacity = 0.88;
        mouth.material.needsUpdate = true;
      }
      console.warn('[portals] live views disabled:', error?.message ?? error);
      return false;
    } finally {
      renderer.setRenderTarget(oldTarget);
      renderer.autoClear = oldAutoClear;
      if (renderer.shadowMap) renderer.shadowMap.autoUpdate = oldShadowAuto;
      renderer.localClippingEnabled = oldLocalClipping ?? false;
      renderer.clippingPlanes = oldClippingPlanes ?? [];
      for (let i = 0; i < entries.length; i++) entries[i].group.visible = visibilities[i];
    }
  }

  /**
   * Called from player or enemy collision while the attempted movement still carries
   * its incoming velocity. Returns true only when a legal crossing happened.
   */
  tryTraverse(entity) {
    if (!this.ready || !entity?.alive) return false;
    if ((entity._portalCooldown ?? 0) > 0) return false;
    if (this.cooldown > 0 && !('type' in entity)) return false;

    const height = entity.height ?? entity.type?.height ?? 1.8;
    const half = entity.half ?? (entity.type?.width ? entity.type.width * 0.5 : 0.32);

    const bodyCenter = new THREE.Vector3(
      entity.pos.x, entity.pos.y + height * 0.5, entity.pos.z,
    );
    const velocity = vec(entity.vel);

    for (const source of [this.portals.blue, this.portals.orange]) {
      const toward = velocity.dot(source.normal);
      if (toward >= -0.10 && velocity.lengthSq() > 0.05) continue;

      const rel = bodyCenter.clone().sub(source.center);
      const planeDistance = rel.dot(source.normal);
      const normalExtent = Math.abs(source.normal.y) * height * 0.5
        + (Math.abs(source.normal.x) + Math.abs(source.normal.z)) * half;
      if (planeDistance - normalExtent > 0.28 || planeDistance < -0.35) continue;

      const x = rel.dot(source.right);
      const y = rel.dot(source.up);
      const rightExtent = Math.abs(source.right.y) * height * 0.5
        + (Math.abs(source.right.x) + Math.abs(source.right.z)) * half;
      const upExtent = Math.abs(source.up.y) * height * 0.5
        + (Math.abs(source.up.x) + Math.abs(source.up.z)) * half;
      if (Math.abs(x) + rightExtent * .25 > PORTAL_HALF_WIDTH
        || Math.abs(y) + upExtent > PORTAL_HALF_HEIGHT + 0.14) continue;

      const destination = source.kind === 'blue' ? this.portals.orange : this.portals.blue;
      const outCenter = this._exitPosition(destination, x, y, height, half);
      const outVelocity = transformPortalVector(source, destination, velocity);
      if (!outCenter) {
        if(this.blockedCooldown===0){
          this.onBlocked?.('PORTAL EXIT BLOCKED — MOVE THE OTHER PORTAL');
          this.blockedCooldown=1;
        }
        continue;
      }
      entity.pos.x = outCenter.x;
      entity.pos.y = outCenter.y - height * 0.5;
      entity.pos.z = outCenter.z;
      if (entity.prevPos) {
        entity.prevPos.x = entity.pos.x;
        entity.prevPos.y = entity.pos.y;
        entity.prevPos.z = entity.pos.z;
      }
      entity.vel.x = outVelocity.x;
      entity.vel.y = outVelocity.y;
      entity.vel.z = outVelocity.z;

      if (typeof entity.getLookDir === 'function') {
        const look = transformPortalVector(source, destination, entity.getLookDir({})).normalize();
        entity.yaw = Math.atan2(-look.x, -look.z);
        if ('pitch' in entity) {
          entity.pitch = Math.asin(Math.max(-1, Math.min(1, look.y)));
        }
      } else if ('yaw' in entity) {
        const fwd = new THREE.Vector3(Math.sin(entity.yaw), 0, Math.cos(entity.yaw));
        const outFwd = transformPortalVector(source, destination, fwd).normalize();
        entity.yaw = Math.atan2(outFwd.x, outFwd.z);
      }

      entity.onGround = false;
      if ('ladder' in entity) entity.ladder = null;
      if ('wallRunning' in entity) {
        entity.wallRunning = false;
        entity.wallNormal = null;
        entity.wallRoll = 0;
        entity.wallTime = 0;
      }

      if ('_anchorX' in entity) {
        entity._anchorX = entity.pos.x;
        entity._anchorZ = entity.pos.z;
        entity.stuckTimer = 0;
        entity.embedTimer = 0;
      }

      if(source.group?.userData)source.group.userData.surge=1;
      if(destination.group?.userData)destination.group.userData.surge=1;
      entity._portalCooldown = 0.32;
      this.cooldown = 0.22;
      if(typeof entity.getLookDir==='function')this.transitPulse=1;
      this.onTraverse?.(source.kind, destination.kind, outVelocity, entity);
      return true;
    }
    return false;
  }
}
