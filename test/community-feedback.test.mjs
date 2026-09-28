import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.js';
import {
  InterplanetaryTravel,
  SNAIL_VISUAL_SCALE,
} from '../src/game/interplanetary.js';
import {
  COMMUNITY_SNAIL_SCALE,
  COMMUNITY_SNAIL_SAFE_DISTANCE,
  installCommunityFeedbackFixes,
} from '../src/game/community-feedback.js';

function input(down = [], pressed = []) {
  return { actionDown: (a) => down.includes(a), actionPressed: (a) => pressed.includes(a) };
}

function flightHarness() {
  installCommunityFeedbackFixes();
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xffffff, 1, 100);
  const world = {
    size: 128,
    heightAt: () => 0,
    inBounds: (x, z) => x > 0 && z > 0 && x < 128 && z < 128,
    blocksAt: () => false,
    plan: {
      start: 'spawn-room',
      rooms: [{
        id: 'spawn-room', minX: 106, maxX: 127, minZ: 106, maxZ: 127,
        floorY: 0,
      }],
    },
  };
  const player = {
    pos: { x: 120, y: 0, z: 120 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    alive: true,
    getLookDir(out) {
      const cp = Math.cos(this.pitch);
      out.x = -Math.sin(this.yaw) * cp;
      out.y = Math.sin(this.pitch);
      out.z = -Math.cos(this.yaw) * cp;
      return out;
    },
    spawn(p) {
      this.pos = { ...p };
      this.vel = { x: 0, y: 0, z: 0 };
    },
  };
  const audio = { setShipEngine() {}, stopShipEngine() {} };
  const flight = new InterplanetaryTravel(
    scene,
    new THREE.PerspectiveCamera(),
    player,
    world,
    { sky: { visible: true }, sun: { color: new THREE.Color() }, fill: { color: new THREE.Color() }, audio },
  );
  flight.reset(player.pos);
  return { flight, player, world };
}

function makeShopDom() {
  const listeners = new Map();
  const elements = new Map();
  let generated = 0;

  const makeElement = (id) => {
    const classes = new Set(id === 'shop' ? ['hidden'] : []);
    const el = {
      id,
      textContent: '',
      className: '',
      style: {},
      scrollTop: 0,
      parentElement: null,
      children: [],
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      },
      addEventListener(type, fn) { listeners.set(`${id}:${type}`, fn); },
      appendChild(child) {
        child.parentElement = el;
        el.children.push(child);
        return child;
      },
      append(...children) {
        for (const child of children) el.appendChild(child);
      },
      insertBefore(child, before) {
        const existing = el.children.indexOf(child);
        if (existing >= 0) el.children.splice(existing, 1);
        const index = el.children.indexOf(before);
        el.children.splice(index >= 0 ? index : el.children.length, 0, child);
        child.parentElement = el;
        return child;
      },
    };
    return el;
  };

  for (const id of ['shop', 'shop-items', 'shop-coins', 'shop-timer', 'shop-weapon', 'shop-close']) {
    elements.set(id, makeElement(id));
  }
  const panel = makeElement('shop-panel');
  panel.appendChild(elements.get('shop-items'));
  panel.appendChild(elements.get('shop-close'));

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    addEventListener(type, fn) { listeners.set(`window:${type}`, fn); },
  };
  globalThis.document = {
    getElementById(id) { return elements.get(id); },
    createElement(tag) { return makeElement(`${tag}-${++generated}`); },
  };

  return {
    listeners,
    elements,
    panel,
    restore() {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    },
  };
}

async function loadShopWithDom(dom) {
  try {
    // Cache-bust so every test gets a constructor wired to its own mocked DOM.
    return await import(`../src/ui/shop.js?feedback-test=${Date.now()}-${Math.random()}`);
  } catch (error) {
    dom.restore();
    throw error;
  }
}

test('one-shot snail is larger and kept out of the opening respawn', () => {
  const { flight, world } = flightHarness();
  const room = world.plan.rooms[0];

  assert.ok(flight.snailDistance >= COMMUNITY_SNAIL_SAFE_DISTANCE - 1e-6,
    `snail spawned only ${flight.snailDistance.toFixed(2)}m from the player`);
  assert.equal(
    flight.snailPos.x >= room.minX && flight.snailPos.x <= room.maxX
      && flight.snailPos.z >= room.minZ && flight.snailPos.z <= room.maxZ,
    false,
    'the lethal snail should not begin inside the player respawn room when a clear exterior point exists',
  );
  assert.equal(flight.snailSpawnRoomId, null);
  assert.ok(Math.abs(
    flight.snailMesh.scale.x - SNAIL_VISUAL_SCALE * COMMUNITY_SNAIL_SCALE,
  ) < 1e-9, 'the fallback snail should use the larger readable gameplay scale');
});

test('resuming on foot pushes a nearby snail outside the safe bubble', () => {
  const { flight, player } = flightHarness();
  flight.snailPlaced = true;
  flight.snailPos.set(player.pos.x + 1, 0.1, player.pos.z);
  flight.snailMesh.position.copy(flight.snailPos);
  flight.snailDistance = 1;

  flight._resumeSurfaceSnail(player);

  assert.ok(flight.snailDistance >= COMMUNITY_SNAIL_SAFE_DISTANCE - 1e-6,
    `resumed snail remained only ${flight.snailDistance.toFixed(2)}m away`);
  assert.equal(flight.snailActive, true);
  assert.equal(flight.snailMesh.visible, true);
});

test('between-wave armoury Escape always releases the solo round hold', async () => {
  const dom = makeShopDom();
  const { Shop } = await loadShopWithDom(dom);
  try {
    let relock = 0;
    const game = {
      state: 'playing',
      touchMode: false,
      input: { requestLock() { relock++; }, exitLock() {} },
      session: { multiplayer: false, sim: { holdBreak: true } },
    };
    const shop = new Shop(game);
    shop.open_ = true;
    dom.elements.get('shop').classList.remove('hidden');

    let prevented = false;
    dom.listeners.get('window:keydown')?.({
      code: 'Escape',
      preventDefault() { prevented = true; },
    });

    assert.equal(prevented, true, 'Escape should be owned by an open armoury');
    assert.equal(shop.isOpen, false);
    assert.equal(dom.elements.get('shop').classList.contains('hidden'), true);
    assert.equal(game.session.sim.holdBreak, false,
      'closing the shop must release the intentionally frozen solo intermission immediately');
    assert.equal(relock, 1, 'closing from a keyboard gesture should return mouse control to gameplay');
    assert.match(dom.elements.get('shop-close').textContent, /B \/ ESC/,
      'the close button should teach both reliable desktop exit paths');
  } finally {
    dom.restore();
  }
});

test('mobile wave clear does not force the player into the armoury', async () => {
  const dom = makeShopDom();
  const { Shop } = await loadShopWithDom(dom);
  try {
    let armouryPressed = false;
    const feed = [];
    const game = {
      state: 'playing',
      touchMode: true,
      input: {
        actionPressed(action) { return action === 'armoury' && armouryPressed; },
        requestLock() {},
        exitLock() {},
      },
      hud: { addFeed(message) { feed.push(message); } },
      session: { multiplayer: false, sim: { holdBreak: false } },
      waveBreak: 8,
    };
    const shop = new Shop(game);
    shop._build = () => {};

    // This is the same no-input call WAVE_CLEAR makes. On touch it should leave
    // gameplay controls up and advertise ARM rather than dropping a modal over
    // the player the instant the last zombie dies.
    shop.open();
    assert.equal(shop.isOpen, false);
    assert.equal(dom.elements.get('shop').classList.contains('hidden'), true);
    assert.match(feed.at(-1), /TAP ARM/);

    // The explicit ARM tap still opens the exact same shop.
    armouryPressed = true;
    shop.open();
    assert.equal(shop.isOpen, true);
    assert.equal(dom.elements.get('shop').classList.contains('hidden'), false);
  } finally {
    dom.restore();
  }
});

test('mobile armoury remains scrollable and keeps an exit under the thumb', async () => {
  const dom = makeShopDom();
  const { Shop } = await loadShopWithDom(dom);
  try {
    let relock = 0;
    const visibility = [];
    const game = {
      state: 'playing',
      touchMode: true,
      input: {
        actionPressed(action) { return action === 'armoury'; },
        requestLock() { relock++; },
        exitLock() {},
      },
      touch: { setVisible(on) { visibility.push(on); } },
      hud: { addFeed() {} },
      session: { multiplayer: false, sim: { holdBreak: false } },
      waveBreak: 8,
    };
    const shop = new Shop(game);
    shop._build = () => {};
    dom.panel.scrollTop = 120;
    shop.open();

    assert.equal(dom.panel.style.touchAction, 'pan-y');
    assert.equal(dom.panel.style.overscrollBehavior, 'contain');
    assert.equal(dom.panel.style.webkitOverflowScrolling, 'touch');
    assert.equal(dom.panel.scrollTop, 0, 'a newly opened mobile shop should start at its visible exit/header');
    assert.equal(dom.panel.children.indexOf(dom.elements.get('shop-close'))
      < dom.panel.children.indexOf(dom.elements.get('shop-items')), true,
    'BACK TO THE FIGHT should be above the long catalogue on mobile');
    assert.equal(dom.elements.get('shop-close').style.position, 'sticky');
    assert.equal(dom.elements.get('shop-close').style.top, '0');

    // touch.js blocks one-finger scrolling everywhere outside #overlay. The live
    // shop intentionally lives outside that element, so its panel must stop the
    // blocker before the event bubbles to document.
    let stopped = false;
    dom.listeners.get('shop-panel:touchmove')?.({ stopPropagation() { stopped = true; } });
    assert.equal(stopped, true, 'shop touchmove must not reach the global gameplay gesture blocker');

    game.session.sim.holdBreak = true;
    shop.close();
    assert.equal(game.session.sim.holdBreak, false);
    assert.deepEqual(visibility, [true], 'closing should restore touch gameplay controls immediately');
    assert.equal(relock, 1, 'the normal close path should still be used on touch');
  } finally {
    dom.restore();
  }
});
