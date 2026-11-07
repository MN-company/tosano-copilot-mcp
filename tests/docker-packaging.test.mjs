import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// This executes in the built Docker image as well as the source tree.
// Prior v0.3.3 omitted these files from the image, causing test 1/45 to fail.
test('Docker image packages files required by unit and release verification', () => {
  for (const file of [
    'integrations/chatgpt/skills/tosano-shopping/SKILL.md',
    'Dockerfile',
    'compose.yaml',
    'scripts/verify-docker-config.mjs'
  ]) assert.ok(fs.existsSync(file), `Missing required file from image: ${file}`);
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  assert.match(dockerfile, /COPY integrations \.\/integrations/);
  assert.match(dockerfile, /COPY Dockerfile compose\.yaml \.\//);
});
