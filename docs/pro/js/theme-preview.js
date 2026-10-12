/**
 * NBD Pro - live theme preview (2026-10-11, roadmap A5 / design idea #04).
 *
 * Settings > Appearance > theme grid. Hovering (120 ms debounce), focusing,
 * arrow-keying or tapping a theme card renders a real mini pipeline in THAT
 * theme inside #te-theme-preview, scoped to the panel: nothing outside it
 * changes and nothing is saved. The panel shows the palette swatches, a
 * contrast badge (with the current theme for comparison) and three actions:
 *   Apply         ThemeEngine.apply(key, true)  - persisted, morphs
 *   Try 10 min    ThemeEngine.apply(key, false) - NOT persisted; auto-reverts
 *                 to the theme that was on screen (a reload also reverts)
 *   Favorite      toggles the key in userSettings.themeFavorites
 * Recent applies are kept in userSettings.themeRecent. Both lists mirror to
 * localStorage so they paint instantly.
 *
 * CSP: external file, delegated listeners, no inline handlers. Loaded in the
 * lazy `theme` ScriptLoader bundle, after theme-engine.js.
 */
(function () {
  'use strict';

  var FAV_KEY = 'nbd_theme_favorites';
  var REC_KEY = 'nbd_theme_recent';
  var MAX_FAV = 24;
  var MAX_REC = 8;
  var TRIAL_MS = 10 * 60 * 1000;
  var HOVER_MS = 120;
  var BOOT_QUIET_MS = 3000; // themechange events this soon after load are the boot restore, not a choice

  var t0 = Date.now();
  var state = { key: null, favs: [], recent: [], trial: null, hoverTimer: null, reverting: false };

  function TE() { return window.ThemeEngine; }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── persistence ────────────────────────────────────────────────────────
  function load(k) {
    try {
      var a = JSON.parse(localStorage.getItem(k) || '[]');
      return Array.isArray(a) ? a.filter(function (s) { return typeof s === 'string'; }) : [];
    } catch (e) { return []; }
  }
  function store(k, a) { try { localStorage.setItem(k, JSON.stringify(a)); } catch (e) {} }
  function syncRemote(field, value) {
    try {
      var uid = (window._user && window._user.uid) || null;
      if (uid && window.db && window.doc && window.setDoc) {
        var d = {}; d[field] = value;
        window.setDoc(window.doc(window.db, 'userSettings', uid), d, { merge: true })
          .catch(function (err) { console.warn('[theme-preview] sync failed:', err.message); });
      }
    } catch (e) {}
  }
  function known(list) {
    var te = TE();
    return list.filter(function (k) { return !te || !te.get || !!te.get(k); });
  }
  function pushRecent(key) {
    if (!key) return;
    state.recent = [key].concat(state.recent.filter(function (k) { return k !== key; })).slice(0, MAX_REC);
    store(REC_KEY, state.recent);
    syncRemote('themeRecent', state.recent);
    renderLists();
  }
  function toggleFavorite(key) {
    var i = state.favs.indexOf(key);
    if (i >= 0) state.favs.splice(i, 1);
    else state.favs.unshift(key);
    state.favs = state.favs.slice(0, MAX_FAV);
    store(FAV_KEY, state.favs);
    syncRemote('themeFavorites', state.favs);
    render(state.key);
  }
  function hydrate() {
    var tries = 0;
    (function poll() {
      var uid, ready = false;
      try {
        uid = (window._user && window._user.uid) || null;
        ready = !!(uid && window.db && window.getDoc && window.doc);
      } catch (e) {}
      if (!ready) { if (++tries <= 10) setTimeout(poll, 500); return; }
      try {
        (window.nbdRetryOffline || function (f) { return f(); })(function () {
          return window.getDoc(window.doc(window.db, 'userSettings', uid));
        }).then(function (snap) {
          if (!snap.exists()) return;
          var d = snap.data() || {};
          var changed = false;
          if (Array.isArray(d.themeFavorites)) { state.favs = d.themeFavorites.filter(function (s) { return typeof s === 'string'; }).slice(0, MAX_FAV); store(FAV_KEY, state.favs); changed = true; }
          if (Array.isArray(d.themeRecent)) { state.recent = d.themeRecent.filter(function (s) { return typeof s === 'string'; }).slice(0, MAX_REC); store(REC_KEY, state.recent); changed = true; }
          if (changed) { renderLists(); if (state.key) render(state.key); }
        }).catch(function (err) { console.warn('[theme-preview] hydrate failed:', err.message); });
      } catch (e) {}
    })();
  }

  // ── contrast / palette ────────────────────────────────────────────────
  function ratio(a, b) {
    var te = TE();
    try { return te && te.contrastRatio ? te.contrastRatio(a, b) : null; } catch (e) { return null; }
  }
  function grade(r) {
    if (r == null) return { label: '-', cls: 'na' };
    if (r >= 7) return { label: 'AAA', cls: 'good' };
    if (r >= 4.5) return { label: 'AA', cls: 'good' };
    if (r >= 3) return { label: 'Large text only', cls: 'warn' };
    return { label: 'Low', cls: 'bad' };
  }
  function pickFg(accent) {
    var w = ratio('#ffffff', accent), k = ratio('#0b0b0b', accent);
    return (w != null && k != null && k > w) ? '#0b0b0b' : '#ffffff';
  }
  // previewCSS() emits ":root[data-theme=\"x\"] { --bg: ...}" - retarget the one
  // selector at the panel's stage so the variables cannot leak onto the page.
  function scopeCSS(css) {
    return String(css || '').replace(/^\s*:root(?:\[[^\]]*\])?\s*\{/, '#te-theme-preview .tp-stage {');
  }

  // ── DOM ────────────────────────────────────────────────────────────────
  var BASE_CSS =
    '#te-theme-preview{margin:0 0 14px;}' +
    '#te-theme-preview .tp-wrap{border:1px solid var(--br);border-radius:12px;background:var(--s2);padding:12px;}' +
    '#te-theme-preview .tp-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;}' +
    '#te-theme-preview .tp-name{font-weight:800;font-size:15px;color:var(--t);}' +
    '#te-theme-preview .tp-cat{font-size:11px;color:var(--m);text-transform:uppercase;letter-spacing:.05em;}' +
    '#te-theme-preview .tp-body{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:12px;}' +
    '@media (max-width:640px){#te-theme-preview .tp-body{grid-template-columns:minmax(0,1fr);}}' +
    '#te-theme-preview .tp-stage{background:var(--bg);color:var(--t);border:1px solid var(--br);border-radius:10px;padding:10px;min-height:150px;}' +
    '#te-theme-preview .tp-bar{display:flex;align-items:center;gap:6px;margin-bottom:8px;}' +
    '#te-theme-preview .tp-dot{width:8px;height:8px;border-radius:50%;background:var(--orange);}' +
    '#te-theme-preview .tp-title{font-weight:800;font-size:12px;letter-spacing:.04em;text-transform:uppercase;}' +
    '#te-theme-preview .tp-pill{margin-left:auto;font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--og);color:var(--orange);}' +
    '#te-theme-preview .tp-cols{display:grid;grid-template-columns:1fr 1fr;gap:8px;}' +
    '#te-theme-preview .tp-card{background:var(--s2);border:1px solid var(--br);border-radius:8px;padding:8px;}' +
    '#te-theme-preview .tp-k{font-size:10px;color:var(--m);text-transform:uppercase;letter-spacing:.04em;}' +
    '#te-theme-preview .tp-v{font-size:15px;font-weight:800;margin:2px 0;}' +
    '#te-theme-preview .tp-m{font-size:10px;color:var(--m);}' +
    '#te-theme-preview .tp-btn{margin-top:8px;border:0;border-radius:8px;padding:7px 12px;font-weight:700;font-size:12px;background:var(--orange);color:var(--accent-fg,#fff);}' +
    '#te-theme-preview .tp-side{display:flex;flex-direction:column;gap:8px;min-width:0;}' +
    '#te-theme-preview .tp-sw{display:flex;gap:6px;}' +
    '#te-theme-preview .tp-sw span{flex:1;height:26px;border-radius:6px;border:1px solid var(--br);}' +
    '#te-theme-preview .tp-badge{display:inline-block;font-size:11px;font-weight:800;padding:2px 8px;border-radius:999px;border:1px solid var(--br);}' +
    '#te-theme-preview .tp-badge.good{color:var(--green);}#te-theme-preview .tp-badge.warn{color:var(--gold);}#te-theme-preview .tp-badge.bad{color:var(--red);}' +
    '#te-theme-preview .tp-line{font-size:12px;color:var(--m);}' +
    '#te-theme-preview .tp-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;}' +
    '#te-theme-preview .tp-actions button{min-height:40px;}' +
    '#te-theme-preview .tp-lists{display:flex;flex-direction:column;gap:6px;margin-top:10px;}' +
    '#te-theme-preview .tp-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;color:var(--m);}' +
    '#te-theme-preview .tp-chip{border:1px solid var(--br);background:var(--s);color:var(--t);border-radius:999px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;min-height:30px;}' +
    '#te-theme-grid [data-te-key]:focus-visible{outline:2px solid var(--orange);outline-offset:2px;}';

  function ensureBaseCss() {
    if ($('te-preview-base')) return;
    var s = document.createElement('style');
    s.id = 'te-preview-base';
    s.textContent = BASE_CSS;
    document.head.appendChild(s);
  }

  function mount() {
    var grid = $('te-theme-grid');
    if (!grid) return null;
    ensureBaseCss();
    var p = $('te-theme-preview');
    if (!p) {
      p = document.createElement('div');
      p.id = 'te-theme-preview';
      p.setAttribute('aria-live', 'polite');
      grid.parentNode.insertBefore(p, grid);
    }
    if (!p.dataset.ready) {
      p.dataset.ready = '1';
      p.innerHTML = '<div class="tp-wrap"><div class="tp-line">Hover, tab or tap a theme to see it here. Nothing changes until you press Apply.</div><div class="tp-lists" id="te-pv-lists"></div></div>';
      renderLists();
    }
    return p;
  }

  function chips(keys, label) {
    var te = TE();
    var items = known(keys).map(function (k) {
      var t = te && te.get ? te.get(k) : null;
      return '<button type="button" class="tp-chip" data-tp="show" data-key="' + esc(k) + '">' + esc(t ? t.name : k) + '</button>';
    }).join('');
    return items ? '<div class="tp-row"><span>' + label + '</span>' + items + '</div>' : '';
  }
  function renderLists() {
    var box = $('te-pv-lists');
    if (!box) return;
    box.innerHTML = chips(state.favs, '★ Favorites') + chips(state.recent, 'Recent');
  }

  function isLocked(key) {
    var te = TE();
    var t = te && te.get ? te.get(key) : null;
    return !!(t && t.locked && !(te.isUnlocked && te.isUnlocked(key)));
  }

  function render(key) {
    var te = TE();
    var p = mount();
    if (!p || !te || !key) return;
    var t = te.get(key);
    if (!t) return;
    state.key = key;
    var res = te.previewResolvedColors(key) || {};
    var cur = te.getCurrent && te.get(te.getCurrent()) ? te.previewResolvedColors(te.getCurrent()) : null;
    var r = ratio(res.text, res.surface);
    var rc = cur ? ratio(cur.text, cur.surface) : null;
    var g = grade(r);
    var locked = isLocked(key);
    var fav = state.favs.indexOf(key) >= 0;
    var trialOn = state.trial && state.trial.key === key;
    var cat = '';
    try {
      (te.getCategories() || []).forEach(function (c) { if (c.key === t.category) cat = c.label; });
    } catch (e) {}

    var style = $('te-preview-style');
    if (!style) { style = document.createElement('style'); style.id = 'te-preview-style'; document.head.appendChild(style); }
    style.textContent = scopeCSS(te.previewCSS(key)) +
      '#te-theme-preview .tp-stage{--accent-fg:' + pickFg(res.accent) + ';}';

    var sw = [res.bg, res.surface, res.accent, res.text].map(function (c) {
      return '<span data-c="' + esc(c) + '" title="' + esc(c) + '"></span>';
    }).join('');

    p.innerHTML =
      '<div class="tp-wrap" data-key="' + esc(key) + '">' +
        '<div class="tp-top"><span class="tp-name">' + esc(t.name) + '</span>' +
          (cat ? '<span class="tp-cat">' + esc(cat) + '</span>' : '') +
          (locked ? '<span class="tp-cat">🔒 locked</span>' : '') + '</div>' +
        '<div class="tp-body">' +
          '<div class="tp-stage" aria-hidden="true">' +
            '<div class="tp-bar"><span class="tp-dot"></span><span class="tp-title">Pipeline</span><span class="tp-pill">3 new</span></div>' +
            '<div class="tp-cols">' +
              '<div class="tp-card"><div class="tp-k">New lead</div><div class="tp-v">$12,400</div><div class="tp-m">Hail · Oak St</div></div>' +
              '<div class="tp-card"><div class="tp-k">Estimate sent</div><div class="tp-v">$18,950</div><div class="tp-m">Follow up today</div></div>' +
            '</div>' +
            '<button type="button" class="tp-btn" tabindex="-1">Book inspection</button>' +
          '</div>' +
          '<div class="tp-side">' +
            '<div class="tp-sw">' + sw + '</div>' +
            '<div><span class="tp-badge ' + g.cls + '">' + (r == null ? 'contrast n/a' : r.toFixed(1) + ':1 · ' + g.label) + '</span></div>' +
            '<div class="tp-line">Text on cards' + (rc != null ? ' · your current theme ' + rc.toFixed(1) + ':1' : '') + '</div>' +
            '<div class="tp-actions">' +
              '<button type="button" class="btn btn-orange" data-tp="apply" data-key="' + esc(key) + '"' + (locked ? ' disabled' : '') + '>Apply</button>' +
              '<button type="button" class="btn btn-ghost" data-tp="trial" data-key="' + esc(key) + '"' + (locked ? ' disabled' : '') + '>' +
                (trialOn ? 'Trying… ' + remaining() : 'Try for 10 min') + '</button>' +
              '<button type="button" class="btn btn-ghost" data-tp="fav" data-key="' + esc(key) + '" aria-pressed="' + fav + '">' + (fav ? '★ Favorited' : '☆ Favorite') + '</button>' +
            '</div>' +
            (state.trial ? '<div class="tp-line"><button type="button" class="tp-chip" data-tp="revert">Revert now</button> trial of ' + esc((te.get(state.trial.key) || {}).name || state.trial.key) + ' ends in ' + remaining() + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="tp-lists" id="te-pv-lists"></div>' +
      '</div>';
    // Swatch colours go through the CSSOM, not inline markup: the repo's
    // inline-style ratchet counts attributes, and CSP-wise this is the cleaner path.
    var spans = p.querySelectorAll ? p.querySelectorAll('.tp-sw span[data-c]') : [];
    for (var i = 0; i < spans.length; i++) spans[i].style.background = spans[i].getAttribute('data-c');
    renderLists();
  }

  // ── Try for 10 minutes ────────────────────────────────────────────────
  function remaining() {
    if (!state.trial) return '';
    var s = Math.max(0, Math.round((state.trial.endsAt - Date.now()) / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function stopTrial() {
    if (!state.trial) return;
    clearInterval(state.trial.tick);
    clearTimeout(state.trial.timer);
    state.trial = null;
  }
  function revertTrial(manual) {
    var tr = state.trial;
    if (!tr) return;
    stopTrial();
    var te = TE();
    state.reverting = true;
    try { te.apply(tr.prev, false, { morph: true }); } catch (e) {}
    state.reverting = false;
    if (state.key) render(state.key);
    if (!manual && typeof window.showToast === 'function') window.showToast('Trial over — back to your theme');
  }
  function startTrial(key, origin) {
    var te = TE();
    if (!te || isLocked(key)) return;
    var prev = state.trial ? state.trial.prev : te.getCurrent();
    stopTrial();
    if (prev === key) { render(key); return; }
    te.apply(key, false, { morph: true, origin: origin });
    state.trial = {
      key: key, prev: prev, endsAt: Date.now() + TRIAL_MS,
      timer: setTimeout(function () { revertTrial(false); }, TRIAL_MS),
      tick: setInterval(function () {
        var b = document.querySelector('#te-theme-preview [data-tp="trial"]');
        if (b && state.trial) b.textContent = 'Trying… ' + remaining();
      }, 1000)
    };
    render(key);
  }

  // ── actions ───────────────────────────────────────────────────────────
  function originOf(el) {
    try {
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    } catch (e) { return undefined; }
  }
  function onAction(el) {
    var act = el.getAttribute('data-tp');
    var key = el.getAttribute('data-key');
    var te = TE();
    if (!te) return;
    if (act === 'show') { render(key); return; }
    if (act === 'fav') { toggleFavorite(key); return; }
    if (act === 'revert') { revertTrial(true); return; }
    if (act === 'trial') { startTrial(key, originOf(el)); return; }
    if (act === 'apply') {
      if (isLocked(key)) return;
      stopTrial();
      // The legacy click-preview flow leaves a confirm bar + a remembered
      // "original" theme behind; applying for real settles both.
      var bar = $('te-confirm-bar');
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
      window._teOriginalTheme = null;
      te.apply(key, true, { origin: originOf(el) });
      pushRecent(key);
      if (typeof window.showToast === 'function') window.showToast('Theme applied ✓');
      if (typeof window._teRenderSettingsGrid === 'function') window._teRenderSettingsGrid(window._teActiveCat || 'all');
      render(key);
    }
  }

  // ── events (delegated) ────────────────────────────────────────────────
  function cardOf(target) {
    return target && target.closest ? target.closest('#te-theme-grid [data-te-key]') : null;
  }
  document.addEventListener('mouseover', function (e) {
    var c = cardOf(e.target);
    if (!c) return;
    var key = c.getAttribute('data-te-key');
    if (key === state.key) return;
    clearTimeout(state.hoverTimer);
    state.hoverTimer = setTimeout(function () { render(key); }, HOVER_MS);
  });
  document.addEventListener('focusin', function (e) {
    var c = cardOf(e.target);
    if (c) render(c.getAttribute('data-te-key'));
  });
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('#te-theme-preview [data-tp]') : null;
    if (a) { e.preventDefault(); onAction(a); return; }
    var c = cardOf(e.target);
    if (c) render(c.getAttribute('data-te-key')); // tap on a phone: no hover, so a tap shows the panel too
  });
  document.addEventListener('keydown', function (e) {
    var c = cardOf(e.target);
    if (!c) return;
    var k = e.key;
    if (k === 'Enter' || k === ' ') { e.preventDefault(); render(c.getAttribute('data-te-key')); return; }
    if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(k) < 0) return;
    var cards = Array.prototype.slice.call(document.querySelectorAll('#te-theme-grid [data-te-key]'));
    var i = cards.indexOf(c);
    if (i < 0) return;
    var next = null;
    if (k === 'ArrowRight') next = cards[i + 1];
    else if (k === 'ArrowLeft') next = cards[i - 1];
    else if (k === 'Home') next = cards[0];
    else if (k === 'End') next = cards[cards.length - 1];
    else {
      var r = c.getBoundingClientRect();
      var dir = k === 'ArrowDown' ? 1 : -1;
      var best = null, bestScore = Infinity;
      cards.forEach(function (o) {
        var b = o.getBoundingClientRect();
        var dy = (b.top - r.top) * dir;
        if (dy < 5) return;
        var score = dy * 4 + Math.abs(b.left - r.left);
        if (score < bestScore) { bestScore = score; best = o; }
      });
      next = best;
    }
    if (next) { e.preventDefault(); next.focus(); }
  });

  // A trial ends if the user switches themes some other way; a persisted
  // switch becomes a Recent entry (boot restores are ignored).
  document.addEventListener('themechange', function (e) {
    var key = e && e.detail;
    if (state.trial && !state.reverting && key !== state.trial.key) stopTrial();
    try {
      if (Date.now() - t0 > BOOT_QUIET_MS && key && localStorage.getItem('nbd_pro_theme') === key && state.recent[0] !== key) pushRecent(key);
    } catch (_) {}
  });

  state.favs = load(FAV_KEY);
  state.recent = load(REC_KEY);
  hydrate();

  window.NBDThemePreview = { mount: mount, show: render, _state: state };
  if ($('te-theme-grid')) mount();
})();
