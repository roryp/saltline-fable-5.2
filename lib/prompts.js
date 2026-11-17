// Builds the Microsoft-Decision-1 requests for the port's machines and reads their answers.
//
//   Gull  (drone)     -> choice maneuver + score aggression + noul ram     (ram: only when badly damaged and close)
//   Hound (robot dog) -> choice tactic   + score aggression + noul charge  (charge: only when the intruder is close and in sight)
//
// The browser sends a small JSON snapshot of one machine's situation. Every value is validated and
// clamped here, and the server writes the text and the questions, so the browser can't put arbitrary
// text or questions in front of the model through this server.

import { readChoice, readNoul, readScore } from "./decisions.js";

export const GULL_MANEUVERS = {
  circle: "Keep circling the intruder at medium range, swinging away from where they are looking.",
  crossfire: "Swing round to the side of the intruder opposite the rest of the squad, so the intruder is caught in crossfire.",
  dive: "Drop to close range and low altitude for accurate fire. Exposed to return fire.",
  climb: "Climb high and widen the circle: harder to hit, but less accurate.",
};

export const HOUND_TACTICS = {
  cover: "Move to a firing spot behind cover (containers, machinery) that still sees the intruder.",
  flank: "Circle round to the intruder's side or back, out of their sight line, and attack from there.",
  crossfire: "Take a firing spot on the side of the intruder opposite the rest of the squad.",
  hold: "Stay put and keep shooting from here.",
  fall_back: "Back off to long range, behind cover if possible.",
};

export const AGGRESSION_LEVELS = [
  "Hold fire: do not shoot; wait for a better moment.",
  "Cautious: fire now and then.",
  "Steady: normal rate of fire.",
  "Aggressive: fire whenever the gun is ready.",
  "Relentless: fire as fast as the gun allows.",
];

// The special moves are only offered when they can make sense.
export const RAM_MAX_HULL = 0.5;
export const RAM_MAX_DISTANCE_M = 30;
export const CHARGE_MAX_DISTANCE_M = 16;

const KINDS = {
  gull: {
    noun: "Gull",
    body: "an armed quadcopter drone",
    hullWord: "Hull",
    orderName: "maneuver",
    orders: GULL_MANEUVERS,
    orderInstructions: (id) =>
      `Which maneuver should ${id} fly for the next two seconds? Weigh its hull, the intruder's health and what they are doing, where they are looking, and what the rest of the squad is doing.`,
    specialName: "ram",
    special: (s) => s.specialReady && s.hull <= RAM_MAX_HULL && s.sees && s.distanceM <= RAM_MAX_DISTANCE_M,
    specialInstructions: (id) =>
      `Should ${id} dive straight into the intruder and self-destruct now? The blast hurts the intruder badly but destroys ${id}.`,
  },
  hound: {
    noun: "Hound",
    body: "a four-legged armored robot with a chin gun and a bite",
    hullWord: "Armor",
    orderName: "tactic",
    orders: HOUND_TACTICS,
    orderInstructions: (id) =>
      `Which tactic should ${id} follow for the next few seconds? Weigh its armor, the distance, the intruder's health and what they are doing, where they are looking, and what the rest of the squad is doing.`,
    specialName: "charge",
    special: (s) => s.specialReady && s.sees && s.distanceM <= CHARGE_MAX_DISTANCE_M,
    specialInstructions: (id) =>
      `Should ${id} sprint at the intruder and bite right now? The bite hurts far more than its gun, but ${id} takes fire on the way in.`,
  },
};

export const MACHINE_KINDS = Object.keys(KINDS);

// ---------------------------------------------------------------------------
// Validation helpers

const MOTIONS = ["still", "walking", "sprinting"];
const VIEWS = ["front", "side", "behind"];
const GUNS = ["ready", "cooling", "firing"];
const SIDES = ["same", "flank", "opposite"];

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function num(value, min, max, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function int(value, min, max, fallback) {
  return Math.round(num(value, min, max, fallback));
}

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function unitId(value, kind) {
  const prefix = kind === "gull" ? "G" : "H";
  return typeof value === "string" && new RegExp(`^${prefix}-\\d{1,3}$`).test(value) ? value : `${prefix}-?`;
}

function readMate(raw) {
  if (!isObject(raw)) return null;
  const kind = oneOf(raw.kind, MACHINE_KINDS, null);
  if (!kind) return null;
  return {
    kind,
    id: unitId(raw.id, kind),
    order: oneOf(raw.order, Object.keys(KINDS[kind].orders), null),
    distanceM: num(raw.distanceM, 0, 200, 20),
    side: oneOf(raw.side, SIDES, "flank"),
  };
}

/** Validate and clamp one machine's snapshot from the browser. */
export function normalizeSnapshot(kind, raw) {
  const k = KINDS[kind];
  if (!k) throw new TypeError(`Unknown machine kind: ${kind}`);
  if (!isObject(raw)) throw new TypeError(`${k.noun} state must be a JSON object`);
  const target = isObject(raw.target) ? raw.target : {};
  const mission = isObject(raw.mission) ? raw.mission : {};
  const relaysTotal = int(mission.relaysTotal, 1, 6, 3);
  return {
    id: unitId(raw.id, kind),
    hull: num(raw.hull, 0, 1, 1),
    distanceM: num(raw.distanceM, 0, 200, 20),
    heightM: num(raw.heightM, -60, 60, 0),
    sees: raw.sees === true,
    lostSightS: num(raw.lostSightS, 0, 600, 0),
    view: oneOf(raw.view, VIEWS, "front"),
    gun: oneOf(raw.gun, GUNS, "ready"),
    hitAgoS: num(raw.hitAgoS, 0, 600, null),
    atCover: raw.atCover === true,
    order: oneOf(raw.order, Object.keys(k.orders), null),
    orderAgoS: num(raw.orderAgoS, 0, 600, 0),
    target: {
      health: num(target.health, 0, 1, 1),
      motion: oneOf(target.motion, MOTIONS, "still"),
      crouched: target.crouched === true,
      reloading: target.reloading === true,
      aiming: target.aiming === true,
    },
    squad: Array.isArray(raw.squad) ? raw.squad.slice(0, 6).map(readMate).filter(Boolean) : [],
    others: int(raw.others, 0, 40, 0),
    lossAgoS: num(raw.lossAgoS, 0, 600, null),
    relaysCut: int(mission.relaysCut, 0, relaysTotal, 0),
    relaysTotal,
    // The browser says when the special move is unavailable (already ramming, charge cooling down).
    specialReady: raw.specialReady !== false,
  };
}

// ---------------------------------------------------------------------------
// Situation text

const pct = (x) => `${Math.round(x * 100)}%`;
const secs = (x) => `${x.toFixed(1)} s`;

function selfLine(k, s) {
  const parts = [`You decide for ${k.noun} ${s.id}, ${k.body}.`];
  parts.push(`${k.hullWord} ${pct(s.hull)}${s.hull <= 0.5 ? " (damaged, smoking)" : ""}.`);
  const distance = Math.round(s.distanceM);
  if (k === KINDS.gull) {
    const h = Math.round(s.heightM);
    const height = h > 0 ? `${h} m above the intruder` : h < 0 ? `${-h} m below the intruder` : "level with the intruder";
    parts.push(`It flies ${height}, ${distance} m away.`);
  } else {
    parts.push(`It is ${distance} m from the intruder, ${s.atCover ? "at a spot behind cover" : "in the open"}.`);
    if (Math.abs(s.heightM) >= 2) {
      parts.push(`The intruder is ${Math.round(Math.abs(s.heightM))} m ${s.heightM < 0 ? "above" : "below"} it.`);
    }
  }
  parts.push({ ready: "Gun ready to fire.", cooling: "Gun cooling down.", firing: "Firing a burst." }[s.gun]);
  if (s.hitAgoS !== null && s.hitAgoS <= 10) parts.push(`Last hit ${secs(s.hitAgoS)} ago.`);
  parts.push(s.order ? `Current ${k.orderName}: ${s.order} (chosen ${secs(s.orderAgoS)} ago).` : `No ${k.orderName} chosen yet.`);
  return parts.join(" ");
}

function intruderLine(s) {
  const t = s.target;
  const doing = [{ still: "standing still", walking: "on the move", sprinting: "sprinting" }[t.motion]];
  if (t.crouched) doing.push("crouched");
  if (t.aiming) doing.push("aiming down the sights");
  if (t.reloading) doing.push("reloading");
  const sight = s.sees
    ? `${s.id} has a clear line of sight to the intruder.`
    : `${s.id} lost sight of the intruder ${secs(s.lostSightS)} ago and is heading for the last known position.`;
  const view = {
    front: `The intruder is facing ${s.id}.`,
    side: `${s.id} is off to the intruder's side.`,
    behind: `${s.id} is behind the intruder, who is looking away.`,
  }[s.view];
  return `Intruder: health ${pct(t.health)}, ${doing.join(", ")}. ${sight} ${view}`;
}

function squadLine(s) {
  const sideText = { same: `on the same side as ${s.id}`, flank: "off to one side", opposite: "on the opposite side" };
  const mates = s.squad.map((m) => {
    const order = m.order ?? "no orders yet";
    return `${KINDS[m.kind].noun} ${m.id} (${order}, ${Math.round(m.distanceM)} m from the intruder, ${sideText[m.side]})`;
  });
  const engaged = mates.length ? `Squad also engaging: ${mates.join("; ")}.` : "No other machine is engaging the intruder.";
  const others = s.others ? ` ${s.others} more machine${s.others === 1 ? " is" : "s are"} searching or on patrol.` : "";
  return engaged + others;
}

function missionLine(s) {
  return s.relaysCut >= s.relaysTotal
    ? `Mission: the intruder has cut all ${s.relaysTotal} uplink relays and is running for the extraction boat.`
    : `Mission: the intruder has cut ${s.relaysCut} of ${s.relaysTotal} uplink relays.`;
}

// ---------------------------------------------------------------------------
// Requests and answers

/** `{ state, questions }` for one machine, from its (untrusted) browser snapshot. */
export function buildRequest(kind, raw) {
  const k = KINDS[kind];
  const s = normalizeSnapshot(kind, raw);
  const lines = [
    "Night, heavy rain, Saltline container terminal. The port's security machines are hunting one armed human intruder.",
    selfLine(k, s),
    intruderLine(s),
    squadLine(s),
  ];
  if (s.lossAgoS !== null && s.lossAgoS <= 20) lines.push(`A squadmate was destroyed ${Math.round(s.lossAgoS)} s ago.`);
  lines.push(missionLine(s));

  const questions = {
    [k.orderName]: { type: "choice", instructions: k.orderInstructions(s.id), criteria: k.orders },
    aggression: { type: "score", instructions: `How hard should ${s.id} shoot right now?`, criteria: AGGRESSION_LEVELS },
  };
  if (k.special(s)) questions[k.specialName] = { type: "noul", instructions: k.specialInstructions(s.id) };
  return { state: lines.join("\n"), questions };
}

/** Compact the typed answers: `{ order, aggression, special }` (null when missing or not asked). */
export function parseDecision(kind, result) {
  const k = KINDS[kind];
  return {
    order: readChoice(result.answers[k.orderName], Object.keys(k.orders)),
    aggression: readScore(result.answers.aggression, AGGRESSION_LEVELS.length),
    special: readNoul(result.answers[k.specialName]),
  };
}
