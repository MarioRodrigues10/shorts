#!/usr/bin/env python3
"""Vision helpers for Shorts (runs in .venv-vision, CPU only).

  vision.py faces    SRC START END OUT.json
      Face centre samples (5 per second) over the source range, for auto-reframe.
  vision.py align    A.png B.png OUT.json
      Face position and size in two stills (the frames either side of a cut), for smooth cuts.
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


def face_points(det, path):
    """Largest face in an image: centre of eyes, nose and mouth, and its size (eye distance and box
    height combined), in pixels. None if no face."""
    img = cv2.cvtColor(cv2.imread(path), cv2.COLOR_BGR2RGB)
    h, w = img.shape[:2]
    r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(img)))
    if not r.detections:
        return None
    d = max(r.detections, key=lambda d: d.bounding_box.width * d.bounding_box.height)
    kp = [(p.x * w, p.y * h) for p in d.keypoints[:4]]  # right eye, left eye, nose tip, mouth
    cx, cy = sum(p[0] for p in kp) / 4, sum(p[1] for p in kp) / 4
    eyes = ((kp[0][0] - kp[1][0]) ** 2 + (kp[0][1] - kp[1][1]) ** 2) ** 0.5
    size = (eyes * 2.2 + d.bounding_box.height) / 2
    return {"x": round(cx, 2), "y": round(cy, 2), "size": round(size, 2), "w": w, "h": h,
            "score": round(d.categories[0].score, 3)}


def align_faces(det, path_a, path_b):
    """Similarity transform (k, tx, ty) that maps frame B onto frame A around the face: a pixel at p
    in B belongs at k*p + t in A. Starts from the face landmarks, then refines on the pixels of the
    head and shoulders (ECC), which is far steadier than landmarks alone. None when there is no
    face or the two frames don't match (different shot, face turned away)."""
    fa, fb = face_points(det, path_a), face_points(det, path_b)
    if not fa or not fb:
        return None
    ga = cv2.cvtColor(cv2.imread(path_a), cv2.COLOR_BGR2GRAY)
    gb = cv2.cvtColor(cv2.imread(path_b), cv2.COLOR_BGR2GRAY)
    h, w = ga.shape
    q = 360 / max(fa["size"], 1)  # work at a scale where the face is ~360 px
    q = min(q, 1.0)
    ga = cv2.resize(ga, None, fx=q, fy=q, interpolation=cv2.INTER_AREA).astype(np.float32)
    gb = cv2.resize(gb, None, fx=q, fy=q, interpolation=cv2.INTER_AREA).astype(np.float32)
    k0 = fa["size"] / fb["size"]
    # ECC warps A's region into B: x_B = M @ [x_A, 1]; start from the landmark estimate (inverse map)
    warp = np.array([[1 / k0, 0, (fb["x"] - fa["x"] / k0) * q], [0, 1 / k0, (fb["y"] - fa["y"] / k0) * q]], np.float32)
    r = fa["size"] * q * 1.6
    x0, y0 = int(max(0, fa["x"] * q - r)), int(max(0, fa["y"] * q - r * 0.9))
    x1, y1 = int(min(ga.shape[1], fa["x"] * q + r)), int(min(ga.shape[0], fa["y"] * q + r * 1.4))
    mask = np.zeros(ga.shape, np.uint8)
    mask[y0:y1, x0:x1] = 255
    try:
        cc, warp = cv2.findTransformECC(ga, gb, warp, cv2.MOTION_AFFINE,
                                        (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), mask, 5)
    except cv2.error:
        return None
    sx, sy = np.hypot(warp[0, 0], warp[1, 0]), np.hypot(warp[0, 1], warp[1, 1])
    k = 2 / (sx + sy)  # A units per B unit
    # Where B's face point lands in A, through the full affine (x_B = A x_A + c, at scale q). Small
    # rotation/shear is dropped from the result, so anchor the shift at the face, not at the
    # image corner: there half a degree of tilt would move the face by ~10 px.
    A, c = warp[:, :2].astype(np.float64), warp[:, 2].astype(np.float64)
    fa_x, fa_y = np.linalg.solve(A, np.array([fb["x"] * q, fb["y"] * q]) - c) / q
    tx, ty = fa_x - k * fb["x"], fa_y - k * fb["y"]
    ok = cc > 0.55 and 0.8 < k < 1.25 and abs(tx) < 0.2 * w and abs(ty) < 0.2 * h
    return {"k": round(float(k), 4), "tx": round(float(tx), 2), "ty": round(float(ty), 2),
            "fx": fb["x"], "fy": fb["y"], "match": round(float(cc), 3), "ok": bool(ok), "w": w, "h": h}


def cmd_align(a):
    det = vision.FaceDetector.create_from_options(vision.FaceDetectorOptions(
        base_options=BaseOptions(model_asset_path=f"{MODELS}/face.tflite"), min_detection_confidence=0.5))
    json.dump(align_faces(det, a.src, a.start_or_img), open(a.out_or_img, "w"))


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
    if len(sys.argv) > 1 and sys.argv[1] == "align":
        ap = argparse.ArgumentParser()
        ap.add_argument("cmd")
        ap.add_argument("src")
        ap.add_argument("start_or_img")
        ap.add_argument("out_or_img")
        return cmd_align(ap.parse_args())
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
