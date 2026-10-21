/**
 * tests/tracker-food-search-2026-10-20.test.js
 *
 * Tracker revamp Phase 2: "Find a food" - Open Food Facts search + barcode
 * lookup (docs/pro/daily-success/js/food-search-logic.js + -ui.js) and the
 * CSP that lets only the daily tracker call it. Synthetic payloads only; no
 * network.
 *
 * Run: node tests/tracker-food-search-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const S = require(path.join(DS, 'js', 'food-search-logic.js'));
const F = require(path.join(DS, 'js', 'food-log-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}

console.log('\n1. barcodes');
ok('valid EAN-13, UPC-A, EAN-8 pass the check digit', S.validBarcode('3017620422003') && S.validBarcode('012345678905') && S.validBarcode('96385074'));
ok('one wrong digit fails', !S.validBarcode('3017620422004') && !S.validBarcode('012345678906') && !S.validBarcode('96385075'));
ok('wrong length, letters, blanks fail', !S.validBarcode('12345') && !S.validBarcode('30176204220A3') && !S.validBarcode('') && !S.validBarcode(null));
ok('URLs: only digits reach the barcode path; the query is encoded and capped',
  S.barcodeUrl('3017620422003/../x').indexOf('/product/3017620422003.json') > 0
  && /search_terms=greek%20yogurt%20%26%20honey&/.test(S.searchUrl('  greek   yogurt & honey ')) && /^https:\/\/world\.openfoodfacts\.org\//.test(S.searchUrl('x'))
  && S.searchUrl('a'.repeat(500)).length < 400);

console.log('\n2. normalizing products');
{
  const perServing = { code: '111', product_name: 'Skyr Vanilla', brands: 'Acme, Other', serving_size: '150 g', serving_quantity: 150,
    nutriments: { proteins_serving: 17.4, carbohydrates_serving: 8.1, fat_serving: 0.2, 'energy-kcal_serving': 99.6, proteins_100g: 11.6 } };
  const a = S.normalizeProduct(perServing);
  ok('label per-serving numbers win; brand is the first one', a.p === 17.4 && a.c === 8.1 && a.f === 0.2 && a.cal === 100 && a.brand === 'Acme' && a.label === '150 g', JSON.stringify(a));
  const scaled = S.normalizeProduct({ product_name: 'Oats', serving_quantity: '40', nutriments: { proteins_100g: 13, carbohydrates_100g: 60, fat_100g: 7, 'energy-kcal_100g': 370 } });
  ok('only per-100 g + a serving weight: scaled to the serving (40 g -> 5.2p, 148 cal)', scaled.p === 5.2 && scaled.c === 24 && scaled.f === 2.8 && scaled.cal === 148 && scaled.label === '40 g', JSON.stringify(scaled));
  const per100 = S.normalizeProduct({ product_name: 'Chicken breast', nutriments: { proteins_100g: 23, 'energy-kcal_100g': 120 } });
  ok('no serving at all: per 100 g, and it says so', per100.label === '100 g' && per100.p === 23 && per100.cal === 120);
  ok('no nutrition or no name: dropped (it would add a blank row)',
    S.normalizeProduct({ product_name: 'Mystery', nutriments: {} }) === null && S.normalizeProduct({ nutriments: { proteins_100g: 5 } }) === null && S.normalizeProduct(null) === null);
  ok('garbage numbers never become NaN', (() => { const x = S.normalizeProduct({ product_name: 'Bad', nutriments: { proteins_100g: 'abc', 'energy-kcal_100g': 90 } }); return x && x.p === 0 && x.cal === 90; })());
  const res = S.parseSearch({ products: [perServing, perServing, { product_name: 'Mystery', nutriments: {} }, ...Array.from({ length: 20 }, (_, i) => ({ product_name: 'F' + i, nutriments: { proteins_100g: 1 + i } }))] });
  ok('search: dedupes, drops empty, caps at 12', res.length === 12 && res[0].name === 'Skyr Vanilla' && !res.some((r) => r.name === 'Mystery'));
  ok('search/barcode with nothing sensible → empty / null', S.parseSearch(null).length === 0 && S.parseSearch({ products: 'x' }).length === 0
    && S.parseProduct({ status: 0 }) === null && S.parseProduct({ status: 1, code: '111', product: perServing }).name === 'Skyr Vanilla');
}

console.log('\n3. servings and the meal row');
{
  const food = { name: 'Skyr Vanilla', brand: 'Acme', label: '150 g', p: 17.4, c: 8.1, f: 0.2, cal: 100 };
  const two = S.toFav(food, 2);
  ok('2 servings doubles every macro and labels the name', two.p === 34.8 && two.c === 16.2 && two.cal === 200 && /Acme Skyr Vanilla ×2$/.test(two.name), JSON.stringify(two));
  ok('bad or huge servings fall back to 1 / cap at 20', S.toFav(food, 'abc').p === 17.4 && S.toFav(food, -3).p === 17.4 && S.scaleFood(food, 500).servings === 20);
  const row = F.addToMeal({ name: 'Eggs', p: '12', c: '1', f: '10', cal: '140' }, S.toFav(food, 1));
  ok('goes through the food log\'s own addToMeal: names join, macros add', row.name === 'Eggs + Acme Skyr Vanilla' && row.p === '29.4' && row.cal === '240', JSON.stringify(row));
  ok('a food with no numbers adds nothing', F.addToMeal({}, S.toFav({ name: 'X', brand: '', label: '1', p: 0, c: 0, f: 0, cal: 0 }, 1)) === null);
}

console.log('\n4. the CSP lets only the daily tracker call Open Food Facts');
{
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firebase.json'), 'utf8')).hosting.headers;
  // Firebase header globs as used in firebase.json: **, *, @(a|b) (same as csp-hardening).
  const globRe = (g) => {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; }
      else if (c === '*') re += '[^/]*';
      else if (c === '@' && g[i + 1] === '(') {
        const end = g.indexOf(')', i);
        re += '(?:' + g.slice(i + 2, end).split('|').map((s) => s.replace(/[.+?^${}()[\]\\]/g, '\\$&')).join('|') + ')';
        i = end;
      } else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + re + '$');
  };
  const effective = (p, key) => {
    let v = null;
    for (const r of rules) {
      if (!r.source || !globRe(r.source).test(p)) continue;
      const h = (r.headers || []).find((x) => x.key === key);
      if (h) v = h.value;
    }
    return v;
  };
  const connect = (v) => ((v || '').match(/connect-src[^;]*/) || [''])[0];
  for (const k of ['Content-Security-Policy', 'Content-Security-Policy-Report-Only']) {
    ok(k + ': /pro/daily-success and its sub-paths may connect to world.openfoodfacts.org',
      /https:\/\/world\.openfoodfacts\.org/.test(connect(effective('/pro/daily-success', k))) && /https:\/\/world\.openfoodfacts\.org/.test(connect(effective('/pro/daily-success/x', k))));
    ok(k + ': the CRM, the public site and the portal do not', ['/pro/dashboard', '/pro/portal', '/', '/services/roof-replacement'].every((p) => !/openfoodfacts/.test(effective(p, k) || '')));
    ok(k + ': nothing else changed on the daily tracker policy (still no Clarity, still frame-ancestors none)',
      !/clarity/.test(effective('/pro/daily-success/x', k)) && /frame-ancestors 'none'/.test(effective('/pro/daily-success/x', k)));
  }
}

console.log('\n5. wired into the page, safely');
{
  const html = fs.readFileSync(path.join(DS, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const at = (s) => html.indexOf(s);
  ok('logic then ui, after food-log.js, both external deferred (strict CSP)',
    at('js/food-search-logic.js') > at('js/food-log.js') && at('js/food-search-ui.js') > at('js/food-search-logic.js')
    && /food-search-logic\.js\?v=1" defer><\/script>/.test(html) && /food-search-ui\.js\?v=1" defer><\/script>/.test(html));
  ok('stylesheet version bumped for phones', /workout-coach\.css\?v=([5-9]|\d\d)\b/.test(html));
  const raw = fs.readFileSync(path.join(DS, 'js', 'food-search-ui.js'), 'utf8').replace(/\r\n/g, '\n');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('no inline handlers, eval or document.write', !/\bon[a-z]+\s*=\s*["']/.test(code) && !/\beval\(|new Function|document\.write/.test(code));
  ok('every food/brand/label from the network is escaped into the page', /esc\(f\.name\)/.test(code) && /esc\(f\.brand\)/.test(code) && /esc\(f\.label\)/.test(code) && /esc\(f\.p\)/.test(code));
  ok('requests time out (a hung lookup must not freeze the card)', /AbortController/.test(code) && /TIMEOUT_MS/.test(code));
  ok('no camera API ⇒ asks for the digits instead of a dead button', /'BarcodeDetector' in window/.test(code) && /type the digits/.test(code));
  ok('the camera is always released (stop on found, on Stop, on re-render)', (code.match(/stopScan\(\)/g) || []).length >= 4 && /getTracks\(\)\.forEach/.test(code));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
