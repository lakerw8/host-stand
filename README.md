# Host Stand

Host Stand is a one-screen restaurant service simulator built for the [OpenAI WebMCP Challenge](https://openai.com/webmcp-challenge/). A human host and a browser agent share the same floor, queues, clock, hard constraints, optimizer, and action history.

The simulated dining room has exactly **120 seats across 33 table units**.

The demo restaurant is **The Steak House**. All guests and service events are synthetic.

[Open the live demo](https://host-stand-nine.vercel.app) · [View the source](https://github.com/lakerw8/host-stand)

![Host Stand with an external WebMCP agent assigning a party](./output/playwright/external-ai-assignment.png)

## Judge walkthrough

The complete narrated recording plan is in [demo-script.md](./demo-script.md). Verified browser captures show the core judging path:

- [Narrated 94-second local preview (MP4)](./output/playwright/host-stand-demo.mp4)
- [Fresh randomized 120-seat floor](./output/playwright/desktop.png)
- [Unified reservation and walk-in priority queue](./output/playwright/reservation-walkin-priority.png)
- [Manual host drag-and-drop override](./output/playwright/manual-host-override.png)
- [External WebMCP agent assignment and reason](./output/playwright/external-ai-assignment.png)
- [End-of-service scorecard and Basic algo baseline](./output/playwright/service-recap.png)

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

- The five-hour service clock is paused at 5:00 PM until you press **Start** and runs through 10:00 PM. Pause or resume it, then select 1×, 2×, or 5×. At 1×, one real second is one restaurant minute.
- Press **New run** at any point to clear the floor and generate a different paused simulation.
- Use the skip control to jump to the next arrival, auto-assignment, table turn, or service event.
- Leave **Basic algo** on to see a rolling 45-minute plan, event-driven reassessments, a full review every 10 restaurant minutes, and automatic execution of an unchanged tentative table at arrival.
- Reservations and arrived walk-ins share one upcoming-party panel with high-contrast `RES` / `WALK-IN` badges and a visible “Reservation first” key. Waiting reservations sort ahead of waiting walk-ins; upcoming reservations remain chronological. New arrivals preserve the host's current scroll position.
- Every run generates 84–96 parties with a new roster, reservation/walk-in mix, arrival timing, zero-to-three preferences, special needs, no-shows, and possible kitchen delays. Demand is weighted into a realistic 6–9 PM dinner rush and regression-tested to reach at least 80% table-seat utilization. Party sizes are normalized per run: 72% are 2- or 4-tops, 12% are 5+, and the expected mean is about three guests. A run code is shown in the footer for debugging.
- Capacity is a maximum, not an exact-size rule: a party of three may legally use a four-seat table. The agent still scores right-sized assignments more highly so it does not waste larger tables without a reason.
- With an agent on, drag an upcoming reservation to a legal table—or select the party and then the table—to replace the tentative agent plan with a locked `HOST` override. Use either gesture on an arrived party to seat it immediately.
- Turn **Basic algo** off for **Manual host**. Future reservations stay inactive until arrival; then drag the party onto a table, or select the party and then a table.
- Every generated run includes at least one high-chair and one accessibility constraint for the allocator to solve.
- Every seated party receives a visible expected finish exactly 90 restaurant minutes after seating.
- Select a table to lock/unlock it or mark it dirty/ready. After a party leaves, its table stays dirty for exactly three restaurant minutes, then returns to ready automatically.
- Move the Sat ↔ Turn slider. Candidate ranking and live metrics re-solve immediately.
- Press <kbd>⌘K</kbd> or <kbd>Ctrl+K</kbd> for service commands and scoring presets.
- Read the compact **Service brief** above the floor. Each random run contains only whole-floor seating context: one temporarily overloaded server section and one pair of reservation parties asking for nearby tables. These are soft preferences; table capacity, accessibility, high-chair requirements, locks, and reservation priority remain hard rules.
- Every planned or seated table identifies its decision owner as `HOST`, `ALG`, or `AI`; select the table or hover the label to inspect the reason. At 10:00 PM the demo opens an auditable scorecard and compares the run with Basic algo replaying the same seed and weights.

### Three operating modes

| Mode | Who decides | What the host sees |
| --- | --- | --- |
| **Manual host** | The human | No tentative plans; every arrived party waits for drag-and-drop or party-then-table selection. |
| **Basic algo** | Deterministic JavaScript scoring | Up to three tentative tables, reasons, automatic deadlines, and `ALG` provenance. No LLM or API key. |
| **External AI** | A WebMCP-capable browser agent | The named agent owns reviews and tool calls; its plans, reasons, and assignments carry `AI` provenance. |

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
4. Use `score_assignment` and then call a write tool such as `set_candidates`, `assign_table`, or `hold_table`. Publish no more than three candidates and include a concise `reason`; that explanation is visible to the host and retained in assignment provenance. Automated walk-in commits return `RESERVATION_PRIORITY` until the reservation is handled; a human host can still override by dragging.
5. Treat `serviceBrief` as soft whole-floor context. It contains only measurable table-allocation directives, while hard legality and reservation priority always win unless the human overrides.
6. Re-read `get_floor` after every write and whenever `agentReview.status` is `review_due`. The floor requests a new review after arrivals, table transitions, host overrides, kitchen changes, and the 10-minute heartbeat. Both read tools also publish `nextRecommendedActions` to make the next safe step explicit.

## Automated verification

```bash
npm run check
npm test
npm run verify:browser # while npm start is running on port 4180
npm run verify:webmcp # while npm start is running on port 4180
```

Set `HOST_STAND_URL` to test the same browser and WebMCP flows against a deployed URL.

The Node test suite covers the paused initial clock, compression, 10-minute heartbeat, event-driven reviews, the 45-minute horizon, reservation-first commitment order, host priority overrides, reservation and walk-in commitment windows, manual mode, WebMCP upcoming-party plans, hard constraints, locks, weights, service-brief scoring, decision provenance, the end-of-service recap, 90-minute expected finishes, and the seated → dirty → ready lifecycle.

Browser verification artifacts live in `output/playwright/`. The canonical randomized-night verifier is `verify_browser_randomized.py`; it advances until an actual waiting party appears instead of assuming a specific first event. The recorded passes exercise explicit Start, random New run, pause, 5× playback, agent-on host overrides through drag-and-drop and select-then-table, manual drag-and-drop, external-agent attachment, reasoned scoring and assignment, seating-only service briefs, provenance labels, the 10:00 PM scorecard and same-night baseline, expected finish data, command filtering and keyboard dismissal, all 20 tool definitions, native-style `getTools()` discovery and `executeTool()` invocation, malformed input and cancellation errors, human-agent state synchronization, console cleanliness, and responsive layouts at 320, 375, 414, and 768 CSS pixels.

## Implementation notes

- Pure HTML, CSS, and JavaScript modules; no framework or application dependencies.
- Built-in Basic algo behavior is deterministic JavaScript scoring. It does not call an LLM. An external AI agent can explicitly take ownership with `attach_agent`, inspect and operate the same state through WebMCP, and remain attached across random New runs.
- Local and external automation share the same reservation-first commit guard. Candidate plans remain visible for walk-ins, but automation cannot assign or hold a table for one while an unassigned waiting reservation has a legal table available. Human drag-and-drop or select-party-then-table is the explicit override: it locks the plan for an upcoming reservation and commits immediately for an arrived party.
- A conservative 90-minute occupancy assumption produces deterministic expected finish times for every seated party.
- Capacity and utilization are derived from the table inventory. The expanded room totals exactly 120 seats across 33 units, including a flexible six-table dining section with four 4-tops and two 2-tops.
- The end-of-service Host Stand score is a transparent demo metric—not an OpenAI judging score: 30% guest satisfaction, 20% walk-in wait control, 20% table fit and turns, 15% eligible parties served, and 15% service-brief adherence. Wait control uses the seated walk-in P90 on a linear band: 15 minutes earns full credit and 90 minutes earns zero.
- This is a demo, not a production reservation, POS, or guest-messaging system.

## License

[MIT](./LICENSE)
