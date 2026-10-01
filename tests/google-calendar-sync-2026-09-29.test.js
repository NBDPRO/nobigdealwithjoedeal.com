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
    async get() { return { exists: !!docs[p], id: p.split('/').pop(), data: () => docs[p] && JSON.parse(JSON.stringify(docs[p])) }; },
    async set(d, o) { const clean = JSON.parse(JSON.stringify(d, (k, v) => (v && v.constructor && v.constructor.name === 'ServerTimestampTransform' ? 'TS' : v))); docs[p] = o && o.merge && docs[p] ? Object.assign(docs[p], clean) : clean; },
    collection: (c) => ({ doc: (id) => ref(p + '/' + c + '/' + id) }),
  });
  // leads/{id}/jobs/{jobId} across all leads (multi-job, 2026-09-30).
  const cg = (name, fl) => ({
    where: (f, op, v) => cg(name, fl.concat([[f, v]])),
    async get() {
      const hits = Object.keys(docs).filter((k) => { const s = k.split('/'); return s.length >= 4 && s[s.length - 2] === name && fl.every(([f, v]) => docs[k][f] === v); })
        .map((k) => { const s = k.split('/'); return { id: s[s.length - 1], ref: { parent: { parent: { id: s[s.length - 3] } } }, data: () => JSON.parse(JSON.stringify(docs[k])) }; });
      return { forEach: (fn) => hits.forEach(fn), docs: hits, size: hits.length };
    },
  });
  const q = (col, fl) => ({
    where: (f, op, v) => q(col, fl.concat([[f, v]])),
    async get() {
      const hits = Object.keys(docs).filter((k) => k.startsWith(col + '/') && k.split('/').length === 2 && fl.every(([f, v]) => docs[k][f] === v))
        .map((k) => ({ id: k.split('/')[1], data: () => JSON.parse(JSON.stringify(docs[k])) }));
      return { forEach: (fn) => hits.forEach(fn), docs: hits, size: hits.length };
    },
  });
  return { doc: (p) => ref(p), collection: (c) => Object.assign(q(c, []), { doc: (id) => ref(c + '/' + id) }), collectionGroup: (n) => cg(n, []), _docs: docs };
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

  console.log('\n7. a customer with two jobs (multi-job, 2026-09-30)');
  {
    const lead = Object.assign({ id: 'M1', activeJobId: 'j1' }, L('Twojobs', { scheduledDate: future(4), scheduledStart: '07:00', scheduledDurationMin: 480 }));
    const gutters = { id: 'j2', title: 'Gutter guards', stage: 'new', scheduledDate: future(6), scheduledStart: '09:00', scheduledDurationMin: 120, property: { address: '9 Other Rd' }, companyId: 'OWNER', userId: 'OWNER' };
    const ev = G.desiredEventsForJob(lead, gutters);
    ok('the other job gets its own event, keyed per job (not the customer\'s id)', ev.length === 1 && ev[0].id === G.eventIdFor('job', 'M1', 'j2') && ev[0].id !== G.eventIdFor('job', 'M1'));
    ok('...a valid Google id', /^[a-v0-9]{5,1024}$/.test(ev[0].id));
    ok('...named with the job, at the job\'s own property, on its own time', /Gutter guards/.test(ev[0].summary) && ev[0].location === '9 Other Rd'
      && Date.parse(ev[0].end.dateTime) - Date.parse(ev[0].start.dateTime) === 120 * 60000, ev[0].summary + ' @ ' + ev[0].location);
    ok('...tagged with its job id', ev[0].extendedProperties.private.nbdJobId === 'j2' && ev[0].extendedProperties.private.nbdLeadId === 'M1');
    ok('the ACTIVE job has no per-job event (the lead\'s event is it)', G.desiredEventsForJob(lead, { id: 'j1', scheduledDate: future(4) }).length === 0);
    ok('a job with no date of its own shows nothing (the customer\'s install date is not copied onto it)', G.desiredEventsForJob(lead, { id: 'j3', title: 'Caulk' }).length === 0);
    ok('the active job\'s event is unchanged by multi-job (same id, no job name)', G.desiredEventsForLead(lead)[0].id === G.eventIdFor('job', 'M1') && !/—/.test(G.desiredEventsForLead(lead)[0].summary));

    const g7 = fakeGoogle();
    M._internal.setClient(g7.client);
    const db7 = fakeDb({
      'leads/M1': lead,
      'leads/M1/jobs/j1': { stage: 'contract_signed', title: 'Roof', scheduledDate: future(4), scheduledStart: '07:00', scheduledDurationMin: 480, companyId: 'OWNER', userId: 'OWNER' },
      'leads/M1/jobs/j2': gutters,
      'leads/X/jobs/j2': { title: 'Other tenant', scheduledDate: future(6), companyId: 'someone-else', userId: 'someone-else' },
    });
    const r = await M._internal.reconcile(db7, 'cal7');
    const t7 = () => g7.live('cal7').map((e) => e.summary).join(' | ');
    ok('reconcile: the roof (customer card) AND the gutter job — two events, no third', g7.live('cal7').length === 2 && /Gutter guards/.test(t7()) && r.jobs === 2, t7());
    const r2 = await M._internal.reconcile(db7, 'cal7');
    ok('a second reconcile changes nothing', r2.upserted === 0 && r2.deleted === 0);

    // Busy: editing the customer skips its own card's event, not its other job.
    const self = G.jobsBusy(g7.live('cal7'), 'M1', () => 0);
    ok('double-booking check while editing this customer: the other job still counts', self.length === 1 && /Gutter guards/.test(self[0].title));

    // Promotion: the roof is paid in full; the gutter job takes over the card.
    const promoted = Object.assign({}, lead, { activeJobId: 'j2', scheduledDate: gutters.scheduledDate, scheduledStart: '09:00', scheduledDurationMin: 120 });
    db7._docs['leads/M1'] = promoted;
    await M._internal.syncLead('cal7', 'M1', promoted);
    const sw = await M._internal.syncSwappedJobs(db7, 'cal7', 'M1', promoted, ['j1', 'j2']);
    const live = g7.live('cal7');
    ok('after the swap: still exactly two events (no duplicate gutter job)', live.length === 2, t7());
    ok('...the card\'s event now shows the gutter date', live.some((e) => e.id === G.eventIdFor('job', 'M1') && e.start.dateTime && e.start.dateTime.slice(0, 10) >= gutters.scheduledDate.slice(0, 8)));
    ok('...the roof keeps its day as its own job event; the gutter job\'s per-job event is gone',
      live.some((e) => e.id === G.eventIdFor('job', 'M1', 'j1') && /Roof/.test(e.summary)) && !live.some((e) => e.id === G.eventIdFor('job', 'M1', 'j2')), JSON.stringify(sw));
    await M._internal.syncJob('cal7', 'M1', promoted, 'j1', null);
    ok('a removed job\'s events are removed', !g7.live('cal7').some((e) => e.id === G.eventIdFor('job', 'M1', 'j1')));
    M._internal.setClient(g.client);

    ok('job trigger gate: a note on the job is ignored; a new date or title is not', G.jobCalendarFieldsChanged({ notes: 'a', scheduledDate: 'x' }, { notes: 'b', scheduledDate: 'x' }) === false
      && G.jobCalendarFieldsChanged({ scheduledDate: 'x' }, { scheduledDate: 'y' }) === true && G.jobCalendarFieldsChanged({ title: 'a' }, { title: 'b' }) === true);
    ok('a promotion (activeJobId) re-syncs the lead', G.calendarFieldsChanged({ activeJobId: 'j1' }, { activeJobId: 'j2' }) === true);

    const J = require(path.join(__dirname, '..', 'functions', 'jobs-logic.js'));
    ok('the job fields are the ones the app writes (adjusterMeetingStart/Name/Phone; no phantom adjusterMeetingTime)',
      ['adjusterMeetingStart', 'adjusterName', 'adjusterPhone'].every((f) => J.JOB_FIELDS.includes(f)) && !J.JOB_FIELDS.includes('adjusterMeetingTime'));
    const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'google-calendar.js'), 'utf8');
    ok('the job trigger leaves the active job to the lead trigger', /if \(lead && lead\.activeJobId === jobId\) return;/.test(src));
    ok('the lead trigger re-syncs BOTH jobs when a promotion swaps the active one',
      /if \(after && was !== now\) r\.jobs = await syncSwappedJobs\(db, cfg\.calendarId, event\.params\.leadId, after, \[was, now\]\);/.test(src));
    const idx = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
    ok('index.js exports onJobCalendarWrite', /exports\.onJobCalendarWrite\s*=/.test(idx));
  }

  console.log('\n8. yard-sign pickups (Jo, 2026-09-29 §6.2: pickups go to Google too)');
  {
    const NOW = Date.parse('2026-10-05T16:00:00Z');                    // noon, Mon Oct 5, New York
    const S = (id, f) => Object.assign({ id, companyId: 'OWNER', userId: 'OWNER', status: 'out', address: id + ' Sign Ln, Mason, OH', placedAt: '2026-09-28T16:00:00Z', durationDays: 14 }, f);
    const e = G.desiredEventForSign(S('s1', { dueAt: '2026-10-12T04:00:00Z' }), NOW);   // midnight Oct 12, New York
    ok('a sign out → an all-day pickup reminder on its New York pickup day', e && e.start.date === '2026-10-12' && e.end.date === '2026-10-13', JSON.stringify(e && e.start));
    ok('...FREE: a to-do, never a busy slot (Cal.com and the double-booking check ignore it)', e.transparency === 'transparent' && G.jobsBusy([e], null, () => 0).length === 0);
    ok('...named with the address, placed at it, tagged as a yard sign', /^🪧 Pick up yard sign — s1 Sign Ln/.test(e.summary) && e.location === 's1 Sign Ln, Mason, OH'
      && e.extendedProperties.private.nbdKind === 'yardsign' && e.extendedProperties.private.nbdSignId === 's1' && e.extendedProperties.private.nbdManaged === '1');
    ok('...a valid Google id ([a-v0-9]; never a lead or job id)', /^[a-v0-9]{5,1024}$/.test(e.id) && e.id !== G.eventIdFor('job', 's1') && e.id !== G.eventIdFor('adjuster', 's1'));
    ok('the day is New York\'s, not UTC\'s (11:30 pm Oct 11 local is Oct 11)', G.desiredEventForSign(S('s2', { dueAt: '2026-10-12T03:30:00Z' }), NOW).start.date === '2026-10-11');
    const late = G.desiredEventForSign(S('s3', { dueAt: '2026-10-01T04:00:00Z' }), NOW);
    ok('still out after its pickup day → the reminder sits on TODAY, marked overdue', late.start.date === '2026-10-05' && /overdue since 2026-10-01/.test(late.summary), late.summary);
    ok('picked up / missing / removed / no date → no reminder', ['picked_up', 'missing'].every((st) => G.desiredEventForSign(S('s4', { status: st, dueAt: '2026-10-12T04:00:00Z' }), NOW) === null)
      && G.desiredEventForSign(S('s4', { deleted: true, dueAt: '2026-10-12T04:00:00Z' }), NOW) === null && G.desiredEventForSign(S('s4', {}), NOW) === null);
    ok('a Firestore Timestamp dueAt reads the same as an ISO string', G.desiredEventForSign(S('s5', { dueAt: { toMillis: () => Date.parse('2026-10-12T04:00:00Z') } }), NOW).start.date === '2026-10-12');
    ok('sign trigger gate: a note is ignored; an extension (new dueAt) or a pickup is not',
      G.signCalendarFieldsChanged({ notes: 'a', dueAt: { seconds: 5 } }, { notes: 'b', dueAt: { _seconds: 5 } }) === false
      && G.signCalendarFieldsChanged({ dueAt: { seconds: 5 } }, { dueAt: { seconds: 6 } }) === true && G.signCalendarFieldsChanged({ status: 'out' }, { status: 'picked_up' }) === true);

    // The trigger path, then a reconcile that must NOT wipe them.
    const g8 = fakeGoogle();
    M._internal.setClient(g8.client);
    const due = new Date(Date.now() + 6 * 86400000).toISOString();
    await M._internal.syncSign('cal8', 'Y1', S('Y1', { dueAt: due }));
    ok('placing a sign puts its reminder on the calendar', g8.live('cal8').length === 1 && /Y1 Sign Ln/.test(g8.live('cal8')[0].summary));
    await M._internal.syncSign('cal8', 'Y1', S('Y1', { dueAt: due, status: 'picked_up' }));
    ok('picking it up removes the reminder', g8.live('cal8').length === 0);
    await M._internal.syncSign('cal8', 'Y2', { companyId: 'someone-else', userId: 'someone-else', status: 'out', dueAt: due, address: 'Other' });
    ok('another company\'s sign never reaches Jo\'s calendar', g8.live('cal8').length === 0);
    const db8 = fakeDb({
      'leads/A8': L('Signjob', { scheduledDate: future(3) }),
      'yardSigns/Y3': S('Y3', { dueAt: due }),
      'yardSigns/Y4': S('Y4', { dueAt: due, status: 'picked_up' }),
      'yardSigns/Y5': { companyId: 'someone-else', userId: 'someone-else', status: 'out', dueAt: due, address: 'Other' },
    });
    await M._internal.syncSign('cal8', 'Y3', db8._docs['yardSigns/Y3']);
    const r8 = await M._internal.reconcile(db8, 'cal8');
    const t8 = g8.live('cal8').map((x) => x.summary).join(' | ');
    ok('reconcile keeps the live sign\'s reminder next to the job (it would delete anything it does not want)', g8.live('cal8').length === 2 && /Y3 Sign Ln/.test(t8) && /Signjob/.test(t8) && r8.signs === 2, t8);
    const r9 = await M._internal.reconcile(db8, 'cal8');
    ok('a second reconcile changes nothing', r9.upserted === 0 && r9.deleted === 0, JSON.stringify(r9));
    M._internal.setClient(g.client);

    const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'google-calendar.js'), 'utf8');
    ok('the sign trigger returns early for other tenants, unchanged fields, and before setup',
      /exports\.onYardSignCalendarWrite = onDocumentWritten\(\s*\{ document: 'yardSigns\/\{signId\}'[\s\S]{0,400}if \(!isOwnerLead\(before\) && !isOwnerLead\(after\)\) return;[\s\S]{0,120}!G\.signCalendarFieldsChanged\(before, after\)\) return;[\s\S]{0,200}if \(!cfg \|\| !cfg\.calendarId\) return;/.test(src));
    const idx = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
    ok('index.js exports onYardSignCalendarWrite', /exports\.onYardSignCalendarWrite\s*=/.test(idx));
  }

  console.log('\n9. D2D follow-ups with a time — the newest knock per door (Jo, 2026-09-30)');
  {
    const SW = require(path.join(__dirname, '..', 'functions', 'schedule-window.js'));
    const K = (id, f) => Object.assign({ id, companyId: 'OWNER', userId: 'OWNER', address: '12 Knock Ln, Mason, OH', homeowner: 'ZZ_QA Door', disposition: 'callback' }, f);
    const day = (ymd) => ymd + 'T04:00:00.000Z';                       // local midnight, New York (EDT)
    const ev = G.desiredEventForKnock(K('k1', { createdAt: 1, followUpDate: day('2026-10-08'), followUpTime: '17:30' }), SW.localToUtcMs);
    ok('a knock with a follow-up date AND time → a 30-minute event at 5:30 pm New York', ev && ev.start.dateTime === '2026-10-08T21:30:00.000Z'
      && Date.parse(ev.end.dateTime) - Date.parse(ev.start.dateTime) === 30 * 60000, JSON.stringify(ev && ev.start));
    ok('...BUSY (a set time is a commitment), named with the homeowner and door', ev.transparency === 'opaque' && /^📞 Follow up — ZZ_QA Door · 12 Knock Ln/.test(ev.summary) && ev.extendedProperties.private.nbdKind === 'knock');
    ok('...a valid Google id, the same for every spelling of the door', /^[a-v0-9]{5,1024}$/.test(ev.id) && ev.id === G.knockEventId(G.knockAddrKey('  12 KNOCK  Ln, Mason, OH ')));
    ok('a date with no time, or a bad time → nothing (Jo: only follow-ups that carry a time)',
      G.desiredEventForKnock(K('k2', { followUpDate: day('2026-10-08') }), SW.localToUtcMs) === null
      && G.desiredEventForKnock(K('k3', { followUpDate: day('2026-10-08'), followUpTime: '25:00' }), SW.localToUtcMs) === null
      && G.desiredEventForKnock(K('k4', { followUpTime: '09:00' }), SW.localToUtcMs) === null);
    const old = K('k5', { createdAt: 100, followUpDate: day('2026-10-08'), followUpTime: '17:30' });
    const reknockTimed = K('k6', { createdAt: 200, followUpDate: day('2026-10-10'), followUpTime: '10:00', address: '12 knock ln, mason, oh' });
    const evs = G.desiredKnockEvents([old, reknockTimed], SW.localToUtcMs);
    ok('re-knocked with a new timed follow-up → ONE event, the newest knock\'s (Oct 10, 10:00)', evs.length === 1 && evs[0].start.dateTime === '2026-10-10T14:00:00.000Z', JSON.stringify(evs.map((e) => e.start)));
    const reknockNone = K('k7', { createdAt: 300, disposition: 'not_interested' });
    ok('re-knocked with no timed follow-up → the door\'s event is gone (the old one never resurfaces)', G.desiredKnockEvents([old, reknockTimed, reknockNone], SW.localToUtcMs).length === 0);
    ok('a Firestore Timestamp createdAt decides "newest" the same way', G.latestKnockPerDoor([K('a', { createdAt: { seconds: 5 } }), K('b', { createdAt: { toMillis: () => 9000 } })]).get(G.knockAddrKey('12 Knock Ln, Mason, OH')).id === 'b');
    ok('an address-less knock is skipped', G.desiredKnockEvents([K('k8', { address: '', followUpDate: day('2026-10-08'), followUpTime: '09:00' })], SW.localToUtcMs).length === 0);
    ok('knock trigger gate: notes ignored; a new time, date or re-dated createdAt is not',
      G.knockCalendarFieldsChanged({ notes: 'a', followUpTime: '09:00' }, { notes: 'b', followUpTime: '09:00' }) === false
      && G.knockCalendarFieldsChanged({ followUpTime: '09:00' }, { followUpTime: '10:00' }) === true
      && G.knockCalendarFieldsChanged({ followUpDate: { seconds: 1 } }, { followUpDate: { seconds: 2 } }) === true);

    // Trigger path, then the reconcile.
    const g9 = fakeGoogle();
    M._internal.setClient(g9.client);
    const fut = (d) => new Date(Date.parse(future(d) + 'T04:00:00Z')).toISOString();
    const db9 = fakeDb({
      'knocks/A1': K('A1', { createdAt: 100, followUpDate: fut(3), followUpTime: '17:30' }),
      'knocks/X1': { companyId: 'someone-else', userId: 'someone-else', address: '9 Other Rd', createdAt: 1, followUpDate: fut(3), followUpTime: '09:00' },
    });
    await M._internal.syncKnockDoor(db9, 'cal9', '12 Knock Ln, Mason, OH');
    ok('a knock with a timed follow-up lands on the calendar', g9.live('cal9').length === 1 && /12 Knock Ln/.test(g9.live('cal9')[0].summary));
    db9._docs['knocks/A2'] = K('A2', { createdAt: 200, disposition: 'not_interested' });
    await M._internal.syncKnockDoor(db9, 'cal9', '12 Knock Ln, Mason, OH');
    ok('re-knocking the door with no follow-up removes it', g9.live('cal9').length === 0);
    await M._internal.syncKnockDoor(db9, 'cal9', '9 Other Rd');
    ok('another company\'s knock never reaches Jo\'s calendar', g9.live('cal9').length === 0);
    db9._docs['knocks/A3'] = K('A3', { createdAt: 300, followUpDate: fut(5), followUpTime: '11:00', address: '12 KNOCK LN, Mason, OH' });
    const r9 = await M._internal.reconcile(db9, 'cal9');
    const live9 = g9.live('cal9');
    ok('reconcile: one event for the door across spellings — the newest knock\'s 11:00', live9.length === 1 && live9[0].start.dateTime === new Date(SW.localToUtcMs(future(5), '11:00', 'America/New_York')).toISOString() && r9.knocks === 3, JSON.stringify(live9.map((e) => e.start)));
    const r10 = await M._internal.reconcile(db9, 'cal9');
    ok('a second reconcile changes nothing', r10.upserted === 0 && r10.deleted === 0, JSON.stringify(r10));
    M._internal.setClient(g.client);

    const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'google-calendar.js'), 'utf8');
    ok('the knock trigger returns early for other tenants, unchanged fields, and before setup; re-syncs both doors on an address edit',
      /exports\.onKnockCalendarWrite = onDocumentWritten\(\s*\{ document: 'knocks\/\{knockId\}'[\s\S]{0,400}if \(!isOwnerLead\(before\) && !isOwnerLead\(after\)\) return;[\s\S]{0,120}!G\.knockCalendarFieldsChanged\(before, after\)\) return;[\s\S]{0,200}if \(!cfg \|\| !cfg\.calendarId\) return;\s*const addrs = \[\.\.\.new Set\(\[before && before\.address, after && after\.address\]/.test(src));
    const idx = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
    ok('index.js exports onKnockCalendarWrite', /exports\.onKnockCalendarWrite\s*=/.test(idx));
  }

  console.log('\n10. the morning follow-up push: only the newest knock at a door (Jo, 2026-09-30)');
  {
    const K = (id, f) => Object.assign({ id, companyId: 'CO', userId: 'rep1', address: '12 Knock Ln, Mason, OH' }, f);
    const old = K('old', { createdAt: 100, followUpDate: 'today' });
    const reknock = K('new', { createdAt: 200, disposition: 'not_interested', address: '12 KNOCK LN, Mason, OH' });
    ok('a door re-knocked since → its old follow-up is skipped', G.keepNewestPerDoor([old], [old, reknock]).length === 0);
    ok('the newest knock\'s own follow-up still reminds', G.keepNewestPerDoor([reknock], [old, reknock]).length === 1);
    ok('no re-knock → the follow-up reminds (and the candidate need not be in `all`)', G.keepNewestPerDoor([old], []).length === 1);
    const otherCo = K('x', { createdAt: 300, companyId: 'OTHER', userId: 'repX' });
    ok('another company knocking the same door later does NOT silence this company\'s follow-up', G.keepNewestPerDoor([old], [old, otherCo]).length === 1);
    const teammate = K('t', { createdAt: 300, userId: 'rep2' });
    ok('a teammate\'s later knock at the door does (same company, newest wins)', G.keepNewestPerDoor([old], [old, teammate]).length === 0);
    ok('a knock with no address has no door to compare → kept', G.keepNewestPerDoor([K('na', { address: '' })], [teammate]).length === 1);
    ok('two doors, one re-knocked → only the other reminds', JSON.stringify(G.keepNewestPerDoor([old, K('b', { address: '9 Other Rd', createdAt: 50 })], [old, reknock]).map((k) => k.id)) === '["b"]');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
