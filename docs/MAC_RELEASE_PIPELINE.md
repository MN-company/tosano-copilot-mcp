# Reliable release pipeline — Tosano Web

## Scope and invariants

This project uses **one existing ChatGPT App** (`asdk_app_6ae8857a20f481919f34fee45f503143`), **one private OpenAI tunnel**, and a Mac-hosted MCP server at `127.0.0.1:3788`. Do not rebuild the App or tunnel when releasing new source. Docker/Windows migration is deliberately postponed.

A release is complete only after these independently verified gates:

1. **Source/SQLite:** syntax and local unit tests pass; the installed dependency graph is locked.
2. **Server:** launchd starts the new immutable release, `/health` reports the correct version, FTS5 is enabled.
3. **Protocol:** real MCP `initialize` and `tools/list` include all required tool names; no purchasing mutation is performed as a health check.
4. **ChatGPT Web:** refresh the existing Tosano Web app's tools from its plugin detail page, start a NEW chat, call `tosano_release_info` and confirm `0.3.1` and `tosano-agent-v3`. This gate **cannot be verified by local deployment alone**.

The installer does NOT publish or refresh ChatGPT App schemas. OpenAI documents the host-side **Refresh** action. Keep App skill and MCP schema changes separately versioned and gated.

## One-time migration to managed service (Mac)

Stop the manually started `npm run start` session first (`Ctrl+C`), but leave `tunnel-client` running. Extract the release ZIP to Downloads, then:

```bash
cd ~/Downloads/tosano-copilot-mcp
bash scripts/deploy-macos.sh --env-from "$HOME/Downloads/tosano-copilot-mcp 2/.env"
```

The first install creates `~/.tosano-copilot/service/`:

- `releases/<semver>-<source-hash>/` — immutable source and installed dependencies.
- `current` — atomically replaced pointer to active release.
- `shared/.env` — local protected config preserved across upgrades; session cookies remain **outside** release directories.
- `shared/package-lock.json` — a stable dependency lock retained when dependencies don't change; initial install resolves it once from the npm registry, subsequent installs use `npm ci`.
- `backups/agent-YYYYMMDD-HHMMSS.sqlite` — SQLite consistent snapshots.
- `logs/` — local launchd stdout/stderr.

The installer installs a user LaunchAgent `com.tosano.copilot`, automatically starting the backend after login and restarting it if it crashes. The OpenAI `tunnel-client` is separate and must still be running. The installed service preserves the existing Chromium profile under `~/.tosano-copilot/browser-profile`, and persisted lists/preferences under `~/.tosano-copilot/agent.sqlite`.

The first deployment downloads npm dependencies on the Mac. **This release archive does not contain `package-lock.json` because the package registry was unreachable in the build environment**; initial installation generates and preserves the lock. Future dependency changes must ship a reviewed lock or the installer will refuse them. The installer never changes `.env` on subsequent releases, never kills unknown processes on port 3788, and never resets the browser session.

## Every subsequent release

1. Stop no services manually; download/extract the release to a NEW Downloads folder.
2. Run `bash scripts/deploy-macos.sh` from that release directory. The script stages files, validates dependency lock, runs tests, snapshots SQLite, safely restarts through launchd and verifies the MCP contract.
3. If health or MCP discovery fails, the script restores the previous `current` source pointer and tries to restart the previous server. Check the return code and logs; **do not assume a rollback succeeded unless the prior health also responds**.
4. Open **ChatGPT Plugins → Tosano Web → Refresh** when tools or metadata changed. Start a new chat and verify `tosano_release_info`. Do not create duplicate plugin identities.

**If an emergency rollback is needed:** `bash scripts/rollback-macos.sh` (from any release checkout). SQLite backups are retained but not automatically restored because that could destroy newer user changes. Any future database migration must be additive and backward-compatible across adjacent releases or require a separately validated data rollback procedure.

## Diagnostics

```bash
curl -s http://127.0.0.1:3788/health
cd ~/.tosano-copilot/service/current
npm run verify:mcp
launchctl print "gui/$(id -u)/com.tosano.copilot"
tail -n 40 ~/.tosano-copilot/service/logs/stderr.log
```

The first two read-only checks confirm the local server. They **do not** verify ChatGPT's cached registered tool schemas. If ChatGPT still exposes only the v0.2 tool list while `verify:mcp` passes with 0.3.1, use the existing App's **Refresh** control and a new chat.

## Permissions

Cart writes default to off. Even when `ALLOW_CART_WRITES=true`, the server enforces a two-step plan, explicit approval, fresh cart fingerprint, price recheck, idempotency and a no-blind-retry policy. Search, onboarding and list writes do not imply checkout consent. No payments, order placement, or delivery scheduling are implemented.

## Cart read endpoint discovery with managed launchd

The one-time `npm run discover-cart` workflow needs exclusive access to the Chromium profile. Since launchd restarts the server automatically, do **not** simply `Ctrl+C` another process. Run:

```bash
cd ~/.tosano-copilot/service/current
bash scripts/discover-cart-macos.sh
```

The helper pauses the managed service, opens the existing authenticated Chromium for discovery, and attempts to restart the server on exit. Do not run it at the same time as a deployment.
