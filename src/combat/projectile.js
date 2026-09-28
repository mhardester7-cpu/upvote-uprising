// Rockets: the one weapon that is not hitscan.
//
// A rocket is stepped forward in small increments, and each increment is a
// short raycast rather than a point test. Testing only the new position would
// let a fast projectile skip straight through a wall between two frames -- the
// same tunnelling problem the voxel raycast avoids for bullets.

import { rayAABB } from '../world/raycast.js';

export const ROCKET_SPEED = 42;
export const ROCKET_LIFETIME = 5;

export class Rocket {
  constructor(x, y, z, dx, dy, dz, def) {
    this.x = x; this.y = y; this.z = z;
    this.dx = dx; this.dy = dy; this.dz = dz;
    this.def = def;
    this.speed = ROCKET_SPEED;
    this.life = ROCKET_LIFETIME;
    this.alive = true;
    this.mesh = null;
    // Ignore hits for the first fraction of a metre so the rocket cannot
    // detonate on the shooter's own hitbox as it leaves the tube.
    this.travelled = 0;
  }

  /**
   * Advance the rocket. Returns an impact descriptor when it detonates.
   * @returns {null | {x, y, z, enemy: Enemy|null}}
   */
  update(dt, world, enemies) {
    if (!this.alive) return null;

    this.life -= dt;
    if (this.life <= 0) {
      this.alive = false;
      return { x: this.x, y: this.y, z: this.z, enemy: null };
    }

    let remaining = this.speed * dt;
    // Cap the sub-step so even at high speed the swept test stays tight.
    const STEP = 1.5;

    while (remaining > 0) {
      const step = Math.min(STEP, remaining);
      remaining -= step;

      const linked = world.raycastSegments?.(
        this.x, this.y, this.z, this.dx, this.dy, this.dz, step,
      ) ?? null;
      const segments = linked?.segments ?? [{
        origin: { x: this.x, y: this.y, z: this.z },
        direction: { x: this.dx, y: this.dy, z: this.dz },
        length: step,
        offset: 0,
      }];

      // Nearest enemy along every linked leg of this step.
      let bestT = step;
      let bestEnemy = null;
      let bestPoint = null;
      for (const e of enemies) {
        if (!e.alive) continue;
        const b = e.bodyBox();
        const h = e.headBox();
        for (const segment of segments) {
          const o = segment.origin, d = segment.direction;
          const tb = rayAABB(o.x, o.y, o.z, d.x, d.y, d.z,
            b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ);
          const th = rayAABB(o.x, o.y, o.z, d.x, d.y, d.z,
            h.minX, h.minY, h.minZ, h.maxX, h.maxY, h.maxZ);
          let local = -1;
          if (tb >= 0 && th >= 0) local = Math.min(tb, th);
          else if (tb >= 0) local = tb;
          else if (th >= 0) local = th;
          if (local < 0 || local > segment.length + 1e-6) continue;
          const total = segment.offset + local;
          if (total > bestT || this.travelled + total < 0.8) continue;
          bestT = total;
          bestEnemy = e;
          bestPoint = {
            x: o.x + d.x * local,
            y: o.y + d.y * local,
            z: o.z + d.z * local,
          };
        }
      }

      // Nearest wall along this segment.
      const wall = linked?.hit
        ?? world.raycast(this.x, this.y, this.z, this.dx, this.dy, this.dz, step);
      const wallDistance = linked?.totalDistance ?? (wall.hit ? wall.distance : step);

      if (bestEnemy && (!wall.hit || bestT <= wallDistance)) {
        this.alive = false;
        return {
          x: bestPoint.x,
          y: bestPoint.y,
          z: bestPoint.z,
          enemy: bestEnemy,
        };
      }
      if (wall.hit) {
        this.alive = false;
        // Back the impact point off the surface so the blast is not inside a
        // block, where the line-of-sight check would occlude everything.
        return {
          x: wall.x + wall.nx * 0.05,
          y: wall.y + wall.ny * 0.05,
          z: wall.z + wall.nz * 0.05,
          enemy: null,
        };
      }

      if (linked) {
        this.x = linked.end.x;
        this.y = linked.end.y;
        this.z = linked.end.z;
        this.dx = linked.endDirection.x;
        this.dy = linked.endDirection.y;
        this.dz = linked.endDirection.z;
      } else {
        this.x += this.dx * step;
        this.y += this.dy * step;
        this.z += this.dz * step;
      }
      this.travelled += step;
    }

    return null;
  }
}

/**
 * Apply radial damage around a detonation.
 *
 * Damage falls off linearly with distance, and anything without line of sight
 * to the blast is spared -- otherwise rockets would kill through walls, which
 * is exactly the bug the hitscan path is careful to avoid.
 *
 * @param damageScale outgoing multiplier (streak tier and potion perks). It is
 *   deliberately not applied to the self-damage below: a damage buff should not
 *   make your own rockets more lethal to you.
 * @returns {{hits: Array<{enemy, damage, killed}>, playerDamage: number}}
 */
export function applyExplosion(world, enemies, player, x, y, z, def, damageScale = 1, deal = null) {
  const radius = def.splashRadius;
  const hits = [];

  for (const e of enemies) {
    if (!e.alive) continue;
    const c = e.center({});
    const dist = Math.hypot(c.x - x, c.y - y, c.z - z);
    if (dist > radius) continue;
    if (!hasLineOfSight(world, x, y, z, c.x, c.y, c.z)) continue;

    const t = 1 - dist / radius;
    const damage = def.splashDamage * (0.35 + 0.65 * t) * damageScale;
    const killed = deal ? !!deal(e, damage, false) : e.damage(damage);
    hits.push({ enemy: e, damage, killed, headshot: false, point: { x: c.x, y: c.y, z: c.z } });

    // Knock survivors around; it reads as impact and breaks up melee packs.
    const inv = dist > 0.01 ? 1 / dist : 0;
    e.vel.x += (c.x - x) * inv * 9 * t;
    e.vel.z += (c.z - z) * inv * 9 * t;
    e.vel.y += 5 * t;
  }

  // Self-damage, at a reduced rate -- enough to punish point-blank shots
  // without making the weapon a liability.
  let playerDamage = 0;
  const px = player.pos.x, py = player.pos.y + player.height * 0.5, pz = player.pos.z;
  const pd = Math.hypot(px - x, py - y, pz - z);
  if (pd < radius && hasLineOfSight(world, x, y, z, px, py, pz)) {
    const t = 1 - pd / radius;
    playerDamage = def.splashDamage * def.selfDamage * (0.3 + 0.7 * t);
    const inv = pd > 0.01 ? 1 / pd : 0;
    player.vel.x += (px - x) * inv * 11 * t;
    player.vel.z += (pz - z) * inv * 11 * t;
    player.vel.y += 7 * t;
  }

  return { hits, playerDamage };
}

/** True when nothing solid sits between the two points. */
function hasLineOfSight(world, x0, y0, z0, x1, y1, z1) {
  return world.lineOfSight(x0, y0, z0, x1, y1, z1);
}
