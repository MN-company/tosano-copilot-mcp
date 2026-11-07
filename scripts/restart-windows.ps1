[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
& docker compose up -d --no-build tosano-mcp tosano-tunnel
if ($LASTEXITCODE -ne 0) { throw 'Tosano Docker startup failed' }
try {
  $health=Invoke-RestMethod 'http://127.0.0.1:3788/health' -TimeoutSec 5
  Write-Host "Backend running: $($health.version), FTS5=$($health.fts5), MCP=$($health.mcpContract)"
} catch { Write-Warning 'Health endpoint not yet responding; check docker compose logs tosano-mcp' }
Write-Host 'Tunnel status is independent: docker compose logs --tail 40 tosano-tunnel'
