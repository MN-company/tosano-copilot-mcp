#!/usr/bin/env bash
# Tosano Copilot MCP - one-command installer for macOS / Linux (Docker required).
#   curl -fsSL https://raw.githubusercontent.com/MN-company/tosano-copilot-mcp/main/install.sh | bash
# Never asks for your LaTuaSpesa password: you log in yourself in a local browser window.
set -euo pipefail
DIR="${TOSANO_DIR:-$HOME/tosano-copilot-mcp}"
REPO="https://github.com/MN-company/tosano-copilot-mcp.git"
step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }

step "Controllo Docker"
command -v docker >/dev/null || { echo "Installa Docker: https://docs.docker.com/get-docker/"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Avvia Docker e rilancia."; exit 1; }

step "Codice sorgente"
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -n "$here" ] && [ -f "$here/compose.yaml" ]; then DIR="$here"
elif [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only
else git clone "$REPO" "$DIR"; fi
cd "$DIR"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"

step "Configurazione"
[ -f config/tosano.env ] || { cp config/tosano.env.example config/tosano.env; echo "Creato config/tosano.env (scritture disattivate)."; }
touch .env
grep -v '^TOSANO_IMAGE_TAG=' .env > .env.tmp || true; echo "TOSANO_IMAGE_TAG=$VERSION" >> .env.tmp; mv .env.tmp .env
grep -q '^CONTROL_PLANE_TUNNEL_ID=' .env || echo "CONTROL_PLANE_TUNNEL_ID=not-configured" >> .env

step "Build e avvio del server MCP v$VERSION"
docker compose build tosano-mcp
docker compose up -d --no-deps tosano-mcp
for i in $(seq 1 40); do curl -fs http://127.0.0.1:3788/health | grep -q "\"version\":\"$VERSION\"" && break; sleep 3; done
curl -fs http://127.0.0.1:3788/health >/dev/null || { echo "Server non raggiungibile: docker compose logs tosano-mcp"; exit 1; }

step "Database ricette"
docker compose exec -T tosano-mcp node -e "import('./src/recipe-db.mjs').then(m=>process.exit(new m.RecipeStore().stats().total>0?0:1))" \
  || docker compose exec -T tosano-mcp node src/import-recipes.mjs | tail -1

if [ "${SKIP_LOGIN:-}" != "1" ]; then
  step "Sessione LaTuaSpesa"
  st="$(curl -s -X POST http://127.0.0.1:3788/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tosano_session_status","arguments":{}}}' || true)"
  if echo "$st" | grep -q 'authenticatedWithTosano\\":\\"verified'; then echo "Già autenticato."
  else
    echo "Apri http://127.0.0.1:6080/vnc.html, accedi a LaTuaSpesa, poi premi INVIO qui."
    docker compose stop tosano-mcp
    docker compose --profile login run --rm --service-ports --no-deps tosano-login || true
    docker compose up -d --no-build --no-deps tosano-mcp
  fi
fi

step "Registrazione negli agenti AI"
if command -v node >/dev/null; then node scripts/register-agents.mjs
else docker run --rm -v "$HOME:/h" -e TOSANO_HOME_OVERRIDE=/h -v "$DIR/scripts:/s:ro" --entrypoint node "tosano-copilot-mcp:$VERSION" /s/register-agents.mjs; fi
echo; echo "Fatto. Riavvia gli agenti aperti e chiedi: 'cosa c'è in offerta da Tosano?'"
