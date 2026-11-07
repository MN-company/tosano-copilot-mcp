/** Deterministic candidate ranking: user preference != safety clearance. */
import { checkProduct } from './preferences.mjs';
import { normalizeTerm } from './agent-db.mjs';

/** Parse a product's explicit package measure; do not infer a weight from a piece count. */
function weightOf(product) {
  const v = normalizeTerm(product.sizeLabel ?? product.name ?? '');
  const a = /(?:^|\W)(kg|gr|g|ml|lt|l)\.?\s*(\d+(?:[.,]\d+)?)/i.exec(v);
  const b = /(\d+(?:[.,]\d+)?)\s*(kg|gr|g|ml|lt|l)(?:\W|$)/i.exec(v);
  if (!a && !b) return null;
  const n = Number((a ? a[2] : b[1]).replace(',', '.'));
  const unit = normalizeTerm(a ? a[1] : b[2]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const match = a ?? b;
  // Typical package labels: "GR. 125 X 8 PZ." = 1 kg, not 125 g.
  const after = v.slice(match.index + match[0].length);
  const multiple = /^\s*(?:x|×)\s*(\d{1,3})(?=\W|$)/i.exec(after);
  const pieces = multiple ? Number(multiple[1]) : 1;
  if (!Number.isSafeInteger(pieces) || pieces < 1 || pieces > 100) return null;
  return { amount: n * pieces * (['kg','l','lt'].includes(unit) ? 1000 : 1),
    base: ['ml','l','lt'].includes(unit) ? 'l' : 'kg' };
}
/** Current displayed package price wins over an inconsistent catalog per-kg list price. */
export function pricePer100(product) {
  const size=weightOf(product);
  if (size && Number.isFinite(product.unitPrice) && product.unitPrice>=0)
    return Math.round(product.unitPrice*10000/size.amount)/100;
  // A per-piece label has no verified mass; never treat eggs as priced per 100 g.
  if (/\b(?:pz|pezzi|pieces)\.?\s*\d+/i.test(normalizeTerm(product.sizeLabel??''))) return null;
  if (Number.isFinite(product.pricePerUnit) && product.pricePerUnit>=0 &&
      ['kg','l'].includes(normalizeTerm(product.unit)))
    return Math.round(product.pricePerUnit*10)/100;
  return null;
}
export function rankProducts(products, preferences, {category=null,excludeTerms=[],mustIncludeTerms=[],includeCategory=null,sortBy='preference',brand=null,limit=12}={}) {
  if(!['preference','price_per_100','relevance'].includes(sortBy))throw new Error('Invalid sortBy');
  if(!Number.isSafeInteger(limit)||limit<1||limit>60)throw new Error('Invalid limit');
  const cat=normalizeTerm(category??'');
  const rules=preferences.rules??[];
  const formatsPreferred=rules.filter(r=>r.kind==='preferred_format'&&(r.category==='*'||r.category===cat));
  const brandsPreferred=rules.filter(r=>r.kind==='preferred_brand'&&(r.category==='*'||r.category===cat))
    .map(r=>({name:normalizeTerm(r.value),strength:r.strength}));
  const avoid=excludeTerms.map(normalizeTerm).filter(Boolean);
  const required=mustIncludeTerms.map(normalizeTerm).filter(Boolean);
  const categoryFilter=normalizeTerm(includeCategory??'');
  const askedBrand=normalizeTerm(brand??'');
  const seen=new Set();
  let ranked=[];
  for(const p of products) {
    if(!Number.isSafeInteger(p.productId)||seen.has(p.productId))continue;
    seen.add(p.productId);
    const allText=normalizeTerm([p.name,p.brand,p.category].filter(Boolean).join(' '));
    if(avoid.some(term=>allText.includes(term)))continue;
    if(required.some(term=>!normalizeTerm(p.name).includes(term)))continue;
    if(categoryFilter&&!normalizeTerm(p.category).includes(categoryFilter))continue;
    if(askedBrand && normalizeTerm(p.brand)!==askedBrand)continue;
    const check=checkProduct(p,preferences);
    const formatText=normalizeTerm([p.name,p.sizeLabel].filter(Boolean).join(' '));
    const formatMatches=formatsPreferred.some(r=>formatText.includes(normalizeTerm(r.value)));
    // Hard format restrictions are enforced centrally by checkProduct(), including
    // direct cart adds which never pass through product ranking.
    const matches=brandsPreferred.some(r=>r.name===normalizeTerm(p.brand));
    const hard=brandsPreferred.some(r=>r.strength==='hard');
    if(hard && !matches){check.blockers.push('Required brand for this category not matched');check.result='blocked';}
    ranked.push({product:p,compatibility:check.result,reasons:check.blockers.concat(check.unknown),
      matchesPreferredBrand:matches,matchesPreferredFormat:formatMatches,pricePer100:pricePer100(p),priceUnit:weightOf(p)?.base ?? ((pricePer100(p)!==null && ['kg','l'].includes(normalizeTerm(p.unit)))?normalizeTerm(p.unit):null),
      recommendable:check.result==='not_blocked_by_configured_rules'});
  }
  // €/100 g and €/100 ml are not interchangeable. Mixed-unit searches must
  // request a product category/unit rather than declaring a false cheapest item.
  const priceUnits=[...new Set(ranked.filter(x=>x.pricePer100!==null && x.priceUnit).map(x=>x.priceUnit))];
  const mixedPriceUnits=priceUnits.length>1;
  // Never recommend a blocked or unverified product automatically. Price comparison still displays them with review flag.
  const safety={not_blocked_by_configured_rules:0,review_required:1,blocked:2};
  const effectiveSort=sortBy==='preference' && preferences.shoppingPriority==='price' ? 'price_per_100' : sortBy;
  ranked.sort((a,b)=>{
    const safe=safety[a.compatibility]-safety[b.compatibility];if(safe)return safe;
    if(effectiveSort==='preference' && a.matchesPreferredBrand!==b.matchesPreferredBrand)
      return a.matchesPreferredBrand?-1:1;
    if(effectiveSort==='preference' && a.matchesPreferredFormat!==b.matchesPreferredFormat)
      return a.matchesPreferredFormat?-1:1;
    if(effectiveSort!=='relevance' && !mixedPriceUnits){
      const pa=a.pricePer100??Infinity,pb=b.pricePer100??Infinity;
      if(pa!==pb)return pa-pb;
    }
    return a.product.productId-b.product.productId;
  });
  const count=ranked.length;
  ranked=ranked.slice(0,limit);
  return {count,results:ranked.map(({product,...others})=>({...product,...others})),
    recommendedProductId:(mixedPriceUnits && effectiveSort==='price_per_100') ? null :
      ranked.find(x=>x.recommendable)?.product.productId??null,
    recommendationRequiresConfirmation:true,
    ...(mixedPriceUnits?{mixedPriceUnits:true,priceUnitWarning:'Mass-based and volume-based products cannot be ranked together by price per 100. Specify a comparable unit/category.'}:{}),
    ...(sortBy==='preference'&&preferences.shoppingPriority==='nutrition'?{nutritionRankingAvailable:false,nutritionWarning:'No verified structured nutritional ranking available; preferred brands and price were used.'}:{}),
    note:'Price comparisons are contextual. Missing allergen data is NOT clearance; availability not confirmed.'};
}
