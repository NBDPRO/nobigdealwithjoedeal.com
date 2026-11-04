'use strict';
/**
 * doc-link-followup.js — docLinkFollowupSweep (2026-11-04): hourly, files ONE
 * Agent-inbox reminder to the OWNER 24 hours after a secure document link was
 * first opened. NOTHING goes to the customer (no SMS, email or draft).
 *
 * The inbox id is deterministic (doclink_<token first 10>_fu) and written with
 * create(), so repeated or overlapping runs file it once. The reminder hides
 * itself (the due time is cleared, nothing filed) when the lead moved on, the
 * link was revoked or expired, Jo already nudged after the first open
 * (lastEstimateNudgeAt), or the customer wrote (lastInboundAt).
 *
 * Gate: DOC_LINK_FOLLOWUP_ENABLED=true. Anything else computes and logs counts
 * only and writes nothing. Query: one single-field range on followUpDueAtMs
 * (the emulator does not enforce composite indexes), the rest filtered here.
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const L = require('./doc-link-logic');
const EVA = require('./estimate-view-alert');

const isAlreadyExists = (e) => !!e && (e.code === 6 || /already exists/i.test(String(e.message || '')));

async function tzFor(db, companyId) {
  try {
    const s = await db.doc('companyProfile/' + companyId).get();
    const tz = s.exists ? String((s.data() || {}).timezone || '') : '';
    if (tz) { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
  } catch (_) { /* Eastern */ }
  return 'America/New_York';
}

async function runSweep({ db, nowMs, live }) {
  const snap = await db.collection('report_share_tokens').where('followUpDueAtMs', '<=', nowMs).limit(200).get();
  const out = { scanned: 0, due: 0, filed: 0, alreadyFiled: 0, cleared: 0, failed: 0 };
  for (const d of snap.docs) {
    const tok = d.data() || {};
    out.scanned++;
    let lead = null;
    try {
      if (tok.leadId) { const ls = await db.doc('leads/' + tok.leadId).get(); lead = ls.exists ? ls.data() : null; }
    } catch (_) { lead = null; }
    const dec = L.followUpDecision(tok, lead, nowMs);
    if (dec.action === 'file') {
      out.due++;
      if (!live) continue;
      const id = d.id.slice(0, 10);
      const c = L.reminderCopy({
        name: EVA.leadName(lead), docLabel: tok.docLabel || tok.filename, openCount: tok.openCount,
        readSeconds: tok.readSeconds, firstOpenedAtMs: L.ms(tok.firstOpenedAt), tz: await tzFor(db, tok.companyId),
      });
      try {
        await db.doc('agent_inbox/doclink_' + id + '_fu').create({
          companyId: tok.companyId, bot: 'Document tracker', botId: 'doc-tracker', status: 'pending', verified: false,
          kind: 'reminder', leadId: tok.leadId, title: c.title, text: c.text, dueDate: null,
          createdAt: FieldValue.serverTimestamp(), keyId: 'doc-tracker',
        });
        out.filed++;
        await db.doc('notifications/doclink_fu_' + id).set({
          userId: tok.ownerUid, companyId: tok.companyId, type: 'agent_inbox', priority: 'normal', leadId: tok.leadId,
          title: '📄 ' + c.title, message: 'Check your Agent inbox. Nothing was sent to the customer.', read: false, dismissed: false,
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }).catch((e) => logger.warn('[docLinkFollowup] bell failed', { msg: e && e.message }));
      } catch (e) {
        if (isAlreadyExists(e)) out.alreadyFiled++;
        else { out.failed++; logger.warn('[docLinkFollowup] write failed', { msg: e && e.message }); continue; }
      }
      await d.ref.update({ followUpFiledAt: FieldValue.serverTimestamp(), followUpDueAtMs: null }).catch(() => {});
    } else if (dec.clear && live) {
      out.cleared++;
      await d.ref.update({ followUpDueAtMs: null, followUpSkippedReason: dec.reason }).catch(() => {});
    }
  }
  return out;
}

exports.runSweep = runSweep;
exports.docLinkFollowupSweep = onSchedule(
  { schedule: '17 * * * *', timeZone: 'America/New_York', maxInstances: 1, timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const live = process.env.DOC_LINK_FOLLOWUP_ENABLED === 'true';
    const r = await runSweep({ db: getFirestore(), nowMs: Date.now(), live });
    logger.info(live ? 'doc_link_followup_run' : 'doc_link_followup_dry_run', r);
  },
);
