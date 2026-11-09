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
 * createdAt ASC) and the leads updated since Monday (userId, updatedAt >= week
 * start, newest first; index userId ASC, updatedAt DESC) with each such lead's
 * jobs, and the company's existing rows. A sale or an estimate move this week
 * stamps updatedAt this week (stage-write.js), so the updated leads hold every
 * one of them. Writes only rows that changed, and deletes the row of anyone no
 * longer an active member.
 *
 * Gate: LEADERBOARD_AGGREGATE_ENABLED=true. Anything else computes and LOGS
 * counts only and writes nothing (the page and widget then show their own
 * fallback / empty state).
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldPath } = require('firebase-admin/firestore');
const L = require('./leaderboard-aggregate-logic');

const enabled = () => process.env.LEADERBOARD_AGGREGATE_ENABLED === 'true';
const MAX_MEMBERS = 50;
const CAP = 2000;          // knocks / leads per member per week: far above one rep's week
const JOB_LEADS = 300;     // leads whose jobs are read per member

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
    byUid[owner] = { uid: owner, name: String((u && (u.displayName || [u.firstName, u.lastName].filter(Boolean).join(' '))) || '').trim() };
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
  let jobsByLead = {};
  try {
    const live = leads.filter((l) => l && !l.deleted).slice(0, JOB_LEADS);
    const snaps = await Promise.all(live.map((l) => db.collection('leads').doc(l.id).collection('jobs').get()));
    snaps.forEach((s, i) => { const js = all(s); if (js.length) jobsByLead[live[i].id] = js; });
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
    if (L.sameRow(row, prev)) { out.unchanged++; continue; }
    if (!live) { out.wouldWrite++; continue; }
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
