/**
 * os/shutdown.js — the NBD OS Shutdown ritual, browser half (2026-11-09, P1;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6.2).
 *
 * window.NBDOSShutdown:
 *   widget(size, cfg)  the home widget's body (os/home.js paints it). Quiet
 *                      outside 4 PM - 8 PM local: no number, just "Close out
 *                      now". Inside the window: how many of the rep's own leads
 *                      touched today have no next step, and the promises past
 *                      due, counted from _leads and the Today plan in memory
 *                      (0 reads). No badge, no notification, ever.
 *   open(opts)         the Shutdown sheet: a native <dialog> (showModal, like the
 *                      Add widget sheet) listing os/shutdown-logic.js's rows:
 *                        lead     Tomorrow / +3 days / +1 week, one tap each,
 *                                 through followup-deck.js setFollowUp (the
 *                                 existing followUp writer, the one the No next
 *                                 step card uses), with Undo in the sheet and on
 *                                 the house toast; Open (the customer page)
 *                        visit    Attach visit (the recorder's Unfiled sheet)
 *                        promise  Open
 *                      and ends with "Loop closed: N leads, N visits" from the
 *                      counts. Today's visits are read when the sheet opens
 *                      (NBDVisitRecorder.listAll: this phone's rows plus one
 *                      query of the server's); never on a widget paint.
 *
 * The OS writes no CRM data of its own: the only write is setFollowUp's
 * `followUp` + `updatedAt` (and its undo). What is still open is kept for the
 * Welcome Recap (P2) in localStorage nbd_os_carry, ids only, this uid's,
 * today's; an nbd_ key, so sign-out wipes it.
 *
 * Loaded as the runtime ScriptLoader bundle `osshutdown` (css/os/shutdown.css,
 * os/shutdown-logic.js, this file), registered and loaded by os/home.js the
 * first time a Shutdown widget paints. Every value goes into the DOM escaped;
 * no inline handlers, no style attributes, no motion.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var doc = W && W.document;
  if (!W || !doc || W.NBDOSShutdown) return;
  var SL = W.NBDOSShutdownLogic;
  if (!SL) return;

  var EVENT = 'nbd:os-shutdown';   // os/home.js repaints its widgets on it

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function lsSet(k, v) { try { W.localStorage.setItem(k, v); } catch (e) {} }
  function toast(m, t) { if (typeof W.showToast === 'function') { try { W.showToast(m, t || 'info'); } catch (e) {} } }
  function notify() { try { W.dispatchEvent(new W.CustomEvent(EVENT)); } catch (e) {} }
  function uid() { return String((W._user && W._user.uid) || ''); }
  function leads() { return W._leadsLoaded === true && Array.isArray(W._leads) ? W._leads : null; }
  function plan() {
    var T = W.NBDToday;
    try { return T && typeof T.last === 'function' ? T.last() : null; } catch (e) { return null; }
  }
  function leadById(id) { return (W._leads || []).filter(function (l) { return l && l.id === id; })[0] || null; }
  function compute(visits) {
    var VL = W.NBDVisitRecorderLogic;
    return SL.build({
      leads: leads() || [], uid: uid(), now: Date.now(), taskCache: W._taskCache || {}, visits: visits === undefined ? null : visits, plan: plan(),
      stageRole: typeof W.stageRole === 'function' ? W.stageRole : null,
      normalizeStage: typeof W.normalizeStage === 'function' ? W.normalizeStage : null,
      isUnfiled: VL && typeof VL.isUnfiled === 'function' ? VL.isUnfiled : null,
    });
  }
  function custHref(id) { return '/pro/customer.html?id=' + encodeURIComponent(id); }
  function plural(n, one, many) { return String(n) + ' ' + (n === 1 ? one : many); }

  // ── the widget ─────────────────────────────────────────────
  var TITLE = '<h3 class="os-hw-title">Shutdown</h3>';
  function widget(size) {
    var now = Date.now();
    if (!SL.inWindow(now)) {
      // quiet: no count, no colour, nothing that asks for attention
      return TITLE + (size === 's' ? '' : '<p class="os-hw-empty">Close out your day from 4 PM.</p>') +
        '<button type="button" class="ui-btn-quiet os-hw-btn os-sd-go" data-oshw-sd="open">Close out now</button>';
    }
    if (!leads() || !uid()) return TITLE + '<p class="os-hw-empty">Getting your day ready…</p>';
    var r = compute();
    if (!r.leads) {   // no-next-step.js missing: the leads are unknown, so no count and no "all closed"
      return TITLE + (size === 's' ? '' : '<p class="os-hw-empty">Couldn\'t check your leads.</p>') +
        '<button type="button" class="ui-btn-quiet os-hw-btn os-sd-go" data-oshw-sd="open">Open Shutdown</button>';
    }
    var n = r.leads.length + r.promises.length;
    if (size === 's') {
      return TITLE + '<button type="button" class="os-hw-row os-sd-s" data-oshw-sd="open">' +
        (n ? '<span class="os-sd-big ui-num">' + esc(String(n)) + '</span><span class="os-sd-to">to close</span>'
          : '<span class="os-hw-row-name">All closed</span>') + '</button>';
    }
    var h = TITLE + '<p class="os-hw-next os-sd-line">' + esc(SL.widgetLine(r)) + '</p>';
    if (size === 'l' && n) {
      h += '<div class="os-hw-rows">' + r.leads.concat(r.promises).slice(0, 3).map(function (x) {
        return '<button type="button" class="os-hw-row" data-oshw-sd="open"><span class="os-hw-row-name">' + esc(x.name) + '</span>' +
          '<span class="os-hw-row-sub">' + esc(x.kind === 'promise' ? 'Promise past due' : x.words) + '</span></button>';
      }).join('') + '</div>';
    }
    return h + '<button type="button" class="btn btn-ghost os-hw-btn os-sd-go" data-oshw-sd="open">' + (n ? 'Close the loop' : 'Open Shutdown') + '</button>';
  }

  // ── the sheet ──────────────────────────────────────────────
  var sheet = null;   // { d, visits, busy, last, returnFocus }
  function when(ymd) {
    try { return new Date(ymd + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { return ymd; }
  }
  function timeOf(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
  }
  var FU = [[1, 'Tomorrow'], [3, '+3 days'], [7, '+1 week']];
  function isViewer() { return ((W._userClaims || {}).role || '') === 'viewer'; }
  function leadRow(x, busy) {
    var dis = busy ? ' disabled' : '';
    if (isViewer()) {   // a viewer changes nothing: Open only
      return '<li class="os-sd-row" data-sd-row="' + esc(x.id) + '"><div class="os-sd-txt"><span class="os-sd-name">' + esc(x.name) + '</span>' +
        '<span class="os-sd-sub">' + esc([x.words, x.place].filter(Boolean).join(' · ')) + '</span></div>' +
        '<div class="os-sd-acts"><a class="btn btn-ghost os-sd-btn" href="' + esc(custHref(x.leadId)) + '" aria-label="' + esc('Open ' + x.name) + '">Open</a></div></li>';
    }
    return '<li class="os-sd-row" data-sd-row="' + esc(x.id) + '"><div class="os-sd-txt"><span class="os-sd-name">' + esc(x.name) + '</span>' +
      '<span class="os-sd-sub">' + esc([x.words, x.place].filter(Boolean).join(' · ')) + '</span></div>' +
      '<div class="os-sd-acts" role="group" aria-label="' + esc('Next step for ' + x.name) + '">' + FU.map(function (f) {
        return '<button type="button" class="btn btn-ghost os-sd-btn" data-sd-fu="' + f[0] + '" data-sd-lead="' + esc(x.leadId) + '" aria-label="' +
          esc('Follow up with ' + x.name + ' ' + f[1].toLowerCase()) + '"' + dis + '>' + esc(f[1]) + '</button>';
      }).join('') + '<a class="btn btn-ghost os-sd-btn" href="' + esc(custHref(x.leadId)) + '" aria-label="' + esc('Open ' + x.name) + '">Open</a></div></li>';
  }
  function visitRow(x) {
    var t = timeOf(x.ms);
    return '<li class="os-sd-row" data-sd-row="' + esc(x.id) + '"><div class="os-sd-txt"><span class="os-sd-name">' + esc('Visit' + (t ? ' at ' + t : '')) + '</span>' +
      '<span class="os-sd-sub">Not on a customer yet</span></div>' +
      '<div class="os-sd-acts"><button type="button" class="btn btn-ghost os-sd-btn" data-sd-attach="' + esc(x.visitId) + '">Attach visit</button></div></li>';
  }
  function promiseRow(x) {
    return '<li class="os-sd-row" data-sd-row="' + esc(x.id) + '"><div class="os-sd-txt"><span class="os-sd-name">' + esc(x.name) + '</span>' +
      '<span class="os-sd-sub">' + esc('Promise past due' + (x.misses ? ' · missed ' + plural(x.misses, 'time', 'times') : '')) + '</span></div>' +
      '<div class="os-sd-acts"><a class="btn btn-ghost os-sd-btn" href="' + esc(custHref(x.leadId)) + '" aria-label="' + esc('Open ' + x.name) + '">Open</a></div></li>';
  }
  function section(title, list, fn) {
    return '<div class="os-sd-sec"><h3 class="os-sd-st">' + esc(title) + '</h3><ul class="os-sd-list">' + list.map(fn).join('') + '</ul></div>';
  }
  function render() {
    if (!sheet) return;
    var s = sheet;
    var r = compute(s.visits);
    var known = !!leads() && !!r.leads;   // false: loading, or no-next-step.js missing
    var h = '<div class="os-sd-hd"><h2 class="os-sd-title" id="osSdTitle">Shutdown</h2>' +
      '<button type="button" class="btn btn-ghost os-sd-close" data-sd-close="">Done</button></div>' +
      (r.open || !leads() ? '<p class="os-sd-lede">Every lead you touched today, with no next step yet. One tap each.</p>' : '');
    if (!leads() || !uid()) h += '<p class="os-sd-note">Your leads are still loading.</p>';
    else if (!r.leads) h += '<p class="os-sd-note">Couldn\'t check your leads.</p>';
    else if (r.leads.length) h += section('Touched today, no next step', r.leads, function (x) { return leadRow(x, !!s.busy[x.leadId]); });
    if (s.visits === undefined) h += '<p class="os-sd-note">Checking today\'s visits…</p>';
    else if (s.visits === null) h += '<p class="os-sd-note">Couldn\'t check today\'s visits.</p>';
    else if (r.visits && r.visits.length) h += section('Visits not filed', r.visits, visitRow);
    if (r.promises.length) h += section('Promises past due', r.promises, promiseRow);
    if (!r.open && known && s.visits !== undefined) h += '<p class="os-sd-note">Nothing left open. Every lead you touched today has a next step.</p>';
    if (s.last) {
      h += '<p class="os-sd-undo" role="status">' + esc(s.last.text) +
        ' <button type="button" class="ui-btn-quiet os-sd-btn" data-sd-undo="">Undo</button></p>';
    }
    var line = known ? SL.closedLine(r.closed) : '';
    h += '<div class="os-sd-ft"><p class="os-sd-closed" tabindex="-1">' + esc(line) + (line && r.open ? ' · ' + esc(String(r.open) + ' still open') : '') + '</p></div>';
    var keep = focusKey(s.d);
    s.d.innerHTML = h;
    if (keep) focusIn(keep);
    var c = SL.carry(r, uid(), Date.now());
    if (c && known) lsSet(SL.CARRY_KEY, JSON.stringify(c));
  }
  /** A repaint replaces the sheet's markup: the selector of the focused control, to put focus back on its twin. */
  function focusKey(d) {
    var a = doc.activeElement;
    if (!a || !d.contains(a) || a === d) return null;
    var row = a.closest ? a.closest('[data-sd-row]') : null;
    var pre = row ? '[data-sd-row="' + row.getAttribute('data-sd-row') + '"] ' : '';
    if (a.hasAttribute('data-sd-fu')) return pre + '[data-sd-fu="' + a.getAttribute('data-sd-fu') + '"]';
    if (a.hasAttribute('data-sd-attach')) return pre + '[data-sd-attach]';
    if (a.hasAttribute('data-sd-undo')) return '[data-sd-undo]';
    if (a.hasAttribute('data-sd-close')) return '[data-sd-close]';
    return row ? pre + 'a' : null;
  }
  function focusIn(sel) {
    var f = null;
    try { f = sheet && sheet.d.querySelector(sel); } catch (e) { f = null; }   // an id no selector can quote
    if (f) { try { f.focus({ preventScroll: false }); } catch (e) {} return true; }
    return false;
  }
  function readVisits() {
    var R = W.NBDVisitRecorder, Lv = W.NBDVisitRecorderLauncher;
    var ready = R && typeof R.listAll === 'function' ? Promise.resolve()
      : (Lv && typeof Lv.load === 'function' ? Promise.resolve().then(function () { return Lv.load(); }) : Promise.reject(new Error('no recorder')));
    return ready.then(function () {
      var Rv = W.NBDVisitRecorder;
      if (!Rv || typeof Rv.listAll !== 'function') return null;
      return Rv.listAll().then(function (res) {
        var local = (res && res.local) || [], remote = (res && res.remote) || [];
        var have = {};
        local.forEach(function (x) { if (x && x.id) have[x.id] = true; });
        return local.concat(remote.filter(function (x) { return x && x.id && !have[x.id]; }).map(function (x) { return Object.assign({ remoteOnly: true }, x); }));
      });
    }).catch(function () { return null; });
  }

  function followUp(leadId, days) {
    var s = sheet;
    var D = W.NBDFollowUpDeck;
    var lead = leadById(leadId);
    if (!s || s.busy[leadId]) return;
    if (!D || typeof D.setFollowUp !== 'function' || !lead) { toast('Follow-up tool not loaded. Refresh and try again.', 'error'); return; }
    var val = SL.followUpYmd(days, Date.now());
    var name = SL.nameOf(lead);
    s.busy[leadId] = true;
    render();
    Promise.resolve().then(function () { return D.setFollowUp(lead, val); }).then(function (res) {
      if (sheet !== s) { notify(); return; }
      delete s.busy[leadId];
      var text = 'Follow up with ' + name + ' ' + when(val) + '.';
      var done = false;
      var undo = function () {
        if (done) return Promise.resolve();
        done = true;
        if (sheet && sheet.last && sheet.last.undo === undo) sheet.last = null;
        return Promise.resolve(res && typeof res.undo === 'function' ? res.undo() : null).then(function () {
          if (sheet) { render(); focusIn('[data-sd-row="lead:' + leadId + '"] [data-sd-fu]'); }
          notify();
        }).catch(function (e) { done = false; toast('Undo failed: ' + ((e && e.message) || 'unknown'), 'error'); });
      };
      s.last = { text: text, undo: undo };
      render();
      notify();
      if (!focusIn('[data-sd-undo]')) focusIn('.os-sd-closed');
      if (typeof W.showToast === 'function') {
        try { W.showToast({ message: text, type: 'success', duration: 6000, undoText: 'Undo', undoAction: function () { undo(); } }); } catch (e) {}
      }
    }).catch(function (e) {
      if (sheet === s) { delete s.busy[leadId]; render(); }
      toast('Couldn\'t set the follow-up: ' + ((e && e.message) || 'unknown'), 'error');
    });
  }
  function attach() {
    var Lv = W.NBDVisitRecorderLauncher;
    close();
    if (Lv && typeof Lv.openUnfiled === 'function') { try { Lv.openUnfiled(); } catch (e) {} }
    else if (W.NBDVisitRecorderUI && typeof W.NBDVisitRecorderUI.openUnfiled === 'function') { try { W.NBDVisitRecorderUI.openUnfiled(); } catch (e) {} }
  }
  function close() { if (sheet && sheet.d.open) sheet.d.close(); else if (sheet) cleanup(); }
  function cleanup() {
    var s = sheet;
    if (!s) return;
    sheet = null;
    W.removeEventListener('nbd:data-refreshed', onData);
    if (s.d.parentNode) s.d.parentNode.removeChild(s.d);
    if (s.returnFocus && s.returnFocus.isConnected) { try { s.returnFocus.focus(); } catch (e) {} }
  }
  function onData() { render(); }
  function outside(d, ev) {
    var r = d.getBoundingClientRect();
    var x = ev.clientX, y = ev.clientY;
    return typeof x === 'number' && typeof y === 'number' && (x < r.left || y < r.top || x > r.left + r.width || y > r.top + r.height);
  }
  function open(opts) {
    var o = opts || {};
    if (sheet) { try { sheet.d.focus(); } catch (e) {} return sheet.d; }
    var d = doc.createElement('dialog');
    d.className = 'os-sd';
    d.setAttribute('aria-labelledby', 'osSdTitle');
    sheet = { d: d, visits: undefined, busy: {}, last: null, returnFocus: o.returnFocus || null };
    var s = sheet;
    d.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('[data-sd-close]') || (t === d && outside(d, ev))) { close(); return; }
      var fu = t.closest('[data-sd-fu]');
      if (fu) { if (!fu.hasAttribute('disabled')) followUp(fu.getAttribute('data-sd-lead'), Number(fu.getAttribute('data-sd-fu'))); return; }
      if (t.closest('[data-sd-undo]')) { if (s.last) s.last.undo(); return; }
      if (t.closest('[data-sd-attach]')) { attach(); return; }
    });
    d.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); } });
    d.addEventListener('close', cleanup);
    W.addEventListener('nbd:data-refreshed', onData);
    doc.body.appendChild(d);
    render();
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    if (!focusIn('[data-sd-fu]') && !focusIn('.os-sd-row a')) focusIn('[data-sd-close]');   // nothing is busy yet
    readVisits().then(function (v) {
      if (sheet !== s) return;
      s.visits = v;   // null: the visits could not be read, so their count stays unsaid
      render();
    });
    return d;
  }

  W.NBDOSShutdown = { widget: widget, open: open, close: close, EVENT: EVENT };
})();
