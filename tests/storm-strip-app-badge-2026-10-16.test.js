#!/usr/bin/env node
/**
 * tests/storm-strip-app-badge-2026-10-16.test.js — the shared storm strip and
 * the installed app's badge.
 *
 *   A. the strip shows only when a warning or hail touches the territory or a customer
 *   B. a failed read is "Storm feed unavailable", never an all-clear; Mission is offered, never forced
 *   C. the app badge = the Needs-you count; untouched while checking or failed; cleared at 0
 *   D. wiring: Home + Field hosts, Field's old cached line gone, lazy bundle, CSP-clean
 *
 * Run: node tests/storm-strip-app-badge-2026-10-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SS = require(path.join(ROOT, 'docs/pro/js/storm-strip.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}
const NOW = Date.parse('2026-10-16T18:00:00Z');
const H = 3600000, D = 86400000;

(async () => {
  console.log('\nA. only when something touches the territory or a customer');
  {
    const leads = [
      { id: 'a', hailHit: { sizeInches: 1.25, at: new Date(NOW - D).toISOString() } },
      { id: 'b', hailHit: { sizeInches: 1.75, at: NOW - 2 * D } },
      { id: 'c', hailHit: { sizeInches: 2, at: NOW - 5 * D } },
      { id: 'd', deleted: true, hailHit: { sizeInches: 3, at: NOW - H } },
    ];
    ok('clear sky, no recent hail: nothing to show', SS.summarize([], [], NOW).state === 'clear');
    ok('not read yet: nothing yet (no flash of a warning or an all-clear)', SS.summarize(undefined, [], NOW).state === 'loading');
    const w = SS.summarize([{ event: 'Severe Thunderstorm Warning', hailIn: 1.5, expires: new Date(NOW + H).toISOString(), leadIds: ['a', 'b', 'x'] }, { event: 'Tornado Warning', leadIds: [], expires: NOW + H }], [], NOW);
    ok('a warning over customers shows, with how many are inside', w.state === 'warn' && w.warnings[0].customers === 3 && w.warnings[0].hailIn === 1.5);
    ok('a zone-wide warning (no polygon) still shows, as "over your area"', w.warnings.length === 2 && w.warnings[1].customers === 0);
    ok('an expired warning does not', SS.summarize([{ event: 'Old', expires: NOW - 60000, leadIds: ['a'] }], [], NOW).state === 'clear');
    const h = SS.summarize([], leads, NOW);
    ok('hail-cron hits from the last 3 days show (size = the largest)', h.state === 'warn' && h.hail.count === 2 && h.hail.maxIn === 1.75, JSON.stringify(h));
    ok('older hail, or a deleted customer, does not', !SS.summarize([], [leads[2], leads[3]], NOW).hail.count);
  }

  console.log('\nB. a failed read is never an all-clear; Mission is offered, never forced');
  {
    const fail = SS.summarize(null, [], NOW);
    ok('a failed warning read is its own state', fail.state === 'fail');
    const win = { document: null, addEventListener() {}, LayoutEngine: null, LayoutRegistry: null };
    const doc = { querySelectorAll: () => [], getElementById: () => null, addEventListener() {}, body: {}, hidden: false };
    win.document = doc;
    const ctx = { window: win, document: doc, console, Date, Math, JSON, String, Array, Object, Number, isFinite, Promise, setTimeout: () => 1, setInterval: () => 1 };
    vm.createContext(ctx);
    vm.runInContext(read('docs/pro/js/storm-strip.js'), ctx);
    const S = win.NBDStormStrip;
    const fh = S._stripHtml(fail, false);
    ok('failed: "Storm feed unavailable. This is not an all-clear."', /Storm feed unavailable\.<\/strong> This is not an all-clear\./.test(fh), fh);
    ok('clear and loading paint nothing', S._stripHtml(SS.summarize([], [], NOW), false) === '' && S._stripHtml(SS.summarize(undefined, [], NOW), false) === '');
    const hailAndFail = S._stripHtml(SS.summarize(null, [{ id: 'a', hailHit: { sizeInches: 1, at: Date.now() - H } }], Date.now()), false);
    ok('failed + known hail: says both', /Storm feed unavailable/.test(hailAndFail) && /Hail up to 1&quot; reported near 1 customer/.test(hailAndFail));
    const wh = S._stripHtml(SS.summarize([{ event: '<b>x</b>', leadIds: ['a'] }], [], Date.now()), false);
    ok('names from the feed are escaped', !/<b>x/.test(wh) && /&lt;b&gt;x/.test(wh));
    ok('no layout engine: no Mission button (offered only when it can open)', !/data-ss="mission"/.test(wh));
    const base = { has: true, surfaces: ['phone', 'tablet', 'desktop'], surface: 'phone', company: {}, current: 'classic' };
    ok('Mission is offered when allowed on this screen', SS.missionOk(base) === true);
    ok('…not when locked, not allowed, unsupported, or already showing', !SS.missionOk(Object.assign({}, base, { company: { locked: true } })) && !SS.missionOk(Object.assign({}, base, { company: { allowed: ['classic'] } })) && !SS.missionOk(Object.assign({}, base, { surfaces: ['desktop'] })) && !SS.missionOk(Object.assign({}, base, { current: 'mission' })));
    const js = read('docs/pro/js/storm-strip.js');
    ok('the tap is a session switch like Storm Mode\'s (source "storm"), never saved', /LayoutEngine\.apply\('mission', \{ source: 'storm' \}\)/.test(js) && !/saveUser/.test(js));
    ok('the read is Storm Mode\'s own (observeWarnings), loaded the way Mission Control loads it', /SM\.observeWarnings\(\)/.test(js) && /ScriptLoader\.load\('\/pro\/js\/storm-mode\.js\?v=1'\)/.test(js) && /\/pro\/js\/storm-mode\.js\?v=1/.test(read('docs/pro/js/layouts/mission.js')));
    ok('a read that throws or resolves nothing is a failure, not a clear', /warnings = Array\.isArray\(list\) \? list : null; \}, function \(\) \{ warnings = null; \}/.test(js));
  }

  console.log('\nC. the app badge');
  {
    ok('the badge is the Needs-you strip\'s count', HA.badgeCount({ calls: 2, stripe: 1, signs: 1, oldPromises: 1, reviews: 2 }) === 7);
    ok('nothing needs you: 0 (the badge is cleared)', HA.badgeCount({ calls: 0, stripe: 0, signs: 0, reviews: 0 }) === 0);
    ok('still checking, or any read failed: null (the badge is left alone, never a false 0)', HA.badgeCount({ pending: true, calls: 0 }) === null && HA.badgeCount({ callsFailed: true, calls: 4 }) === null && HA.badgeCount({ stripeFailed: true }) === null && HA.badgeCount({ oldFailed: true }) === null);
    ok('capped at 999', HA.badgeCount({ calls: 5000 }) === 999);
    const src = read('docs/pro/js/home-attention.js');
    ok('set on a count, cleared at 0, a no-op where unsupported, and a refusal is swallowed', /typeof nav\.setAppBadge === 'function' \? nav\.setAppBadge\(n\)/.test(src) && /typeof nav\.clearAppBadge === 'function' \? nav\.clearAppBadge\(\)/.test(src) && /if \(n === null \|\| !nav\) return;/.test(src) && /p\.catch\(/.test(src));
    ok('it follows the strip: after every paint and after a label change', (src.match(/setBadge\((counts|api\.lastCounts)\);/g) || []).length === 2);
  }

  console.log('\nD. wiring');
  {
    const dash = read('docs/pro/dashboard.html');
    ok('#homeStorm sits at the top of Home, above Next stop', dash.indexOf('id="homeStorm"') > 0 && dash.indexOf('id="homeStorm"') < dash.indexOf('id="homeNextStop"'));
    const field = read('docs/pro/js/layouts/field.js');
    ok('Field: the strip replaces the old cached storm line', /data-storm-slot="field" data-storm-variant="compact"/.test(field) && !/function stormLine\(/.test(field) && !/fa-storm/.test(field));
    ok('lazy bundle "stormstrip" (?v=), kicked by today-home.js', /stormstrip: \[\s*'css\/storm-strip\.css\?v=\d+',\s*'js\/storm-strip\.js\?v=\d+'\s*\]/.test(read('docs/pro/js/script-loader.js')) && /loadBundle\('stormstrip'\)/.test(read('docs/pro/js/today-home.js')));
    ok('home-attention.js was cache-busted for the badge', /home-attention\.js\?v=25/.test(dash));
    const CP = require(path.join(ROOT, 'docs/pro/js/card-prefs.js'));
    ok('Customize knows the Storm card (Home and Field)', CP.idsOf('classic')[0] === 'storm' && CP.idsOf('field')[0] === 'storm');
    const js = read('docs/pro/js/storm-strip.js'), css = read('docs/pro/css/storm-strip.css');
    ok('CSP: no inline handlers or style attributes; 44px button; tokens only', !/\son[a-z]+=/i.test(js) && !/style=/.test(js) && /\.ss-btn\{[^}]*min-height:44px/.test(css) && !/#[0-9a-f]{3,6}\b/i.test(css));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
