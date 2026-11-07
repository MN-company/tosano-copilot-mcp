# Tosano release pipeline — Windows Docker, v0.3.2

The supported Windows Compose stack is independent of WhatsApp Copilot, with two always-on services (MCP and OpenAI tunnel) and one manual login profile. See [`WINDOWS_DOCKER.md`](WINDOWS_DOCKER.md).

Release gates:

1. **Preflight**: Docker daemon running, separate Tosano Compose project, runtime key file exists and correct tunnel ID configured. No access to WhatsApp volumes or containers.
2. **Dependencies**: first deploy generates `package-lock.json` with a temporary Node image; all Docker builds use `npm ci` and pinned Playwright browser/library version. Future dependency changes need a reviewed lock update.
3. **Source**: `docker run ... npm test` and `npm run verify:docker` before cutover.
4. **Data**: consistent SQLite snapshot using Node's SQLite backup API; profile and agent DB on an isolated Docker named volume; never copy live WAL files. Host backup snapshots are local-only and should be protected.
5. **Server**: activate version-tagged Docker image, wait for health matching target version, `tosano-agent-v3` MCP contract, SQLite FTS5.
6. **Protocol**: actual MCP `initialize` plus `tools/list`, verifying the required v3 tool names (no purchase actions). A 200 or 405 alone is insufficient.
7. **Tunnel**: official OpenAI tunnel-client service uses runtime secret file and same preexisting Tosano tunnel; check the tunnel container readiness via `/readyz` before marking the host release deployed, then use a read-only tool call from ChatGPT Web.
8. **ChatGPT**: refresh the *existing* app's registered tool schema if it changed and test in a new ChatGPT conversation. This cannot be done by `docker compose up` or by updating a plugin skill alone.

On failure after cutover, the PowerShell deploy script attempts to restore the previous image tag and verify its health/MCP contract. This only rolls back application code: SQLite schema changes must be backward-compatible; otherwise restore data from a reviewed snapshot with the service stopped.

`restart: unless-stopped` restarts containers when Docker Desktop's Linux engine is available. On Windows 10, Docker Desktop commonly starts on user sign-in; a machine left at the sign-in screen may not start its container engine automatically.

Existing Mac launchd deployment documentation is preserved in [`MAC_RELEASE_PIPELINE.md`](MAC_RELEASE_PIPELINE.md).
