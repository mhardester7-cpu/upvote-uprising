// HUD. Everything here is DOM -- overlaying text on a canvas is more legible
// and far cheaper than drawing it in WebGL.
//
// Values are cached before writing so a 60fps loop does not thrash layout with
// identical assignments.

import { ctrl, pressWord } from '../engine/touch.js';
import { tierOf } from '../combat/weapons.js';

const $ = (id) => document.getElementById(id);

/**
 * Key labels reach innerHTML, and a rebind can put any character in one --
 * including the angle brackets sitting next to the bracket keys the late
 * weapon slots use by default.
 */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export class HUD {
  constructor() {
    this.el = {
      root: $('hud'),
      hpNum: $('hp-num'),
      hpFill: $('hp-fill'),
      ammoNum: $('ammo-num'),
      ammoName: $('ammo-name'),
      reloadHint: $('reload-hint'),
      weapons: $('weapons'),
      crosshair: $('crosshair'),
      hitmarker: $('hitmarker'),
      damage: $('damage'),
      lowhp: $('lowhp'),
      score: $('score-num'),
      coins: $('coin-num'),
      bossbar: $('bossbar'),
      bossName: $('boss-name'),
      bossFill: $('boss-fill'),
      waveNum: $('wave-num'),
      waveSub: $('wave-sub'),
      feed: $('feed'),
      announce: $('announce'),
      trackers: $('trackers'),
      scope: $('scope'),
      bsight: $('bsight'),
      holo: $('holo'),
      reddot: $('reddot'),
      laserdot: $('laserdot'),
      thermal: $('thermal'),
      gems: $('gems'),
      snapHint: $('snap-hint'),
      chestmarks: $('chestmarks'),
      downmarks: $('downmarks'),
      revive: $('revive'),
      rvTitle: $('rv-title'),
      rvSub: $('rv-sub'),
      rvFill: $('rv-fill'),
      roomtag: $('roomtag'),
      roomtagCode: $('roomtag-code'),
      roomtagPlayers: $('roomtag-players'),
      ffa: $('ffa'),
      ffaRows: $('ffa-rows'),
      ffaTarget: $('ffa-target'),
      prompt: $('prompt'),
      effects: $('effects'),
      waypoint: $('waypoint'),
      wpArrow: $('wp-arrow'),
      wpLabel: $('wp-label'),
      streak: $('streak'),
      streakCount: $('streak-count'),
      streakName: $('streak-name'),
      streakFill: $('streak-fill'),
      streakBuffs: $('streak-buffs'),
      travel: $('travelhud'),
    };
    this.trackerEls = [];
    this.chestEls = [];
    this.downEls = [];
    this.fxEls = [];

    this._cache = {};
    this.hitmarkerTimer = 0;
    this.damageTimer = 0;
    this.announceTimer = 0;
    this.feedItems = [];
  }

  show() { this.el.root.classList.remove('hidden'); }
  hide() { this.el.root.classList.add('hidden'); }

  _set(key, value, apply) {
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    apply(value);
  }

  /**
   * The carried weapons, each against the key that draws it.
   *
   * The label is the bound key rather than the slot number: past slot 10 the
   * two stop matching, and a list that says "13" next to a gun you draw with
   * "[" is worse than no hint at all.
   */
  buildWeaponList(weapons, activeIndex) {
    const labels = weapons.map((w) => ctrl('slot' + w.slot));
    const key = weapons.map((w) => w.def.id).join(',') + '|' + activeIndex
      + '|' + labels.join(',');
    this._set('weplist', key, () => {
      this.el.weapons.innerHTML = weapons.map((w, i) =>
        `<div class="wep${i === activeIndex ? ' active' : ''}">` +
        `<span class="slot">${escapeHtml(labels[i])}</span>${w.def.name}</div>`
      ).join('');
    });
  }

  setHealth(hp, max) {
    const rounded = Math.max(0, Math.ceil(hp));
    this._set('hp', rounded, (v) => { this.el.hpNum.textContent = v; });
    const pct = Math.max(0, Math.min(1, hp / max));
    this._set('hpfill', Math.round(pct * 100), (v) => {
      this.el.hpFill.style.width = v + '%';
      this.el.hpFill.style.background = v > 60 ? '#6fe08a' : v > 30 ? '#ffcf4d' : '#ff5a4d';
    });
    this.el.lowhp.style.opacity = pct < 0.35 ? (0.35 - pct) / 0.35 * 0.9 : 0;
  }

  setAmmo(weapon, reloading) {
    const def = weapon.def;
    const tier = tierOf(def);
    this._set('ammoname', `${def.name}|${tier.id}`, () => {
      this.el.ammoName.textContent = def.name;
      // Every weapon is named in its rarity's colour, not just the top rung --
      // which is what makes the tier readable while you are holding the gun.
      this.el.ammoName.className = `tier-${tier.id}`;
    });

    // Melee has no magazine, so it shows a swing glyph instead of 1 / 0, which
    // would read as "almost out of pickaxe".
    const key = def.noAmmo ? 'melee' : `${weapon.ammo}/${weapon.reserve}`;
    this._set('ammo', key, () => {
      this.el.ammoNum.innerHTML = def.noAmmo
        ? '<small>MELEE</small>'
        : `${weapon.ammo}<small> / ${weapon.reserve}</small>`;
      this.el.ammoNum.classList.toggle('empty', !def.noAmmo && weapon.ammo === 0);
    });

    let hint = '';
    let blink = false;
    if (def.noAmmo) hint = '';
    else if (reloading) hint = 'RELOADING';
    else if (weapon.ammo === 0 && weapon.reserve === 0) hint = 'NO AMMO';
    else if (weapon.ammo === 0) { hint = `${pressWord()} ${ctrl('reload')}`; blink = true; }
    else if (weapon.ammo <= weapon.magSize * 0.25) { hint = 'LOW AMMO'; blink = true; }
    this._set('hint', hint + blink, () => {
      this.el.reloadHint.textContent = hint;
      this.el.reloadHint.classList.toggle('blink', blink);
    });
  }

  /**
   * Open the crosshair to match the current cone.
   * Converts the spread half-angle into screen pixels using the projection,
   * so what you see is literally where bullets can go.
   */
  setSpread(halfAngle, fovRad, viewportHeight) {
    const px = Math.tan(halfAngle) / Math.tan(fovRad / 2) * (viewportHeight / 2);
    const gap = Math.max(3, Math.min(90, px));
    this._set('gap', Math.round(gap), (v) => {
      this.el.crosshair.style.setProperty('--gap', v + 'px');
    });
  }

  /**
   * Show a pointer per remaining enemy so the last stragglers of a wave can
   * actually be found. On-screen enemies get a chevron above them; off-screen
   * ones get an arrow pinned to the edge of the view, rotated to point at them.
   *
   * @param marks [{x, y, angle, dist, edge}] in screen pixels
   */
  setTrackers(marks) {
    // Grow the element pool on demand; never shrink it, just hide the extras.
    while (this.trackerEls.length < marks.length) {
      const el = document.createElement('div');
      el.className = 'trk';
      el.innerHTML = '<div class="arrow"></div><div class="dist"></div>';
      this.el.trackers.appendChild(el);
      this.trackerEls.push(el);
    }
    for (let i = 0; i < this.trackerEls.length; i++) {
      const el = this.trackerEls[i];
      const m = marks[i];
      if (!m) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.className = 'trk ' + (m.edge ? 'edge' : 'onscreen');
      el.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px) rotate(${m.angle.toFixed(3)}rad)`;
      if (!m.edge) {
        const dist = el.querySelector('.dist');
        dist.textContent = `${Math.round(m.dist)}m`;
        // Counter-rotate the label out of the parent's rotation. The whole marker
        // spins so the arrow can point at the target, and an on-screen chevron
        // points *down* -- a half turn -- which was rendering every distance the
        // player could actually see upside down.
        dist.style.transform = `translateX(-50%) rotate(${(-m.angle).toFixed(3)}rad)`;
      }
    }
  }

  /**
   * Drive the sight overlays from the aim-down-sights ramp (0..1).
   *
   * Exactly one overlay is ever lit; the rest are held at zero rather than
   * hidden, so switching weapons mid-aim cross-fades instead of popping.
   *
   * @param sight 'iron' | 'scope' | 'bazooka' | 'holo' | 'reddot' | 'laser'
   *   | 'thermal' -- which overlay this weapon's optic uses
   * @param variant optional overlay skin, e.g. the laser rifle's cyan holo
   */
  setAds(t, sight, variant = '') {
    this._set('ads', `${sight}|${variant}|${Math.round(t * 20)}`, () => {
      const lit = {
        scope: this.el.scope,
        bazooka: this.el.bsight,
        thermal: this.el.thermal,
      };
      for (const [kind, el] of Object.entries(lit)) {
        if (!el) continue;
        const on = sight === kind ? t : 0;
        el.style.opacity = String(on);
        // Stop painting entirely at zero. opacity:0 still composites, and the
        // thermal carries a full-screen backdrop-filter -- a real per-frame GPU
        // cost that would otherwise be paid on every frame of every weapon that
        // is not the railgun. visibility flips only at the ends of the ramp, so
        // the cross-fade is untouched.
        el.style.visibility = on > 0 ? 'visible' : 'hidden';
      }
      // Some optics come in more than one colour -- the laser rifle runs a cyan
      // holo where the SMG runs green.
      if (this.el.holo) this.el.holo.classList.toggle('cyan', variant === 'cyan');

      // ADS uses the weapon model's real sight picture, or a true scoped HUD
      // view for magnified optics. The normal hip-fire crosshair must not stay
      // painted over either one.
      this.el.crosshair.style.opacity = String(Math.max(0, 1 - t * 2.2));
    });
  }

  /**
   * The free-for-all scoreboard, sorted by kills.
   *
   * @param rows [{name, kills, alive, respawn, me}] -- already resolved by the
   *   caller, because the HUD has no business knowing what a session is
   * @param target kills needed to win, or 0 to hide the board entirely
   */
  setFFA(rows, target) {
    const on = target > 0;
    this._set('ffaon', on, () => this.el.ffa.classList.toggle('hidden', !on));
    if (!on) return;

    this._set('ffatarget', target, (v) => { this.el.ffaTarget.textContent = v; });
    const sorted = rows.slice().sort((a, b) => b.kills - a.kills);
    // A dead player's row counts them back in, so you know how long you have
    // before they are a problem again.
    const key = sorted.map((r) =>
      `${r.name}:${r.kills}:${r.alive ? 1 : 0}:${Math.ceil(r.respawn || 0)}`).join('|');
    this._set('ffarows', key, () => {
      this.el.ffaRows.textContent = '';
      for (const r of sorted) {
        const div = document.createElement('div');
        div.className = 'ffa-row' + (r.me ? ' me' : '') + (r.alive ? '' : ' dead');
        const name = document.createElement('span');
        name.textContent = r.alive ? r.name : `${r.name} (${Math.ceil(r.respawn || 0)}s)`;
        const kills = document.createElement('span');
        kills.className = 'k';
        kills.textContent = r.kills;
        div.append(name, kills);
        this.el.ffaRows.appendChild(div);
      }
    });
  }

  /** Kill streak counter, decay meter and the buffs it is currently granting. */
  setStreak(streak) {
    const on = streak.count > 0;
    this._set('streakon', on + '|' + streak.frozen, () => {
      this.el.streak.classList.toggle('on', on);
      this.el.streak.classList.toggle('frozen', streak.frozen);
    });
    if (!on) return;

    const tier = streak.tier;
    this._set('streakn', streak.count + '|' + tier.name, () => {
      this.el.streakCount.textContent = 'x' + streak.count;
      this.el.streakName.textContent = streak.frozen ? `${tier.name} — HELD`.trim() : tier.name;
      this.el.streak.style.setProperty('--sc', tier.color);

      const parts = [];
      if (tier.damage > 1) parts.push(`DMG +${Math.round((tier.damage - 1) * 100)}%`);
      if (tier.fireRate > 1) parts.push(`ROF +${Math.round((tier.fireRate - 1) * 100)}%`);
      if (tier.speed > 1) parts.push(`SPD +${Math.round((tier.speed - 1) * 100)}%`);
      this.el.streakBuffs.innerHTML = parts.join('<br>');
    });

    // The meter animates every frame, so it bypasses the cache.
    this.el.streakFill.style.width = (streak.fraction * 100).toFixed(1) + '%';
  }

  /** Build the five gem slots once, in stone order. */
  buildGems(stoneDefs) {
    this.el.gems.innerHTML = stoneDefs.map((s) =>
      `<div class="gem" data-id="${s.id}" style="--c:#${s.color.toString(16).padStart(6, '0')}"></div>`
    ).join('');
  }

  /**
   * @param collected Set of collected stone ids
   * @param state 'armed' (usable now), 'ready' (all five, but not hurt enough)
   *              or '' (still collecting)
   */
  setGauntlet(collected, state) {
    this._set('gems', [...collected].sort().join(','), () => {
      for (const el of this.el.gems.children) {
        el.classList.toggle('on', collected.has(el.dataset.id));
      }
    });

    const text = state === 'armed' ? `${pressWord()} ${ctrl('snap')} TO SNAP`
      : state === 'ready' ? 'GAUNTLET READY — BELOW 50% HP'
      : collected.size > 0 ? `INFINITY STONES ${collected.size}/5` : '';
    this._set('snaphint', text, () => {
      this.el.snapHint.textContent = text;
      this.el.snapHint.classList.toggle('ready', state === 'armed');
    });
  }

  /**
   * Diamonds over the nearest unopened chests.
   *
   * Without these a chest is effectively invisible: the arena is 160 blocks
   * across, fog closes in at 85, and there are only a handful of them.
   *
   * @param marks [{x, y, dist}] in screen pixels
   */
  setChestMarks(marks) {
    while (this.chestEls.length < marks.length) {
      const el = document.createElement('div');
      el.className = 'cmk';
      el.innerHTML = '<div class="box"></div><div class="d"></div>';
      this.el.chestmarks.appendChild(el);
      this.chestEls.push({ el, dist: el.querySelector('.d') });
    }
    for (let i = 0; i < this.chestEls.length; i++) {
      const node = this.chestEls[i];
      const m = marks[i];
      if (!m) { node.el.style.display = 'none'; continue; }
      node.el.style.display = 'block';
      node.el.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px)`;
      node.dist.textContent = `${Math.round(m.dist)}m`;
    }
  }

  /**
   * The co-op room code, parked under the wave counter for the whole session.
   *
   * @param code    room code, or null/'' in single player
   * @param players how many are in the room
   */
  setRoom(code, players = 1) {
    this._set('room', `${code ?? ''}|${players}`, () => {
      const on = !!code;
      this.el.roomtag.classList.toggle('on', on);
      if (!on) return;
      this.el.roomtagCode.textContent = `ROOM ${code}`;
      this.el.roomtagPlayers.textContent =
        players > 1 ? `${players} PLAYERS` : 'WAITING FOR A FRIEND';
    });
  }

  /**
   * Markers over teammates who are bleeding out.
   *
   * @param marks [{x, y, angle, dist, edge, name, secs}] in screen pixels
   */
  setDownMarks(marks) {
    while (this.downEls.length < marks.length) {
      const el = document.createElement('div');
      el.className = 'dmk';
      el.innerHTML = '<div class="ico"></div><div class="txt"></div>';
      this.el.downmarks.appendChild(el);
      this.downEls.push({ el, txt: el.querySelector('.txt') });
    }
    for (let i = 0; i < this.downEls.length; i++) {
      const node = this.downEls[i];
      const m = marks[i];
      if (!m) { node.el.style.display = 'none'; continue; }
      node.el.style.display = 'block';
      node.el.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px)`;
      node.txt.textContent = `${m.name} DOWN · ${Math.round(m.dist)}m`;
    }
  }

  /**
   * The revive banner: your own bleed-out clock, or the pick-up you are
   * currently performing.
   *
   * @param info {title, sub, progress 0..1, bleed} or null to hide
   */
  setRevive(info) {
    this._set('reviveon', !!info, (on) => {
      this.el.revive.classList.toggle('on', on);
    });
    if (!info) return;
    this._set('revivetxt', `${info.title}|${info.sub}|${!!info.bleed}`, () => {
      this.el.rvTitle.textContent = info.title;
      this.el.rvSub.textContent = info.sub;
      this.el.revive.classList.toggle('bleed', !!info.bleed);
    });
    // The bar moves every frame, so it bypasses the cache.
    this.el.rvFill.style.width = `${Math.max(0, Math.min(1, info.progress)) * 100}%`;
  }

  /** Contextual "press E" line under the crosshair. Empty string hides it. */
  setPrompt(text) {
    this._set('prompt', text, (v) => {
      this.el.prompt.textContent = v;
      this.el.prompt.classList.toggle('on', v !== '');
    });
  }

  /**
   * Active potion perks with their countdowns.
   *
   * The list is rebuilt only when the set of perks changes; the timers and
   * meters are written every frame, which is cheap because they touch two
   * cached nodes each rather than re-querying the DOM.
   *
   * @param list [{def, time}] soonest to expire first
   */
  setEffects(all) {
    // Capped so a lucky run of chests cannot grow the column into the weapon
    // list. The soonest to expire are the ones worth watching anyway.
    const list = all.slice(0, 5);
    const key = list.map((e) => e.def.id).join(',');
    this._set('fx', key, () => {
      this.el.effects.innerHTML = list.map((e) => {
        const c = '#' + e.def.color.toString(16).padStart(6, '0');
        return `<div class="fx" style="--c:${c}">` +
          `<div class="fx-top"><span class="fx-name">${e.def.name}</span>` +
          `<span class="fx-time"></span></div>` +
          `<div class="fx-blurb">${e.def.blurb}</div>` +
          `<div class="fx-bar"><div class="fx-fill"></div></div></div>`;
      }).join('');
      this.fxEls = [...this.el.effects.children].map((el) => ({
        el,
        time: el.querySelector('.fx-time'),
        fill: el.querySelector('.fx-fill'),
      }));
    });

    for (let i = 0; i < this.fxEls.length; i++) {
      const node = this.fxEls[i];
      const e = list[i];
      if (!e) continue;
      node.time.textContent = Math.ceil(e.time) + 'S';
      node.fill.style.width = Math.max(0, e.time / e.def.duration * 100).toFixed(1) + '%';
      // Flash the last few seconds, so a perk about to drop is not a surprise
      // mid-fight.
      node.el.classList.toggle('expiring', e.time < 4);
    }
  }

  /**
   * Marker pointing at whatever a treasure map revealed. Same projection maths
   * as the enemy trackers, but it persists until the stone is collected.
   *
   * @param mark {x, y, angle, dist, edge, color, label} or null to clear
   */
  setWaypoint(mark) {
    if (!mark) {
      this._set('wpon', false, () => { this.el.waypoint.style.display = 'none'; });
      return;
    }
    this._set('wpon', true, () => { this.el.waypoint.style.display = 'block'; });
    this._set('wpcolor', mark.color, (v) => {
      this.el.waypoint.style.setProperty('--c', v);
    });
    this.el.waypoint.classList.toggle('edge', !!mark.edge);
    this.el.waypoint.style.transform =
      `translate(${mark.x.toFixed(1)}px, ${mark.y.toFixed(1)}px)`;
    this.el.wpArrow.style.transform = `rotate(${mark.angle.toFixed(3)}rad)`;
    this.el.wpLabel.textContent = `${mark.label}  ${Math.round(mark.dist)}m`;
  }

  hitmarker(kill) {
    this.hitmarkerTimer = kill ? 0.28 : 0.16;
    this.el.hitmarker.classList.toggle('kill', !!kill);
    this.el.hitmarker.style.opacity = '1';
    this.el.hitmarker.style.transform = kill ? 'scale(1.35)' : 'scale(1)';
  }

  damageFlash(amount) {
    this.damageTimer = 0.45;
    this.el.damage.style.opacity = String(Math.min(0.95, 0.28 + amount / 55));
  }

  setScore(n) {
    this._set('score', n, (v) => { this.el.score.textContent = v; });
  }

  setCoins(n) {
    this._set('coins', n, (v) => { this.el.coins.textContent = v; });
  }

  /** Compact travel/hazard readout, including temporary ground equipment. */
  setTravel(info) {
    if (!info) {
      this._set('travel', '', () => { this.el.travel.classList.remove('on'); });
      return;
    }
    const text = `${info.title}<span>${info.sub}</span>`;
    this._set('travel', text, (v) => {
      this.el.travel.innerHTML = v;
      this.el.travel.classList.add('on');
    });
  }

  /**
   * Show the boss bar, or hide it by passing null. Kept as one call so the
   * caller never has to remember to clear it when the boss dies.
   */
  setBoss(boss) {
    if (!boss) {
      this.el.bossbar.classList.add('hidden');
      return;
    }
    this.el.bossbar.classList.remove('hidden');
    this._set('bossName', boss.name, (v) => { this.el.bossName.textContent = v; });
    const frac = Math.max(0, Math.min(1, boss.health / boss.maxHealth));
    this.el.bossFill.style.width = (frac * 100).toFixed(1) + '%';
    this.el.bossFill.classList.toggle('enraged', !!boss.enraged);
  }

  /**
   * @param breakLeft seconds until the next wave, or 0 while one is running.
   *
   * The countdown replaces the kill tally during a break, because "0 / 0
   * ELIMINATED" is the least useful thing the HUD could say in the one window
   * where nothing is alive -- and before this the only place the timer appeared
   * was inside the armoury, so a player who never opened it got no warning at
   * all before the first wave walked in.
   */
  /**
   * @param leader FFA only: {name, kills, target}. A free-for-all has no waves,
   *   so the banner that would read "WAVE 1 INCOMING" over an empty arena shows
   *   who is winning instead.
   */
  setWave(wave, killed, total, breakLeft = 0, leader = null) {
    if (leader) {
      this._set('wave', `ffa|${leader.name}|${leader.kills}`, () => {
        this.el.waveNum.textContent = 'FREE FOR ALL';
      });
      const sub = leader.kills > 0
        ? `${leader.name} LEADS ${leader.kills} / ${leader.target}`
        : `FIRST TO ${leader.target}`;
      this._set('wavesub', sub, () => {
        this.el.waveSub.textContent = sub;
        this.el.waveSub.classList.remove('countdown');
      });
      return;
    }
    const next = Math.max(1, wave + (breakLeft > 0 ? 1 : 0));
    this._set('wave', `${wave}|${breakLeft > 0}`, () => {
      this.el.waveNum.textContent = breakLeft > 0 ? `WAVE ${next} INCOMING` : `WAVE ${wave}`;
    });
    const sub = breakLeft > 0
      ? `${Math.ceil(breakLeft)}s`
      : `${killed} / ${total} ELIMINATED`;
    this._set('wavesub', sub, () => {
      this.el.waveSub.textContent = sub;
      this.el.waveSub.classList.toggle('countdown', breakLeft > 0);
    });
  }

  announce(text, duration = 2.2, color = '#ffcf4d') {
    this.el.announce.textContent = text;
    this.el.announce.style.color = color;
    this.el.announce.style.opacity = '1';
    this.announceTimer = duration;
  }

  addFeed(text, color = '#e8f0f2') {
    const div = document.createElement('div');
    div.textContent = text;
    div.style.color = color;
    this.el.feed.appendChild(div);
    this.feedItems.push({ el: div, life: 4 });
    while (this.feedItems.length > 5) {
      const old = this.feedItems.shift();
      old.el.remove();
    }
  }

  update(dt) {
    if (this.hitmarkerTimer > 0) {
      this.hitmarkerTimer -= dt;
      if (this.hitmarkerTimer <= 0) this.el.hitmarker.style.opacity = '0';
      else this.el.hitmarker.style.opacity = String(Math.min(1, this.hitmarkerTimer * 6));
    }
    if (this.damageTimer > 0) {
      this.damageTimer -= dt;
      if (this.damageTimer <= 0) this.el.damage.style.opacity = '0';
    }
    if (this.announceTimer > 0) {
      this.announceTimer -= dt;
      if (this.announceTimer <= 0) this.el.announce.style.opacity = '0';
      else if (this.announceTimer < 0.5) this.el.announce.style.opacity = String(this.announceTimer / 0.5);
    }
    for (let i = this.feedItems.length - 1; i >= 0; i--) {
      const it = this.feedItems[i];
      it.life -= dt;
      if (it.life <= 0) {
        it.el.remove();
        this.feedItems.splice(i, 1);
      } else if (it.life < 0.6) {
        it.el.style.opacity = String(it.life / 0.6);
      }
    }
  }

  reset() {
    this._cache = {};
    this.feedItems.forEach((f) => f.el.remove());
    this.feedItems = [];
    this.setTrackers([]);
    this.setChestMarks([]);
    this.setDownMarks([]);
    this.setEffects([]);
    this.setWaypoint(null);
    this.setRevive(null);
    this.setPrompt('');
    this.el.damage.style.opacity = '0';
    this.el.announce.style.opacity = '0';
    this.el.hitmarker.style.opacity = '0';
    for (const el of [this.el.scope, this.el.bsight, this.el.holo,
                      this.el.reddot, this.el.laserdot, this.el.thermal]) {
      if (!el) continue;
      el.style.opacity = '0';
      el.style.visibility = 'hidden';
    }
    this.el.crosshair.style.opacity = '1';
    this.setTravel(null);
  }
}
