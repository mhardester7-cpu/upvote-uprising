// Touch controls.
//
// The game is built around pointer lock: mouse look, WASD, and a fistful of
// letter keys. None of that exists on a phone -- pointer lock is not grantable
// on a touch device at all (Safari has no requestPointerLock, Chrome rejects
// it), and before this module the result was a permanent "CLICK TO RESUME
// LOOKING" with every tap swallowed by the relock handler.
//
// Rather than teach the rest of the game about touch, this synthesises the
// input the game already reads. The stick writes an analog vector the player
// picks up, the look zone accumulates into the same mouse deltas
// consumeLook() drains, and every button pushes the key or mouse button its
// keyboard equivalent would. Nothing downstream -- weapons, streaks, the
// armoury, the net session -- needs to know a finger is driving.
//
// Pointer Events rather than Touch Events, for two reasons: pointerId makes
// simultaneous stick + look + fire trivial to track, and calling
// preventDefault() on pointerdown suppresses the compatibility mouse events a
// mobile browser would otherwise fire afterwards -- without that, one tap on
// FIRE would arrive twice, once as a touch and once as a synthetic click.

import { key as boundKey, actionLabel, mouseButtonOf } from './bindings.js';

// -------------------------------------------------------------- fullscreen

const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;

/**
 * Whether this browser will put an arbitrary element fullscreen.
 *
 * False on iPhone Safari, which exposes the Fullscreen API on <video> only --
 * there is no way for a page to hide Safari's chrome on an iPhone. The answer
 * there is Add to Home Screen, which the apple-mobile-web-app meta tags in
 * index.html turn into a standalone window with no browser bar at all.
 */
export function fullscreenAvailable() {
  const d = document.documentElement;
  return !!(d.requestFullscreen || d.webkitRequestFullscreen);
}

export function isFullscreen() { return !!fsEl(); }

/** True when already running without browser chrome (installed to the home screen). */
export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches
    || matchMedia('(display-mode: fullscreen)').matches
    || navigator.standalone === true;      // iOS
}

/**
 * Go fullscreen, and turn the phone landscape if the browser allows it.
 *
 * MUST be called from inside a user gesture -- the same rule pointer lock
 * follows -- so this hangs off a real tap, never off a game event. Both
 * promises are swallowed: a rejection here is a browser saying no, not a bug,
 * and an unhandled one would surface as a console error on a path that is
 * merely unavailable.
 */
export async function enterFullscreen() {
  const d = document.documentElement;
  try {
    const p = d.requestFullscreen ? d.requestFullscreen({ navigationUI: 'hide' })
      : d.webkitRequestFullscreen?.();
    if (p) await p;
  } catch { /* browser declined */ }
  // Orientation lock only works while fullscreen, and only on Android; iOS
  // throws. Landscape is what an FPS wants, but never at the cost of an error.
  try { await screen.orientation?.lock?.('landscape'); } catch { /* not supported */ }
}

export function exitFullscreen() {
  try {
    screen.orientation?.unlock?.();
  } catch { /* not supported */ }
  try {
    if (document.exitFullscreen) document.exitFullscreen();
    else document.webkitExitFullscreen?.();
  } catch { /* not supported */ }
}

/** Toggle, for a button the player can hit either way. */
export function toggleFullscreen() {
  if (isFullscreen()) exitFullscreen();
  else return enterFullscreen();
  return Promise.resolve();
}

// ------------------------------------------------------------- gesture lock

let gesturesLocked = false;

/**
 * Stop the page itself zooming and scrolling under the controls.
 *
 * `user-scalable=no` in the viewport meta is not enough: iOS Safari has
 * deliberately ignored it since iOS 10, so a two-finger aim pinch-zooms the
 * whole page and the HUD ends up half off-screen. Safari's own non-standard
 * gesture events are the only hook that stops it, and double-tap zoom needs
 * the CSS touch-action rule in index.html alongside this.
 */
export function lockGestures() {
  if (gesturesLocked) return;
  gesturesLocked = true;
  const stop = (e) => e.preventDefault();
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(t, stop, { passive: false });
  }
  document.addEventListener('touchmove', (e) => {
    if (!e.cancelable) return;
    // Two fingers is an aim-plus-move, never a page gesture -- block it even
    // over a panel, since nothing in this game wants a pinch.
    if (e.touches.length > 1) { e.preventDefault(); return; }
    // One finger over a menu or the armoury has to keep scrolling: the shop
    // list is taller than a phone in landscape, and killing its scroll would
    // trade a zoom bug for an unreachable bottom half of the armoury.
    if (e.target instanceof Element && e.target.closest('#overlay')) return;
    // Anywhere else, a drag is aim or stick -- so no pull-to-refresh and no
    // rubber-band showing the page edges mid-fight.
    e.preventDefault();
  }, { passive: false });
}

// ------------------------------------------------------------ prompt naming

let touchPrompts = false;

/** Switch player-facing prompts over to naming buttons instead of keys. */
export function useTouchPrompts(on) { touchPrompts = on; }

const BTN_NAME = { interact: 'USE', reload: 'RLD', snap: 'SNAP', armoury: 'ARM' };

/**
 * What to call a control in text the player reads, given an action.
 *
 * On touch it names the on-screen button: "PRESS E" is worse than useless on a
 * phone, the same class of mistake as the relock prompt that sent players here
 * in the first place. On a keyboard it names whatever is currently *bound*, so
 * rebinding reload to T changes the HUD hint to "PRESS T" with no string
 * anywhere needing to be updated by hand.
 */
export function ctrl(action) {
  if (touchPrompts) {
    if (BTN_NAME[action]) return BTN_NAME[action];
    // Weapon slots have no on-screen button of their own -- the weapon list is
    // tapped directly -- so name them by number rather than leaking the action
    // id into the HUD as "slot13".
    const slot = /^slot(\d+)$/.exec(action);
    return slot ? slot[1] : action;
  }
  return actionLabel(action);
}

/** "PRESS" for a key, "TAP" for a button. */
export function pressWord() { return touchPrompts ? 'TAP' : 'PRESS'; }

/**
 * Best-effort pointer capture.
 *
 * Keeps a drag or a held button attached to the element it started on even if
 * the thumb slides off, which matters most for FIRE. It throws if the pointer
 * is not active, so it is never allowed to be load-bearing: callers do their
 * input work first and call this afterwards.
 */
function capture(el, pointerId) {
  try { el.setPointerCapture?.(pointerId); } catch { /* not worth a frame */ }
}

/** Look sensitivity relative to the mouse, per pixel dragged. */
const LOOK_SCALE = 2.6;

/** Radius in CSS pixels at which the movement stick reads full deflection. */
const STICK_RADIUS = 58;

/** Stick deflection past which a forward push counts as a sprint. */
const SPRINT_AT = 0.88;

/**
 * Whether to drive the game with touch controls.
 *
 * Capability, not device: coarse pointer *and* no hover is the pair that means
 * "finger". A touchscreen laptop reports maxTouchPoints > 0 while still having
 * a real mouse, so testing that alone would hand a desktop player a thumb
 * stick. `?touch=1` and `?touch=0` force it either way, which is the only
 * practical way to exercise this on a desktop browser.
 */
export function touchAvailable() {
  const forced = new URLSearchParams(location.search).get('touch');
  if (forced === '1') return true;
  if (forced === '0') return false;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const noHover = matchMedia('(hover: none)').matches;
  return coarse && noHover;
}

/**
 * Buttons, as [data-action, what it synthesises].
 *
 * `hold` entries stay down until the finger lifts, because the game reads them
 * with isDown/isMouseDown -- automatic fire and jump both need the continuous
 * state. `tap` entries are edge triggered through wasPressed, so they are added
 * once on touchdown and endTick() clears them.
 */
const BUTTONS = {
  // aimWhileHeld: sliding off FIRE keeps firing and starts aiming, which is the
  // only way two thumbs cover move, look and shoot at the same time.
  fire: { kind: 'hold', action: 'fire', aimWhileHeld: true },
  ads: { kind: 'toggle', action: 'ads' },
  // These name an *action*, not a key, and resolve through bindings.js at press
  // time. Synthesising the literal code would quietly break every touch button
  // the moment someone rebound the same action on a keyboard.
  jump: { kind: 'hold', action: 'jump' },
  reload: { kind: 'tap', action: 'reload' },
  interact: { kind: 'tap', action: 'interact' },
  swap: { kind: 'tap', action: 'lastWeapon' },
  snap: { kind: 'tap', action: 'snap' },
  armoury: { kind: 'tap', action: 'armoury' },
  // These two have no key to synthesise -- on desktop pause is the browser
  // releasing pointer lock, and fullscreen is the browser's own chrome -- so
  // they call straight out instead.
  pause: { kind: 'call', fn: 'onPause' },
  fullscreen: { kind: 'call', fn: 'onFullscreen' },
};

export class TouchControls {
  /**
   * @param {import('./input.js').Input} input the input system to drive
   * @param {HTMLElement} root the #touch container from index.html
   */
  constructor(input, root) {
    this.input = input;
    this.root = root;

    /** Set by the game: called when the pause button is tapped. */
    this.onPause = null;
    /** Tapped fullscreen. Runs inside the gesture, which the API requires. */
    this.onFullscreen = () => toggleFullscreen();

    this.visible = true;      // matches the class removed at the end of setup
    this.stickId = null;      // pointerId currently driving movement
    this.lookId = null;       // pointerId currently driving look
    this.stickOrigin = { x: 0, y: 0 };
    this.lookLast = { x: 0, y: 0 };
    this.adsOn = false;

    this.pad = root.querySelector('[data-stick-pad]');
    this.nub = root.querySelector('[data-stick-nub]');
    this.stickZone = root.querySelector('[data-zone="move"]');
    this.lookZone = root.querySelector('[data-zone="look"]');

    this._bindZone(this.stickZone, 'stick');
    this._bindZone(this.lookZone, 'look');
    for (const el of root.querySelectorAll('[data-action]')) this._bindButton(el);

    // Pinch, double-tap zoom and pull-to-refresh all have to go before the
    // first drag, or an aim gesture resizes the page instead of turning.
    lockGestures();

    // Only show the fullscreen button where it can do something. On an iPhone
    // it cannot, and Add to Home Screen is the answer there instead.
    const fs = root.querySelector('[data-action="fullscreen"]');
    if (fs && fullscreenAvailable() && !isStandalone()) fs.classList.remove('unavailable');

    root.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ zones

  _bindZone(el, which) {
    if (!el) return;

    el.addEventListener('pointerdown', (e) => {
      // Suppresses the synthetic mouse events that would otherwise follow.
      e.preventDefault();
      if (which === 'stick') {
        if (this.stickId !== null) return;
        this.stickId = e.pointerId;
        // A floating origin -- wherever the thumb lands becomes centre -- is
        // far more forgiving than a fixed pad, because a thumb reaching for a
        // painted circle it cannot see never lands where it thinks it did.
        this.stickOrigin.x = e.clientX;
        this.stickOrigin.y = e.clientY;
        this._showPad(e.clientX, e.clientY);
        this._moveStick(e.clientX, e.clientY);
      } else {
        if (this.lookId !== null) return;
        this.lookId = e.pointerId;
        this.lookLast.x = e.clientX;
        this.lookLast.y = e.clientY;
      }
      capture(el, e.pointerId);
    });

    el.addEventListener('pointermove', (e) => {
      if (which === 'stick' && e.pointerId === this.stickId) {
        e.preventDefault();
        this._moveStick(e.clientX, e.clientY);
      } else if (which === 'look' && e.pointerId === this.lookId) {
        e.preventDefault();
        // Straight into the accumulators consumeLook() drains, so touch look
        // runs through the same sensitivity and ADS scaling as the mouse.
        this.input.mouseDX += (e.clientX - this.lookLast.x) * LOOK_SCALE;
        this.input.mouseDY += (e.clientY - this.lookLast.y) * LOOK_SCALE;
        this.lookLast.x = e.clientX;
        this.lookLast.y = e.clientY;
      }
    });

    const end = (e) => {
      if (which === 'stick' && e.pointerId === this.stickId) {
        this.stickId = null;
        this._releaseStick();
      } else if (which === 'look' && e.pointerId === this.lookId) {
        this.lookId = null;
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  _showPad(x, y) {
    if (!this.pad) return;
    this.pad.style.left = `${x}px`;
    this.pad.style.top = `${y}px`;
    this.pad.classList.add('live');
  }

  _moveStick(x, y) {
    let dx = (x - this.stickOrigin.x) / STICK_RADIUS;
    let dy = (y - this.stickOrigin.y) / STICK_RADIUS;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }

    // Screen down is +y, and the player's forward is -z, so dy maps to iz
    // directly: pushing up the screen gives a negative iz, same as KeyW.
    this.input.moveAxis = { x: dx, z: dy };

    // Sprint is a full forward push rather than a separate button. One less
    // thing under the thumb, and it matches what the stick is already saying.
    const sprinting = len > SPRINT_AT && dy < -0.5;
    const sprintKey = boundKey('sprint');
    if (sprintKey) {
      if (sprinting) this.input.keys.add(sprintKey);
      else this.input.keys.delete(sprintKey);
    }

    if (this.nub) {
      this.nub.style.transform =
        `translate(-50%, -50%) translate(${dx * STICK_RADIUS}px, ${dy * STICK_RADIUS}px)`;
    }
  }

  _releaseStick() {
    this.input.moveAxis = null;
    const sprintKey = boundKey('sprint');
    if (sprintKey) this.input.keys.delete(sprintKey);
    this.pad?.classList.remove('live');
    if (this.nub) this.nub.style.transform = 'translate(-50%, -50%)';
  }

  // ---------------------------------------------------------------- buttons

  _bindButton(el) {
    const spec = BUTTONS[el.dataset.action];
    if (!spec) return;

    // The pointer currently holding this button, or null. Release and move are
    // matched against it and bound on the window rather than the element,
    // because a thumb that slides off the button must keep driving it -- see
    // aimWhileHeld below. Element-bound listeners stop firing the moment the
    // pointer leaves, and pointerleave-as-release actively fights that.
    let heldBy = null;
    let lastX = 0, lastY = 0;
    // Resolved once on press and remembered, so a release always clears exactly
    // what the press set even if the binding moved in between. A binding may be
    // either kind of code, so both slots exist and exactly one is ever filled.
    let heldCode = null;      // a KeyboardEvent.code
    let heldMouse = null;     // a mouse button index

    /**
     * Push the action's current binding into whichever input set holds that kind
     * of code. Fire and aim are bindable now, so a touch button cannot assume it
     * is synthesising a mouse button any more than it can assume a key.
     */
    const engage = (edge) => {
      const code = boundKey(spec.action);
      const mb = mouseButtonOf(code);
      if (mb !== null) {
        heldMouse = mb;
        this.input.mouseButtons.add(mb);
        if (edge) this.input.mousePressed.add(mb);
      } else if (code) {
        heldCode = code;
        this.input.keys.add(code);
        if (edge) this.input.pressed.add(code);
      }
    };

    const disengage = () => {
      if (heldMouse !== null) { this.input.mouseButtons.delete(heldMouse); heldMouse = null; }
      if (heldCode) { this.input.keys.delete(heldCode); heldCode = null; }
    };

    const press = (e) => {
      if (heldBy !== null) return;
      heldBy = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('down');

      if (spec.kind === 'call') {
        this[spec.fn]?.();
      } else if (spec.kind === 'toggle') {
        this.adsOn = !this.adsOn;
        el.classList.toggle('latched', this.adsOn);
        if (this.adsOn) engage(false); else disengage();
      } else {
        engage(true);
      }

      // Capture last, and never let it break the press. setPointerCapture
      // throws outright if the pointer is not currently active -- and it was
      // doing exactly that ahead of the synthesis above, which meant a throw
      // here swallowed the input entirely and the button did nothing at all.
      // The capture is a convenience (it keeps the release on this element when
      // the thumb slides off); the input is the point.
      capture(el, e.pointerId);
    };

    const release = (e) => {
      if (e && heldBy !== e.pointerId) return;
      heldBy = null;
      el.classList.remove('down');
      // A toggle keeps its state; a hold drops it. Taps drop the continuous
      // half too -- the edge was already banked in `pressed` on the way down.
      if (spec.kind === 'toggle') return;
      disengage();
    };

    // Aim out of the button itself.
    //
    // A phone has two thumbs and this needs three inputs at once: move, look,
    // and fire. Left thumb owns the stick, right thumb owns FIRE, and there is
    // nothing left to drag the look zone with -- so holding fire meant standing
    // still or aiming, never both. Letting the held button double as a look
    // surface gives the right thumb both jobs: press to fire, then keep sliding
    // to aim, with the shot never interrupted.
    const move = (e) => {
      if (heldBy !== e.pointerId || !spec.aimWhileHeld) return;
      this.input.mouseDX += (e.clientX - lastX) * LOOK_SCALE;
      this.input.mouseDY += (e.clientY - lastY) * LOOK_SCALE;
      lastX = e.clientX;
      lastY = e.clientY;
    };

    el.addEventListener('pointerdown', press);
    // Window-level, so a thumb that has slid off the button still reports.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  }

  /** Drop ADS, so it cannot stay latched across a death or a menu. */
  resetAds() {
    if (!this.adsOn) return;
    this.adsOn = false;
    const code = boundKey('ads');
    const mb = mouseButtonOf(code);
    if (mb !== null) this.input.mouseButtons.delete(mb);
    else if (code) this.input.keys.delete(code);
    for (const el of this.root.querySelectorAll('[data-action="ads"]')) {
      el.classList.remove('latched', 'down');
    }
  }

  /**
   * Show the pad and buttons only while a round is actually being played.
   *
   * Called every frame, so it early-returns on no change: releasing the stick
   * and dropping ADS on every hidden frame would fight the player's thumb the
   * moment the armoury closed.
   */
  setVisible(on) {
    if (on === this.visible) return;
    this.visible = on;
    this.root.classList.toggle('hidden', !on);
    if (!on) { this._releaseStick(); this.resetAds(); }
  }
}
