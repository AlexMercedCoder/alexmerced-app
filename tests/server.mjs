// Test-only static server. Revision/failure controls exercise real worker updates.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root = resolve('dist');
let revision = 0;
let failedAsset = '';
let disconnected = false;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4329');
  if (url.pathname === '/__test__/release' && req.method === 'POST') {
    revision += 1;
    failedAsset = url.searchParams.get('fail') || '';
    res.writeHead(200).end(String(revision));
    return;
  }
  if (url.pathname === '/__test__/network' && req.method === 'POST') {
    disconnected = url.searchParams.get('offline') === '1';
    res.writeHead(200).end();
    return;
  }
  if (disconnected) { req.socket.destroy(); return; }
  let path = resolve(root, '.' + decodeURIComponent(url.pathname));
  if (path !== root && !path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  if (!extname(path)) path = resolve(path, 'index.html');
  if (url.pathname === failedAsset) { res.writeHead(503).end('Test failure'); return; }
  try {
    let body = await readFile(path);
    if (url.pathname === '/sw.js') body = Buffer.from(body.toString().replace(/const VERSION = '([^']+)'/, `const VERSION = '$1-test-${revision}'`));
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(4329, '127.0.0.1');
