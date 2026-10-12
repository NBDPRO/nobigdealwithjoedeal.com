/**
 * trophy-case.js — window.NBDTrophyCase: achievement unlock toasts + the
 * Trophy Case drawer (CRM style integration C3, Grok idea #09, Jo-approved
 * 2026-10-11).
 *
 *   - `themeunlock` (document CustomEvent, detail {themeKey, name, icon,
 *     description}) is fired by ThemeAchievements.unlock — the one place a
 *     theme is EARNED. This file shows a console-style toast for it: gold
 *     medal, shine sweep, CSS-only confetti, the new theme's swatches and a
 *     "Try theme" button. Unlocks restored from Firestore on boot do not fire
 *     it, so nothing toasts at login for a theme earned last month.
 *   - The Trophy Case drawer lists the 10 achievement themes with live
 *     progress from the achievement store (ThemeAchievements.getAll /
 *     getProgress), "almost there" nudges for the ones within reach, and
 *     Try theme for the ones earned.
 *
 * Motion: Reduce Motion (the OS setting or the Comfort tab's data-motion
 * switch) drops the shine and the confetti; the chime also respects
 * theme-sounds.js (which mutes itself under Reduce Motion) and its on/off.
 *
 * Strict CSP: external file, delegated listeners, no inline handlers; the
 * stylesheet is injected as a <link> to /pro/css/trophy-case.css.
 *
 * _pure helpers are Node-testable (tests/trophy-case-2026-10-11.test.js).
 */
(function (root) {
  'use strict';

  var NEAR = 0.6;             // progress at/after which a row gets an "almost there" nudge
  var TOAST_MS = 9000;
  var CONFETTI_N = 56;
  var CONFETTI_CLASSES = 6;

  // ── PURE ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pct(p) {
    var n = Number(p);
    if (!isFinite(n) || n < 0) n = 0;
    return Math.round(Math.min(n, 1) * 100);
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /**
   * "3 more closed deals" — what is left, in the achievement's own unit.
   * row: { themeKey, current, target, progress, unlocked }.
   */
  function remainingText(row) {
    if (!row || row.unlocked) return '';
    var left = Math.max(0, Math.ceil((Number(row.target) || 0) - (Number(row.current) || 0)));
    switch (row.themeKey) {
      case 'gold-rush': return plural(left, 'more closed deal', 'more closed deals');
      case 'eternal-flame': return plural(left, 'more day of streak', 'more days of streak');
      case 'iron-door': return plural(left, 'more door', 'more doors');
      case 'diamond': return '$' + left + 'K more collected';
      case 'completionist': return plural(left, 'more feature to try', 'more features to try');
      case 'night-owl': return plural(left, 'more late-night login', 'more late-night logins');
      case 'road-warrior': return plural(left, 'more inspection', 'more inspections');
      case 'dragon-ball-super':
        return Number(row.progress) > 0 ? plural(left, 'more won deal', 'more won deals') : 'Earn Dragon Ball Z first';
      case 'hologram': return plural(left, 'more custom theme', 'more custom themes');
      case 'legend': return plural(left, 'more achievement theme', 'more achievement themes');
      default: return plural(left, 'more step', 'more steps');
    }
  }

  /** The nudge shown on a row: only for locked rows that are close. */
  function nudgeFor(row) {
    if (!row || row.unlocked) return '';
    if (!(Number(row.progress) >= NEAR) || Number(row.progress) >= 1) return '';
    return 'Almost there: ' + remainingText(row) + ' to ' + (row.name || 'this theme');
  }

  /** Closest-first among locked, then earned ones last (stable inside each group). */
  function sortRows(rows) {
    var list = (rows || []).map(function (r, i) { return { r: r, i: i }; });
    list.sort(function (a, b) {
      if (!!a.r.unlocked !== !!b.r.unlocked) return a.r.unlocked ? 1 : -1;
      var d = (Number(b.r.progress) || 0) - (Number(a.r.progress) || 0);
      return d || a.i - b.i;
    });
    return list.map(function (x) { return x.r; });
  }

  function summaryText(rows) {
    var all = rows || [];
    var done = all.filter(function (r) { return r.unlocked; }).length;
    var head = done + ' of ' + all.length + ' unlocked';
    var next = sortRows(all).filter(function (r) { return !r.unlocked; })[0];
    if (next && Number(next.progress) > 0) return head + ' · closest: ' + next.name + ' (' + pct(next.progress) + '%)';
    return head;
  }

  /** Confetti pieces: deterministic given rng (a () => 0..1). */
  function confettiSpecs(n, rng) {
    var r = typeof rng === 'function' ? rng : Math.random;
    var out = [];
    for (var i = 0; i < n; i++) {
      var angle = (-Math.PI / 2) + (r() - 0.5) * Math.PI * 1.15;     // a fan above the medal
      var dist = 70 + r() * 150;
      out.push({
        tx: Math.round(Math.cos(angle) * dist),
        ty: Math.round(Math.sin(angle) * dist + 40 + r() * 70),       // gravity pulls the fall down
        rot: Math.round((r() - 0.5) * 900),
        delay: Math.round(r() * 220),
        dur: 1100 + Math.round(r() * 900),
        w: 4 + Math.round(r() * 4),
        h: 6 + Math.round(r() * 6),
        cls: i % CONFETTI_CLASSES
      });
    }
    return out;
  }

  function reducedMotion() {
    try {
      if (root.document && root.document.documentElement.getAttribute('data-motion') === 'reduce') return true;
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) { return false; }
  }

  // ── data ─────────────────────────────────────────────────────────────
  /** Rows for the drawer from the achievement store. Never throws. */
  async function loadRows() {
    var TA = root.ThemeAchievements;
    var TE = root.ThemeEngine;
    if (!TA || typeof TA.getAll !== 'function') return [];
    var all = [];
    try { all = await TA.getAll(); } catch (_) { all = []; }
    var rows = [];
    for (var i = 0; i < all.length; i++) {
      var a = all[i];
      var unlocked = !!(TE && typeof TE.isUnlocked === 'function' ? TE.isUnlocked(a.themeKey) : a.unlocked) || !!a.unlocked;
      var cur = 0, target = 0;
      try {
        var p = await TA.getProgress(a.themeKey);
        if (p) { cur = p.current; target = p.target; }
      } catch (_) {}
      rows.push({
        themeKey: a.themeKey, name: a.name, icon: a.icon, description: a.description,
        progress: unlocked ? 1 : (Number(a.currentProgress) || 0),
        current: cur, target: target, unlocked: unlocked
      });
    }
    return rows;
  }

  function swatchesFor(themeKey) {
    var TE = root.ThemeEngine;
    try { return (TE && TE.previewResolvedColors && TE.previewResolvedColors(themeKey)) || null; } catch (_) { return null; }
  }

  function tryTheme(themeKey) {
    var TE = root.ThemeEngine;
    if (!TE || typeof TE.apply !== 'function') return;
    // Earned → unlock (idempotent) so apply()'s plan gate lets it through.
    if (typeof TE.unlock === 'function') TE.unlock(themeKey);
    TE.apply(themeKey);
  }

  // ── DOM ──────────────────────────────────────────────────────────────
  var doc = root.document;
  var state = { drawer: null, lastFocus: null, queue: [], showing: false, cssAdded: false };

  function ensureCss() {
    if (!doc || state.cssAdded) return;
    state.cssAdded = true;
    var l = doc.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/pro/css/trophy-case.css?v=1';
    doc.head.appendChild(l);
  }

  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function swatchRow(themeKey) {
    var c = swatchesFor(themeKey);
    var wrap = el('span', 'tc-swatches');
    wrap.setAttribute('aria-hidden', 'true');
    if (!c) return wrap;
    ['bg', 'surface', 'accent', 'text'].forEach(function (k) {
      var s = el('i', 'tc-sw');
      s.style.setProperty('--tc-sw', String(c[k] || 'transparent'));
      wrap.appendChild(s);
    });
    return wrap;
  }

  // ----- toast -----
  function showToast(detail) {
    if (!doc || !detail || !detail.themeKey) return;
    state.queue.push(detail);
    if (!state.showing) nextToast();
  }

  function nextToast() {
    var d = state.queue.shift();
    if (!d) { state.showing = false; return; }
    state.showing = true;
    ensureCss();
    var reduce = reducedMotion();

    var toast = el('div', 'tc-toast' + (reduce ? ' tc-calm' : ''));
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    var medal = el('div', 'tc-medal', d.icon || '🏆');
    medal.setAttribute('aria-hidden', 'true');
    var body = el('div', 'tc-toast-body');
    body.appendChild(el('div', 'tc-toast-k', 'Achievement unlocked'));
    body.appendChild(el('div', 'tc-toast-name', d.name || d.themeKey));
    if (d.description) body.appendChild(el('div', 'tc-toast-desc', d.description));
    body.appendChild(swatchRow(d.themeKey));
    var actions = el('div', 'tc-toast-actions');
    var tryBtn = el('button', 'tc-btn tc-btn-primary', 'Try theme');
    tryBtn.type = 'button';
    tryBtn.setAttribute('data-tc-try', d.themeKey);
    var caseBtn = el('button', 'tc-btn', 'Trophy Case');
    caseBtn.type = 'button';
    caseBtn.setAttribute('data-tc-open', '1');
    var closeBtn = el('button', 'tc-btn tc-btn-quiet', 'Dismiss');
    closeBtn.type = 'button';
    closeBtn.setAttribute('data-tc-dismiss', '1');
    actions.appendChild(tryBtn); actions.appendChild(caseBtn); actions.appendChild(closeBtn);
    body.appendChild(actions);

    toast.appendChild(medal);
    toast.appendChild(body);

    if (!reduce) {
      var layer = el('div', 'tc-confetti');
      layer.setAttribute('aria-hidden', 'true');
      confettiSpecs(CONFETTI_N).forEach(function (s) {
        var p = el('span', 'tc-conf tc-c' + s.cls);
        p.style.setProperty('--tx', s.tx + 'px');
        p.style.setProperty('--ty', s.ty + 'px');
        p.style.setProperty('--rot', s.rot + 'deg');
        p.style.setProperty('--d', s.delay + 'ms');
        p.style.setProperty('--t', s.dur + 'ms');
        p.style.width = s.w + 'px';
        p.style.height = s.h + 'px';
        layer.appendChild(p);
      });
      toast.appendChild(layer);
      setTimeout(function () { if (layer.parentNode) layer.parentNode.removeChild(layer); }, 2600);
    }

    doc.body.appendChild(toast);
    requestAnimationFrame(function () { toast.classList.add('tc-in'); });

    // chime: theme-sounds mutes itself under Reduce Motion; also honour its on/off
    try {
      var S = root.ThemeSounds;
      if (S && typeof S.playNotification === 'function' && (typeof S.isEnabled !== 'function' || S.isEnabled())) {
        S.playNotification('dramatic');
      }
    } catch (_) {}

    var timer = setTimeout(done, TOAST_MS);
    function done() {
      clearTimeout(timer);
      toast.classList.remove('tc-in');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        nextToast();
      }, reduce ? 0 : 280);
    }
    toast.addEventListener('mouseenter', function () { clearTimeout(timer); });
    toast.addEventListener('mouseleave', function () { timer = setTimeout(done, 3000); });
    toast._tcDone = done;
  }

  // ----- drawer -----
  function buildRow(r) {
    var li = el('li', 'tc-row' + (r.unlocked ? ' tc-done' : ''));
    var icon = el('div', 'tc-row-ico', r.icon || '🏆');
    icon.setAttribute('aria-hidden', 'true');
    var main = el('div', 'tc-row-main');
    var head = el('div', 'tc-row-head');
    head.appendChild(el('span', 'tc-row-name', r.name));
    head.appendChild(el('span', 'tc-row-state', r.unlocked ? 'Unlocked' : pct(r.progress) + '%'));
    main.appendChild(head);
    main.appendChild(el('div', 'tc-row-desc', r.description || ''));
    var bar = el('div', 'tc-bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', r.name + ' progress');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(pct(r.progress)));
    var fill = el('i', 'tc-bar-fill');
    fill.style.setProperty('--tc-p', pct(r.progress) + '%');
    bar.appendChild(fill);
    main.appendChild(bar);
    var nudge = nudgeFor(r);
    if (r.unlocked) {
      var foot = el('div', 'tc-row-foot');
      foot.appendChild(swatchRow(r.themeKey));
      var b = el('button', 'tc-btn tc-btn-primary', 'Try theme');
      b.type = 'button';
      b.setAttribute('data-tc-try', r.themeKey);
      foot.appendChild(b);
      main.appendChild(foot);
    } else {
      var left = remainingText(r);
      var line = el('div', 'tc-row-left' + (nudge ? ' tc-near' : ''), nudge || left);
      main.appendChild(line);
    }
    li.appendChild(icon);
    li.appendChild(main);
    return li;
  }

  function closeDrawer() {
    var d = state.drawer;
    if (!d) return;
    d.classList.remove('tc-open');
    var back = d._back;
    setTimeout(function () {
      if (d.parentNode) d.parentNode.removeChild(d);
      if (back && back.parentNode) back.parentNode.removeChild(back);
    }, reducedMotion() ? 0 : 220);
    state.drawer = null;
    var f = state.lastFocus;
    state.lastFocus = null;
    if (f && typeof f.focus === 'function') { try { f.focus(); } catch (_) {} }
  }

  async function openDrawer() {
    if (!doc) return;
    if (state.drawer) return;
    ensureCss();
    state.lastFocus = doc.activeElement;
    var back = el('div', 'tc-back');
    back.setAttribute('data-tc-close', '1');
    var d = el('aside', 'tc-drawer');
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-label', 'Trophy Case');
    d.tabIndex = -1;
    d._back = back;
    var head = el('div', 'tc-head');
    var ttl = el('div', 'tc-title');
    ttl.appendChild(el('span', 'tc-title-ico', '🏆'));
    ttl.appendChild(el('span', null, 'Trophy Case'));
    var x = el('button', 'tc-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close Trophy Case');
    x.setAttribute('data-tc-close', '1');
    head.appendChild(ttl); head.appendChild(x);
    var sum = el('div', 'tc-sum', 'Loading your progress…');
    var list = el('ol', 'tc-list');
    d.appendChild(head); d.appendChild(sum); d.appendChild(list);
    doc.body.appendChild(back);
    doc.body.appendChild(d);
    state.drawer = d;
    requestAnimationFrame(function () { d.classList.add('tc-open'); try { x.focus(); } catch (_) {} });

    var rows = await loadRows();
    if (state.drawer !== d) return;           // closed while loading
    if (!rows.length) {
      sum.textContent = 'Achievement themes are still loading. Try again in a moment.';
      return;
    }
    var sorted = sortRows(rows);
    sum.textContent = summaryText(sorted);
    sorted.forEach(function (r) { list.appendChild(buildRow(r)); });
  }

  // ── events ───────────────────────────────────────────────────────────
  if (doc) {
    doc.addEventListener('themeunlock', function (ev) { showToast(ev && ev.detail); });
    doc.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest('[data-tc-try],[data-tc-open],[data-tc-close],[data-tc-dismiss]') : null;
      if (!t) return;
      var key = t.getAttribute('data-tc-try');
      if (key) {
        ev.preventDefault();
        tryTheme(key);
        var tt = t.closest('.tc-toast');
        if (tt && tt._tcDone) tt._tcDone();
        return;
      }
      if (t.hasAttribute('data-tc-dismiss')) {
        var tst = t.closest('.tc-toast');
        if (tst && tst._tcDone) tst._tcDone();
        return;
      }
      if (t.hasAttribute('data-tc-close')) { ev.preventDefault(); closeDrawer(); return; }
      if (t.hasAttribute('data-tc-open')) {
        ev.preventDefault();
        var tst2 = t.closest('.tc-toast');
        if (tst2 && tst2._tcDone) tst2._tcDone();
        openDrawer();
      }
    });
    doc.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && state.drawer) { ev.preventDefault(); closeDrawer(); }
    });
  }

  var api = {
    handlesToasts: true,       // theme-achievements.js skips its old banner when this is set
    open: openDrawer, close: closeDrawer, toast: showToast,
    _pure: {
      pct: pct, remainingText: remainingText, nudgeFor: nudgeFor, sortRows: sortRows,
      summaryText: summaryText, confettiSpecs: confettiSpecs, esc: esc, NEAR: NEAR
    }
  };
  root.NBDTrophyCase = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
