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

  function forToday() {
    if (!canSuggest()) return [];
    return SG.buildSuggestions(recentRows(), ctx());
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
  function chipHtml(s) {
    var accept = s.needsSheet ? (s.kind ? 'Choose…' : 'Label it…') : 'Accept';
    return '<div class="cl-sug" data-cs-row="' + esc(s.digits) + '">' +
      '<div class="cl-sug-text"><b>' + esc(s.title) + '</b> <span class="cl-sug-why">— ' + esc(s.why) + '.</span></div>' +
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
      LB.openSheet({ digits: d, name: nameFor(d), pending: kind || '', source: s ? s.source : '' });
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
  });
  w.addEventListener('nbd:labels-changed', function () { changed(); });

  w.NBDContactSuggest = { load: load, forToday: forToday, forNumber: forNumber, chipHtml: chipHtml, dismiss: dismiss, accept: accept, _state: st };
  // Warm the evidence once the bundle lands; the first paint just has fewer chips.
  setTimeout(function () { load(false); }, 0);
})();
