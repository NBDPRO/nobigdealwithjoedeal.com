/**
 * pixel-mode.js — Pixel Mode: a GBA/DS-style skin that sits on top of ANY
 * theme, plus a dialog-box notification style that works on its own
 * (2026-10-11, CRM style integration roadmap, slice E1).
 *
 * What it adds, each one switchable in Settings > Appearance > Pixel Mode:
 *   - body.skin-pixel     stepped pixel frames, Press Start 2P / VT323, ▶ cursor
 *   - body.px-scanlines   optional static scanline overlay
 *   - dialog notifications  toasts redrawn as a dialog box with a typewriter
 *                           (any theme; independent of the skin)
 *   - Home "Party" + "Trainer Card": the open leads closest to going cold,
 *     each with an HP bar, and your numbers with achievement badges
 *
 * Settings:  userSettings/{uid}.pixelMode = { skin, scanlines, dialog }.
 *            Not localStorage: nbd_ keys are wiped at every sign-out, and the
 *            skin should follow the person.
 *
 * Loaded by pixel-mode.js (the one boot tag) only when the settings say the
 * skin or dialog notifications are on, the Settings card is in view, or
 * Pixel World is opened. The stylesheet, the fonts and the logic module are
 * fetched once something is on; the town itself only when it is opened.
 *
 * Reads the CRM only (window._leads, ThemeEngine.isUnlocked). Writes nothing
 * but the person's own pixelMode preference. Nothing here sends anything.
 *
 * CSP: external deferred script; delegated listeners; message text is always
 * set through textContent (lead names are public input).
 */
(function () {
  'use strict';
  var w = typeof window !== 'undefined' ? window : null;
  var doc = typeof document !== 'undefined' ? document : null;

  // Same rule as NBDPixelLogic.normalizeMode; kept inline so a user with
  // everything off never downloads the logic module. A test pins them equal.
  function normalize(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    return { skin: r.skin === true, scanlines: r.scanlines === true, dialog: r.dialog === true };
  }
  // Pixel World switch. Default OFF; the person's own opt-in OR the company's
  // switch (companyProfile/{id}.pixelWorld.enabled), literal true only.
  function worldOn(userWorld, companyWorld) {
    return !!((userWorld && userWorld.enabled === true) || (companyWorld && companyWorld.enabled === true));
  }
  // Who may flip the company switch: the owner (company id == uid) and company_admin.
  function canSetCompany(claims, uid) {
    var c = claims || {};
    var role = c.role || '';
    if (role === 'viewer' || role === 'manager') return false;
    if (role === 'company_admin' || role === 'admin') return true;
    return !!uid && (!c.companyId || c.companyId === uid);
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { normalize: normalize, worldOn: worldOn, canSetCompany: canSetCompany }; }
  if (!w || !doc || (w.NBDPixelMode && !w.NBDPixelMode.__stub)) return;   // pixel-mode.js leaves a __stub

  var CSS_URL = '/pro/css/pixel-mode.css?v=1';
  var LOGIC_URL = '/pro/js/pixel-logic.js?v=1';
  var FONT_URL = 'https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap';

  var cfg = normalize(null);
  var uid = null;
  var localEditAt = 0;
  var assetsAsked = false;
  var logicPromise = null;
  var toastObserver = null;
  var homeTimer = null;
  var wildEl = null;

  // Pixel World (E2): lazy. Nothing below runs until someone opens it.
  var WORLD_LOGIC_URL = '/pro/js/pixel-world-logic.js?v=1';
  var WORLD_JS_URL = '/pro/js/pixel-world.js?v=1';
  var WORLD_CSS_URL = '/pro/css/pixel-world.css?v=1';
  var OUTLOOK_URL = '/pro/js/storm-outlook.js?v=1';
  var worldUser = { enabled: false };        // userSettings.pixelWorld (enabled flag)
  var worldSeen = [];                        // userSettings.pixelWorld.seen (Lead Dex)
  var worldCompany = null;                   // companyProfile/{id}.pixelWorld, read lazily
  var worldCompanyAsked = false;
  var worldGame = null;                      // the running game handle
  var worldOpening = false;
  var scriptPromises = {};

  var toast = function (m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); };
  var $ = function (id) { return doc.getElementById(id); };

  function reducedMotion() {
    var os = false;
    try { os = !!(w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { /* no matchMedia */ }
    return os || doc.documentElement.getAttribute('data-motion') === 'reduce';
  }

  // ── assets (only once something is on) ───────────────────────────────
  function ensureAssets() {
    if (assetsAsked) return;
    assetsAsked = true;
    [CSS_URL, FONT_URL].forEach(function (href) {
      var l = doc.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      doc.head.appendChild(l);
    });
  }
  function withLogic() {
    if (w.NBDPixelLogic) return Promise.resolve(w.NBDPixelLogic);
    if (logicPromise) return logicPromise;
    logicPromise = new Promise(function (resolve, reject) {
      var s = doc.createElement('script');
      s.src = LOGIC_URL; s.async = true;
      s.onload = function () { resolve(w.NBDPixelLogic); };
      s.onerror = function () { logicPromise = null; reject(new Error('pixel-logic failed to load')); };
      doc.head.appendChild(s);
    });
    return logicPromise;
  }

  // ── settings doc ─────────────────────────────────────────────────────
  function ready() {
    try { return !!(w._user && w._user.uid && w.db && w.doc && w.getDoc); } catch (e) { return false; }
  }
  function dataOf(snap) {
    var ok = snap && (typeof snap.exists === 'function' ? snap.exists() : !!snap.exists);
    return ok && typeof snap.data === 'function' ? (snap.data() || {}) : {};
  }
  function load() {
    uid = w._user.uid;
    var ref = w.doc(w.db, 'userSettings', uid);
    if (typeof w.onSnapshot !== 'function') {
      return w.getDoc(ref).then(function (s) { var d = dataOf(s); cfg = normalize(d.pixelMode); readWorld(d); apply(); });
    }
    return new Promise(function (resolve) {
      var settled = false;
      var done = function () { if (!settled) { settled = true; resolve(); } };
      // includeMetadataChanges + "ignore an empty cached snapshot": the same
      // boot-read hardening My Skin needed (a cache-only first read looks like
      // "no settings" while the connection is still coming up).
      w.onSnapshot(ref, { includeMetadataChanges: true }, function (snap) {
        var data = dataOf(snap);
        if (snap.metadata && snap.metadata.hasPendingWrites) return;
        if (snap.metadata && snap.metadata.fromCache && !data.pixelMode) return;
        if (Date.now() - localEditAt < 3000) { done(); return; }
        cfg = normalize(data.pixelMode);
        readWorld(data);
        apply();
        done();
      }, done);
      setTimeout(done, 15000);
    });
  }
  function readWorld(data) {
    var p = data && data.pixelWorld;
    worldUser = { enabled: !!(p && p.enabled === true) };
    worldSeen = p && Array.isArray(p.seen) ? p.seen.filter(function (x) { return typeof x === 'string'; }).slice(-400) : [];
  }
  function save() {
    localEditAt = Date.now();
    if (!uid) return Promise.resolve();
    return w.setDoc(w.doc(w.db, 'userSettings', uid), { pixelMode: cfg }, { merge: true })
      .catch(function () { toast('Couldn’t save Pixel Mode. Check your connection.', 'error'); });
  }

  // ── apply ────────────────────────────────────────────────────────────
  function apply() {
    var b = doc.body;
    if (!b) return;
    var any = cfg.skin || cfg.dialog;
    if (any) ensureAssets();
    b.classList.toggle('skin-pixel', cfg.skin);
    b.classList.toggle('px-scanlines', cfg.skin && cfg.scanlines);
    b.classList.toggle('px-dialog-notify', cfg.dialog);
    watchToasts(cfg.dialog);
    if (any) withLogic().then(renderHome).catch(function () { /* skin still works without the party card */ });
    else renderHome();
    renderPanel();
  }

  // ── dialog-box toasts ────────────────────────────────────────────────
  var TYPE_CPS = 55;
  function decorate(node) {
    if (!cfg.dialog || !node || node.nodeType !== 1 || !node.classList.contains('toast')) return;
    if (node.classList.contains('px-dialog')) return;
    node.classList.add('px-dialog');
    var msg = node.querySelector('.toast-message');
    if (!msg) return;
    var full = msg.textContent || '';
    if (reducedMotion() || !w.NBDPixelLogic) return;      // instant text, no typewriter
    msg.textContent = '';
    var sr = doc.createElement('span'); sr.className = 'px-sr'; sr.textContent = full;
    var ty = doc.createElement('span'); ty.className = 'px-type'; ty.setAttribute('aria-hidden', 'true');
    msg.appendChild(sr); msg.appendChild(ty);
    var t0 = (w.performance && performance.now) ? performance.now() : Date.now();
    (function tick() {
      if (!ty.isConnected) return;
      var now = (w.performance && performance.now) ? performance.now() : Date.now();
      var s = w.NBDPixelLogic.typewriterSlice(full, now - t0, TYPE_CPS);
      ty.textContent = s;
      if (s.length < full.length) w.requestAnimationFrame(tick);
    })();
  }
  function watchToasts(on) {
    if (toastObserver) { toastObserver.disconnect(); toastObserver = null; }
    if (!on || typeof MutationObserver !== 'function') return;
    var c = $('toastContainer');
    if (!c) return;
    toastObserver = new MutationObserver(function (list) {
      list.forEach(function (m) { m.addedNodes.forEach(decorate); });
    });
    toastObserver.observe(c, { childList: true });
  }

  // ── "A wild LEAD appeared!" ──────────────────────────────────────────
  function closeWild() {
    if (wildEl) { wildEl.remove(); wildEl = null; }
  }
  function wildLead(lead) {
    if (!cfg.dialog || !lead) return;
    var L = w.NBDPixelLogic;
    var name = L ? L.nameOf(lead) : String(lead.name || lead.firstName || 'a new lead');
    closeWild();
    wildEl = doc.createElement('div');
    wildEl.className = 'px-wild';
    wildEl.setAttribute('role', 'alertdialog');
    wildEl.setAttribute('aria-label', 'New lead');
    var t = doc.createElement('div'); t.className = 'px-wild-title'; t.textContent = 'A wild LEAD appeared!';
    var who = doc.createElement('div'); who.textContent = name + ' just came in. What now?';
    var opts = doc.createElement('div'); opts.className = 'px-wild-opts';
    var book = doc.createElement('button'); book.type = 'button'; book.setAttribute('data-px-wild', 'book'); book.textContent = 'BOOK IT';
    var later = doc.createElement('button'); later.type = 'button'; later.setAttribute('data-px-wild', 'later'); later.textContent = 'TEXT LATER';
    wildEl.setAttribute('data-px-lead-id', String(lead.id || ''));
    opts.appendChild(book); opts.appendChild(later);
    wildEl.appendChild(t); wildEl.appendChild(who); wildEl.appendChild(opts);
    doc.body.appendChild(wildEl);
    book.focus();
  }

  // ── Home: Trainer Card + Party ───────────────────────────────────────
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function leadEnv() {
    return {
      stageRole: typeof w.stageRole === 'function' ? w.stageRole : null,
      normalizeStage: typeof w.normalizeStage === 'function' ? w.normalizeStage : null,
      isUnlocked: function (k) {
        try { return !!(w.ThemeEngine && typeof w.ThemeEngine.isUnlocked === 'function' && w.ThemeEngine.isUnlocked(k)); } catch (e) { return false; }
      },
    };
  }
  var TIER_ROOF = { ok: '#5fbf6f', warn: '#e0b030', cold: '#d9534f', unknown: '#8a929e' };
  function sprite(tier) {
    var L = w.NBDPixelLogic;
    var wrap = el('span', 'px-sprite');
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.cssText = 'position:relative;display:block;width:44px;height:40px;';
    var px = el('i', 'px-house');
    var roof = TIER_ROOF[tier] || TIER_ROOF.unknown;
    px.style.boxShadow = L.spriteBoxShadow(L.HOUSE_ROWS, { r: roof, R: 'rgba(0,0,0,.45)', w: '#d8cfc0', g: '#6aa7d8', d: '#7a4a28' }, 4);
    px.style.cssText += ';position:absolute;left:0;top:0;';
    wrap.appendChild(px);
    return wrap;
  }
  function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

  function renderHome() {
    var host = $('homePixelParty');
    if (!host) return;
    var L = w.NBDPixelLogic;
    if (!cfg.skin || !L) { host.hidden = true; host.textContent = ''; stopHomeTimer(); return; }
    var leads = Array.isArray(w._leads) ? w._leads : [];
    var env = leadEnv();
    var now = Date.now();
    var card = L.trainerCard(leads, env, now);
    var party = L.partyOf(leads, env, now, 6);

    var frag = doc.createDocumentFragment();

    // Trainer Card
    var t = el('div', 'px-card px-trainer');
    t.setAttribute('aria-label', 'Trainer card');
    var hdr = el('div', 'px-card-hdr');
    hdr.appendChild(el('h3', 'px-h', 'TRAINER CARD'));
    hdr.appendChild(el('span', 'px-sub', 'LV ' + card.level));
    t.appendChild(hdr);
    var stats = el('div', 'px-stats');
    [
      ['OPEN LEADS', String(card.open)],
      ['OVERDUE', String(card.overdue)],
      ['SIGNED THIS MONTH', String(card.signed)],
      ['AVG HP', card.avgHp == null ? '—' : card.avgHp + '%'],
      ['PIPELINE (PROJECTED)', money(card.pipeline)],
    ].forEach(function (s) {
      var d = el('div', 'px-stat');
      d.appendChild(el('span', null, s[0]));
      d.appendChild(el('b', null, s[1]));
      stats.appendChild(d);
    });
    t.appendChild(stats);
    var badges = el('div', 'px-badges');
    if (card.badges.length) {
      card.badges.forEach(function (b) {
        var n = el('span', 'px-badge', b.label);
        n.title = b.hint;
        badges.appendChild(n);
      });
    } else badges.appendChild(el('span', 'px-empty', 'No badges yet. Clear your overdue follow-ups to earn Clean Slate.'));
    t.appendChild(badges);
    frag.appendChild(t);

    // Party
    var p = el('div', 'px-card px-party');
    p.setAttribute('aria-label', 'Party: leads closest to going cold');
    var ph = el('div', 'px-card-hdr');
    ph.appendChild(el('h3', 'px-h', 'PARTY'));
    ph.appendChild(el('span', 'px-sub', 'HP = days before a lead goes cold (' + L.COLD_DAYS + ')'));
    if (worldEnabled()) {
      var enter = el('button', 'btn btn-ghost px-enter', 'ENTER TOWN');
      enter.type = 'button';
      enter.setAttribute('data-px-open-world', '');
      ph.appendChild(enter);
    }
    p.appendChild(ph);
    var ul = el('ul', 'px-party-list');
    if (!party.length) ul.appendChild(el('li', 'px-empty', 'No open leads in your party.'));
    party.forEach(function (m) {
      var li = el('li', 'px-mon');
      li.setAttribute('data-px-lead', m.id);
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      li.appendChild(sprite(m.tier));
      li.appendChild(el('span', 'px-mon-name', m.name));
      var meta = m.overdue > 0 ? 'follow-up ' + m.overdue + 'd late' : (m.days == null ? 'no touch on record' : (m.days === 0 ? 'touched today' : m.days + 'd since touch'));
      li.appendChild(el('span', 'px-mon-meta' + (m.overdue > 0 ? ' px-mon-warn' : ''), meta));
      var bar = el('span', 'px-hp tier-' + m.tier);
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', m.pct == null ? 'HP unknown' : 'HP ' + m.pct + ' percent');
      var fill = el('i');
      fill.style.width = (m.pct == null ? 0 : m.pct) + '%';
      bar.appendChild(fill);
      li.appendChild(bar);
      ul.appendChild(li);
    });
    p.appendChild(ul);
    frag.appendChild(p);

    host.textContent = '';
    host.appendChild(frag);
    host.hidden = false;
    startHomeTimer();
  }
  function startHomeTimer() {
    if (homeTimer) return;
    homeTimer = setInterval(function () { if (!doc.hidden) renderHome(); }, 60000);
  }
  function stopHomeTimer() { if (homeTimer) { clearInterval(homeTimer); homeTimer = null; } }

  function openLead(id) {
    if (id) w.location.href = '/pro/customer.html?id=' + encodeURIComponent(id);
  }

  // ── Pixel World: switch, lazy assets, launch ─────────────────────────
  function claims() { return w._userClaims || {}; }
  function companyId() { return claims().companyId || uid; }
  function loadScript(url) {
    if (scriptPromises[url]) return scriptPromises[url];
    scriptPromises[url] = new Promise(function (resolve, reject) {
      var s = doc.createElement('script');
      s.src = url; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { delete scriptPromises[url]; reject(new Error('failed to load ' + url)); };
      doc.head.appendChild(s);
    });
    return scriptPromises[url];
  }
  function readCompanyFlag() {
    if (worldCompanyAsked || !ready()) return Promise.resolve(worldCompany);
    worldCompanyAsked = true;
    return w.getDoc(w.doc(w.db, 'companyProfile', companyId())).then(function (s) {
      var d = dataOf(s);
      worldCompany = d.pixelWorld && typeof d.pixelWorld === 'object' ? { enabled: d.pixelWorld.enabled === true } : null;
      return worldCompany;
    }).catch(function () { worldCompanyAsked = false; return worldCompany; });
  }
  function worldEnabled() { return worldOn(worldUser, worldCompany); }
  function worldAssets() {
    ensureAssets();
    if (!doc.querySelector('link[href="' + WORLD_CSS_URL + '"]')) {
      var l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = WORLD_CSS_URL;
      doc.head.appendChild(l);
    }
    return withLogic().then(function () { return loadScript(WORLD_LOGIC_URL); }).then(function () { return loadScript(WORLD_JS_URL); });
  }
  function leadById(id) {
    var list = Array.isArray(w._leads) ? w._leads : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function firstName() {
    var n = (w._user && (w._user.displayName || '')) || (w._userSettings && w._userSettings.displayName) || '';
    return String(n).trim().split(' ')[0] || '';
  }
  function saveWorld(patch) {
    if (!uid) return Promise.resolve();
    localEditAt = Date.now();
    return w.setDoc(w.doc(w.db, 'userSettings', uid), { pixelWorld: patch }, { merge: true })
      .catch(function () { toast('Couldn’t save that. Check your connection.', 'error'); });
  }
  function worldEnv() {
    return {
      leads: function () { return Array.isArray(w._leads) ? w._leads : []; },
      stageRole: function (k) { return typeof w.stageRole === 'function' ? w.stageRole(k) : null; },
      normalizeStage: function (k) { return typeof w.normalizeStage === 'function' ? w.normalizeStage(k) : k; },
      stageLabel: function (k) { try { return typeof w.stageLabel === 'function' ? w.stageLabel(k) : k; } catch (e) { return k; } },
      isUnlocked: function (k) {
        try { return !!(w.ThemeEngine && typeof w.ThemeEngine.isUnlocked === 'function' && w.ThemeEngine.isUnlocked(k)); } catch (e) { return false; }
      },
      summarizeAt: function (lat, lng) {
        try { return w.StormOutlook && typeof w.StormOutlook.summarizeAt === 'function' ? w.StormOutlook.summarizeAt(lat, lng) : null; } catch (e) { return null; }
      },
      hasOutlook: function () {
        try {
          var st = w.StormOutlook && w.StormOutlook.getState && w.StormOutlook.getState();
          return !!(st && ((st.cat && st.cat.length) || (st.hail && st.hail.length)));
        } catch (e) { return false; }
      },
      leadById: leadById,
      openLead: openLead,
      reduceMotion: reducedMotion,
      seen: worldSeen,
      saveSeen: function (arr) { worldSeen = arr.slice(-400); return saveWorld({ seen: worldSeen }); },
      officeName: function () { var n = firstName(); return n ? n.toUpperCase().slice(0, 14) + "'S OFFICE" : 'OFFICE'; },
      onExit: function () { worldGame = null; },
    };
  }
  function openWorld() {
    if (worldGame || worldOpening) return Promise.resolve();
    if (!uid) { toast('Sign in to open Pixel World.', 'warning'); return Promise.resolve(); }
    worldOpening = true;
    return readCompanyFlag().then(function () {
      if (!worldEnabled()) {
        toast('Pixel World is off. Turn it on in Settings > Appearance > Pixel Mode.', 'info');
        return null;
      }
      return worldAssets().then(function () {
        if (!w.NBDPixelWorldGame || typeof w.NBDPixelWorldGame.start !== 'function') throw new Error('pixel world did not load');
        worldGame = w.NBDPixelWorldGame.start(worldEnv());
        // SPC outlook powers the hail event. Best effort, never blocks the town.
        var kick = function () {
          if (w.StormOutlook && typeof w.StormOutlook.load === 'function') {
            return w.StormOutlook.load().then(function () { if (worldGame && worldGame.refresh) worldGame.refresh(); });
          }
        };
        (w.StormOutlook ? Promise.resolve() : loadScript(OUTLOOK_URL)).then(kick).catch(function () { /* no outlook: no hail event */ });
        return worldGame;
      });
    }).catch(function (e) {
      toast('Pixel World could not load. ' + ((e && e.message) || ''), 'error');
    }).then(function (g) { worldOpening = false; return g; });
  }
  function closeWorld() { if (worldGame && worldGame.exit) worldGame.exit(); worldGame = null; return Promise.resolve(); }

  // ── settings panel ───────────────────────────────────────────────────
  function renderPanel() {
    var panel = $('pixelModePanel');
    if (!panel) return;
    var map = { pxSkin: 'skin', pxScanlines: 'scanlines', pxDialog: 'dialog' };
    Object.keys(map).forEach(function (id) {
      var i = $(id);
      if (i) i.checked = !!cfg[map[id]];
    });
    var sc = $('pxScanlines');
    if (sc) sc.disabled = !cfg.skin;
    var wu = $('pxWorldUser'); if (wu) wu.checked = !!worldUser.enabled;
    var wrow = $('pxWorldCompanyRow');
    if (wrow) wrow.hidden = !canSetCompany(claims(), uid);
    var wc = $('pxWorldCompany'); if (wc) wc.checked = !!(worldCompany && worldCompany.enabled);
    var ob = $('pxOpenWorld'); if (ob) ob.hidden = !worldEnabled();
    if (!worldCompanyAsked && uid && ready()) readCompanyFlag().then(function () { renderPanel(); });
  }
  function onChange(e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'pxWorldUser') {
      if (!uid) { t.checked = !t.checked; return; }
      worldUser = { enabled: !!t.checked };
      saveWorld({ enabled: worldUser.enabled });
      renderPanel(); renderHome();
      return;
    }
    if (t.id === 'pxWorldCompany') {
      if (!uid || !canSetCompany(claims(), uid)) { t.checked = !t.checked; return; }
      var on = !!t.checked;
      localEditAt = Date.now();
      w.setDoc(w.doc(w.db, 'companyProfile', companyId()), { pixelWorld: { enabled: on } }, { merge: true })
        .then(function () { worldCompany = { enabled: on }; renderPanel(); renderHome(); })
        .catch(function () { t.checked = !on; toast('Couldn’t change the company setting. Only the owner or a company admin can.', 'error'); });
      return;
    }
    var map = { pxSkin: 'skin', pxScanlines: 'scanlines', pxDialog: 'dialog' };
    if (!map[t.id]) return;
    if (!uid) { t.checked = !t.checked; toast('Sign in to change Pixel Mode.', 'warning'); return; }
    cfg[map[t.id]] = !!t.checked;
    apply();
    save();
  }
  function onClick(e) {
    var tgt = e.target && e.target.closest ? e.target : null;
    if (!tgt) return;
    var mon = tgt.closest('[data-px-lead]');
    if (mon) { openLead(mon.getAttribute('data-px-lead')); return; }
    var wild = tgt.closest('[data-px-wild]');
    if (wild) {
      var id = wildEl && wildEl.getAttribute('data-px-lead-id');
      var which = wild.getAttribute('data-px-wild');
      closeWild();
      if (which === 'book') openLead(id);
      return;
    }
    if (tgt.closest('[data-px-open-world]')) { openWorld(); }
  }
  function onKey(e) {
    if (e.key === 'Escape' && wildEl) { closeWild(); return; }
    if ((e.key === 'Enter' || e.key === ' ') && e.target && e.target.classList && e.target.classList.contains('px-mon')) {
      e.preventDefault();
      openLead(e.target.getAttribute('data-px-lead'));
    }
  }
  function onLeadCreated(e) {
    var lead = e && e.detail && e.detail.lead;
    if (cfg.dialog && lead) withLogic().then(function () { wildLead(lead); }).catch(function () {});
  }

  // The Appearance tab and the Home template mount after boot.
  function watchMounts() {
    if (typeof MutationObserver !== 'function') return;
    var seen = function () {
      var p = $('pixelModePanel');
      if (p && !p.hasAttribute('data-px-ready')) { p.setAttribute('data-px-ready', ''); renderPanel(); }
      var h = $('homePixelParty');
      if (h && !h.hasAttribute('data-px-ready')) { h.setAttribute('data-px-ready', ''); renderHome(); }
    };
    new MutationObserver(seen).observe(doc.body, { childList: true, subtree: true });
    seen();
  }

  function boot() {
    var tries = 0;
    (function poll() {
      if (!ready()) { if (++tries <= 40) setTimeout(poll, 500); return; }
      load().catch(function () { /* settings unreadable: no skin, no noise */ });
    })();
    doc.addEventListener('change', onChange);
    doc.addEventListener('click', onClick);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('nbd:lead-created', onLeadCreated);
    watchMounts();
  }

  w.NBDPixelMode = {
    __v: 1,
    state: function () { return { uid: uid, cfg: Object.assign({}, cfg) }; },
    repaint: apply,
    wildLead: wildLead,
    open: openWorld,
    world: function () { return worldGame; },
    close: closeWorld,
    worldEnabled: worldEnabled,
    set: function (patch) { cfg = normalize(Object.assign({}, cfg, patch)); apply(); return save(); },
  };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})();
