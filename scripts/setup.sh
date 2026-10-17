#!/usr/bin/env bash
# Shorts setup for Linux and macOS: Python envs, ML models, caption fonts, web UI, `shorts` command.
# Safe to re-run.  Usage:  scripts/setup.sh [--no-vision] [--no-service]
#   --no-vision   skip auto-reframe / background replacement (saves ~400 MB)
#   --no-service  Linux: don't install the systemd user service (`shorts` starts the server on demand)
# Windows: use scripts\setup.ps1 instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VISION=1 SERVICE=1
for a in "$@"; do
  case "$a" in
    --no-vision) VISION=0 ;;
    --no-service) SERVICE=0 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1;31m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

OS=$(uname -s)
case "$OS" in
  Darwin) PM="brew install" ;;
  Linux)
    if have pacman; then PM="sudo pacman -S"
    elif have apt-get; then PM="sudo apt install"
    elif have dnf; then PM="sudo dnf install"
    elif have zypper; then PM="sudo zypper install"
    else PM="<your package manager> install"; fi ;;
  *) die "unsupported system '$OS' (on Windows run scripts\\setup.ps1 in PowerShell)" ;;
esac

# ---- Requirements -----------------------------------------------------------
missing=()
have ffmpeg && have ffprobe || missing+=("ffmpeg:   $PM ffmpeg")
have curl || missing+=("curl:     $PM curl")
have uv || have python3 || missing+=("uv:       curl -LsSf https://astral.sh/uv/install.sh | sh   (recommended; it also provides Python 3.12)")
if ! have bun && ! { have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }; then
  missing+=("bun:      curl -fsSL https://bun.sh/install | bash   (or Node.js 20+)")
fi
if [ ${#missing[@]} -gt 0 ]; then
  printf '\033[31mMissing requirements.\033[0m Install them, open a new terminal, and run this again:\n\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo >&2
  exit 1
fi

# ---- Python environments (3.12: wheels exist for faster-whisper and mediapipe) ----
mkvenv() { # dir requirements  (installs run at low priority: they're heavy on small laptops)
  if have uv; then
    [ -x "$1/bin/python" ] || uv venv --python 3.12 "$1"
    nice -n 10 uv pip install --python "$1/bin/python" -r "$2"
  else
    v=$(python3 -c 'import sys; print("%d%02d" % sys.version_info[:2])')
    [ "$v" -ge 310 ] && [ "$v" -le 312 ] || die "Python 3.10-3.12 needed (found $(python3 -V)); install uv and re-run"
    [ -x "$1/bin/python" ] || python3 -m venv "$1"
    nice -n 10 "$1/bin/pip" install -q -r "$2"
  fi
}
say "Transcription environment (.venv)"
mkvenv .venv requirements.txt

if [ "$VISION" = 1 ]; then
  say "Vision environment (.venv-vision): auto reframe and background replacement"
  mkvenv .venv-vision requirements-vision.txt
  mkdir -p models
  base=https://storage.googleapis.com/mediapipe-models
  [ -s models/face.tflite ] || curl -fsSLo models/face.tflite "$base/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite"
  [ -s models/selfie.tflite ] || curl -fsSLo models/selfie.tflite "$base/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"
fi

# ---- Caption fonts (SIL Open Font License, from Google Fonts), served by the app ----
FONTS=static/fonts
mkdir -p "$FONTS"
g=https://github.com/google/fonts/raw/main/ofl
get_font() { [ -s "$FONTS/$1" ] || curl -fsSLo "$FONTS/$1" "$2" || echo "  (skipped $1)"; }
say "Caption fonts"
for f in anton/Anton-Regular bebasneue/BebasNeue-Regular bangers/Bangers-Regular archivoblack/ArchivoBlack-Regular \
         poppins/Poppins-Black poppins/Poppins-ExtraBold; do
  get_font "$(basename "$f").ttf" "$g/$f.ttf"
done
get_font Montserrat.ttf "$g/montserrat/Montserrat%5Bwght%5D.ttf"
get_font Inter.ttf "$g/inter/Inter%5Bopsz,wght%5D.ttf"

# ---- Web UI -------------------------------------------------------------------
say "Building the web UI"
cd web
if have bun; then
  bun install --frozen-lockfile 2>/dev/null || bun install
  bun run build
else
  npm install && npx vite build
fi
cd "$ROOT"

# ---- Git hooks (block media / user data / local paths from commits) -----------
if [ -d .git ]; then git config core.hooksPath .githooks; fi

# ---- `shorts` command, service, launcher -----------------------------------------
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/shorts" "$HOME/.local/bin/shorts"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *)
  printf '\033[33mnote:\033[0m add ~/.local/bin to your PATH to use the `shorts` command:\n  echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.%src\n' "$(basename "${SHELL:-bash}")" ;;
esac

if [ "$OS" = Linux ]; then
  mkdir -p "$HOME/.local/share/applications"
  sed "s|@ROOT@|$ROOT|g" contrib/shorts-studio.desktop.in > "$HOME/.local/share/applications/shorts-studio.desktop"
  if [ "$SERVICE" = 1 ] && have systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    say "Background service (systemctl --user status shorts-studio)"
    mkdir -p "$HOME/.config/systemd/user"
    sed "s|@ROOT@|$ROOT|g" contrib/shorts-studio.service.in > "$HOME/.config/systemd/user/shorts-studio.service"
    systemctl --user daemon-reload
    systemctl --user enable --now shorts-studio.service
    systemctl --user restart shorts-studio.service
  fi
else
  # macOS: a double-clickable launcher in ~/Applications (the server starts on demand)
  APPDIR="$HOME/Applications"
  mkdir -p "$APPDIR"
  printf '#!/bin/bash\nexec "%s/shorts"\n' "$ROOT" > "$APPDIR/Shorts.command"
  chmod +x "$APPDIR/Shorts.command"
  say "Launcher: ~/Applications/Shorts.command"
fi

say "Done! Run: shorts   (or open http://127.0.0.1:7377)"
