#!/usr/bin/env bash
# Records many reference games at once and reports where this engine departs
# from each. Nothing is added to the fixtures: a sweep is for finding
# differences, and only a trace that shows one is worth keeping.
#
#   CW_APPRUN=... XVFB=... tools/upstream/sweep.sh games.txt [out-dir] [jobs]
#
# games.txt: one game per line, `map|fog|days|ai` (see record.sh), # for comments.
set -euo pipefail

LIST="${1:?a file of map|fog|days|ai lines}"
OUT_DIR="${2:-$(mktemp -d)}"
JOBS="${3:-8}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$OUT_DIR"
export OUT_DIR ROOT

grep -v '^\s*\(#\|$\)' "$LIST" | xargs -P "$JOBS" -I{} bash -c '
  IFS="|" read -r map fog days ai <<< "{}"
  name="$(basename "$map" .map | tr " '"'"'" "__")-fog$fog-ai$ai"
  "$ROOT/tools/upstream/record.sh" "$map" "$fog" "$days" "$ai" "$name" > "$OUT_DIR/$name.log" 2>&1 \
    || echo "FAILED to record $map (see $OUT_DIR/$name.log)"
'

echo
for trace in "$OUT_DIR"/*.rec.gz; do
  [ -e "$trace" ] || { echo "no traces were recorded"; exit 1; }
  node "$ROOT/tools/upstream-diff.ts" "$trace" --turns 0 | sed -n '1,3p'
done
echo
echo "traces are in $OUT_DIR"
