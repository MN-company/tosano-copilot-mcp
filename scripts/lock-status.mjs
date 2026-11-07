/** npm lockfile inspection. Keep Windows PowerShell 5.1 away from the large JSON.
 * Outputs exactly current|stale|invalid|missing with exit code 0 for expected
 * lockfile states; exits nonzero for unexpected I/O or invalid package manifest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectLock(manifest, lock) {
  const root = lock?.packages?.[''];
  if (!root || !Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 2) return 'stale';
  if (lock.name !== manifest.name || lock.version !== manifest.version ||
      root.name !== manifest.name || root.version !== manifest.version) return 'stale';
  const deps = ['dependencies', 'devDependencies', 'optionalDependencies'];
  for (const section of deps) {
    const expected = manifest[section] ?? {};
    const got = root[section] ?? {};
    const entries = Object.entries(expected);
    if (entries.length !== Object.keys(got).length ||
        entries.some(([name, version]) => got[name] !== version)) return 'stale';
  }
  return 'current';
}

const rootDir = process.argv[2] || process.cwd();
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const file = path.join(rootDir, 'package-lock.json');
    if (!fs.existsSync(file)) process.stdout.write('missing\n');
    else {
      let lock;
      try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { if (e instanceof SyntaxError) process.stdout.write('invalid\n'); else throw e; }
      if (lock !== undefined) process.stdout.write(inspectLock(manifest, lock) + '\n');
    }
  } catch (e) {
    console.error('Lock inspection failed: ' + e.message);
    process.exitCode = 1;
  }
}
