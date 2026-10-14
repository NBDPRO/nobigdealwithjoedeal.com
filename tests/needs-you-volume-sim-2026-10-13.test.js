#!/usr/bin/env node
/**
 * "Needs you" VOLUME + LIFECYCLE simulation (2026-10-13).
 *
 * Replays realistic weeks through the REAL server code - callWatch runWatch,
 * the re-tell ladder, the 8 pm ledger, pushUrgent, the 15:15 sweep, the 06:45
 * brief's "you said you'd" section, callAction (handled / snooze) - against a
 * Firestore fake that honours where() / orderBy() / limit(), a stubbed clock
 * and stubbed senders (NOTHING is sent anywhere; no network, no emulator).
 *
 * It COUNTS pushes / bells / emails per person per day and per day total,
 * quiet-hours leaks (outside 08:00-21:00 ET), and ladder overruns, and prints
 * a table. Two kinds of check:
 *   - invariants (ok): must hold; the exit code goes red if one breaks.
 *   - findings (finding): behaviours the audit documents as defects. They are
 *     INFORMATIONAL: "REPRODUCES" while the defect exists, "RESOLVED" after a
 *     fix; they never fail the run (so a fix cannot be blocked by this file).
 *
 * Deterministic (seeded PRNG, simulated clock). Fast (a few seconds).
 * Run: node tests/needs-you-volume-sim-2026-10-13.test.js [--table]
 * Write-up: documentation/audit/NEEDS-YOU-LIFECYCLE-AND-VOLUME-2026-10-13.md
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

process.env.CALL_WATCH_ENABLED = 'true';
process.env.CALL_CENTER_INGEST_ENABLED = 'true';
process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'true';
delete process.env.TEXT_NOTES_ENABLED;

const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
const L = require(path.join(ROOT, 'functions/call-center-logic.js'));
const WATCH = require(path.join(ROOT, 'functions/call-watch.js'))._internal;
const CC = require(path.join(ROOT, 'functions/call-center.js'))._test;
const CCX = require(path.join(ROOT, 'functions/call-center.js'));
const PV = require(path.join(ROOT, 'functions/ping-volume-logic.js'));
const OWNER = CC.OWNER;

const MIN = 60000, H = 3600000, D = 86400000;
let passed = 0, failed = 0, reproduced = 0, resolved = 0;
const SHOW_TABLE = process.argv.includes('--table') || !!process.env.SIM_TABLE;
const quiet = () => !SHOW_TABLE;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' - ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
/** Informational: a documented defect. Never fails the run. */
function finding(id, name, stillBroken, detail) {
  if (stillBroken) { reproduced++; console.log('  ! ' + id + ' REPRODUCES: ' + name + (detail !== undefined ? ' - ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
  else { resolved++; console.log('  ✓ ' + id + ' RESOLVED: ' + name); }
}

// ── clock helpers ─────────────────────────────────────────────────────────
const etYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etHour = (ms) => Number(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })) % 24;
const etMin = (ms) => Number(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
function etMidnight(ymd) {
  for (const off of [4, 5]) {
    const t = Date.parse(ymd + 'T0' + off + ':00:00Z');
    if (etYmd(t) === ymd && etHour(t) === 0) return t;
  }
  throw new Error('etMidnight ' + ymd);
}
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T12:00:00Z') + n * D).toISOString().slice(0, 10);
const START_YMD = '2026-10-05';                        // a Monday

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── people ────────────────────────────────────────────────────────────────
let personSeq = 0;
function person(kind, label) {
  personSeq++;
  const n = String(personSeq).padStart(4, '0');
  return { name: 'P' + n + ' ' + (label || kind), digits: '513555' + n, leadId: kind === 'cust' ? 'L' + n : null, kind };
}
const keyOf = (p) => (p.leadId ? 'lead:' + p.leadId : 'num:' + p.digits);

// ── Firestore fake (where == >= < <=, in, orderBy, limit, doc get/set, getAll) ──
function makeDb(S) {
  const val = (x) => (x instanceof Date ? x.getTime() : x);
  const cols = S.cols;
  const docsOf = (col) => cols[col] || (cols[col] = []);
  function query(col) {
    const f = []; const st = { lim: Infinity, field: null, desc: false };
    const self = {
      where(field, op, v) { f.push([field, op, val(v)]); return self; },
      orderBy(field, dir) { st.field = field; st.desc = dir === 'desc'; return self; },
      limit(n) { st.lim = n; return self; },
      async get() {
        let r = docsOf(col).filter((x) => f.every(([k, op, v]) => {
          const a = val(x[k]);
          if (op === '==') return a === v || (v === null && (a === null || a === undefined) && k in x && x[k] === null);
          if (op === 'in') return Array.isArray(v) && v.includes(a);
          if (a === null || a === undefined) return false;
          return op === '>=' ? Number(a) >= v : op === '<' ? Number(a) < v : op === '<=' ? Number(a) <= v : op === '>' ? Number(a) > v : true;
        }));
        if (st.field) r = r.slice().sort((a, b) => (st.desc ? (val(b[st.field]) || 0) - (val(a[st.field]) || 0) : (val(a[st.field]) || 0) - (val(b[st.field]) || 0)));
        r = r.slice(0, st.lim);
        const docs = r.map((x) => ({ id: x.id, data: () => x, ref: colDoc(col, x.id) }));
        return { size: r.length, docs, forEach: (fn) => docs.forEach(fn) };
      },
    };
    return self;
  }
  function colDoc(col, id) {
    return {
      id,
      async get() { const x = docsOf(col).find((r) => r.id === id); return { exists: !!x, id, data: () => x }; },
      async set(v, op) {
        let x = docsOf(col).find((r) => r.id === id);
        if (!x) { x = { id }; docsOf(col).push(x); }
        if (!(op && op.merge)) Object.keys(x).forEach((k) => { if (k !== 'id') delete x[k]; });
        Object.assign(x, v);
      },
      async update(v) { return colDoc(col, id).set(v, { merge: true }); },
      collection() { throw new Error('nested collection not faked: ' + col); },
    };
  }
  const pathDoc = (p) => ({
    async get() { return { exists: p in S.docs, data: () => S.docs[p] }; },
    async set(v, op) { S.docs[p] = op && op.merge ? Object.assign({}, S.docs[p] || {}, v) : Object.assign({}, v); },
    async update(v) { S.docs[p] = Object.assign({}, S.docs[p] || {}, v); },
    async delete() { delete S.docs[p]; },
  });
  const db = {
    collection(n) {
      if (n === 'notifications') return { add: async (v) => { S.onBell(v); } };
      if (n === 'companies') {
        return { doc: () => ({ collection: () => ({
          get: async () => ({ docs: Object.keys(S.labels).map((d) => ({ id: d, data: () => S.labels[d] })) }),
          doc: (d) => ({ get: async () => ({ exists: !!S.labels[d], data: () => S.labels[d] }) }),
        }) }) };
      }
      if (n === 'users') return { doc: (id) => pathDoc('users/' + id) };
      if (n === 'phone_calls' || n === 'phone_text_days' || n === 'thursday_calls') {
        const q = query(n); q.doc = (id) => colDoc(n, id); return q;
      }
      const q = query(n); q.doc = (id) => colDoc(n, id); return q;
    },
    doc: (p) => pathDoc(p),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    // collectionGroup('tasks') over leads/<id>/tasks/<id> path docs (the promise channel's read).
    collectionGroup(n) {
      const f = [];
      const self = {
        where(field, op, v) { f.push([field, op, v]); return self; },
        async get() {
          if (S.failTaskRead) throw new Error('simulated: collectionGroup(tasks) unavailable');
          const docs = Object.keys(S.docs).map((p) => { const m = /^leads\/([^/]+)\/tasks\/([^/]+)$/.exec(p); return m && n === 'tasks' ? { p, leadId: m[1], id: m[2] } : null; })
            .filter(Boolean).filter((x) => f.every(([k, op, v]) => (op === '==' ? S.docs[x.p][k] === v : true)))
            .map((x) => ({ id: x.id, data: () => S.docs[x.p], ref: { parent: { parent: { id: x.leadId } } } }));
          return { size: docs.length, docs, forEach: (fn) => docs.forEach(fn) };
        },
      };
      return self;
    },
  };
  return db;
}

// ── the simulation ────────────────────────────────────────────────────────
/**
 * ev kinds:
 *   {k:'call', t, p, urgent?, promise?, fu?, missed?, callType?, bucket?}
 *   {k:'text', t, p, urgent?, promise?}              (a day of texts, re-noted hourly)
 *   {k:'thu',  t, p, urgent?}                        (Thursday took a call)
 * jo: 'ignores' | 'attentive' (handles a person 30-110 min after first seeing them, in hours)
 *   | 'evening' (handles everyone at 20:30)
 * hooks: optional per-tick function(ctx) for scenario-specific Jo actions.
 */
function simulate(o) {
  const S = {
    cols: { phone_calls: [], phone_text_days: [], thursday_calls: [] },
    docs: { ['users/' + OWNER]: { email: 'jo@example.invalid' } },
    labels: o.labels || {},
    onBell: null,
  };
  const db = makeDb(S);
  const events = [];                                  // every ping
  const clock = { now: 0 };
  const M = { name: o.name, jo: o.jo, events, days: {}, perPersonDay: new Map(), perId: new Map(), leaks: [], openByDay: {}, notes: [] };
  const startMs = etMidnight(o.startYmd || START_YMD);
  const endMs = etMidnight(addDays(o.startYmd || START_YMD, o.days));
  const people = new Map();                           // key -> {name}
  const nameToKey = new Map();
  (o.people || []).forEach((p) => {
    people.set(keyOf(p), p); nameToKey.set(p.name, keyOf(p));
    if (p.leadId) S.docs['leads/' + p.leadId] = { firstName: p.name, userId: OWNER, companyId: OWNER, phoneDigits: p.digits };
  });

  const day = (t) => { const y = etYmd(t); return M.days[y] || (M.days[y] = { push: 0, watchPush: 0, urgentPush: 0, thursdayPush: 0, bell: 0, ledgerBell: 0, email: 0, ladderEmail: 0, sweepEmail: 0, briefEmail: 0, thursdayEmail: 0, reminderPushes: 0, promisePush: 0, unreachedEmail: 0 }); };
  const pp = (key, t) => { const k = key + '|' + etYmd(t); let r = M.perPersonDay.get(k); if (!r) { r = { key, ymd: etYmd(t), push: 0, email: 0, bell: 0 }; M.perPersonDay.set(k, r); } return r; };
  function ping(ch, src, keys, ids, t, whys) {
    events.push({ t, ch, src, keys: keys || [], ids: ids || [], whys: whys || [] });
    const d = day(t);
    if (ch === 'push') { d.push++; if (src === 'watch') d.watchPush++; else if (src === 'urgent') d.urgentPush++; else if (src === 'thursday') d.thursdayPush++; else if (src === 'promise') d.promisePush++; }
    if (ch === 'bell') { d.bell++; if (src === 'ledger') d.ledgerBell++; }
    if (ch === 'email') { d.email++; if (src === 'ladder') d.ladderEmail++; if (src === 'sweep') d.sweepEmail++; if (src === 'brief') d.briefEmail++; if (src === 'thursday') d.thursdayEmail++; if (src === 'unreached') d.unreachedEmail++; }
    const uniq = Array.from(new Set(keys || []));
    uniq.forEach((k) => { const r = pp(k, t); r[ch]++; });
    if (ch === 'push') (ids || []).forEach((id) => { const r = M.perId.get(id) || { push: 0, email: 0, firstAt: t, lastAt: t, ts: [] }; r.push++; r.lastAt = t; r.ts.push(t); M.perId.set(id, r); });
    if (ch === 'email') (ids || []).forEach((id) => { const r = M.perId.get(id) || { push: 0, email: 0, firstAt: t, lastAt: t, ts: [] }; r.email++; M.perId.set(id, r); });
    if (ch === 'push' || (ch === 'email' && src !== 'brief' && src !== 'sweep')) {
      const h = etHour(t);
      if (h < 8 || h >= 21) M.leaks.push({ t, ch, src, at: new Date(t).toISOString(), et: etYmd(t) + ' ' + String(h).padStart(2, '0') + ':' + String(etMin(t)).padStart(2, '0') });
    }
  }

  // Capture which people / ids each watch alert covered.
  // callWatch calls alertFor twice per run: first for the bell (everyone open from
  // this run), then for the push (only the people who earned it).
  const realAlertFor = W.alertFor;
  let lastItems = [], bellItems = [], alertCalls = 0;
  W.alertFor = function (needs, problems, now) { lastItems = needs || []; if (alertCalls++ === 0) bellItems = lastItems; return realAlertFor.call(W, needs, problems, now); };
  let bellSrc = 'urgent', bellKeys = [];
  S.onBell = (v) => {
    const isLedger = /^🗒/.test(String(v.title || ''));
    ping('bell', isLedger ? 'ledger' : (v.type === 'promise_due' ? 'promise' : bellSrc), isLedger || v.type === 'promise_due' ? [] : (bellSrc === 'watch' ? bellItems.map((x) => x.key) : bellKeys), [], clock.now);
  };

  const storedSeen = new Set();
  const seenAt = new Map();                           // key -> first time Jo was told (push)
  const handledKeys = new Set();
  const rows = [];                                    // calls in flight
  const pendingNote = [];                             // ingested, waiting for transcribe
  let seq = 0;
  const tel = (p) => p.digits;

  // schedule: calls become ingested at the next 30-min cron tick after a 5-25 min Drive lag.
  const rand = rng(o.seed || 7);
  const calls = (o.events || []).filter((e) => e.k === 'call').map((e) => Object.assign({ lag: 5 + Math.floor(rand() * 20) }, e)).sort((a, b) => a.t - b.t);
  const texts = (o.events || []).filter((e) => e.k === 'text').sort((a, b) => a.t - b.t);
  const thus = (o.events || []).filter((e) => e.k === 'thu').sort((a, b) => a.t - b.t);
  let ci = 0, ti = 0, hi = 0;
  const pendingCalls = [];                            // started, not ingested
  const pendingTexts = [];

  const auth = { uid: OWNER, token: { role: 'owner' } };
  const act = (id, action, extra, t) => CC.callAction({ db, auth, data: Object.assign({ id, action }, extra || {}), nowMs: t });

  async function handlePerson(key, t) {
    if (handledKeys.has(key + '|' + etYmd(t))) { /* may legitimately handle again after a new call */ }
    const ctx = W.reachIndex(S.cols.phone_calls);
    ctx.labels = S.labels;
    const open = [];
    S.cols.phone_calls.forEach((c) => { if (W.callerKey(c) === key && W.callNeedsYou(c, t, ctx)) open.push(c.id); });
    S.cols.phone_text_days.forEach((c) => { if (W.callerKey(c) === key && W.callNeedsYou(c, t, { labels: S.labels })) open.push(c.id); });
    for (const id of open) await act(id, 'handled', null, t);
    return open.length;
  }

  async function transcribe(t) {
    const todayYmd = etYmd(t);
    for (const r of S.cols.phone_calls.filter((x) => x.status === 'stored' && x.createdAtMs < t)) {
      if (o.transcribeBlockedUntil && t < o.transcribeBlockedUntil) continue;
      const e = r._ev;
      const notes = { summary: 'Call from ' + r.contactName, promises: e.promise ? [{ who: 'jo', text: 'send the quote', due: e.fu || null }] : [], followUpDate: e.fu || null, urgent: !!e.urgent, callType: e.callType || (r.leadId ? 'customer' : 'lead') };
      Object.assign(r, { status: 'noted', summary: notes.summary, callType: notes.callType, promises: notes.promises, followUpDate: notes.followUpDate, urgent: notes.urgent, notedAtMs: t });
      if (r.leadId) {
        const task = L.buildFollowUpTask({ call: r, notes, leadId: r.leadId, ownerUid: OWNER, todayYmd, nowMs: t });
        const p = 'leads/' + r.leadId + '/tasks/cube-' + r.id;
        if (task && !(p in S.docs)) S.docs[p] = task;
      }
      if (notes.urgent === true && !r.urgentPushedAtMs) {
        bellSrc = 'urgent'; bellKeys = [W.callerKey(r)];
        const sent = await CC.pushUrgent({ db, d: { push: async () => { if (o.pushDead) return { sent: 0, failed: 0, errors: [] }; ping('push', 'urgent', [W.callerKey(r)], ['call:' + r.id], t, ['urgent']); return { sent: 1 }; } }, call: r, notes, leadName: r.leadId ? r.contactName : '', nowMs: t });
        if (sent) { if (!seenAt.has(W.callerKey(r))) seenAt.set(W.callerKey(r), t); }
      }
    }
  }

  async function textNotes(t) {
    // hourly :00 - every day-of-texts with a new text since the last pass is (re-)noted
    const byDay = new Map();
    for (const x of pendingTexts.splice(0)) {
      const k = x.p.digits + '|' + etYmd(x.t);
      (byDay.get(k) || byDay.set(k, []).get(k)).push(x);
    }
    byDay.forEach((list, k) => {
      const p = list[0].p, ymd = etYmd(list[0].t);
      const id = 'txt_' + p.digits + '_' + ymd.replace(/-/g, '');
      let row = S.cols.phone_text_days.find((r) => r.id === id);
      const urgent = list.some((x) => x.urgent), promise = list.some((x) => x.promise);
      if (!row) {
        row = { id, userId: OWNER, channel: 'text', phoneDigits: p.digits, contactName: p.name, leadId: p.leadId, bucket: p.leadId ? 'customer' : 'unknown', status: 'noted', direction: 'inbound', startedAtMs: list[0].t, createdAtMs: t, promises: [], urgent: false };
        S.cols.phone_text_days.push(row);
      } else if (row.handledAtMs && list.some((x) => x.t > row.handledAtMs)) {
        row.handledAtMs = null;                       // #2406: a new inbound reopens a handled day
      }
      if (promise) row.promises = [{ who: 'jo', text: 'text back', due: null }];
      if (urgent) row.urgent = true;
      row.summary = 'texts'; row.notedAtMs = t;
      if (row.leadId) {
        const tk = 'leads/' + row.leadId + '/tasks/sms-' + id;
        const task = L.buildTextDayTask({ day: row, notes: { promises: row.promises, followUpDate: null, urgent: row.urgent, summary: 'texts' }, leadId: row.leadId, ownerUid: OWNER, todayYmd: etYmd(t), nowMs: t });
        if (task && !(tk in S.docs)) S.docs[tk] = task;
      }
    });
  }

  const lastRunOk = () => { S.docs['integrations/callCenter'] = { lastRunAtMs: clock.now, lastTranscribeAtMs: clock.now, lastRun: { failed: 0 }, lastTranscribe: { failed: 0 } }; };

  return (async () => {
    for (let t = startMs; t < endMs; t += 15 * MIN) {
      clock.now = t;
      const h = etHour(t), mi = etMin(t);
      // new calls start
      while (ci < calls.length && calls[ci].t <= t) { pendingCalls.push(calls[ci]); ci++; }
      while (ti < texts.length && texts[ti].t <= t) { pendingTexts.push(texts[ti]); ti++; }
      // Thursday rows appear at once + her own push / email (loud route), no quiet-hours gate
      while (hi < thus.length && thus[hi].t <= t) {
        const e = thus[hi++];
        const id = 'th' + (++seq);
        // The REAL quiet-hours decision (ping-volume-logic holdThursday, used by thursday.js
        // notifyAll): a non-urgent call at night is held, an urgent one breaks through.
        const held = PV.holdThursday({ urgent: !!e.urgent }, t);
        const own = o.thursdayQuiet ? null : (held ? 'held' : 'sent');
        S.cols.thursday_calls.push({ id, companyId: OWNER, status: 'processed', reviewed: false, from: e.p.digits, urgent: !!e.urgent, startedAt: new Date(e.t), processedAt: new Date(t),
          notifyState: own === 'sent' ? { push: { status: 'sent', sentAt: new Date(t) }, email: { status: 'sent', sentAt: new Date(t) } } : (own === 'held' ? { push: { status: 'held:quiet-hours' }, email: { status: 'held:quiet-hours' } } : {}) });
        if (own === 'sent') { ping('push', 'thursday', [keyOf(e.p)], ['thursday:' + id + '#direct'], t); ping('email', 'thursday', [keyOf(e.p)], [], t); }
        M.thursdayRows = (M.thursdayRows || []).concat([{ id, held: own === 'held', urgent: !!e.urgent, key: keyOf(e.p), at: t }]);
      }
      // :00 / :30 - the Cube ACR jobs
      if (mi === 0 || mi === 30) {
        lastRunOk();
        for (let i = pendingCalls.length - 1; i >= 0; i--) {
          const e = pendingCalls[i];
          if (e.t + e.lag * MIN > t) continue;
          pendingCalls.splice(i, 1);
          const id = 'cube_c' + String(++seq).padStart(6, '0');
          const row = { id, userId: OWNER, companyId: OWNER, startedAtMs: e.t, createdAtMs: t, direction: 'inbound', phoneDigits: e.p.digits, contactName: e.p.name, leadId: e.p.leadId || null, bucket: e.bucket || (e.p.leadId ? 'customer' : 'unknown'), status: e.missed ? 'short' : 'stored', _ev: e };
          S.cols.phone_calls.push(row);
        }
        await transcribe(t);
      }
      if (mi === 0) await textNotes(t);
      // crons
      if (h === 6 && mi === 45) {
        const g = await CC.gatherSweepWithPromises({ db, nowMs: t });
        M.briefs = M.briefs || {}; M.briefs[etYmd(t)] = g;
        if (g.items.length) {
          ping('email', 'brief', g.items.map((i) => (i.leadId ? 'lead:' + i.leadId : 'num:' + i.phoneDigits)), g.items.map((i) => 'call:' + i.callId), t);
          if (!g.promiseCheckFailed) await CCX.stampDigest(db, g.items, t, 'brief');
        }
      }
      if (h === 15 && mi === 15) {
        const g = await CC.gatherSweepWithPromises({ db, nowMs: t });
        await CC.runSweep({ db, live: true, nowMs: t, slot: 'pm', absorbed: false, send: async () => { ping('email', 'sweep', g.items.map((i) => (i.leadId ? 'lead:' + i.leadId : 'num:' + i.phoneDigits)), g.items.map((i) => 'call:' + i.callId), t); } });
      }
      if (mi === 0 && h >= 8 && h <= 20 && h % 2 === 0) {
        bellSrc = 'watch';
        // Calls this run can see while the transcript is still pending: callNeedsYou
        // counts a 'stored' unknown-number call, so the run tells it as "unknown number".
        S.cols.phone_calls.forEach((r) => { if (r.status === 'stored' && r.bucket === 'unknown') storedSeen.add(r.id); });
        const before = S.docs['integrations/callWatch'];
        alertCalls = 0; bellItems = [];
        let r;
        try {
          r = await WATCH.runWatch({
            db, nowMs: t, live: true,
            push: async (uid, title, body, data) => {
              if (data && data.type === 'promise_due') {
                const pk = String(data.promiseKeys || '').split(',').filter(Boolean);
                const pres = o.pushDead ? { sent: 0, failed: 0, errors: [] } : { sent: 1 };
                ping('push', 'promise', pk, pk.map((k) => 'promise:' + k.replace(/^lead:/, '')), t, ['promise']);
                M.promisePushes = (M.promisePushes || []).concat([{ t, title, body, keys: pk, reached: pres.sent > 0 }]);
                return pres;
              }
              bellKeys = lastItems.map((x) => x.key);
              const res = o.pushDead ? { sent: 0, failed: 0, errors: [] } : { sent: 1 };
              // A merged push (08:00: call alert + promise push in ONE) also carries the promise people.
              const pkeys = data && data.promiseKeys ? String(data.promiseKeys).split(',').filter(Boolean) : [];
              const merged = pkeys.length > 0;
              if (merged) { M.mergedPushes = (M.mergedPushes || 0) + 1; M.promisePushes = (M.promisePushes || []).concat([{ t, title, body, keys: pkeys, reached: res.sent > 0, merged: true }]); }
              M.pushTexts = (M.pushTexts || []).concat([{ t, title, body }]);
              ping('push', 'watch', lastItems.map((x) => x.key).concat(pkeys), lastItems.map((x) => x.id).concat(pkeys.map((k) => 'promise:' + k.replace(/^lead:/, ''))), t, lastItems.map((x) => x.why).concat(merged ? ['you promised something'] : []));
              if (data && data.requireInteraction === 'true') day(t).reminderPushes++;
              lastItems.forEach((x) => { if (!seenAt.has(x.key)) seenAt.set(x.key, t); });
              return res;
            },
            email: async (m) => {
              const keys = [];
              String(m.text || '').split('\n').forEach((ln) => { const mm = /^- (P\d{4} [^ ]+(?: [^ -]+)*?) - /.exec(ln); if (mm && nameToKey.has(mm[1])) keys.push(nameToKey.get(mm[1])); });
              ping('email', /^Your phone did not get the alert/.test(String(m.subject || '')) ? 'unreached' : 'ladder', keys, [], t);
            },
          });
        } catch (e) { r = { state: 'threw', err: e && e.message }; }
        M.lastWatch = r;
        if (h === 20 && S.docs['integrations/dailyLedger']) { const L0 = S.docs['integrations/dailyLedger']; M.ledgers = M.ledgers || {}; M.ledgers[etYmd(t)] = { open: L0.open, clear: L0.clear, calls: L0.calls, anomalies: (L0.anomalies || []).length, anomalyText: (L0.anomalies || []).join(' | ') }; }
        void before;
        // bells for the watch alert are recorded by onBell with bellKeys set at push time;
        // runWatch adds the bell BEFORE the push, so attribute it to the same items.
      }
      // Jo
      if (o.jo === 'attentive' && h >= 8 && h < 21) {
        for (const [key, at] of Array.from(seenAt.entries())) {
          const delay = (30 + (Math.abs(hash(key)) % 80)) * MIN;
          if (t >= at + delay) { await handlePerson(key, t); seenAt.delete(key); }
        }
      }
      if (o.jo === 'evening' && h === 20 && mi === 30) {
        const keys = new Set();
        S.cols.phone_calls.concat(S.cols.phone_text_days).forEach((c) => keys.add(W.callerKey(c)));
        for (const k of keys) await handlePerson(k, t);
      }
      if (o.hook) await o.hook({ t, h, mi, S, db, act, handlePerson, seenAt, M, ping });
      // end of day snapshot of "open on Home"
      if (h === 23 && mi === 45) {
        const ctx = W.reachIndex(S.cols.phone_calls); ctx.labels = S.labels;
        const open = new Set();
        S.cols.phone_calls.forEach((c) => { if (W.callNeedsYou(c, t, ctx)) open.add(W.callerKey(c)); });
        S.cols.phone_text_days.forEach((c) => { if (W.callNeedsYou(c, t, { labels: S.labels })) open.add(W.callerKey(c)); });
        M.openByDay[etYmd(t)] = open.size;
      }
    }
    W.alertFor = realAlertFor;
    M.storedSeen = storedSeen.size;
    M.storedSwallowed = S.cols.phone_calls.filter((r) => storedSeen.has(r.id) && !r.urgent && ((r.promises && r.promises.length) || r.followUpDate)).length;
    M.callsTotal = S.cols.phone_calls.length;
    M.S = S; M.db = db;
    return M;
  })();
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h; }

// ── scenario builders ─────────────────────────────────────────────────────
function at(ymd, hh, mm) { return etMidnight(ymd) + (hh * 60 + (mm || 0)) * MIN; }
const dayYmd = (i) => addDays(START_YMD, i);

function stormWeek() {
  const r = rng(101);
  const people = [], events = [];
  const custs = [], unk = [];
  for (let i = 0; i < 40; i++) { const p = person('cust', 'storm cust'); custs.push(p); people.push(p); }
  for (let i = 0; i < 40; i++) { const p = person('unk', 'storm unk'); unk.push(p); people.push(p); }
  const pick = (a) => a[Math.floor(r() * a.length)];
  const when = (ymd) => { const x = r(); const hh = x < 0.08 ? 20 + Math.floor(r() * 3) : 7 + Math.floor(r() * 13); return at(ymd, hh, Math.floor(r() * 60)); };
  for (let d = 0; d < 7; d++) {
    const ymd = dayYmd(d);
    // 40 calls: 8 urgent, 12 promise (Jo said he would), 5 callbacks (a follow-up date), 6 missed, rest plain
    for (let i = 0; i < 40; i++) {
      const p = i % 3 === 0 ? pick(unk) : pick(custs);
      const e = { k: 'call', t: when(ymd), p };
      if (i < 8) e.urgent = true;
      else if (i < 20) e.promise = true;
      else if (i < 25) e.fu = addDays(ymd, 2);
      else if (i < 31) e.missed = true;
      events.push(e);
    }
    // 20 text days' worth of texts from ~8 people; 3 urgent, 4 promise
    for (let i = 0; i < 20; i++) {
      const p = i % 2 ? pick(custs) : pick(unk);
      const e = { k: 'text', t: when(ymd), p };
      if (i < 3) e.urgent = true; else if (i < 7) e.promise = true;
      events.push(e);
    }
    // 4 Thursday calls (after-hours / overflow)
    for (let i = 0; i < 4; i++) events.push({ k: 'thu', t: at(ymd, i < 2 ? 21 + i : 12 + i, 10), p: pick(unk), urgent: i === 0 });
  }
  return { name: 'storm week (40 calls, 20 texts, 12 promises, 5 callbacks, 4 Thursday per day)', people, events, days: 7 };
}
function quietWeek() {
  const r = rng(202);
  const people = [], events = [];
  for (let d = 0; d < 7; d++) {
    const ymd = dayYmd(d);
    for (let i = 0; i < 6; i++) {
      const p = person(i % 2 ? 'cust' : 'unk', 'quiet'); people.push(p);
      const e = { k: 'call', t: at(ymd, 8 + i * 2, Math.floor(r() * 50)), p };
      if (d === 2 && i === 1) e.urgent = true;
      if (i === 3) e.promise = true;
      events.push(e);
    }
    for (let i = 0; i < 2; i++) { const p = person('cust', 'quiet text'); people.push(p); events.push({ k: 'text', t: at(ymd, 10 + i * 4, 5), p }); }
  }
  return { name: 'quiet week (6 calls, 2 texts, 1 promise per day)', people, events, days: 7 };
}
function spamBurst() {
  const people = [], events = [];
  const robo = person('unk', 'robocaller'), legit = person('cust', 'real customer');
  people.push(robo, legit);
  for (let d = 0; d < 3; d++) {
    const ymd = dayYmd(d);
    for (let i = 0; i < 24; i++) events.push({ k: 'call', t: at(ymd, 9, 0) + i * 20 * MIN, p: robo, missed: true });
    events.push({ k: 'call', t: at(ymd, 13, 5), p: legit, promise: d === 0 });
  }
  return { name: 'spam burst: one unlabeled number hangs up every 20 min, 9:00-17:00, 3 days', people, events, days: 4 };
}
function repeatCaller() {
  const people = [], events = [];
  const c = person('cust', 'angry customer');
  people.push(c);
  const y0 = dayYmd(0);
  [[9, 5, { urgent: true }], [10, 40, { promise: true }], [11, 15, { missed: true }], [13, 30, { urgent: true }], [15, 0, { promise: true }], [16, 45, { missed: true }]]
    .forEach((x) => events.push(Object.assign({ k: 'call', t: at(y0, x[0], x[1]), p: c }, x[2])));
  events.push(Object.assign({ k: 'call', t: at(dayYmd(1), 9, 0), p: c, urgent: true }));
  events.push(Object.assign({ k: 'call', t: at(dayYmd(1), 9, 40), p: c, missed: true }));
  return { name: 'one customer calls 6 times in a day (2 urgent, 2 promise, 2 missed), then 2 more', people, events, days: 4 };
}
function promiseMissed() {
  const people = [], events = [];
  const c = person('cust', 'slipping promise');
  people.push(c);
  events.push({ k: 'call', t: at(dayYmd(0), 10, 0), p: c, promise: true, fu: dayYmd(1) });
  // Jo snoozes at 9:00 each due day, three times, then handles on day 4 at 9:00
  const hook = async ({ t, h, mi, S, act }) => {
    if (h !== 9 || mi !== 0) return;
    const d = Math.round((etMidnight(etYmd(t)) - etMidnight(START_YMD)) / D);
    if (d >= 1 && d <= 3) {
      const row = S.cols.phone_calls.find((x) => x.leadId === c.leadId);
      if (row && row.status === 'noted') await act(row.id, 'snooze', { days: 1 }, t);
    } else if (d === 4) {
      const row = S.cols.phone_calls.find((x) => x.leadId === c.leadId);
      if (row) await act(row.id, 'taskDone', null, t);
    }
  };
  return { name: 'a promise missed 3 times (snoozed 1 day, three times, then done)', people, events, days: 7, hook };
}

// ── reporting ─────────────────────────────────────────────────────────────
function summarize(M) {
  const ds = Object.keys(M.days).sort();
  const col = (k) => ds.map((d) => M.days[d][k]);
  const max = (a) => Math.max(0, ...a);
  const typical = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  let pMax = { n: 0, key: '', ymd: '' };
  let pMaxPush = { n: 0 }, pMaxEmail = { n: 0 };
  M.perPersonDay.forEach((r) => {
    const n = r.push + r.email;
    if (n > pMax.n) pMax = { n, key: r.key, ymd: r.ymd, push: r.push, email: r.email };
    if (r.push > pMaxPush.n) pMaxPush = { n: r.push, key: r.key, ymd: r.ymd };
    if (r.email > pMaxEmail.n) pMaxEmail = { n: r.email, key: r.key, ymd: r.ymd };
  });
  const perPersonVals = Array.from(M.perPersonDay.values()).map((r) => r.push + r.email).sort((a, b) => a - b);
  const p50 = perPersonVals.length ? perPersonVals[Math.floor(perPersonVals.length / 2)] : 0;
  const p95 = perPersonVals.length ? perPersonVals[Math.floor(perPersonVals.length * 0.95)] : 0;
  return {
    name: M.name, jo: M.jo, days: ds.length,
    pushMaxDay: max(col('push')), pushTypicalDay: typical(col('push')), pushWatchMax: max(col('watchPush')), pushUrgentMax: max(col('urgentPush')), pushThursdayMax: max(col('thursdayPush')),
    bellMaxDay: max(col('bell')), bellTotal: col('bell').reduce((a, b) => a + b, 0),
    emailMaxDay: max(col('email')), emailTotal: col('email').reduce((a, b) => a + b, 0), ladderEmailMax: max(col('ladderEmail')), ladderEmailTotal: col('ladderEmail').reduce((a, b) => a + b, 0),
    pushTotal: col('push').reduce((a, b) => a + b, 0),
    personDayMax: pMax, personPushMax: pMaxPush, personEmailMax: pMaxEmail, personDayP50: p50, personDayP95: p95,
    watchPushes: M.events.filter((e) => e.ch === 'push' && e.src === 'watch').length,
    lowOnlyPushes: M.events.filter((e) => e.ch === 'push' && e.src === 'watch' && e.whys.length && e.whys.every((w) => !/^(urgent|you promised something|follow-up due|insurance line)/.test(w))).length,
    leaks: M.leaks.length, openEnd: M.openByDay[ds[ds.length - 1]], storedSeen: M.storedSeen, storedSwallowed: M.storedSwallowed, callsTotal: M.callsTotal,
  };
}
function printRow(s) {
  console.log('    ' + [
    'push/day max ' + s.pushMaxDay + ' typ ' + s.pushTypicalDay + ' (watch ' + s.pushWatchMax + ' urgent ' + s.pushUrgentMax + ' thursday ' + s.pushThursdayMax + ')',
    'bells/day max ' + s.bellMaxDay,
    'emails/day max ' + s.emailMaxDay + ' (ladder ' + s.ladderEmailMax + ')',
    'per-person/day max ' + s.personDayMax.n + ' (push ' + (s.personDayMax.push || 0) + ' email ' + (s.personDayMax.email || 0) + ') p50 ' + s.personDayP50 + ' p95 ' + s.personDayP95,
    'watch pushes ' + s.watchPushes + ' (' + s.lowOnlyPushes + ' only about unknown-number / missed-call items)', 'leaks ' + s.leaks, 'open@end ' + s.openEnd,
  ].join(' | '));
}

(async () => {
  const results = {};
  const extraRuns = [];                                // scenarios N / O / P: the promise-channel runs
  const run = async (sc, jo, extra) => simulate(Object.assign({ name: sc.name, people: sc.people, events: sc.events, days: sc.days, hook: sc.hook, jo, seed: 9 }, extra || {}));

  // ── A. busy storm week ──────────────────────────────────────────────────
  console.log('A. storm week - Jo ignores everything (the ceiling), then Jo attentive');
  const storm = stormWeek();
  const stormIgnore = await run(storm, 'ignores');
  const stormAtt = await run(storm, 'attentive');
  results.stormIgnore = summarize(stormIgnore); results.stormAtt = summarize(stormAtt);
  printRow(results.stormIgnore); printRow(results.stormAtt);
  if (process.env.SIM_TRACE) {   // SIM_TRACE=lead:L0011 prints every ping about that person
    stormIgnore.events.filter((e) => e.keys.includes(process.env.SIM_TRACE)).forEach((e) => console.log('    trace ' + e.ch + ':' + e.src + ' ' + new Date(e.t).toISOString().slice(5, 16) + ' ' + (e.whys || []).join(' / ').slice(0, 90)));
  }
  console.log('    stored-state tells in the storm week: ' + results.stormIgnore.storedSeen + ' of ' + results.stormIgnore.callsTotal + ' calls were seen by a run while still transcribing; ' + results.stormIgnore.storedSwallowed + ' of those carried a promise / callback date that the run could not tell as such');
  ok('storm/ignore: callWatch pushes never exceed one per run (7 per day)', results.stormIgnore.pushWatchMax <= 7, results.stormIgnore.pushWatchMax);
  ok('storm/ignore: zero push / ladder-email quiet-hours leaks from callWatch, urgent push and the ladder', stormIgnore.leaks.filter((l) => l.src !== 'thursday').length === 0, stormIgnore.leaks.slice(0, 3));

  // ── B. quiet week ───────────────────────────────────────────────────────
  console.log('B. quiet week');
  const qw = quietWeek();
  const quietIgnore = await run(qw, 'ignores');
  results.quiet = summarize(quietIgnore); printRow(results.quiet);
  ok('quiet week stays quiet: <= 7 pushes on any day', results.quiet.pushMaxDay <= 7, results.quiet.pushMaxDay);
  // F6: runs with nothing but unknown-number / missed-call items are bell-only.
  const lowBells = quietIgnore.events.filter((e) => e.ch === 'bell' && e.src === 'watch').length;
  ok('F6 quiet week: no push is about ONLY unknown-number / missed-call items (was 13 of 35)', results.quiet.lowOnlyPushes === 0, results.quiet.lowOnlyPushes);
  ok('F6 positive control: those items still reach the bell (nothing dropped) - the quiet week still writes watch bells', lowBells >= 20, lowBells);
  ok('F6 control: the real needs are still pushed (the one urgent call and the promises)', quietIgnore.events.some((e) => e.ch === 'push' && e.whys.some((w) => /^urgent/.test(w))) && quietIgnore.events.some((e) => e.ch === 'push' && e.whys.some((w) => /promised/.test(w))));

  // ── C. hidden / unlabeled-number spam burst ─────────────────────────────
  console.log('C. one number hangs up every 20 min for 3 days');
  const sp = spamBurst();
  const spamUnlabeled = await run(sp, 'ignores');
  const roboKey = keyOf(sp.people[0]);
  const spamLabelled = await run(sp, 'ignores', { labels: { [sp.people[0].digits]: { kind: 'spam', policy: 'hide', ackAtMs: 0, updatedAtMs: at(dayYmd(0), 0, 1) } } });
  results.spamUnlabeled = summarize(spamUnlabeled); results.spamLabelled = summarize(spamLabelled);
  const roboPushDay = (M) => { let mx = 0; M.perPersonDay.forEach((r) => { if (r.key === roboKey) mx = Math.max(mx, r.push); }); return mx; };
  const roboPushTotal = (M) => { let n = 0; M.perPersonDay.forEach((r) => { if (r.key === roboKey) n += r.push; }); return n; };
  console.log('    unlabeled: robocaller pushes/day max ' + roboPushDay(spamUnlabeled) + ', total over 3 days ' + roboPushTotal(spamUnlabeled) + ' | labelled spam+hide: max ' + roboPushDay(spamLabelled) + ', total ' + roboPushTotal(spamLabelled));
  finding('F-SPAM', 'an unlabeled hang-up number triggers a push on every watch run while it keeps calling', roboPushDay(spamUnlabeled) >= 4, roboPushDay(spamUnlabeled) + ' pushes in one day');
  // F6: bell ONCE a day for the number, then the brief carries one summary line.
  const roboBellByDay = {};
  spamUnlabeled.perPersonDay.forEach((r) => { if (r.key === roboKey) roboBellByDay[r.ymd] = r.bell; });
  console.log('    AFTER: robocaller bells per day ' + JSON.stringify(roboBellByDay) + ' | pushes over 3 days ' + roboPushTotal(spamUnlabeled));
  ok('F6: the unlabelled hang-up number never pushes', roboPushTotal(spamUnlabeled) === 0, roboPushTotal(spamUnlabeled));
  ok('F6: ...is belled exactly ONCE a day while it calls (3 days = 3 bells)', Object.keys(roboBellByDay).length === 3 && Object.values(roboBellByDay).every((n) => n === 1), roboBellByDay);
  const nextBrief = (spamUnlabeled.briefs || {})[dayYmd(1)];
  const summary = nextBrief && (nextBrief.quietLines || []).find((l) => l.indexOf(sp.people[0].digits.slice(6)) >= 0 && /called \d+ times/.test(l));
  console.log('    brief summary line (day 1): ' + JSON.stringify(summary || null));
  ok('F6: ...and the next morning\'s brief carries ONE summary line for the number', !!summary, nextBrief && nextBrief.quietLines);
  ok('F6 control: a labelled-spam number has no summary line (it is hidden, nothing to say)', !((spamLabelled.briefs || {})[dayYmd(1)] || { quietLines: [] }).quietLines.some((l) => l.indexOf(sp.people[0].digits.slice(6)) >= 0));
  ok('F6 control: the number is still OPEN on Home (never dropped): the end-of-day open count includes it', spamUnlabeled.openByDay[dayYmd(0)] >= 1, spamUnlabeled.openByDay);
  ok('a labelled spam/hide number is silent apart from the ONE designed "hidden number is calling a lot" push', roboPushTotal(spamLabelled) <= 1, roboPushTotal(spamLabelled));

  // ── D. same customer, six calls in a day ────────────────────────────────
  console.log('D. one customer calls six times in a day');
  const rc = repeatCaller();
  const repIgnore = await run(rc, 'ignores');
  const repAtt = await run(rc, 'attentive');
  results.repeat = summarize(repIgnore); results.repeatAtt = summarize(repAtt);
  printRow(results.repeat); printRow(results.repeatAtt);
  const custKey = keyOf(rc.people[0]);
  const urgentPushesDay0 = repIgnore.events.filter((e) => e.ch === 'push' && e.src === 'urgent' && e.keys[0] === custKey && etYmd(e.t) === dayYmd(0)).length;
  const ladderEmailsByDay = {};
  repIgnore.events.filter((e) => e.ch === 'email' && e.src === 'ladder' && e.keys.includes(custKey)).forEach((e) => { ladderEmailsByDay[etYmd(e.t)] = (ladderEmailsByDay[etYmd(e.t)] || 0) + 1; });
  const ladderEmailsPerson = Math.max(0, ...Object.values(ladderEmailsByDay));
  const pushesPersonDay0 = repIgnore.perPersonDay.get(custKey + '|' + dayYmd(0));
  console.log('    day 0: urgent immediate pushes ' + urgentPushesDay0 + ', total push+email for that person ' + (pushesPersonDay0 ? pushesPersonDay0.push + pushesPersonDay0.email : 0) + ', ladder emails over the run ' + ladderEmailsPerson);
  finding('F-REPEAT-URGENT', 'each urgent call from the same person pushes separately (no per-person collapse)', urgentPushesDay0 >= 2, urgentPushesDay0 + ' immediate pushes for one person in a day');
  {
    const pd = (M, ymd) => M.perPersonDay.get(custKey + '|' + ymd) || { push: 0, email: 0 };
    const adaysPush = pd(repIgnore, dayYmd(0)).push, adaysLadder = ladderEmailsByDay[dayYmd(0)] || 0;
    const day0 = repIgnore.events.filter((e) => e.keys.includes(custKey) && etYmd(e.t) === dayYmd(0));
    console.log('    AFTER: day 0 for that person: pushes ' + adaysPush + ', ladder emails ' + adaysLadder + ' (design 3 pushes + 1 email)');
    ok('F4: the repeat caller gets at most the designed 3 pushes in a day', adaysPush <= 3 && adaysPush >= 1, adaysPush);
    ok('F4: ...ONE immediate urgent push (the second urgent call is folded into the open one)', urgentPushesDay0 === 1, urgentPushesDay0);
    ok('F4: ...and at most one ladder email per person per day', Object.values(ladderEmailsByDay).every((n) => n <= 1), ladderEmailsByDay);
    ok('F4 never silent for a NEW kind: the promise (a different kind) after the urgent call was pushed', day0.some((e) => e.ch === 'push' && e.whys.some((w) => /promised/.test(w))), day0.filter((e) => e.ch === 'push').map((e) => e.src + ':' + (e.whys || []).join('/').slice(0, 50)));
    ok('F4: the folded second urgent call is carried by the next re-tell ("+1 more call"), not lost', (repIgnore.pushTexts || []).some((p) => /\+1 more call/.test(p.body)), (repIgnore.pushTexts || []).map((p) => p.body));
    const row2 = repIgnore.S.cols.phone_calls.filter((c) => c.urgentFoldedAtMs);
    ok('F4 control: exactly one of the two urgent calls was folded (stamped as told, the person is still open)', row2.length >= 1 && repIgnore.openByDay[dayYmd(0)] === 1, [row2.length, repIgnore.openByDay]);
    // Attentive Jo handles Pat between the two urgent calls: the second one is a NEW need -> pushed.
    const attDay0Urgent = repAtt.events.filter((e) => e.ch === 'push' && e.src === 'urgent' && e.keys[0] === custKey && etYmd(e.t) === dayYmd(0)).length;
    ok('F4 control: after Jo HANDLES the person, a new urgent call pushes immediately again (not folded)', attDay0Urgent === 2, attDay0Urgent);
  }
  finding('F-LADDER-PER-CALL', 'the ladder climbs per CALL, so one person can get more ladder emails than the designed one', ladderEmailsPerson > 1, ladderEmailsPerson + ' ladder emails for one person');

  // ── E. a promise missed three times ─────────────────────────────────────
  console.log('E. a promise snoozed three times');
  const pm = promiseMissed();
  const pmRun = await run(pm, 'ignores');
  results.promiseMissed = summarize(pmRun); printRow(results.promiseMissed);
  const pmKey = keyOf(pm.people[0]);
  const pmPushes = pmRun.events.filter((e) => e.ch === 'push' && e.keys.includes(pmKey));
  console.log('    pushes for that person: ' + pmPushes.length + ' at ' + pmPushes.map((e) => new Date(e.t).toISOString().slice(5, 16)).join(', '));
  ok('the snoozed promise is told on each wake day (call day + due + 3 wakes) and then stops', pmPushes.length >= 4 && pmPushes.length <= 7, pmPushes.length);

  // ── F. a call told while still 'stored' uses up its tell ────────────────
  console.log('F. an unknown-number call is told as "unknown number" while its transcript is still pending');
  {
    const iso = (t) => new Date(t).toISOString().slice(11, 16) + 'Z';
    const runCase = async (name, startT, extra, ev) => {
      const p = person('unk', name);
      const sim = await simulate(Object.assign({ name, people: [p], jo: 'ignores', days: 3, seed: 3, events: [Object.assign({ k: 'call', t: startT, p, lag: 10 }, ev)] }, extra || {}));
      const evs = sim.events.filter((e) => e.keys.includes(keyOf(p)) && e.ch !== 'bell');
      return { sim, p, evs, row: sim.S.cols.phone_calls[0], desc: evs.map((e) => e.ch + ':' + e.src + '@' + iso(e.t) + (e.whys && e.whys[0] ? '(' + e.whys[0].slice(0, 22) + ')' : '')).join(' '), pushes: evs.filter((e) => e.ch === 'push').length, ladderEmails: evs.filter((e) => e.src === 'ladder').length };
    };
    // F1: a promise from Jo on a new number. treated: ingested AT the 12:00 run tick, transcript 12:30.
    const f1t = await runCase('stored promise (treated)', at(dayYmd(0), 11, 50), {}, { promise: true });
    const f1c = await runCase('stored promise (control)', at(dayYmd(0), 10, 50), {}, { promise: true });
    console.log('    F1 treated: ' + f1t.desc);
    console.log('    F1 control: ' + f1c.desc);
    finding('F-STORED-PROMISE', 'a call the 12:00 run saw while "stored" is told once as "unknown number"; its promise never climbs the ladder', f1t.pushes < f1c.pushes, { treatedPushes: f1t.pushes, controlPushes: f1c.pushes, treatedLadderEmail: f1t.ladderEmails, controlLadderEmail: f1c.ladderEmails });
    // F2: an urgent call, transcripts held (daily cap / rate limit) until 22:00 ET, so pushUrgent is outside 08-20.
    const hold = at(dayYmd(0), 22, 0);
    const f2t = await runCase('stored urgent (treated)', at(dayYmd(0), 19, 50), { transcribeBlockedUntil: hold }, { urgent: true });
    const f2c = await runCase('stored urgent (control)', at(dayYmd(0), 20, 20), { transcribeBlockedUntil: hold }, { urgent: true });
    console.log('    F2 treated: ' + f2t.desc);
    console.log('    F2 control: ' + f2c.desc);
    const firstAfterNoted = (r) => { const x = r.evs.filter((e) => e.t > r.row.notedAtMs && e.src !== 'thursday')[0]; return x ? x.src + '@' + etYmd(x.t) + ' ' + etHour(x.t) + ':' + String(etMin(x.t)).padStart(2, '0') + ' ET' : 'none'; };
    const urgPushAfter = (r) => r.evs.some((e) => e.ch === 'push' && e.t > r.row.notedAtMs && /urgent/.test((e.whys || [])[0] || ''));
    console.log('    F2 first ping after the transcript: treated ' + firstAfterNoted(f2t) + ' | control ' + firstAfterNoted(f2c));
    finding('F-STORED-URGENT', 'an urgent call whose transcript lands after hours, and which a run saw while "stored", is never pushed as urgent (the control is, at 08:00)', urgPushAfter(f2c) && !urgPushAfter(f2t), { treated: firstAfterNoted(f2t), control: firstAfterNoted(f2c) });
    results.stored = { f1: { treated: f1t.pushes, control: f1c.pushes }, f2: { treated: firstAfterNoted(f2t), control: firstAfterNoted(f2c) } };
  }

  // ── G. nobody can receive a push: the email rung never fires ────────────
  console.log('G. no phone can receive a push (sent: 0) with an urgent call open');
  {
    const mk = async (dead) => {
      const p = person('cust', dead ? 'dead-token customer' : 'live-token customer');
      const sim = await simulate({ name: 'push ' + (dead ? 'dead' : 'live'), people: [p], jo: 'ignores', days: 2, seed: 4, pushDead: dead,
        events: [{ k: 'call', t: at(dayYmd(0), 9, 0), p, urgent: true, lag: 5 }] });
      return { sim, emails: sim.events.filter((e) => e.ch === 'email' && (e.src === 'ladder' || e.src === 'unreached')).length, unreached: sim.events.filter((e) => e.ch === 'email' && e.src === 'unreached').length, attempts: sim.events.filter((e) => e.ch === 'push' && e.src === 'watch').length, bells: Object.values(sim.days).reduce((a, d) => a + d.bell, 0) };
    };
    const dead = await mk(true), live = await mk(false);
    console.log('    push alive: ladder emails ' + live.emails + ', watch pushes ' + live.attempts + ', bells ' + live.bells + ' | push dead: ladder emails ' + dead.emails + ', watch push attempts ' + dead.attempts + ', bells ' + dead.bells);
    results.deadPush = { liveEmails: live.emails, deadEmails: dead.emails, deadAttempts: dead.attempts };
    ok('control: with a working push the rung-3 email goes out once', live.emails === 1, live.emails);
    finding('F-EMAIL-GATED-ON-PUSH', 'the email rung never fires when no push reaches a device (the rung advances only on a reached push)', dead.emails === 0 && dead.attempts >= 3, { emails: dead.emails, pushAttempts: dead.attempts });
    ok('F2: a dead token produces exactly ONE email for the item over 2 days (idempotent), not one per failed run', dead.emails === 1 && dead.unreached === 1, { emails: dead.emails, unreached: dead.unreached, attempts: dead.attempts });
    ok('F2 control: a live token sends no "phone did not get it" email', live.unreached === 0, live.unreached);
  }

  // ── H. longevity: open items for 50 days ────────────────────────────────
  console.log('H. one urgent customer call (no promise) and one dated promise, never handled, 50 days');
  {
    const p = person('cust', 'forgotten urgent'), q = person('cust', 'forgotten promise');
    const sim = await simulate({ name: 'longevity', people: [p, q], jo: 'ignores', days: 50, seed: 5,
      events: [{ k: 'call', t: at(dayYmd(0), 9, 0), p, urgent: true, lag: 5 }, { k: 'call', t: at(dayYmd(0), 9, 30), p: q, promise: true, fu: dayYmd(2), lag: 5 }] });
    const digestDays = (key) => { const m = {}; sim.events.filter((e) => e.ch === 'email' && (e.src === 'brief' || e.src === 'sweep') && e.keys.includes(key)).forEach((e) => { m[etYmd(e.t)] = (m[etYmd(e.t)] || 0) + 1; }); return m; };
    const pushFor = (key) => sim.events.filter((e) => e.ch === 'push' && e.keys.includes(key)).length;
    const dU = digestDays(keyOf(p)), dP = digestDays(keyOf(q));
    const emailsP = Object.values(dP).reduce((a, b) => a + b, 0);
    const open10 = sim.openByDay[dayYmd(10)], open30 = sim.openByDay[dayYmd(30)], open49 = sim.openByDay[dayYmd(49)];
    console.log('    urgent-no-task person: pushes ' + pushFor(keyOf(p)) + ', brief/sweep email days ' + Object.keys(dU).length + ' | promise person: pushes ' + pushFor(keyOf(q)) + ', brief/sweep email days ' + Object.keys(dP).length + ', total emails ' + emailsP + ' | Home people open: day 10 ' + open10 + ', day 30 ' + open30 + ', day 49 ' + open49 + ' | ledger bells ' + Object.values(sim.days).reduce((a, d) => a + d.ledgerBell, 0));
    results.longevity = { urgentPush: pushFor(keyOf(p)), urgentDigestDays: Object.keys(dU).length, promisePush: pushFor(keyOf(q)), promiseDigestDays: Object.keys(dP).length, promiseEmails: emailsP, open10, open30, open49 };
    finding('F-URGENT-NO-TASK', 'an urgent call on a customer with no follow-up task never reaches the brief / sweep email, yet stays open on Home', Object.keys(dU).length === 0 && open10 >= 1, { digestDays: Object.keys(dU).length, homeOpenDay10: open10 });
    ok('F5: the urgent filed call with no task is on the brief / sweep (day 0-1) and then rolls off with the 36 h window', Object.keys(dU).length >= 1 && Object.keys(dU).length <= 3, Object.keys(dU));
    finding('F-DIGEST-REPEAT', 'an unchanged open promise is emailed twice a day (06:45 brief + 15:15 sweep) for weeks', emailsP >= 40, emailsP + ' emails about one promise');
    const sweepDays = Object.keys(dP).filter((ymd) => sim.events.some((e) => e.ch === 'email' && e.src === 'sweep' && e.keys.includes(keyOf(q)) && etYmd(e.t) === ymd));
    console.log('    AFTER (F7): promise person emails ' + emailsP + ' over ' + Object.keys(dP).length + ' days; 15:15 sweeps that still sent: ' + sweepDays.length);
    ok('F7: the unchanged promise is emailed ONCE a day (brief), not twice - about 29 emails, was 57', emailsP <= Object.keys(dP).length + 2 && emailsP >= 25, [emailsP, Object.keys(dP).length]);
    const urgentSweepDay0 = sim.events.filter((e) => e.ch === 'email' && e.src === 'sweep' && e.keys.includes(keyOf(p)) && etYmd(e.t) === dayYmd(0)).length;
    ok('F7 positive control: a list that CHANGED since the brief still goes at 15:15 (the urgent call that arrived after 06:45, day 0)', urgentSweepDay0 === 1, urgentSweepDay0);
  }

  // ── I. quiet hours: calls at night ──────────────────────────────────────
  console.log('I. quiet hours: urgent calls 21:10-23:50, then a 03:00 call');
  {
    const p = person('cust', 'night customer'), q = person('unk', 'night prospect'), p2 = person('unk', 'night sales rep');
    const sim = await simulate({ name: 'night', people: [p, q, p2], jo: 'ignores', days: 2, seed: 6,
      events: [
        { k: 'call', t: at(dayYmd(0), 21, 10), p, urgent: true, lag: 5 },
        { k: 'call', t: at(dayYmd(0), 23, 50), p: q, urgent: true, lag: 5 },
        { k: 'call', t: at(dayYmd(1), 3, 0), p: q, urgent: true, lag: 5 },
        { k: 'thu', t: at(dayYmd(0), 22, 30), p: q, urgent: true },
        { k: 'thu', t: at(dayYmd(0), 22, 40), p: p2, urgent: false },
      ] });
    const nonThursday = sim.leaks.filter((l) => l.src !== 'thursday');
    const thursday = sim.leaks.filter((l) => l.src === 'thursday');
    console.log('    leaks outside 08:00-21:00 ET: callWatch/urgent/ladder ' + nonThursday.length + ', Thursday direct ' + thursday.length);
    const firstMorning = sim.events.filter((e) => e.ch === 'push' && e.src === 'watch').map((e) => new Date(e.t).toISOString().slice(11, 16) + 'Z');
    console.log('    first watch pushes: ' + firstMorning.slice(0, 3).join(', '));
    results.night = { nonThursday: nonThursday.length, thursday: thursday.length };
    ok('callWatch / urgent push / ladder never ping outside 08:00-21:00 ET', nonThursday.length === 0, nonThursday);
    // F8: the non-urgent call at 22:40 is HELD (no direct ping), told by the 08:00 watch run; the
    // urgent one at 22:30 (her emergency path) is NOT held and is not told twice.
    const heldRow = (sim.thursdayRows || []).find((r) => !r.urgent), urgRow = (sim.thursdayRows || []).find((r) => r.urgent);
    const directFor = (key) => sim.events.filter((e) => e.src === 'thursday' && e.keys.includes(key));
    const morningWatch = (row) => sim.events.filter((e) => e.ch === 'push' && e.src === 'watch' && e.ids.includes('thursday:' + row.id) && etYmd(e.t) === dayYmd(1) && etHour(e.t) >= 8);
    const watchRepeats = (row) => sim.events.filter((e) => e.ch === 'push' && e.src === 'watch' && e.ids.includes('thursday:' + row.id)).length;
    console.log('    AFTER: non-urgent Thursday call at 22:40: direct pings ' + directFor(heldRow.key).length + ', told by the morning watch run ' + morningWatch(heldRow).map((e) => etHour(e.t) + ':00 ET').join(',') + ' | urgent call at 22:30: direct pings ' + directFor(urgRow.key).length + ', repeated by the watch ' + watchRepeats(urgRow));
    finding('F-THURSDAY-NIGHT', 'Thursday\'s non-urgent push + email + SMS go out at night (22:40 here); not covered by the 21:00-08:00 rule', directFor(heldRow.key).length > 0, directFor(heldRow.key).length + ' direct pings at night');
    ok('F8: a non-urgent Thursday call at night is held: 0 direct pings between 21:00 and 08:00', directFor(heldRow.key).length === 0 && sim.leaks.filter((l) => l.src === 'thursday' && !urgRow).length === 0, directFor(heldRow.key));
    ok('F8: ...and told by the first watch run of the morning (08:00 ET), not dropped', morningWatch(heldRow).length === 1 && etHour(morningWatch(heldRow)[0].t) === 8, morningWatch(heldRow).length);
    ok('F8 emergency path intact: an URGENT Thursday call at 22:30 still pushes + emails at once', directFor(urgRow.key).filter((e) => e.ch === 'push').length === 1 && directFor(urgRow.key).filter((e) => e.ch === 'email').length === 1);
    ok('F8: ...and the morning watch run does not repeat it (her push was delivered)', watchRepeats(urgRow) === 0, watchRepeats(urgRow));
    ok('F8 positive control: a Thursday row whose own push did NOT go (held) is still in callWatch\'s view', sim.S.cols.thursday_calls.filter((r) => r.notifyState && r.notifyState.push && r.notifyState.push.status === 'held:quiet-hours').length === 1);
  }

  // ── J. what a customer-bucket/Thursday duplicate costs ──────────────────
  console.log('J. Thursday new lead, never reviewed: pings per call');
  {
    const p = person('unk', 'thursday caller');
    const sim = await simulate({ name: 'thursday dup', people: [p], jo: 'ignores', days: 2, seed: 8,
      events: [{ k: 'thu', t: at(dayYmd(0), 10, 10), p }] });
    const evs = sim.events.filter((e) => e.keys.includes(keyOf(p)));
    const desc = evs.map((e) => e.ch + ':' + e.src + '@' + new Date(e.t).toISOString().slice(11, 16)).join(' ');
    console.log('    one Thursday call: ' + desc);
    results.thursdayDup = { pings: evs.filter((e) => e.ch !== 'bell').length };
    finding('F-THURSDAY-DUP', 'one Thursday call pings Jo again at the next callWatch run ("not reviewed") on top of her own push + email', evs.some((e) => e.src === 'thursday') && evs.some((e) => e.src === 'watch'), desc);
    ok('F8: one Thursday call (daytime, her push delivered) = her push + email and NO callWatch repeat', evs.filter((e) => e.ch === 'push').length === 1 && evs.filter((e) => e.src === 'watch').length === 0, desc);
    // positive control: when her own push FAILED the watch still tells it
    const p2 = person('unk', 'thursday caller push failed');
    const sim2 = await simulate({ name: 'thursday push failed', people: [p2], jo: 'ignores', days: 2, seed: 8, thursdayQuiet: true,
      events: [{ k: 'thu', t: at(dayYmd(0), 10, 10), p: p2 }] });
    ok('F8 positive control: with her own push NOT delivered the watch run tells it (never silent)', sim2.events.filter((e) => e.ch === 'push' && e.src === 'watch' && e.keys.includes(keyOf(p2))).length === 1);
  }

  // ── N. a promise captured through the sheet: what tells Jo on its due date? ─
  console.log('N. "Handled" + the promise sheet (Call back in 2 days), Jo does not open the app');
  {
    const p = person('cust', 'sheet promise');
    const d0 = dayYmd(0), due = dayYmd(2);
    const sim = await simulate({ name: 'sheet promise', people: [p], jo: 'ignores', days: 5, seed: 12,
      events: [{ k: 'call', t: at(d0, 9, 0), p, promise: true, lag: 5 }],
      hook: async ({ t, h, mi, S, act }) => {
        if (etYmd(t) === d0 && h === 12 && mi === 15) {
          const row = S.cols.phone_calls.find((x) => x.leadId === p.leadId);
          if (row) await act(row.id, 'promise', { kind: 'callback', dueYmd: due }, t);
        }
      } });
    const after = sim.events.filter((e) => e.keys.includes(keyOf(p)) && e.ch !== 'bell' && e.t > at(d0, 12, 15));
    const task = Object.keys(sim.S.docs).filter((k) => k.indexOf('/tasks/promise-') > 0).map((k) => sim.S.docs[k])[0];
    const dueDayLedger = (sim.ledgers || {})[due];
    console.log('    promise task: ' + (task ? 'due ' + task.dueDate + ', open' : 'NOT CREATED') + '; server pings about this person after capture: ' + after.length + '; ledger on the due day: ' + JSON.stringify(dueDayLedger));
    results.sheetPromise = { taskDue: task && task.dueDate, pingsAfter: after.length, ledgerOnDue: dueDayLedger };
    ok('control: the sheet created the dated promise task', !!task && task.dueDate === due && task.done !== true, task);
    finding('F-PROMISE-TASK-SILENT', 'a promise captured through the Handled sheet is a task; nothing server-side pushes, emails or counts it on its due day (ledger says nothing is open)', !!task && after.length === 0 && dueDayLedger && dueDayLedger.open === 0, { pingsAfter: after.length, ledgerOpen: dueDayLedger && dueDayLedger.open });
    extraRuns.push({ tag: 'N', M: sim });
    const k = keyOf(p);
    const dueEv = (ch, src) => sim.events.filter((e) => e.ch === ch && e.src === src && e.keys.includes(k) && etYmd(e.t) === due);
    const promisePushes = dueEv('push', 'promise');
    const brief = dueEv('email', 'brief');
    console.log('    AFTER: on the due day (' + due + '): 08:00-run push ' + promisePushes.length + ' (' + promisePushes.map((e) => etHour(e.t) + ':' + String(etMin(e.t)).padStart(2, '0') + ' ET').join(',') + '), brief row ' + brief.length + ', ledger open ' + (dueDayLedger && dueDayLedger.open) + ' clear ' + (dueDayLedger && dueDayLedger.clear));
    results.sheetPromise.after = { pushes: promisePushes.length, briefRows: brief.length, ledgerOpen: dueDayLedger && dueDayLedger.open, ledgerClear: dueDayLedger && dueDayLedger.clear };
    ok('N: a promise due Thursday handled via the sheet gets ONE 08:00 ET push on its due day', promisePushes.length === 1 && etHour(promisePushes[0].t) === 8, promisePushes.map((e) => new Date(e.t).toISOString()));
    ok('N: ...a brief line on the due day', brief.length === 1, brief.length);
    ok('N: ...and the 20:00 ledger counts the person and never says nothing fell through', !!dueDayLedger && dueDayLedger.open >= 1, dueDayLedger);
    ok('N: nothing was pushed about it BEFORE the due day (a future date is parked, not nagging)', sim.events.filter((e) => e.ch === 'push' && e.src === 'promise' && etYmd(e.t) < due).length === 0);
  }

  // ── O. one person owed THREE things = one row, one push, one ledger person ──
  console.log('O. one person owed three promises on the same day');
  {
    const p = person('cust', 'three promises');
    const d0 = dayYmd(0), due = dayYmd(1);
    const sim = await simulate({ name: 'three promises', people: [p], jo: 'ignores', days: 3, seed: 13, events: [],
      hook: async ({ t, h, mi, S }) => {
        if (etYmd(t) === d0 && h === 12 && mi === 0) {
          ['a', 'b', 'c'].forEach((x, i) => {
            S.docs['leads/' + p.leadId + '/tasks/promise-' + x] = { kind: 'promise', promiseKind: i === 2 ? 'estimate' : 'callback', text: 'Item ' + x, done: false, dueDate: due, userId: OWNER, leadId: p.leadId };
          });
        }
      } });
    extraRuns.push({ tag: 'O', M: sim });
    const k = keyOf(p);
    const pushes = sim.events.filter((e) => e.ch === 'push' && e.src === 'promise');
    const first = pushes.filter((e) => etYmd(e.t) === due);
    const brief = sim.briefs[due];
    const rows = brief.items.filter((i) => i.leadId === p.leadId);
    const led = (sim.ledgers || {})[due];
    console.log('    due-day promise pushes ' + first.length + ' (title "' + ((sim.promisePushes || [])[0] || {}).title + '"), brief rows for the person ' + rows.length + ' (items listed: ' + (rows[0] ? rows[0].promises.length : 0) + '), ledger open ' + (led && led.open));
    results.threeItems = { pushes: first.length, briefRows: rows.length, itemsInRow: rows[0] ? rows[0].promises.length : 0, ledgerOpen: led && led.open, title: ((sim.promisePushes || [])[0] || {}).title };
    ok('O: three due items from one person = ONE push on the due day, titled by people ("1 promise due today")', first.length === 1 && sim.promisePushes[0].title === '1 promise due today', sim.promisePushes);
    ok('O: ...ONE brief row carrying all three items', rows.length === 1 && rows[0].promises.length === 3, rows.map((r) => r.promises));
    ok('O: ...the ledger counts ONE person', !!led && led.open === 1, led);
    ok('O: ...and the ladder tells them 3 times at most (rung limit), then the push stops', pushes.length <= 1 + 2 + 1, pushes.length);
  }

  // ── P. a failed task read is never an all-clear ─────────────────────────
  console.log('P. the task read fails (collectionGroup unavailable) on the due day');
  {
    const p = person('cust', 'unreadable');
    const d0 = dayYmd(0), due = dayYmd(1);
    const sim = await simulate({ name: 'task read fails', people: [p], jo: 'ignores', days: 3, seed: 14, events: [{ k: 'call', t: at(due, 9, 0), p, lag: 5 }],
      hook: async ({ t, h, mi, S }) => {
        if (etYmd(t) === d0 && h === 12 && mi === 0) S.docs['leads/' + p.leadId + '/tasks/promise-x'] = { kind: 'promise', promiseKind: 'callback', text: 'Call back', done: false, dueDate: due, userId: OWNER, leadId: p.leadId };
        if (etYmd(t) === due) S.failTaskRead = true;
      } });
    const led = (sim.ledgers || {})[due];
    console.log('    ledger on the due day: ' + JSON.stringify(led));
    extraRuns.push({ tag: 'P', M: sim });
    ok('P: a failed task read shows a promise-tasks warning on the ledger, never "nothing fell through" (a call exists today, so the warning is the only reason)', !!led && led.calls >= 1 && led.clear === false && /promise tasks/.test(led.anomalyText || ''), led);
    ok('P: ...and says nothing is due (no push) rather than inventing a person', sim.events.filter((e) => e.ch === 'push' && e.src === 'promise' && etYmd(e.t) === due).length === 0);
  }

  // ── Q. 08:00: a call alert AND a promise push become ONE push ─────────────
  console.log('Q. 08:00: an overnight urgent call and a promise due today');
  {
    const p = person('cust', 'overnight urgent'), q = person('cust', 'promise due today');
    const d0 = dayYmd(0), due = dayYmd(1);
    const sim = await simulate({ name: 'merged 08:00 push', people: [p, q], jo: 'ignores', days: 3, seed: 15,
      events: [{ k: 'call', t: at(d0, 21, 30), p, urgent: true, lag: 5 }],
      hook: async ({ t, h, mi, S }) => {
        if (etYmd(t) === d0 && h === 12 && mi === 0) S.docs['leads/' + q.leadId + '/tasks/promise-q'] = { kind: 'promise', promiseKind: 'callback', text: 'Call back about the estimate', done: false, dueDate: due, userId: OWNER, leadId: q.leadId };
      } });
    extraRuns.push({ tag: 'Q', M: sim });
    const at8 = sim.events.filter((e) => e.ch === 'push' && etYmd(e.t) === due && etHour(e.t) === 8);
    const mp = (sim.promisePushes || []).find((x) => x.merged);
    console.log('    pushes at 08:00 on the due day: ' + at8.length + (mp ? ' | merged title "' + mp.title + '" body "' + String(mp.body).slice(0, 110) + '"' : ' | NOT MERGED'));
    results.merged = { pushesAt8: at8.length, title: mp && mp.title };
    ok('e: the call alert and the promise push at 08:00 are ONE push (was two)', at8.length === 1, at8.map((e) => e.src));
    ok('e: ...that push names both: the person who needs Jo and the promise due today', !!mp && /need/.test(mp.title) && /promise due today/.test(mp.title) && mp.keys.includes(keyOf(q)) && at8[0].keys.includes(keyOf(p)), mp);
    ok('e control: nothing was dropped - the urgent call is on the bell and the promise has its own bell + ledger person', sim.events.filter((e) => e.ch === 'bell' && etYmd(e.t) === due && etHour(e.t) === 8).length === 2 && !!(sim.ledgers || {})[due] && sim.ledgers[due].open >= 2, [(sim.ledgers || {})[due]]);
    ok('e control: with no call alert the promise still goes alone (scenario N: one promise_due push)', Object.values(extraRuns.find((x) => x.tag === 'N').M.days).reduce((a, d) => a + d.promisePush, 0) === 1);
  }

  // ── invariants across all of the above ──────────────────────────────────
  console.log('K. invariants');
  const allRuns = [stormIgnore, stormAtt, quietIgnore, spamUnlabeled, spamLabelled, repIgnore, repAtt, pmRun];
  const tooMany = [];
  allRuns.forEach((M) => M.perId.forEach((r, id) => { if (/^call:|^text:/.test(id) && r.push > W.LADDER_MAX + 2) tooMany.push({ run: M.name.slice(0, 20), id, push: r.push }); }));
  ok('no single call / text day is pushed more than ladder (3) + due + wake times', tooMany.length === 0, tooMany.slice(0, 3));
  // Handling a person closes their card, so a NEW call from them pushes again: with the daily
  // person cap, total pushes are arrival-dominated (within a few of each other). What handling
  // must still do is stop the NAGGING: no ladder emails, far fewer re-tell pushes.
  const retellPushes = (M) => M.events.filter((e) => e.ch === 'push' && e.src === 'watch' && e.whys.some((w) => /still open \(reminder/.test(w))).length;
  ok('attentive Jo: far fewer ladder re-tell pushes and no ladder emails vs ignoring Jo (storm week)', retellPushes(stormAtt) < retellPushes(stormIgnore) && results.stormAtt.ladderEmailTotal === 0 && results.stormIgnore.ladderEmailTotal > 0, [retellPushes(stormAtt), retellPushes(stormIgnore)]);
  ok('attentive Jo: total pushes stay within 5% of ignoring Jo (arrivals, not nagging, drive the volume)', results.stormAtt.pushTotal <= results.stormIgnore.pushTotal * 1.05, [results.stormAtt.pushTotal, results.stormIgnore.pushTotal]);
  ok('the 20:00 ledger bell is written once a day at most', Object.values(stormIgnore.days).every((d) => d.ledgerBell <= 1));
  ok('at most ONE "N promises due today" push per day, over every run including the promise scenarios', allRuns.concat(extraRuns.map((x) => x.M)).every((M) => Object.values(M.days).every((d) => d.promisePush <= 1)));
  const tot = (tag) => Object.values(extraRuns.find((x) => x.tag === tag).M.days).reduce((a, d) => a + d.promisePush, 0);
  // never two pushes in the same watch run (call alert + promise push merged)
  const dupRun = [];
  allRuns.concat(extraRuns.map((x) => x.M)).forEach((M) => { const seen = new Map(); M.events.filter((e) => e.ch === 'push' && (e.src === 'watch' || e.src === 'promise')).forEach((e) => { seen.set(e.t, (seen.get(e.t) || 0) + 1); }); seen.forEach((n, t) => { if (n > 1) dupRun.push({ run: M.name.slice(0, 24), at: new Date(t).toISOString() }); }); });
  ok('no watch run sends two pushes (call alert + promise push are merged)', dupRun.length === 0, dupRun.slice(0, 3));
  // the person card: no person is pushed more than 3 + 1 sticky + new kinds in a day by watch / urgent
  const overCard = [];
  allRuns.forEach((M) => M.perPersonDay.forEach((r) => { if (r.push > 5) overCard.push({ run: M.name.slice(0, 24), key: r.key, ymd: r.ymd, push: r.push }); }));
  ok('person card: no person is pushed more than 5 times in a day in any scenario (was 7)', overCard.length === 0, overCard.slice(0, 3));
  ok('N sends exactly one promise push in total; O exactly one; P (read failed) none', tot('N') === 1 && tot('O') === 1 && tot('P') === 0, [tot('N'), tot('O'), tot('P')]);

  if (SHOW_TABLE) { console.log('\nRESULTS_JSON ' + JSON.stringify(results)); }
  console.log('\n' + passed + ' passed, ' + failed + ' failed (' + reproduced + ' documented defects reproduce, ' + resolved + ' resolved)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
