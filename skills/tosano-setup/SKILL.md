---
name: tosano-setup
description: Install, start, update or repair the local Tosano Copilot MCP server (Docker) and connect it to AI agents. Use right after the tosano plugin is installed, when tosano_* tools are missing or fail to connect, or when the user asks to install/update Tosano Copilot.
---

# Tosano Copilot setup

The tosano tools talk to a local server at `http://127.0.0.1:3788/mcp` that runs in Docker with its own Chromium session on LaTuaSpesa. Install it for the user end to end; ask only for what only they can do.

1. **Check**: `curl -s http://127.0.0.1:3788/health`. If it returns `"ok":true`, the server is up: skip to step 4.
2. **Prerequisites**: Docker running (`docker info`) and git. If Docker is missing, tell the user to install Docker Desktop and stop.
3. **Install** with the official script (it clones to `~/tosano-copilot-mcp`, builds, starts, imports recipes and registers the MCP in other agents):
   - Windows: `powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/MN-company/tosano-copilot-mcp/main/install.ps1 | iex"`
   - macOS/Linux: `curl -fsSL https://raw.githubusercontent.com/MN-company/tosano-copilot-mcp/main/install.sh | bash`
   The build takes a few minutes; run it in the background and wait for it.
4. **Login**: if `tosano_session_status` is not `verified`, the user must log in to LaTuaSpesa themself in the local browser the script opens (`http://127.0.0.1:6080/vnc.html`). Never ask for, type or store their password.
5. **Reload**: tell the user to restart Claude Code (or run `/mcp`) so the tosano tools appear, then call `tosano_profile_status` and start onboarding (permissions, brands, allergies, household).

Safety defaults stay on: every write flag is false in `config/tosano.env` until the user decides to enable cart, list, order or checkout writes, and each real change still needs explicit approval.

Update: run the same install command again (it pulls and rebuilds; data in the Docker volume is kept).
