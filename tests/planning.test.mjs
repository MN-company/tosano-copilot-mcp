import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/agent-db.mjs';
import { ProfileManager } from '../src/profile.mjs';
import { RecipeStore } from '../src/recipe-db.mjs';
import { suggestPlan, mergeIngredients, subtractPantry, analyzeHabits, rankSubstitutes, budgetStatus, priceInsight, weekStart } from '../src/planning.mjs';

test('household: member rules protect everything, strictest wins, loosening needs approval', () => {
  const store = new AgentStore(':memory:'), p = new ProfileManager(store, 'p');
  p.addDietaryRule('latte', 'intolleranza');
  assert.throws(() => p.addMember('Luca', [{ key: 'glutine', severity: 'grave' }]), { code: 'CONSENT_REQUIRED' });
  const { member } = p.addMember('Luca', [{ key: 'glutine', severity: 'grave' }, { key: 'latte', severity: 'grave' }], true);
  const rules = store.getPreferences('p').dietaryRules;
  assert.deepEqual(rules.map(r => [r.key, r.severity, r.who]).sort(), [['glutine', 'grave', ['Luca']], ['latte', 'grave', ['io', 'Luca']]]);
  assert.deepEqual(store.householdRules('p', ['io']).map(r => r.key), ['latte']);
  assert.equal(p.addMemberRule(member.id, 'glutine', 'intolleranza').unchanged, true);
  const plan = p.prepareChange({ type: 'member_rule_remove', memberId: member.id, key: 'glutine' });
  assert.equal(store.getPreferences('p').dietaryRules.length, 2, 'nothing changes before commit');
  assert.throws(() => p.commitChange(plan.planId, 'CONFERMO NOPE'), { code: 'APPROVAL_REQUIRED' });
  p.commitChange(plan.planId, plan.confirmationPhrase);
  assert.deepEqual(store.getPreferences('p').dietaryRules.map(r => r.key), ['latte']);
  const rm = p.prepareChange({ type: 'member_remove', memberId: member.id });
  p.addMemberRule(member.id, 'uova', 'grave');
  assert.throws(() => p.commitChange(rm.planId, rm.confirmationPhrase), { code: 'PLAN_STALE' });
  assert.ok(store.auditLog('p').some(a => a.action === 'member_added'));
});

test('meal plan: merge across recipes, pantry subtraction', () => {
  const merged = mergeIngredients([
    { title: 'A', ingredients: [{ name: 'spaghetti', quantity: 320, unit: 'g' }, { name: 'pecorino', quantity: null, unit: null, optional: true }] },
    { title: 'B', ingredients: [{ name: 'Spaghetti', quantity: 0.5, unit: 'kg' }, { name: 'latte', quantity: 2, unit: 'dl' }, { name: 'Bacon', nameIt: 'pancetta', quantity: 2, unit: null }] }]);
  const sp = merged.find(m => m.name.toLowerCase() === 'spaghetti');
  assert.deepEqual([sp.quantity, sp.unit, sp.usedIn], [820, 'g', ['A', 'B']]);
  assert.equal(merged.find(m => m.name === 'pancetta').quantity, 2);
  const { toBuy, covered } = subtractPantry(merged, [{ name: 'spaghetti', quantity: 500, unit: 'g' }, { name: 'pecorino', quantity: null }, { name: 'latte', quantity: 1, unit: 'l' }]);
  assert.equal(toBuy.find(t => t.name.toLowerCase() === 'spaghetti').quantity, 320);
  assert.deepEqual(covered.map(c => c.name).sort(), ['latte', 'pecorino']);
});

test('meal plan suggestion: distinct main dishes, hidden by rules, no desserts', () => {
  const rs = new RecipeStore(':memory:'), prep = 'x'.repeat(250);
  const add = (title, ings, cats = ['Primi piatti']) => rs.upsert('wikibooks', { title, sourceId: title, servings: 4, categories: cats, preparation: prep,
    ingredients: ings.map(n => ({ name: n, quantity: 100, unit: 'g' })) });
  add('Risotto alla zucca', ['riso', 'zucca', 'cipolla']); add('Spaghetti aglio e olio', ['spaghetti', 'aglio', 'olio']);
  add('Minestrone', ['zucchine', 'carote', 'patate'], ['Zuppe']); add('Tiramisù', ['mascarpone', 'savoiardi', 'caffè'], ['Dolci al cucchiaio']);
  const r = suggestPlan(rs, { days: 3, excludeAllergens: ['glutine'] });
  assert.deepEqual(r.plan.map(x => x.title).sort(), ['Minestrone', 'Risotto alla zucca']);
  assert.equal(r.found, 2); assert.ok(r.note);
  assert.equal(r.hiddenByYourRules >= 1, true);
});

test('smart reorder: intervals, due items, usual quantity', () => {
  const day = 864e5, now = Date.parse('2026-11-07T10:00:00Z');
  const o = (daysAgo, items) => ({ createdAt: new Date(now - daysAgo * day).toISOString(), items });
  const milk = { productId: 1, slug: 'latte', name: 'LATTE', quantity: 2 }, oil = { productId: 2, slug: 'olio', name: 'OLIO', quantity: 1 };
  const h = analyzeHabits([o(7, [milk]), o(14, [milk, oil]), o(21, [milk]), o(28, [milk]), o(2, [oil])], now);
  const m = h.frequent.find(i => i.productId === 1);
  assert.deepEqual([m.avgIntervalDays, m.daysSinceLast, m.usualQuantity, m.due], [7, 7, 2, true]);
  assert.equal(h.frequent.find(i => i.productId === 2).due, false);
  assert.deepEqual(h.cartPlanInput.addItems, [{ productId: 1, slug: 'latte', quantity: 2 }]);
});

test('substitutes: similar and compatible only, blocked removed', () => {
  const orig = { productId: 1, name: 'PASSATA DI POMODORO MUTTI GR. 700', category: 'Passate', brand: 'Mutti', unitPrice: 1.4, sizeLabel: 'GR. 700' };
  const c = [orig, { productId: 2, slug: 'b', name: 'PASSATA DI POMODORO CIRIO GR. 700', category: 'Passate', brand: 'Cirio', unitPrice: 1.2, sizeLabel: 'GR. 700' },
    { productId: 3, slug: 'c', name: 'PASSATA DI POMODORO BIO GR. 700', category: 'Passate', brand: 'Vietata', unitPrice: 1.1, sizeLabel: 'GR. 700' },
    { productId: 4, slug: 'd', name: 'DETERSIVO PIATTI', category: 'Casa', unitPrice: 2 }];
  const r = rankSubstitutes(orig, c, p => ({ blockers: p.brand === 'Vietata' ? ['Excluded brand'] : [], unknown: [] }));
  assert.deepEqual(r.map(x => x.productId), [2]);
});

test('budget and price insight', () => {
  const now = new Date('2026-11-07T12:00:00'); // Saturday
  assert.equal(weekStart(now).getDay(), 1);
  const orders = [{ createdAt: '2026-11-03T10:00:00', total: 60, status: 'Consegnato' }, { createdAt: '2026-11-04T10:00:00', total: 40, status: 'Annullato' },
    { createdAt: '2026-10-28T10:00:00', total: 99, status: 'Consegnato' }];
  const b = budgetStatus({ weekly: 100 }, orders, 35, now);
  assert.deepEqual([b.spent, b.remainingAfterCart, b.status], [60, 5, 'vicino_al_limite']);
  assert.equal(budgetStatus(null, orders).configured, false);
  const pi = priceInsight([{ day: '2026-10-01', price: 2 }, { day: '2026-10-08', price: 2 }, { day: '2026-10-15', price: 2.1 }], 1.7);
  assert.equal(pi.trend, 'sotto_la_media');
  const s = new AgentStore(':memory:');
  s.recordPrices([{ productId: 9, unitPrice: 1.5, name: 'X' }, { productId: null, unitPrice: 1 }, { productId: 8, unitPrice: 'n/a' }]);
  assert.deepEqual(s.priceHistory(9).map(h => h.price), [1.5]);
  s.pantrySet('p', [{ name: ' Olio  EVO ', quantity: 1, unit: 'l' }]);
  assert.equal(s.pantryList('p')[0].name, 'olio evo');
  assert.deepEqual(s.pantryRemove('p', ['OLIO EVO']), { removed: 1 });
});
