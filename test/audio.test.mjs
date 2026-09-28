import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  AQUARIUM_MUSIC_GAIN, AQUARIUM_MUSIC_TRACK, AudioSystem, BUTTON_MOAN_TRACK,
  FLAMETHROWER_TRACK, MUSIC_TRACK, MUSIC_TRACKS, RECORDED_SOUNDS,
} from '../src/engine/audio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class FakeParam {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); }
  exponentialRampToValueAtTime(value, time) { this.value = value; this.events.push(['ramp', value, time]); }
  setTargetAtTime(value, time, constant) { this.value = value; this.events.push(['target', value, time, constant]); }
}

class FakeNode {
  constructor(kind) {
    this.kind = kind; this.connections = []; this.starts = []; this.stops = [];
    this.gain = new FakeParam(); this.frequency = new FakeParam(); this.Q = new FakeParam();
    this.playbackRate = new FakeParam(1);
    this.positionX = new FakeParam(); this.positionY = new FakeParam(); this.positionZ = new FakeParam();
  }
  connect(node) { this.connections.push(node); return node; }
  start(time) { this.starts.push(time); }
  stop(time) { this.stops.push(time); }
}

function audioHarness() {
  const nodes = [];
  const make = (kind) => { const node = new FakeNode(kind); nodes.push(node); return node; };
  const audio = new AudioSystem();
  const listener = {
    positionX: new FakeParam(), positionY: new FakeParam(), positionZ: new FakeParam(),
    forwardX: new FakeParam(), forwardY: new FakeParam(), forwardZ: new FakeParam(),
    upX: new FakeParam(), upY: new FakeParam(), upZ: new FakeParam(),
  };
  audio.ctx = {
    currentTime: 12,
    listener,
    createGain: () => make('gain'),
    createOscillator: () => make('oscillator'),
    createBiquadFilter: () => make('filter'),
    createBufferSource: () => make('buffer'),
    createPanner: () => make('panner'),
  };
  audio.master = make('master');
  audio.noiseBuffer = {};
  return { audio, nodes };
}

test('the background score rotates a bundled CC0 playlist without permanent synth noise', async () => {
  assert.equal(MUSIC_TRACK, MUSIC_TRACKS[0], 'legacy track export should name the playlist opener');
  assert.equal(AQUARIUM_MUSIC_TRACK, 'assets/audio/lost_in_a_bad_place.ogg');
  for (const track of MUSIC_TRACKS) {
    const musicPath = path.join(ROOT, track);
    assert.ok(statSync(musicPath).size > 400_000, `${track} is missing or truncated`);
    assert.equal(readFileSync(musicPath, { encoding: null }).subarray(0, 4).toString(), 'OggS');
  }

  const { audio, nodes } = audioHarness();
  const decoded = MUSIC_TRACKS.map((track) => ({ track, duration: 134.7 }));
  let decodeIndex = 0;
  audio.ctx.decodeAudioData = async () => decoded[decodeIndex++];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: MUSIC_TRACKS.includes(url),
    status: MUSIC_TRACKS.includes(url) ? 200 : 404,
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  try {
    audio._initMusic();
    await audio.musicLoading;
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(nodes.filter((node) => node.kind === 'oscillator').length, 0,
    'the removed background drone was recreated');
  const source = nodes.find((node) => node.kind === 'buffer');
  assert.equal(source.buffer, decoded[0]);
  assert.equal(source.loop, false);
  assert.equal(source.starts.length, 1);

  source.onended();
  const sources = nodes.filter((node) => node.kind === 'buffer');
  assert.equal(sources[1].buffer, decoded[1], 'playlist did not advance after the first composition');
  assert.equal(sources[1].starts.length, 1);
});

test('entering the human enclosure cross-fades to its filtered horror loop', () => {
  const { audio, nodes } = audioHarness();
  audio.musicGain = audio.ctx.createGain();
  audio.musicGain.connect(audio.master);
  audio.intensity = 0;
  audio.aquariumBuffer = { track: AQUARIUM_MUSIC_TRACK, duration: 134.7 };

  assert.equal(audio.setAquariumAmbience(true), true);
  assert.equal(audio.aquariumActive, true);
  const source = nodes.find((node) => node.kind === 'buffer' && node.loop);
  assert.ok(source, 'enclosure did not start a looping music source');
  assert.equal(source.buffer, audio.aquariumBuffer);
  assert.equal(source.playbackRate.value, 0.94);
  assert.equal(source.starts.length, 1);
  assert.equal(audio.aquariumMusic.filter.type, 'lowpass');
  assert.equal(audio.aquariumMusic.filter.frequency.value, 1250);
  assert.equal(AQUARIUM_MUSIC_GAIN, 0.12);
  assert.equal(audio.aquariumMusic.gain.gain.value, AQUARIUM_MUSIC_GAIN);

  audio.setIntensity(0.8, 0.016);
  assert.equal(audio.musicGain.gain.value, 0.006,
    'normal combat score was not ducked under the enclosure music');
  assert.equal(audio.setAquariumAmbience(false), true);
  assert.equal(audio.aquariumMusic.gain.gain.value, 0,
    'enclosure music did not fade after leaving the room');
  audio.setIntensity(0.8, 0.016);
  assert.ok(audio.musicGain.gain.value > 0.065,
    'normal score did not return after leaving the enclosure');
});

test('the rooftop drum performance replaces the score only while active', () => {
  const { audio } = audioHarness();
  audio.musicGain = audio.ctx.createGain();
  audio.musicGain.connect(audio.master);
  audio.intensity = 0;
  const position = { x: 20, y: 25, z: 20 };

  assert.equal(audio.updateDrummer(position, 0.15, true), true);
  audio.setIntensity(0.6, 0.016);
  assert.equal(audio.musicGain.gain.value, 0.01,
    'normal game music was not ducked under the rooftop performance');

  assert.equal(audio.updateDrummer(position, 0.15, false), false);
  audio.setIntensity(0.6, 0.016);
  assert.ok(audio.musicGain.gain.value > 0.065,
    'normal game music did not return after leaving the rooftop');
});

test('missing background music fails to silence without an unhandled rejection', async () => {
  const { audio, nodes } = audioHarness();
  audio.ctx.decodeAudioData = async () => { throw new Error('should not decode a 404'); };
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings = [];
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    audio._initMusic();
    await audio.musicLoading;
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }

  assert.equal(audio.musicSource, null);
  assert.equal(nodes.filter((node) => node.kind === 'buffer').length, 0);
  assert.equal(nodes.filter((node) => node.kind === 'oscillator').length, 0);
  assert.ok(warnings.some((message) => message.includes('continuing without music')));
});

test('gunshot and hit profiles are backed by bundled CC0 recordings', async () => {
  for (const [profile, tracks] of Object.entries(RECORDED_SOUNDS)) {
    assert.ok(tracks.length, `${profile} has no authored takes`);
    for (const track of tracks) {
      const bytes = readFileSync(path.join(ROOT, track), { encoding: null });
      assert.ok(bytes.length > 7_000, `${track} is missing or truncated`);
      const header = bytes.subarray(0, 4).toString();
      assert.ok(
        header.startsWith('ID3') || header === 'OggS' || header === 'RIFF',
        `${track} is not browser audio`,
      );
    }
  }

  const { audio } = audioHarness();
  audio.ctx.decodeAudioData = async () => ({ duration: 0.8 });
  const expected = new Set(Object.values(RECORDED_SOUNDS).flat());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: expected.has(url),
    status: expected.has(url) ? 200 : 404,
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  try {
    await audio._loadRecordedSounds();
  } finally {
    globalThis.fetch = originalFetch;
  }
  for (const [profile, tracks] of Object.entries(RECORDED_SOUNDS)) {
    assert.equal(audio.recordedBuffers.get(profile)?.length, tracks.length);
  }
});

test('real takes replace synthesized gun, flesh-hit and material-impact effects', () => {
  const { audio, nodes } = audioHarness();
  const rifle = { take: 'rifle' };
  const flesh = { take: 'flesh' };
  const material = { take: 'material' };
  audio.recordedBuffers.set('rifle', [rifle]);
  audio.recordedBuffers.set('hit', [flesh]);
  audio.recordedBuffers.set('impact', [material]);

  audio.shoot('rifle');
  audio.hit();
  audio.impact();

  const played = nodes.filter((node) => node.kind === 'buffer').map((node) => node.buffer);
  assert.deepEqual(played, [rifle, flesh, material]);
  assert.equal(nodes.filter((node) => node.kind === 'oscillator').length, 0,
    'a synth tone was layered back over the real recordings');
  assert.equal(nodes.filter((node) => node.kind === 'filter').length, 0,
    'a generated noise burst was layered back over the real recordings');
});

test('the vending event uses recorded metal and explosion sounds without synth layers', () => {
  const { audio, nodes } = audioHarness();
  const rattle = { take: 'metal rattle' };
  const blast = { take: 'mechanical blast' };
  audio.recordedBuffers.set('vendingRattle', [rattle]);
  audio.recordedBuffers.set('vendingExplosion', [blast]);

  audio.vendingRattle({ x: 1, y: 2, z: 3 });
  audio.vendingExplosion({ x: 1, y: 2, z: 3 });

  const played = nodes.filter((node) => node.kind === 'buffer').map((node) => node.buffer);
  assert.deepEqual(played, [rattle, blast]);
  assert.equal(nodes.filter((node) => node.kind === 'oscillator').length, 0);
  assert.equal(nodes.filter((node) => node.kind === 'filter').length, 0);
});

test('world sounds use the player listener and a distance-limited HRTF panner', () => {
  const { audio, nodes } = audioHarness();
  audio.recordedBuffers.set('pistol', [{ take: 'enemy pistol' }]);
  const lookZ = -Math.sqrt(0.74);
  assert.equal(audio.setListener(
    { x: 4, y: 1.7, z: -9 }, { x: 0.5, y: -0.1, z: lookZ }), true);
  audio.enemyShot(false, { x: 24, y: 1.3, z: -3 });

  assert.equal(audio.ctx.listener.positionX.value, 4);
  assert.equal(audio.ctx.listener.positionY.value, 1.7);
  assert.equal(audio.ctx.listener.positionZ.value, -9);
  assert.ok(Math.abs(audio.ctx.listener.forwardX.value - 0.5) < 1e-12);
  const orientationDot = audio.ctx.listener.forwardX.value * audio.ctx.listener.upX.value
    + audio.ctx.listener.forwardY.value * audio.ctx.listener.upY.value
    + audio.ctx.listener.forwardZ.value * audio.ctx.listener.upZ.value;
  assert.ok(Math.abs(orientationDot) < 1e-12,
    'listener up is not orthogonal to the player look direction');
  const panner = nodes.find((node) => node.kind === 'panner');
  assert.ok(panner, 'enemy shot did not enter a spatial audio stage');
  assert.equal(panner.panningModel, 'HRTF');
  assert.equal(panner.distanceModel, 'linear');
  assert.equal(panner.maxDistance, 100);
  assert.equal(panner.positionX.value, 24);
  assert.equal(panner.positionY.value, 1.3);
  assert.equal(panner.positionZ.value, -3);
  assert.equal(panner.connections[0], audio.master);
});

test('a zombie hit preserves the louder gun report and adds splatter just after it', () => {
  const { audio, nodes } = audioHarness();
  audio.recordedBuffers.set('rifle', [{ take: 'rifle' }]);
  audio.recordedBuffers.set('hit', [{ take: 'flesh' }]);

  audio.shoot('rifle');
  audio.hit({ x: 18, y: 1.2, z: -5 });

  const [gun, splatter] = nodes.filter((node) => node.kind === 'buffer');
  assert.equal(gun.starts[0], audio.t, 'gunshot was not started at trigger time');
  assert.ok(splatter.starts[0] > gun.starts[0],
    'splatter masks the gunshot because both transients start together');
  assert.ok(gun.connections[0].gain.value > splatter.connections[0].gain.value,
    'splatter is mixed louder than the firearm report');
  assert.equal(gun.connections[0].connections[0], audio.master,
    'the player weapon should stay present and centered');
  assert.equal(splatter.connections[0].connections[0].kind, 'panner',
    'the struck zombie should be the audible source of the splatter');
});

test('co-op unlocks Web Audio from the join click before its first await', () => {
  const source = readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const method = source.match(/async startCoop\([\s\S]*?\n  }\n\n  \/\*\*/)?.[0];
  assert.ok(method, 'could not inspect startCoop');
  const initAt = method.indexOf('this.audio.init()');
  const awaitAt = method.indexOf('await ');
  assert.ok(initAt >= 0 && initAt < awaitAt,
    'co-op waits before creating audio, so browser user activation expires');
});

test('Clippy contributes mini-boss pressure to the adaptive score', () => {
  const source = readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const intensity = source.match(/  _intensity\(\) \{[\s\S]*?\n  \}\n/)?.[0];
  assert.ok(intensity, 'could not inspect adaptive intensity');
  assert.match(intensity, /e\.type\.boss \|\| e\.type\.miniboss/);
});

test('a browser that blocks AudioContext still starts the game without sound', () => {
  const originalWindow = globalThis.window;
  const originalWarn = console.warn;
  const warnings = [];
  globalThis.window = {
    AudioContext: class BlockedAudioContext {
      constructor() { throw new DOMException('The operation is insecure', 'SecurityError'); }
    },
  };
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const audio = new AudioSystem();
    assert.doesNotThrow(() => audio.init());
    assert.equal(audio.enabled, false);
    assert.equal(audio.ctx, null);
    assert.equal(audio.init(), false, 'a blocked context should not be retried every click');
    assert.ok(warnings.some((message) => message.includes('continuing without sound')));
  } finally {
    console.warn = originalWarn;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('the red-button moan is a bundled CC0 human recording', () => {
  const voicePath = path.join(ROOT, BUTTON_MOAN_TRACK);
  assert.ok(statSync(voicePath).size > 10_000, 'button voice is missing or truncated');
  assert.equal(readFileSync(voicePath, { encoding: null }).subarray(0, 3).toString(), 'ID3');
});

test('the red-button moan is safe before browser audio has started', () => {
  assert.equal(new AudioSystem().buttonMoan(), false);
});

test('the red-button moan plays the decoded human recording through the game mix', () => {
  const { audio, nodes } = audioHarness();
  const recording = { duration: 1.25 };
  audio.buttonMoanBuffer = recording;
  assert.equal(audio.buttonMoan(), true);

  const source = nodes.find((node) => node.kind === 'buffer');
  assert.equal(source.buffer, recording);
  assert.equal(source.starts.length, 1);
  assert.ok(source.connections[0].gain.value > 1, 'recording should sit clearly above the music');
});

test('successive red-button moans rotate subtle playback variants', () => {
  const { audio, nodes } = audioHarness();
  audio.buttonMoanBuffer = { duration: 1.25 };
  audio.buttonMoan();
  const first = nodes.find((node) => node.kind === 'buffer').playbackRate.value;
  audio.buttonMoan();
  const voices = nodes.filter((node) => node.kind === 'buffer');
  assert.notEqual(voices[1].playbackRate.value, first);
});

test('rocket engine creates one continuous motor and follows thrust', () => {
  const { audio, nodes } = audioHarness();
  assert.equal(audio.setShipEngine(0.8), true);
  assert.equal(nodes.filter((node) => node.kind === 'oscillator').length, 2);
  const source = nodes.find((node) => node.kind === 'buffer');
  assert.equal(source.loop, true, 'combustion noise should loop without audible seams');
  assert.ok(audio.shipEngine.gain.gain.value > 0.1, 'launch thrust should be clearly audible');

  const nodeCount = nodes.length;
  audio.setShipEngine(0.3);
  assert.equal(nodes.length, nodeCount, 'throttle changes must reuse the live engine graph');
  audio.stopShipEngine();
  assert.equal(audio.shipEngine.gain.gain.value, 0);
});

test('flamethrower uses one sustained layered burner and fades on release', () => {
  const { audio, nodes } = audioHarness();
  assert.equal(audio.setFlamethrower(true), true);

  const loops = nodes.filter((node) => node.kind === 'buffer' && node.loop);
  assert.equal(loops.length, 2, 'burner needs separate continuous roar and fuel-hiss layers');
  assert.notEqual(loops[0].playbackRate.value, loops[1].playbackRate.value,
    'loop layers should not phase-lock into one repeated noise texture');
  const rumble = nodes.find((node) => node.kind === 'oscillator' && node.stops.length === 0);
  assert.ok(rumble, 'burner has no continuous low combustion layer');
  assert.ok(audio.flamethrower.output.gain.value > 0.2,
    'the held burner should remain clearly audible above the score');

  const nodeCount = nodes.length;
  audio.shoot('flamethrower');
  audio.setFlamethrower(true);
  assert.equal(nodes.length, nodeCount,
    'fuel ticks must reuse the live graph instead of layering short noise bursts');

  assert.equal(audio.stopFlamethrower(), true);
  assert.equal(audio.flamethrower.output.gain.value, 0);
  assert.equal(audio.flamethrower.active, false);
});

test('flamethrower layers a bundled CC0 recording over its synth fallback', async () => {
  const recordingPath = path.join(ROOT, FLAMETHROWER_TRACK);
  assert.ok(statSync(recordingPath).size > 400_000, 'recorded burner is missing or truncated');
  const header = readFileSync(recordingPath, { encoding: null }).subarray(0, 2);
  assert.equal(header[0], 0xff);
  assert.equal(header[1] & 0xe0, 0xe0, 'recorded burner has no MPEG audio sync word');

  const { audio, nodes } = audioHarness();
  const decoded = { duration: 13.479 };
  audio.ctx.decodeAudioData = async () => decoded;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: url === FLAMETHROWER_TRACK,
    status: url === FLAMETHROWER_TRACK ? 200 : 404,
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  try {
    audio._loadFlamethrower();
    await audio.flamethrowerLoading;
  } finally {
    globalThis.fetch = originalFetch;
  }

  audio.setFlamethrower(true);
  const recorded = nodes.find((node) => node.kind === 'buffer' && node.buffer === decoded);
  assert.ok(recorded, 'decoded real burner was not connected');
  assert.equal(recorded.loop, true);
  assert.ok(recorded.loopStart > 1 && recorded.loopEnd < decoded.duration - 2,
    'loop should preserve the authored ignition and skip the shutdown tail');
  audio.stopFlamethrower();
  assert.ok(recorded.stops[0] > audio.t, 'recorded burner should fade instead of cutting off');
});
