import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';

const execute = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pkg = JSON.parse(await readFile('package.json', 'utf8')), base = `2048-sandbox-v${pkg.version}`, file = `release/${base}.zip`;
test('distribution ZIP has a complete matching manifest, checksum, actual build, notices and no user data or dependencies', async () => {
  const bytes = await readFile(file), checksum = await readFile(`${file}.sha256`, 'utf8'); assert.equal(checksum, `${hash(bytes)}  ${base}.zip\n`);
  const archive = unzipSync(bytes), files = Object.fromEntries(Object.entries(archive).map(([path, content]) => {
    assert(path.startsWith(`${base}/`)); const name = path.slice(base.length + 1);
    assert(!/node_modules|\.work|(^|\/)src\/|\.2048(?:lab|backup|state)$/.test(name)); return [name, content];
  }));
  const manifest = JSON.parse(new TextDecoder().decode(files['release-manifest.json'])); assert.equal(manifest.appVersion, pkg.version);
  assert.equal(manifest.files.length + 1, Object.keys(files).length); assert.equal(new Set(manifest.files.map(item => item.path)).size, manifest.files.length);
  for (const item of manifest.files) {
    assert.equal(files[item.path].length, item.bytes, item.path); assert.equal(hash(files[item.path]), item.sha256, item.path);
    if (item.path.startsWith('dist/')) assert.deepEqual(files[item.path], new Uint8Array(await readFile(item.path)), item.path);
  }
  for (const dependency of Object.keys(pkg.dependencies)) assert(manifest.thirdPartyPackages.some(name => name === `${dependency}@${pkg.dependencies[dependency]}`), dependency);
  assert.match(new TextDecoder().decode(files['THIRD_PARTY_NOTICES.txt']), /Permission is hereby granted/);
  assert.equal(JSON.parse(new TextDecoder().decode(files['dist/build-info.json'])).version, pkg.version);
});
test('packaging the same build and inputs twice produces the identical release ZIP', async () => {
  const before = hash(await readFile(file)); await execute(process.execPath, ['scripts/package-release.mjs'], { windowsHide: true });
  assert.equal(hash(await readFile(file)), before);
});
