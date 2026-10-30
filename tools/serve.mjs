// Minimal static file server (no dependencies) with gzip for JSON/JS.
//
//   node tools/serve.mjs [port]
//
// Any static server works (e.g. `python3 -m http.server 8080`); this one just
// compresses the 11 MB map and 3 MB terrain files so they load faster.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
const gzCache = new Map();

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    const canGzip = /gzip/.test(req.headers['accept-encoding'] || '') && ['.json', '.js', '.css', '.html', '.bin'].includes(ext);
    if (canGzip) {
      const key = file + ':' + st.mtimeMs;
      let body = gzCache.get(key);
      if (!body) { body = zlib.gzipSync(fs.readFileSync(file), { level: 6 }); gzCache.set(key, body); }
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': body.length, 'X-Raw-Length': st.size });
      res.end(body);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    }
  });
});
server.listen(port, () => console.log(`Race Boston running at http://localhost:${port}`));
