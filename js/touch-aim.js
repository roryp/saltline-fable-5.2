// Touch screens only: aim assist, auto-fire and auto-reload.
//
// On a phone one pixel of drag turns the view 0.3°, and a Gull 30 m away is a couple of degrees wide, so the right
// thumb can't hold the crosshair on it. Near a machine the view now slows down, follows the machine and eases onto
// it; the gun fires while it's on target; shots that only just miss are bent onto the machine's body. Walls still stop
// everything: nothing locks on to, or is hit through, cover. A firm drag away lets the machine go. Mouse, keyboard and
// gamepad play is unchanged.

import { wrapAngle } from "./tactics.js";

export const ASSIST = {
  range: 60, // m: no help beyond this
  cone: 0.16, // rad (~9°) round the crosshair where the view slows down and follows
  friction: 0.5, // share of the player's own look speed right on a machine; back to 1 at the cone's edge
  pull: 6, // 1/s: how fast the view eases onto the machine
  pullFiring: 10, // 1/s, while firing or aiming
  maxPull: 2.5, // rad/s
  track: 0.85, // share of the machine's own movement across the view that the view follows
  escape: 0.02, // rad per frame: a faster drag away lets the machine go
  size: 0.3, // m: radius of a machine's body for auto-fire and bent shots
  fireMargin: 0.02, // rad beyond a machine's size that still fires
  fireRange: 50, // m
  fireHold: 0.15, // s: keeps firing when the crosshair slips off for a moment
  magnet: 0.035, // rad beyond a machine's size: shots that close are bent onto it
};

const MAX_MOTION = 0.2; // rad per frame: more than this is a new or teleported machine, not movement

/** The middle of a machine's body hitbox: the game's Gull is a flat disc round `pos`, a Hound's body is a capsule. */
export function aimPoint(unit) {
  return { x: unit.pos.x, y: unit.pos.y + (unit.type === "hound" ? 0.62 : -0.03), z: unit.pos.z };
}

/** Yaw, pitch and distance from `from` to `to`, as the game measures the view (yaw 0 looks down -z). */
export function anglesTo(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const flat = Math.hypot(dx, dz);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, flat), dist: Math.hypot(flat, dy) };
}

/** Angle between two view directions given as yaw and pitch. */
export function angleBetween(a, b) {
  const cos = Math.sin(a.pitch) * Math.sin(b.pitch) + Math.cos(a.pitch) * Math.cos(b.pitch) * Math.cos(a.yaw - b.yaw);
  return Math.acos(Math.min(1, Math.max(-1, cos)));
}

/**
 * One frame of help: how far to turn the view (yaw, pitch) for a machine `err` away that moved `motion` across the
 * view since the last frame. The view follows `track` of the motion and closes the rest of the gap at `pull` per
 * second, at most `maxPull` rad/s; it never turns past the machine.
 */
export function assistTurn(err, motion, dt, { pull, maxPull, track }) {
  const followYaw = motion.yaw * track;
  const followPitch = motion.pitch * track;
  const k = 1 - Math.exp(-pull * dt);
  let yaw = (err.yaw - followYaw) * k;
  let pitch = (err.pitch - followPitch) * k;
  const cap = maxPull * dt;
  const len = Math.hypot(yaw, pitch);
  if (len > cap) {
    yaw *= cap / len;
    pitch *= cap / len;
  }
  return { yaw: followYaw + yaw, pitch: followPitch + pitch };
}

/** Whether the crosshair, `off` rad from the middle of a machine `dist` m away, is on it. */
export function onTarget(off, dist, { size, fireMargin, fireRange }) {
  return dist <= fireRange && off <= Math.atan(size / dist) + fireMargin;
}

/** How far, in rad, a shot can miss the middle of a machine `dist` m away and still be bent onto it. */
export function magnetLimit(dist, { size, magnet }) {
  return Math.atan(size / dist) + magnet;
}

const clampAbs = (v, max) => Math.max(-max, Math.min(max, v));

export function installTouchAim(G) {
  const { input, player, weapon, combat, enemies, physics, camera, THREE } = G;
  if (!input || !player?.update || !combat?.playerShot || !enemies?.list || !physics?.raycast || !camera) return null;

  const v = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const state = { t: 0, target: null, last: null, fireUntil: -1, auto: false, ignore: null, ignoreUntil: -1 };
  let fireButton = null;

  const active = () => input.touch && G.game?.state === "playing" && player.alive && player.enabled !== false;

  // Bullets' view of the level: true when nothing blocks the line from `from` to the point `dist` m away.
  const clear = (from, to, dist) => {
    v.set(to.x - from.x, to.y - from.y, to.z - from.z).divideScalar(dist);
    return !physics.raycast(from, v, Math.max(0, dist - 0.3));
  };

  const showAuto = (on) => {
    fireButton ??= document.querySelector("#ui > .touch .t-fire");
    fireButton?.classList.toggle("hm-auto", on);
  };

  const release = () => {
    state.target = null;
    state.last = null;
    state.fireUntil = -1;
    if (state.auto) showAuto(false);
    state.auto = false;
  };

  function assist(dt) {
    state.t += dt;
    if (weapon && weapon.ammo <= 0 && weapon.reserve > 0 && weapon.state !== "reloading") weapon.reloadNow?.();

    camera.getWorldDirection(fwd);
    const view = { yaw: Math.atan2(-fwd.x, -fwd.z), pitch: Math.asin(Math.min(1, Math.max(-1, fwd.y))) };
    const eye = player.eye;
    const candidates = [];
    for (const unit of enemies.list) {
      if (!unit.alive || !unit.active) continue;
      if (unit === state.ignore && state.t < state.ignoreUntil) continue;
      const p = aimPoint(unit);
      const to = anglesTo(eye, p);
      if (to.dist > ASSIST.range || to.dist < 0.5) continue;
      const angle = angleBetween(view, to);
      const current = unit === state.target;
      if (angle > ASSIST.cone * (current ? 1.25 : 1)) continue;
      candidates.push({ unit, p, to, angle, score: angle * (current ? 0.7 : 1) });
    }
    candidates.sort((a, b) => a.score - b.score);
    const pick = candidates.slice(0, 3).find((c) => clear(eye, c.p, c.to.dist));
    if (!pick) return release();
    if (pick.unit !== state.target) state.fireUntil = -1;

    const scale = player.lookScale || 1;
    const err = { yaw: wrapAngle(pick.to.yaw - view.yaw), pitch: pick.to.pitch - view.pitch };
    const drag = { yaw: -input.look.dx * scale, pitch: -input.look.dy * scale };
    const dragLen = Math.hypot(drag.yaw, drag.pitch);
    const away = drag.yaw * err.yaw + drag.pitch * err.pitch < 0 && dragLen > 0.004;
    if (away && dragLen > ASSIST.escape) {
      state.ignore = pick.unit;
      state.ignoreUntil = state.t + 0.4;
      return release();
    }

    if (!away) {
      const slow = ASSIST.friction + (1 - ASSIST.friction) * Math.min(1, pick.angle / ASSIST.cone);
      input.look.dx *= slow;
      input.look.dy *= slow;
      const motion =
        state.target === pick.unit && state.last
          ? { yaw: clampAbs(wrapAngle(pick.to.yaw - state.last.yaw), MAX_MOTION), pitch: clampAbs(pick.to.pitch - state.last.pitch, MAX_MOTION) }
          : { yaw: 0, pitch: 0 };
      const pull = input.fire || input.ads || state.auto ? ASSIST.pullFiring : ASSIST.pull;
      const turn = assistTurn(err, motion, dt, { pull, maxPull: ASSIST.maxPull, track: ASSIST.track });
      input.look.dx -= turn.yaw / scale;
      input.look.dy -= turn.pitch / scale;
    }
    state.target = pick.unit;
    state.last = { yaw: pick.to.yaw, pitch: pick.to.pitch };

    // Where this frame's look leaves the crosshair.
    const aim = { yaw: view.yaw - input.look.dx * scale, pitch: view.pitch - input.look.dy * scale };
    if (onTarget(angleBetween(aim, pick.to), pick.to.dist, ASSIST)) state.fireUntil = state.t + ASSIST.fireHold;
    const auto = state.t < state.fireUntil;
    if (auto !== state.auto) showAuto(auto);
    state.auto = auto;
    // Before the player's update, so firing also stops a sprint, as the FIRE button does.
    if (auto) input.fire = true;
  }

  // A shot that only just misses a machine's body goes into it; a clean hit, head shots included, stays as it is.
  function bend(origin, dir, range) {
    if (enemies.raycast(origin, dir, range)) return;
    let best = null;
    for (const unit of enemies.list) {
      if (!unit.alive || !unit.active) continue;
      const p = aimPoint(unit);
      v.set(p.x - origin.x, p.y - origin.y, p.z - origin.z);
      const dist = v.length();
      if (dist < 0.5 || dist > Math.min(range, ASSIST.range)) continue;
      const off = v.angleTo(dir);
      if (off <= magnetLimit(dist, ASSIST) && (!best || off < best.off)) best = { off, dist, p };
    }
    if (best && clear(origin, best.p, best.dist)) dir.copy(v.set(best.p.x - origin.x, best.p.y - origin.y, best.p.z - origin.z).normalize());
  }

  const update = player.update.bind(player);
  player.update = (dt) => {
    if (active()) assist(dt);
    else if (state.target || state.auto) release();
    update(dt);
  };
  const playerShot = combat.playerShot.bind(combat);
  combat.playerShot = (origin, dir, opts) => {
    if (active()) bend(origin, dir, opts?.range ?? 300);
    return playerShot(origin, dir, opts);
  };

  const [, touchKeys] = document.querySelectorAll('[data-pane="controls"] dl.keys');
  touchKeys?.insertAdjacentHTML("beforeend", "<div><dt>Auto aim</dt><dd>Crosshair near a machine: it follows and fires</dd></div>");
  return state;
}
