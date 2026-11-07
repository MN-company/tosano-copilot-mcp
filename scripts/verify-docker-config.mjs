/** Offline static checks; actual Docker Compose, Chromium and tunnel connectivity need Windows runtime. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { RELEASE } from '../src/release-contract.mjs';
import { getConfig } from '../src/config.mjs';
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const compose=fs.readFileSync('compose.yaml','utf8');
const docker=fs.readFileSync('Dockerfile','utf8');
assert.equal(pkg.version,RELEASE.version);
assert.equal(pkg.dependencies.playwright,'1.55.0');
assert.match(docker,/playwright:v1\.55\.0-noble/);
assert.match(docker,/npm ci/);
// The Docker image executes tests and verify:docker; these must have every file they read.
assert.match(docker,/COPY integrations \.\/integrations/);
assert.match(docker,/COPY Dockerfile compose\.yaml \.\//);
assert.ok(fs.existsSync('integrations/chatgpt/skills/tosano-shopping/SKILL.md'), 'Missing packaged ChatGPT skill');

// Compose's env_file injects environment variables; there is no .env file inside the image.
assert.match(docker,/CMD\s*\["node",\s*"src\/server\.mjs"\]/);
assert.doesNotMatch(docker,/CMD[^\n]*--env-file/);
const winDeploy=fs.readFileSync('scripts/deploy-windows.ps1','utf8');
const winLogin=fs.readFileSync('scripts/login-windows.ps1','utf8');
const browserHelper=fs.readFileSync('scripts/login-browser.sh','utf8');
assert.match(winDeploy,/docker image ls --quiet --filter/);
assert.doesNotMatch(winDeploy,/\$existing\s*=\s*\(\& docker image inspect/);
assert.doesNotMatch(winLogin,/tosano-mcp --env-file=\.env/);
assert.doesNotMatch(browserHelper,/node --env-file=\.env/);
assert.match(compose,/127\.0\.0\.1:3788:3788/);
assert.match(compose,/127\.0\.0\.1:6080:6080/);
assert.match(compose,/ghcr\.io\/openai\/tunnel-client:v0\.0\.19/);
assert.match(compose,/MCP_SERVER_URL: http:\/\/tosano-mcp:3788\/mcp/);
assert.match(compose,/file:\/run\/secrets\/openai_runtime_key/);
assert.match(compose,/profiles: \[login\]/);
assert.match(compose,/profiles: \[chatgpt\]/);
assert.match(compose,/readyz/);
assert.equal(getConfig({MCP_BIND_HOST:'0.0.0.0'}).bindHost,'0.0.0.0');
assert.equal(getConfig({}).bindHost,'127.0.0.1');
assert.throws(()=>getConfig({MCP_BIND_HOST:'evil.example'}));
console.log(JSON.stringify({status:'pass',version:RELEASE.version,checks:'docker-static',liveWindowsDeployment:'not-tested'}));
