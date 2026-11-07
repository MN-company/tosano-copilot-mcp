/** Site-native features beyond search/cart: native lists, purchase context, orders, checkout.
 * Reads are sanitized. Low-risk list edits are direct; everything that changes the cart,
 * an order or spends money goes through SiteActionPlanner (prepare -> approve -> commit once).
 */
import { createHash } from 'node:crypto';
import { TosanoError } from './client.mjs';
import { cartFingerprint } from './agent-db.mjs';
import { checkProduct } from './preferences.mjs';
import { siteListsView, siteListView, timeslotsView, storesView, addressesView, ordersView, orderView,
  categoriesView, paymentAuthsView, paymentTypesView, deliveryFeeView, extractOrderId } from './site-views.mjs';

const NS = { show_sectors: false };
const posInt = (v, name) => { if (!Number.isSafeInteger(v) || v < 1) throw new TosanoError(`Invalid ${name}`, 'INVALID_ARGUMENT'); return v; };
const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const qty = v => { if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100) throw new TosanoError('Invalid quantity', 'INVALID_ARGUMENT'); return v; };

export class SiteService {
  constructor(client) { this.client = client; }
  // ---- native lists (read)
  async lists({ page = 1, pageSize = 30 } = {}) { return siteListsView(await this.client.siteGet('/ebsn/api/wishlist/list', { page, pageSize })); }
  async list(listId) { return siteListView(await this.client.siteGet('/ebsn/api/wishlist/view', { list_id: posInt(listId, 'listId'), calculate_stock: false, show_sectors: false })); }
  // ---- native lists (direct writes, flag ALLOW_LIST_WRITES)
  async createList(name) { await this.client.siteWrite('/ebsn/api/wishlist/insert', { name: String(name).trim().slice(0, 100) }); return this.lists(); }
  async renameList(listId, name) { await this.client.siteWrite('/ebsn/api/wishlist/update', { list_id: posInt(listId, 'listId'), name: String(name).trim().slice(0, 100) }); return this.lists(); }
  async setDefaultList(listId) { await this.client.siteWrite('/ebsn/api/wishlist/select', { list_id: posInt(listId, 'listId') }); return this.lists(); }
  async addToList(listId, items) {
    const payload = { wishlistId: posInt(listId, 'listId'), show_sectors: false,
      items: items.map(i => ({ productId: posInt(i.productId, 'productId'), quantity: qty(i.quantity), infos: {} })) };
    await this.client.siteWrite('/ebsn/api/wishlist/add_prod', {}, payload);
    return this.list(listId);
  }
  async setListQuantity(listId, itemId, quantity) {
    await this.client.siteWrite('/ebsn/api/wishlist/update_prods', { ...NS, calculate_stock: false },
      { wishlistId: posInt(listId, 'listId'), items: [{ itemId: posInt(itemId, 'itemId'), quantity: qty(quantity) }] });
    return this.list(listId);
  }
  async removeFromList(listId, items) {
    await this.client.siteWrite('/ebsn/api/wishlist/delete_prods', { ...NS, calculate_stock: false },
      { wishlistId: String(posInt(listId, 'listId')), show_sectors: false,
        items: items.map(i => ({ itemId: posInt(i.itemId, 'itemId'), productId: posInt(i.productId, 'productId'), quantity: 0 })) });
    return this.list(listId);
  }
  // ---- purchase context (read)
  async timeslots({ showClosed = false } = {}) { return timeslotsView(await this.client.siteGet('/ebsn/api/timeslot/list', { 'show-closed': showClosed, 'check-locker': false })); }
  async stores() { return storesView(await this.client.siteGet('/ebsn/api/store/list')); }
  async addresses(addressType = 'drive') {
    if (!['drive', 'home', 'locker'].includes(addressType)) throw new TosanoError('Invalid address type', 'INVALID_ARGUMENT');
    return addressesView(await this.client.siteGet('/ebsn/api/user-address/delivery-service-list', { address_type: addressType }));
  }
  async deliveryFee() { return deliveryFeeView(await this.client.siteGet('/ebsn/api/delivery-fee/view')); }
  async purchaseContext() {
    const cart = await this.client.readCart();
    return { mode: cart.mode, location: cart.pickupOrDeliveryLocation, timeslot: cart.timeslot, cartId: cart.cartId, observedAt: cart.observedAt };
  }
  // ---- catalog extras
  async categories(depth = 2) { return categoriesView(await this.client.siteGet('/ebsn/api/category', { filtered: true, depth }), depth); }
  async categoryBySlug(slug) {
    if (!/^[a-z0-9-]{2,60}(\/[a-z0-9-]{2,60}){0,2}$/.test(slug)) throw new TosanoError('Invalid category slug', 'INVALID_ARGUMENT');
    const c = await this.client.siteGet('/ebsn/api/category', { slug, filtered: true });
    return categoriesView([c], 2).categories[0] ?? null;
  }
  // ---- orders (read)
  async orders({ page = 1, pageSize = 12 } = {}) { return ordersView(await this.client.siteGet('/ebsn/api/order/list', { page, page_size: pageSize })); }
  async order(orderId) { return orderView(await this.client.siteGet('/ebsn/api/order/view', { order_id: posInt(orderId, 'orderId') })); }
  // ---- cart extras
  /** Substitutions: whether the picker may replace an unavailable item. Same call as the site's toggle. */
  async setSubstitution(itemId, accept) {
    await this.client.siteWrite('/ebsn/api/cart/update-infos', NS, { items: [{ itemId: posInt(itemId, 'itemId'), infos: { accept_alternatives: String(accept === true) } }] });
    const cart = await this.client.readCart(), line = cart.items.find(i => i.itemId === itemId);
    return { itemId, requested: accept === true, observed: line ? line.acceptAlternatives : null, status: line && line.acceptAlternatives === (accept === true) ? 'confirmed' : 'unverified' };
  }
  async giftCertificates() {
    const d = await this.client.siteGet('/ebsn/api/giftcertificate/list', { show_history: false });
    return { giftCertificates: (d?.giftCertificates ?? []).map(g => ({ name: typeof g.name === 'string' ? g.name.slice(0, 80) : null,
      code: typeof g.code === 'string' ? g.code.slice(0, 40) : null, amount: typeof g.amount === 'number' ? g.amount : null,
      endDate: typeof g.endDate === 'string' ? g.endDate.slice(0, 20) : null, description: typeof g.description === 'string' ? g.description.replace(/<[^>]+>/g, ' ').slice(0, 200) : null })) };
  }
  async giftCode(code, action) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{3,40}$/.test(code)) throw new TosanoError('Invalid code', 'INVALID_ARGUMENT');
    const path = action === 'remove' ? '/ebsn/api/cart-giftcertificate/remove_code' : '/ebsn/api/cart-giftcertificate/add_code';
    await this.client.siteWrite(path, { code, ...NS }, {});
    const cart = await this.client.readCart();
    return { action, code, cartTotal: cart.total, cart };
  }
  /** Products that cannot be delivered/picked up on the selected day, as the site reports them. */
  async purchaseRestrictions() {
    const d = await this.client.siteGet('/ebsn/api/cart/purchase-restriction');
    const list = Array.isArray(d) ? d : Array.isArray(d?.products) ? d.products : Array.isArray(d?.items) ? d.items : [];
    const items = list.map(x => { const p = x.product ?? x; return { productId: p.productId ?? null, name: typeof p.name === 'string' ? p.name.slice(0, 120) : null,
      reason: typeof (x.reason ?? x.message ?? p.dayLock) === 'string' ? String(x.reason ?? x.message ?? p.dayLock).slice(0, 160) : null }; });
    return { restricted: items, hasRestrictions: items.length > 0, ...(items.length || !d || typeof d !== 'object' ? {} : { schemaKeys: Object.keys(d).slice(0, 30) }) };
  }
  /** Cart properties the checkout page sets: shopping bag type and the note for the picker. */
  async cartInfo() {
    const raw = await this.client.siteGet('/ebsn/api/cart/view', NS);
    const ci = raw?.cartInfos ?? {};
    return { packageType: ci.package_type ?? null, orderComment: typeof ci.order_comment === 'string' ? ci.order_comment.slice(0, 500) : null };
  }
  async setPackaging(productId) {
    const opts = await this.packagingOptions();
    if (!opts.options.some(o => o.productId === productId)) throw new TosanoError('Packaging type not offered', 'INVALID_ARGUMENT');
    await this.client.siteWrite('/ebsn/api/cart/update-cart-info', NS, { property: 'package_type', value: String(productId) });
    const now = await this.cartInfo();
    return { requested: productId, observed: now.packageType, status: String(now.packageType) === String(productId) ? 'confirmed' : 'unverified' };
  }
  async setOrderComment(text) {
    if (typeof text !== 'string' || text.length > 400) throw new TosanoError('Note must be at most 400 characters', 'INVALID_ARGUMENT');
    const clean = text.replace(/[<>]/g, '').trim();
    await this.client.siteWrite('/ebsn/api/cart/update-cart-info', NS, { property: 'order_comment', value: clean });
    const now = await this.cartInfo();
    return { observed: now.orderComment, status: (now.orderComment ?? '') === clean ? 'confirmed' : 'unverified' };
  }
  async myProducts({ page = 1, pageSize = 24 } = {}) { return { source: 'tosano_site_preferred', ...(await this.client.listProducts({ preferred: true, page, pageSize })) }; }
  async categoryProducts(categoryId, { promo = false, page = 1, pageSize = 24 } = {}) {
    return { source: promo ? 'tosano_site_category_promo' : 'tosano_site_category', categoryId, ...(await this.client.listProducts({ categoryId, promo, page, pageSize })) };
  }
  async ordersPaymentPending() {
    const d = await this.client.siteGet('/ebsn/api/order/list-retry-payment');
    return ordersView(Array.isArray(d) ? { orders: d } : d);
  }
  async prebilledAmount(paymentTypeId, orderId) {
    const d = await this.client.siteGet('/ebsn/api/checkout/prebilled-amount', { payment_type_id: posInt(paymentTypeId, 'paymentTypeId'), ...(orderId ? { order_id: posInt(orderId, 'orderId') } : {}) });
    const v = d?.prebilledAmount ?? d;
    return { prebilledAmount: typeof v === 'number' ? v : (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null),
      note: 'Importo pre-autorizzato sul metodo di pagamento (maggiorato per i prodotti a peso). L\'addebito finale segue il peso reale.' };
  }
  async packagingOptions() {
    const d = await this.client.siteGet('/ebsn/api/packaging-type/list');
    return { options: (d?.products ?? []).map(p => ({ productId: p.productId ?? null, name: typeof p.name === 'string' ? p.name.slice(0, 100) : null, price: p.price ?? null })) };
  }
  // ---- checkout (read)
  async paymentMethods(paymentTypeId) { return paymentAuthsView((await this.client.siteGet('/ebsn/api/payment-type/list-auth', { payment_type_id: posInt(paymentTypeId, 'paymentTypeId') }))?.auths); }
  async checkoutPreview() {
    const raw = await this.client.siteGet('/ebsn/api/cart/view', NS);
    const cart = await this.client.readCart();
    const blockers = [];
    if (!cart.items?.length) blockers.push('CART_EMPTY');
    if (!cart.timeslot) blockers.push('TIMESLOT_NOT_SELECTED');
    if (!cart.pickupOrDeliveryLocation) blockers.push('ADDRESS_NOT_SELECTED');
    let restrictions = null, info = null;
    try { restrictions = await this.purchaseRestrictions(); if (restrictions.hasRestrictions) blockers.push('DAY_RESTRICTED_PRODUCTS'); } catch { restrictions = { error: 'UNAVAILABLE' }; }
    try { info = await this.cartInfo(); } catch {}
    return { cart, paymentTypes: paymentTypesView(raw?.paymentTypeList ?? raw?.paymentTypes), restrictions, packaging: info?.packageType ?? null, orderComment: info?.orderComment ?? null,
      readyForCheckout: blockers.length === 0, blockers,
      note: 'Read-only preview. Ordering requires tosano_prepare_site_action kind=checkout and explicit approval.' };
  }
}

/** Kind -> {flag, baseline(read state), validate, execute(once), verify(read back)} */
export class SiteActionPlanner {
  #queue = Promise.resolve();
  constructor(store, client, profileId = 'default', prefsFn = () => store.getPreferences(profileId)) {
    this.store = store; this.client = client; this.site = new SiteService(client); this.profileId = profileId; this.prefsFn = prefsFn;
  }
  static FAMILY = { cart_empty: 'cart', order_retry_payment: 'checkout', order_change_payment: 'checkout', list_delete: 'lists', list_to_cart: 'cart', reorder: 'cart', select_timeslot: 'cart', select_address: 'cart', order_cancel: 'orders', order_modify: 'orders', checkout: 'checkout' };
  #checkPermission(kind) {
    const fam = SiteActionPlanner.FAMILY[kind], perms = this.prefsFn().permissions ?? {};
    if (perms[fam] === 'denied') throw new TosanoError(`Agent permission '${fam}' is denied in the user profile`, 'PERMISSION_DENIED');
  }
  /** Re-check every product that would enter or stay in the cart against brand and dietary rules. */
  async #safetyGate(products) {
    const prefs = this.prefsFn();
    const hasRules = prefs.dietaryRules?.length || prefs.rules?.some(r => ['excluded_brand', 'excluded_ingredient', 'excluded_allergen'].includes(r.kind) || r.strength === 'hard');
    if (!hasRules || !products.length) return { checked: 0 };
    if (products.length > 80) throw new TosanoError('Too many products to verify safely in one action', 'SAFETY_TOO_MANY');
    const blocked = [], review = [];
    for (const p of products) {
      if (!p.slug) { review.push({ productId: p.productId, name: p.name, reason: 'Prodotto senza slug: impossibile leggere l\'etichetta' }); continue; }
      const details = await this.client.productDetails(p.slug);
      const c = checkProduct(details, prefs);
      if (c.result === 'blocked') blocked.push({ productId: p.productId, name: details.name, reasons: c.blockers });
      else if (c.result === 'review_required') review.push({ productId: p.productId, slug: p.slug, name: details.name, reasons: c.unknown });
    }
    if (blocked.length) throw Object.assign(new TosanoError(`Bloccato dalle tue regole: ${blocked.map(b => b.name).join(', ')}`, 'SAFETY_BLOCKED'), { details: blocked });
    if (review.length) throw Object.assign(new TosanoError(`Da verificare prima di procedere: ${review.map(b => b.name).join(', ')}. Usa tosano_check_product e, se l'utente ha letto l'etichetta, tosano_profile_prepare_change type=product_confirm.`, 'SAFETY_REVIEW_REQUIRED'), { details: review });
    return { checked: products.length };
  }
  async #productsFor(kind, params, base) {
    if (kind === 'list_to_cart') return base.view.list.items;
    if (kind === 'reorder') return base.view.order.items;
    if (kind === 'checkout') return base.view.items;
    return [];
  }
  #kinds() {
    const s = this.site, c = this.client;
    const cartBase = async () => { const cart = await c.readCart(); return { fp: cartFingerprint(cart), view: cart }; };
    const diffCart = (before, after) => {
      const b = new Map(before.items.map(i => [i.productId, i.quantity]));
      return after.items.filter(i => (b.get(i.productId) ?? 0) !== i.quantity)
        .map(i => ({ productId: i.productId, name: i.name, from: b.get(i.productId) ?? 0, to: i.quantity }));
    };
    return {
      cart_empty: { flag: 'allowCartWrites',
        baseline: async () => { const cb = await cartBase(); if (!cb.view.items?.length) throw new TosanoError('Cart already empty', 'CART_EMPTY');
          return { fp: cb.fp, view: { cartId: cb.view.cartId, itemCount: cb.view.items.length, total: cb.view.total, items: cb.view.items.map(i => ({ name: i.name, quantity: i.quantity })), warning: 'Rimuove TUTTI i prodotti dal carrello.' } }; },
        execute: (p, base) => c.siteWrite('/ebsn/api/cart/close', { cart_id: base.view.cartId }),
        verify: async () => { const cart = await c.readCart(); return { status: cart.items.length === 0 ? 'confirmed' : 'unverified', remaining: cart.items.length, cart }; } },
      order_retry_payment: { flag: 'allowCheckout',
        baseline: async p => { const pend = await s.ordersPaymentPending(); const o = pend.orders.find(x => x.orderId === p.orderId);
          if (!o) throw new TosanoError('Order is not waiting for a payment retry', 'ORDER_NOT_PENDING_PAYMENT');
          return { fp: sha([o.orderId, o.status, o.total]), view: { order: o, warning: 'Ritenta l\'addebito dell\'ordine con il metodo già associato. Può avviare un pagamento reale.' } }; },
        execute: p => c.siteWrite('/ebsn/api/order/payment', { order_id: p.orderId }),
        verify: async p => { const pend = await s.ordersPaymentPending(); const still = pend.orders.some(x => x.orderId === p.orderId); let o = null; try { o = await s.order(p.orderId); } catch {}
          return { status: still ? 'unverified' : 'confirmed', stillPending: still, orderStatus: o?.status ?? null, note: still ? 'Il sito potrebbe richiedere un passaggio sul gateway di pagamento: completa dal sito.' : undefined }; } },
      order_change_payment: { flag: 'allowCheckout',
        baseline: async p => { const pend = await s.ordersPaymentPending(); const o = pend.orders.find(x => x.orderId === p.orderId);
          if (!o) throw new TosanoError('Order is not waiting for a payment retry', 'ORDER_NOT_PENDING_PAYMENT');
          return { fp: sha([o.orderId, o.status, o.total, p]), view: { order: o, newPaymentTypeId: p.paymentTypeId, userPaymentAuthId: p.userPaymentAuthId ?? null, warning: 'Cambia il metodo di pagamento dell\'ordine; può avviare un addebito reale.' } }; },
        execute: p => c.siteWrite('/ebsn/api/order/modify-payment-type', { order_id: p.orderId, payment_type_id: p.paymentTypeId, ...(p.userPaymentAuthId ? { user_payment_auth_id: p.userPaymentAuthId } : {}), payment_data: '{}' }),
        verify: async p => { const pend = await s.ordersPaymentPending(); const still = pend.orders.some(x => x.orderId === p.orderId);
          return { status: still ? 'unverified' : 'confirmed', stillPending: still }; } },
      list_delete: { flag: 'allowListWrites',        baseline: async p => { const l = await s.list(p.listId); return { fp: sha(l), view: { listId: l.listId, name: l.name, itemCount: l.items.length } }; },
        execute: p => c.siteWrite('/ebsn/api/wishlist/delete', { list_id: p.listId }),
        verify: async p => { const ls = await s.lists(); const gone = !ls.lists.some(l => l.listId === p.listId); return { status: gone ? 'confirmed' : 'missing', lists: ls.lists }; } },
      list_to_cart: { flag: 'allowCartWrites',
        baseline: async p => { const l = await s.list(p.listId), cb = await cartBase(); return { fp: sha([l, cb.fp]), view: { list: l, cartTotalBefore: cb.view.total }, before: cb.view }; },
        execute: p => c.siteWrite('/ebsn/api/cart/add-all-from-wishlist', { list_id: p.listId, ...NS }),
        verify: async (p, base) => {
          const after = await c.readCart(), changed = diffCart(base.before, after);
          const perItem = base.view.list.items.map(i => ({ productId: i.productId, name: i.name,
            status: changed.some(x => x.productId === i.productId) ? 'confirmed' : 'missing' }));
          const n = perItem.filter(x => x.status === 'confirmed').length;
          return { status: n === perItem.length ? 'confirmed' : n ? 'partial' : 'missing', perItem, cart: after };
        } },
      reorder: { flag: 'allowCartWrites',
        baseline: async p => { const o = await s.order(p.orderId), cb = await cartBase(); return { fp: sha([o.orderId, o.items.length, cb.fp]), view: { order: o, cartTotalBefore: cb.view.total }, before: cb.view }; },
        execute: p => c.siteWrite('/ebsn/api/cart/add-all-from-order', { order_id: p.orderId, ...NS }),
        verify: async (p, base) => { const after = await c.readCart(), changed = diffCart(base.before, after); return { status: changed.length ? 'confirmed' : 'missing', changed, cart: after }; } },
      select_timeslot: { flag: 'allowCartWrites',
        baseline: async p => {
          const t = await s.timeslots(), day = t.days.find(d => d.date === p.date), slot = day?.timeslots.find(x => x.timeslotId === p.timeslotId);
          if (!slot) throw new TosanoError('Timeslot not offered for that date', 'TIMESLOT_NOT_FOUND');
          if (slot.available === false) throw new TosanoError('Timeslot not available', 'TIMESLOT_UNAVAILABLE');
          const cb = await cartBase(); return { fp: sha([slot, cb.fp]), view: { date: p.date, slot, currentTimeslot: cb.view.timeslot } };
        },
        execute: p => c.siteWrite('/ebsn/api/timeslot/select', { sel_date: p.date, timeslot_id: p.timeslotId }),
        verify: async (p, base) => { const cart = await c.readCart(); return { status: cart.timeslot && cart.timeslot.name === base.view.slot.name ? 'confirmed' : 'unverified', timeslot: cart.timeslot }; } },
      select_address: { flag: 'allowCartWrites',
        baseline: async p => {
          const a = await s.addresses(p.addressType), addr = a.addresses.find(x => x.addressId === p.addressId);
          if (!addr) throw new TosanoError('Address not offered for that service', 'ADDRESS_NOT_FOUND');
          const cb = await cartBase(); return { fp: sha([addr, cb.fp]), view: { address: addr, currentLocation: cb.view.pickupOrDeliveryLocation, warning: 'Changing location can drop the timeslot and change prices/availability.' } };
        },
        execute: (p, base) => c.siteWrite('/ebsn/api/user-address/select', { address_type: p.addressType, address_id: p.addressId, delivery_service_id: base.view.address.deliveryServiceId }),
        verify: async (p, base) => { const cart = await c.readCart(); return { status: cart.pickupOrDeliveryLocation === base.view.address.label ? 'confirmed' : 'unverified', location: cart.pickupOrDeliveryLocation, timeslot: cart.timeslot }; } },
      order_cancel: { flag: 'allowOrderWrites',
        baseline: async p => { const o = await s.order(p.orderId); if (o.deletable === false) throw new TosanoError('Site reports order not cancellable', 'ORDER_NOT_CANCELLABLE');
          return { fp: sha([o.orderId, o.status, o.total]), view: { order: { orderId: o.orderId, status: o.status, total: o.total, timeslot: o.timeslot } } }; },
        execute: p => c.siteWrite('/ebsn/api/order/delete', { order_id: p.orderId }),
        verify: async (p, base) => { let o = null; try { o = await s.order(p.orderId); } catch {} return { status: !o || o.status !== base.view.order.status ? 'confirmed' : 'unverified', orderStatus: o?.status ?? null }; } },
      order_modify: { flag: 'allowOrderWrites',
        baseline: async p => { const o = await s.order(p.orderId); if (o.editable === false) throw new TosanoError('Site reports order not editable', 'ORDER_NOT_EDITABLE');
          const cb = await cartBase(); return { fp: sha([o.orderId, o.status, cb.fp]), view: { order: { orderId: o.orderId, status: o.status, total: o.total }, warning: 'The order is reopened into the cart and must be confirmed again with checkout before its deadline.' } }; },
        execute: p => c.siteWrite('/ebsn/api/order/modify', { order_id: p.orderId }),
        verify: async () => { const cart = await c.readCart(); return { status: cart.items?.length ? 'confirmed' : 'unverified', cart }; } },
      checkout: { flag: 'allowCheckout',
        baseline: async p => {
          const pre = await s.checkoutPreview();
          if (!pre.readyForCheckout) throw new TosanoError('Checkout blocked: ' + pre.blockers.join(','), 'CHECKOUT_BLOCKED');
          if (pre.paymentTypes.length && !pre.paymentTypes.some(x => x.paymentTypeId === p.paymentTypeId))
            throw new TosanoError('Payment type not offered for this cart', 'PAYMENT_TYPE_INVALID');
          return { fp: cartFingerprint(pre.cart), view: { items: pre.cart.items, subtotal: pre.cart.subtotal, deliveryFee: pre.cart.deliveryFee,
            packagingFee: pre.cart.packagingFee, total: pre.cart.total, mode: pre.cart.mode, location: pre.cart.pickupOrDeliveryLocation,
            timeslot: pre.cart.timeslot, paymentType: pre.paymentTypes.find(x => x.paymentTypeId === p.paymentTypeId) ?? { paymentTypeId: p.paymentTypeId },
            userPaymentAuthId: p.userPaymentAuthId ?? null, warning: 'Final amount may differ for weighed products. This places a real order.' } };
        },
        execute: async p => {
          await c.siteWrite('/ebsn/api/checkout/prepare', NS);
          return c.siteWrite('/ebsn/api/checkout/buy', { ...NS, payment_type_id: p.paymentTypeId, ...(p.userPaymentAuthId ? { user_payment_auth_id: p.userPaymentAuthId } : {}) });
        },
        verify: async (p, base, response) => {
          const orderId = extractOrderId(response);
          if (!orderId) return { status: 'unverified', warning: 'No order id in response. Check orders before doing anything else. Never retry.' };
          let order = null; try { order = await s.order(orderId); } catch {}
          return { status: order ? 'confirmed' : 'unverified', orderId, order };
        } }
    };
  }
  #params(kind, p = {}) {
    const n = (k) => posInt(p[k], k);
    switch (kind) {
      case 'list_delete': case 'list_to_cart': return { listId: n('listId') };
      case 'cart_empty': return {};
      case 'reorder': case 'order_cancel': case 'order_modify': case 'order_retry_payment': return { orderId: n('orderId') };
      case 'order_change_payment': return { orderId: n('orderId'), paymentTypeId: n('paymentTypeId'), ...(p.userPaymentAuthId ? { userPaymentAuthId: n('userPaymentAuthId') } : {}) };
      case 'select_timeslot': if (typeof p.date !== 'string' || !/^[\w:.-]{4,40}$/.test(p.date)) throw new TosanoError('Invalid date', 'INVALID_ARGUMENT'); return { date: p.date, timeslotId: n('timeslotId') };
      case 'select_address': if (!['drive', 'home', 'locker'].includes(p.addressType)) throw new TosanoError('Invalid address type', 'INVALID_ARGUMENT'); return { addressType: p.addressType, addressId: n('addressId') };
      case 'checkout': return { paymentTypeId: n('paymentTypeId'), ...(p.userPaymentAuthId ? { userPaymentAuthId: n('userPaymentAuthId') } : {}) };
      default: throw new TosanoError('Unknown action kind', 'INVALID_ARGUMENT');
    }
  }
  async prepare(kind, rawParams) {
    const params = this.#params(kind, rawParams), spec = this.#kinds()[kind];
    this.#checkPermission(kind);
    const base = await spec.baseline(params);
    const max = this.prefsFn().permissions?.maxOrderTotal;
    if (kind === 'checkout' && Number.isFinite(max) && Number.isFinite(base.view.total) && base.view.total > max)
      throw new TosanoError(`Totale ${base.view.total} € oltre il tetto di spesa impostato (${max} €)`, 'OVER_SPENDING_LIMIT');
    const safety = await this.#safetyGate(await this.#productsFor(kind, params, base));
    base.view = { ...base.view, safetyCheck: safety.checked ? `${safety.checked} prodotti verificati contro le tue regole` : 'nessuna regola da verificare' };
    const a = this.store.createSiteAction(this.profileId, { kind, params, baselineFingerprint: base.fp, summary: base.view });
    return { planId: a.id, kind, state: a.state, expiresAt: a.expiresAt, summary: a.summary,
      requiredFlag: spec.flag,
      confirmationPhrase: `CONFERMO ${a.id.slice(0, 8).toUpperCase()}`, requiresExplicitUserConfirmation: true,
      warning: 'Show this exact summary to the user. Commit only after their explicit approval in a later message.' };
  }
  async commit(planId, phrase) {
    const next = this.#queue.then(() => this.#commit(planId, phrase));
    this.#queue = next.catch(() => {});
    return next;
  }
  async #commit(planId, phrase) {
    const a = this.store.getSiteAction(this.profileId, planId);
    if (!a) throw new TosanoError('Plan not found', 'PLAN_NOT_FOUND');
    if (a.state === 'succeeded') return { status: 'already_applied', result: a.result, planId };
    if (a.state !== 'prepared') throw new TosanoError('Plan state ' + a.state + '; do not retry', 'PLAN_NOT_PREPARED');
    if (phrase !== `CONFERMO ${a.id.slice(0, 8).toUpperCase()}`) throw new TosanoError('Exact plan confirmation phrase required', 'APPROVAL_REQUIRED');
    const spec = this.#kinds()[a.kind];
    this.#checkPermission(a.kind);
    const claim = this.store.claimSiteAction(this.profileId, planId);
    if (!claim.claimed) throw new TosanoError(claim.reason, claim.reason);
    let base;
    try { base = await spec.baseline(a.params); }
    catch (e) { this.store.finishSiteAction(this.profileId, planId, 'stale', { reason: e.code ?? 'BASELINE_FAILED' }); throw e; }
    if (base.fp !== a.baselineFingerprint) {
      this.store.finishSiteAction(this.profileId, planId, 'stale', { reason: 'State changed since the plan was shown; prepare a new plan' });
      throw new TosanoError('State changed since approval; prepare again', 'PLAN_STALE');
    }
    try { await this.#safetyGate(await this.#productsFor(a.kind, a.params, base)); }
    catch (e) { this.store.finishSiteAction(this.profileId, planId, 'stale', { reason: e.code ?? 'SAFETY_RECHECK_FAILED' }); throw e; }
    let response;
    try { response = await spec.execute(a.params, base); }
    catch (e) {
      const ambiguous = e.code === 'NETWORK_AMBIGUOUS';
      this.store.finishSiteAction(this.profileId, planId, ambiguous ? 'unknown' : 'failed', { error: e.code ?? 'WRITE_FAILED' });
      throw e;
    }
    let check;
    try { check = await spec.verify(a.params, base, response); }
    catch { check = { status: 'unverified', warning: 'Write sent; read-back failed. Do not retry; check status first.' }; }
    const state = check.status === 'confirmed' ? 'succeeded' : 'unknown';
    this.store.finishSiteAction(this.profileId, planId, state, check);
    return { planId, kind: a.kind, state, ...check, retryAllowed: false };
  }
  status(planId) { return this.store.getSiteAction(this.profileId, planId) ?? { error: 'PLAN_NOT_FOUND' }; }
}
