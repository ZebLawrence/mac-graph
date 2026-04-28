#!/usr/bin/env bash
# Stop mac-graph (Linux + macOS).
#
# Uses `docker compose -p mac-graph down` so we don't need the env vars
# set — compose tears down by project name, looking up the running
# container's labels.

set -euo pipefail

docker compose -p mac-graph down "$@"
