#!/usr/bin/env python3
"""Logo stickers and panels for overlays (system python3 + Pillow).

  sticker.py logo IN.png|svg OUT.png [--size 360] [--border 10] [--no-border]
      full-colour logo -> white die-cut border + soft drop shadow, transparent PNG.
      The "real logo, sticker border, soft shadow" look editors use; flat glyph badges read as
      template/AI. Shadow: 40% black, blur ~14 px, offset y 10 px (recipe A, references/style.md).
  sticker.py commons "File:Instagram_icon.png" OUT.png [--size 360]
      download a full-colour logo from Wikimedia Commons (most brand logos are there, often
      public domain: check the file page) and make it a sticker. Find titles with
      https://commons.wikimedia.org/w/index.php?search=<brand>+logo&ns6=1
  sticker.py panel OUT.png W H [--radius 40]
      rounded translucent dark panel (82% opacity, 4 px light stroke) to sit behind a logo row.

SVG input is rasterised with rsvg-convert first.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter


def load(path, size):
    path = Path(path)
    if path.suffix.lower() == ".svg":
        tmp = Path(tempfile.mkdtemp()) / "x.png"
        subprocess.run(["rsvg-convert", "-w", str(size * 2), str(path), "-o", str(tmp)], check=True)
        path = tmp
    im = Image.open(path).convert("RGBA")
    bbox = im.getchannel("A").getbbox()
    if bbox:
        im = im.crop(bbox)
    im.thumbnail((size, size), Image.LANCZOS)
    return im


def logo(src, out, size=360, border=10, shadow=True):
    im = load(src, size)
    pad = border + 40
    W, H = im.width + 2 * pad, im.height + 2 * pad
    base = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    a = Image.new("L", (W, H), 0)
    a.paste(im.getchannel("A"), (pad, pad))
    if border:
        a = a.filter(ImageFilter.MaxFilter(2 * border + 1)).filter(ImageFilter.GaussianBlur(1.2))
        a = a.point(lambda v: 255 if v > 110 else int(v * 2.3))
    if shadow:
        sh = a.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * 0.40))
        base.paste(Image.new("RGBA", (W, H), (0, 0, 0, 255)), (0, 10), sh)
    if border:
        base.paste(Image.new("RGBA", (W, H), (255, 255, 255, 255)), (0, 0), a)
    base.alpha_composite(im, (pad, pad))
    base.save(out)
    return out


def commons(title, out, size=360):
    import json
    import urllib.parse
    import urllib.request
    ua = {"User-Agent": "Shorts-video-editor/0.3 (https://github.com/MarioRodrigues10/shorts)"}
    q = "https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url&format=json&titles=" + \
        urllib.parse.quote(title if title.startswith("File:") else "File:" + title)
    page = next(iter(json.load(urllib.request.urlopen(urllib.request.Request(q, headers=ua)))["query"]["pages"].values()))
    if "imageinfo" not in page:
        raise SystemExit(f"not on Commons: {title}")
    url = page["imageinfo"][0]["url"].split("?")[0]
    tmp = Path(tempfile.mkdtemp()) / Path(urllib.parse.unquote(url)).name
    tmp.write_bytes(urllib.request.urlopen(urllib.request.Request(url, headers=ua)).read())
    return logo(tmp, out, size)


def panel(out, w, h, radius=40):
    im = Image.new("RGBA", (w + 40, h + 50), (0, 0, 0, 0))
    m = Image.new("L", im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((20, 20, 20 + w, 20 + h), radius, fill=255)
    im.paste(Image.new("RGBA", im.size, (0, 0, 0, 255)), (0, 10), m.filter(ImageFilter.GaussianBlur(14)).point(lambda v: int(v * 0.35)))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((20, 20, 20 + w, 20 + h), radius, fill=(18, 18, 20, 209), outline=(255, 255, 255, 46), width=4)
    im.save(out)
    return out


if __name__ == "__main__":
    a = sys.argv
    if a[1] == "logo":
        opt = lambda k, d: int(a[a.index(k) + 1]) if k in a else d
        print(logo(a[2], a[3], opt("--size", 360), 0 if "--no-border" in a else opt("--border", 10)))
    elif a[1] == "commons":
        print(commons(a[2], a[3], int(a[a.index("--size") + 1]) if "--size" in a else 360))
    elif a[1] == "panel":
        print(panel(a[2], int(a[3]), int(a[4]), int(a[a.index("--radius") + 1]) if "--radius" in a else 40))
