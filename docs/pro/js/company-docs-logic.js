/**
 * company-docs-logic.js — the company's OWN documents that expire
 * (2026-10-18): general-liability COI, workers' comp / exemption, trade
 * licenses and local registrations, manufacturer certifications, vehicle
 * registration + insurance. (production-logic.js certStatus covers the
 * SUBCONTRACTORS' certificates; this is the company's side of the same job.)
 *
 * Pure: no DOM, no Firestore, no clock. Every function takes "today" as a
 * YYYY-MM-DD string, so the result never depends on the machine's time zone
 * or on a midnight/DST edge. Day counts are whole calendar days between two
 * calendar dates (both read as UTC midnights, which have no DST).
 *
 * Mirrored byte-for-byte in behaviour by functions/company-doc-expiry-logic.js
 * (the server alert); tests/company-docs-2026-10-18.test.js runs both over the
 * same date sweep.
 *
 * Browser: window.NBDCompanyDocsLogic. Node: module.exports.
 */
(function (root) {
  'use strict';

  var TYPES = [
    { key: 'gl_coi', label: 'General liability insurance (COI)' },
    { key: 'workers_comp', label: "Workers' comp / exemption" },
    { key: 'license', label: 'Contractor / trade license or local registration' },
    { key: 'manufacturer_cert', label: 'Manufacturer certification' },
    { key: 'vehicle', label: 'Vehicle registration or insurance' },
    { key: 'other', label: 'Other' },
  ];
  var TYPE_KEYS = TYPES.map(function (t) { return t.key; });
  var MAX = { name: 80, issuer: 80, notes: 1000, fileRef: 300 };
  var YMD = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

  function str(v) { return v == null ? '' : String(v).trim(); }

  /** 'YYYY-MM-DD' -> { y, m, d, day } (day = whole days since 1970-01-01) or null for anything that is not a real date. */
  function parseYmd(s) {
    var v = str(s);
    if (!YMD.test(v)) return null;
    var y = Number(v.slice(0, 4)), m = Number(v.slice(5, 7)), d = Number(v.slice(8, 10));
    var t = Date.UTC(y, m - 1, d);
    var chk = new Date(t);
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== m - 1 || chk.getUTCDate() !== d) return null;
    return { y: y, m: m, d: d, day: Math.round(t / 86400000) };
  }

  /** The caller's LOCAL calendar date as YYYY-MM-DD (never toISOString: that is UTC and flips the date at 8 pm Eastern). */
  function localYmd(date) {
    var x = date || new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
  }

  function shortDate(ymd) {
    var p = parseYmd(ymd);
    if (!p) return '';
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][p.m - 1] + ' ' + p.d + ', ' + p.y;
  }

  /**
   * One document's state on `todayYmd`.
   *   none     no (or an unreadable) expiry date
   *   ok       more than 30 days left
   *   due30    15..30 days left   due14   8..14 left   due7   0..7 left (0 = expires today)
   *   expired  past the date
   * rank: 0 none/ok, 1 due30, 2 due14, 3 due7, 4 expired -- larger is worse.
   */
  function statusOf(expiryYmd, todayYmd) {
    var e = parseYmd(expiryYmd), t = parseYmd(todayYmd);
    if (!e || !t) return { state: 'none', days: null, rank: 0, label: 'No expiry date on file' };
    var days = e.day - t.day;
    if (days < 0) return { state: 'expired', days: days, rank: 4, label: 'Expired ' + shortDate(expiryYmd) };
    if (days === 0) return { state: 'due7', days: 0, rank: 3, label: 'Expires today' };
    var word = days === 1 ? 'in 1 day' : 'in ' + days + ' days';
    if (days <= 7) return { state: 'due7', days: days, rank: 3, label: 'Expires ' + word + ' (' + shortDate(expiryYmd) + ')' };
    if (days <= 14) return { state: 'due14', days: days, rank: 2, label: 'Expires ' + word + ' (' + shortDate(expiryYmd) + ')' };
    if (days <= 30) return { state: 'due30', days: days, rank: 1, label: 'Expires ' + word + ' (' + shortDate(expiryYmd) + ')' };
    return { state: 'ok', days: days, rank: 0, label: 'Good through ' + shortDate(expiryYmd) };
  }

  function typeLabel(key) {
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i].key === key) return TYPES[i].label;
    return 'Other';
  }

  /**
   * Validate + normalise a form submission into the stored shape (the same
   * limits firestore.rules enforces). { ok, doc } or { ok:false, message }.
   * fileRef is a PRIVATE pointer (a Drive file name or a note about where the
   * paper copy lives), never a link: a URL is refused so a Storage ?token=
   * link can never be saved here.
   */
  function clean(input) {
    var i = input || {};
    var type = TYPE_KEYS.indexOf(str(i.type)) >= 0 ? str(i.type) : '';
    var name = str(i.name), issuer = str(i.issuer), notes = str(i.notes), fileRef = str(i.fileRef);
    var expiry = str(i.expiry);
    if (!type) return { ok: false, message: 'Pick what kind of document it is.' };
    if (!name) return { ok: false, message: 'Give it a name.' };
    if (name.length > MAX.name) return { ok: false, message: 'Name is too long (max ' + MAX.name + ').' };
    if (issuer.length > MAX.issuer) return { ok: false, message: 'Issuer is too long (max ' + MAX.issuer + ').' };
    if (notes.length > MAX.notes) return { ok: false, message: 'Notes are too long (max ' + MAX.notes + ').' };
    if (expiry && !parseYmd(expiry)) return { ok: false, message: 'Expiry must be a real date.' };
    if (fileRef.length > MAX.fileRef) return { ok: false, message: 'File reference is too long (max ' + MAX.fileRef + ').' };
    if (/https?:\/\/|[?&]token=|firebasestorage|storage\.googleapis/i.test(fileRef)) {
      return { ok: false, message: 'Do not paste a link here. Write where the file lives (for example, "Drive > Company > Insurance > COI 2026.pdf").' };
    }
    return { ok: true, doc: { type: type, name: name, issuer: issuer, expiry: expiry, notes: notes, fileRef: fileRef, active: i.active !== false } };
  }

  /**
   * The Home/Settings roll-up. docs: stored rows (active:false ones are
   * history and never warn). -> { rows (worst first, then soonest), attention
   * (rank >= 1), worst (0..4), expired, soon, noDate }
   */
  function summarize(docs, todayYmd) {
    var rows = (docs || []).filter(function (d) { return d && d.active !== false; }).map(function (d) {
      return { id: d.id, type: d.type, name: str(d.name) || typeLabel(d.type), issuer: str(d.issuer), expiry: str(d.expiry), status: statusOf(d.expiry, todayYmd) };
    });
    rows.sort(function (a, b) {
      if (b.status.rank !== a.status.rank) return b.status.rank - a.status.rank;
      var ad = a.status.days == null ? 1e9 : a.status.days, bd = b.status.days == null ? 1e9 : b.status.days;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
    var attention = rows.filter(function (r) { return r.status.rank >= 1; });
    return {
      rows: rows,
      attention: attention,
      worst: attention.length ? attention[0].status.rank : 0,
      expired: rows.filter(function (r) { return r.status.state === 'expired'; }).length,
      soon: rows.filter(function (r) { return r.status.rank >= 1 && r.status.rank <= 3; }).length,
      noDate: rows.filter(function (r) { return r.status.state === 'none'; }).length,
    };
  }

  var api = { TYPES: TYPES, TYPE_KEYS: TYPE_KEYS, MAX: MAX, parseYmd: parseYmd, localYmd: localYmd, shortDate: shortDate, statusOf: statusOf, typeLabel: typeLabel, clean: clean, summarize: summarize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDCompanyDocsLogic = api;
})(typeof window !== 'undefined' ? window : null);
