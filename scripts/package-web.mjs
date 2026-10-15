import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { zipSync, unzipSync } from 'fflate';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'release');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const name = `2048-sandbox-v${pkg.version}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const local = unzipSync(new Uint8Array(await readFile(resolve(output, `${name}.zip`))));
const notices = local[`${name}/THIRD_PARTY_NOTICES.txt`];
if (!notices) throw new Error('Build the matching local release first.');
await mkdir(output, { recursive: true });
const files = {};
async function collect(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.isSymbolicLink()) throw new Error('Web release may not contain symlinks.');
    if (entry.isDirectory()) await collect(resolve(directory, entry.name), `${prefix}${entry.name}/`);
    else files[prefix + entry.name] = new Uint8Array(await readFile(resolve(directory, entry.name)));
  }
}
await collect(resolve(root, '.work/web'));
if (JSON.parse(new TextDecoder().decode(files['build-info.json'])).version !== pkg.version) throw new Error('Web assets are from another version.');
files['THIRD_PARTY_NOTICES.txt'] = notices;
files['.nojekyll'] = new Uint8Array();
files['web-release.json'] = new TextEncoder().encode(JSON.stringify({ format: '2048-sandbox-static-web-release', version: pkg.version,
  files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) }, null, 2));
const archive = zipSync(Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, [bytes, { mtime: new Date(2020, 0, 1), level: 9 }]])));
await writeFile(resolve(output, `${name}-web.zip`), archive);
await writeFile(resolve(output, `${name}-web.zip.sha256`), `${hash(archive)}  ${name}-web.zip\n`);

let html = await readFile(resolve(root, '.work/single/index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)];
if (scripts.length !== 1) throw new Error('Single-file build must emit exactly one script.');
const script = await readFile(resolve(root, '.work/single', scripts[0][1].replace(/^\.\//, '')), 'utf8');
html = html.replace(scripts[0][0], () => `<script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script>`);
for (const link of [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)]) {
  const path = link[0].match(/href="([^"]+)"/)?.[1];
  if (!path) throw new Error('Missing stylesheet path');
  const css = await readFile(resolve(root, '.work/single', path.replace(/^\.\//, '')), 'utf8');
  html = html.replace(link[0], () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`);
}
const icon = `data:image/svg+xml,${encodeURIComponent(await readFile(resolve(root, 'public/icon.svg'), 'utf8'))}`;
html = html.replace(/href="(?:\.\/|\/)icon\.svg"/g, () => `href="${icon}"`);
// Keep third-party attribution inside the self-contained file without executing it.
html = html.replace('</body>', () => `<script type="text/plain" id="third-party-notices">${new TextDecoder().decode(notices).replace(/<\/script/gi, '<\\/script')}</script>\n</body>`);
if (/<(?:script|link)[^>]*(?:src|href)="(?!data:)/.test(html)) throw new Error('Single-file HTML still depends on external files.');
const bytes = Buffer.from(html);
await writeFile(resolve(output, `${name}-web.html`), bytes);
await writeFile(resolve(output, `${name}-web.html.sha256`), `${hash(bytes)}  ${name}-web.html\n`);
console.log(`Static web ZIP: ${archive.length} bytes; self-contained HTML: ${bytes.length} bytes.`);
