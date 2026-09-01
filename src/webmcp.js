import { parseTime } from "./data.js";
import {
  advanceTo,
  attachExternalAgent,
  assignTable,
  detachExternalAgent,
  explainPlan,
  getFloorSnapshot,
  getQueueSnapshot,
  holdTable,
  lockTable,
  markParty,
  markTable,
  moveParty,
  quoteWait,
  releaseHold,
  scoreAssignment,
  setCandidates,
  setWeights,
  unassignParty,
  unlockTable
} from "./engine.js";

const objectSchema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false
});

const stringId = (description) => ({ type: "string", minLength: 1, maxLength: 64, description });

function validateValue(value, schema, path = "input") {
  if (!schema) return null;
  if (schema.oneOf) {
    const valid = schema.oneOf.some((candidate) => validateValue(value, candidate, path) == null);
    return valid ? null : `${path} must match one of the accepted formats.`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(", ")}.`;

  if (schema.type === "object") {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object.`;
    for (const required of schema.required || []) {
      if (!(required in value) || value[required] == null) return `${path}.${required} is required.`;
    }
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(value).find((key) => !(key in (schema.properties || {})));
      if (unexpected) return `${path}.${unexpected} is not supported.`;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!(key in (schema.properties || {}))) continue;
      const error = validateValue(entry, schema.properties[key], `${path}.${key}`);
      if (error) return error;
    }
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array.`;
    if (schema.minItems != null && value.length < schema.minItems) return `${path} requires at least ${schema.minItems} item(s).`;
    if (schema.maxItems != null && value.length > schema.maxItems) return `${path} accepts at most ${schema.maxItems} item(s).`;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return `${path} cannot contain duplicates.`;
    for (let index = 0; index < value.length; index += 1) {
      const error = validateValue(value[index], schema.items, `${path}[${index}]`);
      if (error) return error;
    }
  }

  if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string.`;
    if (schema.minLength != null && value.length < schema.minLength) return `${path} must contain at least ${schema.minLength} character(s).`;
    if (schema.maxLength != null && value.length > schema.maxLength) return `${path} must contain at most ${schema.maxLength} character(s).`;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a finite number.`;
    if (schema.type === "integer" && !Number.isInteger(value)) return `${path} must be an integer.`;
    if (schema.minimum != null && value < schema.minimum) return `${path} must be at least ${schema.minimum}.`;
    if (schema.maximum != null && value > schema.maximum) return `${path} must be at most ${schema.maximum}.`;
  }
  if (schema.type === "boolean" && typeof value !== "boolean") return `${path} must be a boolean.`;
  return null;
}

export function validateToolInput(schema, input) {
  const message = validateValue(input, schema);
  return message ? { ok: false, message } : { ok: true };
}

export async function executeToolDefinition(definition, input = {}, options = {}) {
  if (options.signal?.aborted) return { ok: false, error: { code: "ABORTED", message: "The tool call was cancelled." } };
  const validation = validateToolInput(definition.inputSchema, input);
  if (!validation.ok) return { ok: false, error: { code: "INVALID_INPUT", message: validation.message } };
  try {
    return await definition.execute(input, options);
  } catch (error) {
    return { ok: false, error: { code: "TOOL_FAILED", message: error instanceof Error ? error.message : String(error) } };
  }
}

function asToolResult(value) {
  const failed = value?.ok === false;
  return {
    ...(failed ? { isError: true } : {}),
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function createToolDefinitions({ state, clock, onChange }) {
  const mutate = (operation) => {
    const result = operation();
    onChange?.();
    return result;
  };

  const definitions = [
    {
      name: "attach_agent",
      description: "Attach this browser agent to the Host Stand floor and take planning ownership from the built-in deterministic optimizer. Call this before publishing candidates or assignments.",
      inputSchema: objectSchema(
        {
          agent_name: { type: "string", minLength: 1, maxLength: 64, description: "Visible name for the connected AI agent." },
          mode: { type: "string", enum: ["advisory", "autonomous"], description: "Advisory posts plans only; autonomous may use candidate auto-assignment deadlines." }
        },
        ["agent_name"]
      ),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ agent_name, mode = "autonomous" }) => mutate(() => attachExternalAgent(state, agent_name, mode))
    },
    {
      name: "detach_agent",
      description: "Release external-agent ownership and return the restaurant floor to manual host control without resetting the current simulation.",
      inputSchema: objectSchema(),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: () => mutate(() => detachExternalAgent(state, { source: "agent" }))
    },
    {
      name: "get_floor",
      description: "Read the current restaurant floor, service clock, table states, locks, holds, 90-minute expected finish times, measurable service brief, assignment provenance, next recommended actions, weights, and live metrics. At 10 PM this also includes the final service recap. Use this after every write instead of scraping the floor UI.",
      inputSchema: objectSchema(),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => getFloorSnapshot(state)
    },
    {
      name: "get_queue",
      description: "Read the seating brief plus upcoming reservations and waiting walk-ins with party size, preferences, tentative or committed tables, plan reasons, host overrides, planning-horizon state, auto-assignment deadlines, recommended next actions, and the reservation-first service policy. A waiting walk-in includes reservationPriorityBlockedBy when it must wait behind a reservation.",
      inputSchema: objectSchema(),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => getQueueSnapshot(state)
    },
    {
      name: "score_assignment",
      description: "Score one party-table pairing without changing the floor. Returns legality, satisfaction, turn efficiency, availability delay, reservation-priority status, and plain-language reasons. A walk-in plan may score as legal while its commitment remains blocked until available reservations are seated.",
      inputSchema: objectSchema(
        {
          party_id: stringId("Party id from get_queue."),
          table_id: stringId("Table id from get_floor.")
        },
        ["party_id", "table_id"]
      ),
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: ({ party_id, table_id }) => scoreAssignment(state, party_id, table_id, { forCandidate: true, allowUpcoming: true })
    },
    {
      name: "set_candidates",
      description: "Post one to three ranked legal candidate tables plus a concise whole-floor reason for an upcoming reservation or waiting party. Plan waiting reservations before walk-ins. The first table is tentative and becomes the autonomous assignment at arrival or after the five-minute host-override window, but walk-in commitment pauses while a waiting reservation has a legal available table. A host override is a hard constraint.",
      inputSchema: objectSchema(
        {
          party_id: stringId("Upcoming reservation or waiting party id."),
          table_ids: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "string" }, description: "Ranked table ids, best first." },
          reason: { type: "string", minLength: 2, maxLength: 180, description: "Concise reason that references fit, timing, reservation priority, or a service-brief tradeoff." },
          auto_assign_at: { oneOf: [{ type: "number" }, { type: "string" }], description: "Restaurant minute or clock time such as 6:25 PM. Waiting parties default to now + 5 minutes; upcoming reservations execute when they arrive." }
        },
        ["party_id", "table_ids"]
      ),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ party_id, table_ids, reason, auto_assign_at }) => mutate(() => {
        const parsed = auto_assign_at == null ? null : parseTime(auto_assign_at);
        if (auto_assign_at != null && parsed == null) return { ok: false, error: { code: "INVALID_TIME", message: "Use a restaurant minute or a time such as 6:25 PM." } };
        return setCandidates(state, party_id, table_ids, parsed, { source: "agent", reason });
      })
    },
    {
      name: "assign_table",
      description: "Commit a legal table to a waiting party and provide a concise visible reason. Always assign any waiting reservation with a legal available table before assigning a walk-in; automated walk-in attempts return RESERVATION_PRIORITY until that reservation is handled. Seats immediately when free; otherwise reserves the table as that party's next seating. Re-read get_floor after calling.",
      inputSchema: objectSchema(
        {
          party_id: stringId("Waiting party id."),
          table_id: stringId("Destination table id."),
          reason: { type: "string", minLength: 2, maxLength: 180, description: "Why this assignment is best for the whole floor right now." }
        },
        ["party_id", "table_id"]
      ),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ party_id, table_id, reason }) => mutate(() => assignTable(state, party_id, table_id, { source: "agent", reason }))
    },
    {
      name: "move_party",
      description: "Move a currently seated party to another free legal table. The previous table becomes dirty.",
      inputSchema: objectSchema(
        { party_id: stringId("Seated party id."), table_id: stringId("New free table id.") },
        ["party_id", "table_id"]
      ),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ party_id, table_id }) => mutate(() => moveParty(state, party_id, table_id, { source: "agent" }))
    },
    {
      name: "unassign",
      description: "Return a committed or seated party to the waitlist. A vacated seated table becomes dirty.",
      inputSchema: objectSchema({ party_id: stringId("Party id.") }, ["party_id"]),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ party_id }) => mutate(() => unassignParty(state, party_id, { source: "agent" }))
    },
    {
      name: "lock_table",
      description: "Place a hard lock on a table so the planner cannot propose or assign it. Include the operational reason; only the human host can remove the lock in v1.",
      inputSchema: objectSchema(
        { table_id: stringId("Table id."), reason: { type: "string", minLength: 2, maxLength: 160, description: "Why the table must stay untouched." } },
        ["table_id", "reason"]
      ),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ table_id, reason }) => mutate(() => lockTable(state, table_id, reason, { source: "agent" }))
    },
    {
      name: "unlock_table",
      description: "Request removal of a host lock. In v1 this is host-only and agent calls return a HOST_ONLY error; the host can unlock from the table inspector.",
      inputSchema: objectSchema({ table_id: stringId("Table id.") }, ["table_id"]),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ table_id }) => mutate(() => unlockTable(state, table_id, { source: "agent" }))
    },
    {
      name: "hold_table",
      description: "Hold a table for a named reservation until a restaurant clock time. If occupied, records that party as next for the table.",
      inputSchema: objectSchema(
        {
          table_id: stringId("Table id."),
          party_id: stringId("Reservation or waiting party id."),
          until: { oneOf: [{ type: "number" }, { type: "string" }], description: "Restaurant minute or clock time such as 7:00 PM." }
        },
        ["table_id", "party_id", "until"]
      ),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ table_id, party_id, until }) => mutate(() => {
        const parsed = parseTime(until);
        if (parsed == null) return { ok: false, error: { code: "INVALID_TIME", message: "Use a restaurant minute or a time such as 7:00 PM." } };
        return holdTable(state, table_id, party_id, parsed, { source: "agent" });
      })
    },
    {
      name: "release_hold",
      description: "Release a table hold or next-party commitment, for example after a no-show.",
      inputSchema: objectSchema({ table_id: stringId("Table id.") }, ["table_id"]),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ table_id }) => mutate(() => releaseHold(state, table_id, { source: "agent" }))
    },
    {
      name: "quote_wait",
      description: "Record an honest quoted wait for a waiting party. Quote overrun affects satisfaction scoring.",
      inputSchema: objectSchema(
        { party_id: stringId("Waiting party id."), minutes: { type: "integer", minimum: 0, maximum: 180 } },
        ["party_id", "minutes"]
      ),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ party_id, minutes }) => mutate(() => quoteWait(state, party_id, minutes, { source: "agent" }))
    },
    {
      name: "mark_table",
      description: "Mark a table dirty or ready. Seated is accepted only when a party is already attached.",
      inputSchema: objectSchema(
        { table_id: stringId("Table id."), status: { type: "string", enum: ["dirty", "ready", "seated"] } },
        ["table_id", "status"]
      ),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ table_id, status }) => mutate(() => markTable(state, table_id, status, { source: "agent" }))
    },
    {
      name: "mark_party",
      description: "Mark a party arrived, no-show, or left. Arrived puts an upcoming reservation onto the active queue.",
      inputSchema: objectSchema(
        { party_id: stringId("Party id."), status: { type: "string", enum: ["arrived", "no_show", "left"] } },
        ["party_id", "status"]
      ),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ party_id, status }) => mutate(() => markParty(state, party_id, status, { source: "agent" }))
    },
    {
      name: "set_weights",
      description: "Set satisfaction and table-turn weights. They must be non-negative and total 1.0; use 0.6/0.4 for default, 0.35/0.65 for a busy Saturday, or 0.8/0.2 for review hunting.",
      inputSchema: objectSchema(
        { sat: { type: "number", minimum: 0, maximum: 1 }, turn: { type: "number", minimum: 0, maximum: 1 } },
        ["sat", "turn"]
      ),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ sat, turn }) => mutate(() => setWeights(state, sat, turn, { source: "agent" }))
    },
    {
      name: "explain_plan",
      description: "Publish one to three concise plan bullets to the visible agent strip so the host can see the current tradeoffs.",
      inputSchema: objectSchema(
        { bullets: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", minLength: 2, maxLength: 160 } } },
        ["bullets"]
      ),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ bullets }) => mutate(() => explainPlan(state, bullets, { source: "agent" }))
    },
    {
      name: "pause_clock",
      description: "Pause or resume the compressed service clock without changing its current restaurant time.",
      inputSchema: objectSchema({ paused: { type: "boolean", default: true } }),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ paused = true } = {}) => mutate(() => {
        paused ? clock.pause() : clock.resume();
        return { ok: true, paused: !state.running, clock: state.now };
      })
    },
    {
      name: "set_clock",
      description: "Move the demo clock forward and optionally set playback to 1x, 2x, or 5x. One real second equals one restaurant minute at 1x.",
      inputSchema: objectSchema({
        time: { oneOf: [{ type: "number" }, { type: "string" }], description: "Forward restaurant minute or clock time such as 6:41 PM." },
        speed: { type: "number", enum: [1, 2, 5] },
        running: { type: "boolean" }
      }),
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: ({ time, speed, running } = {}) => mutate(() => {
        if (time != null) {
          const parsed = parseTime(time);
          if (parsed == null) return { ok: false, error: { code: "INVALID_TIME", message: "Use a restaurant minute or a time such as 6:41 PM." } };
          const result = advanceTo(state, parsed);
          if (!result.ok) return result;
        }
        if (speed != null) {
          if (![1, 2, 5].includes(Number(speed))) return { ok: false, error: { code: "INVALID_SPEED", message: "Speed must be 1, 2, or 5." } };
          clock.setSpeed(Number(speed));
        }
        if (running === true) clock.resume();
        if (running === false) clock.pause();
        return { ok: true, clock: state.now, speed: state.speed, running: state.running };
      })
    }
  ];

  return definitions.map((definition) => ({
    title: definition.name.split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    ...definition
  }));
}

function normalizeExposedOrigins(origins = []) {
  return [...new Set(origins.map((origin) => {
    try {
      const parsed = new URL(origin);
      return parsed.protocol === "https:" ? parsed.origin : null;
    } catch {
      return null;
    }
  }).filter(Boolean))];
}

export async function registerWebMCP(context, options = {}) {
  const definitions = createToolDefinitions(context);
  const exposedTo = normalizeExposedOrigins(options.exposedTo);
  globalThis.__HOST_STAND_TOOLS__ = definitions;
  globalThis.hostStandInvokeTool = async (name, input = {}) => {
    const tool = definitions.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown Host Stand tool: ${name}`);
    return executeToolDefinition(tool, input);
  };

  if (!globalThis.document?.modelContext?.registerTool) {
    const status = { supported: false, registered: 0, total: definitions.length, failures: [], exposedTo };
    globalThis.__HOST_STAND_WEBMCP_STATUS__ = status;
    return status;
  }

  const failures = [];
  let registered = 0;
  for (const definition of definitions) {
    try {
      const registeredDefinition = {
        ...definition,
        execute: async (input, options) => {
          return asToolResult(await executeToolDefinition(definition, input || {}, options));
        }
      };
      await document.modelContext.registerTool(registeredDefinition, exposedTo.length ? { exposedTo } : undefined);
      registered += 1;
    } catch (error) {
      failures.push({ name: definition.name, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const status = { supported: true, registered, total: definitions.length, failures, exposedTo };
  globalThis.__HOST_STAND_WEBMCP_STATUS__ = status;
  return status;
}
