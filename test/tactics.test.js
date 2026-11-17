import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cooldownScale, crossfireAngle, gullOrbit, holdsFire, sideOf, spotCost, viewOf, wrapAngle } from "../js/tactics.js";

const at = (x, z) => ({ x, y: 0, z });
const intruder = at(0, 0);
const facingEast = { x: 1, z: 0 };

describe("tactics", () => {
  it("tells where a machine is relative to the intruder's view and to a squadmate", () => {
    assert.equal(viewOf(facingEast, intruder, at(10, 1)), "front");
    assert.equal(viewOf(facingEast, intruder, at(0, 10)), "side");
    assert.equal(viewOf(facingEast, intruder, at(-10, 0)), "behind");
    assert.equal(sideOf(intruder, at(10, 0), at(9, 2)), "same");
    assert.equal(sideOf(intruder, at(10, 0), at(0, -10)), "flank");
    assert.equal(sideOf(intruder, at(10, 0), at(-10, 1)), "opposite");
  });

  it("aims a crossfire opposite the squad", () => {
    assert.ok(Math.abs(wrapAngle(crossfireAngle([0.1, -0.1]) - Math.PI)) < 1e-9);
    assert.equal(crossfireAngle([]), null);
  });

  it("flies a Gull away from the intruder's sight line, close for a dive and high and wide for a climb", () => {
    const ctx = { angle: 0.3, lookAngle: 0, squadAngles: [], orbitDir: -1, rangeMin: 12, rangeMax: 25, altMin: 4, altMax: 8 };
    assert.equal(gullOrbit("circle", ctx).orbitDir, 1);
    assert.equal(gullOrbit("circle", { ...ctx, angle: -0.3 }).orbitDir, -1);
    const dive = gullOrbit("dive", ctx);
    const climb = gullOrbit("climb", ctx);
    assert.ok(dive.orbitR < 12 && dive.alt < 4);
    assert.ok(climb.orbitR > 20 && climb.alt > 8);
    // Crossfire turns towards the side opposite the squad (here: the squad is at angle 0.3, the Gull at 2).
    assert.equal(gullOrbit("crossfire", { ...ctx, angle: 2, squadAngles: [0.3] }).orbitDir, 1);
  });

  it("scores Hound firing spots by tactic", () => {
    const spot = { dist: 12, travel: 5, cover: false, los: true, view: 0, cross: null, crowd: 0 };
    assert.ok(spotCost("cover", { ...spot, cover: true }) < spotCost("cover", spot));
    assert.ok(spotCost("flank", { ...spot, view: Math.PI }) < spotCost("flank", spot));
    assert.ok(spotCost("fall_back", { ...spot, dist: 22 }) < spotCost("fall_back", spot));
    assert.ok(spotCost("crossfire", { ...spot, cross: 0 }) < spotCost("crossfire", { ...spot, cross: Math.PI }));
    assert.ok(spotCost("hold", { ...spot, travel: 1 }) < spotCost("hold", spot));
    assert.ok(spotCost("cover", { ...spot, los: false }) > spotCost("cover", spot));
    assert.ok(spotCost("cover", { ...spot, crowd: 1 }) > spotCost("cover", spot));
  });

  it("maps the aggression score to fire rate", () => {
    assert.equal(cooldownScale(2), 1);
    assert.ok(cooldownScale(4) < 0.5 && cooldownScale(0) > 2);
    assert.equal(holdsFire(0.3), true);
    assert.equal(holdsFire(1), false);
  });
});
