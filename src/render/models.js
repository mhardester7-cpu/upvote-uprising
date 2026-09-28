// Loaded models.
//
// Everything else in this renderer is built out of code -- boxes, cylinders and
// canvas textures -- because a procedural prop costs nothing to ship and can be
// retuned by editing a number. That stops being the right trade the moment a
// prop has to read as a specific real object. A shipping container is a box; a
// truck is not, and the version of a truck you can write out of boxes reads as
// a box with wheels drawn on.
//
// So this is the one place that loads art off disk. It is deliberately small
// and deliberately opinionated:
//
//   The authored collider wins. A prop's box is decided by world.js, which
//   knows nothing about Three.js, and the model is SCALED TO FIT that box. Not
//   the other way round. What stops a bullet and what stops a body are the same
//   volume as before, and swapping the model for a different one cannot quietly
//   change either -- which is the property the whole prop system is built on
//   (see the note at the top of world.js).
//
//   Loading is async and the game does not wait for it. A model that fails to
//   load leaves the collider standing with nothing drawn on it, which is a map
//   with an invisible obstacle -- bad, but survivable and obvious. Blocking the
//   world build on a fetch would make a slow connection look like a hang.

import * as THREE from '../../vendor/three.module.js';
import { loadModelFile } from './loadmodel.js';
import { assetIndex } from './photosets.js';

/**
 * Where model files live.
 *
 * Resolved against this module rather than against the page. A bare relative
 * path is relative to whatever HTML is doing the importing, so the same loader
 * would look in /assets from index.html and in /tools/assets from a tool page
 * -- and the tool pages are exactly where a new model gets looked at first.
 */
const ROOT = new URL('../../assets/models/', import.meta.url).href;
const ASSETS = new URL('../../assets/', import.meta.url).href;

/**
 * Lightweight visible stand-ins for model-backed colliders.
 *
 * The authored world is playable before downloaded art finishes, so a solid
 * collider must never spend those seconds invisible. Two instanced draw calls
 * cover every barrel/crate/machine and each instance disappears only when its
 * corresponding model is actually attached.
 */
export class ModelFallbacks {
  constructor(scene, world) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'model-prop-fallbacks';
    this._instances = new Map();
    this._meshes = [];
    scene.add(this.group);

    const props = world.props.filter((p) => p.model);
    this._build(props.filter((p) => p.type === 'barrel'), true);
    this._build(props.filter((p) => p.type !== 'barrel'), false);
  }

  _build(props, barrels) {
    if (!props.length) return;
    const geometry = barrels
      ? new THREE.CylinderGeometry(0.5, 0.5, 1, 12)
      : new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({
      color: barrels ? 0x526167 : 0x5d604f,
      roughness: 0.84,
      metalness: barrels ? 0.32 : 0.08,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, props.length);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = barrels ? 'barrel-model-fallbacks' : 'crate-model-fallbacks';
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const scale = new THREE.Vector3();
    props.forEach((prop, index) => {
      position.set(prop.x, prop.y + prop.sy / 2, prop.z);
      euler.set(0, prop.rot ?? 0, 0);
      rotation.setFromEuler(euler);
      scale.set(prop.sx, prop.sy, prop.sz);
      matrix.compose(position, rotation, scale);
      mesh.setMatrixAt(index, matrix);
      this._instances.set(prop, { mesh, index, matrix: matrix.clone() });
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this._meshes.push(mesh);
  }

  hide(prop) {
    const slot = this._instances.get(prop);
    if (!slot) return;
    slot.mesh.setMatrixAt(slot.index, new THREE.Matrix4().makeScale(0, 0, 0));
    slot.mesh.instanceMatrix.needsUpdate = true;
  }

  show(prop) {
    const slot = this._instances.get(prop);
    if (!slot) return;
    slot.mesh.setMatrixAt(slot.index, slot.matrix);
    slot.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const mesh of this._meshes) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this._meshes.length = 0;
    this._instances.clear();
  }
}

export function mountModelFallbacks(scene, world) {
  return new ModelFallbacks(scene, world);
}

/**
 * Installed kit pieces, by manifest id.
 *
 * The military kit lands in assets/kit/ rather than assets/models/, and each
 * piece keeps whatever filename its author used. Rather than teach every caller
 * that, the manifest is consulted once and ids resolve to files -- so a prop in
 * src/world/ can name `kit_container01` next to `Barrel_01` and neither has to
 * know where the fetcher put it or what format it arrived in.
 */
let kitPromise = null;
function kitFiles() {
  if (!kitPromise) {
    kitPromise = (async () => {
      const [res, index] = await Promise.all([
        fetch(`${ASSETS}manifest.json`, { cache: 'no-cache' }).catch(() => null),
        assetIndex(),
      ]);
      if (!res?.ok || !index) return new Map();
      const manifest = await res.json();
      const out = new Map();
      for (const entry of manifest.kit || []) {
        if (entry.source !== 'oga' || !entry.id) continue;
        const file = `assets/kit/${entry.id}/${entry.pick.split('/').pop()}`;
        if (index.has(file)) out.set(entry.id, new URL(`../../${file}`, import.meta.url).href);
      }
      return out;
    })().catch(() => new Map());
  }
  return kitPromise;
}

/** name -> Promise<THREE.Object3D>, so two props sharing a model load it once. */
const cache = new Map();

/**
 * Load a model by name, once.
 *
 * Two layouts are accepted, because two things put models here. A hand-placed
 * model is a single self-contained `<name>.glb`. A model installed by
 * tools/fetch-assets.mjs is a `<name>/scene.gltf` beside the loose texture files
 * it references, which is the shape Poly Haven publishes and there is nothing to
 * gain from repacking it -- GLTFLoader resolves the siblings itself.
 *
 * The bundled form is tried second on purpose: a fetched model is the upgrade,
 * so if both exist the downloaded one wins.
 *
 * The promise is cached rather than the result, so simultaneous callers during
 * the same world build share a single request instead of racing to start four.
 */
export function loadModel(name) {
  if (!cache.has(name)) {
    cache.set(name, (async () => {
      const [kit, index] = await Promise.all([kitFiles(), assetIndex()]);
      const fetchedPath = `assets/models/${name}/scene.gltf`;
      const bundledPath = `assets/models/${name}.glb`;
      const candidates = [
        ...(kit.has(name) ? [kit.get(name)] : []),
        ...(!index || index.has(fetchedPath) ? [`${ROOT}${name}/scene.gltf`] : []),
        ...(!index || index.has(bundledPath) ? [`${ROOT}${name}.glb`] : []),
      ];
      let lastErr;
      for (const url of candidates) {
        try {
          return (await loadModelFile(url)).scene;
        } catch (err) { lastErr = err; }
      }
      throw lastErr ?? new Error(`no model named "${name}"`);
    })());
  }
  return cache.get(name);
}

/**
 * Scale and centre a model to fill an authored box.
 *
 * Fits on the largest axis rather than stretching each one independently: a
 * truck squashed to fit a box that is not quite its proportions reads as a
 * broken truck, whereas one that is slightly smaller than its collider just
 * reads as a truck. The collider is the contract; the art fits inside it.
 *
 * The model is dropped so its underside sits on the box floor, because a prop's
 * `y` is the ground it stands on everywhere else in this codebase.
 */
export function fitToBox(model, prop) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  if (!(size.x > 0 && size.y > 0 && size.z > 0)) return model;

  // The box is authored in world axes but the model is measured in its own, and
  // the holder is turned between the two. On a quarter turn those axes swap, so
  // fitting the world box directly solves length against width -- which silently
  // shrinks the model to whichever is tighter instead of failing visibly.
  const rot = prop.rot ?? 0;
  const quarter = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 1;
  const want = quarter
    ? { x: prop.sz, y: prop.sy, z: prop.sx }
    : { x: prop.sx, y: prop.sy, z: prop.sz };
  const k = Math.min(want.x / size.x, want.y / size.y, want.z / size.z);

  const holder = new THREE.Group();
  model.position.set(-centre.x, -box.min.y, -centre.z);
  holder.add(model);
  holder.scale.setScalar(k);
  holder.position.set(prop.x, prop.y, prop.z);
  holder.rotation.y = prop.rot ?? 0;
  return holder;
}

/**
 * Put every loaded-model prop in the world into the scene.
 *
 * Returns a promise for the meshes added, but the caller is free to ignore it:
 * nothing else in the frame depends on these arriving.
 */
export async function mountModels(scene, world, {
  isCurrent = () => true, onMounted = () => {}, onDiscarded = () => {},
} = {}) {
  const props = world.props.filter((p) => p.model);
  const added = [];
  const mountedProps = [];
  const cancel = () => {
    disposeModels(scene, added);
    for (const prop of mountedProps) onDiscarded(prop);
    return [];
  };

  // Decode serially. Promise.all used to launch every installed glTF and its
  // textures together; Firefox/WebKit then queued enough main-thread decode
  // work to make a successfully clicked Solo/Host button appear frozen.
  // Cached duplicates still resolve immediately, while distinct art batches
  // yield a task so input and rendering stay responsive between models.
  for (const p of props) {
    if (!isCurrent()) {
      return cancel();
    }
    let source;
    try {
      source = await loadModel(p.model);
    } catch (err) {
      // Deliberately not fatal. See the note at the top of the file.
      console.warn(`[models] could not load "${p.model}":`, err?.message ?? err);
      continue;
    }
    if (!isCurrent()) {
      return cancel();
    }
    const obj = fitToBox(source.clone(true), p);
    obj.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
    });
    scene.add(obj);
    added.push(obj);
    mountedProps.push(p);
    onMounted(p, obj);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return added;
}

/** Drop everything mountModels added. Geometry is shared, so only the tree goes. */
export function disposeModels(scene, added) {
  for (const obj of added ?? []) scene.remove(obj);
}
