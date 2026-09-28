// The menu's account row, the sign-in panel, and the shop.
//
// All three read from one ProfileStore and write back through it, so there is
// no second copy of "what the player owns" to fall out of sync. The panels are
// plain DOM built once and re-rendered on change rather than rebuilt, because
// the shop grid is the only list here that can grow.

import { SKINS, SKIN_BY_ID, RARITY, ROLE } from '../game/skins.js';
import { renderSkinPreview } from './skinpreview.js';

/**
 * Which weapons the hero preview offers.
 *
 * Deliberately a short list of silhouettes that read differently from one
 * another -- there is no point offering fifteen when half of them are the same
 * shape at this size.
 */
const PREVIEW_GUNS = ['rifle', 'pistol', 'shotgun', 'sniper'];

/** The card thumbnails are all of one weapon, so a row of them compares. */
const CARD_GUN = 'rifle';
const MIN_PASSWORD_LENGTH = 10;

/**
 * Resolve auth-control availability from the three states that affect it.
 *
 * Kept pure so the feature-flagged account path can be covered without a DOM:
 * the public build normally hides it, which previously allowed the shipped
 * `disabled` attributes to remain in place when accounts were switched on.
 */
export function authControlState(configured, signedIn, busy = false) {
  const available = !!configured && !busy;
  return {
    accountEntryHidden: !configured,
    accountEntryDisabled: !configured,
    signInHidden: !configured || !!signedIn,
    signUpHidden: !configured || !!signedIn,
    signOutHidden: !configured || !signedIn,
    signInDisabled: !available || !!signedIn,
    signUpDisabled: !available || !!signedIn,
    signOutDisabled: !available || !signedIn,
    fieldsDisabled: !available || !!signedIn,
  };
}

/** Hex for the swatch: what the skin does to a receiver and its accent. */
function swatchCss(skin) {
  if (skin.isDefault) {
    return `linear-gradient(135deg, #6a727d 0 50%, #434a54 50% 100%)`;
  }
  const metal = skin.roles?.[ROLE.METAL] ?? ROLE.METAL;
  const accent = skin.roles?.[ROLE.ACCENT] ?? ROLE.ACCENT;
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  return `linear-gradient(135deg, ${hex(metal)} 0 60%, ${hex(accent)} 60% 100%)`;
}

export class AccountUI {
  /**
   * @param store    a ProfileStore
   * @param supabase a Supabase instance, or null when accounts are off
   * @param hooks    { onEquip(skinId), showPanel(name), finishes }
   *
   * `hooks.finishes` is the base-palette cosmetic, kept behind an interface
   * rather than imported: it is owned by a different store from the skins and
   * this panel has no business knowing that. Shape:
   * `{ list(), owns(id), worn(), buy(id), equip(id) }`, where buy and equip
   * return `{ ok, reason }` exactly as the skin store does.
   */
  constructor(store, supabase, hooks = {}) {
    this.store = store;
    this.supabase = supabase;
    this.hooks = hooks;
    this.busy = false;

    this.el = {
      who: document.getElementById('account-who'),
      credits: document.getElementById('credits-num'),
      shopCredits: document.getElementById('shop-credits-num'),

      panelAuth: document.getElementById('panel-auth'),
      panelShop: document.getElementById('panel-shop'),
      authNote: document.getElementById('auth-note'),
      email: document.getElementById('auth-email'),
      password: document.getElementById('auth-password'),
      passwordConfirm: document.getElementById('auth-password-confirm'),
      authMsg: document.getElementById('auth-msg'),
      btnSignIn: document.getElementById('btn-signin'),
      btnSignUp: document.getElementById('btn-signup'),
      btnSignOut: document.getElementById('btn-signout'),

      shopGrid: document.getElementById('shop-grid'),
      tabs: document.getElementById('shop-tabs'),
      heroShot: document.getElementById('hero-shot'),
      heroGuns: document.getElementById('hero-guns'),
      heroName: document.getElementById('hero-name'),
      heroRar: document.getElementById('hero-rar'),
      heroBlurb: document.getElementById('hero-blurb'),
      heroPrice: document.getElementById('hero-price'),
      heroAct: document.getElementById('hero-act'),
      heroNote: document.getElementById('hero-note'),
      shopMsg: document.getElementById('shop-msg'),
      btnAccount: document.getElementById('btn-account'),
    };

    this._wire();
    this._buildShop();
    this.refresh();
  }

  _wire() {
    this.el.btnSignIn.addEventListener('click', () => this._submit('signIn'));
    this.el.btnSignUp.addEventListener('click', () => this._submit('signUp'));
    this.el.btnSignOut.addEventListener('click', () => this._signOut());

    // Enter submits, because a form that needs a mouse is a form people abandon.
    for (const f of [this.el.email, this.el.password]) {
      f.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this._submit('signIn'); }
        e.stopPropagation();       // keep WASD out of the game while typing
      });
    }
    this.el.passwordConfirm.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this._submit('signUp'); }
      e.stopPropagation();
    });
  }

  // ------------------------------------------------------------------- render

  /** Re-read the store and repaint everything that shows profile state. */
  refresh() {
    const p = this.store.data;
    this.el.credits.textContent = p.credits.toLocaleString();
    this.el.shopCredits.textContent = p.credits.toLocaleString();

    const signedIn = !this.store.isGuest;
    this.el.who.innerHTML = signedIn
      ? `SIGNED IN AS <b>${escapeHtml(shortEmail(this.store.email))}</b>`
      : 'PLAYING AS <b>GUEST</b>';
    this.el.btnAccount.textContent = signedIn ? 'ACCOUNT' : 'SIGN IN';

    // Accounts need a configured project. Saying so plainly beats offering a
    // button that fails with a network error.
    const usable = !!this.supabase?.configured;
    if (!usable) {
      this.el.authNote.innerHTML =
        'Accounts are not configured for this build, so progress saves to this '
        + 'browser only. Add a Supabase URL and anon key in '
        + '<b>src/net/config.js</b> to enable sign-in.';
    } else if (signedIn) {
      this.el.authNote.textContent =
        'Your credits and skins are saved to your account and follow you to any device.';
    } else {
      // Restore the signed-out copy after a sign-out. Without this branch the
      // panel kept claiming the account was synchronised after it became a
      // browser-only guest again.
      this.el.authNote.textContent =
        'Sign in to carry your credits and skins between devices. Playing as a '
        + 'guest saves to this browser only.';
    }
    this._syncAuthControls();

    if (this.store.error) this._msg(this.el.authMsg, this.store.error, 'err');
    this._renderShop();
  }

  // --------------------------------------------------------------------- auth

  async _submit(method) {
    const email = this.el.email.value.trim();
    const password = this.el.password.value;
    if (!email || !password) {
      return this._msg(this.el.authMsg, 'EMAIL AND PASSWORD REQUIRED', 'err');
    }
    if (method === 'signUp' && password.length < MIN_PASSWORD_LENGTH) {
      return this._msg(
        this.el.authMsg, `PASSWORD MUST BE ${MIN_PASSWORD_LENGTH}+ CHARACTERS`, 'err');
    }
    if (method === 'signUp' && (!/[A-Za-z]/.test(password) || !/\d/.test(password))) {
      return this._msg(this.el.authMsg, 'PASSWORD NEEDS A LETTER AND A NUMBER', 'err');
    }
    if (method === 'signUp' && password !== this.el.passwordConfirm.value) {
      return this._msg(this.el.authMsg, 'PASSWORDS DO NOT MATCH', 'err');
    }

    this._busy(true);
    this._msg(this.el.authMsg, method === 'signUp' ? 'CREATING…' : 'SIGNING IN…');
    try {
      const res = await this.supabase[method](email, password);
      if (method === 'signUp' && res.needsConfirmation) {
        this._msg(this.el.authMsg, 'CHECK YOUR EMAIL, CONFIRM, THEN SIGN IN', 'ok');
        return;
      }
      // Guest progress is merged in rather than replaced.
      await this.store.onSignIn();
      this.el.password.value = '';
      this.el.passwordConfirm.value = '';
      this._msg(this.el.authMsg, 'SIGNED IN', 'ok');
      this.refresh();
    } catch (err) {
      this._msg(this.el.authMsg, String(err.message ?? err).toUpperCase(), 'err');
    } finally {
      this._busy(false);
    }
  }

  async _signOut() {
    this._busy(true);
    try {
      await this.supabase.signOut();
      this.store.onSignOut();
      this._msg(this.el.authMsg, 'SIGNED OUT', 'ok');
      this.refresh();
    } finally {
      this._busy(false);
    }
  }

  _busy(on) {
    this.busy = !!on;
    this._syncAuthControls();
  }

  _syncAuthControls() {
    const state = authControlState(
      this.supabase?.configured,
      !this.store.isGuest,
      this.busy,
    );
    // The public guest-only markup fails closed with both the HTML `hidden`
    // attribute and the CSS class. Clear/set both when a configured account
    // build is actually running; changing only classList left the controls
    // permanently suppressed by the attribute.
    this.el.btnAccount.hidden = state.accountEntryHidden;
    this.el.btnAccount.disabled = state.accountEntryDisabled;
    this.el.btnSignIn.hidden = state.signInHidden;
    this.el.btnSignUp.hidden = state.signUpHidden;
    this.el.btnSignOut.hidden = state.signOutHidden;
    this.el.btnSignIn.classList.toggle('hidden', state.signInHidden);
    this.el.btnSignUp.classList.toggle('hidden', state.signUpHidden);
    this.el.btnSignOut.classList.toggle('hidden', state.signOutHidden);
    this.el.btnSignIn.disabled = state.signInDisabled;
    this.el.btnSignUp.disabled = state.signUpDisabled;
    this.el.btnSignOut.disabled = state.signOutDisabled;
    this.el.email.disabled = state.fieldsDisabled;
    this.el.password.disabled = state.fieldsDisabled;
    this.el.passwordConfirm.disabled = state.fieldsDisabled;
  }

  // --------------------------------------------------------------------- shop
  //
  // Three cosmetic systems share one panel, and they used to share it as three
  // stacked grids: twenty-four cards down a single scroll, each with its own
  // nested scrollbar, and no way to tell at a glance which list you were in or
  // what any of it looked like on a gun. It is a tab, a big picture, and one
  // button now.
  //
  // Everything below works on ONE item shape, whether the entry is a skin or
  // a base finish.

  /** The tabs, and the items in each, in one shape. */
  _sections() {
    const p = this.store.data;
    const fin = this.hooks.finishes;
    const out = [];

    out.push({
      id: 'skins',
      label: 'SKINS',
      items: SKINS.map((skin) => ({
        id: skin.id,
        name: skin.name,
        blurb: skin.blurb ?? 'A repaint of every weapon you carry.',
        rarity: RARITY[skin.rarity]?.label ?? '',
        color: RARITY[skin.rarity]?.color ?? '#9aa6b2',
        owned: this.store.owns(skin.id),
        equipped: p.equippedSkin === skin.id,
        price: skin.price,
        priceLabel: skin.price ? `${skin.price.toLocaleString()} CR` : 'FREE',
        affordable: p.credits >= skin.price,
        swatch: swatchCss(skin),
        shoot: (gun) => renderSkinPreview(skin, gun),
        act: () => (this.store.owns(skin.id)
          ? this.store.equip(skin.id) : this.store.buy(skin.id)),
      })),
    });

    if (fin) {
      out.push({
        id: 'finishes',
        label: 'FINISHES',
        items: fin.list().map((f) => ({
          id: f.id,
          name: f.name,
          blurb: 'The palette every weapon is built from. A skin paints over it.',
          rarity: 'FINISH',
          color: '#9aa6b2',
          owned: fin.owns(f.id),
          equipped: fin.worn() === f.id,
          price: f.cost,
          priceLabel: f.cost ? `${f.cost.toLocaleString()} CR` : 'FREE',
          affordable: p.credits >= f.cost,
          swatch: `linear-gradient(135deg, ${f.metal} 0 60%, ${f.accent} 60% 100%)`,
          // A finish is a palette rather than a texture, so what gets
          // photographed is the player's own skin over this finish -- the
          // question being asked is "what would I be holding", not "what
          // colour is this".
          shoot: (gun) => fin.shoot?.(f.id, gun),
          act: () => (fin.owns(f.id) ? fin.equip(f.id) : fin.buy(f.id)),
        })),
      });
    }

    return out;
  }

  _buildShop() {
    this.tab = this.tab ?? 'skins';
    this.gun = this.gun ?? 'rifle';
    this.picked = this.picked ?? {};

    this.el.tabs.innerHTML = '';
    this.tabButtons = new Map();
    for (const sec of this._sections()) {
      const b = document.createElement('button');
      b.className = 'shop-tab';
      b.innerHTML = `${sec.label}<span class="n"></span>`;
      b.addEventListener('click', () => { this.tab = sec.id; this._buildGrid(); this.refresh(); });
      this.el.tabs.appendChild(b);
      this.tabButtons.set(sec.id, b);
    }

    // Which gun the preview is of. A skin has to be judged on the weapon you
    // actually carry, and the answer is different for everyone.
    this.el.heroGuns.innerHTML = '';
    this.gunButtons = new Map();
    for (const gun of PREVIEW_GUNS) {
      const b = document.createElement('button');
      b.className = 'hero-gun';
      b.textContent = gun.toUpperCase();
      b.addEventListener('click', () => { this.gun = gun; this._renderHero(); });
      this.el.heroGuns.appendChild(b);
      this.gunButtons.set(gun, b);
    }

    this.el.heroAct.addEventListener('click', () => this._act());
    this._buildGrid();
  }

  /** The cards for the open tab. Rebuilt on a tab change, not on every render. */
  _buildGrid() {
    const sec = this._sections().find((x) => x.id === this.tab);
    this.el.shopGrid.innerHTML = '';
    this.cards = new Map();
    if (!sec) return;

    for (const item of sec.items) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'skin';
      card.style.setProperty('--rar', item.color);
      card.setAttribute('aria-label', `${item.name}${item.owned ? '' : ', locked'}`);

      const sw = document.createElement('div');
      sw.className = 'swatch';
      const shot = item.shoot?.(CARD_GUN);
      if (shot) { sw.classList.add('shot'); sw.style.backgroundImage = `url(${shot})`; }
      else sw.style.background = item.swatch ?? '#2b3036';
      card.appendChild(sw);

      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = item.name;
      card.appendChild(nm);

      const tag = document.createElement('div');
      tag.className = 'tag';
      card.appendChild(tag);

      card.addEventListener('click', () => {
        this.picked[this.tab] = item.id;
        this.refresh();
      });
      this.el.shopGrid.appendChild(card);
      this.cards.set(item.id, { card, tag });
    }

    // Land on something rather than an empty hero: what is worn, else the first.
    if (!this.picked[this.tab] || !this.cards.has(this.picked[this.tab])) {
      this.picked[this.tab] = (sec.items.find((i) => i.equipped) ?? sec.items[0])?.id;
    }
  }

  _renderShop() {
    if (!this.cards) return;
    const sections = this._sections();

    for (const sec of sections) {
      const b = this.tabButtons.get(sec.id);
      if (!b) continue;
      b.classList.toggle('on', sec.id === this.tab);
      const owned = sec.items.filter((i) => i.owned).length;
      b.querySelector('.n').textContent = `${owned}/${sec.items.length}`;
    }

    const sec = sections.find((x) => x.id === this.tab);
    if (!sec) return;
    for (const item of sec.items) {
      const entry = this.cards.get(item.id);
      if (!entry) continue;
      entry.card.classList.toggle('equipped', item.equipped);
      entry.card.classList.toggle('locked', !item.owned);
      entry.card.classList.toggle('sel', this.picked[this.tab] === item.id);
      entry.card.setAttribute('aria-pressed', String(this.picked[this.tab] === item.id));
      entry.tag.textContent = item.equipped ? '★' : (item.owned ? '' : '🔒');
    }
    this._renderHero();
  }

  /** The big picture, and the one button that acts on it. */
  _renderHero() {
    const sec = this._sections().find((x) => x.id === this.tab);
    const item = sec?.items.find((i) => i.id === this.picked[this.tab]);
    if (!item) return;

    for (const [gun, b] of this.gunButtons) b.classList.toggle('on', gun === this.gun);

    const shot = item.shoot?.(this.gun) ?? this.hooks.finishes?.shoot?.(item.id, this.gun);
    this.el.heroShot.style.backgroundImage = shot ? `url(${shot})` : 'none';
    this.el.heroShot.style.background = shot ? undefined : (item.swatch ?? 'none');

    this.el.heroName.textContent = item.name;
    this.el.heroRar.textContent = item.rarity;
    this.el.heroRar.style.color = item.color;
    this.el.heroBlurb.textContent = item.blurb;
    this.el.heroNote.textContent = item.note ?? '';

    const price = this.el.heroPrice;
    price.className = 'hero-price'
      + (item.owned ? ' owned' : (item.affordable ? '' : ' poor'));
    // Not "EQUIPPED" -- the button beside it already says that, and saying it
    // twice reads as a bug.
    price.textContent = item.owned ? 'OWNED' : item.priceLabel;

    const act = this.el.heroAct;
    act.textContent = item.equipped ? 'EQUIPPED'
      : item.owned ? 'EQUIP'
      : 'BUY';
    act.disabled = item.equipped || (!item.owned && !item.affordable);
  }

  /** Buy or equip whatever the hero is showing. */
  async _act() {
    const sec = this._sections().find((x) => x.id === this.tab);
    const item = sec?.items.find((i) => i.id === this.picked[this.tab]);
    if (!item) return;

    const owned = item.owned;
    const res = await item.act();
    this._msg(this.el.shopMsg,
      res?.ok ? `${owned ? 'EQUIPPED' : 'UNLOCKED'} ${item.name}` : (res?.reason ?? 'NO'),
      res?.ok ? 'ok' : 'err');
    if (res?.ok) this.hooks.onEquip?.(this.store.data.equippedSkin);
    this.refresh();
  }

  _msg(el, text, kind = '') {
    el.textContent = text;
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }
}

function shortEmail(email) {
  if (!email) return 'PLAYER';
  const [name] = email.split('@');
  return name.length > 14 ? name.slice(0, 13) + '…' : name;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
