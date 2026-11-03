---
name: shorts-edit
description: Edit a talking-head recording into a finished short (Reels, TikTok, YouTube Shorts) with the Shorts editor in this repo, end to end, verified. Breath-aware cuts that never clip a word, context-preserving script edits, a hook, clean captions, full-colour sticker logos with real animation, then every cut checked by ear (re-transcription + listen.py). Use when the user asks to edit, cut, tighten, clean up breaths in, caption, or "make a reel / short from" a video, or to compare two edits.
---

# Edit a short with Shorts

The user records a one-take talking-head video; you turn it into a post-ready short in their
Shorts app and prove it's clean. Pipeline: script edit -> breath-aware cut plan -> ear check of
every joint -> build the project (the polish) -> export -> verify + listen -> report.

Scripts are in `scripts/` next to this file. Run the Python ones with the Shorts venv:
`.venv/bin/python` from the repo root (`.venv\Scripts\python.exe` on Windows); it has numpy
and the transcriber. `references/style.md` has the sources behind every style number.

**First, read `~/.config/shorts-studio/edit-notes.md` if it exists**: the user's own channel,
brand assets, voice quirks and taste. It overrides the defaults below. When the user tells you
a preference worth keeping, offer to add it there.

## Hard rules

1. **Never test on the user's running app (:7377).** Build and export on a throwaway instance:
   `scripts/instance.sh start <media_id>` (port 7378, data in `~/.cache/shorts-edit-instance`;
   `instance.sh stop` deletes it, ~1 GB). Keep its data on a real disk, not a small tmpfs: the
   lossless render cache overflows it.
2. **One heavy job at a time.** `export.py` waits for any running ffmpeg; transcription runs
   `nice`d. Never kill processes with `pkill -f <pattern>` (it can match your own shell).
3. **Never overwrite the user's files.** Their project, media entry and exports stay as they
   are. Your export is a new file; your project is a new project.
4. **Context beats tightness** (see Script edit). Content cuts need the user's OK.

## 1. Script edit (what to keep)

Words: `<data>/shorts-studio/media/<mid>/words.json` (`<data>` = `~/.local/share` or
`$XDG_DATA_HOME`; word `id` = start in ms). If there's no transcript yet, ask the user to click
*Auto captions* (Phonon-2 for English) or run `transcribe.py`. Print the words with times and
read the whole take first.

**Cut without asking**: fillers ("uh", "um"; "basically"/"like"/"so" when padding), stutters
and false starts, retakes (keep the better take, usually the last), exact repeats, sign-offs
that aren't a call to action ("So yeah, that's it. Thank you.").

**Never cut without asking** (list them with the exact words and why):
- a clause that explains *why* ("since code is cheaper *to get features in front of users*")
- the lead-in that names who a sentence is about ("So if you're a content creator, ...")
- a whole sentence, emphasis lines ("That is the main thing."), dramatic pauses
- Read the kept script as prose: every sentence must make sense given only what came before.

**Hook**: the first 1-3 s decide the view (TikTok: proposition in 3 s, hook within 6 s). Offer
a cold open: the strongest single line (a number, a bold claim) moved to the front, with a short
card (<= 6 words, 2 lines); it still plays again in its place. Ask; it's editorial.

Write `keep.json`: `{"sentences": [{"tag": "hook", "keep": [[first_id, last_id], ...]}, ...]}`,
one entry per sentence, several ranges when words inside it go. Tags name the beats; cards and
stickers anchor to them.

## 2. Breath-aware cut plan

Work on an **edit copy** (`make_edit_media` in `shortslib.py`): the video hardlinked (no extra
disk), proxies copied, word times retimed onto the voicing, a breath map that ignores "sh"/"ch"/
"s". The user's own media entry is untouched. Then:

```
PY=.venv/bin/python; SK=.claude/skills/shorts-edit/scripts; M=<data>/shorts-studio/media/<edit_mid>
$PY $SK/breathmap.py $M --table              # real breaths vs consonants it rejected
$PY $SK/cutplan.py $M keep.json plan_a.json --report
$PY $SK/joints.py  $M plan_a.json plan.json  # ear-check + repair every cut
```

Why the planner works the way it does (measured on real phone recordings):
- **Edges come from the sound, not the transcript.** ASR word times are coarse (Phonon-2: 80 ms
  steps) and stretch a word over the following inhale. Ends = last voiced frame (pitch-based,
  hysteresis keeps soft endings) + word-final fricative + 80 ms; starts = 70 ms before voicing
  (p/t/k aspiration is ~70 ms and looks like breath).
- **Energy is not speech**: an inhale can be as loud as a word. Never move a cut to where the
  waveform is loud; check voicing or listen.
- **Breaths go with the gap, but keep ~70 ms of them as air** each side: dipped by "Lower
  breaths" that sliver is the pause. Cutting breaths out completely makes words collide.
- **Protect consonants over breaths**: >= 80 ms after voicing, >= 50 ms before onset. A breath
  sliver gets dipped; a clipped "ch" can't be fixed.
- **Don't over-cut**: no piece under 0.7 s (median 1.5-2.5 s). A short piece means the pause
  was emphasis: keep it.
- **Connected speech** ("and [basically] get"): no pause, so the edge goes to the energy dip
  nearest the word boundary and `joints.py` checks it. If the ears still say "no breathing
  room" there, keep the filler: a filler beats two words colliding.

`joints.py` renders every joint as it will play, transcribes them in one batch and requires the
2 words before + 2 after back to back; failing joints get candidate edges and the passing one
that moves least wins. ASR mishears accents ("fast" -> "first", "stack" -> "stock"): compare
with the source transcript of the same words before calling a cut bad.

## 3. Build the project (the polish)

A short edit script on `scripts/shortslib.py` (see its docstring). The style below is what
working editors do and what separates a crafted edit from template "AI slop" (flat badges that
fade, preset karaoke captions with emojis, a zoom on every cut, text every second):

- **Captions** `CLEAN_CAPTIONS`: Inter 800, 66, sentence case, white + ONE accent (`ACCENT`) on
  the active word, soft shadow, 3 words a page, fade in, posY 0.66, no emojis. Fix misheard
  words with `word_edits`; text `""` hides a word.
- **Zoom** `zoom_eyes()`: medium/tight (1.0/1.08) per cut with the **eyes locked** at one height
  (`y = 2*eye_y - 1`; measure eye height on a frame, ~0.33 for a usual phone selfie framing),
  a 1.16 punch only on the first clip of payoff beats, slow push on the hook. A whoosh whose
  peak lands on the hook -> story cut (`whoosh_into`), no white flash.
- **Brand mentions** `sticker_pop()`: the real full-colour logo as a sticker (white die-cut
  border + soft shadow: `sticker.py commons "File:..." out.png` or `sticker.py logo`), beside
  the head (x 0.8, y 0.36, scale 0.2, tilt -4°), popping on the spoken word: 70% -> 110% in 7
  frames -> 100% in 5, tilt settling, small rise; scales out over 9 frames. Soft Pop (0.3).
  Wide wordmarks go under the chin, above the captions (x 0.5, y 0.565, scale 0.34).
- **Lists of brands**: one translucent panel (`sticker.py panel`, y 0.565, scale 0.78), logos
  popping on their words (x 0.26/0.42/0.58/0.74, scale 0.135), a Click (0.7) each.
- **Cards** `card()`: ONE style and size for the whole video (white rounded box, Montserrat 900,
  60, slide in, y 0.13). Text only on key points.
- **Numbers** `number("10×", None)`: big accent number above the head; skip the label when the
  captions already say it.
- **Never** cover the face (check mouth and chin on a frame grab) or the caption band.
- Sound: normalize -14 LUFS, repair on, "Lower breaths" on (`save()` sets them). No music by
  default (licensing); if wanted: -18 to -25 dB under the voice, ducked.

## 4. Export, verify, listen

```
bash $SK/instance.sh start <src_mid>        # then make_edit_media(...) against :7378
$PY my_edit.py                               # your edit script -> project id
python3 $SK/export.py <project_id>           # headless Firefox drives the export
$PY $SK/verify.py <export.mp4> expected.txt outdir [--compare <their export.mp4>]
$PY $SK/listen.py <project_id> <export.mp4> --data ~/.cache/shorts-edit-instance/data/shorts-studio
```
`expected.txt` = the kept words (join `plan.json` clip texts). Accept only when:
- every kept word is captioned (`save()` checks and fixes edge words on edit copies)
- word match >= 97%, every difference a known mishearing (check each one)
- 0-2 loud breaths; integrated -14 LUFS, true peak <= -1 dBTP
- `listen.py`: no clicks, no level/pitch jumps it flags, no "no breathing room" you can avoid,
  every effect within its range (default -16 to -4 dB vs the voice)
- frame grabs: cards on <= 2 lines, nothing on the face, stickers animate (pop frames differ)

**The ears learn the user's taste**: `listen.py ... --page DIR` writes a page of 3 s clips
(every cut and effect) with *Sounds fine / Sounds edited* buttons; the user saves the ratings
and `listen.py --calibrate ratings.json` fits the weights (`~/.config/shorts-studio/ears.json`).
Offer it once a user has two or three edits.

Copy the export next to theirs (their `export_dir`), then `instance.sh stop` (it keeps
`out/` if exports are still there), and recreate the
project in their app against `http://127.0.0.1:7377` with a fresh `make_edit_media` there.

## 5. Report back

A table, theirs vs yours: length, words/min, audible breaths, cuts and median clip, what was
cut and restored, captions, graphics, loudness, the listen.py worst joints. Name the 1-3 spots
you want them to listen to and anything that needs their OK. Say where theirs is better.

## Gotchas

- Export names: "Name (x)" exports as "Name _x_.mp4".
- Headless Firefox must keep being poked (`page.evaluate`) while waiting, or callbacks stall
  (`export.py` does it).
- An inhale often ends in 1-3 pitched frames; hysteresis voicing can bridge it. The planner
  splits voicing at every detected breath for that reason.
- Re-transcribing a clip in the app recomputes its breath map from the new words; edit copies
  are separate and keep theirs.
