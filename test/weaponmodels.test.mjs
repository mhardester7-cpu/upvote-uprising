import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from '../vendor/three.module.js';
import { WEAPONS } from '../src/combat/weapons.js';
import {
  ADS_MASKS_MODEL, BUILDERS, MODEL_SCALE, auditAdsClearance,
  poseWeaponForAds, ViewModel, weaponAdsPose, weaponModelVisibleInAds,
} from '../src/render/viewmodel.js';
import {
  geometryParts, needsWeaponAdoption, removeLeeEnfieldDisplayRound,
  PREFERRED_PROCEDURAL_WEAPONS,
} from '../src/render/weaponmodels.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(ROOT, 'src/render/weaponmodels.js'), 'utf8');
const sheet = readFileSync(path.join(ROOT, 'tools/weaponsheet.html'), 'utf8');

test('imported weapons inherit the authored sight line and ADS depth', () => {
  assert.match(source, /shift\.x = refSight\.x \/ k - inferred\.sight\.x/);
  assert.match(source, /shift\.y = refSight\.y \/ k - inferred\.sight\.y/);
  assert.match(source, /shift\.z = refMuzzle\.z \/ k - inferred\.muzzle\.z/);
  assert.match(source, /outer\.userData\.adsZ = align\.adsZ \?\? reference\.userData\.adsZ/);
  assert.match(source, /inferred\.muzzle\.add\(shift\)/);
  assert.match(source, /inferred\.sight\.add\(shift\)/);
});

test('a repeated adoption pass never refits an already imported weapon', () => {
  const built = new THREE.Group();
  const imported = new THREE.Group();
  imported.userData.external = true;
  assert.equal(needsWeaponAdoption(built), true);
  assert.equal(needsWeaponAdoption(imported), false,
    'a second adoption can use an imported pistol as its own ruler and make it enormous');
  assert.equal(needsWeaponAdoption(null), false);
  assert.match(source, /if \(!needsWeaponAdoption\(built\)\) return;/);
});

test('every installed real firearm has an explicit audited source orientation', () => {
  const installed = {
    pistol: ['z', true], deagle: ['x', false], rifle: ['z', true],
    smg: ['z', true], microsmg: ['z', false], shotgun: ['x', false],
    sniper: ['x', true], bazooka: ['x', false], minigun: ['z', false],
    flamethrower: ['x', false],
  };

  for (const [id, [axis, flip]] of Object.entries(installed)) {
    const row = new RegExp(`${id}:\\s*\\{[^\\n]*axis: '${axis}'[^\\n]*flip: ${flip}`);
    assert.match(source, row, `${id} has no explicit source-axis/muzzle contract`);
    for (const key of ['yaw', 'pitch', 'roll'])
      assert.match(source, new RegExp(`${id}:\\s*\\{[^\\n]*${key}: 0`), `${id} ${key} is not calibrated`);
  }
});

test('the imported pickaxe head leads the authored swing', () => {
  assert.match(source,
    /pickaxe:\s*\{\s*axis: 'y', flip: false, yaw: 0,[\s\S]*?roll: Math\.PI/);
});

test('the Intervention is a complete authored asset and wins over legacy downloads', () => {
  const model = BUILDERS.sniper();
  const names = new Set();
  const byName = new Map();
  const finishes = new Set();
  let hasProceduralHands = false;
  model.traverse((part) => {
    names.add(part.name);
    if (part.name) byName.set(part.name, part);
  });
  model.traverse((part) => {
    if (part.userData?.hands) hasProceduralHands = true;
    const material = Array.isArray(part.material) ? part.material[0] : part.material;
    if (material?.userData?.finishKind) finishes.add(material.userData.finishKind);
  });

  assert.equal(model.name, 'weapon:sniper:intervention');
  assert.equal(model.userData.variant, 'intervention');
  assert.ok(PREFERRED_PROCEDURAL_WEAPONS.has('sniper'));
  for (const name of [
    'muzzle-brake', 'chassis-vent--1-0', 'bolt-handle', 'stock-upper-strut',
    'stock-lower-strut', 'scope-objective', 'bipod-leg--1', 'grip-palm-swell',
    'grip-panel--1', 'grip-finger-groove-2',
  ]) assert.ok(names.has(name), `Intervention is missing ${name}`);

  for (const finish of ['cerakote', 'brushed', 'polymer', 'rubber']) {
    assert.ok(finishes.has(finish), `Intervention is missing its ${finish} texture`);
  }
  assert.equal(model.userData.handsOmitted, true);
  assert.equal(hasProceduralHands, false, 'generic floating arms returned to the Intervention');
  assert.equal(byName.get('scope-main').geometry.parameters.openEnded, false,
    'scope body is hollow through its middle');
  for (const name of ['scope-objective-glass', 'scope-eye-glass']) {
    const lens = byName.get(name).material;
    assert.equal(lens.transparent, false, `${name} shows the world through its glass`);
    assert.equal(lens.opacity, 1, `${name} is not optically sealed`);
    assert.equal(lens.depthWrite, true, `${name} cannot occlude the interior tube`);
  }

  assert.ok(model.userData.muzzle, 'Intervention has no muzzle anchor');
  assert.ok(model.userData.sight, 'Intervention has no optic sight anchor');
  assert.equal(model.userData.adsZ, -0.22);

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  assert.ok(size.z > 1.55, `Intervention silhouette is too short (${size.z})`);
  assert.ok(size.y > 0.38, `Intervention silhouette lost its scope/stock profile (${size.y})`);
});

test('the gun-only Intervention shot visibly cycles its bolt, flash and spent casing', () => {
  const viewmodel = new ViewModel();
  const player = { bobPhase: 0, bobAmount: 0, sprinting: false };
  const weapons = {
    def: { id: 'sniper', reloadTime: 2.6, adsSight: 'scope' },
    isSwitching: false, pendingIndex: -1, isReloading: false,
    kickBack: 0, spin: 0, adsT: 0, triggerHeld: false,
    current: { isEmpty: false }, weapons: [],
  };
  const look = { dx: 0, dy: 0 };

  viewmodel.update(0, player, weapons, look);
  const model = viewmodel.model;
  const boltRest = model.userData.bolt.position.z;
  const weaponRest = model.position.clone();
  viewmodel.triggerFlash();
  viewmodel.update(0.052, player, weapons, look);
  assert.ok(model.position.z > weaponRest.z + 0.05, 'shot has no strong shoulder recoil');
  assert.ok(viewmodel.flash.visible, 'sniper muzzle blast is not visible');

  viewmodel.update(0.468, player, weapons, look);
  assert.ok(model.userData.bolt.position.z > boltRest + 0.08, 'bolt never draws rearward');
  assert.equal(model.userData.triggerHand, undefined, 'generic firing arm is still attached');
  assert.equal(model.userData.casing.visible, true, 'spent casing is never ejected');

  viewmodel.update(0.60, player, weapons, look);
  assert.ok(Math.abs(model.userData.bolt.position.z - boltRest) < 1e-8, 'bolt does not lock home');
  assert.equal(model.userData.casing.visible, false, 'spent casing remains stuck in the view');
});

test('the gun-only Intervention reload cleanly removes and returns its magazine', () => {
  const viewmodel = new ViewModel();
  const player = { bobPhase: 0, bobAmount: 0, sprinting: false };
  const weapons = {
    def: { id: 'sniper', reloadTime: 2.6, adsSight: 'scope' },
    isSwitching: false, pendingIndex: -1, isReloading: true,
    reloadTotal: 2.6, reloadTimer: 2.08,
    kickBack: 0, spin: 0, adsT: 0, triggerHeld: false,
    current: { isEmpty: false }, weapons: [],
  };

  viewmodel.update(0.01, player, weapons, { dx: 0, dy: 0 });
  assert.ok(viewmodel.model.userData.magazine.position.y < -0.20,
    'magazine does not clear the magwell');
  assert.equal(viewmodel.model.userData.supportHand, undefined,
    'generic support arm is still attached');

  weapons.isReloading = false;
  viewmodel.update(0.01, player, weapons, { dx: 0, dy: 0 });
  assert.ok(viewmodel.model.userData.magazine.position.length() < 1e-8,
    'magazine does not return after reload');
});

test('a melee discharge triggers a visible wind-up and diagonal follow-through', () => {
  const mainSource = readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  assert.match(mainSource, /if \(w\.def\.melee\) \{[\s\S]*?this\.viewmodel\.triggerSwing/,
    'melee damage is not wired to the viewmodel animation');

  const viewmodel = new ViewModel();
  const player = { bobPhase: 0, bobAmount: 0, sprinting: false };
  const weapons = {
    def: { id: 'pickaxe', reloadTime: 0.4, adsSight: 'iron' },
    isSwitching: false, pendingIndex: -1, isReloading: false,
    kickBack: 0, spin: 0, adsT: 0, triggerHeld: false,
    current: { isEmpty: false }, weapons: [],
  };
  const look = { dx: 0, dy: 0 };

  viewmodel.update(0, player, weapons, look);
  const rest = viewmodel.model.position.clone();
  viewmodel.triggerSwing(0.4);
  viewmodel.update(0.05, player, weapons, look);
  const windup = viewmodel.model.position.clone();
  assert.ok(windup.x > rest.x && windup.y > rest.y && windup.z > rest.z,
    'pickaxe does not pull back before the strike');

  viewmodel.update(0.22, player, weapons, look);
  const strike = viewmodel.model.position;
  assert.ok(strike.x < windup.x && strike.y < windup.y && strike.z < windup.z,
    'pickaxe does not sweep down and across on the strike');
});

test('every ranged built weapon has an obstruction-safe full ADS pose', () => {
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.01, 20);
  camera.updateProjectionMatrix();

  for (const def of WEAPONS.filter((d) => BUILDERS[d.id] && !d.melee && !d.portal)) {
    const model = BUILDERS[def.id]();
    assert.ok(model.userData.sight, `${def.id} has no sight anchor`);
    assert.ok(model.userData.muzzle, `${def.id} has no muzzle anchor`);
    model.scale.setScalar(MODEL_SCALE);
    model.userData.ads = weaponAdsPose(model);
    poseWeaponForAds(model, def.adsSight || 'iron', 1);
    const audit = auditAdsClearance(model, camera, { grid: 15, radiusNdc: 0.12 });

    assert.ok(audit.coverage <= 0.45,
      `${def.id} blocks ${(audit.coverage * 100).toFixed(1)}% of its ADS eye box`);
    if (ADS_MASKS_MODEL.has(def.adsSight)) {
      assert.equal(model.visible, false, `${def.id} physical optic is still drawn at full ADS`);
      assert.equal(audit.coverage, 0, `${def.id} masked optic still obstructs the target`);
    }
  }
});

test('the minigun uses a low brace ADS pose that leaves the target area clear', () => {
  const model = BUILDERS.minigun();
  model.scale.setScalar(MODEL_SCALE);
  const pose = weaponAdsPose(model);
  assert.deepEqual(pose, { x: 0.10, y: -0.14, z: -0.38 });
  poseWeaponForAds(model, 'iron', 1);

  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.01, 20);
  camera.updateProjectionMatrix();
  const audit = auditAdsClearance(model, camera, { grid: 21, radiusNdc: 0.12 });
  assert.equal(audit.centerBlocked, false);
  assert.equal(audit.coverage, 0,
    'the minigun still occupies the central ADS target area');
  assert.match(source,
    /outer\.userData\.adsPoseOverride = \{ \.\.\.reference\.userData\.adsPoseOverride \}/,
    'the downloaded minigun does not inherit the authored brace pose');
});

test('scope, thermal, and RPG overlays mask only the final physical-optic frame', () => {
  for (const sight of ['scope', 'thermal', 'bazooka']) {
    assert.equal(weaponModelVisibleInAds(sight, 0.90), true);
    assert.equal(weaponModelVisibleInAds(sight, 0.92), false);
    assert.equal(weaponModelVisibleInAds(sight, 1), false);
  }
  assert.equal(weaponModelVisibleInAds('iron', 1), true);
});

test('a pending real weapon stays invisible instead of showing its generated backup', () => {
  const viewmodel = new ViewModel();
  const pistol = viewmodel.models.pistol;
  viewmodel.requireExternalModel('pistol');
  const player = { bobPhase: 0, bobAmount: 0, sprinting: false };
  const weapons = {
    def: { id: 'pistol', reloadTime: 0.4, adsSight: 'iron' },
    isSwitching: false, pendingIndex: -1, isReloading: false,
    kickBack: 0, spin: 0, adsT: 0, triggerHeld: false,
    current: { isEmpty: false }, weapons: [],
  };
  viewmodel.update(0, player, weapons, { dx: 0, dy: 0 });
  assert.equal(pistol.visible, false);
  assert.equal(viewmodel.flash.visible, false);

  viewmodel.applyCamo('standard');
  assert.equal(viewmodel.models.pistol.userData.replacementPending, true,
    'a finish rebuild made the starter fallback eligible to render again');
});

test('browser QA sheet renders held and actual ADS views with obstruction data', () => {
  assert.match(sheet, /HELD \/ HIP/);
  assert.match(sheet, /FULL ADS/);
  assert.match(sheet, /auditAdsClearance\(model, camera/);
  assert.match(sheet, /cell\.dataset\.coverage/);
  assert.match(sheet, /cell\.dataset\.sourceAxis/);
  assert.match(sheet, /cell\.dataset\.sourceFlip/);
  assert.match(sheet, /cell\.dataset\.realOptic/);
  assert.match(sheet, /cell\.dataset\.removedSourceParts/);
  assert.match(sheet, /window\.weaponQaReady = true/);
});

test('rifle and sniper use a credited real scope and the Lee-Enfield display round is removed exactly', () => {
  const scope = path.join(ROOT, 'assets/weapons/optic_vss_pso/Soviet_Special_Sniper_Rifle.fbx');
  assert.ok(existsSync(scope), 'the CC0 PSO scope source is missing');
  assert.match(source, /REAL_SCOPE_FILE = 'assets\/weapons\/optic_vss_pso\/Soviet_Special_Sniper_Rifle\.fbx'/);
  assert.match(source, /if \(id !== 'rifle' && id !== 'sniper'\) return null/);
  assert.match(source, /scope\.userData\.realAsset = true/);
  assert.match(source, /part\.triangleCount === 50/,
    'sniper cartridge removal is not constrained to its exact geometry island');
  assert.match(source, /Math\.abs\(sx - 0\.50765\) < 0\.002/);
  assert.match(source, /o\.geometry = geometrySubset\(o\.geometry, keep\)/);
});

test('the shipped Lee-Enfield FBX loses its loose bullet in the real loader geometry', async () => {
  // FBXLoader creates image elements while parsing material maps. The cleanup
  // itself is geometry-only, so a tiny inert DOM surface is enough for Node to
  // parse the exact file the browser receives without loading its textures.
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElementNS(_namespace, tagName) {
      return {
        tagName, style: {}, addEventListener() {}, removeEventListener() {},
        setAttribute() {}, set src(value) { this._src = value; },
        get src() { return this._src || ''; },
      };
    },
  };
  try {
    const { FBXLoader } = await import('../vendor/loaders/FBXLoader.js');
    const bytes = readFileSync(path.join(ROOT,
      'assets/weapons/sniper_enfield/FP Hunting Rifle.fbx'));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const rifle = new FBXLoader().parse(buffer, 'assets/weapons/sniper_enfield/');
    const mesh = rifle.getObjectByName('FP_Hunting_Rifle');
    assert.ok(mesh?.isMesh, 'the shipped sniper mesh did not parse');

    const isLooseRound = (part) => part.triangleCount === 50
      && Math.abs(part.size[0] - 0.50765) < 0.002
      && Math.abs(part.center[0] - 0.71593) < 0.002;
    assert.equal(geometryParts(mesh.geometry).filter(isLooseRound).length, 1,
      'test fixture no longer contains the reported display bullet');

    const removed = removeLeeEnfieldDisplayRound(rifle);
    assert.equal(removed.length, 1, 'the loose sniper bullet was not removed');
    assert.equal(removed[0].triangleCount, 50);
    assert.equal(geometryParts(mesh.geometry).filter(isLooseRound).length, 0,
      'the loose sniper bullet survived the cleanup pass');
    // This thin eight-vertex island is a legitimate rifle component near the
    // receiver. Exact removal must not "fix" the bullet by deleting it too.
    assert.equal(geometryParts(mesh.geometry).filter((part) => part.triangleCount === 10).length, 1);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('the revolver removes only its complete detached display-ammo cluster', () => {
  assert.match(source, /function removeRevolverDisplayAmmo\(root\)/);
  assert.match(source, /\[292, 76, 38\]\.includes\(part\.triangleCount\)/,
    'revolver cleanup is not constrained to the known display-part geometry');
  assert.match(source, /if \(loose\.length !== 8\) return/,
    'partial signature matches must fail closed instead of deleting gun parts');
  assert.match(source, /id === 'deagle' \? removeRevolverDisplayAmmo\(model\) : \[\]/);
  assert.match(sheet, /removedSourceParts\.reduce\(\(sum, part\) => sum \+ part\.triangleCount, 0\)/,
    'the browser QA sheet does not report the full removed geometry count');
});

test('the automatic rifle advertises its real magnified optic to gameplay', () => {
  const rifle = WEAPONS.find((weapon) => weapon.id === 'rifle');
  assert.equal(rifle.adsSight, 'scope');
  assert.equal(rifle.adsFov, 48);
});

test('bad FBX emissive defaults cannot wash out imported weapon textures', () => {
  assert.match(source,
    /emissive: m\.emissiveMap && m\.emissive \? m\.emissive\.clone\(\) : 0x000000/);
});

test('every explicitly restored weapon PBR map is installed', () => {
  const expected = {
    deagle_revolver: ['Revolver_NRM.png', 'Revolver_SPEC.png'],
    sniper_enfield: ['FP Hunting Rifle NRM.png', 'FP Hunting Rifle SPEC.png'],
    flamethrower_lp: [
      'Flamethrower.png', 'Flamethrower NRM.png', 'Flamethrower AO.png',
      'Flamethrower MET.png',
    ],
    pickaxe_fireaxe: [
      'Fire Axe BaseColor.png', 'Fire Axe Normal.png', 'Fire Axe Ambient Occlusion.png',
      'Fire Axe Metallic.png', 'Fire Axe Roughness.png',
    ],
    knife_m9: [
      'Handle_albedo.png', 'Handle_nm.png', 'Handle_ao.png',
      'Handle_metallic.png', 'Handle_roughness.png',
      'Knife_albedo.png', 'Knife_nm.png', 'Knife_ao.png',
      'Knife_metallic.png', 'Knife_roughness.png',
    ],
  };

  for (const [directory, files] of Object.entries(expected)) {
    for (const file of files) {
      assert.ok(source.includes(`'${file}'`), `${directory}/${file} is not bound by the loader`);
      assert.ok(existsSync(path.join(ROOT, 'assets/weapons', directory, file)),
        `${directory}/${file} is missing`);
    }
  }
});
