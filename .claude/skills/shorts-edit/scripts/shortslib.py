"""Build a Shorts project from a cut plan. Import this from a small per-video edit script.

    import sys; sys.path.insert(0, "<repo>/.claude/skills/shorts-edit/scripts")
    from shortslib import Edit, CLEAN_CAPTIONS, make_edit_media
    mid = make_edit_media("http://127.0.0.1:7378", src_mid, "my-edit")   # private, retimed copy
    # ... cutplan.py + joints.py on that mid -> plan.json ...
    e = Edit(api="http://127.0.0.1:7378", mid=mid, plan="plan.json", name="My short (Claude edit)")
    e.zoom_eyes(hook_tag="hook", punch_tags=("payoff",))
    e.sticker_pop("stickers/reddit.png", at_word=8820, until=e.tag_end("story"))
    e.card("#1  The first point", e.tag_start("point1"), e.tag_end("point1"))
    e.whoosh_into(e.tag_start("story"))
    pid, project = e.save(captions=CLEAN_CAPTIONS, word_edits={9310: {"text": "chatting"}})

Times passed to stickers/cards/sfx are TIMELINE seconds; e.word_start(id) / e.word_end(id) /
e.tag_start(tag) / e.tag_end(tag) convert from the source transcript (word ids = words.json "id").
"""
import hashlib
import json
import os
import shutil
import struct
import sys
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

FPS = 30
DEFAULT_DATA = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "shorts-studio"
uid = lambda: uuid.uuid4().hex[:8]
snap = lambda t: round(t * FPS) / FPS

TEXT_PRESETS = {  # copied from web/src/core/layer.js TEXT_PRESETS (keep in sync)
    "classic": {"label": "Classic", "font": "Montserrat", "weight": 900, "size": 78, "color": "#ffffff", "bg": "", "stroke": 9, "strokeColor": "#000000", "shadow": 12, "uppercase": False},
    "title-box": {"label": "Title box", "font": "Montserrat", "weight": 900, "size": 64, "color": "#000000", "bg": "#ffffff", "stroke": 0, "strokeColor": "#000000", "shadow": 0, "uppercase": False},
    "dark-box": {"label": "Dark box", "font": "Inter", "weight": 800, "size": 56, "color": "#ffffff", "bg": "rgba(0,0,0,0.75)", "stroke": 0, "strokeColor": "#000000", "shadow": 0, "uppercase": False},
    "yellow": {"label": "Marker", "font": "Poppins", "weight": 900, "size": 70, "color": "#000000", "bg": "#ffe500", "stroke": 0, "strokeColor": "#000000", "shadow": 0, "uppercase": True},
    "red-alert": {"label": "Alert", "font": "Anton", "weight": 400, "size": 110, "color": "#ffffff", "bg": "#ef4444", "stroke": 0, "strokeColor": "#000000", "shadow": 0, "uppercase": True},
    "impact": {"label": "Impact", "font": "Anton", "weight": 400, "size": 140, "color": "#ffe500", "bg": "", "stroke": 12, "strokeColor": "#000000", "shadow": 20, "uppercase": True},
    "minimal": {"label": "Minimal", "font": "Inter", "weight": 600, "size": 52, "color": "#ffffff", "bg": "", "stroke": 0, "strokeColor": "#000000", "shadow": 26, "uppercase": False},
}

# Captions that don't read as a template: one sans, sentence case, white + ONE accent on the active
# word, soft shadow instead of a heavy stroke, a short fade instead of a pop, 3 words a page, no
# emojis (references/style.md). Accent = the same colour as the number callouts.
ACCENT = "#FFD23F"
CLEAN_CAPTIONS = {"enabled": True, "preset": "clean", "label": "Clean (shorts-edit)", "font": "Inter", "weight": 800,
                  "size": 66, "uppercase": False, "stripPunct": True, "color": "#ffffff", "activeColor": ACCENT,
                  "futureColor": "", "emphColor": ACCENT, "highlight": "color", "boxColor": "#000000", "stroke": 0,
                  "strokeColor": "#000000", "shadow": 22, "shadowColor": "rgba(0,0,0,0.8)", "mode": "group",
                  "maxWords": 3, "maxChars": 20, "posY": 0.66, "maxWidth": 0.84, "lineHeight": 1.2, "enter": "fade",
                  "activeScale": 1.0}

# Kinetic "stack" captions (web/src/core/layer.js preset "stack"): words land on their beat and pile
# up into the phrase, key words big, small words small, letters filled with a sky texture.
# posY is the TOP of the block in stack mode (it grows downward): 0.56 starts just under the chin.
STACK_CAPTIONS = {"enabled": True, "preset": "stack", "label": "Stack (shorts-edit)", "font": "Montserrat", "weight": 900,
                  "size": 132, "uppercase": True, "stripPunct": True, "color": "#ffffff", "activeColor": "#ffffff",
                  "futureColor": "", "emphColor": ACCENT, "highlight": "none", "boxColor": ACCENT, "stroke": 0,
                  "strokeColor": "#000000", "shadow": 18, "shadowColor": "rgba(0,0,0,0.45)", "mode": "stack",
                  "maxWords": 4, "maxChars": 26, "posY": 0.56, "maxWidth": 0.8, "lineHeight": 0.92, "enter": "none",
                  "activeScale": 1.0, "letterSpacing": -0.02, "fill": "sky"}


def api(base, path, body=None, method=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method or ("POST" if data else "GET"))
    return json.load(urllib.request.urlopen(req))


def make_edit_media(api_base, src_mid, label, data_dir=None):
    """A private copy of a clip for one edit, with word times retimed onto the voicing (so no kept
    word drops out of the captions) and the filtered breath map. The video is hardlinked (no
    extra disk), the proxy/sprite/peaks are copied (no re-encode). Your own media entry,
    transcript and projects are untouched. Returns the new media id; plan and build on it."""
    import cutplan as C
    import breathmap as BM
    data = Path(data_dir or DEFAULT_DATA)
    src_dir = data / "media" / src_mid
    meta = json.load(open(src_dir / "meta.json"))
    src = Path(meta["path"])
    dst = data / "edit-media" / f"{src.stem} [{label}]{src.suffix}"
    dst.parent.mkdir(parents=True, exist_ok=True)
    if not dst.exists():
        os.link(src, dst)
    st = dst.stat()  # same formula as media_id_for() in server.py
    mid = hashlib.sha1(f"{dst.resolve()}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:12]
    d = data / "media" / mid
    d.mkdir(parents=True, exist_ok=True)
    for f in src_dir.iterdir():
        if f.is_file() and f.name not in ("meta.json", "words.json", "breaths.json") and not (d / f.name).exists():
            shutil.copy2(f, d / f.name)
    m = dict(meta, id=mid, path=str(dst.resolve()), name=dst.name)
    json.dump(m, open(d / "meta.json", "w"))
    words = C.retime(src_dir)
    json.dump(words, open(d / "words.json", "w"))
    audio = BM.B.load_audio(str(dst))
    br, fr, _ = BM.detect(audio, words["words"])
    json.dump({"version": 4, "breaths": br, "fragments": fr}, open(d / "breaths.json", "w"))  # newer than words.json
    api(api_base, "/api/media/import", {"path": str(dst.resolve())})
    return mid


def glossary_edits(words, glossary_md):
    """word_edits from a glossary note: a fenced ```glossary block of "heard -> fix" lines.
    A multi-word match puts the fix on its first word and hides the others; trailing punctuation
    of the last matched word is kept ("open ai," -> "OpenAI,")."""
    import re
    text = Path(glossary_md).expanduser().read_text()
    m = re.search(r"```glossary\n(.*?)```", text, re.S)
    rules = []
    for line in (m.group(1).splitlines() if m else []):
        if "->" in line:
            a, b = (x.strip() for x in line.split("->", 1))
            if a and b:
                rules.append((a.lower().split(), b))
    rules.sort(key=lambda r: -len(r[0]))  # longest match first
    norm = lambda t: re.sub(r"[^a-z0-9/'-]+", "", t.lower())
    ws = list(words)
    edits, i = {}, 0
    while i < len(ws):
        for pat, fix in rules:
            if [norm(w["text"]) for w in ws[i:i + len(pat)]] == pat:
                tail = re.search(r"[.,!?;:]+$", ws[i + len(pat) - 1]["text"])
                edits[ws[i]["id"]] = {"text": fix + (tail.group(0) if tail else "")}
                for w in ws[i + 1:i + len(pat)]:
                    edits[w["id"]] = {"text": ""}
                i += len(pat)
                break
        else:
            i += 1
    return edits


class Edit:
    def __init__(self, api, mid, plan, name, data_dir=None, canvas=(1080, 1920)):
        self.canvas = canvas  # (1920, 1080) for YouTube long-form
        self.api, self.mid, self.name = api.rstrip("/"), mid, name
        self.data = Path(data_dir or DEFAULT_DATA)
        p = json.load(open(plan))
        self.plan_clips = p["clips"]
        self.media_is_copy = json.load(open(self.data / "media" / mid / "meta.json"))["path"].find("/edit-media/") >= 0
        self.words = {w["id"]: w for w in json.load(open(self.data / "media" / mid / "words.json"))["words"]}
        self.clips, self.tags = [], []
        for c in p["clips"]:
            self.clips.append({"id": uid(), "mid": mid, "in": c["in"], "out": c["out"], "speed": 1, "volume": 1,
                               "mute": False, "afadeIn": 0, "afadeOut": 0, "fit": "fill", "zoom": 1, "zoomEnd": None,
                               "x": 0, "y": 0, "effect": "none", "gap": 0})
            self.tags.append(c["tag"])
        self.overlays, self.texts, self.sfx = [], [], []
        self.media_ids = {}
        self._layout()

    # ---- timeline ----
    def _layout(self):  # mirrors relayout + transDur in model.js
        t = 0
        for i, c in enumerate(self.clips):
            d = c["out"] - c["in"]
            td = 0
            if c.get("trans") and i:
                prev = self.clips[i - 1]
                td = round(min(c["trans"]["dur"], (prev["out"] - prev["in"]) * 0.5, d * 0.5) * FPS) / FPS
            c["start"] = max(0, t - td)
            t = c["start"] + d
        self.total = t

    def tl(self, src, tag=None):
        for c, tg in zip(self.clips, self.tags):
            if (tag is None or tg == tag) and c["in"] - 1e-3 <= src <= c["out"] + 1e-3:
                return c["start"] + (src - c["in"])
        raise KeyError(f"source time {src} (tag {tag}) is not in any clip: was it cut?")

    def word_start(self, wid, tag=None):
        w = self.words[wid]
        return self.tl(max(w["start"], self._clip_of(w, tag)["in"]), tag)

    def word_end(self, wid, tag=None):
        w = self.words[wid]
        return self.tl(min(w["end"], self._clip_of(w, tag)["out"]), tag)

    def _clip_of(self, w, tag):
        m = (w["start"] + w["end"]) / 2
        for c, tg in zip(self.clips, self.tags):
            if (tag is None or tg == tag) and c["in"] - 0.15 <= m <= c["out"] + 0.15:
                return c
        raise KeyError(f"word {w['text']} ({w['id']}) is not in the cut")

    def tag_start(self, tag):
        return min(c["start"] for c, t in zip(self.clips, self.tags) if t == tag)

    def tag_end(self, tag):
        return max(c["start"] + c["out"] - c["in"] for c, t in zip(self.clips, self.tags) if t == tag)

    # ---- look ----
    def transition_before(self, tag, kind="fadewhite", dur=0.2):
        i = self.tags.index(tag)
        self.clips[i]["trans"] = {"type": kind, "dur": dur}
        self._layout()

    def _media(self, path):
        path = str(Path(path).expanduser().resolve())
        if path not in self.media_ids:
            self.media_ids[path] = api(self.api, "/api/media/import", {"path": path})["id"]
        return self.media_ids[path]

    # ---- polish (see references/style.md for where each number comes from) ----
    def zoom_eyes(self, eye_y=0.33, levels=(1.0, 1.08), punch=1.16, punch_tags=(), hook_tag=None, hook=(1.10, 1.18)):
        """Medium/tight alternation on every cut with the EYES LOCKED to one height (a zoom
        around the frame centre makes the eyes jump: an AI-edit tell). Shorts pans a zoomed clip
        by y in [-1, 1]; eyes at frame height e stay put at any zoom when y = 2e - 1.
        The first clip of each punch tag (payoff lines) gets a bigger punch-in."""
        py = round(2 * eye_y - 1, 3)
        k, seen = 0, set()
        for c, t in zip(self.clips, self.tags):
            c["y"] = py
            if t == hook_tag:
                c["zoom"], c["zoomEnd"] = hook
            elif t in punch_tags and t not in seen:
                c["zoom"] = punch
            else:
                c["zoom"] = levels[k % len(levels)]
                k += 1
            seen.add(t)

    def sticker_pop(self, path, start=None, until=None, at_word=None, x=0.8, y=0.36, scale=0.2, tilt=-4):
        """Full-colour sticker logo that pops in: 70% -> 110% (7 frames) -> 100% (5 frames), tilt
        settling from tilt-5 to tilt and a small rise; holds; exits scaling to 0 over 9 frames
        (exit ~75% of the entrance). Place beside the head (x 0.8, y 0.36), never on the face or
        the caption band. Needs the scale-keyframe export fix in server.py (2026-11-03)."""
        s = self.word_start(at_word) - 0.03 if at_word is not None else start
        d = round(until - s, 3)
        f = lambda n: round(n / FPS, 3)
        o = {"id": uid(), "mid": self._media(path), "start": snap(s), "in": 0, "out": d, "speed": 1, "volume": 1,
             "mute": False, "x": x, "y": y, "scale": scale, "opacity": 1, "cover": False, "fadeIn": f(2), "fadeOut": f(5),
             "rotate": tilt,
             "kf": {"scale": [{"t": 0, "v": round(scale * 0.7, 4)}, {"t": f(7), "v": round(scale * 1.1, 4)},
                              {"t": f(12), "v": scale}, {"t": round(d - f(9), 3), "v": scale}, {"t": d, "v": round(scale * 0.05, 4)}],
                    "rotate": [{"t": 0, "v": tilt - 5}, {"t": f(12), "v": tilt}],
                    "y": [{"t": 0, "v": round(y + 0.02, 4)}, {"t": f(10), "v": y}]}}
        self.overlays.append(o)
        return o

    def image(self, path, start, until, x=0.5, y=0.5, scale=0.8, fade=(0.1, 0.15)):
        """Static image overlay (a panel behind a logo row, a screenshot)."""
        o = {"id": uid(), "mid": self._media(path), "start": snap(start), "in": 0, "out": round(until - start, 3), "speed": 1,
             "volume": 1, "mute": False, "x": x, "y": y, "scale": scale, "opacity": 1, "cover": False,
             "fadeIn": fade[0], "fadeOut": fade[1]}
        self.overlays.append(o)
        return o

    def text_width(self, text, size, font="Montserrat", weight=900, pad=0.6):
        """Width of a text clip as a fraction of the canvas: measured with the same font file
        Shorts draws with (+ the box padding), capped at its 0.86 wrap width."""
        def estimate(line):  # Montserrat Black advance widths, as a fraction of the font size
            return sum(0.30 if c == " " else 0.32 if c in ".,:;'!|·" else 0.74 if c.isupper() or c.isdigit()
                       else 0.85 if c in "mwMW" else 0.62 for c in line) * size
        try:
            from PIL import ImageFont
            ft = ImageFont.truetype(str(Path(__file__).resolve().parents[4] / "static/fonts" / f"{font}.ttf"), int(size))
            try:
                ft.set_variation_by_axes([weight])
            except Exception:
                pass
            measure = ft.getlength
        except (ImportError, OSError):
            measure = estimate
        w = max(measure(line) for line in text.split("\n")) + pad * size
        return min(w / self.canvas[0], 0.86)

    def fit_x(self, t, x=None, align="left", margin=0.035):
        """Place a text clip so it never leaves the frame: left-aligned at the margin (cards on
        a 16:9 canvas), or centred at x but pushed inside the frame."""
        st = t["style"]
        w = self.text_width(t["text"], st["size"], st.get("font", "Montserrat"), st.get("weight", 900))
        if align == "left":
            t["x"] = round(margin + w / 2, 4)
        else:
            cx = t["x"] if x is None else x
            t["x"] = round(min(max(cx, margin + w / 2), 1 - margin - w / 2), 4)
        return t

    def card(self, text, start, end, y=0.13, size=60, align="center", x=None):
        """The one card style (white rounded box, black Montserrat 900, sentence case, slide in).
        One type size across the video; at most 2 lines. align="left" pins it to the left margin
        (16:9 chapter cards); centred cards are pushed inside the frame if they'd overflow."""
        t = self.title(text, start, end, preset="title-box", size=size, y=y, anim="slide")
        return self.fit_x(t, x, align)

    def title_card(self, text, start, end, style="frosted", accent=(), y=0.13, size=64, x=0.5):
        """A styled title card (graphics.title_card) as an image overlay with a small pop-in.
        Styles, each with a job so a mix reads as designed: "marker" (accent word on a tilted
        yellow tag) for the hook, "frosted" (smoked glass, accent word yellow) for key points,
        "plain" (no box, white + yellow, soft shadow) for one-line statements and numbers.
        The PNG lives in <data>/cards so the project keeps working after the edit."""
        import struct
        import subprocess
        d = self.data / "cards"
        d.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha1(json.dumps([text, style, list(accent), size]).encode()).hexdigest()[:12]
        p = d / f"card-{style}-{key}.png"
        if not p.exists():  # graphics.py runs on the system python3 + Pillow (the app venv has no Pillow)
            subprocess.run([shutil.which("python3") or "python3", "-c",
                            "import sys, json; sys.path.insert(0, sys.argv[1]); from graphics import title_card; "
                            "title_card(*json.loads(sys.argv[2]))",
                            str(Path(__file__).parent), json.dumps([text, str(p), style, list(accent), size])], check=True)
        scale = round(struct.unpack(">I", p.read_bytes()[16:20])[0] / self.canvas[0], 4)  # PNG width
        # never off the frame: a wide card asked to sit at x 0.24 got its first letter cut (Ep. 2, 2026-11-05).
        # The PNG carries ~50 px of shadow padding each side, so the visible card keeps a margin.
        x = round(min(max(x, scale / 2 + 0.01), 1 - scale / 2 - 0.01), 4)
        dur = round(end - start, 3)
        f = lambda n: round(n / FPS, 3)
        o = {"id": uid(), "mid": self._media(p), "start": snap(start), "in": 0, "out": dur, "speed": 1, "volume": 1,
             "mute": False, "x": x, "y": y, "scale": scale, "opacity": 1, "cover": False, "fadeIn": f(3), "fadeOut": f(5),
             "kf": {"scale": [{"t": 0, "v": round(scale * 0.9, 4)}, {"t": f(6), "v": round(scale * 1.03, 4)},
                              {"t": f(10), "v": scale}],
                    "y": [{"t": 0, "v": round(y + 0.012, 4)}, {"t": f(8), "v": y}]}}
        self.overlays.append(o)
        return o

    # ---- explainer UI (ui.py components; rules in references/motion-design.md) ----------------
    def _ui_scale(self, png, size=1.0):
        """ui.py PNGs are drawn at 2x in design px (1 design px = 1 canvas px on 1080x1920 and on 1920x1080)."""
        w = struct.unpack(">I", Path(png).read_bytes()[16:20])[0] / 2
        k = min(self.canvas) / 1080 * size
        return round(w * k / self.canvas[0], 4), k

    def ui_render(self, component, *args, **kw):
        """Render a ui.py component (stepper / list_panel / ring) with the system python3 + Pillow.
        Returns the PNG path (and writes <png>.json geometry for steppers)."""
        import subprocess
        d = self.data / "ui"
        d.mkdir(parents=True, exist_ok=True)
        ver = hashlib.sha1((Path(__file__).parent / "ui.py").read_bytes()).hexdigest()[:8]  # design changes re-render
        key = hashlib.sha1(json.dumps([component, args, kw, ver], sort_keys=True).encode()).hexdigest()[:12]
        out = d / f"{component}-{key}.png"
        if not out.exists():
            subprocess.run([shutil.which("python3") or "python3", str(Path(__file__).parent / "ui.py"), component,
                            json.dumps([list(args) + [str(out)], kw])], check=True,
                           capture_output=True)
        return out

    def ui_panel(self, png, start, until, x, y, size=1.0, enter=True, leave=True):
        """A UI panel: fades up into place (8 frames, opacity 0->1, 12 px rise, 97%->100%), holds, fades
        out (6 frames). No bounce, no tilt: bounce is for stickers, not interface."""
        s, _ = self._ui_scale(png, size)
        d = round(until - start, 3)
        f = lambda n: round(n / FPS, 3)
        kf = {}
        if enter:
            kf = {"opacity": [{"t": 0, "v": 0}, {"t": f(8), "v": 1}],
                  "y": [{"t": 0, "v": round(y + 12 / self.canvas[1], 4)}, {"t": f(8), "v": y}],
                  "scale": [{"t": 0, "v": round(s * 0.97, 4)}, {"t": f(8), "v": s}]}
        if leave and d > f(16):
            kf.setdefault("opacity", [{"t": 0, "v": 1}]).extend([{"t": round(d - f(6), 3), "v": 1}, {"t": d, "v": 0}])
        o = {"id": uid(), "mid": self._media(png), "start": snap(start), "in": 0, "out": d, "speed": 1, "volume": 1,
             "mute": False, "x": x, "y": y, "scale": s, "opacity": 1, "cover": False, "fadeIn": 0, "fadeOut": 0, "kf": kf}
        self.overlays.append(o)
        return o

    def ui_states(self, frames, until, x, y, size=1.0):
        """A panel that changes state in place: frames = [(png, start), ...]. The first fades up, the
        others replace it instantly on their word (a state change, like real UI), the last fades out."""
        out = []
        for i, (png, t) in enumerate(frames):
            end = frames[i + 1][1] if i + 1 < len(frames) else until
            out.append(self.ui_panel(png, t, end, x, y, size, enter=(i == 0), leave=(i == len(frames) - 1)))
        return out

    def ui_ping(self, png_ring, at, x, y, size=1.0):
        """Focus ring on a node that just became current: 90% -> 160% and fades out over 12 frames."""
        s, _ = self._ui_scale(png_ring, size)
        f = lambda n: round(n / FPS, 3)
        o = {"id": uid(), "mid": self._media(png_ring), "start": snap(at), "in": 0, "out": f(12), "speed": 1, "volume": 1,
             "mute": False, "x": x, "y": y, "scale": s, "opacity": 1, "cover": False, "fadeIn": 0, "fadeOut": 0,
             "kf": {"scale": [{"t": 0, "v": round(s * 0.9, 4)}, {"t": f(12), "v": round(s * 1.6, 4)}],
                    "opacity": [{"t": 0, "v": 0.9}, {"t": f(12), "v": 0}]}}
        self.overlays.append(o)
        return o

    def ui_node(self, png, node, x, y, size=1.0):
        """Canvas position of stepper node `node` for a panel placed at (x, y) (reads <png>.json)."""
        geo = json.loads(Path(str(png) + ".json").read_text())
        _, k = self._ui_scale(png, size)
        dx, dy = geo["nodes"][node]
        return round(x + dx * k / self.canvas[0], 4), round(y + dy * k / self.canvas[1], 4)

    def number(self, big, label, start, end, y=0.17, accent="#FFD23F", x=None):
        """Key-number callout: the number in the accent colour, a white label under it."""
        st = dict(TEXT_PRESETS["classic"], font="Montserrat", weight=900, size=210, color=accent, stroke=0, shadow=24)
        lab = dict(TEXT_PRESETS["classic"], font="Montserrat", weight=800, size=58, stroke=0, shadow=20)
        a = self.title(big, start, end, y=y, anim="slide")
        a["style"] = dict(st, maxWidth=0.86, lineHeight=1.0)
        if x is not None:
            self.fit_x(a, x, "center")
        if not label:  # when the captions already say it, the number alone is cleaner
            return a, None
        b = self.title(label, start + 0.1, end, y=y + 0.085, anim="slide")
        b["style"] = dict(lab, maxWidth=0.86, lineHeight=1.1)
        if x is not None:
            b["x"] = a["x"]
        return a, b

    def whoosh_into(self, t, name="Whoosh", peak=0.35, volume=0.9):
        """Whoosh whose peak lands on the first frame of the new shot (Whoosh.wav peaks at 0.35 s).
        0.9 puts it ~15 dB under the voice (listen.py); 0.35 was barely audible."""
        self.add_sfx(name, t - peak, volume)

    def title(self, text, start, end, preset="title-box", size=None, y=0.12, anim="pop"):
        st = dict(TEXT_PRESETS[preset], maxWidth=0.86, lineHeight=1.2)
        if size:
            st["size"] = size
        t = {"id": uid(), "start": snap(start), "dur": round(end - start, 3), "text": text, "style": st, "preset": preset,
             "x": 0.5, "y": y, "anim": anim, "animOut": "fade", "opacity": 1}
        self.texts.append(t)
        return t

    def add_sfx(self, name, start, volume=0.4):
        path = self.data / "sfx" / f"{name}.wav"
        mid = self._media(path)
        dur = api(self.api, f"/api/media?ids={mid}")[0]["duration"]
        self.sfx.append({"id": uid(), "mid": mid, "start": snap(max(0, start)), "in": 0, "out": dur, "speed": 1,
                         "volume": volume, "mute": False, "fadeIn": 0, "fadeOut": 0, "duck": False})

    def sfx_on_overlays(self, name="Pop", volume=0.5):
        for o in self.overlays:
            self.add_sfx(name, o["start"], volume)

    # ---- save ----
    @staticmethod
    def _rows(items, length):
        rows = []
        for c in sorted(items, key=lambda c: c["start"]):
            for r in rows:
                if r[-1]["start"] + length(r[-1]) <= c["start"] + 1e-6:
                    r.append(c)
                    break
            else:
                rows.append([c])
        return rows

    def project(self, pid, captions, word_edits, audio=None):
        self._layout()
        tracks = [{"id": "main", "kind": "main", "clips": self.clips, "name": "Main"}]
        vlen = lambda c: c["out"] - c["in"]
        tracks += [{"id": uid(), "kind": "video", "clips": r, "name": f"Video {i + 1}"}
                   for i, r in enumerate(self._rows(self.overlays, vlen))]
        tracks += [{"id": uid(), "kind": "text", "clips": r, "name": f"Text {i + 1}"}
                   for i, r in enumerate(self._rows(self.texts, lambda c: c["dur"]))]
        tracks += [{"id": uid(), "kind": "audio", "clips": r, "name": f"Audio {i + 1}"}
                   for i, r in enumerate(self._rows(self.sfx, vlen))]
        return {"version": 2, "id": pid, "name": self.name, "canvas": {"w": self.canvas[0], "h": self.canvas[1], "fps": 30, "bg": "blur"},
                "media": [self.mid] + sorted(set(self.media_ids.values())), "tracks": tracks, "captions": captions,
                "wordEdits": {self.mid: {str(k): v for k, v in word_edits.items()}},
                # breaths: Shorts dips every breath left inside a clip by 24 dB. On by default.
                "audio": dict({"normalize": True, "lufs": -14, "enhance": False, "repair": True, "breaths": True}, **(audio or {})),
                "markers": [], "magnet": True}

    def check_captions(self, plan_clips, fix=True):
        """Every kept word must be shown by Shorts' captions (word middle inside a clip)."""
        shown = set()
        for c in self.clips:
            for w in self.words.values():
                if c["in"] <= (w["start"] + w["end"]) / 2 < c["out"]:
                    shown.add(w["id"])
        missing = [(c, i) for c in plan_clips for i in c.get("ids", []) if i not in shown]
        if missing and fix:
            # Only on an edit copy (make_edit_media): its words.json belongs to this edit alone.
            # A joint moved by joints.py can leave a kept word's time range hanging over the clip
            # edge: clamp it into the clip so its middle is inside and Shorts shows it.
            wpath = self.data / "media" / self.mid / "words.json"
            d = json.load(open(wpath))
            by = {w["id"]: w for w in d["words"]}
            for c, i in missing:
                w = by[i]
                s, e = max(w["start"], c["in"] + 0.005), min(w["end"], c["out"] - 0.005)
                if e - s < 0.06:
                    s, e = (c["in"] + 0.005, c["in"] + 0.08) if w["start"] < c["in"] else (c["out"] - 0.08, c["out"] - 0.005)
                w["start"], w["end"] = round(s, 3), round(e, 3)
                self.words[i] = dict(self.words[i], start=w["start"], end=w["end"])
            json.dump(d, open(wpath, "w"))
            bp = self.data / "media" / self.mid / "breaths.json"
            if bp.exists():
                os.utime(bp)  # keep the breath map newer than words.json, or Shorts recomputes it
            print(f"CAPTIONS: clamped {len(missing)} edge words into their clips: {[self.words[i]['text'] for _, i in missing]}")
            return self.check_captions(plan_clips, fix=False)
        if missing:
            print(f"CAPTIONS: {len(missing)} kept words won't show: {[self.words[i]['text'] for _, i in missing]}")
        return missing

    def save(self, base_captions_from=None, caption_size=None, word_edits=None, captions=None, audio=None, pid=None,
             glossary=None):
        if captions is None:
            if base_captions_from:  # path to a project .json whose caption style to reuse
                captions = json.load(open(Path(base_captions_from).expanduser()))["captions"]
            else:
                captions = {"enabled": True, "preset": "bold-pop"}
        if caption_size:
            captions = dict(captions, size=caption_size)
        if glossary:  # the user's glossary first, explicit word_edits win
            ws = sorted(self.words.values(), key=lambda w: w["start"])
            word_edits = dict(glossary_edits(ws, glossary), **(word_edits or {}))
        self.check_captions(self.plan_clips, fix=self.media_is_copy)
        pid = pid or api(self.api, "/api/projects", {"name": self.name})["id"]
        p = self.project(pid, captions, word_edits or {}, audio)
        api(self.api, f"/api/projects/{pid}", p)
        return pid, p
