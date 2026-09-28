/**
 * tests/route-truth.test.js
 *
 * The dashboard's navigation must not lie about where the user is.
 *
 * THREE BUGS THIS PINS (all found 2026-09-03, all phone-first)
 * ────────────────────────────────────────────────────────────
 *  1. goTo() writes '#/crm' — with a LEADING SLASH (dashboard-actions.js).
 *     mobile-nav-customizer's setActiveTab stripped only the '#', compared
 *     '/crm' against the tab id 'crm', and so lit NO tab after any
 *     navigation. Its `hash === ''` fallback was dead code (the `|| 'dash'`
 *     default meant hash was never ''), so a cold load lit 'dash' while the
 *     Home/Widgets view was on screen. The bar was wrong in both directions.
 *
 *  2. The hashchange handler sent an empty hash to 'dash' while the boot sent
 *     the identical empty hash to 'home'. Browser Back from the first view
 *     therefore landed on the ops-overview Dashboard, a screen the user never
 *     opened.
 *
 *  3. billing-gate.js's upgrade-modal CTA called goTo('billing'). 'billing'
 *     is not in routeConfig, so goTo fell through and dropped the user on the
 *     pipeline. Billing is a TAB inside Settings.
 *
 * Bug 3 is the same class as the three revenue views the 2026-09-02 session
 * fixed (#/expenses, #/money, #/refrewards shipped with nav entries and goTo
 * branches but no route). A goTo() literal that names a non-route is always a
 * bug, and it is statically checkable — so this file checks it.
 *
 * Pure-Node, no emulator. Run: node tests/route-truth.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'docs', 'pro', 'js');
const read = (f) => fs.readFileSync(path.join(JS_DIR, f), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else {
    console.log('  ✗ ' + label + (detail ? ' — ' + detail : ''));
    failed++; fails.push(label + (detail ? ' — ' + detail : ''));
  }
}

// ── routeConfig keys, parsed from source (dashboard-state.js is a classic
//    script full of browser globals, so it cannot simply be require()d).
const stateSrc = read('dashboard-state.js');
const rcBlock = stateSrc.match(/const routeConfig = \{([\s\S]*?)\n\};/);
const ROUTES = new Set(rcBlock ? [...rcBlock[1].matchAll(/'([A-Za-z0-9_-]+)'\s*:/g)].map((m) => m[1]) : []);

console.log('\nROUTE TABLE');
ok('routeConfig parsed from dashboard-state.js', !!rcBlock);
ok('routeConfig has a plausible number of routes (' + ROUTES.size + ')', ROUTES.size > 20);
ok("'home' is a route", ROUTES.has('home'));
ok("'settings' is a route", ROUTES.has('settings'));
// The three the previous session had to add — pinned so they cannot vanish.
['expenses', 'money', 'refrewards'].forEach((r) => ok("'" + r + "' is a route (added 2026-09-02)", ROUTES.has(r)));

console.log('\nEVERY goTo() LITERAL NAMES A REAL ROUTE');
{
  const bad = [];
  let literals = 0;
  for (const f of fs.readdirSync(JS_DIR).filter((x) => x.endsWith('.js'))) {
    const src = read(f);
    src.split(/\r?\n/).forEach((line, i) => {
      const trimmed = line.trim();
      // Skip comment lines — dashboard-ui.js:125 documents the old inline
      // `onclick="goTo('xxx')"` handlers in prose.
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      for (const m of line.matchAll(/goTo\(\s*['"]([A-Za-z0-9_-]+)['"]/g)) {
        literals++;
        if (!ROUTES.has(m[1])) bad.push(f + ':' + (i + 1) + " goTo('" + m[1] + "')");
      }
    });
  }
  ok('found goTo() literals to check (' + literals + ')', literals > 10);
  ok('no goTo() names a route that does not exist',
     bad.length === 0,
     bad.join(' | ') + ' — add it to routeConfig, or navigate somewhere real');
}

console.log('\nONE HASH PARSER, ONE DEFAULT');
{
  ok('dashboard-state.js defines routeFromHash', /function routeFromHash\s*\(/.test(stateSrc));
  // The leading slash is the whole bug: '#/crm' must yield 'crm'.
  ok('routeFromHash strips the leading slash goTo writes',
     /replace\(\/\^#\/,\s*''\)[\s\S]{0,80}split\('\/'\)[\s\S]{0,80}filter/.test(stateSrc));
  ok("routeFromHash defaults an empty hash to 'home'", /parts\[0\]\s*\|\|\s*'home'/.test(stateSrc));

  const mainSrc = read('dashboard-main.js');
  ok('dashboard-main uses routeFromHash', /routeFromHash\(\)/.test(mainSrc));
  // Both entry points must go through it — a second hand-rolled parse is how
  // the two defaults drifted apart in the first place.
  const uses = (mainSrc.match(/routeFromHash\(\)/g) || []).length;
  ok('dashboard-main uses it in BOTH the hashchange and boot paths (' + uses + ')', uses >= 2);
  ok('dashboard-main no longer hand-rolls hash.slice(1)',
     !/window\.location\.hash\.slice\(1\)/.test(mainSrc));
  ok("the hashchange handler no longer defaults to 'dash'",
     !/goTo\('dash',\s*\{\s*skipHash/.test(mainSrc));

  const navSrc = read('mobile-nav-customizer.js');
  ok('mobile-nav uses the shared parser', /routeFromHash/.test(navSrc));
  ok('mobile-nav no longer strips only the "#"',
     !/hash\?\.replace\('#',\s*''\)/.test(navSrc));
  ok('mobile-nav re-syncs the bar on navigation (hashchange listener)',
     /addEventListener\('hashchange',\s*setActiveTab\)/.test(navSrc));
}

console.log('\nrouteFromHash BEHAVIOUR — the actual parse, not its shape');
{
  // dashboard-state.js is a classic browser script (window globals, top-level
  // const), so it cannot be require()d. routeFromHash is pure and
  // self-contained, so lift its source and evaluate just that function.
  const fnSrc = stateSrc.match(/function routeFromHash\s*\([\s\S]*?\n\}/);
  ok('routeFromHash source extracted', !!fnSrc);
  let parse = null;
  if (fnSrc) {
    // `window` is referenced only on the no-argument path; stub it so the
    // explicit-argument cases below run unchanged.
    // eslint-disable-next-line no-new-func
    parse = new Function('window', fnSrc[0] + '; return routeFromHash;')({ location: { hash: '' } });
  }
  const nm = (h) => (parse ? parse(h).name : '<no parse>');
  const id = (h) => (parse ? parse(h).id : '<no parse>');

  // THE BUG: goTo writes the leading slash. This is the case that was broken.
  ok("'#/crm' -> 'crm' (the leading slash that broke the bottom bar)", nm('#/crm') === 'crm', nm('#/crm'));
  ok("'#/crm/abc123' -> name 'crm'", nm('#/crm/abc123') === 'crm', nm('#/crm/abc123'));
  ok("'#/crm/abc123' -> id 'abc123'", id('#/crm/abc123') === 'abc123', String(id('#/crm/abc123')));
  // Empty and degenerate hashes all mean home — the disagreement between the
  // boot path and the hashchange path is what sent Back to the Dashboard.
  ok("'' -> 'home'", nm('') === 'home', nm(''));
  ok("'#' -> 'home'", nm('#') === 'home', nm('#'));
  ok("'#/' -> 'home'", nm('#/') === 'home', nm('#/'));
  ok("'/' -> 'home'", nm('/') === 'home', nm('/'));
  // Legacy slash-less shape must still resolve, so an old bookmark works.
  ok("'#crm' (legacy, no slash) -> 'crm'", nm('#crm') === 'crm', nm('#crm'));
  ok("no id yields null, not undefined", id('#/crm') === null, String(id('#/crm')));
  // Every real route must round-trip through the hash goTo() writes for it.
  {
    const broken = [...ROUTES].filter((r) => parse && parse('#/' + r).name !== r);
    ok('every routeConfig key round-trips through its own goTo hash',
       broken.length === 0, broken.join(', '));
  }
}

console.log('\nTHE BILLING CTA GOES TO BILLING');
{
  const bg = read('billing-gate.js');
  ok("billing-gate no longer calls goTo('billing')", !/goTo\('billing'\)/.test(bg));
  ok('billing-gate routes to the settings view', /goTo\('settings'[,)]/.test(bg));
  // Since 2026-09-28 the tab rides in goTo's route id: a separate
  // switchSettingsTab('billing') was undone by goTo's 50 ms default-tab timer
  // (behaviour pinned in settings-deep-link-tab-2026-09-28.test.js).
  ok('billing-gate selects the billing tab', /goTo\('settings',\s*\{\s*id:\s*'billing'\s*\}\)/.test(bg));
  // switchSettingsTab looks up '#stab-panel-' + tab and '#stab-' + tab, so
  // the markup has to carry both or the call silently no-ops.
  const html = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');
  ok('dashboard.html has #stab-panel-billing', html.includes('id="stab-panel-billing"'));
  ok('dashboard.html has #stab-billing', html.includes('id="stab-billing"'));
  ok('switchSettingsTab exists in ui.js',
     /function switchSettingsTab\s*\(/.test(fs.readFileSync(path.join(JS_DIR, 'ui.js'), 'utf8')));
}

console.log('\n──────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
