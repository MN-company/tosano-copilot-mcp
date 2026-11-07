# One-time GET cart endpoint discovery in exclusive Docker Chromium with localhost-only noVNC.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
& docker compose stop tosano-tunnel tosano-mcp
if ($LASTEXITCODE -ne 0) { throw 'Could not stop Tosano services' }
try {
  Write-Host 'Open http://127.0.0.1:6080/vnc.html, then open the Tosano CART in Chromium.'
  Write-Host 'Press ENTER in PowerShell after the cart has loaded; only a validated read GET is saved.'
  & docker compose --profile login run --rm --service-ports --no-deps tosano-login bash scripts/login-browser.sh src/discover-cart.mjs
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Cart endpoint discovery did not complete; nothing has been assumed.' }
} finally {
  & docker compose up -d --no-build tosano-mcp tosano-tunnel
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Tosano restart failed; run .\scripts\restart-windows.ps1' }
}
