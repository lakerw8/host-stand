import test from "node:test";
import assert from "node:assert/strict";

import { SERVICE_END, createRandomNightScenario } from "../src/data.js";

// Regression: ISSUE-003 — reservation arrivals used an undocumented -4 to +10 minute range.
// Found by /qa on 2026-08-31.
// Report: .gstack/qa-reports/qa-report-host-stand-nine-vercel-app-2026-08-31.md
test("random reservations use only 0, 10, or 20-minute lateness and fixed no-show timing", () => {
  const observedArrivalDeltas = new Set();
  let noShowCount = 0;

  for (let index = 0; index < 100; index += 1) {
    const scenario = createRandomNightScenario(`lateness-audit-${index}`);
    const reservations = scenario.parties.filter((party) => party.source === "reservation");

    for (const party of reservations) {
      const event = scenario.events.find((candidate) => candidate.partyIds?.includes(party.id));
      assert.ok(event, `missing event for ${party.id}`);

      if (event.type === "arrival") {
        const delta = event.minute - party.reservedFor;
        observedArrivalDeltas.add(delta);
        assert.ok([0, 10, 20].includes(delta), `${party.id} arrived ${delta} minutes from its reservation`);
      } else {
        noShowCount += 1;
        assert.equal(event.type, "no_show");
        assert.equal(event.minute, Math.min(SERVICE_END - 1, party.reservedFor + 20));
      }
    }
  }

  assert.deepEqual([...observedArrivalDeltas].sort((left, right) => left - right), [0, 10, 20]);
  assert.ok(noShowCount > 0);
});
