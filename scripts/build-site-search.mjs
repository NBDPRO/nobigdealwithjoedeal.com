#!/usr/bin/env node
/**
 * scripts/build-site-search.mjs — the homeowner site's search index
 * (Pagefind 1.5.2, MIT; repos report 2026-10-16 item 7).
 *
 * Indexes EXACTLY the pages docs/sitemap.xml lists: the public homeowner
 * site. /pro, /admin, /sites, /dev, /tools and every noindex page are never
 * in the sitemap, and are refused here a second time by path and by the
 * robots meta, so the CRM can never leak into public search. Nav, header,
 * footer, the mobile CTA bar and forms are left out of what is indexed.
 *
 * Output: docs/pagefind/ (gitignored). Built at deploy time
 * (firebase-deploy.yml) and in CI before the search specs (ci.yml
 * public-e2e). The /search page loads it; its CSP alone carries
 * 'wasm-unsafe-eval' (firebase.json), which Pagefind's WebAssembly needs.
 *
 * Usage:
 *   node scripts/build-site-search.mjs --install   # fetch the pinned pagefind
 *   node scripts/build-site-search.mjs             # build docs/pagefind
 *   node scripts/build-site-search.mjs --list      # print what would be indexed
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

export const PAGEFIND_VERSION = '1.5.2';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(REPO, 'docs');
const ORIGIN = 'https://nobigdealwithjoedeal.com';
export const PRIVATE_PREFIXES = ['/pro', '/admin', '/sites', '/dev', '/tools', '/pagefind', '/search'];
export const EXCLUDE_SELECTORS = ['nav', 'header', 'footer', 'form', '.mobile-cta', '.nbd-mobile-cta', '[data-pagefind-ignore]', 'script', 'style', 'noscript'];
const NOINDEX_RE = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i;

function installDir() { return path.join(os.tmpdir(), 'nbd-pagefind-' + PAGEFIND_VERSION); }

/** Sitemap URL path -> the file Hosting serves for it (cleanUrls). */
export function fileFor(urlPath) {
  const p = decodeURIComponent(urlPath).replace(/\/+$/, '');
  if (p === '') return path.join(DOCS, 'index.html');
  for (const f of [path.join(DOCS, p + '.html'), path.join(DOCS, p, 'index.html')]) if (fs.existsSync(f)) return f;
  return null;
}

export function isPrivate(urlPath) {
  return PRIVATE_PREFIXES.some((x) => urlPath === x || urlPath.startsWith(x + '/') || urlPath.startsWith(x + '.'));
}

/** [{ url, file }] for every public page in the sitemap. */
export function publicPages(sitemapXml) {
  const out = [];
  for (const m of sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const loc = m[1].trim();
    if (!loc.startsWith(ORIGIN)) continue;
    const urlPath = loc.slice(ORIGIN.length) || '/';
    if (isPrivate(urlPath)) continue;
    const file = fileFor(urlPath);
    if (!file || !file.endsWith('.html')) continue;
    out.push({ url: urlPath, file });
  }
  return out;
}

async function loadPagefind() {
  const dirs = [process.env.NBD_PAGEFIND_DIR, installDir(), path.join(REPO, 'tests')].filter(Boolean);
  for (const d of dirs) {
    const pj = path.join(d, 'node_modules', 'pagefind', 'package.json');
    if (!fs.existsSync(pj)) continue;
    const v = JSON.parse(fs.readFileSync(pj, 'utf8')).version;
    if (v !== PAGEFIND_VERSION) throw new Error('pagefind at ' + d + ' is ' + v + ', pinned ' + PAGEFIND_VERSION);
    return import(pathToFileURL(path.join(d, 'node_modules', 'pagefind', 'lib', 'index.js')).href);
  }
  return null;
}

async function main(argv) {
  if (argv.includes('--install')) {
    fs.mkdirSync(installDir(), { recursive: true });
    execSync('npm install --no-save --no-package-lock --no-audit --no-fund --silent --prefix "' + installDir() + '" pagefind@' + PAGEFIND_VERSION, { stdio: 'inherit', shell: true });
    console.log('pagefind ' + PAGEFIND_VERSION + ' installed in ' + installDir());
    return 0;
  }
  const pages = publicPages(fs.readFileSync(path.join(DOCS, 'sitemap.xml'), 'utf8'));
  if (argv.includes('--list')) { pages.forEach((p) => console.log(p.url)); console.log(pages.length + ' pages'); return 0; }
  const pagefind = await loadPagefind();
  if (!pagefind) { console.error('pagefind ' + PAGEFIND_VERSION + ' not installed: node scripts/build-site-search.mjs --install'); return 2; }
  const { index, errors } = await pagefind.createIndex({ excludeSelectors: EXCLUDE_SELECTORS, forceLanguage: 'en' });
  if (!index) { console.error('pagefind: ' + (errors || []).join('; ')); return 1; }
  let added = 0, skipped = 0;
  for (const p of pages) {
    const html = fs.readFileSync(p.file, 'utf8');
    if (NOINDEX_RE.test(html)) { skipped++; continue; }
    const r = await index.addHTMLFile({ url: p.url, content: html });
    if (r.errors && r.errors.length) { console.error('pagefind ' + p.url + ': ' + r.errors.join('; ')); return 1; }
    added++;
  }
  const out = path.join(DOCS, 'pagefind');
  fs.rmSync(out, { recursive: true, force: true });
  const w = await index.writeFiles({ outputPath: out });
  if (w.errors && w.errors.length) { console.error('pagefind write: ' + w.errors.join('; ')); return 1; }
  await pagefind.close();
  console.log('site search: indexed ' + added + ' public pages (' + skipped + ' noindex skipped) -> docs/pagefind');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
