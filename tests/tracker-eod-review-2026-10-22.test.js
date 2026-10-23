/**
 * tests/tracker-eod-review-2026-10-22.test.js
 *
 * Daily Success: the 60-second end-of-day review (eod-logic.js, eod-ui.js).
 * Three optional answers per date; skippable; feeds the weekly review.
 * Clock-dependent checks fake Date (the prompt hour) - never the real clock.
 *
 * Run: node tests/tracker-eod-review-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const E = require(path.join(DS, 'js', 'eod-logic.js'));
const R = require(path.join(DS, 'js', 'review-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; }
}
const read = (...p) => fs.readFileSync(path.join(DS, ...p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/^\/\*[\s\S]*?\*\//, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n1. answers: cleaned, capped, optional');
{
  const n = E.normalize({ body: 2, win: '  Booked   the\nroof tour ', tomorrow: 'Call Dan' });
  ok('whitespace and newlines collapse', n.win === 'Booked the roof tour' && n.body === 2 && n.tomorrow === 'Call Dan');
  ok('length is capped at 140', E.normalize({ win: 'x'.repeat(500) }).win.length === E.MAX && E.MAX === 140);
  ok('one answer alone is enough', E.normalize({ tomorrow: 'Lift' }).tomorrow === 'Lift');
  ok('nothing answered is nothing (negative control)', E.normalize({ body: 0, win: ' ', tomorrow: '' }) === null && E.normalize(null) === null);
  ok('a body score outside 1-3 is dropped', E.normalize({ body: 7, win: 'a' }).body === 0 && E.normalize({ body: -1, win: 'a' }).body === 0);
  ok('control characters are stripped', E.normalize({ win: 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(7) + 'c' }).win === 'a b c');
}

console.log('\n2. save and skip');
{
  const m = E.save({}, '2026-10-20', { body: 3, win: 'Signed Smith' }, 111);
  ok('save stores the note under its date with a stamp', m['2026-10-20'].win === 'Signed Smith' && m['2026-10-20'].at === 111);
  ok('save does not mutate the old map', (() => { const old = {}; E.save(old, '2026-10-20', { win: 'x' }, 1); return Object.keys(old).length === 0; })());
  ok('an empty save leaves the day as it was (negative control)', JSON.stringify(E.save(m, '2026-10-20', { win: '' }, 2)) === JSON.stringify(m));
  ok('a bad date key is refused', Object.keys(E.save({}, 'tonight', { win: 'x' }, 1)).length === 0);
  const s = E.skip({}, '2026-10-21', 5);
  ok('skip is remembered as a record', s['2026-10-21'].skipped === true);
  ok('skip never overwrites real answers (negative control)', E.skip(m, '2026-10-20', 9)['2026-10-20'].win === 'Signed Smith');
  ok('answering after a skip replaces the skip', E.isAnswered(E.save(s, '2026-10-21', { win: 'late' }, 6)['2026-10-21']));
  let big = {};
  for (let i = 0; i < 150; i++) big = E.save(big, E.addDays('2026-01-01', i), { win: 'w' + i }, i);
  ok('only the last 120 days are kept', Object.keys(big).length === 120 && big[E.addDays('2026-01-01', 149)] && !big['2026-01-01']);
}

console.log('\n3. when the prompt shows (never nags)');
{
  const t = '2026-10-22';
  ok('today at 8 pm, nothing yet: prompt', E.state({}, t, t, 20) === 'prompt');
  ok('today at 4 pm: only a quiet link (negative control)', E.state({}, t, t, 16) === 'link');
  ok('exactly 5 pm prompts, 4 pm does not', E.state({}, t, t, 17) === 'prompt' && E.state({}, t, t, 16) === 'link');
  ok('a skipped day never prompts again, even late', E.state({ [t]: { skipped: true } }, t, t, 23) === 'skipped');
  ok('a past day with no note is a link, never a prompt', E.state({}, '2026-10-21', t, 23) === 'link');
  ok('an answered day shows the note', E.state({ [t]: { win: 'x' } }, t, t, 23) === 'saved');
}

console.log('\n4. weekly review feed');
{
  const today = '2026-10-25';
  let map = E.save({}, '2026-10-19', { body: 2, win: 'Quote sent' }, 1);
  map = E.save(map, '2026-10-21', { body: 3, win: 'Closed Jones' }, 1);
  map = E.save(map, '2026-10-25', { body: 1, win: 'today is not in the window' }, 1);
  map = E.save(map, '2026-10-10', { body: 1, win: 'too old' }, 1);
  map = E.skip(map, '2026-10-22', 1);
  const sum = E.weekSummary(map, today);
  ok('counts only answered days inside the 7 finished days', sum.days === 2 && sum.wins.length === 2);
  ok('body average over answered days', sum.bodyAvg === 2.5);
  ok('today, older days and skips are excluded (negative controls)', !sum.wins.some((w) => /today|old/.test(w.text)));
  ok('no notes: empty summary and no scorecard lines', E.weekSummary({}, today).days === 0 && E.scorecardLines(E.weekSummary({}, today)).length === 0);
  const card = R.scorecardText({ from: '2026-10-18', to: '2026-10-24', eodLines: E.scorecardLines(sum) });
  ok('the weekly scorecard carries the wrap-ups', /Day wrap-ups: 2\/7 · body avg 2.5\/3/.test(card) && /Win 10-21: Closed Jones/.test(card));
  ok('the scorecard is unchanged without them', R.scorecardText({ from: 'a', to: 'b' }) === 'WEEKLY SCORECARD a → b');
}

console.log('\n5. card rendering (vm, faked clock)');
{
  function run(hour, stored) {
    const store = Object.assign({}, stored || {});
    const FakeDate = class extends Date { getHours() { return hour; } };
    const win = { todayKey: () => '2026-10-22', toast() {}, dsSettingsChanged() {} };
    const ctx = {
      window: win, Date: FakeDate, console, pages: [{ dk: '2026-10-22' }], cur: 0,
      document: { readyState: 'complete', addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; } },
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(DS, 'js', 'eod-logic.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(DS, 'js', 'eod-ui.js'), 'utf8'), ctx);
    return win.NBDEodUI.cardHtml('2026-10-22');
  }
  ok('evening: the questions are inline with a Not tonight button', /id="eodWin"/.test(run(20)) && /Not tonight/.test(run(20)));
  ok('afternoon: a single quiet link, no form (negative control)', !/id="eodWin"/.test(run(14)) && /Wrap up the day/.test(run(14)));
  const hostile = JSON.stringify({ '2026-10-22': { body: 2, win: '<img src=x onerror=alert(1)>', tomorrow: '"><script>x</script>', at: 1 } });
  const saved = run(20, { nbd_ds_eod: hostile });
  ok('saved text is shown escaped', !/<img|<script/.test(saved) && /&lt;img/.test(saved) && /Okay/.test(saved));
  ok('a skipped day offers only the add-anyway link', /Add a day wrap-up anyway/.test(run(22, { nbd_ds_eod: JSON.stringify({ '2026-10-22': { skipped: true } }) })) && !/id="eodWin"/.test(run(22, { nbd_ds_eod: JSON.stringify({ '2026-10-22': { skipped: true } }) })));
  ok('corrupt storage does not throw', /Day wrap-up/.test(run(20, { nbd_ds_eod: '{not json' })));
}

console.log('\n6. wiring and house rules');
{
  const ui = stripComments(read('js', 'eod-ui.js'));
  const lg = stripComments(read('js', 'eod-logic.js'));
  const idx = read('index.html');
  ok('no inline handlers or inline scripts in the new files', !/\son[a-z]+=/i.test(ui) && !/<script/i.test(ui));
  ok('never assigns document.body.className', !/body\.className\s*=/.test(ui));
  ok('no network or storage in the pure logic', !/fetch\(|localStorage|XMLHttpRequest/.test(lg));
  ok('every stored value is escaped before innerHTML', /esc\(rec\.win\)/.test(ui) && /esc\(rec\.tomorrow\)/.test(ui) && /esc\(r\.win/.test(ui));
  ok('eod scripts load with defer, and the stylesheet is linked', /eod-logic\.js\?v=\d+" defer/.test(idx) && /eod-ui\.js\?v=\d+" defer/.test(idx) && /css\/eod\.css/.test(idx));
  ok('the note rides the existing settings sync', /\{ key: 'nbd_ds_eod',\s+field: 'dsEod' \}/.test(read('ds-firebase-sync.js')));
  const styles = idx.match(/<style[\s\S]*?<\/style>/g);
  ok('phone rules sit in the LAST style block', /\.eod-chip\{/.test(styles[styles.length - 1]) && !styles.slice(0, -1).some((b) => /\.eod-chip\{/.test(b)));
  ok('the weekly review uses the summary', /eodLines\(\)/.test(read('js', 'review-ui.js')) && /r\.eodLines/.test(read('js', 'review-logic.js')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
