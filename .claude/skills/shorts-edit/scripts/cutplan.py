#!/usr/bin/env python3
"""Breath-aware cut planner for Shorts (talking-head, one voice).

Turns "keep these words" into main-track clips whose edges sit on the real sound, not on
Phonon-2's word times (it stretches words over the inhale before/after them and times words
in 80 ms steps).

Usage (run with the Shorts .venv python):
  cutplan.py MEDIA_DIR KEEP.json OUT.json [--report]

MEDIA_DIR  <data>/shorts-studio/media/<mid> (data: ~/.local/share, or $XDG_DATA_HOME)  (needs meta.json + words.json)
KEEP.json  {"sentences": [{"tag": "hook", "keep": [[first_word_id, last_word_id], ...]}, ...]}
           word ids = the "id" field in words.json. [a, b] keeps every word a..b inclusive.
           Each [a, b] range is a "take": its edges are cuts, its inside only splits at pauses.
OUT.json   {"clips": [{"tag","in","out","text"}], "report": [...], "breaths_kept": [...]}

Edge rules (why: see SKILL.md):
  END    last voiced frame of the last word (hysteresis voicing) + a word-final fricative
         (<=180 ms), + 80 ms of air before a pause; stopped 70 ms into the next breath (that
         sliver, dipped by "Lower breaths", is the pause: removing breaths completely made
         words collide, the ears' "no breathing room"), and never less than 80 ms after voicing (protects "ch", "st", releases; a breath sliver is dipped by
         "Lower breaths", a clipped consonant can't be fixed).
  START  70 ms before voicing onset (p/t/k aspiration is ~70 ms and looks like breath), back
         through a word-initial fricative (<=150 ms); after the previous breath ends, but never
         less than 50 ms before voicing.
  CONNECTED SPEECH  when the neighbouring word is cut and there's no pause between them
         ("and [basically] get"), the edge goes to the quietest 10 ms within 100 ms of
         Phonon-2's boundary: voicing runs straight through, so it can't find the edge.
  SPLITS a kept take is split where the pause between words is > 0.30 s, or holds a breath of
         100 ms+ in a pause > 0.18 s; never when a piece would be shorter than 0.7 s (that
         pause is usually emphasis: keep it, its breath gets dipped).
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import breathmap as BM  # Shorts' detector minus sh/ch/s (write it with breathmap.py --write so Shorts dips the same ranges)

SR, HOP = 16000, 0.01
MAX_PAUSE = 0.30
BREATH_SPLIT = (0.10, 0.18)   # (min breath length, min pause) cut out instead of dipped
MIN_PIECE = 0.70              # shorter pieces = over-cut, choppy
AIR_END, AIR_START = 0.08, 0.07
PROTECT_END, PROTECT_START = 0.08, 0.05
BREATH_AIR = 0.07            # breath kept each side of a breath cut: dipped to near-silence it is the pause
FRIC_END, FRIC_START = 0.18, 0.15
MIN_VOICED = 4                # frames: 40 ms


def load(path):
    raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", str(SR),
                          "-f", "s16le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float32) / 32768


def features(a):
    hop, win = int(HOP * SR), int(0.04 * SR)
    n = (len(a) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    raw = a[idx]
    fr = raw * np.hanning(win)
    rms = 20 * np.log10(np.sqrt((raw[:, win // 2 - hop: win // 2 + hop] ** 2).mean(1)) + 1e-9)
    zcr = (np.abs(np.diff(np.sign(raw), axis=1)) > 0).mean(1)
    spec = np.abs(np.fft.rfft(fr, axis=1)) ** 2
    f = np.fft.rfftfreq(win, 1 / SR)
    high = spec[:, f >= 4000].sum(1) / (spec.sum(1) + 1e-12)
    ac = np.fft.irfft(np.abs(np.fft.rfft(fr, 2 * win, axis=1)) ** 2, axis=1)[:, :win]
    ac /= ac[:, :1] + 1e-12
    peak = ac[:, SR // 400: SR // 70].max(1)
    floor = np.percentile(rms, 8)
    strict = (peak > 0.45) & (rms > floor + 14) & (zcr < 0.25)
    loose = (peak > 0.30) & (rms > floor + 6) & (zcr < 0.30)
    # hysteresis: strict frames seed a run, loose frames extend it (soft word endings: "people")
    voiced = strict.copy()
    for i in range(1, n):
        if not voiced[i] and voiced[i - 1] and loose[i]:
            voiced[i] = True
    for i in range(n - 2, -1, -1):
        if not voiced[i] and voiced[i + 1] and loose[i]:
            voiced[i] = True
    runs, i = [], 0
    while i < n:
        if voiced[i]:
            j = i
            while j < n and voiced[j]:
                j += 1
            if j - i >= MIN_VOICED:
                runs.append((i, j))
            i = j
        else:
            i += 1
    fric = (high > 0.35) & (zcr > 0.2) & (rms > floor + 8)
    return dict(rms=rms, runs=runs, fric=fric, floor=floor, n=n)


def t2i(t):
    return int(round(t / HOP))


def speech_runs(F, br):
    """Voiced runs that are speech: drop runs mostly inside a breath (an inhale often ends in a
    few pitched frames) and split runs at every breath (hysteresis can bridge an inhale)."""
    out = []
    for a, b in F["runs"]:
        if any(min(b * HOP, e) - max(a * HOP, s) > 0.5 * (b - a) * HOP for s, e in br):
            continue
        lo = a
        for cs, ce in sorted((t2i(s), t2i(e)) for s, e in br if t2i(s) < b and t2i(e) > a):
            if cs - lo >= MIN_VOICED:
                out.append((lo, cs))
            lo = max(lo, ce)
        if b - lo >= MIN_VOICED:
            out.append((lo, b))
    return out


def plan(media_dir, keep):
    media_dir = Path(media_dir)
    meta = json.load(open(media_dir / "meta.json"))
    words = json.load(open(media_dir / "words.json"))["words"]
    audio = load(meta["path"])
    F = features(audio)
    br, frags, _ = BM.detect(audio, words)
    pos = {w["id"]: i for i, w in enumerate(words)}
    RMS, FR, N = F["rms"], F["fric"], F["n"]

    RUNS = speech_runs(F, br)

    def onset(w, lo_t=0.0):
        lo = max(t2i(lo_t), t2i(w["start"] - 0.15))
        for a, b in RUNS:
            if a < t2i(w["end"]) - 3 and b > t2i(w["start"]) + 3:
                return max(a, lo) * HOP
        return w["start"]

    def offset(w):
        last = None
        for a, b in RUNS:
            if a < t2i(w["end"]) - 3 and b > t2i(w["start"]) + 3:
                last = b
        return last * HOP if last is not None else min(w["end"], w["start"] + 0.12)

    def dip(t, span=0.10):
        """Quietest 10 ms frame within span of t (the joint between two connected words)."""
        a, b = max(0, t2i(t - span)), min(N, t2i(t + span) + 1)
        return (a + int(np.argmin(RMS[a:b]))) * HOP

    def connected(w1, w2):  # no audible pause between two neighbouring words
        return onset(w2) - offset(w1) < 0.06

    def end_edge(w, nxt):
        t = offset(w)
        j = t2i(t)
        while j < N and FR[j] and (j - t2i(t) + 1) * HOP <= FRIC_END:
            j += 1
        fric = j > t2i(t)
        e = max(j * HOP, t) + AIR_END
        why = ["fricative tail" if fric else "voicing end"]
        for b0, b1 in br + frags:
            if b1 > t + 0.01 and b0 < e:
                e = max(t + PROTECT_END, min(b0 + BREATH_AIR, b1))
                why.append("breath")
        if nxt is not None:
            if connected(w, nxt):
                e = dip(nxt["start"]) + 0.005
                why = ["connected speech: energy dip"]
            else:
                e = min(e, onset(nxt) - 0.03)
        return e, ", ".join(why)

    def start_edge(w, prv, floor_t):
        t = onset(w, floor_t)
        j = t2i(t)
        while j > 0 and FR[j - 1] and (t2i(t) - j + 1) * HOP <= FRIC_START:
            j -= 1
        s = min(j * HOP - 0.02, t - AIR_START) if j < t2i(t) else t - AIR_START
        why = ["fricative onset" if j < t2i(t) else "voicing onset"]
        for b0, b1 in br + frags:
            if b0 < t - 0.01 and b1 > s:
                s = min(max(b1 - BREATH_AIR, b0), t - PROTECT_START)
                why.append("breath")
        if prv is not None and connected(prv, w):
            s = dip(w["start"]) - 0.005
            why = ["connected speech: energy dip"]
        return max(s, floor_t), ", ".join(why)

    clips, report = [], []
    for sent in keep["sentences"]:
        for a_id, b_id in sent["keep"]:
            ia, ib = pos[a_id], pos[b_id]
            seg = words[ia: ib + 1]
            pieces = [[seg[0]]]
            for p, q in zip(seg, seg[1:]):
                pe, qs = offset(p), onset(q)
                gap = qs - pe
                b = next(((s, e) for s, e in br if e > pe and s < qs), None)
                if gap > MAX_PAUSE or (b and b[1] - b[0] >= BREATH_SPLIT[0] and gap > BREATH_SPLIT[1]):
                    pieces.append([q])
                    report.append({"tag": sent["tag"], "split": f'{p["text"]} | {q["text"]}', "gap": round(gap, 2),
                                   "breath": bool(b)})
                else:
                    pieces[-1].append(q)
            # merge pieces that would be too short (keep that pause; its breath gets dipped)
            span = lambda pc: offset(pc[-1]) - onset(pc[0])
            merged = True
            while merged and len(pieces) > 1:
                merged = False
                for k, pc in enumerate(pieces):
                    if span(pc) < MIN_PIECE:
                        if k == 0:
                            nb = 1
                        elif k == len(pieces) - 1:
                            nb = k - 1
                        else:  # join the side with the smaller pause
                            gl = onset(pc[0]) - offset(pieces[k - 1][-1])
                            gr = onset(pieces[k + 1][0]) - offset(pc[-1])
                            nb = k - 1 if gl <= gr else k + 1
                        lo, hi = min(k, nb), max(k, nb)
                        pieces[lo:hi + 1] = [pieces[lo] + pieces[hi]]
                        report.append({"tag": sent["tag"], "merged": " ".join(w["text"] for w in pc),
                                       "why": f"piece {span(pc):.2f}s < {MIN_PIECE}s"})
                        merged = True
                        break
            for pc in pieces:
                first, last = pc[0], pc[-1]
                fi, li = pos[first["id"]], pos[last["id"]]
                prv = words[fi - 1] if fi > 0 else None
                nxt = words[li + 1] if li + 1 < len(words) else None
                prev_clip = clips[-1] if clips else None
                floor_t = prev_clip["out"] if prev_clip and prev_clip["in"] < first["start"] < prev_clip["out"] + 0.5 else 0
                s, why_s = start_edge(first, prv, floor_t)
                e, why_e = end_edge(last, nxt)
                clips.append({"tag": sent["tag"], "in": round(s, 3), "out": round(e, 3),
                              "text": " ".join(w["text"] for w in pc), "ids": [w["id"] for w in pc]})
                report.append({"tag": sent["tag"], "clip": f'{first["text"]} … {last["text"]}', "in": round(s, 3),
                               "out": round(e, 3), "start": why_s, "end": why_e})
    kept = []
    for s, e in br:
        for c in clips:
            ov = min(e, c["out"]) - max(s, c["in"])
            if ov > 0.03:
                kept.append({"breath": [s, e], "kept": round(ov, 2), "clip": c["text"][:40]})
    durs = sorted(c["out"] - c["in"] for c in clips)
    return {"clips": clips, "report": report, "breaths_kept": kept, "breaths_total": len(br),
            "median_clip": round(durs[len(durs) // 2], 2) if durs else 0}


def retime(media_dir):
    """words.json with every word's start/end moved onto its voicing (same ids, same text).
    Phonon-2 ends often run over the following inhale; Shorts shows a caption word only when the
    middle of its time range is inside a clip, so a cut that (correctly) drops the inhale also
    dropped sentence-final words ("fast.", "win.", "product,") from the captions."""
    media_dir = Path(media_dir)
    meta = json.load(open(media_dir / "meta.json"))
    words = json.load(open(media_dir / "words.json"))
    ws = words["words"]
    audio = load(meta["path"])
    F = features(audio)
    br, _, _ = BM.detect(audio, ws)
    runs = speech_runs(F, br)
    FR = F["fric"]
    out, prev_end = [], 0.0
    for i, w in enumerate(ws):
        a0, a1 = t2i(w["start"]), t2i(w["end"])
        ov = [r for r in runs if r[0] < a1 - 3 and r[1] > a0 + 3]
        s, e = w["start"], w["end"]
        if ov:
            on, off = max(ov[0][0], t2i(w["start"] - 0.15)), ov[-1][1]
            j = on
            while j > 0 and FR[j - 1] and on - j < 15:   # word-initial fricative
                j -= 1
            k = off
            while k < F["n"] and FR[k] and k - off < 18:  # word-final fricative
                k += 1
            s, e = j * HOP - 0.02, min(w["end"], k * HOP + 0.02)
        nxt = ws[i + 1]["start"] if i + 1 < len(ws) else e
        s = max(s, prev_end)
        e = max(min(e, max(nxt, s + 0.05)), s + 0.05)
        out.append(dict(w, start=round(s, 3), end=round(e, 3)))
        prev_end = e
    words["words"] = out
    words["retimed"] = "shorts-edit cutplan.retime"
    return words


if __name__ == "__main__":
    out = plan(sys.argv[1], json.load(open(sys.argv[2])))
    json.dump(out, open(sys.argv[3], "w"), indent=1)
    if "--report" in sys.argv:
        for r in out["report"]:
            print(r)
    k = out["breaths_kept"]
    short = [c["text"] for c in out["clips"] if c["out"] - c["in"] < MIN_PIECE]
    print(f'{len(out["clips"])} clips, {sum(c["out"] - c["in"] for c in out["clips"]):.2f}s, median clip '
          f'{out["median_clip"]}s; {len(k)}/{out["breaths_total"]} breaths inside clips '
          f'({sum(x["kept"] for x in k):.2f}s, dipped -24 dB by audio.breaths); short clips: {short}')
    for x in k:
        print("  ", x)
