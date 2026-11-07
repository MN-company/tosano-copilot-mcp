/** Only trust strong, observed identity signals from EBSN's response.user.
 * A successful product search and cookie presence are NOT proof of login.
 * Never emit login, account ID, email or other account data to callers.
 */
export function classifyAccountIdentity(user) {
  const hasIdentity = user && Number.isSafeInteger(user.userId) && user.userId > 0 &&
    typeof user.login === 'string' && user.login.includes('@') &&
    user.profileConfirmed === true;
  return hasIdentity
    ? { authenticatedWithTosano: 'verified', evidence: 'confirmed_account_identity_in_api_response' }
    : { authenticatedWithTosano: 'unverified', evidence: 'no_confirmed_account_identity_in_api_response',
        note: 'Product search may be public. Check sign-in inside the Playwright Chromium profile.' };
}
