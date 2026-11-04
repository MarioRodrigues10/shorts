#!/usr/bin/env python3
"""YouTube thumbnails from a frame of the video (run with .venv-vision/bin/python: MediaPipe + Pillow).

  thumbnail.py VIDEO.mp4 OUT_DIR --text "2 JOBS WIN" [--text "..."] [--at 12.5 --at 80] [--sticker logo.png]
  thumbnail.py VIDEO.mp4 OUT_DIR                     # scan, candidates.jpg (top 12), best frame per mood
  make(PHOTO.jpg, 0, "words", out)                   # a still photo works too, and beats any video frame:
                                                     # ask for 3 phone photos (big expressions, facing the lens)

The look that works on YouTube: the person cut out and lifted (brighter, a bit more saturated,
a white rim) over a darker, blurred background, 2-4 huge words on the empty side, one accent
colour, optional brand sticker. 1280x720 JPG, < 2 MB (YouTube's limit). Frames are picked by
face size + mouth/eyes open (MediaPipe face landmarks are not needed: a big, sharp face with
high local contrast is what reads at thumbnail size).
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

REPO = Path(__file__).resolve().parents[4]
FONT = REPO / "static/fonts/Montserrat.ttf"
ACCENT = (255, 210, 63)


def frame(video, t, w=1280, h=720):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1",
                          "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return Image.frombytes("RGB", (w, h), raw)


def scan(video, step=0.5):
    """Score every frame for a thumbnail: eyes open, looking at the camera, sharp (no motion blur),
    and three moods: smile, surprise (brows up + mouth open), confident (eyes on camera, calm mouth).
    Uses MediaPipe's face landmarker (blendshapes)."""
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    lm = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(REPO / "models/face_landmarker.task")),
        output_face_blendshapes=True, output_facial_transformation_matrixes=True, num_faces=1))
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
                               capture_output=True, text=True).stdout)
    W, H = 960, 540
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"fps={1 / step},scale={W}:{H}",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
    out, prev = [], None
    for k, f in enumerate(frames):
        r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(f)))
        g = f.mean(2)
        if not r.face_landmarks:
            prev = g
            continue
        b = {c.category_name: c.score for c in r.face_blendshapes[0]}
        pts = np.array([(p.x * W, p.y * H) for p in r.face_landmarks[0]])
        x0, y0 = pts.min(0).astype(int)
        x1, y1 = pts.max(0).astype(int)
        face = g[max(0, y0):y1, max(0, x0):x1]
        if face.size < 400:
            prev = g
            continue
        lap = np.abs(face[1:-1, 1:-1] * 4 - face[:-2, 1:-1] - face[2:, 1:-1] - face[1:-1, :-2] - face[1:-1, 2:]).mean()
        motion = float(np.abs(g[y0:y1, x0:x1] - prev[y0:y1, x0:x1]).mean()) if prev is not None else 0
        body = float(np.abs(g - prev).mean()) if prev is not None else 0  # hands flying around the frame
        prev = g
        eyes = 1 - max(b.get("eyeBlinkLeft", 0), b.get("eyeBlinkRight", 0))
        gaze = 1 - max(sum(b.get(f"eyeLook{d}{s}", 0) for s in ("Left", "Right")) / 2 for d in ("In", "Out", "Up", "Down"))
        smile = (b.get("mouthSmileLeft", 0) + b.get("mouthSmileRight", 0)) / 2
        surprise = 0.6 * b.get("browInnerUp", 0) + 0.4 * min(1, b.get("jawOpen", 0) * 2)
        calm = 1 - min(1, b.get("jawOpen", 0) * 3)
        # head pose: a face turned or tilted away from the lens reads badly at thumbnail size
        R = np.array(r.facial_transformation_matrixes[0])[:3, :3]
        pitch = float(np.degrees(np.arctan2(R[2, 1], R[2, 2])))
        yaw = float(np.degrees(np.arcsin(np.clip(-R[2, 0], -1, 1))))
        pose = float(np.exp(-(pitch ** 2 + yaw ** 2) / (2 * 14 ** 2)))
        jaw = b.get("jawOpen", 0)
        # mid-syllable mouths read as awkward; a clear smile or a big open "wow" is fine
        mouth = 1.0 if (jaw < 0.06 or jaw > 0.45 or smile > 0.45) else 0.55
        base = eyes ** 2 * gaze ** 3 * pose * mouth * min(1, lap / 6) / (1 + motion / 6) / (1 + body / 3)
        out.append({"t": round(k * step, 2), "eyes": round(eyes, 2), "gaze": round(gaze, 2), "sharp": round(float(lap), 1),
                    "motion": round(motion, 1), "body": round(body, 1), "jaw": round(jaw, 2), "pitch": round(pitch), "yaw": round(yaw), "face_h": round((y1 - y0) / H, 2),
                    "smile": round(base * (0.3 + smile), 3), "surprise": round(base * (0.3 + surprise), 3),
                    "confident": round(base * calm * (0.6 + 0.4 * gaze), 3), "best": round(base, 3)})
    return out


def cutout(im):
    """Soft person mask (MediaPipe selfie segmentation)."""
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
        base_options=BaseOptions(model_asset_path=str(REPO / "models/selfie.tflite")), output_confidence_masks=True))
    m = seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(im.convert("RGB")))).confidence_masks[0].numpy_view()
    mask = Image.fromarray((np.clip(m.squeeze(), 0, 1) * 255).astype(np.uint8)).resize(im.size)
    return mask.filter(ImageFilter.GaussianBlur(1.5))


def picks(scores, n=3, gap=6.0):
    """The best frame per mood (smile, surprise, confident), at least gap seconds apart."""
    chosen = []
    for mood in ("smile", "surprise", "confident")[:n]:
        for s in sorted(scores, key=lambda s: -s[mood]):
            if s["eyes"] > 0.6 and all(abs(s["t"] - c[1]) > gap for c in chosen):
                chosen.append((mood, s["t"], s))
                break
    return chosen


def frame_hi(video, t):
    """The source frame at full resolution."""
    w, h = (int(x) for x in subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                            "stream=width,height", "-of", "csv=p=0:s=x", str(video)],
                                           capture_output=True, text=True).stdout.strip().split("x"))
    raw = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    n = len(raw) // 3
    if n != w * h:  # rotated phone video: ffmpeg applied the rotation
        w, h = h, w
    return Image.frombytes("RGB", (w, h), raw)


def face_box(im):
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    lm = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(REPO / "models/face_landmarker.task")), num_faces=1))
    r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(im)))
    pts = np.array([(p.x * im.width, p.y * im.height) for p in r.face_landmarks[0]])
    eyes = pts[[33, 133, 362, 263]].mean(0)  # eye corners
    return pts.min(0), pts.max(0), eyes


def make(video, t, text, out, sticker=None, side="right", face_frac=0.40, face_luma=172, accent_last=True, restore=0.45,
         badge=None, rim=0.55, glow=0.12, tint=(30, 42, 58), badge_style="chip", badge_icon=None):
    """Thumbnail: face ~46% of the height, eyes on the upper third, person on one side (the frame is
    extended with a blurred fill when the source has no room), relit from the face, words huge."""
    W, H = 1280, 720
    src = Image.open(video).convert("RGB") if str(video).lower().endswith((".jpg", ".jpeg", ".png", ".heic", ".webp")) else frame_hi(video, t)
    (fx0, fy0), (fx1, fy1), (ex, ey) = face_box(src)
    k = face_frac * H / (fy1 - fy0)                       # scale so the face is face_frac of the height
    sw, sh = int(src.width * k), int(src.height * k)
    big = src.resize((sw, sh), Image.LANCZOS)
    polish_models = [REPO / "models/gfpgan_1.4.onnx", REPO / "models/arcface_w600k_r50.onnx"]
    if restore and not all(m.exists() for m in polish_models):
        print("face polish skipped: run scripts/setup.sh --face-polish to download its models", file=sys.stderr)
        restore = 0
    if restore:  # GFPGAN on the enlarged frame, blended in, with an identity guard (restore.py)
        import restore as R
        big, used, sim = R.restore_safe(big, restore, min_sim=0.965)
        print(f"face polish {used} (identity {sim:.3f})", file=sys.stderr)
    mask = cutout(big)
    want_x = 0.30 if side == "right" else 0.70
    ox, oy = int(want_x * W - ex * k), int(0.37 * H - ey * k)  # where the source lands on the canvas
    # background: the source blown up and blurred (so edges outside it never show), pushed dark,
    # tinted, with a soft light behind the person and a vignette: depth instead of flat grey
    bg = src.resize((W, H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(16))
    bg = ImageEnhance.Brightness(bg).enhance(0.30)
    bg = Image.blend(bg, Image.new("RGB", (W, H), tint), 0.45)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    lx = want_x
    light = np.exp(-(((xx / W - lx) / 0.38) ** 2 + ((yy / H - 0.42) / 0.55) ** 2))
    vig = 1 - 0.45 * np.clip(((xx / W - 0.5) ** 2 + (yy / H - 0.5) ** 2) / 0.5, 0, 1)
    b = np.asarray(bg, np.float32) * (0.75 + 0.55 * light[..., None]) * vig[..., None]
    canvas = Image.fromarray(np.clip(b, 0, 255).astype(np.uint8))
    # relight the person from the face: measured face luma -> target
    fa = np.asarray(big.convert("L"), np.float32)[int(fy0 * k + (fy1 - fy0) * k * .25):int(fy1 * k - (fy1 - fy0) * k * .25),
                                                     int(fx0 * k + (fx1 - fx0) * k * .25):int(fx1 * k - (fx1 - fx0) * k * .25)]
    gain = float(np.clip(face_luma / max(fa.mean(), 1), 1.0, 2.0))
    gamma = 1 / (1 + 0.35 * (gain - 1))                   # lift shadows more than highlights
    lut = [int(np.clip(255 * ((i / 255) ** gamma) * (1 + 0.5 * (gain - 1)), 0, 255)) for i in range(256)]
    person = big.point(lut * 3)
    person = ImageEnhance.Color(person).enhance(1.18)
    person = ImageEnhance.Contrast(person).enhance(1.06)
    person = person.filter(ImageFilter.UnsharpMask(radius=2.2, percent=110, threshold=2))
    # a thin, soft rim and a faint glow (a thick white halo reads as a cheap sticker cut-out)
    rim = mask.filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.GaussianBlur(2)).point(lambda v: int(v * rim))
    glow = mask.filter(ImageFilter.MaxFilter(21)).filter(ImageFilter.GaussianBlur(22)).point(lambda v: int(v * glow))
    lmask = Image.new("L", (W, H), 0)
    lmask.paste(glow, (ox, oy))  # soft white glow behind the person
    canvas.paste(Image.new("RGB", (W, H), (255, 255, 255)), (0, 0), lmask)
    rmask = Image.new("L", (W, H), 0); rmask.paste(rim, (ox, oy))
    canvas.paste(Image.new("RGB", (W, H), (255, 255, 255)), (0, 0), rmask)
    pm = Image.new("L", (W, H), 0); pm.paste(mask, (ox, oy))
    pl = Image.new("RGB", (W, H)); pl.paste(person, (ox, oy))
    canvas.paste(pl, (0, 0), pm)
    # words: 2-3 balanced lines filling the other side
    d = ImageDraw.Draw(canvas)
    words = text.upper().split()
    n = 3 if len(words) >= 5 else 2 if len(words) >= 2 else 1
    import itertools
    best = None
    for cuts in itertools.combinations(range(1, len(words)), n - 1):
        parts = [" ".join(words[a:b]) for a, b in zip((0,) + cuts, cuts + (len(words),))]
        if best is None or max(map(len, parts)) < max(map(len, best)):
            best = parts
    lines = best or [" ".join(words)]
    area = (int(W * 0.55), int(W * 0.965)) if side == "right" else (int(W * 0.035), int(W * 0.45))
    top = int(H * 0.30) if sticker else int(H * 0.12)
    size = 230
    while size > 60:
        f = ImageFont.truetype(str(FONT), size)
        try:
            f.set_variation_by_axes([900])
        except Exception:
            pass
        if max(d.textlength(l, font=f) for l in lines) <= area[1] - area[0] and size * 1.0 * len(lines) <= H - top - H * 0.08:
            break
        size -= 4
    lh = int(size * 1.0)
    y = top + (H - top - H * 0.06 - lh * len(lines)) // 2
    text_top = y
    for i, l in enumerate(lines):
        x = area[1] - int(d.textlength(l, font=f)) if side == "right" else area[0]
        fill = ACCENT if (accent_last and i == len(lines) - 1) else (255, 255, 255)
        d.text((x + 8, y + 10), l, font=f, fill=(0, 0, 0))
        d.text((x, y), l, font=f, fill=fill, stroke_width=9, stroke_fill=(0, 0, 0))
        y += lh
    if sticker:
        st = Image.open(sticker).convert("RGBA")
        st.thumbnail((int(W * 0.30), int(H * 0.26)))
        sx = area[1] - st.width if side == "right" else area[0]
        canvas.paste(st, (sx, int(H * 0.05)), st)
    if badge:
        canvas = draw_badge(canvas, badge, badge_style, area, text_top, side, badge_icon)
    canvas.save(out, quality=93)
    return out


def draw_badge(canvas, badge, style, area, text_top, side, icon=None):
    """Series label above the words. badge = "LABEL|EP 1" (chip) or "EP 1" (ep).
    chip: frosted dark chip with an optional brand icon + white label, then a solid accent block
          with the episode in black: reads as a real series mark, not a placeholder pill.
    ep:   just a tilted accent tab with the episode, tucked above the words."""
    W, H = canvas.size
    label, ep = (badge.split("|", 1) + [""])[:2] if "|" in badge else ("", badge)
    lf, ef = ImageFont.truetype(str(FONT), 30), ImageFont.truetype(str(FONT), 36)
    for f_, w_ in ((lf, 800), (ef, 900)):
        try:
            f_.set_variation_by_axes([w_])
        except Exception:
            pass
    d0 = ImageDraw.Draw(canvas)
    if style == "ep" or not label:
        tw = int(d0.textlength(ep, font=ef))
        tab = Image.new("RGBA", (tw + 44, 66), (0, 0, 0, 0))
        ImageDraw.Draw(tab).rounded_rectangle((0, 0, tw + 43, 65), 14, fill=ACCENT + (255,))
        ImageDraw.Draw(tab).text(((tw + 44) // 2, 34), ep, font=ef, fill=(0, 0, 0), anchor="mm")
        tab = tab.rotate(4, resample=Image.BICUBIC, expand=True)
        x = area[1] - tab.width if side == "right" else area[0]
        y = text_top - tab.height - 18
    else:
        ic = 0
        if icon:
            ico = Image.open(icon).convert("RGBA")
            ico.thumbnail((38, 38))
            ic = ico.width + 12
        lw, ew = int(d0.textlength(label, font=lf)), int(d0.textlength(ep, font=ef))
        h = 64
        wl, we = 24 + ic + lw + 22, ew + 40
        tab = Image.new("RGBA", (wl + we, h), (0, 0, 0, 0))
        td = ImageDraw.Draw(tab)
        td.rounded_rectangle((0, 0, wl + we - 1, h - 1), 18, fill=(12, 14, 18, 215))
        td.rounded_rectangle((wl, 0, wl + we - 1, h - 1), 18, fill=ACCENT + (255,))
        td.rectangle((wl, 0, wl + 18, h - 1), fill=ACCENT + (255,))
        td.rounded_rectangle((0, 0, wl + we - 1, h - 1), 18, outline=(255, 255, 255, 70), width=2)
        if icon:
            tab.alpha_composite(ico, (22, (h - ico.height) // 2))
        td.text((24 + ic, h // 2 + 1), label, font=lf, fill=(255, 255, 255), anchor="lm")
        td.text((wl + we // 2, h // 2 + 1), ep, font=ef, fill=(0, 0, 0), anchor="mm")
        x = area[1] - tab.width if side == "right" else area[0]
        y = text_top - h - 22
    x, y = int(x), int(y)
    sh = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    m = Image.new("L", canvas.size, 0)
    m.paste(tab.getchannel("A"), (x, y + 8))
    sh.putalpha(m.filter(ImageFilter.GaussianBlur(10)).point(lambda v: int(v * 0.5)))
    out = canvas.convert("RGBA")
    out.alpha_composite(sh)
    out.alpha_composite(tab, (x, y))
    return out.convert("RGB")


def faces_sheet(video, scores, out, n=24, gap=4.0):
    """Close-ups of the n most expressive usable moments (>= gap s apart), labelled with their time:
    the sheet the user (and you) pick a thumbnail face from. Returns the chosen score rows."""
    good = [s for s in scores if s["eyes"] > 0.65 and abs(s.get("pitch", 0)) < 12 and abs(s.get("yaw", 0)) < 14
            and s.get("body", 0) < 6]
    for s in good:
        s["expr"] = max(s["smile"], s["surprise"], s["confident"])
    good.sort(key=lambda s: -s["expr"])
    f = ImageFont.truetype(str(FONT), 22)
    pick, tiles = [], []
    for s in good:
        if len(tiles) == n:
            break
        if any(abs(s["t"] - q["t"]) < gap for q in pick):
            continue
        im = frame_hi(video, s["t"])
        try:
            (x0, y0), (x1, y1), _ = face_box(im)
        except IndexError:
            continue
        pick.append(s)
        cx, cy, h = (x0 + x1) / 2, (y0 + y1) / 2, (y1 - y0)
        c = im.crop((int(cx - h * .9), int(cy - h), int(cx + h * .9), int(cy + h))).resize((300, 333), Image.LANCZOS)
        d = ImageDraw.Draw(c)
        d.rectangle((0, 0, 300, 30), fill=(0, 0, 0))
        d.text((8, 3), f"{s['t']:.2f}s", font=f, fill=(255, 220, 0))
        tiles.append((s["t"], c))
    tiles.sort(key=lambda x: x[0])
    g = Image.new("RGB", (300 * 6, 333 * ((len(tiles) + 5) // 6)), (20, 20, 20))
    for i, (_, t) in enumerate(tiles):
        g.paste(t, ((i % 6) * 300, (i // 6) * 333))
    g.save(out, quality=88)
    return sorted(pick, key=lambda s: -s["expr"])


def main():
    """Step 1 (explore): thumbnail.py VIDEO OUT --text "WORDS" [--text ...] [--sticker a.png ...]
                                [--badge "SERIES LABEL|EP N"] [--badge-icon brand_icon_white.png] [--badge-style chip|ep]
         -> OUT/faces.jpg (24 face close-ups to pick from), OUT/A..F.jpg + OUT/all.jpg (experiments:
            the best distinct expressions x the texts/stickers), OUT/scores.json
       Step 2 (final):   thumbnail.py VIDEO OUT --final SECONDS "WORDS" [--sticker a.png] [--badge "..."]
         -> OUT/THUMBNAIL.jpg + OUT/THUMBNAIL_mobile.png (how it reads at 168x94)
       A still photo works in place of VIDEO (use SECONDS 0)."""
    import json
    a = sys.argv
    video, outdir = Path(a[1]), Path(a[2])
    outdir.mkdir(parents=True, exist_ok=True)
    opt = lambda k: [a[i + 1] for i, x in enumerate(a) if x == k]
    badge = opt("--badge")[0] if "--badge" in a else None
    bstyle = opt("--badge-style")[0] if "--badge-style" in a else "chip"
    bicon = opt("--badge-icon")[0] if "--badge-icon" in a else None
    stickers = opt("--sticker")
    if "--final" in a:
        i = a.index("--final")
        t, words = float(a[i + 1]), a[i + 2]
        out = make(video, t, words, outdir / "THUMBNAIL.jpg", sticker=stickers[0] if stickers else None, badge=badge,
                   badge_style=bstyle, badge_icon=bicon)
        Image.open(out).resize((168, 94), Image.LANCZOS).save(outdir / "THUMBNAIL_mobile.png")
        print(out)
        return
    sj = outdir / "scores.json"
    scores = json.load(open(sj)) if sj.exists() else scan(video, step=0.25)
    json.dump(scores, open(sj, "w"))
    pick = faces_sheet(video, scores, outdir / "faces.jpg")
    texts = opt("--text") or ["YOUR WORDS HERE"]
    variants = []
    for k, s in enumerate(pick[:6]):
        variants.append((s["t"], texts[k % len(texts)], stickers[k % len(stickers)] if stickers and k % 2 == 0 else None))
    tiles = []
    for letter, (t, words, st) in zip("ABCDEF", variants):
        out = make(video, t, words, outdir / f"{letter}.jpg", sticker=st, badge=badge, badge_style=bstyle, badge_icon=bicon)
        im = Image.open(out).resize((640, 360), Image.LANCZOS)
        ImageDraw.Draw(im).text((10, 6), f"{letter}  {t:.2f}s", font=ImageFont.truetype(str(FONT), 26), fill=(255, 220, 0),
                                stroke_width=3, stroke_fill=(0, 0, 0))
        tiles.append(im)
    g = Image.new("RGB", (640 * 3, 360 * ((len(tiles) + 2) // 3)), (20, 20, 20))
    for i, im in enumerate(tiles):
        g.paste(im, ((i % 3) * 640, (i // 3) * 360))
    g.save(outdir / "all.jpg", quality=88)
    print(f"{outdir}/faces.jpg  (pick a face)\n{outdir}/all.jpg  (A-F experiments)")


if __name__ == "__main__":
    main()
