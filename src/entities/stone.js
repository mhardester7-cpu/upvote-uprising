// Infinity stones: five collectibles hidden around the arena.
//
// Gathering all five arms the snap -- a panic button that only works when the
// player is already hurt, so the reward for exploring is a comeback, not a
// permanent advantage.

import * as THREE from '../../vendor/three.module.js';

export const STONES = [
  { id: 'space',   label: 'SPACE',   color: 0x3d7bd6 },
  { id: 'mind',    label: 'MIND',    color: 0xe0c531 },
  { id: 'reality', label: 'REALITY', color: 0xd0392f },
  { id: 'power',   label: 'POWER',   color: 0x8b3fd4 },
  { id: 'time',    label: 'TIME',    color: 0x3fbf6a },
];

export const STONE_PICKUP_RADIUS = 2.2;

const PROTOS = new Map();

function buildProto(color) {
  const g = new THREE.Group();

  // The gem itself -- an octahedron reads as "gemstone" at voxel scale where a
  // a plain sphere would read as a pickup orb. Half a metre across.
  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.25, 0),
    new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.85 }),
  );
  gem.name = 'gem';
  g.add(gem);

  // Additive halo so it is spottable from a distance and through dim light.
  const halo = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.43, 0),
    new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.28,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  halo.name = 'halo';
  g.add(halo);

  // Deliberately no beacon column. A stone visible from across the arena is a
  // stone you walk to, not one you hunt for -- and it makes the treasure maps
  // redundant, since their whole job is telling you where a stone is. The gem
  // still lights its own surroundings, so it reads clearly once you are close.
  // No point light -- see chest.js. Five stones alone were five recompile
  // triggers; the gem's emissive and halo still read at close range.

  return g;
}

export class Stone {
  constructor(def, x, y, z) {
    this.def = def;
    this.x = x; this.y = y; this.z = z;
    this.phase = Math.random() * Math.PI * 2;
    this.taken = false;

    if (!PROTOS.has(def.id)) PROTOS.set(def.id, buildProto(def.color));
    this.mesh = PROTOS.get(def.id).clone();
    this.mesh.position.set(x, y + 1.1, z);
    // Object3D.clone() round-trips userData through JSON, so object references
    // stored there do not survive. Resolve the animated parts by name instead.
    this.halo = this.mesh.getObjectByName('halo');
  }

  update(dt) {
    this.phase += dt;
    this.mesh.rotation.y = this.phase * 1.1;
    this.mesh.rotation.x = Math.sin(this.phase * 0.7) * 0.35;
    this.mesh.position.y = this.y + 1.1 + Math.sin(this.phase * 1.6) * 0.18;

    const pulse = 1 + Math.sin(this.phase * 3) * 0.12;
    this.halo?.scale.setScalar(pulse);
  }

  inRange(player) {
    const dx = player.pos.x - this.x;
    const dz = player.pos.z - this.z;
    const dy = (player.pos.y + player.height * 0.5) - (this.y + 1.1);
    return dx * dx + dz * dz < STONE_PICKUP_RADIUS * STONE_PICKUP_RADIUS
      && Math.abs(dy) < 3.5;
  }
}

/**
 * Choose five hiding places spread across the arena.
 *
 * Constraints: away from the spawn plaza (so they must be sought out), away
 * from each other (so one trip cannot collect them all), and on open ground.
 */
export function placeStones(world, avoidX, avoidZ) {
  const chosen = [];
  const minApart = world.size * 0.22;

  for (const def of STONES) {
    let best = null;
    for (let attempt = 0; attempt < 400; attempt++) {
      const x = 10 + Math.random() * (world.size - 20);
      const z = 10 + Math.random() * (world.size - 20);

      // Not in the middle of the spawn plaza.
      if (Math.hypot(x - avoidX, z - avoidZ) < 34) continue;

      // Not stacked on another stone.
      let clash = false;
      for (const c of chosen) {
        if (Math.hypot(x - c.x, z - c.z) < minApart) { clash = true; break; }
      }
      if (clash) continue;

      // Must sit on ground you can actually stand on to collect it.
      if (!world.isWalkable(x, z)) continue;

      // Clear of trees and rubble, or the gem ends up inside a trunk.
      const near = world.propsNear(x, z, 2.5, []);
      let blocked = false;
      for (const pr of near) {
        const c = pr.collider;
        const d = c.kind === 'box'
          ? Math.hypot(Math.max(c.minX - x, 0, x - c.maxX), Math.max(c.minZ - z, 0, z - c.maxZ))
          : Math.hypot(x - c.x, z - c.z) - c.r;
        if (d < 2.0) { blocked = true; break; }
      }
      if (blocked) continue;

      best = { x, y: world.heightAt(x, z), z };
      break;
    }
    // Fall back to any valid spawn point rather than dropping a stone entirely;
    // all five must exist or the snap can never be earned.
    if (!best) best = world.findSpawn(avoidX, avoidZ, 60);
    chosen.push(new Stone(def, best.x, best.y, best.z));
  }

  return chosen;
}
