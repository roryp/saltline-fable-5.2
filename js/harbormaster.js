// Harbormaster: hands every engaged Gull (drone) and Hound (robot dog) to Microsoft-Decision-1.1.
//
// Every 1.3-2.1 s an engaged machine sends its situation to the game server (/api/gull, /api/hound),
// which asks the model three typed questions: a `choice` (Gull maneuver / Hound tactic), a `score`
// (how hard to shoot) and a `noul` (Gull: ram and self-destruct? Hound: charge and bite?). The game's
// own AI still flies, walks, aims and shoots; the answers steer it. Without the server, or when a call
// fails, the built-in AI carries on unchanged.

import {
  CHARGE_THRESHOLD,
  HOUND_RANGES,
  RAM_THRESHOLD,
  angleAround,
  cooldownScale,
  crossfireAngle,
  gullOrbit,
  holdsFire,
  sideOf,
  spotCost,
  viewAngle,
  viewOf,
  wrapAngle,
} from "./tactics.js";
import { installTouchAim } from "./touch-aim.js";

const DECISION_MS = [1300, 2100]; // per machine, while it is engaging
const ORDER_TTL_MS = 5000; // without a fresh answer, the built-in AI takes over again
const MAX_PENDING = 8;
const REQUEST_TIMEOUT_MS = 5000;
const RAM_TIMEOUT_MS = 7000;
const RAM_BLAST = { radius: 4, damage: 60 };
const CHARGE_MS = 3000;
const CHARGE_COOLDOWN_MS = 6000;

const ORDERS = {
  gull: { circle: ["↻", "Circle", "calm"], crossfire: ["✕", "Crossfire", "tactic"], dive: ["▼", "Dive", "hot"], climb: ["▲", "Climb", "cool"] },
  hound: {
    cover: ["■", "Cover", "calm"],
    flank: ["↪", "Flank", "tactic"],
    crossfire: ["✕", "Crossfire", "tactic"],
    hold: ["●", "Hold", "calm"],
    fall_back: ["▽", "Fall back", "cool"],
  },
};
const SPECIALS = { gull: ["✖", "Ram", "ram"], hound: ["»", "Charge", "charge"] };
const AGGRESSION = ["Hold fire", "Cautious", "Steady", "Aggressive", "Relentless"];
const VIEWS = ["all", "tags", "off"];
const VIEW_MESSAGES = { all: "AI tags and panel on", tags: "AI panel off", off: "AI tags off" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const hdist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function waitForGame() {
  // Boot takes a while on slow GPUs; the showcase pages (?show=...) have no real enemies.
  // Wait for the first frames too: the shader warm-up blocks the main thread for seconds.
  for (let i = 0; i < 1500; i++) {
    const G = window.__G;
    if (window.__fatal || G?.showcase) return null;
    if (window.__ready && G?.game && G.enemies?.debug?.ctx && G.hud?.root && G.player && G.render) return G;
    await sleep(200);
  }
  return null;
}

async function fetchStatus() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("/api/status", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (res.ok) return await res.json();
      if (res.status === 404) break; // a plain static server: no model API
    } catch {
      // Busy or restarting: try again.
    }
    await sleep(1500);
  }
  return { configured: false };
}

class Harbormaster {
  constructor(G, status) {
    this.G = G;
    this.ctx = G.enemies.debug.ctx;
    this.tune = G.enemies.TUNE;
    this.online = status.configured === true;
    this.model = status.model ?? "Microsoft-Decision-1.1";
    this.minds = new Map(); // machine -> mind; machines are pooled, so this stays small
    this.tags = new Map();
    this.pending = 0;
    this.failures = 0;
    this.downUntil = 0;
    this.lastError = null;
    this.lastLossAt = -Infinity;
    this.stats = { calls: 0, errors: 0, totalMs: 0, lastMs: 0, tokens: 0, rams: 0, charges: 0 };
    this.mission = { calls: 0, totalMs: 0 };
    this.panelAt = 0;
    this.v3 = new G.THREE.Vector3();
    let view = "all";
    try {
      view = localStorage.getItem("saltline.aiView") ?? view;
    } catch {
      // Storage blocked: keep the default.
    }
    this.view = VIEWS.includes(view) ? view : "all";
  }

  install() {
    const { G } = this;
    // The Hound's patched fire-position picker asks here first (see README, "What changed").
    this.ctx.brain = { firePos: (unit, player, out) => this.houndSpot(unit, player, out) };

    const update = G.enemies.update.bind(G.enemies);
    G.enemies.update = (dt) => {
      const step = Math.min(dt, 0.05);
      if (step > 0) this.before(step);
      update(dt);
      if (step > 0) this.after();
    };
    const frame = G.render.frame.bind(G.render);
    G.render.frame = (dt) => {
      frame(dt);
      this.draw();
    };

    G.events.on("enemy:hit", (e) => {
      const mind = this.minds.get(e?.enemy);
      if (mind) mind.lastHitAt = performance.now();
    });
    G.events.on("enemy:killed", () => {
      this.lastLossAt = performance.now();
    });
    G.events.on("game:state", (e) => this.onState(e?.state, e?.prev));
    addEventListener("keydown", (e) => this.onKey(e));
    this.buildUi();
  }

  // ---- per frame, before the game's enemy update ------------------------------------------

  before(dt) {
    const now = performance.now();
    const player = this.G.player;
    const blasts = [];
    for (const unit of this.G.enemies.list) {
      if (!unit.alive || unit.passive) continue;
      const mind = this.mindOf(unit);
      if (unit.mode !== "engage") {
        if (mind.order) this.clear(unit, mind);
        continue;
      }
      if (mind.order && now - mind.decidedAt > ORDER_TTL_MS) this.clear(unit, mind);
      if (!mind.pending && now >= mind.nextAt && this.canAsk(now)) this.ask(unit, mind);
      if (unit.type === "gull") this.steerGull(unit, mind, dt, now, player, blasts);
      else this.driveHound(unit, mind, now);
    }
    for (const unit of blasts) this.detonate(unit);
  }

  // After the update: scale the cooldown the game just set after a burst by the model's aggression.
  after() {
    for (const unit of this.G.enemies.list) {
      const mind = this.minds.get(unit);
      if (!mind || mind.spawnId !== unit.id) continue;
      const state = unit.type === "gull" ? unit.atk : unit.es;
      if (mind.prevGun === "burst" && state !== "burst" && mind.order && mind.aggression !== null) {
        unit.cool *= cooldownScale(mind.aggression);
      }
      mind.prevGun = state;
    }
  }

  canAsk(now) {
    return this.online && now >= this.downUntil && this.pending < MAX_PENDING && this.G.game.state === "playing";
  }

  mindOf(unit) {
    let mind = this.minds.get(unit);
    if (!mind || mind.spawnId !== unit.id) {
      mind = {
        spawnId: unit.id,
        label: this.label(unit),
        pending: false,
        nextAt: 0,
        order: null,
        orderAt: 0,
        decidedAt: 0,
        dist: null,
        aggression: null,
        special: null,
        orbit: null,
        ram: false,
        ramAt: 0,
        charge: false,
        chargeUntil: 0,
        chargeReadyAt: 0,
        replanAt: 0,
        latencyMs: null,
        lastHitAt: -Infinity,
        prevGun: null,
      };
      this.minds.set(unit, mind);
    }
    return mind;
  }

  // The stencil painted on each machine: G-11 to G-20, H-03 to H-10.
  label(unit) {
    const { gulls, hounds } = this.G.enemies.debug;
    return unit.type === "gull"
      ? `G-${gulls.indexOf(unit) + 11}`
      : `H-${String(hounds.indexOf(unit) + 3).padStart(2, "0")}`;
  }

  clear(unit, mind) {
    Object.assign(mind, { order: null, dist: null, aggression: null, special: null, orbit: null, ram: false, charge: false });
    if (unit.type === "hound") unit.burstsWanted = 0;
  }

  // ---- asking the model ----------------------------------------------------------------------

  async ask(unit, mind) {
    mind.pending = true;
    this.pending++;
    const started = performance.now();
    try {
      const res = await fetch(`/api/${unit.type}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.snapshot(unit, mind)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
      const ms = Math.round(performance.now() - started);
      this.failures = 0;
      this.lastError = null;
      this.stats.calls++;
      this.stats.totalMs += ms;
      this.stats.lastMs = ms;
      this.stats.tokens += data.inputTokens ?? 0;
      this.mission.calls++;
      this.mission.totalMs += ms;
      // The machine may have died, or been respawned as a new one, while the model was thinking.
      if (this.minds.get(unit) === mind && unit.alive && unit.mode === "engage") this.apply(unit, mind, data, ms);
    } catch (err) {
      this.stats.errors++;
      this.failures++;
      this.lastError = err?.name === "TimeoutError" ? "request timed out" : err?.message || "request failed";
      if (err?.status === 503 || this.failures >= 4) this.downUntil = performance.now() + 8000;
    } finally {
      mind.pending = false;
      this.pending--;
      mind.nextAt = performance.now() + DECISION_MS[0] + Math.random() * (DECISION_MS[1] - DECISION_MS[0]);
    }
  }

  snapshot(unit, mind) {
    const { G } = this;
    const player = G.player;
    const now = performance.now();
    const squad = [];
    let others = 0;
    for (const other of G.enemies.list) {
      if (other === unit || !other.alive || other.passive) continue;
      if (other.mode !== "engage") {
        others++;
        continue;
      }
      squad.push({
        kind: other.type,
        id: this.mindOf(other).label,
        order: this.minds.get(other)?.order ?? null,
        distanceM: round1(hdist(other.pos, player.pos)),
        side: sideOf(player.pos, unit.pos, other.pos),
      });
    }
    squad.sort((a, b) => a.distanceM - b.distanceM);
    const speed = Math.hypot(player.vel?.x ?? 0, player.vel?.z ?? 0);
    const weapon = G.weapon ?? {};
    const run = G.game.run ?? {};
    const ago = (t) => (now - t < 600_000 ? round1((now - t) / 1000) : null);
    return {
      id: mind.label,
      hull: round2(unit.hp / this.tune[unit.type].hp),
      distanceM: round1(hdist(unit.pos, player.pos)),
      heightM: round1(unit.pos.y - player.pos.y),
      sees: unit.los === true,
      lostSightS: round1(unit.noSeeT ?? 0),
      view: viewOf(player.forward, player.pos, unit.pos),
      gun: this.gunState(unit),
      hitAgoS: ago(mind.lastHitAt),
      atCover: unit.type === "hound" && this.nearCover(unit.pos),
      order: mind.order,
      orderAgoS: mind.order ? round1((now - mind.orderAt) / 1000) : 0,
      target: {
        health: round2((player.health ?? 100) / (player.maxHealth || 100)),
        motion: speed < 0.6 ? "still" : player.sprinting || speed > 5 ? "sprinting" : "walking",
        crouched: Boolean(player.crouching),
        reloading: weapon.state === "reloading",
        aiming: (weapon.ads ?? player.ads ?? 0) > 0.5,
      },
      squad: squad.slice(0, 6),
      others,
      lossAgoS: ago(this.lastLossAt),
      mission: { relaysCut: run.cut ?? 0, relaysTotal: run.relays?.length || 3 },
      // Don't ask about a ram or charge that can't happen right now.
      specialReady: unit.type === "gull" ? !mind.ram : !mind.charge && now >= mind.chargeReadyAt,
    };
  }

  gunState(unit) {
    const firing = unit.type === "gull" ? unit.atk !== "idle" : unit.es === "tele" || unit.es === "burst";
    return firing ? "firing" : unit.cool > 0 ? "cooling" : "ready";
  }

  nearCover(pos) {
    for (const c of this.G.level?.coverPoints ?? []) if (hdist(c, pos) < 1.6) return true;
    return false;
  }

  squadAngles(unit) {
    const center = this.G.player.pos;
    return this.G.enemies.list
      .filter((u) => u !== unit && u.alive && !u.passive && u.mode === "engage")
      .map((u) => angleAround(center, u.pos));
  }

  apply(unit, mind, data, ms) {
    const now = performance.now();
    const choice = data.order?.choice ?? null;
    const changed = Boolean(choice) && choice !== mind.order;
    if (changed) mind.orderAt = now;
    if (choice) mind.order = choice;
    mind.dist = data.order?.probabilities ?? null;
    mind.aggression = data.aggression?.score ?? null;
    // While a ram or charge is under way the model isn't asked again: keep the probability that started it.
    mind.special = data.special?.probability ?? (mind.ram || mind.charge ? mind.special : null);
    mind.latencyMs = ms;
    mind.decidedAt = now;
    if (!mind.order) return; // the model refused: the built-in AI keeps going

    const player = this.G.player;
    if (unit.type === "gull") {
      const tune = this.tune.gull;
      mind.orbit = gullOrbit(mind.order, {
        angle: angleAround(player.pos, unit.pos),
        lookAngle: Math.atan2(player.forward.z, player.forward.x),
        squadAngles: this.squadAngles(unit),
        rangeMin: tune.rangeMin,
        rangeMax: tune.rangeMax,
        altMin: tune.altMin,
        altMax: tune.altMax,
      });
      unit.orbitDir = mind.orbit.orbitDir;
      if (!mind.ram && mind.special !== null && mind.special >= RAM_THRESHOLD) {
        mind.ram = true;
        mind.ramAt = now;
        this.stats.rams++;
        this.G.hud.warn?.(`${mind.label} ramming`, 1.8);
      }
    } else {
      unit.burstsWanted = mind.order === "hold" ? 3 : mind.order === "flank" || mind.order === "fall_back" ? 1 : 0;
      const charge = mind.special !== null && mind.special >= CHARGE_THRESHOLD;
      if (charge && !mind.charge && now >= mind.chargeReadyAt) {
        mind.charge = true;
        mind.chargeUntil = now + CHARGE_MS;
        mind.replanAt = now + 600;
        this.stats.charges++;
        unit._replan?.();
      } else if (changed && !mind.charge) {
        unit._replan?.();
      }
    }
  }

  // ---- carrying out the orders -----------------------------------------------------------------

  steerGull(unit, mind, dt, now, player, blasts) {
    if (!mind.order) return;
    unit.flipT = Math.max(unit.flipT, 1); // the model, not a coin flip, picks the orbit now
    if (mind.ram) {
      const k = 1 - Math.exp(-4 * dt);
      unit.orbitR += (0.6 - unit.orbitR) * k;
      unit.alt += (0.3 - unit.alt) * k;
      unit.cool = Math.max(unit.cool, 0.5);
      const reach = Math.hypot(unit.pos.x - player.pos.x, unit.pos.y - (player.pos.y + 1.1), unit.pos.z - player.pos.z);
      if (reach < 2.3 && player.alive !== false) blasts.push(unit);
      else if (now - mind.ramAt > RAM_TIMEOUT_MS) mind.ram = false;
      return;
    }
    if (!mind.orbit) return;
    const k = 1 - Math.exp(-1.5 * dt);
    unit.orbitR += (mind.orbit.orbitR - unit.orbitR) * k;
    unit.alt += (mind.orbit.alt - unit.alt) * k;
    // Swing round faster than the game's idle drift when circling or setting up a crossfire.
    if ((mind.order === "circle" || mind.order === "crossfire") && unit.atk === "idle" && unit.noSeeT < 1.5) {
      unit.orbitA += unit.orbitDir * 0.3 * dt;
    }
    if (mind.aggression !== null && holdsFire(mind.aggression) && unit.atk === "idle") unit.cool = Math.max(unit.cool, 0.3);
  }

  detonate(unit) {
    const { G } = this;
    const pos = unit.pos.clone();
    const mind = this.minds.get(unit);
    // Retire the Gull before the blast, so the blast doesn't count it as a kill for the player.
    this.ctx.releaseToken(unit);
    this.ctx.retire(unit);
    this.lastLossAt = performance.now();
    if (mind) mind.ram = false;
    G.fx.explosion?.(pos, 1.6);
    G.fx.debris?.(pos, { count: 6 });
    G.combat.explode?.(pos, RAM_BLAST.radius, RAM_BLAST.damage, "enemy");
    G.hud.feed?.(`<b>${escapeHtml(mind?.label ?? "GULL")}</b> self-destructed`);
  }

  driveHound(unit, mind, now) {
    if (!mind.order) return;
    if (mind.aggression !== null && holdsFire(mind.aggression) && unit.es !== "tele" && unit.es !== "burst") {
      unit.cool = Math.max(unit.cool, 0.3);
    }
    if (!mind.charge) return;
    // One bite per charge: after the lunge, or after a few seconds, the model's tactic takes over again.
    if (now > mind.chargeUntil || unit.es === "wind" || unit.es === "lunge" || unit.es === "recover") {
      if (unit.es !== "wind" && unit.es !== "lunge") {
        mind.charge = false;
        mind.chargeReadyAt = now + CHARGE_COOLDOWN_MS;
      }
      return;
    }
    if (unit.es === "move" || unit.es === "aim" || unit.es === "cool") {
      if (unit.es === "move") unit.moveT = 0; // keep running instead of stopping to shoot
      if (now >= mind.replanAt) {
        mind.replanAt = now + 600;
        unit._replan?.(); // head for the intruder, and follow them as they move
      }
    }
  }

  // Called by the game whenever a Hound picks a new firing spot. Returns false to let the game decide.
  houndSpot(unit, player, out) {
    const mind = this.minds.get(unit);
    if (!mind || mind.spawnId !== unit.id || !mind.order) return false;
    const { physics, level, enemies, THREE } = this.G;
    const nav = physics.nav;
    if (mind.charge) {
      const dx = unit.pos.x - player.pos.x;
      const dz = unit.pos.z - player.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      let x = player.pos.x + (dx / d) * 1.1;
      let z = player.pos.z + (dz / d) * 1.1;
      if (nav.isWalkable && !nav.isWalkable(x, z)) ({ x, z } = player.pos);
      out.set(x, physics.groundHeight(x, z, player.pos.y + 1), z);
      return true;
    }

    const tactic = mind.order;
    const [minR, maxR] = HOUND_RANGES[tactic];
    const eye = player.eye || player.pos;
    const hasLos = (p) => physics.lineOfSight(this.v3.set(p.x, p.y + 0.95, p.z), eye);
    if (tactic === "hold" && hdist(unit.pos, player.pos) >= minR && hasLos(unit.pos)) {
      out.copy(unit.pos);
      return true;
    }

    const look = Math.atan2(player.forward.z, player.forward.x);
    const here = angleAround(player.pos, unit.pos);
    const cross = tactic === "crossfire" ? crossfireAngle(this.squadAngles(unit)) : null;
    const spots = [];
    const consider = (p, cover) => {
      const dist = hdist(p, player.pos);
      if (dist < minR || dist > maxR || (nav.isWalkable && !nav.isWalkable(p.x, p.z))) return;
      let crowd = 0;
      for (const u of enemies.list) {
        if (u === unit || !u.alive || u.type !== "hound") continue;
        if (hdist(u.es === "move" ? u.firePos : u.pos, p) < 3) crowd++;
      }
      const c = {
        dist,
        travel: hdist(p, unit.pos),
        cover,
        los: true,
        view: viewAngle(player.forward, player.pos, p),
        cross: cross === null ? null : Math.abs(wrapAngle(angleAround(player.pos, p) - cross)),
        crowd,
      };
      spots.push({ p, c, base: spotCost(tactic, c) });
    };

    for (const c of level?.coverPoints ?? []) consider(c, true);
    for (let i = 0; i < 8; i++) {
      const p = nav.randomPoint?.(player.pos, Math.min(maxR, 26));
      if (p) consider(p, false);
    }
    const ring =
      tactic === "flank"
        ? [look + 1.75, look - 1.75, look + 2.45, look - 2.45, look + Math.PI]
        : cross !== null
          ? [cross, cross + 0.45, cross - 0.45, cross + 0.9, cross - 0.9]
          : [here, here + 0.5, here - 0.5, here + 1, here - 1];
    const mid = (minR + Math.min(maxR, 26)) / 2;
    for (const a of ring) {
      for (const r of [mid - 2, mid + 2]) {
        const x = player.pos.x + Math.cos(a) * r;
        const z = player.pos.z + Math.sin(a) * r;
        consider(new THREE.Vector3(x, physics.groundHeight(x, z, player.pos.y + 1), z), false);
      }
    }

    // Cheapest first; only check line of sight while a spot can still win.
    spots.sort((a, b) => a.base - b.base);
    let best = null;
    let bestCost = Infinity;
    for (const s of spots) {
      if (s.base >= bestCost) break;
      const cost = hasLos(s.p) ? s.base : spotCost(tactic, { ...s.c, los: false });
      if (cost < bestCost) {
        bestCost = cost;
        best = s.p;
      }
    }
    if (!best) return false;
    out.set(best.x, best.y, best.z);
    return true;
  }

  // ---- UI ------------------------------------------------------------------------------------------

  buildUi() {
    const root = this.G.hud.root;
    const tags = document.createElement("div");
    tags.className = "hm-tags";
    const panel = document.createElement("div");
    panel.className = "hm-panel";
    root.append(tags, panel);
    this.ui = { tags, panel };

    const note = document.querySelector(".m-title .m-note");
    if (note) {
      const line = document.createElement("p");
      line.className = "m-note hm-note";
      line.textContent = this.online
        ? `The Harbormaster's Gulls and Hounds think with ${this.model.replace(/ \(.*\)$/, "")}.`
        : "Model server offline: the Gulls and Hounds use the built-in AI.";
      note.after(line);
    }
    // List the T key with the game's own controls, and the AI button with the touch controls.
    const [keys, touchKeys] = document.querySelectorAll('[data-pane="controls"] dl.keys');
    keys?.insertAdjacentHTML("beforeend", "<div><dt>AI tags and panel</dt><dd><kbd>T</kbd></dd></div>");
    touchKeys?.insertAdjacentHTML("beforeend", "<div><dt>AI tags and panel</dt><dd>AI, at the top</dd></div>");
    const legend = document.querySelector(".m-legend > div");
    if (legend) legend.insertAdjacentHTML("beforeend", "<span><kbd>T</kbd> AI tags</span>");
  }

  // The game builds its touch controls on the first touch; the AI button joins them, so it shows and hides with them.
  addTouchButton() {
    const controls = document.querySelector("#ui > .touch");
    if (!controls) return;
    const button = document.createElement("button");
    button.className = "t-btn hm-ai";
    button.setAttribute("aria-label", "AI tags and panel");
    button.dataset.view = this.view;
    button.innerHTML = "<span>AI</span>";
    button.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.cycleView();
      },
      { passive: false },
    );
    button.addEventListener("click", () => this.cycleView());
    controls.append(button);
    this.ui.aiButton = button;
  }

  onKey(e) {
    if (e.code !== "KeyT" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target?.tagName)) return;
    this.cycleView();
  }

  cycleView() {
    this.view = VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length];
    try {
      localStorage.setItem("saltline.aiView", this.view);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    this.G.hud.message?.(VIEW_MESSAGES[this.view], 1.6);
    this.panelAt = 0;
    if (this.ui.aiButton) this.ui.aiButton.dataset.view = this.view;
  }

  onState(state, prev) {
    if (state === "intro" || (state === "playing" && prev !== "paused")) this.mission = { calls: 0, totalMs: 0 };
    if (state === "dead" || state === "complete") this.writeDebrief();
  }

  writeDebrief() {
    const avg = this.mission.calls ? Math.round(this.mission.totalMs / this.mission.calls) : 0;
    const value = this.online ? `${this.mission.calls}${this.mission.calls ? ` <small>~${avg} ms</small>` : ""}` : "Built-in AI";
    for (const list of document.querySelectorAll(".m-dead .m-stats, .m-debrief .m-stats")) {
      let row = list.querySelector(".hm-stat");
      if (!row) {
        row = document.createElement("div");
        row.className = "hm-stat";
        row.innerHTML = "<dt>Model decisions</dt><dd></dd>";
        list.append(row);
      }
      row.querySelector("dd").innerHTML = value;
    }
  }

  draw() {
    if (!this.ui) return;
    if (!this.ui.aiButton && this.G.input?.touch) this.addTouchButton();
    const playing = this.G.game.state === "playing";
    this.ui.tags.hidden = !playing || this.view === "off";
    if (!this.ui.tags.hidden) this.drawTags();
    const now = performance.now();
    if (now >= this.panelAt) {
      this.panelAt = now + 200;
      this.ui.panel.hidden = !playing || this.view !== "all";
      if (!this.ui.panel.hidden) this.drawPanel(now);
    }
  }

  orderLook(unit, mind) {
    if (mind.ram || mind.charge) {
      const [glyph, text] = SPECIALS[unit.type];
      return { glyph, text, tone: "alarm" };
    }
    const [glyph, text, tone] = ORDERS[unit.type][mind.order];
    return { glyph, text, tone };
  }

  drawTags() {
    const { G } = this;
    const width = this.ui.tags.clientWidth;
    const height = this.ui.tags.clientHeight;
    const shown = new Set();
    for (const unit of G.enemies.list) {
      const mind = this.minds.get(unit);
      // Only machines the intruder can see: the tags must never work as a wallhack.
      if (!mind || mind.spawnId !== unit.id || !mind.order || !unit.alive || unit.mode !== "engage" || !unit.los) continue;
      const p = this.v3.set(unit.pos.x, unit.pos.y + (unit.type === "gull" ? 0.55 : 1.45), unit.pos.z).project(G.camera);
      if (p.z > 1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05) continue;
      let tag = this.tags.get(unit);
      if (!tag) {
        tag = { el: document.createElement("div"), key: "" };
        this.ui.tags.append(tag.el);
        this.tags.set(unit, tag);
      }
      const look = this.orderLook(unit, mind);
      const holding = mind.aggression !== null && holdsFire(mind.aggression);
      const key = `${mind.label}|${look.text}|${look.tone}|${holding}`;
      if (tag.key !== key) {
        tag.key = key;
        tag.el.className = `hm-tag tone-${look.tone}${holding ? " holdfire" : ""}`;
        tag.el.innerHTML = `<small>${mind.label}</small><i>${look.glyph}</i>${look.text}${holding ? "<em>hold fire</em>" : ""}`;
      }
      tag.el.hidden = false;
      // Keep tags of machines at the edge of the view on screen.
      const x = Math.min(width - 70, Math.max(70, ((p.x + 1) / 2) * width));
      const y = Math.min(height - 8, Math.max(30, ((1 - p.y) / 2) * height));
      tag.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      shown.add(unit);
    }
    for (const [unit, tag] of this.tags) if (!shown.has(unit)) tag.el.hidden = true;
  }

  drawPanel(now) {
    const s = this.stats;
    let status;
    if (!this.online) status = '<span class="hm-off">built-in AI · no model server</span>';
    else if (now < this.downUntil) status = `<span class="hm-off">model unreachable · built-in AI</span>`;
    else status = `${s.calls ? `${Math.round(s.totalMs / s.calls)} ms` : "ready"} · ${s.calls} decisions`;

    const rows = [];
    for (const unit of this.G.enemies.list) {
      const mind = this.minds.get(unit);
      if (!mind || mind.spawnId !== unit.id || !mind.order || !unit.alive || unit.mode !== "engage") continue;
      rows.push({ unit, mind });
    }
    rows.sort((a, b) => a.mind.label.localeCompare(b.mind.label));

    const body = rows.slice(0, 6).map(({ unit, mind }) => {
      const look = this.orderLook(unit, mind);
      const options = ORDERS[unit.type];
      const bar = Object.keys(options)
        .map((key) => {
          const p = mind.dist?.[key] ?? 0;
          return p > 0.01 ? `<i class="tone-${options[key][2]}${key === mind.order ? " on" : ""}" style="width:${(p * 100).toFixed(1)}%"></i>` : "";
        })
        .join("");
      const aggr = mind.aggression;
      const aggrText = aggr === null ? "–" : AGGRESSION[Math.round(aggr)];
      const [, specialText, specialKey] = SPECIALS[unit.type];
      const threshold = unit.type === "gull" ? RAM_THRESHOLD : CHARGE_THRESHOLD;
      const special =
        mind.special === null
          ? `<span class="hm-sp dim">${specialKey} –</span>`
          : `<span class="hm-sp${mind.special >= threshold ? " hot" : ""}" title="noul: ${specialText.toLowerCase()} (threshold ${threshold})"><u style="width:${(mind.special * 100).toFixed(0)}%"></u><s style="left:${threshold * 100}%"></s>${specialKey} ${mind.special.toFixed(2)}</span>`;
      return `<div class="hm-row">
          <b>${mind.label}</b>
          <span class="hm-order tone-${look.tone}">${look.glyph} ${look.text}</span>
          <span class="hm-dist" title="choice: probabilities">${bar}</span>
          <span class="hm-aggr" title="score: aggression ${aggr === null ? "–" : aggr.toFixed(2)} of 4"><u style="width:${aggr === null ? 0 : (aggr / 4) * 100}%"></u>${aggrText}</span>
          ${special}
        </div>`;
    });
    const empty = this.online ? '<div class="hm-empty">No machine is engaging you</div>' : "";
    this.ui.panel.innerHTML = `<div class="hm-head"><b>Harbormaster</b><span>${escapeHtml(this.model.replace(/ \(.*\)$/, ""))}</span></div>
      <div class="hm-status">${status}</div><div class="hm-rows">${body.join("") || empty}</div>`;
  }
}

const G = await waitForGame();
if (G) {
  installTouchAim(G);
  const brain = new Harbormaster(G, await fetchStatus());
  brain.install();
  window.__harbormaster = brain;
}
