/** Two-phase, snapshot-checked cart modifications; no checkout. */
import { createHash } from 'node:crypto';
import { cartFingerprint } from './agent-db.mjs';
import { checkProduct } from './preferences.mjs';
import { TosanoError } from './client.mjs';
import {cartIdentity,reconcileCartChanges} from './cart-reconciliation.mjs';
import {encodeQuantity,validateOptions,estimateLine} from './selling.mjs';

const fingerprintIntent = (baseline, intent, checks=[]) => createHash('sha256').update(`${baseline}:${JSON.stringify(intent)}:${JSON.stringify(checks)}`).digest('hex');
function isInteger(n) { return Number.isSafeInteger(n)&&n>0; }
function isQty(n,max=100) { return typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=max&&Math.round(n*1000)/1000===n; }
function validOptions(o){ return o===undefined||(o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).length<=5&&Object.entries(o).every(([k,v])=>/^[\w-]{1,60}$/.test(k)&&typeof v==='string'&&v.length<=80)); }
function hasDietaryExclusions(prefs) {
  return Boolean(prefs?.excludedAllergens?.length || prefs?.excludedIngredients?.length ||
    prefs?.rules?.some(r=>r.kind==='excluded_allergen'||r.kind==='excluded_ingredient'));
}
function validateIntent(intent) {
  if(!intent||!['add','set_quantity','remove'].includes(intent.action))throw new TosanoError('Invalid action','INVALID_ARGUMENT');
  if(!Array.isArray(intent.items)||intent.items.length<1||intent.items.length>20)throw new TosanoError('Expected 1-20 items','INVALID_ARGUMENT');
  if(intent.action==='add' && !['ensure_minimum','increment'].includes(intent.mode??'ensure_minimum'))throw new TosanoError('Invalid add mode','INVALID_ARGUMENT');
  for(const x of intent.items){
    if(intent.action==='add'){
      if(!isInteger(x.productId)||typeof x.slug!=='string'||!/^[a-z0-9-]{3,200}$/.test(x.slug)|| !isQty(x.quantity,5000)||!validOptions(x.options))
        throw new TosanoError('Invalid add item','INVALID_ARGUMENT');
    }else if(intent.action==='set_quantity'){
      if(!isInteger(x.itemId)||!isQty(x.quantity))throw new TosanoError('Invalid quantity update','INVALID_ARGUMENT');
    }else if(!isInteger(x.itemId)||!isInteger(x.productId))throw new TosanoError('Invalid delete item','INVALID_ARGUMENT');
  }
  return {action:intent.action,mode:intent.action==='add'?(intent.mode??'ensure_minimum'):null,
    items:intent.items.map(x=>intent.action==='add'?{productId:x.productId,slug:x.slug,quantity:x.quantity,acceptAlternatives:false,...(x.options&&Object.keys(x.options).length?{options:x.options}:{})}
      :intent.action==='set_quantity'?{itemId:x.itemId,quantity:x.quantity}:{itemId:x.itemId,productId:x.productId})};
}
function resolveChanges(intent,cart){
  const changes=[];
  const idCounts=new Map();
  for(const item of cart.items){idCounts.set(item.productId,(idCounts.get(item.productId)??0)+1);}
  for(const x of intent.items){
    if(intent.action==='add' && idCounts.get(x.productId)>1)
      throw new TosanoError('Multiple cart lines for same product: manual review required','AMBIGUOUS_CART_ITEM');
    if(intent.action==='add') {
      const current=cart.items.find(i=>i.productId===x.productId);
      if(current){
        const target=intent.mode==='increment'?current.quantity+x.quantity:Math.max(current.quantity,x.quantity);
        if(target>100)throw new TosanoError('Quantity exceeds maximum','INVALID_ARGUMENT');
        changes.push({action:target===current.quantity?'noop':'set_quantity',itemId:current.itemId,productId:x.productId,
          from:current.quantity,to:target,slug:x.slug});
      }else changes.push({action:'add',productId:x.productId,slug:x.slug,from:0,to:x.quantity});
    } else {
      const current=cart.items.find(i=>i.itemId===x.itemId);
      if(!current)throw new TosanoError('Cart line absent; refresh cart','CART_ITEM_NOT_FOUND');
      if(intent.action==='remove'&&current.productId!==x.productId)throw new TosanoError('Cart item changed','CART_MISMATCH');
      if(intent.action==='set_quantity')changes.push({action:current.quantity===x.quantity?'noop':'set_quantity',itemId:x.itemId,productId:current.productId,
        from:current.quantity,to:x.quantity});
      else changes.push({action:'remove',itemId:x.itemId,productId:x.productId,from:current.quantity,to:0});
    }
  }
  const ids=changes.map(c=>String(c.itemId??'product:'+c.productId));
  if(new Set(ids).size!==ids.length)throw new TosanoError('Same product/cart line repeated in one change','DUPLICATE_REQUEST');
  return changes;
}
export class CartPlanner {
  #queue=Promise.resolve();
  constructor(store,client,profileId='default') {this.store=store;this.client=client;this.profileId=profileId;}
  async prepare(intent,prefs,{idempotencyKey=null}={}) {
    const valid=validateIntent(intent);
    const cart=await this.client.readCart();
    if(!cart.live||cart.source!=='fresh_get')throw new TosanoError('Fresh, verified cart read required','FRESH_CART_REQUIRED');
    if(!Number.isSafeInteger(cart.cartId) || cart.cartId<1)
      throw new TosanoError('Fresh cart has no verifiable cart ID','INVALID_CART_ID');
    const productChecks=[];
    if(valid.action==='add') for(const x of valid.items){
      const details=await this.client.productDetails(x.slug);
      if(details.productId!==x.productId)throw new TosanoError('Product ID and slug do not match','PRODUCT_MISMATCH');
      const check=checkProduct(details,prefs);
      if(check.result!=='not_blocked_by_configured_rules')
        throw new TosanoError('Dietary/brand rule blocks automatic cart change: '+check.result,'PREFERENCES_BLOCK');
      // Site selling rules: pieces vs weight, multiples, minimums, options. Never silently rounded.
      const enc=encodeQuantity(details.selling,x.quantity);
      const opts=validateOptions(details.options??[],x.options);
      x.quantity=enc.cartQuantity;
      if(Object.keys(opts).length)x.options=opts;else delete x.options;
      productChecks.push({productId:x.productId,price:details.unitPrice,slug:x.slug,requested:enc.display,
        ...(details.selling?.variableWeight?{variableWeight:true,estimate:estimateLine(details.selling,details.pricePerUnit,enc.cartQuantity)}:{}),
        ...(details.selling?.dayLock?{dayLock:details.selling.dayLock}:{}),
        ...(Object.keys(opts).length?{options:opts}:{})});
    }
    const changes=resolveChanges(valid,cart);
    if(valid.action==='set_quantity'){
      const increases=changes.filter(c=>c.to>c.from);
      if(increases.length && hasDietaryExclusions(prefs))
        throw new TosanoError('Quantity increases require checked product details under dietary restrictions','REVIEW_REQUIRED');
    }
    const base=cartFingerprint(cart);
    const priceFor = change => {
      const old=cart.items.find(i=>i.productId===change.productId);
      if(old) return old.unitPrice;
      return productChecks.find(c=>c.productId===change.productId)?.price;
    };
    const deltas=changes.map(change=>{
      const price=priceFor(change);
      return Number.isFinite(price)?price*(change.to-change.from):null;
    });
    const estimatedDelta=deltas.every(Number.isFinite)?Math.round(deltas.reduce((a,b)=>a+b,0)*100)/100:null;
    const summary={action:valid.action,mode:valid.mode,changes,products:productChecks.map(({price,...p})=>p),cartId:cart.cartId,cartIdentity:cartIdentity(cart),subtotalBefore:cart.subtotal,totalBefore:cart.total,
      estimatedItemDelta:estimatedDelta,estimatedTotal:estimatedDelta!==null&&Number.isFinite(cart.total)?
        Math.round((cart.total+estimatedDelta)*100)/100:null,
      priceIsEstimate:true,approvalRequired:true,cartObservedAt:cart.observedAt};
    const plan=this.store.createCartPlan(this.profileId,{idempotencyKey:idempotencyKey??fingerprintIntent(base,valid,productChecks),
      payload:{intent:valid,productChecks},baselineFingerprint:base,summary});
    if(!['prepared'].includes(plan.state)) {
      throw new TosanoError(`Previous ${plan.state} plan must be reconciled before starting a new approved action`,
        'PREVIOUS_PLAN_REQUIRES_REVIEW');
    }
    const code=`APPROVE ${plan.id.slice(0,8).toUpperCase()}`;
    return {planId:plan.id,state:plan.state,expiresAt:plan.expiresAt,summary:plan.summary,
      confirmationPhrase:code,requiresExplicitUserConfirmation:true,
      warning:'Show this exact plan to the user. Do not commit without their subsequent explicit approval.'};
  }
  async reconcile(planId) {
    const plan=this.store.getCartPlan(this.profileId,planId);
    if(!plan)throw new TosanoError('Plan not found','PLAN_NOT_FOUND');
    if(!plan.summary.cartIdentity)return {planId,planState:plan.state,status:'unknown',warning:'Legacy plan lacks a verifiable cart identity; cannot reconcile safely.'};
    let after=null;
    try{after=await this.client.readCart();}catch{}
    return {planId,planState:plan.state,readOnly:true,originalResult:plan.result?.status??null,
      ...reconcileCartChanges(plan.summary.changes,after,{
        attemptedCount:plan.result?.attemptedCount ?? (plan.state==='prepared' ? 0 : plan.summary.changes.length),
        beforeIdentity:plan.summary.cartIdentity}),
      attributionWarning:'This is the current server cart snapshot, not proof of which earlier request changed it. Never replay an existing plan.'};
  }
  #serial(fn){const next=this.#queue.then(fn);this.#queue=next.catch(()=>{});return next;}
  async commit(planId,confirmationPhrase,prefs,{allowCartWrites=false}={}) {
    return this.#serial(async()=>{
      if(!allowCartWrites)throw new TosanoError('Cart writes disabled in .env','WRITES_DISABLED');
      const plan=this.store.getCartPlan(this.profileId,planId);
      if(!plan)throw new TosanoError('Plan not found','PLAN_NOT_FOUND');
      if(plan.state==='succeeded')return {status:'already_applied',result:plan.result,planId};
      if(plan.state!=='prepared')throw new TosanoError('Plan state '+plan.state+'; do not retry','PLAN_NOT_PREPARED');
      if(confirmationPhrase!==`APPROVE ${plan.id.slice(0,8).toUpperCase()}`)
        throw new TosanoError('Exact plan confirmation phrase required','APPROVAL_REQUIRED');
      const claim=this.store.claimCartPlan(this.profileId,planId);
      if(!claim.claimed)throw new TosanoError(claim.reason,claim.reason);
      let mutationAttempted=false;
      let before=null;
      let changes=[];
      let attemptedCount=0;
      try {
        before=await this.client.readCart();
        if(!before.live||before.source!=='fresh_get'||cartFingerprint(before)!==plan.baselineFingerprint ||
          JSON.stringify(cartIdentity(before))!==JSON.stringify(plan.summary.cartIdentity)){
          this.store.finishCartPlan(this.profileId,planId,'stale',{reason:'Cart or purchase context changed; create a new plan'});
          throw new TosanoError('Cart changed; prepare a new plan','CART_CHANGED');
        }
        const {intent,productChecks}=plan.payload;
        changes=resolveChanges(intent,before);
        // A dietary restriction may have been saved AFTER plan preparation.
        // Quantity increases have no safe product slug to revalidate here.
        if(intent.action==='set_quantity' && changes.some(c=>c.to>c.from) &&
            hasDietaryExclusions(prefs)) {
          this.store.finishCartPlan(this.profileId,planId,'stale',
            {reason:'Dietary preferences now require reviewing a quantity increase'});
          throw new TosanoError('Dietary preferences changed; prepare a new plan','PREFERENCES_CHANGED');
        }
        for(const check of productChecks){
          const details=await this.client.productDetails(check.slug);
          if(details.productId!==check.productId||details.unitPrice!==check.price ||
            checkProduct(details,prefs).result!=='not_blocked_by_configured_rules'){
            this.store.finishCartPlan(this.profileId,planId,'stale',{reason:'Product/price/preference changed'});
            throw new TosanoError('Product or price changed; prepare a new plan','PRODUCT_CHANGED');
          }
        }
        let commandError=null;
        for(const change of changes){
          attemptedCount++;
          if(change.action==='noop')continue;
          mutationAttempted=true;
          try {
            if(change.action==='add')await this.client.addItems([{productId:change.productId,quantity:change.to,acceptAlternatives:false,...(intent.items.find(i=>i.productId===change.productId)?.options?{options:intent.items.find(i=>i.productId===change.productId).options}:{})}]);
            else if(change.action==='set_quantity')await this.client.updateQuantity(change.itemId,change.to);
            else await this.client.deleteItem(change.itemId,change.productId);
          } catch(e) {
            // Stop immediately. The failed HTTP response may follow a successful write.
            // Reconciliation below is read-only, and this plan can never be committed twice.
            commandError=e instanceof TosanoError ? e.code : 'MUTATION_RESPONSE_UNKNOWN';
            break;
          }
        }
        let after=null;
        try {after=await this.client.readCart();}catch { /* no retry, no assumed success */ }
        const result={planId,attemptedCount,...reconcileCartChanges(changes,after,{attemptedCount,
          beforeIdentity:cartIdentity(before),commandError})};
        if(commandError && commandError!=='HTTP_ERROR' && commandError!=='EBSN_REJECTED' &&
            result.status!=='succeeded') {
          result.status='unknown';
          result.warning='Write response ambiguous. A fresh read cannot prove the write will not appear later; do not retry.';
        }
        result.applied=result.results.filter(x=>x.status==='confirmed').map(x=>({action:x.action,productId:x.productId,quantity:x.observedQuantity}));
        if(result.status==='succeeded')result.cart=after; // verified read, not mutation response
        const state=result.status==='partial'?'partial':result.status;
        this.store.finishCartPlan(this.profileId,planId,state,result);
        return result;
      } catch(e) {
        const latest=this.store.getCartPlan(this.profileId,planId);
        if(latest?.state==='executing') {
          // Preflight failure = no mutation. Ambiguous write = never retry this plan.
          this.store.finishCartPlan(this.profileId,planId,mutationAttempted?'unknown':'failed',
            {reason:mutationAttempted?'Write attempted; outcome not verified. Inspect cart before any new plan.':'No cart mutation attempted',
              attemptedCount});
        }
        throw e;
      }
    });
  }
}
