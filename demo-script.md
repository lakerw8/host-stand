# Host Stand Demo Script

Target runtime: **2 minutes 45 seconds**. Record at 1440×900 with narration. Do not imply the Host Stand service score is an OpenAI judging score.

Public demo: [host-stand-nine.vercel.app](https://host-stand-nine.vercel.app)

A [94-second narrated preview](./output/playwright/host-stand-demo.mp4) is generated from the five browser-verified proof states. It is an honest local preview, not the final hosted video: before submission, record the continuous external-agent tool-call sequence and publish the final cut at the video URL required by Devpost.

## 0:00–0:20 · Establish the problem

**Show:** A fresh paused run at 5:00 PM.

**Say:** “Host Stand is a live 120-seat restaurant simulation built for the OpenAI WebMCP Challenge. Every run generates a different five-hour dinner service, including reservations, walk-ins, hard seating requirements, and two whole-floor service priorities.”

Point out the random run code, unified queue, table floor, and service brief.

## 0:20–0:50 · Show the local algorithm planning

**Show:** Press **Start**, select **5×**, then jump to the next event once or twice.

**Say:** “The built-in local mode is a deterministic algorithm—not an LLM. It reviews the full floor after every meaningful event and every ten restaurant minutes. It publishes up to three tentative tables and automatically executes the top legal plan when the host does nothing.”

Point out an `ALG` table label and its explanation.

## 0:50–1:15 · Override the automation

**Show:** Drag an upcoming reservation to another legal table.

**Say:** “The host always remains in control. Dragging an upcoming reservation locks a tentative host plan; dragging an arrived party seats it immediately. The assignment becomes `HOST`, and the algorithm replans around it.”

## 1:15–1:35 · Demonstrate fully manual operation

**Show:** Turn off Local algorithm, jump to an arrived party, and drag it onto a legal table.

**Say:** “With automation off, no party assigns itself. The human must handle every arrival through drag-and-drop or party-then-table selection.”

## 1:35–2:15 · Connect a real WebMCP agent

**Show:** Open **Connect AI**. In a WebMCP-capable browser agent, attach as `WebMCP Agent`, then call `get_floor`, `get_queue`, `score_assignment`, `set_candidates`, and `assign_table` with a concise reason.

**Say:** “An external AI needs no Host Stand API key. It discovers twenty browser-native tools, reads structured state instead of scraping the page, and writes through the same engine as the human interface. The local algorithm pauses so the planners never conflict.”

Show the tool activity, assignment movement, `AI` provenance, and reason in the table inspector.

## 2:15–2:45 · Prove and score the result

**Show:** Advance a full local-algorithm run to 10:00 PM and open **Review score**.

**Say:** “At service end, Host Stand separates host, local-algorithm, and external-AI decisions. It scores guest satisfaction, walk-in wait control, table fit, parties served, and the service brief, then compares the result with the local algorithm replaying the identical random seed and weights. This is a transparent demo metric, not an OpenAI judging score.”

End on the scorecard with the public demo URL and GitHub repository visible in the video description.

## Recording checklist

- [ ] Keep the final video below three minutes.
- [ ] Include spoken narration naming the WebMCP tools.
- [ ] Capture an actual external-agent tool call, not only the built-in algorithm.
- [ ] Show one manual override and the resulting `HOST` provenance.
- [ ] Show one external assignment with `AI` provenance and a visible reason.
- [ ] Finish on a completed-night scorecard with more than 60 parties served.
- [ ] Add the public HTTPS URL and repository link to the video description.
