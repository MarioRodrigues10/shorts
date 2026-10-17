#!/usr/bin/env bash
# Re-record the README demo (docs/media/demo.webp + demo.mp4) without touching your projects.
# Builds a synthetic clip (gradient + waveform, Piper voice), runs a throwaway server instance
# on :7378, drives the UI with Playwright (Firefox) and edits the recording with ffmpeg.
# Needs: uv, ffmpeg, python3 with playwright (`pip install playwright && playwright install firefox`).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
WORK=$(mktemp -d)
PORT=7378
VOICE=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx
SERVER=
DEMO_EXPORTS="$HOME/Videos/Shorts Demo"
# KEEP=1 keeps the work folder (server log, raw recording, failure screenshot) for debugging
trap 'kill $SERVER 2>/dev/null || true; rm -rf "$DEMO_EXPORTS"; [ -n "${KEEP:-}" ] && echo "kept $WORK" || rm -rf "$WORK"' EXIT
rm -rf "$DEMO_EXPORTS"

echo "• narration"
uv venv -q -p 3.12 "$WORK/tts"
VIRTUAL_ENV="$WORK/tts" uv pip install -q piper-tts
curl -sSfL -o "$WORK/voice.onnx" "$VOICE"
curl -sSfL -o "$WORK/voice.onnx.json" "$VOICE.json"
"$WORK/tts/bin/python" scripts/demo/narration.py "$WORK/voice.onnx" "$WORK/voice.wav"

echo "• clip"
mkdir -p "$WORK/library" "$WORK/config/shorts-studio" "$WORK/data" "$WORK/uploads"
ffmpeg -v error -y -i "$WORK/voice.wav" -filter_complex "\
gradients=s=1080x1920:c0=0x1c1210:c1=0xdc4a22:c2=0x1e9baa:c3=0xf2b880:n=4:speed=0.012:r=30[bg];\
[0:a]aformat=channel_layouts=mono,showwaves=s=900x420:mode=cline:colors=0xffffff:scale=sqrt:draw=full:r=30,format=rgba,colorchannelmixer=aa=0.85[w];\
[bg][w]overlay=(W-w)/2:(H-h)/2:shortest=1:format=auto,format=yuv420p[v]" \
  -map "[v]" -map 0:a -c:v libx264 -crf 18 -c:a aac -b:a 160k -shortest "$WORK/library/My first short.mp4"

echo "• server on :$PORT"
cat > "$WORK/config/shorts-studio/config.json" <<EOF
{"port": $PORT, "library_dirs": ["$WORK/library"], "upload_dir": "$WORK/uploads", "export_dir": "~/Videos/Shorts Demo", "vocabulary": "Shorts, short form content, Linux."}
EOF
XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" SHORTS_PORT=$PORT python3 server.py > "$WORK/server.log" 2>&1 &
SERVER=$!
sleep 2

echo "• recording"
python3 scripts/demo/record.py "$WORK"

echo "• editing"
mkdir -p docs/media
python3 scripts/demo/edit.py "$WORK" "$ROOT/docs/media"
ls -la docs/media
