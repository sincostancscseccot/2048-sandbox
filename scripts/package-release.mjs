import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const build = JSON.parse(await readFile(resolve(root, 'dist/build-info.json'), 'utf8'));
if (build.version !== pkg.version) throw new Error('dist version differs from package.json. Run pnpm build first.');
const base = `2048-sandbox-v${pkg.version}`, files = new Map();
const add = async (name, source = name) => files.set(name, new Uint8Array(await readFile(resolve(root, source))));
async function collect(directory, prefix) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.isSymbolicLink()) throw new Error('Release input must not contain symbolic links.');
    if (entry.isDirectory()) await collect(resolve(directory, entry.name), `${prefix}${entry.name}/`);
    else files.set(prefix + entry.name, new Uint8Array(await readFile(resolve(directory, entry.name))));
  }
}
await collect(resolve(root, 'dist'), 'dist/');
for (const path of ['scripts/start.ps1', 'scripts/serve-release.mjs', 'scripts/verify-release.mjs', '启动试玩.cmd']) await add(path);
await add('使用说明.md', 'docs/release/本地版使用说明.md');
const encoder = new TextEncoder();
files.set('README.txt', encoder.encode(`2048 Sandbox v${pkg.version}\r\n\r\n1. Extract this entire ZIP into a folder.\r\n2. Install Node.js 24.19+ (24.x), or use the bundled Codex runtime on this PC.\r\n3. Double-click 启动试玩.cmd and keep its window open.\r\n4. Open http://127.0.0.1:4173/ in Chrome or Edge.\r\n\r\nNo pnpm, npm install or network access is needed for this release.\r\nVerify extracted files: node scripts/verify-release.mjs\r\nRead 使用说明.md for game controls, backups, offline use and update instructions.\r\nGame data belongs to this browser and origin; it is not stored inside this program ZIP.\r\n`));

// Include actual installed license texts for the app and bundled Workbox runtime.
const visited = new Map();
async function packageDirectory(name, from) {
  const require = createRequire(resolve(from, 'package.json'));
  let folder = dirname(require.resolve(name));
  for (;;) {
    try { const info = JSON.parse(await readFile(resolve(folder, 'package.json'), 'utf8')); if (info.name === name) return { folder, info }; } catch { /* ascend through the package's build directory */ }
    const parent = dirname(folder); if (parent === folder) throw new Error(`Cannot locate package ${name}`); folder = parent;
  }
}
async function notice(name, from) {
  const { folder, info } = await packageDirectory(name, from), key = `${name}@${info.version}`;
  if (visited.has(key)) return;
  const licenseFiles = (await readdir(folder)).filter(path => /^(license|copying|notice)([.\-_].*)?$/i.test(path)).sort();
  if (!licenseFiles.length) throw new Error(`Missing installed license text: ${key}`);
  visited.set(key, { info, texts: await Promise.all(licenseFiles.map(async path => `${path}\n${await readFile(resolve(folder, path), 'utf8')}`)) });
  for (const dependency of Object.keys(info.dependencies ?? {}).filter(name => !name.startsWith('@types/')).sort()) await notice(dependency, folder);
}
for (const dependency of Object.keys(pkg.dependencies).sort()) await notice(dependency, root);
const workboxBuild = await packageDirectory('workbox-build', root);
for (const dependency of Object.keys(workboxBuild.info.dependencies).filter(name => name.startsWith('workbox-')).sort()) await notice(dependency, workboxBuild.folder);
const notices = [...visited].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, { info, texts }]) => `=== ${key} ===\nDeclared license: ${typeof info.license === 'string' ? info.license : JSON.stringify(info.license)}\n${texts.join('\n\n')}`).join('\n\n');
files.set('THIRD_PARTY_NOTICES.txt', encoder.encode(`Third-party software distributed with this local application.\nLicense texts are copied from the installed packages used to build it.\n\n${notices}\n`));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = [...files].sort(([a], [b]) => a.localeCompare(b, 'en'));
const manifest = { format: '2048-sandbox-local-release', formatVersion: 1, appVersion: pkg.version,
  runtime: 'Node.js >=24.19.0 <25', origin: 'http://127.0.0.1:4173/',
  thirdPartyPackages: [...visited.keys()].sort(), files: sorted.map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) })) };
files.set('release-manifest.json', encoder.encode(JSON.stringify(manifest, null, 2) + '\n'));
const archive = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, bytes]) => [`${base}/${name}`, [bytes, { mtime: new Date(2020, 0, 1), level: 9 }]]));
const bytes = zipSync(archive, { level: 9 });
const output = resolve(root, 'release'); await mkdir(output, { recursive: true });
await writeFile(resolve(output, `${base}.zip`), bytes);
await writeFile(resolve(output, `${base}.zip.sha256`), `${sha256(bytes)}  ${base}.zip\n`);
console.log(`Local release: release/${base}.zip (${bytes.length} bytes, ${files.size} files, ${visited.size} third-party packages)\nSHA-256: ${sha256(bytes)}`);
