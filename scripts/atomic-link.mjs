/** POSIX atomic symlink replacement, used only for the local app code pointer. */
import fs from 'node:fs';
import path from 'node:path';
const [link,target]=process.argv.slice(2);
if(!link||!target||!path.isAbsolute(link)||!path.isAbsolute(target))throw new Error('Absolute link and target required');
if(!fs.existsSync(target))throw new Error('Missing target release');
fs.mkdirSync(path.dirname(link),{recursive:true});
const temporary=`${link}.next.${process.pid}`;
try {fs.symlinkSync(target,temporary);fs.renameSync(temporary,link);}
finally {try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
