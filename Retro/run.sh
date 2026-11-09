#!/usr/bin/env bash
# Starts the Retro Race Boston server for the Aptiva, using a modern Node
# (18+) even if an old one is first on the PATH.
#
#   ./run.sh            serve on port 8000
#   ./run.sh --rebuild  rebuild the tiles from ../data/boston.json (and the applet, with JDK 11) first
#   PORT=8080 ./run.sh
set -euo pipefail
cd "$(dirname "$0")"

NODE=""
for n in /opt/homebrew/bin/node /usr/local/bin/node node; do
  if command -v "$n" >/dev/null 2>&1; then
    major=$("$n" -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
    if [ "${major:-0}" -ge 18 ] 2>/dev/null; then NODE="$(command -v "$n")"; break; fi
  fi
done
[ -n "$NODE" ] || { echo "Node 18+ is required (brew install node)."; exit 1; }

if [ "${1:-}" = "--rebuild" ] || [ ! -f index.html ]; then
  "$NODE" tools/build.mjs
  tools/compile-applet.sh || echo "(kept the prebuilt RetroRace.class)"
fi
exec "$NODE" serve.mjs "${PORT:-8000}"
