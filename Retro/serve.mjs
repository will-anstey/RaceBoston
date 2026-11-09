// Serves Retro Race Boston to old browsers on the local network: plain
// files with Content-Length (no chunking, no gzip), listening on every
// interface so a machine on the same Ethernet can connect.
//
//   node Retro/serve.mjs [port]      (default 8000)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 8000;
const TYPES = { '.html': 'text/html', '.js': 'application/x-javascript', '.gif': 'image/gif', '.txt': 'text/plain', '.class': 'application/java-vm' };

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(root, path.normalize(p));
  const ok = file.startsWith(root) && !file.includes(`${path.sep}tools${path.sep}`) && !file.includes(`${path.sep}src${path.sep}`) && fs.existsSync(file) && fs.statSync(file).isFile();
  const body = ok ? fs.readFileSync(file) : Buffer.from('<html><body>Not found</body></html>');
  res.writeHead(ok ? 200 : 404, {
    'Content-Type': ok ? TYPES[path.extname(file)] || 'application/octet-stream' : 'text/html',
    'Content-Length': body.length,
    // Old browsers cache hard: always fetch the latest page and scripts.
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    Expires: 'Thu, 01 Jan 1970 00:00:00 GMT',
    Connection: 'close',
  });
  res.end(body);
  console.log(`${req.socket.remoteAddress} ${req.method} ${p} ${ok ? 200 : 404}`);
}).listen(port, '0.0.0.0', () => {
  console.log(`Retro Race Boston on port ${port}. On the Aptiva, open one of:`);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${port}/`);
});
