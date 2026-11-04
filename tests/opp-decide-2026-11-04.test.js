/**
 * tests/opp-decide-2026-11-04.test.js
 *
 * Thumbtack Opportunities watcher, PR 4: the pure half of the approval callables
 * (functions/opp-decide-logic.js). No Firestore, no clock (the moment is passed in). Pins:
 *   1. dayKey / weekKey: the Eastern calendar day and the Monday-start week, at midnight, at the
 *      DST change (2026-11-01) and across a year end;
 *   2. capCounts / bumpCaps: stale day and week count as 0, a corrupt counter is unknown (null),
 *      a bump adds one to today and this week;
 *   3. sendLabel: "will send 8am" outside 8am to 8pm Eastern, at both edges;
 *   4. textProblem is the PR 3 draftProblem (one refuser, no second copy), with the usual attacks;
 *   5. cardOf is a whitelist: nothing raw is copied through, bad values become blanks / nulls;
 *   6. the closed lists (actions, skip reasons).
 * Synthetic data only (ZZ_QA). Run: node tests/opp-decide-2026-11-04.test.js
 */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const X = require(path.join(ROOT, 'functions/opp-decide-logic.js'));
const D = require(path.join(ROOT, 'functions/opp-draft-logic.js'));
const S = require(path.join(ROOT, 'functions/opp-shortlist-logic.js'));
const R = require(path.join(ROOT, 'functions/opp-rules.js'));

const TZ = 'America/New_York';
const RULES = R.DEFAULT_RULES;

console.log('1. day and week keys (Eastern)');
{
  ok('Wed 2026-11-04 10:00 EST is day 2026-11-04, week of Monday 2026-11-02', X.dayKey(Date.UTC(2026, 10, 4, 15), TZ) === '2026-11-04' && X.weekKey(Date.UTC(2026, 10, 4, 15), TZ) === '2026-11-02');
  ok('11:59 pm Eastern (04:59 UTC next day) is still the same day', X.dayKey(Date.UTC(2026, 10, 5, 4, 59), TZ) === '2026-11-04');
  ok('12:00 am Eastern (05:00 UTC) is the next day', X.dayKey(Date.UTC(2026, 10, 5, 5, 0), TZ) === '2026-11-05');
  ok('a UTC date that is already tomorrow is still today in Eastern (2026-11-05 02:00 UTC = 9 pm Nov 4)', X.dayKey(Date.UTC(2026, 10, 5, 2), TZ) === '2026-11-04');
  ok('Monday is the week start: Mon 00:00 Eastern -> its own date', X.weekKey(Date.UTC(2026, 10, 9, 5, 0), TZ) === '2026-11-09');
  ok('Sunday 11:59 pm Eastern is still the old week', X.weekKey(Date.UTC(2026, 10, 9, 4, 59), TZ) === '2026-11-02');
  ok('Saturday and Sunday belong to the Monday before them', X.weekKey(Date.UTC(2026, 10, 7, 17), TZ) === '2026-11-02' && X.weekKey(Date.UTC(2026, 10, 8, 17), TZ) === '2026-11-02');
  ok('DST ended 2026-11-01 (EDT to EST): Sun 00:30 EDT = 04:30 UTC is Nov 1 in the week of Oct 26', X.dayKey(Date.UTC(2026, 10, 1, 4, 30), TZ) === '2026-11-01' && X.weekKey(Date.UTC(2026, 10, 1, 4, 30), TZ) === '2026-10-26');
  ok('...and Sun 23:30 EST = Mon 04:30 UTC Nov 2 is still Nov 1', X.dayKey(Date.UTC(2026, 10, 2, 4, 30), TZ) === '2026-11-01');
  ok('a week that crosses the year end: Fri 2027-01-01 belongs to the week of Mon 2026-12-28', X.weekKey(Date.UTC(2027, 0, 1, 17), TZ) === '2026-12-28' && X.dayKey(Date.UTC(2027, 0, 1, 17), TZ) === '2027-01-01');
  ok('the zone really is used (Pacific is a different day at 2 am UTC)', X.dayKey(Date.UTC(2026, 10, 5, 2), 'America/Los_Angeles') === '2026-11-04' && X.dayKey(Date.UTC(2026, 10, 5, 9), 'America/Los_Angeles') === '2026-11-05');
}

console.log('\n2. counters');
{
  const now = Date.UTC(2026, 10, 4, 15);
  const doc = { dayKey: '2026-11-04', dayCount: 3, weekKey: '2026-11-02', weekCount: 9 };
  ok('a missing doc counts 0 / 0', JSON.stringify(X.capCounts(null, now, TZ)) === JSON.stringify({ sentToday: 0, sentThisWeek: 0 }) && X.capCounts({}, now, TZ).sentToday === 0);
  ok('a current doc counts as written', X.capCounts(doc, now, TZ).sentToday === 3 && X.capCounts(doc, now, TZ).sentThisWeek === 9);
  ok('a counter from another day counts 0 today but keeps the week', JSON.stringify(X.capCounts(Object.assign({}, doc, { dayKey: '2026-11-03' }), now, TZ)) === JSON.stringify({ sentToday: 0, sentThisWeek: 9 }));
  ok('a counter from another week counts 0 for the week', X.capCounts(Object.assign({}, doc, { weekKey: '2026-10-26' }), now, TZ).sentThisWeek === 0);
  for (const bad of [{ dayCount: 'x' }, { dayCount: -1 }, { dayCount: 2.5 }, { dayCount: null }, { dayCount: NaN }]) {
    ok('corrupt dayCount ' + JSON.stringify(bad) + ' is unknown (null), not 0', X.capCounts(Object.assign({}, doc, bad), now, TZ).sentToday === null);
  }
  ok('corrupt weekCount is unknown (null)', X.capCounts(Object.assign({}, doc, { weekCount: '9' }), now, TZ).sentThisWeek === null);
  ok('a non-string day key is a corrupt doc: unknown, not a fresh day', X.capCounts({ dayKey: 7, dayCount: 1, weekKey: '2026-11-02', weekCount: 1 }, now, TZ).sentToday === null);
  ok('unknown counts make capStatus refuse (fail closed)', S.capStatus(X.capCounts(Object.assign({}, doc, { dayCount: 'x' }), now, TZ), RULES).allowed === false);
  const b = X.bumpCaps(doc, now, TZ);
  ok('bumpCaps adds one to today and this week', b.dayCount === 4 && b.weekCount === 10 && b.dayKey === '2026-11-04' && b.weekKey === '2026-11-02');
  const nb = X.bumpCaps(Object.assign({}, doc, { dayKey: '2026-11-03', weekKey: '2026-10-26' }), now, TZ);
  ok('bumpCaps on a stale doc restarts both at 1', nb.dayCount === 1 && nb.weekCount === 1 && nb.dayKey === '2026-11-04' && nb.weekKey === '2026-11-02');
  ok('the default caps are 8 a day and 25 a week', RULES.caps.sendsPerDay === 8 && RULES.caps.sendsPerWeek === 25);
  ok('8 today is full, 7 is not; 25 this week is full, 24 is not', S.capStatus({ sentToday: 8, sentThisWeek: 0 }, RULES).allowed === false && S.capStatus({ sentToday: 7, sentThisWeek: 24 }, RULES).allowed === true && S.capStatus({ sentToday: 0, sentThisWeek: 25 }, RULES).allowed === false);
}

console.log('\n3. the send label');
{
  const at = (h, m) => Date.UTC(2026, 10, 4, h + 5, m || 0);   // Eastern clock time on Nov 4 2026 (EST)
  ok('10 am Eastern: in the window', X.sendLabel(at(10), RULES).inWindow === true && /8am to 8pm/.test(X.sendLabel(at(10), RULES).label));
  ok('7:59 am: outside, "will send 8am"', X.sendLabel(at(7, 59), RULES).inWindow === false && X.sendLabel(at(7, 59), RULES).label === 'will send 8am');
  ok('8:00 am: inside', X.sendLabel(at(8, 0), RULES).inWindow === true);
  ok('7:59 pm: inside', X.sendLabel(at(19, 59), RULES).inWindow === true);
  ok('8:00 pm: outside, "will send 8am"', X.sendLabel(at(20, 0), RULES).inWindow === false && X.sendLabel(at(20, 0), RULES).label === 'will send 8am');
  ok('3 am: outside', X.sendLabel(at(3), RULES).label === 'will send 8am');
  ok('hourWord: 8 -> 8am, 20 -> 8pm, 0 -> 12am, 12 -> 12pm', X.hourWord(8) === '8am' && X.hourWord(20) === '8pm' && X.hourWord(0) === '12am' && X.hourWord(12) === '12pm');
}

console.log('\n4. textProblem is the PR 3 refuser, once');
{
  const good = 'Hi, we are fully insured and can look at the missing shingles this week. Reply right here in Thumbtack with one photo.';
  ok('a clean message passes', X.textProblem(good) === null && D.draftProblem(good) === null);
  const attacks = ['Call me at 513-555-0100, we are fully insured.', 'five one three five five five zero one zero zero, fully insured', 'Text me, we are fully insured.', 'Hi, we are fully insured and can look at the roof. 555 0100 is the shop.', 'See www.example.com, fully insured.', 'jo@example.com fully insured', 'We will handle your insurance claim, fully insured.', 'about $200 fully insured', '', '   ', 'x'.repeat(701)];
  ok('every attack is refused with the same words as PR 3', attacks.every((a) => X.textProblem(a) !== null && X.textProblem(a) === D.draftProblem(a)));
  ok('a non-string is refused', X.textProblem(undefined) !== null && X.textProblem(5) !== null && X.textProblem({}) !== null && X.textProblem(null) !== null);
  ok('the phone message tells Jo why', /phone number|call, text or email/i.test(X.textProblem('Call me at 513-555-0100, fully insured.') || ''));
}

console.log('\n5. cardOf is a whitelist');
{
  const now = Date.UTC(2026, 10, 4, 15);
  const seen = { companyId: 'x', filedBy: 'y', oppId: 'ZZ1', category: 'Roof repair', tradeKey: 'roof_repair', city: 'Goshen', zip: '45122', milesNearestBase: 4.2, baseUsed: 'goshen', prosAlready: 1, photos: 2, postedAgeMin: 10, score: 88, reasons: ['r1', 'r2'], flags: ['f1'], seenAt: { seconds: Math.floor((now - 300000) / 1000) }, rulesVersion: 1 };
  const draft = { companyId: 'x', createdBy: 'y', approvedBy: 'z', oppId: 'ZZ1', status: 'pending', draftText: 'ZZ_QA draft', templateKey: 'opp_roof_repair_a', expireAt: new Date(now + 1e9), usedQuote: true };
  const c = X.cardOf('ZZ1', draft, seen, now, RULES);
  ok('only the documented keys come out', JSON.stringify(Object.keys(c).sort()) === JSON.stringify(['ageNowMin', 'approvedAtMs', 'baseUsed', 'category', 'city', 'editedByJo', 'flags', 'milesNearestBase', 'oppId', 'originalText', 'photos', 'prosAlready', 'reasons', 'score', 'sendLabel', 'skipReason', 'snoozedUntilMs', 'status', 'templateKey', 'text', 'tradeKey', 'zip']), Object.keys(c).sort().join());
  ok('no raw companyId, uid or expiry is copied', !JSON.stringify(c).includes('"x"') && !('companyId' in c) && !('createdBy' in c) && !('expireAt' in c));
  ok('age is posted age plus time since seen (10 + 5 = 15)', c.ageNowMin === 15);
  ok('a pending card has no approved fields', c.sendLabel === null && c.skipReason === null && c.originalText === null && c.text === 'ZZ_QA draft');
  const e = X.cardOf('ZZ1', Object.assign({}, draft, { editedText: 'ZZ_QA edited', editedByJo: true }), seen, now, RULES);
  ok('an edited draft shows the edit and keeps the original', e.text === 'ZZ_QA edited' && e.originalText === 'ZZ_QA draft' && e.editedByJo === true);
  const a = X.cardOf('ZZ1', Object.assign({}, draft, { status: 'approved', approvedText: 'ZZ_QA approved', sendLabel: 'will send 8am', approvedAt: { seconds: 5 } }), seen, now, RULES);
  ok('an approved card shows the frozen text and the label', a.text === 'ZZ_QA approved' && a.sendLabel === 'will send 8am' && a.approvedAtMs === 5000 && a.originalText === 'ZZ_QA draft');
  const s = X.cardOf('ZZ1', Object.assign({}, draft, { snoozedUntil: new Date(now + 1000) }), seen, now, RULES);
  ok('a snooze in the future is reported; one in the past is not', s.snoozedUntilMs === now + 1000 && X.cardOf('ZZ1', Object.assign({}, draft, { snoozedUntil: new Date(now - 1) }), seen, now, RULES).snoozedUntilMs === null);
  const junk = X.cardOf('ZZ1', { status: { a: 1 }, draftText: 5 }, { category: { a: 1 }, zip: '12', city: 7, score: 'high', reasons: 'nope', flags: [1, null, 'ok'], photos: '2', milesNearestBase: '4' }, now, RULES);
  ok('malformed values become blanks / nulls, never raw objects', junk.status === '' && junk.text === '' && junk.category === '' && junk.zip === '' && junk.city === '' && junk.score === null && junk.reasons.length === 0 && junk.photos === null && junk.milesNearestBase === null, JSON.stringify(junk));
  const longc = X.cardOf('ZZ1', Object.assign({}, draft, { draftText: 'x'.repeat(5000) }), seen, now, RULES);
  ok('an overlong text is cut', longc.text.length <= D.DRAFT_MAX + 50);
  ok('toMs reads a Timestamp-like, a Date, a number and {seconds}; nothing else', X.toMs({ toMillis: () => 7 }) === 7 && X.toMs(new Date(9)) === 9 && X.toMs(11) === 11 && X.toMs({ seconds: 2 }) === 2000 && X.toMs('x') === null && X.toMs(NaN) === null && X.toMs(null) === null);
}

console.log('\n6. closed lists');
{
  ok('the actions are approve, edit, skip, snooze (no approve-all, no send)', X.ACTIONS.join() === 'approve,edit,skip,snooze');
  ok('the skip reasons are exactly the four from the design', Object.keys(X.SKIP_REASONS).join() === 'wrong_trade,too_far,too_small,too_crowded');
  ok('snooze is one hour', X.SNOOZE_MS === 3600000);
  ok('the lists are frozen', Object.isFrozen(X.ACTIONS) && Object.isFrozen(X.SKIP_REASONS));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
