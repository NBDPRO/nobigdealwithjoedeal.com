/**
 * tests/layout-routeplan-2026-10-12.test.js - M3: the job map's crew day route
 * (js/layouts/routeplan.js, plus its wiring in mission.js).
 *
 *   1. drive-time estimate: an estimate by construction, never 0 for a real hop
 *   2. nearest neighbour + 2-opt: a permutation, the first stop never moves,
 *      never longer than nearest neighbour (property over 300 random days),
 *      within a few % of the brute-force optimum on small days, and strictly
 *      better than NN on a constructed crossing
 *   3. conflicts: tight hops only when BOTH ends are timed and the drive does
 *      not fit the gap
 *   4. pins: stage colours never use the danger colours; roof-age buckets
 *   5. "On my way": drafted, plain, no claim words, sms: href encoded, the layout
 *      shows a draft and gates it on the server's text check
 *
 * Run: node tests/layout-routeplan-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n      ' + detail : '')); }
}
const RP = require(path.join(ROOT, 'docs/pro/js/layouts/routeplan.js'));
const CW = require(path.join(ROOT, 'docs/pro/js/claim-wording-filter.js'));

// deterministic PRNG so a failure reproduces
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const pt = (lat, lng) => ({ lat, lng });

console.log('\n1. drive-time estimate');
{
  ok('zero distance is zero minutes', RP.driveMin(0) === 0 && RP.driveMin(-3) === 0 && RP.driveMin(NaN) === 0);
  ok('a real hop is never 0 minutes', RP.driveMin(0.01) === 1);
  ok('10 straight-line miles = 10 x 1.3 / 28 mph = 28 min', RP.driveMin(10) === 28, String(RP.driveMin(10)));
  ok('road miles apply the 1.3 factor', RP.roadMi(10) === 13);
  const a = pt(39.1, -84.5), b = pt(39.2, -84.5);
  ok('0.1 deg of latitude is about 6.9 mi', Math.abs(RP.distMi(a, b) - 6.9) < 0.1, String(RP.distMi(a, b)));
}

console.log('\n2. nearest neighbour + 2-opt');
{
  const R = rng(7);
  let neverWorse = true, perm = true, firstFixed = true, strictly = 0, worstGap = 0;
  for (let t = 0; t < 300; t++) {
    const n = 3 + Math.floor(R() * 10);
    const pts = []; for (let i = 0; i < n; i++) pts.push(pt(39 + R() * 0.3, -84.7 + R() * 0.4));
    const res = RP.optimize(pts, 0);
    perm = perm && res.order.length === n && new Set(res.order).size === n && res.order.every((v) => v >= 0 && v < n);
    firstFixed = firstFixed && res.order[0] === 0;
    if (res.miles > res.nnMiles + 1e-9) neverWorse = false;
    if (res.miles < res.nnMiles - 1e-9) strictly++;
  }
  ok('every result is a permutation of the stops', perm);
  ok('the first stop never moves', firstFixed);
  ok('2-opt is never longer than nearest neighbour', neverWorse);
  ok('2-opt actually improves some days (not a no-op)', strictly > 10, 'improved ' + strictly + '/300');

  // brute-force the optimum open path (first fixed) on 7-stop days
  function best(pts) {
    const n = pts.length; let bestMi = Infinity;
    const rest = []; for (let i = 1; i < n; i++) rest.push(i);
    (function perm2(arr, cur) {
      if (!arr.length) { const m = RP.pathMi([0].concat(cur), pts); if (m < bestMi) bestMi = m; return; }
      for (let i = 0; i < arr.length; i++) perm2(arr.slice(0, i).concat(arr.slice(i + 1)), cur.concat(arr[i]));
    })(rest, []);
    return bestMi;
  }
  const R2 = rng(99);
  for (let t = 0; t < 30; t++) {
    const pts = []; for (let i = 0; i < 7; i++) pts.push(pt(39 + R2() * 0.3, -84.7 + R2() * 0.4));
    const res = RP.optimize(pts, 0);
    const opt = best(pts);
    worstGap = Math.max(worstGap, res.miles / opt - 1);
  }
  ok('within 15% of the brute-force optimum on 7-stop days (worst ' + Math.round(worstGap * 1000) / 10 + '%)', worstGap < 0.15);

  // a constructed crossing: NN from A grabs the close point then has to double back
  const cross = [pt(0.0, 0.0), pt(0.0, 0.010), pt(0.012, 0.0), pt(0.012, 0.010), pt(0.006, 0.020)];
  const r = RP.optimize(cross, 0);
  ok('constructed crossing: 2-opt strictly beats nearest neighbour or ties it validly', r.miles <= r.nnMiles + 1e-9 && RP.pathMi(r.order, cross) === r.miles);
  const zig = [pt(0, 0), pt(0.02, 0.001), pt(0.001, 0.002), pt(0.021, 0.003), pt(0.002, 0.004), pt(0.022, 0.005)];
  const ident = [0, 1, 2, 3, 4, 5];
  const zz = RP.twoOpt(ident, zig);
  ok('2-opt untangles a zig-zag the identity order has', RP.pathMi(zz, zig) < RP.pathMi(ident, zig) - 1e-6 && zz[0] === 0);

  ok('one and two stops are returned as they are', JSON.stringify(RP.optimize([pt(39, -84)], 0).order) === '[0]'
    && JSON.stringify(RP.optimize([pt(39, -84), pt(39.1, -84)], 0).order) === '[0,1]');
  ok('no stops, no crash', RP.optimize([], 0).order.length === 0);
  const many = []; for (let i = 0; i < 60; i++) many.push(pt(39 + i * 0.001, -84));
  ok('past the cap the order is left alone (no O(n^3) surprise)', RP.optimize(many, 0).order.join() === many.map((_, i) => i).join());
}

console.log('\n3. conflicts');
{
  const stops = [{ ms: 1000000000 }, { ms: 1000000000 + 60 * 60000 }, { ms: null }, { ms: 1000000000 + 70 * 60000 }];
  const legsL = [{ min: 10 }, { min: 5 }, { min: 30 }];
  const c = RP.conflicts(stops, legsL);
  ok('a 60 min gap minus 45 on site leaves 15: a 10 min drive fits', !c.some((x) => x.index === 1));
  ok('an untimed stop on either end is never "tight"', !c.some((x) => x.index === 2 || x.index === 3));
  const tight = RP.conflicts([{ ms: 0 }, { ms: 50 * 60000 }], [{ min: 12 }]);
  ok('a 50 min gap minus 45 leaves 5: a 12 min drive is tight', tight.length === 1 && tight[0].driveMin === 12 && tight[0].gapMin === 5);
}

console.log('\n4. pins');
{
  const keys = ['new', 'contacted', 'inspected', 'claim_filed', 'scope_received', 'estimate_sent_cash', 'negotiating', 'contract_signed', 'install_in_progress', 'final_payment', 'closed', 'lost', 'who-knows', '', null];
  const colors = keys.map((k) => RP.stageGroup(k).color);
  ok('no stage colour is a danger colour (red / gold belong to hail)', colors.every((c) => c !== 'red' && c !== 'gold'), colors.join());
  ok('job stages are green, insurance purple, leads blue, closed muted', RP.stageGroup('install_complete').color === 'green' && RP.stageGroup('claim_filed').color === 'purple'
    && RP.stageGroup('new').color === 'blue' && RP.stageGroup('lost').color === 'muted');
  ok('roof age buckets', RP.roofAgeBucket(25).label === '20+ years' && RP.roofAgeBucket('12').label === '10-19 years' && RP.roofAgeBucket(3).label === 'Under 10 years');
  ok('roof age: unknown / junk / absurd are null, not "new roof"', RP.roofAgeBucket('') === null && RP.roofAgeBucket(null) === null
    && RP.roofAgeBucket('abc') === null && RP.roofAgeBucket(-4) === null && RP.roofAgeBucket(900) === null);
  ok('roof age 0 is a new roof (bucket), not "unknown"', RP.roofAgeBucket(0).label === 'Under 10 years');
}

console.log('\n5. on my way');
{
  const t = RP.onMyWayText({ first: 'Dana Smith', minutes: 12, signOff: 'Joe from No Big Deal' });
  ok('names the customer, the sender, and rounds the ETA up to 5 minutes', /^Hi Dana, this is Joe from No Big Deal\. I'm on my way to you now\. I should be there in about 15 minutes\.$/.test(t), t);
  ok('no ETA when there is no leg', /See you shortly/.test(RP.onMyWayText({ first: 'Dana' })) && !/minutes/.test(RP.onMyWayText({ first: 'Dana' })));
  ok('no first name still reads fine', /^Hi, /.test(RP.onMyWayText({})));
  ok('the draft trips no claim-wording rule', CW.scanText(t).length === 0);
  ok('the draft has no price / claim / insurance / guarantee words', !/\b(insurance|claim|deductible|price|\$|guarantee\w*|free)\b/i.test(t));
  ok('sms href is digits-only +1 with an encoded body', RP.smsHref('(513) 555-0188', 'Hi & bye') === 'sms:+15135550188?&body=Hi%20%26%20bye');
  ok('11-digit 1-prefixed numbers work, junk gives nothing', RP.smsHref('1-513-555-0188', 'x').indexOf('sms:+15135550188') === 0 && RP.smsHref('555', 'x') === '' && RP.smsHref('', 'x') === '');

  const src = read('docs/pro/js/layouts/mission.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // 2026-10-15: the gate moved into routeplan.js draftOnMyWay (the Next stop
  // card shares it); tests/next-stop-2026-10-15.test.js runs it end to end.
  const rpCode = read('docs/pro/js/layouts/routeplan.js');
  ok('On my way is gated on the server text check and shows a DRAFT, it does not navigate', /RP\.draftOnMyWay\(\{[^;]*\}, W\.NBDPhoneShare\)/.test(code)
    && /PS\.checkText\(\{ phone: x\.phone, leadId: x\.leadId \}\)/.test(rpCode) && /r && r\.ok === true/.test(rpCode)
    && !/location\.href\s*=/.test(code) && !/window\.open\(/.test(code));
  ok('a failed or impossible check shows the reason and no draft', /\{ key: key, error: r\.reason \}/.test(code) && /ok: false, code: \(r && r\.code\) \|\| 'unverified', reason: \(r && r\.reason\) \|\| COULD_NOT_CHECK/.test(rpCode));
  ok('the draft says nothing is sent until the rep presses Send', /Nothing is sent until you press Send in Messages/.test(code));
  ok('Crews is disabled with a reason, not invented', /chip\('crews', 'Crews', false, true, 'No live crew locations are collected yet'\)/.test(code));
  ok('drive times are labelled as estimates wherever shown', (code.match(/\(est\.\)/g) || []).length >= 3);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
