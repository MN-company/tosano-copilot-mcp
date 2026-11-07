/** Allowlist sanitizers for site responses. EBSN payloads carry personal, address and
 * payment data: only the fields below ever reach MCP. Field names follow the public web
 * bundle; unknown shapes degrade to empty results plus `schemaKeys` (key names only).
 */
import { productView } from './sanitize.mjs';

const id = v => (Number.isSafeInteger(v) && v > 0 ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null));
const str = (v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null));
const bool = v => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
const keys = o => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).slice(0, 40) : []);
const arr = v => (Array.isArray(v) ? v : []);

function lineItem(i = {}) {
  const p = productView(i.product ?? {});
  return { itemId: id(i.itemId), productId: id(p.productId), slug: p.slug, name: p.name, brand: p.brand,
    quantity: num(i.quantity), weight: num(i.weight), unitPrice: num(i.unitPrice ?? p.unitPrice), total: num(i.grossTotal) };
}

export function siteListsView(data = {}) {
  const lists = arr(data.personalList ?? data.lists).map(l => ({
    listId: id(l.id ?? l.listId), name: str(l.name, 100), isDefault: bool(l.isDefault) ?? false,
    itemCount: num(l.size ?? l.itemsCount ?? l.count)
  })).filter(l => l.listId);
  return { source: 'tosano_site', lists, page: data.page ? { page: num(data.page.selPage), totalPages: num(data.page.totPages) } : null,
    ...(lists.length ? {} : { schemaKeys: keys(data) }) };
}

export function siteListView(data = {}) {
  const items = arr(data.wishlistItems).map(lineItem);
  const inactive = arr(data.wishlistInactiveItems).map(i => ({ ...lineItem(i), unavailable: true }));
  return { source: 'tosano_site', listId: id(data.listId ?? data.id), name: str(data.name, 100),
    items, inactiveItems: inactive, ...(items.length || inactive.length || data.listId ? {} : { schemaKeys: keys(data) }) };
}

export function timeslotsView(days = []) {
  const list = Array.isArray(days) ? days : arr(days?.days);
  return { days: list.map(d => ({
    date: str(d.dateIndex ?? d.date, 40),
    timeslots: arr(d.timeslots).map(t => ({
      timeslotId: id(t.timeslotId ?? t.id), name: str(t.name, 60),
      begin: str(t.beginTime, 20), end: str(t.endTime, 20),
      status: str(t.status, 40), selected: bool(t.selected) ?? false,
      available: t.status ? !/full|closed|ko|sold|esaurit|chius/i.test(String(t.status)) : null
    })).filter(t => t.timeslotId)
  })) };
}

export function storesView(data = {}) {
  const stores = arr(Array.isArray(data) ? data : data.stores).map(s => ({
    storeId: id(s.storeId ?? s.id), name: str(s.name, 120), city: str(s.city ?? s.address?.city, 80)
  })).filter(s => s.storeId);
  return { stores };
}

/** Delivery addresses are personal: expose only the label the user chose and the city. */
export function addressesView(data = {}) {
  const addresses = arr(data.addresses ?? data).map(a => ({
    addressId: id(a.addressId ?? a.id), label: str(a.addressName, 120), type: str(a.addressType, 20),
    deliveryServiceId: id(a.deliveryServiceId), city: str(a.city, 80), selected: bool(a.selected) ?? false
  })).filter(a => a.addressId);
  return { addresses };
}

function orderSummary(o = {}) {
  return { orderId: id(o.orderId), status: str(o.orderStatusDescr, 80), statusId: id(o.orderStatusId),
    createdAt: str(o.addDate ?? o.orderDate, 40), timeslot: o.timeslot ? { date: str(o.timeslot.date, 40), name: str(o.timeslot.name, 60) } : null,
    mode: str(o.shippingAddress?.addressType, 20), location: str(o.shippingAddress?.addressName, 120),
    total: num(o.grossTotal), itemCount: num(o.totalItems),
    deletable: bool(o.isDeletable), editable: bool(o.isEditable) };
}
export function ordersView(data = {}) {
  const orders = arr(data.orders).map(orderSummary).filter(o => o.orderId);
  return { orders, page: data.page ? { page: num(data.page.selPage), totalPages: num(data.page.totPages) } : null,
    ...(orders.length ? {} : { schemaKeys: keys(data) }) };
}
export function orderView(data = {}) {
  const groups = [...arr(data.itemsList), ...arr(data.orderItems),
    ...arr(data.suborders).flatMap(s => arr(s.suborderItems ?? s.items))];
  return { ...orderSummary(data), items: groups.map(lineItem),
    ...(groups.length ? {} : { schemaKeys: keys(data) }) };
}

export function categoriesView(categories = [], depth = 2) {
  const walk = (list, d) => arr(list).map(c => ({ categoryId: id(c.categoryId ?? c.id), name: str(c.name, 100), slug: str(c.slug, 120),
    ...(d > 1 && arr(c.children ?? c.categories).length ? { children: walk(c.children ?? c.categories, d - 1) } : {}) }))
    .filter(c => c.categoryId);
  return { categories: walk(categories, depth) };
}

/** Saved payment methods: id + masked label only. Never card data. */
export function paymentAuthsView(auths = []) {
  return { paymentMethods: arr(auths).map(a => ({ userPaymentAuthId: id(a.userPaymentAuthId), paymentTypeId: id(a.paymentTypeId),
    label: str(a.creditCard ?? a.descr ?? a.name, 40)?.replace(/\d(?=\d{4})/g, '*') ?? null })).filter(a => a.userPaymentAuthId) };
}
export function paymentTypesView(list = []) {
  return arr(list).map(p => ({ paymentTypeId: id(p.paymentTypeId ?? p.id), name: str(p.descr ?? p.name, 80) })).filter(p => p.paymentTypeId);
}

export function deliveryFeeView(data = {}) {
  return { rows: arr(data.deliveryFeeRows).map(r => ({ from: num(r.rangeMin ?? r.from), to: num(r.rangeMax ?? r.to), fee: num(r.fee ?? r.price), label: str(r.descr, 80) })) };
}

/** Pull an order id out of a checkout/buy response without trusting its shape. */
export function extractOrderId(data = {}) {
  return id(data?.orderId) ?? id(data?.order?.orderId) ?? id(data?.cart?.orderId) ?? null;
}
