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
 * No appointments today AND nothing else to say → nothing is sent (logged
 * only). Since 2026-10-04 the brief is ONE morning email: when
 * MORNING_BRIEF_ABSORB_ENABLED=true (morning-brief-absorb.js) it also carries
 *   - New leads in the last 24h        (was dailyLeadDigest, 07:00)
 *   - "You said you'd…"                (was callCenterSweep's 07:15 run)
 *   - Ready for a review ask (owner)   (was reviewRequestNudge's 08:15 email;
 *                                       the bell + once-ever mark are written here)
 * and sends on a day with no appointments when any of those has content.
 * Each appointment also gets ONE line from "Brief me" (lead-brief.js).
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
const Absorb = require('./morning-brief-absorb');
// Brief me's model call needs the key bound on THIS function too.
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const MAX_BRIEF_LINES = 10;
const PF = require('./production-flow-logic');

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

  // CRM-booked appointments (production flow, 2026-10-04): leads/{id}/tasks
  // type:'event' (lead-events.js). Read by the owner's uid (single-field
  // COLLECTION_GROUP index on tasks.userId) and fed in as appointments, today
  // only, on the owner's own leads. Its own try, like the jobs read.
  try {
    const leadsById = new Map(leads.map((l) => [String(l.id), l]));
    const ev = await db.collectionGroup('tasks').where('userId', '==', owner).get();
    for (const d of snapDocs(ev)) {
      const t = d.data() || {};
      if (t.type !== 'event') continue;
      const leadId = d.ref && d.ref.parent && d.ref.parent.parent && d.ref.parent.parent.id;
      const lead = leadId ? leadsById.get(String(leadId)) : null;
      if (!lead) continue;
      const appt = CF.leadEventToAppointment(t, lead, leadId, d.id);
      if (appt && appt.startTime >= fromMs && appt.startTime < toMs) appointments.push(appt);
    }
  } catch (e) {
    log.warn('morning_brief_events_read_failed', { err: e && e.message });
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
 * The absorbed sections (live + absorbing only). Each fails soft: one broken
 * read must not cost Jo the rest of the brief.
 */
async function gatherSections({ db, owner, nowMs, log }) {
  const soft = async (what, fn) => {
    try { return await fn(); } catch (e) { log.warn('morning_brief_section_failed', { what, err: e && e.message }); return []; }
  };
  const [newLeads, promises, reviewAsks] = await Promise.all([
    soft('new-leads', () => require('./lead-digest').gatherDigestRows(db, nowMs)),
    soft('promises', async () => (await require('./call-center').gatherSweep({ db, nowMs })).items),
    // Writes the owner's review bells + once-ever marks, exactly as the 08:15
    // run would have (it skips the owner while this absorbs it).
    soft('review-asks', async () => (await require('./review-request-nudge').nudgeUser(db, owner)).dueLeads),
  ]);
  return { newLeads, promises, reviewAsks };
}

/** "Brief me" one-liners for the day's appointment leads (cache → Haiku → fallback). */
async function gatherBriefLines({ db, leadIds, leadsById, nowMs, log }) {
  const out = {};
  const { getBrief } = require('./lead-brief');
  // The global AI kill switch turns these into the deterministic line.
  let useAi = true;
  try { useAi = !(await require('./integrations/killswitch').isAiDisabled()); } catch (_) { useAi = false; }
  for (const id of leadIds.slice(0, MAX_BRIEF_LINES)) {
    try {
      const b = await getBrief({ db, leadId: id, lead: leadsById.get(id) || {}, nowMs, log, useAi });
      if (b && b.oneLine) out[id] = b.oneLine;
    } catch (e) {
      log.warn('morning_brief_brief_line_failed', { leadId: id, err: e && e.message });
    }
  }
  return out;
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
 * @param {function} [deps.sections]  ({db,owner,nowMs,log}) → {newLeads,promises,reviewAsks}
 * @param {function} [deps.briefLines] ({db,leadIds,leadsById,nowMs,log}) → {leadId: line}
 * @returns {Promise<{status:string, items?:number, emailed?:boolean}>}
 */
async function runMorningBrief(deps) {
  const { db, env = {}, nowMs, makeResend, log = logger } = deps || {};
  const owner = (deps && deps.owner) || OWNER;
  const enabled = env.MORNING_BRIEF_ENABLED === 'true';
  const absorb = Absorb.absorbConfigured(env);

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
  const sections = absorb ? await ((deps && deps.sections) || gatherSections)({ db, owner, nowMs, log }) : null;
  // Production flow (2026-10-04): signed jobs with no day and no week. The
  // brief goes out for these alone too — they are the reason it exists.
  const needsWeek = PF.needsWeek(day.leads, day.jobs);
  if (pre.length === 0 && needsWeek.length === 0 && !MB.sectionsHaveContent(sections)) {
    log.info('morning_brief_nothing_today', { owner, date: day.today, mode: enabled ? 'live' : 'dry-run' });
    return { status: 'nothing-today', items: 0 };
  }

  const leadsById = new Map(day.leads.map((l) => [String(l.id), l]));
  const leadIds = [...new Set(pre.map((it) => it.leadId).filter((id) => id && leadsById.has(id)))];
  const hist = await readHistory(db, leadIds, (id) => (leadsById.get(id) || {}).companyId || owner, log);
  // One line per appointment (live runs only — a dry run spends no AI).
  const briefLines = enabled && leadIds.length
    ? await ((deps && deps.briefLines) || gatherBriefLines)({ db, leadIds, leadsById, nowMs, log }).catch(() => ({}))
    : {};

  // The weather.gov forecast for today's job days (warns only). Never fails
  // the brief: job-weather answers null on any trouble.
  const weatherFor = (deps && deps.weatherFor) || ((lead) => require('./job-weather')._internal.weatherByDay(db, lead, nowMs));
  const weatherByLead = {};
  for (const id of new Set(pre.filter((it) => it.source === 'job').map((it) => it.leadId))) {
    const lead = leadsById.get(String(id));
    if (!lead) continue;
    try { const w = await weatherFor(lead); if (w) weatherByLead[id] = w; } catch (_) { /* no weather line */ }
  }

  const brief = MB.buildBrief({
    appointments: day.appointments, leads: day.leads, jobs: day.jobs, nowMs,
    invoices: hist.invoices, activityByLead: hist.activityByLead, stormProofsByLead: hist.stormProofsByLead,
    sections, briefLines,
    weatherByLead, needsWeek,
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
    // Absorbing the lead digest: its two inboxes still get the morning mail.
    to: absorb ? [...new Set([user.email].concat(require('./lead-digest').DIGEST_EMAILS))] : user.email,
    subject: brief.subject,
    html: brief.html,
    text: brief.text,
  });
  if (resendRejected(response)) {
    log.error('morning_brief_send_rejected', { owner, err: resendErrorMessage(response) });
    return { status: 'rejected', items: brief.items.length };
  }
  log.info('morning_brief_sent', { owner, date: brief.today, items: brief.items.length, sections: brief.sectionCounts });
  return { status: 'sent', items: brief.items.length, emailed: true, sections: brief.sectionCounts };
}

// ─── Scheduled function ──────────────────────────────────────────
// 06:45 Eastern — after googleCalendarReconcile (05:45) and before Jo leaves
// for the first job; dailyLeadDigest follows at 07:00.
exports.morningBrief = onSchedule(
  {
    schedule: '45 6 * * *',
    timeZone: 'America/New_York',
    secrets: [RESEND_API_KEY, EMAIL_FROM, ANTHROPIC_API_KEY],
    maxInstances: 1,
    timeoutSeconds: 300,
    memory: '512MiB',
  },
  async () => {
    const env = {
      MORNING_BRIEF_ENABLED: process.env.MORNING_BRIEF_ENABLED,
      MORNING_BRIEF_ABSORB_ENABLED: process.env.MORNING_BRIEF_ABSORB_ENABLED,
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

exports._test = { runMorningBrief, readDay, readHistory, gatherSections, gatherBriefLines, OWNER };
