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
 * Reads per company per run: the company doc, its profile, its members, the
 * owner's users doc when the owner has no member row, then per member the
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
 * Gate: LEADERBOARD_AGGREGATE_ENABLED=true. Anything else computes and LOGS
 * counts only and writes nothing (the page and widget then show their own
 * fallback / empty state).
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');
const L = require('./leaderboard-aggregate-logic');
const jobsLogic = require('./jobs-logic');

const enabled = () => process.env.LEADERBOARD_AGGREGATE_ENABLED === 'true';
const MAX_MEMBERS = 50;
const CAP = 2000;          // knocks / leads per member per week: far above one rep's week

const all = (snap) => { const out = []; snap.forEach((d) => out.push(Object.assign({ id: d.id }, d.data()))); return out; };
const docData = async (ref) => { const s = await ref.get(); return s.exists ? (s.data() || {}) : null; };

/** Active members with a uid, the owner first (named from their member row, else users/{uid}). */
async function membersOf(db, companyId, company) {
  const rows = all(await db.collection('companies/' + companyId + '/members').get());
  const byUid = {};
  rows.forEach((m) => {
    if (!m || !m.uid || (m.status && m.status !== 'active')) return;
    byUid[m.uid] = { uid: String(m.uid), name: String(m.displayName || m.name || '').trim() };
  });
  const owner = String((company && company.ownerId) || companyId);
  if (!byUid[owner]) {
    const u = await docData(db.doc('users/' + owner)).catch(() => null);
    // An owner with no member row who now belongs to ANOTHER company (users/{uid}.companyId is
    // set when an invite is accepted: handlers/invites.js) is counted there, not here: else the
    // old solo company and the new one would both write, and flip, the same leaderboard/{uid}.
    const elsewhere = u && typeof u.companyId === 'string' && u.companyId && u.companyId !== companyId;
    if (!elsewhere) byUid[owner] = { uid: owner, name: String((u && (u.displayName || [u.firstName, u.lastName].filter(Boolean).join(' '))) || '').trim() };
  }
  const list = Object.values(byUid);
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

async function runAggregate({ db, nowMs, live }) {
  const out = { companies: 0, written: 0, unchanged: 0, removed: 0, wouldWrite: 0, wouldRemove: 0, failed: 0 };
  let cursor = null;
  // page the companies by id (a single limit(500) read would skip company 501+)
  for (;;) {
    let q = db.collection('companies').orderBy(FieldPath.documentId()).limit(500);
    if (cursor) q = q.startAfter(cursor);
    const cs = await q.get();
    if (cs.empty) break;
    cursor = cs.docs[cs.docs.length - 1];
    for (const d of cs.docs) {
      out.companies++;
      try {
        await runCompany(db, d.id, d.data() || {}, nowMs, live, out);
      } catch (e) {
        out.failed++;
        logger.warn('[leaderboardAggregate] company failed', { msg: e && e.message });
      }
    }
    if (cs.docs.length < 500) break;
  }
  return out;
}

exports.runAggregate = runAggregate;
exports.leaderboardAggregate = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/New_York', maxInstances: 1, timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const live = enabled();
    const r = await runAggregate({ db: getFirestore(), nowMs: Date.now(), live });
    logger.info(live ? 'leaderboard_aggregate_run' : 'leaderboard_aggregate_dry_run', r);
  },
);
