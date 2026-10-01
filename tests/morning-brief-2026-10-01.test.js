/**
 * tests/morning-brief-2026-10-01.test.js
 *
 * The 06:45 ET appointment brief (functions/morning-brief.js, pure logic in
 * functions/morning-brief-logic.js): one email to the OWNER listing today's
 * appointments with the CRM's property history.
 *
 *   1. ET day boundaries — 11:30 pm ET last night is yesterday, 12:15 am ET
 *      today is today (both are "today" or "yesterday" in UTC the other way)
 *   2. sources merged + sorted: Cal.com bookings, job days, a multi-day
 *      project on its MIDDLE day, a customer's other (non-active) job with its
 *      own title, an adjuster meeting typed as one
 *   3. property history: stage, other jobs, last activity, open balance in
 *      cents, storm lines from what is on file
 *   4. escaping: a lead name carrying <script> never reaches the HTML raw
 *   5. the run: nothing today → no send; dry run → no send; opt-out → no
 *      reads, no send; live → exactly one send, to the owner
 *   6. wiring pins: index export, gate name + registry, heartbeat onSchedule,
 *      schedule + timezone, send-path classified internal
 *
 * Every sender is a fake: firebase-functions, firebase-admin and resend are
 * stubbed at the module loader, and runMorningBrief takes makeResend as a
 * dependency. Nothing here can send a real email.
 *
 * Run: node tests/morning-brief-2026-10-01.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// ── Loader stubs: no real firebase, no real Resend ──────────────────────
let realResendConstructed = 0;
const STUBS = {
  './integrations/heartbeat': { onSchedule: (o, h) => ({ __opts: o, __handler: h }) },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  'firebase-admin/firestore': { getFirestore: () => { throw new Error('test must not reach real Firestore'); } },
  resend: { Resend: function () { realResendConstructed++; this.emails = { send: async () => { throw new Error('real Resend used in a test'); } }; } },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
const MB = require(path.join(FN, 'morning-brief-logic.js'));
const MOD = require(path.join(FN, 'morning-brief.js'));
Module._load = realLoad;
const { runMorningBrief } = MOD._test;

// 2026-10-01 10:45 UTC = 06:45 EDT, the cron's own minute.
const NOW = Date.parse('2026-10-01T10:45:00Z');
const OWNER = 'owner-uid';
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });

// ── In-memory Firestore ─────────────────────────────────────────────────
function makeDb(seed) {
  const docs = new Map(Object.entries(seed));
  const reads = [];
  const val = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : v);
  const test = (d, [f, op, v]) => {
    const a = val(d[f]), b = val(v);
    if (op === '==') return a === b;
    if (a == null) return false;
    if (op === '>=') return a >= b;
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
    throw new Error('op ' + op);
  };
  const snapOf = (k) => {
    const parts = k.split('/');
    return { id: parts[parts.length - 1], ref: { parent: { parent: parts.length >= 4 ? { id: parts[parts.length - 3] } : null } }, data: () => docs.get(k) };
  };
  function query(label, pick, st) {
    return {
      where: (f, op, v) => query(label, pick, Object.assign({}, st, { fl: st.fl.concat([[f, op, v]]) })),
      orderBy: (f, dir) => query(label, pick, Object.assign({}, st, { ob: [f, dir] })),
      limit: (n) => query(label, pick, Object.assign({}, st, { lim: n })),
      async get() {
        reads.push(label);
        let hits = [...docs.keys()].filter((k) => pick(k) && st.fl.every((c) => test(docs.get(k), c)));
        if (st.ob) {
          const [f, dir] = st.ob;
          hits.sort((x, y) => (val(docs.get(x)[f]) || 0) - (val(docs.get(y)[f]) || 0));
          if (dir === 'desc') hits.reverse();
        }
        if (st.lim) hits = hits.slice(0, st.lim);
        const out = hits.map(snapOf);
        return { docs: out, size: out.length, empty: !out.length, forEach: (fn) => out.forEach(fn) };
      },
    };
  }
  const col = (c) => {
    const depth = c.split('/').length + 1;
    return Object.assign(query(c, (k) => k.startsWith(c + '/') && k.split('/').length === depth, { fl: [] }), {
      doc: (id) => ({
        async get() { reads.push(c + '/' + id); const k = c + '/' + id; return { exists: docs.has(k), id, data: () => docs.get(k) }; },
        collection: (sub) => col(c + '/' + id + '/' + sub),
      }),
    });
  };
  return {
    reads,
    collection: col,
    collectionGroup: (name) => query('group:' + name, (k) => { const s = k.split('/'); return s.length >= 4 && s[s.length - 2] === name; }, { fl: [] }),
  };
}

const lead = (x) => Object.assign({ companyId: OWNER, userId: OWNER }, x);

function seedDay() {
  return {
    'users/owner-uid': { email: 'jo@example.test', displayName: 'Jo Deal' },
    // Bookings. 03:30Z = Sep 30 11:30 pm EDT (yesterday); 04:15Z = Oct 1 12:15 am EDT (today).
    'appointments/late-yesterday': { repUid: OWNER, userId: OWNER, title: 'Roof inspection', attendeeName: 'Night Owl', startTime: ts('2026-10-01T03:30:00Z'), endTime: ts('2026-10-01T04:30:00Z') },
    'appointments/just-after-midnight': { repUid: OWNER, userId: OWNER, title: 'Free roof inspection', attendeeName: 'Early Bird', attendeePhone: '(513) 555-0101', location: '1 Dawn Ct, Mason OH', startTime: ts('2026-10-01T04:15:00Z'), endTime: ts('2026-10-01T05:15:00Z') },
    'appointments/nine-am': { repUid: OWNER, title: 'Inspection', leadId: 'L1', startTime: ts('2026-10-01T13:00:00Z'), endTime: ts('2026-10-01T14:00:00Z') },
    'appointments/tomorrow': { repUid: OWNER, title: 'Inspection', startTime: ts('2026-10-02T13:00:00Z') },
    'appointments/cancelled': { repUid: OWNER, title: 'Inspection', status: 'cancelled', startTime: ts('2026-10-01T15:00:00Z') },
    // L1: booked at 9 am AND carrying today's scheduledDate → the booking is the visit, one line.
    'leads/L1': lead({ firstName: '<script>alert(1)</script>', lastName: 'Smith', address: '12 Elm St, Mason OH', phone: '513-555-0111', stage: 'new', jobType: 'insurance', scheduledDate: '2026-10-01', activeJobId: 'j1',
      stormEvents: [{ zoneName: 'Mason hail core', alertType: 'severe_thunderstorm', hailSize: '1.25"', effectiveAt: '2026-06-03T20:00:00Z' }] }),
    'leads/L1/jobs/j1': { companyId: OWNER, userId: OWNER, title: 'Roof replacement', stage: 'new' },
    'leads/L1/jobs/j0': { companyId: OWNER, userId: OWNER, title: 'Gutter guards', stage: 'closed', stageRole: 'won', closedAt: ts('2023-05-10T12:00:00Z') },
    'leads/L1/activity/a1': { type: 'note', label: 'Call', text: 'Said the <b>adjuster</b> came & went', createdAt: ts('2026-09-29T15:00:00Z') },
    'leads/L1/activity/a0': { type: 'note', text: 'older note', createdAt: ts('2026-09-01T15:00:00Z') },
    'leads/L1/storm_proofs/p1': { verified: true, maxSizeInches: 1.5, hitCount: 3, daysBack: 365, provider: 'noaa', strongestHit: { at: '2026-06-03T20:10:00Z' }, verifiedAt: ts('2026-09-20T12:00:00Z') },
    'invoices/i1': { leadId: 'L1', companyId: OWNER, balanceDue: 1250.5, status: 'sent' },
    'invoices/i2': { leadId: 'L1', companyId: OWNER, balanceDue: 100, status: 'partial' },
    'invoices/i3': { leadId: 'L1', companyId: OWNER, balanceDue: 999, status: 'void' },
    'invoices/i4': { leadId: 'L1', companyId: 'someone-else', balanceDue: 5000, status: 'sent' },
    // L2: a 3-day project that started yesterday at 7 am → today is day 2 of 3.
    'leads/L2': lead({ firstName: 'Mid', lastName: 'Project', address: '40 Oak Ave', stage: 'crew_scheduled', scheduledDate: '2026-09-30', scheduledEndDate: '2026-10-02', scheduledStart: '07:00' }),
    // L3: adjuster meeting today at 2 pm; the job itself is next week.
    'leads/L3': lead({ firstName: 'Claire', lastName: 'Claim', address: '9 Pine Rd', stage: 'claim_filed', scheduledDate: '2026-10-08', adjusterMeetingDate: '2026-10-01', adjusterMeetingStart: '14:00', adjusterName: 'Al Adjuster', insCarrier: 'State Farm' }),
    // L4: the active job is next week; the OTHER job (j1, a repair) is today at 3 pm.
    'leads/L4': lead({ firstName: 'Otto', lastName: 'Other', address: '5 Birch Ln', stage: 'new', activeJobId: 'j2', scheduledDate: '2026-10-09' }),
    'leads/L4/jobs/j2': { companyId: OWNER, userId: OWNER, title: 'Siding', stage: 'new', scheduledDate: '2026-10-09' },
    'leads/L4/jobs/j1': { companyId: OWNER, userId: OWNER, title: 'Leak repair — chimney', stage: 'crew_scheduled', scheduledDate: '2026-10-01', scheduledStart: '15:00', scheduledDurationMin: 90 },
    // L5: yesterday's job, L6 deleted with today's date — neither shows.
    'leads/L5': lead({ firstName: 'Yester', lastName: 'Day', scheduledDate: '2026-09-30' }),
    'leads/L6': lead({ firstName: 'Gone', lastName: 'Lead', scheduledDate: '2026-10-01', deleted: true }),
    // Another tenant's lead with today's date — never read in.
    'leads/X1': { companyId: 'other-co', userId: 'other-uid', firstName: 'Not', lastName: 'Ours', scheduledDate: '2026-10-01' },
  };
}

function fakeSender() {
  const sent = [];
  return { sent, makeResend: (key) => ({ emails: { send: async (m) => { sent.push(Object.assign({ key }, m)); return { data: { id: 'e1' }, error: null }; } } }) };
}
const quietLog = () => { const lines = []; return { lines, info: (m, d) => lines.push(['info', m, d]), warn: (m, d) => lines.push(['warn', m, d]), error: (m, d) => lines.push(['error', m, d]) }; };

(async () => {
  console.log('\n1. ET day boundaries (pure)');
  {
    const appts = [
      { id: 'y', title: 'Inspection', startTime: ts('2026-10-01T03:30:00Z') },   // 11:30 pm EDT Sep 30
      { id: 't', title: 'Inspection', startTime: ts('2026-10-01T04:15:00Z') },   // 12:15 am EDT Oct 1
      { id: 'late', title: 'Inspection', startTime: ts('2026-10-02T03:45:00Z') },// 11:45 pm EDT Oct 1
      { id: 'next', title: 'Inspection', startTime: ts('2026-10-02T04:05:00Z') },// 12:05 am EDT Oct 2
    ];
    const keys = MB.collectTodayItems({ appointments: appts, leads: [], jobs: [], nowMs: NOW }).map((i) => i.key);
    ok('11:30 pm ET yesterday is excluded (it is Oct 1 in UTC)', !keys.includes('appt:y'), JSON.stringify(keys));
    ok('12:15 am ET today is included (it is Oct 1 04:15 UTC)', keys.includes('appt:t'));
    ok('11:45 pm ET today is included even though it is Oct 2 in UTC', keys.includes('appt:late'));
    ok('12:05 am ET tomorrow is excluded', !keys.includes('appt:next'));
    const item = MB.collectTodayItems({ appointments: [appts[1]], leads: [], jobs: [], nowMs: NOW })[0];
    ok('its time reads in ET: 12:15 am', /^12:15/.test(item.timeLabel), item.timeLabel);
    // Winter (EST, UTC-5): 2026-12-01 04:30Z = Nov 30 11:30 pm EST.
    const winterNow = Date.parse('2026-12-01T11:45:00Z');
    const w = MB.collectTodayItems({ appointments: [{ id: 'w', startTime: ts('2026-12-01T04:30:00Z') }, { id: 'w2', startTime: ts('2026-12-01T05:15:00Z') }], leads: [], jobs: [], nowMs: winterNow }).map((i) => i.key);
    ok('winter offset too: 11:30 pm EST out, 12:15 am EST in', !w.includes('appt:w') && w.includes('appt:w2'), JSON.stringify(w));
  }

  console.log('\n2. sources merged + sorted (pure, via the run\'s reads)');
  const seed = seedDay();
  const docsOf = (prefix) => Object.entries(seed).filter(([k]) => k.startsWith(prefix) && k.split('/').length === 2).map(([k, v]) => Object.assign({ id: k.split('/')[1] }, v));
  const leads = docsOf('leads/').filter((l) => l.companyId === OWNER);
  const jobs = Object.entries(seed).filter(([k]) => /^leads\/[^/]+\/jobs\//.test(k)).map(([k, v]) => Object.assign({}, v, { id: k.split('/')[3], leadId: k.split('/')[1] }));
  const appointments = docsOf('appointments/');
  const items = MB.collectTodayItems({ appointments, leads, jobs, nowMs: NOW });
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
  const order = items.map((i) => i.key);
  ok('all five of today\'s visits are on the list, and only them',
    order.length === 5 && ['appt:just-after-midnight', 'appt:nine-am', 'job:L2/-', 'adj:L3/-', 'job:L4/j1'].every((k) => order.includes(k)), JSON.stringify(order));
  ok('yesterday\'s and tomorrow\'s booking, a cancelled one, yesterday\'s job, a deleted lead → none listed',
    !order.some((k) => /late-yesterday|tomorrow|cancelled|L5|L6/.test(k)));
  ok('L1 is booked today AND has today\'s scheduledDate → one line (the booking), not two', !order.includes('job:L1/j1') && byKey['appt:nine-am'].leadId === 'L1');
  ok('sorted by time: 12:15 am, 7:00 am (project), 9:00 am, 2:00 pm (adjuster), 3:00 pm (other job)',
    JSON.stringify(order) === JSON.stringify(['appt:just-after-midnight', 'job:L2/-', 'appt:nine-am', 'adj:L3/-', 'job:L4/j1']), JSON.stringify(order));
  ok('the multi-day project shows on its middle day as day 2 of 3, an install', /day 2 of 3/.test(byKey['job:L2/-'].timeLabel) && byKey['job:L2/-'].type === MB.TYPE.INSTALL, JSON.stringify(byKey['job:L2/-']));
  ok('the adjuster meeting is typed as one, at 2:00 pm', byKey['adj:L3/-'].type === MB.TYPE.ADJUSTER && /^2:00 pm$/.test(byKey['adj:L3/-'].timeLabel), byKey['adj:L3/-'].timeLabel);
  ok('...and L3\'s own job (next week) is not today', !order.includes('job:L3/-'));
  ok('the other (non-active) job is included with its own title and window', byKey['job:L4/j1'].title === 'Leak repair — chimney' && /3:00–4:30 pm/.test(byKey['job:L4/j1'].timeLabel), JSON.stringify(byKey['job:L4/j1']));
  ok('...typed from its words (repair), not the stage', byKey['job:L4/j1'].type === MB.TYPE.REPAIR);
  ok('...while L4\'s active job (next week) is not listed', !order.includes('job:L4/j2'));
  ok('a Cal.com booking with no CRM lead still lists its attendee, phone, address', byKey['appt:just-after-midnight'].name === 'Early Bird' && byKey['appt:just-after-midnight'].address === '1 Dawn Ct, Mason OH' && byKey['appt:just-after-midnight'].type === MB.TYPE.INSPECTION);
  ok('a multi-day project with no start time reads "All day · day 2 of 3" and sorts first',
    (() => { const it = MB.collectTodayItems({ appointments: [{ id: 'a', startTime: ts('2026-10-01T12:00:00Z') }], leads: [{ id: 'P', firstName: 'P', scheduledDate: '2026-09-30', scheduledEndDate: '2026-10-02' }], jobs: [], nowMs: NOW }); return it[0].key === 'job:P/-' && it[0].timeLabel === 'All day · day 2 of 3'; })());

  console.log('\n3. property history + render (pure)');
  const brief = MB.buildBrief({
    appointments, leads, jobs, nowMs: NOW,
    invoices: ['i1', 'i2', 'i3'].map((id) => Object.assign({ id }, seed['invoices/' + id])),
    activityByLead: { L1: [seed['leads/L1/activity/a0'], seed['leads/L1/activity/a1']] },
    stormProofsByLead: { L1: [seed['leads/L1/storm_proofs/p1']] },
  });
  const l1 = brief.items.find((i) => i.key === 'appt:nine-am').history;
  ok('stage + job type from the CRM', l1.stage === 'new' && l1.jobType === 'insurance', JSON.stringify(l1));
  ok('other jobs: count + title + year (the active j1 excluded)', l1.otherJobs.count === 1 && l1.otherJobs.list[0].title === 'Gutter guards' && l1.otherJobs.list[0].year === '2023', JSON.stringify(l1.otherJobs));
  ok('last activity is the NEWEST row', /adjuster/.test(l1.lastActivity.snippet) && !/older/.test(l1.lastActivity.snippet));
  ok('open balance in cents, void skipped: $1,250.50 + $100 = 135050', l1.balanceCents === 135050, String(l1.balanceCents));
  ok('storm lines from the stored proof and stormEvents[]', l1.storm.length === 2 && /Verified hail up to 1.5"/.test(l1.storm[0]) && /Mason hail core/.test(l1.storm[1]), JSON.stringify(l1.storm));
  ok('a lead with nothing on file gets no storm lines', brief.items.find((i) => i.key === 'job:L2/-').history.storm.length === 0);
  ok('long notes are truncated', MB.lastActivity([{ text: 'x'.repeat(500), createdAt: 1 }]).snippet.length <= 160);
  ok('subject: count + first time, no homeowner text', brief.subject === 'Today (Thu, Oct 1): 5 appointments — first at 12:15 am', brief.subject);
  ok('html links each customer to the CRM by id', brief.html.includes('https://nobigdealwithjoedeal.com/pro/customer.html?id=L1') && brief.html.includes('customer.html?id=L4'));
  ok('html carries a Google Maps link for the address', brief.html.includes('https://www.google.com/maps/search/?api=1&amp;query=12%20Elm%20St%2C%20Mason%20OH'));
  ok('html shows the balance, the other job, the adjuster', brief.html.includes('Open balance: $1,350.50') && brief.html.includes('Gutter guards (2023)') && brief.html.includes('State Farm'));
  ok('text part mirrors it', /Open balance: \$1,350\.50/.test(brief.text) && /customer\.html\?id=L2/.test(brief.text));

  console.log('\n4. escaping');
  ok('a <script> lead name never reaches the HTML raw', !/<script>/i.test(brief.html) && brief.html.includes('&lt;script&gt;alert(1)&lt;/script&gt; Smith'));
  ok('activity text is escaped too (<b> and &)', !brief.html.includes('<b>adjuster</b>') && brief.html.includes('&lt;b&gt;adjuster&lt;/b&gt; came &amp; went'));
  {
    const evil = MB.buildBrief({ appointments: [], leads: [{ id: 'E"><img src=x onerror=alert(1)>', firstName: 'A', address: '"><svg onload=1>', phone: '5135550000', scheduledDate: '2026-10-01' }], jobs: [], nowMs: NOW });
    ok('an id / address with quotes cannot break out of an href', !/<img|<svg/.test(evil.html) && evil.html.includes('id=E%22%3E%3Cimg'), evil.html.slice(evil.html.indexOf('class="item"'), evil.html.indexOf('class="item"') + 600));
  }

  console.log('\n5. the run (fake db, fake sender)');
  {
    const db = makeDb(seed);
    const s = fakeSender(); const log = quietLog();
    const out = await runMorningBrief({ db, env: {}, nowMs: NOW, makeResend: s.makeResend, log, owner: OWNER });
    ok('flag absent → dry run: built, logged, NOT sent', out.status === 'dry-run' && out.items === 5 && s.sent.length === 0, JSON.stringify(out));
    ok('...the dry run logs the subject', log.lines.some(([, m, d]) => m === 'morning_brief_dry_run' && /5 appointments/.test(d.subject)));
    ok('another tenant\'s lead never enters the brief', !db.reads.some((r) => /X1/.test(r)));
  }
  {
    const s = fakeSender();
    const out = await runMorningBrief({ db: makeDb(seed), env: { MORNING_BRIEF_ENABLED: 'false', RESEND_API_KEY: 're_test' }, nowMs: NOW, makeResend: s.makeResend, log: quietLog(), owner: OWNER });
    ok('flag "false" (or anything but "true") → still a dry run', out.status === 'dry-run' && s.sent.length === 0);
  }
  {
    const s = fakeSender();
    const out = await runMorningBrief({ db: makeDb(seed), env: { MORNING_BRIEF_ENABLED: 'true', RESEND_API_KEY: 're_test', EMAIL_FROM: 'NBD <jd@x.test>' }, nowMs: NOW, makeResend: s.makeResend, log: quietLog(), owner: OWNER });
    ok('flag "true" → exactly one email', out.status === 'sent' && s.sent.length === 1, JSON.stringify(out));
    ok('...to the OWNER\'s address, never a homeowner\'s', s.sent[0] && s.sent[0].to === 'jo@example.test' && !JSON.stringify(s.sent[0].to).includes('555'));
    ok('...with html + text + the subject', s.sent[0] && /<!DOCTYPE html>/.test(s.sent[0].html) && /5 appointments today/.test(s.sent[0].text) && /^Today \(/.test(s.sent[0].subject));
    ok('...history reached the live email (balance from the tenant\'s invoices only)', s.sent[0] && s.sent[0].html.includes('Open balance: $1,350.50'), s.sent[0] && (s.sent[0].html.match(/Open balance[^<]*/) || [''])[0]);
  }
  {
    const quiet = Object.fromEntries(Object.entries(seed).filter(([k]) => !/^appointments\/(just-after-midnight|nine-am)$/.test(k) && !/^leads\/(L2|L3|L4)(\/|$)/.test(k)));
    quiet['leads/L1'] = Object.assign({}, quiet['leads/L1'], { scheduledDate: '2026-10-05' });
    const s = fakeSender(); const log = quietLog();
    const out = await runMorningBrief({ db: makeDb(quiet), env: { MORNING_BRIEF_ENABLED: 'true', RESEND_API_KEY: 're_test' }, nowMs: NOW, makeResend: s.makeResend, log, owner: OWNER });
    ok('no appointments today → nothing sent, even live', out.status === 'nothing-today' && s.sent.length === 0, JSON.stringify(out));
    ok('...and it is logged', log.lines.some(([, m]) => m === 'morning_brief_nothing_today'));
  }
  {
    const opted = Object.assign({}, seed, { 'users/owner-uid': { email: 'jo@example.test', morningBriefEnabled: false } });
    const db = makeDb(opted); const s = fakeSender();
    const out = await runMorningBrief({ db, env: { MORNING_BRIEF_ENABLED: 'true', RESEND_API_KEY: 're_test' }, nowMs: NOW, makeResend: s.makeResend, log: quietLog(), owner: OWNER });
    ok('opt-out (morningBriefEnabled === false) → no send', out.status === 'opted-out' && s.sent.length === 0);
    ok('...and no CRM reads at all', db.reads.length === 1 && db.reads[0] === 'users/owner-uid', JSON.stringify(db.reads));
  }
  {
    const s = fakeSender();
    const out = await runMorningBrief({ db: makeDb(Object.assign({}, seed, { 'users/owner-uid': { email: 'jo@example.test', morningBriefEnabled: true } })), env: { MORNING_BRIEF_ENABLED: 'true', RESEND_API_KEY: 're_test' }, nowMs: NOW, makeResend: s.makeResend, log: quietLog(), owner: OWNER });
    ok('morningBriefEnabled true / absent → sends (default on)', out.status === 'sent' && s.sent.length === 1);
  }
  {
    const s = { sent: [], makeResend: () => ({ emails: { send: async (m) => { s.sent.push(m); return { data: null, error: { message: 'domain not verified' } }; } } }) };
    const log = quietLog();
    const out = await runMorningBrief({ db: makeDb(seed), env: { MORNING_BRIEF_ENABLED: 'true', RESEND_API_KEY: 're_test' }, nowMs: NOW, makeResend: s.makeResend, log, owner: OWNER });
    ok('a Resend API rejection is reported as rejected, not sent', out.status === 'rejected' && log.lines.some(([lvl, m]) => lvl === 'error' && m === 'morning_brief_send_rejected'));
  }
  {
    const s = fakeSender();
    const out = await runMorningBrief({ db: makeDb(Object.assign({}, seed, { 'users/owner-uid': { email: 'not-an-email' } })), env: { MORNING_BRIEF_ENABLED: 'true', RESEND_API_KEY: 're_test' }, nowMs: NOW, makeResend: s.makeResend, log: quietLog(), owner: OWNER });
    ok('owner with no valid email → no send', out.status === 'no-email' && s.sent.length === 0);
  }
  ok('the real Resend constructor was never called', realResendConstructed === 0);

  console.log('\n6. wiring pins');
  {
    const opts = MOD.morningBrief.__opts;
    ok('onSchedule comes from the heartbeat wrapper', /require\('\.\/integrations\/heartbeat'\)/.test(fs.readFileSync(path.join(FN, 'morning-brief.js'), 'utf8')) && typeof MOD.morningBrief.__handler === 'function');
    ok("schedule '45 6 * * *' in America/New_York", opts.schedule === '45 6 * * *' && opts.timeZone === 'America/New_York', JSON.stringify(opts));
    ok('one instance at a time', opts.maxInstances === 1);
    const src = fs.readFileSync(path.join(FN, 'morning-brief.js'), 'utf8');
    ok('the gate is MORNING_BRIEF_ENABLED, compared to the literal "true"', /process\.env\.MORNING_BRIEF_ENABLED/.test(src) && /MORNING_BRIEF_ENABLED === 'true'/.test(src));
    ok('opt-out field is morningBriefEnabled === false', /morningBriefEnabled === false/.test(src));
    ok('send results go through resend-guard', /resendRejected\(/.test(src));
    const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
    ok('functions/index.js exports morningBrief', /exports\.morningBrief = require\('\.\/morning-brief'\)\.morningBrief/.test(idx));
    const { CRON_GATES } = require(path.join(FN, 'cron-gates.js'));
    ok('cron-gates registers MORNING_BRIEF_ENABLED (enabled polarity, morning-brief.js)', CRON_GATES.some((g) => g.name === 'MORNING_BRIEF_ENABLED' && g.polarity === 'enabled' && g.file === 'morning-brief.js'));
    const sup = fs.readFileSync(path.join(FN, 'email-suppression.js'), 'utf8');
    ok("SEND_PATHS classifies morning-brief.js as 'internal' (owner mail, not marketing)", /'morning-brief\.js': 'internal'/.test(sup));
    const md = fs.readFileSync(path.join(FN, 'FUNCTIONS_INDEX.md'), 'utf8');
    ok('FUNCTIONS_INDEX.md documents morningBrief', /\| `morningBrief` \| daily 06:45 ET \|/.test(md));
    const envFile = path.join(FN, '.env.nobigdeal-pro');
    // Jo turned it on 2026-10-01; the literal must stay 'true' (anything else is dry-run).
    ok('the flag is on in functions/.env.nobigdeal-pro (Jo, 2026-10-01)', fs.existsSync(envFile) && /^MORNING_BRIEF_ENABLED=true\r?$/m.test(fs.readFileSync(envFile, 'utf8')));
    const logic = fs.readFileSync(path.join(FN, 'morning-brief-logic.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
    ok('the logic module does no I/O (no firebase / resend / fetch)', !/firebase|resend|fetch\(|https?\.request/i.test(logic.replace(/https:\/\/[^'"`\s]+/g, '')));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFAILED:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
