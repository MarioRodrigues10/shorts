#!/usr/bin/env python3
"""Check explainer graphics before an export (system python3 + Pillow). Rules: ../references/motion-design.md

  uicheck.py A.png B.png ...                 check these PNGs
  uicheck.py --project <projects2/ID.json>   check every image overlay in a project

Flags per image:
  palette   more than one accent hue among saturated pixels (rainbow categories), red/green excepted
  edge      opaque content touching the PNG border (cut-off text, a pill on the border, no shadow room)
  small     the image is so small on the canvas that its text will be unreadable on a phone
Writes uicheck.png in the working folder: every graphic at phone size on a grey frame.
Exit code 1 if anything is flagged.
"""
import colorsys
import json
import sys
from pathlib import Path

from PIL import Image

ALLOWED = [(45, 12), (0, 12), (130, 25)]  # accent yellow ~45°, red ~0°, green ~130° (hue°, tolerance°)


def pixels(im):
    return im.get_flattened_data() if hasattr(im, "get_flattened_data") else im.getdata()


def hues(im):
    small = im.convert("RGBA").resize((max(1, im.width // 4), max(1, im.height // 4)))
    seen = {}
    for r, g, b, a in pixels(small):
        if a < 200:
            continue
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        if s > 0.45 and v > 0.35:
            k = int(h * 360) // 15 * 15
            seen[k] = seen.get(k, 0) + 1
    total = sum(seen.values()) or 1
    return {k: n / total for k, n in seen.items() if n / total > 0.03}


def off_palette(hs):
    bad = []
    for h in hs:
        if not any(min(abs(h - c), 360 - abs(h - c)) <= tol + 7 for c, tol in ALLOWED):
            bad.append(h)
    return bad


def edge(im):
    a = im.convert("RGBA").getchannel("A")
    w, h = a.size
    strips = [a.crop((0, 0, w, 2)), a.crop((0, h - 2, w, h)), a.crop((0, 0, 2, h)), a.crop((w - 2, 0, w, h))]
    return max(max(pixels(s)) for s in strips) > 200


def check(path, canvas_w=None, scale=None):
    im = Image.open(path)
    flags = []
    bad = off_palette(hues(im))
    if bad:
        flags.append(f"palette: off-system hues {sorted(bad)}° (one accent + red/green only)")
    if im.mode in ("RGBA", "LA") and edge(im):
        flags.append("edge: opaque pixels on the border (cut text / element straddling the edge / no shadow room)")
    if canvas_w and scale and scale * canvas_w < 180 and im.width > 400:
        flags.append(f"small: shown {scale * canvas_w:.0f} px wide, text will be unreadable on a phone")
    return im, flags


def main():
    a = sys.argv[1:]
    items = []
    if a and a[0] == "--project":
        p = json.load(open(a[1]))
        W = p["canvas"]["w"]
        # media is a list of ids; each one's path is in <data>/media/<id>/meta.json (projects2/ sits beside media/)
        data = Path(a[1]).resolve().parent.parent
        media = {}
        for m in p.get("media", []):
            mid = m["id"] if isinstance(m, dict) else m
            meta = data / "media" / mid / "meta.json"
            media[mid] = m if isinstance(m, dict) else (json.load(open(meta)) if meta.exists() else {})
        for t in p["tracks"]:
            for c in t["clips"]:
                path = (media.get(c.get("mid")) or {}).get("path")
                if path and path.lower().endswith(".png"):
                    items.append((path, W, c.get("scale")))
    else:
        items = [(x, None, None) for x in a]
    if not items:
        print("nothing to check (project media paths not found: pass the PNGs)")
        return 0
    bad, thumbs = 0, []
    for path, W, s in dict.fromkeys(items):
        im, flags = check(path, W, s)
        thumbs.append(im.convert("RGBA"))
        status = "ok" if not flags else "; ".join(flags)
        bad += bool(flags)
        print(f"{Path(path).name:48s} {status}")
    # review sheet: every graphic at ~phone size (a 1080 canvas shown 390 px wide -> x0.36)
    k = 0.36 / 2 if all(t.width > 1200 for t in thumbs) else 0.36
    tiles = [t.resize((max(1, int(t.width * k)), max(1, int(t.height * k))), Image.LANCZOS) for t in thumbs]
    W = max(t.width for t in tiles) + 40
    H = sum(t.height + 20 for t in tiles) + 20
    sheet = Image.new("RGBA", (W, H), (96, 92, 88, 255))
    y = 20
    for t in tiles:
        sheet.alpha_composite(t, (20, y))
        y += t.height + 20
    out = Path("uicheck.png")  # in the working folder, never next to the user's files
    sheet.convert("RGB").save(out)
    print(f"review sheet: {out}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
