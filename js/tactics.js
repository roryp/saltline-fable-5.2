// Tactical geometry for the model-driven Gulls and Hounds. Pure functions (no DOM, no three.js),
// shared by the browser brain (js/harbormaster.js) and the tests.
//
// Angles follow the game's convention: a point at angle a round the intruder sits at
// (x, z) = (cos a, sin a) * range from them.

export const GULL_ORDERS = ["circle", "crossfire", "dive", "climb"];
export const HOUND_ORDERS = ["cover", "flank", "crossfire", "hold", "fall_back"];

// The `noul` thresholds for the two drastic moves. Microsoft-Decision-1 is cautious about
// self-destructing or charging into gunfire, so these sit below an even 0.5.
export const RAM_THRESHOLD = 0.25;
export const CHARGE_THRESHOLD = 0.4;

const TAU = Math.PI * 2;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a) {
  const t = (((a + Math.PI) % TAU) + TAU) % TAU;
  return t === 0 ? Math.PI : t - Math.PI;
}

/** Angle of `p` round `center` in the x/z plane. */
export function angleAround(center, p) {
  return Math.atan2(p.z - center.z, p.x - center.x);
}

/** Absolute angle (0..PI) between the intruder's facing and the direction from the intruder to `p`. */
export function viewAngle(forward, center, p) {
  return Math.abs(wrapAngle(angleAround(center, p) - Math.atan2(forward.z, forward.x)));
}

/** Where `p` is relative to the intruder's view: "front" (< 45°), "side" (< 110°) or "behind". */
export function viewOf(forward, center, p) {
  const a = viewAngle(forward, center, p);
  return a < Math.PI / 4 ? "front" : a < (110 * Math.PI) / 180 ? "side" : "behind";
}

/** Where `other` is round the intruder relative to `self`: "same", "flank" or "opposite". */
export function sideOf(center, self, other) {
  const a = Math.abs(wrapAngle(angleAround(center, other) - angleAround(center, self)));
  return a < Math.PI / 3 ? "same" : a < (2 * Math.PI) / 3 ? "flank" : "opposite";
}

/** The angle opposite the squad's mean direction round the intruder, or null without a squad. */
export function crossfireAngle(angles) {
  if (!angles.length) return null;
  let x = 0;
  let z = 0;
  for (const a of angles) {
    x += Math.cos(a);
    z += Math.sin(a);
  }
  if (Math.hypot(x, z) < 1e-6) return null;
  return wrapAngle(Math.atan2(z, x) + Math.PI);
}

/**
 * Multiplier on a machine's gun cooldown for an aggression score (0 hold fire .. 4 relentless):
 * 1 at "Steady" (2), about 0.47 at "Relentless" (4) and 2.1 at "Hold fire" (0).
 */
export function cooldownScale(score) {
  return 2 ** ((2 - score) * 0.55);
}

/** The model's aggression score says not to shoot at all. */
export function holdsFire(score) {
  return score < 0.5;
}

/**
 * Orbit for a Gull maneuver. The game flies each engaged Gull round the intruder at `orbitR` metres,
 * `alt` metres above them, turning in `orbitDir` (+1 = increasing orbit angle).
 *
 * @param {string} maneuver one of GULL_ORDERS
 * @param {{ angle: number, lookAngle: number, squadAngles: number[], orbitDir: number,
 *   rangeMin: number, rangeMax: number, altMin: number, altMax: number }} ctx
 *   `angle`: the Gull's angle round the intruder; `lookAngle`: where the intruder is looking.
 */
export function gullOrbit(maneuver, ctx) {
  const midR = (ctx.rangeMin + ctx.rangeMax) / 2;
  const midAlt = (ctx.altMin + ctx.altMax) / 2;
  // Turn away from where the intruder is looking, towards their back.
  const away = wrapAngle(ctx.angle - ctx.lookAngle) >= 0 ? 1 : -1;
  switch (maneuver) {
    case "crossfire": {
      const target = crossfireAngle(ctx.squadAngles);
      const delta = target === null ? 0 : wrapAngle(target - ctx.angle);
      return { orbitR: midR - 2, alt: midAlt, orbitDir: target === null || Math.abs(delta) < 0.2 ? away : Math.sign(delta) };
    }
    case "dive":
      return { orbitR: ctx.rangeMin - 3, alt: ctx.altMin - 1.5, orbitDir: away };
    case "climb":
      return { orbitR: ctx.rangeMax - 1, alt: ctx.altMax + 2, orbitDir: away };
    default:
      return { orbitR: midR, alt: midAlt, orbitDir: away };
  }
}

// Distance band (metres from the intruder) for each Hound tactic.
export const HOUND_RANGES = {
  cover: [8, 18],
  flank: [7, 15],
  crossfire: [8, 17],
  hold: [6, 45],
  fall_back: [15, 26],
};

/**
 * Cost of a candidate firing spot for a Hound tactic; the brain picks the cheapest.
 * @param {string} tactic one of HOUND_ORDERS
 * @param {{ dist: number, travel: number, cover: boolean, los: boolean, view: number,
 *   cross: number|null, crowd: number }} c
 *   dist: metres to the intruder; travel: metres from the Hound; view: viewAngle of the spot
 *   (0 = in front of the intruder, PI = behind); cross: angle from the crossfire target (null = no squad);
 *   crowd: other Hounds within 3 m.
 */
export function spotCost(tactic, c) {
  let cost = c.travel * 0.9 + c.crowd * 16 + (c.los ? 0 : tactic === "fall_back" ? 8 : 22);
  switch (tactic) {
    case "cover":
      cost += (c.cover ? -8 : 0) + Math.abs(c.dist - 12) * 0.3;
      break;
    case "flank":
      // Out of the intruder's sight line: 12 in front, 2 at the side, 0 behind.
      cost += 10 * Math.max(0, Math.cos(c.view) + 0.2);
      break;
    case "crossfire":
      cost += c.cross === null ? 0 : (8 * c.cross) / Math.PI;
      break;
    case "hold":
      cost += c.travel * 1.6;
      break;
    case "fall_back":
      cost += Math.max(0, 20 - c.dist) * 0.8 + (c.cover ? -4 : 0);
      break;
  }
  return cost;
}
