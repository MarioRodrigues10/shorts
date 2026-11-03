# Edit style: where the numbers come from (researched 2026-11-03)

Mostly editor tutorials (YouTube transcripts), Remotion's own template code and editor blogs.
[U] = unverified / vendor-only / opinion. Creators named are for technique, never to copy content.

## Logos and stickers
- Real full-colour logo, background removed, timed to the spoken word / a gesture, small, never
  over the face; pop SFX for a pop-in, whoosh for a slide; exit with a fade.
  Junius Ong (CapCut): https://www.youtube.com/watch?v=E0MDlSgXxp8
- Pop curve: scale 70% -> 110% over 7 frames, -> 100% over 5 (30 fps).
  Isaac: https://www.youtube.com/watch?v=ciAywjey0cY
- Hormozi-style image pop: PNG + soft drop shadow, position from below + rotation, fast-start
  slow-end. https://www.youtube.com/watch?v=pelJlYOkn7s
- Lists: stagger 4 frames, motion blur (180° shutter); items from scale 0 + rotation 45-90° -> 0,
  "small and luxurious". Cinecom: https://www.cinecom.net/adobe-premiere-pro-tutorials/graphics/create-smooth-logo-animations-premiere-pro-tutorial/
  · TomsProject (Kallaway): https://www.youtube.com/watch?v=aNwKDaTag2Q
- Exit ~75% of entrance duration. https://git.secluded.site/agent-skills/blob/main/vendor/impeccable/skill/reference/motion-design.md
- Sticker border width, logo size, hold time: no source [U] (we use 10 px border, ~20% width).

## Cards and numbers
- Hormozi hook: Instagram-native white rounded box, black bold text, top, first ~4 s.
  https://www.youtube.com/watch?v=y60ohM4nr4Y
- Gadzhi system: 60-30-10 colour, two fonts (sans body + serif accent word), rounded shapes,
  per-word blur 10->0 + opacity stagger. https://www.youtube.com/watch?v=O6HOYu_ZEnw
- One font size across a series; never squash text; translucent panels 80-90% + 4 px stroke;
  numbers count up in a monospaced face. https://www.youtube.com/watch?v=aNwKDaTag2Q
- Text only on key points: "a text pop every second" irritates. https://www.youtube.com/watch?v=ciAywjey0cY

## Captions
- Remotion TikTok template (TheBoldFont, 120 px max, 20 px stroke, #39E508 active word, 5-frame
  spring 0.8->1): https://github.com/remotion-dev/template-tiktok — the "classic" look.
- Not-cheap captions: bold geometric sans, white + one accent, 3-5 words, max 2 lines, 10% side
  margins, 95->100% pop or 0.1 s fade, no spin/bounce. https://reelwords.ai/blog/how-to-make-captions-pop-without-looking-cheap
- Hormozi "2.0": clean sans, white + soft shadow, brand-colour keywords, fades, no emojis [U].
  https://joyspace.ai/hormozi-editing-style-2026-analysis
- Timing hygiene: start on the first frame of speech, >= 2 empty frames between captions, outline
  before shadow before box. Derek Lieu: https://www.derek-lieu.com/blog/2019/10/27/guide-for-captions-and-subtitles
- Safe zones (estimates): top ~15%, bottom 25-35%, right 120-160 px. https://reap.video/blog/short-form-video-safe-zones

## Zoom, pacing
- Jump cut every 1-3 s alternating medium/tight, 10-20% punch-ins, no SFX on plain cuts [U].
  https://www.choppity.com/tools/recreate-video-editing-style/alex-hormozi/
- Keep the eyes on the same point across zooms and cuts. https://www.youtube.com/watch?v=ciAywjey0cY
- Whoosh peak on the first frame of the new shot. https://morphic.com/resources/sounds/transition-sound-effects

## SFX, music
- Whoosh per zoom move, click per icon, UI blip per popup; lower SFX "so they don't become
  annoying". https://www.youtube.com/watch?v=Qbntd8yud0o · https://www.youtube.com/watch?v=ciAywjey0cY
- Music under speech -18 to -25 dB, duck over 0.5-1 s. https://vidpros.com/fix-background-music-too-loud-video/

## Slop tells -> fixes
| tell | fix |
|---|---|
| recognisable preset captions (Bold-Pop, green/yellow karaoke, emoji spam) | own palette, white + 1 accent, no emojis |
| text every second | text on key claims only |
| zoom on every cut with the eyes jumping | eyes locked (zoom_eyes), motivated punch-ins |
| linear, blur-free motion / flat badges that fade | eased overshoot pop, depth (shadow, border) |
| oversized/squashed text, many sizes | one type size |
| graphics on the face or in the UI zones | beside the head, safe zones |
| 3+ neon colours, spinning, bouncing | one accent, micro-animation |
