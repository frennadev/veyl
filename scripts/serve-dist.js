#!/usr/bin/env node
// Serves dist/site the way Netlify / Vercel would: the headers from dist/site/_headers (CSP, MIME, cache), clean URLs
// (/app -> app.html). Used by the e2e so proving is tested under the production CSP.  node scripts/serve-dist.js [port] [dir]
'use strict';
const http = require('http'); const fs = require('fs'); const path = require('path');
const MIME = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'application/javascript; charset=utf-8', png: 'image/png', svg: 'image/svg+xml', json: 'application/json', wasm: 'application/wasm', zkey: 'application/octet-stream', bin: 'application/octet-stream', webp: 'image/webp', ico: 'image/x-icon' };
function parseHeaders(file) {
  const rules = []; let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { cur = { pattern: line.trim(), headers: {} }; rules.push(cur); continue; }
    const i = line.indexOf(':'); cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return rules;
}
const matches = (pattern, p) => new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(p);
function serveDist(port, dir) {
  const rules = parseHeaders(path.join(dir, '_headers'));
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    let f = path.join(dir, p); if (!f.startsWith(dir)) { res.writeHead(400); return res.end(); }
    if (!fs.existsSync(f) && fs.existsSync(f + '.html')) { f += '.html'; p += '.html'; }
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory() || path.basename(f).startsWith('_')) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    const h = { 'Content-Type': MIME[path.extname(f).slice(1)] || 'application/octet-stream' };
    for (const r of rules) if (matches(r.pattern, p)) Object.assign(h, r.headers);
    res.writeHead(200, h); fs.createReadStream(f).pipe(res);
  }).listen(port);
}
module.exports = { serveDist, parseHeaders };
if (require.main === module) { const port = Number(process.argv[2] || 8873); const dir = path.resolve(process.argv[3] || path.join(__dirname, '../dist/site')); serveDist(port, dir); console.log('dist/site on http://localhost:' + port); }
