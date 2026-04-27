#!/usr/bin/env bash
# Start mac-graph against a target repo (Linux + macOS).
#
# Usage:
#   ./start.sh                 # index the current directory
#   ./start.sh /path/to/repo   # index a specific repo
#
# Environment overrides (all optional):
#   REPO_DIR   — repo to index (default: $1 or $PWD)
#   DATA_DIR   — KuzuDB + FTS storage (default: $REPO_DIR/.mac-graph-data)
#   WIKI_DIR   — generated wiki output (default: $REPO_DIR/.mac-graph-wiki)
#   PORT       — host port to bind (default: 3030)

set -euo pipefail

REPO_DIR="${REPO_DIR:-${1:-$PWD}}"
REPO_DIR="$(cd "$REPO_DIR" && pwd)"
DATA_DIR="${DATA_DIR:-$REPO_DIR/.mac-graph-data}"
WIKI_DIR="${WIKI_DIR:-$REPO_DIR/.mac-graph-wiki}"
PORT="${PORT:-3030}"

mkdir -p "$DATA_DIR" "$WIKI_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

REPO_DIR="$REPO_DIR" \
DATA_DIR="$DATA_DIR" \
WIKI_DIR="$WIKI_DIR" \
PORT="$PORT" \
docker compose -f "$PROJECT_DIR/docker-compose.yml" -p mac-graph up -d

echo
echo "mac-graph running:"
echo "  http://127.0.0.1:$PORT/health"
echo "  http://127.0.0.1:$PORT/mcp        (Streamable HTTP MCP endpoint)"
echo "  indexing $REPO_DIR"
echo
echo "Stop with: $SCRIPT_DIR/stop.sh"
