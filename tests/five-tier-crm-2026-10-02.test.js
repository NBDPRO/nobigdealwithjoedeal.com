/**
 * tests/five-tier-crm-2026-10-02.test.js
 *
 * Five roof tiers in the CRM (Jo, 2026-10-02): Economy 440 / Good 550 /
 * Better 660 / Best 770 / Beyond 880 per SQ. Economy and Beyond are
 * CRM-only. Beyond is TAMKO HailGuard ONLY ("they're the only shingle that
 * offers a hail warranty, so we've gotta lock that"); Economy is Jo's pick
 * of an economy-grade architectural, NEVER a 3-tab, with a 1-year labor
 * warranty + the manufacturer's limited warranty and NO system warranty.
 *
 * Runs the REAL estimate-config / builder / logic engine / close-board in a
 * vm, and the server's deal acceptance + portal source. Three traps from the
 * 2026-10-02 map are pinned here:
 *   - device-saved 545/595/660 must not override the new rates;
 *   - an economy/beyond line-item estimate must not price materials at $0;
 *   - deal acceptance must accept the new tiers and never record $0.
 *
 * Run: node tests/five-tier-crm-2026-10-02.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs', 'pro', 'js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

function sandbox(store) {
  const data = Object.assign({}, store || {});
  const ls = { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; } };
  const ctx = { window: { localStorage: ls }, console: { log() {}, warn() {}, error() {} }, localStorage: ls };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JS, 'estimate-config.js'), 'utf8'), ctx);
  ctx.NBD_ESTIMATE_CONFIG = ctx.window.NBD_ESTIMATE_CONFIG;
  return ctx;
}
const withBuilder = (store) => { const c = sandbox(store); vm.runInContext(fs.readFileSync(path.join(JS, 'estimate-builder-v2.js'), 'utf8'), c); return c.window.EstimateBuilderV2; };

const C = require(path.join(JS, 'estimate-config.js'));
const TIERS = ['economy', 'good', 'better', 'best', 'beyond'];

console.log('\n1. Config: rates, order, labels, warranty wording');
ok('rates are 440 / 550 / 660 / 770 / 880', JSON.stringify(TIERS.map((t) => C.TIER_RATES[t])) === '[440,550,660,770,880]');
ok('TIER_ORDER is the five, cheapest first', C.TIER_ORDER.join() === TIERS.join());
ok('labels: Economy / Standard / Preferred / Elite / Beyond', TIERS.map(C.tierLabel).join() === 'Economy,Standard,Preferred,Elite,Beyond');
ok('catalog pricing column: economy → good, beyond → best, others unchanged', C.productTier('economy') === 'good' && C.productTier('beyond') === 'best' && C.productTier('better') === 'better');
const eco = C.tierWarrantyText('economy');
ok('Economy warranty: 1-year labor + manufacturer limited, NO system warranty, never "lifetime"',
  /1-year workmanship/.test(eco) && /limited warranty/.test(eco) && /No system warranty/.test(eco) && !/lifetime/i.test(eco), eco);
ok('Economy blurb says 1-year labor', C.tierWarrantyBlurb('economy') === '1-year labor warranty');
const bey = C.tierWarrantyText('beyond');
ok('Beyond warranty: Elite terms + TAMKO HailGuard hail warranty', /fully transferable/.test(bey) && /annual courtesy inspection/.test(bey) && /HailGuard hail warranty/.test(bey), bey);
ok('Good/Better/Best wording unchanged (still lifetime)', TIERS.slice(1, 4).every((t) => /^Lifetime workmanship warranty/.test(C.tierWarrantyText(t))));
ok('a rate generation stamp exists (device-saved rates are checked against it)', typeof C._ratesVersion === 'string' && C._ratesVersion.length >= 10);

console.log('\n2. Shingle locks');
const HG = { code: 'RFG 240-TAMKO-HAIL', name: 'TAMKO HailGuard', sub: 'shingles-impact' };
const HDZ = { code: 'RFG 240-GAF-HDZ', name: 'GAF Timberline HDZ', sub: 'shingles-arch' };
const TAB = { code: 'RFG 3T20', name: '3-Tab Shingles 20yr', sub: 'shingles-3tab' };
const RIDGE = { code: 'RFG RIDG-TAMKO', name: 'TAMKO hip & ridge', sub: 'ridge' };
ok('Beyond with HailGuard (+ non-shingle accessories) passes', C.checkTierShingles('beyond', [HG, RIDGE]).ok);
ok('Beyond with any other shingle fails, naming it', !C.checkTierShingles('beyond', [HG, HDZ]).ok && /HDZ.*HailGuard only/.test(C.checkTierShingles('beyond', [HDZ]).problems[0]));
ok('Economy with a 3-tab fails; with an architectural passes', !C.checkTierShingles('economy', [TAB]).ok && C.checkTierShingles('economy', [HDZ]).ok);
ok('Good/Better/Best have no shingle lock', ['good', 'better', 'best'].every((t) => C.checkTierShingles(t, [TAB, HDZ, HG]).ok));
// The real catalog: the locked code exists and the 3-tab rule matches its 3-tabs.
const catSrc = fs.readFileSync(path.join(JS, 'estimate-catalog-xactimate.js'), 'utf8');
ok('the catalog has RFG 240-TAMKO-HAIL and its 3-tabs are sub "shingles-3tab"', /code:'RFG 240-TAMKO-HAIL'/.test(catSrc) && /code:'RFG 3T20'[^\n]*sub:'shingles-3tab'/.test(catSrc) && /code:'RFG 240-TAMKO-HERITAGE'/.test(catSrc));

console.log('\n3. The V2 engine prices all five');
const input = { method: 'per-sq', mode: 'insurance', rawSqft: 2000, pitch: '6/12', wasteFactorOverride: 1.0 };
const B = withBuilder();
const all = B.calculateAllTiers(input);
ok('calculateAllTiers returns all five', TIERS.every((t) => all[t] && typeof all[t].total === 'number'), Object.keys(all).join());
ok('each tier is priced at its own rate', TIERS.every((t) => all[t].rate === C.TIER_RATES[t]));
ok('totals climb with the tier, $2,200 apart on 20 SQ (same fees on each)',
  TIERS.slice(1).every((t, i) => all[t].total - all[TIERS[i]].total === 2200), TIERS.map((t) => all[t].total).join(' < '));
const li = (tier) => B.calculateEstimate({ method: 'line-item', tier, mode: 'insurance', rawSqft: 2000, pitch: '6/12', wasteFactorOverride: 1 });
const shingleOf = (r) => (r.lineItems || r.items || []).filter((i) => /shingle|HailGuard/i.test(i.name || '')).map((i) => i.name).join('|');
ok('line-item Beyond builds with TAMKO HailGuard', /TAMKO HailGuard/.test(shingleOf(li('beyond'))), shingleOf(li('beyond')));
ok('line-item Economy builds with the economy-grade line (never 3-tab)', /Economy Grade/.test(shingleOf(li('economy'))) && !/3-Tab/i.test(shingleOf(li('economy'))));
ok('no new published cost literal: Economy/Beyond copy the Good/Best starter figures',
  /CATALOG\['shingle-economy'\] = Object\.assign\(\{\}, CATALOG\['shingle-good'\]/.test(read('docs/pro/js/estimate-builder-v2.js'))
    && /CATALOG\['shingle-beyond'\] = Object\.assign\(\{\}, CATALOG\['shingle-best'\]/.test(read('docs/pro/js/estimate-builder-v2.js')));

console.log('\n4. Device-saved rates (the stale-price trap)');
const stale = withBuilder({ nbd_est_settings_v3: JSON.stringify({ tierRates: { good: 545, better: 595, best: 660 } }) });
ok('a device that saved 545/595/660 (no version) now quotes the new rates', stale.calculateEstimate(Object.assign({ tier: 'better' }, input)).rate === 660 && stale.calculateEstimate(Object.assign({ tier: 'good' }, input)).rate === 550);
const fresh = withBuilder({ nbd_est_settings_v3: JSON.stringify({ tierRates: { better: 700 }, tierRatesVersion: C._ratesVersion }) });
ok('a rate saved under the current version is honoured', fresh.calculateEstimate(Object.assign({ tier: 'better' }, input)).rate === 700);
const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
ok('Settings Save stamps the rate version and saves all five', /tierRatesVersion: _cfg\._ratesVersion/.test(boot) && /\['economy', 'Economy'\][^\n]*\['beyond', 'Beyond'\]/.test(boot));
const dash = read('docs/pro/dashboard.html');
ok('Settings has Economy + Beyond rate inputs', /id="v2rateEconomy" value="440"/.test(dash) && /id="v2rateBeyond" value="880"/.test(dash));
ok('the cost inputs publish no cost figures', !/id="v2cost\w+" value="[1-9]/.test(dash));

console.log('\n5. Line-item materials never price at $0 for the new tiers');
{
  const c = sandbox();
  c.window.NBD_PRODUCTS = [{ id: 'p1', name: 'Shingle', unit: 'SQ', pricing: { good: { sell: 100 }, better: { sell: 120 }, best: { sell: 150 } } }];
  vm.runInContext(fs.readFileSync(path.join(JS, 'estimate-logic-engine.js'), 'utf8'), c);
  const L = c.window.EstimateLogic;
  ok('economy prices off the Good column', L.resolveMaterial('p1', 'economy').sell === 100);
  ok('beyond prices off the Best column', L.resolveMaterial('p1', 'beyond').sell === 150);
  ok('better is unchanged', L.resolveMaterial('p1', 'better').sell === 120);
}

console.log('\n6. Builder UI: five buttons, the lock is enforced three ways');
const ui = read('docs/pro/js/estimate-v2-ui.js');
ok('five tier buttons', TIERS.every((t) => new RegExp('id="v2tier' + t[0].toUpperCase() + t.slice(1) + '"[^>]*data-arg="' + t + '"').test(ui)));
ok('setTierChoice accepts any configured tier and swaps shingles on the way in', /if \(_v2Tiers\(\)\.indexOf\(arg\) === -1\) return;/.test(ui) && /_v2EnforceTierShingles\(arg\);/.test(ui));
ok('adding a forbidden shingle is BLOCKED (returns before the push)', /const chk = _cfgT\.checkTierShingles\(state\.tier, \[item\]\);\s*if \(!chk\.ok\) \{[\s\S]{0,200}?return;/.test(ui));
ok('save refuses a scope that breaks the tier lock', /const chk = _cfgS\.checkTierShingles\(state\.tier, _v2ScopeItems\(\)\);/.test(ui));
ok('saved prices carry every tier', /_v2Tiers\(\)\.forEach\(k => \{ if \(tiers\[k\]\) estimate\.prices\[k\] = tiers\[k\]\.total; \}\);/.test(ui));
{
  // Run the real swap with a fake catalog.
  const at = ui.indexOf('  const _V2_TIER_SWAP');
  const end = ui.indexOf('\n  }', ui.indexOf('function _v2EnforceTierShingles')) + 4;
  const ctx = { window: { NBD_ESTIMATE_CONFIG: C, NBD_XACT_CATALOG: { find: (code) => [HG, HDZ, TAB, RIDGE, { code: 'RFG 240-TAMKO-HERITAGE', name: 'TAMKO Heritage', sub: 'shingles-arch' }].find((x) => x.code === code) || null }, showToast() {} }, state: {} };
  vm.createContext(ctx);
  vm.runInContext(ui.slice(at, end) + '\nthis.enforce = _v2EnforceTierShingles;', ctx);
  ctx.state.scope = [{ code: 'RFG 240-GAF-HDZ' }, { code: 'RFG RIDG-TAMKO' }];
  ctx.enforce('beyond');
  ok('switching to Beyond swaps the shingle to HailGuard, keeps accessories', ctx.state.scope.map((x) => x.code).join() === 'RFG 240-TAMKO-HAIL,RFG RIDG-TAMKO', JSON.stringify(ctx.state.scope));
  ctx.state.scope = [{ code: 'RFG 3T20' }, { code: 'RFG RIDG-TAMKO' }];
  ctx.enforce('economy');
  ok('switching to Economy swaps a 3-tab to TAMKO Heritage', ctx.state.scope[0].code === 'RFG 240-TAMKO-HERITAGE');
  ctx.state.scope = [{ code: 'RFG 240-GAF-HDZ' }];
  ctx.enforce('economy');
  ok("...and leaves Jo's architectural pick alone", ctx.state.scope[0].code === 'RFG 240-GAF-HDZ');
  // Beyond → Economy (seen in a real browser run): HailGuard is the Beyond
  // product and must not ride along onto an Economy quote.
  ctx.state.scope = [{ code: 'RFG 240-TAMKO-HAIL' }];
  ctx.enforce('economy');
  ok('Beyond → Economy swaps HailGuard to TAMKO Heritage', ctx.state.scope[0].code === 'RFG 240-TAMKO-HERITAGE');
}

console.log('\n7. Deal room + server');
const deal = read('functions/deal-acceptance.js');
ok('deal acceptance takes all five tiers', /const VALID_TIERS = \['economy', 'good', 'better', 'best', 'beyond'\];/.test(deal));
ok('the server snapshots every tier price (no 3-key literal)', /VALID_TIERS\.forEach\(\(t\) => \{ tierPrices\[t\] = Number\(tiers\[t\] && tiers\[t\]\.price\) \|\| 0; \}\);/.test(deal));
ok('an unpriced package is refused, never recorded at $0', /if \(!\(price > 0\)\) \{[\s\S]{0,120}e\._http = 400/.test(deal));
const portal = read('functions/portal.js');
ok('the portal carries all five prices and labels', /const PORTAL_TIERS = \['economy', 'good', 'better', 'best', 'beyond'\];/.test(portal) && /for \(const k of PORTAL_TIERS\)/.test(portal));
ok('estimate-rows labels all five, both copies identical', /economy: 'Economy'/.test(read('functions/customer-estimate-rows.js')) && read('functions/customer-estimate-rows.js') === read('docs/pro/js/customer-estimate-rows.js'));
{
  // The real deal page for a five-tier deal, and an old three-tier one.
  const c = sandbox();
  c.window.addEventListener = () => {}; c.document = { getElementById: () => null, addEventListener() {} }; c.window.document = c.document;
  c.setTimeout = setTimeout; c.navigator = {};
  try {
    vm.runInContext(fs.readFileSync(path.join(JS, 'close-board.js'), 'utf8'), c);
    const CB = c.window.CloseBoard;
    const t = (p) => ({ price: p, description: '', lineItems: [] });
    const html5 = CB.generatePageHTML({ id: 'd1', customerName: 'Pat', address: '1 Test St, Milford OH', tiers: { economy: t(9000), good: t(11000), better: t(13000), best: t(15000), beyond: t(17000) } });
    const order = [...html5.matchAll(/data-deal-tier="(\w+)"/g)].map((m) => m[1]).join();
    ok('the deal page shows all five priced tiers, cheapest first', order === TIERS.join(), order);
    ok('...with Beyond described as TAMKO HailGuard and Economy as 1-year labor', /TAMKO HailGuard/.test(html5) && /1-year labor warranty/.test(html5));
    const html3 = CB.generatePageHTML({ id: 'd2', customerName: 'Pat', address: '1 Test St, Milford OH', tiers: { good: t(11000), better: t(13000), best: t(15000) } });
    ok('an older three-tier deal renders exactly its three', [...html3.matchAll(/data-deal-tier="(\w+)"/g)].map((m) => m[1]).join() === 'good,better,best');
    const html0 = CB.generatePageHTML({ id: 'd3', customerName: 'Pat', address: '1 Test St, Milford OH', tiers: { good: t(11000), better: t(0), best: t(15000) } });
    ok('an unpriced tier never shows as a $0 package', !/data-deal-tier="better"/.test(html0));
  } catch (e) {
    ok('close-board loads in a vm', false, e.message);
  }
}

console.log('\n8. Homeowner portal warranty card');
{
  const pj = read('docs/pro/js/portal.js');
  ok('an Economy card never falls back to the Lifetime Pledge title',
    /const pledgeTitle = w\.tier === 'economy'\s*\? 'Economy — 1-Year Labor Warranty'/.test(pj) && /esc\(w\.tierLabel \|\| pledgeTitle\)/.test(pj));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
