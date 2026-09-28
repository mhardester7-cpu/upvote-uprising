// Key bindings.
//
// Every keyboard action in the game resolves through here rather than reading a
// literal KeyboardEvent.code, so a player can move the controls to whatever
// their hands expect -- ESDF, arrows, a left-handed layout, a keyboard whose
// layout puts W somewhere else entirely.
//
// The map is the single source of truth for three things that used to disagree:
// what the game actually reads, what the menu's control list claims, and what
// the in-world prompts tell you to press. All three now come from this file, so
// rebinding reload to T changes the HUD hint to "PRESS T" without anyone
// remembering to update a string.
//
// Mouse buttons are bindable too, and share one namespace with the keys: a
// binding is a code, and 'Mouse0' is as valid a code as 'KeyW'. That is what
// lets fire live on a side button, or aim on a key for someone playing
// one-handed -- and it is why a conflict check has to span both, since binding
// jump to Mouse1 must take Mouse1 off aim.
//
// Only the wheel and Escape stay fixed: the wheel is an axis rather than a
// button, and Escape is how a browser releases pointer lock.

const STORE_KEY = 'bs.binds';

/** Mouse button index -> binding code, and back. */
export const MOUSE_PREFIX = 'Mouse';
export function mouseCode(button) { return `${MOUSE_PREFIX}${button}`; }
export function mouseButtonOf(code) {
  if (typeof code !== 'string' || !code.startsWith(MOUSE_PREFIX)) return null;
  const n = Number(code.slice(MOUSE_PREFIX.length));
  return Number.isInteger(n) ? n : null;
}
export function isMouseCode(code) { return mouseButtonOf(code) !== null; }

/**
 * Every bindable action, in the order the settings screen lists them.
 *
 * `group` only drives the headings in the UI. `def` is the factory binding, and
 * is what Reset restores.
 */
export const ACTIONS = [
  { id: 'forward', label: 'Move forward', def: 'KeyW', group: 'MOVEMENT' },
  { id: 'back', label: 'Move back', def: 'KeyS', group: 'MOVEMENT' },
  { id: 'left', label: 'Strafe left', def: 'KeyA', group: 'MOVEMENT' },
  { id: 'right', label: 'Strafe right', def: 'KeyD', group: 'MOVEMENT' },
  { id: 'sprint', label: 'Sprint', def: 'ShiftLeft', group: 'MOVEMENT' },
  { id: 'jump', label: 'Jump', def: 'Space', group: 'MOVEMENT' },

  { id: 'fire', label: 'Fire', def: 'Mouse0', group: 'COMBAT' },
  { id: 'ads', label: 'Aim down sights', def: 'Mouse2', group: 'COMBAT' },
  { id: 'reload', label: 'Reload', def: 'KeyR', group: 'COMBAT' },
  { id: 'lastWeapon', label: 'Last weapon', def: 'KeyQ', group: 'COMBAT' },
  { id: 'snap', label: 'Gauntlet snap', def: 'KeyF', group: 'COMBAT' },

  { id: 'interact', label: 'Interact / use / buy', def: 'KeyE', group: 'WORLD' },
  { id: 'armoury', label: 'Armoury (between waves)', def: 'KeyB', group: 'WORLD' },

  // One per slot, not per weapon: slots are handed out in the order guns are
  // found, so which weapon answers to a key is a run-time fact and cannot be a
  // label here. These ids are load-bearing -- the switch code looks up
  // `slot<n>` from the carried weapon's slot -- and there must be at least
  // SLOT_COUNT of them, or the last weapons found would be unreachable.
  //
  // 1-9 and 0 take the number row and the rest continue onto the keys
  // immediately to its right, so the guns you found first sit under your
  // fingers. All of it is rebindable from the CONTROLS screen.
  { id: 'slot1', label: 'Slot 1', def: 'Digit1', group: 'WEAPON SLOTS' },
  { id: 'slot2', label: 'Slot 2', def: 'Digit2', group: 'WEAPON SLOTS' },
  { id: 'slot3', label: 'Slot 3', def: 'Digit3', group: 'WEAPON SLOTS' },
  { id: 'slot4', label: 'Slot 4', def: 'Digit4', group: 'WEAPON SLOTS' },
  { id: 'slot5', label: 'Slot 5', def: 'Digit5', group: 'WEAPON SLOTS' },
  { id: 'slot6', label: 'Slot 6', def: 'Digit6', group: 'WEAPON SLOTS' },
  { id: 'slot7', label: 'Slot 7', def: 'Digit7', group: 'WEAPON SLOTS' },
  { id: 'slot8', label: 'Slot 8', def: 'Digit8', group: 'WEAPON SLOTS' },
  { id: 'slot9', label: 'Slot 9', def: 'Digit9', group: 'WEAPON SLOTS' },
  { id: 'slot10', label: 'Slot 10', def: 'Digit0', group: 'WEAPON SLOTS' },
  { id: 'slot11', label: 'Slot 11', def: 'Minus', group: 'WEAPON SLOTS' },
  { id: 'slot12', label: 'Slot 12', def: 'Equal', group: 'WEAPON SLOTS' },
  { id: 'slot13', label: 'Slot 13', def: 'BracketLeft', group: 'WEAPON SLOTS' },
  { id: 'slot14', label: 'Slot 14', def: 'BracketRight', group: 'WEAPON SLOTS' },
  { id: 'slot15', label: 'Slot 15', def: 'Backslash', group: 'WEAPON SLOTS' },
  { id: 'slot16', label: 'Slot 16', def: 'Semicolon', group: 'WEAPON SLOTS' },
  { id: 'slot17', label: 'Slot 17', def: 'Quote', group: 'WEAPON SLOTS' },
];

const DEFAULTS = Object.freeze(
  Object.fromEntries(ACTIONS.map((a) => [a.id, a.def])),
);

/** action id -> KeyboardEvent.code, or null for deliberately unbound. */
let current = { ...DEFAULTS };

const listeners = new Set();
function announce() {
  saveBindings();
  for (const fn of listeners) fn();
}

/** Subscribe to rebinds, so the HUD and menu redraw. Returns an unsubscribe. */
export function onBindingsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Codes that must never be captured as a binding.
 *
 * Escape is how a browser releases pointer lock, which is the game's pause
 * signal -- binding it to something would take away the only way out of a
 * round. F-keys and the browser's own modifiers stay with the browser.
 */
const RESERVED = new Set(['Escape', 'Tab', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'MetaLeft', 'MetaRight',
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight']);

export function isReserved(code) { return RESERVED.has(code); }

export function loadBindings() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
  } catch { saved = null; }
  // Merge onto the defaults rather than replacing them, so a binding added in a
  // later version appears for a player who already has a saved map -- otherwise
  // a new action would be permanently unbound for everyone who ever rebound
  // anything.
  current = { ...DEFAULTS };
  if (saved && typeof saved === 'object') {
    for (const a of ACTIONS) {
      const v = saved[a.id];
      if (v === null || (typeof v === 'string' && v && !isReserved(v))) current[a.id] = v;
    }
  }
  return current;
}

export function saveBindings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(current)); } catch { /* private mode */ }
}

/** The code bound to an action, or null. */
export function key(action) { return current[action] ?? null; }

/** Which action owns a code, or null. */
export function actionFor(code) {
  if (!code) return null;
  for (const a of ACTIONS) if (current[a.id] === code) return a.id;
  return null;
}

/**
 * Bind a code to an action.
 *
 * A code can only drive one action, so binding one that is already taken
 * unbinds the previous owner rather than silently giving one key two jobs. The
 * displaced action is returned so the UI can say what it just cost you.
 *
 * @returns {{ok: boolean, reason?: string, displaced?: string}}
 */
export function setBinding(action, code) {
  if (!(action in current)) return { ok: false, reason: 'unknown action' };
  if (isReserved(code)) return { ok: false, reason: 'reserved' };

  const prev = actionFor(code);
  if (prev === action) return { ok: true };           // no change
  if (prev) current[prev] = null;
  current[action] = code;
  announce();
  return { ok: true, displaced: prev || undefined };
}

export function clearBinding(action) {
  if (!(action in current)) return;
  current[action] = null;
  announce();
}

export function resetBindings() {
  current = { ...DEFAULTS };
  announce();
}

export function isDefault() {
  return ACTIONS.every((a) => current[a.id] === a.def);
}

/**
 * A short human label for a code.
 *
 * KeyboardEvent.code is a physical-position name, not a character -- 'KeyW' is
 * "the key where W is on US QWERTY" -- so this strips the prefix rather than
 * pretending to know the player's layout. Everything else gets spelled out,
 * because "ArrowLeft" in a settings row is noise where an arrow is instant.
 */
const NAMES = {
  Space: 'SPACE',
  ShiftLeft: 'L SHIFT', ShiftRight: 'R SHIFT',
  ControlLeft: 'L CTRL', ControlRight: 'R CTRL',
  AltLeft: 'L ALT', AltRight: 'R ALT',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Enter: 'ENTER', Backspace: 'BKSP', CapsLock: 'CAPS',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
  Comma: ',', Period: '.', Slash: '/',
};

const MOUSE_NAMES = ['LEFT CLICK', 'MIDDLE CLICK', 'RIGHT CLICK'];

export function keyLabel(code) {
  const mb = mouseButtonOf(code);
  if (mb !== null) return MOUSE_NAMES[mb] ?? `MOUSE ${mb + 1}`;
  if (!code) return '—';
  if (NAMES[code]) return NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `NUM ${code.slice(6)}`;
  return code.toUpperCase();
}

/** Convenience for prompts: the label of whatever currently drives an action. */
export function actionLabel(action) { return keyLabel(key(action)); }
