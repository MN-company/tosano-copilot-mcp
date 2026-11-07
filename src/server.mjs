/** LOCAL ONLY. MCP is reached through an authenticated OpenAI Secure MCP Tunnel. */
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod/v4';
import { getConfig } from './config.mjs';
import { openBrowserSession, sessionStatus, closeBrowserSession } from './session.mjs';
import { contextualConfig } from './context-hash.mjs';
import { TosanoClient, TosanoError } from './client.mjs';
import { checkProduct } from './preferences.mjs';
import { AgentStore } from './agent-db.mjs';
import { rankProducts } from './smart-search.mjs';
import { CartPlanner } from './cart-planner.mjs';
import {readObservedCartPath} from './cart-read-discovery.mjs';
import {readSiteDiscoveryStatus} from './site-api-discovery.mjs';
import { RELEASE, REQUIRED_TOOLS } from './release-contract.mjs';
import { SiteService, SiteActionPlanner } from './site-service.mjs';
import { ProfileManager, allergenCatalog } from './profile.mjs';
import { lookupBarcode } from './openfoodfacts.mjs';
import { searchRecipes, getRecipe, scaleRecipe } from './recipes.mjs';
import { RecipeStore, basketIngredients } from './recipe-db.mjs';
import { suggestPlan, mergeIngredients, subtractPantry, analyzeHabits, rankSubstitutes, nameTokens, budgetStatus, priceInsight } from './planning.mjs';
import { buildBasket } from './basket.mjs';
import { glycemicEstimate, basketGlycemic } from './glycemic.mjs';

const config=getConfig();
const store=new AgentStore();
const recipes=new RecipeStore(process.env.RECIPES_DB||undefined);
const PROFILE='default'; // v0.3 is intentionally a single-account, local-first service.
// Import the pre-v0.3 JSON preferences ONCE without deleting the original.
const legacyFile=path.join(os.homedir(),'.tosano-copilot','preferences.json');
try { const legacy=JSON.parse(await fs.readFile(legacyFile,'utf8'));store.importLegacyPreferences(PROFILE,legacy); }
catch(e) { if(e.code!=='ENOENT') console.error('Legacy preference file could not be imported; original preserved.'); }
let clientPromise;
async function getClient(){
  if(!clientPromise)clientPromise=openBrowserSession(config).then(context=>new TosanoClient(context.request,contextualConfig(context,config)))
    .catch(e=>{clientPromise=undefined;throw e;});
  return clientPromise;
}
async function verifiedClient(){
  const client=await getClient();
  const s=await client.verifySession();
  if(s.authenticatedWithTosano!=='verified')throw new TosanoError('Account identity not confirmed; use npm run doctor','AUTH_UNVERIFIED');
  return client;
}
// Memoize the IN-FLIGHT creation, not just the finished planner. Two concurrent
// MCP calls must never instantiate planners with independent mutation queues.
let plannerPromise;
async function getPlanner(){
  if(!plannerPromise)plannerPromise=verifiedClient()
    .then(client=>new CartPlanner(store,client,PROFILE))
    .catch(e=>{plannerPromise=undefined;throw e;});
  return plannerPromise;
}
let sitePlannerPromise;
async function getSitePlanner(){
  if(!sitePlannerPromise)sitePlannerPromise=verifiedClient()
    .then(client=>new SiteActionPlanner(store,client,PROFILE,prefs))
    .catch(e=>{sitePlannerPromise=undefined;throw e;});
  return sitePlannerPromise;
}
const prefs=()=>store.getPreferences(PROFILE);
const profile=new ProfileManager(store,PROFILE);
async function checkedProduct(slug){
  const product=await (await getClient()).productDetails(slug);
  store.recordPrices([product]);
  if(!product.label?.source && prefs().dietaryRules.length) product.off=await lookupBarcode(product.barcode);
  return {product,check:checkProduct(product,prefs())};
}
const textResult=(data,isError=false)=>({content:[{type:'text',text:JSON.stringify(data)}],isError});
function safeTool(fn){return async params=>{
  try{return textResult(await fn(params??{}));}
  catch(e){
    if(e instanceof TosanoError)return textResult({error:e.code,message:e.message,...(e.details?{details:e.details}:{})},true);
    console.error('Tosano tool error (details suppressed)');
    return textResult({error:'INVALID_OPERATION',message:'Invalid input or local store operation. No operation confirmed.'},true);
  }
};}
const read={readOnlyHint:true,openWorldHint:true};
const localRead={readOnlyHint:true,openWorldHint:false};
const write={readOnlyHint:false,openWorldHint:true};
const localWrite={readOnlyHint:false,openWorldHint:false};
const productId=z.number().int().positive();
// quantity: pieces; for TIPOLOGIA=Sfuso the weight in the product's selling unit (e.g. grams). options: {parameterName: value} from product.options.
const cartAddItem=z.object({productId,slug:z.string().min(3).max(200),quantity:z.number().positive().max(5000),options:z.record(z.string().max(60),z.string().max(80)).optional()});
async function searchAndRank({query,category,excludeTerms=[],mustIncludeTerms=[],includeCategory,sortBy='preference',brand,limit=12}){
  const client=await getClient();
  const pref=prefs();
  const found=await client.search(query,{pageSize:60});
  const products=[...found.products];
  const matchedPrefs=pref.rules.filter(r=>r.kind==='preferred_brand'&&(r.category==='*'||String(category??query).toLocaleLowerCase('it').includes(r.category)));
  for(const prefBrand of matchedPrefs.slice(0,2)){
    if(products.some(p=>p.brand?.toLocaleLowerCase('it')===prefBrand.value.toLocaleLowerCase('it')))continue;
    const followup=await client.search(`${query} ${prefBrand.value}`,{pageSize:24});
    products.push(...followup.products);
  }
  store.cacheProducts(products,client.getContextKey());store.recordPrices(products);
  return {...rankProducts(products,pref,{category:category??query,excludeTerms,mustIncludeTerms,includeCategory,sortBy,brand,limit}),
    source:'live_tosano_search',contextBound:true,allergenDataMayBeMissing:true};
}
function makeServer(){
  const server=new McpServer({name:'tosano-copilot',version:RELEASE.version});
  server.registerTool('tosano_session_status',{description:'Check account identity without disclosing cookies or user data.',annotations:read},
    safeTool(async()=>sessionStatus(await getClient())));
  server.registerTool('tosano_release_info',{description:'Report active MCP release, required tool contract, and deployment status without exposing private account data.',annotations:localRead},
    safeTool(async()=>({release:RELEASE,requiredTools:REQUIRED_TOOLS,preferencesEngine:'sqlite-fts5',cartWritesEnabled:config.allowCartWrites,writeFlags:{lists:config.allowListWrites,cart:config.allowCartWrites,orders:config.allowOrderWrites,checkout:config.allowCheckout},cartReadEndpoint:(config.cartReadPath||(await readObservedCartPath()))?'observed':'not_observed'})));
  server.registerTool('tosano_agent_status',{description:'Local agent SQLite and FTS5 readiness, no private DB contents.',annotations:localRead},
    safeTool(async()=>store.diagnostics()));
  server.registerTool('tosano_search',{description:'Live Tosano product search. Results are catalog observations, not proof of stock or allergen safety.',
    inputSchema:{query:z.string().min(1).max(150),page:z.number().int().min(1).max(1000).optional(),pageSize:z.number().int().min(1).max(60).optional(),promo:z.boolean().optional()},annotations:read},
  safeTool(async({query,page,pageSize,promo})=>{
    const client=await getClient(),r=await client.search(query,{page,pageSize,promo});
    store.cacheProducts(r.products,client.getContextKey());store.recordPrices(r.products);return r;
  }));
  server.registerTool('tosano_smart_search',{description:'Preferred-brand-aware live product comparison; filters non-equivalent products, computes normalized price per 100 g/ml when valid and marks dietary unknowns. Never modifies cart.',
    inputSchema:{query:z.string().min(1).max(150),category:z.string().max(80).optional(),brand:z.string().max(100).optional(),
      excludeTerms:z.array(z.string().max(80)).max(12).optional(),
      mustIncludeTerms:z.array(z.string().max(80)).max(12).optional(),includeCategory:z.string().max(100).optional(),sortBy:z.enum(['preference','price_per_100','relevance']).optional(),
      limit:z.number().int().min(1).max(60).optional()},annotations:read},
  safeTool(searchAndRank));
  server.registerTool('tosano_cached_search',{description:'Fast SQLite FTS5 local search only: explicitly cached/possibly stale, NOT live stock or current price confirmation.',
    inputSchema:{query:z.string().min(1).max(150),maxAgeMinutes:z.number().int().min(0).max(43200).optional(),limit:z.number().int().min(1).max(50).optional()},annotations:localRead},
  safeTool(async({query,maxAgeMinutes,limit})=>({source:'local_fts5_cache',live:false,
    results:store.searchProducts(query,(await getClient()).getContextKey(),{maxAgeMinutes,limit})})));
  server.registerTool('tosano_product_details',{description:'Read current product details. Unknown ingredient/allergen fields are NOT safety clearance.',
    inputSchema:{slug:z.string().min(3).max(200)},annotations:read},
  safeTool(async({slug})=>{const client=await getClient(),p=await client.productDetails(slug);
    store.cacheProducts([p],client.getContextKey());return p;}));
  server.registerTool('tosano_get_cart',{description:'Read current cart, quantities, subtotal, packaging, delivery, total. Requires a GET route verified from the real site. Never mutates cart.',annotations:read},
    safeTool(async()=> (await verifiedClient()).readCart()));
  server.registerTool('tosano_get_preferences',{description:'Get user-authorized saved brand/category preferences and dietary rules. Returns local rules.',annotations:localRead},
    safeTool(async()=>prefs()));
  server.registerTool('tosano_set_preferences',{description:'Legacy compatibility. Replace specific global exclusion arrays after user expressly instructs; use tosano_preference_upsert for scoped brands. Dietary rules are personal.',
    inputSchema:{excludedBrands:z.array(z.string().max(99)).max(100).optional(),excludedIngredients:z.array(z.string().max(99)).max(100).optional(),
      excludedAllergens:z.array(z.string().max(99)).max(100).optional(),blockPossibleTraces:z.boolean().optional(),
      shoppingPriority:z.enum(['value','price','nutrition']).optional(),userExplicitlyRequested:z.literal(true),dietaryDataConsent:z.boolean().optional()},annotations:localWrite},
    safeTool(async({userExplicitlyRequested,dietaryDataConsent,...patch})=>{
      if((patch.excludedAllergens?.length||patch.excludedIngredients?.length)&&dietaryDataConsent!==true)
        throw new TosanoError('Explicit consent required for dietary data','DIETARY_CONSENT_REQUIRED');
      return store.patchLegacyPreferences(PROFILE,patch);
    }));
  server.registerTool('tosano_preference_upsert',{description:'Save one explicit user preference. Do not infer allergens, allergies or brands silently. For allergens user must explicitly consent to local persistence.',
    inputSchema:{category:z.string().min(1).max(80).default('*'),kind:z.enum(['preferred_brand','excluded_brand','excluded_ingredient','excluded_allergen','preferred_format']),
      value:z.string().min(1).max(100),strength:z.enum(['soft','hard']).optional(),userExplicitlyRequested:z.literal(true),
      dietaryDataConsent:z.boolean().optional()},annotations:localWrite},
    safeTool(async({category,kind,value,strength,dietaryDataConsent})=>{
      if(['excluded_allergen','excluded_ingredient'].includes(kind)&&dietaryDataConsent!==true)
        throw new TosanoError('Explicit user consent to store dietary exclusions is required','DIETARY_CONSENT_REQUIRED');
      return {saved:true,rule:store.upsertRule(PROFILE,{category,kind,value,strength})};
    }));
  server.registerTool('tosano_preference_remove',{description:'Remove an explicit preference rule by ID, after user requests it.',
    inputSchema:{ruleId:z.string().uuid(),userExplicitlyRequested:z.literal(true)},annotations:localWrite},
    safeTool(async({ruleId})=>store.removeRule(PROFILE,ruleId)));
  server.registerTool('tosano_check_product',{description:'Check a live product against brand rules and saved allergies/intolerances using the label text published on the product page; when the site has no label, also Open Food Facts by barcode (second source, never clearance). Verdicts: bloccato / da_verificare / nessun_conflitto_con_le_tue_regole (never "safe").',
    inputSchema:{slug:z.string().min(3).max(200)},annotations:read},
    safeTool(async({slug})=>checkedProduct(slug)));
  // ---- profile: onboarding, permissions, allergies/intolerances
  server.registerTool('tosano_profile_status',{description:'Onboarding progress and next question, agent permissions, saved allergies/intolerances, brand rules. Call at the start of a shopping session.',annotations:localRead},
    safeTool(async()=>profile.status()));
  server.registerTool('tosano_allergen_catalog',{description:'Allergens/intolerances the safety engine knows: the 14 of EU Reg. 1169/2011 Annex II plus heuristic ones (nichel, istamina, lattosio, polioli). Use the key in tosano_dietary_rule_add.',annotations:localRead},
    safeTool(async()=>({allergens:allergenCatalog()})));
  server.registerTool('tosano_dietary_rule_add',{description:'Save or UPGRADE an allergy/intolerance (tightens protection, immediate). severity: grave (traces and incomplete labels block) or intolleranza. Requires the user\'s explicit consent to store health data locally.',
    inputSchema:{key:z.string().min(2).max(40),severity:z.enum(['grave','intolleranza']),dietaryDataConsent:z.literal(true),userExplicitlyRequested:z.literal(true)},annotations:localWrite},
    safeTool(async({key,severity})=>profile.addDietaryRule(key,severity)));
  server.registerTool('tosano_permissions_set',{description:'Set agent permissions. Stricter values apply immediately; looser ones return requiresApproval and must go through tosano_profile_prepare_change. lists: allowed|denied; cart/orders/checkout: ask|denied (never autonomous); maxOrderTotal: euros or null.',
    inputSchema:{lists:z.enum(['allowed','denied']).optional(),cart:z.enum(['ask','denied']).optional(),orders:z.enum(['ask','denied']).optional(),
      checkout:z.enum(['ask','denied']).optional(),maxOrderTotal:z.number().positive().max(2000).nullable().optional(),userExplicitlyRequested:z.literal(true)},annotations:localWrite},
    safeTool(async({userExplicitlyRequested,...patch})=>profile.setPermissions(patch)));
  server.registerTool('tosano_onboarding_step_done',{description:'Mark an onboarding step (permessi, marche, intolleranze) done after the user answered or chose to skip it.',
    inputSchema:{step:z.enum(['permessi','marche','intolleranze']),userExplicitlyRequested:z.literal(true)},annotations:localWrite},
    safeTool(async({step})=>profile.markStep(step)));
  server.registerTool('tosano_profile_prepare_change',{description:'READ-ONLY step for changes that LOOSEN protection: dietary_remove(key), dietary_downgrade(key: grave->intolleranza), permissions(permissions), product_confirm(slug: user read the physical label and accepts a da_verificare product), member_remove(memberId), member_rule_remove(memberId,key), member_rule_downgrade(memberId,key). Returns summary + confirmationPhrase; wait for explicit approval in a later message.',
    inputSchema:{type:z.enum(['dietary_remove','dietary_downgrade','permissions','product_confirm','member_remove','member_rule_remove','member_rule_downgrade']),memberId:z.string().max(20).optional(),key:z.string().max(40).optional(),slug:z.string().min(3).max(200).optional(),
      permissions:z.object({lists:z.enum(['allowed','denied']).optional(),cart:z.enum(['ask','denied']).optional(),orders:z.enum(['ask','denied']).optional(),
        checkout:z.enum(['ask','denied']).optional(),maxOrderTotal:z.number().positive().max(2000).nullable().optional()}).optional()},annotations:localRead},
    safeTool(async({type,key,slug,permissions,memberId})=>{
      const product=type==='product_confirm'?await checkedProduct(slug):null;
      return profile.prepareChange({type,key,permissions,memberId},product&&{...product.product,check:product.check});
    }));
  server.registerTool('tosano_profile_commit_change',{description:'Apply a prepared profile change once, only after the user explicitly approved it in a later message.',
    inputSchema:{planId:z.string().uuid(),confirmationPhrase:z.string().min(1).max(30),userExplicitlyApproved:z.literal(true)},annotations:localWrite},
    safeTool(async({planId,confirmationPhrase})=>profile.commitChange(planId,confirmationPhrase)));
  server.registerTool('tosano_profile_audit',{description:'Local log of profile/safety changes (who changed what, when).',annotations:localRead},
    safeTool(async()=>({log:store.auditLog(PROFILE)})));

  server.registerTool('tosano_site_discovery_status',{description:'Read privacy-sanitized GET endpoint metadata gathered from the authenticated Docker browser. Discovery only; does not read or modify native site lists.',annotations:localRead},
    safeTool(async()=>readSiteDiscoveryStatus()));
  server.registerTool('tosano_prepare_cart_change',{description:'READ-ONLY step: show proposed add/update/remove and cart baseline. Requires an observed fresh GET cart endpoint. Does not mutate. ALWAYS request explicit user approval before commit.',
    inputSchema:{action:z.enum(['add','set_quantity','remove']),mode:z.enum(['ensure_minimum','increment']).optional(),
      addItems:z.array(cartAddItem).min(1).max(20).optional(),
      quantityItems:z.array(z.object({itemId:productId,quantity:z.number().positive().max(100)})).min(1).max(20).optional(),
      removeItems:z.array(z.object({itemId:productId,productId})).min(1).max(20).optional(),
      idempotencyKey:z.string().min(1).max(160).optional()},annotations:read},
    safeTool(async({action,mode,addItems,quantityItems,removeItems,idempotencyKey})=>{
      if(prefs().permissions.cart==='denied')throw new TosanoError("Agent permission 'cart' is denied in the user profile",'PERMISSION_DENIED');
      const items=action==='add'?addItems:action==='set_quantity'?quantityItems:removeItems;
      return (await getPlanner()).prepare({action,mode,items},prefs(),{idempotencyKey});
    }));
  server.registerTool('tosano_commit_cart_change',{description:'WRITES TO CART (never checkout). Call only AFTER the user explicitly approves the displayed exact plan in a later message; requires plan ID, approval phrase, fresh unchanged cart and local write flag.',
    inputSchema:{planId:z.string().uuid(),approvalPhrase:z.string().min(1).max(30),userExplicitlyApproved:z.literal(true)},annotations:write},
    safeTool(async({planId,approvalPhrase})=>{
      if(prefs().permissions.cart==='denied')throw new TosanoError("Agent permission 'cart' is denied in the user profile",'PERMISSION_DENIED');
      await verifiedClient();
      return (await getPlanner()).commit(planId,approvalPhrase,prefs(),{allowCartWrites:config.allowCartWrites});
    }));
  server.registerTool('tosano_cart_reconcile',{description:'Read-only reconciliation of an earlier plan with a fresh cart snapshot, including per-product results. Does not retry any write and cannot prove historical causation.',
    inputSchema:{planId:z.string().uuid()},annotations:read},
    safeTool(async({planId})=>(await getPlanner()).reconcile(planId)));
  server.registerTool('tosano_cart_plan_status',{description:'Read result of a previous plan without reapplying it (important after network timeouts).',
    inputSchema:{planId:z.string().uuid()},annotations:localRead},
    safeTool(async({planId})=>store.getCartPlan(PROFILE,planId)??{error:'PLAN_NOT_FOUND'}));
  // ---- v0.4: site-native features (endpoints observed in the public web bundle)
  const site=async()=>new SiteService(await verifiedClient());
  const siteW=async(fam='lists')=>{if(prefs().permissions[fam]==='denied')throw new TosanoError(`Agent permission '${fam}' is denied in the user profile`,'PERMISSION_DENIED');return site();};
  const listId=z.number().int().positive(), orderId=z.number().int().positive();
  const siteQty=z.number().positive().max(100);
  server.registerTool('tosano_site_lists',{description:'Read the user\'s NATIVE LaTuaSpesa shopping lists (source=tosano_site), distinct from local tosano_lists.',
    inputSchema:{page:z.number().int().min(1).max(100).optional()},annotations:read},
    safeTool(async({page})=>(await site()).lists({page})));
  server.registerTool('tosano_site_list_get',{description:'Read one native site list with items, quantities and unavailable items.',
    inputSchema:{listId},annotations:read},safeTool(async({listId})=>(await site()).list(listId)));
  server.registerTool('tosano_site_list_create',{description:'Create a native site list. Only when the user asks.',
    inputSchema:{name:z.string().min(1).max(100),userExplicitlyRequested:z.literal(true)},annotations:write},
    safeTool(async({name})=>(await siteW()).createList(name)));
  server.registerTool('tosano_site_list_rename',{description:'Rename a native site list. Only when the user asks.',
    inputSchema:{listId,name:z.string().min(1).max(100),userExplicitlyRequested:z.literal(true)},annotations:write},
    safeTool(async({listId,name})=>(await siteW()).renameList(listId,name)));
  server.registerTool('tosano_site_list_set_default',{description:'Make a native site list the default one.',
    inputSchema:{listId,userExplicitlyRequested:z.literal(true)},annotations:write},
    safeTool(async({listId})=>(await siteW()).setDefaultList(listId)));
  server.registerTool('tosano_site_list_add_items',{description:'Add products (productId from search) to a native site list. Does not touch the cart.',
    inputSchema:{listId,items:z.array(z.object({productId,quantity:siteQty})).min(1).max(30),userExplicitlyRequested:z.literal(true)},annotations:write},
    safeTool(async({listId,items})=>(await siteW()).addToList(listId,items)));
  server.registerTool('tosano_site_list_set_quantity',{description:'Set absolute quantity of one native list line (itemId from tosano_site_list_get).',
    inputSchema:{listId,itemId:productId,quantity:siteQty,userExplicitlyRequested:z.literal(true)},annotations:write},
    safeTool(async({listId,itemId,quantity})=>(await siteW()).setListQuantity(listId,itemId,quantity)));
  server.registerTool('tosano_site_list_remove_items',{description:'Remove lines from a native site list (not from the cart).',
    inputSchema:{listId,items:z.array(z.object({itemId:productId,productId})).min(1).max(30),userExplicitlyRequested:z.literal(true)},annotations:write},
    safeTool(async({listId,items})=>(await siteW()).removeFromList(listId,items)));
  server.registerTool('tosano_purchase_context',{description:'Current pickup/delivery mode, location and selected timeslot from a fresh cart read.',annotations:read},
    safeTool(async()=>(await site()).purchaseContext()));
  server.registerTool('tosano_timeslots',{description:'Available pickup/delivery timeslots for the current location. Use timeslotId+date with tosano_prepare_site_action kind=select_timeslot.',
    inputSchema:{showClosed:z.boolean().optional()},annotations:read},safeTool(async({showClosed})=>(await site()).timeslots({showClosed})));
  server.registerTool('tosano_stores',{description:'List IperTosano stores.',annotations:read},safeTool(async()=>(await site()).stores()));
  server.registerTool('tosano_addresses',{description:'Pickup points (drive/locker) or saved home-delivery addresses usable for the cart; labels and city only.',
    inputSchema:{addressType:z.enum(['drive','home','locker']).optional()},annotations:read},safeTool(async({addressType})=>(await site()).addresses(addressType)));
  server.registerTool('tosano_delivery_fee',{description:'Home delivery fee table.',annotations:read},safeTool(async()=>(await site()).deliveryFee()));
  server.registerTool('tosano_categories',{description:'Catalog category tree, or one category by slug.',
    inputSchema:{slug:z.string().min(2).max(120).optional(),depth:z.number().int().min(1).max(3).optional()},annotations:read},
    safeTool(async({slug,depth})=>slug?(await site()).categoryBySlug(slug):(await site()).categories(depth)));
  server.registerTool('tosano_orders',{description:'Order history: status, timeslot, total, whether cancellable/editable.',
    inputSchema:{page:z.number().int().min(1).max(100).optional(),pageSize:z.number().int().min(1).max(30).optional()},annotations:read},
    safeTool(async({page,pageSize})=>(await site()).orders({page,pageSize})));
  server.registerTool('tosano_order_get',{description:'One order with its items.',inputSchema:{orderId},annotations:read},
    safeTool(async({orderId})=>(await site()).order(orderId)));
  server.registerTool('tosano_checkout_preview',{description:'READ-ONLY: cart, slot, location, totals and payment types offered, plus blockers. Never orders.',annotations:read},
    safeTool(async()=>(await site()).checkoutPreview()));
  server.registerTool('tosano_payment_methods',{description:'Saved payment methods for a payment type: ids and masked labels only.',
    inputSchema:{paymentTypeId:productId},annotations:read},safeTool(async({paymentTypeId})=>(await site()).paymentMethods(paymentTypeId)));
  server.registerTool('tosano_cart_set_substitution',{description:'Allow or forbid the store to substitute one cart line if unavailable (site toggle "accetta alternative"). Only when the user asks.',
    inputSchema:{itemId:productId,accept:z.boolean(),userExplicitlyRequested:z.literal(true)},annotations:write},
    safeTool(async({itemId,accept})=>(await siteW('cart')).setSubstitution(itemId,accept)));
  server.registerTool('tosano_gift_certificates',{description:'Gift certificates / coupons available on the account.',annotations:read},
    safeTool(async()=>(await site()).giftCertificates()));
  server.registerTool('tosano_gift_code',{description:'Apply or remove a coupon/gift code on the cart, only with a code the user gave or chose. Re-reads the cart total.',
    inputSchema:{code:z.string().min(3).max(40),action:z.enum(['apply','remove']),userExplicitlyRequested:z.literal(true)},annotations:write},
    safeTool(async({code,action})=>(await siteW('cart')).giftCode(code,action)));
  server.registerTool('tosano_offers',{description:'Products currently on promotion matching a query, ranked by saved preferences and comparable price.',
    inputSchema:{query:z.string().min(1).max(150),limit:z.number().int().min(1).max(40).optional()},annotations:read},
    safeTool(async({query,limit=20})=>{const client=await getClient(),r=await client.search(query,{pageSize:60,promo:true});
      store.cacheProducts(r.products,client.getContextKey());
      return {...rankProducts(r.products,prefs(),{category:query,sortBy:'price_per_100',limit}),source:'live_tosano_promo_search'};}));
  server.registerTool('tosano_packaging_options',{description:'Shopping bag / packaging types the store offers for the order.',annotations:read},
    safeTool(async()=>(await site()).packagingOptions()));
  server.registerTool('tosano_my_products',{description:'The user\'s "I miei preferiti" / frequently bought products on LaTuaSpesa. Base for "rifai la solita spesa".',
    inputSchema:{page:z.number().int().min(1).max(50).optional()},annotations:read},safeTool(async({page})=>(await site()).myProducts({page})));
  server.registerTool('tosano_category_products',{description:'Products of a catalog category (categoryId from tosano_categories); promo=true lists that department\'s current offers (the site\'s volantino is built the same way).',
    inputSchema:{categoryId:productId,promo:z.boolean().optional(),page:z.number().int().min(1).max(100).optional()},annotations:read},
    safeTool(async({categoryId,promo,page})=>(await site()).categoryProducts(categoryId,{promo,page})));
  server.registerTool('tosano_purchase_restrictions',{description:'Cart products that cannot be delivered/picked up on the selected day (site "dayLock" rules). Check after changing timeslot and before checkout.',annotations:read},
    safeTool(async()=>(await site()).purchaseRestrictions()));
  server.registerTool('tosano_cart_info',{description:'Current shopping-bag type and note for the picker on the cart.',annotations:read},safeTool(async()=>(await site()).cartInfo()));
  server.registerTool('tosano_cart_packaging_set',{description:'Choose the shopping bag/packaging type (productId from tosano_packaging_options). Only when the user asks.',
    inputSchema:{productId,userExplicitlyRequested:z.literal(true)},annotations:write},safeTool(async({productId})=>(await siteW('cart')).setPackaging(productId)));
  server.registerTool('tosano_cart_note_set',{description:'Set the note for the person preparing the order (max 400 chars, e.g. "banane poco mature"). Only with text the user dictated or approved. Empty string clears it.',
    inputSchema:{text:z.string().max(400),userExplicitlyRequested:z.literal(true)},annotations:write},safeTool(async({text})=>(await siteW('cart')).setOrderComment(text)));
  server.registerTool('tosano_orders_payment_pending',{description:'Orders whose payment failed and can be retried or paid with another method.',annotations:read},
    safeTool(async()=>(await site()).ordersPaymentPending()));
  server.registerTool('tosano_prebilled_amount',{description:'Amount that will be pre-authorized on the payment method for this cart (or an order), higher than the estimate when there are weighed products.',
    inputSchema:{paymentTypeId:productId,orderId:productId.optional()},annotations:read},safeTool(async({paymentTypeId,orderId})=>(await site()).prebilledAmount(paymentTypeId,orderId)));
  // ---- recipes (real, attributed), basket from ingredients, glycemic estimate
  const ingredientSchema=z.object({name:z.string().min(1).max(120),quantity:z.number().positive().max(10000).optional(),
    unit:z.enum(['g','kg','ml','cl','dl','l','cucchiaio','cucchiaino','bicchiere','tazza','spicchio','pizzico','mazzetto','foglia','fetta','confezione','vasetto','scatola','lattina']).optional(),
    optional:z.boolean().optional(),pantry:z.boolean().optional()});
  async function glycemicFor(slug){const p=await (await getClient()).productDetails(slug);return {...glycemicEstimate(p),slug};}
  async function lowGlycemicChooser(candidates){
    let best=null;
    for(const c of candidates.filter(c=>c.compatibility!=='blocked'&&c.slug).slice(0,3)){
      try{const g=await glycemicFor(c.slug);const rank={trascurabile:0,basso:1,medio:2,non_stimabile:3,alto:4}[g.band];
        if(!best||rank<best.rank||(rank===best.rank&&(g.glycemicLoad??99)<(best.gl??99)))best={c,rank,gl:g.glycemicLoad};}catch{}
    }
    return best?.c??null;
  }
  async function basketFrom(ingredients,{includePantry=false,lowGlycemic=false}={}){
    const out=await buildBasket(ingredients,{includePantry,choose:lowGlycemic?lowGlycemicChooser:null,
      search:q=>searchAndRank({query:q,category:q,limit:3})});
    if(lowGlycemic)out.glycemic=basketGlycemic(await Promise.all(out.lines.filter(l=>l.proposed?.slug).map(l=>glycemicFor(l.proposed.slug).catch(()=>({band:'non_stimabile',name:l.proposed.name})))));
    return out;
  }
  const eatersSchema=z.array(z.string().max(20)).min(1).max(13).optional().describe('Who eats: "io" and/or household member ids. Default: whole household.');
  // Local DB first (Wikibooks + TheMealDB + personal recipes); live Wikibooks when the DB is empty or a title is not an id.
  async function loadRecipe(idOrTitle){
    const local=recipes.get(idOrTitle,PROFILE);
    if(local)return local;
    return getRecipe(idOrTitle.replace(/^wikibooks:/,''));
  }
  const ruleKeys=(eaters=null)=>store.householdRules(PROFILE,eaters).map(r=>r.key);
  server.registerTool('tosano_recipe_search',{description:'Search REAL recipes in the local recipe database (Italian Wikibooks CC BY-SA, TheMealDB in English, the user\'s own saved recipes). Use for "fammi una ricetta": never invent a recipe; present title, source, link and licence. Recipes whose ingredients conflict with the profile allergy/intolerance rules are hidden by default (hiddenByYourRules says how many); recipe allergens are a pre-filter, products are checked again on their labels when the basket is built. Empty query = random suggestions. English recipes (lang=en): translate when presenting.',
    inputSchema:{query:z.string().max(120).optional(),diet:z.enum(['vegetariano','vegano','senza_glutine_negli_ingredienti']).optional(),source:z.enum(['wikibooks','themealdb','personale']).optional(),
      includeConflicting:z.boolean().optional(),eaters:eatersSchema,limit:z.number().int().min(1).max(20).optional()},annotations:{readOnlyHint:true,openWorldHint:true}},
    safeTool(async({query='',diet,source,includeConflicting,eaters,limit})=>{
      if(!recipes.stats().total){const live=query.trim()?await searchRecipes(query,{limit}):{results:[]};return {...live,note:'Database locale vuoto: risultati live da Wikibooks. Esegui npm run recipes:import.'};}
      return recipes.search({query,diet,source,limit,profileId:PROFILE,excludeAllergens:includeConflicting?[]:ruleKeys(eaters)});
    }));
  server.registerTool('tosano_recipe_get',{description:'Full recipe by id (from tosano_recipe_search) or Wikibooks title: servings, parsed ingredients (quantity, unit, optional, pantry; nameIt for English recipes), preparation, possibleAllergens, diet tags, source URL and licence. servings rescales quantities.',
    inputSchema:{id:z.string().min(1).max(200),servings:z.number().int().min(1).max(20).optional()},annotations:{readOnlyHint:true,openWorldHint:true}},
    safeTool(async({id,servings})=>{const r=scaleRecipe(await loadRecipe(id),servings);
      const conflicts=(r.possibleAllergens??[]).filter(k=>ruleKeys().includes(k));
      return conflicts.length?{...r,warning:'Questa ricetta contiene ingredienti in conflitto con le tue regole: '+conflicts.join(', ')}:r;}));
  server.registerTool('tosano_basket_from_recipe',{description:'Turn a real recipe (id or Wikibooks title) into Tosano product proposals (packs computed from quantities, preferences and allergy rules applied) plus cartPlanInput for tosano_prepare_cart_change. Read-only. lowGlycemic picks the lowest estimated glycemic impact among comparable products.',
    inputSchema:{id:z.string().min(1).max(200),servings:z.number().int().min(1).max(20).optional(),includePantry:z.boolean().optional(),lowGlycemic:z.boolean().optional()},annotations:read},
    safeTool(async({id,servings,includePantry,lowGlycemic})=>{const r=scaleRecipe(await loadRecipe(id),servings);
      const untranslated=r.ingredients.filter(i=>r.lang==='en'&&!i.nameIt).map(i=>i.name);
      return {recipe:{id:r.id??null,title:r.title,servings:r.servings,url:r.url,source:r.source},
        ...(untranslated.length?{untranslatedIngredients:untranslated,note:'Ingredienti in inglese senza traduzione: traducili e usa tosano_basket_from_ingredients se mancano nel carrello.'}:{}),
        ...(await basketFrom(basketIngredients(r),{includePantry,lowGlycemic}))};}));
  server.registerTool('tosano_recipe_save',{description:'Save a recipe the user dictated, photographed or owns into their personal collection (private to this profile). Pass ingredients as text lines ("200 g di riso") or objects. Pass id (personale:...) to update one of their recipes. Do not save text copied from websites that forbid reuse.',
    inputSchema:{id:z.string().max(80).optional(),title:z.string().min(1).max(150),servings:z.number().int().min(1).max(30).optional(),
      ingredients:z.array(z.union([z.string().min(1).max(200),ingredientSchema])).min(1).max(40),preparation:z.string().max(5000).optional(),
      categories:z.array(z.string().max(60)).max(6).optional(),userExplicitlyRequested:z.literal(true)},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
    safeTool(async(x)=>({saved:true,...recipes.savePersonal(PROFILE,x)})));
  server.registerTool('tosano_recipe_delete',{description:'Delete one of the user\'s personal recipes (id personale:...). Only when the user asked.',
    inputSchema:{id:z.string().startsWith('personale:').max(80),userExplicitlyRequested:z.literal(true)},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}},
    safeTool(async({id})=>recipes.deletePersonal(id,PROFILE)));
  server.registerTool('tosano_recipe_sources',{description:'Recipe database status: recipes per source, average quality, last import, licences.',annotations:{readOnlyHint:true,openWorldHint:false}},
    safeTool(async()=>recipes.stats()));
  server.registerTool('tosano_basket_from_ingredients',{description:'Turn an ingredient list into Tosano product proposals and cartPlanInput. Use it for a photo (fridge, handwritten list, cookbook page, receipt) or text: YOU read the image/text and pass the ingredients. Read-only.',
    inputSchema:{ingredients:z.array(ingredientSchema).min(1).max(30),includePantry:z.boolean().optional(),lowGlycemic:z.boolean().optional()},annotations:read},
    safeTool(async({ingredients,includePantry,lowGlycemic})=>basketFrom(ingredients,{includePantry,lowGlycemic})));
  server.registerTool('tosano_glycemic_check',{description:'ESTIMATED glycemic impact (glycemic load per typical portion: basso/medio/alto) for one product (slug), several (slugs) or the whole cart (cart=true), from Tosano nutrition labels and category GI tables. Not a measurement, not medical advice.',
    inputSchema:{slug:z.string().min(3).max(200).optional(),slugs:z.array(z.string().min(3).max(200)).max(40).optional(),cart:z.boolean().optional()},annotations:read},
    safeTool(async({slug,slugs,cart})=>{
      if(slug)return glycemicFor(slug);
      let list=slugs??[];
      if(cart){const c=await (await verifiedClient()).readCart();list=c.items.map(i=>i.slug).filter(Boolean);}
      if(!list.length)throw new TosanoError('Provide slug, slugs or cart=true','INVALID_ARGUMENT');
      const est=[];for(const s of list.slice(0,40)){try{est.push(await glycemicFor(s));}catch{est.push({slug:s,band:'non_stimabile'});}}
      return {items:est,summary:basketGlycemic(est)};
    }));
  // ---- household (family profiles)
  server.registerTool('tosano_household',{description:'Household members and their allergy/intolerance rules. Every member\'s rules protect EVERY product check, cart and order (strictest severity wins); recipes and meal plans can be narrowed to who eats (eaters).',annotations:localRead},
    safeTool(async()=>({members:profile.members(),combinedRules:store.householdRules(PROFILE)})));
  server.registerTool('tosano_household_member_add',{description:'Add a household member (e.g. "Luca") with optional allergy/intolerance rules. Tightens protection, immediate. Requires explicit consent to store health data.',
    inputSchema:{name:z.string().min(1).max(40),rules:z.array(z.object({key:z.string().min(2).max(40),severity:z.enum(['grave','intolleranza'])})).max(20).optional(),
      dietaryDataConsent:z.boolean().optional(),userExplicitlyRequested:z.literal(true)},annotations:localWrite},
    safeTool(async({name,rules=[],dietaryDataConsent})=>profile.addMember(name,rules,dietaryDataConsent===true)));
  server.registerTool('tosano_household_rule_add',{description:'Add or upgrade an allergy/intolerance for a member (tightens, immediate). To remove or downgrade use tosano_profile_prepare_change member_rule_remove/member_rule_downgrade.',
    inputSchema:{memberId:z.string().max(20),key:z.string().min(2).max(40),severity:z.enum(['grave','intolleranza']),dietaryDataConsent:z.literal(true),userExplicitlyRequested:z.literal(true)},annotations:localWrite},
    safeTool(async({memberId,key,severity})=>profile.addMemberRule(memberId,key,severity)));
  // ---- pantry
  const pantryItem=z.object({name:z.string().min(1).max(120),quantity:z.number().positive().max(100000).optional(),unit:z.enum(['g','kg','ml','l','pz','confezione']).optional()});
  server.registerTool('tosano_pantry_list',{description:'What the user has at home (dispensa). Meal plans subtract it from the shopping list.',annotations:localRead},
    safeTool(async()=>({items:store.pantryList(PROFILE)})));
  server.registerTool('tosano_pantry_set',{description:'Add or update pantry items (what the user says they have, or what YOU read from a photo of fridge/pantry and the user confirmed). No quantity = "ce l\'ho".',
    inputSchema:{items:z.array(pantryItem).min(1).max(60),userExplicitlyRequested:z.literal(true)},annotations:localWrite},
    safeTool(async({items})=>({items:store.pantrySet(PROFILE,items,'utente')})));
  server.registerTool('tosano_pantry_remove',{description:'Remove finished items from the pantry.',inputSchema:{names:z.array(z.string().min(1).max(120)).min(1).max(60),userExplicitlyRequested:z.literal(true)},annotations:localWrite},
    safeTool(async({names})=>store.pantryRemove(PROFILE,names)));
  server.registerTool('tosano_pantry_add_from_order',{description:'Add the items of a delivered order to the pantry (names and quantities as ordered). Use when the user says the shopping arrived.',
    inputSchema:{orderId,userExplicitlyRequested:z.literal(true)},annotations:write},
    safeTool(async({orderId})=>{const o=await (await site()).order(orderId);
      const items=o.items.filter(i=>i.name).map(i=>({name:i.name,quantity:i.quantity??undefined,unit:'pz',productId:i.productId}));
      if(!items.length)throw new TosanoError('Order has no readable items','ORDER_ITEMS_UNAVAILABLE');
      return {added:items.length,items:store.pantrySet(PROFILE,items,'ordine '+orderId)};}));
  // ---- recent order details (cached briefly; read-only)
  let ordersCache=null;
  async function recentOrders(n=10){
    if(ordersCache&&Date.now()-ordersCache.at<10*60e3&&ordersCache.n>=n)return ordersCache.list.slice(0,n);
    const s=await site(),list=(await s.orders({pageSize:Math.min(n,30)})).orders.slice(0,n),out=[];
    for(const o of list){try{out.push({...o,items:(await s.order(o.orderId)).items});}catch{out.push({...o,items:[]});}}
    ordersCache={at:Date.now(),n,list:out};return out;
  }
  // ---- meal plan
  server.registerTool('tosano_meal_plan_suggest',{description:'Propose a weekly menu of REAL recipes from the local database: distinct, varied, compatible with the household rules of who eats. Returns recipe ids; show the plan, let the user swap dishes, then call tosano_meal_plan_shopping.',
    inputSchema:{days:z.number().int().min(1).max(14).optional(),mealsPerDay:z.union([z.literal(1),z.literal(2)]).optional(),diet:z.enum(['vegetariano','vegano','senza_glutine_negli_ingredienti']).optional(),
      query:z.string().max(120).optional(),eaters:eatersSchema},annotations:localRead},
    safeTool(async({days=7,mealsPerDay=1,diet,query='',eaters})=>suggestPlan(recipes,{days,mealsPerDay,diet,query,eaters,profileId:PROFILE,excludeAllergens:ruleKeys(eaters)})));
  server.registerTool('tosano_meal_plan_shopping',{description:'ONE shopping list for several recipes: scales each to its servings, sums the same ingredients across recipes, removes what is in the pantry, then proposes Tosano products (allergy rules applied) with cartPlanInput and a budget check. Read-only.',
    inputSchema:{recipes:z.array(z.object({id:z.string().min(1).max(200),servings:z.number().int().min(1).max(20).optional()})).min(1).max(21),
      usePantry:z.boolean().optional(),includePantry:z.boolean().optional(),lowGlycemic:z.boolean().optional()},annotations:read},
    safeTool(async({recipes:list,usePantry=true,includePantry=false,lowGlycemic=false})=>{
      const loaded=[];for(const r of list)loaded.push(scaleRecipe(await loadRecipe(r.id),r.servings));
      const merged=mergeIngredients(loaded);
      const {toBuy,covered}=usePantry?subtractPantry(merged,store.pantryList(PROFILE)):{toBuy:merged,covered:[]};
      const basket=await basketFrom(toBuy.slice(0,40),{includePantry,lowGlycemic});
      let budget=null;try{budget=budgetStatus(store.getSetting(PROFILE,'budget',null),await recentOrders(10),(await (await verifiedClient()).readCart()).total);}catch{}
      return {recipes:loaded.map(r=>({id:r.id??null,title:r.title,servings:r.servings,url:r.url,source:r.source?.name})),
        mergedIngredients:merged.length,coveredByPantry:covered,...(toBuy.length>40?{truncated:toBuy.length-40}:{}),...basket,
        ...(budget?.configured?{budget:{...budget,afterThisBasket:Math.round((budget.remainingAfterCart-(basket.estimatedTotal??0))*100)/100}}:{})};
    }));
  // ---- substitutes
  server.registerTool('tosano_substitutes',{description:'Alternatives for a product that is missing, too expensive or not compatible: similar name/category, price per kg compared, blocked products removed by the household rules. Read-only.',
    inputSchema:{slug:z.string().min(3).max(200),limit:z.number().int().min(1).max(10).optional()},annotations:read},
    safeTool(async({slug,limit})=>{const {product}=await checkedProduct(slug),client=await getClient();
      const q=nameTokens(product.name).slice(0,2).join(' ')||product.category;if(!q)throw new TosanoError('Cannot derive a search for this product','INVALID_ARGUMENT');
      const found=await client.search(q,{pageSize:40});store.recordPrices(found.products);
      return {original:{productId:product.productId,slug:product.slug,name:product.name,unitPrice:product.unitPrice,category:product.category},
        alternatives:rankSubstitutes(product,found.products,p=>checkProduct(p,prefs()),limit),
        note:'Compatibilità basata sui dati di ricerca: verifica il singolo prodotto con tosano_check_product prima di aggiungerlo.'};}));
  // ---- budget and prices
  server.registerTool('tosano_budget_set',{description:'Set (or clear with null) the weekly grocery budget in euros. Soft limit: the agent warns, it does not block. Different from maxOrderTotal (a hard permission per order).',
    inputSchema:{weekly:z.number().positive().max(5000).nullable(),userExplicitlyRequested:z.literal(true)},annotations:localWrite},
    safeTool(async({weekly})=>{store.setSetting(PROFILE,'budget',weekly===null?null:{weekly});store.audit(PROFILE,'budget_set',{weekly});return {budget:weekly};}));
  server.registerTool('tosano_budget_status',{description:'Spending this week (orders since Monday, cancelled excluded) plus current cart, against the weekly budget.',annotations:read},
    safeTool(async()=>budgetStatus(store.getSetting(PROFILE,'budget',null),await recentOrders(10),(await (await verifiedClient()).readCart()).total)));
  server.registerTool('tosano_price_history',{description:'Price history of a product as observed by this MCP (median, min, max, trend vs now). Starts when the MCP first sees the product.',
    inputSchema:{slug:z.string().min(3).max(200)},annotations:read},
    safeTool(async({slug})=>{const {product}=await checkedProduct(slug);const h=store.priceHistory(product.productId);
      return {productId:product.productId,name:product.name,...priceInsight(h,product.unitPrice),history:h.slice(-30)};}));
  // ---- smart reorder
  server.registerTool('tosano_usual_items',{description:'"La solita spesa": learns from the last orders how often each product is bought and proposes what is DUE now, with usual quantity, as cartPlanInput for tosano_prepare_cart_change. Also lists frequent items and price trend. Read-only.',
    inputSchema:{orders:z.number().int().min(2).max(20).optional()},annotations:read},
    safeTool(async({orders=10})=>{const h=analyzeHabits(await recentOrders(orders));
      for(const i of h.due){const x=store.priceHistory(i.productId);if(x.length>1)i.price=priceInsight(x);}
      return h;}));
  server.registerTool('tosano_prepare_site_action',{description:'READ-ONLY step for risky site actions. kind: list_delete(listId) | list_to_cart(listId) | reorder(orderId) | select_timeslot(date,timeslotId) | select_address(addressType,addressId) | order_cancel(orderId) | order_modify(orderId) | checkout(paymentTypeId[,userPaymentAuthId]) | cart_empty() | order_retry_payment(orderId) | order_change_payment(orderId,paymentTypeId[,userPaymentAuthId]). Returns exact summary and confirmationPhrase. Show it and wait for explicit approval in a later message.',
    inputSchema:{kind:z.enum(['list_delete','list_to_cart','reorder','select_timeslot','select_address','order_cancel','order_modify','checkout','cart_empty','order_retry_payment','order_change_payment']),
      listId:listId.optional(),orderId:orderId.optional(),date:z.string().max(40).optional(),timeslotId:productId.optional(),
      addressType:z.enum(['drive','home','locker']).optional(),addressId:productId.optional(),
      paymentTypeId:productId.optional(),userPaymentAuthId:productId.optional()},annotations:read},
    safeTool(async({kind,...params})=>(await getSitePlanner()).prepare(kind,params)));
  server.registerTool('tosano_commit_site_action',{description:'EXECUTES a prepared site action ONCE (may change cart, cancel an order, or PLACE A REAL ORDER for kind=checkout). Only after the user explicitly approved the shown summary in a later message. Never retry on error or unknown state.',
    inputSchema:{planId:z.string().uuid(),confirmationPhrase:z.string().min(1).max(30),userExplicitlyApproved:z.literal(true)},annotations:write},
    safeTool(async({planId,confirmationPhrase})=>(await getSitePlanner()).commit(planId,confirmationPhrase)));
  server.registerTool('tosano_site_action_status',{description:'Result of a previous site action plan, without re-executing it.',
    inputSchema:{planId:z.string().uuid()},annotations:localRead},safeTool(async({planId})=>(await getSitePlanner()).status(planId)));
  for(const tool of ['tosano_add_to_cart','tosano_update_quantity','tosano_delete_from_cart']){
    server.registerTool(tool,{description:'Deprecated unsafe direct write. Use tosano_prepare_cart_change, await user approval, then tosano_commit_cart_change.',annotations:write},
      safeTool(async()=>{throw new TosanoError('Direct cart writes removed in v0.3; use the two-phase cart plan tools','TWO_PHASE_REQUIRED');}));
  }
  return server;
}
// Docker binds inside its own network; permit only our Compose service and loopback hosts.
// The host-facing Docker port remains published to 127.0.0.1, not 0.0.0.0.
const app=createMcpExpressApp({host:config.bindHost,
  ...(config.bindHost==='0.0.0.0' ? {allowedHosts:['tosano-mcp','localhost','127.0.0.1'],allowedOrigins:['tosano-mcp','localhost','127.0.0.1']} : {})});
app.use(express.json({limit:'128kb'}));
app.get('/health',(_req,res)=>res.json({service:'tosano-copilot',ok:true,version:RELEASE.version,mcpContract:RELEASE.mcpContract,fts5:store.diagnostics().fts5}));
app.post('/mcp',async(req,res)=>{
  const server=makeServer(),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  try{await server.connect(transport);await transport.handleRequest(req,res,req.body);}
  catch{if(!res.headersSent)res.status(500).json({jsonrpc:'2.0',error:{code:-32603,message:'Internal MCP error'},id:null});}
  finally{if(res.writableFinished){await transport.close();await server.close();}
    else res.on('close',async()=>{await transport.close();await server.close();});}
});
app.get('/mcp',(_req,res)=>res.status(405).end());
app.delete('/mcp',(_req,res)=>res.status(405).end());
const instance=app.listen(config.port,config.bindHost,()=>{
  console.log(`Tosano MCP v${RELEASE.version} listening on ${config.bindHost}:${config.port}/mcp (Docker host publishing must be loopback-only)`);
  console.log(`SQLite FTS5: ${store.diagnostics().fts5?'ready':'unavailable'}; cart writes: ${config.allowCartWrites?'enabled':'disabled'}`);
});
async function stop(){instance.close();await closeBrowserSession();store.close();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
