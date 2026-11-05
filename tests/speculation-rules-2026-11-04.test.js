/**
 * tests/speculation-rules-2026-11-04.test.js — prerender-on-hover for the
 * public site, from documentation/audit/GITHUB-REPO-SWEEP-2026-11-04.md.
 *
 *   1. firebase.json: the `**` rule sends Speculation-Rules: "/speculation.json"
 *      and the LAST rule for /speculation.json serves it as
 *      application/speculationrules+json (Chrome ignores any other type)
 *   2. docs/speculation.json: prerender, document source, eagerness moderate
 *   3. which links it prerenders: public pages yes; /pro, /admin, /dev, /sites,
 *      deal/share/report/api, /inspect, /book, the off-site redirects and PDFs
 *      never (matched the way Chrome's URLPattern does; cross-checked against
 *      the real URLPattern when this Node has it)
 *   4. @view-transition in the stylesheet every public page loads, behind
 *      prefers-reduced-motion: no-preference
 *   5. the outbound link check workflow stays report-only and pinned
 *
 * The Clarity loader's prerender guard is tested in clarity-2026-10-01.test.js.
 *
 * Run: node tests/speculation-rules-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('\n1. firebase.json headers');
{
  const headers = JSON.parse(read('firebase.json')).hosting.headers;
  const star = headers.find((h) => h.source === '**');
  const sr = star && star.headers.find((x) => x.key === 'Speculation-Rules');
  ok('the ** rule sends Speculation-Rules as a quoted structured-field string', !!sr && sr.value === '"/speculation.json"', sr && sr.value);
  const ctRules = headers.filter((h) => h.headers.some((x) => x.key === 'Content-Type'));
  const last = ctRules[ctRules.length - 1];
  ok('the last Content-Type rule is /speculation.json -> application/speculationrules+json',
    !!last && last.source === '/speculation.json' && last.headers.find((x) => x.key === 'Content-Type').value === 'application/speculationrules+json');
  ok('no rule after it re-sets Content-Type on ** (last-match-wins)', headers.indexOf(last) > headers.indexOf(star));
}

console.log('\n2. speculation.json shape');
const rules = JSON.parse(read('docs/speculation.json'));
const rule = rules.prerender && rules.prerender[0];
ok('one prerender rule, document source, eagerness moderate', !!rule && rules.prerender.length === 1 && rule.source === 'document' && rule.eagerness === 'moderate');
ok('no prefetch-only or immediate rules slipped in', Object.keys(rules).join() === 'prerender');

console.log('\n3. which links get prerendered');
{
  const and = rule.where.and;
  const include = and.find((c) => c.href_matches).href_matches;
  const exclude = and.find((c) => c.not && c.not.href_matches).not.href_matches;
  const selector = (and.find((c) => c.not && c.not.selector_matches) || { not: {} }).not.selector_matches || '';
  const all = [include].concat(exclude);
  // Only plain paths with * wildcards, so the matcher below is faithful to
  // URLPattern (a pathname-only pattern leaves search and hash as wildcards).
  ok('patterns use only paths and * (no regex groups the local matcher would misread)', all.every((p) => /^\/[A-Za-z0-9/._*-]*$/.test(p)), all.join(' '));
  const toRe = (p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const hit = (p, url) => toRe(p).test(new URL(url, 'https://nobigdealwithjoedeal.com').pathname);
  const prerendered = (url) => hit(include, url) && !exclude.some((p) => hit(p, url));

  for (const u of ['/', '/services/roof-replacement', '/blog/roof-age', '/our-work', '/areas/mason-oh', '/free-tools', '/estimate', '/credentials', '/services/financing?x=1', '/process', '/inspection-checklist']) {
    ok('prerenders ' + u, prerendered(u));
  }
  for (const u of ['/pro', '/pro/dashboard', '/pro/login?next=/pro', '/admin', '/admin/analytics', '/dev/x', '/sites/oaks', '/sites/t/acme',
    '/deal/abc', '/share/abc', '/report/abc/file', '/api/site-config', '/cspReport',
    '/inspect', '/inspect?src=nav', '/inspect.html', '/book', '/book/', '/r', '/yardsign', '/guides/storm-checklist.pdf']) {
    ok('never prerenders ' + u, !prerendered(u));
  }
  ok('a page can opt a link out with data-no-prerender; download links are skipped', /\[data-no-prerender\]/.test(selector) && /\[download\]/.test(selector));

  if (typeof URLPattern === 'function') {
    const base = 'https://nobigdealwithjoedeal.com/';
    const probe = ['/pro/dashboard?a=1#x', '/inspect?src=nav', '/blog/x', '/x.pdf', '/book', '/bookshelf'];
    const agree = all.every((p) => probe.every((u) => new URLPattern(p, base).test(base.slice(0, -1) + u) === hit(p, u)));
    ok('local matcher agrees with the real URLPattern on every pattern', agree);
  } else {
    console.log('  - URLPattern not in Node ' + process.version + '; local matcher only');
  }
}

console.log('\n4. view transitions');
{
  const css = read('docs/assets/css/nbd-fonts.css');
  ok('nbd-fonts.css opts every page into cross-document view transitions, motion-safe only',
    /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*@view-transition\s*\{\s*navigation:\s*auto;\s*\}\s*\}/.test(css));
}

console.log('\n5. outbound link check workflow');
{
  const wf = read('.github/workflows/link-check.yml');
  ok('runs weekly', /cron: '\d+ \d+ \* \* \d'/.test(wf));
  ok('report-only (fail: false)', /^\s*fail: false\s*$/m.test(wf));
  ok('caches .lycheecache', /--cache\b/.test(wf) && /path: \.lycheecache/.test(wf));
  ok('checks docs/**/*.html and skips our own domain', /'docs\/\*\*\/\*\.html'/.test(wf) && /nobigdealwithjoedeal\\\.com/.test(wf));
  ok('third-party actions pinned to a commit SHA', /lycheeverse\/lychee-action@[0-9a-f]{40}\b/.test(wf) && /actions\/cache@[0-9a-f]{40}\b/.test(wf));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
