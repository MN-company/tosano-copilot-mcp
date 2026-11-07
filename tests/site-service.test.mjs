import test from 'node:test';
import assert from 'node:assert/strict';
import { TosanoClient } from '../src/client.mjs';
import { AgentStore } from '../src/agent-db.mjs';
import { SiteService, SiteActionPlanner } from '../src/site-service.mjs';
import { siteListsView, siteListView, ordersView, addressesView, paymentAuthsView, timeslotsView, extractOrderId } from '../src/site-views.mjs';

const PII = 'secret@example.org';
const ok = data => ({ ok: () => true, status: () => 200, json: async () => ({ response: { status: 0, errors: [] }, data, user: { email: PII } }) });
const product = (productId, name) => ({ productId, name, slug: `p-${productId}`, price: 1.5, vendor: { name: 'Brand' } });
function fakeSite(state) {
  const calls = [];
  const route = (method, url) => {
    const u = new URL(url), p = u.pathname, q = Object.fromEntries(u.searchParams);
    calls.push({ method, path: p, q });
    if (state.fail?.[p]) throw new Error('network');
    if (p === '/ebsn/api/cart/view') return ok(state.cart);
    if (p === '/ebsn/api/wishlist/list') return ok({ personalList: state.lists, page: { selPage: 1, totPages: 1 } });
    if (p === '/ebsn/api/wishlist/view') return ok(state.listDetail);
    if (p === '/ebsn/api/wishlist/delete') { state.lists = state.lists.filter(l => String(l.id) !== q.list_id); return ok({ personalList: state.lists }); }
    if (p === '/ebsn/api/cart/add-all-from-wishlist') { state.cart = state.afterCart ?? state.cart; return ok(state.cart); }
    if (p === '/ebsn/api/timeslot/list') return ok({ days: state.days });
    if (p === '/ebsn/api/timeslot/select') { state.cart = { ...state.cart, timeslot: { date: q.sel_date, name: '10:00-11:00' } }; return ok(true); }
    if (p === '/ebsn/api/order/view') return ok(state.order);
    if (p === '/ebsn/api/order/list') return ok({ orders: [state.order], page: { selPage: 1, totPages: 1 } });
    if (p === '/ebsn/api/checkout/prepare') return ok(state.cart);
    if (p === '/ebsn/api/checkout/buy') { state.bought = (state.bought ?? 0) + 1; return ok({ orderId: 9001 }); }
    return ok({});
  };
  return { calls, http: { get: async u => route('GET', u), post: async u => route('POST', u) } };
}
const baseCart = () => ({ cartId: 7, totalPrice: 3, grossTotal: 3.5, totalItems: 1, packageTotal: 0.5,
  shippingAddress: { addressType: 'drive', addressName: 'Drive Verona', address1: 'PRIVATE STREET' },
  timeslot: { date: '2026-11-08', name: '10:00-11:00' },
  paymentTypeList: [{ paymentTypeId: 1, descr: 'Pagamento al ritiro' }],
  cartItems: [{ itemId: 1, quantity: 1, unitPrice: 3, grossTotal: 3, product: product(11, 'LATTE') }], user: { email: PII } });
const cfg = extra => ({ contextHash: 'abcde', cartReadPath: '/ebsn/api/cart/view?show_sectors=false', allowCartWrites: true,
  allowListWrites: true, allowOrderWrites: true, allowCheckout: true, ...extra });
function setup(state, extra) {
  const f = fakeSite(state), client = new TosanoClient(f.http, cfg(extra)), store = new AgentStore(':memory:');
  // These tests exercise the planner mechanics; the profile defaults checkout to 'denied'.
  store.setPermissions('default', { ...store.getPermissions('default'), checkout: 'ask' }, 'test');
  return { f, client, store, site: new SiteService(client), planner: new SiteActionPlanner(store, client) };
}

test('views never leak personal fields and mask payment labels', () => {
  const all = JSON.stringify([
    siteListsView({ personalList: [{ id: 5, name: 'Spesa', isDefault: true, owner: PII }] }),
    addressesView({ addresses: [{ addressId: 3, addressName: 'Casa', address1: 'PRIVATE STREET', city: 'Verona', phone: '333' }] }),
    ordersView({ orders: [{ orderId: 4, grossTotal: 10, user: { email: PII }, shippingAddress: { address1: 'PRIVATE STREET' } }] })
  ]);
  assert.ok(!all.includes(PII) && !all.includes('PRIVATE') && !all.includes('333'));
  assert.equal(paymentAuthsView([{ userPaymentAuthId: 2, creditCard: '4111111111111111' }]).paymentMethods[0].label, '************1111');
  assert.equal(extractOrderId({ order: { orderId: '77' } }), 77);
  assert.deepEqual(siteListsView({ weird: 1 }).schemaKeys, ['weird']);
});

test('reads use only allowlisted endpoints; unknown paths refused', async () => {
  const { site, client, f } = setup({ cart: baseCart(), lists: [{ id: 5, name: 'Spesa' }], days: [] });
  const r = await site.lists();
  assert.equal(r.lists[0].listId, 5);
  await assert.rejects(client.siteGet('/ebsn/api/registration/user_detail'), { code: 'INVALID_PATH' });
  await assert.rejects(client.siteWrite('/ebsn/api/registration/update_password'), { code: 'INVALID_PATH' });
  assert.ok(f.calls.every(c => c.path.startsWith('/ebsn/api/')));
});

test('each write family is gated by its own flag', async () => {
  const { site, planner } = setup({ cart: baseCart(), lists: [], days: [] }, { allowListWrites: false, allowCheckout: false });
  await assert.rejects(site.createList('x'), { code: 'WRITES_DISABLED' });
  const p = await planner.prepare('checkout', { paymentTypeId: 1 });
  await assert.rejects(planner.commit(p.planId, p.confirmationPhrase), { code: 'WRITES_DISABLED' });
});

test('checkout: exact phrase required, executes once, returns confirmed orderId, never replays', async () => {
  const state = { cart: baseCart(), order: { orderId: 9001, orderStatusDescr: 'Confermato', grossTotal: 3.5 } };
  const { planner } = setup(state);
  const p = await planner.prepare('checkout', { paymentTypeId: 1 });
  assert.equal(p.summary.total, 3.5);
  assert.ok(!JSON.stringify(p).includes('PRIVATE'));
  await assert.rejects(planner.commit(p.planId, 'CONFERMO NOPE'), { code: 'APPROVAL_REQUIRED' });
  const r = await planner.commit(p.planId, p.confirmationPhrase);
  assert.equal(r.state, 'succeeded'); assert.equal(r.orderId, 9001); assert.equal(r.retryAllowed, false);
  const again = await planner.commit(p.planId, p.confirmationPhrase);
  assert.equal(again.status, 'already_applied');
  assert.equal(state.bought, 1);
});

test('checkout blocked without timeslot and rejects payment types not offered', async () => {
  const noSlot = { ...baseCart(), timeslot: null };
  await assert.rejects(setup({ cart: noSlot }).planner.prepare('checkout', { paymentTypeId: 1 }), { code: 'CHECKOUT_BLOCKED' });
  await assert.rejects(setup({ cart: baseCart() }).planner.prepare('checkout', { paymentTypeId: 99 }), { code: 'PAYMENT_TYPE_INVALID' });
});

test('stale plan: cart changed after approval -> no write', async () => {
  const state = { cart: baseCart() };
  const { planner } = setup(state);
  const p = await planner.prepare('checkout', { paymentTypeId: 1 });
  state.cart = { ...state.cart, grossTotal: 9.99 };
  await assert.rejects(planner.commit(p.planId, p.confirmationPhrase), { code: 'PLAN_STALE' });
  assert.equal(state.bought, undefined);
  assert.equal(planner.status(p.planId).state, 'stale');
});

test('ambiguous network on buy -> unknown, no retry', async () => {
  const state = { cart: baseCart(), fail: { '/ebsn/api/checkout/buy': true } };
  const { planner } = setup(state);
  const p = await planner.prepare('checkout', { paymentTypeId: 1 });
  await assert.rejects(planner.commit(p.planId, p.confirmationPhrase), { code: 'NETWORK_AMBIGUOUS' });
  assert.equal(planner.status(p.planId).state, 'unknown');
  await assert.rejects(planner.commit(p.planId, p.confirmationPhrase), { code: 'PLAN_NOT_PREPARED' });
});

test('list_to_cart reports partial per product', async () => {
  const after = baseCart(); after.cartItems = [...after.cartItems, { itemId: 2, quantity: 2, unitPrice: 1, grossTotal: 2, product: product(12, 'PANE') }];
  const state = { cart: baseCart(), afterCart: after,
    listDetail: { listId: 5, name: 'Spesa', wishlistItems: [{ itemId: 50, quantity: 2, product: product(12, 'PANE') }, { itemId: 51, quantity: 1, product: product(13, 'UOVA') }] } };
  const { planner } = setup(state);
  const p = await planner.prepare('list_to_cart', { listId: 5 });
  const r = await planner.commit(p.planId, p.confirmationPhrase);
  assert.equal(r.status, 'partial'); assert.equal(r.state, 'unknown');
  assert.deepEqual(r.perItem.map(x => x.status), ['confirmed', 'missing']);
});

test('select_timeslot validates offered slot and verifies by read-back', async () => {
  const state = { cart: { ...baseCart(), timeslot: null }, days: [{ dateIndex: '2026-11-09', timeslots: [{ timeslotId: 3, name: '10:00-11:00', status: 'OK' }, { timeslotId: 4, name: '11:00-12:00', status: 'FULL' }] }] };
  const { planner } = setup(state);
  await assert.rejects(planner.prepare('select_timeslot', { date: '2026-11-09', timeslotId: 4 }), { code: 'TIMESLOT_UNAVAILABLE' });
  const p = await planner.prepare('select_timeslot', { date: '2026-11-09', timeslotId: 3 });
  const r = await planner.commit(p.planId, p.confirmationPhrase);
  assert.equal(r.state, 'succeeded');
  assert.equal(timeslotsView(state.days).days[0].timeslots[1].available, false);
});

test('list_delete confirmed only when the list disappears', async () => {
  const state = { cart: baseCart(), lists: [{ id: 5, name: 'Vecchia' }], listDetail: { listId: 5, name: 'Vecchia', wishlistItems: [] } };
  const { planner } = setup(state);
  const p = await planner.prepare('list_delete', { listId: 5 });
  const r = await planner.commit(p.planId, p.confirmationPhrase);
  assert.equal(r.status, 'confirmed');
});

test('order_cancel refused when site marks order not deletable', async () => {
  const { planner } = setup({ cart: baseCart(), order: { orderId: 4, isDeletable: false } });
  await assert.rejects(planner.prepare('order_cancel', { orderId: 4 }), { code: 'ORDER_NOT_CANCELLABLE' });
});

test('list estimate prices weighed items per kg', async () => {
  const { listEstimate } = await import('../src/site-service.mjs');
  const e = listEstimate({ items: [{ productId: 1, name: 'CLEMENTINE', quantity: 1, weight: 2, unitPrice: 2.28 }, { productId: 2, name: 'SALE', quantity: 1, weight: 0, unitPrice: 0.3 }] }, 4.8);
  assert.deepEqual([e.lines[0].estimate, e.lines[1].estimate, e.estimatedAdded, e.estimatedTotalAfter], [4.56, 0.3, 4.86, 9.66]);
});
