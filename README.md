<div align="center">

<img src="docs/mascot/shorty-hero.svg" alt="Shorty, the Shorts mascot: a clapperboard with scissors" width="170">

# Shorts

**The CapCut-style editor for short-form video. Free, open source, and it runs entirely on your machine.**

Auto captions · edit by deleting words · one-click silence and retake removal · export ready for Reels, TikTok and Shorts

[![CI](https://github.com/MarioRodrigues10/shorts/actions/workflows/ci.yml/badge.svg)](https://github.com/MarioRodrigues10/shorts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-dc4a22)](LICENSE)
![Linux · macOS · Windows](https://img.shields.io/badge/runs%20on-Linux%20·%20macOS%20·%20Windows-1e9baa)
![100% local](https://img.shields.io/badge/cloud-none.%20100%25%20local-1c1917)

[Install](#install) · [Features](#features) · [Let Claude edit it](#or-let-claude-edit-it) · [Why](#why-i-built-it) · [FAQ](#faq)

<br>

<img src="docs/media/demo.webp" alt="Demo: auto captions, cutting a retake and silences, choosing a caption style, deleting a word in the transcript, exporting" width="900">

<sub>Real recording, with the transcription and export waits sped up. <a href="docs/media/demo.mp4">MP4 version</a>. The clip is synthetic, so no personal footage ships with this repo.</sub>

</div>

## From raw recording to posted in about two minutes

1. **Drop in your video.** Phone footage, screen recordings, anything ffmpeg reads.
2. **Click _Auto captions_.** Phonon-2 transcribes only what's on your timeline, on your own CPU.
3. **Click _Cut retakes_ and _Remove silences_.** False starts and dead air are gone.
4. **Pick a caption style.** Word-by-word highlights, boxes, karaoke, one word at a time. Drag it where you want.
5. **Delete words in the transcript** to cut them from the video, like editing a doc.
6. **Export.** 1080×1920 H.264 at −14 LUFS, plus `.srt` captions and a `.txt` transcript for your post.

## Or let Claude edit it

<img src="docs/mascot/shorty-ears.svg" alt="Shorty listening with headphones" width="150" align="right">

Shorts ships with a [Claude Code](https://claude.com/claude-code) skill that turns a raw take into a finished short, then checks its own work by listening to it. Open Claude Code in this folder and ask:

```text
> Make a Reel from ~/Videos/raw/take-12.mp4. Keep my points, lose the breaths.
```

1. **It edits the script with you.** Fillers, stutters, retakes and dead sign-offs go. Anything that carries meaning is listed for your OK first, along with a suggested hook for the first three seconds.
2. **It cuts on the sound, not the transcript.** Each cut sits on where your voice actually starts and stops. Breaths leave with the pause they're in, and the sliver kept as breathing room is turned down to near silence. Word endings like *-ch* and *-st* are never clipped, and no clip is so short it feels choppy.
3. **It checks every cut by ear.** Each joint is played back and re-transcribed. A cut that clips a word, or lets a removed word leak back in, gets moved until it sounds right.
4. **It adds the polish real editors use.** Captions in white with one accent colour. Punch-ins that keep your eyes in the same spot. Full-colour logos as stickers that pop in on the word you say them. One consistent card style. Sound effects levelled under your voice.
5. **It exports on a throwaway copy of Shorts and verifies the result.** Every word captioned, no audible breaths, −14 LUFS, and a list of the cuts that still sound edited. You get the file next to your exports, a new project in your app, and a short report of what to listen to.

**What the ears listen for** (`listen.py`, at every cut and sound effect):

| | Flags |
|---|---|
| Click | an un-faded edit: a jump in the waveform |
| Level and pitch | your voice suddenly louder, quieter, higher or lower across a cut |
| Tone | the sound changing colour across a cut |
| Breathing room | words colliding with no pause, or dead air |
| Breath | a breath left near a cut |
| Effects | a pop or whoosh too loud or too quiet for your voice (editors keep them about 6 to 10 dB under) |

**Teach it your taste.** `listen.py … --page` builds a listening page of three-second clips with *Sounds fine* and *Sounds edited* buttons. Rate a few, run `listen.py --calibrate ratings.json`, and from then on it ranks cuts the way you hear them. Put your channel's preferences (brand logos, colours, words the transcriber gets wrong for your voice) in `~/.config/shorts-studio/edit-notes.md` and the skill follows them.

**YouTube videos and thumbnails too.** Ask for a long-form edit and it switches to 16:9: a cold open from your strongest lines, chapter cards, subtitles as an `.srt` to upload instead of burned-in captions, and a grade measured on your face. It also goes past logos. When you mention a video, it shows that video's card. A list of points becomes a scorecard that fills in as you talk, and a claim gets the real web page behind it as proof.

```text
> Edit ~/Videos/raw/update.mp4 as a YouTube video, then make the thumbnail.
```

Thumbnails take two steps. First it scores every half-second of your video for open eyes, eye contact, a closed mouth and sharpness. It shows you the 24 best faces and six finished layouts. You pick one, and it relights you from your face, sets 2–3 big words next to you, and adds an optional series badge. It can also polish a soft face from a phone frame. A face-recognition check makes sure the result is still you, and it backs off if it isn't (`setup.sh --face-polish`).

**Compare your style with numbers.** `fingerprint.py` measures how a video is edited: cuts per second, punch-ins, how much your eye line moves, how often something new appears on screen, and the grade. Run it on your edit and on a folder of creators you admire to see where you differ.

**It never touches your work.** It edits a private copy of your clip (a hardlink, so no extra disk space) and renders on a separate Shorts instance. Your projects, transcripts and exports stay as they are.

<details>
<summary>Setup and the full workflow</summary>

<br>

- The skill lives in [`.claude/skills/shorts-edit`](.claude/skills/shorts-edit/SKILL.md). Claude Code loads it automatically in this folder. To use it from anywhere: `ln -s "$PWD/.claude/skills/shorts-edit" ~/.claude/skills/`.
- Exports are driven in a headless browser: `python3 -m pip install playwright pillow && python3 -m playwright install firefox`.
- Each step is a plain script you can run yourself: `breathmap.py` (breaths vs *sh*/*ch*/*s*), `cutplan.py` (cut plan), `joints.py` (ear check), `shortslib.py` (build the project), `export.py`, `verify.py` (words, breaths, loudness), `listen.py` (the ears), `srt.py` (subtitles), `graphics.py` (video cards, scorecards, stamps, page proof), `thumbnail.py` + `restore.py` (thumbnails and face polish) and `fingerprint.py` (style numbers). The research behind the long-form and thumbnail choices is in [`references/`](.claude/skills/shorts-edit/references). The full playbook is in [`SKILL.md`](.claude/skills/shorts-edit/SKILL.md), and the editing sources behind every number are in [`references/style.md`](.claude/skills/shorts-edit/references/style.md).

</details>

## Why I built it

I make short-form videos for **[IdealJob](https://idealjob.app)**, and Shorts is the editor I built to edit them. Before, I used CapCut or DaVinci Resolve. On Linux neither works well:

- **CapCut** has no Linux version.
- **DaVinci Resolve** runs on Linux, but the experience is miserable for short-form content:
  - The free version can't read H.264 or AAC on Linux, so every phone or screen recording had to be converted to DNxHR before I could import it.
  - Captions meant exporting the audio and running a separate transcription tool in the terminal.
  - Every export needed another pass through ffmpeg before Instagram or TikTok would accept it.
  - Caption styling was very limited.

So I built my own: the editing flow I liked in CapCut, running natively on Linux (and now macOS and Windows), with everything, transcription included, on my own machine.

### How it compares

| | **Shorts** | CapCut | DaVinci Resolve (free) |
|---|:---:|:---:|:---:|
| Runs on Linux | ✅ | ❌ | ✅ |
| Opens phone footage (H.264/AAC) on Linux | ✅ | — | ❌ |
| Auto captions | ✅ on your CPU | ✅ | ❌ Studio only |
| Edit the video by editing the transcript | ✅ | ✅ | ❌ Studio only |
| Open source | ✅ MIT | ❌ | ❌ |
| Price | Free | Free + Pro subscription | Free / Studio $295 |

## Features

<table>
<tr>
<td width="50%"><img src="docs/media/editor-light.webp" alt="Shorts editor in light mode"></td>
<td width="50%"><img src="docs/media/editor-dark.webp" alt="Shorts editor in dark mode"></td>
</tr>
</table>

**Speech editing**
- **Auto captions** transcribe only the parts of your videos that are on the timeline, and only the new parts after you edit.
- **Transcript editing:** delete words to cut them, fix misheard words, highlight words for captions.
- One-click **Remove silences**, **Cut retakes** (false starts), **Cut fillers** (um, uh) and **Punch-in** (alternating zoom on cuts).
- **[Claude Code skill](#or-let-claude-edit-it)**: a full edit from one prompt, with breath-aware cuts that are checked by ear. It also edits YouTube videos and makes thumbnails.

**Captions and graphics**
- 7 caption styles (word highlight, box, one word, karaoke…) with full control over font, colors, outline, shadow and animation. Drag them on the canvas.
- Text presets, emoji stickers, and highlight shapes (boxes, circles, arrows, underlines).

**Timeline**
- A main track plus as many video, image, text and audio rows as you need. Free placement or a magnetic main track.
- Trim, split, delete left/right of the playhead, duplicate, copy/paste, markers, snapping. Zoom stays anchored on the playhead.
- Transitions (dissolve, dips, slides, wipes, zoom, circle) and keyframes for position, scale, rotation and opacity.
- Speed, flip, freeze frame, detach audio, slow zoom (Ken Burns), intro effects.
- **Smooth cuts**: hides jump cuts by lining your face up across the cut, then gliding back to the normal framing.

**Look and sound**
- Color looks and adjustments: brightness, contrast, saturation, temperature, sharpen, denoise.
- **Clean surface**: draw a box over a desk or mat and dust, lint and crumbs disappear.
- **Phone mockups**: put any video inside a phone (black or silver) as an element you can move, resize, rotate and animate, or frame the whole video in a phone on a gradient, colour or blurred background.
- **Auto reframe** follows your face to turn landscape footage into 9:16. **Background replacement** with blur or a color.
- Music and sound effects that duck under your voice automatically, plus voiceover recording.
- Loudness normalization to −14 LUFS, voice enhance, automatic repair of clipped (distorted) audio, and **Lower breaths**, which makes breathing between sentences almost silent without changing your timing.

**Export**
- 30 or 60 fps, 1080p or 720p, H.264 + AAC. Uses the Intel GPU encoder (VA-API) on Linux when available, x264 otherwise.
- No generational loss: each clip is rendered losslessly once and cached; only the final encode compresses.

## Install

You need **git**. The setup script tells you exactly what else to install (FFmpeg, [uv](https://github.com/astral-sh/uv) and [Bun](https://bun.sh)) if anything is missing.

**Linux and macOS**

```sh
git clone https://github.com/MarioRodrigues10/shorts.git
cd shorts
scripts/setup.sh
```

On macOS, get the requirements with [Homebrew](https://brew.sh): `brew install ffmpeg uv oven-sh/bun/bun`.

**Windows 10 / 11** (PowerShell)

```powershell
git clone https://github.com/MarioRodrigues10/shorts.git
cd shorts
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

On Windows, missing tools are installed for you with `winget`.

The setup script:
- creates the Python environments
- downloads the caption fonts and vision models (all openly licensed)
- builds the UI
- installs the `shorts` command, plus a background service on Linux, `~/Applications/Shorts.command` on macOS, or a Start Menu shortcut on Windows

The Phonon-2 speech model (about 170 MB) downloads on your first transcription. Add `--no-vision` (`-NoVision` on Windows) to skip auto reframe and background replacement and save about 400 MB. Add `--face-polish` (`-FacePolish`) to also download the thumbnail face-polish models (about 510 MB). GFPGAN is Apache-2.0, but the identity-check model from InsightFace is licensed for non-commercial research only.

## Use

```sh
shorts                    # open the app in your browser
shorts path/to/clip.mp4   # start a project from a clip
shorts convert file.mov   # platform-ready MP4, no editing
```

Press `?` in the editor for every shortcut. The essentials:

| Key | Action | Key | Action |
|---|---|---|---|
| `Space` | Play / pause | `S` | Split |
| `Q` / `W` | Delete left / right of playhead | `Del` | Delete |
| `←` `→` | Frame step (Shift: 1 s) | `↑` `↓` | Previous / next cut |
| `T` | Add text | `Ctrl+Z` / `Y` | Undo / redo |
| `Ctrl+E` | Export | `?` | All shortcuts |

**Coming from DaVinci Resolve?** Copy `integrations/resolve/Send to Shorts.py` into `~/.local/share/DaVinciResolve/Fusion/Scripts/Utility/`. Then *Workspace → Scripts → Send to Shorts* renders the current timeline and opens it here for captions and export.

## Meet Shorty

<p align="center">
<img src="docs/mascot/shorty-wave.svg" alt="Shorty waving" height="130">
<img src="docs/mascot/shorty-listen.svg" alt="Shorty listening" height="130">
<img src="docs/mascot/shorty-celebrate.svg" alt="Shorty celebrating" height="130">
<img src="docs/mascot/shorty-ears.svg" alt="Shorty listening with headphones" height="130">
<img src="docs/mascot/shorty-sleep.svg" alt="Shorty sleeping" height="130">
</p>

Shorty keeps you company in the app: listening while it transcribes, celebrating when your video is ready, and napping when there's nothing to edit yet. With headphones on, it's the face of the Claude skill that listens to your cuts. It's a clapperboard with scissors, because editing is mostly cutting. Every pose is plain SVG generated by [`docs/mascot/build.py`](docs/mascot/build.py).

## Your data stays yours

Transcription, rendering and the editor all run on your computer. No accounts, no uploads, no API keys, no telemetry.

The [Claude Code skill](#or-let-claude-edit-it) is optional. If you use it, Claude reads your transcript and a few frame grabs through Claude Code to make its decisions. The audio analysis, rendering and exports still run on your machine.

| What | Where |
|---|---|
| Settings | `~/.config/shorts-studio/config.json` |
| Projects, transcripts, proxies, render cache | `~/.local/share/shorts-studio/` |
| Imported files | `~/Videos/Shorts/Media` (configurable) |
| Exports | `~/Videos/Shorts/Exports` (configurable) |

`config.json` lets you change:
- the folders shown in the media browser (`library_dirs`)
- `upload_dir` and `export_dir`
- the transcription `model` and `language`
- `vocabulary` (comma-separated names and terms the model should know)
- encoder settings

## FAQ

**Does it work in my language?**
Yes. Set your `"language"` (for example `"pt"` or `"es"`) in `config.json`. English uses Phonon-2 (the default `"model"`), which is fast and accurate. Other languages use Whisper's multilingual `small` model, or any Whisper model you set as `"model"`.

**Do I need a GPU?**
No. Everything runs on the CPU, and it was built on an 8 GB laptop. Previews use lightweight proxies, heavy jobs run one at a time at low priority, and on Linux the service is memory-capped. Intel GPUs speed up exports on Linux.

**Is it really offline?**
After setup, yes. The only downloads are the speech model on first use and the models and fonts during setup.

**Which platforms are tested?**
Linux is the daily driver. CI runs the setup scripts and an export on Linux, macOS and Windows on every push. Bug reports from macOS and Windows are very welcome.

## How it works

```
web/            React + Tailwind + Radix UI, built into static/app
  src/core/     the editing engine: project model, timeline, preview player,
                caption/text renderer, keyframes (plain JS)
server.py       stdlib HTTP server on 127.0.0.1: media registry, background worker
                (proxies, filmstrips, waveforms, transcripts), projects, export via ffmpeg
transcribe.py   Phonon-2 (or faster-whisper) on CPU + energy-based word boundary refinement
vision.py       MediaPipe face tracking and person segmentation (CPU)
.claude/skills/shorts-edit/
                the Claude Code editing skill: cut planner, ear checks, project builder
```

- **Preview and export match.** The same JavaScript draws captions and text in the preview and in the export. The browser renders the caption layer and the server composites it.
- **No drift across hundreds of cuts.** Each clip is rendered to a lossless cached piece on a single frame grid. Transitions are separate pieces. The final pass adds overlays, the caption layer and the audio mix (ducking, two-pass loudness), then encodes once.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, how to test without touching your own projects, and how the repo keeps personal data out of git. `scripts/demo/record.sh` re-records the demo above from a synthetic clip.

If Shorts saves you from a Linux editing headache, a ⭐ helps other people find it.

## License

[MIT](LICENSE) © Mário Rodrigues. Made to edit the videos for [IdealJob](https://idealjob.app).

Built with [Phonon-2](https://huggingface.co/FermionResearch/Phonon-2) by Fermion Research (CC BY 4.0), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [MediaPipe](https://github.com/google-ai-edge/mediapipe), [FFmpeg](https://ffmpeg.org), [React](https://react.dev), [Tailwind CSS](https://tailwindcss.com), [Radix UI](https://www.radix-ui.com) and [Phosphor Icons](https://phosphoricons.com). Caption fonts from [Google Fonts](https://fonts.google.com) (SIL Open Font License).
