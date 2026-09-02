import test from "node:test";
import assert from "node:assert/strict";

import { FIRST_SEATING, SERVICE_END } from "../src/data.js";
import {
  advanceTo,
  assignTable,
  attachExternalAgent,
  createInitialState,
  getFloorSnapshot,
  getParty,
  getServiceRecap,
  setCandidates,
  setHostCandidateOverride
} from "../src/engine.js";
import { runReferenceAgent } from "./helpers/reference-agent.js";

const GROUND_KEYS = ["\"ground\"", "\"zoneNotIn\"", "\"acceptableOutcomes\"", "\"reservationPriorityRespected\""];

function requestParty(state, partyId, request) {
  const party = getParty(state, partyId);
  party.request = { id: `${request.template}-${partyId}`, category: request.template[0], source: "guest", ...request };
  return party;
}

test("a manual-only night shows the host column only and no agent attached", () => {
  const state = createInitialState();
  requestParty(state, "patel", { template: "A2", text: "Atmosphere.", ground: { zoneIn: ["view", "interior"], shapeNot: "booth" } });
  requestParty(state, "brooks", { template: "E1", text: "Shellfish.", ground: { zoneNotIn: ["kitchen"], markedAllergy: true } });
  advanceTo(state, FIRST_SEATING + 30);
  assert.equal(assignTable(state, "patel", "V1", { source: "host" }).ok, true);
  assert.equal(assignTable(state, "brooks", "S4", { source: "host" }).ok, true);
  advanceTo(state, SERVICE_END);

  const recap = getServiceRecap(state);
  assert.equal(recap.agentEverAttached, false);
  assert.equal(recap.comparison.host.present, true);
  assert.equal(recap.comparison.agent.present, false);
  assert.deepEqual(recap.comparison.host.specialRequests, { satisfied: 1, total: 2, partial: 0.5 });
  assert.equal(recap.comparison.host.decisions, 2);
  assert.equal(recap.comparison.agent.decisions, 0);
  assert.equal(recap.comparison.host.overrides, 0);
  assert.equal(recap.requests.total, 2);
  assert.equal(recap.requests.satisfied, 1);
  assert.equal(recap.reservationPriorityViolations, 0);
  const failed = recap.requests.outcomes.find((outcome) => outcome.partyId === "brooks");
  assert.equal(failed.owner, "HOST");
  assert.equal(failed.satisfied, false);
  assert.match(failed.reasons.join(" "), /never flagged/);
});

test("an agent-only night attributes every decision and request to the agent", () => {
  const state = createInitialState({ scenarioSeed: "recap-agent-only", randomizeScenario: true });
  runReferenceAgent(state, SERVICE_END);
  const recap = getServiceRecap(state);
  assert.equal(recap.agentEverAttached, true);
  assert.equal(recap.comparison.agent.present, true);
  assert.equal(recap.comparison.host.decisions, 0);
  assert.ok(recap.comparison.agent.decisions >= 60);
  assert.equal(recap.comparison.host.specialRequests.total, 0);
  assert.ok(recap.requests.total >= 8);
  assert.equal(recap.comparison.agent.specialRequests.total + recap.requests.unattributed, recap.requests.total);
  assert.equal(recap.reservationPriorityViolations, 0);
  assert.ok(recap.requests.outcomes.every((outcome) => outcome.text && ["guest", "host"].includes(outcome.source)));
  const serialized = JSON.stringify(getFloorSnapshot(state).serviceRecap);
  for (const key of GROUND_KEYS) assert.ok(!serialized.includes(key), `recap leaked ${key}`);
});

test("a mixed night splits decisions by owner and counts host overrides of agent plans", () => {
  const state = createInitialState();
  requestParty(state, "patel", { template: "A2", text: "Atmosphere.", ground: { zoneIn: ["view", "interior"], shapeNot: "booth" } });
  requestParty(state, "nguyen", { template: "A2", text: "Atmosphere.", ground: { zoneIn: ["view", "interior"], shapeNot: "booth" } });
  attachExternalAgent(state, "Table Pilot", "autonomous");

  // Agent plans Patel for V1; the host overrides to V2 before arrival (still view).
  assert.equal(setCandidates(state, "patel", ["V1"], null, { source: "agent", reason: "Window." }).ok, true);
  assert.equal(setHostCandidateOverride(state, "patel", "V2").ok, true);
  // Agent plans Nguyen for D1; the host drags to the same table at arrival (implicit accept).
  assert.equal(setCandidates(state, "nguyen", ["D1"], null, { source: "agent", reason: "Right-sized 4-top with atmosphere." }).ok, true);
  advanceTo(state, FIRST_SEATING - 1);
  getParty(state, "nguyen").status = "waiting";
  assert.equal(assignTable(state, "nguyen", "D1", { source: "host" }).ok, true);
  advanceTo(state, FIRST_SEATING);
  assert.equal(getParty(state, "patel").committedTableId, "V2");
  assert.equal(getParty(state, "patel").assignmentOrigin.kind, "host");

  getParty(state, "brooks").status = "waiting";
  assert.equal(assignTable(state, "brooks", "D2", { source: "agent", reason: "Two-top." }).ok, true);
  advanceTo(state, SERVICE_END);

  const recap = getServiceRecap(state);
  assert.equal(recap.comparison.host.decisions, 2);
  assert.equal(recap.comparison.agent.decisions, 1);
  assert.equal(recap.comparison.host.overrides, 1);
  assert.equal(recap.comparison.agent.accepted, 1);
  assert.equal(recap.comparison.agent.overridden, 1);
  assert.deepEqual(recap.comparison.host.specialRequests, { satisfied: 2, total: 2, partial: 1 });
  assert.equal(recap.comparison.agent.specialRequests.total, 0);
  assert.equal(state.hostDecisions.map((decision) => decision.action).sort().join(","), "accepted,overrode");
  assert.equal(recap.reservationPriorityViolations, 0);
});

test("a host bypass of reservation priority is reported separately and never counts as an engine violation", () => {
  const state = createInitialState();
  getParty(state, "patel").status = "waiting";
  getParty(state, "diaz").status = "waiting";
  assert.equal(assignTable(state, "diaz", "R1", { source: "host" }).ok, true);
  advanceTo(state, SERVICE_END);
  const recap = getServiceRecap(state);
  assert.equal(recap.reservationPriorityViolations, 0);
  assert.equal(recap.hostPriorityOverrides, 1);
});
