# WebMCP browser verification

Records which browsers registered the Host Stand tools, through which entry point, and against which URL. The judges test with ChatGPT's in-app browser (the ChatGPT desktop app's built-in browser, which replaced Atlas) or Chrome with `chrome://flags/#enable-webmcp-testing`. Both judge surfaces are verified against the production URL as of 2026-09-01.

| Date (PDT) | Browser | URL | Entry point | Tools registered | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-01 | Google Chrome 152.0.7977.65  (Playwright headless, `--enable-features=WebMCP --enable-blink-features=WebMCP`) | http://127.0.0.1:4173 | `document.modelContext` | 21 / 21 | `verify_webmcp_client.py` native pass: getTools() returns 21 sorted tools, executeTool() reads, scores, writes; STALE_STATE and INVALID_INPUT round-trip through the native API. |
| 2026-09-01 | Google Chrome 152.0.7977.65  (Playwright headless, in-page polyfill on `document`) | http://127.0.0.1:4173 | `document.modelContext` | 21 / 21 | Simulates a spec-canonical host. Header chip reads `WebMCP: 21 tools · document`. |
| 2026-09-01 | Google Chrome 152.0.7977.65  (Playwright headless, in-page polyfill on `navigator` only) | http://127.0.0.1:4173 | `navigator.modelContext` | 21 / 21 | Simulates an embedded browser that still exposes the older location; `document.modelContext` is undefined. Header chip reads `WebMCP: 21 tools · navigator`. |
| 2026-09-01 | Google Chrome 152.0.7977.65 (headless, no flag) | https://host-stand-nine.vercel.app/?run=DEMOAAFT | none | 0 / 21 | Verified: chip reads `WebMCP: 21 tools · unavailable`; `window.__HOST_STAND_TOOLS__` still exposes the definitions and `window.hostStandInvokeTool` still executes them. |
| 2026-09-01 | Google Chrome 152.0.7977.65 (Playwright headless, `--enable-features=WebMCP --enable-blink-features=WebMCP`) | https://host-stand-nine.vercel.app (commit 106566a) | `document.modelContext` | 21 / 21 | Same native pass as above against production; `Origin-Agent-Cluster: ?1` confirmed on the response. |
| 2026-09-01 | Google Chrome 152.0.7977.65 (Playwright headless, polyfill on `navigator` only) | https://host-stand-nine.vercel.app (commit 106566a) | `navigator.modelContext` | 21 / 21 | Fallback pass against production; chip reads `WebMCP: 21 tools · navigator`. |
| 2026-09-01 | Google Chrome 152.0.7977.65 (Playwright headless, no flag) | https://host-stand-nine.vercel.app/?run=DEMOAAFT | none | 0 / 21 | Demo night loads with 10 open requests; chip reads `· unavailable`; no console errors. |
| 2026-09-01 | Google Chrome 152.0.7977.65 (interactive, macOS, `chrome://flags/#enable-webmcp-testing` and `#devtools-webmcp-support` enabled) | https://host-stand-nine.vercel.app/?run=DEMOAAFT (commit 106566a) | `document.modelContext` | 21 / 21 | Verified by the user in their signed-in Chrome profile: the chip read `WebMCP: 21 tools · document` on load. The same build without the flag reports `· unavailable` (checked headless), so the flag is what enables registration in Chrome 152. |
| 2026-09-01 | ChatGPT desktop app 26.825.51511 for macOS (built-in browser, Codex chat, model GPT-5.6 Sol) | https://host-stand-nine.vercel.app/?run=DEMOAAFT (commit 106566a) | `document.modelContext` | 21 / 21 | The judges' surface: Atlas was retired and its browser moved into the ChatGPT desktop app. Opened via the side panel → **Browser**. Chip reads `WebMCP: 21 tools · document`. Prompting the chat to use the page's site tools produced `attach_agent` (agent "ChatGPT", advisory), `get_floor`, and `get_queue`; the header switched to **Agent: ChatGPT** and the agent reported runCode `DEMOAAFT`, floorVersion 1, controllerMode `external`, and 10 open requests. The address-bar page-info popover in this build shows only "Connection is secure" and "Site settings"; there was no separate "Site tools" entry to inspect. |

## How to reproduce the automated rows

```bash
PORT=4173 npm start
HOST_STAND_URL=http://127.0.0.1:4173 npm run verify:webmcp
```

Point `HOST_STAND_URL` at the deployed URL to repeat the same three passes against production.

## What a silent zero-registration looks like

If a WebMCP-capable browser shows `WebMCP: 21 tools · unavailable`, registration did not find a `modelContext` with `registerTool` on either `document` or `navigator`. Check `window.__HOST_STAND_WEBMCP_STATUS__` in the console: `entryPoint` is `null` and `failures` lists any per-tool registration errors when an entry point was found but a definition was rejected.
