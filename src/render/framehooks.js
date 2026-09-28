// Per-frame hook registry for the render layer.
//
// The render modules need a per-frame tick (wind animation, clutter streaming)
// but main.js owns the game loop and only ever pokes the sky's `time` uniform.
// Rather than require new wiring, the sky mesh -- which is always drawn, never
// frustum-culled and always first -- fans a tick out to everyone registered
// here from its own onBeforeRender.
//
// Registering is cheap and order-independent: the sky may be created before or
// after the things that subscribe.

const hooks = new Set();

/**
 * Subscribe to the per-frame tick.
 * @param {(ctx:{renderer:any,scene:any,camera:any,time:number,dt:number})=>void} fn
 * @returns {() => void} unsubscribe
 */
export function onFrame(fn) {
  hooks.add(fn);
  return () => hooks.delete(fn);
}

export function clearFrameHooks() {
  hooks.clear();
}

let lastTime = 0;

/** Called by the sky. Safe to call more than once per frame. */
export function runFrameHooks(renderer, scene, camera, time) {
  const dt = Math.max(0, Math.min(0.25, time - lastTime));
  lastTime = time;
  if (dt <= 0) return;
  const ctx = { renderer, scene, camera, time, dt };
  for (const fn of hooks) fn(ctx);
}
