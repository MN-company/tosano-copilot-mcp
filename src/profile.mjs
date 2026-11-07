/** User profile: dietary rules, agent permissions, onboarding.
 * Tightening applies immediately. Anything that LOOSENS protection (remove/downgrade a
 * dietary rule, widen permissions, accept a product whose label could not be verified)
 * needs prepare -> explicit approval phrase -> commit, and is written to the audit log.
 */
import { createHash } from 'node:crypto';
import { TosanoError } from './client.mjs';
import { ALLERGENS, allergenInfo } from './allergens.mjs';

const SEV = { intolleranza: 1, grave: 2 };
const PERM_RANK = { lists: { denied: 0, allowed: 1 }, cart: { denied: 0, ask: 1 }, orders: { denied: 0, ask: 1 }, checkout: { denied: 0, ask: 1 } };
const sha = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export function allergenCatalog() {
  return ALLERGENS.map(a => ({ key: a.key, label: a.label, basis: a.basis, examples: a.terms.slice(0, 8), ...(a.note ? { note: a.note } : {}) }));
}

export class ProfileManager {
  constructor(store, profileId = 'default') { this.store = store; this.profileId = profileId; }
  status() {
    const p = this.store.getPreferences(this.profileId);
    const steps = [
      { step: 'permessi', done: this.store.getSetting(this.profileId, 'onboardPermsDone', false),
        ask: 'Cosa può fare l\'agente: modificare le liste del sito da solo? Preparare modifiche al carrello e agli ordini (sempre con tua conferma)? Confermare ordini (checkout)? Tetto di spesa per ordine?' },
      { step: 'marche', done: this.store.getSetting(this.profileId, 'onboardBrandsDone', false),
        ask: 'Marche da evitare sempre, e marche preferite per categoria (es. yogurt → Mila)?' },
      { step: 'intolleranze', done: this.store.getSetting(this.profileId, 'onboardDietDone', false),
        ask: 'Allergie o intolleranze? Per ognuna: allergia grave (blocca anche tracce ed etichette incomplete) o intolleranza. Serve il tuo consenso a salvarle in locale.' }
    ];
    return { onboardingCompleted: p.onboardingCompleted, nextStep: steps.find(s => !s.done)?.step ?? null, steps,
      household: this.members(), permissions: p.permissions, dietaryRules: p.dietaryRules.map(r => ({ ...r, label: allergenInfo(r.key)?.label })),
      brandRules: p.rules.filter(r => r.kind === 'excluded_brand' || r.kind === 'preferred_brand'),
      confirmedProducts: Object.keys(p.productOverrides).length, catalog: 'tosano_allergen_catalog' };
  }
  markStep(step) {
    const key = { permessi: 'onboardPermsDone', marche: 'onboardBrandsDone', intolleranze: 'onboardDietDone' }[step];
    if (!key) throw new TosanoError('Unknown onboarding step', 'INVALID_ARGUMENT');
    this.store.setSetting(this.profileId, key, true);
    const s = this.status();
    if (!s.nextStep) this.store.setSetting(this.profileId, 'onboardingCompleted', true);
    return this.status();
  }
  /** Adding or upgrading a rule only tightens protection: immediate. */
  addDietaryRule(key, severity) {
    if (!allergenInfo(key)) throw new TosanoError('Unknown allergen key; see tosano_allergen_catalog', 'INVALID_ARGUMENT');
    if (!SEV[severity]) throw new TosanoError('severity must be grave or intolleranza', 'INVALID_ARGUMENT');
    const rules = this.store.getDietaryRules(this.profileId), cur = rules.find(r => r.key === key);
    if (cur && SEV[cur.severity] >= SEV[severity]) return { unchanged: true, rule: cur, note: 'Per ridurre la gravità usa tosano_profile_prepare_change.' };
    const next = [...rules.filter(r => r.key !== key), { key, severity, since: new Date().toISOString() }];
    this.store.setDietaryRules(this.profileId, next, cur ? 'dietary_rule_upgraded' : 'dietary_rule_added');
    return { saved: true, rules: next };
  }
  #isLooserPerms(patch) {
    const cur = this.store.getPermissions(this.profileId);
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'maxOrderTotal') {
        if (v === null ? cur.maxOrderTotal !== null : cur.maxOrderTotal !== null && v > cur.maxOrderTotal) return true;
      } else if (PERM_RANK[k][v] > PERM_RANK[k][cur[k]]) return true;
    }
    return false;
  }
  #validPerms(patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (v === undefined) continue;
      if (k === 'maxOrderTotal') { if (v !== null && !(typeof v === 'number' && v > 0 && v <= 2000)) throw new TosanoError('Invalid maxOrderTotal', 'INVALID_ARGUMENT'); out[k] = v; }
      else if (PERM_RANK[k] && v in PERM_RANK[k]) out[k] = v;
      else throw new TosanoError(`Invalid permission ${k}`, 'INVALID_ARGUMENT');
    }
    if (!Object.keys(out).length) throw new TosanoError('No permission change', 'INVALID_ARGUMENT');
    return out;
  }
  /** Stricter permissions apply now; looser ones return requiresApproval. */
  setPermissions(patch) {
    const p = this.#validPerms(patch);
    if (this.#isLooserPerms(p)) return { applied: false, requiresApproval: true, next: 'tosano_profile_prepare_change type=permissions' };
    return { applied: true, permissions: this.store.setPermissions(this.profileId, { ...this.store.getPermissions(this.profileId), ...p }, 'permissions_tightened') };
  }
  // ---- household members: adding people or rules tightens (immediate); removing loosens (approval)
  members() {
    return this.store.getMembers(this.profileId).map(m => ({ ...m, dietaryRules: (m.dietaryRules ?? []).map(r => ({ ...r, label: allergenInfo(r.key)?.label })) }));
  }
  addMember(name, rules = [], dietaryDataConsent = false) {
    const n = String(name ?? '').trim().slice(0, 40);
    if (!n || n.toLowerCase() === 'io') throw new TosanoError('Invalid member name', 'INVALID_ARGUMENT');
    const list = this.store.getMembers(this.profileId);
    if (list.length >= 12) throw new TosanoError('Too many household members', 'INVALID_ARGUMENT');
    if (list.some(m => m.name.toLowerCase() === n.toLowerCase())) throw new TosanoError('Member already exists', 'INVALID_ARGUMENT');
    if (rules.length && !dietaryDataConsent) throw new TosanoError('Consent required to store health data', 'CONSENT_REQUIRED');
    const clean = this.#cleanRules(rules);
    const m = { id: 'm' + createHash('sha256').update(n + Date.now()).digest('hex').slice(0, 8), name: n, dietaryRules: clean, since: new Date().toISOString() };
    this.store.setMembers(this.profileId, [...list, m], 'member_added', { name: n, rules: clean });
    return { saved: true, member: m };
  }
  addMemberRule(memberId, key, severity) {
    const list = this.store.getMembers(this.profileId), m = list.find(x => x.id === memberId);
    if (!m) throw new TosanoError('Member not found', 'INVALID_ARGUMENT');
    const [r] = this.#cleanRules([{ key, severity }]), cur = (m.dietaryRules ?? []).find(x => x.key === key);
    if (cur && SEV[cur.severity] >= SEV[severity]) return { unchanged: true, rule: cur, note: 'Per ridurre usa tosano_profile_prepare_change.' };
    m.dietaryRules = [...(m.dietaryRules ?? []).filter(x => x.key !== key), r];
    this.store.setMembers(this.profileId, list, 'member_rule_added', { member: m.name, rule: r });
    return { saved: true, member: m };
  }
  #cleanRules(rules) {
    return rules.map(r => {
      if (!allergenInfo(r.key)) throw new TosanoError('Unknown allergen key; see tosano_allergen_catalog', 'INVALID_ARGUMENT');
      if (!SEV[r.severity]) throw new TosanoError('severity must be grave or intolleranza', 'INVALID_ARGUMENT');
      return { key: r.key, severity: r.severity, since: new Date().toISOString() };
    });
  }
  prepareChange(change, product = null) {
    const rules = this.store.getDietaryRules(this.profileId), perms = this.store.getPermissions(this.profileId), members = this.store.getMembers(this.profileId);
    let summary;
    if (['member_remove', 'member_rule_remove', 'member_rule_downgrade'].includes(change.type)) {
      const m = members.find(x => x.id === change.memberId);
      if (!m) throw new TosanoError('Member not found', 'INVALID_ARGUMENT');
      if (change.type === 'member_remove') summary = { change: 'member_remove', member: m.name, rulesLost: (m.dietaryRules ?? []).map(r => `${allergenInfo(r.key)?.label} (${r.severity})`) };
      else {
        const cur = (m.dietaryRules ?? []).find(r => r.key === change.key);
        if (!cur) throw new TosanoError('No such dietary rule', 'INVALID_ARGUMENT');
        if (change.type === 'member_rule_downgrade' && cur.severity !== 'grave') throw new TosanoError('Already intolleranza', 'INVALID_ARGUMENT');
        summary = { change: change.type, member: m.name, allergen: allergenInfo(change.key).label, from: cur.severity, to: change.type === 'member_rule_remove' ? 'nessuna regola' : 'intolleranza' };
      }
      summary.warning = 'Riduce la protezione della famiglia: prodotti oggi bloccati potranno essere proposti.';
      change = { type: change.type, memberId: change.memberId, key: change.key ?? null };
    } else if (change.type === 'dietary_remove' || change.type === 'dietary_downgrade') {
      const cur = rules.find(r => r.key === change.key);
      if (!cur) throw new TosanoError('No such dietary rule', 'INVALID_ARGUMENT');
      if (change.type === 'dietary_downgrade' && cur.severity !== 'grave') throw new TosanoError('Already intolleranza', 'INVALID_ARGUMENT');
      summary = { change: change.type, allergen: allergenInfo(change.key).label, from: cur.severity, to: change.type === 'dietary_remove' ? 'nessuna regola' : 'intolleranza',
        warning: 'Riduce la protezione: prodotti oggi bloccati potranno essere proposti.' };
    } else if (change.type === 'permissions') {
      const p = this.#validPerms(change.permissions);
      summary = { change: 'permissions', from: perms, to: { ...perms, ...p }, warning: p.checkout === 'ask' ? 'L\'agente potrà PREPARARE ordini reali; ogni ordine richiederà comunque la tua conferma esplicita.' : 'Allarga i permessi dell\'agente.' };
      change = { type: 'permissions', permissions: p };
    } else if (change.type === 'product_confirm') {
      if (!product) throw new TosanoError('Product required', 'INVALID_ARGUMENT');
      const review = product.check?.safety?.rules?.filter(r => r.verdict === 'da_verificare').map(r => r.key) ?? [];
      if (!review.length) throw new TosanoError('Nothing to confirm: product is not in da_verificare for your rules (blocked products cannot be overridden)', 'NOTHING_TO_CONFIRM');
      summary = { change: 'product_confirm', productId: product.productId, name: product.name, allergens: review.map(k => allergenInfo(k).label),
        labelHash: product.label?.labelHash ?? null,
        warning: 'Dichiari di aver letto l\'etichetta fisica o la foto del retro e di accettare questo prodotto per queste regole. Se l\'etichetta pubblicata cambia, la conferma decade.' };
      change = { type: 'product_confirm', productId: product.productId, keys: review, labelHash: product.label?.labelHash ?? null };
    } else throw new TosanoError('Unknown change type', 'INVALID_ARGUMENT');
    const a = this.store.createSiteAction(this.profileId, { kind: 'profile_change', params: change, baselineFingerprint: sha([rules, perms, members, change]), summary });
    return { planId: a.id, summary, confirmationPhrase: `CONFERMO ${a.id.slice(0, 8).toUpperCase()}`, requiresExplicitUserConfirmation: true };
  }
  commitChange(planId, phrase) {
    const a = this.store.getSiteAction(this.profileId, planId);
    if (!a || a.kind !== 'profile_change') throw new TosanoError('Plan not found', 'PLAN_NOT_FOUND');
    if (phrase !== `CONFERMO ${a.id.slice(0, 8).toUpperCase()}`) throw new TosanoError('Exact plan confirmation phrase required', 'APPROVAL_REQUIRED');
    const claim = this.store.claimSiteAction(this.profileId, planId);
    if (!claim.claimed) throw new TosanoError(claim.reason, claim.reason);
    const rules = this.store.getDietaryRules(this.profileId), perms = this.store.getPermissions(this.profileId), members = this.store.getMembers(this.profileId), c = a.params;
    if (sha([rules, perms, members, c]) !== a.baselineFingerprint) {
      this.store.finishSiteAction(this.profileId, planId, 'stale', { reason: 'Profile changed' });
      throw new TosanoError('Profile changed since the plan; prepare again', 'PLAN_STALE');
    }
    if (c.type === 'dietary_remove') this.store.setDietaryRules(this.profileId, rules.filter(r => r.key !== c.key), 'dietary_rule_removed');
    else if (c.type === 'dietary_downgrade') this.store.setDietaryRules(this.profileId, rules.map(r => r.key === c.key ? { ...r, severity: 'intolleranza' } : r), 'dietary_rule_downgraded');
    else if (c.type === 'permissions') this.store.setPermissions(this.profileId, { ...perms, ...c.permissions }, 'permissions_widened');
    else if (c.type === 'member_remove') this.store.setMembers(this.profileId, members.filter(m => m.id !== c.memberId), 'member_removed', { memberId: c.memberId });
    else if (c.type === 'member_rule_remove' || c.type === 'member_rule_downgrade')
      this.store.setMembers(this.profileId, members.map(m => m.id !== c.memberId ? m : { ...m, dietaryRules: c.type === 'member_rule_remove'
        ? m.dietaryRules.filter(r => r.key !== c.key) : m.dietaryRules.map(r => r.key === c.key ? { ...r, severity: 'intolleranza' } : r) }), c.type, { memberId: c.memberId, key: c.key });
    else if (c.type === 'product_confirm') this.store.setOverride(this.profileId, c.productId, { keys: c.keys, labelHash: c.labelHash, at: new Date().toISOString() });
    this.store.finishSiteAction(this.profileId, planId, 'succeeded', { applied: c.type });
    return { applied: true, change: c.type, profile: this.status() };
  }
}
