/**
 * NBD Pro — 6:45 am appointment brief
 * ═══════════════════════════════════════════════════════════════
 *
 * Every morning at 06:45 America/New_York, ONE email to the platform owner
 * (Jo, NBD_OWNER_UID) listing today's appointments with what the CRM already
 * knows about each property: stage, job type, the customer's other jobs, the
 * last activity note, any open invoice balance, and storm history already on
 * file. Never sent to a homeowner. No external lookups — the "research" is
 * the CRM itself (Jo's idea triage: "pulls today's calendar meetings,
 * researches each attendee, and emails a brief").
 *
 * Sources (owner tenant):
 *   appointments  — Cal.com bookings (repUid / userId == owner), today's ET day
 *   leads         — job days (scheduledDate + window, multi-day projects
 *                   included on their middle days) and adjuster meetings
 *   jobs          — collectionGroup('jobs'): a customer's OTHER jobs
 *   invoices / leads/{id}/activity / leads/{id}/storm_proofs — per item
 * All decisions live in morning-brief-logic.js (pure).
 *
 * No appointments today → nothing is sent (logged only).
 *
 * Per-user opt-out: users/{owner}.morningBriefEnabled === false.
 * Ships DRY-RUN by default: unless MORNING_BRIEF_ENABLED=true on the
 * morningBrief Cloud Run revision, the brief is built and logged, never sent.
 * Jo turns it on (it is deliberately absent from functions/.env.nobigdeal-pro).
 */

'use strict';

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { Resend } = require('resend');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const SW = require('./schedule-window');
const CF = require('./calendar-feed-logic');
const MB = require('./morning-brief-logic');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM     = defineSecret('EMAIL_FROM');

const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

function snapDocs(snap) {
  const out = [];
  if (snap && typeof snap.forEach === 'function') snap.forEach((d) => out.push(d));
  else if (snap && Array.isArray(snap.docs)) out.push(...snap.docs);
  return out;
}

/** Union two snapshots by doc id → [{ id, ...data }]. */
function unionDocs(snaps) {
  const byId = new Map();
  for (const s of snaps) for (const d of snapDocs(s)) if (!byId.has(d.id)) byId.set(d.id, Object.assign({ id: d.id }, d.data() || {}));
  return [...byId.values()];
}

/** Everything collectTodayItems needs, owner tenant only. */
async function readDay(db, owner, nowMs, log) {
  const today = CF.nyDateOf(nowMs);
  // Today's ET day as instants (DST-correct): [00:00 today, 00:00 tomorrow).
  const fromMs = SW.localToUtcMs(today, '00:00');
  const toMs = SW.localToUtcMs(SW.addDays(today, 1), '00:00');

  const [byRep, byUser] = await Promise.all([
    db.collection('appointments').where('repUid', '==', owner)
      .where('startTime', '>=', new Date(fromMs)).where('startTime', '<', new Date(toMs)).get(),
    db.collection('appointments').where('userId', '==', owner)
      .where('startTime', '>=', new Date(fromMs)).where('startTime', '<', new Date(toMs)).get(),
  ]);
  const appointments = unionDocs([byRep, byUser]);

  const [lc, lu] = await Promise.all([
    db.collection('leads').where('companyId', '==', owner).get(),
    db.collection('leads').where('userId', '==', owner).get(),
  ]);
  const leads = unionDocs([lc, lu]);

  // A failed jobs read must not cost Jo the whole brief — the customers' own
  // job days and bookings are still right.
  let jobs = [];
  try {
    const [jc, ju] = await Promise.all([
      db.collectionGroup('jobs').where('companyId', '==', owner).get(),
      db.collectionGroup('jobs').where('userId', '==', owner).get(),
    ]);
    const byKey = new Map();
    for (const s of [jc, ju]) {
      for (const d of snapDocs(s)) {
        const leadId = d.ref && d.ref.parent && d.ref.parent.parent && d.ref.parent.parent.id;
        if (!leadId) continue;
        const k = leadId + '/' + d.id;
        if (!byKey.has(k)) byKey.set(k, Object.assign({}, d.data() || {}, { id: d.id, leadId }));
      }
    }
    jobs = [...byKey.values()];
  } catch (e) {
    log.warn('morning_brief_jobs_read_failed', { err: e && e.message });
  }
  return { today, appointments, leads, jobs };
}

/** Per-lead enrichment for the leads behind today's items only. */
async function readHistory(db, leadIds, tenantKeyOf, log) {
  const invoices = [];
  const activityByLead = new Map();
  const stormProofsByLead = new Map();
  for (const leadId of leadIds) {
    const leadRef = db.collection('leads').doc(leadId);
    const [inv, act, storm] = await Promise.all([
      db.collection('invoices').where('leadId', '==', leadId).limit(20).get()
        .catch((e) => { log.warn('morning_brief_invoices_read_failed', { leadId, err: e && e.message }); return null; }),
      leadRef.collection('activity').orderBy('createdAt', 'desc').limit(1).get()
        .catch((e) => { log.warn('morning_brief_activity_read_failed', { leadId, err: e && e.message }); return null; }),
      leadRef.collection('storm_proofs').orderBy('verifiedAt', 'desc').limit(1).get()
        .catch((e) => { log.warn('morning_brief_storm_read_failed', { leadId, err: e && e.message }); return null; }),
    ]);
    // An invoice found by leadId alone must be this tenant's (a lead id can be
    // re-created by another tenant after a hard delete — portal-authz.js).
    const tenant = tenantKeyOf(leadId);
    for (const d of snapDocs(inv)) {
      const data = d.data() || {};
      if (data.companyId && data.companyId !== tenant) continue;
      invoices.push(Object.assign({ id: d.id }, data, { leadId }));
    }
    activityByLead.set(leadId, snapDocs(act).map((d) => d.data() || {}));
    stormProofsByLead.set(leadId, snapDocs(storm).map((d) => d.data() || {}));
  }
  return { invoices, activityByLead, stormProofsByLead };
}

/**
 * One run. Every dependency is injected so tests drive it with fakes.
 * @param {object} deps
 * @param {object} deps.db           Firestore (or a fake)
 * @param {object} deps.env          process.env (MORNING_BRIEF_ENABLED, RESEND_API_KEY, EMAIL_FROM)
 * @param {number} deps.nowMs
 * @param {function} deps.makeResend (apiKey) → { emails: { send } }
 * @param {object} deps.log          logger (info / warn / error)
 * @param {string} [deps.owner]      platform owner uid
 * @returns {Promise<{status:string, items?:number, emailed?:boolean}>}
 */
async function runMorningBrief(deps) {
  const { db, env = {}, nowMs, makeResend, log = logger } = deps || {};
  const owner = (deps && deps.owner) || OWNER;
  const enabled = env.MORNING_BRIEF_ENABLED === 'true';

  const userSnap = await db.collection('users').doc(owner).get();
  const user = (userSnap && userSnap.exists && userSnap.data()) || {};
  if (user.morningBriefEnabled === false) {
    log.info('morning_brief_opted_out', { owner });
    return { status: 'opted-out' };
  }
  if (!isValidEmail(user.email)) {
    log.warn('morning_brief_no_owner_email', { owner });
    return { status: 'no-email' };
  }

  const day = await readDay(db, owner, nowMs, log);
  const pre = MB.collectTodayItems({ appointments: day.appointments, leads: day.leads, jobs: day.jobs, nowMs });
  if (pre.length === 0) {
    log.info('morning_brief_nothing_today', { owner, date: day.today, mode: enabled ? 'live' : 'dry-run' });
    return { status: 'nothing-today', items: 0 };
  }

  const leadsById = new Map(day.leads.map((l) => [String(l.id), l]));
  const leadIds = [...new Set(pre.map((it) => it.leadId).filter((id) => id && leadsById.has(id)))];
  const hist = await readHistory(db, leadIds, (id) => (leadsById.get(id) || {}).companyId || owner, log);

  const brief = MB.buildBrief({
    appointments: day.appointments, leads: day.leads, jobs: day.jobs, nowMs,
    invoices: hist.invoices, activityByLead: hist.activityByLead, stormProofsByLead: hist.stormProofsByLead,
  });

  if (!enabled) {
    log.info('morning_brief_dry_run', {
      owner, date: brief.today, items: brief.items.length, subject: brief.subject,
      sample: brief.items.slice(0, 5).map((it) => ({ type: it.type, time: it.timeLabel, leadId: it.leadId })),
    });
    return { status: 'dry-run', items: brief.items.length };
  }
  if (!env.RESEND_API_KEY) {
    log.warn('morning_brief_no_resend_key', { owner });
    return { status: 'no-key', items: brief.items.length };
  }

  const resend = makeResend(env.RESEND_API_KEY);
  const response = await resend.emails.send({
    from: env.EMAIL_FROM || 'Joe Deal <jd@nobigdealwithjoedeal.com>',
    to: user.email,
    subject: brief.subject,
    html: brief.html,
    text: brief.text,
  });
  if (resendRejected(response)) {
    log.error('morning_brief_send_rejected', { owner, err: resendErrorMessage(response) });
    return { status: 'rejected', items: brief.items.length };
  }
  log.info('morning_brief_sent', { owner, date: brief.today, items: brief.items.length });
  return { status: 'sent', items: brief.items.length, emailed: true };
}

// ─── Scheduled function ──────────────────────────────────────────
// 06:45 Eastern — after googleCalendarReconcile (05:45) and before Jo leaves
// for the first job; dailyLeadDigest follows at 07:00.
exports.morningBrief = onSchedule(
  {
    schedule: '45 6 * * *',
    timeZone: 'America/New_York',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    maxInstances: 1,
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  async () => {
    const env = {
      MORNING_BRIEF_ENABLED: process.env.MORNING_BRIEF_ENABLED,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      EMAIL_FROM: process.env.EMAIL_FROM,
    };
    const out = await runMorningBrief({
      db: getFirestore(),
      env,
      nowMs: Date.now(),
      makeResend: (key) => new Resend(key),
      log: logger,
    });
    logger.info('morning_brief_complete', out);
  }
);

exports._test = { runMorningBrief, readDay, readHistory, OWNER };
