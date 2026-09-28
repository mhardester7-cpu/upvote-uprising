// Pure sprint posing for the purpose-built baby zombie.
//
// Kept separate from the skinned-character clip classifier because this model
// is a rigid hierarchy with named limb pivots. The simulation supplies distance
// travelled; the renderer samples the same gait in solo and co-op.

export function sampleRunnerGait(phase, speed, topSpeed = 4) {
  const pace = Math.max(0, Number(speed) || 0);
  const moving = pace > 0.06;
  const effort = moving ? Math.min(1, pace / Math.max(0.01, topSpeed)) : 0;
  const stride = moving ? Math.sin(phase) * (0.72 + effort * 0.38) : 0;
  const plant = moving ? 0.5 + 0.5 * Math.cos(phase * 2) : 0;

  return {
    legL: stride,
    legR: -stride,
    armL: -stride * 0.82,
    armR: stride * 0.82,
    // The bespoke torso is authored at a 0.30 rad hunch. Faster movement leans
    // it farther over its toes and adds a small shoulder beat at foot plant.
    torsoPitch: 0.30 + effort * 0.13 + plant * effort * 0.025,
    bob: moving ? (1 - plant) * effort * 0.022 : 0,
  };
}
