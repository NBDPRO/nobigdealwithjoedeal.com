#!/usr/bin/env node
/**
 * Ping volume (2026-10-13; audit F4 / F6 / F7 / F8 + the 08:00 double push):
 * documentation/audit/PING-VOLUME-2026-10-13.md. The end-to-end numbers are in
 * tests/needs-you-volume-sim-2026-10-13.test.js; this file pins the rules.
 *
 * Every absence assertion ("no push", "no email") is paired with a presence
 * control built from the same fixture with ONE field changed, so a harness that
 * blanks the keyed value cannot make it pass with the bug present.
 * Run: node tests/ping-volume-2026-10-13.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.env.CALL_WATCH_ENABLED = 'true';
process.env.CALL_CENTER_INGEST_ENABLED = 'false';
process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'false';
delete process.env.TEXT_NOTES_ENABLED;

const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
const PV = require(path.join(ROOT, 'functions/ping-volume-logic.js'));
const L = require(path.join(ROOT, 'functions/call-center-logic.js'));
const MB = require(path.join(ROOT, 'functions/morning-brief-logic.js'));
const WATCH = require(path.join(ROOT, 'functions/call-watch.js'))._internal;
const CCmod = require(path.join(ROOT, 'functions/call-center.js'));
const CC = CCmod._test;
const MBR = require(path.join(ROOT, 'functions/morning-brief.js'));
const THU = require(path.join(ROOT, 'functions/integrations/thursday.js'));
const OWNER = CC.OWNER;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' - ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
const MIN = 60000, H = 3600000, D = 86400000;
const T0 = Date.parse('2026-10-07T16:00:00Z');             // Wed 12:00 ET
const TODAY = W.etYmd(T0);

(async () => {
  // ── 1. what kind of need is it ───────────────────────────────────────────
  console.log('1. kindOf');
  const it = (why, key, extra) => Object.assign({ id: 'call:' + why, key: key || 'num:5135550101', why }, extra || {});
  ok('urgent / promise / due / insurance', PV.kindOf(it('urgent')) === 'urgent' && PV.kindOf(it('urgent - still open (reminder 1)')) === 'urgent' && PV.kindOf(it('you promised something')) === 'promise' && PV.kindOf(it('follow-up due')) === 'due' && PV.kindOf(it('insurance line, no customer on file')) === 'insurance');
  ok('unknown number / missed call with no customer = low', PV.kindOf(it('unknown number, no customer on file')) === 'low' && PV.kindOf(it('missed call')) === 'low');
  ok('control: a missed call from a KNOWN customer is not low', PV.kindOf(it('missed call', 'lead:L1')) === 'missed' && !PV.isLow(it('missed call', 'lead:L1')));
  ok('control: Thursday and a hidden number that came back are not low', PV.kindOf({ kind: 'thursday', id: 'thursday:x', why: 'Thursday took it' }) === 'thursday' && PV.kindOf({ id: 'hidden:5135550101:0', why: 'a hidden number is calling a lot' }) === 'hidden');

  // ── 2. planPush ──────────────────────────────────────────────────────────
  console.log('2. planPush: what may buzz');
  const plan = (items, pp, rows) => PV.planPush({ items, pp: pp || {}, facts: PV.personFacts(rows || [], T0, W.callerKey), nowMs: T0, callerKey: W.callerKey });
  const lowA = it('unknown number, no customer on file', 'num:5135550111', { id: 'call:a' });
  const pr = it('you promised something', 'lead:L7', { id: 'call:b' });
  let p = plan([lowA]);
  ok('low-value only: bell yes (kept in the alert), push no', p.alertItems.length === 1 && p.pushItems.length === 0);
  p = plan([lowA, pr]);
  ok('control: add one promise and the run pushes (for the promise only)', p.pushItems.length === 1 && p.pushItems[0].id === 'call:b' && p.alertItems.length === 2);
  p = plan([lowA], { 'num:5135550111': { ymd: TODAY, lowBellYmd: TODAY, firstAtMs: T0 - H } });
  ok('a number already belled today is dropped from today\'s alerts (the brief carries it)', p.alertItems.length === 0 && p.lowDropped.length === 1);
  p = plan([lowA], { 'num:5135550111': { ymd: '2026-10-06', lowBellYmd: '2026-10-06', firstAtMs: T0 - D } });
  ok('control: yesterday\'s bell does not silence today', p.alertItems.length === 1);
  p = plan([lowA, Object.assign({}, lowA, { id: 'call:z', key: 'num:5135550999' })], { 'num:5135550111': { ymd: TODAY, lowBellYmd: TODAY, firstAtMs: T0 - H } });
  ok('control: a DIFFERENT number is not affected by the first number\'s cap', p.alertItems.length === 1 && p.alertItems[0].key === 'num:5135550999');

  const urg = it('urgent', 'lead:L9', { id: 'call:u2' });
  const entryUrgentPushed = { 'lead:L9': { ymd: TODAY, n: 1, kinds: { urgent: T0 - H }, firstAtMs: T0 - H } };
  p = plan([urg], entryUrgentPushed);
  ok('a repeat of a kind already pushed today (a second urgent call) is folded: no push', p.pushItems.length === 0 && p.alertItems.length === 1);
  p = plan([it('you promised something', 'lead:L9', { id: 'call:p2' })], entryUrgentPushed);
  ok('control: a NEW kind (a promise after the urgent push) always pushes', p.pushItems.length === 1);
  p = plan([Object.assign({}, urg, { rung: 2, why: 'urgent - still open (reminder 1)' })], entryUrgentPushed);
  ok('a ladder re-tell (rung 2) of the same kind pushes while the person is under 3 pushes today', p.pushItems.length === 1);
  p = plan([Object.assign({}, urg, { rung: 2, why: 'urgent - still open (reminder 1)' })], { 'lead:L9': { ymd: TODAY, n: 3, kinds: { urgent: T0 - H }, firstAtMs: T0 - 4 * H } });
  ok('...and stops at 3 (the person card is full)', p.pushItems.length === 0);
  p = plan([Object.assign({}, urg, { rung: 3, why: 'urgent - still open (reminder 2)' })], { 'lead:L9': { ymd: TODAY, n: 3, kinds: { urgent: T0 - H }, firstAtMs: T0 - 4 * H } });
  ok('the LAST rung (sticky) still goes once a day even with a full card', p.pushItems.length === 1);
  p = plan([Object.assign({}, urg, { rung: 3, why: 'urgent - still open (reminder 2)' })], { 'lead:L9': { ymd: TODAY, n: 3, kinds: { urgent: T0 - H }, stickyYmd: TODAY, firstAtMs: T0 - 4 * H } });
  ok('...but only once: a second sticky the same day is folded', p.pushItems.length === 0);
  // an immediate urgent push from the call rows counts against the card
  const rowPushed = { id: 'c1', leadId: 'L9', urgent: true, urgentPushedAtMs: T0 - 30 * MIN, startedAtMs: T0 - H };
  p = plan([urg], {}, [rowPushed]);
  ok('an immediate urgent push (on the call row) counts: a second urgent call is folded without any stored state', p.pushItems.length === 0);
  p = plan([urg], {}, [Object.assign({}, rowPushed, { urgentPushedAtMs: T0 - 30 * MIN, urgentFoldedAtMs: T0 - 20 * MIN })]);
  ok('control: a FOLDED call was not a push of its own and counts for nothing', p.pushItems.length === 1);
  p = plan([urg], {}, [Object.assign({}, rowPushed, { handledAtMs: T0 - 10 * MIN })]);
  ok('control: once Jo HANDLED the person, the earlier push belongs to a closed episode (a new urgent call pushes)', p.pushItems.length === 1);
  p = plan([urg], entryUrgentPushed, [{ id: 'c1', leadId: 'L9', handledAtMs: T0 - 10 * MIN, startedAtMs: T0 - 2 * H }]);
  ok('...the same holds for the stored card (a handled person starts fresh)', p.pushItems.length === 1);

  // ── 3. applyRun ──────────────────────────────────────────────────────────
  console.log('3. applyRun: a push that reached 0 devices is not "told"');
  let nx = PV.applyRun({ pp: {}, nowMs: T0, pushItems: [urg], pushReached: false, belledLowKeys: [], emailedKeys: [], stickyKeys: [], facts: new Map() });
  ok('unreached: nothing counted (the next run may try again)', !nx['lead:L9']);
  nx = PV.applyRun({ pp: {}, nowMs: T0, pushItems: [urg], pushReached: true, belledLowKeys: ['num:5135550111'], emailedKeys: ['lead:L9'], stickyKeys: ['lead:L9'], facts: new Map() });
  ok('control: reached -> one push counted with its kind; low bell, email and sticky stamped',
    nx['lead:L9'].n === 1 && nx['lead:L9'].kinds.urgent === T0 && nx['lead:L9'].emailedYmd === TODAY && nx['lead:L9'].stickyYmd === TODAY && nx['num:5135550111'].lowBellYmd === TODAY, nx);
  const two = PV.applyRun({ pp: nx, nowMs: T0 + 2 * H, pushItems: [urg, Object.assign({}, urg, { id: 'x' })], pushReached: true, belledLowKeys: [], emailedKeys: [], stickyKeys: [], facts: new Map() });
  ok('two items of one person in one push count as ONE push', two['lead:L9'].n === 2);
  const nextDay = PV.applyRun({ pp: nx, nowMs: T0 + D, pushItems: [], pushReached: false, belledLowKeys: [], emailedKeys: [], stickyKeys: [], facts: new Map() });
  ok('yesterday\'s entries are not carried (the card is per day)', Object.keys(nextDay).length === 0);
  ok('emailedToday reads the stamp, and only for today', PV.emailedToday(nx, 'lead:L9', T0, new Map()) === true && PV.emailedToday(nx, 'lead:L9', T0 + D, new Map()) === false && PV.emailedToday(nx, 'lead:OTHER', T0, new Map()) === false);

  // ── 4. digest signature ──────────────────────────────────────────────────
  console.log('4. digestSig / digestUnchanged');
  const items = [{ kind: 'urgent', callId: 'c1', due: TODAY, promises: [] }, { kind: 'due', callId: 'c2', due: TODAY, promises: ['send the quote'] }];
  const sig = PV.digestSig(items);
  ok('order does not change the signature', PV.digestSig(items.slice().reverse()) === sig);
  ok('a changed promise text, a new item or a moved date changes it', PV.digestSig([items[0], Object.assign({}, items[1], { promises: ['send a quote'] })]) !== sig && PV.digestSig(items.concat([{ kind: 'due', callId: 'c3', due: TODAY, promises: [] }])) !== sig && PV.digestSig([items[0], Object.assign({}, items[1], { due: '2026-10-09' })]) !== sig);
  ok('unchanged vs the same day\'s stamp -> skip', PV.digestUnchanged({ ymd: TODAY, sig }, items, T0) === true);
  ok('control: a stamp from yesterday never suppresses today', PV.digestUnchanged({ ymd: '2026-10-06', sig }, items, T0) === false);
  ok('control: a missing stamp / empty doc never suppresses', PV.digestUnchanged(null, items, T0) === false && PV.digestUnchanged({}, items, T0) === false);

  // ── 5. Thursday quiet hours ──────────────────────────────────────────────
  console.log('5. holdThursday (21:00-08:00 ET)');
  const at = (hh, mm) => { const base = Date.parse('2026-10-07T04:00:00Z'); return base + (hh * 60 + (mm || 0)) * MIN; };   // 00:00 EDT + hh:mm
  const heldHours = [21, 22, 23, 0, 3, 7].map((h) => PV.holdThursday({ urgent: false }, at(h, h === 7 ? 59 : 0)));
  ok('non-urgent at 21:00, 22:00, 23:00, 00:00, 03:00, 07:59 ET is held', heldHours.every(Boolean), heldHours);
  const openHours = [8, 12, 20].map((h) => PV.holdThursday({ urgent: false }, at(h, h === 20 ? 59 : 0)));
  ok('control: non-urgent at 08:00, 12:00, 20:59 ET goes out', openHours.every((x) => x === false), openHours);
  ok('emergency path: an URGENT call is never held, at 22:30 or 03:00', PV.holdThursday({ urgent: true }, at(22, 30)) === false && PV.holdThursday({ urgent: true }, at(3, 0)) === false);
  // the real notifyAll
  const updates = [];
  const ref = { update: async (v) => { updates.push(v); } };
  const cfg = { emailTo: 'jo@example.invalid', pushEnabled: true, pushUid: 'u', smsEnabled: false };
  const bodyArgs = { extraction: { caller_type: 'new_lead', caller_name: 'Pat' }, call: { callId: 'c1' }, route: { label: 'New lead' }, leadId: null };
  const run = async (urgent, nowMs) => { updates.length = 0; await THU._test.notifyAll(ref, {}, { cfg, call: { callId: 'c1' }, bodyArgs, nowMs, route: { notifyEmail: true, notifyPush: true, notifySms: true, urgent } }); return updates[0] || {}; };
  let u = await run(false, at(22, 30));
  ok('notifyAll at 22:30 ET, non-urgent: email, push and SMS are all HELD (not attempted)',
    ['email', 'push', 'sms'].every((ch) => u['notifyState.' + ch] && u['notifyState.' + ch].status === 'held:quiet-hours'), u);
  u = await run(true, at(22, 30));
  ok('control: the same call flagged urgent is NOT held (it attempts its channels)', ['email', 'push', 'sms'].every((ch) => u['notifyState.' + ch] && !/^held:/.test(u['notifyState.' + ch].status)), u);
  u = await run(false, at(12, 0));
  ok('control: at noon a non-urgent call is not held', ['email', 'push', 'sms'].every((ch) => u['notifyState.' + ch] && !/^held:/.test(u['notifyState.' + ch].status)), u);

  console.log('5b. callWatch does not repeat a Thursday call her own push delivered');
  const thu = (o) => Object.assign({ id: 't1', status: 'processed', reviewed: false, from: '5135550177', startedAt: new Date(T0 - 30 * MIN), processedAt: new Date(T0 - 25 * MIN) }, o);
  const needsFor = (row) => W.newNeeds([], [], [row], T0 - 2 * H, T0, null, new Set()).filter((n) => n.kind === 'thursday');
  ok('her push delivered (notifyState.push.sentAt) -> not told again', needsFor(thu({ notifyState: { push: { status: 'sent', sentAt: new Date(T0 - 24 * MIN) } } })).length === 0);
  ok('control: no notifyState -> told', needsFor(thu()).length === 1);
  ok('control: her push failed / was held -> told', needsFor(thu({ notifyState: { push: { status: 'held:quiet-hours' } } })).length === 1 && needsFor(thu({ notifyState: { push: { status: 'skipped:no-device', attemptedAt: new Date(T0) } } })).length === 1);
  ok('control: her EMAIL went but the push did not -> told (the push is what buzzes)', needsFor(thu({ notifyState: { email: { status: 'sent', sentAt: new Date(T0) } } })).length === 1);

  // ── 6. runWatch end to end (stubbed senders, a fake Firestore) ───────────
  console.log('6. runWatch: bell-only / merged push / one email per person per day');
  function mkDb(rows, extraDocs, opts) {
    const o = opts || {};
    const docs = Object.assign({ 'integrations/callWatch': { lastCheckAtMs: T0 - 2 * H } }, extraDocs || {});
    const data = { phone_calls: rows || [], phone_text_days: [], thursday_calls: [] };
    const q = (arr) => { const x = { where: () => x, orderBy: () => x, limit: () => x, get: async () => ({ docs: arr.map((r) => ({ id: r.id, data: () => r })), forEach() {} }) }; return x; };
    const db = {
      docs, bells: [],
      collection(n) {
        if (n === 'notifications') return { add: async (v) => { db.bells.push(v); } };
        if (n === 'companies') return { doc: () => ({ collection: () => ({ get: async () => ({ docs: [] }) }) }) };
        return q(data[n] || []);
      },
      collectionGroup() {
        const x = { where: () => x, get: async () => ({ docs: (o.taskDocs || []).map((t) => ({ id: t.id, data: () => t, ref: { parent: { parent: { id: t.leadId } } } })), forEach() {} }) };
        return x;
      },
      doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p], id: p.split('/').pop() }), set: async (v) => { docs[p] = v; } }),
      getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    };
    return db;
  }
  const row = (o) => Object.assign({ id: 'c' + Math.random().toString(36).slice(2, 7), userId: OWNER, direction: 'inbound', bucket: 'unknown', phoneDigits: '5135550142', contactName: 'Unknown caller', status: 'noted', startedAtMs: T0 - 30 * MIN, createdAtMs: T0 - 25 * MIN, notedAtMs: T0 - 20 * MIN }, o);
  const go = async (db, now, extra) => {
    const pushes = [], emails = [];
    const r = await WATCH.runWatch(Object.assign({ db, nowMs: now, live: true, push: async (uid, title, body, data) => { pushes.push({ title, body, data }); return { sent: 1 }; }, email: async (m) => { emails.push(m); } }, extra || {}));
    return { r, pushes, emails };
  };
  let d = mkDb([row({ id: 'low1' })]);
  let g = await go(d, T0);
  ok('unknown-number-only run: one bell, NO push', g.r.state === 'alerted' && d.bells.length === 1 && g.pushes.length === 0 && g.r.bellOnly === true, { state: g.r.state, bells: d.bells.length, pushes: g.pushes.length });
  d = mkDb([row({ id: 'real1', promises: [{ who: 'jo', text: 'send the quote' }] })]);
  g = await go(d, T0);
  ok('control: the same call carrying a promise of Jo\'s DOES push', g.pushes.length === 1 && /promised/.test(g.pushes[0].body), g.pushes.map((x) => x.body));
  // belled once a day: the same number calling again two hours later
  d = mkDb([row({ id: 'low1' })]);
  await go(d, T0);
  d.docs['integrations/callWatch'].lastCheckAtMs = T0;
  const again = mkDb([row({ id: 'low1' }), row({ id: 'low2', startedAtMs: T0 + H, createdAtMs: T0 + H, notedAtMs: T0 + H })], { 'integrations/callWatch': d.docs['integrations/callWatch'] });
  g = await go(again, T0 + 2 * H);
  ok('the same unlabelled number again two hours later: no second bell, no push, still open', g.r.state === 'quiet' && again.bells.length === 0 && g.pushes.length === 0 && g.r.lowDropped === 1, { state: g.r.state, bells: again.bells.length, low: g.r.lowDropped });
  const other = mkDb([row({ id: 'low1' }), row({ id: 'low3', phoneDigits: '5135550888', startedAtMs: T0 + H, createdAtMs: T0 + H, notedAtMs: T0 + H })], { 'integrations/callWatch': d.docs['integrations/callWatch'] });
  g = await go(other, T0 + 2 * H);
  ok('control: a DIFFERENT number the same day still gets its one bell', other.bells.length === 1, other.bells.length);

  // (e) merged: an overnight urgent call + a promise task due today = ONE push
  const NOW8 = Date.parse('2026-10-08T12:00:00Z');                 // Thu 08:00 ET
  const overnight = row({ id: 'night1', leadId: 'L5', bucket: 'customer', contactName: 'Pat', urgent: true, startedAtMs: NOW8 - 10 * H, createdAtMs: NOW8 - 9 * H, notedAtMs: NOW8 - 9 * H });
  const taskDocs = [{ id: 'promise-q', leadId: 'L6', kind: 'promise', promiseKind: 'callback', text: 'Call back about the estimate', done: false, dueDate: '2026-10-08', userId: OWNER }];
  const leads = { 'leads/L5': { firstName: 'Pat', userId: OWNER }, 'leads/L6': { firstName: 'Sam', userId: OWNER, companyId: OWNER } };
  d = mkDb([overnight], Object.assign({ 'integrations/callWatch': { lastCheckAtMs: NOW8 - 12 * H } }, leads), { taskDocs });
  g = await go(d, NOW8);
  ok('08:00 with a call alert AND a promise due: ONE push carrying both', g.pushes.length === 1 && /needs? you/.test(g.pushes[0].title) && /promise due today/.test(g.pushes[0].title) && /Sam/.test(g.pushes[0].data.promiseKeys + g.pushes[0].body + 'lead:L6'), g.pushes.map((x) => x.title));
  ok('...both bells are still written (the promise keeps its own record)', d.bells.length === 2 && d.bells.some((b) => b.type === 'promise_due'), d.bells.map((b) => b.type));
  d = mkDb([], Object.assign({ 'integrations/callWatch': { lastCheckAtMs: NOW8 - 12 * H } }, leads), { taskDocs });
  g = await go(d, NOW8);
  ok('control: a promise alone is still its own "N promises due today" push', g.pushes.length === 1 && g.pushes[0].data.type === 'promise_due', g.pushes.map((x) => x.data.type));
  // merged push that reaches nobody: neither counts as told, and it mails once
  d = mkDb([overnight], Object.assign({ 'integrations/callWatch': { lastCheckAtMs: NOW8 - 12 * H } }, leads), { taskDocs });
  let threw = null; const mails = [];
  try { await WATCH.runWatch({ db: d, nowMs: NOW8, live: true, push: async () => ({ sent: 0, failed: 1, errors: [] }), email: async (m) => { mails.push(m); } }); } catch (e) { threw = e; }
  const st = d.docs['integrations/callWatch'];
  ok('merged push that reached 0 devices: the run fails loud, nothing is counted as told, one "did not get it" email', !!threw && !(st.personPings && st.personPings['lead:L5']) && mails.length === 1, { threw: !!threw, pings: st.personPings, mails: mails.length });
  ok('...and the promise person has no ladder entry that says "told" (n is 0, so the next run tries again)', st.ladder['promise:L6'] && st.ladder['promise:L6'].n === 0, st.ladder);

  // one ladder email per person per day
  const stuck = (id) => row({ id, leadId: 'L8', bucket: 'customer', contactName: 'Lee', promises: [{ who: 'jo', text: 'ring back' }], startedAtMs: T0 - 10 * H, createdAtMs: T0 - 10 * H, notedAtMs: T0 - 10 * H });
  const ladderState = { 'call:s1': { n: 2, at: T0 - 3 * H }, 'call:s2': { n: 2, at: T0 - 3 * H } };
  d = mkDb([stuck('s1'), stuck('s2')], { 'integrations/callWatch': { lastCheckAtMs: T0 - 2 * H, ladder: ladderState } });
  g = await go(d, T0);
  ok('two calls of one person on their last rung = ONE email (it already grouped per person)', g.emails.length === 1 && g.emails[0].people === 1, g.emails.map((m) => m.subject));
  const afterRun = d.docs['integrations/callWatch'];
  ok('...and the person is stamped as emailed today', afterRun.personPings['lead:L8'] && afterRun.personPings['lead:L8'].emailedYmd === TODAY, afterRun.personPings);
  // a third call of the same person reaches its last rung two hours later the same day
  const later = mkDb([stuck('s1'), stuck('s2'), stuck('s3')], { 'integrations/callWatch': Object.assign({}, afterRun, { lastCheckAtMs: T0, ladder: Object.assign({}, afterRun.ladder, { 'call:s3': { n: 2, at: T0 - 90 * MIN } }) }) });
  g = await go(later, T0 + 2 * H);
  ok('the same person\'s later last rung the SAME day does not email again', g.emails.length === 0, g.emails.map((m) => m.subject));
  const nextday = mkDb([stuck('s1'), stuck('s2'), stuck('s3')], { 'integrations/callWatch': Object.assign({}, afterRun, { lastCheckAtMs: T0, ladder: Object.assign({}, afterRun.ladder, { 'call:s3': { n: 2, at: T0 + 20 * H } }) }) });
  g = await go(nextday, T0 + 22 * H);
  ok('control: the next day it may (one per person per DAY)', g.emails.length === 1, g.emails.map((m) => m.subject));

  console.log('6b. review fixes: held re-tells, orphaned folds, labels of the cap');
  // A re-tell the person card folds does NOT climb a rung (it waits for room)
  const cardFull = { 'lead:L8': { ymd: TODAY, n: 3, kinds: { promise: T0 - 4 * H }, firstAtMs: T0 - 5 * H } };
  const cardRoom = { 'lead:L8': { ymd: TODAY, n: 1, kinds: { promise: T0 - 4 * H }, firstAtMs: T0 - 5 * H } };
  const ladderN = { 'call:s1': { n: 1, at: T0 - 3 * H }, 'call:s2': { n: 1, at: T0 - 3 * H } };
  d = mkDb([stuck('s1'), stuck('s2')], { 'integrations/callWatch': { lastCheckAtMs: T0 - 2 * H, ladder: ladderN, personPings: cardFull } });
  g = await go(d, T0);
  ok('card full: the rung-2 re-tell is NOT pushed, NOT belled again, and does not climb (it waits for room)',
    g.pushes.length === 0 && d.bells.length === 0 && d.docs['integrations/callWatch'].ladder['call:s1'].n === 1 && d.docs['integrations/callWatch'].ladder['call:s2'].n === 1, { pushes: g.pushes.length, bells: d.bells.length, ladder: d.docs['integrations/callWatch'].ladder });
  d = mkDb([stuck('s1'), stuck('s2')], { 'integrations/callWatch': { lastCheckAtMs: T0 - 2 * H, ladder: ladderN, personPings: cardRoom } });
  g = await go(d, T0);
  ok('control: the same re-tell with room on the card pushes (one push for the person) and climbs both calls in step',
    g.pushes.length === 1 && /\+1 more call/.test(g.pushes[0].body) && d.docs['integrations/callWatch'].ladder['call:s1'].n === 2 && d.docs['integrations/callWatch'].ladder['call:s2'].n === 2, { pushes: g.pushes.map((x) => x.body), ladder: d.docs['integrations/callWatch'].ladder });
  // a held re-tell of one call is carried by the person's push when another item pushes
  const mixed = mkDb([stuck('s1'), stuck('s2'), row({ id: 'new1', leadId: 'L8', bucket: 'customer', contactName: 'Lee', urgent: true, startedAtMs: T0 - 20 * MIN, createdAtMs: T0 - 15 * MIN, notedAtMs: T0 - 15 * MIN })], { 'integrations/callWatch': { lastCheckAtMs: T0 - 2 * H, ladder: ladderN, personPings: cardFull } });
  g = await go(mixed, T0);
  ok('control: a NEW kind from the same person pushes even on a full card, and carries that person\'s re-tells (they climb)',
    g.pushes.length === 1 && mixed.docs['integrations/callWatch'].ladder['call:s1'].n === 2, { pushes: g.pushes.map((x) => x.body), ladder: mixed.docs['integrations/callWatch'].ladder });

  // a folded call whose carrier left the list is told as news (once)
  const carrierOpen = { id: 'cA', leadId: 'L3', urgent: true, status: 'noted', urgentPushedAtMs: T0 - 2 * H, startedAtMs: T0 - 3 * H, notedAtMs: T0 - 3 * H, bucket: 'customer', phoneDigits: '5135550103' };
  const folded = { id: 'cB', leadId: 'L3', urgent: true, status: 'noted', urgentPushedAtMs: T0 - 2 * H, urgentFoldedAtMs: T0 - 150 * MIN, urgentFoldedInto: 'cA', startedAtMs: T0 - 160 * MIN, notedAtMs: T0 - 150 * MIN, bucket: 'customer', phoneDigits: '5135550103' };
  const callNeeds = (rows, told) => W.newNeeds(rows, [], [], T0 - 2 * H, T0, null, told || new Set()).filter((n) => n.kind === 'call');
  ok('carrier handled: the folded call is told as news (its own id, once)', (() => { const n = callNeeds([Object.assign({}, carrierOpen, { handledAtMs: T0 - H }), folded]); return n.length === 1 && n[0].id === 'call:cB' && /#carrier$/.test(n[0].tellId); })());
  ok('control: carrier still open: the folded call stays quiet (it rides the carrier\'s re-tell)', callNeeds([carrierOpen, folded]).length === 0);
  ok('control: carrier snoozed to a later day counts as gone (told)', callNeeds([Object.assign({}, carrierOpen, { snoozeUntilYmd: '2026-10-09' }), folded]).length === 1);
  ok('control: a call pushed on its own (never folded) is not re-told when another call of the person is handled', callNeeds([Object.assign({}, carrierOpen, { handledAtMs: T0 - H }), Object.assign({}, folded, { urgentFoldedAtMs: undefined, urgentFoldedInto: undefined })]).length === 0);
  const toldSet = new Set(['call:cB#carrier']);   // runWatch filters needs by tellId against st.toldIds
  ok('...and once told it is not told again (runWatch drops a need whose tellId is in toldIds)', callNeeds([Object.assign({}, carrierOpen, { handledAtMs: T0 - H }), folded]).filter((n) => !toldSet.has(n.tellId || n.id)).length === 0);

  // a known customer's repeated missed call has no ladder: capped, not folded to nothing
  const missedKnown = it('missed call', 'lead:L2', { id: 'call:m2' });
  p = plan([missedKnown], { 'lead:L2': { ymd: TODAY, n: 1, kinds: { missed: T0 - 2 * H }, firstAtMs: T0 - 3 * H } });
  ok('a second missed call from a known customer pushes while the card has room (it has no re-tell to carry it)', p.pushItems.length === 1);
  p = plan([missedKnown], { 'lead:L2': { ymd: TODAY, n: 3, kinds: { missed: T0 - 2 * H }, firstAtMs: T0 - 5 * H } });
  ok('control: ...and is capped at 3 pushes a day like everything else (bell, not push)', p.pushItems.length === 0 && p.alertItems.length === 1);

  // lastPush: a bell-only run must not erase "the last push reached 0 phones"
  d = mkDb([row({ id: 'low9', phoneDigits: '5135550909' })], { 'integrations/callWatch': { lastCheckAtMs: T0 - 2 * H, lastPush: { atMs: T0 - 4 * H, sent: 0, failed: 1 } } });
  g = await go(d, T0);
  ok('bell-only run keeps lastPush (sent 0) so the 20:00 ledger still warns the phone is dead', g.pushes.length === 0 && d.docs['integrations/callWatch'].lastPush.sent === 0, d.docs['integrations/callWatch'].lastPush);
  d = mkDb([row({ id: 'real9', promises: [{ who: 'jo', text: 'send it' }] })], { 'integrations/callWatch': { lastCheckAtMs: T0 - 2 * H, lastPush: { atMs: T0 - 4 * H, sent: 0, failed: 1 } } });
  g = await go(d, T0);
  ok('control: a run that pushes (and reaches a phone) records the new result', d.docs['integrations/callWatch'].lastPush.sent === 1, d.docs['integrations/callWatch'].lastPush);

  // only the numbers the bell actually names are "belled today"
  const many = [];
  for (let i = 0; i < 7; i++) many.push(row({ id: 'mn' + i, phoneDigits: '513555060' + i, startedAtMs: T0 - (10 + i) * MIN, createdAtMs: T0 - (9 + i) * MIN, notedAtMs: T0 - (9 + i) * MIN }));
  d = mkDb(many);
  g = await go(d, T0);
  const belled = Object.keys(d.docs['integrations/callWatch'].personPings || {}).filter((k) => d.docs['integrations/callWatch'].personPings[k].lowBellYmd === TODAY);
  ok('7 unknown numbers in one run: the bell names 5, so only those 5 are marked belled today', belled.length === 5 && g.pushes.length === 0, belled);

  // Thursday hold needs callWatch live (else nothing would tell the held call)
  {
    const prevEnv = process.env.CALL_WATCH_ENABLED;
    process.env.CALL_WATCH_ENABLED = 'false';
    const u2 = await run(false, at(22, 30));
    process.env.CALL_WATCH_ENABLED = prevEnv;
    ok('callWatch off: a night Thursday call is NOT held (nothing would tell it in the morning)', ['email', 'push', 'sms'].every((ch) => u2['notifyState.' + ch] && !/^held:/.test(u2['notifyState.' + ch].status)), u2);
  }

  // ── 7. pushUrgent folds a second urgent call of an open urgent person ─────
  console.log('7. pushUrgent: the person card');
  const pushNow = Date.parse('2026-10-07T17:00:00Z');                // 13:00 ET
  function urgDb(siblings, failRead) {
    const store = new Map((siblings || []).map((s) => [s.id, s]));
    const stamps = [], bells = [];
    const wheres = [];
    const mkQ = (filters) => ({
      where: (f, op, v) => { wheres.push([f, op, v]); return mkQ(filters.concat([[f, op, v]])); },
      limit: () => mkQ(filters),
      get: async () => {
        if (failRead) throw new Error('read failed');
        const rows = [...store.values()].filter((s) => filters.every(([f, op, v]) => op !== '==' || s[f] === v));
        return { docs: rows.map((s) => ({ id: s.id, data: () => s })) };
      },
    });
    const col = { where: (f, op, v) => { wheres.push([f, op, v]); return mkQ([[f, op, v]]); }, doc: (id) => ({ set: async (v) => { stamps.push([id, v]); } }) };
    void wheres;
    return { stamps, bells, wheres, collection: (n) => (n === 'notifications' ? { add: async (v) => { bells.push(v); } } : (n === 'companies' ? { doc: () => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) }) } : col)) };
  }
  const newCall = { id: 'cube_new', leadId: 'L3', phoneDigits: '5135550103', startedAtMs: pushNow - 5 * MIN, urgent: true };
  const sibling = { id: 'cube_old', leadId: 'L3', phoneDigits: '5135550103', startedAtMs: pushNow - 3 * H, urgent: true, status: 'noted', urgentPushedAtMs: pushNow - 2 * H, userId: OWNER };
  const trySend = async (db) => { const sent = []; const r = await CC.pushUrgent({ db, d: { push: async (u, t, b) => { sent.push(b); return { sent: 1 }; } }, call: newCall, notes: { urgent: true }, leadName: 'Pat', nowMs: pushNow }); return { r, sent }; };
  let x = await trySend(urgDb([sibling]));
  ok('a second urgent call while the first (pushed today) is still open: NO push', x.r === false && x.sent.length === 0, x);
  const dbF = urgDb([sibling]); await trySend(dbF);
  ok('...it is stamped as told and linked to the call that carries it', dbF.stamps.length === 1 && dbF.stamps[0][1].urgentFoldedInto === 'cube_old' && dbF.stamps[0][1].urgentPushedAtMs === sibling.urgentPushedAtMs && dbF.stamps[0][1].urgentFoldedAtMs === pushNow, dbF.stamps);
  x = await trySend(urgDb([]));
  ok('control: with no sibling the same call pushes', x.r === true && x.sent.length === 1, x);
  x = await trySend(urgDb([Object.assign({}, sibling, { handledAtMs: pushNow - H })]));
  ok('control: sibling HANDLED -> a new need, pushes', x.r === true && x.sent.length === 1);
  x = await trySend(urgDb([Object.assign({}, sibling, { urgentPushedAtMs: pushNow - 20 * H })]));
  ok('control: sibling pushed YESTERDAY (a new day) -> pushes', x.r === true && x.sent.length === 1);
  x = await trySend(urgDb([Object.assign({}, sibling, { urgentFoldedAtMs: pushNow - H })]));
  ok('control: a sibling that was itself folded is not a carrier -> pushes', x.r === true && x.sent.length === 1);
  x = await trySend(urgDb([Object.assign({}, sibling, { leadId: 'L4', phoneDigits: '5135550104' })]));
  ok('control: a different person\'s urgent call never folds this one', x.r === true && x.sent.length === 1);
  x = await trySend(urgDb([sibling], true));
  ok('control: a failed sibling read is not an excuse for silence -> pushes', x.r === true && x.sent.length === 1);

  // ── 8. the 15:15 sweep sends once per CHANGE ─────────────────────────────
  console.log('8. runSweep digest dedupe');
  const sweepNow = Date.parse('2026-10-07T19:15:00Z');
  const callRow = { id: 'sw1', userId: OWNER, status: 'noted', startedAtMs: sweepNow - 5 * H, leadId: null, contactName: 'Dana', phoneDigits: '5135550150', promises: [{ who: 'jo', text: 'send the quote' }], summary: 'roof quote', callType: 'lead' };
  function sweepDb(rows, docs, failSig) {
    const store = Object.assign({ ['users/' + OWNER]: { email: 'jo@example.invalid' } }, docs || {});
    const q = (arr) => { const o = { where: () => o, orderBy: () => o, limit: () => o, get: async () => { const dd = arr.map((r) => ({ id: r.id, data: () => r })); return { docs: dd, forEach: (fn) => dd.forEach(fn) }; } }; return o; };
    return {
      store,
      collection(n) {
        if (n === 'phone_calls') return q(rows);
        if (n === 'users') return { doc: (id) => ({ get: async () => ({ exists: ('users/' + id) in store, data: () => store['users/' + id] }) }) };
        if (n === 'companies') return { doc: () => ({ collection: () => ({ get: async () => ({ docs: [] }) }) }) };
        return q([]);
      },
      collectionGroup: () => { const o = { where: () => o, get: async () => ({ docs: [], forEach() {} }) }; return o; },
      doc: (p) => ({
        get: async () => { if (failSig && p === 'integrations/digestSig') throw new Error('sig read failed'); return { exists: p in store, data: () => store[p] }; },
        set: async (v) => { store[p] = v; },
      }),
      getAll: async () => [],
    };
  }
  const sent = [];
  const send = async (m) => { sent.push(m); };
  let sdb = sweepDb([callRow]);
  let rs = await CC.runSweep({ db: sdb, live: true, nowMs: sweepNow, slot: 'pm', absorbed: false, send });
  ok('first 15:15 of the day (no earlier digest): sent, and the signature is stamped', rs.state === 'sent' && sent.length === 1 && sdb.store['integrations/digestSig'] && sdb.store['integrations/digestSig'].ymd === TODAY, rs);
  const sigBefore = sdb.store['integrations/digestSig'];
  sent.length = 0;
  rs = await CC.runSweep({ db: sweepDb([callRow], { 'integrations/digestSig': sigBefore }), live: true, nowMs: sweepNow, slot: 'pm', absorbed: false, send });
  ok('the SAME list at the next digest the same day: skipped (state unchanged), nothing sent', rs.state === 'unchanged' && sent.length === 0, rs);
  rs = await CC.runSweep({ db: sweepDb([Object.assign({}, callRow, { promises: [{ who: 'jo', text: 'send the quote' }, { who: 'jo', text: 'call the adjuster' }] })], { 'integrations/digestSig': sigBefore }), live: true, nowMs: sweepNow, slot: 'pm', absorbed: false, send });
  ok('control: ONE more promise changes the list -> it sends', rs.state === 'sent' && sent.length === 1, rs);
  sent.length = 0;
  rs = await CC.runSweep({ db: sweepDb([callRow], { 'integrations/digestSig': Object.assign({}, sigBefore, { ymd: '2026-10-06' }) }), live: true, nowMs: sweepNow, slot: 'pm', absorbed: false, send });
  ok('control: yesterday\'s signature never suppresses today', rs.state === 'sent' && sent.length === 1, rs);
  sent.length = 0;
  rs = await CC.runSweep({ db: sweepDb([callRow], { 'integrations/digestSig': sigBefore }, true), live: true, nowMs: sweepNow, slot: 'pm', absorbed: false, send });
  ok('control: a failed signature read sends (a duplicate beats a lost reminder)', rs.state === 'sent' && sent.length === 1, rs);
  sent.length = 0;
  rs = await CC.runSweep({ db: sweepDb([callRow], { 'integrations/digestSig': sigBefore }), live: true, nowMs: sweepNow, slot: 'am', absorbed: false, send });
  ok('control: the 07:15 slot is not deduped (only the afternoon repeat is)', rs.state === 'sent' && sent.length === 1, rs);

  // ── 9. the brief records what it listed; the repeat-number summary ───────
  console.log('9. morning brief: digest stamp + repeat-number line');
  const briefNow = Date.parse('2026-10-07T10:45:00Z');
  const bstore = { ['users/' + OWNER]: { email: 'jo@example.invalid' } };
  const anyQ = () => { const o = new Proxy({}, { get: (_, k) => (k === 'get' ? async () => ({ docs: [], size: 0, empty: true, forEach() {} }) : () => o) }); return o; };
  const bdb = {
    collection: (n) => (n === 'users' ? { doc: (id) => ({ get: async () => ({ exists: ('users/' + id) in bstore, data: () => bstore['users/' + id] }) }) } : anyQ()),
    collectionGroup: () => anyQ(),
    doc: (p) => ({ get: async () => ({ exists: p in bstore, data: () => bstore[p] }), set: async (v) => { bstore[p] = v; } }),
  };
  const sections = { newLeads: [], promises: [{ kind: 'due', callId: 'c9', leadId: null, who: 'Dana', promises: ['send the quote'], due: TODAY, summary: '' }], reviewAsks: [], promiseCheckFailed: false, quietLines: ['(513) 555-0137 called 24 times in the last day (hung up each time) and is not labelled. Not pushed. Label it in the Call Center to silence it.'] };
  const sentB = [];
  const mk = () => ({ emails: { send: async (m) => { sentB.push(m); return { data: { id: 'x' }, error: null }; } } });
  const quietLog = { info() {}, warn() {}, error() {} };
  const env = { MORNING_BRIEF_ENABLED: 'true', MORNING_BRIEF_ABSORB_ENABLED: 'true', RESEND_API_KEY: 're_test' };
  const ob = await MBR._test.runMorningBrief({ db: bdb, env, nowMs: briefNow, makeResend: mk, log: quietLog, owner: OWNER, sections: async () => sections, briefLines: async () => ({}) });
  ok('the brief sends and carries the repeat-number summary line (text and html)', ob.status === 'sent' && /REPEAT UNKNOWN NUMBERS/.test(sentB[0].text) && /555\) 555-0137 called 24 times|\(513\) 555-0137 called 24 times/.test(sentB[0].text) && /Repeat unknown numbers/.test(sentB[0].html), { status: ob.status });
  ok('...and stamps the digest signature of the list it sent (the 15:15 sweep compares against it)', bstore['integrations/digestSig'] && bstore['integrations/digestSig'].sig === PV.digestSig(sections.promises) && bstore['integrations/digestSig'].ymd === W.etYmd(briefNow), bstore['integrations/digestSig']);
  const bstore2 = { ['users/' + OWNER]: { email: 'jo@example.invalid' } };
  const bdb2 = Object.assign({}, bdb, { doc: (p) => ({ get: async () => ({ exists: p in bstore2, data: () => bstore2[p] }), set: async (v) => { bstore2[p] = v; } }) });
  bdb2.collection = (n) => (n === 'users' ? { doc: (id) => ({ get: async () => ({ exists: true, data: () => bstore2['users/' + id] }) }) } : anyQ());
  await MBR._test.runMorningBrief({ db: bdb2, env, nowMs: briefNow, makeResend: mk, log: quietLog, owner: OWNER, sections: async () => Object.assign({}, sections, { promiseCheckFailed: true }), briefLines: async () => ({}) });
  ok('control: a brief that carried the "could not check" warning does NOT stamp a signature (the sweep must still send)', !bstore2['integrations/digestSig']);
  // the summary builder itself
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push({ id: 'm' + i, phoneDigits: '5135550137', status: 'short', direction: 'inbound', bucket: 'unknown', startedAtMs: T0 - (i + 1) * H });
  rows.push({ id: 'one', phoneDigits: '5135550200', status: 'short', direction: 'inbound', bucket: 'unknown', startedAtMs: T0 - H });
  const qn = PV.quietNumbers(rows, T0, W.callNeedsYou, Object.assign(W.reachIndex(rows), { labels: {} }));
  ok('a number with 2+ open calls is summarised; a one-off is not', qn.length === 1 && qn[0].digits === '5135550137' && qn[0].n === 4, qn);
  const qnHidden = PV.quietNumbers(rows, T0, W.callNeedsYou, Object.assign(W.reachIndex(rows), { labels: { 5135550137: { kind: 'spam', policy: 'hide', ackAtMs: 0, updatedAtMs: 1 } } }));
  ok('control: a number labelled spam + hide has no summary line', qnHidden.length === 0, qnHidden);
  ok('a failed read is said, not skipped', PV.quietNumberLines([], true).some((l) => /Could not check/.test(l)));
  const mail = L.buildSweepEmail({ items: [{ kind: 'due', callId: 'c1', who: 'Dana', promises: ['x'], summary: '', due: TODAY, channel: 'call' }], todayYmd: TODAY, slot: 'pm', quietLines: ['(513) 555-0137 called 3 times'] });
  ok('the 15:15 email carries the same line', /Repeat unknown numbers/.test(mail.text) && /Repeat unknown numbers/.test(mail.html));
  const mail2 = L.buildSweepEmail({ items: [{ kind: 'due', callId: 'c1', who: 'Dana', promises: ['x'], summary: '', due: TODAY, channel: 'call' }], todayYmd: TODAY, slot: 'pm' });
  ok('control: no lines, no block', !/Repeat unknown numbers/.test(mail2.text) && !/Repeat unknown numbers/.test(mail2.html));
  void MB;

  // ── 10. second audit round: the gaps the vacuity audit found ─────────────
  console.log('10. query shape, latest carrier, closed episodes, wiring');
  {
    // pushUrgent: filed call -> leadId query; unfiled -> phoneDigits query; the carrier is the LATEST
    const filedDb = urgDb([sibling]); await trySend(filedDb);
    ok('a filed call looks siblings up by leadId (userId + leadId equality only: no composite index)', filedDb.wheres.some((w) => w[0] === 'leadId' && w[2] === 'L3') && !filedDb.wheres.some((w) => w[0] === 'phoneDigits'), filedDb.wheres);
    const phoneOnly = Object.assign({}, newCall, { leadId: null });
    const phoneSib = Object.assign({}, sibling, { leadId: null });
    const sendPhone = async (db, call) => { const sentP = []; const r = await CC.pushUrgent({ db, d: { push: async (u, t, b) => { sentP.push(b); return { sent: 1 }; } }, call, notes: { urgent: true }, leadName: '', nowMs: pushNow }); return { r, sentP }; };
    let rp = await sendPhone(urgDb([phoneSib]), phoneOnly);
    ok('an UNFILED call folds into an open urgent call from the same NUMBER', rp.r === false && rp.sentP.length === 0, rp);
    rp = await sendPhone(urgDb([Object.assign({}, phoneSib, { phoneDigits: '5135550999' })]), phoneOnly);
    ok('control: a different number\'s urgent call does not fold it', rp.r === true && rp.sentP.length === 1, rp);
    const phoneDb = urgDb([phoneSib]); await sendPhone(phoneDb, phoneOnly);
    ok('...and the unfiled lookup is by phoneDigits, not leadId', phoneDb.wheres.some((w) => w[0] === 'phoneDigits' && w[2] === '5135550103') && !phoneDb.wheres.some((w) => w[0] === 'leadId'), phoneDb.wheres);
    const older = Object.assign({}, sibling, { id: 'cube_first', urgentPushedAtMs: pushNow - 5 * H });
    const dbL = urgDb([older, sibling]); await trySend(dbL);
    ok('with two pushed siblings the fold links to the LATEST push', dbL.stamps.length === 1 && dbL.stamps[0][1].urgentFoldedInto === 'cube_old' && dbL.stamps[0][1].urgentPushedAtMs === sibling.urgentPushedAtMs, dbL.stamps);

    // planPush / personFacts: yesterday's immediate push counts for nothing today
    p = plan([urg], {}, [Object.assign({}, rowPushed, { urgentPushedAtMs: T0 - 20 * H })]);
    ok('an immediate urgent push from YESTERDAY (on the call row) does not fill today\'s card', p.pushItems.length === 1);
    p = plan([urg], {}, [rowPushed]);
    ok('control: the same push today does', p.pushItems.length === 0);

    // digest signature distinguishes WHO, not just how many
    ok('digestSig: a different item with the same date and promise text is a different list', PV.digestSig([{ kind: 'due', callId: 'cA', due: TODAY, promises: ['x'] }]) !== PV.digestSig([{ kind: 'due', callId: 'cB', due: TODAY, promises: ['x'] }]));
    ok('digestSig: the same item changing kind (due -> urgent) is a different list', PV.digestSig([{ kind: 'due', callId: 'cA', due: TODAY, promises: [] }]) !== PV.digestSig([{ kind: 'urgent', callId: 'cA', due: TODAY, promises: [] }]));
    ok('digestSig: a promise-task row (leadId, no callId) is distinguished by its lead', PV.digestSig([{ kind: 'promise', leadId: 'L1', due: TODAY, promises: ['x'] }]) !== PV.digestSig([{ kind: 'promise', leadId: 'L2', due: TODAY, promises: ['x'] }]));

    // a closed episode: emailed, then handled, then a new need the same day
    const factsH = new Map([['lead:L9', { handledSince: T0 - 10 * MIN, urgentAt: [] }]]);
    const ppE = { 'lead:L9': { ymd: TODAY, n: 2, kinds: { urgent: T0 - 3 * H }, emailedYmd: TODAY, firstAtMs: T0 - 4 * H } };
    ok('emailedToday: a person handled since the email is a NEW episode (may be emailed again)', PV.emailedToday(ppE, 'lead:L9', T0, factsH) === false && PV.emailedToday(ppE, 'lead:L9', T0, new Map()) === true);
    const afterHandled = PV.applyRun({ pp: ppE, nowMs: T0, pushItems: [urg], pushReached: true, belledLowKeys: [], emailedKeys: [], stickyKeys: [], facts: factsH });
    ok('applyRun: a push after Jo handled the person starts a fresh card (n 1, not 3; the old email stamp is gone)', afterHandled['lead:L9'].n === 1 && !afterHandled['lead:L9'].emailedYmd, afterHandled['lead:L9']);

    // quietNumbers boundaries
    const qrow = (o) => Object.assign({ id: 'q' + Math.random().toString(36).slice(2, 7), phoneDigits: '5135550300', status: 'short', direction: 'inbound', bucket: 'unknown', startedAtMs: T0 - H }, o);
    const qn2 = (rowsQ) => PV.quietNumbers(rowsQ, T0, W.callNeedsYou, Object.assign(W.reachIndex(rowsQ), { labels: {} }));
    ok('quietNumbers counts a number with two open unlabelled calls', qn2([qrow(), qrow()]).length === 1);
    ok('control: a customer-filed call is not a repeat NUMBER', qn2([qrow({ leadId: 'L1' }), qrow({ leadId: 'L1' })]).length === 0);
    ok('control: calls older than 36 h are not in the summary', qn2([qrow({ startedAtMs: T0 - 40 * H }), qrow({ startedAtMs: T0 - 41 * H })]).length === 0);
    ok('control: an URGENT call is never "just a repeat number"', qn2([qrow({ urgent: true }), qrow({ urgent: true })]).length === 0);
    const sevenNums = [];
    for (let i = 0; i < 7; i++) { sevenNums.push(qrow({ phoneDigits: '513555040' + i }), qrow({ phoneDigits: '513555040' + i })); }
    const lines7 = PV.quietNumberLines(qn2(sevenNums), false);
    ok('the summary is capped at 5 numbers plus a "+N more" line', lines7.length === 6 && /\+2 more/.test(lines7[5]), lines7);

    // runSweep wiring: the repeat-number line reaches the 15:15 email through gatherSweepWithPromises
    const sweepN = Date.parse('2026-10-07T19:15:00Z');
    const quietRows = [];
    for (let i = 0; i < 3; i++) quietRows.push({ id: 'qs' + i, userId: OWNER, status: 'short', direction: 'inbound', bucket: 'unknown', phoneDigits: '5135550137', startedAtMs: sweepN - (i + 1) * H, leadId: null });
    const sentQ = [];
    let rq = await CC.runSweep({ db: sweepDb([callRow].concat(quietRows)), live: true, nowMs: sweepN, slot: 'pm', absorbed: false, send: async (m) => { sentQ.push(m); } });
    ok('runSweep -> email carries "Repeat unknown numbers" with the number and its count', rq.state === 'sent' && /Repeat unknown numbers/.test(sentQ[0].text) && /555-0137 called 3 times/.test(sentQ[0].text), sentQ[0] && sentQ[0].text);
    sentQ.length = 0;
    rq = await CC.runSweep({ db: sweepDb([callRow]), live: true, nowMs: sweepN, slot: 'pm', absorbed: false, send: async (m) => { sentQ.push(m); } });
    ok('control: without repeat calls the email has no such block', rq.state === 'sent' && !/Repeat unknown numbers/.test(sentQ[0].text));
    // the gather feeds the brief's sections
    const realG = CCmod.gatherSweepWithPromises;
    CCmod.gatherSweepWithPromises = async () => ({ items: [], promiseCheckFailed: false, quietLines: ['(513) 555-0137 called 3 times in the last day'] });
    let gs = null;
    try { gs = await MBR._test.gatherSections({ db: bdb, owner: OWNER, nowMs: briefNow, log: quietLog }); } finally { CCmod.gatherSweepWithPromises = realG; }
    ok('gatherSections passes the gather\'s quietLines through to the brief', gs && Array.isArray(gs.quietLines) && gs.quietLines.length === 1 && /555-0137/.test(gs.quietLines[0]), gs);

    // runSweep + a failed promise-task read: never deduped, never stamped
    const sweepFail = (docs) => { const dbf = sweepDb([callRow], docs); dbf.collectionGroup = () => { const o = { where: () => o, get: async () => { throw new Error('tasks unavailable'); } }; return o; }; return dbf; };
    const stampThen = { ymd: TODAY, sig: 'will-not-match', atMs: 1 };
    const sentF = [];
    const dbFail = sweepFail({ 'integrations/digestSig': Object.assign({}, sigBefore, { atMs: 1 }) });   // atMs 1: a rewrite is visible
    rq = await CC.runSweep({ db: dbFail, live: true, nowMs: sweepNow, slot: 'pm', absorbed: false, send: async (m) => { sentF.push(m); } });
    ok('a failed promise-task read: the 15:15 email goes even when the list matches the stamp, and says "could not check"', rq.state === 'sent' && sentF.length === 1 && /could not check/i.test(sentF[0].text), { state: rq.state, text: sentF[0] && sentF[0].text.slice(0, 160) });
    ok('...and it does NOT overwrite the signature (a warning list is never the baseline)', dbFail.store['integrations/digestSig'].atMs === 1 && dbFail.store['integrations/digestSig'].sig === sigBefore.sig, dbFail.store['integrations/digestSig']);
    void stampThen;

    // runWatch: a pipeline problem alone is still a push (bell-only is for low-value ITEMS)
    process.env.CALL_CENTER_INGEST_ENABLED = 'true';
    try {
      d = mkDb([row({ id: 'lowP' })], { 'integrations/callCenter': { lastRunAtMs: T0 - 5 * H, lastRun: { failed: 0 } } });
      g = await go(d, T0);
      ok('an unknown-number item PLUS a pipeline problem still pushes (the problem is what buzzes)', g.pushes.length === 1 && /behind|haven't been copied|Calls/i.test(g.pushes[0].title + g.pushes[0].body), g.pushes.map((x) => x.title + ' | ' + x.body));
      d = mkDb([row({ id: 'lowP' })], { 'integrations/callCenter': { lastRunAtMs: T0 - 5 * MIN, lastRun: { failed: 0 } } });
      g = await go(d, T0);
      ok('control: the same item with a healthy pipeline is bell-only', g.pushes.length === 0 && d.bells.length === 1);
    } finally { process.env.CALL_CENTER_INGEST_ENABLED = 'false'; }

    // merged push that reached nobody: the promise person has no card entry either
    d = mkDb([overnight], Object.assign({ 'integrations/callWatch': { lastCheckAtMs: NOW8 - 12 * H } }, leads), { taskDocs });
    try { await WATCH.runWatch({ db: d, nowMs: NOW8, live: true, push: async () => ({ sent: 0, failed: 1, errors: [] }), email: async () => {} }); } catch (e) { /* the run fails loud by design */ }
    ok('merged push that reached 0 devices: neither person is on the card (the promise person included)', !(d.docs['integrations/callWatch'].personPings || {})['lead:L6'] && !(d.docs['integrations/callWatch'].personPings || {})['lead:L5'], d.docs['integrations/callWatch'].personPings);

    // a promise person already pushed about a promise today is folded (bell + ladder entry kept)
    const ppProm = { 'lead:L6': { ymd: '2026-10-08', n: 1, kinds: { promise: NOW8 - 3 * H }, firstAtMs: NOW8 - 4 * H } };
    d = mkDb([], Object.assign({ 'integrations/callWatch': { lastCheckAtMs: NOW8 - 12 * H, personPings: ppProm } }, leads), { taskDocs });
    g = await go(d, NOW8);
    ok('a promise person already pushed about a promise today: no second push, the bell is written, the ladder marks them told', g.pushes.length === 0 && d.bells.some((b) => b.type === 'promise_due') && d.docs['integrations/callWatch'].ladder['promise:L6'].n === 1, { pushes: g.pushes.length, bells: d.bells.map((b) => b.type), ladder: d.docs['integrations/callWatch'].ladder });

    // an email stamp only for the people actually mailed (rung 3), not for a rung-2 re-tell in the same run
    const stuckL = (id, lead) => row({ id, leadId: lead, bucket: 'customer', contactName: 'P' + lead, promises: [{ who: 'jo', text: 'ring back' }], startedAtMs: T0 - 10 * H, createdAtMs: T0 - 10 * H, notedAtMs: T0 - 10 * H });
    d = mkDb([stuckL('m1', 'L11'), stuckL('m2', 'L12')], { 'integrations/callWatch': { lastCheckAtMs: T0 - 2 * H, ladder: { 'call:m1': { n: 2, at: T0 - 3 * H }, 'call:m2': { n: 1, at: T0 - 3 * H } } } });
    g = await go(d, T0);
    const pings = d.docs['integrations/callWatch'].personPings || {};
    ok('one person on their last rung is mailed and stamped; the other (rung 2) is pushed but NOT stamped as emailed', g.emails.length === 1 && pings['lead:L11'] && pings['lead:L11'].emailedYmd === TODAY && pings['lead:L12'] && !pings['lead:L12'].emailedYmd, pings);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
