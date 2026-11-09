/**
 * command-runner.js — window.NBDRunner: the KRunner-style action runner on top
 * of the Cmd+K palette (NBD OS P2, design §6.4, uncommon #4, 2026-11-09).
 *
 * Loaded lazily, never at boot: command-palette-scopes.js loads it (the
 * `cmdrunner` ScriptLoader bundle, registered at runtime) the first time the
 * palette opens, and the NBD OS layout loads it when the laptop desk mounts.
 * Node-testable through module.exports (`_pure`).
 *
 * What it adds:
 *   - providers: NBDCommand.registerProvider({ id, prefix?, label?, match(q) ->
 *     [{ id?, label, sub?, icon?, actions: [{ id, label, run?, href? }] }] }).
 *     A result row carries verbs. Built in: leads (window._leads, in memory),
 *     views (the sidebar), apps (NBD OS apps) and settings tabs. A provider row
 *     with the same id as a palette row lends that row its verbs instead of
 *     adding a second row. A provider with a prefix answers only when the box
 *     starts with it (the palette's own @ # > = t: are reserved).
 *   - lead verbs: Open, Call (tel:), Text (the device's Messages app, held by
 *     phone-share.js's "ok to text?" check, never sent from here) and Navigate
 *     (the Google Maps search link the CRM already uses).
 *   - keys: Tab / Shift+Tab and Right / Left (Right only with the caret at the
 *     end of the box) move between a row's verbs, Enter runs the lit one. Tab
 *     past the last verb of a lead row pins the lead, as before (palette 2.0).
 *   - Quick Keys: device-only aliases (nbd_ localStorage, so sign-out wipes
 *     them) such as nl = New Lead, rv = Record visit, ds = Daily Success, with
 *     a small editor inside the palette ("Edit Quick Keys").
 *   - on the NBD OS laptop desk: type-anywhere opens the runner with the key
 *     typed, ONLY when focus is on the desk itself (never an input or a
 *     window) and only while the "Type to search" setting is on (default on
 *     for laptops; off in the Control Center or the Quick Keys editor), so it
 *     meets WCAG 2.1.4; an opt-in hot corner (top-left, 250 ms dwell, off by
 *     default) opens it too.
 *
 * Reads nothing new: no Firestore, no network. Every field is escaped.
 * Strict CSP: no inline handlers, no style attributes (css/command-runner.css).
 */
(function (root) {
  'use strict';
  var prior = root && root.NBDRunner;
  if (prior && prior.__sentinel === 'nbd-runner-v1' && typeof module === 'undefined') return;

  var QK_KEY = 'nbd_cmd_quickkeys_v1';
  var TYPE_KEY = 'nbd_runner_type_v1';
  var CORNER_KEY = 'nbd_runner_corner_v1';
  var MAX_ALIASES = 30;
  var MAX_VERBS = 6;
  var MAX_ROWS = 6;            // per provider
  var MAX_EXTRA = 8;           // provider rows added under the palette's own
  var DWELL_MS = 250;
  var CORNER_PX = 2;
  var RESERVED = ['@', '#', '>', '=', 't:', 'theme:', 'themes:'];
  var DEFAULT_ALIASES = { nl: 'action-new-lead', rv: 'runner:record-visit', ds: 'runner:daily-success' };
  var MAPS = 'https://www.google.com/maps/search/?api=1&query=';

  // ── PURE ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function digits10(p) {
    var d = String(p == null ? '' : p).replace(/\D+/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }
  function telUrl(p) { var d = digits10(p); return d ? 'tel:+1' + d : ''; }
  function smsUrl(p) { var d = digits10(p); return d ? 'sms:+1' + d : ''; }
  function mapsUrl(a) { var s = String(a == null ? '' : a).trim(); return s ? MAPS + encodeURIComponent(s) : ''; }
  function leadName(l) {
    var n = (String(l.firstName || '') + ' ' + String(l.lastName || '')).trim();
    return n || String(l.name || '').trim() || '(no name)';
  }

  /** prefix match 100, substring 60, every word a word-prefix 25, else 0 */
  function scoreText(q, text) {
    var s = String(q == null ? '' : q).toLowerCase().trim();
    var t = String(text == null ? '' : text).toLowerCase();
    if (!s) return 0;
    if (t.indexOf(s) === 0) return 100;
    if (t.indexOf(s) !== -1) return 60;
    var words = t.split(/[^a-z0-9]+/).filter(Boolean);
    var qs = s.split(/\s+/).filter(Boolean);
    return qs.length && qs.every(function (w) { return words.some(function (x) { return x.indexOf(w) === 0; }); }) ? 25 : 0;
  }

  /** "NL " -> "nl"; 1-6 letters or digits, else null */
  function normalizeAlias(a) {
    var s = String(a == null ? '' : a).trim().toLowerCase();
    return /^[a-z0-9]{1,6}$/.test(s) ? s : null;
  }
  function cleanTarget(t) {
    var s = typeof t === 'string' ? t.trim() : '';
    return s && s.length <= 120 ? s : null;
  }
  /** The stored aliases; nothing stored (or unreadable) = the defaults; a saved {} stays empty. */
  function parseAliases(raw) {
    var obj = null;
    if (raw != null && raw !== '') { try { obj = JSON.parse(raw); } catch (e) { obj = null; } }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return Object.assign({}, DEFAULT_ALIASES);
    var out = {}, n = 0;
    Object.keys(obj).forEach(function (k) {
      var a = normalizeAlias(k), t = cleanTarget(obj[k]);
      if (a && t && !out[a] && n < MAX_ALIASES) { out[a] = t; n++; }
    });
    return out;
  }
  /** -> { map } or { error } */
  function setAlias(map, alias, target) {
    var a = normalizeAlias(alias), t = cleanTarget(target);
    if (!a) return { error: 'A Quick Key is 1 to 6 letters or numbers.' };
    if (!t) return { error: 'Pick what the Quick Key runs.' };
    var next = Object.assign({}, map || {});
    if (!next[a] && Object.keys(next).length >= MAX_ALIASES) return { error: 'That is the most Quick Keys this device keeps (' + MAX_ALIASES + ').' };
    next[a] = t;
    return { map: next };
  }
  function removeAlias(map, alias) {
    var next = Object.assign({}, map || {});
    delete next[normalizeAlias(alias) || ''];
    return next;
  }
  function aliasTarget(map, q) {
    var a = normalizeAlias(q);
    return a && map && Object.prototype.hasOwnProperty.call(map, a) ? map[a] : null;
  }

  /** The lead's verbs (data only; the DOM side binds them). */
  function leadVerbs(l) {
    var out = [{ id: 'open', label: 'Open' }];
    var tel = telUrl(l && (l.phone || l.phoneDigits));
    var nav = mapsUrl(l && l.address);
    if (tel) out.push({ id: 'call', label: 'Call', href: tel });
    if (tel) out.push({ id: 'text', label: 'Text', href: smsUrl(l.phone || l.phoneDigits), sms: true });
    if (nav) out.push({ id: 'nav', label: 'Navigate', href: nav, ext: true });
    return out;
  }

  var SAFE_HREF = /^(tel:\+?[\d-]+|sms:\+?[\d-]+|https:\/\/[^\s"'<>]+|\/(?!\/)[^\s"'<>]*)$/i;
  /** A provider's row, made safe: strings capped, verbs need run() or a safe href. Null to drop it. */
  function normalizeRow(row, pid, i, group) {
    if (!row || typeof row !== 'object') return null;
    var label = String(row.label == null ? '' : row.label).trim().slice(0, 120);
    if (!label) return null;
    var verbs = [];
    (Array.isArray(row.actions) ? row.actions : []).forEach(function (a, k) {
      if (!a || verbs.length >= MAX_VERBS) return;
      var href = typeof a.href === 'string' && SAFE_HREF.test(a.href) ? a.href : '';
      if (typeof a.run !== 'function' && !href) return;
      verbs.push({
        id: String(a.id == null ? 'v' + k : a.id).slice(0, 40),
        label: String(a.label == null ? (a.id == null ? 'Run' : a.id) : a.label).slice(0, 40) || 'Run',
        run: typeof a.run === 'function' ? a.run : null, href: href, ext: /^https:/i.test(href), sms: /^sms:/i.test(href) && a.sms === true,
        leadId: a.leadId != null ? String(a.leadId) : '',
      });
    });
    if (!verbs.length) return null;
    return {
      id: typeof row.id === 'string' && row.id ? row.id.slice(0, 160) : 'prov:' + pid + ':' + i,
      label: label, sublabel: String(row.sub == null ? '' : row.sub).slice(0, 160),
      icon: String(row.icon == null ? '•' : row.icon).slice(0, 4), group: String(row.group || group || 'More').slice(0, 40),
      verbs: verbs, xrow: 'runner',
    };
  }

  /** The type-anywhere guard (WCAG 2.1.4): a plain character, on the desk, with the setting on. */
  function shouldTypeOpen(ev, ctx) {
    var c = ctx || {};
    if (!ev || !c.enabled || !c.armed || !c.onDesk || c.paletteOpen || c.modalOpen) return false;
    if (ev.defaultPrevented || ev.isComposing || ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    var k = ev.key;
    if (typeof k !== 'string' || k.length !== 1) return false;
    return /\S/.test(k) && k !== '/';
  }
  function inCorner(x, y) { return Number(x) <= CORNER_PX && Number(y) <= CORNER_PX && Number(x) >= 0 && Number(y) >= 0; }

  /** Which registered provider owns a prefixed query: -> { p, q } or null */
  function prefixOwner(raw, list) {
    var s = String(raw == null ? '' : raw).replace(/^\s+/, '');
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.prefix && s.toLowerCase().indexOf(p.prefix.toLowerCase()) === 0) return { p: p, q: s.slice(p.prefix.length).trim() };
    }
    return null;
  }

  // ── registry ─────────────────────────────────────────────────────────
  var providers = [];
  function registerProvider(p) {
    if (!p || typeof p.id !== 'string' || !p.id || typeof p.match !== 'function') return false;
    var prefix = typeof p.prefix === 'string' ? p.prefix.trim() : '';
    if (prefix && (prefix.length > 6 || RESERVED.indexOf(prefix.toLowerCase()) !== -1)) return false;
    providers = providers.filter(function (x) { return x.id !== p.id; }).concat([{
      id: p.id.slice(0, 40), prefix: prefix, label: String(p.label || '').slice(0, 40), match: p.match, builtin: p.__builtin === true,
    }]);
    return true;
  }
  function unregisterProvider(id) { providers = providers.filter(function (x) { return x.id !== id; }); }
  function runMatch(p, q) {
    var rows;
    try { rows = p.match(q); } catch (e) { return []; }
    if (!Array.isArray(rows)) return [];
    var out = [];
    for (var i = 0; i < rows.length && out.length < MAX_ROWS; i++) {
      var r = rows[i] && rows[i].__row ? rows[i].__row : normalizeRow(rows[i], p.id, i, p.label);
      if (r) out.push(r);
    }
    return out;
  }

  // ── DOM side ─────────────────────────────────────────────────────────
  var doc = root && root.document;
  var R = { sel: { id: null, v: 0 }, last: [], actions: null, cssAdded: false, targets: {}, edOpen: false };

  function ls(k, v) {
    try {
      if (v === undefined) return root.localStorage.getItem(k);
      if (v === null) root.localStorage.removeItem(k); else root.localStorage.setItem(k, v);
    } catch (e) {}
    return null;
  }
  function toast(m, kind) { if (typeof root.showToast === 'function') { try { root.showToast(m, kind || 'info'); } catch (e) {} } }
  function ensureCss() {
    if (!doc || R.cssAdded || !doc.head) return;
    R.cssAdded = true;
    var l = doc.createElement('link');
    l.rel = 'stylesheet';
    l.href = '/pro/css/command-runner.css?v=1';
    doc.head.appendChild(l);
  }
  function leadById(id) {
    var arr = Array.isArray(root._leads) ? root._leads : [];
    for (var i = 0; i < arr.length; i++) if (arr[i] && String(arr[i].id) === id) return arr[i];
    return null;
  }
  function openLead(l) {
    var f = root.openCardDetailModal || root.openLeadDetail;
    if (typeof f === 'function') { try { f(l.id); return; } catch (e) {} }
    root.location.href = '/pro/customer.html?id=' + encodeURIComponent(l.id);
  }
  /** Text: a checked sms: link, so phone-share.js asks "ok to text?" first. Never sends. */
  function textLink(href, leadId) {
    if (!root.NBDPhoneShare || !doc || !doc.body) { toast('Texting isn\'t ready on this page. Open the customer to text.', 'error'); return; }
    var a = doc.createElement('a');
    a.setAttribute('href', href);
    a.setAttribute('data-ps-check', '');
    if (leadId) a.setAttribute('data-ps-lead', leadId);
    a.hidden = true;
    doc.body.appendChild(a);
    if (typeof a.click === 'function') a.click();
    (root.setTimeout || setTimeout)(function () { if (a.parentNode) a.parentNode.removeChild(a); }, 0);
  }
  function runVerb(v) {
    if (!v) return;
    try {
      if (v.sms && v.href) return textLink(v.href, v.leadId);
      if (v.run) return v.run();
      if (!v.href) return;
      if (v.ext) root.open(v.href, '_blank', 'noopener');
      else root.location.href = v.href;
    } catch (e) { try { root.console.warn('[runner] verb failed:', e); } catch (_) {} }
  }
  /** Bind data verbs for a lead; `open` is the palette's own run when it has one. */
  function bindLeadVerbs(l, open) {
    return leadVerbs(l).map(function (v) {
      var b = { id: v.id, label: v.label, href: v.href || '', ext: !!v.ext, sms: !!v.sms, leadId: String(l.id), run: null };
      if (v.id === 'open') b.run = typeof open === 'function' ? open : function () { openLead(l); };
      return b;
    });
  }
  function curVerb(item) { return item && R.sel.id === item.id ? Math.min(R.sel.v, item.verbs.length - 1) : 0; }
  function withRun(row) {
    row.run = function () { runVerb(row.verbs[curVerb(row)]); };
    return row;
  }
  /** Palette lead rows (`lead:<id>`) get the lead verbs; the row's own run stays the Open verb. */
  function leadRow(item) {
    if (!item || item.xrow || item.verbs || !/^lead:/.test(String(item.id))) return item;
    var l = leadById(String(item.id).slice(5));
    if (!l) return item;
    var row = Object.assign({}, item, { xrow: 'runner', verbs: bindLeadVerbs(l, item.run) });
    return withRun(row);
  }
  function decorateLeads(rows) {
    R.last = (Array.isArray(rows) ? rows : []).map(leadRow);
    return R.last;
  }

  // ── built-in providers ───────────────────────────────────────────────
  function osState() { try { return root.NBDOSLayout && root.NBDOSLayout.state(); } catch (e) { return null; } }
  function navHidden(n) {
    return !!(n.hidden || (n.classList && n.classList.contains('dn')) || (n.style && n.style.display === 'none') || n.getAttribute('aria-hidden') === 'true');
  }
  function ownText(n) {
    var t = '';
    (n.childNodes || []).forEach(function (c) { if (c.nodeType === 3) t += c.nodeValue; });
    return t.replace(/\s+/g, ' ').trim();
  }
  function goTo(id, arg) { if (typeof root.goTo === 'function') root.goTo(id, arg || {}); else root.location.href = '/pro/dashboard.html#' + encodeURIComponent(id); }
  function rowsFrom(q, list, make) {
    return list.map(function (x) { return { x: x, s: scoreText(q, x.label + ' ' + (x.kw || '')) }; })
      .filter(function (r) { return r.s > 0; }).sort(function (a, b) { return b.s - a.s; })
      .slice(0, 4).map(function (r) { return { __row: make(r.x) }; });
  }
  var BUILTIN = [
    { id: 'leads', label: 'Leads', match: function (q) {
      var s = String(q || '').trim(), dq = s.replace(/\D+/g, ''), lq = s.toLowerCase();
      if (s.length < 2) return [];
      var hits = [];
      (Array.isArray(root._leads) ? root._leads : []).forEach(function (l) {
        if (!l || l.deleted || l.id == null) return;
        var sc = Math.max(scoreText(lq, leadName(l)), scoreText(lq, l.address));
        if (dq.length >= 3 && String(l.phone || l.phoneDigits || '').replace(/\D+/g, '').indexOf(dq) !== -1) sc = Math.max(sc, 80);
        if (sc > 0) hits.push({ l: l, s: sc });
      });
      hits.sort(function (a, b) { return b.s - a.s; });
      return hits.slice(0, MAX_ROWS).map(function (h) {
        return { __row: withRun({ id: 'lead:' + h.l.id, label: leadName(h.l), sublabel: String(h.l.address || ''), icon: '👤', group: 'Leads', xrow: 'runner', verbs: bindLeadVerbs(h.l) }) };
      });
    } },
    { id: 'views', label: 'Views', match: function (q) {
      if (osState() || !doc) return [];   // on the NBD OS desk the apps provider answers instead
      var list = [];
      doc.querySelectorAll('.sidebar [data-action="goTo"][data-target]').forEach(function (n) {
        var id = n.getAttribute('data-target');
        if (!id || navHidden(n)) return;
        list.push({ id: id, label: ownText(n) || n.getAttribute('aria-label') || id, kw: id });
      });
      return rowsFrom(q, list, function (v) {
        return withRun({ id: 'go-' + v.id, label: v.label, sublabel: 'View', icon: '▤', group: 'Views', xrow: 'runner', verbs: [
          { id: 'open', label: 'Open', run: function () { goTo(v.id); } },
          { id: 'tab', label: 'New tab', href: '/pro/dashboard.html#' + encodeURIComponent(v.id), ext: true },
        ] });
      });
    } },
    { id: 'apps', label: 'Apps', match: function (q) {
      var S = osState();
      if (!S || !Array.isArray(S.apps)) return [];
      return rowsFrom(q, S.apps.map(function (a) { return { id: a.id, label: String(a.label || a.id), href: a.href, kw: a.id }; }), function (a) {
        return withRun({ id: 'os:app:' + a.id, label: 'Open ' + a.label, sublabel: 'App', icon: '▣', group: 'Apps', xrow: 'runner', verbs: [
          { id: 'open', label: 'Open', run: function () {
            if (a.href) root.open(a.href, '_self');
            else if (root.NBDOSLayout && typeof root.NBDOSLayout.open === 'function') root.NBDOSLayout.open(a.id);
          } },
        ] });
      });
    } },
    { id: 'settings', label: 'Settings', match: function (q) {
      if (!doc) return [];
      var list = [];
      doc.querySelectorAll('#view-settings .stab-btn[data-target]').forEach(function (b) {
        var id = b.getAttribute('data-target');
        if (!id || navHidden(b)) return;
        var label = String(b.textContent || '').replace(/^[^A-Za-z0-9]+/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (label) list.push({ id: id, label: label, kw: 'settings ' + id });
      });
      return rowsFrom(q, list, function (t) {
        return withRun({ id: 'os:set:' + t.id, label: 'Settings: ' + t.label, sublabel: 'Settings', icon: '⚙', group: 'Settings', xrow: 'runner', verbs: [
          { id: 'open', label: 'Open', run: function () {
            var O = root.NBDOS;
            if (O && typeof O.settingsTab === 'function') return O.settingsTab(t.id, null);
            goTo('settings', { id: t.id });
            (root.setTimeout || setTimeout)(function () { if (typeof root.switchSettingsTab === 'function') root.switchSettingsTab(t.id); }, 250);
          } },
        ] });
      });
    } },
  ];
  BUILTIN.forEach(function (p) { p.__builtin = true; registerProvider(p); });

  // ── Quick Keys ───────────────────────────────────────────────────────
  function aliases() { return parseAliases(ls(QK_KEY)); }
  function saveAliases(m) { ls(QK_KEY, JSON.stringify(m)); }
  var quickKeys = {
    get: aliases,
    set: function (a, t) { var r = setAlias(aliases(), a, t); if (r.map) saveAliases(r.map); return r; },
    remove: function (a) { saveAliases(removeAlias(aliases(), a)); },
    reset: function () { ls(QK_KEY, null); },
  };
  function cmd() { return root.NBDCommand || null; }
  /** The runner's own palette actions (the Quick Key targets). Registered when what they open exists. */
  function ensureTargets() {
    var C = cmd();
    if (!C || typeof C.registerAction !== 'function') return;
    function reg(id, def) { if (R.targets[id]) return; R.targets[id] = true; C.registerAction(Object.assign({ id: id }, def)); }
    reg('runner:quickkeys', { label: 'Edit Quick Keys', icon: '⌨', group: 'Runner', keywords: 'alias shortcut quick keys runner type search hot corner',
      run: function () { var c = cmd(); if (c) c.open(); openEditor(); } });
    var VL = root.NBDVisitRecorderLauncher;
    if (VL && typeof VL.begin === 'function') {
      reg('runner:record-visit', { label: 'Record visit', icon: '⏺', group: 'Actions', keywords: 'visit record audio meeting',
        run: function () { root.NBDVisitRecorderLauncher.begin({ source: 'fab' }); } });
    }
    var nav = doc && doc.getElementById('nav-daily');
    if (nav && !navHidden(nav)) {
      reg('runner:daily-success', { label: 'Daily Success', icon: '📅', group: 'Navigation', keywords: 'success tracker goals floors streak ds',
        run: function () { root.open('/pro/daily-success/', '_self'); } });
    }
  }

  /**
   * The plain-scope list: lead verbs on the palette's lead rows, provider rows
   * merged by id (or added under), and a Quick Key's target first.
   */
  function decorate(rows, raw, ctx) {
    ensureCss();
    ensureTargets();
    if (ctx && typeof ctx.allActions === 'function') R.actions = ctx.allActions;
    var own = prefixOwner(raw, providers);
    if (own) { R.last = runMatch(own.p, own.q); return R.last; }
    var out = (Array.isArray(rows) ? rows : []).map(leadRow);
    var q = String(raw == null ? '' : raw).trim();
    if (q) {
      var at = {};
      out.forEach(function (r, i) { if (r && r.id) at[r.id] = i; });
      var extra = [];
      providers.forEach(function (p) {
        if (p.prefix) return;
        runMatch(p, q).forEach(function (r) {
          if (Object.prototype.hasOwnProperty.call(at, r.id)) {
            var cur = out[at[r.id]];
            if (cur && !cur.verbs && !cur.xrow) out[at[r.id]] = withRun(Object.assign({}, cur, { xrow: 'runner', verbs: r.verbs }));
          } else if (extra.length < MAX_EXTRA) { at[r.id] = -1; extra.push(r); }
        });
      });
      out = out.concat(extra);
      var tid = aliasTarget(aliases(), q);
      if (tid) {
        var acts = R.actions ? R.actions() : [];
        var a = acts.filter(function (x) { return x && x.id === tid; })[0] || out.filter(function (x) { return x && x.id === tid; })[0];
        if (a) {
          out = out.filter(function (x) { return !x || x.id !== tid; });
          out.unshift(Object.assign({}, a, { group: 'Quick Key', sublabel: 'Quick Key ' + normalizeAlias(q), score: 2000 }));
        }
      }
    }
    R.last = out;
    return out;
  }

  // ── rows, verbs and keys ─────────────────────────────────────────────
  function rowHtml(item, idx) {
    var v = R.sel.id === item.id ? curVerb(item) : -1;   // only the selected row has a lit verb
    var c = item.card || {};
    var bits = [item.sublabel, c.stage, c.value].filter(function (b) { return b; });
    var i = Number(idx) || 0;
    return '<div class="nbd-cmd-row cmdx-row cmdr-row" data-idx="' + i + '">' +
      '<span class="cmdx-ico" aria-hidden="true">' + esc(item.icon || '•') + '</span>' +
      '<div class="cmdx-main"><div class="cmdx-label">' + esc(item.label) + '</div>' +
      (bits.length ? '<div class="cmdx-sub">' + bits.map(esc).join(' · ') + '</div>' : '') + '</div>' +
      '<div class="cmdr-verbs" role="group" aria-label="' + esc('Actions for ' + item.label) + '">' +
      item.verbs.map(function (vb, k) {
        return '<button type="button" tabindex="-1" class="cmdr-verb' + (k === v ? ' is-on' : '') + '" data-cmdr-v="' + k + '"' +
          (k === v ? ' aria-current="true"' : '') + '>' + esc(vb.label) + '</button>';
      }).join('') + '</div></div>';
  }
  function list() { return doc && doc.getElementById('nbd-cmd-results'); }
  function paintVerbs() {
    var l = list();
    if (!l) return;
    l.querySelectorAll('.cmdr-row').forEach(function (row) {
      var item = R.last[Number(row.getAttribute('data-idx'))];
      if (!item || !item.verbs) return;
      var v = R.sel.id === item.id ? curVerb(item) : -1;
      row.querySelectorAll('[data-cmdr-v]').forEach(function (b) {
        var on = Number(b.getAttribute('data-cmdr-v')) === v;
        b.classList.toggle('is-on', on);
        if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      });
    });
  }
  function onSelect(item) {
    var id = item && item.verbs ? item.id : null;
    if (R.sel.id !== id) { R.sel = { id: id, v: 0 }; paintVerbs(); }
  }
  /** Tab/Shift+Tab, Right (caret at the end)/Left move between the selected row's verbs. True = handled. */
  function onKey(e, st) {
    if (!e || !st) return false;
    var item = st.results && st.results[st.index];
    if (!item || !item.verbs || item.verbs.length < 2) return false;
    var n = item.verbs.length, v = curVerb(item), next = v;
    var inp = st.input || {};
    var atEnd = inp.selectionStart == null || inp.selectionStart >= String(inp.value || '').length;
    if (e.key === 'Tab' && !e.shiftKey && v < n - 1) next = v + 1;
    else if (e.key === 'Tab' && e.shiftKey && v > 0) next = v - 1;
    else if (e.key === 'ArrowRight' && !e.shiftKey && atEnd && v < n - 1) next = v + 1;
    else if (e.key === 'ArrowLeft' && !e.shiftKey && v > 0) next = v - 1;
    if (next === v) return false;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    R.sel = { id: item.id, v: next };
    paintVerbs();
    return true;
  }
  /** A verb button: run it (capture, so the row's own click never fires). */
  function onListClick(ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('[data-cmdr-v]') : null;
    if (!b) return;
    var row = b.closest('.cmdr-row');
    var item = row ? R.last[Number(row.getAttribute('data-idx'))] : null;
    var verb = item && item.verbs ? item.verbs[Number(b.getAttribute('data-cmdr-v'))] : null;
    if (!verb) return;
    ev.preventDefault();
    ev.stopPropagation();
    var C = cmd();
    if (C && typeof C.close === 'function') C.close();
    runVerb(verb);
  }
  function afterRender(listEl) {
    if (!listEl || listEl.__cmdr) return;
    listEl.__cmdr = true;
    listEl.addEventListener('click', onListClick, true);
  }

  // ── the Quick Keys editor (inside the open palette) ──────────────────
  function actionLabel(id) {
    var acts = R.actions ? R.actions() : [];
    var a = acts.filter(function (x) { return x && x.id === id; })[0];
    return a ? a.label : '';
  }
  function editorHtml(msg) {
    var m = aliases();
    var keys = Object.keys(m).sort();
    var acts = (R.actions ? R.actions() : []).filter(function (a) { return a && a.id && a.label; })
      .slice().sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); }).slice(0, 200);
    return '<div class="cmdr-ed-head"><b>Quick Keys</b><span class="cmdr-note">Type a key in the search box and press Enter. Saved on this device only.</span></div>' +
      '<ul class="cmdr-ed-list">' + (keys.length ? keys.map(function (k) {
        var lab = actionLabel(m[k]);
        return '<li class="cmdr-ed-row"><kbd class="cmdr-qk">' + esc(k) + '</kbd><span class="cmdr-ed-what">' +
          (lab ? esc(lab) : '<i>Not on this page</i>') + '</span>' +
          '<button type="button" class="cmdr-btn" data-cmdr-rm="' + esc(k) + '" aria-label="' + esc('Remove Quick Key ' + k) + '">Remove</button></li>';
      }).join('') : '<li class="cmdr-ed-row cmdr-note">No Quick Keys yet.</li>') + '</ul>' +
      '<div class="cmdr-ed-add">' +
        '<label class="cmdr-field"><span>Key</span><input type="text" class="cmdr-ed-key" maxlength="6" autocomplete="off" spellcheck="false" aria-label="Quick Key, 1 to 6 letters or numbers"></label>' +
        '<label class="cmdr-field"><span>Runs</span><select class="cmdr-ed-target" aria-label="What the Quick Key runs">' +
          acts.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(a.label) + '</option>'; }).join('') + '</select></label>' +
        '<button type="button" class="cmdr-btn cmdr-primary" data-cmdr-add="1">Add</button>' +
      '</div>' +
      '<p class="cmdr-ed-msg" role="status">' + esc(msg || '') + '</p>' +
      '<div class="cmdr-ed-opts">' +
        '<label class="cmdr-check"><input type="checkbox" data-cmdr-opt="type"' + (typeOpen.on() ? ' checked' : '') + '> Type on the NBD OS desktop to search (laptop)</label>' +
        '<label class="cmdr-check"><input type="checkbox" data-cmdr-opt="corner"' + (corner.on() ? ' checked' : '') + '> Hot corner: rest the pointer in the top-left corner to search</label>' +
      '</div>' +
      '<div class="cmdr-ed-foot"><button type="button" class="cmdr-btn" data-cmdr-reset="1">Reset Quick Keys</button>' +
        '<button type="button" class="cmdr-btn cmdr-primary" data-cmdr-done="1">Done</button></div>';
  }
  function closeEditor() {
    var ed = doc && doc.querySelector('.cmdr-ed');
    if (ed && ed.parentNode) ed.parentNode.removeChild(ed);
    var l = list();
    if (l) l.classList.remove('cmdr-hidden');
    R.edOpen = false;
    var i = doc && doc.getElementById('nbd-cmd-input');
    if (i) { i.focus(); if (typeof i.dispatchEvent === 'function' && root.Event) i.dispatchEvent(new root.Event('input')); }
  }
  function paintEditor(ed, msg, focusSel) {
    ed.innerHTML = editorHtml(msg);
    var f = focusSel && ed.querySelector(focusSel);
    if (f) f.focus();
  }
  function onEditorClick(ev) {
    var ed = ev.currentTarget || (ev.target && ev.target.closest && ev.target.closest('.cmdr-ed'));
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-cmdr-rm],[data-cmdr-add],[data-cmdr-reset],[data-cmdr-done],[data-cmdr-opt]') : null;
    if (!t || !ed) return;
    if (t.hasAttribute('data-cmdr-done')) return closeEditor();
    if (t.hasAttribute('data-cmdr-rm')) { quickKeys.remove(t.getAttribute('data-cmdr-rm')); return paintEditor(ed, 'Removed.', '.cmdr-ed-key'); }
    if (t.hasAttribute('data-cmdr-reset')) { quickKeys.reset(); return paintEditor(ed, 'Quick Keys are back to the defaults.', '.cmdr-ed-key'); }
    if (t.hasAttribute('data-cmdr-opt')) {
      var which = t.getAttribute('data-cmdr-opt'), on = !!t.checked;
      if (which === 'type') typeOpen.set(on); else if (which === 'corner') corner.set(on);
      var msgEl = ed.querySelector('.cmdr-ed-msg');
      if (msgEl) msgEl.textContent = which === 'type' ? (on ? 'Typing on the desktop opens search.' : 'Typing on the desktop does nothing now. Ctrl+K still opens search.')
        : (on ? 'Hot corner is on.' : 'Hot corner is off.');
      return;
    }
    if (t.hasAttribute('data-cmdr-add')) addFromEditor(ed);
  }
  function addFromEditor(ed) {
    var k = ed.querySelector('.cmdr-ed-key'), s = ed.querySelector('.cmdr-ed-target');
    var r = quickKeys.set(k ? k.value : '', s ? s.value : '');
    if (r.error) {
      var msgEl = ed.querySelector('.cmdr-ed-msg');
      if (msgEl) msgEl.textContent = r.error;
      if (k) k.focus();
      return;
    }
    paintEditor(ed, 'Saved: ' + normalizeAlias(k.value) + ' runs ' + (actionLabel(s.value) || s.value) + '.', '.cmdr-ed-key');
  }
  function onEditorKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); return closeEditor(); }
    if (ev.key === 'Enter' && ev.target && ev.target.classList && ev.target.classList.contains('cmdr-ed-key')) {
      ev.preventDefault();
      var ed = ev.target.closest('.cmdr-ed');
      if (ed) addFromEditor(ed);
    }
  }
  function openEditor() {
    var wrap = doc && doc.getElementById('nbd-cmd-modal');
    var l = list();
    if (!wrap || !l || !l.parentNode) return false;
    ensureCss();
    var ed = wrap.querySelector('.cmdr-ed');
    if (!ed) {
      ed = doc.createElement('div');
      ed.className = 'cmdr-ed';
      ed.setAttribute('role', 'region');
      ed.setAttribute('aria-label', 'Quick Keys');
      l.parentNode.insertBefore(ed, l);
      ed.addEventListener('click', onEditorClick);
      ed.addEventListener('change', onEditorClick);
      ed.addEventListener('keydown', onEditorKey);
    }
    l.classList.add('cmdr-hidden');
    R.edOpen = true;
    paintEditor(ed, '', '.cmdr-ed-key');
    return true;
  }

  // ── settings ─────────────────────────────────────────────────────────
  var typeOpen = { on: function () { return ls(TYPE_KEY) !== '0'; }, set: function (on) { ls(TYPE_KEY, on ? '1' : '0'); } };
  var corner = { on: function () { return ls(CORNER_KEY) === '1'; }, set: function (on) { ls(CORNER_KEY, on ? '1' : null); } };

  // ── the NBD OS desk: type-anywhere and the hot corner ────────────────
  // the widget column's empty space is desk; its widgets, tools and the Add sheet are not
  var BLOCK = '.os-win, .os-taskbar, .os-start, .os-hw, .os-hw-tools, .os-hw-add, .os-widget, .os-deskmenu, .os-snap, ' +
    'button, a, input, textarea, select, label, [contenteditable], [role="dialog"]';
  /** A press on the desk's own background (not a window, the taskbar, a widget or any control). */
  function isBareDesk(t, desk) {
    if (!t || !desk || !desk.contains || !desk.contains(t)) return false;
    return !(t.closest && t.closest(BLOCK));
  }
  function paletteOpen() { return !!(doc && doc.getElementById('nbd-cmd-modal')); }
  /** An open dialog on screen. The dashboard keeps hidden aria-modal sheets in the page: those do not count. */
  function modalOpen() {
    if (!doc) return false;
    var list = doc.querySelectorAll('dialog[open], [aria-modal="true"]');
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!n.hidden && (typeof n.getClientRects !== 'function' || n.getClientRects().length > 0)) return true;
    }
    return false;
  }
  function openPrefilled(ch) {
    var C = cmd();
    if (!C || typeof C.open !== 'function') return;
    C.open();
    var i = doc.getElementById('nbd-cmd-input');
    if (!i) return;
    i.value = ch;
    i.focus();
    if (typeof i.dispatchEvent === 'function' && root.Event) i.dispatchEvent(new root.Event('input'));
  }
  /** Wire the desk; returns the detach function. Only a press on the desk's background arms typing. */
  function attachDesk(desk) {
    if (!doc || !desk) return function () {};
    var st = { armed: false, cornerT: 0 };
    var set = root.setTimeout || setTimeout, clr = root.clearTimeout || clearTimeout;
    function onDown(ev) { st.armed = isBareDesk(ev.target, desk); }
    function onFocus(ev) { var t = ev.target; if (t && t !== doc.body && t !== desk && t !== doc.documentElement) st.armed = false; }
    function onKeyDown(ev) {
      var t = ev.target;
      var ok = shouldTypeOpen(ev, {
        enabled: typeOpen.on(), armed: st.armed && !!desk.isConnected,
        onDesk: !t || t === doc.body || t === desk || t === doc.documentElement,
        paletteOpen: paletteOpen(), modalOpen: modalOpen(),
      });
      if (!ok) return;
      ev.preventDefault();
      openPrefilled(ev.key);
    }
    function clearCorner() { if (st.cornerT) { clr(st.cornerT); st.cornerT = 0; } }
    function onMove(ev) {
      if (!corner.on() || (ev.pointerType && ev.pointerType !== 'mouse') || ev.buttons || !inCorner(ev.clientX, ev.clientY)) return clearCorner();
      if (st.cornerT) return;
      st.cornerT = set(function () {
        st.cornerT = 0;
        if (corner.on() && desk.isConnected && !paletteOpen() && !modalOpen()) { var C = cmd(); if (C && typeof C.open === 'function') C.open(); }
      }, DWELL_MS);
    }
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('focusin', onFocus, true);
    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('pointermove', onMove, { passive: true });
    return function detach() {
      clearCorner();
      doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('focusin', onFocus, true);
      doc.removeEventListener('keydown', onKeyDown);
      doc.removeEventListener('pointermove', onMove, { passive: true });
    };
  }

  var api = {
    __sentinel: 'nbd-runner-v1',
    registerProvider: registerProvider, unregisterProvider: unregisterProvider,
    providers: function () { return providers.map(function (p) { return { id: p.id, prefix: p.prefix, builtin: p.builtin }; }); },
    decorate: decorate, decorateLeads: decorateLeads, rowHtml: rowHtml, afterRender: afterRender, onSelect: onSelect, onKey: onKey,
    openEditor: openEditor, closeEditor: closeEditor, quickKeys: quickKeys, typeOpen: typeOpen, corner: corner,
    attachDesk: attachDesk, runVerb: runVerb,
    _pure: {
      esc: esc, telUrl: telUrl, smsUrl: smsUrl, mapsUrl: mapsUrl, scoreText: scoreText, normalizeAlias: normalizeAlias,
      parseAliases: parseAliases, setAlias: setAlias, removeAlias: removeAlias, aliasTarget: aliasTarget, leadVerbs: leadVerbs,
      normalizeRow: normalizeRow, shouldTypeOpen: shouldTypeOpen, inCorner: inCorner, prefixOwner: prefixOwner, isBareDesk: isBareDesk,
      DEFAULT_ALIASES: DEFAULT_ALIASES, RESERVED: RESERVED, QK_KEY: QK_KEY, TYPE_KEY: TYPE_KEY, CORNER_KEY: CORNER_KEY, DWELL_MS: DWELL_MS,
    },
  };
  if (root) {
    root.NBDRunner = api;
    // providers registered before this file loaded (NBDCommand.registerProvider queues them)
    var q = root.__nbdCmdProviders;
    if (Array.isArray(q)) { q.splice(0).forEach(registerProvider); }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
