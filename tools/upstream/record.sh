#!/usr/bin/env bash
# Records a reference game with the real Commander Wars and stores it as a
# fixture for the differential test. See docs/upstream-differential.md.
#
#   CW_APPRUN=/path/to/squashfs-root/AppRun \
#   tools/upstream/record.sh "maps/2_player/Agitated.map" [fog=0] [days=15] [ai=2] [name]
#
# fog: 0 off, 1 fog of war, 2 shroud, 3 mist.   ai: 1 very easy, 2 normal, 5 heavy.
# Needs an X server the game can draw to; Xvfb is used if it is on PATH or in $XVFB.
set -euo pipefail

MAP="${1:?map path below the Commander Wars root, e.g. maps/2_player/Agitated.map}"
FOG="${2:-0}"
DAYS="${3:-15}"
AI="${4:-2}"
NAME="${5:-$(basename "$MAP" .map | tr ' ' '_')-fog$FOG-ai$AI}"
MOVEVISION="${MOVEVISION:-false}"
TRANSPORTERREFRESH="${TRANSPORTERREFRESH:-false}"
TIMEOUT="${TIMEOUT:-900}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${CW_APPRUN:?set CW_APPRUN to the AppRun of an unpacked Commander Wars AppImage (see docs/upstream-differential.md)}"
XVFB="${XVFB:-$(command -v Xvfb || true)}"
[ -n "$XVFB" ] || { echo "no Xvfb: put it on PATH or set XVFB (nix build nixpkgs#xorg.xvfb)" >&2; exit 1; }

WORK="$(mktemp -d)"
DISPLAY_NUM=$((200 + RANDOM % 700))
"$XVFB" ":$DISPLAY_NUM" -screen 0 1280x800x24 -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null || true; rm -rf "$WORK"' EXIT

sed -e "s|@MAPDIR@|$(dirname "$MAP")/|" -e "s|@MAPFILE@|$(basename "$MAP")|" \
    -e "s|@FOG@|$FOG|" -e "s|@DAYS@|$DAYS|" -e "s|@AI@|$AI|" \
    -e "s|@MOVEVISION@|$MOVEVISION|" -e "s|@TRANSPORTERREFRESH@|$TRANSPORTERREFRESH|" \
    "$ROOT/tools/upstream/init.template.js" > "$WORK/init.js"

# The game announces the end of the match in its console log but does not exit
# in headless mode, so it is stopped once the marker appears. TIMEOUT bounds a
# hang; a game stopped early still leaves a usable record.
(cd "$(dirname "$CW_APPRUN")" && DISPLAY=":$DISPLAY_NUM" exec "$CW_APPRUN" \
    --noUi --noAudio --userPath "$WORK/" >"$WORK/run.log" 2>&1) &
GAME_PID=$!
FINISHED=0
for ((waited = 0; waited < TIMEOUT; waited++)); do
  if grep -aq "IRON-ACCORD: game over" "$WORK/console.log" 2>/dev/null; then FINISHED=1; break; fi
  kill -0 "$GAME_PID" 2>/dev/null || break
  sleep 1
done
sleep 2   # let the final map state reach the file
pkill -P "$GAME_PID" 2>/dev/null || true
kill "$GAME_PID" 2>/dev/null || true
wait "$GAME_PID" 2>/dev/null || true
[ "$FINISHED" = 1 ] || echo "the game did not reach its turn limit within ${TIMEOUT}s; keeping what was recorded" >&2

REC="$(ls "$WORK"/data/records/*.rec 2>/dev/null | head -1 || true)"
[ -n "$REC" ] || { echo "no record was written; last console lines:" >&2; tail -5 "$WORK/console.log" >&2 || true; exit 1; }

OUT="$ROOT/test/fixtures/upstream/$NAME.rec.gz"
node "$ROOT/tools/upstream-diff.ts" --trim "$REC" "$OUT" \
    --fog "$FOG" --ai "$AI" --days "$DAYS" --map "$MAP" \
    --moveVision "$MOVEVISION" --transporterRefresh "$TRANSPORTERREFRESH"
node "$ROOT/tools/upstream-diff.ts" "$OUT"
