#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ "$(uname -s)" == 'Darwin' ]] || { echo 'macOS only'; exit 2; }
ROOT="${TOSANO_DEPLOY_ROOT:-$HOME/.tosano-copilot/service}"
PLIST="$HOME/Library/LaunchAgents/com.tosano.copilot.plist"
PREVIOUS="$(cat "$ROOT/shared/previous-release.txt" 2>/dev/null || true)"
[[ -n "$PREVIOUS" && -d "$PREVIOUS" ]] || { echo 'No previous release recorded.' >&2; exit 2; }
CURRENT="$(readlink "$ROOT/current")"
[[ "$CURRENT" != "$PREVIOUS" ]] || { echo 'Previous version is already selected.'; exit 0; }
launchctl bootout "gui/$(id -u)" "$PLIST"
node "$(dirname "$0")/atomic-link.mjs" "$ROOT/current" "$PREVIOUS"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
printf '%s\n' "$CURRENT" > "$ROOT/shared/previous-release.txt"
# Test previous source independently: it might not have the new release contract.
if curl --fail --silent --max-time 5 http://127.0.0.1:3788/health >/dev/null; then
  echo "ROLLBACK COMPLETE: $(basename "$PREVIOUS") (health responding)"
else
  echo 'Rollback selected, but service health has not been confirmed; inspect logs.' >&2;exit 3
fi
