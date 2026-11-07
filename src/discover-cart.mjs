/** Run with the MCP server STOPPED because Chromium profiles are single-writer. */
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import {stdin as input,stdout as output} from 'node:process';
import {getConfig,BASE_URL} from './config.mjs';
import {CartReadRouteTracker} from './cart-read-discovery.mjs';
const cfg=getConfig();
const {chromium}=await import('playwright');
await fs.mkdir(cfg.profilePath,{recursive:true,mode:0o700});
const ctx=await chromium.launchPersistentContext(cfg.profilePath,{headless:false,...(cfg.channel==='chrome'?{channel:'chrome'}:{})});
const tracker=await new CartReadRouteTracker().load();tracker.attach(ctx);
try{
  const page=ctx.pages()[0]??await ctx.newPage();
  if(!page.url().startsWith(BASE_URL))await page.goto(BASE_URL,{waitUntil:'domcontentloaded'});
  console.log('Open your Tosano cart in this Chromium window. No order will be placed.');
  console.log('Only an actually observed GET response containing a valid cart is saved.');
  const rl=createInterface({input,output});
  try{await rl.question('After opening the cart, press ENTER: ');}finally{rl.close();}
  await new Promise(resolve=>setTimeout(resolve,300)); // settle response event processing
  await tracker.flush();
  console.log(tracker.path?'Verified GET cart route observed and saved.':'No confirmed GET cart route observed. Nothing invented or saved.');
}finally{tracker.detach(ctx);await tracker.flush();await ctx.close();}
