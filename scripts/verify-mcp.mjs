/** Read-only release gate. Checks actual MCP discovery; never accesses Tosano cart. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RELEASE, REQUIRED_TOOLS } from '../src/release-contract.mjs';

const port = Number(process.env.PORT || '3788');
const base = process.env.MCP_VERIFY_BASE_URL || `http://127.0.0.1:${port}`;
const timeout = AbortSignal.timeout(7000);
async function withDeadline(promise, label, ms=7000) {
  let handle;
  try {return await Promise.race([promise,new Promise((_,reject)=>{handle=setTimeout(()=>reject(new Error(label+' timed out')),ms);})]);}
  finally {clearTimeout(handle);}
}
async function main() {
  const healthResp = await fetch(`${base}/health`, {signal:timeout});
  if (!healthResp.ok) throw new Error(`Health HTTP ${healthResp.status}`);
  const health = await healthResp.json();
  if (health.version !== RELEASE.version || health.mcpContract !== RELEASE.mcpContract || health.fts5 !== true)
    throw new Error(`Health mismatch: expected ${RELEASE.version} (${RELEASE.mcpContract}) and FTS5`);
  const client = new Client({name:'tosano-release-verifier',version:'1.0.0'});
  try {
    await withDeadline(client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`))), 'MCP initialize');
    const {tools} = await withDeadline(client.listTools(), 'MCP tools/list');
    const actual = new Set(tools.map(t=>t.name));
    const missing = REQUIRED_TOOLS.filter(name=>!actual.has(name));
    if(missing.length) throw new Error(`MCP tool discovery incomplete: ${missing.join(', ')}`);
    const releaseTool = tools.find(t=>t.name==='tosano_release_info');
    if (!releaseTool?.inputSchema) throw new Error('Release tool lacks a valid MCP schema');
    console.log(JSON.stringify({status:'pass',version:health.version,mcpContract:health.mcpContract,toolsDiscovered:tools.length,requiredTools:REQUIRED_TOOLS.length,appRegistration:'not_tested_here'}));
  } finally { await withDeadline(client.close(), 'MCP close', 3000).catch(()=>{}); }
}
main().catch(e=>{console.error(`VERIFY FAILED: ${e.message}`); process.exitCode=1;});
