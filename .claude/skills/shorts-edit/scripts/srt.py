#!/usr/bin/env python3
"""Subtitles (.srt) for a project, from its own cut: word times mapped through the main track,
the project's word fixes applied, words a cut removed left out. For YouTube long-form, where
captions aren't burned in (upload the .srt instead), and for any export made with captions off.

Usage: srt.py PROJECT OUT.srt [--data DIR] [--chars 42] [--lines 2]
Cues: <= 42 characters a line, <= 2 lines, a new cue at a pause >= 0.6 s or after 5 s;
cues end 80 ms before the next one starts (players need the gap).
"""
import json
import os
import sys
from pathlib import Path


def main():
    a = sys.argv
    data = Path(a[a.index("--data") + 1]).expanduser() if "--data" in a else \
        Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "shorts-studio"
    maxc = int(a[a.index("--chars") + 1]) if "--chars" in a else 42
    maxl = int(a[a.index("--lines") + 1]) if "--lines" in a else 2
    pp = Path(a[1]) if Path(a[1]).exists() else data / "projects2" / f"{a[1]}.json"
    p = json.load(open(pp))
    main_t = next(t for t in p["tracks"] if t["kind"] == "main")["clips"]
    edits = p.get("wordEdits", {})
    cache, words = {}, []
    for c in main_t:
        if c["mid"] not in cache:
            f = data / "media" / c["mid"] / "words.json"
            cache[c["mid"]] = json.load(open(f))["words"] if f.exists() else []
        sp = c.get("speed") or 1
        for w in cache[c["mid"]]:
            m = (w["start"] + w["end"]) / 2
            if not (c["in"] <= m < c["out"]):
                continue
            text = edits.get(c["mid"], {}).get(str(w["id"]), {}).get("text", w["text"])
            if not str(text).strip():
                continue
            s = c["start"] + (max(w["start"], c["in"]) - c["in"]) / sp
            e = c["start"] + (min(w["end"], c["out"]) - c["in"]) / sp
            words.append((s, e, text))
    words.sort()
    cues, cur = [], []
    def flush():
        if cur:
            cues.append(cur[:])
            cur.clear()
    for w in words:
        if cur:
            text = join(x[2] for x in cur + [w])
            lines_needed = sum(1 for _ in wrap(text, maxc))
            if w[0] - cur[-1][1] >= 0.6 or w[1] - cur[0][0] > 5 or lines_needed > maxl:
                flush()
        cur.append(w)
        if cur[-1][2].rstrip().endswith((".", "?", "!")) and len(join(x[2] for x in cur)) > maxc * 0.6:
            flush()
    flush()
    out = []
    for i, c in enumerate(cues):
        s = c[0][0]
        e = c[-1][1] + 0.25
        if i + 1 < len(cues):
            e = min(e, cues[i + 1][0][0] - 0.08)
        out.append(f"{i + 1}\n{ts(s)} --> {ts(max(e, s + 0.5))}\n" + "\n".join(wrap(join(x[2] for x in c), maxc)) + "\n")
    Path(a[2]).write_text("\n".join(out))
    print(f"{len(cues)} cues, {len(words)} words -> {a[2]}")


def join(tokens):
    """Join word tokens; a token like ",000" or "%" attaches to the one before ("10 ,000" -> "10,000")."""
    out = ""
    for t in tokens:
        t = str(t)
        out = out + t if out and t[:1] in ",.%'" and not t.startswith("...") else (out + " " + t if out else t)
    return out


def wrap(text, n):
    lines, cur = [], ""
    for w in text.split():
        if cur and len(cur) + 1 + len(w) > n:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines


def ts(t):
    t = max(0.0, t)
    h, r = divmod(t, 3600)
    m, s = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}".replace(",1000", ",999")


if __name__ == "__main__":
    main()
