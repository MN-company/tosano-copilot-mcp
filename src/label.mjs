/** Parse the label text LaTuaSpesa publishes in metaData.product_description (HTML). */
import { createHash } from 'node:crypto';
import { keysForLabelName } from './allergens.mjs';
import { parseNutrition } from './glycemic.mjs';

const MAX = 6000;
export function htmlToText(html) {
  if (typeof html !== 'string') return null;
  const t = html.replace(/<\s*(br|\/li|\/p|\/tr|\/div)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();
  return t ? t.slice(0, MAX) : null;
}
const split = s => s.split(/[,;]| e (?=[a-zàèéìòù])|\//i).map(x => x.replace(/^(tracce di|di)\s+/i, '').trim()).filter(Boolean);
/** "Contiene: Latte\nPotrebbe contenere: Soia\nNon contiene: Glutine" */
export function parseAllergenDeclaration(text) {
  if (!text) return null;
  const out = { contains: [], mayContain: [], notContains: [] };
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(contiene|potrebbe contenere|pu[oò] contenere|non contiene)\s*:\s*(.+)$/i);
    if (!m) continue;
    const k = m[1].trim().toLowerCase();
    const field = k.startsWith('non') ? 'notContains' : k === 'contiene' ? 'contains' : 'mayContain';
    out[field].push(...split(m[2]));
  }
  return out.contains.length || out.mayContain.length || out.notContains.length ? out : null;
}
/** Precautionary sentences inside ingredients ("Può contenere tracce di soia e senape"). */
export function precautionarySentences(text) {
  if (!text) return [];
  return [...text.matchAll(/(pu[oò] contenere|potrebbe contenere|tracce di|prodotto in uno stabilimento[^.\n]*|lavorat[oa] in uno stabilimento[^.\n]*)[^.\n]*/gi)].map(m => m[0].trim());
}
export function labelFromProduct(raw = {}) {
  const pd = raw?.metaData?.product_description ?? {};
  const ingredients = htmlToText(pd.ingredients);
  const allergensText = htmlToText(pd.allergens);
  const decl = parseAllergenDeclaration(allergensText);
  const precautions = precautionarySentences(ingredients);
  const toKeys = list => [...new Set((list ?? []).flatMap(keysForLabelName))];
  const present = Boolean(ingredients || decl);
  return {
    nutrition: parseNutrition(pd.nutritional_values),
    source: present ? 'tosano_product_page' : null,
    ingredients, allergensText, precautions,
    declared: decl ? { contains: decl.contains, mayContain: decl.mayContain, notContains: decl.notContains,
      containsKeys: toKeys(decl.contains), mayContainKeys: toKeys(decl.mayContain), notContainsKeys: toKeys(decl.notContains) } : null,
    labelHash: present ? createHash('sha256').update(JSON.stringify([ingredients, allergensText])).digest('hex').slice(0, 24) : null
  };
}
