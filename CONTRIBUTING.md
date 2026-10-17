# Contributing to Shorts

Thanks for helping! Bug reports, feature ideas and pull requests are all welcome.

## Getting set up

1. Run the setup script for your system (see the [README](README.md#install)).
2. Start the UI with hot reload (API calls go to the server on :7377):

   ```sh
   cd web && bun run dev        # http://127.0.0.1:5173
   ```

3. Before opening a pull request:

   ```sh
   cd web && bun test && bun run build
   ```

## Test on a separate instance

Your real projects live in `~/.local/share/shorts-studio`. When you experiment, run a throwaway server with its own data folders and port so nothing you do can touch them:

```sh
XDG_DATA_HOME=/tmp/ss/data XDG_CONFIG_HOME=/tmp/ss/config SHORTS_PORT=7378 python3 server.py
```

## Where things are

| Path | What |
|---|---|
| `server.py` | HTTP server (stdlib only): media registry, background jobs, projects, export |
| `transcribe.py` | faster-whisper transcription with word-timing refinement |
| `vision.py` | MediaPipe face tracking and background segmentation |
| `web/src/core/` | The editing engine: project model, timeline, player, caption renderer, keyframes. Plain JS, no React |
| `web/src/components/` | React UI |
| `web/test/` | Unit tests for the engine (`bun test`) |
| `docs/mascot/build.py` | Generates Shorty, the mascot, as SVG |
| `scripts/demo/` | Re-records the README demo with a synthetic clip |

A few rules the code relies on:

- **Preview and export must match.** Anything drawn in the browser preview (`player.js`, `layer.js`) has an ffmpeg counterpart in `server.py`. Change both.
- **Keep it light.** Heavy work runs one job at a time at low priority. Shorts should stay usable on an 8 GB laptop.
- **Everything stays local.** No network calls at runtime, apart from model downloads.

## Never commit user data

Videos, audio, images, transcripts, project files and paths from your machine must never end up in the repo. `scripts/check-no-data.sh` enforces this. It runs as a pre-commit hook (the setup scripts enable it) and again in CI. The only media allowed are the synthetic demo files in `docs/media/`.
