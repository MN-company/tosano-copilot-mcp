import fs from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getConfig, BASE_URL } from './config.mjs';
import { ContextHashTracker, contextualConfig } from './context-hash.mjs';
import { sessionStatus } from './session.mjs';
import { TosanoClient } from './client.mjs';

const config = getConfig();
const { chromium } = await import('playwright');
await fs.mkdir(config.profilePath, { recursive: true, mode: 0o700 });
await fs.chmod(config.profilePath, 0o700);
const context = await chromium.launchPersistentContext(config.profilePath, {
  headless: false,
  ...(config.channel === 'chrome' ? { channel: 'chrome' } : {})
});
const tracker = await new ContextHashTracker().load(config.contextHash);
tracker.attach(context);
try {
  const page = context.pages().find(p => p.url().startsWith(BASE_URL)) ?? context.pages()[0] ?? await context.newPage();
  if (!page.url().startsWith(BASE_URL)) await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  console.log('Your existing Chromium profile is reused. If you are already signed in, DO NOT sign in again.');
  console.log('Confirm your pickup/delivery context in this Chromium window. You may search for a product.');
  const rl = createInterface({ input, output });
  try { await rl.question('Return here and press ENTER when ready (do not paste the hash): '); }
  finally { rl.close(); }

  // A safe product search allows us to observe the site's current hash automatically.
  try {
    const responsePromise = page.waitForResponse(r =>
      r.url().startsWith(`${BASE_URL}/ebsn/api/products?`) && new URL(r.url()).searchParams.has('hash'),
      { timeout: 10000 }).catch(() => null);
    await page.goto(`${BASE_URL}/search?q=pasta`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await responsePromise;
  } catch { /* Existing observed hash / .env fallback may still work. */ }
  await tracker.flush();
  const client = new TosanoClient(context.request, contextualConfig(context, config));
  const status = await sessionStatus(client);
  console.log('Local session diagnosis (no account details):', JSON.stringify(status));
  console.log('Product context:', tracker.hash ? `available (${tracker.source})` : 'not captured; search for a product in this Chromium window');
  if (status.authenticatedWithTosano !== 'verified') {
    console.log('Account was NOT VERIFIED by the backend probe. This is not evidence of logout.');
    console.log('If the Chromium browser appears signed in, capture a fresh product search and try npm run doctor.');
  } else {
    console.log('Account identity verified via Tosano API. The browser profile has been preserved.');
  }
} finally {
  await tracker.flush();
  tracker.detach(context);
  await context.close();
}
