import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshSiteSession } from '../src/session.mjs';

function fakeContext(cookies) {
  let jar = cookies.map(c => ({ ...c }));
  return {
    jar: () => jar,
    cookies: async () => jar.map(c => ({ ...c })),
    clearCookies: async ({ name, domain, path }) => { jar = jar.filter(c => !(c.name === name && c.domain === domain && c.path === path)); },
    addCookies: async list => { jar.push(...list.map(c => ({ ...c }))); }
  };
}
const account = { name: 'X-Ebsn-Account', value: 'tok', domain: 'www.latuaspesa.com', path: '/', expires: 1900000000 };
const session = { name: 'JSESSIONID', value: 's1', domain: 'www.latuaspesa.com', path: '/ebsn', expires: -1 };
const consent = { name: 'CookieConsent', value: 'c', domain: 'www.latuaspesa.com', path: '/', expires: 1900000000 };

test('drops only in-memory session cookies, keeps the persistent login, names only in output', async () => {
  const ctx = fakeContext([account, session, consent]);
  const r = await refreshSiteSession(ctx, async () => true);
  assert.deepEqual(r, { refreshed: true, dropped: ['JSESSIONID'] });
  assert.deepEqual(ctx.jar().map(c => c.name).sort(), ['CookieConsent', 'X-Ebsn-Account']);
  assert.ok(!JSON.stringify(r).includes('s1') && !JSON.stringify(r).includes('tok'));
});

test('restores the old session when the account is not recognised afterwards', async () => {
  const ctx = fakeContext([account, session]);
  const r = await refreshSiteSession(ctx, async () => false);
  assert.equal(r.refreshed, false); assert.equal(r.reason, 'restored_previous_session');
  assert.deepEqual(ctx.jar().map(c => c.name).sort(), ['JSESSIONID', 'X-Ebsn-Account']);
  const r2 = await refreshSiteSession(fakeContext([account, session]), async () => { throw new Error('net'); });
  assert.equal(r2.reason, 'restored_previous_session');
});

test('never drops the session without a persistent login to fall back on', async () => {
  const ctx = fakeContext([session]);
  assert.deepEqual(await refreshSiteSession(ctx, async () => true), { refreshed: false, reason: 'no_persistent_login' });
  assert.equal(ctx.jar().length, 1);
  assert.deepEqual(await refreshSiteSession(fakeContext([account]), async () => true), { refreshed: false, reason: 'no_session_cookies' });
});
