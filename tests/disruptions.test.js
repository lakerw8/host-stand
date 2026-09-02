import test from "node:test";
import assert from "node:assert/strict";

import { FIRST_SEATING } from "../src/data.js";
import { advanceTo, attachExternalAgent, createInitialState, getFloorSnapshot, getParty, getQueueSnapshot, setCandidates } from "../src/engine.js";

test("kitchen delays and no-shows surface as disruptions and request an agent review", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "autonomous");
  advanceTo(state, FIRST_SEATING + 50);
  const noShow = getFloorSnapshot(state).disruptions.find((disruption) => disruption.type === "no_show");
  assert.ok(noShow);
  assert.equal(noShow.partyId, "alvarez");
  assert.equal(noShow.resolved, true);
  assert.equal(state.agentReview.status, "review_due");
  assert.match(state.agentReview.reason, /no show/);

  setCandidates(state, "okonkwo", ["R2"], null, { source: "agent", reason: "Eight-top." });
  assert.equal(state.agentReview.status, "planned");
  advanceTo(state, FIRST_SEATING + 65);
  const floor = getFloorSnapshot(state);
  const delay = floor.disruptions.find((disruption) => disruption.type === "kitchen_delay");
  assert.ok(delay);
  assert.equal(delay.resolved, false);
  assert.equal(floor.kitchenDelay, true);
  assert.equal(floor.kitchenDelayUntil, FIRST_SEATING + 80);
  assert.equal(state.agentReview.status, "review_due");
  assert.match(state.agentReview.reason, /kitchen delay/);

  advanceTo(state, FIRST_SEATING + 80);
  assert.equal(getFloorSnapshot(state).disruptions.find((disruption) => disruption.type === "kitchen_delay").resolved, true);
});

test("during a kitchen delay the agent is told to quote waits and review holds", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "autonomous");
  advanceTo(state, FIRST_SEATING + 65);
  getParty(state, "tanaka").status = "waiting";
  getParty(state, "tanaka").arrivedAt = state.now;
  const actions = getQueueSnapshot(state).nextRecommendedActions;
  assert.ok(actions.some((action) => action.includes("quote_wait") && action.includes("Diaz")), actions.join(" | "));
  assert.ok(actions.some((action) => action.includes("hold_table")), actions.join(" | "));
  advanceTo(state, FIRST_SEATING + 80);
  assert.ok(!getQueueSnapshot(state).nextRecommendedActions.some((action) => action.includes("quote_wait")));
});

test("a party size change is a disruption tied to the C1 request trigger", () => {
  let state = null;
  for (let index = 0; index < 40 && !state; index += 1) {
    const candidate = createInitialState({ scenarioSeed: `disruption-c1-${index}`, randomizeScenario: true });
    if (candidate.parties.some((party) => party.request?.template === "C1")) state = candidate;
  }
  assert.ok(state);
  const update = state.events.find((event) => event.type === "party_update");
  attachExternalAgent(state, "Table Pilot", "autonomous");
  advanceTo(state, update.minute);
  const disruption = getFloorSnapshot(state).disruptions.find((entry) => entry.type === "party_size_change");
  assert.ok(disruption);
  assert.equal(disruption.partyId, update.partyIds[0]);
  assert.equal(disruption.at, update.minute);
  assert.match(disruption.detail, /confirmed/);
  assert.equal(state.agentReview.status, "review_due");
  assert.match(state.agentReview.reason, /party update/);
});
