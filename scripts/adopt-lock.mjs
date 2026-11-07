/** Preserve an existing, reviewed dependency tree across immutable releases. */
import fs from 'node:fs';
const [savedLock, targetLock] = process.argv.slice(2);
if(!savedLock||!targetLock)throw new Error('Usage: adopt-lock <saved> <target>');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const lock=JSON.parse(fs.readFileSync(savedLock,'utf8'));
const expected=JSON.stringify(Object.entries(pkg.dependencies||{}).sort(([a],[b])=>a.localeCompare(b)));
const actual=JSON.stringify(Object.entries(lock.packages?.['']?.dependencies||{}).sort(([a],[b])=>a.localeCompare(b)));
if(expected!==actual)throw new Error('Dependency definitions changed. Release must include an updated package-lock.json. Refusing unreviewed upgrade.');
lock.version=pkg.version;
lock.packages[''].version=pkg.version;
fs.writeFileSync(targetLock, JSON.stringify(lock,null,2)+'\n',{mode:0o600});
