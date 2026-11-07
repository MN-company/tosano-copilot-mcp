import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rankProducts,pricePer100} from '../src/smart-search.mjs';
const yogurt=(id,brand,price,perKg)=>({productId:id,name:`YOGURT ${brand} GR. 500`,brand,category:'YOGURT',sizeLabel:'GR. 500',unitPrice:price,pricePerUnit:perKg,unit:'KG',ingredients:null,allergens:null});

test('100g normalization from per kg or package size, not list price',()=>{
  assert.equal(pricePer100(yogurt(1,'MILA',2.5,5)),0.5);
  assert.equal(pricePer100({unitPrice:3,sizeLabel:'KG. 1'}),0.3);
  assert.equal(pricePer100({unitPrice:4,sizeLabel:'200 g'}),2);
  assert.equal(pricePer100({unitPrice:5,sizeLabel:'500 ml'}),1);
  assert.equal(pricePer100({unitPrice:7}),null);
});

test('yogurt preferred MILA ranks ahead of cheaper alternatives, soft not hard',()=>{
  const prefs={rules:[{kind:'preferred_brand',category:'yogurt',value:'Mila',strength:'soft'}],excludedBrands:[],excludedIngredients:[],excludedAllergens:[]};
  const r=rankProducts([yogurt(1,'MULLER',1.5,3),yogurt(2,'MILA',2.5,5)],prefs,{category:'yogurt'});
  assert.equal(r.recommendedProductId,2);
  assert.deepEqual(r.results.map(x=>x.productId),[2,1]);
  const r2=rankProducts([yogurt(1,'MULLER',1.5,3),yogurt(2,'MILA',2.5,5)],prefs,{category:'yogurt',sortBy:'price_per_100'});
  assert.equal(r2.recommendedProductId,1);
});

test('allergen rules prevent automatic recommendation when labels are missing',()=>{
  const prefs={rules:[{kind:'excluded_allergen',category:'*',value:'milk',strength:'hard'}],excludedBrands:[],excludedIngredients:[],excludedAllergens:['milk']};
  const r=rankProducts([yogurt(1,'MILA',2.5,5)],prefs,{category:'yogurt'});
  assert.equal(r.recommendedProductId,null);
  assert.equal(r.results[0].compatibility,'review_required');
});

test('exclude ritagli or irrelevant products before price comparisons',()=>{
  const prefs={rules:[],excludedBrands:[],excludedIngredients:[],excludedAllergens:[]};
  const products=[{productId:1,name:'RITAGLI SALMONE AFFUMICATO',brand:'A',unitPrice:4.2,pricePerUnit:21,unit:'KG'},
    {productId:2,name:'SALMONE AFFUMICATO A FETTE',brand:'B',unitPrice:3.29,pricePerUnit:32.9,unit:'KG'}];
  const r=rankProducts(products,prefs,{excludeTerms:['ritagli'],sortBy:'price_per_100'});
  assert.deepEqual(r.results.map(x=>x.productId),[2]);
});

test('category and required-name filters reject cooked dishes and canned products',()=>{
  const prefs={rules:[],excludedBrands:[],excludedIngredients:[],excludedAllergens:[]};
  const products=[
    {productId:1,name:'SUGO AL SALMONE AFFUMICATO',category:'SUGHI E SALSE',brand:'X',unitPrice:2.5,pricePerUnit:16,unit:'KG'},
    {productId:2,name:'SALMONE NORVEGESE A FETTE AFFUMICATO',category:'AFFUMICATI E SPECIALITÀ',brand:'Y',unitPrice:3.5,pricePerUnit:35,unit:'KG'},
    {productId:3,name:'TARTARE DI SALMONE',category:'AFFUMICATI E SPECIALITÀ',brand:'Z',unitPrice:3,pricePerUnit:30,unit:'KG'}
  ];
  const r=rankProducts(products,prefs,{includeCategory:'affumicati e specialità',mustIncludeTerms:['affumicato'],sortBy:'price_per_100'});
  assert.deepEqual(r.results.map(x=>x.productId),[2]);
});


test('discounted package price outranks stale catalog per-kg price',()=>{
  assert.equal(pricePer100({unitPrice:0.99,pricePerUnit:3.38,unit:'KG',sizeLabel:'GR. 400'}),0.25);
  assert.equal(pricePer100({unitPrice:0.99,pricePerUnit:1.39,unit:'L',sizeLabel:'LT. 1'}),0.1);
  const prefs={rules:[],excludedBrands:[],excludedIngredients:[],excludedAllergens:[]};
  const result=rankProducts([
    {productId:1,name:'YOGURT A',brand:'A',category:'YOGURT',sizeLabel:'GR. 400',unitPrice:0.99,pricePerUnit:3.38,unit:'KG'},
    {productId:2,name:'YOGURT B',brand:'B',category:'YOGURT',sizeLabel:'GR. 500',unitPrice:1.45,pricePerUnit:2.90,unit:'KG'}
  ],prefs,{sortBy:'price_per_100'});
  assert.deepEqual(result.results.map(x=>x.productId),[1,2]);
});
test('multipacks multiply package size when comparing actual price',()=>{
  assert.equal(pricePer100({unitPrice:2.80,sizeLabel:'GR. 125 X 8 PZ.',pricePerUnit:2.80,unit:'KG'}),0.28);
  assert.equal(pricePer100({unitPrice:1.55,sizeLabel:'GR. 400 X 3 PZ.',pricePerUnit:1.29,unit:'KG'}),0.13);
  assert.equal(pricePer100({unitPrice:2.80,sizeLabel:'125 g x 8',unit:'KG'}),0.28);
});
test('counted eggs lack verified weight and must not report a price per 100 g',()=>{
  const egg={productId:5,name:'UOVA MEDIE PZ. 6',category:'UOVA',sizeLabel:'PZ. 6',unitPrice:1.50,pricePerUnit:1.50,unit:'KG'};
  assert.equal(pricePer100(egg),null);
  const r=rankProducts([egg],{rules:[]},{sortBy:'price_per_100'});
  assert.equal(r.results[0].priceUnit,null);
});
test('catalog per-kg information remains fallback when package mass is missing',()=>{
  assert.equal(pricePer100({unitPrice:2.50,pricePerUnit:5,unit:'KG'}),0.5);
});
