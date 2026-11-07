import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore} from '../src/agent-db.mjs';
import {CartPlanner} from '../src/cart-planner.mjs';
import {cartIdentity,reconcileCartChanges} from '../src/cart-reconciliation.mjs';
import {TosanoError} from '../src/client.mjs';
const P={excludedBrands:[],excludedIngredients:[],excludedAllergens:[],rules:[],blockPossibleTraces:true};
const fmt = (rows,cartId=42,slot='10:00')=>({source:'fresh_get',live:true,observedAt:new Date().toISOString(),cartId,
  mode:'drive',pickupOrDeliveryLocation:'Pederobba',timeslot:{date:'2026-11-04',name:slot},
  subtotal:rows.reduce((a,x)=>a+x.quantity*x.unitPrice,0),total:rows.reduce((a,x)=>a+x.quantity*x.unitPrice,0)+.1,
  totalItems:rows.length,deliveryFee:0,packagingFee:.1,items:structuredClone(rows)});
const row=id=>({itemId:1000+id,productId:id,quantity:1,unitPrice:1,total:1});
const change=id=>({action:'add',productId:id,from:0,to:1});
test('seven-line plan reports six confirmed and one missing as partial with exact quantities',()=>{
  const before=fmt([]),after=fmt([1,2,3,4,5,6].map(row));
  const out=reconcileCartChanges([1,2,3,4,5,6,7].map(change),after,{beforeIdentity:cartIdentity(before),attemptedCount:7,commandError:'HTTP_ERROR'});
  assert.equal(out.status,'partial');assert.equal(out.confirmed,6);assert.equal(out.requested,7);
  assert.deepEqual(out.results.map(x=>x.status),[...Array(6).fill('confirmed'),'missing']);
  assert.equal(out.cart.total,6.1);assert.equal(out.commandError,'HTTP_ERROR');
});
test('a changed cart ID or purchase slot cannot be reconciled as success',()=>{
  const before=fmt([]),changes=[change(1)];
  for(const after of [fmt([row(1)],41),fmt([row(1)],42,'11:00')]){
    const result=reconcileCartChanges(changes,after,{beforeIdentity:cartIdentity(before)});
    assert.equal(result.status,'unknown');assert.equal(result.identityMatches,false);
  }
});
test('an uncertain write and a failed GET are never reported successful',()=>{
 const r=reconcileCartChanges([change(1)],null,{attemptedCount:1,beforeIdentity:cartIdentity(fmt([]))});
 assert.equal(r.status,'unknown');assert.equal(r.results[0].status,'unverified');
});
test('an aborted batch marks nonattempted lines and never guesses their success',()=>{
 const r=reconcileCartChanges([change(1),change(2),change(3)],fmt([row(1)]),{attemptedCount:2,beforeIdentity:cartIdentity(fmt([]))});
 assert.deepEqual(r.results.map(x=>x.status),['confirmed','missing','not_attempted']);
 assert.equal(r.status,'partial');
});
test('planner persists partial 6/7, returns accurate result and cannot replay',async()=>{
 const db=new AgentStore(':memory:');let items=[];let posts=[];let reads=0;
 const api={
  async readCart(){reads++;return fmt(items);},
  async productDetails(slug){return {productId:Number(slug.split('-')[1]),slug,unitPrice:1,brand:'TEST',name:'Prodotto',ingredients:null,allergens:null};},
  async addItems([{productId}]) {posts.push(productId);if(productId===7)throw new TosanoError('HTTP 422','HTTP_ERROR');items.push(row(productId));return fmt(items);}
 };
 const p=new CartPlanner(db,api);
 const plan=await p.prepare({action:'add',mode:'ensure_minimum',items:[1,2,3,4,5,6,7].map(id=>({productId:id,slug:'item-'+id,quantity:1}))},P);
 const result=await p.commit(plan.planId,plan.confirmationPhrase,P,{allowCartWrites:true});
 assert.equal(result.status,'partial');assert.equal(result.confirmed,6);
 assert.deepEqual(result.results.map(x=>x.status),[...Array(6).fill('confirmed'),'missing']);
 assert.equal(db.getCartPlan('default',plan.planId).state,'partial');
 assert.equal(reads,3);assert.deepEqual(posts,[1,2,3,4,5,6,7]);
 await assert.rejects(p.commit(plan.planId,plan.confirmationPhrase,P,{allowCartWrites:true}),/Plan state partial/);
 assert.deepEqual(posts,[1,2,3,4,5,6,7]);
 const readOnly=await p.reconcile(plan.planId);
 assert.equal(readOnly.status,'partial');assert.equal(readOnly.readOnly,true);
 assert.deepEqual(posts,[1,2,3,4,5,6,7]);
 db.close();
});
test('a lost mutation reply remains unknown, even when immediate GET shows no line',async()=>{
 const db=new AgentStore(':memory:'), calls=[];
 const api={readCart:async()=>fmt([]),productDetails:async(slug)=>({productId:1,slug,unitPrice:1}),
 addItems:async()=>{calls.push('POST');throw new TosanoError('Reply lost','NETWORK_AMBIGUOUS')}};
 const p=new CartPlanner(db,api);
 const plan=await p.prepare({action:'add',items:[{productId:1,slug:'item-1',quantity:1}]},P);
 const result=await p.commit(plan.planId,plan.confirmationPhrase,P,{allowCartWrites:true});
 assert.equal(result.status,'unknown');assert.equal(db.getCartPlan('default',plan.planId).state,'unknown');
 await assert.rejects(p.commit(plan.planId,plan.confirmationPhrase,P,{allowCartWrites:true}),/Plan state unknown/);
 assert.equal(calls.length,1);db.close();
});
