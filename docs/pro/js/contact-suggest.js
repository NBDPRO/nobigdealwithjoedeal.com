/**
 * contact-suggest.js — label suggestions: data + chips (phase 2b, 2026-10-12).
 * Lazy bundle 'contactlabels'. Pure ranking: contact-suggest-logic.js.
 *
 *   NBDContactSuggest.load(force)         read dismissals + Thursday's callers
 *   NBDContactSuggest.forToday()          [≤3 suggestions] for the Today strip
 *   NBDContactSuggest.forNumber(d, rows)  the one suggestion for a card
 *   NBDContactSuggest.chipHtml(s)         the Accept / Not this row
 *
 * One tap Accept applies a kind that does not hide (with the usual undo bar).
 * A kind that hides (personal, spam) and the "calling a lot" pattern open the
 * Label sheet instead — two taps, never an auto-apply. "Not this" is a
 * remembered per-number dismiss in companies/{tenant}/contact_suggestions.
 * Reads that fail leave fewer suggestions, never an error on screen.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDContactSuggest) return;
  var w = window, doc = document;
  var LG = w.NBDContactLabelsLogic, SG = w.NBDContactSuggestLogic;
  if (!LG || !SG) return;
  var TTL = 5 * 60 * 1000;
  var st = { dismissals: {}, thursday: [], loaded: false, at: 0, busy: null };

  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || null; }
  function role() { return claims().role || ''; }
  function tenant() { return claims().companyId || uid() || null; }
  function canSuggest() { return !!(uid() && w.NBDContactLabels && w.NBDContactLabels.canWrite()); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtPhone(d) { return d && d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (d || ''); }
  function changed() { try { w.dispatchEvent(new CustomEvent('nbd:suggestions-changed')); } catch (_) { /* old browser */ } }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }

  async function load(force) {
    if (!canSuggest() || !w.db || !w.getDocs || !w.collection) return;
    if (!force && st.loaded && Date.now() - st.at < TTL) return;
    if (st.busy) return st.busy;
    st.busy = (async function () {
      st.at = Date.now();
      try {
        var snap = await w.getDocs(w.collection(w.db, 'companies', tenant(), 'contact_suggestions'));
        var next = {};
        snap.docs.forEach(function (d) { var x = d.data() || {}; if (/^\d{10}$/.test(d.id)) next[d.id] = { dismissed: Array.isArray(x.dismissed) ? x.dismissed : [] }; });
        st.dismissals = next;
      } catch (e) { console.warn('[suggest] dismissals read failed', e && e.code); }
      try {
        if (w.query && w.where && w.limit) {
          var ts = await w.getDocs(w.query(w.collection(w.db, 'thursday_calls'), w.where('userId', '==', uid()), w.limit(150)));
          st.thursday = ts.docs.map(function (d) { var x = d.data() || {}; return { from: x.from, callerType: x.callerType }; });
        }
      } catch (e) { console.warn('[suggest] thursday read failed', e && e.code); }
      st.loaded = true; st.busy = null;
      changed();
    })();
    return st.busy;
  }

  function leadFor(d) {
    var hits = (w._leads || []).filter(function (l) {
      return l && l.id && !l.deleted && [l.phoneDigits, l.phone, l.phone2, l.altPhone, l.mobilePhone, l.secondaryPhone].some(function (p) { return LG.digits10(p) === d; });
    });
    if (!hits.length || hits.length >= 3) return null;       // 3+ = a proxy line
    var l = hits[0];
    return { leadName: ((l.firstName || '') + ' ' + (l.lastName || '')).trim() };
  }
  function ctx() {
    return { labels: w.NBDContactLabels ? w.NBDContactLabels.current() : {}, dismissals: st.dismissals, thursday: st.thursday, leadFor: leadFor, now: Date.now() };
  }
  function recentRows() {
    var HA = w.NBDHomeAttention;
    return HA && Array.isArray(HA.lastRows) ? HA.lastRows : [];
  }

  /**
   * Numbers Jo labeled (hidden / quiet / not recorded) that have since become
   * a customer — one entry per person, newest first, never auto-changed
   * (audit C-4, 2026-10-13). type 'reconcile' so chipHtml draws it.
   */
  function reconcileRows() {
    if (!canSuggest() || !w.NBDContactLabels) return [];
    var own = [];
    try { own = (w._companyProfile && [w._companyProfile.phone, w._companyProfile.twilioNumber]) || []; } catch (_) { own = []; }
    return LG.reconcile(w.NBDContactLabels.current(), w._leads || [], { now: Date.now(), ownDigits: own }).map(function (r) {
      return Object.assign({ type: 'reconcile' }, r);
    });
  }
  var RECONCILE_MAX = 2;
  function forToday() {
    if (!canSuggest()) return [];
    var rec = reconcileRows();
    var shown = rec.slice(0, RECONCILE_MAX);
    if (rec.length > shown.length) shown[shown.length - 1].more = rec.length - shown.length;
    return shown.concat(SG.buildSuggestions(recentRows(), ctx()));
  }
  function forNumber(digits, rows) {
    if (!canSuggest()) return null;
    var d = LG.digits10(digits);
    if (!d) return null;
    var c = ctx();
    return SG.suggestFor({ digits: d, calls: (rows || recentRows()).filter(function (r) { return r && LG.digits10(r.phoneDigits) === d; }),
      thursday: c.thursday, labels: c.labels, dismissals: c.dismissals, onLead: !!leadFor(d), leadName: (leadFor(d) || {}).leadName, now: c.now });
  }

  /** "Looks like a Sub — why  [Accept] [Not this]" — plain classes, delegated clicks. */
  function reconcileHtml(s) {
    var kinds = (s.kinds || []).map(function (k) { return LG.KIND_LABEL[k] || 'Labeled'; }).join(' / ');
    var nums = (s.digits || []).join(',');
    var what = s.captureOff
      ? 'You stopped recording this number'
      : (s.policy === 'quiet' ? 'You set this number to quiet' : 'You hid this number');
    var tail = s.captureOff
      ? 'Calls and texts that arrived while it was off were not saved, and texts cannot be brought back. Unlabel to record it again.'
      : 'Its missed' + (s.policy === 'quiet' ? ' and urgent' : '') + ' calls stay off Today unless you promised something.';
    return '<div class="cl-sug cl-rec" data-cs-row="' + esc(nums) + '" role="group" aria-label="A labeled number is now a customer">' +
      '<div class="cl-sug-text"><b>' + esc(s.name) + ' is now a customer</b> <span class="cl-sug-why">— ' + esc(what) + ' as ' + esc(kinds) + '. ' + esc(tail) + '</span>' +
      (s.more ? ' <span class="cl-sug-why">(' + esc(s.more) + ' more like this in the Call Center → Labeled.)</span>' : '') + '</div>' +
      '<div class="cl-sug-acts">' +
      '<button type="button" class="cl-sug-btn cl-sug-go" data-cs="rec-clear" data-digits="' + esc(nums) + '">' + (s.captureOff ? 'Unlabel and record again' : 'Unlabel') + '</button>' +
      '<button type="button" class="cl-sug-btn" data-cs="rec-keep" data-digits="' + esc(nums) + '">Keep it ' + (s.captureOff ? 'off' : 'hidden') + '</button>' +
      '</div></div>';
  }
  function chipHtml(s) {
    if (s && s.type === 'reconcile') return reconcileHtml(s);
    var accept = s.needsSheet ? (s.kind ? 'Choose…' : 'Label it…') : 'Accept';
    // What Accept does, said before the tap (audit H5). A number on a customer
    // says why it is not one tap.
    var effect = '';
    if (s.kind && s.effect) {
      var lead = s.needsSheet && s.onLead ? 'This number is on customer ' + (s.leadName || 'a customer') + ', so it is not one tap. You choose next. ' : '';
      effect = '<div class="cl-sug-effect">' + esc(lead) + (s.needsSheet && !s.onLead ? 'You pick what happens to its calls next.' : esc((s.needsSheet ? '' : 'If you accept: ') + s.effect)) + '</div>';
    }
    return '<div class="cl-sug" data-cs-row="' + esc(s.digits) + '">' +
      '<div class="cl-sug-text"><b>' + esc(s.title) + '</b> <span class="cl-sug-why">— ' + esc(s.why) + '.</span>' + effect + '</div>' +
      '<div class="cl-sug-acts">' +
      '<button type="button" class="cl-sug-btn cl-sug-go" data-cs="accept" data-digits="' + esc(s.digits) + '" data-kind="' + esc(s.kind) + '">' + esc(accept) + '</button>' +
      '<button type="button" class="cl-sug-btn" data-cs="dismiss" data-digits="' + esc(s.digits) + '" data-kind="' + esc(s.kind) + '">Not this</button>' +
      '</div></div>';
  }

  async function dismiss(digits, kind) {
    var d = LG.digits10(digits);
    if (!d || !canSuggest()) return;
    var prev = st.dismissals[d] ? { dismissed: st.dismissals[d].dismissed.slice() } : null;
    var list = SG.withDismissal(prev, kind, Date.now());
    st.dismissals[d] = { dismissed: list };
    changed();                                            // optimistic: the chip leaves at once
    try {
      await w.setDoc(w.doc(w.db, 'companies', tenant(), 'contact_suggestions', d),
        { digits: d, dismissed: list, companyId: String(tenant()), updatedBy: uid(), updatedAtMs: Date.now() });
    } catch (e) {
      if (prev) st.dismissals[d] = prev; else delete st.dismissals[d];
      changed();
      console.warn('[suggest] dismiss write failed', e && e.code);
      toast("Couldn't save that — the suggestion is back; tap Not this again", 'error');
    }
  }

  function nameFor(digits) {
    var rows = recentRows().filter(function (r) { return r && LG.digits10(r.phoneDigits) === digits && r.contactName; });
    return rows.length ? rows[0].contactName : '';
  }
  async function accept(digits, kind) {
    var d = LG.digits10(digits);
    var s = forNumber(d);
    var LB = w.NBDContactLabels;
    if (!d || !LB) return;
    if (!s || s.needsSheet || !kind) {
      LB.openSheet({ digits: d, name: nameFor(d), leadName: s && s.leadName ? s.leadName : (leadFor(d) || {}).leadName || '', pending: kind || '', source: s ? s.source : '' });
      return;
    }
    await LB.applyWithUndo({ digits: d, kind: kind, source: s.source, name: nameFor(d) });
    changed();
  }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-cs]') : null;
    if (!t) return;
    var a = t.getAttribute('data-cs'), d = t.getAttribute('data-digits'), k = t.getAttribute('data-kind') || '';
    if (a === 'accept') accept(d, k);
    else if (a === 'dismiss') dismiss(d, k);
    else if (a === 'rec-keep' || a === 'rec-clear') reconcileAct(a, d);
  });

  // "Keep hidden" / "Unlabel" on the reconciliation row: both undoable (the
  // 9 s bar in contact-labels.js), neither touches the customer.
  async function reconcileAct(a, csv) {
    var LB = w.NBDContactLabels;
    var list = String(csv || '').split(',').map(function (x) { return LG.digits10(x); }).filter(Boolean);
    if (!LB || !list.length || !canSuggest()) return;
    if (a === 'rec-keep') await LB.ack(list);
    else await LB.clear(list);
    changed();
  }
  w.addEventListener('nbd:labels-changed', function () { changed(); });

  w.NBDContactSuggest = { load: load, forToday: forToday, forNumber: forNumber, chipHtml: chipHtml, dismiss: dismiss, accept: accept, reconcileRows: reconcileRows, _state: st };
  // Warm the evidence once the bundle lands; the first paint just has fewer chips.
  setTimeout(function () { load(false); }, 0);
})();
