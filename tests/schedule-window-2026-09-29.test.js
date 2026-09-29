/**
 * tests/schedule-window-2026-09-29.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Calendar hub plan, Phase 0 (documentation/projects/CALENDAR-HUB-PLAN-2026-09-29.md).
 * A lead's install day was a bare 'YYYY-MM-DD' with no time. Jo's answer: the
 * window depends on the job — a project starts about 7 am and runs 1–2 days, a
 * repair or inspection takes minutes to hours at almost any time. So the lead
 * gains scheduledStart / scheduledDurationMin / scheduledEndDate, and
 * docs/pro/js/schedule-window.js does all the date math, pure.
 *
 * What this pins:
 *   - THE UTC trap. new Date('2026-10-06') is Monday evening in New York. The
 *     weekday is asserted in CHILD PROCESSES under real TZ values west and east
 *     of UTC — on a UTC runner the buggy and correct forms agree, which is how
 *     this class of bug ships (the portal-scheduled-date suite's lesson).
 *   - multi-day projects, end-before-start rejected, empty fields → null;
 *   - 24h → 12h, noon and midnight edges, ranges across noon and midnight;
 *   - the .ics times: exclusive all-day DTEND, NY-local → UTC across DST;
 *   - the deal-room install date fills an EMPTY lead date only;
 *   - functions/schedule-window.js is byte-identical to the browser copy, and
 *     every assertion below runs against both.
 *
 * Pure Node. Run: node tests/schedule-window-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLIENT_PATH = path.join(ROOT, 'docs', 'pro', 'js', 'schedule-window.js');
const SERVER_PATH = path.join(ROOT, 'functions', 'schedule-window.js');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const J = JSON.stringify;

console.log('\nthe Cloud Functions copy');
const clientSrc = fs.readFileSync(CLIENT_PATH, 'utf8').replace(/\r\n/g, '\n');
const serverSrc = fs.existsSync(SERVER_PATH) ? fs.readFileSync(SERVER_PATH, 'utf8').replace(/\r\n/g, '\n') : null;
ok('functions/schedule-window.js exists', serverSrc != null);
ok('functions/schedule-window.js is byte-identical to docs/pro/js/schedule-window.js',
  serverSrc === clientSrc, 'copy the browser file over the functions one — never edit only one');

function suite(name, W) {
  console.log('\n══ ' + name + ' ══');

  console.log('\nempty and invalid');
  ok('empty object → null', W.normalize({}) === null);
  ok('undefined → null', W.normalize(undefined) === null);
  ok('blank date → null', W.normalize({ scheduledDate: '' }) === null);
  ok('window fields without a date → null', W.normalize({ scheduledStart: '07:00', scheduledDurationMin: 60 }) === null);
  ok('a date the calendar lacks → null', W.normalize({ scheduledDate: '2026-02-30' }) === null);
  ok('an ISO timestamp is not a date → null', W.normalize({ scheduledDate: '2026-10-06T00:00:00Z' }) === null);
  ok('formatWindow of nothing is empty', W.formatWindow({}, '2026-10-01') === '');

  console.log('\nall day / no time — exactly as before');
  const allday = W.normalize({ scheduledDate: '2026-10-06' });
  ok('date only → kind allday', allday && allday.kind === 'allday' && allday.start === null
    && allday.durationMin === null && allday.endDate === null && allday.days === 1, J(allday));
  ok('null/blank window fields are "empty", not invalid',
    (W.normalize({ scheduledDate: '2026-10-06', scheduledStart: null, scheduledDurationMin: '', scheduledEndDate: '  ' }) || {}).kind === 'allday');
  ok('date only formats as just the date', W.formatWindow({ scheduledDate: '2026-10-06' }, '2026-10-01') === 'Tue, Oct 6',
    W.formatWindow({ scheduledDate: '2026-10-06' }, '2026-10-01'));
  ok('date only has no portal phrase', W.portalPhrase({ scheduledDate: '2026-10-06' }) === '');

  console.log('\nthe weekday — 2026-10-06 is a Tuesday');
  ok('formatWindow says Tue in this process',
    /^Tue, Oct 6/.test(W.formatWindow({ scheduledDate: '2026-10-06' }, '2026-10-01')));

  console.log('\nrepair / inspection (start + length)');
  const rep = { scheduledDate: '2026-10-06', scheduledStart: '14:30', scheduledDurationMin: 60 };
  ok('kind timed', (W.normalize(rep) || {}).kind === 'timed');
  ok('formats as a range sharing pm', W.formatWindow(rep, '2026-10-01') === 'Tue, Oct 6 · 2:30–3:30 pm',
    W.formatWindow(rep, '2026-10-01'));
  ok('portal phrase is the window itself', W.portalPhrase(rep) === '2:30–3:30 pm', W.portalPhrase(rep));
  ok('duration as a numeric string is accepted', (W.normalize(Object.assign({}, rep, { scheduledDurationMin: '90' })) || {}).durationMin === 90);
  ok('30 min', W.formatWindow({ scheduledDate: '2026-10-06', scheduledStart: '09:00', scheduledDurationMin: 30 }, '2026-10-01') === 'Tue, Oct 6 · 9:00–9:30 am');
  ok('a start with no length is a point in time',
    W.formatWindow({ scheduledDate: '2026-10-06', scheduledStart: '14:30' }, '2026-10-01') === 'Tue, Oct 6 · 2:30 pm');
  ok('portal: a bare start is only "around"',
    W.portalPhrase({ scheduledDate: '2026-10-06', scheduledStart: '14:30' }) === 'arriving around 2:30 pm');

  console.log('\nfull project (start + last day)');
  const proj = { scheduledDate: '2026-10-06', scheduledStart: '07:00', scheduledEndDate: '2026-10-07' };
  const pw = W.normalize(proj);
  ok('kind project, 2 days', pw && pw.kind === 'project' && pw.days === 2, J(pw));
  ok('formats "Tue, Oct 6 · 7:00 am · 2-day job"', W.formatWindow(proj, '2026-10-01') === 'Tue, Oct 6 · 7:00 am · 2-day job',
    W.formatWindow(proj, '2026-10-01'));
  ok('portal: "arriving around 7:00 am · 2-day job"', W.portalPhrase(proj) === 'arriving around 7:00 am · 2-day job', W.portalPhrase(proj));
  const one = { scheduledDate: '2026-10-06', scheduledStart: '07:00', scheduledEndDate: '2026-10-06' };
  ok('a 1-day project is valid and does not say "1-day job"',
    (W.normalize(one) || {}).days === 1 && W.formatWindow(one, '2026-10-01') === 'Tue, Oct 6 · 7:00 am');
  ok('a multi-day project without a start still says its length',
    W.formatWindow({ scheduledDate: '2026-10-06', scheduledEndDate: '2026-10-08' }, '2026-10-01') === 'Tue, Oct 6 · 3-day job');
  ok('across a month boundary: Oct 31 → Nov 2 is 3 days',
    (W.normalize({ scheduledDate: '2026-10-31', scheduledEndDate: '2026-11-02' }) || {}).days === 3);
  ok('across a year boundary: Dec 31 → Jan 1 is 2 days',
    (W.normalize({ scheduledDate: '2026-12-31', scheduledEndDate: '2027-01-01' }) || {}).days === 2);
  ok('across the DST change: Nov 1 → Nov 2 2026 is 2 days, not 1.04',
    (W.normalize({ scheduledDate: '2026-11-01', scheduledEndDate: '2026-11-02' }) || {}).days === 2);

  console.log('\nrejected');
  const c = (f) => W.check(f).error;
  ok('end before start → end-before-start', c({ scheduledDate: '2026-10-06', scheduledEndDate: '2026-10-05' }) === 'end-before-start');
  ok('end before start normalizes to null', W.normalize({ scheduledDate: '2026-10-06', scheduledEndDate: '2026-10-05' }) === null);
  ok('bad start "7am"', c({ scheduledDate: '2026-10-06', scheduledStart: '7am' }) === 'bad-start');
  ok('bad start "24:00"', c({ scheduledDate: '2026-10-06', scheduledStart: '24:00' }) === 'bad-start');
  ok('bad start "7:00" (unpadded)', c({ scheduledDate: '2026-10-06', scheduledStart: '7:00' }) === 'bad-start');
  ok('duration 0', c({ scheduledDate: '2026-10-06', scheduledStart: '09:00', scheduledDurationMin: 0 }) === 'bad-duration');
  ok('duration negative', c({ scheduledDate: '2026-10-06', scheduledStart: '09:00', scheduledDurationMin: -30 }) === 'bad-duration');
  ok('duration fractional', c({ scheduledDate: '2026-10-06', scheduledStart: '09:00', scheduledDurationMin: 30.5 }) === 'bad-duration');
  ok('duration over 24h', c({ scheduledDate: '2026-10-06', scheduledStart: '09:00', scheduledDurationMin: 1441 }) === 'bad-duration');
  ok('duration text', c({ scheduledDate: '2026-10-06', scheduledStart: '09:00', scheduledDurationMin: 'an hour' }) === 'bad-duration');
  ok('a length with no start', c({ scheduledDate: '2026-10-06', scheduledDurationMin: 60 }) === 'length-needs-start');
  ok('a length AND a multi-day end', c({ scheduledDate: '2026-10-06', scheduledStart: '07:00', scheduledDurationMin: 60, scheduledEndDate: '2026-10-07' }) === 'length-and-end');
  ok('a bad end date', c({ scheduledDate: '2026-10-06', scheduledEndDate: '2026-10-32' }) === 'bad-end');
  ok('over 14 days', c({ scheduledDate: '2026-10-01', scheduledEndDate: '2026-10-15' }) === 'too-long');
  ok('exactly 14 days is fine', W.check({ scheduledDate: '2026-10-01', scheduledEndDate: '2026-10-14' }).ok === true);
  ok('every error key has a message', Object.keys(W.ERRORS).length >= 8
    && ['no-date', 'bad-start', 'bad-duration', 'bad-end', 'end-before-start', 'too-long', 'length-and-end', 'length-needs-start']
      .every((k) => typeof W.ERRORS[k] === 'string' && W.ERRORS[k].length > 5));

  console.log('\n24h → 12h, noon and midnight');
  ok('00:00 → 12:00 am', W.fmtTime12(0) === '12:00 am');
  ok('00:05 → 12:05 am', W.fmtTime12(5) === '12:05 am');
  ok('11:59 → 11:59 am', W.fmtTime12(11 * 60 + 59) === '11:59 am');
  ok('12:00 → 12:00 pm', W.fmtTime12(12 * 60) === '12:00 pm');
  ok('12:30 → 12:30 pm', W.fmtTime12(12 * 60 + 30) === '12:30 pm');
  ok('13:00 → 1:00 pm', W.fmtTime12(13 * 60) === '1:00 pm');
  ok('23:59 → 11:59 pm', W.fmtTime12(23 * 60 + 59) === '11:59 pm');
  ok('range across noon keeps both suffixes',
    W.formatWindow({ scheduledDate: '2026-10-06', scheduledStart: '11:30', scheduledDurationMin: 60 }, '2026-10-01') === 'Tue, Oct 6 · 11:30 am–12:30 pm');
  ok('range ending exactly at noon',
    W.formatWindow({ scheduledDate: '2026-10-06', scheduledStart: '11:00', scheduledDurationMin: 60 }, '2026-10-01') === 'Tue, Oct 6 · 11:00 am–12:00 pm');
  ok('range across midnight',
    W.formatWindow({ scheduledDate: '2026-10-06', scheduledStart: '23:00', scheduledDurationMin: 120 }, '2026-10-01') === 'Tue, Oct 6 · 11:00 pm–1:00 am');
  ok('a midnight start', W.formatWindow({ scheduledDate: '2026-10-06', scheduledStart: '00:00' }, '2026-10-01') === 'Tue, Oct 6 · 12:00 am');

  console.log('\ntoday and the year');
  ok('today says Today', W.formatWindow({ scheduledDate: '2026-10-06', scheduledStart: '07:00' }, '2026-10-06') === 'Today · 7:00 am');
  ok('another year carries the year', W.formatWindow({ scheduledDate: '2027-01-05' }, '2026-12-20') === 'Tue, Jan 5, 2027');
  ok('no todayYmd → no year, no Today', W.formatWindow({ scheduledDate: '2026-10-06' }) === 'Tue, Oct 6');

  console.log('\nendsAt');
  ok('allday ends its own day', J(W.endsAt({ scheduledDate: '2026-10-06' })) === J({ date: '2026-10-06', time: null }));
  ok('repair ends start + length', J(W.endsAt(rep)) === J({ date: '2026-10-06', time: '15:30' }));
  ok('a point ends when it starts', J(W.endsAt({ scheduledDate: '2026-10-06', scheduledStart: '14:30' })) === J({ date: '2026-10-06', time: '14:30' }));
  ok('a late job rolls into the next day', J(W.endsAt({ scheduledDate: '2026-10-06', scheduledStart: '23:00', scheduledDurationMin: 120 })) === J({ date: '2026-10-07', time: '01:00' }));
  ok('a project ends its last day', J(W.endsAt(proj)) === J({ date: '2026-10-07', time: null }));
  ok('invalid → null', W.endsAt({}) === null);

  console.log('\ncoversDay');
  ok('project covers day 1', W.coversDay(proj, '2026-10-06'));
  ok('project covers day 2', W.coversDay(proj, '2026-10-07'));
  ok('project does not cover the day after', !W.coversDay(proj, '2026-10-08'));
  ok('project does not cover the day before', !W.coversDay(proj, '2026-10-05'));
  ok('allday covers only its day', W.coversDay({ scheduledDate: '2026-10-06' }, '2026-10-06') && !W.coversDay({ scheduledDate: '2026-10-06' }, '2026-10-07'));
  ok('garbage covers nothing', !W.coversDay({}, '2026-10-06') && !W.coversDay(proj, 'tomorrow'));

  console.log('\n.ics times');
  const allIcs = W.toIcsTimes({ scheduledDate: '2026-10-06' });
  ok('allday: DATE start, EXCLUSIVE end the next day', allIcs && allIcs.allDay === true && allIcs.start === '20261006' && allIcs.end === '20261007', J(allIcs));
  const projIcs = W.toIcsTimes(proj);
  ok('multi-day project stays all-day; end = day after the last day',
    projIcs && projIcs.allDay === true && projIcs.start === '20261006' && projIcs.end === '20261008', J(projIcs));
  ok('month-end multi-day end rolls the month', (W.toIcsTimes({ scheduledDate: '2026-10-30', scheduledEndDate: '2026-10-31' }) || {}).end === '20261101');
  const repIcs = W.toIcsTimes(rep);
  ok('repair: timed', repIcs && repIcs.allDay === false);
  ok('repair 2:30 pm EDT on Oct 6 = 18:30Z', repIcs && repIcs.startMs === Date.UTC(2026, 9, 6, 18, 30), repIcs && new Date(repIcs.startMs).toISOString());
  ok('repair end = start + 60 min', repIcs && repIcs.endMs - repIcs.startMs === 3600000);
  const dec = W.toIcsTimes({ scheduledDate: '2026-12-01', scheduledStart: '07:00', scheduledEndDate: '2026-12-01' });
  ok('1-day project with a start is timed: 7:00 am EST on Dec 1 = 12:00Z',
    dec && dec.allDay === false && dec.startMs === Date.UTC(2026, 11, 1, 12, 0), dec && new Date(dec.startMs).toISOString());
  ok('a start with no length has a zero-length end (no invented block)', dec && dec.endMs === dec.startMs);
  ok('timed events carry the zone they were computed in', repIcs && repIcs.tz === 'America/New_York');
  ok('invalid → null', W.toIcsTimes({ scheduledDate: '2026-10-06', scheduledEndDate: '2026-10-01' }) === null);

  console.log('\nlocalToUtcMs across DST (America/New_York)');
  ok('Mar 7 2026 07:00 is EST (UTC-5)', W.localToUtcMs('2026-03-07', '07:00') === Date.UTC(2026, 2, 7, 12, 0));
  ok('Mar 8 2026 07:00 is EDT (UTC-4) — spring forward that morning', W.localToUtcMs('2026-03-08', '07:00') === Date.UTC(2026, 2, 8, 11, 0));
  ok('Nov 1 2026 07:00 is EST again — fall back that morning', W.localToUtcMs('2026-11-01', '07:00') === Date.UTC(2026, 10, 1, 12, 0));
  ok('Oct 31 2026 23:30 is still EDT', W.localToUtcMs('2026-10-31', '23:30') === Date.UTC(2026, 10, 1, 3, 30));
  ok('another zone can be asked for', W.localToUtcMs('2026-07-01', '07:00', 'America/Chicago') === Date.UTC(2026, 6, 1, 12, 0));
  ok('bad input → null', W.localToUtcMs('2026-10-06', '7am') === null && W.localToUtcMs('nope', '07:00') === null);

  console.log('\ndeal room install date → lead (fill-empty only)');
  ok('empty lead date takes the deal date', W.installDateFill('', '2026-10-06') === '2026-10-06');
  ok('missing lead date takes the deal date', W.installDateFill(undefined, '2026-10-06') === '2026-10-06');
  ok('null lead date takes the deal date', W.installDateFill(null, '2026-10-06') === '2026-10-06');
  ok('a date Jo typed is NEVER overwritten', W.installDateFill('2026-10-20', '2026-10-06') === null);
  ok('even a date Jo typed that equals the deal date writes nothing', W.installDateFill('2026-10-06', '2026-10-06') === null);
  ok('a free-text deal date is not copied', W.installDateFill('', 'next Tuesday') === null);
  ok('a deal date the calendar lacks is not copied', W.installDateFill('', '2026-02-30') === null);
  ok('no deal date → nothing', W.installDateFill('', null) === null && W.installDateFill('', '') === null);
}

// Load each copy fresh (no shared require cache) so a drifted server copy
// fails on its own behaviour, not only on the byte check above.
function load(p) { delete require.cache[require.resolve(p)]; return require(p); }
suite('browser copy (docs/pro/js/schedule-window.js)', load(CLIENT_PATH));
if (serverSrc != null) suite('Cloud Functions copy (functions/schedule-window.js)', load(SERVER_PATH));

console.log('\nthe weekday under real timezones (child processes)');
// 2026-10-06 is a Tuesday. The naive form must be proven wrong in the same
// child, or a green result here says nothing about OUR code.
function underTZ(tz, code) {
  return execFileSync(process.execPath, ['-e', code], {
    env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8',
  });
}
const probe = 'const W=require(' + J(CLIENT_PATH) + ');process.stdout.write(W.formatWindow({scheduledDate:"2026-10-06",scheduledStart:"07:00",scheduledEndDate:"2026-10-07"},"2026-10-01"))';
const naive = 'process.stdout.write(new Date("2026-10-06").toLocaleDateString("en-US",{weekday:"short"}))';
[['America/New_York', 'UTC-4'], ['America/Los_Angeles', 'UTC-7'], ['Pacific/Auckland', 'UTC+13'], ['UTC', 'the CI runner']].forEach(([tz, why]) => {
  const out = underTZ(tz, probe);
  ok('in ' + tz + ' (' + why + ') it is Tue, Oct 6', out === 'Tue, Oct 6 · 7:00 am · 2-day job', out);
});
ok('control: the naive new Date("2026-10-06") really says Mon in New York', underTZ('America/New_York', naive) === 'Mon');
const icsProbe = 'const W=require(' + J(CLIENT_PATH) + ');process.stdout.write(String(W.toIcsTimes({scheduledDate:"2026-10-06",scheduledStart:"07:00"}).startMs))';
ok('the NY → UTC instant does not depend on the host zone (Auckland host)',
  underTZ('Pacific/Auckland', icsProbe) === String(Date.UTC(2026, 9, 6, 11, 0)));

console.log('\nthe source never parses a bare date string');
const code = clientSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
ok('no new Date(<string>) anywhere in the module', !/new Date\(\s*['"a-zA-Z_]/.test(code.replace(/new Date\((utcMs|t|p\.day \* DAY_MS|day \* DAY_MS)\)/g, '')));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
