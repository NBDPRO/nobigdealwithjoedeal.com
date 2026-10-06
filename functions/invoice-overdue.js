/**
 * invoice-overdue.js — a daily INTERNAL reminder for each invoice that went
 * overdue (2026-10-03). The rule is invoice-overdue-logic.js.
 *
 * 08:15 Eastern: every invoice still open (status sent / partial / overdue /
 * viewed — one 'in' query, no composite index) whose due date has passed
 * gets ONE task on its lead, "💸 Invoice overdue — follow up", created once
 * (the task id is the invoice's, so the next morning's run is a no-op).
 * NOTHING is sent to a customer — no email, no text, no Stripe call. The
 * rep follows up from the task (Money → Collections → Remind, a call, or
 * Send balance).
 *
 * Kill switch: NBD_INVOICE_OVERDUE=off.
 */
'use strict';

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const O = require('./invoice-overdue-logic');
const KyLaw = require('./ky-insurance-law');

/** One sweep. Exported for tests with a fake db. Never throws per invoice. */
async function runOverdueSweep(db, nowMs, deps) {
  const log = (deps && deps.logger) || logger;
  const FV = (deps && deps.FieldValue) || FieldValue;
  // R4-7 (2026-10-06): this was one `.limit(1000)` read, so open invoice
  // #1001+ never got its overdue task. Page through all of them; startAfter
  // a snapshot continues in document order (no orderBy, so no new index).
  const PAGE = (deps && deps.pageSize) || 1000;
  const raw = [];
  let cursor = null;
  for (;;) {
    let q = db.collection('invoices').where('status', 'in', O.OPEN_STATUSES).limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    const page = snap.docs || [];
    raw.push(...page);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1];
  }
  const docs = raw.map((d) => Object.assign({ id: d.id }, d.data() || {}));
  const leads = new Map();
  const tzByTenant = new Map();
  const out = { scanned: docs.length, created: 0, existing: 0, failed: 0, skipped: {} };
  for (const inv of docs) {
    try {
      let lead = null;
      if (inv.leadId) {
        const key = String(inv.leadId);
        if (!leads.has(key)) {
          const ls = await db.collection('leads').doc(key).get();
          leads.set(key, ls.exists ? (ls.data() || {}) : null);
        }
        lead = leads.get(key);
      }
      const tenant = String(inv.companyId || inv.createdBy || '');
      if (tenant && !tzByTenant.has(tenant)) {
        let tz = KyLaw.DEFAULT_TIME_ZONE;
        try {
          const cp = await db.doc('companyProfile/' + tenant).get();
          if (cp.exists) tz = KyLaw.resolveTimeZone(cp.data() || {});
        } catch (_) { /* default zone */ }
        tzByTenant.set(tenant, tz);
      }
      const d = O.decideOverdue(inv, lead, nowMs, tzByTenant.get(tenant));
      if (!d.due) { out.skipped[d.reason] = (out.skipped[d.reason] || 0) + 1; continue; }
      try {
        await db.collection('leads').doc(String(inv.leadId)).collection('tasks').doc(d.taskId)
          .create(Object.assign({}, d.task, { createdAt: FV.serverTimestamp(), createdBy: 'system: overdue invoice' }));
        out.created++;
      } catch (e) {
        if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) { out.existing++; continue; }
        throw e;
      }
    } catch (e) {
      out.failed++;
      log.error('[invoiceOverdue] invoice failed', { invoiceId: inv.id, err: e && e.message });
    }
  }
  return out;
}

exports.invoiceOverdueSweep = onSchedule(
  { schedule: '15 8 * * *', timeZone: 'America/New_York', maxInstances: 1, timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    if (process.env.NBD_INVOICE_OVERDUE === 'off') { logger.info('[invoiceOverdue] kill switch on'); return; }
    const out = await runOverdueSweep(getFirestore(), Date.now());
    logger.info('[invoiceOverdue] sweep', out);
  }
);

exports._internal = { runOverdueSweep };
