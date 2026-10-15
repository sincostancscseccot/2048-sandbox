import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveRelease } from './scripts/serve-release.mjs';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const server = await serveRelease(resolve(dirname(fileURLToPath(import.meta.url)), 'dist'), port, '0.0.0.0');
console.log(`2048 Sandbox ready on 0.0.0.0:${port}; Node ${process.version}.`);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
