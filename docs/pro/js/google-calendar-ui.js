/**
 * google-calendar-ui.js — Google Calendar (calendar hub Phase 2) in the CRM.
 *
 * 1. The "Google Calendar" panel in the Schedule view: set up the "NBD Jobs"
 *    calendar (functions/google-calendar.js setupGoogleCalendar — the CRM's
 *    service account creates it and shares it read-only with Jo's Google
 *    account), show its status, and tell Jo the one extra click that lets the
 *    CRM see his own calendar's busy times.
 * 2. The double-booking warning under the job date/time pickers (customer
 *    page #editSched*, lead modal #lSched*): after a change it asks
 *    getBusyTimes and shows what is already booked then. Warn, never block
 *    (Jo, 2026-09-29).
 *
 * Owner / company_admin / platform admin only (the callables refuse everyone
 * else); for anyone else the panel stays hidden and no busy check runs.
 * Listeners are bound by id / delegated on document, like calendar-feed-ui.js
 * — no dispatcher registry to drift from. Every value into innerHTML is
 * escaped.
 */
(function () {
  'use strict';
  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['google-calendar-ui']) return;
  __NBD_LOADED['google-calendar-ui'] = true;

  const OWNER = window.__NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, t) => { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); };

  function allowed() {
    const c = window._userClaims || {};
    const uid = window._user && window._user.uid;
    return uid === OWNER || c.role === 'admin' || (c.companyId === OWNER && c.role === 'company_admin');
  }

  async function callable(name, payload) {
    if (!window._httpsCallable) {
      const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      window._httpsCallable = mod.httpsCallable;
    }
    if (!window._functions) throw new Error('Functions SDK unavailable');
    const res = await window._httpsCallable(window._functions, name)(payload || {});
    return res && res.data;
  }

  // ── the panel ─────────────────────────────────────────────────────────
  let _status = null;
  function renderPanel() {
    const panel = $('gcalPanel');
    if (!panel) return;
    if (!allowed()) { panel.hidden = true; panel.style.display = 'none'; return; }
    panel.hidden = false; panel.style.display = '';
    const body = $('gcalBody');
    if (!body) return;
    const s = _status;
    if (!s) { body.innerHTML = '<div class="gcal-muted">Checking Google Calendar…</div>'; return; }
    if (s.error) { body.innerHTML = '<div class="gcal-muted">Couldn\'t reach Google Calendar: ' + esc(s.error) + '</div>'; return; }
    const sa = s.serviceAccount ? '<code class="gcal-code" id="gcalSa">' + esc(s.serviceAccount) + '</code> <button type="button" class="btn btn-ghost gcal-small" id="gcalCopySa">Copy</button>' : '';
    if (!s.configured) {
      body.innerHTML =
        '<div class="gcal-muted">Puts every scheduled job, adjuster meeting, yard-sign pickup and timed door-knock follow-up on an <b>NBD Jobs</b> calendar in your Google account — your phone, Google Calendar, and Cal.com\'s double-booking check all see it. Changes in the CRM show up within seconds.</div>' +
        '<div class="gcal-row"><input type="email" id="gcalEmail" class="gcal-input" placeholder="Your Google account email" autocomplete="email" value="' + esc(s.sharedWith || '') + '">' +
        '<button type="button" class="btn btn-orange" id="gcalSetup">Connect Google Calendar</button></div>' +
        (s.disabled ? '<div class="gcal-warn">The sync is switched off on the server right now.</div>' : '');
      return;
    }
    const last = s.lastSync ? (s.lastSync.upserted + s.lastSync.unchanged) + ' events in sync' : 'not synced yet';
    body.innerHTML =
      '<div class="gcal-ok">✓ <b>NBD Jobs</b> is shared with ' + esc(s.sharedWith) + ' · ' + esc(last) + '</div>' +
      (s.primaryShared
        ? '<div class="gcal-ok">✓ The CRM can see your own calendar\'s busy times — it will warn you before double-booking.</div>'
        : '<div class="gcal-step"><b>One more step for the double-booking warning:</b> in Google Calendar, open your main calendar\'s <i>Settings and sharing</i> → <i>Share with specific people</i> → add ' + sa + ' → <i>See only free/busy</i>. Until then the warning only checks other NBD jobs.</div>') +
      '<div class="gcal-row"><button type="button" class="btn btn-ghost gcal-small" id="gcalResync">Re-sync now</button>' +
      '<button type="button" class="btn btn-ghost gcal-small" id="gcalRefresh">Check status</button></div>';
  }

  async function loadStatus() {
    if (!allowed() || !$('gcalPanel')) return;
    _status = null; renderPanel();
    try { _status = await callable('getGoogleCalendarStatus'); }
    catch (e) { _status = { error: (e && e.message) || 'unknown error' }; }
    renderPanel();
  }

  async function setup(btn) {
    const email = (($('gcalEmail') || {}).value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Enter the Google account email', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }
    try {
      const r = await callable('setupGoogleCalendar', { email });
      toast('NBD Jobs calendar shared with ' + email + ' — ' + ((r && r.summary && r.summary.upserted) || 0) + ' events added. Check your email to accept it.', 'success');
      await loadStatus();
    } catch (e) {
      toast('Google Calendar setup failed: ' + ((e && e.message) || 'unknown'), 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Connect Google Calendar'; }
    }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.id) return;
    if (t.id === 'gcalSetup') setup(t);
    else if (t.id === 'gcalRefresh') loadStatus();
    else if (t.id === 'gcalResync') {
      const email = _status && _status.sharedWith;
      if (email) { t.disabled = true; callable('setupGoogleCalendar', { email }).then(() => { toast('Re-synced', 'success'); loadStatus(); }).catch((e) => { toast('Re-sync failed: ' + ((e && e.message) || ''), 'error'); t.disabled = false; }); }
    } else if (t.id === 'gcalCopySa') {
      const sa = _status && _status.serviceAccount;
      if (sa && navigator.clipboard) navigator.clipboard.writeText(sa).then(() => toast('Copied', 'success')).catch(() => {});
    }
  });

  // ── the double-booking warning ──────────────────────────────────────────
  const SW = () => window.NBDScheduleWindow;
  const FIELD_RE = /^(edit|l)(ScheduledDate|SchedStart|SchedDays|SchedDuration)$/;
  const _timers = {};

  function windowFor(prefix) {
    const date = (($(prefix === 'edit' ? 'editScheduledDate' : 'lScheduledDate')) || {}).value || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !SW()) return null;
    const start = (($(prefix + 'SchedStart')) || {}).value || '';
    const daysEl = $(prefix + 'SchedDays'), durEl = $(prefix + 'SchedDuration');
    const days = daysEl && daysEl.offsetParent !== null ? Math.max(1, parseInt(daysEl.value, 10) || 1) : 1;
    const dur = durEl && durEl.offsetParent !== null ? parseInt(durEl.value, 10) || 0 : 0;
    const L = SW().localToUtcMs;
    // No time → the working day (7 am–6 pm) is what the job would take.
    const s = L(date, start || '07:00');
    const lastDay = days > 1 ? SW().addDays(date, days - 1) : date;
    const e = (start && dur && days === 1) ? s + dur * 60000 : L(lastDay, days > 1 || !start ? '18:00' : start) + (days > 1 || !start ? 0 : 60 * 60000);
    return { startMs: s, endMs: Math.max(e, s + 30 * 60000), date };
  }

  function fmt(ms) {
    return new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function warnEl(prefix) {
    let el = $(prefix + 'SchedConflict');
    const preview = $(prefix + 'SchedPreview');
    if (!el && preview && preview.parentNode) {
      el = document.createElement('div');
      el.id = prefix + 'SchedConflict';
      el.setAttribute('aria-live', 'polite');
      el.className = 'gcal-conflict';
      preview.parentNode.insertBefore(el, preview.nextSibling);
    }
    return el;
  }

  async function check(prefix) {
    const el = warnEl(prefix);
    if (!el) return;
    const w = windowFor(prefix);
    if (!w) { el.innerHTML = ''; return; }
    const leadId = prefix === 'edit' ? (new URLSearchParams(location.search).get('id') || null) : ((($('lEditId') || {}).value) || null);
    let r;
    try { r = await callable('getBusyTimes', { fromMs: w.startMs - 1, toMs: w.endMs + 1, excludeLeadId: leadId }); }
    catch (_) { el.innerHTML = ''; return; } // never block a save on the warning
    if (!r || !r.configured) { el.innerHTML = ''; return; }
    const hits = (r.blocks || []).filter((b) => b.startMs < w.endMs && b.endMs > w.startMs);
    if (!hits.length) { el.innerHTML = '<span class="gcal-clear">✓ Nothing else booked then</span>'; return; }
    el.innerHTML = '⚠ Already booked then: ' + hits.slice(0, 3).map((b) => {
      const who = b.titles && b.titles.length ? b.titles.join(', ') : 'your calendar';
      return esc(fmt(b.startMs)) + '–' + esc(new Date(b.endMs).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })) + ' (' + esc(who) + ')';
    }).join('; ') + (hits.length > 3 ? ' +' + (hits.length - 3) + ' more' : '') + ' — you can still save.';
  }

  function onField(ev) {
    const t = ev.target;
    const m = t && t.id && FIELD_RE.exec(t.id);
    if (!m || !allowed()) return;
    const prefix = m[1];
    clearTimeout(_timers[prefix]);
    _timers[prefix] = setTimeout(() => { check(prefix); }, 500);
  }
  document.addEventListener('change', onField);
  document.addEventListener('input', onField);

  // The panel lives in the Schedule view's template, stamped on first visit.
  // The status check reads Google, so it runs only when that view is open —
  // never on an ordinary page load.
  //
  // Opened by a direct link (…/dashboard.html#/schedule) the page is still
  // signing in and stamping the view when this first runs, so a single
  // delayed check could see no user / no panel and leave the panel hidden for
  // good (Jo, 2026-09-29: "don't see any schedule button anywhere"). Retry
  // every 500 ms, up to 20 s, until both the panel and the signed-in user
  // exist; then load once.
  let _tries = 0, _timer = null;
  function maybeLoad() {
    if (!/schedule/.test(location.hash || '')) return;
    clearTimeout(_timer);
    _tries = 0;
    const tick = () => {
      const ready = $('gcalPanel') && window._user && window._user.uid;
      if (ready) { if (!_status && allowed()) loadStatus(); else renderPanel(); return; }
      if (++_tries < 40) _timer = setTimeout(tick, 500);
    };
    _timer = setTimeout(tick, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', maybeLoad); else maybeLoad();
  window.addEventListener('hashchange', maybeLoad);
  window.addEventListener('nbd:data-refreshed', maybeLoad);

  window.NBDGoogleCalendarUI = { loadStatus, check, _windowFor: windowFor };
})();
