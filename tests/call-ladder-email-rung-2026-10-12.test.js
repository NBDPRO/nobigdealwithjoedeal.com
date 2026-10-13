#!/usr/bin/env node
/**
 * The ladder's email rung (2026-10-12): the THIRD tell of an item still open
 * also emails Jo (internal only). Never earlier, never twice, never to anyone
 * else; a failed send is recorded and never blocks the run.
 * Run: node tests/call-ladder-email-rung-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const H = 3600000, MIN = 60000;
const T0 = Date.parse('2026-10-02T14:00:00Z'); // 10 AM ET

(async () => {
  console.log('A. ladderEmail (pure)');
  ok('nothing on its last rung -> no email', W.ladderEmail([{ id: 'call:a', rung: 2, who: 'Maria', why: 'urgent - still open (reminder 1)' }], T0) === null && W.ladderEmail([], T0) === null);
  const m = W.ladderEmail([
    { id: 'call:a', key: 'lead:L1', rung: 3, who: 'Maria <b>', why: 'urgent — still open (reminder 2)' },
    { id: 'call:b', key: 'lead:L1', rung: 3, who: 'Maria <b>', why: 'you promised something — still open (reminder 2)' },
    { id: 'call:c', key: 'num:5135550100', rung: 3, who: 'Bob', why: 'follow-up due — still open (reminder 2)' },
    { id: 'call:d', key: 'lead:L9', rung: 2, who: 'Early', why: 'urgent' },
  ], T0);
  ok('one line per PERSON (two calls from one customer = one), only last-rung items', m && m.people === 2 && !/Early/.test(m.text), JSON.stringify(m));
  ok('subject counts people; links to the Call Center', /Still open: 2 people/.test(m.subject) && /#\/calls/.test(m.text) && /#\/calls/.test(m.html));
  ok('html is escaped (a caller name cannot inject markup)', !/<b>/.test(m.html) && /&lt;b&gt;/.test(m.html));

  console.log('B. through runWatch (fake Firestore, injected email)');
  process.env.CALL_CENTER_INGEST_ENABLED = 'false'; process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'false';
  const { runWatch } = require(path.join(ROOT, 'functions/call-watch.js'))._internal;
  function mk(rows) {
    const docs = { 'integrations/callWatch': { lastCheckAtMs: T0 - 2 * H } };
    const snap = (r) => ({ docs: r.map((x) => ({ id: x.id, data: () => x })) });
    const q = (r) => { const o = { where: () => o, orderBy: () => o, limit: () => o, get: async () => snap(r) }; return o; };
    return {
      docs,
      collection(n) { if (n === 'phone_calls') return q(this.rows); if (n === 'notifications') return { add: async () => {} }; return q([]); },
      doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = v; } }),
      getAll: async (...r) => r.map(() => ({ exists: false, data: () => null })),
      rows,
    };
  }
  const row = { id: 'ux', userId: 'x', urgent: true, contactName: 'Maria', startedAtMs: T0 - 5 * MIN, createdAtMs: T0 - 5 * MIN, status: 'noted' };
  const db = mk([row]);
  const mails = [];
  const push = async () => ({ sent: 1 });
  const email = async (m) => { mails.push(m); };
  await runWatch({ db, nowMs: T0, live: true, push, email });
  await runWatch({ db, nowMs: T0 + 2 * H, live: true, push, email });
  ok('first and second tell: no email', mails.length === 0);
  await runWatch({ db, nowMs: T0 + 4 * H, live: true, push, email });
  ok('third tell: ONE email, and the run records it', mails.length === 1 && /Still open: 1 person/.test(mails[0].subject) && db.docs['integrations/callWatch'].lastEmail.ok === true);
  await runWatch({ db, nowMs: T0 + 6 * H, live: true, push, email });
  ok('ladder exhausted: no second email', mails.length === 1);

  const db2 = mk([row]);
  await runWatch({ db: db2, nowMs: T0, live: true, push, email });
  await runWatch({ db: db2, nowMs: T0 + 2 * H, live: true, push, email });
  let threw = null;
  try { await runWatch({ db: db2, nowMs: T0 + 4 * H, live: true, push, email: async () => { throw new Error('resend: key revoked'); } }); } catch (e) { threw = e; }
  ok('a failed send does not fail the run, and is recorded', !threw && db2.docs['integrations/callWatch'].lastEmail.ok === false && /key revoked/.test(db2.docs['integrations/callWatch'].lastEmail.error));
  const db3 = mk([Object.assign({}, row)]);
  await runWatch({ db: db3, nowMs: T0, live: true, push, email });
  db3.rows = [Object.assign({}, row, { handledAtMs: T0 + H })];
  const before = mails.length;
  await runWatch({ db: db3, nowMs: T0 + 4 * H, live: true, push, email });
  ok('handled before the third tell -> no email', mails.length === before);

  console.log('C. wiring (source)');
  const src = fs.readFileSync(path.join(ROOT, 'functions/call-watch.js'), 'utf8').replace(/\r\n/g, '\n');
  ok('only to the owner address on users/{owner}, INTERNAL, rejection checked', /doc\('users\/' \+ OWNER\)/.test(src) && /INTERNAL/.test(src) && /resendRejected\(resp\)/.test(src));
  ok('Resend secrets bound on the schedule like callCenterSweep', /secrets: \[TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, RESEND_API_KEY, EMAIL_FROM\]/.test(src));
  ok('no real-send path in the test (injected email only)', !/delivered@resend\.dev/.test(src));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
