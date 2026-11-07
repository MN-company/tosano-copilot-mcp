/** Offline-only: import a consistent SQLite snapshot produced by SQLite backup() on the Mac. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
const input = process.argv[2];
if (!input || !path.isAbsolute(input)) throw Error('Expected absolute path to transferred SQLite snapshot');
if (!fs.existsSync(input)) throw Error('Snapshot not found');
const src = new DatabaseSync(input, { readOnly: true });
try {
  const check = src.prepare('PRAGMA quick_check').all();
  if (check[0]?.quick_check !== 'ok') throw Error('Import rejected: SQLite quick_check failed');
  const tables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
  if (!tables.has('preference_rules') || !tables.has('shopping_lists'))
    throw Error('Import rejected: not a Tosano agent database');
  const home = path.join(os.homedir(), '.tosano-copilot');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = path.join(home, 'agent.sqlite');
  // The caller MUST stop the MCP container before importing. Busy SQLite WAL means fail closed.
  if (fs.existsSync(target)) {
    const old = new DatabaseSync(target);
    try {
      old.exec('PRAGMA busy_timeout=1000;');
      const cp = old.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (cp && cp.busy !== 0) throw Error('Import rejected: another process has database open');
      const backupDir = path.join(home, 'backups');
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const backupPath = path.join(backupDir, `before-import-${Date.now()}.sqlite`);
      await backup(old, backupPath);
      fs.chmodSync(backupPath, 0o600);
    } finally { old.close(); }
    // WAL was checkpointed successfully. Remove obsolete sidecars before replacing main db.
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = target + suffix;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
  }
  const stage = path.join(home, `agent-import-${process.pid}.sqlite`);
  try {
    await backup(src, stage);
    const checkStage = new DatabaseSync(stage, { readOnly: true });
    try {
      if (checkStage.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
        throw Error('Stage snapshot failed SQLite verification');
    } finally { checkStage.close(); }
    fs.renameSync(stage, target);
    fs.chmodSync(target, 0o600);
    console.log('Verified SQLite snapshot imported. Restart the Tosano service; no credentials migrated.');
  } finally {
    if (fs.existsSync(stage)) fs.unlinkSync(stage);
    for (const suffix of ['-wal', '-shm']) {
      const extra = stage + suffix;
      if (fs.existsSync(extra)) fs.unlinkSync(extra);
    }
  }
} finally { src.close(); }
