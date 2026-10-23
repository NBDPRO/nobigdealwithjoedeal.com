/**
 * Storm Center > Outreach tab (2026-10-23, storm-and-demand queue, PR 2).
 *
 * Past customers and open leads near a RECORDED storm report, each with a
 * fixed-wording draft the owner ticks and files. The two callables do the work
 * (functions/storm-outreach-logic.js):
 *   listStormOutreach        read-only; names, address, stage, miles; never a
 *                            phone or email
 *   fileStormOutreachDrafts  files the ticked customers as PENDING drafts in
 *                            the Agent inbox
 * NOTHING sends from here. The owner sends each draft from the Agent inbox,
 * where STOP / Do-Not-Text / consent / quiet hours / the kill switch are
 * re-checked. Owner and company admins only (the callables refuse everyone
 * else; the tab says so instead of failing silently).
 *
 * Loaded in the 'storm' bundle after storm-center.js, which calls
 * StormOutreachUI.html() / .load() for its Outreach tab. No inline handlers
 * (CSP): one delegated click + change listener on #view-storm.
 */
(function () {
  'use strict';

  var MAX_PER_EVENT = 40; // the callable's cap
  var state = { status: 'idle', data: null, error: '', picked: {}, busy: '', note: '' };

  var COHORT = { past_customer: 'Past customer', open_lead: 'Open lead' };
  var SKIP = {
    cannot_text: 'no textable phone, texting declined, or on a Do-Not-Text list',
    out_of_range: 'too far from the report',
    not_a_target: 'not a target stage',
    not_on_board: 'not found',
    already_filed: 'already filed',
    text_refused: 'wording refused',
    write_failed: 'could not be saved'
  };
  var HAZARD = { hail: 'Hail', wind: 'Damaging wind', storm: 'Severe storm' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function callable(name, payload) {
    var ready = window._httpsCallable ? Promise.resolve() :
      import('/assets/vendor/firebase/10.12.2/firebase-functions.js').then(function (m) { window._httpsCallable = m.httpsCallable; });
    return ready.then(function () {
      if (!window._functions) throw new Error('Functions SDK unavailable');
      return window._httpsCallable(window._functions, name)(payload || {});
    }).then(function (res) { return res && res.data; });
  }

  function repaint() {
    try { if (window.StormCenter && window.StormCenter.render) window.StormCenter.render(); } catch (_) { /* tab repaint is best effort */ }
  }

  function pickedIds(key) {
    var m = state.picked[key] || {};
    return Object.keys(m).filter(function (id) { return m[id]; });
  }

  function selectable(c) { return !!c && !!c.draft && c.has_phone === true && c.declined_texting !== true; }

  function why(c) {
    if (!c.draft) return 'No draft could be built';
    if (c.declined_texting) return 'Declined texting';
    if (!c.has_phone) return 'No phone on file';
    return '';
  }

  function rowHtml(ev, c) {
    var ok = selectable(c);
    var id = 'sto-' + esc(ev.key) + '-' + esc(c.lead_id);
    var checked = !!(state.picked[ev.key] && state.picked[ev.key][c.lead_id]);
    var label = (c.name || 'Unnamed') + ', ' + (COHORT[c.cohort] || 'Customer') + ', ' + c.miles + ' miles from the report';
    return '<li class="sto-row' + (ok ? '' : ' sto-row-off') + '">'
      + '<input type="checkbox" class="sto-check" id="' + id + '" data-sto-event="' + esc(ev.key) + '" data-sto-lead="' + esc(c.lead_id) + '"'
      + (checked ? ' checked' : '') + (ok ? '' : ' disabled') + ' aria-label="' + esc(label) + '">'
      + '<div class="sto-main">'
      + '<label class="sto-name" for="' + id + '">' + esc(c.name || 'Unnamed') + '</label>'
      + '<div class="sto-sub">' + esc(c.address || 'No address') + '</div>'
      + '<div class="sto-tags"><span class="stc-tag sto-cohort sto-cohort-' + esc(c.cohort) + '">' + esc(COHORT[c.cohort] || 'Customer') + '</span>'
      + '<span class="stc-tag stc-tag-plain">' + esc(c.miles) + ' mi</span>'
      + (c.stage ? '<span class="stc-tag stc-tag-plain">' + esc(c.stage) + '</span>' : '')
      + (ok ? '' : '<span class="stc-tag sto-off">' + esc(why(c)) + '</span>') + '</div>'
      + (c.draft ? '<details class="sto-draft"><summary>Preview draft</summary><p>' + esc(c.draft) + '</p></details>' : '')
      + '</div></li>';
  }

  function eventHtml(ev) {
    var n = pickedIds(ev.key).length;
    var total = (ev.counts && (ev.counts.past_customer + ev.counts.open_lead)) || 0;
    var shown = (ev.customers || []).length;
    return '<section class="stc-card sto-event" aria-label="' + esc((HAZARD[ev.hazard] || 'Storm') + ' report, ' + (ev.where || '')) + '">'
      + '<div class="stc-card-title">' + esc(HAZARD[ev.hazard] || 'Storm') + ' report &middot; ' + esc(ev.where || 'Unknown area') + '</div>'
      + '<div class="stc-card-sub">' + esc(ev.when_text || ev.when) + ' &middot; ' + esc(ev.counts ? ev.counts.past_customer : 0) + ' past customers, '
      + esc(ev.counts ? ev.counts.open_lead : 0) + ' open leads nearby'
      + (total > shown ? ' (nearest ' + shown + ' shown)' : '') + '</div>'
      + (shown ? '<ul class="sto-list">' + ev.customers.map(function (c) { return rowHtml(ev, c); }).join('') + '</ul>'
        + '<button type="button" class="btn btn-orange sto-file" data-sto-action="file" data-sto-event="' + esc(ev.key) + '"'
        + (n && !state.busy ? '' : ' disabled') + '>' + esc(state.busy === ev.key ? 'Filing…' : 'File ' + n + ' draft' + (n === 1 ? '' : 's') + ' to Agent inbox') + '</button>'
        : '<div class="stc-card-sub">No one on your board within ' + esc(state.data.miles) + ' miles.</div>')
      + '</section>';
  }

  function html() {
    var head = '<div class="stc-section"><div class="stc-sec-head">Storm outreach drafts</div>'
      + '<p class="sto-note">Past customers and open leads near a recorded storm report. Tick the people you want to check in on and file them. '
      + '<strong>Nothing is sent from here</strong>: each draft waits in your Agent inbox and you send it yourself. The wording only says a storm was reported near the town; it never promises damage or a claim outcome.</p>'
      + '<div class="sto-live" role="status" aria-live="polite">' + esc(state.note) + '</div>';
    if (state.status === 'loading' || state.status === 'idle') return head + '<div class="nbd-empty"><div class="ne-sub">⏳ Loading storm reports…</div></div></div>';
    if (state.status === 'error') {
      return head + '<div class="nbd-empty"><div class="ne-msg">Could not load storm outreach</div><div class="ne-sub">' + esc(state.error) + '</div>'
        + '<button type="button" class="btn btn-orange btn-sm" data-sto-action="reload">Try again</button></div></div>';
    }
    var evs = (state.data && state.data.events) || [];
    if (!evs.length) {
      return head + '<div class="nbd-empty"><div class="ne-icon">☀️</div><div class="ne-msg">No recent storm reports near your customers</div>'
        + '<div class="ne-sub">Last ' + esc(state.data.days) + ' days, within ' + esc(state.data.miles) + ' miles.</div></div></div>';
    }
    var foot = state.data.without_location
      ? '<p class="sto-note">' + esc(state.data.without_location) + ' customer' + (state.data.without_location === 1 ? ' has' : 's have') + ' no map location and cannot be matched.</p>' : '';
    return head + evs.map(eventHtml).join('') + foot + '</div>';
  }

  function load(force) {
    if (!force && (state.status === 'loading' || state.status === 'ready')) return;
    state.status = 'loading'; state.error = '';
    callable('listStormOutreach', {}).then(function (d) {
      state.data = d || { events: [] }; state.status = 'ready';
    }).catch(function (e) {
      state.status = 'error';
      state.error = (e && e.code === 'permission-denied') ? 'Only the owner or an admin can use storm outreach.' : 'Try again in a moment.';
    }).then(repaint);
  }

  function skipText(skipped) {
    var parts = Object.keys(skipped || {}).map(function (k) { return skipped[k] + ' ' + (SKIP[k] || k); });
    return parts.length ? ' Skipped: ' + parts.join('; ') + '.' : '';
  }

  function file(key) {
    var ids = pickedIds(key).slice(0, MAX_PER_EVENT);
    if (!ids.length || state.busy) return;
    state.busy = key; state.note = '';
    repaint();
    // The list and the filing both use the callable's default radius (3 mi).
    callable('fileStormOutreachDrafts', { eventKey: key, leadIds: ids }).then(function (r) {
      state.picked[key] = {};
      var n = (r && r.filed) || 0;
      state.note = n + ' draft' + (n === 1 ? '' : 's') + ' filed to your Agent inbox. Nothing was sent.' + skipText(r && r.skipped);
    }).catch(function (e) {
      state.note = (e && e.code === 'permission-denied') ? 'Only the owner or an admin can file drafts.' : 'Could not file the drafts. Nothing was sent. Try again.';
    }).then(function () { state.busy = ''; repaint(); });
  }

  function syncButton(root, key) {
    var n = pickedIds(key).length;
    var btns = root.querySelectorAll('.sto-file');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-sto-event') !== key) continue;
      btns[i].disabled = !n || !!state.busy;
      btns[i].textContent = 'File ' + n + ' draft' + (n === 1 ? '' : 's') + ' to Agent inbox';
    }
  }

  function wire() {
    var root = document.getElementById('view-storm');
    if (!root || root.__stoWired) return;
    root.__stoWired = true;
    root.addEventListener('click', function (ev) {
      var t = ev.target.closest && ev.target.closest('[data-sto-action]');
      if (!t || t.disabled) return;
      var a = t.getAttribute('data-sto-action');
      if (a === 'file') file(t.getAttribute('data-sto-event'));
      else if (a === 'reload') { load(true); repaint(); }
    });
    root.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || !t.classList || !t.classList.contains('sto-check')) return;
      var key = t.getAttribute('data-sto-event'), id = t.getAttribute('data-sto-lead');
      state.picked[key] = state.picked[key] || {};
      state.picked[key][id] = !!t.checked;
      syncButton(root, key);
    });
  }

  function onOpen() { wire(); load(false); }

  window.StormOutreachUI = {
    html: html, load: onOpen, reload: function () { load(true); },
    _state: state, _file: file, _wire: wire
  };
})();
