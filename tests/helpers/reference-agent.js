import { advanceTo, assignTable, attachExternalAgent, getWaitingParties, rankCandidateTables } from "../../src/engine.js";

// A deliberately simple scripted client of the engine's scoring service. It stands in
// for a browser agent during simulation tests. The product itself ships no planner:
// the engine enforces, an attached agent reasons.
export function attachReferenceAgent(state, name = "Reference agent") {
  if (state.controllerMode !== "external") attachExternalAgent(state, name, "autonomous");
  return state;
}

export function seatWaitingParties(state) {
  let seated = 0;
  const waiting = getWaitingParties(state)
    .filter((party) => !party.committedTableId)
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === "reservation" ? -1 : 1;
      return (left.reservedFor ?? left.arrivedAt) - (right.reservedFor ?? right.arrivedAt);
    });
  for (const party of waiting) {
    const ranked = rankCandidateTables(state, party.id).filter((entry) => entry.availabilityDelay === 0);
    if (!ranked.length) continue;
    const top = ranked[0];
    const result = assignTable(state, party.id, top.tableId, { source: "agent", reason: top.reasons.slice(0, 2).join("; ") });
    if (result.ok) seated += 1;
  }
  return seated;
}

export function runReferenceAgent(state, untilMinute, options = {}) {
  attachReferenceAgent(state);
  seatWaitingParties(state);
  options.onMinute?.(state);
  while (state.now < untilMinute) {
    advanceTo(state, state.now + 1);
    seatWaitingParties(state);
    options.onMinute?.(state);
  }
  return state;
}
