/**
 * sub-paperwork-logic.js — the pure rules for the Sub paperwork tracker
 * (flag `subPaperwork`, 2026-10-19).
 *
 * For every independent subcontractor on companies/{id}/subs: is the W-9 on
 * file, are the liability / workers' comp papers current, and (in January) how
 * much was paid to each one in the calendar year.
 *
 * Pure: no DOM, no Firestore, no clock (the caller passes "today"), so it is unit
 * tested. Money is integer cents. Nothing here ever holds a Social Security or
 * employer ID number: the W-9 itself is a private file, and the form refuses
 * text that looks like a tax ID. Crews are independent subcontractors: nothing
 * here says employee, payroll or in-house.
 *
 * Exposed as window.NBDSubPaperworkLogic and module.exports.
 */
(function (root) {
  'use strict';

  var YMD = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
  var DAY_MS = 86400000;
  var W9_STATES = ['none', 'requested', 'on_file'];
  var KINDS = [
    { key: 'w9', label: 'W-9' },
    { key: 'gl_coi', label: 'Liability certificate' },
    { key: 'wc_coi', label: "Workers' comp certificate" },
    { key: 'license', label: 'License / registration' },
    { key: 'other', label: 'Other paper' }
  ];
  var KIND_KEYS = KINDS.map(function (k) { return k.key; });
  var METHODS = [
    { key: 'cash', label: 'Cash' },
    { key: 'zelle', label: 'Zelle' },
    { key: 'check', label: 'Check' },
    { key: 'other', label: 'Other' }
  ];
  var CATEGORY = 'subcontractor';
  // The words the screen and the CSV carry. No threshold is ever stated as fact.
  var CPA_NOTE = 'Confirm thresholds, who needs a 1099, and filing deadlines with your CPA.';
  var COVERAGE_NOTE = 'Totals count only payments logged in the CRM. Cash paid out and never logged is not here, so a total can be too low.';
  // Fields on the sub doc this feature owns (the rules bound every one of them).
  var FIELDS = ['legalName', 'entityType', 'w9Status', 'w9ReceivedOn', 'glExpiry', 'wcExpiry', 'wcExempt', 'wcExemptNote',
    'licenseRequired', 'licenseNote', 'licenseExpiry', 'paperworkNote', 'paperworkReviewedAt'];
  // A Storage path for a sub's paper: private, per company and per sub.
  var PAPER_PATH_RE = /^sub-papers\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9._-]{1,160}$/;

  function str(v) { return v == null ? '' : String(v).trim(); }
  function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : 0; }

  // ── dates ─────────────────────────────────────────────────────────────
  function parseYmd(s) {
    var v = str(s);
    if (!YMD.test(v)) return null;
    var y = +v.slice(0, 4), m = +v.slice(5, 7), d = +v.slice(8, 10);
    var t = Date.UTC(y, m - 1, d), c = new Date(t);
    if (c.getUTCFullYear() !== y || c.getUTCMonth() !== m - 1 || c.getUTCDate() !== d) return null;
    return { y: y, m: m, d: d, day: Math.round(t / DAY_MS) };
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(ymd) { var p = parseYmd(ymd); return p ? MONTHS[p.m - 1] + ' ' + p.d + ', ' + p.y : ''; }
  /** Local calendar date of a Date. */
  function localYmd(d) {
    var x = d || new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }

  /**
   * none | ok | due30 | due14 | due7 | expired. The SAME bands as the company-document
   * watcher (functions/company-doc-expiry-logic.js statusOf); tests run both.
   */
  function statusOf(expiryYmd, todayYmd) {
    var e = parseYmd(expiryYmd), t = parseYmd(todayYmd);
    if (!e || !t) return { state: 'none', days: null, rank: 0 };
    var days = e.day - t.day;
    if (days < 0) return { state: 'expired', days: days, rank: 4 };
    if (days <= 7) return { state: 'due7', days: days, rank: 3 };
    if (days <= 14) return { state: 'due14', days: days, rank: 2 };
    if (days <= 30) return { state: 'due30', days: days, rank: 1 };
    return { state: 'ok', days: days, rank: 0 };
  }

  // ── the chips on a sub's card ─────────────────────────────────────────
  // state: ok | soon | expired | missing | na
  function dateChip(label, expiry, today, missingText) {
    var s = str(expiry);
    if (!parseYmd(s)) return { label: label, state: 'missing', text: missingText || 'Not on file', rank: 5 };
    var st = statusOf(s, today);
    if (st.state === 'expired') return { label: label, state: 'expired', text: 'Expired ' + shortDate(s), rank: 4 };
    if (st.rank > 0) return { label: label, state: 'soon', text: 'Ends ' + shortDate(s), rank: 3 };
    return { label: label, state: 'ok', text: 'Through ' + shortDate(s), rank: 0 };
  }
  /** The General liability expiry. `insuranceExpiry` is the older field for the same thing. */
  function glExpiryOf(sub) { return str(sub && sub.glExpiry) || str(sub && sub.insuranceExpiry); }
  function w9Chip(sub) {
    var s = str(sub && sub.w9Status);
    if (s === 'on_file') {
      var on = parseYmd(sub.w9ReceivedOn);
      return { label: 'W-9', state: 'ok', text: on ? 'On file ' + shortDate(sub.w9ReceivedOn) : 'On file', rank: 0 };
    }
    if (s === 'requested') return { label: 'W-9', state: 'soon', text: 'Requested, not back yet', rank: 3 };
    return { label: 'W-9', state: 'missing', text: 'Missing', rank: 5 };
  }
  function chipsFor(sub, today) {
    var out = [w9Chip(sub), dateChip('Liability', glExpiryOf(sub), today)];
    if (sub && sub.wcExempt === true) out.push({ label: "Workers' comp", state: 'ok', text: 'Exempt (see note)', rank: 0 });
    else out.push(dateChip("Workers' comp", sub && sub.wcExpiry, today));
    if (sub && sub.licenseRequired === true) out.push(dateChip('License', sub.licenseExpiry, today));
    return out;
  }
  /** The worst chip's state, for sorting and the count of subs that need attention. */
  function worstOf(chips) {
    var r = 0;
    (chips || []).forEach(function (c) { if (c.rank > r) r = c.rank; });
    return r;
  }
  function needsAttention(sub, today) { return worstOf(chipsFor(sub, today)) > 0; }

  // ── the form -> the sub doc fields ────────────────────────────────────
  // A tax ID typed into a note is refused: 123-45-6789, 12-3456789, or nine digits in a row.
  // (A 10-digit phone number is not caught: the nine digits must stand alone.) Same pattern as the rules.
  var TAXID_RE = /(^|[^0-9])([0-9]{3}-[0-9]{2}-[0-9]{4}|[0-9]{3} [0-9]{2} [0-9]{4}|[0-9]{3}[.][0-9]{2}[.][0-9]{4}|[0-9]{2}[ -][0-9]{7}|[0-9]{9})([^0-9]|$)/;
  function looksLikeTaxId(s) { return TAXID_RE.test(String(s == null ? '' : s)); }

  /** { ok, fields } or { ok:false, message }. Only the whitelisted keys leave here. */
  function cleanPaperwork(input) {
    var i = input || {}, f = {}, k;
    var texts = { legalName: 120, entityType: 40, wcExemptNote: 200, licenseNote: 200, paperworkNote: 500 };
    for (k in texts) {
      if (!Object.prototype.hasOwnProperty.call(texts, k)) continue;
      var v = str(i[k]).slice(0, texts[k]);
      if (looksLikeTaxId(v)) return { ok: false, message: 'Do not type a Social Security or tax ID number here. Keep the W-9 as a file instead.' };
      f[k] = v;
    }
    var w9 = str(i.w9Status) || 'none';
    if (W9_STATES.indexOf(w9) === -1) return { ok: false, message: 'Pick a W-9 status.' };
    f.w9Status = w9;
    var dates = { w9ReceivedOn: 'the date the W-9 came in', glExpiry: 'the liability certificate end date', wcExpiry: "the workers' comp end date",
      licenseExpiry: 'the license end date', paperworkReviewedAt: 'the reviewed date' };
    for (k in dates) {
      if (!Object.prototype.hasOwnProperty.call(dates, k)) continue;
      var d = str(i[k]);
      if (d && !parseYmd(d)) return { ok: false, message: 'Pick ' + dates[k] + ' again.' };
      f[k] = d || null;
    }
    if (w9 !== 'on_file') f.w9ReceivedOn = null;
    f.wcExempt = i.wcExempt === true;
    f.licenseRequired = i.licenseRequired === true;
    if (f.wcExempt && !f.wcExemptNote) return { ok: false, message: "Say why workers' comp does not apply (for example a letter on file)." };
    return { ok: true, fields: f };
  }

  // ── papers (private files) ────────────────────────────────────────────
  function paperPathOk(p) { return typeof p === 'string' && PAPER_PATH_RE.test(p) && p.indexOf('..') === -1; }
  function kindLabel(k) { for (var i = 0; i < KINDS.length; i++) if (KINDS[i].key === k) return KINDS[i].label; return 'Paper'; }

  // ── payments ──────────────────────────────────────────────────────────
  // The matching rules the Sub payments sorter already uses (name key, aliases, subId).
  // Read lazily so a load order that puts this file first still works at call time.
  var SP = null;
  function sorter() {
    if (SP) return SP;
    try {
      if (root && root.NBDSubPaymentsLogic) SP = root.NBDSubPaymentsLogic;
      else if (typeof require === 'function') SP = require('./sub-payments-logic.js');
    } catch (e) { SP = null; }
    return SP;
  }
  function payeeKey(name) {
    var s = sorter();
    if (s && typeof s.payeeKey === 'function') return s.payeeKey(name);
    return str(name).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  /** The calendar year of an expense date, by LOCAL parts (a 'YYYY-MM-DD' string by its own year). */
  function yearOf(v) {
    if (typeof v === 'string') { var m = /^(\d{4})-\d{2}-\d{2}/.exec(v); if (m) return +m[1]; }
    var ms = toMs(v);
    return ms == null ? null : new Date(ms).getFullYear();
  }
  function centsOf(e) { return int(e && e.amountCents) + int(e && e.taxCents); }
  function methodOf(e) {
    var m = str(e && e.paymentMethod).toLowerCase();
    for (var i = 0; i < METHODS.length; i++) if (METHODS[i].key === m) return m;
    return 'none';
  }
  function rosterKeys(r) {
    var ks = [payeeKey(r.name)];
    if (r.legalName) ks.push(payeeKey(r.legalName));
    (r.aliases || []).forEach(function (a) { var k = payeeKey(a); if (k && ks.indexOf(k) === -1) ks.push(k); });
    return ks.filter(Boolean);
  }
  function resolveSub(e, roster) {
    var list = roster || [], i;
    if (e && e.subId) for (i = 0; i < list.length; i++) if (list[i].id === e.subId) return list[i];
    var k = payeeKey(e && e.supplier);
    if (!k) return null;
    for (i = 0; i < list.length; i++) if (rosterKeys(list[i]).indexOf(k) !== -1) return list[i];
    return null;
  }
  function blankTotals() { return { cents: 0, count: 0, byMethod: { cash: 0, zelle: 0, check: 0, other: 0, none: 0 }, noMethod: 0, last: null }; }
  function addTo(t, e) {
    var c = centsOf(e), m = methodOf(e);
    t.cents += c; t.count += 1; t.byMethod[m] += c;
    if (m === 'none') t.noMethod += 1;
  }

  /**
   * One calendar year of what was paid to subs, from plain /expenses rows: category
   * 'subcontractor', not deleted, positive. Estimated rows (estimated:true) were never
   * paid, so they are listed apart and never added. Rows that match no roster sub (by
   * id, name or alias) go in `unassigned`, grouped by payee, so nothing is dropped.
   *   roster: [{ id, name, legalName?, aliases?, ... }]
   * -> { year, subs:[{ sub, totals }], unassigned:[{ name, totals }], estimated:{ cents, count, rows }, all:{ cents, count } }
   */
  function yearTotals(expenses, roster, year) {
    var subs = {}, un = {}, est = { cents: 0, count: 0 }, all = { cents: 0, count: 0 };
    var list = roster || [];
    list.forEach(function (r) { subs[r.id] = blankTotals(); });
    (expenses || []).forEach(function (e) {
      if (!e || e.deleted === true || e.category !== CATEGORY || centsOf(e) <= 0) return;
      if (yearOf(e.date) !== year) return;
      if (e.estimated === true) { est.cents += centsOf(e); est.count += 1; return; }
      all.cents += centsOf(e); all.count += 1;
      var r = resolveSub(e, list);
      if (r) { addTo(subs[r.id], e); return; }
      var key = payeeKey(e.supplier) || '(no name)';
      if (!un[key]) un[key] = { name: str(e.supplier) || '(no name)', totals: blankTotals() };
      addTo(un[key].totals, e);
    });
    return {
      year: year,
      subs: list.map(function (r) { return { sub: r, totals: subs[r.id] }; }),
      unassigned: Object.keys(un).map(function (k) { return un[k]; }).sort(function (a, b) { return b.totals.cents - a.totals.cents; }),
      estimated: est, all: all
    };
  }
  /** The recent live payments to one sub in a year, newest first (for the sheet). */
  function paymentsFor(expenses, roster, subId, year, max) {
    var list = roster || [], out = [];
    (expenses || []).forEach(function (e) {
      if (!e || e.deleted === true || e.category !== CATEGORY || centsOf(e) <= 0 || e.estimated === true) return;
      if (yearOf(e.date) !== year) return;
      var r = resolveSub(e, list);
      if (r && r.id === subId) out.push(e);
    });
    out.sort(function (a, b) { return (toMs(b.date) || 0) - (toMs(a.date) || 0); });
    return out.slice(0, max || 50);
  }

  // ── 1099 prep CSV ─────────────────────────────────────────────────────
  function dollars(cents) {
    var c = int(cents), neg = c < 0; c = Math.abs(c);
    return (neg ? '-' : '') + Math.floor(c / 100) + '.' + String(c % 100).padStart(2, '0');
  }
  function cell(v) {
    var s = v == null ? '' : String(v);
    // A spreadsheet runs a cell that starts with = + - @ as a formula: defuse it.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function w9Text(sub) {
    var s = str(sub && sub.w9Status);
    return s === 'on_file' ? 'On file' : s === 'requested' ? 'Requested' : 'No W-9 on file';
  }
  /**
   * Rows for the screen and the CSV. Flags: no W-9 on file, payee not matched to a roster
   * sub, payments with no method. A sub with no payments is listed only when `includeIdle`.
   */
  function prepRows(yt, opts) {
    var includeIdle = !!(opts && opts.includeIdle);
    var rows = [];
    yt.subs.forEach(function (x) {
      if (!includeIdle && x.totals.count === 0) return;
      var flags = [];
      if (str(x.sub.w9Status) !== 'on_file') flags.push('No W-9 on file');
      if (x.totals.noMethod) flags.push(x.totals.noMethod + (x.totals.noMethod === 1 ? ' payment' : ' payments') + ' with no method');
      rows.push({ kind: 'sub', name: str(x.sub.legalName) || str(x.sub.name), rosterName: str(x.sub.name), entityType: str(x.sub.entityType), w9: w9Text(x.sub), w9On: str(x.sub.w9ReceivedOn), totals: x.totals, flags: flags });
    });
    yt.unassigned.forEach(function (u) {
      var flags = ['Payee not matched to a roster sub'];
      if (u.totals.noMethod) flags.push(u.totals.noMethod + (u.totals.noMethod === 1 ? ' payment' : ' payments') + ' with no method');
      rows.push({ kind: 'unassigned', name: u.name, rosterName: '', entityType: '', w9: 'Unknown', w9On: '', totals: u.totals, flags: flags });
    });
    return rows;
  }
  var CSV_HEAD = ['Legal name', 'Name on the roster', 'Entity type', 'W-9', 'W-9 received', 'Total paid', 'Payments',
    'Cash', 'Zelle', 'Check', 'Other', 'No method logged', 'Flags'];
  function csv1099(yt, opts) {
    var rows = prepRows(yt, opts), lines = [];
    lines.push(['Calendar year ' + yt.year + ' payments to independent subcontractors'].map(cell).join(','));
    lines.push(CSV_HEAD.map(cell).join(','));
    var tot = 0, n = 0;
    function line(r) {
      var t = r.totals;
      return [r.name, r.rosterName, r.entityType, r.w9, r.w9On, dollars(t.cents), t.count, dollars(t.byMethod.cash), dollars(t.byMethod.zelle),
        dollars(t.byMethod.check), dollars(t.byMethod.other), dollars(t.byMethod.none), r.flags.join('; ')].map(cell).join(',');
    }
    rows.filter(function (r) { return r.kind === 'sub'; }).forEach(function (r) { lines.push(line(r)); tot += r.totals.cents; n += r.totals.count; });
    var un = rows.filter(function (r) { return r.kind === 'unassigned'; });
    if (un.length) {
      lines.push('');
      lines.push(cell('Unassigned: payees not matched to a roster sub'));
      un.forEach(function (r) { lines.push(line(r)); tot += r.totals.cents; n += r.totals.count; });
    }
    lines.push('');
    lines.push(['Total paid, all rows above', '', '', '', '', dollars(tot), n].map(cell).join(','));
    if (yt.estimated.count) lines.push(cell('Left out: ' + yt.estimated.count + ' estimated cost row(s) totalling ' + dollars(yt.estimated.cents) + ' that were never paid'));
    lines.push('');
    lines.push(cell(CPA_NOTE));
    lines.push(cell(COVERAGE_NOTE));
    lines.push(cell('This file holds no Social Security or tax ID numbers. Read those from the W-9 itself.'));
    return lines.join('\r\n') + '\r\n';
  }

  var API = {
    KINDS: KINDS, KIND_KEYS: KIND_KEYS, METHODS: METHODS, W9_STATES: W9_STATES, FIELDS: FIELDS, CATEGORY: CATEGORY,
    CPA_NOTE: CPA_NOTE, COVERAGE_NOTE: COVERAGE_NOTE, PAPER_PATH_RE: PAPER_PATH_RE,
    parseYmd: parseYmd, shortDate: shortDate, localYmd: localYmd, statusOf: statusOf,
    glExpiryOf: glExpiryOf, chipsFor: chipsFor, worstOf: worstOf, needsAttention: needsAttention,
    looksLikeTaxId: looksLikeTaxId, cleanPaperwork: cleanPaperwork, paperPathOk: paperPathOk, kindLabel: kindLabel,
    payeeKey: payeeKey, yearOf: yearOf, centsOf: centsOf, methodOf: methodOf, resolveSub: resolveSub,
    yearTotals: yearTotals, paymentsFor: paymentsFor, dollars: dollars, prepRows: prepRows, csv1099: csv1099
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NBDSubPaperworkLogic = API;
})(typeof window !== 'undefined' ? window : null);
