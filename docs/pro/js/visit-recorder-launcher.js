/**
 * visit-recorder-launcher.js - the ~boot-time half of the visit recorder
 * (window.NBDVisitRecorderLauncher). Small on purpose: it owns the ENTRY
 * POINTS and nothing heavy. The recorder, its IndexedDB store and its screens
 * (visit-recorder*.js + css) are fetched on the first tap, or when the phone
 * is holding a recording that still has to be saved or uploaded.
 *
 *   documentation/projects/VISIT-RECORDER-PR1-2026-10-13.md
 *
 * Entry points (all end in NBDVisitRecorderUI.begin()):
 *   - any element with data-nbd-record-visit (delegated; optional
 *     data-lead-id, data-appointment-id, data-source)
 *   - the Record bar on Home (dashboard.html, #view-home) in Classic and
 *     Bento; Island has it in its dock and the full-screen layouts in their
 *     own screens (js/layouts/kit.js recordButton), all via the delegate
 *   - "Record visit" on today's appointment rows (decorated here, so the
 *     Today files are untouched) - pre-attaches lead + appointment
 *   - "Record visit" in the customer page quick-actions - pre-attaches lead
 *   - the deep link  ?capture=1[&lead=<id>]
 *   - Unfiled visits: the Home bar badge, or NBDVisitRecorderLauncher.openUnfiled()
 *
 * Also here, owner/manager only: the per-customer "do not record" toggle on
 * the customer page, and the owner's recording-reminder switch in
 * Settings > Company. Both are mounted by this file so no Settings or
 * customer template changes.
 */
(function () {
  'use strict';
  if (window.NBDVisitRecorderLauncher) return;

  var V = '3';
  var FILES = [
    '/pro/css/visit-recorder.css?v=3',   // = BAR_CSS below
    '/pro/js/visit-recorder-logic.js?v=' + V,
    '/pro/js/visit-recorder.js?v=' + V,
    '/pro/js/visit-recorder-ui.js?v=' + V,
  ];
  // PR 2: the one "N unfiled visits" Today row. Its own file so the Today PRs are
  // untouched, and best-effort: the recorder works without it.
  var TODAY_FILE = '/pro/js/visit-unfiled-today.js?v=' + V;
  // The bar's stylesheet has its own version: only its bar placement changes
  // here, and the recorder files above keep theirs.
  var BAR_CSS = '/pro/css/visit-recorder.css?v=3';
  // The same words on every entry point, in every layout (kit.js RECORD_LABEL).
  var RECORD_LABEL = 'Record visit';
  var RECENT_LABEL = 'Recent visits';
  var CFG_KEY = 'nbd_vr_cfg';
  var UNFILED_KEY = 'nbd_vr_unfiled';
  var PENDING_KEY = 'nbd_vr_pending';

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, String(v)); } catch (_) {} }
  function claims() { try { return window._userClaims || {}; } catch (_) { return {}; } }
  function uid() { try { return (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null; } catch (_) { return null; } }
  function role() { return String(claims().role || ''); }
  /** Owner-level: no role claim (solo owner) or company_admin. */
  // Claims arrive after sign-in; an empty role before that is "unknown", not "owner".
  function claimsKnown() { try { return !!(window._userClaims && typeof window._userClaims === 'object'); } catch (_) { return false; } }
  function isOwner() { if (!claimsKnown()) return false; var r = role(); return r === '' || r === 'company_admin' || r === 'admin'; }
  function isStaff() { if (!claimsKnown()) return false; var r = role(); return r === '' || r === 'company_admin' || r === 'manager' || r === 'admin'; }

  // ── lazy load ───────────────────────────────────────────────────────────
  var loading = null;
  function loadOne(src) {
    return new Promise(function (resolve, reject) {
      var key = src.split('?')[0];
      var have = document.querySelector('[data-nbd-vr-src="' + key + '"]');
      if (have) { resolve(); return; }
      var n;
      if (/\.css(\?|$)/.test(src)) {
        n = document.createElement('link'); n.rel = 'stylesheet'; n.href = src;
      } else {
        n = document.createElement('script'); n.src = src; n.async = false;
      }
      n.setAttribute('data-nbd-vr-src', key);
      n.onload = function () { resolve(); };
      n.onerror = function () { try { n.remove(); } catch (_) {} reject(new Error('load-failed ' + key)); };
      document.head.appendChild(n);
    });
  }
  function load() {
    if (window.NBDVisitRecorderUI && window.NBDVisitRecorder) return Promise.resolve();
    if (loading) return loading;
    loading = FILES.reduce(function (p, src) { return p.then(function () { return loadOne(src); }); }, Promise.resolve())
      .then(function () {
        if (!window.NBDVisitRecorderUI) throw new Error('recorder-missing');
        // keep the Home badge true as the recorder changes things
        window.NBDVisitRecorder.subscribe(function (k) { if (k === 'counters') paintBar(); });
        loadOne(TODAY_FILE).catch(function () {});
      })
      .catch(function (e) { loading = null; throw e; });
    return loading;
  }
  function toast(msg, tone) {
    try { if (typeof window.showToast === 'function') { window.showToast(msg, tone || 'info'); return; } } catch (_) {}
    console.warn('[visit-recorder]', msg);
  }

  // ── start ───────────────────────────────────────────────────────────────
  function begin(o) {
    return load().then(function () {
      if (window.NBDVisitRecorder.getState().active) { window.NBDVisitRecorderUI.ensureLive(); return null; }
      return window.NBDVisitRecorderUI.begin(o || {});
    }).catch(function () {
      toast('Could not load the recorder. Check your signal and try again.', 'error');
      return null;
    });
  }
  function fromElement(t) {
    var d = t.dataset || {};
    return { leadId: d.leadId || null, appointmentId: d.appointmentId || null, source: d.source || 'fab' };
  }
  function onClick(e) {
    var r = e.target && e.target.closest ? e.target.closest('[data-nbd-recent-visits]') : null;
    if (r) { e.preventDefault(); openRecent(); return; }
    var t = e.target && e.target.closest ? e.target.closest('[data-nbd-record-visit]') : null;
    if (!t) return;
    e.preventDefault();
    begin(fromElement(t));
  }

  // ── auth + counters ─────────────────────────────────────────────────────
  function whenAuth(cb, maxMs) {
    var t0 = Date.now();
    (function poll() {
      if (uid()) { cb(); return; }
      if (Date.now() - t0 > (maxMs || 180000)) return;   // slow auth restores happen; later events re-arm too
      setTimeout(poll, Date.now() - t0 < 10000 ? 400 : 2000);
    })();
  }
  function companyId() { return claims().companyId || uid(); }
  function counters() {
    return { unfiled: parseInt(lsGet(UNFILED_KEY) || '0', 10) || 0, pending: parseInt(lsGet(PENDING_KEY) || '0', 10) || 0 };
  }
  /**
   * Once per page load, after sign-in and the page has settled: load the recorder,
   * read the company's consent setting, find a recording a killed app left behind,
   * and push anything waiting. NOT gated on the localStorage counters: those are
   * cleared by a logout and by iOS, and a counter that says 0 while rows wait
   * would strand the recording. Opening IndexedDB here is the point.
   */
  var booted = false;
  function bootRecorder() {
    if (booted || !uid()) return;
    booted = true;
    load().then(function () {
      var R = window.NBDVisitRecorder;
      R.wire();
      R.refreshConfig();
      return R.recoverInterrupted().then(function (rows) {
        if (rows && rows.length && !R.getState().active) window.NBDVisitRecorderUI.showRecovered(rows);
        return R.drain('boot');
      });
    }).then(function () { return window.NBDVisitRecorder.refreshCounters(); })
      .catch(function () { booted = false; });
  }
  /** A later event (back in the app, signal returned) with rows known to be waiting: look again. */
  var lastLook = 0;
  function lookAgain() {
    if (!uid()) return;
    if (!booted) { bootRecorder(); return; }
    var t = Date.now();
    if (t - lastLook < 5000 || !counters().pending) return;
    lastLook = t;
    load().then(function () {
      var R = window.NBDVisitRecorder;
      if (R.getState().active) return null;
      return R.recoverInterrupted().then(function (rows) {
        if (rows && rows.length) window.NBDVisitRecorderUI.showRecovered(rows);
        return R.drain('boot');
      });
    }).catch(function () {});
  }

  // ── the Home bar ────────────────────────────────────────────────────────
  var bar = null;
  var unfiledBtn = null;
  // ONE Record visit entry per layout (2026-10-15). The floating bar is
  // Classic's and Bento's. Island puts Record visit in its dock, and the
  // full-screen layouts (Field, Focus, Inbox, Mission, Crew) draw it in their
  // own screens (js/layouts/kit.js recordButton), all through the same
  // [data-nbd-record-visit] delegate below.
  var BAR_LAYOUTS = { classic: 1, bento: 1 };
  function layoutWantsBar() {
    var id = document.documentElement.getAttribute('data-layout');
    return !id || BAR_LAYOUTS[id] === 1;
  }
  function paintBar() {
    if (!bar) return;
    var home = document.getElementById('view-home');
    var show = !!(home && home.classList.contains('active')) && layoutWantsBar();
    bar.hidden = !show;
    // visit-recorder.css reserves room under Home's content while the bar shows
    document.documentElement.classList.toggle('nbd-vr-bar-on', show);
    var n = counters().unfiled;
    unfiledBtn.hidden = n < 1;
    unfiledBtn.textContent = 'Unfiled visits (' + n + ')';
  }
  function mountBar() {
    if (bar || !document.getElementById('view-home')) return;
    // the bar needs its stylesheet at boot: one small link, the rest stays lazy
    if (!document.querySelector('[data-nbd-vr-src="/pro/css/visit-recorder.css"]')) {
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = BAR_CSS; l.setAttribute('data-nbd-vr-src', '/pro/css/visit-recorder.css');
      document.head.appendChild(l);
    }
    bar = document.createElement('div');
    bar.className = 'nbd-vr-bar';
    bar.id = 'nbd-vr-bar';
    bar.hidden = true;
    var rec = document.createElement('button');
    rec.type = 'button';
    rec.className = 'nbd-vr-barbtn';
    rec.setAttribute('data-nbd-record-visit', '');
    rec.setAttribute('data-source', 'fab');
    var dot = document.createElement('span'); dot.className = 'nbd-vr-bardot'; dot.setAttribute('aria-hidden', 'true');
    var txt = document.createElement('span'); txt.textContent = RECORD_LABEL;
    rec.appendChild(dot); rec.appendChild(txt);
    unfiledBtn = document.createElement('button');
    unfiledBtn.type = 'button';
    unfiledBtn.className = 'nbd-vr-unfiled';
    unfiledBtn.hidden = true;
    unfiledBtn.addEventListener('click', function () { openUnfiled(); });
    // Recent visits: the quiet second button beside Record (the unfiled
    // button's look; delegated through [data-nbd-recent-visits] like the rest)
    var recent = document.createElement('button');
    recent.type = 'button';
    recent.className = 'nbd-vr-unfiled nbd-vr-recent';
    recent.setAttribute('data-nbd-recent-visits', '');
    recent.textContent = RECENT_LABEL;
    bar.appendChild(rec); bar.appendChild(recent); bar.appendChild(unfiledBtn);
    document.body.appendChild(bar);
    paintBar();
  }
  function openUnfiled() {
    return load().then(function () { window.NBDVisitRecorderUI.openUnfiled(); }).catch(function () { toast('Could not load the recorder.', 'error'); });
  }
  /**
   * "Recent visits" (the last 14 days, NBDVisitRecorderUI.openRecent): every
   * [data-nbd-recent-visits] element, beside each Record visit entry. Same lazy
   * path as Record: the recorder files load first if they have not yet.
   */
  function openRecent() {
    return load().then(function () {
      var UI = window.NBDVisitRecorderUI;
      if (UI && typeof UI.openRecent === 'function') { UI.openRecent(); return; }
      toast('Recent visits are not available yet. Reload the app to get the latest version.', 'info');
    }).catch(function () { toast('Could not load the recorder. Check your signal and try again.', 'error'); });
  }

  // ── decorators (appointments, customer page, settings) ──────────────────
  function addApptButtons() {
    var rows = document.querySelectorAll('.tp-row[data-tp-row^="appt:"]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.querySelector('.nbd-vr-rowbtn')) continue;
      var acts = row.querySelector('.tp-acts');
      if (!acts) continue;
      var key = row.getAttribute('data-tp-row') || '';
      var leadId = '';
      var a = row.querySelector('a[href*="customer.html?id="], a[href*="customer?id="]');
      if (a) { try { leadId = new URL(a.getAttribute('href'), window.location.href).searchParams.get('id') || ''; } catch (_) {} }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tp-btn nbd-vr-rowbtn';
      b.textContent = RECORD_LABEL;
      b.setAttribute('data-nbd-record-visit', '');
      b.setAttribute('data-source', 'appointment');
      b.setAttribute('data-appointment-id', key.replace(/^appt:/, ''));
      if (leadId) b.setAttribute('data-lead-id', leadId);
      acts.appendChild(b);
    }
  }
  function pageLeadId() {
    try {
      var p = new URLSearchParams(window.location.search);
      return p.get('id') || (window._currentLead && (window._currentLead.id || window._currentLead.leadId)) || '';
    } catch (_) { return ''; }
  }
  function addCustomerButtons() {
    var qa = document.querySelector('.quick-actions');
    var id = pageLeadId();
    if (!qa || !id || !/customer/.test(window.location.pathname)) return;
    if (!qa.querySelector('.nbd-vr-custbtn')) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn nbd-vr-custbtn';
      b.id = 'nbd-vr-custbtn';
      b.textContent = RECORD_LABEL;
      b.title = 'Record this visit. It saves on your phone first, then uploads.';
      b.setAttribute('data-nbd-record-visit', '');
      b.setAttribute('data-source', 'customer');
      b.setAttribute('data-lead-id', id);
      qa.appendChild(b);
      var rv = document.createElement('button');
      rv.type = 'button';
      rv.className = 'btn nbd-vr-custbtn nbd-vr-recentbtn';
      rv.textContent = RECENT_LABEL;
      rv.setAttribute('data-nbd-recent-visits', '');
      qa.appendChild(rv);
    }
    if (isStaff() && !qa.querySelector('.nbd-vr-dnr')) {
      var d = document.createElement('button');
      d.type = 'button';
      d.className = 'btn nbd-vr-dnr';
      d.id = 'nbd-vr-dnr';
      d.addEventListener('click', toggleDnr);
      qa.appendChild(d);
      paintDnr();
    }
  }
  function currentLead() { try { return window._currentLead || null; } catch (_) { return null; } }
  function paintDnr() {
    var d = document.getElementById('nbd-vr-dnr');
    if (!d) return;
    var on = !!(currentLead() && currentLead().doNotRecord === true);
    d.textContent = on ? 'Recording: off for this customer' : 'Allow recording: on';
    d.setAttribute('aria-pressed', on ? 'true' : 'false');
    d.classList.toggle('is-on', on);
    d.title = on ? 'This customer is marked do not record. Tap to allow recording again.' : 'Tap to mark this customer do not record.';
    var rec = document.getElementById('nbd-vr-custbtn');
    if (rec) rec.disabled = on;
  }
  function toggleDnr() {
    var id = pageLeadId();
    var lead = currentLead();
    if (!id || !window.db || typeof window.updateDoc !== 'function' || typeof window.doc !== 'function') return;
    var next = !(lead && lead.doNotRecord === true);
    window.updateDoc(window.doc(window.db, 'leads', id), { doNotRecord: next }).then(function () {
      if (lead) lead.doNotRecord = next;
      paintDnr();
      toast(next ? 'Marked do not record. The recorder will refuse to start for this customer.' : 'Recording allowed again for this customer.', 'ok');
    }).catch(function () { toast('Could not save that. Try again.', 'error'); });
  }
  function addSettingsCard() {
    var panel = document.getElementById('stab-panel-company');
    if (!panel || panel.querySelector('#nbd-vr-setting') || !isOwner()) return;
    var card = document.createElement('div');
    card.className = 'nbd-vr-setting';
    card.id = 'nbd-vr-setting';
    var h = document.createElement('div'); h.className = 'nbd-vr-setting-title'; h.textContent = 'Visit recording';
    var p = document.createElement('p'); p.className = 'nbd-vr-setting-note';
    p.textContent = 'Ohio and Kentucky allow recording a conversation you are part of. This only adds a reminder line before each visit recording. It is off by default.';
    var label = document.createElement('label'); label.className = 'nbd-vr-setting-row';
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'nbd-vr-reminder';
    try { cb.checked = JSON.parse(lsGet(CFG_KEY) || '{}').reminder === true; } catch (_) {}
    var span = document.createElement('span'); span.textContent = 'Remind me to tell them I am recording';
    label.appendChild(cb); label.appendChild(span);
    var msg = document.createElement('div'); msg.className = 'nbd-vr-setting-msg'; msg.setAttribute('role', 'status');
    cb.addEventListener('change', function () {
      var id = companyId();
      if (!id || !window.db || typeof window.setDoc !== 'function' || typeof window.doc !== 'function') { msg.textContent = 'Not ready. Try again.'; return; }
      var want = cb.checked;
      window.setDoc(window.doc(window.db, 'companies', id), { visitRecordingReminder: want }, { merge: true }).then(function () {
        var c = {}; try { c = JSON.parse(lsGet(CFG_KEY) || '{}') || {}; } catch (_) {}
        c.reminder = want; c.companyId = id; if (!c.consentMode) c.consentMode = 'one_party';
        lsSet(CFG_KEY, JSON.stringify(c));
        msg.textContent = want ? 'Saved. The reminder shows before each recording.' : 'Saved. No reminder.';
      }).catch(function () { cb.checked = !want; msg.textContent = 'Could not save. Only the owner can change this.'; });
    });
    // Raw audio retention (PR 2): the daily cleanup deletes the audio of visit recordings
    // after this many days. The transcript and the notes stay. Default 90, 7 to 3650.
    var keepRow = document.createElement('label'); keepRow.className = 'nbd-vr-setting-row';
    var keepIn = document.createElement('input'); keepIn.type = 'number'; keepIn.id = 'nbd-vr-retention';
    keepIn.min = '7'; keepIn.max = '3650'; keepIn.step = '1'; keepIn.value = '90'; keepIn.className = 'nbd-vr-setting-num';
    keepIn.setAttribute('inputmode', 'numeric');
    var keepSpan = document.createElement('span'); keepSpan.textContent = 'Keep the raw audio for this many days (the transcript and notes stay)';
    keepRow.appendChild(keepSpan); keepRow.appendChild(keepIn);
    try {
      var cur = JSON.parse(lsGet(CFG_KEY) || '{}').retentionDays;
      if (cur) keepIn.value = String(cur);
      var cid = companyId();
      if (cid && window.db && typeof window.getDoc === 'function' && typeof window.doc === 'function') {
        window.getDoc(window.doc(window.db, 'companies', cid)).then(function (snap) {
          var d = snap && typeof snap.data === 'function' ? snap.data() : null;
          var v = d && Number(d.recordingRetentionDays);
          if (v >= 7 && v <= 3650) keepIn.value = String(v);
        }).catch(function () {});
      }
    } catch (_) {}
    keepIn.addEventListener('change', function () {
      var id = companyId();
      var n = Math.round(Number(keepIn.value));
      if (!(n >= 7 && n <= 3650)) { msg.textContent = 'Pick a number from 7 to 3650.'; return; }
      if (!id || !window.db || typeof window.setDoc !== 'function' || typeof window.doc !== 'function') { msg.textContent = 'Not ready. Try again.'; return; }
      window.setDoc(window.doc(window.db, 'companies', id), { recordingRetentionDays: n }, { merge: true }).then(function () {
        var c = {}; try { c = JSON.parse(lsGet(CFG_KEY) || '{}') || {}; } catch (_) {}
        c.retentionDays = n; lsSet(CFG_KEY, JSON.stringify(c));
        msg.textContent = 'Saved. Audio older than ' + n + ' days is deleted each night.';
      }).catch(function () { msg.textContent = 'Could not save. Only the owner can change this.'; });
    });
    card.appendChild(h); card.appendChild(p); card.appendChild(label); card.appendChild(keepRow); card.appendChild(msg);
    panel.appendChild(card);
  }

  // ── one debounced observer for everything we decorate ───────────────────
  var scheduled = false;
  function decorate() {
    scheduled = false;
    try { paintBar(); addApptButtons(); addCustomerButtons(); addSettingsCard(); } catch (e) { console.warn('[visit-recorder] decorate', e); }
  }
  function scheduleDecorate() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(decorate, 250);
  }
  function observe() {
    if (typeof MutationObserver !== 'function') return;
    var mo = new MutationObserver(scheduleDecorate);
    var targets = [document.getElementById('view-home'), document.getElementById('view-settings')];
    targets.forEach(function (t) { if (t) mo.observe(t, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); });
    if (/customer/.test(window.location.pathname)) {
      var qa = document.querySelector('.quick-actions');
      if (qa) mo.observe(qa, { childList: true });
    }
  }

  // ── deep link ───────────────────────────────────────────────────────────
  function handleDeepLink() {
    var p;
    try { p = new URLSearchParams(window.location.search); } catch (_) { return; }
    if (p.get('capture') !== '1') return;
    var lead = p.get('lead') || '';
    // strip the params so a reload or a back-navigation never re-starts a recording
    try {
      p.delete('capture'); p.delete('lead');
      var qs = p.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
    } catch (_) {}
    whenAuth(function () {
      // Opened from outside the app there is no tap, so a browser may refuse the
      // microphone; begin() then shows the problem and the Record bar is one tap.
      // With a lead in the link, wait (briefly) for the customer list so the
      // do-not-record flag is known BEFORE the microphone opens; the recorder
      // also re-checks the lead doc itself if the list never arrives.
      var t0 = Date.now();
      (function go() {
        if (lead && window._leadsLoaded !== true && Date.now() - t0 < 8000 && !/customer/.test(window.location.pathname)) { setTimeout(go, 250); return; }
        begin({ leadId: lead || null, source: 'deeplink' });
      })();
    }, 45000);
  }

  function init() {
    document.addEventListener('click', onClick);
    mountBar();
    decorate();
    observe();
    handleDeepLink();
    whenAuth(function () {
      paintBar();
      // Fetch + start the recorder once the page has settled (NOT on the boot path),
      // so a recording started with no signal in a basement does not need the
      // network to load its own code. ~50 KB, parsed on idle.
      setTimeout(function () {
        var go = function () { bootRecorder(); };
        if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(go, { timeout: 8000 });
        else go();
      }, 4000);
    });
    // _currentLead arrives after the page's own boot; paint the toggle again
    setTimeout(decorate, 1500); setTimeout(decorate, 4000);
    window.addEventListener('online', lookAgain);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') lookAgain(); });
    window.addEventListener('storage', function (e) { if (e.key === UNFILED_KEY || e.key === PENDING_KEY) paintBar(); });
    // the bar is Classic's and Bento's: follow a layout switch (layout-system.js)
    document.addEventListener('layoutchange', paintBar);
  }

  window.NBDVisitRecorderLauncher = {
    begin: begin, openUnfiled: openUnfiled, openRecent: openRecent, load: load, decorate: decorate,
    // Called by the recorder after any change so the Home badge stays true.
    paint: paintBar,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
