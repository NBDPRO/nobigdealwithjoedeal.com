/* tests/lib/demo-hosting-server.js
 *
 * A small static server over docs/ that behaves like Firebase Hosting for the
 * parts the sample account (Pro demo phase 2) depends on, driven by
 * firebase.json itself:
 *   - cleanUrls (/x serves x.html, /x.html 301s to /x, /dir serves dir/index.html)
 *   - the non-function rewrites (/pro/explore/dashboard -> /pro/dashboard.html)
 *   - the EFFECTIVE response headers per path, via tests/lib/hosting-headers.js
 *     (the Hosting emulator serves none of firebase.json's headers, so a CSP
 *     test against it would test nothing)
 *   - function rewrites (/api/**, /cspReport, ...) answer 502 and are recorded,
 *     so a test can fail on any attempt to reach a server function.
 *
 * Every request is recorded in server.log as { method, path, status, kind }.
 *
 * Standalone (for a manual look): node tests/lib/demo-hosting-server.js [port]
 * Zero dependencies.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { effectiveHeaders, globMatches } = require('./hosting-headers');

const ROOT = path.join(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.xml': 'application/xml', '.mp4': 'video/mp4', '.pdf': 'application/pdf'
};

function loadHosting() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')).hosting;
}

function fileFor(p) {
  const abs = path.join(DOCS, p);
  if (!abs.startsWith(DOCS)) return null;
  try { const st = fs.statSync(abs); if (st.isFile()) return abs; } catch (_) {}
  return null;
}

// Resolve a request pathname the way Hosting does (cleanUrls, trailingSlash:false).
function resolve(hosting, pathname) {
  if (/\.html$/.test(pathname)) {
    const clean = pathname.replace(/\/index\.html$/, '') .replace(/\.html$/, '') || '/';
    return { redirect: clean };
  }
  let f = fileFor(pathname);
  if (f) return { file: f };
  f = fileFor(pathname + '.html');
  if (f) return { file: f };
  f = fileFor(path.posix.join(pathname, 'index.html'));
  if (f) return { file: f };
  for (const rw of hosting.rewrites || []) {
    if (!rw.source || !globMatches(rw.source, pathname)) continue;
    if (rw.function || rw.run) return { fn: rw.function ? rw.function.functionId || rw.function : rw.run };
    if (rw.destination) { const d = fileFor(rw.destination); if (d) return { file: d, rewrite: rw.destination }; }
  }
  return { notFound: true };
}

function start(opts) {
  const o = opts || {};
  const hosting = loadHosting();
  const log = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(u.pathname);
    const r = resolve(hosting, pathname);
    const hdrs = effectiveHeaders(hosting, pathname);
    const send = (status, body, type, kind) => {
      for (const [, h] of hdrs) {
        // HSTS on plain-http localhost would only confuse a browser profile.
        if (/^strict-transport-security$/i.test(h.key)) continue;
        res.setHeader(h.key, h.value);
      }
      if (type) res.setHeader('Content-Type', type);
      res.statusCode = status;
      log.push({ method: req.method, path: pathname, search: u.search, status, kind });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (r.redirect) { res.setHeader('Location', r.redirect + u.search); return send(301, '', null, 'redirect'); }
    if (r.fn) return send(502, 'function rewrite (' + r.fn + ') is not served here', 'text/plain', 'function');
    if (r.notFound) {
      const nf = fileFor('/404.html');
      return send(404, nf ? fs.readFileSync(nf) : 'not found', 'text/html; charset=utf-8', 'missing');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'static only', 'text/plain', 'write');
    const ext = path.extname(r.file).toLowerCase();
    return send(200, fs.readFileSync(r.file), MIME[ext] || 'application/octet-stream', r.rewrite ? 'rewrite' : 'static');
  });
  return new Promise((resolveP) => {
    server.listen(o.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolveP({ server, port, origin: 'http://127.0.0.1:' + port, log, close: () => new Promise((r2) => server.close(r2)) });
    });
  });
}

module.exports = { start, resolve };

if (require.main === module) {
  start({ port: Number(process.argv[2]) || 5055 }).then((s) => {
    console.log('demo hosting sim on ' + s.origin + '  (sample account: ' + s.origin + '/pro/explore)');
  });
}
