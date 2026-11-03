#!/usr/bin/env python3
"""Find breaths, so they can be lowered without changing the timing.

Usage: breaths.py INPUT WORDS.json OUTPUT.json
Runs in .venv (numpy). Writes {"version": 4, "breaths": [[start, end], ...], "fragments": [...]}
in source seconds. Fragments are shorter breathy bits (from 40 ms); they are only lowered where they
touch a cut, because inside a clip they are usually part of a word, while at a cut they are the
leftover tail or start of a breath.

A breath is unvoiced, noise-like sound (high zero-crossing rate), quieter than speech and louder
than the room, whose energy sits low (mostly below 4 kHz). That last test separates it from
"s"/"s"/"f", which are just as noisy but put most of their energy above 4 kHz. "sh"/"ch" sit lower
(2-5 kHz) and pass that test, so every finished range is checked once more over its whole
length: 70%+ of its energy in 2-5 kHz is a "sh"/"ch"/"s" (inhales: 28-60%), 50%+ below 1 kHz
is voiced (inhales: 3-40%). Without it "Lower breaths" turned "shifting", "cheaper", "rich"
down by 15-22 dB. Whisper often
stretches a word over the inhale before or after it, so word boundaries are only used for the
speech/room levels, never to decide where a breath can be.
"""
import json
import subprocess
import sys

import numpy as np

SR, F = 16000, 0.02  # analysis rate, frame length (s)


def load_audio(path):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(SR),
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def band_share(audio, s, e, lo, hi):
    x = audio[int(s * SR): int(e * SR)]
    if len(x) < 32:
        return 0.0
    sp = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return float(sp[(f >= lo) & (f < hi)].sum() / (sp.sum() + 1e-12))


def is_breath(audio, s, e):
    return band_share(audio, s, e, 2000, 5000) <= 0.70 and band_share(audio, s, e, 0, 1000) <= 0.50


def detect(audio, words):
    if not words:
        return [], []
    hop = int(F * SR)
    frames = audio[: len(audio) // hop * hop].reshape(-1, hop)
    if len(frames) < 10:
        return [], []
    rms = 20 * np.log10(np.sqrt((frames ** 2).mean(1)) + 1e-9)
    zcr = (np.abs(np.diff(np.sign(frames), axis=1)) > 0).mean(1)
    spec = np.abs(np.fft.rfft(frames * np.hanning(hop), axis=1)) ** 2
    freqs = np.fft.rfftfreq(hop, 1 / SR)
    high = spec[:, freqs >= 4000].sum(1) / (spec.sum(1) + 1e-12)  # share of energy above 4 kHz
    inword = np.zeros(len(rms), bool)
    for w in words:
        inword[int(w["start"] / F): int(w["end"] / F) + 1] = True
    if inword.all() or not inword.any():
        return [], []
    floor, speech = np.percentile(rms[~inword], 10), np.median(rms[inword])
    breathy = (rms > floor + 10) & (rms < speech + 2) & (zcr > 0.15) & (high < 0.35)
    voiced = (zcr < 0.12) & (rms > speech - 12)

    out, frags, run, hole = [], [], [], 0
    for i in range(len(rms) + 1):
        if i < len(rms) and breathy[i]:
            run.append(i)
            hole = 0
            continue
        if run and i < len(rms) and hole == 0 and not voiced[i]:
            hole = 1  # tolerate one quiet frame inside a breath
            continue
        if run and 0.04 <= len(run) * F < 0.1:
            frags.append([round(run[0] * F, 3), round((run[-1] + 1) * F, 3)])
        if run and 0.1 <= len(run) * F <= 1.0:
            a, b = run[0], run[-1] + 1
            lo = a
            while lo > 0 and not voiced[lo - 1] and a - lo < 3:  # fade room, never into speech
                lo -= 1
            hi = b
            while hi < len(rms) and not voiced[hi] and hi - b < 3:
                hi += 1
            out.append([round(max(lo * F, a * F - 0.03), 3), round(min(hi * F, b * F + 0.03), 3)])
        run, hole = [], 0
    return ([r for r in out if is_breath(audio, *r)], [r for r in frags if is_breath(audio, *r)])


def main():
    src, words_path, out_path = sys.argv[1:4]
    words = json.load(open(words_path)).get("words", [])
    breaths, frags = detect(load_audio(src), words) if words else ([], [])
    json.dump({"version": 4, "breaths": breaths, "fragments": frags}, open(out_path, "w"))


if __name__ == "__main__":
    main()
