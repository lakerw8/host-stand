import test from "node:test";
import assert from "node:assert/strict";

import { FIRST_SEATING, SERVICE_END } from "../src/data.js";
import {
  acceptAgentPlan,
  advanceTo,
  attachExternalAgent,
  createInitialState,
  getFloorSnapshot,
  getParty,
  getQueueSnapshot,
  getServiceRecap,
  getTable,
  rejectAgentPlan,
  setCandidates
} from "../src/engine.js";
import { createToolDefinitions, executeToolDefinition } from "../src/webmcp.js";

test("the host can reject an agent plan and the agent cannot re-propose the rejected table", async () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "autonomous");
  assert.equal(setCandidates(state, "patel", ["V1", "V2"], null, { source: "agent", reason: "Window." }).ok, true);
  assert.equal(acceptAgentPlan(state, "brooks").error.code, "NO_AGENT_PLAN");

  const rejected = rejectAgentPlan(state, "patel", "V1 is being held for the owner's guests.", { source: "host" });
  assert.equal(rejected.ok, true);
  assert.deepEqual(rejected.rejectedTables, ["V1"]);
  assert.deepEqual(getParty(state, "patel").candidateTableIds, []);
  assert.equal(getParty(state, "patel").candidateState, "unplanned");
  assert.equal(state.agentReview.status, "review_due");
  assert.equal(state.agentReview.reason, "host rejected a plan");
  assert.equal(state.activity[0].tool, "reject_plan");

  const floor = getFloorSnapshot(state);
  assert.deepEqual(floor.recentHostDecisions.at(-1), { partyId: "patel", action: "rejected", tableId: "V1", reason: "V1 is being held for the owner's guests.", at: state.now });
  assert.deepEqual(getQueueSnapshot(state).reservations.find((party) => party.id === "patel").rejectedTables, ["V1"]);

  const again = setCandidates(state, "patel", ["V1", "V2"], null, { source: "agent", reason: "Window." });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, "INVALID_INPUT");
  assert.match(again.error.message, /rejected V1 for Patel: “V1 is being held for the owner's guests\.”/);
  assert.equal(again.error.hostReason, "V1 is being held for the owner's guests.");

  const secondChoice = setCandidates(state, "patel", ["V2", "V1"], null, { source: "agent", reason: "Second window table." });
  assert.equal(secondChoice.ok, true);
  assert.equal(setCandidates(state, "patel", ["V1"], null, { source: "host" }).ok, true, "the host may still choose the table");
});

test("accepting an upcoming plan locks it as AI ✓ and commits with agent provenance at arrival", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "advisory");
  assert.equal(setCandidates(state, "patel", ["V1"], null, { source: "agent", reason: "Window 2-top for the anniversary." }).ok, true);

  const accepted = acceptAgentPlan(state, "patel", { source: "host" });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.seated, false);
  assert.equal(getParty(state, "patel").planApproved, true);
  assert.equal(getParty(state, "patel").candidateState, "approved");
  assert.equal(setCandidates(state, "patel", ["V2"], null, { source: "agent" }).error.code, "HOST_OVERRIDE_ACTIVE");
  assert.equal(state.hostDecisions.at(-1).action, "accepted");

  advanceTo(state, FIRST_SEATING);
  const party = getParty(state, "patel");
  assert.equal(party.status, "seated");
  assert.equal(party.committedTableId, "V1");
  assert.deepEqual(getTable(state, "V1").assignmentOrigin, { kind: "external", label: "Table Pilot", approved: true });
  assert.equal(getTable(state, "V1").assignmentReason, "Window 2-top for the anniversary.");
  assert.equal(state.seatingRecords[0].reasonSupplied, true);
});

test("accepting a waiting party's plan seats it immediately and the recap counts the loop", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "advisory");
  advanceTo(state, FIRST_SEATING + 12);
  assert.equal(setCandidates(state, "lee", ["C1"], null, { source: "agent", reason: "Counter for a quick two-top." }).ok, true);
  assert.equal(setCandidates(state, "patel", ["V1"], null, { source: "agent", reason: "Window." }).ok, true);
  assert.equal(setCandidates(state, "nguyen", ["D1"], null, { source: "agent", reason: "Four-top." }).ok, true);

  const blocked = acceptAgentPlan(state, "lee", { source: "host" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "RESERVATION_PRIORITY");

  assert.equal(acceptAgentPlan(state, "patel", { source: "host" }).seated, true);
  assert.equal(rejectAgentPlan(state, "nguyen", "", { source: "host" }).ok, true);
  assert.equal(state.hostDecisions.at(-1).reason, null);
  assert.equal(getTable(state, "V1").assignmentOrigin.approved, true);

  advanceTo(state, SERVICE_END);
  const recap = getServiceRecap(state);
  assert.equal(recap.comparison.agent.accepted, 1);
  assert.equal(recap.comparison.agent.rejected, 1);
  assert.equal(recap.comparison.agent.decisions, 1);
  assert.equal(recap.comparison.host.decisions, 0);
});

test("the WebMCP set_candidates tool returns INVALID_INPUT for a rejected table with the host's reason", async () => {
  const state = createInitialState({ preferenceSeed: "proposal-tool" });
  const clock = { pause() {}, resume() {}, setSpeed() {} };
  const definitions = createToolDefinitions({ state, clock, onChange: () => {} });
  const execute = (name, input = {}) => executeToolDefinition(definitions.find((tool) => tool.name === name), input);
  await execute("attach_agent", { agent_name: "Table Pilot", mode: "autonomous" });
  assert.equal((await execute("set_candidates", { party_id: "patel", table_ids: ["V1"], reason: "Window." })).ok, true);
  rejectAgentPlan(state, "patel", "Too drafty tonight.", { source: "host" });
  const result = await execute("set_candidates", { party_id: "patel", table_ids: ["V1"], reason: "Window." });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_INPUT");
  assert.match(result.error.message, /Too drafty tonight/);
  const floor = await execute("get_floor");
  assert.equal(floor.recentHostDecisions.length, 1);
  assert.equal(floor.recentHostDecisions[0].action, "rejected");
});
