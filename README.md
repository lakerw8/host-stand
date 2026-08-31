# Host Stand

Host Stand is a one-screen restaurant service simulator built for the [OpenAI WebMCP Challenge](https://openai.com/webmcp-challenge/). A human host and a browser agent share the same floor, queues, clock, hard constraints, optimizer, and action history.

The simulated dining room has exactly **100 seats across 27 table units**.

The demo restaurant is **The Steak House**. All guests and service events are synthetic.

## Run locally

Requires Node.js 20 or newer. There are no runtime packages to install.

```bash
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). If that port is occupied:

```bash
PORT=4180 npm start
```

For a container or hosted runtime, expose the server with `HOST_STAND_HOST=0.0.0.0` and the platform-provided `PORT`.

## What to test

- The clock is paused at 5:45 PM until you press **Start**. Pause or resume it, then select 1×, 2×, or 5×. At 1×, one real second is one restaurant minute.
- Press **New run** at any point to clear the floor and generate a different paused simulation.
- Use the skip control to jump to the next arrival, auto-assignment, table turn, or service event.
- Leave **Local optimizer** on to see a rolling 45-minute plan, event-driven reassessments, a full review every 10 restaurant minutes, and automatic execution of an unchanged tentative table at arrival.
- Reservations and arrived walk-ins share one upcoming-party panel with high-contrast `RES` / `WALK-IN` badges and a visible “Reservation first” key. Waiting reservations sort ahead of waiting walk-ins; upcoming reservations remain chronological. New arrivals preserve the host's current scroll position.
- Every run generates 20–28 parties with a new roster, reservation/walk-in mix, party sizes, arrival timing, zero-to-three preferences, special needs, no-shows, and possible kitchen delays. A run code is shown in the footer for debugging.
- Turn the local optimizer off for **Manual floor**. Drag a waiting party onto a table, or select a party and then a table.
- Every generated run includes at least one high-chair and one accessibility constraint for the allocator to solve.
- Every seated party receives a visible expected finish exactly 90 restaurant minutes after seating.
- Select a table to lock/unlock it or mark it dirty/ready.
- Move the Sat ↔ Turn slider. Candidate ranking and live metrics re-solve immediately.
- Press <kbd>⌘K</kbd> or <kbd>Ctrl+K</kbd> for service commands and scoring presets.

## WebMCP

The page registers 20 imperative tools with `document.modelContext.registerTool` when WebMCP is available. Test with ChatGPT’s in-app browser or a Chrome build with WebMCP enabled. In a standard browser the app shows **preview API** and exposes the same definitions at `window.__HOST_STAND_TOOLS__` for inspection.

Read tools:

- `get_floor`
- `get_queue`
- `score_assignment`

Write tools:

- `attach_agent`
- `detach_agent`
- `set_candidates`
- `assign_table`
- `move_party`
- `unassign`
- `lock_table`
- `unlock_table` (host-only enforcement in v1)
- `hold_table`
- `release_hold`
- `quote_wait`
- `mark_table`
- `mark_party`
- `set_weights`
- `explain_plan`
- `pause_clock`
- `set_clock`

Every tool calls the same client-side engine as the human interface. The activity ledger shows the calls and the floor updates in place; the agent does not scrape or simulate clicks.

### Connecting another AI

Open **Connect AI** in the header for a ready-to-copy agent prompt. WebMCP runs inside the active browser page, so a compatible browser agent, extension, or same-origin in-page agent can discover the tools without an API key. The page must be served from HTTPS in production; `localhost` is accepted for development. The server sends `Origin-Agent-Cluster: ?1`, which keeps the document eligible for WebMCP origin isolation.

Wait for registration, discover the tools, and call them through the browser API:

```js
await window.__HOST_STAND_WEBMCP_READY__;
const tools = await document.modelContext.getTools();
const floorTool = tools.find((tool) => tool.name === "get_floor");
const serializedResult = await document.modelContext.executeTool(floorTool, JSON.stringify({}));
const toolResult = JSON.parse(serializedResult);
const floor = JSON.parse(toolResult.content[0].text);
```

Browser-integrated agents such as ChatGPT’s in-app browser require no origin configuration. For an author-provided AI in a trusted cross-origin iframe, set the comma-separated origins in `<meta name="webmcp-exposed-to">`, serve every origin over HTTPS, and add `allow="tools"` to the iframe. Do not expose tools to origins you do not trust.

WebMCP requires an open tab or webview. An AI running only on a remote server cannot call these in-page tools directly; that integration would require a separate backend MCP server.

Recommended agent loop:

1. Call `attach_agent` with a visible name and `advisory` or `autonomous` mode. This pauses the built-in optimizer so the two planners cannot conflict.
2. Call `get_floor` and `get_queue`.
3. Follow `get_queue.servicePolicy`: seat a waiting reservation before a walk-in whenever that reservation has a legal available table. `score_assignment.reservationPriority` and each walk-in’s `reservationPriorityBlockedBy` expose the live guard.
4. Use `score_assignment` and then call a write tool such as `set_candidates`, `assign_table`, or `hold_table`. Automated walk-in commits return `RESERVATION_PRIORITY` until the reservation is handled; a human host can still override by dragging.
5. Re-read `get_floor` after every write and whenever `agentReview.status` is `review_due`. The floor requests a new review after arrivals, table transitions, host overrides, kitchen changes, and the 10-minute heartbeat.

## Automated verification

```bash
npm run check
npm test
npm run verify:browser # while npm start is running on port 4180
npm run verify:webmcp # while npm start is running on port 4180
```

The Node test suite covers the paused initial clock, compression, 10-minute heartbeat, event-driven reviews, the 45-minute horizon, reservation-first commitment order, host priority overrides, reservation and walk-in commitment windows, manual mode, WebMCP upcoming-party plans, hard constraints, locks, weights, 90-minute expected finishes, and the seated → dirty → ready lifecycle.

Browser verification artifacts live in `output/playwright/`. The canonical randomized-night verifier is `verify_browser_randomized.py`; it advances until an actual waiting party appears instead of assuming a specific first event. The recorded passes exercise explicit Start, random New run, pause, 5× playback, manual drag-and-drop, external-agent attachment, scoring and assignment, expected finish data, command filtering and keyboard dismissal, all 20 tool definitions, native-style `getTools()` discovery and `executeTool()` invocation, malformed input and cancellation errors, human-agent state synchronization, console cleanliness, and responsive layouts at 320, 375, 414, and 768 CSS pixels.

## Implementation notes

- Pure HTML, CSS, and JavaScript modules; no framework or application dependencies.
- Built-in Local optimizer behavior is a deterministic scoring algorithm. It does not call an LLM. An external AI agent can explicitly take ownership with `attach_agent`, inspect and operate the same state through WebMCP, and remain attached across random New runs.
- Local and external automation share the same reservation-first commit guard. Candidate plans remain visible for walk-ins, but automation cannot assign or hold a table for one while an unassigned waiting reservation has a legal table available. Human drag-and-drop is the explicit override.
- A conservative 90-minute occupancy assumption produces deterministic expected finish times for every seated party.
- Capacity and utilization are derived from the table inventory. The expanded room totals exactly 100 seats across 27 units, including the new V6, B5, and S6 tables.
- This is a demo, not a production reservation, POS, or guest-messaging system.

## License

[MIT](./LICENSE)
