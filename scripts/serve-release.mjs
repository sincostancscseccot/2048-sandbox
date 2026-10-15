import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
const inside = (root, path) => { const name = relative(root, path); return name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name); };

export async function serveRelease(directory, port = 4173, hostname = '127.0.0.1') {
  const root = await realpath(directory);
  if (!(await stat(resolve(root, 'index.html'))).isFile()) throw new Error('dist/index.html is missing. Build or extract the complete release first.');
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const fail = (status, message) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(request.method === 'HEAD' ? undefined : message); };
    if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); fail(405, 'Method not allowed'); return; }
    try {
      const path = decodeURIComponent((request.url ?? '/').split(/[?#]/, 1)[0]);
      if (!path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.')) { fail(400, 'Invalid path'); return; }
      let file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
      if (!inside(root, file)) { fail(400, 'Invalid path'); return; }
      let info;
      try { info = await stat(file); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      if (!info?.isFile()) {
        if (!extname(path) && request.headers.accept?.includes('text/html')) { file = resolve(root, 'index.html'); info = await stat(file); }
        else { fail(404, 'File not found'); return; }
      }
      file = await realpath(file);
      if (!inside(root, file)) { fail(404, 'File not found'); return; }
      const immutable = path.startsWith('/assets/') && /-[\w-]{8,}\.(js|css|woff2)$/.test(path);
      response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size,
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
      if (request.method === 'HEAD') response.end();
      else { const stream = createReadStream(file); stream.on('error', () => response.destroy()); stream.pipe(response); }
    } catch (error) { if (error instanceof URIError) fail(400, 'Invalid path'); else fail(500, 'Unable to read application file'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, hostname, resolve); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--port')) throw new Error('Usage: node scripts/serve-release.mjs [--port 4173]');
    const port = args.length ? Number(args[1]) : 4173;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer from 1024 to 65535.');
    const server = await serveRelease(resolve(dirname(fileURLToPath(import.meta.url)), '../dist'), port);
    console.log(`2048 Sandbox is ready: http://127.0.0.1:${port}/\nKeep this window open while playing. Ctrl+C stops the local server.`);
    process.once('SIGINT', () => server.close()); process.once('SIGTERM', () => server.close());
  } catch (error) { console.error(error.code === 'EADDRINUSE' ? 'This port is already in use. Close the previous local server and try again.' : error.message); process.exitCode = 1; }
}
