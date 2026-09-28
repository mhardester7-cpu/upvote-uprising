// World-space effects: tracers, impact debris, and death bursts.
//
// Both systems are fixed-size pools drawn as a single object -- one LineSegments
// for every tracer and one InstancedMesh for every particle. Nothing is
// allocated while shooting, so sustained fire does not stutter on GC.

import * as THREE from '../../vendor/three.module.js';

const MAX_TRACERS = 64;
const MAX_PARTICLES = 512;
const MAX_FLAMES = 320;
const MAX_SMOKE = 96;

export class Effects {
  constructor(scene) {
    this.scene = scene;

    // ---- tracers ---------------------------------------------------------
    // Additive blending means fading a tracer's colour to black fades it out,
    // which avoids needing per-vertex alpha.
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3));
    tGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_TRACERS * 6), 3));
    this.tracerGeo = tGeo;
    this.tracers = new THREE.LineSegments(tGeo, new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    this.tracers.frustumCulled = false;
    this.tracers.renderOrder = 5;
    this.tracers.visible = false;
    scene.add(this.tracers);

    this.tracerPool = [];
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.tracerPool.push({ active: false, life: 0, maxLife: 0.09, r: 1, g: 0.9, b: 0.6 });
    }

    // ---- particles -------------------------------------------------------
    const pGeo = new THREE.BoxGeometry(1, 1, 1);
    const pMat = new THREE.MeshLambertMaterial({ vertexColors: false });
    this.particles = new THREE.InstancedMesh(pGeo, pMat, MAX_PARTICLES);
    this.particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.particles.frustumCulled = false;
    this.particles.count = MAX_PARTICLES;
    this.particles.visible = false;
    scene.add(this.particles);

    // instanceColor is not created by default; allocate it up front.
    this.particles.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_PARTICLES * 3), 3);
    this.particles.instanceColor.setUsage(THREE.DynamicDrawUsage);

    this.particlePool = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particlePool.push({
        active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, size: 0.08, r: 1, g: 1, b: 1,
        rx: 0, ry: 0, rz: 0, spin: 0, gravity: 22, bounce: false,
      });
    }
    this.pNext = 0;
    this.tNext = 0;

    // ---- flamethrower ----------------------------------------------------
    // Fire gets its own rounded, additive pool. Reusing the debris cubes made
    // the old jet look like orange dice, while allocating sprites on every fuel
    // tick is exactly the kind of sustained-fire GC spike this class avoids.
    const flameGeo = new THREE.IcosahedronGeometry(1, 1);
    const flameMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.86,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.flames = new THREE.InstancedMesh(flameGeo, flameMat, MAX_FLAMES);
    this.flames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flames.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_FLAMES * 3), 3);
    this.flames.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.flames.frustumCulled = false;
    this.flames.renderOrder = 6;
    this.flames.visible = false;
    scene.add(this.flames);
    this.flamePool = Array.from({ length: MAX_FLAMES }, () => ({
      active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      life: 0, maxLife: 0.3, size: 0.1, grow: 0.5, r: 1, g: 0.5, b: 0.05,
    }));
    this.fNext = 0;

    // Smoke is deliberately a separate normal-blended pool. Putting grey into
    // an additive fire material brightens the scene instead of reading as soot.
    const smokeMat = new THREE.MeshLambertMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.24,
      depthWrite: false,
    });
    this.smoke = new THREE.InstancedMesh(flameGeo, smokeMat, MAX_SMOKE);
    this.smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.smoke.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_SMOKE * 3), 3);
    this.smoke.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.smoke.frustumCulled = false;
    this.smoke.renderOrder = 4;
    this.smoke.visible = false;
    scene.add(this.smoke);
    this.smokePool = Array.from({ length: MAX_SMOKE }, () => ({
      active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      life: 0, maxLife: 0.9, size: 0.18, grow: 0.35, shade: 0.18,
    }));
    this.sNext = 0;

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
  }

  // -------------------------------------------------------------- tracers

  addTracer(x0, y0, z0, x1, y1, z1, color = 0xffe6a0, life = 0.075) {
    const i = this.tNext;
    const t = this.tracerPool[i];
    this.tNext = (this.tNext + 1) % MAX_TRACERS;

    const pos = this.tracerGeo.attributes.position.array;
    const o = i * 6;
    // Start the tracer slightly along the ray so it never covers the crosshair.
    pos[o] = x0; pos[o + 1] = y0; pos[o + 2] = z0;
    pos[o + 3] = x1; pos[o + 4] = y1; pos[o + 5] = z1;

    t.active = true;
    t.life = life;
    t.maxLife = life;
    t.r = ((color >> 16) & 255) / 255;
    t.g = ((color >> 8) & 255) / 255;
    t.b = (color & 255) / 255;
    this.tracers.visible = true;
    this.tracerGeo.attributes.position.needsUpdate = true;
  }

  // ------------------------------------------------------------ particles

  _spawnParticle(cfg) {
    const p = this.particlePool[this.pNext];
    this.pNext = (this.pNext + 1) % MAX_PARTICLES;
    Object.assign(p, cfg);
    p.active = true;
    p.life = p.maxLife;
    this.particles.visible = true;
    return p;
  }

  _spawnFlame(cfg) {
    const p = this.flamePool[this.fNext];
    this.fNext = (this.fNext + 1) % MAX_FLAMES;
    Object.assign(p, cfg);
    p.active = true;
    p.life = p.maxLife;
    this.flames.visible = true;
    return p;
  }

  _spawnSmoke(cfg) {
    const p = this.smokePool[this.sNext];
    this.sNext = (this.sNext + 1) % MAX_SMOKE;
    Object.assign(p, cfg);
    p.active = true;
    p.life = p.maxLife;
    this.smoke.visible = true;
    return p;
  }

  /**
   * A pressurised flame ribbon from nozzle to the resolved end of one cone ray.
   * Hot particles start tight and pale, expand through orange, and leave a
   * sparse soot tail. Three calls per fuel tick form a turbulent cone rather
   * than one laser-straight orange line.
   */
  flameJet(x0, y0, z0, x1, y1, z1, rng = Math.random) {
    let dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const distance = Math.hypot(dx, dy, dz);
    if (!(distance > 0.001)) return;
    dx /= distance; dy /= distance; dz /= distance;

    // Basis around the stream direction for a radius that widens downrange.
    let rx = -dz, ry = 0, rz = dx;
    let rl = Math.hypot(rx, rz);
    if (rl < 0.001) { rx = 1; rz = 0; rl = 1; }
    rx /= rl; rz /= rl;
    const ux = dy * rz - dz * ry;
    const uy = dz * rx - dx * rz;
    const uz = dx * ry - dy * rx;
    const travel = Math.min(distance, 13);
    const count = Math.max(5, Math.min(9, Math.ceil(travel * 0.65)));

    for (let i = 0; i < count; i++) {
      const t = Math.min(1, Math.max(0, (i + rng() * 0.9) / count));
      const angle = rng() * Math.PI * 2;
      const radius = (0.015 + t * 0.27) * Math.sqrt(rng());
      const ox = (rx * Math.cos(angle) + ux * Math.sin(angle)) * radius;
      const oy = (ry * Math.cos(angle) + uy * Math.sin(angle)) * radius;
      const oz = (rz * Math.cos(angle) + uz * Math.sin(angle)) * radius;
      const speed = 2.4 + t * 2.8 + rng() * 1.2;
      // Black-body-inspired ramp: white-yellow at the nozzle, orange in the
      // body, red at the ragged edge. Additive blending supplies the hot core.
      const r = 1;
      const g = t < 0.22 ? 0.9 - t * 0.5 : 0.79 - t * 0.48;
      const b = t < 0.18 ? 0.48 - t * 1.6 : 0.04;
      this._spawnFlame({
        x: x0 + dx * travel * t + ox,
        y: y0 + dy * travel * t + oy,
        z: z0 + dz * travel * t + oz,
        vx: dx * speed + ox * 3.2,
        vy: dy * speed + 0.45 + t * 0.55 + oy * 3.2,
        vz: dz * speed + oz * 3.2,
        maxLife: 0.16 + t * 0.18 + rng() * 0.08,
        size: 0.055 + t * 0.25 + rng() * 0.05,
        grow: 0.34 + t * 0.48,
        r, g, b,
      });
    }

    // Only some rays leave soot. That keeps the flame readable instead of
    // drawing an opaque grey tube across the player's target.
    if (rng() < 0.58) {
      const t = 0.72 + rng() * 0.25;
      this._spawnSmoke({
        x: x0 + dx * travel * t + (rng() - 0.5) * 0.32,
        y: y0 + dy * travel * t + (rng() - 0.5) * 0.18,
        z: z0 + dz * travel * t + (rng() - 0.5) * 0.32,
        vx: dx * (0.6 + rng()) + (rng() - 0.5) * 0.5,
        vy: 0.75 + rng() * 0.75,
        vz: dz * (0.6 + rng()) + (rng() - 0.5) * 0.5,
        maxLife: 0.62 + rng() * 0.48,
        size: 0.13 + rng() * 0.12,
        grow: 0.2 + rng() * 0.22,
        shade: 0.12 + rng() * 0.11,
      });
    }
  }

  /** Flame curling against a body or surface instead of stone/blood debris. */
  flameImpact(x, y, z, nx = 0, ny = 1, nz = 0) {
    for (let i = 0; i < 3; i++) {
      this._spawnFlame({
        x: x + (Math.random() - 0.5) * 0.16,
        y: y + Math.random() * 0.12,
        z: z + (Math.random() - 0.5) * 0.16,
        vx: nx * 0.25 + (Math.random() - 0.5) * 0.65,
        vy: 0.85 + Math.random() * 0.75 + ny * 0.2,
        vz: nz * 0.25 + (Math.random() - 0.5) * 0.65,
        maxLife: 0.18 + Math.random() * 0.18,
        size: 0.1 + Math.random() * 0.12,
        grow: 0.28, r: 1, g: 0.36 + Math.random() * 0.22, b: 0.025,
      });
    }
  }

  /** Chips of the block that was hit, thrown back along the surface normal. */
  blockImpact(x, y, z, nx, ny, nz, color) {
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    for (let i = 0; i < 7; i++) {
      const sp = 2.2 + Math.random() * 3.4;
      this._spawnParticle({
        x, y, z,
        vx: nx * sp + (Math.random() - 0.5) * 3.4,
        vy: ny * sp + Math.random() * 3.2,
        vz: nz * sp + (Math.random() - 0.5) * 3.4,
        maxLife: 0.4 + Math.random() * 0.5,
        size: 0.045 + Math.random() * 0.06,
        r: r * (0.8 + Math.random() * 0.4),
        g: g * (0.8 + Math.random() * 0.4),
        b: b * (0.8 + Math.random() * 0.4),
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
        spin: (Math.random() - 0.5) * 14,
        gravity: 22,
      });
    }
  }

  /** Bright spray when a shot lands on an enemy. */
  fleshImpact(x, y, z, dx, dy, dz, headshot) {
    const n = headshot ? 12 : 6;
    for (let i = 0; i < n; i++) {
      const sp = 1.6 + Math.random() * 3.2;
      this._spawnParticle({
        x, y, z,
        vx: -dx * sp + (Math.random() - 0.5) * 3.6,
        vy: -dy * sp + Math.random() * 3.0 + 1,
        vz: -dz * sp + (Math.random() - 0.5) * 3.6,
        maxLife: 0.3 + Math.random() * 0.35,
        size: 0.04 + Math.random() * 0.05,
        r: headshot ? 1.0 : 0.85,
        g: headshot ? 0.85 : 0.18,
        b: headshot ? 0.3 : 0.14,
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
        spin: (Math.random() - 0.5) * 18,
        gravity: 18,
      });
    }
  }

  /** Enemy death: a burst of cubes in that enemy's colours. */
  deathBurst(x, y, z, color, scale = 1) {
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    for (let i = 0; i < 20; i++) {
      const sp = 2.5 + Math.random() * 5;
      const ang = Math.random() * Math.PI * 2;
      const up = Math.random();
      this._spawnParticle({
        x: x + (Math.random() - 0.5) * 0.4,
        y: y + Math.random() * 0.8,
        z: z + (Math.random() - 0.5) * 0.4,
        vx: Math.cos(ang) * sp * (1 - up * 0.5),
        vy: 2 + up * 6,
        vz: Math.sin(ang) * sp * (1 - up * 0.5),
        maxLife: 0.8 + Math.random() * 0.7,
        size: (0.09 + Math.random() * 0.11) * scale,
        r: r * (0.75 + Math.random() * 0.5),
        g: g * (0.75 + Math.random() * 0.5),
        b: b * (0.75 + Math.random() * 0.5),
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
        spin: (Math.random() - 0.5) * 12,
        gravity: 24,
      });
    }
  }

  /** Rounded fire, rolling smoke and a small amount of physical debris. */
  explosion(x, y, z, radius) {
    const scale = Math.max(0.35, radius / 4.8);

    // The old fireball reused the block-debris cube pool, so every blast was a
    // cloud of orange dice. These irregular additive volumes overlap into a
    // hot core and cool as they expand.
    for (let i = 0; i < 44; i++) {
      const ang = Math.random() * Math.PI * 2;
      const vertical = Math.random() * 2 - 0.68;
      const radial = Math.sqrt(Math.max(0, 1 - vertical * vertical));
      const sp = (2.2 + Math.random() * 7.4) * scale;
      const heat = Math.random();
      this._spawnFlame({
        x: x + (Math.random() - 0.5) * 0.3,
        y: y + (Math.random() - 0.5) * 0.25,
        z: z + (Math.random() - 0.5) * 0.3,
        vx: Math.cos(ang) * radial * sp,
        vy: vertical * sp + 2.5 * scale,
        vz: Math.sin(ang) * radial * sp,
        maxLife: 0.34 + Math.random() * 0.5,
        size: (0.16 + Math.random() * 0.28) * scale,
        grow: (0.7 + Math.random() * 1.0) * scale,
        r: 1,
        g: 0.25 + heat * 0.65,
        b: 0.015 + heat * 0.16,
      });
    }

    // Dense soot follows the flame front upward instead of brightening the
    // scene through additive blending.
    for (let i = 0; i < 24; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = (0.8 + Math.random() * 3.8) * scale;
      this._spawnSmoke({
        x: x + (Math.random() - 0.5) * 0.6,
        y: y + Math.random() * 0.45,
        z: z + (Math.random() - 0.5) * 0.6,
        vx: Math.cos(ang) * sp,
        vy: (1.2 + Math.random() * 3.2) * scale,
        vz: Math.sin(ang) * sp,
        maxLife: 0.85 + Math.random() * 1.05,
        size: (0.24 + Math.random() * 0.32) * scale,
        grow: (0.65 + Math.random() * 1.05) * scale,
        shade: 0.1 + Math.random() * 0.12,
      });
    }

    // A restrained amount of dark debris still communicates that a metal
    // cabinet actually came apart; it no longer stands in for the fireball.
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = (4 + Math.random() * 10) * scale;
      this._spawnParticle({
        x, y, z,
        vx: Math.cos(ang) * sp,
        vy: 3 + Math.random() * 9,
        vz: Math.sin(ang) * sp,
        maxLife: 0.7 + Math.random() * 0.8,
        size: 0.07 + Math.random() * 0.12,
        r: 0.3, g: 0.27, b: 0.24,
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
        spin: (Math.random() - 0.5) * 20,
        gravity: 26,
      });
    }
  }

  /** Purple shockwave radiating from the player when the gauntlet fires. */
  snapFlash(x, y, z) {
    for (let i = 0; i < 90; i++) {
      const ang = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * 0.9;
      const sp = 8 + Math.random() * 16;
      const violet = Math.random();
      this._spawnParticle({
        x, y: y - 0.4 + Math.random() * 0.8, z,
        vx: Math.cos(ang) * Math.cos(pitch) * sp,
        vy: Math.sin(pitch) * sp * 0.5 + 1.5,
        vz: Math.sin(ang) * Math.cos(pitch) * sp,
        maxLife: 0.6 + Math.random() * 0.7,
        size: 0.09 + Math.random() * 0.16,
        r: 0.62 + violet * 0.38,
        g: 0.22 + violet * 0.3,
        b: 0.9,
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
        spin: (Math.random() - 0.5) * 16,
        gravity: 1.5,
      });
    }
  }

  /** Puff marking a wave spawn point. */
  spawnPuff(x, y, z, color) {
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    for (let i = 0; i < 14; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 2.4;
      this._spawnParticle({
        x, y: y + Math.random() * 1.4, z,
        vx: Math.cos(ang) * sp, vy: 1 + Math.random() * 3, vz: Math.sin(ang) * sp,
        maxLife: 0.5 + Math.random() * 0.4,
        size: 0.07 + Math.random() * 0.08,
        r, g, b,
        rx: 0, ry: 0, rz: 0, spin: (Math.random() - 0.5) * 8,
        gravity: 6,
      });
    }
  }

  /**
   * One slow-rising mote. Strung along a line these draw the treasure map's
   * trail, so "the map leads you there" is something you can see in the world
   * rather than only on the HUD.
   */
  mote(x, y, z, color, size = 0.11) {
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    this._spawnParticle({
      x, y, z,
      vx: (Math.random() - 0.5) * 0.3, vy: 0.7 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.3,
      maxLife: 1.1 + Math.random() * 0.5,
      size,
      r, g, b,
      rx: Math.random() * 6, ry: Math.random() * 6, rz: 0,
      spin: (Math.random() - 0.5) * 3,
      gravity: 0.35,     // near-weightless, so the trail hangs in the air
    });
  }

  // ---------------------------------------------------------------- update

  update(dt, world) {
    // --- tracers ---
    const colors = this.tracerGeo.attributes.color.array;
    let anyTracer = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const t = this.tracerPool[i];
      const o = i * 6;
      if (!t.active) {
        colors[o] = colors[o + 1] = colors[o + 2] = 0;
        colors[o + 3] = colors[o + 4] = colors[o + 5] = 0;
        continue;
      }
      t.life -= dt;
      if (t.life <= 0) {
        t.active = false;
        colors[o] = colors[o + 1] = colors[o + 2] = 0;
        colors[o + 3] = colors[o + 4] = colors[o + 5] = 0;
        continue;
      }
      anyTracer = true;
      const k = t.life / t.maxLife;
      // Head of the tracer stays brighter than the tail.
      colors[o] = t.r * k * 0.35; colors[o + 1] = t.g * k * 0.35; colors[o + 2] = t.b * k * 0.35;
      colors[o + 3] = t.r * k; colors[o + 4] = t.g * k; colors[o + 5] = t.b * k;
    }
    this.tracerGeo.attributes.color.needsUpdate = true;
    this.tracers.visible = anyTracer;

    // --- particles ---
    let anyParticle = false;
    for (let i = 0; this.particles.visible && i < MAX_PARTICLES; i++) {
      const p = this.particlePool[i];
      if (!p.active) {
        // Collapse dead instances to zero scale rather than reordering the pool.
        this._m.makeScale(0, 0, 0);
        this.particles.setMatrixAt(i, this._m);
        continue;
      }

      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        this._m.makeScale(0, 0, 0);
        this.particles.setMatrixAt(i, this._m);
        continue;
      }
      anyParticle = true;

      p.vy -= p.gravity * dt;
      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;
      const nz = p.z + p.vz * dt;

      // Cheap collision: settle on the ground instead of sinking through it.
      const ground = world.heightAt(nx, nz);
      if (ny <= ground) {
        p.x = nx; p.z = nz;
        p.y = ground;
        if (p.vy < 0) { p.vy *= -0.28; p.vx *= 0.62; p.vz *= 0.62; }
      } else {
        p.x = nx; p.y = ny; p.z = nz;
      }

      p.rx += p.spin * dt;
      p.ry += p.spin * 0.7 * dt;

      const fade = Math.min(1, p.life / (p.maxLife * 0.4));
      const s = p.size * (0.4 + fade * 0.6);
      this._e.set(p.rx, p.ry, p.rz);
      this._q.setFromEuler(this._e);
      this._v.set(p.x, p.y, p.z);
      this._s.set(s, s, s);
      this._m.compose(this._v, this._q, this._s);
      this.particles.setMatrixAt(i, this._m);
      this.particles.setColorAt(i, TMP_COLOR.setRGB(p.r * fade, p.g * fade, p.b * fade));
    }
    this.particles.visible = anyParticle;
    if (anyParticle) {
      this.particles.instanceMatrix.needsUpdate = true;
      if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
    }

    // --- flame volumes ---
    let anyFlame = false;
    for (let i = 0; this.flames.visible && i < MAX_FLAMES; i++) {
      const p = this.flamePool[i];
      if (!p.active || (p.life -= dt) <= 0) {
        p.active = false;
        this._m.makeScale(0, 0, 0);
        this.flames.setMatrixAt(i, this._m);
        continue;
      }
      anyFlame = true;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vx *= Math.max(0, 1 - dt * 2.2);
      p.vz *= Math.max(0, 1 - dt * 2.2);
      p.vy += dt * 0.7;
      const age = 1 - p.life / p.maxLife;
      const fade = Math.min(1, p.life / Math.max(0.001, p.maxLife * 0.34));
      const s = (p.size + p.grow * age) * (0.74 + fade * 0.26);
      this._v.set(p.x, p.y, p.z);
      this._s.set(s * (0.82 + age * 0.22), s, s * (0.82 + age * 0.22));
      this._m.compose(this._v, this._q.identity(), this._s);
      this.flames.setMatrixAt(i, this._m);
      this.flames.setColorAt(i, TMP_COLOR.setRGB(p.r * fade, p.g * fade, p.b * fade));
    }
    this.flames.visible = anyFlame;
    if (anyFlame) {
      this.flames.instanceMatrix.needsUpdate = true;
      if (this.flames.instanceColor) this.flames.instanceColor.needsUpdate = true;
    }

    // --- smoke volumes ---
    let anySmoke = false;
    for (let i = 0; this.smoke.visible && i < MAX_SMOKE; i++) {
      const p = this.smokePool[i];
      if (!p.active || (p.life -= dt) <= 0) {
        p.active = false;
        this._m.makeScale(0, 0, 0);
        this.smoke.setMatrixAt(i, this._m);
        continue;
      }
      anySmoke = true;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vx *= Math.max(0, 1 - dt * 1.25);
      p.vz *= Math.max(0, 1 - dt * 1.25);
      p.vy += dt * 0.22;
      const age = 1 - p.life / p.maxLife;
      const fade = Math.min(1, p.life / Math.max(0.001, p.maxLife * 0.42));
      const s = p.size + p.grow * age;
      this._v.set(p.x, p.y, p.z);
      this._s.setScalar(s * (0.7 + fade * 0.3));
      this._m.compose(this._v, this._q.identity(), this._s);
      this.smoke.setMatrixAt(i, this._m);
      const shade = p.shade * fade;
      this.smoke.setColorAt(i, TMP_COLOR.setRGB(shade, shade * 0.93, shade * 0.84));
    }
    this.smoke.visible = anySmoke;
    if (anySmoke) {
      this.smoke.instanceMatrix.needsUpdate = true;
      if (this.smoke.instanceColor) this.smoke.instanceColor.needsUpdate = true;
    }
  }

  clear() {
    for (const p of this.particlePool) p.active = false;
    for (const t of this.tracerPool) t.active = false;
    for (const p of this.flamePool) p.active = false;
    for (const p of this.smokePool) p.active = false;
    this.particles.visible = false;
    this.tracers.visible = false;
    this.flames.visible = false;
    this.smoke.visible = false;
  }
}

const TMP_COLOR = new THREE.Color();
