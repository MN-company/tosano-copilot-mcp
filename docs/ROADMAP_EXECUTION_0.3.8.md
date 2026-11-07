# Tosano Copilot — execution ledger, 2 November 2026

## Scope and evidence

This is a **source-code release candidate**, prepared from the available v0.3.6 ZIP.
The Windows PC's Docker installation has **not** been modified. No real Tosano website
write was attempted during this implementation. Site-native list endpoints have not
been observed, so implementing them would be speculative and unsafe.

## Done in source (v0.3.8)

| Item | Evidence | Remaining gate |
| --- | --- | --- |
| Cart plans report per-product `confirmed` / `missing` / `not_attempted` / `unverified` | `src/cart-reconciliation.mjs`; regression 6-of-7 with HTTP 422 | Live Docker integration |
| Persist state `partial` instead of categorizing all partials as `unknown` | `src/agent-db.mjs`, `src/cart-planner.mjs` | Live browser recheck |
| Preserve `unknown` and never retry after ambiguous network response | New regression for `NETWORK_AMBIGUOUS` and idempotent plan claims | Real timeout test, safely simulated |
| Validate cart ID and pickup/slot context before commits and when reading results | `cartIdentity`/`cartFingerprint`, tests | Verify actual browser response fields |
| Read-only `tosano_cart_reconcile` | MCP tool; no retry or mutation | MCP discovery and live read |
| Trace-allergen preference is enforced; missing trace label requires review | `checkProduct()`, 4 new test categories | Labels from native API must be verified |
| Preferred formats and shopping priority price honored in ranking | `rankProducts()`, tests | Product matching review for nonstandard labels |
| Nutrition priority does not claim ranking without structured data | explicit `nutritionRankingAvailable=false` | Future authoritative nutrition data |
| Safe observation of potential site-native GET endpoints | `src/discover-site.mjs`, `scripts/discover-site-windows.ps1`, tests | User browsing in authenticated Docker Chromium |
| `tosano_site_discovery_status` returns only metadata from local observation | server tool | Host rollout / possible ChatGPT tool refresh |
| Release and version wiring | package, release contract, Compose, skill | Windows deploy + tunnel + ChatGPT app verification |

## Not yet implemented (requires discovery or external account access)

- Native LaTuaSpesa list read/create/edit/delete/transfer and local↔site sync.
- Slots and pickup-context modification beyond observed cart metadata.
- Order history, ordering, checkout and payment.
- Structured nutrition/stock verification when the site does not provide reliable fields.
- User-visible remote browser viewer. Existing noVNC is **localhost-only** and
  should not be exposed publicly without a separate authenticated gateway.

## Security and acceptance conditions

1. The user inspects current Docker cart and confirms that the browser agrees with
   `tosano_get_cart` (within the same Docker session).
2. Install candidate with `scripts/deploy-windows.ps1` when able to access Windows;
   watch backup, unit tests, MCP contract verification and tunnel readiness.
3. On ChatGPT, `tosano_release_info` must show `0.3.8` and `tosano_cart_reconcile`
   and `tosano_site_discovery_status` must be discoverable.
4. Use mock data for seven-item partial, lost response and concurrent change tests.
   For real cart modifications, obtain exact subsequent user approval for one
   disposable test item, then read back. No automated retry.
5. Only after site-native read endpoint observation and a documented authenticated
   response schema, implement native list GET. Then stage writes separately,
   with user-confirmed test objects and rollback paths.
6. Keep local lists, preferences, site-native lists, cart and orders distinct.
7. Do not release site-native CRUD or checkout features based on invented endpoints.

## Docker deployment caution

Do not run Mac and Windows instances of the same tunnel ID simultaneously.
Tosano Compose project is separate from WhatsApp Copilot. The ZIP contains no
runtime `.env`, `config/tosano.env`, browser profile, SQLite data, or tunnel key.
Version 0.3.8 intentionally retains `tosano-agent-v3`, with additive read-only tools.
