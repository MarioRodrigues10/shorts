#!/usr/bin/env python3
"""Find breaths between words, so they can be lowered without changing the timing.

Usage: breaths.py INPUT WORDS.json OUTPUT.json
Runs in .venv (numpy). Writes {"version": 1, "breaths": [[start, end], ...]} in source seconds.

A breath is a run of noise-like sound (high zero-crossing rate, quieter than speech, louder
than the room) that starts in a gap between two words. Whisper often starts the next word
early, over the inhale, so the run may continue up to 0.25 s into that word but always stops
at the first voiced (tonal) frame, where speech really begins.
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


def detect(audio, words):
    if len(words) < 2:
        return []
    hop = int(F * SR)
    frames = audio[: len(audio) // hop * hop].reshape(-1, hop)
    if not len(frames):
        return []
    rms = 20 * np.log10(np.sqrt((frames ** 2).mean(1)) + 1e-9)
    zcr = (np.abs(np.diff(np.sign(frames), axis=1)) > 0).mean(1)
    inword = np.zeros(len(rms), bool)
    for w in words:
        inword[int(w["start"] / F): int(w["end"] / F) + 1] = True
    if inword.all() or not inword.any():
        return []
    floor, speech = np.percentile(rms[~inword], 10), np.median(rms[inword])
    noisy = (rms > floor + 10) & (zcr > 0.15) & (rms < speech + 2)
    voiced = (zcr < 0.12) & (rms > speech - 12)

    out = []
    gaps = [(0.0, words[0]["start"])] + [(a["end"], b["start"]) for a, b in zip(words, words[1:])]
    for g0, g1 in gaps:
        if not 0.12 <= g1 - g0 <= 1.5:  # longer gaps are often untranscribed speech or laughter
            continue
        i0, iw = int((g0 + 0.02) / F), int(g1 / F)
        i_end = min(len(rms), int((g1 + 0.25) / F))
        stop = next((i for i in range(iw, i_end) if voiced[i]), i_end)
        run, best, hole = [], [], 0
        for i in range(i0, min(stop, len(rms))):
            if noisy[i]:
                run.append(i)
                hole = 0
            elif run and hole == 0:
                hole = 1  # tolerate one quiet frame inside a breath
            elif run:
                best = run if len(run) > len(best) else best
                run, hole = [], 0
        best = run if len(run) > len(best) else best
        if len(best) * F >= 0.1 and best[0] < iw:
            b0 = max(g0 + 0.01, best[0] * F - 0.03)
            b1 = min(stop * F - 0.01, (best[-1] + 1) * F + 0.03)
            if b1 - b0 >= 0.08:
                out.append([round(b0, 3), round(b1, 3)])
    return out


def main():
    src, words_path, out_path = sys.argv[1:4]
    words = json.load(open(words_path)).get("words", [])
    breaths = detect(load_audio(src), words) if words else []
    json.dump({"version": 1, "breaths": breaths}, open(out_path, "w"))


if __name__ == "__main__":
    main()
