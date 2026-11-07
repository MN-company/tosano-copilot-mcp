import os from 'node:os';
import path from 'node:path';

export const BASE_URL = 'https://www.latuaspesa.com';
const USER_DIR = path.join(os.homedir(), '.tosano-copilot', 'browser-profile');
export function getConfig(env = process.env) {
  const port = Number(env.PORT || 3788);
  const bindHost = env.MCP_BIND_HOST || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(bindHost)) throw new Error('MCP_BIND_HOST must be 127.0.0.1 or 0.0.0.0');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
  const channel = env.TOSANO_BROWSER_CHANNEL || 'chromium';
  if (!['chromium', 'chrome'].includes(channel)) throw new Error('Browser channel must be chromium or chrome');
  let cartReadPath = (env.TOSANO_CART_READ_PATH || '').trim();
  if (cartReadPath) {
    // In particular: never allow arbitrary domains or account/action routes as a GET override.
    if (!/^\/ebsn\/api\/cart(?:\/[a-z-]+)?(?:\?[a-z_=&0-9-]+)?$/.test(cartReadPath)) {
      throw new Error('TOSANO_CART_READ_PATH must be an observed cart API path on the Tosano domain');
    }
    if (/\/(add|update|delete|checkout|pay|confirm)(?:\?|$)/.test(cartReadPath)) {
      throw new Error('TOSANO_CART_READ_PATH cannot point to a mutation');
    }
  }
  const hash = (env.TOSANO_CONTEXT_HASH || '').trim();
  if (hash && !/^[A-Za-z0-9_-]{5,100}$/.test(hash)) throw new Error('Invalid TOSANO_CONTEXT_HASH');
  return {
    port,
    bindHost,
    channel,
    profilePath: USER_DIR,
    contextHash: hash,
    cartReadPath,
    allowCartWrites: env.ALLOW_CART_WRITES === 'true',
    allowListWrites: env.ALLOW_LIST_WRITES === 'true',
    allowOrderWrites: env.ALLOW_ORDER_WRITES === 'true',
    allowCheckout: env.ALLOW_CHECKOUT === 'true'
  };
}
