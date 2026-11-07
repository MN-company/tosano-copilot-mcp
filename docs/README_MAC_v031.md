# Tosano Copilot MCP v0.3 — SQLite + FTS5 / agent-first

Private, local MCP server for LaTuaSpesa. It connects to **ChatGPT Web** through your **existing OpenAI Secure MCP Tunnel**. The Tosano browser profile and login remain on the Mac. This project is independent from WhatsApp Copilot. **No order placement, payment, checkout, delivery management or home-inventory dashboard.**

## What is new

- **SQLite + FTS5:** local cache of sanitized product metadata, full-text search (`unicode61 remove_diacritics 2`, prefix matching, FTS rank), saved shopping lists, preference rules, immutable-operation-style cart plans. SQLite WAL and bound SQL queries; no raw user SQL exposed to the agent.
- **Preference engine:** brands by category (`yogurt → Mila`), hard brand exclusions, explicit food exclusions, desired formats and shopping priority. Old `~/.tosano-copilot/preferences.json` is imported once, without deleting or overwriting it. Missing ingredients/allergen data means **review required**, not guaranteed safety.
- **Smart search:** live Tosano search with preference-based ranking, extra brand-specific lookup when necessary, optional required-name and category filters, unit normalization to 100 g/100 ml (or kg/litre) and options to exclude products that should not be compared.
- **Persistent lists:** named lists with stable IDs, absolute quantity upserts, FTS lookup, live product suggestions for up to five list entries at a time, and building **proposals** to add multiple selected products.
- **Cart safety:** read-only cart GET route discovery from real browser traffic, not a guessed URL. Two-phase preparation and approval, cart fingerprint check, no accidental duplicate additions (`ensure_minimum`), idempotent plans, price checks, final cart verification, and **no retry** when a mutation outcome may be unknown. The v0.2 direct write tool names now return `TWO_PHASE_REQUIRED`.
- **Optional chat onboarding:** the agent can ask about brands and dietary preferences progressively; no preferences are silently inferred and dietary constraints require explicit storage consent. Tool `tosano_preferences_finish_onboarding` can mark setup finished.

## Requirements

- macOS with **Node.js 22.13+** (22 LTS is recommended). `node:sqlite` is supplied by Node; no external SQLite service or native package installation is needed. In Node 22 it may print an experimental-feature warning, even if all tests pass.
- Playwright Chromium, already working in your v0.2 installation.
- The existing `~/.tosano-copilot/browser-profile`, live purchase context, and existing OpenAI Secure MCP Tunnel.
- A `.env` file in the active application folder. The archive contains only `.env.example`.

### Safely upgrade your existing v0.2 (Mac)

**Do not remove the existing application folder, browser profile, .env, or tunnel configuration.** Stop `npm run start` (`Ctrl+C`) before updating. You can take a quick backup of the current source folder first.

Download `tosano-copilot-mcp-v0.3.zip` to `~/Downloads` and run the following in Terminal. If your actual active directory is not named `tosano-copilot-mcp 2`, replace that destination with its correct absolute path:

```bash
mkdir -p ~/Downloads/tosano-v03-extract
unzip -oq ~/Downloads/tosano-copilot-mcp-v0.3.zip -d ~/Downloads/tosano-v03-extract
rsync -av --exclude='.env' --exclude='node_modules' \
  ~/Downloads/tosano-v03-extract/tosano-copilot-mcp/ \
  ~/Downloads/'tosano-copilot-mcp 2'/
cd ~/Downloads/'tosano-copilot-mcp 2'
node --version
npm install
npm run check
npm test
npm run doctor
npm run smoke -- "yogurt"
```

Then start the server as usual:

```bash
npm run start
```

**The plugin installed in ChatGPT Web already points to the Secure MCP Tunnel**, so keep using the same tunnel/profile. The tunnel ID and OpenAI Runtime API Key are not stored in this archive. After restarting the local server, refresh the installed plugin or its connection in ChatGPT to discover the newly added MCP tools. The plugin's v0.2 instructional skill may still need an update when the backend is validated; do not assume an updated server automatically updates that skill.

### Find the real cart read endpoint (one-time discovery)

We have verified cart **add**, **update** and **delete** endpoints. We have **not yet observed** an independent GET cart endpoint from the user session. The project includes a safe discovery utility; do **not** hardcode an assumed path.

1. Stop the MCP server (`Ctrl+C`): only one Chromium process can use the persistent profile at a time.
2. Run `npm run discover-cart`.
3. In the Chromium window that opens, **open your existing cart normally**, then return to Terminal and press Enter.
4. The tool accepts a path only if it observed a same-origin **GET** request, a successful EBSN envelope, a cart ID and item array. Only the validated relative route is persisted to `~/.tosano-copilot/cart-read-path.json`; raw cart/account JSON and cookies are not saved.
5. Restart `npm run start` and ask ChatGPT to call `tosano_get_cart`.

If the site does not make a matching GET request, discovery will say so. No cart-read support is falsely claimed, and cart mutations remain blocked until a genuinely fresh read is available. We can then inspect the Network requests and adapt the observer to the actual endpoint. A site-issued read route may require later re-verification if Tosano changes its API.

### Test preferences in ChatGPT Web

After restarting the server and refreshing the plugin discovery, try:

> Per lo yogurt preferisco Mila, ma accetto altre marche se te lo chiedo espressamente. Salva questa preferenza.

ChatGPT should call `tosano_preference_upsert` with `category="yogurt"`, `kind="preferred_brand"`, `value="Mila"`, `strength="soft"`, only after explicit request. Then try:

> Cerca uno yogurt e proponi prima quelli Mila, con prezzo per 100 g. Non aggiungere nulla al carrello.

For allergy or ingredient rules, the agent must explicitly obtain user consent to **persist** dietary data; missing product labels are not safety clearance. These are preference filters, not certified allergy screening.

### Test lists in ChatGPT Web

> Crea una lista chiamata Spesa settimanale, aggiungici due yogurt e una confezione di pasta, senza modificare il carrello.

Tools: `tosano_list_create`, `tosano_list_upsert_item`, `tosano_list_get`, `tosano_list_suggest_matches`. A list is independent of the native Tosano shopping lists and independent of the remote cart.

### Cart changes and consent

- `ALLOW_CART_WRITES=false` **by default**. Leave it disabled until the real GET cart endpoint has been discovered and `tosano_get_cart` works reliably.
- A read-only `tosano_prepare_cart_change` returns exact proposed line changes and an **estimated** cost delta. The user must explicitly approve that proposal in a separate turn.
- `tosano_commit_cart_change` requires the matching plan ID and approval phrase, a fresh unchanged cart, current product/price verification when adding, and local `ALLOW_CART_WRITES=true`. It never checks out.
- A plan may expire, become stale, or finish `unknown` if a network error happens after an attempted mutation. Unknown means **inspect the real cart**; **never retry the mutation automatically**.
- Plan approval is enforced by a two-phase tool contract and assistant/host permissions; a client capable of directly calling the MCP tool can technically supply the approval phrase. For stronger proof of user presence a dedicated MCP App approval dialog or authenticated approval channel is needed. This is **not** a cryptographic human-consent guarantee.

## Agent-first storage model

Database: `~/.tosano-copilot/agent.sqlite` (file mode `0600`, parent directory `0700`). SQLite WAL is on. Companion `-wal`/`-shm` files are under the same private parent directory.

Tables (not exposed directly to ChatGPT):

- `preference_rules`: profile, category, rule kind, normalized value, hard/soft enforcement; indexed by profile/category/kind.
- `settings`: preferences, onboarding completion, migration marker.
- `shopping_lists` and `shopping_list_items`: stable UUID keys, normalized terms, exact absolute quantities, SKU binding when user chose an exact product.
- `cached_products` + `cached_products_fts`: **sanitized** product metadata indexed by context, search rank and observation time. The cached price is never described as current or physically in stock.
- `shopping_list_items_fts`: full-text search across list items.
- `cart_plans`: planned, executing, succeeded, stale, failed or unknown changes with snapshot hash and idempotency keys.

The agent accesses **typed MCP tools**, not arbitrary SQL. This makes common workflows fast without permitting unrestricted table scans, unsafe mutations or exposing the database on the network. FTS5 improves lexical search but does **not** provide semantic understanding or verified allergen information.

v0.3 is configured as a **single-user profile** (`default`) on a private Mac. Do not share this running instance across multiple Tosano accounts: cross-account authorization and user-scoped profiles would need additional work before multi-user deployment.

## Commands and troubleshooting

```bash
npm run doctor             # identity probe, read-only
npm run smoke -- "pasta"  # live product read
npm run discover-cart      # must stop the server first; headful browser discovery
npm run check              # JavaScript parse checks
npm test                   # offline regression tests
npm run start              # localhost:3788/mcp, /health
```

- `UNVERIFIED_ENDPOINT`: cart GET has not yet been seen. Use `discover-cart`.
- `AUTH_UNVERIFIED`: the backend did not confirm identity; the catalog may still be public. Inspect `npm run doctor`, do not assume a missing cookie means logged out.
- `REVIEW_REQUIRED` / `PREFERENCES_BLOCK`: an exclusion rule cannot be cleared because labels are missing or a hard restriction is violated.
- `CART_CHANGED` / `PRODUCT_CHANGED`: prepare a new proposal after inspection; old consent must not be reused.
- `NETWORK_AMBIGUOUS` / `PLAN_UNKNOWN`: check the site before any further cart changes. No automatic retry.

## Security and scope

Store no Tosano passwords in files or chat; the Chromium browser owns the authenticated session. Do not publish the local MCP endpoint without robust authentication. Do not upload the `~/.tosano-copilot` directory (it includes browser credentials and dietary preferences), database, `.env`, or tunnel runtime key. Rotate any previously shared `JSESSIONID`. Keep the Mac running for ChatGPT Web access.

This is an experimental adapter to undocumented Tosano website endpoints, not an official Tosano integration. Respect site terms and reasonable rate limits. Product search is confirmed from prior live user tests; **the new v0.3 tools have only been offline-tested in the packaging environment**, not yet on the user's Mac or live Tosano account.

---

## v0.3.1 reliable updating (preferred over rsync)

This release adds **an immutable macOS/launchd deployment pipeline**. Stop the old manually started `npm run start`, unpack this ZIP on the Mac, and run from the extracted source:

```bash
bash scripts/deploy-macos.sh --env-from "$HOME/Downloads/tosano-copilot-mcp 2/.env"
```

It preserves your original Playwright session and `.env`, tests SQLite/FTS5, verifies actual MCP tool discovery, and rolls source back on a failed cutover. On subsequent releases you can run `bash scripts/deploy-macos.sh` without `--env-from`. Do not run a second manual Node server alongside launchd. See [docs/RELEASE_PIPELINE.md](docs/RELEASE_PIPELINE.md) for exact prerequisites, limitations, diagnostics and rollback.

**ChatGPT Web is a separate release gate.** After a successful backend deployment, open the **existing Tosano Web app** in ChatGPT Plugins and click **Refresh**, then start a new chat and ask it to call `tosano_release_info`. Confirm server version `0.3.1` and contract `tosano-agent-v3`. A local deployment alone cannot force the hosted ChatGPT app to refresh its registered tool definitions.

**Build limitation:** the archive does not yet include a `package-lock.json` because the npm registry could not be reached in the build environment. The Mac installer creates it on first deployment and saves it for future deterministic `npm ci` installations. Avoid changing dependencies before the lock is recorded.
