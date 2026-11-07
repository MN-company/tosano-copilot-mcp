import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore} from '../src/agent-db.mjs';
import {CartPlanner} from '../src/cart-planner.mjs';
import {cartIdentity,reconcileCartChanges} from '../src/cart-reconciliation.mjs';
const prefs={excludedBrands:[],excludedIngredients:[],excludedAllergens:[],rules:[]};
const row=(itemId,productId,quantity=1)=>({itemId,productId,quantity,unitPrice:1,total:quantity});
const cart=items=>({source:'fresh_get',live:true,cartId:711,mode:'drive',pickupOrDeliveryLocation:'Pederobba',timeslot:{date:'2026-11-04',name:'08:30-09:00'},observedAt:new Date().toISOString(),items,
 subtotal:items.reduce((a,i)=>a+i.total,0),total:items.reduce((a,i)=>a+i.total,0)+.1,deliveryFee:0,packagingFee:.1,totalItems:items.length});
function fakeApi(items=[]){let rows=structuredClone(items),writes=0,failOn=null;return {
 get writes(){return writes},set failOn(v){failOn=v},get rows(){return rows},
 readCart:async()=>cart(rows),productDetails:async slug=>({slug,productId:Number(slug.slice(5)),unitPrice:1,brand:'TEST',name:'PRODOTTO',category:'TEST'}),
 addItems:async([{productId,quantity}])=>{writes++;if(failOn===productId)throw Object.assign(new Error('HTTP 422'),{code:'HTTP_ERROR'});rows.push(row(1000+productId,productId,quantity));return cart(rows)},
 updateQuantity:async(id,quantity)=>{writes++;const r=rows.find(x=>x.itemId===id);r.quantity=quantity;r.total=quantity;return cart(rows)},
 deleteItem:async(id)=>{writes++;rows=rows.filter(x=>x.itemId!==id);return cart(rows)}
}}
test('partial plan reconciliation preserves not_attempted entries on subsequent read',async()=>{
 const db=new AgentStore(':memory:'),api=fakeApi();api.failOn=2;const p=new CartPlanner(db,api);
 const plan=await p.prepare({action:'add',items:[1,2,3].map(id=>({productId:id,slug:'item-'+id,quantity:1}))},prefs);
 const result=await p.commit(plan.planId,plan.confirmationPhrase,prefs,{allowCartWrites:true});
 assert.deepEqual(result.results.map(x=>x.status),['confirmed','missing','not_attempted']);
 assert.equal(result.attemptedCount,2);
 const followup=await p.reconcile(plan.planId);
 assert.deepEqual(followup.results.map(x=>x.status),['confirmed','missing','not_attempted']);
 assert.equal(api.writes,2);db.close();
});
test('an expired unclaimed plan gets a new planId and confirmation phrase',()=>{
 const db=new AgentStore(':memory:');const inp={idempotencyKey:'same-request',payload:{intent:'add'},baselineFingerprint:'a',summary:{changes:[]}};
 const old=db.createCartPlan('default',{...inp,ttlMs:-1000});
 const renewed=db.createCartPlan('default',{...inp,ttlMs:600000});
 assert.notEqual(old.id,renewed.id);assert.equal(renewed.state,'prepared');
 assert.equal(db.getCartPlan('default',old.id).state,'expired');db.close();
});
test('remove and quantity verification use original line ID, not just product ID',()=>{
 const before=cart([row(101,10)]),after=cart([row(102,10)]);
 const remove=reconcileCartChanges([{action:'remove',productId:10,itemId:101,from:1,to:0}],after,{beforeIdentity:cartIdentity(before)});
 assert.equal(remove.status,'succeeded');assert.equal(remove.results[0].observedQuantity,0);
 const qty=reconcileCartChanges([{action:'set_quantity',productId:10,itemId:101,from:1,to:2}],cart([row(102,10,2)]),{beforeIdentity:cartIdentity(before)});
 assert.equal(qty.status,'failed');assert.equal(qty.results[0].observedQuantity,0);
});
test('noop must be verified against actual fresh read, not assumed successful',()=>{
 const before=cart([row(101,10,2)]);
 const r=reconcileCartChanges([{action:'noop',productId:10,itemId:101,from:2,to:2}],cart([]),{beforeIdentity:cartIdentity(before)});
 assert.equal(r.status,'failed');assert.equal(r.results[0].status,'missing');
});
test('harder dietary rules saved after preparation block quantity increases before mutation',async()=>{
 const db=new AgentStore(':memory:'),api=fakeApi([row(101,10)]),p=new CartPlanner(db,api);
 const plan=await p.prepare({action:'set_quantity',items:[{itemId:101,quantity:2}]},prefs);
 await assert.rejects(p.commit(plan.planId,plan.confirmationPhrase,{...prefs,excludedAllergens:['latte']},{allowCartWrites:true}),/Dietary preferences changed/);
 assert.equal(api.writes,0);assert.equal(db.getCartPlan('default',plan.planId).state,'stale');db.close();
});
test('duplicate cart lines for same product fail closed before planning an add',async()=>{
 const db=new AgentStore(':memory:'),api=fakeApi([row(101,10),row(102,10)]),p=new CartPlanner(db,api);
 await assert.rejects(p.prepare({action:'add',items:[{productId:10,slug:'item-10',quantity:3}]},prefs),/Multiple cart lines/);
 assert.equal(api.writes,0);db.close();
});
test('plan cannot be prepared without a valid cart identifier',async()=>{
 const db=new AgentStore(':memory:'),api=fakeApi(),p=new CartPlanner(db,{...api,readCart:async()=>({...cart([]),cartId:null})});
 await assert.rejects(p.prepare({action:'add',items:[{productId:10,slug:'item-10',quantity:1}]},prefs),/verifiable cart ID/);db.close();
});
test('hard format preferences also block a direct cart addition, not just ranking',async()=>{
 const db=new AgentStore(':memory:'),api=fakeApi(),p=new CartPlanner(db,{...api,productDetails:async slug=>({slug,productId:10,unitPrice:1,brand:'TEST',name:'YOGURT',sizeLabel:'GR. 1000',category:'YOGURT'})});
 await assert.rejects(p.prepare({action:'add',items:[{productId:10,slug:'item-10',quantity:1}]},
  {...prefs,rules:[{kind:'preferred_format',strength:'hard',category:'yogurt',value:'GR. 250'}]}),/Dietary\/brand rule blocks/);
 assert.equal(api.writes,0);db.close();
});
import fs from 'node:fs';
test('MCP server shares one in-flight CartPlanner instance across concurrent tool calls',()=>{
 const source=fs.readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
 assert.match(source,/let plannerPromise;/);
 assert.match(source,/if\(!plannerPromise\)plannerPromise=verifiedClient\(\)/);
 assert.doesNotMatch(source,/if\(!planner\)planner=new CartPlanner\(store,await verifiedClient\(\)/);
});
import {rankProducts} from '../src/smart-search.mjs';
test('different price-per-100 units cannot yield a fake cheapest recommendation',()=>{
 const products=[
 {productId:1,name:'SOLIDO',sizeLabel:'GR. 500',unitPrice:1,category:'DOLCI'},
 {productId:2,name:'LIQUIDO',sizeLabel:'ML. 500',unitPrice:1,category:'DOLCI'}
 ];
 const result=rankProducts(products,{...prefs,shoppingPriority:'price'},{category:'dolci',sortBy:'price_per_100'});
 assert.equal(result.mixedPriceUnits,true);assert.equal(result.recommendedProductId,null);
 assert.match(result.priceUnitWarning,/cannot be ranked together/);
});
test('two comparable products remain sorted by actual price per 100 g',()=>{
 const products=[
 {productId:1,name:'A',sizeLabel:'GR. 500',unitPrice:2,category:'DOLCI'},
 {productId:2,name:'B',sizeLabel:'GR. 500',unitPrice:1,category:'DOLCI'}
 ];
 const result=rankProducts(products,{...prefs,shoppingPriority:'price'},{category:'dolci',sortBy:'price_per_100'});
 assert.notEqual(result.mixedPriceUnits,true);assert.equal(result.recommendedProductId,2);
});
