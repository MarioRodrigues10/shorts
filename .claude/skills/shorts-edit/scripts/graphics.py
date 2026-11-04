#!/usr/bin/env python3
"""Engagement graphics as transparent PNGs, in one house style (system python3 + Pillow).
Each is an overlay for shortslib (sticker_pop / image). Fonts come from the repo (static/fonts).

  yt_card(thumb.jpg, title, channel, meta, duration, out)        a YouTube video card (dark mode)
      -> when the speaker mentions a video ("I recorded a video last year...", a lecture they learned from)
  scorecard(title, tone, items, shown, out)                       a running checklist panel
      tone "good" (green header, ✓) or "bad" (red header, ✗); items = [("check"|"cross"|"mid", text)]
      -> render one PNG per state (shown = 1..n) and switch on each spoken item
  ig_card(avatar.png, handle, name, followers, bio, out)         an Instagram creator card (avatar in
      the gradient ring, handle, name, followers, one bio line) -> when they mention a creator
  stamp(text, out, color)                                         a rubber stamp ("REJECTED")
  pill(text, out, icon=None)                                      a red subscribe-style button with an emoji
  page_card(screenshot.png, out, highlight=(x0,y0,x1,y1), crop_top=0)  a website as 16:9 proof B-roll

Emoji: Microsoft Fluent Emoji 3D (MIT), e.g.
  https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/Unicorn/3D/unicorn_3d.png
Video thumbnails: https://i.ytimg.com/vi/<id>/maxresdefault.jpg (fall back to hqdefault.jpg);
details with `yt-dlp --skip-download --print "%(upload_date)s|%(view_count)s|%(channel)s|%(title)s" URL`.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = Path(__file__).resolve().parents[4] / "static/fonts"
ACCENT = (255, 210, 63)


def font(size, weight=800, name="Montserrat"):
    f = ImageFont.truetype(str(FONTS / f"{name}.ttf"), int(size))
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def rounded(im, r):
    m = Image.new("L", im.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, im.width - 1, im.height - 1), r, fill=255)
    out = im.convert("RGBA")
    out.putalpha(m)
    return out


def shadowed(card, blur=22, dy=14, alpha=0.5, pad=50):
    W, H = card.width + 2 * pad, card.height + 2 * pad
    base = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sh = Image.new("L", (W, H), 0)
    sh.paste(card.getchannel("A"), (pad, pad + dy))
    sh = sh.filter(ImageFilter.GaussianBlur(blur)).point(lambda v: int(v * alpha))
    base.paste(Image.new("RGBA", (W, H), (0, 0, 0, 255)), (0, 0), sh)
    base.alpha_composite(card, (pad, pad))
    return base


def wrap(d, text, f, width):
    lines, cur = [], ""
    for w in text.split():
        t = f"{cur} {w}".strip()
        if cur and d.textlength(t, font=f) > width:
            lines.append(cur)
            cur = w
        else:
            cur = t
    return lines + ([cur] if cur else [])


def yt_card(thumb, title, channel, meta, duration, out, width=900):
    th = Image.open(thumb).convert("RGB")
    tw = width - 40
    th = th.resize((tw, int(tw * 9 / 16)), Image.LANCZOS)
    th = rounded(th, 18)
    d0 = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    tf, mf = font(40, 800), font(30, 500)
    tl = wrap(d0, title, tf, tw - 90)[:2]
    H = 20 + th.height + 24 + len(tl) * 50 + 46 + 24
    card = Image.new("RGBA", (width, H), (15, 15, 15, 255))
    card.alpha_composite(th, (20, 20))
    d = ImageDraw.Draw(card)
    # duration badge
    bf = font(26, 700)
    bw = d.textlength(duration, font=bf) + 20
    bx, by = 20 + tw - bw - 12, 20 + th.height - 48
    d.rounded_rectangle((bx, by, bx + bw, by + 36), 8, fill=(0, 0, 0, 220))
    d.text((bx + 10, by + 3), duration, font=bf, fill=(255, 255, 255))
    # avatar + title + meta
    y = 20 + th.height + 24
    d.ellipse((20, y, 82, y + 62), fill=(220, 74, 34))
    d.text((51, y + 31), channel[:1].upper(), font=font(30, 800), fill=(255, 255, 255), anchor="mm")
    for i, l in enumerate(tl):
        d.text((100, y + i * 50), l, font=tf, fill=(241, 241, 241))
    d.text((100, y + len(tl) * 50 + 6), f"{channel} · {meta}", font=mf, fill=(170, 170, 170))
    shadowed(rounded(card, 26)).save(out)
    return out


def ig_card(avatar, handle, name, followers, bio, out, width=820):
    """Instagram-style creator card. avatar: a square photo (cropped from a profile screenshot)."""
    av = Image.open(avatar).convert("RGBA").resize((170, 170), Image.LANCZOS)
    m = Image.new("L", av.size, 0)
    ImageDraw.Draw(m).ellipse((0, 0, 169, 169), fill=255)
    H = 250
    card = Image.new("RGBA", (width, H), (15, 15, 15, 255))
    # Instagram's story ring: an orange -> magenta -> purple gradient circle
    ring = Image.new("RGBA", (196, 196), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    stops = [(254, 218, 117), (250, 126, 30), (214, 41, 118), (150, 47, 191), (79, 91, 213)]
    for i in range(196):
        t = i / 195 * (len(stops) - 1)
        a, b = stops[int(t)], stops[min(int(t) + 1, len(stops) - 1)]
        c = tuple(int(a[k] + (b[k] - a[k]) * (t - int(t))) for k in range(3))
        rd.line([(i, 0), (i, 195)], fill=c + (255,))
    rm = Image.new("L", (196, 196), 0)
    ImageDraw.Draw(rm).ellipse((0, 0, 195, 195), fill=255)
    ImageDraw.Draw(rm).ellipse((7, 7, 188, 188), fill=0)
    card.paste(ring, (32, 27), rm)
    card.paste(av, (45, 40), m)
    d = ImageDraw.Draw(card)
    d.text((250, 52), handle, font=font(46, 800), fill=(245, 245, 245))
    d.text((250, 112), name, font=font(32, 600), fill=(200, 200, 200))
    d.text((250, 158), f"{followers} followers", font=font(30, 700), fill=(245, 245, 245))
    bf = font(26, 500)
    line = wrap(d, bio, bf, width - 280)[:1]
    if line:
        d.text((250, 202), line[0], font=bf, fill=(160, 160, 160))
    # the Instagram glyph, top right
    g = Image.new("RGBA", (54, 54), (0, 0, 0, 0))
    gd = ImageDraw.Draw(g)
    gd.rounded_rectangle((3, 3, 50, 50), 15, outline=(255, 255, 255, 230), width=5)
    gd.ellipse((15, 15, 38, 38), outline=(255, 255, 255, 230), width=5)
    gd.ellipse((37, 10, 43, 16), fill=(255, 255, 255, 230))
    card.alpha_composite(g, (width - 80, 26))
    shadowed(rounded(card, 26)).save(out)
    return out


def _icon(kind, size):
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    col = {"check": (34, 197, 94), "cross": (239, 68, 68), "mid": (234, 179, 8)}[kind]
    d.ellipse((0, 0, size - 1, size - 1), fill=col)
    w = max(4, size // 9)
    if kind == "check":
        d.line([(size * .27, size * .53), (size * .44, size * .70), (size * .74, size * .33)], fill="white", width=w, joint="curve")
    elif kind == "cross":
        d.line([(size * .32, size * .32), (size * .68, size * .68)], fill="white", width=w)
        d.line([(size * .68, size * .32), (size * .32, size * .68)], fill="white", width=w)
    else:
        d.line([(size * .3, size * .5), (size * .7, size * .5)], fill="white", width=w)
    return im


def scorecard(title, tone, items, shown, out, width=640):
    hf, f = font(40, 900), font(36, 700)
    row = 76
    H = 96 + row * len(items) + 24
    card = Image.new("RGBA", (width, H), (18, 18, 20, 232))
    d = ImageDraw.Draw(card)
    hc = (34, 197, 94) if tone == "good" else (239, 68, 68)
    d.rounded_rectangle((0, 0, width, 84), 26, fill=hc)
    d.rectangle((0, 50, width, 84), fill=hc)
    d.text((28, 42), title, font=hf, fill=(255, 255, 255), anchor="lm")
    for i, (kind, text) in enumerate(items):
        y = 96 + i * row
        if i < shown:
            card.alpha_composite(_icon(kind, 52), (26, y + 10))
            d.text((96, y + 36), text, font=f, fill=(255, 255, 255), anchor="lm")
        else:  # the rows still to come: faint placeholders keep the panel's size stable
            d.rounded_rectangle((26, y + 22, 26 + 52, y + 50), 14, fill=(255, 255, 255, 28))
            d.rounded_rectangle((96, y + 26, 96 + 220, y + 46), 10, fill=(255, 255, 255, 22))
    border = Image.new("RGBA", card.size, (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle((1, 1, width - 2, H - 2), 26, outline=(255, 255, 255, 40), width=3)
    card.alpha_composite(border)
    shadowed(rounded(card, 26)).save(out)
    return out


def stamp(text, out, color=(220, 38, 38), angle=-12):
    f = font(150, 900)
    d0 = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    tw = int(d0.textlength(text, font=f))
    W, H = tw + 120, 250
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((10, 10, W - 10, H - 10), 28, outline=color + (255,), width=14)
    d.rounded_rectangle((32, 32, W - 32, H - 32), 18, outline=color + (255,), width=5)
    d.text((W // 2, H // 2 + 4), text, font=f, fill=color + (255,), anchor="mm")
    # ink texture: knock out speckles so it reads as a real stamp
    import random
    rnd = random.Random(7)
    a = im.getchannel("A")
    holes = Image.new("L", im.size, 255)
    hd = ImageDraw.Draw(holes)
    for _ in range(int(W * H / 160)):
        x, y, r = rnd.randrange(W), rnd.randrange(H), rnd.choice((1, 1, 2, 3))
        hd.ellipse((x - r, y - r, x + r, y + r), fill=rnd.choice((0, 60, 120)))
    im.putalpha(Image.composite(a, Image.new("L", im.size, 0), holes.filter(ImageFilter.GaussianBlur(0.6))))
    im = im.rotate(angle, resample=Image.BICUBIC, expand=True)
    im.save(out)
    return out


def pill(text, out, icon=None, color=(255, 0, 0)):
    f = font(64, 800)
    d0 = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    tw = int(d0.textlength(text, font=f))
    ic = 0
    if icon:
        ico = Image.open(icon).convert("RGBA").resize((96, 96), Image.LANCZOS)
        ic = 96 + 20
    W, H = tw + ic + 110, 132
    card = Image.new("RGBA", (W, H), color + (255,))
    d = ImageDraw.Draw(card)
    x = 55
    if icon:
        card.alpha_composite(ico, (x - 10, (H - 96) // 2))
        x += ic
    d.text((x, H // 2 + 2), text, font=f, fill=(255, 255, 255), anchor="lm")
    shadowed(rounded(card, H // 2)).save(out)
    return out


def page_card(shot, out, highlight=None, crop_top=0):
    src = Image.open(shot).convert("RGB")
    W = src.width
    crop = src.crop((0, crop_top, W, crop_top + int(W * 9 / 16)))
    canvas = crop.resize((1920, 1080)).filter(ImageFilter.GaussianBlur(28))
    canvas = Image.blend(canvas, Image.new("RGB", canvas.size, (18, 18, 20)), 0.55)
    cw = 1560
    ch = int(cw * crop.height / crop.width)
    c = crop.resize((cw, ch), Image.LANCZOS).convert("RGBA")
    if highlight:
        k = cw / crop.width
        x0, y0, x1, y1 = highlight
        ov = Image.new("RGBA", c.size, (0, 0, 0, 0))
        ImageDraw.Draw(ov).rounded_rectangle((int(x0 * k) - 12, int((y0 - crop_top) * k) - 8, int(x1 * k) + 12,
                                              int((y1 - crop_top) * k) + 8), 12, fill=ACCENT + (110,))
        c = Image.alpha_composite(c, ov)
    m = Image.new("L", c.size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, cw - 1, ch - 1), 28, fill=255)
    x, y = (1920 - cw) // 2, (1080 - ch) // 2
    sh = Image.new("L", canvas.size, 0)
    sh.paste(m, (x, y + 18))
    canvas.paste((0, 0, 0), (0, 0), sh.filter(ImageFilter.GaussianBlur(26)).point(lambda v: int(v * 0.55)))
    canvas.paste(c.convert("RGB"), (x, y), m)
    canvas.save(out)
    return out
