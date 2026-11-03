#!/usr/bin/env bash
# Throwaway Shorts instance on :7378 so test exports never collide with your app (:7377).
#   instance.sh start MID [MID...]   copy those media entries (proxy, words, breaths) and start
#   instance.sh stop                 stop it and delete its data (render cache ~1 GB); exports in out/ stay
# Data lives on real disk: the /tmp scratchpad is a quota'd tmpfs and lossless render-cache
# files overflow it ("Disk quota exceeded").
set -euo pipefail
D="$HOME/.cache/shorts-edit-instance"
LIVE="${XDG_DATA_HOME:-$HOME/.local/share}/shorts-studio"
REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
case "${1:-}" in
start)
  shift
  mkdir -p "$D/data/shorts-studio/media" "$D/data/shorts-studio/projects2" "$D/config/shorts-studio" "$D/out"
  for m in "$@"; do cp -rn "$LIVE/media/$m" "$D/data/shorts-studio/media/"; done
  cp -rn "$LIVE/sfx" "$D/data/shorts-studio/" 2>/dev/null || true
  python3 - "$D" <<'EOF'
import json, sys
d = sys.argv[1]
import os
cfg = os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config")), "shorts-studio", "config.json")
c = json.load(open(cfg)) if os.path.exists(cfg) else {}
c.update(port=7378, upload_dir=f"{d}/uploads", export_dir=f"{d}/out")
json.dump(c, open(f"{d}/config/shorts-studio/config.json", "w"))
EOF
  if ! curl -sf http://127.0.0.1:7378/api/ping >/dev/null; then
    (cd "$REPO" && XDG_DATA_HOME="$D/data" XDG_CONFIG_HOME="$D/config" SHORTS_PORT=7378 \
      setsid nohup python3 server.py >"$D/server.log" 2>&1 </dev/null &) >/dev/null 2>&1  # never hold the caller's pipe
    for _ in $(seq 20); do curl -sf http://127.0.0.1:7378/api/ping >/dev/null && break; sleep 0.5; done
  fi
  curl -sf http://127.0.0.1:7378/api/ping && echo " instance up; exports go to $D/out; data $D/data"
  ;;
stop)
  # find the server by its environment, never `pkill -f` (the pattern matches this shell too)
  for pid in $(pgrep -f "server.py" || true); do
    tr '\0' '\n' </proc/"$pid"/environ 2>/dev/null | grep -q "SHORTS_PORT=7378" && kill "$pid" && echo "stopped $pid"
  done
  rm -rf "$D/data" "$D/config" "$D/server.log"
  ls "$D/out"/*.mp4 >/dev/null 2>&1 && echo "exports kept in $D/out (copy them out, then rm -rf $D)" || rm -rf "$D"
  ;;
*) echo "usage: $0 start MID... | stop"; exit 1 ;;
esac
