import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zipSync, unzipSync } from 'fflate';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'release');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version, filename = `2048-sandbox-v${version}-cloud.zip`;
const info = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
if (info.version !== version || info.target !== 'web') throw new Error('Build matching web assets first.');
const encoder = new TextEncoder(), files = {};
async function collect(directory, prefix) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.isSymbolicLink()) throw new Error('Cloud release may not contain symlinks.');
    if (entry.isDirectory()) await collect(resolve(directory, entry.name), `${prefix}${entry.name}/`);
    else files[prefix + entry.name] = new Uint8Array(await readFile(resolve(directory, entry.name)));
  }
}
await collect(resolve(root, 'dist'), 'dist/');
files['package.json'] = encoder.encode(JSON.stringify({ name: '2048-sandbox-cloud', version, private: true, type: 'module',
  engines: { node: '>=22' }, scripts: { start: 'node server.mjs' } }, null, 2) + '\n');
files['server.mjs'] = new Uint8Array(await readFile(resolve(root, 'deploy/cloud/server.mjs')));
files['scripts/serve-release.mjs'] = new Uint8Array(await readFile(resolve(root, 'scripts/serve-release.mjs')));
const local = unzipSync(new Uint8Array(await readFile(resolve(output, `2048-sandbox-v${version}.zip`))));
const notices = local[`2048-sandbox-v${version}/THIRD_PARTY_NOTICES.txt`];
if (!notices) throw new Error('Build the local package with third-party notices first.');
files['THIRD_PARTY_NOTICES.txt'] = notices;
files['dist/THIRD_PARTY_NOTICES.txt'] = notices;
files['README.md'] = encoder.encode(`# 2048 Sandbox v${version} — cloud deployment\n\nRun npm install, then npm start.\nNode.js 22 or newer. No npm dependencies or build step is needed.\nThe server uses process.env.PORT (default 3000) and binds 0.0.0.0.\nGame data is stored in each player's browser; this server stores no personal game records.\nDo not clear browser data without exporting a backup first.\n\nSource: https://github.com/sincostancscseccot/2048-sandbox\n`);
const bytes = zipSync(Object.fromEntries(Object.entries(files).map(([path, data]) => [path, [data, { mtime: new Date(2020, 0, 1), level: 9 }]])));
await writeFile(resolve(output, filename), bytes);
await writeFile(resolve(output, `${filename}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${filename}\n`);
console.log(`Cloud deployment ZIP: ${filename} (${bytes.length} bytes, package.json at root, npm start, PORT + 0.0.0.0).`);
