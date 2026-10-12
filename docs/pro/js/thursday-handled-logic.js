/**
 * thursday-handled-logic.js — "let Thursday handle this number" + what Today
 * shows for her calls, PURE (2026-10-12). Nothing here touches the DOM,
 * Firestore or the clock.
 *
 * Design + decisions: documentation/projects/THURSDAY-LABEL-PLAYBOOKS-2026-10-12.md.
 *
 *   - companies/{companyId}/thursday_handled/{digits10} — the doc's EXISTENCE is
 *     the setting (opt-in, per number, default off). It only changes (1) what
 *     Thursday is TOLD when she looks the caller up and (2) how Today shows her
 *     calls from that number. It never forwards a call, never sends anything.
 *   - disposition(call, label, handled) puts every Thursday call in exactly one
 *     tier, so a Thursday call can never end without a place on Today:
 *       item    its own row (needs Jo)
 *       recap   one line in the daily "Thursday handled N calls" row
 *       ledger  counted only (spam / test / a hang-up, or a number Jo hid)
 *       done    Jo already reviewed it
 *       wait    still being processed — the row arrives when it is
 *   - "Block" is NOT a new policy value: a blocked number is a contact label
 *     kind 'spam' with policy 'hide' (the suppression that already exists).
 *     Every consumer of label policy knows surface/quiet/hide only, and a
 *     fourth value would be silently ignored by all of them. The block list is a
 *     view + a copy button; the CRM never blocks at the carrier.
 *
 * Browser: window.NBDThursdayHandledLogic. Node: module.exports.
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var WINDOW_MS = 3 * DAY;       // how long an unreviewed Thursday call stays on Today
  var NOTE_MAX = 200;
  var DOC_KEYS = ['digits', 'companyId', 'updatedBy', 'updatedAtMs', 'createdAtMs', 'note'];
  var LOG_ONLY_TYPES = ['spam', 'test', 'silent'];
  // Pinned to functions/integrations/thursday-playbooks.js KIND_TO_PLAYBOOK by a test.
  var KIND_TO_PLAYBOOK = {
    customer: 'customer', prospect: 'prospect', contractor: 'sub', sub: 'sub', supplier: 'supplier',
    insurance: 'insurance', referral: 'referral', personal: 'personal', spam: 'spam', recruiter: 'recruiter', other: 'unknown',
  };
  var PLAYBOOK_LABEL = {
    customer: 'Customer', prospect: 'Prospect', sub: 'Sub / contractor', supplier: 'Supplier', insurance: 'Adjuster / carrier',
    referral: 'Referral partner', personal: 'Personal', recruiter: 'Job seeker', spam: 'Spam', unknown: 'Unknown caller',
  };

  function digits10(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }
  function clip(s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); }
  function toMs(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  function fmtPhone(d) { d = digits10(d); return d ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : ''; }

  // ── the setting doc ──────────────────────────────────────────────────
  /** A doc ready to write, or null. */
  function buildDoc(o) {
    o = o || {};
    var d = digits10(o.digits);
    if (!d || !o.companyId || !o.uid) return null;
    var now = Number(o.nowMs) || Date.now();
    var doc = {
      digits: d, companyId: String(o.companyId), updatedBy: String(o.uid),
      updatedAtMs: now, createdAtMs: Number(o.createdAtMs) || now,
    };
    var note = clip(o.note, NOTE_MAX);
    if (note) doc.note = note;
    return doc;
  }
  /** [{id, data}] → { digits10: { digits, note, createdAtMs, updatedAtMs } }. */
  function indexHandled(docs) {
    var out = {};
    (docs || []).forEach(function (r) {
      var data = (r && (r.data || r)) || {};
      var d = digits10((r && r.id) || data.digits);
      if (!d) return;
      out[d] = { digits: d, note: clip(data.note, NOTE_MAX), createdAtMs: Number(data.createdAtMs) || 0, updatedAtMs: Number(data.updatedAtMs) || 0 };
    });
    return out;
  }
  function lookup(map, digits) {
    var d = digits10(digits);
    if (!map || !d) return null;
    return (typeof map.get === 'function' ? map.get(d) : map[d]) || null;
  }

  /**
   * Can Jo hand this number to Thursday?
   *   o.ownDigits [10-digit]   his own lines
   *   o.label     the number's contact label or null
   */
  function checkTarget(digits, o) {
    o = o || {};
    var d = digits10(digits);
    if (!d) return { ok: false, reason: 'No usable phone number on this row.' };
    if ((o.ownDigits || []).map(digits10).indexOf(d) !== -1) return { ok: false, reason: 'That is your own number.' };
    if (o.label && o.label.kind === 'spam') {
      return { ok: false, reason: 'This number is labeled spam. Thursday ends those calls politely; label it something else first if you want her to take messages.' };
    }
    return { ok: true, reason: '' };
  }

  // ── Today tiers ──────────────────────────────────────────────────────
  function policyOf(label) {
    if (!label) return 'surface';
    if (label.policy === 'hide' || label.policy === 'quiet' || label.policy === 'surface') return label.policy;
    return label.kind === 'personal' || label.kind === 'spam' ? 'hide' : 'surface';
  }
  function callbackAsked(call) {
    var ex = (call && call.extraction) || {};
    return !!clip(ex.callback_window, 120);
  }
  function callerTypeOf(call) {
    return String((call && (call.callerType || (call.extraction && call.extraction.caller_type))) || '');
  }

  /**
   * Which tier a thursday_calls doc belongs to.
   *   call     thursday_calls doc
   *   label    contact label for call.from, or null
   *   handled  thursday_handled setting for call.from, or null
   * Returns { tier, reason }.
   */
  function disposition(call, label, handled) {
    var c = call || {};
    var type = callerTypeOf(c);
    if (c.status === 'pending' || c.status === 'processing' || c.status === 'reprocess') return { tier: 'wait', reason: 'processing' };
    if (c.reviewed === true) return { tier: LOG_ONLY_TYPES.indexOf(type) !== -1 ? 'ledger' : 'done', reason: 'reviewed' };
    var urgent = c.urgent === true || (c.extraction && c.extraction.urgent === true);
    var wins = urgent || callbackAsked(c);
    var kind = label && label.kind ? label.kind : '';
    if (kind === 'spam') return { tier: 'ledger', reason: 'spam label' };
    if (handled) return wins ? { tier: 'item', reason: urgent ? 'urgent' : 'asked for a callback' } : { tier: 'recap', reason: 'handled number' };
    var p = policyOf(label);
    if (p === 'hide') return urgent ? { tier: 'item', reason: 'urgent from a hidden number' } : { tier: 'ledger', reason: 'hidden number' };
    if (p === 'quiet') return wins ? { tier: 'item', reason: urgent ? 'urgent' : 'asked for a callback' } : { tier: 'recap', reason: 'quiet number' };
    return { tier: 'item', reason: 'new call' };
  }

  /**
   * How unsure Thursday was, higher = look at it first. Built only from what
   * the call doc already carries (extraction confidence, the route, whether the
   * label and the caller type disagree, whether there is a way to call back).
   */
  function uncertainty(call, label) {
    var c = call || {}, ex = c.extraction || {};
    var score = 0, why = [];
    function add(n, t) { score += n; why.push(t); }
    if (c.status === 'failed' || c.extractionError) add(50, 'her notes failed — read the recording');
    if (!c.extraction && c.status !== 'failed') add(30, 'no notes');
    if (ex.confidence === 'low') add(40, 'she was not sure what they said');
    else if (ex.confidence === 'medium') add(10, 'medium confidence');
    if (c.route && c.route.action === 'possible_match') add(25, 'might be a customer — not confirmed');
    if (c.route && c.route.action === 'inbox' && callerTypeOf(c) === 'new_lead') add(15, 'not matched to anyone');
    var type = callerTypeOf(c);
    var kind = label && label.kind ? label.kind : '';
    var expect = { sub: 'supplier_sub', contractor: 'supplier_sub', supplier: 'supplier_sub', insurance: 'adjuster', recruiter: 'job_seeker', spam: 'spam', customer: 'existing_customer' }[kind];
    if (expect && type && type !== expect && type !== 'silent' && type !== 'test') add(30, 'the call did not match the label (' + kind + ')');
    if (type === 'silent') add(20, 'hung up or silent');
    if (!digits10(ex.callback_number) && !digits10(c.fromDigits || c.from)) add(20, 'no number to call back');
    if (!clip(ex.issue || c.issue, 300)) add(15, 'no summary of what they wanted');
    if (ex.language && ex.language !== 'en') add(10, 'spoke ' + ex.language);
    if (c.urgent === true) add(10, 'marked urgent — confirm it');
    return { score: Math.min(100, score), reasons: why };
  }

  function whoOf(call, label) {
    var ex = (call && call.extraction) || {};
    return clip(ex.caller_name || call.callerName || (label && label.name) || fmtPhone(call.fromDigits || call.from) || 'Unknown caller', 80);
  }

  /**
   * Everything Today needs about Thursday's calls.
   *   calls     thursday_calls docs (any order)
   *   labels    { digits10: label } | Map
   *   handled   { digits10: setting } | Map
   * Returns { items, recap, ledgerCount, handledCount }:
   *   items  tier 'item' rows, newest first
   *   recap  { rows (least sure first), top (first 3), count }
   */
  function summarize(calls, labels, handled, now, opts) {
    var o = opts || {};
    var t = Number(now) || Date.now();
    var items = [], recap = [], ledger = 0;
    (calls || []).forEach(function (c) {
      if (!c) return;
      var at = toMs(c.startedAt) || toMs(c.processedAt) || toMs(c.createdAt);
      if (at && t - at > (o.windowMs || WINDOW_MS)) return;
      var d = digits10(c.fromDigits || c.from);
      var label = d ? lookup(labels, d) : null;
      var h = d ? lookup(handled, d) : null;
      var disp = disposition(c, label, h);
      if (disp.tier === 'ledger') { ledger++; return; }
      if (disp.tier !== 'item' && disp.tier !== 'recap') return;
      var u = uncertainty(c, label);
      var row = {
        id: String(c.callId || c._id || c.id || ''), digits: d, who: whoOf(c, label), at: at,
        summary: clip((c.extraction && c.extraction.issue) || c.issue || (c.call && c.call.summary) || '', 160),
        urgent: c.urgent === true, tier: disp.tier, reason: disp.reason, labelKind: label ? label.kind : '',
        playbook: label && KIND_TO_PLAYBOOK[label.kind] ? KIND_TO_PLAYBOOK[label.kind] : '',
        handled: !!h, score: u.score, why: u.reasons, leadId: c.leadId || (c.route && c.route.leadId) || '',
        taskId: c.taskId || '',
      };
      (disp.tier === 'item' ? items : recap).push(row);
    });
    items.sort(function (a, b) { return (b.urgent - a.urgent) || (b.at - a.at); });
    // Least sure first; among equals the newest.
    recap.sort(function (a, b) { return (b.score - a.score) || (b.at - a.at); });
    return {
      items: items,
      recap: { rows: recap, top: recap.slice(0, 3), count: recap.length },
      ledgerCount: ledger,
      handledCount: handled ? (typeof handled.size === 'number' ? handled.size : Object.keys(handled).length) : 0,
    };
  }

  // ── block list ───────────────────────────────────────────────────────
  /** Numbers Jo labeled spam (policy hide): [{ digits, name, note, updatedAtMs }], newest first. */
  function blockList(labels) {
    var out = [];
    var each = function (l, k) {
      if (!l || l.kind !== 'spam' || policyOf(l) !== 'hide') return;
      var d = digits10(l.digits || k);
      if (d) out.push({ digits: d, name: clip(l.name, 80), note: clip(l.note, 200), updatedAtMs: Number(l.updatedAtMs) || 0 });
    };
    if (labels && typeof labels.forEach === 'function' && typeof labels.get === 'function') labels.forEach(function (l, k) { each(l, k); });
    else Object.keys(labels || {}).forEach(function (k) { each(labels[k], k); });
    out.sort(function (a, b) { return b.updatedAtMs - a.updatedAtMs; });
    return out;
  }
  /** One number per line, ready to paste. */
  function blockListText(list) {
    return (list || []).map(function (r) { return fmtPhone(r.digits) + (r.name ? ' - ' + r.name : ''); }).join('\n');
  }

  var API = {
    DAY: DAY, WINDOW_MS: WINDOW_MS, NOTE_MAX: NOTE_MAX, DOC_KEYS: DOC_KEYS, LOG_ONLY_TYPES: LOG_ONLY_TYPES,
    KIND_TO_PLAYBOOK: KIND_TO_PLAYBOOK, PLAYBOOK_LABEL: PLAYBOOK_LABEL,
    digits10: digits10, fmtPhone: fmtPhone, toMs: toMs, buildDoc: buildDoc, indexHandled: indexHandled, lookup: lookup,
    checkTarget: checkTarget, policyOf: policyOf, disposition: disposition, uncertainty: uncertainty,
    summarize: summarize, blockList: blockList, blockListText: blockListText,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root && root.document) root.NBDThursdayHandledLogic = API;
})(typeof window !== 'undefined' ? window : null);
