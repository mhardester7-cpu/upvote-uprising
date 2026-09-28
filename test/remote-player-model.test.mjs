// The supplied multiplayer soldier is a binary art dependency, so validate the
// parts that would otherwise fail only when a second browser joins a live game.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel, encoding = null) => readFileSync(path.join(ROOT, rel), encoding);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function parseGlb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF', 'not a binary glTF');
  assert.equal(bytes.readUInt32LE(4), 2, 'player model must be glTF 2.0');
  assert.equal(bytes.readUInt32LE(8), bytes.length, 'GLB length header is stale');
  let json = null;
  let binary = null;
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString().replace(/\0+\s*$/, ''));
    if (type === 0x004e4942) binary = chunk;
    offset += 8 + length;
  }
  assert.ok(json && binary, 'GLB needs JSON and binary chunks');
  return { json, binary };
}

test('supplied tactical soldier binary, texture and humanoid rig are intact', () => {
  const bytes = read('assets/characters/tactical_soldier/tactical_soldier.glb');
  assert.equal(sha256(bytes),
    '761d092abffaf1a127afd3fccf60b63078730c168f4415998f104456e82dead9');
  const { json, binary } = parseGlb(bytes);

  assert.equal(json.skins.length, 1);
  assert.equal(json.skins[0].joints.length, 24);
  assert.equal(json.meshes.length, 1);
  assert.equal(json.nodes.filter((node) => node.skin !== undefined).length, 1);
  const names = new Set(json.nodes.map((node) => node.name));
  for (const bone of [
    'Hips', 'Spine', 'Spine01', 'Spine02', 'Head',
    'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand',
    'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot',
  ]) assert.ok(names.has(bone), `missing player bone ${bone}`);

  assert.equal(json.animations.length, 1);
  assert.match(json.animations[0].name, /walk/i);
  assert.equal(json.animations[0].channels.length, 72);
  const imageView = json.bufferViews[json.images[0].bufferView];
  const embeddedPng = binary.subarray(
    imageView.byteOffset ?? 0, (imageView.byteOffset ?? 0) + imageView.byteLength);
  assert.equal(sha256(embeddedPng),
    '627d0233c656973553c337e37c9df2a18eecb67fec90bdef3651d7a824e15dab');
});

test('remote players preload independent skeletons and correct the source material', () => {
  const src = read('src/render/remoteplayer.js', 'utf8');
  assert.match(src, /export function preloadRemotePlayerModel/);
  assert.match(src, /cloneSkinned\(playerPrototype\.scene\)/,
    'remote players must not share one live skeleton');
  assert.match(src, /emissiveMap = null/,
    'the source atlas must not remain wired to full-strength emissive');
  assert.match(src, /emissiveIntensity = 0/);
  assert.match(src, /solveLimb\(rig\.bones\.LeftFoot/);
  assert.match(src, /rightGrip/);
  assert.match(src, /leftGrip/);
  assert.match(src, /buildLoadedPlayer\(remote\) \|\| buildSoldierMesh\(remote\)/,
    'a failed binary load needs a complete procedural fallback');

  const main = read('src/main.js', 'utf8');
  assert.match(main, /preloadRemotePlayerModel\(\)/,
    'the model must be ready before synchronous network reconciliation');
});

test('model viewer exposes every multiplayer pose used for visual QA', () => {
  const viewer = read('tools/modelviewer.html', 'utf8');
  assert.match(viewer, /await preloadRemotePlayerModel\(\)/);
  assert.match(viewer, /\['idle', 'walk', 'aim', 'down'\]/);
  assert.match(viewer, /setPlayerState/);
});

test('player-model provenance records exact supplied bytes without inventing a license', () => {
  const note = read('assets/characters/tactical_soldier/README.md', 'utf8');
  assert.match(note, /supplied directly by the project owner/i);
  assert.match(note, /No author, source URL, or third-party license\s+metadata was included/i);
  assert.match(note, /761d092abffaf1a127afd3fccf60b63078730c168f4415998f104456e82dead9/);
});
