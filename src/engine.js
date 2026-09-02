import {
  ADJACENCY_RULE,
  DISTANCE_RULE,
  ENTRANCE,
  EXPECTED_DWELL_MINUTES,
  FLOOR_GRID,
  NEAR_ENTRANCE_MAX_DISTANCE,
  REQUEST_CATEGORY_LABELS,
  RESTAURANT_CAPACITY,
  SCRIPTED_EVENTS,
  SERVER_SECTIONS,
  SERVICE_END,
  SERVICE_START,
  TABLE_DEFINITIONS,
  createNightParties,
  createRandomNightScenario,
  createServiceBrief,
  distanceToEntrance,
  minutesToTime,
  tableDistance,
  tablesAdjacent
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
export const TABLE_RESET_MINUTES = 3;
export const RUSH_DWELL_MINUTES = 60;

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
  candidateReasonSupplied: false,
  reasonSupplied: false,
  seatingScore: null,
  request: definition.request ? clone(definition.request) : null,
  linkedPartyIds: definition.linkedPartyIds ? [...definition.linkedPartyIds] : [],
  marks: { rush: false, allergy: false, discreet: false },
  requestTrace: { blockedAttempts: 0, confirmedSize: null, heldTableSeatsAtConfirm: null },
  rejectedTables: [],
  planApproved: false
});

const manualReview = () => ({
  status: "manual",
  reason: "manual control",
  lastReviewAt: null,
  nextReviewAt: null,
  requestedAt: null,
  plannedPartyCount: 0,
  changedPartyCount: 0
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
        sectionRequests: [],
        seed: String(scenarioSeed),
        runCode: "SATURDAY"
      };
  const state = {
    now: SERVICE_START,
    running: options.running ?? false,
    speed: options.speed ?? 1,
    controllerMode: "manual",
    agentConnection: null,
    agentReview: manualReview(),
    weights: { sat: 0.6, turn: 0.4 },
    tables: TABLE_DEFINITIONS.map(runtimeTable),
    parties: scenario.parties.map(runtimeParty),
    events: scenario.events,
    serviceBrief: clone(scenario.serviceBrief),
    sectionRequests: clone(scenario.sectionRequests || []),
    disruptions: [],
    floorVersion: 0,
    changeLog: [],
    hostDecisions: [],
    agentEverAttached: false,
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
    plan: "Doors open at 5:00. The floor is clear. Seat arrivals by hand, or attach a browser agent through WebMCP.",
    planBullets: ["The engine enforces legality, capacity, locks, and reservation priority", "An attached agent interprets special requests and explains its plans", "The host can override any plan"],
    seatingRecords: [],
    coversHistory: [],
    scoreHistory: [],
    lastError: null,
    revision: 0
  };
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

// ---------------------------------------------------------------------------
// Optimistic concurrency
//
// Every mutation that changes assignments, holds, locks, marks, table status,
// requests, plans, or the clock increments floorVersion and appends to a ring
// buffer of the last 50 changes. Writes may pass expected_version; a mismatch
// is rejected with STALE_STATE and the diff so a human and an agent editing the
// same floor never silently clobber each other.
// ---------------------------------------------------------------------------

export const CHANGE_LOG_LIMIT = 50;

const changeOwner = (source) => (source === "host" ? "HOST" : source === "agent" ? "AI" : "CLOCK");

function recordChange(state, type, details = {}) {
  state.floorVersion += 1;
  state.changeLog.push({
    version: state.floorVersion,
    minute: state.now,
    type,
    partyId: details.partyId ?? null,
    tableId: details.tableId ?? null,
    by: details.by ?? "CLOCK",
    detail: details.detail ?? null
  });
  if (state.changeLog.length > CHANGE_LOG_LIMIT) state.changeLog = state.changeLog.slice(-CHANGE_LOG_LIMIT);
  bump(state);
}

export function changesSince(state, version) {
  const oldest = state.changeLog[0]?.version ?? state.floorVersion + 1;
  return {
    changes: state.changeLog.filter((change) => change.version > version),
    truncated: version < oldest - 1
  };
}

export function checkExpectedVersion(state, expectedVersion, options = {}) {
  if (expectedVersion == null) return null;
  const expected = Number(expectedVersion);
  if (!Number.isInteger(expected) || expected < 0) {
    return failure(state, "INVALID_INPUT", "expected_version must be a non-negative integer.");
  }
  if (expected === state.floorVersion) return null;
  const { changes, truncated } = changesSince(state, expected);
  logActivity(state, "stale_write", `Agent write rejected — floor changed (v${expected} → v${state.floorVersion})${options.tool ? ` · ${options.tool}` : ""}`, "agent");
  return {
    ok: false,
    error: {
      code: "STALE_STATE",
      message: `Floor changed since version ${expected}.`,
      currentVersion: state.floorVersion,
      changes,
      ...(truncated ? { truncated: true } : {})
    }
  };
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


export function rankCandidateTables(state, partyId, options = {}) {
  const party = getParty(state, partyId);
  if (!party) return [];
  return state.tables
    .map((table) => ({ table, result: scoreAssignment(state, party.id, table.id, { forCandidate: true, allowUpcoming: true, source: options.source || "agent" }) }))
    .filter(({ result }) => result.legal)
    .sort((left, right) => right.result.score - left.result.score || left.result.availabilityDelay - right.result.availabilityDelay || left.table.seats - right.table.seats)
    .map(({ table, result }) => ({ tableId: table.id, seats: table.seats, zone: table.zone, ...result }));
}



function isInsidePlanningHorizon(state, party) {
  if (party.status === "waiting") return !party.committedTableId;
  return party.source === "reservation"
    && party.status === "upcoming"
    && party.reservedFor <= state.now + AGENT_PLANNING_HORIZON_MINUTES;
}


function clearCandidatePlan(party) {
  party.candidateTableIds = [];
  party.autoAssignAt = null;
  party.candidateState = "unplanned";
  party.candidateUpdatedAt = null;
  party.candidateFrozen = false;
  party.candidateReason = null;
  party.candidateReasonSupplied = false;
  party.planApproved = false;
}








function requestAgentReview(state, reason) {
  if (state.controllerMode === "external") {
    state.agentReview.status = "review_due";
    state.agentReview.reason = reason;
    state.agentReview.requestedAt ??= state.now;
  }
  return state;
}

function isHostPlan(party) {
  return Boolean(party.hostOverrideTableId && party.candidateTableIds[0] === party.hostOverrideTableId);
}

function agentMayAutoCommit(state) {
  return state.controllerMode === "external" && state.agentConnection?.mode === "autonomous";
}

// A tentative plan executes at arrival when it is the host's own override or when an
// autonomous agent published it. Advisory agents only propose.
function scheduleArrivalCommit(state, party) {
  if (!party.candidateTableIds.length) return;
  if (party.planApproved || isHostPlan(party) || agentMayAutoCommit(state)) party.autoAssignAt = state.now;
}

function approvedOrigin(state) {
  return { kind: "external", label: state.agentConnection?.name || "Agent", approved: true };
}

function commitOptionsFor(state, party) {
  if (party.planApproved) return { source: "agent", origin: approvedOrigin(state), skipPlan: true, reasonSupplied: party.candidateReasonSupplied };
  if (isHostPlan(party)) return { source: "host", skipPlan: true };
  return { source: "agent", skipPlan: true };
}

function commitCandidateDeadlines(state) {
  const due = getWaitingParties(state)
    .filter((party) => party.autoAssignAt != null && party.autoAssignAt <= state.now && party.candidateTableIds.length)
    .filter((party) => party.planApproved || isHostPlan(party) || agentMayAutoCommit(state))
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === "reservation" ? -1 : 1;
      return left.autoAssignAt - right.autoAssignAt;
    });
  for (const party of due) {
    assignTable(state, party.id, party.candidateTableIds[0], commitOptionsFor(state, party));
  }
}

// Proposal loop: the host accepts or rejects an agent's tentative plan. Accept
// locks the top candidate as the agent's plan with human sign-off (AI ✓).
// Reject clears it, remembers the table, and hands the reason back to the agent.
export function acceptAgentPlan(state, partyId, options = {}) {
  const party = getParty(state, partyId);
  if (!party) return failure(state, "PARTY_NOT_FOUND", `Party ${partyId} was not found.`);
  if (party.candidateState !== "tentative" || !party.candidateTableIds.length) {
    return failure(state, "NO_AGENT_PLAN", `${party.name} has no tentative agent plan to accept.`);
  }
  const tableId = party.candidateTableIds[0];
  if (party.status === "waiting") {
    // Seat first so a blocked accept (reservation priority, legality) records nothing.
    const approved = { source: "agent", origin: approvedOrigin(state), reasonSupplied: party.candidateReasonSupplied, reason: party.candidateReason };
    const result = assignTable(state, party.id, tableId, approved);
    if (!result.ok) return result;
    party.planApproved = true;
    recordHostDecision(state, party, "accepted", tableId, { previousTableId: tableId, reason: options.reason });
    logActivity(state, "accept_plan", `${party.name} → ${tableId} · AI plan approved`, "host");
    return success(state, { partyId, tableId, seated: result.seated, approved: true });
  }
  recordHostDecision(state, party, "accepted", tableId, { previousTableId: tableId, reason: options.reason });
  party.planApproved = true;
  party.candidateState = "approved";
  party.hostOverrideTableId = tableId;
  recordChange(state, "plan", { partyId: party.id, tableId, by: "HOST", detail: `${party.name}: agent plan ${tableId} accepted` });
  logActivity(state, "accept_plan", `${party.name} → ${tableId} · AI plan approved`, "host");
  requestAgentReview(state, "host accepted a plan");
  return success(state, { partyId, tableId, seated: false, approved: true });
}

export function rejectAgentPlan(state, partyId, reason = "", options = {}) {
  const party = getParty(state, partyId);
  if (!party) return failure(state, "PARTY_NOT_FOUND", `Party ${partyId} was not found.`);
  if (party.candidateState !== "tentative" || !party.candidateTableIds.length) {
    return failure(state, "NO_AGENT_PLAN", `${party.name} has no tentative agent plan to reject.`);
  }
  const tableId = party.candidateTableIds[0];
  const cleanReason = String(reason || "").trim().slice(0, 160) || null;
  if (!party.rejectedTables.includes(tableId)) party.rejectedTables.push(tableId);
  clearCandidatePlan(party);
  party.hostOverrideTableId = null;
  recordHostDecision(state, party, "rejected", tableId, { previousTableId: tableId, reason: cleanReason });
  recordChange(state, "plan", { partyId: party.id, tableId, by: "HOST", detail: `${party.name}: agent plan ${tableId} rejected${cleanReason ? ` · ${cleanReason}` : ""}` });
  logActivity(state, "reject_plan", `${party.name} ✕ ${tableId}${cleanReason ? ` · ${cleanReason}` : ""}`, "host");
  requestAgentReview(state, "host rejected a plan");
  return success(state, { partyId, tableId, reason: cleanReason, rejectedTables: [...party.rejectedTables] });
}

function assignmentOriginFor(state, source, preservedOrigin = null) {
  if (preservedOrigin) return clone(preservedOrigin);
  if (source === "host") return { kind: "host", label: "Host" };
  return { kind: "external", label: state.agentConnection?.name || "Agent" };
}

function assignmentReasonFor(scored, origin, suppliedReason = null) {
  const cleanReason = String(suppliedReason || "").trim().slice(0, 180);
  if (cleanReason) return cleanReason;
  if (origin.kind === "host") return "Manual host override.";
  if (scored.serviceBriefReasons?.length) return scored.serviceBriefReasons.join("; ");
  return scored.reasons.slice(0, 2).join("; ");
}

function reasonWasSupplied(party, options) {
  if (options.reasonSupplied != null) return Boolean(options.reasonSupplied);
  if (String(options.reason || "").trim()) return true;
  return Boolean(options.skipPlan && party.candidateReasonSupplied);
}

function seatPartyAtTable(state, party, table, source, options = {}) {
  const scored = scoreAssignment(state, party.id, table.id, { forCandidate: true, source });
  const assignmentOrigin = assignmentOriginFor(state, source, options.origin);
  const assignmentReason = assignmentReasonFor(scored, assignmentOrigin, options.reason || party.assignmentReason || party.candidateReason);
  const reasonSupplied = reasonWasSupplied(party, options) || party.reasonSupplied;
  const priorityBypassed = Boolean(getReservationPriorityBlocker(state, party));
  const origin = party.source === "walk_in" ? party.arrivedAt : party.reservedFor;
  const wait = Math.max(0, state.now - origin);
  table.status = "seated";
  table.partyId = party.id;
  table.heldForPartyId = null;
  table.holdUntil = null;
  table.nextPartyId = null;
  table.seatedAt = state.now;
  table.dueAt = state.now + (party.marks.rush ? RUSH_DWELL_MINUTES : EXPECTED_DWELL_MINUTES);
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
  party.reasonSupplied = reasonSupplied;
  party.candidateReason = null;
  party.candidateReasonSupplied = false;
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
    assignmentReason,
    reasonSupplied,
    priorityBypassed
  };
  state.seatingRecords.push(record);
  recordChange(state, "assignment", { partyId: party.id, tableId: table.id, by: changeOwner(source), detail: `${party.name} seated at ${table.id}` });
  state.coversHistory.push({ minute: state.now, covers: party.size });
  state.scoreHistory.push({ minute: state.now, sat: scored.sat });
  state.scoreHistory = state.scoreHistory.slice(-20);
  logActivity(state, "assign_table", `${table.id} ← ${party.name} · ${assignmentOrigin.label} · ${assignmentReason}`, source);
  state.plan = `${assignmentOrigin.label} seated ${party.name} at ${table.id}. ${assignmentReason}`;
}

function recordHostDecision(state, party, action, tableId, options = {}) {
  state.hostDecisions.push({
    partyId: party.id,
    partyName: party.name,
    action,
    tableId,
    previousTableId: options.previousTableId ?? null,
    reason: options.reason || null,
    at: state.now
  });
  if (state.hostDecisions.length > 200) state.hostDecisions = state.hostDecisions.slice(-200);
}

function noteHostDecisionOnAgentPlan(state, party, tableId, options = {}) {
  if (options.source !== "host" || party.candidateState !== "tentative" || !party.candidateTableIds.length) return;
  const agentTop = party.candidateTableIds[0];
  recordHostDecision(state, party, agentTop === tableId ? "accepted" : "overrode", tableId, { previousTableId: agentTop, reason: options.reason });
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
  noteHostDecisionOnAgentPlan(state, party, tableId, { source, reason: options.reason });
  const priorityBlocker = source === "host" ? null : getReservationPriorityBlocker(state, party);
  if (priorityBlocker) {
    party.requestTrace.blockedAttempts += 1;
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
    party.reasonSupplied = reasonWasSupplied(party, options);
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
    recordChange(state, "commitment", { partyId: party.id, tableId: table.id, by: changeOwner(source), detail: `${table.id} committed next to ${party.name}` });
    logActivity(state, "assign_table", `${table.id} held next for ${party.name} · ${assignmentOrigin.label} · ${assignmentReason}`, source);
  }

  if (!options.skipPlan) requestAgentReview(state, source === "host" ? "host assignment override" : "assignment committed");
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
  requestAgentReview(state, "party moved");
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
  recordChange(state, "unassign", { partyId: party.id, tableId: table?.id ?? null, by: changeOwner(options.source || "agent"), detail: `${party.name} returned to the queue` });
  logActivity(state, "unassign", `${party.name} returned to the queue`, options.source || "agent");
  requestAgentReview(state, "party returned to queue");
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
  if (source !== "host" && party.rejectedTables.includes(uniqueIds[0])) {
    const rejection = [...state.hostDecisions].reverse().find((decision) => decision.partyId === party.id && decision.action === "rejected" && decision.tableId === uniqueIds[0]);
    return failure(state, "INVALID_INPUT", `The host rejected ${uniqueIds[0]} for ${party.name}${rejection?.reason ? `: “${rejection.reason}”` : "."} Propose a different table.`, {
      rejectedTables: [...party.rejectedTables],
      hostReason: rejection?.reason || null
    });
  }
  const illegal = uniqueIds
    .map((tableId) => ({ tableId, result: checkAssignmentLegality(state, partyId, tableId, { forCandidate: true, allowUpcoming: true, source }) }))
    .find(({ result }) => !result.legal);
  if (illegal) return failure(state, "ILLEGAL_CANDIDATE", `${illegal.tableId}: ${illegal.result.reasons[0]}`);
  const previousTop = party.candidateTableIds[0] || null;
  party.candidateTableIds = uniqueIds;
  party.candidateState = source === "host" ? "host_override" : "tentative";
  party.candidateUpdatedAt = state.now;
  party.candidateReasonSupplied = Boolean(String(options.reason || "").trim());
  party.candidateReason = String(options.reason || "").trim().slice(0, 180)
    || (source === "host" ? "Manual host override." : "Agent-ranked table plan.");
  party.candidateFrozen = party.status === "upcoming" && party.reservedFor - state.now <= AGENT_FREEZE_WINDOW_MINUTES;
  if (party.status === "waiting" && (previousTop !== uniqueIds[0] || party.autoAssignAt == null)) {
    const deadline = autoAssignAt == null ? state.now + AGENT_FREEZE_WINDOW_MINUTES : autoAssignAt;
    party.autoAssignAt = Math.max(state.now, Math.round(deadline));
  }
  if (party.status === "upcoming") party.autoAssignAt = null;
  recordChange(state, "plan", { partyId: party.id, tableId: uniqueIds[0], by: changeOwner(source), detail: `${party.name} planned for ${uniqueIds.join(" · ")}` });
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
  noteHostDecisionOnAgentPlan(state, party, tableId, { source: "host" });
  party.hostOverrideTableId = tableId;
  const candidates = [tableId, ...party.candidateTableIds.filter((candidateId) => candidateId !== tableId)].slice(0, 3);
  const result = setCandidates(state, partyId, candidates, null, { source: "host" });
  if (!result.ok) return result;
  logActivity(state, "override_candidate", `${party.name} → ${tableId} · host`, "host");
  requestAgentReview(state, "host changed a tentative table");
  return success(state, { partyId, tableId, candidateState: party.candidateState });
}

export function lockTable(state, tableId, reason = "Host hold", options = {}) {
  const table = getTable(state, tableId);
  if (!table) return failure(state, "TABLE_NOT_FOUND", `Table ${tableId} was not found.`);
  table.locked = true;
  table.lockedBy = options.source || "host";
  table.lockReason = reason;
  recordChange(state, "lock", { tableId: table.id, by: changeOwner(options.source || "host"), detail: `${table.id} locked · ${reason}` });
  logActivity(state, "lock_table", `${table.id} · ${reason}`, options.source || "host");
  requestAgentReview(state, "table lock changed");
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
  recordChange(state, "unlock", { tableId: table.id, by: changeOwner(source), detail: `${table.id} unlocked` });
  logActivity(state, "unlock_table", table.id, source);
  requestAgentReview(state, "table lock changed");
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
    party.requestTrace.blockedAttempts += 1;
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
  recordChange(state, "hold", { partyId: party.id, tableId: table.id, by: changeOwner(source), detail: `${table.id} held for ${party.name} until ${minutesToTime(until)}` });
  logActivity(state, "hold_table", `${table.id} → ${party.name} until ${minutesToTime(until)}`, source);
  requestAgentReview(state, "table hold changed");
  return success(state, { tableId, partyId, until: Math.round(until) });
}

export function releaseHold(state, tableId, options = {}) {
  const table = getTable(state, tableId);
  if (!table) return failure(state, "TABLE_NOT_FOUND", `Table ${tableId} was not found.`);
  if (table.status === "held") table.status = "free";
  table.heldForPartyId = null;
  table.holdUntil = null;
  table.nextPartyId = null;
  recordChange(state, "release", { tableId: table.id, by: changeOwner(options.source || "agent"), detail: `${table.id} hold released` });
  logActivity(state, "release_hold", table.id, options.source || "agent");
  requestAgentReview(state, "table hold released");
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
  recordChange(state, "table_status", { tableId: table.id, by: changeOwner(options.source || "agent"), detail: `${table.id} marked ${table.status}` });
  logActivity(state, "mark_table", `${table.id} → ${table.status}`, options.source || "agent");
  requestAgentReview(state, "table readiness changed");
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
    scheduleArrivalCommit(state, party);
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
  recordChange(state, "party_status", { partyId: party.id, by: changeOwner(options.source || "agent"), detail: `${party.name} marked ${status}` });
  logActivity(state, "mark_party", `${party.name} → ${status}`, options.source || "agent");
  requestAgentReview(state, `party marked ${status}`);
  return success(state, { partyId, status: party.status });
}

export const HOST_NOTE_MAX_LENGTH = 280;

// A host note is free text typed mid-service. It becomes the party's request
// (source host, no hidden ground truth) or is appended to an existing one, and
// the attached agent is asked to react.
export function addHostNote(state, partyId, text, options = {}) {
  const party = getParty(state, partyId);
  if (!party) return failure(state, "PARTY_NOT_FOUND", `Party ${partyId} was not found.`);
  const clean = String(text || "").trim().slice(0, HOST_NOTE_MAX_LENGTH);
  if (!clean) return failure(state, "NOTE_REQUIRED", `Provide a note between 1 and ${HOST_NOTE_MAX_LENGTH} characters.`);
  if (party.request) {
    party.request.text = `${party.request.text} — ${clean}`;
    party.request.hostNotes = [...(party.request.hostNotes || []), clean];
  } else {
    party.request = { id: `note-${party.id}`, template: null, category: null, text: clean, source: "host", ground: null, hostNotes: [clean] };
  }
  recordChange(state, "request", { partyId: party.id, by: changeOwner(options.source || "host"), detail: `Host note added for ${party.name}` });
  logActivity(state, "add_host_note", `${party.name} · ${clean}`, options.source || "host");
  requestAgentReview(state, "host note added");
  return success(state, { partyId, request: { text: party.request.text, source: party.request.source } });
}

export const PARTY_MARK_KEYS = Object.freeze(["rush", "allergy", "discreet"]);

export function setPartyMarks(state, partyId, marks = {}, options = {}) {
  const party = getParty(state, partyId);
  if (!party) return failure(state, "PARTY_NOT_FOUND", `Party ${partyId} was not found.`);
  const entries = Object.entries(marks).filter(([key]) => PARTY_MARK_KEYS.includes(key) && marks[key] != null);
  if (!entries.length) return failure(state, "MARK_REQUIRED", `Provide at least one of ${PARTY_MARK_KEYS.join(", ")}.`);
  if (entries.some(([, value]) => typeof value !== "boolean")) return failure(state, "INVALID_MARK", "Marks must be booleans.");
  for (const [key, value] of entries) party.marks[key] = value;
  if (party.marks.rush && party.status === "seated") {
    const table = getTable(state, party.committedTableId);
    if (table?.partyId === party.id && table.seatedAt != null) {
      table.dueAt = Math.min(table.dueAt ?? Infinity, Math.max(state.now, table.seatedAt + RUSH_DWELL_MINUTES));
    }
  }
  const visible = entries.filter(([key]) => key !== "discreet").map(([key, value]) => `${key} ${value ? "on" : "off"}`);
  recordChange(state, "marks", { partyId: party.id, by: changeOwner(options.source || "agent"), detail: `${party.name} marks updated` });
  logActivity(state, "mark_party", `${party.name} · ${visible.length ? visible.join(" · ") : "note recorded"}`, options.source || "agent");
  requestAgentReview(state, "party marks changed");
  return success(state, { partyId, marks: clone(party.marks) });
}

export function setWeights(state, sat, turn = 1 - sat, options = {}) {
  const satNumber = Number(sat);
  const turnNumber = Number(turn);
  if (!Number.isFinite(satNumber) || !Number.isFinite(turnNumber) || satNumber < 0 || turnNumber < 0 || Math.abs(satNumber + turnNumber - 1) > 0.001) {
    return failure(state, "INVALID_WEIGHTS", "Satisfaction and turn weights must be non-negative and total 1.0.");
  }
  state.weights = { sat: satNumber, turn: turnNumber };
  logActivity(state, "set_weights", `Sat ${Math.round(satNumber * 100)} · Turn ${Math.round(turnNumber * 100)}`, options.source || "host");
  requestAgentReview(state, "service objective changed");
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
    reason: nextParty.assignmentReason,
    reasonSupplied: nextParty.reasonSupplied
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
      recordChange(state, "table_status", { tableId: table.id, partyId: party?.id ?? null, detail: `${table.id} turned dirty` });
      logActivity(state, "mark_table", `${table.id} → dirty`, "clock");
      changed = true;
    }
    if (table.status === "dirty" && table.dirtyUntil != null && table.dirtyUntil <= state.now) {
      table.status = "free";
      table.dirtyUntil = null;
      table.assignmentOrigin = null;
      table.assignmentReason = null;
      recordChange(state, "table_status", { tableId: table.id, detail: `${table.id} ready` });
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
        recordChange(state, "release", { tableId: table.id, detail: `${table.id} hold expired` });
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
      scheduleArrivalCommit(state, party);
      const arrivalDetail = party.size > previousSize
        ? `${party.name} arrived · party grew ${previousSize} → ${party.size}`
        : `${party.name} arrived · party of ${party.size}`;
      recordChange(state, "arrival", { partyId: party.id, detail: arrivalDetail });
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
      releasePartyHolds(state, party);
      state.disruptions.push({ type: "no_show", at: state.now, partyId: party.id, detail: `${party.name} did not show for ${minutesToTime(party.reservedFor)}`, resolved: true });
      recordChange(state, "party_status", { partyId: party.id, detail: `${party.name} no-show` });
      logActivity(state, "mark_party", `${party.name} → no-show`, "clock");
      changed = true;
    }
  }
  if (event.type === "kitchen_delay") {
    state.kitchenDelayUntil = event.until;
    state.disruptions.push({ type: "kitchen_delay", at: state.now, partyId: null, detail: `Kitchen delay through ${minutesToTime(event.until)}`, until: event.until, resolved: false });
    recordChange(state, "kitchen", { detail: `Kitchen delay through ${minutesToTime(event.until)}` });
    logActivity(state, "get_floor", `Kitchen delay through ${minutesToTime(event.until)}`, "clock");
    changed = true;
  }
  if (event.type === "party_update") {
    for (const update of event.updates || []) {
      const party = getParty(state, update.partyId);
      if (!party || ["left", "no_show"].includes(party.status) || update.size == null) continue;
      const previousSize = party.size;
      const heldTable = state.tables.find((table) => (
        table.heldForPartyId === party.id || table.nextPartyId === party.id || (party.committedTableId && table.id === party.committedTableId)
      ));
      party.size = update.size;
      party.requestTrace.confirmedSize = update.size;
      party.requestTrace.heldTableSeatsAtConfirm = heldTable ? heldTable.seats : null;
      if (heldTable && heldTable.seats < party.size && party.status !== "seated") {
        releasePartyHolds(state, party);
        logActivity(state, "release_hold", `${heldTable.id} released · ${party.name} outgrew it`, "clock");
      }
      const detail = party.size === previousSize
        ? `${party.name} confirmed ${party.size}`
        : `${party.name} confirmed ${previousSize} → ${party.size}`;
      state.disruptions.push({ type: "party_size_change", at: state.now, partyId: party.id, detail, resolved: false });
      recordChange(state, "party_update", { partyId: party.id, detail });
      logActivity(state, "party_update", detail, "clock");
      changed = true;
    }
  }
  return changed;
}

function releasePartyHolds(state, party) {
  for (const table of state.tables) {
    if (table.heldForPartyId === party.id) {
      if (table.status === "held") table.status = "free";
      table.heldForPartyId = null;
      table.holdUntil = null;
    }
    if (table.nextPartyId === party.id) table.nextPartyId = null;
  }
  if (party.status !== "seated") party.committedTableId = null;
}

function processMinute(state) {
  const reviewReasons = [];
  if (state.kitchenDelayUntil != null && state.kitchenDelayUntil <= state.now) {
    state.kitchenDelayUntil = null;
    for (const disruption of state.disruptions) {
      if (disruption.type === "kitchen_delay" && !disruption.resolved) disruption.resolved = true;
    }
    logActivity(state, "get_floor", "Kitchen delay cleared", "clock");
    reviewReasons.push("kitchen delay cleared");
  }
  const events = state.events.filter((event) => event.minute === state.now && !state.processedEvents.includes(`${event.minute}:${event.type}`));
  for (const event of events) {
    if (processEvent(state, event)) reviewReasons.push(event.type.replaceAll("_", " "));
    state.processedEvents.push(`${event.minute}:${event.type}`);
  }
  if (processTableTransitions(state)) reviewReasons.push("table transition");

  commitCandidateDeadlines(state);
  if (reviewReasons.length) requestAgentReview(state, [...new Set(reviewReasons)].join(" + "));
  if (state.controllerMode === "external"
    && state.agentReview.status !== "review_due"
    && state.agentReview.nextReviewAt != null
    && state.now >= state.agentReview.nextReviewAt) {
    requestAgentReview(state, "10-minute heartbeat");
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

export function jumpClock(state, targetMinute, options = {}) {
  const from = state.now;
  const result = advanceTo(state, targetMinute);
  if (result.ok && state.now !== from) {
    recordChange(state, "clock", { by: changeOwner(options.source || "host"), detail: `Clock jumped ${minutesToTime(from)} → ${minutesToTime(state.now)}` });
  }
  return result;
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


export function attachExternalAgent(state, name, mode = "autonomous") {
  const cleanName = String(name || "").trim().slice(0, 64);
  if (!cleanName) return failure(state, "INVALID_AGENT", "Provide a short agent name.");
  if (!["advisory", "autonomous"].includes(mode)) return failure(state, "INVALID_AGENT_MODE", "Agent mode must be advisory or autonomous.");
  state.controllerMode = "external";
  state.agentEverAttached = true;
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
  recordChange(state, "agent", { by: "AI", detail: `${cleanName} attached (${mode})` });
  logActivity(state, "attach_agent", `${cleanName} · ${mode}`, "agent");
  return success(state, {
    controllerMode: state.controllerMode,
    agent: clone(state.agentConnection),
    floorVersion: state.floorVersion,
    concurrency: `The floor is at version ${state.floorVersion}. Pass expected_version from your last get_floor, get_queue, or write result on every write; a mismatch returns STALE_STATE with the changes you missed.`
  });
}

export function detachExternalAgent(state, options = {}) {
  const previous = state.agentConnection?.name || "External agent";
  state.controllerMode = "manual";
  state.agentConnection = null;
  for (const party of state.parties) {
    clearCandidatePlan(party);
    party.hostOverrideTableId = null;
  }
  state.agentReview = manualReview();
  state.plan = "External agent disconnected. The floor is in manual mode.";
  recordChange(state, "agent", { by: changeOwner(options.source || "agent"), detail: `${previous} detached` });
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
    const origin = record.assignmentOrigin;
    const current = provenance.get(origin.kind) || { kind: origin.kind, label: origin.label, assignments: 0, covers: 0 };
    current.assignments += 1;
    current.covers += record.size;
    provenance.set(origin.kind, current);
  }

  const requestOutcomes = getRequestOutcomes(state);
  const average = (values) => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : null);
  const ownerColumn = (kind, owner, label) => {
    const ownerRecords = records.filter((record) => record.assignmentOrigin?.kind === kind);
    const graded = requestOutcomes.filter((outcome) => outcome.owner === owner && outcome.gradable);
    const decisions = state.hostDecisions;
    return {
      kind,
      owner,
      label,
      present: kind === "host" ? true : state.agentEverAttached,
      specialRequests: {
        satisfied: graded.filter((outcome) => outcome.satisfied).length,
        total: graded.length,
        partial: average(graded.map((outcome) => outcome.partial))
      },
      guestSatisfaction: average(ownerRecords.map((record) => record.sat)),
      walkInP90: percentile(ownerRecords.filter((record) => getParty(state, record.partyId)?.source === "walk_in").map((record) => record.wait), 0.9),
      tableFit: average(ownerRecords.map((record) => record.turn)),
      decisions: ownerRecords.length,
      covers: ownerRecords.reduce((total, record) => total + record.size, 0),
      overrides: kind === "host" ? decisions.filter((decision) => decision.action === "overrode").length : null,
      accepted: kind === "external" ? decisions.filter((decision) => decision.action === "accepted").length : null,
      rejected: kind === "external" ? decisions.filter((decision) => decision.action === "rejected").length : null,
      overridden: kind === "external" ? decisions.filter((decision) => decision.action === "overrode").length : null
    };
  };
  const gradedOutcomes = requestOutcomes.filter((outcome) => outcome.gradable);

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
    briefResults: brief.results,
    comparison: {
      host: ownerColumn("host", "HOST", "Host decisions"),
      agent: ownerColumn("external", "AI", state.agentConnection?.name ? `${state.agentConnection.name} decisions` : "Agent decisions")
    },
    requests: {
      total: gradedOutcomes.length,
      satisfied: gradedOutcomes.filter((outcome) => outcome.satisfied).length,
      unattributed: gradedOutcomes.filter((outcome) => !outcome.owner).length,
      outcomes: requestOutcomes
    },
    reservationPriorityViolations: state.seatingRecords.filter((record) => record.priorityBypassed && record.source !== "host").length,
    hostPriorityOverrides: state.seatingRecords.filter((record) => record.priorityBypassed && record.source === "host").length,
    agentEverAttached: state.agentEverAttached
  };
}

// ---------------------------------------------------------------------------
// Special request grading
//
// Each predicate is a pure function over final state: seating records, marks,
// the party-update trace, and floor geometry. The agent never sees `ground`;
// it must infer intent from the request text. Grades stay hidden until the
// 10 PM recap.
// ---------------------------------------------------------------------------

const verdict = (ok, reason, partial = ok ? 1 : 0) => ({ ok: Boolean(ok), partial: clamp(partial), reason });
const seatedTable = (state, partyId) => {
  const record = latestSeatingRecord(state, partyId);
  return { record, table: record ? getTable(state, record.tableId) : null };
};
const zoneLabel = (zone) => SERVER_SECTIONS[zone]?.label || `${zone} zone`;

const REQUEST_PREDICATES = {
  zoneNotIn(state, party, zones, { record, table, ground }) {
    if (!table) return verdict(false, "never seated");
    if (ground.ifSeatedAfter != null && record.minute < ground.ifSeatedAfter) {
      return verdict(true, `seated at ${minutesToTime(record.minute)}, before the ${minutesToTime(ground.ifSeatedAfter)} cutoff, so ${table.id} in the ${zoneLabel(table.zone)} was fine`);
    }
    const ok = !zones.includes(table.zone);
    return verdict(ok, ok ? `${table.id} kept them out of the ${zones.map(zoneLabel).join(" and ")}` : `${table.id} is in the ${zoneLabel(table.zone)}, which they asked to avoid`);
  },
  zoneIn(state, party, zones, { table }) {
    if (!table) return verdict(false, "never seated");
    const ok = zones.includes(table.zone);
    return verdict(ok, ok ? `${table.id} sits in the ${zoneLabel(table.zone)}` : `${table.id} is in the ${zoneLabel(table.zone)}; they needed ${zones.map(zoneLabel).join(" or ")}`);
  },
  quietOrBooth(state, party, expected, { table }) {
    if (!table) return verdict(false, "never seated");
    const ok = Boolean(table.quiet || table.shape === "booth") === expected;
    return verdict(ok, ok ? `${table.id} is a quiet table or booth` : `${table.id} is neither quiet nor a booth`);
  },
  shapeNot(state, party, shape, { table }) {
    if (!table) return verdict(false, "never seated");
    const ok = table.shape !== shape;
    return verdict(ok, ok ? `${table.id} is not a ${shape}` : `${table.id} is a ${shape}, which they did not want`);
  },
  nearEntrance(state, party, expected, { table }) {
    if (!table) return verdict(false, "never seated");
    const distance = distanceToEntrance(table);
    const ok = (distance <= NEAR_ENTRANCE_MAX_DISTANCE) === expected;
    return verdict(ok, `${table.id} is ${distance} grid units from the entrance (${ok ? "can" : "cannot"} see the door)`, ok ? 1 : clamp(1 - (distance - NEAR_ENTRANCE_MAX_DISTANCE) / 4));
  },
  adjacentTablesEmptyUntil(state, party, until, { record, table }) {
    if (!table) return verdict(false, "never seated");
    const neighbors = state.seatingRecords.filter((other) => (
      other.partyId !== party.id
      && other.minute >= record.minute
      && other.minute < until
      && tablesAdjacent(table, getTable(state, other.tableId))
    ));
    const ok = neighbors.length === 0;
    return verdict(
      ok,
      ok ? `no party was seated next to ${table.id} before ${minutesToTime(until)}` : `${neighbors.length} ${neighbors.length === 1 ? "party was" : "parties were"} seated next to ${table.id} before ${minutesToTime(until)} (${neighbors.map((other) => other.tableId).join(", ")})`,
      clamp(1 - neighbors.length / 3)
    );
  },
  withinDistanceOfParty(state, party, { id, maxGrid }, { table }) {
    if (!table) return verdict(false, "never seated");
    const other = getParty(state, id);
    const otherSeat = seatedTable(state, id);
    if (other?.status === "no_show") return verdict(true, `${other.name} never came, so proximity did not apply`);
    if (!otherSeat.table) return verdict(false, `${other?.name || id} was never seated`);
    const distance = tableDistance(table, otherSeat.table);
    const ok = distance <= maxGrid;
    return verdict(ok, `${table.id} is ${distance} grid units from ${other.name} at ${otherSeat.table.id} (asked for ${maxGrid} or closer)`, ok ? 1 : distance <= maxGrid + 1 ? 0.5 : 0);
  },
  notSameTable(state, party, id, { table }) {
    if (!table) return verdict(false, "never seated");
    const otherSeat = seatedTable(state, id);
    const ok = !otherSeat.table || otherSeat.table.id !== table.id;
    return verdict(ok, ok ? "each family kept its own table" : "both families were put at the same table");
  },
  minDistanceFromParty(state, party, { id, minGrid }, { table }) {
    if (!table) return verdict(false, "never seated");
    const other = getParty(state, id);
    const otherSeat = seatedTable(state, id);
    if (other?.status === "no_show") return verdict(true, `${other.name} never came, so distance did not apply`);
    if (!otherSeat.table) return verdict(false, `${other?.name || id} was never seated`);
    const distance = tableDistance(table, otherSeat.table);
    const ok = distance >= minGrid;
    return verdict(ok, `${table.id} is ${distance} grid units from ${other.name} at ${otherSeat.table.id} (asked for at least ${minGrid})`, ok ? 1 : distance >= minGrid - 1 ? 0.5 : 0);
  },
  allTablesSameSection(state, party, expected, { ground }) {
    const group = (party.request?.groupPartyIds || [party.id]).map((id) => seatedTable(state, id));
    const seated = group.filter((entry) => entry.table);
    if (seated.length < group.length) return verdict(false, `${group.length - seated.length} of ${group.length} linked tables were never seated`, seated.length / group.length * 0.5);
    const zones = seated.map((entry) => entry.table.zone);
    const majority = Math.max(...[...new Set(zones)].map((zone) => zones.filter((entry) => entry === zone).length));
    const ok = majority === zones.length;
    return verdict(ok, ok ? `all ${zones.length} tables sit in the ${zoneLabel(zones[0])}` : `tables were split across ${[...new Set(zones)].map(zoneLabel).join(" and ")}`, majority / zones.length);
  },
  tablesAdjacent(state, party, expected) {
    const group = (party.request?.groupPartyIds || [party.id]).map((id) => seatedTable(state, id));
    const tables = group.map((entry) => entry.table).filter(Boolean);
    if (tables.length < group.length) return verdict(false, "not every linked table was seated", tables.length / group.length * 0.5);
    const withNeighbor = tables.filter((table) => tables.some((other) => tablesAdjacent(table, other)));
    const ok = tables.length < 2 || withNeighbor.length === tables.length;
    return verdict(ok, ok ? `${tables.map((table) => table.id).join(", ")} sit side by side` : `${tables.length - withNeighbor.length} of ${tables.length} tables had no linked neighbor`, withNeighbor.length / tables.length);
  },
  capacityAtLeastIfConfirmed(state, party, seats, { table }) {
    const confirmed = party.requestTrace.confirmedSize;
    if (!table) return verdict(false, "never seated");
    if (confirmed == null || confirmed < seats) return verdict(true, `final size was ${party.size}; ${table.id} fits`);
    const ok = table.seats >= seats;
    return verdict(ok, ok ? `they grew to ${confirmed} and ${table.id} seats ${table.seats}` : `they grew to ${confirmed} but ${table.id} only seats ${table.seats}`);
  },
  flexibilityHeldUntil(state, party, until, { ground }) {
    const seatsHeld = party.requestTrace.heldTableSeatsAtConfirm;
    const needed = ground.capacityAtLeastIfConfirmed ?? party.size;
    if (party.requestTrace.confirmedSize == null) return verdict(false, `the ${minutesToTime(until)} confirmation never arrived`);
    const ok = seatsHeld == null || seatsHeld >= needed;
    return verdict(ok, ok ? `no undersized table was committed before ${minutesToTime(until)}` : `a ${seatsHeld}-seat table was committed before the ${minutesToTime(until)} confirmation`);
  },
  seatedBy(state, party, minute, { record }) {
    if (!record) return verdict(false, "never seated");
    const late = record.minute - minute;
    const ok = late <= 0;
    return verdict(ok, ok ? `seated at ${minutesToTime(record.minute)}, in time` : `seated at ${minutesToTime(record.minute)}, ${late} min after the ${minutesToTime(minute)} target`, ok ? 1 : clamp(1 - late / 30));
  },
  markedRush(state, party, expected) {
    const ok = party.marks.rush === expected;
    return verdict(ok, ok ? "flagged as a rush so the kitchen could pace the table" : "never flagged as a rush");
  },
  ifSeatedAfter(state, party, cutoff, { record }) {
    if (!record) return verdict(false, "never seated");
    return verdict(true, record.minute < cutoff ? `seated before the ${minutesToTime(cutoff)} cutoff` : `seated after the ${minutesToTime(cutoff)} cutoff, so the zone rule applied`);
  },
  acceptableOutcomes(state, party, outcomes, { ground }) {
    const regular = seatedTable(state, ground.regularPartyId);
    const anniversary = seatedTable(state, ground.anniversaryPartyId);
    const anniversaryParty = getParty(state, ground.anniversaryPartyId);
    if (!regular.table) return verdict(false, "the regular was never seated");
    if (anniversaryParty?.status === "no_show") return verdict(true, `${anniversaryParty.name} never came; ${regular.table.id} for the regular stands`);
    if (!anniversary.table) return verdict(false, `${anniversaryParty?.name || "the anniversary party"} was never seated`, 0.5);
    const matches = (outcome) => (
      (outcome.regularTable == null || regular.table.id === outcome.regularTable)
      && (outcome.regularZone == null || regular.table.zone === outcome.regularZone)
      && (outcome.anniversaryTable == null || anniversary.table.id === outcome.anniversaryTable)
      && (outcome.anniversaryZone == null || anniversary.table.zone === outcome.anniversaryZone)
    );
    const ok = outcomes.some(matches);
    return verdict(ok, `regular at ${regular.table.id}, anniversary at ${anniversary.table.id}${ok ? " — an acceptable call" : " — neither claim was honored well"}`);
  },
  requiresReason(state, party, expected, { record }) {
    if (!record) return verdict(false, "never seated");
    const ok = Boolean(record.reasonSupplied);
    return verdict(ok, ok ? `decision explained: “${record.assignmentReason}”` : "no explanation was given for the call");
  },
  markedAllergy(state, party, expected) {
    const ok = party.marks.allergy === expected;
    return verdict(ok, ok ? "allergy flagged for the servers" : "allergy was never flagged for the servers");
  },
  noVisibleFlag(state, party, expected) {
    const visible = ["rush", "allergy"].filter((key) => party.marks[key]);
    const ok = visible.length === 0;
    return verdict(ok, ok ? "no floor-visible flag gave them away" : `a visible ${visible.join(" and ")} flag made it obvious`);
  },
  reservationPriorityRespected(state, party) {
    const bypassed = state.seatingRecords.filter((record) => record.partyId === party.id && record.priorityBypassed && record.source !== "host");
    const ok = bypassed.length === 0;
    const blocked = party.requestTrace.blockedAttempts;
    return verdict(ok, `${ok ? "the queue held" : "they jumped the queue"}${blocked ? `; the engine blocked ${blocked} premature seating attempt${blocked === 1 ? "" : "s"}` : ""}`);
  }
};

const REQUEST_META_KEYS = new Set(["regularPartyId", "anniversaryPartyId"]);

export function gradeRequest(state, party) {
  const request = party?.request;
  if (!request) return null;
  if (!request.ground) return { gradable: false, satisfied: null, partial: null, reasons: ["Host note · not graded"], checks: [] };
  const { record, table } = seatedTable(state, party.id);
  const context = { record, table, ground: request.ground };
  const checks = Object.entries(request.ground)
    .filter(([key]) => REQUEST_PREDICATES[key] && !REQUEST_META_KEYS.has(key))
    .map(([key, value]) => ({ key, ...REQUEST_PREDICATES[key](state, party, value, context) }));
  const partial = checks.length ? checks.reduce((total, check) => total + check.partial, 0) / checks.length : 0;
  return {
    gradable: true,
    satisfied: checks.length > 0 && checks.every((check) => check.ok),
    partial: Math.round(partial * 100) / 100,
    reasons: checks.map((check) => check.reason),
    checks
  };
}

export function gradeSectionRequest(state, request) {
  const ground = request?.ground;
  if (!ground) return { gradable: false, satisfied: null, partial: null, reasons: ["Host note · not graded"], records: [] };
  const records = state.seatingRecords.filter((record) => (
    record.minute >= ground.from && record.minute < ground.until && getTable(state, record.tableId)?.zone === ground.sectionZone
  ));
  const violations = records.filter((record) => {
    const party = getParty(state, record.partyId);
    const allergy = Boolean(party?.marks.allergy || party?.request?.ground?.markedAllergy);
    return record.size > ground.maxPartySize || (ground.noAllergyParties && allergy);
  });
  const satisfied = violations.length === 0;
  const reasons = [
    records.length
      ? `${records.length} ${records.length === 1 ? "party" : "parties"} seated in the ${zoneLabel(ground.sectionZone)} between ${minutesToTime(ground.from)} and ${minutesToTime(ground.until)}`
      : `no party was seated in the ${zoneLabel(ground.sectionZone)} during the window`,
    ...(violations.length ? [`${violations.length} broke the rule: ${violations.map((record) => `${getParty(state, record.partyId)?.name || record.partyId} (${record.size}) at ${record.tableId}`).join(", ")}`] : [])
  ];
  return {
    gradable: true,
    satisfied,
    partial: records.length ? Math.round((1 - violations.length / records.length) * 100) / 100 : 1,
    reasons,
    records
  };
}

const ownerLabel = (origin) => (origin ? (origin.kind === "host" ? "HOST" : "AI") : null);

function requestStatus(state, party) {
  const record = latestSeatingRecord(state, party.id);
  if (record) return { status: "addressed", addressedBy: ownerLabel(record.assignmentOrigin) };
  if (["no_show", "left"].includes(party.status)) return { status: "failed", addressedBy: null };
  return { status: "open", addressedBy: null };
}

function sectionRequestOwner(state, request) {
  const graded = gradeSectionRequest(state, request);
  const owners = graded.records.map((record) => ownerLabel(record.assignmentOrigin)).filter(Boolean);
  if (!owners.length) return null;
  const counts = owners.reduce((totals, owner) => ({ ...totals, [owner]: (totals[owner] || 0) + 1 }), {});
  return Object.entries(counts).sort((left, right) => right[1] - left[1])[0][0];
}

export function listOpenRequests(state) {
  const partyRequests = state.parties
    .filter((party) => party.request)
    .map((party) => ({
      partyId: party.id,
      partyName: party.name,
      scope: "party",
      category: party.request.category || null,
      text: party.request.text,
      source: party.request.source,
      arrivesAt: party.source === "reservation" ? party.reservedFor : party.arrivedAt,
      ...requestStatus(state, party)
    }));
  const sectionRequests = state.sectionRequests.map((request) => ({
    partyId: null,
    partyName: null,
    scope: "section",
    category: request.category || null,
    zone: request.zone,
    text: request.text,
    source: request.source,
    arrivesAt: request.ground?.from ?? null,
    status: state.now >= (request.ground?.until ?? SERVICE_END) ? "addressed" : "open",
    addressedBy: state.now >= (request.ground?.until ?? SERVICE_END) ? sectionRequestOwner(state, request) : null
  }));
  return [...partyRequests, ...sectionRequests].sort((left, right) => (left.arrivesAt ?? Infinity) - (right.arrivesAt ?? Infinity));
}

// Outcomes are exposed in the 10 PM recap, so they carry plain-language reasons
// only; predicate keys never leave the engine.
const publicGrade = ({ checks, records, ...grade }) => grade;

export function getRequestOutcomes(state) {
  const partyOutcomes = state.parties
    .filter((party) => party.request)
    .map((party) => {
      const grade = publicGrade(gradeRequest(state, party));
      const record = latestSeatingRecord(state, party.id);
      return {
        partyId: party.id,
        partyName: party.name,
        scope: "party",
        category: party.request.category || null,
        categoryLabel: REQUEST_CATEGORY_LABELS[party.request.category] || null,
        template: party.request.template || null,
        text: party.request.text,
        source: party.request.source,
        owner: ownerLabel(record?.assignmentOrigin),
        tableId: record?.tableId || null,
        reason: record?.assignmentReason || null,
        ...grade
      };
    });
  const sectionOutcomes = state.sectionRequests.map((request) => ({
    partyId: null,
    partyName: null,
    scope: "section",
    category: request.category || null,
    categoryLabel: REQUEST_CATEGORY_LABELS[request.category] || null,
    template: request.template || null,
    text: request.text,
    source: request.source,
    owner: sectionRequestOwner(state, request),
    tableId: null,
    reason: null,
    ...publicGrade(gradeSectionRequest(state, request))
  }));
  return [...partyOutcomes, ...sectionOutcomes];
}

function nextRecommendedActions(state) {
  if (state.now >= SERVICE_END) return ["Review the service recap", "Start a new random run"];
  const waitingReservation = state.parties.find((party) => party.source === "reservation" && party.status === "waiting" && !party.committedTableId);
  const upcomingRequests = listOpenRequests(state)
    .filter((request) => request.status === "open" && request.partyId && request.arrivesAt != null && request.arrivesAt <= state.now + AGENT_PLANNING_HORIZON_MINUTES)
    .filter((request) => !getParty(state, request.partyId)?.committedTableId && !getParty(state, request.partyId)?.candidateTableIds.length)
    .slice(0, 2)
    .map((request) => `Special request from ${request.partyName} (${minutesToTime(request.arrivesAt)}): “${request.text.length > 90 ? `${request.text.slice(0, 87)}…` : request.text}”`);
  if (state.controllerMode === "manual") {
    return [
      ...(waitingReservation
        ? [`Seat reservation ${waitingReservation.name} before a walk-in`, "Drag the party row to a legal table or select party then table"]
        : ["Assign each arrived party manually", "Quote a wait when no legal table is ready"]),
      ...upcomingRequests
    ];
  }
  const kitchenDelayActive = Boolean(state.kitchenDelayUntil && state.now < state.kitchenDelayUntil);
  const waitingWalkIns = state.parties.filter((party) => party.source === "walk_in" && party.status === "waiting" && !party.committedTableId);
  const delayActions = kitchenDelayActive
    ? [
      `Kitchen delay until ${minutesToTime(state.kitchenDelayUntil)}: ${waitingWalkIns.length ? `quote_wait for ${waitingWalkIns.slice(0, 3).map((party) => party.name).join(", ")} with honest minutes` : "quote honest waits for any walk-in that arrives"}`,
      "Review hold_table commitments; kitchen-zone tables score lower until the delay clears"
    ]
    : [];
  const base = state.agentReview.status === "review_due"
    ? ["Read get_floor and get_queue", "Publish up to three candidates with a concise reason that says how the plan honors any special request", "Explain the current whole-floor plan"]
    : ["Keep tentative tables current for parties inside the 45-minute horizon", "Re-read get_floor after every write"];
  return [...delayActions, ...upcomingRequests, ...base, `Pass expected_version: ${state.floorVersion} on your next write so a host change is never clobbered`];
}

export function getFloorSnapshot(state) {
  return {
    clock: minutesToTime(state.now),
    minute: state.now,
    floorVersion: state.floorVersion,
    recentChanges: state.changeLog.slice(-10),
    recentHostDecisions: state.hostDecisions.slice(-20).map((decision) => ({
      partyId: decision.partyId,
      action: decision.action,
      tableId: decision.tableId,
      reason: decision.reason,
      at: decision.at
    })),
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
    kitchenDelayUntil: state.kitchenDelayUntil,
    disruptions: state.disruptions.slice(-20).map((disruption) => ({
      type: disruption.type,
      at: disruption.at,
      partyId: disruption.partyId ?? null,
      detail: disruption.detail,
      resolved: Boolean(disruption.resolved)
    })),
    serviceBrief: clone(state.serviceBrief),
    sectionRequests: state.sectionRequests.map((request) => ({
      id: request.id,
      scope: "section",
      zone: request.zone,
      server: SERVER_SECTIONS[request.zone]?.server || null,
      text: request.text,
      source: request.source
    })),
    geometry: {
      columns: FLOOR_GRID.columns,
      rows: FLOOR_GRID.rows,
      entrance: { ...ENTRANCE },
      adjacencyRule: ADJACENCY_RULE,
      distanceRule: DISTANCE_RULE,
      nearEntranceMaxDistance: NEAR_ENTRANCE_MAX_DISTANCE,
      sections: Object.fromEntries(Object.entries(SERVER_SECTIONS).map(([zone, section]) => [zone, { ...section }]))
    },
    nextRecommendedActions: nextRecommendedActions(state),
    weights: clone(state.weights),
    tables: state.tables.map((table) => ({
      id: table.id,
      seats: table.seats,
      minSeats: table.minSeats,
      shape: table.shape,
      zone: table.zone,
      server: SERVER_SECTIONS[table.zone]?.server || null,
      layout: { ...table.layout },
      distanceToEntrance: distanceToEntrance(table),
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
      partyMarks: table.status === "seated" && table.partyId
        ? { rush: Boolean(getParty(state, table.partyId)?.marks.rush), allergy: Boolean(getParty(state, table.partyId)?.marks.allergy) }
        : null,
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
    floorVersion: state.floorVersion,
    servicePolicy: {
      order: ["waiting_reservation", "waiting_walk_in"],
      rule: "Seat a waiting reservation first whenever a legal table is available.",
      hostMayOverride: true
    },
    serviceBrief: clone(state.serviceBrief),
    requestPolicy: "Special requests are natural language written by guests or the host. Interpret intent; the floor grades outcomes at 10 PM. Say how your plan honors a request in `reason`.",
    openRequests: listOpenRequests(state),
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
    notes: party.notes || "",
    request: party.request ? { text: party.request.text, source: party.request.source } : null,
    linkedPartyIds: [...party.linkedPartyIds],
    marks: clone(party.marks),
    quotedWaitMin: party.quotedWaitMin,
    candidateTableIds: [...party.candidateTableIds],
    autoAssignAt: party.autoAssignAt,
    candidateState: party.candidateState,
    candidateUpdatedAt: party.candidateUpdatedAt,
    candidateFrozen: party.candidateFrozen,
    candidateReason: party.candidateReason,
    planApproved: party.planApproved,
    rejectedTables: [...party.rejectedTables],
    hostOverrideTableId: party.hostOverrideTableId,
    insidePlanningHorizon: isInsidePlanningHorizon(state, party),
    committedTableId: party.committedTableId,
    assignmentOrigin: clone(party.assignmentOrigin),
    assignmentReason: party.assignmentReason
    });
  };
}
