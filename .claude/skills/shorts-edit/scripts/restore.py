#!/usr/bin/env python3
"""Face restoration for thumbnails (run with .venv-vision: MediaPipe + OpenCV + onnxruntime).

  restore.py IN.jpg OUT.jpg [--strength 0.6]

GFPGAN 1.4 (ONNX, models/gfpgan_1.4.onnx, from facefusion-assets) rebuilds a sharp face from a
soft one: eyes, lashes, skin texture, hair edges. It invents detail, so it is blended in at partial
strength and only on the face (feathered mask): at 1.0 faces turn waxy and slightly not-you, the
"AI" look. Use it on the ENLARGED frame (after scaling for the thumbnail), so the restored detail
isn't thrown away again. CPU: ~2-4 s per face.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[4]
# GFPGAN / FFHQ 512 alignment template: left eye, right eye, nose tip, mouth left, mouth right
TEMPLATE = np.array([[192.98, 239.95], [318.90, 240.19], [256.63, 314.02], [201.26, 371.41], [313.09, 371.15]], np.float32)
_sess = None


def _session():
    global _sess
    if _sess is None:
        import onnxruntime as ort
        o = ort.SessionOptions()
        o.intra_op_num_threads = 4
        _sess = ort.InferenceSession(str(REPO / "models/gfpgan_1.4.onnx"), o, providers=["CPUExecutionProvider"])
    return _sess


def five_points(img):
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    lm = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(REPO / "models/face_landmarker.task")), num_faces=1))
    r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(img)))
    if not r.face_landmarks:
        return None
    p = np.array([(q.x * img.shape[1], q.y * img.shape[0]) for q in r.face_landmarks[0]], np.float32)
    return np.array([p[[33, 133]].mean(0), p[[362, 263]].mean(0), p[1], p[61], p[291]], np.float32)


ARC = np.array([[38.29, 51.70], [73.53, 51.50], [56.03, 71.74], [41.55, 92.37], [70.73, 92.20]], np.float32)
_arc = None


def identity(img, pts):
    """ArcFace embedding (models/arcface_w600k_r50.onnx) of the face at pts, unit length."""
    global _arc
    import cv2
    import onnxruntime as ort
    if _arc is None:
        _arc = ort.InferenceSession(str(REPO / "models/arcface_w600k_r50.onnx"), providers=["CPUExecutionProvider"])
    M, _ = cv2.estimateAffinePartial2D(pts, ARC, method=cv2.LMEDS)
    f = cv2.warpAffine(np.asarray(img), M, (112, 112), flags=cv2.INTER_LINEAR)
    x = ((f.astype(np.float32) - 127.5) / 127.5).transpose(2, 0, 1)[None]
    e = _arc.run(None, {"input": x})[0][0]
    return e / (np.linalg.norm(e) + 1e-9)


def restore_safe(im, strength=0.45, min_sim=0.965, step=0.05):
    """restore() with an identity guard: the polished face must still be the same person to a face-
    recognition model (cosine similarity of ArcFace embeddings >= min_sim vs the original); if not,
    the strength steps down until it is. Returns (image, strength_used, similarity).
    Calibrated on real thumbnails: the strength a creator rejected ("not my face", 0.7) scored
    0.938-0.957; 0.45 scored 0.969-0.981. 0.965 sits between them."""
    img = np.asarray(im.convert("RGB"))
    pts = five_points(img)
    if pts is None:
        return im, 0.0, 1.0
    ref = identity(img, pts)
    s = strength
    while s > 0.05:
        out = restore(im, s)
        sim = float(identity(np.asarray(out), pts) @ ref)
        if sim >= min_sim:
            return out, s, sim
        s = round(s - step, 2)
    return im, 0.0, 1.0


def restore(im, strength=0.3):
    """PIL RGB in, PIL RGB out, the face restored and blended at `strength`."""
    import cv2
    img = np.asarray(im.convert("RGB"))
    pts = five_points(img)
    if pts is None:
        return im
    M, _ = cv2.estimateAffinePartial2D(pts, TEMPLATE, method=cv2.LMEDS)
    face = cv2.warpAffine(img, M, (512, 512), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
    x = (face.astype(np.float32) / 255 - 0.5) / 0.5
    out = _session().run(None, {"input": x.transpose(2, 0, 1)[None]})[0][0]
    out = ((np.clip(out, -1, 1) + 1) / 2 * 255).transpose(1, 2, 0)
    Mi = cv2.invertAffineTransform(M)
    h, w = img.shape[:2]
    back = cv2.warpAffine(out, Mi, (w, h), flags=cv2.INTER_CUBIC)
    # feathered oval over the face only (no restored background/hair edges)
    m = np.zeros((512, 512), np.float32)
    cv2.ellipse(m, (256, 290), (190, 236), 0, 0, 360, 1, -1)
    m = cv2.GaussianBlur(m, (0, 0), 22)
    # only where the restored square really lands (its border would otherwise leak a seam)
    valid = cv2.warpAffine(np.ones((512, 512), np.float32), Mi, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)
    valid = cv2.erode(valid, np.ones((9, 9), np.uint8))
    mask = (cv2.warpAffine(m, Mi, (w, h), flags=cv2.INTER_LINEAR) * valid)[..., None] * strength
    res = img.astype(np.float32) * (1 - mask) + back * mask
    return Image.fromarray(np.clip(res, 0, 255).astype(np.uint8))


_esr = None


def upscale2x(im, tile=192, pad=12):
    """Real-ESRGAN x2 (models/real_esrgan_x2_fp16.onnx, facefusion-assets): sharpens edges and
    texture WITHOUT redrawing the face's features (keeps identity, unlike GFPGAN). Tiled, CPU."""
    global _esr
    import onnxruntime as ort
    if _esr is None:
        o = ort.SessionOptions()
        o.intra_op_num_threads = 4
        _esr = ort.InferenceSession(str(REPO / "models/real_esrgan_x2_fp16.onnx"), o, providers=["CPUExecutionProvider"])
    a = np.asarray(im.convert("RGB"), np.float32) / 255
    H, W = a.shape[:2]
    out = np.zeros((H * 2, W * 2, 3), np.float32)
    for y in range(0, H, tile):
        for x in range(0, W, tile):
            y0, x0 = max(0, y - pad), max(0, x - pad)
            y1, x1 = min(H, y + tile + pad), min(W, x + tile + pad)
            t = a[y0:y1, x0:x1]
            ph, pw = (-t.shape[0]) % 4, (-t.shape[1]) % 4  # the model folds 2x2 blocks: even sizes only
            t = np.pad(t, ((0, ph), (0, pw), (0, 0)), mode="reflect").transpose(2, 0, 1)[None]
            r = _esr.run(None, {"input": t})[0][0].transpose(1, 2, 0)
            oy, ox = (y - y0) * 2, (x - x0) * 2
            hh, ww = min(tile, H - y) * 2, min(tile, W - x) * 2
            out[y * 2:y * 2 + hh, x * 2:x * 2 + ww] = r[oy:oy + hh, ox:ox + ww]
    return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8))


if __name__ == "__main__":
    a = sys.argv
    s = float(a[a.index("--strength") + 1]) if "--strength" in a else 0.3
    restore(Image.open(a[1]), s).save(a[2], quality=94)
    print(a[2])
