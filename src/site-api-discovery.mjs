/** Metadata-only observation of authenticated LaTuaSpesa read endpoints.
 * Never stores tokens, response bodies, personal records or full URLs.
 * This is discovery evidence, not authorization to call an unverified API.
 */
import {BASE_URL} from './config.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const SAFE_SEGMENTS = new Set([
  'ebsn','api','cart','view','get','list','lists','shopping','shopping-list','shopping-lists',
  'wishlist','wishlists','favorites','favourites','products','product','orders','order',
  'slots','slot','timeslots','timeslot','store','stores','warehouse','delivery','pickup',
  'account','profile','addresses','address','history','details','detail','overview',
  'search','customer','user','categories','category','sectors','preferences','shipping'
]);
export function safeSiteGetObservation({url,method,status,contentType=''}) {
  try {
    const u=new URL(url);
    if(u.origin!==BASE_URL || method!=='GET' || !u.pathname.startsWith('/ebsn/api/') ||
      !Number.isInteger(status) || status<100 || status>599) return null;
    if(!/json/i.test(contentType))return null;
    const path=u.pathname.split('/').map((part,index)=>{
      if(index===0)return '';
      // Never trust path segments to be free of names, IDs or session values.
      return SAFE_SEGMENTS.has(part.toLowerCase()) ? part.toLowerCase() : ':segment';
    }).join('/');
    return {method:'GET',pathTemplate:path,status,observedAs:'browser_response_unverified_auth',
      validation:'metadata_only_not_a_verified_api_contract'};
  } catch {return null;}
}

export async function readSiteDiscoveryStatus(file=path.join(os.homedir(),'.tosano-copilot','site-api-read-discovery.json')) {
  try {
    const saved=JSON.parse(await fs.readFile(file,'utf8'));
    if(saved.version!==1 || !Array.isArray(saved.routes))throw new Error('Invalid discovery file');
    const routes=saved.routes.filter(x=>x?.method==='GET' &&
      typeof x.pathTemplate==='string' && /^\/ebsn\/api\/(?:[a-z-]+|:segment)(?:\/(?:[a-z-]+|:segment))*$/.test(x.pathTemplate) &&
      Number.isInteger(x.status) && x.status>=100 && x.status<=599).slice(0,300)
      .map(x=>({method:'GET',pathTemplate:x.pathTemplate,status:x.status}));
    return {status:'discovered_metadata_only',source:'local_browser_observation',
      recordedAt:typeof saved.recordedAt==='string'?saved.recordedAt:null,routes,
      warning:'Routes are sanitized observations, not confirmed API contracts. Native lists are not implemented.'};
  } catch(e) {
    if(e.code==='ENOENT')return {status:'awaiting_read_only_discovery',routes:[],
      warning:'Run scripts/discover-site-windows.ps1 on the Windows PC when available. No site-native lists are implemented.'};
    return {status:'discovery_file_unreadable',routes:[],warning:'No validated routes available.'};
  }
}
