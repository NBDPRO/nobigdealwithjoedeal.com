/**
 * tests/escape-user-text-sinks-2026-09-29.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * A read-only audit of the CRM's ~930 innerHTML / insertAdjacentHTML /
 * document.write sinks (2026-09-29) found a dozen that put user text into
 * HTML unescaped. The worst: the Cmd-K palette rendered a lead's name and
 * address raw — leads come from the PUBLIC contact form — and replayed them
 * from saved recents on every open. The root cause behind several others:
 * escape helpers that did not escape quotes (textContent→innerHTML, or a
 * <>-only replace) but were used inside attributes (value="…", alt="…",
 * data-d2d-args='…').
 *
 * 1. Every one of those helpers, pulled out of its real file, now escapes
 *    & < > " ' — behaviour, not a regex over the source.
 * 2. The real renderCmdResults, run on a hostile lead, emits no live tag.
 * 3. Each fixed sink passes its value through an escape helper.
 *
 * Run: node tests/escape-user-text-sinks-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = (f) => fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// Pull `function name(...) {...}` or `const name = (...) => ...;` out of a file.
function extract(src, name) {
  let i = src.indexOf('function ' + name + '(');
  if (i !== -1) {
    const open = src.indexOf('{', i);
    let d = 0, j = open;
    for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) { j++; break; } } }
    return src.slice(i, j);
  }
  const m = new RegExp('const ' + name + ' = [\\s\\S]*?;\\r?\\n').exec(src);
  return m ? m[0] : '';
}

const HOSTILE = `<img src=x onerror="a('1')">&'`;
const doc = { createElement: () => ({ set textContent(v) { this._t = v; }, get innerHTML() { return this._t; } }) };

console.log('\n1. every escape helper escapes & < > " \'');
const HELPERS = [
  ['d2d-tracker-core-2026b.js', 'esc'],
  ['close-board.js', 'esc'],
  ['document-generator-templates.js', 'esc'],
  ['storm-center.js', 'esc'],
  ['rep-os.js', 'esc'],
  ['buying-intent-strike.js', 'esc'],
  ['dashboard-widgets.js', 'escText'],
  ['onboarding-tour.js', 'escHtml'],
  ['ui.js', '_cmdEsc'],
  ['property-intel.js', '_piEsc'],
];
for (const [file, name] of HELPERS) {
  const code = extract(JS(file), name);
  let out = null;
  try {
    const ctx = { document: doc };
    vm.createContext(ctx);
    vm.runInContext(code + '\nglobalThis.__f = ' + name + ';', ctx);
    out = ctx.__f(HOSTILE);
  } catch (e) { out = 'ERR ' + e.message; }
  ok(file + ' ' + name + '()', typeof out === 'string' && !/[<>"']/.test(out) && /&lt;img/.test(out) && /&amp;/.test(out), out);
}
{
  // insurance-claim.js and dashboard-ui.js keep theirs inline.
  const ic = /function _icEsc\(v\) \{[^\n]*\}/.exec(JS('insurance-claim.js'));
  let out = null;
  try { const ctx = {}; vm.createContext(ctx); vm.runInContext(ic[0] + '\nglobalThis.__f=_icEsc;', ctx); out = ctx.__f(HOSTILE); } catch (e) { out = 'ERR ' + e.message; }
  ok('insurance-claim.js _icEsc()', typeof out === 'string' && !/[<>"']/.test(out), out);
  const du = /const _escT = \(s\) => [^\n]*;/.exec(JS('dashboard-ui.js'));
  try { const ctx = {}; vm.createContext(ctx); vm.runInContext(du[0] + '\nglobalThis.__f=_escT;', ctx); out = ctx.__f(HOSTILE); } catch (e) { out = 'ERR ' + e.message; }
  ok('dashboard-ui.js _escT()', typeof out === 'string' && !/[<>"']/.test(out), out);
}

console.log('\n2. Cmd-K palette: a hostile lead renders as text');
{
  const src = JS('ui.js');
  const container = { innerHTML: '' };
  const ctx = {
    document: { getElementById: (id) => (id === 'cmdResults' ? container : null) },
    cmdSelectedIndex: 0, cmdCurrentResults: [],
  };
  vm.createContext(ctx);
  vm.runInContext(['_cmdEsc', 'renderCmdResults'].map((n) => extract(src, n)).join('\n')
    + '\nglobalThis.__r = renderCmdResults;', ctx);
  ctx.__r([{ type: 'lead', icon: '👤', title: HOSTILE, meta: '1 Main St · ' + HOSTILE, badge: HOSTILE }]);
  ok('the palette rendered something', container.innerHTML.length > 0);
  ok('no live <img> tag from the lead name', !/<img/i.test(container.innerHTML), container.innerHTML.slice(0, 160));
  ok('the name is shown escaped', /&lt;img src=x onerror=&quot;/.test(container.innerHTML));
}

console.log('\n3. each fixed sink escapes its value');
const SINKS = [
  ['insurance-claim.js', /Claim #:<\/strong> \$\{_icEsc\(status\.claimNumber\)\}/, 'claim # (claim workflow)'],
  ['insurance-claim.js', /Carrier:<\/strong> \$\{_icEsc\(status\.insuranceCarrier\)\}/, 'carrier'],
  ['insurance-claim.js', /Claim #\$\{_icEsc\(status\.claimNumber\)\}/, 'claim # (summary)'],
  ['property-intel.js', /mir-owner">\$\{_piEsc\(intel\.ownerName/, 'AI owner name'],
  ['property-intel.js', /Type <span>\$\{_piEsc\(intel\.propertyType\)\}/, 'AI property type'],
  ['document-generator-templates.js', /<span>\$\{esc\(extra \|\| C\.tagline/, 'document footer (claim # etc.)'],
  ['widgets.js', /class="wg-strong">\$\{esc\(name\)\}<\/span>/, 'Pipeline by Damage widget'],
  ['widgets.js', /class="wg-strong">\$\{esc\(s\)\}<\/span>/, 'Lead Sources widget'],
  ['product-library.js', /\$\{escapeHtml\(catLabel\(catId\)\)\}/, 'product category label'],
  ['photo-engine.js', /src="\$\{escHtml\(photo\.thumbUrl \|\| photo\.url\)\}"/, 'gallery thumbnail src'],
  ['photo-engine.js', /src="\$\{escHtml\(photo\.url\)\}" alt="Full size"/, 'lightbox src'],
  ['dashboard-ui.js', /\.split\('\{\{COMPANY\}\}'\)\.join\(_escT\(co\.name\)\)/, 'blank-document company name'],
];
for (const [file, re, label] of SINKS) ok(label + ' (' + file + ')', re.test(strip(JS(file))));
ok('no widget still queries raw NWS text', !/\$\{f\.properties\.event\}/.test(JS('widgets.js')));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('Failures:'); fails.forEach((x) => console.log('  - ' + x)); process.exit(1); }
