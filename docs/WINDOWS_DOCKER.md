# Tosano Copilot 0.3.8 — deploy on the Windows 10 machine

## What this does and does not do

The **existing** app is `asdk_app_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. Its OpenAI Secure MCP Tunnel is `tunnel_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. Neither requires recreation. WhatsApp Copilot stays in **its own** Compose stack, with its own tunnel and database. This project installs **Tosano MCP + Tosano tunnel** in a separate Compose project, all containerized and restarted on Docker daemon restart.

- Services: `tosano-mcp` (Node.js 22 + Chromium/Playwright + SQLite FTS5) and `tosano-tunnel` (official `ghcr.io/openai/tunnel-client:v0.0.19`).
- One-time login service `tosano-login` uses a temporary graphical Chromium via a loopback-only noVNC viewer. It is **not started normally**.
- `tosano_state` Docker named volume holds Chromium profile, local SQLite preferences/lists, context, and cart-read route; not in the app image or source checkout. **Never run two Chromiums against this profile.**
- OpenAI runtime key is a local gitignored file mounted as a Compose secret in the **tunnel only**. It does not enter `tosano-mcp` environment or Node application.
- `127.0.0.1:3788` is visible only from the Windows host, not the LAN; `127.0.0.1:6080` exists only for the interactive login session. The tunnel needs **outbound 443**, not public inbound ports.
- ChatGPT Web tools stay tied to the existing `Tosano Web` app. Server-side changes **do not automatically refresh** a previously registered ChatGPT tool schema; verify with `tosano_release_info` in a NEW chat.

## Prerequisites

Windows 10 with Docker Desktop Linux containers + WSL2 **already working** (as in your WhatsApp setup); SSH and Tailscale can stay on the host. Windows Docker Desktop may require the Windows user to log in for the Docker Desktop engine to start. Docker restart policies do not independently start Docker Desktop before user login. Ensure Docker Desktop starts with Windows sign-in.

### First-time setup on Windows (PowerShell)

1. Copy/extract the supplied `tosano-copilot-mcp-v0.3.8-audited.zip` into an independent directory, for example `C:\services\tosano-copilot` (the archive has a `tosano-copilot-mcp` wrapper). **Do not** place it inside the WhatsApp Copilot directory.
2. Open PowerShell inside `tosano-copilot-mcp`. Use the **same existing tunnel ID**, as provided in `.env` example. Do **not** install or run a second tunnel on Mac for this ID after cutover.
3. Provide the OpenAI Runtime API Key (Tunnels **Read + Use** permission). This is the existing/new *runtime* key, NOT an admin key; no key gets sent to ChatGPT or included in the ZIP:

```powershell
.\scripts\set-tunnel-key.ps1
```

4. Install (the first build generates `package-lock.json` using an ephemeral official Node image if no lock is packaged, then pins subsequent dependency installs with `npm ci`):

```powershell
.\scripts\deploy-windows.ps1
```

The first deployment produces the health/MCP check results. It can start the tunnel while the Tosano site session is still unauthenticated. Check status:

```powershell
Invoke-RestMethod http://127.0.0.1:3788/health
docker compose ps
docker compose logs --tail 40 tosano-tunnel
```

Expected `health.version = 0.3.8`, `mcpContract = tosano-agent-v3`, `fts5 = true`. MCP `initialize` and `tools/list` are checked in the deploy script, not inferred from an HTTP 200 response.

## First login inside Docker Linux (ONE TIME, no Mac profile copy)

**Stop the Mac's Tosano tunnel** for this tunnel ID before Windows cutover. Don't stop the WhatsApp tunnel.

```powershell
.\scripts\login-windows.ps1
```

The script stops only Tosano services and starts a temporary graphical Chromium in Docker. While it is running, open this URL **on the Windows host**:

`http://127.0.0.1:6080/vnc.html`

Login directly to LaTuaSpesa in the Chromium window, choose the pickup context/time slot and search a product to capture the context hash. Return to the PowerShell console and press **Enter**, which closes Chromium cleanly and saves the profile. The script then restarts Tosano MCP and its tunnel, verifies account identity via the site's API, and prints **no credentials**. If the webpage is blank, inspect login-service logs before retrying.

If working from the Mac over Tailscale/SSH, use an SSH local forward (replace the SSH account and Tailscale hostname with your real values):

```sh
ssh -L 6080:127.0.0.1:6080 WINDOWS_USER@WINDOWS_TAILSCALE_HOST
```

Then use `http://127.0.0.1:6080/vnc.html` on the Mac **while that SSH tunnel is active**. Never publish noVNC openly or leave its login container running permanently.

## Optional: discover the real cart-read endpoint

Until the original site's **actual GET cart route** has been observed, `tosano_get_cart` may not return a fresh cart, and writes stay off. This one-time procedure safely pauses the MCP server, runs the original cart route observer in the same graphical Docker browser, and restarts the MCP server and tunnel:

```powershell
.\scripts\discover-cart-windows.ps1
```

In `http://127.0.0.1:6080/vnc.html`, open the Tosano **carrello** page in Chromium, then press Enter in PowerShell. Only a response matching the expected cart schema is persisted. Do not assume a guessed API URL is correct.

## Migration of Mac SQLite data (optional but recommended)

On the Mac, while the old server is still available, create a **consistent** agent SQLite snapshot:

```sh
cd ~/.tosano-copilot/service/current
node scripts/backup-db.mjs "$HOME/Desktop/tosano-agent.sqlite"
```

Transfer only `tosano-agent.sqlite` privately over Tailscale/SSH to `C:\services\tosano-copilot\tosano-copilot-mcp\migration\agent.sqlite`. Do **not** transfer the Mac Chromium profile, cookies, `JSESSIONID`, or secret files. The new container requires a fresh site login.

When importing a database, stop the Tosano services first:

```powershell
docker compose stop tosano-tunnel tosano-mcp
docker compose run --rm --no-deps -v "${PWD}\migration:/import:ro" --entrypoint node tosano-mcp scripts/import-db.mjs /import/agent.sqlite
.\scripts\restart-windows.ps1
```

This import validates SQLite integrity and expected schema and creates a backup of the existing Windows database when present. Run it **before** adding new lists on Windows; an import replaces the existing agent database, and cannot merge two independent histories automatically.

## Normal operation and updates

Windows Docker Desktop must be running. Both containers use `restart: unless-stopped`. SSH and Tailscale are only for private administration; they are *not* required in the ChatGPT tunnel path.

```powershell
.\scripts\restart-windows.ps1
# Show status
docker compose ps
# Check logs
docker compose logs --tail 60 tosano-mcp
docker compose logs --tail 60 tosano-tunnel
```

For future releases, extract into the **same project directory** without overwriting `secrets/`, `config/tosano.env`, `.env`, `migration/`, `backups/`, or `package-lock.json`, and run `deploy-windows.ps1`. Every new release must have a **new semantic version**. The script:

1. Builds a version-tagged image, fails if dependencies cannot be resolved.
2. Runs source tests and Docker static checks **before** stopping the old service.
3. Takes an online-consistent SQLite backup when an old server is running; it also copies the snapshot to local `backups/` (protect this directory).
4. Switches the Tosano Compose image, waits for `/health` and verifies the **actual MCP** `tools/list` against the required v3 tool names.
5. If those checks fail, restores the previously tagged image and verifies the rollback. It does **not** automatically roll back SQLite migrations: DB changes must remain backward-compatible, or require a separate reviewed data rollback.

The ChatGPT App's cached tool catalog is a **separate** verification gate. The backend pipeline **cannot** force ChatGPT to refresh registered tool metadata. Do not declare the Web rollout complete until `Tosano Web` actually calls `tosano_release_info` and sees the new backend and tools.

## Known constraints and security

- No order placement or checkout tools. Cart modifications remain **disabled** until `ALLOW_CART_WRITES=true`, live cart GET endpoint verified, and a separate explicit two-stage approval has been tested. Leave it false during migration.
- Site product labels can lack ingredients and allergens; unknown is never considered safe.
- A Docker named volume is private to the local Docker Desktop VM, but not a substitute for host disk encryption. Backups contain purchase preferences; keep them restricted and do not share them.
- The published Microsoft Playwright image is intended primarily for testing and development; the target site is restricted to the user's own authenticated session. Browser binaries and Node dependency versions are pinned as far as possible. In this release `package-lock.json` must be generated on the Windows machine because npm registry access was unavailable in the authoring environment.
- Only run the Windows `tosano-tunnel` for this tunnel ID during cutover. Do not launch both the Mac and Windows tunnel with the **same** ID simultaneously.
- No direct access to the Windows host is available in this chat: the code and scripts have been statically checked locally, **not** installed or exercised on the user's Windows Docker daemon.

## v0.3.6 Windows first-install fixes

This hotfix corrects the first deployment failure when the version-tagged image does not
yet exist. A missing image is now treated as expected and a Docker build is started.
It also removes `node --env-file=.env` from all Docker entrypoints: Docker Compose's
`env_file: config/tosano.env` supplies environment variables, so an in-image `.env`
is neither needed nor copied. Lockfile metadata is updated on version changes.

If you already started v0.3.2 and generated `package-lock.json`, **keep it**.
Unpack the hotfix over the project directory without overwriting `.env`, `config/tosano.env`,
`secrets`, or persistent data; none are included in the archive. Then run
`.\scripts\deploy-windows.ps1` from PowerShell in that folder.
The project is not fully deployed until health and MCP verification pass.

## v0.3.6 Docker packaging correction

The previous image built but failed its own test suite because `integrations/chatgpt/skills/tosano-shopping/SKILL.md` was not copied into the image (44/45 tests). The image also lacked `Dockerfile` and `compose.yaml`, required by `npm run verify:docker`. These inputs are now packaged; a 46th regression test checks them. Preserve existing `.env`, `config/tosano.env`, `secrets/openai-runtime-key.txt` and `package-lock.json` when extracting the hotfix over the v0.3.3 source. Run `./scripts/deploy-windows.ps1` again; the new release image tag is immutable and no previous app data is deleted.

## v0.3.6 lockfile inspection correction

PowerShell 5.1 can reject a valid npm package-lock.json because its JSON-to-object
conversion does not preserve case-distinct property names. The deployment now
inspects lock metadata with Node.js, preserves an already valid file, and only
updates stale dependencies. Malformed JSON gets backed up under `backups/`
before npm regenerates a replacement. The generated lock is verified again
before Docker builds the release image.
