#!/usr/bin/env python3
"""Measure how a short is edited, so a style can be compared with numbers instead of vibes.

Usage (run with the vision venv: .venv-vision/bin/python, it has MediaPipe + numpy):
  fingerprint.py VIDEO.mp4 [VIDEO2.mp4 ...] [--json OUT.json]
  fingerprint.py --compare MINE.mp4 REFS_DIR        # me vs the median of every reference video

Per video:
  cuts_per_s / median_shot_s   hard cuts and jump cuts (frame-difference spikes)
  punchins_per_min             cuts where the face size changes >= 6% (zoom between shots)
  eye_drift                    how much the eye line moves across cuts (fraction of height)
  face_size                    median face height / frame height (how tight the framing is)
  no_face_share                share of time with no face: B-roll, screenshots, full-screen graphics
  visual_change_s              median seconds between "something new on screen" (cut, B-roll
                               start/end, a title appearing)
  text_share / text_top_share  share of sampled frames with any on-screen text / text in the top 40%
  caption_y / caption_h        where captions sit and how tall the letters are (of frame height)
  floor_db / bass_share         music bed signals: quietest 5% vs speech, and energy below 100 Hz
  lufs                         integrated loudness
  luma / contrast / saturation / sharpness   the look (grade and source quality)
Text needs `tesseract` on PATH (OCR, 1 frame/s). Everything runs on CPU.
"""
import json
import math
import re
import shutil
import statistics as st
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[4]
FPS = 5
W, H = 270, 480


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height:format=duration", "-of", "json", str(path)], capture_output=True, text=True).stdout
    d = json.loads(out)
    return d["streams"][0]["width"], d["streams"][0]["height"], float(d["format"]["duration"])


def frames(path, fps=FPS, w=W, h=H):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease,"
                          f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)


def cuts(path):
    """Cut times from consecutive frames at the video's own rate (small greyscale): a jump cut on
    the same background barely registers between frames 0.2 s apart, but stands out between
    neighbouring frames, where normal motion is tiny."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", "scale=90:160,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    g = np.frombuffer(raw, np.uint8).reshape(-1, 160, 90).astype(np.float32)
    rate = len(g) / probe(path)[2]
    d = np.abs(np.diff(g, axis=0)).mean((1, 2))
    if len(d) < 5:
        return []
    out, last = [], -1e9
    for i in range(1, len(d) - 1):
        lo, hi = max(0, i - 15), min(len(d), i + 16)
        win = d[lo:hi][d[lo:hi] > 0.3]  # ignore duplicated frames (30 fps footage in a 60 fps file)
        local = float(np.median(win)) if len(win) else 0.3
        if d[i] > max(2.5, 4 * local) and d[i] >= d[i - 1] and d[i] >= d[i + 1] and i - last > rate * 0.2:
            out.append((i + 1) / rate)
            last = i
    return out


def faces(fr):
    try:
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision
    except ImportError:
        return [None] * len(fr)
    det = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(
        base_options=BaseOptions(model_asset_path=str(REPO / "models/face.tflite")), min_detection_confidence=0.5))
    out = []
    for f in fr:
        r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(f)))
        if not r.detections:
            out.append(None)
            continue
        b = max(r.detections, key=lambda d: d.bounding_box.height).bounding_box
        kp = r.detections[0].keypoints  # 0, 1 = eyes
        eye_y = (kp[0].y + kp[1].y) / 2 if len(kp) >= 2 else (b.origin_y + 0.4 * b.height) / H
        out.append({"h": b.height / H, "eye_y": eye_y, "cx": (b.origin_x + b.width / 2) / W})
    return out


def ocr(path, dur):
    if not shutil.which("tesseract"):
        return None
    tmp = Path(tempfile.mkdtemp())
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", "fps=1,scale=540:960:force_original_aspect_ratio=decrease,"
                    "pad=540:960:(ow-iw)/2:(oh-ih)/2", str(tmp / "f%04d.png")], check=True)
    res = []
    for f in sorted(tmp.glob("f*.png")):
        tsv = subprocess.run(["tesseract", str(f), "-", "--psm", "11", "tsv"], capture_output=True, text=True).stdout
        boxes = []
        for line in tsv.splitlines()[1:]:
            c = line.split("\t")
            if len(c) < 12 or not c[11].strip() or not re.search(r"[A-Za-z0-9]{2,}", c[11]):
                continue
            try:
                conf = float(c[10])
            except ValueError:
                continue
            if conf < 70:
                continue
            top, hgt = int(c[7]), int(c[9])
            boxes.append({"y": (top + hgt / 2) / 960, "h": hgt / 960, "word": c[11]})
        res.append(boxes)
    shutil.rmtree(tmp, ignore_errors=True)
    return res


def audio(path):
    """(floor_db, bass_share, lufs). floor_db: the quietest 5% of 50 ms frames vs loud speech (a
    music bed keeps it high, ~-20..-30; a bare voice edit sits lower). bass_share: energy below
    100 Hz, where music beds put kick and bass and voices put almost nothing (bare voice ~0.01-0.03)."""
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                         capture_output=True).stdout
    a = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    if len(a) < 16000:
        return None, None, None
    fr = a[: len(a) // 800 * 800].reshape(-1, 800)
    lv = 20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-9)
    floor = float(np.percentile(lv, 5) - np.percentile(lv, 85))
    loud = fr[lv > np.percentile(lv, 30)]
    sp = np.abs(np.fft.rfft(loud * np.hanning(800), axis=1)) ** 2
    f = np.fft.rfftfreq(800, 1 / 16000)
    bass = float(sp[:, f < 100].sum() / (sp.sum() + 1e-12))
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", r)
    return round(floor, 1), round(bass, 3), (float(m[-1]) if m else None)


def look(fr):
    f = fr[:: max(1, len(fr) // 40)].astype(np.float32)
    luma = 0.2126 * f[..., 0] + 0.7152 * f[..., 1] + 0.0722 * f[..., 2]
    mx, mn = f.max(3), f.min(3)
    sat = np.where(mx > 0, (mx - mn) / (mx + 1e-6), 0)
    lap = np.abs(luma[:, 1:-1, 1:-1] * 4 - luma[:, :-2, 1:-1] - luma[:, 2:, 1:-1] - luma[:, 1:-1, :-2] - luma[:, 1:-1, 2:])
    return round(float(luma.mean()), 1), round(float(luma.std()), 1), round(float(sat.mean()), 3), round(float(lap.mean()), 2)


def fingerprint(path):
    w, h, dur = probe(path)
    fr = frames(path)
    cs = cuts(path)
    fc = faces(fr)
    n = len(fr)
    shots = np.diff([0.0] + cs + [n / FPS])
    # punch-ins: face size changes across a cut
    punch, drift = 0, []
    for c in cs:
        i = int(c * FPS)
        a = next((fc[k] for k in range(i - 1, max(-1, i - 4), -1) if fc[k]), None)
        b = next((fc[k] for k in range(i, min(n, i + 3)) if fc[k]), None)
        if a and b:
            if abs(a["h"] - b["h"]) / max(a["h"], 1e-6) >= 0.06:
                punch += 1
            drift.append(abs(a["eye_y"] - b["eye_y"]))
    noface = [f is None for f in fc]
    events = set(round(c, 1) for c in cs)
    for k in range(1, n):
        if noface[k] != noface[k - 1]:
            events.add(round(k / FPS, 1))
    tx = ocr(path, dur)
    text_share = top_share = cap_y = cap_h = None
    if tx is not None:
        has = [bool(b) for b in tx]
        top = [any(x["y"] < 0.4 for x in b) for b in tx]
        text_share, top_share = round(sum(has) / max(1, len(tx)), 2), round(sum(top) / max(1, len(tx)), 2)
        for k in range(1, len(top)):
            if top[k] and not top[k - 1]:
                events.add(float(k))
        low = [x for b in tx for x in b if x["y"] >= 0.4]
        if low:
            cap_y, cap_h = round(st.median(x["y"] for x in low), 2), round(st.median(x["h"] for x in low), 3)
    ev = sorted(events)
    gaps = np.diff([0.0] + ev + [dur]) if ev else [dur]
    floor, bass, lufs = audio(path)
    luma, contrast, sat, sharp = look(fr)
    fh = [f["h"] for f in fc if f]
    return {"file": Path(path).name, "res": f"{w}x{h}", "dur": round(dur, 1),
            "cuts_per_s": round(len(cs) / dur, 2), "median_shot_s": round(float(np.median(shots)), 2),
            "punchins_per_min": round(punch / dur * 60, 1), "eye_drift": round(st.median(drift), 3) if drift else None,
            "face_size": round(st.median(fh), 2) if fh else None, "no_face_share": round(sum(noface) / max(1, n), 2),
            "visual_change_s": round(float(np.median(gaps)), 2), "text_share": text_share, "text_top_share": top_share,
            "caption_y": cap_y, "caption_h": cap_h, "floor_db": floor, "bass_share": bass, "lufs": lufs,
            "luma": luma, "contrast": contrast, "saturation": sat, "sharpness": sharp}


KEYS = ["cuts_per_s", "median_shot_s", "punchins_per_min", "eye_drift", "face_size", "no_face_share", "visual_change_s",
        "text_share", "text_top_share", "caption_y", "caption_h", "floor_db", "bass_share", "lufs", "luma", "contrast", "saturation", "sharpness"]


def table(rows):
    print("file".ljust(28) + "".join(k[:12].rjust(13) for k in KEYS))
    for r in rows:
        print(r["file"][:27].ljust(28) + "".join(str(r.get(k)).rjust(13) for k in KEYS))


def main():
    a = sys.argv[1:]
    if a and a[0] == "--compare":
        mine = fingerprint(a[1])
        refs = [fingerprint(p) for p in sorted(Path(a[2]).rglob("*.mp4"))]
        med = {k: round(st.median([r[k] for r in refs if r.get(k) is not None]), 3) if any(r.get(k) is not None for r in refs) else None for k in KEYS}
        print(f"{'':22}{'mine':>10}{'refs median':>14}{'refs range':>22}")
        for k in KEYS:
            vals = [r[k] for r in refs if r.get(k) is not None]
            rng = f"{min(vals)} - {max(vals)}" if vals else "-"
            print(f"{k:22}{str(mine.get(k)):>10}{str(med[k]):>14}{rng:>22}")
        out = {"mine": mine, "refs": refs, "median": med}
    else:
        vids = [p for p in a if not p.startswith("--") and p.endswith(".mp4")]
        out = [fingerprint(p) for p in vids]
        table(out)
    if "--json" in a:
        json.dump(out, open(a[a.index("--json") + 1], "w"), indent=1)


if __name__ == "__main__":
    main()
