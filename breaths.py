#!/usr/bin/env python3
"""Find breaths, so they can be lowered without changing the timing.

Usage: breaths.py INPUT WORDS.json OUTPUT.json
Runs in .venv (numpy). Writes {"version": 2, "breaths": [[start, end], ...]} in source seconds.

A breath is unvoiced, noise-like sound (high zero-crossing rate), quieter than speech and louder
than the room, whose energy sits low (mostly below 4 kHz). That last test separates it from
"s"/"sh"/"f", which are just as noisy but put most of their energy above 4 kHz. Whisper often
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


def detect(audio, words):
    if not words:
        return []
    hop = int(F * SR)
    frames = audio[: len(audio) // hop * hop].reshape(-1, hop)
    if len(frames) < 10:
        return []
    rms = 20 * np.log10(np.sqrt((frames ** 2).mean(1)) + 1e-9)
    zcr = (np.abs(np.diff(np.sign(frames), axis=1)) > 0).mean(1)
    spec = np.abs(np.fft.rfft(frames * np.hanning(hop), axis=1)) ** 2
    freqs = np.fft.rfftfreq(hop, 1 / SR)
    high = spec[:, freqs >= 4000].sum(1) / (spec.sum(1) + 1e-12)  # share of energy above 4 kHz
    inword = np.zeros(len(rms), bool)
    for w in words:
        inword[int(w["start"] / F): int(w["end"] / F) + 1] = True
    if inword.all() or not inword.any():
        return []
    floor, speech = np.percentile(rms[~inword], 10), np.median(rms[inword])
    breathy = (rms > floor + 10) & (rms < speech + 2) & (zcr > 0.15) & (high < 0.35)
    voiced = (zcr < 0.12) & (rms > speech - 12)

    out, run, hole = [], [], 0
    for i in range(len(rms) + 1):
        if i < len(rms) and breathy[i]:
            run.append(i)
            hole = 0
            continue
        if run and i < len(rms) and hole == 0 and not voiced[i]:
            hole = 1  # tolerate one quiet frame inside a breath
            continue
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
    return out


def main():
    src, words_path, out_path = sys.argv[1:4]
    words = json.load(open(words_path)).get("words", [])
    breaths = detect(load_audio(src), words) if words else []
    json.dump({"version": 2, "breaths": breaths}, open(out_path, "w"))


if __name__ == "__main__":
    main()
