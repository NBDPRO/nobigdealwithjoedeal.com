/**
 * thursday-handled.js — "let Thursday handle this number", the Today recap
 * row, and the block list (2026-10-12). Lazy: contact-labels.js loads it only
 * once the `thursdayLabelPlaybooks` feature flag is on, so a flag-off session
 * never runs any of this.
 *
 *   NBDThursdayHandled.enabled()          the flag
 *   NBDThursdayHandled.load(force)        handled settings + Thursday's recent calls (60 s memo)
 *   NBDThursdayHandled.isHandled(digits)  Jo handed this number to Thursday
 *   NBDThursdayHandled.isBlocked(digits)  label kind spam / policy hide
 *   NBDThursdayHandled.todayHtml()        the Thursday section for Today ('' when nothing)
 *   NBDThursdayHandled.sheetHtml(digits)  the toggle inside the Label sheet
 *   NBDThursdayHandled.panelHtml(filter)  Call Center 'thandled' / 'blocklist' panels
 *
 * Storage: companies/{tenant}/thursday_handled/{digits10} (the doc's existence
 * is the setting). Owner / company_admin / manager write, viewer reads, a
 * sales_rep neither reads nor writes (firestore.rules).
 *
 * Honest limit, said in the UI: the CRM cannot change carrier forwarding, so
 * handing a number to Thursday changes what she is told and what Today shows;
 * the phone still has to forward that number's calls to her. Nothing here ever
 * sends, blocks at the carrier, or contacts anyone. Strict CSP: classes and
 * delegated listeners only. Pure rules: thursday-handled-logic.js.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDThursdayHandled) return;
  var w = window, doc = document;
  var LG = w.NBDThursdayHandledLogic;
  if (!LG) return;

  var FLAG = 'thursdayLabelPlaybooks';
  var FUNCTIONS_SDK = '/assets/vendor/firebase/10.12.2/firebase-functions.js';
  var TTL = 60 * 1000;
  var CALL_LIMIT = 40;
  var state = { handled: {}, calls: [], loaded: false, at: 0, busy: null, gone: {}, open: false };

  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || null; }
  function role() { return claims().role || ''; }
  function tenant() { return claims().companyId || uid() || null; }
  function canRead() { return !!(uid() && role() !== 'sales_rep'); }
  function canWrite() { return !!(uid() && role() !== 'viewer' && role() !== 'sales_rep'); }
  function enabled() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function changed() { try { w.dispatchEvent(new CustomEvent('nbd:thursday-handled-changed')); } catch (_) { /* old browser */ } }
  function labels() { return w.NBDContactLabels ? w.NBDContactLabels.current() : {}; }
  function labelFor(d) { return w.NBDContactLabels ? w.NBDContactLabels.get(d) : null; }
  function colRef() { return w.collection(w.db, 'companies', tenant(), 'thursday_handled'); }

  async function callable(name, data) {
    if (!w._functions || !w._httpsCallable) {
      var mod = await import(FUNCTIONS_SDK);
      w._functions = mod.getFunctions();
      w._httpsCallable = mod.httpsCallable;
    }
    var res = await w._httpsCallable(w._functions, name)(data);
    return res && res.data;
  }

  // ── data ─────────────────────────────────────────────────────────────
  // Same two-scope shape widgets.js uses for thursday_calls (the rules need it).
  async function fetchCalls() {
    var db = w.db, id = uid();
    if (!db || !id || !w.query) return [];
    var col = w.collection(db, 'thursday_calls');
    var qs = [w.query(col, w.where('userId', '==', id), w.orderBy('startedAt', 'desc'), w.limit(CALL_LIMIT))];
    var c = claims();
    if (['company_admin', 'manager', 'viewer'].indexOf(c.role || '') !== -1 && c.companyId) {
      qs.push(w.query(col, w.where('companyId', '==', c.companyId), w.orderBy('startedAt', 'desc'), w.limit(CALL_LIMIT)));
    }
    var byId = {};
    for (var i = 0; i < qs.length; i++) {
      try {
        var snap = await w.getDocs(qs[i]);
        snap.docs.forEach(function (d) { byId[d.id] = Object.assign({}, d.data(), { _id: d.id }); });
      } catch (e) { console.warn('[thursday-handled] calls read failed', e && e.code); }
    }
    return Object.keys(byId).map(function (k) { return byId[k]; });
  }

  async function load(force) {
    if (!enabled() || !canRead() || !w.db || !w.getDocs || !w.collection) return state;
    if (!force && state.loaded && Date.now() - state.at < TTL) return state;
    if (state.busy) return state.busy;
    state.busy = (async function () {
      try {
        var got = await Promise.all([
          w.getDocs(colRef()).then(function (s) { return LG.indexHandled(s.docs.map(function (d) { return { id: d.id, data: d.data() }; })); },
            function (e) { console.warn('[thursday-handled] settings read failed', e && e.code); return state.handled; }),
          fetchCalls(),
        ]);
        state.handled = got[0]; state.calls = got[1]; state.loaded = true;
      } catch (e) {
        console.warn('[thursday-handled] load failed', e && e.code);
      } finally { state.at = Date.now(); state.busy = null; }
      changed();
      return state;
    })();
    return state.busy;
  }

  function isHandled(digits) { return !!LG.lookup(state.handled, digits); }
  function isBlocked(digits) {
    var l = labelFor(LG.digits10(digits));
    return !!(l && l.kind === 'spam' && LG.policyOf(l) === 'hide');
  }

  // ── writes: optimistic, honest rollback ──────────────────────────────
  async function setHandled(digits, on) {
    if (!canWrite()) { toast("Your role can't change this.", 'info'); return false; }
    var d = LG.digits10(digits);
    if (!d) return false;
    var prev = state.handled[d] || null;
    if (on) {
      var chk = LG.checkTarget(d, { label: labelFor(d) });
      if (!chk.ok) { toast(chk.reason, 'info'); return false; }
      var docu = LG.buildDoc({ digits: d, companyId: tenant(), uid: uid(), createdAtMs: prev && prev.createdAtMs });
      if (!docu) return false;
      state.handled[d] = LG.indexHandled([{ id: d, data: docu }])[d];
    } else {
      delete state.handled[d];
    }
    changed();
    try {
      var ref = w.doc(w.db, 'companies', tenant(), 'thursday_handled', d);
      if (on) {
        // The rules freeze createdAtMs: when this tab did not know the doc (a stale
        // 60 s memo, a second device), keep the stored one instead of "now".
        var created = prev && prev.createdAtMs;
        if (!created && typeof w.getDoc === 'function') {
          try { var sn = await w.getDoc(ref); if (sn && sn.exists()) created = Number((sn.data() || {}).createdAtMs) || 0; } catch (_) { /* create path */ }
        }
        await w.setDoc(ref, LG.buildDoc({ digits: d, companyId: tenant(), uid: uid(), createdAtMs: created }));
      } else await w.deleteDoc(ref);
      return true;
    } catch (e) {
      if (prev) state.handled[d] = prev; else delete state.handled[d];
      changed();
      console.warn('[thursday-handled] write failed', e && e.code);
      toast("Couldn't save that - check your connection and tap it again", 'error');
      return false;
    }
  }

  async function markReviewed(callId) {
    if (!canWrite() || !callId) return false;
    state.gone[callId] = true; changed();
    try {
      await callable('thursdayCallAction', { callId: callId, action: 'mark_reviewed' });
      return true;
    } catch (e) {
      delete state.gone[callId]; changed();
      console.warn('[thursday-handled] review failed', e && e.code);
      toast("Couldn't mark that reviewed - tap it again", 'error');
      return false;
    }
  }

  // ── view model ───────────────────────────────────────────────────────
  function visibleCalls() {
    return state.calls.filter(function (c) { return !state.gone[c.callId || c._id]; });
  }
  function model() { return LG.summarize(visibleCalls(), labels(), state.handled, Date.now()); }

  function chip(row) {
    if (!row.labelKind) return '';
    var LGL = w.NBDContactLabelsLogic;
    var name = LGL && LGL.KIND_LABEL ? LGL.KIND_LABEL[row.labelKind] : row.labelKind;
    return '<span class="cl-chip" title="Thursday ran the ' + esc(LG.PLAYBOOK_LABEL[row.playbook] || '') + ' playbook">🏷 ' + esc(name) + '</span>';
  }
  function btn(act, key, label, extra) {
    return '<button type="button" class="tp-btn' + (extra ? ' ' + extra : '') + '" data-th-act="' + act + '" data-th-key="' + esc(key) + '">' + label + '</button>';
  }
  function telLink(d) { return d ? '<a class="tp-btn" href="tel:+1' + esc(d) + '">Call</a>' : ''; }
  function openLink(leadId) { return leadId ? '<a class="tp-btn" href="/pro/customer.html?id=' + encodeURIComponent(leadId) + '">Open</a>' : ''; }
  function itemRow(r, ro) {
    var sub = [r.urgent ? '<b class="tp-hot">urgent</b>' : '', r.reason !== 'new call' && !r.urgent ? esc(r.reason) : '', esc(r.summary), chip(r)].filter(Boolean).join(' · ');
    return '<div class="tp-row" data-th-row="' + esc(r.id) + '"><div class="tp-main"><div class="tp-name">' + esc(r.who) + '</div>' +
      '<div class="tp-sub">Thursday took it · ' + sub + '</div></div><div class="tp-acts">' +
      telLink(r.digits) + openLink(r.leadId) + (ro ? '' : btn('reviewed', r.id, '✓ Reviewed', 'tp-go')) + '</div></div>';
  }
  function recapRow(r, ro) {
    var why = r.score >= 25 && r.why.length ? '<b class="tp-hot">' + esc(r.why[0]) + '</b>' : '';
    var sub = [why, esc(r.summary), chip(r)].filter(Boolean).join(' · ');
    return '<div class="tp-row th-recap-row" data-th-row="' + esc(r.id) + '"><div class="tp-main"><div class="tp-name">' + esc(r.who) + '</div>' +
      '<div class="tp-sub">' + sub + '</div></div><div class="tp-acts">' +
      telLink(r.digits) + openLink(r.leadId) + (ro ? '' : btn('reviewed', r.id, '✓ Reviewed', 'tp-go') + btn('reclaim', r.digits, 'Take back')) + '</div></div>';
  }

  /** The Thursday section for Today. '' when the feature is off or there is nothing to say. */
  function todayHtml() {
    if (!enabled() || !canRead()) return '';
    if (!state.loaded) { load(false); return ''; }
    var m = model();
    var ro = !canWrite();
    var out = '';
    if (m.items.length) {
      out += '<div class="tp-sec" data-tp-sec="thursday"><div class="tp-sec-hd"><span class="tp-sec-title">Thursday took a call <span class="tp-count">' +
        m.items.length + '</span></span></div>' + m.items.map(function (r) { return itemRow(r, ro); }).join('') + '</div>';
    }
    if (m.recap.count) {
      var shown = state.open ? m.recap.rows : m.recap.top;
      var more = m.recap.count > shown.length ? btn('more', 'recap', 'Show all ' + m.recap.count) : '';
      var all = !ro ? btn('allreviewed', 'recap', '✓ Mark all reviewed') : '';
      out += '<div class="tp-sec th-recap" data-tp-sec="thursday-recap"><div class="tp-sec-hd"><span class="tp-sec-title">Thursday handled ' +
        m.recap.count + (m.recap.count === 1 ? ' call' : ' calls') + ' <span class="tp-count">' + m.recap.count + '</span></span></div>' +
        '<div class="tp-sub th-recap-note">From numbers you handed her or marked quiet. The ones she was least sure about are on top.</div>' +
        shown.map(function (r) { return recapRow(r, ro); }).join('') + more + all + '</div>';
    }
    var n = Object.keys(state.handled).length;
    if (n || m.ledgerCount) {
      out += '<div class="tp-sub th-foot">' + (n ? n + (n === 1 ? ' number' : ' numbers') + ' handled by Thursday · <button type="button" class="tp-more tp-hd-btn" data-th-act="goto" data-th-key="thandled">See the list</button>' : '') +
        (m.ledgerCount ? (n ? ' · ' : '') + m.ledgerCount + ' spam / hang-up' + (m.ledgerCount === 1 ? '' : 's') + ' logged quietly' : '') + '</div>';
    }
    return out;
  }

  /** The toggle row inside the Label sheet. */
  function sheetHtml(digits) {
    if (!enabled() || !canWrite()) return '';
    var d = LG.digits10(digits);
    if (!d) return '';
    var l = labelFor(d);
    if (l && l.kind === 'spam') return '';
    var on = isHandled(d);
    return '<div class="cl-sec">Thursday</div><div class="th-sheet">' +
      '<button type="button" class="cl-pol' + (on ? ' is-on' : '') + '" data-th-act="toggle" data-th-key="' + esc(d) + '" aria-pressed="' + on + '">' +
      (on ? 'Thursday handles this number ✓' : 'Let Thursday handle this number') + '</button>' +
      '<div class="cl-note">She takes the message and her summary lands on Today (never silent). Your phone still has to forward this number’s calls to her; the CRM cannot change that. You can take it back any time.</div></div>';
  }

  function numberRow(r, ro, kind) {
    var lab = labelFor(r.digits);
    var name = (lab && lab.name) || r.name || '';
    var acts = ro ? '' : (kind === 'block' ? btn('unblock', r.digits, 'Not spam') : btn('reclaim', r.digits, 'Take back'));
    return '<div class="tp-row" data-th-row="' + esc(r.digits) + '"><div class="tp-main"><div class="tp-name">' + esc(LG.fmtPhone(r.digits)) +
      (name ? ' <span class="tp-dim">- ' + esc(name) + '</span>' : '') + '</div></div><div class="tp-acts">' + acts + '</div></div>';
  }

  /** Call Center panels for the 'thandled' and 'blocklist' filters. */
  function panelHtml(filter) {
    if (!enabled() || !canRead()) return '';
    var ro = !canWrite();
    if (!state.loaded) { load(false); return '<div class="cc-empty">Loading…</div>'; }
    if (filter === 'thandled') {
      var hs = Object.keys(state.handled).map(function (k) { return state.handled[k]; }).sort(function (a, b) { return b.updatedAtMs - a.updatedAtMs; });
      return '<div class="th-panel"><div class="th-panel-hd">Numbers Thursday handles (' + hs.length + ')</div>' +
        '<div class="cl-note">You handed these to her. Each call lands on Today as a summary, with the ones she was least sure about first. Add a number from its Label sheet.</div>' +
        (hs.length ? hs.map(function (r) { return numberRow(r, ro, 'handled'); }).join('') : '<div class="cc-empty">No numbers handed to Thursday yet.</div>') + '</div>';
    }
    if (filter === 'blocklist') {
      var list = LG.blockList(labels());
      return '<div class="th-panel"><div class="th-panel-hd">Block on your phone (' + list.length + ')</div>' +
        '<div class="cl-note">These numbers are labeled spam, so the CRM keeps them off Today. The CRM cannot block a call for you: copy the list and add them in your phone’s blocked numbers (Phone app, the number, Block this caller).</div>' +
        (list.length ? '<button type="button" class="tp-btn tp-go" data-th-act="copy" data-th-key="block">Copy list</button>' : '') +
        (list.length ? list.map(function (r) { return numberRow(r, ro, 'block'); }).join('') : '<div class="cc-empty">No spam numbers yet. Label a number Spam from Today or a call card.</div>') + '</div>';
    }
    return '';
  }

  // ── actions ──────────────────────────────────────────────────────────
  async function copyBlockList() {
    var text = LG.blockListText(LG.blockList(labels()));
    if (!text) return;
    try {
      await w.navigator.clipboard.writeText(text);
      toast('Copied ' + text.split('\n').length + ' numbers', 'ok');
    } catch (_) { toast("Couldn't copy - long-press the numbers instead", 'error'); }
  }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-th-act]') : null;
    if (!t) return;
    var a = t.getAttribute('data-th-act'), key = t.getAttribute('data-th-key') || '';
    // Number-keyed actions only ever act on a real 10-digit number, whatever markup carried the attribute.
    if (a === 'toggle' || a === 'reclaim' || a === 'unblock') { key = LG.digits10(key); if (!key) return; }
    if (a === 'goto') { if (typeof w.goTo === 'function') w.goTo('calls'); setTimeout(function () { try { w.NBDCallCenter && w.NBDCallCenter.setFilter && w.NBDCallCenter.setFilter(key); } catch (_) { /* optional */ } }, 50); return; }
    if (a === 'more') { state.open = true; changed(); return; }
    if (a === 'copy') { copyBlockList(); return; }
    if (a === 'reviewed') { markReviewed(key); return; }
    if (a === 'allreviewed') {
      model().recap.rows.forEach(function (r) { markReviewed(r.id); });
      return;
    }
    if (a === 'toggle') {
      var on = !isHandled(key);
      setHandled(key, on).then(function (ok) {
        if (ok) toast(on ? 'Thursday will handle this number. Check Today for her summaries.' : 'Taken back.', 'ok');
        // Repaint just the button in an open Label sheet (attributes + textContent only).
        var b = t.isConnected ? t : null;
        if (b) {
          var now = isHandled(key);
          b.classList.toggle('is-on', now);
          b.setAttribute('aria-pressed', String(now));
          b.textContent = now ? 'Thursday handles this number ✓' : 'Let Thursday handle this number';
        }
      });
      return;
    }
    if (a === 'reclaim') {
      setHandled(key, false).then(function (ok) { if (ok) toast('Taken back. Calls from this number surface the normal way.', 'ok'); });
      return;
    }
    if (a === 'unblock') {
      if (w.NBDContactLabels && w.NBDContactLabels.clear) {
        w.NBDContactLabels.clear(key).then(function (r) { if (r && r.ok) { toast('Label removed - calls from it surface again', 'ok'); changed(); } });
      }
    }
  });

  w.addEventListener('nbd:labels-changed', function () { /* views read labels live */ });

  w.NBDThursdayHandled = {
    enabled: enabled, load: load, isHandled: isHandled, isBlocked: isBlocked, todayHtml: todayHtml,
    sheetHtml: sheetHtml, panelHtml: panelHtml, setHandled: setHandled, markReviewed: markReviewed,
    _state: state,
  };
  // The files arrive after the first Today paint: ask for a repaint once data is in.
  load(false);
})();
