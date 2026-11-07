import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {observedCartReadRoute,CartReadRouteTracker,readObservedCartPath} from '../src/cart-read-discovery.mjs';
const url='https://www.latuaspesa.com/ebsn/api/cart/view?show_sectors=false';
const payload={response:{status:0},data:{cartId:123,totalPrice:4.2,cartItems:[{itemId:1}]}};
test('accept only validated GET cart JSON on Tosano origin',()=>{
  assert.equal(observedCartReadRoute(url,'GET',payload),'/ebsn/api/cart/view?show_sectors=false');
  assert.equal(observedCartReadRoute(url,'POST',payload),null);
  assert.equal(observedCartReadRoute('https://evil.test/ebsn/api/cart/view','GET',payload),null);
  assert.equal(observedCartReadRoute(url,'GET',{response:{status:0},data:{}}),null);
  assert.equal(observedCartReadRoute(url+'&token=secret','GET',payload),null);
  assert.equal(observedCartReadRoute('https://www.latuaspesa.com/ebsn/api/cart/delete','GET',payload),null);
});

test('observed cart route is stored without cookies, payload, identity or full URL',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tosano-read-'));
  const file=path.join(folder,'path.json'),t=await new CartReadRouteTracker(file).load();
  const response={url:()=>url,request:()=>({method:()=> 'GET'}),json:async()=>payload};
  assert.equal(await t.observe(response),true);await t.flush();
  assert.equal(await readObservedCartPath(file),'/ebsn/api/cart/view?show_sectors=false');
  const stored=await fs.readFile(file,'utf8');assert.ok(!stored.includes('cartId'));assert.ok(!stored.includes('JSESSIONID'));
  assert.equal((await fs.stat(file)).mode & 0o777,0o600);
  await fs.rm(folder,{recursive:true,force:true});
});
