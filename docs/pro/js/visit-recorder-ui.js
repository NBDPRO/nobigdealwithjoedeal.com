/**
 * visit-recorder-ui.js - the screens of the in-person visit recorder
 * (window.NBDVisitRecorderUI). Lazy-loaded with visit-recorder.js.
 *
 * Every string that reaches the DOM goes through textContent. There is no
 * innerHTML and no inline handler anywhere in this file (strict CSP).
 *
 * Screens: consent/start sheet -> live recording panel -> "Who was this?"
 * sheet -> "Unfiled visits" list; plus the recovery prompt.
 */
(function () {
  'use strict';
  if (window.NBDVisitRecorderUI) return;
  var R = window.NBDVisitRecorder;
  var L = window.NBDVisitRecorderLogic;
  if (!R || !L) { console.warn('[visit-recorder-ui] core missing'); return; }

  var root = null;       // #nbd-vr-root
  var live = null;       // the recording panel (non-modal)
  var sheet = null;      // the one modal sheet at a time
  var sheetCleanup = null;
  var liveUnsub = null;

  // ── tiny DOM helpers ────────────────────────────────────────────────────
  function el(tag, cls, text, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null && text !== '') n.textContent = String(text);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function btn(label, cls, onClick, attrs) {
    var b = el('button', 'nbd-vr-btn' + (cls ? ' ' + cls : ''), label, Object.assign({ type: 'button' }, attrs || {}));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.getElementById('nbd-vr-root');
    if (!root) {
      root = el('div', 'nbd-vr-root', '', { id: 'nbd-vr-root' });
      document.body.appendChild(root);
    }
    return root;
  }
  function toast(msg, tone) {
    try { if (typeof window.showToast === 'function') { window.showToast(msg, tone || 'info'); return; } } catch (_) {}
    var t = el('div', 'nbd-vr-toast', msg, { role: 'status' });
    ensureRoot().appendChild(t);
    setTimeout(function () { try { t.remove(); } catch (_) {} }, 4500);
  }

  // ── modal sheet ─────────────────────────────────────────────────────────
  function closeSheet() {
    if (sheetCleanup) { try { sheetCleanup(); } catch (_) {} sheetCleanup = null; }
    if (sheet) { try { sheet.remove(); } catch (_) {} sheet = null; }
  }
  function openSheet(title, bodyNodes, opts) {
    closeSheet();
    opts = opts || {};
    var scrim = el('div', 'nbd-vr-scrim');
    var card = el('div', 'nbd-vr-sheet', '', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    card.appendChild(el('div', 'nbd-vr-title', title));
    bodyNodes.forEach(function (n) { if (n) card.appendChild(n); });
    scrim.appendChild(card);
    if (opts.dismissible !== false) {
      scrim.addEventListener('click', function (e) { if (e.target === scrim) closeSheet(); });
      var onKey = function (e) { if (e.key === 'Escape') closeSheet(); };
      document.addEventListener('keydown', onKey);
      sheetCleanup = function () { document.removeEventListener('keydown', onKey); };
    }
    ensureRoot().appendChild(scrim);
    sheet = scrim;
    var first = card.querySelector('.nbd-vr-primary') || card.querySelector('button');
    if (first) { try { first.focus({ preventScroll: true }); } catch (_) {} }
    return { scrim: scrim, card: card };
  }

  // ── customer data (read-only, in memory) ────────────────────────────────
  function allLeads() {
    var out = Array.isArray(window._leads) ? window._leads.slice() : [];
    try {
      var cur = window._currentLead;
      if (cur && (cur.id || cur.leadId) && !out.some(function (l) { return l && String(l.id) === String(cur.id || cur.leadId); })) {
        out.push(Object.assign({ id: cur.id || cur.leadId }, cur));
      }
    } catch (_) {}
    return out;
  }
  function nameOf(leadId) {
    if (!leadId) return '';
    var l = allLeads().filter(function (x) { return x && String(x.id) === String(leadId); })[0];
    return l ? L.leadName(l) : 'this customer';
  }
  function recentIds() {
    try {
      var r = JSON.parse(window.localStorage.getItem('nbd_recent_customers') || '[]');
      return r.map(function (x) { return typeof x === 'string' ? x : (x && x.id); }).filter(Boolean).slice(0, 3);
    } catch (_) { return []; }
  }
  function uidNow() { try { return (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null; } catch (_) { return null; } }
  /** Today's appointments around the moment recording started. Offline or failing -> []. */
  function appointmentsNear(startedAtMs) {
    var u = uidNow();
    if (!u || !window.db || typeof window.getDocs !== 'function' || typeof window.query !== 'function' || !window.where || !window.orderBy || !window.collection) return Promise.resolve([]);
    var lo = new Date(startedAtMs - L.APPT_WINDOW_MS - 5 * 60000);
    var hi = new Date(startedAtMs + L.APPT_WINDOW_MS + 5 * 60000);
    var byId = {};
    var lanes = ['repUid', 'userId'];
    return Promise.all(lanes.map(function (lane) {
      try {
        var q = window.query(window.collection(window.db, 'appointments'), window.where(lane, '==', u),
          window.where('startTime', '>=', lo), window.where('startTime', '<=', hi), window.orderBy('startTime', 'asc'));
        return Promise.race([
          window.getDocs(q).then(function (snap) { snap.forEach(function (d) { byId[d.id] = Object.assign({ id: d.id }, d.data()); }); }),
          new Promise(function (res) { setTimeout(res, 4000); }),
        ]).catch(function () {});
      } catch (_) { return Promise.resolve(); }
    })).then(function () { return Object.keys(byId).map(function (k) { return byId[k]; }); });
  }

  // ── start ───────────────────────────────────────────────────────────────
  function begin(o) {
    o = o || {};
    if (R.getState().active) { toast('A recording is already running.', 'info'); return Promise.resolve({ ok: false, reason: 'busy' }); }
    var cfg = R.getConfig();
    // First use on this phone (or a logout wiped the cache): read the company's
    // consent setting, but never make the person wait more than 1.5 s for it.
    var ready = cfg.known ? Promise.resolve(cfg)
      : Promise.race([R.refreshConfig(), new Promise(function (res) { setTimeout(function () { res(R.getConfig()); }, 1500); })]);
    return ready.then(function (c) { return beginWith(o, L.consentPlan(c || R.getConfig())); });
  }
  function beginWith(o, plan) {
    if (!plan.needsSheet) return doStart(o);
    return new Promise(function (resolve) {
      var body = [
        el('p', 'nbd-vr-line', plan.line),
        el('p', 'nbd-vr-note', plan.needsAck ? 'Your company is set to ask first. Nothing is recorded until you tap below.' : 'You can turn this reminder off in Settings > Company.'),
      ];
      var row = el('div', 'nbd-vr-actions');
      row.appendChild(btn(plan.needsAck ? 'I told them - start recording' : 'Start recording', 'nbd-vr-primary nbd-vr-go', function () {
        closeSheet();
        resolve(doStart(Object.assign({}, o, { disclosureAckedAtMs: Date.now() })));
      }));
      row.appendChild(btn('Cancel', 'nbd-vr-quiet', function () { closeSheet(); resolve({ ok: false, reason: 'cancelled' }); }));
      body.push(row);
      openSheet('Record this visit', body);
    });
  }
  function doStart(o) {
    // The panel appears on the 'state' event the core emits synchronously.
    mountLive();
    return R.start(o).then(function (r) {
      if (!r.ok) {
        if (r.reason === 'busy') { mountLive(); return r; }   // a recording is already running: show it, say nothing
        unmountLive();
        if (r.reason !== 'cancelled') showProblem(r);
      }
      return r;
    });
  }
  function showProblem(r) {
    var body = [el('p', 'nbd-vr-line', r.message || 'Could not start recording.')];
    var row = el('div', 'nbd-vr-actions');
    row.appendChild(btn('OK', 'nbd-vr-primary', closeSheet));
    body.push(row);
    openSheet(r.reason === 'dnr' ? 'Do not record' : 'Not recording', body);
  }

  // ── the live panel ──────────────────────────────────────────────────────
  var liveNodes = null;
  function mountLive() {
    if (live && live.isConnected) return;
    live = el('div', 'nbd-vr-live', '', { role: 'region', 'aria-label': 'Recording in progress', 'aria-live': 'polite' });
    var head = el('div', 'nbd-vr-live-head');
    var dot = el('span', 'nbd-vr-dot', '', { 'aria-hidden': 'true' });
    var label = el('span', 'nbd-vr-live-label', 'Recording');
    var clock = el('span', 'nbd-vr-clock', '0:00');
    head.appendChild(dot); head.appendChild(label); head.appendChild(clock);
    var who = el('div', 'nbd-vr-live-who');
    var notes = el('div', 'nbd-vr-live-notes');
    var actions = el('div', 'nbd-vr-actions');
    var pauseBtn = btn('Pause', 'nbd-vr-quiet', function () {
      var a = R.getState().active;
      if (a && a.paused) R.resume(); else R.pause();
    });
    var stopBtn = btn('Stop and save', 'nbd-vr-primary nbd-vr-stop', function () {
      stopBtn.disabled = true; pauseBtn.disabled = true;
      R.stop({ reason: 'stopped' });
    });
    actions.appendChild(pauseBtn); actions.appendChild(stopBtn);
    live.appendChild(head); live.appendChild(who); live.appendChild(notes); live.appendChild(actions);
    ensureRoot().appendChild(live);
    liveNodes = { dot: dot, label: label, clock: clock, who: who, notes: notes, pauseBtn: pauseBtn, stopBtn: stopBtn };
    if (liveUnsub) liveUnsub();
    liveUnsub = R.subscribe(onCoreEvent);
    renderLive(R.getState());
  }
  function unmountLive() {
    if (live) { try { live.remove(); } catch (_) {} }
    live = null; liveNodes = null;
  }
  function note(cls, text) { return el('div', 'nbd-vr-note ' + cls, text); }
  function renderLive(st) {
    var a = st && st.active;
    if (!live || !liveNodes) return;
    if (!a) return;
    var n = liveNodes;
    n.label.textContent = a.paused ? 'Paused' : 'Recording';
    live.classList.toggle('is-paused', !!a.paused);
    n.clock.textContent = L.formatClock(a.elapsedSec);
    n.pauseBtn.textContent = a.paused ? 'Resume' : 'Pause';
    n.who.textContent = a.leadId ? 'Attached to ' + nameOf(a.leadId) : 'Not attached yet. You will pick the customer after you stop.';
    var notes = [];
    if (a.disclosure) notes.push(note('is-law', a.disclosure));
    // Always said: a web app cannot record in the background or with the phone locked.
    notes.push(note('is-hint', 'Keep this app open and the screen on. An iPhone cannot record in the background.'));
    if (a.wakeLock === 'lost') notes.push(note('is-warn', 'The screen may lock and stop the recording. Tap the screen now and then.'));
    else if (a.wakeLock === 'unsupported') notes.push(note('is-warn', 'This phone cannot hold the screen awake for you. Do not let it lock.'));
    if (a.firstGeoAsk && a.geo === 'asking') notes.push(note('is-hint', 'Your phone may ask for location. It is only used to suggest which customer this visit was.'));
    if (a.storageError) notes.push(note('is-warn', 'Could not save to phone storage. Do not close the app until you stop.'));
    if (a.cap === 'warn') notes.push(note('is-warn', 'Ten minutes left. It saves itself at 60 minutes; tap Record to start part 2.'));
    if (a.notice && !a.storageError && a.cap !== 'warn') notes.push(note('is-warn', a.notice));
    n.notes.textContent = '';
    notes.forEach(function (x) { n.notes.appendChild(x); });
  }
  function onCoreEvent(kind, data) {
    if (kind === 'state' || kind === 'tick' || kind === 'started') {
      var st = data && data.active !== undefined ? data : R.getState();
      if (st.active) { if (!live) mountLive(); renderLive(st); }
      return;
    }
    if (kind === 'refused') {
      unmountLive();
      if (liveUnsub) { liveUnsub(); liveUnsub = null; }
      showProblem({ reason: 'dnr', message: data.message });
      return;
    }
    if (kind === 'stopped') {
      unmountLive();
      if (liveUnsub) { liveUnsub(); liveUnsub = null; }
      var row = data && data.row;
      if (row) {
        var why = '';
        if (data.reason === 'cap') why = 'It stopped at the 60 minute limit and was saved. Tap Record to start part 2.';
        else if (data.reason === 'recorder-ended') why = 'The phone ended the recording (usually because the app went to the background). What was captured is saved.';
        var msg = [data.notice || '', why].filter(Boolean).join(' ');
        showWho(row, msg, !!data.error);
      }
    }
  }

  // ── "Who was this?" ─────────────────────────────────────────────────────
  function liveBadgeNode(rowId) {
    var n = el('div', 'nbd-vr-badge');
    function paint() {
      R._getVisit(rowId).then(function (r) {
        if (!r) return;
        var b = L.badge(r, navigator.onLine !== false);
        n.textContent = b.text;
        n.className = 'nbd-vr-badge is-' + b.tone;
      }).catch(function () {});
    }
    paint();
    var un = R.subscribe(function (k, d) { if (k === 'row' || k === 'online' || k === 'counters') paint(); });
    return { node: n, off: un };
  }
  function showWho(row, notice, failed) {
    var badge = liveBadgeNode(row.id);
    var body = [badge.node];
    if (failed) body.push(el('p', 'nbd-vr-note is-warn', 'NOT saved to the storage on this phone.'));
    if (notice) body.push(el('p', 'nbd-vr-note is-warn', notice));
    var chipsBox = el('div', 'nbd-vr-chips');
    var status = el('p', 'nbd-vr-note', '');
    var actions = el('div', 'nbd-vr-actions');
    var title = 'Who was this?';

    function finish(msg) {
      badge.off();
      closeSheet();
      if (msg) toast(msg, 'ok');
    }
    function attachTo(leadId, apptId) {
      R.attach(row.id, leadId, { appointmentId: apptId }).then(function (r) {
        if (!r.ok) { status.textContent = r.message || 'Could not attach.'; status.className = 'nbd-vr-note is-warn'; return; }
        row = r.row;
        finish('Attached to ' + nameOf(leadId) + '. Nothing else was filed.');
      });
    }
    function chip(c, apptId) {
      var b = el('button', 'nbd-vr-chip', '', { type: 'button' });
      b.appendChild(el('span', 'nbd-vr-chip-name', c.name));
      if (c.address) b.appendChild(el('span', 'nbd-vr-chip-addr', c.address));
      b.appendChild(el('span', 'nbd-vr-chip-why', c.evidence));
      b.addEventListener('click', function () { attachTo(c.leadId, apptId); });
      return b;
    }

    if (row.leadId) {
      title = 'Saved on phone';
      body.push(el('p', 'nbd-vr-line', 'Attached to ' + nameOf(row.leadId) + '.'));
      actions.appendChild(btn('Done', 'nbd-vr-primary', function () { finish(); }));
      actions.appendChild(btn('Change customer', 'nbd-vr-quiet', function () {
        R.attach(row.id, null).then(function (r) { if (r.ok) { badge.off(); showWho(r.row, ''); } });
      }));
      body.push(actions);
      openSheet(title, body);
      return;
    }

    body.push(el('p', 'nbd-vr-line', 'Pick the customer so it files with them. Nothing is attached until you tap.'));
    body.push(chipsBox);
    body.push(status);
    actions.appendChild(btn('Search customer', 'nbd-vr-primary', function () { badge.off(); showSearch(row); }));
    actions.appendChild(btn('Save unattached', 'nbd-vr-quiet', function () { finish('Saved. Find it under Unfiled visits.'); }));
    body.push(actions);
    openSheet(title, body);

    chipsBox.appendChild(el('p', 'nbd-vr-note', 'Looking for likely matches...'));
    appointmentsNear(row.startedAtMs).then(function (appts) {
      var chips = L.suggest({ startedAtMs: row.startedAtMs, preLeadId: row.leadId, appointments: appts, recentIds: recentIds(), leads: allLeads() });
      chipsBox.textContent = '';
      if (!chips.length) { chipsBox.appendChild(el('p', 'nbd-vr-note', 'No likely match. Search for the customer, or save it unattached.')); return; }
      chips.forEach(function (c) { chipsBox.appendChild(chip(c, c.kind === 'appointment' ? L.appointmentIdFor(appts, c.leadId) : null)); });
    });
  }

  // ── customer search ─────────────────────────────────────────────────────
  function searchLeads(q) {
    q = String(q || '').trim();
    if (q.length < 2) return [];
    try {
      if (window.NbdGlobalSearch && typeof window.NbdGlobalSearch.searchLeads === 'function') {
        var hits = window.NbdGlobalSearch.searchLeads(q) || [];
        return hits.map(function (h) { return h && h.lead ? h.lead : h; }).filter(Boolean).slice(0, 8);
      }
    } catch (_) {}
    var needle = q.toLowerCase();
    return allLeads().filter(function (l) {
      return l && !l.deleted && [L.leadName(l), l.address, l.phone].join(' ').toLowerCase().indexOf(needle) >= 0;
    }).slice(0, 8);
  }
  function showSearch(row) {
    var input = el('input', 'nbd-vr-input', '', { type: 'search', placeholder: 'Name, address or phone', autocomplete: 'off', 'aria-label': 'Search customers' });
    var results = el('div', 'nbd-vr-results');
    var status = el('p', 'nbd-vr-note', '');
    function renderResults() {
      results.textContent = '';
      var hits = searchLeads(input.value);
      if (!hits.length && input.value.trim().length >= 2) results.appendChild(el('p', 'nbd-vr-note', 'No customer found.'));
      hits.forEach(function (l) {
        var b = el('button', 'nbd-vr-chip', '', { type: 'button' });
        b.appendChild(el('span', 'nbd-vr-chip-name', L.leadName(l) || 'Customer'));
        if (l.address) b.appendChild(el('span', 'nbd-vr-chip-addr', l.address));
        if (L.isDoNotRecord(l)) b.appendChild(el('span', 'nbd-vr-chip-why is-warn', 'Marked do not record'));
        b.addEventListener('click', function () {
          R.attach(row.id, l.id).then(function (r) {
            if (!r.ok) { status.textContent = r.message; status.className = 'nbd-vr-note is-warn'; return; }
            closeSheet(); toast('Attached to ' + L.leadName(l) + '.', 'ok');
          });
        });
        results.appendChild(b);
      });
    }
    input.addEventListener('input', renderResults);
    var actions = el('div', 'nbd-vr-actions');
    actions.appendChild(btn('Back', 'nbd-vr-quiet', function () { showWho(row, ''); }));
    openSheet('Search customer', [input, results, status, actions]);
    try { input.focus(); } catch (_) {}
  }

  // ── recovery ────────────────────────────────────────────────────────────
  function showRecovered(rows) {
    var list = (rows || []).slice();
    function next() {
      var r = list.shift();
      if (!r) { closeSheet(); return; }
      var when = new Date(r.startedAtMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      var body = [
        el('p', 'nbd-vr-line', 'Recovered a recording from ' + when + ' (' + L.formatClock(r.durationSec || 0) + '). The app closed before it was saved.'),
        el('p', 'nbd-vr-note', 'It is still on this phone. Save it, or discard it.'),
      ];
      var actions = el('div', 'nbd-vr-actions');
      actions.appendChild(btn('Save it', 'nbd-vr-primary', function () {
        R.confirmRecovered(r.id).then(function (row) { closeSheet(); if (row) showWho(row, ''); });
      }));
      var del = btn('Discard', 'nbd-vr-quiet', function () {
        if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Tap again to delete it'; return; }
        R.discard(r.id).then(next);
      });
      actions.appendChild(del);
      body.push(actions);
      openSheet('Recovered a recording', body, { dismissible: false });
    }
    next();
  }

  // ── unfiled visits ──────────────────────────────────────────────────────
  function openUnfiled() {
    var wrap = el('div', 'nbd-vr-list');
    var actions = el('div', 'nbd-vr-actions');
    actions.appendChild(btn('Close', 'nbd-vr-quiet', closeSheet));
    var off = null;
    var h = openSheet('Unfiled visits', [wrap, actions]);
    var cleanup = sheetCleanup;
    sheetCleanup = function () { if (off) off(); if (cleanup) cleanup(); };
    function render() {
      Promise.all([R.list(), R.listRemote()]).then(function (res) {
        var local = res[0], remote = res[1];
        var ids = {};
        local.forEach(function (r) { ids[r.id] = true; });
        var rows = local.concat(remote.filter(function (r) { return !ids[r.id] && !r.leadId && r.status === 'uploaded'; }))
          .filter(function (r) { return !r.leadId; })
          .sort(function (a, b) { return (b.startedAtMs || 0) - (a.startedAtMs || 0); });
        wrap.textContent = '';
        if (!rows.length) { wrap.appendChild(el('p', 'nbd-vr-note', 'Nothing waiting. Every visit you recorded is filed or discarded.')); return; }
        rows.forEach(function (r) { wrap.appendChild(rowNode(r)); });
      });
    }
    function rowNode(r) {
      var n = el('div', 'nbd-vr-item');
      var when = new Date(r.startedAtMs || Date.now());
      n.appendChild(el('div', 'nbd-vr-item-title',
        when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
        when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' - ' + L.formatClock(r.durationSec || 0)));
      var b = L.badge(r, navigator.onLine !== false);
      n.appendChild(el('div', 'nbd-vr-badge is-' + b.tone, b.text));
      var acts = el('div', 'nbd-vr-actions');
      acts.appendChild(btn('Attach', 'nbd-vr-primary', function () { closeSheet(); showWho(r, ''); }));
      if (r.status === 'failed' || r.status === 'stored' || (r.status === 'uploaded' && r.docSynced === false)) {
        acts.appendChild(btn('Retry now', 'nbd-vr-quiet', function () { R.retryNow().then(render); }));
      }
      var del = btn('Discard', 'nbd-vr-quiet', function () {
        if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; return; }
        R.discard(r.id).then(render);
      });
      acts.appendChild(del);
      n.appendChild(acts);
      return n;
    }
    off = R.subscribe(function (k) { if (k === 'row' || k === 'counters') render(); });
    render();
    return h;
  }

  window.NBDVisitRecorderUI = {
    begin: begin, openUnfiled: openUnfiled, showRecovered: showRecovered, showWho: showWho,
    close: closeSheet, isRecording: function () { return !!R.getState().active; },
    // The live panel may need re-mounting after a full-screen modal covered it.
    ensureLive: function () { if (R.getState().active) mountLive(); },
  };
})();
