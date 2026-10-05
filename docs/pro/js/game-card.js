/**
 * game-card.js — the OPTIONAL game card (Jo, 2026-10-03).
 *
 * Off by default. Settings › Appearance › "Game mode" turns it on; then one
 * card on Home shows your pixel avatar, level, an XP bar, this week vs last
 * week ("your ghost"), and what the XP was for. Nothing else in the CRM
 * changes: no pop-ups, no notifications, nothing on the working screens.
 *
 * XP is NOT computed or stored here: getGameCard (functions/game.js) derives
 * it from your own records on request, so it can't be edited from the app.
 * This module stores only your preferences on userSettings/{uid}.game
 * ({ enabled, avatar: { skin, hat, shirt, tool } }) — userSettings survives
 * sign-out (client-state lifetimes, see the repo notes).
 *
 * CSP: no inline handlers or style attributes; one delegated click listener;
 * styles in css/game-card.css (gc-*). Test hook: window.NBDGameCard.
 */
(function () {
  'use strict';
  if (window.NBDGameCard) return;

  var FUNCTIONS_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
  var CACHE_MS = 15 * 60 * 1000;
  // The avatar itself (parts, colours, drawing) lives in game-sprite.js.
  function S() { return window.NBDSprite; }
  var st = { settings: null, card: null, loading: false, editing: false, error: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uid() { return window._user && window._user.uid; }
  function avatar() { return S() ? S().normalize((st.settings && st.settings.avatar) || {}) : {}; }
  function enabled() { return !!(st.settings && st.settings.enabled); }
  function fmt(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }

  // ── settings (userSettings/{uid}.game) ─────────────────────────────────
  // A cold boot can catch Firestore mid-connect (2026-10-04): getDoc then
  // REJECTS "client is offline", or answers from the empty local cache. Both
  // used to land as { enabled: false } for the page's life — game mode on,
  // card gone until a reload. Ask again a few times before settling on off;
  // a choice made on this screen meanwhile is never overwritten.
  var READ_TRIES = 6;
  var localEditAt = 0;
  function transient(e) { return /offline|unavailable|deadline|backend|network/i.test(String((e && (e.code || e.message)) || '')); }
  async function loadSettings() {
    if (!uid() || !window.getDoc || !window.doc || !window.db) return null;
    for (var n = 0; ; n++) {
      var editAt = localEditAt;
      try {
        var snap = await window.getDoc(window.doc(window.db, 'userSettings', uid()));
        var game = snap.exists() && (snap.data() || {}).game;
        if (!game && snap.metadata && snap.metadata.fromCache && n < READ_TRIES - 1) throw Object.assign(new Error('cached read'), { code: 'unavailable' });
        if (localEditAt === editAt) st.settings = game || { enabled: false };
        return st.settings;
      } catch (e) {
        if (!transient(e) || n >= READ_TRIES - 1) { st.settings = st.settings || { enabled: false }; return st.settings; }
      }
      await new Promise(function (r) { setTimeout(r, 1500 * (n + 1)); });
    }
  }
  async function saveSettings(patch) {
    localEditAt = Date.now();
    st.settings = Object.assign({}, st.settings || {}, patch);
    if (!uid() || !window.setDoc) return;
    await window.setDoc(window.doc(window.db, 'userSettings', uid()), { game: st.settings }, { merge: true });
  }

  // ── the card's numbers (server-derived, cached 15 min) ─────────────────
  function cacheKey() { return 'nbd_gamecard:' + uid(); }
  async function loadCard(force) {
    if (st.loading) return;
    if (!force) {
      try {
        var c = JSON.parse(sessionStorage.getItem(cacheKey()) || 'null');
        if (c && Date.now() - c.at < CACHE_MS) { st.card = c.card; return; }
      } catch (_) {}
    }
    st.loading = true; st.error = '';
    try {
      if (!window._functions || !window._httpsCallable) {
        var mod = await import(FUNCTIONS_SDK);
        window._functions = mod.getFunctions();
        window._httpsCallable = mod.httpsCallable;
      }
      var res = await window._httpsCallable(window._functions, 'getGameCard')({});
      st.card = res && res.data;
      try { sessionStorage.setItem(cacheKey(), JSON.stringify({ at: Date.now(), card: st.card })); } catch (_) {}
    } catch (e) {
      st.error = 'Couldn\'t load your XP right now.';
    }
    st.loading = false;
  }

  function drawSprite(canvas, a) { if (S()) S().draw(canvas, a); }

  // The editor is generated from NBDSprite.OPTIONS: colour lists become
  // swatches (classes gc-sw-<key>-<i>, CSP: no inline colours), the rest
  // become small buttons.
  function editorHtml(prefix) {
    if (!S()) return '';
    var a = avatar(), O = S().OPTIONS;
    var group = function (key) {
      var o = O[key];
      var body = o.colors ? o.colors.map(function (c, i) {
        return '<button type="button" class="gc-swatch gc-sw-' + key + '-' + i + (a[key] === i ? ' is-on' : '') + '" data-gc="pick" data-key="' + key + '" data-val="' + i + '" aria-label="' + esc(o.label) + ' ' + (i + 1) + '" aria-pressed="' + (a[key] === i) + '"></button>';
      }).join('') : o.values.map(function (v) {
        return '<button type="button" class="btn btn-ghost btn-sm gc-opt' + (a[key] === v[0] ? ' is-on' : '') + '" data-gc="pick" data-key="' + key + '" data-val="' + esc(v[0]) + '" aria-pressed="' + (a[key] === v[0]) + '">' + esc(v[1]) + '</button>';
      }).join('');
      return '<div class="gc-group"><div class="gc-lbl">' + esc(o.label) + '</div><div class="' + (o.colors ? 'gc-sw' : 'gc-tools') + '">' + body + '</div></div>';
    };
    return '<div class="gc-editor">' +
      '<canvas class="gc-sprite gc-sprite-lg" id="' + prefix + 'Sprite" width="256" height="256" role="img" aria-label="Your avatar"></canvas>' +
      '<div class="gc-editor-opts">' + Object.keys(O).map(group).join('') + '</div></div>';
  }

  // ── Home card ──────────────────────────────────────────────────────────
  function renderHome() {
    var el = document.getElementById('homeGameCard');
    if (!el) return;
    if (!enabled()) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    var c = st.card;
    var name = (window._user && (window._user.displayName || '').split(' ')[0]) || 'You';
    if (!c) {
      el.innerHTML = '<div class="gc-card"><div class="gc-muted">' + esc(st.error || 'Adding up your week…') + '</div></div>';
      return;
    }
    var span = Math.max(1, (c.levelNext || 1) - (c.levelFloor || 0));
    var pct = Math.max(0, Math.min(100, Math.round(((c.totalXp - (c.levelFloor || 0)) / span) * 100)));
    var ahead = c.week.xp - c.lastWeek.xp;
    el.innerHTML = '<div class="gc-card">' +
      '<div class="gc-top">' +
        '<canvas class="gc-sprite" id="gcHomeSprite" width="128" height="128" role="img" aria-label="Your avatar"></canvas>' +
        '<div class="gc-who"><div class="gc-name">' + esc(name) + '</div><div class="gc-muted">Level ' + esc(c.level) + ' · ' + esc(c.title) + '</div></div>' +
        '<div class="gc-xp gc-muted">' + fmt(c.totalXp) + ' / ' + fmt(c.levelNext) + ' XP</div>' +
      '</div>' +
      '<div class="gc-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Progress to the next level"><div class="gc-fill gc-w' + Math.round(pct / 5) * 5 + '"></div></div>' +
      '<div class="gc-weeks">' +
        '<div class="gc-stat"><div class="gc-muted">This week</div><div class="gc-num">' + fmt(c.week.xp) + ' XP</div></div>' +
        '<div class="gc-stat"><div class="gc-muted">Last week (your ghost)</div><div class="gc-num">' + fmt(c.lastWeek.xp) + ' XP</div></div>' +
      '</div>' +
      '<div class="gc-muted gc-vs">' + (ahead > 0 ? 'Ahead of your ghost by ' + fmt(ahead) + ' XP.' : ahead < 0 ? fmt(-ahead) + ' XP behind your ghost — the week isn\'t over.' : 'Dead even with your ghost.') + '</div>' +
      (c.breakdown && c.breakdown.length ? '<div class="gc-list">' + c.breakdown.map(function (b) {
        return '<div class="gc-row"><span>' + esc(b.label) + ' (' + (b.kind === 'collected' ? '$' + fmt(b.count) : fmt(b.count)) + ')</span><span>+' + fmt(b.xp) + '</span></div>';
      }).join('') + '</div>' : '<div class="gc-muted">Nothing yet this week. Tick a follow-up or file a call and it shows up here.</div>') +
      ((c.partial || []).length ? '<div class="gc-muted gc-note">Some numbers are still catching up.</div>' : '') +
      '<div class="gc-actions"><button type="button" class="btn btn-ghost btn-sm" data-gc="edit">' + (st.editing ? 'Done' : 'Edit avatar') + '</button>' +
        '<a class="btn btn-ghost btn-sm gc-play" href="/pro/roof-rep.html">🎮 Play Roof Rep</a></div>' +
      (st.editing ? editorHtml('gcHomeEd') : '') +
    '</div>';
    drawSprite(document.getElementById('gcHomeSprite'), avatar());
    if (st.editing) drawSprite(document.getElementById('gcHomeEdSprite'), avatar());
  }

  // ── Settings › Appearance ──────────────────────────────────────────────
  function renderSettings() {
    var el = document.getElementById('gameSettingsMount');
    if (!el) return;
    var on = enabled();
    el.innerHTML = '<div class="panel mb-md"><div class="panel-hdr"><div><div class="panel-label">Game mode (optional)</div><div class="panel-title">Avatar, levels and XP</div></div></div>' +
      '<div class="panel-body">' +
        '<p class="gc-muted gc-p">A small card on Home with your pixel avatar, a level, and XP earned only from real work: follow-ups done, calls filed, leads, review asks, jobs won, money collected. You race last week\'s you. No pop-ups, nothing on the working screens.</p>' +
        '<label class="gc-switch"><input type="checkbox" id="gcEnabled"' + (on ? ' checked' : '') + '> <span>' + (on ? 'On' : 'Off') + '</span></label>' +
        (on ? editorHtml('gcSetEd') : '') +
      '</div></div>';
    if (on) drawSprite(document.getElementById('gcSetEdSprite'), avatar());
  }

  function renderAll() { renderHome(); renderSettings(); }

  document.addEventListener('click', async function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-gc]') : null;
    if (!b) return;
    var a = b.getAttribute('data-gc');
    if (a === 'edit') { st.editing = !st.editing; renderHome(); return; }
    if (a === 'pick') {
      var key = b.getAttribute('data-key'), val = b.getAttribute('data-val');
      var av = avatar();
      var o = S() && S().OPTIONS[key];
      if (!o) return;
      av[key] = o.colors ? Number(val) : val;
      try { await saveSettings({ avatar: av }); } catch (_) {}
      renderAll();
    }
  });
  document.addEventListener('change', async function (e) {
    if (!e.target || e.target.id !== 'gcEnabled') return;
    var on = !!e.target.checked;
    try { await saveSettings({ enabled: on }); } catch (_) {}
    if (on && !st.card) { renderAll(); await loadCard(false); }
    renderAll();
  });

  async function init() {
    var tries = 0;
    while (!(uid() && window.getDoc && window.db) && tries++ < 80) await new Promise(function (r) { setTimeout(r, 250); });
    await loadSettings();
    renderAll();
    if (enabled()) { await loadCard(false); renderHome(); }
  }
  // The Settings template hydrates lazily: render into it when it appears.
  var mo = new MutationObserver(function () {
    var s = document.getElementById('gameSettingsMount');
    if (s && !s.firstChild && st.settings) renderSettings();
    var h = document.getElementById('homeGameCard');
    if (h && enabled() && !h.firstChild) renderHome();
  });
  function start() {
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (_) {}
    init();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  window.NBDGameCard = {
    refresh: async function () { await loadCard(true); renderAll(); },
    _state: st,
    _draw: drawSprite,
  };
})();
