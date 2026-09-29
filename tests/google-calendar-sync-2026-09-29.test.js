/**
 * tests/google-calendar-sync-2026-09-29.test.js
 *
 * Calendar hub Phase 2 — CRM jobs + adjuster meetings → an "NBD Jobs" Google
 * Calendar owned by the functions' service account and shared with Jo
 * (functions/google-calendar.js + google-calendar-logic.js). A fake Google
 * records every request; an in-memory Firestore holds the leads. Synthetic
 * data only.
 *
 * Run: node tests/google-calendar-sync-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
process.env.NBD_OWNER_UID = 'OWNER';
const G = require(path.join(__dirname, '..', 'functions', 'google-calendar-logic.js'));
const M = require(path.join(__dirname, '..', 'functions', 'google-calendar.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// ── fakes ────────────────────────────────────────────────────────────────
function fakeGoogle() {
  const g = { calendars: {}, events: {}, acl: [], calls: [], freeBusy: null, n: 0 };
  const err = (code) => Object.assign(new Error('HTTP ' + code), { code });
  g.client = {
    email: async () => 'svc@zzqa.iam.gserviceaccount.com',
    request: async ({ url, method, data, params }) => {
      const p = url.replace('https://www.googleapis.com/calendar/v3', '');
      g.calls.push(method + ' ' + p);
      let m;
      if (method === 'POST' && p === '/calendars') { const id = 'cal' + (++g.n) + '@group.calendar.google.com'; g.calendars[id] = data; return { data: { id } }; }
      if ((m = /^\/calendars\/([^/]+)\/acl$/.exec(p)) && method === 'POST') { g.acl.push({ cal: decodeURIComponent(m[1]), data, params }); return { data: {} }; }
      if ((m = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(p))) {
        const key = decodeURIComponent(m[1]) + '|' + m[2];
        if (method === 'PUT') { if (!g.events[key]) throw err(404); g.events[key] = Object.assign({}, data); return { data }; }
        if (method === 'DELETE') { if (!g.events[key] || g.events[key].status === 'cancelled') throw err(410); g.events[key] = Object.assign({}, g.events[key], { status: 'cancelled' }); return { data: {} }; }
      }
      if ((m = /^\/calendars\/([^/]+)\/events$/.exec(p))) {
        const cal = decodeURIComponent(m[1]);
        if (method === 'POST') { const key = cal + '|' + data.id; if (g.events[key]) throw err(409); g.events[key] = Object.assign({}, data); return { data }; }
        if (method === 'GET') {
          const items = Object.entries(g.events).filter(([k, e]) => k.startsWith(cal + '|') && e.status !== 'cancelled'
            && e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.nbdManaged === '1').map(([, e]) => e);
          return { data: { items } };
        }
      }
      if (p === '/freeBusy' && method === 'POST') return { data: g.freeBusy || { calendars: {} } };
      throw new Error('unexpected ' + method + ' ' + p);
    },
  };
  g.live = (cal) => Object.entries(g.events).filter(([k, e]) => k.startsWith(cal + '|') && e.status !== 'cancelled').map(([, e]) => e);
  return g;
}
function fakeDb(seed) {
  const docs = {};
  for (const [k, v] of Object.entries(seed || {})) docs[k] = JSON.parse(JSON.stringify(v));
  const ref = (p) => ({
    async get() { return { exists: !!docs[p], data: () => docs[p] && JSON.parse(JSON.stringify(docs[p])) }; },
    async set(d, o) { const clean = JSON.parse(JSON.stringify(d, (k, v) => (v && v.constructor && v.constructor.name === 'ServerTimestampTransform' ? 'TS' : v))); docs[p] = o && o.merge && docs[p] ? Object.assign(docs[p], clean) : clean; },
  });
  const q = (col, fl) => ({
    where: (f, op, v) => q(col, fl.concat([[f, v]])),
    async get() {
      const hits = Object.keys(docs).filter((k) => k.startsWith(col + '/') && k.split('/').length === 2 && fl.every(([f, v]) => docs[k][f] === v))
        .map((k) => ({ id: k.split('/')[1], data: () => JSON.parse(JSON.stringify(docs[k])) }));
      return { forEach: (fn) => hits.forEach(fn), docs: hits, size: hits.length };
    },
  });
  return { doc: (p) => ref(p), collection: (c) => Object.assign(q(c, []), { doc: (id) => ref(c + '/' + id) }), _docs: docs };
}

const L = (id, f) => Object.assign({ companyId: 'OWNER', userId: 'OWNER', firstName: 'ZZ_QA', lastName: id, address: id + ' ZZQA St', stage: 'contract_signed' }, f);
const future = (d) => { const t = new Date(Date.now() + d * 86400000); return t.toISOString().slice(0, 10); };

(async () => {
  console.log('\n1. events from leads (same rules as the .ics feed)');
  {
    const full = G.desiredEventsForLead(Object.assign({ id: 'L1' }, L('Full', { scheduledDate: future(5), scheduledStart: '07:00', scheduledEndDate: future(6), customerId: 'NBD-0001' })));
    ok('a 2-day project with a start → one all-day event over both days, BUSY', full.length === 1 && full[0].start.date === future(5) && full[0].end.date === future(7) && full[0].transparency === 'opaque');
    ok('...titled with the job and its window, linked back to the CRM', /🔨 ZZ_QA Full · 7:00 am · 2-day job/.test(full[0].summary) && /customer\.html\?id=L1/.test(full[0].description) && /NBD-0001/.test(full[0].description));
    const repair = G.desiredEventsForLead(Object.assign({ id: 'L2' }, L('Repair', { scheduledDate: future(3), scheduledStart: '14:30', scheduledDurationMin: 90 })));
    ok('a timed repair → a timed event, 90 minutes, New York time, BUSY', repair[0].start.dateTime && repair[0].start.timeZone === 'America/New_York'
      && Date.parse(repair[0].end.dateTime) - Date.parse(repair[0].start.dateTime) === 90 * 60000 && repair[0].transparency === 'opaque');
    const dateOnly = G.desiredEventsForLead(Object.assign({ id: 'L3' }, L('DateOnly', { scheduledDate: future(2) })));
    ok('a date with no time → an all-day reminder that does NOT block (FREE)', dateOnly[0].start.date === future(2) && dateOnly[0].transparency === 'transparent');
    const adj = G.desiredEventsForLead(Object.assign({ id: 'L4' }, L('Claim', { adjusterMeetingDate: future(4), adjusterMeetingStart: '10:00', adjusterName: 'ZZ Adj', insCarrier: 'ZZ Mutual', claimNumber: 'C-1' })));
    ok('an adjuster meeting → its own event with carrier, claim # and adjuster', adj.length === 1 && /Adjuster meeting/.test(adj[0].summary) && /ZZ Mutual/.test(adj[0].description) && /C-1/.test(adj[0].description) && /ZZ Adj/.test(adj[0].description));
    ok('job + adjuster on one lead → two events with different ids', G.desiredEventsForLead(Object.assign({ id: 'L5' }, L('Both', { scheduledDate: future(9), adjusterMeetingDate: future(4) }))).length === 2
      && G.eventIdFor('job', 'L5') !== G.eventIdFor('adjuster', 'L5'));
    ok('nothing scheduled / deleted → no events', G.desiredEventsForLead(L('None')).length === 0
      && G.desiredEventsForLead(Object.assign({ id: 'L6' }, L('Gone', { scheduledDate: future(1), deleted: true }))).length === 0);
    ok('event ids are valid Google ids (base32hex, 5–1024) and stable', /^[a-v0-9]{5,1024}$/.test(G.eventIdFor('job', 'thumbtack_leads__lead_58902'))
      && G.eventIdFor('job', 'X') === G.eventIdFor('job', 'X'));
  }

  console.log('\n2. set up, then keep Google matching the CRM');
  const g = fakeGoogle();
  M._internal.setClient(g.client);
  const db = fakeDb({
    'leads/A': L('Alpha', { scheduledDate: future(5), scheduledStart: '07:00', scheduledDurationMin: 480 }),
    'leads/B': L('Bravo', { adjusterMeetingDate: future(3), adjusterMeetingStart: '09:00' }),
    'leads/C': L('Charlie', {}),
    'leads/X': { companyId: 'someone-else', userId: 'someone-else', firstName: 'ZZ_QA', lastName: 'Othertenant', scheduledDate: future(2) },
  });
  let refused = false;
  try { await M._internal.setup(db, 'not-an-email'); } catch (e) { refused = /email/i.test(e.message); }
  ok('setup refuses a bad email', refused && g.calls.length === 0);
  const s = await M._internal.setup(db, 'jo@example.com');
  const cal = s.calendarId;
  ok('setup creates "NBD Jobs" in New York time', g.calendars[cal] && g.calendars[cal].summary === 'NBD Jobs' && g.calendars[cal].timeZone === 'America/New_York');
  ok('...shares it READ-ONLY with Jo, and Google emails the invite', g.acl.length === 1 && g.acl[0].data.role === 'reader' && g.acl[0].data.scope.value === 'jo@example.com' && g.acl[0].params.sendNotifications === true);
  ok('...and fills it: Alpha\'s job + Bravo\'s adjuster meeting; nothing for another company', g.live(cal).length === 2 && s.summary.upserted === 2
    && !g.live(cal).some((e) => /Othertenant/.test(e.summary)));
  ok('the config remembers the calendar, who it is shared with, and the service account', db._docs['integrations/googleCalendar'].calendarId === cal
    && db._docs['integrations/googleCalendar'].serviceAccount === 'svc@zzqa.iam.gserviceaccount.com');
  const again = await M._internal.setup(db, 'jo@example.com');
  ok('running setup again reuses the same calendar (no second one)', again.calendarId === cal && Object.keys(g.calendars).length === 1);

  // Reconcile after changes: move Alpha, unschedule Bravo's meeting, schedule Charlie.
  db._docs['leads/A'].scheduledDate = future(8);
  delete db._docs['leads/B'].adjusterMeetingDate;
  db._docs['leads/C'].scheduledDate = future(10);
  const r = await M._internal.reconcile(db, cal);
  const titles = g.live(cal).map((e) => e.summary).join(' | ');
  ok('reconcile: Alpha moved, Bravo\'s meeting removed, Charlie added', r.upserted === 2 && r.deleted === 1 && g.live(cal).length === 2 && /Alpha/.test(titles) && /Charlie/.test(titles) && !/Adjuster/.test(titles), titles);
  const r2 = await M._internal.reconcile(db, cal);
  ok('a second reconcile with no changes touches nothing', r2.upserted === 0 && r2.deleted === 0 && r2.unchanged === 2);

  console.log('\n3. one lead at a time (the Firestore trigger path)');
  {
    const before = g.calls.length;
    await M._internal.syncLead(cal, 'D', L('Delta', { scheduledDate: future(12) }));
    ok('a newly scheduled lead appears', g.live(cal).some((e) => /Delta/.test(e.summary)));
    await M._internal.syncLead(cal, 'D', L('Delta', { scheduledDate: future(12), deleted: true }));
    ok('deleting the lead removes its event', !g.live(cal).some((e) => /Delta/.test(e.summary)));
    await M._internal.syncLead(cal, 'D', L('Delta', { scheduledDate: future(14) }));
    ok('re-scheduling revives the same event id (PUT, no duplicate)', g.live(cal).filter((e) => /Delta/.test(e.summary)).length === 1);
    await M._internal.syncLead(cal, 'D', { companyId: 'someone-else', userId: 'someone-else', scheduledDate: future(14) });
    ok('a lead moved to another company is removed from Jo\'s calendar', !g.live(cal).some((e) => /Delta/.test(e.summary)) && g.calls.length > before);
    ok('the trigger gate ignores writes the calendar does not show', G.calendarFieldsChanged({ notes: 'a', scheduledDate: 'x' }, { notes: 'b', scheduledDate: 'x' }) === false
      && G.calendarFieldsChanged({ scheduledDate: 'x' }, { scheduledDate: 'y' }) === true);
  }

  console.log('\n4. free/busy for the double-booking warning');
  {
    // A fresh calendar with two timed jobs on Oct 6 and a date-only reminder.
    const g4 = fakeGoogle();
    M._internal.setClient(g4.client);
    const db4 = fakeDb({ 'integrations/googleCalendar': { calendarId: 'cal4', sharedWith: 'jo@example.com' } });
    await M._internal.syncLead('cal4', 'J1', L('Morning', { scheduledDate: '2026-10-06', scheduledStart: '07:00', scheduledDurationMin: 240 }));
    await M._internal.syncLead('cal4', 'J2', L('Afternoon', { scheduledDate: '2026-10-06', scheduledStart: '14:00', scheduledDurationMin: 60 }));
    await M._internal.syncLead('cal4', 'J3', L('Reminder', { scheduledDate: '2026-10-06' }));
    g4.freeBusy = { calendars: { 'jo@example.com': { busy: [{ start: '2026-10-06T18:30:00Z', end: '2026-10-06T19:30:00Z' }] } } };
    const day = [Date.parse('2026-10-06T04:00:00Z'), Date.parse('2026-10-07T04:00:00Z')];
    const b = await M._internal.busy(db4, day[0], day[1]);
    ok('busy = both timed jobs (named) + Jo\'s own 2:30 hold; the FREE reminder is not busy',
      b.blocks.length === 2 && b.blocks.some((x) => x.titles.some((t) => /Morning/.test(t))) && !b.blocks.some((x) => x.titles.some((t) => /Reminder/.test(t))));
    ok('Jo\'s 2:30 personal hold merges into the 2:00 job block (both calendars named)',
      b.blocks.some((x) => x.calendars.length === 2 && x.endMs === Date.parse('2026-10-06T19:30:00Z')));
    ok('Jo\'s main calendar is reported as shared when Google can read it', b.primaryShared === true);
    const self = await M._internal.busy(db4, day[0], day[1], 'J2');
    ok('editing the Afternoon job itself: its own event does not warn — only Jo\'s hold remains there',
      !self.blocks.some((x) => x.titles.some((t) => /Afternoon/.test(t))) && self.blocks.some((x) => x.calendars.includes('jo@example.com')));
    const c = G.conflictsWith(b.blocks, Date.parse('2026-10-06T13:00:00Z'), Date.parse('2026-10-06T14:00:00Z'));
    ok('a 9am job on the 6th conflicts with the Morning job', c.length === 1 && /Morning/.test(c[0].titles.join()));
    ok('...and 12–1 is clear', G.conflictsWith(b.blocks, Date.parse('2026-10-06T16:00:00Z'), Date.parse('2026-10-06T17:00:00Z')).length === 0);
    g4.freeBusy = { calendars: { 'jo@example.com': { errors: [{ reason: 'notFound' }] } } };
    const nb = await M._internal.busy(db4, day[0], day[1]);
    ok('not shared yet → primaryShared false (the card says what to click); jobs still checked', nb.primaryShared === false && nb.blocks.length === 2);
    const none = await M._internal.busy(fakeDb({}), 0, 1000);
    ok('before setup → configured:false, no Google call', none.configured === false);
    M._internal.setClient(g.client);
  }

  console.log('\n5. wiring');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'google-calendar.js'), 'utf8');
    ok('the trigger returns early for other tenants, unchanged fields, and before setup',
      /if \(!isOwnerLead\(before\) && !isOwnerLead\(after\)\) return;/.test(src) && /!G\.calendarFieldsChanged\(before, after\)\) return;/.test(src) && /if \(!cfg \|\| !cfg\.calendarId\) return;/.test(src));
    ok('kill switch on every path', (src.match(/disabled\(\)/g) || []).length >= 4);
    ok('the calendar is shared read-only (edits belong in the CRM)', /role: 'reader'/.test(src) && !/role: 'owner'/.test(src));
    const idx = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
    ok('index.js exports all five functions', ['setupGoogleCalendar', 'getGoogleCalendarStatus', 'getBusyTimes', 'onLeadCalendarWrite', 'googleCalendarReconcile'].every((n) => new RegExp('exports\\.' + n + '\\s*=').test(idx)));
  }

  console.log('\n6. Jo can find it (2026-09-29: "don\'t see any schedule button anywhere")');
  {
    const dash = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'dashboard.html'), 'utf8');
    ok('Schedule is in the desktop sidebar, right under Pipeline',
      /id="nav-crm"[^\n]*\n\s*<div class="ni"[^>]*data-target="schedule" id="nav-schedule"/.test(dash));
    ok('...and in the phone More drawer', /class="mm-item" data-action="mobileNav" data-target="schedule"/.test(dash));
    const mnc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'mobile-nav-customizer.js'), 'utf8');
    ok('...and offered as a bottom-bar tab', /id: 'schedule',[^\n]*action: 'schedule'/.test(mnc));
    const ui = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'google-calendar-ui.js'), 'utf8');
    ok('a direct #/schedule link waits for the panel AND the signed-in user before its one status load',
      /\$\('gcalPanel'\) && window\._user && window\._user\.uid/.test(ui) && /_tries < 40/.test(ui) && /addEventListener\('nbd:data-refreshed', maybeLoad\)/.test(ui));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
