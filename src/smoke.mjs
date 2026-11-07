/** Read-only live smoke test. Uses local Playwright cookies; never places or modifies orders. */
import { getConfig } from './config.mjs';
import { openBrowserSession, closeBrowserSession, sessionStatus } from './session.mjs';
import { contextualConfig } from './context-hash.mjs';
import { TosanoClient } from './client.mjs';

const cfg = { ...getConfig(), allowCartWrites: false };
try {
  const browser = await openBrowserSession(cfg);
  const client = new TosanoClient(browser.request, contextualConfig(browser, cfg));
  const status = await sessionStatus(client);
  console.log('Session metadata:', JSON.stringify(status));
  if (status.authenticatedWithTosano !== 'verified') console.log('Warning: catalog search may work anonymously; cart writes require verified login.');
  const query = process.argv.slice(2).join(' ') || 'pasta';
  const result = await client.search(query, { page: 1, pageSize: 5 });
  console.log('Search results (sanitized):', JSON.stringify(result, null, 2));
} catch (e) {
  console.error('Smoke test failed:', e.code || e.name || 'ERROR', e.message || 'See README');
  process.exitCode = 1;
} finally {
  await closeBrowserSession();
}
