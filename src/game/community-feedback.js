// Small gameplay hardening layer for issues reported by live players.
//
// This file intentionally wraps the existing interplanetary implementation
// instead of duplicating it. It keeps the shipped pursuit/terrain logic intact
// while making the one-shot snail visually readable and preventing it from
// camping the player's entry point.

import {
  InterplanetaryTravel,
  SNAIL_GROUND_OFFSET,
  SNAIL_START_MIN_DISTANCE,
  SNAIL_VISUAL_SCALE,
  snailGroundHeight,
} from './interplanetary.js';
import { installReloadSafety } from './reload-safety.js';

/** A one-shot threat should be readable before it is already touching you. */
export const COMMUNITY_SNAIL_SCALE = 1.7;
/** Keep the lethal pursuer well outside the immediate spawn/exit bubble. */
export const COMMUNITY_SNAIL_SAFE_DISTANCE = Math.max(14, SNAIL_START_MIN_DISTANCE + 7);

let installed = false;

function pointOf(player) {
  const p = player?.pos ?? player;
  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.z))) return null;
  return p;
}

function contains(room, x, z) {
  return !!room
    && Number.isFinite(room.minX) && Number.isFinite(room.maxX)
    && Number.isFinite(room.minZ) && Number.isFinite(room.maxZ)
    && x >= room.minX && x <= room.maxX
    && z >= room.minZ && z <= room.maxZ;
}

function playerRoom(travel, p) {
  return (travel.world?.plan?.rooms ?? []).find((room) => contains(room, p.x, p.z)) ?? null;
}

function candidateIsClear(travel, x, z, fromY) {
  const world = travel.world;
  if (typeof world?.inBounds === 'function' && !world.inBounds(x, z)) return null;
  const terrainY = Number(world?.heightAt?.(x, z));
  const y = Number.isFinite(terrainY) ? terrainY : (Number(fromY) || 0);
  if (world?.blocksAt?.(x, y, z, 0.78, 1.45)) return null;
  return y;
}

function placeSnail(travel, p, x, z, fromY) {
  const y = candidateIsClear(travel, x, z, fromY);
  if (y === null) return false;
  const groundY = snailGroundHeight(travel.world, x, z, y);
  travel.snailPos.set(x, groundY + SNAIL_GROUND_OFFSET, z);
  travel.snailMesh.position.copy(travel.snailPos);
  travel.snailDistance = Math.hypot(x - p.x, z - p.z);
  travel._orientSurfaceSnail?.(p, 0, true);
  return true;
}

/**
 * Find a deterministic clear point around the player. On the opening spawn we
 * prefer a point outside the room the player appears in, so the snail is a
 * pursuer entering the encounter rather than a lethal prop sitting in spawn.
 */
function moveSnailOutOfSpawn(travel, player, avoidPlayerRoom = false) {
  const p = pointOf(player);
  if (!p) return false;
  const room = avoidPlayerRoom ? playerRoom(travel, p) : null;
  const currentDx = travel.snailPos.x - p.x;
  const currentDz = travel.snailPos.z - p.z;
  const baseAngle = currentDx * currentDx + currentDz * currentDz > 1e-6
    ? Math.atan2(currentDz, currentDx)
    : Math.PI * 0.375;
  const fromY = Number(p.y) || 0;

  // First pass honours the opening-room exclusion. The second is a safety
  // fallback for tiny/fully enclosed authored rooms: distance matters more than
  // preserving the preference if no outside point is actually reachable.
  for (const requireOutsideRoom of [avoidPlayerRoom, false]) {
    for (const radius of [
      COMMUNITY_SNAIL_SAFE_DISTANCE,
      COMMUNITY_SNAIL_SAFE_DISTANCE + 3,
      COMMUNITY_SNAIL_SAFE_DISTANCE + 6,
      COMMUNITY_SNAIL_SAFE_DISTANCE + 9,
    ]) {
      for (let i = 0; i < 24; i++) {
        // Alternate clockwise/counter-clockwise around the direction the snail
        // already occupied so a correction does not feel like a random teleport.
        const step = Math.ceil(i / 2);
        const side = i % 2 === 0 ? 1 : -1;
        const angle = baseAngle + side * step * (Math.PI * 2 / 24);
        const x = p.x + Math.cos(angle) * radius;
        const z = p.z + Math.sin(angle) * radius;
        if (requireOutsideRoom && contains(room, x, z)) continue;
        if (!placeSnail(travel, p, x, z, fromY)) continue;
        if (avoidPlayerRoom && room && !contains(room, x, z)) travel.snailSpawnRoomId = null;
        return true;
      }
    }
    if (!requireOutsideRoom) break;
  }
  return false;
}

function applyReadableScale(travel) {
  const mesh = travel?.snailMesh;
  if (!mesh?.scale) return;
  // The fallback group's authored scale is SNAIL_VISUAL_SCALE. Installing the
  // realistic GLB resets the outer group to 1 because the child is normalized
  // to SNAIL_MODEL_LENGTH, so use the corresponding base in each state.
  const base = mesh.userData?.realisticSnail ? 1 : SNAIL_VISUAL_SCALE;
  mesh.scale.setScalar(base * COMMUNITY_SNAIL_SCALE);
  mesh.userData.communityScaleMultiplier = COMMUNITY_SNAIL_SCALE;
}

/** Install once at module load; safe to call again from tests or hot reloads. */
export function installCommunityFeedbackFixes() {
  if (installed) return;
  installed = true;

  // Combat safety belongs in the same always-loaded live-feedback layer so the
  // shipped game gets the fix without adding another boot path.
  installReloadSafety();

  const proto = InterplanetaryTravel.prototype;
  const spawnSurfaceSnail = proto._spawnSurfaceSnail;
  const resumeSurfaceSnail = proto._resumeSurfaceSnail;
  const loadHazardAssets = proto._loadHazardAssets;

  proto._spawnSurfaceSnail = function patchedSpawnSurfaceSnail(player, opening = false) {
    spawnSurfaceSnail.call(this, player, opening);
    applyReadableScale(this);
    if (!this.snailPlaced) return;

    const p = pointOf(player);
    if (!p) return;
    const distance = Math.hypot(this.snailPos.x - p.x, this.snailPos.z - p.z);
    // Opening spawns always leave the player's room when possible. Later
    // landings keep the authored placement unless it violates the same safety
    // bubble.
    if (opening || distance < COMMUNITY_SNAIL_SAFE_DISTANCE) {
      moveSnailOutOfSpawn(this, player, opening);
    }
  };

  proto._resumeSurfaceSnail = function patchedResumeSurfaceSnail(player) {
    const p = pointOf(player);
    if (p && this.snailPlaced) {
      const distance = Math.hypot(this.snailPos.x - p.x, this.snailPos.z - p.z);
      if (distance < COMMUNITY_SNAIL_SAFE_DISTANCE) moveSnailOutOfSpawn(this, player, false);
    }
    const result = resumeSurfaceSnail.call(this, player);
    applyReadableScale(this);
    return result;
  };

  proto._loadHazardAssets = async function patchedLoadHazardAssets(...args) {
    const result = await loadHazardAssets.apply(this, args);
    // installRealisticSnail deliberately resets the outer group's scale to 1;
    // reapply the gameplay scale after the async replacement lands.
    applyReadableScale(this);
    return result;
  };
}
