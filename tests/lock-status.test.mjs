import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspectLock } from '../scripts/lock-status.mjs';

const pkg={name:'tosano-copilot-mcp',version:'0.3.6',dependencies:{express:'^5.1.0',playwright:'1.55.0'}};
const lock={name:pkg.name,version:pkg.version,lockfileVersion:3,packages:{'':{name:pkg.name,version:pkg.version,dependencies:pkg.dependencies}}};
test('lock status recognizes matching npm v3 lock',()=>assert.equal(inspectLock(pkg,lock),'current'));
test('lock status rejects outdated version without treating JSON as invalid',()=>assert.equal(inspectLock(pkg,{...lock,version:'0.3.4'}),'stale'));
test('lock status rejects changed dependencies',()=>assert.equal(inspectLock(pkg,{...lock,packages:{'':{...lock.packages[''],dependencies:{express:'^4.0.0',playwright:'1.55.0'}}}}),'stale'));
test('lock status rejects old or incomplete schema',()=>{
  assert.equal(inspectLock(pkg,{name:pkg.name,version:pkg.version,lockfileVersion:1}),'stale');
  assert.equal(inspectLock(pkg,null),'stale');
});
test('CLI distinguishes missing, invalid and valid lock without PowerShell JSON parser',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tosano-lock-'));
  try {
    fs.writeFileSync(path.join(tmp,'package.json'),JSON.stringify(pkg));
    const cli=()=>spawnSync(process.execPath,['scripts/lock-status.mjs',tmp],{encoding:'utf8'});
    const missing=cli(); assert.equal(missing.status,0); assert.equal(missing.stdout.trim(),'missing');
    fs.writeFileSync(path.join(tmp,'package-lock.json'),'{not-json');
    const invalid=cli(); assert.equal(invalid.status,0); assert.equal(invalid.stdout.trim(),'invalid');
    fs.writeFileSync(path.join(tmp,'package-lock.json'),JSON.stringify(lock));
    const current=cli(); assert.equal(current.status,0); assert.equal(current.stdout.trim(),'current');
  } finally {fs.rmSync(tmp,{recursive:true,force:true});}
});
test('Windows deploy inspects npm lock with Node and backs up invalid files',()=>{
  const deploy=fs.readFileSync('scripts/deploy-windows.ps1','utf8');
  assert.match(deploy,/node scripts\/lock-status\.mjs/);
  assert.doesNotMatch(deploy,/Get-Content 'package-lock\.json' -Raw \| ConvertFrom-Json/);
  assert.match(deploy,/Move-Item -LiteralPath 'package-lock\.json'/);
  assert.match(deploy,/Post-generation dependency lock verification/);
});
