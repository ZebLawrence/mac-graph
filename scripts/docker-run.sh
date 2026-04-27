#!/usr/bin/env bash
set -euo pipefail

REPO=${1:-$PWD}
PORT=${PORT:-3030}

REPO=$(cd "$REPO" && pwd)
DATA="$REPO/.mac-graph-data"
WIKI="$REPO/.mac-graph-wiki"
mkdir -p "$DATA" "$WIKI"

exec docker run --rm -it \
  --name mac-graph \
  -v "$REPO":/repo:ro \
  -v "$DATA":/data \
  -v "$WIKI":/wiki \
  -p "127.0.0.1:$PORT:3030" \
  mac-graph:latest
