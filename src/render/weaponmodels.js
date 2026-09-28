// Photographed weapons in place of the built ones.
//
// viewmodel.js writes fifteen guns out of bevelled boxes and cylinders, and
// they are good -- but a box-built AK reads as an approximation of an AK, and
// this is the object the player looks at for the entire game. So a downloaded
// model wins when there is one. What makes that swap safe rather than a rewrite
// is that the procedural gun stays the *contract*, in three specific ways:
//
//   SIZE. The built model is measured, and the download is scaled to match its
//   length. Every REST pose, every ADS depth and the whole MODEL_SCALE tuning
//   in viewmodel.js was authored against those dimensions, so matching them
//   means none of it has to move. A model that arrives 40x too big -- the
//   normal case, since half of Sketchfab is authored in centimetres -- lands
//   the right size without anybody typing a number.
//
//   ANCHORS. A built gun publishes `userData.muzzle` (where flash, light and
//   tracers originate) and `userData.sight` + `adsZ` (where the eye goes when
//   aiming). A downloaded mesh has neither, so they are derived from its
//   bounding box: muzzle at the front face on the barrel axis, sight on the top
//   face just behind it. Derived anchors are approximately right immediately,
//   and ALIGN below overrides them once someone has looked through the sights.
//
//   SURFACES. Skins work by reading `userData.baseHex` and
//   `userData.baseRole` off each material -- the palette slot a part was built
//   from. An imported material has no such history, so roles are inferred from
//   material names and the same two fields are written. Get this wrong and a
//   cosmetic repaint silently stops working on the gun.
//
// Everything degrades: no manifest, no file, a failed parse or a mesh with no
// geometry all leave the built gun in the player's hands.

import * as THREE from '../../vendor/three.module.js';
import { loadModelFile } from './loadmodel.js';
import { assetIndex } from './photosets.js';

const ROOT = new URL('../../assets/', import.meta.url).href;
// These slots are complete code-authored assets whose silhouette is part of
// their identity. Keep downloaded models available to the QA tooling, but do
// not replace the authored asset in the live viewmodel.
export const PREFERRED_PROCEDURAL_WEAPONS = new Set(['sniper']);
const REAL_SCOPE_FILE = 'assets/weapons/optic_vss_pso/Soviet_Special_Sniper_Rifle.fbx';
const REAL_SCOPE_CREDIT = {
  title: 'Soviet Special Sniper Rifle — PSO optic',
  author: 'GGBotNet', license: 'CC0',
  page: 'https://opengameart.org/content/vss-vintorez-3d',
};

/**
 * Maps shipped beside the open-download weapons but omitted by their FBX/MTL.
 *
 * Several source files only point at an albedo map (and the M9 points at a
 * non-existent `Textures/` directory), even though the archive contains a full
 * PBR set. Loading those files explicitly keeps the finish consistent with
 * the MeshStandard materials used by the rest of the armoury.
 */
const PBR_SETS = {
  deagle_revolver: [{
    normalMap: 'Revolver_NRM.png', metalnessMap: 'Revolver_SPEC.png',
    roughness: 0.32, metalness: 0.62,
  }],
  sniper_enfield: [{
    normalMap: 'FP Hunting Rifle NRM.png', metalnessMap: 'FP Hunting Rifle SPEC.png',
    roughness: 0.48, metalness: 0.42,
  }],
  flamethrower_lp: [{
    map: 'Flamethrower.png', normalMap: 'Flamethrower NRM.png',
    aoMap: 'Flamethrower AO.png', metalnessMap: 'Flamethrower MET.png',
    roughness: 0.52, metalness: 0.62,
  }],
  pickaxe_fireaxe: [{
    map: 'Fire Axe BaseColor.png', normalMap: 'Fire Axe Normal.png',
    aoMap: 'Fire Axe Ambient Occlusion.png', metalnessMap: 'Fire Axe Metallic.png',
    roughnessMap: 'Fire Axe Roughness.png', roughness: 1, metalness: 1,
  }],
  knife_m9: [
    {
      match: /handle/i,
      map: 'Handle_albedo.png', normalMap: 'Handle_nm.png',
      aoMap: 'Handle_ao.png', metalnessMap: 'Handle_metallic.png',
      roughnessMap: 'Handle_roughness.png', roughness: 1, metalness: 1,
    },
    {
      match: /knife|blade/i,
      map: 'Knife_albedo.png', normalMap: 'Knife_nm.png',
      aoMap: 'Knife_ao.png', metalnessMap: 'Knife_metallic.png',
      roughnessMap: 'Knife_roughness.png', roughness: 1, metalness: 1,
    },
  ],
};

const TEXTURE_CACHE = new Map();

/**
 * Per-weapon corrections, on top of what the bounding box implies.
 *
 * Empty is a valid state and the honest starting point: nothing here can be
 * authored without looking at the model in `tools/aligner.html`, which prints
 * the block to paste back. Auto-derivation handles scale and the barrel axis;
 * these are for what it cannot know.
 *
 *   yaw/pitch/roll  radians, applied after the barrel axis is squared up
 *   flip            true when the auto-detected barrel axis points backwards
 *   scale           multiplier on the fitted scale, for guns that should not be
 *                   exactly as long as the box-built one (a minigun reads
 *                   bigger; a knife reads smaller)
 *   muzzle/sight    explicit anchors in model space, overriding the box
 *   adsZ            how far the gun pulls toward the camera when aiming
 */
export const ALIGN = {
  // Which end of a gun is the muzzle is not something the geometry will tell
  // you. Three automatic tests were tried and all three failed: the anchor is
  // derived from the bounding box so it always agrees with the model (a flipped
  // gun has a flipped marker, and the pair looks identical); mass at each end
  // says nothing consistent, because the built guns themselves range from
  // front-heavy to back-heavy; and slice-profile correlation against the built
  // model is noise for every weapon whose download is a different shape, which
  // is most of them.
  //
  // So this table is authored by eye, against the one thing that is correct by
  // definition: the built gun. tools/weaponsheet.html draws it in wireframe
  // around each download, and the built model's forearm runs back toward the
  // player -- so its muzzle is the far end, and any loaded barrel pointing the
  // other way is flipped.
  // Source axes and zero-valued corrections are intentional calibration data,
  // not noise. They make each accepted asset independent of future changes to
  // its overall bounding box (an RPG sling or optic must not become its new
  // "barrel") and give tests one explicit orientation contract per weapon.
  pistol:      { axis: 'z', flip: true,  yaw: 0, pitch: 0, roll: 0 },
  deagle:      { axis: 'x', flip: false, yaw: 0, pitch: 0, roll: 0 },
  rifle:       { axis: 'z', flip: true,  yaw: 0, pitch: 0, roll: 0 },
  smg:         { axis: 'z', flip: true,  yaw: 0, pitch: 0, roll: 0 },
  microsmg:    { axis: 'z', flip: false, yaw: 0, pitch: 0, roll: 0 },
  // Zsky's stock is at -X and muzzle at +X. Squaring +X onto viewmodel -Z is
  // already correct; the previous flip put the butt toward the target.
  shotgun:     { axis: 'x', flip: false, yaw: 0, pitch: 0, roll: 0 },
  sniper:      { axis: 'x', flip: true,  yaw: 0, pitch: 0, roll: 0 },
  // The installed RPG-7 is authored along +X, upright on +Y, with its warhead
  // already leading after +X is squared onto viewmodel -Z. Making all five
  // values explicit is what prevents the launcher from regressing to the
  // geometry heuristic that previously left it at a visibly wrong angle.
  bazooka:     { axis: 'x', flip: false, yaw: 0, pitch: 0, roll: 0 },
  // Harrison1's barrel cluster is at source -Z. The previous flip put that end
  // at viewmodel +Z, leaving the rear housing aimed at the target.
  minigun:     { axis: 'z', flip: false, yaw: 0, pitch: 0, roll: 0, scale: 1.15 },
  flamethrower:{ axis: 'x', flip: false, yaw: 0, pitch: 0, roll: 0 },

  // Melee weapons are held, not aimed: no muzzle, and the blade or head leads.
  // No flip. The M9's blade already leads once the barrel axis is squared up,
  // and the flip added here earlier put the handle out front -- which is the
  // one orientation error a melee weapon cannot hide, because the swing arc
  // points it straight at the camera.
  knife:    { axis: 'x', flip: false, yaw: 0, pitch: 0, roll: 0,
    scale: 0.9, noMuzzle: true },
  // The fire axe is authored up its Y axis with the head at +Y. Square-up turns
  // that axis by +PI/2, so the pitch below reverses that turn and adds the
  // pickaxe contract's 0.95-radian upward rake: head forward and above the hand.
  // Rolling it half a turn puts the axe's cutting edge on the same leading side
  // as the built pick point; without that correction the back of the head led
  // the diagonal strike.
  pickaxe:  { axis: 'y', flip: false, yaw: 0,
    pitch: -(Math.PI / 2 + 0.95), roll: Math.PI, scale: 1.0, noMuzzle: true },
  golfclub: { scale: 1.0, noMuzzle: true },
};

/** Material-name keyword -> palette role, first match wins. */
const ROLE_RULES = [
  // Aiming hardware first, because these are also "metal" and the rule that
  // matters most is the one that keeps pattern off a sight picture. DARK maps
  // to the GRIP surface, which cosmetic skins never wrap.
  [/scope|optic|sight|reticle|lens|glass|rail|picatinny/i, 'DARK'],
  [/grip|polymer|rubber|handle|stock|pad|strap|sling|cord|leather/i, 'DARK'],
  [/wood|walnut|birch|furniture/i, 'WOOD'],
  [/mag(azine)?|brass|cartridge|bullet|ammo|shell|round/i, 'ACCENT'],
  [/blade|edge|knife|cutting/i, 'STEEL'],
  [/gold|brass_plate/i, 'GOLD'],
  [/barrel|receiver|body|frame|slide|bolt|metal|steel|iron|gun/i, 'METAL'],
];

/** Fallback palette hexes per role, so skins have something to remap from. */
const ROLE_HEX = {
  METAL: 0x6a7078, STEEL: 0x9aa3ab, DARK: 0x24272b,
  WOOD: 0x6b4a2b, ACCENT: 0xb8892f, GOLD: 0xc9a227,
};

let manifestPromise = null;

/**
 * Triangle islands in one imported mesh, joined by coincident vertices.
 *
 * FBX commonly stores an entire weapon in one Mesh even when the author left a
 * loose cartridge beside it. Object-name filtering cannot remove that defect:
 * gun and cartridge have the same name and material. Joining triangles by
 * quantised position works across UV/normal seams and lets the loader identify
 * the actual detached piece instead of hiding every mesh with an ammo-ish name.
 */
export function geometryParts(geometry) {
  const position = geometry?.attributes?.position;
  if (!position) return [];
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const triangles = Math.floor(count / 3);
  if (!triangles) return [];

  const parent = new Int32Array(triangles);
  for (let i = 0; i < triangles; i++) parent[i] = i;
  const find = (n) => {
    let root = n;
    while (parent[root] !== root) root = parent[root];
    while (parent[n] !== n) { const next = parent[n]; parent[n] = root; n = next; }
    return root;
  };
  const join = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  const at = (offset) => index ? index.getX(offset) : offset;
  const key = (vertex) => `${Math.round(position.getX(vertex) * 1e5)},`
    + `${Math.round(position.getY(vertex) * 1e5)},${Math.round(position.getZ(vertex) * 1e5)}`;
  const owner = new Map();
  for (let tri = 0; tri < triangles; tri++) {
    for (let corner = 0; corner < 3; corner++) {
      const k = key(at(tri * 3 + corner));
      const previous = owner.get(k);
      if (previous === undefined) owner.set(k, tri);
      else join(tri, previous);
    }
  }

  const parts = new Map();
  for (let tri = 0; tri < triangles; tri++) {
    const root = find(tri);
    let part = parts.get(root);
    if (!part) {
      part = { triangles: [], vertices: new Set(), min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity] };
      parts.set(root, part);
    }
    part.triangles.push(tri);
    for (let corner = 0; corner < 3; corner++) {
      const vertex = at(tri * 3 + corner);
      part.vertices.add(vertex);
      const values = [position.getX(vertex), position.getY(vertex), position.getZ(vertex)];
      for (let axis = 0; axis < 3; axis++) {
        part.min[axis] = Math.min(part.min[axis], values[axis]);
        part.max[axis] = Math.max(part.max[axis], values[axis]);
      }
    }
  }
  return [...parts.values()].map((part) => {
    const size = part.max.map((n, axis) => n - part.min[axis]);
    return { ...part, triangleCount: part.triangles.length, vertexCount: part.vertices.size,
      size, center: part.min.map((n, axis) => (n + part.max[axis]) / 2) };
  }).sort((a, b) => b.triangleCount - a.triangleCount);
}

/** Clone a geometry while retaining only the requested source triangles. */
function geometrySubset(geometry, triangles) {
  const subset = geometry.clone();
  const original = geometry.index;
  const at = (offset) => original ? original.getX(offset) : offset;
  const groups = geometry.groups || [];
  const materialAt = (offset) => groups.find((g) =>
    offset >= g.start && offset < g.start + g.count)?.materialIndex ?? 0;
  const indices = [];
  const materials = [];
  for (const tri of triangles.slice().sort((a, b) => a - b)) {
    const offset = tri * 3;
    indices.push(at(offset), at(offset + 1), at(offset + 2));
    materials.push(materialAt(offset));
  }
  subset.setIndex(indices);
  subset.clearGroups();
  let start = 0;
  while (start < materials.length) {
    let end = start + 1;
    while (end < materials.length && materials[end] === materials[start]) end++;
    subset.addGroup(start * 3, (end - start) * 3, materials[start]);
    start = end;
  }
  subset.computeBoundingBox();
  subset.computeBoundingSphere();
  return subset;
}

/**
 * Remove the loose display cartridge authored beside the Lee-Enfield.
 *
 * It is not a separately named FBX object: it is one 50-triangle island inside
 * `FP_Hunting_Rifle`. Match that island's source-space dimensions and centre,
 * then rebuild only this geometry's index. The bolt, sights, sling swivels and
 * every other disconnected but legitimate rifle component remain intact.
 */
export function removeLeeEnfieldDisplayRound(root) {
  const removed = [];
  root.traverse((o) => {
    // The FBX importer is allowed to sanitise or deduplicate object names. The
    // cartridge signature below is exact enough to identify the authored part
    // on its own, so making removal depend on one spelling could leave the
    // bullet visible after a loader update even though its geometry is unchanged.
    if (!o.isMesh) return;
    const parts = geometryParts(o.geometry);
    const loose = parts.find((part) => {
      const [sx, sy, sz] = part.size;
      const [cx, cy, cz] = part.center;
      return part.triangleCount === 50
        && Math.abs(sx - 0.50765) < 0.002
        && Math.abs(sy - 0.09317) < 0.002
        && Math.abs(sz - 0.07111) < 0.002
        && Math.abs(cx - 0.71593) < 0.002
        && Math.abs(cy + 0.00826) < 0.002
        && Math.abs(cz - 0.01475) < 0.002;
    });
    if (!loose) return;
    const rejected = new Set(loose.triangles);
    const triangleCount = Math.floor((o.geometry.index?.count
      ?? o.geometry.attributes.position.count) / 3);
    const keep = [];
    for (let tri = 0; tri < triangleCount; tri++) if (!rejected.has(tri)) keep.push(tri);
    o.geometry = geometrySubset(o.geometry, keep);
    removed.push({ mesh: o.name, triangleCount: loose.triangleCount,
      size: loose.size, center: loose.center });
  });
  return removed;
}

/**
 * Remove the revolver archive's detached display cylinder and cartridges.
 *
 * The source FBX includes a second cylinder assembly several model units behind
 * the weapon: one cylinder, six rounds, and a centre pin. They share the same
 * mesh and material as the real gun, so names and materials cannot distinguish
 * them. Require the complete eight-island signature before rebuilding the
 * geometry; if the upstream asset ever changes, keeping the model untouched is
 * safer than deleting something that might have become part of the weapon.
 */
function removeRevolverDisplayAmmo(root) {
  const removed = [];
  root.traverse((o) => {
    if (!o.isMesh || o.name !== 'Revolver') return;
    const loose = geometryParts(o.geometry).filter((part) => {
      const [cx, , cz] = part.center;
      return cx > -3.9 && cx < -3.2 && cz > 1.0 && cz < 1.6
        && [292, 76, 38].includes(part.triangleCount);
    });
    if (loose.length !== 8) return;

    const rejected = new Set(loose.flatMap((part) => part.triangles));
    const triangleCount = Math.floor((o.geometry.index?.count
      ?? o.geometry.attributes.position.count) / 3);
    const keep = [];
    for (let tri = 0; tri < triangleCount; tri++) if (!rejected.has(tri)) keep.push(tri);
    o.geometry = geometrySubset(o.geometry, keep);
    removed.push(...loose.map((part) => ({
      mesh: o.name, triangleCount: part.triangleCount,
      size: part.size, center: part.center,
    })));
  });
  return removed;
}

/** The actual PSO optic and mount occupy these authored VSS geometry islands. */
function isPsoScopePart(part) {
  const [, y, z] = part.center;
  return y > 1.7 && z > -5 && z < 7;
}

let scopeTemplatePromise = null;

/** Load and isolate the permissively licensed real optic once. */
async function realScopeTemplate() {
  if (!scopeTemplatePromise) scopeTemplatePromise = (async () => {
    const index = await assetIndex();
    if (!index?.has(REAL_SCOPE_FILE)) return null;
    const { scene: source } = await loadModelFile(new URL(`../../${REAL_SCOPE_FILE}`, import.meta.url).href);
    source.updateMatrixWorld(true);
    const scope = new THREE.Group();
    source.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      const selected = geometryParts(o.geometry).filter(isPsoScopePart)
        .flatMap((part) => part.triangles);
      if (!selected.length) return;
      const geometry = geometrySubset(o.geometry, selected);
      // Flatten the source hierarchy while its transforms are known. The FBX
      // carries a 100x unit conversion on a parent; dropping it would turn the
      // scope into a speck even though its own mesh dimensions look correct.
      geometry.applyMatrix4(o.matrixWorld);
      const sourceMaterials = Array.isArray(o.material) ? o.material : [o.material];
      const mesh = new THREE.Mesh(geometry, sourceMaterials.map((m) => m.clone()));
      mesh.name = 'real-pso-optic';
      scope.add(mesh);
    });
    if (!scope.children.length) return null;
    tagSurfaces(scope);
    scope.traverse((o) => {
      if (!o.isMesh) return;
      for (const material of (Array.isArray(o.material) ? o.material : [o.material])) {
        material.color.setHex(0x353b42);
        material.roughness = 0.38;
        material.metalness = 0.58;
        material.userData.baseRole = 'DARK';
        material.userData.baseHex = ROLE_HEX.DARK;
      }
    });

    // Centre the source once, then size and place independent clones per gun.
    let box = new THREE.Box3().setFromObject(scope);
    const centre = box.getCenter(new THREE.Vector3());
    for (const child of scope.children) child.position.sub(centre);
    scope.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(scope);
    const size = box.getSize(new THREE.Vector3());

    // Real glass at both ends restores the blue-green lens read the untextured
    // CC0 source lacks. These discs are visual only and explicitly non-blocking
    // to the ADS clearance audit.
    const lensMaterial = new THREE.MeshPhysicalMaterial({
      name: 'scope_glass', color: 0x76979a, roughness: 0.05, metalness: 0.05,
      transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide,
    });
    lensMaterial.userData.adsNonBlocking = true;
    lensMaterial.userData.baseRole = 'DARK';
    lensMaterial.userData.baseHex = ROLE_HEX.DARK;
    for (const [z, radius] of [[box.min.z + 0.002, 0.36], [box.max.z - 0.002, 0.29]]) {
      const lens = new THREE.Mesh(new THREE.CircleGeometry(Math.min(size.x, size.y) * radius, 28), lensMaterial);
      lens.position.z = z;
      lens.name = 'real-scope-lens';
      scope.add(lens);
    }
    scope.userData.credit = REAL_SCOPE_CREDIT;
    scope.userData.source = REAL_SCOPE_FILE;
    return scope;
  })().catch((err) => {
    console.warn(`[weaponmodels] real scope: ${err?.message ?? err}`);
    return null;
  });
  return scopeTemplatePromise;
}

/** Mount a compact rifle optic or a full-size sniper optic above the receiver. */
async function attachRealScope(outer, id, weaponBox) {
  if (id !== 'rifle' && id !== 'sniper') return null;
  const template = await realScopeTemplate();
  if (!template) return null;
  const scope = template.clone(true);
  scope.name = `real-scope:${id}`;
  const sourceBox = new THREE.Box3().setFromObject(scope);
  const sourceSize = sourceBox.getSize(new THREE.Vector3());
  const weaponSize = weaponBox.getSize(new THREE.Vector3());
  const desiredLength = weaponSize.z * (id === 'rifle' ? 0.34 : 0.46);
  const scale = desiredLength / Math.max(sourceSize.z, 1e-6);
  // The source's centimetre conversion leaves its lateral axis unusually thin
  // once flattened. Restore a believable tube/ring width without stretching
  // its optical length or mount height.
  scope.scale.set(scale * 1.65, scale, scale);
  const mountedHeight = sourceSize.y * scale;
  const centre = weaponBox.getCenter(new THREE.Vector3());
  // Front sights are usually the highest point in the whole weapon box. Using
  // box.max.y therefore left a perfectly touching scope floating above the
  // much lower receiver. Seat the mount on the receiver/rail profile instead.
  const receiverTop = centre.y + weaponSize.y * (id === 'rifle' ? 0.15 : 0.0);
  scope.position.set(centre.x, receiverTop + mountedHeight * 0.48,
    centre.z + weaponSize.z * (id === 'rifle' ? -0.015 : 0.015));
  scope.userData.realAsset = true;
  scope.userData.variant = id === 'rifle' ? 'compact-4x' : 'precision-8x';
  outer.add(scope);
  return scope;
}

/** Serializable component inventory used by the browser weapon QA sheet. */
export function sourcePartAudit(root) {
  const audit = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const part of geometryParts(o.geometry)) audit.push({
      mesh: o.name || '(unnamed)', triangleCount: part.triangleCount,
      vertexCount: part.vertexCount,
      size: part.size.map((n) => +n.toFixed(5)),
      center: part.center.map((n) => +n.toFixed(5)),
    });
  });
  return audit.sort((a, b) => b.triangleCount - a.triangleCount);
}

/**
 * Weapon id -> installed model, from assets/manifest.json.
 *
 * The manifest is the single source of truth for which download answers which
 * weapon, so the ids never get out of step with the credits. Consulted against
 * the fetch index too: a manifest entry whose files were never downloaded is
 * treated as absent, not as a broken asset.
 */
export function weaponManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      const [res, index] = await Promise.all([
        // The manifest changes whenever the art pack does, so it is read fresh
        // for the same reason CREDITS.json is -- see photosets.js.
        fetch(`${ROOT}manifest.json`, { cache: 'no-cache' }).catch(() => null),
        assetIndex(),
      ]);
      if (!res?.ok || !index) return new Map();
      const manifest = await res.json();
      const out = new Map();
      for (const entry of manifest.weapons || []) {
        if (!entry.weapon) continue;
        const file = weaponFile(entry);
        // Manifest order is preference order, and the first *installed* entry
        // wins. That is what lets two sources coexist for one slot: the
        // account-gated pick sits above the openly downloadable one, so adding a
        // token upgrades a weapon rather than duplicating it, and having no token
        // is not a downgrade from anything -- it is simply the next choice.
        if (!index.has(file) || out.has(entry.weapon)) continue;
        out.set(entry.weapon, { ...entry, file });
      }
      return out;
    })().catch(() => new Map());
  }
  return manifestPromise;
}

/** Repo-relative path to a weapon entry's model file, whatever its source. */
function weaponFile(entry) {
  if (entry.source === 'sketchfab') return `assets/weapons/${entry.uid}/scene.gltf`;
  return `assets/weapons/${entry.id}/${entry.pick.split('/').pop()}`;
}

/** Longest bounding-box axis, which on any gun is the barrel. */
function longestAxis(size) {
  if (size.x >= size.y && size.x >= size.z) return 'x';
  return size.y >= size.z ? 'y' : 'z';
}

/**
 * Rotate a model so its barrel runs down -Z, the axis viewmodel.js poses against.
 *
 * Guns are exported pointing whichever way their author worked, and the only
 * reliable signal in the file is the shape itself: the long axis is the barrel.
 * That leaves one ambiguity no geometry can settle -- which end is the muzzle --
 * hence `flip`.
 */
function squareUp(model, align) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  // Once a real asset is accepted, its authored barrel axis belongs in ALIGN.
  // Longest-axis detection remains a graceful fallback for a newly-installed
  // model, but it is not allowed to silently reinterpret a shipped RPG as its
  // sling, sight, or rocket changes the overall bounds.
  const axis = align.axis ?? longestAxis(size);
  const holder = new THREE.Group();
  if (axis === 'x') holder.rotation.y = Math.PI / 2;
  else if (axis === 'y') holder.rotation.x = Math.PI / 2;
  if (align.flip) holder.rotation.y += Math.PI;
  holder.add(model);
  holder.userData.sourceAxis = axis;
  holder.userData.rawSize = size.toArray();
  return holder;
}

/**
 * Rebuild an imported material as the kind the rest of the armoury speaks.
 *
 * FBXLoader produces MeshPhongMaterial and MTLLoader produces Phong too, while
 * every built gun -- and every skin that repaints one -- is a
 * MeshStandardMaterial. Leaving the difference in place means two weapons in the
 * same armoury respond differently to the same finish, and the ones that came
 * from a download are the ones that look wrong.
 *
 * Converting is also what makes the studio environment work on them: Phong has
 * no metalness, so it ignores the environment map entirely and a chrome slide
 * renders as flat grey.
 *
 * @param m the imported material
 * @returns {THREE.MeshStandardMaterial} a fresh material, never shared
 */
function toStandard(m) {
  if (m.isMeshStandardMaterial) return m.clone();

  // Phong's specular strength is the only hint it carries about how metallic a
  // surface is meant to be, so it seeds metalness rather than being discarded.
  const spec = m.specular ? (m.specular.r + m.specular.g + m.specular.b) / 3 : 0;
  const shine = typeof m.shininess === 'number' ? m.shininess : 30;
  const color = m.color ? m.color.clone() : new THREE.Color(0xffffff);
  if (!m.map) {
    const lightness = (color.r + color.g + color.b) / 3;
    // Hobbyist MTLs commonly use literal zero and one as placeholders. Under
    // PBR those become light-eating black and highlight-clipping white, hiding
    // the geometry that the material was meant to reveal. Keep their hue while
    // pulling only those unusable endpoints into the armoury's working range.
    if (lightness < 0.006) color.setRGB(0.014, 0.014, 0.014);
    else if (lightness > 0.9) color.multiplyScalar(0.58);
  }
  return new THREE.MeshStandardMaterial({
    name: m.name,
    color,
    map: m.map ?? null,
    normalMap: m.normalMap ?? m.bumpMap ?? null,
    aoMap: m.aoMap ?? null,
    // FBX exports from several of the installed packs arrive with emissive set
    // to full white even though the source has no luminous material. Preserving
    // that exporter default makes the entire mesh render as an unshaded white
    // cut-out and completely hides its albedo/normal maps. A real emissive
    // surface has an emissive map; otherwise imported weapons are not lights.
    emissive: m.emissiveMap && m.emissive ? m.emissive.clone() : 0x000000,
    emissiveMap: m.emissiveMap ?? null,
    transparent: m.transparent,
    opacity: m.opacity,
    side: m.side,
    // Shininess runs 0..1000 in practice; the log keeps the low end, which is
    // where almost every hobbyist export sits, from collapsing to one value.
    roughness: Math.min(1, Math.max(0.12, 1 - Math.log10(1 + shine) / 3)),
    // Deliberately conservative, and capped well below 1. A white specular
    // colour is the FBX exporter's default, not a statement that the surface is
    // chrome -- reading it literally put every downloaded gun at metalness 0.9,
    // where a MeshStandardMaterial has almost no diffuse response left and the
    // model lives or dies by whatever the environment map happens to be. The
    // built guns sit at 0.35; this keeps loaded ones in the same neighbourhood.
    metalness: Math.min(0.45, Math.max(0.15, spec * 0.4)),
  });
}

/**
 * Tag every material with the palette slot a built part would have had.
 *
 * Rebuilt per mesh, never shared: two weapons out of one pack arrive sharing a
 * material, and repainting one would repaint the other.
 */
function tagSurfaces(root) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const tagged = mats.map((m) => {
      const name = `${m.name || ''} ${o.name || ''}`;
      const rule = ROLE_RULES.find(([re]) => re.test(name));
      const role = rule ? rule[1] : 'METAL';
      const std = toStandard(m);
      // Imported scope lenses are commonly exported as opaque Phong surfaces.
      // When the mesh/material name tells us it is glass, restore the physical
      // contract: it may tint the view, but it must not become a solid cap at
      // the exact moment the player aims through it.
      if (/lens|glass|reticle/i.test(name)) {
        std.transparent = true;
        std.opacity = Math.min(std.opacity ?? 1, 0.18);
        std.depthWrite = false;
        std.side = THREE.DoubleSide;
        std.userData.adsNonBlocking = true;
      }
      std.userData.baseRole = role;
      // Packs and skins remap from this hex when a role lookup misses, so it
      // has to be a plausible palette colour rather than the photo's average.
      std.userData.baseHex = ROLE_HEX[role] ?? ROLE_HEX.METAL;
      std.userData.baseRoughness = std.roughness;
      std.userData.baseMetalness = std.metalness;
      return std;
    });
    o.material = Array.isArray(o.material) ? tagged : tagged[0];
    o.castShadow = false;   // the viewmodel scene has no shadow-casting lights
    o.receiveShadow = false;
  });
}

/** One decoded texture per URL, shared by every copy of that weapon. */
async function texture(url, colour = false) {
  if (!TEXTURE_CACHE.has(url)) {
    TEXTURE_CACHE.set(url, new THREE.TextureLoader().loadAsync(url).then((t) => {
      if (colour) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      return t;
    }).catch((err) => {
      console.warn(`[weaponmodels] texture ${url}: ${err?.message ?? err}`);
      return null;
    }));
  }
  return TEXTURE_CACHE.get(url);
}

/** Restore the PBR maps an FBX/MTL export failed to reference correctly. */
async function applyPbrSet(root, entry) {
  const sets = PBR_SETS[entry.id];
  if (!sets) return;

  const base = new URL(`../../${entry.file}`, import.meta.url);
  const loaded = new Map();
  for (const set of sets) {
    for (const key of ['map', 'normalMap', 'aoMap', 'metalnessMap', 'roughnessMap']) {
      const file = set[key];
      if (!file || loaded.has(file)) continue;
      loaded.set(file, await texture(new URL(file, base).href, key === 'map'));
    }
  }

  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const mat of (Array.isArray(o.material) ? o.material : [o.material])) {
      const name = `${mat.name || ''} ${o.name || ''}`;
      const set = sets.find((candidate) => !candidate.match || candidate.match.test(name));
      if (!set) continue;
      for (const key of ['map', 'normalMap', 'aoMap', 'metalnessMap', 'roughnessMap']) {
        if (set[key] && loaded.get(set[key])) mat[key] = loaded.get(set[key]);
      }
      if (set.map) mat.color.setHex(0xffffff);
      if (set.roughness !== undefined) mat.roughness = set.roughness;
      if (set.metalness !== undefined) mat.metalness = set.metalness;

      // Ambient occlusion has its own UV channel in three.js. These models
      // ship one UV set, so mirror it rather than silently ignoring their AO.
      if (mat.aoMap && o.geometry.attributes.uv && !o.geometry.attributes.uv1) {
        o.geometry.setAttribute('uv1', o.geometry.attributes.uv);
      }
      mat.needsUpdate = true;
      mat.userData.baseRoughness = mat.roughness;
      mat.userData.baseMetalness = mat.metalness;
    }
  });
}

/**
 * Derive muzzle and sight anchors from the shape.
 *
 * Both are Object3Ds parented to the model, because that is what viewmodel.js
 * reads: it takes their world position each frame, so anchors follow recoil,
 * sway and the melee swing for free.
 */
/**
 * Bounding box of a subtree, in that subtree's own frame.
 *
 * `Box3.setFromObject` measures in world space, which is the wrong frame for
 * placing children and quietly wrong by a factor of the scale above it. Doing
 * it explicitly -- each geometry's own box, pushed through the transform
 * relative to the root -- keeps every number here in one frame, which is what
 * makes the arithmetic below reviewable.
 */
function localBox(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rel = new THREE.Matrix4();
  const box = new THREE.Box3();
  const hands = new Set();
  root.traverse((o) => {
    // The gloves and forearms are not part of the weapon, and a box drawn round
    // them is dominated by an arm leaving the frame -- see addHands in
    // viewmodel.js. Skipping the flagged subtree is what makes "as long as the
    // built gun" mean the gun.
    if (o.userData?.hands || (o.parent && hands.has(o.parent))) { hands.add(o); return; }
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    rel.multiplyMatrices(inv, o.matrixWorld);
    box.union(o.geometry.boundingBox.clone().applyMatrix4(rel));
  });
  return box;
}

/** Position of an authored anchor in its model's unscaled local frame. */
function localAnchor(root, anchor) {
  if (!anchor) return null;
  root.updateMatrixWorld(true);
  return root.worldToLocal(anchor.getWorldPosition(new THREE.Vector3()));
}

/** The physical points inferred from an already squared-up imported model. */
function inferredAnchors(box, align, clearSight = null) {
  const centre = box.getCenter(new THREE.Vector3());
  const height = box.max.y - box.min.y;
  const depth = box.max.z - box.min.z;
  return {
    muzzle: align.muzzle
      ? new THREE.Vector3().fromArray(align.muzzle)
      : new THREE.Vector3(centre.x, box.max.y - height * 0.35, box.min.z),
    sight: align.sight
      ? new THREE.Vector3().fromArray(align.sight)
      : clearSight
        ? clearSight.clone()
      // The top of the housing is not the line the eye looks through. Inset
      // into the silhouette so an iron notch or optic centre, rather than its
      // cap, lands on the crosshair.
      : new THREE.Vector3(centre.x, box.max.y - height * (align.sightInset ?? 0.09),
        centre.z - depth * 0.1),
  };
}

function addAnchors(outer, align, inferred) {

  if (!align.noMuzzle) {
    const muzzle = new THREE.Object3D();
    muzzle.position.copy(inferred.muzzle);
    // Parented to `outer`, in `outer`'s frame, which is the frame `box` is in.
    // Anchors used to hang off the inner holder, and the holder's own rotation
    // then meant the box coordinates addressed a different set of axes than the
    // ones they were measured in -- so every muzzle landed near the middle of
    // its gun instead of at the end of the barrel.
    outer.add(muzzle);
    outer.userData.muzzle = muzzle;
  }

  // Melee weapons get no sight, deliberately. The built pickaxe and knife have
  // none either -- "melee weapons never aim", as the note above their builders
  // puts it -- and adsPose falls back to a neutral hold when the anchor is
  // absent. Deriving one anyway gave a knife a sight picture to line up, which
  // is a pose the game has no business offering for a blade.
  if (align.noMuzzle) return;

  const sight = new THREE.Object3D();
  sight.position.copy(inferred.sight);
  outer.add(sight);
  outer.userData.sight = sight;
}

function hitMaterial(hit) {
  const material = hit.object?.material;
  if (!Array.isArray(material)) return material;
  return material[hit.face?.materialIndex ?? 0];
}

function blocksSight(hit) {
  const material = hitMaterial(hit);
  return material
    && material.visible !== false
    && material.colorWrite !== false
    && (material.opacity ?? 1) >= 0.35
    && !material.userData?.adsNonBlocking;
}

/**
 * Find a genuinely open line immediately above/through an imported weapon.
 *
 * Asset bounds can tell us where the top of a scope is, not where its aperture
 * is. This samples a small eye box through the model and prefers the clear line
 * closest to the conventional sight height. If a source model has a capped or
 * baked scope, the safe answer is just above it: less cinematic than guessing
 * at an opaque lens, but the target remains visible and shots still go exactly
 * through screen centre.
 */
function clearSightLine(holder, box, align) {
  if (align.sight) return new THREE.Vector3().fromArray(align.sight);

  holder.updateMatrixWorld(true);
  const centre = box.getCenter(new THREE.Vector3());
  const width = box.max.x - box.min.x;
  const height = box.max.y - box.min.y;
  const depth = box.max.z - box.min.z;
  const wantedY = box.max.y - height * (align.sightInset ?? 0.09);
  const eyeRadius = Math.max(0.0005, Math.min(width, height) * 0.025);
  const ray = new THREE.Raycaster();
  let best = null;

  // Search from slightly above the silhouette down through the top third. The
  // centreline is tried first, followed by tiny lateral offsets for asymmetric
  // side-mounted launcher sights.
  const xs = [0, -0.08, 0.08, -0.16, 0.16].map((n) => centre.x + width * n);
  for (let yi = 0; yi <= 24; yi++) {
    const y = box.max.y + height * 0.025 - height * (yi / 24) * 0.38;
    for (const x of xs) {
      let blocked = 0;
      for (const dx of [-eyeRadius, 0, eyeRadius]) {
        for (const dy of [-eyeRadius, 0, eyeRadius]) {
          ray.set(new THREE.Vector3(x + dx, y + dy, box.max.z + depth * 0.15 + 0.01),
            new THREE.Vector3(0, 0, -1));
          if (ray.intersectObject(holder, true).some(blocksSight)) blocked++;
        }
      }
      const distance = Math.abs(y - wantedY) / Math.max(height, 1e-6)
        + Math.abs(x - centre.x) / Math.max(width, 1e-6) * 0.35;
      const score = blocked * 10 + distance;
      if (!best || score < best.score) best = { x, y, blocked, score };
    }
  }

  const sight = new THREE.Vector3(best?.x ?? centre.x, best?.y ?? wantedY,
    centre.z - depth * 0.1);
  sight.userData = { blockedSamples: best?.blocked ?? 9 };
  return sight;
}

/**
 * Load the weapon that answers `id`, sized against the built one.
 *
 * @param id        weapon id, as keyed in viewmodel.js BUILDERS
 * @param reference the procedurally built model, used purely as a ruler. Its
 *                  own scale is ignored -- only the unscaled geometry matters.
 * @returns {Promise<THREE.Group|null>} null whenever the built gun should stay
 */
export async function loadWeaponModel(id, reference) {
  const entry = (await weaponManifest()).get(id);
  if (!entry) return null;

  let model;
  try {
    ({ scene: model } = await loadModelFile(new URL(`../../${entry.file}`, import.meta.url).href));
  } catch (err) {
    console.warn(`[weaponmodels] ${id}: ${err?.message ?? err}`);
    return null;
  }

  const align = ALIGN[id] || {};
  const removedSourceParts = id === 'sniper'
    ? removeLeeEnfieldDisplayRound(model)
    : id === 'deagle' ? removeRevolverDisplayAmmo(model) : [];
  const raw = new THREE.Box3().setFromObject(model);
  const rawSize = raw.getSize(new THREE.Vector3());
  if (!(rawSize.x > 0 && rawSize.y > 0 && rawSize.z > 0)) {
    console.warn(`[weaponmodels] ${id}: empty geometry`);
    return null;
  }
  // Component-level geometry inspection stays limited to the two sources that
  // shipped detached display ammunition. Running graph connectivity across
  // every firearm would add seconds to startup for audit data nobody reads.
  const partAudit = (id === 'sniper' || id === 'deagle') ? sourcePartAudit(model) : [];

  const holder = squareUp(model, align);
  if (align.yaw) holder.rotation.y += align.yaw;
  if (align.pitch) holder.rotation.x += align.pitch;
  if (align.roll) holder.rotation.z += align.roll;

  const outer = new THREE.Group();
  outer.add(holder);

  // Measure in `outer`'s frame, which means *after* squareUp has turned the
  // barrel onto -Z and before any scale is applied. Everything downstream --
  // the fit, the centring and both anchors -- is then in one frame, which is the
  // only way "the front face" reliably means the end of the barrel.
  outer.scale.setScalar(1);
  holder.position.set(0, 0, 0);
  outer.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());

  tagSurfaces(holder);
  await applyPbrSet(holder, entry);
  const clearSight = align.noMuzzle ? null : clearSightLine(holder, box, align);
  const inferred = inferredAnchors(box, align, clearSight);

  // Match the built gun's longest dimension, hands excluded: a box drawn round
  // the built model includes an arm running off the bottom of the screen.
  const refBox = localBox(reference);
  const refSize = refBox.getSize(new THREE.Vector3());
  const have = Math.max(size.x, size.y, size.z);
  if (!(have > 0)) {
    // Measured across meshes only, so this fires on a file that parsed but
    // produced no faces -- lines or points instead of triangles, which is what a
    // stray line element in an OBJ export does to the whole object.
    console.warn(`[weaponmodels] ${id}: no triangles in "${entry.pick ?? entry.uid}", keeping built model`);
    return null;
  }
  const k = (Math.max(refSize.x, refSize.y, refSize.z) / have) * (align.scale ?? 1);
  outer.scale.setScalar(k);

  // Fit to gameplay anchors, not just to the centre of the bounding box. Two
  // models can have the same length and centre while putting their sights at
  // different heights and their muzzle at opposite ends. The built weapon is
  // the authored contract, so put the imported sight on its sight line and its
  // barrel end on its muzzle. That makes every replacement inherit the exact
  // hip/ADS transition and flash origin of the gun it replaces.
  const shift = refBox.getCenter(new THREE.Vector3()).divideScalar(k)
    .sub(box.getCenter(new THREE.Vector3()));
  if (!align.noMuzzle) {
    const refSight = localAnchor(reference, reference.userData.sight);
    const refMuzzle = localAnchor(reference, reference.userData.muzzle);
    if (refSight) {
      shift.x = refSight.x / k - inferred.sight.x;
      shift.y = refSight.y / k - inferred.sight.y;
    }
    if (refMuzzle) shift.z = refMuzzle.z / k - inferred.muzzle.z;
  }
  holder.position.copy(shift);
  box.translate(shift);          // keep the box and the model in step
  // `inferred` was measured before the holder was fitted to the reference.
  // Anchors are children of `outer`, not of the shifted holder, so they need
  // the identical translation or ADS aims at the model's old origin. The old
  // code happened to recompute anchors after translating `box`; retaining an
  // explicitly clearance-tested sight point makes this step necessary.
  inferred.muzzle.add(shift);
  inferred.sight.add(shift);

  const scope = await attachRealScope(outer, id, box);
  if (scope) {
    // ADS translation should rise toward the actual mounted optic during the
    // transition. Magnified weapons mask the physical model only at the final
    // overlay frame, so this is visible and important for the whole raise.
    // `scope.position` is already in outer/model space. Box3.setFromObject
    // would return world-scaled coordinates here and move the ADS anchor by the
    // fit factor a second time.
    inferred.sight.x = scope.position.x;
    inferred.sight.y = scope.position.y;
  }

  addAnchors(outer, align, inferred);
  // Depth is part of ADS too. Falling back to a single -0.24 value made a
  // loaded pistol, rifle and scope all stop at the same eye relief even though
  // their built counterparts deliberately do not.
  outer.userData.adsZ = align.adsZ ?? reference.userData.adsZ;
  // Unusual holds such as the hip-braced minigun deliberately do not put their
  // physical sight anchor on the camera centreline. The fitted real model must
  // inherit that authored pose just like it inherits ADS depth.
  if (reference.userData.adsPoseOverride) {
    outer.userData.adsPoseOverride = { ...reference.userData.adsPoseOverride };
  }
  outer.updateMatrixWorld(true);

  outer.userData.external = true;
  outer.userData.sourceAxis = holder.userData.sourceAxis;
  outer.userData.sourceFlip = !!align.flip;
  outer.userData.rawSize = holder.userData.rawSize;
  outer.userData.sourceParts = partAudit;
  outer.userData.removedSourceParts = removedSourceParts;
  outer.userData.realOptic = scope ? {
    source: scope.userData.source, variant: scope.userData.variant,
    credit: scope.userData.credit,
  } : null;
  outer.userData.sightBlockedSamples = clearSight?.userData?.blockedSamples ?? 0;
  outer.userData.credit = {
    title: entry.title, author: entry.author, license: entry.license, page: entry.page,
  };
  outer.name = `weapon:${id}`;
  return outer;
}

/** Only fresh procedural references should be fitted to downloaded art. */
export function needsWeaponAdoption(model) {
  return !!model && !model.userData.external;
}

/**
 * Swap in every installed weapon, then hand the viewmodel back to cosmetics.
 *
 * Called during the startup asset gate and again after a finish rebuild. The
 * startup caller awaits the complete swap before exposing the canvas; later
 * calls suppress each generated stand-in until its replacement resolves.
 *
 * @returns {Promise<string[]>} ids actually replaced, for logging
 */
export async function adoptWeaponModels(viewmodel) {
  const manifest = await weaponManifest();
  if (!manifest.size) return [];

  // An installed model is not allowed to reveal its generated stand-in while
  // the real file is pending. Leave the slot empty on a failed load as well:
  // a missing gun is preferable to the blocky backup flashing into the first
  // playable frame and then being replaced under the player's hands.
  for (const id of manifest.keys()) {
    if (PREFERRED_PROCEDURAL_WEAPONS.has(id)) continue;
    const built = viewmodel.models[id];
    if (!needsWeaponAdoption(built)) continue;
    built.userData.replacementPending = true;
    built.visible = false;
  }

  const swapped = [];
  await Promise.all([...manifest.keys()].map(async (id) => {
    if (PREFERRED_PROCEDURAL_WEAPONS.has(id)) return;
    const built = viewmodel.models[id];
    // Adoption is deliberately repeatable: a finish rebuild installs a fresh
    // procedural reference and needs another pass, while an already imported
    // model must be left alone. Measuring a raw download against that same
    // download treats its fitted scale as local geometry, discards the fit
    // factor, and replaces a 4 cm scale with MODEL_SCALE (0.66). The result is
    // the camera-inside-the-pistol failure seen after a later presentation
    // handoff.
    if (!needsWeaponAdoption(built)) return;
    const model = await loadWeaponModel(id, built);
    if (!model) return;
    viewmodel.replaceModel(id, model);
    swapped.push(id);
  }));

  // Skins live on materials that have just been thrown away with the
  // built models. Same guarantee _buildModels makes, for the same reason.
  if (swapped.length) viewmodel.onRefinish?.(viewmodel);
  return swapped;
}
