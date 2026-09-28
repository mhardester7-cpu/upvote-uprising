import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

import { sampleWindowVault } from '../src/entities/enemy.js';
import {
  CHARACTER_CLIP_SPEED, classifyCharacterClips, locomotionPlaybackRate,
  locomotionState, sampleVaultPose,
} from '../src/render/zombieanimation.js';
import { NetEnemy } from '../src/net/session.js';

const clip = (name) => ({ name });

test('a character with one locomotion clip never idles while running or vaulting', () => {
  const walk = clip('Undead Shamble Locomotion');
  const idle = clip('Grunt Idle');
  const states = classifyCharacterClips([idle, walk, clip('Zombie Attack')]);

  assert.equal(states.walk, walk);
  assert.equal(states.run, walk, 'missing run did not fall back to locomotion');
  assert.equal(states.vault, walk, 'missing vault did not fall back to locomotion');
  assert.notEqual(states.run, idle, 'fast movement fell back to an idle pose');
});

test('run clip classification recognises real pack naming without matching Grunt', () => {
  const running = clip('Zombie Running');
  const states = classifyCharacterClips([clip('Grunt Idle'), running]);
  assert.equal(states.run, running);

  const noMovement = classifyCharacterClips([clip('Grunt Idle'), clip('Attack')]);
  assert.equal(noMovement.run, undefined, 'the word Grunt was mistaken for Run');
});

test('the installed zombie pack includes the dedicated running FBX in its manifest', () => {
  const manifest = JSON.parse(readFileSync(
    new URL('../assets/manifest.json', import.meta.url), 'utf8'));
  const zombie = manifest.characters.find((entry) => entry.role === 'zombie');
  assert.ok(zombie, 'there is no installed zombie role');
  assert.ok(zombie.clips.some((name) => /running/i.test(name)),
    'the zombie manifest does not request its run animation');

  const file = new URL('../assets/characters/char_city_zombie/Zombie Running.fbx', import.meta.url);
  assert.ok(statSync(file).size > 100_000, 'the run FBX is missing or truncated');
});

test('the runner keeps the installed realistic zombie and its dedicated run clip', () => {
  const characterSource = readFileSync(
    new URL('../src/render/charactermodels.js', import.meta.url), 'utf8');
  const roles = characterSource.match(/export const CHARACTER_ROLES = \{([\s\S]*?)\};/)?.[1] || '';
  assert.match(roles, /^\s*runner\s*:\s*'zombie'/m,
    'runner was routed back through the rigid procedural body');

  const walk = clip('Zombie Walk');
  const run = clip('Zombie Running');
  const states = classifyCharacterClips([walk, run, clip('Zombie Idle')]);
  assert.equal(states.walk, walk);
  assert.equal(states.run, run, 'runner does not select the installed running performance');
  assert.notEqual(states.run, states.walk, 'runner is stretching the shamble instead of running');

  assert.equal(locomotionState(4), 'run');
  const rate = locomotionPlaybackRate('run', 4);
  assert.ok(Math.abs(rate - 4 / CHARACTER_CLIP_SPEED.run) < 1e-9,
    `4m/s runner plays its ${CHARACTER_CLIP_SPEED.run}m/s clip at ${rate.toFixed(2)}x`);
  assert.ok(rate < 1.7, 'runner animation is sped into an implausible blur');
  assert.equal(locomotionState(0), 'idle', 'stationary realistic zombie runs in place');
});

test('co-op interpolation supplies the realistic runner animation its actual speed', () => {
  const enemy = new NetEnemy(12, 'runner');
  enemy.applyNet(snapshot(-1), { ...snapshot(-1), x: 0.4 }, 1, 0.1);
  const speed = Math.hypot(enemy.vel.x, enemy.vel.z);
  assert.ok(Math.abs(speed - 4) < 1e-9,
    `interpolated runner reported ${speed}m/s instead of 4m/s`);
  assert.equal(locomotionState(speed), 'run');
  assert.ok(locomotionPlaybackRate('run', speed) > 1.5,
    'co-op runner did not advance the run clip quickly enough for its ground speed');
});

test('window traverse has a planted takeoff, airborne clearance, and planted landing', () => {
  const load = sampleWindowVault(0.12);
  const middle = sampleWindowVault(0.50);
  const land = sampleWindowVault(0.90);

  assert.ok(load.travel < 0.03, `takeoff slid ${load.travel.toFixed(3)} of the traverse`);
  assert.equal(load.lift, 0, 'feet left the floor before the planted load-up');
  assert.ok(middle.travel > 0.4 && middle.travel < 0.6);
  assert.ok(middle.lift > 1.1, `the tuck only lifted ${middle.lift.toFixed(2)}m`);
  assert.ok(land.travel > 0.97, 'the landing did not plant on the far side');
  assert.equal(land.lift, 0, 'feet were still floating during the landing beat');
});

test('vault pose tucks limbs under a modest lean instead of rolling the body', () => {
  const pose = sampleVaultPose(0.31, 1);
  assert.ok(pose.pitch > 0.35 && pose.pitch < 0.60,
    `root pitch ${pose.pitch.toFixed(2)} is not a forward vault lean`);
  assert.ok(Math.abs(pose.roll) < 0.12, 'vault still barrel-rolls the whole body');
  assert.ok(pose.crouch > 0.8, 'airborne pose did not tuck under the header');
  assert.ok(pose.leadLeg < -1 && pose.trailLeg > 0.6,
    'lead knee and trailing leg do not describe a leap');
});

function snapshot(v) {
  return {
    x: 0, y: 0, z: 0, r: 0, w: 0, k: 0, m: 0, d: 0,
    h: 100, mh: 100, f: -1, a: 1, v,
  };
}

test('co-op clients interpolate vault pose progress and finish the landing', () => {
  const enemy = new NetEnemy(9, 'grunt');
  enemy.applyNet(snapshot(0.2), snapshot(0.6), 0.5);
  assert.ok(Math.abs(enemy.vault.progress - 0.4) < 1e-9,
    'remote vault snapped to the newest server pose');

  enemy.applyNet(snapshot(0.72), snapshot(-1), 0.5);
  assert.ok(enemy.vault && enemy.vault.progress > 0.72,
    'remote body dropped its landing pose between snapshots');
  enemy.applyNet(snapshot(0.72), snapshot(-1), 1);
  assert.equal(enemy.vault, null, 'remote vault state survived the grounded snapshot');
});
