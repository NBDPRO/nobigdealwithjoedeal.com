'use strict';
/**
 * sub-paperwork-logic.js — the rules behind subPaperworkWatch (2026-10-19, flag
 * `subPaperwork` on the client; env switch SUB_PAPERWORK_WATCH_ENABLED here).
 *
 * Which of a company's independent subcontractors (companies/{id}/subs) have a
 * liability certificate, workers' comp certificate or license that ends soon,
 * and the one Agent-inbox report each stage files FOR THE OWNER.
 *
 * Pure: no Firestore, no clock, no env. The day bands are the company-document
 * watcher's (company-doc-expiry-logic.js statusOf), reused, so the two cannot drift.
 * NOTHING here is addressed to a sub or a customer: the report tells the owner
 * whose paper ends and that nothing was sent. Missing dates raise no alert (there
 * is no date to count from); the tracker screen shows "Missing" instead.
 */
const D = require('./company-doc-expiry-logic');

const str = (v) => (v == null ? '' : String(v).trim());
/** Doc ids come from Firestore auto-ids; keep only id-safe characters. */
const safe = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);

const KINDS = {
  gl: 'liability certificate',
  wc: "workers' comp certificate",
  license: 'license / registration',
};

/** The dated papers of one sub that can expire: [{ kind, expiry }]. */
function datedPapers(sub) {
  const out = [];
  const gl = str(sub && sub.glExpiry) || str(sub && sub.insuranceExpiry);
  if (gl) out.push({ kind: 'gl', expiry: gl });
  if (sub && sub.wcExempt !== true && str(sub.wcExpiry)) out.push({ kind: 'wc', expiry: str(sub.wcExpiry) });
  if (sub && sub.licenseRequired === true && str(sub.licenseExpiry)) out.push({ kind: 'license', expiry: str(sub.licenseExpiry) });
  return out;
}

/**
 * The Agent-inbox report for ONE paper at its CURRENT stage, or null (ok / no date /
 * inactive sub). Deterministic id (company, sub, kind, expiry date, stage) + create()
 * = each stage files once; renewing moves the expiry date and starts a fresh set.
 */
function alertFor(companyId, sub, paper, todayYmd) {
  if (!sub || sub.active === false) return null;
  const st = D.statusOf(paper.expiry, todayYmd);
  if (st.rank === 0) return null;
  const who = str(sub.name) || 'A sub';
  const what = KINDS[paper.kind] || 'paper';
  const date = D.shortDate(paper.expiry);
  let title, lead;
  if (st.state === 'expired') {
    const n = -st.days;
    title = who + ': ' + what + ' expired ' + (n === 1 ? 'yesterday' : n + ' days ago');
    lead = 'The ' + what + ' on file for ' + who + ' ended on ' + date + '.';
  } else if (st.days === 0) {
    title = who + ': ' + what + ' ends today';
    lead = 'The ' + what + ' on file for ' + who + ' ends today (' + date + ').';
  } else {
    title = who + ': ' + what + ' ends in ' + st.days + (st.days === 1 ? ' day' : ' days');
    lead = 'The ' + what + ' on file for ' + who + ' ends on ' + date + ' (' + st.days + (st.days === 1 ? ' day' : ' days') + ' from today).';
  }
  const text = lead + ' Ask them for a current one, then update the date in Expenses > Sub paperwork; these reminders stop on their own. Nothing was sent to the sub.';
  return {
    id: 'subdoc_' + safe(companyId) + '_' + safe(sub.id) + '_' + paper.kind + '_' + str(paper.expiry) + '_' + st.state,
    stage: st.state,
    item: { kind: 'report', leadId: null, title: title.slice(0, 140), text, dueDate: null },
  };
}

/** Every alert due for a company's subs today. */
function planAlerts(companyId, subs, todayYmd) {
  const out = [];
  for (const s of subs || []) {
    for (const p of datedPapers(s)) {
      const a = alertFor(companyId, s, p, todayYmd);
      if (a) out.push(a);
    }
  }
  return out;
}

module.exports = { KINDS, datedPapers, alertFor, planAlerts, DEFAULT_TZ: D.DEFAULT_TZ, ymdInZone: D.ymdInZone };
