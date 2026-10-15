import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { resolve, sep } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { serveRelease } from '../../scripts/serve-release.mjs';

const execute = promisify(execFile), parent = resolve('.work/release-tests');
let directory, server, port;
function send(path, method = 'GET', accept = '*/*') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Accept: accept } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on('error', reject); req.end();
  });
}
before(async () => {
  await mkdir(parent, { recursive: true }); directory = await mkdtemp(resolve(parent, 'server-'));
  await mkdir(resolve(directory, 'dist/assets'), { recursive: true });
  for (const [name, body] of [['index.html','<!doctype html><title>Local app</title>'],['sw.js','// worker'],['manifest.webmanifest','{}'],['assets/index-12345678.js','console.log(1)']]) await writeFile(resolve(directory, 'dist', name), body);
  await writeFile(resolve(directory, 'private.txt'), 'private');
  server = await serveRelease(resolve(directory, 'dist'), 0); port = server.address().port;
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (directory && resolve(directory).startsWith(parent + sep)) await rm(directory, { recursive: true, force: true });
});

test('standalone server serves MIME, HEAD, cache revalidation and immutable assets correctly', async () => {
  const home = await send('/'); assert.equal(home.status, 200); assert.match(home.headers['content-type'], /text\/html/); assert.equal(home.headers['cache-control'], 'no-cache');
  const head = await send('/', 'HEAD'); assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], String(Buffer.byteLength(home.body)));
  const worker = await send('/sw.js'); assert.match(worker.headers['content-type'], /javascript/); assert.equal(worker.headers['cache-control'], 'no-cache'); assert.equal(worker.headers['x-content-type-options'], 'nosniff');
  const manifest = await send('/manifest.webmanifest'); assert.match(manifest.headers['content-type'], /application\/manifest\+json/); assert.equal(manifest.headers['cache-control'], 'no-cache');
  const asset = await send('/assets/index-12345678.js'); assert.match(asset.headers['cache-control'], /immutable/);
});
test('SPA fallback does not hide missing scripts, files or unsupported methods', async () => {
  assert.match((await send('/history/branch', 'GET', 'text/html')).body, /Local app/);
  assert.equal((await send('/missing.js', 'GET', 'text/html')).status, 404);
  assert.equal((await send('/assets/missing', 'GET', '*/*')).status, 404);
  const post = await send('/', 'POST'); assert.equal(post.status, 405); assert.equal(post.headers.allow, 'GET, HEAD');
});
test('encoded traversal, Windows separators, malformed escapes and NUL never expose files outside dist', async () => {
  for (const path of ['/%2e%2e/private.txt', '/.%2e/private.txt', '/%5c..%5cprivate.txt', '/%00private.txt', '/%bad%encoding']) {
    const result = await send(path); assert.equal(result.status, 400, path); assert.notEqual(result.body, 'private');
  }
  assert.equal((await send('/private.txt')).status, 404);
});
test('CLI refuses an occupied port and malformed port with an actionable error', async () => {
  await assert.rejects(execute(process.execPath, ['scripts/serve-release.mjs', '--port', String(port)]), error => error.code === 1 && /already in use/.test(error.stderr));
  await assert.rejects(execute(process.execPath, ['scripts/serve-release.mjs', '--port', '4173;bad']), error => error.code === 1 && /Port must/.test(error.stderr));
});
test('release launcher runs the standalone server without requiring Vite or dependency installation', async () => {
  const launch = await readFile('scripts/start.ps1', 'utf8');
  assert.match(launch, /scripts\\serve-release\.mjs/); assert.match(launch, /\[switch\]\$Rebuild/);
  const source = await readFile('scripts/serve-release.mjs', 'utf8');
  assert.doesNotMatch(source, /from ['"](?:vite|fflate|react|dexie)/);
});
test('Windows PowerShell 5 launcher selects a supported Node and serves the actual production build', { skip: process.platform !== 'win32' }, async () => {
  const probe = await serveRelease(resolve(directory, 'dist'), 0), launchPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('scripts/start.ps1'),'-Port',String(launchPort)], { windowsHide:true, stdio:['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', chunk => output += String(chunk)); child.stderr.on('data', chunk => output += String(chunk));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
      try { const result = await fetch(`http://127.0.0.1:${launchPort}/build-info.json`); if (result.ok) { ready = true; break; } } catch { /* wait for this owned launch */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(ready, output); const runtime = /Using Node\.js (\d+)\.(\d+)\.(\d+)/.exec(output);
    assert(runtime, output); assert.equal(Number(runtime[1]), 24); assert(Number(runtime[2]) >= 19, output);
    const marker = await (await fetch(`http://127.0.0.1:${launchPort}/build-info.json`)).json();
    assert.equal(marker.version, JSON.parse(await readFile('package.json','utf8')).version);
  } finally {
    if (child.exitCode === null && child.pid) await execute('taskkill.exe', ['/PID',String(child.pid),'/T','/F'], { windowsHide:true });
  }
});
