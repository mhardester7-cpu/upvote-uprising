// The mystery box: spend score, get a gun, sometimes get a legendary.
//
// The box is the arena's one gamble. Chests hand out what the arena decided;
// the box lets the player decide -- bank points, walk to it, and pay for a roll.
// That choice is the whole feature, so the roll is deliberately theatrical: it
// takes a few seconds, the names flick past, and it slows down before landing.
// A box that instantly dropped a weapon would just be a vending machine.
//
// Like the chest, this file knows nothing about what a weapon id means. It rolls
// one from a weighted table and hands the id back.

import * as THREE from '../../vendor/three.module.js';
import { WEAPONS, TIER, TIERS, tierOf } from '../combat/weapons.js';

/** Points per roll. High enough to be a decision, low enough to be reachable. */
export const BOX_COST = 950;

export const BOX_RADIUS = 2.8;
/** Seconds the roll takes before it reveals. */
export const ROLL_TIME = 3.2;
/** Seconds the prize hovers above the box before it drops. */
export const PRESENT_TIME = 1.1;

/**
 * Weapons the box will never hand out, and why.
 *
 * The two starting weapons would be a dead roll -- paying 950 for the pistol you
 * are already holding is the worst outcome the table could produce. The airstrike
 * is a kill-drop reward and stays one; putting it here would let a player buy
 * what the streak system is supposed to be paying out.
 */
const BOX_EXCLUDES = new Set(['pistol', 'pickaxe', 'airstrike']);

/**
 * Weighted prize table, derived from the rarity ladder in weapons.js.
 *
 * Every weapon's pull weight is its tier's `boxWeight`, so the odds and the
 * rarity a player sees on the gun are the same fact. The weights used to be
 * typed in per gun here, which meant the table and the gold "legendary" label in
 * the HUD were two independent opinions -- and a new weapon could be added with
 * a rare's weight and a common's colour with nothing to catch it.
 *
 * The commons are a real outcome, not filler: pulling an SMG on a 950 roll
 * should still feel like getting a gun.
 */
export const BOX_POOL = WEAPONS
  .filter((w) => !BOX_EXCLUDES.has(w.id))
  .map((w) => ({ id: w.id, tier: w.tier, weight: tierOf(w).boxWeight }))
  // Rarest last, so the table reads like the ladder it comes from.
  .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));

const TOTAL_WEIGHT = BOX_POOL.reduce((sum, e) => sum + e.weight, 0);

/** Odds per tier, so the box can advertise itself honestly. */
export const TIER_CHANCE = TIERS.map((t, i) =>
  BOX_POOL.filter((e) => e.tier === i).reduce((s, e) => s + e.weight, 0) / TOTAL_WEIGHT);

/** Odds of a legendary on any single roll. */
export const LEGENDARY_CHANCE = TIER_CHANCE[TIER.LEGENDARY];

/** One weighted draw. */
export function rollBox(rng = Math.random) {
  let roll = rng() * TOTAL_WEIGHT;
  for (const entry of BOX_POOL) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return BOX_POOL[0];
}

const PURPLE = 0xa855f7;

let PROTO = null;

function buildProto() {
  const g = new THREE.Group();

  const woodMat = new THREE.MeshLambertMaterial({ color: 0x3c2a4a, emissive: 0x150a1e });
  const trimMat = new THREE.MeshLambertMaterial({ color: PURPLE, emissive: 0x3d1466 });
  const markMat = new THREE.MeshBasicMaterial({ color: 0xf0d0ff });

  // ---- body ----
  // Deliberately bigger than a loot chest: this is a landmark you navigate to,
  // not something you stumble over.
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.95, 1.1), woodMat);
  body.position.y = 0.475;
  body.castShadow = true;
  g.add(body);

  for (const sx of [-0.52, 0.52]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.13, 1.0, 1.14), trimMat);
    strap.position.set(sx, 0.475, 0);
    g.add(strap);
  }

  // ---- lid ----
  const lidPivot = new THREE.Group();
  lidPivot.position.set(0, 0.95, -0.55);
  lidPivot.name = 'lid';
  g.add(lidPivot);

  const lid = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.16, 1.1), woodMat);
  lid.position.set(0, 0.08, 0.55);
  lid.castShadow = true;
  lidPivot.add(lid);

  // A question mark spelled out in blocks on the lid, matching the voxel style.
  // Drawn from a bitmap so the glyph is legible rather than approximated.
  const MARK = [
    ' ### ',
    '#   #',
    '    #',
    '  ## ',
    '  #  ',
    '     ',
    '  #  ',
  ];
  const markGroup = new THREE.Group();
  markGroup.name = 'mark';
  const cell = 0.115;
  for (let r = 0; r < MARK.length; r++) {
    for (let c = 0; c < MARK[r].length; c++) {
      if (MARK[r][c] !== '#') continue;
      const px = new THREE.Mesh(new THREE.BoxGeometry(cell, 0.05, cell), markMat);
      px.position.set(
        (c - (MARK[r].length - 1) / 2) * cell,
        0.17,
        (r - (MARK.length - 1) / 2) * cell + 0.55,
      );
      markGroup.add(px);
    }
  }
  lidPivot.add(markGroup);

  // ---- the prize, hidden until a roll lands ----
  // A generic glowing crate. The actual weapon is handed over as a ground
  // pickup, so this only has to read as "something is coming out".
  const prize = new THREE.Group();
  prize.name = 'prize';
  prize.visible = false;
  const crate = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.36, 0.5),
    new THREE.MeshLambertMaterial({ color: 0xd9b45f, emissive: 0x6a4a08 }),
  );
  prize.add(crate);
  const halo = new THREE.Mesh(
    new THREE.BoxGeometry(0.62, 0.48, 0.62),
    new THREE.MeshBasicMaterial({
      color: 0xffe6a0, transparent: true, opacity: 0.28,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  prize.add(halo);
  prize.position.set(0, 1.55, 0);
  g.add(prize);

  // ---- beacon ----
  // Same visual language as the chests and stones, in the box's own colour, and
  // taller: it has to be findable from across the arena to be worth saving for.
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 26, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: PURPLE, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  beam.position.y = 26 * 0.46;
  beam.name = 'beam';
  g.add(beam);

  // No point light, for the same reason as the chests: a changing light count
  // recompiles every shader in the scene. The beam and the emissive trim carry it.

  return g;
}

export class MysteryBox {
  constructor(x, y, z, yaw = 0) {
    this.x = x; this.y = y; this.z = z;
    this.phase = Math.random() * Math.PI * 2;

    this.rolling = false;
    this.rollT = 0;
    this.presentT = 0;
    this.result = null;      // the entry that won, once the roll lands
    this.previewId = null;   // what the HUD should be showing right now
    this.flick = 0;
    /** Set for exactly one frame when the prize is ready to hand over. */
    this.payout = null;

    if (!PROTO) PROTO = buildProto();
    this.mesh = PROTO.clone();
    this.mesh.position.set(x, y, z);
    this.mesh.rotation.y = yaw;

    // clone() drops userData references, so resolve the moving parts by name --
    // the same trick the chest and the stone halo use.
    this.lid = this.mesh.getObjectByName('lid');
    this.beam = this.mesh.getObjectByName('beam');
    this.prize = this.mesh.getObjectByName('prize');
    this.mark = this.mesh.getObjectByName('mark');
    this.beam.material = this.beam.material.clone();
  }

  get busy() { return this.rolling || this.presentT > 0; }

  /**
   * Pay for a roll.
   * @returns the winning entry, or null if a roll is already running
   */
  startRoll(rng = Math.random) {
    if (this.busy) return null;
    this.rolling = true;
    this.rollT = 0;
    this.flick = 0;
    this.result = rollBox(rng);
    this.previewId = this.result.id;
    return this.result;
  }

  update(dt) {
    this.phase += dt;
    this.payout = null;

    // Idle breathing, so the box reads as live from a distance.
    const pulse = 0.85 + Math.sin(this.phase * 1.8) * 0.22;
    this.beam.material.opacity = 0.3 * pulse;
    if (this.mark) this.mark.rotation.y = 0;

    if (this.rolling) {
      this.rollT += dt;
      const t = Math.min(1, this.rollT / ROLL_TIME);

      // Lid cracks open and the light swells as the roll builds.
      this.lid.rotation.x = -(0.35 + t * 1.35);
      this.beam.material.opacity = 0.3 * (1 + t * 1.6);

      // Names flick past fast at first and slow toward the reveal. A linear
      // cycle reads as a list scrolling; this reads as something deciding.
      const speed = 26 * (1 - t) ** 2 + 1.2;
      this.flick += dt * speed;
      this.previewId = t >= 1
        ? this.result.id
        : BOX_POOL[Math.floor(this.flick) % BOX_POOL.length].id;

      if (t >= 1) {
        this.rolling = false;
        this.presentT = PRESENT_TIME;
        this.previewId = this.result.id;
        this.prize.visible = true;
      }
      return;
    }

    if (this.presentT > 0) {
      this.presentT -= dt;
      const k = 1 - this.presentT / PRESENT_TIME;
      // Rises and spins while it is being shown off.
      this.prize.position.y = 1.55 + Math.sin(k * Math.PI) * 0.35;
      this.prize.rotation.y = k * Math.PI * 4;
      this.lid.rotation.x = -(1.7 - k * 1.7);

      if (this.presentT <= 0) {
        this.presentT = 0;
        this.prize.visible = false;
        this.lid.rotation.x = 0;
        // Hand the prize over exactly once.
        this.payout = this.result;
        this.result = null;
        this.previewId = null;
      }
    }
  }

  dispose() {
    this.beam.material.dispose();
  }

  /** True when the player is standing close enough to buy a roll. */
  inRange(player) {
    const dx = player.pos.x - this.x;
    const dz = player.pos.z - this.z;
    const dy = (player.pos.y + player.height * 0.5) - (this.y + 0.6);
    return dx * dx + dz * dz < BOX_RADIUS * BOX_RADIUS && Math.abs(dy) < 3.5;
  }
}

/**
 * Find a home for the box.
 *
 * Placed like the chests -- open ground, off the spawn plaza -- but deliberately
 * further out, and only ever one of them. The walk is part of the cost.
 */
export function placeMysteryBox(world, avoidX, avoidZ, avoid = [], minDist = 26) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const x = 10 + Math.random() * (world.size - 20);
    const z = 10 + Math.random() * (world.size - 20);

    if (Math.hypot(x - avoidX, z - avoidZ) < minDist) continue;

    let clash = false;
    for (const a of avoid) {
      if (Math.hypot(x - a.x, z - a.z) < 7) { clash = true; break; }
    }
    if (clash) continue;

    // Has to be ground the player can actually walk to, or the box is a tease.
    if (!world.isWalkable(x, z)) continue;

    // It is a big box, so the whole footprint needs level ground -- otherwise it
    // sinks into a slope at one corner and floats at the other.
    const y = world.heightAt(x, z);
    let uneven = false;
    for (let ox = -1.4; ox <= 1.4 && !uneven; ox += 1.4) {
      for (let oz = -1.4; oz <= 1.4; oz += 1.4) {
        if (Math.abs(world.heightAt(x + ox, z + oz) - y) > 0.65) { uneven = true; break; }
      }
    }
    if (uneven) continue;

    // Clear of trees and rubble, with room to walk around it.
    let inProp = false;
    for (const pr of world.propsNear(x, z, 3.5, [])) {
      const c = pr.collider;
      const d = c.kind === 'box'
        ? Math.hypot(Math.max(c.minX - x, 0, x - c.maxX), Math.max(c.minZ - z, 0, z - c.maxZ))
        : Math.hypot(x - c.x, z - c.z) - c.r;
      if (d < 2.6) { inProp = true; break; }
    }
    if (inProp) continue;

    return new MysteryBox(x, y, z, Math.random() * Math.PI * 2);
  }
  return null;
}
