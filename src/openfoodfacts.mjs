/** Open Food Facts lookup by barcode: community data, used only as a second source.
 * Only the barcode leaves the machine. Results are cached in memory for 24 h.
 */
const MAP = { 'en:gluten': 'glutine', 'en:crustaceans': 'crostacei', 'en:eggs': 'uova', 'en:fish': 'pesce', 'en:peanuts': 'arachidi',
  'en:soybeans': 'soia', 'en:milk': 'latte', 'en:nuts': 'frutta_a_guscio', 'en:celery': 'sedano', 'en:mustard': 'senape',
  'en:sesame-seeds': 'sesamo', 'en:sulphur-dioxide-and-sulphites': 'solfiti', 'en:lupin': 'lupini', 'en:molluscs': 'molluschi' };
const cache = new Map();
const TTL = 24 * 3600 * 1000;
export function offView(json) {
  const p = json?.product;
  if (json?.status !== 1 || !p) return { found: false };
  const tags = t => [...new Set((Array.isArray(t) ? t : []).map(x => MAP[x]).filter(Boolean))];
  const ing = p.ingredients_text_it || p.ingredients_text || null;
  return { found: true, source: 'openfoodfacts', allergens: tags(p.allergens_tags), traces: tags(p.traces_tags),
    ingredients: typeof ing === 'string' ? ing.slice(0, 4000) : null,
    lastModified: p.last_modified_t ? new Date(p.last_modified_t * 1000).toISOString().slice(0, 10) : null,
    warning: 'Dati inseriti dalla community, possono essere incompleti o di una versione precedente della ricetta.' };
}
export async function lookupBarcode(barcode, fetchImpl = globalThis.fetch) {
  if (typeof barcode !== 'string' || !/^\d{8,14}$/.test(barcode)) return { found: false, reason: 'NO_BARCODE' };
  const hit = cache.get(barcode);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value;
  try {
    const r = await fetchImpl(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=allergens_tags,traces_tags,ingredients_text_it,ingredients_text,last_modified_t`,
      { headers: { 'User-Agent': 'tosano-copilot-mcp/0.4 (private shopping assistant)' }, signal: AbortSignal.timeout(8000) });
    value = r.ok ? offView(await r.json()) : { found: false, reason: 'HTTP_' + r.status };
  } catch { value = { found: false, reason: 'UNREACHABLE' }; }
  cache.set(barcode, { at: Date.now(), value });
  return value;
}
