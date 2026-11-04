/**
 * tests/a11y-contrast-sweep-2026-11-04.test.js
 *
 * The 2026-11-04 axe-core sweep (WCAG 2.x A/AA, every public page, phone +
 * desktop) found brand orange #bd5728 used as TEXT on navy/dark grey (3.0–3.4:1)
 * and on the light fact-box (4.15:1), links inside body text told apart by
 * colour alone (down to 1.26:1), and sideways-scrolling tables/trust bars a
 * keyboard could not reach. Each spot was fixed with the site's own tokens:
 *   --orange-light #dd875f on dark  → 5.83:1 on #12223d, 5.14:1 on #2c2a3a
 *   --orange-dark  #a14a22 on light → 5.39:1 on #f5f3ef, 5.97:1 on #fff
 * A re-run of the full sweep was clean. This pins each fix so a copy-paste
 * of the old rule cannot quietly bring it back.
 *
 * Run: node tests/a11y-contrast-sweep-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label); failed++; }
}

// WCAG relative-luminance contrast, so the token choice itself is checked.
function lum(hex) {
  const c = [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

console.log('\ntoken contrast (AA 4.5:1 for text)');
ok('orange-light on navy passes', ratio('#dd875f', '#12223d') >= 4.5);
ok('orange-light on the dark hero passes', ratio('#dd875f', '#2c2a3a') >= 4.5);
ok('orange-dark on the light fact box passes', ratio('#a14a22', '#f5f3ef') >= 4.5);
ok('control: the old brand orange on navy FAILS (why this file exists)', ratio('#bd5728', '#12223d') < 4.5);

console.log('\nfixed spots keep their tokens');
const LIGHT = /var\(--orange-light(,#dd875f)?\)/;
const fin = read('docs/blog/roof-financing-cincinnati-explained.html');
ok('financing post: hero .article-tag uses orange-light', /\.article-tag\{[^}]*color:var\(--orange-light/.test(fin));
ok('financing post: .fact-box h4 uses orange-dark', /\.fact-box h4\{[^}]*color:var\(--orange-dark/.test(fin));
ok('financing post: related .rtag uses orange-dark', /\.rtag\{[^}]*color:var\(--orange-dark/.test(fin));
ok('pipe-boot post: the dark compare head row uses orange-light', /\.compare-row\.head \.ours\{color:var\(--orange-light/.test(read('docs/blog/the-pipe-boot-fork.html')));
ok('/book: the phone link in the note is underlined, not colour-only', /\.book-note-inner p a\{[^}]*text-decoration:underline/.test(read('docs/book/index.html')));
ok('/free-roof: links on the navy rules section use orange-light', /\.rules a\{color:var\(--orange-light/.test(read('docs/free-roof/index.html')));
ok('offline page: tip titles use orange-light', /\.tip-title\{[^}]*color:var\(--orange-light/.test(read('docs/offline.html')));
ok('financing service page: phone link on navy uses orange-light (inline)', /href="tel:\+18594207382" style="color:var\(--orange-light/.test(read('docs/services/financing.html')));
ok('LumaNail compare head: the right side uses orange-light', /\.compare-head \.side\.right \{[^}]*color: var\(--orange-light/.test(read('docs/services/lumanail/index.html')));
ok('Roof Care Plan warranty badge uses orange-light', /\.warranty-badge \.big \{ color: var\(--orange-light/.test(read('docs/services/roof-care-plan.html')));
const pledge = read('docs/the-pledge/index.html');
ok('the Pledge: featured label uses orange-light', /\.featured \.label\{color:var\(--orange-light/.test(pledge));
ok('the Pledge: no footer link uses the plain brand orange inline', !/<a href="\/(the-pledge|estimate)" style="color:var\(--orange\);?"/.test(pledge));
ok('"How a roof works" links under illustrations are underlined', /\.illus-more a\{[^}]*text-decoration:underline/.test(read('docs/assets/css/illustrations.css')));
ok('every page loading illustrations.css asks for v=2 (CSS is cached a day)', !/illustrations\.css\?v=1/.test(
  ['docs/services/roof-repair.html', 'docs/services/storm-damage.html', 'docs/guides/how-a-roof-works.html'].map(read).join('')));

console.log('\nscrolling regions are keyboard-reachable');
ok('build-guides.js emits tabindex + role=region + aria-label on every table wrap', /g-table-wrap" tabindex="0" role="region" aria-label="/.test(read('scripts/build-guides.js')));
ok('a generated guide page carries it', /class="g-table-wrap" tabindex="0" role="region" aria-label="Table: /.test(read('docs/guides/compare-roofing-quotes-checklist.html')));
for (const p of ['docs/services/commercial-roofing.html', 'docs/services/emergency-roof-tarping.html']) {
  ok(path.basename(p) + ': the trust bar is a focusable labelled region', /class="trust-bar-inner" tabindex="0" role="region" aria-label="/.test(read(p)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
