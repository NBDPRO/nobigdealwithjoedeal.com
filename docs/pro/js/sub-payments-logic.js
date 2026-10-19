/**
 * sub-payments-logic.js — the pure matching rules for the Sub payments sorter
 * (flag `subPaymentsSorter`, 2026-10-19).
 *
 * Two flags, same idea as the receipt sorter:
 *   A. this JOB has no sub / labor cost attached   (the job cost auditor's queue)
 *   B. this PAYMENT has no job                      (an /expenses row, category
 *      'subcontractor', costType 'direct', no leadId / jobId, not answered
 *      "Not a job cost")
 *
 * Everything here is pure (no DOM, no Firestore) so the matching is unit-tested.
 * Money is integer cents. Crews are independent subcontractors: nothing here
 * says employee, payroll or in-house.
 *
 * Exposed as window.NBDSubPaymentsLogic and module.exports.
 */
(function (root) {
  'use strict';

  var CONFIG = {
    windowGraceDays: 3,   // a payment this close to a job's work window still points at it
    nearDays: 14,         // beyond this many days from the job's start, date says nothing
    maxSuggestions: 5,
    maxProofs: 6,         // photos per payment (rules bound the stored list at 10)
    maxLog: 25            // the rules' editLog bound
  };
  var METHODS = [
    { key: 'cash', label: 'Cash' },
    { key: 'check', label: 'Check' },
    { key: 'zelle', label: 'Zelle' },
    { key: 'other', label: 'Other' }
  ];
  var METHOD_KEYS = METHODS.map(function (m) { return m.key; });
  var SOURCE = 'sub_payments';
  var CATEGORY = 'subcontractor';
  var MAX_CENTS = 99999999;
  var DAY_MS = 86400000;
  var SUFFIX = { llc: 1, inc: 1, co: 1, corp: 1, company: 1, ltd: 1 };
  // Proofs live next to receipts (same rules, same owner-only read).
  var PROOF_RE = /^receipts\/[A-Za-z0-9_-]{1,128}\/sub-proofs\/[A-Za-z0-9._-]{1,160}$/;

  function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : 0; }
  function centsOf(e) { return int(e && e.amountCents) + int(e && e.taxCents); }
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
  // A calendar-day number from a Date's LOCAL parts, or from 'YYYY-MM-DD'
  // (never new Date('YYYY-MM-DD'): that is UTC midnight, the wrong day in Ohio).
  function dayNum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'string') {
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
      if (m) return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS);
    }
    var ms = toMs(v);
    if (ms == null) return null;
    var d = new Date(ms);
    return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
  }

  // ── names ─────────────────────────────────────────────────────────────
  /**
   * The key two spellings of one payee share. Lowercase; anything in brackets
   * dropped ("CA Roofing (Alex)" -> "ca roofing"); dots removed ("C.A." -> "ca");
   * punctuation to spaces; "and" for "&"; trailing LLC / Inc / Co dropped.
   */
  function payeeKey(name) {
    var s = String(name == null ? '' : name).toLowerCase();
    s = s.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/&/g, ' and ').replace(/\./g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    var t = s ? s.split(' ') : [];
    while (t.length > 1 && SUFFIX[t[t.length - 1]]) t.pop();
    return t.join(' ');
  }
  // One name's tokens are inside the other's: "ca roofing" / "ca roofing alex".
  // A single-token name only counts when it is the other's FIRST token (4+ letters),
  // so "roofing" never matches "abc roofing".
  function similarKeys(a, b) {
    if (!a || !b || a === b) return false;
    var ta = a.split(' '), tb = b.split(' ');
    var s = ta.length <= tb.length ? ta : tb, l = ta.length <= tb.length ? tb : ta;
    if (s.length === l.length) return false;
    if (s.length === 1) return s[0].length >= 4 && l[0] === s[0];
    return s.every(function (t) { return l.indexOf(t) !== -1; });
  }

  // ── which rows are in play ────────────────────────────────────────────
  function isLive(e) { return !!e && e.deleted !== true && centsOf(e) > 0; }
  /** A sub / crew payment: category subcontractor, live (any cost type). */
  function isSubPayment(e) { return isLive(e) && e.category === CATEGORY; }
  /** Flag B: a direct sub payment with no job, not answered "Not a job cost". */
  function needsJob(e) {
    return isSubPayment(e) && e.costType === 'direct' && !e.leadId && !e.jobId && e.notJobCost !== true;
  }
  function proofCount(e) {
    var n = Array.isArray(e && e.proofPaths) ? e.proofPaths.filter(function (p) { return typeof p === 'string' && p; }).length : 0;
    return n + (e && e.receiptStoragePath ? 1 : 0);
  }
  function hasProof(e) { return proofCount(e) > 0; }
  function proofPathOk(p) { return typeof p === 'string' && PROOF_RE.test(p) && p.indexOf('..') === -1; }
  function paymentsOf(list) { return (list || []).filter(isSubPayment); }

  // ── roster resolution ─────────────────────────────────────────────────
  // roster: [{ id, name, trade, aliases:[names] }]
  function rosterKeys(r) {
    var ks = [payeeKey(r.name)];
    (r.aliases || []).forEach(function (a) { var k = payeeKey(a); if (k && ks.indexOf(k) === -1) ks.push(k); });
    return ks.filter(Boolean);
  }
  /** The roster sub a row or typed name belongs to (id first, then exact key / alias), else null. */
  function resolveSub(name, subId, roster) {
    var list = roster || [];
    var i;
    if (subId) for (i = 0; i < list.length; i++) if (list[i].id === subId) return list[i];
    var k = payeeKey(name);
    if (!k) return null;
    for (i = 0; i < list.length; i++) if (rosterKeys(list[i]).indexOf(k) !== -1) return list[i];
    return null;
  }
  /** A stable group key: 'sub:<id>' on the roster, else 'name:<key>'. */
  function groupKeyFor(e, roster) {
    var r = resolveSub(e && e.supplier, e && e.subId, roster);
    if (r) return 'sub:' + r.id;
    return 'name:' + payeeKey(e && e.supplier);
  }

  /**
   * Merge SUGGESTIONS, never merges. Types:
   *   roster_duplicate  two roster subs share a key (exact) or look alike
   *   alias             a payee spelling on payments that is not on the roster but
   *                     matches / looks like a roster sub  { name, subId, exact }
   *   unrostered_group  two or more spellings of one payee that are on no roster sub
   * The caller applies one only when the user taps it.
   */
  function mergeSuggestions(roster, payments) {
    var list = roster || [], out = [], i, j;
    for (i = 0; i < list.length; i++) for (j = i + 1; j < list.length; j++) {
      var ka = payeeKey(list[i].name), kb = payeeKey(list[j].name);
      if (ka && (ka === kb || similarKeys(ka, kb))) {
        out.push({ type: 'roster_duplicate', a: list[i].id, b: list[j].id, aName: list[i].name, bName: list[j].name, exact: ka === kb });
      }
    }
    var spellings = {}; // raw -> count
    paymentsOf(payments).forEach(function (e) {
      var raw = String(e.supplier || '').trim();
      if (raw && !resolveSub(raw, e.subId, list)) spellings[raw] = (spellings[raw] || 0) + 1;
    });
    var raws = Object.keys(spellings).sort();
    raws.forEach(function (raw) {
      var k = payeeKey(raw);
      for (i = 0; i < list.length; i++) {
        var rk = payeeKey(list[i].name);
        if (k && rk && similarKeys(k, rk)) { out.push({ type: 'alias', name: raw, subId: list[i].id, subName: list[i].name, exact: false, count: spellings[raw] }); break; }
      }
    });
    var byKey = {};
    raws.forEach(function (raw) {
      var k = payeeKey(raw); if (!k) return;
      (byKey[k] = byKey[k] || []).push(raw);
    });
    Object.keys(byKey).forEach(function (k) {
      if (byKey[k].length > 1) out.push({ type: 'unrostered_group', key: k, names: byKey[k] });
    });
    return out;
  }

  // ── per-sub view ──────────────────────────────────────────────────────
  function monthKey(v) {
    var ms = toMs(v); if (ms == null) return 'undated';
    var d = new Date(ms);
    return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1);
  }
  /**
   * Per-sub totals over every live sub payment (rows answered "Not a job cost"
   * still count as money paid to the sub). -> [{ key, subId|null, name, trade,
   * totalCents, count, noProof, noJob, byJob{leadId:{cents,count}}, byMonth[], spellings[] }]
   * sorted by total paid, biggest first.
   */
  function perSub(payments, roster) {
    var map = {};
    paymentsOf(payments).forEach(function (e) {
      var key = groupKeyFor(e, roster);
      var r = resolveSub(e.supplier, e.subId, roster);
      var g = map[key] = map[key] || {
        key: key, subId: r ? r.id : null, name: r ? r.name : String(e.supplier || '').trim() || 'Unknown',
        trade: r ? (r.trade || '') : '', totalCents: 0, count: 0, noProof: 0, noJob: 0, byJob: {}, byMonthMap: {}, spellings: []
      };
      var c = centsOf(e);
      g.totalCents += c; g.count++;
      if (!hasProof(e)) g.noProof++;
      if (needsJob(e)) g.noJob++;
      if (e.leadId) { var b = g.byJob[e.leadId] = g.byJob[e.leadId] || { cents: 0, count: 0 }; b.cents += c; b.count++; }
      var mk = monthKey(e.date);
      var m = g.byMonthMap[mk] = g.byMonthMap[mk] || { key: mk, cents: 0, count: 0 };
      m.cents += c; m.count++;
      var raw = String(e.supplier || '').trim();
      if (raw && g.spellings.indexOf(raw) === -1) g.spellings.push(raw);
    });
    // A roster sub with no payments yet still shows (so "add a sub" has a home).
    (roster || []).forEach(function (r) {
      var key = 'sub:' + r.id;
      if (!map[key]) map[key] = { key: key, subId: r.id, name: r.name, trade: r.trade || '', totalCents: 0, count: 0, noProof: 0, noJob: 0, byJob: {}, byMonthMap: {}, spellings: [] };
    });
    return Object.keys(map).map(function (k) {
      var g = map[k];
      g.byMonth = Object.keys(g.byMonthMap).map(function (m) { return g.byMonthMap[m]; }).sort(function (a, b) { return a.key < b.key ? 1 : -1; });
      delete g.byMonthMap;
      return g;
    }).sort(function (a, b) { return (b.totalCents - a.totalCents) || a.name.localeCompare(b.name); });
  }

  // ── the three dashboard counters ──────────────────────────────────────
  /** jobsNoSub is passed in (it needs collected money from the auditor). */
  function counters(payments, jobsNoSub) {
    var rows = paymentsOf(payments);
    var noJob = rows.filter(needsJob), noProof = rows.filter(function (e) { return !hasProof(e); });
    var sum = function (a) { return a.reduce(function (t, e) { return t + centsOf(e); }, 0); };
    return {
      jobsNoSub: jobsNoSub == null ? null : jobsNoSub,
      paymentsNoJob: noJob.length, noJobCents: sum(noJob),
      paymentsNoProof: noProof.length, noProofCents: sum(noProof),
      total: rows.length
    };
  }

  // ── queue B: search / filter / sort ───────────────────────────────────
  /** opts: { scope:'nojob'|'all', query, method, sub (groupKey), proof:'all'|'none', sort:'newest'|'oldest'|'amount' } */
  function filterPayments(payments, roster, opts) {
    var o = opts || {};
    var q = String(o.query || '').trim().toLowerCase();
    var rows = paymentsOf(payments).filter(function (e) {
      if ((o.scope || 'nojob') === 'nojob' && !needsJob(e)) return false;
      if (o.method && o.method !== 'all' && (e.paymentMethod || 'cash') !== o.method) return false;
      if (o.proof === 'none' && hasProof(e)) return false;
      if (o.sub && o.sub !== 'all' && groupKeyFor(e, roster) !== o.sub) return false;
      if (q) {
        var hay = (String(e.supplier || '') + ' ' + String(e.note || '') + ' ' + (centsOf(e) / 100).toFixed(2)).toLowerCase();
        if (hay.indexOf(q.replace(/^\$/, '')) === -1) return false;
      }
      return true;
    });
    var dt = function (e) { var m = toMs(e.date); return m == null ? 0 : m; };
    var by = {
      newest: function (a, b) { return dt(b) - dt(a); },
      oldest: function (a, b) { return dt(a) - dt(b); },
      amount: function (a, b) { return centsOf(b) - centsOf(a); }
    };
    return rows.sort(by[o.sort] || by.newest);
  }

  // ── suggestions: which job does this payment belong to? ───────────────
  function leadName(l) { return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || String(l.address || '').split(',')[0] || 'Untitled'; }
  function windowOf(l) {
    var s = dayNum(l && l.scheduledDate);
    if (s == null) return null;
    var e = dayNum(l.scheduledEndDate);
    return { start: s, end: e != null && e >= s ? e : s };
  }
  /**
   * Likely jobs for one payment, best first. NEVER assigns: the caller shows
   * these and the user taps one. ctx = { roster, payments (all, for the sub's past
   * jobs), hasSubByLead { leadId: true } }. Signals (a job needs at least one of
   * the first two to appear):
   *   +50  payment date inside the job's work window (+/- grace days)
   *   +30-d payment date d days outside it, within nearDays
   *   +25  this same sub was paid on the job before
   *   +15  the job has no sub cost yet (a boost only, never a reason on its own)
   */
  function suggestJobs(payment, leads, ctx) {
    var c = ctx || {};
    var pd = dayNum(payment && payment.date);
    var gk = groupKeyFor(payment, c.roster);
    var pastJobs = {};
    paymentsOf(c.payments).forEach(function (e) {
      if (e.leadId && e.id !== (payment && payment.id) && groupKeyFor(e, c.roster) === gk) pastJobs[e.leadId] = (pastJobs[e.leadId] || 0) + 1;
    });
    var out = [];
    (leads || []).forEach(function (l) {
      if (!l || !l.id || l.deleted || l.isProspect) return;
      var score = 0, reasons = [], signal = false;
      var w = windowOf(l);
      if (pd != null && w) {
        if (pd >= w.start - CONFIG.windowGraceDays && pd <= w.end + CONFIG.windowGraceDays) {
          score += 50; signal = true; reasons.push('Paid during the job\'s work window');
        } else {
          var d = pd < w.start ? w.start - pd : pd - w.end;
          if (d <= CONFIG.nearDays) { score += 30 - d; signal = true; reasons.push('Paid ' + d + ' day' + (d === 1 ? '' : 's') + (pd < w.start ? ' before' : ' after') + ' the job\'s work window'); }
        }
      }
      if (pastJobs[l.id]) { score += 25; signal = true; reasons.push('Same sub was paid on this job before'); }
      if (!signal) return;
      if (!(c.hasSubByLead && c.hasSubByLead[l.id])) { score += 15; reasons.push('No sub cost logged on this job yet'); }
      out.push({ leadId: l.id, name: leadName(l), score: score, reasons: reasons });
    });
    out.sort(function (a, b) { return (b.score - a.score) || a.name.localeCompare(b.name); });
    return out.slice(0, CONFIG.maxSuggestions);
  }

  /** Free search over jobs by customer name, address, customer id. */
  function searchJobs(leads, query, limit) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    var out = [];
    (leads || []).forEach(function (l) {
      if (!l || !l.id || l.deleted || l.isProspect) return;
      var hay = (leadName(l) + ' ' + (l.address || '') + ' ' + (l.customerId || '')).toLowerCase();
      if (hay.indexOf(q) !== -1) out.push({ leadId: l.id, name: leadName(l), address: String(l.address || '') });
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return out.slice(0, limit || 8);
  }

  // ── writes: the doc and the patches ───────────────────────────────────
  function parseCents(input) {
    var s = String(input == null ? '' : input).replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return 0;
    return Math.round(parseFloat(s) * 100);
  }
  function logEntry(by, what, note, nowMs) {
    return { at: nowMs, by: by || null, what: what, source: 'sub-payments', note: String(note || '').trim().slice(0, 300) };
  }
  function appendLog(prev, entry) {
    var b = Array.isArray(prev) ? prev.slice() : [];
    b.push(entry);
    return b.slice(-CONFIG.maxLog);
  }

  /**
   * form: { who, amount, method, date 'YYYY-MM-DD', note, leadId, proofPaths[] }
   * ctx:  { roster, jobIdFor(leadId) }
   * -> { fields } for an /expenses doc (no timestamps, no user fields), or { error }.
   */
  function buildPayment(form, ctx) {
    var f = form || {}, c = ctx || {};
    var who = String(f.who || '').trim().slice(0, 120);
    if (!who) return { error: 'Who was paid? Pick a sub or add a new one.' };
    var cents = parseCents(f.amount);
    if (cents <= 0) return { error: 'Enter an amount greater than $0' };
    if (cents > MAX_CENTS) return { error: 'That amount is too large' };
    var method = METHOD_KEYS.indexOf(f.method) !== -1 ? f.method : null;
    if (!method) return { error: 'How was it paid? Pick cash, check, Zelle or other.' };
    var d;
    if (f.date) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f.date));
      d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(NaN);
    } else d = new Date();
    if (isNaN(d.getTime())) return { error: 'Pick a valid date' };
    var proofs = (f.proofPaths || []).filter(proofPathOk).slice(0, CONFIG.maxProofs);
    var leadId = f.leadId ? String(f.leadId) : null;
    var hit = resolveSub(who, f.subId, c.roster);
    var fields = {
      leadId: leadId,
      jobId: leadId && c.jobIdFor ? c.jobIdFor(leadId) : null,
      category: CATEGORY, costType: 'direct', auditKind: 'sub',
      supplier: hit ? hit.name : who,
      amountCents: cents, taxCents: 0, paymentMethod: method, date: d,
      note: String(f.note || '').trim().slice(0, 500),
      estimated: false, notJobCost: false, proofPaths: proofs
    };
    if (hit) fields.subId = hit.id;
    return { fields: fields };
  }

  /** The update that attaches a job to a payment. */
  function assignPatch(row, lead, jobId, by, nowMs) {
    return {
      leadId: lead.id, jobId: jobId || null,
      editLog: appendLog(row.editLog, logEntry(by, 'assign-job', 'Job picked: ' + leadName(lead), nowMs))
    };
  }
  /** "Not a job cost": overhead, remembered on the row so it never comes back. */
  function overheadPatch(row, by, nowMs) {
    return { costType: 'overhead', notJobCost: true, editLog: appendLog(row.editLog, logEntry(by, 'not-a-job-cost', 'Marked not a job cost (overhead)', nowMs)) };
  }
  function undoOverheadPatch(row, by, nowMs) {
    return { costType: 'direct', notJobCost: false, editLog: appendLog(row.editLog, logEntry(by, 'undo-not-a-job-cost', 'Put back as a job cost', nowMs)) };
  }
  function proofPatch(row, newPaths, by, nowMs) {
    var have = Array.isArray(row.proofPaths) ? row.proofPaths.filter(proofPathOk) : [];
    var add = (newPaths || []).filter(proofPathOk);
    var all = have.concat(add).slice(0, CONFIG.maxProofs);
    return { proofPaths: all, editLog: appendLog(row.editLog, logEntry(by, 'add-proof', add.length + ' proof file' + (add.length === 1 ? '' : 's') + ' added', nowMs)) };
  }
  function voidPatch(row, note, by, nowMs) {
    var n = String(note || '').trim();
    if (!n) return { error: 'Say why you are voiding it.' };
    return { patch: { deleted: true, deletedAt: new Date(nowMs || Date.now()), editLog: appendLog(row.editLog, logEntry(by, 'void', n, nowMs)) } };
  }

  var API = {
    CONFIG: CONFIG, METHODS: METHODS, SOURCE: SOURCE, CATEGORY: CATEGORY, MAX_CENTS: MAX_CENTS,
    centsOf: centsOf, dayNum: dayNum, parseCents: parseCents,
    payeeKey: payeeKey, similarKeys: similarKeys, resolveSub: resolveSub, groupKeyFor: groupKeyFor, mergeSuggestions: mergeSuggestions,
    isSubPayment: isSubPayment, needsJob: needsJob, hasProof: hasProof, proofCount: proofCount, proofPathOk: proofPathOk, paymentsOf: paymentsOf,
    perSub: perSub, counters: counters, filterPayments: filterPayments, suggestJobs: suggestJobs, searchJobs: searchJobs, leadName: leadName,
    buildPayment: buildPayment, assignPatch: assignPatch, overheadPatch: overheadPatch, undoOverheadPatch: undoOverheadPatch,
    proofPatch: proofPatch, voidPatch: voidPatch, logEntry: logEntry, appendLog: appendLog
  };
  if (root && typeof root === 'object') root.NBDSubPaymentsLogic = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : null);
