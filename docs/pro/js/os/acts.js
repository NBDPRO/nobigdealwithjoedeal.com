/**
 * os/acts.js — NBD OS Activities and Focus modes, the live half (2026-11-09, P2;
 * design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6.3, uncommon #3).
 *
 * Phone modes (Canvassing, In a home, Storm day, Office; the member can rename them)
 * and laptop job-phase workspaces (desks 1-4: Leads, Inspect/Claim, Build, Collect).
 * The modes, their names and which one is on live in layoutState['os-home'] (acts,
 * on; os/home-logic.js); the layout (layouts/os.js) owns every write and passes a
 * host here. This file is:
 *
 *   lens(act)     the focus lens os/home.js paints through while a mode is on
 *                 (os/acts-logic.js over _leads, the tenant stageRole and the Today
 *                 plan it already holds: NBDToday.last(), never compute())
 *   openMenu()    a native <dialog>: each mode (pick it, or rename it on the phone),
 *                 and Off. (The Control Center tile "Mode" / "Workspace" and the
 *                 Spotlight actions "Switch to <mode>" are the layout's own.)
 *   "In a home"   turns Do Not Disturb on (system.js setDnd: routine toasts wait in
 *                 the Notification Center; warnings, errors and undo toasts are the
 *                 time-sensitive ones that show) and back off on leaving, only if it
 *                 turned it on; system.js asks privacy() to show only time-sensitive
 *                 notification groups
 *   a storm       OFFERS Storm day once per alert, in a toast whose one button
 *                 switches. Nothing in this file switches a mode by itself: only a
 *                 tap, a key or a Spotlight action does (Jo, 2026-11-09).
 *
 * Writes nothing but this device's two memos (nbd_os_acts_dnd: DND was turned on
 * by a mode; nbd_os_acts_storm: the alert last offered), both nbd_ keys wiped at
 * sign-out. Every name is escaped; no inline handlers, no style attributes.
 * Loaded as the runtime ScriptLoader bundle 'osacts' (os/home.js loadActs) once a
 * mode is on, a fresh storm alert waits to be offered, or the menu opens; never at
 * boot. window.NBDOSActs: { lens, privacy, attach(host), detach, openMenu(from),
 * changed() (the layout calls it after every switch or rename), switchTo(id) }.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var doc = W && W.document;
  if (!W || !doc || W.NBDOSActs) return;
  var HL = W.NBDOSHomeLogic, AL = W.NBDOSActsLogic;
  if (!HL || !AL) return;

  var DND_KEY = 'nbd_os_acts_dnd', STORM_KEY = 'nbd_os_acts_storm';
  var STORM_CACHE = 'nbd_storm_alerts_cache';
  var EVENTS = ['storage', 'nbd:data-refreshed', 'nbd:os-unlock', 'online'];
  var host = null, dlg = null, live = null, sysT = null, tries = 0, lastId = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function safe(fn) { try { return fn(); } catch (e) { try { console.warn('[os-acts]', e && e.message); } catch (_) {} return undefined; } }
  function lsGet(k) { try { return W.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) W.localStorage.removeItem(k); else W.localStorage.setItem(k, v); } catch (e) {} }
  function parse(raw) { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
  function phone() { return !!host && host.surface === 'phone'; }
  function cur() { return host ? safe(host.act) || null : null; }

  // ── the lens ──────────────────────────────────────────────
  function plan() { var T = W.NBDToday; return safe(function () { return T && typeof T.last === 'function' ? T.last() : null; }) || null; }
  function ctxOf(act) {
    return { focus: act.focus || {}, leads: W._leadsLoaded === true && Array.isArray(W._leads) ? W._leads : null,
      roleOf: typeof W.stageRole === 'function' ? W.stageRole : null, now: Date.now() };
  }
  function lens(act) {
    if (!act || typeof act !== 'object') return null;
    var c = ctxOf(act);
    return {
      plan: function (p) { return AL.lensPlan(p, c); },
      leads: function (l) { return AL.lensLeads(l, c); },
      urgency: function (u) { return AL.lensUrgency(u, c.focus); },
      nameOk: function (id) { return AL.nameOk(id, c, c.focus.privacy === true ? AL.currentAppt(plan(), c.now) : null); },
    };
  }
  function privacy() { var a = cur(); return !!(a && a.focus && a.focus.privacy === true); }

  // ── what each mode says it does ─────────────────────────────
  function line(a, deskFace) {
    var f = deskFace ? { phase: HL.PHASES[a.slot] } : (a.focus || {});
    if (f.privacy) return 'Hides money and other customers\' names. Only urgent alerts show.';
    if (f.phase) return 'Up Next and Needs you show ' + HL.PHASE_NAME[f.phase] + ' work only.';
    return 'Your whole day.';
  }
  function modes() {
    var list = host ? safe(host.acts) || [] : [];
    return list.map(function (a, i) {
      var desk = !phone();
      return { id: a.id, slot: i, name: desk ? HL.PHASE_NAME[HL.PHASES[i]] : a.name, label: desk ? 'Desk ' + String(i + 1) : '', line: line({ slot: i, focus: a.focus }, desk) };
    });
  }
  function offName() { return phone() ? 'Off' : 'Workspaces off'; }

  // ── switching: only ever from a tap, a key or Spotlight ─────
  function say(msg) {
    if (!live) {
      live = doc.createElement('p');
      live.className = 'os-acts-live';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      doc.body.appendChild(live);
    }
    live.textContent = '';
    live.textContent = msg;
  }
  /** A tap on a menu row or the storm toast's button: the layout switches, then calls changed(). */
  function switchTo(id) {
    if (host) safe(function () { host.switchTo(id); });
  }
  /** After any switch or rename (the layout calls it): Do Not Disturb, the Control Center, the open menu, a spoken line. */
  function changed() {
    syncDnd();
    var O = W.NBDOS;
    if (O && typeof O.refresh === 'function') safe(O.refresh);
    if (dlg && dlg.open) paintMenu();
    var a = cur(), id = a ? a.id + ':' + a.slot : null;
    if (id === lastId) return;
    lastId = id;
    say(a ? a.name + ' is on. ' + line(a, !phone()) : (phone() ? 'Mode off. Your home as you set it.' : 'Workspaces off. All work on every desk.'));
  }

  // ── "In a home": Do Not Disturb while it is on ───────────────
  function syncDnd() {
    var O = W.NBDOS;
    if (!O || typeof O.setDnd !== 'function' || typeof O.isDnd !== 'function') return;
    var mine = lsGet(DND_KEY) === '1';
    if (privacy()) {
      if (!mine && !O.isDnd()) { lsSet(DND_KEY, '1'); safe(function () { O.setDnd(true); }); }
    } else if (mine) {
      lsSet(DND_KEY, null);
      safe(function () { O.setDnd(false); });
    }
  }

  // ── a storm offers Storm day (phone), never switches ─────────
  function stormName() { var m = modes().filter(function (x) { return x.id === 'storm'; })[0]; return m ? m.name : 'Storm day'; }
  function checkStorm() {
    if (!phone()) return;
    var a = cur();
    var o = AL.stormOffer({ cache: parse(lsGet(STORM_CACHE)), now: Date.now(), on: a ? a.id : null, offered: lsGet(STORM_KEY) });
    if (!o.offer || typeof W.showToast !== 'function') return;
    lsSet(STORM_KEY, o.mark);
    var name = stormName();
    safe(function () {
      W.showToast({ message: o.event + ' nearby. Switch to ' + name + '?', type: 'warning', duration: 12000,
        undoText: 'Switch to ' + name, undoAction: function () { switchTo('storm'); } });
    });
  }
  function onEvent(ev) {
    if (ev && ev.type === 'storage' && ev.key && ev.key !== STORM_CACHE) return;
    checkStorm();
  }

  // ── the system layer loads lazily, often after this: Do Not Disturb waits for it ──
  function waitSystem() {
    var O = W.NBDOS;
    if (O && typeof O.setDnd === 'function') { syncDnd(); return; }
    if (++tries <= 20) sysT = W.setTimeout(waitSystem, 1500);
  }

  // ── the menu: a native <dialog> ─────────────────────────────
  var renaming = null;
  function rowHtml(m, on) {
    if (renaming === m.id) {
      return '<li class="os-acts-row is-renaming"><form class="os-acts-form" data-id="' + esc(m.id) + '">' +
        '<label class="os-acts-label"><span class="ui-eyebrow">Name</span>' +
        '<input class="os-acts-input" type="text" name="name" maxlength="' + String(HL.ACT_NAME_MAX) + '" value="' + esc(m.name) + '" autocomplete="off" required></label>' +
        '<div class="os-acts-form-btns"><button type="submit" class="btn btn-ghost os-acts-btn">Save</button>' +
        '<button type="button" class="ui-btn-quiet os-acts-btn" data-osacts="cancel">Cancel</button></div></form></li>';
    }
    return '<li class="os-acts-row' + (on ? ' is-on' : '') + '">' +
      '<button type="button" class="os-acts-pick" data-osacts="pick" data-id="' + esc(m.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="os-acts-name">' + (m.label ? '<span class="os-acts-desk">' + esc(m.label) + '</span>' : '') + esc(m.name) + '</span>' +
        '<span class="os-acts-line">' + esc(m.line) + '</span></button>' +
      (phone() ? '<button type="button" class="ui-btn-quiet os-acts-btn os-acts-ren" data-osacts="rename" data-id="' + esc(m.id) + '" aria-label="' + esc('Rename ' + m.name) + '">Rename</button>' : '') +
      '</li>';
  }
  function paintMenu() {
    if (!dlg) return;
    var a = cur();
    var title = phone() ? 'Mode' : 'Workspaces';
    var intro = phone()
      ? 'Each mode has its own widgets. You switch; nothing switches by itself.'
      : 'Each desk is a job phase with its own windows. You switch; nothing switches by itself.';
    dlg.innerHTML = '<h2 class="os-acts-title" id="osActsTitle">' + esc(title) + '</h2>' +
      '<p class="os-acts-intro">' + esc(intro) + '</p>' +
      '<ul class="os-acts-list">' + modes().map(function (m) { return rowHtml(m, !!a && a.id === m.id); }).join('') +
        '<li class="os-acts-row' + (a ? '' : ' is-on') + '"><button type="button" class="os-acts-pick" data-osacts="pick" data-id="" aria-pressed="' + (a ? 'false' : 'true') + '">' +
          '<span class="os-acts-name">' + esc(offName()) + '</span><span class="os-acts-line">' + esc(phone() ? 'Your home as you set it.' : 'All work on every desk.') + '</span></button></li>' +
      '</ul>' +
      '<div class="os-acts-foot"><button type="button" class="btn btn-ghost os-acts-btn" data-osacts="close">Done</button></div>';
  }
  var opener = null;
  function closeMenu() {
    if (!dlg) return;
    renaming = null;
    if (dlg.open) safe(function () { dlg.close(); });
    var f = opener;
    opener = null;
    if (f && f.isConnected !== false && typeof f.focus === 'function') safe(function () { f.focus(); });
  }
  function focusIn(sel) { var b = dlg && dlg.querySelector(sel); if (b) safe(function () { b.focus(); }); }
  function onMenuClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-osacts]') : null;
    if (!t) return;
    var what = t.getAttribute('data-osacts'), id = t.getAttribute('data-id') || '';
    if (what === 'close') return closeMenu();
    if (what === 'pick') { closeMenu(); return switchTo(id || null); }
    if (what === 'rename' && phone()) { renaming = id; paintMenu(); return focusIn('.os-acts-input'); }
    if (what === 'cancel') { var was = renaming; renaming = null; paintMenu(); return focusIn('[data-osacts="rename"][data-id="' + esc(was) + '"]'); }
  }
  function onMenuSubmit(ev) {
    var f = ev.target && ev.target.closest ? ev.target.closest('.os-acts-form') : null;
    if (!f) return;
    ev.preventDefault();
    var id = f.getAttribute('data-id'), input = f.querySelector('.os-acts-input');
    var name = input ? String(input.value || '') : '';
    renaming = null;
    if (host && typeof host.rename === 'function') safe(function () { host.rename(id, name); });
    paintMenu();
    focusIn('[data-osacts="rename"][data-id="' + esc(id) + '"]');
    var m = modes().filter(function (x) { return x.id === id; })[0];
    if (m) say('Renamed to ' + m.name + '.');
  }
  function openMenu(from) {
    if (!host) return;
    opener = from || doc.activeElement || null;
    if (!dlg) {
      dlg = doc.createElement('dialog');
      dlg.className = 'os-acts';
      dlg.setAttribute('aria-labelledby', 'osActsTitle');
      dlg.addEventListener('click', onMenuClick);
      dlg.addEventListener('submit', onMenuSubmit);
      dlg.addEventListener('close', function () { renaming = null; });
      // Escape closes it ourselves (focus back on the opener), whatever else on the page listens for Escape
      dlg.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Escape') return;
        ev.preventDefault();
        if (ev.stopPropagation) ev.stopPropagation();
        if (renaming) { var was = renaming; renaming = null; paintMenu(); focusIn('[data-osacts="rename"][data-id="' + esc(was) + '"]'); return; }
        closeMenu();
      });
      doc.body.appendChild(dlg);
    }
    renaming = null;
    paintMenu();
    if (!dlg.open) { if (typeof dlg.showModal === 'function') safe(function () { dlg.showModal(); }); else dlg.setAttribute('open', ''); }
    var a = cur();
    focusIn(a ? '[data-osacts="pick"][aria-pressed="true"]' : '.os-acts-pick');
  }

  // ── attach / detach (the layout's mount / unmount) ──────────
  function attach(h) {
    if (host) detach();
    if (!h || (h.surface !== 'phone' && h.surface !== 'desk')) return;
    host = h;
    tries = 0;
    var a = cur();
    lastId = a ? a.id + ':' + a.slot : null;
    waitSystem();
    EVENTS.forEach(function (t) { W.addEventListener(t, onEvent); });
    checkStorm();
  }
  function detach() {
    if (!host) return;
    W.clearTimeout(sysT);
    EVENTS.forEach(function (t) { W.removeEventListener(t, onEvent); });
    closeMenu();
    if (dlg && dlg.parentNode) dlg.parentNode.removeChild(dlg);
    dlg = null;
    host = null;
  }

  W.NBDOSActs = { lens: lens, privacy: privacy, attach: attach, detach: detach, openMenu: openMenu, changed: changed, switchTo: switchTo };
})();
