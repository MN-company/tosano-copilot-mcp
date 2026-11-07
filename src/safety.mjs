/** Dietary safety engine. Fail-closed: missing evidence is never clearance.
 * Verdicts: 'bloccato' | 'da_verificare' | 'nessun_conflitto_con_le_tue_regole' (never "safe").
 * Severity: 'grave' (allergy: traces block, missing explicit declaration needs review)
 *           'intolleranza' (ingredients block, traces need review).
 */
import { allergenInfo, findTerms } from './allergens.mjs';

const RANK = { nessun_conflitto_con_le_tue_regole: 0, da_verificare: 1, bloccato: 2 };
const worst = (a, b) => (RANK[b] > RANK[a] ? b : a);
const fold = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('it');

function evalRule(rule, product, override) {
  const info = allergenInfo(rule.key);
  if (!info) return { key: rule.key, verdict: 'da_verificare', reasons: ['Regola sconosciuta'] };
  const label = product.label ?? {};
  const decl = label.declared;
  const ingRaw = label.ingredients ?? (typeof product.ingredients === 'string' ? product.ingredients : null);
  // Precautionary sentences are evaluated as traces, not as ingredients.
  const ing = ingRaw ? ingRaw.replace(/(pu[oò] contenere|potrebbe contenere|tracce di|prodotto in uno stabilimento|lavorat[oa] in uno stabilimento)[^.\n]*/gi, ' ') : null;
  const name = [product.name, product.sizeLabel].filter(Boolean).join(' ');
  const off = product.off ?? null;
  const reasons = [], sources = [];
  let verdict = 'nessun_conflitto_con_le_tue_regole';
  const block = (why, src) => { verdict = 'bloccato'; reasons.push(why); sources.push(src); };
  const review = why => { verdict = worst(verdict, 'da_verificare'); reasons.push(why); };

  if (info.basis === 'eu_1169_2011_annex_ii') {
    if (decl?.containsKeys?.includes(rule.key)) block(`Dichiarato in etichetta: contiene ${info.label}`, 'tosano_product_page');
    if (decl?.containsKeys?.includes(rule.key) && decl?.notContainsKeys?.includes(rule.key))
      reasons.push('Etichetta contraddittoria ("contiene" e "non contiene" insieme): vale il blocco');
    const inIng = findTerms(rule.key, ing); if (inIng.length) block(`Ingredienti: ${inIng.join(', ')}`, 'tosano_product_page');
    const inName = findTerms(rule.key, name); if (inName.length) block(`Nome prodotto: ${inName.join(', ')}`, 'tosano_product_page');
    const traceDecl = decl?.mayContainKeys?.includes(rule.key);
    const traceText = (label.precautions ?? []).some(s => findTerms(rule.key, s).length);
    if (traceDecl || traceText) {
      if (rule.severity === 'grave') block(`Possibili tracce di ${info.label}`, 'tosano_product_page');
      else review(`Possibili tracce di ${info.label} (intolleranza: decidi tu)`);
    }
    if (!ing && !decl) {
      if (off?.found) {
        if (off.allergens.includes(rule.key)) block(`Open Food Facts: contiene ${info.label}`, 'openfoodfacts');
        else if (off.traces.includes(rule.key)) { if (rule.severity === 'grave') block(`Open Food Facts: tracce di ${info.label}`, 'openfoodfacts'); else review(`Open Food Facts: tracce di ${info.label}`); }
        else review('Etichetta assente sul sito; solo dati Open Food Facts (community), non sufficienti per escludere');
      } else review('Ingredienti e allergeni non pubblicati sul sito');
    } else if (rule.severity === 'grave' && verdict !== 'bloccato' && !decl?.notContainsKeys?.includes(rule.key) && !decl)
      review(`Allergia grave: manca una dichiarazione allergeni esplicita (le tracce non sono obbligatorie per legge)`);
  } else {
    if (info.exemptIfName?.some(x => fold(name).includes(fold(x)))) return { key: rule.key, verdict, reasons: [`Nome dichiara: ${info.exemptIfName.find(x => fold(name).includes(fold(x)))}`], sources: ['tosano_product_page'], basis: info.basis };
    const hits = [...new Set([...findTerms(rule.key, name), ...findTerms(rule.key, ing), ...findTerms(rule.key, product.category)])];
    if (hits.length) block(`${info.label}: ${hits.join(', ')}`, 'dietary_heuristic');
    if (info.cannedRisk && /\b(in scatola|scatolame|lattina|latta)\b/i.test(fold(`${name} ${product.category ?? ''}`))) block('Nichel: alimento in scatola', 'dietary_heuristic');
    if (!ing && verdict !== 'bloccato') { if (rule.severity === 'grave') review('Ingredienti non pubblicati: impossibile valutare'); else reasons.push('Ingredienti non pubblicati; valutato solo il nome'); }
    if (info.note) reasons.push(info.note);
  }
  if (verdict === 'da_verificare' && override && override.keys.includes(rule.key) && override.labelHash === (label.labelHash ?? null)) {
    verdict = 'nessun_conflitto_con_le_tue_regole';
    reasons.push(`Confermato da te dopo verifica dell'etichetta il ${override.at.slice(0, 10)}`);
  }
  return { key: rule.key, label: info.label, severity: rule.severity, verdict, reasons, sources: [...new Set(sources)], basis: info.basis };
}

export function evaluateSafety(product, { dietaryRules = [], productOverrides = {} } = {}) {
  if (!dietaryRules.length) return { verdict: 'nessun_conflitto_con_le_tue_regole', rules: [], note: 'Nessuna regola alimentare salvata.' };
  const override = productOverrides[String(product.productId)] ?? null;
  const rules = dietaryRules.map(r => evalRule(r, product, override));
  const verdict = rules.reduce((v, r) => worst(v, r.verdict), 'nessun_conflitto_con_le_tue_regole');
  return { verdict, rules, labelSource: product.label?.source ?? (product.off?.found ? 'openfoodfacts_only' : 'none'), labelHash: product.label?.labelHash ?? null,
    disclaimer: 'Controllo automatico su testo di etichetta pubblicato; non sostituisce la lettura della confezione. "nessun_conflitto" non significa sicuro.' };
}
