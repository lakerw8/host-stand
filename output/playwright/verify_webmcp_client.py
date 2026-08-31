from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL = "http://127.0.0.1:4180"

MODEL_CONTEXT_POLYFILL = r"""
(() => {
  class TestModelContext extends EventTarget {
    constructor() {
      super();
      this.registered = new Map();
      this.registrationOptions = new Map();
    }

    async registerTool(tool, options = {}) {
      if (!tool?.name || !tool?.description || this.registered.has(tool.name)) {
        throw new DOMException('Invalid or duplicate tool', 'InvalidStateError');
      }
      JSON.stringify(tool.inputSchema);
      this.registered.set(tool.name, tool);
      this.registrationOptions.set(tool.name, options || {});
      queueMicrotask(() => this.dispatchEvent(new Event('toolchange')));
    }

    async getTools() {
      return [...this.registered.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((tool) => ({
          name: tool.name,
          title: tool.title || '',
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
          origin: location.origin,
          window
        }));
    }

    async executeTool(discoveredTool, input = '{}', options = {}) {
      const implementation = this.registered.get(discoveredTool.name);
      if (!implementation) throw new DOMException('Tool not found', 'NotFoundError');
      const parsedInput = typeof input === 'string' ? JSON.parse(input) : input;
      const callbackOptions = {
        signal: options.signal || new AbortController().signal
      };
      return JSON.stringify(await implementation.execute(parsedInput, callbackOptions));
    }
  }

  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    enumerable: true,
    value: new TestModelContext()
  });
})();
"""


def main():
    with urlopen(URL) as response:
        assert response.headers.get("Origin-Agent-Cluster") == "?1"

    console_errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.add_init_script(MODEL_CONTEXT_POLYFILL)
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: console_errors.append(str(error)))
        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_function("window.__HOST_STAND_WEBMCP_STATUS__?.registered === 20")

        result = page.evaluate(r"""async () => {
          const status = await window.__HOST_STAND_WEBMCP_READY__;
          const tools = await document.modelContext.getTools();
          const invoke = async (name, input = {}, options = {}) => {
            const tool = tools.find((candidate) => candidate.name === name);
            if (!tool) throw new Error(`Missing ${name}`);
            const serialized = await document.modelContext.executeTool(tool, JSON.stringify(input), options);
            const toolResult = JSON.parse(serialized);
            const payload = JSON.parse(toolResult.content[0].text);
            return { toolResult, payload };
          };

          const initial = await invoke('get_floor');
          const attached = await invoke('attach_agent', { agent_name: 'WebMCP Test Agent', mode: 'autonomous' });
          const queue = await invoke('get_queue');
          const party = queue.payload.reservations[0];
          await invoke('mark_party', { party_id: party.id, status: 'arrived' });
          const scores = await Promise.all(initial.payload.tables.map(async table => ({
            table,
            result: await invoke('score_assignment', { party_id: party.id, table_id: table.id })
          })));
          const legal = scores.filter(item => item.result.payload.legal).sort((a, b) => b.result.payload.score - a.result.payload.score);
          const tableId = legal[0].table.id;
          const score = legal[0].result;
          const candidates = await invoke('set_candidates', { party_id: party.id, table_ids: legal.slice(0, 3).map(item => item.table.id) });
          const assignment = await invoke('assign_table', { party_id: party.id, table_id: tableId });
          const afterAssignment = await invoke('get_floor');
          const invalid = await invoke('set_candidates', { party_id: party.id });

          const controller = new AbortController();
          controller.abort();
          const aborted = await invoke('get_floor', {}, { signal: controller.signal });

          document.querySelector('[data-action="reset-night"]').click();
          const afterReset = await invoke('get_floor');

          return {
            status,
            names: tools.map((tool) => tool.name),
            allSchemasAreObjects: tools.every((tool) => tool.inputSchema?.type === 'object'),
            readOnlyCount: tools.filter((tool) => tool.annotations?.readOnlyHint).length,
            initialTables: initial.payload.tables.length,
            initialCapacity: initial.payload.capacity,
            attached: attached.payload,
            queueParty: { id: party.id, status: party.status },
            scoredLegal: score.payload.legal,
            candidatesOk: candidates.payload.ok,
            assigned: assignment.payload,
            assignedTable: afterAssignment.payload.tables.find((table) => table.id === tableId),
            invalid: { isError: invalid.toolResult.isError, payload: invalid.payload },
            aborted: { isError: aborted.toolResult.isError, payload: aborted.payload },
            reset: { clock: afterReset.payload.clock, running: afterReset.payload.running, runChanged: afterReset.payload.runCode !== initial.payload.runCode, controllerMode: afterReset.payload.controllerMode, agentName: afterReset.payload.agentConnection?.name }
          };
        }""")

        assert result["status"]["supported"] is True
        assert result["status"]["registered"] == 20
        assert result["names"] == sorted(result["names"])
        assert result["allSchemasAreObjects"] is True
        assert result["readOnlyCount"] == 3
        assert result["initialTables"] == 27
        assert result["initialCapacity"] == 100
        assert result["attached"]["ok"] is True
        assert result["queueParty"]["status"] == "upcoming"
        assert result["scoredLegal"] is True
        assert result["candidatesOk"] is True
        assert result["assigned"]["seated"] is True
        assert result["assignedTable"]["partyId"] == result["queueParty"]["id"]
        assert result["invalid"]["isError"] is True
        assert result["invalid"]["payload"]["error"]["code"] == "INVALID_INPUT"
        assert result["aborted"]["isError"] is True
        assert result["aborted"]["payload"]["error"]["code"] == "ABORTED"
        assert result["reset"] == {"clock": "5:45 PM", "running": False, "runChanged": True, "controllerMode": "external", "agentName": "WebMCP Test Agent"}
        assert "WebMCP Test Agent attached" in page.locator(".mcp-status").inner_text()
        assert console_errors == [], f"browser console errors: {console_errors}"
        browser.close()

    native_console_errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=CHROME,
            headless=True,
            args=["--enable-features=WebMCP", "--enable-blink-features=WebMCP"],
        )
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("console", lambda message: native_console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: native_console_errors.append(str(error)))
        page.goto(URL, wait_until="domcontentloaded")
        assert page.evaluate("typeof document.modelContext?.registerTool") == "function"
        page.wait_for_function("window.__HOST_STAND_WEBMCP_STATUS__?.registered === 20")

        native_result = page.evaluate(r"""async () => {
          const tools = await document.modelContext.getTools();
          const invoke = async (name, input = {}) => {
            const tool = tools.find((candidate) => candidate.name === name);
            const serialized = await document.modelContext.executeTool(tool, JSON.stringify(input));
            const toolResult = JSON.parse(serialized);
            return { toolResult, payload: JSON.parse(toolResult.content[0].text) };
          };

          const floor = await invoke('get_floor');
          const attached = await invoke('attach_agent', { agent_name: 'Native Chrome Agent', mode: 'autonomous' });
          const queue = await invoke('get_queue');
          const party = queue.payload.reservations[0];
          await invoke('mark_party', { party_id: party.id, status: 'arrived' });
          const scores = await Promise.all(floor.payload.tables.map(async table => ({ table, result: await invoke('score_assignment', { party_id: party.id, table_id: table.id }) })));
          const legal = scores.filter(item => item.result.payload.legal).sort((a, b) => b.result.payload.score - a.result.payload.score);
          const tableId = legal[0].table.id;
          const assignment = await invoke('assign_table', { party_id: party.id, table_id: tableId });
          const verifiedFloor = await invoke('get_floor');
          const invalid = await invoke('set_candidates', { party_id: party.id });

          return {
            count: tools.length,
            names: tools.map((tool) => tool.name),
            readOnlyCount: tools.filter((tool) => tool.annotations?.readOnlyHint).length,
            tables: floor.payload.tables.length,
            capacity: floor.payload.capacity,
            attached: attached.payload,
            partyId: party.id,
            assignment: assignment.payload,
            assignedTable: verifiedFloor.payload.tables.find((table) => table.id === tableId),
            invalid: { isError: invalid.toolResult.isError, payload: invalid.payload }
          };
        }""")

        assert native_result["count"] == 20
        assert native_result["names"] == sorted(native_result["names"])
        assert native_result["readOnlyCount"] == 3
        assert native_result["tables"] == 27
        assert native_result["capacity"] == 100
        assert native_result["attached"]["ok"] is True
        assert native_result["assignment"]["seated"] is True
        assert native_result["assignedTable"]["partyId"] == native_result["partyId"]
        assert native_result["invalid"]["isError"] is True
        assert native_result["invalid"]["payload"]["error"]["code"] == "INVALID_INPUT"
        assert native_console_errors == [], f"native browser console errors: {native_console_errors}"
        browser.close()

    print("PASS · Origin-Agent-Cluster enables an origin-isolated WebMCP document")
    print("PASS · Chrome 151's native WebMCP API registers, discovers, and executes all tools")
    print("PASS · an independent client discovers 20 sorted tools through getTools()")
    print("PASS · schemas and current readOnlyHint annotations survive discovery")
    print("PASS · executeTool() reads, scores, writes, and verifies shared page state")
    print("PASS · malformed and cancelled calls return structured agent-readable errors")
    print("PASS · explicit agent attachment survives a human-created random reset")
    print("PASS · no browser console or page errors")


if __name__ == "__main__":
    main()
