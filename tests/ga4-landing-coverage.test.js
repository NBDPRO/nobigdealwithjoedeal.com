/**
 * tests/ga4-landing-coverage.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Until 2026-09-04 the 164 service/area landing pages — the pages that earn
 * organic leads — loaded no GA4 tag at all, while the homepage did. Nothing
 * noticed for months because nothing asserted coverage: a page can be
 * perfectly valid HTML, pass every SEO check, and simply not be measured.
 * This pins that every in-scope public page carries exactly one GA4 loader
 * plus the external (CSP-safe) init script, that the init script really
 * configures the property, and that the CSP allows both hosts. It also
 * proves scripts/add-ga4-tag.js can go RED (a page without the tag) and is
 * idempotent (a page with the tag is left alone), so `--check` is a gate and
 * not a rubber stamp.
 *
 * Pure-Node. Run: node tests/ga4-landing-coverage.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const tool = require(path.join(ROOT, 'scripts', 'add-ga4-tag.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

console.log('\nTHE CODEMOD CAN FAIL — and leaves a tagged page alone');
{
  const bare = '<!doctype html><html><head><title>x</title>\n<link rel="stylesheet" href="/a.css">\n</head><body></body></html>';
  const out = tool.addTag(bare);
  ok('a page without the tag gets the loader + init inserted before </head>', out && out.includes(tool.LOADER_LINE + '\n' + tool.INIT_LINE + '\n</head>'));
  ok('…exactly once', out && (out.match(/gtag\/js\?id=/g) || []).length === 1);
  ok('a page that already has a loader is returned null (idempotent)', tool.addTag(out) === null);
  ok('a page with any G-XXXX loader (even a different property) is left alone, never double-tagged',
     tool.addTag('<head><script async src="https://www.googletagmanager.com/gtag/js?id=G-OTHER1"></script></head>') === null);
  const crlf = bare.replace(/\n/g, '\r\n');
  const outCrlf = tool.addTag(crlf);
  ok('CRLF pages get CRLF insertions (no mixed endings)', outCrlf && outCrlf.includes(tool.LOADER_LINE + '\r\n' + tool.INIT_LINE + '\r\n</head>') && !/[^\r]\n/.test(outCrlf));
  ok('a page with no </head> is refused (null), not mangled', tool.addTag('<html><body></body></html>') === null);
  ok('a page with two </head> is refused', tool.addTag('<head></head><head></head>') === null);
}

console.log('\nSCOPE — the pages that earn leads');
const pages = tool.scopePages();
{
  ok('scope covers docs/services and docs/areas', tool.SCOPE_DIRS.includes('services') && tool.SCOPE_DIRS.includes('areas'));
  // 2026-11-25: the 33 blog posts and 51 /our-work case studies had no tag at all.
  const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
  ok('scope covers docs/blog and docs/our-work (every post and case study)',
     tool.SCOPE_DIRS.includes('blog') && tool.SCOPE_DIRS.includes('our-work') &&
     pages.filter((p) => rel(p).startsWith('docs/blog/')).length >= 30 &&
     pages.filter((p) => rel(p).startsWith('docs/our-work/')).length >= 50,
     pages.filter((p) => /docs[\\/](blog|our-work)[\\/]/.test(p)).length + ' blog + our-work pages in scope');
  ok('scope is the 160+ landing pages the audit counted', pages.length >= 160, String(pages.length));
  ok('the three untagged top-level public pages are in scope', ['careers.html', 'partners.html', 'storm-alerts.html'].every((f) => tool.SCOPE_FILES.includes(f)));
  ok('the CRM, admin, tenant microsites and the 404 are NOT in scope',
     !pages.some((p) => /[\\/]docs[\\/](pro|admin|dev|sites)[\\/]/.test(p) || /404\.html$|offline\.html$/.test(p)));
}

console.log('\nCOVERAGE — every in-scope page, exactly one loader, the shared init');
{
  const missing = [], doubled = [], noInit = [];
  for (const p of pages) {
    const html = fs.readFileSync(p, 'utf8');
    const n = (html.match(/googletagmanager\.com\/gtag\/js\?id=G-/g) || []).length;
    if (n === 0) missing.push(path.relative(ROOT, p));
    if (n > 1) doubled.push(path.relative(ROOT, p));
    if (n === 1 && !html.includes(`src="${tool.INIT_SCRIPT}"`) && !/\/assets\/js\/inline\/[0-9a-f]{10}\.js/.test(html)) noInit.push(path.relative(ROOT, p));
  }
  ok(`all ${pages.length} in-scope pages carry a GA4 loader`, missing.length === 0, missing.slice(0, 5).join(', ') + (missing.length > 5 ? ` … +${missing.length - 5}` : ''));
  ok('no page carries two loaders', doubled.length === 0, doubled.slice(0, 5).join(', '));
  ok('every tagged page also loads an external init script (CSP forbids inline)', noInit.length === 0, noInit.slice(0, 5).join(', '));

  const init = path.join(ROOT, 'docs', tool.INIT_SCRIPT.replace(/^\//, ''));
  ok('the init script exists', fs.existsSync(init));
  ok('…and configures the same property the loader requests',
     fs.existsSync(init) && fs.readFileSync(init, 'utf8').includes(`"${tool.MEASUREMENT_ID}"`) && tool.LOADER_LINE.includes(tool.MEASUREMENT_ID));
  ok('the homepage uses the same property (one GA4 stream for the whole site)',
     fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8').includes(`gtag/js?id=${tool.MEASUREMENT_ID}`));

  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'add-ga4-tag.js'), '--check'], { encoding: 'utf8' });
  ok('`add-ga4-tag.js --check` exits 0 on the committed tree', r.status === 0, (r.stderr || r.stdout).slice(0, 300));
}

console.log('\nCSP — the `**` rule allows the tag on both headers');
{
  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const rule = fb.hosting.headers.find((h) => h.source === '**');
  const csps = rule.headers.filter((h) => /^Content-Security-Policy(-Report-Only)?$/.test(h.key));
  ok('two CSP headers on the `**` rule', csps.length === 2);
  for (const h of csps) {
    ok(`${h.key}: script-src-elem allows www.googletagmanager.com`, /script-src-elem [^;]*https:\/\/www\.googletagmanager\.com/.test(h.value));
    ok(`${h.key}: connect-src allows www.google-analytics.com`, /connect-src [^;]*https:\/\/www\.google-analytics\.com/.test(h.value));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
