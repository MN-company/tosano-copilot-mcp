# One-time GUI browser login IN the Linux container via a localhost-only noVNC viewer.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
Write-Host 'Temporarily stopping Tosano server and its tunnel, NOT WhatsApp Copilot.'
& docker compose stop tosano-tunnel tosano-mcp
if ($LASTEXITCODE -ne 0) { throw 'Could not stop Tosano services; refusing to share Chromium profile.' }
try {
  Write-Host 'Open http://127.0.0.1:6080/vnc.html on the Windows PC.'
  Write-Host 'Complete login and purchase-context selection, then press ENTER in this PowerShell window.'
  & docker compose --profile login run --rm --service-ports --no-deps tosano-login
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Browser login helper returned an error; state may be incomplete.' }
  Write-Host 'Checking account identity with exclusive access to the saved profile, before server restart.'
  & docker compose run --rm --no-deps --entrypoint node tosano-mcp src/doctor.mjs
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Session doctor did not verify authentication; examine browser context, then retry.' }
} finally {
  Write-Host 'Restarting Tosano MCP and tunnel from Docker Compose.'
  & docker compose up -d --no-build tosano-mcp tosano-tunnel
  if ($LASTEXITCODE -ne 0) { Write-Warning 'Automatic restart failed: run .\scripts\restart-windows.ps1' }
}
Write-Host 'Backend and tunnel restarted. Do not run doctor while MCP holds the Chromium profile.'
