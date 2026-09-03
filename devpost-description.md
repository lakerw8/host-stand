# Host Stand · Devpost project story

Tagline (183 chars): A restaurant host stand where a human and a browser agent seat the same floor through WebMCP. The engine enforces the rules; the agent makes the judgment calls; the night grades both.

Built with: JavaScript, HTML, CSS, WebMCP, document.modelContext, Node.js, Vercel, Playwright, ChatGPT, GitHub

---

## Inspiration

This started at a restaurant, not at a keyboard. It was a popular place on a busy night, and I spent a long wait watching the host work: a reservation book on one side, a line of walk-ins on the other, a grid of tables in between, and a steady stream of people asking how much longer. I noticed something I did not like about myself: the more often I went back to the stand to check in, the sooner I got a table. My persistence was being rewarded, which meant the host was allocating attention, not tables. That is not a character flaw in the host. It is what happens when one person is asked to hold every variable in their head, with a tool that only knows which shapes fit which parties.

If the wait could be shortened by nagging, then there was room to shorten it properly, for the guest who did not nag and for the room's own utilization. The interesting question was who, or what, should do that thinking.

## What it does

Host Stand is one screen: a 120-seat dining room, a five-hour dinner service, and a queue of reservations and walk-ins. A host runs it by dragging parties onto tables. A browser agent runs it through 22 WebMCP tools. Both see the same floor, clock, queue, and version number.

The division of labor is explicit. The engine enforces what should never be negotiable: capacity, accessibility, high chairs, locks, dirty-table timers, and reservation priority. The agent reasons: it reads each party's request in the guest's own words, plans the whole night so a scarce window table is held for the guest who needs it later, and explains every choice in a sentence. The host decides: any plan can be accepted, rejected with a reason the agent sees, or overridden by hand, and a note typed mid-service reaches the agent as a request to look again. When a party arrives, the engine seats it on its planned table by itself.

Every run seeds eight to ten requests that no rule can settle: "somewhere private", two families who want to be near each other but not together, a party that might be six or eight and will know by 6:45, a twenty-year regular and an anniversary who both want the same window table, a guest who is probably the critic and must not be treated visibly differently. One request per night is a prompt-injection probe from a walk-in asking to skip the queue; the engine blocks it and shows the attempt. At 10 PM the scorecard puts the host's decisions and the agent's side by side, special requests first, misses included.

## Why WebMCP

What I learned from looking at seating seriously is that it is a hybrid problem. Half of it is arithmetic and rules, which a deterministic program does better than any person. The other half is judgment over messy, human information, which a deterministic program cannot do at all. WebMCP turned out to be the most convenient way I have found to bring intelligence to exactly that second half. The page describes what it can do, in the page, and whatever agent the staff already use can act on it: no API key, no backend, no integration project, and no model shipped with the site. The host keeps working in the same tool; the agent joins them in it. Registration goes through `document.modelContext`, with a fallback to `navigator.modelContext`, and every call runs the same engine function the mouse does, lands in a visible ledger, and carries a name. I verified it in ChatGPT's built-in browser and in Chrome 152 with the WebMCP flag, against the live URL.

## How I built it

I built it with two coding agents, Codex and Claude Code, and I spent the first stretch not writing code. I wrote the problem down: every variable a real host juggles (party sizes, reservation times, lateness, walk-in timing, preferences, children, accessibility, no-shows, kitchen delays, section loads, and the requests people actually make), which of those are hard constraints and which are judgment, and what a good night would look like when it was over. Codex built the first version of the engine and the floor from that brief. Then I wrote a second brief, a PRD for the submission sprint, and Claude Code worked through it item by item: the special requests and their hidden grading, the optimistic concurrency, the accept-and-reject loop, the whole-night planning, and the browser verification against the ChatGPT desktop app and Chrome. Only after the engine held every hard rule did the WebMCP access point get built, so that the agent would work alongside the host rather than in place of them. Working this way meant my job was defining the problem and judging the result, which is the same division of labor the product itself argues for.

The result is plain HTML, CSS, and JavaScript modules with no dependencies. `src/engine.js` holds the state machine: two modes, a reservation-first guard, a scoring service, a whole-night plan board with time conflicts, optimistic concurrency with a change log, and the request grader. `src/data.js` seeds each night from a run code, including the special requests, each drawn from templates with several phrasings so an agent cannot pattern-match strings. `src/webmcp.js` defines the 22 tools with schema validation, `readOnlyHint` and `untrustedContentHint` annotations, and an `expected_version` check on every write. `src/app.js` renders the floor, the queue, the ledger, Accept and Reject, host notes, and the recap. 98 Node tests and two Playwright verifiers cover generation, grading, concurrency, and the browser flows.

## Challenges I ran into

The hardest part was not the agent. It was capturing enough of a real night that the agent's judgment would matter, and then deciding how to score that judgment honestly.

A night has to feel real without becoming a toy: 84 to 96 parties, a rush that peaks between six and nine, lateness that is sometimes zero and sometimes twenty minutes, a no-show or two, a kitchen delay, a server in training. Every variable I left out was a way for the agent to look smarter than it was.

The reward system was harder still. Who should get priority: the loyal regular who has sat at the same table for twenty years, or the first-timer with a strong chance of coming back? I could not find an honest weight that answers that, so the product does not pretend to have one. The rules that must never bend live in the engine and are enforced for everyone. The trade-off is handed to the agent as the host's own words, "your call", and the grade requires two things: an outcome from a short list a reasonable host would accept, and a written reason. Explaining the call is part of getting it right.

Grading free text meant the ground truth had to be generated with the text and never leave the engine; a test serializes every tool result and the page and fails if a predicate name leaks. Two planners on one floor meant a host drag between an agent's read and its write must never be silently overwritten; a stale write now comes back with the changes it missed. Agent latency meant one tool call per party was too slow for a whole-night plan; `set_plan` posts forty parties in one call. And the judges' browser changed mid-hackathon when Atlas was retired, so I found its successor inside the ChatGPT desktop app and verified there.

## What I learned

Draw the line between engine and agent before writing either. Once legality, timers, and arithmetic were non-negotiable in code, the agent's job became clear and its prompt got shorter. Browser agents do not poll, so the page has to say when it wants attention and the human has to cue it. And an agent that only sees the next hour will spend the window four-top on a couple with no preferences; whole-night planning needs a plan board it can read, not a bigger prompt.

## What's next

Connect the floor to a real reservation feed instead of a seed. Let the agent see server section loads and kitchen pace as first-class data. Add declarative form tools for the walk-in check-in and output schemas on the read tools. And run it on a real Friday, with a real host, and see which column wins.
