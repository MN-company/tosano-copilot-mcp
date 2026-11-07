// Claude Code SessionStart hook: if the local Tosano MCP server is not running, tell Claude to set it up.
const out = m => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: m } }));
try {
  const r = await fetch('http://127.0.0.1:3788/health', { signal: AbortSignal.timeout(3000) });
  const h = await r.json();
  if (!h.ok) throw new Error('not ok');
} catch {
  out('Tosano plugin: the local MCP server (http://127.0.0.1:3788) is not running. If the user wants to shop on Tosano/LaTuaSpesa, or just installed this plugin, follow the tosano-setup skill to install and start it.');
}
