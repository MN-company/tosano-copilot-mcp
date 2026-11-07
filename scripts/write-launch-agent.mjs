import fs from 'node:fs';
import path from 'node:path';
const [destination,root,nodePath]=process.argv.slice(2);
if(!destination||!root||!nodePath||![destination,root,nodePath].every(path.isAbsolute))throw new Error('Use absolute paths');
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const args=[nodePath,`--env-file=${path.join(root,'shared','.env')}`,path.join(root,'current','src','server.mjs')];
const strings=args.map(s=>`    <string>${esc(s)}</string>`).join('\n');
const contents=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tosano.copilot</string>
  <key>ProgramArguments</key><array>
${strings}
  </array>
  <key>WorkingDirectory</key><string>${esc(path.join(root,'current'))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${esc(path.join(root,'logs','stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(root,'logs','stderr.log'))}</string>
</dict></plist>\n`;
fs.mkdirSync(path.dirname(destination),{recursive:true});
fs.writeFileSync(destination,contents,{mode:0o600});
console.log('LaunchAgent configuration prepared (no secrets in plist)');
