import fs from 'node:fs/promises';
import { getConfig } from './config.mjs';
import { ContextHashTracker, getContextTracker } from './context-hash.mjs';

let contextPromise;
export async function openBrowserSession(config = getConfig()) {
  if (contextPromise) return contextPromise;
  contextPromise = (async () => {
    const { chromium } = await import('playwright');
    await fs.mkdir(config.profilePath, { recursive: true, mode: 0o700 });
    await fs.chmod(config.profilePath, 0o700);
    const context = await chromium.launchPersistentContext(config.profilePath, {
      headless: true,
      ...(config.channel === 'chrome' ? { channel: 'chrome' } : {})
    });
    try {
      const tracker = await new ContextHashTracker().load(config.contextHash);
      tracker.attach(context);
      return context;
    } catch (e) { await context.close(); throw e; }
  })().catch(e => { contextPromise = undefined; throw e; });
  return contextPromise;
}

/** Actually asks Tosano who the session belongs to, instead of guessing from cookies.
 * Does not include email, address, account ID, or other personal data in output.
 */
export async function sessionStatus(client) {
  try {
    const result = await client.verifySession();
    return { browserReady: true, ...result };
  } catch (e) {
    return {
      browserReady: true,
      authenticatedWithTosano: 'unverified',
      evidence: 'probe_failed',
      reason: typeof e.code === 'string' ? e.code : 'PROBE_FAILED',
      note: 'An API read was attempted; an inability to verify login does not mean the browser is logged out.'
    };
  }
}

export async function closeBrowserSession() {
  if (!contextPromise) return;
  const promise = contextPromise;
  contextPromise = undefined;
  const context = await promise;
  const tracker = getContextTracker(context);
  if (tracker) {
    await tracker.flush();
    tracker.detach(context);
  }
  await context.close();
}
