// Load a model in whatever format its author published.
//
// glTF is the format this project prefers, and for a long time the only one it
// spoke. That was fine while the only loaded art was a truck. It stopped being
// fine the moment the art had to come from wherever it could be downloaded
// without an account: free guns and free characters are overwhelmingly FBX and
// OBJ, because those are what a hobbyist exports from Blender without thinking
// about it. Refusing them would have meant refusing almost everything.
//
// So the extension decides, and the three loaders are vendored side by side.
// Everything that loads art off disk comes through here -- props, weapons and
// characters -- so a format added here is a format all three can use.

import { GLTFLoader } from '../../vendor/loaders/GLTFLoader.js';
import { OBJLoader } from '../../vendor/loaders/OBJLoader.js';
import { MTLLoader } from '../../vendor/loaders/MTLLoader.js';
import { FBXLoader } from '../../vendor/loaders/FBXLoader.js';

/**
 * @param url absolute or module-relative URL ending in .gltf/.glb/.obj/.fbx
 * @returns {Promise<{scene: THREE.Object3D, animations: THREE.AnimationClip[]}>}
 *   Shaped like a glTF result whatever the source, so callers do not branch.
 *   FBX carries its clips on the object itself; OBJ has none.
 */
export async function loadModelFile(url) {
  const ext = url.split('?')[0].split('.').pop().toLowerCase();

  if (ext === 'gltf' || ext === 'glb') {
    const gltf = await new GLTFLoader().loadAsync(url);
    return { scene: gltf.scene, animations: gltf.animations ?? [] };
  }

  if (ext === 'fbx') {
    const group = await new FBXLoader().loadAsync(url);
    return { scene: group, animations: group.animations ?? [] };
  }

  if (ext === 'obj') {
    const loader = new OBJLoader();
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    try {
      const materials = await new MTLLoader().setPath(base)
        .loadAsync(url.slice(base.length).replace(/\.obj$/i, '.mtl'));
      materials.preload();
      loader.setMaterials(materials);
    } catch {
      // No .mtl, or one naming textures that were not shipped. The geometry is
      // still worth having: callers assign their own materials anyway, and an
      // untextured model is a paintable model.
    }
    return { scene: await loader.loadAsync(url), animations: [] };
  }

  throw new Error(`unsupported model format ".${ext}"`);
}
