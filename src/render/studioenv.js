// A tiny environment map, so metal looks like metal.
//
// A physically-based material with `metalness: 1` has no diffuse response at
// all -- every photon it shows you is a reflection. With nothing in the scene
// to reflect, the correct render of a polished gold receiver is black, which is
// exactly what the armoury's legendary skins turned into. Direct lights only
// contribute a specular pinprick; the broad soft gradient that makes metal read
// as metal comes from the environment.
//
// So this bakes one: a gradient sky over a warm floor, with a bright overhead
// panel standing in for a softbox. It is 64px wide before PMREM convolves it --
// an environment map's whole job here is low-frequency, and anything sharper
// would only cost memory.

import * as THREE from '../../vendor/three.module.js';

let cached = null;

/**
 * Build (once) an equirectangular studio environment, PMREM-filtered so it can
 * drive roughness properly.
 *
 * @param renderer the WebGLRenderer that will use it -- PMREM runs on the GPU
 * @returns a Texture for `scene.environment`, or null without a DOM
 */
export function studioEnvironment(renderer) {
  if (cached) return cached;
  if (typeof document === 'undefined' || !renderer) return null;

  const W = 128, H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Vertical gradient: cool sky, warm bounce off the ground.
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0.00, '#9fc6ff');
  sky.addColorStop(0.42, '#dfe9f5');
  sky.addColorStop(0.52, '#b9ac97');
  sky.addColorStop(1.00, '#4a4238');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // Key softbox, high and to the left, matching the viewmodel's key light so a
  // highlight lands where the direct lighting says it should.
  const key = ctx.createRadialGradient(W * 0.30, H * 0.20, 1, W * 0.30, H * 0.20, W * 0.22);
  key.addColorStop(0, '#ffffff');
  key.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, W, H);

  // A dimmer, cooler panel opposite, so the unlit side is not dead flat.
  const fill = ctx.createRadialGradient(W * 0.78, H * 0.34, 1, W * 0.78, H * 0.34, W * 0.20);
  fill.addColorStop(0, 'rgba(190,215,255,0.85)');
  fill.addColorStop(1, 'rgba(190,215,255,0)');
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, W, H);

  const equirect = new THREE.CanvasTexture(canvas);
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  equirect.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromEquirectangular(equirect);

  equirect.dispose();
  pmrem.dispose();

  cached = target.texture;
  return cached;
}

export function disposeStudioEnvironment() {
  cached?.dispose();
  cached = null;
}
