import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output" / "playwright"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL = os.environ.get("HOST_STAND_URL", "http://127.0.0.1:4180")
GROUND_KEYS = [
    "\"ground\"", "zoneNotIn", "quietOrBooth", "adjacentTablesEmptyUntil", "withinDistanceOfParty", "minDistanceFromParty",
    "allTablesSameSection", "capacityAtLeastIfConfirmed", "flexibilityHeldUntil", "seatedBy", "markedRush", "acceptableOutcomes",
    "requiresReason", "markedAllergy", "noVisibleFlag", "reservationPriorityRespected", "sectionZone", "noAllergyParties",
]

AGENT_NIGHT = """
async ({untilMinute, hostEvery}) => {
  const inv = window.hostStandInvokeTool;
  let seatedAI = 0, seatedHost = 0, stale = 0;
  for (let minute = 17 * 60 + 1; minute <= untilMinute; minute += 1) {
    await inv('set_clock', {time: minute, running: false});
    const queue = await inv('get_queue', {});
    const waiting = [...queue.reservations, ...queue.walkIns].filter((p) => p.status === 'waiting' && !p.committedTableId);
    for (const party of waiting) {
      const ranked = await inv('score_assignment', {party_id: party.id});
      const free = ranked.ranked.filter((entry) => entry.availabilityDelay === 0);
      if (!free.length) continue;
      if (hostEvery && (seatedAI + seatedHost) % hostEvery === hostEvery - 1) {
        const row = document.querySelector(`.party-row[data-party-id="${CSS.escape(party.id)}"] .party-select`);
        if (row) {
          row.click();
          document.querySelector(`.table-node[data-table-id="${free[0].tableId}"]`)?.click();
          seatedHost += 1;
          continue;
        }
      }
      const reason = party.request ? `Honors the request: ${free[0].reasons[0]}` : free[0].reasons.slice(0, 2).join('; ');
      const result = await inv('assign_table', {party_id: party.id, table_id: free[0].tableId, reason, expected_version: queue.floorVersion});
      if (result.ok) seatedAI += 1;
      else if (result.error?.code === 'STALE_STATE') {
        stale += 1;
        const retry = await inv('assign_table', {party_id: party.id, table_id: free[0].tableId, reason, expected_version: result.error.currentVersion});
        if (retry.ok) seatedAI += 1;
      }
    }
  }
  return {seatedAI, seatedHost, stale};
}
"""


def clock_minute(label):
    time_text, suffix = label.strip().split()
    hour_text, minute_text = time_text.split(":")
    hour = int(hour_text) % 12 + (12 if suffix == "PM" else 0)
    return hour * 60 + int(minute_text)


def legal_free_table(page, party_id, exclude=()):
    return page.evaluate("""async ({partyId, exclude}) => {
      const floor = await window.hostStandInvokeTool('get_floor', {});
      for (const table of floor.tables) {
        if (table.status !== 'free' || table.locked || exclude.includes(table.id)) continue;
        const score = await window.hostStandInvokeTool('score_assignment', {party_id: partyId, table_id: table.id});
        if (score.legal) return table.id;
      }
      return null;
    }""", {"partyId": party_id, "exclude": list(exclude)})


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
        assert "120 seats · 33 tables" in page.locator(".brand-lockup").inner_text()
        assert page.locator(".party-row").count() >= 8
        party_heights = page.locator(".party-row").evaluate_all("rows => rows.map(row => row.getBoundingClientRect().height)")
        assert max(party_heights) <= 190, party_heights
        clipped_chips = page.evaluate("""() => [...document.querySelectorAll('.party-row .preference-list')].flatMap(list => {
          const bounds = list.getBoundingClientRect();
          return [...list.querySelectorAll('.preference-chip')].filter(chip => chip.getBoundingClientRect().right > bounds.right + 1 || chip.scrollWidth > chip.clientWidth + 1).map(chip => chip.textContent);
        })""")
        assert clipped_chips == [], f"preference chips clipped: {clipped_chips}"
        assert page.locator(".queue-section").count() == 1
        assert page.locator(".queue-section h2").inner_text() == "Upcoming parties"
        assert page.locator(".party-source--reservation").count() >= 8
        floor_contract = page.evaluate("async () => window.hostStandInvokeTool('get_floor', {})")
        assert [directive["type"] for directive in floor_contract["serviceBrief"]["directives"]] == ["section_load", "party_proximity"]
        assert page.locator(".service-brief span").count() >= 2
        assert floor_contract["geometry"]["entrance"] == {"column": 1, "row": 1}
        assert all("layout" in table and "distanceToEntrance" in table for table in floor_contract["tables"])
        assert page.locator(".mode-indicator").inner_text().strip() == "Manual host"
        assert page.locator(".mcp-status--strip").inner_text().strip() == "WebMCP: 22 tools · not in this browser"
        assert page.locator('[data-action="toggle-agent"]').count() == 0
        product_text = page.locator(".product-bar").inner_text().lower()
        assert "basic algo" not in product_text
        source_key_text = " ".join(page.locator(".queue-source-key").inner_text().split())
        assert "Reservation first" in source_key_text, source_key_text
        assert "Walk-in after" in source_key_text, source_key_text
        results.append("a fresh run is Manual host with two modes, a visible WebMCP chip, and no algo copy")

        queue_contract = page.evaluate("async () => window.hostStandInvokeTool('get_queue', {})")
        assert 8 <= len(queue_contract["openRequests"]) <= 10
        assert all(request["status"] == "open" for request in queue_contract["openRequests"])
        # Walk-in requests appear at arrival, so only reservation requests are visible at 5 PM.
        reservation_requests = sum(1 for request in queue_contract["openRequests"] if request["scope"] == "party" and any(party["id"] == request["partyId"] for party in queue_contract["reservations"]))
        assert page.locator(".request-note").count() == reservation_requests, (page.locator(".request-note").count(), reservation_requests)
        assert reservation_requests >= 3
        assert page.locator(".request-badge").first.inner_text() in ("REQUEST", "NOTE")
        dom = page.evaluate("() => document.body.innerHTML")
        for key in GROUND_KEYS:
            assert key not in dom, f"hidden ground truth leaked into the DOM: {key}"
        serialized = page.evaluate("async () => JSON.stringify([await window.hostStandInvokeTool('get_floor', {}), await window.hostStandInvokeTool('get_queue', {})])")
        for key in GROUND_KEYS:
            assert key not in serialized, f"hidden ground truth leaked into a tool result: {key}"
        results.append("special requests show as REQUEST/NOTE badges and hidden ground truth never reaches the DOM or a tool result")

        viewport_fit = page.evaluate("() => ({pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight, floorHeight: document.querySelector('.floor-map').getBoundingClientRect().height, tableHeight: document.querySelector('[data-table-id=\"V1\"]').getBoundingClientRect().height})")
        assert viewport_fit["pageHeight"] <= viewport_fit["viewportHeight"], viewport_fit
        assert viewport_fit["floorHeight"] <= 482, viewport_fit
        assert viewport_fit["tableHeight"] <= 52, viewport_fit
        results.append("randomized floor fits 33 compact table units and one mixed-source queue without page scroll")

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
        assert len(second_run) == 8
        assert second_roster != first_roster
        assert page.locator(".clock-readout time").inner_text() == "5:00 PM"
        assert "New random run" in page.locator(".toast").inner_text()
        assert page.evaluate("() => new URLSearchParams(location.search).get('run')") == second_run
        page.locator(".simulation-console__toggle").click()
        page.locator('[data-form="load-run"] input').fill("demoaaft")
        page.locator('[data-form="load-run"] button[type=submit]').click()
        assert page.evaluate("async () => (await window.hostStandInvokeTool('get_floor', {})).runCode") == "DEMOAAFT"
        assert "Run DEMOAAFT loaded" in page.locator(".toast").inner_text()
        demo_requests = page.evaluate("async () => (await window.hostStandInvokeTool('get_queue', {})).openRequests.length")
        assert demo_requests == 10, demo_requests
        page.locator(".simulation-console__toggle").click()
        page.locator(".reset-control").click()
        results.append("New run produces a different paused service, and a run code reloads the exact demo night")

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

        # Manual host: a real arrival is seated by drag-and-drop with HOST provenance.
        waiting_party = page.locator('.party-row[draggable="true"]').first
        for _ in range(12):
            if waiting_party.count() == 1:
                break
            page.get_by_label("Jump to next event").click()
        assert waiting_party.count() == 1, "manual mode never surfaced a waiting party after 12 service events"
        assert page.locator('.party-row[data-host-action="plan"]').count() == 0, "manual mode must not expose upcoming reservations as plan targets"
        waiting_name = waiting_party.locator(".party-name").inner_text()
        waiting_party_id = waiting_party.get_attribute("data-party-id")
        legal_table_id = legal_free_table(page, waiting_party_id)
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

        # Attach an agent: the header flips, upcoming reservations become override targets.
        page.locator(".agent-connect-control").click()
        assert "Attach through WebMCP" in page.locator(".agent-connect-panel").inner_text()
        assert "No API key needed" in page.locator(".agent-connect-panel").inner_text()
        guide_text = page.locator(".controller-mode-guide").inner_text()
        assert "Manual host" in guide_text and "Agent" in guide_text and "Basic algo" not in guide_text
        attached = page.evaluate("async () => window.hostStandInvokeTool('attach_agent', {agent_name: 'WebMCP Agent', mode: 'autonomous'})")
        assert attached["ok"] is True
        assert "expected_version" in attached["concurrency"]
        assert page.locator(".mode-indicator").inner_text().strip() == "Agent: WebMCP Agent"
        assert "WebMCP Agent" in page.locator(".product-bar").inner_text()
        assert "WebMCP Agent is attached" in page.locator(".agent-connect-panel").inner_text()
        page.locator('[data-action="close-agent-panel"]').click()

        planned_party = page.locator('.party-row[data-host-action="plan"]').first
        assert planned_party.count() == 1, "agent mode did not expose an upcoming reservation as a host override target"
        planned_party_id = planned_party.get_attribute("data-party-id")
        drag_plan_table = legal_free_table(page, planned_party_id)
        assert drag_plan_table is not None
        planned_party.drag_to(page.locator(f'.table-node[data-table-id="{drag_plan_table}"]'))
        planned_party = page.locator(f'.party-row[data-party-id="{planned_party_id}"]')
        host_chip = planned_party.locator(".candidate-button.is-host-override")
        assert drag_plan_table in host_chip.inner_text() and "HOST" in host_chip.inner_text()
        assert "Host override active" in page.locator(".inspector").inner_text()

        second_planned_party = page.locator('.party-row[data-host-action="plan"]:not(.has-host-override)').first
        assert second_planned_party.count() == 1
        second_planned_party_id = second_planned_party.get_attribute("data-party-id")
        click_plan_table = legal_free_table(page, second_planned_party_id, exclude=(drag_plan_table,))
        assert click_plan_table is not None
        second_planned_party.locator(".party-select").click()
        page.locator(f'.table-node[data-table-id="{click_plan_table}"]').click()
        second_host_chip = page.locator(f'.party-row[data-party-id="{second_planned_party_id}"] .candidate-button.is-host-override')
        assert click_plan_table in second_host_chip.inner_text() and "HOST" in second_host_chip.inner_text()
        results.append("with an agent attached, host overrides work by drag-and-drop and by selecting a party then a table")

        # The agent seats a party with a reason, then proposes plans the host can accept or reject.
        assignment = page.evaluate("""async () => {
          const queue = await window.hostStandInvokeTool('get_queue', {});
          const floor = await window.hostStandInvokeTool('get_floor', {});
          for (const party of queue.reservations.filter(candidate => candidate.size <= 2 && candidate.status === 'upcoming' && !candidate.hostOverrideTableId)) {
            await window.hostStandInvokeTool('mark_party', {party_id: party.id, status: 'arrived'});
            for (const table of floor.tables.filter(candidate => candidate.seats === 2 && candidate.status === 'free')) {
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
        assert assignment["assigned"]["floorVersion"] > 0
        assert assignment["partyName"] in page.locator(f'.table-node[data-table-id="{assignment["tableId"]}"]').inner_text()
        expected_finish = page.evaluate("""async tableId => {
          const floor = await window.hostStandInvokeTool('get_floor', {});
          const table = floor.tables.find(item => item.id === tableId);
          return {minute: floor.minute, expectedFinishAt: table.expectedFinishAt};
        }""", assignment["tableId"])
        assert expected_finish["expectedFinishAt"] == expected_finish["minute"] + 90
        small_table = page.locator(f'.table-node[data-table-id="{assignment["tableId"]}"]')
        assert small_table.locator(".table-provenance").inner_text() == "AI"
        assert "WebMCP Agent" in small_table.locator(".table-provenance").get_attribute("title")
        assert "Right-sized table" in small_table.locator(".table-provenance").get_attribute("title")

        proposals = page.evaluate("""async () => {
          const queue = await window.hostStandInvokeTool('get_queue', {});
          const picked = [];
          for (const party of queue.reservations.filter(candidate => candidate.status === 'upcoming' && !candidate.hostOverrideTableId)) {
            const ranked = await window.hostStandInvokeTool('score_assignment', {party_id: party.id});
            const free = ranked.ranked.filter(entry => entry.availabilityDelay === 0 && !picked.some(item => item.tableId === entry.tableId));
            if (!free.length) continue;
            const plan = await window.hostStandInvokeTool('set_candidates', {party_id: party.id, table_ids: [free[0].tableId], reason: `Honors the request: ${free[0].reasons[0]}`});
            if (plan.ok) picked.push({partyId: party.id, tableId: free[0].tableId});
            if (picked.length === 2) break;
          }
          return picked;
        }""")
        assert len(proposals) == 2, proposals
        accept_row = page.locator(f'.party-row[data-party-id="{proposals[0]["partyId"]}"]')
        reject_row = page.locator(f'.party-row[data-party-id="{proposals[1]["partyId"]}"]')
        assert accept_row.locator('[data-action="accept-plan"]').count() == 1
        assert reject_row.locator('[data-action="reject-plan"]').count() == 1
        dismiss_feedback = page.locator('[data-action="dismiss-feedback"]')
        if dismiss_feedback.count():
            dismiss_feedback.click()
        # Let the assignment-flight animation finish and bring a request card into view for the README hero.
        page.wait_for_timeout(700)
        page.evaluate("""() => {
          const rail = document.querySelector('.queue-rail');
          const card = [...rail.querySelectorAll('.party-row')].find(row => row.querySelector('.request-note'));
          if (card) rail.scrollTop = Math.max(0, card.offsetTop - rail.offsetTop - 8);
        }""")
        page.wait_for_timeout(100)
        page.screenshot(path=str(OUTPUT / "external-ai-assignment.png"), full_page=True)
        results.append("external AI assignments show the named agent and its reason on the floor, and its plans carry Accept and Reject")

        accept_row.locator('[data-action="accept-plan"]').click()
        assert "AI ✓ accepted" in page.locator(f'.party-row[data-party-id="{proposals[0]["partyId"]}"] .candidate-list__label').inner_text()
        reject_row.locator('[data-action="reject-plan"]').click()
        page.locator('[data-form="reject-plan"] input').fill("Keep that table for the owner's guests.")
        page.locator('[data-form="reject-plan"] button[type=submit]').click()
        retry = page.evaluate("""async ({partyId, tableId}) => window.hostStandInvokeTool('set_candidates', {party_id: partyId, table_ids: [tableId], reason: 'Again.'})""", proposals[1])
        assert retry["ok"] is False and retry["error"]["code"] == "INVALID_INPUT"
        assert "Keep that table for the owner's guests." in retry["error"]["message"]
        decisions = page.evaluate("async () => (await window.hostStandInvokeTool('get_floor', {})).recentHostDecisions")
        assert [decision["action"] for decision in decisions[-2:]] == ["accepted", "rejected"]
        results.append("the host accepts one agent plan (AI ✓) and rejects another with a reason the agent cannot re-propose")

        # A stale agent write after a host change is rejected and shown in the ledger.
        stale = page.evaluate("""async () => {
          const before = await window.hostStandInvokeTool('get_queue', {});
          const queue = before;
          const party = [...queue.reservations, ...queue.walkIns].find(candidate => candidate.status === 'waiting' && !candidate.committedTableId);
          if (!party) return {skipped: true};
          const floor = await window.hostStandInvokeTool('get_floor', {});
          let tableId = null;
          for (const table of floor.tables) {
            if (table.status !== 'free' || table.locked) continue;
            const score = await window.hostStandInvokeTool('score_assignment', {party_id: party.id, table_id: table.id});
            if (score.legal) { tableId = table.id; break; }
          }
          if (!tableId) return {skipped: true};
          await window.hostStandInvokeTool('lock_table', {table_id: 'P2', reason: 'Host photo setup'});
          const result = await window.hostStandInvokeTool('assign_table', {party_id: party.id, table_id: tableId, reason: 'Stale.', expected_version: before.floorVersion});
          return {code: result.error?.code, changes: result.error?.changes?.length, ledger: document.querySelector('.activity-ledger li.is-rejected')?.innerText};
        }""")
        if not stale.get("skipped"):
            assert stale["code"] == "STALE_STATE", stale
            assert stale["changes"] == 1
            assert "Agent write rejected" in stale["ledger"]
            results.append("a stale agent write after a floor change is rejected with the diff and shown in the ledger")

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

        # A full mixed night: the attached agent seats most parties, the host drags every fifth.
        page.locator(".reset-control").click()
        assert page.locator(".mode-indicator").inner_text().strip() == "Agent: WebMCP Agent"
        night = page.evaluate(AGENT_NIGHT, {"untilMinute": 22 * 60, "hostEvery": 5})
        assert night["seatedAI"] >= 40 and night["seatedHost"] >= 8, night
        recap_dialog = page.locator("#service-recap")
        assert recap_dialog.evaluate("dialog => dialog.open") is True
        recap_text = recap_dialog.inner_text()
        assert "Host vs. Agent" in recap_text
        assert "special requests satisfied" in recap_text
        assert "Reservation priority violations: 0" in recap_text
        assert "transparent demo metric, not an OpenAI judging score" in recap_text
        assert "Basic algo" not in recap_text
        assert recap_dialog.locator(".recap-compare__headline").count() == 1
        assert "Special requests satisfied" in recap_dialog.locator(".recap-compare__headline").inner_text()
        assert recap_dialog.locator(".recap-compare tbody tr").count() == 6
        assert recap_dialog.locator(".recap-requests li").count() >= 8
        assert recap_dialog.locator(".recap-requests .recap-owner").count() >= 8
        assert recap_dialog.locator(".recap-components > div").count() == 5
        recap_contract = page.evaluate("async () => (await window.hostStandInvokeTool('get_floor', {})).serviceRecap")
        assert recap_contract["official"] is False
        assert 0 <= recap_contract["score"] <= 100
        assert recap_contract["reservationPriorityViolations"] == 0
        assert recap_contract["comparison"]["host"]["decisions"] >= 8
        assert recap_contract["comparison"]["agent"]["decisions"] >= 40
        assert recap_contract["comparison"]["agent"]["present"] is True
        assert recap_contract["requests"]["total"] >= 8
        assert recap_contract["partiesServed"] >= 60
        assert {origin["kind"] for origin in recap_contract["provenance"]} == {"host", "external"}
        recap_serialized = page.evaluate("async () => JSON.stringify((await window.hostStandInvokeTool('get_floor', {})).serviceRecap)")
        for key in GROUND_KEYS:
            assert key not in recap_serialized, f"recap leaked {key}"
        recap_dialog.evaluate("dialog => dialog.scrollTop = 0")
        page.screenshot(path=str(OUTPUT / "service-recap.png"), full_page=True)
        recap_dialog.get_by_role("button", name="Return to floor").click()
        page.wait_for_function("() => !document.querySelector('#service-recap').open")
        assert recap_dialog.evaluate("dialog => dialog.open") is False
        results.append("10 PM opens the Host vs. Agent scorecard with special requests as the headline, every request outcome, and a zero-violation guard line")

        # Manual-only recap shows the agent column as absent.
        detached = page.evaluate("async () => window.hostStandInvokeTool('detach_agent', {})")
        assert detached["ok"] is True
        page.locator(".reset-control").click()
        assert page.locator(".mode-indicator").inner_text().strip() == "Manual host"
        page.evaluate("async () => window.hostStandInvokeTool('set_clock', {time: '10:00 PM', running: false})")
        assert recap_dialog.evaluate("dialog => dialog.open") is True
        assert "No agent attached" in recap_dialog.inner_text()
        recap_dialog.get_by_role("button", name="Return to floor").click()
        page.wait_for_function("() => !document.querySelector('#service-recap').open")
        results.append("a manual-only night shows the host column with No agent attached in the agent column")

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
