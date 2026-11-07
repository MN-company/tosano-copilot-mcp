import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIngredient, parseRecipe, scaleRecipe, searchRecipes, getRecipe, wikiToText } from '../src/recipes.mjs';
import { parseSize, packsNeeded, ingredientQuery, buildBasket } from '../src/basket.mjs';
import { parseNutrition, glycemicEstimate, basketGlycemic, categoryGi } from '../src/glycemic.mjs';
import { productView } from '../src/sanitize.mjs';

// Wikitext shape of it.wikibooks.org "Libro di cucina/Ricette/Spaghetti alla carbonara" (shortened).
const WT = `{{Interprogetto|w=Pasta alla carbonara}}
== Ingredienti ==
per '''4''' persone:

* 500 g di spaghetti
* 200 g di [[guanciale]] (o pancetta)
* 3-4 tuorli
* pecorino grattugiato q.b.
* pepe nero macinato al momento
* 2 cucchiai di olio extravergine

Un piatto abbastanza semplice...
== Preparazione ==
Soffriggere a fuoco lento il '''guanciale'''.
== Note ==
x`;

test('recipe parser: servings, ingredients, preparation, attribution', () => {
  const r = parseRecipe('Libro di cucina/Ricette/Spaghetti alla carbonara', WT);
  assert.equal(r.title, 'Spaghetti alla carbonara');
  assert.equal(r.servings, 4);
  assert.deepEqual(r.ingredients.map(i => [i.name, i.quantity, i.unit]), [
    ['spaghetti', 500, 'g'], ['guanciale', 200, 'g'], ['tuorli', 4, null], ['pecorino grattugiato', null, null],
    ['pepe nero macinato al momento', null, null], ['olio extravergine', 2, 'cucchiaio']]);
  assert.equal(r.ingredients[3].optional, true);
  assert.equal(r.ingredients[4].pantry, true);
  assert.equal(r.preparation, 'Soffriggere a fuoco lento il guanciale.');
  assert.equal(r.source.license, 'CC BY-SA 4.0');
  assert.match(r.url, /^https:\/\/it\.wikibooks\.org\/wiki\/Libro_di_cucina\/Ricette\/Spaghetti_alla_carbonara$/);
  assert.equal(scaleRecipe(r, 2).ingredients[0].quantity, 250);
  assert.equal(wikiToText("[[File:x.jpg]]'''a''' [[b|c]]"), 'a c');
});

test('recipe search only returns cookbook pages and attributes the source', async () => {
  const fetchImpl = async u => ({ ok: true, json: async () => (u.searchParams.get('list') === 'search'
    ? { query: { search: [{ title: 'Libro di cucina/Ricette/Frittata di zucchine', snippet: 'con <span class="searchmatch">zucchine</span>' }, { title: 'Utente:Prova' }] } }
    : { parse: { title: 'Libro di cucina/Ricette/Frittata di zucchine', wikitext: WT } }) });
  const s = await searchRecipes('frittata zucchine', {}, fetchImpl);
  assert.deepEqual(s.results.map(x => x.title), ['Frittata di zucchine']);
  assert.ok(String(fetchImpl).length && s.source.name.includes('Wikibooks'));
  const r = await getRecipe('Frittata di zucchine', fetchImpl);
  assert.equal(r.ingredients.length, 6);
  await assert.rejects(getRecipe('x]]{{evil', fetchImpl), { code: 'INVALID_ARGUMENT' });
});

test('pack sizes and packs needed', () => {
  assert.deepEqual(parseSize('GR. 80 X 6 PZ.'), { grams: 480 });
  assert.deepEqual(parseSize('KG. 1'), { grams: 1000 });
  assert.deepEqual(parseSize('LT. 1,5'), { ml: 1500 });
  assert.equal(packsNeeded({ quantity: 700, unit: 'g' }, { sizeLabel: 'GR. 500' }).packs, 2);
  assert.equal(packsNeeded({ quantity: 1, unit: 'l' }, { sizeLabel: 'ML 500' }).packs, 2);
  assert.equal(packsNeeded({ quantity: null }, { sizeLabel: 'GR. 400' }).packs, 1);
  assert.equal(ingredientQuery('pecorino grattugiato'), 'pecorino');
});

test('basket: skips pantry, never adds blocked or optional items to the plan, estimates total', async () => {
  const products = {
    spaghetti: [{ productId: 1, slug: 'spaghetti', name: 'SPAGHETTI', sizeLabel: 'GR. 500', unitPrice: 1.2, compatibility: 'not_blocked_by_configured_rules' }],
    guanciale: [{ productId: 2, slug: 'guanciale', name: 'GUANCIALE', sizeLabel: 'GR. 150', unitPrice: 3, compatibility: 'blocked' }],
    pecorino: [{ productId: 3, slug: 'pecorino', name: 'PECORINO', sizeLabel: 'GR. 200', unitPrice: 4 }]
  };
  const r = parseRecipe('Libro di cucina/Ricette/X', WT);
  const b = await buildBasket(r.ingredients, { search: async q => ({ results: products[q] ?? [] }) });
  assert.deepEqual(b.skipped.map(s => s.ingredient), ['pepe nero macinato al momento', 'olio extravergine']);
  assert.equal(b.lines.find(l => l.ingredient === 'guanciale').status, 'bloccato_dalle_tue_regole');
  assert.equal(b.lines.find(l => l.ingredient === 'tuorli').status, 'non_trovato');
  assert.deepEqual(b.cartPlanInput.addItems, [{ productId: 1, slug: 'spaghetti', quantity: 1 }]);
  assert.equal(b.estimatedTotal, 5.2);
});

test('nutrition parser reads both list and table labels', () => {
  assert.deepEqual(parseNutrition('<ul><li>Carboidrati: 63 g</li><li>di cui zuccheri: 38 g</li><li>Fibre: 2,8 g</li><li>Proteine: 5,8 g</li><li>Grassi: 23 g</li></ul>'),
    { carbs: 63, sugars: 38, fiber: 2.8, protein: 5.8, fat: 23 });
  assert.equal(parseNutrition('<table><tr><th></th><th>Per 100g</th></tr><tr><td>Carboidrati</td><td>16,8 g</td></tr></table>').carbs, 16.8);
  assert.equal(parseNutrition('<li>Energia: 100 kcal</li>'), null);
});

test('glycemic estimate: bands, category order, honest when data is missing', () => {
  const p = (name, carbs, extra = {}) => ({ name, label: { nutrition: carbs === null ? null : { carbs, sugars: null, fiber: null, ...extra } } });
  const pasta = glycemicEstimate(p('SPAGHETTI N.5', 71));
  assert.deepEqual([pasta.band, pasta.glycemicLoad, pasta.category], ['alto', 27.8, 'pasta di semola']);
  assert.equal(glycemicEstimate(p('CECI GR. 380', 16.8)).band, 'basso');
  assert.equal(glycemicEstimate(p('YOGURT BIANCO', 3)).band, 'trascurabile');
  assert.equal(categoryGi({ name: 'CIOCCOLATO AL LATTE' }).label, 'cioccolato');
  assert.equal(glycemicEstimate(p('PANE INTEGRALE', null)).band, 'non_stimabile');
  assert.equal(glycemicEstimate(p('DETERSIVO', 40)).band, 'non_stimabile');
  const fiber = glycemicEstimate(p('PASTA INTEGRALE', 64, { fiber: 7 }));
  assert.deepEqual(fiber.adjustments, ['fibre elevate (-15%)']);
  assert.match(pasta.note, /non è una misura/);
});

test('real Tosano label flows into the glycemic estimate through productView', () => {
  const v = productView({ productId: 5, name: 'CECI', description: 'GR. 380', metaData: { product_description: {
    ingredients: '<li>Ceci, acqua, sale</li>', nutritional_values: '<ul><li>Carboidrati: 16,8 g</li><li>Fibre: 6,4 g</li></ul>' } } });
  assert.equal(v.label.nutrition.carbs, 16.8);
  const s = basketGlycemic([glycemicEstimate(v), glycemicEstimate({ name: 'RISO', label: { nutrition: { carbs: 78 } } })]);
  assert.equal(s.verdict, 'contiene_prodotti_ad_alto_impatto');
  assert.equal(s.highImpact[0].name, 'RISO');
  assert.equal(s.coverage, 100);
});
