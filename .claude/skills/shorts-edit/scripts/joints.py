#!/usr/bin/env python3
"""Check every cut by ear (Phonon-2), and repair the ones that leak or clip a word.

Usage (run with the Shorts .venv python):
  joints.py MEDIA_DIR PLAN.json OUT_PLAN.json

For each joint between two clips that aren't contiguous in the source, renders the last ~1.2 s
of clip A + the first ~1.2 s of clip B, exactly as the edit will play it, and transcribes all
joints in one batch. A joint passes when the words heard across it are the last 2 words of A
followed by the first 2 words of B: nothing missing (clipped), nothing extra (a cut word
leaking in). Failing joints get candidate edges (local energy dips within 250 ms of the
current edge, both sides) and the batch runs again; the candidate that passes and moves the
edge least wins. Joints that still fail are listed: fix them by hand (or keep the word).
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import cutplan as C

PY = sys.executable  # the Shorts .venv python (has the transcriber)
TRANSCRIBE = str(Path(__file__).resolve().parents[4] / "transcribe.py")
CTX, GAP, SR = 1.2, 1.0, 16000
norm = lambda t: re.sub(r"[^a-z0-9']+", "", t.lower())


def transcribe_batch(audio, snippets):
    """snippets: list of [(a, b), (c, d)] source ranges -> list of heard word lists."""
    parts, offs, t = [], [], 0.0
    sil = np.zeros(int(GAP * SR), np.float32)
    for segs in snippets:
        offs.append(t)
        for a, b in segs:
            x = audio[int(a * SR): int(b * SR)].copy()
            n = min(len(x), int(0.005 * SR))  # 5 ms ramps, like the render's cut
            if n:
                x[:n] *= np.linspace(0, 1, n)
                x[-n:] *= np.linspace(1, 0, n)
            parts.append(x)
            t += len(x) / SR
        parts.append(sil)
        t += GAP
    with tempfile.TemporaryDirectory() as d:
        wav, out = Path(d) / "j.wav", Path(d) / "j.json"
        pcm = (np.concatenate(parts) * 32767).astype(np.int16).tobytes()
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-", str(wav)],
                       input=pcm, check=True)
        subprocess.run(["nice", "-n", "10", PY, TRANSCRIBE, str(wav), str(out), "--threads", "4"], check=True,
                       capture_output=True)
        words = [w for s in json.load(open(out))["segments"] for w in (s.get("words") or [])]
    heard = [[] for _ in snippets]
    for w in words:
        mid = (w["start"] + w["end"]) / 2
        k = max(i for i, o in enumerate(offs) if o <= mid + 0.05)
        heard[k].append(norm(w["word"]))
    return [[h for h in hs if h] for hs in heard]


def ok(heard, want):
    """The 2 words before the cut + the 2 after must be heard back to back. Compared as letters,
    not tokens: Phonon-2 merges/splits words ("alright" / "all right")."""
    return "".join(want) in "".join(heard)


def candidates(F, t, span=0.25):
    rms, a, b = F["rms"], max(1, C.t2i(t - span)), min(F["n"] - 2, C.t2i(t + span))
    mins = [i for i in range(a, b) if rms[i] <= rms[i - 1] and rms[i] <= rms[i + 1]]
    mins.sort(key=lambda i: rms[i])
    return sorted({round(i * C.HOP, 3) for i in mins[:5]} | {round(t, 3)}, key=lambda x: abs(x - t))


def main():
    media, plan_in, plan_out = sys.argv[1:4]
    meta = json.load(open(Path(media) / "meta.json"))
    plan = json.load(open(plan_in))
    clips = plan["clips"]
    audio = C.load(meta["path"])
    F = C.features(audio)
    joints = [i for i in range(len(clips) - 1) if abs(clips[i + 1]["in"] - clips[i]["out"]) > 0.02]

    def want(i):
        a, b = clips[i]["text"].split(), clips[i + 1]["text"].split()
        return [norm(x) for x in a[-2:] + b[:2] if norm(x)]

    def snip(i, e, s):
        return [(max(clips[i]["in"], e - CTX), e), (s, min(clips[i + 1]["out"], s + CTX))]

    heard = transcribe_batch(audio, [snip(i, clips[i]["out"], clips[i + 1]["in"]) for i in joints])
    bad = [(i, h) for i, h in zip(joints, heard) if not ok(h, want(i))]
    print(f"{len(joints)} joints checked, {len(bad)} failing")
    fixed, still = [], []
    if bad:
        trials = []
        for i, h in bad:
            print(f"  joint {i}: want '{' '.join(want(i))}' heard '{' '.join(h)}'")
            ce = [e for e in candidates(F, clips[i]["out"]) if e > clips[i]["in"] + 0.3]
            cs = [s for s in candidates(F, clips[i + 1]["in"]) if s < clips[i + 1]["out"] - 0.3]
            for e in ce:
                for s in cs:
                    trials.append((i, e, s))
        res = transcribe_batch(audio, [snip(i, e, s) for i, e, s in trials])
        for i, _ in bad:
            good = [(abs(e - clips[i]["out"]) + abs(s - clips[i + 1]["in"]), e, s)
                    for (j, e, s), h in zip(trials, res) if j == i and ok(h, want(i))]
            if good:
                _, e, s = min(good)
                fixed.append({"joint": i, "out": [clips[i]["out"], e], "in": [clips[i + 1]["in"], s]})
                clips[i]["out"], clips[i + 1]["in"] = e, s
            else:
                still.append({"joint": i, "want": " ".join(want(i)), "at": [clips[i]["out"], clips[i + 1]["in"]]})
    plan["joints"] = {"checked": len(joints), "fixed": fixed, "failing": still}
    json.dump(plan, open(plan_out, "w"), indent=1)
    for f in fixed:
        print("  fixed", f)
    for s in still:
        print("  STILL FAILING (fix by hand or keep the word):", s)


if __name__ == "__main__":
    main()
