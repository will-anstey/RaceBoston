#!/usr/bin/env bash
# Race Boston launcher: fetches dependencies/data if missing, then serves the game.
#
#   ./run.sh            install deps if needed and start on http://localhost:8080
#   ./run.sh --rebuild  re-download OpenStreetMap data and rebuild data/boston.json + terrain.bin
#   PORT=9000 ./run.sh  use a different port
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8080}"

# Prefer a modern Node (18+); fall back to Python for serving.
NODE=""
for n in node /opt/homebrew/bin/node /usr/local/bin/node; do
  if command -v "$n" >/dev/null 2>&1; then
    major=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "${major:-0}" -ge 18 ] 2>/dev/null; then NODE="$(command -v "$n")"; break; fi
  fi
done

need_tools=0
[ "${1:-}" = "--rebuild" ] && need_tools=1
[ -f data/boston.json ] || need_tools=1
[ -f data/terrain.bin ] || need_tools=1
[ -f vendor/three/three.module.js ] || need_tools=1

if [ "$need_tools" = 1 ]; then
  [ -n "$NODE" ] || { echo "Node 18+ is required to fetch dependencies/map data (brew install node)."; exit 1; }
  NPM="$(dirname "$NODE")/npm"
  echo "Installing npm dependencies..."
  PATH="$(dirname "$NODE"):$PATH" "$NPM" install --no-audit --no-fund
  if [ ! -f vendor/three/three.module.js ]; then
    mkdir -p vendor/three
    cp node_modules/three/build/three.module.js node_modules/three/build/three.core.js vendor/three/
    cp node_modules/three/LICENSE vendor/three/LICENSE
    cp node_modules/earcut/src/earcut.js vendor/earcut.js
  fi
  if [ "${1:-}" = "--rebuild" ] || [ ! -f data/boston.json ] || [ ! -f data/terrain.bin ]; then
    echo "Downloading OpenStreetMap data and elevation tiles (a few minutes)..."
    "$NODE" tools/fetch-osm.mjs ${1:+--force}
    "$NODE" tools/fetch-dem.mjs
    "$NODE" tools/build-map.mjs
  fi
fi

URL="http://localhost:$PORT"
echo "Starting Race Boston at $URL  (Ctrl+C to stop)"
( sleep 1.5; command -v open >/dev/null && open "$URL" || command -v xdg-open >/dev/null && xdg-open "$URL" ) >/dev/null 2>&1 &
if [ -n "$NODE" ]; then
  exec "$NODE" tools/serve.mjs "$PORT"
else
  exec python3 -m http.server "$PORT"
fi
