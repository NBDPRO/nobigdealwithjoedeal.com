/**
 * call-brief-ui.js — the Call Brief review sheet (Call to Close P0, 2026-11-09).
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §4, §5.2.
 *
 * Loaded on the first tap of "Draft from this call" (customer-calls.js on the
 * customer page, call-center-view.js on #/calls), never at boot: no <script>
 * tag anywhere. Its stylesheet (css/call-brief.css) loads with it.
 *
 * The sheet shows what the callBrief callable returned (every fact with the
 * words that were said) and offers one tap per item, each through an
 * existing writer:
 *   1. Summary: editable; "Add to timeline" appends one activity note
 *      (callBriefDecide), after a confirm, because notes cannot be undone.
 *   2. Field diff: current → from the call, quote, said / implied, Accept /
 *      Edit / Skip. Fill-empty only (a filled field says so and offers Skip).
 *      Carrier, claim # and an insurance job type carry the Kentucky
 *      insurance-job warning and confirm first. One field per tap.
 *   3. Promises: a You / Them toggle on each (the model's guess, which Jo
 *      fixes), the kind and the date, and an explicit Add + a one-line
 *      confirm, because a promise marks the call handled (callCenterAction
 *      promise, slot i).
 *   4. Follow-up: only when the call's date differs from the customer's
 *      (NBDFollowUpDeck.setFollowUp, with its undo; followup-deck.js is
 *      lazy-loaded on the customer page).
 *   5. Mark handled (callCenterAction handled).
 *   6. Stage: READ-ONLY in P0. "Suggests: …, because '…'" and a button that
 *      opens the normal place to change it.
 *   7. Draft proposal (P0b): DocPreflight.open('proposal', leadId) with only
 *      the Project Description seeded, and only when the customer has none
 *      (it persists to lead.scopeOfWork). Scope items are never seeded: the
 *      call's scope shows as a "From the call" list to copy in.
 * Nothing is pre-ticked, there is no Apply-all, nothing is sent, priced or
 * signed, and no stage moves. Everything shown is escaped.
 *
 * No inline handlers (CSP script-src-attr 'none'): one delegated listener.
 */
(function () {
  'use strict';
  if (window.NBDCallBrief) return;

  var FUNCTIONS_SDK = '/assets/vendor/firebase/10.12.2/firebase-functions.js';
  var CSS_HREF = '/pro/css/call-brief.css?v=1';
  var FOLLOWUP_JS = '/pro/js/followup-deck.js?v=2';
  var INSURANCE_WARN = 'This makes the job an insurance job. Kentucky notices and the cancellation form will apply.';
  var FIELD_ORDER = ['insCarrier', 'claimNumber', 'dateOfLoss', 'adjusterName', 'adjusterMeetingYmd', 'damageType', 'jobType'];
  var FIELD_LABEL = {
    insCarrier: 'Insurance carrier', claimNumber: 'Claim #', dateOfLoss: 'Date of loss', adjusterName: 'Adjuster',
    adjusterMeetingYmd: 'Adjuster meeting', damageType: 'Damage', jobType: 'Job type',
  };
  // The lead field each brief field fills (= functions/call-brief-logic.js LEAD_FIELD).
  var LEAD_FIELD = {
    insCarrier: 'insCarrier', claimNumber: 'claimNumber', dateOfLoss: 'dateOfLoss', adjusterName: 'adjusterName',
    adjusterMeetingYmd: 'adjusterMeetingDate', damageType: 'damageType', jobType: 'jobType',
  };
  var KIND_LABEL = { callback: 'Call back', estimate: 'Send estimate', text: 'Text', order: 'Order materials', permit: 'Check on permit', waiting: 'Waiting on them' };
  var KINDS = ['callback', 'estimate', 'text', 'order', 'permit', 'waiting'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function blank(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }
  function ymdOf(v) { var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '')); return m ? m[1] : ''; }
  function fmtYmd(v) {
    var y = ymdOf(v);
    if (!y) return '';
    var d = new Date(y + 'T12:00:00');
    return isNaN(d) ? y : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtDur(sec) { var s = Math.max(0, Math.round(Number(sec) || 0)); return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; }
  function leadName(l) { l = l || {}; return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.address || 'Customer'; }
  function uid() { return (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || ''; }

  // ── pure helpers (also what the tests read) ────────────────────────────
  function warnFor(key, value) {
    if (key === 'insCarrier' || key === 'claimNumber') return INSURANCE_WARN;
    if (key === 'jobType' && value === 'insurance') return INSURANCE_WARN;
    return '';
  }
  /** One row per field the brief proposes: current → proposed, never pre-ticked. */
  function fieldRows(brief, lead) {
    var f = (brief && brief.fields) || {};
    var L = lead || {};
    // A field the customer already has with the same value says nothing new.
    var same = function (a, b) { return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase(); };
    return FIELD_ORDER.filter(function (k) { return f[k] && !blank(f[k].value) && !same(L[LEAD_FIELD[k]], f[k].value); }).map(function (k) {
      var current = L[LEAD_FIELD[k]];
      return {
        key: k, label: FIELD_LABEL[k], current: blank(current) ? '' : String(current), proposed: String(f[k].value),
        spoken: f[k].spoken || '', quote: f[k].quote || '', conf: f[k].conf === 'implied' ? 'implied' : 'said',
        warn: blank(current) ? warnFor(k, f[k].value) : '', filled: !blank(current), isDate: k === 'dateOfLoss' || k === 'adjusterMeetingYmd',
      };
    });
  }
  /** The follow-up change, only when the call's date differs from the customer's. */
  function followUpChange(brief, lead) {
    var to = ymdOf(brief && brief.followUp && brief.followUp.value);
    if (!to) return null;
    var from = ymdOf(lead && lead.followUp);
    return to === from ? null : { to: to, from: from, quote: brief.followUp.quote || '' };
  }
  /** "From the call" scope lines (shown, never seeded into a list field). */
  function scopeHints(brief) {
    var s = (brief && brief.scope) || {};
    var out = [];
    if (s.service && s.service.value) out.push(s.service.value);
    var m = s.mentions || {};
    ['gutters', 'chimney', 'skylight', 'decking'].forEach(function (k) { if (m[k] === true) out.push(k.charAt(0).toUpperCase() + k.slice(1) + ' mentioned on the call'); });
    if (s.stories && s.stories.value) out.push(s.stories.value + '-story house (said on the call)');
    if (s.tierInterest && s.tierInterest.value) out.push('Asked about the ' + s.tierInterest.value + ' package');
    (s.saidQuantities || []).forEach(function (q) { out.push('Said: "' + q.quote + '"'); });
    return out;
  }
  /**
   * The Project Description seed: fixed phrases from the brief's choices only
   * (no model prose, no numbers), and '' when the customer already has one.
   */
  function projectSeed(brief, lead) {
    if (!brief || (lead && !blank(lead.scopeOfWork))) return '';
    var f = brief.fields || {};
    var s = brief.scope || {};
    var kind = f.workKind && f.workKind.value;
    var what = kind === 'repair' ? 'Roof repair' : kind === 'replace' ? 'Complete roof replacement' : '';
    if (!what && s.service && s.service.value) what = String(s.service.value).replace(/[\d$]/g, '').trim();
    if (!what) return '';
    var adds = [];
    var m = s.mentions || {};
    if (m.gutters) adds.push('gutters');
    if (m.chimney) adds.push('chimney flashing');
    if (m.skylight) adds.push('skylights');
    if (m.decking) adds.push('decking as needed');
    var dmg = f.damageType && f.damageType.value ? String(f.damageType.value).replace(/[\d$]/g, '').trim() : '';
    var text = what + (dmg ? ' for ' + dmg + ' damage' : '') + (adds.length ? ', including ' + adds.join(', ') : '') + '.';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // ── state ──────────────────────────────────────────────────────────────
  var S = null;  // { callId, call, lead, leadId, page, brief, decisions, loading, error, done:{}, busy:{}, confirm:'', edit:{}, prom:[], fuUndo, onChange }
  var dlg = null;

  function decided(item) {
    var ds = (S && S.decisions) || [];
    for (var i = ds.length - 1; i >= 0; i--) if (ds[i] && ds[i].item === item) return ds[i];
    return null;
  }
  function initPromises() {
    S.prom = ((S.brief && S.brief.promises) || []).map(function (p, i) {
      var d = decided('promise:' + i);
      return { who: p.who === 'them' ? 'them' : 'jo', kind: p.kind, modelKind: p.kind, dueYmd: p.dueYmd || '', done: !!(d && d.decision === 'accept'), skipped: !!(d && d.decision === 'skip') };
    });
  }

  // ── render ─────────────────────────────────────────────────────────────
  function btn(label, act, extra, cls) {
    return '<button type="button" class="btn ' + (cls || 'btn-ghost') + '" data-cb-act="' + esc(act) + '"' + (extra || '') + '>' + esc(label) + '</button>';
  }
  function quoteHtml(q) { return q ? '<blockquote class="cb-quote">&ldquo;' + esc(q) + '&rdquo;</blockquote>' : ''; }
  function statusFor(item) {
    if (S.err && S.err[item]) return '<div class="cb-err" role="alert">' + esc(S.err[item]) + '</div>';
    var d = S.done[item] || decided(item);
    if (!d) return '';
    if (d === 'busy') return '<div class="cb-meta">Saving…</div>';
    return d.decision === 'skip' ? '<div class="cb-skipped">Skipped</div>' : '<div class="cb-done">' + esc(d.label || 'Done') + '</div>';
  }
  function isSettled(item) { var d = S.done[item] || decided(item); return !!(d && d !== 'busy'); }

  function renderHeader() {
    var c = S.call || {};
    var when = c.startedAtMs ? new Date(c.startedAtMs).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    var filer = c.attachedBy || c.movedBy;
    var filed = filer ? (filer === uid() ? 'Filed by you' : 'Filed by a teammate') : '';
    var meta = [filed, when, c.durationSec ? fmtDur(c.durationSec) : ''].filter(Boolean).join(' · ');
    return '<div class="cb-head"><div><h2 class="cb-title" id="cbTitle">From this call: ' + esc(leadName(S.lead)) + '</h2>' +
      '<div class="cb-meta">' + esc(meta) + (c.urgent ? ' <span class="cb-badge is-urgent">Urgent</span>' : '') + '</div></div>' +
      '<button type="button" class="btn btn-ghost cb-close" data-cb-act="close" aria-label="Close">✕</button></div>';
  }

  function renderBanners() {
    var b = S.brief || {};
    var t = b.transcriptOk || {};
    var out = '';
    if (t.reliable === false) out += '<div class="cb-banner is-danger" role="status">Transcript unreliable, listen to the recording. Only the summary is shown' + (t.why ? ': ' + esc(t.why) : '.') + '</div>';
    if (t.cutOff) out += '<div class="cb-banner" role="status">The transcript ends mid-call.</div>';
    if (b.flags && b.flags.injection) out += '<div class="cb-banner" role="status">Part of this call reads like instructions to a computer. Nothing was taken from those words.</div>';
    return out;
  }

  function renderSummary() {
    var sm = (S.brief && S.brief.summary) || {};
    var item = 'summary';
    var settled = isSettled(item);
    var confirming = S.confirm === item;
    return '<div class="cb-sec" role="group" aria-labelledby="cbSumH"><h3 class="cb-sec-title" id="cbSumH">Summary</h3>' +
      '<label class="cb-field-lbl" for="cbSummary">What the call was about' + (sm.inferred ? ' (inferred: no quote backs it)' : '') + '</label>' +
      '<textarea class="cb-text" id="cbSummary" data-cb-input="summary"' + (settled ? ' disabled' : '') + '>' + esc(S.summaryText != null ? S.summaryText : (sm.text || '')) + '</textarea>' +
      ((sm.quotes || []).length ? '<div class="cb-quotes">' + sm.quotes.map(quoteHtml).join('') + '</div>' : '') +
      (settled ? statusFor(item) : confirming
        ? '<div class="cb-warn">Timeline notes cannot be undone. Add this summary to the timeline?</div><div class="cb-acts">' + btn('Add note', 'summary-yes', '', 'btn-orange') + btn('Cancel', 'cancel') + '</div>'
        : '<div class="cb-acts">' + btn('Add to timeline', 'summary') + '</div>' + statusFor(item)) +
      '</div>';
  }

  function renderFields() {
    var rows = fieldRows(S.brief, S.lead);
    if (!rows.length) return '';
    return '<div class="cb-sec" role="group" aria-labelledby="cbFieldH"><h3 class="cb-sec-title" id="cbFieldH">Customer details from the call</h3>' +
      '<div class="cb-meta">Fills empty fields only, one at a time. Nothing is filled until you tap Accept.</div>' +
      rows.map(function (r) {
        var item = 'field:' + r.key;
        var settled = isSettled(item);
        var editing = S.edit[item] != null;
        var shown = r.isDate ? fmtYmd(r.proposed) + (r.spoken ? ' ("' + r.spoken + '")' : '') : r.proposed;
        var acts;
        if (settled) acts = statusFor(item);
        else if (S.confirm === item) {
          acts = '<div class="cb-warn">' + esc(r.warn) + ' Fill it in?</div><div class="cb-acts">' + btn('Yes, fill it in', 'accept-yes', ' data-k="' + esc(r.key) + '"', 'btn-orange') + btn('Cancel', 'cancel') + '</div>';
        } else if (r.filled) {
          acts = '<div class="cb-meta">Already filled in on the customer. Change it on the customer card if it is wrong.</div><div class="cb-acts">' + btn('Skip', 'skip', ' data-k="' + esc(r.key) + '"') + '</div>' + statusFor(item);
        } else if (editing) {
          acts = '<label class="cb-field-lbl" for="cbEdit-' + esc(r.key) + '">Your value</label>' +
            '<input class="cb-input" id="cbEdit-' + esc(r.key) + '" data-cb-input="edit" data-k="' + esc(r.key) + '"' + (r.isDate ? ' type="date"' : ' type="text" maxlength="120"') + ' value="' + esc(S.edit[item]) + '">' +
            '<div class="cb-acts">' + btn('Save', 'edit-save', ' data-k="' + esc(r.key) + '"') + btn('Cancel', 'cancel') + '</div>' + statusFor(item);
        } else {
          acts = '<div class="cb-acts">' + btn('Accept', 'accept', ' data-k="' + esc(r.key) + '"') + btn('Edit', 'edit', ' data-k="' + esc(r.key) + '"') + btn('Skip', 'skip', ' data-k="' + esc(r.key) + '"') + '</div>' + statusFor(item);
        }
        return '<div class="cb-card" data-cb-row="' + esc(item) + '"><div class="cb-row-head"><span class="cb-label">' + esc(r.label) + '</span><span class="cb-badge">' + esc(r.conf) + '</span></div>' +
          '<div class="cb-diff"><span class="cb-now">Now: ' + esc(r.current ? (r.isDate ? fmtYmd(r.current) : r.current) : 'empty') + '</span> → <strong>' + esc(shown) + '</strong></div>' +
          quoteHtml(r.quote) + (r.warn && !settled && S.confirm !== item ? '<div class="cb-warn">' + esc(r.warn) + '</div>' : '') + acts + '</div>';
      }).join('') + '</div>';
  }

  function renderPromises() {
    var ps = (S.brief && S.brief.promises) || [];
    if (!ps.length) return '';
    return '<div class="cb-sec" role="group" aria-labelledby="cbPromH"><h3 class="cb-sec-title" id="cbPromH">Promises on the call</h3>' +
      '<div class="cb-meta">Check who promised it. Adding a promise makes a dated task and marks the call handled. Not handled puts the call back; the task stays until it is done.</div>' +
      ps.map(function (p, i) {
        var st = S.prom[i];
        var item = 'promise:' + i;
        var head = '<div class="cb-row-head"><span class="cb-label">' + esc(p.text) + '</span>' + (p.dueSpoken ? '<span class="cb-meta">' + esc(p.dueSpoken) + '</span>' : '') + '</div>' + quoteHtml(p.quote);
        if (st.done || st.skipped || isSettled(item)) return '<div class="cb-card">' + head + (statusFor(item) || '<div class="cb-done">Added</div>') + '</div>';
        var toggle = '<div class="cb-toggle" role="radiogroup" aria-label="Who promised it">' +
          '<button type="button" role="radio" aria-checked="' + (st.who === 'jo') + '" data-cb-act="who" data-i="' + i + '" data-who="jo">You</button>' +
          '<button type="button" role="radio" aria-checked="' + (st.who === 'them') + '" data-cb-act="who" data-i="' + i + '" data-who="them">Them</button></div>';
        var kinds = KINDS.map(function (k) { return '<option value="' + k + '"' + (k === st.kind ? ' selected' : '') + '>' + esc(KIND_LABEL[k]) + '</option>'; }).join('');
        var fields = '<div class="cb-grid"><label class="cb-field-lbl" for="cbKind-' + i + '">What<select class="cb-select" id="cbKind-' + i + '" data-cb-input="kind" data-i="' + i + '">' + kinds + '</select></label>' +
          '<label class="cb-field-lbl" for="cbDue-' + i + '">' + (st.kind === 'waiting' ? 'Chase on' : 'Due') + '<input class="cb-input" type="date" id="cbDue-' + i + '" data-cb-input="due" data-i="' + i + '" value="' + esc(st.dueYmd) + '"></label></div>';
        var acts = S.confirm === item
          ? '<div class="cb-warn">Add "' + esc(KIND_LABEL[st.kind] || st.kind) + '"' + (st.dueYmd ? ' for ' + esc(fmtYmd(st.dueYmd)) : '') + '? It marks the call handled.</div><div class="cb-acts">' + btn('Add promise', 'promise-yes', ' data-i="' + i + '"', 'btn-orange') + btn('Cancel', 'cancel') + '</div>'
          : '<div class="cb-acts">' + btn('Add', 'promise', ' data-i="' + i + '"') + btn('Skip', 'promise-skip', ' data-i="' + i + '"') + '</div>';
        return '<div class="cb-card" data-cb-row="' + esc(item) + '">' + head + toggle + fields + acts + statusFor(item) + '</div>';
      }).join('') + '</div>';
  }

  function renderFollowUp() {
    var ch = followUpChange(S.brief, S.lead);
    if (!ch && !S.fuUndo) return '';
    var item = 'followUp';
    var body;
    if (S.fuUndo) body = '<div class="cb-done">Follow-up set to ' + esc(fmtYmd(S.fuUndo.to)) + '</div><div class="cb-acts">' + btn('Undo', 'followup-undo') + '</div>';
    else body = '<div class="cb-diff"><span class="cb-now">Now: ' + esc(ch.from ? fmtYmd(ch.from) : 'none') + '</span> → <strong>' + esc(fmtYmd(ch.to)) + '</strong></div>' + quoteHtml(ch.quote) +
      (isSettled(item) ? statusFor(item) : '<div class="cb-acts">' + btn('Change follow-up', 'followup') + '</div>' + statusFor(item));
    return '<div class="cb-sec" role="group" aria-labelledby="cbFuH"><h3 class="cb-sec-title" id="cbFuH">Follow-up</h3><div class="cb-card">' + body + '</div></div>';
  }

  function renderStage() {
    var st = S.brief && S.brief.stage;
    if (!st) return '';
    var act = S.page === 'customer'
      ? btn('Change the stage…', 'stage')
      : '<a class="btn btn-ghost" href="/pro/customer.html?id=' + encodeURIComponent(S.leadId) + '">Open the customer to change it</a>';
    return '<div class="cb-sec" role="group" aria-labelledby="cbStageH"><h3 class="cb-sec-title" id="cbStageH">Stage</h3><div class="cb-card">' +
      '<div class="cb-diff">Suggests: <strong>' + esc(st.label) + '</strong>' + (st.reason ? ', because ' + esc(st.reason.charAt(0).toLowerCase() + st.reason.slice(1).replace(/\.$/, '')) : '') + '</div>' + quoteHtml(st.quote) +
      '<div class="cb-meta">Nothing moves from here. You change the stage yourself.</div><div class="cb-acts">' + act + '</div></div></div>';
  }

  function renderDrafts() {
    var hints = scopeHints(S.brief);
    var seed = projectSeed(S.brief, S.lead);
    var body = S.page === 'customer'
      ? '<div class="cb-meta">Opens the proposal' + (seed ? '. If its project description is empty, it is filled in from this call' : ' with its usual details') + '. You finish it, nothing is sent.</div>' +
        (hints.length ? '<div class="cb-meta">From the call (copy what fits into the scope list):</div><ul class="cb-list">' + hints.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>' : '') +
        '<div class="cb-acts">' + btn('Draft proposal', 'proposal', '', 'btn-orange') + '</div>'
      : '<div class="cb-acts"><a class="btn btn-ghost" href="/pro/customer.html?id=' + encodeURIComponent(S.leadId) + '">Open the customer to draft a proposal</a></div>';
    return '<div class="cb-sec" role="group" aria-labelledby="cbDraftH"><h3 class="cb-sec-title" id="cbDraftH">Drafts</h3><div class="cb-card">' + body + '</div></div>';
  }

  function renderHandled() {
    var c = S.call || {};
    var item = 'handled';
    var body = c.handledAtMs || isSettled(item)
      ? '<div class="cb-done">This call is marked handled.</div>'
      : '<div class="cb-acts">' + btn('Mark handled', 'handled') + '</div><div class="cb-meta">Takes the call off "needs you". Not handled on the call card puts it back.</div>' + statusFor(item);
    return '<div class="cb-sec" role="group" aria-labelledby="cbHandH"><h3 class="cb-sec-title" id="cbHandH">This call</h3><div class="cb-card">' + body + '</div></div>';
  }

  function render() {
    if (!dlg || !S) return;
    var body;
    if (S.loading) body = '<div class="cb-loading" role="status">Reading the call… Notes arrive 30-60 minutes after the call.</div>';
    else if (S.error) body = '<div class="cb-banner is-danger" role="alert">' + esc(S.error) + '</div>';
    else body = renderBanners() + renderSummary() + renderFields() + renderPromises() + renderFollowUp() + renderHandled() + renderStage() + renderDrafts();
    dlg.innerHTML = renderHeader() + '<div class="cb-scroll">' + body + '</div>' +
      '<div class="cb-foot"><span class="cb-meta">Nothing here is sent, priced or signed.</span>' + btn('Close', 'close') + '</div>';
  }

  // ── server calls ───────────────────────────────────────────────────────
  async function callable(name, data) {
    if (!window._functions || !window._httpsCallable) {
      var mod = await import(FUNCTIONS_SDK);
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    var res = await window._httpsCallable(window._functions, name)(data);
    return res && res.data;
  }
  function errText(e) { return (e && e.message ? String(e.message).replace(/^FirebaseError:\s*/, '') : '') || 'That did not work. Try again.'; }
  async function decide(item, decision, extra) {
    return callable('callBriefDecide', Object.assign({ callId: S.callId, item: item, decision: decision }, extra || {}));
  }
  function mark(item, decision, label) { S.done[item] = { decision: decision, label: label }; if (S.err) delete S.err[item]; }
  function fail(item, e) { delete S.done[item]; S.err = S.err || {}; S.err[item] = errText(e); }
  function changed() { if (S && typeof S.onChange === 'function') { try { S.onChange(); } catch (_) { /* the card reloads itself */ } } }

  async function acceptField(key, value, confirmed) {
    var item = 'field:' + key;
    S.done[item] = 'busy'; S.confirm = ''; render();
    try {
      var extra = { confirmedInsurance: confirmed === true };
      if (value != null) extra.value = value;
      await decide(item, 'accept', extra);
      var row = fieldRows(S.brief, S.lead).filter(function (r) { return r.key === key; })[0];
      var final = value != null ? value : row && row.proposed;
      if (S.lead) S.lead[LEAD_FIELD[key]] = final;
      mark(item, 'accept', 'Filled in');
      delete S.edit[item];
      changed();
    } catch (e) { fail(item, e); }
    render();
  }

  async function onAct(b) {
    var a = b.getAttribute('data-cb-act');
    var k = b.getAttribute('data-k');
    var i = Number(b.getAttribute('data-i'));
    if (a === 'close') { close(); return; }
    if (a === 'cancel') { S.confirm = ''; Object.keys(S.edit).forEach(function (x) { delete S.edit[x]; }); render(); return; }
    if (a === 'summary') { S.confirm = 'summary'; render(); return; }
    if (a === 'summary-yes') {
      var text = S.summaryText != null ? S.summaryText : ((S.brief.summary || {}).text || '');
      S.done.summary = 'busy'; S.confirm = ''; render();
      try { await decide('summary', 'accept', { value: text }); mark('summary', 'accept', 'Added to the timeline'); changed(); } catch (e) { fail('summary', e); }
      render(); return;
    }
    if (a === 'accept') {
      var r = fieldRows(S.brief, S.lead).filter(function (x) { return x.key === k; })[0];
      if (!r) return;
      if (r.warn) { S.confirm = 'field:' + k; render(); return; }
      acceptField(k, null, false); return;
    }
    if (a === 'accept-yes') { acceptField(k, S.edit['field:' + k] != null ? S.edit['field:' + k] : null, true); return; }
    if (a === 'edit') {
      var er = fieldRows(S.brief, S.lead).filter(function (x) { return x.key === k; })[0];
      S.edit['field:' + k] = er ? er.proposed : ''; render();
      var inp = dlg.querySelector('#cbEdit-' + k); if (inp) inp.focus();
      return;
    }
    if (a === 'edit-save') {
      var v = String(S.edit['field:' + k] || '').trim();
      if (!v) return;
      var wr = warnFor(k, v);
      if (wr) { S.confirm = 'field:' + k; render(); return; }
      acceptField(k, v, false); return;
    }
    if (a === 'skip') {
      var it = 'field:' + k;
      S.done[it] = 'busy'; render();
      try { await decide(it, 'skip'); mark(it, 'skip'); } catch (e) { fail(it, e); }
      render(); return;
    }
    if (a === 'who') {
      var st = S.prom[i]; if (!st) return;
      st.who = b.getAttribute('data-who') === 'them' ? 'them' : 'jo';
      st.kind = st.who === 'them' ? 'waiting' : (st.modelKind && st.modelKind !== 'waiting' ? st.modelKind : 'callback');
      render(); return;
    }
    if (a === 'promise') { S.confirm = 'promise:' + i; render(); return; }
    if (a === 'promise-skip') {
      S.done['promise:' + i] = 'busy'; render();
      try { await decide('promise:' + i, 'skip'); S.prom[i].skipped = true; mark('promise:' + i, 'skip'); } catch (e) { fail('promise:' + i, e); }
      render(); return;
    }
    if (a === 'promise-yes') {
      var ps = S.prom[i], p = S.brief.promises[i];
      var item = 'promise:' + i;
      S.done[item] = 'busy'; S.confirm = ''; render();
      try {
        var data = { id: S.callId, action: 'promise', kind: ps.kind, why: p.text, slot: i };
        if (ps.dueYmd) data.dueYmd = ps.dueYmd;
        if (ps.kind === 'waiting') data.waitingOn = 'customer';
        var res = await callable('callCenterAction', data);
        ps.done = true;
        mark(item, 'accept', 'Added' + (res && res.dueDate ? ', due ' + fmtYmd(res.dueDate) : ''));
        if (S.call) S.call.handledAtMs = Date.now();
        decide(item, 'accept', { value: ps.who + ' ' + ps.kind + ' ' + (ps.dueYmd || '') }).catch(function () { /* the promise itself is saved */ });
        changed();
      } catch (e) { fail(item, e); }
      render(); return;
    }
    if (a === 'followup' || a === 'followup-undo') { followUp(a === 'followup-undo'); return; }
    if (a === 'handled') {
      S.done.handled = 'busy'; render();
      try {
        await callable('callCenterAction', { id: S.callId, action: 'handled' });
        if (S.call) S.call.handledAtMs = Date.now();
        mark('handled', 'accept', 'Marked handled');
        decide('handled', 'accept').catch(function () {});
        changed();
      } catch (e) { fail('handled', e); }
      render(); return;
    }
    if (a === 'stage') {
      decide('stage', 'skip', { value: 'opened the stage picker' }).catch(function () {});
      close();
      var edit = document.querySelector('[data-action="openEditCustomerModal"]');
      if (edit) edit.click();
      return;
    }
    if (a === 'proposal') { draftProposal(); return; }
  }

  async function followUp(undo) {
    var item = 'followUp';
    try {
      if (undo) {
        if (S.fuUndo && S.fuUndo.undo) await S.fuUndo.undo();
        S.fuUndo = null; delete S.done[item]; render(); changed(); return;
      }
      var ch = followUpChange(S.brief, S.lead);
      if (!ch) return;
      S.done[item] = 'busy'; render();
      if (!window.NBDFollowUpDeck && window.ScriptLoader && typeof window.ScriptLoader.load === 'function') await window.ScriptLoader.load(FOLLOWUP_JS);
      if (!window.NBDFollowUpDeck) throw new Error('Could not load the follow-up tools. Try again in a moment.');
      var lead = { id: S.leadId, followUp: S.lead ? S.lead.followUp : '' };
      var r = await window.NBDFollowUpDeck.setFollowUp(lead, ch.to);
      if (S.lead) S.lead.followUp = ch.to;
      S.fuUndo = { to: ch.to, undo: async function () { await r.undo(); if (S && S.lead) S.lead.followUp = lead.followUp; } };
      delete S.done[item];
      decide(item, 'accept', { value: ch.to }).catch(function () {});
      changed();
    } catch (e) { fail(item, e); }
    render();
  }

  async function draftProposal() {
    var brief = S.brief, lead = S.lead, leadId = S.leadId;
    var seed = projectSeed(brief, lead);
    var hints = scopeHints(brief);
    decide('draft:proposal', 'accept', { value: seed }).catch(function () {});
    close();
    try {
      if (!window.DocPreflight && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') await window.ScriptLoader.loadBundle('docgen');
    } catch (_) { /* reported below */ }
    if (!window.DocPreflight || typeof window.DocPreflight.open !== 'function') {
      if (typeof window.showToast === 'function') window.showToast('Could not open the proposal. Try again in a moment.', 'error');
      return;
    }
    window.DocPreflight.open('proposal', leadId);
    // Seed only the Project Description (persist: LEAD → lead.scopeOfWork on
    // Generate), only when it is empty. Scope items are never seeded (they
    // persist to docOverrides); the call's scope is shown beside them.
    var tries = 0;
    (function seedWhenReady() {
      var ta = document.querySelector('[data-field="projectDescription"]');
      if (!ta) { if (++tries < 40) setTimeout(seedWhenReady, 100); return; }
      if (seed && !String(ta.value || '').trim()) {
        ta.value = seed;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var wrap = document.querySelector('[data-field-wrap="scopeItems"]');
      if (wrap && hints.length && !wrap.querySelector('.cb-from-call')) {
        var box = document.createElement('div');
        box.className = 'cb-from-call';
        box.innerHTML = '<strong>From the call</strong> (copy what fits):<ul class="cb-list">' + hints.map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('') + '</ul>';
        wrap.appendChild(box);
      }
    })();
  }

  // ── open / close ───────────────────────────────────────────────────────
  function ensureDialog() {
    if (window.ScriptLoader && typeof window.ScriptLoader.load === 'function') window.ScriptLoader.load(CSS_HREF);
    if (dlg && document.body.contains(dlg)) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'cb-sheet';
    dlg.setAttribute('aria-labelledby', 'cbTitle');
    dlg.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-cb-act]') : null;
      if (b && dlg.contains(b) && !b.disabled) { onAct(b); return; }
      if (e.target === dlg) close();   // a tap on the backdrop
    });
    dlg.addEventListener('input', onInput);
    dlg.addEventListener('change', onInput);
    dlg.addEventListener('close', function () { S = null; });
    document.body.appendChild(dlg);
    return dlg;
  }
  function onInput(e) {
    var t = e.target; if (!t || !S) return;
    var kind = t.getAttribute('data-cb-input');
    var i = Number(t.getAttribute('data-i'));
    if (kind === 'summary') S.summaryText = t.value;
    else if (kind === 'edit') S.edit['field:' + t.getAttribute('data-k')] = t.value;
    else if (kind === 'due' && S.prom[i]) S.prom[i].dueYmd = t.value;
    else if (kind === 'kind' && S.prom[i] && KINDS.indexOf(t.value) !== -1) {
      S.prom[i].kind = t.value;
      if (e.type === 'change') render();
    }
  }
  function show() {
    ensureDialog();
    render();
    if (!dlg.open) { if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', ''); }
  }
  function close() { if (dlg && dlg.open) { try { dlg.close(); } catch (_) { dlg.removeAttribute('open'); } } S = null; }

  /**
   * Open the sheet for one call. o: { callId, call, lead, leadId, page:
   * 'customer'|'calls', onChange }. Asks callBrief, then shows the answer.
   */
  async function open(o) {
    var x = o || {};
    if (!x.callId) return;
    S = { callId: x.callId, call: Object.assign({}, x.call || {}), lead: Object.assign({}, x.lead || {}), leadId: x.leadId || (x.call && x.call.leadId) || '',
      page: x.page === 'customer' ? 'customer' : 'calls', loading: true, error: '', done: {}, err: {}, edit: {}, confirm: '', prom: [], decisions: [], onChange: x.onChange };
    var mine = S;
    show();
    try {
      var r = await callable('callBrief', { callId: x.callId });
      if (S !== mine) return;
      S.brief = r && r.brief; S.decisions = (r && r.decisions) || []; S.loading = false;
      if (!S.brief) S.error = 'The brief did not come back. Try again in a minute.';
      else initPromises();
    } catch (e) {
      if (S !== mine) return;
      S.loading = false; S.error = errText(e);
    }
    render();
  }

  /** Show a brief already in hand (no server call): the screenshot walk and the tests. */
  function showWith(o) {
    var x = o || {};
    S = { callId: x.callId || 'cube_PREVIEW', call: x.call || {}, lead: x.lead || {}, leadId: x.leadId || '', page: x.page === 'customer' ? 'customer' : 'calls',
      loading: false, error: '', done: {}, err: {}, edit: {}, confirm: '', prom: [], decisions: x.decisions || [], brief: x.brief, onChange: null };
    initPromises();
    show();
    return dlg;
  }

  window.NBDCallBrief = {
    open: open, close: close, _showWith: showWith,
    _fieldRows: fieldRows, _followUpChange: followUpChange, _projectSeed: projectSeed, _scopeHints: scopeHints, _warnFor: warnFor,
    _render: function () { render(); return dlg ? dlg.innerHTML : ''; },
    INSURANCE_WARN: INSURANCE_WARN,
  };
})();
