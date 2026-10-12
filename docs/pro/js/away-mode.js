/**
 * away-mode.js — Home status line + hand-back + backup cover list
 * (never-forget lane, 2026-10-12).
 *
 * Paints into #awayStatus (dashboard.html, above the needs-you strip):
 *
 *   owner / company_admin   "Away until Thu 6 PM — backup: Sam" + I'm back,
 *                           red when nobody is covering; and, after the
 *                           window ends, the "While you were away" card that
 *                           stays until Reviewed is tapped.
 *   the backup person       "Covering for Joe" — a minimal packet per
 *                           person (name, number, why, age) with I'm on it /
 *                           Called / Couldn't reach / Done + a short note.
 *                           Never an address, amount, note or lead link.
 *
 * Reads away_mode/{companyId} (status only; firestore.rules lets any member of
 * the company read it) and, for the owner, away_windows/{id} (the ledger).
 * Everything that WRITES goes through the manageAway callable. The wording of
 * the status line mirrors functions/away-mode-logic.js statusLine (a test runs
 * both on the same documents). No inline handlers: one delegated listener.
 * Settings UI lives in away-mode-settings.js.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDAway) return;
  var w = window, doc = document;
  var FUNCTIONS_SDK = '/assets/vendor/firebase/10.12.2/firebase-functions.js';
  var MIN = 60000;

  var state = { status: null, handBack: null, packets: null, windowId: '', loadedAt: 0, busy: false, seq: 0 };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, k) { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); }
  function uid() { return (w._user && w._user.uid) || null; }
  function claims() { return w._userClaims || {}; }
  function role() { return String(claims().role || '').toLowerCase(); }
  /** Owner or company_admin: the people manageAway lets act as the owner. */
  function isOwnerish() {
    var r = role(), c = claims();
    if (r === 'company_admin' || r === 'admin') return true;
    return !r && (!c.companyId || c.companyId === uid());
  }
  function companyKey() {
    if (typeof w._resolveCompanyKey === 'function') return Promise.resolve(w._resolveCompanyKey()).catch(function () { return null; });
    var c = claims();
    return Promise.resolve(c.companyId || uid() || null);
  }

  // ── mirror of functions/away-mode-logic.js (kept in step by the test) ──
  var ET = 'America/New_York';
  function fmtUntil(ms) {
    var d = new Date(ms);
    var day = d.toLocaleDateString('en-US', { timeZone: ET, weekday: 'short' });
    var time = d.toLocaleTimeString('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' }).replace(':00', '');
    return day + ' ' + time;
  }
  function statusLine(d, now) {
    d = d || {};
    var away = d.away || {};
    if (!away.on) return null;
    if (away.endMs && now >= away.endMs) return { text: "Your away window has ended — tap I'm back to see what happened", tone: 'warn', canImBack: true };
    var bs = d.backupState || 'none';
    var nm = d.backup && d.backup.name ? d.backup.name : '';
    var until = away.untilMs && away.untilMs > 0
      ? 'Away until ' + fmtUntil(away.untilMs)
      : 'Away — no end date (ends itself ' + fmtUntil(away.endMs || now) + ')';
    var behind = d.lastTickAtMs && now - d.lastTickAtMs > 45 * MIN;
    var text, tone = 'ok';
    if (bs === 'ok') text = until + ' — backup: ' + nm;
    else if (bs === 'unavailable') { text = until + ' — your backup' + (nm ? ' ' + nm : '') + ' is no longer active. Nobody is covering.'; tone = 'bad'; }
    else if (bs === 'unreachable') { text = until + ' — ' + (nm || 'your backup') + ' could not be reached. Check their phone.'; tone = 'bad'; }
    else { text = until + ' — no backup set'; tone = 'warn'; }
    if (behind && bs === 'ok') { text += ' (backup routing is behind)'; tone = 'warn'; }
    return { text: text, tone: tone, canImBack: true };
  }

  // ── data ─────────────────────────────────────────────────────────────
  async function callable(payload) {
    if (!w._functions || !w._httpsCallable) {
      var mod = await import(FUNCTIONS_SDK);
      w._functions = w._functions || mod.getFunctions();
      w._httpsCallable = w._httpsCallable || mod.httpsCallable;
    }
    var res = await w._httpsCallable(w._functions, 'manageAway')(payload || {});
    return res && res.data;
  }
  async function readDoc(path) {
    if (!w.db || !w.doc || !w.getDoc) return null;
    var parts = path.split('/');
    var snap = await w.getDoc(w.doc.apply(null, [w.db].concat(parts)));
    var ok = snap && (typeof snap.exists === 'function' ? snap.exists() : !!snap.exists);
    return ok ? (snap.data() || {}) : null;
  }
  async function load(force) {
    if (!uid() || !w.db) return;
    if (state.busy || (!force && Date.now() - state.loadedAt < 30000)) return;
    state.busy = true;
    var seq = ++state.seq;
    try {
      var key = await companyKey();
      if (!key) return;
      var st = null;
      try { st = await readDoc('away_mode/' + key); } catch (e) { st = null; }   // no doc yet / rules: nothing to show
      if (seq !== state.seq) return;
      state.status = st;
      state.handBack = null; state.packets = null;
      if (st && isOwnerish() && st.pendingReview && st.pendingReview.windowId) {
        try {
          var led = await readDoc('away_windows/' + key + '__' + st.pendingReview.windowId);
          state.handBack = led && led.handBack ? led.handBack : null;
        } catch (e) { state.handBack = null; }
      } else if (st && st.backup && st.backup.uid && st.backup.uid === uid() && role() !== 'viewer') {
        try {
          var r = await callable({ action: 'backupList' });
          state.packets = r && Array.isArray(r.items) ? r.items : [];
          state.windowId = (r && r.windowId) || '';
        } catch (e) { state.packets = null; }
      }
      state.loadedAt = Date.now();
    } finally { state.busy = false; }
    render();
  }

  // ── paint ────────────────────────────────────────────────────────────
  function statusHtml(d) {
    var line = statusLine(d, Date.now());
    if (!line) return '';
    return '<div class="away-line away-' + esc(line.tone) + '" role="status">' +
      '<span class="away-text">' + esc(line.text) + '</span>' +
      (line.canImBack && isOwnerish() ? '<button type="button" class="away-btn" data-away-act="back">I’m back</button>' : '') +
      '</div>';
  }
  function handBackHtml(hb) {
    if (!state.status || !state.status.pendingReview) return '';
    var rows = hb && Array.isArray(hb.rows) ? hb.rows : [];
    var head = rows.length
      ? 'While you were away — ' + rows.length + ' still need' + (rows.length === 1 ? 's' : '') + ' you'
      : 'While you were away — nothing is waiting on you';
    var sub = hb ? (hb.touched ? esc(hb.backupName || 'Your backup') + ' touched ' + hb.touched + ', ' + (hb.resolved || 0) + ' cleared.' : 'Your backup did not need to step in.') : '';
    var list = rows.map(function (r) {
      var tel = r.phone10 && r.phone10.length === 10 ? '<a class="away-btn" href="tel:+1' + esc(r.phone10) + '">Call</a>' : '';
      return '<div class="away-row"><div class="away-main"><div class="away-name">' + esc(r.who) +
        (r.backupSaysDone ? ' <span class="away-chip">says done — your call</span>' : '') + '</div>' +
        '<div class="away-sub">' + esc(r.note) + '</div></div><div class="away-acts">' + tel + '</div></div>';
    }).join('');
    return '<div class="away-card" data-away-card="handback"><div class="away-card-hd"><div class="away-card-title">' + esc(head) + '</div>' +
      '<div class="away-sub">' + sub + '</div></div>' + list +
      '<div class="away-foot"><button type="button" class="away-btn away-go" data-away-act="reviewed">Reviewed</button></div></div>';
  }
  function coverHtml(items) {
    if (!items || !items.length) return '';
    var who = state.status && state.status.ownerName ? state.status.ownerName : 'the owner';
    var list = items.map(function (p) {
      var tel = p.phone10 && p.phone10.length === 10 ? '<a class="away-btn away-go" href="tel:+1' + esc(p.phone10) + '">Call ' + esc(p.phone10.slice(0, 3) + '-' + p.phone10.slice(3, 6) + '-' + p.phone10.slice(6)) + '</a>' : '';
      var last = p.touches && p.touches.length ? p.touches[p.touches.length - 1] : null;
      var btn = function (a, label) { return '<button type="button" class="away-btn" data-away-act="touch" data-away-touch="' + a + '" data-away-key="' + esc(p.key) + '">' + label + '</button>'; };
      return '<div class="away-row" data-away-item="' + esc(p.key) + '"><div class="away-main"><div class="away-name">' + esc(p.who) +
        (p.urgent ? ' <span class="away-chip away-hot">urgent</span>' : '') + '</div>' +
        '<div class="away-sub">' + esc(p.why) + ' · ' + (p.ageMin >= 120 ? Math.round(p.ageMin / 60) + ' h' : p.ageMin + ' min') + ' ago' +
        (last ? ' · you: ' + esc(last.label) + (last.note ? ' — ' + esc(last.note) : '') : '') + '</div></div>' +
        '<div class="away-acts">' + tel + btn('took', 'I’m on it') + btn('called', 'Called') + btn('cant_reach', 'No answer') + btn('done', 'Done') + '</div>' +
        '<input type="text" class="away-note" maxlength="140" placeholder="Short note for ' + esc(who) + ' (optional)" aria-label="Note" data-away-note="' + esc(p.key) + '"></div>';
    }).join('');
    return '<div class="away-card" data-away-card="cover"><div class="away-card-hd"><div class="away-card-title">Covering: ' + items.length +
      (items.length === 1 ? ' person needs' : ' people need') + ' a call-back</div>' +
      '<div class="away-sub">You see a name, a number and why. Your notes go back to the owner; nothing is closed in the CRM until they review it.</div></div>' +
      list + '</div>';
  }
  function render() {
    var el = doc.getElementById('awayStatus');
    if (!el) return;
    var st = state.status;
    var html = '';
    if (st) {
      if (isOwnerish()) html = statusHtml(st) + handBackHtml(state.handBack);
      else {
        // A teammate sees the status line (no button) and, if they are the backup, the cover list.
        var line = statusLine(st, Date.now());
        html = line ? '<div class="away-line away-' + esc(line.tone) + '" role="status"><span class="away-text">' + esc(line.text) + '</span></div>' : '';
        if (st.backup && st.backup.uid === uid() && state.packets) html += coverHtml(state.packets);
      }
    }
    el.innerHTML = html;
    el.hidden = !html;
  }

  // ── actions ──────────────────────────────────────────────────────────
  async function ask(m) { return typeof window.nbdConfirm === 'function' ? !!(await window.nbdConfirm(m)) : window.confirm(m); }
  async function act(t) {
    var a = t.getAttribute('data-away-act');
    if (a === 'back') {
      if (!(await ask("Mark yourself back? Your backup stops being told, and anything they touched comes back to you."))) return;
      t.disabled = true;
      try { await callable({ action: 'imBack' }); toast('Welcome back. Your hand-back list is on Home.', 'success'); await load(true); }
      catch (e) { t.disabled = false; toast((e && e.message) || "Couldn't end away mode — try again", 'error'); }
    } else if (a === 'reviewed') {
      t.disabled = true;
      try { await callable({ action: 'reviewed' }); state.status = Object.assign({}, state.status, { pendingReview: null }); state.handBack = null; render(); await load(true); }
      catch (e) { t.disabled = false; toast((e && e.message) || "Couldn't save — try again", 'error'); }
    } else if (a === 'touch') {
      var key = t.getAttribute('data-away-key') || '';
      var noteEl = doc.querySelector('[data-away-note="' + (w.CSS && w.CSS.escape ? w.CSS.escape(key) : key.replace(/"/g, '')) + '"]');
      t.disabled = true;
      try {
        await callable({ action: 'backupAct', key: key, touch: t.getAttribute('data-away-touch'), note: noteEl ? noteEl.value : '' });
        toast('Saved — the owner will see it', 'success');
        await load(true);
      } catch (e) { t.disabled = false; toast((e && e.message) || "Couldn't save — try again", 'error'); }
    }
  }
  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('#awayStatus [data-away-act]') : null;
    if (t) act(t).catch(function (e) { console.warn('[away]', e); });
  });

  function boot() {
    try {
      new MutationObserver(function () {
        var el = doc.getElementById('awayStatus');
        if (el && !el.getAttribute('data-away-mounted')) { el.setAttribute('data-away-mounted', '1'); if (state.status) render(); else load(true); }
      }).observe(doc.body, { childList: true, subtree: true });
    } catch (_) { /* no observer: the poll below still loads */ }
    var tries = 0;
    (function kick() {
      if (uid() && w.db && w.doc && w.getDoc) { load(true); return; }
      if (++tries < 60) setTimeout(kick, 1000);
    })();
    // Refresh while Home stays open: the window can end or the backup can change.
    setInterval(function () { if (!doc.hidden) load(false); }, 60000);
    doc.addEventListener('visibilitychange', function () { if (!doc.hidden) load(false); });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();

  w.NBDAway = {
    __v: 1, statusLine: statusLine, fmtUntil: fmtUntil, load: load, render: render, callable: callable,
    state: function () { return state; },
    // test seam: paint a given status / ledger / packets without Firestore
    _paint: function (o) { state.status = o.status || null; state.handBack = o.handBack || null; state.packets = o.packets || null; render(); },
  };
})();
