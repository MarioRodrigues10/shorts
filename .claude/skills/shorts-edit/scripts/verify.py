#!/usr/bin/env python3
"""Check an exported short the way a viewer hears and sees it.

Usage (run with the Shorts .venv python):
  verify.py EXPORT.mp4 EXPECTED.txt OUTDIR [--compare OTHER.mp4]

1. Re-transcribes the export and aligns it to EXPECTED.txt (the script you meant to keep).
   Words missing from the export = a cut clipped a word (or the word is too quiet).
   Extra words = a cut let a neighbouring word leak in. Phonon-2 sometimes merges a short
   unstressed word ("in", "a") into its neighbour: check those on the waveform before
   "fixing" them (energy is not speech: an inhale is loud too).
2. Runs Shorts' breath detector on the export's own audio and lists every breath a viewer
   will hear (inside "Lower breaths" dips they're 24 dB down: those are flagged "dipped?").
3. Loudness (integrated LUFS, true peak) and a contact sheet (1 frame / 4 s).
With --compare, prints the same numbers for another export side by side.
"""
import difflib
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

HOME = Path.home()
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO))
import breaths as B
sys.path.insert(0, str(Path(__file__).parent))
import breathmap as BM

PY = sys.executable
norm = lambda t: re.sub(r"[^a-z0-9']+", "", t.lower())


def transcribe(path, out):
    if not Path(out).exists():
        subprocess.run(["nice", "-n", "10", PY, str(REPO / "transcribe.py"), str(path), str(out),
                        "--threads", "4"], check=True, capture_output=True)
    d = json.load(open(out))
    return [{"text": w["word"].strip(), "start": w["start"], "end": w["end"]}
            for s in d["segments"] for w in (s.get("words") or [])]


def loudness(path):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    i = re.findall(r"I:\s+(-?[\d.]+) LUFS", r)
    p = re.findall(r"Peak:\s+(-?[\d.]+) dBFS", r)
    return (float(i[-1]) if i else None), (float(p[-1]) if p else None)


def audible_breaths(path, words):
    audio = B.load_audio(str(path))
    br, _, _ = BM.detect(audio, [{"start": w["start"], "end": w["end"]} for w in words])
    # a dipped breath (-24 dB) is far below speech: measure each one's level against speech
    F = 0.02
    hop = int(F * B.SR)
    fr = audio[: len(audio) // hop * hop].reshape(-1, hop)
    rms = 20 * np.log10(np.sqrt((fr ** 2).mean(1)) + 1e-9)
    inword = np.zeros(len(rms), bool)
    for w in words:
        inword[int(w["start"] / F): int(w["end"] / F) + 1] = True
    speech = float(np.median(rms[inword])) if inword.any() else -20
    out = []
    for s, e in br:
        lvl = float(rms[int(s / F): max(int(s / F) + 1, int(e / F))].max())
        out.append({"at": round(s, 2), "dur": round(e - s, 2), "db_below_speech": round(speech - lvl, 1)})
    return out


def stats(path, outdir, tag):
    words = transcribe(path, outdir / f"{tag}_words.json")
    dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                               capture_output=True, text=True).stdout)
    lufs, peak = loudness(path)
    brs = audible_breaths(path, words)
    loud = [b for b in brs if b["db_below_speech"] < 15]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-vf", "fps=1/4,scale=216:-1,tile=10x3",
                    "-frames:v", "1", str(outdir / f"{tag}_sheet.jpg")])
    return {"duration": round(dur, 2), "words": len(words), "wpm": round(len(words) / dur * 60),
            "lufs": lufs, "true_peak": peak, "breaths_detected": len(brs), "breaths_loud": len(loud),
            "loud_breath_seconds": round(sum(b["dur"] for b in loud), 2), "loud_breaths": loud,
            "_words": words}


def main():
    path, expected, outdir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    outdir.mkdir(parents=True, exist_ok=True)
    st = stats(path, outdir, "export")
    want = [norm(t) for t in expected.read_text().split() if norm(t)]
    got = [norm(w["text"]) for w in st["_words"] if norm(w["text"])]
    sm = difflib.SequenceMatcher(None, want, got, autojunk=False)
    issues = []
    for op, a0, a1, b0, b1 in sm.get_opcodes():
        if op == "equal":
            continue
        at = st["_words"][min(b0, len(st["_words"]) - 1)]["start"] if st["_words"] else 0
        issues.append({"at": round(at, 2), "op": op, "expected": " ".join(want[a0:a1]), "heard": " ".join(got[b0:b1]),
                       "context": " ".join(want[max(0, a0 - 3):a1 + 3])})
    st.pop("_words")
    print(json.dumps({k: v for k, v in st.items() if k != "loud_breaths"}, indent=1))
    print(f"\nword match {sm.ratio():.1%}; differences ({len(issues)}):")
    for i in issues:
        print(f"  {i['at']:7.2f}s {i['op']:8s} expected '{i['expected']}' heard '{i['heard']}'   …{i['context']}…")
    print("\nloud breaths (less than 15 dB under speech):")
    for b in st["loud_breaths"]:
        print("  ", b)
    if "--compare" in sys.argv:
        other = stats(Path(sys.argv[sys.argv.index("--compare") + 1]), outdir, "other")
        other.pop("_words")
        print("\ncompare:")
        for k in ["duration", "wpm", "lufs", "true_peak", "breaths_detected", "breaths_loud", "loud_breath_seconds"]:
            print(f"  {k:20s} this {st[k]!s:>8}   other {other[k]!s:>8}")
    json.dump({"export": st, "issues": issues}, open(outdir / "verify.json", "w"), indent=1)


if __name__ == "__main__":
    main()
