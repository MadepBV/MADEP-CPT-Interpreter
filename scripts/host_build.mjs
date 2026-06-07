// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal static server for the adapter-static build/ output (correct MIME for ES
// modules and wasm, with SvelteKit prerendered-route fallback). Dependency-free.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = normalize(new URL('../build', import.meta.url).pathname);
const PORT = Number(process.env.PORT) || 5175;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.txt': 'text/plain'
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    const candidates = [file, file + '.html', join(ROOT, p, 'index.html')];
    for (const c of candidates) {
      try {
        const data = await readFile(c);
        res.writeHead(200, { 'Content-Type': MIME[extname(c)] || 'application/octet-stream' });
        return res.end(data);
      } catch { /* next candidate */ }
    }
    // SPA fallback to root index.html
    try {
      const data = await readFile(join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(data);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`serving ${ROOT} on 0.0.0.0:${PORT}`));
