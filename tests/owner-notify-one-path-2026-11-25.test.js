#!/usr/bin/env node
/**
 * owner-notify one path (roadmap step 13, 2026-11-25; audit
 * BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22 §2.8 / §3.7 / §3.9).
 *
 * Failures reached no one: stall alerts sat in a log, perf-watch was red for
 * three weeks, copycat-watch flagged our own repo after the org move. This
 * pins, by running the code:
 *  A. notifyOwner texts ONLY for alert / critical (info = bell + push)
 *  B. a daily text cap (default 4, env OWNER_ALERT_SMS_PER_DAY) + dedupe by
 *     key; over the cap one "more alerts in the app" text, then bell only
 *  C. quiet hours: an alert at night is queued and ONE summary goes at 07:00;
 *     critical is texted at any hour
 *  D. the owner's internal-alert switch off = no text (bell + push still)
 *  E. no owner phone = bell only, logged
 *  F. the routed callers hand notifyOwner a severity: cronDeadman (run + the
 *     real handler), pipeline-deadman, the health digest
 *  G. copycat-watch: our own repo / org is never a match
 *  H. the "Scheduled checks failing" issue opens, updates and closes
 *
 * Pure Node (in-memory Firestore, Twilio and push stand-ins; no network).
 * Run: node tests/owner-notify-one-path-2026-11-25.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const MIN = 60000, H = 3600000, DAY = 24 * H;
// November 2026 is EST (UTC-5).
const et = (ymd, hhmm) => Date.parse(ymd + 'T' + hhmm + ':00-05:00');

// push-functions.js needs a Firebase app at load; stand in for it.
const pfPath = require.resolve(path.join(FN, 'push-functions.js'));
const pf = { sendCustomNotification: async () => ({ sent: 1 }) };
require.cache[pfPath] = { id: pfPath, filename: pfPath, loaded: true, exports: pf };

const MC = require(path.join(FN, 'messaging-controls.js'));
const ON = require(path.join(FN, 'owner-notify.js'));
const texts = [];
let twilioDown = false;
const logs = [];
ON._overrides.twilio = () => ({ messages: { create: async (m) => { if (twilioDown) throw new Error('twilio 500'); texts.push(m); return { sid: 'SM' + texts.length }; } } });
ON._overrides.logger = { info() {}, warn: (m, d) => logs.push(['warn', m, d]), error: (m, d) => logs.push(['error', m, d]) };
// Fake Twilio config, built at runtime (never a real value).
process.env.TWILIO_ACCOUNT_SID = 'AC' + 'test0000';
process.env.TWILIO_AUTH_TOKEN = 'tok' + 'test';
process.env.TWILIO_PHONE_NUMBER = '+1513555' + '0100';
delete process.env.OWNER_ALERT_PHONE;
delete process.env.OWNER_ALERT_SMS_PER_DAY;
const OWNER_PHONE = '+1513555' + '0199';

/** In-memory Firestore: docs, bell rows, transactions (the guard's counters and the text ledger). */
function fakeDb(seed) {
  const docs = JSON.parse(JSON.stringify(seed || {}));
  const bell = [];
  const snap = (p) => ({ exists: p in docs, data: () => (p in docs ? JSON.parse(JSON.stringify(docs[p])) : undefined) });
  const put = (p, v, o) => { const c = JSON.parse(JSON.stringify(v)); docs[p] = o && o.merge ? Object.assign({}, docs[p] || {}, c) : c; };
  return {
    docs, bell,
    doc: (p) => ({ path: p, get: async () => snap(p), set: async (v, o) => put(p, v, o) }),
    collection: (c) => ({ add: async (v) => { bell.push(Object.assign({ collection: c }, v)); return { id: 'n' + bell.length }; } }),
    runTransaction: async (fn) => fn({ get: async (r) => snap(r.path), set: (r, v, o) => put(r.path, v, o) }),
  };
}
const ownerDoc = (extra) => ({ 'messaging_controls/internal': Object.assign({ ownerPhone: OWNER_PHONE }, extra || {}) });
const fresh = (seed) => { MC._resetCache(); texts.length = 0; logs.length = 0; return fakeDb(seed === undefined ? ownerDoc() : seed); };
const say = (db, severity, key, nowMs, title) => ON.notifyOwner(db, { title: title || ('⚠ ' + key + ' is down'), body: key + ': last run failed\nmore detail', severity, key, nowMs });

(async () => {
  console.log('A. a text only for alert / critical');
  {
    const db = fresh();
    const now = et('2026-11-23', '10:00');
    const a = await say(db, 'info', 'k-info', now);
    ok('info: bell + push, no text', a.pushed === true && a.sms === 'none' && texts.length === 0 && db.bell.length === 1, JSON.stringify(a));
    const b = await say(db, 'alert', 'k-alert', now);
    ok('alert (daytime): one text to the configured owner phone, from the Twilio number', b.sms === 'sent' && texts.length === 1 && texts[0].to === OWNER_PHONE && texts[0].from === process.env.TWILIO_PHONE_NUMBER, JSON.stringify([b, texts]));
    ok('…short and plain: names the title, points at the CRM bell, no emoji', texts[0].body.length <= 260 && /k-alert is down/.test(texts[0].body) && /CRM bell/.test(texts[0].body) && !/[^\x20-\x7E]/.test(texts[0].body), texts[0].body);
    const c = await say(db, 'critical', 'k-crit', now);
    ok('critical: texted too, marked urgent', c.sms === 'sent' && texts.length === 2 && /^URGENT/.test(texts[1].body), JSON.stringify(c));
    const d = await say(db, 'bogus', 'k-bogus', now);
    ok('an unknown severity is treated as info (no text)', d.sms === 'none' && texts.length === 2);
    ok('every call wrote its bell row with the severity', db.bell.length === 4 && db.bell[1].severity === 'alert' && db.bell[0].severity === 'info');
    twilioDown = true;
    const e = await say(db, 'alert', 'k-down', now);
    twilioDown = false;
    ok('a Twilio failure never rejects: the bell + push still stand', e.pushed === true && e.sms === 'failed:send', JSON.stringify(e));
  }

  console.log('B. daily cap + dedupe by key');
  {
    const db = fresh();
    const now = et('2026-11-23', '11:00');
    const r = [];
    for (let i = 1; i <= 6; i++) r.push((await say(db, 'alert', 'job' + i, now + i * MIN)).sms);
    ok('4 distinct alerts -> 4 texts, the 5th -> one "more alerts in the app" text, the 6th -> bell only',
      r.join() === 'sent,sent,sent,sent,sent_overflow,capped' && texts.length === 5 && /More system alerts today/.test(texts[4].body) && /capped at 4/.test(texts[4].body), r.join() + ' ' + texts.length);
    ok('…all 6 are in the bell', db.bell.length === 6);
    const db2 = fresh();
    const x = await say(db2, 'alert', 'same-key', now);
    const y = await say(db2, 'critical', 'same-key', now + 5 * MIN);
    ok('the same key twice in a day -> one text (the second is bell only)', x.sms === 'sent' && y.sms === 'dup' && texts.length === 1 && db2.bell.length === 2, JSON.stringify([x, y]));
    const z = await say(db2, 'alert', 'same-key', et('2026-11-24', '10:00'));
    ok('…a new ET day resets the cap and the dedupe', z.sms === 'sent' && texts.length === 2, JSON.stringify(z));
    process.env.OWNER_ALERT_SMS_PER_DAY = '1';
    const db3 = fresh();
    const p = [(await say(db3, 'alert', 'a', now)).sms, (await say(db3, 'alert', 'b', now)).sms, (await say(db3, 'alert', 'c', now)).sms];
    process.env.OWNER_ALERT_SMS_PER_DAY = '0';
    const db4 = fresh();
    const q = (await say(db4, 'critical', 'a', now)).sms;
    delete process.env.OWNER_ALERT_SMS_PER_DAY;
    ok('the cap is config: OWNER_ALERT_SMS_PER_DAY=1 -> 1 + the overflow text; =0 -> no text at all', p.join() === 'sent,sent_overflow,capped' && q === 'capped', p.join() + ' / ' + q);
  }

  console.log('C. quiet hours: queued at night, one 07:00 summary; critical at any hour');
  {
    const db = fresh();
    const a = await say(db, 'alert', 'perf', et('2026-11-23', '02:00'));
    const a2 = await say(db, 'alert', 'perf', et('2026-11-23', '03:00'));
    const b = await say(db, 'alert', 'link', et('2026-11-23', '04:00'));
    ok('02:00 / 04:00 alerts: queued, no text, but the bell + push go now', a.sms === 'queued' && b.sms === 'queued' && texts.length === 0 && db.bell.length === 3 && a.pushed, JSON.stringify([a, b]));
    ok('…the same key queued twice is one queue entry', a2.sms === 'dup' && db.docs['system/ownerNotify'].queue.length === 2, JSON.stringify(db.docs['system/ownerNotify']));
    const c = await say(db, 'critical', 'ingest', et('2026-11-23', '02:30'));
    ok('a critical alert at 02:30 is texted at once', c.sms === 'sent' && texts.length === 1 && /^URGENT/.test(texts[0].body), JSON.stringify(c));
    const f0 = await ON.flushOwnerQueue(db, { nowMs: et('2026-11-23', '06:30') });
    ok('06:30 flush: still night, nothing sent', f0.sms === 'none' && texts.length === 1, JSON.stringify(f0));
    const f1 = await ON.flushOwnerQueue(db, { nowMs: et('2026-11-23', '07:05') });
    ok('07:05 flush: ONE summary text naming both queued alerts', f1.sms === 'sent' && texts.length === 2 && /Overnight: 2 system alerts/.test(texts[1].body) && /perf/.test(texts[1].body) && /link/.test(texts[1].body), JSON.stringify(f1) + ' ' + (texts[1] && texts[1].body));
    const f2 = await ON.flushOwnerQueue(db, { nowMs: et('2026-11-23', '07:35') });
    ok('07:35 flush: nothing left, nothing sent', f2.sms === 'none' && texts.length === 2, JSON.stringify(f2));
    const d = await say(db, 'alert', 'perf', et('2026-11-23', '09:00'));
    ok('a queued key that was in the summary is not texted again that day', d.sms === 'dup' && texts.length === 2, JSON.stringify(d));
    const e = await say(db, 'alert', 'late', et('2026-11-23', '21:30'));
    ok('21:30 is outside the window (07:00-21:00 ET, the cron-deadman rule): queued', e.sms === 'queued', JSON.stringify(e));
  }

  console.log('C2. a queue the flush never sent cannot silence a key');
  {
    const db = fresh();
    ok('03:00 alert queued', (await say(db, 'alert', 'email-queue', et('2026-11-25', '03:00'))).sms === 'queued');
    // No flush ran (guard held it, no Twilio secrets, the deadman in dry run…).
    const a = await say(db, 'alert', 'email-queue', et('2026-11-25', '11:00'));
    ok('same day 11:00, never flushed: the same key is texted now, not "dup"', a.sms === 'sent' && texts.length === 1, JSON.stringify(a));
    const f = await ON.flushOwnerQueue(db, { nowMs: et('2026-11-25', '11:30') });
    ok('…and it left the queue, so a later flush does not text it again', f.sms === 'none' && texts.length === 1, JSON.stringify(f));
    const db2 = fresh();
    await say(db2, 'alert', 'stale', et('2026-11-25', '03:00'));
    const o = await say(db2, 'alert', 'other', et('2026-11-28', '02:00'));
    const g = await ON.flushOwnerQueue(db2, { nowMs: et('2026-11-28', '07:05') });
    ok('a morning summary three days later never carries the days-old entry', o.sms === 'queued' && g.sms === 'sent' && texts.length === 1 && /Overnight: 1 system alert:/.test(texts[0].body) && !/stale/.test(texts[0].body), texts[0] && texts[0].body);
    const b = await say(db2, 'alert', 'stale', et('2026-11-28', '11:00'));
    ok('…and the old key is texted when it comes back (the queue entry expired)', b.sms === 'sent' && texts.length === 2, JSON.stringify(b));
    const db3 = fresh();
    await say(db3, 'alert', 'late', et('2026-11-24', '22:30'));
    const h = await ON.flushOwnerQueue(db3, { nowMs: et('2026-11-25', '07:05') });
    ok('(control) an alert queued before midnight is still in the next 07:00 summary', h.sms === 'sent' && texts.length === 1 && /late/.test(texts[0].body), JSON.stringify(h));
  }

  console.log('D. the owner\'s internal-alert switch is respected');
  {
    const db = fresh(ownerDoc({ internalAlertsEnabled: false }));
    const a = await say(db, 'critical', 'k', et('2026-11-23', '10:00'));
    ok('internal alerts off: no text, bell + push still', a.sms === 'skipped:internal_alerts_off' && texts.length === 0 && db.bell.length === 1 && a.pushed === true, JSON.stringify(a));
    db.docs['system/ownerNotify'] = { queue: [{ key: 'q', title: 'queued thing', atMs: et('2026-11-23', '02:00') }] };
    const f = await ON.flushOwnerQueue(db, { nowMs: et('2026-11-23', '07:05') });
    ok('…and the morning summary is held too', f.sms === 'skipped:internal_alerts_off' && texts.length === 0, JSON.stringify(f));
    const db2 = fresh(ownerDoc({ internalAlertsEnabled: true }));
    ok('(control) internal alerts on: texted', (await say(db2, 'critical', 'k', et('2026-11-23', '10:00'))).sms === 'sent' && texts.length === 1);
    // The chosen rule, pinned: the CUSTOMER kill switch (messaging_controls/global)
    // does not hold an owner system text; only the owner's internal switch does.
    const db3 = fresh(Object.assign(ownerDoc(), { 'messaging_controls/global': { customerSendsEnabled: false, smsEnabled: false, canary: true } }));
    const k = await say(db3, 'critical', 'k', et('2026-11-23', '10:00'));
    ok('customer kill switch off + internal alerts on: the owner text still goes (to the owner only)', k.sms === 'sent' && texts.length === 1 && texts[0].to === OWNER_PHONE, JSON.stringify(k));
    // Queued / duplicate alerts must not spend the internal hourly text allowance.
    process.env.INTERNAL_SMS_PER_HOUR = '1';
    const db4 = fresh();
    const q1 = await say(db4, 'alert', 'night-a', et('2026-11-23', '02:00'));
    const q2 = await say(db4, 'alert', 'night-b', et('2026-11-23', '02:10'));
    const c1 = await say(db4, 'critical', 'ingest', et('2026-11-23', '02:20'));
    delete process.env.INTERNAL_SMS_PER_HOUR;
    ok('two queued alerts do not use up the hourly cap: a critical in the same hour is texted', q1.sms === 'queued' && q2.sms === 'queued' && c1.sms === 'sent' && texts.length === 1, JSON.stringify([q1, q2, c1]));
    const db5 = fresh(ownerDoc({ internalAlertsEnabled: false }));
    await say(db5, 'alert', 'held', et('2026-11-23', '10:00'));
    db5.docs['messaging_controls/internal'].internalAlertsEnabled = true;
    MC._resetCache();
    const r5 = await say(db5, 'alert', 'held', et('2026-11-23', '11:00'));
    ok('a text held by the switch is not booked as sent: switched back on, the same key is texted', r5.sms === 'sent' && texts.length === 1, JSON.stringify(r5));
  }

  console.log('E. no owner phone -> bell only, logged');
  {
    const db = fresh({});
    const a = await say(db, 'critical', 'k', et('2026-11-23', '10:00'));
    ok('no phone configured: bell + push, no text', a.sms === 'skipped:owner_phone_not_configured' && texts.length === 0 && db.bell.length === 1, JSON.stringify(a));
    ok('…and it is logged, not silent', logs.some((l) => l[0] === 'warn' && /bell only/.test(l[1]) && l[2] && l[2].reason === 'owner_phone_not_configured'), JSON.stringify(logs));
    const saved = process.env.TWILIO_PHONE_NUMBER;
    delete process.env.TWILIO_PHONE_NUMBER;
    const db2 = fresh();
    const b = await say(db2, 'critical', 'k', et('2026-11-23', '10:00'));
    process.env.TWILIO_PHONE_NUMBER = saved;
    ok('a function without the Twilio secrets: bell only, logged', b.sms === 'skipped:twilio_not_configured' && texts.length === 0 && logs.some((l) => /Twilio not configured/.test(l[1])), JSON.stringify(b));
  }

  console.log('F. the routed callers hand notifyOwner a severity');
  {
    // cronDeadman.run(): the third send() argument.
    const R = require(path.join(FN, 'cron-deadman.js'));
    const hbMod = require(path.join(FN, 'integrations', 'heartbeat.js'));
    const cronDb = (jobs) => {
      const docs = { 'system/heartbeats': { startedAtMs: et('2026-11-01', '00:00') } };
      return {
        docs,
        doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = JSON.parse(JSON.stringify(v)); } }),
        collection: (c) => ({ add: async () => ({}), get: async () => { if (c !== hbMod.LEDGER_COLLECTION) throw new Error(c); const ds = Object.keys(jobs).map((id) => ({ id, data: () => jobs[id] })); return { docs: ds, forEach: (fn) => ds.forEach(fn) }; } }),
      };
    };
    const expected = ['callCenterTranscribe', 'callCenterIngest'];
    const okJob = (now) => ({ schedule: 'every 30 minutes', ok: true, lastOkAtMs: now - 10 * MIN });
    const badJob = (now) => ({ schedule: 'every 30 minutes', ok: false, error: 'boom', lastOkAtMs: now - 3 * H, finishedAtMs: now - MIN });
    const metas = [];
    const send = async (t, b, meta) => { metas.push(meta); return { pushed: true }; };
    let now = et('2026-11-23', '02:00');
    const jobs = { callCenterTranscribe: okJob(now), callCenterIngest: badJob(now) };
    const db = cronDb(jobs);
    await R.run({ db, nowMs: now, live: true, expected, send });
    ok('cronDeadman: a CRITICAL job (call ingest) down at 02:00 -> severity critical', metas.length === 1 && metas[0].severity === 'critical' && /callCenterIngest/.test(metas[0].key), JSON.stringify(metas));
    now = et('2026-11-23', '10:00');
    Object.assign(jobs, { callCenterIngest: okJob(now), callCenterTranscribe: badJob(now) });
    await R.run({ db, nowMs: now, live: true, expected, send });
    const last = metas[metas.length - 1];
    ok('…a non-critical job down in the daytime -> severity alert', last && last.severity === 'alert' && /callCenterTranscribe/.test(last.key), JSON.stringify(metas));
    now = et('2026-11-23', '10:30');
    Object.assign(jobs, { callCenterTranscribe: okJob(now) });
    await R.run({ db, nowMs: now, live: true, expected, send });
    ok('…a recovery-only message -> severity info (no text)', metas[metas.length - 1].severity === 'info', JSON.stringify(metas));

    // The real cronDeadman handler: it calls owner-notify's notifyOwner (with a
    // severity) and flushOwnerQueue.
    const Module = require('module');
    const file = require.resolve(path.join(FN, 'cron-deadman.js'));
    const saved = require.cache[file];
    const runCron = async (disabled) => {
      delete require.cache[file];
      const calls = [];
      if (disabled) process.env.CRON_DEADMAN_DISABLED = 'true'; else delete process.env.CRON_DEADMAN_DISABLED;
      const stubON = Object.assign({}, ON, {
        notifyOwner: async (dbx, msg) => { calls.push(['notify', msg]); return { pushed: true, sms: 'sent' }; },
        flushOwnerQueue: async () => { calls.push(['flush']); return { sms: 'none' }; },
      });
      const FA = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
      const hdb = cronDb({ callCenterIngest: badJob(Date.now()) });
      const realLoad = Module._load;
      Module._load = function (req, parent) {
        if (parent && parent.filename === file && req === './owner-notify') return stubON;
        if (parent && parent.filename === file && req === 'firebase-functions/v2') return { logger: { info() {}, warn() {}, error() {}, log() {} } };
        if (parent && parent.filename === file && req === 'firebase-admin/firestore') return Object.assign({}, FA, { getFirestore: () => hdb });
        return realLoad.apply(this, arguments);
      };
      hbMod._overrides.functionTarget = 'cronDeadman';
      hbMod._overrides.pingKey = '';
      hbMod._overrides.recordRun = async () => {};
      let threw = null;
      try {
        const CD = require(file);
        const ep = CD.cronDeadman;
        await (typeof ep.run === 'function' ? ep.run : ep)({ scheduleTime: new Date().toISOString() });
      } catch (e) { threw = e; }
      finally {
        Module._load = realLoad;
        if (saved) require.cache[file] = saved; else delete require.cache[file];
        hbMod._overrides.functionTarget = undefined; hbMod._overrides.pingKey = undefined; hbMod._overrides.recordRun = undefined;
      }
      delete process.env.CRON_DEADMAN_DISABLED;
      return { calls, threw };
    };
    const live = await runCron(false);
    const n = live.calls.find((c) => c[0] === 'notify');
    ok('the real cronDeadman handler sends through notifyOwner with severity critical (call ingest down)', n && n[1].severity === 'critical' && n[1].type === 'cron_watch' && /callCenterIngest/.test(n[1].body), JSON.stringify(live.calls) + ' ' + (live.threw && live.threw.message));
    ok('…and flushes the overnight text queue every run', live.calls.some((c) => c[0] === 'flush'), JSON.stringify(live.calls));
    const dry = await runCron(true);
    ok('…even in dry run (CRON_DEADMAN_DISABLED=true): the queue belongs to owner-notify, not the deadman', dry.calls.some((c) => c[0] === 'flush') && !dry.calls.some((c) => c[0] === 'notify'), JSON.stringify(dry.calls));

    // pipeline-deadman: the third notify() argument.
    const D = require(path.join(FN, 'pipeline-deadman.js'));
    const etOct = (hhmm) => Date.parse('2026-10-02T' + hhmm + ':00-04:00');
    const pdb = (docs) => ({ docs, doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = v; } }), collection: () => ({}) });
    const env = { CALL_WATCH_ENABLED: 'true', CALL_CENTER_INGEST_ENABLED: 'true', CALL_CENTER_TRANSCRIBE_ENABLED: 'true' };
    const pm = [];
    await D.run({ db: pdb({ 'integrations/callWatch': { lastCheckAtMs: etOct('10:00') + 1000 }, 'integrations/callCenter': { lastRunAtMs: etOct('07:00'), lastTranscribeAtMs: etOct('10:20') } }), nowMs: etOct('10:40'), live: true, env, notify: async (t, b, meta) => { pm.push(meta); } });
    ok('pipeline-deadman: call recordings not copied -> severity critical, keyed by problem', pm.length === 1 && pm[0].severity === 'critical' && pm[0].key === 'pipeline-deadman:ingest_not_running', JSON.stringify(pm));
    await D.run({ db: pdb({ 'integrations/callWatch': { lastCheckAtMs: etOct('10:00') + 1000 }, 'integrations/callCenter': { lastRunAtMs: etOct('10:20'), lastTranscribeAtMs: etOct('10:20') }, 'integrations/pipelineHealth': { canary: { ymd: '2026-10-02', ok: false, failed: ['home read nothing'] } } }), nowMs: etOct('10:40'), live: true, env, notify: async (t, b, meta) => { pm.push(meta); } });
    ok('…a failed self-test only (jobs running) -> severity alert', pm.length === 2 && pm[1].severity === 'alert', JSON.stringify(pm));
    // A dead call / text pipeline is told at ANY hour (step 11 rule); owner-notify owns the quiet hours.
    const night = [];
    const nightDocs = { 'integrations/callWatch': { lastCheckAtMs: etOct('20:00') + 1000 }, 'integrations/callCenter': { lastRunAtMs: etOct('23:00'), lastTranscribeAtMs: etOct('23:00') }, 'integrations/pipelineHealth': { canary: { ymd: '2026-10-03', ok: false, failed: ['home read nothing'] } } };
    const nightNow = Date.parse('2026-10-03T02:00:00-04:00');
    const nr = await D.run({ db: pdb(nightDocs), nowMs: nightNow, live: true, env, notify: async (t, b, meta) => { night.push([meta, b]); } });
    ok('pipeline-deadman at 02:00 ET: ingest + transcribe stopped -> told now, severity critical', night.length === 1 && night[0][0].severity === 'critical' && /ingest_not_running/.test(night[0][0].key) && /transcribe_not_running/.test(night[0][0].key), JSON.stringify(night));
    ok('…only the dead-pipeline lines go at night; the self-test line waits for the day (not marked told)', !/self-test/.test(night[0] ? night[0][1] : '') && !nr.told.includes('canary_failed') && nr.told.includes('ingest_not_running'), JSON.stringify(nr));
    const quiet = [];
    await D.run({ db: pdb({ 'integrations/callWatch': { lastCheckAtMs: etOct('20:00') + 1000 }, 'integrations/callCenter': { lastRunAtMs: nightNow - 10 * MIN, lastTranscribeAtMs: nightNow - 10 * MIN }, 'integrations/pipelineHealth': { canary: { ymd: '2026-10-03', ok: false, failed: ['x'] } } }), nowMs: nightNow, live: true, env, notify: async (t, b, meta) => { quiet.push(meta); } });
    ok('(control) at 02:00 a self-test failure alone is not pushed at night', quiet.length === 0, JSON.stringify(quiet));

    // backup-freshness ("Firestore backup has NOT run") goes through notifyOwner too.
    {
      const bfFile = require.resolve(path.join(FN, 'backup-freshness.js'));
      const bfSaved = require.cache[bfFile];
      delete require.cache[bfFile];
      const bcalls = [];
      const emails = [];
      const stubON2 = Object.assign({}, ON, { notifyOwner: async (dbx, msg) => { bcalls.push(msg); return { pushed: true, sms: 'queued' }; } });
      const FA2 = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
      const realLoad2 = Module._load;
      Module._load = function (req, parent) {
        if (parent && parent.filename === bfFile && req === './owner-notify') return stubON2;
        if (parent && parent.filename === bfFile && req === 'firebase-functions/v2') return { logger: { info() {}, warn() {}, error() {}, log() {} } };
        if (parent && parent.filename === bfFile && req === 'firebase-admin/firestore') return Object.assign({}, FA2, { getFirestore: () => ({ collection: (c) => ({ add: async (v) => { emails.push([c, v]); return {}; } }) }) });
        if (parent && parent.filename === bfFile && req === 'firebase-admin/storage') return { getStorage: () => ({ bucket: () => ({ getFiles: async () => [[]] }) }) };
        return realLoad2.apply(this, arguments);
      };
      hbMod._overrides.functionTarget = 'backupFreshnessCron';
      hbMod._overrides.pingKey = '';
      hbMod._overrides.recordRun = async () => {};
      let bthrew = null;
      try {
        const ep = require(bfFile).backupFreshnessCron;
        await (typeof ep.run === 'function' ? ep.run : ep)({ scheduleTime: new Date().toISOString() });
      } catch (e) { bthrew = e; }
      finally {
        Module._load = realLoad2;
        if (bfSaved) require.cache[bfFile] = bfSaved; else delete require.cache[bfFile];
        hbMod._overrides.functionTarget = undefined; hbMod._overrides.pingKey = undefined; hbMod._overrides.recordRun = undefined;
      }
      ok('backup-freshness: no export marker -> notifyOwner with severity alert, keyed, plus the email as before', bcalls.length === 1 && bcalls[0].severity === 'alert' && bcalls[0].key === 'backup-freshness' && /backup/i.test(bcalls[0].title) && emails.length === 1 && emails[0][0] === 'email_queue', JSON.stringify([bcalls, emails.length, bthrew && bthrew.message]));
    }

    // The health digest's failure lines.
    const HD = require(path.join(FN, 'health-digest.js'))._test;
    const good = { renderPdf: { failRecent: false, okRecent: true }, emailQueue: { pending: 0, sending: 0, failed: 0 }, imagePipe: { genuineRecent: false } };
    ok('health digest: nothing failing -> no owner alert', HD.digestAlert(good) === null);
    const bad = HD.digestAlert(Object.assign({}, good, { renderPdf: { failRecent: true, okRecent: false, lastFailStage: 'launch' }, emailQueue: { pending: 40, sending: 0, failed: 2 } }));
    ok('…PDF renders + email queue failing -> one alert-severity notice naming both', bad && bad.severity === 'alert' && bad.key === 'health-digest:render-pdf,email-queue' && /40 pending/.test(bad.body), JSON.stringify(bad));
  }

  console.log('G. copycat-watch: our own repo / org is never a match');
  {
    const CF = require(path.join(ROOT, 'scripts', 'copycat-foreign-repos.js'));
    const self = 'NBDPRO/nobigdealwithjoedeal.com';
    const hits = ['NBDPRO/nobigdealwithjoedeal.com', 'nbdpro/nobigdealwithjoedeal.com', 'NBDPRO/other-repo', 'someone/nobigdealwithjoedeal-copy', 'jdealtia-sys/nobigdealwithjoedeal.com'];
    const f = CF.foreignRepos(hits, { self, allow: '^$' });
    ok('own repo (any case) and other repos of the own org are excluded; strangers are kept', f.join() === 'someone/nobigdealwithjoedeal-copy,jdealtia-sys/nobigdealwithjoedeal.com', f.join());
    ok('the ALLOWLIST regex still removes acknowledged repos', CF.foreignRepos(['someone/x', 'friend/y'], { self, allow: '^friend/' }).join() === 'someone/x');
    let threw = false; try { CF.foreignRepos(['a/b'], { self: '' }); } catch (_) { threw = true; }
    ok('no --self (owner/repo) is an error, never "everything is foreign"', threw);
    const cli = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'copycat-foreign-repos.js')].concat(args), { encoding: 'utf8' });
    const out = cli(['--self', self, '--allow', '^$', hits.slice(0, 3).join(' ')]);
    ok('CLI, as the workflow calls it with the search hits: our own repo prints nothing', out.status === 0 && out.stdout.trim() === '', JSON.stringify([out.status, out.stdout, out.stderr]));
    const dry = cli(['--self', self, '--allow', '^$', '--dry-run']);
    ok('the workflow\'s dry-run step passes for this repo name', dry.status === 0, dry.stderr);
  }

  console.log('H. the "Scheduled checks failing" issue');
  {
    const SC = require(path.join(ROOT, 'scripts', 'scheduled-checks-issue.js'));
    const run = (name, conclusion) => ({ name, conclusion, url: 'https://example.test/run/' + name.length, at: '2026-11-25T12:00:00Z' });
    const p1 = SC.plan(null, run('Page-speed watch', 'failure'));
    ok('a scheduled watch fails, no issue yet -> create', p1.action === 'create', p1.action);
    const issue = { number: 7, state: 'open', body: p1.body };
    const p2 = SC.plan(issue, run('Copycat watch', 'failure'));
    ok('a second watch fails -> update the same issue + a comment naming it', p2.action === 'update' && /Copycat watch failed/.test(p2.comment) && SC.failing(SC.parseState(p2.body)).length === 2, JSON.stringify(p2.comment));
    issue.body = p2.body;
    const p3 = SC.plan(issue, run('Page-speed watch', 'success'));
    ok('one goes green, one still red -> update, stays open', p3.action === 'update' && SC.failing(SC.parseState(p3.body)).join() === 'Copycat watch', p3.action);
    issue.body = p3.body;
    const p4 = SC.plan(issue, run('Copycat watch', 'success'));
    ok('all green again -> close', p4.action === 'close' && SC.failing(SC.parseState(p4.body)).length === 0, p4.action);
    const p5 = SC.plan({ number: 7, state: 'closed', body: p4.body }, run('Lead address audit', 'timed_out'));
    ok('a later failure -> reopen the same issue (one issue, never a pile)', p5.action === 'reopen' && /Lead address audit failed/.test(p5.comment), p5.action);
    ok('a cancelled run changes nothing; an unwatched workflow is ignored', SC.plan(null, run('Page-speed watch', 'cancelled')).action === 'none' && SC.plan(null, run('CI', 'failure')).action === 'none');
    ok('only a scheduled run counts (a manual dispatch is ignored)', SC.runFromEvent({ workflow_run: { event: 'workflow_dispatch', name: 'Copycat watch', conclusion: 'failure' } }) === null && SC.runFromEvent({ workflow_run: { event: 'schedule', name: 'Copycat watch', conclusion: 'failure', html_url: 'u' } }).name === 'Copycat watch');
    const chk = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'scheduled-checks-issue.js'), '--check'], { encoding: 'utf8' });
    ok('--check: every watched name is a scheduled workflow and the alert workflow listens to exactly that list', chk.status === 0, chk.stderr);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-chk-'));
    fs.writeFileSync(path.join(tmp, 'x.yml'), 'name: Copycat watch\non:\n  workflow_dispatch:\n');
    const neg = SC.check(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    ok('(control) --check fails a watch with no schedule and a missing alert workflow', neg.some((p) => /no schedule/.test(p)) && neg.some((p) => /is missing/.test(p)), JSON.stringify(neg));

    // The issue is found by its title, never by a label that may be missing.
    const calls = [];
    const unlabeled = { number: 9, title: SC.TITLE, state: 'open', body: issue.body, labels: [] };
    const fakeGh = async (method, url) => {
      calls.push(method + ' ' + url);
      if (/labels=/.test(url)) return [];
      if (/\/issues\?/.test(url)) return [{ number: 3, title: 'something else', labels: [] }, { number: 8, title: SC.TITLE, pull_request: {} }, unlabeled];
      if (/\/labels$/.test(url)) return [];
      return null;
    };
    const found = await SC.findIssue('o/r', fakeGh);
    ok('an existing "Scheduled checks failing" issue WITHOUT the ops label is found (no duplicate issue)', found && found.number === 9, JSON.stringify([found, calls]));
    calls.length = 0;
    await SC.apply('o/r', unlabeled, { action: 'update', body: 'x', comment: '' }, fakeGh);
    ok('…and an update puts the ops label back (best effort)', calls.some((c) => /^POST \/repos\/o\/r\/issues\/9\/labels$/.test(c)), JSON.stringify(calls));
    // A pending workflow_run can be cancelled by concurrency: each watch's
    // latest scheduled run is re-read, not only the triggering event.
    const latest = { 'Copycat watch': 'failure', 'Public-invoker watch': 'failure', 'Page-speed watch': 'success' };
    const runsGh = async (method, url) => {
      const m = /actions\/workflows\/([^/]+)\/runs\?/.exec(url);
      const name = m && Object.keys(SC.workflowNamesIn(path.join(ROOT, '.github', 'workflows'))).find((n) => SC.workflowNamesIn(path.join(ROOT, '.github', 'workflows'))[n].file === decodeURIComponent(m[1]));
      if (!m || !/event=schedule/.test(url)) throw new Error('unexpected ' + url);
      return { workflow_runs: latest[name] ? [{ name, conclusion: latest[name], html_url: 'u/' + name.length, updated_at: 't', event: 'schedule' }] : [] };
    };
    const lr = await SC.latestRuns('o/r', runsGh, path.join(ROOT, '.github', 'workflows'));
    const pl = SC.plan({ number: 7, state: 'open', body: SC.renderBody({}) }, [run('Page-speed watch', 'success')].concat(lr));
    ok('a lost red event (Public-invoker) still lands: the latest scheduled runs are re-read', SC.failing(SC.parseState(pl.body)).join() === 'Copycat watch,Public-invoker watch' && /Public-invoker watch failed/.test(pl.comment), JSON.stringify(pl));
    latest['Copycat watch'] = 'success'; latest['Public-invoker watch'] = 'success';
    const lr2 = await SC.latestRuns('o/r', runsGh, path.join(ROOT, '.github', 'workflows'));
    const pl2 = SC.plan({ number: 7, state: 'open', body: pl.body }, [run('Page-speed watch', 'success')].concat(lr2));
    ok('…and a lost green closes it', pl2.action === 'close', pl2.action);
    const lr3 = await SC.latestRuns('o/r', async () => { throw new Error('403'); }, path.join(ROOT, '.github', 'workflows'));
    ok('…a failed re-read falls back to the triggering event only (never throws)', Array.isArray(lr3) && lr3.length === 0);

    // copycat-watch.yml: a filter that crashes must be an infra failure, not "no hits".
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'copycat-watch.yml'), 'utf8');
    ok('copycat-watch never loops over the filter\'s output unchecked (exit status captured, failure = infra)', !/for R in \$\(node scripts\/copycat-foreign-repos/.test(yml) && (yml.match(/FOREIGN=\$\(node scripts\/copycat-foreign-repos\.js[^\n]*\) \|\| \{ infra /g) || []).length === 2);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
