# Tosano Copilot v0.3.8 — independent predeployment code audit

Audit date: 2026-11-02. Based on the full v0.3.7 ZIP, **not** on a running Windows Docker instance. **Status: candidate for Windows acceptance, not a verified live deployment**.

## Findings corrected

1. **MCP planner construction race.** Multiple overlapping initial calls to `getPlanner()` could instantiate independent `CartPlanner` queues. Now the in-flight Promise is memoized, ensuring a single queue per process.
2. **Cart-line identity.** Quantity and removal reconciliation previously looked up only `productId`; replacement lines with the same product could give misleading confirmations. Now reconciliation uses the requested `itemId` plus `productId`.
3. **Misleading no-op confirmations.** No-ops were unconditionally marked successful. Now the final GET must verify the desired quantity remains present.
4. **Partial batches.** `tosano_cart_reconcile` previously treated every planned line as attempted even after the commit aborted early. Now `attemptedCount` is persisted and reused by read-only reconciliations.
5. **Expired plans.** The same intent could return an already expired, unclaimed plan; now it is marked expired and a new ID is issued for a fresh approval.
6. **Dietary preference changes.** Hard dietary restrictions saved between `prepare` and `commit` now invalidate a quantity increase before any write.
7. **Hard package-format rules.** Previously enforced only by search ranking, not by a direct cart add. Now `checkProduct()` applies them in both paths.
8. **Ambiguous duplicate cart lines.** A plan to add an existing product represented by multiple cart lines now fails closed instead of silently updating an arbitrary line.
9. **Invalid cart identity.** Plan preparation rejects a cart with no positive integer `cartId`.
10. **Incomparable price units.** A mixed €/100 g and €/100 ml search now warns about non-comparability and refuses a fictitious cheapest recommendation.
11. **Docker tag collision.** The Windows installer previously reused a same-version Docker image without checking that it came from the current sources. Now it stops and requires an explicit `-AllowReplaceImage` override. Release tagged `0.3.8` to avoid collision with any earlier `0.3.7` candidate.

## Offline checks and limits

- `npm run check`: JavaScript syntax for the entrypoints, success.
- `npm test`: **81/81** Node test cases passed.
- `npm run verify:docker`: static Docker wiring checks passed (not a Docker build).
- Full source ZIP can be extracted and all tests rerun in an empty directory.
- Secrets excluded: `.env`, `config/tosano.env`, `secrets/openai-runtime-key.txt`, browser profile and SQLite database.
- Packaging **does not include `package-lock.json`**. The existing Windows installer validates or regenerates this file through the official Node Docker image; this step **requires access to the npm registry if regeneration is needed**. Dependency resolution and `npm ci` cannot be tested offline here, so an actual Windows Docker build remains a release gate.
- `pwsh` and Docker daemon are not installed in this execution environment. PowerShell syntax and Compose runtime behavior have not been executed live. Earlier Windows v0.3.5 deployment results do not prove v0.3.8 works until tested on the target host.
- MCP SDK modules are also not installed in this source-only environment; MCP `initialize`/`tools/list`, browser authentication, real cart/checkout and tunnel registration must pass the Windows smoke test.
- Native LaTuaSpesa lists, slots, ordering/checkout are **not implemented**. Do not claim them as available.

## Windows release gate (next, not yet done)

1. Confirm `docker compose ps` for the existing Tosano project and back up `.env`, `config/tosano.env`, and `secrets` securely without sharing their content.
2. Extract the audited ZIP **over the project folder**, preserve runtime configs, then run `scripts/deploy-windows.ps1`. Confirm automatic SQLite backup occurs.
3. Require `DEPLOYMENT PASS`, local health `/health` version `0.3.8`, the full MCP tool manifest, and tunnel health; **do not override an existing same-tag image casually**.
4. Reopen ChatGPT Tosano Web and confirm `tosano_release_info` returns `0.3.8`, plus `tosano_cart_reconcile` and `tosano_site_discovery_status` discoverable.
5. Read the cart twice, and check `cartId`, pickup and item quantities match the same Docker Chromium session.
6. Run write operations only with a fresh plan, displayed intent and an **explicit subsequent approval**. No checkout; no automatic replay of an ambiguous response.
7. If any gate fails, stop and inspect sanitized diagnostics instead of repeatedly reinstalling or modifying account data.
