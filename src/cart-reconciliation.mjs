/** Pure, read-only reconciliation of an approved cart plan with a fresh server GET.
 * Never retries a mutation. A failed POST is NOT proof that the cart was unchanged.
 */
export function cartIdentity(cart) {
  return {
    cartId: cart?.cartId ?? null,
    mode: cart?.mode ?? null,
    pickupOrDeliveryLocation: cart?.pickupOrDeliveryLocation ?? null,
    timeslot: cart?.timeslot ? { date:cart.timeslot.date ?? null, name:cart.timeslot.name ?? null } : null
  };
}
export function sameCartIdentity(before, after) {
  return Number.isSafeInteger(before?.cartId) && before.cartId === after?.cartId &&
    JSON.stringify(cartIdentity(before)) === JSON.stringify(cartIdentity(after));
}
function safeQty(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
export function reconcileCartChanges(changes, after, {attemptedCount=changes.length, beforeIdentity=null, commandError=null}={}) {
  if (!Array.isArray(changes) || !changes.length) throw new Error('At least one cart change is required');
  if (!after || !after.live || after.source!=='fresh_get' || !Array.isArray(after.items)) {
    return { status:'unknown', identityMatches:false, results:changes.map((c,i)=>({productId:c.productId,
      action:c.action,requestedQuantity:c.to,observedQuantity:null,status:i>=attemptedCount?'not_attempted':'unverified'})),
      warning:'No verified fresh cart read; no automatic retry allowed.' };
  }
  const identityMatches = beforeIdentity ? JSON.stringify(beforeIdentity)===JSON.stringify(cartIdentity(after)) : true;
  if (!identityMatches) {
    return {status:'unknown',identityMatches:false,
      results:changes.map((c,i)=>({productId:c.productId,action:c.action,requestedQuantity:c.to,observedQuantity:null,
        status:i>=attemptedCount?'not_attempted':'unverified'})),
      warning:'Cart identity or purchase context changed; no automatic retry allowed.'};
  }
  const results=changes.map((c,i)=>{
    // Updates/removals identify a specific CART LINE, not merely a product. A
    // second line for the same product must not be mistaken for the edited line.
    const line=c.action==='add'
      ? after.items.find(x=>x.productId===c.productId)
      : after.items.find(x=>x.itemId===c.itemId && x.productId===c.productId);
    const actual=safeQty(line?.quantity ?? (line ? null : 0));
    const confirmed=c.action==='remove' ? actual===0 :
      c.action==='add' ? actual!==null && actual>=c.to : actual===c.to;
    const status=c.action==='noop' ? (confirmed?'confirmed':'missing') : i>=attemptedCount?'not_attempted':confirmed?'confirmed':'missing';
    return {productId:c.productId,action:c.action,itemId:c.itemId??null,
      previousQuantity:c.from,requestedQuantity:c.to,observedQuantity:actual,status};
  });
  const confirmed=results.filter(x=>x.status==='confirmed').length;
  const unverified=results.some(x=>x.status==='unverified');
  const status=unverified?'unknown':confirmed===results.length?'succeeded':confirmed>0?'partial':'failed';
  return {status,identityMatches:true,confirmed,requested:results.length,results,
    cart:{cartId:after.cartId,total:after.total,subtotal:after.subtotal,totalItems:after.totalItems,
      observedAt:after.observedAt,source:after.source,live:true},
    ...(commandError?{commandError}:{}),
    ...(status!=='succeeded'?{warning:'Some cart changes were not confirmed. Inspect the current cart; do not replay this plan.'}:{})};
}
