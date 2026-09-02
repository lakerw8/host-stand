import test from "node:test";
import assert from "node:assert/strict";

import { FIRST_SEATING } from "../src/data.js";
import {
  PLAN_BATCH_LIMIT,
  acceptAgentPlan,
  advanceTo,
  attachExternalAgent,
  createInitialState,
  getParty,
  rejectAgentPlan,
  setCandidates,
  setHostCandidateOverride,
  setPlan
} from "../src/engine.js";
import { createToolDefinitions, executeToolDefinition } from "../src/webmcp.js";

function createHarness() {
  const state = createInitialState({ preferenceSeed: "plan-batch" });
  const clock = { pause() {}, resume() {}, setSpeed() {} };
  const definitions = createToolDefinitions({ state, clock, onChange: () => {} });
  const execute = (name, input = {}) => executeToolDefinition(definitions.find((tool) => tool.name === name), input);
  return { state, definitions, execute };
}

test("set_plan posts many tentative tables in one call with per-party results, one ledger row, and one change", async () => {
  const { execute, state } = createHarness();
  await execute("attach_agent", { agent_name: "Table Pilot", mode: "autonomous" });
  const version = state.floorVersion;
  const activityBefore = state.activity.length;

  const result = await execute("set_plan", {
    plans: [
      { party_id: "patel", table_ids: ["V1", "V2"], reason: "Window two-top for the anniversary." },
      { party_id: "nguyen", table_ids: ["D1"], reason: "Right-sized four-top." },
      { party_id: "haddad", table_ids: ["B3"], reason: "Booth for the kids." },
      { party_id: "rossi", table_ids: ["V6"], reason: "Protects the last window four-top for 7:15." }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.planned, 3);
  assert.equal(result.rejected, 1);
  assert.equal(result.floorVersion, version + 1, "one change record for the batch");
  assert.deepEqual(result.results.map((entry) => [entry.partyId, entry.ok]), [["patel", true], ["nguyen", true], ["haddad", false], ["rossi", true]]);
  assert.equal(result.results[2].error.code, "ILLEGAL_CANDIDATE");
  assert.match(result.results[2].error.message, /high chair/);
  assert.deepEqual(getParty(state, "patel").candidateTableIds, ["V1", "V2"]);
  assert.deepEqual(getParty(state, "rossi").candidateTableIds, ["V6"]);
  assert.equal(getParty(state, "patel").candidateReasonSupplied, true);
  assert.equal(state.activity.length - activityBefore, 1);
  assert.equal(state.activity[0].tool, "set_plan");
  assert.match(state.activity[0].detail, /3 planned · 1 rejected \(haddad\)/);
  assert.equal(state.changeLog.at(-1).type, "plan");
  assert.match(state.changeLog.at(-1).detail, /Whole-night plan: 3 planned/);
  assert.equal(state.agentReview.status, "planned");

  advanceTo(state, FIRST_SEATING);
  assert.equal(getParty(state, "patel").committedTableId, "V1");
  assert.equal(getParty(state, "nguyen").committedTableId, "D1");
});

test("set_plan honors host overrides, accepted plans, rejected tables, and stale versions", async () => {
  const { execute, state } = createHarness();
  await execute("attach_agent", { agent_name: "Table Pilot", mode: "advisory" });
  setCandidates(state, "brooks", ["D2"], null, { source: "agent" });
  acceptAgentPlan(state, "brooks", { source: "host" });
  setCandidates(state, "singh", ["D4"], null, { source: "agent" });
  rejectAgentPlan(state, "singh", "Keep D4 for the owner.", { source: "host" });
  setHostCandidateOverride(state, "cohen", "S1");
  const stale = state.floorVersion - 1;

  const rejectedBatch = await execute("set_plan", {
    plans: [{ party_id: "patel", table_ids: ["V1"], reason: "Window." }],
    expected_version: stale
  });
  assert.equal(rejectedBatch.error.code, "STALE_STATE");
  assert.deepEqual(getParty(state, "patel").candidateTableIds, []);

  const result = await execute("set_plan", {
    plans: [
      { party_id: "brooks", table_ids: ["D3"], reason: "Move the accepted plan." },
      { party_id: "singh", table_ids: ["D4"], reason: "Try the rejected table again." },
      { party_id: "cohen", table_ids: ["S2"], reason: "Move the host override." },
      { party_id: "patel", table_ids: ["V1"], reason: "Window." },
      { party_id: "nobody", table_ids: ["V2"], reason: "Unknown party." },
      { party_id: "okonkwo", table_ids: ["R2"], reason: "Eight-top.", auto_assign_at: "half past" }
    ],
    expected_version: state.floorVersion
  });
  assert.equal(result.ok, true);
  assert.equal(result.planned, 1);
  assert.equal(result.rejected, 5);
  const byParty = Object.fromEntries(result.results.map((entry) => [entry.partyId, entry]));
  assert.equal(byParty.brooks.error.code, "HOST_OVERRIDE_ACTIVE");
  assert.equal(byParty.singh.error.code, "INVALID_INPUT");
  assert.match(byParty.singh.error.message, /Keep D4 for the owner/);
  assert.equal(byParty.cohen.error.code, "HOST_OVERRIDE_ACTIVE");
  assert.equal(byParty.patel.ok, true);
  assert.equal(byParty.nobody.error.code, "PARTY_NOT_PLANNABLE");
  assert.equal(byParty.okonkwo.error.code, "INVALID_TIME");
  assert.deepEqual(getParty(state, "brooks").candidateTableIds, ["D2"]);
  assert.deepEqual(getParty(state, "cohen").candidateTableIds, ["S1"]);
});

test("set_plan validates its shape and reports a wholly rejected batch", async () => {
  const { execute } = createHarness();
  await execute("attach_agent", { agent_name: "Table Pilot", mode: "autonomous" });
  assert.equal((await execute("set_plan", { plans: [] })).error.code, "INVALID_INPUT");
  assert.equal((await execute("set_plan", { plans: [{ party_id: "patel" }] })).error.code, "INVALID_INPUT");
  assert.equal((await execute("set_plan", { plans: [{ party_id: "patel", table_ids: ["V1"], extra: true }] })).error.code, "INVALID_INPUT");
  assert.equal((await execute("set_plan", { plans: Array.from({ length: 41 }, () => ({ party_id: "patel", table_ids: ["V1"] })) })).error.code, "INVALID_INPUT");
  const allBad = await execute("set_plan", { plans: [{ party_id: "haddad", table_ids: ["B3"] }, { party_id: "haddad", table_ids: ["C1"] }] });
  assert.equal(allBad.ok, false);
  assert.equal(allBad.error.code, "PLAN_REJECTED");
  assert.equal(allBad.error.results.length, 2);
  assert.equal(PLAN_BATCH_LIMIT, 40);
});

test("a whole-night pass over a random run fits in a few batches", () => {
  const state = createInitialState({ scenarioSeed: "plan-batch-night", randomizeScenario: true });
  attachExternalAgent(state, "Table Pilot", "autonomous");
  const reservations = state.parties.filter((party) => party.source === "reservation" && party.status === "upcoming");
  const tableFor = (party) => state.tables.find((table) => table.seats >= party.size && (!party.children || table.highChair) && (!party.needsAccessible || table.accessible) && (table.zone !== "private" || party.size >= 5));
  let calls = 0;
  let planned = 0;
  for (let index = 0; index < reservations.length; index += PLAN_BATCH_LIMIT) {
    const batch = reservations.slice(index, index + PLAN_BATCH_LIMIT).map((party) => ({ partyId: party.id, tableIds: [tableFor(party).id], reason: "Whole-night pass." }));
    const result = setPlan(state, batch, { source: "agent" });
    calls += 1;
    planned += result.planned;
  }
  assert.ok(calls <= 3, `${calls} calls`);
  assert.equal(planned, reservations.length);
  assert.ok(reservations.every((party) => party.candidateTableIds.length === 1));
});
