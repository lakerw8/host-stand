import {
  EXPECTED_DWELL_MINUTES,
  RESTAURANT_CAPACITY,
  SCRIPTED_EVENTS,
  SERVICE_END,
  SERVICE_START,
  TABLE_DEFINITIONS,
  createNightParties,
  createRandomNightScenario,
  createServiceBrief,
  minutesToTime
} from "./data.js";

const clone = (value) => (
  typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
);

const clamp = (value, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, value));

export const AGENT_HEARTBEAT_MINUTES = 10;
export const AGENT_PLANNING_HORIZON_MINUTES = 45;
export const AGENT_FREEZE_WINDOW_MINUTES = 5;
export const AGENT_STABILITY_THRESHOLD = 0.1;
export const TABLE_RESET_MINUTES = 3;

const runtimeTable = (definition) => ({
  ...clone(definition),
  status: "free",
  locked: false,
  lockedBy: null,
  lockReason: null,
  partyId: null,
  heldForPartyId: null,
  holdUntil: null,
  nextPartyId: null,
  seatedAt: null,
  dueAt: null,
  dirtyUntil: null,
  assignmentOrigin: null,
  assignmentReason: null
});

const runtimeParty = (definition) => ({
  ...clone(definition),
  status: "upcoming",
  candidateTableIds: [],
  autoAssignAt: null,
  candidateState: "unplanned",
  candidateUpdatedAt: null,
  candidateFrozen: false,
  hostOverrideTableId: null,
  committedTableId: null,
  seatedAt: null,
  leftAt: null,
  assignedBy: null,
  assignmentOrigin: null,
  assignmentReason: null,
  candidateReason: null,
  seatingScore: null
});

export function createInitialState(options = {}) {
  const scenarioSeed = options.scenarioSeed ?? options.preferenceSeed ?? "host-stand-saturday";
  const scriptedParties = options.randomizeScenario ? null : createNightParties(scenarioSeed);
  const scenario = options.randomizeScenario
    ? createRandomNightScenario(scenarioSeed)
    : {
        parties: scriptedParties,
        events: clone(SCRIPTED_EVENTS),
        serviceBrief: createServiceBrief(scriptedParties, `${scenarioSeed}-brief`, { excludedPartyIds: ["alvarez"] }),
        seed: String(scenarioSeed),
        runCode: "SATURDAY"
      };
  const agentEnabled = options.agentEnabled ?? true;
  const state = {
    now: SERVICE_START,
    running: options.running ?? false,
    speed: options.speed ?? 1,
    agentEnabled,
    controllerMode: agentEnabled ? "local" : "manual",
    agentConnection: null,
    agentReview: {
      status: agentEnabled ? "reviewing" : "manual",
      reason: agentEnabled ? "opening plan" : "manual control",
      lastReviewAt: null,
      nextReviewAt: agentEnabled ? SERVICE_START + AGENT_HEARTBEAT_MINUTES : null,
      requestedAt: null,
      plannedPartyCount: 0,
      changedPartyCount: 0
    },
    weights: { sat: 0.6, turn: 0.4 },
    tables: TABLE_DEFINITIONS.map(runtimeTable),
    parties: scenario.parties.map(runtimeParty),
    events: scenario.events,
    serviceBrief: clone(scenario.serviceBrief),
    scenarioSeed: scenario.seed,
    runCode: scenario.runCode,
    preferenceSeed: scenario.seed,
    processedEvents: [],
    kitchenDelayUntil: null,
    activity: [
      {
        minute: SERVICE_START,
        tool: "get_floor",
        detail: "Service snapshot ready",
        source: "system"
      }
    ],
    plan: "Doors open at 5:00. The floor is clear and the agent is watching the arrival book.",
    planBullets: ["Seat waiting reservations before walk-ins when a legal table is available", "Respect host overrides as fixed", "Protect right-sized tables for the full service"],
    seatingRecords: [],
    coversHistory: [],
    scoreHistory: [],
    lastError: null,
    revision: 0
  };
  if (state.agentEnabled) runAgentCycle(state, { reason: "opening plan", log: false, allowAutoCommit: false });
  return state;
}

export const elapsedToSimMinutes = (elapsedMilliseconds, speed = 1) => (
  Math.max(0, elapsedMilliseconds) / 1000 * speed
);

export const getTable = (state, tableId) => state.tables.find((table) => table.id === tableId) || null;
export const getParty = (state, partyId) => state.parties.find((party) => party.id === partyId) || null;

export function getWaitingParties(state) {
  return state.parties.filter((party) => party.status === "waiting");
}

function bump(state) {
  state.revision += 1;
}

export function logActivity(state, tool, detail, source = "agent") {
  if (source === "agent" && state.controllerMode === "external" && state.agentConnection) {
    state.agentConnection.lastSeenAt = state.now;
  }
  state.activity.unshift({ minute: state.now, tool, detail, source });
  state.activity = state.activity.slice(0, 18);
  bump(state);
}

function success(state, value = {}) {
  state.lastError = null;
  return { ok: true, ...value };
}

function failure(state, code, message, details = {}) {
  state.lastError = { code, message, minute: state.now };
  bump(state);
  return { ok: false, error: { code, message, ...details } };
}

function preferenceMatches(party, table) {
  const matchers = {
    view: table.zone === "view",
    quiet: table.quiet,
    away_kitchen: !table.nearKitchen,
    counter: table.zone === "counter",
    booth: table.shape === "booth",
    private: table.zone === "private",
    round: table.shape === "round",
    together: true
  };
  return party.preferences.filter((preference) => matchers[preference]);
}

function tableGridDistance(leftTable, rightTable) {
  if (!leftTable || !rightTable) return null;
  const leftColumn = leftTable.layout.column + (leftTable.layout.columnSpan - 1) / 2;
  const leftRow = leftTable.layout.row + (leftTable.layout.rowSpan - 1) / 2;
  const rightColumn = rightTable.layout.column + (rightTable.layout.columnSpan - 1) / 2;
  const rightRow = rightTable.layout.row + (rightTable.layout.rowSpan - 1) / 2;
  return Math.abs(leftColumn - rightColumn) + Math.abs(leftRow - rightRow);
}

function serviceBriefAdjustment(state, party, table) {
  const directives = state.serviceBrief?.directives || [];
  const targetMinute = party.status === "upcoming" ? party.reservedFor : state.now;
  let adjustment = 0;
  const reasons = [];

  for (const directive of directives) {
    if (directive.type === "section_load"
      && targetMinute >= directive.from
      && targetMinute < directive.until
      && table.zone === directive.zone) {
      adjustment -= 0.26;
      reasons.push(`${directive.server}’s ${directive.sectionLabel} is overloaded`);
    }
    if (directive.type === "party_proximity" && directive.partyIds.includes(party.id)) {
      const otherPartyId = directive.partyIds.find((partyId) => partyId !== party.id);
      const otherParty = getParty(state, otherPartyId);
      const otherTableId = otherParty?.committedTableId
        || otherParty?.hostOverrideTableId
        || otherParty?.candidateTableIds?.[0];
      const otherTable = otherTableId ? getTable(state, otherTableId) : null;
      const distance = tableGridDistance(table, otherTable);
      if (distance != null) {
        const nearby = distance <= directive.maxTableDistance;
        adjustment += nearby ? 0.16 : -0.16;
        reasons.push(`${nearby ? "near" : "far from"} ${otherParty.name} at ${otherTable.id}`);
      }
    }
  }

  return { adjustment, reasons };
}

function projectedFreeMinute(table, now) {
  if (table.status === "free") return now;
  if (table.status === "held") return table.holdUntil ?? now + 20;
  if (table.status === "seated") return (table.dueAt ?? now + EXPECTED_DWELL_MINUTES) + TABLE_RESET_MINUTES;
  if (table.status === "dirty") return table.dirtyUntil ?? now + TABLE_RESET_MINUTES;
  return now + 60;
}

export function checkAssignmentLegality(state, partyId, tableId, options = {}) {
  const party = getParty(state, partyId);
  const table = getTable(state, tableId);
  const forCandidate = options.forCandidate ?? false;
  const allowUpcoming = options.allowUpcoming ?? false;
  const source = options.source || "agent";
  const reasons = [];

  if (!party) reasons.push(`Party ${partyId} does not exist.`);
  if (!table) reasons.push(`Table ${tableId} does not exist.`);
  if (!party || !table) return { legal: false, reasons };

  const isUpcomingForecast = forCandidate && allowUpcoming && party.status === "upcoming" && party.source === "reservation";
  if (!["waiting", "seated"].includes(party.status) && !isUpcomingForecast) reasons.push(`${party.name} is not available to assign.`);
  if (party.size > table.seats) reasons.push(`${table.id} seats ${table.seats}; ${party.name} has ${party.size}.`);
  if (party.children >= 1 && !table.highChair) reasons.push(`${table.id} cannot take a high chair.`);
  if (party.needsAccessible && !table.accessible) reasons.push(`${table.id} is not marked accessible.`);
  if (table.zone === "private" && party.size < 5 && source !== "host") reasons.push(`${table.id} is reserved for parties of five or more.`);
  if (table.locked) reasons.push(`${table.id} is host-locked.`);
  if (table.heldForPartyId && table.heldForPartyId !== party.id) reasons.push(`${table.id} is held for another party.`);
  if (table.nextPartyId && table.nextPartyId !== party.id) reasons.push(`${table.id} is already committed to another waiting party.`);
  if (!forCandidate && table.status === "held" && table.heldForPartyId !== party.id) reasons.push(`${table.id} cannot be seated while held.`);

  return { legal: reasons.length === 0, reasons };
}

export function getReservationPriorityBlocker(state, party) {
  if (!party || party.source !== "walk_in" || party.status !== "waiting") return null;
  const waitingReservations = state.parties
    .filter((candidate) => (
      candidate.source === "reservation"
      && candidate.status === "waiting"
      && !candidate.committedTableId
    ))
    .sort((left, right) => left.reservedFor - right.reservedFor);

  for (const reservation of waitingReservations) {
    const availableTableIds = state.tables
      .filter((table) => table.status === "free" || (table.status === "held" && table.heldForPartyId === reservation.id))
      .filter((table) => checkAssignmentLegality(state, reservation.id, table.id, { source: "agent" }).legal)
      .map((table) => table.id);
    if (availableTableIds.length) {
      return {
        partyId: reservation.id,
        partyName: reservation.name,
        reservedFor: reservation.reservedFor,
        availableTableIds
      };
    }
  }
  return null;
}

export function scoreAssignment(state, partyId, tableId, options = {}) {
  const legality = checkAssignmentLegality(state, partyId, tableId, { ...options, forCandidate: options.forCandidate ?? true });
  const party = getParty(state, partyId);
  const table = getTable(state, tableId);
  if (!legality.legal || !party || !table) {
    return { legal: false, score: 0, sat: 0, turn: 0, reasons: legality.reasons };
  }

  const waited = Math.max(0, state.now - (party.source === "walk_in" ? party.arrivedAt : party.reservedFor));
  const waitPenaltyMinutes = party.source === "reservation" ? Math.max(0, waited - 5) : waited;
  let waitScore = clamp(1 - waitPenaltyMinutes / 40);
  if (party.quotedWaitMin != null && waited > party.quotedWaitMin) {
    waitScore = clamp(waitScore - (waited - party.quotedWaitMin) / 60);
  }

  const matches = preferenceMatches(party, table);
  const prefScore = party.preferences.length ? matches.length / party.preferences.length : 1;
  const sat = clamp(0.5 * waitScore + 0.5 * prefScore);

  const sizeEfficiency = party.size / table.seats;
  let turn = 0.82 * sizeEfficiency;
  if (!party.preferences.length && table.zone === "kitchen") turn += 0.16;
  if (party.size <= 2 && table.zone === "counter") turn += 0.14;
  if (table.zone === "private" && party.size < table.seats - 1) turn -= 0.22;
  if (state.kitchenDelayUntil && state.now < state.kitchenDelayUntil && table.zone === "kitchen") turn -= 0.3;
  turn = clamp(turn);

  const targetMinute = party.status === "upcoming" ? party.reservedFor : state.now;
  const availabilityDelay = Math.max(0, projectedFreeMinute(table, state.now) - targetMinute);
  const availabilityPenalty = Math.min(0.35, availabilityDelay / 120)
    * (0.25 + state.weights.turn * 1.5);
  const regularBoost = party.isRegular ? 0.025 : 0;
  const brief = serviceBriefAdjustment(state, party, table);
  const score = clamp(state.weights.sat * sat + state.weights.turn * turn + regularBoost - availabilityPenalty + brief.adjustment);
  const priorityBlocker = getReservationPriorityBlocker(state, party);

  const reasons = [
    ...(priorityBlocker ? [`Reservation priority: seat ${priorityBlocker.partyName} first`] : []),
    ...brief.reasons,
    `${matches.length}/${party.preferences.length || 0} stated preferences matched`,
    `${Math.round(sizeEfficiency * 100)}% seat fit`,
    availabilityDelay ? `likely available in ${availabilityDelay} min` : "available now"
  ];

  return {
    legal: true,
    score,
    sat,
    turn,
    waitScore,
    prefScore,
    matchedPreferences: matches,
    availabilityDelay,
    serviceBriefAdjustment: brief.adjustment,
    serviceBriefReasons: brief.reasons,
    reservationPriority: priorityBlocker
      ? { blocked: true, ...priorityBlocker, hostMayOverride: true }
      : { blocked: false, hostMayOverride: true },
    reasons
  };
}

function priorityValue(state, party) {
  const lateReservation = party.source === "reservation" && state.now > party.reservedFor + 5 ? 10000 : 0;
  const regular = party.isRegular ? 5000 : 0;
  const origin = party.source === "walk_in" ? party.arrivedAt : party.reservedFor;
  return lateReservation + regular + Math.max(0, state.now - origin);
}

function rankedCandidateScores(state, party) {
  return state.tables
    .map((table) => ({ table, result: scoreAssignment(state, party.id, table.id, { forCandidate: true, allowUpcoming: true }) }))
    .filter(({ result }) => result.legal)
    .sort((left, right) => right.result.score - left.result.score || left.result.availabilityDelay - right.result.availabilityDelay || left.table.seats - right.table.seats);
}

function rankedCandidates(state, party) {
  return rankedCandidateScores(state, party).slice(0, 3).map(({ table }) => table.id);
}

function partyPlanningMinute(state, party) {
  return party.status === "upcoming" ? party.reservedFor : state.now;
}

function isInsidePlanningHorizon(state, party) {
  if (party.status === "waiting") return !party.committedTableId;
  return party.source === "reservation"
    && party.status === "upcoming"
    && party.reservedFor <= state.now + AGENT_PLANNING_HORIZON_MINUTES;
}

function planningOrder(state, left, right) {
  if (left.status !== right.status) return left.status === "waiting" ? -1 : 1;
  if (left.status === "waiting") {
    if (left.source !== right.source) return left.source === "reservation" ? -1 : 1;
    return priorityValue(state, right) - priorityValue(state, left);
  }
  return left.reservedFor - right.reservedFor || priorityValue(state, right) - priorityValue(state, left);
}

function clearCandidatePlan(party) {
  party.candidateTableIds = [];
  party.autoAssignAt = null;
  party.candidateState = "unplanned";
  party.candidateUpdatedAt = null;
  party.candidateFrozen = false;
  party.candidateReason = null;
}

function scheduledCandidateScores(state, party, tableAvailableAt) {
  const targetMinute = partyPlanningMinute(state, party);
  return rankedCandidateScores(state, party)
    .map((entry) => {
      const actualFreeAt = projectedFreeMinute(entry.table, state.now);
      const scheduledFreeAt = Math.max(actualFreeAt, tableAvailableAt.get(entry.table.id) ?? state.now);
      const plannedStart = Math.max(targetMinute, scheduledFreeAt);
      const scheduleDelay = Math.max(0, plannedStart - Math.max(targetMinute, actualFreeAt));
      return {
        ...entry,
        plannedStart,
        planScore: clamp(entry.result.score - Math.min(0.4, scheduleDelay / 90))
      };
    })
    .sort((left, right) => right.planScore - left.planScore || left.plannedStart - right.plannedStart || left.table.seats - right.table.seats);
}

function choosePrimaryCandidate(state, party, entries) {
  const best = entries[0] || null;
  if (!best) return null;
  const previousTop = party.candidateTableIds[0] || null;
  const previous = entries.find((entry) => entry.table.id === previousTop);
  const hostOverride = party.hostOverrideTableId
    ? entries.find((entry) => entry.table.id === party.hostOverrideTableId)
    : null;

  if (party.hostOverrideTableId && !hostOverride) {
    party.hostOverrideTableId = null;
  }
  if (hostOverride) return hostOverride;

  const insideFreezeWindow = party.status === "upcoming"
    && party.reservedFor - state.now <= AGENT_FREEZE_WINDOW_MINUTES;
  const previousStillPractical = previous
    && previous.plannedStart <= partyPlanningMinute(state, party) + 15;
  if (insideFreezeWindow && previousStillPractical) return previous;
  if (previousStillPractical && best.planScore - previous.planScore < AGENT_STABILITY_THRESHOLD) return previous;
  return best;
}

function publishCandidatePlan(state, party, entries, tableAvailableAt) {
  const previousTop = party.candidateTableIds[0] || null;
  const hadExistingPlan = Boolean(previousTop && party.candidateUpdatedAt != null);
  const primary = choosePrimaryCandidate(state, party, entries);
  if (!primary) {
    clearCandidatePlan(party);
    return { changed: Boolean(previousTop), planned: false };
  }

  const candidates = [primary, ...entries.filter((entry) => entry.table.id !== primary.table.id)]
    .slice(0, 3)
    .map((entry) => entry.table.id);
  const nextTop = candidates[0];
  const changed = previousTop !== nextTop;
  party.candidateTableIds = candidates;
  party.candidateUpdatedAt = state.now;
  party.candidateFrozen = party.status === "upcoming"
    && party.reservedFor - state.now <= AGENT_FREEZE_WINDOW_MINUTES;
  party.candidateState = party.hostOverrideTableId ? "host_override" : "tentative";
  party.candidateReason = primary.result.reasons.slice(0, 2).join("; ");

  if (party.status === "waiting") {
    if (party.autoAssignAt == null || changed) {
      party.autoAssignAt = hadExistingPlan && !changed ? state.now : state.now + AGENT_FREEZE_WINDOW_MINUTES;
    }
  } else {
    party.autoAssignAt = null;
  }

  tableAvailableAt.set(primary.table.id, primary.plannedStart + EXPECTED_DWELL_MINUTES + TABLE_RESET_MINUTES);
  if (changed) logActivity(state, "set_candidates", `${party.name} → ${candidates.join(" · ")}`, "agent");
  return { changed, planned: true };
}

function commitLocalCandidateDeadlines(state) {
  let committedCount = 0;
  const due = getWaitingParties(state)
    .filter((party) => !party.committedTableId && party.autoAssignAt != null && party.autoAssignAt <= state.now)
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === "reservation" ? -1 : 1;
      return left.autoAssignAt - right.autoAssignAt || priorityValue(state, right) - priorityValue(state, left);
    });

  for (const party of due) {
    const tableId = party.candidateTableIds.find((candidateId) => (
      checkAssignmentLegality(state, party.id, candidateId, { forCandidate: true, source: "agent" }).legal
    ));
    if (!tableId) {
      party.autoAssignAt = null;
      continue;
    }
    const result = assignTable(state, party.id, tableId, { source: "agent", skipPlan: true });
    if (result.ok) committedCount += 1;
  }
  return committedCount;
}

function refreshCandidates(state, allowAutoCommit = true) {
  const tableAvailableAt = new Map(state.tables.map((table) => [table.id, projectedFreeMinute(table, state.now)]));
  const planningParties = state.parties.filter((party) => isInsidePlanningHorizon(state, party)).sort((a, b) => planningOrder(state, a, b));
  let changedCount = 0;
  let plannedCount = 0;

  for (const party of state.parties) {
    if (["upcoming", "waiting"].includes(party.status) && !isInsidePlanningHorizon(state, party) && !party.committedTableId) {
      clearCandidatePlan(party);
    }
  }

  for (const party of planningParties) {
    const published = publishCandidatePlan(state, party, scheduledCandidateScores(state, party, tableAvailableAt), tableAvailableAt);
    changedCount += Number(published.changed);
    plannedCount += Number(published.planned);
  }

  const committedCount = allowAutoCommit ? commitLocalCandidateDeadlines(state) : 0;
  if (committedCount) {
    const refreshed = refreshCandidates(state, false);
    changedCount += refreshed.changedCount;
    plannedCount = refreshed.plannedCount;
  }
  return { changedCount, plannedCount, committedCount };
}

function updatePlanNarrative(state) {
  const waiting = getWaitingParties(state).filter((party) => !party.committedTableId);
  const next = waiting
    .filter((party) => party.candidateTableIds.length)
    .sort((a, b) => (a.autoAssignAt ?? Infinity) - (b.autoAssignAt ?? Infinity))[0];

  if (next) {
    state.plan = `${next.name}: ${next.candidateTableIds.join(" · ")}. Auto-assign in ${Math.max(0, next.autoAssignAt - state.now)} restaurant min unless the host overrides.`;
  } else if (waiting.length) {
    state.plan = `${waiting.length} ${waiting.length === 1 ? "party is" : "parties are"} waiting; no legal table is ready yet.`;
  } else {
    state.plan = "The floor is balanced. Watching arrivals, expected finishes, and host locks.";
  }
}

export function runAgentCycle(state, options = {}) {
  if (!state.agentEnabled) return state;
  const reason = options.reason || "scheduled heartbeat";
  state.agentReview.status = "reviewing";
  state.agentReview.reason = reason;
  state.agentReview.requestedAt = state.now;
  const result = refreshCandidates(state, options.allowAutoCommit ?? true);
  state.agentReview.status = result.changedCount || result.committedCount ? "planned" : "observing";
  state.agentReview.lastReviewAt = state.now;
  state.agentReview.nextReviewAt = state.now + AGENT_HEARTBEAT_MINUTES;
  state.agentReview.requestedAt = null;
  state.agentReview.plannedPartyCount = result.plannedCount;
  state.agentReview.changedPartyCount = result.changedCount;
  updatePlanNarrative(state);
  if (options.log !== false) {
    logActivity(
      state,
      "review_floor",
      `${reason} · ${result.plannedCount} planned${result.changedCount ? ` · ${result.changedCount} changed` : " · stable"}`,
      "agent"
    );
  }
  return state;
}

function requestAgentReview(state, reason, options = {}) {
  if (state.agentEnabled) return runAgentCycle(state, { reason, allowAutoCommit: options.allowAutoCommit ?? true });
  if (state.controllerMode === "external") {
    state.agentReview.status = "review_due";
    state.agentReview.reason = reason;
    state.agentReview.requestedAt ??= state.now;
  }
  return state;
}

function commitExternalCandidateDeadlines(state) {
  if (state.controllerMode !== "external" || state.agentConnection?.mode !== "autonomous") return;
  const due = getWaitingParties(state)
    .filter((party) => party.autoAssignAt != null && party.autoAssignAt <= state.now && party.candidateTableIds.length)
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === "reservation" ? -1 : 1;
      return left.autoAssignAt - right.autoAssignAt;
    });
  for (const party of due) {
    assignTable(state, party.id, party.candidateTableIds[0], { source: "agent", skipPlan: true });
  }
}

function assignmentOriginFor(state, source, preservedOrigin = null) {
  if (preservedOrigin) return clone(preservedOrigin);
  if (source === "host") return { kind: "host", label: "Host override" };
  if (source === "agent" && state.controllerMode === "external") {
    return { kind: "external", label: state.agentConnection?.name || "External AI" };
  }
  if (source === "agent") return { kind: "local", label: "Local algorithm" };
  return { kind: "system", label: "Service clock" };
}

function assignmentReasonFor(scored, origin, suppliedReason = null) {
  const cleanReason = String(suppliedReason || "").trim().slice(0, 180);
  if (cleanReason) return cleanReason;
  if (origin.kind === "host") return "Manual host override.";
  if (scored.serviceBriefReasons?.length) return scored.serviceBriefReasons.join("; ");
  return scored.reasons.slice(0, 2).join("; ");
}

function seatPartyAtTable(state, party, table, source, options = {}) {
  const scored = scoreAssignment(state, party.id, table.id, { forCandidate: true, source });
  const assignmentOrigin = assignmentOriginFor(state, source, options.origin);
  const assignmentReason = assignmentReasonFor(scored, assignmentOrigin, options.reason || party.assignmentReason || party.candidateReason);
  const origin = party.source === "walk_in" ? party.arrivedAt : party.reservedFor;
  const wait = Math.max(0, state.now - origin);
  table.status = "seated";
  table.partyId = party.id;
  table.heldForPartyId = null;
  table.holdUntil = null;
  table.nextPartyId = null;
  table.seatedAt = state.now;
  table.dueAt = state.now + EXPECTED_DWELL_MINUTES;
  table.dirtyUntil = null;
  table.assignmentOrigin = clone(assignmentOrigin);
  table.assignmentReason = assignmentReason;

  party.status = "seated";
  party.seatedAt = state.now;
  party.committedTableId = table.id;
  party.candidateTableIds = [];
  party.autoAssignAt = null;
  party.candidateState = "committed";
  party.candidateUpdatedAt = state.now;
  party.candidateFrozen = true;
  party.hostOverrideTableId = null;
  party.assignedBy = source;
  party.assignmentOrigin = clone(assignmentOrigin);
  party.assignmentReason = assignmentReason;
  party.candidateReason = null;
  party.seatingScore = scored;

  const record = {
    partyId: party.id,
    tableId: table.id,
    minute: state.now,
    wait,
    size: party.size,
    sat: scored.sat,
    turn: scored.turn,
    preferences: party.preferences.length,
    matchedPreferences: scored.matchedPreferences.length,
    source,
    assignmentOrigin: clone(assignmentOrigin),
    assignmentReason
  };
  state.seatingRecords.push(record);
  state.coversHistory.push({ minute: state.now, covers: party.size });
  state.scoreHistory.push({ minute: state.now, sat: scored.sat });
  state.scoreHistory = state.scoreHistory.slice(-20);
  logActivity(state, "assign_table", `${table.id} ← ${party.name} · ${assignmentOrigin.label} · ${assignmentReason}`, source);
  state.plan = `${assignmentOrigin.label} seated ${party.name} at ${table.id}. ${assignmentReason}`;
}

export function assignTable(state, partyId, tableId, options = {}) {
  const source = options.source || "host";
  const party = getParty(state, partyId);
  const table = getTable(state, tableId);
  const legality = checkAssignmentLegality(state, partyId, tableId, { forCandidate: true, source });

  if (!legality.legal) {
    return failure(state, "ILLEGAL_ASSIGNMENT", legality.reasons[0], { reasons: legality.reasons, partyId, tableId });
  }
  if (!party || !table) return failure(state, "NOT_FOUND", "Party or table was not found.");
  if (party.status === "seated") return failure(state, "ALREADY_SEATED", `${party.name} is already seated; use move_party.`);
  const priorityBlocker = source === "host" ? null : getReservationPriorityBlocker(state, party);
  if (priorityBlocker) {
    return failure(
      state,
      "RESERVATION_PRIORITY",
      `${priorityBlocker.partyName} has an available table and must be seated before ${party.name}. The host may override manually.`,
      { partyId, tableId, reservation: priorityBlocker, hostMayOverride: true }
    );
  }

  if (table.status === "free" || (table.status === "held" && table.heldForPartyId === party.id)) {
    seatPartyAtTable(state, party, table, source, options);
  } else {
    const assignmentOrigin = assignmentOriginFor(state, source, options.origin);
    const scored = scoreAssignment(state, party.id, table.id, { forCandidate: true, source });
    const assignmentReason = assignmentReasonFor(scored, assignmentOrigin, options.reason || party.assignmentReason || party.candidateReason);
    table.nextPartyId = party.id;
    party.committedTableId = table.id;
    party.candidateTableIds = [];
    party.autoAssignAt = null;
    party.candidateState = "committed";
    party.candidateUpdatedAt = state.now;
    party.candidateFrozen = true;
    party.hostOverrideTableId = null;
    party.assignedBy = source;
    party.assignmentOrigin = clone(assignmentOrigin);
    party.assignmentReason = assignmentReason;
    logActivity(state, "assign_table", `${table.id} held next for ${party.name} · ${assignmentOrigin.label} · ${assignmentReason}`, source);
  }

  if (!options.skipPlan) requestAgentReview(state, source === "host" ? "host assignment override" : "assignment committed", { allowAutoCommit: false });
  return success(state, { partyId, tableId, seated: party.status === "seated", held: party.status === "waiting" });
}

export function moveParty(state, partyId, tableId, options = {}) {
  const party = getParty(state, partyId);
  if (!party || party.status !== "seated") return failure(state, "PARTY_NOT_SEATED", "Only a seated party can be moved.");
  const currentTable = getTable(state, party.committedTableId);
  const destination = getTable(state, tableId);
  const legality = checkAssignmentLegality(state, partyId, tableId, { forCandidate: false, source: options.source || "host" });
  if (!legality.legal || !destination || destination.status !== "free") {
    return failure(state, "ILLEGAL_MOVE", legality.reasons[0] || `${tableId} is not free.`, { reasons: legality.reasons });
  }

  if (currentTable) {
    currentTable.status = "dirty";
    currentTable.partyId = null;
    currentTable.dueAt = null;
    currentTable.dirtyUntil = state.now + TABLE_RESET_MINUTES;
    currentTable.assignmentOrigin = null;
    currentTable.assignmentReason = null;
  }
  party.status = "waiting";
  party.committedTableId = null;
  seatPartyAtTable(state, party, destination, options.source || "host", options);
  logActivity(state, "move_party", `${party.name}: ${currentTable?.id || "waitlist"} → ${destination.id}`, options.source || "host");
  requestAgentReview(state, "party moved", { allowAutoCommit: false });
  return success(state, { partyId, from: currentTable?.id || null, to: tableId });
}

export function unassignParty(state, partyId, options = {}) {
  const party = getParty(state, partyId);
  if (!party) return failure(state, "PARTY_NOT_FOUND", `Party ${partyId} was not found.`);
  if (!["waiting", "seated"].includes(party.status) || !party.committedTableId) {
    return failure(state, "PARTY_NOT_ASSIGNED", `${party.name} is not committed to a table.`);
  }
  const table = getTable(state, party.committedTableId);
  if (table?.partyId === party.id) {
    table.status = "dirty";
    table.partyId = null;
    table.dueAt = null;
    table.dirtyUntil = state.now + TABLE_RESET_MINUTES;
    table.assignmentOrigin = null;
    table.assignmentReason = null;
  }
  if (table?.nextPartyId === party.id) table.nextPartyId = null;
  party.status = "waiting";
  party.seatedAt = null;
  party.committedTableId = null;
  clearCandidatePlan(party);
  party.hostOverrideTableId = null;
  logActivity(state, "unassign", `${party.name} returned to the queue`, options.source || "agent");
  requestAgentReview(state, "party returned to queue", { allowAutoCommit: false });
  return success(state, { partyId });
}

export function setCandidates(state, partyId, tableIds, autoAssignAt = null, options = {}) {
  const party = getParty(state, partyId);
  const isPlannable = party?.status === "waiting"
    || (party?.source === "reservation" && party?.status === "upcoming");
  if (!party || !isPlannable) return failure(state, "PARTY_NOT_PLANNABLE", `${partyId} is not an upcoming reservation or waiting party.`);
  const uniqueIds = [...new Set(tableIds)].slice(0, 3);
  if (!uniqueIds.length) return failure(state, "CANDIDATES_REQUIRED", "At least one candidate table is required.");
  const source = options.source || "agent";
  if (party.hostOverrideTableId && source !== "host" && uniqueIds[0] !== party.hostOverrideTableId) {
    return failure(state, "HOST_OVERRIDE_ACTIVE", `${party.name} is host-locked to ${party.hostOverrideTableId}.`);
  }
  const illegal = uniqueIds
    .map((tableId) => ({ tableId, result: checkAssignmentLegality(state, partyId, tableId, { forCandidate: true, allowUpcoming: true, source }) }))
    .find(({ result }) => !result.legal);
  if (illegal) return failure(state, "ILLEGAL_CANDIDATE", `${illegal.tableId}: ${illegal.result.reasons[0]}`);
  const previousTop = party.candidateTableIds[0] || null;
  party.candidateTableIds = uniqueIds;
  party.candidateState = source === "host" ? "host_override" : "tentative";
  party.candidateUpdatedAt = state.now;
  party.candidateReason = String(options.reason || "").trim().slice(0, 180)
    || (source === "host" ? "Manual host override." : "Agent-ranked table plan.");
  party.candidateFrozen = party.status === "upcoming" && party.reservedFor - state.now <= AGENT_FREEZE_WINDOW_MINUTES;
  if (party.status === "waiting" && (previousTop !== uniqueIds[0] || party.autoAssignAt == null)) {
    const deadline = autoAssignAt == null ? state.now + AGENT_FREEZE_WINDOW_MINUTES : autoAssignAt;
    party.autoAssignAt = Math.max(state.now, Math.round(deadline));
  }
  if (party.status === "upcoming") party.autoAssignAt = null;
  logActivity(state, "set_candidates", `${party.name} → ${uniqueIds.join(" · ")}`, source);
  if (state.controllerMode === "external" && source === "agent") {
    state.agentReview.status = "planned";
    state.agentReview.reason = "external plan received";
    state.agentReview.lastReviewAt = state.now;
    state.agentReview.nextReviewAt = state.now + AGENT_HEARTBEAT_MINUTES;
    state.agentReview.requestedAt = null;
    state.agentReview.plannedPartyCount = state.parties.filter((candidate) => candidate.candidateTableIds.length).length;
    state.agentReview.changedPartyCount = Number(previousTop !== uniqueIds[0]);
  }
  return success(state, { partyId, tableIds: uniqueIds, autoAssignAt: party.autoAssignAt });
}

export function setHostCandidateOverride(state, partyId, tableId) {
  const party = getParty(state, partyId);
  if (!party || party.source !== "reservation" || party.status !== "upcoming") {
    return failure(state, "PARTY_NOT_UPCOMING", "Only an upcoming reservation can receive a tentative host override.");
  }
  const legality = checkAssignmentLegality(state, partyId, tableId, { forCandidate: true, allowUpcoming: true, source: "host" });
  if (!legality.legal) return failure(state, "ILLEGAL_CANDIDATE", legality.reasons[0], { reasons: legality.reasons });
  party.hostOverrideTableId = tableId;
  const candidates = [tableId, ...party.candidateTableIds.filter((candidateId) => candidateId !== tableId)].slice(0, 3);
  const result = setCandidates(state, partyId, candidates, null, { source: "host" });
  if (!result.ok) return result;
  logActivity(state, "override_candidate", `${party.name} → ${tableId} · host`, "host");
  requestAgentReview(state, "host changed a tentative table", { allowAutoCommit: false });
  return success(state, { partyId, tableId, candidateState: party.candidateState });
}

export function lockTable(state, tableId, reason = "Host hold", options = {}) {
  const table = getTable(state, tableId);
  if (!table) return failure(state, "TABLE_NOT_FOUND", `Table ${tableId} was not found.`);
  table.locked = true;
  table.lockedBy = options.source || "host";
  table.lockReason = reason;
  logActivity(state, "lock_table", `${table.id} · ${reason}`, options.source || "host");
  requestAgentReview(state, "table lock changed", { allowAutoCommit: false });
  return success(state, { tableId, locked: true });
}

export function unlockTable(state, tableId, options = {}) {
  const source = options.source || "host";
  if (source !== "host") return failure(state, "HOST_ONLY", "Only the host can unlock a table in this demo.");
  const table = getTable(state, tableId);
  if (!table) return failure(state, "TABLE_NOT_FOUND", `Table ${tableId} was not found.`);
  table.locked = false;
  table.lockedBy = null;
  table.lockReason = null;
  logActivity(state, "unlock_table", table.id, source);
  requestAgentReview(state, "table lock changed", { allowAutoCommit: false });
  return success(state, { tableId, locked: false });
}

export function holdTable(state, tableId, partyId, until, options = {}) {
  const table = getTable(state, tableId);
  const party = getParty(state, partyId);
  const source = options.source || "agent";
  if (!table || !party) return failure(state, "NOT_FOUND", "The table or party was not found.");
  if (!(party.source === "reservation" && party.status === "upcoming") && party.status !== "waiting") {
    return failure(state, "PARTY_NOT_HOLDABLE", `${party.name} is not an upcoming reservation or waiting party.`);
  }
  const priorityBlocker = source === "host" ? null : getReservationPriorityBlocker(state, party);
  if (priorityBlocker) {
    return failure(
      state,
      "RESERVATION_PRIORITY",
      `${priorityBlocker.partyName} has an available table and must be seated before a table is held for ${party.name}. The host may override manually.`,
      { partyId, tableId, reservation: priorityBlocker, hostMayOverride: true }
    );
  }
  if (table.locked) return failure(state, "TABLE_LOCKED", `${table.id} is host-locked.`);
  if (table.status === "free" || (table.status === "held" && table.heldForPartyId === party.id)) {
    table.status = "held";
    table.heldForPartyId = party.id;
    table.holdUntil = Math.round(until);
  } else if (!table.nextPartyId || table.nextPartyId === party.id) {
    table.nextPartyId = party.id;
  } else {
    return failure(state, "TABLE_COMMITTED", `${table.id} already has a next party.`);
  }
  logActivity(state, "hold_table", `${table.id} → ${party.name} until ${minutesToTime(until)}`, source);
  requestAgentReview(state, "table hold changed", { allowAutoCommit: false });
  return success(state, { tableId, partyId, until: Math.round(until) });
}

export function releaseHold(state, tableId, options = {}) {
  const table = getTable(state, tableId);
  if (!table) return failure(state, "TABLE_NOT_FOUND", `Table ${tableId} was not found.`);
  if (table.status === "held") table.status = "free";
  table.heldForPartyId = null;
  table.holdUntil = null;
  table.nextPartyId = null;
  logActivity(state, "release_hold", table.id, options.source || "agent");
  requestAgentReview(state, "table hold released", { allowAutoCommit: false });
  return success(state, { tableId });
}

export function quoteWait(state, partyId, minutes, options = {}) {
  const party = getParty(state, partyId);
  if (!party || party.status !== "waiting") return failure(state, "PARTY_NOT_WAITING", `${partyId} is not waiting.`);
  party.quotedWaitMin = Math.max(0, Math.round(minutes));
  logActivity(state, "quote_wait", `${party.name} · ${party.quotedWaitMin} min`, options.source || "agent");
  return success(state, { partyId, minutes: party.quotedWaitMin });
}

export function markTable(state, tableId, status, options = {}) {
  const table = getTable(state, tableId);
  if (!table) return failure(state, "TABLE_NOT_FOUND", `Table ${tableId} was not found.`);
  if (!["dirty", "ready", "seated"].includes(status)) return failure(state, "INVALID_STATUS", "Use dirty, ready, or seated.");
  if (["dirty", "ready"].includes(status) && table.status === "seated") {
    return failure(state, "TABLE_OCCUPIED", `${table.id} is occupied; mark the party left before changing table readiness.`);
  }
  if (status === "dirty" && table.status === "held") {
    return failure(state, "TABLE_HELD", `${table.id} is held; release the hold before marking it dirty.`);
  }
  if (status === "ready") {
    table.status = "free";
    table.partyId = null;
    table.dueAt = null;
    table.dirtyUntil = null;
    table.assignmentOrigin = null;
    table.assignmentReason = null;
    seatCommittedPartyIfReady(state, table);
  } else if (status === "dirty") {
    table.status = "dirty";
    table.partyId = null;
    table.dueAt = null;
    table.dirtyUntil = state.now + TABLE_RESET_MINUTES;
    table.assignmentOrigin = null;
    table.assignmentReason = null;
  } else if (!table.partyId) {
    return failure(state, "PARTY_REQUIRED", "A party must be assigned before marking a table seated.");
  }
  logActivity(state, "mark_table", `${table.id} → ${table.status}`, options.source || "agent");
  requestAgentReview(state, "table readiness changed", { allowAutoCommit: false });
  return success(state, { tableId, status: table.status });
}

export function markParty(state, partyId, status, options = {}) {
  const party = getParty(state, partyId);
  if (!party) return failure(state, "PARTY_NOT_FOUND", `Party ${partyId} was not found.`);
  if (!["arrived", "no_show", "left"].includes(status)) return failure(state, "INVALID_STATUS", "Use arrived, no_show, or left.");
  if (status === "arrived") {
    if (party.status !== "upcoming") return failure(state, "INVALID_PARTY_TRANSITION", `${party.name} cannot arrive from ${party.status}.`);
    party.status = "waiting";
    if (party.source === "walk_in") party.arrivedAt ??= state.now;
    if (state.controllerMode === "external" && party.candidateTableIds.length && state.agentConnection?.mode === "autonomous") {
      party.autoAssignAt = state.now;
    }
  } else {
    if (status === "no_show" && !["upcoming", "waiting"].includes(party.status)) {
      return failure(state, "INVALID_PARTY_TRANSITION", `${party.name} cannot be marked no-show from ${party.status}.`);
    }
    if (status === "left" && !["waiting", "seated"].includes(party.status)) {
      return failure(state, "INVALID_PARTY_TRANSITION", `${party.name} cannot leave from ${party.status}.`);
    }
    const table = getTable(state, party.committedTableId);
    if (table?.partyId === party.id) {
      table.status = "dirty";
      table.partyId = null;
      table.dueAt = null;
      table.dirtyUntil = state.now + TABLE_RESET_MINUTES;
      table.assignmentOrigin = null;
      table.assignmentReason = null;
    }
    if (table?.nextPartyId === party.id) table.nextPartyId = null;
    party.status = status;
    clearCandidatePlan(party);
    party.hostOverrideTableId = null;
    party.committedTableId = null;
    party.leftAt = state.now;
  }
  logActivity(state, "mark_party", `${party.name} → ${status}`, options.source || "agent");
  requestAgentReview(state, `party marked ${status}`);
  return success(state, { partyId, status: party.status });
}

export function setWeights(state, sat, turn = 1 - sat, options = {}) {
  const satNumber = Number(sat);
  const turnNumber = Number(turn);
  if (!Number.isFinite(satNumber) || !Number.isFinite(turnNumber) || satNumber < 0 || turnNumber < 0 || Math.abs(satNumber + turnNumber - 1) > 0.001) {
    return failure(state, "INVALID_WEIGHTS", "Satisfaction and turn weights must be non-negative and total 1.0.");
  }
  state.weights = { sat: satNumber, turn: turnNumber };
  logActivity(state, "set_weights", `Sat ${Math.round(satNumber * 100)} · Turn ${Math.round(turnNumber * 100)}`, options.source || "host");
  requestAgentReview(state, "service objective changed", { allowAutoCommit: false });
  return success(state, { weights: clone(state.weights) });
}

export function explainPlan(state, bullets, options = {}) {
  const clean = bullets.map((bullet) => String(bullet).trim()).filter(Boolean).slice(0, 3);
  if (!clean.length) return failure(state, "PLAN_REQUIRED", "Supply one to three concise plan bullets.");
  state.planBullets = clean;
  state.plan = clean.join(" · ");
  logActivity(state, "explain_plan", clean[0], options.source || "agent");
  return success(state, { bullets: clean });
}

function seatCommittedPartyIfReady(state, table) {
  if (!table.nextPartyId || table.status !== "free") return;
  const nextParty = getParty(state, table.nextPartyId);
  if (!nextParty || nextParty.status !== "waiting") {
    table.nextPartyId = null;
    return;
  }
  const partyId = table.nextPartyId;
  table.nextPartyId = null;
  const result = assignTable(state, partyId, table.id, {
    source: nextParty.assignedBy || "agent",
    skipPlan: true,
    origin: nextParty.assignmentOrigin,
    reason: nextParty.assignmentReason
  });
  if (!result.ok && result.error?.code === "RESERVATION_PRIORITY" && nextParty.assignedBy !== "host") {
    nextParty.committedTableId = null;
    nextParty.assignedBy = null;
    clearCandidatePlan(nextParty);
    logActivity(state, "reservation_priority", `${nextParty.name} returned to the queue · reservation first`, "agent");
  }
}

function processTableTransitions(state) {
  let changed = false;
  for (const table of state.tables) {
    if (table.status === "seated" && table.dueAt != null && table.dueAt <= state.now) {
      const party = getParty(state, table.partyId);
      if (party) {
        party.status = "left";
        party.leftAt = state.now;
      }
      table.status = "dirty";
      table.partyId = null;
      table.dueAt = null;
      table.dirtyUntil = state.now + TABLE_RESET_MINUTES;
      table.assignmentOrigin = null;
      table.assignmentReason = null;
      logActivity(state, "mark_table", `${table.id} → dirty`, "clock");
      changed = true;
    }
    if (table.status === "dirty" && table.dirtyUntil != null && table.dirtyUntil <= state.now) {
      table.status = "free";
      table.dirtyUntil = null;
      table.assignmentOrigin = null;
      table.assignmentReason = null;
      logActivity(state, "mark_table", `${table.id} → ready`, "clock");
      seatCommittedPartyIfReady(state, table);
      changed = true;
    }
    if (table.status === "held" && table.holdUntil != null && table.holdUntil <= state.now) {
      const heldParty = getParty(state, table.heldForPartyId);
      if (heldParty?.status === "waiting") {
        const partyId = table.heldForPartyId;
        table.status = "free";
        table.heldForPartyId = null;
        table.holdUntil = null;
        assignTable(state, partyId, table.id, { source: "agent", skipPlan: true });
      } else {
        table.status = "free";
        table.heldForPartyId = null;
        table.holdUntil = null;
        logActivity(state, "release_hold", `${table.id} · hold expired`, "clock");
      }
      changed = true;
    }
  }
  return changed;
}

function processEvent(state, event) {
  let changed = false;
  if (event.type === "arrival") {
    for (const partyId of event.partyIds) {
      const party = getParty(state, partyId);
      if (!party || party.status !== "upcoming") continue;
      party.status = "waiting";
      if (party.source === "walk_in") party.arrivedAt = event.minute;
      const previousSize = party.size;
      if (party.checkInSizeDelta) {
        party.size += party.checkInSizeDelta;
        party.checkInSizeDelta = 0;
      }
      if (state.controllerMode === "external" && party.candidateTableIds.length && state.agentConnection?.mode === "autonomous") {
        party.autoAssignAt = state.now;
      }
      const arrivalDetail = party.size > previousSize
        ? `${party.name} arrived · party grew ${previousSize} → ${party.size}`
        : `${party.name} arrived · party of ${party.size}`;
      logActivity(state, "get_queue", arrivalDetail, "clock");
      changed = true;
    }
  }
  if (event.type === "no_show") {
    for (const partyId of event.partyIds) {
      const party = getParty(state, partyId);
      if (!party || ["seated", "left"].includes(party.status)) continue;
      party.status = "no_show";
      clearCandidatePlan(party);
      party.hostOverrideTableId = null;
      logActivity(state, "mark_party", `${party.name} → no-show`, "clock");
      changed = true;
    }
  }
  if (event.type === "kitchen_delay") {
    state.kitchenDelayUntil = event.until;
    logActivity(state, "get_floor", `Kitchen delay through ${minutesToTime(event.until)}`, "clock");
    changed = true;
  }
  return changed;
}

function processMinute(state) {
  const reviewReasons = [];
  if (state.kitchenDelayUntil != null && state.kitchenDelayUntil <= state.now) {
    state.kitchenDelayUntil = null;
    logActivity(state, "get_floor", "Kitchen delay cleared", "clock");
    reviewReasons.push("kitchen delay cleared");
  }
  const events = state.events.filter((event) => event.minute === state.now && !state.processedEvents.includes(`${event.minute}:${event.type}`));
  for (const event of events) {
    if (processEvent(state, event)) reviewReasons.push(event.type.replaceAll("_", " "));
    state.processedEvents.push(`${event.minute}:${event.type}`);
  }
  if (processTableTransitions(state)) reviewReasons.push("table transition");

  if (state.agentEnabled) {
    if (reviewReasons.length) {
      runAgentCycle(state, { reason: [...new Set(reviewReasons)].join(" + ") });
    } else {
      const committedCount = commitLocalCandidateDeadlines(state);
      if (committedCount) runAgentCycle(state, { reason: "assignment committed", allowAutoCommit: false });
      else if (state.agentReview.nextReviewAt != null && state.now >= state.agentReview.nextReviewAt) {
        runAgentCycle(state, { reason: "10-minute heartbeat" });
      }
    }
  } else {
    commitExternalCandidateDeadlines(state);
    if (reviewReasons.length) requestAgentReview(state, [...new Set(reviewReasons)].join(" + "));
    if (state.controllerMode === "external"
      && state.agentReview.status !== "review_due"
      && state.agentReview.nextReviewAt != null
      && state.now >= state.agentReview.nextReviewAt) {
      requestAgentReview(state, "10-minute heartbeat");
    }
  }
  bump(state);
}

export function advanceMinutes(state, minutes = 1) {
  const count = Math.max(0, Math.floor(minutes));
  for (let index = 0; index < count && state.now < SERVICE_END; index += 1) {
    state.now += 1;
    processMinute(state);
  }
  if (state.now >= SERVICE_END) state.running = false;
  return state;
}

export function advanceTo(state, targetMinute) {
  const bounded = Math.min(SERVICE_END, Math.max(SERVICE_START, Math.round(targetMinute)));
  if (bounded < state.now) return failure(state, "CLOCK_REWIND_UNSUPPORTED", "Reset the night before moving the clock backward.");
  advanceMinutes(state, bounded - state.now);
  return success(state, { now: state.now });
}

export function getNextEventMinute(state) {
  const scripted = state.events.find((event) => event.minute > state.now)?.minute;
  const tableTimes = state.tables.flatMap((table) => [table.dueAt, table.dirtyUntil, table.holdUntil]).filter((minute) => minute != null && minute > state.now);
  const autoTimes = getWaitingParties(state).map((party) => party.autoAssignAt).filter((minute) => minute != null && minute > state.now);
  const heartbeat = state.controllerMode !== "manual" && state.agentReview.nextReviewAt > state.now
    ? state.agentReview.nextReviewAt
    : null;
  const candidates = [scripted, heartbeat, ...tableTimes, ...autoTimes, SERVICE_END].filter((minute) => minute != null);
  return Math.min(...candidates);
}

export function setAgentEnabled(state, enabled) {
  state.agentEnabled = Boolean(enabled);
  state.controllerMode = state.agentEnabled ? "local" : "manual";
  state.agentConnection = null;
  logActivity(state, "agent_mode", state.agentEnabled ? "Autopilot enabled" : "Manual floor · drag or tap to assign", "host");
  if (state.agentEnabled) {
    state.agentReview.status = "reviewing";
    state.agentReview.reason = "autopilot enabled";
    state.agentReview.nextReviewAt = state.now + AGENT_HEARTBEAT_MINUTES;
    runAgentCycle(state, { reason: "autopilot enabled", allowAutoCommit: false });
  } else {
    for (const party of state.parties) {
      clearCandidatePlan(party);
      party.hostOverrideTableId = null;
    }
    state.agentReview = {
      status: "manual",
      reason: "manual control",
      lastReviewAt: null,
      nextReviewAt: null,
      requestedAt: null,
      plannedPartyCount: 0,
      changedPartyCount: 0
    };
    state.plan = "Allocation automation is off. The host owns every table assignment.";
  }
  return success(state, { agentEnabled: state.agentEnabled });
}

export function attachExternalAgent(state, name, mode = "autonomous") {
  const cleanName = String(name || "").trim().slice(0, 64);
  if (!cleanName) return failure(state, "INVALID_AGENT", "Provide a short agent name.");
  if (!["advisory", "autonomous"].includes(mode)) return failure(state, "INVALID_AGENT_MODE", "Agent mode must be advisory or autonomous.");
  state.agentEnabled = false;
  state.controllerMode = "external";
  state.agentConnection = { name: cleanName, mode, attachedAt: state.now, lastSeenAt: state.now };
  for (const party of state.parties) {
    if (party.hostOverrideTableId) {
      party.candidateTableIds = [party.hostOverrideTableId];
      party.candidateState = "host_override";
      party.candidateUpdatedAt = state.now;
      party.autoAssignAt = null;
    } else {
      clearCandidatePlan(party);
    }
  }
  state.agentReview = {
    status: "review_due",
    reason: "external agent attached",
    lastReviewAt: null,
    nextReviewAt: state.now + AGENT_HEARTBEAT_MINUTES,
    requestedAt: state.now,
    plannedPartyCount: state.parties.filter((party) => party.candidateTableIds.length).length,
    changedPartyCount: 0
  };
  state.plan = `${cleanName} is attached through WebMCP in ${mode} mode and is reading the floor.`;
  logActivity(state, "attach_agent", `${cleanName} · ${mode}`, "agent");
  return success(state, { controllerMode: state.controllerMode, agent: clone(state.agentConnection) });
}

export function detachExternalAgent(state, options = {}) {
  const previous = state.agentConnection?.name || "External agent";
  state.agentEnabled = false;
  state.controllerMode = "manual";
  state.agentConnection = null;
  for (const party of state.parties) {
    clearCandidatePlan(party);
    party.hostOverrideTableId = null;
  }
  state.agentReview = {
    status: "manual",
    reason: "manual control",
    lastReviewAt: null,
    nextReviewAt: null,
    requestedAt: null,
    plannedPartyCount: 0,
    changedPartyCount: 0
  };
  state.plan = "External agent disconnected. The floor is in manual mode.";
  logActivity(state, "detach_agent", `${previous} disconnected`, options.source || "agent");
  return success(state, { controllerMode: state.controllerMode });
}

function percentile(values, percent) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(percent * sorted.length) - 1);
  return sorted[index];
}

export function getMetrics(state) {
  const records = state.seatingRecords;
  const sat = records.length ? records.reduce((total, record) => total + record.sat, 0) / records.length : null;
  const preferences = records.reduce((total, record) => total + record.preferences, 0);
  const matched = records.reduce((total, record) => total + record.matchedPreferences, 0);
  const walkInWaits = records
    .filter((record) => getParty(state, record.partyId)?.source === "walk_in")
    .map((record) => record.wait);
  const coversLastHour = state.coversHistory
    .filter((entry) => entry.minute > state.now - 60)
    .reduce((total, entry) => total + entry.covers, 0);
  const occupiedSeats = state.tables
    .filter((table) => table.status === "seated")
    .reduce((total, table) => total + table.seats, 0);

  return {
    sat,
    coversPerHour: coversLastHour,
    utilization: occupiedSeats / RESTAURANT_CAPACITY,
    preferenceHitRate: preferences ? matched / preferences : null,
    waitP50: percentile(walkInWaits, 0.5),
    waitP90: percentile(walkInWaits, 0.9),
    scoreHistory: clone(state.scoreHistory)
  };
}

function latestSeatingRecord(state, partyId) {
  return [...state.seatingRecords].reverse().find((record) => record.partyId === partyId) || null;
}

function scoreServiceBrief(state) {
  const results = (state.serviceBrief?.directives || []).map((directive) => {
    if (directive.type === "section_load") {
      const assignments = state.seatingRecords.filter((record) => record.minute >= directive.from && record.minute < directive.until);
      const addedToSection = assignments.filter((record) => getTable(state, record.tableId)?.zone === directive.zone).length;
      const value = assignments.length ? clamp(1 - addedToSection / assignments.length) : 1;
      return {
        id: directive.id,
        text: directive.text,
        value,
        result: assignments.length
          ? `${addedToSection} of ${assignments.length} assignments added to ${directive.server}’s section`
          : "No assignments were needed during the overload window"
      };
    }
    if (directive.type === "party_proximity") {
      const records = directive.partyIds.map((partyId) => latestSeatingRecord(state, partyId));
      if (records.some((record) => !record)) {
        return { id: directive.id, text: directive.text, value: 0, result: "Both linked parties were not seated" };
      }
      const distance = tableGridDistance(getTable(state, records[0].tableId), getTable(state, records[1].tableId));
      const value = distance <= directive.maxTableDistance ? 1 : distance <= directive.maxTableDistance + 2 ? 0.5 : 0;
      return {
        id: directive.id,
        text: directive.text,
        value,
        result: `${directive.partyNames.join(" & ")} were seated ${distance.toFixed(1)} floor-grid units apart`
      };
    }
    return { id: directive.id, text: directive.text, value: 1, result: "Not scored" };
  });
  return {
    value: results.length ? results.reduce((total, result) => total + result.value, 0) / results.length : 1,
    results
  };
}

export function getServiceRecap(state) {
  const uniquePartyIds = new Set(state.seatingRecords.map((record) => record.partyId));
  const records = [...uniquePartyIds].map((partyId) => latestSeatingRecord(state, partyId)).filter(Boolean);
  const eligiblePartyCount = state.parties.filter((party) => party.status !== "no_show").length;
  const averageSat = records.length
    ? records.reduce((total, record) => total + record.sat, 0) / records.length
    : 0;
  const walkInWaits = records
    .filter((record) => getParty(state, record.partyId)?.source === "walk_in")
    .map((record) => record.wait);
  const averageTurn = records.length
    ? records.reduce((total, record) => total + record.turn, 0) / records.length
    : 0;
  const brief = scoreServiceBrief(state);
  const values = {
    guestSatisfaction: averageSat,
    waitControl: walkInWaits.length ? clamp((90 - percentile(walkInWaits, 0.9)) / 75) : 0,
    tableFit: averageTurn,
    completion: eligiblePartyCount ? uniquePartyIds.size / eligiblePartyCount : 0,
    briefAdherence: brief.value
  };
  const weights = {
    guestSatisfaction: 0.3,
    waitControl: 0.2,
    tableFit: 0.2,
    completion: 0.15,
    briefAdherence: 0.15
  };
  const labels = {
    guestSatisfaction: "Guest satisfaction",
    waitControl: "Walk-in wait control",
    tableFit: "Table fit & turns",
    completion: "Parties served",
    briefAdherence: "Service brief"
  };
  const score = Math.round(Object.keys(weights).reduce((total, key) => total + values[key] * weights[key], 0) * 100);
  const grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  const provenance = new Map();
  for (const record of records) {
    const origin = record.assignmentOrigin || { kind: record.source === "host" ? "host" : "local", label: record.source === "host" ? "Host override" : "Local algorithm" };
    const current = provenance.get(origin.kind) || { kind: origin.kind, label: origin.label, assignments: 0, covers: 0 };
    current.assignments += 1;
    current.covers += record.size;
    provenance.set(origin.kind, current);
  }

  return {
    official: false,
    status: state.now >= SERVICE_END ? "complete" : "provisional",
    score,
    grade,
    scoreLabel: "Host Stand service score",
    formula: "30% guest satisfaction · 20% walk-in wait control (P90: 15m earns 100%, 90m earns 0%) · 20% table fit · 15% parties served · 15% service brief",
    components: Object.keys(weights).map((key) => ({
      key,
      label: labels[key],
      weight: weights[key],
      value: values[key],
      points: Math.round(values[key] * weights[key] * 100)
    })),
    partiesServed: uniquePartyIds.size,
    eligibleParties: eligiblePartyCount,
    coversServed: records.reduce((total, record) => total + record.size, 0),
    provenance: [...provenance.values()],
    briefResults: brief.results
  };
}

function nextRecommendedActions(state) {
  if (state.now >= SERVICE_END) return ["Review the service recap", "Start a new random run"];
  const waitingReservation = state.parties.find((party) => party.source === "reservation" && party.status === "waiting" && !party.committedTableId);
  if (state.controllerMode === "manual") {
    return waitingReservation
      ? [`Seat reservation ${waitingReservation.name} before a walk-in`, "Drag the party row to a legal table or select party then table"]
      : ["Assign each arrived party manually", "Quote a wait when no legal table is ready"];
  }
  if (state.controllerMode === "external" && state.agentReview.status === "review_due") {
    return ["Read get_floor and get_queue", "Publish up to three candidates with a concise reason", "Explain the current whole-floor plan"];
  }
  return ["Monitor tentative tables", "Override any plan by dragging a party to another legal table"];
}

export function getFloorSnapshot(state) {
  return {
    clock: minutesToTime(state.now),
    minute: state.now,
    running: state.running,
    speed: state.speed,
    runCode: state.runCode,
    controllerMode: state.controllerMode,
    agentConnection: clone(state.agentConnection),
    agentReview: clone(state.agentReview),
    agentCadence: {
      heartbeatMinutes: AGENT_HEARTBEAT_MINUTES,
      planningHorizonMinutes: AGENT_PLANNING_HORIZON_MINUTES,
      freezeWindowMinutes: AGENT_FREEZE_WINDOW_MINUTES,
      strategy: "event-driven plus heartbeat",
      servicePriority: "seat waiting reservations before walk-ins whenever a legal table is available; host assignments may override"
    },
    capacity: RESTAURANT_CAPACITY,
    tableUnitCount: state.tables.length,
    kitchenDelay: Boolean(state.kitchenDelayUntil && state.now < state.kitchenDelayUntil),
    serviceBrief: clone(state.serviceBrief),
    nextRecommendedActions: nextRecommendedActions(state),
    weights: clone(state.weights),
    tables: state.tables.map((table) => ({
      id: table.id,
      seats: table.seats,
      minSeats: table.minSeats,
      shape: table.shape,
      zone: table.zone,
      quiet: table.quiet,
      nearKitchen: table.nearKitchen,
      highChair: table.highChair,
      accessible: table.accessible,
      status: table.status,
      locked: table.locked,
      lockReason: table.lockReason,
      partyId: table.partyId,
      heldForPartyId: table.heldForPartyId,
      nextPartyId: table.nextPartyId,
      expectedFinishAt: table.status === "seated" ? table.dueAt : null,
      dirtyUntil: table.status === "dirty" ? table.dirtyUntil : null,
      assignmentOrigin: table.status === "seated" ? clone(table.assignmentOrigin) : null,
      assignmentReason: table.status === "seated" ? table.assignmentReason : null,
      likelyFree: table.status === "seated" && table.dueAt
        ? { earliest: table.dueAt + TABLE_RESET_MINUTES, latest: table.dueAt + TABLE_RESET_MINUTES }
        : table.status === "dirty" && table.dirtyUntil
          ? { earliest: table.dirtyUntil, latest: table.dirtyUntil }
          : null
    })),
    metrics: getMetrics(state),
    serviceRecap: state.now >= SERVICE_END ? getServiceRecap(state) : null
  };
}

export function getQueueSnapshot(state) {
  return {
    clock: minutesToTime(state.now),
    servicePolicy: {
      order: ["waiting_reservation", "waiting_walk_in"],
      rule: "Seat a waiting reservation first whenever a legal table is available.",
      hostMayOverride: true
    },
    serviceBrief: clone(state.serviceBrief),
    nextRecommendedActions: nextRecommendedActions(state),
    reservations: state.parties.filter((party) => party.source === "reservation" && ["upcoming", "waiting"].includes(party.status)).map(queueParty(state)),
    walkIns: state.parties.filter((party) => party.source === "walk_in" && party.status === "waiting").map(queueParty(state))
  };
}

function queueParty(state) {
  return (party) => {
    const priorityBlocker = getReservationPriorityBlocker(state, party);
    return ({
    id: party.id,
    name: party.name,
    size: party.size,
    source: party.source,
    servicePriority: party.source === "reservation" ? "reservation_first" : "after_waiting_reservations",
    reservationPriorityBlockedBy: priorityBlocker,
    status: party.status,
    reservedFor: party.reservedFor,
    arrivedAt: party.arrivedAt,
    waitMinutes: party.status === "waiting" ? Math.max(0, state.now - (party.source === "walk_in" ? party.arrivedAt : party.reservedFor)) : 0,
    preferences: [...party.preferences],
    children: party.children,
    needsAccessible: party.needsAccessible,
    isRegular: party.isRegular,
    quotedWaitMin: party.quotedWaitMin,
    candidateTableIds: [...party.candidateTableIds],
    autoAssignAt: party.autoAssignAt,
    candidateState: party.candidateState,
    candidateUpdatedAt: party.candidateUpdatedAt,
    candidateFrozen: party.candidateFrozen,
    candidateReason: party.candidateReason,
    hostOverrideTableId: party.hostOverrideTableId,
    insidePlanningHorizon: isInsidePlanningHorizon(state, party),
    committedTableId: party.committedTableId,
    assignmentOrigin: clone(party.assignmentOrigin),
    assignmentReason: party.assignmentReason
    });
  };
}
