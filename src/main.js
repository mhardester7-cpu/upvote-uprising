// Game entry point: wiring, state machine, and the main loop.
//
// Loop shape (the standard fixed-timestep-with-interpolation arrangement):
//   - simulation runs at a fixed 60Hz so physics and fire rates are
//     framerate-independent and reproducible
//   - rendering runs as fast as the display allows, interpolating between the
//     last two simulation states so motion stays smooth on a 144Hz monitor
//   - look input is applied per frame, not per tick, because aiming latency is
//     the one thing players feel immediately
//
// States: LOADING -> MENU -> PLAYING <-> PAUSED, PLAYING -> DEAD -> MENU

import * as THREE from '../vendor/three.module.js';

import { Input } from './engine/input.js';
import {
  TouchControls, touchAvailable, useTouchPrompts, ctrl, pressWord, enterFullscreen,
} from './engine/touch.js';
import { loadBindings } from './engine/bindings.js';
import { Settings } from './ui/settings.js';
import { AudioSystem } from './engine/audio.js';
import { World, FLOOR_H, PROP_DOOR, MAP_ARENA, MAP_COMPLEX } from './world/world.js';
import { REVERSE_AQUARIUM_ROLE, TIER_WEAPONS } from './world/complex.js';
import { onDrummerTowerDeck } from './world/drummertower.js';
import { TerrainMesh } from './render/terrainmesh.js';
import { terrainPhotoTextures, preloadSurfaces } from './render/photosets.js';
import { PropRenderer } from './render/props.js';
import { BuildingRenderer } from './render/buildings.js';
import { createDrummerTower } from './render/drummertower.js';
import { mountModels, disposeModels, mountModelFallbacks } from './render/models.js';
import { Effects } from './render/effects.js';
import { ViewModel } from './render/viewmodel.js';
import { Player } from './entities/player.js';
import { createInertButton } from './entities/inertbutton.js';
import { createNuggetDispenser } from './entities/nuggetdispenser.js';
import {
  createDinosaurFactory, DINOSAUR_FACTORY_COST,
} from './entities/dinosaurfactory.js';
import {
  createReverseAquarium, insideReverseAquarium,
} from './entities/reverseaquarium.js';
import { createSpinningCat } from './entities/spinningcat.js';
import { Enemy, ENEMY_TYPES } from './entities/enemy.js';
import { buildEnemyMesh, syncEnemyMesh, disposeEnemyMesh } from './render/enemymesh.js';
import { preloadCharacters } from './render/charactermodels.js';
import { LocalSession, NetSession, EV } from './net/session.js';
import { BLEED_OUT, REVIVE_RANGE, REVIVE_TIME } from './sim/gamesim.js';
import { NetClient } from './net/netclient.js';
import { Presence } from './net/presence.js';
import { C2S, FFA_KILL_TARGET } from './net/protocol.js';
import {
  buildRemotePlayerMesh, syncRemotePlayerMesh, disposeRemotePlayerMesh,
  preloadRemotePlayerModel,
} from './render/remoteplayer.js';
import { WeaponSystem, WEAPONS, TIERS, SLOT_COUNT } from './combat/weapons.js';
import { LOADOUTS, DEFAULT_LOADOUT, loadoutById, loadoutWeapons } from './combat/loadouts.js';
import { resolveFire, HIT_ENEMY, HIT_WORLD } from './combat/combat.js';
import { Rocket, applyExplosion } from './combat/projectile.js';
import {
  Pickup, buildRocketMesh, installPickupWeaponModel, LOOT_LIFETIME,
  PICKUP_WEAPON, PICKUP_POTION, PICKUP_MAP,
} from './entities/pickup.js';
import { Stone, STONES, placeStones } from './entities/stone.js';
import { Chest, placeChests } from './entities/chest.js';
import { placeMysteryBox, BOX_COST } from './entities/mysterybox.js';
import { PotionEffects, POTION_BY_ID, randomPotion } from './entities/potion.js';
import { KillStreak } from './combat/streak.js';
import { createSky } from './render/sky.js';
import { HUD } from './ui/hud.js';
import { Shop, ITEM_BY_ID } from './ui/shop.js';
import { DamageNumbers } from './ui/damagenumbers.js';
import { Shake, TRAUMA } from './render/shake.js';
import { Progress } from './ui/progress.js';

import { EffectComposer } from '../vendor/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/postprocessing/OutputPass.js';
import { SSAOPass } from './render/ssaopass.js';
import { studioEnvironment } from './render/studioenv.js';
import { applySkyEnvironment } from './render/environment.js';
import { adoptWeaponModels } from './render/weaponmodels.js';
import { initCredits } from './ui/credits.js';

import { Supabase } from './net/supabase.js';
import { ACCOUNTS_ENABLED, supabaseConfig } from './net/config.js';
import { ProfileStore } from './game/profile.js';
import { applySkinToAll } from './game/skins.js';
import { CAMOS } from './render/camos.js';
import { previewFinish } from './ui/skinpreview.js';
import { AccountUI } from './ui/account.js';
import { LegalGate } from './ui/legal.js';
import { readPreference, writePreference } from './ui/preferences.js';
import { InterplanetaryTravel } from './game/interplanetary.js';
import { PortalSystem } from './game/portals.js';

const TICK_RATE = 60;
const TICK_DT = 1 / TICK_RATE;
const MAX_TICKS_PER_FRAME = 5;   // clamp so a background tab cannot spiral
const FOV = 78;

/** Safari's WebKit needs a smaller cold-start asset working set. */
function usesWebKitEngine() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /AppleWebKit\//.test(ua)
    && !/(?:Chrome|Chromium|Edg|OPR)\//.test(ua);
}

/** Whether this exact multisampled color format produces a complete FBO. */
function supportsMultisampledColor(gl, internalFormat, samples) {
  if (!(samples > 0)) return false;
  const priorFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
  const priorRenderbuffer = gl.getParameter(gl.RENDERBUFFER_BINDING);
  const framebuffer = gl.createFramebuffer();
  const renderbuffer = gl.createRenderbuffer();
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, internalFormat, 4, 4);
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer,
    );
    return gl.getError() === gl.NO_ERROR
      && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  } catch {
    return false;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, priorFramebuffer);
    gl.bindRenderbuffer(gl.RENDERBUFFER, priorRenderbuffer);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteRenderbuffer(renderbuffer);
  }
}

/**
 * Fog range at the hip-fire FOV. Held here rather than only on the Fog object
 * because _render rescales it every frame for the magnified optics.
 */
const FOG_NEAR = 130;
const FOG_FAR = 480;

/** Drop chances on kill. Baby zombies are far likelier to yield an airstrike. */
const BAZOOKA_DROP_CHANCE = 0.05;
const AIRSTRIKE_DROP_CHANCE = 0.01;
const AIRSTRIKE_DROP_CHANCE_BABY = 0.10;
/**
 * The flamethrower, and it is meant to be a story rather than a rotation.
 *
 * Four in a thousand bodies: a couple of waves' worth of kills gives you
 * roughly one chance in twenty of ever seeing one, and there is no other way to
 * get it -- not the box, not the armoury. Rolled before the other two, so the
 * rarest prize wins a tie rather than being quietly eaten by a bazooka.
 */
const FLAMETHROWER_DROP_CHANCE = 0.004;

/** Show enemy pointers once a wave is down to this many stragglers. */
const TRACKER_THRESHOLD = 3;

/** Loot chests seeded at the start of a run, plus a top-up after each wave. */
const CHEST_START_COUNT = 10;
const CHEST_PER_WAVE = 2;
const CHEST_MAX = 14;

/**
 * Chest markers: how far out they show, and how many at once.
 *
 * Capped at three so the marker layer stays a hint about what is nearby rather
 * than a map of the whole arena.
 */
const CHEST_MARK_RANGE = 95;
const CHEST_MARK_MAX = 3;

/**
 * How far a treasure map can see. A map found in a chest leads to an infinity
 * stone inside this radius of that chest, which is what ties the two collectible
 * systems together: chests are common and stationary, stones are rare and
 * hidden, and the map is the bridge.
 */
const MAP_RADIUS = 50;

/** Seconds between puffs of the trail a map leaves toward its stone. */
const TRAIL_INTERVAL = 0.85;

// An enemy is never teleported once it has spawned: where it entered the world
// is where it hunts from, and it closes the distance on foot or not at all.

const STATE = { LOADING: 'loading', MENU: 'menu', PLAYING: 'playing', PAUSED: 'paused', DEAD: 'dead' };

// Scratch objects for the per-frame tracker projection -- allocating these in
// the render loop would create garbage every frame.
/** Reused so the non-FFA HUD path allocates nothing per frame. */
const EMPTY_ROWS = [];

const TMP_VEC = new THREE.Vector3();
const TMP_VEC2 = new THREE.Vector3();
const TMP_CENTER = {};

/** Returned by the enemy accessor before a session exists. */
const EMPTY = [];

class Game {
  constructor() {
    this.state = STATE.LOADING;
    this.acc = 0;
    this.lastTime = 0;
    this.elapsed = 0;
    this.webkitCompatibility = usesWebKitEngine();

    this._initRenderer();
    this._initScene();
    this._initComposer();

    // Decided once, up front: the input system has to know from construction
    // whether it is being driven by a finger, because that is what determines
    // whether pointer lock is part of its life at all.
    // Before the first binding read, so a saved map is in force from frame one.
    loadBindings();
    this.touchMode = touchAvailable();
    // Before anything can render a prompt, so no frame ever tells a phone
    // player to press a key.
    useTouchPrompts(this.touchMode);
    this.input = new Input(this.renderer.domElement, { touchMode: this.touchMode });
    this.audio = new AudioSystem();
    this.hud = new HUD();

    this.world = new World(20260725);
    this._homeWorldSeed = this.world.seed;
    this.player = new Player(this.world);
    this.weapons = new WeaponSystem(this.audio);
    this.portals = new PortalSystem(this.scene, this.world);
    this.player.portalSystem = this.portals;
    this.world.portalSystem = this.portals;
    this.portals.onBlocked = (message) => this.hud.addFeed(message, '#ff9b72');
    this.effects = null;      // created after the scene exists
    this.viewmodel = new ViewModel();
    // Even if the manifest request itself fails, never expose the block-built
    // starter pistol. Its slot stays empty until the shipped model replaces it.
    this.viewmodel.requireExternalModel(this.weapons.def.id);
    // Metal needs something to reflect, and PMREM needs a live renderer, so the
    // viewmodel's environment is built here rather than in its constructor.
    this.viewmodel.setRenderer(this.renderer);
    // The world needs one too. A metalness-0.4 locker with nothing to reflect
    // renders black -- which is exactly what the shelves were doing.
    //
    // Carries the faces no lamp reaches. A shelf turned away from every
    // fixture has nothing but ambient on it, and at 0.55 that read as a black
    // slab standing in a lit room. Environment light arrives from every
    // direction, which is exactly what a turned-away face needs.
    this.scene.environment = studioEnvironment(this.renderer);
    this.scene.environmentIntensity = 0.78;
    // Heavy art is loaded sequentially while the opaque startup curtain is
    // present. These fields also let a later planet rebuild resume safely.
    this._skyEnvironmentPromise = null;
    this._optionalArtRun = 0;
    this._optionalArtTimer = null;
    this._optionalArtWorld = null;
    this._optionalArtDone = new Set();
    this.assetsReady = false;

    // The session owns enemies, waves and the coin pot. It is either a
    // LocalSession (a simulation ticked in this tab) or a NetSession (one
    // ticked on the server); nothing below this line needs to know which.
    this.session = null;
    this.net = null;
    this.remotes = [];
    /** Every live or lingering enemy group, including retired local corpses. */
    this.enemyMeshes = new Set();
    this.enemyPool = [];
    this.rockets = [];
    this.pickups = [];
    this.strikes = [];
    this.stones = [];
    this.collectedStones = new Set();
    this.chests = [];
    /** The arena's one mystery box, or null if nowhere suitable was found. */
    this.mysteryBox = null;
    /** The start room's deliberately suspicious red wall button. */
    this.importantButton = null;
    this._importantButtonRequest = 0;
    /** Optional prop art currently attached to this generated world. */
    this._models = [];
    this._modelsRequest = 0;
    this._modelFallbacks = null;
    /** One local serving state over the complex's shared physical machine. */
    this.nuggetDispenser = null;
    /** The complex's cloning pod and this client's persistent raptor ally. */
    this.dinosaurFactory = null;
    this._dinosaurFactoryRequest = 0;
    /** The supplied tabby GIF and the real geometry it resolves into. */
    this.spinningCat = null;
    this._spinningCatRequest = 0;
    this.potions = new PotionEffects();
    this.potions.onExpire = (def) => {
      this.hud.addFeed(`${def.name} WORE OFF`, '#9aa6b2');
      this.audio.potionEnd();
    };
    // The stone a treasure map is currently pointing at, or null.
    this.waypoint = null;
    this.trailTimer = 0;
    this.streak = new KillStreak();
    this.streak.onTierChange = (tier, count) => {
      this.hud.announce(`${tier.name}  x${count}`, 1.6, tier.color);
      this.audio.streakUp();
    };
    this.stats = { shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0, bosses: 0 };
    this.deathCause = '';
    this.bossId = null;
    this.lastEarned = 0;
    this._secretOpened = false;
    /** VITALITY levels bought this run. */
    this.vitality = 0;
    this.shop = new Shop(this);
    this.progress = new Progress();
    this.shake = new Shake();
    this.dmgNumbers = new DamageNumbers(document.getElementById('dmgnums'));
    /** Scratch map of enemy id -> world point, so numbers track moving targets. */
    this._numAnchors = new Map();

    this._bindUI();
    this._bindWeaponEvents();
    this._bindPlayerEvents();

    // Wear whatever finish the profile saved last time.
    if (this.progress.data.camo !== 'standard') {
      this.viewmodel.applyCamo(this.progress.data.camo);
    }

    window.addEventListener('resize', () => this._resize());
    this._resize();
  }

  // --------------------------------------------------------------- session

  // Enemies, waves and the shared score all live in the session. Exposing them
  // as accessors means the rest of this file reads the same whether the numbers
  // came from a local simulation or from the server.
  get enemies() { return this.session ? this.session.enemies : EMPTY; }
  get wave() { return this.session ? this.session.wave : 0; }
  get waveKills() { return this.session ? this.session.waveKills : 0; }
  get waveTotal() { return this.session ? this.session.waveTotal : 0; }
  get waveBreak() { return this.session ? this.session.waveBreak : 0; }
  get score() { return this.session ? this.session.score : 0; }
  get coins() { return this.session ? this.session.coins : 0; }
  get isMultiplayer() { return !!this.session?.multiplayer; }

  /** Drop every enemy mesh in the scene. Used on restart and on mode change. */
  _clearEnemyMeshes() {
    // A retired corpse is no longer in `enemies`, which is precisely why the
    // old loop could leave it lying in the scene across a restart. The registry
    // owns render lifetime independently of simulation lifetime.
    const groups = new Set(this.enemyMeshes);
    for (const e of this.enemies) if (e.group) groups.add(e.group);
    for (const e of this.session?.removed ?? []) if (e.group) groups.add(e.group);
    for (const group of groups) {
      this.scene.remove(group);
      disposeEnemyMesh(group);
    }
    this.enemyMeshes.clear();
    for (const e of this.enemies) e.group = null;
    for (const e of this.session?.removed ?? []) e.group = null;
  }

  /** Drop every co-op partner avatar. */
  _clearRemoteMeshes() {
    for (const r of this.remotes) {
      if (!r.group) continue;
      this.scene.remove(r.group);
      disposeRemotePlayerMesh(r.group);
      r.group = null;
    }
    this.remotes.length = 0;
  }

  /**
   * Give every entity the session reports a mesh, and take the mesh back from
   * anything that has gone. This is the one place meshes are created, so it
   * serves the local simulation and the networked one identically.
   */
  _reconcileMeshes() {
    for (const e of this.enemies) {
      if (e.group) continue;
      e.group = buildEnemyMesh(e.type.id);
      this.scene.add(e.group);
      this.enemyMeshes.add(e.group);
    }

    // LocalSession and NetSession both retain the object that just vanished
    // until this pass gives its mesh back. Do this before the multiplayer-only
    // avatar work so solo corpses obey the same lifecycle.
    for (const e of this.session?.removed ?? []) {
      if (!e.group) continue;
      this.scene.remove(e.group);
      disposeEnemyMesh(e.group);
      this.enemyMeshes.delete(e.group);
      e.group = null;
    }
    if (this.session?.removed) this.session.removed.length = 0;
    if (!this.session?.multiplayer) return;

    for (const r of this.session.remotes) {
      if (r.group) continue;
      r.group = buildRemotePlayerMesh(r);
      this.scene.add(r.group);
    }
    for (const r of this.session.remotesRemoved) {
      if (!r.group) continue;
      this.scene.remove(r.group);
      disposeRemotePlayerMesh(r.group);
      r.group = null;
    }
    this.remotes = this.session.remotes;
  }

  // ------------------------------------------------------------------ setup

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    // Retina 2x quadruples every full-screen target. With HalfFloat post
    // buffers, MSAA and SSAO that left too little GPU headroom for the first
    // gameplay texture uploads on Safari/Firefox. 1.5x remains visibly sharp
    // while cutting those targets by 44% versus 2x.
    this.pixelRatio = Math.min(window.devicePixelRatio, this.webkitCompatibility ? 1.25 : 1.5);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.autoClear = false;   // the viewmodel pass needs manual control

    // Filmic tone mapping in linear space, resolved to sRGB on output. This is
    // what lets the palette run bright and saturated without the highlights
    // clipping to flat white.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Exposure and the light intensities below are a matched set, tuned
    // together against ACES. Raising the lights without lowering exposure
    // pushes lit surfaces past the shoulder of the curve and the terrain goes
    // pale and chalky; lowering both too far crushes it to mud.
    this.renderer.toneMappingExposure = 1.05;

    // Soft sun shadows.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    document.body.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener('webglcontextlost', (event) => {
      // Three.js cannot safely rebuild this entire generated scene in place.
      // Prevent the browser's silent default and tell the player what happened
      // instead of leaving a frozen frame after they press Solo/Host.
      event.preventDefault();
      fatal('GRAPHICS MEMORY WAS EXHAUSTED',
        'The browser reset WebGL while loading the game. Refresh this page; '
        + 'UPVOTE UPRISING will use its reduced-memory assets and display settings.');
    });
  }

  /**
   * Post chain: scene -> bloom -> tone map/output.
   *
   * Bloom is the single biggest contributor to the stylised look -- it is what
   * makes the sun, the muzzle flashes, the stones and the tracers read as
   * emissive rather than merely bright.
   */
  _initComposer() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());

    // EffectComposer's default target has no multisampling, which quietly threw
    // away the `antialias: true` on the renderer: that flag only ever applied to
    // the default framebuffer, and every pixel of the world is drawn into this
    // target instead. Edges were aliased for free. Asking for samples here is
    // what actually buys the antialiasing back.
    //
    // 4x at DPR 1, 2x once the device is already supersampling -- MSAA cost
    // scales with the pixels underneath it, and at DPR 2 there is far less
    // aliasing left to resolve.
    const gl = this.renderer.getContext();
    const wantedSamples = this.pixelRatio >= 1.25 ? 2 : 4;
    const maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;
    const candidateSamples = Math.min(wantedSamples, maxSamples);
    const halfFloatRenderable = !!gl.getExtension('EXT_color_buffer_float');
    const type = halfFloatRenderable ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const internalFormat = halfFloatRenderable ? gl.RGBA16F : gl.RGBA8;
    const samples = supportsMultisampledColor(gl, internalFormat, candidateSamples)
      ? candidateSamples
      : 0;
    const target = new THREE.WebGLRenderTarget(
      size.x, size.y,
      { type, samples },
    );
    target.texture.name = 'EffectComposer.rt1';

    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.setSize(window.innerWidth, window.innerHeight);

    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);
    this.renderPass = renderPass;

    // Occlusion goes in before bloom so it darkens the lit frame rather than
    // the bloomed one -- AO applied after bloom would eat the glow out of
    // creases the bloom was meant to bleed into.
    this.ssaoPass = new SSAOPass(this.scene, this.camera, size.x, size.y);
    // The sky dome is drawn without depth for a reason and must not become an
    // occluder when the prepass overrides its material. The tracers are added
    // in load(), once Effects exists.
    this.ssaoPass.exclude.push(this.sky);
    this.composer.addPass(this.ssaoPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      0.30,   // strength -- restrained, so the whole frame does not smear
      0.60,   // radius
      0.90,   // threshold: only genuinely bright pixels bloom
    );
    this.composer.addPass(this.bloomPass);

    // OutputPass applies tone mapping and the sRGB conversion at the end of
    // the chain, which is where they belong once post effects are involved.
    this.composer.addPass(new OutputPass());
  }

  _initScene() {
    this.scene = new THREE.Scene();
    // Fog tinted to match the sky's horizon so distant terrain dissolves into
    // it instead of ending on a hard line.
    this.scene.fog = new THREE.Fog(0xbfe4f7, FOG_NEAR, FOG_FAR);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 700);
    // Yaw-then-pitch is the correct order for an FPS camera; XYZ would roll the
    // view as you look around.
    this.camera.rotation.order = 'YXZ';

    this.sunDir = new THREE.Vector3(0.42, 0.78, 0.28).normalize();
    this.sky = createSky(this.sunDir);
    this.scene.add(this.sky);

    // Bright sky bounce over a warm ground bounce -- the two-tone ambient is
    // what keeps shadowed faces colourful instead of grey. It also carries the
    // building interiors, which get their own fixtures on top.
    this.scene.add(new THREE.HemisphereLight(0xa8d8ff, 0x7d6a44, 0.72));

    const sun = new THREE.DirectionalLight(0xfff0cf, 1.65);
    sun.position.copy(this.sunDir).multiplyScalar(120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    // A tight ortho box that follows the player: a world-sized shadow frustum
    // would waste the entire map on a handful of texels.
    const S = 42;
    this.shadowExtent = S;
    sun.shadow.camera.left = -S;
    sun.shadow.camera.right = S;
    sun.shadow.camera.top = S;
    sun.shadow.camera.bottom = -S;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 320;
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.06;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // Cool rim fill from the opposite side, so silhouettes stay readable
    // against bright terrain.
    const fill = new THREE.DirectionalLight(0x86b6ff, 0.28);
    fill.position.set(-0.6, 0.45, -0.7).multiplyScalar(120);
    this.scene.add(fill);
    this.fill = fill;
  }

  /**
   * Light the rooms.
   *
   * An indoor room with a ceiling is pitch dark however bright the day is, so
   * every one gets a fixture. Courtyards get none -- they are open to the sky
   * and the sun already reaches them, and lighting them would read as floodlit
   * rather than outdoors.
   *
   * None of these cast shadows. The sun is the scene's one shadow caster;
   * shadow-mapping a fixture per room would cost more than everything else in
   * the frame together.
   */
  _lightInteriors() {
    // Everything this makes goes in one group, so a rebuild on a new seed can
    // take the old rig out in one move. Two hundred loose panels added to the
    // scene and never removed is a leak you only notice as the frame rate
    // sagging after the third room you join.
    if (this.interiorRig) {
      this.scene.remove(this.interiorRig);
      this.interiorRig.traverse((o) => {
        o.geometry?.dispose?.();
        if (o.material && o.material !== this._panelMat
          && o.material !== this._aquariumPanelMat) o.material.dispose?.();
      });
      this._panelMat?.dispose?.();
      this._aquariumPanelMat?.dispose?.();
      this._panelMat = null;
      this._aquariumPanelMat = null;
      this.interiorRig = null;
    }
    const rig = new THREE.Group();
    this.scene.add(rig);
    this.interiorRig = rig;

    const panelMat = new THREE.MeshBasicMaterial({ color: 0xd8c59d });
    const aquariumPanelMat = new THREE.MeshBasicMaterial({ color: 0x6e7042 });
    const panelGeo = new THREE.PlaneGeometry(1.5, 0.45);
    this._panelMat = panelMat;
    this._aquariumPanelMat = aquariumPanelMat;

    /** Where every fixture hangs. The panels are drawn at all of them. */
    this.fixtures = [];

    for (const r of this.world.plan.rooms) {
      if (r.outdoor) continue;
      const w = r.maxX - r.minX, d = r.maxZ - r.minZ;

      // Fixtures on a grid, roughly one every seven metres. Two lamps light
      // the centre of a big room and leave the far wall reading black -- which
      // is not an unlit wall, it is a wall eight metres from the only thing
      // lighting it.
      const PITCH = 7;
      const nx = Math.max(1, Math.round(w / PITCH));
      const nz = Math.max(1, Math.round(d / PITCH));

      for (let f = 0; f < (r.storeys ?? 1); f++) {
        // A fixture on EVERY storey. A mezzanine puts a slab between the floor
        // you stand on and a lamp hung at the roof, so that floor is lit by a
        // light it cannot see.
        const y = r.floorY + FLOOR_H * (f + 1) - 0.45;

        for (let i = 0; i < nx; i++) {
          for (let j = 0; j < nz; j++) {
            const x = r.minX + (i + 0.5) * (w / nx);
            const z = r.minZ + (j + 0.5) * (d / nz);
            const aquarium = r.role?.id === REVERSE_AQUARIUM_ROLE;
            this.fixtures.push({
              x, y, z, aquarium,
              color: aquarium ? 0xc1c574 : 0xffeccc,
              intensity: aquarium ? 0.18 : 1,
            });

            const panel = new THREE.Mesh(panelGeo, aquarium ? aquariumPanelMat : panelMat);
            panel.position.set(x, y - 0.05, z);
            panel.rotation.x = Math.PI / 2;
            rig.add(panel);
          }
        }
      }
    }

    // A dim fill that rides the camera.
    //
    // Every fixture is overhead, so a face turned sideways -- the broad side of
    // a shelf, the end of a locker bank -- catches nothing but ambient and
    // reads as a black slab standing in a lit room. That is physically honest
    // and looks broken, because a real room bounces light off its floor and
    // walls and we do not simulate that. A weak light at the eye is the
    // standard stand-in: it lands on exactly the surfaces facing you, which are
    // exactly the ones missing their bounce, and it is invisible on anything
    // already lit.
    this.fillLight = new THREE.PointLight(0xfff0dd, 1.6, 12, 1);
    rig.add(this.fillLight);

    // A small pool of real lights, moved to whichever fixtures are nearest.
    //
    // One PointLight per fixture would be a hundred and eighty of them, and a
    // forward renderer loops every fragment over every light in the scene --
    // the shader is compiled for the count present, so the cost is paid on
    // every pixel whether the light reaches it or not. Ten that follow the
    // player look identical from inside a room and cost a twentieth as much.
    //
    // Ten rather than eight, and reaching further, because the building is
    // three storeys deep now: the pool is picked by distance in 3D, so a lamp
    // on the floor above is competing for a slot with the lamp across the room,
    // and a pool that is too small browns out the room you are standing in.
    this.lightPool = [];
    for (let i = 0; i < 10; i++) {
      const light = new THREE.PointLight(0xffeccc, 4.8, 15, 1);
      light.visible = false;
      rig.add(light);
      this.lightPool.push(light);
    }
    this._nearestFixtures = new Array(this.lightPool.length).fill(null);
    this._nearestFixtureDistances = new Float64Array(this.lightPool.length);
  }

  /**
   * Point the light pool at the nearest fixtures.
   *
   * Called per frame. Sorting a couple of hundred fixtures by distance every
   * frame would be wasteful, so this does a single linear pass keeping the
   * best few -- the pool is small enough that insertion beats a full sort.
   */
  _updateInteriorLights(frameDt = 0.016) {
    if (!this.fixtures || !this.lightPool) return;
    const p = this.camera.position;
    const body = this.player?.pos ?? p;
    const aquariumRoom = this.world?.plan?.rooms?.find(
      (room) => room.role?.id === REVERSE_AQUARIUM_ROLE,
    );
    const insideAquarium = insideReverseAquarium(aquariumRoom, body);
    this._insideAquarium = insideAquarium;

    // Ease the whole exposure down at the threshold. This darkens bright sky
    // leaking through the open door as well as the room, which makes the
    // enclosure feel like a separate, stale institutional space.
    const moodTarget = insideAquarium ? 1 : 0;
    const moodRate = insideAquarium ? 1.9 : 2.8;
    this._aquariumMood = (this._aquariumMood ?? 0)
      + (moodTarget - (this._aquariumMood ?? 0))
        * Math.min(1, Math.max(0, frameDt || 0.016) * moodRate);
    this.renderer.toneMappingExposure = 1.05 - this._aquariumMood * 0.25;
    this.scene.environmentIntensity = 0.78 - this._aquariumMood * 0.42;
    // Just behind the eye, so it never blows out whatever you are looking at
    // point-blank.
    if (this.fillLight) {
      this.fillLight.position.set(p.x, p.y + 0.35, p.z);
      this.fillLight.color.setHex(insideAquarium ? 0x9b9d61 : 0xfff0dd);
      this.fillLight.intensity = insideAquarium ? 0.38 : 1.6;
    }
    const pool = this.lightPool;
    const best = this._nearestFixtures;
    const distances = this._nearestFixtureDistances;
    best.fill(null);
    distances.fill(Infinity);

    for (const f of this.fixtures) {
      const d = (f.x - p.x) ** 2 + (f.y - p.y) ** 2 + (f.z - p.z) ** 2;
      if (d >= distances[distances.length - 1]) continue;
      let slot = distances.length - 1;
      while (slot > 0 && d < distances[slot - 1]) {
        distances[slot] = distances[slot - 1];
        best[slot] = best[slot - 1];
        slot--;
      }
      distances[slot] = d;
      best[slot] = f;
    }

    for (let i = 0; i < pool.length; i++) {
      const hit = best[i];
      pool[i].visible = !!hit;
      if (hit) {
        pool[i].position.set(hit.x, hit.y, hit.z);
        pool[i].color.setHex(hit.color);
        // Keep doorway illumination stable. Abrupt simulated electrical dips
        // read as a render fault when the fixture is just outside the view.
        pool[i].intensity = 4.8 * hit.intensity;
      }
    }
  }

  /**
   * The boards on the windows: shaken while they are worked, gone when they go.
   *
   * Until now a torn-off board left the simulation and stayed on the screen --
   * the collider went, so bullets and bodies passed through it, but the plank
   * was baked into the merged building geometry and could not be taken out
   * again. A zombie spent five seconds prising at a window and nothing visibly
   * happened, which made the single most important mechanic on the map
   * invisible.
   */
  _updateBoards(dt) {
    if (!this.buildings) return;
    this._boardTime = (this._boardTime ?? 0) + dt;
    this.buildings.syncBoards(this.world.barriers, this._boardTime, (at) => {
      // Splinters where the plank was, then the crack of the nails going.
      this.effects.blockImpact(at.x, at.y, at.z, 0, 1, 0, 0x9a7040);
      this.effects.spawnPuff(at.x, at.y, at.z, 0xb08a52);
      this.audio.boardBreak(at);
      this.shake.add(0.16);
    });
  }

  /** Keep the shadow frustum stably centred on the player. */
  _updateSunShadow() {
    const p = this.player.pos;
    // A look-dependent shadow box moved by metres whenever the camera turned,
    // reprojecting every shadow across doorway edges and the tower deck. Keep
    // it player-centred and snap it to one shadow texel so sub-pixel walking
    // cannot shimmer the map either.
    const mapWidth = this.sun.shadow.mapSize.x || 2048;
    const texel = (this.shadowExtent * 2) / mapWidth;
    const cx = Math.round(p.x / texel) * texel;
    const cz = Math.round(p.z / texel) * texel;

    this.sun.target.position.set(cx, p.y, cz);
    this.sun.position.set(
      cx + this.sunDir.x * 120,
      p.y + this.sunDir.y * 120,
      cz + this.sunDir.z * 120,
    );
    this.sun.target.updateMatrixWorld();
  }

  _bindUI() {
    this.ui = {
      overlay: document.getElementById('overlay'),
      panelLoad: document.getElementById('panel-load'),
      panelMenu: document.getElementById('panel-menu'),
      panelPause: document.getElementById('panel-pause'),
      panelDead: document.getElementById('panel-dead'),
      panelAuth: document.getElementById('panel-auth'),
      panelShop: document.getElementById('panel-shop'),
      panelPatchnotes: document.getElementById('panel-patchnotes'),
      loadFill: document.getElementById('loadfill'),
      loadText: document.getElementById('loading'),
      pauseStats: document.getElementById('pause-stats'),
      deadStats: document.getElementById('dead-stats'),
    };

    this.ui.mpName = document.getElementById('mp-name');
    this.ui.mpCode = document.getElementById('mp-code');
    this.ui.mpStatus = document.getElementById('mp-status');
    this.ui.mpRooms = document.getElementById('mp-rooms');
    this.ui.mpPublic = document.getElementById('mp-public');
    this.ui.mpCount = document.getElementById('mp-count');
    this.ui.liveCount = document.getElementById('livecount');
    this.ui.playCount = document.getElementById('playcount');
    this.ui.liveStats = document.getElementById('live-stats');

    // Click-through acceptance is versioned and stored locally. The legal
    // pages remain available before acceptance; only play, rooms and accounts
    // are gated.
    this.legal = new LegalGate(
      document.getElementById('legal-consent'),
      document.getElementById('legal-note'),
      ['btn-play', 'btn-host', 'btn-join']
        .map((id) => document.getElementById(id)),
    );

    // Check in with the server so solo players are counted at all, and use the
    // reply to show everyone how many others are in the game right now.
    this.presence = new Presence((live) => this._showLiveCount(live)).start();

    // Entering a game is the one reliable user gesture before play starts, and
    // fullscreen -- like pointer lock -- can only be taken inside one. Asking
    // here means the browser bar is gone by the time the first wave lands,
    // rather than the player hunting for a button mid-fight. Fire-and-forget:
    // the request is allowed to fail, and enterFullscreen swallows that.
    const goBig = () => { if (this.touchMode) enterFullscreen(); };

    document.getElementById('btn-play').addEventListener('click', () => {
      goBig();
      try { this.startGame(); }
      catch (error) { this._launchFailed(error); }
    });
    document.getElementById('btn-host').addEventListener('click', () => {
      goBig();
      this.startCoop('', 'coop', this._visibility())
        .catch((error) => this._launchFailed(error));
    });
    // Public or code-only is remembered, because it is a standing preference
    // about how someone plays rather than a per-game decision. A new browser
    // starts private so publishing a name and room code is always deliberate.
    this.ui.mpPublic.checked = readPreference('bs.public') === '1';
    this.ui.mpPublic.addEventListener('change', () => {
      writePreference('bs.public', this.ui.mpPublic.checked ? '1' : '0');
    });
    document.getElementById('btn-join').addEventListener('click', () => {
      const code = this.ui.mpCode.value.trim();
      if (!code) { this._mpStatus('Enter a code, or host a new game.', 'err'); return; }
      goBig();
      this.startCoop(code).catch((error) => this._launchFailed(error));
    });
    // Enter in the code box joins, which is what anyone typing a code expects.
    this.ui.mpCode.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-join').click();
    });

    // The name is the one setting worth remembering between visits.
    this.ui.mpName.value = readPreference('bs.name');
    this.ui.mpName.addEventListener('change', () => {
      writePreference('bs.name', this.ui.mpName.value.trim());
    });

    // Loadout picker. Built from the table rather than typed into the markup,
    // so adding a set is a one-line change in loadouts.js and never a menu that
    // offers a kit the game cannot grant.
    this.ui.mpLoadout = document.getElementById('mp-loadout');
    this.ui.mpLoadoutHint = document.getElementById('mp-loadout-hint');
    if (this.ui.mpLoadout) {
      for (const l of LOADOUTS) {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.name;
        this.ui.mpLoadout.appendChild(opt);
      }
      const describe = () => {
        const l = loadoutById(this.ui.mpLoadout.value);
        if (this.ui.mpLoadoutHint) this.ui.mpLoadoutHint.textContent = l.blurb;
      };
      this.ui.mpLoadout.value = this.loadoutId;
      describe();
      this.ui.mpLoadout.addEventListener('change', () => {
        writePreference('bs.loadout', this.ui.mpLoadout.value);
        describe();
      });
    }
    document.getElementById('btn-resume').addEventListener('click', () => this.resume());
    // The only way out of a run that is not dying or closing the tab. Pause had
    // RESUME and CONTROLS and nothing else, so a player who wanted to leave a
    // match -- or switch from co-op to a free-for-all -- was stuck in it.
    document.getElementById('btn-quit').addEventListener('click', () => this._toMenu());

    // Controls screen. Reachable from the menu and from pause, and it returns to
    // whichever one opened it.
    this.settings = new Settings((returnTo) => {
      if (returnTo === 'panel-menu') {
        this._setPatchnotesVisible?.(!this._patchnotesDismissed);
      }
    });
    document.getElementById('btn-settings')
      .addEventListener('click', () => {
        this._setPatchnotesVisible?.(false);
        this.settings.open('panel-menu');
      });
    document.getElementById('btn-settings-pause')
      .addEventListener('click', () => this.settings.open('panel-pause'));
    document.getElementById('btn-restart').addEventListener('click', () => this.startGame());

    // Art credits. Same show/hide contract as the controls panel: hide the menu,
    // show this, and BACK puts the menu back. initCredits leaves the button
    // hidden when no downloaded art is installed, so a procedural build has no
    // dead entry in its menu.
    const creditsBtn = document.getElementById('btn-credits');
    const creditsPanel = document.getElementById('panel-credits');
    initCredits(creditsBtn, document.getElementById('credits-body'))
      .then((n) => { if (n) console.log(`[assets] ${n} credited third-party assets`); });
    creditsBtn.addEventListener('click', () => {
      this._setPatchnotesVisible?.(false);
      document.getElementById('panel-menu').classList.add('hidden');
      creditsPanel.classList.remove('hidden');
    });
    document.getElementById('btn-credits-back').addEventListener('click', () => {
      creditsPanel.classList.add('hidden');
      document.getElementById('panel-menu').classList.remove('hidden');
      this._setPatchnotesVisible?.(!this._patchnotesDismissed);
    });

    // The release card accompanies the menu without replacing it. Dismissal is
    // remembered for this page session so it does not keep returning while a
    // player visits controls, the shop, or a match.
    this._patchnotesDismissed = false;
    this._setPatchnotesVisible = (visible) => {
      this.ui.panelPatchnotes.classList.toggle('hidden', !visible);
      this.ui.overlay.classList.toggle('patch-open', visible);
    };
    const closePatchnotes = () => {
      this._patchnotesDismissed = true;
      this._setPatchnotesVisible(false);
      document.getElementById('btn-settings').focus();
    };
    document.getElementById('btn-patchnotes-close').addEventListener('click', closePatchnotes);
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.ui.panelPatchnotes.classList.contains('hidden')) return;
      event.preventDefault();
      closePatchnotes();
    });

    // The menu, the shop and the account panel are three views of one screen;
    // only ever one is up, and BACK always returns to the menu.
    document.getElementById('btn-shop')
      .addEventListener('click', () => this._showMenuPanel('shop'));
    if (ACCOUNTS_ENABLED) {
      document.getElementById('btn-account')
        .addEventListener('click', () => this._showMenuPanel('auth'));
    }
    document.getElementById('btn-shop-back')
      .addEventListener('click', () => this._showMenuPanel('menu'));
    document.getElementById('btn-auth-back')
      .addEventListener('click', () => this._showMenuPanel('menu'));

    // The on-screen stick and buttons, which synthesise the same keys and mouse
    // buttons the desktop path uses. Built only on a touch device, so the
    // desktop game never allocates it or listens for a pointer it will not get.
    if (this.touchMode) this._initTouch();

    // Safety net for a wrong guess.
    //
    // The detection reads primary pointer and hover, which is the right signal,
    // but it is still a guess about hardware -- and getting it wrong in the
    // desktop direction puts the player straight back into the dead end this
    // all started as: a live round, no pointer lock, and taps that go nowhere.
    // A real finger arriving while the game wants a lock it does not have is
    // proof the guess was wrong, so promote and carry on rather than strand them.
    this.input.onTouchDetected = () => this._initTouch();

    // Losing pointer lock is the canonical "pause" signal in a browser FPS.
    // Never fires under touch: nothing there ever holds a lock to lose, and
    // auto-pausing on its absence would pause the game permanently.
    this.input.onLockChange = (locked) => {
      // The shop releases the pointer on purpose, so losing lock while it is
      // open is expected rather than a signal that the player tabbed away.
      if (!locked && this.state === STATE.PLAYING && !this.shop.isOpen) this.pause();
    };
  }

  /** Swap which of the menu-screen panels is visible. */
  _showMenuPanel(name) {
    this.ui.panelMenu.classList.toggle('hidden', name !== 'menu');
    this.ui.panelShop.classList.toggle('hidden', name !== 'shop');
    this.ui.panelAuth.classList.toggle('hidden', name !== 'auth');
    this._setPatchnotesVisible?.(name === 'menu' && !this._patchnotesDismissed);
    if (name !== 'menu') this.accountUI?.refresh();
  }

  _bindWeaponEvents() {
    this.weapons.onFire = (w, shots, cone, alternate = false) => {
      // Portal placements are traversal inputs, not combat attempts, and must
      // not quietly ruin the run's accuracy statistic.
      if (!w.def.portal) this.stats.shots += 1;
      // Melee discharge is an animation event, not a muzzle event. The swing
      // transform already lives in the viewmodel, but nothing used to trigger
      // it, so the pickaxe dealt damage while remaining perfectly still (and
      // could flash the last gun's muzzle position at the same time).
      if (w.def.melee) {
        const cadence = 60 / Math.max(1, w.def.rpm);
        this.viewmodel.triggerSwing(Math.min(0.48, cadence * 0.9));
      }
      // The flamethrower's held plume is driven directly from trigger state;
      // stacking powder flashes on its fuel cadence turns it into a flickering
      // automatic rifle. Every other weapon keeps the short discharge flash.
      if (!w.def.melee && w.def.id !== 'flamethrower') {
        const flash = w.def.portal ? (alternate ? 0xff8b24 : 0x28a9ff) : w.def.beamColor;
        this.viewmodel.triggerFlash(flash);
      }
      if (w.def.portal) this._firePortal(alternate ? 'orange' : 'blue', shots[0]);
      else if (w.def.designator) this._callAirstrike(w, shots[0]);
      else if (w.def.projectile) this._launchRocket(w, shots[0]);
      else this._resolveShot(w, shots, cone);
    };
    this.weapons.onSwitch = (w) => {
      this._refreshWeaponList();
      if (w.def.portal) {
        this.hud.addFeed('PORTAL GUN — PRIMARY BLUE · SECONDARY ORANGE', '#9eeaff');
      }
    };
  }

  _bindPlayerEvents() {
    this.player.onStep = () => this.audio.step();
    this.player.onLand = () => this.audio.land();
    this.player.onJump = () => this.audio.jump();
    this.player.onDamage = (amount) => {
      this.audio.playerHurt();
      this.hud.damageFlash(amount);
    };
    this.player.onDeath = (source) => {
      this.deathCause = source === 'inevitable-snail' ? 'THE INEVITABLE SNAIL' : '';
      // Solo, zero health is simply the end. In co-op it is a bleed-out, and
      // the simulation is the thing that decides how that resolves.
      if (this.isMultiplayer && source !== 'inevitable-snail') this.session.reportDown();
      else this.gameOver();
    };
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewmodel.setSize(w, h);
  }

  // -------------------------------------------------------------- world load

  async load() {
    const setProgress = (p, label) => {
      this.ui.loadFill.style.width = Math.round(p * 100) + '%';
      if (label) this.ui.loadText.textContent = label;
    };

    // A hidden tab throttles requestAnimationFrame to about 1Hz, which would
    // stretch a 300ms load into half a minute. When there is nothing to paint,
    // yield through a macrotask instead so the work still runs at full speed.
    const yieldToBrowser = () => new Promise((resolve) => {
      if (document.hidden) setTimeout(resolve, 0);
      else requestAnimationFrame(() => resolve());
    });

    // Drain a generator, handing time back to the browser only once this chunk
    // of work has run long enough to be worth a repaint.
    const drain = async (gen, from, span, label) => {
      let last = performance.now();
      for (const p of gen) {
        setProgress(from + p * span, label);
        if (performance.now() - last > 24) {
          await yieldToBrowser();
          last = performance.now();
        }
      }
      setProgress(from + span, label);
      await yieldToBrowser();
    };

    await drain(this.world.generate(), 0, 0.55, 'GENERATING TERRAIN');

    this.effects = new Effects(this.scene);
    // Additive, depth-less, and drawn every time a shot goes out -- exactly the
    // thing that must not turn into an occluder during the AO prepass.
    this.ssaoPass.exclude.push(
      this.effects.tracers,
      this.effects.flames,
      this.effects.smoke,
    );
    setProgress(0.6, 'BUILDING TERRAIN');
    // Photographed ground if the art pack is installed, procedural bake if not.
    // Awaited here rather than swapped in later because the terrain material
    // captures its texture arrays when the shader compiles: handing them over
    // after the fact would mean recompiling every chunk's program mid-frame.
    // All awaited here, before anything is built with them: the terrain material
    // captures its arrays when the shader compiles, the complex assigns its
    // materials in one synchronous pass, and buildEnemyMesh is synchronous too --
    // a character that arrives after the first wave spawns would give one wave
    // capsules and the next one bodies.
    // Do not overlap character and wall image decoders. Both are main-thread
    // work in Firefox/WebKit and the parallel burst was a larger risk than the
    // small serial latency win.
    const characters = await preloadCharacters();
    // WebKit's clean-cache startup used to decode more than 50 MiB of
    // photographed terrain/wall sources before it could show the menu. Its
    // procedural PBR surfaces are complete, so reserve the cold-start budget
    // for the realistic animated zombies the player actually needs.
    const surfaces = this.webkitCompatibility ? 0 : await preloadSurfaces();
    this._terrainTextures = this.webkitCompatibility
      ? null
      : await terrainPhotoTextures(512);
    if (surfaces) console.log(`[assets] ${surfaces} photographed building surfaces`);
    if (characters.length) console.log(`[assets] skinned characters: ${characters.join(', ')}`);
    this.terrain = new TerrainMesh(this.scene, this.world.field, this._terrainTextures);
    this.terrain.build();
    await yieldToBrowser();

    setProgress(0.8, 'PLACING SCENERY');
    this.propRenderer = new PropRenderer(this.scene, this.world);
    this.propRenderer.build();
    this._mountModelFallbacks();
    await yieldToBrowser();

    setProgress(0.9, 'RAISING BUILDINGS');
    this.buildings = new BuildingRenderer(this.scene, this.world);
    this.buildings.build();
    this._lightInteriors();
    // Build complete interaction shells behind the curtain, then replace their
    // visuals one batch at a time. Serial decoding avoids freezing WebKit and
    // Firefox while ensuring no fallback reaches a visible frame.
    this._mountNuggetDispenser();
    await this._mountDinosaurFactoryFallback();
    this._mountDrummerTower();
    this._createTravel();

    setProgress(0.92, 'LOADING WORLD ASSETS');
    await this._loadRequiredWorldArt({
      onStep: (index, total, label) => setProgress(
        0.92 + ((index + 1) / total) * 0.05,
        `LOADING ${label.toUpperCase()}`,
      ),
      yieldFrame: yieldToBrowser,
    });
    await yieldToBrowser();

    setProgress(0.98, 'FINALIZING PROFILE');
    await this._initProfile();
    await this._adoptWeapons();
    this._optionalArtDone.add('weapons');
    await this._warmStartingWeapon();
    this.assetsReady = true;
    document.body.classList.add('assets-ready');
    setProgress(1, 'READY');

    this.state = STATE.MENU;
    this.ui.panelLoad.classList.add('hidden');
    this.ui.overlay.classList.remove('asset-loading');
    this._showMenuPanel('menu');

    // Keep the lobby list live while the menu is up.
    this.refreshRooms();
    setInterval(() => this.refreshRooms(), 5000);
  }

  // ------------------------------------------------------------------ co-op

  _mpStatus(text, kind = '') {
    this.ui.mpStatus.textContent = text;
    this.ui.mpStatus.className = 'mp-status' + (kind ? ' ' + kind : '');
  }

  /** Recover the menu when a browser rejects an optional startup capability. */
  _launchFailed(error) {
    this._connecting = false;
    this.state = STATE.MENU;
    this.audio.stopMusic();
    this.input.exitLock();
    this.ui.overlay.classList.remove('hidden');
    this.ui.panelMenu.classList.remove('hidden');
    this._mpStatus(`Could not start: ${error?.message || error || 'unknown browser error'}`, 'err');
    console.error('[upvote-uprising] match startup failed:', error);
  }

  /**
   * Poll the public lobby while the menu is up, so the list is never stale.
   *
   * Everything here is built with createElement and textContent. Names in this
   * list are typed by strangers, and a lobby browser is the one screen in the
   * game that renders other people's input -- innerHTML habits here are how a
   * player name becomes a script tag in everybody else's menu.
   */
  async refreshRooms() {
    if (this.state !== STATE.MENU || document.hidden) return;
    try {
      const res = await fetch('/api/rooms', { cache: 'no-store' });
      const { rooms } = await res.json();
      const box = this.ui.mpRooms;
      box.textContent = '';

      const open = rooms.filter((r) => !r.full).length;
      this.ui.mpCount.textContent = rooms.length
        ? `${open} OPEN / ${rooms.length}`
        : '';

      if (!rooms.length) {
        const empty = document.createElement('div');
        empty.className = 'mp-empty';
        empty.textContent = 'NO PUBLIC GAMES RIGHT NOW — HOST ONE AND IT APPEARS HERE';
        box.appendChild(empty);
        return;
      }

      for (const r of rooms) box.appendChild(this._roomRow(r));
    } catch {
      /* the lobby is a convenience; failing to list rooms is not fatal */
    }
  }

  /** One row of the lobby browser. */
  _roomRow(r) {
    const ffa = r.mode === 'ffa';

    const b = document.createElement('button');
    b.className = 'room-btn';
    b.disabled = !!r.full;

    const mode = document.createElement('span');
    mode.className = 'room-mode ' + (ffa ? 'ffa' : 'coop');
    mode.textContent = ffa ? 'FFA' : 'CO-OP';

    // Who is in there, with the code kept alongside: the list is how you find a
    // stranger's game, and the code is how you tell a friend to come to yours.
    const who = document.createElement('span');
    who.className = 'room-who';
    who.textContent = r.host || 'OPEN GAME';
    const code = document.createElement('span');
    code.textContent = `  ${r.code}`;
    who.appendChild(code);

    const state = document.createElement('span');
    state.className = 'room-state';
    // What a newcomer actually wants to know: can I get in, and what will I be
    // walking into if I do.
    state.textContent = r.full ? 'FULL'
      : !r.started ? 'IN LOBBY'
        : ffa ? 'IN PROGRESS'
          // Wave 0 with the clock running is the opening grace: the room has
          // started but nothing has walked in yet, which is still a good moment
          // to arrive and not the same as being mid-wave.
          : r.wave < 1 ? 'STARTING' : `WAVE ${r.wave}`;

    const count = document.createElement('b');
    count.textContent = `${r.players}/${r.max}`;

    b.append(mode, who, state, count);
    if (!r.full) b.addEventListener('click', () => this.startCoop(r.code));
    return b;
  }

  /**
   * The "N playing now" line under the menu.
   *
   * The viewer is always one of the N -- their own beat is what fetched this --
   * so a count of one is not an empty server, it is an empty server plus you,
   * and saying so plainly beats a bare "1" that reads like a bug.
   */
  _showLiveCount(live) {
    const el = this.ui.liveCount;
    if (!el) return;
    const n = live?.players ?? 0;
    el.textContent = !n ? '' : n === 1 ? 'JUST YOU RIGHT NOW' : `${n} PLAYING NOW`;

    const plays = live?.plays;
    const total = Number.isSafeInteger(plays) && plays >= 0 ? plays : null;
    if (this.ui.playCount) {
      this.ui.playCount.textContent = total == null
        ? ''
        : `${total.toLocaleString()} TOTAL ${total === 1 ? 'PLAY' : 'PLAYS'}`;
    }
    if (this.ui.liveStats) {
      this.ui.liveStats.hidden = !el.textContent && !this.ui.playCount?.textContent;
    }
  }

  /** Whether a game hosted right now would be listed for everyone. */
  _visibility() { return this.ui.mpPublic?.checked === false ? 'private' : 'public'; }

  /**
   * Join or host a game. An empty code asks the server for a new room, which is
   * code-only unless the host has deliberately enabled public listing.
   *
   * The world is regenerated from the room's seed before play starts, because
   * every client has to be standing on the same terrain for shared enemy
   * positions to mean anything.
   */
  async startCoop(code, mode = 'coop', visibility = 'private') {
    if (this._connecting) return;
    // Capture the host/join click before the first await. Creating Web Audio
    // only after the socket and world build finish loses transient user
    // activation in Chromium/Safari and leaves co-op music suspended forever.
    this.audio.init();
    this._connecting = true;
    this._mpStatus('Connecting...');

    const name = this.ui.mpName.value.trim() || 'PLAYER';
    writePreference('bs.name', name);

    const net = new NetClient();
    try {
      await net.connect(code, name, mode, visibility);
    } catch (err) {
      this._mpStatus(err.message || 'Could not connect.', 'err');
      this._connecting = false;
      return;
    }

    net.onJoin = (id, who) => this.hud.addFeed(`${who} JOINED`, '#6fe08a');
    net.onLeave = (id, who) => this.hud.addFeed(`${who} LEFT`, '#9aa6b2');
    net.onStatus = (st) => {
      if (st === 'closed' || st === 'error') {
        this.hud.addFeed('DISCONNECTED — RETURNING TO MENU', '#ff6b6b');
        this._toMenu();
      }
    };

    this._mpStatus(`Joined room ${net.room}. Building the world...`, 'ok');
    await this._rebuildWorld(net.seed, net.mode);

    this.net = net;
    // The socket counts this player from here on, so stop beating. Doing both
    // would not double-count -- the server keys presence on the same client id
    // either way -- but there is no reason to pay for a beat nobody reads.
    this.presence?.setConnected(true);

    this.session = new NetSession(net, this.world);
    this._connecting = false;
    this.startGame({ keepSession: true });

    // Only now is the world built and the player standing in it, so only now is
    // it fair for the room to start counting down.
    net.reportReady();

    // A host who opened a public room should be told it is on the list, or the
    // reasonable assumption is that a code is the only way anyone gets in.
    const hosting = !code;
    this.hud.addFeed(
      hosting && visibility === 'public'
        ? `ROOM ${net.room} — LISTED PUBLICLY, OR SHARE THIS CODE`
        : `ROOM ${net.room} — SHARE THIS CODE`,
      '#ffd070');
    // Joining a room that is already fighting is a different situation from
    // opening one, and the player needs to know which they are in before they
    // are shot at. `wave` comes straight from the room's own state.
    const live = (net.wave ?? 0) > 0 && (net.waveBreak ?? 0) <= 0;
    if (live) {
      this.hud.announce(`ROOM ${net.room} — WAVE ${net.wave} IN PROGRESS`, 3.4, '#ff8a3d');
    } else {
      this.hud.announce(`ROOM ${net.room}`, 3.0, '#4db6ff');
    }
    // Both of the above fade, and the feed line scrolls away, so neither can be
    // the only place the code lives -- it is the one string a host has to read
    // out to someone else, possibly minutes after joining.
    this.hud.setRoom(net.room, 1);
  }

  /**
   * Switch the game over to touch controls. Idempotent, because it is reached
   * both from the initial detection and from the mid-session promotion.
   */
  _initTouch() {
    if (this.touch) return;
    this.touchMode = true;
    this.input.enableTouchMode();
    useTouchPrompts(true);
    document.body.classList.add('touch');
    this.touch = new TouchControls(this.input, document.getElementById('touch'));
    // The only way off the battlefield on a phone: there is no Escape key to
    // release a lock that was never taken.
    this.touch.onPause = () => {
      if (this.state === STATE.PLAYING) this.pause();
    };
  }

  /** Regenerate terrain for a new seed and rebuild everything drawn from it. */
  async _rebuildWorld(seed, mode = 'coop') {
    // The map is part of the world's identity, not just the seed. A duel and a
    // horde run on the same seed are different floorplans, so matching seeds
    // alone is not grounds to keep what is already built -- that check used to
    // leave an FFA player walking the co-op complex while the server ran the
    // arena, which reads as every wall being in the wrong place at once.
    const map = mode === 'ffa' ? MAP_ARENA : MAP_COMPLEX;
    if (this.world.seed === (seed | 0) && this.world.mapId === map) return;

    this._clearEnemyMeshes();
    this._clearRemoteMeshes();
    this._disposeImportantButton();
    this._disposeNuggetDispenser();
    this._disposeDinosaurFactory();
    this._disposeReverseAquarium();
    this._disposeDrummerTower();
    this._disposeSpinningCat();
    this._disposeModelFallbacks();

    this.world = new World(seed | 0, { map });
    this.portals.setWorld(this.world);
    this.world.portalSystem = this.portals;
    this._homeWorldSeed = this.world.seed;
    for (const _ of this.world.generate()) { /* drain */ }

    this.terrain.dispose?.();
    this.propRenderer.dispose?.();
    // Cached from the first build, so joining a lobby does not re-decode six
    // photographs to arrive at arrays it already has.
    this.terrain = new TerrainMesh(this.scene, this.world.field, this._terrainTextures);
    this.terrain.build();
    this.propRenderer = new PropRenderer(this.scene, this.world);
    this.propRenderer.build();
    this._mountModelFallbacks();

    // The complex too, and the lamps in it.
    //
    // This used to rebuild the ground and leave the building standing, which
    // is the worst possible half of the job: joining a room on another seed
    // gave you one floorplan to look at and a different one to walk through.
    // Every wall was in the wrong place, so they read as invisible walls and
    // as rooms you could see into and not enter.
    this.buildings?.dispose?.();
    this.buildings = new BuildingRenderer(this.scene, this.world);
    this.buildings.build();
    this._lightInteriors();
    this._disposeWorldModels();
    this._mountNuggetDispenser();
    await this._mountDinosaurFactoryFallback();
    this._mountDrummerTower();

    // The player and everything that queries terrain must follow the new world.
    this.player.world = this.world;
    await this._createTravel();
    await this._loadRequiredWorldArt();
  }

  /** Rebind the optional flight layer whenever a generated world is replaced. */
  _createTravel() {
    this.travel?.dispose();
    this.travel = new InterplanetaryTravel(this.scene, this.camera, this.player, this.world, {
      terrain: this.terrain, sky: this.sky, sun: this.sun, fill: this.fill, audio: this.audio,
      viewmodel: this.viewmodel, deferAssets: true,
    });
    this.travel.onPrepareSurface = (planet) => this._preparePlanetSurface(planet);
    this.travel.onLanded = (planet, landing) => {
      // Clear the flight card inside the same tick that transfers us back to
      // boots-on-ground play. This makes the return feel decisive even on a
      // frame where the simulation has just crossed the atmosphere boundary.
      this.hud.setTravel(null);
      this._spawnPlanetHostiles(planet, landing);
    };
    this.travel.onBananaCharged = ({ fresh }) => {
      this.hud.announce(fresh ? 'SHIP BANANAFIED!' : 'BANANA CHARGE RESTORED', 2.1, '#ffe04a');
      this.hud.addFeed('LAND AND DISEMBARK TO ARM THE BANANA GUN', '#ffe04a');
    };
    this.travel.onBananaStart = ({ duration }) => {
      this.hud.announce('BANANA GUN ACTIVE', 2.1, '#ffe04a');
      this.hud.addFeed(`BANANA BOOMERANG — ${duration} SECONDS`, '#ffe04a');
    };
    this.travel.onBananaEnd = () => {
      this.hud.addFeed('BANANA GUN EXPIRED', '#b7c1c8');
      this.audio.potionEnd();
    };
    this.travel.onSnailHit = () => {
      this.hud.announce('SNAIL KNOCKED BACK', 1.15, '#ffe04a');
    };
    this.travel.getBananaTargets = () => this.enemies;
    this.travel.onBananaEnemyHit = ({ enemy, damage, point, origin }) => {
      const result = this.session.damageEnemy(enemy, damage, {
        scoreScale: 1,
        origin,
      });
      this.stats.hits += 1;
      this.stats.damage += damage;
      this._showDamage(enemy, damage, false);
      this.hud.hitmarker(!!result?.killed);
      this.effects.fleshImpact(point.x, point.y, point.z, 0, 0.25, -1, false);
      this.audio.hit(point);
    };
    this.travel.onSnailCaught = () => {
      this.audio.snailCaught();
      this.hud.announce('THE SNAIL CAUGHT YOU', 1.4, '#ff5a4d');
      this.player.kill('inevitable-snail');
    };
    return this.travel.ready;
  }

  _loadSkyEnvironment() {
    if (!this._skyEnvironmentPromise) {
      this._skyEnvironmentPromise = applySkyEnvironment(
        this.scene, this.renderer, 'overcast',
      ).then((used) => {
        this.envSource = used;
        return used;
      }).catch((error) => {
        console.warn('Photographed sky unavailable; keeping studio environment', error);
        return false;
      });
    }
    return this._skyEnvironmentPromise;
  }

  /**
   * Resolve every downloaded world visual before a run can start.
   *
   * Decodes stay serial, with a browser yield between them. This preserves the
   * cross-browser responsiveness fix without revealing procedural backups.
   */
  async _loadRequiredWorldArt({ onStep = () => {}, yieldFrame = null } = {}) {
    if (this._optionalArtWorld !== this.world) {
      this._optionalArtWorld = this.world;
      this._optionalArtDone.clear();
    }
    const pause = yieldFrame ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
    const steps = [
      ['hazards', 'hazard art', () => this.travel?.loadHazardAssets()],
      ['button', 'wall button', () => this._mountImportantButton()],
      ['cat', 'spinning cat', () => this._mountSpinningCat()],
      ['soldier', 'multiplayer soldier', async () => {
        if (await preloadRemotePlayerModel()) console.log('[assets] skinned multiplayer soldier');
      }],
      ['factory', 'dinosaur factory', () => this._mountDinosaurFactory()],
      ['tower', 'tower performance', () => this.drummerTower?.loadAssets()],
      ['props', 'world props', () => this._mountWorldModels()],
      ['spacecraft', 'detailed spacecraft', () => this.travel?.loadDetailedShip()],
      ['sky', 'sky environment', () => this._loadSkyEnvironment()],
      ['aquarium', 'reverse aquarium', () => this._mountReverseAquarium()],
    ];

    for (let index = 0; index < steps.length; index++) {
      const [key, label, work] = steps[index];
      onStep(index, steps.length, label);
      try { await work(); }
      catch (error) { console.warn(`Required ${label} unavailable; leaving its visual empty`, error); }
      this._optionalArtDone.add(key);
      await pause();
    }
  }

  /**
   * Upgrade fallbacks one at a time after the first playable frames.
   *
   * Firefox and WebKit both perform much of glTF/image decoding on the main
   * thread. Launching the cat, snail, button, weapons, tower and prop pack in
   * parallel made a successful menu click look exactly like a frozen page.
   */
  _scheduleOptionalWorldArt(delay = 900) {
    if (this._optionalArtWorld !== this.world) {
      this._optionalArtWorld = this.world;
      this._optionalArtDone.clear();
    }
    const run = ++this._optionalArtRun;
    if (this._optionalArtTimer) clearTimeout(this._optionalArtTimer);
    this._optionalArtTimer = setTimeout(() => {
      this._optionalArtTimer = null;
      void this._loadOptionalWorldArt(run);
    }, delay);
  }

  async _loadOptionalWorldArt(run) {
    const mountedWorld = this.world;
    const sameWorld = () => mountedWorld === this.world && mountedWorld === this._optionalArtWorld;
    const current = () => run === this._optionalArtRun && sameWorld()
      && this.state === STATE.PLAYING;
    const step = async (key, label, work) => {
      if (!current()) return false;
      if (this._optionalArtDone.has(key)) return true;
      try { await work(); }
      catch (error) { console.warn(`Optional ${label} unavailable; keeping fallback`, error); }
      // Completing a decode while the pause menu opens is still completion.
      // Record it against the world so resume continues at the next batch
      // instead of destroying and rebuilding live landmarks.
      if (sameWorld()) this._optionalArtDone.add(key);
      // Let input, simulation, and a rendered frame run between heavyweight
      // decode batches instead of forming one long unresponsive task train.
      await new Promise((resolve) => setTimeout(resolve, 60));
      return current();
    };

    if (!(await step('hazards', 'hazard art', () => this.travel?.loadHazardAssets()))) return;
    if (!(await step('button', 'wall button', () => this._mountImportantButton()))) return;
    if (!(await step('cat', 'spinning cat', () => this._mountSpinningCat()))) return;
    if (this.session?.multiplayer
      && !(await step('soldier', 'multiplayer soldier', async () => {
        if (await preloadRemotePlayerModel()) {
          console.log('[assets] skinned multiplayer soldier');
          this._upgradeRemotePlayerMeshes();
        }
      }))) return;
    if (!(await step('factory', 'dinosaur factory', () => this._mountDinosaurFactory()))) return;
    if (!(await step('tower', 'tower performance', () => this.drummerTower?.loadAssets()))) return;
    if (!(await step('props', 'world props', () => this._mountWorldModels()))) return;
    if (!(await step('spacecraft', 'detailed spacecraft', () => this.travel?.loadDetailedShip()))) return;
    if (!(await step('weapons', 'weapon models', () => this._adoptWeapons()))) return;
    if (!(await step('sky', 'sky environment', () => this._loadSkyEnvironment()))) return;
    await step('aquarium', 'reverse aquarium', () => this._mountReverseAquarium());
  }

  _cancelOptionalWorldArt() {
    this._optionalArtRun++;
    if (this._optionalArtTimer) clearTimeout(this._optionalArtTimer);
    this._optionalArtTimer = null;
  }

  /** Replace already-created co-op fallbacks after the real soldier loads. */
  _upgradeRemotePlayerMeshes() {
    if (!this.session?.multiplayer) return;
    for (const remote of this.session.remotes ?? []) {
      if (!remote.group) continue;
      this.scene.remove(remote.group);
      disposeRemotePlayerMesh(remote.group);
      remote.group = null;
    }
    this._reconcileMeshes();
  }

  /**
   * Build the destination's actual playable world before touchdown.
   *
   * Solo can change deterministic terrain locally. A network room cannot: its
   * server owns one shared collision world, so it keeps the existing surface
   * and still receives the safe in-bounds fallback from the planet definition.
   */
  _preparePlanetSurface(planet) {
    if (!this.session || this.session.multiplayer || !['cinder', 'nyx'].includes(planet.id)) return null;
    if (this.world.planetProfile === planet.id) {
      return { world: this.world, terrain: this.terrain, landing: this.world.landing };
    }

    const salt = planet.id === 'cinder' ? 0x43494e44 : 0x4e595831;
    const next = new World((this._homeWorldSeed ^ salt) | 0, { map: MAP_COMPLEX, planet: planet.id });
    for (const _ of next.generate()) { /* drain before rendering or collision */ }
    this._dressPlanetOutpost(next, planet.id);

    // All of these objects are tied to coordinates in the outgoing world.
    this._clearEnemyMeshes();
    this._disposeImportantButton();
    this._disposeNuggetDispenser();
    this._disposeDinosaurFactory();
    this._disposeReverseAquarium();
    this._disposeDrummerTower();
    this._disposeSpinningCat();
    this._disposeModelFallbacks();
    for (const c of this.chests) { this.scene.remove(c.mesh); c.dispose(); }
    this.chests.length = 0;
    if (this.mysteryBox) {
      this.scene.remove(this.mysteryBox.mesh);
      this.mysteryBox.dispose();
      this.mysteryBox = null;
    }

    const sim = this.session.sim;
    sim.enemies.length = 0;
    sim.spawnQueue.length = 0;
    sim.world = next;
    sim.nav = null;

    this.terrain.dispose?.();
    this.propRenderer.dispose?.();
    this.buildings?.dispose?.();
    this._disposeWorldModels();

    this.world = next;
    this.portals.setWorld(next);
    this.world.portalSystem = this.portals;
    this.player.world = next;
    this.travel.world = next;
    this.terrain = new TerrainMesh(this.scene, next.field, this._terrainTextures);
    this.terrain.build();
    this.travel.terrain = this.terrain;
    this.propRenderer = new PropRenderer(this.scene, next);
    this.propRenderer.build();
    this._mountModelFallbacks();
    this.buildings = new BuildingRenderer(this.scene, next);
    this.buildings.build();
    this._mountDrummerTower();
    this._lightInteriors();
    this._mountNuggetDispenser();
    void this._mountDinosaurFactoryFallback();

    this._resetStones();
    this._addChests(Math.min(7, CHEST_START_COUNT));
    this._placeMysteryBox();
    if (this.state === STATE.PLAYING) this._scheduleOptionalWorldArt(250);
    return { world: next, terrain: this.terrain, landing: next.landing };
  }

  /** Reuse installed, textured prop models to give each outpost its own plan. */
  _dressPlanetOutpost(world, id) {
    const l = world.landing;
    if (!l) return;
    const pieces = id === 'cinder' ? [
      ['modular_industrial_pipes_01', l.x + 1, l.z - 15, 7.2, 3.0, 3.2, 0],
      ['portable_generator', l.x - 5, l.z + 14, 2.8, 1.8, 2.0, Math.PI / 2],
      ['Barrel_01', l.x + 6, l.z + 15, 0.9, 1.0, 0.9, 0],
      ['kit_lightpole', l.x + 7, l.z - 13, 0.7, 5.0, 0.7, 0],
    ] : [
      ['covered_car', l.x - 15, l.z + 2, 4.6, 2.0, 2.2, Math.PI / 2],
      ['portable_searchlight', l.x + 14, l.z - 2, 1.8, 2.2, 1.8, -Math.PI / 4],
      ['industrial_storage_cart', l.x - 13, l.z + 9, 2.2, 1.8, 1.3, Math.PI / 2],
      ['kit_lightpole', l.x + 13, l.z + 8, 0.7, 5.0, 0.7, 0],
    ];
    for (const [model, x, z, sx, sy, sz, rot] of pieces) {
      world._placeKit({ model, sx, sy, sz }, x, z, rot);
    }
    world._index();
  }

  /** Populate a landed destination with its own immediate combat encounter. */
  _spawnPlanetHostiles(planet, landing) {
    // Co-op enemies are server-authoritative. Solo owns its GameSim, so these
    // enemies use the normal combat, kill rewards, meshes and collision path.
    const sim = this.session?.sim;
    if (!sim || !planet.creatures?.length) return;

    for (let i = 0; i < planet.creatures.length; i++) {
      const enemy = sim.spawnEnemy(planet.creatures[i]);
      // Find a genuine clear patch around the pad, rather than accepting the
      // simulation's default spawn if a tree or a rock happens to occupy the
      // cinematic encounter ring.
      for (let attempt = 0; attempt < 12; attempt++) {
        const baseAngles = planet.id === 'cinder'
          ? [-1.28, 1.28, 0.02]
          : [0.05, Math.PI - 0.05, 0.58, Math.PI - 0.58];
        const a = baseAngles[i % baseAngles.length] + attempt * 0.47;
        const r = 21 + (i % 2) * 4 + (attempt % 3) * 2;
        const x = THREE.MathUtils.clamp(landing.x + Math.cos(a) * r, 3, this.world.size - 3);
        const z = THREE.MathUtils.clamp(landing.z + Math.sin(a) * r, 3, this.world.size - 3);
        const y = this.world.heightAt(x, z);
        if (Math.hypot(x - this.player.pos.x, z - this.player.pos.z) < 14) continue;
        if (!this.world.blocksAt(x, y, z, enemy.half, enemy.type.height)) {
          enemy.relocate(x, y, z);
          break;
        }
      }
    }
    this.hud.announce(`${planet.name} HOSTILES`, 2.6, planet.id === 'cinder' ? '#ff9a5a' : '#a8cfff');
    this.hud.addFeed(`LANDING PARTY DETECTED — ${planet.creatures.length} CONTACTS`, '#ffd070');
  }

  /** Load render-only world props without making the menu wait for them. */
  _mountWorldModels() {
    this._disposeWorldModels();
    const request = ++this._modelsRequest;
    const mountedWorld = this.world;
    return mountModels(this.scene, mountedWorld, {
      isCurrent: () => request === this._modelsRequest && mountedWorld === this.world,
      onMounted: (prop) => this._modelFallbacks?.hide(prop),
      onDiscarded: (prop) => this._modelFallbacks?.show(prop),
    }).then((added) => {
      if (request !== this._modelsRequest || mountedWorld !== this.world) {
        disposeModels(this.scene, added);
        return;
      }
      this._models = added;
    }).catch((error) => {
      if (request === this._modelsRequest) {
        console.warn('Optional world models unavailable; keeping authored colliders', error);
      }
    });
  }

  _disposeWorldModels() {
    this._modelsRequest++;
    disposeModels(this.scene, this._models);
    this._models = [];
  }

  _mountModelFallbacks() {
    this._disposeModelFallbacks();
    this._modelFallbacks = mountModelFallbacks(this.scene, this.world);
  }

  _disposeModelFallbacks() {
    this._modelFallbacks?.dispose();
    this._modelFallbacks = null;
  }

  /** Mount the collision-free emergency button on the current start-room wall. */
  async _mountImportantButton() {
    this._disposeImportantButton();
    const request = ++this._importantButtonRequest;
    const mountedWorld = this.world;
    const button = await createInertButton(mountedWorld);
    if (request !== this._importantButtonRequest || mountedWorld !== this.world) {
      button?.dispose();
      return;
    }
    this.importantButton = button;
    if (button) this.scene.add(button.mesh);
  }

  _disposeImportantButton() {
    this._importantButtonRequest++;
    if (!this.importantButton) return;
    this.scene.remove(this.importantButton.mesh);
    this.importantButton.dispose();
    this.importantButton = null;
  }

  /** Mount the detailed interactive art over its world-authored collider. */
  _mountNuggetDispenser() {
    this._disposeNuggetDispenser();
    this.nuggetDispenser = createNuggetDispenser(this.world);
    if (this.nuggetDispenser) this.scene.add(this.nuggetDispenser.mesh);
  }

  _disposeNuggetDispenser() {
    if (!this.nuggetDispenser) return;
    this.scene.remove(this.nuggetDispenser.mesh);
    this.nuggetDispenser.dispose();
    this.nuggetDispenser = null;
  }

  /** Mount the cloning bank and its animated companion over its world collider. */
  async _mountDinosaurFactory() {
    const request = ++this._dinosaurFactoryRequest;
    const mountedWorld = this.world;
    let factory = null;
    try {
      factory = await createDinosaurFactory(mountedWorld);
    } catch (error) {
      if (request === this._dinosaurFactoryRequest) {
        console.warn('Dinosaur factory art unavailable; skipping landmark', error);
      }
      return;
    }
    if (request !== this._dinosaurFactoryRequest || mountedWorld !== this.world) {
      factory?.dispose();
      return;
    }
    // Never erase a hatch/companion that the player has already paid for just
    // because its optional FBX finished later. The procedural entity remains
    // a fully functional implementation for the rest of this world.
    const previous = this.dinosaurFactory;
    if (previous && (previous.producing || previous.ally?.mode !== 'stored')) {
      factory?.dispose();
      return;
    }
    if (previous) {
      this.scene.remove(previous.mesh);
      previous.dispose();
    }
    this.dinosaurFactory = factory;
    if (factory) this.scene.add(factory.mesh);
  }

  /** Install the no-download factory so its interaction exists at READY. */
  async _mountDinosaurFactoryFallback() {
    const request = ++this._dinosaurFactoryRequest;
    const mountedWorld = this.world;
    const factory = await createDinosaurFactory(mountedWorld, {
      asset: { model: null, clips: [], skinTexture: null },
    });
    if (request !== this._dinosaurFactoryRequest || mountedWorld !== this.world) {
      factory?.dispose();
      return;
    }
    if (this.dinosaurFactory) {
      this.scene.remove(this.dinosaurFactory.mesh);
      this.dinosaurFactory.dispose();
    }
    this.dinosaurFactory = factory;
    if (factory) this.scene.add(factory.mesh);
  }

  _disposeDinosaurFactory() {
    this._dinosaurFactoryRequest++;
    if (!this.dinosaurFactory) return;
    this.scene.remove(this.dinosaurFactory.mesh);
    this.dinosaurFactory.dispose();
    this.dinosaurFactory = null;
  }

  /** Mount the ceiling conduit and its locally animated CC0 fish school. */
  async _mountReverseAquarium() {
    this._disposeReverseAquarium();
    const request = ++this._reverseAquariumRequest;
    const mountedWorld = this.world;
    let aquarium = null;
    try {
      aquarium = await createReverseAquarium(mountedWorld);
    } catch (error) {
      if (request === this._reverseAquariumRequest) {
        console.warn('Reverse aquarium assets unavailable; skipping landmark', error);
      }
      return;
    }
    if (request !== this._reverseAquariumRequest || mountedWorld !== this.world) {
      aquarium?.dispose();
      return;
    }
    this.reverseAquarium = aquarium;
    if (aquarium) this.scene.add(aquarium.mesh);
  }

  _disposeReverseAquarium() {
    this._reverseAquariumRequest = (this._reverseAquariumRequest ?? 0) + 1;
    if (!this.reverseAquarium) return;
    this.scene.remove(this.reverseAquarium.mesh);
    this.reverseAquarium.dispose();
    this.reverseAquarium = null;
  }

  /** Mount the central tower and its locally animated rooftop performance. */
  _mountDrummerTower() {
    this._disposeDrummerTower();
    this.drummerTower = createDrummerTower(this.world, { deferAssets: true });
    if (this.drummerTower) this.scene.add(this.drummerTower.mesh);
    const mounted = this.drummerTower;
    return (mounted?.ready ?? Promise.resolve(null)).then((renderer) => {
      if (renderer && this.drummerTower === mounted) {
        // Transparent, depth-less banana instances are presentation, not AO
        // occluders. Excluding them avoids drawing all 320 twice per frame.
        for (const rain of renderer.bananaRainMeshes ?? []) {
          if (!this.ssaoPass.exclude.includes(rain)) this.ssaoPass.exclude.push(rain);
        }
      }
      return renderer;
    });
  }

  _disposeDrummerTower() {
    if (!this.drummerTower) return;
    const rain = new Set(this.drummerTower.bananaRainMeshes ?? []);
    if (rain.size) this.ssaoPass.exclude = this.ssaoPass.exclude.filter((object) => !rain.has(object));
    this.scene.remove(this.drummerTower.mesh);
    this.drummerTower.dispose();
    this.drummerTower = null;
  }

  /** Mount the 2D-GIF-to-3D-cat reveal in its selected ordinary room. */
  async _mountSpinningCat() {
    this._disposeSpinningCat();
    const request = ++this._spinningCatRequest;
    const mountedWorld = this.world;
    const cat = await createSpinningCat(mountedWorld);
    if (request !== this._spinningCatRequest || mountedWorld !== this.world) {
      cat?.dispose();
      return;
    }
    this.spinningCat = cat;
    if (cat) this.scene.add(cat.mesh);
  }

  _disposeSpinningCat() {
    this._spinningCatRequest++;
    if (!this.spinningCat) return;
    this.scene.remove(this.spinningCat.mesh);
    this.spinningCat.dispose();
    this.spinningCat = null;
  }

  _toMenu() {
    this._cancelOptionalWorldArt();
    this.state = STATE.MENU;
    this.audio.stopFlamethrower();
    this.audio.stopDrummer();
    this.input.exitLock();
    this._clearEnemyMeshes();
    this._clearRemoteMeshes();
    this.session?.disconnect();
    this.session = null;
    this.net = null;
    // Back on our own again: no socket is reporting this player, so resume.
    this.presence?.setConnected(false);
    this.hud.setRoom(null);
    this.hud.hide();
    this.ui.overlay.classList.remove('hidden');
    this._showMenuPanel('menu');
    this.ui.panelPause.classList.add('hidden');
    this.ui.panelDead.classList.add('hidden');
    this.refreshRooms();
  }

  /**
   * Bring up saved data and the shop.
   *
   * Guest play is the default and needs nothing: a profile exists from the
   * first launch, saved to this browser. If a Supabase project is configured
   * and a previous session is still valid, the account's data is merged over
   * the top. Neither path is allowed to keep the player out of the game -- a
   * failure here costs cloud sync, not the run.
   */
  async _initProfile() {
    const cfg = supabaseConfig();
    this.supabase = cfg.url && cfg.anonKey ? new Supabase(cfg.url, cfg.anonKey) : null;

    if (this.supabase) {
      try {
        await this.supabase.restore();
      } catch { /* expired or offline: carry on as a guest */ }
    }

    this.profile = new ProfileStore(this.supabase);
    await this.profile.load();

    this.accountUI = new AccountUI(this.profile, this.supabase, {
      onEquip: () => this._refinishWeapons(),
      finishes: this._finishStore(),
    });

    // Whatever the profile says is worn goes back on after every rebuild, not
    // just now. Changing a finish rebuilds the models from the factory palette,
    // which is what used to strip a bought skin off the gun without telling
    // anyone.
    this.viewmodel.onRefinish = () => this._refinishWeapons();
    this._refinishWeapons();

    // Re-run after a camo change, because that rebuilds from BUILDERS. The
    // initial adoption is scheduled after gameplay starts with the other
    // optional art, so a clickable menu never competes with fifteen model
    // decoders.
    this.viewmodel.onReadopt = () => this._adoptWeapons();
  }

  /** Put photographed weapons in the player's hands. Never throws. */
  async _adoptWeapons() {
    try {
      const swapped = await adoptWeaponModels(this.viewmodel);
      if (swapped.length) {
        this._refinishWeapons();
        console.log(`[assets] ${swapped.length} photographed weapons: ${swapped.join(', ')}`);
      }
    } catch (err) {
      console.warn('[assets] weapon adoption failed, keeping built models:', err?.message ?? err);
    }

    try {
      // Ground loot is a world-space presentation of the same resolved model,
      // not a second opinion about what each gun looks like. Register every
      // slot, including procedural-only sci-fi weapons, after cosmetics have
      // been restored so the dropped gun matches the one the player will hold.
      for (const [id, model] of Object.entries(this.viewmodel.models)) {
        installPickupWeaponModel(id, model);
      }
      for (const pickup of this.pickups) pickup.refreshWeaponVisual();
    } catch (err) {
      console.warn('[assets] pickup model sync failed:', err?.message ?? err);
    }
  }

  /**
   * Compile and upload the starting gun while the opaque loading curtain is
   * still present. Fetch completion alone is not enough: otherwise its first
   * shader compile and texture upload happen on the first playable frame.
   */
  async _warmStartingWeapon() {
    const id = this.weapons.def.id;
    this.viewmodel.setWeapon(id);
    const model = this.viewmodel.model;
    if (!model || model.userData.replacementPending) {
      this.viewmodel.setWeapon(null);
      return;
    }

    model.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        for (const value of Object.values(material)) {
          if (value?.isTexture) this.renderer.initTexture(value);
        }
      }
    });
    if (typeof this.renderer.compileAsync === 'function') {
      await this.renderer.compileAsync(this.viewmodel.scene, this.viewmodel.camera);
    } else {
      this.renderer.compile(this.viewmodel.scene, this.viewmodel.camera);
    }
    this.viewmodel.setWeapon(null);
  }

  // ------------------------------------------------------------ state moves

  startGame(opts = {}) {
    if (!this.assetsReady) return false;
    this.audio.init();
    this.audio.stopDrummer();

    // Hand back the outgoing session's meshes before the session itself is
    // replaced -- once the enemy list is gone, so is the only reference to
    // the meshes standing in the scene.
    this._clearEnemyMeshes();

    // A new run starts from authored world state, not from whichever doors and
    // windows the last run happened to leave open. A kept network session owns
    // its room's state and must not be locally rewound while joining it.
    const freshRun = !opts.keepSession || !this.session;
    if (freshRun) {
      this.world.resetRunState?.();
      this.drummerTower?.reset();
      this.buildings.syncDoors?.(this.world.doors());
      this.buildings.syncBoards?.(this.world.barriers, 0);
      this.buildings.syncSecrets?.(this.world.props.filter((p) => p.secret));
      this._secretOpened = false;
    }

    // Solo play gets a simulation ticked right here. Co-op has already built a
    // networked one pointing at the server, so leave it alone.
    if (!opts.keepSession || !this.session) {
      this.session?.disconnect();
      this._clearRemoteMeshes();
      this.session = new LocalSession(this.world, this.world.seed);
    }

    // Reset everything -- the same path serves first launch and replay.
    this.enemyPool.length = 0;
    for (const r of this.rockets) this.scene.remove(r.mesh);
    this.rockets.length = 0;
    for (const pk of this.pickups) this.scene.remove(pk.mesh);
    this.pickups.length = 0;
    for (const s of this.strikes) if (s.marker) this.scene.remove(s.marker);
    this.strikes.length = 0;
    for (const c of this.chests) { this.scene.remove(c.mesh); c.dispose(); }
    this.chests.length = 0;
    if (this.mysteryBox) {
      this.scene.remove(this.mysteryBox.mesh);
      this.mysteryBox.dispose();
      this.mysteryBox = null;
    }
    this.potions.clear();
    this.importantButton?.reset();
    this.nuggetDispenser?.reset();
    this.dinosaurFactory?.reset();
    this.reverseAquarium?.reset();
    this.spinningCat?.reset();
    this.waypoint = null;
    this.trailTimer = 0;
    this._trackersShown = false;
    this.effects.clear();
    this.portals.setWorld(this.world);
    this.portals.clear();

    this.weapons.reset();
    // ...then, in a duel, throw that away for the loadout. reset() still runs
    // first because it clears the timers and multipliers a run carries, and
    // applyLoadout only owns which weapons are in hand.
    this._applyLoadout();
    // Local capture shortcut: normal solo progression is untouched, but the
    // recording URL can begin with the Intervention already shouldered. It is
    // deliberately query-gated and still requires the normal consent/play
    // click, so it cannot silently alter an ordinary run or bypass the menu.
    const showcase = new URLSearchParams(location.search).get('showcase');
    const showcasingIntervention = !this.session.isFFA && showcase === 'intervention';
    if (showcasingIntervention) {
      this.weapons.applyLoadout(['sniper', 'pistol', 'pickaxe']);
    }
    // The run begins sealed inside the start room, not on open ground -- the
    // first thing the player buys is the way out of it.
    // A restart on another planet begins at that world's authored berth, not
    // inside the newly generated facility with the ship clipped through its
    // ceiling. Verdant keeps the original sealed-room opening.
    const spawn = this.world.landing ?? this._startSpawn() ?? this.world.findSpawn();
    this.player.spawn(spawn);
    this.player.yaw = 0;
    if (!this.world.landing) {
      const airlock = this.world.props.find((p) => p.escape);
      if (airlock) this.player.yaw = Math.atan2(-(airlock.x - spawn.x), -(airlock.z - spawn.z));
    }
    this.player.pitch = 0;
    this.travel?.reset(spawn);

    this.session.reset();
    // Count only after the run owns a reset session and a spawned player. The
    // request is deliberately not awaited, so a slow analytics store can never
    // delay gameplay. Retries reuse one anonymous run id and remain exactly-once.
    this.presence?.recordPlay();
    this.shop.close();
    this.shake.reset();
    this.dmgNumbers.clear();
    this.runStarted = performance.now();
    this.vitality = 0;
    this.player.maxHealth = 100;
    this.stats = { shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0, bosses: 0 };
    this.deathCause = '';
    this.bossId = null;
    this.lastEarned = 0;
    this._numAnchors.clear();
    this.streak.reset();
    this.collectedStones.clear();

    // Stones depend on the spawn point, so place them after the player moves.
    this._resetStones();
    // Chests are placed after the stones so they can avoid burying one.
    this._addChests(CHEST_START_COUNT);
    this._placeMysteryBox();

    this.hud.reset();
    this.hud.show();
    this.hud.buildGems(STONES);
    this._refreshWeaponList();
    this.hud.setScore(0);
    this.hud.announce(showcasingIntervention ? 'INTERVENTION SHOWCASE' : 'SURVIVE', 1.6);
    this.hud.addFeed(
      `CHESTS MARKED ON HUD — ${pressWord()} ${ctrl('interact')} TO OPEN`, '#ffd070');

    this.ui.overlay.classList.add('hidden');
    this.ui.panelMenu.classList.add('hidden');
    this.ui.panelDead.classList.add('hidden');
    this.ui.panelPause.classList.add('hidden');
    this.ui.panelShop.classList.add('hidden');
    this.ui.panelAuth.classList.add('hidden');
    // RELEASE 0.0.0 belongs only to the website's initial menu. Mark it spent
    // when a run begins so revealing the overlay for pause or quit cannot
    // surface it over gameplay.
    this._patchnotesDismissed = true;
    this._setPatchnotesVisible(false);

    this.state = STATE.PLAYING;
    this.acc = 0;
    this.input.clear();
    this.input.requestLock();
    return true;
  }

  pause() {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.PAUSED;
    this.audio.stopMusic();
    this.audio.stopFlamethrower();
    this.audio.stopDrummer();
    this.input.exitLock();
    this._setPatchnotesVisible(false);
    this.ui.pauseStats.innerHTML = this._statsHTML();
    this.ui.overlay.classList.remove('hidden');
    this.ui.panelPause.classList.remove('hidden');
  }

  resume() {
    if (this.state !== STATE.PAUSED) return;
    // The resume button is another guaranteed user gesture, so use it to wake
    // an AudioContext the browser may have suspended while the game was paused.
    this.audio.init();
    this.state = STATE.PLAYING;
    this.acc = 0;
    this.ui.overlay.classList.add('hidden');
    this.ui.panelPause.classList.add('hidden');
    this.input.clear();
    this.input.requestLock();
    this._scheduleOptionalWorldArt(250);
  }

  gameOver() {
    if (this.state === STATE.DEAD) return;
    this.state = STATE.DEAD;
    this.audio.stopMusic();
    this.audio.stopFlamethrower();
    this.audio.stopDrummer();

    const beat = this.progress.recordRun({
      score: this.score,
      wave: this.wave,
      kills: this.stats.kills,
      headshots: this.stats.headshots,
      bosses: this.stats.bosses,
      seconds: (performance.now() - (this.runStarted || performance.now())) / 1000,
    });
    if (beat.score) this.hud.addFeed('NEW BEST SCORE', '#ffd24a');
    this.audio.playerDie();
    this.input.exitLock();

    // Bank the run before the summary is built, so the credits it paid out can
    // be part of what the player reads.
    this.lastEarned = this.profile?.recordRun({
      score: this.score, wave: this.wave, kills: this.stats.kills,
    }) ?? 0;
    this.accountUI?.refresh();

    this.ui.deadStats.innerHTML = this._statsHTML() + this._recordHTML();
    this.ui.overlay.classList.remove('hidden');
    this.ui.panelDead.classList.remove('hidden');
    this.hud.announce('', 0);
    // _updateHUD stops running on death, so these would otherwise freeze on
    // screen behind the menu.
    this.hud.setPrompt('');
    this.hud.setWaypoint(null);
    this.hud.setChestMarks([]);
    this.hud.setBoss(null);
  }

  /** The lifetime record, appended under a run summary. */
  _recordHTML() {
    const html = this.progress.summaryHTML();
    return html ? `<hr class="statrule">${html}` : '';
  }

  _statsHTML() {
    const acc = this.stats.shots > 0 ? (this.stats.hits / this.stats.shots * 100) : 0;
    // Only the death summary has earnings to report; the pause screen is the
    // same stats mid-run, when nothing has been banked yet.
    const earned = this.state === STATE.DEAD && this.lastEarned > 0
      ? `<br>EARNED <b>${this.lastEarned.toLocaleString()} CR</b>`
      : '';
    const cause = this.state === STATE.DEAD && this.deathCause
      ? `<br>CAUGHT BY <b>${this.deathCause}</b>`
      : '';
    return `
      SCORE <b>${this.score}</b><br>
      WAVE <b>${Math.max(1, this.wave)}</b><br>
      KILLS <b>${this.stats.kills}</b><br>
      HEADSHOTS <b>${this.stats.headshots}</b><br>
      ACCURACY <b>${acc.toFixed(1)}%</b>${earned}${cause}
    `;
  }

  // ----------------------------------------------------------------- combat

  _resolveShot(weaponInstance, shots) {
    const def = weaponInstance.def;
    const p = this.player;
    const origin = { x: p.pos.x, y: p.eyeY, z: p.pos.z };

    // Streak tier and potion perks are independent multipliers on the same
    // outgoing damage, so they compound.
    // Damage is dealt through the session: locally that applies it straight
    // away, in co-op it also reports the hit upward for the server to score.
    // In a free-for-all the other players are targets too, traced in the same
    // pass as the zombies. One pass rather than two is what makes a player
    // standing behind a zombie actually be behind it, instead of both taking
    // the same bullet.
    const pvp = this.session.pvpTargets;
    const targets = pvp.length ? this.enemies.concat(pvp) : this.enemies;

    const shotWorld = this.portals.ready ? this.portals : this.world;
    const result = resolveFire(shotWorld, targets, origin, shots, def,
      this.streak.tier.damage * this.potions.mods.damage * this.weapons.damageMultiplier,
      (target, amount, headshot) => {
        // A hit player is reported and never resolved here; the server owns the
        // frag. Everything else is a zombie and takes the co-op path.
        if (target.type?.id === 'player') {
          this.session.hitPlayer(target, amount, { headshot });
          return false;
        }
        return this.session.damageEnemy(target, amount, {
          headshot, scoreScale: this.streak.tier.damage,
        })?.killed;
      });

    // Tracers start at the muzzle, not the eye, or they look like they come
    // out of the player's forehead.
    const dir = p.getLookDir({});
    const right = { x: -dir.z, y: 0, z: dir.x };
    const rl = Math.hypot(right.x, right.z) || 1;
    const muzzle = {
      x: origin.x + dir.x * 0.7 + (right.x / rl) * 0.18,
      y: origin.y + dir.y * 0.7 - 0.16,
      z: origin.z + dir.z * 0.7 + (right.z / rl) * 0.18,
    };

    let hitSomething = false;
    let killedSomething = false;

    for (let i = 0; i < result.traces.length; i++) {
      const tr = result.traces[i];
      if (def.id === 'flamethrower') {
        // Three turbulent particle ribbons form the flame cone. A tracer is a
        // straight, one-pixel line and made the old effect read as an orange
        // laser; rounded hot volumes and sparse soot have depth and expansion.
        this.effects.flameJet(
          muzzle.x, muzzle.y, muzzle.z, tr.end.x, tr.end.y, tr.end.z);
      } else if (def.pellets === 1 || i % 3 === 0) {
        // One tracer per shot for single-projectile guns, a sample for buckshot.
        // Drawn to where the round stopped, not to what it hit first: a piercing
        // shot that carried through a body has to be seen carrying through it.
        const color = def.beamColor ?? (def.id === 'shotgun' ? 0xffc07a : 0xfff0b0);
        if (tr.path?.length) {
          for (let segment = 0; segment < tr.path.length; segment++) {
            const leg = tr.path[segment];
            const start = segment === 0 ? muzzle : leg.start;
            this.effects.addTracer(start.x, start.y, start.z,
              leg.end.x, leg.end.y, leg.end.z, color, undefined);
          }
        } else {
          this.effects.addTracer(muzzle.x, muzzle.y, muzzle.z,
            tr.end.x, tr.end.y, tr.end.z, color, undefined);
        }
      }

      if (tr.kind === HIT_WORLD) {
        if (def.id === 'flamethrower') {
          this.effects.flameImpact(tr.point.x, tr.point.y, tr.point.z,
            tr.normal.x, tr.normal.y, tr.normal.z);
        } else {
          const color = this._impactColor(tr.prop);
          this.effects.blockImpact(
            tr.point.x + tr.normal.x * 0.02,
            tr.point.y + tr.normal.y * 0.02,
            tr.point.z + tr.normal.z * 0.02,
            tr.normal.x, tr.normal.y, tr.normal.z, color);
        }
      } else if (tr.kind === HIT_ENEMY) {
        const s = shots[i];
        // Every body on the line sprays, or collateral is damage with nothing
        // on screen to explain where it came from.
        for (const h of [tr, ...tr.through]) {
          if (def.id === 'flamethrower') {
            this.effects.flameImpact(h.point.x, h.point.y, h.point.z, -s.x, 0.4, -s.z);
          } else {
            this.effects.fleshImpact(h.point.x, h.point.y, h.point.z, s.x, s.y, s.z, h.headshot);
          }
        }
      }
    }
    if (def.id !== 'flamethrower') {
      const worldHit = result.traces.find((trace) => trace.kind === HIT_WORLD);
      if (worldHit) this.audio.impact(worldHit.point);
    }

    // Shake scales with the weapon: a sniper should move the frame, a pistol
    // should barely register.
    this.shake.add(def.id === 'flamethrower' ? TRAUMA.shot * 0.18
      : def.pellets > 1 || def.damage > 90 ? TRAUMA.shotHeavy : TRAUMA.shot);

    const lifesteal = this.potions.mods.lifesteal;
    for (const hit of result.hits) {
      hitSomething = true;
      this.stats.damage += hit.damage;
      if (hit.headshot) this.stats.headshots += 1;
      if (lifesteal > 0) this.player.heal(hit.damage * lifesteal);
      this._showDamage(hit.enemy, hit.damage, hit.headshot);

      // The kill itself is announced by the simulation, which is what keeps
      // the score identical for everyone in the room. This only notes that
      // something died so the hitmarker can say so.
      if (hit.killed) killedSomething = true;
    }

    if (hitSomething) {
      this.stats.hits += 1;
      this.hud.hitmarker(killedSomething);
      // The firearm report has already started in WeaponSystem._fire. Place the
      // flesh layer at the struck body and a few milliseconds later, so a hit
      // adds a spatial splatter instead of masking the gunshot transient.
      const fleshPoint = result.traces.find((trace) => trace.kind === HIT_ENEMY)?.point ?? null;
      if (killedSomething) this.audio.kill(fleshPoint);
      else if (result.anyHeadshot) this.audio.headshot(fleshPoint);
      else this.audio.hit(fleshPoint);
    }
  }

  // ------------------------------------------------------------- projectiles

  _firePortal(kind, dir) {
    const p = this.player;
    const result = this.portals.place(kind, p, dir);
    const color = kind === 'blue' ? 0x28a9ff : 0xff8b24;
    const hit = result.hit;
    if (hit) {
      this.effects.addTracer(
        p.pos.x, p.eyeY - 0.08, p.pos.z,
        hit.x, hit.y, hit.z, color, 0.045,
      );
    }
    if (!result.ok) {
      this.hud.addFeed(result.reason, '#ff9b72');
      return;
    }
    this.effects.blockImpact(
      hit.x + hit.nx * 0.04, hit.y + hit.ny * 0.04, hit.z + hit.nz * 0.04,
      hit.nx, hit.ny, hit.nz, color,
    );
    if (result.ready) this.hud.addFeed('PORTAL LINK STABLE', '#9eeaff');
  }

  _launchRocket(weaponInstance, dir) {
    const p = this.player;
    const origin = { x: p.pos.x, y: p.eyeY, z: p.pos.z };
    const r = new Rocket(
      origin.x + dir.x * 0.8, origin.y + dir.y * 0.8 - 0.1, origin.z + dir.z * 0.8,
      dir.x, dir.y, dir.z, weaponInstance.def);
    r.mesh = buildRocketMesh();
    r.mesh.position.set(r.x, r.y, r.z);
    this.scene.add(r.mesh);
    this.rockets.push(r);
  }

  _updateRockets(dt) {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      const projectileWorld = this.portals.ready ? this.portals : this.world;
      const impact = r.update(dt, projectileWorld, this.enemies);

      if (r.mesh) {
        r.mesh.position.set(r.x, r.y, r.z);
        // Point the shell along its velocity.
        r.mesh.rotation.y = Math.atan2(r.dx, r.dz);
        r.mesh.rotation.x = -Math.asin(Math.max(-1, Math.min(1, r.dy)));
      }

      if (!impact) continue;

      this.scene.remove(r.mesh);
      this.rockets.splice(i, 1);
      this._detonate(impact.x, impact.y, impact.z, r.def);
    }
  }

  // -------------------------------------------------------------- airstrike

  /**
   * Designate wherever the player is aiming. The strike itself is queued, so
   * there is a beat between the call and the bombs -- that delay is what makes
   * it feel like support fire rather than another gun.
   */
  _callAirstrike(weaponInstance, dir) {
    const def = weaponInstance.def;
    const p = this.player;
    const hit = this.world.raycast(p.pos.x, p.eyeY, p.pos.z,
      dir.x, dir.y, dir.z, def.range);

    const tx = hit.hit ? hit.x : p.pos.x + dir.x * 60;
    const tz = hit.hit ? hit.z : p.pos.z + dir.z * 60;

    this.strikes.push({
      x: tx, z: tz, def,
      timer: def.strikeDelay,
      remaining: def.strikeCount,
      marker: this._spawnStrikeMarker(tx, tz),
    });

    this.audio.designator();
    this.hud.announce('AIRSTRIKE INBOUND', 2.0, '#ff8a3d');
    this.hud.addFeed('STRIKE CALLED', '#ff8a3d');
  }

  _spawnStrikeMarker(x, z) {
    const gy = this.world.heightAt(x, z);
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.CylinderGeometry(4.2, 4.2, 26, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff6a2a, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    ring.position.y = 13;
    g.add(ring);
    g.position.set(x, gy, z);
    this.scene.add(g);
    return g;
  }

  _updateStrikes(dt) {
    for (let i = this.strikes.length - 1; i >= 0; i--) {
      const s = this.strikes[i];
      s.timer -= dt;
      if (s.marker) s.marker.rotation.y += dt * 1.6;
      if (s.timer > 0) continue;

      // Drop one bomb, scattered around the designated point, then re-arm.
      const ang = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * s.def.strikeSpread;
      const bx = s.x + Math.cos(ang) * r;
      const bz = s.z + Math.sin(ang) * r;
      const by = this.world.heightAt(bx, bz) + s.def.strikeHeight;

      const bomb = new Rocket(bx, by, bz, 0, -1, 0, s.def);
      bomb.speed = s.def.strikeSpeed;
      bomb.travelled = 5;          // no muzzle-safety window for a falling bomb
      bomb.mesh = buildRocketMesh();
      bomb.mesh.rotation.x = Math.PI / 2;
      bomb.mesh.position.set(bx, by, bz);
      this.scene.add(bomb.mesh);
      this.rockets.push(bomb);

      s.remaining -= 1;
      s.timer = s.def.strikeInterval;

      if (s.remaining <= 0) {
        if (s.marker) this.scene.remove(s.marker);
        this.strikes.splice(i, 1);
      }
    }
  }

  _detonate(x, y, z, def) {
    const { hits, playerDamage } = applyExplosion(
      this.world, this.enemies, this.player, x, y, z, def,
      this.streak.tier.damage * this.potions.mods.damage * this.weapons.damageMultiplier,
      (enemy, amount) => this.session.damageEnemy(enemy, amount, {
        splash: true, scoreScale: this.streak.tier.damage,
      })?.killed);

    this.audio.explosion({ x, y, z });
    this.effects.explosion(x, y, z, def.splashRadius);
    const shakeDist = Math.hypot(x - this.player.pos.x, z - this.player.pos.z);
    this.shake.add(TRAUMA.explosionFar
      + (TRAUMA.explosionNear - TRAUMA.explosionFar)
        * Math.max(0, 1 - shakeDist / (def.splashRadius * 4)));
    this.hud.damageFlash(playerDamage > 0 ? playerDamage : 6);
    // Shake reads as concussion; reuse the recoil punch channel.
    this.weapons.punchPitch += 0.09;
    this.weapons.punchYaw += (Math.random() - 0.5) * 0.06;

    if (playerDamage > 0) this.player.damage(playerDamage, 'explosion');

    let killed = false;
    const lifesteal = this.potions.mods.lifesteal;
    for (const hit of hits) {
      this.stats.damage += hit.damage;
      if (lifesteal > 0) this.player.heal(hit.damage * lifesteal);
      if (hit.killed) killed = true;   // announced by the simulation
      this._showDamage(hit.enemy, hit.damage, false);
    }
    if (hits.length > 0) {
      this.stats.hits += 1;
      this.hud.hitmarker(killed);
    }
  }

  // ----------------------------------------------------------------- pickups

  /** @param spec see Pickup -- {type, kind, color?, target?, lifetime?} */
  _spawnPickup(spec, x, y, z) {
    // Rest it on whatever surface is under the drop point.
    const gy = this.world.supportHeight(x, z, y + 1, 0.4);

    const pk = new Pickup(spec, x, gy, z);
    this.scene.add(pk.mesh);
    this.pickups.push(pk);
  }

  _updatePickups(dt) {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      const alive = pk.update(dt);

      if (this.player.alive && pk.inRange(this.player)) {
        this._collect(pk);
        this.scene.remove(pk.mesh);
        this.pickups.splice(i, 1);
        continue;
      }

      if (!alive) {
        this.scene.remove(pk.mesh);
        this.pickups.splice(i, 1);
      }
    }
  }

  _collect(pk) {
    if (pk.type === PICKUP_POTION) {
      const def = POTION_BY_ID.get(pk.kind);
      this.potions.apply(def);
      this.audio.drink();
      const color = '#' + def.color.toString(16).padStart(6, '0');
      this.hud.announce(def.name, 1.6, color);
      this.hud.addFeed(`${def.name} — ${def.blurb}`, color);
      this.effects.spawnPuff(pk.x, pk.y + 0.6, pk.z, def.color);
      return;
    }

    if (pk.type === PICKUP_MAP) {
      this._followMap(pk.target);
      return;
    }

    const isNew = this.weapons.pickUp(pk.kind);
    this.audio.pickup();
    const held = this.weapons.weapons.find((w) => w.def.id === pk.kind);
    const def = held.def;
    // Name the key that is actually bound to the slot this pickup just claimed.
    // The slot number is not the key label -- past the number row they diverge,
    // and "PRESS 13" is not a key anyone has.
    this.hud.addFeed(
      isNew
        ? `${def.name} ACQUIRED — ${pressWord()} ${ctrl('slot' + held.slot)}`
        : `${def.name} ROCKETS +${def.pickupAmmo}`,
      '#ffcf4d');
    if (isNew) this.hud.announce(`${def.name}!`, 2.0);
    this._refreshWeaponList();
  }

  // ------------------------------------------------------------------ chests

  /** Seed more chests, keeping the arena under CHEST_MAX. */
  _addChests(count) {
    const room = Math.min(count, CHEST_MAX - this.chests.length);
    if (room <= 0) return 0;

    // Keep clear of the stones (a chest must never hide one) and of chests
    // that are already out there.
    const avoid = this.stones.map((s) => ({ x: s.x, z: s.z }))
      .concat(this.chests.map((c) => ({ x: c.x, z: c.z })));

    // Indoors, in the rooms. The fight is meant to happen in the building, so
    // the reason to cross a room has to be in one -- a chest in the field
    // outside is a chest nobody walks to.
    const fresh = [];
    for (let i = 0; i < room; i++) {
      const at = this.world.spotInRooms(null, 0.8, avoid.concat(fresh), 5);
      if (!at) break;
      fresh.push(new Chest(at.x, at.y, at.z, Math.random() * Math.PI * 2));
    }
    for (const c of fresh) {
      this.scene.add(c.mesh);
      this.chests.push(c);
    }
    return fresh.length;
  }

  _updateChests(dt) {
    for (let i = this.chests.length - 1; i >= 0; i--) {
      const c = this.chests[i];
      c.update(dt);
      if (!c.done) continue;
      this.scene.remove(c.mesh);
      c.dispose();
      this.chests.splice(i, 1);
    }
  }

  /** Nearest unopened chest the player is standing close enough to open. */
  _chestInReach() {
    let best = null;
    let bestD = Infinity;
    for (const c of this.chests) {
      if (c.opened || !c.inRange(this.player)) continue;
      const d = (c.x - this.player.pos.x) ** 2 + (c.z - this.player.pos.z) ** 2;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  _tryOpenChest() {
    if (!this.player.alive) return;
    const chest = this._chestInReach();
    if (!chest) return;

    const loot = chest.open();
    this.audio.chestOpen({ x: chest.x, y: chest.y + 0.7, z: chest.z });
    this.effects.spawnPuff(chest.x, chest.y + 0.7, chest.z, 0xffd070);
    this.hud.addFeed('CHEST OPENED', '#ffd070');
    this._grantLoot(loot, chest);
  }

  // ------------------------------------------------ banana vending machine

  _bananaVendingInReach() {
    return this.drummerTower?.vendingInRange(this.player) ? this.drummerTower : null;
  }

  _bananaVendingPrompt() {
    return this._bananaVendingInReach()
      ? `${pressWord()} ${ctrl('interact')} — SHAKE BANANA MACHINE`
      : null;
  }

  _tryBananaVendingMachine() {
    if (!this._bananaVendingInReach()) return;
    this.session.activateBananaVending();
  }

  // ------------------------------------------------------ nugget dispenser

  _nuggetDispenserInReach() {
    const dispenser = this.nuggetDispenser;
    return this.player.alive && dispenser?.inRange(this.player) ? dispenser : null;
  }

  _nuggetDispenserPrompt() {
    const dispenser = this._nuggetDispenserInReach();
    if (!dispenser) return null;
    return dispenser.ready
      ? `${pressWord()} ${ctrl('interact')} — ${dispenser.prompt()}`
      : dispenser.prompt();
  }

  _tryDispenseNuggets() {
    const dispenser = this._nuggetDispenserInReach();
    if (!dispenser) return;
    if (!dispenser.ready) {
      this.audio.dryFire();
      return;
    }

    const serving = dispenser.dispense(this.player);
    if (!serving) return;
    this.audio.nuggets();

    // Local +Z is the serving side of the cabinet.
    const fx = dispenser.x + Math.sin(dispenser.yaw) * 0.75;
    const fz = dispenser.z + Math.cos(dispenser.yaw) * 0.75;
    this.effects.spawnPuff(fx, dispenser.y + 0.7, fz, 0xffb02e);
    this.hud.announce('NUGGETS!', 1.35, '#ffb02e');
    this.hud.addFeed(
      serving.healed > 0
        ? `${serving.count} CHICKEN NUGGETS · +${Math.round(serving.healed)} HP`
        : `${serving.count} CHICKEN NUGGETS · ABSOLUTELY DELICIOUS`,
      '#ffb02e');
  }

  // ------------------------------------------------------- dinosaur factory

  _dinosaurFactoryInReach() {
    const factory = this.dinosaurFactory;
    return this.player.alive && factory?.inRange(this.player) ? factory : null;
  }

  _dinosaurFactoryPrompt() {
    const factory = this._dinosaurFactoryInReach();
    if (!factory) return null;
    return factory.ready
      ? `${pressWord()} ${ctrl('interact')} — ${factory.prompt(this.coins)}`
      : factory.prompt(this.coins);
  }

  _tryCloneDinosaur() {
    const factory = this._dinosaurFactoryInReach();
    if (!factory || !factory.ready) return;
    if (this.coins < DINOSAUR_FACTORY_COST) {
      this.hud.addFeed(
        `NEED ${DINOSAUR_FACTORY_COST - this.coins} MORE COINS`, '#ff6b6b');
      this.audio.dryFire();
      return;
    }
    if (!this.session.spendCoins(DINOSAUR_FACTORY_COST, 'dinosaur-factory') || !factory.start()) return;
    this.audio.dinosaurFactoryStart({
      x: factory.x, y: factory.y + 1.2, z: factory.z,
    });
    this.hud.announce('CLONING VELOCIRAPTOR', 1.8, '#58ff9c');
    this.hud.addFeed('DINOSAUR FACTORY ONLINE', '#58ff9c');
  }

  _updateDinosaurFactory(dt) {
    const event = this.dinosaurFactory?.update(
      dt, this.player, this.enemies,
      (enemy, amount) => this.session.damageEnemy(enemy, amount, {
        scoreScale: this.streak.tier.damage,
        origin: this.dinosaurFactory?.ally?.pos,
      }),
    );
    if (!event) return;
    if (event.kind === 'hatched') {
      const ally = this.dinosaurFactory.ally;
      this.audio.dinosaurRoar({ x: ally.pos.x, y: ally.pos.y + 0.8, z: ally.pos.z });
      this.hud.announce('VELOCIRAPTOR DEPLOYED', 2.0, '#7dffa9');
      this.hud.addFeed('YOUR RAPTOR WILL FOLLOW AND HUNT ZOMBIES', '#7dffa9');
      this.effects.spawnPuff(ally.pos.x, ally.pos.y + 0.8, ally.pos.z, 0x58ff9c);
      return;
    }
    if (event.kind === 'bite') {
      this.audio.dinosaurBite({
        x: event.enemy.pos.x,
        y: event.enemy.pos.y + event.enemy.type.height * 0.55,
        z: event.enemy.pos.z,
      });
      this.stats.hits += 1;
      this.stats.damage += event.damage;
      this._showDamage(event.enemy, event.damage, false);
      this.effects.spawnPuff(
        event.enemy.pos.x,
        event.enemy.pos.y + event.enemy.type.height * 0.55,
        event.enemy.pos.z,
        0xb7e37b,
      );
    }
  }

  /**
   * Turn abstract loot entries into things in the world.
   *
   * Everything but the ammo cache is ejected as a ground pickup rather than
   * granted outright: seeing a flask pop out and roll is what sells the roll,
   * and it gives the player a beat to decide whether it is worth stepping into
   * the open for.
   */
  _grantLoot(entries, chest) {
    entries.forEach((entry, slot) => {
      // Fan multiple drops apart so two items never land on the same square.
      const ang = Math.random() * Math.PI * 2 + slot * 2.4;
      const x = chest.x + Math.cos(ang) * 1.2;
      const z = chest.z + Math.sin(ang) * 1.2;
      const ejectFrom = { x: chest.x, y: chest.y + 0.78, z: chest.z };

      if (entry.type === 'weapon') {
        this._spawnPickup(
          { type: PICKUP_WEAPON, kind: entry.id, lifetime: LOOT_LIFETIME, ejectFrom },
          x, chest.y, z);
        return;
      }

      if (entry.type === 'potion') {
        const def = randomPotion();
        this._spawnPickup(
          { type: PICKUP_POTION, kind: def.id, color: def.color,
            lifetime: LOOT_LIFETIME, ejectFrom },
          x, chest.y, z);
        return;
      }

      if (entry.type === 'map') {
        const target = this._nearestStone(chest.x, chest.z, MAP_RADIUS);
        // A map only leads somewhere if a stone is still hidden inside its
        // radius. With nothing to point at it would be a dud, so the slot pays
        // out as supplies instead of as a worthless scroll.
        if (target) {
          this._spawnPickup(
            { type: PICKUP_MAP, target: target.def.id, lifetime: LOOT_LIFETIME, ejectFrom },
            x, chest.y, z);
          return;
        }
      }

      this.weapons.addAmmo(0.35);
      this.hud.addFeed('AMMO CACHE', '#6fe08a');
    });
  }

  // -------------------------------------------------------------------- doors

  /**
   * A clear spot on the start room's ground floor.
   *
   * Not the centre. Partitions split a floor down the middle, so the exact
   * centre is inside a wall about half the time -- and spawning embedded in
   * geometry hands you straight to the push-out resolver, which ejects you
   * through the nearest face and out of the building. That is the "glitched
   * outside the room" bug, and it happens before you touch the controls.
   *
   * So this searches: spiral out from the middle and take the first spot with
   * room to stand.
   */
  _startSpawn() {
    const zn = this.world.startZone;
    if (!zn) return null;
    const b = zn.site;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;

    const clear = (x, z) => {
      // Inside the footprint with a wall's worth of margin, and not inside
      // anything solid.
      if (x < b.minX + 1 || x > b.maxX - 1 || z < b.minZ + 1 || z > b.maxZ - 1) return false;
      return !this.world.blocksAt(x, b.floorY ?? this.world.heightAt(x, z), z, 0.4, 1.8);
    };

    const fy = () => b.floorY ?? this.world.heightAt(cx, cz);
    if (clear(cx, cz)) return { x: cx, y: fy(), z: cz };

    for (let r = 1.0; r < Math.max(b.maxX - b.minX, b.maxZ - b.minZ); r += 0.8) {
      const steps = Math.max(8, Math.round(r * 6));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        if (clear(x, z)) return { x, y: b.floorY ?? this.world.heightAt(x, z), z };
      }
    }
    // Nowhere in the room works, which means the layout is broken. Fall back
    // to open ground rather than starting the player inside a wall.
    return null;
  }

  /** The door or reclosable shutter the player is standing at, if any. */
  _doorInReach() {
    const p = this.player.pos;
    let best = null, bestD = 9;
    const doors = this.world.interactableDoors?.() ?? this.world.doors();
    for (const door of doors) {
      const c = door.collider;
      // Distance to the face of the shutter, not its centre, so a wide door is
      // reachable from anywhere along it.
      const dx = Math.max(c.minX - p.x, 0, p.x - c.maxX);
      const dz = Math.max(c.minZ - p.z, 0, p.z - c.maxZ);
      const d = Math.hypot(dx, dz);
      if (d > 2.2) continue;
      if (Math.abs(p.y - c.minY) > 3) continue;   // not from the floor above
      if (d < bestD) { bestD = d; best = door; }
    }
    return best;
  }

  /** A shutter cannot close through a player, co-op partner, or living enemy. */
  _doorwayOccupied(door) {
    const c = door?.collider;
    if (!c) return false;
    const bodies = [this.player, ...(this.remotes ?? []), ...(this.enemies ?? [])];
    for (const body of bodies) {
      if (!body || body.alive === false) continue;
      const p = body.pos ?? body.position;
      if (!p) continue;
      const radius = Number(body.half ?? body.type?.width / 2 ?? 0.34);
      const height = Number(body.type?.height ?? body.height ?? 1.8);
      if (p.x + radius <= c.minX || p.x - radius >= c.maxX
        || p.z + radius <= c.minZ || p.z - radius >= c.maxZ) continue;
      if (p.y + height <= c.minY || p.y >= c.maxY) continue;
      return true;
    }
    return false;
  }

  _tryOpenDoor() {
    if (!this.player.alive) return;
    const door = this._doorInReach();
    if (!door) return;
    const c = door.collider;
    const doorSound = {
      x: (c.minX + c.maxX) / 2,
      y: (c.minY + c.maxY) / 2,
      z: (c.minZ + c.maxZ) / 2,
    };

    const isClosed = this.world.props.includes(door);
    if (door.reclosable && !isClosed) {
      if (this._doorwayOccupied(door)) {
        this.hud.addFeed('DOORWAY BLOCKED', '#ffd37b');
        this.audio.dryFire?.();
        return;
      }
      if (!this.world.closeDoor(door)) return;
      this.buildings.syncDoors?.(this.world.doors());
      this.audio.chestOpen(doorSound);
      this.hud.addFeed('HUMAN ENCLOSURE SEALED', '#71e5f4');
      return;
    }

    if (!this.world.openDoor(door)) return;
    this.buildings.removeDoor(door);
    this.audio.chestOpen(doorSound);

    const zone = this.world.zones.find((z) => z.id === door.zone);
    this.hud.addFeed(
      `${zone && zone.tier > 0 ? zone.label : 'THE YARD'} OPEN`, '#6fe08a');
    // Opening an area stocks it immediately, so exploration still has a clear
    // reward even though traversal never spends the player's coins.
    if (!door.escape) this._stockZone(zone);
  }

  /**
   * Put the tier's reward into a newly opened zone.
   *
   * A weapon on the floor and a chest, both scaled to the tier, so pushing
   * outward is what upgrades your kit rather than luck with drops.
   */
  _stockZone(zone) {
    if (!zone || zone.stocked) return;
    // The start room is where you already are. Its door is the way *out*, so
    // there is nothing to stock behind it -- and handing the player the pistol
    // they are already holding reads as a broken reward.
    if (zone.tier === 0) return;
    zone.stocked = true;

    const pool = TIER_WEAPONS[Math.min(TIER_WEAPONS.length - 1, zone.tier)] ?? [];
    const b = zone.site;
    const role = b.role ?? { chests: 1, weapons: 1 };
    // Sampled per item rather than once for the whole zone. A room has one flat
    // floor and the distinction never mattered, but the perimeter is bare
    // terrain -- taking the height at its centre and using it for everything
    // would sink a chest into a rise and float the next one off a dip.
    const groundY = (x, z) => b.floorY ?? this.world.heightAt(x, z);

    // Weapons on the floor, spread out, so a room with two is worth clearing
    // rather than worth glancing into.
    for (let i = 0; i < (role.weapons ?? 1) && pool.length; i++) {
      const kind = pool[Math.floor(Math.random() * pool.length)];
      const at = this._spotInRoom(b, i * 2 + 1);
      if (at) {
        this._spawnPickup(
          { type: PICKUP_WEAPON, kind, lifetime: 0 },
          at.x, groundY(at.x, at.z) + 0.6, at.z,
        );
      }
    }

    // Chests in the area you just paid for -- not scattered where opening a
    // door has nothing to do with finding one.
    for (let i = 0; i < (role.chests ?? 1); i++) {
      const at = this._spotInRoom(b, i * 2 + 2);
      if (!at) continue;
      const chest = new Chest(at.x, groundY(at.x, at.z), at.z, Math.random() * Math.PI * 2);
      this.scene.add(chest.mesh);
      this.chests.push(chest);
    }
  }

  // ------------------------------------------------------------- mystery box

  /**
   * Put the box somewhere worth walking to.
   *
   * Kept clear of the stones and the chests so the box never buries a
   * collectible, and pushed well away from spawn -- the walk is part of what a
   * roll costs.
   */
  _placeMysteryBox() {
    const avoid = this.stones.map((s) => ({ x: s.x, z: s.z }))
      .concat(this.chests.map((c) => ({ x: c.x, z: c.z })));

    this.mysteryBox = placeMysteryBox(
      this.world, this.player.pos.x, this.player.pos.z, avoid);
    // A box that found nowhere to stand is simply absent for the run; nothing
    // downstream requires one to exist.
    if (this.mysteryBox) this.scene.add(this.mysteryBox.mesh);
  }

  _updateMysteryBox(dt) {
    const box = this.mysteryBox;
    if (!box) return;

    box.update(dt);

    // The roll hands its prize over on exactly one frame.
    if (box.payout) {
      const won = box.payout;
      this._spawnPickup(
        { type: PICKUP_WEAPON, kind: won.id, lifetime: LOOT_LIFETIME },
        box.x, box.y + 0.9, box.z);
      this.audio.chestOpen({ x: box.x, y: box.y + 1, z: box.z });
      // The reveal is the whole point of the box, so it names the rung: the puff
      // and the feed both take the tier's colour, and a common pull says so
      // rather than reading as a nondescript success.
      const tier = TIERS[won.tier] ?? TIERS[0];
      this.effects.spawnPuff(box.x, box.y + 1.5, box.z, tier.hex);
      this.hud.addFeed(`${tier.name}!`, tier.css);
    }
  }

  /** True when the player is standing at the box and could pay for a roll. */
  _boxInReach() {
    const box = this.mysteryBox;
    if (!box || !box.inRange(this.player)) return null;
    return box;
  }

  /**
   * A clear spot inside a room to drop something the player should find.
   *
   * Seeded by index so two rewards in the same room do not land on each other,
   * and checked against the furniture so nothing spawns inside a desk.
   */
  _spotInRoom(room, salt = 0) {
    const w = room.maxX - room.minX, d = room.maxZ - room.minZ;
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = (attempt * 2.399 + salt * 1.7);
      const rr = 0.2 + 0.6 * ((attempt + salt) % 5) / 5;
      const x = room.cx + Math.cos(a) * (w * 0.5 - 1.6) * rr;
      const z = room.cz + Math.sin(a) * (d * 0.5 - 1.6) * rr;
      const y = room.floorY ?? this.world.heightAt(x, z);
      if (!this.world.blocksAt(x, y, z, 0.5, 1.2)) return { x, z };
    }
    return null;
  }

  /** The secret panel, if the player is close enough to notice it. */
  _secretInReach() {
    if (this._secretOpened) return null;
    const p = this.player.pos;
    for (const w of this.world.props) {
      if (!w.secret) continue;
      const c = w.collider;
      const dx = Math.max(c.minX - p.x, 0, p.x - c.maxX);
      const dz = Math.max(c.minZ - p.z, 0, p.z - c.maxZ);
      if (Math.hypot(dx, dz) < 1.6 && Math.abs(p.y - c.minY) < 3) return w;
    }
    return null;
  }

  /**
   * Open the cache.
   *
   * Free, because the cost was finding it, and it pays out the best thing in
   * the game -- a secret that hands you a rifle is not worth hunting for.
   */
  _openSecret() {
    const panel = this._secretInReach();
    if (!panel) return;

    this._secretOpened = true;
    const i = this.world.props.indexOf(panel);
    if (i >= 0) this.world.props.splice(i, 1);
    this.world._index();
    this.buildings.removeSecret?.(panel);

    const x = (panel.collider.minX + panel.collider.maxX) / 2;
    const z = (panel.collider.minZ + panel.collider.maxZ) / 2;
    const y = panel.collider.minY;

    this._spawnPickup({ type: PICKUP_WEAPON, kind: 'railgun', lifetime: 0 }, x, y + 0.7, z);
    const chest = new Chest(x, y, z + 1.4, Math.random() * Math.PI * 2);
    this.scene.add(chest.mesh);
    this.chests.push(chest);

    this.audio.chestOpen({ x, y: y + 0.7, z });
    this.hud.announce('CACHE FOUND', 2.4);
    this.hud.addFeed('HIDDEN CACHE', '#ffd700');
  }

  /** Context text for mounting, climbing and descending the rhythm tower. */
  _ladderPrompt() {
    if (this.player.climbing) {
      return `${ctrl('forward')} / ${ctrl('back')} — CLIMB · ${ctrl('jump')} — JUMP OFF`;
    }
    const p = this.player.pos;
    if (!this.world.ladderNear?.(p.x, p.y, p.z)) return null;
    return `${pressWord()} ${ctrl('interact')} — USE TOWER LADDER`;
  }

  /** The free door interaction in reach, or null when there is none. */
  _doorPrompt() {
    const door = this._doorInReach();
    if (!door) return null;

    // The one door that leads out of the building rather than further into it.
    // Naming the area behind it would be a lie -- there is no room back there --
    // and after an hour of "OPEN THE ARMOURY" the prompt is the only thing that
    // tells you this door is different.
    if (door.escape) {
      return `${pressWord()} ${ctrl('interact')} — OPEN SPACEPORT AIRLOCK — FREE`;
    }

    if (door.reclosable) {
      return this.world.props.includes(door)
        ? `${pressWord()} ${ctrl('interact')} — OPEN HUMAN ENCLOSURE — FREE`
        : `${pressWord()} ${ctrl('interact')} — CLOSE HUMAN ENCLOSURE`;
    }

    const zone = this.world.zones.find((z) => z.id === door.zone);
    // A door in the start room leads out of it; every other door leads into
    // the area it belongs to, so they read differently.
    const label = zone && zone.tier > 0 ? zone.label : 'THE YARD';
    return `${pressWord()} ${ctrl('interact')} — OPEN ${label} — FREE`;
  }

  /**
   * What the box wants to say right now, or null when it has nothing to say.
   *
   * While a roll is running this is the flicking name -- that readout is the
   * whole theatre of the feature, so it takes over the prompt line rather than
   * competing with a chest hint.
   */
  _boxPrompt() {
    const box = this.mysteryBox;
    // Walking away mid-roll leaves the box spinning on its own; the readout is
    // for the player standing at it, so it goes with them.
    if (!box || !box.inRange(this.player)) return null;

    if (box.busy) {
      const def = WEAPONS.find((w) => w.id === box.previewId);
      return def ? `— ${def.name} —` : '— ROLLING —';
    }
    // Advertise the odds. It is a 950-coin decision, and the honest number is
    // more interesting than the mystery -- one in seven is worth saving for.
    const odds = `${Math.round(LEGENDARY_CHANCE * 100)}% LEGENDARY`;
    return this.coins >= BOX_COST
      ? `${pressWord()} ${ctrl('interact')} — MYSTERY BOX (${BOX_COST}) · ${odds}`
      : `MYSTERY BOX — NEED ${BOX_COST - this.coins} COINS · ${odds}`;
  }

  _tryRollBox() {
    if (!this.player.alive) return;
    const box = this._boxInReach();
    if (!box || box.busy) return;

    if (this.coins < BOX_COST) {
      this.hud.addFeed(`NEED ${BOX_COST - this.coins} MORE COINS`, '#ff6b6b');
      return;
    }

    // Coins, not score. Score is a read-only view of the sim's tally -- the box
    // used to do `this.score -= cost`, which throws in a module (always strict)
    // and meant every single press failed silently. Coins are also the right
    // currency: they are the shared pot the armoury already spends from, so a
    // co-op party buys rolls out of the same purse the server owns.
    if (!this.session.spendCoins(BOX_COST, 'mystery-box')) return;
    box.startRoll();
    this.audio.chestOpen({ x: box.x, y: box.y + 1, z: box.z });
  }

  // ------------------------------------------------------------ treasure map

  /** Closest uncollected stone to a point, within `radius`. Null if none. */
  _nearestStone(x, z, radius) {
    let best = null;
    let bestD = radius * radius;
    for (const s of this.stones) {
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** Read a map: mark its stone and start laying a trail toward it. */
  _followMap(stoneId) {
    // The stone this map was drawn for may already have been collected by the
    // time the scroll is picked up; fall back to the nearest one still hidden
    // so a map is never a dead item in the hand.
    let stone = this.stones.find((s) => s.def.id === stoneId);
    if (!stone) stone = this._nearestStone(this.player.pos.x, this.player.pos.z, Infinity);

    if (!stone) {
      this.hud.addFeed('MAP IS BLANK — ALL STONES FOUND', '#9aa6b2');
      return;
    }

    this.waypoint = stone;
    this.trailTimer = 0;
    this.audio.mapOpen();
    const color = '#' + stone.def.color.toString(16).padStart(6, '0');
    this.hud.announce('TREASURE MAP', 1.8, color);
    this.hud.addFeed(`${stone.def.label} STONE MARKED`, color);
  }

  /** Lay the periodic trail of motes running from the player to the stone. */
  _updateWaypoint(dt) {
    if (!this.waypoint) return;
    // Dropped once the stone is collected, or when a snap reshuffles the set.
    if (!this.stones.includes(this.waypoint)) { this.waypoint = null; return; }

    this.trailTimer -= dt;
    if (this.trailTimer > 0) return;
    this.trailTimer = TRAIL_INTERVAL;

    const p = this.player.pos;
    const dx = this.waypoint.x - p.x, dz = this.waypoint.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 2.5) return;   // close enough that the stone's own beam takes over

    const ux = dx / dist, uz = dz / dist;
    const span = Math.min(dist - 1, 11);
    for (let i = 1; i <= 4; i++) {
      const t = (i / 4) * span;
      const x = p.x + ux * t, z = p.z + uz * t;
      const y = this.world.heightAt(x, z) + 1.3;
      this.effects.mote(x, y, z, this.waypoint.def.color);
    }
  }

  // ------------------------------------------------------- infinity stones

  /** Hide a fresh set of five stones and clear whatever was carried. */
  _resetStones() {
    for (const s of this.stones) this.scene.remove(s.mesh);
    // Stones indoors too, and never two in the same room -- a stone is a
    // reason to open a door, which it cannot be if it is sitting in a field.
    this.stones = [];
    const usedRooms = new Set();
    for (const def of STONES) {
      const at = this.world.spotInRooms(
        (r) => !usedRooms.has(r.id), 0.9,
        this.stones.map((s) => ({ x: s.x, z: s.z })), 6);
      if (!at) break;
      usedRooms.add(at.room.id);
      this.stones.push(new Stone(def, at.x, at.y, at.z));
    }
    if (!this.stones.length) {
      this.stones = placeStones(this.world, this.player.pos.x, this.player.pos.z);
    }
    for (const s of this.stones) this.scene.add(s.mesh);
    this.collectedStones.clear();
    // Any map in play was drawn for the old set, so it no longer means anything.
    this.waypoint = null;
  }

  get snapArmed() {
    return this.collectedStones.size === STONES.length
      && this.player.alive
      && this.player.health < this.player.maxHealth * 0.5;
  }

  _updateStones(dt) {
    for (let i = this.stones.length - 1; i >= 0; i--) {
      const s = this.stones[i];
      s.update(dt);
      if (!this.player.alive || !s.inRange(this.player)) continue;

      this.collectedStones.add(s.def.id);
      this.scene.remove(s.mesh);
      this.stones.splice(i, 1);
      this.effects.spawnPuff(s.x, s.y, s.z, s.def.color);
      this.audio.stone();
      this.hud.addFeed(`${s.def.label} STONE ${this.collectedStones.size}/5`,
        '#' + s.def.color.toString(16).padStart(6, '0'));

      if (this.collectedStones.size === STONES.length) {
        this.hud.announce('GAUNTLET COMPLETE', 2.6, '#c04ae0');
      }
    }
  }

  /**
   * Consume all five stones: heal to full and wipe the wave.
   * Deliberately gated on being below half health -- it is a comeback button,
   * not something to fire the moment the fifth stone is picked up.
   */
  _snap() {
    if (!this.snapArmed) return;

    this.audio.snap();
    this.hud.announce('SNAP', 2.4, '#c04ae0');
    this.hud.addFeed('PERFECTLY BALANCED', '#c04ae0');
    this.hud.damageFlash(0);
    this.effects.snapFlash(this.player.pos.x, this.player.eyeY, this.player.pos.z);

    this.player.health = this.player.maxHealth;
    this.player.regenDelay = 0;

    // Kill everything currently alive, plus anything still queued to spawn --
    // otherwise the wave would immediately refill and the snap would feel weak.
    // In co-op this wipes the wave for the whole room, which is the point: the
    // stones are hard enough to gather that the payoff should be shared.
    const killed = this.session.snap();

    this.hud.addFeed(`${killed} DUSTED`, '#c04ae0');
    this._resetStones();
  }

  /**
   * Queue a floating number over an enemy.
   *
   * A hit on a boss's core or into a bulwark's shield is classified separately,
   * because the whole point of those archetypes is teaching the player where to
   * aim -- and a number that changes colour when they get it right teaches it
   * faster than any amount of tutorial text.
   */
  _showDamage(enemy, amount, headshot) {
    if (!enemy || amount <= 0) return;
    const t = enemy.type;

    let kind = headshot ? 'headshot' : 'hit';
    if (t.boss || t.shield) {
      // Compare against what an unmodified hit would have been: anything
      // amplified is a weak point, anything cut down bounced off armour.
      const base = t.boss ? t.armor : t.shieldReduction;
      if (amount > 0 && base > 0) {
        const plain = amount / base;
        if (amount > plain * 0.9) kind = 'weak';
      }
    }
    this.dmgNumbers.add(enemy.id, amount, kind);
  }

  /** Debris colour for whatever the shot landed on. */
  _impactColor(prop) {
    if (!prop) return 0x7d6a44;                 // dirt kicked off the ground
    if (prop.type === 'tree') return 0x6b4a2e;  // bark
    if (prop.type === 'rock') return 0x8d8578;
    if (prop.type === 'crate') return 0xb07a3c;
    return 0x9a9384;                            // masonry
  }

  /**
   * A kill happened -- ours or a partner's. Score and coins were already
   * awarded by the simulation, so this is purely the reaction to it.
   */
  _onEnemyKilled(ev) {
    const type = ENEMY_TYPES[ev.type] || ENEMY_TYPES.grunt;
    const mine = !this.session.multiplayer || ev.by === this.session.selfId;

    this.hud.setScore(this.session.score);

    // Death effects play for everyone; the rest is only for the player who
    // actually pulled the trigger.
    this.effects.deathBurst(ev.x, ev.y + type.height * 0.55, ev.z,
      type.bodyColor, type.width / 0.62);

    if (!mine) {
      this.hud.addFeed(`${this._nameOf(ev.by)}: ${type.label}`, '#9aa6b2');
      return;
    }

    this.stats.kills += 1;
    this.streak.addKill();
    this.hud.addFeed(
      ev.headshot ? `${type.label} — HEADSHOT +${ev.score}` : `${type.label} +${ev.score}`,
      ev.headshot ? '#ffcf4d' : '#e8f0f2');

    // Weapon drops. Airstrike is checked first so the rarer prize wins the roll
    // when both would have succeeded.
    const strikeChance = type.baby ? AIRSTRIKE_DROP_CHANCE_BABY : AIRSTRIKE_DROP_CHANCE;
    if (Math.random() < FLAMETHROWER_DROP_CHANCE) {
      this._spawnPickup({ type: PICKUP_WEAPON, kind: 'flamethrower' }, ev.x, ev.y, ev.z);
      this.hud.addFeed('FLAMETHROWER DROPPED', '#ff7a1e');
      this.hud.announce('FLAMETHROWER', 2.2, '#ff7a1e');
      this.audio.streakUp();
    } else if (Math.random() < strikeChance) {
      this._spawnPickup({ type: PICKUP_WEAPON, kind: 'airstrike' }, ev.x, ev.y, ev.z);
      this.hud.addFeed('AIRSTRIKE DROPPED', '#ff8a3d');
    } else if (Math.random() < BAZOOKA_DROP_CHANCE) {
      this._spawnPickup({ type: PICKUP_WEAPON, kind: 'bazooka' }, ev.x, ev.y, ev.z);
      this.hud.addFeed('BAZOOKA DROPPED', '#ffcf4d');
    }

    // Small reward so aggression is sustainable.
    this.player.heal(ev.headshot ? 8 : 4);
    if (this.stats.kills % 6 === 0) {
      this.weapons.addAmmo(0.18);
      this.hud.addFeed('AMMO RESUPPLY', '#6fe08a');
    }
  }

  // --------------------------------------------------------- session events

  /**
   * Turn simulation events into sound, effects and HUD feedback.
   *
   * Everything here is presentation. The events themselves are produced by the
   * simulation, so a co-op partner's kill lands in your feed for exactly the
   * same reason your own does -- there is no separate "someone else did this"
   * path to keep in step.
   */
  _drainSessionEvents() {
    const events = this.session.drainEvents();
    if (!events) return;

    for (const ev of events) {
      switch (ev.type) {
        case EV.WAVE_START:
          this.shop.close();
          this.audio.waveStart();
          if (ev.boss) {
            this.hud.announce(`WAVE ${ev.wave}  —  ABOMINATION`, 2.6, '#ff4d4d');
            this.hud.addFeed('SHOOT THE CORE ON ITS BACK', '#ffd24a');
          } else {
            this.hud.announce(`WAVE ${ev.wave}`, 1.8);
          }
          if (!this.session.isFFA) this.hud.setWave(ev.wave, 0, ev.total);
          this.weapons.addAmmo(0.22);
          break;

        case EV.EXPLOSION: {
          // A bloater going off. The simulation already applied the damage;
          // this is the part you see and hear.
          this.audio.explosion({ x: ev.x, y: ev.y, z: ev.z });
          this.effects.explosion(ev.x, ev.y, ev.z, ev.radius);
          // Shake falls off with distance, so a detonation across the map is a
          // rumble and one at your feet is a concussion.
          const d = Math.hypot(ev.x - this.player.pos.x, ev.z - this.player.pos.z);
          const k = Math.max(0, 1 - d / (ev.radius * 4));
          this.shake.add(TRAUMA.explosionFar + (TRAUMA.explosionNear - TRAUMA.explosionFar) * k);
          break;
        }

        case EV.BOSS_SPAWN:
          this.bossId = ev.id;
          this.audio.streakUp();
          if (ev.type === 'clippy') {
            this.hud.announce('IT LOOKS LIKE YOU\'RE SURVIVING A HORDE', 2.8, '#d8ddd8');
            this.hud.addFeed('CLIPPY HAS A SUGGESTION', '#f0f1e8');
          }
          break;

        case EV.BOSS_DEAD:
          if (this.bossId === ev.id) this.bossId = null;
          this.stats.bosses = (this.stats.bosses || 0) + 1;
          this.hud.announce(`${ev.label || 'ABOMINATION'} DOWN`, 2.6, '#6fe08a');
          this.shake.add(TRAUMA.bossKill);
          this.audio.snap();
          break;

        case EV.WAVE_CLEAR: {
          this.hud.announce(`WAVE ${ev.wave} CLEAR  +${ev.bonus}`, 2.6, '#6fe08a');
          this.player.heal(35);
          this.weapons.addAmmo(0.3);
          const added = this._addChests(CHEST_PER_WAVE);
          if (added > 0) {
            this.hud.addFeed(`${added} CHEST${added > 1 ? 'S' : ''} RESTOCKED`, '#ffd070');
          }
          this._openShop();
          break;
        }

        case EV.ENEMY_KILLED:
          this._onEnemyKilled(ev);
          break;

        case EV.ENEMY_SHOT:
          // Enemy gunfire draws its own tracer so incoming shots are readable.
          this.effects.addTracer(ev.x0, ev.y0, ev.z0, ev.x1, ev.y1, ev.z1, 0xff9a5a, 0.09);
          this.audio.enemyShot(ev.hit, { x: ev.x0, y: ev.y0, z: ev.z0 });
          break;

        case EV.ENEMY_RELOCATED: {
          const e = this.enemies.find((x) => x.id === ev.id);
          this.effects.spawnPuff(ev.x, ev.y, ev.z, e ? e.type.bodyColor : 0x88aa88);
          break;
        }

        case EV.PLAYER_HURT:
          // Only our own player is simulated here; a partner being hit is
          // their client's business.
          if (ev.to === this.session.selfId) this._takeHit(ev);
          break;

        case EV.PLAYER_POISONED:
          if (ev.to === this.session.selfId) {
            this.player.applyPoison(ev.total, ev.duration);
          }
          break;

        case EV.PLAYER_DOWNED:
          if (ev.to === this.session.selfId) this._onDowned();
          else this.hud.addFeed(`${this._nameOf(ev.to)} IS DOWN`, '#ff6b6b');
          break;

        case EV.PLAYER_REVIVED:
          if (ev.to === this.session.selfId) this._onRevived();
          else this.hud.addFeed(`${this._nameOf(ev.to)} REVIVED`, '#6fe08a');
          break;

        case EV.PLAYER_DIED:
          // A free-for-all death is a respawn, not a run ending -- the game-over
          // screen belongs to co-op, where there is nothing to come back to.
          if (this.session?.isFFA) {
            if (ev.to === this.session.selfId) this._onFragged();
          } else if (ev.to === this.session.selfId) {
            this.gameOver();
          } else {
            this.hud.addFeed(`${this._nameOf(ev.to)} BLED OUT`, '#ff4d4d');
          }
          break;

        case EV.PLAYER_FRAGGED: {
          const me = this.session.selfId;
          const by = ev.by === me ? 'YOU' : this._nameOf(ev.by);
          const to = ev.to === me ? 'YOU' : this._nameOf(ev.to);
          const tag = ev.headshot ? ' [HEADSHOT]' : '';
          this.hud.addFeed(`${by} ▸ ${to}${tag}`,
            ev.by === me ? '#ffd24a' : ev.to === me ? '#ff6b6b' : '#e8f0f2');
          if (ev.by === me) {
            // A frag is a kill: the run summary counts zombies through
            // enemyKilled, and would otherwise report a duel as no kills at all.
            this.stats.kills += 1;
            this.hud.hitmarker(true);
            this.audio.kill();
          }
          break;
        }

        case EV.PLAYER_RESPAWN:
          if (ev.to === this.session.selfId) this._onRespawn(ev);
          break;

        case EV.MATCH_OVER:
          this.hud.announce(
            ev.winner === this.session.selfId ? 'YOU WIN' : `${ev.name} WINS`,
            5, '#ffd24a');
          this.hud.addFeed(`${ev.name} took it with ${ev.kills} kills`, '#ffd24a');
          break;

        case EV.MATCH_RESET:
          this.hud.announce('NEW ROUND', 2.2, '#6fe08a');
          break;

        case EV.COINS:
          this.hud.setCoins?.(ev.coins);
          break;

        case EV.BANANA_VENDING:
          if (this.drummerTower?.activateVendingMachine()) {
            this.audio.vendingRattle({ x: ev.x, y: ev.y, z: ev.z });
            this.hud.addFeed('THE MACHINE DOES NOT APPRECIATE THAT', '#f5cf31');
          }
          break;

        default:
          break;
      }
    }
  }

  /**
   * Our health hit zero. Solo that is simply death; in co-op it is a bleed-out
   * that a partner can interrupt, so the simulation is told and it decides.
   */
  _onDowned() {
    this.hud.announce('DOWNED — HOLD ON', 2.4, '#ff4d4d');
    this.hud.addFeed('WAITING FOR A REVIVE', '#ff6b6b');
    this.audio.playerHurt();
    this.weapons.cancelReload?.();
  }

  /**
   * Killed in a free-for-all. Not a game over: hold the player still and let the
   * server's respawn clock put them back. The weapon is left alone deliberately
   * -- losing your arsenal on every death would make a twenty-kill match a
   * scavenging simulator.
   */
  _onFragged() {
    this.player.alive = false;
    // The sim is the one that ruled on this, and it can rule on a player whose
    // local health has not quite reached zero -- a splash frag, or a shot that
    // landed while our own hit was still travelling. Zeroing it keeps the health
    // bar from reading "40" over the top of a corpse.
    this.player.health = 0;
    this.hud.announce('YOU DIED', 1.6, '#ff4d4d');
    this.audio.playerHurt();
    this.weapons.cancelReload?.();
  }

  /** The server dropped us back in somewhere fresh. */
  _onRespawn(ev) {
    this.player.spawn({ x: ev.x, y: ev.y, z: ev.z });
    this.player.health = this.player.maxHealth;
    this.player.alive = true;
    // Back with the same kit, full. A duel where the loser also loses their
    // gun is one where the first fight decides the rest of them.
    this._applyLoadout();
    this.hud.announce('RESPAWNED', 1.2, '#6fe08a');
    this.effects.spawnPuff?.(ev.x, ev.y + 1, ev.z, 0x6fe08a);
  }

  /** The loadout this player brought, defaulted and remembered between runs. */
  get loadoutId() {
    return readPreference('bs.loadout', DEFAULT_LOADOUT);
  }

  /**
   * Give the player their versus kit.
   *
   * Only in a free-for-all. Co-op's whole economy is that weapons are found,
   * and handing out a rifle on wave one would delete it.
   */
  _applyLoadout() {
    if (!this.session.isFFA) return;
    const l = loadoutById(this.loadoutId);
    this.weapons.applyLoadout(loadoutWeapons(l.id));
    this.hud.setWeapons?.(this.weapons.owned, this.weapons.index);
  }

  /** The server brought us back for a new wave. Pick up where we left off. */
  _respawned() {
    const self = this.session.self;
    this.player.spawn({ x: self.x, y: self.y, z: self.z });
    this.player.health = self.h || this.player.maxHealth;
    this.player.alive = true;
    this.streak.reset();

    this.state = STATE.PLAYING;
    this.acc = 0;
    this.ui.overlay.classList.add('hidden');
    this.ui.panelDead.classList.add('hidden');
    this.hud.show();
    this.hud.announce('BACK IN', 1.8, '#6fe08a');
    this.input.clear();
    this.input.requestLock();
  }

  _onRevived() {
    this.player.health = 50;
    this.player.alive = true;
    this.player.regenDelay = 0;
    this.hud.announce('BACK UP', 1.6, '#6fe08a');
    this.audio.potionEnd();
  }

  /** Opened during the wave break. See the shop module for the contents. */
  _openShop() {
    this.shop?.open();
  }

  /**
   * Request a purchase.
   *
   * Solo settles immediately. Co-op asks the server, because the pot is shared
   * and two players spending the last of it at the same instant is a race only
   * the server can settle -- so the effect waits for the confirmation.
   */
  buy(itemId, cost) {
    if (cost > this.coins) {
      this.hud.addFeed('NOT ENOUGH COINS', '#ff6b6b');
      return;
    }
    if (this.isMultiplayer) {
      this.session.net.send(C2S.BUY, {
        item: itemId,
        cost,
        weapon: this.weapons.current.def.id,
      });
      return;
    }
    if (this.session.spendCoins(cost)) this._applyPurchase(itemId);
  }

  _applyPurchase(itemId) {
    // World interactions are applied by the caller as soon as it requests the
    // spend. Their ids exist only so the server can validate the shared-pot
    // price; they are not armoury catalogue entries to apply a second time.
    if (itemId === 'door' || itemId === 'mystery-box' || itemId === 'dinosaur-factory') return;
    if (!itemId) return;
    // Cosmetics used to be buyable here, out of the run's coin pot. They are
    // not any more -- they are bought with credits in the menu armoury -- and
    // the path is refused rather than removed, because a stale confirmation
    // from a server mid-upgrade would otherwise fall through to the catalogue
    // lookup below and buy something else entirely.
    if (itemId.startsWith('camo:')) return;
    const item = ITEM_BY_ID[itemId];
    if (!item) return;
    item.apply(this);
    this.audio.pickup();
    this.shop.onPurchase();
  }

  /** Potion table access, so the shop does not need its own import. */
  randomPotionDef() { return randomPotion(); }

  /**
   * Put back on whatever the player owns and has equipped.
   *
   * Order matters and is the whole point of routing this through one place: the
   * finish is the base palette and is applied by rebuilding the models, and the
   * skin is a repaint layered over whatever those models came out as. Doing it
   * the other way round, or doing either of them from two places, is how the
   * gun ends up wearing something nobody chose.
   */
  _refinishWeapons() {
    applySkinToAll(this.viewmodel, this.profile?.equippedSkin);
  }

  /**
   * The finishes, as the armoury panel wants to see them.
   *
   * Ownership lives in the local progress store and the wallet lives in the
   * profile, which is an accident of history rather than a design -- the panel
   * is handed an interface instead of either of them so that when those two
   * stores are eventually merged, nothing in the UI has to know it happened.
   *
   * They cost credits now rather than coins. Coins are earned and spent inside
   * a single run; charging them for something permanent meant the price of a
   * finish was whatever the last wave happened to pay out.
   */
  _finishStore() {
    const owned = () => (this.progress.data.camos ??= ['standard']);
    return {
      list: () => CAMOS.map((c) => ({
        id: c.id,
        name: c.name,
        cost: c.cost,
        metal: '#' + (c.metal ?? 0x6a727d).toString(16).padStart(6, '0'),
        accent: '#' + (c.furniture ?? c.dark ?? 0x434a54).toString(16).padStart(6, '0'),
      })),
      owns: (id) => owned().includes(id),
      worn: () => this.progress.data.camo ?? 'standard',
      // A finish is a palette, so there is nothing to photograph on its own.
      // Showing the skin the player is wearing, over this finish, is the only
      // preview that answers the question they are actually asking.
      shoot: (id, gun) => previewFinish(id, this.profile?.equippedSkin, gun),
      equip: (id) => {
        if (!owned().includes(id)) return { ok: false, reason: 'NOT OWNED' };
        this.equipCamo(id);
        return { ok: true };
      },
      buy: (id) => {
        const def = CAMOS.find((c) => c.id === id);
        if (!def) return { ok: false, reason: 'NO SUCH FINISH' };
        if (owned().includes(id)) return { ok: false, reason: 'ALREADY OWNED' };
        const credits = this.profile?.data?.credits ?? 0;
        if (credits < def.cost) {
          return { ok: false, reason: `NEED ${(def.cost - credits).toLocaleString()} MORE` };
        }
        this.profile.data.credits -= def.cost;
        this.profile.save({ immediate: true });
        owned().push(id);
        this.progress.save();
        this.equipCamo(id);
        return { ok: true };
      },
    };
  }

  /**
   * Wear an owned finish. Rebuilds the models, which re-applies the skin over
   * the top through onRefinish.
   */
  equipCamo(id) {
    if (!this.progress.data.camos.includes(id)) return;
    this.progress.data.camo = id;
    this.progress.save();
    this.viewmodel.applyCamo(id);
  }

  /** Confirmations and notices from the server, drained each tick. */
  _drainNetExtras() {
    if (!this.isMultiplayer) return;
    const bought = this.session.net.drainPurchases();
    if (bought) for (const id of bought) this._applyPurchase(id);

    const notices = this.session.net.drainNotices();
    if (notices) for (const n of notices) this.hud.addFeed(n.toUpperCase(), '#ff6b6b');

    const chat = this.session.drainChat();
    if (chat) for (const c of chat) this.hud.addFeed(`${c.name}: ${c.text}`, '#4db6ff');
  }

  /**
   * How hairy things are right now, 0..1. Feeds the score.
   *
   * Four inputs, because any one of them alone lies: enemies nearby (a crowd
   * across the map is not pressure), your own health, the streak you are
   * riding, and whether a boss is up. A player at full health mowing down a
   * distant wave should get quiet music even at a high kill count.
   */
  _intensity() {
    if (this.waveBreak > 0) return 0.06;

    const p = this.player.pos;
    let close = 0;
    let boss = 0;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.pos.x - p.x, e.pos.z - p.z);
      if (d < 30) close += 1 - d / 30;
      if (e.type.boss || e.type.miniboss) boss = 1;
    }

    const crowd = Math.min(1, close / 5);
    const hurt = 1 - this.player.health / this.player.maxHealth;
    const streak = Math.min(1, this.streak.count / 15);

    return Math.min(1, crowd * 0.5 + hurt * 0.3 + streak * 0.2 + boss * 0.35);
  }

  _nameOf(id) {
    const r = this.remotes.find((x) => x.id === id);
    return r ? r.name : 'A PARTNER';
  }

  /** Apply an enemy hit the simulation says landed on us. */
  _takeHit(ev) {
    // The pilot is physically sealed in the ship while the ground simulation
    // continues around its parked location. Letting a distant zombie damage
    // that frozen body made a successful launch turn into a surprise death.
    if (this.travel?.piloting) return;
    this.player.damage(ev.amount);
    this.shake.add(TRAUMA.hurt * Math.min(1, ev.amount / 25));
    // Knockback is applied here rather than in the simulation so it acts on
    // the real player object, which is the one that actually moves.
    const len = Math.hypot(ev.dx, ev.dz) || 1;
    this.player.vel.x += (ev.dx / len) * 3.2;
    this.player.vel.z += (ev.dz / len) * 3.2;
    this.player.vel.y += 1.6;
  }

  // ------------------------------------------------------------------- tick

  _tick(dt) {
    const input = this.input;
    const piloting = this.travel?.piloting;

    // --- weapon switching -------------------------------------------------
    // One weapon per slot key, so this asks for a specific gun. The old loop
    // ran over the weapons instead of the slots, and since several shared a
    // slot every match called switchTo in turn -- so a digit quietly drew
    // whichever of its weapons sat last in the table.
    for (let slot = 1; !piloting && slot <= SLOT_COUNT; slot++) {
      if (input.actionPressed('slot' + slot)) this.weapons.selectSlot(slot);
    }
    if (!piloting && input.actionPressed('lastWeapon')) this.weapons.switchLast();
    if (!piloting && input.actionPressed('reload')) this.weapons.startReload();
    if (!piloting && input.actionPressed('snap')) this._snap();
    // E is context-sensitive. Gameplay interactions win; the button is last
    // because pressing it intentionally changes nothing except its animation
    // and the recorded reaction.
    if (input.actionPressed('interact') && !this.travel?.tryInteract(this.player)) {
      // A door is the most specific thing you can be standing at, then the
      // fixed machines, then a chest.
      if (this.player.tryUseLadder()) { /* Player owns mount and dismount state. */ }
      else if (this._secretInReach()) this._openSecret();
      else if (this._doorInReach()) this._tryOpenDoor();
      else if (this._bananaVendingInReach()) this._tryBananaVendingMachine();
      else if (this._boxInReach()) this._tryRollBox();
      else if (this._dinosaurFactoryInReach()) this._tryCloneDinosaur();
      else if (this._nuggetDispenserInReach()) this._tryDispenseNuggets();
      else if (this._chestInReach()) this._tryOpenChest();
      else if (this.importantButton?.targetedBy(this.player, this.world)) {
        if (this.importantButton.press()) this.audio.buttonMoan();
      }
    }
    // The armoury is only open between waves -- shopping mid-fight would make
    // the break pointless and the fight pausable. A free-for-all has no waves to
    // shop between, and frag coins with nothing to spend them on, so there it is
    // open throughout: the cost of browsing is standing still in a duel, which
    // is a steep enough price on its own.
    if (!piloting && input.actionPressed('armoury')) {
      if (this.session?.isFFA || this.waveBreak > 0 || this.shop.isOpen) this.shop.toggle();
      else this.hud.addFeed('ARMOURY OPENS BETWEEN WAVES', '#9aa6b2');
    }

    const wheel = piloting ? 0 : input.consumeWheel();
    if (wheel !== 0) this.weapons.cycle(wheel > 0 ? 1 : -1);

    // --- player -----------------------------------------------------------
    this.travel?.update(dt, input, this.player);
    if (!piloting) this.player.update(dt, input, this.player.alive);
    if (this.travel?.land(input)) this.hud.announce('DESCENT BURN', 2.0, '#9eeaff');

    // --- weapons ----------------------------------------------------------
    // The aim ramp is advanced in frame(), at display rate, not here.
    if (this.player.alive && !piloting && !this.player.climbing
      && !this.travel?.bananaGunActive) {
      this.weapons.update(dt, this.player,
        input.actionDown('fire'), input.actionPressed('fire'));
      if (this.weapons.def.portal && input.actionPressed('ads')) {
        this.weapons.fireAlternate(this.player);
      }
    } else {
      this.weapons.update(dt, this.player, false, false);
    }

    // --- enemies and waves ------------------------------------------------
    // Both are the session's job. Locally that ticks a simulation right here;
    // in co-op the server has already done it and this is a no-op.
    this.session.reportState(this.player, dt);
    this.session.tick(dt);
    this._drainSessionEvents();
    this._drainNetExtras();

    // The streak is held frozen until the wave's first kill, so the spawn lull
    // between waves never eats a streak the player earned.
    this.streak.setFrozen(this.waveBreak > 0 || this.waveKills === 0);
    this.streak.update(dt);

    // Potions hold between waves, for the same reason the streak does: a perk
    // bought or found during the lull would otherwise burn most of itself down
    // while there is nothing to use it on, which punishes drinking at exactly
    // the moment the game hands you the flask. The break is downtime, so the
    // clock treats it as downtime.
    if (this.waveBreak <= 0) this.potions.update(dt);

    // Streak buffs and potion perks are folded together here, in one place, so
    // neither system has to know the other exists.
    const tier = this.streak.tier;
    const perk = this.potions.mods;
    this.weapons.fireRateScale = tier.fireRate * perk.fireRate;
    this.weapons.reloadScale = tier.reload * perk.reload;
    this.weapons.spreadScale = perk.spread;
    this.weapons.infiniteAmmo = perk.infiniteAmmo;
    this.player.speedScale = tier.speed * perk.speed;
    this.player.regenScale = tier.regen * perk.regen;
    this.player.damageScale = perk.resist;
    this.player.jumpScale = perk.jump;
    this.player.noFallDamage = perk.noFall;

    this._updateStrikes(dt);
    this._updateRockets(dt);
    this.portals.update(dt);
    if (this.portals.ready && this.enemies?.length) {
      for (const e of this.enemies) {
        if (!e.alive) continue;
        if (e._portalCooldown > 0) {
          e._portalCooldown = Math.max(0, e._portalCooldown - dt);
          continue;
        }
        this.portals.tryTraverse(e);
      }
    }
    this._updatePickups(dt);
    this._updateChests(dt);
    this.nuggetDispenser?.update(dt);
    this._updateDinosaurFactory(dt);
    this.reverseAquarium?.update(dt, [this.player, ...(this.remotes ?? [])]);
    this._updateMysteryBox(dt);
    this._updateStones(dt);
    this._updateWaypoint(dt);
    // In a free-for-all the wave banner has nothing to report, so it carries the
    // score race instead.
    let leader = null;
    if (this.session?.isFFA) {
      const self = this.session.self;
      let best = { name: 'YOU', kills: self?.kl ?? 0 };
      for (const r of this.remotes) if (r.kills > best.kills) best = { name: r.name, kills: r.kills };
      leader = { name: best.name, kills: best.kills, target: FFA_KILL_TARGET };
    }
    this.hud.setWave(this.wave, this.waveKills, this.waveTotal, this.waveBreak, leader);
    this.elapsed += dt;
  }

  // ----------------------------------------------------------------- render

  _render(alpha, frameDt, look) {
    this._updateInteriorLights(frameDt);
    const p = this.player;

    // Interpolate the simulation position for smooth motion above 60fps.
    const px = p.prevPos.x + (p.pos.x - p.prevPos.x) * alpha;
    const py = p.prevPos.y + (p.pos.y - p.prevPos.y) * alpha;
    const pz = p.prevPos.z + (p.pos.z - p.prevPos.z) * alpha;

    const piloting = this.travel?.piloting;
    const spaceVisuals = this.travel?.inSpace || this.travel?.mode === 'landing';
    this.travel?.setSpaceVisuals(spaceVisuals);
    // View bob, scaled down from the viewmodel's so it never fights the aim.
    const bob = p.bobAmount * (p.sprinting ? 0.055 : 0.032);
    const bobY = -Math.abs(Math.cos(p.bobPhase)) * bob;
    const bobX = Math.sin(p.bobPhase) * bob * 0.5;

    // Zoom toward the aimed FOV. Driven off adsT so it tracks the same ramp as
    // the sight picture and the accuracy change.
    const targetFov = piloting ? 82 : (this.weapons.canAds
      ? FOV + (this.weapons.def.adsFov - FOV) * this.weapons.adsT
      : FOV) + (this.portals.transitPulse || 0) * 5;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }

    // Push the fog back with the zoom. The 85..260 range is tuned for 78°,
    // where anything past ~150m is a few pixels tall and dissolving it into the
    // sky costs nothing. A scope looks through exactly that band, so at 18° the
    // haze lands on the target instead of behind it and a tree at 200m arrives
    // 66% fog-coloured -- which is the whole "washed out through the scope"
    // complaint. Scaling by the square root of the magnification rather than
    // the magnification itself is deliberate: the full ratio switches the fog
    // off, and then the far hills end on a hard line inside the sight picture.
    const haze = Math.sqrt(FOV / targetFov);
    this.scene.fog.near = spaceVisuals ? 5000 : FOG_NEAR * haze;
    this.scene.fog.far = spaceVisuals ? 6000 : FOG_FAR * haze;

    // Shake is advanced at display rate so it stays smooth regardless of how
    // the simulation is stepping, and applied on top of everything else.
    this.shake.update(frameDt);

    const deathDrop = p.alive ? 0 : -0.9;
    this.camera.position.set(
      px + bobX * 0.3 + this.shake.offsetX,
      py + p.height * 0.91 + bobY + deathDrop + this.shake.offsetY,
      pz + bobX * 0.3,
    );

    // Recoil punch decays in the weapon system; a little roll adds weight.
    // Shake rides on top: recoil is directional and learnable, shake is not.
    this.camera.rotation.set(
      p.pitch + (p.alive ? 0 : -0.7) + this.shake.pitch,
      p.yaw + this.shake.yaw,
      this.weapons.punchYaw * 2.2 + (p.wallRoll || 0) + (p.alive ? 0 : 0.9) + this.shake.roll,
    );
    this.travel?.render(this.camera, p, frameDt);
    this.spinningCat?.update(frameDt, this.camera);
    if (this.drummerTower?.vendingState === 'idle' && this.session?.vendingTime >= 0) {
      this.drummerTower.activateVendingMachine(this.session.vendingTime);
    }
    const vendingEvents = this.drummerTower?.update(frameDt) ?? [];
    for (const event of vendingEvents) {
      const position = { x: event.x, y: event.y, z: event.z };
      if (event.type === 'vending-rattle') {
        this.audio.vendingRattle(position);
        continue;
      }
      if (event.type !== 'vending-explosion') continue;
      this.audio.vendingExplosion(position);
      this.effects.explosion(event.x, event.y, event.z, 4.8);
      const distance = Math.hypot(
        event.x - this.player.pos.x,
        event.y - (this.player.pos.y + this.player.height * 0.5),
        event.z - this.player.pos.z,
      );
      const proximity = Math.max(0, 1 - distance / 36);
      if (proximity > 0) {
        this.shake.add(
          TRAUMA.explosionFar
            + (TRAUMA.explosionNear - TRAUMA.explosionFar) * proximity,
        );
        this.weapons.punchPitch += 0.08 * proximity;
        this.hud.announce('BANANA WEATHER', 2.8, '#f5cf31');
      }
      this.hud.addFeed('320 BANANAS HAVE ENTERED THE FORECAST', '#f5cf31');
    }

    // Rebuild the visible entity set from the newest snapshots, then make sure
    // everything in it has a mesh, then animate. Order matters: a partner who
    // joined this frame has to get an avatar before it can be posed.
    this.session.interpolate(frameDt);
    this._reconcileMeshes();

    for (const e of this.enemies) syncEnemyMesh(e, alpha, frameDt);
    // Name tags are for partners. In a free-for-all the other soldier is the
    // thing you are meant to be hunting, so they are found by looking.
    const tags = !this.session?.isFFA;
    for (const r of this.remotes) syncRemotePlayerMesh(r, this.camera, tags);

    // Damage numbers track their target, so the anchor map is rebuilt from the
    // enemies that still exist. Anything killed keeps its last position and
    // finishes its rise where it fell.
    this._numAnchors.clear();
    for (const e of this.enemies) {
      this._numAnchors.set(e.id, {
        x: e.pos.x, y: e.pos.y + e.type.height * 0.95, z: e.pos.z,
      });
    }
    this.dmgNumbers.update(frameDt, this._numAnchors, (x, y, z) => {
      const m = this._projectMark(x, y, z);
      return m && !m.edge ? m : null;
    });

    this._updateBoards(frameDt);
    this.effects.update(frameDt, this.world);
    const bananaGun = this.travel?.bananaGunActive;
    this.viewmodel.scene.visible = !piloting && !p.climbing;
    if (!piloting && !p.climbing) {
      // Keep the equipped weapon in its ordinary rest pose behind the banana
      // overlay. Freezing this update for the full power-up left a stale
      // close-to-camera/ADS transform to reappear on expiry, making the pistol
      // look enormous for the handoff frame.
      this.viewmodel.update(frameDt, p, this.weapons, look);
      if (bananaGun) {
        for (const model of Object.values(this.viewmodel.models)) model.visible = false;
        this.viewmodel.flash.visible = false;
        this.viewmodel.flamePlume.visible = false;
      }
    }

    // Sky follows the camera so the dome never clips.
    this.sky.position.copy(this.camera.position);
    this.sky.updateMatrix();
    this.sky.updateMatrixWorld(true);
    this.sky.material.uniforms.time.value = this.elapsed;

    this._updateSunShadow();

    // World through the post chain, then the viewmodel straight to the screen
    // with a cleared depth buffer so the gun never intersects geometry.
    this.portals.setFrameTime(frameDt);
    this.portals.renderViews(this.renderer, this.scene, this.camera);
    this.composer.render();
    this.renderer.clearDepth();
    this.renderer.render(this.viewmodel.scene, this.viewmodel.camera);
  }

  _renderStatic() {
    this.sky.position.copy(this.camera.position);
    this.sky.updateMatrix();
    this.sky.updateMatrixWorld(true);
    this.sky.material.uniforms.time.value = this.elapsed;
    this.composer.render();
  }

  // ------------------------------------------------------------------- loop

  frame(now) {
    requestAnimationFrame((t) => this.frame(t));

    if (this.lastTime === 0) this.lastTime = now;
    let frameDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (frameDt > 0.25) frameDt = 0.25;   // tab was hidden; do not catch up

    const look = this.input.consumeLook();

    // The game wants the pointer whenever a round is live and the armoury is
    // not deliberately holding it. Recomputed every frame so a lock lost from a
    // non-gesture context is always recoverable by clicking.
    this.input.wantLock = this.state === STATE.PLAYING && !this.shop.isOpen;

    // Freeze the wave clock while the player is shopping, so the break cannot
    // run out from under an open armoury. Single-player only: in co-op the
    // round belongs to everyone, and one player browsing must not stop the
    // other's game.
    const sim = this.session?.sim;
    if (sim && !this.session.multiplayer) sim.holdBreak = this.shop.isOpen;
    // The controls follow the same condition: visible exactly while there is a
    // round to play and the armoury is not covering it.
    this.touch?.setVisible(this.input.wantLock);

    if (this.state === STATE.PLAYING) {
      // Right mouse aims down sights. Advanced here rather than in _tick so the
      // sights start rising on the very frame the button goes down instead of
      // waiting up to a full 16ms for the next simulation step -- and so the
      // ramp itself runs at monitor rate, which is what makes it feel instant.
      // It runs before applyLook so the sensitivity scale is this frame's.
      this.weapons.updateAds(frameDt,
        this.player.alive && !this.player.climbing && !this.travel?.bananaGunActive
          && this.input.actionDown('ads'));

      // Aim updates at display rate for minimum input latency. Aiming scales it
      // down so magnified aim stays controllable.
      const ls = this.weapons.lookScale;
      if (this.player.alive
        && !this.spinningCat?.focusPlayer(this.player, frameDt)) {
        this.player.applyLook(look.dx * ls, look.dy * ls);
      }
      const hearing = this.player.getLookDir({});
      this.audio.setListener(
        { x: this.player.pos.x, y: this.player.eyeY, z: this.player.pos.z },
        hearing,
      );
      // Launching has a friendly heading assist, but any mouse movement is an
      // unambiguous request to fly manually. Keyboard A/D does the same in the
      // flight controller itself.
      if (this.travel?.inSpace && (Math.abs(look.dx) + Math.abs(look.dy) > 0.01)) this.travel.navTarget = null;

      this.acc += frameDt;
      let ticks = 0;
      while (this.acc >= TICK_DT && ticks < MAX_TICKS_PER_FRAME) {
        this._tick(TICK_DT);
        this.input.endTick();
        this.acc -= TICK_DT;
        ticks++;
      }
      if (ticks === MAX_TICKS_PER_FRAME) this.acc = 0;

      this.hud.update(frameDt);
      this.importantButton?.update(frameDt);
      this._updateHUD();
      this._render(this.acc / TICK_DT, frameDt, look);
      // After the render, so the projections use this frame's camera matrices.
      this._updateTrackers();
      this._updateChestMarks();
      this._updateDownedHUD();
      this._updateWaypointHUD();
      this.shop.update();
      this.audio.setAquariumAmbience(!!this._insideAquarium);
      const towerPerformanceActive = !this.travel?.inSpace
        && onDrummerTowerDeck(this.world.drummerTower, this.player?.pos);
      this.audio.updateDrummer(this.world.drummerTower?.sound, frameDt, towerPerformanceActive);
      this.audio.setIntensity(this._intensity(), frameDt);
    } else if (this.state === STATE.PAUSED || this.state === STATE.DEAD) {
      // Keep drawing so the world is visible behind the menu; effects still
      // settle on the death screen, which reads better than a frozen frame.
      // Lowering the sights is part of that -- pausing mid-aim should not leave
      // the FOV zoomed in behind the menu.
      this.weapons.updateAds(frameDt, false);
      if (this.state === STATE.DEAD) {
        this.acc += frameDt;
        while (this.acc >= TICK_DT) {
          this.player.update(TICK_DT, this.input, false);
          // Advance through the session rather than driving enemies directly:
          // in co-op they belong to the server and have no update() to call.
          this.session?.reportState(this.player, TICK_DT);
          this.session?.tick(TICK_DT);
          this._drainSessionEvents();
          this.input.endTick();
          this.acc -= TICK_DT;
        }
        // Co-op puts the dead back in at the start of the next wave, so watch
        // for the server standing us up again.
        if (this.isMultiplayer && this.session.self?.a === 1) this._respawned();
      }
      this.hud.update(frameDt);
      this._render(1, this.state === STATE.DEAD ? frameDt : 0, { dx: 0, dy: 0 });
    } else if (this.state === STATE.MENU && this.terrain) {
      // Slow orbit behind the menu.
      this.elapsed += frameDt;
      const c = this.world.size / 2;
      const r = 34;
      this.camera.position.set(
        c + Math.cos(this.elapsed * 0.06) * r, 34, c + Math.sin(this.elapsed * 0.06) * r);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(-0.22, -this.elapsed * 0.06 + Math.PI / 2, 0);
      this.effects.update(frameDt, this.world);
      this._renderStatic();
    }
  }

  /**
   * Point the player at the last few enemies of a wave. Without this, one
   * straggler wedged behind a hill stalls the round while the player searches
   * 160 blocks of terrain for it.
   */
  _updateTrackers() {
    const alive = this.enemies.filter((e) => e.alive);
    const stillSpawning = this.waveTotal - this.waveKills > alive.length;
    if (stillSpawning || alive.length === 0 || alive.length > TRACKER_THRESHOLD) {
      if (this._trackersShown) { this.hud.setTrackers([]); this._trackersShown = false; }
      return;
    }
    this._trackersShown = true;

    const marks = [];
    for (const e of alive) {
      const c = e.center(TMP_CENTER);
      marks.push(this._projectMark(c.x, c.y + e.type.height * 0.45, c.z));
    }
    this.hud.setTrackers(marks);
  }

  /**
   * Project a world point to a screen-space pointer.
   *
   * On-screen targets get a chevron floating above them; off-screen ones clamp
   * to the edge of the view with the arrow turned to face them.
   *
   * @returns {{x, y, angle, dist, edge}} in screen pixels
   */
  _projectMark(x, y, z) {
    const W = window.innerWidth, H = window.innerHeight;
    const cx = W / 2, cy = H / 2;
    const margin = 46;

    TMP_VEC.set(x, y, z);

    // Camera space first: points behind the camera project to a mirrored
    // position, so they must be detected before the perspective divide.
    TMP_VEC2.copy(TMP_VEC).applyMatrix4(this.camera.matrixWorldInverse);
    const behind = TMP_VEC2.z > -0.05;

    TMP_VEC.project(this.camera);
    let sx = (TMP_VEC.x * 0.5 + 0.5) * W;
    let sy = (-TMP_VEC.y * 0.5 + 0.5) * H;
    if (behind) { sx = W - sx; sy = H - sy; }

    const dist = Math.hypot(x - this.player.pos.x, z - this.player.pos.z);
    const offScreen = behind || sx < margin || sx > W - margin || sy < margin || sy > H - margin;

    if (!offScreen) return { x: sx, y: sy - 30, angle: Math.PI, dist, edge: false };

    // Clamp to the screen edge along the direction from centre, and rotate the
    // arrow to point outward toward the target.
    let vx = sx - cx, vy = sy - cy;
    const len = Math.hypot(vx, vy) || 1;
    vx /= len; vy /= len;
    const scale = Math.min(
      (cx - margin) / Math.max(1e-4, Math.abs(vx)),
      (cy - margin) / Math.max(1e-4, Math.abs(vy)),
    );
    // The arrow art points up, i.e. screen direction (0, -1). Rotating that
    // onto (vx, vy) under CSS's clockwise rotation needs atan2(vx, -vy).
    return {
      x: cx + vx * scale,
      y: cy + vy * scale,
      angle: Math.atan2(vx, -vy),
      dist,
      edge: true,
    };
  }

  /** Mark the nearest few unopened chests, closest first. */
  _updateChestMarks() {
    const p = this.player.pos;
    const near = [];
    for (const c of this.chests) {
      if (c.opened) continue;
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d <= CHEST_MARK_RANGE) near.push({ c, d });
    }
    near.sort((a, b) => a.d - b.d);

    const marks = [];
    for (const { c } of near.slice(0, CHEST_MARK_MAX)) {
      const mark = this._projectMark(c.x, c.y + 1.7, c.z);
      // Only worth drawing when the chest is actually in front of the player;
      // an edge arrow for every chest would clutter the view for something
      // that is never urgent.
      if (!mark.edge) marks.push(mark);
    }
    this.hud.setChestMarks(marks);
  }

  /**
   * Everything about bleeding out that has to be visible rather than inferred:
   * where downed teammates are, how long they have left, and how far along a
   * pick-up is.
   *
   * The build before this announced "X IS DOWN" once into the kill feed and
   * left it there. In a firefight that is indistinguishable from nothing
   * happening -- the line has scrolled away before you look, and nothing on
   * screen says where they fell or how long they have.
   */
  _updateDownedHUD() {
    const remotes = this.session?.remotes ?? [];
    const marks = [];
    let nearest = null;
    let nearestDist = Infinity;

    for (const r of remotes) {
      if (!r.down || !r.alive) continue;
      const mark = this._projectMark(r.pos.x, r.pos.y + 1.2, r.pos.z);
      mark.name = r.name;
      marks.push(mark);
      if (mark.dist < nearestDist) { nearestDist = mark.dist; nearest = r; }
    }
    this.hud.setDownMarks(marks);

    // Our own bleed-out clock wins the banner: it is the only one carrying a
    // deadline the player can do nothing about except wait it out.
    const self = this.session?.self;
    if (self && self.dn === 1) {
      const bleed = Math.max(0, self.bl ?? 0);
      const reviving = (self.rv ?? 0) > 0;
      this.hud.setRevive({
        title: reviving ? 'BEING REVIVED' : 'DOWNED',
        sub: reviving ? 'HOLD STILL' : `BLEEDING OUT — ${Math.ceil(bleed)}s`,
        progress: reviving ? self.rv / REVIVE_TIME : bleed / BLEED_OUT,
        bleed: !reviving,
      });
      return;
    }

    if (nearest && nearestDist <= REVIVE_RANGE) {
      this.hud.setRevive({
        title: `REVIVING ${nearest.name}`,
        sub: 'STAY CLOSE',
        progress: (nearest.reviveProgress ?? 0) / REVIVE_TIME,
        bleed: false,
      });
      return;
    }

    if (nearest) {
      this.hud.setRevive({
        title: `${nearest.name} IS DOWN`,
        sub: `${Math.round(nearestDist)}m AWAY — GO PICK THEM UP`,
        progress: Math.max(0, nearest.bleed ?? 0) / BLEED_OUT,
        bleed: true,
      });
      return;
    }

    this.hud.setRevive(null);
  }

  /** Draw the marker for whatever stone a treasure map revealed. */
  _updateWaypointHUD() {
    if (!this.waypoint) { this.hud.setWaypoint(null); return; }
    const s = this.waypoint;
    const mark = this._projectMark(s.x, s.y + 1.4, s.z);
    mark.color = '#' + s.def.color.toString(16).padStart(6, '0');
    mark.label = s.def.label;
    this.hud.setWaypoint(mark);
  }

  /** The weapon list shows only what the player is actually carrying. */
  _refreshWeaponList() {
    const owned = this.weapons.owned;
    this.hud.buildWeaponList(owned, owned.indexOf(this.weapons.current));
  }

  _updateHUD() {
    const w = this.weapons.current;
    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setCoins(this.coins);
    // Re-asserted every frame so the head count follows people coming and
    // going, and so solo play clears the tag without a special case.
    this.hud.setRoom(this.net?.room ?? null, 1 + (this.session?.remotes?.length ?? 0));

    // The boss bar tracks whichever boss is alive, so a wave with two of them
    // shows the one still standing rather than a stale bar for a dead one.
    const boss = this.enemies.find((e) => (e.type.boss || e.type.miniboss) && e.alive);
    this.hud.setBoss(boss ? {
      name: boss.type.label,
      health: boss.health,
      maxHealth: boss.maxHealth,
      enraged: boss.enraged,
    } : null);
    this.hud.setAmmo(w, this.weapons.isReloading);
    this._refreshWeaponList();
    this.hud.setAds(this.weapons.adsT, this.weapons.adsSight, w.def.adsHoloColor ?? '');

    // Free-for-all scoreboard. Self comes from the sim's own record rather than
    // the local Player, because kills are the server's tally, not ours.
    if (this.session?.isFFA) {
      const me = this.session.selfId;
      const self = this.session.self;
      const rows = [{
        name: 'YOU',
        kills: self?.kl ?? 0,
        alive: (self?.a ?? 1) === 1,
        respawn: self?.rs ?? 0,
        me: true,
      }];
      for (const r of this.remotes) {
        rows.push({ name: r.name, kills: r.kills, alive: r.alive, respawn: r.respawn, me: false });
      }
      void me;
      this.hud.setFFA(rows, FFA_KILL_TARGET);
    } else {
      this.hud.setFFA(EMPTY_ROWS, 0);
    }

    this.hud.setStreak(this.streak);
    // Poison rides the same status column as the potion perks, so the player
    // reads "something is ticking on me" in one place.
    const statuses = this.potions.list.slice();
    if (this.player.poisoned) {
      const p = this.player.poison;
      statuses.unshift({
        def: {
          id: 'poison', name: 'POISONED', color: 0x86b83a,
          blurb: `${Math.ceil(p.remaining)} damage remaining`,
          duration: p.duration,
        },
        time: p.timeLeft,
      });
    }
    this.hud.setEffects(statuses);
    this.hud.setTravel(this.travel?.hudInfo() ?? null);
    // Losing the pointer mid-round outranks every other prompt: until it is back
    // the player cannot look around, so nothing else is worth telling them.
    const lostPointer = !this.input.locked && !this.shop.isOpen;
    // The armoury is only open between waves, so the break has to advertise
    // itself -- an unsignposted window the player has to already know about is
    // the same as no window at all.
    const breakOpen = this.waveBreak > 0 && !this.shop.isOpen;
    const travelPrompt = this.travel?.prompt(this.player);
    const ladderPrompt = this._ladderPrompt();
    this.hud.setPrompt(lostPointer
      ? 'CLICK TO RESUME LOOKING'
      : travelPrompt
        ? travelPrompt
      : ladderPrompt
        ? ladderPrompt
      : breakOpen
        ? `${pressWord()} ${ctrl('armoury')} — ARMOURY (${Math.ceil(this.waveBreak)}s)`
        // A door is the most specific thing you can be standing at.
        : (this._secretInReach()
            ? `${pressWord()} ${ctrl('interact')} — SOMETHING BEHIND THIS PANEL`
            : this._doorPrompt()
          ?? this._bananaVendingPrompt()
          ?? this._boxPrompt()
          ?? this._dinosaurFactoryPrompt()
          ?? this._nuggetDispenserPrompt()
          ?? (this._chestInReach() ? `${pressWord()} ${ctrl('interact')} — OPEN CHEST` : null)
          ?? (this.importantButton?.targetedBy(this.player, this.world)
            ? `${pressWord()} ${ctrl('interact')} — PRIORITY OVERRIDE`
            : '')));

    const full = this.collectedStones.size === STONES.length;
    this.hud.setGauntlet(this.collectedStones,
      this.snapArmed ? 'armed' : full ? 'ready' : '');
    // Feed the live camera FOV in, so the crosshair still matches the cone
    // while zoomed rather than reading against the hip-fire projection.
    this.hud.setSpread(
      this.weapons.spread(this.player),
      THREE.MathUtils.degToRad(this.camera.fov),
      window.innerHeight);
  }

  start() {
    requestAnimationFrame((t) => { this.lastTime = t; this.frame(t); });
  }
}

// ---------------------------------------------------------------- bootstrap

/**
 * Put a failure on the screen.
 *
 * Everything below used to be unguarded: `new Game()` builds the renderer in its
 * constructor and `game.load()` was called without an await or a catch, so any
 * throw -- a missing WebGL2 context, a shader that would not compile, a bad
 * asset -- became an unhandled rejection and left the loading panel sitting at
 * whatever step it had reached, forever, saying nothing. "It will not load" with
 * no way to tell why is the worst failure mode a browser game can have, and it
 * is worse than the underlying bug because it hides it.
 *
 * Deliberately raw DOM: this has to work when the Game object does not exist.
 */
function fatal(message, detail) {
  const panel = document.getElementById('panel-load');
  const label = document.getElementById('loading');
  const bar = document.getElementById('loadbar');
  const overlay = document.getElementById('overlay');
  try {
    overlay?.classList.remove('hidden');
    panel?.classList.remove('hidden');
    if (bar) bar.style.display = 'none';
    if (label) {
      label.textContent = message;
      label.className = 'fatal';
    }
    if (detail) {
      const pre = document.createElement('div');
      pre.className = 'fatal-detail';
      pre.textContent = String(detail).slice(0, 400);
      panel?.appendChild(pre);
    }
  } catch { /* nothing left to try */ }
  console.error('[upvote-uprising] fatal:', message, detail || '');
}

/**
 * WebGL2, checked before anything needs it.
 *
 * The terrain's layered ground material samples a sampler2DArray out of a
 * DataArrayTexture, and both are WebGL2-only. Without this the failure surfaces
 * deep inside terrain construction as an opaque shader or texture error, which
 * is a miserable way to learn your browser is running WebGL1.
 */
function webgl2Available() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch { return false; }
}

if (!webgl2Available()) {
  fatal('THIS BROWSER CANNOT RUN THE GAME',
    'UPVOTE UPRISING needs WebGL2. Update your browser, or enable hardware '
    + 'acceleration in its settings — on desktop Chrome that is '
    + 'Settings → System → "Use graphics acceleration when available".');
} else {
  let game = null;
  try {
    game = new Game();
    window.__game = game;   // handy for debugging from the console
    game.start();
  } catch (err) {
    fatal('FAILED TO START', err?.stack || err?.message || err);
  }
  // Awaited properly now, so a failure during world generation reports itself
  // instead of stalling the progress bar at whichever step threw.
  if (game) {
    game.load().catch((err) => fatal('FAILED TO LOAD', err?.stack || err?.message || err));
  }
}

// Anything that escapes the paths above still reaches the player rather than
// only the console they are not looking at.
window.addEventListener('error', (e) => {
  if (document.getElementById('panel-load')?.classList.contains('hidden')) return;
  fatal('FAILED TO LOAD', e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  if (document.getElementById('panel-load')?.classList.contains('hidden')) return;
  fatal('FAILED TO LOAD', e.reason?.stack || e.reason?.message || e.reason);
});
