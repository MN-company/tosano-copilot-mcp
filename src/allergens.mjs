/** Allergen and intolerance knowledge base.
 *
 * EU: the 14 substances of Annex II, Regulation (EU) No 1169/2011 (food information to
 * consumers), with Italian label terms and common derivatives. Annex II exemptions
 * (e.g. wheat-based glucose syrups, fully refined soybean oil, whey for distillates)
 * are deliberately NOT applied: a mention still flags, the user decides.
 *
 * Non-EU entries (nickel, histamine, lactose, polyols) are not declared on labels by
 * law. They are matched against product name, category and ingredient text using lists
 * from dietary practice. They are heuristics: they can flag, they never certify absence.
 */
const eu = (key, label, terms, extra = {}) => ({ key, label, basis: 'eu_1169_2011_annex_ii', terms, ...extra });
const heur = (key, label, terms, extra = {}) => ({ key, label, basis: 'dietary_heuristic', terms, ...extra });

export const ALLERGENS = Object.freeze([
  eu('glutine', 'Cereali contenenti glutine', ['glutine', 'frumento', 'grano', 'farina di grano', 'grano tenero', 'grano duro', 'semola', 'semolino',
    'orzo', 'segale', 'avena', 'farro', 'kamut', 'khorasan', 'spelta', 'triticale', 'malto', 'seitan', 'cous cous', 'couscous', 'bulgur',
    'pangrattato', 'pane grattugiato', 'amido di frumento', 'fibra di frumento', 'germe di grano', 'crusca', 'gluten', 'wheat', 'barley', 'rye', 'oat']),
  eu('crostacei', 'Crostacei', ['crostacei', 'gambero', 'gamberi', 'gamberetti', 'mazzancolle', 'scampi', 'aragosta', 'astice', 'granchio', 'granseola', 'canocchie', 'surimi']),
  eu('uova', 'Uova', ['uovo', 'uova', 'tuorlo', 'albume', 'ovoalbumina', 'lisozima', 'egg']),
  eu('pesce', 'Pesce', ['pesce', 'tonno', 'salmone', 'merluzzo', 'acciughe', 'alici', 'sardine', 'sgombro', 'nasello', 'baccalà', 'stoccafisso', 'trota',
    'branzino', 'orata', 'pesce spada', 'colla di pesce', 'olio di pesce', 'surimi', 'fish']),
  eu('arachidi', 'Arachidi', ['arachidi', 'arachide', 'nocciolina', 'noccioline', 'burro di arachidi', 'olio di arachide', 'peanut']),
  eu('soia', 'Soia', ['soia', 'soja', 'lecitina di soia', 'tofu', 'tempeh', 'edamame', 'miso', 'salsa di soia', 'tamari', 'shoyu', 'soy']),
  eu('latte', 'Latte e prodotti a base di latte (incluso lattosio)', ['latte', 'lattosio', 'siero di latte', 'siero', 'caseina', 'caseinato', 'lattoalbumina',
    'lattoglobulina', 'burro', 'panna', 'yogurt', 'formaggio', 'formaggi', 'ricotta', 'mozzarella', 'mascarpone', 'grana', 'parmigiano', 'pecorino', 'kefir',
    'crema di latte', 'proteine del latte', 'milk', 'butter', 'cheese', 'cream']),
  eu('frutta_a_guscio', 'Frutta a guscio', ['frutta a guscio', 'mandorle', 'mandorla', 'nocciole', 'nocciola', 'noci', 'noce', 'anacardi', 'anacardo', 'noci pecan',
    'noci del brasile', 'pistacchi', 'pistacchio', 'noci macadamia', 'macadamia', 'noce del queensland', 'gianduia', 'gianduja', 'marzapane', 'pasta di mandorle',
    'pralinato', 'nuts', 'almond', 'hazelnut', 'walnut', 'cashew', 'pistachio']),
  eu('sedano', 'Sedano', ['sedano', 'sedano rapa', 'celery']),
  eu('senape', 'Senape', ['senape', 'mostarda', 'mustard']),
  eu('sesamo', 'Semi di sesamo', ['sesamo', 'tahina', 'tahin', 'gomasio', 'sesame']),
  eu('solfiti', 'Anidride solforosa e solfiti (> 10 mg/kg o 10 mg/l)', ['solfiti', 'solfito', 'anidride solforosa', 'metabisolfito', 'bisolfito', 'disolfito',
    'e220', 'e221', 'e222', 'e223', 'e224', 'e225', 'e226', 'e227', 'e228', 'sulphite', 'sulfite']),
  eu('lupini', 'Lupini', ['lupino', 'lupini', 'farina di lupino', 'lupin']),
  eu('molluschi', 'Molluschi', ['molluschi', 'cozze', 'cozza', 'vongole', 'vongola', 'ostriche', 'ostrica', 'calamari', 'calamaro', 'seppie', 'seppia', 'polpo',
    'moscardini', 'totani', 'capesante', 'lumache', 'chiocciole', 'fasolari', 'telline', 'mollusc']),
  heur('nichel', 'Nichel (dieta a basso contenuto di nichel)', ['cacao', 'cioccolato', 'soia', 'legumi', 'fagioli', 'fagiolini', 'piselli', 'lenticchie', 'ceci', 'fave',
    'lupini', 'arachidi', 'noci', 'nocciole', 'mandorle', 'pistacchi', 'anacardi', 'semi di girasole', 'semi di lino', 'sesamo', 'integrale', 'integrali',
    'avena', 'grano saraceno', 'miglio', 'crusca', 'germe di grano', 'pomodoro', 'pomodori', 'passata', 'pelati', 'spinaci', 'lattuga', 'cavolo', 'cavoli',
    'asparagi', 'funghi', 'cipolla', 'porro', 'porri', 'pere', 'kiwi', 'lamponi', 'ananas', 'frutta secca', 'crostacei', 'molluschi', 'cozze', 'vongole',
    'aringa', 'sgombro', 'tè', 'the ', 'liquirizia', 'lievito in polvere', 'agenti lievitanti', 'margarina'],
    { cannedRisk: true, note: 'Il contenuto di nichel non è dichiarato in etichetta. Valutazione per nome, categoria e ingredienti secondo le liste delle diete a basso nichel; anche lo scatolame è segnalato. Non è un\'analisi.' }),
  heur('istamina', 'Istamina (intolleranza / alimenti istamino-liberatori)', ['stagionato', 'stagionata', 'grana', 'parmigiano', 'pecorino', 'gorgonzola',
    'salame', 'salami', 'salumi', 'prosciutto crudo', 'speck', 'bresaola', 'tonno', 'sgombro', 'acciughe', 'alici', 'sardine', 'aringa', 'vino', 'birra',
    'aceto', 'crauti', 'fermentato', 'fermentati', 'pomodoro', 'spinaci', 'melanzane', 'avocado', 'fragole', 'agrumi', 'cioccolato', 'cacao', 'salsa di soia'],
    { note: 'Euristica sulle liste per intolleranza all\'istamina; il contenuto reale dipende da freschezza e conservazione.' }),
  heur('lattosio', 'Lattosio (intolleranza, non allergia al latte)', ['lattosio', 'latte', 'siero di latte', 'panna', 'burro', 'yogurt', 'ricotta', 'mozzarella',
    'mascarpone', 'formaggio fresco', 'crema di latte', 'latte in polvere'],
    { exemptIfName: ['senza lattosio', 'delattosato', 'zero lattosio', 'lactose free', 'ad alta digeribilità'],
      note: 'Per l\'intolleranza si accettano i prodotti dichiarati "senza lattosio" nel nome; per l\'allergia alle proteine del latte usa "latte".' }),
  heur('polioli', 'Polioli / sorbitolo (intolleranza)', ['sorbitolo', 'mannitolo', 'xilitolo', 'maltitolo', 'isomalto', 'eritritolo', 'lactitolo',
    'e420', 'e421', 'e953', 'e965', 'e966', 'e967', 'e968', 'polioli'])
]);
export const ALLERGEN_KEYS = Object.freeze(ALLERGENS.map(a => a.key));
const byKey = new Map(ALLERGENS.map(a => [a.key, a]));
export const allergenInfo = key => byKey.get(key) ?? null;

// Keep line breaks: label lines ("Senza glutine") end a negated phrase.
const fold = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('it').replace(/[ \t]+/g, ' ');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "senza glutine", "non contiene latte", "privo di uova" must not count as a mention.
 * Only the next 1-3 words are removed, so "senza zucchero, latte" still flags latte. */
export function stripNegations(text) {
  return fold(text).replace(/\b(senza|privo di|priva di|non contiene:?|free from|without)\s+([a-z']+(?: (?:di|a|e|da)?\s?[a-z']+){0,2}?)(?=\s*(?:[.,;:\n)]|$))/g, ' ');
}
export function findTerms(key, text) {
  const a = byKey.get(key); if (!a || !text) return [];
  const t = ' ' + stripNegations(text) + ' ';
  return [...new Set(a.terms.filter(term => new RegExp(`(^|[^a-z])${esc(fold(term).trim())}([^a-z]|$)`).test(t)))];
}
/** Map a free label name ("Frutta a guscio", "Nocciole", "Glutine") to KB keys. */
export function keysForLabelName(name) {
  const n = fold(name).trim(); if (!n) return [];
  return ALLERGENS.filter(a => a.basis === 'eu_1169_2011_annex_ii' && (fold(a.label).includes(n) || a.terms.some(t => fold(t) === n || n.includes(fold(t)))))
    .map(a => a.key);
}
