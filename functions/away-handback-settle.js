'use strict';
/**
 * functions/away-handback-settle.js - keep the away-mode hand-back timeline
 * row TRUE after the hand-back (2026-10-13).
 *
 * fileHandBackTimeline (away-mode.js) writes ONE row per open item at the
 * moment the window ends: "Sam: Says done - sent the estimate", with
 * backupSaysDone. The row is a snapshot of what the BACKUP claimed. It used
 * to read "(they say it is done)" forever, even after Jo cleared the person
 * from his needs-you list, so the timeline kept saying a claim was
 * outstanding that Jo had already closed.
 *
 * This runs after Jo's own clearing actions (callCenterAction: Handled /
 * Undo, Done / Undo on the follow-up task, a promise taken, and the
 * onCallTaskWrite mirror). It re-asks the same source of truth the
 * hand-back used (loadOpenItems, i.e. callWatch's own callNeedsYou) whether
 * that person STILL needs Jo, then idempotently stamps / unstamps three
 * fields on the existing activity doc:
 *
 *   clearedAtMs     when the person left the needs-you list (null = open)
 *   clearedByUid    who did it ('' when it came from a task tick mirror)
 *   clearedByName   that person's first name from their token ('' = unknown)
 *
 * The renderer (docs/pro/js/call-timeline.js) turns those into "handed
 * back; cleared by Jo on Oct 13". Nothing here is sent to a customer, no
 * lead / call / task doc is written, and an unknown name is left unknown.
 * Best effort: a failure is logged and never blocks the clearing action.
 */
const { logger } = require('firebase-functions/v2');
const L = require('./away-mode-logic');

const MAX_DOCS = 20;

async function leadIdFor(db, cid, phone10) {
  const ids = new Set();
  for (const f of ['userId', 'companyId']) {
    const s = await db.collection('leads').where(f, '==', cid).where('phoneDigits', '==', phone10).get();
    s.forEach((d) => { if ((d.data() || {}).deleted !== true) ids.add(d.id); });
  }
  // same rule as filing: a number on zero or on several leads gets no note,
  // so there is nothing here to settle either.
  return ids.size === 1 ? Array.from(ids)[0] : '';
}

/**
 * @param db        Firestore
 * @param call      the phone_calls / phone_text_days doc data (phoneDigits, companyId|userId)
 * @param opts      { nowMs, byUid, byName, loadItems?, log? }
 * @returns         { settled: n, reopened: n } (zeros when nothing applies)
 */
async function settleHandBackTimeline(db, call, opts) {
  const o = opts || {};
  const log = o.log || logger;
  const out = { settled: 0, reopened: 0 };
  try {
    const phone10 = L.digits10(call && call.phoneDigits);
    if (!/^[0-9]{10}$/.test(phone10)) return out;
    const cid = String((call && (call.companyId || call.userId)) || '');
    if (!cid) return out;
    const leadId = await leadIdFor(db, cid, phone10);
    if (!leadId) return out;
    const snap = await db.collection('leads/' + leadId + '/activity').where('type', '==', 'away_handback').get();
    const docs = [];
    snap.forEach((d) => {
      const id = String(d.id || '');
      if (id.startsWith('away-') && id.endsWith('-' + phone10)) docs.push({ id, data: d.data() || {} });
    });
    if (!docs.length) return out;
    // Only now pay for the open-items read.
    const loadItems = o.loadItems || ((d, c, n) => require('./away-mode')._internal.loadOpenItems(d, c, n));
    const open = await loadItems(db, cid, o.nowMs);
    const stillOpen = (Array.isArray(open) ? open : []).some((it) => L.digits10(it && it.phone10) === phone10);
    const name = L.cleanLine(L.firstName(o.byName || ''), 40);
    for (const d of docs.slice(0, MAX_DOCS)) {
      const cleared = Number(d.data.clearedAtMs) > 0;
      const ref = db.doc('leads/' + leadId + '/activity/' + d.id);
      if (!stillOpen && !cleared) {
        await ref.set({ clearedAtMs: o.nowMs, clearedByUid: String(o.byUid || ''), clearedByName: name }, { merge: true });
        out.settled++;
      } else if (stillOpen && cleared) {
        await ref.set({ clearedAtMs: null, clearedByUid: '', clearedByName: '' }, { merge: true });
        out.reopened++;
      }
    }
  } catch (e) {
    log.warn('[awayHandBack] settle failed', { err: e && e.message });
  }
  return out;
}

module.exports = { settleHandBackTimeline };
