/** Online-safe SQLite snapshot. Never backs up browser cookies, tokens or .env. */
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const source = path.join(os.homedir(),'.tosano-copilot','agent.sqlite');
const destination = process.argv[2];
if (!destination) throw new Error('Expected snapshot destination');
if (!fs.existsSync(source)) {console.log('Database not yet created; backup skipped');process.exit(0);}
fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
const db = new DatabaseSync(source,{readOnly:true});
try {
  await backup(db,destination);
  fs.chmodSync(destination,0o600);
  console.log('SQLite snapshot created; user data not printed');
} finally {db.close();}
