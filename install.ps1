# Tosano Copilot MCP - one-command installer for Windows (PowerShell 5.1+, Docker Desktop).
#   irm https://raw.githubusercontent.com/MN-company/tosano-copilot-mcp/main/install.ps1 | iex
# or, from a clone:  .\install.ps1
# Steps: get the code -> config files -> build and start the MCP container -> recipe database
#        -> LaTuaSpesa login (only if needed) -> register the MCP in every AI agent found.
# It never asks for or stores your LaTuaSpesa password: you log in yourself in a local browser window.
[CmdletBinding()]
param([string]$Dir = "$HOME\tosano-copilot-mcp", [switch]$SkipLogin, [switch]$SkipAgents)
$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/MN-company/tosano-copilot-mcp.git'
function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Native($label) { if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)" } }

Step 'Controllo Docker'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Docker Desktop non trovato: installalo da https://www.docker.com/products/docker-desktop/ e rilancia.' }
docker info *> $null; Native 'Docker non avviato (apri Docker Desktop)'

Step 'Codice sorgente'
if (Test-Path (Join-Path $PSScriptRoot 'compose.yaml') -ErrorAction SilentlyContinue) { $Dir = $PSScriptRoot }
elseif (Test-Path (Join-Path $Dir '.git')) { git -C $Dir pull --ff-only; Native 'git pull' }
else { if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Serve git: https://git-scm.com/download/win' }; git clone $repo $Dir; Native 'git clone' }
Set-Location $Dir
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version

Step 'Configurazione'
if (-not (Test-Path config\tosano.env)) { Copy-Item config\tosano.env.example config\tosano.env; Write-Host 'Creato config\tosano.env (tutte le scritture disattivate).' }
$envFile = Join-Path $Dir '.env'
$envText = if (Test-Path $envFile) { [IO.File]::ReadAllText($envFile) } else { '' }
if ($envText -match '(?m)^TOSANO_IMAGE_TAG=') { $envText = [regex]::Replace($envText, '(?m)^TOSANO_IMAGE_TAG=.*$', "TOSANO_IMAGE_TAG=$version") } else { $envText = $envText.TrimEnd() + "`nTOSANO_IMAGE_TAG=$version`n" }
if ($envText -notmatch '(?m)^CONTROL_PLANE_TUNNEL_ID=') { $envText = $envText.TrimEnd() + "`nCONTROL_PLANE_TUNNEL_ID=not-configured`n" }
[IO.File]::WriteAllText($envFile, $envText.TrimStart())

Step "Build e avvio del server MCP v$version"
docker compose build tosano-mcp; Native 'docker compose build'
docker compose up -d --no-deps tosano-mcp; Native 'docker compose up'
$ok = $false
for ($i = 0; $i -lt 40 -and -not $ok; $i++) { try { $h = Invoke-RestMethod http://127.0.0.1:3788/health -TimeoutSec 3; $ok = $h.ok -and $h.version -eq $version } catch { Start-Sleep 3 } }
if (-not $ok) { throw 'Il server non risponde su http://127.0.0.1:3788/health (docker compose logs tosano-mcp)' }
Write-Host "MCP attivo: http://127.0.0.1:3788/mcp"

Step 'Database ricette (Wikibooks + TheMealDB)'
docker compose exec -T tosano-mcp node -e "import('./src/recipe-db.mjs').then(m=>process.exit(new m.RecipeStore().stats().total>0?0:1))" *> $null
if ($LASTEXITCODE -ne 0) { docker compose exec -T tosano-mcp node src/import-recipes.mjs | Select-Object -Last 1 } else { Write-Host 'Già presente.' }

if (-not $SkipLogin) {
  Step 'Sessione LaTuaSpesa'
  $status = ''
  try {
    $body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tosano_session_status","arguments":{}}}'
    $r = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3788/mcp -ContentType 'application/json' -Headers @{ Accept = 'application/json, text/event-stream' } -Body $body -TimeoutSec 60
    $status = $r.result.content[0].text
  } catch {}
  if ("$status" -match '"authenticatedWithTosano":"verified"') { Write-Host 'Già autenticato.' }
  else { Write-Host 'Si apre il browser locale: accedi a LaTuaSpesa e poi chiudi la finestra.' -ForegroundColor Yellow; & .\scripts\login-windows.ps1 }
}

if (-not $SkipAgents) {
  Step 'Registrazione negli agenti AI (Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI, Codex, LM Studio)'
  if (Get-Command node -ErrorAction SilentlyContinue) { node scripts\register-agents.mjs }
  else { docker run --rm -v "${HOME}:/h" -e TOSANO_HOME_OVERRIDE=/h -e APPDATA=/h/AppData/Roaming -v "${Dir}\scripts:/s:ro" --entrypoint node "tosano-copilot-mcp:$version" /s/register-agents.mjs }
}

Write-Host "`nFatto. Riavvia gli agenti aperti e chiedi: 'cosa c'è in offerta da Tosano?'" -ForegroundColor Green
Write-Host 'Facoltativo, solo per ChatGPT: scripts\set-tunnel-key.ps1 e poi docker compose --profile chatgpt up -d tosano-tunnel (vedi README).'
