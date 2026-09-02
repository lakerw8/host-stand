# WebMCP browser verification

Records which browsers registered the Host Stand tools, through which entry point, and against which URL. Update the table before code freeze; the ChatGPT row and the production-URL rows must be filled in by hand on a machine with those browsers.

| Date (PDT) | Browser | URL | Entry point | Tools registered | Notes |
| --- | --- | --- | --- | --- | --- |
| 2026-09-01 | Google Chrome 152.0.7977.65  (Playwright headless, `--enable-features=WebMCP --enable-blink-features=WebMCP`) | http://127.0.0.1:4173 | `document.modelContext` | 21 / 21 | `verify_webmcp_client.py` native pass: getTools() returns 21 sorted tools, executeTool() reads, scores, writes; STALE_STATE and INVALID_INPUT round-trip through the native API. |
| 2026-09-01 | Google Chrome 152.0.7977.65  (Playwright headless, in-page polyfill on `document`) | http://127.0.0.1:4173 | `document.modelContext` | 21 / 21 | Simulates a spec-canonical host. Header chip reads `WebMCP: 21 tools · document`. |
| 2026-09-01 | Google Chrome 152.0.7977.65  (Playwright headless, in-page polyfill on `navigator` only) | http://127.0.0.1:4173 | `navigator.modelContext` | 21 / 21 | Simulates an embedded browser that still exposes the older location; `document.modelContext` is undefined. Header chip reads `WebMCP: 21 tools · navigator`. |
| 2026-09-01 | Google Chrome 152.0.7977.65  (plain, no flag) | http://127.0.0.1:4173 | none | 0 / 21 | Expected: chip reads `WebMCP: 21 tools · unavailable`; `window.__HOST_STAND_TOOLS__` still exposes the definitions and `window.hostStandInvokeTool` still executes them. |
| _pending_ | Chrome (interactive) with `chrome://flags/#enable-webmcp-testing` | https://host-stand-nine.vercel.app | | | Load the page, confirm the chip reads `· document` (or `· navigator`) on load, then run the agent loop from **Connect AI**. Record the version string from `chrome://version`. |
| _pending_ | ChatGPT in-app browser | https://host-stand-nine.vercel.app | | | Open the deployed URL inside ChatGPT, paste the **Connect AI** prompt, and confirm the header switches to **Agent: …**. Record the app version and the entry point shown in the chip. |

## How to reproduce the automated rows

```bash
PORT=4173 npm start
HOST_STAND_URL=http://127.0.0.1:4173 npm run verify:webmcp
```

Point `HOST_STAND_URL` at the deployed URL to repeat the same three passes against production.

## What a silent zero-registration looks like

If a WebMCP-capable browser shows `WebMCP: 21 tools · unavailable`, registration did not find a `modelContext` with `registerTool` on either `document` or `navigator`. Check `window.__HOST_STAND_WEBMCP_STATUS__` in the console: `entryPoint` is `null` and `failures` lists any per-tool registration errors when an entry point was found but a definition was rejected.
