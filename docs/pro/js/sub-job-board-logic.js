/**
 * sub-job-board-logic.js — the pure rules behind the Sub job board
 * (flag `subJobBoard`, 2026-11-19). No DOM, no Firestore, no clock (the caller
 * passes "today"), so it is unit tested. Money is integer cents.
 *
 * Two questions, one file:
 *   rowsFor(opts)  which committed / finished jobs have no sub, no agreed pay,
 *                  no payment logged, or were paid over the agreed amount
 *   metrics(opts)  per roster sub: jobs done, paid (total and by year), average
 *                  paid per SQ, days late, paid vs agreed
 *
 * Inputs (opts): { leads[], subJobs (map or array keyed by lead id), payments[]
 * (the /expenses rows), roster[], today 'YYYY-MM-DD' }.
 *   - subJobs is companies/{id}/subJobs/{leadId}: the agreed pay, the sub, and the
 *     "no sub needed" toggle. That doc's subId wins over the lead's own subId.
 *   - "Paid" is the sum of live sub payments logged to the job, read through
 *     sub-payments-logic (credits subtract, a voided / deleted row never counts).
 *     Cash paid and never logged is not here, so paid can be too low.
 *   - Every flag is a WARNING. Nothing here blocks a job, a schedule or a close.
 *   - Agreed pay is cost data: this file never builds customer-facing text.
 *   - Crews are independent subcontractors: nothing here says employee or payroll.
 *
 * Exposed as window.NBDSubJobBoardLogic and module.exports.
 */
(function (root) {
  'use strict';

  var CONFIG = {
    graceDays: 1      // finished on or before the last scheduled day + this many days is on time
  };
  // Committed work (schedule-planner-logic READY) and finished work (its DONE, minus lost).
  var COMMITTED = ['contract_signed', 'job_created', 'permit_pulled', 'materials_ordered',
    'materials_delivered', 'crew_scheduled', 'install_in_progress',
    'warranty_claim', 'warranty_scheduled', 'service_approved'];
  var FINISHED = ['install_complete', 'final_photos', 'deductible_collected',
    'final_payment', 'collections', 'closed', 'warranty_repaired'];
  var BUCKETS = [
    { key: 'noSub', label: 'No sub on the job' },
    { key: 'noAgreed', label: 'Sub on, no agreed pay' },
    { key: 'noPayment', label: 'Finished, no payment logged' },
    { key: 'overpaid', label: 'Paid more than agreed' }
  ];

  function SP() { return (root && root.NBDSubPaymentsLogic) || (typeof require === 'function' ? require('./sub-payments-logic.js') : null); }
  function str(v) { return String(v == null ? '' : v).trim(); }
  function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : 0; }
  function stageOf(l) { return str(l && (l._stageKey || l.stage)).toLowerCase(); }
  function nameOf(l) {
    return str([l.firstName, l.lastName].filter(Boolean).join(' ')) || str(l.name) || str(l.customerName) || str(l.address).split(',')[0] || 'Untitled';
  }
  function mapOf(subJobs) {
    var out = {};
    if (Array.isArray(subJobs)) subJobs.forEach(function (s) { if (s && s.id) out[s.id] = s; });
    else if (subJobs && typeof subJobs === 'object') Object.keys(subJobs).forEach(function (k) { out[k] = subJobs[k]; });
    return out;
  }
  function subIdOf(lead, sj) { return str(sj && sj.subId) || str(lead && lead.subId); }
  function agreedOf(sj) { var a = int(sj && sj.agreedCents); return a > 0 ? a : 0; }
  // The jobs the board looks at: not deleted, not lost, committed or finished. -> 'committed' | 'finished' | ''
  function phaseOf(l) {
    if (!l || l.deleted === true || !l.id) return '';
    var s = stageOf(l);
    return COMMITTED.indexOf(s) !== -1 ? 'committed' : FINISHED.indexOf(s) !== -1 ? 'finished' : '';
  }
  // Money paid per job, summed across every sub that was paid on it.
  function paidByLead(payments, roster) {
    var out = {};
    SP().perSub(payments, roster).forEach(function (g) {
      Object.keys(g.byJob).forEach(function (id) { out[id] = (out[id] || 0) + g.byJob[id].cents; });
    });
    return out;
  }

  /**
   * -> { rows: [{ leadId, name, stage, phase, subId, subName, agreedCents, paidCents,
   *               flags[], legacyCrew }], counts: { noSub, noAgreed, noPayment, overpaid },
   *        considered, skipped }
   * Only jobs with at least one flag are rows. `skipped` counts jobs marked "no sub needed".
   * `legacyCrew` is an old free-text crew name on a job with no roster sub (listed, never auto-linked).
   */
  function rowsFor(opts) {
    var o = opts || {};
    var sjs = mapOf(o.subJobs), roster = o.roster || [];
    var paid = paidByLead(o.payments || [], roster);
    var rows = [], considered = 0, skipped = 0;
    var counts = { noSub: 0, noAgreed: 0, noPayment: 0, overpaid: 0 };
    (o.leads || []).forEach(function (l) {
      var phase = phaseOf(l);
      if (!phase) return;
      var sj = sjs[l.id] || null;
      if (sj && sj.noSubNeeded === true) { skipped++; return; }
      considered++;
      var subId = subIdOf(l, sj);
      var sub = null;
      roster.forEach(function (r) { if (r.id === subId) sub = r; });
      var agreed = agreedOf(sj), p = paid[l.id] || 0, flags = [];
      if (!subId) flags.push('noSub');
      else if (!agreed) flags.push('noAgreed');
      if (phase === 'finished' && subId && p <= 0) flags.push('noPayment');
      if (agreed && p > agreed) flags.push('overpaid');
      if (!flags.length) return;
      flags.forEach(function (f) { counts[f]++; });
      rows.push({
        leadId: l.id, name: nameOf(l), stage: stageOf(l), phase: phase, subId: subId || null,
        subName: sub ? sub.name : '', agreedCents: agreed, paidCents: p, flags: flags,
        legacyCrew: !subId ? str(l.crew) : ''
      });
    });
    return { rows: rows, counts: counts, considered: considered, skipped: skipped };
  }

  /**
   * Per roster sub: { subId, name, trade, jobs, totalPaidCents, paidByYear{}, sqJobs,
   * avgPaidPerSqCents|null, measured, lateJobs, lateDays, agreedCents,
   * paidOnAgreedCents, varianceCents|null }.
   *   jobs        finished jobs the sub was on
   *   avg per SQ  paid / quantity, only on jobs whose agreed basis is SQ with a quantity
   *   late        finished day vs the LAST scheduled day + graceDays; a job with no
   *               schedule or no finish date is not measured (never counted as late)
   *   variance    paid minus agreed, over jobs that have an agreed amount
   */
  function metrics(opts) {
    var o = opts || {};
    var sp = SP(), sjs = mapOf(o.subJobs), roster = o.roster || [];
    var paid = paidByLead(o.payments || [], roster);
    var groups = {};
    sp.perSub(o.payments || [], roster).forEach(function (g) { if (g.subId) groups[g.subId] = g; });
    var by = {};
    roster.forEach(function (r) {
      by[r.id] = { subId: r.id, name: r.name, trade: r.trade || '', jobs: 0, totalPaidCents: 0, paidByYear: {},
        sqJobs: 0, avgPaidPerSqCents: null, measured: 0, lateJobs: 0, lateDays: 0,
        agreedCents: 0, paidOnAgreedCents: 0, varianceCents: null, _sqPaid: 0, _sqQty: 0 };
      var g = groups[r.id];
      if (g) {
        by[r.id].totalPaidCents = g.totalCents;
        g.byMonth.forEach(function (m) { var y = m.key.slice(0, 4); if (/^\d{4}$/.test(y)) by[r.id].paidByYear[y] = (by[r.id].paidByYear[y] || 0) + m.cents; });
      }
    });
    (o.leads || []).forEach(function (l) {
      if (phaseOf(l) !== 'finished') return;
      var sj = sjs[l.id] || null;
      if (sj && sj.noSubNeeded === true) return;
      var m = by[subIdOf(l, sj)];
      if (!m) return;
      m.jobs++;
      var p = paid[l.id] || 0, agreed = agreedOf(sj);
      if (sj && sj.basis === 'sq' && Number(sj.qty) > 0 && p > 0) { m.sqJobs++; m._sqPaid += p; m._sqQty += Number(sj.qty); }
      if (agreed) { m.agreedCents += agreed; m.paidOnAgreedCents += p; }
      var last = str(l.scheduledEndDate) > str(l.scheduledDate) ? l.scheduledEndDate : l.scheduledDate;
      var a = sp.dayNum(last), b = sp.dayNum(l.installCompletedAt);
      if (a != null && b != null) {
        m.measured++;
        var late = b - a - CONFIG.graceDays;
        if (late > 0) { m.lateJobs++; m.lateDays += late; }
      }
    });
    return Object.keys(by).map(function (k) {
      var m = by[k];
      if (m._sqQty > 0) m.avgPaidPerSqCents = Math.round(m._sqPaid / m._sqQty);
      if (m.agreedCents > 0) m.varianceCents = m.paidOnAgreedCents - m.agreedCents;
      delete m._sqPaid; delete m._sqQty;
      return m;
    }).sort(function (a, b) { return (b.totalPaidCents - a.totalPaidCents) || a.name.localeCompare(b.name); });
  }

  var API = { CONFIG: CONFIG, COMMITTED: COMMITTED, FINISHED: FINISHED, BUCKETS: BUCKETS, rowsFor: rowsFor, metrics: metrics };
  if (root && typeof root === 'object') root.NBDSubJobBoardLogic = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : null);
