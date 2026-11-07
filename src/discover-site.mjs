/** Interactive, read-only endpoint inventory. Requires exclusive browser profile.
 * The user opens *reading* screens, without submitting forms or checking out.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {stdin as input,stdout as output} from 'node:process';
import {getConfig,BASE_URL} from './config.mjs';
import {safeSiteGetObservation} from './site-api-discovery.mjs';
const cfg=getConfig();
const filename=path.join(os.homedir(),'.tosano-copilot','site-api-read-discovery.json');
const {chromium}=await import('playwright');
await fs.mkdir(cfg.profilePath,{recursive:true,mode:0o700});
const ctx=await chromium.launchPersistentContext(cfg.profilePath,{headless:false,...(cfg.channel==='chrome'?{channel:'chrome'}:{})});
const observed=new Map(),pending=new Set();
const onResponse=response=>{
 const job=(async()=>{
   const c=safeSiteGetObservation({url:response.url(),method:response.request().method(),status:response.status(),
      contentType:response.headers()['content-type']??''});
   if(c)observed.set(`${c.method}:${c.pathTemplate}:${c.status}`,c);
 })();
 pending.add(job);job.finally(()=>pending.delete(job));
};
ctx.on('response',onResponse);
try {
 const page=ctx.pages()[0]??await ctx.newPage();
 if(!page.url().startsWith(BASE_URL))await page.goto(BASE_URL,{waitUntil:'domcontentloaded'});
 console.log('OBSERVE ONLY: navigate to Tosano native lists, delivery slots and order history; do not modify any content.');
 console.log('Only GET metadata is recorded. All query strings, IDs and response data are discarded.');
 const rl=createInterface({input,output});
 try {await rl.question('When finished exploring READ-ONLY pages, press ENTER: ');}finally{rl.close();}
 await Promise.allSettled([...pending]);
 const routes=[...observed.values()].sort((a,b)=>a.pathTemplate.localeCompare(b.pathTemplate));
 await fs.writeFile(filename,JSON.stringify({version:1,recordedAt:new Date().toISOString(),
  warning:'Endpoint discovery only. Does not prove payload semantics or mutation safety.',routes},null,2)+'\n',{mode:0o600});
 await fs.chmod(filename,0o600);
 console.log(`Read-only route inventory stored locally (${routes.length} shapes). No cookies, bodies or full URLs.`);
} finally {ctx.off('response',onResponse);await ctx.close();}
