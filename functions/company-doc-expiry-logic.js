'use strict';
/**
 * company-doc-expiry-logic.js — the rules behind companyDocExpiryWatch
 * (2026-10-18): which of a company's OWN documents (companies/{id}/companyDocs)
 * are close to expiring, and the one Agent-inbox report each stage files.
 *
 * Pure: no Firestore, no clock, no env. The status function mirrors
 * docs/pro/js/company-docs-logic.js (the browser copy the Settings card and the
 * Home strip use); tests/company-docs-2026-10-18.test.js runs both over the
 * same date sweep so they cannot drift.
 *
 * NOTHING here is addressed to a customer. The only output is an Agent-inbox
 * `report` item (kind 'report', no lead) for the owner.
 */

const YMD = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DEFAULT_TZ = 'America/New_York';

const TYPE_LABELS = {
  gl_coi: 'General liability insurance (COI)',
  workers_comp: "Workers' comp / exemption",
  license: 'Contractor / trade license or local registration',
  manufacturer_cert: 'Manufacturer certification',
  vehicle: 'Vehicle registration or insurance',
  other: 'Other',
};

const str = (v) => (v == null ? '' : String(v).trim());

function parseYmd(s) {
  const v = str(s);
  if (!YMD.test(v)) return null;
  const y = Number(v.slice(0, 4)), m = Number(v.slice(5, 7)), d = Number(v.slice(8, 10));
  const t = Date.UTC(y, m - 1, d);
  const chk = new Date(t);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== m - 1 || chk.getUTCDate() !== d) return null;
  return { y, m, d, day: Math.round(t / 86400000) };
}

/** The calendar date at `ms` in the IANA zone `tz` (a bad zone falls back to Eastern). */
function ymdInZone(ms, tz) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  } catch (_) {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  }
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(ymd) {
  const p = parseYmd(ymd);
  return p ? MONTHS[p.m - 1] + ' ' + p.d + ', ' + p.y : '';
}

/** none | ok | due30 (15-30 days) | due14 (8-14) | due7 (0-7) | expired. Same thresholds as the browser copy. */
function statusOf(expiryYmd, todayYmd) {
  const e = parseYmd(expiryYmd), t = parseYmd(todayYmd);
  if (!e || !t) return { state: 'none', days: null, rank: 0 };
  const days = e.day - t.day;
  if (days < 0) return { state: 'expired', days, rank: 4 };
  if (days <= 7) return { state: 'due7', days, rank: 3 };
  if (days <= 14) return { state: 'due14', days, rank: 2 };
  if (days <= 30) return { state: 'due30', days, rank: 1 };
  return { state: 'ok', days, rank: 0 };
}

/** Doc ids come from Firestore auto-ids or the client; keep only id-safe characters. */
const safe = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);

/**
 * The Agent-inbox report for ONE document at its CURRENT stage, or null when it
 * needs none (ok / no date / inactive).
 *
 * De-duplication: the item id is deterministic (company, doc, expiry date,
 * stage) and the writer uses create(), so a daily sweep files each stage once.
 * A sweep that missed days (an outage) files only the stage the doc is in NOW,
 * never the stages it already passed. Renewing the document moves its expiry
 * date, which starts a fresh set of ids.
 */
function alertFor(companyId, doc, todayYmd) {
  if (!doc || doc.active === false) return null;
  const st = statusOf(doc.expiry, todayYmd);
  if (st.rank === 0) return null;
  const name = str(doc.name) || TYPE_LABELS[doc.type] || 'Company document';
  const kind = TYPE_LABELS[doc.type] || TYPE_LABELS.other;
  const date = shortDate(doc.expiry);
  let title, lead;
  if (st.state === 'expired') {
    const n = -st.days;
    title = name + ' expired ' + (n === 1 ? 'yesterday' : n + ' days ago');
    lead = 'This document expired on ' + date + '.';
  } else if (st.days === 0) {
    title = name + ' expires today';
    lead = 'This document expires today (' + date + ').';
  } else {
    title = name + ' expires in ' + st.days + (st.days === 1 ? ' day' : ' days');
    lead = 'This document expires on ' + date + ' (' + st.days + (st.days === 1 ? ' day' : ' days') + ' from today).';
  }
  const text = lead + ' Type: ' + kind + (str(doc.issuer) ? '. Issuer: ' + str(doc.issuer) : '') +
    '. Renew it and update the expiry date in Settings > Company Profile > Company documents; the reminders stop on their own.';
  return {
    id: 'docexp_' + safe(companyId) + '_' + safe(doc.id) + '_' + str(doc.expiry) + '_' + st.state,
    stage: st.state,
    item: { kind: 'report', leadId: null, title: title.slice(0, 140), text, dueDate: null },
  };
}

/** Every alert due for a company's documents today. */
function planAlerts(companyId, docs, todayYmd) {
  const out = [];
  for (const d of docs || []) {
    const a = alertFor(companyId, d, todayYmd);
    if (a) out.push(a);
  }
  return out;
}

module.exports = { DEFAULT_TZ, TYPE_LABELS, parseYmd, ymdInZone, statusOf, alertFor, planAlerts, shortDate };
