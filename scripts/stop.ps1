# Stop mac-graph (Windows / PowerShell).
#
# Uses `docker compose -p mac-graph down` so we don't need env vars
# set — compose tears down by project name.

$ErrorActionPreference = "Stop"

docker compose -p mac-graph down @args
if ($LASTEXITCODE -ne 0) { throw "docker compose down failed (exit $LASTEXITCODE)" }
