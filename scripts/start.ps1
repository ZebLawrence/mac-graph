# Start mac-graph against a target repo (Windows / PowerShell).
#
# Usage:
#   .\start.ps1                              # index the current directory
#   .\start.ps1 -RepoDir C:\path\to\repo     # index a specific repo
#   .\start.ps1 -Port 4040
#
# All parameters are optional.

param(
    [string]$RepoDir = $PWD.Path,
    [string]$DataDir,
    [string]$WikiDir,
    [int]$Port = 3030
)

$ErrorActionPreference = "Stop"

$RepoDir = (Resolve-Path -LiteralPath $RepoDir).Path
if (-not $DataDir) { $DataDir = Join-Path $RepoDir ".mac-graph-data" }
if (-not $WikiDir) { $WikiDir = Join-Path $RepoDir ".mac-graph-wiki" }

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
New-Item -ItemType Directory -Force -Path $WikiDir | Out-Null

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

$env:REPO_DIR = $RepoDir
$env:DATA_DIR = $DataDir
$env:WIKI_DIR = $WikiDir
$env:PORT     = $Port

docker compose -f (Join-Path $ProjectDir "docker-compose.yml") -p mac-graph up -d
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "mac-graph running:"
Write-Host "  http://127.0.0.1:$Port/health"
Write-Host "  http://127.0.0.1:$Port/mcp        (Streamable HTTP MCP endpoint)"
Write-Host "  indexing $RepoDir"
Write-Host ""
Write-Host "Stop with: $ScriptDir\stop.ps1"
