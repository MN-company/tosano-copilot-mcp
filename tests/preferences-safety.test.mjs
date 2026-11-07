import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkProduct} from '../src/preferences.mjs';
import {rankProducts} from '../src/smart-search.mjs';
import {productView} from '../src/sanitize.mjs';
const product=(id,brand,price,format='GR. 500')=>({productId:id,brand,name:'YOGURT '+brand,category:'YOGURT',sizeLabel:format,unitPrice:price,ingredients:'latte',allergens:['latte'],possibleTraces:[]});
test('excluded allergens also check explicit possible traces; missing trace declaration needs review',()=>{
 const prefs={excludedAllergens:['arachidi'],blockPossibleTraces:true,rules:[]};
 assert.equal(checkProduct({...product(1,'X',1),possibleTraces:['arachidi']},prefs).result,'blocked');
 const unknown=checkProduct({...product(1,'X',1),possibleTraces:null},prefs);
 assert.equal(unknown.result,'review_required');assert.match(unknown.unknown.join(' '),/traces/i);
 assert.equal(checkProduct({...product(1,'X',1),possibleTraces:[]},prefs).result,'not_blocked_by_configured_rules');
 assert.equal(checkProduct({...product(1,'X',1),possibleTraces:null},{...prefs,blockPossibleTraces:false}).result,'not_blocked_by_configured_rules');
});
test('sanitizer never fabricates structured possible traces',()=>{
 assert.equal(productView({name:'TEST',allergens:['arachidi']}).possibleTraces,null);
 assert.equal(productView({name:'TEST',possibleTraces:['arachidi']}).possibleTraces[0],'arachidi');
 assert.equal(productView({name:'TEST',possibleTraces:[{name:'arachidi'}]}).possibleTraces,null);
});
test('preferred package format influences ranking but is not allergy clearance',()=>{
 const prefs={rules:[{kind:'preferred_format',value:'GR. 250',category:'yogurt',strength:'soft'}]};
 const ranked=rankProducts([product(1,'A',1,'GR. 500'),product(2,'B',1.1,'GR. 250')],prefs,{category:'yogurt'});
 assert.equal(ranked.results[0].productId,2);assert.equal(ranked.results[0].matchesPreferredFormat,true);
 const hard=rankProducts([product(1,'A',1,'GR. 500')],{rules:[{kind:'preferred_format',value:'GR. 250',category:'yogurt',strength:'hard'}]},{category:'yogurt'});
 assert.equal(hard.recommendedProductId,null);assert.equal(hard.results[0].compatibility,'blocked');
});
test('shoppingPriority price sorts by comparable price, nutrition never invents ranking',()=>{
 const pref={shoppingPriority:'price',rules:[{kind:'preferred_brand',category:'yogurt',value:'COSTOSO',strength:'soft'}]};
 const ranked=rankProducts([product(1,'COSTOSO',3),product(2,'ECONOMICO',1)],pref,{category:'yogurt'});
 assert.equal(ranked.recommendedProductId,2);
 const nutrition=rankProducts([product(1,'A',1)],{shoppingPriority:'nutrition',rules:[]},{category:'yogurt'});
 assert.equal(nutrition.nutritionRankingAvailable,false);
});

test('ingredient text containing an excluded allergen blocks despite empty structured allergen array',()=>{
 const data={...product(1,'X',1),ingredients:'Farina, arachidi, sale',allergens:[],possibleTraces:[]};
 const r=checkProduct(data,{excludedAllergens:['arachidi'],blockPossibleTraces:true,rules:[]});
 assert.equal(r.result,'blocked');
});
