/** Ingredients (from a recipe, a photo read by the chat model, or a typed list) -> Tosano
 * product proposals and a ready-to-prepare cart input. Never writes: the agent still goes
 * through tosano_prepare_cart_change and the user's approval.
 */
const round = n => Math.round(n * 1000) / 1000;
/** "GR. 500", "KG. 1", "ML 750", "LT. 1,5", "GR. 80 X 6 PZ." -> {grams|ml, pieces} */
export function parseSize(label) {
  if (typeof label !== 'string') return null;
  const s = label.toUpperCase().replace(',', '.');
  const m = s.match(/(GR?|KG|ML|CL|LT?)\.?\s*(\d+(?:\.\d+)?)(?:\s*X\s*(\d+))?/);
  if (!m) { const pz = s.match(/(\d+)\s*PZ/); return pz ? { pieces: Number(pz[1]) } : null; }
  const v = Number(m[2]), mult = m[3] ? Number(m[3]) : 1;
  const unit = m[1];
  if (unit === 'KG') return { grams: round(v * 1000 * mult) };
  if (unit.startsWith('G')) return { grams: round(v * mult) };
  if (unit === 'ML') return { ml: round(v * mult) };
  if (unit === 'CL') return { ml: round(v * 10 * mult) };
  return { ml: round(v * 1000 * mult) };
}
const TO_G = { g: 1, kg: 1000 }, TO_ML = { ml: 1, cl: 10, dl: 100, l: 1000 };
/** How many packs of `product` cover the ingredient amount. Pieces default to 1 when unknown. */
export function packsNeeded(ingredient, product) {
  const size = parseSize(product.sizeLabel);
  const q = ingredient.quantity, u = ingredient.unit;
  if (q && TO_G[u] && size?.grams) return { packs: Math.max(1, Math.ceil((q * TO_G[u]) / size.grams)), basis: `${q} ${u} / ${size.grams} g` };
  if (q && TO_ML[u] && size?.ml) return { packs: Math.max(1, Math.ceil((q * TO_ML[u]) / size.ml)), basis: `${q} ${u} / ${size.ml} ml` };
  if (q && !u && product.selling?.variableWeight && product.selling.estimatedWeightKg) return { packs: 1, basis: 'pezzi a peso: verifica la quantità' };
  if (q && !u && size?.pieces) return { packs: Math.max(1, Math.ceil(q / size.pieces)), basis: `${q} pz / ${size.pieces} pz` };
  if (q && !u && Number.isInteger(q) && q <= 12) return { packs: 1, basis: `${q} pezzi richiesti: controlla la confezione` };
  return { packs: 1, basis: 'quantità non convertibile: 1 confezione' };
}
/** Search text for an ingredient name: drop preparation words that confuse catalog search. */
export function ingredientQuery(name) {
  return name.toLowerCase().replace(/\b(grattugiat[oaie]|tritat[oaie]|macinat[oaie]( al momento)?|fresc[oaih]+|tagliat[oaie]( a [a-z]+)?|a cubetti|a dadini|sbucciat[oaie]|cott[oaie]|crud[oaie]|extravergine|tiepid[oaie]|a temperatura ambiente|per (guarnire|decorare|friggere))\b/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 80) || name.slice(0, 80);
}
/** search(query) -> ranked result {results:[product...], recommendedProductId} */
export async function buildBasket(ingredients, { search, choose = null, includePantry = false, maxIngredients = 25 }) {
  const lines = [], addItems = [], skipped = [];
  for (const ing of ingredients.slice(0, maxIngredients)) {
    if (ing.pantry && !includePantry) { skipped.push({ ingredient: ing.name, reason: 'dispensa (sale, olio, pepe...): aggiunto solo se richiesto' }); continue; }
    let r;
    try { r = await search(ingredientQuery(ing.name)); } catch (e) { lines.push({ ingredient: ing.name, status: 'errore_ricerca', error: e.code ?? 'SEARCH_FAILED' }); continue; }
    const candidates = (r.results ?? []).slice(0, 3);
    if (!candidates.length) { lines.push({ ingredient: ing.name, requested: ing.raw ?? null, status: 'non_trovato' }); continue; }
    const pick = (choose ? await choose(candidates) : null) ?? candidates.find(c => c.productId === r.recommendedProductId) ?? candidates.find(c => c.compatibility !== 'blocked') ?? candidates[0];
    const need = packsNeeded(ing, pick);
    const blocked = (pick.compatibility ?? pick.check?.result) === 'blocked';
    lines.push({ ingredient: ing.name, requested: ing.raw ?? (ing.quantity ? `${ing.quantity} ${ing.unit ?? ''}`.trim() : null), optional: Boolean(ing.optional),
      status: blocked ? 'bloccato_dalle_tue_regole' : candidates.length > 1 ? 'scelta_proposta' : 'trovato',
      proposed: { productId: pick.productId, slug: pick.slug, name: pick.name, brand: pick.brand, sizeLabel: pick.sizeLabel, unitPrice: pick.unitPrice, packs: need.packs, basis: need.basis, safety: pick.compatibility ?? pick.check?.result ?? null },
      alternatives: candidates.filter(c => c !== pick).map(c => ({ productId: c.productId, slug: c.slug, name: c.name, brand: c.brand, sizeLabel: c.sizeLabel, unitPrice: c.unitPrice })) });
    if (!blocked && !ing.optional && pick.slug) addItems.push({ productId: pick.productId, slug: pick.slug, quantity: need.packs });
  }
  const est = lines.filter(l => l.proposed && Number.isFinite(l.proposed.unitPrice) && l.status !== 'bloccato_dalle_tue_regole')
    .reduce((a, l) => a + l.proposed.unitPrice * l.proposed.packs, 0);
  return { lines, skipped, estimatedTotal: Math.round(est * 100) / 100,
    cartPlanInput: addItems.length ? { action: 'add', mode: 'ensure_minimum', addItems: addItems.slice(0, 20) } : null,
    note: 'Proposta, nessuna modifica al carrello. Mostra le righe all\'utente, chiedi le scelte sulle alternative e sugli opzionali, poi usa tosano_prepare_cart_change con cartPlanInput (eventualmente modificato).' };
}
