import test from 'node:test';
import assert from 'node:assert/strict';
import { productView } from '../src/sanitize.mjs';
import { labelFromProduct, parseAllergenDeclaration } from '../src/label.mjs';
import { findTerms, stripNegations, ALLERGEN_KEYS } from '../src/allergens.mjs';
import { evaluateSafety } from '../src/safety.mjs';
import { checkProduct } from '../src/preferences.mjs';
import { offView } from '../src/openfoodfacts.mjs';
import { AgentStore } from '../src/agent-db.mjs';
import { ProfileManager } from '../src/profile.mjs';
import { TosanoClient } from '../src/client.mjs';
import { SiteActionPlanner } from '../src/site-service.mjs';

// Shapes copied from real LaTuaSpesa product pages (2026-11-07), text shortened.
const biscotti = { productId: 868669, name: 'BISCOTTI RIPIENI DI CREMA ALLA NOCCIOLA', description: 'GR. 200', slug: 'borgo-biscotti', barcode: '8032755322665',
  metaData: { product_description: { ingredients: '<ul><li>crema di nocciola 40% (zucchero, olio di colza, cacao magro in polvere, nocciole 8%, emulsionante: lecitina di girasole, aromi), farina di frumento, olio di girasole, uova fresche*, latte scremato in polvere, burro, sale.</li></ul>' } } };
const pastaAmaranto = { productId: 2, name: 'PASTA CON AMARANTO FUSILLI', slug: 'pasta-amaranto',
  metaData: { product_description: { ingredients: '<ul><li>Farina di mais (90%)</li><li>Farina di amaranto (10%)</li><li>Può contenere tracce di soia, senape e lupino</li></ul>',
    allergens: 'Potrebbe contenere: Lupini, Senape, Soia<br/>Non contiene: Glutine' } } };
const yogurt = { productId: 3, name: 'YOGURT INTERO CON VANIGLIA', slug: 'yogurt-vaniglia',
  metaData: { product_description: { ingredients: '<ul><li>Latte intero, zucchero, vaniglia</li></ul>', allergens: 'Contiene: Latte<br/>Non contiene: Glutine' } } };
const noLabel = { productId: 4, name: 'CRACKERS', slug: 'crackers', barcode: '8000000000001' };
const rules = (...r) => ({ dietaryRules: r.map(([key, severity]) => ({ key, severity })), productOverrides: {} });

test('label parser reads the real declaration format and precautionary sentences', () => {
  const d = parseAllergenDeclaration('Contiene: Nocciole, Latte, Soia\nPotrebbe contenere: Mandorle\nNon contiene: Glutine');
  assert.deepEqual(d, { contains: ['Nocciole', 'Latte', 'Soia'], mayContain: ['Mandorle'], notContains: ['Glutine'] });
  const l = labelFromProduct(pastaAmaranto);
  assert.equal(l.source, 'tosano_product_page');
  assert.deepEqual(l.declared.mayContainKeys.sort(), ['lupini', 'senape', 'soia']);
  assert.deepEqual(l.declared.notContainsKeys, ['glutine']);
  assert.equal(l.precautions.length, 1);
  assert.ok(!l.ingredients.includes('<'));
});

test('negations are not mentions: "senza glutine" does not flag gluten', () => {
  assert.deepEqual(findTerms('glutine', 'Senza glutine. Farina di riso.'), []);
  assert.deepEqual(findTerms('glutine', 'farina di frumento'), ['frumento']);
  assert.ok(!stripNegations('non contiene latte').includes('latte'));
  assert.ok(ALLERGEN_KEYS.includes('nichel') && ALLERGEN_KEYS.length === 18);
});

test('EU allergen found in ingredients blocks, at any severity', () => {
  const p = productView(biscotti);
  for (const sev of ['grave', 'intolleranza']) {
    const s = evaluateSafety(p, rules(['glutine', sev], ['frutta_a_guscio', sev]));
    assert.equal(s.verdict, 'bloccato');
    assert.ok(s.rules.every(r => r.verdict === 'bloccato'));
  }
});

test('traces: block for grave, review for intolleranza; explicit "non contiene" clears', () => {
  const p = productView(pastaAmaranto);
  assert.equal(evaluateSafety(p, rules(['soia', 'grave'])).verdict, 'bloccato');
  assert.equal(evaluateSafety(p, rules(['soia', 'intolleranza'])).verdict, 'da_verificare');
  assert.equal(evaluateSafety(p, rules(['glutine', 'grave'])).verdict, 'nessun_conflitto_con_le_tue_regole');
});

test('missing label is never clearance; Open Food Facts can block but not clear', () => {
  const p = productView(noLabel);
  assert.equal(evaluateSafety(p, rules(['latte', 'intolleranza'])).verdict, 'da_verificare');
  p.off = offView({ status: 1, product: { allergens_tags: ['en:milk'], traces_tags: [] } });
  assert.equal(evaluateSafety(p, rules(['latte', 'intolleranza'])).verdict, 'bloccato');
  p.off = offView({ status: 1, product: { allergens_tags: [], traces_tags: [] } });
  assert.equal(evaluateSafety(p, rules(['latte', 'intolleranza'])).verdict, 'da_verificare');
});

test('grave allergy without a structured declaration needs review even if ingredients look clean', () => {
  const clean = productView({ productId: 9, name: 'RISO', slug: 'riso', metaData: { product_description: { ingredients: '<li>Riso</li>' } } });
  assert.equal(evaluateSafety(clean, rules(['sesamo', 'grave'])).verdict, 'da_verificare');
  assert.equal(evaluateSafety(clean, rules(['sesamo', 'intolleranza'])).verdict, 'nessun_conflitto_con_le_tue_regole');
});

test('nickel heuristic flags cocoa, nuts, tomato and canned food by name/ingredients', () => {
  assert.equal(evaluateSafety(productView(biscotti), rules(['nichel', 'intolleranza'])).verdict, 'bloccato');
  const tonno = productView({ productId: 5, name: 'TONNO ALL\'OLIO IN SCATOLA', slug: 'tonno', metaData: { product_description: { ingredients: '<li>Tonno, olio di oliva, sale</li>' } } });
  assert.equal(evaluateSafety(tonno, rules(['nichel', 'intolleranza'])).verdict, 'bloccato');
  const riso = productView({ productId: 6, name: 'RISO CARNAROLI', slug: 'riso', metaData: { product_description: { ingredients: '<li>Riso</li>' } } });
  const s = evaluateSafety(riso, rules(['nichel', 'intolleranza']));
  assert.equal(s.verdict, 'nessun_conflitto_con_le_tue_regole');
  assert.ok(s.rules[0].reasons.some(r => /non è un'analisi/i.test(r)));
});

test('lactose intolerance accepts "senza lattosio" products, milk allergy does not', () => {
  const p = productView({ productId: 7, name: 'LATTE SENZA LATTOSIO', slug: 'latte-sl', metaData: { product_description: { ingredients: '<li>Latte, enzima lattasi</li>' } } });
  assert.equal(evaluateSafety(p, rules(['lattosio', 'intolleranza'])).verdict, 'nessun_conflitto_con_le_tue_regole');
  assert.equal(evaluateSafety(p, rules(['latte', 'intolleranza'])).verdict, 'bloccato');
});

test('user label confirmation only lifts da_verificare, bound to the label hash, never a block', () => {
  const p = productView(pastaAmaranto);
  const r = { ...rules(['soia', 'intolleranza']), productOverrides: { 2: { keys: ['soia'], labelHash: p.label.labelHash, at: '2026-11-07T10:00:00Z' } } };
  assert.equal(evaluateSafety(p, r).verdict, 'nessun_conflitto_con_le_tue_regole');
  r.productOverrides[2].labelHash = 'old-label';
  assert.equal(evaluateSafety(p, r).verdict, 'da_verificare');
  const y = productView(yogurt);
  const ry = { ...rules(['latte', 'intolleranza']), productOverrides: { 3: { keys: ['latte'], labelHash: y.label.labelHash, at: '2026-11-07T10:00:00Z' } } };
  assert.equal(evaluateSafety(y, ry).verdict, 'bloccato');
});

test('checkProduct merges safety into the cart planner result', () => {
  const c = checkProduct(productView(yogurt), { rules: [], ...rules(['latte', 'grave']) });
  assert.equal(c.result, 'blocked');
  assert.equal(c.safety.verdict, 'bloccato');
});

test('profile: tightening is immediate, loosening needs prepare + exact phrase, all audited', () => {
  const store = new AgentStore(':memory:'), pm = new ProfileManager(store);
  assert.throws(() => pm.addDietaryRule('unicorno', 'grave'), { code: 'INVALID_ARGUMENT' });
  pm.addDietaryRule('nichel', 'intolleranza');
  assert.equal(pm.addDietaryRule('nichel', 'grave').saved, true);
  assert.equal(pm.addDietaryRule('nichel', 'intolleranza').unchanged, true);
  assert.equal(pm.setPermissions({ checkout: 'ask' }).requiresApproval, true);
  assert.equal(pm.setPermissions({ maxOrderTotal: 80 }).applied, true);
  assert.equal(pm.setPermissions({ maxOrderTotal: 120 }).requiresApproval, true);
  const plan = pm.prepareChange({ type: 'dietary_remove', key: 'nichel' });
  assert.throws(() => pm.commitChange(plan.planId, 'CONFERMO SBAGLIATO'), { code: 'APPROVAL_REQUIRED' });
  pm.commitChange(plan.planId, plan.confirmationPhrase);
  assert.equal(store.getDietaryRules('default').length, 0);
  assert.throws(() => pm.commitChange(plan.planId, plan.confirmationPhrase), { code: 'PLAN_SUCCEEDED' });
  assert.deepEqual(store.auditLog('default').map(x => x.action).reverse(),
    ['dietary_rule_added', 'dietary_rule_upgraded', 'permissions_tightened', 'dietary_rule_removed']);
});

test('profile: blocked products cannot be confirmed; onboarding finishes after 3 steps', () => {
  const store = new AgentStore(':memory:'), pm = new ProfileManager(store);
  pm.addDietaryRule('latte', 'intolleranza');
  const y = productView(yogurt);
  assert.throws(() => pm.prepareChange({ type: 'product_confirm' }, { ...y, check: checkProduct(y, store.getPreferences('default')) }), { code: 'NOTHING_TO_CONFIRM' });
  assert.equal(pm.status().nextStep, 'permessi');
  pm.markStep('permessi'); pm.markStep('marche');
  assert.equal(pm.markStep('intolleranze').onboardingCompleted, true);
});

const ok = data => ({ ok: () => true, status: () => 200, json: async () => ({ response: { status: 0, errors: [] }, data }) });
function gateSetup(cartItems, products, perms = {}) {
  const store = new AgentStore(':memory:');
  const cart = { cartId: 1, grossTotal: 50, totalPrice: 50, timeslot: { date: 'd', name: 's' }, shippingAddress: { addressName: 'Drive' },
    paymentTypeList: [{ paymentTypeId: 1, descr: 'Al ritiro' }], cartItems };
  let bought = 0;
  const http = { get: async u => { const url = new URL(u);
      if (url.pathname === '/ebsn/api/products') return ok(products[url.searchParams.get('slug')]);
      return ok(cart); },
    post: async u => { if (u.includes('checkout/buy')) bought++; return ok({ orderId: 5 }); } };
  const client = new TosanoClient(http, { contextHash: 'abcde', cartReadPath: '/ebsn/api/cart/view', allowCheckout: true, allowCartWrites: true });
  store.setPermissions('default', { lists: 'allowed', cart: 'ask', orders: 'ask', checkout: 'ask', maxOrderTotal: null, ...perms }, 'test');
  return { store, planner: new SiteActionPlanner(store, client), bought: () => bought };
}

test('checkout re-checks every cart product against allergies and refuses with details', async () => {
  const items = [{ itemId: 1, quantity: 1, product: { productId: 3, slug: 'yogurt-vaniglia', name: 'YOGURT' } }];
  const g = gateSetup(items, { 'yogurt-vaniglia': yogurt });
  g.store.setDietaryRules('default', [{ key: 'latte', severity: 'grave' }], 'test');
  await assert.rejects(g.planner.prepare('checkout', { paymentTypeId: 1 }), e => e.code === 'SAFETY_BLOCKED' && e.details[0].productId === 3);
  assert.equal(g.bought(), 0);
});

test('checkout respects denied permission and spending limit', async () => {
  const items = [{ itemId: 1, quantity: 1, product: { productId: 2, slug: 'pasta-amaranto', name: 'PASTA' } }];
  await assert.rejects(gateSetup(items, { 'pasta-amaranto': pastaAmaranto }, { checkout: 'denied' }).planner.prepare('checkout', { paymentTypeId: 1 }), { code: 'PERMISSION_DENIED' });
  await assert.rejects(gateSetup(items, { 'pasta-amaranto': pastaAmaranto }, { maxOrderTotal: 30 }).planner.prepare('checkout', { paymentTypeId: 1 }), { code: 'OVER_SPENDING_LIMIT' });
  const g = gateSetup(items, { 'pasta-amaranto': pastaAmaranto });
  g.store.setDietaryRules('default', [{ key: 'glutine', severity: 'grave' }], 'test');
  const p = await g.planner.prepare('checkout', { paymentTypeId: 1 });
  assert.match(p.summary.safetyCheck, /1 prodotti verificati/);
  const r = await g.planner.commit(p.planId, p.confirmationPhrase);
  assert.equal(r.orderId, 5); assert.equal(g.bought(), 1);
});

test('a rule added after approval blocks the commit (safety re-checked at commit time)', async () => {
  const items = [{ itemId: 1, quantity: 1, product: { productId: 3, slug: 'yogurt-vaniglia', name: 'YOGURT' } }];
  const g = gateSetup(items, { 'yogurt-vaniglia': yogurt });
  const p = await g.planner.prepare('checkout', { paymentTypeId: 1 });
  g.store.setDietaryRules('default', [{ key: 'latte', severity: 'intolleranza' }], 'test');
  await assert.rejects(g.planner.commit(p.planId, p.confirmationPhrase), { code: 'SAFETY_BLOCKED' });
  assert.equal(g.bought(), 0);
  assert.equal(g.store.getSiteAction('default', p.planId).state, 'stale');
});
