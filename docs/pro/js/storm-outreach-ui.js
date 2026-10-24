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
  var RADII = [1, 3, 5, 10]; // miles; the callables clamp to 0.5-10 and default to 3
  var state = { status: 'idle', data: null, error: '', picked: {}, busy: '', note: '', miles: 3, owner: null, gen: 0 };

  // Whose screen this is. The module outlives a sign-out / account switch in the
  // same tab, so customers, drafts and ticks from the previous account must not
  // stay in memory (audit 2026-10-23, finding 3). A switch bumps gen so a call
  // still in flight for the old account is ignored when it answers.
  function who() {
    var c = window._userClaims || {};
    return c.companyId || (window._user && window._user.uid) || '';
  }
  function syncOwner() {
    var now = who();
    if (state.owner === null) { state.owner = now; return; }
    if (state.owner === now) return;
    state.owner = now; state.gen++;
    state.status = 'idle'; state.data = null; state.error = ''; state.picked = {}; state.busy = ''; state.note = ''; state.miles = 3;
  }

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
      + (shown && ev.customers.some(selectable) ? '<div class="sto-bar">'
        + '<button type="button" class="btn btn-sm" data-sto-action="all" data-sto-event="' + esc(ev.key) + '">Select everyone I can text</button>'
        + '<button type="button" class="btn btn-sm" data-sto-action="none" data-sto-event="' + esc(ev.key) + '">Clear</button></div>' : '')
      + (shown ? '<ul class="sto-list">' + ev.customers.map(function (c) { return rowHtml(ev, c); }).join('') + '</ul>'
        + '<button type="button" class="btn btn-orange sto-file" data-sto-action="file" data-sto-event="' + esc(ev.key) + '"'
        + (n && !state.busy ? '' : ' disabled') + '>' + esc(state.busy === ev.key ? 'Filing…' : 'File ' + n + ' draft' + (n === 1 ? '' : 's') + ' to Agent inbox') + '</button>'
        : '<div class="stc-card-sub">No one on your board within ' + esc(state.data.miles) + ' miles.</div>')
      + '</section>';
  }

  function html() {
    syncOwner();
    var head = '<div class="stc-section"><div class="stc-sec-head">Storm outreach drafts</div>'
      + '<p class="sto-note">Past customers and open leads near a recorded storm report. Tick the people you want to check in on and file them. '
      + '<strong>Nothing is sent from here</strong>: each draft waits in your Agent inbox and you send it yourself. The wording only says a storm was reported near the town; it never promises damage or a claim outcome.</p>'
      + '<div class="sto-radius" role="group" aria-label="Distance from the report">' + RADII.map(function (m) {
        return '<button type="button" class="btn btn-sm sto-radius-btn" data-sto-action="miles" data-sto-miles="' + m + '" aria-pressed="' + (state.miles === m) + '"' + (state.busy ? ' disabled' : '') + '>' + m + ' mi</button>';
      }).join('') + '</div>'
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
    syncOwner();
    if (!force && (state.status === 'loading' || state.status === 'ready')) return;
    state.status = 'loading'; state.error = '';
    var gen = state.gen;
    callable('listStormOutreach', { miles: state.miles }).then(function (d) {
      if (gen !== state.gen) return;
      state.data = d || { events: [] }; state.status = 'ready';
    }).catch(function (e) {
      if (gen !== state.gen) return;
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
    var gen = state.gen;
    repaint();
    // The same radius the list was built with; the server re-measures it.
    callable('fileStormOutreachDrafts', { eventKey: key, leadIds: ids, miles: state.miles }).then(function (r) {
      if (gen !== state.gen) return;
      state.picked[key] = {};
      var n = (r && r.filed) || 0;
      state.note = n + ' draft' + (n === 1 ? '' : 's') + ' filed to your Agent inbox. Nothing was sent.' + skipText(r && r.skipped);
    }).catch(function (e) {
      if (gen !== state.gen) return;
      state.note = (e && e.code === 'permission-denied') ? 'Only the owner or an admin can file drafts.'
        : (e && e.code === 'failed-precondition') ? 'That storm report is too old to draft from. Nothing was sent. Reload for recent reports.'
        : 'Could not file the drafts. Nothing was sent. Try again.';
    }).then(function () { if (gen === state.gen) state.busy = ''; repaint(); });
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

  function setMiles(m) {
    if (state.busy || RADII.indexOf(m) < 0 || m === state.miles) return;
    state.miles = m; state.picked = {}; state.note = '';
    load(true);
    repaint();
  }

  // Tick (or clear) every row of one report that can be ticked, in place so focus stays put.
  function setAll(root, key, on) {
    var ev = ((state.data && state.data.events) || []).filter(function (e) { return e.key === key; })[0];
    if (!ev || state.busy) return;
    var map = {};
    if (on) (ev.customers || []).filter(selectable).slice(0, MAX_PER_EVENT).forEach(function (c) { map[c.lead_id] = true; });
    state.picked[key] = map;
    var boxes = root.querySelectorAll('.sto-check');
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].getAttribute('data-sto-event') !== key || boxes[i].disabled) continue;
      boxes[i].checked = !!map[boxes[i].getAttribute('data-sto-lead')];
    }
    syncButton(root, key);
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
      else if (a === 'miles') setMiles(Number(t.getAttribute('data-sto-miles')));
      else if (a === 'all') setAll(root, t.getAttribute('data-sto-event'), true);
      else if (a === 'none') setAll(root, t.getAttribute('data-sto-event'), false);
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
