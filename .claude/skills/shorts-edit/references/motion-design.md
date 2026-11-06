# Motion design for explainers (panels, steppers, lists, charts)

Why this exists: a hand-drawn flow chart with four rainbow colour bars, mixed icon/text boxes, a
pill sitting on the panel border and every box bouncing in like a sticker was called "vibecoded"
(2026-11-05). Explainers must look like product UI made by one designer. Build them with
`scripts/ui.py` (tokens + components) and place them with `Edit.ui_panel / ui_states / ui_ping`;
check them with `scripts/uicheck.py` before exporting.

## Look
- **One accent.** Neutrals (ink panel, white, muted white) + the channel accent (yellow) for "current /
  important". Red and green only when they *mean* down/up or wrong/right. Never a colour per item.
- **One type scale.** Title 30, label 26, meta 19 (design px, Montserrat 800). Every label in a row is
  the same size and weight; nothing shrinks to fit except as a last resort (ui.py steps down ≤ 4 px,
  then refuses).
- **One component language.** Same panel (ink at ~77%, 1.5 px light rim, radius 22, soft shadow) as the
  frosted title cards. Nodes are circles with a number (pending), accent fill (current) or white +
  check (done). Icons: all items or none.
- **Grid and padding.** 8 px grid; panel padding 24; text never closer than 12 px to any edge. Notes
  live *inside* the panel (e.g. "to everybody" under its node), never straddling a border.
- **Hierarchy by state, not decoration.** Current = accent; done = white; pending = 45% white.
  Dim (50% opacity) to say "this is the wrong way", then make the point with a marker card.

## Motion
- **UI enters calmly:** fade-up 8 frames (opacity 0→1, 12 px rise, 97%→100% scale), ease-out, no
  bounce, no tilt. Exit: fade 6 frames. Bounce/overshoot is for stickers and emoji only.
- **Change state, don't add objects.** A process is one panel whose state changes on each spoken word
  (instant swap, like real UI) + a focus ring that expands and fades on the node that just became
  current (`ui_ping`, 12 frames). Not a new box popping per word.
- **One motion idea at a time.** Don't animate the panel and its content together; let the entrance
  finish (8 frames) before the first state change.
- **Hold to read.** ≥ 1.2 s on screen per state with new text; the whole panel ≥ 2.5 s.
- **Sound follows meaning.** A soft Click (0.4) on state changes; a Pop only on sticker entrances;
  Boom only for a verdict (once per video).

## Layout on the frame
- Clear of the face and the caption band: shorts → above the captions, beside or under the chin;
  long-form → the empty side of the frame, right edge ≥ 2% from the face.
- Max two information elements on screen (a panel + a card). Chapter cards top-left, panels mid-left.
- Long-form (16:9): `size=1.35`; shorts (9:16): `size=1.0`.

## Check before exporting
`python3 scripts/uicheck.py <png> [...]` (or `--project <data>/projects2/<id>.json`):
palette (≤ 1 accent hue + red/green), content touching the PNG edge, tiny text, and a review sheet at
phone size (`uicheck.png`). Then look at a frame grab of every state on the real frame.
