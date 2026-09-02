import test from "node:test";
import assert from "node:assert/strict";

import { advanceTo, attachExternalAgent, checkAssignmentLegality, createInitialState, getParty, rankCandidateTables } from "../src/engine.js";

// Regression: ISSUE-002 — generated parties never changed size when they checked in.
// Found by /qa on 2026-08-31.
// Report: .gstack/qa-reports/qa-report-host-stand-nine-vercel-app-2026-08-31.md
test("a seeded ten-percent cohort grows by one at check-in and triggers legal replanning", () => {
  const state = createInitialState({ scenarioSeed: "check-in-size-0", randomizeScenario: true });
  const sizeIncreaseParties = state.parties.filter((party) => party.checkInSizeDelta === 1);
  const party = getParty(state, "silva-12");
  const arrival = state.events.find((event) => event.partyIds?.includes(party.id));

  assert.equal(state.parties.length, 91);
  assert.equal(sizeIncreaseParties.length, 9);
  assert.equal(party.size, 1);
  assert.equal(party.checkInSizeDelta, 1);

  attachExternalAgent(state, "Reference agent", "autonomous");
  advanceTo(state, arrival.minute);

  assert.equal(party.status, "waiting");
  assert.equal(party.size, 2);
  assert.equal(party.checkInSizeDelta, 0);
  assert.equal(state.agentReview.status, "review_due");
  assert.match(state.agentReview.reason, /arrival/);
  assert.ok(state.activity.some((entry) => entry.detail === "Silva arrived · party grew 1 → 2"));
  const ranked = rankCandidateTables(state, party.id);
  assert.ok(ranked.length >= 1);
  assert.ok(ranked.every((entry) => (
    checkAssignmentLegality(state, party.id, entry.tableId, { forCandidate: true, source: "agent" }).legal
  )));
});
