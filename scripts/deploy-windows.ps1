# Deploys only the Tosano Compose project. Does not touch WhatsApp Copilot.
# Run from any directory in PowerShell 5.1+ on Windows 10 (Docker Desktop/WSL2).
[CmdletBinding()]
param([switch]$AllowReplaceImage)
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
$root = (Get-Location).Path
function Must([bool]$ok, [string]$message) { if (-not $ok) { throw $message } }
function CheckExit([string]$label) { if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" } }
function Set-ComposeTag([string]$value) {
  $file = Join-Path $root '.env'
  $text = [IO.File]::ReadAllText($file)
  if ($text -match '(?m)^TOSANO_IMAGE_TAG=') {
    $text = [regex]::Replace($text, '(?m)^TOSANO_IMAGE_TAG=.*$', "TOSANO_IMAGE_TAG=$value")
  } else { $text = $text.TrimEnd() + "`nTOSANO_IMAGE_TAG=$value`n" }
  [IO.File]::WriteAllText($file, $text)
}
function Get-ComposeTag() {
  $raw=[IO.File]::ReadAllText((Join-Path $root '.env'))
  if ($raw -match '(?m)^TOSANO_IMAGE_TAG=([^\r\n]*)') { return $Matches[1].Trim() }
  return ''
}
function Verify-Tunnel() {
  for ($attempt=0; $attempt -lt 35; $attempt++) {
    $id = (& docker compose ps -q tosano-tunnel 2>$null)
    if ($LASTEXITCODE -eq 0 -and $id -and ($id -join '').Trim()) {
      $cid=($id | Select-Object -First 1).Trim()
      $h=(& docker inspect -f '{{.State.Health.Status}}' $cid 2>$null)
      $healthValue=[string]($h | Select-Object -First 1)
      if ($healthValue.Trim() -eq 'healthy') { return $true }
    }
    Start-Sleep -Seconds 3
  }
  return $false
}
function Verify-Release([string]$target) {
  for ($attempt=0; $attempt -lt 25; $attempt++) {
    try {
      $health=Invoke-RestMethod -Uri 'http://127.0.0.1:3788/health' -TimeoutSec 3
      if ($health.version -eq $target -and $health.fts5 -eq $true -and $health.mcpContract -eq 'tosano-agent-v3') {
        & docker compose exec -T tosano-mcp node scripts/verify-mcp.mjs
        CheckExit 'MCP contract verification'
        return $true
      }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}
$manifest=Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version=$manifest.version
Must ($version -match '^\d+\.\d+\.\d+$') 'Invalid version'
Must (Test-Path (Join-Path $root 'Dockerfile')) 'Dockerfile missing'
& docker info --format '{{.ServerVersion}}' | Out-Null
CheckExit 'Docker daemon'
& docker compose version
CheckExit 'Docker Compose'
if (-not (Test-Path '.env')) { Copy-Item 'compose.env.example' '.env' }
if (-not (Test-Path 'config/tosano.env')) { Copy-Item 'config/tosano.env.example' 'config/tosano.env' }
Must (Test-Path 'secrets/openai-runtime-key.txt') 'Missing secrets/openai-runtime-key.txt. Run: .\scripts\set-tunnel-key.ps1'
Must ((Get-Item 'secrets/openai-runtime-key.txt').Length -gt 12) 'Runtime key file is empty or too short'
Must ([IO.File]::ReadAllText((Join-Path $root '.env')) -match 'CONTROL_PLANE_TUNNEL_ID=tunnel_[a-z0-9]{32}') 'Tunnel ID missing or invalid in .env'
$previous=Get-ComposeTag
$priorImagePresent = $false
if ($previous) {
  $priorMatches = @(& docker image ls --quiet --filter "reference=tosano-copilot-mcp:$previous")
  CheckExit 'Previous image lookup'
  $priorImagePresent = $priorMatches.Count -gt 0
}
$targetImage="tosano-copilot-mcp:$version"
Write-Host "Preparing isolated Tosano Docker release $version; old tag=$previous"
# npm's package-lock.json can include property names that collide in Windows
# PowerShell 5.1 ConvertFrom-Json (case-insensitive PSObject keys). Let Node parse
# npm's own JSON instead. Inspect without modifying an existing lock file.
$lockStatus = (& docker run --rm -v "${root}:/work" -w /work node:22.16.0-bookworm node scripts/lock-status.mjs)
CheckExit 'Dependency lock inspection'
$lockStatus = ([string]($lockStatus | Select-Object -Last 1)).Trim()
Must (@('current','stale','invalid','missing') -contains $lockStatus) "Unknown dependency lock status: $lockStatus"
if ($lockStatus -eq 'invalid') {
  New-Item -ItemType Directory -Path 'backups' -Force | Out-Null
  $backupName = 'backups/package-lock.invalid-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json'
  Move-Item -LiteralPath 'package-lock.json' -Destination $backupName
  Write-Warning "Invalid npm lockfile backed up to $backupName. Regenerating."
}
if ($lockStatus -ne 'current') {
  Write-Host "Updating dependency lock with npm (detected: $lockStatus)."
  & docker run --rm -v "${root}:/work" -w /work node:22.16.0-bookworm sh -c 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund'
  CheckExit 'Dependency lock generation'
}
Must (Test-Path 'package-lock.json') 'package-lock.json was not generated'
$lockAfter = (& docker run --rm -v "${root}:/work" -w /work node:22.16.0-bookworm node scripts/lock-status.mjs)
CheckExit 'Post-generation dependency lock verification'
Must (([string]($lockAfter | Select-Object -Last 1)).Trim() -eq 'current') 'Dependency lockfile is still not consistent with package.json'
# A missing image on first installation is normal. Docker image inspect would
# print a native stderr error that PowerShell 5 treats as terminating under Stop.
$existing = @(& docker image ls --quiet --filter "reference=$targetImage")
CheckExit 'Docker image lookup'
if ($existing.Count -gt 0 -and -not $AllowReplaceImage) {
  throw "Docker image $targetImage already exists. Cannot verify whether it matches these source files. Use -AllowReplaceImage only after reviewing the target image and preserving a rollback copy."
} else {
  & docker build --pull -t $targetImage -f Dockerfile .
  CheckExit 'Docker image build'
}
& docker run --rm --entrypoint npm $targetImage test
CheckExit 'Unit tests'
& docker run --rm --entrypoint npm $targetImage run verify:docker
CheckExit 'Docker wiring tests'

# Take a consistent online SQLite backup, never copy active -wal/-shm files.
$oldContainer = (& docker compose ps -q tosano-mcp 2>$null)
if ($LASTEXITCODE -eq 0 -and $oldContainer -and ($oldContainer -join '').Trim()) {
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
  $dest="/home/pwuser/.tosano-copilot/backups/pre-$version-$stamp.sqlite"
  & docker compose exec -T tosano-mcp node scripts/backup-db.mjs $dest
  CheckExit 'Pre-deployment SQLite backup'
  $containerId=($oldContainer | Select-Object -First 1).Trim()
  New-Item -ItemType Directory -Force 'backups' | Out-Null
  $hostFile=Join-Path $root "backups\pre-$version-$stamp.sqlite"
  & docker cp ('{0}:{1}' -f $containerId,$dest) $hostFile
  if ($LASTEXITCODE -ne 0) { Write-Warning 'No existing DB snapshot copied: database may not exist yet.' }
}
$changedTag = $previous -ne $version
try {
  Set-ComposeTag $version
  & docker compose config -q
  CheckExit 'Compose configuration'
  & docker compose up -d --no-build tosano-mcp tosano-tunnel
  CheckExit 'Compose startup'
  if (-not (Verify-Release $version)) { throw "Release $version did not pass health/MCP verification" }
  if (-not (Verify-Tunnel)) { throw 'OpenAI tunnel did not become ready; verify runtime API key and tunnel permission' }
  Write-Host "DEPLOYMENT PASS: Tosano MCP $version, FTS5, MCP tool discovery AND tunnel readiness." -ForegroundColor Green
  Write-Host 'NEXT: Docker login if needed; then verify Tosano Web tools from ChatGPT.'
} catch {
  $failure=$_.Exception.Message
  Write-Warning "Deployment failed: $failure"
  if ($priorImagePresent -and $previous -and $previous -ne $version) {
    Set-ComposeTag $previous
    & docker compose up -d --no-build tosano-mcp tosano-tunnel
    if ($LASTEXITCODE -eq 0 -and (Verify-Release $previous) -and (Verify-Tunnel)) {
      Write-Warning "ROLLBACK VERIFIED: restored Tosano $previous"
    } else { Write-Warning 'ROLLBACK COULD NOT BE VERIFIED. Inspect the Tosano service manually.' }
  } else {
    Write-Warning 'No earlier version to restore; this stack remains in need of inspection.'
  }
  throw "Tosano deployment did not complete: $failure"
}
