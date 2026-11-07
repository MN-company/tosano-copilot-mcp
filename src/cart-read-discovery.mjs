/** Discover cart GET route by observing the real site; no guessing, no PII persistence. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BASE_URL } from './config.mjs';

const READ_PATH_FILE=path.join(os.homedir(),'.tosano-copilot','cart-read-path.json');
const validCartRoute = route => /^\/ebsn\/api\/cart(?:\/[a-z-]+)?(?:\?(?:show_sectors=(?:true|false)))?$/.test(route)
  && !/\/(?:add|update|delete|pay|checkout|confirm)(?:\?|$)/.test(route);
export function observedCartReadRoute(rawUrl,method,payload){
  try {
    const url=new URL(rawUrl);
    if(url.origin!==BASE_URL||method!=='GET')return null;
    // Store only the safe known query parameter. Other parameters may be tokens or user details.
    const keys=[...url.searchParams.keys()];
    if(keys.some(k=>k!=='show_sectors'))return null;
    const route=url.pathname+url.search;
    if(!validCartRoute(route))return null;
    const data=payload?.data;
    if(payload?.response?.status!==0||!data||!Array.isArray(data.cartItems)||
      !Number.isSafeInteger(data.cartId)||!Number.isFinite(data.totalPrice))return null;
    return route;
  }catch{return null;}
}
export class CartReadRouteTracker {
  #file;#path='';#pending=Promise.resolve();#onResponse;
  constructor(file=READ_PATH_FILE){this.#file=file;}
  get path(){return this.#path;}
  async load(){
    try{const saved=JSON.parse(await fs.readFile(this.#file,'utf8'));if(validCartRoute(saved.path))this.#path=saved.path;}
    catch(e){if(e.code!=='ENOENT' && !(e instanceof SyntaxError))throw e;}
    return this;
  }
  async observe(response){
    if(response.request().method()!=='GET'||!response.url().startsWith(BASE_URL+'/ebsn/api/cart'))return false;
    let payload;try{payload=await response.json();}catch{return false;}
    const path=observedCartReadRoute(response.url(),'GET',payload);
    if(!path)return false;
    this.#path=path;
    this.#pending=this.#pending.catch(()=>{}).then(async()=>{
      await fs.mkdir(pathModule(this.#file),{recursive:true,mode:0o700});
      await fs.chmod(pathModule(this.#file),0o700);
      await fs.writeFile(this.#file,JSON.stringify({path,observedAt:new Date().toISOString()})+'\n',{mode:0o600});
      await fs.chmod(this.#file,0o600);
    });
    return true;
  }
  attach(context){this.#onResponse=r=>{this.observe(r).catch(()=>{});};context.on('response',this.#onResponse);return this;}
  detach(context){if(this.#onResponse)context.off('response',this.#onResponse);}
  async flush(){await this.#pending;}
}
const pathModule = p => path.dirname(p);
export async function readObservedCartPath(file=READ_PATH_FILE){
  try {const saved=JSON.parse(await fs.readFile(file,'utf8'));return validCartRoute(saved.path)?saved.path:null;}
  catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return null;throw e;}
}
