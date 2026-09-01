import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output" / "playwright"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL = os.environ.get("HOST_STAND_URL", "http://127.0.0.1:4180")


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
        assert page.locator(".table-node").count() == 33
        assert "120 seats · 33 table units" in page.locator(".brand-lockup").inner_text()
        assert page.locator(".party-row").count() >= 8
        party_heights = page.locator(".party-row").evaluate_all("rows => rows.map(row => row.getBoundingClientRect().height)")
        assert max(party_heights) <= 100, party_heights
        assert page.locator(".queue-section").count() == 1
        assert page.locator(".queue-section h2").inner_text() == "Upcoming parties"
        assert page.locator(".party-source--reservation").count() >= 8
        floor_contract = page.evaluate("async () => window.hostStandInvokeTool('get_floor', {})")
        assert [directive["type"] for directive in floor_contract["serviceBrief"]["directives"]] == ["section_load", "party_proximity"]
        assert page.locator(".service-brief span").count() == 2
        assert "local algorithm" in page.locator(".product-bar").inner_text().lower()
        source_key_text = " ".join(page.locator(".queue-source-key").inner_text().split())
        assert "Reservation first" in source_key_text, source_key_text
        assert "Walk-in after" in source_key_text, source_key_text
        viewport_fit = page.evaluate("() => ({pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight, floorHeight: document.querySelector('.floor-map').getBoundingClientRect().height, tableHeight: document.querySelector('[data-table-id=\"V1\"]').getBoundingClientRect().height})")
        assert viewport_fit["pageHeight"] <= viewport_fit["viewportHeight"], viewport_fit
        assert viewport_fit["floorHeight"] <= 482, viewport_fit
        assert viewport_fit["tableHeight"] <= 52, viewport_fit
        results.append("randomized floor fits 33 compact table units and one mixed-source queue without page scroll")
        results.append("the visible service brief contains only measurable table-allocation constraints")

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
            collisions = page.evaluate("""() => {
              const tables = [...document.querySelectorAll('.table-node')].map(table => ({
                id: table.dataset.tableId,
                rect: table.getBoundingClientRect()
              }));
              return tables.flatMap((left, index) => tables.slice(index + 1).flatMap(right => {
                const overlapX = Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left);
                const overlapY = Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top);
                return overlapX > 1 && overlapY > 1 ? [`${left.id}/${right.id}`] : [];
              }));
            }""")
            assert collisions == [], f"table overlap at {width}x{height}: {collisions}"
        results.append("1024x768, 1280x800, and 1440x900 desktop layouts fit without page scroll")
        results.append("all 33 table units remain clear of every neighboring table at each desktop test size")
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
        assert page.locator(".clock-readout time").inner_text() == "5:00 PM"
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

        planned_party = page.locator('.party-row[data-host-action="plan"]').first
        assert planned_party.count() == 1, "agent mode did not expose an upcoming reservation as a host override target"
        planned_party_id = planned_party.get_attribute("data-party-id")
        drag_plan_table = page.evaluate("""async partyId => {
          const floor = await window.hostStandInvokeTool('get_floor', {});
          for (const table of floor.tables) {
            if (table.status !== 'free' || table.locked) continue;
            const score = await window.hostStandInvokeTool('score_assignment', {party_id: partyId, table_id: table.id});
            if (score.legal) return table.id;
          }
          return null;
        }""", planned_party_id)
        assert drag_plan_table is not None
        planned_party.drag_to(page.locator(f'.table-node[data-table-id="{drag_plan_table}"]'))
        planned_party = page.locator(f'.party-row[data-party-id="{planned_party_id}"]')
        host_chip = planned_party.locator(".candidate-button.is-host-override")
        assert drag_plan_table in host_chip.inner_text() and "HOST" in host_chip.inner_text()
        assert "Host override active" in page.locator(".inspector").inner_text()

        second_planned_party = page.locator('.party-row[data-host-action="plan"]:not(.has-host-override)').first
        assert second_planned_party.count() == 1
        second_planned_party_id = second_planned_party.get_attribute("data-party-id")
        click_plan_table = page.evaluate("""async partyId => {
          const floor = await window.hostStandInvokeTool('get_floor', {});
          for (const table of floor.tables) {
            const score = await window.hostStandInvokeTool('score_assignment', {party_id: partyId, table_id: table.id});
            if (score.legal) return table.id;
          }
          return null;
        }""", second_planned_party_id)
        assert click_plan_table is not None
        second_planned_party.locator(".party-select").click()
        page.locator(f'.table-node[data-table-id="{click_plan_table}"]').click()
        second_host_chip = page.locator(f'.party-row[data-party-id="{second_planned_party_id}"] .candidate-button.is-host-override')
        assert click_plan_table in second_host_chip.inner_text() and "HOST" in second_host_chip.inner_text()
        assert page.locator('[data-action="toggle-agent"]').get_attribute("aria-checked") == "true"
        results.append("agent-on host overrides work by drag-and-drop and by selecting a party then a table")

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
            if (table.status !== 'free' || table.locked) continue;
            const score = await window.hostStandInvokeTool('score_assignment', {party_id: partyId, table_id: table.id});
            if (score.legal) return table.id;
          }
          return null;
        }""", waiting_party_id)
        assert legal_table_id is not None
        legal_table = page.locator(f'.table-node[data-table-id="{legal_table_id}"]')
        for _ in range(2):
            page.locator(f'.party-row[data-party-id="{waiting_party_id}"]').drag_to(legal_table, force=True)
            if waiting_name in legal_table.inner_text():
                break
            page.wait_for_timeout(50)
        assert waiting_name in legal_table.inner_text()
        assert legal_table.locator(".table-provenance").inner_text() == "HOST"
        assert "Manual host override" in legal_table.locator(".table-provenance").get_attribute("title")
        page.screenshot(path=str(OUTPUT / "manual-host-override.png"), full_page=True)
        results.append("manual mode waits for a real arrival and seats it through drag-and-drop")
        results.append("manual overrides remain visibly attributed on the assigned table")

        page.locator(".reset-control").click()
        page.locator('[data-action="open-agent-panel"]').click()
        assert "Attach through WebMCP" in page.locator(".agent-connect-panel").inner_text()
        assert "No API key is needed" in page.locator(".agent-connect-panel").inner_text()
        assert "Manual host" in page.locator(".controller-mode-guide").inner_text()
        assert "Local algorithm" in page.locator(".controller-mode-guide").inner_text()
        assert "External AI" in page.locator(".controller-mode-guide").inner_text()
        attached = page.evaluate("async () => window.hostStandInvokeTool('attach_agent', {agent_name: 'WebMCP Agent', mode: 'autonomous'})")
        assert attached["ok"] is True
        assert "WebMCP Agent is attached" in page.locator(".agent-connect-panel").inner_text()

        assignment = page.evaluate("""async () => {
          const queue = await window.hostStandInvokeTool('get_queue', {});
          const floor = await window.hostStandInvokeTool('get_floor', {});
          for (const party of queue.reservations.filter(candidate => candidate.size <= 2)) {
            await window.hostStandInvokeTool('mark_party', {party_id: party.id, status: 'arrived'});
            for (const table of floor.tables.filter(candidate => candidate.seats === 2)) {
              const score = await window.hostStandInvokeTool('score_assignment', {party_id: party.id, table_id: table.id});
              if (!score.legal) continue;
              await window.hostStandInvokeTool('set_candidates', {party_id: party.id, table_ids: [table.id], reason: 'Right-sized table with no reservation conflict.'});
              const assigned = await window.hostStandInvokeTool('assign_table', {party_id: party.id, table_id: table.id, reason: 'Right-sized table with no reservation conflict.'});
              return {partyId: party.id, partyName: party.name, tableId: table.id, assigned};
            }
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
        page.set_viewport_size({"width": 1024, "height": 768})
        page.wait_for_timeout(50)
        small_table = page.locator(f'.table-node[data-table-id="{assignment["tableId"]}"]')
        finish_status = small_table.locator(".table-status--due")
        finish_fit = finish_status.evaluate("""status => {
          const statusRect = status.getBoundingClientRect();
          const tableRect = status.closest('.table-node').getBoundingClientRect();
          return {
            clientWidth: status.clientWidth,
            scrollWidth: status.scrollWidth,
            insideTable: statusRect.left >= tableRect.left && statusRect.right <= tableRect.right
          };
        }""")
        assert finish_status.inner_text().strip().count(":") == 1
        assert finish_fit["scrollWidth"] <= finish_fit["clientWidth"], finish_fit
        assert finish_fit["insideTable"] is True, finish_fit
        assert "Expected finish" in small_table.get_attribute("aria-label")
        assert small_table.locator(".table-provenance").inner_text() == "AI"
        assert "WebMCP Agent" in small_table.locator(".table-provenance").get_attribute("title")
        assert "Right-sized table" in small_table.locator(".table-provenance").get_attribute("title")
        dismiss_feedback = page.locator('[data-action="dismiss-feedback"]')
        if dismiss_feedback.count():
            dismiss_feedback.click()
        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_timeout(50)
        page.screenshot(path=str(OUTPUT / "external-ai-assignment.png"), full_page=True)
        results.append("a seated 2-top keeps its full 90-minute expected finish visible without truncation")
        results.append("external AI assignments show the named agent and its reason on the floor")

        dirty_lifecycle = page.evaluate("""async ({partyId, tableId}) => {
          const left = await window.hostStandInvokeTool('mark_party', {party_id: partyId, status: 'left'});
          const dirty = await window.hostStandInvokeTool('get_floor', {});
          const dirtyTable = dirty.tables.find(table => table.id === tableId);
          const dirtyText = document.querySelector(`.table-node[data-table-id="${CSS.escape(tableId)}"] .table-status--dirty`)?.textContent.trim();
          await window.hostStandInvokeTool('set_clock', {time: dirtyTable.dirtyUntil - 1, running: false});
          const beforeReady = await window.hostStandInvokeTool('get_floor', {});
          const beforeReadyText = document.querySelector(`.table-node[data-table-id="${CSS.escape(tableId)}"] .table-status--dirty`)?.textContent.trim();
          await window.hostStandInvokeTool('set_clock', {time: dirtyTable.dirtyUntil, running: false});
          const ready = await window.hostStandInvokeTool('get_floor', {});
          return {
            left,
            dirtyMinute: dirty.minute,
            dirtyTable,
            dirtyText,
            beforeReady: beforeReady.tables.find(table => table.id === tableId),
            beforeReadyText,
            ready: ready.tables.find(table => table.id === tableId)
          };
        }""", {"partyId": assignment["partyId"], "tableId": assignment["tableId"]})
        assert dirty_lifecycle["left"]["ok"] is True
        assert dirty_lifecycle["dirtyTable"]["status"] == "dirty"
        assert dirty_lifecycle["dirtyTable"]["dirtyUntil"] == dirty_lifecycle["dirtyMinute"] + 3
        assert dirty_lifecycle["dirtyText"] == "Dirty 3m"
        assert dirty_lifecycle["beforeReady"]["status"] == "dirty"
        assert dirty_lifecycle["beforeReadyText"] == "Dirty 1m"
        assert dirty_lifecycle["ready"]["status"] == "free"
        results.append("party departure starts a visible three-minute dirty state, then the table becomes ready")

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

        page.locator(".reset-control").click()
        detached = page.evaluate("async () => window.hostStandInvokeTool('detach_agent', {})")
        assert detached["ok"] is True
        close_agent_panel = page.locator('[data-action="close-agent-panel"]')
        if close_agent_panel.count():
            close_agent_panel.click()
        if page.locator('[data-action="toggle-agent"]').get_attribute("aria-checked") == "false":
            page.locator('[data-action="toggle-agent"]').click()
        assert "local algorithm" in page.locator(".product-bar").inner_text().lower()
        page.evaluate("async () => window.hostStandInvokeTool('set_clock', {time: '10:00 PM', running: false})")
        recap_dialog = page.locator("#service-recap")
        assert recap_dialog.evaluate("dialog => dialog.open") is True
        assert "How the floor performed" in recap_dialog.inner_text()
        assert "same-night local baseline" in recap_dialog.inner_text()
        assert recap_dialog.locator(".recap-components > div").count() == 5
        assert recap_dialog.locator(".recap-details section").count() == 2
        recap_contract = page.evaluate("async () => (await window.hostStandInvokeTool('get_floor', {})).serviceRecap")
        assert recap_contract["official"] is False
        assert 0 <= recap_contract["score"] <= 100
        assert len(recap_contract["briefResults"]) == 2
        assert recap_contract["partiesServed"] >= 60
        assert any(origin["kind"] == "local" for origin in recap_contract["provenance"])
        page.screenshot(path=str(OUTPUT / "service-recap.png"), full_page=True)
        recap_dialog.get_by_role("button", name="Return to floor").click()
        page.wait_for_function("() => !document.querySelector('#service-recap').open")
        assert recap_dialog.evaluate("dialog => dialog.open") is False
        results.append("10 PM opens a transparent scorecard with local-baseline comparison, provenance, and brief adherence")

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
