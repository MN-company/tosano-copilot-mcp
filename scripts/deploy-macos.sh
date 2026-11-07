#!/usr/bin/env bash
# macOS only. Immutable releases, tested staging, persistent private state,
# launchd managed restart, server-side MCP contract validation, rollback.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
ROOT="${TOSANO_DEPLOY_ROOT:-$HOME/.tosano-copilot/service}"
LABEL='com.tosano.copilot'
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ENV_FROM=""
if [[ "${1:-}" == '--env-from' ]]; then
  [[ $# -eq 2 ]] || { echo 'Usage: bash scripts/deploy-macos.sh [--env-from /full/path/.env]' >&2; exit 2; }
  ENV_FROM="$2"
elif [[ $# -gt 0 ]]; then
  echo 'Usage: bash scripts/deploy-macos.sh [--env-from /full/path/.env]' >&2; exit 2
fi
if [[ "$(uname -s)" != 'Darwin' ]]; then echo 'This installer is for macOS launchd only.' >&2; exit 2; fi
for cmd in node npm rsync launchctl lsof curl; do command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 2; }; done
NODE_PATH="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 13) )); then echo 'Node 22.13+ required' >&2; exit 2; fi
VERSION="$(node -p "require('$SOURCE_DIR/package.json').version")"
HASH="$(node -e 'const fs=require("fs"),crypto=require("crypto");const dir=process.argv[1];const h=crypto.createHash("sha256");for(const f of ["package.json","src/server.mjs","src/agent-db.mjs","src/release-contract.mjs"])h.update(fs.readFileSync(dir+"/"+f));console.log(h.digest("hex").slice(0,12))' "$SOURCE_DIR")"
RELEASE="$ROOT/releases/${VERSION}-${HASH}"
mkdir -p "$ROOT/releases" "$ROOT/shared" "$ROOT/logs" "$ROOT/backups"
chmod 700 "$ROOT" "$ROOT/shared" "$ROOT/logs" "$ROOT/backups"

if [[ ! -f "$ROOT/shared/.env" ]]; then
  if [[ -z "$ENV_FROM" && -f "$SOURCE_DIR/.env" ]]; then ENV_FROM="$SOURCE_DIR/.env"; fi
  if [[ -z "$ENV_FROM" && -f "$HOME/Downloads/tosano-copilot-mcp 2/.env" ]]; then ENV_FROM="$HOME/Downloads/tosano-copilot-mcp 2/.env"; fi
  if [[ -z "$ENV_FROM" || ! -f "$ENV_FROM" ]]; then
    echo 'Missing .env; supply --env-from /full/path/to/existing/.env (do not paste credentials).' >&2;exit 2
  fi
  cp "$ENV_FROM" "$ROOT/shared/.env"
  chmod 600 "$ROOT/shared/.env"
  echo 'Protected existing .env copied to persistent shared directory.'
fi
chmod 600 "$ROOT/shared/.env"
# Existing secure tunnel currently forwards 127.0.0.1:3788.
if [[ "$(node --env-file="$ROOT/shared/.env" -e 'console.log(process.env.PORT||"3788")')" != '3788' ]]; then
  echo 'PORT must be 3788 for the existing tunnel; refusing deploy.' >&2;exit 2
fi

# Never touch an unmanaged server. Stop the old manual "npm run start" first.
MANAGED=0
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then MANAGED=1; fi
if (( MANAGED == 0 )) && lsof -nP -iTCP:3788 -sTCP:LISTEN | grep -q 'LISTEN'; then
  echo 'Port 3788 is occupied by a manually started server. Stop it with Ctrl+C, then rerun. Nothing was changed.' >&2
  exit 3
fi

# Immutable release: stage in a new folder, never rsync into a live service.
if [[ -e "$RELEASE" ]]; then
  echo "Release already staged: $RELEASE"
else
  mkdir -p "$RELEASE"
  rsync -a --exclude='.env' --exclude='node_modules' --exclude='.git' --exclude='*.sqlite*' "$SOURCE_DIR/" "$RELEASE/"
fi
cd "$RELEASE"
if [[ ! -e .env ]]; then ln -s "$ROOT/shared/.env" .env; fi
if [[ ! -f package-lock.json ]]; then
  if [[ -f "$ROOT/shared/package-lock.json" ]]; then
    node scripts/adopt-lock.mjs "$ROOT/shared/package-lock.json" "$RELEASE/package-lock.json"
  else
    echo 'First deployment: obtaining dependency lock from npm registry; it will be reused for subsequent releases.'
    npm install --package-lock-only --ignore-scripts --no-audit --no-fund
  fi
fi
# A missing lock is fatal, and installations always use npm ci.
[[ -f package-lock.json ]] || { echo 'Dependency lock unavailable; refusing deployment.' >&2; exit 4; }
npm ci --no-audit --no-fund
npm run check
npm test

PREVIOUS=''
if [[ -L "$ROOT/current" ]]; then PREVIOUS="$(readlink "$ROOT/current")"; fi
if [[ "$PREVIOUS" == "$RELEASE" ]]; then
  echo "This exact release is already selected: $RELEASE"
  node --env-file="$ROOT/shared/.env" scripts/verify-mcp.mjs
  exit 0
fi
# Backup SQLite before any cutover. Never copy a live WAL database via cp.
if [[ -f "$HOME/.tosano-copilot/agent.sqlite" ]]; then
  node scripts/backup-db.mjs "$ROOT/backups/agent-$(date +%Y%m%d-%H%M%S).sqlite"
fi

# Write launchd service with stable paths, not version-specific paths.
node scripts/write-launch-agent.mjs "$PLIST" "$ROOT" "$NODE_PATH"
if (( MANAGED == 1 )); then launchctl bootout "gui/$(id -u)" "$PLIST" || { echo 'Could not stop managed service; no cutover performed.' >&2;exit 5; }; fi
for _ in {1..12}; do
  if ! lsof -nP -iTCP:3788 -sTCP:LISTEN | grep -q 'LISTEN'; then break; fi
  sleep 1
done
if lsof -nP -iTCP:3788 -sTCP:LISTEN | grep -q 'LISTEN'; then
  echo 'Port 3788 did not become free; no cutover performed. Restoring previous service where possible.' >&2
  if (( MANAGED == 1 )); then launchctl bootstrap "gui/$(id -u)" "$PLIST" || true; fi
  exit 5
fi
node scripts/atomic-link.mjs "$ROOT/current" "$RELEASE"
RECOVERED=0
if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
  for _ in {1..18}; do
    if node --env-file="$ROOT/shared/.env" scripts/verify-mcp.mjs >/dev/null 2>&1; then
      printf '%s\n' "$PREVIOUS" > "$ROOT/shared/previous-release.txt"
      cp "$RELEASE/package-lock.json" "$ROOT/shared/package-lock.json"
      chmod 600 "$ROOT/shared/package-lock.json"
      echo "DEPLOYMENT PASS: Tosano Copilot $VERSION, FTS5 and MCP tools verified at 127.0.0.1:3788"
      echo 'NEXT: Refresh Tosano Web tools in ChatGPT. This is a SEPARATE host-side check, not completed by installing local code.'
      exit 0
    fi
    sleep 1
  done
fi
# Auto-rollback code only; DB backup is preserved for manual recovery if future schema changes.
echo 'DEPLOYMENT FAILED: release does not pass health and MCP contract. Rolling back.' >&2
launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
  node scripts/atomic-link.mjs "$ROOT/current" "$PREVIOUS"
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && RECOVERED=1 || true
else
  rm -f "$ROOT/current"
fi
if (( RECOVERED == 1 )); then echo 'Previous source restored; verify logs and health.' >&2; fi
echo "Last logs: $ROOT/logs/stderr.log" >&2
exit 6
