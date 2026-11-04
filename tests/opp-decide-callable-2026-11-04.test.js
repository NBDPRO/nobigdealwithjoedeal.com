/**
 * tests/opp-decide-callable-2026-11-04.test.js
 *
 * Thumbtack Opportunities watcher, PR 4: the approval screen's two callables, oppDraftList and
 * oppDraftDecide (functions/opp-decide.js), flag thumbtackOpportunities (dark). Faked Firestore
 * (documents, queries, and a transaction that runs one at a time, like contention would). Pins:
 *   1. OWNER ONLY for both callables;
 *   2. dark: flag off / killSwitch / unreadable settings change and read nothing;
 *   3. input: bad id, action, text, reason = invalid-argument, nothing read or written;
 *   4. approve: marks `approved`, freezes the exact text, labels "will send 8am" outside the send hours,
 *      writes only opp_drafts and opp_caps, sends nothing, is idempotent and never counted twice;
 *   5. the phone / link / claims refuser runs on every text that could be approved or saved (edited or not);
 *   6. the caps: 8 a day and 25 a week enforced at approve time, day and week rollover, corrupt counter
 *      fails closed, a rules override can only lower them, contention cannot exceed them;
 *   7. edit, skip (closed reasons), snooze, and the pending-only state machine;
 *   8. tenant isolation (another company's draft = the same generic not_found), expiry;
 *   9. oppDraftList: whitelisted cards, caps, sorted, owner's company only;
 *  10. no sender: nothing sent, thumbtackOppSend unread, wiring (App Check, index, map, docs, rules).
 * Synthetic data only (ZZ_QA). Run: node tests/opp-decide-callable-2026-11-04.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

function fakeDb() {
  const docs = new Map();
  const failPaths = new Set();
  const writes = [];
  const reads = [];
  const st = { failTx: false, lock: Promise.resolve() };
  const snap = (p) => ({ id: p.split('/').pop(), exists: docs.has(p), data: () => docs.get(p) });
  function mk(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => { reads.push(p); if (failPaths.has(p)) throw new Error('simulated read failure'); return snap(p); },
      set: async (v, o) => { writes.push(['set', p]); docs.set(p, o && o.merge ? Object.assign({}, docs.get(p), v) : Object.assign({}, v)); },
      update: async (v) => { writes.push(['update', p]); docs.set(p, Object.assign({}, docs.get(p), v)); },
      create: async (v) => {
        writes.push(['create', p]);
        if (docs.has(p)) { const e = new Error('6 ALREADY_EXISTS: ' + p); e.code = 6; throw e; }
        docs.set(p, Object.assign({}, v));
      },
    };
  }
  function collection(name) {
    const filters = []; let lim = 1e9;
    const q = {
      where(f, op, v) { filters.push([f, op, v]); return q; },
      limit(n) { lim = n; return q; },
      get: async () => {
        reads.push('query:' + name);
        const out = [];
        for (const [p, v] of docs) {
          if (p.split('/')[0] !== name || p.split('/').length !== 2) continue;
          if (filters.every(([f, , val]) => v[f] === val)) out.push({ id: p.split('/')[1], data: () => v });
        }
        return { docs: out.slice(0, lim) };
      },
    };
    return q;
  }
  // One transaction at a time (what contention on one document would force); writes apply at commit.
  function runTransaction(fn) {
    const run = st.lock.then(async () => {
      if (st.failTx) throw new Error('simulated transaction failure');
      const buf = [];
      const tx = {
        get: (ref) => ref.get(),
        update: (ref, v) => { buf.push(['update', ref.path, v]); },
        set: (ref, v, o) => { buf.push(['set', ref.path, v, o]); },
      };
      const res = await fn(tx);
      for (const [k, p, v, o] of buf) {
        writes.push([k, p]);
        docs.set(p, k === 'set' && !(o && o.merge) ? Object.assign({}, v) : Object.assign({}, docs.get(p), v));
      }
      return res;
    });
    st.lock = run.catch(() => {});
    return run;
  }
  return { docs, failPaths, writes, reads, st, doc: mk, collection, runTransaction };
}
let DB = fakeDb();
let RATE_LIMITED = false;
const serverTimestamp = () => ({ __ts: true });
const origLoad = Module._load;
let NET = 0;
Module._load = function (request) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue: { serverTimestamp } };
  if (request === 'firebase-admin/auth') return { getAuth: () => ({ getUser: async (uid) => ({ uid, disabled: false, customClaims: {} }) }) };
  if (/upstash-ratelimit$/.test(request)) return { enforceRateLimit: async () => { if (RATE_LIMITED) { const e = new Error('limited'); e.rateLimited = true; throw e; } return { count: 1 }; } };
  return origLoad.apply(this, arguments);
};
const realFetch = global.fetch;
global.fetch = function () { NET++; return Promise.reject(new Error('no network in this test')); };

const Dec = require(path.join(ROOT, 'functions', 'opp-decide.js'));
const A = require(path.join(ROOT, 'functions', 'opp-access.js'));
const D = require(path.join(ROOT, 'functions', 'opp-draft-logic.js'));
const X = require(path.join(ROOT, 'functions', 'opp-decide-logic.js'));

const NBD = A.NBD_OWNER_UID;
const OWNER = { uid: NBD, token: {} };
// Wed 2026-11-04 10:00 Eastern (EST, UTC-5): inside the send hours. Mon 2026-11-02 starts that week.
const IN_HOURS = Date.UTC(2026, 10, 4, 15, 0);
const OUT_HOURS = Date.UTC(2026, 10, 5, 3, 0);     // Wed 10 pm Eastern: outside
let CLOCK = IN_HOURS;
const realNow = Date.now;
Date.now = () => CLOCK;

const callD = async (auth, data) => { try { return { r: await Dec.oppDraftDecide.run({ auth, data, rawRequest: {} }) }; } catch (e) { return { err: e }; } };
const callL = async (auth, data) => { try { return { r: await Dec.oppDraftList.run({ auth, data: data || {}, rawRequest: {} }) }; } catch (e) { return { err: e }; } };

const TEXT = 'Hi, this is No Big Deal Home Solutions. We are fully insured and happy to take a free look at the missing shingles this week, mornings or afternoons. If there was no photo posted, reply right here in Thumbtack with one.';
const EDIT = 'Hi, this is Jo from No Big Deal Home Solutions. We are fully insured and can look at the missing shingles on the back slope this week, mornings or afternoons. Reply right here in Thumbtack and tell me what works.';
const ON = { thumbtackOpportunities: true };
const dk = (id) => 'opp_drafts/' + NBD + '_' + id;
const sk = (id) => 'opp_seen/' + NBD + '_' + id;
const CAPS = 'opp_caps/' + NBD;
const DRAFT = (id, over) => Object.assign({
  companyId: NBD, createdBy: NBD, oppId: id, tradeKey: 'roof_repair', templateKey: 'opp_roof_repair_a', draftText: TEXT, usedQuote: false,
  status: 'pending', createdAt: { __ts: true }, expireAt: new Date(IN_HOURS + 80 * 86400000),
}, over || {});
const SEEN = (id, over) => Object.assign({
  companyId: NBD, oppId: id, decision: 'SHOW', score: 88, tradeKey: 'roof_repair', category: 'Roof repair', city: 'Goshen', zip: '45122',
  summary: 'leak, missing shingles', photos: 2, prosAlready: 1, postedAgeMin: 10, milesNearestBase: 4.2, baseUsed: 'goshen', flags: [], reasons: ['Roof repair is a trade you work.', 'Near the Goshen base.'],
  seenAt: new Date(IN_HOURS - 5 * 60000),
}, over || {});
function seed(over, ids) {
  DB = fakeDb();
  DB.docs.set('feature_flags/_default', ON);
  (ids || ['ZZ1']).forEach((id) => { DB.docs.set(dk(id), DRAFT(id)); DB.docs.set(sk(id), SEEN(id)); });
  Object.keys(over || {}).forEach((k) => { if (over[k] === null) DB.docs.delete(k); else DB.docs.set(k, over[k]); });
  CLOCK = IN_HOURS;
}
const draft = (id) => DB.docs.get(dk(id || 'ZZ1'));
const caps = () => DB.docs.get(CAPS);
const quiet = () => DB.writes.length === 0;

(async () => {
  ok('the test text itself passes the finished-text gate (a fixture that is wrong would prove nothing)', D.draftProblem(TEXT) === null && D.draftProblem(EDIT) === null, D.draftProblem(TEXT) + '|' + D.draftProblem(EDIT));

  console.log('1. owner only (both callables)');
  const refused = [
    ['signed out', null, 'unauthenticated'],
    ['company_admin of the NBD company', { uid: 'carol', token: { role: 'company_admin', companyId: NBD } }, 'permission-denied'],
    ['manager', { uid: 'eve', token: { role: 'manager', companyId: NBD } }, 'permission-denied'],
    ['sales_rep', { uid: 'alice', token: { role: 'sales_rep', companyId: NBD } }, 'permission-denied'],
    ['viewer', { uid: 'vic', token: { role: 'viewer', companyId: NBD } }, 'permission-denied'],
    ['another tenant owner', { uid: 'co-b', token: {} }, 'permission-denied'],
    ['a platform admin who is not the owner', { uid: 'joe', token: { role: 'admin', owner: true } }, 'permission-denied'],
    ['a demoted former owner (owner uid, manager role)', { uid: NBD, token: { role: 'manager' } }, 'permission-denied'],
    ['an anonymous sign-in', { uid: 'anon1', token: { firebase: { sign_in_provider: 'anonymous' } } }, 'permission-denied'],
  ];
  seed();
  let x = await callD(OWNER, { oppId: 'ZZ1', action: 'snooze' });
  ok('the NBD owner is accepted by oppDraftDecide', x.r && x.r.status === 'snoozed', JSON.stringify(x.err && x.err.message));
  x = await callL(OWNER);
  ok('the NBD owner is accepted by oppDraftList', x.r && x.r.status === 'done', JSON.stringify(x.err && x.err.message));
  for (const [name, auth, code] of refused) {
    for (const [fn, label] of [[() => callD(auth, { oppId: 'ZZ1', action: 'approve', text: TEXT }), 'approve'], [() => callL(auth), 'list']]) {
      seed();
      x = await fn();
      ok(name + ' is refused (' + code + ') on ' + label + ', nothing read or written', x.err && x.err.code === code && DB.writes.length === 0 && DB.reads.length === 0, JSON.stringify(x.err ? [x.err.code, x.err.message] : x.r));
      ok('   ...and the draft is still pending', draft().status === 'pending' && !caps());
    }
  }

  console.log('\n2. dark behind the flag and the kill switch');
  for (const [label, flagDocs] of [
    ['no flag docs', null], ['_default without the flag', { _default: { followUpBoard: true } }], ['flag false', { _default: { thumbtackOpportunities: false } }],
    ['flag "true" (string)', { _default: { thumbtackOpportunities: 'true' } }], ['per-user false beats default true', { _default: ON, [NBD]: { thumbtackOpportunities: false } }],
    ['only the reserved send flag', { _default: { thumbtackOppSend: true } }],
  ]) {
    seed({ 'feature_flags/_default': null });
    if (flagDocs) Object.keys(flagDocs).forEach((k) => DB.docs.set('feature_flags/' + k, flagDocs[k]));
    x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
    ok(label + ': approve is not_allowed feature_off, nothing written', x.r && x.r.status === 'not_allowed' && x.r.code === 'feature_off' && quiet() && draft().status === 'pending', JSON.stringify(x.r || x.err.message));
    x = await callL(OWNER);
    ok(label + ': list is not_allowed feature_off and returns no cards', x.r && x.r.status === 'not_allowed' && x.r.code === 'feature_off' && !x.r.cards);
  }
  seed({ 'opp_rules/_default': { killSwitch: true } });
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  ok('killSwitch true stops approve with the flag on', x.r && x.r.code === 'kill_switch' && quiet() && draft().status === 'pending');
  x = await callL(OWNER);
  ok('killSwitch true stops the list too', x.r && x.r.code === 'kill_switch' && !x.r.cards);
  seed(); DB.failPaths.add('feature_flags/_default');
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  ok('unreadable flag doc -> unavailable, nothing written (fail closed)', x.err && x.err.code === 'unavailable' && quiet());
  seed(); RATE_LIMITED = true;
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  RATE_LIMITED = false;
  ok('rate limit -> resource-exhausted, nothing written', x.err && x.err.code === 'resource-exhausted' && quiet());

  console.log('\n3. input');
  seed();
  const bad = [
    ['no data', null], ['no oppId', { action: 'snooze' }], ['oppId with a slash', { oppId: 'a/b', action: 'snooze' }], ['oppId an object', { oppId: { a: 1 }, action: 'snooze' }],
    ['no action', { oppId: 'ZZ1' }], ['action "send"', { oppId: 'ZZ1', action: 'send' }], ['action "approveAll"', { oppId: 'ZZ1', action: 'approveAll' }], ['action "approve_all"', { oppId: 'ZZ1', action: 'approve_all' }],
    ['action "__proto__"', { oppId: 'ZZ1', action: '__proto__' }], ['action an array', { oppId: 'ZZ1', action: ['approve'] }],
    ['approve without text', { oppId: 'ZZ1', action: 'approve' }], ['approve with text a number', { oppId: 'ZZ1', action: 'approve', text: 5 }], ['approve with text over 2000', { oppId: 'ZZ1', action: 'approve', text: 'a'.repeat(2001) }],
    ['edit without text', { oppId: 'ZZ1', action: 'edit' }],
    ['skip without a reason', { oppId: 'ZZ1', action: 'skip' }], ['skip with a free-text reason', { oppId: 'ZZ1', action: 'skip', reason: 'I do not like it' }], ['skip with reason __proto__', { oppId: 'ZZ1', action: 'skip', reason: '__proto__' }],
    ['skip with reason toString', { oppId: 'ZZ1', action: 'skip', reason: 'toString' }],
  ];
  for (const [label, data] of bad) {
    x = await callD(OWNER, data);
    ok(label + ' -> invalid-argument, nothing read or written', x.err && x.err.code === 'invalid-argument' && DB.writes.length === 0 && DB.reads.length === 0, JSON.stringify(x.err ? x.err.code : x.r));
  }
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'snooze', companyId: 'other', status: 'sent', snoozedUntil: 'never', draftText: 'Call 5135550100' });
  ok('extra fields (companyId, status, snoozedUntil, draftText) are ignored', x.r.status === 'snoozed' && draft().status === 'pending' && draft().companyId === NBD && draft().draftText === TEXT && draft().snoozedUntil.getTime() === IN_HOURS + 3600000);

  console.log('\n4. approve');
  seed();
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  let d = draft();
  ok('approve answers approved and says nothing was sent', x.r.status === 'approved' && x.r.code === 'approved' && /nothing was sent/i.test(x.r.message), JSON.stringify(x.r));
  ok('status approved, approvedBy the owner, the exact text frozen as approvedText, server timestamp', d.status === 'approved' && d.approvedBy === NBD && d.approvedText === TEXT && d.approvedAt.__ts === true);
  ok('the original draftText is untouched and editedByJo is false when the text did not change', d.draftText === TEXT && d.editedByJo === false && d.editedText === null);
  ok('inside 8am to 8pm Eastern: approvedInSendHours true and no "will send 8am"', d.approvedInSendHours === true && !/will send 8am/.test(d.sendLabel) && /8am to 8pm/.test(d.sendLabel), d.sendLabel);
  ok('one counter doc: 1 today, 1 this week, Eastern day key and Monday week key', JSON.stringify([caps().dayKey, caps().dayCount, caps().weekKey, caps().weekCount]) === JSON.stringify(['2026-11-04', 1, '2026-11-02', 1]), JSON.stringify(caps()));
  ok('the answer carries the counts and caps', x.r.caps.approvedToday === 1 && x.r.caps.perDay === 8 && x.r.caps.approvedThisWeek === 1 && x.r.caps.perWeek === 25);
  ok('only opp_drafts and opp_caps were written, by update / set (never create or delete)', [...new Set(DB.writes.map((w) => w[1].split('/')[0]))].sort().join() === 'opp_caps,opp_drafts' && DB.writes.every((w) => w[0] === 'update' || w[0] === 'set'), JSON.stringify(DB.writes));
  ok('no network call was made', NET === 0);
  const before = JSON.stringify([draft(), caps()]), nWrites = DB.writes.length;
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  ok('IDEMPOTENT: a second approve answers already_approved', x.r.status === 'already_approved' && x.r.code === 'already_approved', JSON.stringify(x.r));
  ok('...and changes nothing and counts nothing', JSON.stringify([draft(), caps()]) === before && DB.writes.length === nWrites && caps().dayCount === 1);
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: EDIT });
  ok('...even with different text: the approved text is never rewritten', x.r.status === 'already_approved' && draft().approvedText === TEXT && JSON.stringify([draft(), caps()]) === before);

  seed();
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: '  ' + EDIT + '  ' });
  d = draft();
  ok('approving EDITED text: approvedText is Jo\'s text (trimmed), editedByJo true, the original is kept', x.r.status === 'approved' && d.approvedText === EDIT && d.editedByJo === true && d.editedText === EDIT && d.draftText === TEXT, JSON.stringify(d));
  seed();
  CLOCK = OUT_HOURS;
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  d = draft();
  ok('OUTSIDE the send hours (10 pm Eastern): approval is allowed and labelled "will send 8am"', x.r.status === 'approved' && x.r.sendLabel === 'will send 8am' && d.sendLabel === 'will send 8am' && d.approvedInSendHours === false && x.r.inSendHours === false, JSON.stringify(x.r));
  ok('...and it still counts toward today and this week', caps().dayCount === 1 && caps().weekCount === 1 && caps().dayKey === '2026-11-04');
  for (const [label, ms, inside] of [['7:59 am Eastern', Date.UTC(2026, 10, 4, 12, 59), false], ['8:00 am Eastern', Date.UTC(2026, 10, 4, 13, 0), true], ['7:59 pm Eastern', Date.UTC(2026, 10, 5, 0, 59), true], ['8:00 pm Eastern', Date.UTC(2026, 10, 5, 1, 0), false]]) {
    seed(); CLOCK = ms;
    x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
    ok('send-hours boundary ' + label + ': ' + (inside ? 'in the window' : 'will send 8am'), x.r.status === 'approved' && x.r.inSendHours === inside && (inside ? !/will send/.test(x.r.sendLabel) : x.r.sendLabel === 'will send 8am'), JSON.stringify(x.r));
  }

  console.log('\n5. the phone / link / claims refuser runs on every text that could be approved');
  const nasty = [
    ['digits with dashes', 'Hi, we can look at it this week. Call me at 513-555-0100 and we will set it up.'],
    ['a bare SEVEN digit run (a local number)', 'Hi, we are fully insured and can look at the roof. 555 0100 is the shop.'],
    ['a bare ten digit run', 'Hi, we are fully insured and can look at the roof. 5135550100'],
    ['digits split through the text', 'Hi 5 1 3 we are fully 5 5 5 insured and can come 0 1 0 0 this week.'],
    ['number words', 'Hi, we are fully insured. Reach us at five one three five five five zero one zero zero.'],
    ['"text me"', 'Hi, we are fully insured and can come this week. Text me and we will set a time.'],
    ['a zero-width character between digits', 'Hi, we are fully insured. 513\u200b555\u200b0100 is the best way to reach us.'],
    ['a letter O for a zero', 'Hi, we are fully insured. 513 555 O1OO works.'],
    ['a web link', 'Hi, we are fully insured. See www.example.com for our work.'],
    ['an email address', 'Hi, we are fully insured. Write to jo@example.com about it.'],
    ['claims talk', 'Hi, we are fully insured and we will handle your insurance claim for you.'],
    ['a price', 'Hi, we are fully insured and the repair will be $250.'],
    ['an empty message', '   '],
    ['too long', 'Hi, we are fully insured. ' + 'We can come this week. '.repeat(40)],
  ];
  for (const [label, t] of nasty) {
    seed();
    x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: t });
    ok('approve REFUSES ' + label + ' (text_refused), nothing written, still pending', x.r && x.r.status === 'not_allowed' && x.r.code === 'text_refused' && quiet() && draft().status === 'pending' && !caps(), JSON.stringify(x.r || x.err.message));
    seed();
    x = await callD(OWNER, { oppId: 'ZZ1', action: 'edit', text: t });
    ok('edit REFUSES ' + label + ', the stored draft is unchanged', x.r && x.r.code === 'text_refused' && quiet() && !('editedText' in draft()));
  }
  seed();
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: 'Hi, we are fully insured and can look at the roof this week. Reply here with one photo.' });
  ok('POSITIVE CONTROL: a clean edited text with no number is approved', x.r.status === 'approved');
  seed({ [dk('ZZ1')]: DRAFT('ZZ1', { draftText: 'Call me at 513-555-0100 about the roof, we are fully insured.' }) });
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: 'Call me at 513-555-0100 about the roof, we are fully insured.' });
  ok('even the UNCHANGED stored text is re-checked: a stored draft with a phone shape cannot be approved', x.r.code === 'text_refused' && draft().status === 'pending');

  console.log('\n6. the caps');
  const ids = (n, p) => Array.from({ length: n }, (_, i) => (p || 'ZZ') + i);
  seed({}, ids(10));
  const outcomes = [];
  for (const id of ids(10)) { x = await callD(OWNER, { oppId: id, action: 'approve', text: TEXT }); outcomes.push(x.r.status === 'approved' ? 'A' : x.r.code); }
  ok('ten approvals in a row: exactly the first EIGHT are approved, the rest refused cap_reached', outcomes.join() === 'A,A,A,A,A,A,A,A,cap_reached,cap_reached', outcomes.join());
  ok('the refused drafts are still pending and the counter stopped at 8', draft('ZZ8').status === 'pending' && draft('ZZ9').status === 'pending' && caps().dayCount === 8 && caps().weekCount === 8);
  x = await callD(OWNER, { oppId: 'ZZ8', action: 'approve', text: TEXT });
  ok('the daily-cap refusal names the cap and says nothing was approved', /Daily cap of 8 reached/.test(x.r.message) && /Nothing was approved/.test(x.r.message), x.r.message);
  x = await callD(OWNER, { oppId: 'ZZ8', action: 'skip', reason: 'too_far' });
  ok('a capped draft can still be skipped (the cap only stops approving)', x.r.status === 'skipped');
  x = await callD(OWNER, { oppId: 'ZZ0', action: 'approve', text: TEXT });
  ok('re-approving an already approved draft at the cap is still the idempotent answer', x.r.status === 'already_approved');
  seed({ [CAPS]: { companyId: NBD, dayKey: '2026-11-04', dayCount: 7, weekKey: '2026-11-02', weekCount: 7 } }, ids(2));
  x = await callD(OWNER, { oppId: 'ZZ0', action: 'approve', text: TEXT });
  ok('BOUNDARY: with 7 approved today, the 8th is allowed', x.r.status === 'approved' && caps().dayCount === 8);
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  ok('BOUNDARY: with 8 approved today, the 9th is refused', x.r.code === 'cap_reached' && caps().dayCount === 8);
  seed({ [CAPS]: { companyId: NBD, dayKey: '2026-11-04', dayCount: 2, weekKey: '2026-11-02', weekCount: 24 } }, ids(2));
  x = await callD(OWNER, { oppId: 'ZZ0', action: 'approve', text: TEXT });
  ok('BOUNDARY: with 24 approved this week, the 25th is allowed', x.r.status === 'approved' && caps().weekCount === 25 && caps().dayCount === 3);
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  ok('BOUNDARY: with 25 approved this week, the 26th is refused (weekly cap) even though today has room', x.r.code === 'cap_reached' && /Weekly cap of 25 reached/.test(x.r.message) && caps().weekCount === 25, x.r.message);
  seed({ [CAPS]: { companyId: NBD, dayKey: '2026-11-03', dayCount: 8, weekKey: '2026-11-02', weekCount: 12 } }, ids(1));
  x = await callD(OWNER, { oppId: 'ZZ0', action: 'approve', text: TEXT });
  ok('DAY ROLLOVER: yesterday\'s 8 do not block today; today restarts at 1 and the week continues at 13', x.r.status === 'approved' && caps().dayKey === '2026-11-04' && caps().dayCount === 1 && caps().weekCount === 13, JSON.stringify(caps()));
  seed({ [CAPS]: { companyId: NBD, dayKey: '2026-11-04', dayCount: 8, weekKey: '2026-11-02', weekCount: 20 } }, ids(1));
  CLOCK = Date.UTC(2026, 10, 5, 5, 0);   // Thu 00:00 Eastern: a new day, same week
  x = await callD(OWNER, { oppId: 'ZZ0', action: 'approve', text: TEXT });
  ok('EASTERN MIDNIGHT: 12:00 am Eastern is a new day (04:59 UTC is still the old one)', x.r.status === 'approved' && caps().dayKey === '2026-11-05' && caps().dayCount === 1);
  seed({ [CAPS]: { companyId: NBD, dayKey: '2026-11-04', dayCount: 8, weekKey: '2026-11-02', weekCount: 20 } }, ids(1));
  CLOCK = Date.UTC(2026, 10, 5, 4, 59);
  x = await callD(OWNER, { oppId: 'ZZ0', action: 'approve', text: TEXT });
  ok('...11:59 pm Eastern is still the old day and the cap holds', x.r.code === 'cap_reached');
  seed({ [CAPS]: { companyId: NBD, dayKey: '2026-11-08', dayCount: 1, weekKey: '2026-11-02', weekCount: 25 } }, ids(1));
  CLOCK = Date.UTC(2026, 10, 9, 5, 0);   // Mon 00:00 Eastern: the week turns over
  x = await callD(OWNER, { oppId: 'ZZ0', action: 'approve', text: TEXT });
  ok('WEEK ROLLOVER: Monday 12:00 am Eastern starts a new week (the week key is Monday)', x.r.status === 'approved' && caps().weekKey === '2026-11-09' && caps().weekCount === 1, JSON.stringify(caps()));
  seed({ [CAPS]: { companyId: NBD, dayKey: '2026-11-08', dayCount: 1, weekKey: '2026-11-02', weekCount: 25 } }, ids(1));
  CLOCK = Date.UTC(2026, 10, 9, 4, 59);  // Sunday 11:59 pm Eastern: still last week
  x = await callD(OWNER, { oppId: 'ZZ0', action: 'approve', text: TEXT });
  ok('...Sunday 11:59 pm Eastern is still the old week and the weekly cap holds', x.r.code === 'cap_reached');
  for (const bad of [{ dayCount: 'x' }, { dayCount: -1 }, { dayCount: 1.5 }, { dayCount: null }, { weekCount: '25' }]) {
    seed({ [CAPS]: Object.assign({ companyId: NBD, dayKey: '2026-11-04', dayCount: 1, weekKey: '2026-11-02', weekCount: 1 }, bad) }, ids(1));
    x = await callD(OWNER, { oppId: 'ZZ0', action: 'approve', text: TEXT });
    ok('a corrupt counter ' + JSON.stringify(bad) + ' fails CLOSED: nothing approved', x.r.code === 'cap_reached' && draft('ZZ0').status === 'pending', JSON.stringify(x.r));
  }
  seed({ [CAPS]: { companyId: NBD, dayKey: 7, dayCount: 1, weekKey: '2026-11-02', weekCount: 1 } }, ids(1));
  x = await callD(OWNER, { oppId: 'ZZ0', action: 'approve', text: TEXT });
  ok('a counter whose day key is not a string fails closed too', x.r.code === 'cap_reached');
  seed({ 'opp_rules/_default': { caps: { sendsPerDay: 2 } } }, ids(4));
  const low = [];
  for (const id of ids(4)) { x = await callD(OWNER, { oppId: id, action: 'approve', text: TEXT }); low.push(x.r.status === 'approved' ? 'A' : x.r.code); }
  ok('a rules override can LOWER the daily cap (2): A,A,refused,refused', low.join() === 'A,A,cap_reached,cap_reached', low.join());
  seed({ 'opp_rules/_default': { caps: { sendsPerDay: 50, sendsPerWeek: 500 } } }, ids(10));
  const high = [];
  for (const id of ids(10)) { x = await callD(OWNER, { oppId: id, action: 'approve', text: TEXT }); high.push(x.r.status === 'approved' ? 'A' : 'R'); }
  ok('a rules override can NOT raise the caps: still 8 a day', high.join('') === 'AAAAAAAARR', high.join(''));
  seed({}, ids(12));
  const par = await Promise.all(ids(12).map((id) => callD(OWNER, { oppId: id, action: 'approve', text: TEXT })));
  ok('CONTENTION: 12 approvals at the same moment still approve exactly 8', par.filter((p) => p.r && p.r.status === 'approved').length === 8 && par.filter((p) => p.r && p.r.code === 'cap_reached').length === 4 && caps().dayCount === 8, par.map((p) => p.r && (p.r.status + ':' + p.r.code)).join());
  seed();
  const same = await Promise.all([1, 2, 3, 4].map(() => callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT })));
  ok('CONTENTION: 4 taps on the SAME draft = one approved and three already_approved, counted once', same.filter((p) => p.r.status === 'approved').length === 1 && same.filter((p) => p.r.status === 'already_approved').length === 3 && caps().dayCount === 1);
  seed(); DB.st.failTx = true;
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  ok('a transaction failure answers unavailable and changes nothing', x.err && x.err.code === 'unavailable' && quiet() && draft().status === 'pending');

  console.log('\n7. edit, skip, snooze and the state machine');
  seed();
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'edit', text: EDIT });
  ok('edit saves Jo\'s text on a pending draft and does NOT approve it or count it', x.r.status === 'edited' && draft().editedText === EDIT && draft().editedByJo === true && draft().status === 'pending' && draft().draftText === TEXT && !caps());
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'edit', text: TEXT });
  ok('editing back to the original clears the edit', x.r.status === 'edited' && draft().editedText === null && draft().editedByJo === false);
  for (const reason of Object.keys(X.SKIP_REASONS)) {
    seed();
    x = await callD(OWNER, { oppId: 'ZZ1', action: 'skip', reason });
    ok('skip with reason ' + reason + ' marks it skipped with that reason', x.r.status === 'skipped' && draft().status === 'skipped' && draft().skipReason === reason && draft().skippedBy === NBD && !caps());
  }
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'skip', reason: 'too_far' });
  ok('a second skip is the idempotent already_skipped', x.r.status === 'already_skipped');
  for (const act of ['approve', 'edit', 'snooze']) {
    x = await callD(OWNER, { oppId: 'ZZ1', action: act, text: TEXT });
    ok('a skipped draft cannot be ' + act + 'd (not_pending), and stays skipped', x.r.code === 'not_pending' && draft().status === 'skipped' && !caps());
  }
  seed();
  await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  for (const [act, extra] of [['skip', { reason: 'too_far' }], ['snooze', {}], ['edit', { text: EDIT }]]) {
    const snap = JSON.stringify(draft());
    x = await callD(OWNER, Object.assign({ oppId: 'ZZ1', action: act }, extra));
    ok('an APPROVED draft cannot be ' + act + (act === 'skip' ? 'ped' : 'd') + ' (approved is final in this series)', x.r.code === 'not_pending' && JSON.stringify(draft()) === snap);
  }
  seed();
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'snooze' });
  ok('snooze hides a pending draft for one hour (snoozedUntil = now + 1h), status unchanged', x.r.status === 'snoozed' && draft().status === 'pending' && draft().snoozedUntil.getTime() === IN_HOURS + 3600000 && x.r.snoozedUntilMs === IN_HOURS + 3600000);
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  ok('a snoozed draft can still be approved (it is Jo\'s tap)', x.r.status === 'approved' && draft().snoozedUntil === null);
  seed({ [dk('ZZ1')]: DRAFT('ZZ1', { status: 'sent' }) });
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  ok('a draft in any other status (sent) cannot be approved', x.r.code === 'not_pending');
  seed({ [dk('ZZ1')]: DRAFT('ZZ1', { expireAt: new Date(IN_HOURS - 1000) }) });
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  ok('an expired draft cannot be approved', x.r.code === 'expired' && quiet());

  console.log('\n8. tenant isolation');
  seed({ [dk('ZZ1')]: DRAFT('ZZ1', { companyId: 'co-b' }) });
  x = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  ok('a draft whose companyId is another company: the generic not_found, nothing written', x.r.code === 'not_found' && x.r.message === Dec._internal.MESSAGES.not_found && quiet());
  seed({ 'opp_drafts/co-b_ZZ9': DRAFT('ZZ9', { companyId: 'co-b' }) });
  x = await callD(OWNER, { oppId: 'ZZ9', action: 'approve', text: TEXT });
  ok('another company\'s draft id is not reachable (doc id is built from the OWNER\'s company)', x.r.code === 'not_found' && quiet() && DB.reads.every((p) => !/co-b/.test(p)));
  seed({ [dk('ZZ1')]: null });
  const nf = await callD(OWNER, { oppId: 'ZZ1', action: 'approve', text: TEXT });
  ok('a missing draft and another company\'s draft give the SAME answer (no existence leak)', nf.r.code === 'not_found' && nf.r.message === x.r.message && nf.r.status === x.r.status);

  console.log('\n9. oppDraftList');
  seed({}, ['ZZ1', 'ZZ2', 'ZZ3', 'ZZ4', 'ZZ5']);
  DB.docs.set(sk('ZZ2'), SEEN('ZZ2', { score: 95, postedAgeMin: 3 }));
  DB.docs.set(sk('ZZ3'), SEEN('ZZ3', { score: 70, flags: ['photo_missing'] }));
  DB.docs.set(dk('ZZ4'), DRAFT('ZZ4', { status: 'skipped' }));
  DB.docs.set('opp_drafts/co-b_ZZ7', DRAFT('ZZ7', { companyId: 'co-b' }));
  DB.docs.set('opp_seen/co-b_ZZ7', SEEN('ZZ7', { companyId: 'co-b' }));
  await callD(OWNER, { oppId: 'ZZ5', action: 'approve', text: EDIT });
  await callD(OWNER, { oppId: 'ZZ3', action: 'snooze' });
  DB.writes.length = 0;
  x = await callL(OWNER);
  const cards = x.r.cards;
  ok('lists this company\'s pending and approved drafts only (not skipped, not another company\'s)', cards.map((c) => c.oppId).sort().join() === 'ZZ1,ZZ2,ZZ3,ZZ5', cards.map((c) => c.oppId).join());
  ok('pending cards come first by score, approved last', cards.map((c) => c.oppId).join() === 'ZZ2,ZZ1,ZZ3,ZZ5', cards.map((c) => c.oppId).join());
  const c2 = cards.filter((c) => c.oppId === 'ZZ2')[0];
  ok('a card carries category, place, miles, base, pros, photo count, score, reasons and the draft text', c2.category === 'Roof repair' && c2.city === 'Goshen' && c2.zip === '45122' && c2.milesNearestBase === 4.2 && c2.baseUsed === 'goshen' && c2.prosAlready === 1 && c2.photos === 2 && c2.score === 95 && c2.reasons.length === 2 && c2.text === TEXT);
  ok('age is the age when seen plus the time since (3 min + 5 min = 8)', c2.ageNowMin === 8, String(c2.ageNowMin));
  ok('a snoozed card says until when; the others do not', cards.filter((c) => c.oppId === 'ZZ3')[0].snoozedUntilMs === IN_HOURS + 3600000 && c2.snoozedUntilMs === null);
  const c5 = cards.filter((c) => c.oppId === 'ZZ5')[0];
  ok('an approved card shows the approved (edited) text, the original, and the send label', c5.status === 'approved' && c5.text === EDIT && c5.originalText === TEXT && c5.editedByJo === true && /8am to 8pm/.test(c5.sendLabel));
  ok('a card is a WHITELIST: no companyId, createdBy, approvedBy, expireAt or other raw field', cards.every((c) => !('companyId' in c) && !('createdBy' in c) && !('approvedBy' in c) && !('expireAt' in c) && !('filedBy' in c)), JSON.stringify(Object.keys(c2)));
  ok('the list carries the counts against the caps and the send-hours state', x.r.caps.approvedToday === 1 && x.r.caps.perDay === 8 && x.r.caps.perWeek === 25 && x.r.inSendHours === true && x.r.nowMs === IN_HOURS);
  ok('the list writes nothing', quiet());
  seed(); CLOCK = OUT_HOURS;
  x = await callL(OWNER);
  ok('outside the hours the list says so and carries "will send 8am"', x.r.inSendHours === false && x.r.sendLabel === 'will send 8am');
  seed({ [sk('ZZ1')]: null });
  x = await callL(OWNER);
  ok('a draft whose opp_seen record is gone still lists (blank facts, the text)', x.r.cards.length === 1 && x.r.cards[0].text === TEXT && x.r.cards[0].category === '');
  seed(); DB.failPaths.add(sk('ZZ1'));
  x = await callL(OWNER);
  ok('an unreadable opp_seen -> unavailable (fail closed)', x.err && x.err.code === 'unavailable');
  seed({ [CAPS]: { companyId: NBD, dayKey: 'garbage', dayCount: 'x', weekKey: 7, weekCount: null } });
  x = await callL(OWNER);
  ok('a corrupt counter lists as unknown (null), never as a fake zero: a stale day key is 0, a non-string week key is null', x.r.caps.approvedToday === 0 && x.r.caps.approvedThisWeek === null, JSON.stringify(x.r.caps));

  console.log('\n10. no sender, and wiring');
  const files = ['functions/opp-decide.js', 'functions/opp-decide-logic.js'];
  const src = files.map((f) => strip(read(f))).join('\n');
  ok('the source has no fetch / http / sms / email / agent_inbox / lead write / sender / create / delete', !/\b(fetch|https?\.request|axios|twilio|sendgrid|resend|sendSms|sendEmail|sendMessage)\b|agent_inbox|sms_log|collection\(\s*['"]leads|\.create\(|\.delete\(/.test(src));
  ok('the reserved send flag is never read (no thumbtackOppSend / SEND_FLAG_NAME)', !/thumbtackOppSend|SEND_FLAG/.test(src));
  ok('the source names no Thumbtack host', !/thumbtack\.com/i.test(src));
  ok('the status is only ever set to approved / skipped (never sent / failed)', !/status:\s*'(sent|failed)'/.test(src) && /status: 'approved'/.test(src) && /status: 'skipped'/.test(src));
  ok('there is no approve-all path: the handler takes exactly one oppId', !/approveAll|approve_all|for \(const .* of .*oppIds/.test(src));
  const code = read('functions/opp-decide.js');
  ok('both callables: enforceAppCheck true and the tenant-guard wrapper', (code.match(/enforceAppCheck: true/g) || []).length === 1 && /OPTS = \{[^}]*enforceAppCheck: true/.test(code) && /wrapCallable\(oppDraftDecide\)/.test(code) && /wrapCallable\(oppDraftList\)/.test(code));
  ok('the text gate is the PR 3 draftProblem, with no second copy of the refuser', /D\.draftProblem\(text\)/.test(strip(read('functions/opp-decide-logic.js'))) && !/phoneProblem\s*=|function phoneProblem/.test(src));
  const idx = read('functions/index.js');
  ok('exported from index.js', /exports\.oppDraftList = oppDecide\.oppDraftList;/.test(idx) && /exports\.oppDraftDecide = oppDecide\.oppDraftDecide;/.test(idx));
  const map = JSON.parse(read('functions/function-map.json'));
  ok('in function-map.json', map.oppDraftDecide === './opp-decide' && map.oppDraftList === './opp-decide');
  const fi = read('functions/FUNCTIONS_INDEX.md');
  ok('listed in FUNCTIONS_INDEX.md as onCall', /\| `oppDraftList` \| onCall \|/.test(fi) && /\| `oppDraftDecide` \| onCall \|/.test(fi));
  const rules = read('firestore.rules');
  ok('firestore.rules denies opp_drafts and opp_caps to every client', /match \/opp_drafts\/\{docId\} \{\s*allow read, write: if false;\s*\}/.test(rules) && /match \/opp_caps\/\{docId\} \{\s*allow read, write: if false;\s*\}/.test(rules));
  ok('classified in the viewer-callables sweep', /oppDraftList: 'role-gated'/.test(read('tests/viewer-callables.test.js')) && /oppDraftDecide: 'role-gated'/.test(read('tests/viewer-callables.test.js')));
  const manifest = read('tests/ci-manifest.json');
  ok('the three PR 4 test files are in the manifest', ['opp-decide-2026-11-04.test.js', 'opp-decide-callable-2026-11-04.test.js', 'opp-approval-ui-2026-11-04.test.js'].every((f) => manifest.includes('"' + f + '"')));
  ok('the doc note names both callables, the caps and opp_caps', (() => { const t = read('documentation/projects/THUMBTACK-OPPORTUNITIES-2026-11-04.md'); return /oppDraftDecide/.test(t) && /oppDraftList/.test(t) && /opp_caps/.test(t) && /8 approved/.test(t); })());

  Date.now = realNow;
  global.fetch = realFetch;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
