// Input system: keyboard + mouse, pointer-lock aware.
//
// Two flavours of query exist because they answer different questions:
//   isDown(code)      -- continuous state, for movement and automatic fire
//   wasPressed(code)  -- edge triggered, for jump / reload / weapon switch
// Edge state is cleared by endTick(), which the game loop calls once per fixed
// step, so a tap is never missed and never repeats.

import { key as boundKey, mouseButtonOf } from './bindings.js';

/**
 * True for anything the browser should be typing into rather than the game.
 *
 * Buttons and checkboxes are deliberately excluded: they are <input> elements
 * but they take no text, and Space on a focused button should still be the
 * game's jump rather than a click.
 */
const TYPELESS_INPUTS = new Set([
  'button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image',
]);

export function isTextEntry(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !TYPELESS_INPUTS.has(String(el.type || 'text').toLowerCase());
}

/** Native controls keep their keyboard behaviour while the pointer is free. */
export function isInteractiveControl(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return true;
  if (tag === 'A') return !!el.href || el.hasAttribute?.('href');
  // Keyboard events may originate from an icon or span inside a button/link.
  return !!el.closest?.('button,a[href],input,select,textarea,[contenteditable="true"]');
}

export class Input {
  constructor(canvas, { touchMode = false } = {}) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.mouseButtons = new Set();
    this.mousePressed = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.sensitivity = 0.0022;
    /**
     * Analog movement, or null to fall back to WASD.
     *
     * The thumb stick needs magnitude as well as direction -- a half push
     * should walk -- which four boolean keys cannot express. Player.move()
     * clamps rather than normalises, so a WASD diagonal still comes out at
     * full speed while a partial stick push does not.
     */
    this.moveAxis = null;
    /**
     * True when a finger is driving instead of a mouse.
     *
     * Pointer lock is not obtainable on a touch device, so everything gated on
     * `locked` would be dead forever. Reporting the input as captured is the
     * honest answer there: the game *does* have the input it needs, just not
     * through the Pointer Lock API.
     */
    this.touchMode = touchMode;
    this.locked = touchMode;
    /**
     * Whether the game currently wants the pointer. Set by the game each frame.
     * When this is true but `locked` is false, the next click retakes the lock
     * instead of reaching the game -- see the mousedown handler below.
     */
    this.wantLock = false;
    /** Set by the game: a real touch arrived on a session that guessed desktop. */
    this.onTouchDetected = null;

    this._onLockChange = () => {
      // Nothing requests a lock in touch mode, so this should never fire there
      // -- but if some other page script took one, letting it clear `locked`
      // would silently kill every touch input path.
      if (this.touchMode) return;
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.clear();
      this.onLockChange?.(this.locked);
    };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // Menus and the between-wave shop release pointer lock. In that state a
      // focused button, checkbox or link must keep native Space/Enter handling;
      // cancelling its keydown makes the UI mouse-only. Body/canvas shortcuts
      // (notably B to close the armoury) still flow into the game.
      if (!this.locked && isInteractiveControl(e.target)) return;
      // A focused text field owns the keyboard. The preventDefault below is
      // unconditional, and on an <input> that cancels the character insertion
      // itself -- which is what stopped anyone typing a room code or a name
      // into the co-op panel, and made co-op look like it was refusing joins.
      if (isTextEntry(e.target)) return;
      // Keep browser shortcuts like Cmd+R working; only swallow game keys.
      if (!e.metaKey && !e.ctrlKey && !e.altKey) e.preventDefault();
      this.keys.add(e.code);
      this.pressed.add(e.code);
    });
    // Deliberately not guarded by isTextEntry: a key pressed in the game and
    // released after clicking into a field must still be released, or the
    // player walks into a wall forever.
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    // Clicking into a text box mid-stride would otherwise leave W held down
    // while the player types.
    window.addEventListener('focusin', (e) => {
      if (isTextEntry(e.target)) this.clear();
    });
    // Releasing focus mid-key would otherwise leave that key stuck down.
    window.addEventListener('blur', () => this.clear());

    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    // Recovering the pointer lock. A lock can only be taken during a user
    // gesture, so anything that releases it from a timer or a game event -- a
    // wave starting while the armoury is open, say -- cannot retake it itself.
    // A click is the only place recovery is possible, and without this the
    // player is stuck in a live round with no mouse look and no way out.
    //
    // Registered before the fire handler and swallowing the event, so the click
    // that reclaims the mouse does not also shoot.
    // Skipped entirely in touch mode. There, `wantLock` is never satisfiable
    // and `locked` is already true, so this would either do nothing or -- if
    // the flags ever disagreed -- swallow every tap the player made, which is
    // exactly the dead end touch controls exist to remove.
    window.addEventListener('mousedown', (e) => {
      if (this.touchMode || this.locked || !this.wantLock) return;
      e.preventDefault();
      e.stopPropagation();
      this.requestLock();
    }, true);

    window.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.mouseButtons.add(e.button);
      this.mousePressed.add(e.button);
    });
    window.addEventListener('mouseup', (e) => this.mouseButtons.delete(e.button));
    window.addEventListener('contextmenu', (e) => { if (this.locked) e.preventDefault(); });
    window.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });

    // A real finger, arriving while the game wants a pointer lock it does not
    // have. That combination only happens on hardware that cannot grant one, so
    // it means the capability sniff guessed desktop on a touch device -- and the
    // consequence of leaving it wrong is the original dead end: a live round
    // with no look control and taps that reach nothing.
    //
    // Gated on wantLock so a stray tap on a menu, where no lock is wanted, never
    // promotes a desktop player into thumb-stick controls.
    window.addEventListener('touchstart', () => {
      if (this.touchMode || this.locked || !this.wantLock) return;
      this.onTouchDetected?.();
    }, { passive: true, capture: true });

    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  /**
   * Promote a running session to touch. Separate from the constructor flag
   * because the promotion can happen mid-round, after a wrong guess.
   */
  enableTouchMode() {
    if (this.touchMode) return;
    this.touchMode = true;
    this.locked = true;      // nothing will ever grant a real lock here
    this.wantLock = false;
    this.clear();
  }

  // Both no-ops under touch: there is no lock to take, and calling exitLock on
  // a menu must not clear `locked`, because on touch that flag is what tells
  // the rest of the game the player can still aim.
  requestLock() {
    if (this.touchMode) return;
    const p = this.canvas.requestPointerLock?.();
    // Chrome rejects a request that did not originate in a user gesture, and an
    // unhandled rejection here would surface as a console error on a path that
    // is genuinely recoverable: the next click retakes it.
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  exitLock() {
    if (this.touchMode) return;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressed.has(code); }

  /**
   * The same two queries, addressed by action rather than by physical input.
   *
   * A binding is a code, and a mouse button is just another code ('Mouse0'), so
   * these resolve to whichever set actually holds it. That is what lets fire sit
   * on a side button or aim sit on a key without a single call site caring.
   * An unbound action resolves to null, which no Set ever contains, so it simply
   * never fires.
   */
  actionDown(action) {
    const code = boundKey(action);
    const mb = mouseButtonOf(code);
    return mb === null ? this.keys.has(code) : this.mouseButtons.has(mb);
  }

  actionPressed(action) {
    const code = boundKey(action);
    const mb = mouseButtonOf(code);
    return mb === null ? this.pressed.has(code) : this.mousePressed.has(mb);
  }
  isMouseDown(btn) { return this.mouseButtons.has(btn); }
  wasMousePressed(btn) { return this.mousePressed.has(btn); }

  /** Consume accumulated look delta (radians). Called once per rendered frame. */
  consumeLook() {
    const dx = this.mouseDX * this.sensitivity;
    const dy = this.mouseDY * this.sensitivity;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { dx, dy };
  }

  consumeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Clear edge-triggered state. Called at the end of every fixed update. */
  endTick() {
    this.pressed.clear();
    this.mousePressed.clear();
  }

  clear() {
    this.keys.clear();
    this.pressed.clear();
    this.mouseButtons.clear();
    this.mousePressed.clear();
    this.mouseDX = this.mouseDY = 0;
    // Otherwise a stick held at the moment the window blurs -- or the game
    // pauses -- keeps the player walking into the pause menu.
    this.moveAxis = null;
  }
}
