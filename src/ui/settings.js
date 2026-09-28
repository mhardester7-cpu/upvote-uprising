// Controls screen: rebind any key, see every control in one place.
//
// The menu links here on demand so the full binding map stays useful without
// taking over the game's front screen.

import {
  ACTIONS, key, keyLabel, setBinding, resetBindings, onBindingsChanged,
  isReserved, actionFor, mouseCode,
} from '../engine/bindings.js';

const $ = (id) => document.getElementById(id);

/**
 * Controls the game owns but does not let you move, listed anyway.
 *
 * A controls screen that shows only the rebindable half is a worse reference
 * than the hardcoded list it replaced -- a player looking for "how do I aim"
 * should find it here.
 */
const FIXED = [
  ['MOUSE', 'Look'],
  ['WHEEL', 'Cycle weapon'],
  ['ESC', 'Pause'],
];

export class Settings {
  /** @param onClose called with the panel id to return to. */
  constructor(onClose) {
    this.onClose = onClose;
    this.panel = $('panel-settings');
    this.list = $('binds');
    this.note = $('bind-note');
    this.returnTo = 'panel-menu';
    this.listening = null;        // action id currently awaiting a key

    $('btn-binds-back').addEventListener('click', () => this.close());
    $('btn-binds-reset').addEventListener('click', () => {
      this._stopListening();
      resetBindings();
      this._say('Defaults restored.');
    });

    // Capture phase, and swallowed: while a row is armed the next key belongs to
    // the binding, not to the game. Without stopping propagation the same press
    // would also land in Input's key set and fire whatever it used to do.
    window.addEventListener('keydown', (e) => {
      if (!this.listening) return;
      e.preventDefault();
      e.stopPropagation();
      this._capture(e.code);
    }, true);

    // Mouse buttons are bindings too, so an armed row has to be able to catch
    // one. Capture phase and swallowed for the same reason as the keys: while a
    // row is armed the click belongs to the binding, and letting it through
    // would also fire the gun it is being bound to.
    window.addEventListener('mousedown', (e) => {
      if (!this.listening) return;
      e.preventDefault();
      e.stopPropagation();
      this._capture(mouseCode(e.button));
    }, true);
    // Otherwise a right-click bind pops the browser menu over the panel.
    window.addEventListener('contextmenu', (e) => {
      if (this.listening) e.preventDefault();
    });

    onBindingsChanged(() => this._build());
  }

  get isOpen() { return !this.panel.classList.contains('hidden'); }

  open(returnTo = 'panel-menu') {
    this.returnTo = returnTo;
    this._say('');
    this._build();
    $(returnTo)?.classList.add('hidden');
    this.panel.classList.remove('hidden');
  }

  close() {
    this._stopListening();
    this.panel.classList.add('hidden');
    $(this.returnTo)?.classList.remove('hidden');
    this.onClose?.(this.returnTo);
  }

  _say(text, warn = false) {
    this.note.textContent = text;
    this.note.classList.toggle('warn', warn && !!text);
  }

  // ------------------------------------------------------------- rebinding

  _startListening(action, btn) {
    this._stopListening();
    this.listening = action;
    this.listeningBtn = btn;
    btn.classList.add('listening');
    btn.textContent = 'PRESS ANY';
    this._say('Press a key or mouse button, or ESC to cancel.');
  }

  _stopListening() {
    if (this.listeningBtn) {
      this.listeningBtn.classList.remove('listening');
      this.listeningBtn = null;
    }
    this.listening = null;
  }

  _capture(code) {
    const action = this.listening;
    if (code === 'Escape') { this._stopListening(); this._build(); this._say('Cancelled.'); return; }
    if (isReserved(code)) {
      this._say(`${keyLabel(code)} is reserved by the browser — pick another.`, true);
      return;
    }
    const displaced = actionFor(code);
    const res = setBinding(action, code);
    this._stopListening();
    if (!res.ok) { this._build(); this._say('That key cannot be used.', true); return; }
    // _build() is driven by the change listener; only the message is left.
    if (displaced && displaced !== action) {
      const name = ACTIONS.find((a) => a.id === displaced)?.label ?? displaced;
      this._say(`${keyLabel(code)} taken from "${name}", which is now unbound.`, true);
    } else {
      this._say(`Bound to ${keyLabel(code)}.`);
    }
  }

  // ----------------------------------------------------------------- render

  _build() {
    this.list.textContent = '';
    let group = null;

    for (const a of ACTIONS) {
      if (a.group !== group) {
        group = a.group;
        const h = document.createElement('div');
        h.className = 'bind-group';
        h.textContent = group;
        this.list.appendChild(h);
      }

      const row = document.createElement('div');
      row.className = 'bind-row';

      const lbl = document.createElement('div');
      lbl.className = 'lbl';
      lbl.textContent = a.label;

      const code = key(a.id);
      const btn = document.createElement('button');
      btn.className = 'bind-key' + (code ? '' : ' unbound');
      btn.textContent = code ? keyLabel(code) : 'UNBOUND';
      btn.title = code || 'not bound';
      btn.addEventListener('click', () => this._startListening(a.id, btn));

      row.append(lbl, btn);
      this.list.appendChild(row);
    }

    const h = document.createElement('div');
    h.className = 'bind-group';
    h.textContent = 'FIXED';
    this.list.appendChild(h);
    for (const [label, desc] of FIXED) {
      const row = document.createElement('div');
      row.className = 'bind-row fixed';
      const lbl = document.createElement('div');
      lbl.className = 'lbl';
      lbl.textContent = desc;
      const btn = document.createElement('div');
      btn.className = 'bind-key';
      btn.textContent = label;
      row.append(lbl, btn);
      this.list.appendChild(row);
    }
  }
}
