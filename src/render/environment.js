// Environment light from a photographed sky.
//
// The world's reflections came from studioenv.js: a gradient painted into a
// cube and run through PMREM. That was the right call while nothing on screen
// was trying to be a real material -- it gave metal something to reflect and
// stopped the lockers rendering as black slabs. But a studio gradient reflects
// like a studio: evenly, from nowhere in particular, with no horizon and no sun.
// A photographed HDRI has a bright sky, a dark ground, and a sun with a
// direction, which is most of what makes a steel drum look like steel.
//
// This does not replace the sky dome. sky.js still draws what the player sees;
// the HDRI is only what surfaces reflect and pick ambient light up from. Keeping
// them separate means the atmosphere stays art-directed and tunable while the
// lighting gets its realism from a measurement.
//
// A missing HDRI is not an error. The studio environment is still there, still
// correct, and the game runs identically without the art pack installed.

import * as THREE from '../../vendor/three.module.js';
import { RGBELoader } from '../../vendor/loaders/RGBELoader.js';
import { studioEnvironment } from './studioenv.js';

const ROOT = new URL('../../assets/env/', import.meta.url).href;

/**
 * Available skies, by mood, matching what the manifest installs.
 *
 * All four are the same arid location or its neighbours at different times, on
 * purpose: an environment swap that also changes the *place* fights the terrain
 * art, whereas one that only changes the hour composes with it. This is what a
 * night wave would switch to, without retuning a single material.
 */
export const SKIES = {
  overcast: 'rogland_overcast',
  golden: 'aarfontein_dirt_road',
  dusk: 'rogland_sunset',
  night: 'rogland_moonlit_night',
};

const cache = new Map();

/**
 * Load an HDRI and prefilter it for image-based lighting.
 *
 * PMREM needs a live renderer, and the result is a render target rather than a
 * plain texture, so this is called during setup rather than at construction.
 * Cached per mood: switching back to a sky already used costs nothing.
 *
 * @returns {Promise<THREE.Texture|null>} null when the file is not installed
 */
export function loadSkyEnvironment(renderer, mood = 'overcast') {
  const slug = SKIES[mood] || SKIES.overcast;
  if (cache.has(slug)) return cache.get(slug);

  const promise = new Promise((resolve) => {
    new RGBELoader().load(`${ROOT}${slug}.hdr`, (hdr) => {
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const env = pmrem.fromEquirectangular(hdr).texture;
      // The equirect source has done its job once prefiltered; only the cube
      // render target is sampled from here on.
      hdr.dispose();
      pmrem.dispose();
      resolve(env);
    }, undefined, () => resolve(null));
  });

  cache.set(slug, promise);
  return promise;
}

/**
 * Point a scene's reflections at the sky, falling back to the studio.
 *
 * Returns which one it used, so the caller can log honestly rather than
 * claiming a photographed environment it did not get.
 *
 * @param intensity tuned independently from the studio fallback. An HDRI
 *   carries real-world dynamic range, so the same number is not the same
 *   brightness as the generated gradient.
 */
export async function applySkyEnvironment(scene, renderer, mood = 'overcast', intensity = 1.0) {
  const env = await loadSkyEnvironment(renderer, mood);
  if (!env) {
    scene.environment = studioEnvironment(renderer);
    scene.environmentIntensity = 0.78;
    return 'studio';
  }
  scene.environment = env;
  scene.environmentIntensity = intensity;
  return mood;
}

/** Free every prefiltered cube map. Called on teardown. */
export function disposeEnvironments() {
  for (const p of cache.values()) Promise.resolve(p).then((t) => t?.dispose?.());
  cache.clear();
}
