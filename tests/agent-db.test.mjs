import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AgentStore,cartFingerprint,safeFtsQuery} from '../src/agent-db.mjs';

const product=(id,name,brand='MILA')=>({productId:id,name,brand,category:'YOGURT',sizeLabel:'GR. 500',
  unitPrice:2.5,pricePerUnit:5,unit:'KG',slug:`item-${id}`,availabilityConfirmed:false});

test('SQLite FTS5: correct schema and local private file permissions',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tosano-agent-test-'));
  const dbPath=path.join(dir,'private','agent.sqlite');
  const db=new AgentStore(dbPath);
  assert.equal(db.diagnostics().fts5,true);
  assert.equal(fs.statSync(dbPath).mode & 0o777,0o600);
  assert.equal(fs.statSync(path.dirname(dbPath)).mode & 0o777,0o700);
  db.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('FTS5 cached products are scoped by context and explicitly labeled non-live',()=>{
  const s=new AgentStore(':memory:');
  s.cacheProducts([product(1,'YOGURT MILA NATURALE')],'context-a');
  s.cacheProducts([product(1,'YOGURT MILA NATURALE')],'context-b');
  s.cacheProducts([{...product(2,'SALMONE FRESCO','RUMMO'),category:'PESCE'}],'context-a');
  assert.equal(s.searchProducts('yogurt','context-a').length,1);
  assert.equal(s.searchProducts('yogurt','context-b').length,1);
  assert.equal(s.searchProducts('yogurt','context-a')[0].live,false);
  assert.equal(s.searchProducts('salmon','context-a').length,1);
  assert.equal(s.searchProducts('yogurt','wrong').length,0);
  assert.throws(()=>s.searchProducts('yogurt','context-a',{maxAgeMinutes:-1}),/Invalid max age/);
  s.close();
});

test('FTS5 query escaping prevents syntax injection and malformed search crashes',()=>{
  const s=new AgentStore(':memory:');s.cacheProducts([product(1,'YOGURT MILA NATURALE')],'ctx');
  assert.deepEqual(s.searchProducts("' OR NOT MATCH -- yogurt",'ctx').map(x=>x.productId),[]);
  assert.deepEqual(s.searchProducts('"yogurt"','ctx').map(x=>x.productId),[1]);
  assert.match(safeFtsQuery('yogurt mila'),/"yogurt"\* AND "mila"\*/);
  s.close();
});

test('scoped brand preferences are persistent and global rules remain independent',()=>{
  const s=new AgentStore(':memory:');
  const r=s.upsertRule('user-1',{category:'yogurt',kind:'preferred_brand',value:'Mila'});
  assert.equal(s.upsertRule('user-1',{category:'yogurt',kind:'preferred_brand',value:'MILA'}).id,r.id);
  s.upsertRule('user-1',{kind:'excluded_allergen',value:'arachidi'});
  assert.equal(s.getPreferences('user-1').rules.length,2);
  assert.equal(s.getPreferences('user-2').rules.length,0);
  assert.equal(s.getPreferences('user-1').excludedAllergens[0],'arachidi');
  assert.equal(s.removeRule('user-1',r.id).removed,true);
  assert.equal(s.getPreferences('user-1').rules.length,1);
  s.close();
});

test('legacy JSON preferences import is idempotent and does not replace already saved rules',()=>{
  const s=new AgentStore(':memory:');
  s.importLegacyPreferences('user',{excludedBrands:['X'],excludedAllergens:['milk'],blockPossibleTraces:false});
  s.importLegacyPreferences('user',{excludedBrands:['Y']});
  assert.deepEqual(s.getPreferences('user').excludedBrands,['X']);
  assert.deepEqual(s.getPreferences('user').excludedAllergens,['milk']);
  assert.equal(s.getPreferences('user').blockPossibleTraces,false);
  s.close();
});

test('named lists and items use idempotent upsert/absolute quantity',()=>{
  const s=new AgentStore(':memory:');const l=s.createList('default','Settimanale');
  assert.equal(s.createList('default','  settimanale ').id,l.id);
  s.upsertListItem('default',l.id,{term:'Yogurt  Mila',quantity:2});
  s.upsertListItem('default',l.id,{term:' yogurt mila ',quantity:2});
  const list=s.getList('default',l.id);
  assert.equal(list.items.length,1);
  assert.equal(list.items[0].quantity,2);
  assert.equal(s.searchListItems('default','yogurt').length,1);
  assert.equal(s.removeListItem('default',l.id,list.items[0].id).removed,true);
  assert.equal(s.searchListItems('default','yogurt').length,0);
  assert.equal(s.getList('default',l.id).items.length,0);
  s.close();
});

test('List data is account scoped and cannot be edited across profiles',()=>{
  const s=new AgentStore(':memory:');const l=s.createList('user1','Privata');
  assert.throws(()=>s.getList('user2',l.id),/not found/);
  assert.throws(()=>s.upsertListItem('user2',l.id,{term:'latte'}),/not found/);
  assert.equal(s.listLists('user2').length,0);
  s.close();
});

test('Cart plan claims are atomic, irreversible and deduplicated',()=>{
  const s=new AgentStore(':memory:');
  const params={idempotencyKey:'same-request',payload:{intent:{action:'remove'}},baselineFingerprint:'abc',summary:{actions:1}};
  const first=s.createCartPlan('default',params),second=s.createCartPlan('default',params);
  assert.equal(first.id,second.id);
  assert.equal(s.claimCartPlan('default',first.id).claimed,true);
  assert.equal(s.claimCartPlan('default',first.id).claimed,false);
  s.finishCartPlan('default',first.id,'succeeded',{done:true});
  assert.equal(s.getCartPlan('default',first.id).state,'succeeded');
  assert.throws(()=>s.finishCartPlan('default',first.id,'succeeded',{}),/not executing/);
  s.close();
});

test('cart fingerprints ignore observation time and item ordering, react to quantity change',()=>{
  const a={cartId:1,subtotal:10,total:10,packagingFee:0,deliveryFee:0,observedAt:'abc',items:[{itemId:2,productId:22,quantity:1},{itemId:1,productId:11,quantity:2}]};
  const b={...a,observedAt:'xyz',items:[...a.items].reverse()};
  assert.equal(cartFingerprint(a),cartFingerprint(b));
  assert.notEqual(cartFingerprint(a),cartFingerprint({...a,items:[{...a.items[0],quantity:4},a.items[1]]}));
});
