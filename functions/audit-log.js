/**
 * Audit log — invoices only. SUPERSEDED by audit-triggers.js (H-4).
 *
 * audit-triggers.js is the canonical audit_log writer for users, leads,
 * companies, companies/members, access_codes, and subscriptions — it
 * redacts PII, records a compact diff, and stamps `ts` (so
 * auditLogRetentionCron, which prunes by `ts`, can age entries out).
 *
 * This module used to ALSO write audit_log for users/companies/
 * access_codes/subscriptions, which DOUBLE-WROTE every row — and its
 * entries used `createdAt` (not `ts`), so they evaded retention and
 * accumulated forever with unredacted before/after PII.
 *
 * 2026-06-08 dedup: those four triggers became no-ops; 2026-11-15 they were
 * deleted outright (exports removed, then undeployed with functions:delete).
 * audit-triggers.js already covers their collections (more completely + redacted), so no
 * audit coverage is lost. The only live writer left here is auditInvoices,
 * because `invoices/*` is NOT covered by audit-triggers.js.
 */

'use strict';

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');

// ─── Invoices — the one sensitive collection audit-triggers.js omits ──
async function writeAudit(entry) {
  try {
    await getFirestore().collection('audit_log').add(entry);
  } catch (e) {
    logger.error('audit_log_write_failed', { err: e.message, path: entry.path });
  }
}

exports.auditInvoices = onDocumentWritten('invoices/{invoiceId}', async (event) => {
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  const after  = event.data?.after?.exists  ? event.data.after.data()  : null;
  // Only audit status and total changes — other edits (notes, line items
  // during drafting) would be too noisy.
  const b = before || {};
  const a = after || {};
  if (b.status === a.status && b.total === a.total) return;
  await writeAudit({
    kind: 'invoice.state_change',
    path: event.data.after.ref.path,
    docId: event.data.after.ref.id,
    // Store ONLY the non-PII state fields this trigger audits (status +
    // total) — never the full invoice doc, which carries homeowner
    // name/email/phone + line items and would accumulate plaintext PII in
    // the ~7-year audit_log. (DI-01, backend security audit 2026-06-24.)
    before: before ? { status: before.status ?? null, total: before.total ?? null } : null,
    after:  after  ? { status: after.status  ?? null, total: after.total  ?? null } : null,
    // `ts` (not just createdAt) so auditLogRetentionCron — which queries
    // on `ts` — can actually age these out instead of accumulating forever.
    ts: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  });
});
