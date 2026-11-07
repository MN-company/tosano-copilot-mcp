/** Capture Tosano's context hash from real product requests made by the user's browser.
 * No cookies, credentials, or network payloads are stored in this module.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BASE_URL } from './config.mjs';
import { readObservedCartPath } from './cart-read-discovery.mjs';

const CONTEXT_FILE = path.join(os.homedir(), '.tosano-copilot', 'context.json');
const HASH_RE = /^[A-Za-z0-9_-]{5,100}$/;
const trackers = new WeakMap();

export function extractContextHash(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== BASE_URL || url.pathname !== '/ebsn/api/products') return null;
    const hash = url.searchParams.get('hash');
    return hash && HASH_RE.test(hash) ? hash : null;
  } catch { return null; }
}

export class ContextHashTracker {
  #file;
  #hash = '';
  #source = 'missing';
  #pending = Promise.resolve();
  #onRequest;
  constructor(file = CONTEXT_FILE) { this.#file = file; }
  get hash() { return this.#hash; }
  get source() { return this.#source; }

  async load(envHash = '') {
    this.#hash = HASH_RE.test(envHash) ? envHash : '';
    this.#source = this.#hash ? 'env_fallback' : 'missing';
    try {
      const saved = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      if (HASH_RE.test(saved.hash)) {
        this.#hash = saved.hash;
        this.#source = 'saved_browser_observation';
      }
    } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    return this;
  }

  observe(rawUrl) {
    const hash = extractContextHash(rawUrl);
    if (!hash) return false;
    if (hash === this.#hash && this.#source === 'live_browser_observation') return false;
    this.#hash = hash;
    this.#source = 'live_browser_observation';
    this.#pending = this.#pending.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      await fs.chmod(path.dirname(this.#file), 0o700);
      await fs.writeFile(this.#file, JSON.stringify({ hash, capturedAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
      await fs.chmod(this.#file, 0o600);
    });
    return true;
  }

  attach(browserContext) {
    this.#onRequest = req => { this.observe(req.url()); };
    browserContext.on('request', this.#onRequest);
    trackers.set(browserContext, this);
    return this;
  }
  async flush() { await this.#pending; }
  detach(browserContext) {
    if (this.#onRequest) browserContext.off('request', this.#onRequest);
    trackers.delete(browserContext);
  }
}

export function getContextTracker(browserContext) { return trackers.get(browserContext); }
export function contextualConfig(browserContext, config) {
  const tracker = getContextTracker(browserContext);
  return { ...config, getContextHash: () => tracker?.hash || config.contextHash || '',
    getContextHashSource: () => tracker?.source || (config.contextHash ? 'env_fallback' : 'missing'),
    getCartReadPath: () => readObservedCartPath() };
}
