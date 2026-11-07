/** Estimated glycemic impact. NOT a measurement and NOT medical advice.
 *
 * Inputs: per-100 g nutrition published on the LaTuaSpesa product page, plus a typical
 * glycemic index for the food category taken from the international tables
 * (Atkinson, Foster-Powell, Brand-Miller: Diabetes Care 2008;31:2281 and
 * Am J Clin Nutr 2021;114:1625). Category GI is a typical value: real products vary
 * with recipe, cooking and portion.
 *
 * Glycemic load per portion = GI x available carbohydrate (g per portion) / 100.
 * Bands (standard): <=10 basso, 11-19 medio, >=20 alto.
 */
import { htmlToText } from './label.mjs';

// [match terms (name/category), GI, typical portion g/ml, label]. Order matters: specific first.
const GI_TABLE = [
  [['riso soffiato', 'gallette di riso', 'gallette'], 82, 25, 'gallette / riso soffiato'],
  [['corn flakes', 'cornflakes', 'fiocchi di mais'], 81, 30, 'corn flakes'],
  [['pure istantaneo', 'purè', 'fiocchi di patate'], 87, 150, 'purè istantaneo'],
  [['patatine', 'chips'], 56, 30, 'patatine'],
  [['patate'], 78, 150, 'patate bollite'],
  [['pasta integrale', 'spaghetti integrali', 'penne integrali'], 48, 80, 'pasta integrale'],
  [['gnocchi'], 68, 150, 'gnocchi'],
  [['spaghetti', 'penne', 'fusilli', 'maccheroni', 'rigatoni', 'farfalle', 'linguine', 'tagliatelle', 'pasta'], 49, 80, 'pasta di semola'],
  [['cous cous', 'couscous'], 65, 80, 'cous cous'],
  [['riso basmati', 'basmati'], 58, 80, 'riso basmati'],
  [['riso integrale'], 68, 80, 'riso integrale'],
  [['riso parboiled', 'parboiled'], 60, 80, 'riso parboiled'],
  [['riso'], 73, 80, 'riso bianco'],
  [['orzo perlato', 'orzo'], 28, 80, 'orzo perlato'],
  [['quinoa'], 53, 80, 'quinoa'],
  [['polenta', 'farina di mais'], 68, 80, 'polenta'],
  [['pane integrale'], 74, 50, 'pane integrale'],
  [['pane di segale', 'segale'], 58, 50, 'pane di segale'],
  [['pane', 'baguette', 'ciabatta', 'rosetta', 'panino', 'pancarre', 'pan carre', 'piadina'], 75, 50, 'pane bianco'],
  [['crackers', 'cracker'], 74, 25, 'crackers'],
  [['pizza'], 80, 150, 'pizza'],
  [['fiocchi d\'avena', 'avena'], 55, 40, 'fiocchi d\'avena (porridge)'],
  [['muesli'], 57, 40, 'muesli'],
  [['ceci'], 28, 150, 'ceci cotti'],
  [['lenticchie'], 32, 150, 'lenticchie cotte'],
  [['fagioli'], 24, 150, 'fagioli cotti'],
  [['piselli'], 51, 80, 'piselli'],
  [['mais dolce', 'mais'], 52, 80, 'mais dolce'],
  [['carote'], 39, 80, 'carote cotte'],
  [['zucca'], 64, 80, 'zucca'],
  [['anguria', 'cocomero'], 76, 150, 'anguria'],
  [['ananas'], 59, 120, 'ananas'],
  [['uva'], 59, 120, 'uva'],
  [['banane', 'banana'], 51, 120, 'banana'],
  [['mango'], 51, 120, 'mango'],
  [['kiwi'], 50, 120, 'kiwi'],
  [['arance', 'arancia'], 43, 120, 'arancia'],
  [['mele', 'mela'], 36, 120, 'mela'],
  [['pere', 'pera'], 38, 120, 'pera'],
  [['fragole'], 40, 120, 'fragole'],
  [['succo d\'arancia', 'spremuta'], 50, 200, 'succo d\'arancia'],
  [['succo', 'nettare'], 50, 200, 'succo di frutta'],
  [['cola', 'aranciata', 'bibita', 'gassosa', 'tè freddo', 'the freddo'], 59, 330, 'bibita zuccherata'],
  [['yogurt'], 41, 125, 'yogurt'],
  [['gelato'], 51, 80, 'gelato'],
  [['cioccolato'], 40, 25, 'cioccolato'],
  [['miele'], 61, 20, 'miele'],
  [['marmellata', 'confettura'], 51, 20, 'confettura'],
  [['biscotti', 'frollini'], 55, 30, 'biscotti'],
  [['fette biscottate'], 70, 30, 'fette biscottate'],
  // generic last: compound names (cioccolato al latte, senza zucchero) must match above first
  [['latte'], 39, 200, 'latte'],
  [['zucchero'], 65, 5, 'zucchero (saccarosio)']
];
export const GI_SOURCE = 'Valori tipici di categoria da Atkinson et al., Diabetes Care 2008 e Am J Clin Nutr 2021';

const fold = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const n = s => (s == null ? null : Number(String(s).replace(',', '.')));
/** Per-100 g values from the label's nutritional_values HTML (list or table). */
export function parseNutrition(html) {
  const t = htmlToText(html); if (!t) return null;
  const get = re => { const m = t.match(re); return m ? n(m[1]) : null; };
  const out = {
    carbs: get(/carboidrati[^0-9\n]*?(\d+(?:[.,]\d+)?)\s*g/i),
    sugars: get(/(?:di cui )?zuccheri[^0-9\n]*?(\d+(?:[.,]\d+)?)\s*g/i),
    fiber: get(/fibr[ae][^0-9\n]*?(\d+(?:[.,]\d+)?)\s*g/i),
    protein: get(/proteine[^0-9\n]*?(\d+(?:[.,]\d+)?)\s*g/i),
    fat: get(/grassi[^0-9\n]*?(\d+(?:[.,]\d+)?)\s*g/i)
  };
  return out.carbs === null ? null : out;
}
export function categoryGi(product) {
  const hay = ' ' + fold(`${product.name ?? ''} ${product.category ?? ''}`) + ' ';
  for (const [terms, gi, portion, label] of GI_TABLE)
    if (terms.some(t => new RegExp(`[^a-z]${fold(t).replace(/[.*+?^${}()|[\]\\']/g, '\\$&')}[^a-z]`).test(hay))) return { gi, portion, label };
  return null;
}
const band = gl => (gl <= 10 ? 'basso' : gl < 20 ? 'medio' : 'alto');

export function glycemicEstimate(product) {
  const nutrition = product.nutrition ?? product.label?.nutrition ?? null;
  const cat = categoryGi(product);
  const base = { productId: product.productId ?? null, name: product.name ?? null, estimate: true, source: GI_SOURCE };
  if (nutrition && nutrition.carbs !== null && nutrition.carbs < 5)
    return { ...base, band: 'trascurabile', glycemicLoad: 0, carbsPer100g: nutrition.carbs, note: 'Meno di 5 g di carboidrati per 100 g: impatto glicemico trascurabile.' };
  if (!cat) return { ...base, band: 'non_stimabile', carbsPer100g: nutrition?.carbs ?? null,
    note: nutrition ? 'Categoria senza IG di riferimento: valuta i carboidrati per porzione.' : 'Né valori nutrizionali né categoria di riferimento.' };
  const carbs = nutrition?.carbs ?? null;
  if (carbs === null) return { ...base, band: 'non_stimabile', categoryGi: cat.gi, category: cat.label,
    note: 'IG tipico della categoria noto, ma il sito non pubblica i carboidrati di questo prodotto.' };
  const perPortion = carbs * cat.portion / 100;
  let gl = cat.gi * perPortion / 100;
  const adjust = [];
  if (nutrition.fiber !== null && nutrition.fiber >= 6) { gl *= 0.85; adjust.push('fibre elevate (-15%)'); }
  if (nutrition.sugars !== null && carbs > 0 && nutrition.sugars / carbs > 0.6 && cat.gi < 60) { gl *= 1.1; adjust.push('zuccheri semplici elevati (+10%)'); }
  gl = Math.round(gl * 10) / 10;
  return { ...base, band: band(gl), glycemicLoad: gl, categoryGi: cat.gi, category: cat.label, portionG: cat.portion,
    carbsPerPortion: Math.round(perPortion * 10) / 10, adjustments: adjust,
    note: 'Stima del carico glicemico per porzione tipica; non è una misura né un consiglio medico.' };
}
/** Whole basket/cart: count bands, list the highest-impact items. */
export function basketGlycemic(estimates) {
  const counts = { basso: 0, medio: 0, alto: 0, trascurabile: 0, non_stimabile: 0 };
  for (const e of estimates) counts[e.band] = (counts[e.band] ?? 0) + 1;
  const high = estimates.filter(e => e.band === 'alto').sort((a, b) => b.glycemicLoad - a.glycemicLoad);
  const estimable = estimates.length - counts.non_stimabile;
  return { counts, highImpact: high.map(e => ({ productId: e.productId, name: e.name, glycemicLoad: e.glycemicLoad, category: e.category })),
    coverage: estimates.length ? Math.round(estimable / estimates.length * 100) : 0,
    verdict: high.length ? 'contiene_prodotti_ad_alto_impatto' : counts.medio ? 'impatto_moderato' : 'impatto_contenuto',
    note: 'Stima per porzioni tipiche, non misura. Copertura = prodotti stimabili sul totale.', source: GI_SOURCE };
}
