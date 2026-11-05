/**
 * tests/crm-logo-accent-contrast-2026-11-04.test.js
 *
 * THE BUG: the CRM header wordmark (`.logo span`, "PRO", 14 px bold) used var(--orange). The theme engine tunes
 * --orange to 3:1 against the PAGE background, but the header is a fixed near-black (rgba(10,12,15,.97)) in every
 * theme, light ones included. Measured on the sample account, 51 of 207 themes were under AA normal 4.5:1; the
 * default theme's #BD5728 was 4.03-4.25 (Lighthouse color-contrast, audit 2026-11-04).
 *
 * THE FIX: theme-engine.js emits --orange-on-header = tuneAgainst(accent, '#0a0c0f', 4.5); `.logo span` uses it.
 * Measured after: 0 of 207 under 4.5, none worse.
 *
 * Runs the engine's REAL luminance / contrastRatio / adjustHex / tuneAgainst in a vm over every theme's accent, and
 * checks the wiring. Positive control: the raw default accent fails 4.5 against the header.
 *
 * Zero deps. Run: node tests/crm-logo-accent-contrast-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/theme-engine.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/css/dashboard-app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const helpers = ['parseHex', 'luminance', 'contrastRatio', 'adjustHex', 'tuneAgainst'].map((n) => extractFn(SRC, n)).filter(Boolean).join('\n');
const ctx = {};
vm.createContext(ctx);
let loaded = true;
try { vm.runInContext(helpers + '\nthis.cr = contrastRatio; this.tune = tuneAgainst;', ctx); } catch (e) { loaded = false; console.log(e.message); }
ok('the engine\'s colour helpers load', loaded && typeof ctx.tune === 'function');

const HEADER = '#0a0c0f';
const accents = [...SRC.matchAll(/^\s+accent:\s*'(#[0-9a-fA-F]{6})'/gm)].map((m) => m[1]);
ok('every theme accent is found (100+)', accents.length >= 100, String(accents.length));
if (loaded) {
  ok('POSITIVE CONTROL: the raw default accent #BD5728 is under 4.5 on the header', ctx.cr('#BD5728', HEADER) < 4.5, String(ctx.cr('#BD5728', HEADER)));
  const low = accents.filter((a) => ctx.cr(ctx.tune(a, HEADER, 4.5), HEADER) < 4.5);
  ok('every theme accent, tuned for the header, clears 4.5:1', low.length === 0, low.slice(0, 5).join(', '));
}

ok('the engine tunes --orange-on-header against the fixed header, to 4.5', /const accentText = tuneAgainst\(accentFinal, '#0a0c0f', 4\.5\);/.test(SRC) && /--orange-on-header: \$\{accentText\};/.test(SRC));
ok('the header is still the fixed near-black the tune assumes', /header\{flex-shrink:0;background:rgba\(10,12,15,\.97\)/.test(CSS));
ok('the wordmark uses the header-safe accent', /\.logo span\{color:var\(--orange-on-header, var\(--orange\)\);\}/.test(CSS));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
