import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {RELEASE,REQUIRED_TOOLS} from '../src/release-contract.mjs';
import pkg from '../package.json' with {type:'json'};

test('release manifest matches package and has unique required tools',()=>{
 assert.equal(RELEASE.version,pkg.version);
 assert.match(RELEASE.mcpContract,/^tosano-agent-v\d+$/);
 assert.equal(new Set(REQUIRED_TOOLS).size,REQUIRED_TOOLS.length);
});
test('all declared required tools really exist in the source',()=>{
 const source=fs.readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
 for(const name of REQUIRED_TOOLS)assert.ok(source.includes(`server.registerTool('${name}'`),`Missing actual tool: ${name}`);
});
test('writes remain two phase and old direct tool calls are disabled',()=>{
 const source=fs.readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
 assert.match(source,/TWO_PHASE_REQUIRED/);
 assert.match(source,/userExplicitlyApproved:z\.literal\(true\)/);
 assert.ok(REQUIRED_TOOLS.includes('tosano_prepare_cart_change'));
 assert.ok(REQUIRED_TOOLS.includes('tosano_commit_cart_change'));
});
