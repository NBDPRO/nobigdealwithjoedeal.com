#!/usr/bin/env node
/**
 * indexnow-ping.mjs — tells IndexNow which public pages a deploy changed.
 *
 * WHY: IndexNow (api.indexnow.org → Bing, Yandex, Seznam, Naver, Yep) is a
 * direct "this URL changed, come re-crawl it" signal, and Bing's index is what
 * ChatGPT search reads. The key file docs/b947f682ee5aa172a0005d5440a7bfcf.txt
 * has been live since 2026-08-17, but the only ping ever sent was one manual
 * curl that day (documentation/marketing/rush-week-2026-08.md). This runs from
 * .github/workflows/firebase-deploy.yml right after a successful production
 * Hosting deploy, so every shipped page change is announced automatically.
 *
 * WHAT GETS PINGED: files under docs/ that changed in the pushed commit range
 * (before..after), mapped to their canonical URL the same way
 * scripts/build-sitemap.js forms them (cleanUrls: strip .html; a directory
 * index.html is the no-slash directory URL; docs/index.html is "/"), keeping
 * only URLs that
 *   - are not under docs/pro/, docs/admin/ or docs/sites/ (private / B2B /
 *     tenant surfaces — never announced from the homeowner domain),
 *   - are listed in docs/sitemap.xml (the curated public URL set), and
 *   - carry no robots noindex meta in their <head>.
 * docs/llms.txt, docs/llms-full.txt and docs/sitemap.xml are pinged by URL when
 * they change (they are not sitemap entries themselves).
 *
 * USAGE:
 *   node scripts/indexnow-ping.mjs --before <sha> --after <sha> [--dry-run]
 *   node scripts/indexnow-ping.mjs --files docs/about.html,docs/llms.txt --dry-run
 *
 *   --dry-run   print the payload, send NOTHING.
 *   --before/--after  the push event's commit range. An all-zero --before (new
 *               branch, force push) or a before-commit that cannot be fetched
 *               is a clean SKIP (exit 0), never a guess at the range.
 *   --files     comma-separated repo-relative paths instead of a git range
 *               (local testing).
 *
 * SAFETY: this script runs `git` and `fetch` and nothing else — no firebase,
 * no deploy tooling. The workflow step is continue-on-error with a short
 * timeout: a ping failure must never fail or stall a deploy.
 *
 * Known gap: firebase-deploy.yml's concurrency group lets a newer push cancel
 * a QUEUED deploy run. The surviving run pings only its own push's range, so
 * pages changed only in a cancelled run's push are not announced (they are
 * still in the sitemap and get crawled normally).
 *
 * The pure functions are exported for tests/indexnow-ping.test.js.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const HOST = 'nobigdealwithjoedeal.com';
export const ORIGIN = 'https://' + HOST;
export const ENDPOINT = 'https://api.indexnow.org/indexnow';
export const MAX_URLS = 10000; // IndexNow's per-request cap

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

// Private, B2B and tenant surfaces. Never announced, even if one somehow
// reached the sitemap.
export const PRIVATE_PREFIXES = ['docs/pro/', 'docs/admin/', 'docs/sites/'];

// Non-page files worth a ping when they change. Not sitemap entries, so they
// bypass the sitemap-membership filter (and have no <head> to be noindexed).
export const EXTRA_FILES = {
  'docs/llms.txt': '/llms.txt',
  'docs/llms-full.txt': '/llms-full.txt',
  'docs/sitemap.xml': '/sitemap.xml',
};

const NOINDEX_RE = /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i;

export const isZeroSha = (sha) => !sha || /^0+$/.test(sha);

export function normalizeRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Repo-relative file → canonical public URL, or null when the file is not a
 * public page. String concatenation only (see build-sitemap.js's 2026-04-17
 * backslash regression note).
 */
export function fileToUrl(rel) {
  const r = normalizeRel(rel);
  if (!r.startsWith('docs/')) return null;
  if (PRIVATE_PREFIXES.some((p) => r.startsWith(p))) return null;
  if (Object.prototype.hasOwnProperty.call(EXTRA_FILES, r)) return ORIGIN + EXTRA_FILES[r];
  if (!r.endsWith('.html')) return null;
  let p = r.slice('docs/'.length, -'.html'.length);
  if (p === 'index') return ORIGIN + '/';
  if (p.endsWith('/index')) p = p.slice(0, -'/index'.length);
  return ORIGIN + '/' + p;
}

/** <loc> values of a sitemap XML string. */
export function parseSitemapLocs(xml) {
  return new Set([...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]));
}

/** True when an HTML document's <head> carries a robots noindex meta. */
export function htmlIsNoindex(html) {
  const s = String(html);
  const headEnd = s.indexOf('</head>');
  return NOINDEX_RE.test(headEnd === -1 ? s : s.slice(0, headEnd));
}

/**
 * Pure selection. changed: repo-relative paths; sitemapLocs: Set of URLs;
 * isNoindex(rel): boolean. Returns { urls, skipped: [{ file, reason }] }.
 */
export function selectUrls({ changed, sitemapLocs, isNoindex = () => false }) {
  const urls = new Set();
  const skipped = [];
  for (const raw of changed) {
    const rel = normalizeRel(raw);
    const url = fileToUrl(rel);
    if (!url) { skipped.push({ file: rel, reason: 'not a public page' }); continue; }
    if (Object.prototype.hasOwnProperty.call(EXTRA_FILES, rel)) { urls.add(url); continue; }
    if (!sitemapLocs.has(url)) { skipped.push({ file: rel, reason: 'not in sitemap.xml' }); continue; }
    if (isNoindex(rel)) { skipped.push({ file: rel, reason: 'robots noindex' }); continue; }
    urls.add(url);
  }
  const sorted = [...urls].sort();
  if (sorted.length > MAX_URLS) {
    for (const u of sorted.slice(MAX_URLS)) skipped.push({ file: u, reason: 'over the ' + MAX_URLS + '-URL cap' });
  }
  return { urls: sorted.slice(0, MAX_URLS), skipped };
}

export function buildPayload(urls, key) {
  return { host: HOST, key, keyLocation: ORIGIN + '/' + key + '.txt', urlList: urls };
}

/**
 * The key file lives at the hosting root and contains exactly its own name.
 * IndexNow keys are 8–128 chars of [A-Za-z0-9-].
 */
export function findKey(docsDir = DOCS) {
  const found = readdirSync(docsDir)
    .filter((f) => /^[A-Za-z0-9-]{8,128}\.txt$/.test(f))
    .filter((f) => readFileSync(path.join(docsDir, f), 'utf8').trim() === f.slice(0, -4));
  if (found.length !== 1) {
    throw new Error('expected exactly one IndexNow key file in docs/ (a <key>.txt containing <key>), found ' + found.length);
  }
  return found[0].slice(0, -4);
}

/* ── git + network (not unit-tested; thin) ─────────────────────────────── */

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function hasCommit(sha) {
  try { git(['cat-file', '-e', sha + '^{commit}']); return true; } catch { return false; }
}

/** Changed (added/modified) files under docs/ in before..after, or null + reason. */
function changedFilesFromGit(before, after) {
  if (isZeroSha(before)) return { files: null, reason: 'before-SHA is all zeros (new branch or first push) — no range to diff' };
  if (!/^[0-9a-f]{7,64}$/i.test(before) || !/^[0-9a-f]{7,64}$|^HEAD$/i.test(after)) {
    return { files: null, reason: 'before/after is not a commit SHA' };
  }
  // CI checks out with depth 1, so the before-commit is usually absent. A diff
  // of two commits needs only their trees, so fetching that one commit at
  // depth 1 is enough.
  if (!hasCommit(before)) {
    try { git(['fetch', '--no-tags', '--depth=1', 'origin', before]); } catch { /* handled below */ }
  }
  if (!hasCommit(before)) return { files: null, reason: 'before-commit ' + before + ' is not fetchable (force push?) — skipping' };
  const out = git(['diff', '--name-only', '--no-renames', '--diff-filter=AM', before, after, '--', 'docs/']);
  return { files: out.split('\n').map((s) => s.trim()).filter(Boolean) };
}

async function ping(payload, timeoutMs) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.text().catch(() => '');
  return { status: res.status, body: body.slice(0, 500) };
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const o = { dryRun: false, before: null, after: 'HEAD', files: null, timeoutMs: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--before') o.before = argv[++i] ?? '';
    else if (a === '--after') o.after = argv[++i] || 'HEAD';
    else if (a === '--files') o.files = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i]) || o.timeoutMs;
    else { console.error('unknown argument: ' + a + '\nusage: node scripts/indexnow-ping.mjs (--before <sha> --after <sha> | --files a,b) [--dry-run]'); process.exit(2); }
  }
  if (!o.files && o.before === null) { console.error('need --before <sha> (with --after) or --files'); process.exit(2); }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));

  let changed = o.files;
  if (!changed) {
    const r = changedFilesFromGit(o.before, o.after);
    if (!r.files) { console.log('IndexNow: SKIP — ' + r.reason); return; }
    changed = r.files;
  }

  const sitemapLocs = parseSitemapLocs(readFileSync(path.join(DOCS, 'sitemap.xml'), 'utf8'));
  const isNoindex = (rel) => {
    const abs = path.join(ROOT, normalizeRel(rel));
    return existsSync(abs) && htmlIsNoindex(readFileSync(abs, 'utf8'));
  };
  const { urls, skipped } = selectUrls({ changed, sitemapLocs, isNoindex });

  const reasons = {};
  for (const s of skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
  console.log('IndexNow: ' + changed.length + ' changed file(s) under docs/ → ' + urls.length + ' public URL(s)'
    + (skipped.length ? ' (skipped: ' + Object.entries(reasons).map(([k, v]) => v + ' ' + k).join(', ') + ')' : ''));

  if (!urls.length) { console.log('IndexNow: nothing to announce.'); return; }

  const payload = buildPayload(urls, findKey());
  if (o.dryRun) {
    console.log('IndexNow: DRY RUN — would POST to ' + ENDPOINT + ':');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const { status, body } = await ping(payload, o.timeoutMs);
  // 200 OK and 202 Accepted are both success (202 = key validation pending).
  if (status === 200 || status === 202) {
    console.log('IndexNow: HTTP ' + status + ' — ' + urls.length + ' URL(s) submitted.');
    for (const u of urls) console.log('  ' + u);
    return;
  }
  console.error('::warning::IndexNow ping returned HTTP ' + status + (body ? ': ' + body : ''));
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error('::warning::IndexNow ping failed: ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}
