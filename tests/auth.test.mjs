import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { classifyAccountIdentity } from '../src/identity.mjs';
import { ContextHashTracker, extractContextHash, contextualConfig } from '../src/context-hash.mjs';
import { sessionStatus } from '../src/session.mjs';
import { TosanoClient } from '../src/client.mjs';

const signedUser = {userId:12345, login:'tes*****@example.com', profileConfirmed:true,
  email:'never-reveal@example.org', address:'private street'};
const validResult = user => ({
  ok:()=>true, status:()=>200,
  json:async()=>({response:{status:0,errors:[]}, user, data:{page:{selPage:1,totPages:1,totItems:0},products:[]}})
});
const testCfg = { contextHash:'w90d2026-11-03t372', allowCartWrites:false };

test('account check is independent of JSESSIONID detection and never reveals personal data', async () => {
  const http = {get: async()=> validResult(signedUser)};
  const client = new TosanoClient(http,testCfg);
  const result = await sessionStatus(client);
  assert.equal(result.authenticatedWithTosano,'verified');
  assert.equal(result.evidence,'confirmed_account_identity_in_api_response');
  assert(!JSON.stringify(result).includes('example.com'));
  assert(!JSON.stringify(result).includes('12345'));
});
test('public product catalog does not prove account login',async()=>{
  const http = { get: async()=> validResult({ userId:0, login:'', profileConfirmed:false }) };
  const status = await sessionStatus(new TosanoClient(http,testCfg));
  assert.equal(status.authenticatedWithTosano,'unverified');
  assert.equal(classifyAccountIdentity(undefined).authenticatedWithTosano,'unverified');
  assert.equal(classifyAccountIdentity({userId:123,login:'test@example.com',profileConfirmed:false}).authenticatedWithTosano,'unverified');
});
test('session probe network error does not imply logout or leak exception',async()=>{
  const http={ get:async()=>{throw new Error('Authorization: secret-sensitive');} };
  const result=await sessionStatus(new TosanoClient(http,testCfg));
  assert.equal(result.authenticatedWithTosano,'unverified');
  assert.equal(result.reason,'NETWORK_READ_FAILED');
  assert(!JSON.stringify(result).includes('secret-sensitive'));
});
test('context parser only accepts observed Tosano product URLs',()=>{
  assert.equal(extractContextHash('https://www.latuaspesa.com/ebsn/api/products?q=pasta&hash=w90d2026-11-03t372'),'w90d2026-11-03t372');
  assert.equal(extractContextHash('https://other.example/ebsn/api/products?hash=w90d2026-11-03t372'),null);
  assert.equal(extractContextHash('https://www.latuaspesa.com/ebsn/api/cart/add?hash=w90d2026-11-03t372'),null);
  assert.equal(extractContextHash('https://www.latuaspesa.com/ebsn/api/products?hash=%0A'),null);
});
test('latest observed browser context overrides old env and persists without cookies',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tosano-context-'));
  try {
    const file=path.join(dir,'context.json');
    const emitter=new EventEmitter();
    const tracker=await new ContextHashTracker(file).load('oldhash123');
    tracker.attach(emitter);
    assert.equal(contextualConfig(emitter,{contextHash:'oldhash123'}).getContextHash(),'oldhash123');
    emitter.emit('request',{url:()=> 'https://www.latuaspesa.com/ebsn/api/products?hash=w91d2026-11-05t111&q=pasta'});
    await tracker.flush();
    assert.equal(contextualConfig(emitter,{contextHash:'oldhash123'}).getContextHash(),'w91d2026-11-05t111');
    tracker.detach(emitter);
    const content=await fs.readFile(file,'utf8');
    assert(!content.includes('JSESSIONID'));
    assert.equal((await fs.stat(file)).mode & 0o777,0o600);
    const reloaded=await new ContextHashTracker(file).load('oldhash123');
    assert.equal(reloaded.hash,'w91d2026-11-05t111');
    assert.equal(reloaded.source,'saved_browser_observation');
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('contextHash is used dynamically after browser changes warehouse/slot',async()=>{
  const calls=[];
  let liveHash='w90d2026-11-03t372';
  const http={get:async(url)=>{ calls.push(url); return validResult(signedUser); }};
  const client=new TosanoClient(http,{...testCfg,getContextHash:()=>liveHash,getContextHashSource:()=> 'live_browser_observation'});
  await client.verifySession();
  liveHash='w91d2026-11-05t111';
  await client.verifySession();
  assert.equal(new URL(calls[0]).searchParams.get('hash'),'w90d2026-11-03t372');
  assert.equal(new URL(calls[1]).searchParams.get('hash'),'w91d2026-11-05t111');
});
