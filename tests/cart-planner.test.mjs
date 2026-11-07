import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentStore} from '../src/agent-db.mjs';
import {CartPlanner} from '../src/cart-planner.mjs';
const EMPTY={excludedBrands:[],excludedIngredients:[],excludedAllergens:[],rules:[]};
function client(initial=[{itemId:50,productId:10,name:'YOGURT MILA',quantity:1,unitPrice:2,total:2}],fresh=true) {
  let rows=structuredClone(initial),calls=[];
  const makeCart=()=>({source:fresh?'fresh_get':'last_mutation_only',live:fresh,observedAt:new Date().toISOString(),cartId:42,
    subtotal:rows.reduce((x,r)=>x+r.unitPrice*r.quantity,0),deliveryFee:0,packagingFee:.1,
    total:rows.reduce((x,r)=>x+r.unitPrice*r.quantity,0)+.1,items:structuredClone(rows)});
  return {
    calls, makeCart,
    async readCart(){calls.push(['read']);return makeCart();},
    async productDetails(slug){calls.push(['details',slug]);return {productId:slug==='yogurt-mila'?10:20,name:'YOGURT MILA',brand:'MILA',category:'YOGURT',slug,unitPrice:2,ingredients:null,allergens:null};},
    async addItems(items){calls.push(['add',items]);for(const i of items)rows.push({itemId:99,productId:i.productId,quantity:i.quantity,unitPrice:2,total:i.quantity*2});return makeCart();},
    async updateQuantity(id,q){calls.push(['update',id,q]);const row=rows.find(r=>r.itemId===id);row.quantity=q;row.total=q*row.unitPrice;return makeCart();},
    async deleteItem(id,pid){calls.push(['delete',id,pid]);rows=rows.filter(r=>r.itemId!==id);return makeCart();},
    changeExternally(){rows[0].quantity++;}
  };
}

test('cart plan is read-only until exact explicit approval and writes enabled',async()=>{
  const db=new AgentStore(':memory:'),c=client(),p=new CartPlanner(db,c);
  const plan=await p.prepare({action:'add',items:[{productId:10,slug:'yogurt-mila',quantity:2}]},EMPTY);
  assert.equal(plan.summary.changes[0].action,'set_quantity'); // existing line updated, not duplicated
  assert.equal(c.calls.filter(x=>['add','update','delete'].includes(x[0])).length,0);
  await assert.rejects(p.commit(plan.planId,plan.confirmationPhrase,EMPTY,{allowCartWrites:false}),/disabled/);
  await assert.rejects(p.commit(plan.planId,'WRONG',EMPTY,{allowCartWrites:true}),/confirmation/);
  assert.equal(db.getCartPlan('default',plan.planId).state,'prepared');
  const result=await p.commit(plan.planId,plan.confirmationPhrase,EMPTY,{allowCartWrites:true});
  assert.equal(result.status,'succeeded');
  assert.equal(c.calls.filter(x=>x[0]==='update').length,1);
  assert.equal(c.calls.filter(x=>x[0]==='add').length,0);
  assert.equal(result.cart.items[0].quantity,2);
  const repeat=await p.commit(plan.planId,plan.confirmationPhrase,EMPTY,{allowCartWrites:true});
  assert.equal(repeat.status,'already_applied');
  assert.equal(c.calls.filter(x=>x[0]==='update').length,1);
  db.close();
});

test('plan is invalidated if external cart changes before approval, with no writes',async()=>{
  const db=new AgentStore(':memory:'),c=client(),p=new CartPlanner(db,c);
  const plan=await p.prepare({action:'remove',items:[{itemId:50,productId:10}]},EMPTY);
  c.changeExternally();
  await assert.rejects(p.commit(plan.planId,plan.confirmationPhrase,EMPTY,{allowCartWrites:true}),/Cart changed/);
  assert.equal(db.getCartPlan('default',plan.planId).state,'stale');
  assert.equal(c.calls.filter(x=>x[0]==='delete').length,0);
  db.close();
});

test('ensure_minimum does not add duplicates when requested quantity already present',async()=>{
  const db=new AgentStore(':memory:'),c=client(),p=new CartPlanner(db,c);
  const plan=await p.prepare({action:'add',mode:'ensure_minimum',items:[{productId:10,slug:'yogurt-mila',quantity:1}]},EMPTY);
  assert.equal(plan.summary.changes[0].action,'noop');
  const result=await p.commit(plan.planId,plan.confirmationPhrase,EMPTY,{allowCartWrites:true});
  assert.equal(result.applied[0].action,'noop');
  assert.equal(c.calls.filter(x=>['add','delete','update'].includes(x[0])).length,0);
  db.close();
});

test('no fresh GET route means no cart plan and no write',async()=>{
  const db=new AgentStore(':memory:'),c=client([],false),p=new CartPlanner(db,c);
  await assert.rejects(p.prepare({action:'add',items:[{productId:10,slug:'yogurt-mila',quantity:1}]},EMPTY),/Fresh, verified cart read required/);
  assert.equal(c.calls.filter(x=>['add','update','delete'].includes(x[0])).length,0);db.close();
});

test('a network failure after a mutation is marked unknown and must not be retried',async()=>{
  const db=new AgentStore(':memory:'),c=client([],true),p=new CartPlanner(db,c);
  c.addItems=async()=>{c.calls.push(['add']);throw new Error('Simulated lost response');};
  const plan=await p.prepare({action:'add',items:[{productId:10,slug:'yogurt-mila',quantity:1}]},EMPTY);
  const response=await p.commit(plan.planId,plan.confirmationPhrase,EMPTY,{allowCartWrites:true});
  assert.equal(response.status,'unknown');
  assert.equal(db.getCartPlan('default',plan.planId).state,'unknown');
  await assert.rejects(p.commit(plan.planId,plan.confirmationPhrase,EMPTY,{allowCartWrites:true}),/Plan state unknown/);
  assert.equal(c.calls.filter(x=>x[0]==='add').length,1);
  db.close();
});

test('allergen data missing blocks planning for adding yogurt',async()=>{
  const db=new AgentStore(':memory:'),c=client([]),p=new CartPlanner(db,c);
  await assert.rejects(p.prepare({action:'add',items:[{productId:10,slug:'yogurt-mila',quantity:1}]},
    {...EMPTY,excludedAllergens:['milk']}),/Dietary\/brand rule blocks/);
  assert.equal(c.calls.filter(x=>x[0]==='add').length,0);db.close();
});
