#!/usr/bin/env bash
# Temporarily pause the managed Tosano service to give Playwright sole access
# to its persistent browser profile; always attempt to restart on exit.
set -Eeuo pipefail
ROOT="${TOSANO_DEPLOY_ROOT:-$HOME/.tosano-copilot/service}"
PLIST="$HOME/Library/LaunchAgents/com.tosano.copilot.plist"
LABEL='com.tosano.copilot'
[[ "$(uname -s)" == 'Darwin' ]] || { echo 'macOS only' >&2; exit 2; }
[[ -L "$ROOT/current" ]] || { echo 'No managed Tosano deployment found.' >&2; exit 2; }
if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo 'Managed service not loaded. Check the deployment instead.' >&2; exit 2
fi
RESTORE=1
restart() {
  if [[ "$RESTORE" == '1' ]]; then
    echo 'Restarting Tosano service...'
    launchctl bootstrap "gui/$(id -u)" "$PLIST" || echo 'Restart failed; check launchd and logs.' >&2
  fi
}
trap restart EXIT
launchctl bootout "gui/$(id -u)" "$PLIST"
for _ in {1..12}; do
  if ! lsof -nP -iTCP:3788 -sTCP:LISTEN | grep -q 'LISTEN'; then break; fi
  sleep 1
done
if lsof -nP -iTCP:3788 -sTCP:LISTEN | grep -q 'LISTEN'; then
  echo 'The old server still occupies port 3788; profile may still be locked. Aborting discovery.' >&2
  exit 3
fi
cd "$ROOT/current"
node --env-file="$ROOT/shared/.env" src/discover-cart.mjs
