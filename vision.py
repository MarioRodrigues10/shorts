#!/usr/bin/env python3
"""Vision helpers for Shorts (runs in .venv-vision, CPU only).

  vision.py faces    SRC START END OUT.json
      Face centre samples (5 per second) over the source range, for auto-reframe.
  vision.py removebg SRC START END OUT.mp4 --bg blur|#rrggbb
      Replace the background behind the person (selfie segmentation) and re-encode
      the range (x264 CRF 14 + the original audio).

Progress: JSON lines on stdout ({"progress": 0.4}).
"""
import argparse
import json
import subprocess
import sys

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

MODELS = __file__.rsplit("/", 1)[0] + "/models"


def say(**kw):
    print(json.dumps(kw), flush=True)


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,avg_frame_rate", "-of", "json", path],
                         capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    num, den = s.get("avg_frame_rate", "30/1").split("/")
    return int(s["width"]), int(s["height"]), (float(num) / float(den)) if float(den) else 30.0


def frames(path, start, end, w, h, fps=None):
    """Yield RGB frames of the range (decoded by ffmpeg, auto-rotated)."""
    vf = [f"scale={w}:{h}"]
    if fps:
        vf.insert(0, f"fps={fps}")
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{start:.4f}", "-t", f"{end - start:.4f}", "-i", path,
           "-vf", ",".join(vf), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = w * h * 3
    while True:
        buf = p.stdout.read(size)
        if len(buf) < size:
            break
        yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    p.wait()


def even(x):
    return max(2, int(round(x / 2)) * 2)


def cmd_faces(a):
    sw, sh, _ = probe(a.src)
    k = 480 / max(sw, sh)
    w, h = even(sw * k), even(sh * k)
    det = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(
        base_options=BaseOptions(model_asset_path=f"{MODELS}/face.tflite"), min_detection_confidence=0.5))
    out, n_total = [], max(1, int((a.end - a.start) * 5))
    for i, fr in enumerate(frames(a.src, a.start, a.end, w, h, fps=5)):
        r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(fr)))
        t = a.start + i / 5
        if r.detections:
            b = max(r.detections, key=lambda d: d.bounding_box.width * d.bounding_box.height).bounding_box
            out.append({"t": round(t, 3), "x": round((b.origin_x + b.width / 2) / w, 4),
                        "y": round((b.origin_y + b.height / 2) / h, 4), "s": round(b.width / w, 4)})
        if i % 10 == 0:
            say(progress=round(min(0.99, i / n_total), 3))
    json.dump({"width": sw, "height": sh, "samples": out}, open(a.out, "w"))
    say(progress=1.0)


def cmd_removebg(a):
    sw, sh, src_fps = probe(a.src)
    fps = 60 if src_fps > 45 else 30  # constant rate on both ends (phones record variable frame rate)
    seg = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
        base_options=BaseOptions(model_asset_path=f"{MODELS}/selfie.tflite"), output_confidence_masks=True))
    # segment on a small copy, composite at full resolution
    k = 384 / max(sw, sh)
    small = (even(sw * k), even(sh * k))
    color = None
    if a.bg.startswith("#") and len(a.bg) == 7:
        color = np.array([int(a.bg[i:i + 2], 16) for i in (1, 3, 5)], np.float32)
    enc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{sw}x{sh}", "-r", str(fps),
         "-i", "-", "-ss", f"{a.start:.4f}", "-t", f"{a.end - a.start:.4f}", "-i", a.src,
         "-map", "0:v", "-map", "1:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "320k", "-t", f"{a.end - a.start:.4f}", "-movflags", "+faststart", a.out], stdin=subprocess.PIPE)
    prev = None
    n_total = max(1, int((a.end - a.start) * fps))
    for i, fr in enumerate(frames(a.src, a.start, a.end, sw, sh, fps=fps)):
        sm = cv2.resize(fr, small, interpolation=cv2.INTER_AREA)
        m = seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(sm))).confidence_masks[0].numpy_view()
        m = m.reshape(small[1], small[0]).astype(np.float32)
        # temporal smoothing (less edge flicker) + soft, slightly tightened edge
        prev = m if prev is None else 0.55 * m + 0.45 * prev
        mm = np.clip((prev - 0.35) / 0.4, 0, 1)
        mm = cv2.GaussianBlur(mm, (0, 0), 1.2)
        mask = cv2.resize(mm, (sw, sh), interpolation=cv2.INTER_LINEAR)[..., None]
        f32 = fr.astype(np.float32)
        if color is not None:
            back = np.broadcast_to(color, f32.shape)
        else:
            tiny = cv2.resize(fr, (max(8, sw // 16), max(8, sh // 16)), interpolation=cv2.INTER_AREA)
            back = cv2.resize(cv2.GaussianBlur(tiny, (0, 0), 3), (sw, sh), interpolation=cv2.INTER_LINEAR).astype(np.float32) * 0.85
        outf = f32 * mask + back * (1 - mask)
        try:
            enc.stdin.write(np.clip(outf, 0, 255).astype(np.uint8).tobytes())
        except BrokenPipeError:
            break  # encoder reached the requested length
        if i % 15 == 0:
            say(progress=round(min(0.99, i / n_total), 3))
    try:
        enc.stdin.close()
    except BrokenPipeError:
        pass
    if enc.wait() != 0:
        sys.exit("encode failed")
    say(progress=1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["faces", "removebg"])
    ap.add_argument("src")
    ap.add_argument("start", type=float)
    ap.add_argument("end", type=float)
    ap.add_argument("out")
    ap.add_argument("--bg", default="blur")
    a = ap.parse_args()
    {"faces": cmd_faces, "removebg": cmd_removebg}[a.cmd](a)


if __name__ == "__main__":
    main()
