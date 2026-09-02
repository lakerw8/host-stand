import test from "node:test";
import assert from "node:assert/strict";

import { createInitialState } from "../src/engine.js";
import { createToolDefinitions, executeToolDefinition, validateToolInput } from "../src/webmcp.js";

function createHarness() {
  const state = createInitialState({ preferenceSeed: "webmcp-contract" });
  let changes = 0;
  const clock = {
    pause() { state.running = false; },
    resume() { state.running = true; },
    setSpeed(speed) { state.speed = speed; }
  };
  const definitions = createToolDefinitions({ state, clock, onChange: () => { changes += 1; } });
  const execute = (name, input = {}, options = {}) => {
    const definition = definitions.find((tool) => tool.name === name);
    assert.ok(definition, `Missing tool ${name}`);
    return executeToolDefinition(definition, input, options);
  };
  return { state, definitions, execute, get changes() { return changes; } };
}

test("the WebMCP catalog is discoverable, unique, and uses current annotations", () => {
  const { definitions } = createHarness();
  const names = definitions.map((tool) => tool.name);
  const readTools = new Set(["get_floor", "get_queue", "score_assignment"]);
  const untrustedTools = new Set(["get_floor", "get_queue"]);

  assert.equal(definitions.length, 21);
  assert.equal(new Set(names).size, definitions.length);
  for (const tool of definitions) {
    assert.match(tool.name, /^[A-Za-z0-9_.-]{1,128}$/);
    assert.ok(tool.title.length >= 1);
    assert.ok(tool.description.length >= 20);
    assert.doesNotThrow(() => JSON.stringify(tool.inputSchema));
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.annotations).sort(), ["readOnlyHint", "untrustedContentHint"]);
    assert.equal(tool.annotations.readOnlyHint, readTools.has(tool.name));
    assert.equal(tool.annotations.untrustedContentHint, untrustedTools.has(tool.name), `${tool.name} untrustedContentHint`);
    for (const required of tool.inputSchema.required || []) {
      assert.ok(required in tool.inputSchema.properties, `${tool.name}.${required} must have a schema`);
    }
  }
});

test("WebMCP input validation rejects missing, extra, mistyped, and oversized arguments", async () => {
  const { definitions, execute } = createHarness();
  const getFloor = definitions.find((tool) => tool.name === "get_floor");

  assert.equal(validateToolInput(getFloor.inputSchema, {}).ok, true);
  assert.equal((await execute("get_floor", { unexpected: true })).error.code, "INVALID_INPUT");
  assert.equal((await execute("set_candidates", { party_id: "patel" })).error.code, "INVALID_INPUT");
  assert.equal((await execute("set_candidates", { party_id: "patel", table_ids: ["V1", "V2", "V3", "V4"] })).error.code, "INVALID_INPUT");
  assert.equal((await execute("quote_wait", { party_id: "patel", minutes: "ten" })).error.code, "INVALID_INPUT");
  assert.equal((await execute("lock_table", { table_id: "V1", reason: "x".repeat(161) })).error.code, "INVALID_INPUT");
});

test("an external agent can plan, mutate, verify, and recover through tools only", async () => {
  const harness = createHarness();
  const { execute, state } = harness;

  const initialFloor = await execute("get_floor");
  assert.equal(initialFloor.tables.length, 33);
  assert.equal(initialFloor.capacity, 120);
  assert.equal(initialFloor.tableUnitCount, 33);
  assert.equal(initialFloor.clock, "5:00 PM");
  assert.equal(initialFloor.agentCadence.heartbeatMinutes, 10);
  assert.equal(initialFloor.agentCadence.planningHorizonMinutes, 45);
  assert.equal(initialFloor.agentCadence.freezeWindowMinutes, 5);
  assert.equal(initialFloor.serviceBrief.directives.length, 2);
  assert.deepEqual(initialFloor.serviceBrief.directives.map((directive) => directive.type), ["section_load", "party_proximity"]);
  assert.ok(initialFloor.nextRecommendedActions.length >= 1);

  assert.equal((await execute("set_clock", { time: "6:00 PM", running: false })).ok, true);
  const queue = await execute("get_queue");
  assert.deepEqual(queue.serviceBrief, initialFloor.serviceBrief);
  const patel = queue.reservations.find((party) => party.id === "patel");
  assert.equal(patel.status, "waiting");

  const score = await execute("score_assignment", { party_id: "patel", table_id: "V1" });
  assert.equal(score.legal, true);
  const ranked = await execute("score_assignment", { party_id: "patel" });
  assert.ok(ranked.ranked.length >= 1 && ranked.ranked.length <= 8);
  assert.ok(ranked.ranked.every((entry) => entry.legal && typeof entry.tableId === "string"));
  assert.equal((await execute("set_candidates", { party_id: "patel", table_ids: ["V1", "V2"] })).ok, true);
  assert.equal((await execute("assign_table", { party_id: "patel", table_id: "V1" })).seated, true);

  const seatedFloor = await execute("get_floor");
  const v1 = seatedFloor.tables.find((table) => table.id === "V1");
  assert.equal(v1.partyId, "patel");
  assert.equal(v1.expectedFinishAt, 19 * 60 + 30);

  const occupiedMutation = await execute("mark_table", { table_id: "V1", status: "dirty" });
  assert.equal(occupiedMutation.ok, false);
  assert.equal(occupiedMutation.error.code, "TABLE_OCCUPIED");

  assert.equal((await execute("lock_table", { table_id: "V2", reason: "Protect for anniversary arrival" })).ok, true);
  const lockedFloor = await execute("get_floor");
  assert.equal(lockedFloor.tables.find((table) => table.id === "V2").locked, true);
  assert.equal((await execute("unlock_table", { table_id: "V2" })).error.code, "HOST_ONLY");

  assert.equal((await execute("explain_plan", { bullets: ["Protect V2", "Keep P1 for the eight-top"] })).ok, true);
  assert.match(state.plan, /Protect V2/);
  assert.ok(harness.changes >= 6);
});

test("an external AI can attach explicitly and own autonomous candidate deadlines", async () => {
  const { execute, state } = createHarness();

  const attached = await execute("attach_agent", { agent_name: "Table Pilot", mode: "autonomous" });
  assert.equal(attached.ok, true);
  assert.equal(state.controllerMode, "external");
  assert.equal(state.agentConnection.name, "Table Pilot");

  await execute("set_clock", { time: "6:00 PM", running: false });
  assert.equal((await execute("set_candidates", {
    party_id: "patel",
    table_ids: ["V1", "V2"],
    reason: "Protect the four-tops and keep the reservation near its requested area.",
    auto_assign_at: "6:03 PM"
  })).ok, true);
  await execute("set_clock", { time: "6:03 PM", running: false });
  assert.equal(state.parties.find((party) => party.id === "patel").status, "seated");
  assert.equal(state.tables.find((table) => table.id === "V1").partyId, "patel");
  assert.deepEqual(state.tables.find((table) => table.id === "V1").assignmentOrigin, { kind: "external", label: "Table Pilot" });
  assert.match(state.tables.find((table) => table.id === "V1").assignmentReason, /Protect the four-tops/);

  assert.equal((await execute("detach_agent")).ok, true);
  assert.equal(state.controllerMode, "manual");
  assert.equal(state.agentConnection, null);
});

test("an external agent can publish an upcoming plan that executes when the reservation arrives", async () => {
  const { execute, state } = createHarness();

  assert.equal((await execute("attach_agent", { agent_name: "Table Pilot", mode: "autonomous" })).ok, true);
  const planned = await execute("set_candidates", { party_id: "patel", table_ids: ["V1", "V2"] });
  assert.equal(planned.ok, true);
  assert.equal(planned.autoAssignAt, null);
  assert.equal(state.parties.find((party) => party.id === "patel").candidateState, "tentative");
  assert.equal(state.agentReview.status, "planned");

  await execute("set_clock", { time: "6:00 PM", running: false });
  assert.equal(state.parties.find((party) => party.id === "patel").status, "seated");
  assert.equal(state.tables.find((table) => table.id === "V1").partyId, "patel");
});

test("WebMCP exposes and enforces reservation-first service for external agents", async () => {
  const { execute } = createHarness();
  await execute("set_clock", { time: "6:08 PM", running: false });

  const queue = await execute("get_queue");
  const walkIn = queue.walkIns.find((party) => party.id === "diaz");
  assert.deepEqual(queue.servicePolicy.order, ["waiting_reservation", "waiting_walk_in"]);
  assert.equal(queue.servicePolicy.hostMayOverride, true);
  assert.ok(walkIn.reservationPriorityBlockedBy);

  const score = await execute("score_assignment", { party_id: "diaz", table_id: "R1" });
  assert.equal(score.legal, true);
  assert.equal(score.reservationPriority.blocked, true);
  assert.match(score.reasons[0], /Reservation priority/i);
  assert.equal((await execute("set_candidates", { party_id: "diaz", table_ids: ["R1"] })).ok, true);
  assert.equal((await execute("hold_table", { party_id: "diaz", table_id: "R1", until: "6:30 PM" })).error.code, "RESERVATION_PRIORITY");

  const assignment = await execute("assign_table", { party_id: "diaz", table_id: "R1" });
  assert.equal(assignment.ok, false);
  assert.equal(assignment.error.code, "RESERVATION_PRIORITY");
});

test("upcoming reservations can be scored but cannot be seated before arrival", async () => {
  const { execute } = createHarness();
  const score = await execute("score_assignment", { party_id: "alvarez", table_id: "R1" });
  assert.equal(score.legal, true);

  const plan = await execute("set_candidates", { party_id: "alvarez", table_ids: ["R1"] });
  assert.equal(plan.ok, true);
  assert.equal(plan.autoAssignAt, null);

  const assignment = await execute("assign_table", { party_id: "alvarez", table_id: "R1" });
  assert.equal(assignment.ok, false);
  assert.equal(assignment.error.code, "ILLEGAL_ASSIGNMENT");
});

test("add_host_note creates or appends a host-sourced request and asks the agent to review", async () => {
  const { execute, state } = createHarness();
  assert.equal((await execute("attach_agent", { agent_name: "Table Pilot", mode: "advisory" })).ok, true);
  assert.equal((await execute("set_candidates", { party_id: "patel", table_ids: ["V1"], reason: "Window." })).ok, true);
  assert.equal(state.agentReview.status, "planned");

  const created = await execute("add_host_note", { party_id: "patel", text: "Birthday candle at dessert." });
  assert.equal(created.ok, true);
  assert.deepEqual(created.request, { text: "Birthday candle at dessert.", source: "host" });
  assert.equal(state.parties.find((party) => party.id === "patel").request.ground, null);
  assert.equal(state.agentReview.status, "review_due");
  assert.equal(state.agentReview.reason, "host note added");

  const appended = await execute("add_host_note", { party_id: "patel", text: "Also gluten-free." });
  assert.equal(appended.request.text, "Birthday candle at dessert. — Also gluten-free.");
  const queue = await execute("get_queue");
  assert.equal(queue.reservations.find((party) => party.id === "patel").request.source, "host");
  assert.equal(queue.openRequests.find((request) => request.partyId === "patel").status, "open");

  assert.equal((await execute("add_host_note", { party_id: "patel", text: "" })).error.code, "INVALID_INPUT");
  assert.equal((await execute("add_host_note", { party_id: "patel", text: "x".repeat(281) })).error.code, "INVALID_INPUT");
  assert.equal((await execute("add_host_note", { party_id: "nobody", text: "Hello" })).error.code, "PARTY_NOT_FOUND");
});

test("mark_party accepts rush, allergy, and discreet marks alongside status", async () => {
  const { execute, state } = createHarness();
  await execute("set_clock", { time: "6:00 PM", running: false });
  assert.equal((await execute("assign_table", { party_id: "patel", table_id: "V1", reason: "Window." })).ok, true);
  const table = state.tables.find((entry) => entry.id === "V1");
  assert.equal(table.dueAt, 18 * 60 + 90);

  const rushed = await execute("mark_party", { party_id: "patel", rush: true });
  assert.equal(rushed.ok, true);
  assert.deepEqual(rushed.marks, { rush: true, allergy: false, discreet: false });
  assert.equal(table.dueAt, 18 * 60 + 60);
  const floor = await execute("get_floor");
  assert.deepEqual(floor.tables.find((entry) => entry.id === "V1").partyMarks, { rush: true, allergy: false });

  const discreet = await execute("mark_party", { party_id: "brooks", discreet: true });
  assert.equal(discreet.ok, true);
  assert.equal(state.activity[0].detail, "Brooks · note recorded");

  const combined = await execute("mark_party", { party_id: "rossi", status: "arrived", allergy: true });
  assert.equal(combined.ok, true);
  assert.equal(combined.status, "waiting");
  assert.equal(state.parties.find((party) => party.id === "rossi").marks.allergy, true);

  assert.equal((await execute("mark_party", { party_id: "patel" })).error.code, "INVALID_INPUT");
  assert.equal((await execute("mark_party", { party_id: "patel", rush: "yes" })).error.code, "INVALID_INPUT");
});

test("an already-aborted WebMCP call returns a structured cancellation error", async () => {
  const { execute } = createHarness();
  const controller = new AbortController();
  controller.abort();
  const result = await execute("get_floor", {}, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ABORTED");
});
