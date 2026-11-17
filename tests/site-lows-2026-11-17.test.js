/**
 * tests/site-lows-2026-11-17.test.js — two low findings from the 2026-11-17
 * sweep on the public site.
 *
 * #20 /sites (docs/sites/index.html)
 *   - Its canonical was https://nobigdealwithjoedeal.com/sites/ . Hosting runs
 *     trailingSlash:false, so that URL 301s to /sites: the page named a
 *     redirect as its own canonical. Guarded sitewide: no public page's
 *     canonical (or og:url) path may end in "/" except the root.
 *   - A dead .frame-cta rule still carried the retired orange #e8720c
 *     (DESIGN.md: never reintroduce it). No element used the class.
 *
 * #21 /visualizer: the "Anything else" question label had no for=, so the
 *   additionalNotes textarea had no programmatic label (screen readers read
 *   an unnamed text box). The label must point at the textarea.
 *
 * Run: node tests/site-lows-2026-11-17.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor']);

let failed = 0;
function ok(name, cond, detail) {
  if (cond) { console.log('  ok  ' + name); return; }
  failed++;
  console.log('  FAIL ' + name + (detail ? '\n       ' + detail : ''));
}

/** Every start tag named `name`, as an attribute map. */
function tags(html, name) {
  const out = [];
  const lower = html.toLowerCase();
  let at = 0;
  for (;;) {
    const i = lower.indexOf('<' + name, at);
    if (i < 0) break;
    const end = html.indexOf('>', i);
    if (end < 0) break;
    const next = lower[i + name.length + 1];
    if (next === ' ' || next === '>' || next === '\n' || next === '\r' || next === '\t' || next === '/') {
      const attrs = {};
      const src = html.slice(i + name.length + 1, end);
      const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m;
      while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4];
      out.push(attrs);
    }
    at = end + 1;
  }
  return out;
}

/** The <style> bodies of a page, joined. */
function styleText(html) {
  const lower = html.toLowerCase();
  let out = '';
  let at = 0;
  for (;;) {
    const i = lower.indexOf('<style', at);
    if (i < 0) break;
    const open = html.indexOf('>', i);
    const close = lower.indexOf('</style>', open);
    if (open < 0 || close < 0) break;
    out += html.slice(open + 1, close) + '\n';
    at = close + 8;
  }
  return out;
}

/** Public page URLs (canonical + og:url) whose path ends in a slash. */
function slashUrls(html) {
  const urls = [];
  for (const l of tags(html, 'link')) if ((l.rel || '').toLowerCase() === 'canonical' && l.href) urls.push(l.href);
  for (const m of tags(html, 'meta')) if (m.property === 'og:url' && m.content) urls.push(m.content);
  return urls.filter((u) => {
    try { const p = new URL(u).pathname; return p !== '/' && p.endsWith('/'); } catch (_) { return false; }
  });
}

function walk(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (r !== 'pro') walk(path.join(dir, e.name), r, out); }
    else if (e.name.endsWith('.html')) out.push(r);
  }
  return out;
}

console.log('\nhelper behaviour');
ok('a trailing-slash canonical is caught, the root is not',
  slashUrls('<link rel="canonical" href="https://x.com/sites/"><meta property="og:url" content="https://x.com/">').length === 1);
ok('a slashless canonical passes',
  slashUrls('<link rel="canonical" href="https://x.com/sites">').length === 0);

console.log('\n#20 canonical never names a trailing-slash URL (trailingSlash:false 301s it)');
const hits = [];
for (const f of walk(DOCS, '', [])) {
  for (const u of slashUrls(fs.readFileSync(path.join(DOCS, f), 'utf8'))) hits.push(f + ': ' + u);
}
ok('no public canonical / og:url path ends in "/" except the root', hits.length === 0, hits.join('\n       '));

const sites = fs.readFileSync(path.join(DOCS, 'sites', 'index.html'), 'utf8');
const canon = tags(sites, 'link').filter((l) => (l.rel || '').toLowerCase() === 'canonical').map((l) => l.href);
ok('/sites canonical is https://nobigdealwithjoedeal.com/sites', canon.length === 1 && canon[0] === 'https://nobigdealwithjoedeal.com/sites', JSON.stringify(canon));

console.log('\n#20 /sites carries no retired orange and no dead .frame-cta rule');
const css = styleText(sites);
ok('no #e8720c in /sites styles', !/#e8720c/i.test(css));
ok('no .frame-cta rule left in /sites styles', !/\.frame-cta\b/.test(css));

console.log('\n#21 visualizer "Anything else" textarea has a programmatic label');
const viz = fs.readFileSync(path.join(DOCS, 'visualizer.html'), 'utf8');
ok('the additionalNotes textarea exists', tags(viz, 'textarea').some((t) => t.id === 'additionalNotes'));
ok('a <label for="additionalNotes"> names it', tags(viz, 'label').some((l) => l.for === 'additionalNotes'));

console.log(failed ? '\n' + failed + ' failed' : '\nall passed');
process.exit(failed ? 1 : 0);
