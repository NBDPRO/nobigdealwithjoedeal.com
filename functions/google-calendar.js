/**
 * functions/google-calendar.js — CRM jobs and adjuster meetings → an
 * "NBD Jobs" Google Calendar (calendar hub Phase 2), plus the free/busy read
 * the CRM uses to warn before double-booking.
 *
 * Design choice (2026-09-29): no OAuth app. The functions' own service
 * account OWNS the "NBD Jobs" calendar and shares it (read-only) with Jo's
 * Google account, where it appears like any other calendar — phone, Google
 * Calendar, and Cal.com's conflict check (Cal.com reads the calendars in
 * Jo's connected Google account). A Google OAuth app would need Google's
 * verification for a calendar scope; this needs two clicks from Jo:
 *   1. Settings → Google Calendar → Set up (creates + shares "NBD Jobs")
 *   2. Google Calendar → his main calendar → Share with specific people →
 *      the service-account email → "See only free/busy" (only needed for the
 *      double-booking warning to see his personal events).
 *
 * Inert until set up: every path returns early while
 * integrations/googleCalendar has no calendarId. Kill switch:
 * GOOGLE_CALENDAR_SYNC_DISABLED=true (cron-gates registry).
 *
 * Platform tenant only (Jo's leads), same scope as the Stripe ledger.
 * Pure rules: google-calendar-logic.js.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const G = require('./google-calendar-logic');

const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const CONFIG = 'integrations/googleCalendar';
const API = 'https://www.googleapis.com/calendar/v3';
const CORS_ORIGINS = ['https://nobigdealwithjoedeal.com', 'https://www.nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app', 'https://nobigdeal-pro.firebaseapp.com'];
const disabled = () => process.env.GOOGLE_CALENDAR_SYNC_DISABLED === 'true';

let _client = null;
let _testClient = null;
async function gclient() {
  if (_testClient) return _testClient;
  if (_client) return _client;
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/calendar'] });
  const c = await auth.getClient();
  _client = { request: (o) => c.request(o), email: async () => { try { return (await auth.getCredentials()).client_email || null; } catch (_) { return null; } } };
  return _client;
}
async function call(method, path, data, params) {
  const c = await gclient();
  const r = await c.request({ url: API + path, method, data, params });
  return r.data;
}
const statusOf = (e) => (e && (e.code || (e.response && e.response.status))) || 0;

async function loadConfig(db) {
  const s = await db.doc(CONFIG).get();
  return s.exists ? s.data() : null;
}

// ── events ───────────────────────────────────────────────────────────────
async function upsertEvent(calendarId, ev) {
  const body = Object.assign({}, ev, { status: 'confirmed' });
  try {
    // PUT first: it also revives an id Google remembers as deleted, which a
    // POST insert would refuse (409).
    return await call('PUT', '/calendars/' + encodeURIComponent(calendarId) + '/events/' + ev.id, body);
  } catch (e) {
    if (statusOf(e) === 404) return call('POST', '/calendars/' + encodeURIComponent(calendarId) + '/events', body);
    throw e;
  }
}
async function deleteEvent(calendarId, id) {
  try { await call('DELETE', '/calendars/' + encodeURIComponent(calendarId) + '/events/' + id); return true; }
  catch (e) { if ([404, 410].includes(statusOf(e))) return false; throw e; }
}
async function listManaged(calendarId, timeMinMs) {
  const out = [];
  let pageToken;
  do {
    const r = await call('GET', '/calendars/' + encodeURIComponent(calendarId) + '/events', undefined, {
      privateExtendedProperty: 'nbdManaged=1', maxResults: 2500, singleEvents: true, showDeleted: false,
      timeMin: new Date(timeMinMs).toISOString(), pageToken,
    });
    (r.items || []).forEach((i) => out.push(i));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

const isOwnerLead = (d) => !!d && (d.companyId === OWNER || d.userId === OWNER);

/** One lead → its events in Google (create / update / delete as needed). */
async function syncLead(calendarId, leadId, lead) {
  const want = isOwnerLead(lead) ? G.desiredEventsForLead(Object.assign({ id: leadId }, lead)) : [];
  const wantIds = new Set(want.map((e) => e.id));
  for (const e of want) await upsertEvent(calendarId, e);
  let removed = 0;
  for (const id of G.allIdsForLead(leadId)) if (!wantIds.has(id) && await deleteEvent(calendarId, id)) removed++;
  return { upserted: want.length, removed };
}

/**
 * One of a customer's OTHER jobs → its events (multi-job, 2026-09-30). The
 * active job's events are the lead's (syncLead); a job that is active, gone,
 * or not the owner's has none, and any it had are removed.
 */
async function syncJob(calendarId, leadId, lead, jobId, job) {
  const want = isOwnerLead(lead) && job ? G.desiredEventsForJob(Object.assign({ id: leadId }, lead), Object.assign({ id: jobId }, job)) : [];
  const wantIds = new Set(want.map((e) => e.id));
  for (const e of want) await upsertEvent(calendarId, e);
  let removed = 0;
  for (const id of G.allIdsForJob(leadId, jobId)) if (!wantIds.has(id) && await deleteEvent(calendarId, id)) removed++;
  return { upserted: want.length, removed };
}

/** Re-sync the jobs a promotion swapped (old active → own events, new active → the lead's). */
async function syncSwappedJobs(db, calendarId, leadId, lead, jobIds) {
  const out = {};
  for (const jid of jobIds) {
    if (!jid || !/^[A-Za-z0-9_-]{1,40}$/.test(jid)) continue;
    const s = await db.collection('leads').doc(String(leadId)).collection('jobs').doc(jid).get();
    out[jid] = await syncJob(calendarId, leadId, lead, jid, s.exists ? s.data() : null);
  }
  return out;
}

/** Make Google match the CRM: every owner lead from 30 days back. */
async function reconcile(db, calendarId) {
  const sinceMs = Date.now() - 30 * 86400000;
  const [a, b] = await Promise.all([
    db.collection('leads').where('companyId', '==', OWNER).get(),
    db.collection('leads').where('userId', '==', OWNER).get(),
  ]);
  const leads = new Map();
  [a, b].forEach((s) => s.forEach((d) => leads.set(d.id, Object.assign({ id: d.id }, d.data()))));
  // Multi-job: every owner job (one collection-group read per stamp — the
  // single-field COLLECTION_GROUP indexes from #1917 serve both).
  const [ja, jb] = await Promise.all([
    db.collectionGroup('jobs').where('companyId', '==', OWNER).get(),
    db.collectionGroup('jobs').where('userId', '==', OWNER).get(),
  ]);
  const jobs = new Map();
  [ja, jb].forEach((s) => s.forEach((d) => {
    const leadId = d.ref.parent && d.ref.parent.parent && d.ref.parent.parent.id;
    if (leadId) jobs.set(leadId + '/' + d.id, { leadId, job: Object.assign({ id: d.id }, d.data()) });
  }));
  const desired = [];
  const keep = (e) => {
    const endMs = e.end.dateTime ? Date.parse(e.end.dateTime) : Date.parse(e.end.date + 'T23:59:59Z');
    if (endMs >= sinceMs) desired.push(e);
  };
  for (const l of leads.values()) G.desiredEventsForLead(l).forEach(keep);
  for (const { leadId, job } of jobs.values()) {
    const l = leads.get(leadId);
    if (l) G.desiredEventsForJob(l, job).forEach(keep);
  }
  const existing = await listManaged(calendarId, sinceMs);
  const plan = G.planSync(desired, existing);
  for (const e of plan.upserts) await upsertEvent(calendarId, e);
  for (const id of plan.deletes) await deleteEvent(calendarId, id);
  return { upserted: plan.upserts.length, deleted: plan.deletes.length, unchanged: plan.same, leads: leads.size, jobs: jobs.size };
}

// ── owner gate (same shape as stripe-ledger.js) ───────────────────────────
function requireOwner(request, isPlatformAdmin) {
  const a = request.auth;
  if (!a || !a.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const t = a.token || {};
  if (a.uid === OWNER || isPlatformAdmin(t)) return;
  if (t.companyId === OWNER && t.role === 'company_admin') return;
  throw new HttpsError('permission-denied', 'Only the account owner or a company admin can manage the Google Calendar sync.');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Create (or re-share) "NBD Jobs", then fill it. */
async function setup(db, email) {
  if (!EMAIL_RE.test(email)) throw new HttpsError('invalid-argument', 'Enter the Google account email the calendar should appear in.');
  const cfg = (await loadConfig(db)) || {};
  let calendarId = cfg.calendarId;
  if (!calendarId) {
    const cal = await call('POST', '/calendars', { summary: 'NBD Jobs', timeZone: G.TZ,
      description: 'Jobs and adjuster meetings from NBD Pro. Managed by the CRM — change them there; edits here are overwritten.' });
    calendarId = cal.id;
  }
  // Read-only share: the calendar mirrors the CRM, so edits belong in the CRM.
  await call('POST', '/calendars/' + encodeURIComponent(calendarId) + '/acl', { role: 'reader', scope: { type: 'user', value: email } }, { sendNotifications: true });
  const serviceAccount = await (await gclient()).email();
  await db.doc(CONFIG).set({ calendarId, sharedWith: email, serviceAccount: serviceAccount || null, createdAt: cfg.createdAt || FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  const summary = await reconcile(db, calendarId);
  await db.doc(CONFIG).set({ lastSyncAt: FieldValue.serverTimestamp(), lastSync: summary }, { merge: true });
  return { calendarId, sharedWith: email, serviceAccount, summary };
}

/**
 * What is busy in a window: the NBD Jobs events themselves (read directly,
 * so each block can name the job, and the lead being edited is skipped) plus
 * Jo's main calendar through free/busy (times only — Google shares nothing
 * else, and nothing else is needed).
 */
async function busy(db, fromMs, toMs, excludeLeadId) {
  const cfg = await loadConfig(db);
  if (!cfg || !cfg.calendarId) return { configured: false, blocks: [] };
  const SW = require('./schedule-window');
  const r = await call('GET', '/calendars/' + encodeURIComponent(cfg.calendarId) + '/events', undefined, {
    timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), singleEvents: true, maxResults: 250, showDeleted: false,
  });
  const cals = { [cfg.calendarId]: { busy: G.jobsBusy(r.items || [], excludeLeadId, SW.localToUtcMs) } };
  let primaryShared = null;
  if (cfg.sharedWith) {
    const fb = await call('POST', '/freeBusy', { timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(), timeZone: G.TZ, items: [{ id: cfg.sharedWith }] });
    const primary = fb.calendars && fb.calendars[cfg.sharedWith];
    // Google answers a calendar it cannot read with errors:[notFound] rather than failing the call.
    primaryShared = !!(primary && !(primary.errors && primary.errors.length));
    if (primaryShared) cals[cfg.sharedWith] = { busy: primary.busy || [] };
  }
  return { configured: true, primaryShared, blocks: G.busyBlocks({ calendars: cals }), jobsCalendarId: cfg.calendarId, primaryCalendarId: cfg.sharedWith || null };
}

// ── exports ─────────────────────────────────────────────────────────────
exports.setupGoogleCalendar = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 300, memory: '512MiB' },
  async (request) => {
    requireOwner(request, (t) => t.role === 'admin');
    if (disabled()) throw new HttpsError('failed-precondition', 'Google Calendar sync is switched off.');
    const email = String((request.data && request.data.email) || '').trim().toLowerCase();
    return setup(getFirestore(), email);
  }
);

exports.getGoogleCalendarStatus = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 60 },
  async (request) => {
    requireOwner(request, (t) => t.role === 'admin');
    const db = getFirestore();
    const cfg = (await loadConfig(db)) || {};
    const serviceAccount = cfg.serviceAccount || await (await gclient()).email();
    let primaryShared = null;
    if (cfg.calendarId) {
      try { primaryShared = (await busy(db, Date.now(), Date.now() + 3600000)).primaryShared; } catch (_) { primaryShared = null; }
    }
    return {
      configured: !!cfg.calendarId, sharedWith: cfg.sharedWith || null, serviceAccount: serviceAccount || null,
      primaryShared, lastSync: cfg.lastSync || null, disabled: disabled(),
    };
  }
);

exports.getBusyTimes = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 30 },
  async (request) => {
    requireOwner(request, (t) => t.role === 'admin');
    const { fromMs, toMs, excludeLeadId } = request.data || {};
    const f = Number(fromMs), to = Number(toMs);
    if (!isFinite(f) || !isFinite(to) || to <= f || to - f > 62 * 86400000) throw new HttpsError('invalid-argument', 'fromMs/toMs: a window of at most 62 days');
    return busy(getFirestore(), f, to, typeof excludeLeadId === 'string' ? excludeLeadId : null);
  }
);

exports.onLeadCalendarWrite = onDocumentWritten(
  { document: 'leads/{leadId}', region: 'us-central1', timeoutSeconds: 60, retry: false },
  async (event) => {
    if (disabled()) return;
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    if (!isOwnerLead(before) && !isOwnerLead(after)) return;          // another tenant's lead
    if (before && after && !G.calendarFieldsChanged(before, after)) return; // nothing the calendar shows
    const db = getFirestore();
    const cfg = await loadConfig(db);
    if (!cfg || !cfg.calendarId) return;                               // not set up yet
    try {
      const r = await syncLead(cfg.calendarId, event.params.leadId, after);
      // A promotion (jobs-mirror) swapped the active job: the old one now
      // gets its own events, the new one's move onto the lead's.
      const was = before && before.activeJobId, now = after && after.activeJobId;
      if (after && was !== now) r.jobs = await syncSwappedJobs(db, cfg.calendarId, event.params.leadId, after, [was, now]);
      logger.info('[googleCalendar] lead synced', { leadId: event.params.leadId, ...r });
    } catch (e) {
      // The nightly reconcile repairs anything missed here.
      logger.warn('[googleCalendar] lead sync failed', { leadId: event.params.leadId, status: statusOf(e), msg: e && e.message });
    }
  }
);

// Multi-job (2026-09-30): one of a customer's other jobs was added, moved,
// rescheduled or removed → its own events. The active job is the lead's
// (onLeadCalendarWrite), so it is skipped here.
exports.onJobCalendarWrite = onDocumentWritten(
  { document: 'leads/{leadId}/jobs/{jobId}', region: 'us-central1', timeoutSeconds: 60, retry: false },
  async (event) => {
    if (disabled()) return;
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    if (!isOwnerLead(before) && !isOwnerLead(after)) return;          // another tenant's job
    if (before && after && !G.jobCalendarFieldsChanged(before, after)) return;
    const db = getFirestore();
    const cfg = await loadConfig(db);
    if (!cfg || !cfg.calendarId) return;
    const { leadId, jobId } = event.params;
    try {
      const ls = await db.collection('leads').doc(leadId).get();
      const lead = ls.exists ? ls.data() : null;
      if (lead && lead.activeJobId === jobId) return;                  // the lead's own events
      const r = await syncJob(cfg.calendarId, leadId, lead, jobId, after);
      logger.info('[googleCalendar] job synced', { leadId, jobId, ...r });
    } catch (e) {
      logger.warn('[googleCalendar] job sync failed', { leadId, jobId, status: statusOf(e), msg: e && e.message });
    }
  }
);

exports.googleCalendarReconcile = onSchedule(
  { schedule: 'every day 05:45', timeZone: 'America/New_York', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    if (disabled()) { logger.info('[googleCalendarReconcile] disabled'); return; }
    const db = getFirestore();
    const cfg = await loadConfig(db);
    if (!cfg || !cfg.calendarId) { logger.info('[googleCalendarReconcile] not set up'); return; }
    const summary = await reconcile(db, cfg.calendarId);
    await db.doc(CONFIG).set({ lastSyncAt: FieldValue.serverTimestamp(), lastSync: summary }, { merge: true });
    logger.info('[googleCalendarReconcile] done', summary);
  }
);

module.exports._internal = { setup, reconcile, syncLead, syncJob, syncSwappedJobs, busy, upsertEvent, deleteEvent, listManaged, isOwnerLead,
  setClient: (c) => { _testClient = c; } };
