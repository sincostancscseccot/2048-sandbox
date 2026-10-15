import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';

test('cloud ZIP starts its real npm entry on PORT and serves the matching offline app', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const filename = `release/2048-sandbox-v${pkg.version}-cloud.zip`;
  const bytes = await readFile(filename), files = unzipSync(bytes);
  const checksum = await readFile(`${filename}.sha256`, 'utf8');
  assert.equal(checksum.trim().split(/\s+/)[0], createHash('sha256').update(bytes).digest('hex'));
  const cloud = JSON.parse(new TextDecoder().decode(files['package.json']));
  assert.equal(cloud.scripts.start, 'node server.mjs');
  assert.equal(cloud.version, pkg.version);
  assert.equal(Object.keys(cloud.dependencies ?? {}).length, 0);
  const directory = resolve('.work/cloud-package-test');
  await mkdir(directory, { recursive: true });
  for (const [path, data] of Object.entries(files)) {
    assert.ok(!path.startsWith('/') && !path.split('/').includes('..'));
    const target = resolve(directory, path); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, data);
  }
  const child = spawn(process.execPath, ['server.mjs'], { cwd: directory, env: { ...process.env, PORT: '4327' }, windowsHide: true });
  let logs = ''; child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  try {
    let response;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { response = await fetch('http://127.0.0.1:4327/build-info.json'); if (response.ok) break; } catch { /* wait for this owned server */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(response?.ok, logs);
    assert.equal((await response.json()).version, pkg.version);
    assert.match(logs, /ready on 0\.0\.0\.0:4327/);
    assert.equal((await fetch('http://127.0.0.1:4327/')).status, 200);
    assert.equal((await fetch('http://127.0.0.1:4327/sw.js')).status, 200);
    assert.equal((await fetch('http://127.0.0.1:4327/package.json')).status, 404);
  } finally { const stopped = once(child, 'exit'); child.kill(); await stopped; }
});
