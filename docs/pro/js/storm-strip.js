/**
 * storm-strip.js — the shared storm strip (2026-10-16, layouts idea #9).
 *
 * Storm days are the money days, and quiet otherwise: the strip shows ONLY
 * when something touches Joe's territory or a customer —
 *
 *   an NWS warning   Storm Mode's own read (NBDStormMode.observeWarnings():
 *                    the qualifying warnings that overlap the service area,
 *                    with the customers inside each), polled every 10 minutes
 *                    while the screen is in use. It works with Storm Mode off.
 *   a hail report    hail-cron's stamp on a customer (lead.hailHit) from the
 *                    last 3 days
 *
 * — and it never shows a false all-clear: when the warning read fails it says
 * "Storm feed unavailable. This is not an all-clear." (with any hail it does
 * know about). Clear = no strip at all.
 *
 * One tap opens Mission Control (LayoutEngine.apply('mission', { source:
 * 'storm' }), the same session-only switch Storm Mode's banner makes), offered
 * only when the company allows that layout and the screen supports it.
 *
 * Hosts: #homeStorm in the Home template (Classic; Bento above its board;
 * Island under its hero) and Field's [data-storm-slot] (it replaces Field's
 * old cached storm line). Mission Control is the storm screen itself.
 *
 * Pure half (summarize / missionOk) is require()-able for tests.
 * Loaded lazily (ScriptLoader bundle 'stormstrip', kicked by today-home.js boot).
 */
(function (root) {
  'use strict';

  var HAIL_DAYS = 3;
  var POLL_MS = 10 * 60000;

  function toMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var t = new Date(v).getTime();
    return isFinite(t) ? t : 0;
  }

  // ── pure ─────────────────────────────────────────────────────────────
  /**
   * warnings: the observeWarnings() result — an array, or null when the read
   * failed (undefined = not read yet). leads: window._leads.
   * -> { state: 'loading'|'clear'|'warn'|'fail', warnings:[{ event, hailIn, expires, customers }], hail:{ count, maxIn } }
   */
  function summarize(warnings, leads, nowMs) {
    var now = Number(nowMs) || Date.now();
    var hail = { count: 0, maxIn: 0 };
    (leads || []).forEach(function (l) {
      if (!l || l.deleted === true || l.e2eTestData || !l.hailHit) return;
      var at = toMs(l.hailHit.at) || toMs(l.hailHit.foundAt);
      var sz = Number(l.hailHit.sizeInches) || 0;
      if (!at || now - at > HAIL_DAYS * 86400000 || at > now + 3600000 || !(sz > 0)) return;
      hail.count++;
      if (sz > hail.maxIn) hail.maxIn = sz;
    });
    var list = Array.isArray(warnings) ? warnings.filter(function (w) {
      var exp = toMs(w && w.expires);
      return w && (!exp || exp > now);
    }).map(function (w) {
      return { event: String(w.event || 'Weather warning'), hailIn: Number(w.hailIn) || 0, expires: toMs(w.expires) || 0, customers: Array.isArray(w.leadIds) ? w.leadIds.length : 0 };
    }).sort(function (a, b) { return b.customers - a.customers || b.hailIn - a.hailIn; }) : [];
    var state = warnings === null ? 'fail' : warnings === undefined ? 'loading' : list.length || hail.count ? 'warn' : 'clear';
    return { state: state, warnings: list, hail: hail };
  }
  /** May the strip offer Mission Control? i: { has, surfaces, surface, company:{locked, allowed}, current } */
  function missionOk(i) {
    var x = i || {};
    if (!x.has || x.current === 'mission') return false;
    var c = x.company || {};
    if (c.locked === true) return false;
    if (Array.isArray(c.allowed) && c.allowed.indexOf('mission') === -1) return false;
    return Array.isArray(x.surfaces) && x.surfaces.indexOf(x.surface) !== -1;
  }

  var pure = { summarize: summarize, missionOk: missionOk, HAIL_DAYS: HAIL_DAYS, POLL_MS: POLL_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document || root.NBDStormStrip) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = root, doc = root.document;
  var warnings;            // undefined = not read yet; null = the read failed
  var lastAt = 0, busy = false, html = { full: '', compact: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function timeOf(ms) { try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; } }
  function inches(n) { return (Math.round(n * 100) / 100) + '"'; }
  function canMission() {
    var E = w.LayoutEngine, R = w.LayoutRegistry;
    if (!E || !R || typeof E.current !== 'function') return false;
    var d = R.get('mission'), p = typeof E.prefs === 'function' ? E.prefs() : {};
    var cur = E.current() || {};
    return missionOk({ has: !!d, surfaces: d ? d.surfaces : [], surface: typeof E.surface === 'function' ? E.surface() : '', company: (p && p.company) || {}, current: cur.id });
  }

  function stripHtml(m, compact) {
    if (m.state === 'clear' || m.state === 'loading') return '';
    var lines = [];
    if (m.state === 'fail') lines.push('<p class="ss-line ss-fail"><strong>Storm feed unavailable.</strong> This is not an all-clear. It looks again in 10 minutes.</p>');
    m.warnings.slice(0, compact ? 1 : 3).forEach(function (x) {
      lines.push('<p class="ss-line"><strong>' + esc(x.event) + '</strong>' +
        (x.hailIn ? ' · hail up to ' + esc(inches(x.hailIn)) : '') +
        ' · ' + (x.customers ? x.customers + (x.customers === 1 ? ' customer inside' : ' customers inside') : 'over your area') +
        (x.expires ? ' · until ' + esc(timeOf(x.expires)) : '') + '</p>');
    });
    if (m.warnings.length > (compact ? 1 : 3)) lines.push('<p class="ss-line">+' + (m.warnings.length - (compact ? 1 : 3)) + ' more warnings</p>');
    if (m.hail.count) lines.push('<p class="ss-line">Hail up to ' + esc(inches(m.hail.maxIn)) + ' reported near ' + m.hail.count + (m.hail.count === 1 ? ' customer' : ' customers') + ' in the last ' + HAIL_DAYS + ' days</p>');
    var go = (m.warnings.length || m.hail.count) && canMission()
      ? '<button type="button" class="ss-btn" data-ss="mission">Open Mission Control</button>' : '';
    return '<div class="ss-card' + (m.state === 'fail' && !m.warnings.length && !m.hail.count ? ' ss-quiet' : '') + (compact ? ' ss-compact' : '') + '" role="region" aria-label="Storm">' +
      '<div class="ss-body">' + lines.join('') + '</div>' + go + '</div>';
  }
  function hosts() {
    var out = Array.prototype.slice.call(doc.querySelectorAll('[data-storm-slot]'));
    var home = doc.getElementById('homeStorm');
    if (home) out.unshift(home);
    return out;
  }
  function paintHost(el) {
    var h = el.getAttribute && el.getAttribute('data-storm-variant') === 'compact' ? html.compact : html.full;
    if (el.__ssHtml === h && (el.firstChild || !h)) return;
    el.__ssHtml = h;
    el.innerHTML = h;
    el.hidden = !h;
  }
  function render() {
    var m = summarize(warnings, w._leads || [], Date.now());
    html.full = stripHtml(m, false);
    html.compact = stripHtml(m, true);
    hosts().forEach(paintHost);
  }
  function ensureStorm() {
    if (w.NBDStormMode && typeof w.NBDStormMode.observeWarnings === 'function') return Promise.resolve(w.NBDStormMode);
    if (!w.ScriptLoader || typeof w.ScriptLoader.load !== 'function') return Promise.resolve(null);
    // the same file and URL Mission Control loads
    return Promise.resolve(w.ScriptLoader.load('/pro/js/storm-mode.js?v=1')).then(function () { return w.NBDStormMode || null; }, function () { return null; });
  }
  function poll(force) {
    if (busy || (!force && Date.now() - lastAt < POLL_MS)) return;
    if (w._leadsLoaded !== true) return;
    busy = true; lastAt = Date.now();
    ensureStorm().then(function (SM) {
      if (!SM || typeof SM.observeWarnings !== 'function') return null;
      return SM.observeWarnings();
    }).then(function (list) { warnings = Array.isArray(list) ? list : null; }, function () { warnings = null; })
      .then(function () { busy = false; render(); });
  }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-ss="mission"]') : null;
    if (!t) return;
    ev.preventDefault();
    if (canMission() && w.LayoutEngine) w.LayoutEngine.apply('mission', { source: 'storm' });
  });
  ['nbd:data-refreshed', 'layoutchange'].forEach(function (n) { w.addEventListener(n, function () { render(); }); });
  doc.addEventListener('visibilitychange', function () { if (!doc.hidden) poll(false); });
  setInterval(function () { if (!doc.hidden) poll(false); }, 60000);
  var queued = false;
  try {
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      (w.requestAnimationFrame || setTimeout)(function () { queued = false; hosts().forEach(paintHost); });
    }).observe(doc.body, { childList: true, subtree: true });
  } catch (_) { /* events still paint */ }
  var tries = 0;
  (function kick() { if (w._leadsLoaded === true) { render(); poll(true); return; } if (++tries < 120) setTimeout(kick, 500); })();

  // settled(): the warning read has answered (a list, or null = failed). today-home.js holds Home's first reveal for it, briefly.
  w.NBDStormStrip = { render: render, poll: poll, settled: function () { return warnings !== undefined; }, _stripHtml: stripHtml, _set: function (v) { warnings = v; render(); } };
})(typeof window !== 'undefined' ? window : null);
