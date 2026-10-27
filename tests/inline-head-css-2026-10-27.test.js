/**
 * tests/inline-head-css-2026-10-27.test.js — the deploy-time inlining of the
 * homepage's head stylesheets (scripts/inline-head-css.js; PageSpeed mobile
 * 2026-10-27: 11 render-blocking CSS requests, LCP 4.3 s).
 *
 * Guards: every head <link rel=stylesheet href=/assets/css/...> becomes a
 * <style> in the SAME position and order (the cascade must not move), the
 * body is untouched, a second run is a no-op, an unreadable file or one that
 * would close the <style> early stays a link, the CSS files use absolute
 * url() paths only (inlining must not change URL resolution), and the deploy
 * runs the step after the minify, before Hosting, and restores docs/index.html.
 *
 * Run: node tests/inline-head-css-2026-10-27.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { inlineHeadCss, PAGES } = require('../scripts/inline-head-css.js');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const read = (f) => { try { return fs.readFileSync(path.join(DOCS, 'assets', 'css', f), 'utf8'); } catch (e) { return null; } };
const LINK = /<link rel="stylesheet" href="\/assets\/css\/([A-Za-z0-9._-]+\.css)(?:\?[^"]*)?">/g;

// The CSS text a browser would apply, in document order, for everything in <head>.
function headCssSequence(html, linkText) {
  const head = html.slice(0, html.indexOf('</head>'));
  const out = [];
  const re = /<link rel="stylesheet" href="\/assets\/css\/([A-Za-z0-9._-]+\.css)(?:\?[^"]*)?">|<style>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(head))) out.push((m[1] ? linkText(m[1]) : m[2]).trim());
  return out;
}

console.log('\nHOMEPAGE');
ok('only the homepage is listed (add a page after re-measuring it)', PAGES.length === 1 && PAGES[0] === 'index.html');
const orig = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const headLinks = (orig.slice(0, orig.indexOf('</head>')).match(LINK) || []);
ok('the homepage head links at least 11 local stylesheets', headLinks.length >= 11, 'found ' + headLinks.length);

const r = inlineHeadCss(orig, read);
ok('every head stylesheet link was inlined', r.count === headLinks.length && r.skipped === 0, JSON.stringify({ count: r.count, skipped: r.skipped }));
ok('no local stylesheet link is left in the head', !LINK.test(r.html.slice(0, r.html.indexOf('</head>'))));
LINK.lastIndex = 0;
ok('everything from </head> on is byte-identical', r.html.slice(r.html.indexOf('</head>')) === orig.slice(orig.indexOf('</head>')));

const before = headCssSequence(orig, (f) => read(f));
const after = headCssSequence(r.html, () => '');
ok('same CSS blocks in the same order (the cascade does not move)',
  before.length === after.length && before.every((t, i) => t === after[i]),
  'before ' + before.length + ' blocks, after ' + after.length);

const again = inlineHeadCss(r.html, read);
ok('a second run changes nothing', again.count === 0 && again.html === r.html);

console.log('\nSAFETY');
const synth = '<html><head><link rel="stylesheet" href="/assets/css/a.css">\n<link rel="stylesheet" href="/assets/css/b.css?v=2">\n<link rel="stylesheet" href="/assets/css/c.css">\n</head><body><link rel="stylesheet" href="/assets/css/a.css"></body></html>';
const files = { 'a.css': 'a{color:red}', 'b.css': 'b{}</style><script>x</script>', 'c.css': null };
const s = inlineHeadCss(synth, (f) => files[f]);
ok('inlines a readable file', s.html.includes('<style>a{color:red}</style>'));
ok('a file that contains </style stays a link', s.html.includes('<link rel="stylesheet" href="/assets/css/b.css?v=2">'));
ok('an unreadable file stays a link', s.html.includes('<link rel="stylesheet" href="/assets/css/c.css">'));
ok('a link in the body is not touched', s.html.endsWith('<body><link rel="stylesheet" href="/assets/css/a.css"></body></html>'));
ok('counts: 1 inlined, 2 skipped', s.count === 1 && s.skipped === 2);
ok('a page with no </head> is returned as is', inlineHeadCss('<p>x</p>', read).html === '<p>x</p>');

console.log('\nURL RESOLUTION');
const bad = [];
for (const f of new Set(headLinks.map((l) => l.match(/css\/([^"?]+)/)[1]))) {
  const css = read(f) || '';
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let m;
  while ((m = re.exec(css))) if (!/^(\/|data:|#|https?:)/.test(m[2])) bad.push(f + ' -> ' + m[2]);
  if (/@import/.test(css)) bad.push(f + ' has @import');
}
ok('inlined CSS has no relative url() or @import', bad.length === 0, bad.join('; '));

console.log('\nDEPLOY WIRING');
const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'firebase-deploy.yml'), 'utf8');
const iMin = wf.indexOf('node scripts/minify-shipped.js --write');
const iInline = wf.indexOf('node scripts/inline-head-css.js --write');
const iDeploy = wf.indexOf('firebase-tools deploy --only hosting');
ok('the inline step runs after the minify', iMin > 0 && iInline > iMin);
ok('the inline step runs before the Hosting deploy', iInline > 0 && iDeploy > iInline);
ok('the inline step is soft-fail (the page keeps its links)', /inline-head-css\.js --write[^\n]*\\\n\s*\|\| echo "::warning::/.test(wf));
ok('the restore step puts docs/index.html back', /git checkout -- docs\/pro docs\/assets docs\/index\.html/.test(wf));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
