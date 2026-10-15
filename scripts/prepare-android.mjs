import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const marker = JSON.parse(await readFile(resolve(root, '.work/android-web/build-info.json'), 'utf8'));
if (marker.version !== pkg.version || marker.target !== 'android') throw new Error('Build matching Android web assets first.');
const release = unzipSync(new Uint8Array(await readFile(resolve(root, `release/2048-sandbox-v${pkg.version}.zip`))));
const notices = release[`2048-sandbox-v${pkg.version}/THIRD_PARTY_NOTICES.txt`];
if (!notices) throw new Error('Build the local release with third-party notices first.');
const androidNotices = await readFile(resolve(root, 'android/THIRD_PARTY_NOTICES.txt'), 'utf8');
await writeFile(resolve(root, '.work/android-web/THIRD_PARTY_NOTICES.txt'), Buffer.concat([notices, Buffer.from('\n\n' + androidNotices)]));
console.log(`Prepared offline Android assets v${pkg.version} and license texts.`);
