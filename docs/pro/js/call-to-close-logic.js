/**
 * call-to-close-logic.js — Call to Close P1 (2026-11-09), pure rules for two
 * one-tap surfaces of the Call Brief.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §4 (5), §6 #3, §9 P1.
 *
 * 1. stagePlan(): what the brief's stage card may do with its suggestion.
 *    'one-tap'  a plain forward move, one tap through the CRM's own stage
 *               writer (customer page: progressStage; dashboard: moveCard).
 *    'confirm'  never one tap: Inspected (it orders a $3 roof measurement
 *               that Undo cannot refund, measure-auto-order.js), Install
 *               Done (the after-install automations), and Lost / Archived /
 *               Cancelled (stage-write.js stageMoveNeedsConfirm; Lost needs
 *               a reason), and any move BACK to an earlier stage. The sheet
 *               asks first, naming why.
 *    'flow'     never moves from the sheet: a stage that sets an appointment
 *               (a scheduled meeting or visit). It opens the normal place to
 *               change the stage, where the date is set too.
 *    'refuse'   a call never moves a customer to a signed contract, a job
 *               or a won stage (functions/call-brief-logic.js already never
 *               offers one; this is the second lock).
 *    'none'     no suggestion, or the customer is already there.
 *    The server mirror is functions/call-brief-logic.js stageOneTapAllowed;
 *    tests/call-to-close-stage-2026-11-09.test.js holds the two equal.
 *
 * 2. saidVsProposal(): before Generate on a proposal, what a call said the
 *    work includes that the proposal leaves out. Fixed phrases only (no model
 *    call at generate time, no model wording copied): a small vocabulary of
 *    scope items, looked for in what the server grounded (the scope mention
 *    flags and the service) and in the promises a person ACCEPTED on the
 *    brief shown, then looked for in the proposal's own text. Each item
 *    carries the words that were said (shown, never copied onto the document)
 *    and a fixed scope phrase "Copy into scope" puts in the visible list.
 *    It never blocks Generate and never writes anything itself.
 *
 * UMD: window.NBDCallToClose in the browser (lazy-loaded by call-brief-ui.js
 * and doc-preflight.js, never at boot), module.exports in node (the tests).
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.NBDCallToClose = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // ── 1. stage moves ───────────────────────────────────────────────────
  var OFFER_ROLES = ['new', 'active', 'lost'];
  var NEVER_KEYS = ['contract_signed'];
  // Never one tap, whatever role a tenant gives them.
  var CONFIRM_KEYS = ['inspected', 'install_complete'];
  // A stage whose key says something gets scheduled: never moved from the sheet.
  var APPOINTMENT_RE = /(^|_)(appointment|appt|appts|meeting|scheduled?|booked|booking|visit)(_|$)/;
  var CLOSE_OUT_RE = /(^|[_\s-])(lost|archived?|cancell?ed)($|[_\s-])/;
  // The default pipeline order (= functions/call-brief-logic.js DEFAULT_STAGES,
  // which mirrors crm-stages.js STAGE_META). A suggestion that sits EARLIER
  // than where the customer is would move them back: never one tap.
  var STAGE_ORDER = ['new', 'contacted', 'inspected', 'claim_filed', 'adjuster_meeting_scheduled', 'adjuster_inspection_done',
    'scope_received', 'estimate_submitted', 'supplement_requested', 'supplement_approved', 'estimate_sent_cash', 'negotiating',
    'prequal_sent', 'loan_approved', 'contract_signed', 'job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered',
    'crew_scheduled', 'install_in_progress', 'install_complete', 'final_photos', 'deductible_collected', 'final_payment',
    'collections', 'closed', 'warranty_claim', 'warranty_scheduled', 'warranty_repaired', 'service_quoted', 'service_approved', 'lost'];
  // A tenant's own order (companyProfile.pipelines.views[*].stages, the
  // board's columns) decides when a view lists both stages: any such view
  // that puts the suggestion earlier makes it a move back. Otherwise the
  // default order decides (review 2026-11-09).
  function movesBack(key, currentKey, orders) {
    var cur = normKey(currentKey);
    var own = (Array.isArray(orders) ? orders : []).filter(function (o) { return Array.isArray(o) && o.indexOf(key) !== -1 && o.indexOf(cur) !== -1; });
    if (own.length) return own.some(function (o) { return o.indexOf(key) < o.indexOf(cur); });
    var a = STAGE_ORDER.indexOf(key), b = STAGE_ORDER.indexOf(cur);
    return a !== -1 && b !== -1 && a < b;
  }
  /** A tenant's pipeline orders: each view's stage list, keys normalised. */
  function tenantStageOrders(pipelines) {
    var views = pipelines && typeof pipelines === 'object' && pipelines.views && typeof pipelines.views === 'object' ? pipelines.views : {};
    var out = [];
    Object.keys(views).forEach(function (vk) {
      var v = views[vk];
      if (!v || typeof v !== 'object' || !Array.isArray(v.stages)) return;
      var list = v.stages.filter(function (k) { return typeof k === 'string' && k.trim(); }).map(normKey);
      if (list.length > 1) out.push(list);
    });
    return out;
  }

  function normKey(k) { return String(k == null ? '' : k).trim().toLowerCase().replace(/[\s-]+/g, '_'); }

  var WHY = {
    inspected: 'Moving to this stage orders a roof measurement ($3) that Undo cannot refund.',
    install_complete: 'Moving to this stage starts the after-install steps (the Before & After report, the close-out tasks).',
    lost: 'This closes the customer out. It needs a reason.',
    closeOut: 'This closes the customer out.',
    back: 'This moves the customer back to an earlier stage.',
    flow: 'This stage sets an appointment, so it is never moved from here. Change it where you set the date.',
    refuse: 'A call never moves a customer to a signed contract, a job or a won stage.',
  };

  /**
   * stage: the brief's { targetKey, role, label } (role from the tenant's
   * stage list); currentKey: the customer's stage now; orders: the tenant's
   * pipeline orders (tenantStageOrders), optional.
   * → { kind: 'one-tap'|'confirm'|'flow'|'refuse'|'none', key, why, needsReason }
   */
  function stagePlan(stage, currentKey, orders) {
    var s = stage && typeof stage === 'object' ? stage : null;
    var key = normKey(s && s.targetKey);
    if (!key) return { kind: 'none', key: '', why: '', needsReason: false };
    if (key === normKey(currentKey)) return { kind: 'none', key: key, why: 'The customer is already at this stage.', needsReason: false };
    var role = normKey(s.role);
    if (NEVER_KEYS.indexOf(key) !== -1 || OFFER_ROLES.indexOf(role) === -1) return { kind: 'refuse', key: key, why: WHY.refuse, needsReason: false };
    if (APPOINTMENT_RE.test(key)) return { kind: 'flow', key: key, why: WHY.flow, needsReason: false };
    if (CONFIRM_KEYS.indexOf(key) !== -1) return { kind: 'confirm', key: key, why: WHY[key], needsReason: false };
    if (role === 'lost' || key === 'lost') return { kind: 'confirm', key: key, why: WHY.lost, needsReason: true };
    if (CLOSE_OUT_RE.test(key)) return { kind: 'confirm', key: key, why: WHY.closeOut, needsReason: false };
    if (movesBack(key, currentKey, orders)) return { kind: 'confirm', key: key, why: WHY.back, needsReason: false };
    return { kind: 'one-tap', key: key, why: '', needsReason: false };
  }
  /** The server's question: may a move to this stage from fromKey (when known) go in one tap? */
  function oneTapAllowed(key, role, fromKey, orders) {
    var from = normKey(fromKey) === normKey(key) ? '' : fromKey;
    return stagePlan({ targetKey: key, role: role }, from || '', orders).kind === 'one-tap';
  }

  // ── 2. said vs. proposal ─────────────────────────────────────────────
  // Order matters: the specific item before the general one (gutter guards
  // before gutters). `said` finds it in what the call said; `has` finds it in
  // the proposal, narrowly enough not to hide a real gap (gutter guards are
  // not gutters, a pipe vent is not attic ventilation, a patio deck is not
  // roof decking). `phrase` is the fixed scope line "Copy into scope" adds.
  var VOCAB = [
    { key: 'gutterGuards', label: 'Gutter guards', phrase: 'Gutter guards', said: /\b(gutter|leaf)\s*(guards?|screens?|covers?)\b/, has: /\b(gutter|leaf)\s*(guards?|screens?|covers?)\b/ },
    { key: 'gutters', label: 'Gutters', phrase: 'Gutters', said: /\bgutters?\b(?!\s*(guards?|screens?|covers?))/, has: /\bgutters?\b(?!\s*(guards?|screens?|covers?))/ },
    { key: 'downspouts', label: 'Downspouts', phrase: 'Downspouts', said: /\bdown\s*spouts?\b/, has: /\bdown\s*spouts?\b/ },
    { key: 'chimney', label: 'Chimney flashing', phrase: 'Chimney flashing', said: /\bchimney\b/, has: /\bchimney\b/ },
    { key: 'skylight', label: 'Skylights', phrase: 'Skylights', said: /\bsky\s*lights?\b/, has: /\bsky\s*lights?\b/ },
    { key: 'decking', label: 'Decking', phrase: 'Replace damaged decking as needed', said: /\b(decking|plywood|sheathing|osb)\b/, has: /\b(roof\s*deck(ing)?|decking|plywood|sheathing|osb)\b/ },
    { key: 'ridgeVent', label: 'Ridge vent', phrase: 'Ridge vent', said: /\bridge\s*vents?\b/, has: /\bridge\s*vents?\b/ },
    { key: 'ventilation', label: 'Attic ventilation', phrase: 'Attic ventilation', said: /\b(attic\s*(fan|vent|ventilation)|ventilation|box\s*vents?|turbines?)\b/, has: /\b(ventilation|(ridge|box|attic|soffit|static|power|off[\s-]*ridge|turtle)\s*vents?|turbines?|attic\s*fans?)\b/ },
    { key: 'dripEdge', label: 'Drip edge', phrase: 'Drip edge', said: /\bdrip\s*edge\b/, has: /\bdrip\s*edge\b/ },
    { key: 'iceWater', label: 'Ice and water shield', phrase: 'Ice and water shield', said: /\bice\s*(and|&|n)?\s*water\b/, has: /\bice\s*(and|&|n)?\s*water\b/ },
    { key: 'fascia', label: 'Fascia', phrase: 'Fascia', said: /\bfascia\b/, has: /\bfascia\b/ },
    { key: 'soffit', label: 'Soffit', phrase: 'Soffit', said: /\bsoffits?\b/, has: /\bsoffits?\b/ },
    { key: 'siding', label: 'Siding', phrase: 'Siding', said: /\bsiding\b/, has: /\bsiding\b/ },
    { key: 'satellite', label: 'Satellite dish', phrase: 'Remove and reset the satellite dish', said: /\b(satellite|dish)\b/, has: /\b(satellite|dish)\b/ },
    { key: 'solar', label: 'Solar panels', phrase: 'Remove and reset the solar panels', said: /\bsolar\b/, has: /\bsolar\b/ },
    { key: 'permit', label: 'Permit', phrase: 'Building permit', said: /\bpermits?\b/, has: /\bpermits?\b/ },
    { key: 'cleanup', label: 'Cleanup', phrase: 'Full cleanup and haul-away', said: /\b(clean\s*up|cleanup|haul\s*(it\s*)?away|dumpster|magnet(ic)?\s*(sweep|nail))\b/, has: /\b(clean\s*up|cleanup|haul|dumpster|magnet)\b/ },
  ];
  // The grounded mention flags → the vocabulary item each one means.
  var MENTION_KEY = { gutters: 'gutters', chimney: 'chimney', skylight: 'skylight', decking: 'decking' };

  function low(s) { return String(s == null ? '' : s).toLowerCase(); }
  function vocabOf(key) { for (var i = 0; i < VOCAB.length; i++) if (VOCAB[i].key === key) return VOCAB[i]; return null; }
  /** Items of the vocabulary found in a piece of what was said. */
  function saidIn(text) {
    var t = low(text);
    return VOCAB.filter(function (v) { return v.said.test(t); }).map(function (v) { return v.key; });
  }
  /** The proposal's own words: description, scope list, note and line items. */
  function proposalText(p) {
    var x = p || {};
    var parts = [x.projectDescription, x.termsNote];
    (Array.isArray(x.scopeItems) ? x.scopeItems : [x.scopeItems]).forEach(function (s) { parts.push(s); });
    (Array.isArray(x.lineItems) ? x.lineItems : []).forEach(function (it) {
      if (it && typeof it === 'object') parts.push(it.description, it.name, it.item, it.label, it.title);
      else parts.push(it);
    });
    return low(parts.filter(function (s) { return s != null && s !== ''; }).join('\n'));
  }
  // The decisions made on the brief shown (gen = its generatedAtMs); call-brief-ui.js decided().
  function acceptedPromise(decisions, i, gen) {
    var ds = Array.isArray(decisions) ? decisions : [];
    for (var n = ds.length - 1; n >= 0; n--) {
      var d = ds[n];
      if (d && d.item === 'promise:' + i && (gen == null || d.gen == null || d.gen === gen)) return d.decision === 'accept';
    }
    return false;
  }
  // The first grounded quote of a brief that names the item (shown, never copied).
  function quoteFor(brief, v) {
    var b = brief || {};
    var qs = [];
    var sc = b.scope || {};
    if (sc.service && sc.service.quote) qs.push(sc.service.quote);
    ((b.summary && b.summary.quotes) || []).forEach(function (q) { qs.push(q); });
    (sc.saidQuantities || []).forEach(function (q) { if (q && q.quote) qs.push(q.quote); });
    (b.promises || []).forEach(function (p) { if (p && p.quote) qs.push(p.quote); });
    var fs = b.fields || {};
    Object.keys(fs).forEach(function (k) { if (fs[k] && fs[k].quote) qs.push(fs[k].quote); });
    for (var i = 0; i < qs.length; i++) if (v.said.test(low(qs[i]))) return String(qs[i]);
    return '';
  }

  /**
   * briefs: [{ callId, brief, decisions, generatedAtMs }] (newest first is
   * best: the first call to name an item gives its quote).
   * proposal: { projectDescription, scopeItems[], termsNote, lineItems[] }.
   * → [{ key, label, phrase, quote, callId, from: 'mention'|'service'|'promise' }]
   */
  function saidVsProposal(briefs, proposal) {
    var have = proposalText(proposal);
    var out = [];
    var seen = {};
    (Array.isArray(briefs) ? briefs : []).forEach(function (row) {
      var r = row || {};
      var b = r.brief;
      if (!b || typeof b !== 'object') return;
      // An unreliable transcript says nothing about scope (the server blanks it too).
      if (b.transcriptOk && b.transcriptOk.reliable === false) return;
      var gen = r.generatedAtMs != null ? Number(r.generatedAtMs) : null;
      var found = [];
      var men = (b.scope && b.scope.mentions) || {};
      Object.keys(MENTION_KEY).forEach(function (m) { if (men[m] === true) found.push([MENTION_KEY[m], 'mention', '']); });
      var svc = b.scope && b.scope.service;
      if (svc && svc.value) saidIn(svc.value + ' ' + (svc.quote || '')).forEach(function (k) { found.push([k, 'service', svc.quote || '']); });
      (b.promises || []).forEach(function (p, i) {
        if (!p || !acceptedPromise(r.decisions, i, gen)) return;
        saidIn((p.text || '') + ' ' + (p.quote || '')).forEach(function (k) { found.push([k, 'promise', p.quote || '']); });
      });
      found.forEach(function (f) {
        var v = vocabOf(f[0]);
        if (!v || seen[v.key] || v.has.test(have)) return;
        seen[v.key] = true;
        var q = f[2] && v.said.test(low(f[2])) ? String(f[2]) : quoteFor(b, v);
        out.push({ key: v.key, label: v.label, phrase: v.phrase, quote: q.slice(0, 300), callId: String(r.callId || ''), from: f[1] });
      });
    });
    return out;
  }

  /** The scope list with the phrase added once (a new array; a blank row the person added stays). */
  function copyIntoScope(scopeItems, phrase) {
    var list = (Array.isArray(scopeItems) ? scopeItems : (scopeItems ? [scopeItems] : [])).map(function (s) { return String(s == null ? '' : s); });
    var p = String(phrase == null ? '' : phrase).trim();
    if (!p) return list;
    var lp = low(p);
    if (list.some(function (s) { return low(s).trim() === lp; })) return list;
    return list.concat([p]);
  }

  /**
   * The briefs on one lead, for the proposal check. Reads the lead's filed
   * calls the way customer-calls.js does (leadId + the user's own, or the
   * company's for company_admin / manager), then each call's brief by its id
   * path (the rules read a brief only through its call). A viewer reads
   * nothing (they cannot read phone_calls, Q11), and every failure is quiet:
   * the check is a help, never a gate. fb: { db, collection, query, where,
   * getDocs, doc, getDoc, limit? }; who: { uid, role, companyId }.
   */
  async function loadLeadBriefs(fb, who, leadId, max) {
    var f = fb || {}, w = who || {};
    if (!leadId || !w.uid || w.role === 'viewer' || !f.db || !f.getDocs || !f.getDoc || !f.doc || !f.collection || !f.query || !f.where) return [];
    var scopes = [[f.where('leadId', '==', leadId), f.where('userId', '==', w.uid)]];
    if ((w.role === 'company_admin' || w.role === 'manager') && w.companyId) scopes.push([f.where('leadId', '==', leadId), f.where('companyId', '==', w.companyId)]);
    var calls = {};
    for (var i = 0; i < scopes.length; i++) {
      try {
        var snap = await f.getDocs(f.query.apply(null, [f.collection(f.db, 'phone_calls')].concat(scopes[i])));
        (snap.docs || []).forEach(function (d) { var c = d.data() || {}; if (c.leadId === leadId && (c.attachedBy || c.movedBy)) calls[d.id] = c; });
      } catch (_) { /* the other scope may still read */ }
    }
    var ids = Object.keys(calls).sort(function (a, b) { return (Number(calls[b].startedAtMs) || 0) - (Number(calls[a].startedAtMs) || 0); }).slice(0, max || 10);
    var out = [];
    for (var j = 0; j < ids.length; j++) {
      try {
        var bs = await f.getDoc(f.doc(f.db, 'leads', leadId, 'call_briefs', ids[j]));
        var exists = typeof bs.exists === 'function' ? bs.exists() : !!bs.exists;
        if (!exists) continue;
        var d = bs.data() || {};
        if (d.brief) out.push({ callId: ids[j], brief: d.brief, decisions: d.decisions || [], generatedAtMs: d.generatedAtMs });
      } catch (_) { /* no brief, or not readable: skip it */ }
    }
    return out;
  }

  return {
    stagePlan: stagePlan, oneTapAllowed: oneTapAllowed, tenantStageOrders: tenantStageOrders, CONFIRM_KEYS: CONFIRM_KEYS, STAGE_ORDER: STAGE_ORDER, APPOINTMENT_RE: APPOINTMENT_RE, WHY: WHY,
    saidVsProposal: saidVsProposal, copyIntoScope: copyIntoScope, loadLeadBriefs: loadLeadBriefs, VOCAB: VOCAB, _proposalText: proposalText,
  };
});
