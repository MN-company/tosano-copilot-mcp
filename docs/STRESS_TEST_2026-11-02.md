# Tosano Copilot — live QA stress test, 2 novembre 2026

## Confirmed live findings (backend v0.3.5)

- ChatGPT exposes 28 Tosano Web MCP tools, release v0.3.5 and `tosano-agent-v3`.
- 26 of 28 tools were exercised; the two not invoked are `tosano_commit_cart_change` (requires explicit subsequent approval and live fresh cart) and `tosano_preferences_finish_onboarding` (would change a lasting account preference).
- 15 functional read/search cases passed: basic search, page 2, promo, no-results, smart filters by price/brand/category, cache, injection-like query, product details and checks, list search and read.
- Three 6-call concurrent waves completed: 18/18 successful requests, no request errors.
- Account session verified, purchase context saved, SQLite WAL/FTS5 healthy, initial cache 528 products.
- Temporary list item was added, upserted again without duplication, searched with FTS5, removed; the real `Essenziali economici` list remains with seven items.
- Temporary nonsensitive preference was added, read and deleted; existing preference settings restored and the onboarding flag unchanged.
- `tosano_list_create` with an existing name was idempotent, and `tosano_list_suggest_matches` returned suitable product matches for the first three items.
- `tosano_cart_plan_status` returned `PLAN_NOT_FOUND` for a dummy ID.
- Three deprecated direct-write endpoints correctly rejected requests with `TWO_PHASE_REQUIRED`, preventing bypass of approval.
- Promo filter changed actual catalog results (91 vs 732 yogurt entries compared under the same search); not silently ignored.

## Blocking issues

`tosano_get_cart`, `tosano_list_prepare_additions` and `tosano_prepare_cart_change` fail with `UNVERIFIED_ENDPOINT`: no GET route has been verified in the browser. The fix requires running `scripts/discover-cart-windows.ps1` on Windows, browsing the real cart in Docker Chromium, and observing a valid EBSN GET response. Do not guess or hardcode an unobserved URL.

The live v0.3.5 backend reports `cartWritesEnabled=false`, so no cart writes can be completed. Real cart writes should only be enabled after tested fresh reads, and then executed only with exact subsequent user approval of a particular plan. No checkout or cart mutation was attempted by this QA run.

## Price comparison bug discovered, fixed in this ZIP (v0.3.6; not yet deployed)

Some products have a current pack price different from their catalog price-per-kilogram, apparently because of discounts:
- Merano white yogurt 400g: current pack price €0.99 -> €2.48/kg; catalog displays €3.38/kg.
- Nuovo Dì fresh milk 1L: current pack price €0.99 -> €0.99/L; catalog displays €1.39/L.

v0.3.6 fixes smart-search ranking to derive effective prices from current pack price and known size, handles multipack sizes, and declines per-100g pricing for piece-only labels (e.g. 6 eggs). Existing raw `pricePerUnit` is still the catalog field; ranking uses recomputed actual prices where possible. 4 regression tests added, 56/56 local tests pass; the Windows build and tunnel for v0.3.6 have NOT yet been tested live.

## Remaining verification on Windows

1. Deploy ZIP v0.3.6 via `scripts/deploy-windows.ps1`. It preserves the .env and persistent SQLite state.
2. Run `scripts/discover-cart-windows.ps1`, open actual Tosano cart using `http://127.0.0.1:6080/vnc.html` in the Windows PC, then press Enter. The script must report `Verified GET cart route observed and saved`.
3. From ChatGPT call `tosano_get_cart`, expect `live=true` and `source=fresh_get`. If the route cannot be observed, inspect the site UI/network rather than force a URL.
4. After verified reads, separately agree whether to enable writes, and confirm an exact cart plan before any commit test.

No personal credentials are included in this ZIP; no existing user list or order was modified other than a temporary list test item that has been removed.
