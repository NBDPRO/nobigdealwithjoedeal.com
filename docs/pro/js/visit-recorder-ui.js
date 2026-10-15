/**
 * visit-recorder-ui.js - the screens of the in-person visit recorder
 * (window.NBDVisitRecorderUI). Lazy-loaded with visit-recorder.js.
 *
 * Every string that reaches the DOM goes through textContent. There is no
 * innerHTML and no inline handler anywhere in this file (strict CSP).
 *
 * Screens: consent/start sheet -> live recording panel -> "Who was this?"
 * sheet -> "Unfiled visits" list (with "Recent visits", every visit from the
 * last 14 days and where it is); plus the recovery prompt, which walks every
 * recovered recording in order.
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
  var POLL_MS = 15000;   // a sheet showing a visit the server is still working on re-reads it this often

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
  function online() { return navigator.onLine !== false; }
  function paintBadge(n, b) { n.textContent = b.text; n.className = 'nbd-vr-badge is-' + b.tone; }

  // ── modal sheet ─────────────────────────────────────────────────────────
  function closeSheet() {
    if (sheetCleanup) { var c = sheetCleanup; sheetCleanup = null; try { c(); } catch (_) {} }
    if (sheet) { try { sheet.remove(); } catch (_) {} sheet = null; }
  }
  /**
   * opts.dismissible (default true): scrim tap / Escape close it, then opts.onDismiss.
   * opts.cleanup runs whenever the sheet goes, however it goes (another sheet replacing it too).
   */
  function openSheet(title, bodyNodes, opts) {
    closeSheet();
    opts = opts || {};
    var scrim = el('div', 'nbd-vr-scrim');
    var card = el('div', 'nbd-vr-sheet', '', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
    var titleNode = el('div', 'nbd-vr-title', title);
    card.appendChild(titleNode);
    bodyNodes.forEach(function (n) { if (n) card.appendChild(n); });
    scrim.appendChild(card);
    var cleanups = [];
    if (typeof opts.cleanup === 'function') cleanups.push(opts.cleanup);
    if (opts.dismissible !== false) {
      var dismiss = function () { closeSheet(); if (typeof opts.onDismiss === 'function') opts.onDismiss(); };
      scrim.addEventListener('click', function (e) { if (e.target === scrim) dismiss(); });
      var onKey = function (e) { if (e.key === 'Escape') dismiss(); };
      document.addEventListener('keydown', onKey);
      cleanups.push(function () { document.removeEventListener('keydown', onKey); });
    }
    ensureRoot().appendChild(scrim);
    sheet = scrim;
    sheetCleanup = function () { cleanups.forEach(function (f) { try { f(); } catch (_) {} }); };
    var first = card.querySelector('.nbd-vr-primary') || card.querySelector('button');
    if (first) { try { first.focus({ preventScroll: true }); } catch (_) {} }
    return {
      scrim: scrim, card: card, titleNode: titleNode,
      setTitle: function (t) { titleNode.textContent = t; card.setAttribute('aria-label', t); },
    };
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
    // Read the company's consent setting when this phone never has (first use, a logout
    // wiped it) OR the copy is more than 10 minutes old: a company that switched to a
    // two-party mode must not be recorded under the old setting, or the server deletes
    // the recording (2026-10-15). Never more than 1.5 s of waiting; a stale-but-known
    // copy is used if the read does not come back in time.
    var ready = (cfg.known && !cfg.stale) ? Promise.resolve(cfg)
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
      openSheet('Record this visit', body, { onDismiss: function () { resolve({ ok: false, reason: 'cancelled' }); } });
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
    notes.push(note('is-hint', 'Keep this app open and the screen on. An iPhone cannot record in the background. Leaving this page stops the recording.'));
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
      if (row) showWho(row, stoppedWhy(data), !!data.error);
    }
  }
  /** Why it stopped, in words, when the person did not tap Stop. */
  function stoppedWhy(data) {
    var why = '';
    if (data.reason === 'cap') why = 'It stopped at the 60 minute limit and was saved. Tap Record to start part 2.';
    else if (data.reason === 'size-cap') why = 'It reached the 24 MB upload limit and was saved. Tap Record to start part 2.';
    else if (data.reason === 'recorder-ended') why = 'The recording ended on its own (a phone call, another app taking the microphone, or the app going to the background). Everything captured up to then is saved.';
    else if (data.reason === 'navigate') why = 'You left the page, so the recording was stopped and saved.';
    // the core's notice says the same thing in its own words for a recorder-ended stop
    var n = data.reason === 'recorder-ended' ? '' : (data.notice || '');
    return [n, why].filter(Boolean).join(' ');
  }

  // ── "Who was this?" ─────────────────────────────────────────────────────
  /**
   * The status line for one visit. A visit with no row on this phone (another
   * device uploaded it) is shown from the server's doc instead of a blank badge.
   */
  function liveBadgeNode(rowId, fallback) {
    var n = el('div', 'nbd-vr-badge');
    function paint() {
      R._getVisit(rowId).then(function (r) {
        if (r) { paintBadge(n, L.visitStatus(Object.assign({}, r, fallback && fallback.pipelineStatus ? { pipelineStatus: fallback.pipelineStatus, pipelineNote: fallback.pipelineNote, audioLive: fallback.audioLive } : {}), online())); return; }
        if (fallback) paintBadge(n, L.visitStatus(Object.assign({ remoteOnly: true }, fallback), online()));
      }).catch(function () {});
    }
    paint();
    var un = R.subscribe(function (k, d) { if ((k === 'row' && !(d && d.progress)) || k === 'online') paint(); });
    return { node: n, off: un, paint: paint };
  }

  /**
   * What the server made of an uploaded visit: state words, the summary, the
   * ten-minute audio link, the retries. Re-read on the phone's own events AND
   * every 15 s while the server is still working on it (2026-10-15: it was read
   * once and never refreshed). Returns stop().
   */
  function serverDetail(row, box, onDoc) {
    var stopped = false;
    var timer = null;
    var playing = false;
    function settled(doc) {
      var p = doc && doc.pipelineStatus;
      return !doc || ['ready', 'failed', 'notes_failed', 'skipped', 'quarantined_consent', 'discarded'].indexOf(p) !== -1;
    }
    function paint() {
      if (stopped || !R.getServerDoc) return;
      R.getServerDoc(row.id).then(function (doc) {
        if (stopped) return;
        if (typeof onDoc === 'function') onDoc(doc);
        if (!doc) { schedule(null); return; }
        if (playing) { schedule(doc); return; }   // never pull the player out from under the person
        box.textContent = '';
        var pb = L.pipelineBadge(doc);
        if (pb) box.appendChild(el('div', 'nbd-vr-badge is-' + pb.tone, pb.text));
        var n = doc.notes;
        if (n && n.summary) box.appendChild(el('p', 'nbd-vr-line', n.summary));
        if (n && Array.isArray(n.promises) && n.promises.length) {
          box.appendChild(el('p', 'nbd-vr-note', 'Promises filed as tasks: ' + n.promises.map(function (p) { return (p.who === 'jo' ? 'You: ' : 'They: ') + p.text; }).join('; ')));
        }
        var acts = el('div', 'nbd-vr-actions');
        var said = el('p', 'nbd-vr-note', '');
        if (doc.pipelineStatus === 'notes_pending' || doc.pipelineStatus === 'notes_failed') {
          acts.appendChild(retryBtn('Retry notes', function () { return R.retryNotes(row.id); }, said));
        }
        if (L.canRetryTranscription(doc) && R.retryTranscription) {
          acts.appendChild(retryBtn('Retry transcription', function () { return R.retryTranscription(row.id); }, said));
        }
        if (doc.audioLive === true) {
          var pl = btn('Play audio', 'nbd-vr-quiet', function () {
            pl.disabled = true;
            R.audioUrl(row.id).then(function (r) {
              pl.disabled = false;
              if (!r.ok) { said.textContent = r.message || 'Could not open the audio.'; said.className = 'nbd-vr-note is-warn'; return; }
              // media-src in firebase.json admits https://storage.googleapis.com (the signed URL's host)
              var a = el('audio', 'nbd-vr-audio', '', { controls: 'controls', preload: 'none' });
              a.src = r.url;
              playing = true;
              box.appendChild(a);
              try { var pr = a.play(); if (pr && typeof pr.catch === 'function') pr.catch(function () {}); } catch (_) {}
            });
          });
          acts.appendChild(pl);
        }
        if (acts.childNodes.length) box.appendChild(acts);
        box.appendChild(said);
        schedule(doc);
      });
    }
    function schedule(doc) {
      if (stopped || timer || settled(doc)) return;
      timer = setTimeout(function () { timer = null; paint(); }, POLL_MS);
    }
    function retryBtn(label, call, said) {
      var b = btn(label, 'nbd-vr-quiet', function () {
        b.disabled = true;
        call().then(function (r) {
          if (r.ok) { b.textContent = 'Retrying - check back in a minute'; said.textContent = ''; return; }
          b.disabled = false;
          said.textContent = r.message || 'Could not retry right now.';
          said.className = 'nbd-vr-note is-warn';
        });
      });
      return b;
    }
    var un = R.subscribe(function (k, d) {
      if (k === 'row' && d && d.row && d.row.id === row.id && !d.progress && !playing) { if (timer) { clearTimeout(timer); timer = null; } paint(); }
    });
    paint();
    return function stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } un(); };
  }

  /**
   * opts.onDone: called once when the person is finished with this visit (Done,
   * an attach, Save unattached, or dismissing the sheet). The recovery walk uses
   * it to go on to the next recovered recording.
   */
  function showWho(row, notice, failed, opts) {
    opts = opts || {};
    var doneOnce = false;
    var onDone = function () { if (doneOnce) return; doneOnce = true; if (typeof opts.onDone === 'function') opts.onDone(); };
    var badge = liveBadgeNode(row.id, row.remoteOnly || row.pipelineStatus ? row : null);
    var body = [badge.node];
    if (failed) body.push(el('p', 'nbd-vr-note is-warn', 'NOT saved to the storage on this phone.'));
    if (notice) body.push(el('p', 'nbd-vr-note is-warn', notice));
    if (row.attachRefused) body.push(el('p', 'nbd-vr-note is-warn', L.attachNoteWords(row.attachRefused)));
    var chipsBox = el('div', 'nbd-vr-chips');
    var status = el('p', 'nbd-vr-note', '');
    var actions = el('div', 'nbd-vr-actions');
    var stopDetail = null;
    var sheetOpts = { onDismiss: onDone, cleanup: function () { badge.off(); if (stopDetail) stopDetail(); } };

    function finish(msg) {
      closeSheet();
      if (msg) toast(msg, 'ok');
      onDone();
    }
    function warn(msg) { status.textContent = msg; status.className = 'nbd-vr-note is-warn'; }
    function attachTo(leadId, apptId) {
      R.attach(row.id, leadId, { appointmentId: apptId }).then(function (r) {
        if (!r.ok) { warn(r.message || 'Could not attach.'); return; }
        row = r.row;
        // Say only what was really filed (2026-10-15: it said "Nothing else was filed." whatever happened).
        finish(L.attachToast(nameOf(leadId), r));
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
      body.push(el('p', 'nbd-vr-line', 'Attached to ' + nameOf(row.leadId) + '.'));
      var detail = el('div', 'nbd-vr-detail');
      body.push(detail);
      actions.appendChild(btn('Done', 'nbd-vr-primary', function () { finish(); }));
      var change = btn('Change customer', 'nbd-vr-quiet', function () {
        change.disabled = true;
        R.attach(row.id, null).then(function (r) {
          change.disabled = false;
          // It failed silently before (2026-10-15): say why, keep the sheet.
          if (!r || !r.ok) { warn((r && r.message) || 'Could not take the customer off right now. Try again with a signal.'); return; }
          closeSheet();
          showWho(r.row, '', false, opts);
        });
      });
      actions.appendChild(change);
      actions.appendChild(btn('Recent visits', 'nbd-vr-quiet', function () { closeSheet(); onDone(); openRecent(); }));
      body.push(actions);
      body.push(status);
      var h = openSheet(L.sheetTitle(row.remoteOnly ? null : row, null), body, sheetOpts);
      // the title follows the visit: re-read the phone's row with each server read
      stopDetail = serverDetail(row, detail, function (doc) {
        R._getVisit(row.id).then(function (local) { if (sheet === h.scrim) h.setTitle(L.sheetTitle(local || null, doc)); }, function () {});
      });
      return;
    }

    body.push(el('p', 'nbd-vr-line', 'Pick the customer so it files with them. Nothing is attached until you tap.'));
    body.push(chipsBox);
    body.push(status);
    actions.appendChild(btn('Search customer', 'nbd-vr-primary', function () { showSearch(row, opts); }));
    actions.appendChild(btn('Save unattached', 'nbd-vr-quiet', function () { finish('Saved. Find it under Unfiled visits.'); }));
    body.push(actions);
    openSheet('Who was this?', body, sheetOpts);

    chipsBox.appendChild(el('p', 'nbd-vr-note', 'Looking for likely matches...'));
    Promise.all([appointmentsNear(row.startedAtMs), R.getServerDoc ? R.getServerDoc(row.id) : Promise.resolve(null)]).then(function (res) {
      var appts = res[0], server = res[1];
      var local = L.suggest({ startedAtMs: row.startedAtMs, preLeadId: row.leadId, appointments: appts, recentIds: recentIds(), leads: allLeads() });
      var chips = L.mergeChips(server, local, allLeads());
      chipsBox.textContent = '';
      var pb = server ? L.pipelineBadge(server) : null;
      if (pb) chipsBox.appendChild(el('div', 'nbd-vr-badge is-' + pb.tone, pb.text));
      if (!chips.length) { chipsBox.appendChild(el('p', 'nbd-vr-note', 'No likely match. Search for the customer, or save it unattached.')); return; }
      chips.forEach(function (c) { chipsBox.appendChild(chip(c, c.kind === 'appointment' ? L.appointmentIdFor(appts, c.leadId) : null)); });
      if (chips.some(function (c) { return c.kind === 'server'; })) {
        var no = btn('Not these', 'nbd-vr-quiet', function () {
          no.disabled = true;
          R.dismissSuggestions(row.id).then(function (r) {
            if (!r.ok) { no.disabled = false; warn(r.message); return; }
            chipsBox.textContent = '';
            chipsBox.appendChild(el('p', 'nbd-vr-note', 'Okay. Search for the customer, or save it unattached.'));
          });
        });
        chipsBox.appendChild(no);
      }
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
  function showSearch(row, opts) {
    opts = opts || {};
    var doneOnce = false;
    var onDone = function () { if (doneOnce) return; doneOnce = true; if (typeof opts.onDone === 'function') opts.onDone(); };
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
            closeSheet(); toast(L.attachToast(L.leadName(l), r), 'ok'); onDone();
          });
        });
        results.appendChild(b);
      });
    }
    input.addEventListener('input', renderResults);
    var actions = el('div', 'nbd-vr-actions');
    actions.appendChild(btn('Back', 'nbd-vr-quiet', function () { showWho(row, '', false, opts); }));
    openSheet('Search customer', [input, results, status, actions], { onDismiss: onDone });
    try { input.focus(); } catch (_) {}
  }

  // ── recovery: every recovered recording, oldest first, one after another ─
  // "Save it" used to open "Who was this?" for the first one and drop the rest,
  // which then sat on the phone for ever, never uploaded (2026-10-15).
  var recQueue = [];
  var recCurrent = null;
  function showRecovered(rows) {
    (rows || []).forEach(function (r) {
      if (!r || !r.id || r.id === recCurrent || recQueue.some(function (q) { return q.id === r.id; })) return;
      recQueue.push(r);
    });
    recQueue.sort(function (a, b) { return (a.startedAtMs || 0) - (b.startedAtMs || 0); });
    if (!recCurrent) nextRecovered();
  }
  function nextRecovered() {
    var r = recQueue.shift();
    if (!r) { recCurrent = null; return; }
    recCurrent = r.id;
    var when = new Date(r.startedAtMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    var more = recQueue.length;
    var body = [
      el('p', 'nbd-vr-line', 'Recovered a recording from ' + when + ' (' + L.formatClock(r.durationSec || 0) + '). The app closed before it was saved.'),
      el('p', 'nbd-vr-note', 'It is still on this phone. Save it, or discard it.' + (more ? ' ' + more + (more === 1 ? ' more recovered recording comes' : ' more recovered recordings come') + ' after this one.' : '')),
    ];
    var actions = el('div', 'nbd-vr-actions');
    actions.appendChild(btn('Save it', 'nbd-vr-primary', function () {
      R.confirmRecovered(r.id).then(function (row) {
        closeSheet();
        if (row) showWho(row, '', false, { onDone: nextRecovered });
        else nextRecovered();
      }, function () { closeSheet(); nextRecovered(); });
    }));
    var del = btn('Discard', 'nbd-vr-quiet', function () {
      if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Tap again to delete it'; return; }
      del.disabled = true;
      R.discard(r.id).then(function () { closeSheet(); nextRecovered(); }, function () { closeSheet(); nextRecovered(); });
    });
    actions.appendChild(del);
    body.push(actions);
    openSheet(more ? 'Recovered recordings' : 'Recovered a recording', body, { dismissible: false });
  }
  // A recording cut off moments ago may only be provably cut off after its heartbeat goes
  // quiet; the core looks again then and announces it here.
  R.subscribe(function (k, d) {
    if (k === 'recoverable' && d && d.rows && d.rows.length && !R.getState().active) showRecovered(d.rows);
  });

  // ── unfiled visits (+ recent visits) ────────────────────────────────────
  function whenOf(r) {
    var when = new Date(r.startedAtMs || Date.now());
    return when.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
      when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' - ' + L.formatClock(r.durationSec || 0);
  }
  /**
   * The Unfiled visits sheet, and below it "Recent visits": every visit from the
   * last 14 days, attached or not, with where it is (a visit that failed on the
   * server is not hidden just because it is on a customer).
   * Re-rendered at most every 1.2 s, never for upload-progress ticks (it re-read
   * both lists every ~400 ms during an upload), and a Discard that is armed stays
   * armed across a re-render.
   */
  function openList(focus) {
    var wrap = el('div', 'nbd-vr-list');
    // Under the Unfiled list, the recent visits NOT already listed above (on a customer,
    // or not kept); on its own (openRecent), all of them.
    var recentHead = el('div', 'nbd-vr-item-title', focus === 'recent' ? 'Recent visits (last 14 days)' : 'Other recent visits (last 14 days)');
    var recentWrap = el('div', 'nbd-vr-list');
    var actions = el('div', 'nbd-vr-actions');
    actions.appendChild(btn('Close', 'nbd-vr-quiet', closeSheet));
    var off = null;
    var timer = null;
    var armed = {};
    var lastSig = '';
    var nodes = focus === 'recent' ? [recentHead, recentWrap, actions] : [wrap, recentHead, recentWrap, actions];
    var h = openSheet(focus === 'recent' ? 'Recent visits' : 'Unfiled visits', nodes, {
      cleanup: function () { if (off) off(); if (timer) { clearTimeout(timer); timer = null; } },
    });
    function schedule() {
      if (timer) return;
      timer = setTimeout(function () { timer = null; render(); }, 1200);
    }
    function render() {
      R.listAll().then(function (res) {
        if (!sheet || sheet !== h.scrim) return;   // the sheet went while the lists were read
        var all = L.recentVisits(res.local, res.remote, Date.now(), 36500);
        var unfiled = all.filter(function (r) { return L.isUnfiled(r) && !(r.remoteOnly && r.status !== 'uploaded'); });
        var shown = {};
        if (focus !== 'recent') unfiled.forEach(function (r) { shown[r.id] = true; });
        var recent = L.recentVisits(res.local, res.remote, Date.now(), 14).filter(function (r) { return !shown[r.id]; });
        var on = online();
        var sig = JSON.stringify([unfiled, recent].map(function (list) {
          return list.map(function (r) { return [r.id, r.leadId || '', L.visitStatus(r, on).text, armed[r.id] ? 1 : 0, r.notes && r.notes.summary ? 1 : 0]; });
        }));
        if (sig === lastSig) return;
        lastSig = sig;
        wrap.textContent = '';
        if (!unfiled.length) wrap.appendChild(el('p', 'nbd-vr-note', 'Nothing waiting. Every visit you recorded is filed or discarded.'));
        unfiled.forEach(function (r) { wrap.appendChild(rowNode(r, true)); });
        recentWrap.textContent = '';
        if (!recent.length) recentWrap.appendChild(el('p', 'nbd-vr-note', focus === 'recent' ? 'No visits recorded in the last 14 days.' : 'No other visits in the last 14 days.'));
        recent.forEach(function (r) { recentWrap.appendChild(rowNode(r, false)); });
      });
    }
    function rowNode(r, unfiledRow) {
      var n = el('div', 'nbd-vr-item');
      n.appendChild(el('div', 'nbd-vr-item-title', whenOf(r) + (r.leadId ? ' - ' + nameOf(r.leadId) : (unfiledRow ? '' : ' - not on a customer'))));
      var b = L.visitStatus(r, online());
      n.appendChild(el('div', 'nbd-vr-badge is-' + b.tone, b.text));
      if (r.attachRefused) n.appendChild(el('div', 'nbd-vr-note is-warn', L.attachNoteWords(r.attachRefused)));
      if (r.notes && r.notes.summary) n.appendChild(el('div', 'nbd-vr-note', r.notes.summary));
      if (unfiledRow && Array.isArray(r.suggestions) && r.suggestions.length) {
        var s0 = r.suggestions[0];
        n.appendChild(el('div', 'nbd-vr-note', 'Looks like ' + (s0.name || 'a customer') + (s0.evidence ? ' - ' + s0.evidence : '')));
      }
      var acts = el('div', 'nbd-vr-actions');
      acts.appendChild(btn(r.leadId ? 'Open' : 'Attach', 'nbd-vr-primary', function () { closeSheet(); showWho(r, ''); }));
      if (!r.remoteOnly && !r.tooLarge && (r.status === 'failed' || r.status === 'stored' || (r.status === 'uploaded' && r.docSynced === false))) {
        acts.appendChild(btn('Retry now', 'nbd-vr-quiet', function () { R.retryNow().then(render); }));
      }
      if (unfiledRow) {
        var del = btn(armed[r.id] ? 'Tap again to delete' : 'Discard', 'nbd-vr-quiet', function () {
          if (!armed[r.id]) { armed[r.id] = true; del.textContent = 'Tap again to delete'; return; }
          del.disabled = true;
          delete armed[r.id];
          R.discard(r.id).then(render);
        });
        acts.appendChild(del);
      }
      n.appendChild(acts);
      return n;
    }
    off = R.subscribe(function (k, d) {
      if (k === 'row' && d && d.progress) return;   // upload ticks change nothing worth re-reading for
      if (k === 'row' || k === 'online') schedule();
    });
    render();
    return h;
  }
  function openUnfiled() { return openList('unfiled'); }
  function openRecent() { return openList('recent'); }

  window.NBDVisitRecorderUI = {
    begin: begin, openUnfiled: openUnfiled, openRecent: openRecent, showRecovered: showRecovered, showWho: showWho,
    close: closeSheet, isRecording: function () { return !!R.getState().active; },
    // The live panel may need re-mounting after a full-screen modal covered it.
    ensureLive: function () { if (R.getState().active) mountLive(); },
  };
})();
