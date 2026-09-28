// Hit registration.
//
// Every shot is a hitscan trace resolved in one pass:
//   1. Trace the world (terrain + props) to find where it stops the bullet.
//   2. Trace every live enemy's head and body boxes.
//   3. Whichever is nearest wins.
//
// Step 3 is the part that makes it correct: an enemy behind cover produces an
// AABB intersection, but the terrain's intersection is nearer, so the shot is
// blocked. Testing entities without also testing geometry is the classic way to
// end up shooting through walls.
//
// Bodies, unlike geometry, do not always stop the bullet. A weapon with
// `pierce` carries through the first target into whatever is lined up behind
// it, which is why the tracer collects every body along the ray rather than
// keeping only the nearest. Terrain still stops everything -- a sniper round
// punches through a queue of zombies, never through the wall behind them.

import { rayAABB } from '../world/raycast.js';
import { damageAtRange } from './weapons.js';

export const HIT_NONE = 'none';
export const HIT_WORLD = 'world';
export const HIT_ENEMY = 'enemy';

function clippedVisualPath(segments, distance) {
  const path = [];
  for (const segment of segments) {
    const length = Math.min(segment.length, distance - segment.offset);
    if (length <= 1e-6) break;
    const start = { ...segment.origin };
    path.push({
      start,
      end: {
        x: start.x + segment.direction.x * length,
        y: start.y + segment.direction.y * length,
        z: start.z + segment.direction.z * length,
      },
    });
    if (length < segment.length) break;
  }
  return path;
}

/**
 * Resolve a single hitscan shot.
 *
 * `point` is the first thing the bullet touched and `end` is where it finally
 * stopped; they differ only for a piercing round that carried through a body.
 * Tracers should be drawn to `end`, impact effects placed at `point` and at
 * each entry in `through`.
 *
 * @returns {{kind:string, distance:number, point:{x,y,z}, end:{x,y,z},
 *            enemy?:Enemy, headshot?:boolean, damage?:number,
 *            through?:Array<{enemy,headshot,damage,distance,point}>,
 *            normal?:{x,y,z}, prop?:object|null}}
 */
export function traceShot(world, enemies, ox, oy, oz, dx, dy, dz, def) {
  const range = def.range;
  const linked = world.raycastSegments?.(ox, oy, oz, dx, dy, dz, range) ?? null;
  const wall = linked?.hit ?? world.raycast(ox, oy, oz, dx, dy, dz, range);
  const wallDist = linked?.totalDistance ?? (wall.hit ? wall.distance : range);
  const segments = linked?.segments ?? [{
    origin: { x: ox, y: oy, z: oz },
    direction: { x: dx, y: dy, z: dz },
    length: wallDist,
    offset: 0,
  }];
  const linkedPath = (linked?.hops ?? 0) > 0;

  // How many bodies past the first this round survives, and what each one
  // costs it. Absent on every weapon that stops at the first target, which
  // makes this loop behave exactly as it did before.
  const pierce = def.pierce ?? 0;
  const falloff = def.pierceFalloff ?? 1;

  // Every body on the ray, not just the nearest: which ones actually take the
  // round cannot be decided until they are ordered by depth.
  const found = [];

  for (const e of enemies) {
    if (!e.alive) continue;

    const head = e.headBox();
    const body = e.bodyBox();
    let nearest = null;
    for (const segment of segments) {
      const sx = segment.origin.x, sy = segment.origin.y, sz = segment.origin.z;
      const sd = segment.direction;
      const tHead = rayAABB(sx, sy, sz, sd.x, sd.y, sd.z,
        head.minX, head.minY, head.minZ, head.maxX, head.maxY, head.maxZ);
      const tBody = rayAABB(sx, sy, sz, sd.x, sd.y, sd.z,
        body.minX, body.minY, body.minZ, body.maxX, body.maxY, body.maxZ);

      // Both boxes can be hit by one segment; the nearer entry is the one the
      // bullet touches. Total distance includes every preceding portal leg.
      let local = -1, isHead = false;
      if (tHead >= 0 && tBody >= 0) {
        if (tHead <= tBody) { local = tHead; isHead = true; }
        else { local = tBody; }
      } else if (tHead >= 0) { local = tHead; isHead = true; }
      else if (tBody >= 0) local = tBody;
      if (local < 0 || local > segment.length + 1e-6) continue;
      const total = segment.offset + local;
      if (nearest && total >= nearest.t) continue;
      nearest = {
        enemy: e, t: total, headshot: isHead,
        point: { x: sx + sd.x * local, y: sy + sd.y * local, z: sz + sd.z * local },
      };
    }
    if (nearest) found.push(nearest);
  }

  if (found.length) {
    // Depth order is what makes the sort matter: it decides who the round
    // reaches first, and therefore who it still has energy left for.
    found.sort((a, b) => a.t - b.t);

    const taken = found.slice(0, pierce + 1);
    const at = (rec, index) => {
      const base = damageAtRange(def, rec.t);
      // Each body the round passes through costs it a fixed fraction. The
      // headshot bonus rides on top, so a round that punches a torso and finds
      // a skull behind it still pays out for the skull.
      const damage = base * (rec.headshot ? def.headshotMultiplier : 1)
        * Math.pow(falloff, index);
      return {
        enemy: rec.enemy,
        headshot: rec.headshot,
        damage,
        distance: rec.t,
        point: rec.point,
      };
    };

    const first = at(taken[0], 0);
    const through = taken.slice(1).map((rec, i) => at(rec, i + 1));

    // Where the round died. It only reaches the wall if it had pierce to
    // spare -- a budget spent exactly on bodies means the last body stopped it.
    const spent = found.length > pierce;
    const end = spent
      ? { ...through.length ? through[through.length - 1].point : first.point }
      : linked?.end ?? { x: wall.hit ? wall.x : ox + dx * range,
                        y: wall.hit ? wall.y : oy + dy * range,
                        z: wall.hit ? wall.z : oz + dz * range };

    const endDistance = spent
      ? taken[taken.length - 1].t
      : wallDist;
    return {
      kind: HIT_ENEMY,
      distance: first.distance,
      point: first.point,
      end,
      enemy: first.enemy,
      headshot: first.headshot,
      damage: first.damage,
      through,
      ...(linkedPath ? { path: clippedVisualPath(segments, endDistance) } : {}),
    };
  }

  if (wall.hit) {
    const point = { x: wall.x, y: wall.y, z: wall.z };
    return {
      kind: HIT_WORLD,
      distance: wall.distance,
      point,
      end: point,
      normal: { x: wall.nx, y: wall.ny, z: wall.nz },
      // null when it was the ground, otherwise the tree/rock/ruin that stopped
      // it -- callers use this to pick the impact effect.
      prop: wall.prop ?? null,
      through: [],
      ...(linkedPath ? { path: clippedVisualPath(segments, wallDist) } : {}),
    };
  }

  const point = linked?.end
    ?? { x: ox + dx * range, y: oy + dy * range, z: oz + dz * range };
  return {
    kind: HIT_NONE,
    distance: range,
    point,
    end: point,
    through: [],
    ...(linkedPath ? { path: clippedVisualPath(segments, range) } : {}),
  };
}

/**
 * Resolve a melee swing.
 *
 * A swing is an arc sweep, not a ray: it takes the nearest live enemy inside
 * `def.range` whose direction is within `def.swingArc` of where the player is
 * looking. Tracing a single ray instead would demand the pixel accuracy of a
 * sniper shot from a weapon used at contact distance, which reads as the game
 * eating inputs.
 *
 * Line of sight is still checked against the voxel grid, so a pickaxe cannot
 * reach through a wall, and the head box is still tested, so a knife to the
 * skull still pays out.
 *
 * @returns {{enemy, damage, headshot, killed, point}|null}
 */
export function resolveMelee(world, enemies, origin, dir, def, damageScale = 1) {
  const reach = def.range;
  const cosArc = Math.cos(def.swingArc ?? 30 * Math.PI / 180);

  let best = null;
  let bestDist = Infinity;

  for (const e of enemies) {
    if (!e.alive) continue;

    // Aim at the middle of the body: the feet of a tall enemy standing on top
    // of you are outside any sane arc, and its head is above it.
    const body = e.bodyBox();
    const tx = (body.minX + body.maxX) / 2 - origin.x;
    const ty = (body.minY + body.maxY) / 2 - origin.y;
    const tz = (body.minZ + body.maxZ) / 2 - origin.z;

    const dist = Math.hypot(tx, ty, tz);
    if (dist > reach || dist >= bestDist) continue;
    if (dist < 1e-6) { best = e; bestDist = dist; continue; }

    // Inside the swing arc?
    if ((tx * dir.x + ty * dir.y + tz * dir.z) / dist < cosArc) continue;

    // Not through geometry. Checked along the line to the target, stopping just
    // short so standing flush against a wall does not block a legal swing.
    const wall = world.raycast(origin.x, origin.y, origin.z,
      tx / dist, ty / dist, tz / dist, dist - 0.1);
    if (wall.hit) continue;

    best = e;
    bestDist = dist;
  }

  if (!best) return null;

  // A headshot is decided by where the player was actually pointing, so lining
  // up the skull is still a skill rather than a side effect of proximity.
  const head = best.headBox();
  const tHead = rayAABB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
    head.minX, head.minY, head.minZ, head.maxX, head.maxY, head.maxZ);
  const headshot = tHead >= 0 && tHead <= reach;

  const damage = def.damage * (headshot ? def.headshotMultiplier : 1) * damageScale;
  const body = best.bodyBox();
  const killed = best.damage(damage);

  return {
    enemy: best,
    damage,
    headshot,
    killed,
    pellets: 1,
    point: {
      x: (body.minX + body.maxX) / 2,
      y: headshot ? (head.minY + head.maxY) / 2 : (body.minY + body.maxY) / 2,
      z: (body.minZ + body.maxZ) / 2,
    },
  };
}

/**
 * Resolve a full trigger pull (one shot for most guns, N pellets for a shotgun)
 * and apply the damage. Damage is accumulated per enemy first so a shotgun
 * blast reports one combined number instead of nine.
 *
 * Damage is applied through `deal`, which defaults to hitting the enemy
 * directly. The caller overrides it so the authoritative simulation can be the
 * one that decides what a hit is worth -- in co-op the same trigger pull has to
 * be predicted locally and scored on the server, and those are not the same
 * step.
 *
 * @returns {{traces:Array, hits:Array<{enemy,damage,headshot,killed}>,
 *            totalDamage:number, anyHeadshot:boolean, kills:Array}}
 */
export function resolveFire(world, enemies, origin, shots, def, damageScale = 1, deal = null) {
  const traces = [];
  const perEnemy = new Map();
  let anyHeadshot = false;

  for (const s of shots) {
    const tr = traceShot(world, enemies, origin.x, origin.y, origin.z, s.x, s.y, s.z, def);
    traces.push(tr);
    if (tr.kind !== HIT_ENEMY) continue;

    // The target the round hit first, then everything it carried through.
    // Collateral banks into the same per-enemy records, so a pierced zombie
    // that a later pellet also hits reports one combined number.
    for (const h of [tr, ...tr.through]) {
      if (h.headshot) anyHeadshot = true;
      let rec = perEnemy.get(h.enemy);
      if (!rec) {
        rec = { enemy: h.enemy, damage: 0, headshot: false, pellets: 0, killed: false, point: h.point };
        perEnemy.set(h.enemy, rec);
      }
      rec.damage += h.damage * damageScale;
      rec.headshot = rec.headshot || h.headshot;
      rec.pellets += 1;
    }
  }

  const hits = [];
  const kills = [];
  let totalDamage = 0;
  for (const rec of perEnemy.values()) {
    const killed = deal
      ? !!deal(rec.enemy, rec.damage, rec.headshot)
      : rec.enemy.damage(rec.damage);
    rec.killed = killed;
    totalDamage += rec.damage;
    hits.push(rec);
    if (killed) kills.push(rec);
  }

  return { traces, hits, kills, totalDamage, anyHeadshot };
}
