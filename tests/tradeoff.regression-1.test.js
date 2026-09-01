import test from "node:test";
import assert from "node:assert/strict";

import { advanceTo, createInitialState, getMetrics, setWeights } from "../src/engine.js";
import { SERVICE_END } from "../src/data.js";

// Regression: ISSUE-004 — the Turn preset improved table fit but increased walk-in P90.
// Found by /qa on 2026-08-31.
// Report: .gstack/qa-reports/qa-report-host-stand-nine-vercel-app-2026-08-31.md
test("Sat and Turn presets produce the promised same-seed service tradeoff", () => {
  const totals = {
    turn: { waitP90: 0, preferenceHitRate: 0 },
    satisfaction: { waitP90: 0, preferenceHitRate: 0 }
  };

  for (let index = 0; index < 24; index += 1) {
    for (const [mode, weights] of [
      ["turn", [0.35, 0.65]],
      ["satisfaction", [0.8, 0.2]]
    ]) {
      const state = createInitialState({
        scenarioSeed: `tradeoff-${index}`,
        randomizeScenario: true
      });
      assert.equal(setWeights(state, ...weights).ok, true);
      advanceTo(state, SERVICE_END);

      const metrics = getMetrics(state);
      assert.notEqual(metrics.waitP90, null);
      assert.notEqual(metrics.preferenceHitRate, null);
      totals[mode].waitP90 += metrics.waitP90;
      totals[mode].preferenceHitRate += metrics.preferenceHitRate;
    }
  }

  assert.ok(
    totals.turn.waitP90 < totals.satisfaction.waitP90,
    `Turn P90 ${totals.turn.waitP90} should be below Sat P90 ${totals.satisfaction.waitP90}`
  );
  assert.ok(
    totals.satisfaction.preferenceHitRate > totals.turn.preferenceHitRate,
    "Satisfaction should improve preference hit rate relative to Turn"
  );
});
