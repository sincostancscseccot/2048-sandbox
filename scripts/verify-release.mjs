import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
try {
  const manifest = JSON.parse(await readFile(resolve(root, 'release-manifest.json'), 'utf8'));
  if (manifest.format !== '2048-sandbox-local-release' || manifest.formatVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid release manifest.');
  const names = new Set();
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || item.path.includes('\\') || item.path.split('/').some(part => !part || part === '.' || part === '..') || names.has(item.path)) throw new Error('Invalid or duplicate release path.');
    const file = await realpath(resolve(root, item.path)), path = relative(root, file);
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw new Error('Release file escaped the application folder.');
    const bytes = await readFile(file);
    if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`File changed or incomplete: ${item.path}`);
    names.add(item.path);
  }
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(resolve(directory, entry.name), name + '/');
      else if (name !== 'release-manifest.json' && !names.has(name)) throw new Error(`Unexpected release file: ${name}`);
    }
  }
  await walk(root);
  console.log(`Verified 2048 Sandbox v${manifest.appVersion}: ${names.size} files.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
