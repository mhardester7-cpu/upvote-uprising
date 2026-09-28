// Pure animation selection and posing shared by the render integrations.
// Keeping this file free of Three.js/loaders makes the behaviour deterministic
// and directly testable in the authoritative Node build too.

/** Clip name patterns per state, best match first. */
const CLIPS = {
  idle:   [/idle/i, /stand/i, /breath/i],
  walk:   [/walk/i, /shamble/i, /stagger/i, /move/i, /locomotion/i],
  // Do not use bare /run/: it also matches "Grunt Idle" (g-RUN-t), silently
  // classifying an idle as locomotion. The broader forms below still cover
  // ZombieRunning, Zombie_Run and namespaced FBX stack names.
  run:    [/running/i, /(?:^|[\s_|.:-])run(?:$|[\s_|.:-])/i,
           /jog/i, /sprint/i, /charge/i, /dash/i],
  vault:  [/vault/i, /climb/i, /mantle/i, /jump/i, /leap/i],
  attack: [/attack/i, /punch/i, /swipe/i, /hit(?!.*react)/i, /bite/i, /shoot|fire|aim/i],
  death:  [/death|dying|die|dead/i, /fall/i, /collapse/i],
};

/** Assumed authored ground speed for the installed in-place locomotion clips. */
export const CHARACTER_CLIP_SPEED = Object.freeze({ walk: 0.9, run: 2.6, vault: 2.6 });

/** Above this speed a run cycle is more believable than a stretched shamble. */
export const RUN_ABOVE = 1.9;

/** Select locomotion from measured world motion, including a true standing idle. */
export function locomotionState(speed) {
  const pace = Math.max(0, Number(speed) || 0);
  if (pace <= 0.06) return 'idle';
  return pace >= RUN_ABOVE ? 'run' : 'walk';
}

/**
 * Match an in-place clip to the distance the simulation moves the body.
 * Dedicated run/walk selection handles the large difference; this narrow rate
 * band only removes the remaining foot slide without turning mocap into a blur.
 */
export function locomotionPlaybackRate(state, speed, authoredSpeed = 0,
                                        fallbackSpeed = CHARACTER_CLIP_SPEED.walk) {
  const pace = Math.max(0, Number(speed) || 0);
  if (pace <= 0.06) return 0;
  const authored = authoredSpeed > 0
    ? authoredSpeed
    : CHARACTER_CLIP_SPEED[state] || fallbackSpeed;
  return Math.max(0.65, Math.min(1.7, pace / Math.max(0.01, authored)));
}

/**
 * Turn an author's clip names into the small state set the game speaks.
 *
 * Locomotion is deliberately fail-soft. A fast zombie must never fall back to
 * idle merely because an otherwise good pack calls its only moving clip
 * "Shamble", "Jog" or simply "Locomotion". When there is only one usable
 * locomotion clip it serves walk, run and window-vault states; playback speed
 * still distinguishes a shamble from a charge. A dedicated run/vault wins
 * whenever the pack supplies one.
 */
export function classifyCharacterClips(clips = []) {
  const actions = {};
  for (const [state, patterns] of Object.entries(CLIPS)) {
    const clip = patterns.reduce((found, re) =>
      found || clips.find((candidate) => re.test(candidate.name || '')), null);
    if (clip) actions[state] = clip;
  }

  const locomotion = actions.run || actions.walk;
  if (locomotion) {
    actions.walk ||= locomotion;
    actions.run ||= locomotion;
    actions.vault ||= actions.run;
  }
  actions.idle ||= actions.walk || actions.run || clips[0];
  return actions;
}

const VAULT_KEYS = [
  // t, pitch, roll, crouch, lead leg, trail leg, left arm, right arm
  [0.00,  0.00, 0.00, 0.00,  0.00,  0.00,  0.00,  0.00],
  [0.16,  0.20, 0.03, 0.55,  0.48,  0.34,  0.52,  0.38],
  [0.31,  0.46, 0.08, 0.88, -1.22,  0.72, -1.28, -1.05],
  [0.60,  0.40, 0.06, 0.76, -0.72,  1.00, -1.05, -1.24],
  [0.82,  0.12, 0.03, 0.48, -0.28, -0.78,  0.36, -0.12],
  [1.00,  0.00, 0.00, 0.00,  0.00,  0.00,  0.00,  0.00],
];

/**
 * Authored window-vault pose at normalised progress.
 *
 * It has five readable beats: load both legs, drive one knee through, tuck the
 * trail leg, reach past the sill, then put the lead foot down. The modest root
 * pitch is intentional; clearance comes from the crouch and limb pose, not a
 * rigid-body somersault.
 */
export function sampleVaultPose(progress, side = 1) {
  const t = Math.max(0, Math.min(1, progress ?? 0));
  let a = VAULT_KEYS[0], b = VAULT_KEYS.at(-1);
  for (let i = 1; i < VAULT_KEYS.length; i++) {
    if (t > VAULT_KEYS[i][0]) continue;
    a = VAULT_KEYS[i - 1];
    b = VAULT_KEYS[i];
    break;
  }
  const u0 = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const u = u0 * u0 * (3 - 2 * u0);
  const value = (i) => a[i] + (b[i] - a[i]) * u;
  return {
    pitch: value(1), roll: value(2) * (side < 0 ? -1 : 1), crouch: value(3),
    leadLeg: value(4), trailLeg: value(5), armL: value(6), armR: value(7),
  };
}
