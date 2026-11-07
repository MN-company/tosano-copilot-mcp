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

/** LaTuaSpesa keeps a per-session server copy of the cart: a session does not see cart
 * changes made by other sessions (the user's own browser) until it starts a new one.
 * The login survives in the persistent "X-Ebsn-Account" cookie, so dropping only the
 * in-memory session cookies makes the server open a fresh session with the current cart.
 * If the account is no longer recognised afterwards, the old cookies are restored.
 * Returns { refreshed, dropped } with cookie NAMES only, never values.
 */
export async function refreshSiteSession(context, verify) {
  // All paths (a session cookie may be scoped to /ebsn), only the site's own domain.
  const all = (await context.cookies()).filter(c => /^\.?(www\.)?latuaspesa\.com$/.test(c.domain));
  const session = all.filter(c => c.expires === -1);
  if (!session.length) return { refreshed: false, reason: 'no_session_cookies' };
  if (!all.some(c => c.name === 'X-Ebsn-Account' && c.expires !== -1)) return { refreshed: false, reason: 'no_persistent_login' };
  for (const c of session) await context.clearCookies({ name: c.name, domain: c.domain, path: c.path });
  let ok = false;
  try { ok = await verify(); } catch { ok = false; }
  if (!ok) {
    await context.addCookies(session);
    return { refreshed: false, reason: 'restored_previous_session', dropped: session.map(c => c.name) };
  }
  return { refreshed: true, dropped: session.map(c => c.name) };
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
