import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeSiteGetObservation} from '../src/site-api-discovery.mjs';
test('site discovery retains only safe read metadata and drops response content and secrets',()=>{
 const o=safeSiteGetObservation({method:'GET',url:'https://www.latuaspesa.com/ebsn/api/lists/12345?token=secret&email=user@example.com',status:200,contentType:'application/json',privateData:'PII'});
 assert.deepEqual(o,{method:'GET',pathTemplate:'/ebsn/api/lists/:segment',status:200,
   observedAs:'browser_response_unverified_auth',validation:'metadata_only_not_a_verified_api_contract'});
 assert.doesNotMatch(JSON.stringify(o),/token|secret|email|12345|PII/);
});
test('site discovery rejects writes, cross-origin, non-JSON and non-API routes',()=>{
 const base={url:'https://www.latuaspesa.com/ebsn/api/lists',method:'GET',status:200,contentType:'application/json'};
 assert.equal(safeSiteGetObservation({...base,method:'POST'}),null);
 assert.equal(safeSiteGetObservation({...base,url:'https://evil.example/ebsn/api/lists'}),null);
 assert.equal(safeSiteGetObservation({...base,contentType:'text/html'}),null);
 assert.equal(safeSiteGetObservation({...base,url:'https://www.latuaspesa.com/myaccount'}),null);
});
import {readSiteDiscoveryStatus} from '../src/site-api-discovery.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('site discovery status distinguishes not-yet-discovered and sanitizer readback',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tosano-discovery-'));
 const file=path.join(dir,'status.json');
 assert.equal((await readSiteDiscoveryStatus(file)).status,'awaiting_read_only_discovery');
 await fs.writeFile(file,JSON.stringify({version:1,recordedAt:'2026-11-02T00:00:00Z',routes:[
  {method:'GET',pathTemplate:'/ebsn/api/lists/:segment',status:200},
  {method:'POST',pathTemplate:'/ebsn/api/lists',status:200},
  {method:'GET',pathTemplate:'/ebsn/api/lists/secret+value',status:200}
 ]}));
 const d=await readSiteDiscoveryStatus(file);
 assert.equal(d.status,'discovered_metadata_only');assert.equal(d.routes.length,1);
 await fs.rm(dir,{recursive:true,force:true});
});
