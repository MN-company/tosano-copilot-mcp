/** EBSN endpoints observed in the public LaTuaSpesa web bundle (/js/app.*.js, 2026-11-07).
 * Each entry records how the site's own frontend calls it. Anything not listed is refused.
 * Categories gate writes behind independent env flags.
 */
export const SITE_READS = Object.freeze({
  '/ebsn/api/cart/view': 'cart',
  '/ebsn/api/wishlist/list': 'lists',
  '/ebsn/api/wishlist/view': 'lists',
  '/ebsn/api/timeslot/list': 'context',
  '/ebsn/api/store/list': 'context',
  '/ebsn/api/store/view': 'context',
  '/ebsn/api/user-address/list': 'context',
  '/ebsn/api/user-address/delivery-service-list': 'context',
  '/ebsn/api/delivery-fee/view': 'context',
  '/ebsn/api/order/list': 'orders',
  '/ebsn/api/order/view': 'orders',
  '/ebsn/api/category': 'catalog',
  '/ebsn/api/payment-type/list-auth': 'checkout',
  '/ebsn/api/cart/purchase-restriction': 'cart',
  '/ebsn/api/giftcertificate/list': 'checkout',
  '/ebsn/api/packaging-type/list': 'cart',
  '/ebsn/api/order/list-retry-payment': 'orders',
  '/ebsn/api/checkout/prebilled-amount': 'checkout'
});
/** method + flag per mutation. GET mutations are how the site itself calls them. */
export const SITE_WRITES = Object.freeze({
  '/ebsn/api/wishlist/insert': { method: 'POST', flag: 'allowListWrites' },
  '/ebsn/api/wishlist/update': { method: 'POST', flag: 'allowListWrites' },
  '/ebsn/api/wishlist/delete': { method: 'POST', flag: 'allowListWrites' },
  '/ebsn/api/wishlist/select': { method: 'POST', flag: 'allowListWrites' },
  '/ebsn/api/wishlist/add_prod': { method: 'POST', flag: 'allowListWrites' },
  '/ebsn/api/wishlist/update_prods': { method: 'POST', flag: 'allowListWrites' },
  '/ebsn/api/wishlist/delete_prods': { method: 'POST', flag: 'allowListWrites' },
  '/ebsn/api/cart/add-all-from-wishlist': { method: 'POST', flag: 'allowCartWrites' },
  '/ebsn/api/cart/add-all-from-order': { method: 'POST', flag: 'allowCartWrites' },
  '/ebsn/api/timeslot/select': { method: 'GET', flag: 'allowCartWrites' },
  '/ebsn/api/store/select': { method: 'POST', flag: 'allowCartWrites' },
  '/ebsn/api/user-address/select': { method: 'POST', flag: 'allowCartWrites' },
  '/ebsn/api/cart/update-infos': { method: 'POST', flag: 'allowCartWrites' },
  '/ebsn/api/cart-giftcertificate/add_code': { method: 'POST', flag: 'allowCartWrites' },
  '/ebsn/api/cart-giftcertificate/remove_code': { method: 'POST', flag: 'allowCartWrites' },
  '/ebsn/api/cart/close': { method: 'POST', flag: 'allowCartWrites' },
  '/ebsn/api/cart/update-cart-info': { method: 'POST', flag: 'allowCartWrites' },
  '/ebsn/api/order/payment': { method: 'POST', flag: 'allowCheckout' },
  '/ebsn/api/order/modify-payment-type': { method: 'POST', flag: 'allowCheckout' },
  '/ebsn/api/order/delete': { method: 'POST', flag: 'allowOrderWrites' },
  '/ebsn/api/order/modify': { method: 'POST', flag: 'allowOrderWrites' },
  '/ebsn/api/checkout/prepare': { method: 'POST', flag: 'allowCheckout' },
  '/ebsn/api/checkout/buy': { method: 'POST', flag: 'allowCheckout' }
});
export const WRITE_FLAG_ENV = Object.freeze({
  allowListWrites: 'ALLOW_LIST_WRITES', allowCartWrites: 'ALLOW_CART_WRITES',
  allowOrderWrites: 'ALLOW_ORDER_WRITES', allowCheckout: 'ALLOW_CHECKOUT'
});
