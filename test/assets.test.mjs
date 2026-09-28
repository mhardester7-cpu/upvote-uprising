// The asset pipeline's contracts.
//
// None of this can render in node, so these are the checks that do not need a
// GPU and would otherwise only fail in front of a player:
//
//   The manifest names things that exist. A weapon entry pointing at an id that
//   viewmodel.js has no builder for silently never loads; a character role
//   pointing at an enemy type that was renamed does the same. Both are one typo
//   away and neither shows up as an error at runtime -- the code is written to
//   treat "no such asset" as normal, which is exactly what hides a typo.
//
//   Every asset carries the attribution it obliges. Most of this art is CC-BY,
//   where a missing author or source URL is not a cosmetic problem, it is a
//   licence violation. Nothing renders it optional, so it is asserted.
//
// The render modules are read as source rather than imported: they pull in
// three.js, which wants a browser. Reading the file is uglier than importing it
// and it is the only way these invariants get checked at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { ENEMY_TYPES } from '../src/entities/enemy.js';
import {
  assertSafeArchiveEntries, download, parseAssetArgs, pickMap, renderAttributions,
  resolveInside, selectOgaFiles,
} from '../tools/fetch-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const manifest = JSON.parse(read('assets/manifest.json'));

function readGlb(rel) {
  const bytes = readFileSync(path.join(ROOT, rel));
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF', `${rel}: invalid GLB magic`);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  const binHeader = 20 + jsonLength;
  assert.equal(bytes.readUInt32LE(binHeader + 4), 0x004e4942, `${rel}: missing BIN chunk`);
  const binaryLength = bytes.readUInt32LE(binHeader);
  const binStart = binHeader + 8;
  const binary = bytes.subarray(binStart, binStart + binaryLength);
  return { bytes, json, binStart, binary };
}

function embeddedImageDimensions(glb, image) {
  const view = glb.json.bufferViews[image.bufferView];
  const start = glb.binStart + (view.byteOffset ?? 0);
  const end = start + view.byteLength;
  if (image.mimeType === 'image/png') {
    assert.equal(glb.bytes.toString('hex', start, start + 8), '89504e470d0a1a0a');
    return [glb.bytes.readUInt32BE(start + 16), glb.bytes.readUInt32BE(start + 20)];
  }
  assert.equal(image.mimeType, 'image/jpeg');
  assert.equal(glb.bytes.readUInt16BE(start), 0xffd8);
  let offset = start + 2;
  while (offset + 8 < end) {
    while (offset < end && glb.bytes[offset] !== 0xff) offset++;
    while (offset < end && glb.bytes[offset] === 0xff) offset++;
    const marker = glb.bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    const length = glb.bytes.readUInt16BE(offset);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]
      .includes(marker)) {
      return [glb.bytes.readUInt16BE(offset + 5), glb.bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw new Error('JPEG dimensions not found');
}

function glbAccessor(json, binary, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type];
  const length = accessor.count * components;
  const Type = {
    5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
  }[accessor.componentType];
  assert.ok(Type, `unsupported GLB accessor component type ${accessor.componentType}`);
  return new Type(binary.buffer, binary.byteOffset + offset, length);
}

function connectedComponentSizes(vertexCount, indices) {
  const parent = Int32Array.from({ length: vertexCount }, (_, index) => index);
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  for (let index = 0; index < indices.length; index += 3) {
    union(indices[index], indices[index + 1]);
    union(indices[index], indices[index + 2]);
  }
  const counts = new Map();
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const root = find(vertex);
    counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  return Array.from({ length: vertexCount }, (_, vertex) => counts.get(find(vertex)));
}

const SECTIONS = ['audio', 'terrain', 'surfaces', 'photos', 'creatures', 'env', 'props', 'weapons', 'hands',
                  'attachments', 'characters', 'kit', 'vehicles'];

// --------------------------------------------------------------- the manifest

test('every manifest entry is available and credited', () => {
  for (const section of SECTIONS) {
    const entries = manifest[section];
    assert.ok(Array.isArray(entries) && entries.length, `${section} is missing or empty`);
    for (const e of entries) {
      const where = `${section}/${e.slug || e.title}`;
      // Fetchable.
      assert.ok(['polyhaven', 'oga', 'sketchfab', 'direct', 'audio-archive'].includes(e.source),
        `${where}: bad source`);
      if (e.source === 'polyhaven') {
        assert.ok(e.slug, `${where}: no slug`);
        assert.ok(['texture', 'model', 'hdri'].includes(e.kind), `${where}: bad kind ${e.kind}`);
      } else if (e.source === 'oga') {
        assert.ok(e.id, `${where}: no id`);
        assert.match(e.url ?? '', /^https:\/\/opengameart\.org\//, `${where}: not an OGA url`);
        assert.ok(e.pick, `${where}: no pick -- which file in the archive?`);
        if (e.includeModels !== undefined) {
          assert.equal(typeof e.includeModels, 'boolean', `${where}: includeModels must be boolean`);
        }
        // The runtime only speaks these three, and a pick it cannot load is a
        // slot that silently keeps its built model.
        assert.match(e.pick, /\.(obj|fbx|gltf|glb)$/i, `${where}: pick "${e.pick}" is not loadable`);
        if (e.conversion !== undefined) {
          assert.equal(e.conversion, 'ascii-fbx-obj', `${where}: unknown conversion ${e.conversion}`);
          assert.match(e.pick, /\.fbx$/i, `${where}: ASCII FBX conversion needs an FBX source`);
          assert.match(e.convertedPath ?? '', /\.obj$/i, `${where}: ASCII FBX conversion must output OBJ`);
        }
      } else if (e.source === 'sketchfab') {
        // A 32-hex uid is what the download endpoint takes; anything else is a
        // page URL someone pasted, and it would 404 unattended.
        assert.match(e.uid ?? '', /^[0-9a-f]{32}$/, `${where}: not a Sketchfab uid`);
      } else if (e.source === 'direct') {
        if (e.url?.startsWith('local:')) {
          assert.ok(existsSync(resolveInside(ROOT, e.url.slice('local:'.length))),
            `${where}: bundled source asset is missing`);
        } else {
          assert.match(e.url ?? '', /^https:\/\//, `${where}: no direct download URL`);
        }
        assert.match(e.path ?? '', /\.(png|jpe?g|webp|hdr|ogg|mp3|wav|glb|gltf|fbx|obj)$/i,
          `${where}: direct asset has no usable path`);
        if (e.encoding !== undefined) {
          assert.equal(e.encoding, 'p3d', `${where}: unknown direct encoding ${e.encoding}`);
          assert.match(e.path, /\.glb$/i, `${where}: P3D conversion must output GLB`);
        }
      } else {
        assert.match(e.url ?? '', /^https:\/\/opengameart\.org\//,
          `${where}: audio archive is not hosted by its credited source`);
        assert.ok(e.id && e.path && Array.isArray(e.clips) && e.clips.length,
          `${where}: incomplete audio archive recipe`);
        for (const clip of e.clips) {
          assert.match(clip.pick ?? '', /\.(wav|ogg|mp3|flac)$/i, `${where}: bad source clip`);
          assert.match(clip.path ?? '', /\.(ogg|mp3|wav)$/i, `${where}: bad output clip`);
        }
      }
      // Creditable. This is the licence-compliance half.
      assert.ok(e.title, `${where}: no title`);
      assert.ok(e.author, `${where}: no author to credit`);
      assert.ok(['CC0', 'CC-BY'].includes(e.license), `${where}: licence ${e.license}`);
      assert.match(e.page ?? '', /^https:\/\//, `${where}: no source URL`);
    }
  }
});

test('no restrictive licence slipped into the manifest', () => {
  // NonCommercial and ShareAlike are the two that a commercial game cannot
  // simply credit its way out of, and both are one careless copy-paste away
  // from being in here.
  const raw = read('assets/manifest.json');
  for (const bad of ['NonCommercial', 'ShareAlike', 'NoDerivs', 'CC-BY-NC', 'CC-BY-SA']) {
    assert.ok(!raw.includes(bad), `manifest mentions ${bad}`);
  }
});

test('no two assets land in the same directory', () => {
  const seen = new Map();
  for (const section of SECTIONS) {
    for (const e of manifest[section]) {
      const key = e.source === 'polyhaven' ? `${e.kind}:${e.slug}`
        : e.source === 'oga' ? `oga:${e.id}`
          : e.source === 'direct' ? `direct:${e.path}`
            : e.source === 'audio-archive' ? `audio:${e.id}` : `sf:${e.uid}`;
      // The same texture serving two roles is fine; the same *slot* twice is a
      // silent overwrite where one of the two never appears.
      const prior = seen.get(key);
      if (prior && prior !== section) continue;
      assert.ok(!prior, `${key} appears twice in ${section}`);
      seen.set(key, section);
    }
  }
});

test('the installed hazard models use complete browser-loadable containers', () => {
  const snailPath = path.join(ROOT, 'assets/creatures/inevitable_snail/snail-v2.glb');
  const bananaPath = path.join(ROOT, 'assets/creatures/banana/banana.glb');
  assert.ok(existsSync(snailPath), 'complete realistic snail is missing');
  assert.ok(existsSync(bananaPath), 'converted banana model is missing');

  const snail = readFileSync(snailPath);
  assert.equal(snail.toString('ascii', 0, 4), 'glTF');
  assert.equal(snail.readUInt32LE(4), 2, 'snail must be a GLB 2.0 file');
  assert.equal(snail.readUInt32LE(8), snail.length, 'snail GLB payload is truncated');
  const jsonLength = snail.readUInt32LE(12);
  const gltf = JSON.parse(snail.toString('utf8', 20, 20 + jsonLength));
  const nodeNames = new Set(gltf.nodes.map((node) => node.name));
  assert.ok(nodeNames.has('Shell'), 'snail shell is missing');
  assert.ok(nodeNames.has('Snail'), 'authored snail body is missing');
  assert.ok(!nodeNames.has('Leaf') && !nodeNames.has('Water'),
    'presentation scenery leaked into the pursuit asset');
  assert.ok(![...nodeNames].some((name) => /\.001$/.test(name)),
    'mirrored presentation duplicate leaked into the pursuit asset');
  assert.equal(gltf.meshes.length, 2, 'snail should contain its authored shell and body meshes');
  assert.ok(gltf.materials.length >= 2, 'snail shell and body lost their separate PBR materials');
  assert.ok(gltf.images.length >= 4, 'snail lost its embedded PBR textures');
  const triangles = gltf.meshes.flatMap((mesh) => mesh.primitives).reduce((sum, primitive) => {
    const accessor = primitive.indices === undefined
      ? gltf.accessors[primitive.attributes.POSITION] : gltf.accessors[primitive.indices];
    return sum + accessor.count / 3;
  }, 0);
  assert.ok(triangles > 15_000, `realistic snail has only ${triangles} triangles`);

  const snailEntry = manifest.creatures.find((entry) => entry.id === 'inevitable_snail');
  assert.equal(snailEntry?.author, 'Rafael Rodrigues');
  assert.equal(snailEntry?.license, 'CC-BY');
  assert.equal(snailEntry?.path, 'inevitable_snail/snail-v2.glb');

  const banana = readFileSync(bananaPath);
  assert.equal(banana.toString('ascii', 0, 4), 'glTF');
  assert.equal(banana.readUInt32LE(4), 2, 'banana must be a GLB 2.0 file');
});

test('cross-browser landmark textures use core formats within the mobile GPU budget', () => {
  for (const rel of [
    'assets/creatures/cat/maggie-animated-v3.glb',
    'assets/creatures/inevitable_snail/snail-v2.glb',
    'assets/models/critical_button-v2.glb',
  ]) {
    const glb = readGlb(rel);
    assert.ok(!glb.json.extensionsRequired?.includes('EXT_texture_webp'),
      `${rel}: WebP is required without a core PNG/JPEG fallback`);
    assert.ok(glb.json.images?.length, `${rel}: embedded PBR textures are missing`);
    for (const image of glb.json.images) {
      assert.ok(['image/png', 'image/jpeg'].includes(image.mimeType),
        `${rel}: ${image.mimeType} is not a core glTF image format`);
      assert.ok(Number.isInteger(image.bufferView), `${rel}: texture is external or missing`);
      const [width, height] = embeddedImageDimensions(glb, image);
      assert.ok(width <= 512 && height <= 512,
        `${rel}: ${width}x${height} texture exceeds the mobile budget`);
    }
  }
});

test('every textureless FBX material has an explicit non-white fallback', () => {
  const zombie = manifest.characters.find((entry) => entry.role === 'zombie');
  const eyes = zombie?.materialFallbacks?.defaultPolygonShader1;
  assert.ok(eyes, 'zombie eyeballs still rely on three nonexistent guessed textures');
  assert.notEqual(eyes.color?.toLowerCase(), '#ffffff');
  assert.ok(eyes.roughness > 0 && eyes.roughness < 1);

  const source = read('src/render/charactermodels.js');
  assert.match(source, /const fallback = materialFallbacks\[m\.name\]/);
  assert.match(source, /if \(fallback\) return std/,
    'explicit FBX fallbacks still issue texture requests before applying their color');
});

test('startup landmarks resolve before READY and later world upgrades stay serial', () => {
  const source = read('src/main.js');
  const start = source.indexOf('  async load() {');
  const end = source.indexOf('  // ------------------------------------------------------------------ co-op', start);
  const loading = source.slice(start, end);
  assert.doesNotMatch(loading,
    /(?:_mountWorldModels|_mountImportantButton|_mountDinosaurFactory|_mountReverseAquarium|_mountSpinningCat)\(/,
    'startup bypasses the required-asset gate with ad-hoc landmark loads');
  assert.match(loading, /await this\._loadRequiredWorldArt\(\{/,
    'the menu can become ready before the landmark models finish loading');
  assert.match(source, /this\._scheduleOptionalWorldArt\(250\)/,
    'later world changes never schedule their serial visual upgrades');
  assert.match(source, /await new Promise\(\(resolve\) => setTimeout\(resolve, 60\)\)/,
    'optional decode batches do not yield to browser input and rendering');
  assert.match(source, /this\._optionalArtDone\.has\(key\)/,
    'pause/resume can still destructively remount completed optional art');
  assert.match(source, /this\._upgradeRemotePlayerMeshes\(\)/,
    'already-visible co-op fallbacks never upgrade after the soldier loads');
  assert.match(source, /onMounted: \(prop\) => this\._modelFallbacks\?\.hide\(prop\)/,
    'model-backed colliders can still remain invisible while art streams');

  const models = read('src/render/models.js');
  assert.match(models, /if \(!isCurrent\(\)\) \{\s*return cancel\(\)/,
    'a stale world-model load can still attach props after a world switch');
  assert.match(source, /getExtension\('EXT_color_buffer_float'\)/,
    'post-processing assumes every WebGL2 browser can render RGBA16F');
  assert.match(source, /supportsMultisampledColor\(gl, internalFormat, candidateSamples\)/,
    'post-processing assumes Safari supports multisampling the chosen format');
  assert.match(source, /this\.pixelRatio >= 1\.25 \? 2 : 4/,
    'Safari at its exact 1.25 DPR cap still allocates the 4x multisample target');
  assert.match(source, /webglcontextlost/);
  assert.match(source, /GRAPHICS MEMORY WAS EXHAUSTED/,
    'a post-menu context loss still leaves the player on a silent frozen frame');
  assert.match(source, /this\.webkitCompatibility \? 0 : await preloadSurfaces\(\)/,
    'Safari still blocks its first menu on the full photographed wall pack');
  assert.match(source, /this\.webkitCompatibility\s*\? null\s*:\s*await terrainPhotoTextures\(512\)/,
    'Safari still blocks its first menu on the photographed terrain pack');

  const photosets = read('src/render/photosets.js');
  assert.doesNotMatch(photosets, /Promise\.all\(names\.map/,
    'terrain still decodes every photographed layer simultaneously');
  assert.doesNotMatch(photosets, /Promise\.all\(Object\.entries\(SURFACE_SETS\)/,
    'optional wall surfaces still decode every material simultaneously');
  assert.match(photosets, /bitmap\?\.close\?\.\(\)/,
    'terrain source bitmaps remain resident after their packed pixels are created');
});

test('the realistic rooftop performers are bundled as browser-loadable GLB 2.0 files', () => {
  for (const rel of [
    'assets/creatures/gorilla/gorilla-rigged.glb',
    'assets/models/realistic_drum_kit/drum-kit.glb',
  ]) {
    const bytes = readFileSync(path.join(ROOT, rel));
    assert.equal(bytes.toString('ascii', 0, 4), 'glTF', `${rel}: invalid GLB magic`);
    assert.equal(bytes.readUInt32LE(4), 2, `${rel}: not GLB 2.0`);
    assert.equal(bytes.readUInt32LE(8), bytes.length, `${rel}: truncated GLB payload`);
    assert.ok(bytes.length > 30_000, `${rel}: model geometry is unexpectedly small`);
  }
});

test('the rooftop banana machine ships its credited CC0 FBX source asset', () => {
  const rel = 'assets/models/banana_vending_machine/Vending Machines.fbx';
  const bytes = readFileSync(path.join(ROOT, rel));
  assert.ok(bytes.length > 25_000, 'vending-machine geometry was replaced by a placeholder');
  assert.equal(bytes.toString('ascii', 0, 18), 'Kaydara FBX Binary',
    'vending-machine asset is not a browser-loadable binary FBX');
  const entry = manifest.props.find((candidate) => candidate.id === 'banana_vending_machine');
  assert.equal(entry?.author, 'tiko479');
  assert.equal(entry?.license, 'CC0');
  assert.equal(entry?.pick, 'Vending Machines.fbx');
});

test('FBX vertices with excess influences retain normalized skinning weights quietly', () => {
  const loader = read('vendor/loaders/FBXLoader.js');
  assert.match(loader, /const retainedWeight = Weight\.reduce/);
  assert.match(loader, /Weight\[ i \] \/= retainedWeight/);
  assert.doesNotMatch(loader, /Vertex has more than 4 skinning weights/,
    'valid source art still floods the browser console with truncation warnings');
});

test('the shipped gorilla is skinned to the programmable seven-bone armature', () => {
  const { json: gltf, binary } = readGlb('assets/creatures/gorilla/gorilla-rigged.glb');
  const { json: sourceGltf, binary: sourceBinary } = readGlb(
    'assets/creatures/gorilla/gorilla.glb',
  );
  assert.equal(gltf.skins?.length, 1, 'gorilla GLB has no armature skin');
  assert.equal(gltf.skins[0].joints.length, 7, 'gorilla armature must include root and both three-bone arms');

  const boneNames = new Set(gltf.nodes.map((node) => node.name));
  for (const side of ['Left', 'Right']) {
    for (const part of ['UpperArm', 'ForeArm', 'Hand']) {
      assert.ok(boneNames.has(`Gorilla${side}${part}`), `missing ${side.toLowerCase()} ${part} bone`);
    }
  }
  for (const [primitiveIndex, primitive] of gltf.meshes[0].primitives.entries()) {
    assert.ok(Number.isInteger(primitive.attributes.JOINTS_0), 'mesh is missing joint indices');
    assert.ok(Number.isInteger(primitive.attributes.WEIGHTS_0), 'mesh is missing skin weights');

    // The source hand has a small disconnected finger/knuckle shell nested
    // inside the palm. It shows through as a floating dark piece while the
    // wrist rotates, so none of its vertices may remain in the rendered index.
    const positions = glbAccessor(gltf, binary, primitive.attributes.POSITION);
    const indices = glbAccessor(gltf, binary, primitive.indices);
    const joints = glbAccessor(gltf, binary, primitive.attributes.JOINTS_0);
    const weights = glbAccessor(gltf, binary, primitive.attributes.WEIGHTS_0);
    const renderedVertices = new Set(indices);
    const sourcePrimitive = sourceGltf.meshes[0].primitives[primitiveIndex];
    const sourceIndices = glbAccessor(sourceGltf, sourceBinary, sourcePrimitive.indices);
    const componentSizes = connectedComponentSizes(positions.length / 3, sourceIndices);
    for (const vertex of renderedVertices) {
      assert.ok(componentSizes[vertex] > 11,
        `loose ${componentSizes[vertex]}-vertex source island is still rendered`);
    }
    let handVertices = 0;
    let removedCapVertices = 0;
    let removedSoleVertices = 0;
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      const x = positions[vertex * 3];
      const y = positions[vertex * 3 + 1];
      const z = positions[vertex * 3 + 2];
      if (Math.abs(x) > 0.2 && Math.abs(x) < 0.7
          && y > 0.25 && y < 1.2 && Math.abs(z + 0.04) < 0.01
          && !renderedVertices.has(vertex)) {
        removedSoleVertices++;
      }
      if (!(Math.abs(x) > 0.42 && y < -1.25 && z < 0.55)) continue;
      handVertices++;
      if (!renderedVertices.has(vertex)) {
        removedCapVertices++;
        continue;
      }
      let dominant = 0;
      for (let slot = 1; slot < 4; slot++) {
        if (weights[vertex * 4 + slot] > weights[vertex * 4 + dominant]) dominant = slot;
      }
      const movingArmJoints = x > 0 ? new Set([5, 6]) : new Set([2, 3]);
      assert.ok(movingArmJoints.has(joints[vertex * 4 + dominant]),
        `front-hand vertex ${vertex} is still weighted to the stationary body`);
    }
    assert.ok(handVertices >= 30, 'gorilla front-hand envelope unexpectedly changed');
    assert.equal(removedCapVertices, 10,
      'the disconnected ten-vertex front-hand cap is still rendered');
    assert.equal(removedSoleVertices, 18,
      'the disconnected foot scraps are still rendered');
  }
});

test('the gorilla fur is a bundled CC0 photographic texture with provenance metadata', () => {
  const bytes = readFileSync(path.join(ROOT, 'assets/creatures/gorilla/gorilla-fur-cc0.jpg'));
  assert.equal(bytes[0], 0xff, 'fur texture is missing JPEG start marker');
  assert.equal(bytes[1], 0xd8, 'fur texture is not a JPEG');
  assert.ok(bytes.length > 400_000, 'fur texture was replaced by a low-detail placeholder');
  assert.ok(bytes.includes(Buffer.from('public domain (CC0)')),
    'source file lost its embedded public-domain declaration');
});

// ---------------------------------------------------- ids the code must know

test('every weapon in the manifest has a builder to replace', () => {
  const src = read('src/render/viewmodel.js');
  const block = src.match(/export const BUILDERS = \{([\s\S]*?)\};/);
  assert.ok(block, 'could not find BUILDERS in viewmodel.js');
  const ids = new Set([...block[1].matchAll(/(\w+):\s*build\w+/g)].map((m) => m[1]));
  assert.ok(ids.size >= 15, `only found ${ids.size} builders`);

  for (const e of manifest.weapons) {
    assert.ok(e.weapon, `${e.title}: no weapon id`);
    assert.ok(ids.has(e.weapon), `${e.title}: no builder called "${e.weapon}"`);
  }
  // Every slot covered, which is the promise the manifest is making.
  const covered = new Set(manifest.weapons.map((e) => e.weapon));
  // The paired-aperture device is an authored procedural prop rather than a
  // real firearm, so replacing it with a downloaded gun would erase its two
  // readable emitters instead of upgrading it.
  const proceduralOnly = new Set(['portalgun']);
  for (const id of ids) {
    if (!proceduralOnly.has(id)) assert.ok(covered.has(id), `weapon slot "${id}" has no model`);
  }
});

test('every character role maps to a real enemy type', () => {
  const src = read('src/render/charactermodels.js');
  const block = src.match(/export const CHARACTER_ROLES = \{([\s\S]*?)\};/);
  assert.ok(block, 'could not find CHARACTER_ROLES');
  const pairs = [...block[1].matchAll(/^\s*(\w+):\s*'([\w-]+)'/gm)];
  assert.ok(pairs.length, 'no roles mapped');

  const roles = new Set(manifest.characters.map((e) => e.role));
  for (const [, type, role] of pairs) {
    assert.ok(ENEMY_TYPES[type], `CHARACTER_ROLES maps unknown enemy type "${type}"`);
    assert.ok(roles.has(role), `enemy "${type}" wants role "${role}", which the manifest lacks`);
  }
});

test('the enemies whose silhouette carries the counter keep their built models', () => {
  // Not a style preference. The bulwark's shield and the abomination's back core
  // are how the player knows to flank rather than shoot, and a generic humanoid
  // body deletes that tell -- so these two must never be mapped to a download.
  const src = read('src/render/charactermodels.js');
  const block = src.match(/export const CHARACTER_ROLES = \{([\s\S]*?)\};/)[1];
  const mapped = new Set([...block.matchAll(/^\s*(\w+):\s*'[\w-]+'/gm)].map((m) => m[1]));
  for (const type of ['shielded', 'boss']) {
    assert.ok(ENEMY_TYPES[type], `${type} is no longer an enemy type`);
    assert.ok(!mapped.has(type), `${type} must keep its hand-built silhouette`);
  }
});

test('terrain layer art is one set per shader layer, in order', () => {
  const lab = read('src/render/texturelab.js');
  const count = Number(lab.match(/export const LAYER_COUNT = (\d+)/)[1]);
  const sets = read('src/render/photosets.js')
    .match(/export const TERRAIN_LAYER_SETS = \[([\s\S]*?)\];/)[1]
    .match(/'[^']+'/g).map((s) => s.slice(1, -1));

  assert.equal(sets.length, count, 'one photo set per shader layer');
  const installed = new Set(manifest.terrain.map((e) => e.slug));
  for (const name of sets) {
    assert.ok(installed.has(name), `layer art "${name}" is not in the terrain manifest`);
  }
});

// ------------------------------------------------------------ fetcher helpers

test('pickMap prefers candidate order, then jpeg', () => {
  const files = {
    Diffuse: { '1k': { png: { url: 'a.png' }, jpg: { url: 'a.jpg' } } },
    col: { '1k': { jpg: { url: 'b.jpg' } } },
  };
  assert.equal(pickMap(files, ['Diffuse', 'col'], '1k'), 'a.jpg', 'jpeg wins over png');
  assert.equal(pickMap(files, ['col', 'Diffuse'], '1k'), 'b.jpg', 'candidate order wins');
  assert.equal(pickMap(files, ['Nope'], '1k'), null, 'a missing map is null, not a throw');
  assert.equal(pickMap(files, ['Diffuse'], '4k'), null, 'a missing resolution is null');
});

test('asset CLI rejects misspelled or empty section filters', () => {
  assert.deepEqual(parseAssetArgs(['--force', '--only=terrain,env']), {
    force: true, wantSketchfab: false, only: ['terrain', 'env'],
  });
  assert.throws(() => parseAssetArgs(['--only=']), /needs at least one section/);
  assert.throws(() => parseAssetArgs(['--only=terrian']), /unknown asset section/);
  assert.throws(() => parseAssetArgs(['--wat']), /unknown argument/);
});

test('manifest paths cannot escape their assigned asset directory', () => {
  const base = path.join(os.tmpdir(), 'deadfall-assets-root');
  assert.equal(resolveInside(base, 'models', 'scene.gltf'), path.join(base, 'models', 'scene.gltf'));
  assert.throws(() => resolveInside(base, '..', 'outside.glb'), /escapes its output directory/);
  assert.throws(() => resolveInside(base, path.parse(base).root, 'outside.glb'), /escapes its output directory/);
});

test('download archives cannot write outside their extraction directory', () => {
  assert.doesNotThrow(() => assertSafeArchiveEntries(['scene.gltf', 'textures/base color.png']));
  for (const entry of ['../outside', 'models/../../outside', '/absolute', 'C:\\outside']) {
    assert.throws(() => assertSafeArchiveEntries([entry]), /escapes its extraction directory/);
  }
});

test('forced downloads preserve the previous asset until replacement succeeds', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'deadfall-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dest = path.join(dir, 'model.glb');
  await writeFile(dest, 'known-good');

  const failed = await download('https://example.invalid/model.glb', dest, {
    force: true,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(failed, false);
  assert.equal(await readFile(dest, 'utf8'), 'known-good');
  assert.ok(!(await readdir(dir)).some((name) => name.includes('.part-')));

  const replaced = await download('https://example.invalid/model.glb', dest, {
    force: true,
    fetchImpl: async () => new Response('replacement'),
  });
  assert.equal(replaced, true);
  assert.equal(await readFile(dest, 'utf8'), 'replacement');
});

test('OpenGameArt slots copy only their selected models and shared sidecars', () => {
  const archive = ['Pistol.obj', 'Rifle.obj', 'Walk.fbx', 'Body.png', 'pack.mtl', 'preview.blend'];
  assert.deepEqual(selectOgaFiles({ pick: 'OBJ/Pistol.obj' }, archive),
    ['Pistol.obj', 'Body.png', 'pack.mtl']);
  assert.deepEqual(selectOgaFiles({ pick: 'Pistol.obj', clips: ['Walk.fbx'] }, archive),
    ['Pistol.obj', 'Walk.fbx', 'Body.png', 'pack.mtl']);
  assert.deepEqual(selectOgaFiles({ pick: 'Pistol.obj', includeModels: true }, archive),
    ['Pistol.obj', 'Rifle.obj', 'Walk.fbx', 'Body.png', 'pack.mtl']);
});

test('attributions name the title, author, source and licence of every CC-BY asset', () => {
  const md = renderAttributions([
    { section: 'weapons', title: 'AK-47S', author: 'Someone', license: 'CC-BY',
      page: 'https://sketchfab.com/3d-models/x', modified: 'scaled and re-materialled' },
    { section: 'props', title: 'Barrel 01', author: 'Poly Haven', license: 'CC0',
      page: 'https://polyhaven.com/a/Barrel_01' },
  ]);
  for (const needed of ['AK-47S', 'Someone', 'https://sketchfab.com/3d-models/x',
                        'CC BY 4.0', 'creativecommons.org/licenses/by/4.0/',
                        'scaled and re-materialled']) {
    assert.ok(md.includes(needed), `attributions omit ${needed}`);
  }
  // CC0 is credited too, but under its own heading, so a reader can tell which
  // rows are an obligation and which are a courtesy.
  assert.match(md, /CC BY 4\.0 — attribution required[\s\S]*CC0 — public domain/);
});

// ------------------------------------------------- what the fetcher wrote out

test('the installed credits match the manifest', (t) => {
  // Skipped on a fresh clone: the art is fetched, not committed.
  if (!existsSync(path.join(ROOT, 'assets/CREDITS.json'))) {
    return t.skip('no art installed -- run tools/fetch-assets.mjs');
  }
  const rows = JSON.parse(read('assets/CREDITS.json'));
  const titles = new Map();
  for (const section of SECTIONS) {
    for (const e of manifest[section]) titles.set(e.title, e);
  }
  for (const row of rows) {
    assert.ok(row.author, `${row.title}: credited without an author`);
    assert.ok(['CC0', 'CC-BY'].includes(row.license), `${row.title}: licence ${row.license}`);
    assert.match(row.page ?? '', /^https:\/\//, `${row.title}: no source URL`);
    assert.ok(row.path, `${row.title}: no path`);
    if (row.license === 'CC-BY') {
      assert.ok(row.modified, `${row.title}: CC-BY row must state whether it was modified`);
    }
  }
});

test('a weapon slot answered twice is ordered, account-gated first', () => {
  // Manifest order is preference order and weaponmodels.js takes the first
  // *installed* entry, so an openly downloadable gun must never sit above the
  // one it stands in for -- otherwise adding a token would change nothing.
  const bySlot = new Map();
  for (const [i, e] of manifest.weapons.entries()) {
    if (!bySlot.has(e.weapon)) bySlot.set(e.weapon, []);
    bySlot.get(e.weapon).push({ i, source: e.source, title: e.title });
  }
  for (const [slot, entries] of bySlot) {
    if (entries.length < 2) continue;
    const gated = entries.filter((e) => e.source === 'sketchfab');
    const open = entries.filter((e) => e.source !== 'sketchfab');
    if (!gated.length || !open.length) continue;
    assert.ok(Math.max(...gated.map((e) => e.i)) < Math.min(...open.map((e) => e.i)),
      `${slot}: an openly downloadable model sits above an account-gated one`);
  }
});

test('every weapon slot is answered by something installable without an account', () => {
  // The point of the OpenGameArt half: the game should not need anybody's
  // credentials to have guns. Four slots are deliberately exempt -- the two
  // energy weapons, whose coloured emitters are how the player tells them apart,
  // the paired portal projector, and the golf club, which nobody has modelled for free.
  const EXEMPT = new Set(['laser', 'railgun', 'portalgun', 'golfclub']);
  const src = read('src/render/viewmodel.js');
  const block = src.match(/export const BUILDERS = \{([\s\S]*?)\};/)[1];
  const ids = [...block.matchAll(/(\w+):\s*build\w+/g)].map((m) => m[1]);
  const open = new Set(manifest.weapons.filter((e) => e.source !== 'sketchfab').map((e) => e.weapon));
  for (const id of ids) {
    if (EXEMPT.has(id)) continue;
    assert.ok(open.has(id), `weapon slot "${id}" needs an account to have a model`);
  }
});

test('no render module references a constant it never declares', () => {
  // This exists because a rename shipped to production and the suite stayed
  // green. `CLIP_WALK_SPEED` was replaced by `CLIP_SPEED`, one reference was
  // missed, and it sat in buildCharacterMesh -- a function no node test can
  // reach, because importing it pulls in three.js and three.js wants a browser.
  // The result threw on every enemy spawn, which is to say the game locked up
  // the instant a wave started, while `npm test` reported 263 passes.
  //
  // A real linter would be the better answer. Until there is one, this is the
  // cheap version that catches the same mistake: SCREAMING_CASE identifiers are
  // module constants by this codebase's convention, so any that are used and
  // never declared or imported are a reference to something that is not there.
  const files = [
    'src/render/charactermodels.js', 'src/render/weaponmodels.js',
    'src/render/photosets.js', 'src/render/models.js',
    'src/render/environment.js', 'src/render/loadmodel.js',
  ];
  // Things that are legitimately capitalised and come from elsewhere.
  const AMBIENT = new Set(['NaN', 'Infinity', 'JSON', 'Math', 'Promise', 'Map', 'Set',
    'Array', 'Object', 'Number', 'String', 'Boolean', 'Error', 'URL', 'OffscreenCanvas']);

  for (const file of files) {
    const src = read(file);
    const declared = new Set([
      ...[...src.matchAll(/(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]),
      ...[...src.matchAll(/import\s*\{([^}]*)\}/g)]
        .flatMap((m) => m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop())),
      ...[...src.matchAll(/import\s+\*\s+as\s+(\w+)/g)].map((m) => m[1]),
    ].filter(Boolean));

    // Strip comments and strings so prose and messages are not scanned.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');

    for (const m of code.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      const name = m[1];
      if (declared.has(name) || AMBIENT.has(name)) continue;
      // Property access (THREE.SRGBColorSpace, obj.SOME_KEY) is not a reference
      // to a module constant.
      const before = code.slice(Math.max(0, m.index - 1), m.index);
      if (before === '.') continue;
      // An object key, not a reference: `ROLE_HEX = { METAL: 0x6a7078 }` and
      // `case METAL:` look identical to a regex, and only one of them is a read.
      const after = code.slice(m.index + name.length).match(/^\s*(.)/);
      if (after && after[1] === ':') continue;
      assert.fail(`${file} uses "${name}" but never declares or imports it`);
    }
  }
});
