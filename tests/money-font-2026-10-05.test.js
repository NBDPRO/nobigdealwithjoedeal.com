/**
 * tests/money-font-2026-10-05.test.js — CRM money figures use Barlow Semi
 * Condensed (Jo's pick, 2026-10-05) through the --font-money token.
 *
 *   - the two vendored files exist under docs/assets/fonts and are real
 *     WOFF2 (magic bytes), and the @font-face rules point at them;
 *   - --font-money keeps a fallback stack (Barlow Condensed → Barlow →
 *     system-ui) and the money rule sets tabular figures;
 *   - every money class in the rule is something a CRM renderer really
 *     emits (a selector for a class nobody renders is a silent no-op);
 *   - the money rule WINS: for every rule in a stylesheet dashboard.html
 *     loads that sets font-family on one of those classes, the money rule's
 *     specificity is higher, or equal and later in load order;
 *   - Today's owed / deposit amounts are wrapped in .ui-money;
 *   - customer-facing documents are untouched (no Semi Condensed in the
 *     document generators or the server PDF renderer).
 *
 * Zero deps. Run: node tests/money-font-2026-10-05.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const prim = strip(read('docs/pro/css/ui-primitives.css'));

console.log('MONEY FONT — files and token');
{
  const faces = [...prim.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]).filter((b) => /Barlow Semi Condensed/.test(b));
  ok('two @font-face rules for Barlow Semi Condensed (700, 800)', faces.length === 2
    && faces.some((b) => /font-weight:\s*700/.test(b)) && faces.some((b) => /font-weight:\s*800/.test(b)));
  for (const b of faces) {
    const url = (b.match(/url\(([^)]+)\)/) || [])[1] || '';
    const file = path.join(ROOT, 'docs', url.replace(/^\//, ''));
    const exists = url.startsWith('/assets/fonts/') && fs.existsSync(file);
    const magic = exists ? fs.readFileSync(file).slice(0, 4).toString('latin1') : '';
    ok('self-hosted ' + url + ' exists and is WOFF2', exists && magic === 'wOF2' && /format\('woff2'\)/.test(b) && /font-display:\s*swap/.test(b));
  }
  const tok = (prim.match(/--font-money:\s*([^;]+);/) || [])[1] || '';
  ok('--font-money leads with Barlow Semi Condensed and keeps a fallback stack',
    /^'Barlow Semi Condensed', 'Barlow Condensed', 'Barlow', system-ui, sans-serif$/.test(tok.trim()), tok);
}

const ruleM = prim.match(/((?::root[^{;}]*,\s*)*:root[^{;}]*)\{\s*font-family:\s*var\(--font-money\);\s*font-variant-numeric:\s*tabular-nums;\s*\}/);
const sels = ruleM ? ruleM[1].split(/,(?![^(]*\))/).map((s) => s.trim()) : [];
const classes = ruleM ? [...new Set((ruleM[1].match(/\.[a-z][\w-]*/g) || []).map((c) => c.slice(1)))].filter((c) => c !== 'ui-stat') : [];
console.log('\nMONEY FONT — what it reaches');
{
  ok('one money rule sets the face and tabular figures', !!ruleM && sels.length >= 3);
  const want = ['ui-money', 'kc-val-badge', 'cl-card-val', 'est-card-total', 'est-total-val', 'ceh-card-amt', 'ipx-total-row', 'cbr-pill-t', 'cbr-v22-green'];
  ok('it covers Today, pipeline, customer, estimates, invoices and Close Board', want.every((c) => classes.includes(c)), 'missing: ' + want.filter((c) => !classes.includes(c)).join(', '));
  ok('it covers the customer job value (#infoJobValue)', sels.some((s) => /#infoJobValue$/.test(s)));
  const sources = ['docs/pro/dashboard.html', 'docs/pro/customer.html', ...fs.readdirSync(path.join(ROOT, 'docs/pro/js')).filter((f) => f.endsWith('.js')).map((f) => 'docs/pro/js/' + f)].map(read).join('\n');
  const dead = classes.filter((c) => !new RegExp('class=\\\\?["\'][^"\']*\\b' + c + '\\b').test(sources));
  ok('every money class is really rendered somewhere in the CRM', dead.length === 0, 'never rendered: ' + dead.join(', '));
  const home = read('docs/pro/js/today-home.js');
  ok('Today wraps owed and deposit amounts in .ui-money', /var money = '<span class="ui-money">' \+ esc\(P\.fmtCents\(r\.cents\)\) \+ '<\/span>';/.test(home)
    && /'Draft deposit ' \+ money \+/.test(home) && /money \+ ' owed'/.test(home) && !/esc\(P\.fmtCents\(r\.cents\)\) \+ ' owed'/.test(home));
}

// Specificity of a selector: [ids, classes/attrs/pseudo-classes, types].
function spec(sel) {
  let s = sel.replace(/::[\w-]+/g, '');
  let extra = [0, 0, 0];
  s = s.replace(/:(is|not|where)\(([^()]*)\)/g, (m, fn, inner) => {
    if (fn === 'where') return '';
    const best = inner.split(',').map((x) => spec(x.trim())).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
    extra = extra.map((v, i) => v + best[i]); return '';
  });
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
  const typ = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|:[\w-]+/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length;
  return [ids + extra[0], cls + extra[1], typ + extra[2]];
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
console.log('\nMONEY FONT — it wins the cascade');
{
  const html = read('docs/pro/dashboard.html');
  const order = [...html.matchAll(/<link rel="stylesheet" href="\/?(?:pro\/)?(css\/[\w-]+\.css)/g)].map((m) => m[1]);
  const me = order.indexOf('css/ui-primitives.css');
  ok('dashboard.html load order found, ui-primitives in it', me > 0);
  const lose = [];
  order.forEach((rel, idx) => {
    if (rel === 'css/ui-primitives.css') return;
    let src; try { src = strip(read('docs/pro/' + rel)); } catch (e) { return; }
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/font-family\s*:/.test(m[2])) continue;
      const important = /font-family\s*:[^;]*!important/.test(m[2]);
      for (const theirs of m[1].split(/,(?![^(]*\))/).map((x) => x.trim())) {
        const last = theirs.split(/[\s>+~]+/).pop();
        const hit = classes.find((c) => new RegExp('\\.' + c + '(?![\\w-])').test(last));
        if (!hit) continue;
        const mine = sels.filter((x) => new RegExp('\\.' + hit + '(?![\\w-])').test(x)).map(spec).sort((a, b) => cmp(b, a))[0];
        const c = cmp(mine, spec(theirs));
        if (important || c < 0 || (c === 0 && idx > me)) lose.push(rel + ' :: ' + theirs);
      }
    }
  });
  ok('no stylesheet rule overrides the money face on those elements', lose.length === 0, lose.slice(0, 5).join(' | '));
}

console.log('\nMONEY FONT — documents untouched');
{
  const docs = ['docs/pro/js/document-generator-templates.js', 'docs/pro/js/document-generator.js', 'functions/render-pdf.js'];
  ok('no Barlow Semi Condensed / --font-money in the document generators or PDF renderer', docs.every((d) => !/Barlow Semi Condensed|--font-money/.test(read(d))));
  ok('customer-facing nbd-brand.css is untouched', !/Semi Condensed|--font-money/.test(read('docs/pro/css/nbd-brand.css')));
}
{
  const d = read('docs/pro/dashboard.html'), c = read('docs/pro/customer.html');
  const v = (s, re) => +((s.match(re) || [])[1] || 0);
  ok('cache-busters bumped (ui-primitives > v12 on both pages, today-home.js > v1)',
    v(d, /css\/ui-primitives\.css\?v=(\d+)/) > 12 && v(c, /css\/ui-primitives\.css\?v=(\d+)/) > 12 && v(d, /js\/today-home\.js\?v=(\d+)/) > 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
