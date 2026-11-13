#!/usr/bin/env python3
"""Export a project by driving the Shorts UI in headless Firefox (export is browser-assisted:
the page renders captions/text to PNG frames, the server composes).

Usage: export.py PROJECT_ID [--port 7378] [--shot DIR] [--timeout SECONDS (default 3600)]
Waits for any other ffmpeg first (one heavy job at a time; you may be exporting in the app).
Prints the export time. Output lands in the instance's export_dir as "<name>.mp4".
"""
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

pid = sys.argv[1]
port = sys.argv[sys.argv.index("--port") + 1] if "--port" in sys.argv else "7378"
shot = sys.argv[sys.argv.index("--shot") + 1] if "--shot" in sys.argv else None


def wait(pg, s):  # keep poking the page: headless Firefox stalls callbacks otherwise
    for _ in range(int(s * 5)):
        pg.evaluate("1")
        time.sleep(0.2)


def until(pg, js, timeout=900):
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(js):
            return
        time.sleep(0.25)
    if shot:
        pg.screenshot(path=f"{shot}/export-failed.png")
    raise SystemExit("timeout waiting for: " + js)


def launch_firefox(p):
    """Playwright's own Firefox; if this Playwright wants a build that isn't downloaded
    (after a pip upgrade, before `playwright install firefox`), the newest one that is."""
    try:
        return p.firefox.launch()
    except Exception as err:
        root = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or Path.home() / ".cache/ms-playwright")
        found = sorted(root.glob("firefox-*/firefox/firefox"), key=lambda x: int(x.parent.parent.name.split("-")[1]))
        if not found:
            raise SystemExit(f"{err}\nRun: playwright install firefox")
        print(f"Playwright's Firefox build is missing, using {found[-1].parent.parent.name} (run `playwright install firefox` to fix)", flush=True)
        return p.firefox.launch(executable_path=str(found[-1]))


with sync_playwright() as p:
    b = launch_firefox(p)
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(f"http://127.0.0.1:{port}/#/p/{pid}")
    pg.wait_for_selector(".tl-clip", timeout=60000)
    until(pg, "!!document.querySelector('.tl-film')", 120)
    wait(pg, 3)
    if shot:
        pg.screenshot(path=f"{shot}/editor.png")
    while subprocess.run(["pgrep", "-x", "ffmpeg"], capture_output=True).returncode == 0:
        print("waiting for another ffmpeg to finish", flush=True)
        wait(pg, 5)
    pg.locator("header button:has-text('Export')").click()
    wait(pg, 1.5)
    pg.locator("[role=dialog] button:has-text('Export')").click()
    t0 = time.time()
    # long videos: the final pass of a 6-minute 1080p edit takes ~20 min on a laptop CPU/iGPU
    until(pg, "document.body.innerText.includes('Ready to post')", timeout=int(sys.argv[sys.argv.index("--timeout") + 1]) if "--timeout" in sys.argv else 3600)
    print(f"exported in {time.time() - t0:.0f}s; page errors: {errs}")
    b.close()
