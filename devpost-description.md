# Host Stand · Devpost project story

Tagline (183 chars): A restaurant host stand where a human and a browser agent seat the same floor through WebMCP. The engine enforces the rules; the agent makes the judgment calls; the night grades both.

Built with: JavaScript, HTML, CSS, WebMCP, document.modelContext, Node.js, Vercel, Playwright, ChatGPT, GitHub

---

## Inspiration

Every restaurant has a host stand, and the person behind it makes about forty judgment calls an hour that nobody checks. The software on the stand is a grid of table shapes. It knows a four won't fit a two-top, and that is about all it knows. Everything interesting is in the notes: "somewhere private", "near the in-laws but not the same table", "our regular always gets V3, and so does tonight's anniversary." Those notes are the job, and no system reads them.

When the WebMCP Challenge opened, that felt like the right test. Not "can an agent click through a form," but "can an agent make the calls a good host makes, inside the tool the host already uses, without taking the host's hands off the floor."

## What it does

Host Stand is one screen: a 120-seat dining room, a five-hour dinner service, and a queue of reservations and walk-ins. A host runs it by dragging parties onto tables. A browser agent runs it through 22 WebMCP tools. Both see the same floor, clock, queue, and version number.

The division of labor is explicit. The engine enforces: capacity, accessibility, high chairs, locks, dirty-table timers, and reservation priority. No prompt can talk it out of those. The agent reasons: it reads each party's free-text request, plans the whole night up front so a scarce window table is held for the guest who needs it later, and explains every choice in a one-line reason. The host decides: any plan can be accepted (it commits as "AI ✓"), rejected with a reason the agent sees and cannot re-propose, or overridden by hand; a note typed mid-service reaches the agent as a request to look again.

Every run seeds eight to ten special requests that no rule can settle, drawn from five kinds: interpretation ("atmosphere, not a corner"), relations between parties, conditional plans ("we might be six or eight, we'll know by 6:45"), trade-offs ("the regular or the anniversary, your call"), and discretion ("we think it's the critic, don't make it obvious"). One request per night is a prompt-injection probe from a walk-in asking to skip the queue; the engine blocks it and the ledger shows the attempt. At 10 PM the scorecard puts Host decisions and Agent decisions side by side, special requests first, misses included, so "what did the agent add that the code couldn't" has a number attached.

## Why WebMCP

A host stand is shared state with a person already standing at it, so the tools have to live where the floor lives: in the page. Host Stand registers its tools with `document.modelContext` and falls back to `navigator.modelContext`. Any browser agent the staff already use can find `get_floor`, `get_queue`, `set_plan`, `assign_table`, `add_host_note`, and the rest with no API key, no backend, and no integration project. Every call runs the same engine function the mouse does, lands in the visible ledger, and carries a name. The page ships no model of its own; whatever agent opens it brings the reasoning. We verified registration in ChatGPT's built-in browser and in Chrome 152 with the WebMCP flag, against the live URL.

## How we built it

Plain HTML, CSS, and JavaScript modules, no dependencies. `src/engine.js` is a deterministic state machine: two modes (Manual host, Agent), a reservation-first commit guard, a scoring service, a whole-night plan board with time conflicts, optimistic concurrency with a 50-entry change log, and the request grader. `src/data.js` seeds each night from a run code with 84 to 96 parties and the special requests, each template with at least three phrasings so an agent cannot pattern-match strings. The hidden ground truth is generated with the text and graded at 10 PM by pure functions over the final state: seating records, marks, the size-change trace, and floor geometry (adjacency and Chebyshev distance on a 14×7 grid). `src/webmcp.js` defines the 22 tools with schema validation, `readOnlyHint` and `untrustedContentHint` annotations, and an `expected_version` gate on every write. `src/app.js` renders the floor, the queue, the ledger, Accept and Reject, host notes, and the recap. 96 Node tests and two Playwright verifiers cover generation, grading, concurrency, and the browser flows.

## Challenges we ran into

Grading free text without leaking the answer. The agent must infer intent, so the ground truth had to be generated alongside the text and never exposed. A test serializes every tool result and the DOM and fails if any predicate name appears.

Two planners on one floor. A host drag between an agent's read and its write should never be silently overwritten. Every mutation bumps a floor version, every write may pass `expected_version`, and a stale write comes back as `STALE_STATE` with the changes the agent missed, visible in the ledger.

Agent latency. A whole-night plan is sixty-odd reservations, and one tool call per party took minutes. `set_plan` posts up to forty parties in one call with a per-party result, so the first pass is two or three calls.

The judge browser changed mid-hackathon. Atlas was retired, and its browser moved into the ChatGPT desktop app. We found the built-in browser there, verified all 22 tools registered through `document.modelContext`, and ran the agent loop from it.

Making it readable for someone who has never seen it. Judges scan. A design pass rewrote every status line in plain words, put the service brief on its own row, and moved the WebMCP status chip where it can be seen on load.

## What we learned

Draw the line between engine and agent before writing either. Once legality, timers, and arithmetic were non-negotiable in code, the agent's job became clear, and the prompt got shorter. Browser agents do not poll, so the page has to say when it wants attention and the human has to cue it. And an agent that only sees the next hour will spend the window four-top on a couple with no preferences; whole-night planning needs a plan board it can read, not a bigger prompt.

## What's next

Connect the floor to a real reservation feed instead of a seed. Let the agent see server section loads and kitchen pace as first-class data. Add declarative form tools for the walk-in check-in and output schemas on the read tools. And run it on a real Friday, with a real host, and see which column wins.
