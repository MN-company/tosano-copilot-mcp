import test from 'node:test';
import assert from 'node:assert/strict';
import { RecipeStore, enrichRecipe, mealDbRecipe, importWikibooks, basketIngredients } from '../src/recipe-db.mjs';
import { parseRecipe, wikiCategories } from '../src/recipes.mjs';

const WT = `== Ingredienti ==
per 4 persone:
* 320 g di spaghetti
* 150 g di guanciale
* 4 tuorli
* 50 g di pecorino
== Preparazione ==
${'Cuocere la pasta e mantecare fuori dal fuoco con i tuorli e il pecorino. '.repeat(4)}
{{Categorie della ricetta| Primi piatti | Ricette a base di uova}}
[[Categoria:Spaghetti|Carbonara]]`;
const carbonara = parseRecipe('Libro di cucina/Ricette/Spaghetti alla carbonara', WT);

test('categories and enrichment: implicit gluten from pasta shapes, diet, quality', () => {
  assert.deepEqual(wikiCategories(WT), ['Primi piatti', 'Ricette a base di uova', 'Spaghetti']);
  const e = enrichRecipe(carbonara);
  assert.ok(e.allergens.includes('glutine') && e.allergens.includes('uova') && e.allergens.includes('latte'));
  assert.ok(!e.diet.includes('vegetariano') && !e.diet.includes('senza_glutine_negli_ingredienti'));
  assert.equal(e.quality, 100);
  const rice = enrichRecipe({ title: 'Pane di riso', ingredients: [{ name: 'farina di riso' }, { name: 'acqua' }, { name: 'sale' }], preparation: '' });
  assert.ok(!rice.allergens.includes('glutine') && rice.diet.includes('vegano'));
  assert.ok(enrichRecipe({ title: 'Pennette al pomodoro', ingredients: [{ name: 'pomodori' }] }).allergens.includes('glutine'));
});

test('search: FTS, diet, hides recipes conflicting with rules, personal recipes stay private', () => {
  const s = new RecipeStore(':memory:');
  s.upsert('wikibooks', { ...carbonara, sourceId: carbonara.title });
  s.upsert('wikibooks', { title: 'Zucchine trifolate', sourceId: 'z', ingredients: [{ name: 'zucchine' }, { name: 'aglio' }, { name: 'olio' }], preparation: 'x' });
  assert.equal(s.search({ query: 'carbonara' }).results[0].title, 'Spaghetti alla carbonara');
  const hidden = s.search({ query: 'spaghetti', excludeAllergens: ['glutine'] });
  assert.deepEqual([hidden.results.length, hidden.hiddenByYourRules], [0, 1]);
  assert.deepEqual(s.search({ diet: 'vegano' }).results.map(r => r.title), ['Zucchine trifolate']);
  const mine = s.savePersonal('p1', { title: 'Lasagna della nonna', servings: 6, ingredients: ['500 g di lasagne', '300 g di ragù'], preparation: 'strati' });
  assert.match(mine.id, /^personale:/);
  assert.equal(s.search({ query: 'nonna', profileId: 'p1' }).results.length, 1);
  assert.equal(s.search({ query: 'nonna', profileId: 'p2' }).results.length, 0);
  assert.equal(s.get(mine.id, 'p2'), null);
  assert.equal(s.get(mine.id, 'p1').ingredients[0].quantity, 500);
  assert.deepEqual(s.deletePersonal(mine.id, 'p2'), { deleted: false });
  assert.deepEqual(s.deletePersonal(mine.id, 'p1'), { deleted: true });
  assert.throws(() => s.search({ query: '"; DROP' }) && s.search({ query: '***' }), /letters or digits/);
});

test('TheMealDB mapping: measures, Italian names for the basket, attribution url', () => {
  const r = mealDbRecipe({ idMeal: '52982', strMeal: 'Spaghetti alla Carbonara', strCategory: 'Pasta', strArea: 'Italian', strInstructions: 'Boil.\r\nMix.',
    strIngredient1: 'Spaghetti', strMeasure1: '320g', strIngredient2: 'Egg Yolks', strMeasure2: '4', strIngredient3: 'Olive Oil', strMeasure3: '1 tbsp', strIngredient4: '' });
  assert.deepEqual(r.ingredients.map(i => [i.name, i.quantity, i.unit, i.nameIt]), [['Spaghetti', 320, 'g', 'spaghetti'], ['Egg Yolks', 4, null, 'tuorli'], ['Olive Oil', 1, 'cucchiaio', 'olio extravergine di oliva']]);
  assert.equal(r.url, 'https://www.themealdb.com/meal/52982');
  assert.deepEqual(basketIngredients(r).map(i => i.name), ['spaghetti', 'tuorli', 'olio extravergine di oliva']);
  assert.ok(enrichRecipe(r).allergens.includes('uova'));
});

test('Wikibooks import paginates, batches and skips pages without ingredients', async () => {
  const fetchImpl = async u => ({ ok: true, status: 200, json: async () => {
    if (u.searchParams.get('list') === 'allpages') return u.searchParams.get('apcontinue')
      ? { query: { allpages: [{ title: 'Libro di cucina/Ricette/Vuota' }, { title: 'Libro di cucina/Ricette/X/Sottopagina' }] } }
      : { continue: { apcontinue: 'V' }, query: { allpages: [{ title: 'Libro di cucina/Ricette/Spaghetti alla carbonara' }] } };
    return { query: { pages: u.searchParams.get('titles').split('|').map(t => ({ title: t, revisions: [{ slots: { main: { content: t.endsWith('Vuota') ? 'testo' : WT } } }] })) } };
  } });
  const s = new RecipeStore(':memory:');
  assert.deepEqual(await importWikibooks(s, { fetchImpl, delayMs: 0 }), { source: 'wikibooks', imported: 1, skipped: 1 });
  assert.equal(s.stats().bySource.wikibooks.recipes, 1);
});
