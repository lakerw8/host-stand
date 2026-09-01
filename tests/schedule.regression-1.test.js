import test from "node:test";
import assert from "node:assert/strict";

import { FIRST_SEATING, SERVICE_END, createRandomNightScenario } from "../src/data.js";

// Regression: ISSUE-001 — a valid random night could create more reservations than schedule slots.
// Found by /qa on 2026-08-31.
// Report: .gstack/qa-reports/qa-report-host-stand-nine-vercel-app-2026-08-31.md
test("every generated reservation receives a valid in-service time", () => {
  const overflowNight = createRandomNightScenario("schedule-overflow-4");
  const reservations = overflowNight.parties.filter((party) => party.source === "reservation");

  assert.equal(overflowNight.parties.length, 93);
  assert.equal(reservations.length, 61);
  assert.ok(reservations.every((party) => Number.isFinite(party.reservedFor)));
  assert.ok(reservations.every((party) => party.reservedFor >= FIRST_SEATING));
  assert.ok(reservations.every((party) => party.reservedFor < SERVICE_END));
});
