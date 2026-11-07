import { BASE_URL } from './config.mjs';
import { cartView, productView, searchView } from './sanitize.mjs';
import { classifyAccountIdentity } from './identity.mjs';
import { SITE_READS, SITE_WRITES, WRITE_FLAG_ENV } from './site-paths.mjs';

export class TosanoError extends Error {
  constructor(message, code = 'TOSANO_ERROR') { super(message); this.code = code; }
}
function validInteger(value, name, min = 1, max = 10000000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TosanoError(`Invalid ${name}`, 'INVALID_ARGUMENT');
  return value;
}
/** Pieces (integer) or, for weighed 'Sfuso' items, kg with up to 3 decimals. */
export function validQuantity(q) {
  if (typeof q !== 'number' || !Number.isFinite(q) || q <= 0 || q > 100 || Math.round(q * 1000) / 1000 !== q) throw new TosanoError('Invalid quantity', 'INVALID_ARGUMENT');
  return q;
}
function validProducts(items, max = 20) {
  if (!Array.isArray(items) || !items.length || items.length > max) throw new TosanoError(`Expected 1-${max} products`, 'INVALID_ARGUMENT');
  return items.map(x => ({
    productId: validInteger(x.productId, 'productId'),
    quantity: validQuantity(x.quantity),
    infos: { ...(x.options ?? {}), accept_alternatives: x.acceptAlternatives === true }
  }));
}
function urlFor(path, query = {}) {
  if (!path.startsWith('/ebsn/api/')) throw new TosanoError('Only EBSN API calls are allowed', 'INVALID_PATH');
  const u = new URL(path, BASE_URL);
  if (u.origin !== BASE_URL) throw new TosanoError('External destination blocked', 'INVALID_PATH');
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) u.searchParams.set(key, String(value));
  }
  return u.toString();
}

/** http: Playwright's context.request or a fake implementing get/post for testing */
export class TosanoClient {
  #http;
  #config;
  #lastCart = null;
  #writeQueue = Promise.resolve();
  constructor(http, config) { this.#http = http; this.#config = config; }

  async #requestEnvelope(method, path, query = {}, data = undefined) {
    const url = urlFor(path, query);
    const headers = {
      Accept: 'application/json',
      'X-Ebsn-Client': 'site',
      'X-Ebsn-Client-Redirect': 'site',
      'X-Ebsn-Version': '1.1.63',
      ...(method === 'POST' ? { Origin: BASE_URL, 'Content-Type': 'application/json' } : {})
    };
    let response;
    try {
      const options = { headers, timeout: 15000, maxRedirects: 0 };
      response = method === 'GET'
        ? await this.#http.get(url, options)
        : await this.#http.post(url, { ...options, data });
    } catch {
      // NEVER retry a mutation whose outcome may be unknown. Reads cannot change the cart.
      if (method === 'GET') throw new TosanoError('Network read failed. No cart modification was attempted.', 'NETWORK_READ_FAILED');
      throw new TosanoError('Network error; operation outcome unknown. Check cart in browser before repeating.', 'NETWORK_AMBIGUOUS');
    }
    if (response.status() === 401 || response.status() === 403) throw new TosanoError('Tosano session expired: run npm run login again', 'SESSION_EXPIRED');
    if (!response.ok()) throw new TosanoError(`Tosano HTTP error ${response.status()}`, 'HTTP_ERROR');
    let payload;
    try { payload = await response.json(); } catch { throw new TosanoError('Non-JSON response (possible login redirect or expiration)', 'INVALID_RESPONSE'); }
    if (payload?.response?.status !== 0 || (payload?.response?.errors?.length ?? 0) > 0) {
      // Do not include server-supplied error text that could contain personal fields.
      throw new TosanoError('Tosano rejected request; inspect the site directly', 'EBSN_REJECTED');
    }
    if (!payload || !('data' in payload)) throw new TosanoError('Missing response data', 'INVALID_RESPONSE');
    return payload;
  }
  async #request(method, path, query = {}, data = undefined) {
    return (await this.#requestEnvelope(method, path, query, data)).data;
  }

  #context() {
    const hash = this.#config.getContextHash?.() || this.#config.contextHash;
    if (!hash) throw new TosanoError('No Tosano purchase context found. Open npm run login, select a store/slot and search for a product.', 'MISSING_CONTEXT');
    return hash;
  }
  async verifySession() {
    // A public catalog search can succeed for guests. Unlike search(), this checks the
    // account identity returned by Tosano's *same API response*. Never expose it to MCP.
    const envelope = await this.#requestEnvelope('GET', '/ebsn/api/products', {
      q: 'pasta', page: 1, page_size: 1, sort: '', promo: false, new_product: false, hash: this.#context()
    });
    return {
      ...classifyAccountIdentity(envelope.user),
      purchaseContextPresent: true,
      purchaseContextSource: this.#config.getContextHashSource?.() ?? 'configured'
    };
  }
  async search(query, { page = 1, pageSize = 24, promo = false } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > 150) throw new TosanoError('Invalid search query', 'INVALID_ARGUMENT');
    validInteger(page, 'page', 1, 1000);
    validInteger(pageSize, 'pageSize', 1, 60);
    const data = await this.#request('GET', '/ebsn/api/products', {
      q: query.trim(), page, page_size: pageSize, sort: '', promo, new_product: false, hash: this.#context()
    });
    return searchView(data);
  }
  /** Product listing by category, promotions or the user's "preferiti" (products?preferred=1). */
  async listProducts({ categoryId, promo = false, preferred = false, page = 1, pageSize = 24 } = {}) {
    validInteger(page, 'page', 1, 1000); validInteger(pageSize, 'pageSize', 1, 60);
    if (categoryId !== undefined) validInteger(categoryId, 'categoryId');
    if (categoryId === undefined && !preferred && !promo) throw new TosanoError('categoryId, promo or preferred required', 'INVALID_ARGUMENT');
    const data = await this.#request('GET', '/ebsn/api/products', {
      ...(categoryId ? { parent_category_id: categoryId } : {}), ...(preferred ? { preferred: 1 } : {}),
      page, page_size: pageSize, sort: '', promo: promo === true, new_product: false, hash: this.#context() });
    return searchView(data);
  }
  getContextKey() { return this.#context(); }
  async productDetails(slug) {
    if (typeof slug !== 'string' || !/^[a-z0-9-]{3,200}$/.test(slug)) throw new TosanoError('Invalid product slug', 'INVALID_ARGUMENT');
    const data = await this.#request('GET', '/ebsn/api/products', { slug, hash: this.#context() });
    return productView(data);
  }
  async readCart() {
    const cartReadPath = (await this.#config.getCartReadPath?.()) || this.#config.cartReadPath;
    if (!cartReadPath) {
      if (!this.#lastCart) throw new TosanoError('Cart GET endpoint not yet observed. Run scripts/discover-cart-windows.ps1 on Windows, open the cart in the Docker Chromium browser, and wait for a verified GET response.', 'UNVERIFIED_ENDPOINT');
      return { ...this.#lastCart, live: false, source: 'last_mutation_only', warning: 'Not a fresh read. May be outdated if modified in the site.' };
    }
    const data = await this.#request('GET', cartReadPath);
    if (!data || !Array.isArray(data.cartItems) || !Number.isSafeInteger(data.cartId))
      throw new TosanoError('Cart read response does not match validated cart format', 'INVALID_CART_RESPONSE');
    this.#lastCart = cartView(data, { source: 'fresh_get', live: true });
    return this.#lastCart;
  }
  #checkWrites() {
    if (!this.#config.allowCartWrites) throw new TosanoError('Cart writes disabled. Set ALLOW_CART_WRITES=true after testing.', 'WRITES_DISABLED');
  }
  // Queue mutations so simultaneous ChatGPT tool calls cannot race each other.
  #serial(fn) {
    const next = this.#writeQueue.then(fn);
    this.#writeQueue = next.catch(() => {});
    return next;
  }
  #commit(data, operation) {
    this.#lastCart = cartView(data, { source: operation, live: true });
    return this.#lastCart;
  }
  /** Allowlisted read of an observed site endpoint. Returns raw data for sanitizers only. */
  async siteGet(path, query = {}) {
    if (!Object.hasOwn(SITE_READS, path)) throw new TosanoError('Endpoint not in observed read allowlist', 'INVALID_PATH');
    return this.#request('GET', path, query);
  }
  /** Allowlisted, flag-gated, serialized mutation. Never retried. */
  async siteWrite(path, query = {}, data = undefined) {
    const spec = SITE_WRITES[path];
    if (!spec) throw new TosanoError('Endpoint not in observed write allowlist', 'INVALID_PATH');
    if (this.#config[spec.flag] !== true)
      throw new TosanoError(`Writes disabled. Set ${WRITE_FLAG_ENV[spec.flag]}=true after testing.`, 'WRITES_DISABLED');
    return this.#serial(async () => {
      if (spec.method === 'GET') {
        try { return await this.#request('GET', path, query); }
        catch (e) {
          // A GET that mutates is still a mutation: a lost response is ambiguous.
          if (e.code === 'NETWORK_READ_FAILED') throw new TosanoError('Network error; operation outcome unknown. Verify before repeating.', 'NETWORK_AMBIGUOUS');
          throw e;
        }
      }
      return this.#request('POST', path, query, data);
    });
  }
  async addItems(items) {
    this.#checkWrites();
    const payload = { items: validProducts(items) };
    return this.#serial(async () => this.#commit(
      await this.#request('POST', '/ebsn/api/cart/add', { show_sectors: false }, payload), 'add_response'));
  }
  async updateQuantity(itemId, quantity) {
    this.#checkWrites();
    validInteger(itemId, 'itemId'); validQuantity(quantity);
    return this.#serial(async () => this.#commit(
      await this.#request('POST', '/ebsn/api/cart/update', { show_sectors: false },
        { items: [{ itemId, quantity, searchParams: {} }] }), 'update_response'));
  }
  async deleteItem(itemId, productId) {
    this.#checkWrites();
    validInteger(itemId, 'itemId'); validInteger(productId, 'productId');
    return this.#serial(async () => this.#commit(
      await this.#request('POST', '/ebsn/api/cart/delete', { show_sectors: false },
        { items: [{ itemId, productId }] }), 'delete_response'));
  }
}
