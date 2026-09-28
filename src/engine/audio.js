// UI blips and deliberately fantastic effects remain synthesised at runtime.
// Gunshots, impacts, voices and music use bundled CC0 field recordings where a
// noise oscillator would call attention to itself as fake.

/** CC0 score playlist. The first export is retained for old callers/tests. */
export const MUSIC_TRACKS = Object.freeze([
  'assets/audio/lost_in_a_bad_place.ogg',
  'assets/audio/insistent.ogg',
  'assets/audio/zombies_are_coming.ogg',
]);
export const MUSIC_TRACK = MUSIC_TRACKS[0];
/** CC0 horror loop reserved for the reverse-aquarium human enclosure. */
export const AQUARIUM_MUSIC_TRACK = MUSIC_TRACKS[0];
/** Slightly above the original room mix without competing with combat audio. */
export const AQUARIUM_MUSIC_GAIN = 0.12;
/** Short CC0 human reaction used by the red wall button. */
export const BUTTON_MOAN_TRACK = 'assets/audio/button_male_moan.mp3';
/** CC0 blowtorch recording by SamsterBirdies, used as the burner body. */
export const FLAMETHROWER_TRACK = 'assets/audio/flamethrower_cc0.mp3';
/** CC0 industrial blast with loose-metal clatter for the banana machine. */
export const VENDING_EXPLOSION_TRACK = 'assets/audio/mechanical_explosion.wav';
/** Tempo shared with the animated rooftop performance. */
export const DRUMMER_BPM = 112;

/**
 * Close-mic firearm and material-impact recordings bundled with the game.
 * Multiple takes rotate instead of pitch-randomising one recognisable sample.
 */
export const RECORDED_SOUNDS = Object.freeze({
  pistol: Object.freeze([
    'assets/audio/gunshots/pistol_1.mp3',
    'assets/audio/gunshots/pistol_2.mp3',
    'assets/audio/gunshots/pistol_3.mp3',
  ]),
  deagle: Object.freeze([
    'assets/audio/gunshots/deagle_1.mp3',
    'assets/audio/gunshots/deagle_2.mp3',
  ]),
  smg: Object.freeze([
    'assets/audio/gunshots/smg_1.mp3',
    'assets/audio/gunshots/smg_2.mp3',
    'assets/audio/gunshots/smg_3.mp3',
  ]),
  rifle: Object.freeze([
    'assets/audio/gunshots/rifle_1.mp3',
    'assets/audio/gunshots/rifle_2.mp3',
  ]),
  minigun: Object.freeze([
    'assets/audio/gunshots/minigun_1.mp3',
    'assets/audio/gunshots/minigun_2.mp3',
    'assets/audio/gunshots/minigun_3.mp3',
    'assets/audio/gunshots/minigun_4.mp3',
  ]),
  shotgun: Object.freeze([
    'assets/audio/gunshots/shotgun_1.mp3',
    'assets/audio/gunshots/shotgun_2.mp3',
  ]),
  sniper: Object.freeze([
    'assets/audio/gunshots/sniper_1.mp3',
    'assets/audio/gunshots/sniper_2.mp3',
  ]),
  hit: Object.freeze([
    'assets/audio/impacts/meat01.ogg',
    'assets/audio/impacts/meat02.ogg',
  ]),
  impact: Object.freeze([
    'assets/audio/impacts/stone.ogg',
    'assets/audio/impacts/metal.ogg',
    'assets/audio/impacts/wood.ogg',
  ]),
  vendingRattle: Object.freeze([
    'assets/audio/impacts/metal.ogg',
  ]),
  vendingExplosion: Object.freeze([
    VENDING_EXPLOSION_TRACK,
  ]),
});

const RECORDED_LEVELS = Object.freeze({
  // Firearm transients deliberately sit above flesh impacts. A hit should add
  // information to the report, never replace the report with a wet thud.
  pistol: 0.62,
  deagle: 0.72,
  smg: 0.28,
  rifle: 0.48,
  minigun: 0.12,
  shotgun: 0.7,
  sniper: 0.74,
});

export class AudioSystem {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.enabled = true;
    this.shipEngine = null;
    this.flamethrower = null;
    this.flamethrowerBuffer = null;
    this.flamethrowerLoading = null;
    this.musicSource = null;
    this.musicLoading = null;
    this.musicBuffers = [];
    this.musicIndex = -1;
    this.musicToken = 0;
    this.aquariumActive = false;
    this.aquariumBuffer = null;
    this.aquariumMusic = null;
    this.recordedBuffers = new Map();
    this.recordedCursor = new Map();
    this.recordedLoading = null;
    this.buttonMoanBuffer = null;
    this.buttonMoanLoading = null;
    this.drummerActive = false;
    this.drummerTime = 0;
    this.drummerStep = -1;
  }

  /** Must be called from a user gesture (browsers block autoplay otherwise). */
  init() {
    if (!this.enabled) return false;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        try {
          const resumed = this.ctx.resume();
          if (resumed?.catch) resumed.catch(() => {});
        } catch { /* audio stays suspended; gameplay still starts */ }
      }
      return true;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return false; }

    try {
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);

      // One second of white noise, reused by every percussive sound.
      const len = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;

      this._initMusic();
      this._loadRecordedSounds();
      this._loadButtonMoan();
      this._loadFlamethrower();
      return true;
    } catch (error) {
      // Firefox privacy settings and some Safari configurations expose the
      // constructor but reject context creation. Audio is optional; allowing
      // that exception to escape the Play/Host click made the menu look frozen.
      try {
        const closing = this.ctx?.close?.();
        if (closing?.catch) closing.catch(() => {});
      } catch { /* a half-created context may not be closable */ }
      this.ctx = null;
      this.master = null;
      this.noiseBuffer = null;
      this.enabled = false;
      console.warn('Web Audio unavailable; continuing without sound', error);
      return false;
    }
  }

  // ------------------------------------------------------------------- music

  /** Decode the playlist, then let each complete composition hand off to the next. */
  _initMusic() {
    const ctx = this.ctx;

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = 0;
    this.musicGain.connect(this.master);
    this.intensity = 0;

    // Decode independently so one unavailable track does not silence the other
    // two. Loading still begins inside the user's gesture for autoplay safety.
    this.musicLoading = Promise.all(MUSIC_TRACKS.map(async (track) => {
      try {
        const response = await fetch(track);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await ctx.decodeAudioData(await response.arrayBuffer());
      } catch (error) {
        console.warn(`CC0 music track unavailable: ${track}`, error);
        return null;
      }
    })).then((buffers) => {
      if (this.ctx !== ctx) return;
      this.aquariumBuffer = buffers[MUSIC_TRACKS.indexOf(AQUARIUM_MUSIC_TRACK)] ?? null;
      this.musicBuffers = buffers.filter(Boolean);
      if (!this.musicBuffers.length) {
        console.warn('CC0 music unavailable; continuing without music');
        return;
      }
      this._playNextMusicTrack();
      if (this.aquariumActive) this._startAquariumMusic();
    });
  }

  _playNextMusicTrack() {
    if (!this.ctx || !this.musicGain || this.musicSource || !this.musicBuffers.length) return false;
    this.musicIndex = (this.musicIndex + 1) % this.musicBuffers.length;
    const source = this.ctx.createBufferSource();
    source.buffer = this.musicBuffers[this.musicIndex];
    source.loop = false;
    source.connect(this.musicGain);
    const token = ++this.musicToken;
    source.onended = () => {
      if (this.musicSource !== source || this.musicToken !== token) return;
      this.musicSource = null;
      this._playNextMusicTrack();
    };
    this.musicSource = source;
    source.start();
    return true;
  }

  /** Start the enclosure's real horror loop once and keep it ready to fade. */
  _startAquariumMusic() {
    if (!this.ctx || !this.master || !this.aquariumBuffer || this.aquariumMusic) return false;
    const source = this.ctx.createBufferSource();
    source.buffer = this.aquariumBuffer;
    source.loop = true;
    // A small slowdown makes the separate room mix feel heavier without
    // replacing the licensed recording with a conspicuous synth drone.
    source.playbackRate.value = 0.94;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1450;
    filter.Q.value = 0.72;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    source.connect(filter).connect(gain).connect(this.master);
    source.start();
    this.aquariumMusic = { source, filter, gain };
    return true;
  }

  /** Cross-fade the creepy enclosure score on room entry and exit. */
  setAquariumAmbience(active) {
    if (!this.ctx) return false;
    this.aquariumActive = !!active;
    if (this.aquariumActive) this._startAquariumMusic();
    if (this.aquariumMusic) {
      this.aquariumMusic.gain.gain.setTargetAtTime(
        this.aquariumActive ? AQUARIUM_MUSIC_GAIN : 0,
        this.t, this.aquariumActive ? 0.7 : 0.42,
      );
      this.aquariumMusic.filter.frequency.setTargetAtTime(
        this.aquariumActive ? 1250 : 700, this.t, 0.8,
      );
    }
    return true;
  }

  /**
   * Drive the score. `intensity` is 0..1; the caller decides what feeds it.
   *
   * Gain is ramped rather than assigned, because assigning to an AudioParam
   * mid-stream produces a click. The real recording stays musically intact;
   * combat only nudges it slightly louder instead of filtering or pitch-bending
   * it into another continuous noise.
   */
  setIntensity(intensity, dt) {
    if (!this.ctx || !this.musicGain) return;
    const i = Math.max(0, Math.min(1, intensity));
    // Ease toward the target so a single kill does not lurch the mix.
    this.intensity += (i - this.intensity) * Math.min(1, (dt || 0.016) * 1.5);
    const k = this.intensity;
    const t = this.t;

    // The roof performance replaces the score locally. Everywhere below the
    // deck keeps the normal playlist; synth drums no longer leak across the map.
    const scoreLevel = this.aquariumActive ? 0.006
      : this.drummerActive ? 0.01
        : 0.065 + k * 0.04;
    this.musicGain.gain.setTargetAtTime(scoreLevel, t, 0.8);
  }

  /** Silence the score without tearing the graph down. */
  stopMusic() {
    if (this.musicGain) this.musicGain.gain.setTargetAtTime(0, this.t, 0.3);
    this.setAquariumAmbience(false);
    this.intensity = 0;
  }

  /**
   * A continuous rocket motor whose pitch, combustion hiss and volume follow
   * actual thrust. The graph is created lazily so ordinary FPS play pays no
   * extra audio cost before anyone boards the Starling.
   */
  _initShipEngine() {
    if (!this.ctx || !this.master || this.shipEngine) return;
    const ctx = this.ctx;
    const gain = ctx.createGain(); gain.gain.value = 0; gain.connect(this.master);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 520; filter.Q.value = 1.25; filter.connect(gain);

    const low = ctx.createOscillator();
    low.type = 'sawtooth'; low.frequency.value = 48; low.connect(filter); low.start();
    const turbine = ctx.createOscillator();
    turbine.type = 'triangle'; turbine.frequency.value = 92; turbine.connect(filter); turbine.start();

    const noiseGain = ctx.createGain(); noiseGain.gain.value = 0.32; noiseGain.connect(filter);
    const combustion = ctx.createBufferSource();
    combustion.buffer = this.noiseBuffer; combustion.loop = true;
    combustion.connect(noiseGain); combustion.start();
    this.shipEngine = { gain, filter, low, turbine, noiseGain, combustion };
  }

  setShipEngine(power) {
    if (!this.ctx) return false;
    this._initShipEngine();
    if (!this.shipEngine) return false;
    const p = Math.max(0, Math.min(1, power || 0));
    const { gain, filter, low, turbine, noiseGain } = this.shipEngine;
    gain.gain.setTargetAtTime(p > 0.01 ? 0.018 + p * 0.145 : 0, this.t, p > 0.01 ? 0.06 : 0.18);
    filter.frequency.setTargetAtTime(360 + p * 1550, this.t, 0.08);
    low.frequency.setTargetAtTime(43 + p * 48, this.t, 0.09);
    turbine.frequency.setTargetAtTime(82 + p * 128, this.t, 0.07);
    noiseGain.gain.setTargetAtTime(0.18 + p * 0.46, this.t, 0.08);
    return true;
  }

  stopShipEngine() {
    if (!this.shipEngine || !this.ctx) return;
    this.shipEngine.gain.gain.setTargetAtTime(0, this.t, 0.16);
  }

  /**
   * Build the flamethrower's sustained combustion graph once.
   *
   * A flamethrower is a pressurised stream, not a machine gun. Re-triggering a
   * short noise burst for every unit of fuel makes the apparent motor restart
   * eleven times a second and produces a choppy "chuff". Two differently
   * filtered loops give the held trigger a continuous low roar and high fuel
   * hiss, while the oscillator supplies the burner rumble underneath.
   */
  _initFlamethrower() {
    if (!this.ctx || !this.master || this.flamethrower) return;
    const ctx = this.ctx;
    const output = ctx.createGain(); output.gain.value = 0; output.connect(this.master);

    const roarFilter = ctx.createBiquadFilter();
    roarFilter.type = 'lowpass'; roarFilter.frequency.value = 980; roarFilter.Q.value = 0.72;
    const roarGain = ctx.createGain(); roarGain.gain.value = 0.42;
    roarFilter.connect(roarGain).connect(output);
    const roar = ctx.createBufferSource();
    roar.buffer = this.noiseBuffer; roar.loop = true; roar.playbackRate.value = 0.71;
    roar.connect(roarFilter); roar.start();

    const hissFilter = ctx.createBiquadFilter();
    hissFilter.type = 'bandpass'; hissFilter.frequency.value = 2550; hissFilter.Q.value = 0.58;
    const hissGain = ctx.createGain(); hissGain.gain.value = 0.15;
    hissFilter.connect(hissGain).connect(output);
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noiseBuffer; hiss.loop = true; hiss.playbackRate.value = 1.37;
    hiss.connect(hissFilter); hiss.start();

    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass'; rumbleFilter.frequency.value = 145; rumbleFilter.Q.value = 0.9;
    const rumbleGain = ctx.createGain(); rumbleGain.gain.value = 0.1;
    rumbleFilter.connect(rumbleGain).connect(output);
    const rumble = ctx.createOscillator();
    rumble.type = 'sawtooth'; rumble.frequency.value = 57;
    rumble.connect(rumbleFilter); rumble.start();

    this.flamethrower = {
      active: false, output, roar, roarFilter, roarGain,
      hiss, hissFilter, hissGain, rumble, rumbleFilter, rumbleGain,
      recording: null,
    };
  }

  /** Decode the real burner once; the synthesised graph remains the fallback. */
  _loadFlamethrower() {
    if (!this.ctx || this.flamethrowerLoading || this.flamethrowerBuffer) return;
    const ctx = this.ctx;
    this.flamethrowerLoading = fetch(FLAMETHROWER_TRACK)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => ctx.decodeAudioData(bytes))
      .then((buffer) => {
        if (this.ctx !== ctx) return;
        this.flamethrowerBuffer = buffer;
        if (this.flamethrower?.active) this._startFlamethrowerRecording();
      })
      .catch((error) => console.warn(
        'CC0 flamethrower recording unavailable; using synthesised burner', error));
  }

  /** Play the recording's real ignition once, then loop only its steady burn. */
  _startFlamethrowerRecording() {
    const flame = this.flamethrower;
    if (!this.ctx || !flame || !this.flamethrowerBuffer || flame.recording) return false;
    const source = this.ctx.createBufferSource();
    source.buffer = this.flamethrowerBuffer;
    source.loop = true;
    // Measured at matching zero crossings inside the recording's steady body,
    // after its authored ignition and before its authored shutdown tail.
    source.loopStart = 1.288866;
    source.loopEnd = 11.280204;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.82;
    source.connect(gain).connect(flame.output);
    source.start();
    flame.recording = { source, gain };
    return true;
  }

  /** Fade the burner in or out without recreating any looping source nodes. */
  setFlamethrower(active) {
    if (!this.ctx) return false;
    const on = !!active;
    if (on) this._initFlamethrower();
    const flame = this.flamethrower;
    if (!flame) return false;

    const wasActive = flame.active;
    flame.active = on;
    flame.output.gain.setTargetAtTime(on ? 0.235 : 0, this.t, on ? 0.035 : 0.12);
    flame.roarFilter.frequency.setTargetAtTime(on ? 1120 : 520, this.t, 0.08);
    flame.hissFilter.frequency.setTargetAtTime(on ? 2850 : 1550, this.t, 0.06);
    flame.rumble.frequency.setTargetAtTime(on ? 62 : 48, this.t, 0.09);

    // Ignition is an edge, not an ammo-tick sound. It gives the jet a distinct
    // light-up transient and then gets out of the way of the seamless loops.
    if (on && !wasActive) {
      this._startFlamethrowerRecording();
      this._noise({ dur: 0.16, gain: 0.32, freq: 1450, endFreq: 5200, q: 0.65, type: 'bandpass' });
      this._tone({ freq: 82, endFreq: 55, dur: 0.18, gain: 0.13, type: 'triangle' });
    } else if (!on && wasActive && flame.recording) {
      const recording = flame.recording;
      recording.gain.gain.setTargetAtTime(0, this.t, 0.07);
      recording.source.stop(this.t + 0.22);
      flame.recording = null;
    }
    return true;
  }

  stopFlamethrower() { return this.setFlamethrower(false); }

  get t() { return this.ctx.currentTime; }

  /**
   * Keep Web Audio's listener on the player's ears so world sounds have a real
   * direction and distance. Local weapon/UI sounds bypass this spatial stage.
   */
  setListener(position, forward = { x: 0, y: 0, z: -1 }) {
    if (!this.ctx?.listener || !position) return false;
    const listener = this.ctx.listener;
    const t = this.t;
    const set = (param, value) => param?.setValueAtTime?.(Number(value) || 0, t);
    let fx = Number(forward.x) || 0;
    let fy = Number(forward.y) || 0;
    let fz = Number(forward.z);
    if (!Number.isFinite(fz)) fz = -1;
    const forwardLength = Math.hypot(fx, fy, fz) || 1;
    fx /= forwardLength; fy /= forwardLength; fz /= forwardLength;
    // Project world-up onto the listener plane. Keeping a fixed (0, 1, 0)
    // while looking upward makes Web Audio's forward/up vectors non-orthogonal
    // and can collapse left/right panning near the vertical pitch limit.
    let ux = -fx * fy;
    let uy = 1 - fy * fy;
    let uz = -fz * fy;
    const upLength = Math.hypot(ux, uy, uz);
    if (upLength > 0.0001) {
      ux /= upLength; uy /= upLength; uz /= upLength;
    } else {
      ux = 0; uy = 0; uz = fy >= 0 ? 1 : -1;
    }
    if (listener.positionX) {
      set(listener.positionX, position.x);
      set(listener.positionY, position.y);
      set(listener.positionZ, position.z);
    } else {
      listener.setPosition?.(position.x, position.y, position.z);
    }
    if (listener.forwardX) {
      set(listener.forwardX, fx);
      set(listener.forwardY, fy);
      set(listener.forwardZ, fz);
      set(listener.upX, ux); set(listener.upY, uy); set(listener.upZ, uz);
    } else {
      listener.setOrientation?.(fx, fy, fz, ux, uy, uz);
    }
    return true;
  }

  /** Build an HRTF stage that fades fully out at maxDistance. */
  _spatialOutput(position, {
    refDistance = 2.5, maxDistance = 70, rolloffFactor = 1,
  } = {}) {
    if (!position || !this.ctx?.createPanner) return this.master;
    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'linear';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = rolloffFactor;
    if (panner.positionX) {
      panner.positionX.setValueAtTime(position.x, this.t);
      panner.positionY.setValueAtTime(position.y, this.t);
      panner.positionZ.setValueAtTime(position.z, this.t);
    } else {
      panner.setPosition?.(position.x, position.y, position.z);
    }
    panner.connect(this.master);
    return panner;
  }

  _noise({
    dur = 0.2, gain = 0.5, freq = 1200, endFreq = 200, q = 1, type = 'lowpass',
    delay = 0, position = null, spatial = undefined,
  }) {
    if (!this.ctx) return;
    const start = this.t + Math.max(0, delay);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 1;

    const filt = this.ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(freq, start);
    filt.frequency.exponentialRampToValueAtTime(Math.max(40, endFreq), start + dur);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);

    src.connect(filt).connect(g).connect(this._spatialOutput(position, spatial));
    src.start(start);
    src.stop(start + dur + 0.02);
  }

  _tone({
    freq = 440, endFreq = freq, dur = 0.1, gain = 0.2, type = 'square',
    delay = 0, position = null, spatial = undefined,
  }) {
    if (!this.ctx) return;
    const start = this.t + Math.max(0, delay);
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), start + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(this._spatialOutput(position, spatial));
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  /** Decode every short real-world effect once; synthesis remains the fallback. */
  _loadRecordedSounds() {
    if (!this.ctx) return Promise.resolve(null);
    if (this.recordedLoading) return this.recordedLoading;
    const ctx = this.ctx;
    this.recordedLoading = Promise.all(Object.entries(RECORDED_SOUNDS).map(async ([profile, tracks]) => {
      const buffers = (await Promise.all(tracks.map(async (track) => {
        try {
          const response = await fetch(track);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await ctx.decodeAudioData(await response.arrayBuffer());
        } catch (error) {
          console.warn(`CC0 sound unavailable: ${track}`, error);
          return null;
        }
      }))).filter(Boolean);
      if (this.ctx === ctx && buffers.length) this.recordedBuffers.set(profile, buffers);
    })).then(() => this.recordedBuffers);
    return this.recordedLoading;
  }

  /** Play the next authored take for a profile with only tiny speed variation. */
  _playRecorded(profile, gain = RECORDED_LEVELS[profile] ?? 0.3, rate = 1, {
    delay = 0, position = null, spatial = undefined,
  } = {}) {
    if (!this.ctx || !this.master) return false;
    const buffers = this.recordedBuffers.get(profile);
    if (!buffers?.length) return false;
    const cursor = this.recordedCursor.get(profile) ?? 0;
    this.recordedCursor.set(profile, cursor + 1);

    const source = this.ctx.createBufferSource();
    source.buffer = buffers[cursor % buffers.length];
    // A few percent keeps repeated automatic fire alive without turning a real
    // gunshot into a cartoonishly pitch-shifted effect.
    const variants = [0.985, 1, 1.015];
    source.playbackRate.value = rate * variants[cursor % variants.length];
    const level = this.ctx.createGain();
    level.gain.value = gain;
    source.connect(level).connect(this._spatialOutput(position, spatial));
    source.start(this.t + Math.max(0, delay));
    return true;
  }

  // ---------------------------------------------------------- rhythm tower

  /** A deep, short pitch dive with enough attack to read as a kick outdoors. */
  _drumKick(position, gain = 0.34) {
    const world = { position, spatial: { refDistance: 8, maxDistance: 145, rolloffFactor: 0.82 } };
    this._tone({
      freq: 152, endFreq: 43, dur: 0.19, gain, type: 'sine', ...world,
    });
    this._noise({
      dur: 0.026, gain: gain * 0.25, freq: 2300, endFreq: 540,
      q: 0.75, type: 'bandpass', ...world,
    });
  }

  /** Noise wires plus a compact shell tone, both from the same rooftop point. */
  _drumSnare(position, gain = 0.23) {
    const world = { position, spatial: { refDistance: 8, maxDistance: 140, rolloffFactor: 0.85 } };
    this._noise({
      dur: 0.16, gain, freq: 5200, endFreq: 720,
      q: 0.7, type: 'bandpass', ...world,
    });
    this._tone({
      freq: 205, endFreq: 142, dur: 0.095, gain: gain * 0.42,
      type: 'triangle', ...world,
    });
  }

  _drumHat(position, open = false) {
    const world = { position, spatial: { refDistance: 7, maxDistance: 118, rolloffFactor: 0.9 } };
    this._noise({
      dur: open ? 0.24 : 0.052,
      gain: open ? 0.095 : 0.066,
      freq: open ? 9200 : 11000,
      endFreq: open ? 4300 : 6800,
      q: 0.52,
      type: 'highpass',
      ...world,
    });
  }

  _drumTom(position, high = false, gain = 0.2) {
    const world = { position, spatial: { refDistance: 8, maxDistance: 135, rolloffFactor: 0.84 } };
    this._tone({
      freq: high ? 184 : 126,
      endFreq: high ? 112 : 72,
      dur: high ? 0.18 : 0.24,
      gain,
      type: 'sine',
      ...world,
    });
    this._noise({
      dur: 0.055, gain: gain * 0.24, freq: 1700, endFreq: 460,
      q: 0.8, type: 'bandpass', ...world,
    });
  }

  _drumCrash(position) {
    const world = { position, spatial: { refDistance: 9, maxDistance: 150, rolloffFactor: 0.8 } };
    this._noise({
      dur: 0.9, gain: 0.13, freq: 10500, endFreq: 2600,
      q: 0.43, type: 'highpass', ...world,
    });
  }

  _playDrummerStep(step, position) {
    const at = step % 16;
    const bar = Math.floor(step / 16) % 2;
    if (at % 2 === 0) this._drumHat(position, at === 14);
    if ([0, 3, 7, 8, 10, 11].includes(at)) this._drumKick(position, at === 0 ? 0.39 : 0.3);
    if (at === 4 || at === 12) this._drumSnare(position, at === 12 ? 0.25 : 0.22);
    if (bar === 1 && at === 13) this._drumTom(position, true, 0.18);
    if (bar === 1 && at === 14) this._drumTom(position, false, 0.2);
    if (bar === 1 && at === 15) this._drumTom(position, false, 0.24);
    if (at === 0 && bar === 0) this._drumCrash(position);
  }

  /**
   * Advance the continuous spatial drum performance at a fixed sixteenth-note
   * grid. The caller supplies frame time; limiting catch-up prevents a hidden
   * tab from firing a whole missed bar at once when it wakes.
   */
  updateDrummer(position, dt, active = true) {
    if (!this.ctx || !position) return false;
    if (!active) {
      this.stopDrummer();
      return false;
    }
    if (!this.drummerActive) {
      this.drummerActive = true;
      this.drummerTime = 0;
      this.drummerStep = -1;
    }

    this.drummerTime += Math.max(0, Math.min(0.2, Number(dt) || 0));
    const secondsPerStep = 60 / DRUMMER_BPM / 4;
    const wanted = Math.floor(this.drummerTime / secondsPerStep);
    let emitted = 0;
    while (this.drummerStep < wanted && emitted < 3) {
      this.drummerStep++;
      this._playDrummerStep(this.drummerStep, position);
      emitted++;
    }
    if (this.drummerStep < wanted) this.drummerStep = wanted;
    return true;
  }

  stopDrummer() {
    this.drummerActive = false;
    this.drummerTime = 0;
    this.drummerStep = -1;
  }

  shoot(profile) {
    if (!this.ctx) return;
    if (profile === 'flamethrower') {
      // WeaponSystem owns release detection. Individual fuel ticks merely keep
      // the already-running combustion graph open; they never spawn a new roar.
      this.setFlamethrower(true);
      return;
    }
    if (profile === 'swing' || profile === 'stab' || profile === 'golf') {
      // Air movement is intentionally still generated: it follows the exact
      // animation edge and has no conspicuous impulse recording to repeat.
      const heavy = profile === 'golf';
      this._noise({
        dur: heavy ? 0.28 : 0.16,
        gain: heavy ? 0.26 : 0.17,
        freq: heavy ? 520 : 1150,
        endFreq: heavy ? 1800 : 3100,
        q: 0.62,
        type: 'bandpass',
      });
      return;
    }
    if (this._playRecorded(profile)) return;
    if (profile === 'bazooka') {
      // Whoosh of the rocket leaving the tube, over a low thump.
      this._noise({ dur: 0.7, gain: 0.7, freq: 900, endFreq: 2600, q: 0.6, type: 'bandpass' });
      this._tone({ freq: 110, endFreq: 38, dur: 0.4, gain: 0.4, type: 'sine' });
      return;
    }
    if (profile === 'sniper') {
      // Sharp crack with a long tail, so it reads as a high-power rifle.
      this._noise({ dur: 0.55, gain: 0.9, freq: 6000, endFreq: 160, q: 0.9 });
      this._tone({ freq: 200, endFreq: 48, dur: 0.35, gain: 0.3, type: 'sawtooth' });
      return;
    }
    if (profile === 'shotgun') {
      this._noise({ dur: 0.42, gain: 0.85, freq: 2600, endFreq: 90, q: 0.7 });
      this._tone({ freq: 150, endFreq: 40, dur: 0.28, gain: 0.35, type: 'sine' });
    } else if (profile === 'pistol') {
      this._noise({ dur: 0.16, gain: 0.5, freq: 3600, endFreq: 500, q: 1.2 });
      this._tone({ freq: 320, endFreq: 90, dur: 0.09, gain: 0.16, type: 'square' });
    } else {
      this._noise({ dur: 0.2, gain: 0.62, freq: 4200, endFreq: 320, q: 1.1 });
      this._tone({ freq: 240, endFreq: 70, dur: 0.12, gain: 0.2, type: 'sawtooth' });
    }
  }

  dryFire() { this._tone({ freq: 900, endFreq: 500, dur: 0.04, gain: 0.12, type: 'square' }); }
  reloadOut() { this._tone({ freq: 260, endFreq: 160, dur: 0.08, gain: 0.16, type: 'square' }); }
  reloadIn() { this._tone({ freq: 420, endFreq: 620, dur: 0.09, gain: 0.18, type: 'square' }); }
  switchWeapon() { this._tone({ freq: 620, endFreq: 900, dur: 0.06, gain: 0.14, type: 'square' }); }

  hit(position = null) {
    const world = { delay: 0.032, position,
      spatial: { refDistance: 1.5, maxDistance: 55 } };
    if (this._playRecorded('hit', 0.19, 1.05, world)) return;
    this._tone({
      freq: 1500, endFreq: 1100, dur: 0.05, gain: 0.19, type: 'sine', ...world,
    });
  }
  headshot(position = null) {
    const world = { delay: 0.028, position,
      spatial: { refDistance: 1.5, maxDistance: 60 } };
    if (this._playRecorded('hit', 0.25, 0.94, world)) return;
    this._tone({
      freq: 2100, endFreq: 1500, dur: 0.07, gain: 0.23, type: 'sine', ...world,
    });
  }
  kill(position = null) {
    const world = { delay: 0.025, position,
      spatial: { refDistance: 1.5, maxDistance: 60 } };
    if (this._playRecorded('hit', 0.29, 0.86, world)) return;
    this._tone({
      freq: 880, endFreq: 1320, dur: 0.12, gain: 0.18, type: 'triangle', ...world,
    });
    this._noise({ dur: 0.25, gain: 0.24, freq: 1400, endFreq: 120, ...world });
  }

  impact(position = null) {
    const world = { delay: 0.018, position,
      spatial: { refDistance: 1.5, maxDistance: 50 } };
    if (this._playRecorded('impact', 0.2, 1, world)) return;
    this._noise({ dur: 0.09, gain: 0.2, freq: 1800, endFreq: 300, ...world });
  }

  explosion(position = null) {
    const world = { position, spatial: { refDistance: 6, maxDistance: 150 } };
    this._noise({ dur: 1.1, gain: 1.0, freq: 1800, endFreq: 55, q: 0.5, ...world });
    this._tone({
      freq: 90, endFreq: 28, dur: 0.8, gain: 0.5, type: 'sine', ...world,
    });
    this._tone({
      freq: 220, endFreq: 45, dur: 0.35, gain: 0.3, type: 'sawtooth', ...world,
    });
  }

  vendingRattle(position = null) {
    const world = { position, spatial: { refDistance: 4, maxDistance: 70 } };
    if (this._playRecorded('vendingRattle', 0.28, 0.92, world)) return;
    this._noise({ dur: 0.1, gain: 0.19, freq: 3200, endFreq: 420, q: 1.1, ...world });
  }

  vendingExplosion(position = null) {
    const world = { position, spatial: { refDistance: 8, maxDistance: 180 } };
    if (this._playRecorded('vendingExplosion', 0.95, 1, world)) return;
    this.explosion(position);
  }

  streakUp() {
    this._tone({ freq: 700, endFreq: 1050, dur: 0.1, gain: 0.2, type: 'triangle' });
    setTimeout(() => this._tone({ freq: 1050, endFreq: 1580, dur: 0.14, gain: 0.18, type: 'triangle' }), 80);
  }

  enemyShot(_hit = false, position = null) {
    const world = { position, spatial: { refDistance: 3, maxDistance: 100 } };
    if (this._playRecorded('pistol', 0.22, 0.96, world)) return;
    this._noise({
      dur: 0.13, gain: 0.32, freq: 3000, endFreq: 400, q: 1.1, ...world,
    });
    this._tone({
      freq: 280, endFreq: 80, dur: 0.08, gain: 0.1, type: 'square', ...world,
    });
  }

  designator() {
    // Three rising blips, like a radio confirmation.
    this._tone({ freq: 880, endFreq: 880, dur: 0.07, gain: 0.18, type: 'square' });
    setTimeout(() => this._tone({ freq: 1180, endFreq: 1180, dur: 0.07, gain: 0.18, type: 'square' }), 110);
    setTimeout(() => this._tone({ freq: 1560, endFreq: 1560, dur: 0.14, gain: 0.2, type: 'square' }), 220);
  }

  stone() {
    this._tone({ freq: 520, endFreq: 1040, dur: 0.22, gain: 0.22, type: 'sine' });
    setTimeout(() => this._tone({ freq: 1560, endFreq: 2080, dur: 0.28, gain: 0.14, type: 'sine' }), 90);
  }

  snap() {
    // Sharp crack, then a long swelling hum.
    this._noise({ dur: 0.12, gain: 0.9, freq: 7000, endFreq: 900, q: 1.4 });
    this._tone({ freq: 70, endFreq: 240, dur: 1.6, gain: 0.4, type: 'sine' });
    this._tone({ freq: 210, endFreq: 700, dur: 1.4, gain: 0.22, type: 'triangle' });
    setTimeout(() => this._noise({ dur: 1.4, gain: 0.4, freq: 400, endFreq: 3000, q: 0.5, type: 'bandpass' }), 120);
  }

  pickup() {
    this._tone({ freq: 660, endFreq: 990, dur: 0.12, gain: 0.24, type: 'triangle' });
    setTimeout(() => this._tone({ freq: 990, endFreq: 1320, dur: 0.18, gain: 0.22, type: 'triangle' }), 90);
  }

  /** Elastic fruit-cannon chirp: deliberately unlike any firearm report. */
  bananaFire() {
    this._tone({ freq: 920, endFreq: 310, dur: 0.13, gain: 0.16, type: 'triangle' });
    this._tone({ freq: 360, endFreq: 760, dur: 0.09, gain: 0.07, type: 'sine' });
  }

  snailHit() {
    this._tone({ freq: 190, endFreq: 92, dur: 0.22, gain: 0.16, type: 'square' });
  }

  snailCaught() {
    this._tone({ freq: 108, endFreq: 31, dur: 0.9, gain: 0.28, type: 'sawtooth' });
  }

  /** Creaking hinge over the thud of a heavy lid. */
  chestOpen(position = null) {
    const world = { position, spatial: { refDistance: 2, maxDistance: 28 } };
    this._noise({
      dur: 0.45, gain: 0.3, freq: 380, endFreq: 1600, q: 3.5,
      type: 'bandpass', ...world,
    });
    this._tone({
      freq: 130, endFreq: 70, dur: 0.22, gain: 0.28, type: 'sine', ...world,
    });
    setTimeout(() => {
      this._tone({
        freq: 880, endFreq: 1320, dur: 0.22, gain: 0.2, type: 'triangle', ...world,
      });
      this._tone({
        freq: 1320, endFreq: 1760, dur: 0.3, gain: 0.12, type: 'sine', ...world,
      });
    }, 240);
  }

  /** Servo whirr, tray clack, then six quick crunchy bites. */
  nuggets() {
    this._tone({ freq: 170, endFreq: 310, dur: 0.32, gain: 0.15, type: 'sawtooth' });
    this._noise({ dur: 0.38, gain: 0.12, freq: 700, endFreq: 1800, q: 2.2, type: 'bandpass' });
    setTimeout(() => this._tone({
      freq: 110, endFreq: 64, dur: 0.13, gain: 0.2, type: 'square',
    }), 360);
    for (let i = 0; i < 6; i++) {
      setTimeout(() => {
        this._noise({
          dur: 0.055, gain: 0.1, freq: 3200 + i * 130, endFreq: 850,
          q: 0.8, type: 'bandpass',
        });
      }, 720 + i * 105);
    }
    setTimeout(() => this._tone({
      freq: 660, endFreq: 990, dur: 0.18, gain: 0.14, type: 'triangle',
    }), 1320);
  }

  /** Refrigeration spool-up, fluid pulse and the pod's locking relay. */
  dinosaurFactoryStart(position = null) {
    const world = { position, spatial: { refDistance: 3, maxDistance: 45 } };
    this._tone({
      freq: 52, endFreq: 148, dur: 1.15, gain: 0.24, type: 'sawtooth', ...world,
    });
    this._noise({
      dur: 1.35, gain: 0.12, freq: 260, endFreq: 2200,
      q: 3.2, type: 'bandpass', ...world,
    });
    for (let i = 0; i < 4; i++) {
      setTimeout(() => this._tone({
        freq: 180 + i * 45, endFreq: 92 + i * 22,
        dur: 0.12, gain: 0.12, type: 'sine', ...world,
      }), 260 + i * 230);
    }
    setTimeout(() => this._tone({
      freq: 950, endFreq: 1420, dur: 0.2, gain: 0.14, type: 'triangle', ...world,
    }), 1200);
  }

  /** A layered animal call: chest rumble, rasp and throat harmonic. */
  dinosaurRoar(position = null) {
    const world = { position, spatial: { refDistance: 3, maxDistance: 60 } };
    this._tone({
      freq: 74, endFreq: 43, dur: 0.82, gain: 0.35, type: 'sawtooth', ...world,
    });
    this._tone({
      freq: 148, endFreq: 91, dur: 0.64, gain: 0.2, type: 'square', ...world,
    });
    this._noise({
      dur: 0.78, gain: 0.25, freq: 1500, endFreq: 240,
      q: 1.7, type: 'bandpass', ...world,
    });
  }

  /** Jaw snap plus a short organic crunch at the animation's impact frame. */
  dinosaurBite(position = null) {
    const world = { position, spatial: { refDistance: 1.5, maxDistance: 32 } };
    this._tone({
      freq: 132, endFreq: 48, dur: 0.11, gain: 0.23, type: 'square', ...world,
    });
    this._noise({
      dur: 0.16, gain: 0.2, freq: 2600, endFreq: 340,
      q: 0.75, type: 'bandpass', ...world,
    });
  }

  /** Glug, then the perk settling in. */
  drink() {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => this._tone({
        freq: 300 + i * 40, endFreq: 180 + i * 30, dur: 0.07, gain: 0.16, type: 'sine',
      }), i * 90);
    }
    setTimeout(() => {
      this._tone({ freq: 520, endFreq: 1560, dur: 0.4, gain: 0.18, type: 'triangle' });
    }, 280);
  }

  /** Downward sigh, so a perk running out is audible without reading the HUD. */
  potionEnd() {
    this._tone({ freq: 780, endFreq: 300, dur: 0.35, gain: 0.14, type: 'triangle' });
  }

  /** Decode the small voice clip early so the first button press is immediate. */
  _loadButtonMoan() {
    if (!this.ctx) return Promise.resolve(null);
    if (this.buttonMoanBuffer) return Promise.resolve(this.buttonMoanBuffer);
    if (this.buttonMoanLoading) return this.buttonMoanLoading;

    const url = new URL(`../../${BUTTON_MOAN_TRACK}`, import.meta.url).href;
    this.buttonMoanLoading = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`voice asset returned ${response.status}`);
        return response.arrayBuffer();
      })
      .then((bytes) => this.ctx.decodeAudioData(bytes))
      .then((buffer) => {
        this.buttonMoanBuffer = buffer;
        return buffer;
      })
      .catch((error) => {
        console.warn('Red-button voice unavailable; continuing without it', error);
        return null;
      });
    return this.buttonMoanLoading;
  }

  _playButtonMoan(buffer) {
    if (!buffer || !this.ctx || !this.master) return false;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const variants = [0.97, 1, 1.035];
    this._buttonMoanVariant = ((this._buttonMoanVariant ?? -1) + 1) % variants.length;
    source.playbackRate.value = variants[this._buttonMoanVariant];

    const level = this.ctx.createGain();
    level.gain.value = 1.35;
    source.connect(level).connect(this.master);
    source.start();
    return true;
  }

  /** Play the recorded human moan, or queue it while its first decode finishes. */
  buttonMoan() {
    if (!this.ctx || !this.master) return false;
    if (this.buttonMoanBuffer) return this._playButtonMoan(this.buttonMoanBuffer);
    this._loadButtonMoan().then((buffer) => this._playButtonMoan(buffer));
    return true;
  }


  /** Paper unrolling, then the ping of a marked location. */
  mapOpen() {
    this._noise({ dur: 0.3, gain: 0.22, freq: 2400, endFreq: 900, q: 0.8, type: 'bandpass' });
    setTimeout(() => {
      this._tone({ freq: 1180, endFreq: 1180, dur: 0.1, gain: 0.2, type: 'sine' });
      setTimeout(() => this._tone({ freq: 1760, endFreq: 1760, dur: 0.22, gain: 0.18, type: 'sine' }), 120);
    }, 180);
  }

  playerHurt() {
    this._noise({ dur: 0.3, gain: 0.45, freq: 700, endFreq: 80 });
    this._tone({ freq: 180, endFreq: 60, dur: 0.25, gain: 0.22, type: 'sawtooth' });
  }
  playerDie() { this._tone({ freq: 300, endFreq: 45, dur: 1.2, gain: 0.35, type: 'sawtooth' }); }
  jump() { this._tone({ freq: 420, endFreq: 560, dur: 0.05, gain: 0.06, type: 'sine' }); }
  land() { this._noise({ dur: 0.1, gain: 0.16, freq: 500, endFreq: 90 }); }
  step() { this._noise({ dur: 0.06, gain: 0.09, freq: 900, endFreq: 200 }); }
  /**
   * A board coming off a window.
   *
   * A crack and a low thump together: the crack is the nails letting go and is
   * what carries across a room, the thump is what tells you it happened behind
   * you. A barrier is meant to be a countdown you can hear without looking at
   * it, so this has to read at the edge of the mix rather than in the middle.
   */
  boardBreak(position = null) {
    const world = { position, spatial: { refDistance: 2, maxDistance: 42 } };
    this._noise({ dur: 0.14, gain: 0.34, freq: 2600, endFreq: 320, ...world });
    this._tone({
      freq: 190, endFreq: 70, dur: 0.22, gain: 0.2, type: 'square', ...world,
    });
  }
  waveStart() {
    this._tone({ freq: 440, endFreq: 660, dur: 0.5, gain: 0.2, type: 'triangle' });
    setTimeout(() => this._tone({ freq: 660, endFreq: 880, dur: 0.6, gain: 0.2, type: 'triangle' }), 180);
  }
}
