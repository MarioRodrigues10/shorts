#!/usr/bin/env python3
"""Word-level transcription for Shorts.

faster-whisper for the words, then word boundaries are snapped to the audio
energy so silence removal cuts tightly (Whisper's own word ends tend to bleed
into the following pause).

Usage: transcribe.py INPUT OUTPUT.json [--model small.en] [--lang en]
                     [--prompt TEXT] [--threads 4]
Prints JSON progress lines on stdout: {"progress": 0.42} / {"status": "..."}.
"""
import argparse
import json
import subprocess
import sys
import time

import numpy as np

SR = 16000
HOP = 160  # 10 ms energy frames


def say(**kw):
    print(json.dumps(kw), flush=True)


def load_audio(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(SR),
         "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def energy_db(audio):
    n = len(audio) // HOP
    frames = audio[: n * HOP].reshape(n, HOP)
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms + 1e-9)
    # light smoothing (30 ms) so plosive gaps inside words don't count as silence
    return np.convolve(db, np.ones(3) / 3, mode="same")


def refine(words, db):
    """Snap word starts/ends to where speech energy actually begins/ends."""
    if not len(db) or not words:
        return words
    floor = np.percentile(db, 10)
    loud = np.percentile(db, 95)
    voiced = db > floor + 0.25 * (loud - floor)
    n = len(db)
    f = lambda t: max(0, min(n, int(round(t * 100))))
    raw = [(f(w["start"]), f(w["end"])) for w in words]
    prev_end = 0
    for i, w in enumerate(words):
        s, e = raw[i]
        nxt = raw[i + 1][0] if i + 1 < len(words) else n
        lo = max(prev_end, s - 10)
        if e - s < 5:  # Whisper sometimes gives (near) zero-length words: look a bit further
            e = min(max(nxt, s + 5), s + 30)
        hi = max(e, lo + 1)
        idx = np.nonzero(voiced[lo:hi])[0]
        if len(idx):
            ns = lo + idx[0]
            ns = max(lo, min(ns - 2, s + 40))  # pull a late start in by at most 400 ms
            ne = max(lo + idx[-1] + 1, e - 40)  # trim a trailing pause by at most 400 ms
        else:
            ns, ne = max(lo, s), e
        # Trailing sounds (s, t, breathy endings) that run past Whisper's end: extend up to 150 ms.
        k = ne
        while k < min(n, ne + 15, max(nxt, ne)) and voiced[k]:
            k += 1
        ne = max(k, ns + 6)  # at least 60 ms
        w["start"], w["end"] = round(ns / 100, 3), round(ne / 100, 3)
        prev_end = ne
    for a, b in zip(words, words[1:]):
        if b["start"] < a["end"]:
            mid = round((a["end"] + b["start"]) / 2, 3)
            a["end"], b["start"] = mid, max(mid, b["start"])
        if b["end"] <= b["start"]:
            b["end"] = round(b["start"] + 0.06, 3)
    return words


def load_model(name, threads):
    # CPU only on purpose: the 2 GB laptop GPU runs out of memory (and can hang the
    # desktop) when Whisper shares it with Resolve / the display.
    from faster_whisper import WhisperModel
    return WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads)


def parse_ranges(spec, dur):
    if not spec:
        return [(0.0, dur)]
    out = []
    for part in spec.split(","):
        x, y = part.split("-")
        x, y = max(0.0, float(x)), min(dur, float(y))
        if y - x > 0.2:
            out.append((x, y))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--prompt", default=None)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--ranges", default=None, help="only these source ranges: 'a-b,c-d' (seconds)")
    a = ap.parse_args()

    t0 = time.time()
    say(status="reading audio")
    audio = load_audio(a.input)
    dur = len(audio) / SR
    ranges = parse_ranges(a.ranges, dur)
    if not ranges:
        json.dump({"engine": "none", "segments": [], "ranges": []}, open(a.output, "w"))
        return
    say(status=f"loading {a.model}")
    model = load_model(a.model, a.threads)
    say(status=f"transcribing ({a.model})")
    total = sum(y - x for x, y in ranges)
    done = 0.0
    out_segs, all_words, lang = [], [], a.lang
    for x, y in ranges:
        chunk = audio[int(x * SR): int(y * SR)]
        segs, info = model.transcribe(
            chunk, language=a.lang or None, word_timestamps=True, beam_size=5,
            vad_filter=True, vad_parameters={"min_silence_duration_ms": 400, "speech_pad_ms": 200},
            condition_on_previous_text=False,  # keeps retakes/repeats instead of "cleaning" them
            initial_prompt=a.prompt or None, temperature=[0.0, 0.2, 0.4],
        )
        lang = info.language
        for seg in segs:
            ws = [{"word": w.word, "start": float(w.start) + x, "end": float(w.end) + x, "probability": float(w.probability)}
                  for w in (seg.words or []) if w.word.strip()]
            if ws:
                out_segs.append({"start": float(seg.start) + x, "end": float(seg.end) + x, "text": seg.text, "words": ws})
                all_words.extend(ws)
            say(progress=round(min(0.99, (done + seg.end) / total), 3))
        done += y - x
    refine(all_words, energy_db(audio))
    for sg in out_segs:
        sg["start"], sg["end"] = sg["words"][0]["start"], sg["words"][-1]["end"]
    json.dump({"engine": f"faster-whisper/{a.model}/cpu", "language": lang, "ranges": ranges,
               "processing_time_sec": round(time.time() - t0, 1), "segments": out_segs},
              open(a.output, "w"))
    say(progress=1.0, status="done")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        sys.exit("could not read audio: " + (e.stderr or b"").decode()[-300:])
