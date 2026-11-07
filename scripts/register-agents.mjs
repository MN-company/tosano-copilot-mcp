#!/usr/bin/env node
/** Register the local Tosano MCP server in every AI agent found on this computer.
 * Only touches agents whose config folder already exists. Backs up every file it edits
 * (<file>.tosano-backup) and is idempotent. No dependencies: Node 18+.
 *
 *   node scripts/register-agents.mjs            # register everywhere detected
 *   node scripts/register-agents.mjs --dry-run  # show what would change
 *   node scripts/register-agents.mjs --remove   # unregister
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const URL_ = process.env.TOSANO_MCP_URL || 'http://127.0.0.1:3788/mcp';
const NAME = 'tosano';
const HOME = process.env.TOSANO_HOME_OVERRIDE || os.homedir();
const DRY = process.argv.includes('--dry-run'), REMOVE = process.argv.includes('--remove');
const win = process.platform === 'win32', mac = process.platform === 'darwin';
const appData = process.env.APPDATA || (mac ? path.join(HOME, 'Library', 'Application Support') : path.join(HOME, '.config'));
const results = [];

function editJson(file, mutate, label) {
  if (!fs.existsSync(path.dirname(file))) return results.push({ agent: label, status: 'non_installato' });
  let data = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try { data = raw.trim() ? JSON.parse(raw) : {}; } catch { return results.push({ agent: label, status: 'saltato', reason: 'JSON con commenti o non valido: aggiungi a mano', file }); }
  }
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) === before) return results.push({ agent: label, status: 'già_configurato', file });
  if (!DRY) {
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.tosano-backup');
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  }
  results.push({ agent: label, status: DRY ? 'da_modificare' : (REMOVE ? 'rimosso' : 'registrato'), file });
}
const put = (obj, key, value) => { obj[key] ??= {}; if (REMOVE) delete obj[key][NAME]; else obj[key][NAME] = value; };

// Cursor
editJson(path.join(HOME, '.cursor', 'mcp.json'), d => put(d, 'mcpServers', { url: URL_ }), 'Cursor');
// Windsurf
editJson(path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'), d => put(d, 'mcpServers', { serverUrl: URL_ }), 'Windsurf');
// Gemini CLI
editJson(path.join(HOME, '.gemini', 'settings.json'), d => put(d, 'mcpServers', { httpUrl: URL_ }), 'Gemini CLI');
// VS Code (GitHub Copilot agent mode), stable and Insiders
for (const [dir, label] of [['Code', 'VS Code'], ['Code - Insiders', 'VS Code Insiders']])
  editJson(path.join(appData, dir, 'User', 'mcp.json'), d => put(d, 'servers', { type: 'http', url: URL_ }), label);
// Claude Desktop: stdio only, bridged with mcp-remote (needs npx at runtime)
editJson(path.join(appData, 'Claude', 'claude_desktop_config.json'), d => put(d, 'mcpServers', { command: 'npx', args: ['-y', 'mcp-remote', URL_, '--allow-http'] }), 'Claude Desktop');
// LM Studio
editJson(path.join(HOME, '.lmstudio', 'mcp.json'), d => put(d, 'mcpServers', { url: URL_ }), 'LM Studio');

// OpenAI Codex CLI: TOML
(() => {
  const file = path.join(HOME, '.codex', 'config.toml'), label = 'Codex CLI';
  if (!fs.existsSync(path.dirname(file))) return results.push({ agent: label, status: 'non_installato' });
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = /\n?\[mcp_servers\.tosano\][^[]*/;
  let next = raw.replace(block, '');
  if (!REMOVE) next = next.trimEnd() + `\n\n[mcp_servers.tosano]\nurl = "${URL_}"\n`;
  if (next === raw) return results.push({ agent: label, status: 'già_configurato', file });
  if (!DRY) { if (raw) fs.copyFileSync(file, file + '.tosano-backup'); fs.writeFileSync(file, next.replace(/^\n+/, '')); }
  results.push({ agent: label, status: DRY ? 'da_modificare' : (REMOVE ? 'rimosso' : 'registrato'), file });
})();

// Claude Code: prefer its own CLI (user scope)
(() => {
  const label = 'Claude Code';
  try {
    execFileSync(win ? 'claude.cmd' : 'claude', ['--version'], { stdio: 'ignore', shell: win });
    if (DRY) return results.push({ agent: label, status: 'da_modificare' });
    try { execFileSync(win ? 'claude.cmd' : 'claude', ['mcp', 'remove', NAME, '-s', 'user'], { stdio: 'ignore', shell: win }); } catch {}
    if (!REMOVE) execFileSync(win ? 'claude.cmd' : 'claude', ['mcp', 'add', '--transport', 'http', '-s', 'user', NAME, URL_], { stdio: 'ignore', shell: win });
    results.push({ agent: label, status: REMOVE ? 'rimosso' : 'registrato' });
  } catch { results.push({ agent: label, status: 'non_installato', hint: 'oppure installa il plugin: /plugin marketplace add MN-company/tosano-copilot-mcp' }); }
})();

console.log(JSON.stringify({ server: URL_, results }, null, 2));
console.log('\nChatGPT: usa il connettore via OpenAI Secure MCP Tunnel (vedi README, sezione ChatGPT).');
