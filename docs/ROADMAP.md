# Tosano Copilot — development roadmap (updated 2 November 2026)

## v0.3.8 source candidate — ready for Windows deploy/acceptance

- Cart operation reconciliation (`succeeded`/`partial`/`failed`/`unknown`) with per-product proof.
- No retry on ambiguous writes, read-back and cart purchase-context identity checks.
- Read-only cart-plan reconciliation (`tosano_cart_reconcile`).
- Brand/format preferences, normalized price ranking, possible-traces allergy fail-closed logic.
- Privacy-sanitized discovery of site-native GET endpoints (`tosano_site_discovery_status` and browser helper).
- 81 local unit tests plus Docker static verification; **no live deployment yet**.

## Blocked by authenticated site discovery — future releases

1. **v0.4.x**: Native LaTuaSpesa lists (read, then user-authorized CRUD and cart transfer).
2. **v0.5.x**: Stronger structured ingredient/trace parsing and product search equivalence/availability.
3. **v0.6.x**: Account, pickup slots and order history in read-only mode.
4. **Later, separately approved**: Checkout with explicit consent and strong idempotency.

See `docs/PREDEPLOY_AUDIT_0.3.8.md` for the post-sprint audit and Windows acceptance requirements.
