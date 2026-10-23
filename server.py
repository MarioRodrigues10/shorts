#!/usr/bin/env python3
"""Shorts server.

The browser is the editor (multi-track timeline, preview compositor, caption
and text rendering). This server owns the heavy lifting:

* media registry: probe, preview proxy, waveform peaks, filmstrip sprite and
  transcript per media file (cached, reused across projects), processed by a
  single background worker so the laptop never runs two heavy jobs at once;
* projects (JSON documents);
* export: each main-track clip is rendered to a cached intermediate (constant
  memory, re-exports only re-render changed clips), then one final pass adds
  overlays, the browser-rendered text/caption layer, audio mixing with ducking,
  two-pass loudness normalisation and the platform encode (Intel VAAPI, x264
  fallback).
"""
import hashlib
import json
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HOME = Path.home()
APP_DIR = Path(__file__).resolve().parent
IS_WIN = os.name == "nt"


def low(cmd, n=10, idle_io=False):
    """Run cmd at low CPU (and optionally idle I/O) priority so the desktop stays responsive."""
    if IS_WIN:
        return cmd  # priority is set with creationflags in popen_low()
    pre = ["nice", "-n", str(n)]
    if idle_io and shutil.which("ionice"):
        pre += ["ionice", "-c", "3"]
    return pre + cmd


LOW_FLAGS = {"creationflags": 0x00004000} if IS_WIN else {}  # BELOW_NORMAL_PRIORITY_CLASS


_FFMPEG_MAJOR = None


def filter_script_opt():
    """Option that reads a filter graph from a file: `-/filter_complex` on FFmpeg 7+,
    `-filter_complex_script` before that (Ubuntu 24.04 and Debian 12 still ship FFmpeg 6)."""
    global _FFMPEG_MAJOR
    if _FFMPEG_MAJOR is None:
        try:
            out = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout
            m = re.search(r"version \D*(\d+)\.", out)
            _FFMPEG_MAJOR = int(m.group(1)) if m else 7
        except OSError:
            _FFMPEG_MAJOR = 7
    return "-/filter_complex" if _FFMPEG_MAJOR >= 7 else "-filter_complex_script"


def venv_python(name):
    return str(APP_DIR / name / ("Scripts/python.exe" if IS_WIN else "bin/python"))


def open_in_file_manager(target):
    if IS_WIN:
        os.startfile(str(target))  # noqa: only exists on Windows
    else:
        opener = "open" if sys.platform == "darwin" else "xdg-open"
        subprocess.Popen([opener, str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
STATIC_DIR = APP_DIR / "static"
DATA_DIR = Path(os.environ.get("XDG_DATA_HOME", HOME / ".local/share")) / "shorts-studio"
MEDIA_DIR = DATA_DIR / "media"
PROJECTS_DIR = DATA_DIR / "projects2"
CACHE_DIR = DATA_DIR / "render-cache"
THUMBS_DIR = DATA_DIR / "thumbs"
CONFIG_PATH = Path(os.environ.get("XDG_CONFIG_HOME", HOME / ".config")) / "shorts-studio" / "config.json"

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".mxf", ".mts"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"}
BROWSER_AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus"}

DEFAULT_CONFIG = {
    "port": 7377,
    # Folders shown in the media browser / "Recent recordings" (top level only).
    "library_dirs": [
        "~/Videos",
        "~/Videos/Shorts/Media",
        "~/Music",
        "~/Pictures",
        "~/Downloads",
    ],
    "upload_dir": "~/Videos/Shorts/Media",     # imported / dropped files are copied here
    "export_dir": "~/Videos/Shorts/Exports",   # finished videos
    "language": "en",
    "model": "small.en",
    "transcribe_threads": 4,
    # Whisper prompt. Helps with names but can make Whisper drop repeated
    # phrases (retakes), so it is empty by default.
    "vocabulary": "",
    "encoder": "auto",  # auto (Intel VAAPI if it works, else x264) | vaapi | x264
    "vaapi_device": "auto",
    "x264_preset": "medium",
    "crf": 16,
    "vaapi_qp": 14,
    "ffmpeg_stall_seconds": 180,
    "x264_threads": 6,  # CPU encodes: 6 uses ~15% less RAM than ffmpeg's default (1.5x cores) at the same quality  # stop an ffmpeg run that makes no progress for this long
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text()))
        except Exception as e:
            print("config error:", e, file=sys.stderr)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    # keep new keys visible in the file
    merged = dict(DEFAULT_CONFIG)
    merged.update(cfg)
    for k in ("gpu", "forced_alignment"):
        merged.pop(k, None)
    CONFIG_PATH.write_text(json.dumps(merged, indent=2))
    return merged


CONFIG = load_config()
DEFAULTS_PATH = CONFIG_PATH.parent / "default-style.json"


def expand(p):
    return Path(os.path.expanduser(str(p)))


def atomic_write(path, text):
    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text)
    tmp.replace(path)


# --------------------------------------------------------------------------
# Jobs (exports, conversions)
# --------------------------------------------------------------------------

JOBS = {}
JOBS_LOCK = threading.Lock()
# One export at a time: protects RAM on this laptop and keeps renders from racing.
EXPORT_LOCK = threading.Lock()


def new_job(kind, project_id=None):
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "kind": kind, "project": project_id, "status": "running",
           "progress": 0.0, "message": "", "error": None, "result": None, "started": time.time()}
    with JOBS_LOCK:
        JOBS[jid] = job
    return job


def run_job(job, fn, *args):
    def target():
        try:
            job["result"] = fn(job, *args)
            job["status"] = "done"
            job["progress"] = 1.0
        except Exception as e:
            traceback.print_exc()
            job["status"] = "error"
            job["error"] = str(e)
    threading.Thread(target=target, daemon=True).start()
    return job


def run_ffmpeg(cmd, job=None, total=None, start=0.0, span=1.0, key="progress"):
    """Run ffmpeg at low priority, reporting progress in [start, start+span] on job[key].

    A watchdog stops runs that make no sense any more: no progress for `ffmpeg_stall_seconds`
    (default 3 min), or, when the media length is known, longer than 30x real time (min 10 min).
    A stopped run raises, so the export fails with a message and the next queued one starts."""
    cmd = low([cmd[0], "-hide_banner", "-nostats", "-progress", "pipe:1"] + cmd[1:])
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **LOW_FLAGS)
    err_lines = []
    began = last = time.time()
    seen = {}
    stall = float(CONFIG.get("ffmpeg_stall_seconds", 180))
    limit = max(600.0, 30 * total) if total else None
    stopped = []

    def drain():
        for line in proc.stderr:
            err_lines.append(line)
            if len(err_lines) > 400:
                del err_lines[:200]

    def watchdog():
        while proc.poll() is None:
            time.sleep(5)
            now = time.time()
            why = (f"no progress for {int(now - last)} s" if now - last > stall else
                   f"still running after {int(now - began)} s for {total:.0f} s of media" if limit and now - began > limit else None)
            if why and proc.poll() is None:
                stopped.append(why)
                print("ffmpeg watchdog: stopping (" + why + "):", " ".join(cmd[:12]), flush=True)
                proc.kill()
                return
    threading.Thread(target=drain, daemon=True).start()
    threading.Thread(target=watchdog, daemon=True).start()
    for line in proc.stdout:
        k, _, v = line.strip().partition("=")
        if k in ("out_time_us", "frame", "total_size") and seen.get(k) != v:
            seen[k] = v
            last = time.time()  # any advance counts as progress
        if job is not None and total and k == "out_time_us":
            try:
                job[key] = start + span * max(0.0, min(1.0, int(v) / 1e6 / total))
            except ValueError:
                pass
    proc.wait()
    if stopped:
        raise RuntimeError(f"ffmpeg was stopped because it looked stuck ({stopped[0]}). Try exporting again.")
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg failed:\n" + "".join(err_lines[-25:]))
    return "".join(err_lines)


# --------------------------------------------------------------------------
# Hardware encoder detection (Intel iGPU via VAAPI; never the 2 GB NVIDIA card)
# --------------------------------------------------------------------------

_VAAPI = {"checked": False, "device": None}


def vaapi_device():
    if _VAAPI["checked"]:
        return _VAAPI["device"]
    _VAAPI["checked"] = True
    if CONFIG["encoder"] == "x264":
        return None
    candidates = []
    if CONFIG["vaapi_device"] != "auto":
        candidates.append(CONFIG["vaapi_device"])
    else:
        # Prefer the Intel GPU (PCI vendor 0x8086).
        for r in sorted(Path("/dev/dri").glob("renderD*")):
            vendor = Path(f"/sys/class/drm/{r.name}/device/vendor")
            if vendor.exists() and vendor.read_text().strip() == "0x8086":
                candidates.append(str(r))
    for dev in candidates:
        ok = subprocess.run(
            ["ffmpeg", "-v", "error", "-vaapi_device", dev, "-f", "lavfi", "-i",
             "testsrc=s=320x240:d=0.2", "-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi",
             "-f", "null", "-"], capture_output=True, env=dict(os.environ, LIBVA_DRIVER_NAME="iHD"),
            timeout=30).returncode == 0
        if ok:
            _VAAPI["device"] = dev
            break
    print("encoder:", "vaapi " + _VAAPI["device"] if _VAAPI["device"] else "x264", flush=True)
    return _VAAPI["device"]


def video_encode_args(final=True, quality="high"):
    """Encoder args. Returns (pre_input_args, filter_suffix, codec_args).
    quality: high (GPU CQP14 ~ x264 CRF16-17) | max (CPU x264 slow CRF14) | small (GPU CQP21)."""
    if final and quality == "max":
        return ([], "", ["-c:v", "libx264", "-preset", "slow", "-crf", "14", "-profile:v", "high",
                         "-level:v", "4.2", "-pix_fmt", "yuv420p", "-threads", str(CONFIG["x264_threads"])])
    if not final:
        # Intermediates are lossless: no generational loss before the final encode.
        return ([], "", ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p", "-threads", "4"])
    dev = vaapi_device()
    if dev:
        # CQP 14 on the Intel encoder ~= x264 CRF 16-17 (SSIM 0.996) at ~8x the speed.
        return (["-vaapi_device", dev], ",format=nv12,hwupload",
                ["-c:v", "h264_vaapi", "-rc_mode", "CQP", "-qp", str(21 if quality == "small" else CONFIG.get("vaapi_qp", 14)),
                 "-profile:v", "high"])
    return ([], "", ["-c:v", "libx264", "-preset", CONFIG["x264_preset"], "-crf", str(22 if quality == "small" else CONFIG["crf"]),
                     "-profile:v", "high", "-level:v", "4.2", "-pix_fmt", "yuv420p", "-threads", str(CONFIG["x264_threads"])])


FFENV = dict(os.environ, LIBVA_DRIVER_NAME="iHD")


# --------------------------------------------------------------------------
# Media registry
# --------------------------------------------------------------------------

def media_kind(path):
    ext = Path(path).suffix.lower()
    if ext in VIDEO_EXTS:
        return "video"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in AUDIO_EXTS:
        return "audio"
    return None


def media_id_for(path):
    st = path.stat()
    return hashlib.sha1(f"{path.resolve()}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:12]


def check_id(x):
    if not re.fullmatch(r"[0-9a-f]{12}", x or ""):
        raise ValueError("bad id")
    return x


def mdir(mid):
    return MEDIA_DIR / check_id(mid)


MEDIA_LOCK = threading.RLock()


def load_meta(mid):
    p = mdir(mid) / "meta.json"
    return json.loads(p.read_text()) if p.exists() else None


def save_meta(meta):
    d = mdir(meta["id"])
    d.mkdir(parents=True, exist_ok=True)
    atomic_write(d / "meta.json", json.dumps(meta))


def update_meta(mid, **kw):
    with MEDIA_LOCK:
        m = load_meta(mid)
        m.update(kw)
        save_meta(m)
        return m


def set_status(mid, task, state, err=None):
    with MEDIA_LOCK:
        m = load_meta(mid)
        m.setdefault("status", {})[task] = state
        if err:
            m.setdefault("errors", {})[task] = str(err)[-800:]
        elif task in m.get("errors", {}):
            del m["errors"][task]
        save_meta(m)


def probe(path, kind):
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, check=True).stdout
    d = json.loads(out)
    v = next((s for s in d["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in d["streams"] if s["codec_type"] == "audio"), None)
    info = {"has_audio": a is not None and kind != "image", "duration": 0.0,
            "width": 0, "height": 0, "fps": 30.0}
    if kind == "audio":
        info["duration"] = float(d["format"].get("duration") or 0)
        return info
    if v is None:
        raise ValueError("no video stream")
    w, h = int(v["width"]), int(v["height"])
    rot = 0
    for sd in v.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
    if "rotate" in v.get("tags", {}):
        rot = int(v["tags"]["rotate"])
    if abs(rot) % 180 == 90:
        w, h = h, w
    info.update(width=w, height=h, color_transfer=v.get("color_transfer"), pix_fmt=v.get("pix_fmt"))
    if kind == "video":
        num, den = (v.get("avg_frame_rate") or "30/1").split("/")
        info["fps"] = round(float(num) / float(den), 3) if float(den) else 30.0
        info["duration"] = float(d["format"].get("duration") or v.get("duration") or 0)
    return info


def import_media(path, transcribe=False):
    path = expand(path).resolve()
    if not path.is_file():
        raise FileNotFoundError(str(path))
    kind = media_kind(path)
    if not kind:
        raise ValueError(f"unsupported file type: {path.suffix}")
    mid = media_id_for(path)
    with MEDIA_LOCK:
        meta = load_meta(mid)
        if meta is None:
            try:
                info = probe(path, kind)
            except ValueError:
                if kind != "video":
                    raise
                kind, info = "audio", probe(path, "audio")  # e.g. a mic recording saved as .webm
            meta = {"id": mid, "path": str(path), "name": path.name, "kind": kind,
                    "added": time.time(), "status": {}}
            meta.update(info)
            save_meta(meta)
    enqueue_prep(mid)
    if transcribe:
        enqueue_transcribe(mid)
    return load_meta(mid)


# ---- background worker: one heavy task at a time ----

TASKS = queue.PriorityQueue()
QUEUED = set()
CURRENT = {"task": None, "progress": 0.0, "message": ""}
_seq = [0]


def _put(prio, mid, task, opts=None):
    key = (mid, task)
    with MEDIA_LOCK:
        if key in QUEUED:
            return
        QUEUED.add(key)
        _seq[0] += 1
        TASKS.put((prio, _seq[0], mid, task, opts or {}))
        m = load_meta(mid)
        if m.get("status", {}).get(task) not in ("running",):
            m.setdefault("status", {})[task] = "queued"
            save_meta(m)


def enqueue_prep(mid):
    m = load_meta(mid)
    st = m.get("status", {})
    d = mdir(mid)
    if m["kind"] == "video":
        if not (d / proxy_name(m)).exists() and st.get("proxy") != "error":
            _put(0, mid, "proxy")
        if (not (d / "sprite.jpg").exists() or (m.get("sprite") or {}).get("v") != SPRITE_V) and st.get("sprite") != "error":
            _put(1, mid, "sprite")
    if m.get("has_audio") and "clipped" not in m and m["kind"] != "video":
        detect_clipping(m)
        m = load_meta(mid)
    if m["kind"] == "audio" and (Path(m["path"]).suffix.lower() not in BROWSER_AUDIO or m.get("clipped")) \
            and not (d / "proxy.m4a").exists():
        _put(0, mid, "proxy")
    if m["kind"] == "video" and m.get("has_audio") and "clipped" not in m and (d / proxy_name(m)).exists():
        _put(0, mid, "reproxy")  # media proxied before clip detection existed
    if m["kind"] == "image" and Path(m["path"]).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif"} \
            and not (d / "proxy.png").exists():
        _put(0, mid, "proxy")
    if m.get("has_audio") and not (d / "peaks.json").exists() and st.get("peaks") != "error":
        _put(1, mid, "peaks")


PENDING_RANGES = {}  # mid -> {"ranges": [[a, b]], "model": str, "force": bool}


def merge_ranges(rs, gap=0.0):
    out = []
    for a, b in sorted([list(r) for r in rs if r[1] > r[0]]):
        if out and a <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def subtract_ranges(rs, cut):
    out = []
    for a, b in rs:
        segs = [[a, b]]
        for c, d in cut:
            nxt = []
            for x, y in segs:
                if d <= x or c >= y:
                    nxt.append([x, y])
                    continue
                if c > x:
                    nxt.append([x, c])
                if d < y:
                    nxt.append([d, y])
            segs = nxt
        out += [r for r in segs if r[1] - r[0] > 0.3]
    return out


def enqueue_transcribe(mid, ranges=None, model=None, force=False):
    """Transcribe the given source ranges (default: whole file) — only parts not done yet."""
    m = load_meta(mid)
    if not m.get("has_audio"):
        return 0
    dur = m["duration"]
    ranges = [[0, dur]] if not ranges else ranges
    # a little context around each range; join ranges that are close together
    ranges = merge_ranges([[max(0, a - 0.5), min(dur, b + 0.5)] for a, b in ranges], gap=2.0)
    covered = m.get("covered") if "covered" in m else load_words(mid)["covered"]
    need = ranges if force else subtract_ranges(ranges, covered or [])
    if not need:
        return 0
    with MEDIA_LOCK:
        pend = PENDING_RANGES.setdefault(mid, {"ranges": [], "model": None, "force": False})
        pend["ranges"] = merge_ranges(pend["ranges"] + need)
        pend["model"] = model or pend["model"]
        pend["force"] = pend["force"] or force
    _put(2, mid, "transcript", {})
    return sum(b - a for a, b in need)


def worker():
    while True:
        prio, _, mid, task, opts = TASKS.get()
        with MEDIA_LOCK:
            QUEUED.discard((mid, task))
        CURRENT.update(task={"media": mid, "task": task}, progress=0.0, message=task)
        # Whisper (~0.9 GB) never runs alongside an export or vision job (up to ~0.9 GB each):
        # one heavy job at a time. Proxies, filmstrips and waveforms are light and don't wait.
        heavy, held = task == "transcript", False
        try:
            if heavy:
                if not EXPORT_LOCK.acquire(blocking=False):
                    CURRENT.update(message="Waiting for the export to finish")
                    EXPORT_LOCK.acquire()
                held = True
            set_status(mid, task, "running")
            {"proxy": task_proxy, "reproxy": task_reproxy, "sprite": task_sprite, "peaks": task_peaks,
             "transcript": task_transcript, "upgrade": task_proxy}[task](load_meta(mid), opts)
            set_status(mid, task, "done")
        except Exception as e:
            traceback.print_exc()
            set_status(mid, task, "error", e)
        finally:
            if held:
                EXPORT_LOCK.release()
            CURRENT.update(task=None, progress=0.0, message="")


def detect_clipping(m):
    """Flat-topped peaks = the recording itself is clipped (mic/phone overloaded)."""
    if not m.get("has_audio") or "clipped" in m:
        return m.get("clipped", False)
    out = subprocess.run(low(["ffmpeg", "-hide_banner", "-nostats", "-i", m["path"], "-map", "0:a:0", "-vn",
                              "-af", "astats=measure_perchannel=none:measure_overall=Peak_level+Flat_factor",
                              "-f", "null", "-"]), capture_output=True, text=True).stderr
    peak = re.search(r"Peak level dB: (-?[\d.]+|-inf)", out)
    flat = re.search(r"Flat factor: ([\d.]+)", out)
    clipped = bool(peak and flat and peak.group(1) != "-inf" and float(peak.group(1)) > -0.3 and float(flat.group(1)) > 0.5)
    update_meta(m["id"], clipped=clipped)
    return clipped


DECLIP = "adeclip=window=55:overlap=75:arorder=8:threshold=10:hsize=1000"


def task_proxy(m, opts):
    d = mdir(m["id"])
    clipped = detect_clipping(m)
    if m["kind"] == "audio":
        run_ffmpeg(["ffmpeg", "-y", "-i", m["path"], "-vn"] + (["-af", DECLIP] if clipped else []) +
                   ["-c:a", "aac", "-b:a", "160k", str(d / "proxy.tmp.m4a")])
        (d / "proxy.tmp.m4a").replace(d / "proxy.m4a")
        return
    if m["kind"] == "image":
        # Preview copy only (exports read the original): at most 2160 px so a 12 MP photo doesn't
        # decode to ~48 MB in the browser. PNG keeps transparency for stickers and logos.
        run_ffmpeg(["ffmpeg", "-y", "-i", m["path"], "-frames:v", "1",
                    "-vf", "scale='min(2160,iw)':'min(2160,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
                    str(d / "proxy.tmp.png")])
        (d / "proxy.tmp.png").replace(d / "proxy.png")
        return
    # Sized for the preview it feeds, never upscaled. Benchmarked seeks (Firefox, long-GOP source):
    # vertical 540x960 / GOP 15 ~6 ms (p95 10); landscape 1280x720 / GOP 8 ~8 ms (p95 13).
    wide = m["width"] > m["height"]
    long_side = min(1280 if wide else 960, max(m["width"], m["height"]) // 2 * 2)
    scale = f"scale={long_side}:-2" if wide else f"scale=-2:{long_side}"
    gop = "8" if wide else "15"
    rev = int(m.get("proxy_rev", 0)) + (1 if (d / proxy_name(m)).exists() else 0)
    tmp = d / "proxy.tmp.mp4"
    run_ffmpeg(["ffmpeg", "-y", "-i", m["path"], "-map", "0:v:0", "-map", "0:a:0?",
                "-vf", f"fps=30,{scale}:flags=fast_bilinear,format=yuv420p", "-c:v", "libx264"] +
               (["-af", DECLIP] if clipped else []) + [
                "-preset", "ultrafast", "-tune", "fastdecode", "-crf", "27", "-g", gop, "-threads", "4",
                "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", str(tmp)],
               CURRENT, m["duration"])
    # New name per version: a file the browser is streaming is never rewritten in place.
    new = d / ("proxy.mp4" if rev == 0 else f"proxy.{rev}.mp4")
    tmp.replace(new)
    old = d / proxy_name(m)
    update_meta(m["id"], proxy_rev=rev, proxy_v=PROXY_V)
    if old != new and old.exists():
        threading.Timer(120, lambda: old.unlink(missing_ok=True)).start()


def proxy_name(m):
    rev = int(m.get("proxy_rev", 0))
    return "proxy.mp4" if rev == 0 else f"proxy.{rev}.mp4"


PROXY_V = 2  # 2: 540x960 vertical / 1280x720 landscape (v1 was 720 on the long side: blurry when wide)


def task_reproxy(m, opts):
    if detect_clipping(m):
        task_proxy(load_meta(m["id"]), opts)


SPRITE_V = 2


def task_sprite(m, opts):
    """Filmstrip thumbnails: up to 4 per second, 96 px tall, in a grid (JPEG max is 65535 px wide)."""
    d = mdir(m["id"])
    src = d / proxy_name(m) if (d / proxy_name(m)).exists() else m["path"]
    n = int(max(8, min(900, m["duration"] * 4)))
    fps = n / max(m["duration"], 0.1)
    th = 96
    tw = even(m["width"] / max(1, m["height"]) * th) if m["height"] else 54
    cols = min(n, 40)
    rows = (n + cols - 1) // cols
    run_ffmpeg(["ffmpeg", "-y", "-i", str(src), "-an", "-vf",
                f"fps={fps:.5f},scale={tw}:{th}:flags=lanczos,tile={cols}x{rows}", "-frames:v", "1", "-q:v", "4",
                str(d / "sprite.tmp.jpg")])
    (d / "sprite.tmp.jpg").replace(d / "sprite.jpg")
    update_meta(m["id"], sprite={"n": n, "tw": tw, "th": th, "cols": cols, "step": m["duration"] / n, "v": SPRITE_V})


def task_peaks(m, opts):
    d = mdir(m["id"])
    rate = 100
    raw = subprocess.run(low(["ffmpeg", "-v", "quiet", "-i", m["path"], "-map", "0:a:0", "-ac", "1",
                              "-ar", "8000", "-f", "s16le", "-"]), capture_output=True, check=True).stdout
    import array
    a = array.array("h")
    a.frombytes(raw[: len(raw) // 2 * 2])
    step = 8000 // rate
    peaks = []
    for i in range(0, len(a), step):
        chunk = a[i:i + step]
        peaks.append(round(max(abs(min(chunk)), abs(max(chunk))) / 32768, 3) if chunk else 0)
    atomic_write(d / "peaks.json", json.dumps({"rate": rate, "peaks": peaks}))


TRANSCRIBER = [venv_python(".venv"), str(APP_DIR / "transcribe.py")]


def load_words(mid):
    p = mdir(mid) / "words.json"
    if not p.exists():
        return {"words": [], "covered": []}
    d = json.loads(p.read_text())
    if "covered" not in d:  # transcripts from before range support covered the whole file
        m = load_meta(mid)
        d["covered"] = [[0, m["duration"]]]
        for w in d["words"]:
            w["id"] = int(round(w["start"] * 1000))
    return d


def task_transcript(m, opts):
    mid = m["id"]
    with MEDIA_LOCK:
        pend = PENDING_RANGES.pop(mid, None)
    if not pend or not pend["ranges"]:
        return
    d = mdir(mid)
    raw = d / "transcript_raw.json"
    raw.unlink(missing_ok=True)
    model = pend["model"] or CONFIG["model"]
    ranges = pend["ranges"]
    # Low priority so the desktop (and Resolve) stay responsive while it runs.
    cmd = low(TRANSCRIBER, 15, idle_io=True) + [
        m["path"], str(raw), "--model", model, "--threads", str(CONFIG["transcribe_threads"]),
        "--ranges", ",".join(f"{a:.3f}-{b:.3f}" for a, b in ranges)]
    if CONFIG.get("language"):
        cmd += ["--lang", CONFIG["language"]]
    if CONFIG.get("vocabulary"):
        cmd += ["--prompt", CONFIG["vocabulary"]]
    env = dict(os.environ)
    hub = HOME / ".cache/huggingface/hub"
    if any(hub.glob(f"models--*{model.replace('.', '*')}*")):
        env["HF_HUB_OFFLINE"] = "1"  # model is cached: fully offline, no network check
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, **LOW_FLAGS)
    err = []
    threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True).start()
    for line in proc.stdout:
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if "progress" in ev:
            CURRENT["progress"] = ev["progress"]
        if ev.get("status"):
            CURRENT["message"] = ev["status"]
    proc.wait()
    if proc.returncode != 0 or not raw.exists():
        raise RuntimeError("transcription failed: " + "".join(err)[-800:])
    data = json.loads(raw.read_text())
    new = []
    for si, seg in enumerate(data.get("segments", [])):
        for w in seg.get("words", []):
            text = w["word"].strip()
            if text:
                new.append({"text": text, "start": round(w["start"], 3),
                            "end": round(max(w["end"], w["start"] + 0.04), 3),
                            "p": round(w.get("probability", 1.0), 3), "seg": f"{ranges[0][0]:.0f}.{si}"})
    with MEDIA_LOCK:
        old = load_words(mid)
        inside = lambda w: any(a <= (w["start"] + w["end"]) / 2 < b for a, b in ranges)
        words = [w for w in old["words"] if not inside(w)] + new
        words.sort(key=lambda w: w["start"])
        used = set()
        for w in words:  # stable ids (ms of start) so word edits survive re-transcription
            i = int(round(w["start"] * 1000))
            while i in used:
                i += 1
            used.add(i)
            w["id"] = i
        covered = merge_ranges((old.get("covered") or []) + ranges)
        atomic_write(d / "words.json", json.dumps({"model": model, "engine": data.get("engine"),
                                                   "at": time.time(), "covered": covered, "words": words}))
        update_meta(mid, covered=covered)


def media_public(m):
    d = mdir(m["id"])
    if "covered" not in m and (d / "words.json").exists():
        m = update_meta(m["id"], covered=load_words(m["id"])["covered"])
    m = dict(m)
    m["ready"] = {
        "proxy": (m["kind"] == "video" and (d / proxy_name(m)).exists())
        or (m["kind"] == "audio" and (d / "proxy.m4a").exists() or (m["kind"] == "audio" and not m.get("clipped")
                                       and Path(m["path"]).suffix.lower() in BROWSER_AUDIO))
        or (m["kind"] == "image"),
        "sprite": (d / "sprite.jpg").exists() and (m.get("sprite") or {}).get("v") == SPRITE_V,
        "peaks": (d / "peaks.json").exists(),
        "words": (d / "words.json").exists() and bool(m.get("covered", True)),
    }
    if CURRENT["task"] and CURRENT["task"]["media"] == m["id"]:
        m["working"] = {"task": CURRENT["task"]["task"], "progress": CURRENT["progress"],
                        "message": CURRENT["message"]}
    return m


def preview_file(m):
    d = mdir(m["id"])
    if m["kind"] == "video":
        return d / proxy_name(m)
    if (d / "proxy.m4a").exists():
        return d / "proxy.m4a"
    if (d / "proxy.png").exists():
        return d / "proxy.png"
    return Path(m["path"])


# --------------------------------------------------------------------------
# Projects
# --------------------------------------------------------------------------

def ppath(pid):
    return PROJECTS_DIR / f"{check_id(pid)}.json"


def load_proj(pid):
    p = ppath(pid)
    return json.loads(p.read_text()) if p.exists() else None


def save_proj(proj):
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    proj["updated"] = time.time()
    atomic_write(ppath(proj["id"]), json.dumps(proj))


def new_project(name, from_path=None):
    pid = uuid.uuid4().hex[:12]
    proj = {"version": 2, "id": pid, "name": name or "Untitled", "created": time.time(),
            "canvas": {"w": 1080, "h": 1920, "fps": 30, "bg": "blur"},
            "media": [], "tracks": [{"id": "main", "kind": "main", "clips": []}],
            "captions": None, "wordEdits": {}, "audio": {"normalize": True, "lufs": -14, "enhance": False}}
    if from_path:
        m = import_media(from_path)
        proj["media"].append(m["id"])
        proj["name"] = name or Path(m["path"]).stem
        if m["kind"] in ("video", "image"):
            dur = m["duration"] if m["kind"] == "video" else 5.0
            proj["tracks"][0]["clips"].append({"id": uuid.uuid4().hex[:8], "mid": m["id"], "in": 0,
                                               "out": round(dur, 3)})
    save_proj(proj)
    return proj


def list_projects():
    out = []
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    for f in PROJECTS_DIR.glob("*.json"):
        try:
            p = json.loads(f.read_text())
        except Exception:
            continue
        main = next((t for t in p["tracks"] if t["kind"] == "main"), {"clips": []})
        dur = sum((c["out"] - c["in"]) / c.get("speed", 1) for c in main["clips"])
        first = main["clips"][0]["mid"] if main["clips"] else (p["media"][0] if p["media"] else None)
        fm = load_meta(first) if first else None
        out.append({"id": p["id"], "name": p["name"], "updated": p.get("updated", p["created"]),
                    "duration": dur, "thumb": fm["path"] if fm and fm["kind"] != "audio" else None,
                    "exported": bool(p.get("exports"))})
    out.sort(key=lambda x: -x["updated"])
    return out


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

def even(x):
    return max(2, int(round(x / 2)) * 2)


def atempo_chain(speed):
    parts, s = [], speed
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    parts.append(f"atempo={s:.5f}")
    return ",".join(parts)


def kf_expr(kfs, base, T="t"):
    """Keyframes -> ffmpeg expression in T (seconds from clip start). Mirrors kfValue() in kf.js (smoothstep)."""
    if not kfs:
        return f"({base})"
    expr = f"({kfs[-1]['v']})"
    for i in range(len(kfs) - 1, 0, -1):
        a, b = kfs[i - 1], kfs[i]
        x = f"clip(({T}-{a['t']})/{max(b['t'] - a['t'], 1e-6):.6f},0,1)"
        seg = f"({a['v']}+({b['v']}-{a['v']})*{x}*{x}*(3-2*{x}))"
        expr = f"if(lt({T},{b['t']}),{seg},{expr})"
    return f"if(lt({T},{kfs[0]['t']}),({kfs[0]['v']}),{expr})"


def zoom_expr(c, dur, off=0.0):
    """Zoom at clip time T=t+off: keyframes or slow zoom, times the 'zoom' intro effect. Mirrors zoomAt() in player.js."""
    T = f"(t+{off:.5f})"
    z0 = float(c.get("zoom", 1.0))
    z1 = float(c.get("zoomEnd", z0) if c.get("zoomEnd") is not None else z0)
    kz = (c.get("kf") or {}).get("zoom")
    if kz:
        expr = kf_expr(kz, z0, T)
    else:
        expr = f"({z0}+({z1}-{z0})*min({T}/{max(dur, 0.01):.4f},1))" if abs(z1 - z0) > 1e-4 else f"{z0}"
    if c.get("effect") == "zoom":
        expr = f"{expr}*(1+0.25*pow(max(0,1-{T}/0.35),2))"
    animated = bool(kz) or abs(z1 - z0) > 1e-4 or c.get("effect") == "zoom"
    return expr, animated


def can_shrink(c):
    """True if the clip is ever drawn below 100% (scale, slow zoom or zoom keyframes)."""
    zs = [float(c.get("zoom", 1.0))]
    if c.get("zoomEnd") is not None:
        zs.append(float(c["zoomEnd"]))
    zs += [float(k["v"]) for k in ((c.get("kf") or {}).get("zoom") or [])]
    return min(zs) < 1 - 1e-6


SCALE_FLAGS = "lanczos+accurate_rnd+full_chroma_int"


def source_filters(c, m):
    """Per-clip picture fixes before framing: HDR->SDR, denoise, colour (mirrors adjustFilter() in player.js), sharpen."""
    f = []
    if (m.get("color_transfer") or "") in ("arib-std-b67", "smpte2084"):
        f.append("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,"
                 "zscale=t=bt709:m=bt709:r=tv,format=yuv420p")
    a = c.get("adj") or {}
    dn = float(a.get("denoise") or 0)
    if dn > 0:
        f.append(f"hqdn3d={2 * dn:.2f}:{1.5 * dn:.2f}:{6 * dn:.2f}:{4.5 * dn:.2f}")
    b, ct, sat, tmp = (float(a.get(k) or 0) for k in ("brightness", "contrast", "saturation", "temperature"))
    if b or ct or tmp:
        k, cc = 1 + b, 1 + ct
        gr, gb = 1 + 0.12 * tmp, 1 - 0.12 * tmp
        lut = lambda g: f"clip(((val*{k * g:.5f})-128)*{cc:.5f}+128\\,0\\,255)"
        f.append(f"format=rgb24,lutrgb=r='{lut(gr)}':g='{lut(1)}':b='{lut(gb)}'")
    if sat:
        s_ = 1 + sat
        mtx = [0.213 + 0.787 * s_, 0.715 - 0.715 * s_, 0.072 - 0.072 * s_,
               0.213 - 0.213 * s_, 0.715 + 0.285 * s_, 0.072 - 0.072 * s_,
               0.213 - 0.213 * s_, 0.715 - 0.715 * s_, 0.072 + 0.928 * s_]
        names = ["rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb"]
        f.append("format=rgb24,colorchannelmixer=" + ":".join(f"{n}={v:.5f}" for n, v in zip(names, mtx)))
    sh = float(a.get("sharpen") or 0)
    if sh > 0:
        f.append(f"cas=strength={min(1.0, sh):.2f}")
    if c.get("flip"):
        f.append("hflip")
    if f:
        f.append("format=yuv420p")
    return ",".join(f)


def crop_box(c, sw, sh):
    """Source-pixel crop (x, y, w, h) from c["crop"] = {l, r, t, b} (fractions per side), or None.
    Mirrors cropRect() in player.js."""
    cr = c.get("crop") or {}
    l, r, t, b = (min(0.45, max(0.0, float(cr.get(k) or 0))) for k in ("l", "r", "t", "b"))
    if not (l or r or t or b):
        return None
    ev = lambda v: int(v // 2) * 2  # round down to even (yuv420p); same rule as cropRect()
    return ev(sw * l), ev(sh * t), max(2, ev(sw * (1 - l - r))), max(2, ev(sh * (1 - t - b)))


def main_clip_filters(c, m, W, H, bg, fps=30, off=0.0):
    """Video filter for one main-track clip (or a piece of it starting at clip time `off`).
    Mirrors _drawMainInner() in player.js."""
    speed = float(c.get("speed", 1.0))
    dur = (c["out"] - c["in"]) / speed
    sw, sh = max(1, m["width"]), max(1, m["height"])
    kf = c.get("kf") or {}
    T = f"(t+{off:.5f})"
    px = kf_expr(kf["x"], 0, T) if kf.get("x") else str(float(c.get("x", 0)))
    py = kf_expr(kf["y"], 0, T) if kf.get("y") else str(float(c.get("y", 0)))
    zexpr, animated = zoom_expr(c, dur, off)
    ev = ":eval=frame" if animated else ""
    pre = f"setpts=(PTS-STARTPTS)/{speed},fps={fps}" if speed != 1 else f"setpts=PTS-STARTPTS,fps={fps}"
    box = crop_box(c, sw, sh)
    if box:  # crop the raw source first; framing below then treats the crop as the whole picture
        pre += f",crop={box[2]}:{box[3]}:{box[0]}:{box[1]}"
        sw, sh = box[2], box[3]
    sf = source_filters(c, m)
    if sf:
        pre += "," + sf
    fill = c.get("fit", "fill") == "fill"
    if fill and not can_shrink(c):
        # covers the frame the whole time: scale up and crop (no background needed)
        s0 = max(W / sw, H / sh)
        return (f"{pre},scale=w='2*ceil({sw}*{s0}*{zexpr}/2)':h='2*ceil({sh}*{s0}*{zexpr}/2)'{ev}:flags={SCALE_FLAGS},"
                f"crop={W}:{H}:x='(iw-{W})/2*(1+{px})':y='(ih-{H})/2*(1+{py})',setsar=1,format=yuv420p")
    s0 = (max if fill else min)(W / sw, H / sh)
    fg = (f"scale=w='2*ceil({sw}*{s0}*{zexpr}/2)':h='2*ceil({sh}*{s0}*{zexpr}/2)'{ev}:flags={SCALE_FLAGS}")
    # fill keeps the crop path's meaning of x/y (same formula), so scaling across 100% is seamless
    pos = (f"x='({W}-w)/2*(1+{px})':y='({H}-h)/2*(1+{py})'" if fill else
           f"x='({W}-w)/2+{px}*{W}/2':y='({H}-h)/2+{py}*{H}/2'")
    if bg == "blur":
        back = (f"scale={W // 4}:{H // 4}:force_original_aspect_ratio=increase,crop={W // 4}:{H // 4},"
                f"boxblur=12:2,eq=brightness=-0.12:saturation=1.1,scale={W}:{H}")
    else:
        color = "black" if bg in ("black", None) else bg
        back = f"drawbox=c={color}:t=fill,scale={W}:{H}"
    return (f"{pre},split[bg][fg];[bg]{back}[bgs];[fg]{fg}[fgs];[bgs][fgs]overlay={pos}:eval=frame,"
            f"setsar=1,format=yuv420p")


def _cache_out(key_obj):
    key = hashlib.sha1(json.dumps(key_obj, sort_keys=True).encode()).hexdigest()[:20]
    return CACHE_DIR / f"{key}.mkv", key


BREATH_GAIN = 10 ** (-24 / 20)  # "Lower breaths": -24 dB, with 30 ms ramps
BREATH_RAMP = 0.03
BREATHS_V = 3  # breaths.py output version; older detections are recomputed
EDGE = 0.12    # a breath fragment this close to a cut is the leftover of a breath


def breaths_for(m):
    """{"breaths": [...], "fragments": [...]} in source seconds, from breaths.py; recomputed when the
    transcript changes."""
    d = mdir(m["id"])
    words, out = d / "words.json", d / "breaths.json"
    none = {"breaths": [], "fragments": []}
    if m.get("kind") != "video" and m.get("kind") != "audio" or not words.exists() or not Path(m["path"]).exists():
        return none
    stale = not out.exists() or out.stat().st_mtime < words.stat().st_mtime
    if not stale:
        try:
            stale = json.loads(out.read_text()).get("version") != BREATHS_V
        except (OSError, ValueError):
            stale = True
    if stale:
        tmp = d / "breaths.tmp.json"
        r = subprocess.run(low([venv_python(".venv"), str(APP_DIR / "breaths.py"), m["path"], str(words), str(tmp)], 15),
                           capture_output=True, text=True, **LOW_FLAGS)
        if r.returncode != 0 or not tmp.exists():
            print("breaths.py failed:", r.stderr[-400:], flush=True)
            return none
        tmp.replace(out)
    try:
        d = json.loads(out.read_text())
        return {"breaths": d.get("breaths", []), "fragments": d.get("fragments", [])}
    except (OSError, ValueError):
        return none


def clip_breaths(found, c):
    """Ranges to lower in one clip: its breaths, plus fragments touching its cut points.
    Mirrors clipBreaths() in media.js."""
    a, b = float(c["in"]), float(c["out"])
    edge = [f for f in found["fragments"] if f[0] <= a + EDGE and f[1] >= a or f[1] >= b - EDGE and f[0] <= b]
    return sorted(found["breaths"] + edge)


def breath_gain_expr(breaths, src_in, src_len):
    """Volume expression (t = seconds since src_in, source time) that dips each breath."""
    terms = []
    for b0, b1 in breaths:
        if b1 <= src_in or b0 >= src_in + src_len:
            continue
        x0, x1 = b0 - src_in, b1 - src_in
        terms.append(f"(1-{1 - BREATH_GAIN:.4f}*clip(min((t-{x0:.3f})/{BREATH_RAMP},({x1:.3f}-t)/{BREATH_RAMP}),0,1))")
    return "*".join(terms)


def render_main_piece(c, W, H, bg, fps, a, b, nframes, job_progress=None, repair=True, breaths=None):
    """Render clip time [a, b] of one main-track clip to a cached lossless intermediate of exactly
    `nframes` frames (H.264 qp0 + PCM)."""
    m = load_meta(c["mid"])
    speed = float(c.get("speed", 1.0))
    full = (c["out"] - c["in"]) / speed
    dur = nframes / fps
    declip = bool(repair and m.get("clipped"))
    key_obj = {k: c.get(k) for k in ("mid", "in", "out", "speed", "volume", "mute", "afadeIn", "afadeOut",
                                     "fit", "zoom", "zoomEnd", "x", "y", "effect", "adj", "kf", "flip", "crop")}
    key_obj.update(W=W, H=H, bg=bg, fps=fps, v=7, path=m["path"], declip=declip, a=round(a, 4), n=nframes)
    if breaths:
        key_obj.update(breaths=breaths, breath_gain=round(BREATH_GAIN, 4))
    out, key = _cache_out(key_obj)
    if out.exists():
        return out
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _, _, codec = video_encode_args(final=False)
    src_in = c["in"] + a * speed
    if m["kind"] == "image":
        inputs = ["-loop", "1", "-framerate", str(fps), "-t", f"{dur + 0.5:.4f}", "-i", m["path"]]
    else:
        inputs = ["-ss", f"{src_in:.4f}", "-t", f"{dur * speed + 0.25:.4f}", "-i", m["path"]]
    vf = main_clip_filters(c, m, W, H, bg, fps, a)
    # exact frame count inside the graph (an output -frames:v limit would cut the audio short at EOF)
    graph = [f"[0:v]{vf},tpad=stop_mode=clone:stop=-1,trim=end_frame={nframes},setpts=PTS-STARTPTS[v]"]
    vol = 0 if c.get("mute") else float(c.get("volume", 1.0))
    if m.get("has_audio") and m["kind"] == "video":
        ach = "[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo"
        if declip:
            ach += "," + DECLIP
        if breaths:  # before atempo: breath times are source seconds from src_in
            g = breath_gain_expr(breaths, src_in, dur * speed + 0.25)
            if g:
                ach += f",volume='{g}':eval=frame"
        if speed != 1:
            ach += "," + atempo_chain(speed)
        ach += f",volume={vol},apad,atrim=0:{dur:.5f}"
        fi = float(c.get("afadeIn") or 0) if a < 1e-4 else 0
        fo = float(c.get("afadeOut") or 0) if abs(b - full) < 1e-3 else 0
        if a < 1e-4:
            ach += f",afade=t=in:d={max(fi, 0.008):.3f}"
        if abs(b - full) < 1e-3:
            ach += f",afade=t=out:st={max(0, dur - max(fo, 0.008)):.4f}:d={max(fo, 0.008):.3f}"
        graph.append(ach + "[a]")
    else:
        graph.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{dur:.5f}[a]")
    tmp = CACHE_DIR / f"{key}.{uuid.uuid4().hex[:6]}.tmp.mkv"
    run_ffmpeg(["ffmpeg", "-y"] + inputs + ["-filter_complex", ";".join(graph),
                "-map", "[v]", "-map", "[a]", "-r", str(fps)] + codec +
               ["-g", str(fps), "-c:a", "pcm_s16le", "-ar", "48000", str(tmp)], job_progress, dur)
    tmp.replace(out)
    return out


def render_transition(tail, head, kind, nframes, fps):
    """Cross two cached pieces with ffmpeg xfade/acrossfade (same names as the preview)."""
    out, key = _cache_out({"tail": tail.name, "head": head.name, "kind": kind, "n": nframes, "fps": fps, "v": 2})
    if out.exists():
        return out
    d = nframes / fps
    tmp = CACHE_DIR / f"{key}.{uuid.uuid4().hex[:6]}.tmp.mkv"
    _, _, codec = video_encode_args(final=False)
    run_ffmpeg(["ffmpeg", "-y", "-i", str(tail), "-i", str(head), "-filter_complex",
                f"[0:v][1:v]xfade=transition={kind}:duration={d:.5f}:offset=0,format=yuv420p,trim=end_frame={nframes}[v];"
                f"[0:a][1:a]acrossfade=d={d:.5f}:c1=tri:c2=tri[a]",
                "-map", "[v]", "-map", "[a]", "-r", str(fps)] + codec +
               ["-g", str(fps), "-c:a", "pcm_s16le", "-ar", "48000", str(tmp)])
    tmp.replace(out)
    return out


def render_gap(W, H, fps, nframes):
    """Black frames + silence for empty space on the main track (magnet off)."""
    out, key = _cache_out({"gap": nframes, "W": W, "H": H, "fps": fps, "v": 1})
    if out.exists():
        return out
    d = nframes / fps
    tmp = CACHE_DIR / f"{key}.{uuid.uuid4().hex[:6]}.tmp.mkv"
    _, _, codec = video_encode_args(final=False)
    run_ffmpeg(["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r={fps}:d={d:.5f},format=yuv420p",
                "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo", "-t", f"{d:.5f}", "-frames:v", str(nframes),
                "-r", str(fps)] + codec + ["-g", str(fps), "-c:a", "pcm_s16le", "-ar", "48000", str(tmp)])
    tmp.replace(out)
    return out


def render_main_track(spec, job, fps, repair):
    """Main track -> ordered list of lossless pieces on one global frame grid (no drift)."""
    W, H, bg = spec["W"], spec["H"], spec.get("bg", "blur")
    F = lambda x: int(round(x * fps))
    clips = spec["main"]
    durs = [(c["out"] - c["in"]) / float(c.get("speed", 1)) for c in clips]
    heads = [float(c.get("tdur") or 0) if i > 0 else 0.0 for i, c in enumerate(clips)]
    tails = heads[1:] + [0.0]
    total_work = sum(durs) or 1
    done = [0.0]
    parts, pending_tail = [], None
    breath_lists, found = {}, {}
    if (spec.get("audioOpts") or {}).get("breaths"):
        job["message"] = "Finding breaths"
        for i, c in enumerate(clips):
            if c["mid"] not in found:
                m = load_meta(c["mid"])
                found[c["mid"]] = breaths_for(m) if m else {"breaths": [], "fragments": []}
            breath_lists[i] = clip_breaths(found[c["mid"]], c)

    def piece(i, a, b):
        c, g0 = clips[i], float(clips[i]["start"])
        n = F(g0 + b) - F(g0 + a)
        if n <= 0:
            return None
        sub = {"p": 0.0}
        start = done[0]
        prog = _ProgressProxy(sub, lambda: job.__setitem__("progress", 0.6 * (start + sub["p"] * (b - a)) / total_work))
        return render_main_piece(c, W, H, bg, fps, a, b, n, prog, repair, breath_lists.get(i)), n

    prev_end = 0.0
    for i, c in enumerate(clips):
        job["message"] = f"Rendering clip {i + 1}/{len(clips)}"
        head, tail, d = heads[i], tails[i], durs[i]
        g0 = float(c["start"])
        if head <= 0 and F(g0) - F(prev_end) > 0:
            parts.append(render_gap(W, H, fps, F(g0) - F(prev_end)))
        prev_end = g0 + d
        if head > 0 and pending_tail:
            h = piece(i, 0, head)
            if h:
                parts.append(render_transition(pending_tail[0], h[0], (c.get("trans") or {}).get("type", "fade"), h[1], fps))
        body = piece(i, head, d - tail)
        if body:
            parts.append(body[0])
        pending_tail = piece(i, d - tail, d) if tail > 0 else None
        done[0] += d
        job["progress"] = 0.6 * done[0] / total_work
    # overlays/text running past the main track: black underneath until the end
    end_f = F(float(spec["duration"]))
    if end_f > F(prev_end):
        parts.append(render_gap(W, H, fps, end_f - F(prev_end)))
    return parts


def overlay_kf(o, prop, base):
    k = (o.get("kf") or {}).get(prop)
    return kf_expr(k, base, "T") if k else None


def overlay_clip_chain(o, m, W, H, idx, fps=30):
    """Filter for one overlay (video/image). Keyframed x/y/scale/opacity/rotate become per-frame
    expressions in local time T. Returns (chain, x_expr, y_expr). Mirrors overlayValues() in player.js."""
    speed = float(o.get("speed", 1.0))
    dur = o["dur"]
    sw, sh = max(1, m["width"]), max(1, m["height"])
    start = float(o["start"])
    sf = source_filters(o, m)
    f = f"[{idx}:v]setpts=(PTS-STARTPTS)/{speed},fps={fps},"
    box = crop_box(o, sw, sh)
    if box:
        f += f"crop={box[2]}:{box[3]}:{box[0]}:{box[1]},"
        sw, sh = box[2], box[3]
    f += (sf + "," if sf else "")
    if o.get("cover"):
        s = max(W / sw, H / sh)
        f += f"scale={even(sw * s)}:{even(sh * s)}:flags={SCALE_FLAGS},format=rgba"
    else:
        ks = overlay_kf(o, "scale", float(o.get("scale", 0.6)))
        if ks:
            k = ks.replace("T", "t")
            f += (f"scale=w='2*ceil({sw}*({W}/{sw})*{k}/2)':h='2*ceil({sh}*({W}/{sw})*{k}/2)':eval=frame:"
                  f"flags={SCALE_FLAGS},format=rgba")
        else:
            s = float(o.get("scale", 0.6)) * W / sw
            f += f"scale={even(sw * s)}:{even(sh * s)}:flags={SCALE_FLAGS},format=rgba"
    kop = overlay_kf(o, "opacity", float(o.get("opacity", 1)))
    if kop:
        f += f",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip({kop},0,1)'"
    else:
        op = float(o.get("opacity", 1.0))
        if op < 1:
            f += f",colorchannelmixer=aa={op:.3f}"
    krot = overlay_kf(o, "rotate", float(o.get("rotate") or 0))
    if krot or o.get("rotate"):
        ang = (krot or str(float(o.get("rotate")))).replace("T", "t")
        f += f",rotate=a='({ang})*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=none"
    fi, fo = float(o.get("fadeIn") or 0), float(o.get("fadeOut") or 0)
    if fi > 0:
        f += f",fade=t=in:st=0:d={fi:.3f}:alpha=1"
    if fo > 0:
        f += f",fade=t=out:st={max(0, dur - fo):.3f}:d={fo:.3f}:alpha=1"
    f += f",trim=0:{dur:.4f},setpts=PTS+{start:.4f}/TB"
    if o.get("cover"):
        return f, "(W-w)/2", "(H-h)/2"
    lt = f"(t-{start:.4f})"
    kx = overlay_kf(o, "x", float(o.get("x", 0.5)))
    ky = overlay_kf(o, "y", float(o.get("y", 0.5)))
    xe = f"({kx.replace('T', lt)})*{W}-w/2" if kx else f"{float(o.get('x', 0.5)) * W:.2f}-w/2"
    ye = f"({ky.replace('T', lt)})*{H}-h/2" if ky else f"{float(o.get('y', 0.5)) * H:.2f}-h/2"
    return f, xe, ye


def build_final(spec, main_file, workdir, measure=None, audio_only=False):
    W, H = spec["W"], spec["H"]
    fps = int(spec.get("fps", 30))
    repair = spec.get("audioOpts", {}).get("repair", True)
    total = spec["duration"]
    D = ["-threads", "2"]  # decoder threads per input: each one holds its own frame buffers
    inputs = D + ["-i", str(main_file)]
    graph = []
    idx = 1
    ov_specs = []
    for o in spec.get("overlays", []):
        m = load_meta(o["mid"])
        if m["kind"] == "image":
            inputs += D + ["-loop", "1", "-framerate", str(fps), "-t", f"{o['dur'] + 0.2:.4f}", "-i", m["path"]]
        else:
            src_len = o["dur"] * float(o.get("speed", 1.0))
            inputs += D + ["-ss", f"{o['in']:.4f}", "-t", f"{src_len + 0.2:.4f}", "-i", m["path"]]
        ov_specs.append((o, m, idx))
        idx += 1
    aud_specs = []
    for a in spec.get("audio", []):
        m = load_meta(a["mid"])
        src_len = a["dur"] * float(a.get("speed", 1.0))
        inputs += D + ["-ss", f"{a['in']:.4f}", "-t", f"{src_len + 0.2:.4f}", "-i", m["path"]]
        aud_specs.append((a, m, idx))
        idx += 1
    text_idx = None
    voice_idx = 0
    if not audio_only:
        inputs += D + ["-f", "concat", "-safe", "0", "-i", str(workdir / "overlay.txt")]
        text_idx = idx
        idx += 1
        # Read the main track's audio through a second, audio-only input. Sharing one input made the
        # demuxer run ahead for audio while queueing raw lossless video packets (~200 MB at 1080p).
        inputs += ["-vn", "-i", str(main_file)]
        voice_idx = idx
        idx += 1

    # ---- video
    if not audio_only:
        base = "[0:v]"
        for k, (o, m, i) in enumerate(ov_specs):
            f, x, y = overlay_clip_chain(o, m, W, H, i, fps)
            graph.append(f + f"[ov{k}]")
            graph.append(f"{base}[ov{k}]overlay=x='{x}':y='{y}':eval=frame:eof_action=pass:"
                         f"enable='between(t,{o['start']:.4f},{o['start'] + o['dur']:.4f})'[b{k}]")
            base = f"[b{k}]"
        graph.append(f"[{text_idx}:v]format=rgba[txt]")
        graph.append(f"{base}[txt]overlay=0:0:format=auto:eof_action=repeat,format=yuv420p[vfinal]")

    # ---- audio
    voices = [f"[{voice_idx}:a]"]
    for k, (o, m, i) in enumerate(ov_specs):
        if m["kind"] == "video" and m.get("has_audio") and not o.get("mute") and float(o.get("volume", 1)) > 0:
            speed = float(o.get("speed", 1.0))
            ch = (f"[{i}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo"
                  + ("," + DECLIP if repair and m.get("clipped") else "")
                  + ("," + atempo_chain(speed) if speed != 1 else "")
                  + f",volume={float(o.get('volume', 1))},atrim=0:{o['dur']:.4f},"
                  f"adelay={int(o['start'] * 1000)}:all=1[oa{k}]")
            graph.append(ch)
            voices.append(f"[oa{k}]")
    music, ducked = [], []
    for k, (a, m, i) in enumerate(aud_specs):
        speed = float(a.get("speed", 1.0))
        dur = a["dur"]
        fi, fo = float(a.get("fadeIn") or 0), float(a.get("fadeOut") or 0)
        ch = (f"[{i}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo"
              + ("," + DECLIP if repair and m.get("clipped") else "")
              + ("," + atempo_chain(speed) if speed != 1 else "")
              + f",volume={0 if a.get('mute') else float(a.get('volume', 1))},atrim=0:{dur:.4f}")
        if fi > 0:
            ch += f",afade=t=in:d={fi:.3f}"
        if fo > 0:
            ch += f",afade=t=out:st={max(0, dur - fo):.3f}:d={fo:.3f}"
        ch += f",adelay={int(a['start'] * 1000)}:all=1[mu{k}]"
        graph.append(ch)
        (ducked if a.get("duck") else music).append(f"[mu{k}]")
    # voice bus
    if len(voices) > 1:
        graph.append("".join(voices) + f"amix=inputs={len(voices)}:normalize=0:duration=first[voice]")
    else:
        graph.append(f"[{voice_idx}:a]anull[voice]")
    mix = ["[voicem]"]
    if ducked:
        graph.append("[voice]asplit=2[voicem][voicesc]")
        if len(ducked) > 1:
            graph.append("".join(ducked) + f"amix=inputs={len(ducked)}:normalize=0[duckin]")
        else:
            graph.append(f"{ducked[0]}anull[duckin]")
        graph.append("[duckin][voicesc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[ducked]")
        mix.append("[ducked]")
    else:
        graph.append("[voice]anull[voicem]")
    mix += music
    chain = []
    ao = spec.get("audioOpts", {})
    if ao.get("enhance"):
        chain += ["highpass=f=80", "afftdn=nf=-25:tn=1",
                  "acompressor=threshold=-20dB:ratio=3:attack=5:release=80:makeup=2"]
    if ao.get("normalize", True):
        target = ao.get("lufs", -14)
        if measure is None:
            chain.append(f"loudnorm=I={target}:TP=-1.0:LRA=11:print_format=json")
        else:
            chain.append(f"loudnorm=I={target}:TP=-1.0:LRA=11:measured_I={measure['input_i']}:"
                         f"measured_TP={measure['input_tp']}:measured_LRA={measure['input_lra']}:"
                         f"measured_thresh={measure['input_thresh']}:offset={measure['target_offset']}:linear=true")
    chain += ["aresample=48000", f"atrim=0:{total:.4f}"]
    if len(mix) > 1:
        graph.append("".join(mix) + f"amix=inputs={len(mix)}:normalize=0:duration=first," + ",".join(chain) + "[afinal]")
    else:
        graph.append(f"{mix[0]}" + ",".join(chain) + "[afinal]")
    return inputs, graph


def export_render(job, pid, spec, workdir):
    if not EXPORT_LOCK.acquire(blocking=False):
        job["message"] = "Waiting for the other export or transcription to finish"
        EXPORT_LOCK.acquire()
    try:
        return _export_render(job, pid, spec, workdir)
    finally:
        EXPORT_LOCK.release()


def _export_render(job, pid, spec, workdir):
    W, H, fps = spec["W"], spec["H"], int(spec.get("fps", 30))
    bg = spec.get("bg", "blur")
    total = spec["duration"]
    clips = spec["main"]
    if not clips and not spec.get("overlays"):
        raise ValueError("The timeline is empty")
    # ---- stage 1: main track as cached lossless pieces (+ transitions)
    job["message"] = "Rendering clips"
    parts = render_main_track(spec, job, fps, spec.get("audioOpts", {}).get("repair", True))
    lst = workdir / "main.txt"
    lst.write_text("".join(f"file '{Path(p).as_posix()}'\n" for p in parts))
    main_file = workdir / "main.mkv"
    run_ffmpeg(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(main_file)])

    # ---- text/caption layer (PNG sequence from the browser)
    with (workdir / "overlay.txt").open("w") as f:
        f.write("ffconcat version 1.0\n")
        last = None
        for fr in spec["overlay"]:
            f.write(f"file 'f{fr['file']}.png'\nduration {fr['frames'] / fps:.6f}\n")
            last = fr["file"]
        if last is not None:
            f.write(f"file 'f{last}.png'\n")

    # ---- loudness measure (audio only)
    measure = None
    if spec.get("audioOpts", {}).get("normalize", True):
        job["message"] = "Measuring loudness"
        inputs, graph = build_final(spec, main_file, workdir, audio_only=True)
        (workdir / "pass1.txt").write_text(";\n".join(graph))
        log = run_ffmpeg(["ffmpeg", "-y", "-filter_complex_threads", "2"] + inputs + [filter_script_opt(), str(workdir / "pass1.txt"),
                          "-map", "[afinal]", "-f", "null", "-"], job, total, 0.6, 0.05)
        mm = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", log, re.S)
        if mm:
            measure = json.loads(mm.group(0))
            if measure["input_i"] in ("-inf", "inf"):
                measure = None
        if measure is None:
            spec.setdefault("audioOpts", {})["normalize"] = False

    # ---- final encode
    job["message"] = "Encoding"
    inputs, graph = build_final(spec, main_file, workdir, measure)
    pre_in, enc_suffix, codec = video_encode_args(final=True, quality=spec.get("quality", "high"))
    if enc_suffix:
        graph = [g.replace("format=yuv420p[vfinal]", f"format=yuv420p{enc_suffix}[vfinal]") for g in graph]
    (workdir / "final.txt").write_text(";\n".join(graph))
    out_dir = expand(CONFIG["export_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^\w\-. ]+", "_", spec.get("name") or "short").strip() or "short"
    # Re-exporting a project replaces its own file; never overwrite another project's export.
    mine = {e["path"] for e in (load_proj(pid) or {}).get("exports", [])} if pid else set()
    base, k = name, 2
    while (out_dir / f"{name}.mp4").exists() and str(out_dir / f"{name}.mp4") not in mine:
        name = f"{base} ({k})"
        k += 1
    out = out_dir / f"{name}.mp4"
    tmp_out = out_dir / f".{name}.{job['id']}.rendering.mp4"
    cmd = (["ffmpeg", "-y", "-filter_complex_threads", "2"] + pre_in + inputs +
           [filter_script_opt(), str(workdir / "final.txt"), "-map", "[vfinal]", "-map", "[afinal]"] + codec +
           ["-r", str(fps), "-g", str(fps * 2), "-color_primaries", "bt709", "-color_trc", "bt709",
            "-colorspace", "bt709", "-c:a", "aac", "-b:a", "320k", "-ar", "48000",
            "-movflags", "+faststart", "-frames:v", str(round(total * fps)), "-t", f"{total:.4f}", str(tmp_out)])
    try:
        run_ffmpeg(cmd, job, total, 0.65, 0.35)
    except RuntimeError:
        if not pre_in:
            raise
        # hardware encoder hiccup: fall back to x264 once
        job["message"] = "Encoding (software fallback)"
        _VAAPI.update(checked=True, device=None)
        inputs, graph = build_final(spec, main_file, workdir, measure)
        (workdir / "final.txt").write_text(";\n".join(graph))
        _, _, codec = video_encode_args(final=True)
        cmd = (["ffmpeg", "-y", "-filter_complex_threads", "2"] + inputs + [filter_script_opt(), str(workdir / "final.txt"),
               "-map", "[vfinal]", "-map", "[afinal]"] + codec +
               ["-r", str(fps), "-g", str(fps * 2), "-c:a", "aac", "-b:a", "320k", "-ar", "48000",
                "-movflags", "+faststart", "-frames:v", str(round(total * fps)), "-t", f"{total:.4f}", str(tmp_out)])
        run_ffmpeg(cmd, job, total, 0.65, 0.35)
    tmp_out.replace(out)
    if spec.get("srt"):
        (out_dir / f"{name}.srt").write_text(spec["srt"])
    if spec.get("text"):
        (out_dir / f"{name}.txt").write_text(spec["text"])
    shutil.rmtree(workdir, ignore_errors=True)
    prune_cache()
    size = out.stat().st_size
    proj = load_proj(pid) if pid else None
    if proj:
        proj.setdefault("exports", []).append({"path": str(out), "at": time.time(), "size": size, "duration": total})
        save_proj(proj)
    job["message"] = "Done"
    return {"path": str(out), "size": size, "duration": total}


class _ProgressProxy(dict):
    """dict-like progress sink for run_ffmpeg that forwards to a callback."""

    def __init__(self, sub, cb):
        super().__init__()
        self._sub, self._cb = sub, cb

    def __setitem__(self, k, v):
        self._sub["p"] = v
        self._cb()


def prune_cache(limit_bytes=8 * 1024 ** 3):
    for t in CACHE_DIR.glob("*.tmp.mkv"):  # leftovers from interrupted renders
        if time.time() - t.stat().st_mtime > 3600:
            t.unlink(missing_ok=True)
    files = sorted((p for p in CACHE_DIR.glob("*.mkv") if not p.name.endswith(".tmp.mkv")), key=lambda p: p.stat().st_atime)
    total = sum(p.stat().st_size for p in files)
    while files and total > limit_bytes:
        p = files.pop(0)
        total -= p.stat().st_size
        p.unlink(missing_ok=True)


def convert_plain(job, src, out):
    """Platform-ready H.264 from any file (e.g. a Resolve export), no edits."""
    m = import_media(src)
    W, H = 1080, 1920
    c = {"mid": m["id"], "in": 0, "out": m["duration"], "start": 0, "fit": "fill" if m["height"] >= m["width"] else "fit"}
    spec = {"W": W, "H": H, "duration": round(round(m["duration"] * 30) / 30, 4), "main": [c], "overlay": [],
            "bg": "blur", "audioOpts": {"normalize": True, "lufs": -14}, "name": Path(out).stem}
    wd = DATA_DIR / f"convert_{job['id']}"
    wd.mkdir(parents=True, exist_ok=True)
    blank = wd / "f0.png"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"color=c=black@0.0:s={W}x{H},format=rgba",
                    "-frames:v", "1", str(blank)], check=True)
    spec["overlay"] = [{"file": 0, "frames": max(1, round(spec["duration"] * 30))}]
    return export_render(job, None, spec, wd)


EXPORTS = {}


# --------------------------------------------------------------------------
# Browse
# --------------------------------------------------------------------------

def browse(dirpath=None):
    if not dirpath:
        roots = []
        for d in CONFIG["library_dirs"]:
            p = expand(d)
            if p.is_dir():
                roots.append({"path": str(p), "name": str(p).replace(str(HOME), "~") or "~"})
        return {"dir": None, "roots": roots, "items": []}
    p = expand(dirpath)
    items = []
    for f in p.iterdir():
        if f.name.startswith("."):
            continue
        if f.is_dir():
            items.append({"path": str(f), "name": f.name, "kind": "dir"})
            continue
        k = media_kind(f)
        if not k:
            continue
        # Hide resolve-audio-fix intermediates (X_dr.mp4) when the original X.* is next to it.
        if f.stem.endswith("_dr") and any(f.with_name(f.stem[:-3] + e).exists()
                                          for e in (".mp4", ".mov", ".mkv", ".MP4", ".MOV")):
            continue
        st = f.stat()
        items.append({"path": str(f), "name": f.name, "kind": k, "size": st.st_size, "mtime": st.st_mtime})
    items.sort(key=lambda x: (x["kind"] != "dir", -x.get("mtime", 0) if x["kind"] != "dir" else x["name"].lower()))
    return {"dir": str(p), "parent": str(p.parent) if p != p.parent else None, "items": items}


def recent_recordings(limit=24):
    """Newest video files across the library folders (top level only)."""
    seen, out = set(), []
    for d in CONFIG["library_dirs"]:
        p = expand(d)
        if not p.is_dir():
            continue
        for it in browse(str(p))["items"]:
            if it["kind"] != "video" or it["path"] in seen:
                continue
            if str(expand(CONFIG["export_dir"])) in it["path"]:
                continue
            seen.add(it["path"])
            it["dir"] = str(Path(it["path"]).parent).replace(str(HOME), "~")
            out.append(it)
    out.sort(key=lambda x: -x["mtime"])
    return out[:limit]


SFX = {
    "Whoosh": "anoisesrc=d=0.8:c=pink:a=0.9,highpass=f=250,lowpass=f=4000,afade=t=in:d=0.35:curve=exp,afade=t=out:st=0.35:d=0.45",
    "Swoosh up": "aevalsrc='0.5*sin(2*PI*(300+1500*t*t)*t)*sin(PI*t/0.6)':d=0.6,highpass=f=200",
    "Pop": "aevalsrc='0.9*sin(2*PI*(380+2600*exp(-38*t))*t)*exp(-22*t)':d=0.18",
    "Ding": "aevalsrc='0.55*sin(2*PI*1318*t)*exp(-3.5*t)+0.25*sin(2*PI*2636*t)*exp(-5*t)':d=1.4",
    "Click": "aevalsrc='0.8*sin(2*PI*2200*t)*exp(-180*t)':d=0.06",
    "Boom": "aevalsrc='0.95*sin(2*PI*(48+60*exp(-6*t))*t)*exp(-2.8*t)':d=1.6,lowpass=f=300",
    "Riser": "aevalsrc='0.35*sin(2*PI*(150+700*t*t)*t)*(t/2.5)':d=2.5,highpass=f=120",
    "Glitch": "anoisesrc=d=0.35:c=white:a=0.6,acrusher=bits=3:samples=24:mix=1,afade=t=out:st=0.25:d=0.1",
    "Camera": "aevalsrc='0.8*(random(0)-0.5)*(exp(-120*t)+exp(-120*max(t-0.09,0))*gte(t,0.09))':d=0.25,highpass=f=800",
    "Notification": "aevalsrc='0.5*sin(2*PI*880*t)*exp(-9*t)+0.5*sin(2*PI*1320*max(t-0.1,0))*exp(-9*max(t-0.1,0))*gte(t,0.1)':d=0.6",
}


def sfx_list():
    d = DATA_DIR / "sfx"
    d.mkdir(parents=True, exist_ok=True)
    out = []
    for name, src in SFX.items():
        f = d / f"{name}.wav"
        if not f.exists():
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", src, "-ac", "2", "-ar", "48000", str(f)], check=True)
        out.append({"name": name, "path": str(f)})
    return out


def audio_library(limit=300):
    """Music/audio files in the usual folders (two levels deep)."""
    roots = [expand(d) for d in ["~/Music", "~/Downloads", CONFIG["upload_dir"], "~/Videos"]] + \
            [expand(d) for d in CONFIG["library_dirs"] if expand(d) != HOME]
    seen, out = set(), []

    def scan(d, depth):
        try:
            entries = list(d.iterdir())
        except OSError:
            return
        for f in entries:
            if f.name.startswith("."):
                continue
            if f.is_dir() and depth > 0:
                scan(f, depth - 1)
            elif f.is_file() and f.suffix.lower() in AUDIO_EXTS and str(f) not in seen:
                seen.add(str(f))
                out.append({"path": str(f), "name": f.stem, "dir": str(f.parent).replace(str(HOME), "~"), "mtime": f.stat().st_mtime})
    for r in roots:
        if r.is_dir():
            scan(r, 2)
    out.sort(key=lambda x: -x["mtime"])
    return out[:limit]


VISION = [venv_python(".venv-vision"), str(APP_DIR / "vision.py")]


def run_vision(job, args):
    """One heavy job at a time (shares the export lock), low priority, progress from stdout."""
    if not EXPORT_LOCK.acquire(blocking=False):
        job["message"] = "Waiting for the current render to finish"
        EXPORT_LOCK.acquire()
    try:
        proc = subprocess.Popen(low(VISION + args, 15), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **LOW_FLAGS)
        err = []
        threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True).start()
        for line in proc.stdout:
            try:
                job["progress"] = float(json.loads(line).get("progress", job["progress"]))
            except (ValueError, AttributeError):
                pass
        if proc.wait() != 0:
            raise RuntimeError("vision failed: " + "".join(err)[-600:])
    finally:
        EXPORT_LOCK.release()


def job_faces(job, mid, start, end):
    m = load_meta(mid)
    out = mdir(mid) / f"faces_{start:.2f}_{end:.2f}.json"
    if not out.exists():
        job["message"] = "Finding your face"
        run_vision(job, ["faces", m["path"], f"{start:.3f}", f"{end:.3f}", str(out)])
    return json.loads(out.read_text())


def job_removebg(job, mid, start, end, bg):
    m = load_meta(mid)
    d = expand(CONFIG["upload_dir"])
    d.mkdir(parents=True, exist_ok=True)
    tag = "blur" if bg == "blur" else bg.lstrip("#")
    out = d / f"{Path(m['path']).stem} (background {tag}) {start:.1f}-{end:.1f}.mp4"
    if not out.exists():
        job["message"] = "Removing the background"
        tmp = d / f".{out.stem}.part.mp4"
        run_vision(job, ["removebg", m["path"], f"{start:.3f}", f"{end:.3f}", str(tmp), "--bg", bg])
        tmp.replace(out)
    nm = import_media(out)
    # carry the transcript over (shifted), so captions keep working on the processed clip
    src_words = load_words(mid)
    if src_words["words"] and not (mdir(nm["id"]) / "words.json").exists():
        ws = [dict(w, start=round(w["start"] - start, 3), end=round(w["end"] - start, 3))
              for w in src_words["words"] if start <= (w["start"] + w["end"]) / 2 < end]
        cov = [[max(0, a - start), min(end, b) - start] for a, b in src_words["covered"] if b > start and a < end]
        atomic_write(mdir(nm["id"]) / "words.json", json.dumps({"words": ws, "covered": cov, "model": src_words.get("model")}))
        nm = update_meta(nm["id"], covered=cov)
    return media_public(nm)


def make_still(mid, t):
    """Freeze frame: a full-resolution PNG of the source at time t."""
    m = load_meta(mid)
    d = expand(CONFIG["upload_dir"])
    d.mkdir(parents=True, exist_ok=True)
    out = d / f"{Path(m['path']).stem} frame {t:.2f}s.png"
    if not out.exists():
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.4f}", "-i", m["path"], "-frames:v", "1", str(out)], check=True)
    return import_media(out)


def thumbnail(path):
    p = expand(path)
    key = hashlib.sha1(f"{p}|{p.stat().st_mtime}".encode()).hexdigest()[:16]
    out = THUMBS_DIR / f"{key}.jpg"
    if not out.exists():
        THUMBS_DIR.mkdir(parents=True, exist_ok=True)
        for ss in (["-ss", "1"], []):
            subprocess.run(low(["ffmpeg", "-v", "quiet", "-y"] + ss + ["-i", str(p), "-frames:v", "1",
                                "-vf", "scale=240:-2", str(out)]), check=False)
            if out.exists():
                break
    return out


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "ShortsStudio/2.0"
    # HTTP/1.0: one request per connection. Keep-alive buys nothing on localhost and its
    # connection reuse caused stalls (Firefox pools max 6 connections, <video> parks them).
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("SHORTS_DEBUG"):
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        # Cached: every POST body is consumed exactly once (see do_POST), otherwise leftover
        # bytes would corrupt the next request on a keep-alive connection.
        if not hasattr(self, "_body"):
            n = int(self.headers.get("Content-Length") or 0)
            self._body = self.rfile.read(n) if n else b""
        return self._body

    def read_json(self):
        b = self.read_body()
        return json.loads(b) if b else {}

    def send_file(self, path, ctype=None, cache=False):
        path = Path(path)
        if not path.is_file():
            return self.send_json({"error": "not found"}, 404)
        size = path.stat().st_size
        ctype = ctype or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = min(int(m.group(2)), size - 1)
                elif m.group(2):
                    start = max(0, size - int(m.group(2)))
            # Serve media in bounded chunks: an open-ended range would keep the connection
            # busy for the whole file, and browsers only open ~6 per host.
            # 512 KB: small enough that a paused <video> never parks a connection mid-response.
            end = min(end, start + 512 * 1024 - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-cache")
        self.end_headers()
        with path.open("rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def trusted(self):
        """Only the studio page itself may call the API (blocks other websites / DNS rebinding)."""
        port = self.server.server_address[1]
        ok_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if self.headers.get("Host") not in ok_hosts:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {f"http://{h}" for h in ok_hosts}

    def do_GET(self):
        self.__dict__.pop("_body", None)  # handler objects are reused across keep-alive requests
        if not self.trusted():
            return self.send_json({"error": "forbidden"}, 403)
        try:
            self.route_get()
        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        self.__dict__.pop("_body", None)  # handler objects are reused across keep-alive requests
        # Cross-site form posts carry an Origin; our own fetches come from our origin.
        if not self.trusted() or (self.headers.get("Origin") is None and
                                  self.headers.get("Sec-Fetch-Site") not in (None, "same-origin")):
            self.read_body()
            return self.send_json({"error": "forbidden"}, 403)
        try:
            if self.path.split("?")[0] != "/api/media/upload":  # uploads stream their own body
                self.read_body()
            self.route_post()
        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": str(e)}, 500)

    do_PUT = do_POST
    do_DELETE = do_POST

    def route_get(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = unquote(u.path)
        if path in ("/", "/index.html"):
            app = STATIC_DIR / "app" / "index.html"  # React build (web/), falls back to the old page
            return self.send_file(app if app.exists() else STATIC_DIR / "index.html", "text/html; charset=utf-8")
        if path.startswith("/static/"):
            f = (STATIC_DIR / path[len("/static/"):]).resolve()
            if STATIC_DIR not in f.parents:
                return self.send_json({"error": "forbidden"}, 403)
            ctype = "text/javascript" if f.suffix == ".js" else None
            return self.send_file(f, ctype, cache="/assets/" in path)
        if path == "/api/ping":
            return self.send_json({"ok": True})
        if path == "/api/config":
            return self.send_json(CONFIG)
        if path == "/api/defaults":
            return self.send_json(json.loads(DEFAULTS_PATH.read_text()) if DEFAULTS_PATH.exists() else {})
        if path == "/api/browse":
            return self.send_json(browse(q.get("dir")))
        if path == "/api/thumb":
            return self.send_file(thumbnail(q["path"]), "image/jpeg", cache=True)
        if path == "/api/projects":
            return self.send_json(list_projects())
        if path == "/api/audio-library":
            return self.send_json(audio_library())
        if path == "/api/audiofile":
            f = expand(q["path"])
            if f.suffix.lower() not in AUDIO_EXTS or not f.is_file():
                return self.send_json({"error": "not an audio file"}, 403)
            return self.send_file(f)
        if path == "/api/sfx":
            return self.send_json(sfx_list())
        if path == "/api/recent":
            return self.send_json(recent_recordings())
        m = re.fullmatch(r"/api/projects/([0-9a-f]{12})", path)
        if m:
            p = load_proj(m.group(1))
            return self.send_json(p) if p else self.send_json({"error": "no such project"}, 404)
        m = re.fullmatch(r"/api/media/([0-9a-f]{12})", path)
        if m:
            meta = load_meta(m.group(1))
            return self.send_json(media_public(meta)) if meta else self.send_json({"error": "no such media"}, 404)
        if path == "/api/media":
            ids = [i for i in q.get("ids", "").split(",") if i]
            out = []
            for i in ids:
                meta = load_meta(check_id(i))
                if meta:
                    # opening a project upgrades its old, low-res preview copies in the background
                    if (meta["kind"] == "video" and meta.get("proxy_v", 1) != PROXY_V and Path(meta["path"]).exists()
                            and (mdir(meta["id"]) / proxy_name(meta)).exists()):
                        _put(5, meta["id"], "upgrade")
                    out.append(media_public(meta))
            return self.send_json(out)
        m = re.fullmatch(r"/media/([0-9a-f]{12})/(preview|sprite\.jpg|peaks\.json|words\.json|breaths\.json)", path)
        if m:
            meta = load_meta(m.group(1))
            if not meta:
                return self.send_json({"error": "no such media"}, 404)
            if m.group(2) == "breaths.json":
                return self.send_json(breaths_for(meta))
            if m.group(2) == "preview":
                return self.send_file(preview_file(meta))
            return self.send_file(mdir(meta["id"]) / m.group(2), cache=m.group(2) != "words.json")
        if path == "/api/queue":
            return self.send_json({"current": CURRENT["task"], "progress": CURRENT["progress"],
                                   "message": CURRENT["message"], "queued": TASKS.qsize()})
        m = re.fullmatch(r"/api/jobs/([0-9a-f]{12})", path)
        if m:
            job = JOBS.get(m.group(1))
            return self.send_json(job or {"error": "no such job"}, 200 if job else 404)
        if path == "/api/file":
            f = expand(q["path"]).resolve()
            if expand(CONFIG["export_dir"]).resolve() not in f.parents:
                return self.send_json({"error": "forbidden"}, 403)
            return self.send_file(f)
        return self.send_json({"error": "not found"}, 404)

    def route_post(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        path = unquote(u.path)
        method = self.command
        if path == "/api/defaults":
            DEFAULTS_PATH.write_text(json.dumps(self.read_json(), indent=2))
            return self.send_json({"ok": True})
        if path == "/api/projects":
            body = self.read_json()
            p = new_project(body.get("name"), body.get("from"))
            return self.send_json({"id": p["id"]})
        m = re.fullmatch(r"/api/projects/([0-9a-f]{12})", path)
        if m:
            if method == "DELETE":
                ppath(m.group(1)).unlink(missing_ok=True)
                return self.send_json({"ok": True})
            body = self.read_json()
            old = load_proj(m.group(1)) or {}
            body["id"] = m.group(1)
            body.setdefault("created", old.get("created", time.time()))
            body["exports"] = old.get("exports", [])
            save_proj(body)
            return self.send_json({"ok": True, "updated": body["updated"]})
        if path == "/api/media/import":
            body = self.read_json()
            meta = import_media(body["path"], transcribe=bool(body.get("transcribe")))
            return self.send_json(media_public(meta))
        if path == "/api/media/upload":
            name = re.sub(r"[^\w\-. ]+", "_", Path(q.get("name", "upload")).name)
            if not media_kind(name):
                return self.send_json({"error": "unsupported file type"}, 400)
            d = expand(CONFIG["upload_dir"])
            d.mkdir(parents=True, exist_ok=True)
            dest = d / name
            stem, suf, k = dest.stem, dest.suffix, 1
            while dest.exists():
                dest = d / f"{stem} ({k}){suf}"
                k += 1
            left = int(self.headers.get("Content-Length") or 0)
            tmp = d / f".{dest.name}.part"
            with tmp.open("wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            tmp.replace(dest)
            return self.send_json(media_public(import_media(dest)))
        m = re.fullmatch(r"/api/media/([0-9a-f]{12})/(faces|removebg)", path)
        if m:
            body = self.read_json()
            job = new_job(m.group(2))
            st, en = float(body.get("start", 0)), float(body.get("end", 0))
            if m.group(2) == "faces":
                run_job(job, job_faces, m.group(1), st, en)
            else:
                bg = body.get("bg", "blur")
                if bg != "blur" and not re.fullmatch(r"#[0-9a-fA-F]{6}", bg):
                    return self.send_json({"error": "bad background"}, 400)
                run_job(job, job_removebg, m.group(1), st, en, bg)
            return self.send_json({"job": job["id"]})
        m = re.fullmatch(r"/api/media/([0-9a-f]{12})/still", path)
        if m:
            return self.send_json(media_public(make_still(m.group(1), float(self.read_json().get("t", 0)))))
        m = re.fullmatch(r"/api/media/([0-9a-f]{12})/transcribe", path)
        if m:
            body = self.read_json()
            secs = enqueue_transcribe(m.group(1), body.get("ranges"), body.get("model"), force=bool(body.get("force")))
            return self.send_json({"ok": True, "seconds": secs})
        m = re.fullmatch(r"/api/projects/([0-9a-f]{12})/export/begin", path)
        if m:
            job = new_job("export", m.group(1))
            job["status"] = "uploading"
            wd = DATA_DIR / f"export_{job['id']}"
            wd.mkdir(parents=True, exist_ok=True)
            EXPORTS[job["id"]] = {"dir": wd, "project": m.group(1)}
            return self.send_json({"job": job["id"]})
        m = re.fullmatch(r"/api/export/([0-9a-f]{12})/frame", path)
        if m:
            ex = EXPORTS[m.group(1)]
            (ex["dir"] / f"f{int(q['i'])}.png").write_bytes(self.read_body())
            return self.send_json({"ok": True})
        m = re.fullmatch(r"/api/export/([0-9a-f]{12})/start", path)
        if m:
            jid = m.group(1)
            ex = EXPORTS.pop(jid)
            spec = self.read_json()
            job = JOBS[jid]
            job["status"] = "running"
            run_job(job, export_render, ex["project"], spec, ex["dir"])
            return self.send_json({"job": jid})
        if path == "/api/convert":
            src = expand(self.read_json()["path"])
            out = expand(CONFIG["export_dir"]) / (src.stem + ".mp4")
            job = new_job("convert")
            run_job(job, convert_plain, src, out)
            return self.send_json({"job": job["id"]})
        if path == "/api/reveal":
            p = expand(self.read_json()["path"])
            target = p if p.is_dir() else p.parent
            open_in_file_manager(target)
            return self.send_json({"ok": True})
        return self.send_json({"error": "not found"}, 404)


def main():
    for d in (MEDIA_DIR, PROJECTS_DIR, CACHE_DIR):
        d.mkdir(parents=True, exist_ok=True)
    # Work folders of exports that never finished (crash, restart) are just disk; drop old ones.
    for d in DATA_DIR.glob("export_*"):
        if d.is_dir() and time.time() - d.stat().st_mtime > 6 * 3600:
            shutil.rmtree(d, ignore_errors=True)
    # Media tasks interrupted by a restart go back in the queue.
    for f in MEDIA_DIR.glob("*/meta.json"):
        try:
            meta = json.loads(f.read_text())
            st = meta.get("status", {})
            for task, state in st.items():
                if state in ("queued", "running"):
                    st[task] = None
            save_meta(meta)
            enqueue_prep(meta["id"])
        except Exception:
            traceback.print_exc()
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=vaapi_device, daemon=True).start()
    port = int(os.environ.get("SHORTS_PORT", CONFIG["port"]))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    print(f"Shorts on http://127.0.0.1:{port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
