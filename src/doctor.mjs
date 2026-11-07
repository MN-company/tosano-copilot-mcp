/** Read-only diagnostics. Does not print cookies, contact details, or API payloads. */
import { getConfig } from './config.mjs';
import { openBrowserSession, closeBrowserSession, sessionStatus } from './session.mjs';
import { contextualConfig, getContextTracker } from './context-hash.mjs';
import { TosanoClient } from './client.mjs';

const cfg = { ...getConfig(), allowCartWrites: false };
try {
  const browser = await openBrowserSession(cfg);
  const tracker = getContextTracker(browser);
  const client = new TosanoClient(browser.request, contextualConfig(browser, cfg));
  const report = await sessionStatus(client);
  console.log('Tosano diagnostics (sanitized):');
  console.log(JSON.stringify({
    profileOpened: true,
    contextHashPresent: Boolean(tracker?.hash),
    contextHashSource: tracker?.source ?? 'missing',
    ...report
  }, null, 2));
  if (report.authenticatedWithTosano !== 'verified') {
    console.log('Next step: close other Tosano scripts, run npm run login, then verify in the Chromium window and press ENTER.');
    process.exitCode = 1;
  } else console.log('Account verified: no new login is needed.');
} catch (e) {
  console.error('Doctor failed:', e.code ?? 'ERROR', e.code ? e.message : 'Unable to initialize local session.');
  process.exitCode = 1;
} finally { await closeBrowserSession(); }
