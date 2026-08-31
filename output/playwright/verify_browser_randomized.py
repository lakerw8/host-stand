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
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: console_errors.append(str(error)))

        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_selector(".floor-map")
        assert page.title() == "Host Stand · The Steak House"
        assert page.locator(".table-node").count() == 27
        assert "100 seats · 27 table units" in page.locator(".brand-lockup").inner_text()
        assert page.locator(".party-row").count() >= 8
        party_heights = page.locator(".party-row").evaluate_all("rows => rows.map(row => row.getBoundingClientRect().height)")
        assert max(party_heights) <= 100, party_heights
        assert page.locator(".queue-section").count() == 1
        assert page.locator(".queue-section h2").inner_text() == "Upcoming parties"
        assert page.locator(".party-source--reservation").count() >= 8
        source_key_text = " ".join(page.locator(".queue-source-key").inner_text().split())
        assert "Reservation first" in source_key_text, source_key_text
        assert "Walk-in after" in source_key_text, source_key_text
        viewport_fit = page.evaluate("() => ({pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight, floorHeight: document.querySelector('.floor-map').getBoundingClientRect().height, tableHeight: document.querySelector('[data-table-id=\"V1\"]').getBoundingClientRect().height})")
        assert viewport_fit["pageHeight"] <= viewport_fit["viewportHeight"], viewport_fit
        assert viewport_fit["floorHeight"] <= 482, viewport_fit
        assert viewport_fit["tableHeight"] <= 52, viewport_fit
        results.append("randomized floor fits 27 compact table units and one mixed-source queue without page scroll")

        for width, height in ((1024, 768), (1280, 800), (1440, 900)):
            page.set_viewport_size({"width": width, "height": height})
            page.wait_for_timeout(50)
            vertical_fit = page.evaluate("() => ({scroll: document.documentElement.scrollHeight, client: document.documentElement.clientHeight})")
            assert vertical_fit["scroll"] <= vertical_fit["client"], f"vertical page scroll at {width}x{height}: {vertical_fit}"
            kitchen_clearance = page.evaluate("""() => {
              const tables = [...document.querySelectorAll('.table-node')];
              const rule = document.querySelector('.room-rule--south').getBoundingClientRect();
              const label = document.querySelector('.zone-label--kitchen').getBoundingClientRect();
              return {
                tableBottom: Math.max(...tables.map(table => table.getBoundingClientRect().bottom)),
                passTop: Math.min(rule.top, label.top)
              };
            }""")
            assert kitchen_clearance["tableBottom"] + 4 <= kitchen_clearance["passTop"], \
                f"kitchen pass overlap at {width}x{height}: {kitchen_clearance}"
        results.append("1024x768, 1280x800, and 1440x900 desktop layouts fit without page scroll")
        results.append("south tables keep a clear lane above the kitchen pass")

        initial_at = page.locator(".clock-readout time").inner_text()
        page.wait_for_timeout(1100)
        assert page.locator(".clock-readout time").inner_text() == initial_at
        page.get_by_label("Start service clock").click()
        page.wait_for_timeout(1100)
        page.get_by_label("Pause service clock").click()
        started_at = page.locator(".clock-readout time").inner_text()
        assert 1 <= clock_minute(started_at) - clock_minute(initial_at) <= 2

        page.locator('[data-action="set-speed"][data-speed="5"]').click()
        page.get_by_label("Resume service clock").click()
        page.wait_for_timeout(1100)
        page.get_by_label("Pause service clock").click()
        end_at = page.locator(".clock-readout time").inner_text()
        assert 4 <= clock_minute(end_at) - clock_minute(started_at) <= 7
        results.append("Start, pause, resume, and 5x clock compression work")

        first_run = page.evaluate("async () => (await window.hostStandInvokeTool('get_floor', {})).runCode")
        first_roster = page.evaluate("async () => (await window.hostStandInvokeTool('get_queue', {})).reservations.map(p => [p.id, p.size, p.reservedFor])")
        page.locator(".reset-control").click()
        second_run = page.evaluate("async () => (await window.hostStandInvokeTool('get_floor', {})).runCode")
        second_roster = page.evaluate("async () => (await window.hostStandInvokeTool('get_queue', {})).reservations.map(p => [p.id, p.size, p.reservedFor])")
        assert second_run != first_run
        assert second_roster != first_roster
        assert page.locator(".clock-readout time").inner_text() == "5:45 PM"
        assert "New random run" in page.locator(".toast").inner_text()
        results.append("New run produces a different paused service and confirms the reset")

        queue_rail = page.locator(".queue-rail")
        anchor_before = queue_rail.evaluate("""rail => {
          const rows = [...rail.querySelectorAll('.party-row')];
          const anchor = rows[Math.floor(rows.length * 0.65)];
          rail.scrollTop = Math.max(1, anchor.offsetTop - rail.clientHeight / 3);
          return {
            id: anchor.dataset.partyId,
            offset: anchor.getBoundingClientRect().top - rail.getBoundingClientRect().top,
            scrollTop: rail.scrollTop
          };
        }""")
        assert anchor_before["scrollTop"] > 0
        initial_walk_ins = page.locator(".party-source--walk-in").count()
        for _ in range(20):
            page.get_by_label("Jump to next event").click()
            if page.locator(".party-source--walk-in").count() > initial_walk_ins:
                break
        assert page.locator(".party-source--walk-in").count() > initial_walk_ins, "no walk-in joined the unified queue"
        reservation_badge = page.locator(".party-source--reservation").first
        walk_in_badge = page.locator(".party-source--walk-in").first
        assert reservation_badge.inner_text() == "RES"
        assert walk_in_badge.inner_text() == "WALK-IN"
        source_styles = page.evaluate("""() => {
          const reservation = getComputedStyle(document.querySelector('.party-source--reservation'));
          const walkIn = getComputedStyle(document.querySelector('.party-source--walk-in'));
          return {
            reservationBackground: reservation.backgroundColor,
            reservationColor: reservation.color,
            walkInBackground: walkIn.backgroundColor,
            walkInColor: walkIn.color
          };
        }""")
        assert source_styles["reservationBackground"] != source_styles["walkInBackground"], source_styles
        assert source_styles["reservationColor"] != source_styles["walkInColor"], source_styles
        anchor_after = queue_rail.evaluate("""(rail, id) => {
          const anchor = rail.querySelector(`.party-row[data-party-id="${CSS.escape(id)}"]`);
          return anchor ? {
            offset: anchor.getBoundingClientRect().top - rail.getBoundingClientRect().top,
            scrollTop: rail.scrollTop
          } : null;
        }""", anchor_before["id"])
        assert anchor_after is not None, "the scroll anchor left the queue before the first walk-in"
        assert abs(anchor_after["offset"] - anchor_before["offset"]) <= 1.5, {"before": anchor_before, "after": anchor_after}
        assert anchor_after["scrollTop"] > 0
        queue_rail.evaluate("rail => rail.scrollTop = 0")
        page.screenshot(path=str(OUTPUT / "reservation-walkin-priority.png"), full_page=True)
        results.append("source labels remain unmistakable and new walk-ins join without moving the host's scroll position")

        page.locator('[data-action="toggle-agent"]').click()
        assert page.locator('[data-action="toggle-agent"]').get_attribute("aria-checked") == "false"
        waiting_party = page.locator('.party-row[draggable="true"]').first
        for _ in range(12):
            if waiting_party.count() == 1:
                break
            page.get_by_label("Jump to next event").click()
        assert waiting_party.count() == 1, "manual mode never surfaced a waiting party after 12 service events"

        waiting_name = waiting_party.locator(".party-name").inner_text()
        waiting_party_id = waiting_party.get_attribute("data-party-id")
        legal_table_id = page.evaluate("""async partyId => {
          const floor = await window.hostStandInvokeTool('get_floor', {});
          for (const table of floor.tables) {
            const score = await window.hostStandInvokeTool('score_assignment', {party_id: partyId, table_id: table.id});
            if (score.legal) return table.id;
          }
          return null;
        }""", waiting_party_id)
        assert legal_table_id is not None
        waiting_party.drag_to(page.locator(f'.table-node[data-table-id="{legal_table_id}"]'))
        assert waiting_name in page.locator(f'.table-node[data-table-id="{legal_table_id}"]').inner_text()
        results.append("manual mode waits for a real arrival and seats it through drag-and-drop")

        page.locator(".reset-control").click()
        page.locator('[data-action="open-agent-panel"]').click()
        assert "Attach through WebMCP" in page.locator(".agent-connect-panel").inner_text()
        attached = page.evaluate("async () => window.hostStandInvokeTool('attach_agent', {agent_name: 'Browser QA', mode: 'autonomous'})")
        assert attached["ok"] is True
        assert "Browser QA is attached" in page.locator(".agent-connect-panel").inner_text()

        assignment = page.evaluate("""async () => {
          const queue = await window.hostStandInvokeTool('get_queue', {});
          const party = queue.reservations[0];
          await window.hostStandInvokeTool('mark_party', {party_id: party.id, status: 'arrived'});
          const floor = await window.hostStandInvokeTool('get_floor', {});
          for (const table of floor.tables) {
            const score = await window.hostStandInvokeTool('score_assignment', {party_id: party.id, table_id: table.id});
            if (!score.legal) continue;
            await window.hostStandInvokeTool('set_candidates', {party_id: party.id, table_ids: [table.id]});
            const assigned = await window.hostStandInvokeTool('assign_table', {party_id: party.id, table_id: table.id});
            return {partyName: party.name, tableId: table.id, assigned};
          }
          return null;
        }""")
        assert assignment is not None and assignment["assigned"]["seated"] is True
        assert assignment["partyName"] in page.locator(f'.table-node[data-table-id="{assignment["tableId"]}"]').inner_text()
        expected_finish = page.evaluate("""async tableId => {
          const floor = await window.hostStandInvokeTool('get_floor', {});
          const table = floor.tables.find(item => item.id === tableId);
          return {minute: floor.minute, expectedFinishAt: table.expectedFinishAt};
        }""", assignment["tableId"])
        assert expected_finish["expectedFinishAt"] == expected_finish["minute"] + 90
        results.append("external AI attaches, scores, plans, and assigns through WebMCP with a 90-minute finish")

        page.locator(".command-trigger").click()
        page.locator("#command-search").fill("busy")
        visible_actions = page.locator("[data-palette-action]:visible")
        assert visible_actions.count() == 1
        assert "Busy Saturday" in visible_actions.first.inner_text()
        page.keyboard.press("Escape")
        assert page.locator("#command-dialog").evaluate("dialog => dialog.open") is False

        page.locator(".command-trigger").click()
        page.locator("#command-search").fill("busy")
        page.keyboard.press("Enter")
        assert "Sat 35" in page.locator(".weight-console label").inner_text()
        assert "Turn 65" in page.locator(".weight-console label").inner_text()
        results.append("command search filters, closes with one Escape, and executes by keyboard")

        for width in (320, 375, 414, 768):
            page.set_viewport_size({"width": width, "height": 900})
            page.wait_for_timeout(100)
            dimensions = page.evaluate("() => ({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth})")
            assert dimensions["scroll"] <= dimensions["client"], f"horizontal overflow at {width}px: {dimensions}"
        results.append("320, 375, 414, and 768 px layouts have no horizontal overflow")

        page.set_viewport_size({"width": 1440, "height": 900})
        page.locator(".reset-control").click()
        page.screenshot(path=str(OUTPUT / "desktop.png"), full_page=True)
        browser.close()

    assert console_errors == [], f"browser console errors: {console_errors}"
    for result in results:
        print(f"PASS · {result}")
    print("PASS · no browser console or page errors")


if __name__ == "__main__":
    main()
