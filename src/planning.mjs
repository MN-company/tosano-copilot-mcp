/** Meal planning, pantry subtraction, smart reorder, substitutes, budget, price insights.
 * Pure functions: the server feeds them live site data and the local stores.
 */
import { pricePer100 } from './smart-search.mjs';

const fold = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ---------- meal plan
const NOT_A_MEAL = /dolc|dessert|torta|crostata|biscott|gelat|salsa|salse|conserv|marmellat|confettur|liquor|cocktail|bevand|sciropp|pane$|impast|brodo base|tecnica|condiment/i;
/** Choose distinct, varied, good-quality main dishes from the recipe DB. */
export function suggestPlan(recipeStore, { days = 7, mealsPerDay = 1, diet = null, excludeAllergens = [], query = '', profileId = null, preferItalian = true }) {
  const want = Math.min(days * mealsPerDay, 21), seen = new Set(), cats = new Map(), picked = [];
  const pool = [];
  for (let i = 0; i < 4 && pool.length < 300; i++) pool.push(...recipeStore.search({ query, diet, excludeAllergens, profileId, minQuality: 60, limit: 20 }).results);
  const hidden = recipeStore.search({ query, diet, excludeAllergens, profileId, limit: 1 }).hiddenByYourRules;
  const candidates = pool.filter(r => !NOT_A_MEAL.test([r.title, ...r.categories].join(' ')))
    .sort((a, b) => (preferItalian ? (b.lang === 'it') - (a.lang === 'it') : 0) || b.quality - a.quality);
  for (const r of candidates) {
    if (picked.length >= want) break;
    const key = fold(r.title).replace(/\s+/g, ' '), cat = fold(r.categories[0] ?? '');
    if (seen.has(key) || (cat && (cats.get(cat) ?? 0) >= Math.max(2, Math.ceil(want / 4)))) continue;
    seen.add(key); cats.set(cat, (cats.get(cat) ?? 0) + 1); picked.push(r);
  }
  const plan = picked.map((r, i) => ({ day: Math.floor(i / mealsPerDay) + 1, meal: mealsPerDay === 1 ? 'cena' : (i % 2 ? 'cena' : 'pranzo'), recipeId: r.id, title: r.title, lang: r.lang, url: r.url }));
  return { plan, requested: want, found: plan.length, hiddenByYourRules: hidden,
    ...(plan.length < want ? { note: 'Non ci sono abbastanza ricette compatibili: riduci i giorni o allenta i filtri.' } : {}) };
}

const FAMILY = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], cl: ['ml', 10], dl: ['ml', 100], l: ['ml', 1000] };
/** Sum the same ingredient across recipes (g/kg and ml/l unified). */
export function mergeIngredients(recipes) {
  const map = new Map();
  for (const r of recipes) for (const i of r.ingredients) {
    const name = i.nameIt ?? i.name, [unit, k] = FAMILY[i.unit] ?? [i.unit ?? null, 1];
    const key = fold(name) + '|' + (i.quantity === null ? '?' : unit ?? 'pz');
    const cur = map.get(key) ?? { name, quantity: i.quantity === null ? null : 0, unit, optional: true, pantry: false, usedIn: [] };
    if (i.quantity !== null) cur.quantity = round(cur.quantity + i.quantity * k);
    cur.optional = cur.optional && Boolean(i.optional); cur.pantry = cur.pantry || Boolean(i.pantry);
    if (!cur.usedIn.includes(r.title)) cur.usedIn.push(r.title);
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.usedIn.length - a.usedIn.length);
}
/** Remove what the pantry already covers. Unknown pantry quantity = available. */
export function subtractPantry(items, pantry) {
  const toBuy = [], covered = [];
  for (const it of items) {
    const n = fold(it.name);
    const p = pantry.find(x => { const pn = fold(x.name); return pn === n || n.includes(pn) || pn.includes(n); });
    if (!p) { toBuy.push(it); continue; }
    const [pu, pk] = FAMILY[p.unit] ?? [p.unit ?? 'pz', 1];
    if (p.quantity === null || it.quantity === null) { covered.push({ ...it, pantryItem: p.name, coveredBy: 'presente in dispensa' }); continue; }
    if (pu !== (it.unit ?? 'pz')) { toBuy.push({ ...it, pantryNote: `in dispensa: ${p.quantity} ${p.unit ?? ''}`.trim() }); continue; }
    const missing = round(it.quantity - p.quantity * pk);
    if (missing <= 0) covered.push({ ...it, pantryItem: p.name, coveredBy: `${p.quantity} ${p.unit ?? 'pz'} in dispensa` });
    else toBuy.push({ ...it, quantity: missing, pantryNote: `già in dispensa ${p.quantity} ${p.unit ?? 'pz'}` });
  }
  return { toBuy, covered };
}

// ---------- smart reorder
/** orders: [{createdAt, items:[{productId, slug, name, quantity}]}] newest first or any order. */
export function analyzeHabits(orders, now = Date.now()) {
  const valid = orders.filter(o => o.createdAt && Array.isArray(o.items) && o.items.length);
  const by = new Map();
  for (const o of valid) {
    const t = Date.parse(o.createdAt); if (!Number.isFinite(t)) continue;
    for (const i of o.items) {
      if (!i.productId || !i.slug) continue;
      const cur = by.get(i.productId) ?? { productId: i.productId, slug: i.slug, name: i.name, dates: [], qty: [] };
      if (!cur.dates.includes(t)) { cur.dates.push(t); cur.qty.push(Number(i.quantity) || 1); }
      by.set(i.productId, cur);
    }
  }
  const items = [...by.values()].map(x => {
    const d = x.dates.sort((a, b) => a - b), gaps = d.slice(1).map((t, i) => (t - d[i]) / 864e5);
    const interval = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null;
    const since = (now - d[d.length - 1]) / 864e5;
    const avgQty = x.qty.reduce((a, b) => a + b, 0) / x.qty.length;
    return { productId: x.productId, slug: x.slug, name: x.name, timesBought: d.length, share: round(d.length / valid.length), avgIntervalDays: interval === null ? null : Math.round(interval),
      daysSinceLast: Math.round(since), usualQuantity: avgQty >= 1 ? Math.round(avgQty) : round(avgQty, 3),
      due: interval !== null && since >= interval * 0.85, staple: valid.length >= 3 && d.length / valid.length >= 0.5 };
  }).sort((a, b) => b.timesBought - a.timesBought);
  const due = items.filter(i => i.due || (i.staple && i.daysSinceLast >= 6));
  return { ordersAnalyzed: valid.length, due, frequent: items.filter(i => i.timesBought >= 2).slice(0, 40),
    cartPlanInput: { addItems: due.map(i => ({ productId: i.productId, slug: i.slug, quantity: i.usualQuantity })) },
    note: valid.length < 3 ? 'Pochi ordini con dettaglio: la stima delle abitudini è debole.' : 'Proposta basata sulla frequenza dei tuoi ordini; controllala prima di preparare il carrello.' };
}

// ---------- substitutes
const STOP = new Set(['di', 'al', 'alla', 'con', 'e', 'gr', 'g', 'kg', 'ml', 'lt', 'l', 'pz', 'x', 'conf', 'il', 'la', 'del', 'della']);
export const nameTokens = name => fold(name).split(/[^a-z0-9]+/).filter(t => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));
export function rankSubstitutes(original, candidates, checkFn, limit = 5) {
  const ot = new Set(nameTokens(original.name)), op = pricePer100(original);
  return candidates.filter(c => c.productId && c.productId !== original.productId).map(c => {
    const ct = nameTokens(c.name), shared = ct.filter(t => ot.has(t)).length;
    const check = checkFn(c), cp = pricePer100(c);
    let score = shared * 2 + (c.category && c.category === original.category ? 3 : 0) + (c.brand && c.brand === original.brand ? 1 : 0);
    if (op && cp) score -= Math.min(3, Math.abs(cp - op) / op * 3);
    return { productId: c.productId, slug: c.slug, name: c.name, brand: c.brand, unitPrice: c.unitPrice, pricePer100: cp, score: round(score),
      compatibility: check.blockers?.length ? 'blocked' : check.unknown?.length ? 'da_verificare' : 'not_blocked_by_configured_rules', reasons: [...(check.blockers ?? []), ...(check.unknown ?? [])].slice(0, 3) };
  }).filter(c => c.compatibility !== 'blocked' && c.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------- budget
export function weekStart(now = new Date()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d;
}
const CANCELLED = /annullat|cancellat|rifiutat|deleted|cancel/i;
export function budgetStatus(budget, orders, cartTotal = 0, now = new Date()) {
  if (!budget?.weekly) return { configured: false, note: 'Nessun budget impostato (tosano_budget_set).' };
  const from = weekStart(now).getTime();
  const week = orders.filter(o => Date.parse(o.createdAt) >= from && !CANCELLED.test(o.status ?? ''));
  const spent = round(week.reduce((a, o) => a + (Number(o.total) || 0), 0));
  const committed = round(spent + (Number(cartTotal) || 0));
  return { configured: true, weeklyBudget: budget.weekly, weekStarts: weekStart(now).toISOString().slice(0, 10), ordersThisWeek: week.length, spent,
    cartTotal: round(Number(cartTotal) || 0), remainingAfterCart: round(budget.weekly - committed),
    status: committed > budget.weekly ? 'oltre_budget' : committed > budget.weekly * 0.9 ? 'vicino_al_limite' : 'nel_budget',
    note: 'Totali degli ordini come riportati dal sito; i prodotti a peso possono variare alla consegna.' };
}

// ---------- prices
export function priceInsight(history, current) {
  if (!history.length) return { trend: 'nessuno_storico', note: 'Prezzi registrati da quando l\'MCP osserva questo prodotto.' };
  const prices = history.map(h => h.price).sort((a, b) => a - b), median = prices[Math.floor(prices.length / 2)];
  const cur = Number(current ?? history[history.length - 1].price), diff = round((cur - median) / median * 100, 1);
  return { current: cur, median, min: prices[0], max: prices[prices.length - 1], observations: history.length, since: history[0].day, changePct: diff,
    trend: history.length < 2 ? 'storico_insufficiente' : diff <= -8 ? 'sotto_la_media' : diff >= 8 ? 'sopra_la_media' : 'stabile' };
}
