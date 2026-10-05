/**
 * tests/production-flow-2026-10-04.test.js
 *
 * The after-contract production flow (Jo approved all 12 items, 2026-10-04).
 * The audit behind it: 8 committed jobs, only 2 with dates; no lead ever in
 * Permit / Materials Ordered / Materials Here / Crew Scheduled; the crew set
 * on 0 leads; 30 finished jobs with 0 After photos.
 *
 * Behaviour, not source shape: the real modules run against fakes —
 * an in-memory Firestore, a fake Google Calendar, a stubbed weather.gov
 * fetch, stubbed FCM. Nothing here touches the network or sends anything.
 *
 *   1  CRM-booked appointments → Google (trigger + reconcile + busy), the
 *      .ics feed, the 30-minute push and the morning brief
 *   2  the sub roster: certificate + double-booking warnings, the Google line
 *   3  "Send to sub" job sheet — no prices, no homeowner phone
 *   4  the production strip + permit "not required" passing the gate
 *   5  material orders → delivery events, warnings, no prices, HD SKUs
 *   6  weather.gov: parse, cache, User-Agent, warn-only lines
 *   7  rain-day push plan
 *   8  after install: the push, the soft Final Photos warning
 *   9  the 7-day busy strip
 *   10 signed jobs that need a week (brief + Today)
 *   11 the Crew Scheduled email is a filled DRAFT, never a direct send
 *   12 tomorrow's installs — pre-written, sent from Jo's phone
 *   13 rules + indexes the reads depend on
 *
 * Run: node tests/production-flow-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { pathToFileURL } = require('url');

process.env.NBD_OWNER_UID = 'OWNER';
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const JS = path.join(ROOT, 'docs', 'pro', 'js');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// The firebase-functions logger prints "[Push] Sent: 1 Failed: 0"; the
// manifest runner reads "/(\d+) failed/i" in any output as a failure — mute it.
const fnLogger = require(require.resolve('firebase-functions/v2', { paths: [FN] })).logger;
for (const level of ['debug', 'log', 'info', 'warn', 'error']) fnLogger[level] = () => {};

const SW = require(path.join(FN, 'schedule-window.js'));
const CF = require(path.join(FN, 'calendar-feed-logic.js'));
const G = require(path.join(FN, 'google-calendar-logic.js'));
const PF = require(path.join(FN, 'production-flow-logic.js'));
const PL = require(path.join(JS, 'production-logic.js'));
const SPL = require(path.join(JS, 'schedule-planner-logic.js'));

const NY = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const TODAY = NY(Date.now());
const day = (n) => SW.addDays(TODAY, n);

// ── a path-keyed in-memory Firestore ────────────────────────────────────
function fakeDb(seed) {
  const docs = {};
  for (const [k, v] of Object.entries(seed || {})) docs[k] = JSON.parse(JSON.stringify(v));
  const writes = [];
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, (k, x) => (x && x.constructor && /Transform|Sentinel/.test(x.constructor.name) ? 'TS' : x))));
  function ref(p) {
    const parts = p.split('/');
    const r = {
      id: parts[parts.length - 1], path: p,
      async get() { return { exists: !!docs[p], id: r.id, ref: r, data: () => clone(docs[p]) }; },
      async set(d, o) { writes.push(['set', p, d]); const c = clone(d); docs[p] = o && o.merge && docs[p] ? Object.assign(docs[p], c) : c; },
      async update(d) { writes.push(['update', p, d]); if (!docs[p]) throw new Error('NOT_FOUND ' + p); Object.assign(docs[p], clone(d)); },
      async create(d) { if (docs[p]) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } writes.push(['create', p, d]); docs[p] = clone(d); },
      collection: (c) => col(p + '/' + c),
    };
    r.parent = { id: parts[parts.length - 2], parent: parts.length > 2 ? ref(parts.slice(0, -2).join('/')) : null };
    return r;
  }
  const val = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : v);
  function match(d, [f, op, v]) {
    const a = val(d[f]), b = val(v);
    if (op === '==') return a === b;
    if (op === 'in') return Array.isArray(b) && b.includes(a);
    if (a == null) return false;
    if (op === '>=') return a >= b;
    if (op === '<=') return a <= b;
    if (op === '<') return a < b;
    if (op === '>') return a > b;
    throw new Error('op ' + op);
  }
  function query(pick, st) {
    return {
      where: (f, op, v) => query(pick, Object.assign({}, st, { fl: st.fl.concat([[f, op, v]]) })),
      limit: (n) => query(pick, Object.assign({}, st, { lim: n })),
      orderBy: () => query(pick, st),
      startAfter: (d) => query(pick, Object.assign({}, st, { after: d.path || d._path })),
      async get() {
        let keys = Object.keys(docs).filter((k) => pick(k) && st.fl.every((c) => match(docs[k], c))).sort();
        if (st.after) keys = keys.slice(keys.indexOf(st.after) + 1);
        if (st.lim != null) keys = keys.slice(0, st.lim);
        const out = keys.map((k) => { const r = ref(k); return { id: r.id, path: k, _path: k, ref: r, data: () => clone(docs[k]) }; });
        return { docs: out, size: out.length, empty: !out.length, forEach: (fn) => out.forEach(fn) };
      },
    };
  }
  function col(c) {
    const depth = c.split('/').length + 1;
    return Object.assign(query((k) => k.startsWith(c + '/') && k.split('/').length === depth, { fl: [] }), {
      doc: (id) => ref(c + '/' + id),
      async add(d) { const id = 'auto' + Object.keys(docs).length; await ref(c + '/' + id).set(d); return ref(c + '/' + id); },
    });
  }
  return {
    _docs: docs, _writes: writes,
    doc: (p) => ref(p),
    collection: col,
    collectionGroup: (name) => query((k) => { const s = k.split('/'); return s.length >= 4 && s.length % 2 === 0 && s[s.length - 2] === name; }, { fl: [] }),
  };
}

// ── a fake Google Calendar (records every event) ────────────────────────
function fakeGoogle() {
  const g = { events: {}, calls: [] };
  const err = (code) => Object.assign(new Error('HTTP ' + code), { code });
  g.client = {
    email: async () => 'svc@zzqa.iam.gserviceaccount.com',
    request: async ({ url, method, data, params }) => {
      const p = url.replace('https://www.googleapis.com/calendar/v3', '');
      g.calls.push(method + ' ' + p);
      let m;
      if ((m = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(p))) {
        const key = decodeURIComponent(m[1]) + '|' + m[2];
        if (method === 'PUT') { if (!g.events[key]) throw err(404); g.events[key] = Object.assign({}, data); return { data }; }
        if (method === 'DELETE') { if (!g.events[key] || g.events[key].status === 'cancelled') throw err(410); g.events[key] = Object.assign({}, g.events[key], { status: 'cancelled' }); return { data: {} }; }
      }
      if ((m = /^\/calendars\/([^/]+)\/events$/.exec(p))) {
        const cal = decodeURIComponent(m[1]);
        if (method === 'POST') { g.events[cal + '|' + data.id] = Object.assign({}, data); return { data }; }
        if (method === 'GET') {
          const items = Object.entries(g.events).filter(([k, e]) => k.startsWith(cal + '|') && e.status !== 'cancelled'
            && (!params || !params.privateExtendedProperty || (e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.nbdManaged === '1'))).map(([, e]) => e);
          return { data: { items } };
        }
      }
      if (p === '/freeBusy' && method === 'POST') return { data: { calendars: {} } };
      throw new Error('unexpected ' + method + ' ' + p);
    },
  };
  g.live = (cal) => Object.entries(g.events).filter(([k, e]) => k.startsWith(cal + '|') && e.status !== 'cancelled').map(([, e]) => e);
  return g;
}

const L = (id, f) => Object.assign({ companyId: 'OWNER', userId: 'OWNER', firstName: 'ZZ_QA', lastName: id, address: id + ' ZZQA St, Cincinnati, OH', phone: '(513) 555-0199', stage: 'crew_scheduled' }, f);
const isoAt = (ymd, hm) => new Date(SW.localToUtcMs(ymd, hm)).toISOString();

(async () => {
  const GC = require(path.join(FN, 'google-calendar.js'));
  GC._internal.setWeather(async () => null);

  // ═══ 1. CRM-booked appointments go everywhere ═══════════════════════════
  console.log('\n1. CRM-booked appointments (leads/{id}/tasks type:\'event\')');
  {
    const task = { type: 'event', title: 'Roof inspection', eventAt: isoAt(day(2), '14:30'), notes: 'Side door', userId: 'OWNER', leadId: 'A' };
    const lead = L('Alpha');
    const a = CF.leadEventToAppointment(task, lead, 'A', 't1');
    ok('an event task → an appointment-shaped doc (an hour, with the customer and address)', a && a.startTime === Date.parse(task.eventAt) && a.endTime - a.startTime === 3600000
      && /Roof inspection — ZZ_QA Alpha/.test(a.title) && a.location === lead.address && a.leadId === 'A');
    ok('a plain task, a deleted event, an event on a deleted lead → nothing',
      CF.leadEventToAppointment({ title: 'Call back', eventAt: task.eventAt }, lead, 'A', 't2') === null
      && CF.leadEventToAppointment(Object.assign({}, task, { deleted: true }), lead, 'A', 't1') === null
      && CF.leadEventToAppointment(task, Object.assign({}, lead, { deleted: true }), 'A', 't1') === null);
    const ics = CF.buildCalendar({ appointments: [a], leads: [], nowMs: Date.now() });
    ok('.ics: the CRM event is a timed VEVENT with its own UID', /UID:evt-A-t1@nobigdealwithjoedeal\.com/.test(ics) && /SUMMARY:Roof inspection — ZZ_QA Alpha/.test(ics));

    const ev = G.desiredEventForLeadEvent(task, lead, 'A', 't1');
    ok('Google: a timed BUSY event, New York time, valid stable id', ev && ev.start.dateTime && ev.start.timeZone === 'America/New_York' && ev.transparency === 'opaque'
      && /^[a-v0-9]{5,1024}$/.test(ev.id) && ev.id === G.leadEventEventId('A', 't1') && ev.id !== G.eventIdFor('job', 'A'));
    ok('...not keyed as the lead\'s own job, so "skip the lead being edited" never hides it',
      !ev.extendedProperties.private.nbdLeadId && ev.extendedProperties.private.nbdEventLeadId === 'A'
      && G.jobsBusy([ev], 'A', SW.localToUtcMs).length === 1);
    ok('eventTaskFieldsChanged: a plain task never re-syncs; a moved event does',
      !G.eventTaskFieldsChanged({ title: 'x' }, { title: 'y' }) && G.eventTaskFieldsChanged(task, Object.assign({}, task, { eventAt: isoAt(day(3), '09:00') }))
      && !G.eventTaskFieldsChanged(task, Object.assign({}, task, { reminderSentAt: 'x' })));

    // trigger path + lead delete
    const g = fakeGoogle();
    GC._internal.setClient(g.client);
    await GC._internal.syncLeadEvent('cal', 'A', 't1', task, lead);
    ok('sync: the event lands on NBD Jobs', g.live('cal').some((e) => e.id === ev.id));
    await GC._internal.syncLeadEvent('cal', 'A', 't1', task, { companyId: 'other', userId: 'other' });
    ok('...another tenant\'s lead → removed (platform tenant only)', !g.live('cal').some((e) => e.id === ev.id));
    const db = fakeDb({ 'leads/A': lead, 'leads/A/tasks/t1': task, 'leads/A/tasks/t2': { title: 'plain task', userId: 'OWNER' } });
    await GC._internal.syncLeadEvents(db, 'cal', 'A', lead);
    ok('a lead edit re-syncs its events (plain tasks ignored)', g.live('cal').filter((e) => e.extendedProperties.private.nbdKind === 'event').length === 1);
    await GC._internal.syncLeadEvents(db, 'cal', 'A', null);
    ok('...and a deleted lead takes its events with it', g.live('cal').filter((e) => e.extendedProperties.private.nbdKind === 'event').length === 0);

    // reconcile keeps them (planSync deletes anything not desired)
    const g2 = fakeGoogle();
    GC._internal.setClient(g2.client);
    const rdb = fakeDb({ 'leads/A': lead, 'leads/A/tasks/t1': task });
    const r1 = await GC._internal.reconcile(rdb, 'cal2');
    ok('reconcile: CRM events are desired (counted, created)', r1.events === 1 && g2.live('cal2').some((e) => e.id === ev.id), JSON.stringify(r1));
    const r2 = await GC._internal.reconcile(rdb, 'cal2');
    ok('...and the next night leaves them alone (no delete, no churn)', r2.deleted === 0 && r2.upserted === 0 && g2.live('cal2').some((e) => e.id === ev.id), JSON.stringify(r2));
    delete rdb._docs['leads/A/tasks/t1'];
    await GC._internal.reconcile(rdb, 'cal2');
    ok('...a removed event is deleted from Google', !g2.live('cal2').some((e) => e.id === ev.id));
    GC._internal.setClient(g.client);
  }

  // .ics feed handler: CRM events reach the phone
  {
    console.log('\n1b. the .ics feed serves CRM events');
    const feedMod = require(path.join(FN, 'calendar-feed.js'));
    const src = fs.readFileSync(path.join(FN, 'calendar-feed.js'), 'utf8');
    ok('feed reads collectionGroup(\'tasks\') by the rep\'s uid in its own try (never 503s on it)',
      /collectionGroup\('tasks'\)\.where\('userId', '==', uid\)/.test(src) && /CRM events read failed — serving the rest/.test(src) && typeof feedMod.getCalendarFeed === 'function');
  }

  // 30-minute push + after-install push (real handlers, stubbed admin SDK)
  console.log('\n1c / 8. pushes (onAppointmentReminder, onAfterInstallDay)');
  {
    const sent = [];
    let pdb = fakeDb({});
    const fakeMessaging = { sendEachForMulticast: async (msg) => { sent.push(msg); return { successCount: msg.tokens.length, failureCount: 0, responses: msg.tokens.map(() => ({ success: true })) }; } };
    const stub = (request, exportsObj, from) => {
      const resolved = require.resolve(request, { paths: [from || FN] });
      const m = new Module(resolved); m.filename = resolved; m.loaded = true; m.exports = exportsObj; require.cache[resolved] = m;
    };
    stub('firebase-admin/firestore', {
      getFirestore: () => new Proxy({}, { get: (_, k) => (typeof pdb[k] === 'function' ? pdb[k].bind(pdb) : pdb[k]) }),
      Timestamp: { fromDate: (d) => d, now: () => new Date() },
      FieldValue: { serverTimestamp: () => '__ts__', increment: (n) => n },
    });
    stub('firebase-admin/messaging', { getMessaging: () => fakeMessaging });
    stub(path.join(FN, 'integrations', 'heartbeat.js'), { onSchedule: (o, h) => ({ __opts: o, __handler: h }) });
    delete require.cache[require.resolve(path.join(FN, 'push-functions.js'))];
    const push = require(path.join(FN, 'push-functions.js'));
    const tok = { 'users/OWNER/fcmTokens/d1': { token: 'tok-1' } };

    const soon = new Date(Date.now() + 12 * 60000).toISOString();
    pdb = fakeDb(Object.assign({}, tok, {
      'leads/A': L('Alpha'),
      'leads/A/tasks/t1': { type: 'event', title: 'Inspection', eventAt: soon, userId: 'OWNER' },
      'leads/A/tasks/t2': { title: 'plain task', eventAt: soon, userId: 'OWNER' },
      'leads/A/tasks/t3': { type: 'event', title: 'Already reminded', eventAt: soon, userId: 'OWNER', reminderSentAt: 'x' },
    }));
    await push.onAppointmentReminder.__handler({});
    ok('a CRM event 12 min out → ONE reminder push to its rep, naming the customer, opening the customer page',
      sent.length === 1 && /Inspection — ZZ_QA Alpha starts in 1[12] minutes/.test(sent[0].notification.body) && /customer\.html\?id=A/.test(sent[0].webpush.data.clickUrl),
      JSON.stringify(sent.map((s) => s.notification)));
    ok('...marks reminderSentAt on the task, so the next 15-min tick stays quiet', !!pdb._docs['leads/A/tasks/t1'].reminderSentAt);
    await push.onAppointmentReminder.__handler({});
    ok('...the next tick sends nothing new', sent.length === 1);

    sent.length = 0;
    pdb = fakeDb(Object.assign({}, tok, {
      'leads/Y': L('Yesterday', { scheduledDate: day(-2), scheduledEndDate: day(-1), stage: 'install_in_progress' }),
      'leads/T': L('Today', { scheduledDate: day(0), stage: 'crew_scheduled' }),
      'leads/D': L('Done', { scheduledDate: day(-1), stage: 'install_complete' }),
    }));
    await push.onAfterInstallDay.__handler({});
    ok('the morning after the LAST job day → "Mark Install Done? Take After photos." (once, that job only)',
      sent.length === 1 && /Mark Install Done\? Take After photos\./.test(sent[0].notification.body) && /ZZ_QA Yesterday/.test(sent[0].notification.body), JSON.stringify(sent.map((s) => s.notification.body)));
    await push.onAfterInstallDay.__handler({});
    ok('...a second run the same morning pushes nothing (push_markers create() guard)', sent.length === 1);
    ok('afterInstallDue: not on the last day itself, not once marked done', !PF.afterInstallDue(L('x', { scheduledDate: day(0), stage: 'crew_scheduled' }), TODAY)
      && !PF.afterInstallDue(L('x', { scheduledDate: day(-1), stage: 'install_complete' }), TODAY)
      && PF.afterInstallDue(L('x', { scheduledDate: day(-1), stage: 'materials_delivered' }), TODAY));
  }

  // ═══ 2. the sub roster ══════════════════════════════════════════════════
  console.log('\n2. sub roster');
  {
    const c = PL.cleanSub({ name: '  Ridge Bros  ', phone: '513-555-0111', insuranceExpiry: '2026-12-31' });
    ok('cleanSub trims, defaults the trade, keeps the expiry', c.ok && c.sub.name === 'Ridge Bros' && c.sub.trade === 'Roofing' && c.sub.insuranceExpiry === '2026-12-31');
    ok('cleanSub refuses no name / a bad date', !PL.cleanSub({ name: ' ' }).ok && !PL.cleanSub({ name: 'X', insuranceExpiry: '12/31/26' }).ok);
    const sub = { id: 's1', name: 'Ridge Bros', insuranceExpiry: day(5) };
    ok('certStatus: ok / soon / expired / none, judged on the job\'s day', PL.certStatus(sub, day(-60)).state === 'ok' && PL.certStatus(sub, day(0)).state === 'soon'
      && PL.certStatus(sub, day(6)).state === 'expired' && PL.certStatus({ name: 'n' }, day(0)).state === 'none');
    const leads = [L('Other', { id: 'O', subId: 's1', scheduledDate: day(8), scheduledEndDate: day(9) }), L('Free', { id: 'F', subId: 's2', scheduledDate: day(8) })];
    const warns = PL.subWarnings(sub, { start: day(9), end: day(10) }, leads, 'ME', TODAY);
    ok('warns on an EXPIRED certificate before the job and on double-booking (warn, never block)',
      warns.some((w) => /expired/.test(w)) && warns.some((w) => /already on ZZ_QA Other/.test(w) && /still save/.test(w)), JSON.stringify(warns));
    ok('no double-booking warning for a different sub or non-overlapping days', PL.subConflicts(leads, 's1', { start: day(10), end: day(11) }, 'ME').length === 0
      && PL.subConflicts(leads, 's2', { start: day(9), end: day(9) }, 'ME').length === 0);
    ok('subFieldsFor: subId + the name in crew (every old reader shows crew); none → cleared', JSON.stringify(PL.subFieldsFor(sub)) === JSON.stringify({ subId: 's1', crew: 'Ridge Bros' })
      && JSON.stringify(PL.subFieldsFor(null)) === JSON.stringify({ subId: null, crew: '' }));
    const mig = PL.crewMigration([L('a', { id: 'a', crew: 'ridge bros' }), L('b', { id: 'b', crew: 'Old Crew' }), L('c', { id: 'c', crew: 'Ridge Bros', subId: 's1' })], [sub]);
    ok('crew migration: links free text naming a roster sub; lists the rest to add', mig.links.length === 1 && mig.links[0].subId === 's1' && mig.newNames.join() === 'Old Crew');
    const ev = G.desiredEventsForLead(Object.assign({ id: 'S' }, L('Sub', { scheduledDate: day(4), crew: 'Ridge Bros' })))[0];
    ok('Google: the sub\'s name goes in the job event description', /\nSub: Ridge Bros\n/.test(ev.description));
    ok('a sub change re-syncs the event (crew watched, job mirror too)', G.calendarFieldsChanged({ crew: '' }, { crew: 'Ridge Bros' }) && G.JOB_WATCHED.includes('crew'));
  }

  // ═══ 3. job sheet ═══════════════════════════════════════════════════════
  console.log('\n3. "Send to sub" job sheet');
  {
    const lead = L('Sheet', { scheduledDate: day(3), scheduledStart: '07:00', scheduledEndDate: day(4), scopeOfWork: 'Tear off, 28 SQ architectural, new drip edge', accessNotes: 'Gate code 4411, dog in back', jobValue: 18500, estimateAmount: 18500 });
    const orders = [{ store: 'Gulf Eagle Supply', deliveryDate: day(2), status: 'ordered', items: [{ qty: 84, unit: 'bundles', name: 'TAMKO Heritage shingles' }, { qty: 3, unit: 'rolls', name: 'Synthetic underlayment' }] }];
    const t = PL.jobSheet({ lead, orders, sub: { name: 'Ridge Bros' } });
    ok('address + a map link', t.includes(lead.address) && t.includes('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(lead.address)));
    ok('start date, time and days', /Start: \w+day, \w+ \d+ · 7:00 am/.test(t) && /Days: 2 \(through/.test(t));
    ok('scope, materials (quantities) and access notes', t.includes('Scope: Tear off, 28 SQ') && t.includes('- 84 bundles — TAMKO Heritage shingles') && t.includes('Access: Gate code 4411, dog in back'));
    ok('NO prices and NO homeowner phone', !/\$|18,?500/.test(t) && !t.includes('555-0199'), t);
    ok('even a $ typed into the scope is stripped', !/\$/.test(PL.jobSheet({ lead: Object.assign({}, lead, { scopeOfWork: 'Re-roof ($12,400 job)' }), orders: [] })));
    const src = fs.readFileSync(path.join(JS, 'production.js'), 'utf8');
    ok('it goes out through Jo\'s share sheet (NBDPhoneShare), never a server send', /NBDPhoneShare/.test(src) && !/sendSMS|sendEmail|fetch\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
  }

  // ═══ 4. production strip + permit ═══════════════════════════════════════
  console.log('\n4. production strip');
  {
    const lead = L('Strip', { scheduledDate: day(6), scheduledStart: '07:00', subId: 's1' });
    const steps = PL.stripSteps(lead, [{ store: 'Home Depot', orderedDate: day(-1), deliveryDate: day(7), status: 'ordered' }], { id: 's1', name: 'Ridge Bros', insuranceExpiry: day(90) }, TODAY);
    ok('five steps in order: Permit → Ordered → Delivery → Sub → Start', steps.map((s) => s.key).join() === 'permit,ordered,delivery,sub,start');
    ok('ordered shows store + date; delivery after the start is flagged', /Home Depot/.test(steps[1].value) && steps[1].done && /after the start day/.test(steps[2].warn));
    ok('sub + start filled', steps[3].value === 'Ridge Bros' && steps[3].done && steps[4].done && /7:00 am/.test(steps[4].value));
    const patch = PL.permitPatch({ state: 'none', city: 'Mason' }, lead, '2026-10-04T12:00:00.000Z');
    ok('"Not required" reuses #2128\'s permitNotRequired (+ its stamp), never a fake filed stamp', patch.permitNotRequired === true && patch.permitNotRequiredAt && patch.permitFiledAt === '' && patch.permitCity === 'Mason');
    const stages = await import(pathToFileURL(path.join(JS, 'crm-stages.js')).href);
    const atOrdered = Object.assign({}, lead, { jobType: 'cash', stage: 'materials_ordered' });
    ok('...which the Materials Ordered gate accepts', stages.missingRequiredFields(atOrdered).includes('permitFiledAt')
      && !stages.missingRequiredFields(Object.assign({}, atOrdered, patch)).includes('permitFiledAt'));
    const filed = PL.permitPatch({ state: 'filed', number: 'BP-2231', city: 'Mason' }, lead, 'NOW');
    ok('"Filed" stamps permitFiledAt with the number and city', filed.permitFiledAt === 'NOW' && filed.permitNumber === 'BP-2231' && filed.permitNotRequired === false
      && PL.stripSteps(Object.assign({}, lead, filed), [], null, TODAY)[0].value === 'Filed #BP-2231 · Mason');
    ok('a re-save keeps the first filed stamp', PL.permitPatch({ state: 'filed' }, { permitFiledAt: 'FIRST' }, 'NOW').permitFiledAt === 'FIRST');
  }

  // ═══ 5. material orders ═════════════════════════════════════════════════
  console.log('\n5. material orders');
  {
    const lead = L('Order', { scheduledDate: day(5) });
    const items = PL.orderItemsFromList({ groups: [{ store: 'Gulf Eagle Supply', cost: 4100, items: [{ name: 'Shingles', code: 'RFG 240', buyQty: 84, buyUnit: 'bundles', cost: 3900 }] }] });
    ok('the materials list saved into an order carries quantities, never cost', items.length === 1 && items[0].qty === 84 && !('cost' in items[0]) && !JSON.stringify(items).includes('3900'));
    const c = PL.cleanOrder({ store: 'Home Depot', orderedDate: day(0), deliveryDate: day(6), items }, lead);
    ok('cleanOrder: owner + tenant copied from the lead (the rules pin them), status from the dates', c.ok && c.order.userId === 'OWNER' && c.order.companyId === 'OWNER' && c.order.status === 'ordered');
    ok('cleanOrder refuses a delivery before the order', !PL.cleanOrder({ store: 'HD', orderedDate: day(3), deliveryDate: day(1) }, lead).ok);
    ok('a delivery after the start day warns; on/before it does not', /after the start day/.test(PL.deliveryWarning(c.order, lead)) && PL.deliveryWarning({ deliveryDate: day(5) }, lead) === '');
    const ev = G.desiredEventForOrder(c.order, lead, 'O1', 'j1', 'ord1');
    ok('delivery → an all-day FREE Google event on the day', ev.start.date === day(6) && ev.end.date === day(7) && ev.transparency === 'transparent' && /^🚚 Delivery \(Home Depot\)/.test(ev.summary) && /^[a-v0-9]+$/.test(ev.id));
    ok('...flagged when it lands after the job starts', /Arrives AFTER the job starts/.test(ev.description));
    ok('a cancelled order or one with no day → no event', G.desiredEventForOrder(Object.assign({}, c.order, { status: 'cancelled' }), lead, 'O1', 'j1', 'o') === null
      && G.desiredEventForOrder(Object.assign({}, c.order, { deliveryDate: '' }), lead, 'O1', 'j1', 'o') === null);
    const book = { homedepot_1001: { store: 'homedepot', sku: '1001', desc: 'Drip edge 10ft', lastPaidCents: 899, history: [{ cents: 899, qty: 12, date: day(-3), leadId: 'O1' }] },
      homedepot_2002: { store: 'homedepot', sku: '2002', desc: 'Nails', history: [{ cents: 4500, qty: 1, date: day(-3), leadId: 'other' }] } };
    const skus = PL.hdSkusForLead(book, 'O1');
    ok('Home Depot SKUs imported for THIS lead are linked — names and quantities, never cents', skus.length === 1 && skus[0].sku === '1001' && skus[0].qty === 12 && !JSON.stringify(skus).includes('899'));

    const g = fakeGoogle(); GC._internal.setClient(g.client);
    await GC._internal.syncOrder('calo', 'O1', 'j1', 'ord1', c.order, lead);
    ok('sync: the delivery lands on NBD Jobs', g.live('calo').some((e) => e.id === ev.id));
    await GC._internal.syncOrder('calo', 'O1', 'j1', 'ord1', Object.assign({}, c.order, { status: 'cancelled' }), lead);
    ok('...cancelled → removed', !g.live('calo').some((e) => e.id === ev.id));
    const rdb = fakeDb({ 'leads/O1': lead, 'leads/O1/jobs/j1/orders/ord1': c.order });
    const r = await GC._internal.reconcile(rdb, 'calo');
    ok('reconcile reads orders by collection group and keeps the delivery', r.orders === 1 && g.live('calo').some((e) => e.id === ev.id), JSON.stringify(r));
    ok('orderFieldsChanged: a new delivery day re-syncs, a note edit does not', G.orderFieldsChanged(c.order, Object.assign({}, c.order, { deliveryDate: day(7) })) && !G.orderFieldsChanged(c.order, Object.assign({}, c.order, { notes: 'x' })));
  }

  // ═══ 6. weather.gov ═════════════════════════════════════════════════════
  console.log('\n6. weather.gov forecast (stubbed)');
  {
    const WX = require(path.join(FN, 'job-weather.js'))._internal;
    const fcast = (d0) => ({ properties: { periods: [
      { name: 'Today', startTime: d0 + 'T06:00:00-04:00', isDaytime: true, shortForecast: 'Showers And Thunderstorms Likely', probabilityOfPrecipitation: { value: 70 }, windSpeed: '10 to 20 mph', temperature: 71 },
      { name: 'Tonight', startTime: d0 + 'T18:00:00-04:00', isDaytime: false, shortForecast: 'Clear', probabilityOfPrecipitation: { value: 0 }, windSpeed: '5 mph' },
      { name: 'Tomorrow', startTime: SW.addDays(d0, 1) + 'T06:00:00-04:00', isDaytime: true, shortForecast: 'Sunny', probabilityOfPrecipitation: { value: null }, windSpeed: '5 to 10 mph' },
      { name: 'Next', startTime: SW.addDays(d0, 2) + 'T06:00:00-04:00', isDaytime: true, shortForecast: 'Chance Rain Showers', probabilityOfPrecipitation: { value: 30 }, windSpeed: '10 mph' },
    ] } });
    const days = PF.dailySummary(PF.slimPeriods(fcast(TODAY)));
    ok('one summary per day, the DAYTIME period wins', days[TODAY].short === 'Showers And Thunderstorms Likely' && days[TODAY].pop === 70 && days[TODAY].wind === 20);
    ok('levels: storms/70% → warn, sunny → ok, 30% showers → watch', days[TODAY].level === 'warn' && days[day(1)].level === 'ok' && days[day(2)].level === 'watch');
    ok('label reads like a forecast', days[TODAY].label === '70% Showers And Thunderstorms Likely · wind 20 mph');

    const calls = [];
    WX.clearMemory();
    WX.setFetch(async (url, opts) => {
      calls.push({ url, ua: opts && opts.headers && opts.headers['User-Agent'] });
      if (/\/points\//.test(url)) return { ok: true, json: async () => ({ properties: { forecast: 'https://api.weather.gov/gridpoints/ILN/38,41/forecast' } }) };
      if (/\/forecast$/.test(url)) return { ok: true, json: async () => fcast(TODAY) };
      return { ok: false, status: 404 };
    });
    const wdb = fakeDb({});
    const lead = L('Wx', { scheduledDate: day(0), scheduledEndDate: day(1), lat: 39.3612, lng: -84.3099 });
    const w = await WX.weatherByDay(wdb, lead);
    ok('a job in the next 7 days with a point → its days\' forecast', w && w[TODAY].level === 'warn' && w[day(1)].level === 'ok');
    ok('every weather.gov request carries an identifying User-Agent', calls.length === 2 && calls.every((c) => /NBD Pro/.test(c.ua) && /@/.test(c.ua)), JSON.stringify(calls));
    ok('cached in weather_cache (admin-only) with the forecast URL', Object.keys(wdb._docs).some((k) => /^weather_cache\/wx_39\.36_-84\.31$/.test(k)) && /gridpoints/.test(wdb._docs['weather_cache/wx_39.36_-84.31'].forecastUrl));
    await WX.weatherByDay(wdb, L('Neighbour', { scheduledDate: day(0), lat: 39.3608, lng: -84.3101 }));
    ok('a neighbour (same ~1 km grid) and a repeat → no new fetch', calls.length === 2);
    WX.clearMemory();
    await WX.weatherByDay(wdb, lead);
    ok('a fresh instance reads the Firestore cache, not the API', calls.length === 2);
    WX.clearMemory();
    wdb._docs['weather_cache/wx_39.36_-84.31'].fetchedAtMs = Date.now() - WX.FORECAST_TTL_MS - 1;
    WX.setFetch(async () => { throw new Error('offline'); });
    const stale = await WX.weatherByDay(wdb, lead);
    ok('weather.gov down → the last cached forecast (never throws)', stale && stale[TODAY].level === 'warn');
    ok('no point, or no day in the next week → no fetch at all', (await WX.weatherByDay(wdb, L('NoPt', { scheduledDate: day(0) }))) === null
      && (await WX.weatherByDay(wdb, L('Far', { scheduledDate: day(20), lat: 39, lng: -84 }))) === null);

    const ev = G.desiredEventsForLead(Object.assign({ id: 'W' }, lead), undefined, { weather: w })[0];
    ok('Google: a forecast line per job day, the risky one flagged ⚠ (warns only — the event is unchanged otherwise)',
      new RegExp('⚠ Weather ' + TODAY + ': 70%').test(ev.description) && new RegExp('Weather ' + day(1) + ': Sunny').test(ev.description) && ev.start.date === TODAY);
    const g = fakeGoogle(); GC._internal.setClient(g.client);
    GC._internal.setWeather(async () => w);
    await GC._internal.syncLead('calw', 'W', lead);
    ok('syncLead writes the forecast into the job event', g.live('calw').some((e) => /Weather /.test(e.description)));
    const r1 = await GC._internal.reconcile(fakeDb({ 'leads/W': lead }), 'calw');
    ok('...and the nightly reconcile keeps it (no strip-and-re-add churn)', r1.upserted === 0 && r1.deleted === 0, JSON.stringify(r1));
    GC._internal.setWeather(async () => null);
  }

  // ═══ 7. rain-day push ═══════════════════════════════════════════════════
  console.log('\n7. rain-day push');
  {
    // Fix the week: Thu 2026-10-08 … so weekends are predictable.
    const leads = [
      L('Pick', { id: 'P', scheduledDate: '2026-10-08', scheduledStart: '07:00', scheduledEndDate: '2026-10-09', stage: 'crew_scheduled' }),
      L('Next', { id: 'N', scheduledDate: '2026-10-09', stage: 'contract_signed' }),
      L('Before', { id: 'B', scheduledDate: '2026-10-07', stage: 'crew_scheduled' }),
      L('Inspect', { id: 'I', scheduledDate: '2026-10-12', stage: 'inspected' }),
      L('Week', { id: 'W', scheduledWeek: '2026-10-12', stage: 'crew_scheduled' }),
      L('Timed', { id: 'T', scheduledDate: '2026-10-13', scheduledStart: '13:00', scheduledDurationMin: 90, stage: 'service_approved' }),
    ];
    const plan = PL.rainPushPlan(leads, 'P', 1);
    const by = Object.fromEntries(plan.map((p) => [p.id, p]));
    ok('moves the picked job and every committed job after it — not earlier ones, inspections or week-only plans', plan.map((p) => p.id).sort().join() === 'N,P,T');
    ok('weekends skipped: a Thu–Fri job pushed 1 working day runs Fri–Mon (2 working days kept)', by.P.to.start === '2026-10-09' && by.P.to.end === '2026-10-12' && by.P.fields.scheduledEndDate === '2026-10-12');
    ok('a Friday job pushed 1 day lands Monday', by.N.to.start === '2026-10-12');
    ok('start time and a short job\'s length ride along', by.P.fields.scheduledStart === '07:00' && by.T.fields.scheduledDurationMin === 90 && by.T.fields.scheduledEndDate === null);
    ok('every move passes NBDScheduleWindow.check (the save gate)', plan.every((p) => SW.check(p.fields).ok));
    ok('N=3 from Thu → Tue', PL.rainPushPlan(leads, 'P', 3).find((p) => p.id === 'P').to.start === '2026-10-13');
    const uiSrc = fs.readFileSync(path.join(JS, 'production.js'), 'utf8');
    ok('the sheet previews conflicts with checkRow and validates every move before any write', /G\.checkRow\(\{ date: p\.to\.start/.test(uiSrc) && /SW\(\)\.check\(p\.fields\)[\s\S]{0,200}nothing was moved/.test(uiSrc));
  }

  // ═══ 8. after install (UI rules) ════════════════════════════════════════
  console.log('\n8. after install');
  {
    ok('Final Photos with 0 After photos → a soft warning that says the move went through', /No After photos/.test(PL.finalPhotosWarning('final_photos', 0)) && /went through/.test(PL.finalPhotosWarning('final_photos', 0)));
    ok('...none with After photos, none for other stages', PL.finalPhotosWarning('final_photos', 3) === '' && PL.finalPhotosWarning('install_complete', 0) === '');
    ok('the After photos + walkthrough checklist shows once install is under way or the last day has come',
      PL.showAfterChecklist({ stage: 'install_complete' }, TODAY) && PL.showAfterChecklist(L('x', { scheduledDate: day(-1), stage: 'crew_scheduled' }), TODAY)
      && !PL.showAfterChecklist(L('x', { scheduledDate: day(3), stage: 'crew_scheduled' }), TODAY) && PL.AFTER_CHECKLIST.some((c) => c.id === 'after_photos'));
    const sw = fs.readFileSync(path.join(JS, 'stage-write.js'), 'utf8');
    ok('stage-write.js calls the hook AFTER the write, best-effort (never blocks the move)', /NBDProduction\.onStageChange\(id, oldStage, newStage\)/.test(sw)
      && sw.indexOf('NBDProduction.onStageChange') > sw.indexOf('tx.update(leadRef, payload)'));
  }

  // ═══ 9. busy strip ══════════════════════════════════════════════════════
  console.log('\n9. 7-day busy strip');
  {
    const d0 = '2026-10-08';
    const strip = PL.busyStrip({
      today: d0, days: 7,
      blocks: [{ startMs: SW.localToUtcMs(SW.addDays(d0, 1), '09:00'), endMs: SW.localToUtcMs(SW.addDays(d0, 1), '11:00'), titles: [] }],
      leads: [L('Proj', { scheduledDate: d0 }), L('Rep', { scheduledDate: SW.addDays(d0, 2), scheduledStart: '13:00', scheduledDurationMin: 60 })],
      orders: [{ deliveryDate: SW.addDays(d0, 3), store: 'HD' }],
    });
    const k = (i) => strip[i].cells.map((c) => c.kind[0]).join('');
    ok('7 days × 12 hourly cells (7 am–7 pm)', strip.length === 7 && strip.every((d) => d.cells.length === 12));
    ok('a timed 1-hour job shades just its hour', k(2) === 'ffffffjfffff', k(2));
    ok('Google busy 9–11 shades 9 and 10', k(1) === 'ffbbffffffff', k(1));
    ok('a delivery day shades lightly all day', k(3) === 'dddddddddddd' && strip[3].deliveries.length === 1);
    ok('a day job shades the working day', k(0).slice(0, 11) === 'jjjjjjjjjjj');
    const css = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'css', 'production.css'), 'utf8');
    ok('cells are classes, not inline styles (CSP / style ratchet)', /\.bs-job\s*\{/.test(css) && /\.bs-busy\s*\{/.test(css) && /\.bs-deliv\s*\{/.test(css));
  }

  // ═══ 10. signed jobs that need a week ═══════════════════════════════════
  console.log('\n10. signed jobs that need a week');
  {
    const leads = [L('NoDate', { id: 'a', stage: 'contract_signed' }), L('Week', { id: 'b', stage: 'contract_signed', scheduledWeek: day(7) }),
      L('Dated', { id: 'c', stage: 'crew_scheduled', scheduledDate: day(3) }), L('Lead', { id: 'd', stage: 'inspected' })];
    ok('server: only committed jobs with neither a day nor a week', PF.needsWeek(leads).map((r) => r.leadId).join() === 'a');
    ok('client twin agrees', PL.needsWeek(leads).map((l) => l.id).join() === 'a');
    const STUBS = {
      './integrations/heartbeat': { onSchedule: (o, h) => ({ __opts: o, __handler: h }) },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
      resend: { Resend: function () { throw new Error('real Resend'); } },
    };
    const realLoad = Module._load;
    Module._load = function (request) { if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request]; return realLoad.apply(this, arguments); };
    delete require.cache[require.resolve(path.join(FN, 'morning-brief.js'))];
    const MB = require(path.join(FN, 'morning-brief.js'))._test;
    Module._load = realLoad;
    const quiet = { info() {}, warn() {}, error() {} };
    const out1 = await MB.runMorningBrief({ db: fakeDb({ 'users/OWNER': { email: 'jo@example.test' }, 'leads/a': leads[0] }), env: {}, nowMs: Date.now(), makeResend: () => { throw new Error('no'); }, log: quiet, owner: 'OWNER', weatherFor: async () => null });
    ok('the brief goes out for unscheduled signed jobs alone (dry-run here)', out1.status === 'dry-run', JSON.stringify(out1));
    let sentMail = null;
    const db = fakeDb({
      'users/OWNER': { email: 'jo@example.test' },
      'leads/a': leads[0],
      'leads/J': L('JobDay', { scheduledDate: TODAY, lat: 39.1, lng: -84.5 }),
      'leads/J/tasks/e1': { type: 'event', title: 'Adjuster walk', eventAt: isoAt(TODAY, '15:00'), userId: 'OWNER' },
    });
    const out2 = await MB.runMorningBrief({ db, env: { MORNING_BRIEF_ENABLED: 'true', RESEND_API_KEY: 're_test' }, nowMs: Date.now(), owner: 'OWNER', log: quiet,
      makeResend: () => ({ emails: { send: async (m) => { sentMail = m; return { data: { id: 'x' } }; } } }),
      weatherFor: async (l) => (l.lat ? { [TODAY]: { label: '80% Rain', level: 'warn' } } : null) });
    ok('brief: the CRM event is an item; the job day stays (an event never stands in for it)', out2.status === 'sent' && /Adjuster walk/.test(sentMail.text) && /ZZ_QA JobDay/.test(sentMail.text), sentMail && sentMail.text);
    ok('brief: "1 signed job needs a week" + a Plan Jobs link', /1 signed job needs a week/.test(sentMail.text) && /#\/schedule/.test(sentMail.html) && /needs a week/.test(sentMail.subject));
    ok('brief: today\'s forecast on the job day (warn-only wording)', /⚠ Weather: 80% Rain — check before the crew rolls/.test(sentMail.text));
    const ui = fs.readFileSync(path.join(JS, 'production.js'), 'utf8');
    ok('Today screen section is feature-detected (#todayPlan from #2137)', /\$\('todayPlan'\)/.test(ui) && /if \(!plan \|\| !P\(\)\) return;/.test(ui));
  }

  // ═══ 11. Crew Scheduled email ═══════════════════════════════════════════
  console.log('\n11. Crew Scheduled email — filled, a DRAFT');
  {
    const lead = L('Mail', { email: 'h@example.test', stage: 'crew_scheduled', scheduledDate: '2026-10-08', scheduledStart: '07:30', scheduledEndDate: '2026-10-09' });
    const f = PL.crewEmailFields(lead);
    ok('filled from the job: date range, arrival time, day count', /Thursday, October 8 through Friday, October 9/.test(f.scheduledDate) && /around 7:30 am/.test(f.arrivalLine) && /2 days/.test(f.lengthLine));
    ok('a week-only plan says the week, no invented time', /week of Monday, October 12/.test(PL.crewEmailFields(L('w', { scheduledWeek: '2026-10-12' })).scheduledDate));
    // vm-load email_system.js and build the real email.
    const win = { NBDProductionLogic: PL, NBDScheduleWindow: SW, _leads: [Object.assign({ id: 'M' }, lead)], console,
      db: {}, doc: (_db, _c, id) => id, getDoc: async (id) => ({ exists: () => id === 'M', data: () => Object.assign({}, lead) }), showToast() {}, location: {}, document: { addEventListener() {}, getElementById: () => null, createElement: () => ({ style: {} }), querySelectorAll: () => [] } };
    win.window = win;
    const ctx = vm.createContext(Object.assign(win, { setTimeout, clearTimeout, Promise, Date, JSON, Object, RegExp, String, Array, Math, Number, encodeURIComponent }));
    let esSrc = fs.readFileSync(path.join(JS, 'email_system.js'), 'utf8');
    try { vm.runInContext(esSrc, ctx, { filename: 'email_system.js' }); } catch (e) { /* DOM bits at load are optional */ }
    let built = null;
    if (win.emailSystem && typeof win.emailSystem.buildStageEmail === 'function') {
      built = await win.emailSystem.buildStageEmail('M');
    }
    ok('the real template: the job\'s time and days, "the crew"; no "7-8 AM", "1-2 days" or "installation team"', built && /around 7:30 am/.test(built.body) && /2 days/.test(built.body)
      && /the crew/i.test(built.body) && !/7-8 AM|1-2 days|installation team|our team/i.test(built.body), built && built.body);
    const comms = fs.readFileSync(path.join(JS, 'nbd-comms.js'), 'utf8');
    ok('nbd-comms: a Crew Scheduled "send now" opens the review modal instead of sending', /DRAFT_ONLY_STAGES = \['crew_scheduled'\]/.test(comms)
      && /DRAFT_ONLY_STAGES\.includes\(built\.stage\)\) \{\s*window\.emailByStage\(leadId\);\s*return \{ success: true, mode: 'review' \};/.test(comms));
  }

  // ═══ 12. tomorrow's installs ════════════════════════════════════════════
  console.log('\n12. tomorrow\'s installs — pre-written, from Jo\'s phone');
  {
    const rows = PL.tomorrowInstalls([L('Tom', { id: 't', firstName: 'Dana', scheduledDate: day(1), scheduledStart: '07:00' }), L('Later', { id: 'l', scheduledDate: day(2) }), L('MidJob', { id: 'm', scheduledDate: day(0), scheduledEndDate: day(1) })],
      TODAY, { repName: 'Joe', companyName: 'No Big Deal Home Solutions' });
    ok('jobs STARTING tomorrow only', rows.map((r) => r.id).join() === 't');
    ok('the reminder: first name, address, time, move vehicles — and "the crew"', /^Hi Dana, this is Joe with No Big Deal Home Solutions\./.test(rows[0].text) && /tomorrow around 7:00 am/.test(rows[0].text)
      && /move vehicles/.test(rows[0].text) && /the crew/.test(rows[0].text) && !/our team|employee/i.test(rows[0].text));
    const share = require(path.join(JS, 'phone-share.js'));
    ok('tap-to-text builds an sms: link with the text (Jo sends it)', /^sms:5135550199\?&body=Hi%20Dana/.test(share.smsHref(rows[0].phone, rows[0].text)));
  }

  // ═══ 13. rules + indexes ════════════════════════════════════════════════
  console.log('\n13. rules + indexes');
  {
    const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
    const ov = (g, f) => (idx.fieldOverrides || []).find((o) => o.collectionGroup === g && o.fieldPath === f);
    const cg = (o) => !!o && o.indexes.some((i) => i.queryScope === 'COLLECTION_GROUP' && i.order === 'ASCENDING') && o.indexes.some((i) => i.queryScope === 'COLLECTION');
    ok('tasks.eventAt COLLECTION_GROUP (the reminder\'s range; the emulator never enforces it)', cg(ov('tasks', 'eventAt')));
    ok('orders.userId + orders.companyId COLLECTION_GROUP (reconcile, busy strip)', cg(ov('orders', 'userId')) && cg(ov('orders', 'companyId')));
    ok('tasks.userId COLLECTION_GROUP still there (feed, brief, reconcile read events by it)', cg(ov('tasks', 'userId')));
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    ok('rules: orders under a job, collection-group read, and a subs roster under the company', /match \/orders\/\{orderId\}[\s\S]{0,900}orderWriteOk\(leadId\)/.test(rules)
      && /match \/\{path=\*\*\}\/orders\/\{orderId\}/.test(rules) && /match \/subs\/\{subId\}[\s\S]{0,700}subWriteOk\(\)/.test(rules));
    ok('rules: an order row may not carry money keys', /hasAny\(\['cost', 'costCents', 'price', 'priceCents', 'total', 'totalCents', 'materialTotal', 'margin'\]\)/.test(rules));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
