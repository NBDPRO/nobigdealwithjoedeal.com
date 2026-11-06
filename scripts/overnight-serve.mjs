#!/usr/bin/env node
/**
 * scripts/overnight-serve.mjs — zero-dependency static server for docs/ that
 * mimics Firebase Hosting cleanUrls (/about -> about.html, /dir -> dir/index.html)
 * and the cache/compression-free essentials, for local Lighthouse / Playwright runs.
 *
 *   node scripts/overnight-serve.mjs [--port 8080] [--root docs]
 *
 * Read-only: serves files, never writes. Responds with gzip for text types so
 * Lighthouse transfer sizes resemble production (Firebase Hosting compresses).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const port = Number(arg('--port', 8080));
const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '..', arg('--root', 'docs'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.avif': 'image/avif', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const COMPRESS = new Set(['.html', '.css', '.js', '.mjs', '.json', '.svg', '.xml', '.txt', '.webmanifest']);

async function isFile(p) { try { return (await stat(p)).isFile(); } catch { return false; } }

async function resolveFile(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const base = join(root, clean);
  if (base !== root && !base.startsWith(root + sep)) return null;
  if (await isFile(base)) return base;
  if (await isFile(base + '.html')) return base + '.html';
  if (await isFile(join(base, 'index.html'))) return join(base, 'index.html');
  return null;
}

createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    let file = await resolveFile(u.pathname);
    let status = 200;
    if (!file) { file = join(root, '404.html'); status = 404; if (!(await isFile(file))) { res.writeHead(404); return res.end('Not found'); } }
    const ext = extname(file).toLowerCase();
    let body = await readFile(file);
    const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' };
    if (COMPRESS.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      body = gzipSync(body); headers['Content-Encoding'] = 'gzip'; headers['Vary'] = 'Accept-Encoding';
    }
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500); res.end(String(e && e.message || e));
  }
}).listen(port, '127.0.0.1', () => console.log('serving ' + root + ' on http://127.0.0.1:' + port));
