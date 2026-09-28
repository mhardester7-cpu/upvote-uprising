#!/usr/bin/env node

// Add a compact armature to Micket's CC0 gorilla conversion.
//
// The source mesh is built from clean, disconnected low-poly limb shells, so
// connected-component bounds give deterministic shoulder/arm/hand weights.
// Keeping this conversion scripted makes the shipped GLB reproducible without
// requiring Blender or an account-gated auto-rigging service.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = path.resolve(ROOT, process.argv[2] ?? 'assets/creatures/gorilla/gorilla.glb');
const outputPath = path.resolve(ROOT, process.argv[3] ?? 'assets/creatures/gorilla/gorilla-rigged.glb');

function parseGlb(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2) {
    throw new Error('input is not a GLB 2.0 file');
  }
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  const binHeader = 20 + jsonLength;
  const binLength = bytes.readUInt32LE(binHeader);
  return { json, bin: bytes.subarray(binHeader + 8, binHeader + 8 + binLength) };
}

function accessorArray(json, bin, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  const view = json.bufferViews[accessor.bufferView];
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const length = accessor.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type]);
  if (accessor.componentType === 5126) {
    return new Float32Array(bin.buffer, bin.byteOffset + byteOffset, length);
  }
  if (accessor.componentType === 5125) {
    return new Uint32Array(bin.buffer, bin.byteOffset + byteOffset, length);
  }
  if (accessor.componentType === 5123) {
    return new Uint16Array(bin.buffer, bin.byteOffset + byteOffset, length);
  }
  throw new Error(`unsupported accessor component type ${accessor.componentType}`);
}

function componentKinds(positions, indices) {
  const count = positions.length / 3;
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value]; parent[value] = root; value = next;
    }
    return root;
  };
  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  for (let i = 0; i < indices.length; i += 3) {
    union(indices[i], indices[i + 1]);
    union(indices[i], indices[i + 2]);
  }

  const bounds = new Map();
  for (let i = 0; i < count; i++) {
    const root = find(i);
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const box = bounds.get(root) ?? {
      minX: Infinity, minY: Infinity, minZ: Infinity,
      maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
      vertices: 0,
    };
    box.vertices++;
    box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
    box.minZ = Math.min(box.minZ, z); box.maxZ = Math.max(box.maxZ, z);
    bounds.set(root, box);
  }

  const kinds = new Map();
  for (const [root, box] of bounds) {
    const reach = Math.max(Math.abs(box.minX), Math.abs(box.maxX));
    // Every real anatomical shell in this deliberately low-poly source uses
    // at least 25 vertices. The handful of 6-11 vertex islands are loose caps,
    // plates and slivers; once the arms are posed they are the black scraps
    // visibly suspended between the drummer and the kit. Strip the full class
    // instead of chasing one hard-coded bound every time another sliver shows.
    if (box.vertices <= 11) {
      kinds.set(root, 'artifact');
    } else if (box.maxY < -0.8 && box.maxZ < 0.7 && reach > 0.4) {
      kinds.set(root, 'hand');
    } else if (box.maxY < -0.65 && box.maxZ > 2.5 && box.minZ > 0.35 && reach > 0.78) {
      kinds.set(root, 'arm');
    } else {
      kinds.set(root, 'body');
    }
  }
  return Array.from({ length: count }, (_, i) => kinds.get(find(i)));
}

function inverseTranslation(x, y, z) {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    -x, -y, -z, 1,
  ];
}

function pad4(bytes, fill = 0) {
  const padded = Buffer.alloc(Math.ceil(bytes.length / 4) * 4, fill);
  bytes.copy(padded);
  return padded;
}

function addBufferData(json, chunks, bytes, target) {
  const offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const padded = pad4(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const view = { buffer: 0, byteOffset: offset, byteLength: bytes.byteLength };
  if (target) view.target = target;
  json.bufferViews.push(view);
  chunks.push(padded);
  return json.bufferViews.length - 1;
}

function addAccessor(json, bufferView, componentType, count, type) {
  json.accessors.push({ bufferView, byteOffset: 0, componentType, count, type });
  return json.accessors.length - 1;
}

const source = await readFile(inputPath);
const { json, bin } = parseGlb(source);
const chunks = [pad4(Buffer.from(bin))];
const rigged = [];

for (const primitive of json.meshes[0].primitives) {
  const positions = accessorArray(json, bin, primitive.attributes.POSITION);
  const indices = accessorArray(json, bin, primitive.indices);
  const kinds = componentKinds(positions, indices);
  const count = positions.length / 3;
  const joints = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  const positive = positions.reduce((sum, _, i) => i % 3 === 0 ? sum + positions[i] : sum, 0) >= 0;
  const upper = positive ? 4 : 1;
  const fore = positive ? 5 : 2;
  const hand = positive ? 6 : 3;
  const tally = { body: 0, arm: 0, hand: 0, artifact: 0 };

  // Keep the original vertices so all other accessors remain byte-for-byte
  // compatible, but omit triangles belonging to the isolated source scraps.
  // Unindexed vertices are not submitted to the GPU and cannot float behind
  // the moving limbs.
  const cleanIndices = new indices.constructor(indices.length);
  let cleanIndexCount = 0;
  for (let i = 0; i < indices.length; i += 3) {
    if (kinds[indices[i]] === 'artifact') continue;
    cleanIndices[cleanIndexCount++] = indices[i];
    cleanIndices[cleanIndexCount++] = indices[i + 1];
    cleanIndices[cleanIndexCount++] = indices[i + 2];
  }
  if (cleanIndexCount !== indices.length) {
    const visibleIndices = cleanIndices.subarray(0, cleanIndexCount);
    const indexView = addBufferData(json, chunks, visibleIndices, 34963);
    const componentType = json.accessors[primitive.indices].componentType;
    primitive.indices = addAccessor(
      json, indexView, componentType, visibleIndices.length, 'SCALAR',
    );
  }

  for (let i = 0; i < count; i++) {
    const kind = kinds[i];
    tally[kind]++;
    if (kind === 'body' || kind === 'artifact') {
      joints[i * 4] = 0;
      weights[i * 4] = 1;
      continue;
    }
    if (kind === 'hand') {
      joints[i * 4] = hand;
      weights[i * 4] = 1;
      continue;
    }

    const z = positions[i * 3 + 2];
    const progress = Math.max(0, Math.min(1, (2.58 - z) / 2.08));
    const blend = Math.max(0, Math.min(1, (progress - 0.3) / 0.36));
    const eased = blend * blend * (3 - 2 * blend);
    joints[i * 4] = upper;
    joints[i * 4 + 1] = fore;
    weights[i * 4] = 1 - eased;
    weights[i * 4 + 1] = eased;
  }

  const jointView = addBufferData(json, chunks, joints, 34962);
  const weightView = addBufferData(json, chunks, weights, 34962);
  primitive.attributes.JOINTS_0 = addAccessor(json, jointView, 5123, count, 'VEC4');
  primitive.attributes.WEIGHTS_0 = addAccessor(json, weightView, 5126, count, 'VEC4');
  rigged.push(tally);
}

const originalNodeCount = json.nodes.length;
const rigRoot = originalNodeCount;
const leftUpper = rigRoot + 1;
const leftFore = rigRoot + 2;
const leftHand = rigRoot + 3;
const rightUpper = rigRoot + 4;
const rightFore = rigRoot + 5;
const rightHand = rigRoot + 6;
json.nodes.push(
  { name: 'GorillaRigRoot', children: [leftUpper, rightUpper] },
  { name: 'GorillaLeftUpperArm', translation: [-0.58, -0.72, 2.56], children: [leftFore] },
  { name: 'GorillaLeftForeArm', translation: [-0.12, -0.33, -1.06], children: [leftHand] },
  { name: 'GorillaLeftHand', translation: [0.03, -0.2, -1.02] },
  { name: 'GorillaRightUpperArm', translation: [0.58, -0.72, 2.56], children: [rightFore] },
  { name: 'GorillaRightForeArm', translation: [0.12, -0.33, -1.06], children: [rightHand] },
  { name: 'GorillaRightHand', translation: [-0.03, -0.2, -1.02] },
);
json.nodes[0].children.push(rigRoot);
json.nodes[1].skin = 0;

const inverseBind = new Float32Array([
  ...inverseTranslation(0, 0, 0),
  ...inverseTranslation(-0.58, -0.72, 2.56),
  ...inverseTranslation(-0.7, -1.05, 1.5),
  ...inverseTranslation(-0.67, -1.25, 0.48),
  ...inverseTranslation(0.58, -0.72, 2.56),
  ...inverseTranslation(0.7, -1.05, 1.5),
  ...inverseTranslation(0.67, -1.25, 0.48),
]);
const inverseView = addBufferData(json, chunks, inverseBind);
const inverseAccessor = addAccessor(json, inverseView, 5126, 7, 'MAT4');
json.skins = [{
  name: 'GorillaArmature',
  inverseBindMatrices: inverseAccessor,
  skeleton: rigRoot,
  joints: [rigRoot, leftUpper, leftFore, leftHand, rightUpper, rightFore, rightHand],
}];

const binary = Buffer.concat(chunks);
json.buffers[0].byteLength = binary.length;
const jsonBytes = pad4(Buffer.from(JSON.stringify(json)), 0x20);
const header = Buffer.alloc(12);
header.write('glTF', 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + binary.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonBytes.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binary.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
await writeFile(outputPath, Buffer.concat([header, jsonHeader, jsonBytes, binHeader, binary]));

console.log(`Rigged ${path.relative(ROOT, inputPath)} -> ${path.relative(ROOT, outputPath)}`);
console.log(rigged);
