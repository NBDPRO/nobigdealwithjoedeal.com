/**
 * invoice-overdue-logic.js — the PURE rule behind the overdue-invoice
 * reminder (2026-10-03; functions/invoice-overdue.js does the I/O).
 *
 * Jo's way, as with every money reminder: nothing goes to a homeowner. When
 * an invoice someone owes passes its due date, the lead gets ONE internal
 * task — "💸 Invoice overdue — follow up" — on the rep's task list. The rep
 * decides what to do (the Money view's one-tap Remind sheet, a call, Send
 * balance). One task per invoice, ever: the task id is the invoice's.
 *
 * Owed = #2112's owed rule (invoice-owed.js): not paid / draft / void /
 * cancelled / deleted — 'partial' IS owed. A Kentucky insurance invoice still
 * inside its KRS 367.626 window is skipped: no payment may be asked for yet,
 * so it is not "overdue" for collection.
 */
'use strict';

const { isOwedInvoice, owedDollarsOf } = require('./invoice-owed');
const KyLaw = require('./ky-insurance-law');

const OPEN_STATUSES = ['sent', 'partial', 'overdue', 'viewed'];

function _seg(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100); }
function _ms(v) {
  if (!v) return NaN;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}
function overdueTaskId(invoiceId) { return 'invoice-overdue-' + _seg(invoiceId); }

/**
 * Should this invoice get its overdue task now? Pure.
 *   inv: { id, ...doc }, lead: the lead doc | null, nowMs, tz?
 * → { due: true, taskId, task } | { due: false, reason }
 */
function decideOverdue(inv, lead, nowMs, tz) {
  if (!inv || !inv.id) return { due: false, reason: 'no_invoice' };
  if (!inv.leadId) return { due: false, reason: 'no_lead' };
  if (inv.e2eTestData) return { due: false, reason: 'test_data' };
  if (!isOwedInvoice(inv)) return { due: false, reason: 'not_owed' };
  const owed = owedDollarsOf(inv);
  if (!(owed > 0)) return { due: false, reason: 'nothing_owed' };
  const dueMs = _ms(inv.dueDate);
  if (!Number.isFinite(dueMs)) return { due: false, reason: 'no_due_date' };
  // Overdue the day AFTER the due date (Eastern calendar days).
  const today = KyLaw.toUtcDay(new Date(nowMs), tz || KyLaw.DEFAULT_TIME_ZONE);
  const dueDay = KyLaw.toUtcDay(new Date(dueMs), tz || KyLaw.DEFAULT_TIME_ZONE);
  if (!(today > dueDay)) return { due: false, reason: 'not_yet' };
  if (!lead) return { due: false, reason: 'lead_unreadable' };
  if (lead.deleted === true || lead.deletedAt) return { due: false, reason: 'lead_deleted' };
  if (KyLaw.payLinkHold(lead, inv, new Date(nowMs), tz).held) return { due: false, reason: 'ky_hold' };
  const days = Math.round((today - dueDay) / 86400000);
  const amt = '$' + owed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const who = String(inv.customerName || [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'the customer').slice(0, 80);
  return {
    due: true,
    taskId: overdueTaskId(inv.id),
    task: {
      text: '💸 Invoice overdue — follow up',
      title: 'Invoice overdue — follow up',
      notes: amt + ' is ' + days + ' day' + (days === 1 ? '' : 's') + ' past due from ' + who + ' (invoice ' + String(inv.id).slice(0, 12) + ').'
        + ' Internal reminder only — nothing was sent to the customer. Remind them from Money → Collections, or tap Send balance.',
      source: 'invoice_overdue',
      invoiceId: String(inv.id),
      actionId: 'invoice_overdue',
      actionKind: 'action',
      dueDate: KyLaw.isoDay ? KyLaw.isoDay(today) : new Date(nowMs).toISOString().slice(0, 10),
      done: false,
      internalOnly: true,
    },
  };
}

module.exports = { OPEN_STATUSES, overdueTaskId, decideOverdue };
