# Host Stand — PRD

**Status:** testable MVP implemented; continue iterating from host feedback.  
**Challenge:** OpenAI WebMCP Challenge. Demo must run in ChatGPT’s in-app browser or Chrome with WebMCP enabled.  
**One liner:** A host stand where an agent posts a short set of fitting tables for every party, and if the host does nothing, the agent commits one of them.

**Project name:** Host Stand (locked).

**Restaurant name:** The Steak House (locked). Fancy 120-seat room with a window wall. Not the submission title.

---

## 1. Why this exists

A host is making on-the-spot calls all night: this 6-top wants the view, a regular is walking in, the 7:00 eight-top is not here yet, table 14 just went dirty, the kitchen-side four is the only open four. The job is not a calendar. It is a live assignment problem with hard constraints, soft preferences, and undeterministic arrivals and dwell.

The product is the floor. For every waiting party the agent posts **candidate tables** (e.g. V3, V4, S1). The host can tap one. If the host does nothing, the agent **automatically assigns** from that set (the top-ranked candidate). ChatGPT (or another browser agent) calls tools on that floor. If the agent cannot drive the board, this is the wrong project.

Out of scope for the demo: real POS, real reservations vendor, payments, staff login, multi-location, SMS to guests.

---

## 2. Demo contract

This is a **demo restaurant**, not a production host tool.

- All guests are fake and named.
- A **service clock** runs from 5:00pm to 10:00pm. Real time is compressed (default: 1 second = 1 restaurant minute). The host can pause, play, and jump.
- The agent maintains a rolling 45-minute plan with up to three legal, ranked candidate tables. Reservations execute their stable plan when they arrive; newly discovered walk-ins receive a five-minute override window. When a waiting reservation has a legal available table, automation must seat it before any walk-in. The human host can explicitly override by tapping or dragging.
- Every random run supplies two seating-relevant whole-floor directives: one temporarily overloaded server section and one pair of reservation parties that prefer nearby tables. They influence ranking and the recap, but never relax hard constraints or reservation priority.
- Every tentative and committed decision preserves a visible owner and reason: `HOST` for a manual override, `ALG` for the built-in deterministic baseline, or `AI` for an attached WebMCP agent.
- On-screen scores tick so a 3-minute video can show the tradeoff working, not a static floor.

Success for the hackathon: a judge opens the live URL, sees the agent seat a walk-in, sees a host override, sees the plan reflow, and can tell what WebMCP tools fired.

---

## 3. Users

**Host (human).** Optional override. Taps one of the candidate chips, or drags onto a table. Locks a table the agent must not touch. Marks no-show / dirty / ready. If they do nothing, the agent’s pick stands.

**Agent (WebMCP).** Produces candidate sets for waiting parties and reservations inside the planning horizon, reviews every 10 restaurant minutes and after floor events, then commits from the stable set at arrival/deadline unless the host already picked. Reads floor + waitlist + clock + service brief, scores, `set_candidates` with a reason, then `assign_table` / `hold_table`. Does not scrape buttons or freeze the night waiting for approval.

They share one page. The agent is not a sidebar that prints table numbers as text.

---

## 4. The restaurant: The Steak House

The Steak House. One room, top-down, exactly 120 seats across 33 assignable units. North wall is windows (view). South wall is the kitchen pass. West is the bar counter. East has two private rooms.

### 4.1 Table inventory

Every table has: `id`, `seats` (hard max), `min_seats` (soft: wasting a big table), `shape`, `zone`, flags, `status`.

| ID | Seats | Shape | Zone | Quiet | Near kitchen | High chair | Notes |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| V1 | 2 | square | view | n | n | y | window 2-top |
| V2 | 2 | square | view | n | n | y | |
| V3 | 4 | square | view | n | n | y | |
| V4 | 4 | square | view | n | n | y | |
| V5 | 6 | round | view | n | n | y | window round |
| V6 | 4 | square | view | n | n | y | window 4-top |
| D1 | 4 | square | interior | n | n | y | north dining row |
| D2 | 2 | square | interior | n | n | y | flexible 2-top |
| D3 | 2 | square | interior | n | n | y | accessible flexible 2-top |
| D4 | 4 | square | interior | n | n | y | north dining row |
| D5 | 4 | square | interior | n | n | y | east dining row |
| D6 | 4 | square | interior | n | n | y | east dining row |
| B1 | 4 | booth | interior | y | n | y | |
| B2 | 4 | booth | interior | y | n | y | |
| B3 | 4 | booth | interior | y | n | n | tight booth, no high chair |
| B4 | 2 | booth | interior | y | n | n | |
| B5 | 4 | booth | interior | y | n | y | south booth |
| R1 | 6 | round | interior | n | n | y | center |
| R2 | 8 | round | interior | n | n | y | center large |
| S1 | 4 | square | interior | n | n | y | |
| S2 | 4 | square | interior | n | n | y | |
| S3 | 4 | square | kitchen | n | y | y | noisy, fast turn |
| S4 | 2 | square | kitchen | n | y | y | |
| S5 | 2 | square | kitchen | n | y | n | |
| S6 | 4 | square | kitchen | n | y | y | accessible south extension |
| C1–C6 | 2 | counter | counter | n | n | n | six bar seats, pairable as 1–2. Treat as six 1–2 units; agent may seat a 2 across two adjacent stools |
| P1 | 8 | private | private | y | n | y | door, must not burn on a 2-top |
| P2 | 6 | private | private | y | n | y | |

**Status machine:** `free` → `held` (for a named reservation) → `seated` → `dirty` → `free`. Host or agent can set these via tools. Agent cannot seat `dirty`, `held` (unless the hold is that party), or `locked`.

**Lock:** host-only hard constraint. Agent may propose “unlock V3?” but cannot unlock.

### 4.2 Hard constraints (never break)

1. Party size ≤ table seats. This is a maximum, so a party of 3 may legally use a 4-top; right-sizing affects the score but not legality. Counter: a party of 3+ cannot sit at the bar unless host overrides.
2. Do not seat on `dirty`, `seated`, or someone else’s `held`.
3. Do not seat on a host-`locked` table.
4. Private rooms: party size ≥ 5, unless host overrides.
5. **Children → high chair (hard).** `children >= 1` implies a high chair. Candidate set and commit may only include tables with `high_chair: y`. Counter stools are never legal. Tight booths B3/B4 and kitchen 2-top S5 are also `n`. Host drag onto a no-high-chair table **fails** for a kids party (same as size). Not a preference.
6. Accessible required → table.accessible (mark V3, S1, P1, C1 as accessible in the demo data).

### 4.3 Soft objectives (the optimizer)

Maximize, every re-solve:

**Customer satisfaction (weight default 0.6)**

- Wait: `wait_score = max(0, 1 - wait_min / 40)` for walk-ins; for reservations, penalty starts at 5 minutes past reserved time.
- Preferences: `pref_score = matched / requested` if the party stated any; 1.0 if they stated none.
- Quote honesty: if we quoted 15 and they wait 28, extra penalty.

**Table turn / revenue (weight default 0.4)**

- Do not put a 2-top on an 8 (size waste).
- Kitchen-adjacent tables should turn faster (shorter dwell draw) and are the right dump for parties with no view/quiet pref.
- Empty private rooms during a 6:30 crush while a 5-top waits is a miss unless a hold is live.
- Utilization: seated_seats / 120, sampled each tick.

Host slider: **Sat ↔ Turn**. Moving it changes agent behavior live. That slider is a WebMCP tool too (`set_weights`).

Default weights: sat 0.6 / turn 0.4. “Busy Saturday” preset: 0.35 / 0.65. “Review hunting” preset: 0.8 / 0.2.

---

## 5. Parties

One compact operational queue on the **left rail**, beside the table floor. Reservations and arrived walk-ins share the same section and object type, distinguished by `source: reservation | walk_in`. Waiting reservations appear first, then waiting walk-ins, then upcoming reservations; each priority band stays chronological.

### 5.1 Fields

- `name`, `size`, `source`
- `reserved_for` (reservations) or `arrived_at` (walk-ins)
- `preferences[]` — open set, demo uses: `view`, `quiet`, `away_kitchen`, `counter`, `booth`, `private`, `round`, `together` (never split)
- `children` (count; 0 default). If `children >= 1`, high chair is required. Size includes kids.
- `needs_accessible`, `is_regular`
- `quoted_wait_min` (nullable; set when the committed table is not free yet)
- `status`: upcoming | waiting | seated | no_show | left
- `candidate_table_ids[]` (up to three legal tables, ranked; tentative for upcoming reservations inside the 45-minute planning horizon and required while waiting when a legal option exists)
- `candidate_state`: unplanned | tentative | host_override | committed
- `candidate_updated_at`, `candidate_frozen`, `host_override_table_id`
- `auto_assign_at` (sim clock; reservations execute their stable plan on arrival; newly discovered walk-ins default to now + 5 min)
- `committed_table_id` (null until host taps or idle window fires)
- `service_priority`: `reservation_first | after_waiting_reservations`; walk-ins also expose `reservation_priority_blocked_by` while the automated commit guard is active

### 5.2 Random service generator

Clock starts **5:00pm** and each new run creates a different service scenario. The run code makes any generated night reproducible for debugging without making the demo deterministic.

- Generate 84–96 named parties with a randomized reservation/walk-in mix, service timing, lateness, no-shows, regulars, children, and accessibility needs. Weight arrivals into a 6–9pm dinner rush and require generated scenarios to reach at least 80% table-seat utilization. Normalize party sizes within each run to a real-service target: 1 (6%), 2 (48%), 3 (10%), 4 (24%), 5 (4%), 6 (5%), and 8 (3%). This keeps 72% of parties at 2 or 4 seats, with an occasional 12% at 5+.
- Every party receives zero to three unique random preferences. Each generated night covers the full zero-through-three range.
- Every run includes at least one high-chair constraint and one accessibility constraint so the allocator must solve hard cases.
- Walk-ins arrive throughout service with noisy peaks; reservations may arrive on time, late, or no-show.
- Possible kitchen-delay events force replanning.
- **New run** clears the floor, returns the clock to a paused 5:00pm, and generates a new seed.

---

## 6. Clock and undeterministic factors

The clock is the product. Without it, this is a static puzzle.

**Tick.** Default 1s real = 1 min sim. Pause / resume / 1x / 2x / 5x / jump to next event.

**Dwell.** The MVP uses a conservative, visible **90-minute expected finish** for every seated party. This keeps the planning horizon understandable while the agent still reacts to arrivals, table turnover, locks, holds, and service disruptions. Variable dwell can be introduced as later complexity.

**Noise the agent must re-solve on:**

- Walk-in arrivals are noisy, with a different distribution each run.
- Reservation late: 0 / 10 / 20 min, or no-show after 20.
- Party size +1 at check-in (10%).
- A possible kitchen-delay window changes kitchen-zone desirability.
- A table becomes dirty as soon as its party leaves. The dirty state lasts exactly 3 restaurant minutes, then the table becomes free automatically.

**Events that force a re-solve:** new walk-in, reservation check-in, table → dirty, table → free, host lock/unlock/drag, no-show, slider move, kitchen-delay flag.

---

## 7. Assignment loop

The agent maintains a rolling plan. It performs a full-floor review every **10 restaurant minutes** and immediately after any floor-changing event. It plans upcoming reservations inside a **45-minute horizon**, freezes stable reservation plans at **T−5**, and auto-commits when the host does not override.

1. Read floor, queues, locks, holds, weights, clock, any host taps still pending.
2. For each waiting party and in-horizon reservation in priority order (waiting reservation > waiting walk-in > upcoming reservation; then late/regular/quoted-wait aging/arrival order inside each class):
   - Score every legal table: `0.6 * sat(party, table, wait) + 0.4 * turn(party, table)` using current weights.
   - Skip host-locked tables and tables already committed to a higher-priority party.
   - If `children >= 1`, drop every table with `high_chair: n` before ranking. Do not list them as candidates.
   - Keep up to three legal tables as `candidate_table_ids` (always at least one if any legal table exists).
   - `set_candidates` so the rail shows e.g. “V3 · V4 · S1” with #1 marked.
   - Preserve the previous #1 candidate when it remains legal and a new option does not improve the plan materially. Inside T−5, keep it fixed unless it becomes impractical or illegal.
   - Known reservations execute the stable #1 table when they actually arrive. A walk-in discovered at arrival gets a five-minute host-override window.
3. With an agent active, if the host taps a candidate, selects the party and then a table, or **drags an upcoming reservation onto a legal table**, promote it to a hard host plan. The same gestures on an arrived party commit immediately. In Manual floor, future reservations remain inactive until arrival. Host decisions always beat agent ranking.
4. If the host **does nothing** until arrival/deadline → commit the #1 candidate. Before an automated walk-in commit or hold, check for an unassigned waiting reservation with any legal available table. If one exists, keep the walk-in plan visible and return `RESERVATION_PRIORITY` until the reservation is handled. No popup. No pause.
5. Publish `explain_plan` (candidate sets + last commits).

An in-horizon party never sits on the rail with no tables listed when a legal option exists. Far-future reservations clearly show that planning begins at T−45. A waiting party never waits forever for a host tap.

The Walsh-vs-Okonkwo moment: Okonkwo’s candidates include P1 (and maybe R2). Walsh’s candidates are R2 (and P1 if still legal). Agent ranks P1 #1 for Okonkwo, R2 #1 for Walsh. If the host does nothing, those commit. If the host taps P1 on Walsh’s row, Walsh gets P1 and Okonkwo’s set reflows onto R2.

---

## 8. UI

One screen. No settings maze.

**Center / left — floor.** Top-down The Steak House. Tables drawn as their shapes. Color: free (open), held (stripe), seated (filled + remaining band), dirty (hash), locked (padlock). Hover: seats, zone, prefs that match. Candidate tables pulse on the floor while a party is highlighted. With an agent active, drag an upcoming reservation onto a table or select the party and then the table to lock a host plan; use the same gestures on a waiting party to commit immediately. Manual mode enables those controls at arrival. The rail and inspector state the result before the host acts and show `HOST` after an override.

**Left rail — Upcoming parties.** Reservations and arrived walk-ins appear together in one priority-ordered list. A dark `RES` badge, cobalt `WALK-IN` badge, and compact `Reservation first / Walk-in after` key make the source and policy readable without separate panels. Each row shows time, name, size, preference chips, **candidate tables** as tappable chips, and planning/wait state. Aging waiting rows go amber at 15 minutes and red at 30. The rail preserves its visible-party anchor when events add or update rows, so live service never snaps the host back to the top.

**Simulation control panel.** A compact, product-external strip above Host Stand contains the sim clock, pause/play, 1x/2x/5x, next event, mode, AI connection, and new-run controls. Expanded details contain Sat score, covers/hour, utilization, preference hit rate, and the Sat ↔ Turn weight slider.

**Agent strip** (under the top bar, not a chat dump). Current plan in one line plus “why” on the last commit. Tool names can show as quiet chips (`assign_table V3 ← Diaz`) so judges see WebMCP fire.

**Empty states.** From 5:00 to the first 5:15 seating the floor is mostly free and tentative holds begin to light. After 9:30 walk-ins taper off; at 10:00 the scoreboard freezes for the recap.

---

## 9. WebMCP tools

This list **is** the product. Register on the page with `document.modelContext.registerTool`. Unregister nothing during service; annotations: writes are not read-only.

| Tool | What it does | Why a human/agent needs it |
| --- | --- | --- |
| `get_floor` | Snapshot: tables, status, locks, remaining dwell band | Agent must not scrape SVG |
| `get_queue` | Reservations + walk-ins with prefs and waits | Same |
| `score_assignment` | `{party_id, table_id}` → sat, turn, legal?, why | Lets agent compare without seating |
| `attach_agent` / `detach_agent` | Explicitly transfer planning ownership to/from an external AI | Prevents the built-in optimizer and external planner from conflicting |
| `set_candidates` | `{party_id, table_ids[], auto_assign_at}` | Rail + floor show table x, y, z |
| `assign_table` | Commit one table (seat now if free); fails hard constraints | Auto-fires from the candidate set if host is idle |
| `move_party` | Change table after seated (host or agent) | Mistakes, +1 guest |
| `unassign` | Send back to waitlist | |
| `lock_table` / `unlock_table` | Host hard constraint | Agent can lock only if we allow a `lock` from agent with `reason`; **v1: host-only unlock** |
| `hold_table` | `{table_id, party_id, until}` | Birthday 8-top |
| `release_hold` | | No-show / host kill |
| `quote_wait` | `{party_id, minutes}` | Honest quote |
| `mark_table` | dirty / ready / seated | Busser + demo clock |
| `mark_party` | no_show / left / arrived | |
| `set_weights` | sat/turn slider | Demo the tradeoff |
| `explain_plan` | Write the 3-bullet plan to the strip | Judges read it |
| `pause_clock` / `set_clock` | Demo control | Video |

Read tools: `get_floor`, `get_queue`, `score_assignment`.  
Write tools: everything else.

Agent policy for the demo (scripted enough to film, noisy enough to be real):

- Maintain up to three ranked candidates for waiting parties and reservations inside the 45-minute planning horizon (`set_candidates`). One is fine when only one table is legal.
- Seat an unassigned waiting reservation before any walk-in whenever the reservation has a legal available table. `get_queue.servicePolicy`, `reservationPriorityBlockedBy`, and `score_assignment.reservationPriority` expose this rule. Only a human host action may override it.
- Reassess immediately after meaningful floor events and run a full review every 10 restaurant minutes.
- Tentative plans freeze at T−5 unless they become infeasible. A host-selected candidate is a hard override until the host changes it.
- Reservations commit when they arrive. Walk-ins without an existing plan receive a five-minute override window; host tap or drag commits immediately.
- Seat now if the committed table is free. Keep the plan visible if the table is still turning over.
- Re-call `get_floor` after every write. Do not keep stale state.
- **Cut:** `offer_choice`. The agent does not freeze waiting for a yes. Host inaction is a yes on #1.

---

## 10. Scoring, visible

Not a forecast. Live, labeled.

- **Sat:** average of seated parties’ `0.5 wait_score + 0.5 pref_score`, updated as they sit. Show last 5 as a sparkline.
- **Turn:** covers seated in the last 60 sim minutes; utilization %.
- **Preference hit rate:** % of requested chips matched at seating.
- **Wait P50 / P90** for walk-ins.

At 10:00 PM, freeze an explicitly unofficial **Host Stand service score** from five labeled components: 30% guest satisfaction, 20% walk-in wait control, 20% table fit and turns, 15% eligible parties served, and 15% service-brief adherence. Show assignment counts and covers by `HOST` / `ALG` / named external `AI`, the measured result of each service-brief directive, and a comparison with the local algorithm replaying the same random seed and Sat/Turn weights.

These are the demo’s “how well this works” chart. When the host drags the slider toward Turn, wait P90 should drop and pref hit rate should drop. When they drag toward Sat, the opposite. If that does not happen, the optimizer is fake.

---

## 11. Three-minute demo script

1. **0:00–0:20** Start from a fresh paused run. Name the random run code, 120-seat floor, 45-minute horizon, and visible tentative plans.
2. **0:20–0:45** Press Start and 5x. Use next-event once or twice so the first parties arrive and the agent begins committing planned tables.
3. **0:45–1:15** Click a non-primary candidate on an upcoming party. The chip becomes **HOST**; when that party arrives, the host plan commits and the movement animation lands on the chosen table.
4. **1:15–1:45** Toggle to **Manual floor**, jump to a walk-in, and drag the waiting row onto a legal table. No automatic candidates or assignments appear while manual mode is active.
5. **1:45–2:10** Return to Local algorithm. Lock a table or mark one dirty/ready and show the event-driven full-floor review in the activity ledger.
6. **2:10–2:35** Open **Connect AI** and attach a WebMCP-capable agent. Show `get_floor`, `get_queue`, `score_assignment`, and a write such as `set_candidates` or `assign_table` updating the same board.
7. **2:35–3:00** Jump to 10:00 PM and show the service score, same-seed local baseline, assignment provenance, and service-brief results. State that this is the demo’s metric, not the OpenAI judging score.

Audio on the video names the tools.

---

## 12. What we are not building (v1)

- Real OpenTable / Resy / POS.
- Guest-facing waitlist SMS.
- Full staffing schedules and tip-out. Named server sections exist only as table-allocation context in the random service brief.
- Combinable tables (four 2-tops → 8) except: adjacent counter stools already defined as pairable.
- Multi-room beyond P1/P2 as marked.
- Learning / historical guest graph beyond `is_regular`.
- Perfect dwell prediction. Bands only.

Combinable 4-tops are a known host move. If v1 needs one “wow,” allow **one** scripted combine: S1+S2 → 6 with host confirm. Otherwise cut.

---

## 13. Hackathon packaging remaining before submission

- Live URL, public OSS repo + license, <3 min YouTube with audio.
- README: prior work none; this is new. How to enable WebMCP. Test as host (pause clock) and as agent (ChatGPT in-app browser: “Seat the floor for the next 30 minutes, don’t burn the 7:00 private hold”).
- Do not edit repo or live URL after Thu Sep 3, 1pm PT if submitted.

---

## 14. Open questions for Vincent

1. **Decided:** project name is Host Stand. Restaurant on the floor is The Steak House.
2. **Decided:** keep the Sat/Turn slider in v1, collapsed inside simulation details by default.
3. Combinable tables: none, or the one S1+S2 gag.
4. **Decided:** agent posts candidate tables (x, y, z) within a 45-minute horizon; if the host does nothing, the plan commits at reservation arrival or after a five-minute walk-in override window. Plans freeze at T−5, while host overrides remain fixed. `offer_choice` is cut.
5. **Decided:** counter is six 1–2 units.

---

## 15. Build note

The testable MVP is implemented as a browser-native simulation with manual and agent-assisted modes, a 120-seat randomized floor, and a functional WebMCP tool surface. Continue iterating against this document as host feedback is incorporated.
