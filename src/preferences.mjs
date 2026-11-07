import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateSafety } from './safety.mjs';

export const DEFAULT_PREFS = Object.freeze({
  excludedBrands: [],
  excludedIngredients: [],
  excludedAllergens: [],
  blockPossibleTraces: true,
  shoppingPriority: 'value'
});
export function normalizePrefs(value = {}) {
  const list = (x, name) => {
    if (!Array.isArray(x) || x.length > 100 || !x.every(s => typeof s === 'string' && s.length < 100))
      throw new Error(`Invalid ${name}`);
    return [...new Set(x.map(s => s.trim()).filter(Boolean))];
  };
  if (typeof value.blockPossibleTraces !== 'boolean') throw new Error('blockPossibleTraces must be boolean');
  if (!['value', 'price', 'nutrition'].includes(value.shoppingPriority)) throw new Error('Invalid shoppingPriority');
  return {
    excludedBrands: list(value.excludedBrands, 'excludedBrands'),
    excludedIngredients: list(value.excludedIngredients, 'excludedIngredients'),
    excludedAllergens: list(value.excludedAllergens, 'excludedAllergens'),
    blockPossibleTraces: value.blockPossibleTraces,
    shoppingPriority: value.shoppingPriority
  };
}
export function checkProduct(product, prefs) {
  const blockers = [], unknown = [];
  const fold = s => String(s ?? '').normalize('NFKC').toLocaleLowerCase('it').trim();
  const category = fold(product.category);
  const scoped = (prefs.rules ?? []).filter(r => r.category === '*' || fold(r.category) === category ||
    fold(product.name).includes(fold(r.category)));
  const excludedBrands = [...(prefs.excludedBrands ?? []), ...scoped.filter(r=>r.kind==='excluded_brand').map(r=>r.value)];
  const excludedIngredients = [...(prefs.excludedIngredients ?? []), ...scoped.filter(r=>r.kind==='excluded_ingredient').map(r=>r.value)];
  const excludedAllergens = [...(prefs.excludedAllergens ?? []), ...scoped.filter(r=>r.kind==='excluded_allergen').map(r=>r.value)];
  if (excludedBrands.some(b => fold(b) === fold(product.brand))) blockers.push('Excluded brand');
  const hardPreferred = scoped.filter(r=>r.kind==='preferred_brand' && r.strength==='hard');
  if (hardPreferred.length && !hardPreferred.some(r=>fold(r.value)===fold(product.brand))) blockers.push('Required brand not matched');
  const requiredFormats = scoped.filter(r=>r.kind==='preferred_format' && r.strength==='hard');
  if (requiredFormats.length) {
    const declared=fold([product.name,product.sizeLabel].filter(Boolean).join(' '));
    if (!declared) unknown.push('Required product format not declared');
    else if (!requiredFormats.some(r=>declared.includes(fold(r.value))))
      blockers.push('Required package format not matched');
  }
  if (excludedIngredients.length || excludedAllergens.length) {
    if (!product.ingredients && !product.allergens) {
      unknown.push('Ingredients/allergen declaration missing from Tosano product data');
    } else {
      if (product.ingredients && excludedIngredients.some(x => fold(product.ingredients).includes(fold(x))))
        blockers.push('Excluded ingredient detected');
      if (Array.isArray(product.allergens) && excludedAllergens.some(x => product.allergens.some(y => fold(y) === fold(x))))
        blockers.push('Excluded allergen detected');
      // Explicitly written ingredient labels may reveal an excluded allergen even
      // when the site's structured allergens list is incomplete.
      if (typeof product.ingredients==='string' && excludedAllergens.some(x => fold(product.ingredients).includes(fold(x))))
        blockers.push('Excluded allergen term detected in ingredients declaration');
      if (!product.ingredients && excludedIngredients.length) unknown.push('Ingredient data missing');
      if (!Array.isArray(product.allergens) && excludedAllergens.length) unknown.push('Allergen data missing');
    }
  }
  // A "free from" result requires a verified trace declaration when the user
  // has opted to block possible traces. Missing fields are never proof of safety.
  if (excludedAllergens.length && (prefs.blockPossibleTraces ?? true)) {
    if (!Array.isArray(product.possibleTraces)) unknown.push('Possible-traces declaration missing');
    else if (excludedAllergens.some(x=>product.possibleTraces.some(y=>fold(y)===fold(x))))
      blockers.push('Excluded allergen detected in possible traces');
  }
  const safety = evaluateSafety(product, prefs);
  for (const r of safety.rules) {
    if (r.verdict === 'bloccato') blockers.push(`${r.label}: ${r.reasons[0]}`);
    else if (r.verdict === 'da_verificare') unknown.push(`${r.label}: ${r.reasons[0]}`);
  }
  return { result: blockers.length ? 'blocked' : unknown.length ? 'review_required' : 'not_blocked_by_configured_rules', blockers, unknown,
    ...(safety.rules.length ? { safety } : {}) };
}
export class PreferencesStore {
  constructor(file = path.join(os.homedir(), '.tosano-copilot', 'preferences.json')) { this.file = file; }
  async read() {
    try { return normalizePrefs({ ...DEFAULT_PREFS, ...JSON.parse(await fs.readFile(this.file, 'utf8')) }); }
    catch (e) { if (e.code === 'ENOENT') return structuredClone(DEFAULT_PREFS); throw e; }
  }
  async update(patch) {
    const old = await this.read();
    const next = normalizePrefs({ ...old, ...patch });
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600);
    return next;
  }
}
