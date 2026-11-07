import test from 'node:test';
import assert from 'node:assert/strict';
import { sellingView, optionsView, encodeQuantity, estimateLine, validateOptions } from '../src/selling.mjs';
import { productView } from '../src/sanitize.mjs';
import { TosanoClient } from '../src/client.mjs';
import { AgentStore } from '../src/agent-db.mjs';
import { SiteService, SiteActionPlanner } from '../src/site-service.mjs';
import { CartPlanner } from '../src/cart-planner.mjs';

// productInfos as served by LaTuaSpesa (2026-11-07).
const banane = { productId: 10, name: 'BANANE', slug: 'banane', priceStandardUmDisplay: 1.99, price: 2.59,
  productInfos: { TIPOLOGIA: 'Confezione', WEIGHT_SELLING: '1.300', WEIGHT_UNIT_SELLING: 'KG', WEIGHT_UNIT_BASE: 'KG', MINACQ: '1', MAIL_TO: 'internal@example.org' } };
const mortadella = { productId: 11, name: 'MORTADELLA A TRANCIO', slug: 'mortadella', priceStandardUmDisplay: 12,
  productInfos: { TIPOLOGIA: 'Confezione', WEIGHT_SELLING: '400.000', WEIGHT_UNIT_SELLING: 'GR', WEIGHT_UNIT_BASE: 'KG', MINACQ: '1' } };
const sfuso = { productId: 12, name: 'OLIVE SFUSE', slug: 'olive', priceStandardUmDisplay: 9,
  productInfos: { TIPOLOGIA: 'Sfuso', WEIGHT_SELLING: '100', STEP_SELLING: '50', WEIGHT_UNIT_SELLING: 'GR', WEIGHT_UNIT_BASE: 'KG' },
  selectOptions: [{ name: 'Taglio', parameterName: 'TAGLIO', options: [{ key: 'FINE', value: 'Fine' }, { key: 'SPESSO', value: 'Spesso' }] }] };
const acqua = { productId: 13, name: 'ACQUA X6', slug: 'acqua', productInfos: { TIPOLOGIA: 'Pezzo', QTY_MULT: '6', MINACQ: '6' } };

test('selling view mirrors site rules and never exposes internal productInfos', () => {
  const b = sellingView(banane);
  assert.deepEqual([b.type, b.variableWeight, b.estimatedWeightKg], ['Confezione', true, 1.3]);
  assert.equal(sellingView(mortadella).estimatedWeightKg, 0.4);
  assert.equal(sellingView(sfuso).multiplier, 1000);
  assert.ok(!JSON.stringify(productView(banane)).includes('internal@example.org'));
  assert.equal(productView(sfuso).options[0].choices.length, 2);
});

test('pieces: multiples and minimums are enforced with suggestions, never silently rounded', () => {
  const s = sellingView(acqua);
  assert.equal(encodeQuantity(s, 12).cartQuantity, 12);
  assert.throws(() => encodeQuantity(s, 8), e => e.code === 'QUANTITY_RULE' && e.details.suggestions.join() === '6,12');
  assert.throws(() => encodeQuantity(s, 3), { code: 'QUANTITY_RULE' });
  assert.throws(() => encodeQuantity(sellingView(banane), 1.5), { code: 'INVALID_ARGUMENT' });
});

test('sfuso: grams in, kg to the cart, steps enforced (like encodeProductQuantity)', () => {
  const s = sellingView(sfuso);
  assert.deepEqual(encodeQuantity(s, 250), { cartQuantity: 0.25, display: '250 gr' });
  assert.throws(() => encodeQuantity(s, 50), { code: 'QUANTITY_RULE' });
  assert.throws(() => encodeQuantity(s, 220), e => e.details.suggestions.join() === '200,250');
});

test('variable weight estimate is labelled and computed from price per kg', () => {
  const e = estimateLine(sellingView(mortadella), 12, 2);
  assert.deepEqual([e.estimatedKg, e.estimatedPrice], [0.8, 9.6]);
  assert.match(e.note, /peso effettivo/);
  assert.equal(estimateLine(sellingView(acqua), 1, 6), null);
});

test('options must be among the choices the product offers', () => {
  const opts = optionsView(sfuso);
  assert.deepEqual(validateOptions(opts, { TAGLIO: 'Fine' }), { TAGLIO: 'FINE' });
  assert.throws(() => validateOptions(opts, { TAGLIO: 'Medio' }), { code: 'INVALID_OPTION' });
  assert.throws(() => validateOptions(opts, { SPESSORE: 'x' }), { code: 'INVALID_OPTION' });
});

const ok = data => ({ ok: () => true, status: () => 200, json: async () => ({ response: { status: 0, errors: [] }, data }) });
function world(state) {
  const posts = [];
  const http = {
    get: async u => { const url = new URL(u), p = url.pathname;
      if (p === '/ebsn/api/products') return ok(state.products[url.searchParams.get('slug')] ?? { products: Object.values(state.products), page: { selPage: 1, totPages: 1, totItems: 1 } });
      if (p === '/ebsn/api/cart/view') return ok(state.cart);
      if (p === '/ebsn/api/cart/purchase-restriction') return ok(state.restrictions ?? { products: [] });
      if (p === '/ebsn/api/order/list-retry-payment') return ok({ orders: state.pending ?? [] });
      if (p === '/ebsn/api/packaging-type/list') return ok({ products: [{ productId: 900, name: 'Sacchetto carta', price: 0.1 }] });
      if (p === '/ebsn/api/order/view') return ok({ orderId: 77, orderStatusDescr: 'Pagato' });
      return ok({}); },
    post: async (u, o) => { const url = new URL(u); posts.push({ path: url.pathname, q: Object.fromEntries(url.searchParams), data: o?.data });
      if (url.pathname === '/ebsn/api/cart/add') { state.cart.cartItems.push({ itemId: 5, quantity: o.data.items[0].quantity, product: { productId: o.data.items[0].productId, slug: 'olive' } }); return ok(state.cart); }
      if (url.pathname === '/ebsn/api/cart/close') state.cart.cartItems = [];
      if (url.pathname === '/ebsn/api/cart/update-cart-info') state.cart.cartInfos = { ...(state.cart.cartInfos ?? {}), [o.data.property]: o.data.value };
      if (url.pathname === '/ebsn/api/order/payment') state.pending = [];
      return ok(state.cart); } };
  const client = new TosanoClient(http, { contextHash: 'abcde', cartReadPath: '/ebsn/api/cart/view', allowCartWrites: true, allowCheckout: true });
  const store = new AgentStore(':memory:');
  store.setPermissions('default', { ...store.getPermissions('default'), checkout: 'ask' }, 'test');
  return { client, store, posts, site: new SiteService(client), planner: new SiteActionPlanner(store, client) };
}
const cart = items => ({ cartId: 3, grossTotal: 10, totalPrice: 10, timeslot: { date: 'd', name: 's' }, shippingAddress: { addressName: 'Drive' }, cartItems: items });

test('cart planner sends kg for sfuso, passes options as infos, shows estimate in the plan', async () => {
  const w = world({ products: { olive: sfuso }, cart: cart([]) });
  const p = new CartPlanner(w.store, w.client);
  const plan = await p.prepare({ action: 'add', items: [{ productId: 12, slug: 'olive', quantity: 250, options: { TAGLIO: 'Fine' } }] }, w.store.getPreferences('default'));
  assert.equal(plan.summary.products[0].requested, '250 gr');
  assert.equal(plan.summary.products[0].estimate.estimatedPrice, 2.25);
  await p.commit(plan.planId, plan.confirmationPhrase, w.store.getPreferences('default'), { allowCartWrites: true });
  const add = w.posts.find(x => x.path === '/ebsn/api/cart/add').data.items[0];
  assert.equal(add.quantity, 0.25);
  assert.equal(add.infos.TAGLIO, 'FINE');
});

test('cart_empty is two-phase and verified empty', async () => {
  const w = world({ products: {}, cart: cart([{ itemId: 1, quantity: 2, product: { productId: 1, name: 'X' } }]) });
  const p = await w.planner.prepare('cart_empty', {});
  assert.equal(p.summary.itemCount, 1);
  assert.equal(w.posts.length, 0);
  const r = await w.planner.commit(p.planId, p.confirmationPhrase);
  assert.equal(r.status, 'confirmed');
  assert.equal(w.posts[0].q.cart_id, '3');
});

test('failed payment retry only for orders the site lists as pending', async () => {
  const w = world({ products: {}, cart: cart([]), pending: [{ orderId: 77, orderStatusDescr: 'Pagamento fallito', grossTotal: 40 }] });
  await assert.rejects(w.planner.prepare('order_retry_payment', { orderId: 78 }), { code: 'ORDER_NOT_PENDING_PAYMENT' });
  const p = await w.planner.prepare('order_retry_payment', { orderId: 77 });
  const r = await w.planner.commit(p.planId, p.confirmationPhrase);
  assert.equal(r.status, 'confirmed');
});

test('packaging must be offered; note is stored and verified; restrictions block checkout', async () => {
  const w = world({ products: {}, cart: cart([{ itemId: 1, quantity: 1, product: { productId: 1, name: 'GELATO' } }]),
    restrictions: { products: [{ productId: 1, name: 'GELATO', reason: 'Non disponibile il giorno scelto' }] } });
  await assert.rejects(w.site.setPackaging(5), { code: 'INVALID_ARGUMENT' });
  assert.equal((await w.site.setPackaging(900)).status, 'confirmed');
  assert.equal((await w.site.setOrderComment('Banane <b>poco</b> mature')).status, 'confirmed');
  assert.equal(w.posts.at(-1).data.value, 'Banane bpoco/b mature');
  const pre = await w.site.checkoutPreview();
  assert.ok(pre.blockers.includes('DAY_RESTRICTED_PRODUCTS'));
  assert.equal(pre.restrictions.restricted[0].reason, 'Non disponibile il giorno scelto');
});
