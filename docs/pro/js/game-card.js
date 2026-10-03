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
  var PALETTE = {
    skin: ['#F2C6A0', '#D99A6C', '#A86B45', '#6B4226'],
    hat: ['#BA7517', '#378ADD', '#E24B4A', '#639922'],
    shirt: ['#185FA5', '#D85A30', '#5F5E5A', '#0F6E56'],
  };
  var TOOLS = [['hammer', 'Hammer'], ['ladder', 'Ladder'], ['none', 'None']];
  var DEFAULT_AVATAR = { skin: 0, hat: 0, shirt: 0, tool: 'hammer' };
  var st = { settings: null, card: null, loading: false, editing: false, error: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uid() { return window._user && window._user.uid; }
  function avatar() { return Object.assign({}, DEFAULT_AVATAR, (st.settings && st.settings.avatar) || {}); }
  function enabled() { return !!(st.settings && st.settings.enabled); }
  function fmt(n) { return Math.round(Number(n) || 0).toLocaleString('en-US'); }

  // ── settings (userSettings/{uid}.game) ─────────────────────────────────
  async function loadSettings() {
    if (!uid() || !window.getDoc || !window.doc || !window.db) return null;
    try {
      var snap = await window.getDoc(window.doc(window.db, 'userSettings', uid()));
      st.settings = (snap.exists() && (snap.data() || {}).game) || { enabled: false };
    } catch (_) { st.settings = st.settings || { enabled: false }; }
    return st.settings;
  }
  async function saveSettings(patch) {
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

  // ── the 16×16 sprite ───────────────────────────────────────────────────
  function drawSprite(canvas, a) {
    if (!canvas || !canvas.getContext) return;
    var g = canvas.getContext('2d');
    var u = canvas.width / 16;
    var px = function (x, y, c) { g.fillStyle = c; g.fillRect(x * u, y * u, u, u); };
    g.clearRect(0, 0, canvas.width, canvas.height);
    var skin = PALETTE.skin[a.skin] || PALETTE.skin[0], hat = PALETTE.hat[a.hat] || PALETTE.hat[0];
    var shirt = PALETTE.shirt[a.shirt] || PALETTE.shirt[0], dark = '#2C2C2A', pants = '#444441';
    var x, y;
    for (x = 4; x < 12; x++) px(x, 2, hat);
    for (x = 3; x < 13; x++) px(x, 3, hat);
    for (y = 4; y < 8; y++) for (x = 5; x < 11; x++) px(x, y, skin);
    px(6, 5, dark); px(9, 5, dark); px(7, 7, dark); px(8, 7, dark);
    for (y = 8; y < 12; y++) for (x = 4; x < 12; x++) px(x, y, shirt);
    for (y = 8; y < 11; y++) { px(3, y, skin); px(12, y, skin); }
    for (y = 12; y < 15; y++) { px(5, y, pants); px(6, y, pants); px(9, y, pants); px(10, y, pants); }
    px(5, 15, dark); px(6, 15, dark); px(9, 15, dark); px(10, 15, dark);
    if (a.tool === 'hammer') { for (y = 6; y < 11; y++) px(13, y, '#854F0B'); px(12, 5, '#888780'); px(13, 5, '#888780'); px(14, 5, '#888780'); }
    if (a.tool === 'ladder') { for (y = 4; y < 15; y++) { px(13, y, '#B4B2A9'); px(15, y, '#B4B2A9'); } for (y = 5; y < 15; y += 3) px(14, y, '#B4B2A9'); }
  }

  function editorHtml(prefix) {
    var a = avatar();
    var row = function (key, label) {
      return '<div class="gc-lbl">' + label + '</div><div class="gc-sw">' + PALETTE[key].map(function (c, i) {
        return '<button type="button" class="gc-swatch gc-sw-' + key + '-' + i + (a[key] === i ? ' is-on' : '') + '" data-gc="pick" data-key="' + key + '" data-val="' + i + '" aria-label="' + label + ' ' + (i + 1) + '" aria-pressed="' + (a[key] === i) + '"></button>';
      }).join('') + '</div>';
    };
    return '<div class="gc-editor">' +
      '<canvas class="gc-sprite gc-sprite-lg" id="' + prefix + 'Sprite" width="128" height="128" role="img" aria-label="Your avatar"></canvas>' +
      '<div class="gc-editor-opts">' + row('skin', 'Skin') + row('hat', 'Hard hat') + row('shirt', 'Shirt') +
      '<div class="gc-lbl">Tool</div><div class="gc-tools">' + TOOLS.map(function (t) {
        return '<button type="button" class="btn btn-ghost btn-sm' + (a.tool === t[0] ? ' is-on' : '') + '" data-gc="pick" data-key="tool" data-val="' + t[0] + '" aria-pressed="' + (a.tool === t[0]) + '">' + t[1] + '</button>';
      }).join('') + '</div></div></div>';
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
        '<canvas class="gc-sprite" id="gcHomeSprite" width="64" height="64" role="img" aria-label="Your avatar"></canvas>' +
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
      '<div class="gc-actions"><button type="button" class="btn btn-ghost btn-sm" data-gc="edit">' + (st.editing ? 'Done' : 'Edit avatar') + '</button></div>' +
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
      av[key] = key === 'tool' ? val : Number(val);
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
