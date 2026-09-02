# WebMCP browser verification

Records which browsers registered the Host Stand tools, through which entry point, and against which URL. The judges test with ChatGPT's in-app browser (the ChatGPT desktop app's built-in browser, which replaced Atlas) or Chrome with `chrome://flags/#enable-webmcp-testing`. The interactive-Chrome row still needs a hand-filled entry from a machine with the flag enabled.

| Date (PDT) | Browser | URL | Entry point | Tools registered | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-01 | Google Chrome 152.0.7977.65  (Playwright headless, `--enable-features=WebMCP --enable-blink-features=WebMCP`) | http://127.0.0.1:4173 | `document.modelContext` | 21 / 21 | `verify_webmcp_client.py` native pass: getTools() returns 21 sorted tools, executeTool() reads, scores, writes; STALE_STATE and INVALID_INPUT round-trip through the native API. |
| 2026-09-01 | Google Chrome 152.0.7977.65  (Playwright headless, in-page polyfill on `document`) | http://127.0.0.1:4173 | `document.modelContext` | 21 / 21 | Simulates a spec-canonical host. Header chip reads `WebMCP: 21 tools · document`. |
| 2026-09-01 | Google Chrome 152.0.7977.65  (Playwright headless, in-page polyfill on `navigator` only) | http://127.0.0.1:4173 | `navigator.modelContext` | 21 / 21 | Simulates an embedded browser that still exposes the older location; `document.modelContext` is undefined. Header chip reads `WebMCP: 21 tools · navigator`. |
| 2026-09-01 | Google Chrome 152.0.7977.65  (plain, no flag) | http://127.0.0.1:4173 | none | 0 / 21 | Expected: chip reads `WebMCP: 21 tools · unavailable`; `window.__HOST_STAND_TOOLS__` still exposes the definitions and `window.hostStandInvokeTool` still executes them. |
| 2026-09-01 | Google Chrome 152.0.7977.65 (Playwright headless, `--enable-features=WebMCP --enable-blink-features=WebMCP`) | https://host-stand-nine.vercel.app (commit 106566a) | `document.modelContext` | 21 / 21 | Same native pass as above against production; `Origin-Agent-Cluster: ?1` confirmed on the response. |
| 2026-09-01 | Google Chrome 152.0.7977.65 (Playwright headless, polyfill on `navigator` only) | https://host-stand-nine.vercel.app (commit 106566a) | `navigator.modelContext` | 21 / 21 | Fallback pass against production; chip reads `WebMCP: 21 tools · navigator`. |
| 2026-09-01 | Google Chrome 152.0.7977.65 (Playwright headless, no flag) | https://host-stand-nine.vercel.app/?run=DEMOAAFT | none | 0 / 21 | Demo night loads with 10 open requests; chip reads `· unavailable`; no console errors. |
| _pending_ | Chrome (interactive) with `chrome://flags/#enable-webmcp-testing` | https://host-stand-nine.vercel.app | | | Load the page, confirm the chip reads `· document` (or `· navigator`) on load, then run the agent loop from **Connect AI**. Record the version string from `chrome://version`. |
| 2026-09-01 | ChatGPT desktop app 26.825.51511 for macOS (built-in browser, Codex chat, model GPT-5.6 Sol) | https://host-stand-nine.vercel.app/?run=DEMOAAFT (commit 106566a) | `document.modelContext` | 21 / 21 | The judges' surface: Atlas was retired and its browser moved into the ChatGPT desktop app. Opened via the side panel → **Browser**. Chip reads `WebMCP: 21 tools · document`. Prompting the chat to use the page's site tools produced `attach_agent` (agent "ChatGPT", advisory), `get_floor`, and `get_queue`; the header switched to **Agent: ChatGPT** and the agent reported runCode `DEMOAAFT`, floorVersion 1, controllerMode `external`. The address-bar page-info popover in this build shows only "Connection is secure" and "Site settings"; there was no separate "Site tools" entry to inspect. |

## How to reproduce the automated rows

```bash
PORT=4173 npm start
HOST_STAND_URL=http://127.0.0.1:4173 npm run verify:webmcp
```

Point `HOST_STAND_URL` at the deployed URL to repeat the same three passes against production.

## What a silent zero-registration looks like

If a WebMCP-capable browser shows `WebMCP: 21 tools · unavailable`, registration did not find a `modelContext` with `registerTool` on either `document` or `navigator`. Check `window.__HOST_STAND_WEBMCP_STATUS__` in the console: `entryPoint` is `null` and `failures` lists any per-tool registration errors when an entry point was found but a definition was rejected.
