import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';

import { CLOUD_DRIFT_TIME_SCALE, createSky } from '../src/render/sky.js';

test('cloud layers drift at a slow environmental pace', () => {
  assert.ok(CLOUD_DRIFT_TIME_SCALE <= 0.02,
    'cloud time is fast enough to make the sky visibly race');

  const sky = createSky(new THREE.Vector3(0.42, 0.78, 0.28).normalize());
  sky.material.uniforms.time.value = 90;
  sky.onBeforeRender({}, {}, {});
  assert.equal(sky.material.uniforms.uCloudTime.value, 90 * CLOUD_DRIFT_TIME_SCALE,
    'the sky passes unscaled game time to its cloud shader');

  sky.geometry.dispose();
  sky.material.dispose();
});
