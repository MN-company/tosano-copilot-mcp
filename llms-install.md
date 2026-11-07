# Tosano Copilot MCP — instructions for AI agents

This repository is a local MCP server for grocery shopping on LaTuaSpesa / IperTosano.

## Installing for the user ("installa Tosano Copilot")

Follow `skills/tosano-setup/SKILL.md`. Short version:

- Windows: `powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/MN-company/tosano-copilot-mcp/main/install.ps1 | iex"`
- macOS/Linux: `curl -fsSL https://raw.githubusercontent.com/MN-company/tosano-copilot-mcp/main/install.sh | bash`

The script builds and starts the Docker server, imports the recipe database and registers the MCP endpoint `http://127.0.0.1:3788/mcp` in every agent it finds (Claude Code, Claude Desktop, Cursor, VS Code Copilot, Windsurf, Gemini CLI, Codex CLI, LM Studio). The user logs in to LaTuaSpesa themself in a local browser window: never ask for their password.

Manual registration, if needed:

| Agent | Config |
|---|---|
| Claude Code | `claude mcp add --transport http -s user tosano http://127.0.0.1:3788/mcp` or the plugin: `/plugin marketplace add MN-company/tosano-copilot-mcp` then `/plugin install tosano@tosano-copilot` |
| Cursor | `~/.cursor/mcp.json` → `{"mcpServers":{"tosano":{"url":"http://127.0.0.1:3788/mcp"}}}` |
| VS Code | user `mcp.json` → `{"servers":{"tosano":{"type":"http","url":"http://127.0.0.1:3788/mcp"}}}` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` → `serverUrl` |
| Gemini CLI | `~/.gemini/settings.json` → `{"mcpServers":{"tosano":{"httpUrl":"http://127.0.0.1:3788/mcp"}}}` |
| Codex CLI | `~/.codex/config.toml` → `[mcp_servers.tosano]` `url = "http://127.0.0.1:3788/mcp"` |
| Claude Desktop | `npx -y mcp-remote http://127.0.0.1:3788/mcp --allow-http` |
| ChatGPT | OpenAI Secure MCP Tunnel (`scripts/set-tunnel-key.ps1`, then `docker compose up -d tosano-tunnel`) |

## Using the tools

Read `skills/tosano-shopping/SKILL.md` before shopping. Non-negotiable rules: real changes to cart, orders and checkout go through prepare → show summary → explicit user approval → commit once; never retry an uncertain write; never call a product "safe" for an allergy; never invent recipes.

## Developing

`npm ci`, `npm run check`, `npm test` (Node 22.13+; POSIX permission tests fail on Windows hosts, run the suite in the Docker image). Never commit `.env`, `config/tosano.env`, `secrets/` or `*.sqlite`.
