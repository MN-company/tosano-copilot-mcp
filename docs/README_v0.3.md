# Tosano Copilot MCP — v0.3.8 candidate

**Offline patch ready; Windows/Docker deployment NOT performed.** This release implements
verified per-product cart reconciliation, read-only reconciliation of previous plans,
cart purchase-context identity checks, more conservative dietary/trace checks,
preferred-format ranking and safe GET-only site API discovery for later native-list support.

## Important distinctions

- `tosano_lists` manages **local SQLite lists**, not native LaTuaSpesa website lists.
- Docker Chromium is the operational cart session. Other browser sessions may show separate carts.
- A successful unit test is not a live cart/checkout validation.
- No checkout/order tools are included. Site-native list, orders and slots endpoints remain unknown.
- Never paste cookies, passwords, headers or secrets into ChatGPT.

## Existing Windows upgrade (when you return to the PC)

Extract this package into `C:\Users\gioia\Downloads` using PowerShell
`Expand-Archive -LiteralPath .\tosano-copilot-mcp-v0.3.8-audited.zip -DestinationPath . -Force`
(from Downloads), then:

```powershell
cd "$HOME\Downloads\tosano-copilot-mcp"
.\scripts\deploy-windows.ps1
```

The deployment script runs static/unit checks, backs up the SQLite database,
checks MCP tool discovery and tunnel health, and attempts rollback if needed.
It reuses the existing Docker named volume for browser session and lists.
Do not run the login script again unless the saved login actually expired.

To discover **read-only site APIs for native lists** after successful deploy:

```powershell
.\scripts\discover-site-windows.ps1
```

The helper stops only this project's Tosano services, opens localhost noVNC,
collects sanitized GET request metadata while you browse read screens, and
restarts the Tosano services. It never places orders or stores HTTP response bodies.
ChatGPT can later retrieve the safe inventory with `tosano_site_discovery_status`.

See `docs/PREDEPLOY_AUDIT_0.3.8.md` for independently reviewed fixes, acceptance gates and remaining limitations; `docs/ROADMAP_EXECUTION_0.3.8.md` records the feature sprint.

---

# Previous deployment guide (v0.3.2)

**Windows 10 + Docker Desktop/WSL2 deployment package**, running alongside WhatsApp Copilot as an isolated Compose stack. ChatGPT Web keeps its existing **Tosano Web** app and OpenAI Secure MCP Tunnel ID. Includes Node/Playwright, SQLite FTS5, two-phase cart approvals and the original 45 tests.

## Windows installation

Read **[`docs/WINDOWS_DOCKER.md`](docs/WINDOWS_DOCKER.md)** first. One-time PowerShell commands, from this project folder:

```powershell
.\scripts\set-tunnel-key.ps1
.\scripts\deploy-windows.ps1
.\scripts\login-windows.ps1   # only when the Linux browser session is not yet authenticated
.\scripts\discover-cart-windows.ps1 # optional, verified cart GET discovery
```

Normal restart:

```powershell
.\scripts\restart-windows.ps1
```

The login helper opens a temporary noVNC viewer on `http://127.0.0.1:6080/vnc.html`, published ONLY to Windows localhost. Open it while the helper is running and authenticate inside the container's Chromium browser. The existing Mac Chromium profile should NOT be copied to the Linux container. Migrate only a consistent SQLite snapshot if you want to retain preferences and shopping lists.

**Secrets:** Run-time key is placed by a local prompt in `secrets/openai-runtime-key.txt`, excluded from Git and from the image. No cookies or runtime key are included in this archive.

The Docker migration is a new host deployment; it has not been executed on the Windows PC from this chat. Local tests cover business logic and static Docker configuration; the Windows container build, Chrome UI and real tunnel need a live acceptance test on the PC.

## Other guides

- [`docs/WINDOWS_DOCKER.md`](docs/WINDOWS_DOCKER.md): Windows host commands, tunnel, browser login, migration, updates, rollback.
- [`docs/RELEASE_PIPELINE.md`](docs/RELEASE_PIPELINE.md): delivery contracts, release gates.
- [`docs/README_MAC_v031.md`](docs/README_MAC_v031.md): previous macOS v0.3.1 instructions (legacy).
- [`docs/CHATGPT_AGENT_GUIDE.md`](docs/CHATGPT_AGENT_GUIDE.md): tools and agent safety rules.

Do not run Mac and Windows `tunnel-client` instances concurrently for the **same** Tosano tunnel ID. WhatsApp Copilot's distinct tunnel remains unaffected.
