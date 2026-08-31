from pathlib import Path

from playwright.sync_api import sync_playwright


# Regression: ISSUE-001 — command search left non-matching actions visible
# Regression: ISSUE-002 — one Escape did not close a populated search dialog
# Found by /qa on 2026-08-30
# Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-08-30.md

ROOT = Path(__file__).resolve().parents[2]
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL = "http://127.0.0.1:4180"


def main():
    console_errors = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: console_errors.append(str(error)))

        page.goto(URL, wait_until="domcontentloaded")
        page.locator(".command-trigger").click()
        page.locator("#command-search").fill("busy")

        visible_actions = page.locator("[data-palette-action]:visible")
        assert visible_actions.count() == 1
        assert "Busy Saturday" in visible_actions.first.inner_text()

        page.keyboard.press("Escape")
        assert page.locator("#command-dialog").evaluate("dialog => dialog.open") is False
        assert page.locator("#command-dialog").is_visible() is False

        browser.close()

    assert console_errors == [], f"browser console errors: {console_errors}"
    print("PASS · command search shows only matching actions")
    print("PASS · one Escape closes a populated command search")
    print("PASS · no browser console or page errors")


if __name__ == "__main__":
    main()
