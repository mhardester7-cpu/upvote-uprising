import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as THREE from '../vendor/three.module.js';
import { ModelFallbacks } from '../src/render/models.js';

const near = (actual, expected) => Math.abs(actual - expected) < 1e-5;

test('model-backed colliders stay visible until their real art is mounted', () => {
  const barrel = {
    type: 'barrel', model: 'barrel', x: 2, y: 3, z: 4,
    sx: 0.6, sy: 0.9, sz: 0.6, rot: 0.3,
  };
  const crate = {
    type: 'crate', model: 'crate', x: -2, y: 1, z: 5,
    sx: 1.2, sy: 1.1, sz: 0.8, rot: -0.4,
  };
  const scene = new THREE.Scene();
  const fallbacks = new ModelFallbacks(scene, { props: [barrel, crate] });

  assert.ok(scene.getObjectByName('barrel-model-fallbacks'));
  assert.ok(scene.getObjectByName('crate-model-fallbacks'));

  const slot = fallbacks._instances.get(crate);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  slot.mesh.getMatrixAt(slot.index, matrix);
  matrix.decompose(position, rotation, scale);
  assert.ok(scale.toArray().every((value, index) => near(value, [crate.sx, crate.sy, crate.sz][index])));
  assert.ok(near(position.y, crate.y + crate.sy / 2));

  fallbacks.hide(crate);
  slot.mesh.getMatrixAt(slot.index, matrix);
  matrix.decompose(position, rotation, scale);
  assert.deepEqual(scale.toArray(), [0, 0, 0]);

  fallbacks.show(crate);
  slot.mesh.getMatrixAt(slot.index, matrix);
  matrix.decompose(position, rotation, scale);
  assert.ok(scale.toArray().every((value, index) => near(value, [crate.sx, crate.sy, crate.sz][index])));

  fallbacks.dispose();
  assert.equal(scene.getObjectByName('model-prop-fallbacks'), undefined);
});
