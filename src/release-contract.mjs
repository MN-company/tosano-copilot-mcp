/** Immutable release handshake; expected by scripts/verify-mcp.mjs. */
export const RELEASE = Object.freeze({
  version: '0.5.0',
  mcpContract: 'tosano-agent-v3',
  storageSchema: 'sqlite-fts5-v1',
  appId: 'asdk_app_6ae8857a20f481919f34fee45f503143'
});
export const REQUIRED_TOOLS = Object.freeze([
  'tosano_release_info', 'tosano_agent_status', 'tosano_search',
  'tosano_smart_search', 'tosano_get_cart', 'tosano_get_preferences',
  'tosano_preference_upsert',
  'tosano_prepare_cart_change', 'tosano_commit_cart_change', 'tosano_cart_reconcile', 'tosano_site_discovery_status',
  'tosano_site_lists', 'tosano_site_list_get', 'tosano_timeslots', 'tosano_orders',
  'tosano_checkout_preview', 'tosano_prepare_site_action', 'tosano_commit_site_action',
  'tosano_profile_status', 'tosano_allergen_catalog', 'tosano_dietary_rule_add', 'tosano_check_product',
  'tosano_profile_prepare_change', 'tosano_profile_commit_change',
  'tosano_my_products', 'tosano_purchase_restrictions', 'tosano_prebilled_amount',
  'tosano_recipe_search', 'tosano_recipe_get', 'tosano_basket_from_recipe', 'tosano_basket_from_ingredients', 'tosano_glycemic_check', 'tosano_recipe_save', 'tosano_recipe_delete', 'tosano_recipe_sources', 'tosano_household', 'tosano_household_member_add', 'tosano_household_rule_add', 'tosano_pantry_list', 'tosano_pantry_set', 'tosano_pantry_remove', 'tosano_pantry_add_from_order', 'tosano_meal_plan_suggest', 'tosano_meal_plan_shopping', 'tosano_substitutes', 'tosano_budget_set', 'tosano_budget_status', 'tosano_price_history', 'tosano_usual_items'
]);
