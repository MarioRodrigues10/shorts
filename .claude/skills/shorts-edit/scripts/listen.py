#!/usr/bin/env python3
"""Ears for an export: what a listener would notice at every cut and every sound effect.

Usage (run with the Shorts .venv python):
  listen.py PROJECT EXPORT.mp4 [--data DIR] [--top 8] [--json OUT.json]
  listen.py PROJECT EXPORT.mp4 --page DIR        # listening page to calibrate on your own ears
  listen.py --calibrate RATINGS.json             # learn your taste from the page's ratings

PROJECT is a project id or a path to its .json (data dir: ~/.local/share/shorts-studio or $XDG_DATA_HOME).

At every joint (two main-track clips that aren't contiguous in the source) it measures, on the
exported audio, what makes a cut sound edited:
  click      a sample jump at the edit (an un-faded cut), vs the waveform around it
  level      loudness step between the last 250 ms before and the first 250 ms after
  pitch      voice pitch jump across a cut with no pause, in semitones (octave errors folded)
  timbre     spectral jump (log-mel) across the cut, as a z-score vs neighbouring windows elsewhere
  gap        the pause the listener hears: < 40 ms between words = rushed, > 450 ms = dead air
  breath     a breath leftover within 300 ms of the cut
Each sound effect gets its level vs the voice around it (the final loudness pass scales the
whole mix, so the balance measured before it holds): editors keep SFX ~6-10 dB under the voice.

Thresholds are generic until you calibrate: --page writes a page of short clips (every joint and
effect) with Good / Bad buttons; save the ratings it downloads and run --calibrate on them. The
learned weights (~/.config/shorts-studio/ears.json) then rank joints the way you hear them.
"""
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

SR = 16000
EARS = Path.home() / ".config/shorts-studio/ears.json"
FEATURES = ["click", "level", "pitch", "timbre", "rushed", "dead_air", "breath"]
# generic weights (before calibration): what counts as one "unit" of badness per feature
DEFAULT = {"scale": {"click": 4.0, "level": 6.0, "pitch": 4.0, "timbre": 2.5, "rushed": 1.0, "dead_air": 1.0, "breath": 1.0},
           "weights": {f: 1.0 for f in FEATURES}, "bias": -1.0, "sfx_range": [-16.0, -4.0]}


def load(path, sr=SR):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", str(path), "-map", "0:a:0", "-ac", "1", "-ar", str(sr),
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def db(x):
    return 20 * math.log10(math.sqrt(float(np.mean(x ** 2))) + 1e-9) if len(x) else -120.0


def frames(a, hop=0.01, win=0.03):
    h, w = int(hop * SR), int(win * SR)
    n = max(0, (len(a) - w) // h)
    idx = np.arange(w)[None, :] + h * np.arange(n)[:, None]
    return a[idx] if n else np.zeros((0, w), np.float32)


def f0(seg):
    """Median pitch (Hz) of the voiced 30 ms frames in seg, or None."""
    out = []
    for fr in frames(seg):
        fr = fr * np.hanning(len(fr))
        if db(fr) < -45:
            continue
        ac = np.fft.irfft(np.abs(np.fft.rfft(fr, 2 * len(fr))) ** 2)[: len(fr)]
        if ac[0] <= 0:
            continue
        ac /= ac[0]
        lo, hi = SR // 400, SR // 70
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] > 0.5:
            out.append(SR / k)
    return float(np.median(out)) if len(out) >= 3 else None


MEL = None


def logmel(seg):
    global MEL
    n = 512
    if MEL is None:
        mel = lambda f: 2595 * np.log10(1 + f / 700)
        pts = 700 * (10 ** (np.linspace(mel(80), mel(7600), 42) / 2595) - 1)
        bins = np.floor((n + 1) * pts / SR).astype(int)
        MEL = np.zeros((40, n // 2 + 1))
        for i in range(40):
            a, b, c = bins[i], bins[i + 1], bins[i + 2]
            MEL[i, a:b] = np.linspace(0, 1, max(1, b - a), endpoint=False)
            MEL[i, b:c] = np.linspace(1, 0, max(1, c - b), endpoint=False)
    if len(seg) < n:
        seg = np.pad(seg, (0, n - len(seg)))
    spec = np.abs(np.fft.rfft(seg[:n] * np.hanning(n))) ** 2
    return np.log(MEL @ spec + 1e-10)


def project(arg, data):
    p = Path(arg)
    if not p.exists():
        p = data / "projects2" / f"{arg}.json"
    return json.load(open(p))


def joints(p):
    main = next(t for t in p["tracks"] if t["kind"] == "main")["clips"]
    out = []
    for a, b in zip(main, main[1:]):
        if a["mid"] == b["mid"] and abs(b["in"] - a["out"]) < 0.02:
            continue  # contiguous in the source: not an audible edit
        out.append({"t": b["start"], "src": [round(a["out"], 3), round(b["in"], 3)]})
    return out


def measure_joint(a, a48, t, floor, breaths, mel_sd):
    i = int(t * SR)
    pre, post = a[max(0, i - int(0.25 * SR)): i], a[i: i + int(0.25 * SR)]
    # click: biggest sample-to-sample jump within 3 ms of the edit vs the 99th pct around it
    j = int(t * 48000)
    near = np.abs(np.diff(a48[max(0, j - 144): j + 144]))
    around = np.abs(np.diff(np.concatenate([a48[max(0, j - 4800): max(0, j - 480)], a48[j + 480: j + 4800]])))
    click = float(near.max() / (np.percentile(around, 99) + 1e-6)) if len(near) and len(around) else 0.0
    # level step between the speech on both sides
    sp = lambda s: s[np.abs(s) > 10 ** ((floor + 12) / 20)]
    level = abs(db(sp(pre)) - db(sp(post))) if len(sp(pre)) > 400 and len(sp(post)) > 400 else 0.0
    # pitch jump (only when voice on both sides, close to the cut)
    fa, fb = f0(a[max(0, i - int(0.12 * SR)): i]), f0(a[i: i + int(0.12 * SR)])
    pitch = 0.0
    if fa and fb:  # fold octave errors of the pitch tracker (a jump of ~12 semitones is one)
        d = 12 * math.log2(fa / fb)
        pitch = min(abs(d), abs(d - 12), abs(d + 12))
    # timbre jump: log-mel 80 ms each side, as a z-score against ordinary neighbouring windows
    d = float(np.linalg.norm(logmel(a[max(0, i - 1280): i]) - logmel(a[i: i + 1280])))
    timbre = max(0.0, (d - mel_sd[0]) / (mel_sd[1] + 1e-6))
    # the pause the listener hears around the cut
    fr = frames(a[max(0, i - int(0.8 * SR)): i + int(0.8 * SR)])
    quiet = np.array([db(x) < floor + 12 for x in fr])
    # the longest quiet run that touches the 200 ms around the cut (the pause may sit just
    # before or after the edit point, not on it)
    c = min(len(quiet) - 1, int(0.8 / 0.01)) if len(quiet) else 0
    gap, k = 0.0, 0
    while k < len(quiet):
        if quiet[k]:
            e = k
            while e + 1 < len(quiet) and quiet[e + 1]:
                e += 1
            if e >= c - 10 and k <= c + 10:
                gap = max(gap, (e - k + 1) * 0.01)
            k = e + 1
        else:
            k += 1
    breath = float(any(s - 0.3 < t < e + 0.3 for s, e in breaths))
    if gap >= 0.12:
        pitch = 0.0  # after a pause, a new pitch is how speech works, not an edit
    return {"click": round(click, 2), "level": round(level, 1), "pitch": round(pitch, 1), "timbre": round(timbre, 2),
            "gap": round(gap, 2), "rushed": float(gap < 0.04 and pitch > 2), "dead_air": float(gap > 0.45),
            "breath": breath}


def score(m, ears):
    x = sum(ears["weights"][f] * (m[f] / ears["scale"][f] if f in ears["scale"] else m[f]) for f in FEATURES)
    return 1 / (1 + math.exp(-(x + ears["bias"])))


def why(m, ears):
    s = ears["scale"]
    out = []
    if m["click"] > s["click"]: out.append(f"click at the edit ({m['click']}x)")
    if m["level"] > s["level"]: out.append(f"loudness jumps {m['level']} dB")
    if m["pitch"] > s["pitch"]: out.append(f"pitch jumps {m['pitch']} semitones")
    if m["timbre"] > s["timbre"]: out.append(f"tone changes (z {m['timbre']})")
    if m["rushed"]: out.append("no breathing room between words")
    if m["dead_air"]: out.append(f"dead air {m['gap']} s")
    if m["breath"]: out.append("breath leftover")
    return "; ".join(out) or "-"


def sfx_levels(p, data, a, t_gain):
    out = []
    for t in p["tracks"]:
        if t["kind"] != "audio":
            continue
        for c in t["clips"]:
            meta = json.load(open(data / "media" / c["mid"] / "meta.json"))
            dur = (c["out"] - c["in"]) / (c.get("speed") or 1)
            if dur > 3:  # music bed, not an effect
                continue
            x = load(meta["path"])[int(c["in"] * SR): int(c["out"] * SR)]
            win = min(0.1, 0.9 * len(x) / SR)  # short effects (a 60 ms click) get a shorter window
            peak = max((db(f) for f in frames(x, 0.005, win)), default=db(x)) + 20 * math.log10(max(1e-4, c.get("volume", 1)))
            i = int(c["start"] * SR)
            ctx = np.concatenate([a[max(0, i - int(1.5 * SR)): i], a[i + int(dur * SR): i + int((dur + 1.5) * SR)]])
            voice = [db(f) for f in frames(ctx, 0.01, 0.1)]
            voice = sorted(v for v in voice if v > -45)
            vlev = voice[int(len(voice) * 0.8)] if voice else -20  # loud-ish speech level nearby
            out.append({"t": round(c["start"], 2), "name": meta["name"], "rel_db": round(peak + t_gain - vlev, 1)})
    return out


def analyse(p, export, data, ears):
    a, a48 = load(export), load(export, 48000)
    floor = float(np.percentile([db(f) for f in frames(a, 0.02, 0.02)], 10))
    br = []
    try:
        import breathmap as BM  # breaths in the export, measured with the same filtered detector
        import cutplan as C
        F = C.features(a)
        words = [{"start": s * C.HOP, "end": e * C.HOP} for s, e in F["runs"]]
        br, _, _ = BM.detect(a, words)
    except Exception:
        pass
    # typical spectral distance between neighbouring 80 ms windows (speech only)
    ds = []
    for k in range(int(0.5 * SR), len(a) - 2 * 1280, int(0.37 * SR)):
        x, y = a[k - 1280: k], a[k: k + 1280]
        if db(x) > floor + 15 and db(y) > floor + 15:
            ds.append(float(np.linalg.norm(logmel(x) - logmel(y))))
    mel_sd = (float(np.mean(ds)), float(np.std(ds))) if ds else (0.0, 1.0)
    js = []
    for j in joints(p):
        m = measure_joint(a, a48, j["t"], floor, br, mel_sd)
        js.append(dict(j, **m, score=round(score(m, ears), 3), why=why(m, ears)))
    # the final loudness pass: export speech level vs the source speech level -> gain applied to SFX too
    main = next(t for t in p["tracks"] if t["kind"] == "main")["clips"]
    src = load(json.load(open(data / "media" / main[0]["mid"] / "meta.json"))["path"])
    sl = [db(f) for f in frames(src, 0.01, 0.1)]
    el = [db(f) for f in frames(a, 0.01, 0.1)]
    t_gain = float(np.percentile([v for v in el if v > -45], 80) - np.percentile([v for v in sl if v > -45], 80))
    sfx = sfx_levels(p, data, a, t_gain)
    lo, hi = ears["sfx_range"]
    for s in sfx:
        s["verdict"] = "too loud" if s["rel_db"] > hi else ("barely audible" if s["rel_db"] < lo else "ok")
    return {"joints": js, "sfx": sfx, "floor_db": round(floor, 1)}


def page(res, export, outdir):
    """A listening page: every joint and effect as a short clip with Good / Bad buttons."""
    outdir = Path(outdir)
    (outdir / "clips").mkdir(parents=True, exist_ok=True)
    items = [("j", j["t"], f"Cut at {j['t']:.1f}s", j.get("why", "")) for j in res["joints"]]
    items += [("s", s["t"], f"{s['name']} at {s['t']:.1f}s", f"{s['rel_db']} dB vs voice") for s in res["sfx"]]
    rows = []
    for kind, t, title, note in items:
        key = f"{kind}{t:.2f}"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{max(0, t - 1.6):.2f}", "-t", "3.2", "-i", str(export),
                        "-vn", "-ac", "1", "-c:a", "aac", "-b:a", "96k", str(outdir / "clips" / f"{key}.m4a")])
        rows.append(f'<li data-k="{key}"><div><b>{title}</b><small>{note}</small></div><audio controls preload="none" '
                    f'src="clips/{key}.m4a"></audio><span><button data-v="good">Sounds fine</button>'
                    f'<button data-v="bad">Sounds edited</button></span></li>')
    html = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shorts ears: calibration</title>
<style>
:root{--bg:#faf8f6;--fg:#1c1917;--mut:#78716c;--line:#e7e5e4;--a:#dc4a22;--b:#1e9baa}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--mut:#a8a29e;--line:#292524}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 80px}h1{font-size:22px;margin:0 0 4px}
p{color:var(--mut);margin:0 0 20px}ul{list-style:none;padding:0;margin:0}
li{display:grid;grid-template-columns:1fr;gap:8px;padding:14px 0;border-top:1px solid var(--line)}
li small{display:block;color:var(--mut)}audio{width:100%}
button{font:inherit;padding:7px 12px;margin-right:8px;border-radius:8px;border:1px solid var(--line);background:none;color:inherit;cursor:pointer}
li[data-v=good] button[data-v=good]{background:var(--b);color:#fff;border-color:var(--b)}
li[data-v=bad] button[data-v=bad]{background:var(--a);color:#fff;border-color:var(--a)}
#save{position:fixed;right:16px;bottom:16px;background:var(--fg);color:var(--bg);border:0;padding:10px 16px}
</style><main><h1>Calibrate the ears</h1>
<p>Listen to each clip (the cut or sound effect is in the middle) and mark it. Then save, and run
<code>listen.py --calibrate ratings.json</code>.</p><ul>""" + "".join(rows) + """</ul></main>
<button id="save">Save ratings</button>
<script>
const r={};document.querySelectorAll('li').forEach(li=>li.querySelectorAll('button').forEach(b=>b.onclick=()=>{li.dataset.v=b.dataset.v;r[li.dataset.k]=b.dataset.v}));
document.getElementById('save').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(r,null,1)],{type:'application/json'}));a.download='ratings.json';a.click()};
</script>"""
    (outdir / "index.html").write_text(html)
    json.dump(res, open(outdir / "measurements.json", "w"), indent=1)
    return outdir / "index.html"


def calibrate(ratings_path):
    """Fit weights so 'bad' joints score high (logistic regression, numpy) and the SFX range
    so the effects you marked fine sit inside it. Needs measurements.json next to the ratings
    or in the same folder as the page."""
    rp = Path(ratings_path)
    meas = json.load(open(next(p for p in [rp.parent / "measurements.json", rp.with_name("measurements.json")] if p.exists())))
    ratings = json.load(open(rp))
    ears = json.loads(EARS.read_text()) if EARS.exists() else json.loads(json.dumps(DEFAULT))
    X, y = [], []
    for j in meas["joints"]:
        v = ratings.get(f"j{j['t']:.2f}")
        if v:
            X.append([j[f] / ears["scale"].get(f, 1.0) for f in FEATURES])
            y.append(1.0 if v == "bad" else 0.0)
    if len(set(y)) == 2:
        X, y = np.array(X), np.array(y)
        w, b = np.ones(len(FEATURES)), -1.0
        for _ in range(3000):  # plain gradient descent, L2-regularised: few ratings, keep it tame
            p = 1 / (1 + np.exp(-(X @ w + b)))
            w -= 0.1 * (X.T @ (p - y) / len(y) + 0.05 * (w - 1))
            b -= 0.1 * float(np.mean(p - y))
        ears["weights"] = {f: round(float(v), 3) for f, v in zip(FEATURES, w)}
        ears["bias"] = round(b, 3)
    ok = [s["rel_db"] for s in meas["sfx"] if ratings.get(f"s{s['t']:.2f}") == "good"]
    bad = [s["rel_db"] for s in meas["sfx"] if ratings.get(f"s{s['t']:.2f}") == "bad"]
    if ok:
        ears["sfx_range"] = [round(min(ok) - 1, 1), round(max(ok) + 1, 1)]
    EARS.parent.mkdir(parents=True, exist_ok=True)
    EARS.write_text(json.dumps(ears, indent=1))
    print(f"learned from {len(y)} joints and {len(ok) + len(bad)} effects -> {EARS}")


def main():
    a = sys.argv
    if "--calibrate" in a:
        return calibrate(a[a.index("--calibrate") + 1])
    data = Path(a[a.index("--data") + 1]).expanduser() if "--data" in a else Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "shorts-studio"
    ears = json.loads(EARS.read_text()) if EARS.exists() else DEFAULT
    p = project(a[1], data)
    res = analyse(p, a[2], data, ears)
    top = int(a[a.index("--top") + 1]) if "--top" in a else 8
    js = sorted(res["joints"], key=lambda j: -j["score"])
    print(f"{len(js)} cuts heard ({'calibrated' if EARS.exists() else 'generic thresholds'}); worst {min(top, len(js))}:")
    for j in js[:top]:
        print(f"  {j['t']:7.2f}s  score {j['score']:.2f}  {j['why']}   [click {j['click']} level {j['level']}dB "
              f"pitch {j['pitch']}st timbre {j['timbre']} gap {j['gap']}s]")
    print(f"{len(res['sfx'])} sound effects (aim {ears['sfx_range'][0]} to {ears['sfx_range'][1]} dB vs voice):")
    for s in res["sfx"]:
        print(f"  {s['t']:7.2f}s  {s['name']:<16} {s['rel_db']:+6.1f} dB  {s['verdict']}")
    if "--json" in a:
        json.dump(res, open(a[a.index("--json") + 1], "w"), indent=1)
    if "--page" in a:
        print("listening page:", page(res, a[2], a[a.index("--page") + 1]))


if __name__ == "__main__":
    main()
