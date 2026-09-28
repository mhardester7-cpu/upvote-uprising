// Player: movement, voxel collision, and health.
//
// Collision resolves one axis at a time (X, then Z, then Y). Doing it this way
// means a blocked X move never cancels the Z component, so sliding along a wall
// feels smooth instead of sticky.

const HALF = 0.32;          // half width/depth of the player box
const HEIGHT = 1.8;
const EYE = 1.64;
const STEP_HEIGHT = 1.05;   // walk up one block without jumping
// Anything whose top is within this of your feet is climbed, not collided with.
// Matches World.supportHeight's window, so the two agree on what a step is.
const STEP_UP = 0.65;
/**
 * The same allowance while airborne, and it has to be nearly nothing.
 *
 * The step-up window is measured from the feet, so applying it in mid-air says
 * "anything whose top is within 0.65 of wherever I have jumped to is a step" --
 * and a jump clears 1.35m. That made every wall in the map 2m of free climb,
 * and 2m is what a shelf gives you: shelf, wall top, roof, out of the level.
 * On the ground the allowance is what walking over a kerb is; in the air the
 * only thing you may land on is something already at or below your feet.
 */
const AIR_STEP = 0.05;

const GRAVITY = 26;
const JUMP_SPEED = 8.4;
const WALK_SPEED = 5.2;
const SPRINT_SPEED = 8.0;
const MAX_PARKOUR_SPEED = 14;
// 8.5m/s clears the map's 3m cross-streets within the 0.42s seam grace.
// A connected wall run has no stamina timer; height is regained with jumps.
const WALL_RUN_SPEED = 8.5;
const WALL_GAP_GRACE = 0.42;
const WALL_JUMP_BUFFER = 0.14;
const GROUND_ACCEL = 62;
const AIR_ACCEL = 20;
const GROUND_FRICTION = 12;

export class Player {
  constructor(world) {
    this.world = world;
    this.pos = { x: 0, y: 40, z: 0 };      // feet position (box bottom)
    this.prevPos = { x: 0, y: 40, z: 0 };  // previous tick, for render interpolation
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.pitch = 0;

    this.onGround = false;
    this.sprinting = false;
    this.ladder = null;
    this.ladderCooldown = 0;

    this.maxHealth = 100;
    this.health = 100;
    this.alive = true;
    this.regenDelay = 0;      // seconds until health regen resumes
    this.timeSinceHit = 99;

    this.bobPhase = 0;
    this.bobAmount = 0;
    this.stepDistance = 0;

    // Multipliers driven by the kill-streak buffs and the potion perks.
    this.speedScale = 1;
    this.regenScale = 1;
    this.jumpScale = 1;
    this.damageScale = 1;      // incoming damage; IRONSKIN drives this below 1
    this.noFallDamage = false;

    // Poison: a fixed total spread evenly over a duration. Refreshing resets
    // the clock rather than stacking, so a swarm of spitters cannot chain a
    // player to death through one long unbreakable tick.
    this.poison = null;

    // Event hooks, wired up by the game.
    this.onStep = null;
    this.onLand = null;
    this.onJump = null;
    this.onDamage = null;
    this.onDeath = null;
    this.onPoisoned = null;
    this.onPoisonEnd = null;

    // Optional paired-portal controller. Kept as a capability rather than an
    // import so the headless movement simulation remains usable on its own.
    this.portalSystem = null;
    this._resetParkour();
  }

  get eyeY() { return this.pos.y + EYE; }
  get height() { return HEIGHT; }
  get half() { return HALF; }

  spawn(p) {
    this.pos.x = p.x; this.pos.y = p.y; this.pos.z = p.z;
    this.prevPos.x = p.x; this.prevPos.y = p.y; this.prevPos.z = p.z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.health = this.maxHealth;
    this.alive = true;
    this.onGround = false;
    this.ladder = null;
    this.ladderCooldown = 0;
    // Death and respawn end status effects. Without clearing this, a player
    // killed while a poison dose still had time left respawned at full health
    // and immediately resumed taking the previous life's damage.
    this.poison = null;
    this._resetParkour();
  }

  _resetParkour() {
    this.wallRunning = false;
    this.wallNormal = null;
    this.wallTime = 0;
    this.wallCooldown = 0;
    this.wallRoll = 0;
    this.wallGrace = 0;
    this.wallAnchor = null;
    this.jumpBuffer = 0;
    this._portalCooldown = 0;
    this._jumpWasDown = false;
  }

  get climbing() { return !!this.ladder; }

  /**
   * Mount the nearby authored ladder, or step away from the one being climbed.
   * E is used for the mount so merely brushing the cage in combat never steals
   * movement control. Once attached, normal forward/back bindings climb and
   * descend, which also gives touch movement the same behaviour for free.
   */
  tryUseLadder() {
    if (!this.alive) return false;
    if (this.ladder) {
      this._leaveLadder(false);
      return true;
    }
    if (this.ladderCooldown > 0) return false;
    const ladder = this.world.ladderNear?.(this.pos.x, this.pos.y, this.pos.z);
    if (!ladder) return false;

    this.ladder = ladder;
    const atTop = this.pos.y > ladder.deckY - 1.15;
    this.pos.x = ladder.x + ladder.normalX * (HALF + 0.08);
    this.pos.z = ladder.z + ladder.normalZ * (HALF + 0.08);
    this.pos.y = atTop
      ? ladder.deckY - 0.28
      : Math.max(ladder.minY, Math.min(ladder.deckY - 0.28, this.pos.y));
    this.prevPos.x = this.pos.x;
    this.prevPos.y = this.pos.y;
    this.prevPos.z = this.pos.z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.onGround = false;
    this.sprinting = false;
    // Face the rungs. At yaw zero the player's forward is -Z, which is exactly
    // inward for the canonical south-face ladder.
    this.yaw = Math.atan2(ladder.normalX, ladder.normalZ);
    return true;
  }

  _leaveLadder(jump) {
    const ladder = this.ladder;
    if (!ladder) return false;
    this.ladder = null;
    this.ladderCooldown = 0.32;
    const push = jump ? 0.78 : 0.48;
    this.pos.x += ladder.normalX * push;
    this.pos.z += ladder.normalZ * push;
    this.vel.x = ladder.normalX * (jump ? 3.2 : 0);
    this.vel.z = ladder.normalZ * (jump ? 3.2 : 0);
    this.vel.y = jump ? 3.7 : 0;
    this.onGround = false;
    return true;
  }

  _updateLadder(dt, input, canMove) {
    const ladder = this.ladder;
    if (!ladder) return false;

    if (canMove && input.actionPressed?.('jump')) {
      this._leaveLadder(true);
      return false;
    }

    let climb = 0;
    if (canMove) {
      const axis = input.moveAxis;
      if (axis) climb = Math.max(-1, Math.min(1, -axis.z));
      else {
        if (input.actionDown('forward')) climb += 1;
        if (input.actionDown('back')) climb -= 1;
      }
    }

    this.pos.x = ladder.x + ladder.normalX * (HALF + 0.08);
    this.pos.z = ladder.z + ladder.normalZ * (HALF + 0.08);
    this.pos.y += climb * (climb >= 0 ? 3.25 : 2.8) * dt;
    this.vel.x = this.vel.z = 0;
    this.vel.y = climb * (climb >= 0 ? 3.25 : 2.8);
    this.onGround = false;
    this.sprinting = false;
    this.bobAmount += (0 - this.bobAmount) * Math.min(1, dt * 12);
    // A restrained body rise makes the climb visible without applying ordinary
    // footsteps to metal rungs.
    this.bobPhase += Math.abs(climb) * dt * 5.2;

    if (climb > 0 && this.pos.y >= ladder.deckY - 0.03) {
      this.pos.x = ladder.topX;
      this.pos.z = ladder.topZ;
      this.pos.y = ladder.deckY;
      this.prevPos.x = this.pos.x;
      this.prevPos.y = this.pos.y;
      this.prevPos.z = this.pos.z;
      this.ladder = null;
      this.ladderCooldown = 0.32;
      this.vel.x = this.vel.y = this.vel.z = 0;
      this.onGround = true;
    } else if (climb < 0 && this.pos.y <= ladder.minY) {
      this.pos.y = ladder.minY;
      this.ladder = null;
      this.ladderCooldown = 0.32;
      this.vel.x = this.vel.y = this.vel.z = 0;
      this.onGround = true;
    } else {
      this.pos.y = Math.max(ladder.minY, Math.min(ladder.deckY - 0.02, this.pos.y));
    }
    return true;
  }

  /** Forward vector from yaw/pitch. Used for both aiming and view direction. */
  getLookDir(out = {}) {
    const cp = Math.cos(this.pitch);
    out.x = -Math.sin(this.yaw) * cp;
    out.y = Math.sin(this.pitch);
    out.z = -Math.cos(this.yaw) * cp;
    return out;
  }

  applyLook(dx, dy) {
    this.yaw -= dx;
    this.pitch -= dy;
    const lim = Math.PI / 2 - 0.001;
    if (this.pitch > lim) this.pitch = lim;
    if (this.pitch < -lim) this.pitch = -lim;
    // Keep yaw bounded so it never loses float precision over a long session.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  damage(amount, source) {
    if (!this.alive) return;
    if (!Number.isFinite(amount) || amount <= 0) return;
    amount *= this.damageScale;
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.health -= amount;
    this.timeSinceHit = 0;
    this.regenDelay = 5;
    this.onDamage?.(amount, source);
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.onDeath?.(source);
    }
  }

  /** Immediate hazards bypass armour, perks and the ordinary damage scale. */
  kill(source = 'instant') {
    if (!this.alive) return false;
    this.health = 0;
    this.alive = false;
    this.poison = null;
    this.onDamage?.(this.maxHealth, source);
    this.onDeath?.(source);
    return true;
  }

  heal(amount) {
    if (!this.alive || !Number.isFinite(amount) || amount <= 0) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /** Apply (or refresh) a damage-over-time. */
  applyPoison(total, duration) {
    if (!this.alive || !Number.isFinite(total) || !Number.isFinite(duration)
      || total <= 0 || duration <= 0) return;
    const scaled = total * this.damageScale;   // IRONSKIN blunts poison too
    if (!Number.isFinite(scaled) || scaled <= 0) return;
    // Refresh: whatever is left of an existing dose is rolled into the new one
    // so re-poisoning is never a downgrade, but it stays bounded.
    const carry = this.poison ? this.poison.remaining : 0;
    this.poison = {
      remaining: Math.min(scaled + carry, scaled * 2),
      duration,
      timeLeft: duration,
    };
    this.onPoisoned?.(this.poison);
  }

  get poisoned() { return !!this.poison && this.poison.timeLeft > 0; }

  /**
   * Bleed off the current dose. Deliberately does not go through damage():
   * that would re-fire the hit flash sixty times a second and restart the
   * regen delay on every tick.
   */
  _tickPoison(dt) {
    const p = this.poison;
    if (!p) return;

    const step = Math.min(dt, p.timeLeft);
    const amount = p.remaining * (step / p.timeLeft);
    p.timeLeft -= step;
    p.remaining -= amount;

    this.health -= amount;
    this.regenDelay = Math.max(this.regenDelay, 1.5);   // no regen while poisoned

    if (p.timeLeft <= 1e-6 || p.remaining <= 1e-6) {
      this.poison = null;
      this.onPoisonEnd?.();
    }

    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.onDeath?.('poison');
    }
  }

  update(dt, input, canMove = true) {
    this.prevPos.x = this.pos.x;
    this.prevPos.y = this.pos.y;
    this.prevPos.z = this.pos.z;

    this._portalCooldown = Math.max(0, (this._portalCooldown ?? 0) - dt);
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);
    if (!this.alive) {
      this.wallRunning = false;
      this.wallRoll = 0;
      this.ladder = null;
      // Still fall, but no input. Only the vertical axis is resolved: a corpse
      // has no wish direction, so there is nothing horizontal to sweep.
      this.vel.y -= GRAVITY * dt;
      this.pos.y += this.vel.y * dt;
      const rest = this.world.supportHeight(this.pos.x, this.pos.z, this.pos.y, HALF);
      if (this.pos.y <= rest) {
        this.pos.y = rest;
        this.vel.y = 0;
        this.onGround = true;
      }
      return;
    }

    if (this.ladderCooldown > 0) this.ladderCooldown = Math.max(0, this.ladderCooldown - dt);
    if (this._updateLadder(dt, input, canMove)) return;

    this.timeSinceHit += dt;
    if (this.poison) this._tickPoison(dt);
    if (!this.alive) return;
    if (this.regenDelay > 0) this.regenDelay -= dt;
    else if (this.health < this.maxHealth) this.heal(18 * this.regenScale * dt);

    // ---- desired direction in world space --------------------------------
    let ix = 0, iz = 0;
    if (canMove) {
      // A thumb stick reports magnitude as well as direction, so it replaces
      // the key reads outright rather than being folded in with them.
      const axis = input.moveAxis;
      if (axis) {
        ix = axis.x; iz = axis.z;
      } else {
        if (input.actionDown('forward')) iz -= 1;
        if (input.actionDown('back')) iz += 1;
        if (input.actionDown('left')) ix -= 1;
        if (input.actionDown('right')) ix += 1;
      }
    }
    // Clamp rather than normalise. Normalising would push a half-deflected
    // stick up to full speed and throw away the analog range entirely, while
    // clamping still brings a WASD diagonal (length 1.41) back to 1 and leaves
    // a single key (length 1) exactly where it was.
    const len = Math.hypot(ix, iz);
    if (len > 1) { ix /= len; iz /= len; }

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // At yaw 0 the player faces -Z, so forward = (-sin, -cos) and the right
    // vector is that turned 90 degrees: right = (cos, -sin).
    // W gives iz = -1, so the forward term is scaled by -iz.
    const wishX = ix * cos + iz * sin;
    const wishZ = -ix * sin + iz * cos;

    const jumpDown = canMove && input.actionDown('jump');
    const jumpPressed = jumpDown && !this._jumpWasDown;
    this._jumpWasDown = jumpDown;
    this.jumpBuffer = jumpPressed ? WALL_JUMP_BUFFER : Math.max(0, this.jumpBuffer - dt);
    this.sprinting = canMove && input.actionDown('sprint') && iz < 0;
    const maxSpeed = (this.sprinting ? SPRINT_SPEED : WALK_SPEED) * this.speedScale;
    const hopping = this.onGround && jumpDown;

    // Accelerate only the missing velocity along the wish direction in air.
    // Steering a portal launch must never clamp its existing momentum away.
    if (len > 0) {
      if (this.onGround && !hopping) {
        const blend = Math.min(1, GROUND_ACCEL * dt / maxSpeed);
        this.vel.x += (wishX * maxSpeed - this.vel.x) * blend;
        this.vel.z += (wishZ * maxSpeed - this.vel.z) * blend;
      } else {
        const before = Math.hypot(this.vel.x, this.vel.z);
        const projected = this.vel.x * wishX + this.vel.z * wishZ;
        const add = Math.max(0, Math.min(maxSpeed - projected, AIR_ACCEL * dt));
        this.vel.x += wishX * add;
        this.vel.z += wishZ * add;
        if (hopping && before > 3) {
          this.vel.x += wishX * 0.65;
          this.vel.z += wishZ * 0.65;
        }
        const speed = Math.hypot(this.vel.x, this.vel.z);
        const cap = Math.max(before, MAX_PARKOUR_SPEED * this.speedScale);
        if (speed > cap) { this.vel.x *= cap / speed; this.vel.z *= cap / speed; }
      }
    } else if (this.onGround) {
      const speed = Math.hypot(this.vel.x, this.vel.z);
      const drop = speed > 0 ? Math.max(0, speed - GROUND_FRICTION * dt) / speed : 0;
      this.vel.x *= drop; this.vel.z *= drop;
    }

    if (hopping) {
      this.vel.y = JUMP_SPEED * this.jumpScale;
      this.onGround = false;
      this.wallTime = 0;
      this.jumpBuffer = 0;
      this.onJump?.();
    }

    // Entering a portal wins over wall adhesion. Otherwise an airborne
    // approach can lose its inward velocity before collision sees the opening.
    if (this.portalSystem?.tryTraverse(this)) return;

    // Probe in world space, independently of camera yaw. Every solid near-
    // vertical face is eligible, including doors, pillars and curved walls.
    if (this.wallNormal && canMove && wishX*this.wallNormal.x+wishZ*this.wallNormal.z>.5) {
      // Air acceleration is capped along the wish direction; at running speed
      // that cap can otherwise swallow an explicit strafe away from the wall.
      const outward=this.vel.x*this.wallNormal.x+this.vel.z*this.wallNormal.z;
      const push=Math.max(0,Math.min(3-outward,GROUND_ACCEL*dt));
      this.vel.x+=this.wallNormal.x*push;
      this.vel.z+=this.wallNormal.z*push;
    }
    let wall = null;
    let bestWall = -Infinity;
    if (!this.onGround && canMove && len > .2 && this.wallCooldown === 0
        && Math.hypot(this.vel.x, this.vel.z) > 2) {
      for (let i = 0; i < 12; i++) {
        const angle = i * Math.PI / 6;
        const dx = Math.cos(angle), dz = Math.sin(angle);
        const hit = this.world.raycast?.(this.pos.x, this.pos.y + 1, this.pos.z,
          dx, 0, dz, HALF + 0.3);
        if (!hit?.hit || Math.abs(hit.ny) > 0.3) continue;
        const normalLength = Math.hypot(hit.nx,hit.nz);
        if (normalLength < .9) continue;
        const nx = hit.nx / normalLength, nz = hit.nz / normalLength;
        const tangent = Math.abs(wishX * -nz + wishZ * nx);
        // Head-on movement has no direction along the wall. As soon as the
        // player steers along either side, that same wall supports a run.
        if (tangent < .2 || wishX*nx+wishZ*nz > .5) continue;
        const continuity = this.wallNormal ? Math.max(0,nx*this.wallNormal.x+nz*this.wallNormal.z)*.3 : 0;
        const score=tangent+continuity-(hit.distance??.4)*.2;
        if (score > bestWall) {bestWall=score;wall={x:nx,z:nz};}
      }
    }
    if (wall) {
      this.wallGrace = WALL_GAP_GRACE;
      this.wallAnchor = {x:this.pos.x,z:this.pos.z};
    } else {
      this.wallGrace = Math.max(0,this.wallGrace-dt);
      const previous = this.wallNormal;
      // Bridge a cross-street only while staying beside the same wall plane.
      // Steering out into open space, stopping, or jumping releases adhesion.
      if (previous && this.wallAnchor && this.wallGrace > 0 && !this.onGround
          && canMove && len > .2 && this.wallCooldown === 0
          && Math.abs((this.pos.x-this.wallAnchor.x)*previous.x
            +(this.pos.z-this.wallAnchor.z)*previous.z)<.35
          && Math.abs(wishX*-previous.z+wishZ*previous.x)>.2
          && wishX*previous.x+wishZ*previous.z <= .5) wall=previous;
    }
    this.wallRunning = !!wall;
    this.wallNormal = wall;
    if (wall) {
      this.wallTime += dt;
      const into = this.vel.x * wall.x + this.vel.z * wall.z;
      this.vel.x -= into * wall.x;
      this.vel.z -= into * wall.z;
      const along=this.vel.x*-wall.z+this.vel.z*wall.x;
      const wishAlong=wishX*-wall.z+wishZ*wall.x;
      const direction=Math.sign(wishAlong);
      const accelerate=Math.max(0,Math.min(WALL_RUN_SPEED*this.speedScale-along*direction,GROUND_ACCEL*dt));
      this.vel.x += -wall.z*direction*accelerate;
      this.vel.z += wall.x*direction*accelerate;
      this.vel.y = Math.max(-0.45, this.vel.y - GRAVITY * 0.16 * dt);
      if (this.jumpBuffer > 0 && !hopping) {
        this.vel.x += wall.x * 6;
        this.vel.z += wall.z * 6;
        this.vel.y = JUMP_SPEED * this.jumpScale;
        this.wallRunning = false;
        this.wallCooldown = 0.18;
        this.wallGrace = 0;
        this.wallNormal = null;
        this.jumpBuffer = 0;
        this.wallTime = 0;
        this.onJump?.();
      }
    } else {
      this.vel.y -= GRAVITY * dt;
      if (this.onGround) this.wallTime = 0;
    }
    const roll = this.wallRunning ? (wall.x * cos - wall.z * sin) * 0.065 : 0;
    this.wallRoll += (roll - this.wallRoll) * Math.min(1, dt * 10);
    if (this.vel.y < -60) this.vel.y = -60;

    // ---- integrate against the heightfield -------------------------------
    // Horizontal first, one axis at a time so a blocked X never cancels Z and
    // sliding along a slope or a wall stays smooth.
    const wasGround = this.onGround;

    // A body that is already inside something is refused every direction it
    // tries to go, including out, and that is what being stuck is. Letting it
    // move anyway would be worse -- an overlap would become a licence to walk
    // through the wall you are overlapping -- so it is lifted clear instead,
    // by the shortest move that reaches open floor.
    this._unstick();

    this._portalMovedThisTick = false;
    this._moveHorizontal(0, this.vel.x * dt);
    if (this._portalMovedThisTick) return;
    this._moveHorizontal(2, this.vel.z * dt);
    if (this._portalMovedThisTick) return;

    // Props push the capsule out after the move; doing it here rather than
    // per-axis means corners resolve once, along their shallowest face.
    this.world.resolveProps(this.pos, HALF, HEIGHT);

    // ---- vertical --------------------------------------------------------
    const yBefore = this.pos.y;
    this.pos.y += this.vel.y * dt;

    // Floors and ceilings are resolved below, which would erase the incoming
    // vertical velocity before a portal could rotate it. Give the aperture the
    // crossing while that momentum is still intact.
    if (this.portalSystem?.tryTraverse(this)) return;

    // Bump your head on the ceiling rather than through it. A storey is 3.4m
    // and a jump clears 1.35m, so this only ever fires under a mezzanine, on a
    // staircase, or below a doorway header -- but it fires there constantly,
    // and a head inside a slab is a body the resolver will try to push out
    // sideways.
    if (this.vel.y > 0) {
      const ceiling = this.world.ceilingAt(this.pos.x, this.pos.z, yBefore, HALF);
      if (this.pos.y + HEIGHT > ceiling) {
        this.pos.y = ceiling - HEIGHT;
        this.vel.y = 0;
      }
    }

    // Falling, the allowance has to cover the distance covered this tick, or a
    // fast drop passes clean through a floor: the surface was above the feet
    // when the tick started and below them when it ended, so a small fixed
    // window never sees it. Measured from where the feet were, not from where
    // they are, which is the same thing said in a way that cannot tunnel.
    const fell = Math.max(0, yBefore - this.pos.y);
    const lift = wasGround ? STEP_UP : fell + AIR_STEP;
    const ground = this.world.supportHeight(this.pos.x, this.pos.z, this.pos.y, HALF, lift);
    if (this.pos.y <= ground) {
      if (this.vel.y < 0 && !wasGround && this.vel.y < -6) {
        this.onLand?.(-this.vel.y);
        // Fall damage past a survivable drop. LEAPING waives it entirely.
        const excess = -this.vel.y - 17;
        if (excess > 0 && !this.noFallDamage) this.damage(excess * 4.5, 'fall');
      }
      this.pos.y = ground;
      this.vel.y = 0;
      this.onGround = true;
    } else if (this.pos.y - ground < 0.12 && this.vel.y <= 0) {
      // Snap down small drops so walking downhill does not turn into hopping.
      this.pos.y = ground;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // ---- view bob / footsteps -------------------------------------------
    const hspeed = Math.hypot(this.vel.x, this.vel.z);
    const targetBob = this.onGround ? Math.min(1, hspeed / WALK_SPEED) : 0;
    this.bobAmount += (targetBob - this.bobAmount) * Math.min(1, dt * 10);
    this.bobPhase += hspeed * dt * 1.9;

    if (this.onGround) {
      this.stepDistance += hspeed * dt;
      const stride = this.sprinting ? 2.4 : 1.9;
      if (this.stepDistance > stride) {
        this.stepDistance = 0;
        this.onStep?.();
      }
    }

  }

  // --------------------------------------------------------------- collision

  /**
   * Lift the body out of anything it has ended up inside.
   *
   * Overlaps happen for reasons movement cannot prevent: a knockback shoving
   * you into cover, a door closing on you, a spawn point that turned out to be
   * inside a desk, or two colliders whose push-out directions cancel. The
   * position is then illegal, every move out of it is refused because the
   * destination is also inside the same solid, and the player is welded in
   * place until they die.
   *
   * The search spirals outward from where they already are, so the smallest
   * possible correction wins and a body pressed against a wall is not flung
   * across the room. Doing nothing when nothing is found is deliberate: the
   * next tick tries again, and a bad guess is worse than another frame stuck.
   */
  _unstick() {
    const w = this.world;
    // Genuinely inside something, not merely somewhere a move would be refused
    // from. blocksAt inflates every solid by the body's radius, which is the
    // right question to ask before moving and the wrong one to ask about where
    // you already are: standing in a window reveal legitimately overlaps the
    // inflated box of the boards beside you. Asking with almost no radius asks
    // whether the body and the solid actually intersect.
    if (!w.blocksAt(this.pos.x, this.pos.y, this.pos.z, 0.02, HEIGHT, STEP_UP)) return;

    const eyeY = this.pos.y + HEIGHT * 0.5;
    for (const radius of [0.35, 0.7, 1.1, 1.6, 2.2, 3.0]) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const x = this.pos.x + Math.cos(a) * radius;
        const z = this.pos.z + Math.sin(a) * radius;
        if (!w.inBounds(x, z)) continue;
        if (w.blocksAt(x, this.pos.y, z, HALF, HEIGHT, STEP_UP)) continue;

        // The floor under the escape has to be one we could have walked to,
        // not a rooftop or the bottom of a shaft.
        const support = w.supportHeight(x, z, this.pos.y, HALF, STEP_UP);
        if (Math.abs(support - this.pos.y) > STEP_HEIGHT) continue;
        // And it has to be on this side of the wall. Without this the rescue
        // is a teleport through whatever you were stuck in, which is a far
        // better way out of a sealed room than any door.
        if (!w.lineOfSight(this.pos.x, eyeY, this.pos.z, x, eyeY, z)) continue;

        this.pos.x = x;
        this.pos.z = z;
        this.pos.y = Math.max(this.pos.y, support);
        this.vel.x = this.vel.z = 0;
        return;
      }
    }
  }

  /**
   * Move along one horizontal axis, refusing steps that would climb something
   * too tall or too steep.
   *
   * Terrain is never "solid" the way a voxel was -- you are always above it --
   * so a wall is expressed as ground that rises faster than the step height,
   * or as a face steeper than the walkable slope limit.
   */
  _moveHorizontal(axis, amount) {
    const steps = Math.max(1, Math.ceil(Math.abs(amount) / 0.2));
    for (let i = 0; i < steps; i++) {
      const blocked = this._moveHorizontalStep(axis, amount / steps);
      if (blocked || this._portalMovedThisTick) return blocked;
    }
    return false;
  }

  _moveHorizontalStep(axis, amount) {
    if (amount === 0) return false;
    const key = axis === 0 ? 'x' : 'z';
    const before = this.pos[key];
    this.pos[key] += amount;

    if (!this.world.inBounds(this.pos.x, this.pos.z)) {
      this.pos[key] = before;
      if (axis === 0) this.vel.x = 0; else this.vel.z = 0;
      return true;
    }

    // Solid geometry blocks the move outright. supportHeight only sees things
    // low enough to climb, so without this a wall is invisible to movement and
    // the only thing keeping you inside a room is a push-out resolver that
    // ejects you through the wall the moment you cross its midline.
    const stepUp = this.onGround ? STEP_UP : AIR_STEP;
    if (this.world.blocksAt(this.pos.x, this.pos.y, this.pos.z, HALF, HEIGHT, stepUp)) {
      // The tentative position is intentionally still inside the collider at
      // this point. That is the exact crossing attempt a wall portal needs;
      // on success it replaces the blocked position with its paired exit.
      if (this.portalSystem?.tryTraverse(this)) {
        this._portalMovedThisTick = true;
        return false;
      }
      this.pos[key] = before;
      if (axis === 0) this.vel.x = 0; else this.vel.z = 0;
      return true;
    }

    const ground = this.world.supportHeight(this.pos.x, this.pos.z, this.pos.y, HALF, stepUp);
    const rise = ground - this.pos.y;

    // Climbable: step straight up onto it.
    if (rise > 0 && rise <= STEP_HEIGHT && this.world.isWalkable(this.pos.x, this.pos.z)) {
      this.pos.y = ground;
      return false;
    }

    // Too tall, or a cliff face: refuse the move on this axis only.
    if (rise > STEP_HEIGHT || (rise > 0.05 && !this.world.isWalkable(this.pos.x, this.pos.z))) {
      this.pos[key] = before;
      if (axis === 0) this.vel.x = 0; else this.vel.z = 0;
      return true;
    }

    return false;
  }
}
