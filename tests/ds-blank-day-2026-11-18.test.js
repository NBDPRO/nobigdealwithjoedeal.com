/**
 * tests/ds-blank-day-2026-11-18.test.js
 *
 * The "yesterday is blank" banner on the Daily Success Dash (Joe, 2026-11-18, the Q1-Q4 answers) and the "Days logged this week" line.
 * Pure rules in js/blankday-logic.js:
 *   - a day is BLANK when none of the floors were met on it (pages of the same date merge) and no workout was finished that date;
 *   - the banner is about yesterday only, never when yesterday was a Sunday (Sunday is not a required day), never on a tracker with no
 *     earlier logged day (a new install is not nagged), never for the rest of the day after "Not now", never with no floors configured;
 *   - "days logged" counts the last seven days ending today: the exact complement of blank.
 *
 * Run: node tests/ds-blank-day-2026-11-18.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const SRC = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
let L;
try { L = require(path.join(SRC, 'js', 'blankday-logic.js')); } catch (e) { L = null; console.log('  ✗ blankday-logic.js loads — ' + e.message); failed++; }

const floors = [{ id: 'sleep' }, { id: 'train' }, { id: 'task' }];
const page = (dk, met) => ({ dk, suf: 1, data: Object.fromEntries((met || []).map((id) => ['floormet-' + id, '1'])) });
const none = () => false;
const trained = (...dks) => (dk) => dks.indexOf(dk) >= 0;

// 2026-11-18 is a Wednesday: yesterday is Tue the 17th. 2026-11-23 is a Monday: yesterday is Sunday the 22nd.
const WED = '2026-11-18', MON = '2026-11-23';

if (L) {
  console.log('\n1. what counts as a blank day');
  ok('no page at all is blank', L.isBlankDay([], floors, none, '2026-11-17'));
  ok('a page with no floor met and no workout is blank', L.isBlankDay([page('2026-11-17', [])], floors, none, '2026-11-17'));
  ok('one floor met makes the day not blank', !L.isBlankDay([page('2026-11-17', ['sleep'])], floors, none, '2026-11-17'));
  ok('a finished workout alone makes it not blank', !L.isBlankDay([page('2026-11-17', [])], floors, trained('2026-11-17'), '2026-11-17'));
  ok('two pages for one date merge: a floor on the second page counts', !L.isBlankDay([page('2026-11-17', []), Object.assign(page('2026-11-17', ['task']), { suf: 2 })], floors, none, '2026-11-17'));
  ok('a missed floor does not make a day blank (some floors met)', !L.isBlankDay([page('2026-11-17', ['sleep'])], floors, none, '2026-11-17'));
  ok('a floor met on another date does not count', L.isBlankDay([page('2026-11-16', ['sleep', 'train', 'task'])], floors, none, '2026-11-17'));

  console.log('\n2. when the banner shows');
  const earlier = [page('2026-11-14', ['sleep', 'train'])];
  const b = L.bannerFor({ pages: earlier, floors, hasWorkout: none, todayDk: WED, dismissedFor: '' });
  ok('yesterday blank, an earlier day logged: shows, for yesterday', !!b && b.dk === '2026-11-17', JSON.stringify(b));
  ok('...and says how to name it (Tue Nov 17)', !!b && b.label === 'Tue Nov 17', JSON.stringify(b));
  ok('yesterday had a floor met: no banner', L.bannerFor({ pages: earlier.concat([page('2026-11-17', ['task'])]), floors, hasWorkout: none, todayDk: WED, dismissedFor: '' }) === null);
  ok('yesterday had only a workout: no banner', L.bannerFor({ pages: earlier, floors, hasWorkout: trained('2026-11-17'), todayDk: WED, dismissedFor: '' }) === null);
  ok('yesterday was a Sunday: no banner (not a required day)', L.bannerFor({ pages: [page('2026-11-20', ['sleep'])], floors, hasWorkout: none, todayDk: MON, dismissedFor: '' }) === null);
  ok('a brand-new tracker (no earlier logged day): no banner', L.bannerFor({ pages: [], floors, hasWorkout: none, todayDk: WED, dismissedFor: '' }) === null);
  ok('earlier pages that are all blank do not count as history: no banner', L.bannerFor({ pages: [page('2026-11-12', []), page('2026-11-13', [])], floors, hasWorkout: none, todayDk: WED, dismissedFor: '' }) === null);
  ok('Not now today hides it', L.bannerFor({ pages: earlier, floors, hasWorkout: none, todayDk: WED, dismissedFor: WED }) === null);
  ok('Not now from another day does not hide today\'s', !!L.bannerFor({ pages: earlier, floors, hasWorkout: none, todayDk: WED, dismissedFor: '2026-11-17' }));
  ok('no floors configured: no banner (every day would read blank)', L.bannerFor({ pages: earlier, floors: [], hasWorkout: none, todayDk: WED, dismissedFor: '' }) === null);
  ok('a day older than yesterday is never offered', (L.bannerFor({ pages: earlier, floors, hasWorkout: none, todayDk: WED, dismissedFor: '' }) || {}).dk !== '2026-11-16');
  ok('garbage in gives no banner and no throw', L.bannerFor({ pages: null, floors: null, hasWorkout: null, todayDk: 'nope', dismissedFor: null }) === null);

  console.log('\n3. days logged this week');
  const wk = [page('2026-11-12', ['sleep']), page('2026-11-13', []), page('2026-11-15', ['task']), page('2026-11-17', ['train']), page('2026-11-18', ['sleep'])];
  const r = L.daysLogged(wk, floors, trained('2026-11-14'), WED);
  ok('counts the 7 days ending today: 12 to 18 Nov', r && r.from === '2026-11-12' && r.to === WED && r.of === 7, JSON.stringify(r));
  ok('logged = days with a floor or a workout (12, 14 by workout, 15, 17, 18)', r && r.logged === 5, JSON.stringify(r));
  ok('a blank page (13th) and a day with no page (16th) are not logged', r && r.logged < 7);
  ok('an empty tracker reads 0 of 7', (L.daysLogged([], floors, none, WED) || {}).logged === 0);
  ok('no floors configured: null, so the line is not drawn', L.daysLogged(wk, [], none, WED) === null);

  console.log('\n4. wiring (kept to a few pins on purpose)');
  const idx = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  ok('index.html loads the logic and the UI', /js\/blankday-logic\.js/.test(idx) && /js\/blankday-ui\.js/.test(idx));
  ok('the Dash Today card asks the banner for its html', /NBDBlankDay/.test(fs.readFileSync(path.join(SRC, 'js', 'nextup-ui.js'), 'utf8')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
