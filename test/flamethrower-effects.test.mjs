import test from 'node:test';
import assert from 'node:assert/strict';
import { Effects } from '../src/render/effects.js';
import { ViewModel } from '../src/render/viewmodel.js';
import { WEAPONS } from '../src/combat/weapons.js';

test('flame jet is a bounded expanding fire-and-smoke volume, not a tracer', () => {
  const scene = { children: [], add(object) { this.children.push(object); } };
  const effects = new Effects(scene);
  effects.flameJet(0, 1.5, 0, 10, 1.5, 0, () => 0.5);

  const fire = effects.flamePool.filter((particle) => particle.active);
  const smoke = effects.smokePool.filter((particle) => particle.active);
  assert.ok(fire.length >= 7, 'jet does not have enough volume samples');
  assert.equal(smoke.length, 1, 'a deterministic jet should emit one sparse soot volume');
  assert.ok(fire.at(-1).size > fire[0].size * 2,
    'fire should expand away from the pressurised nozzle');
  assert.ok(fire[0].g > fire.at(-1).g,
    'the hot nozzle core should cool from pale yellow toward orange');
  assert.equal(effects.tracerPool.some((tracer) => tracer.active), false,
    'flameJet must not fall back to a laser-straight tracer');

  const previousLife = fire[0].life;
  const flameMatrixVersion = effects.flames.instanceMatrix.version;
  const smokeMatrixVersion = effects.smoke.instanceMatrix.version;
  effects.update(1 / 60, { heightAt: () => -100 });
  assert.ok(fire[0].life < previousLife, 'fire particles do not advance');
  assert.ok(effects.flames.instanceMatrix.version > flameMatrixVersion);
  assert.ok(effects.smoke.instanceMatrix.version > smokeMatrixVersion);
});

test('explosions use rounded fire and smoke instead of a voxel fireball', () => {
  const scene = { children: [], add(object) { this.children.push(object); } };
  const effects = new Effects(scene);
  effects.explosion(2, 3, 4, 4.8);

  const fire = effects.flamePool.filter((particle) => particle.active);
  const smoke = effects.smokePool.filter((particle) => particle.active);
  const debris = effects.particlePool.filter((particle) => particle.active);
  assert.ok(fire.length >= 40, 'the blast has no rounded hot core');
  assert.ok(smoke.length >= 20, 'the blast has no rolling soot volume');
  assert.ok(debris.length <= 12, 'block debris still dominates the explosion');
  assert.equal(effects.flames.visible, true);
  assert.equal(effects.smoke.visible, true);

  effects.clear();
  const version = effects.flames.instanceMatrix.version;
  effects.update(1 / 60, { heightAt: () => 0 });
  assert.equal(effects.flames.instanceMatrix.version, version,
    'an idle effects pool still uploads every instance transform');
});

test('first-person flamethrower plume follows held trigger state', () => {
  const def = WEAPONS.find((weapon) => weapon.id === 'flamethrower');
  const viewmodel = new ViewModel();
  viewmodel.setWeapon('flamethrower');
  const weapons = {
    def, current: { isEmpty: false }, triggerHeld: true, isBusy: false,
    isSwitching: false, pendingIndex: -1, switchTimer: 0,
    isReloading: false, adsT: 0, kickBack: 0, spin: 0,
  };
  const player = { bobPhase: 0, bobAmount: 0, sprinting: false };

  viewmodel.update(1 / 60, player, weapons, { dx: 0, dy: 0 });
  assert.equal(viewmodel.flamePlume.visible, true);
  assert.ok(viewmodel.flameLight.intensity > 3);

  weapons.triggerHeld = false;
  viewmodel.update(1 / 60, player, weapons, { dx: 0, dy: 0 });
  assert.equal(viewmodel.flamePlume.visible, false);
  assert.equal(viewmodel.flameLight.intensity, 0);
});
