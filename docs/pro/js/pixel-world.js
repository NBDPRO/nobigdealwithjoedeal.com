/**
 * pixel-world.js — Pixel World v1: the CRM as a walkable town
 * (2026-10-11, CRM style roadmap slice E2). Lazy-loaded by pixel-mode.js the
 * first time someone opens it; never part of dashboard boot.
 *
 *   - arrow keys / WASD, or the touch D-pad, walk the player around a town
 *   - six buildings are CRM areas: Leads Hall, Estimate Workshop, Storm Watch
 *     Tower, Bank, Trophy Hall, Office. Stepping on a door opens that area.
 *   - townspeople are the user's open leads, most-at-risk first. A red "!"
 *     means the lead's own follow-up date is past; the small bar over a head
 *     is its HP (days before it goes cold).
 *   - talking to one shows facts and Call / Open lead / Draft text / Move
 *     stage. Move stage runs through the CRM's own moveCard (E2b). Draft text
 *     (E2c) asks the SERVER to file one template draft into the Agent inbox
 *     (env.fileDraft -> callable fileLeadTextDraft); the game sends a template
 *     key, never words, and says FILED / ALREADY FILED / NOT ALLOWED. Nothing
 *     is ever texted from here.
 *   - Lead Dex, day/night tint from the real local clock, and a hail event
 *     when today's SPC outlook puts a lead's address in a hail-risk area.
 *
 * The map is drawn on a <canvas> in original pixel art built here from small
 * string patterns (no image files, nothing from any other game). The frame
 * around it (dialog, menu, HUD, D-pad) is HTML styled with theme tokens in
 * pixel-world.css, so it re-colours with every theme.
 *
 * Reads: the signed-in user's own leads already in memory (window._leads via
 * env.leads), StormOutlook.summarizeAt, ThemeEngine.isUnlocked. Writes: only
 * the player's own "seen" list on userSettings (via env.saveSeen). It never
 * sends a message and never changes a lead.
 *
 * CSP: external deferred-style script; delegated listeners; every string from
 * the CRM goes in through textContent.
 */
(function () {
  'use strict';
  var w = window, doc = document;
  if (!w.NBDPixelLogic || !w.NBDPixelWorldLogic) return;
  if (w.NBDPixelWorldGame) return;

  var PL = w.NBDPixelLogic;
  var WL = w.NBDPixelWorldLogic;
  var TILE = WL.TILE;
  var STEP_MS = 140;
  var MAX_PEOPLE = 40;
  var FONT = '"Press Start 2P", ui-monospace, "Courier New", monospace';

  // ── original pixel art ─────────────────────────────────────────────────
  var PERSON = [
    '..hhhh..',
    '.hhhhhh.',
    '.ffffff.',
    '.feffef.',
    '.ffffff.',
    '..tttt..',
    '.tttttt.',
    'ftttttff',
    '.tttttt.',
  ];
  var LEGS_A = ['..pppp..', '..p..p..', '.bb..bb.'];
  var LEGS_B = ['..pppp..', '...pp...', '...bb...'];
  var EYES = { down: '.feffef.', up: '.hhhhhh.', left: '.efffff.', right: '.fffffe.' };
  var FACE_ROW2 = { up: '.hhhhhh.' };

  function hsl(h, s, l) { return 'hsl(' + h + ',' + s + '%,' + l + '%)'; }

  function drawRows(ctx, rows, pal, x, y) {
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      for (var c = 0; c < row.length; c++) {
        var ch = row.charAt(c);
        if (ch === '.') continue;
        var col = pal[ch];
        if (!col) continue;
        ctx.fillStyle = col;
        ctx.fillRect(x + c, y + r, 1, 1);
      }
    }
  }
  function personRows(dir, step) {
    var rows = PERSON.slice();
    rows[3] = EYES[dir] || EYES.down;
    if (FACE_ROW2[dir]) rows[2] = FACE_ROW2[dir];
    return rows.concat(step ? LEGS_B : LEGS_A);
  }

  var BUILDING_PAL = {
    blue:   { roof: '#3a6fd8', roof2: '#2f5bb5', wall: '#d9dde6' },
    orange: { roof: '#e0752c', roof2: '#bd5f1f', wall: '#eadfce' },
    slate:  { roof: '#5d6678', roof2: '#485063', wall: '#c9ccd4' },
    green:  { roof: '#3d9a5a', roof2: '#2f7a46', wall: '#dde6d6' },
    gold:   { roof: '#e2b53a', roof2: '#bd952a', wall: '#efe6c9' },
    red:    { roof: '#c9453b', roof2: '#a43329', wall: '#ecdcd6' },
  };

  function makeTileset() {
    var c = doc.createElement('canvas');
    c.width = TILE * 8; c.height = TILE;
    var x = c.getContext('2d');
    function grass(ox, spots, hi) {
      x.fillStyle = '#5aa845'; x.fillRect(ox, 0, TILE, TILE);
      x.fillStyle = '#4a9338';
      spots.forEach(function (p) { x.fillRect(ox + p[0], p[1], 2, 2); });
      if (hi) { x.fillStyle = '#6bb855'; hi.forEach(function (p) { x.fillRect(ox + p[0], p[1], 2, 1); }); }
    }
    grass(0, [[2, 4], [10, 2], [6, 10], [13, 13], [3, 14]]);
    grass(TILE, [[5, 2], [12, 6], [2, 9], [9, 13]], [[1, 5], [8, 8], [13, 1]]);
    grass(TILE * 2, [[3, 3], [11, 12]]);
    var f = TILE * 2;                       // flower
    x.fillStyle = '#f2d24a'; x.fillRect(f + 6, 5, 2, 2); x.fillRect(f + 4, 7, 2, 2); x.fillRect(f + 8, 7, 2, 2); x.fillRect(f + 6, 9, 2, 2);
    x.fillStyle = '#fff'; x.fillRect(f + 6, 7, 2, 2);
    x.fillStyle = '#e86a8a'; x.fillRect(f + 11, 11, 2, 2); x.fillRect(f + 2, 11, 2, 2);
    var p = TILE * 3;                       // path
    x.fillStyle = '#d6c08a'; x.fillRect(p, 0, TILE, TILE);
    x.fillStyle = '#c4ac74';
    [[2, 3], [9, 1], [6, 8], [12, 11], [3, 13], [14, 6]].forEach(function (s) { x.fillRect(p + s[0], s[1], 2, 1); });
    var t = TILE * 4;                       // tree (on grass)
    grass(t, [[2, 14]]);
    x.fillStyle = '#6b4423'; x.fillRect(t + 6, 9, 4, 7);
    x.fillStyle = '#2f7a34'; x.fillRect(t + 2, 2, 12, 8); x.fillRect(t + 4, 0, 8, 12);
    x.fillStyle = '#3f9442'; x.fillRect(t + 4, 2, 4, 3); x.fillRect(t + 9, 5, 3, 3);
    var wv = TILE * 5;                      // water
    x.fillStyle = '#3b7ddc'; x.fillRect(wv, 0, TILE, TILE);
    x.fillStyle = '#6aa6f0'; x.fillRect(wv + 2, 4, 5, 1); x.fillRect(wv + 9, 10, 5, 1);
    var b = TILE * 6;                       // building filler (overdrawn per building)
    x.fillStyle = '#cfc3b0'; x.fillRect(b, 0, TILE, TILE);
    var d = TILE * 7;                       // door
    x.fillStyle = '#cfc3b0'; x.fillRect(d, 0, TILE, TILE);
    x.fillStyle = '#4a2f1a'; x.fillRect(d + 3, 2, 10, 14);
    x.fillStyle = '#6b4423'; x.fillRect(d + 4, 3, 8, 13);
    x.fillStyle = '#f2d24a'; x.fillRect(d + 10, 9, 2, 2);
    return c;
  }

  // ── theme-token helpers for canvas chrome ──────────────────────────────
  var TIER_COLOR = { ok: '#5fbf6f', warn: '#e0b030', cold: '#d9534f', unknown: '#8a929e' };

  // ── game ───────────────────────────────────────────────────────────────
  function start(env) {
    var world = WL.makeWorld();
    var tileset = makeTileset();
    var reduce = function () { return !!(env.reduceMotion && env.reduceMotion()); };

    var state = {
      pos: { x: world.start.x, y: world.start.y },
      from: null, to: null, t: 0,
      facing: 'down', stepFlip: false,
      people: [], flagged: 0,
      busy: false, menuOpen: false,
      keys: {}, pad: null,
      seen: Array.isArray(env.seen) ? env.seen.slice() : [],
      tint: WL.dayTint(new Date().getHours() + new Date().getMinutes() / 60),
      hail: [], areaName: 'TOWN SQUARE', lastRefresh: 0, raf: 0, last: 0, wander: 0,
      saveTimer: 0,
    };

    // DOM ----------------------------------------------------------------
    var prevFocus = doc.activeElement;
    var root = doc.createElement('div');
    root.className = 'pxw';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Pixel World');
    root.tabIndex = -1;
    function h(tag, cls, attrs, kids) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      (kids || []).forEach(function (c) { n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
      return n;
    }
    function btn(label, data, cls, aria) {
      var a = { type: 'button' };
      Object.keys(data).forEach(function (k) { a[k] = data[k]; });
      if (aria) a['aria-label'] = aria;
      return h('button', cls, a, [label]);
    }
    var cv = h('canvas', 'pxw-canvas', { 'aria-hidden': 'true' });
    var chipHail = h('span', 'pxw-chip pxw-hailchip'); chipHail.hidden = true;
    var dlgEl = h('div', 'pxw-dialog', {}, [h('div', 'pxw-dtext'), h('div', 'pxw-dopts')]); dlgEl.hidden = true;
    var panelEl = h('div', 'pxw-panel', { role: 'region' }, [
      h('div', 'pxw-ptitle'), h('div', 'pxw-pbody'),
      h('div', 'pxw-popts', {}, [btn('BACK', { 'data-pxw': 'close-panel' }, 'pxw-btn')]),
    ]); panelEl.hidden = true;
    [
      cv,
      h('div', 'pxw-hud', {}, [h('span', 'pxw-chip pxw-area'), h('span', 'pxw-chip pxw-clock'), chipHail]),
      h('div', 'pxw-top', {}, [btn('MENU', { 'data-pxw': 'menu' }, 'pxw-btn'), btn('EXIT', { 'data-pxw': 'exit' }, 'pxw-btn')]),
      h('div', 'pxw-live', { role: 'status', 'aria-live': 'polite' }),
      dlgEl,
      panelEl,
      h('div', 'pxw-dpad', { 'aria-label': 'Touch controls' }, [
        h('div', 'pxw-dir', {}, [
          btn('▲', { 'data-pxw-dir': 'up' }, 'pxw-key', 'Up'),
          btn('◀', { 'data-pxw-dir': 'left' }, 'pxw-key', 'Left'),
          btn('▶', { 'data-pxw-dir': 'right' }, 'pxw-key', 'Right'),
          btn('▼', { 'data-pxw-dir': 'down' }, 'pxw-key', 'Down'),
        ]),
        h('div', 'pxw-act', {}, [
          btn('B', { 'data-pxw': 'back' }, 'pxw-key pxw-keyb', 'Back'),
          btn('A', { 'data-pxw': 'act' }, 'pxw-key pxw-keya', 'Talk or enter'),
        ]),
      ]),
    ].forEach(function (n) { root.appendChild(n); });
    doc.body.appendChild(root);
    doc.documentElement.classList.add('pxw-open');
    var canvas = root.querySelector('.pxw-canvas');
    var ctx = canvas.getContext('2d');
    var q = function (s) { return root.querySelector(s); };
    var elArea = q('.pxw-area'), elClock = q('.pxw-clock'), elHail = q('.pxw-hailchip'), elLive = q('.pxw-live');
    var elDlg = q('.pxw-dialog'), elDText = q('.pxw-dtext'), elDOpts = q('.pxw-dopts');
    var elPanel = q('.pxw-panel'), elPTitle = q('.pxw-ptitle'), elPBody = q('.pxw-pbody');
    root.focus();

    function say(msg) { elLive.textContent = ''; elLive.textContent = msg; }
    function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
    function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

    // data ---------------------------------------------------------------
    function leadEnv() {
      return { stageRole: env.stageRole, normalizeStage: env.normalizeStage };
    }
    function allLeads() { var l = env.leads(); return Array.isArray(l) ? l : []; }
    function stageText(k) { return (env.stageLabel && env.stageLabel(k)) || k; }
    function party() {
      var members = PL.partyOf(allLeads(), leadEnv(), Date.now());
      state.flagged = WL.flagHail(members, env.summarizeAt);
      return members;
    }
    function sync() {
      var members = party();
      var fresh = WL.placePeople(world, members, MAX_PEOPLE);
      var old = {};
      state.people.forEach(function (p) { old[p.id] = p; });
      var used = new Set([state.pos.x + ',' + state.pos.y]);
      fresh.forEach(function (p) {
        var o = old[p.id];
        if (o && WL.walkable(world, o.x, o.y) && !used.has(o.x + ',' + o.y)) { p.x = o.x; p.y = o.y; p.homeX = o.homeX; p.homeY = o.homeY; p.facing = o.facing; }
        used.add(p.x + ',' + p.y);
      });
      state.people = fresh;
      state.members = members;
      state.lastRefresh = Date.now();
      if (state.flagged > 0) {
        elHail.hidden = false;
        elHail.textContent = 'HAIL WATCH: ' + state.flagged;
      } else elHail.hidden = true;
    }

    // dialog -------------------------------------------------------------
    var dlg = { pages: [], i: 0, opts: [], typed: 0, t0: 0, timer: 0, done: null };
    function closeDialog() {
      cancelAnimationFrame(dlg.timer);
      elDlg.hidden = true; elDText.textContent = ''; elDOpts.textContent = '';
      dlg.pages = [];
      state.busy = !!(elPanel.hidden === false || state.menuOpen);
    }
    function renderOpts() {
      elDOpts.textContent = '';
      dlg.opts.forEach(function (o) {
        var b;
        if (o.href && !o.disabled) { b = el('a', 'pxw-opt', o.label); b.href = o.href; }
        else { b = el('button', 'pxw-opt', o.label); b.type = 'button'; if (o.disabled) { b.disabled = true; b.title = o.note || ''; } }
        if (o.note && o.disabled) b.appendChild(el('span', 'pxw-optnote', ' ' + o.note));
        if (o.run && !o.disabled) b.addEventListener('click', function () { o.run(); });
        elDOpts.appendChild(b);
      });
      var first = elDOpts.querySelector('.pxw-opt:not([disabled])');
      if (first) first.focus();
    }
    function showPage() {
      var text = dlg.pages[dlg.i] || '';
      elDOpts.textContent = '';
      cancelAnimationFrame(dlg.timer);
      if (reduce()) { elDText.textContent = text; dlg.typed = text.length; afterPage(); return; }
      dlg.t0 = performance.now(); dlg.typed = 0;
      (function tick() {
        var s = PL.typewriterSlice(text, performance.now() - dlg.t0, 60);
        elDText.textContent = s; dlg.typed = s.length;
        if (s.length < text.length) dlg.timer = requestAnimationFrame(tick); else afterPage();
      })();
    }
    function afterPage() {
      if (dlg.i >= dlg.pages.length - 1) renderOpts();
      else elDOpts.textContent = '';
    }
    function openDialog(pages, opts) {
      dlg.pages = pages.slice(); dlg.i = 0; dlg.opts = opts || [{ label: 'OK', run: closeDialog }];
      elDlg.hidden = false; state.busy = true;
      say(pages.join(' '));
      showPage();
    }
    function advanceDialog() {
      if (elDlg.hidden) return false;
      var text = dlg.pages[dlg.i] || '';
      if (dlg.typed < text.length) { cancelAnimationFrame(dlg.timer); elDText.textContent = text; dlg.typed = text.length; afterPage(); return true; }
      if (dlg.i < dlg.pages.length - 1) { dlg.i++; showPage(); return true; }
      return true;
    }

    // panels -------------------------------------------------------------
    function closePanel() {
      elPanel.hidden = true; elPBody.textContent = '';
      state.menuOpen = false;
      state.busy = !elDlg.hidden;
      root.focus();
    }
    function openPanel(title, build) {
      closeDialog();
      elPTitle.textContent = title;
      elPBody.textContent = '';
      build(elPBody);
      elPanel.hidden = false; state.busy = true;
      var b = elPanel.querySelector('.pxw-row[data-pxw-lead], .pxw-btn');
      if (b) b.focus();
      say(title);
    }
    function row(label, value, cls) {
      var r = el('div', 'pxw-line' + (cls ? ' ' + cls : ''));
      r.appendChild(el('span', 'pxw-k', label));
      r.appendChild(el('span', 'pxw-v', value));
      return r;
    }
    function leadRow(m) {
      var r = el('button', 'pxw-row');
      r.type = 'button';
      r.setAttribute('data-pxw-lead', m.id);
      var nm = el('span', 'pxw-rname', m.name);
      var meta = m.overdue > 0 ? 'follow-up ' + m.overdue + 'd late' : (m.days == null ? 'no touch on record' : m.days + 'd since touch');
      var hp = el('span', 'pxw-hp tier-' + m.tier);
      var fill = el('i'); fill.style.width = (m.pct == null ? 0 : m.pct) + '%'; hp.appendChild(fill);
      r.appendChild(nm);
      r.appendChild(el('span', 'pxw-rmeta' + (m.overdue > 0 ? ' pxw-warn' : ''), meta));
      r.appendChild(hp);
      return r;
    }
    function leadList(host, list, emptyText) {
      if (!list.length) { host.appendChild(el('p', 'pxw-note', emptyText)); return; }
      list.forEach(function (m) { host.appendChild(leadRow(m)); });
    }

    function openBuilding(b, quiet) {
      var members = state.members || [];
      if (b.door && !quiet) { state.areaName = b.name; elArea.textContent = b.name; }
      if (b.id === 'leads') {
        openPanel('LEADS HALL', function (host) {
          host.appendChild(el('p', 'pxw-note', members.length + ' open lead' + (members.length === 1 ? '' : 's') + ', closest to going cold first. HP = days before a lead goes cold (' + PL.COLD_DAYS + ').'));
          leadList(host, members.slice(0, 60), 'No open leads. Nothing is going cold.');
          if (members.length > 60) host.appendChild(el('p', 'pxw-note', '+' + (members.length - 60) + ' more in the CRM pipeline.'));
        });
      } else if (b.id === 'workshop') {
        openPanel('ESTIMATE WORKSHOP', function (host) {
          var est = members.filter(function (m) { return /estimate|proposal|quote/i.test(m.stage); });
          host.appendChild(el('p', 'pxw-note', 'Leads in an estimate stage: ' + est.length + '.'));
          leadList(host, est, 'No estimates out right now.');
          var counts = {};
          members.forEach(function (m) { counts[m.stage] = (counts[m.stage] || 0) + 1; });
          host.appendChild(el('h4', 'pxw-sub', 'OPEN LEADS BY STAGE'));
          Object.keys(counts).sort(function (a, c) { return counts[c] - counts[a]; }).forEach(function (k) {
            host.appendChild(row(stageText(k), String(counts[k])));
          });
        });
      } else if (b.id === 'tower') {
        openPanel('STORM WATCH TOWER', function (host) {
          var hailed = members.filter(function (m) { return m.hailPct != null; });
          if (!env.hasOutlook()) host.appendChild(el('p', 'pxw-note', 'No storm outlook loaded yet. Open Storm Watch in the CRM, then come back.'));
          else host.appendChild(el('p', 'pxw-note', hailed.length ? hailed.length + ' of your leads sit inside today\'s hail-risk area (NOAA Storm Prediction Center outlook, roof not verified).' : 'No lead addresses are inside a hail-risk area today.'));
          leadList(host, hailed, '');
          var gate = WL.AREA_GATES.summit;
          host.appendChild(el('h4', 'pxw-sub', gate.name.toUpperCase()));
          if (WL.gateOpen('summit', env.isUnlocked)) {
            host.appendChild(el('p', 'pxw-note', 'Open. Highest hail chance today: ' + (hailed.length ? Math.max.apply(null, hailed.map(function (m) { return m.hailPct; })) + '%' : 'none on your leads') + '.'));
          } else host.appendChild(el('p', 'pxw-note pxw-locked', 'Locked. Earn the ' + gate.needs + ' achievement to open it.'));
        });
      } else if (b.id === 'bank') {
        openPanel('BANK', function (host) {
          var card = PL.trainerCard(allLeads(), { stageRole: env.stageRole, normalizeStage: env.normalizeStage }, Date.now());
          host.appendChild(row('PROJECTED PIPELINE', money(card.pipeline)));
          host.appendChild(el('p', 'pxw-note', 'Open leads\' job value. A projection, not money collected.'));
          host.appendChild(row('SIGNED THIS MONTH', String(card.signed)));
          var gate = WL.AREA_GATES.vault;
          host.appendChild(el('h4', 'pxw-sub', gate.name.toUpperCase()));
          if (WL.gateOpen('vault', env.isUnlocked)) {
            var top = members.filter(function (m) { return m.value > 0; }).sort(function (a, c) { return c.value - a.value; }).slice(0, 5);
            if (!top.length) host.appendChild(el('p', 'pxw-note', 'No open lead has a job value yet.'));
            top.forEach(function (m) { host.appendChild(row(m.name, money(m.value))); });
          } else host.appendChild(el('p', 'pxw-note pxw-locked', 'Locked. Earn the ' + gate.needs + ' achievement to open it.'));
        });
      } else if (b.id === 'trophy') {
        openPanel('TROPHY HALL', function (host) {
          var card = PL.trainerCard(allLeads(), { stageRole: env.stageRole, normalizeStage: env.normalizeStage, isUnlocked: env.isUnlocked }, Date.now());
          host.appendChild(row('LEVEL', String(card.level)));
          host.appendChild(row('SIGNED THIS MONTH', String(card.signed)));
          host.appendChild(row('OVERDUE FOLLOW-UPS', String(card.overdue)));
          host.appendChild(el('h4', 'pxw-sub', 'ACHIEVEMENT THEMES'));
          Object.keys(PL.THEME_BADGES).forEach(function (k) {
            var on = !!env.isUnlocked(k);
            host.appendChild(row(PL.THEME_BADGES[k], on ? 'EARNED' : 'LOCKED', on ? 'pxw-earned' : 'pxw-locked'));
          });
          host.appendChild(el('h4', 'pxw-sub', 'BADGES'));
          if (!card.badges.length) host.appendChild(el('p', 'pxw-note', 'None yet.'));
          card.badges.forEach(function (bd) { host.appendChild(row(bd.label, bd.hint)); });
        });
      } else if (b.id === 'office') {
        openPanel(env.officeName(), function (host) {
          var overdue = members.filter(function (m) { return m.overdue > 0; });
          var cold = members.filter(function (m) { return m.tier === 'cold'; });
          host.appendChild(row('OVERDUE FOLLOW-UPS', String(overdue.length)));
          host.appendChild(row('LEADS ABOUT TO GO COLD', String(cold.length)));
          host.appendChild(el('h4', 'pxw-sub', 'WORK THESE FIRST'));
          leadList(host, overdue.slice(0, 8), 'Nothing overdue. Clean slate.');
          var out = el('button', 'pxw-btn', 'BACK TO THE CRM');
          out.type = 'button'; out.setAttribute('data-pxw', 'exit');
          host.appendChild(out);
        });
      }
    }

    function dexPanel() {
      openPanel('LEAD DEX', function (host) {
        var rows = WL.dexEntries(allLeads(), state.seen, leadEnv());
        var caught = rows.filter(function (r) { return r.state === 'caught'; }).length;
        var seen = rows.filter(function (r) { return r.state !== 'unknown'; }).length;
        host.appendChild(el('p', 'pxw-note', 'Signed: ' + caught + '. Met: ' + seen + ' of ' + rows.length + '. Talk to townspeople to fill the Dex.'));
        rows.slice(0, 200).forEach(function (r) {
          var line = row('No. ' + String(r.no).padStart(3, '0') + '  ' + r.name, r.state === 'caught' ? 'SIGNED' : (r.state === 'seen' ? 'MET' : '???'), r.state === 'caught' ? 'pxw-earned' : '');
          host.appendChild(line);
        });
      });
    }
    function partyPanel() {
      openBuilding({ id: 'leads', name: 'PARTY' });
    }
    function helpPanel() {
      openPanel('HOW TO PLAY', function (host) {
        [
          'Arrow keys or WASD: walk. Space / Enter / A: talk or enter.',
          'Step on a building\'s door to open that part of the CRM.',
          'Red "!" over a head: that lead\'s follow-up date has passed.',
          'The bar over a head is HP: days before the lead goes cold.',
          'Esc / B: back. MENU: Party, Lead Dex, Trophies.',
          'Move stage uses the CRM\'s own rules. Draft text only files a draft in your Agent inbox. Nothing is texted from here.',
        ].forEach(function (t) { host.appendChild(el('p', 'pxw-note', t)); });
      });
    }
    function menu() {
      state.menuOpen = true;
      openPanel('MENU', function (host) {
        [['PARTY', partyPanel], ['LEAD DEX', dexPanel], ['TROPHIES', function () { openBuilding(WL.BUILDINGS.filter(function (b) { return b.id === 'trophy'; })[0], true); }], ['HOW TO PLAY', helpPanel], ['EXIT PIXEL WORLD', exit]].forEach(function (it) {
          var b = el('button', 'pxw-row pxw-menurow', it[0]);
          b.type = 'button';
          b.addEventListener('click', function () { it[1](); });
          host.appendChild(b);
        });
      });
    }

    // talk ---------------------------------------------------------------
    function markSeen(id) {
      var next = WL.markSeen(state.seen, id);
      if (next === state.seen) return;
      state.seen = next;
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(function () { if (env.saveSeen) env.saveSeen(state.seen); }, 2000);
    }
    function talkTo(m) {
      if (!m) return;
      markSeen(m.id);
      var raw = env.leadById ? env.leadById(m.id) : null;
      var phone = raw ? String(raw.phone || raw.phoneDigits || '').replace(/[^\d+]/g, '') : '';
      var opts = [];
      if (phone.length >= 7) opts.push({ label: 'CALL', href: 'tel:' + phone });
      else opts.push({ label: 'CALL', disabled: true, note: '(no phone on file)' });
      opts.push({ label: 'OPEN LEAD', run: function () { exit(); env.openLead(m.id); } });
      var writer = !!(env.canWrite && env.canWrite());
      if (!writer) opts.push({ label: 'DRAFT TEXT', disabled: true, note: '(view-only)' });
      else if (phone.length < 7) opts.push({ label: 'DRAFT TEXT', disabled: true, note: '(no phone on file)' });
      else if (typeof env.fileDraft !== 'function') opts.push({ label: 'DRAFT TEXT', disabled: true, note: '(unavailable)' });
      else opts.push({ label: 'DRAFT TEXT', run: function () { draftFlow(m); } });
      if (writer) opts.push({ label: 'MOVE STAGE', run: function () { moveFlow(m); } });
      else opts.push({ label: 'MOVE STAGE', disabled: true, note: '(view-only)' });
      opts.push({ label: 'BYE', run: closeDialog });
      openDialog([WL.talkLines(m, stageText(m.stage)).join('\n')], opts);
    }
    // E2b: stage moves go through the CRM's own moveCard (env.moveStage), so
    // every gate it has (role, lost reason, required fields, cancellation-window
    // warning) still applies. The game asks YES/NO itself (never window.confirm)
    // and offers UNDO.
    function moveFlow(m) {
      var adj = WL.adjacentStages(env.stageKeys(), m.stage, env.stageRole);
      var opts = [];
      if (adj.next) opts.push({ label: 'NEXT: ' + stageText(adj.next), run: function () { confirmMove(m, adj.next); } });
      if (adj.prev) opts.push({ label: 'BACK: ' + stageText(adj.prev), run: function () { confirmMove(m, adj.prev); } });
      opts.push({ label: 'CANCEL', run: function () { talkTo(m); } });
      openDialog([adj.next || adj.prev ? 'Move ' + m.name + ' from ' + stageText(m.stage) + '?' : 'No stage to move to from here. Open the lead to change it.'], opts);
    }
    function confirmMove(m, target) {
      openDialog(['Move ' + m.name + '\nfrom ' + stageText(m.stage) + '\nto ' + stageText(target) + '?'], [
        { label: 'YES', run: function () { doMove(m, target); } },
        { label: 'NO', run: function () { moveFlow(m); } },
      ]);
    }
    function doMove(m, target) {
      var before = m.stage;
      openDialog(['Moving...'], []);
      Promise.resolve().then(function () { return env.moveStage(m.id, target); }).catch(function () { /* judged by the lead below */ }).then(function () {
        var out = WL.moveOutcome(target, env.stageOf(m.id));
        sync();
        if (out === 'moved') {
          openDialog([m.name + ' is now in ' + stageText(target) + '.'], [
            { label: 'UNDO', run: function () {
              openDialog(['Moving back...'], []);
              Promise.resolve().then(function () { return env.moveStage(m.id, before); }).catch(function () {}).then(function () {
                sync();
                openDialog([WL.moveOutcome(before, env.stageOf(m.id)) === 'moved' ? 'Moved back to ' + stageText(before) + '.' : 'Could not move back. Open the lead.'], [{ label: 'OK', run: closeDialog }]);
              });
            } },
            { label: 'OK', run: closeDialog },
          ]);
        } else {
          openDialog(['Not moved. The pipeline needs something first (a required field, a lost reason, or it is a teammate\'s lead). Open the lead to finish.'], [
            { label: 'OPEN LEAD', run: function () { exit(); env.openLead(m.id); } },
            { label: 'OK', run: closeDialog },
          ]);
        }
      });
    }
    // E2c: DRAFT TEXT. The game picks a template KEY and asks the server to
    // file the draft (agent_inbox is create:false for clients). The server
    // checks role, tenant, STOP / Do Not Text / consent, wording and
    // idempotency, and the owner sends from the Agent inbox, where Send
    // re-checks texting hours. This code only reports what the server said.
    function draftFlow(m) {
      var opts = WL.DRAFT_TEMPLATES.map(function (t) { return { label: t.label, run: function () { doDraft(m, t); } }; });
      opts.push({ label: 'CANCEL', run: function () { talkTo(m); } });
      openDialog(['Which text should ' + m.name + ' get? It is only saved as a draft. You send it from the Agent inbox.'], opts);
    }
    function doDraft(m, t) {
      openDialog(['Filing the draft...'], []);
      Promise.resolve().then(function () { return env.fileDraft(m.id, t.key); }).then(
        function (res) { return WL.draftOutcome(res, null); },
        function (err) { return WL.draftOutcome(null, err); }
      ).then(function (out) {
        openDialog([out.lines.join('\n')], [
          { label: 'OK', run: function () { talkTo(m); } },
          { label: 'OPEN LEAD', run: function () { exit(); env.openLead(m.id); } },
        ]);
      });
    }
    function talkById(id) {
      var m = (state.members || []).filter(function (x) { return x.id === id; })[0];
      if (m) { closePanel(); talkTo(m); }
    }

    // input --------------------------------------------------------------
    var KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', W: 'up', s: 'down', S: 'down', a: 'left', A: 'left', d: 'right', D: 'right' };
    function onKeyDown(e) {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      var d = KEYMAP[e.key];
      if (d) {
        if (state.busy) return;
        state.keys[d] = true; e.preventDefault(); return;
      }
      if (e.key === ' ' || e.key === 'Enter') {
        var onBtn = e.target && e.target.closest && e.target.closest('button, a');
        if (onBtn && root.contains(onBtn)) return;     // let the focused control act
        e.preventDefault(); act(); return;
      }
      if (e.key === 'Escape' || e.key === 'b' || e.key === 'B') { e.preventDefault(); back(); return; }
      if (e.key === 'm' || e.key === 'M') { if (!state.busy) menu(); }
    }
    function onKeyUp(e) { var d = KEYMAP[e.key]; if (d) delete state.keys[d]; }
    function act() {
      if (!elDlg.hidden) { advanceDialog(); return; }
      if (state.busy) return;
      var door = WL.buildingAtDoor(world, state.pos.x, state.pos.y);
      if (door) { openBuilding(door); return; }
      var p = WL.personFacing(state.people, state.pos, state.facing);
      if (p) talkTo(p.member);
    }
    function back() {
      if (!elDlg.hidden) { closeDialog(); return; }
      if (!elPanel.hidden) { closePanel(); return; }
      menu();
    }
    function onClick(e) {
      var t = e.target && e.target.closest ? e.target.closest('[data-pxw],[data-pxw-lead]') : null;
      if (!t || !root.contains(t)) return;
      var lead = t.getAttribute('data-pxw-lead');
      if (lead) { talkById(lead); return; }
      var a = t.getAttribute('data-pxw');
      if (a === 'exit') exit();
      else if (a === 'menu') { if (state.menuOpen) closePanel(); else menu(); }
      else if (a === 'close-panel') closePanel();
      else if (a === 'act') act();
      else if (a === 'back') back();
    }
    function padDown(e) {
      var b = e.target && e.target.closest ? e.target.closest('[data-pxw-dir]') : null;
      if (!b || state.busy) return;
      e.preventDefault();
      state.pad = b.getAttribute('data-pxw-dir');
      try { b.setPointerCapture(e.pointerId); } catch (x) { /* not capturable */ }
    }
    function padUp() { state.pad = null; }
    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('keyup', onKeyUp);
    root.addEventListener('click', onClick);
    root.addEventListener('pointerdown', padDown);
    root.addEventListener('pointerup', padUp);
    root.addEventListener('pointercancel', padUp);

    // loop ---------------------------------------------------------------
    var scale = 3, view = { w: 240, h: 160 };
    function resize() {
      var dpr = Math.max(1, Math.min(3, w.devicePixelRatio || 1));
      var cw = root.clientWidth, ch = root.clientHeight;
      canvas.width = Math.floor(cw * dpr); canvas.height = Math.floor(ch * dpr);
      var css = Math.max(2, Math.floor(Math.min(cw / 320, ch / 192)));
      scale = Math.max(1, Math.floor(css * dpr));
      view.w = Math.ceil(canvas.width / scale); view.h = Math.ceil(canvas.height / scale);
      ctx.imageSmoothingEnabled = false;
    }
    w.addEventListener('resize', resize);

    function heldDir() {
      if (state.pad) return state.pad;
      var k = ['up', 'down', 'left', 'right'];
      for (var i = 0; i < k.length; i++) if (state.keys[k[i]]) return k[i];
      return null;
    }
    function blockedSet() {
      var s = new Set();
      state.people.forEach(function (p) { s.add(p.x + ',' + p.y); });
      return s;
    }
    function update(dt) {
      if (state.from) {
        state.t += dt;
        if (state.t >= STEP_MS) {
          state.pos = { x: state.to.x, y: state.to.y };
          state.from = state.to = null; state.t = 0; state.stepFlip = !state.stepFlip;
          var door = WL.buildingAtDoor(world, state.pos.x, state.pos.y);
          if (door) { releaseKeys(); openBuilding(door); }
          else if (state.areaName !== 'TOWN SQUARE') { state.areaName = 'TOWN SQUARE'; elArea.textContent = 'TOWN SQUARE'; }
        }
      }
      if (!state.from && !state.busy) {
        var d = heldDir();
        if (d) {
          var r = WL.tryMove(world, state.pos, d, blockedSet());
          state.facing = r.facing;
          if (r.moved) { state.from = { x: state.pos.x, y: state.pos.y }; state.to = { x: r.x, y: r.y }; state.t = 0; }
        }
      }
      // idle townspeople shuffle a tile now and then (not under Reduce Motion)
      if (!reduce()) {
        state.wander += dt;
        if (state.wander > 700) {
          state.wander = 0;
          var blocked = blockedSet(); blocked.add(state.pos.x + ',' + state.pos.y);
          if (state.to) blocked.add(state.to.x + ',' + state.to.y);
          var p = state.people[Math.floor(Math.random() * state.people.length)];
          if (p) {
            var s = WL.wanderStep(world, p, Math.random, blocked);
            if (s) { p.x = s.x; p.y = s.y; p.facing = s.facing; }
          }
        }
      }
      // refresh from the CRM and the clock
      var now = Date.now();
      if (now - state.lastRefresh > 45000) sync();
      var dt2 = new Date();
      var hr = dt2.getHours() + dt2.getMinutes() / 60;
      state.tint = WL.dayTint(hr);
      elClock.textContent = state.tint.name + ' ' + String(dt2.getHours()).padStart(2, '0') + ':' + String(dt2.getMinutes()).padStart(2, '0');
    }
    function releaseKeys() { state.keys = {}; state.pad = null; }

    var drops = [];
    for (var di = 0; di < 90; di++) drops.push({ x: Math.random(), y: Math.random(), s: 0.6 + Math.random() * 0.8 });

    function drawBuilding(b, cam) {
      var pal = BUILDING_PAL[b.palette] || BUILDING_PAL.slate;
      var x = b.x * TILE - cam.x, y = b.y * TILE - cam.y, wpx = b.w * TILE, hpx = b.h * TILE;
      ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(x + 3, y + hpx - 2, wpx, 4);        // ground shadow
      ctx.fillStyle = pal.wall; ctx.fillRect(x, y, wpx, hpx);
      ctx.fillStyle = pal.roof; ctx.fillRect(x - 2, y, wpx + 4, TILE + 6);
      ctx.fillStyle = pal.roof2;
      for (var i = 0; i < wpx + 4; i += 6) ctx.fillRect(x - 2 + i, y + TILE + 2, 3, 4);
      ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x - 2, y + TILE + 6, wpx + 4, 2);
      // windows
      ctx.fillStyle = '#7fb4e6';
      for (var wx = 6; wx < wpx - 8; wx += 20) {
        if (Math.abs((x + wx) - ((b.door.x * TILE - cam.x) + 1)) < 20) continue;
        ctx.fillRect(x + wx, y + TILE + 14, 10, 9);
        ctx.fillStyle = '#4c86c4'; ctx.fillRect(x + wx, y + TILE + 18, 10, 1); ctx.fillStyle = '#7fb4e6';
      }
      // sign
      ctx.font = '6px ' + FONT;
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillText(b.name, x + 4, y + 5);
      ctx.fillStyle = '#fff';
      ctx.fillText(b.name, x + 3, y + 4);
      // locked-room hint (a small padlock-ish pip on the tower / bank roof)
      var gate = null;
      Object.keys(WL.AREA_GATES).forEach(function (k) { if (WL.AREA_GATES[k].where === b.id) gate = k; });
      if (gate && !WL.gateOpen(gate, env.isUnlocked)) { ctx.fillStyle = '#d9b84a'; ctx.fillRect(x + wpx - 9, y + 3, 5, 4); ctx.fillStyle = '#7a5a10'; ctx.fillRect(x + wpx - 8, y + 1, 3, 3); }
      // door tile is drawn by the tileset; add a mat
      ctx.fillStyle = '#a14a22'; ctx.fillRect(b.door.x * TILE - cam.x + 2, b.door.y * TILE - cam.y + TILE - 2, TILE - 4, 2);
    }

    function drawPerson(p, cam, time) {
      var x = p.x * TILE - cam.x, y = p.y * TILE - cam.y;
      var m = p.member;
      ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(x + 3, y + 13, 10, 3);
      var pal = { h: '#3b2a1a', f: '#f1c7a0', e: '#2a1a10', t: hsl(p.hue, 55, 52), p: '#3d4a66', b: '#2a2a2a' };
      drawRows(ctx, personRows(p.facing, false), pal, x + 4, y + 1);
      // HP bar
      var tier = TIER_COLOR[m.tier] || TIER_COLOR.unknown;
      ctx.fillStyle = '#111'; ctx.fillRect(x + 2, y - 3, 12, 3);
      ctx.fillStyle = '#333'; ctx.fillRect(x + 3, y - 2, 10, 1);
      ctx.fillStyle = tier; ctx.fillRect(x + 3, y - 2, Math.max(0, Math.round(10 * (m.pct == null ? 0 : m.pct) / 100)), 1);
      // "!" bubble
      var bob = reduce() ? 0 : (Math.floor(time / 300) % 2);
      if (m.overdue > 0) {
        ctx.fillStyle = '#fff'; ctx.fillRect(x + 5, y - 13 - bob, 6, 8);
        ctx.fillStyle = '#c9302c'; ctx.fillRect(x + 7, y - 12 - bob, 2, 4); ctx.fillRect(x + 7, y - 7 - bob, 2, 1);
      }
      // hail-risk roof flag
      if (m.hailPct != null) {
        ctx.fillStyle = '#6ec6ff'; ctx.fillRect(x + 12, y - 8, 4, 1); ctx.fillRect(x + 13, y - 9, 2, 1);
        ctx.fillStyle = '#c9302c'; ctx.fillRect(x + 11, y - 7, 6, 2);
      }
    }

    function render(time) {
      var sx = state.from ? state.from.x + (state.to.x - state.from.x) * (state.t / STEP_MS) : state.pos.x;
      var sy = state.from ? state.from.y + (state.to.y - state.from.y) * (state.t / STEP_MS) : state.pos.y;
      var cam = WL.cameraFor(sx, sy, view.w, view.h, world);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#10151c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.imageSmoothingEnabled = false;
      var x0 = Math.max(0, Math.floor(cam.x / TILE)), y0 = Math.max(0, Math.floor(cam.y / TILE));
      var x1 = Math.min(world.w - 1, Math.floor((cam.x + view.w) / TILE)), y1 = Math.min(world.h - 1, Math.floor((cam.y + view.h) / TILE));
      var wave = reduce() ? 0 : (Math.floor(time / 600) % 2);
      for (var ty = y0; ty <= y1; ty++) for (var tx = x0; tx <= x1; tx++) {
        var t = world.tiles[ty * world.w + tx];
        ctx.drawImage(tileset, t * TILE, 0, TILE, TILE, tx * TILE - cam.x, ty * TILE - cam.y, TILE, TILE);
        if (t === WL.T.WATER && wave) { ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(tx * TILE - cam.x + 4, ty * TILE - cam.y + 7, 8, 1); }
      }
      world.buildings.forEach(function (b) { drawBuilding(b, cam); });
      // people + player, back to front
      var actors = state.people.map(function (p) { return { y: p.y, p: p }; });
      actors.push({ y: sy, player: true });
      actors.sort(function (a, b) { return a.y - b.y; });
      actors.forEach(function (a) {
        if (a.p) { drawPerson(a.p, cam, time); return; }
        var px = sx * TILE - cam.x, py = sy * TILE - cam.y;
        ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(px + 3, py + 13, 10, 3);
        var rows = personRows(state.facing, state.from ? state.stepFlip : false);
        rows[0] = '..cccc..'; rows[1] = '.cccccc.';
        drawRows(ctx, rows, { c: '#c8541a', h: '#3b2a1a', f: '#f1c7a0', e: '#2a1a10', t: '#f2f2f2', p: '#1f3a6e', b: '#222' }, px + 4, py + 1);
      });
      // day / night: multiply tint
      if (state.tint.a > 0.01) {
        ctx.globalCompositeOperation = 'multiply';
        var a = state.tint.a;
        ctx.fillStyle = 'rgb(' + Math.round(255 - (255 - state.tint.r) * a) + ',' + Math.round(255 - (255 - state.tint.g) * a) + ',' + Math.round(255 - (255 - state.tint.b) * a) + ')';
        ctx.fillRect(0, 0, view.w, view.h);
        ctx.globalCompositeOperation = 'source-over';
      }
      // hail event: falling ice while the outlook flags one of your leads
      if (state.flagged > 0 && !reduce()) {
        ctx.fillStyle = 'rgba(220,240,255,.85)';
        var fall = (time / 1000);
        drops.forEach(function (d) {
          var yy = ((d.y + fall * 0.9 * d.s) % 1) * view.h;
          var xx = ((d.x + fall * 0.25 * d.s) % 1) * view.w;
          ctx.fillRect(Math.floor(xx), Math.floor(yy), 1, 3);
        });
      }
    }

    function frame(time) {
      state.raf = requestAnimationFrame(frame);
      var dt = Math.min(50, state.last ? time - state.last : 16);
      state.last = time;
      update(dt);
      render(time);
    }

    function exit() {
      cancelAnimationFrame(state.raf);
      clearTimeout(state.saveTimer);
      if (env.saveSeen) env.saveSeen(state.seen);
      cancelAnimationFrame(dlg.timer);
      doc.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('keyup', onKeyUp);
      w.removeEventListener('resize', resize);
      root.remove();
      doc.documentElement.classList.remove('pxw-open');
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* gone */ } }
      if (env.onExit) env.onExit();
    }

    sync();
    resize();
    state.raf = requestAnimationFrame(frame);
    if (w.document && doc.fonts && doc.fonts.load) { try { doc.fonts.load('8px "Press Start 2P"'); doc.fonts.load('18px VT323'); } catch (e) { /* fallback font draws */ } }
    elArea.textContent = state.areaName;
    var crowd = state.people.length
      ? state.people.length + ' lead' + (state.people.length === 1 ? ' is' : 's are') + ' out and about. A red "!" means a follow-up is overdue.'
      : 'No open leads right now, so the streets are quiet.';
    openDialog([
      'Welcome to town. Walk to a door to open that part of the CRM.\n' + crowd,
    ], [{ label: 'START', run: closeDialog }]);

    return {
      exit: exit,
      refresh: sync,
      // exposed for tests and the console
      state: function () { return { pos: { x: state.pos.x, y: state.pos.y }, facing: state.facing, people: state.people.length, flagged: state.flagged, busy: state.busy, seen: state.seen.slice(), tint: state.tint }; },
      teleport: function (x, y) { if (WL.walkable(world, x, y)) { state.pos = { x: x, y: y }; state.from = state.to = null; } },
      press: function (d) { state.keys[d] = true; },
      release: function () { releaseKeys(); },
      act: act,
      menu: menu,
      people: function () { return state.people.map(function (p) { return { id: p.id, x: p.x, y: p.y }; }); },
    };
  }

  w.NBDPixelWorldGame = { start: start };
})();
