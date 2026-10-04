/**
 * d2d-knock-lead-logic.js — what a door knock becomes in the CRM.
 *
 * Pure rules used by d2d-tracker-core-2026b.js convertToLead (2026-10-03,
 * stage-flow lane). Loaded ahead of the core in the script-loader 'd2d' bundle.
 *
 *  stageForDisposition — the CRM stage a converted knock lands on.
 *    "Appointment Set" used to land as INSPECTED — nobody had been on the
 *    roof yet; the appointment is the inspection. "Needs to file" used to land
 *    as CLAIM FILED — a false record that a claim exists, and on a Kentucky
 *    insurance job one that reads as if we filed/handled the claim, which the
 *    KY insurance-job rules forbid. Both land on CONTACTED: we
 *    talked to them at the door. A homeowner who already HAS a claim (or a
 *    denied one) still lands on Claim Filed — their claim exists.
 *
 *  localYmd — a Date as its LOCAL calendar day. toISOString().split('T')[0]
 *    is the UTC day: an auto follow-up computed after ~8pm Eastern landed a
 *    day late.
 *
 *  appointmentWhen — the knock's appointment time (datetime-local string,
 *    Date or Firestore Timestamp) as a Date, or null.
 *
 * window.NBDKnockLeadLogic + module.exports (tests).
 */
(function (root) {
  'use strict';

  const INS_DISPOSITIONS = ['ins_has_claim', 'ins_needs_file', 'ins_denied'];

  function stageForDisposition(dispo) {
    switch (dispo) {
      case 'appointment':    return 'contacted';
      case 'interested':     return 'contacted';
      case 'callback':       return 'contacted';
      case 'left_material':  return 'contacted';
      case 'storm_damage':   return 'contacted';
      case 'ins_needs_file': return 'contacted';
      case 'ins_has_claim':  return 'claim_filed';
      case 'ins_denied':     return 'claim_filed';
      default:               return 'new';
    }
  }

  const pad = (n) => String(n).padStart(2, '0');
  function localYmd(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function _toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v.toDate === 'function') { try { return _toDate(v.toDate()); } catch (_) { return null; } }
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? null : d;
  }

  /** The knock's stored follow-up as a local YYYY-MM-DD ('' when none). */
  function followUpYmd(v) {
    if (!v) return '';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    return localYmd(_toDate(v));
  }

  function appointmentWhen(v) { return _toDate(v); }

  const api = { INS_DISPOSITIONS, stageForDisposition, localYmd, followUpYmd, appointmentWhen };
  if (root) root.NBDKnockLeadLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
