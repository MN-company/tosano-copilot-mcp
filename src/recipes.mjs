/** Real recipes from the Italian Wikibooks cookbook ("Libro di cucina", ~740 recipes),
 * licensed CC BY-SA 4.0. Every result carries its source URL and licence so the agent
 * can attribute it; nothing is invented. Only it.wikibooks.org is contacted.
 */
import { TosanoError } from './client.mjs';

const API = 'https://it.wikibooks.org/w/api.php';
const PREFIX = 'Libro di cucina/Ricette/';
const UA = { 'User-Agent': 'tosano-copilot-mcp/0.4 (private shopping assistant; recipe lookup)' };
export const RECIPE_SOURCE = Object.freeze({ name: 'Wikibooks - Libro di cucina', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/deed.it' });
const cache = new Map(), TTL = 24 * 3600 * 1000;
const pageUrl = title => 'https://it.wikibooks.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/');

async function api(params, fetchImpl) {
  const key = JSON.stringify(params), hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const u = new URL(API); for (const [k, v] of Object.entries({ ...params, format: 'json', formatversion: 2 })) u.searchParams.set(k, String(v));
  let r;
  // Read-only API: on 429/503 wait (Retry-After) and try again, max 4 times.
  for (let attempt = 0; ; attempt++) {
    try { r = await fetchImpl(u, { headers: UA, signal: AbortSignal.timeout(15000) }); } catch { throw new TosanoError('Recipe source unreachable', 'RECIPES_UNAVAILABLE'); }
    if (![429, 503].includes(r.status) || attempt >= 4) break;
    const wait = Math.min(60, Number(r.headers?.get?.('retry-after')) || 5 * (attempt + 1));
    await new Promise(res => setTimeout(res, wait * 1000));
  }
  if (!r.ok) throw new TosanoError('Recipe source error ' + r.status, 'RECIPES_UNAVAILABLE');
  const value = await r.json(); cache.set(key, { at: Date.now(), value }); return value;
}

/** Strip wiki markup: [[a|b]] -> b, '''x''' -> x, templates, refs, html. */
export function wikiToText(s = '') {
  return s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '').replace(/<[^>]+>/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '').replace(/\[\[(?:File|Immagine|Image|Categoria|Category):[^\]]*\]\]/gi, '')
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/\[https?:\/\/\S+ ([^\]]*)\]/g, '$1')
    .replace(/'''?/g, '').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g, ' ').trim();
}
function section(wikitext, names) {
  const re = new RegExp(`^==+\\s*(?:${names.join('|')})\\s*==+\\s*$`, 'im');
  const m = wikitext.match(re); if (!m) return null;
  const rest = wikitext.slice(m.index + m[0].length);
  const end = rest.search(/^==+[^=].*==+\s*$/m);
  return end >= 0 ? rest.slice(0, end) : rest;
}

const UNITS = { g: 'g', gr: 'g', grammi: 'g', kg: 'kg', chili: 'kg', ml: 'ml', cl: 'cl', dl: 'dl', l: 'l', litro: 'l', litri: 'l',
  cucchiaio: 'cucchiaio', cucchiai: 'cucchiaio', cucchiaino: 'cucchiaino', cucchiaini: 'cucchiaino', bicchiere: 'bicchiere', bicchieri: 'bicchiere',
  tazza: 'tazza', tazze: 'tazza', spicchio: 'spicchio', spicchi: 'spicchio', pizzico: 'pizzico', mazzetto: 'mazzetto', ciuffo: 'ciuffo',
  foglia: 'foglia', foglie: 'foglia', fetta: 'fetta', fette: 'fetta', bustina: 'bustina', bustine: 'bustina', confezione: 'confezione', vasetto: 'vasetto', scatola: 'scatola', lattina: 'lattina', rametto: 'rametto' };
const PANTRY = /\b(sale|pepe|olio|acqua|zucchero|aceto|noce moscata|origano|peperoncino|bicarbonato)\b/i;
const frac = s => s.includes('/') ? s.split('/').reduce((a, b) => Number(a) / Number(b)) : Number(s.replace(',', '.'));

/** "500 g di spaghetti", "4 tuorli", "2 cucchiai d'olio", "pecorino q.b." */
export function parseIngredient(line) {
  let raw = wikiToText(line.replace(/^[*#:\s]+/, '')).replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const optional = /\b(facoltativ[oaie]|a piacere|q\.?\s?b\.?|quanto basta)\b/i.test(raw);
  // "3-4 tuorli" / "2 o 3 patate": keep the upper bound (enough for the recipe).
  let s = raw.replace(/\([^)]*\)/g, ' ').replace(/\b(q\.?\s?b\.?|quanto basta|a piacere)\b/gi, ' ').trim()
    .replace(/^(\d+(?:[.,]\d+)?)\s*(?:-|o|\/)\s*(\d+(?:[.,]\d+)?)(?=\s)/i, '$2');
  let quantity = null, unit = null;
  const m = s.match(/^(\d+(?:[.,]\d+)?(?:\/\d+)?|mezz[oa]|un[oa]?|un')\s*(?:-\s*\d+\s*)?([a-zàèéìòù.]+)?\s*/i);
  if (m) {
    const q = m[1].toLowerCase();
    quantity = /^mezz/.test(q) ? 0.5 : /^un/.test(q) ? 1 : frac(q);
    const u = (m[2] ?? '').replace(/\.$/, '').toLowerCase();
    if (UNITS[u]) { unit = UNITS[u]; s = s.slice(m[0].length); }
    else s = s.slice(m[1].length).trim();
  }
  const name = s.replace(/^(di|d'|del|della|dei|degli|delle|dello)\s*/i, '').replace(/[,;.]\s*$/, '').trim().slice(0, 120);
  if (!name) return null;
  return { raw: raw.slice(0, 200), name, quantity: Number.isFinite(quantity) ? quantity : null, unit, optional, pantry: PANTRY.test(name) };
}

/** {{Categorie della ricetta|Dolci al cucchiaio|...}} and [[Categoria:Spaghetti|...]] */
export function wikiCategories(wikitext = '') {
  const out = new Set();
  for (const m of wikitext.matchAll(/\{\{\s*Categorie della ricetta\s*\|([^}]*)\}\}/gi))
    for (const c of m[1].split('|')) if (c.trim() && !c.includes('=')) out.add(c.trim());
  for (const m of wikitext.matchAll(/\[\[\s*Categoria\s*:\s*([^\]|]+)/gi)) out.add(m[1].trim());
  return [...out].slice(0, 10);
}

export function parseRecipe(title, wikitext) {
  const ing = section(wikitext, ['Ingredienti']);
  const prep = section(wikitext, ['Preparazione', 'Procedimento', 'Esecuzione']);
  const servingsM = (ing ?? wikitext).match(/per\s+'*\s*(\d{1,2})\s*'*\s*person/i);
  const ingredients = (ing ?? '').split('\n').filter(l => /^\s*[*#]/.test(l)).map(parseIngredient).filter(Boolean);
  return { title: title.replace(PREFIX, ''), servings: servingsM ? Number(servingsM[1]) : null, ingredients,
    preparation: prep ? wikiToText(prep).replace(/\n{2,}/g, '\n').slice(0, 2500) : null,
    categories: wikiCategories(wikitext), url: pageUrl(title), source: RECIPE_SOURCE, ...(ingredients.length ? {} : { warning: 'Ingredienti non strutturati in questa pagina: aprire il link.' }) };
}

export async function searchRecipes(query, { limit = 8 } = {}, fetchImpl = globalThis.fetch) {
  if (typeof query !== 'string' || !query.trim() || query.length > 120) throw new TosanoError('Invalid recipe query', 'INVALID_ARGUMENT');
  const d = await api({ action: 'query', list: 'search', srsearch: `${query.trim()} prefix:${PREFIX}`, srnamespace: 0, srlimit: Math.min(20, limit) }, fetchImpl);
  const results = (d?.query?.search ?? []).filter(x => x.title.startsWith(PREFIX))
    .map(x => ({ title: x.title.replace(PREFIX, ''), pageTitle: x.title, snippet: wikiToText(String(x.snippet ?? '')).replace(/searchmatch/g, '').slice(0, 200), url: pageUrl(x.title) }));
  return { query, results, source: RECIPE_SOURCE };
}
export async function getRecipe(pageTitle, fetchImpl = globalThis.fetch) {
  const title = pageTitle.startsWith(PREFIX) ? pageTitle : PREFIX + pageTitle;
  if (title.length > 200 || /[\[\]{}|#<>]/.test(title)) throw new TosanoError('Invalid recipe title', 'INVALID_ARGUMENT');
  const d = await api({ action: 'parse', page: title, prop: 'wikitext', redirects: 1 }, fetchImpl);
  const wt = d?.parse?.wikitext;
  if (typeof wt !== 'string') throw new TosanoError('Recipe not found', 'RECIPE_NOT_FOUND');
  return parseRecipe(d.parse.title ?? title, wt);
}
/** All cookbook page titles (paginated allpages). */
export async function listAllRecipeTitles(fetchImpl = globalThis.fetch, { max = 5000 } = {}) {
  const titles = []; let cont = null;
  do {
    const d = await api({ action: 'query', list: 'allpages', apprefix: PREFIX, apnamespace: 0, aplimit: 500, ...(cont ? { apcontinue: cont } : {}) }, fetchImpl);
    for (const p of d?.query?.allpages ?? []) titles.push(p.title);
    cont = d?.continue?.apcontinue ?? null;
  } while (cont && titles.length < max);
  return titles.filter(t => t.startsWith(PREFIX) && !t.slice(PREFIX.length).includes('/'));
}
/** Wikitext of up to 50 pages in one request. Returns [{title, wikitext}]. */
export async function fetchWikitexts(titles, fetchImpl = globalThis.fetch) {
  const d = await api({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: titles.slice(0, 50).join('|'), redirects: 1 }, fetchImpl);
  return (d?.query?.pages ?? []).filter(p => !p.missing && p.revisions?.[0])
    .map(p => ({ title: p.title, wikitext: p.revisions[0].slots?.main?.content ?? p.revisions[0].content ?? '' }));
}
/** Scale quantities to the wanted number of servings. */
export function scaleRecipe(recipe, servings) {
  if (!recipe.servings || !servings || servings === recipe.servings) return recipe;
  const k = servings / recipe.servings;
  return { ...recipe, servings, scaledFrom: recipe.servings,
    ingredients: recipe.ingredients.map(i => i.quantity === null ? i : { ...i, quantity: Math.round(i.quantity * k * 100) / 100 }) };
}
