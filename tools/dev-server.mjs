// Zero-dependency static file server for local development.
//   node tools/dev-server.mjs [port]
// The site itself has no build step; this only exists because ES modules
// don't load from file:// URLs.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 5500);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  // Only found in the Android app's offline bundle (android/app/src/main/assets/www).
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
};

http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, rel);
  // Never serve anything outside the project folder.
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`LoL Sound Quiz dev server: http://localhost:${PORT}`);
});
