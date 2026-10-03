/**
 * tests/inline-style-ratchet-2026-10-01.test.js — the reskin ratchet.
 *
 * Themes could only recolor the CRM because spacing, borders, radius and
 * shadow are fixed in inline style attributes, which a skin can't reach
 * (documentation/projects/RESKIN-PLAN-2026-10-01.md, step 2). This pins the
 * count of inline `style="…"` attributes so it can only go down: converting
 * a screen to classes and tokens lowers it, and new UI must not raise it.
 *
 * Over the ceiling → fail, naming the files with the most sites and how to
 * fix. Under it → pass, with a note to lower the ceiling to the new count
 * (do that in the same PR so the win is locked in).
 *
 * Counted: `style="`, `style='`, `style=\"` and `style=\``, in rep-side
 * docs/pro/js/*.js and in dashboard.html / customer.html. Not counted:
 * `el.style.x = …` (dynamic values like widths and positions are a fair use)
 * and the EXEMPT files below, whose output is meant to carry inline styles.
 *
 * Zero deps. Run: node tests/inline-style-ratchet-2026-10-01.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ATTR = /\bstyle\s*=\s*\\?["'`]/g;

// Output that has to inline its styles, so it can't be skinned anyway.
const EXEMPT = {
  'document-generator-templates.js': 'printed documents and PDFs: html2pdf and email clients drop stylesheets',
};

// Lower these whenever the count drops. Never raise them.
const CEILING = {
  'docs/pro/js': 2756,
  'docs/pro/dashboard.html': 826,
  'docs/pro/customer.html': 207,
};

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, fix) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (fix ? '\n      fix: ' + fix : '')); }
}
const count = (s) => (s.match(ATTR) || []).length;

console.log('INLINE STYLE RATCHET — skins can only restyle what reaches a class or token');

const FIX = 'move the new inline styles into a class in docs/pro/css/ (use theme tokens: var(--s), var(--br), var(--r-md)…); ' +
  'a truly dynamic value (a width %, a position) can be set as el.style.x or a CSS custom property instead';

// Regex sanity: every form the counter claims to count, and none it doesn't.
ok('counter sees the four quoted forms and skips el.style',
  count('a style="x" b style=\'x\' c style=\\"x\\" d style=`x` e.style.width = 1') === 4);

{
  const dir = path.join(ROOT, 'docs/pro/js');
  const per = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !EXEMPT[f])
    .map((f) => [f, count(fs.readFileSync(path.join(dir, f), 'utf8'))])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = per.reduce((s, [, n]) => s + n, 0);
  const top = per.slice(0, 5).map(([f, n]) => f + ' ' + n).join(', ');
  ok(`docs/pro/js inline style attributes: ${total} ≤ ceiling ${CEILING['docs/pro/js']}`,
    total <= CEILING['docs/pro/js'], FIX + '. Most sites: ' + top);
  if (total < CEILING['docs/pro/js']) console.log(`    note: down ${CEILING['docs/pro/js'] - total} — lower CEILING['docs/pro/js'] to ${total}`);
  ok('every EXEMPT file still exists (drop stale exemptions)',
    Object.keys(EXEMPT).every((f) => fs.existsSync(path.join(dir, f))));
}

for (const rel of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
  const n = count(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  ok(`${rel} inline style attributes: ${n} ≤ ceiling ${CEILING[rel]}`, n <= CEILING[rel], FIX);
  if (n < CEILING[rel]) console.log(`    note: down ${CEILING[rel] - n} — lower CEILING['${rel}'] to ${n}`);
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
