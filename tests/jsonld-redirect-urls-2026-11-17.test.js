/**
 * tests/jsonld-redirect-urls-2026-11-17.test.js — no structured-data URL on a
 * public page points at a firebase.json redirect source.
 *
 * WHY (2026-11-17 sweep, finding #19): 12 town service pages carried a
 * BreadcrumbList whose position-2 parent was /services/hail-damage (301 to
 * /services/hail-damage-insurance-claim) or /services/storm-damage-insurance-claim
 * (301 to /services/storm-damage), while the visible breadcrumb on the same
 * page linked the real hub. Google reads the marked-up trail, so it was being
 * fed a redirect hop and a trail that disagreed with the page.
 *
 * HOW: walk every .html under docs/ except docs/pro/, parse each
 * application/ld+json block, collect every "item" / "url" / "@id" string that
 * resolves to this site, and fail if its path matches any hosting redirect
 * source (Firebase glob: ** spans segments, * stays inside one). A redirect to
 * an external host (e.g. /r, /yardsign) is a deliberate short link, so it is
 * still a redirect and still not a valid structured-data URL.
 *
 * Run: node tests/jsonld-redirect-urls-2026-11-17.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const ORIGIN = 'https://nobigdealwithjoedeal.com';
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor']);

let failed = 0;
function ok(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); return; }
  failed++;
  console.log('  FAIL ' + name + (detail ? '\n       ' + detail : ''));
}

/** Firebase hosting glob -> RegExp. ** spans segments; * stays in one. */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { out += '.*'; i++; continue; }
    if (c === '*') { out += '[^/]*'; continue; }
    out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

function redirectMatchers(firebaseJson) {
  const hostings = Array.isArray(firebaseJson.hosting) ? firebaseJson.hosting : [firebaseJson.hosting];
  const out = [];
  for (const h of hostings) {
    for (const r of h.redirects || []) {
      if (r.source) out.push({ source: r.source, re: globToRegExp(r.source) });
      else if (r.regex) out.push({ source: 'regex:' + r.regex, re: new RegExp(r.regex) });
    }
  }
  return out;
}

/** The JSON bodies of every <script type="application/ld+json"> block. */
function jsonLdBlocks(html) {
  const blocks = [];
  let at = 0;
  for (;;) {
    const open = html.indexOf('<script', at);
    if (open < 0) break;
    const tagEnd = html.indexOf('>', open);
    if (tagEnd < 0) break;
    const close = html.indexOf('</script>', tagEnd);
    if (close < 0) break;
    const tag = html.slice(open, tagEnd + 1).toLowerCase();
    if (tag.indexOf('application/ld+json') >= 0) blocks.push(html.slice(tagEnd + 1, close));
    at = close + 9;
  }
  return blocks;
}

/** Every "item" / "url" / "@id" string value anywhere in a parsed JSON-LD tree. */
function linkedUrls(node, out) {
  out = out || [];
  if (Array.isArray(node)) { for (const n of node) linkedUrls(n, out); return out; }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if ((k === 'item' || k === 'url' || k === '@id') && typeof v === 'string') out.push(v);
      else linkedUrls(v, out);
    }
  }
  return out;
}

/** Path on this site for a URL, or null for another host. Fragments dropped. */
function sitePath(u) {
  let parsed;
  try { parsed = new URL(u, ORIGIN + '/'); } catch (_) { return null; }
  if (parsed.origin !== ORIGIN && parsed.origin !== 'https://www.nobigdealwithjoedeal.com') return null;
  return parsed.pathname;
}

function offenders(html, matchers) {
  const bad = [];
  for (const body of jsonLdBlocks(html)) {
    let data;
    try { data = JSON.parse(body); } catch (_) { continue; }
    for (const u of linkedUrls(data)) {
      const p = sitePath(u);
      if (p === null) continue;
      const m = matchers.find((x) => x.re.test(p));
      if (m) bad.push(u + '  (redirect source ' + m.source + ')');
    }
  }
  return bad;
}

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (r === 'pro') continue;
      walk(path.join(dir, e.name), r, out);
    } else if (e.name.endsWith('.html')) out.push(r);
  }
  return out;
}

const matchers = redirectMatchers(JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')));

console.log('\nmatcher behaviour');
const fixture = redirectMatchers({ hosting: { redirects: [
  { source: '/services/hail-damage' },
  { source: '/services/hail-damage-insurance-claim-mason-oh*' },
  { source: '/sites/t/oaks/**' },
] } });
const page = (item) => '<script type="application/ld+json">' + JSON.stringify({
  '@type': 'BreadcrumbList',
  itemListElement: [{ '@type': 'ListItem', position: 2, name: 'X', item: item }],
}) + '</script>';
ok('a parent crumb on an exact redirect source is caught',
  offenders(page(ORIGIN + '/services/hail-damage'), fixture).length === 1);
ok('the redirect target itself passes',
  offenders(page(ORIGIN + '/services/hail-damage-insurance-claim'), fixture).length === 0);
ok('a single * matches the .html twin but not a deeper path',
  offenders(page(ORIGIN + '/services/hail-damage-insurance-claim-mason-oh.html'), fixture).length === 1
  && offenders(page(ORIGIN + '/services/hail-damage-insurance-claim-mason-oh/x'), fixture).length === 0);
ok('** spans segments',
  offenders(page(ORIGIN + '/sites/t/oaks/a/b'), fixture).length === 1);
ok('another host is ignored',
  offenders(page('https://example.com/services/hail-damage'), fixture).length === 0);
ok('a url nested in a Service/provider node is checked too',
  offenders('<script type="application/ld+json">' + JSON.stringify({ '@type': 'Service', provider: { url: ORIGIN + '/services/hail-damage' } }) + '</script>', fixture).length === 1);

console.log('\npublic pages (docs/ minus docs/pro)');
const files = walk(DOCS, '', []);
ok('found public pages to scan (' + files.length + ')', files.length > 100);
const hits = [];
for (const f of files) {
  for (const b of offenders(fs.readFileSync(path.join(DOCS, f), 'utf8'), matchers)) hits.push(f + ': ' + b);
}
ok('no JSON-LD item/url/@id points at a redirect source', hits.length === 0, hits.join('\n       '));

console.log(failed ? '\n' + failed + ' failed' : '\nall passed');
process.exit(failed ? 1 : 0);
