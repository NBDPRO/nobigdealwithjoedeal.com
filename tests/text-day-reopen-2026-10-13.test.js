/**
 * tests/text-day-reopen-2026-10-13.test.js — QA finding H1 (never-forget sweep).
 *
 * A text day Jo marked Handled used to swallow every later text from that
 * number the same day: runTextNotes re-wrote the doc (new sig, new notes) but
 * merged over handledAtMs, so Home / callWatch / the ledger never saw the new
 * text. A NEW INBOUND text after the handled stamp re-opens the day. Jo's own
 * reply, a text that predates the stamp, and send-status rows (failed / queued
 * / outbox / draft) must not.
 *
 * The model is stubbed; Firestore is in-memory; numbers are invented (555).
 * Run: node tests/text-day-reopen-2026-10-13.test.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'functions', 'text-inbox-logic.js'));
const TI = require(path.join(ROOT, 'functions', 'text-inbox.js'));
const W = require(path.join(ROOT, 'functions', 'call-watch-logic.js'));
const HA = require(path.join(ROOT, 'docs', 'pro', 'js', 'home-attention.js'));
const { runTextNotes, setNotes, OWNER, DAYS, COLLECTION } = TI._test;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const H = 3600e3;
const NOW = Date.parse('2026-10-13T22:00:00Z'); // 18:00 ET
const DIGITS = '5135550123';
const DAY_ID = 'txt_' + DIGITS + '_20261013';
const txt = (id, hoursAgo, dir, body, extra) => Object.assign({
  id, userId: OWNER, companyId: OWNER, phoneDigits: DIGITS, sentAtMs: NOW - hoursAgo * H,
  direction: dir, body, contactName: '', leadId: null, group: false,
}, extra);

function fakeDb(seed) {
  const docs = new Map(Object.entries(seed || {}));
  const mk = (p) => ({
    id: p.split('/').pop(),
    get: async () => ({ exists: docs.has(p), id: p.split('/').pop(), data: () => docs.get(p) }),
    set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
    create: async (v) => { if (docs.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } docs.set(p, v); },
  });
  const query = (name, filters, lim) => ({
    where: (f, op, v) => query(name, filters.concat([[f, op, v]]), lim),
    orderBy: () => query(name, filters, lim),
    limit: (n) => query(name, filters, n),
    get: async () => {
      const rows = [...docs.entries()].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === 2 &&
        filters.every(([f, op, val]) => (op === '>=' ? v[f] >= val : v[f] === val)))
        .sort((a, b) => (b[1].sentAtMs || 0) - (a[1].sentAtMs || 0)).slice(0, lim || 1e9);
      return { forEach: (fn) => rows.forEach(([k, v]) => fn({ id: k.split('/')[1], data: () => v })) };
    },
  });
  return { docs, doc: mk, collection: (n) => Object.assign(query(n, [], null), { doc: (id) => mk(n + '/' + id) }), getAll: async (...r) => Promise.all(r.map((x) => x.get())) };
}

const QUIET = { call_type: 'other', summary: 'Unknown number asked about a roof.', promises: [], follow_up_date: null, urgent: false };
const URGENT = { call_type: 'customer', summary: 'Water coming through the ceiling.', promises: [], follow_up_date: null, urgent: true };

// Seed: one morning exchange, noted, then Jo hit Handled at `handledHoursAgo`.
async function handledDayDb(msgs, handledHoursAgo) {
  const db = fakeDb(Object.fromEntries(msgs.map((m) => [COLLECTION + '/' + m.id, m])));
  setNotes(async () => QUIET);
  await runTextNotes({ db, live: true, nowMs: NOW - 8 * H });
  const d = db.docs.get(DAYS + '/' + DAY_ID);
  db.docs.set(DAYS + '/' + DAY_ID, Object.assign({}, d, { handledAtMs: NOW - handledHoursAgo * H, handledBy: 'uid_jo' }));
  return db;
}
const morning = () => [txt('m1', 12, 'inbound', 'hi do you do roofs?'), txt('m2', 11.5, 'outbound', 'Yes, I can look at it.')];

(async () => {
  console.log('\n1. a NEW inbound text re-opens a handled day');
  let db = await handledDayDb(morning(), 10);
  ok('control: the handled stamp is in place before the new text', db.docs.get(DAYS + '/' + DAY_ID).handledAtMs === NOW - 10 * H);
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'inbound', 'water is coming through the ceiling!'));
  setNotes(async () => URGENT);
  let r = await runTextNotes({ db, live: true, nowMs: NOW });
  let day = db.docs.get(DAYS + '/' + DAY_ID);
  ok('the day was re-noted with the new text', r.noted === 1 && day.urgent === true && day.messageCount === 3, JSON.stringify(r));
  ok('handledAtMs is cleared (the row is eligible again)', day.handledAtMs == null, JSON.stringify(day.handledAtMs));
  ok('handledBy is cleared with it', day.handledBy == null);
  ok('the re-open is stamped for the audit trail', typeof day.reopenedAtMs === 'number' && day.reopenedAtMs === NOW);
  const row = Object.assign({}, day, { id: DAY_ID });
  ok('callWatch rule: needs Jo again, reason = urgent', W.callNeedsYou(row, NOW) === true && W.reasonFor(row, NOW) === 'urgent');
  ok('Home rule agrees (same field, same answer)', HA.callNeedsYou(row, NOW) === true);

  console.log('\n2. the reason is the NEW note, not the old one');
  db = await handledDayDb(morning(), 10);
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'inbound', 'ok sounds good'));
  setNotes(async () => QUIET);
  await runTextNotes({ db, live: true, nowMs: NOW });
  day = db.docs.get(DAYS + '/' + DAY_ID);
  ok('a quiet follow-up text re-opens as the unknown-number reason (not urgent)', day.handledAtMs == null && W.reasonFor(day, NOW) === 'unknown number, no customer on file' && day.urgent === false);
  const cust = fakeDb(Object.fromEntries(morning().map((m) => [COLLECTION + '/' + m.id, Object.assign({}, m, { leadId: 'L1', contactName: 'Pat Example' })])));
  cust.docs.set('leads/L1', { firstName: 'Pat', userId: OWNER });
  setNotes(async () => Object.assign({}, QUIET, { call_type: 'customer' }));
  await runTextNotes({ db: cust, live: true, nowMs: NOW - 8 * H });
  cust.docs.set(DAYS + '/' + DAY_ID, Object.assign({}, cust.docs.get(DAYS + '/' + DAY_ID), { handledAtMs: NOW - 10 * H, handledBy: 'uid_jo' }));
  cust.docs.set(COLLECTION + '/m3', txt('m3', 5, 'inbound', 'thanks!', { leadId: 'L1', contactName: 'Pat Example' }));
  await runTextNotes({ db: cust, live: true, nowMs: NOW });
  day = cust.docs.get(DAYS + '/' + DAY_ID);
  ok('a filed customer saying "thanks" clears the stamp but the rule keeps them off the list (no noise)', day.handledAtMs == null && W.callNeedsYou(day, NOW) === false, JSON.stringify(day));

  console.log('\n3. what must NOT re-open it');
  db = await handledDayDb(morning(), 10);
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'outbound', 'Following up - can I come Thursday?'));
  setNotes(async () => URGENT);
  r = await runTextNotes({ db, live: true, nowMs: NOW });
  day = db.docs.get(DAYS + '/' + DAY_ID);
  ok('Jo\'s own outbound reply re-notes the day but stays handled', r.noted === 1 && day.messageCount === 3 && day.handledAtMs === NOW - 10 * H && day.reopenedAtMs === undefined, JSON.stringify(day));
  ok('...and the rule keeps it off the list', W.callNeedsYou(Object.assign({}, day, { id: DAY_ID }), NOW) === false);

  db = await handledDayDb([txt('m1', 12, 'inbound', 'hi'), txt('m2', 9, 'inbound', 'anyone there?')], 6);
  // sig changes only because Jo's reply landed after he marked it handled
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'outbound', 'Sorry, called you back.'));
  setNotes(async () => URGENT);
  await runTextNotes({ db, live: true, nowMs: NOW });
  day = db.docs.get(DAYS + '/' + DAY_ID);
  ok('an inbound text that predates the handled stamp does not re-open it (Jo had seen it)', day.handledAtMs === NOW - 6 * H);

  // send-status rows: failed(5)/queued(6)/outbox(4)/draft(3) never become phone_texts.
  const xml = '<smses count="4">' + [3, 4, 5, 6].map((t, i) => '<sms protocol="0" address="+1' + DIGITS + '" date="' + (NOW - (4 - i) * H) + '" type="' + t + '" body="status echo ' + t + '" contact_name="(Unknown)" />').join('') + '</smses>';
  const parsed = T.parseSmsBackup(xml, {});
  const n = (parsed.messages || parsed.texts || []).length;
  ok('control: the parser really reads rows (a received text parses)', (T.parseSmsBackup('<smses count="1"><sms protocol="0" address="+1' + DIGITS + '" date="' + NOW + '" type="1" body="hello" contact_name="(Unknown)" /></smses>', {}).messages || []).length === 1);
  ok('draft / outbox / failed / queued rows are dropped at ingest (no echo can re-open a day)', n === 0, JSON.stringify(Object.keys(parsed)));

  console.log('\n4. the pure helper');
  const prev = { handledAtMs: 1000, handledBy: 'u' };
  const msgs = (arr) => ({ messages: arr.map(([dir, at]) => ({ direction: dir, sentAtMs: at })) });
  ok('reopenPatch: inbound after the stamp -> clears', !!T.reopenPatch && T.reopenPatch(prev, msgs([['inbound', 900], ['inbound', 1500]]), 2000).handledAtMs === null);
  ok('reopenPatch: only outbound after the stamp -> null', T.reopenPatch(prev, msgs([['inbound', 900], ['outbound', 1500]]), 2000) === null);
  ok('reopenPatch: inbound at exactly the stamp -> null (not strictly after)', T.reopenPatch(prev, msgs([['inbound', 1000]]), 2000) === null);
  ok('reopenPatch: never handled -> null', T.reopenPatch({}, msgs([['inbound', 1500]]), 2000) === null && T.reopenPatch(null, msgs([['inbound', 1500]]), 2000) === null);

  console.log('\n5. one person, counted once');
  db = await handledDayDb(morning(), 10);
  db.docs.set(COLLECTION + '/m3', txt('m3', 5, 'inbound', 'water is coming through the ceiling!'));
  setNotes(async () => URGENT);
  await runTextNotes({ db, live: true, nowMs: NOW });
  const reopened = Object.assign({ id: DAY_ID }, db.docs.get(DAYS + '/' + DAY_ID));
  const call = { id: 'cube_x', phoneDigits: DIGITS, status: 'noted', callType: 'lead', urgent: true, startedAtMs: NOW - 2 * H, direction: 'inbound', bucket: 'unknown' };
  const ledger = W.dailyLedger([call], [reopened], NOW, {});
  ok('the same number as an open call AND an open text day is ONE person in the ledger', ledger.open === 1, JSON.stringify(ledger.title));
  ok('and one row on Home', HA.callersNeedingYou([call, Object.assign({}, reopened, { channel: 'text' })], NOW) === 1);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
