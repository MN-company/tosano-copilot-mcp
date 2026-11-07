import test from 'node:test';
import assert from 'node:assert/strict';
import { TosanoClient, TosanoError } from '../src/client.mjs';
import { cartView, productView, searchView } from '../src/sanitize.mjs';
import { checkProduct, normalizePrefs, DEFAULT_PREFS, PreferencesStore } from '../src/preferences.mjs';
import { getConfig } from '../src/config.mjs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const sampleProduct = {
  productId: 1001, name: 'PASTA', description: 'GR. 500', price: 1.2,
  vendor: { name: 'Brand X' }, priceStandardUmDisplay: 2.4,
  media: [{type:'back',medium:'https://example.org/back.jpg'}],
  available:100000000, productClasses: []
};
const sampleCart = { cartId: 44, totalItems: 1, totalPrice: 1.2, grossTotal: 1.3,
  packageTotal: 0.1, user: { email: 'secret@example.org', fiscalCode:'SECRET' },
  shippingAddress: { addressType:'drive', addressName:'Store', address1:'PRIVATE' },
  cartItems: [{itemId: 303, quantity: 1, unitPrice: 1.2, grossTotal: 1.2, product: sampleProduct }]};
const sampleSearch = {page: {selPage: 1, totPages: 2, totItems: 24}, products: [sampleProduct],
  user: { email: 'secret@example.org' }};
const ok = data => ({ok:()=>true,status:()=>200,json:async()=>({response:{status:0,errors:[]},data,user:{email:'secret@example.org'}})});
function fake(resolver) {
  const calls=[];
  const http={
    get:async(url,options)=>{calls.push({method:'GET',url,options});return resolver?.('GET',url,options) ?? ok(sampleSearch)},
    post:async(url,options)=>{calls.push({method:'POST',url,options});return resolver?.('POST',url,options) ?? ok(sampleCart)}
  };
  return {http,calls};
}
const cfg = (extras={})=>({allowCartWrites: true, contextHash:'w90d2026-11-03t372',cartReadPath:'',...extras});

test('product sanitization never leaks account data or treats large available as stock',()=>{
  const p=productView({...sampleProduct,personalData:{email:'secret@example.org'}});
  assert.equal(p.availabilityConfirmed,false);
  assert.equal(p.productId,1001);
  assert(!JSON.stringify(p).includes('secret@example.org'));
});
test('search uses observed endpoint, context, pagination, and strips user profile',async()=>{
  const f=fake();
  const result=await new TosanoClient(f.http,cfg()).search('pasta barilla',{page:2,pageSize:12,promo:true});
  assert.match(f.calls[0].url,/\/ebsn\/api\/products\?/);
  const u=new URL(f.calls[0].url);
  assert.equal(u.searchParams.get('q'),'pasta barilla');
  assert.equal(u.searchParams.get('page'),'2');
  assert.equal(u.searchParams.get('page_size'),'12');
  assert.equal(u.searchParams.get('hash'),'w90d2026-11-03t372');
  assert.equal(result.products.length,1);
  assert(!JSON.stringify(result).includes('secret@example.org'));
});
test('product details use slug instead of q',async()=>{
  const f=fake(()=>ok(sampleProduct));
  const p=await new TosanoClient(f.http,cfg()).productDetails('pasta-protein-test');
  assert.equal(p.productId,1001);
  assert.equal(new URL(f.calls[0].url).searchParams.get('slug'),'pasta-protein-test');
});
test('observed add payload and sanitized cart, never exposes user data',async()=>{
  const f=fake();
  const out=await new TosanoClient(f.http,cfg()).addItems([{productId:1001, quantity:2,acceptAlternatives:false}]);
  assert.equal(f.calls.length,1);
  assert.equal(new URL(f.calls[0].url).pathname,'/ebsn/api/cart/add');
  assert.deepEqual(f.calls[0].options.data,{items:[{productId:1001,quantity:2,infos:{accept_alternatives:false}}]});
  assert.equal(out.total,1.3);
  assert(!JSON.stringify(out).includes('secret@example.org'));
  assert(!JSON.stringify(out).includes('PRIVATE'));
});
test('observed update payload is absolute quantity, delete uses both IDs',async()=>{
  const f=fake();const c=new TosanoClient(f.http,cfg());
  await c.updateQuantity(303,2);
  await c.deleteItem(303,1001);
  assert.deepEqual(f.calls[0].options.data,{items:[{itemId:303,quantity:2,searchParams:{}}]});
  assert.deepEqual(f.calls[1].options.data,{items:[{itemId:303,productId:1001}]});
});
test('writes are off by default',async()=>{
  const f=fake();const c=new TosanoClient(f.http,cfg({allowCartWrites:false}));
  await assert.rejects(c.addItems([{productId:1001,quantity:1}]),e=>e.code==='WRITES_DISABLED');
  assert.equal(f.calls.length,0);
});
test('refuse to assume cart GET endpoint; last mutation is marked stale',async()=>{
  const f=fake();const c=new TosanoClient(f.http,cfg());
  await assert.rejects(c.readCart(),e=>e.code==='UNVERIFIED_ENDPOINT');
  await c.addItems([{productId:1001,quantity:1}]);
  const out=await c.readCart();
  assert.equal(out.live,false);
  assert.equal(out.source,'last_mutation_only');
});
test('cart GET path when verified returns fresh sanitized data',async()=>{
  const f=fake(()=>ok(sampleCart));const c=new TosanoClient(f.http,cfg({cartReadPath:'/ebsn/api/cart/view'}));
  const out=await c.readCart();
  assert.equal(out.live,true);
  assert.equal(out.source,'fresh_get');
  assert.equal(f.calls[0].method,'GET');
  assert.equal(new URL(f.calls[0].url).pathname,'/ebsn/api/cart/view');
});
test('invalid input and nonzero EBSN status fail closed',async()=>{
  const f=fake(()=>({ok:()=>true,status:()=>200,json:async()=>({response:{status:4,errors:['bad']},data:sampleCart})}));
  const c=new TosanoClient(f.http,cfg());
  await assert.rejects(c.addItems([{productId:1001,quantity:1}]),e=>e.code==='EBSN_REJECTED');
  await assert.rejects(c.addItems([{productId:1001,quantity:-1}]),e=>e.code==='INVALID_ARGUMENT');
  assert.equal(f.calls.length,1);
});
test('network failure of writes is never automatically retried',async()=>{
  let count=0;const f=fake(()=>{count++;throw new Error('network');});
  await assert.rejects(new TosanoClient(f.http,cfg()).deleteItem(303,1001),e=>e.code==='NETWORK_AMBIGUOUS');
  assert.equal(count,1);
});
test('configured brand exclusion blocks, missing allergy data requires review',()=>{
  const prefs=normalizePrefs({...DEFAULT_PREFS,excludedBrands:['Brand X'],excludedAllergens:['milk']});
  assert.equal(checkProduct(productView(sampleProduct),prefs).result,'blocked');
  assert.equal(checkProduct(productView({...sampleProduct,vendor:{name:'Other'}}),prefs).result,'review_required');
  assert.equal(checkProduct(productView(sampleProduct),DEFAULT_PREFS).result,'not_blocked_by_configured_rules');
});
test('preferences are stored on disk with owner-only permissions',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tosano-test-'));
  try {
    const store=new PreferencesStore(path.join(dir,'preferences.json'));
    const out=await store.update({excludedBrands:[' Brand X '],excludedAllergens:['milk']});
    assert.deepEqual(out.excludedBrands,['Brand X']);
    assert.deepEqual((await store.read()).excludedAllergens,['milk']);
    assert.equal((await fs.stat(store.file)).mode & 0o777,0o600);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('config refuses arbitrary URL as cart GET and bad context hash',()=>{
  assert.throws(()=>getConfig({TOSANO_CART_READ_PATH:'https://evil.example/token'}));
  assert.throws(()=>getConfig({TOSANO_CART_READ_PATH:'/ebsn/api/cart/delete'}));
  assert.throws(()=>getConfig({TOSANO_CONTEXT_HASH:'w90&token=abc'}));
});
