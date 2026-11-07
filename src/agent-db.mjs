/** Agent-oriented local SQLite storage. No cookies, account responses or passwords belong here. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(os.homedir(), '.tosano-copilot');
const ALLOWED_KINDS = new Set(['preferred_brand', 'excluded_brand', 'excluded_ingredient', 'excluded_allergen', 'preferred_format']);
const HARD_KINDS = new Set(['excluded_brand', 'excluded_ingredient', 'excluded_allergen']);
export const normalizeTerm = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('it-IT').trim().replace(/\s+/g, ' ');
export const nowISO = () => new Date().toISOString();
const assertString = (v, label, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`Invalid ${label}`);
  return v.trim();
};
const assertQty = n => {
  if (!Number.isSafeInteger(n) || n < 1 || n > 100) throw new Error('Invalid quantity');
  return n;
};
const json = value => JSON.stringify(value);
const unjson = value => value == null ? null : JSON.parse(value);
function cleanTokens(query) {
  // No user text is ever interpolated into SQL or raw FTS5 syntax.
  return [...new Set(String(query).normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [])]
    .map(x => x.slice(0, 40)).filter(Boolean);
}
export function safeFtsQuery(query) {
  const tokens = cleanTokens(query);
  if (!tokens.length) throw new Error('Search requires letters or digits');
  return tokens.map(t => `"${t.replaceAll('"', '')}"*`).join(' AND ');
}
const safeOutputError = e => { throw new Error(e?.message === 'Search requires letters or digits' ? e.message : 'Invalid store operation'); };

export class AgentStore {
  constructor(filename = path.join(ROOT, 'agent.sqlite')) {
    this.filename = filename;
    if (filename !== ':memory:') {
      fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.dirname(filename), 0o700);
    }
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
    if (filename !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL;');
    this.#migrate();
  }
  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        profile_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY (profile_id, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS preference_rules (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, category TEXT NOT NULL DEFAULT '*',
        kind TEXT NOT NULL, value TEXT NOT NULL, value_norm TEXT NOT NULL,
        strength TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(profile_id, category, kind, value_norm)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS preference_scope_idx ON preference_rules(profile_id, category, kind);
      CREATE TABLE IF NOT EXISTS shopping_lists (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, name TEXT NOT NULL,
        name_norm TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(profile_id, name_norm)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS shopping_list_items (
        id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
        term TEXT NOT NULL, term_norm TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 100),
        product_id INTEGER, slug TEXT, note TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(list_id, term_norm)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS list_items_fk_idx ON shopping_list_items(list_id);
      CREATE TABLE IF NOT EXISTS cached_products (
        id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, context_key TEXT NOT NULL,
        name TEXT NOT NULL, brand TEXT, category TEXT, slug TEXT,
        price REAL, price_per_unit REAL, unit TEXT, size_label TEXT,
        result_json TEXT NOT NULL, observed_at TEXT NOT NULL,
        UNIQUE(product_id, context_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cached_products_ctx_idx ON cached_products(context_key, observed_at);
      CREATE INDEX IF NOT EXISTS cached_products_brand_idx ON cached_products(context_key, brand);
      CREATE VIRTUAL TABLE IF NOT EXISTS cached_products_fts USING fts5(
        name, brand, category, content='cached_products', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
      );
      CREATE TRIGGER IF NOT EXISTS cp_insert AFTER INSERT ON cached_products BEGIN
        INSERT INTO cached_products_fts(rowid,name,brand,category) VALUES(new.id,new.name,new.brand,new.category);
      END;
      CREATE TRIGGER IF NOT EXISTS cp_delete AFTER DELETE ON cached_products BEGIN
        INSERT INTO cached_products_fts(cached_products_fts,rowid,name,brand,category)
          VALUES('delete',old.id,old.name,old.brand,old.category);
      END;
      CREATE TRIGGER IF NOT EXISTS cp_update AFTER UPDATE ON cached_products BEGIN
        INSERT INTO cached_products_fts(cached_products_fts,rowid,name,brand,category)
          VALUES('delete',old.id,old.name,old.brand,old.category);
        INSERT INTO cached_products_fts(rowid,name,brand,category) VALUES(new.id,new.name,new.brand,new.category);
      END;
      CREATE VIRTUAL TABLE IF NOT EXISTS shopping_list_items_fts USING fts5(
        term, note, content='shopping_list_items', content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
      );
      CREATE TRIGGER IF NOT EXISTS li_insert AFTER INSERT ON shopping_list_items BEGIN
        INSERT INTO shopping_list_items_fts(rowid,term,note) VALUES(new.rowid,new.term,new.note);
      END;
      CREATE TRIGGER IF NOT EXISTS li_delete AFTER DELETE ON shopping_list_items BEGIN
        INSERT INTO shopping_list_items_fts(shopping_list_items_fts,rowid,term,note)
          VALUES('delete',old.rowid,old.term,old.note);
      END;
      CREATE TRIGGER IF NOT EXISTS li_update AFTER UPDATE ON shopping_list_items BEGIN
        INSERT INTO shopping_list_items_fts(shopping_list_items_fts,rowid,term,note)
          VALUES('delete',old.rowid,old.term,old.note);
        INSERT INTO shopping_list_items_fts(rowid,term,note) VALUES(new.rowid,new.term,new.note);
      END;
      CREATE TABLE IF NOT EXISTS cart_plans (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, payload_json TEXT NOT NULL,
        baseline_fingerprint TEXT NOT NULL, summary_json TEXT NOT NULL,
        state TEXT NOT NULL, result_json TEXT,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(profile_id, idempotency_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cart_plan_status_idx ON cart_plans(profile_id,state,expires_at);
      CREATE TABLE IF NOT EXISTS site_actions (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, kind TEXT NOT NULL,
        params_json TEXT NOT NULL, baseline_fingerprint TEXT NOT NULL, summary_json TEXT NOT NULL,
        state TEXT NOT NULL, result_json TEXT,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS site_action_state_idx ON site_actions(profile_id,state,expires_at);
      CREATE TABLE IF NOT EXISTS profile_audit (
        id INTEGER PRIMARY KEY, profile_id TEXT NOT NULL, at TEXT NOT NULL,
        action TEXT NOT NULL, detail_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS pantry (
        profile_id TEXT NOT NULL, name TEXT NOT NULL, quantity REAL, unit TEXT, source TEXT NOT NULL,
        product_id INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY (profile_id, name)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS price_history (
        product_id INTEGER NOT NULL, day TEXT NOT NULL, price REAL NOT NULL, name TEXT, slug TEXT,
        PRIMARY KEY (product_id, day)
      ) STRICT;
    `);
    if (this.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLite quick_check failed');
  }
  close() { this.db.close(); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  getSetting(profileId, key, fallback = null) {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE profile_id=? AND key=?').get(profileId,key);
    return row ? unjson(row.value_json) : fallback;
  }
  setSetting(profileId, key, value) {
    this.db.prepare('INSERT INTO settings(profile_id,key,value_json) VALUES(?,?,?) ON CONFLICT(profile_id,key) DO UPDATE SET value_json=excluded.value_json').run(profileId,key,json(value));
  }
  listRules(profileId = 'default') {
    return this.db.prepare('SELECT id,category,kind,value,strength,created_at AS createdAt,updated_at AS updatedAt FROM preference_rules WHERE profile_id=? ORDER BY category,kind,value_norm').all(profileId);
  }
  upsertRule(profileId, { category = '*', kind, value, strength }) {
    if (!ALLOWED_KINDS.has(kind)) throw new Error('Invalid preference kind');
    const val = assertString(value,'value',100), cat = normalizeTerm(assertString(category,'category',80));
    const level = HARD_KINDS.has(kind) ? 'hard' : (strength ?? 'soft');
    if (!['hard','soft'].includes(level)) throw new Error('Invalid strength');
    const id = randomUUID(), at = nowISO();
    this.db.prepare(`INSERT INTO preference_rules(id,profile_id,category,kind,value,value_norm,strength,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(profile_id,category,kind,value_norm)
      DO UPDATE SET value=excluded.value,strength=excluded.strength,updated_at=excluded.updated_at`)
      .run(id,profileId,cat,kind,val,normalizeTerm(val),level,at,at);
    return this.db.prepare('SELECT id,category,kind,value,strength FROM preference_rules WHERE profile_id=? AND category=? AND kind=? AND value_norm=?')
      .get(profileId,cat,kind,normalizeTerm(val));
  }
  removeRule(profileId, id) { return { removed: this.db.prepare('DELETE FROM preference_rules WHERE profile_id=? AND id=?').run(profileId,id).changes === 1 }; }
  replaceRulesOfKind(profileId, kind, values) {
    if (!ALLOWED_KINDS.has(kind) || !Array.isArray(values) || values.length > 100) throw new Error('Invalid legacy preference update');
    return this.tx(() => {
      this.db.prepare('DELETE FROM preference_rules WHERE profile_id=? AND kind=? AND category=?').run(profileId,kind,'*');
      for (const value of values) this.upsertRule(profileId,{kind,value});
    });
  }
  getPreferences(profileId = 'default') {
    const rules = this.listRules(profileId);
    return {
      excludedBrands: rules.filter(r=>r.kind==='excluded_brand'&&r.category==='*').map(r=>r.value),
      excludedIngredients: rules.filter(r=>r.kind==='excluded_ingredient'&&r.category==='*').map(r=>r.value),
      excludedAllergens: rules.filter(r=>r.kind==='excluded_allergen'&&r.category==='*').map(r=>r.value),
      blockPossibleTraces: this.getSetting(profileId,'blockPossibleTraces',true),
      shoppingPriority: this.getSetting(profileId,'shoppingPriority','value'),
      onboardingCompleted: this.getSetting(profileId,'onboardingCompleted',false),
      dietaryRules: this.householdRules(profileId),
      ownDietaryRules: this.getDietaryRules(profileId),
      household: this.getMembers(profileId),
      productOverrides: this.getOverrides(profileId),
      permissions: this.getPermissions(profileId),
      rules
    };
  }
  patchLegacyPreferences(profileId, patch) {
    const kinds={excludedBrands:'excluded_brand',excludedIngredients:'excluded_ingredient',excludedAllergens:'excluded_allergen'};
    if (!patch || typeof patch!=='object'||Array.isArray(patch)) throw new Error('Invalid preferences');
    this.tx(() => {
      for(const [field,kind] of Object.entries(kinds)) if(Object.hasOwn(patch,field)) {
        if(!Array.isArray(patch[field])||patch[field].length>100) throw new Error('Invalid '+field);
        this.db.prepare('DELETE FROM preference_rules WHERE profile_id=? AND kind=? AND category=?').run(profileId,kind,'*');
        for(const value of patch[field])this.upsertRule(profileId,{kind,value});
      }
      if(Object.hasOwn(patch,'blockPossibleTraces')) {
        if(typeof patch.blockPossibleTraces!=='boolean')throw new Error('Invalid blockPossibleTraces');
        this.setSetting(profileId,'blockPossibleTraces',patch.blockPossibleTraces);
      }
      if(Object.hasOwn(patch,'shoppingPriority')) {
        if(!['value','price','nutrition'].includes(patch.shoppingPriority))throw new Error('Invalid shoppingPriority');
        this.setSetting(profileId,'shoppingPriority',patch.shoppingPriority);
      }
    });
    return this.getPreferences(profileId);
  }
  importLegacyPreferences(profileId, legacyPrefs) {
    if(this.getSetting(profileId,'legacyMigration',false))return false;
    this.tx(()=>{
      if(!this.listRules(profileId).length && legacyPrefs) {
        const map={excludedBrands:'excluded_brand',excludedIngredients:'excluded_ingredient',excludedAllergens:'excluded_allergen'};
        for(const [field,kind] of Object.entries(map))for(const value of legacyPrefs[field]??[])this.upsertRule(profileId,{kind,value});
        if(typeof legacyPrefs.blockPossibleTraces==='boolean')this.setSetting(profileId,'blockPossibleTraces',legacyPrefs.blockPossibleTraces);
        if(['value','price','nutrition'].includes(legacyPrefs.shoppingPriority))this.setSetting(profileId,'shoppingPriority',legacyPrefs.shoppingPriority);
      }
      this.setSetting(profileId,'legacyMigration',true);
    });
    return true;
  }
  createList(profileId, name) {
    const val=assertString(name,'list name',100),at=nowISO(),id=randomUUID();
    this.db.prepare(`INSERT INTO shopping_lists(id,profile_id,name,name_norm,created_at,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(profile_id,name_norm) DO NOTHING`).run(id,profileId,val,normalizeTerm(val),at,at);
    const row=this.db.prepare('SELECT id,name,created_at AS createdAt,updated_at AS updatedAt FROM shopping_lists WHERE profile_id=? AND name_norm=?')
      .get(profileId,normalizeTerm(val));
    return { ...row, created: row.id===id };
  }
  listLists(profileId) {
    return this.db.prepare(`SELECT l.id,l.name,l.updated_at AS updatedAt,
      (SELECT count(*) FROM shopping_list_items i WHERE i.list_id=l.id) AS lineCount
      FROM shopping_lists l WHERE profile_id=? ORDER BY updated_at DESC`).all(profileId);
  }
  getList(profileId,id) {
    const row=this.db.prepare('SELECT id,name,updated_at AS updatedAt FROM shopping_lists WHERE id=? AND profile_id=?').get(id,profileId);
    if(!row)throw new Error('Shopping list not found');
    const items=this.db.prepare(`SELECT id,term,quantity,product_id AS productId,slug,note,updated_at AS updatedAt FROM shopping_list_items WHERE list_id=? ORDER BY created_at,id`).all(id);
    return {...row,items};
  }
  upsertListItem(profileId,listId,{term,quantity=1,productId=null,slug=null,note=null}) {
    const v=assertString(term,'term',180);assertQty(quantity);
    if(productId!==null &&(!Number.isSafeInteger(productId)||productId<1))throw new Error('Invalid productId');
    if(slug!==null && (typeof slug!=='string'||!/^[a-z0-9-]{3,200}$/.test(slug)))throw new Error('Invalid slug');
    if(note!==null &&(typeof note!=='string'||note.length>300))throw new Error('Invalid note');
    return this.tx(()=>{
      this.getList(profileId,listId);const at=nowISO();
      this.db.prepare(`INSERT INTO shopping_list_items(id,list_id,term,term_norm,quantity,product_id,slug,note,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(list_id,term_norm) DO UPDATE SET
        term=excluded.term,quantity=excluded.quantity,product_id=excluded.product_id,slug=excluded.slug,
        note=excluded.note,updated_at=excluded.updated_at`).run(randomUUID(),listId,v,normalizeTerm(v),quantity,productId,slug,note,at,at);
      this.db.prepare('UPDATE shopping_lists SET updated_at=? WHERE id=?').run(at,listId);
      return this.getList(profileId,listId);
    });
  }
  removeListItem(profileId,listId,itemId) {
    return this.tx(()=>{
      this.getList(profileId,listId);
      const removed=this.db.prepare('DELETE FROM shopping_list_items WHERE id=? AND list_id=?').run(itemId,listId).changes===1;
      if(removed)this.db.prepare('UPDATE shopping_lists SET updated_at=? WHERE id=?').run(nowISO(),listId);
      return {removed};
    });
  }
  searchListItems(profileId,query,limit=12){
    if(!Number.isSafeInteger(limit)||limit<1||limit>30)throw new Error('Invalid limit');
    let match;try{match=safeFtsQuery(query);}catch(e){return safeOutputError(e);}
    return this.db.prepare(`SELECT l.id AS listId,l.name AS listName,i.id AS itemId,i.term,i.quantity,
      i.product_id AS productId,i.slug
      FROM shopping_list_items_fts f JOIN shopping_list_items i ON i.rowid=f.rowid
      JOIN shopping_lists l ON l.id=i.list_id
      WHERE shopping_list_items_fts MATCH ? AND l.profile_id=? ORDER BY f.rank LIMIT ?`).all(match,profileId,limit);
  }
  cacheProducts(products,contextKey) {
    assertString(contextKey,'context key',120);
    if(!Array.isArray(products)||products.length>200)throw new Error('Invalid product batch');
    const sql=this.db.prepare(`INSERT INTO cached_products(product_id,context_key,name,brand,category,slug,price,price_per_unit,unit,size_label,result_json,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_id,context_key) DO UPDATE SET
      name=excluded.name,brand=excluded.brand,category=excluded.category,slug=excluded.slug,
      price=excluded.price,price_per_unit=excluded.price_per_unit,unit=excluded.unit,size_label=excluded.size_label,
      result_json=excluded.result_json,observed_at=excluded.observed_at`);
    const at=nowISO();
    this.tx(()=>{for(const p of products){
      if(!Number.isSafeInteger(p.productId)||p.productId<=0||!p.name)continue;
      // ProductView is explicitly sanitized. Keep only its small allowlisted representation.
      const safe={productId:p.productId,name:p.name,brand:p.brand??null,category:p.category??null,
        slug:p.slug??null,sizeLabel:p.sizeLabel??null,unitPrice:p.unitPrice??null,
        pricePerUnit:p.pricePerUnit??null,unit:p.unit??null,availabilityConfirmed:false};
      sql.run(p.productId,contextKey,safe.name,safe.brand,safe.category,safe.slug,safe.unitPrice,safe.pricePerUnit,
        safe.unit,safe.sizeLabel,json(safe),at);
    }});
    return {cached:products.length,observedAt:at};
  }
  searchProducts(query,contextKey,{limit=12,maxAgeMinutes=60,category=null,brand=null}={}) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('Invalid limit');
    if(!Number.isSafeInteger(maxAgeMinutes)||maxAgeMinutes<0||maxAgeMinutes>60*24*30)throw new Error('Invalid max age');
    const match=safeFtsQuery(query);
    const cutoff=new Date(Date.now()-maxAgeMinutes*60_000).toISOString();
    const rows=this.db.prepare(`SELECT p.result_json AS product,p.observed_at AS observedAt,
      p.price AS price,p.price_per_unit AS pricePerUnit,p.unit AS unit,
      f.rank AS ftsRank
      FROM cached_products_fts f JOIN cached_products p ON p.id=f.rowid
      WHERE cached_products_fts MATCH ? AND p.context_key=? AND p.observed_at>=?
        AND (? IS NULL OR lower(p.category)=lower(?))
        AND (? IS NULL OR lower(p.brand)=lower(?))
      ORDER BY f.rank,p.product_id LIMIT ?`).all(match,contextKey,cutoff,category,category,brand,brand,limit);
    return rows.map(r=>({...unjson(r.product),source:'cached_search',observedAt:r.observedAt,live:false,ftsRank:r.ftsRank}));
  }
  createCartPlan(profileId,{idempotencyKey,payload,baselineFingerprint,summary,ttlMs=600000}){
    assertString(idempotencyKey,'idempotency key',160);
    const existing=this.db.prepare('SELECT * FROM cart_plans WHERE profile_id=? AND idempotency_key=?').get(profileId,idempotencyKey);
    if(existing){
      if(existing.payload_json!==json(payload) || existing.baseline_fingerprint!==baselineFingerprint)
        throw new Error('Idempotency key reused for different request');
      if(existing.state==='prepared' && existing.expires_at<=nowISO()) {
        this.db.prepare('UPDATE cart_plans SET state=?,updated_at=? WHERE id=? AND state=?')
          .run('expired',nowISO(),existing.id,'prepared');
        existing.state='expired';
      }
      if(!['failed','stale','expired'].includes(existing.state))return this.#viewPlan(existing);
      // Expired/stale plans can be replanned with a fresh approval. Never replay a plan ID.
      idempotencyKey+=`/new/${randomUUID()}`;
    }
    const id=randomUUID(),at=nowISO(),expires=new Date(Date.now()+ttlMs).toISOString();
    this.db.prepare('INSERT INTO cart_plans(id,profile_id,idempotency_key,payload_json,baseline_fingerprint,summary_json,state,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id,profileId,idempotencyKey,json(payload),baselineFingerprint,json(summary),'prepared',at,expires,at);
    return this.getCartPlan(profileId,id);
  }
  #viewPlan(row){return {id:row.id,state:row.state,summary:unjson(row.summary_json),payload:unjson(row.payload_json),baselineFingerprint:row.baseline_fingerprint,
    expiresAt:row.expires_at,result:unjson(row.result_json)};}
  getCartPlan(profileId,id){const row=this.db.prepare('SELECT * FROM cart_plans WHERE profile_id=? AND id=?').get(profileId,id);return row?this.#viewPlan(row):null;}
  claimCartPlan(profileId,id){
    return this.tx(()=>{
      const existing=this.getCartPlan(profileId,id);
      if(!existing)return {claimed:false,reason:'PLAN_NOT_FOUND'};
      if(existing.state!=='prepared')return {claimed:false,reason:'PLAN_'+existing.state.toUpperCase(),plan:existing};
      if(existing.expiresAt<=nowISO()){
        this.db.prepare('UPDATE cart_plans SET state=?,updated_at=? WHERE id=?').run('expired',nowISO(),id);
        return {claimed:false,reason:'PLAN_EXPIRED'};
      }
      this.db.prepare('UPDATE cart_plans SET state=?,updated_at=? WHERE id=? AND state=?').run('executing',nowISO(),id,'prepared');
      return {claimed:true,plan:this.getCartPlan(profileId,id)};
    });
  }
  finishCartPlan(profileId,id,state,result={}){
    if(!['succeeded','partial','unknown','failed','stale'].includes(state))throw new Error('Invalid plan state');
    const changes=this.db.prepare('UPDATE cart_plans SET state=?,result_json=?,updated_at=? WHERE id=? AND profile_id=? AND state=?')
      .run(state,json(result),nowISO(),id,profileId,'executing').changes;
    if(changes!==1)throw new Error('Cart plan is not executing');
    return this.getCartPlan(profileId,id);
  }
  // ---- v0.4 profile: dietary rules, agent permissions, per-product label confirmations
  audit(profileId,action,detail){
    this.db.prepare('INSERT INTO profile_audit(profile_id,at,action,detail_json) VALUES(?,?,?,?)').run(profileId,nowISO(),action,json(detail));
  }
  auditLog(profileId,limit=50){
    return this.db.prepare('SELECT at,action,detail_json AS d FROM profile_audit WHERE profile_id=? ORDER BY id DESC LIMIT ?').all(profileId,limit)
      .map(r=>({at:r.at,action:r.action,detail:unjson(r.d)}));
  }
  getDietaryRules(profileId){return this.getSetting(profileId,'dietaryRules',[]);}
  // ---- household: every member's rules protect every purchase (strictest severity wins)
  getMembers(profileId){return this.getSetting(profileId,'household',[]);}
  setMembers(profileId,members,action,detail={}){
    this.tx(()=>{this.setSetting(profileId,'household',members);this.audit(profileId,action,detail);});
    return members;
  }
  householdRules(profileId,eaters=null){
    const sev={intolleranza:1,grave:2},out=new Map();
    const add=(r,who)=>{const cur=out.get(r.key);
      if(!cur)out.set(r.key,{...r,who:[who]});
      else{cur.who.push(who);if(sev[r.severity]>sev[cur.severity])cur.severity=r.severity;}};
    const members=this.getMembers(profileId);
    if(!eaters||eaters.includes('io'))for(const r of this.getDietaryRules(profileId))add(r,'io');
    for(const m of members)if(!eaters||eaters.includes(m.id))for(const r of m.dietaryRules??[])add(r,m.name);
    return [...out.values()];
  }
  // ---- pantry
  pantryList(profileId){return this.db.prepare('SELECT name,quantity,unit,source,product_id AS productId,updated_at AS updatedAt FROM pantry WHERE profile_id=? ORDER BY name').all(profileId);}
  pantrySet(profileId,items,source='utente'){
    return this.tx(()=>{const st=this.db.prepare(`INSERT INTO pantry VALUES (?,?,?,?,?,?,?) ON CONFLICT(profile_id,name) DO UPDATE SET
      quantity=excluded.quantity,unit=excluded.unit,source=excluded.source,product_id=COALESCE(excluded.product_id,pantry.product_id),updated_at=excluded.updated_at`);
      for(const i of items){const name=assertString(normalizeTerm(i.name),'pantry item',120);
        st.run(profileId,name,i.quantity??null,i.unit??null,source,i.productId??null,nowISO());}
      return this.pantryList(profileId);});
  }
  pantryRemove(profileId,names){
    const st=this.db.prepare('DELETE FROM pantry WHERE profile_id=? AND name=?');let n=0;
    for(const x of names)n+=st.run(profileId,normalizeTerm(x)).changes;return {removed:n};
  }
  // ---- prices seen in live product data (public catalog prices only)
  recordPrices(products){
    const day=nowISO().slice(0,10),st=this.db.prepare('INSERT INTO price_history VALUES (?,?,?,?,?) ON CONFLICT(product_id,day) DO UPDATE SET price=excluded.price');
    for(const p of products){const price=Number(p.unitPrice);if(Number.isSafeInteger(p.productId)&&p.productId>0&&Number.isFinite(price)&&price>0)
      st.run(p.productId,day,price,String(p.name??'').slice(0,160),p.slug??null);}
  }
  priceHistory(productId,days=180){
    const since=new Date(Date.now()-days*864e5).toISOString().slice(0,10);
    return this.db.prepare('SELECT day,price FROM price_history WHERE product_id=? AND day>=? ORDER BY day').all(productId,since);
  }
  setDietaryRules(profileId,rules,action){
    this.tx(()=>{this.setSetting(profileId,'dietaryRules',rules);this.audit(profileId,action,{rules});});
    return rules;
  }
  getPermissions(profileId){
    return {lists:'allowed',cart:'ask',orders:'ask',checkout:'denied',maxOrderTotal:null,...this.getSetting(profileId,'agentPermissions',{})};
  }
  setPermissions(profileId,perms,action){
    this.tx(()=>{this.setSetting(profileId,'agentPermissions',perms);this.audit(profileId,action,{perms});});
    return this.getPermissions(profileId);
  }
  getOverrides(profileId){return this.getSetting(profileId,'productOverrides',{});}
  setOverride(profileId,productId,value){
    const all=this.getOverrides(profileId);
    if(value)all[String(productId)]=value;else delete all[String(productId)];
    this.tx(()=>{this.setSetting(profileId,'productOverrides',all);this.audit(profileId,value?'product_label_confirmed':'product_confirmation_removed',{productId,...(value??{})});});
    return all;
  }
  createSiteAction(profileId,{kind,params,baselineFingerprint,summary,ttlMs=600000}){
    assertString(kind,'action kind',60);assertString(baselineFingerprint,'fingerprint',128);
    const id=randomUUID(),at=nowISO(),expires=new Date(Date.now()+ttlMs).toISOString();
    this.db.prepare('INSERT INTO site_actions(id,profile_id,kind,params_json,baseline_fingerprint,summary_json,state,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id,profileId,kind,json(params),baselineFingerprint,json(summary),'prepared',at,expires,at);
    return this.getSiteAction(profileId,id);
  }
  getSiteAction(profileId,id){
    const r=this.db.prepare('SELECT * FROM site_actions WHERE profile_id=? AND id=?').get(profileId,id);
    return r?{id:r.id,kind:r.kind,state:r.state,params:unjson(r.params_json),baselineFingerprint:r.baseline_fingerprint,
      summary:unjson(r.summary_json),result:unjson(r.result_json),expiresAt:r.expires_at}:null;
  }
  claimSiteAction(profileId,id){
    return this.tx(()=>{
      const a=this.getSiteAction(profileId,id);
      if(!a)return {claimed:false,reason:'PLAN_NOT_FOUND'};
      if(a.state!=='prepared')return {claimed:false,reason:'PLAN_'+a.state.toUpperCase(),action:a};
      if(a.expiresAt<=nowISO()){
        this.db.prepare('UPDATE site_actions SET state=?,updated_at=? WHERE id=?').run('expired',nowISO(),id);
        return {claimed:false,reason:'PLAN_EXPIRED'};
      }
      this.db.prepare('UPDATE site_actions SET state=?,updated_at=? WHERE id=? AND state=?').run('executing',nowISO(),id,'prepared');
      return {claimed:true,action:this.getSiteAction(profileId,id)};
    });
  }
  finishSiteAction(profileId,id,state,result={}){
    if(!['succeeded','unknown','failed','stale'].includes(state))throw new Error('Invalid action state');
    const n=this.db.prepare('UPDATE site_actions SET state=?,result_json=?,updated_at=? WHERE id=? AND profile_id=? AND state=?')
      .run(state,json(result),nowISO(),id,profileId,'executing').changes;
    if(n!==1)throw new Error('Site action is not executing');
    return this.getSiteAction(profileId,id);
  }
  diagnostics(){
    const fts=this.db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get().enabled;
    return {engine:'SQLite',fts5:Boolean(fts),journal:this.db.prepare('PRAGMA journal_mode').get().journal_mode,
      schema:'agent-v1',databasePath:this.filename === ':memory:' ? 'memory' : 'local_private_file',
      cachedProducts:this.db.prepare('SELECT COUNT(*) n FROM cached_products').get().n};
  }
}
export function cartFingerprint(cart) {
  const content={cartId:cart.cartId,mode:cart.mode??null,pickupOrDeliveryLocation:cart.pickupOrDeliveryLocation??null,timeslot:cart.timeslot??null,subtotal:cart.subtotal,deliveryFee:cart.deliveryFee,packagingFee:cart.packagingFee,total:cart.total,
    items:[...(cart.items??[])].map(x=>({itemId:x.itemId,productId:x.productId,quantity:x.quantity,unitPrice:x.unitPrice,total:x.total})).sort((a,b)=>a.itemId-b.itemId)};
  return createHash('sha256').update(json(content)).digest('hex');
}
