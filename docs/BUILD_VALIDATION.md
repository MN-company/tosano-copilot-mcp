# Build validation, v0.3.2 (authoring environment)

Validated: `npm run check`, `npm test` (46/46), `node scripts/verify-docker-config.mjs`, `bash -n scripts/login-browser.sh`, YAML parse of Compose, SQLite snapshot import twice with an isolated HOME. The plugin update for the existing ChatGPT Web App was saved as a separate v1.0.2 account release, preserving the App ID; this does not verify live Windows deployment or ChatGPT discovery.

Not validated from this environment: Docker build/pull/run, Node dependencies through npm registry, PowerShell execution on Windows 10, Playwright GUI inside noVNC, OpenAI tunnel runtime connectivity from Windows, Windows Docker Desktop autostart and the real LaTuaSpesa session. Docker CLI and external npm registry access are unavailable here. `package-lock.json` must be created on the target Windows Docker host on first build, using the provided `deploy-windows.ps1` bootstrap. Subsequent builds use `npm ci` with the preserved lock.

Do not claim Windows deployment succeeded merely because this source package was generated or the ChatGPT plugin metadata was updated. Run `deploy-windows.ps1`, `login-windows.ps1`, and the actual ChatGPT Web read-only tool smoke test to complete the cutover.

Windows 0.3.5 regression guards: missing Docker image lookup must not terminate PowerShell; Docker entrypoints use Compose-provided environment.

Windows 0.3.5 regression: the Docker image now includes `integrations/`, `Dockerfile`, and `compose.yaml`, all required to run the unit tests and `verify:docker` within the image. A new packaging test fails if these files are absent. Live Windows Docker build and tunnel connection remain to be confirmed on the host.
