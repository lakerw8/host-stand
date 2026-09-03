import test from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_FREEZE_WINDOW_MINUTES,
  AGENT_HEARTBEAT_MINUTES,
  AGENT_PLANNING_HORIZON_MINUTES,
  TABLE_RESET_MINUTES,
  advanceTo,
  assignTable,
  attachExternalAgent,
  checkAssignmentLegality,
  createInitialState,
  detachExternalAgent,
  elapsedToSimMinutes,
  getFloorSnapshot,
  getMetrics,
  getParty,
  getReservationPriorityBlocker,
  getServiceRecap,
  getTable,
  lockTable,
  rankCandidateTables,
  scoreAssignment,
  setCandidates,
  setHostCandidateOverride,
  setWeights
} from "../src/engine.js";
import { EXPECTED_DWELL_MINUTES, FIRST_SEATING, PARTY_SIZE_DISTRIBUTION, PREFERENCE_KEYS, RESTAURANT_CAPACITY, SERVICE_END, SERVICE_START, TABLE_DEFINITIONS, TABLE_UNIT_COUNT } from "../src/data.js";
import { runReferenceAgent } from "./helpers/reference-agent.js";

test("the expanded restaurant inventory is exactly 120 seats", () => {
  assert.equal(RESTAURANT_CAPACITY, 120);
  assert.equal(TABLE_UNIT_COUNT, 33);
  assert.equal(TABLE_DEFINITIONS.reduce((total, table) => total + table.seats, 0), 120);
  assert.deepEqual(
    ["D1", "D2", "D3", "D4", "D5", "D6"].map((id) => TABLE_DEFINITIONS.some((table) => table.id === id)),
    [true, true, true, true, true, true]
  );
});

test("service waits at 5:00 PM in manual mode until Start is pressed and ends at 10:00 PM", () => {
  const state = createInitialState();
  assert.equal(state.now, SERVICE_START);
  assert.equal(SERVICE_START, 17 * 60);
  assert.equal(SERVICE_END, 22 * 60);
  assert.equal(state.running, false);
  assert.equal(state.controllerMode, "manual");
  assert.equal(state.agentConnection, null);
  assert.ok(state.parties.every((party) => party.candidateTableIds.length === 0));
});

test("only two operating modes exist: manual host and an attached agent", () => {
  const state = createInitialState();
  assert.deepEqual(getParty(state, "patel").candidateTableIds, []);
  assert.equal(AGENT_PLANNING_HORIZON_MINUTES, 45);

  assert.equal(attachExternalAgent(state, "Table Pilot", "autonomous").ok, true);
  assert.equal(state.controllerMode, "external");
  assert.equal(state.agentReview.status, "review_due");
  assert.equal(setCandidates(state, "patel", ["V1", "V2"], null, { source: "agent", reason: "Window 2-top for the anniversary." }).ok, true);
  assert.equal(getParty(state, "patel").candidateState, "tentative");
  assert.equal(getParty(state, "patel").autoAssignAt, null);

  getParty(state, "brooks").status = "waiting";
  assert.equal(assignTable(state, "brooks", "D2", { source: "agent" }).ok, true);

  assert.equal(detachExternalAgent(state).ok, true);
  assert.equal(state.controllerMode, "manual");
  assert.deepEqual(getParty(state, "patel").candidateTableIds, []);
  assert.equal(getParty(state, "brooks").status, "seated");
  assert.equal(getTable(state, "D2").partyId, "brooks");
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
  assert.deepEqual(first.serviceBrief, replay.serviceBrief);
  assert.notDeepEqual(first.parties, next.parties);
  assert.notDeepEqual(first.events, next.events);
  assert.notDeepEqual(first.serviceBrief, next.serviceBrief);
  assert.equal(first.serviceBrief.directives.length, 2);
  assert.deepEqual(first.serviceBrief.directives.map((directive) => directive.type), ["section_load", "party_proximity"]);
  assert.ok(first.serviceBrief.directives.every((directive) => directive.text.length >= 30));
  assert.ok(first.parties.length >= 84 && first.parties.length <= 96);
  assert.ok(first.parties.some((party) => party.source === "reservation"));
  assert.ok(first.parties.some((party) => party.source === "walk_in"));
  assert.ok(first.parties.some((party) => party.children > 0));
  assert.ok(first.parties.some((party) => party.needsAccessible));
  assert.deepEqual([...new Set(first.parties.map((party) => party.preferences.length))].sort(), [0, 1, 2, 3]);
});

test("the seating brief changes table scoring with an explicit operational reason", () => {
  const state = createInitialState({ preferenceSeed: "brief-scoring" });
  const directive = state.serviceBrief.directives.find((entry) => entry.type === "section_load");
  const party = getParty(state, "brooks");
  party.status = "waiting";
  party.children = 0;
  party.needsAccessible = false;
  state.now = directive.from;
  const table = state.tables.find((candidate) => candidate.zone === directive.zone && candidate.seats >= party.size);
  const scored = scoreAssignment(state, party.id, table.id, { forCandidate: true, source: "agent" });

  assert.equal(scored.legal, true);
  assert.equal(scored.serviceBriefAdjustment, -0.26);
  assert.match(scored.serviceBriefReasons.join(" "), /overloaded/i);
});

test("the seating brief rewards keeping linked parties nearby", () => {
  const state = createInitialState({ preferenceSeed: "brief-proximity-scoring" });
  const directive = state.serviceBrief.directives.find((entry) => entry.type === "party_proximity");
  const [targetPartyId, companionPartyId] = directive.partyIds;
  const targetParty = getParty(state, targetPartyId);
  const companionParty = getParty(state, companionPartyId);

  targetParty.size = 2;
  targetParty.children = 0;
  targetParty.needsAccessible = false;
  targetParty.preferences = [];
  targetParty.status = "waiting";
  companionParty.candidateTableIds = ["V1"];

  const nearby = scoreAssignment(state, targetParty.id, "V2", { forCandidate: true, source: "agent" });
  const distant = scoreAssignment(state, targetParty.id, "S4", { forCandidate: true, source: "agent" });

  assert.equal(nearby.legal, true);
  assert.equal(distant.legal, true);
  assert.equal(nearby.serviceBriefAdjustment, 0.16);
  assert.equal(distant.serviceBriefAdjustment, -0.16);
  assert.match(nearby.serviceBriefReasons.join(" "), /near/i);
  assert.match(distant.serviceBriefReasons.join(" "), /far/i);
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

test("busy random nights offer enough demand for a simple agent to reach 80 percent seat utilization", () => {
  for (let index = 0; index < 8; index += 1) {
    const state = createInitialState({ scenarioSeed: `peak-capacity-${index}`, randomizeScenario: true });
    let peakUtilization = 0;
    runReferenceAgent(state, SERVICE_END, {
      onMinute: (current) => { peakUtilization = Math.max(peakUtilization, getMetrics(current).utilization); }
    });
    assert.ok(
      peakUtilization >= 0.8,
      `${state.runCode} only reached ${Math.round(peakUtilization * 100)}% utilization`
    );
  }
});

test("service clock maps real seconds to restaurant minutes at 1x, 2x, and 5x", () => {
  assert.equal(elapsedToSimMinutes(1000, 1), 1);
  assert.equal(elapsedToSimMinutes(1000, 2), 2);
  assert.equal(elapsedToSimMinutes(1000, 5), 5);
});

test("an autonomous agent's tentative tables commit when the reservations arrive", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "autonomous");
  assert.equal(setCandidates(state, "patel", ["V1"], null, { source: "agent", reason: "Window 2-top." }).ok, true);
  assert.equal(setCandidates(state, "nguyen", ["D1"], null, { source: "agent", reason: "Right-sized 4-top." }).ok, true);
  const result = advanceTo(state, FIRST_SEATING);

  assert.equal(result.ok, true);
  assert.equal(getParty(state, "patel").status, "seated");
  assert.equal(getParty(state, "nguyen").status, "seated");
  assert.equal(getParty(state, "patel").committedTableId, "V1");
  assert.equal(getParty(state, "nguyen").committedTableId, "D1");
  assert.deepEqual(getTable(state, "V1").assignmentOrigin, { kind: "external", label: "Table Pilot" });
});

test("plans execute at arrival in advisory mode too; the mode no longer gates execution", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Advisor", "advisory");
  assert.equal(setCandidates(state, "patel", ["V1"], null, { source: "agent" }).ok, true);
  advanceTo(state, FIRST_SEATING);
  assert.equal(getParty(state, "patel").status, "seated");
  assert.equal(getParty(state, "patel").committedTableId, "V1");
  assert.equal(getTable(state, "V1").assignmentOrigin.kind, "external");
});

test("a plan falls back to the agent's next-ranked table when the first is no longer legal at arrival", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "autonomous");
  assert.equal(setCandidates(state, "patel", ["V1", "V2", "D2"], null, { source: "agent", reason: "Window, else a two-top." }).ok, true);
  lockTable(state, "V1", "Broken chair", { source: "host" });
  advanceTo(state, FIRST_SEATING);
  assert.equal(getParty(state, "patel").status, "seated");
  assert.equal(getParty(state, "patel").committedTableId, "V2");
  assert.equal(getTable(state, "V1").partyId, null);
});

test("when no planned table is legal at arrival the ledger says so and the agent is asked to review", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "autonomous");
  assert.equal(setCandidates(state, "patel", ["V1"], null, { source: "agent" }).ok, true);
  lockTable(state, "V1", "Broken chair", { source: "host" });
  state.agentReview.status = "planned";
  advanceTo(state, FIRST_SEATING);
  const patel = getParty(state, "patel");
  assert.equal(patel.status, "waiting");
  assert.equal(patel.autoAssignAt, null, "the deadline is cleared so the engine does not retry every minute");
  assert.deepEqual(patel.candidateTableIds, ["V1"], "the plan stays visible for the host and the agent");
  assert.ok(state.activity.some((entry) => entry.tool === "plan" && entry.detail.includes("Patel: planned V1 not possible")), state.activity.map((entry) => entry.detail).join(" | "));
  assert.equal(state.agentReview.status, "review_due");
});

test("an arrived walk-in in manual mode waits for the host with no suggestions", () => {
  const state = createInitialState();
  advanceTo(state, FIRST_SEATING + 12);

  const lee = getParty(state, "lee");
  assert.equal(lee.status, "waiting");
  assert.deepEqual(lee.candidateTableIds, []);
  assert.equal(lee.autoAssignAt, null);
});

test("an attached agent is asked to review every ten restaurant minutes when no event intervenes", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "autonomous");
  assert.equal(state.agentReview.nextReviewAt, SERVICE_START + AGENT_HEARTBEAT_MINUTES);
  setCandidates(state, "patel", ["V1"], null, { source: "agent" });
  assert.equal(state.agentReview.status, "planned");

  advanceTo(state, SERVICE_START + AGENT_HEARTBEAT_MINUTES);

  assert.equal(state.agentReview.status, "review_due");
  assert.equal(state.agentReview.reason, "10-minute heartbeat");
});

test("the scoring service ranks a fast-turn zone first for a no-preference 2-top", () => {
  const state = createInitialState();
  advanceTo(state, FIRST_SEATING + 12);

  const lee = getParty(state, "lee");
  assert.deepEqual(lee.preferences, []);
  const ranked = rankCandidateTables(state, lee.id);
  assert.ok(ranked.length >= 1);
  assert.ok(["kitchen", "counter"].includes(ranked[0].zone), `Lee's top table was ${ranked[0].tableId} in ${ranked[0].zone}`);
  assert.ok(ranked.every((entry) => entry.legal));
});

test("a host tentative-table override remains fixed and commits as a host decision at arrival", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "advisory");
  setCandidates(state, "patel", ["V2"], null, { source: "agent" });
  const override = setHostCandidateOverride(state, "patel", "V1");

  assert.equal(override.ok, true);
  assert.equal(getParty(state, "patel").hostOverrideTableId, "V1");
  assert.equal(getParty(state, "patel").candidateTableIds[0], "V1");
  assert.equal(getParty(state, "patel").candidateState, "host_override");
  assert.equal(setCandidates(state, "patel", ["V2"], null, { source: "agent" }).error.code, "HOST_OVERRIDE_ACTIVE");

  advanceTo(state, FIRST_SEATING);
  assert.equal(getParty(state, "patel").committedTableId, "V1");
  assert.equal(getParty(state, "patel").assignedBy, "host");
  assert.equal(getTable(state, "V1").assignmentOrigin.kind, "host");
});

test("a floor event asks the attached agent for an immediate review between heartbeats", () => {
  const state = createInitialState();
  attachExternalAgent(state, "Table Pilot", "autonomous");
  setCandidates(state, "patel", ["V1"], null, { source: "agent" });
  const result = lockTable(state, "V1", "Host photo setup", { source: "host" });

  assert.equal(result.ok, true);
  assert.equal(state.agentReview.status, "review_due");
  assert.equal(state.agentReview.reason, "table lock changed");
  assert.equal(checkAssignmentLegality(state, "patel", "V1", { forCandidate: true, allowUpcoming: true }).legal, false);
});

test("manual mode never auto-assigns, while host assignment remains available", () => {
  const state = createInitialState();
  advanceTo(state, FIRST_SEATING + 8);
  assert.equal(getParty(state, "patel").status, "waiting");
  assert.deepEqual(getParty(state, "patel").candidateTableIds, []);

  const result = assignTable(state, "patel", "V1", { source: "host" });
  assert.equal(result.ok, true);
  assert.equal(getParty(state, "patel").status, "seated");
  assert.equal(getTable(state, "V1").partyId, "patel");
});

test("automated seating honors an available reservation before a walk-in, while the host can override", () => {
  const state = createInitialState();
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
  const state = createInitialState();
  const reservation = getParty(state, "patel");
  const walkIn = getParty(state, "diaz");
  reservation.status = "waiting";
  walkIn.status = "waiting";

  assert.equal(assignTable(state, reservation.id, "V1", { source: "agent" }).ok, true);
  assert.equal(getReservationPriorityBlocker(state, walkIn), null);
  assert.equal(assignTable(state, walkIn.id, "R1", { source: "agent" }).ok, true);
});

test("an autonomous agent's simultaneous deadlines commit in reservation-first order", () => {
  const state = createInitialState();
  state.now = FIRST_SEATING;
  attachExternalAgent(state, "Table Pilot", "autonomous");
  const reservation = getParty(state, "patel");
  const walkIn = getParty(state, "diaz");
  reservation.status = "waiting";
  walkIn.status = "waiting";

  assert.equal(setCandidates(state, walkIn.id, ["R1"], state.now + AGENT_FREEZE_WINDOW_MINUTES, { source: "agent" }).ok, true);
  assert.equal(setCandidates(state, reservation.id, ["V1"], state.now + AGENT_FREEZE_WINDOW_MINUTES, { source: "agent" }).ok, true);
  assert.equal(walkIn.autoAssignAt, state.now + AGENT_FREEZE_WINDOW_MINUTES);

  advanceTo(state, state.now + AGENT_FREEZE_WINDOW_MINUTES);
  assert.equal(state.seatingRecords[0].partyId, reservation.id);
  assert.equal(reservation.status, "seated");
  assert.equal(walkIn.status, "seated");
});

test("children make non-high-chair tables illegal for agent and host", () => {
  const state = createInitialState();
  advanceTo(state, FIRST_SEATING + 18);

  for (const tableId of ["B3", "B4", "S5", "C1", "C6"]) {
    const legality = checkAssignmentLegality(state, "haddad", tableId, { forCandidate: true, source: "host" });
    assert.equal(legality.legal, false, `${tableId} must reject a party needing a high chair`);
    assert.match(legality.reasons.join(" "), /high chair/i);
  }
  assert.equal(checkAssignmentLegality(state, "haddad", "V3", { forCandidate: true, source: "host" }).legal, true);
});

test("candidate sets reject an illegal child seating before publication", () => {
  const state = createInitialState();
  advanceTo(state, FIRST_SEATING + 18);

  const result = setCandidates(state, "haddad", ["B3", "V3"], state.now + 3, { source: "agent" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ILLEGAL_CANDIDATE");
  assert.deepEqual(getParty(state, "haddad").candidateTableIds, []);
});

test("a host lock is a hard constraint for host and agent alike", () => {
  const state = createInitialState();
  advanceTo(state, FIRST_SEATING);
  lockTable(state, "V1", "Anniversary photo setup", { source: "host" });

  const result = assignTable(state, "patel", "V1", { source: "host" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ILLEGAL_ASSIGNMENT");
  assert.match(result.error.message, /locked/i);
});

test("accessibility requirement filters every unmarked table", () => {
  const state = createInitialState();
  const party = getParty(state, "cohen");
  party.status = "waiting";
  party.needsAccessible = true;

  assert.equal(checkAssignmentLegality(state, "cohen", "S2", { forCandidate: true }).legal, false);
  assert.equal(checkAssignmentLegality(state, "cohen", "S1", { forCandidate: true }).legal, true);
  assert.equal(checkAssignmentLegality(state, "cohen", "V3", { forCandidate: true }).legal, true);
});

test("a party of three can be seated at a four-seat table", () => {
  const state = createInitialState();
  const party = getParty(state, "cohen");
  party.status = "waiting";

  assert.equal(checkAssignmentLegality(state, party.id, "V3", { forCandidate: true, source: "host" }).legal, true);
  assert.equal(assignTable(state, party.id, "V3", { source: "host" }).ok, true);
  assert.equal(getTable(state, "V3").partyId, party.id);
});

test("host can override the private-room minimum but not table capacity", () => {
  const state = createInitialState();
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

test("a departed party leaves a table dirty for exactly three minutes", () => {
  const state = createInitialState();
  const party = getParty(state, "patel");
  party.status = "waiting";
  const seated = assignTable(state, "patel", "V1", { source: "host" });
  assert.equal(seated.ok, true);
  const dueAt = getTable(state, "V1").dueAt;
  assert.equal(dueAt, state.now + EXPECTED_DWELL_MINUTES);

  advanceTo(state, dueAt);
  assert.equal(getTable(state, "V1").status, "dirty");
  assert.equal(getTable(state, "V1").dirtyUntil, dueAt + TABLE_RESET_MINUTES);
  assert.equal(getParty(state, "patel").status, "left");
  const dirtySnapshot = getFloorSnapshot(state).tables.find((table) => table.id === "V1");
  assert.equal(dirtySnapshot.dirtyUntil, dueAt + TABLE_RESET_MINUTES);
  assert.deepEqual(dirtySnapshot.likelyFree, {
    earliest: dueAt + TABLE_RESET_MINUTES,
    latest: dueAt + TABLE_RESET_MINUTES
  });

  assert.equal(TABLE_RESET_MINUTES, 3);
  advanceTo(state, dueAt + TABLE_RESET_MINUTES - 1);
  assert.equal(getTable(state, "V1").status, "dirty");

  advanceTo(state, dueAt + TABLE_RESET_MINUTES);
  assert.equal(getTable(state, "V1").status, "free");
});

test("assignment provenance is HOST or AI only and the end-of-service recap is auditable", () => {
  const state = createInitialState();
  const party = getParty(state, "patel");
  party.status = "waiting";
  const result = assignTable(state, party.id, "V1", { source: "host", reason: "Keep the reservation near the window." });

  assert.equal(result.ok, true);
  assert.deepEqual(getTable(state, "V1").assignmentOrigin, { kind: "host", label: "Host" });
  assert.equal(getTable(state, "V1").assignmentReason, "Keep the reservation near the window.");

  attachExternalAgent(state, "Table Pilot", "autonomous");
  getParty(state, "brooks").status = "waiting";
  assert.equal(assignTable(state, "brooks", "D2", { source: "agent", reason: "Right-sized 2-top." }).ok, true);
  assert.deepEqual(getTable(state, "D2").assignmentOrigin, { kind: "external", label: "Table Pilot" });

  advanceTo(state, SERVICE_END);
  const recap = getServiceRecap(state);
  assert.equal(recap.status, "complete");
  assert.equal(recap.official, false);
  assert.ok(recap.score >= 0 && recap.score <= 100);
  assert.equal(recap.components.length, 5);
  assert.equal(recap.briefResults.length, 2);
  assert.deepEqual(recap.provenance.map((origin) => origin.kind).sort(), ["external", "host"]);
  assert.equal(recap.provenance.find((origin) => origin.kind === "host").assignments, 1);
  assert.equal(getFloorSnapshot(state).serviceRecap.score, recap.score);
});
