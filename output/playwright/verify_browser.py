from pathlib import Path
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output" / "playwright"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL = "http://127.0.0.1:4180"


def clock_minute(label):
    time_text, suffix = label.strip().split()
    hour_text, minute_text = time_text.split(":")
    hour = int(hour_text) % 12 + (12 if suffix == "PM" else 0)
    return hour * 60 + int(minute_text)


def main():
    results = []
    console_errors = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1100}, device_scale_factor=1)
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: console_errors.append(str(error)))

        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_selector(".floor-map")
        assert page.title() == "Host Stand · The Steak House"
        assert page.locator(".table-node").count() == 27
        assert page.locator(".party-row").count() >= 8
        assert "100 seats · 27 table units" in page.locator(".brand-lockup").inner_text()
        first_upcoming = page.locator('.party-row').first
        first_party_id = first_upcoming.get_attribute("data-party-id")
        first_party_name = first_upcoming.locator(".party-name").inner_text()
        first_candidates = first_upcoming.locator(".candidate-button")
        assert first_candidates.count() >= 1
        preview_table_id = first_candidates.first.get_attribute("data-table-id")
        first_candidates.first.click()
        assert page.locator(f'.party-row[data-party-id="{first_party_id}"]').count() == 1
        assert first_party_name not in page.locator(f'.table-node[data-table-id="{preview_table_id}"]').inner_text()
        first_party_height = page.locator(f'.party-row[data-party-id="{first_party_id}"]').bounding_box()["height"]
        assert first_party_height <= 100, f"upcoming party row is not compact: {first_party_height}px"
        page.screenshot(path=str(OUTPUT / "initial-desktop.png"), full_page=True)
        results.append("initial floor renders 27 named table units totaling exactly 100 seats")
        results.append("upcoming reservations show previewable live table suggestions without seating early")
        results.append("reservation and walk-in cards use a compact two-line layout")

        initial_at = page.locator(".clock-readout time").inner_text()
        page.wait_for_timeout(1200)
        assert page.locator(".clock-readout time").inner_text() == initial_at
        page.get_by_label("Start service clock").click()
        page.wait_for_timeout(1150)
        page.get_by_label("Pause service clock").click()
        started_at = page.locator(".clock-readout time").inner_text()
        assert 1 <= clock_minute(started_at) - clock_minute(initial_at) <= 2
        results.append("service stays paused until Start, then the clock advances")

        start = clock_minute(started_at)
        page.locator('[data-action="set-speed"][data-speed="5"]').click()
        page.get_by_label("Resume service clock").click()
        page.wait_for_timeout(1150)
        page.get_by_label("Pause service clock").click()
        end = clock_minute(page.locator(".clock-readout time").inner_text())
        assert 4 <= end - start <= 7
        results.append("5x advances roughly five restaurant minutes per real second")

        first_run = page.evaluate("async () => (await window.hostStandInvokeTool('get_floor', {})).runCode")
        first_roster = page.evaluate("async () => (await window.hostStandInvokeTool('get_queue', {})).reservations.map(p => [p.id, p.size, p.reservedFor])")
        page.locator('[data-action="reset-night"]').last.click()
        assert page.locator(".clock-readout time").inner_text() == "5:45 PM"
        assert page.get_by_label("Start service clock").count() == 1
        assert page.locator(".reset-control").count() == 1
        second_run = page.evaluate("async () => (await window.hostStandInvokeTool('get_floor', {})).runCode")
        second_roster = page.evaluate("async () => (await window.hostStandInvokeTool('get_queue', {})).reservations.map(p => [p.id, p.size, p.reservedFor])")
        assert second_run != first_run
        assert second_roster != first_roster
        assert "New random run" in page.locator(".toast").inner_text()
        results.append("New run clears the floor and generates a different random scenario")

        page.get_by_label("Jump to next event").click()
        waiting_party = page.locator('.party-row[draggable="true"]').first
        assert waiting_party.count() == 1
        waiting_name = waiting_party.locator(".party-name").inner_text()
        legal_table_id = waiting_party.locator(".candidate-button").first.get_attribute("data-table-id")
        page.locator('[data-action="toggle-agent"]').click()
        assert page.locator('[data-action="toggle-agent"]').get_attribute("aria-checked") == "false"
        waiting_party.drag_to(page.locator(f'.table-node[data-table-id="{legal_table_id}"]'))
        assert waiting_name in page.locator(f'.table-node[data-table-id="{legal_table_id}"]').inner_text()
        results.append("manual mode seats a generated party through drag-and-drop")

        page.locator('[data-action="reset-night"]').last.click()
        page.locator('[data-action="open-agent-panel"]').click()
        assert "Attach through WebMCP" in page.locator(".agent-connect-panel").inner_text()
        attach_result = page.evaluate("""async () => window.hostStandInvokeTool('attach_agent', {agent_name: 'Browser QA', mode: 'autonomous'})""")
        assert attach_result["ok"] is True
        assert "Browser QA is attached" in page.locator(".agent-connect-panel").inner_text()
        agent_result = page.evaluate("""async () => {
          const queue = await window.hostStandInvokeTool('get_queue', {});
          const party = queue.reservations[0];
          await window.hostStandInvokeTool('mark_party', {party_id: party.id, status: 'arrived'});
          const floor = await window.hostStandInvokeTool('get_floor', {});
          const scores = await Promise.all(floor.tables.map(async table => ({
            table,
            score: await window.hostStandInvokeTool('score_assignment', {party_id: party.id, table_id: table.id})
          })));
          const best = scores.filter(item => item.score.legal).sort((a, b) => b.score.score - a.score.score)[0];
          await window.hostStandInvokeTool('set_candidates', {party_id: party.id, table_ids: [best.table.id]});
          const assigned = await window.hostStandInvokeTool('assign_table', {party_id: party.id, table_id: best.table.id});
          return {party, tableId: best.table.id, assigned};
        }""")
        assert agent_result["assigned"]["seated"] is True
        assert agent_result["party"]["name"] in page.locator(f'.table-node[data-table-id="{agent_result["tableId"]}"]').inner_text()
        expected_finish = page.evaluate("""async tableId => (await window.hostStandInvokeTool('get_floor', {})).tables.find(table => table.id === tableId).expectedFinishAt""", agent_result["tableId"])
        floor_minute = page.evaluate("""async () => (await window.hostStandInvokeTool('get_floor', {})).minute""")
        assert expected_finish == floor_minute + 90
        results.append("an external AI attaches explicitly, scores the random floor, and seats through WebMCP")

        tool_count = page.evaluate("window.__HOST_STAND_TOOLS__.length")
        floor = page.evaluate("""async () => window.hostStandInvokeTool('get_floor', {})""")
        assert tool_count == 20
        assert len(floor["tables"]) == 27
        assert floor["capacity"] == 100
        assigned_table = next(table for table in floor["tables"] if table["id"] == agent_result["tableId"])
        assert assigned_table["expectedFinishAt"] == floor["minute"] + 90
        assert floor["controllerMode"] == "external"
        results.append("20 WebMCP definitions expose agent ownership and 90-minute expected finishes")

        page.keyboard.press("Meta+K")
        assert page.locator("#command-dialog").get_attribute("open") is not None
        page.locator("#command-search").fill("busy")
        page.get_by_text("Busy Saturday · 35/65", exact=True).click()
        assert "Sat 35" in page.locator(".weight-console label").inner_text()
        assert "Turn 65" in page.locator(".weight-console label").inner_text()
        results.append("command palette opens from Meta+K and applies the Busy Saturday preset")

        page.screenshot(path=str(OUTPUT / "desktop.png"), full_page=True)
        for width in (320, 375, 414, 768):
            page.set_viewport_size({"width": width, "height": 900})
            page.wait_for_timeout(150)
            dimensions = page.evaluate("""() => ({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth})""")
            assert dimensions["scroll"] <= dimensions["client"], f"horizontal overflow at {width}px: {dimensions}"
            wrapped = page.evaluate("""() => [...document.querySelectorAll('.control,.candidate-button,.command-trigger,.agent-toggle,.foot-line button,.speed-switch button')]
              .filter((element) => {
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                const textLines = new Set();
                let node;
                while ((node = walker.nextNode())) {
                  if (!node.textContent.trim()) continue;
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  for (const rect of range.getClientRects()) {
                    if (rect.width > 1 && rect.height > 1) textLines.add(Math.round(rect.top));
                  }
                }
                return textLines.size > 1;
              }).map((element) => element.textContent.trim())""")
            assert wrapped == [], f"wrapped affordances at {width}px: {wrapped}"
            page.screenshot(path=str(OUTPUT / f"mobile-{width}.png"), full_page=True)
        results.append("320, 375, 414, and 768 px layouts have no horizontal overflow or wrapped controls")

        browser.close()

    assert console_errors == [], f"browser console errors: {console_errors}"
    for result in results:
        print(f"PASS · {result}")
    print("PASS · no browser console or page errors")


if __name__ == "__main__":
    main()
