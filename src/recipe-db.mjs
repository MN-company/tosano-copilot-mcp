/** Local recipe database (SQLite + FTS5).
 *
 * Sources, all with a real licence or owned by the user:
 *  - wikibooks: it.wikibooks.org "Libro di cucina", CC BY-SA 4.0 (Italian)
 *  - themealdb: TheMealDB free API, attribution required (English, translated names kept separately)
 *  - personale: recipes the user saved; private, never exported
 * Sites that forbid crawling (robots.txt / terms) are NOT imported.
 *
 * Every recipe is enriched at import: possible allergens (heuristic, from ingredient
 * names), diet tags, quality score. Search can hide recipes that conflict with the
 * profile's dietary rules. Recipe allergens are a pre-filter only: the real check is
 * done on each Tosano product label when the basket is built.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ALLERGEN_KEYS, findTerms } from './allergens.mjs';
import { safeFtsQuery } from './agent-db.mjs';
import { parseIngredient, parseRecipe, listAllRecipeTitles, fetchWikitexts, RECIPE_SOURCE } from './recipes.mjs';
import { TosanoError } from './client.mjs';

const ROOT = path.join(os.homedir(), '.tosano-copilot');
export const SOURCES = Object.freeze({
  wikibooks: RECIPE_SOURCE,
  themealdb: Object.freeze({ name: 'TheMealDB', license: 'Uso gratuito con attribuzione (TheMealDB API)', licenseUrl: 'https://www.themealdb.com/api.php', lang: 'en' }),
  personale: Object.freeze({ name: 'Ricette personali', license: 'privata (solo questo profilo)', licenseUrl: null })
});

const fold = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const MEAT = ['carne', 'manzo', 'vitello', 'maiale', 'pollo', 'tacchino', 'agnello', 'abbacchio', 'capretto', 'coniglio', 'anatra', 'prosciutto', 'pancetta',
  'guanciale', 'salsiccia', 'salame', 'speck', 'mortadella', 'bresaola', 'lardo', 'wurstel', 'ragu', 'brodo di carne', 'strutto',
  'beef', 'pork', 'chicken', 'turkey', 'lamb', 'bacon', 'ham', 'sausage', 'duck', 'veal', 'mince', 'chorizo', 'gelatin', 'gelatina', 'colla di pesce'];
const ANIMAL = ['miele', 'honey', 'egg', 'eggs'];
const hasAny = (text, terms) => terms.some(t => new RegExp(`(^|[^a-z])${fold(t)}([^a-z]|$)`).test(text));

// Recipe ingredient names hide allergens that labels spell out ("spaghetti" = wheat).
// Pre-filter only, deliberately over-inclusive: flagging too much is safe, missing is not.
const IMPLICIT = {
  glutine: ['pasta', 'spaghetti', 'spaghettini', 'penne', 'fusilli', 'maccheroni', 'rigatoni', 'linguine', 'tagliatelle', 'fettuccine', 'pappardelle', 'tagliolini',
    'lasagne', 'lasagna', 'tortellini', 'tortelli', 'ravioli', 'cappelletti', 'agnolotti', 'gnocchi', 'orecchiette', 'bucatini', 'trofie', 'pici', 'paccheri', 'ditalini',
    'tubetti', 'farfalle', 'pennette', 'pipette', 'fileja', 'sedanini', 'conchiglie', 'conchiglioni', 'mafaldine', 'strozzapreti', 'maltagliati',
    'tortiglioni', 'garganelli', 'cavatelli', 'malloreddus', 'lumache', 'stelline', 'anelletti', 'cannelloni', 'manicotti', 'calamarata', 'casarecce', 'gramigna',
    'bigoli', 'tajarin', 'pizzoccheri', 'passatelli', 'canederli', 'strangolapreti', 'culurgiones', 'scialatielli', 'ziti', 'mezzi rigatoni', 'timballo', 'pasticcio',
    'lasagnette', 'spatzle', 'crepes', 'crespelle', 'frittelle', 'impanato', 'impanati', 'panati', 'gratinato', 'torta', 'crostata', 'ciambella', 'muffin', 'brioche', 'mezze maniche', 'vermicelli', 'capellini', 'fregola', 'pastina', 'farina', 'pane', 'pan', 'panini', 'panino', 'mollica', 'crostini', 'pizza',
    'focaccia', 'savoiardi', 'biscotti', 'pan di spagna', 'grissini', 'crackers', 'piadina', 'pasta sfoglia', 'pasta frolla', 'pasta brisee', 'lievito madre', 'birra',
    'flour', 'bread', 'noodles', 'breadcrumbs', 'pastry', 'puff pastry', 'tortillas', 'beer', 'biscuits', 'macaroni', 'lasagne sheets', 'couscous'],
  latte: ['besciamella', 'bechamel', 'stracchino', 'gorgonzola', 'fontina', 'asiago', 'scamorza', 'provola', 'provolone', 'taleggio', 'caciocavallo', 'robiola',
    'crescenza', 'burrata', 'stracciatella', 'caprino', 'montasio', 'emmental', 'groviera', 'fiordilatte', 'parmesan', 'cheddar', 'feta', 'cream cheese', 'creme fraiche', 'ghee'],
  uova: ['savoiardi', 'pan di spagna', 'maionese', 'mayonnaise', 'frittata', 'pasta all\'uovo', 'meringa', 'meringhe', 'zabaione'],
  pesce: ['salmon', 'cod', 'anchovy', 'anchovies', 'tuna', 'haddock', 'mackerel', 'sardines', 'bottarga', 'colatura', 'fish sauce'],
  crostacei: ['prawns', 'shrimp', 'lobster', 'crab', 'langoustine'],
  molluschi: ['mussels', 'clams', 'squid', 'octopus', 'scallops', 'oysters']
};
// "farina di riso/mais/ceci..." is not wheat: removed before the glutine check only.
const NOT_WHEAT = /farina (?:di )?(?:riso|mais|ceci|castagne|grano saraceno|mandorle|cocco|lupini|tapioca|patate)|pane (?:senza glutine|di riso)|pasta (?:di riso|di mais|senza glutine|di mandorle)|rice noodles|rice flour|corn flour|cornflour|pan(?:e|i) carasau senza glutine/g;
export function enrichRecipe(r) {
  const text = fold([r.title, ...(r.categories ?? []), ...r.ingredients.map(i => [i.name, i.raw, i.nameIt].filter(Boolean).join(' '))].join('\n'));
  const allergens = ALLERGEN_KEYS.filter(k => findTerms(k, text).length
    || (IMPLICIT[k] && hasAny(k === 'glutine' ? text.replace(NOT_WHEAT, ' ') : text, IMPLICIT[k])));
  const meat = hasAny(text, MEAT) || allergens.some(k => ['pesce', 'crostacei', 'molluschi'].includes(k));
  const diet = [];
  if (!meat) diet.push('vegetariano');
  if (!meat && !allergens.some(k => ['latte', 'uova'].includes(k)) && !hasAny(text, ANIMAL)) diet.push('vegano');
  if (!allergens.includes('glutine')) diet.push('senza_glutine_negli_ingredienti');
  const withQty = r.ingredients.filter(i => i.quantity !== null).length;
  const quality = Math.round((r.ingredients.length >= 3 ? 30 : r.ingredients.length * 8)
    + (r.ingredients.length ? 30 * withQty / r.ingredients.length : 0)
    + ((r.preparation?.length ?? 0) >= 200 ? 25 : (r.preparation?.length ?? 0) / 8)
    + (r.servings ? 15 : 0));
  return { allergens, diet, quality: Math.min(100, quality) };
}

export class RecipeStore {
  constructor(filename = path.join(ROOT, 'recipes.sqlite')) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS recipes (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, profile_id TEXT, title TEXT NOT NULL, url TEXT, lang TEXT NOT NULL DEFAULT 'it',
        servings INTEGER, ingredients TEXT NOT NULL, preparation TEXT, categories TEXT NOT NULL DEFAULT '[]',
        allergens TEXT NOT NULL DEFAULT '[]', diet TEXT NOT NULL DEFAULT '[]', quality INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL, imported_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS recipes_source ON recipes(source);
      CREATE VIRTUAL TABLE IF NOT EXISTS recipes_fts USING fts5(id UNINDEXED, title, ingredients, categories, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS recipe_imports (source TEXT PRIMARY KEY, finished_at TEXT, imported INTEGER, skipped INTEGER);`);
  }
  upsert(source, r, { profileId = null, id = null } = {}) {
    const e = enrichRecipe(r);
    const rid = id ?? `${source}:${r.sourceId ?? r.title}`;
    const ing = JSON.stringify(r.ingredients);
    const hash = createHash('sha256').update(r.title + ing + (r.preparation ?? '')).digest('hex').slice(0, 16);
    const cats = r.categories ?? [];
    this.db.prepare(`INSERT INTO recipes (id,source,profile_id,title,url,lang,servings,ingredients,preparation,categories,allergens,diet,quality,content_hash,imported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,url=excluded.url,servings=excluded.servings,
      ingredients=excluded.ingredients,preparation=excluded.preparation,categories=excluded.categories,allergens=excluded.allergens,diet=excluded.diet,
      quality=excluded.quality,content_hash=excluded.content_hash,imported_at=excluded.imported_at`)
      .run(rid, source, profileId, r.title, r.url ?? null, r.lang ?? 'it', r.servings ?? null, ing, r.preparation ?? null, JSON.stringify(cats),
        JSON.stringify(e.allergens), JSON.stringify(e.diet), e.quality, hash, new Date().toISOString());
    this.db.prepare('DELETE FROM recipes_fts WHERE id=?').run(rid);
    this.db.prepare('INSERT INTO recipes_fts (id,title,ingredients,categories) VALUES (?,?,?,?)')
      .run(rid, r.title, r.ingredients.map(i => [i.name, i.nameIt].filter(Boolean).join(' ')).join(' | '), cats.join(' '));
    return { id: rid, ...e };
  }
  #row(x) {
    if (!x) return null;
    return { id: x.id, title: x.title, url: x.url, lang: x.lang, servings: x.servings, ingredients: JSON.parse(x.ingredients), preparation: x.preparation,
      categories: JSON.parse(x.categories), possibleAllergens: JSON.parse(x.allergens), diet: JSON.parse(x.diet), quality: x.quality, source: SOURCES[x.source] ?? { name: x.source } };
  }
  get(id, profileId = null) {
    const x = this.db.prepare('SELECT * FROM recipes WHERE id=?').get(String(id));
    if (!x || (x.source === 'personale' && x.profile_id !== profileId)) return null;
    return this.#row(x);
  }
  /** excludeAllergens: keys to hide; diet: 'vegetariano' | 'vegano' | 'senza_glutine_negli_ingredienti'. */
  search({ query = '', diet = null, source = null, excludeAllergens = [], minQuality = 0, limit = 8, profileId = null } = {}) {
    const lim = Math.min(Math.max(limit, 1), 20);
    const where = ['(r.source != \'personale\' OR r.profile_id = ?)', 'r.quality >= ?'], args = [profileId, minQuality];
    if (source) { where.push('r.source = ?'); args.push(source); }
    let sql;
    if (query.trim()) {
      sql = `SELECT r.*, bm25(recipes_fts, 0, 10, 3, 2) AS rank FROM recipes_fts JOIN recipes r ON r.id = recipes_fts.id
        WHERE recipes_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank - r.quality / 50.0 LIMIT 400`;
      args.unshift(safeFtsQuery(query));
    } else sql = `SELECT r.* FROM recipes r WHERE ${where.join(' AND ')} ORDER BY random() LIMIT 400`;
    const rows = this.db.prepare(sql).all(...args);
    let hidden = 0; const out = [];
    for (const x of rows) {
      const al = JSON.parse(x.allergens), dt = JSON.parse(x.diet);
      if (diet && !dt.includes(diet)) continue;
      const conflict = al.filter(k => excludeAllergens.includes(k));
      if (conflict.length) { hidden++; continue; }
      if (out.length < lim) out.push({ id: x.id, title: x.title, lang: x.lang, servings: x.servings, ingredientsCount: JSON.parse(x.ingredients).length,
        categories: JSON.parse(x.categories).slice(0, 4), possibleAllergens: al, diet: dt, quality: x.quality, url: x.url, source: SOURCES[x.source]?.name ?? x.source });
    }
    return { results: out, hiddenByYourRules: hidden };
  }
  deletePersonal(id, profileId) {
    const r = this.db.prepare("DELETE FROM recipes WHERE id=? AND source='personale' AND profile_id=?").run(String(id), profileId);
    if (r.changes) this.db.prepare('DELETE FROM recipes_fts WHERE id=?').run(String(id));
    return { deleted: r.changes > 0 };
  }
  stats() {
    const bySource = Object.fromEntries(this.db.prepare('SELECT source, COUNT(*) n, ROUND(AVG(quality)) q FROM recipes GROUP BY source').all().map(x => [x.source, { recipes: x.n, avgQuality: x.q }]));
    return { bySource, total: Object.values(bySource).reduce((a, b) => a + b.recipes, 0),
      imports: this.db.prepare('SELECT * FROM recipe_imports').all(), sources: SOURCES };
  }
  /** Recompute allergens/diet/quality after a knowledge-base change (no network). */
  reenrichAll() {
    const rows = this.db.prepare('SELECT * FROM recipes').all(); const upd = this.db.prepare('UPDATE recipes SET allergens=?, diet=?, quality=? WHERE id=?');
    for (const x of rows) { const e = enrichRecipe({ title: x.title, categories: JSON.parse(x.categories), ingredients: JSON.parse(x.ingredients), preparation: x.preparation, servings: x.servings });
      upd.run(JSON.stringify(e.allergens), JSON.stringify(e.diet), e.quality, x.id); }
    return { updated: rows.length };
  }
  markImport(source, imported, skipped) {
    this.db.prepare('INSERT INTO recipe_imports VALUES (?,?,?,?) ON CONFLICT(source) DO UPDATE SET finished_at=excluded.finished_at,imported=excluded.imported,skipped=excluded.skipped')
      .run(source, new Date().toISOString(), imported, skipped);
  }
  savePersonal(profileId, r) {
    if (!r?.title?.trim() || !Array.isArray(r.ingredients) || !r.ingredients.length) throw new TosanoError('Recipe needs title and ingredients', 'INVALID_ARGUMENT');
    const id = r.id && String(r.id).startsWith('personale:') ? r.id : `personale:${randomUUID()}`;
    if (r.id && !this.get(id, profileId)) throw new TosanoError('Recipe not found', 'RECIPE_NOT_FOUND');
    const ingredients = r.ingredients.map(i => typeof i === 'string' ? parseIngredient(i) : { raw: i.name, quantity: null, unit: null, optional: false, pantry: false, ...i }).filter(Boolean);
    return this.upsert('personale', { title: r.title.trim().slice(0, 150), servings: r.servings ?? null, ingredients, preparation: r.preparation?.slice(0, 5000) ?? null,
      categories: r.categories ?? [], url: r.url ?? null }, { profileId, id });
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BATCH = 20;
export async function importWikibooks(store, { fetchImpl = globalThis.fetch, delayMs = 1500, log = () => {} } = {}) {
  const titles = await listAllRecipeTitles(fetchImpl);
  log(`wikibooks: ${titles.length} pagine`);
  let imported = 0, skipped = 0;
  for (let i = 0; i < titles.length; i += BATCH) {
    for (const p of await fetchWikitexts(titles.slice(i, i + BATCH), fetchImpl)) {
      const r = parseRecipe(p.title, p.wikitext);
      if (r.ingredients.length < 2) { skipped++; continue; }
      store.upsert('wikibooks', { ...r, sourceId: r.title }); imported++;
    }
    log(`wikibooks: ${Math.min(i + BATCH, titles.length)}/${titles.length}`);
    if (delayMs) await sleep(delayMs);
  }
  store.markImport('wikibooks', imported, skipped);
  return { source: 'wikibooks', imported, skipped };
}

// Common TheMealDB ingredient names -> Italian, so baskets can search Tosano.
const EN_IT = { 'olive oil': 'olio extravergine di oliva', onion: 'cipolla', onions: 'cipolla', garlic: 'aglio', 'garlic clove': 'aglio', salt: 'sale', 'black pepper': 'pepe nero',
  pepper: 'pepe', butter: 'burro', 'unsalted butter': 'burro', eggs: 'uova', egg: 'uova', 'egg yolks': 'tuorli', milk: 'latte', 'double cream': 'panna', 'heavy cream': 'panna',
  'plain flour': 'farina', flour: 'farina', sugar: 'zucchero', 'caster sugar': 'zucchero', 'brown sugar': 'zucchero di canna', water: 'acqua', tomatoes: 'pomodori',
  'chopped tomatoes': 'polpa di pomodoro', 'tomato puree': 'concentrato di pomodoro', 'tomato passata': 'passata di pomodoro', potatoes: 'patate', carrots: 'carote',
  carrot: 'carote', celery: 'sedano', 'chicken breast': 'petto di pollo', 'chicken breasts': 'petto di pollo', chicken: 'pollo', 'chicken thighs': 'sovracosce di pollo',
  beef: 'manzo', 'minced beef': 'macinato di manzo', 'beef brisket': 'manzo', pork: 'maiale', lamb: 'agnello', bacon: 'pancetta', ham: 'prosciutto cotto', sausages: 'salsiccia',
  rice: 'riso', 'basmati rice': 'riso basmati', 'arborio rice': 'riso arborio', spaghetti: 'spaghetti', penne: 'penne', 'penne rigate': 'penne rigate', lasagne: 'lasagne',
  parmesan: 'parmigiano', 'parmesan cheese': 'parmigiano', mozzarella: 'mozzarella', 'mozzarella balls': 'mozzarella', ricotta: 'ricotta', 'cheddar cheese': 'formaggio cheddar',
  'feta': 'feta', lemon: 'limone', lemons: 'limone', 'lemon juice': 'succo di limone', lime: 'lime', orange: 'arancia', apples: 'mele', banana: 'banane', basil: 'basilico',
  'fresh basil': 'basilico', parsley: 'prezzemolo', oregano: 'origano', thyme: 'timo', rosemary: 'rosmarino', 'bay leaf': 'alloro', 'bay leaves': 'alloro', mint: 'menta',
  cinnamon: 'cannella', nutmeg: 'noce moscata', paprika: 'paprika', cumin: 'cumino', 'chilli powder': 'peperoncino', 'red chilli': 'peperoncino', ginger: 'zenzero',
  mushrooms: 'funghi', spinach: 'spinaci', courgettes: 'zucchine', zucchini: 'zucchine', aubergine: 'melanzane', 'red pepper': 'peperone rosso', 'green pepper': 'peperone verde',
  peas: 'piselli', chickpeas: 'ceci', lentils: 'lenticchie', 'kidney beans': 'fagioli rossi', 'cannellini beans': 'fagioli cannellini', broccoli: 'broccoli', cabbage: 'cavolo',
  leek: 'porro', 'spring onions': 'cipollotti', shallots: 'scalogno', salmon: 'salmone', tuna: 'tonno', prawns: 'gamberi', 'king prawns': 'gamberoni', cod: 'merluzzo',
  anchovy: 'acciughe', 'anchovy fillet': 'acciughe', mussels: 'cozze', clams: 'vongole', 'white wine': 'vino bianco', 'red wine': 'vino rosso', 'chicken stock': 'brodo di pollo',
  'vegetable stock': 'brodo vegetale', 'beef stock': 'brodo di manzo', honey: 'miele', yogurt: 'yogurt', 'greek yogurt': 'yogurt greco', 'cocoa': 'cacao', 'dark chocolate': 'cioccolato fondente',
  'baking powder': 'lievito per dolci', yeast: 'lievito', breadcrumbs: 'pangrattato', bread: 'pane', almonds: 'mandorle', walnuts: 'noci', 'pine nuts': 'pinoli', hazelnuts: 'nocciole',
  'vanilla extract': 'estratto di vaniglia', vinegar: 'aceto', 'balsamic vinegar': 'aceto balsamico', 'soy sauce': 'salsa di soia', mascarpone: 'mascarpone', 'sour cream': 'panna acida',
  'vegetable oil': 'olio di semi', 'sunflower oil': 'olio di semi di girasole', capers: 'capperi', olives: 'olive', 'black olives': 'olive nere', 'green olives': 'olive verdi', pancetta: 'pancetta' };
const UNIT_EN = [[/^(\d+(?:\.\d+)?)\s*(g|kg|ml|l)\b/i, (m) => ({ quantity: Number(m[1]), unit: m[2].toLowerCase() })],
  [/^(\d+(?:\.\d+)?)\s*(tbsp|tblsp|tablespoons?|tbs)\b/i, (m) => ({ quantity: Number(m[1]), unit: 'cucchiaio' })],
  [/^(\d+(?:\.\d+)?)\s*(tsp|teaspoons?)\b/i, (m) => ({ quantity: Number(m[1]), unit: 'cucchiaino' })],
  [/^(\d+(?:\.\d+)?)\s*(cups?)\b/i, (m) => ({ quantity: Number(m[1]), unit: 'tazza' })],
  [/^(\d+(?:\.\d+)?)\s*$/, (m) => ({ quantity: Number(m[1]), unit: null })]];
export function mealDbRecipe(m) {
  const ingredients = [];
  for (let i = 1; i <= 20; i++) {
    const name = String(m[`strIngredient${i}`] ?? '').trim(); if (!name) continue;
    const measure = String(m[`strMeasure${i}`] ?? '').trim();
    let q = { quantity: null, unit: null };
    for (const [re, f] of UNIT_EN) { const x = measure.match(re); if (x) { q = f(x); break; } }
    const it = EN_IT[name.toLowerCase()] ?? null;
    ingredients.push({ raw: `${measure} ${name}`.trim(), name, nameIt: it, ...q, optional: false, pantry: /^(salt|pepper|black pepper|water|olive oil|sugar|vegetable oil)$/i.test(name) });
  }
  return { sourceId: m.idMeal, title: m.strMeal, lang: 'en', servings: null, ingredients,
    preparation: String(m.strInstructions ?? '').replace(/\r/g, '').slice(0, 5000), categories: [m.strCategory, m.strArea].filter(Boolean),
    url: `https://www.themealdb.com/meal/${encodeURIComponent(m.idMeal)}` };
}
export async function importTheMealDB(store, { fetchImpl = globalThis.fetch, apiKey = '1', delayMs = 300, log = () => {} } = {}) {
  let imported = 0;
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    const r = await fetchImpl(`https://www.themealdb.com/api/json/v1/${encodeURIComponent(apiKey)}/search.php?f=${letter}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new TosanoError('TheMealDB error ' + r.status, 'RECIPES_UNAVAILABLE');
    for (const m of (await r.json())?.meals ?? []) { store.upsert('themealdb', mealDbRecipe(m)); imported++; }
    log(`themealdb: ${letter} (${imported})`);
    if (delayMs) await sleep(delayMs);
  }
  store.markImport('themealdb', imported, 0);
  return { source: 'themealdb', imported, skipped: 0 };
}
/** Ingredients ready for the Tosano basket: Italian name when known. */
export const basketIngredients = recipe => recipe.ingredients.map(i => ({ ...i, name: i.nameIt ?? i.name }));
