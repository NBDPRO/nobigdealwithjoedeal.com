/**
 * tests/tracker-adaptive-calories-2026-10-20.test.js
 *
 * Tracker idea #7: the adaptive maintenance-calories estimate
 * (docs/pro/daily-success/js/adaptive-calories-logic.js + -ui.js). Synthetic
 * data against the REAL logic, the real weightSeries and the real totals().
 *
 * Run: node tests/tracker-adaptive-calories-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const A = require(path.join(DS, 'js', 'adaptive-calories-logic.js'));
const F = require(path.join(DS, 'js', 'food-log-logic.js'));
const H = require(path.join(DS, 'js', 'tracker-history-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}

const TODAY = '2026-10-20';                 // window = 2026-09-29 .. 2026-10-19
const WSTART = A.addDays(TODAY, -21);
const range = (n) => Array.from({ length: n }, (_, i) => A.addDays(WSTART, i));   // the 21 window days
const DAYS = range(21);

/** Weigh-in every day on a straight line: lbPerWeek slope from 180 lb at the window start. */
function line(lbPerWeek, every) {
  return DAYS.filter((_, i) => i % (every || 1) === 0).map((dk, _i) => ({ dk, lbs: Math.round((180 + lbPerWeek / 7 * A.diffDays(WSTART, dk)) * 100) / 100 }));
}
const eat = (cal, days) => (days || DAYS).map((dk) => ({ dk, cal }));
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 15 : tol);

console.log('\n1. known scenarios');
{
  const flat = A.estimate(eat(2500), line(0), TODAY);
  ok('eats 2,500, weight flat -> maintenance about 2,500', flat.ok && near(flat.maintenance, 2500), JSON.stringify(flat));
  const cut = A.estimate(eat(2000), line(-1), TODAY);
  ok('eats 2,000 and loses 1 lb/week -> about 2,500', cut.ok && near(cut.maintenance, 2500), JSON.stringify(cut));
  const bulk = A.estimate(eat(3000), line(1), TODAY);
  ok('eats 3,000 and gains 1 lb/week -> about 2,500', bulk.ok && near(bulk.maintenance, 2500), JSON.stringify(bulk));
  ok('the weekly pace it reports matches the weight line', cut.ok && near(cut.ratePerWeek, -1, 0.15) && bulk.ok && near(bulk.ratePerWeek, 1, 0.15), cut.ratePerWeek + ' / ' + bulk.ratePerWeek);
  ok('reports how many days of food it used', cut.ok && cut.foodDays === 21 && cut.partialDays === 0 && cut.windowEnd === '2026-10-19', JSON.stringify(cut));
  const rec = cut.recent;
  ok('last week vs maintenance: 2,000 eaten against ~2,500 is about 1 lb/week down', rec && rec.days === 7 && near(rec.lbPerWeek, -1, 0.15) && A.paceWords(rec.lbPerWeek) === 'about 1.0 lb/week down', JSON.stringify(rec));
  const noisy = line(0).map((w, i) => Object.assign({}, w, { lbs: w.lbs + (i % 2 ? 1.2 : -1.2) }));
  const nz = A.estimate(eat(2500), noisy, TODAY);
  ok('day-to-day scale noise (+-1.2 lb) barely moves it (the 7-day averages smooth it)', nz.ok && near(nz.maintenance, 2500, 120), JSON.stringify(nz));
  ok('today\'s partly typed food is not in the window', A.estimate(eat(2500).concat([{ dk: TODAY, cal: 300 }]), line(0), TODAY).foodDays === 21);
}

console.log('\n2. not enough data names the missing input');
{
  const w = line(0);
  const few = A.estimate(eat(2500, DAYS.slice(0, 10)), w, TODAY);
  ok('10 logged days -> not enough, says need 4 more days of food', !few.ok && few.code === 'food' && /Not enough data yet/.test(few.message) && /need 4 more days of food/.test(few.message) && few.maintenance === undefined, few.message);
  const none = A.estimate([], w, TODAY);
  ok('no food at all -> not enough, need 14', !none.ok && /need 14 more days of food/.test(none.message));
  const noW = A.estimate(eat(2500), [], TODAY);
  ok('no weigh-ins -> not enough, names the weight box', !noW.ok && noW.code === 'weight' && /weigh-ins/.test(noW.message) && /Body Metrics/.test(noW.message), noW.message);
  const onlyStart = A.estimate(eat(2500), line(0).filter((x) => x.dk <= A.addDays(WSTART, 6)), TODAY);
  ok('weigh-ins only in the first week -> asks for the last week', !onlyStart.ok && /need 2 more weigh-ins from 2026-10-13 to 2026-10-19/.test(onlyStart.message), onlyStart.message);
  const oneEach = A.estimate(eat(2500), [line(0)[0], line(0)[20]], TODAY);
  ok('one weigh-in at each end is still not enough', !oneEach.ok && /need 1 more weigh-in /.test(oneEach.message), oneEach.message);
  const tight = A.estimate(eat(2500), line(0).filter((x) => { const i = A.diffDays(WSTART, x.dk); return i === 5 || i === 6 || i === 14 || i === 15; }), TODAY);
  ok('weigh-ins that span under 14 days -> not enough, says so', !tight.ok && /span 10 days/.test(tight.message) && /need 14/.test(tight.message), tight.message);
  const both = A.estimate(eat(2500, DAYS.slice(0, 5)), [], TODAY);
  ok('both missing -> one message names food AND weigh-ins', !both.ok && /food/.test(both.message) && /weigh-ins/.test(both.message) && both.missing.length >= 2, both.message);
  ok('positive control: the same food + weights with enough of both IS ok', A.estimate(eat(2500, DAYS.slice(0, 14)), w, TODAY).ok);
  ok('boundary: exactly 14 food days is ok, 13 is not', A.estimate(eat(2500, DAYS.slice(0, 14)), w, TODAY).ok && !A.estimate(eat(2500, DAYS.slice(0, 13)), w, TODAY).ok);
  ok('days outside the 21-day window do not count', !A.estimate(eat(2500, [A.addDays(WSTART, -3), A.addDays(WSTART, -2)].concat(DAYS.slice(0, 11))), w, TODAY).ok);
}

console.log('\n3. blank, partial and typo days');
{
  const w = line(0);
  const mixed = eat(2500, DAYS.slice(0, 16)).concat(eat(0, DAYS.slice(16, 19))).concat([{ dk: DAYS[19], cal: '' }, { dk: DAYS[20], cal: null }]);
  const m = A.estimate(mixed, w, TODAY);
  ok('zero / blank / null days are excluded (16 days used, average still 2,500)', m.ok && m.foodDays === 16 && m.avgIntake === 2500, JSON.stringify(m));
  const partial = A.estimate(eat(2500, DAYS.slice(0, 15)).concat(eat(350, DAYS.slice(15, 21))), w, TODAY);
  ok('6 days of 350 cal (only some meals) are left out, not averaged in, and counted', partial.ok && partial.foodDays === 15 && partial.partialDays === 6 && partial.avgIntake === 2500, JSON.stringify(partial));
  const mostly = A.estimate(eat(2500, DAYS.slice(0, 8)).concat(eat(500, DAYS.slice(8, 21))), w, TODAY);
  ok('mostly under 800 -> not enough data, and says why', !mostly.ok && mostly.code === 'partial-food' && /under 800 cal looked like only some meals/.test(mostly.message), mostly.message);
  const typo = A.estimate(eat(2500, DAYS.slice(0, 14)).concat(eat(25000, DAYS.slice(14, 16))), w, TODAY);
  ok('a 25,000 cal typo day is dropped', typo.ok && typo.foodDays === 14 && typo.typoDays === 2 && typo.avgIntake === 2500, JSON.stringify(typo));
  const lie = A.estimate(eat(1200), line(1), TODAY);
  ok('numbers that imply an impossible maintenance are refused, not shown', !lie.ok && lie.code === 'implausible' && /believable/.test(lie.message), lie.message);
}

console.log('\n4. weights: typos ignored the way weightSeries does');
{
  const pages = DAYS.map((dk, i) => ({ dk, data: { 'bm-wt': String(180) } }));
  pages[3].data['bm-wt'] = '2150';          // fat-fingered scale reading
  pages[17].data['bm-wt'] = '18';           // and a missing digit
  const series = H.weightSeries(pages);
  ok('weightSeries drops both typos', series.length === 19 && !series.some((s) => s.lbs > 700 || s.lbs < 60), String(series.length));
  const r = A.estimate(eat(2500), series, TODAY);
  ok('estimate over the cleaned series is unaffected by them (flat 180 -> 2,500)', r.ok && r.maintenance === 2500, JSON.stringify(r));
  const raw = A.estimate(eat(2500), line(0).map((x, i) => (i === 3 ? { dk: x.dk, lbs: 2150 } : x)), TODAY);
  ok('even if a typo reaches estimate() directly it is ignored', raw.ok && raw.maintenance === 2500, JSON.stringify(raw));
}

console.log('\n5. intakeSeries reads day pages through the real totals()');
{
  const pages = [
    { dk: '2026-10-01', data: { 'diet-m0-cal': '500', 'diet-m1-cal': '700', 'diet-m2-cal': '900', 'diet-m3-cal': '' } },
    { dk: '2026-10-02', data: { 'diet-m0-name': 'Eggs', 'diet-m0-p': '30', 'diet-m0-cal': '' } },     // macros but no calories
    { dk: '2026-10-03', data: {} },
    { dk: '2026-10-04', data: { 'diet-m0-cal': '1800' } },
    { dk: '2026-10-04', data: { 'diet-m0-cal': '2000' } },     // second page, same day: the last wins
    { dk: 'bad', data: { 'diet-m0-cal': '9' } },
    null,
  ];
  const s = A.intakeSeries(pages, F.totals);
  ok('sums the meal rows; skips days with no calories typed (no calories are made up from macros)',
    JSON.stringify(s) === JSON.stringify([{ dk: '2026-10-01', cal: 2100 }, { dk: '2026-10-04', cal: 2000 }]), JSON.stringify(s));
  ok('end to end: pages -> intakeSeries + weightSeries -> estimate',
    (() => {
      const pg = DAYS.map((dk, i) => ({ dk, data: { 'diet-m0-cal': '1000', 'diet-m1-cal': '1000', 'bm-wt': String(Math.round((180 - i / 7) * 10) / 10) } }));
      const r = A.estimate(A.intakeSeries(pg, F.totals), H.weightSeries(pg), TODAY);
      return r.ok && near(r.maintenance, 2500, 40);
    })());
}

console.log('\n6. never NaN / Infinity / undefined text');
{
  const bad = [
    A.estimate(null, null, TODAY), A.estimate(undefined, undefined, undefined), A.estimate([{ dk: 'x', cal: 'abc' }], [{ dk: TODAY, lbs: NaN }], 'nope'),
    A.estimate(eat('abc'), line(0).map((x) => ({ dk: x.dk, lbs: 'heavy' })), TODAY),
    A.estimate(eat(2500), line(0).map((x) => ({ dk: x.dk, lbs: Infinity })), TODAY),
    A.estimate(eat(Infinity), line(0), TODAY),
    A.estimate([{ dk: DAYS[0], cal: -500 }], line(0), TODAY),
  ];
  ok('garbage in never crashes and is always a clean not-enough state', bad.every((r) => r && r.ok === false && typeof r.message === 'string' && r.message.indexOf('Not enough data yet') === 0));
  const all = JSON.stringify([bad, A.estimate(eat(2500), line(0), TODAY), A.estimate(eat(2000), line(-1), TODAY)]);
  ok('no NaN, Infinity or undefined in any result', !/NaN|Infinity|undefined/.test(all) && !/null,"message"/.test(all));
  ok('paceWords handles the edges', A.paceWords(0) === 'about even (no real change)' && A.paceWords(0.04) === 'about even (no real change)' && A.paceWords(0.5) === 'about 0.5 lb/week up' && A.paceWords(NaN) === '' && A.paceWords(null) === '');
  ok('month and year boundaries use calendar math', A.addDays('2026-10-01', -1) === '2026-09-30' && A.addDays('2026-01-01', -1) === '2025-12-31' && A.diffDays('2026-03-01', '2026-03-31') === 30 && A.diffDays('2026-03-07', '2026-03-09') === 2);
}

console.log('\n7. the screen (static checks)');
{
  const ui = fs.readFileSync(path.join(DS, 'js', 'adaptive-calories-ui.js'), 'utf8');
  const html = fs.readFileSync(path.join(DS, 'index.html'), 'utf8');
  ok('loaded as deferred external scripts, logic before ui', /adaptive-calories-logic\.js\?v=\d+" defer><\/script>/.test(html) && /adaptive-calories-ui\.js\?v=\d+" defer><\/script>/.test(html) && html.indexOf('adaptive-calories-logic.js') < html.indexOf('adaptive-calories-ui.js'));
  ok('loaded after food-log.js (it hooks the diet section)', html.indexOf('food-log.js') < html.indexOf('adaptive-calories-logic.js'));
  ok('no inline handlers or new Date(\'YYYY-MM-DD\') strings', !/\son[a-z]+\s*=\s*["']/.test(ui) && !/new Date\(\s*['"`]\d{4}-/.test(ui));
  ok('has the formula disclosure and the not-medical-advice note', /How is this worked out\?/.test(ui) && /not medical advice/i.test(ui) && /3,500/.test(ui));
  ok('the target button only writes on a tap (delegated action) and only when no calorie target is set',
    /data-ac-action="use-target"/.test(ui) && /nbd_ds_food/.test(ui) && /dsSettingsChanged/.test(ui) && /!hasTarget \?|\(!hasTarget/.test(ui));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
