#!/usr/bin/env python3
"""Explainer UI for edits (system python3 + Pillow): one design system so panels look designed, not generated.

Every explainer graphic (steppers, lists, comparisons) goes through these tokens and components.
The rules behind them are in ../references/motion-design.md. Components measure their own text
and never let it touch an edge: if a label doesn't fit, the font steps down, then the call fails.

  stepper(title, steps, active, out, done=None, sub=None, dim=False)  -> PNG + geometry (node centres)
  list_panel(title, rows, shown, out, kind="number"|"check"|"updown") -> PNG (rows fill in)
  ring(out)                                                            -> accent focus ring PNG

All sizes are in "design px" for a 1080-wide canvas and rendered at SS x for crisp edges;
place with shortslib (Edit.ui_panel / ui_states / ui_ping), which converts the scale.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(Path(__file__).parent))
from graphics import font  # noqa: E402  (Montserrat from the app's static/fonts)

SS = 2  # supersampling: drawn at 2x, so 1 design px = 2 image px

# ---- tokens -------------------------------------------------------------------------------
INK = (14, 14, 18)              # panel tint (same as the "frosted" title card)
PANEL_ALPHA = 196
RIM = (255, 255, 255, 56)       # 1.5 px light rim
TEXT = (255, 255, 255, 255)
MUTED = (255, 255, 255, 120)    # pending / secondary
FAINT = (255, 255, 255, 46)     # tracks, empty slots
ACCENT = (255, 210, 63, 255)    # the channel's one accent (captions, cards)
ON_ACCENT = (17, 17, 17, 255)
NEG = (239, 68, 68, 255)        # only for "wrong / goes down"
POS = (52, 199, 89, 255)        # only for "right / goes up"

TYPE = {"title": (30, 800), "label": (26, 800), "meta": (21, 800), "num": (20, 900)}  # 1.2-ish scale
GRID = 8
RADIUS = 22
PAD = 24          # panel padding (3 grid units)


def px(v):
    return int(round(v * SS))


def _font(role, shrink=0):
    size, weight = TYPE[role]
    return font(px(size - shrink), weight)


def _fit(d, text, role, max_w):
    """The role's font, stepped down (max 4 design px) until `text` fits `max_w` image px."""
    for k in range(0, 5):
        f = _font(role, k)
        if d.textlength(text, font=f) <= max_w:
            return f
    raise ValueError(f"'{text}' doesn't fit {max_w / SS:.0f} design px: shorten it or widen the panel")


def _panel(w, h):
    im = Image.new("RGBA", (px(w), px(h)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, im.width - 1, im.height - 1), px(RADIUS), fill=INK + (PANEL_ALPHA,),
                        outline=RIM, width=max(2, px(1.5)))
    return im, d


def _shadow(im, blur=20, dy=10, alpha=0.45, pad=36):
    """Soft drop shadow; the padding is part of the PNG (callers place by centre, so it's symmetric)."""
    P = px(pad)
    out = Image.new("RGBA", (im.width + 2 * P, im.height + 2 * P), (0, 0, 0, 0))
    sh = Image.new("RGBA", out.size, (0, 0, 0, 0))
    a = im.getchannel("A").point(lambda v: int(v * alpha))
    sh.paste((0, 0, 0, 255), (P, P + px(dy)), a)
    out.alpha_composite(sh.filter(ImageFilter.GaussianBlur(px(blur))))
    out.alpha_composite(im, (P, P))
    return out, P


def _check(d, cx, cy, r, color):
    w = max(3, int(r * 0.28))
    d.line([(cx - r * 0.42, cy + r * 0.02), (cx - r * 0.12, cy + r * 0.32), (cx + r * 0.45, cy - r * 0.3)],
           fill=color, width=w, joint="curve")


def stepper(title, steps, active, out, done=None, sub=None, dim=False, width=560):
    """A horizontal process: numbered nodes on one track, labels under them, all the same size.
    active: index of the current step (-1 = none); steps before it are done (white + check).
    sub: (index, text) small accent note under a label (e.g. (3, "to everybody")).
    Writes PNG `out` and `out`.json with the node centres in design px relative to the PNG centre."""
    done = active if done is None else done
    n = len(steps)
    node_r = 20
    col_w = (width - 2 * PAD) / n
    title_h = 30 + 24
    H = PAD + title_h + node_r * 2 + 14 + 30 + (26 if sub else 0) + PAD
    im, d = _panel(width, H)
    ft = _fit(d, title, "title", px(width - 2 * PAD))
    d.text((px(PAD), px(PAD) + px(2)), title, font=ft, fill=TEXT)
    cy = PAD + title_h + node_r
    centres = [PAD + col_w * (i + 0.5) for i in range(n)]
    # track: faint full line, solid up to the last done node
    tw = max(2, px(3))
    d.line([(px(centres[0]), px(cy)), (px(centres[-1]), px(cy))], fill=FAINT, width=tw)
    if done > 0:
        d.line([(px(centres[0]), px(cy)), (px(centres[min(done, n - 1)]), px(cy))], fill=(255, 255, 255, 200), width=tw)
    for i, (cx, label) in enumerate(zip(centres, steps)):
        box = (px(cx - node_r), px(cy - node_r), px(cx + node_r), px(cy + node_r))
        if i < done:  # done: solid white, dark check
            d.ellipse(box, fill=(255, 255, 255, 235))
            _check(d, px(cx), px(cy), px(node_r * 0.62), ON_ACCENT)
            lc = (255, 255, 255, 215)
        elif i == active:  # current: accent, number
            d.ellipse((box[0] - px(5), box[1] - px(5), box[2] + px(5), box[3] + px(5)), fill=(255, 210, 63, 60))
            d.ellipse(box, fill=ACCENT)
            d.text((px(cx), px(cy) + px(1)), str(i + 1), font=_font("num"), fill=ON_ACCENT, anchor="mm")
            lc = TEXT
        else:  # pending: outline only
            d.ellipse(box, fill=INK + (255,), outline=(255, 255, 255, 70), width=max(2, px(2)))
            d.text((px(cx), px(cy) + px(1)), str(i + 1), font=_font("num"), fill=MUTED, anchor="mm")
            lc = MUTED
        fl = _fit(d, label, "label", px(col_w - 12))
        d.text((px(cx), px(cy + node_r + 14 + 15)), label, font=fl, fill=lc, anchor="mm")
        if sub and sub[0] == i:  # a note under its node, kept inside the panel padding (never on the border)
            fm = _fit(d, sub[1], "meta", px(width - 2 * PAD))
            half = d.textlength(sub[1], font=fm) / SS / 2
            sx = min(max(cx, PAD + half), width - PAD - half)
            d.text((px(sx), px(cy + node_r + 14 + 30 + 14)), sub[1], font=fm, fill=ACCENT, anchor="mm")
    if dim:
        im.putalpha(im.getchannel("A").point(lambda v: int(v * 0.5)))
    im, P = _shadow(im)
    im.save(out)
    W2, H2 = im.width / SS / 2, im.height / SS / 2
    geo = {"size": [im.width / SS, im.height / SS],
           "nodes": [[round(P / SS + c - W2, 1), round(P / SS + cy - H2, 1)] for c in centres], "node_r": node_r}
    Path(str(out) + ".json").write_text(json.dumps(geo))
    return out, geo


def list_panel(title, rows, shown, out, kind="number", width=560, active=None):
    """A titled list whose rows fill in one by one (placeholders keep the size stable).
    kind: "number" (accent numbered badges) | "check" | "updown" (rows are ("up"|"down", text)).
    active: row index drawn at full white (the one being said); others shown at 80%."""
    row_h = 52
    title_h = 30 + 16
    H = PAD + title_h + row_h * len(rows) + PAD - 12
    im, d = _panel(width, H)
    d.text((px(PAD), px(PAD) + px(2)), title, font=_fit(d, title, "title", px(width - 2 * PAD)), fill=TEXT)
    for i, row in enumerate(rows):
        y = PAD + title_h + i * row_h + row_h / 2 - 6
        bx, r = PAD + 16, 15
        if i >= shown:  # placeholder
            d.ellipse((px(bx - r), px(y - r), px(bx + r), px(y + r)), fill=FAINT)
            d.rounded_rectangle((px(bx + 30), px(y - 7), px(bx + 30 + 200), px(y + 7)), px(7), fill=(255, 255, 255, 26))
            continue
        badge, text = (row if kind == "updown" else (None, row))
        if kind == "number":
            d.ellipse((px(bx - r), px(y - r), px(bx + r), px(y + r)), fill=ACCENT)
            d.text((px(bx), px(y) + px(1)), str(i + 1), font=_font("num"), fill=ON_ACCENT, anchor="mm")
        elif kind == "check":
            d.ellipse((px(bx - r), px(y - r), px(bx + r), px(y + r)), fill=(255, 255, 255, 235))
            _check(d, px(bx), px(y), px(r * 0.62), ON_ACCENT)
        else:
            col = POS if badge == "up" else NEG
            d.ellipse((px(bx - r), px(y - r), px(bx + r), px(y + r)), fill=col)
            s = 1 if badge == "up" else -1
            d.polygon([(px(bx), px(y - 7 * s)), (px(bx - 7), px(y + 4 * s)), (px(bx + 7), px(y + 4 * s))], fill=TEXT)
        fl = _fit(d, text, "label", px(width - PAD - (bx + 30)))
        fill = TEXT if (active is None or active == i) else (255, 255, 255, 200)
        d.text((px(bx + 30), px(y) + px(1)), text, font=fl, fill=fill, anchor="lm")
    im, _ = _shadow(im)
    im.save(out)
    return out


def ring(out, r=20):
    """Accent focus ring for Edit.ui_ping (expands and fades on a node when it becomes current)."""
    R = r + 10
    im = Image.new("RGBA", (px(2 * R), px(2 * R)), (0, 0, 0, 0))
    ImageDraw.Draw(im).ellipse((px(2), px(2), px(2 * R - 2), px(2 * R - 2)), outline=ACCENT, width=px(3))
    im.save(out)
    return out


if __name__ == "__main__":
    cmd, args = sys.argv[1], json.loads(sys.argv[2])
    print(json.dumps({"stepper": stepper, "list_panel": list_panel, "ring": ring}[cmd](*args[0], **args[1])))
