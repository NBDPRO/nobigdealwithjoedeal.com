/**
 * tests/seasonal-ann-slide-2026-11-26.test.js
 *
 * The seasonal announcement-bar slide (scripts/seasonal-ann-slide.js):
 *   1. insert/strip on a fixture: placed second, keeps CRLF, a second run is a no-op, --off restores the bytes;
 *   2. the live tree agrees: every homeowner page with a slide bar is in the same season state (--check exits 0),
 *      and no contractor surface (pro/, sites/) carries the slide;
 *   3. every season's wording keeps the tarping qualifier and never names a claim or an adjuster.
 * Run: node tests/seasonal-ann-slide-2026-11-26.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const K = require('./lib/src-kit');
const S = require('../scripts/seasonal-ann-slide');
const T = K.suite('SEASONAL ANNOUNCEMENT SLIDE (2026-11-26)');
const { ok, section } = T;

section('1. insert / strip on a fixture');
{
  const bar = (eol) => ['<body>', '<div class="ann-bar" id="annBar">',
    '  <div class="ann-slide active"><svg class="ico"></svg> <span class="ann-text">One</span></div>',
    '  <div class="ann-slide"><a href="tel:+1"><span class="ann-text">Two</span></a></div>',
    '</div>', '<div class="ann-slide">not in the bar</div>', '</body>'].join(eol);
  for (const eol of ['\n', '\r\n']) {
    const src = bar(eol);
    const on = S.insert(src, 'winter');
    const slides = K.parseTags(on).$$('.ann-bar .ann-slide');
    ok(`${JSON.stringify(eol)}: the season slide is second of three in the bar`,
      slides.length === 3 && slides[1].attr(S.ATTR) === 'winter' && slides[0].classes.includes('active'));
    ok(`${JSON.stringify(eol)}: line endings kept, no lone CR`, eol === '\r\n' ? !/(^|[^\r])\n/.test(on) : !on.includes('\r'));
    ok(`${JSON.stringify(eol)}: strip restores the original bytes`, S.strip(on) === src);
    ok(`${JSON.stringify(eol)}: strip then insert again is stable`, S.insert(S.strip(on), 'winter') === on);
  }
  ok('a page without a slide bar is left alone', S.insert('<div class="ann-bar">Text only</div>', 'winter') === null);
}

section('2. the live tree agrees');
{
  const r = spawnSync(process.execPath, [path.join(K.ROOT, 'scripts/seasonal-ann-slide.js'), '--check'], { encoding: 'utf8' });
  ok('--check: one season state across all homeowner pages', r.status === 0, (r.stdout || '') + (r.stderr || ''));
  const leaked = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html') && fs.readFileSync(p, 'utf8').includes(S.ATTR)) leaked.push(path.relative(K.ROOT, p));
    }
  };
  for (const d of ['docs/pro', 'docs/sites']) walk(path.join(K.ROOT, d));
  ok('no contractor surface carries the seasonal slide', leaked.length === 0, leaked.slice(0, 5).join(', '));

  // Phones hide the bar except for the seasonal slide (Jo, 2026-11-26); that rule lives in nbd-nav.css.
  const noNavCss = [];
  const walkDocs = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['pro', 'sites', 'admin', 'assets'].includes(e.name)) walkDocs(p); continue; }
      if (!e.name.endsWith('.html')) continue;
      const html = fs.readFileSync(p, 'utf8');
      if (html.includes(S.ATTR) && !/href="\/assets\/css\/nbd-nav\.css/.test(html)) noNavCss.push(path.relative(K.ROOT, p));
    }
  };
  walkDocs(path.join(K.ROOT, 'docs'));
  ok('every page with the seasonal slide loads nbd-nav.css (where the phone rule lives)', noNavCss.length === 0, noNavCss.slice(0, 5).join(', '));
  const nav = K.read('docs/assets/css/nbd-nav.css');
  ok('nbd-nav.css shows the bar on phones only when it holds a seasonal slide, standing slides hidden',
    /\.ann-bar:has\(> \[data-nbd-season-ann\]\)\s*\{\s*display:\s*flex !important/.test(nav)
    && /\.ann-bar:has\(> \[data-nbd-season-ann\]\) > \.ann-slide:not\(\[data-nbd-season-ann\]\)\s*\{\s*display:\s*none !important/.test(nav));
}

section('3. wording rules');
for (const [name, s] of Object.entries(S.SEASONS)) {
  const all = `${s.long} ${s.short}`;
  ok(`${name}: a same-day promise carries "when daylight & weather allow"`,
    !/same-day/i.test(all) || /same-day tarping when daylight (and|&amp;) weather allow/i.test(s.long) && !/same-day/i.test(s.short));
  ok(`${name}: no claim, adjuster or deductible wording`, !/claim|adjuster|deductible|insurance/i.test(all));
  ok(`${name}: links to a real page`, fs.existsSync(path.join(K.ROOT, 'docs', s.href + '.html')));
}

T.done();
