import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_FREEZE_WINDOW_MINUTES,
  AGENT_HEARTBEAT_MINUTES,
  AGENT_PLANNING_HORIZON_MINUTES,
  advanceTo,
  assignTable,
  checkAssignmentLegality,
  createInitialState,
  elapsedToSimMinutes,
  getParty,
  getReservationPriorityBlocker,
  getTable,
  lockTable,
  runAgentCycle,
  setCandidates,
  setHostCandidateOverride,
  setWeights
} from "../src/engine.js";
import { EXPECTED_DWELL_MINUTES, PARTY_SIZE_DISTRIBUTION, PREFERENCE_KEYS, RESTAURANT_CAPACITY, SERVICE_START, TABLE_DEFINITIONS, TABLE_UNIT_COUNT } from "../src/data.js";

test("the expanded restaurant inventory is exactly 100 seats", () => {
  assert.equal(RESTAURANT_CAPACITY, 100);
  assert.equal(TABLE_UNIT_COUNT, 27);
  assert.equal(TABLE_DEFINITIONS.reduce((total, table) => total + table.seats, 0), 100);
  assert.deepEqual(["V6", "B5", "S6"].map((id) => TABLE_DEFINITIONS.some((table) => table.id === id)), [true, true, true]);
});

test("service waits at 5:45 PM until Start is pressed", () => {
  const state = createInitialState();
  assert.equal(state.now, SERVICE_START);
  assert.equal(state.running, false);
  assert.ok(getParty(state, "patel").candidateTableIds.length >= 1);
});

test("upcoming reservations receive forecast tables while manual mode stays suggestion-free", () => {
  const agentState = createInitialState();
  assert.ok(getParty(agentState, "patel").candidateTableIds.length >= 1);
  assert.equal(getParty(agentState, "patel").autoAssignAt, null);
  assert.equal(getParty(agentState, "patel").candidateState, "tentative");
  assert.deepEqual(getParty(agentState, "rossi").candidateTableIds, []);
  assert.equal(AGENT_PLANNING_HORIZON_MINUTES, 45);

  const manualState = createInitialState({ agentEnabled: false });
  assert.deepEqual(getParty(manualState, "patel").candidateTableIds, []);
});

test("party preferences are seeded-random, unique, and span zero through three", () => {
  const first = createInitialState({ preferenceSeed: "preference-test" });
  const replay = createInitialState({ preferenceSeed: "preference-test" });
  const anotherNight = createInitialState({ preferenceSeed: "another-night" });

  assert.deepEqual(first.parties.map((party) => party.preferences), replay.parties.map((party) => party.preferences));
  assert.notDeepEqual(first.parties.map((party) => party.preferences), anotherNight.parties.map((party) => party.preferences));
  assert.deepEqual([...new Set(first.parties.map((party) => party.preferences.length))].sort(), [0, 1, 2, 3]);
  for (const party of first.parties) {
    assert.equal(new Set(party.preferences).size, party.preferences.length);
    assert.ok(party.preferences.every((preference) => PREFERENCE_KEYS.includes(preference)));
  }
});

test("random service runs replay by seed and vary parties, timing, constraints, and events across seeds", () => {
  const first = createInitialState({ scenarioSeed: "random-run-a", randomizeScenario: true });
  const replay = createInitialState({ scenarioSeed: "random-run-a", randomizeScenario: true });
  const next = createInitialState({ scenarioSeed: "random-run-b", randomizeScenario: true });

  assert.deepEqual(first.parties, replay.parties);
  assert.deepEqual(first.events, replay.events);
  assert.notDeepEqual(first.parties, next.parties);
  assert.notDeepEqual(first.events, next.events);
  assert.ok(first.parties.length >= 20 && first.parties.length <= 28);
  assert.ok(first.parties.some((party) => party.source === "reservation"));
  assert.ok(first.parties.some((party) => party.source === "walk_in"));
  assert.ok(first.parties.some((party) => party.children > 0));
  assert.ok(first.parties.some((party) => party.needsAccessible));
  assert.deepEqual([...new Set(first.parties.map((party) => party.preferences.length))].sort(), [0, 1, 2, 3]);
});

test("random nights normalize party sizes around mostly two-tops and four-tops", () => {
  assert.equal(PARTY_SIZE_DISTRIBUTION.reduce((total, entry) => total + entry.weight, 0), 100);
  assert.equal(
    PARTY_SIZE_DISTRIBUTION.filter((entry) => [2, 4].includes(entry.size)).reduce((total, entry) => total + entry.weight, 0),
    72
  );

  for (let index = 0; index < 100; index += 1) {
    const state = createInitialState({ scenarioSeed: `party-size-ratio-${index}`, randomizeScenario: true });
    const twoOrFourCount = state.parties.filter((party) => [2, 4].includes(party.size)).length;
    const largePartyCount = state.parties.filter((party) => party.size >= 5).length;
    const meanPartySize = state.parties.reduce((total, party) => total + party.size, 0) / state.parties.length;

    assert.ok(twoOrFourCount / state.parties.length >= 0.68, `too few 2/4-top parties in ${state.runCode}`);
    assert.ok(twoOrFourCount / state.parties.length <= 0.75, `too many 2/4-top parties in ${state.runCode}`);
    assert.ok(largePartyCount / state.parties.length >= 0.08, `no realistic large-party tail in ${state.runCode}`);
    assert.ok(largePartyCount / state.parties.length <= 0.16, `too many large parties in ${state.runCode}`);
    assert.ok(meanPartySize >= 2.8 && meanPartySize <= 3.2, `unrealistic mean party size in ${state.runCode}`);
  }
});

test("service clock maps real seconds to restaurant minutes at 1x, 2x, and 5x", () => {
  assert.equal(elapsedToSimMinutes(1000, 1), 1);
  assert.equal(elapsedToSimMinutes(1000, 2), 2);
  assert.equal(elapsedToSimMinutes(1000, 5), 5);
});

test("pre-planned reservations commit their tentative tables when they arrive", () => {
  const state = createInitialState();
  const patelPlan = getParty(state, "patel").candidateTableIds[0];
  const nguyenPlan = getParty(state, "nguyen").candidateTableIds[0];
  const result = advanceTo(state, 18 * 60);

  assert.equal(result.ok, true);
  assert.equal(getParty(state, "patel").status, "seated");
  assert.equal(getParty(state, "nguyen").status, "seated");
  assert.equal(getParty(state, "patel").committedTableId, patelPlan);
  assert.equal(getParty(state, "nguyen").committedTableId, nguyenPlan);
  assert.notEqual(patelPlan, nguyenPlan);
});

test("an arrived walk-in receives live table suggestions", () => {
  const state = createInitialState();
  advanceTo(state, 18 * 60 + 12);

  const lee = getParty(state, "lee");
  assert.equal(lee.status, "waiting");
  assert.ok(lee.candidateTableIds.length >= 1);
  assert.equal(lee.autoAssignAt, 18 * 60 + 12 + AGENT_FREEZE_WINDOW_MINUTES);
});

test("the local agent reviews every ten restaurant minutes when no event intervenes", () => {
  const state = createInitialState();
  assert.equal(state.agentReview.lastReviewAt, SERVICE_START);
  assert.equal(state.agentReview.nextReviewAt, SERVICE_START + AGENT_HEARTBEAT_MINUTES);

  advanceTo(state, SERVICE_START + AGENT_HEARTBEAT_MINUTES);

  assert.equal(state.agentReview.lastReviewAt, SERVICE_START + AGENT_HEARTBEAT_MINUTES);
  assert.equal(state.agentReview.reason, "10-minute heartbeat");
  assert.ok(state.activity.some((entry) => entry.tool === "review_floor" && entry.detail.includes("10-minute heartbeat")));
});

test("the agent sends a no-preference 2-top to a fast-turn zone instead of spending the view", () => {
  const state = createInitialState();
  advanceTo(state, 18 * 60 + 12 + AGENT_FREEZE_WINDOW_MINUTES);

  const lee = getParty(state, "lee");
  const table = getTable(state, lee.committedTableId);
  assert.equal(lee.status, "seated");
  assert.ok(["kitchen", "counter"].includes(table.zone), `Lee was assigned to ${table.id} in ${table.zone}`);
});

test("a host tentative-table override remains fixed and commits at reservation arrival", () => {
  const state = createInitialState();
  const override = setHostCandidateOverride(state, "patel", "V1");

  assert.equal(override.ok, true);
  assert.equal(getParty(state, "patel").hostOverrideTableId, "V1");
  assert.equal(getParty(state, "patel").candidateTableIds[0], "V1");
  assert.equal(getParty(state, "patel").candidateState, "host_override");

  advanceTo(state, 18 * 60);
  assert.equal(getParty(state, "patel").committedTableId, "V1");
  assert.equal(getParty(state, "patel").assignedBy, "agent");
});

test("a floor event triggers an immediate full review between heartbeats", () => {
  const state = createInitialState();
  const previousTop = getParty(state, "patel").candidateTableIds[0];
  const result = lockTable(state, previousTop, "Host photo setup", { source: "host" });

  assert.equal(result.ok, true);
  assert.equal(state.agentReview.reason, "table lock changed");
  assert.notEqual(getParty(state, "patel").candidateTableIds[0], previousTop);
  assert.equal(state.agentReview.nextReviewAt, state.now + AGENT_HEARTBEAT_MINUTES);
});

test("manual mode never auto-assigns, while host assignment remains available", () => {
  const state = createInitialState({ agentEnabled: false });
  advanceTo(state, 18 * 60 + 8);
  assert.equal(getParty(state, "patel").status, "waiting");
  assert.deepEqual(getParty(state, "patel").candidateTableIds, []);

  const result = assignTable(state, "patel", "V1", { source: "host" });
  assert.equal(result.ok, true);
  assert.equal(getParty(state, "patel").status, "seated");
  assert.equal(getTable(state, "V1").partyId, "patel");
});

test("automated seating honors an available reservation before a walk-in, while the host can override", () => {
  const state = createInitialState({ agentEnabled: false });
  const reservation = getParty(state, "patel");
  const walkIn = getParty(state, "diaz");
  reservation.status = "waiting";
  walkIn.status = "waiting";

  const blocker = getReservationPriorityBlocker(state, walkIn);
  assert.equal(blocker.partyId, reservation.id);
  assert.ok(blocker.availableTableIds.length >= 1);

  const agentAttempt = assignTable(state, walkIn.id, "R1", { source: "agent" });
  assert.equal(agentAttempt.ok, false);
  assert.equal(agentAttempt.error.code, "RESERVATION_PRIORITY");
  assert.equal(agentAttempt.error.hostMayOverride, true);

  const hostOverride = assignTable(state, walkIn.id, "R1", { source: "host" });
  assert.equal(hostOverride.ok, true);
  assert.equal(getTable(state, "R1").partyId, walkIn.id);
});

test("walk-in automation resumes after the available reservation is seated", () => {
  const state = createInitialState({ agentEnabled: false });
  const reservation = getParty(state, "patel");
  const walkIn = getParty(state, "diaz");
  reservation.status = "waiting";
  walkIn.status = "waiting";

  assert.equal(assignTable(state, reservation.id, "V1", { source: "agent" }).ok, true);
  assert.equal(getReservationPriorityBlocker(state, walkIn), null);
  assert.equal(assignTable(state, walkIn.id, "R1", { source: "agent" }).ok, true);
});

test("the local agent commits simultaneous deadlines in reservation-first order", () => {
  const state = createInitialState();
  state.now = 18 * 60;
  const reservation = getParty(state, "patel");
  const walkIn = getParty(state, "diaz");
  reservation.status = "waiting";
  walkIn.status = "waiting";

  runAgentCycle(state, { reason: "reservation priority test", allowAutoCommit: false });
  assert.ok(reservation.autoAssignAt <= walkIn.autoAssignAt);
  assert.equal(walkIn.autoAssignAt, state.now + AGENT_FREEZE_WINDOW_MINUTES);

  advanceTo(state, Math.max(reservation.autoAssignAt, walkIn.autoAssignAt));
  assert.equal(state.seatingRecords[0].partyId, reservation.id);
  assert.equal(reservation.status, "seated");
  assert.equal(walkIn.status, "seated");
});

test("children make non-high-chair tables illegal for agent and host", () => {
  const state = createInitialState({ agentEnabled: false });
  advanceTo(state, 18 * 60 + 18);

  for (const tableId of ["B3", "B4", "S5", "C1", "C6"]) {
    const legality = checkAssignmentLegality(state, "haddad", tableId, { forCandidate: true, source: "host" });
    assert.equal(legality.legal, false, `${tableId} must reject a party needing a high chair`);
    assert.match(legality.reasons.join(" "), /high chair/i);
  }
  assert.equal(checkAssignmentLegality(state, "haddad", "V3", { forCandidate: true, source: "host" }).legal, true);
});

test("candidate sets reject an illegal child seating before publication", () => {
  const state = createInitialState({ agentEnabled: false });
  advanceTo(state, 18 * 60 + 18);

  const result = setCandidates(state, "haddad", ["B3", "V3"], state.now + 3, { source: "agent" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ILLEGAL_CANDIDATE");
  assert.deepEqual(getParty(state, "haddad").candidateTableIds, []);
});

test("a host lock is a hard constraint and forces candidate reflow", () => {
  const state = createInitialState({ agentEnabled: false });
  advanceTo(state, 18 * 60);
  lockTable(state, "V1", "Anniversary photo setup", { source: "host" });

  const result = assignTable(state, "patel", "V1", { source: "host" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ILLEGAL_ASSIGNMENT");
  assert.match(result.error.message, /locked/i);
});

test("accessibility requirement filters every unmarked table", () => {
  const state = createInitialState({ agentEnabled: false });
  const party = getParty(state, "cohen");
  party.status = "waiting";
  party.needsAccessible = true;

  assert.equal(checkAssignmentLegality(state, "cohen", "S2", { forCandidate: true }).legal, false);
  assert.equal(checkAssignmentLegality(state, "cohen", "S1", { forCandidate: true }).legal, true);
  assert.equal(checkAssignmentLegality(state, "cohen", "V3", { forCandidate: true }).legal, true);
});

test("host can override the private-room minimum but not table capacity", () => {
  const state = createInitialState({ agentEnabled: false });
  const brooks = getParty(state, "brooks");
  brooks.status = "waiting";

  assert.equal(checkAssignmentLegality(state, "brooks", "P1", { forCandidate: true, source: "agent" }).legal, false);
  assert.equal(checkAssignmentLegality(state, "brooks", "P1", { forCandidate: true, source: "host" }).legal, true);

  const walsh = getParty(state, "walsh");
  walsh.status = "waiting";
  walsh.size = 9;
  assert.equal(checkAssignmentLegality(state, "walsh", "P1", { forCandidate: true, source: "host" }).legal, false);
});

test("weight changes must total one and are stored for the next solve", () => {
  const state = createInitialState();
  const valid = setWeights(state, 0.35, 0.65, { source: "host" });
  assert.equal(valid.ok, true);
  assert.deepEqual(state.weights, { sat: 0.35, turn: 0.65 });

  const invalid = setWeights(state, 0.5, 0.7, { source: "host" });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_WEIGHTS");
});

test("a seated table progresses through dirty back to free", () => {
  const state = createInitialState({ agentEnabled: false });
  const party = getParty(state, "patel");
  party.status = "waiting";
  const seated = assignTable(state, "patel", "V1", { source: "host" });
  assert.equal(seated.ok, true);
  const dueAt = getTable(state, "V1").dueAt;
  assert.equal(dueAt, state.now + EXPECTED_DWELL_MINUTES);

  advanceTo(state, dueAt);
  assert.equal(getTable(state, "V1").status, "dirty");
  assert.equal(getParty(state, "patel").status, "left");

  advanceTo(state, dueAt + 8);
  assert.equal(getTable(state, "V1").status, "free");
});
