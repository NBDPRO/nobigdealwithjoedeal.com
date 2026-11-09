'use strict';
/**
 * leaderboard-aggregate.js — leaderboardAggregate (NBD OS P2 "Team", 2026-11-09):
 * every 30 minutes, for every company, one row per active member at
 * leaderboard/{uid} with today's and this week's counted numbers (doors,
 * appointments set, estimates sent, deals won) in the company's time zone
 * (companyProfile.timeZone; rules and metrics: leaderboard-aggregate-logic.js).
 *
 * Readers: the Leaderboard page (pages/leaderboard.js, one query of the
 * company's rows instead of every lead, knock and invoice the rep owns) and the
 * owner's Team widget on the NBD OS home (os/team.js). firestore.rules lets the
 * member and their company read a row and no client write one.
 *
 * Reads per company per run: the company doc, its profile, its members, each
 * member's users doc (users/{uid}.companyId: see membersOf), then per member the
 * knocks since Monday (userId, createdAt >= week start; index userId ASC,
 * createdAt ASC), the leads updated since Monday (userId, updatedAt >= week
 * start, newest first; index userId ASC, updatedAt DESC), and the jobs written
 * since Monday in one collectionGroup query (userId, updatedAt >= week start;
 * index jobs COLLECTION_GROUP userId ASC, updatedAt ASC) plus the lead of any
 * such job whose lead was not updated, and the company's existing rows. A sale
 * or an estimate move this week stamps updatedAt this week on what it moved
 * (stage-write.js on the lead, NBDJobs.update on a second job), so these hold
 * every one of them. Rewrites each member's row every run (asOfMs, shown as
 * 'Updated', is the last run), and deletes the row of anyone no longer an
 * active member.
 *
 * Time budget: companies run four at a time; a run stops starting companies 4
 * minutes in (timeoutSeconds 300), keeps where it stopped in
 * system/leaderboardAggregate { cursor }, and the next run resumes after it and
 * wraps round, so no company is silently left out of a large tenant set.
 *
 * Gate: LEADERBOARD_AGGREGATE_ENABLED=true. Anything else computes and LOGS
 * counts only and writes nothing (the page and widget then show their own
 * fallback / empty state), and counts ONE company per run (the first by id,
 * DRY_RUN_COMPANIES), so a dark feature does not bill every company's reads
 * 48 times a day.
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');
const L = require('./leaderboard-aggregate-logic');
const jobsLogic = require('./jobs-logic');

const enabled = () => process.env.LEADERBOARD_AGGREGATE_ENABLED === 'true';
const MAX_MEMBERS = 50;
const STATE_DOC = 'system/leaderboardAggregate';
const DRY_RUN_COMPANIES = 1; // the dry run (gate off) counts this many companies per run, enough to check its log
const BUDGET_MS = 240000;  // stop starting companies 4 minutes in (timeoutSeconds 300); the next run resumes
const CAP = 2000;          // knocks / leads per member per week: far above one rep's week

const all = (snap) => { const out = []; snap.forEach((d) => out.push(Object.assign({ id: d.id }, d.data()))); return out; };
const docData = async (ref) => { const s = await ref.get(); return s.exists ? (s.data() || {}) : null; };

/**
 * Active members with a uid, the owner first (named from their member row, else users/{uid}).
 * Anyone whose users/{uid}.companyId names ANOTHER company (set when an invite is accepted:
 * handlers/invites.js) is counted there, not here: an owner with no member row whose solo company
 * was superseded, or a member whose row in a company they left was never deactivated. Else both
 * companies would write, and flip, the same leaderboard/{uid} every run.
 */
async function membersOf(db, companyId, company) {
  const rows = all(await db.collection('companies/' + companyId + '/members').get());
  const byUid = {};
  rows.forEach((m) => {
    if (!m || !m.uid || (m.status && m.status !== 'active')) return;
    byUid[m.uid] = { uid: String(m.uid), name: String(m.displayName || m.name || '').trim() };
  });
  const owner = String((company && company.ownerId) || companyId);
  if (!byUid[owner]) byUid[owner] = { uid: owner, name: '', noRow: true };
  // one users/{uid} read per member (at most MAX_MEMBERS + 1), against the knocks / leads / jobs
  // queries each member already costs
  const uids = Object.keys(byUid).slice(0, MAX_MEMBERS + 1);
  const users = await Promise.all(uids.map((uid) => docData(db.doc('users/' + uid)).catch(() => null)));
  const list = [];
  uids.forEach((uid, i) => {
    const u = users[i];
    const elsewhere = u && typeof u.companyId === 'string' && u.companyId && u.companyId !== companyId;
    if (elsewhere) return;
    const m = byUid[uid];
    if (m.noRow) m.name = String((u && (u.displayName || [u.firstName, u.lastName].filter(Boolean).join(' '))) || '').trim();
    list.push({ uid: m.uid, name: m.name });
  });
  list.sort((a, b) => (a.uid === owner ? -1 : b.uid === owner ? 1 : 0));
  return list.slice(0, MAX_MEMBERS);
}

async function countedFor(db, uid, b) {
  const since = new Date(b.weekStartMs);
  const [knocks, leads] = await Promise.all([
    db.collection('knocks').where('userId', '==', uid).where('createdAt', '>=', since).limit(CAP).get().then(all),
    db.collection('leads').where('userId', '==', uid).where('updatedAt', '>=', since).orderBy('updatedAt', 'desc').limit(CAP).get().then(all),
  ]);
  // Jobs: one collectionGroup query of the member's jobs written since Monday (index jobs
  // COLLECTION_GROUP userId ASC, updatedAt ASC), not a get per lead. A job moved on its own
  // (a customer's second job: crm-pipeline.js _moveJobCard -> NBDJobs.update) stamps only the
  // job's updatedAt, so this also finds a sale on a customer whose lead was not touched; that
  // customer's lead is then read by id (the active job is the lead: jobs-logic.js jobRecords).
  let jobsByLead = {};
  try {
    const js = await db.collectionGroup('jobs').where('userId', '==', uid).where('updatedAt', '>=', since).limit(CAP).get();
    jobsByLead = jobsLogic.jobsByLeadFromDocs(js.docs || []);
    const have = new Set(leads.map((l) => l.id));
    const missing = Object.keys(jobsByLead).filter((id) => !have.has(id));
    const extra = await Promise.all(missing.map((id) => db.collection('leads').doc(id).get()));
    extra.forEach((s) => { if (s && s.exists) leads.push(Object.assign({ id: s.id }, s.data())); });
  } catch (e) {
    jobsByLead = null;   // each customer then counts once, by its own fields
  }
  return { knocks, leads, jobsByLead };
}

async function runCompany(db, companyId, company, nowMs, live, out) {
  const zone = L.companyZone(await docData(db.doc('companyProfile/' + companyId)));
  const b = L.bounds(nowMs, zone.tz);
  const members = await membersOf(db, companyId, company);
  const knocks = [], leads = [], jobsByLead = {};
  let jobsOk = true;
  for (const m of members) {
    const c = await countedFor(db, m.uid, b);
    knocks.push(...c.knocks);
    leads.push(...c.leads);
    if (c.jobsByLead === null) jobsOk = false; else Object.assign(jobsByLead, c.jobsByLead);
  }
  // a lead can come back for two members (moved by one, owned by another): count it once
  const seen = {};
  const uniq = leads.filter((l) => (seen[l.id] ? false : (seen[l.id] = true)));
  const rows = L.memberRows({ members, knocks, leads: uniq, jobsByLead: jobsOk ? jobsByLead : null, bounds: b });
  const existing = {};
  (await db.collection('leaderboard').where('companyId', '==', companyId).get()).forEach((d) => { existing[d.id] = d.data() || {}; });
  for (const m of members) {
    const row = L.rowDoc({ companyId, uid: m.uid, name: m.name, metrics: rows[m.uid], bounds: b, zone, nowMs });
    const prev = existing[m.uid];
    delete existing[m.uid];
    // Every row is restamped each run, numbers unchanged or not: asOfMs is when it was last
    // counted, which the Team widget and the Leaderboard page show as 'Updated h:mm' (a skipped
    // write made that the time of the last change, and hid a run that had stopped).
    const same = L.sameRow(row, prev);
    if (same) out.unchanged++;
    if (!live) { if (!same) out.wouldWrite++; continue; }
    await db.collection('leaderboard').doc(m.uid).set(row);
    out.written++;
  }
  for (const uid of Object.keys(existing)) {
    if (!live) { out.wouldRemove++; continue; }
    await db.collection('leaderboard').doc(uid).delete();
    out.removed++;
  }
}

/**
 * Every company, in id order, starting after `startAfter` (the cursor a run that ran out of
 * time left) and wrapping round to the start, so a large tenant set is counted across runs
 * instead of the companies past a timeout never being counted. Companies run `concurrency`
 * at a time; before each group the clock is checked against `deadlineMs`, and an
 * out-of-time run stops with partial:true and next = the last company it finished (or, when
 * it finished none, the cursor it was given, so the resume point is never lost).
 */
async function runAggregate({ db, nowMs, live, startAfter = null, deadlineMs = Infinity, clock = Date.now, concurrency = 4, maxCompanies = Infinity }) {
  const out = { companies: 0, written: 0, unchanged: 0, removed: 0, wouldWrite: 0, wouldRemove: 0, failed: 0, partial: false, capped: false, next: null };
  const one = async (d) => {
    out.companies++;
    try {
      await runCompany(db, d.id, d.data() || {}, nowMs, live, out);
    } catch (e) {
      out.failed++;
      logger.warn('[leaderboardAggregate] company failed', { msg: e && e.message });
    }
  };
  const width = Math.max(1, concurrency | 0);
  let last = startAfter ? String(startAfter) : null;   // out of time before the first group: resume where this run was asked to
  // pass 1: after the cursor to the end; pass 2 (a resumed run): the start up to the cursor
  const passes = startAfter ? [{ after: String(startAfter), until: null }, { after: null, until: String(startAfter) }] : [{ after: null, until: null }];
  for (const pass of passes) {
    let cursor = null;
    let first = true;
    // page the companies by id (a single limit(500) read would skip company 501+)
    for (;;) {
      let q = db.collection('companies').orderBy(FieldPath.documentId()).limit(500);
      if (cursor) q = q.startAfter(cursor);
      else if (first && pass.after) q = q.startAfter(pass.after);
      first = false;
      const cs = await q.get();
      if (cs.empty) break;
      cursor = cs.docs[cs.docs.length - 1];
      const docs = pass.until ? cs.docs.filter((d) => d.id <= pass.until) : cs.docs;
      for (let i = 0; i < docs.length; ) {
        if (clock() >= deadlineMs) { out.partial = true; out.next = last; return out; }
        if (out.companies >= maxCompanies) { out.capped = true; return out; }   // the dry run's cap: no cursor kept
        const group = docs.slice(i, i + Math.min(width, maxCompanies - out.companies));
        await Promise.all(group.map(one));
        last = group[group.length - 1].id;
        i += group.length;
      }
      if (cs.docs.length < 500 || docs.length < cs.docs.length) break;
    }
  }
  return out;
}

exports.runAggregate = runAggregate;
exports.leaderboardAggregate = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/New_York', maxInstances: 1, timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const live = enabled();
    const db = getFirestore();
    const start = Date.now();
    // the resume cursor (server only: firestore.rules closes system/{doc} to every client)
    const state = live ? ((await docData(db.doc(STATE_DOC)).catch(() => null)) || {}) : {};
    const r = await runAggregate({ db, nowMs: start, live, startAfter: state.cursor || null, deadlineMs: start + BUDGET_MS, maxCompanies: live ? Infinity : DRY_RUN_COMPANIES });
    if (live && (r.next || state.cursor)) await db.doc(STATE_DOC).set({ cursor: r.next || null, at: Date.now() });
    if (r.partial) logger.warn('leaderboard_aggregate_partial', { next: r.next, companies: r.companies });
    logger.info(live ? 'leaderboard_aggregate_run' : 'leaderboard_aggregate_dry_run', r);
  },
);
