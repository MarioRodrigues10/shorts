#!/usr/bin/env python3
"""Breath map that doesn't mistake "sh"/"ch"/"s" for breaths.

Usage (run with the Shorts .venv python):
  breathmap.py MEDIA_DIR [--write] [--table]

Runs Shorts' own detector (breaths.py in the repo), then drops every detection that is
really a consonant: "sh", "ch", "s" put 80-92% of their energy between 2 and 5 kHz, a real
inhale 28-60%; voiced sounds put >50% below 1 kHz, an inhale 3-40% (measured on real
phone recordings, 2026-11). breaths.py only checks the share
above 4 kHz, so it lets "sh"/"ch" through, and "Lower breaths" then turns the start of
"shifting", "cheaper", "rich" down by 15-22 dB.

Since Shorts 0.3.0 breaths.py has the same filter (output version 4); this script adds the
--table view and writes the map for an edit copy.

--write saves the filtered map as MEDIA_DIR/breaths.json (version 4, same format). Shorts uses
that file for "Lower breaths" until words.json changes (re-transcribing recomputes it with the
unfiltered detector, so run this again after any transcription).
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))  # the repo: breaths.py
import breaths as B

SR = 16000
CONSONANT_SHARE = 0.70  # energy share in 2-5 kHz above which a "breath" is a sh/ch/s
VOICED_SHARE = 0.50     # energy share below 1 kHz above which it's a voiced sound (breaths: 0.03-0.40)


def band_share(audio, s, e, lo=2000, hi=5000):
    x = audio[int(s * SR): int(e * SR)]
    if len(x) < 32:
        return 0.0
    sp = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return float(sp[(f >= lo) & (f < hi)].sum() / (sp.sum() + 1e-12))


def detect(audio, words):
    """(breaths, fragments, rejected) in source seconds."""
    br, frags = B.detect(audio, words)
    keep_b, keep_f, rej = [], [], []
    for lst, out in ((br, keep_b), (frags, keep_f)):
        for s, e in lst:
            sh, lo = band_share(audio, s, e), band_share(audio, s, e, 0, 1000)
            if sh > CONSONANT_SHARE or lo > VOICED_SHARE:
                rej.append([s, e, round(sh, 2)])
            else:
                out.append([s, e])
    return keep_b, keep_f, rej


def main():
    md = Path(sys.argv[1])
    meta = json.load(open(md / "meta.json"))
    words = json.load(open(md / "words.json"))["words"]
    audio = B.load_audio(meta["path"])
    br, frags, rej = detect(audio, words)
    print(f"{len(br)} breaths ({sum(e - s for s, e in br):.1f}s), {len(frags)} fragments; "
          f"{len(rej)} consonants rejected (sh/ch/s)")
    if "--table" in sys.argv:
        for s, e, sh in rej:
            ctx = " ".join(w["text"] for w in words if s - 0.5 < w["start"] < e + 0.4)
            print(f"  rejected {s:7.2f}-{e:7.2f} 2-5k {sh:.2f}  …{ctx}…")
    if "--write" in sys.argv:
        tmp = md / "breaths.tmp.json"
        json.dump({"version": 4, "breaths": br, "fragments": frags, "filtered": "shorts-edit breathmap"}, open(tmp, "w"))
        tmp.replace(md / "breaths.json")
        print("wrote", md / "breaths.json")


if __name__ == "__main__":
    main()
