import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASSIST, aimPoint, angleBetween, anglesTo, assistTurn, magnetLimit, onTarget } from "../js/touch-aim.js";

// The game's camera looks along (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)).
const forward = ({ yaw, pitch }) => ({ x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) });
const eye = { x: 1, y: 1.6, z: -2 };
const deg = (d) => (d * Math.PI) / 180;

describe("touch aim", () => {
  it("measures the view to a machine the way the game's camera turns", () => {
    for (const view of [{ yaw: 0, pitch: 0 }, { yaw: 2.4, pitch: 0.3 }, { yaw: -1.1, pitch: -0.5 }]) {
      const f = forward(view);
      const to = anglesTo(eye, { x: eye.x + f.x * 20, y: eye.y + f.y * 20, z: eye.z + f.z * 20 });
      assert.ok(angleBetween(view, to) < 1e-6);
      assert.ok(Math.abs(to.dist - 20) < 1e-9);
    }
    assert.ok(aimPoint({ type: "hound", pos: { x: 0, y: 0, z: 0 } }).y > aimPoint({ type: "gull", pos: { x: 0, y: 0, z: 0 } }).y);
  });

  it("eases the view onto a machine without passing it, at no more than the turn-rate cap", () => {
    const opts = { pull: ASSIST.pull, maxPull: ASSIST.maxPull, track: ASSIST.track };
    let err = { yaw: deg(6), pitch: deg(-3) };
    for (let frame = 0; frame < 60; frame++) {
      const turn = assistTurn(err, { yaw: 0, pitch: 0 }, 1 / 60, opts);
      assert.ok(Math.hypot(turn.yaw, turn.pitch) <= ASSIST.maxPull / 60 + 1e-12);
      err = { yaw: err.yaw - turn.yaw, pitch: err.pitch - turn.pitch };
      assert.ok(err.yaw >= 0 && err.pitch <= 0);
    }
    assert.ok(Math.hypot(err.yaw, err.pitch) < deg(0.2));
    // A machine moving across the view is followed even when the crosshair is already on it.
    const follow = assistTurn({ yaw: deg(1), pitch: 0 }, { yaw: deg(1), pitch: 0 }, 1 / 60, opts);
    assert.ok(follow.yaw > deg(1) * ASSIST.track * 0.99 && follow.yaw <= deg(1));
  });

  it("fires on a machine's body, with more room close up, and bends only near misses", () => {
    assert.ok(onTarget(deg(3), 6, ASSIST));
    assert.ok(!onTarget(deg(3), 30, ASSIST));
    assert.ok(onTarget(deg(1), 30, ASSIST));
    assert.ok(!onTarget(0, ASSIST.fireRange + 1, ASSIST));
    assert.ok(magnetLimit(30, ASSIST) > Math.atan(ASSIST.size / 30) && magnetLimit(30, ASSIST) < deg(3));
  });
});
