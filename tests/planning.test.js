import test from "node:test";
import assert from "node:assert/strict";

import { EXPECTED_DWELL_MINUTES, FIRST_SEATING } from "../src/data.js";
import {
  TABLE_RESET_MINUTES,
  advanceTo,
  assignTable,
  attachExternalAgent,
  createInitialState,
  getFloorSnapshot,
  getParty,
  getPlanBoard,
  getQueueSnapshot,
  setCandidates
} from "../src/engine.js";

test("an agent can plan the whole night: tentative tables persist for reservations hours away", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "autonomous");
  const rossi = getParty(state, "rossi");
  assert.ok(rossi.reservedFor - state.now > 120);
  assert.equal(setCandidates(state, "rossi", ["V6"], null, { source: "agent", reason: "Protect the last window four-top for the anniversary." }).ok, true);
  assert.equal(getQueueSnapshot(state).reservations.find((party) => party.id === "rossi").candidateTableIds[0], "V6");

  advanceTo(state, FIRST_SEATING + 60);
  assert.deepEqual(getParty(state, "rossi").candidateTableIds, ["V6"], "the plan survives events and the heartbeat");
  const floor = getFloorSnapshot(state);
  assert.deepEqual(floor.tables.find((table) => table.id === "V6").plannedParties.map((entry) => entry.partyId), ["rossi"]);
  assert.match(floor.agentCadence.planningPolicy, /whole night|every upcoming reservation/i);
  assert.match(getQueueSnapshot(state).planningPolicy, /whole night/i);

  advanceTo(state, rossi.reservedFor);
  assert.equal(getParty(state, "rossi").committedTableId, "V6");
});

test("the plan board lists who is planned where and flags plans that collide in time", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "autonomous");
  getParty(state, "rossi").size = 2;
  assert.equal(setCandidates(state, "patel", ["V1"], null, { source: "agent" }).ok, true);
  assert.equal(setCandidates(state, "brooks", ["V1"], null, { source: "agent" }).ok, true);
  assert.equal(setCandidates(state, "rossi", ["V1"], null, { source: "agent" }).ok, true);

  const board = getPlanBoard(state);
  assert.deepEqual(board.byTable.get("V1").map((entry) => entry.partyId), ["patel", "brooks", "rossi"]);
  assert.equal(board.byTable.get("V1")[0].expectedFinishAt, getParty(state, "patel").reservedFor + EXPECTED_DWELL_MINUTES);
  assert.deepEqual(board.conflicts.map((conflict) => conflict.partyId), ["brooks"], "Brooks at 5:45 collides with Patel until 6:48; Rossi at 7:15 does not");
  assert.equal(board.conflicts[0].blockedBy, "patel");
  assert.match(board.conflicts[0].detail, /Brooks is planned for V1/);

  const floor = getFloorSnapshot(state);
  assert.equal(floor.planBoard.plannedTables, 1);
  assert.equal(floor.planBoard.plannedParties, 3);
  assert.equal(floor.planBoard.conflicts.length, 1);
  assert.ok(floor.nextRecommendedActions.some((action) => action.startsWith("Plan conflict:")));
});

test("a plan on a seated table is a conflict until the expected finish plus reset", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "autonomous");
  advanceTo(state, FIRST_SEATING);
  assert.equal(assignTable(state, "patel", "V1", { source: "agent" }).ok, true);
  const dueAt = state.tables.find((table) => table.id === "V1").dueAt;
  getParty(state, "brooks").reservedFor = dueAt + TABLE_RESET_MINUTES - 1;
  assert.equal(setCandidates(state, "brooks", ["V1"], null, { source: "agent" }).ok, true);
  assert.equal(getPlanBoard(state).conflicts.length, 1);
  getParty(state, "brooks").reservedFor = dueAt + TABLE_RESET_MINUTES;
  assert.equal(getPlanBoard(state).conflicts.length, 0);
});

test("recommended actions ask for a whole-night plan and surface unplanned requests at any hour", () => {
  const state = createInitialState({ scenarioSeed: "planning-actions", randomizeScenario: true });
  attachExternalAgent(state, "Table Pilot", "autonomous");
  const latest = state.parties
    .filter((party) => party.request && party.source === "reservation")
    .sort((left, right) => right.reservedFor - left.reservedFor)[0];
  assert.ok(latest.reservedFor - state.now > 45);
  const actions = getQueueSnapshot(state).nextRecommendedActions;
  assert.ok(actions.some((action) => action.startsWith("Plan the whole night:")), actions.join(" | "));
  assert.ok(actions.some((action) => action.includes("Unplanned special request")), actions.join(" | "));
  assert.ok(!actions.some((action) => action.includes("45-minute")), actions.join(" | "));

  for (const party of state.parties.filter((candidate) => candidate.source === "reservation" && candidate.status === "upcoming")) {
    party.candidateTableIds = ["R2"];
    party.candidateState = "tentative";
  }
  assert.ok(!getQueueSnapshot(state).nextRecommendedActions.some((action) => action.startsWith("Plan the whole night:")));
});
