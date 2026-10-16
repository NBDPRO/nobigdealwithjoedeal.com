#!/usr/bin/env node
/**
 * tests/site-search-2026-10-16.test.js — search everywhere (repos report
 * 2026-10-16 items 6 and 7).
 *
 *   A. CRM: docs/pro/js/lead-search.js (MiniSearch 7.2.0) finds leads with
 *      typos and prefixes across name, address, claim, phone, email, notes
 *   B. the command palette loads it on open (never at boot) and ranks its
 *      typo hits under exact matches; it reads only window._leads
 *   C. Field: a Search button in its header opens the palette
 *   D. public: scripts/build-site-search.mjs indexes only sitemap pages, never
 *      /pro, /admin, /sites, /tools, /dev or a noindex page
 *   E. firebase.json: 'wasm-unsafe-eval' on /search and /pagefind/** ONLY, and
 *      those two policies are otherwise the '**' policy (drift guard)
 *   F. the /search page, the header entry, the deploy + CI wiring
 *
 * Run: node tests/site-search-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 400) : '')); failed++; fails.push(label); }
}

(async () => {
  console.log('\nA. lead-search.js');
  {
    global.MiniSearch = require(path.join(ROOT, 'docs/assets/vendor/minisearch/7.2.0/minisearch.min.js'));
    const LS = require(path.join(ROOT, 'docs/pro/js/lead-search.js'));
    const leads = [
      { id: 'a', firstName: 'Jordan', lastName: 'Avery', address: '214 Sample Ridge Rd, Fort Thomas, KY', zip: '41075', phone: '(859) 555-0110', email: 'jordan@example.com', claimNumber: 'SF-22-81934', insCarrier: 'State Farm', notes: 'Hail on the north slope, skylight leaks' },
      { id: 'b', firstName: 'Maya', lastName: 'Brooks', address: '9 Elm St, Florence, KY', phone: '8595550188' },
      { id: 'c', firstName: 'Jordan', lastName: 'Lee', address: '1 Main St, Covington, KY' },
    ];
    const ids = (q) => (LS.search(q, leads) || []).map((h) => h.lead.id);
    ok('a typo in the name finds the lead ("jordn avry")', ids('jordn avry')[0] === 'a', JSON.stringify(ids('jordn avry')));
    ok('a typo in the street finds the lead ("sampel ridge")', ids('sampel ridge')[0] === 'a');
    ok('a prefix works ("broo")', ids('broo')[0] === 'b');
    ok('the claim number finds it', ids('SF-22-81934')[0] === 'a');
    ok('the carrier finds it', ids('state farm')[0] === 'a');
    ok('words in the notes find it ("skylight")', ids('skylight')[0] === 'a');
    ok('every word must match first: "jordan covington" is Jordan Lee', ids('jordan covington')[0] === 'c');
    ok('an empty query gives nothing', ids('').length === 0);
    const added = leads.concat([{ id: 'd', firstName: 'Priya', lastName: 'Nair', address: '5 Oak Ave' }]);
    ok('a new lead (new array) is findable at once', (LS.search('priya', added) || []).map((h) => h.lead.id)[0] === 'd');
    delete global.MiniSearch;
    ok('before MiniSearch loads, search() says null (the palette keeps its classic match)', LS.search('jordan', leads) === null);
    const src = read('docs/pro/js/lead-search.js');
    ok('MiniSearch is the vendored, pinned file', /'\/assets\/vendor\/minisearch\/7\.2\.0\/minisearch\.min\.js'/.test(src) && /MiniSearch 7\.2\.0 \| MIT/.test(read('docs/assets/vendor/minisearch/7.2.0/minisearch.min.js').slice(0, 200)));
    ok('lead-search.js makes no Firestore call of its own', !/getDocs|onSnapshot|collection\(|fetch\(/.test(src));
  }

  console.log('\nB. the command palette');
  {
    const cp = read('docs/pro/js/command-palette.js');
    const openFn = cp.slice(cp.indexOf('  function open() {'), cp.indexOf('  function close() {'));
    ok('lead-search.js is injected the first time the palette opens', /_ensureLeadSearch\(\);/.test(openFn) && /LEAD_SEARCH_SRC = '\/pro\/js\/lead-search\.js\?v=\d+'/.test(cp));
    ok('no boot <script> tag for lead-search or MiniSearch', !/lead-search|minisearch/i.test(read('docs/pro/dashboard.html')) && !/lead-search|minisearch/i.test(read('docs/pro/customer.html')));
    ok('the palette searches the same window._leads it always did', /window\.NBDLeadSearch\.search\(q, leads, 40\)/.test(cp));
    // Behaviour: run _buildLeadResults' ranking with a stub NBDLeadSearch.
    const ctxWin = {
      _leads: [{ id: 'x', firstName: 'Jordan', lastName: 'Avery', address: '214 Sample Ridge Rd' }, { id: 'y', firstName: 'Jordana', lastName: 'Ray', address: '3 Pine' }],
      NBDLeadSearch: { search: (q) => (q === 'jordn' ? [{ lead: { id: 'x' } }] : []) },
      addEventListener() {}, localStorage: { getItem: () => null, setItem() {} },
    };
    const doc = { addEventListener() {}, getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { appendChild() {} }, querySelector: () => null };
    ctxWin.document = doc;
    const ctx = { window: ctxWin, document: doc, console, localStorage: ctxWin.localStorage, setTimeout: () => 1, navigator: { platform: 'Win' }, Map, Set, JSON, Math, String, Number, Array, Object, Promise, Date };
    vm.createContext(ctx);
    let ran = true;
    try { vm.runInContext(cp, ctx); } catch (e) { ran = false; }
    ok('command-palette.js runs in a sandbox', ran && !!ctxWin.NBDCommand);
    ok('the palette source ranks a typo-only hit under exact matches (35 - rank, floor 10)', /fuzzy = fuzzy > 0 \? fuzzy \+ 5 : Math\.max\(10, 35 - ms\)/.test(cp));
  }

  console.log('\nC. Field search');
  {
    const f = read('docs/pro/js/layouts/field.js');
    ok('Field\'s Today header has a Search button', /searchBtn\(\) \+ sunBtn\(\)/.test(f) && /data-fa="search" aria-label="Search customers"/.test(f));
    ok('it opens the command palette (no second search UI)', /a === 'search'[\s\S]{0,120}W\.NBDCommand\.open\(\)/.test(f));
  }

  console.log('\nD. the public index');
  {
    const S = await import(require('url').pathToFileURL(path.join(ROOT, 'scripts/build-site-search.mjs')).href);
    const xml = '<urlset><url><loc>https://nobigdealwithjoedeal.com/</loc></url><url><loc>https://nobigdealwithjoedeal.com/inspect</loc></url>' +
      '<url><loc>https://nobigdealwithjoedeal.com/pro/dashboard</loc></url><url><loc>https://nobigdealwithjoedeal.com/sites/oaks</loc></url>' +
      '<url><loc>https://nobigdealwithjoedeal.com/admin</loc></url><url><loc>https://nobigdealwithjoedeal.com/search</loc></url><url><loc>https://example.com/x</loc></url></urlset>';
    const urls = S.publicPages(xml).map((p) => p.url);
    ok('only public sitemap pages are indexed', JSON.stringify(urls) === JSON.stringify(['/', '/inspect']), JSON.stringify(urls));
    ok('private prefixes are refused by path too', ['/pro', '/pro/x', '/admin/y', '/sites/oaks', '/tools/a', '/dev', '/search'].every(S.isPrivate) && !S.isPrivate('/products') && !S.isPrivate('/services/roof-repair'));
    ok('pagefind is pinned to 1.5.2', S.PAGEFIND_VERSION === '1.5.2');
    ok('nav, header, footer and forms are not indexed', ['nav', 'header', 'footer', 'form'].every((x) => S.EXCLUDE_SELECTORS.indexOf(x) !== -1));
    ok('noindex pages are skipped at build time', /NOINDEX_RE\.test\(html\)/.test(read('scripts/build-site-search.mjs')));
    ok('site-integrity skips only /pagefind/ (generated at deploy), nothing else', read('scripts/check-site-integrity.js').includes('const GENERATED_AT_DEPLOY = /^\\/pagefind\\//;'));
    ok('docs/pagefind is generated, never committed', /^docs\/pagefind\/\r?$/m.test(read('.gitignore')));
  }

  console.log('\nE. firebase.json CSP');
  {
    const fb = JSON.parse(read('firebase.json'));
    const H = fb.hosting.headers;
    const val = (rule, key) => ((rule.headers || []).find((h) => h.key === key) || {}).value || '';
    const star = H.find((r) => r.source === '**');
    const withWasm = H.filter((r) => /wasm-unsafe-eval/.test(val(r, 'Content-Security-Policy')) || /wasm-unsafe-eval/.test(val(r, 'Content-Security-Policy-Report-Only')));
    ok('exactly two rules carry wasm-unsafe-eval: /search and /pagefind/**', JSON.stringify(withWasm.map((r) => r.source)) === JSON.stringify(['/search', '/pagefind/**']), JSON.stringify(withWasm.map((r) => r.source)));
    const base = val(star, 'Content-Security-Policy');
    for (const r of withWasm) {
      const v = val(r, 'Content-Security-Policy');
      ok(r.source + ': the enforced policy is "**" plus wasm-unsafe-eval in script-src, nothing else', v === base.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'"));
      ok(r.source + ': script-src-elem did not get it', !/script-src-elem[^;]*wasm-unsafe-eval/.test(v));
      ok(r.source + ': Report-Only = the enforced policy + the report endpoints (no style-attribute flood)', val(r, 'Content-Security-Policy-Report-Only') === v + ' report-uri /cspReport; report-to csp-endpoint;');
    }
    const iStar = H.indexOf(star), iSearch = H.findIndex((r) => r.source === '/search');
    ok('the rules sit after "**" (last match wins)', iSearch > iStar);
  }

  console.log('\nF. page, header, wiring');
  {
    const page = read('docs/search.html');
    ok('/search loads the Component UI script + stylesheet from /pagefind, deferred', /<script defer src="\/pagefind\/pagefind-component-ui\.js"><\/script>/.test(page) && /<link rel="stylesheet" href="\/pagefind\/pagefind-component-ui\.css">/.test(page));
    ok('/search is noindex and has no inline script', /<meta name="robots" content="noindex, follow">/.test(page) && !/<script(?![^>]*\ssrc=)[^>]*>/.test(page));
    ok('/search has the input, summary and results', /<pagefind-input /.test(page) && /<pagefind-summary>/.test(page) && /<pagefind-results /.test(page));
    const nav = read('docs/assets/js/nbd-nav.js');
    ok('the header entry is added by nbd-nav.js (no partial restamp), never on /pro, /admin, /sites, /tools or /search', /function addSearchEntry\(\)/.test(nav) && /\^\\\/\(pro\|admin\|sites\|tools\|dev\)/.test(nav) && /addSearchEntry\(\);/.test(nav));
    ok('nbd-nav.js keeps its iOS 12 floor (no ?. or ??)', !/\?\.|\?\?/.test(nav.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
    const dep = read('.github/workflows/firebase-deploy.yml');
    ok('the deploy builds the index (pinned pagefind) before Hosting', /build-site-search\.mjs --install/.test(dep) && dep.indexOf('build-site-search.mjs') < dep.indexOf('- name: Deploy Hosting'));
    const ci = read('.github/workflows/ci.yml');
    const pub = ci.slice(ci.indexOf('  public-e2e:'), ci.indexOf('\n  qc-render-sweep:'));
    ok('CI builds the index and runs site-search.spec.js on Chromium + mobile WebKit', /build-site-search\.mjs/.test(pub) && /site-search\.spec\.js/.test(pub) && /\(nav-drawer\|site-search\)\\\.spec\\\.js/.test(read('tests/playwright.config.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})();
