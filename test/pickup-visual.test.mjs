import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';

import {
  Pickup, installPickupWeaponModel, PICKUP_WEAPON,
} from '../src/entities/pickup.js';

test('weapon loot shows the rolled gun instead of a generic supply cube', () => {
  const pickup = new Pickup({ type: PICKUP_WEAPON, kind: 'rifle' }, 4, 2, 8);
  assert.equal(pickup.mesh.userData.weaponModel, 'rifle');
  assert.ok(pickup.mesh.getObjectByName('loot-weapon:rifle'),
    'the rifle viewmodel was not mounted on its world pickup');
  assert.equal(pickup.mesh.getObjectByName('hands'), undefined,
    'first-person glove blobs leaked into the ground pickup');

  const other = new Pickup({ type: PICKUP_WEAPON, kind: 'shotgun' }, 4, 2, 8);
  assert.equal(other.mesh.userData.weaponModel, 'shotgun');
  assert.ok(other.mesh.getObjectByName('loot-weapon:shotgun'));
  assert.equal(other.mesh.getObjectByName('hands'), undefined);
});

test('weapon loot adopts the rendered armoury asset instead of rebuilding the stand-in', () => {
  const rendered = new THREE.Group();
  rendered.userData.external = true;
  rendered.visible = false;
  rendered.position.set(9, 4, -7);       // a live viewmodel pose must not leak through
  rendered.scale.setScalar(0.66);
  const authoredPart = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.15, 1.4),
    new THREE.MeshStandardMaterial({ color: 0xb87333 }),
  );
  authoredPart.name = 'rendered-flamethrower-body';
  rendered.add(authoredPart);

  assert.equal(installPickupWeaponModel('flamethrower', rendered), true);
  const pickup = new Pickup({ type: PICKUP_WEAPON, kind: 'flamethrower' }, 1, 2, 3);
  const weapon = pickup.mesh.getObjectByName('loot-weapon:flamethrower');
  assert.ok(weapon?.getObjectByName('rendered-flamethrower-body'),
    'the installed rendered asset was not used for ground loot');
  assert.equal(pickup.mesh.userData.weaponAsset, 'downloaded');
  assert.equal(weapon.visible, true, 'the viewmodel hidden state leaked into the pickup');
  assert.notEqual(
    weapon.getObjectByName('rendered-flamethrower-body').geometry,
    authoredPart.geometry,
    'pickup geometry is still owned by the disposable viewmodel',
  );
});

test('chest loot follows a visible ballistic pop before it can be collected', () => {
  const pickup = new Pickup({
    type: PICKUP_WEAPON,
    kind: 'minigun',
    ejectFrom: { x: 0, y: 1, z: 0 },
  }, 1.2, 0, -0.4);
  const player = { pos: { x: 1.2, y: 0, z: -0.4 }, height: 1.8 };

  assert.equal(pickup.inRange(player), false, 'loot can be taken while still inside the chest');
  pickup.update(0.31);
  assert.ok(pickup.mesh.position.y > 1.7, 'the reveal has no upward pop');
  assert.ok(pickup.mesh.position.x > 0 && pickup.mesh.position.x < pickup.x,
    'the reveal does not travel from chest to landing point');

  pickup.update(0.31);
  assert.equal(pickup.eject, null);
  assert.equal(pickup.inRange(player), true);
});
