"""Drive the editor through the demo flow with Playwright and record it (run by record.sh).
Writes WORKDIR/marks.json: the raw video path and timestamps that edit.py uses."""
import time, json, sys
from playwright.sync_api import sync_playwright
D = sys.argv[1]; URL = "http://127.0.0.1:7378/"
W, H = 1440, 900
CURSOR = """
addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:18px;height:18px;margin:-3px 0 0 -3px;pointer-events:none;transition:transform .08s';
  c.innerHTML = '<svg width="18" height="22" viewBox="0 0 18 22"><path d="M2 2v16l4.5-4 3 6.5 2.5-1.2-3-6.3H15z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  document.body.appendChild(c);
  addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
  addEventListener('mousedown', () => c.style.transform = 'scale(.85)', true);
  addEventListener('mouseup', () => c.style.transform = '', true);
});"""
marks = []; T0 = None
def mark(name): marks.append((name, round(time.monotonic() - T0, 2))); print(name, marks[-1][1], flush=True)
def wait(pg, s):
    for _ in range(int(s * 5)): pg.evaluate("1"); time.sleep(0.2)
def until(pg, js, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(js): return True
        time.sleep(0.25)
    raise SystemExit("timeout: " + js)
pos = [W / 2, H / 2]
def go(pg, loc, click=True, pause=0.35):
    try:
        loc.wait_for(state="visible", timeout=60000)
    except Exception:
        pg.screenshot(path=D + "/failed.png")
        raise
    b = loc.bounding_box(); x, y = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    pg.mouse.move(x, y, steps=18); pos[:] = [x, y]; wait(pg, pause)
    if click: pg.mouse.click(x, y); wait(pg, 0.3)
with sync_playwright() as p:
    b = p.firefox.launch()
    ctx = b.new_context(viewport={"width": W, "height": H}, record_video_dir=D + "/rec", record_video_size={"width": W, "height": H})
    ctx.add_init_script(CURSOR)
    pg = ctx.new_page(); T0 = time.monotonic()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL); pg.evaluate("localStorage.setItem('shorts.theme','light')"); pg.reload()
    pg.mouse.move(W / 2, H / 2); wait(pg, 1); mark("home"); wait(pg, 2)
    go(pg, pg.locator("button[title*='My first short']").first)
    pg.wait_for_selector(".tl-clip", timeout=60000); mark("opening")
    until(pg, "!!document.querySelector('.tl-film')"); wait(pg, 1); mark("editor")
    go(pg, pg.locator("footer button:has-text('Auto captions')")); mark("transcribing")
    until(pg, "![...document.querySelectorAll('button')].some(b => b.textContent.includes('Transcribing'))"); wait(pg, 1.5); mark("captions")
    go(pg, pg.locator("footer button:has-text('Cut retakes')")); wait(pg, 2); mark("retakes")
    go(pg, pg.locator("footer button:has-text('Remove silences')")); wait(pg, 2); mark("silences")
    go(pg, pg.locator("nav button:has-text('Captions')")); wait(pg, 0.8)
    presets = pg.locator("aside button[title]:has(canvas)")
    go(pg, presets.nth(3)); wait(pg, 1.2); go(pg, presets.nth(1)); wait(pg, 1.5); mark("styles")
    go(pg, pg.locator("nav button:has-text('Transcript')")); wait(pg, 1)
    go(pg, pg.locator(".w", has_text="entirely").first); wait(pg, 0.5)
    pg.keyboard.press("Delete"); wait(pg, 1.5); mark("transcript")
    pg.keyboard.press("Escape"); pg.keyboard.press("Home"); wait(pg, 0.5)
    play = pg.locator("section button.rounded-full").first
    go(pg, play); mark("play"); wait(pg, 9); pg.keyboard.press("Space"); mark("played")
    while pg.evaluate("1") and __import__("subprocess").run(["pgrep", "-x", "ffmpeg"], capture_output=True).returncode == 0:
        time.sleep(2)  # don't render at the same time as the real app
    go(pg, pg.locator("header button:has-text('Export')")); wait(pg, 1.2)
    go(pg, pg.locator("[role=dialog] button:has-text('Export')")); mark("exporting")
    until(pg, "document.body.innerText.includes('Ready to post')", 400); mark("done"); wait(pg, 5); mark("end")
    # stills for the README: the finished edit in light and dark
    go(pg, pg.locator("[role=dialog] button:has-text('Done')")); wait(pg, 1)
    pg.keyboard.press("Home"); pg.mouse.move(W - 5, H - 5); wait(pg, 1.5)
    pg.screenshot(path=D + "/shot-light.png")
    pg.evaluate("localStorage.setItem('shorts.theme','dark')"); pg.reload()
    pg.wait_for_selector(".tl-clip", timeout=60000); until(pg, "!!document.querySelector('.tl-film')"); wait(pg, 2)
    pg.mouse.move(W - 5, H - 5); wait(pg, 0.5)
    pg.screenshot(path=D + "/shot-dark.png")
    print("errors:", errs)
    vid = pg.video; mark("close"); ctx.close(); b.close()
    json.dump({"video": vid.path(), "marks": marks}, open(D + "/marks.json", "w"))
