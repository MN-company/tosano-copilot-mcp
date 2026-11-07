# Optional manual read-only API discovery; stops only the Tosano Compose services.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
& docker compose stop tosano-tunnel tosano-mcp
if ($LASTEXITCODE -ne 0) { throw 'Could not stop Tosano services' }
try {
  Write-Host 'Open http://127.0.0.1:6080/vnc.html on THIS Windows PC.'
  Write-Host 'Visit only read screens (site lists, slots, order history); do not place orders or edit data.'
  & docker compose --profile login run --rm --service-ports --no-deps tosano-login bash scripts/login-browser.sh src/discover-site.mjs
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Read-only site API discovery did not finish.' }
} finally {
  & docker compose up -d --no-build tosano-mcp tosano-tunnel
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Tosano restart failed. Run .\scripts\restart-windows.ps1' }
}
