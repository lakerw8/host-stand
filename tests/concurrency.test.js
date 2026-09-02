import test from "node:test";
import assert from "node:assert/strict";

import { FIRST_SEATING } from "../src/data.js";
import { CHANGE_LOG_LIMIT, advanceTo, assignTable, changesSince, createInitialState, getParty, jumpClock, lockTable } from "../src/engine.js";
import { createToolDefinitions, executeToolDefinition } from "../src/webmcp.js";

function createHarness() {
  const state = createInitialState({ preferenceSeed: "concurrency" });
  const clock = { pause() { state.running = false; }, resume() { state.running = true; }, setSpeed(speed) { state.speed = speed; } };
  const definitions = createToolDefinitions({ state, clock, onChange: () => {} });
  const execute = (name, input = {}) => executeToolDefinition(definitions.find((tool) => tool.name === name), input);
  return { state, definitions, execute };
}

test("every write tool accepts expected_version and every read returns floorVersion", async () => {
  const { definitions, execute } = createHarness();
  for (const tool of definitions) {
    const accepts = "expected_version" in tool.inputSchema.properties;
    assert.equal(accepts, !tool.annotations.readOnlyHint, `${tool.name} expected_version`);
    if (accepts) assert.match(tool.description, /expected_version/);
  }
  const floor = await execute("get_floor");
  const queue = await execute("get_queue");
  assert.equal(typeof floor.floorVersion, "number");
  assert.equal(floor.floorVersion, queue.floorVersion);
  assert.ok(Array.isArray(floor.recentChanges));
});

test("a stale agent write is rejected with the diff, then succeeds with the current version", async () => {
  const { execute, state } = createHarness();
  await execute("attach_agent", { agent_name: "Table Pilot", mode: "advisory" });
  await execute("set_clock", { time: "6:00 PM", running: false });

  const read = await execute("get_queue");
  const version = read.floorVersion;
  assert.equal(getParty(state, "patel").status, "waiting");

  // The host drags Patel to V1 between the agent's read and its write.
  const hostDrag = assignTable(state, "patel", "V1", { source: "host" });
  assert.equal(hostDrag.ok, true);
  assert.equal(state.floorVersion, version + 1);

  const stale = await execute("assign_table", { party_id: "nguyen", table_id: "D1", reason: "Right-sized.", expected_version: version });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "STALE_STATE");
  assert.equal(stale.error.message, `Floor changed since version ${version}.`);
  assert.equal(stale.error.currentVersion, version + 1);
  assert.equal(stale.error.changes.length, 1);
  assert.deepEqual(
    { type: stale.error.changes[0].type, partyId: stale.error.changes[0].partyId, tableId: stale.error.changes[0].tableId, by: stale.error.changes[0].by, version: stale.error.changes[0].version },
    { type: "assignment", partyId: "patel", tableId: "V1", by: "HOST", version: version + 1 }
  );
  assert.equal(getParty(state, "nguyen").status, "waiting");
  assert.equal(state.activity[0].tool, "stale_write");
  assert.match(state.activity[0].detail, /Agent write rejected — floor changed \(v\d+ → v\d+\) · assign_table/);

  const fresh = await execute("assign_table", { party_id: "nguyen", table_id: "D1", reason: "Right-sized.", expected_version: version + 1 });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.floorVersion, version + 2);
  assert.equal(getParty(state, "nguyen").status, "seated");
});

test("omitting expected_version keeps writes backward compatible while reads nudge the agent", async () => {
  const { execute, state } = createHarness();
  const attached = await execute("attach_agent", { agent_name: "Table Pilot", mode: "autonomous" });
  assert.match(attached.concurrency, /expected_version/);
  assert.equal(attached.floorVersion, state.floorVersion);
  lockTable(state, "V1", "Photo", { source: "host" });
  const plan = await execute("set_candidates", { party_id: "patel", table_ids: ["V2"], reason: "Window." });
  assert.equal(plan.ok, true);
  assert.equal(plan.floorVersion, state.floorVersion);
  const queue = await execute("get_queue");
  assert.ok(queue.nextRecommendedActions.some((action) => action.includes(`expected_version: ${state.floorVersion}`)));
  assert.equal((await execute("set_candidates", { party_id: "patel", table_ids: ["V2"], expected_version: -1 })).error.code, "INVALID_INPUT");
});

test("the change log records host, agent, and clock mutations and keeps the last 50", () => {
  const state = createInitialState({ preferenceSeed: "concurrency-log" });
  const start = state.floorVersion;
  jumpClock(state, FIRST_SEATING, { source: "host" });
  assert.ok(state.changeLog.some((change) => change.type === "arrival" && change.by === "CLOCK"));
  assert.ok(state.changeLog.some((change) => change.type === "clock" && change.by === "HOST"));
  assert.ok(state.floorVersion > start);

  for (let index = 0; index < 60; index += 1) {
    lockTable(state, "V1", `Lock ${index}`, { source: "host" });
  }
  assert.equal(state.changeLog.length, CHANGE_LOG_LIMIT);
  assert.equal(state.changeLog.at(-1).version, state.floorVersion);
  const since = changesSince(state, state.floorVersion - 3);
  assert.equal(since.changes.length, 3);
  assert.equal(since.truncated, false);
  const ancient = changesSince(state, 0);
  assert.equal(ancient.changes.length, CHANGE_LOG_LIMIT);
  assert.equal(ancient.truncated, true);

  const before = state.floorVersion;
  advanceTo(state, state.now + 1);
  assert.equal(state.floorVersion, before, "an uneventful minute does not change the floor version");
});
