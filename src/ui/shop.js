// The between-wave shop.
//
// Kills pay coins into a pot the whole party shares, and the wave break is when
// that pot turns into decisions. The point of the shop is that it makes a run a
// series of choices rather than a single difficulty curve: spend on upgrades now
// and be thin on ammo, or stay stocked and stay weak.
//
// Two rules shape the catalogue:
//
//   Upgrades are per weapon, not global. Sinking coins into the rifle should
//   mean the rifle is your answer for the rest of the run -- that is the
//   commitment which makes the choice interesting.
//
//   Consumables never stop being worth buying. Ammo and health scale in price
//   with the wave, so late in a run the pot is under real pressure and buying
//   a fourth damage tier genuinely costs you the medkit.
//
// In co-op the pot is shared and the server is the one that deducts, so a
// purchase is a request: the effect only lands once the server confirms it.
// Two players spending the last 400 coins at the same instant is a race the
// server settles, and the loser is told rather than silently overdrawn.

import { actionLabel } from '../engine/bindings.js';
import { installCommunityFeedbackFixes } from '../game/community-feedback.js';

// Loaded through the shop because it is already part of every gameplay boot.
// The installer is idempotent, so hot reloads/tests can import it safely too.
installCommunityFeedbackFixes();

/** Upgrade ceilings. Low enough that maxing one weapon is a real decision. */
export const MAX_DAMAGE = 5;
export const MAX_RATE = 5;
export const MAX_MAG = 4;
export const MAX_VITALITY = 4;

/**
 * The catalogue.
 *
 * `cost` is a function of the game so prices can scale with the wave, and
 * `available` hides anything already maxed rather than showing a dead button.
 */
export const ITEMS = [
  {
    id: 'ammo',
    name: 'AMMO CRATE',
    blurb: 'Refill every reserve you carry',
    cost: (g) => 180 + g.wave * 25,
    available: () => true,
    apply: (g) => {
      g.weapons.addAmmo(1);
      g.hud.addFeed('RESERVES REFILLED', '#6fe08a');
    },
  },
  {
    id: 'medkit',
    name: 'MEDKIT',
    blurb: 'Back to full health',
    cost: (g) => 200 + g.wave * 30,
    available: (g) => g.player.health < g.player.maxHealth,
    apply: (g) => {
      g.player.health = g.player.maxHealth;
      g.player.regenDelay = 0;
      g.hud.addFeed('PATCHED UP', '#6fe08a');
    },
  },
  {
    id: 'potion',
    name: 'MYSTERY BREW',
    blurb: 'One random perk, drunk immediately',
    cost: () => 450,
    available: () => true,
    apply: (g) => {
      const def = g.randomPotionDef();
      g.potions.apply(def);
      g.audio.drink();
      g.hud.addFeed(`${def.name} — ${def.blurb ?? 'active'}`, '#ffd070');
    },
  },
  {
    id: 'vitality',
    name: 'VITALITY',
    blurb: '+25 maximum health',
    cost: (g) => 600 + g.vitality * 350,
    available: (g) => g.vitality < MAX_VITALITY,
    level: (g) => `${g.vitality}/${MAX_VITALITY}`,
    apply: (g) => {
      g.vitality += 1;
      g.player.maxHealth += 25;
      g.player.health += 25;
      g.hud.addFeed(`MAX HEALTH ${g.player.maxHealth}`, '#6fe08a');
    },
  },
  {
    id: 'damage',
    name: 'HEAVY ROUNDS',
    blurb: '+15% damage, this weapon only',
    cost: (g) => 500 + g.weapons.current.upgrades.damage * 400,
    available: (g) => g.weapons.current.upgrades.damage < MAX_DAMAGE,
    level: (g) => `${g.weapons.current.upgrades.damage}/${MAX_DAMAGE}`,
    weaponScoped: true,
    apply: (g) => {
      const w = g.weapons.current;
      w.upgrades.damage += 1;
      g.hud.addFeed(`${w.def.name} DAMAGE ${w.upgrades.damage}/${MAX_DAMAGE}`, '#ff8a3d');
    },
  },
  {
    id: 'rate',
    name: 'TUNED ACTION',
    blurb: '+12% fire rate, this weapon only',
    cost: (g) => 450 + g.weapons.current.upgrades.rate * 350,
    available: (g) => g.weapons.current.upgrades.rate < MAX_RATE,
    level: (g) => `${g.weapons.current.upgrades.rate}/${MAX_RATE}`,
    weaponScoped: true,
    apply: (g) => {
      const w = g.weapons.current;
      w.upgrades.rate += 1;
      g.hud.addFeed(`${w.def.name} FIRE RATE ${w.upgrades.rate}/${MAX_RATE}`, '#ffcf4d');
    },
  },
  {
    id: 'mag',
    name: 'EXTENDED MAG',
    blurb: '+25% magazine, this weapon only',
    cost: (g) => 400 + g.weapons.current.upgrades.mag * 300,
    available: (g) => g.weapons.current.upgrades.mag < MAX_MAG,
    level: (g) => `${g.weapons.current.upgrades.mag}/${MAX_MAG}`,
    weaponScoped: true,
    apply: (g) => {
      const w = g.weapons.current;
      w.upgrades.mag += 1;
      w.reserve += w.magStep * 2;
      g.hud.addFeed(`${w.def.name} MAG ${w.magSize}`, '#4db6ff');
    },
  },
  {
    id: 'bazooka',
    name: 'BAZOOKA',
    blurb: 'Rockets, with splash',
    cost: () => 1200,
    available: (g) => !g.weapons.weapons.find((w) => w.def.id === 'bazooka').owned,
    apply: (g) => {
      g.weapons.pickUp('bazooka');
      g.hud.addFeed('BAZOOKA ACQUIRED', '#ffcf4d');
    },
  },
  {
    id: 'airstrike',
    name: 'AIRSTRIKE BEACON',
    blurb: 'Call down a bombing run',
    cost: () => 2200,
    available: (g) => !g.weapons.weapons.find((w) => w.def.id === 'airstrike').owned,
    apply: (g) => {
      g.weapons.pickUp('airstrike');
      g.hud.addFeed('AIRSTRIKE ACQUIRED', '#ff8a3d');
    },
  },
];

export const ITEM_BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));

export class Shop {
  /**
   * @param game the Game, used for both the price inputs and the effects
   */
  constructor(game) {
    this.game = game;
    this.open_ = false;
    this.root = document.getElementById('shop');
    this.list = document.getElementById('shop-items');
    this.coinEl = document.getElementById('shop-coins');
    this.timerEl = document.getElementById('shop-timer');
    this.weaponEl = document.getElementById('shop-weapon');
    this.closeButton = document.getElementById('shop-close');
    this.panel = this.closeButton?.parentElement ?? null;
    this._touchPanelReady = false;

    this.closeButton.addEventListener('click', () => this.close());
    // Escape normally releases pointer lock to pause. The armoury has already
    // released the pointer, so without an explicit path Escape does nothing and
    // a player who misses the B hint can reasonably conclude the menu is stuck.
    window.addEventListener('keydown', (event) => {
      if (!this.open_ || event.code !== 'Escape') return;
      event.preventDefault();
      this.close();
    }, true);
    this._rows = [];
    this._refreshCloseLabel();
  }

  get isOpen() { return this.open_; }

  _refreshCloseLabel() {
    const suffix = this.game.touchMode ? '' : `  [${actionLabel('armoury')} / ESC]`;
    this.closeButton.textContent = `BACK TO THE FIGHT${suffix}`;
  }

  /**
   * The live armoury was moved outside #overlay so it could sit over gameplay,
   * but the touch gesture lock still only exempted #overlay from scroll
   * suppression. On a short landscape phone that made the lower half of this
   * panel -- including BACK TO THE FIGHT -- physically unreachable.
   *
   * Keep the fix local to the scroll container: allow native vertical panning,
   * stop the document-level touchmove blocker before it sees this gesture, and
   * keep the exit control pinned where a thumb can always reach it.
   */
  _setupTouchPanel() {
    if (!this.game.touchMode || this._touchPanelReady || !this.panel) return;
    this._touchPanelReady = true;

    this.panel.style.touchAction = 'pan-y';
    this.panel.style.overscrollBehavior = 'contain';
    this.panel.style.webkitOverflowScrolling = 'touch';
    this.panel.addEventListener('touchmove', (event) => {
      event.stopPropagation();
    }, { passive: true });

    // Put the exit immediately below the header and pin it while the catalogue
    // scrolls. A player never has to discover that the only way out was below
    // the fold.
    if (this.list?.parentElement === this.panel && this.closeButton.parentElement === this.panel) {
      this.panel.insertBefore(this.closeButton, this.list);
    }
    Object.assign(this.closeButton.style, {
      position: 'sticky',
      top: '0',
      zIndex: '5',
      width: '100%',
      marginBottom: '10px',
    });
  }

  open() {
    if (this.open_) return;

    // Wave-clear currently calls open() automatically. That works on desktop,
    // where the pointer/cursor makes a modal shop obvious, but on a phone it
    // abruptly replaces every movement control with a tall panel. Make mobile
    // opt in with the ARM button instead; the existing break HUD already tells
    // the player to tap ARM and the round keeps counting normally until they do.
    const touchRequested = this.game.input?.actionPressed?.('armoury') === true;
    if (this.game.touchMode && !touchRequested) {
      this.game.hud?.addFeed?.('TAP ARM — ARMOURY OPEN DURING BREAK', '#ffd070');
      return;
    }

    this._setupTouchPanel();
    this.open_ = true;
    this.root.classList.remove('hidden');
    if (this.panel) this.panel.scrollTop = 0;
    this.game.input.exitLock();
    this._refreshCloseLabel();
    this._build();
  }

  close() {
    // Hide from the DOM even if a missed event ever desynchronised open_ from
    // the CSS class. A close action should be idempotent, not another trap.
    const wasVisible = !this.root.classList.contains('hidden');
    const wasOpen = this.open_;
    this.open_ = false;
    this.root.classList.add('hidden');

    // Single-player deliberately holds the intermission while shopping. Clear
    // that hold immediately instead of waiting for the next rendered frame.
    const sim = this.game.session?.sim;
    if (sim && !this.game.session.multiplayer) sim.holdBreak = false;

    if ((wasOpen || wasVisible) && this.game.state === 'playing') {
      // Touch has no pointer lock to reacquire. Restore its gameplay layer right
      // here, inside the closing tap, rather than waiting for a later frame to
      // make the player wonder whether the button worked.
      if (this.game.touchMode) this.game.touch?.setVisible?.(true);
      this.game.input.requestLock();
    }
  }

  toggle() { this.open_ ? this.close() : this.open(); }

  /** Rebuild the rows. Cheap enough to do on every purchase. */
  _build() {
    const g = this.game;
    this.list.textContent = '';
    this._rows = [];

    for (const item of ITEMS) {
      if (!item.available(g)) continue;

      const cost = item.cost(g);
      const row = document.createElement('button');
      row.className = 'shop-item';

      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'si-name';
      name.textContent = item.level ? `${item.name}  ${item.level(g)}` : item.name;
      const blurb = document.createElement('div');
      blurb.className = 'si-blurb';
      // Weapon-scoped upgrades say which weapon, because the answer changes
      // as soon as the player switches guns and that is easy to forget.
      blurb.textContent = item.weaponScoped
        ? `${item.blurb} (${g.weapons.current.def.name})`
        : item.blurb;
      left.append(name, blurb);

      const price = document.createElement('div');
      price.className = 'si-cost';
      price.textContent = cost;

      row.append(left, price);
      row.addEventListener('click', () => this.game.buy(item.id, cost));
      this.list.appendChild(row);
      this._rows.push({ row, cost });
    }

    // Cosmetics are deliberately absent.
    //
    // This is the between-wave armoury: everything in it is spent from the
    // run's coin pot and consumed by the run. A finish is neither -- it is
    // bought once, kept forever, and worn in every game after this one, so
    // selling it here charged a per-run currency for a permanent thing and let
    // the player restyle their gun in the middle of a firefight. Finishes and
    // skins both live in the menu armoury now, which is the only place either
    // can be bought or changed.

    this._refreshAffordable();
  }

  /** Grey out anything the pot cannot currently cover. */
  _refreshAffordable() {
    const coins = this.game.coins;
    for (const { row, cost } of this._rows) {
      row.classList.toggle('unaffordable', cost > coins);
    }
  }

  /** Called every frame while open. */
  update() {
    if (!this.open_) return;
    const g = this.game;

    // In co-op the server clock keeps moving while this client shops. WAVE_START
    // normally closes us through the event queue; this is a second guard so a
    // delayed/dropped presentation event can never leave an expired shop over a
    // live round.
    if (!g.session?.isFFA && g.waveBreak <= 0) {
      this.close();
      return;
    }

    this.coinEl.textContent = g.coins;
    this.weaponEl.textContent = g.weapons.current.def.name;

    const left = Math.max(0, g.waveBreak);
    const soloHeld = !!g.session?.sim && !g.session.multiplayer && left > 0;
    // In solo the wave clock intentionally pauses while shopping. Calling the
    // frozen number a countdown made a healthy intermission look broken: the
    // player could stare at "NEXT WAVE IN 10s" forever. Say what is actually
    // happening and make the exit controls explicit.
    this.timerEl.textContent = soloHeld
      ? `ROUND PAUSED — ${this.game.touchMode ? 'BACK TO THE FIGHT' : `${actionLabel('armoury')} OR ESC`} TO CONTINUE`
      : left > 0
        ? `NEXT WAVE IN ${left.toFixed(0)}s`
        : 'WAVE INCOMING';

    this._refreshAffordable();
  }

  /** A purchase landed; prices and levels have moved, so rebuild. */
  onPurchase() {
    if (this.open_) this._build();
  }
}
