'use strict';
/**
 * owner-weekly-digest.js — ownerWeeklyDigest (2026-10-22): Monday 07:30 Eastern,
 * file ONE Agent-inbox `report` per company for its OWNER: collected last week,
 * estimates awaiting signature (projected), calls to return, jobs this week.
 * Rules and wording: owner-weekly-digest-logic.js.
 *
 * Writes (only when live): agent_inbox/ownerdigest_<company>_<monday>, created
 * with create() so a retry or a second run files each week ONCE, plus one bell
 * per company. NOTHING goes to a customer or a rep: no SMS, no email, no draft.
 *
 * Gate: OWNER_WEEKLY_DIGEST_ENABLED=true. Anything else computes and LOGS
 * counts only, writes nothing.
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue, FieldPath } = require('firebase-admin/firestore');
const L = require('./agent-mcp-logic');
const D = require('./owner-weekly-digest-logic');

const enabled = () => process.env.OWNER_WEEKLY_DIGEST_ENABLED === 'true';
const isAlreadyExists = (e) => !!e && (e.code === 6 || /already exists/i.test(String(e.message || '')));
const NBD_OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

// Docs owned by the company under any of its owner fields, de-duplicated
// (solo accounts own by uid, team accounts by companyId).
async function docsOf(db, collection, companyId, fields) {
  const snaps = await Promise.all(fields.map((f) => db.collection(collection).where(f, '==', companyId).limit(5000).get()));
  const byId = {};
  snaps.forEach((s) => s.docs.forEach((d) => { byId[d.id] = Object.assign({ id: d.id }, d.data()); }));
  return Object.values(byId);
}

// A deal room carries only its creator's uid (no companyId), so a team's rooms are the ones its reps created. The
// reps are the distinct userIds on the company's own leads: one query per rep, nothing from a uid that owns none of
// the company's leads (pass-2 item 2, 2026-10-25).
function repUids(leads, companyId) {
  const s = new Set();
  (leads || []).forEach((l) => { if (l && l.userId && String(l.userId) !== String(companyId)) s.add(String(l.userId)); });
  return Array.from(s).slice(0, 50);
}
async function dealRoomsOf(db, companyId, leads) {
  const uids = [String(companyId)].concat(repUids(leads, companyId));
  const snaps = await Promise.all(uids.map((u) => db.collection('deal_rooms').where('userId', '==', u).limit(5000).get()));
  const byId = {};
  snaps.forEach((s) => s.docs.forEach((d) => { byId[d.id] = Object.assign({ id: d.id }, d.data()); }));
  return Object.values(byId);
}

async function jobsByLead(db, companyId) {
  try {
    const snaps = await Promise.all(['companyId', 'userId'].map((f) =>
      db.collectionGroup('jobs').where(f, '==', companyId).limit(5000).get()));
    return require('./jobs-logic').jobsByLeadFromDocs(snaps.reduce((all, sn) => all.concat(sn.docs), []));
  } catch (e) {
    // null = "could not read" (an empty calendar is {}); the digest then says unavailable, never "none"
    logger.warn('[ownerWeeklyDigest] jobs read failed', { companyId, msg: e && e.message });
    return null;
  }
}

async function ownerFor(db, companyId) {
  try {
    const s = await db.doc('companies/' + companyId).get();
    const o = s.exists ? String((s.data() || {}).ownerId || '') : '';
    if (o) return o;
  } catch (_) { /* fall through */ }
  return companyId;
}

async function tzFor(db, companyId) {
  try {
    const s = await db.doc('companyProfile/' + companyId).get();
    const tz = s.exists ? String((s.data() || {}).timezone || '') : '';
    if (tz) { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
  } catch (_) { /* Eastern */ }
  return 'America/New_York';
}

async function runDigest({ db, nowMs, live, gatherCalls }) {
  const out = { companies: 0, filed: 0, alreadyFiled: 0, failed: 0 };
  // Page the companies by document id: a single limit(500) read would skip company 501+ (pass-2 item 2, 2026-10-25).
  let cursor = null;
  while (true) {
    let q = db.collection('companies').orderBy(FieldPath.documentId()).limit(500);
    if (cursor) q = q.startAfter(cursor);
    const cs = await q.get();
    if (cs.empty) break;
    cursor = cs.docs[cs.docs.length - 1];
  for (const doc of cs.docs) {
    const companyId = doc.id;
    out.companies++;
    try {
      const tz = await tzFor(db, companyId);
      const todayYmd = L.dayInZone(nowMs, tz);
      const owner = await ownerFor(db, companyId);
      const leads = await docsOf(db, 'leads', companyId, ['companyId', 'userId']);
      const [invoices, estimates, deals, jbl] = await Promise.all([
        docsOf(db, 'invoices', companyId, ['companyId', 'createdBy']),
        docsOf(db, 'estimates', companyId, ['companyId', 'userId']),
        dealRoomsOf(db, companyId, leads),
        jobsByLead(db, companyId),
      ]);
      // The Call Center is NBD's owner account only today.
      let callItems = null;
      if (owner === NBD_OWNER && gatherCalls) {
        try { callItems = (await gatherCalls({ db, nowMs })).items; } catch (e) { logger.warn('[ownerWeeklyDigest] calls read failed', { msg: e && e.message }); }
      }
      const digest = D.buildDigest({ leads, jobsByLead: jbl, jobsUnavailable: jbl === null, invoices, estimates, deals, callItems, todayYmd, tz });
      if (!live) continue;
      const r = D.render(digest);
      try {
        await db.doc('agent_inbox/ownerdigest_' + companyId + '_' + digest.thisWeek.from).create({
          companyId, bot: 'Weekly digest', botId: 'owner-digest', status: 'pending', verified: false,
          createdAt: FieldValue.serverTimestamp(), keyId: 'owner-digest',
          kind: 'report', leadId: null, title: r.title, text: r.text, dueDate: null,
        });
        out.filed++;
        await db.doc('notifications/ownerdigest_' + companyId + '_' + digest.thisWeek.from).set({
          userId: owner, companyId, type: 'agent_inbox', priority: 'normal',
          title: 'Your Monday digest is in the Agent inbox', message: 'Collected last week, estimates awaiting signature, calls to return, jobs this week.',
          read: false, dismissed: false, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }).catch((e) => logger.warn('[ownerWeeklyDigest] bell failed', { msg: e && e.message }));
      } catch (e) {
        if (isAlreadyExists(e)) out.alreadyFiled++; else throw e;
      }
    } catch (e) {
      out.failed++;
      logger.warn('[ownerWeeklyDigest] company failed', { msg: e && e.message });
    }
  }
    if (cs.docs.length < 500) break;
  }
  return out;
}

exports.runDigest = runDigest;
exports.ownerWeeklyDigest = onSchedule(
  { schedule: '30 7 * * 1', timeZone: 'America/New_York', maxInstances: 1, timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const live = enabled();
    const gatherCalls = (a) => require('./call-center').gatherSweep(a);
    const r = await runDigest({ db: getFirestore(), nowMs: Date.now(), live, gatherCalls });
    logger.info(live ? 'owner_weekly_digest_run' : 'owner_weekly_digest_dry_run', r);
  },
);
