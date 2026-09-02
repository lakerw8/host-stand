import { PREFERENCE_LABELS, RESTAURANT_CAPACITY, SERVICE_END, SERVICE_START, TABLE_UNIT_COUNT, minutesToTime } from "./data.js";
import {
  AGENT_FREEZE_WINDOW_MINUTES,
  AGENT_HEARTBEAT_MINUTES,
  AGENT_PLANNING_HORIZON_MINUTES,
  advanceMinutes,
  advanceTo,
  assignTable,
  checkAssignmentLegality,
  createInitialState,
  detachExternalAgent,
  elapsedToSimMinutes,
  getMetrics,
  getNextEventMinute,
  getParty,
  getReservationPriorityBlocker,
  getServiceRecap,
  getTable,
  lockTable,
  markParty,
  markTable,
  setHostCandidateOverride,
  setWeights,
  unlockTable
} from "./engine.js";
import { registerWebMCP } from "./webmcp.js";

const root = document.querySelector("#app");
let seedSequence = 0;
const createScenarioSeed = () => globalThis.crypto?.randomUUID?.() || `night-${Date.now()}-${seedSequence++}`;
let state = createInitialState({ scenarioSeed: createScenarioSeed(), randomizeScenario: true });
let selectedPartyId = null;
let selectedTableId = null;
let hoverPartyId = null;
let draggingPartyId = null;
let interactionHold = false;
let paletteOpen = false;
let agentPanelOpen = false;
let simulationPanelOpen = false;
let webmcpStatus = { supported: null, entryPoint: null, registered: 0, total: 20, failures: [] };
let feedback = null;
let carryMinutes = 0;
let lastRealTick = performance.now();
let lastAnimatedActivity = null;
let resetQueueViewport = false;
let recapClosedForRun = null;

const icons = {
  pause: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
  play: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z"/></svg>',
  skip: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 5 9 7-9 7ZM18 5v14"/></svg>',
  lock: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-2.6"/></svg>',
  users: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  spark: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 18V9M10 18V5M16 18v-7M22 18V3"/></svg>',
  command: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M9 6a3 3 0 1 1-3-3c1.7 0 3 1.3 3 3v12a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V6a3 3 0 1 1 3 3H6"/></svg>',
  close: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  check: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
  warning: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5M12 18v.01"/></svg>',
  clock: '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  chevron: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>'
};

const icon = (name) => `<span class="icon">${icons[name]}</span>`;

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const formatPercent = (value) => value == null ? "—" : `${Math.round(value * 100)}%`;
const formatNumber = (value) => value == null ? "—" : String(Math.round(value));

const AGENT_PROMPT = "Attach to Host Stand as my external table-allocation agent in autonomous mode. Call attach_agent, then read get_floor and get_queue. Treat serviceBrief as soft whole-floor context and hard legality plus reservation priority as non-negotiable unless the human host overrides. Maintain up to three ranked tentative tables for every reservation inside the 45-minute planning horizon and every waiting party. Include a concise reason with set_candidates and assign_table so the host can audit each choice. Reassess whenever agentReview.status is review_due, after every write, and at the 10-minute heartbeat. Respect hostOverrideTableId as fixed. Autonomous candidates execute at arrival or their deadline if the host does not override.";

function serviceBriefLabel(directive) {
  if (directive.type === "section_load") {
    return `${directive.server} overloaded · ${minutesToTime(directive.from).replace(" PM", "")}–${minutesToTime(directive.until).replace(" PM", "")}`;
  }
  if (directive.type === "party_proximity") return `${directive.partyNames.join(" + ")} nearby`;
  return directive.text;
}

function renderServiceBrief() {
  const directives = state.serviceBrief?.directives || [];
  return `
    <div class="service-brief" aria-label="Tonight’s seating brief">
      <strong>Service brief</strong>
      ${directives.map((directive) => `<span title="${escapeHtml(directive.text)}">${escapeHtml(serviceBriefLabel(directive))}</span>`).join("")}
    </div>
  `;
}


function renderServiceRecap() {
  if (state.now < SERVICE_END) return "";
  const recap = getServiceRecap(state);
  return `
    <dialog class="recap-dialog" id="service-recap" aria-labelledby="recap-title">
      <div class="recap-dialog__head">
        <div>
          <span class="command-kicker">SERVICE COMPLETE · ${escapeHtml(state.runCode)}</span>
          <h2 id="recap-title">How the floor performed</h2>
          <p>Host and agent decisions, graded on the same floor.</p>
        </div>
        <div class="recap-grade" aria-label="Grade ${recap.grade}, ${recap.score} out of 100"><strong>${recap.grade}</strong><span>${recap.score}/100</span></div>
      </div>
      <div class="recap-components" aria-label="Score components">
        ${recap.components.map((component) => `
          <div>
            <span>${escapeHtml(component.label)}</span>
            <b>${Math.round(component.value * 100)}%</b>
            <i aria-hidden="true"><span style="--recap-value:${Math.round(component.value * 100)}%"></span></i>
            <small>${component.points} points · ${Math.round(component.weight * 100)}% weight</small>
          </div>
        `).join("")}
      </div>
      <div class="recap-details">
        <section>
          <h3>Decision ownership</h3>
          <p>${recap.partiesServed}/${recap.eligibleParties} parties seated · ${recap.coversServed} covers</p>
          <ul>${recap.provenance.length ? recap.provenance.map((origin) => `<li><strong>${escapeHtml(origin.label)}</strong><span>${origin.assignments} assignments · ${origin.covers} covers</span></li>`).join("") : "<li>No assignments recorded</li>"}</ul>
        </section>
        <section>
          <h3>Service brief</h3>
          <ul>${recap.briefResults.map((result) => `<li><strong>${Math.round(result.value * 100)}%</strong><span>${escapeHtml(result.result)}</span></li>`).join("")}</ul>
        </section>
      </div>
      <p class="recap-formula">Demo score—not an OpenAI judging score. ${escapeHtml(recap.formula)}.</p>
      <div class="recap-actions">
        <button class="control control--quiet" type="button" data-action="close-recap">Return to floor</button>
        <button class="control recap-actions__primary" type="button" data-action="reset-night">Start a new random run</button>
      </div>
    </dialog>
  `;
}

function agentReviewPresentation() {
  if (state.controllerMode === "manual") {
    return {
      label: "Manual assignment",
      detail: "No automatic reviews",
      tone: "manual",
      meta: ""
    };
  }
  const due = state.agentReview.status === "review_due";
  return {
    label: due ? "Review requested" : "Plan received",
    detail: due ? state.agentReview.reason : `Last review ${minutesToTime(state.agentReview.lastReviewAt ?? state.now)}`,
    tone: due ? "due" : "planned",
    meta: due
      ? "Waiting for the attached agent to re-read the floor"
      : `${state.agentReview.plannedPartyCount} tentative · ${AGENT_PLANNING_HORIZON_MINUTES}m horizon · T−${AGENT_FREEZE_WINDOW_MINUTES} lock`
  };
}

function activitySignature(entry) {
  return entry ? `${entry.minute}:${entry.tool}:${entry.detail}:${entry.source}` : null;
}

function captureAgentAssignment() {
  const latest = state.activity.find((entry) => (
    entry.tool === "assign_table"
    && entry.source === "agent"
    && entry.detail.includes("←")
    && activitySignature(entry) !== lastAnimatedActivity
  ));
  const signature = activitySignature(latest);
  if (!latest) return null;
  const tableId = latest.detail.split(" ")[0];
  const table = getTable(state, tableId);
  const party = table?.partyId ? getParty(state, table.partyId) : null;
  const row = party ? root.querySelector(`.party-row[data-party-id="${CSS.escape(party.id)}"]`) : null;
  if (!party || !row) return null;
  return {
    party: { id: party.id, name: party.name, size: party.size },
    tableId,
    origin: party.assignmentOrigin,
    from: row.getBoundingClientRect(),
    signature
  };
}

function animateAgentAssignment(transition) {
  if (!transition || globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const target = root.querySelector(`.table-node[data-table-id="${CSS.escape(transition.tableId)}"]`);
  if (!target) return;
  document.body.dataset.lastAgentMove = `${transition.party.id}:${transition.tableId}`;
  const destination = target.getBoundingClientRect();
  const marker = document.createElement("div");
  marker.className = "assignment-flight";
  marker.setAttribute("aria-hidden", "true");
  marker.innerHTML = `<span>AI</span><strong>${escapeHtml(transition.party.name)}</strong><small>→ ${escapeHtml(transition.tableId)}</small>`;
  marker.style.left = `${transition.from.left}px`;
  marker.style.top = `${transition.from.top}px`;
  marker.style.width = `${Math.min(transition.from.width, 220)}px`;
  document.body.append(marker);

  const motionTokens = getComputedStyle(document.documentElement);
  const easeOut = motionTokens.getPropertyValue("--ease-out").trim();
  const durationLong = Number.parseFloat(motionTokens.getPropertyValue("--dur-long")) || 420;
  const fromX = transition.from.left + transition.from.width / 2;
  const fromY = transition.from.top + transition.from.height / 2;
  const toX = destination.left + destination.width / 2;
  const toY = destination.top + destination.height / 2;
  const flight = marker.animate([
    { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
    { opacity: 0.92, transform: `translate3d(${toX - fromX}px, ${toY - fromY}px, 0) scale(0.62)` }
  ], { duration: durationLong, easing: easeOut, fill: "forwards" });
  target.animate([
    { transform: "scale(1)" },
    { transform: "scale(0.96)" },
    { transform: "scale(1)" }
  ], { duration: durationLong, delay: durationLong * 0.6, easing: easeOut });
  flight.finished.finally(() => marker.remove());
}

function renderAgentChange() {
  const transition = captureAgentAssignment();
  render();
  if (transition) {
    lastAnimatedActivity = transition.signature;
    requestAnimationFrame(() => animateAgentAssignment(transition));
  }
}

function resetNight() {
  const previousController = state.controllerMode;
  const previousConnection = state.agentConnection ? { ...state.agentConnection } : null;
  const fresh = createInitialState({
    scenarioSeed: createScenarioSeed(),
    randomizeScenario: true
  });
  if (previousController === "external" && previousConnection) {
    fresh.controllerMode = "external";
    fresh.agentConnection = { ...previousConnection, attachedAt: fresh.now, lastSeenAt: fresh.now };
    fresh.agentReview = {
      status: "review_due",
      reason: "new random run",
      lastReviewAt: null,
      nextReviewAt: fresh.now + AGENT_HEARTBEAT_MINUTES,
      requestedAt: fresh.now,
      plannedPartyCount: 0,
      changedPartyCount: 0
    };
    fresh.plan = `${previousConnection.name} remains attached. A new random floor is ready to inspect.`;
    fresh.activity.unshift({ minute: fresh.now, tool: "attach_agent", detail: `${previousConnection.name} · carried into new run`, source: "system" });
  }
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, fresh);
  selectedPartyId = null;
  selectedTableId = null;
  hoverPartyId = null;
  draggingPartyId = null;
  carryMinutes = 0;
  lastRealTick = performance.now();
  lastAnimatedActivity = null;
  recapClosedForRun = null;
  resetQueueViewport = true;
  feedback = {
    message: `New random run ${fresh.runCode} generated. Service is paused at ${minutesToTime(SERVICE_START)}${previousConnection ? `; ${previousConnection.name} remains attached.` : "."}`,
    tone: "success"
  };
}

const clock = {
  pause() {
    state.running = false;
    carryMinutes = 0;
  },
  resume() {
    if (state.now < SERVICE_END) state.running = true;
    lastRealTick = performance.now();
  },
  setSpeed(speed) {
    state.speed = [1, 2, 5].includes(speed) ? speed : 1;
    carryMinutes = 0;
    lastRealTick = performance.now();
  },
  setMinute(minute) {
    return advanceTo(state, minute);
  }
};

function showFeedback(message, tone = "error") {
  feedback = { message, tone };
}

function runHostAssignment(partyId, tableId) {
  const result = assignTable(state, partyId, tableId, { source: "host" });
  if (!result.ok) {
    showFeedback(result.error.message, "error");
  } else {
    feedback = null;
    selectedPartyId = null;
    selectedTableId = tableId;
  }
  return result;
}

function hostActionForParty(party) {
  if (party?.status === "waiting") return "seat";
  if (party?.status === "upcoming" && party.source === "reservation" && state.controllerMode !== "manual") return "plan";
  return null;
}

function runHostTableAction(partyId, tableId) {
  const party = getParty(state, partyId);
  const hostAction = hostActionForParty(party);
  if (hostAction === "seat") return runHostAssignment(partyId, tableId);
  if (hostAction !== "plan") {
    const result = { ok: false, error: { message: "This party can be assigned after it arrives." } };
    showFeedback(result.error.message);
    return result;
  }

  const result = setHostCandidateOverride(state, partyId, tableId);
  if (!result.ok) {
    showFeedback(result.error.message);
  } else {
    feedback = null;
    selectedPartyId = partyId;
    selectedTableId = null;
  }
  return result;
}

function sparklinePath(values) {
  if (!values.length) return "M 0 15 L 72 15";
  const points = values.slice(-8);
  return points.map((entry, index) => {
    const x = points.length === 1 ? 72 : index * (72 / (points.length - 1));
    const y = 28 - entry.sat * 24;
    return `${index ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

function statusLabel(table) {
  if (table.locked) return "Locked";
  if (table.status === "free") return "Open";
  if (table.status === "held") return "Held";
  if (table.status === "dirty") return "Dirty";
  return "Seated";
}

function tableSecondary(table) {
  if (table.partyId) return getParty(state, table.partyId)?.name || "Seated";
  if (table.heldForPartyId) return `For ${getParty(state, table.heldForPartyId)?.name || "party"}`;
  if (table.nextPartyId) return `Next ${getParty(state, table.nextPartyId)?.name || "party"}`;
  return `${table.seats} seats`;
}

function candidateRank(tableId, party) {
  const index = party?.candidateTableIds.indexOf(tableId) ?? -1;
  return index >= 0 ? index + 1 : null;
}

function renderTable(table, activeParty) {
  const rank = candidateRank(table.id, activeParty);
  const selected = selectedTableId === table.id;
  const expectedFinish = table.status === "seated" && table.dueAt ? minutesToTime(table.dueAt) : null;
  const dirtyMinutes = table.status === "dirty" && table.dirtyUntil
    ? Math.max(1, table.dirtyUntil - state.now)
    : null;
  const tableStatus = expectedFinish
    ? `<span class="table-status table-status--due" title="Expected finish ${escapeHtml(expectedFinish)}">${icon("clock")}<time>${escapeHtml(expectedFinish.replace(" PM", ""))}</time></span>`
    : `<span class="table-status ${dirtyMinutes != null ? "table-status--dirty" : ""}">${escapeHtml(dirtyMinutes != null ? `Dirty ${dirtyMinutes}m` : statusLabel(table))}</span>`;
  const originBadge = table.status === "seated" && table.assignmentOrigin
    ? `<span class="table-provenance is-${escapeHtml(table.assignmentOrigin.kind)}" title="${escapeHtml(`${table.assignmentOrigin.label}: ${table.assignmentReason || "Assignment recorded"}`)}">${table.assignmentOrigin.kind === "host" ? "HOST" : "AI"}</span>`
    : "";
  const classes = [
    "table-node",
    `table-node--${table.shape}`,
    `is-${table.status}`,
    table.locked ? "is-locked" : "",
    rank ? "is-candidate" : "",
    rank === 1 ? "is-first-candidate" : "",
    selected ? "is-selected" : ""
  ].filter(Boolean).join(" ");
  const timingAria = expectedFinish
    ? ` Expected finish ${expectedFinish}.`
    : dirtyMinutes != null ? ` Ready in ${dirtyMinutes} ${dirtyMinutes === 1 ? "minute" : "minutes"}.` : "";
  const provenanceAria = table.assignmentOrigin
    ? ` Assigned by ${table.assignmentOrigin.label}. ${table.assignmentReason || ""}`
    : "";
  const aria = `${table.id}, ${table.seats} seats, ${table.zone}, ${statusLabel(table)}. ${tableSecondary(table)}.${timingAria}${provenanceAria}${rank ? ` Candidate ${rank} for ${activeParty.name}.` : ""}`;

  return `
    <button
      class="${classes}"
      type="button"
      data-action="select-table"
      data-table-id="${table.id}"
      data-focus-key="table-${table.id}"
      style="--table-column:${table.layout.column};--table-row:${table.layout.row};--table-column-span:${table.layout.columnSpan};--table-row-span:${table.layout.rowSpan}"
      aria-label="${escapeHtml(aria)}"
      aria-pressed="${selected}"
    >
      ${rank ? `<span class="candidate-rank" aria-hidden="true">${rank}</span>` : ""}
      ${table.locked ? `<span class="table-lock" aria-hidden="true">${icon("lock")}</span>` : ""}
      ${originBadge}
      <span class="table-id">${table.id}</span>
      <span class="table-party">${escapeHtml(tableSecondary(table))}</span>
      ${tableStatus}
    </button>
  `;
}

function preferenceChips(party) {
  const chips = [];
  if (party.children) chips.push(`${party.children} kids`);
  if (party.needsAccessible) chips.push("accessible");
  chips.push(...party.preferences);
  if (party.isRegular) chips.push("regular");
  return chips.length
    ? chips.map((preference) => `<span class="preference-chip">${escapeHtml(PREFERENCE_LABELS[preference] || preference)}</span>`).join("")
    : '<span class="preference-chip preference-chip--quiet">No preference</span>';
}

function candidateButtons(party) {
  if (party.committedTableId) {
    return `<span class="assignment-state assignment-state--committed">${icon("check")} ${escapeHtml(party.committedTableId)}</span>`;
  }
  if (party.status === "upcoming") {
    if (state.controllerMode === "manual") return '<span class="candidate-empty">Manual · assign at arrival</span>';
    const insideHorizon = party.reservedFor <= state.now + AGENT_PLANNING_HORIZON_MINUTES;
    if (!insideHorizon) return `<span class="candidate-empty">Agent watches at T−${AGENT_PLANNING_HORIZON_MINUTES}</span>`;
    if (!party.candidateTableIds.length) return '<span class="candidate-empty">Waiting for agent…</span>';
    return party.candidateTableIds.map((tableId, index) => `
      <button
        type="button"
        class="candidate-button ${index === 0 ? "is-ranked-first" : ""} ${party.hostOverrideTableId === tableId ? "is-host-override" : ""}"
        data-action="override-candidate"
        data-party-id="${party.id}"
        data-table-id="${tableId}"
        data-focus-key="forecast-${party.id}-${tableId}"
        aria-label="Make ${tableId} the host plan for upcoming ${escapeHtml(party.name)}${index === 0 ? ", currently the tentative table" : ""}"
      >${tableId}${party.hostOverrideTableId === tableId ? '<span aria-hidden="true">HOST</span>' : index === 0 ? '<span aria-hidden="true">PLAN</span>' : ""}</button>
    `).join("");
  }
  if (party.status !== "waiting") return "";
  if (!party.candidateTableIds.length) {
    if (state.controllerMode === "external") return '<span class="candidate-empty">Waiting for agent…</span>';
    return '<span class="candidate-empty">Drag to any legal table</span>';
  }
  return party.candidateTableIds.map((tableId, index) => `
    <button
      type="button"
      class="candidate-button ${index === 0 ? "is-ranked-first" : ""}"
      data-action="assign-candidate"
      data-party-id="${party.id}"
      data-table-id="${tableId}"
      data-focus-key="candidate-${party.id}-${tableId}"
      aria-label="Assign ${escapeHtml(party.name)} to ${tableId}${index === 0 ? ", allocator first choice" : ""}"
    >${tableId}${index === 0 ? '<span aria-hidden="true">#1</span>' : ""}</button>
  `).join("");
}

function candidateStateLabel(party) {
  if (party.committedTableId) return "Committed";
  if (party.hostOverrideTableId) return "Host override";
  if (getReservationPriorityBlocker(state, party)) return "After reservation";
  if (party.candidateState === "tentative") return party.candidateFrozen ? "AI plan · locked" : "AI plan";
  return party.status === "waiting" ? "Seat now" : "Potential";
}

function partyTiming(party) {
  if (party.status === "upcoming") {
    const until = Math.max(0, party.reservedFor - state.now);
    if (party.hostOverrideTableId) return `${until ? `in ${until}m` : "due"} · host`;
    if (party.candidateFrozen) return `${until ? `in ${until}m` : "due"} · locked`;
    return until ? `in ${until}m` : "due";
  }
  const origin = party.source === "walk_in" ? party.arrivedAt : party.reservedFor;
  const waited = Math.max(0, state.now - origin);
  if (state.controllerMode === "manual") return `${waited}m wait · manual`;
  if (getReservationPriorityBlocker(state, party)) return `${waited}m wait · res first`;
  if (party.autoAssignAt == null) return `${waited}m wait`;
  return `${waited}m wait · agent ${Math.max(0, party.autoAssignAt - state.now)}m`;
}

function partyQueueMinute(party) {
  return party.source === "reservation" ? party.reservedFor : party.arrivedAt;
}

function partyQueuePriority(party) {
  if (party.status === "waiting" && party.source === "reservation") return 0;
  if (party.status === "waiting" && party.source === "walk_in") return 1;
  return 2;
}

function captureQueueViewport() {
  const rail = root.querySelector(".queue-rail");
  if (!rail) return null;
  const railTop = rail.getBoundingClientRect().top;
  const anchor = [...rail.querySelectorAll(".party-row")]
    .find((row) => row.getBoundingClientRect().bottom > railTop);
  return {
    scrollTop: rail.scrollTop,
    anchorId: anchor?.dataset.partyId || null,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - railTop : 0
  };
}

function restoreQueueViewport(viewport) {
  if (!viewport) return;
  const rail = root.querySelector(".queue-rail");
  if (!rail) return;
  rail.scrollTop = viewport.scrollTop;
  if (!viewport.anchorId) return;
  const anchor = rail.querySelector(`.party-row[data-party-id="${CSS.escape(viewport.anchorId)}"]`);
  if (!anchor) return;
  const currentOffset = anchor.getBoundingClientRect().top - rail.getBoundingClientRect().top;
  rail.scrollTop += currentOffset - viewport.anchorOffset;
}

function renderParty(party) {
  const waiting = party.status === "waiting";
  const hostAction = hostActionForParty(party);
  const actionable = Boolean(hostAction);
  const origin = party.source === "walk_in" ? party.arrivedAt : party.reservedFor;
  const waited = waiting ? Math.max(0, state.now - origin) : 0;
  const aging = waited >= 30 ? "is-overdue" : waited >= 15 ? "is-aging" : "";
  const selected = party.id === selectedPartyId;
  return `
    <article
      class="party-row party-row--${party.source === "reservation" ? "reservation" : "walk-in"} ${aging} ${selected ? "is-selected" : ""} ${actionable ? "is-draggable" : ""} ${party.hostOverrideTableId ? "has-host-override" : ""}"
      ${actionable ? 'draggable="true"' : ""}
      data-party-id="${party.id}"
      data-host-action="${hostAction || "none"}"
    >
      <div class="party-row__top">
        <button
          type="button"
          class="party-select"
          data-action="select-party"
          data-party-id="${party.id}"
          data-focus-key="party-${party.id}"
          aria-pressed="${selected}"
          aria-label="${escapeHtml(`${party.name}, party of ${party.size}. ${hostAction === "plan" ? "Select to override the agent plan." : hostAction === "seat" ? "Select to seat now." : "Assignment opens at arrival."}`)}"
          ${actionable ? "" : "disabled"}
        >
          <span class="party-time">
            <span>${minutesToTime(partyQueueMinute(party)).replace(" PM", "")}</span>
            <small class="party-source party-source--${party.source === "reservation" ? "reservation" : "walk-in"}" aria-label="${party.source === "reservation" ? "Reservation" : "Walk-in"}">${party.source === "reservation" ? "RES" : "WALK-IN"}</small>
          </span>
          <span class="party-name">${escapeHtml(party.name)}</span>
          <span class="party-size">${icon("users")} ${party.size}</span>
        </button>
        <span class="party-timing">${escapeHtml(partyTiming(party))}</span>
      </div>
      <div class="party-row__meta">
        <div class="preference-list">${preferenceChips(party)}</div>
        <div class="candidate-list" aria-label="Suggested tables" ${party.candidateReason ? `title="${escapeHtml(party.candidateReason)}"` : ""}>
          <span class="candidate-list__label">${candidateStateLabel(party)}</span>
          ${candidateButtons(party)}
        </div>
      </div>
    </article>
  `;
}

function renderQueueSection(title, parties, emptyMessage) {
  const headingId = title.toLowerCase().replaceAll(" ", "-");
  return `
    <section class="queue-section" aria-labelledby="${headingId}">
      <div class="queue-heading">
        <div>
          <h2 id="${headingId}">${title}</h2>
          <div class="queue-source-key" aria-label="Party source and service priority">
            <span class="queue-source-key__reservation"><b class="party-source party-source--reservation">RES</b> Reservation first</span>
            <span class="queue-source-key__walk-in"><b class="party-source party-source--walk-in">WALK-IN</b> Walk-in after</span>
          </div>
        </div>
        <span>${parties.length}</span>
      </div>
      <div class="queue-list">
        ${parties.length ? parties.map(renderParty).join("") : `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`}
      </div>
    </section>
  `;
}

function renderInspector(activeParty) {
  const table = selectedTableId ? getTable(state, selectedTableId) : null;
  if (table) {
    const assignedParty = table.partyId ? getParty(state, table.partyId) : null;
    return `
      <aside class="inspector" aria-label="Selected table details">
        <div>
          <strong>${table.id} · ${table.seats} seats</strong>
          <span>${escapeHtml(table.zone)} · ${escapeHtml(table.shape)}${table.highChair ? " · high chair" : ""}${table.accessible ? " · accessible" : ""}</span>
        </div>
        <div class="inspector__state">
          <span class="status-mark status-mark--${table.status}"></span>
          ${escapeHtml(statusLabel(table))}${assignedParty ? ` · ${escapeHtml(assignedParty.name)} · expected finish ${minutesToTime(table.dueAt)}` : ""}
          ${assignedParty?.assignmentOrigin ? `<small><strong>${escapeHtml(assignedParty.assignmentOrigin.label)}</strong> · ${escapeHtml(assignedParty.assignmentReason || "Assignment recorded")}</small>` : ""}
        </div>
        <div class="inspector__actions">
          <button class="control control--quiet" type="button" data-action="toggle-lock" data-table-id="${table.id}">
            ${icon(table.locked ? "unlock" : "lock")} ${table.locked ? "Unlock" : "Lock"}
          </button>
          <button class="control control--quiet" type="button" data-action="mark-table" data-table-id="${table.id}" data-status="${table.status === "dirty" ? "ready" : "dirty"}" ${table.status === "seated" ? "disabled" : ""}>
            ${table.status === "dirty" ? "Mark ready" : "Mark dirty"}
          </button>
        </div>
      </aside>
    `;
  }
  if (activeParty) {
    const hostAction = hostActionForParty(activeParty);
    const constraint = activeParty.children
      ? `${activeParty.children} ${activeParty.children === 1 ? "child" : "children"} · high chair required`
      : activeParty.needsAccessible ? "Accessible table required" : "";
    const operation = hostAction === "plan"
      ? activeParty.hostOverrideTableId
        ? `Upcoming reservation · ${activeParty.hostOverrideTableId} is the host's locked plan`
        : "Upcoming reservation · agent plan can be overridden now"
      : hostAction === "seat"
        ? "Party has arrived · assign a table now"
        : "Upcoming reservation · manual assignment opens at arrival";
    const instruction = hostAction === "plan"
      ? activeParty.hostOverrideTableId
        ? `Host override active · ${activeParty.hostOverrideTableId} is locked until arrival. Drag, tap a chip, or select another table to change it.`
        : "Override agent: drag → table, tap a table chip, or select party → table."
      : hostAction === "seat"
        ? "Seat now: drag row → table, tap a candidate, or select party → table."
        : "Manual mode waits for check-in; then drag row → table or select party → table.";
    return `
      <aside class="inspector" aria-label="Selected party details">
        <div>
          <strong>${escapeHtml(activeParty.name)} · party of ${activeParty.size}</strong>
          <span>${escapeHtml([operation, constraint].filter(Boolean).join(" · "))}</span>
        </div>
        <div class="inspector__state">${escapeHtml(instruction)}</div>
        ${activeParty.candidateReason ? `<div class="inspector__reason"><strong>Plan reason</strong><span>${escapeHtml(activeParty.candidateReason)}</span></div>` : ""}
        <button class="control control--quiet" type="button" data-action="clear-selection">Clear</button>
      </aside>
    `;
  }
  const emptyInstruction = state.controllerMode === "manual"
    ? "Manual assignment — arrived parties only. Drag row → table, or select party → table."
    : "Override — upcoming locks a plan; arrived seats now. Drag, tap a chip, or select → table.";
  return `
    <aside class="inspector inspector--empty" aria-label="Host assignment instructions">
      <span class="drag-key" aria-hidden="true">↗</span>
      <p>${escapeHtml(emptyInstruction)}</p>
    </aside>
  `;
}

function renderActivity() {
  return `
    <section class="activity-ledger" aria-labelledby="activity-title">
      <div class="queue-heading">
        <h2 id="activity-title">Tool activity</h2>
        <span>${state.activity.length}</span>
      </div>
      <ol>
        ${state.activity.slice(0, 6).map((entry) => `
          <li>
            <time>${minutesToTime(entry.minute).replace(" PM", "")}</time>
            <code>${escapeHtml(entry.tool)}</code>
            <span>${escapeHtml(entry.detail)}</span>
          </li>
        `).join("")}
      </ol>
    </section>
  `;
}

function webmcpStatusText() {
  if (webmcpStatus.supported == null) return { tone: "is-loading", text: "Checking WebMCP" };
  if (!webmcpStatus.supported) return { tone: "", text: `WebMCP: ${webmcpStatus.total} tools · unavailable` };
  const entry = webmcpStatus.entryPoint || "document";
  if (webmcpStatus.failures.length) return { tone: "is-error", text: `WebMCP: ${webmcpStatus.registered}/${webmcpStatus.total} tools · ${entry}` };
  return { tone: "is-success", text: `WebMCP: ${webmcpStatus.registered} tools · ${entry}` };
}

function renderWebMCPBadge(variant = "console") {
  const status = webmcpStatusText();
  const className = `mcp-status ${status.tone} ${variant === "strip" ? "mcp-status--strip" : ""}`.trim();
  const title = webmcpStatus.supported
    ? `Tools registered through ${webmcpStatus.entryPoint}.modelContext`
    : "No modelContext API in this browser. Open the page in a WebMCP-capable browser agent, or inspect window.__HOST_STAND_TOOLS__.";
  if (state.agentConnection && variant === "console") {
    return `<span class="mcp-status is-success"><span></span> ${escapeHtml(state.agentConnection.name)} attached</span>`;
  }
  return `<span class="${className}" title="${escapeHtml(title)}" data-webmcp-entry="${escapeHtml(webmcpStatus.entryPoint || "unavailable")}"><span></span> ${escapeHtml(status.text)}</span>`;
}

function renderAgentConnector() {
  if (!agentPanelOpen) return "";
  const connection = state.agentConnection;
  const capability = webmcpStatus.supported
    ? `${webmcpStatus.registered} tools are live in this tab.`
    : `${webmcpStatus.total} tools are ready; open this page in a WebMCP-capable browser agent.`;
  return `
    <section class="agent-connect-panel ${connection ? "is-connected" : ""}" aria-label="Connect an external AI agent">
      <div class="agent-connect-panel__copy">
        <span class="command-kicker">EXTERNAL AGENT</span>
        <strong>${connection ? `${escapeHtml(connection.name)} is attached` : "Attach through WebMCP"}</strong>
        <p>${connection ? `${escapeHtml(connection.mode)} mode · connection stays attached across new random runs.` : `${capability} No API key is needed: the WebMCP-capable browser agent supplies the model. Open this deployed page there, paste the prompt, and watch its named decisions appear on the floor.`}</p>
        <div class="controller-mode-guide" aria-label="Available operating modes">
          <span class="${state.controllerMode === "manual" ? "is-current" : ""}"><b>Manual host</b><small>The human seats every arrival</small></span>
          <span class="${state.controllerMode === "external" ? "is-current" : ""}"><b>Agent</b><small>A WebMCP browser agent plans and explains</small></span>
        </div>
      </div>
      ${connection ? `
        <button class="control agent-connect-panel__primary" type="button" data-action="disconnect-agent">Disconnect</button>
      ` : `
        <code class="agent-connect-panel__prompt">${escapeHtml(AGENT_PROMPT)}</code>
        <button class="control agent-connect-panel__primary" type="button" data-action="copy-agent-prompt">Copy agent prompt</button>
      `}
      <button class="icon-control" type="button" data-action="close-agent-panel" aria-label="Close agent connection panel">${icon("close")}</button>
    </section>
  `;
}

function renderCommandPalette() {
  const clockActionLabel = state.running ? "Pause clock" : state.now === SERVICE_START ? "Start service" : "Resume clock";
  return `
    <dialog class="command-dialog" id="command-dialog" aria-labelledby="command-title">
      <div class="command-dialog__head">
        <div>
          <span class="command-kicker">HOST COMMANDS</span>
          <h2 id="command-title">Run the service</h2>
        </div>
        <button class="icon-control" type="button" data-action="close-palette" aria-label="Close commands">${icon("close")}</button>
      </div>
      <label class="command-search">
        <span>Find an action</span>
        <input id="command-search" type="search" placeholder="Pause, jump, weights…" autocomplete="off" />
      </label>
      <div class="command-results" role="listbox" aria-label="Service commands">
        <button type="button" data-palette-action="toggle-clock" data-search="start pause resume clock"><span>${clockActionLabel}</span><kbd>Space</kbd></button>
        <button type="button" data-palette-action="next-event" data-search="jump next event"><span>Jump to next event</span><kbd>J</kbd></button>
        <button type="button" data-palette-action="busy-saturday" data-search="busy saturday turn weights"><span>Busy Saturday · 35/65</span><kbd>B</kbd></button>
        <button type="button" data-palette-action="review-hunting" data-search="review hunting satisfaction weights"><span>Review hunting · 80/20</span><kbd>R</kbd></button>
        <button type="button" data-palette-action="reset-night" data-search="reset restart night"><span>Reset the night</span><kbd>⌫</kbd></button>
      </div>
      <p class="command-help">Arrow keys move · Enter runs · Esc closes</p>
    </dialog>
  `;
}

function render() {
  if (!root || interactionHold || draggingPartyId || paletteOpen) return;
  const queueViewport = resetQueueViewport ? null : captureQueueViewport();
  resetQueueViewport = false;
  const focusedKey = document.activeElement?.dataset?.focusKey;
  const metrics = getMetrics(state);
  const activeParty = getParty(state, hoverPartyId || selectedPartyId);
  const queueParties = state.parties
    .filter((party) => (
      (party.source === "reservation" && ["upcoming", "waiting"].includes(party.status))
      || (party.source === "walk_in" && party.status === "waiting")
    ))
    .sort((left, right) => partyQueuePriority(left) - partyQueuePriority(right) || partyQueueMinute(left) - partyQueueMinute(right));
  const clockProgress = ((state.now - SERVICE_START) / (SERVICE_END - SERVICE_START)) * 100;
  const activityChips = state.activity.slice(0, 3).map((entry) => `<span><code>${escapeHtml(entry.tool)}</code> ${escapeHtml(entry.detail)}</span>`).join("");
  const clockAction = state.running ? "Pause" : state.now === SERVICE_START ? "Start" : "Resume";
  const agentAttached = state.controllerMode === "external" && state.agentConnection;
  const planLabel = agentAttached ? state.agentConnection.name : "Manual host";
  const modeLabel = agentAttached ? `Agent: ${state.agentConnection.name}` : "Manual host";
  const planText = state.controllerMode === "manual"
    ? "No agent is attached. Seat arrived parties by drag or select-then-table; the engine still enforces every hard rule."
    : state.plan;
  const hostGuidance = state.controllerMode === "manual"
    ? "Manual · arrived parties only."
    : "AI plans · accept, reject, or drag to override.";
  const reviewPresentation = agentReviewPresentation();
  const queueCount = queueParties.length;

  root.innerHTML = `
    <div class="app-shell">
      <header class="simulation-console ${simulationPanelOpen ? "is-expanded" : ""}" aria-label="Simulation control panel">
        <div class="simulation-console__main">
          <div class="simulation-console__identity">
            <span>Simulation control</span>
            <strong>Run ${escapeHtml(state.runCode)}</strong>
          </div>

          <div class="clock-console" aria-label="Service clock controls">
            <button class="icon-control clock-toggle" type="button" data-action="toggle-clock" data-focus-key="clock-toggle" aria-label="${clockAction} service clock">
              ${icon(state.running ? "pause" : "play")}
              <span>${clockAction}</span>
            </button>
            <div class="clock-readout">
              <time datetime="${minutesToTime(state.now)}">${minutesToTime(state.now)}</time>
              <span>${state.running ? `${state.speed}× · 1 sec = ${state.speed} min` : "Paused"}</span>
            </div>
            <div class="speed-switch" aria-label="Clock speed">
              ${[1, 2, 5].map((speed) => `<button type="button" class="${state.speed === speed ? "is-active" : ""}" data-action="set-speed" data-speed="${speed}" data-focus-key="speed-${speed}" aria-pressed="${state.speed === speed}">${speed}×</button>`).join("")}
            </div>
            <button class="icon-control" type="button" data-action="next-event" data-focus-key="next-event" aria-label="Jump to next event">${icon("skip")}</button>
            <span class="clock-progress" aria-hidden="true"><span style="--clock-progress:${clockProgress}%"></span></span>
          </div>

          <div class="simulation-console__status">
            <span class="agent-state-dot is-${escapeHtml(reviewPresentation.tone)}" aria-hidden="true"></span>
            <div><strong>${escapeHtml(reviewPresentation.label)}</strong><span>${escapeHtml(reviewPresentation.detail)}</span></div>
          </div>

          <div class="topbar-actions">
            <button class="mode-indicator ${agentAttached ? "is-agent" : ""}" type="button" data-action="open-agent-panel" data-focus-key="mode-indicator" aria-label="Operating mode: ${escapeHtml(modeLabel)}. Open the agent connection panel." title="${escapeHtml(modeLabel)}">
              <i aria-hidden="true"></i>
              <span>${escapeHtml(modeLabel)}</span>
            </button>
            <button class="control agent-connect-control" type="button" data-action="open-agent-panel" data-focus-key="agent-connect">${state.agentConnection ? "Agent" : "Connect AI"}</button>
            <button class="control reset-control" type="button" data-action="reset-night" data-focus-key="reset-night" title="Clear the floor and generate a different service scenario">New run</button>
            ${state.now >= SERVICE_END ? '<button class="control" type="button" data-action="open-recap" data-focus-key="open-recap">Review score</button>' : ""}
            <button class="command-trigger" type="button" data-action="open-palette" data-focus-key="command-trigger" aria-label="Open service commands">
              ${icon("command")}<kbd>⌘K</kbd>
            </button>
            <button class="icon-control simulation-console__toggle" type="button" data-action="toggle-simulation-panel" data-focus-key="simulation-toggle" aria-expanded="${simulationPanelOpen}" aria-label="${simulationPanelOpen ? "Collapse" : "Expand"} simulation details">
              ${icon("chevron")}
            </button>
          </div>
        </div>

          <div class="simulation-console__details ${simulationPanelOpen ? "" : "is-collapsed"}" aria-hidden="${!simulationPanelOpen}">
            <div class="scoreboard" aria-label="Live service metrics">
              <div><span>Sat</span><strong>${formatPercent(metrics.sat)}</strong></div>
              <svg class="score-spark" viewBox="0 0 72 32" aria-label="Recent satisfaction scores"><path d="${sparklinePath(metrics.scoreHistory)}"/></svg>
              <div><span>Covers/hr</span><strong>${metrics.coversPerHour}</strong></div>
              <div><span>Util.</span><strong>${formatPercent(metrics.utilization)}</strong></div>
              <div><span>Pref. hit</span><strong>${formatPercent(metrics.preferenceHitRate)}</strong></div>
            </div>
            <div class="weight-console">
              <div>
                <strong>Service objective</strong>
                <span>Balance table turns against party preferences.</span>
              </div>
              <label>
                <span>Sat ${Math.round(state.weights.sat * 100)}</span>
                <input type="range" min="20" max="80" step="5" value="${Math.round(state.weights.sat * 100)}" data-action="set-weights" aria-label="Satisfaction weight" />
                <span>Turn ${Math.round(state.weights.turn * 100)}</span>
              </label>
              <div class="wait-metrics">
                <span>Walk-in P50 <strong>${formatNumber(metrics.waitP50)}${metrics.waitP50 == null ? "" : " min"}</strong></span>
                <span>P90 <strong>${formatNumber(metrics.waitP90)}${metrics.waitP90 == null ? "" : " min"}</strong></span>
              </div>
            </div>
            ${renderWebMCPBadge()}
          </div>
      </header>

      ${renderAgentConnector()}

      <section class="product-bar" aria-label="Host Stand product header">
        <div class="brand-lockup">
          <span class="brand-mark" aria-hidden="true">HS</span>
          <div>
            <h1>Host Stand</h1>
            <span>The Steak House · ${RESTAURANT_CAPACITY} seats · ${TABLE_UNIT_COUNT} table units</span>
          </div>
        </div>
        <div class="agent-strip" aria-label="Current agent plan">
          <div class="agent-orbit is-${escapeHtml(reviewPresentation.tone)}" aria-hidden="true"><span></span></div>
          <div class="agent-strip__content">
            <p><strong>${escapeHtml(planLabel)}</strong> ${escapeHtml(planText)}</p>
            <div class="agent-review-meta" role="status" aria-live="polite">
              <strong>${escapeHtml(reviewPresentation.label)}</strong>
              ${reviewPresentation.meta ? `<span>${escapeHtml(reviewPresentation.meta)}</span>` : ""}
              ${renderWebMCPBadge("strip")}
            </div>
            ${renderServiceBrief()}
          </div>
          <div class="tool-chips" aria-label="Recent tool calls">${activityChips}</div>
        </div>
      </section>

      ${state.kitchenDelayUntil ? `<div class="service-alert" role="status">${icon("warning")} Kitchen delay active until ${minutesToTime(state.kitchenDelayUntil)}. Kitchen-zone satisfaction is reduced.</div>` : ""}

      <main class="service-layout">
        <aside class="queue-rail" aria-label="Upcoming parties">
          <div class="assignment-panel__head">
            <div>
              <strong>Parties</strong>
              <span>${escapeHtml(hostGuidance)}</span>
            </div>
            <span>${queueCount} active</span>
          </div>
          ${renderQueueSection("Upcoming parties", queueParties, "No reservations or walk-ins are waiting.")}
          ${renderActivity()}
        </aside>

        <section class="floor-panel" aria-labelledby="floor-title">
          <div class="floor-heading">
            <div>
              <span>North windows → south kitchen pass</span>
              <h2 id="floor-title">Table floor</h2>
            </div>
            <div class="floor-legend" aria-label="Table status legend">
              <span><i class="status-mark status-mark--free"></i> Open</span>
              <span><i class="status-mark status-mark--held"></i> Held</span>
              <span><i class="status-mark status-mark--seated"></i> Seated</span>
              <span><i class="status-mark status-mark--dirty"></i> Dirty</span>
              <span>${icon("lock")} Locked</span>
            </div>
          </div>

          <div class="floor-map" data-drop-zone="floor" aria-label="Interactive restaurant floor plan">
            <div class="zone-label zone-label--window" aria-hidden="true">WINDOW WALL</div>
            <div class="zone-label zone-label--bar" aria-hidden="true">BAR</div>
            <div class="zone-label zone-label--kitchen" aria-hidden="true">KITCHEN PASS</div>
            <div class="room-rule room-rule--north" aria-hidden="true"></div>
            <div class="room-rule room-rule--south" aria-hidden="true"></div>
            ${state.tables.map((table) => renderTable(table, activeParty)).join("")}
          </div>

          ${renderInspector(activeParty)}
        </section>
      </main>

      <footer class="foot-line">
        <p><strong>Host Stand</strong> · WebMCP challenge demo · random run ${escapeHtml(state.runCode)} · MIT licensed</p>
        <button type="button" data-action="reset-night">Start a new run</button>
      </footer>
    </div>

    ${feedback ? `
      <div class="toast toast--${feedback.tone}" role="alert">
        ${icon(feedback.tone === "error" ? "warning" : "check")}
        <span>${escapeHtml(feedback.message)}</span>
        <button class="icon-control" type="button" data-action="dismiss-feedback" aria-label="Dismiss message">${icon("close")}</button>
      </div>
    ` : ""}

    <div class="sr-only" aria-live="polite" id="service-live">${escapeHtml(feedback?.message || state.plan)}</div>
    ${renderCommandPalette()}
    ${renderServiceRecap()}
  `;
  root.setAttribute("aria-busy", "false");

  const dialog = root.querySelector("#command-dialog");
  dialog?.addEventListener("close", () => {
    paletteOpen = false;
    interactionHold = false;
    render();
  }, { once: true });

  const recapDialog = root.querySelector("#service-recap");
  recapDialog?.addEventListener("close", () => {
    recapClosedForRun = state.runCode;
  }, { once: true });
  if (recapDialog && recapClosedForRun !== state.runCode && !recapDialog.open) recapDialog.showModal();

  if (focusedKey) {
    root.querySelector(`[data-focus-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
  }
  restoreQueueViewport(queueViewport);
}

function closePalette() {
  const dialog = root.querySelector("#command-dialog");
  if (dialog?.open) dialog.close();
  paletteOpen = false;
  interactionHold = false;
}

function openPalette() {
  if (paletteOpen) return;
  const dialog = root.querySelector("#command-dialog");
  if (!dialog) return;
  paletteOpen = true;
  interactionHold = true;
  dialog.showModal();
  dialog.querySelector("input")?.focus();
}

function runPaletteAction(action) {
  if (action === "toggle-clock") state.running ? clock.pause() : clock.resume();
  if (action === "next-event") {
    advanceTo(state, getNextEventMinute(state));
    closePalette();
    renderAgentChange();
    return;
  }
  if (action === "busy-saturday") setWeights(state, 0.35, 0.65, { source: "host" });
  if (action === "review-hunting") setWeights(state, 0.8, 0.2, { source: "host" });
  if (action === "reset-night") resetNight();
  closePalette();
  render();
}

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action], [data-palette-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (target.dataset.paletteAction) {
    runPaletteAction(target.dataset.paletteAction);
    return;
  }

  if (action === "toggle-clock") state.running ? clock.pause() : clock.resume();
  if (action === "set-speed") clock.setSpeed(Number(target.dataset.speed));
  if (action === "next-event") {
    advanceTo(state, getNextEventMinute(state));
    renderAgentChange();
    return;
  }
  if (action === "reset-night") resetNight();
  if (action === "open-recap") {
    recapClosedForRun = null;
    render();
    return;
  }
  if (action === "close-recap") {
    recapClosedForRun = state.runCode;
    target.closest("dialog")?.close();
    return;
  }
  if (action === "open-agent-panel") agentPanelOpen = true;
  if (action === "close-agent-panel") agentPanelOpen = false;
  if (action === "toggle-simulation-panel") simulationPanelOpen = !simulationPanelOpen;
  if (action === "disconnect-agent") {
    detachExternalAgent(state, { source: "host" });
    feedback = null;
  }
  if (action === "copy-agent-prompt") {
    navigator.clipboard?.writeText(AGENT_PROMPT);
    feedback = { message: "Agent prompt copied. Paste it into a WebMCP-capable agent with this page open.", tone: "success" };
  }
  if (action === "dismiss-feedback") feedback = null;
  if (action === "open-palette") {
    openPalette();
    return;
  }
  if (action === "close-palette") {
    closePalette();
    render();
    return;
  }
  if (action === "clear-selection") {
    selectedPartyId = null;
    selectedTableId = null;
  }
  if (action === "select-party") {
    selectedPartyId = selectedPartyId === target.dataset.partyId ? null : target.dataset.partyId;
    selectedTableId = null;
  }
  if (action === "override-candidate") {
    runHostTableAction(target.dataset.partyId, target.dataset.tableId);
  }
  if (action === "assign-candidate") runHostAssignment(target.dataset.partyId, target.dataset.tableId);
  if (action === "select-table") {
    const tableId = target.dataset.tableId;
    if (selectedPartyId && hostActionForParty(getParty(state, selectedPartyId))) runHostTableAction(selectedPartyId, tableId);
    else selectedTableId = selectedTableId === tableId ? null : tableId;
  }
  if (action === "toggle-lock") {
    const table = getTable(state, target.dataset.tableId);
    const result = table?.locked
      ? unlockTable(state, table.id, { source: "host" })
      : lockTable(state, table.id, "Host lock", { source: "host" });
    if (result && !result.ok) showFeedback(result.error.message);
  }
  if (action === "mark-table") {
    const result = markTable(state, target.dataset.tableId, target.dataset.status, { source: "host" });
    if (!result.ok) showFeedback(result.error.message);
  }
  render();
});

root.addEventListener("change", (event) => {
  const input = event.target.closest('[data-action="set-weights"]');
  if (!input) return;
  const sat = Number(input.value) / 100;
  setWeights(state, sat, 1 - sat, { source: "host" });
  interactionHold = false;
  render();
});

root.addEventListener("input", (event) => {
  if (event.target.id !== "command-search") return;
  const query = event.target.value.trim().toLowerCase();
  for (const result of root.querySelectorAll("[data-palette-action]")) {
    result.hidden = query && !result.dataset.search.includes(query) && !result.textContent.toLowerCase().includes(query);
  }
});

root.addEventListener("pointerdown", (event) => {
  if (event.target.matches('[data-action="set-weights"]')) interactionHold = true;
});

globalThis.addEventListener("pointerup", () => {
  if (!paletteOpen && interactionHold) {
    interactionHold = false;
    render();
  }
});

root.addEventListener("dragstart", (event) => {
  const partyRow = event.target.closest(".party-row[draggable=true]");
  if (!partyRow) return;
  draggingPartyId = partyRow.dataset.partyId;
  const draggingParty = getParty(state, draggingPartyId);
  selectedPartyId = draggingPartyId;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggingPartyId);
  partyRow.classList.add("is-dragging");
  root.querySelectorAll(".table-node").forEach((node) => {
    const legality = checkAssignmentLegality(state, draggingPartyId, node.dataset.tableId, {
      forCandidate: true,
      allowUpcoming: draggingParty?.status === "upcoming",
      source: "host"
    });
    node.classList.toggle("is-valid-drop", legality.legal);
    node.classList.toggle("is-invalid-drop", !legality.legal);
  });
});

root.addEventListener("dragover", (event) => {
  const tableNode = event.target.closest(".table-node");
  if (!tableNode || !draggingPartyId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  tableNode.classList.add("is-drop-target");
});

root.addEventListener("dragleave", (event) => {
  event.target.closest(".table-node")?.classList.remove("is-drop-target");
});

root.addEventListener("drop", (event) => {
  const tableNode = event.target.closest(".table-node");
  if (!tableNode) return;
  event.preventDefault();
  const partyId = event.dataTransfer.getData("text/plain") || draggingPartyId;
  runHostTableAction(partyId, tableNode.dataset.tableId);
  draggingPartyId = null;
  render();
});

root.addEventListener("dragend", () => {
  draggingPartyId = null;
  render();
});

globalThis.addEventListener("keydown", (event) => {
  if (paletteOpen && event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closePalette();
    render();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    paletteOpen ? closePalette() : openPalette();
    return;
  }
  if (!paletteOpen && event.code === "Space" && !["INPUT", "BUTTON", "TEXTAREA"].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    state.running ? clock.pause() : clock.resume();
    render();
  }
  if (paletteOpen && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    const visible = [...root.querySelectorAll("[data-palette-action]")].filter((item) => !item.hidden);
    const currentIndex = visible.indexOf(document.activeElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    visible[(currentIndex + offset + visible.length) % visible.length]?.focus();
  }
  if (paletteOpen && event.key === "Enter" && document.activeElement?.id === "command-search") {
    const first = [...root.querySelectorAll("[data-palette-action]")].find((item) => !item.hidden);
    if (first) {
      event.preventDefault();
      runPaletteAction(first.dataset.paletteAction);
    }
  }
}, { capture: true });

function serviceTick(now) {
  const elapsed = Math.min(1000, now - lastRealTick);
  lastRealTick = now;
  if (!state.running || state.now >= SERVICE_END) return;
  carryMinutes += elapsedToSimMinutes(elapsed, state.speed);
  const wholeMinutes = Math.floor(carryMinutes);
  if (wholeMinutes >= 1) {
    carryMinutes -= wholeMinutes;
    advanceMinutes(state, wholeMinutes);
    renderAgentChange();
  }
}

setInterval(() => serviceTick(performance.now()), 100);

render();
const exposedTo = document.querySelector('meta[name="webmcp-exposed-to"]')?.content
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean) || [];
globalThis.__HOST_STAND_WEBMCP_READY__ = registerWebMCP({ state, clock, onChange: renderAgentChange }, { exposedTo });
webmcpStatus = await globalThis.__HOST_STAND_WEBMCP_READY__;
render();
