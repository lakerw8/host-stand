import test from "node:test";
import assert from "node:assert/strict";

import { createInitialState, getMetrics, setWeights } from "../src/engine.js";
import { SERVICE_END } from "../src/data.js";
import { runReferenceAgent } from "./helpers/reference-agent.js";

// Regression: ISSUE-004 — the Turn preset improved table fit but the weights were not measurable.
// Found by /qa on 2026-08-31.
// Report: .gstack/qa-reports/qa-report-host-stand-nine-vercel-app-2026-08-31.md
// The product ships no planner, so the weights are observable through the scoring service:
// a client that follows score_assignment rankings should trade preference matches for seat fit.
test("Sat and Turn presets change what the scoring service recommends on the same seed", () => {
  const totals = {
    turn: { tableFit: 0, preferenceHitRate: 0 },
    satisfaction: { tableFit: 0, preferenceHitRate: 0 }
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
      runReferenceAgent(state, SERVICE_END);

      const metrics = getMetrics(state);
      const averageFit = state.seatingRecords.reduce((total, record) => total + record.turn, 0) / state.seatingRecords.length;
      assert.ok(state.seatingRecords.length > 0);
      assert.notEqual(metrics.preferenceHitRate, null);
      totals[mode].tableFit += averageFit;
      totals[mode].preferenceHitRate += metrics.preferenceHitRate;
    }
  }

  assert.ok(
    totals.turn.tableFit > totals.satisfaction.tableFit,
    `Turn fit ${totals.turn.tableFit} should exceed Sat fit ${totals.satisfaction.tableFit}`
  );
  assert.ok(
    totals.satisfaction.preferenceHitRate > totals.turn.preferenceHitRate,
    "Satisfaction should improve preference hit rate relative to Turn"
  );
});
