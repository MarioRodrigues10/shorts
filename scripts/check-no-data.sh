#!/usr/bin/env bash
# Refuses media, user data, secrets, big files and local home paths in the repo.
#   scripts/check-no-data.sh --staged   files staged for commit (the pre-commit hook)
#   scripts/check-no-data.sh            every tracked file (CI)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
red() { printf '\033[31m%s\033[0m\n' "$*" >&2; }

if [ "${1:-}" = "--staged" ]; then
  files=$(git diff --cached --name-only --diff-filter=ACMR)
  size() { git cat-file -s ":$1" 2>/dev/null || echo 0; }
  added=$(git diff --cached -U0 -- . ':(exclude)scripts/check-no-data.sh' | grep -E '^\+' | grep -v '^+++' || true)
else
  files=$(git ls-files)
  size() { wc -c < "$1" 2>/dev/null || echo 0; }
  added=$(git grep -hI '' -- . ':(exclude)scripts/check-no-data.sh' || true)
fi
[ -z "$files" ] && exit 0

while IFS= read -r f; do
  [ -e "$f" ] || [ "${1:-}" = "--staged" ] || continue
  lower=$(printf '%s' "$f" | tr 'A-Z' 'a-z')
  case "$lower" in
    # the synthetic README demo and screenshots (scripts/demo): the only media allowed, still size-checked
    docs/media/demo.mp4|docs/media/demo.webp|docs/media/editor-light.webp|docs/media/editor-dark.webp) ;;
    *.mp4|*.mov|*.mkv|*.webm|*.m4v|*.avi|*.mxf|*.mts|*.wav|*.mp3|*.m4a|*.aac|*.ogg|*.opus|*.flac|\
    *.png|*.jpg|*.jpeg|*.webp|*.gif|*.heic|*.srt|*.vtt|*.tflite|*.onnx|*.bin|*.safetensors|*.ttf|*.otf)
      red "blocked: media/model/font file  $f"; fail=1 ;;
    .env|.env.*|*/.env|*/.env.*|*.pem|*.key)
      red "blocked: secret file  $f"; fail=1 ;;
    */words.json|words.json|*/meta.json|meta.json|*/peaks.json|peaks.json|*transcript*.json|*/projects*/*|*default-style.json|*/config.json|config.json)
      red "blocked: user data  $f"; fail=1 ;;
  esac
  s=$(size "$f")
  if [ "$s" -gt 1000000 ]; then red "blocked: file over 1 MB  $f ($s bytes)"; fail=1; fi
done <<< "$files"

# local home-directory paths (e.g. /home/you/Videos/...)
pat="/home/[a-z_][a-z0-9_-]*/|/Users/[A-Za-z0-9_-]+/|[A-Za-z]:\\\\Users\\\\[A-Za-z0-9_-]+"
[ -n "${HOME:-}" ] && [ "$HOME" != "/" ] && pat="$pat|$HOME"
hits=$(printf '%s\n' "$added" | grep -nE "$pat" || true)
if [ -n "$hits" ]; then
  red "blocked: a local home-directory path:"
  printf '%s\n' "$hits" | head -5 >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  red "Refused (see above). If you are sure, commit with --no-verify."
  exit 1
fi
