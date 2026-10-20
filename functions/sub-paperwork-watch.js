'use strict';
/**
 * sub-paperwork-watch.js — subPaperworkWatch (2026-10-19): daily 09:15 Eastern,
 * look at every company's independent subcontractors (companies/{id}/subs) and
 * tell the OWNER when a sub's liability certificate, workers' comp certificate or
 * license reaches 30 / 14 / 7 days or has ended. Rules and wording:
 * sub-paperwork-logic.js (day bands shared with companyDocExpiryWatch).
 *
 * Writes (only when live): one Agent-inbox `report` per paper per stage
 * (agent_inbox/subdoc_<company>_<sub>_<kind>_<expiry>_<stage>, created with
 * create(), so a daily run files each stage ONCE and a renewal starts fresh) and
 * one bell notification per company per day. NOTHING goes to a sub or a customer:
 * no SMS, no email, no draft. Reads only companies/{id}/subs, the company doc and
 * companyProfile (time zone).
 *
 * Gate: SUB_PAPERWORK_WATCH_ENABLED=true. Anything else computes and LOGS what it
 * would file (counts only; no names), writes nothing. Ships dark.
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const L = require('./sub-paperwork-logic');

const enabled = () => process.env.SUB_PAPERWORK_WATCH_ENABLED === 'true';
const isAlreadyExists = (e) => !!e && (e.code === 6 || /already exists/i.test(String(e.message || '')));

/** The company's time zone (companyProfile/{id}.timezone, an IANA name) or Eastern. */
async function zoneFor(db, companyId) {
  try {
    const s = await db.doc('companyProfile/' + companyId).get();
    const tz = s.exists ? String((s.data() || {}).timezone || '') : '';
    if (tz) { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
  } catch (_) { /* unreadable or not an IANA name: Eastern */ }
  return L.DEFAULT_TZ;
}

/** Who the bell goes to: the company doc's ownerId, else the company id (a solo owner's uid). */
async function ownerFor(db, companyId) {
  try {
    const s = await db.doc('companies/' + companyId).get();
    const o = s.exists ? String((s.data() || {}).ownerId || '') : '';
    if (o) return o;
  } catch (_) { /* fall through */ }
  return companyId;
}

async function runWatch({ db, nowMs, live }) {
  // No where() on purpose: a collection-group filter needs a deployed index, and
  // the emulator would never tell us it is missing (it does not enforce indexes).
  const snap = await db.collectionGroup('subs').limit(5000).get();
  const byCompany = {};
  snap.forEach((d) => {
    const m = /^companies\/([^/]+)\/subs\/([^/]+)$/.exec(d.ref.path);
    if (!m) return;
    // the path's id goes LAST: a stray `id` field in the data must never win
    (byCompany[m[1]] = byCompany[m[1]] || []).push(Object.assign({}, d.data(), { id: m[2] }));
  });
  if (snap.size >= 5000) logger.warn('[subPaperworkWatch] 5000 subs read: the list may be cut short');

  const out = { companies: 0, due: 0, filed: 0, alreadyFiled: 0, failed: 0 };
  for (const companyId of Object.keys(byCompany)) {
    out.companies++;
    const today = L.ymdInZone(nowMs, await zoneFor(db, companyId));
    const alerts = L.planAlerts(companyId, byCompany[companyId], today);
    out.due += alerts.length;
    if (!alerts.length || !live) continue;
    let filedHere = 0;
    for (const a of alerts) {
      try {
        await db.doc('agent_inbox/' + a.id).create(Object.assign({
          companyId, bot: 'Sub paperwork watch', botId: 'sub-paperwork-watch', status: 'pending', verified: false,
          createdAt: FieldValue.serverTimestamp(), keyId: 'sub-paperwork-watch', stage: a.stage,
        }, a.item));
        out.filed++; filedHere++;
      } catch (e) {
        if (isAlreadyExists(e)) out.alreadyFiled++;
        else { out.failed++; logger.warn('[subPaperworkWatch] write failed', { msg: e && e.message }); }
      }
    }
    if (filedHere) {
      const ownerUid = await ownerFor(db, companyId);
      await db.doc('notifications/subdoc_' + companyId + '_' + today).set({
        userId: ownerUid, companyId, type: 'agent_inbox', priority: 'normal',
        title: '📄 ' + filedHere + (filedHere === 1 ? ' sub paper needs renewing' : ' sub papers need renewing'),
        message: 'Check your Agent inbox, or Expenses > Sub paperwork.',
        count: filedHere, read: false, dismissed: false,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true }).catch((e) => logger.warn('[subPaperworkWatch] bell failed', { msg: e && e.message }));
    }
  }
  return out;
}

exports.runWatch = runWatch;
exports.subPaperworkWatch = onSchedule(
  { schedule: '15 9 * * *', timeZone: 'America/New_York', maxInstances: 1, timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const live = enabled();
    const r = await runWatch({ db: getFirestore(), nowMs: Date.now(), live });
    logger.info(live ? 'sub_paperwork_watch_run' : 'sub_paperwork_watch_dry_run', r);
  },
);
