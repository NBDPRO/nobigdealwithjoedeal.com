/**
 * layouts/picker.js — Settings > Appearance > Layouts (2026-10-11, D2).
 *
 * Loaded lazily by layout-system.js the first time the Appearance tab is open,
 * so it costs a Classic rep nothing at boot. Mounts into #layoutsPanelBody.
 *
 *   - device toggle (Computer / Tablet / Phone): which screen you are choosing
 *     FOR. A choice is stored per device (userSettings.layout.byDevice).
 *   - one card per registered layout that supports that device, with a
 *     schematic thumbnail, what it is for, and Use / Try it.
 *   - Try it: previews on THIS screen for 30 seconds without saving, then
 *     Keep or Revert (it reverts on its own when the time is up). It opens
 *     Home (where the full-screen layouts draw) and returns to Settings after,
 *     and it is offered only when the chosen device is this screen.
 *   - Glove mode: the --tap token goes 56px -> 64px.
 *   - Company default / lock (owner or company_admin only; the rules enforce
 *     it): a default per device, which layouts are offered, and Lock.
 *
 * A locked company layout wins over everything here (layout-system.js
 * resolve()); the picker says so and disables Use / Try it rather than
 * pretending the choice worked.
 *
 * No inline handlers: one delegated click/change listener on the panel.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDLayoutPicker) return;
  var E = window.LayoutEngine, R = window.LayoutRegistry;
  if (!E || !R) return;
  // The Settings view is mounted from a template and can be re-mounted, so the
  // panel body is looked up each time and listeners sit on document.
  function mountEl() { return document.getElementById('layoutsPanelBody'); }

  var PREVIEW_SECONDS = 30;
  var DEVICES = [
    { id: 'desktop', label: 'Computer' },
    { id: 'tablet', label: 'Tablet' },
    { id: 'phone', label: 'Phone' },
  ];
  // Schematic thumbnails: tiny wireframes in theme tokens, so each card shows
  // the real theme's colours. Unknown layouts get the generic one.
  var THUMBS = {
    classic: '<rect x="2" y="2" width="14" height="56" rx="2" class="a"/><rect x="20" y="2" width="78" height="10" rx="2" class="b"/><rect x="20" y="16" width="24" height="18" rx="2" class="b"/><rect x="48" y="16" width="24" height="18" rx="2" class="b"/><rect x="76" y="16" width="22" height="18" rx="2" class="b"/><rect x="20" y="38" width="78" height="20" rx="2" class="b"/>',
    field: '<rect x="30" y="2" width="40" height="50" rx="5" class="b"/><rect x="34" y="8" width="32" height="12" rx="2" class="a"/><rect x="34" y="24" width="32" height="6" rx="2" class="c"/><rect x="34" y="33" width="32" height="6" rx="2" class="c"/><rect x="30" y="52" width="40" height="6" rx="2" class="b"/><circle cx="50" cy="52" r="6" class="a"/>',
    focus: '<rect x="14" y="4" width="72" height="52" rx="6" class="b"/><rect x="24" y="12" width="52" height="8" rx="2" class="a"/><rect x="24" y="26" width="52" height="5" rx="2" class="c"/><rect x="24" y="36" width="24" height="12" rx="3" class="a"/><rect x="52" y="36" width="24" height="12" rx="3" class="c"/>',
    mission: '<rect x="2" y="2" width="22" height="56" rx="3" class="b"/><rect x="28" y="2" width="44" height="56" rx="3" class="c"/><rect x="34" y="14" width="30" height="8" rx="2" class="a"/><rect x="40" y="30" width="24" height="8" rx="2" class="a"/><rect x="76" y="2" width="22" height="56" rx="3" class="b"/>',
    bento: '<rect x="2" y="2" width="46" height="26" rx="3" class="b"/><rect x="52" y="2" width="22" height="26" rx="3" class="a"/><rect x="78" y="2" width="20" height="12" rx="3" class="b"/><rect x="78" y="16" width="20" height="12" rx="3" class="b"/><rect x="2" y="32" width="30" height="26" rx="3" class="b"/><rect x="36" y="32" width="62" height="26" rx="3" class="b"/>',
    // crew lanes on a week grid, a job block spanning days
    crew: '<rect x="2" y="2" width="96" height="8" rx="2" class="b"/><rect x="2" y="13" width="18" height="45" rx="2" class="c"/><rect x="23" y="14" width="34" height="9" rx="2" class="a"/><rect x="45" y="27" width="40" height="9" rx="2" class="b"/><rect x="28" y="40" width="22" height="9" rx="2" class="b"/><rect x="64" y="40" width="30" height="9" rx="2" class="a"/>',
    // the pill on top, glass islands, the dock at the bottom
    island: '<rect x="26" y="2" width="48" height="8" rx="4" class="b"/><rect x="6" y="14" width="88" height="18" rx="6" class="b"/><rect x="12" y="19" width="34" height="8" rx="2" class="a"/><rect x="6" y="35" width="88" height="12" rx="6" class="b"/><rect x="30" y="50" width="40" height="8" rx="4" class="a"/>',
    // folder rail | list | thread
    inbox: '<rect x="2" y="2" width="18" height="56" rx="3" class="c"/><rect x="24" y="2" width="32" height="56" rx="3" class="b"/><rect x="27" y="6" width="26" height="6" rx="2" class="a"/><rect x="27" y="16" width="26" height="6" rx="2" class="c"/><rect x="27" y="26" width="26" height="6" rx="2" class="c"/><rect x="60" y="2" width="38" height="56" rx="3" class="b"/><rect x="64" y="44" width="30" height="10" rx="2" class="a"/>',
    generic: '<rect x="2" y="2" width="96" height="12" rx="2" class="a"/><rect x="2" y="18" width="46" height="40" rx="3" class="b"/><rect x="52" y="18" width="46" height="40" rx="3" class="b"/>',
  };
  // What each layout is FOR, in the rep's words. Neutral claims only.
  var ABOUT = {
    classic: 'The CRM exactly as you know it. Nothing changes.',
    field: 'Built for the driveway and the roof: today\'s stops, big buttons, a camera that is always one thumb away, and a sunlight mode.',
    focus: 'One lead at a time, ranked, with a plain line on why now and four big actions.',
    mission: 'A storm war room: the map with the hail swath, who is in its path, and canvass turfs.',
    bento: 'A dashboard of tiles you arrange yourself.',
    crew: 'Your crews as lanes on a week: drag a job to another day or crew, with rain days marked. Moves warn, they never block.',
    island: 'No sidebar: a nav pill on top, a dock with Record visit at the bottom, and your pages as glass panels over your wallpaper.',
    inbox: 'Texts, calls, new leads and nudges in one list, each with a reply-by timer and a drafted reply you send yourself.',
  };

  var state = { device: E.surface(), preview: null, timer: null, tick: null, left: 0, busy: false, adminOpen: false, returnTo: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); }
  function sayUserSave(r) {
    if (r && r.blocked) { toast('Your company\'s layout settings haven\'t loaded yet, so nothing changed. Check your connection and try again.', 'error'); return; }
    toast(r && r.saved ? 'Layout saved.' : 'Layout applied on this device. Couldn\'t sync it; check your connection.', r && r.saved ? 'success' : 'info');
  }
  function prefs() { return E.prefs(); }
  function lockInfo() {
    var p = prefs();
    var c = p.company;
    if (!c.locked) return null;
    var id = c.defaultByDevice[state.device] || c.defaultLayout;
    var d = id && R.get(id);
    return { id: id || R.FALLBACK, name: d ? d.name : 'Classic' };
  }
  function companyAllows(id) {
    var c = prefs().company;
    return id === R.FALLBACK || !c.allowed || c.allowed.indexOf(id) !== -1;
  }
  function mineFor(device) {
    var u = prefs().user;
    return u.byDevice[device] || (device === 'desktop' ? u.id : null) || null;
  }
  function effectiveFor(device) {
    // what this device will actually show, by the same rule the engine uses
    return R.resolve({ surface: device, user: prefs().user, company: prefs().company });
  }
  function canAdmin() {
    var c = window._userClaims || {};
    var role = String(c.role || '');
    if (role === 'viewer' || role === 'sales_rep' || role === 'manager') return false;
    var u = window._user && window._user.uid;
    return role === 'company_admin' || !c.companyId || c.companyId === u;
  }

  // ── render ───────────────────────────────────────────────────────────
  function thumb(id) {
    var t = THUMBS[id] || THUMBS.generic;
    return '<svg class="lp-thumb" viewBox="0 0 100 60" aria-hidden="true">' + t + '</svg>';
  }
  function cardHtml(d, eff, lock) {
    var current = eff.id === d.id;
    var mine = mineFor(state.device) === d.id;
    var off = !!lock || state.busy;
    // A preview shows on THIS screen, so it only makes sense when the device
    // being chosen for is this screen (Try a Phone layout from a computer and
    // nothing you would see is the phone's).
    var here = state.device === E.surface();
    var phoneOnly = d.surfaces.length && d.surfaces.indexOf('desktop') === -1;
    var h = '<article class="lp-card' + (current ? ' lp-current' : '') + '" data-layout-id="' + esc(d.id) + '">' + thumb(d.id) +
      '<h4 class="lp-name">' + esc(d.name) + (current ? ' <span class="lp-badge">In use</span>' : '') + '</h4>' +
      '<p class="lp-about">' + esc(ABOUT[d.id] || d.blurb || '') + '</p>' +
      '<p class="lp-meta">' + d.surfaces.map(function (s) { return esc(s === 'desktop' ? 'Computer' : s.charAt(0).toUpperCase() + s.slice(1)); }).join(' · ') +
      (d.supports && d.supports.sunlight ? ' · Sunlight mode' : '') + '</p>' +
      '<div class="lp-btns">' +
      '<button type="button" class="btn btn-ghost lp-btn" data-lp="use" data-id="' + esc(d.id) + '"' + (off || mine ? ' disabled' : '') + '>' + (mine ? 'Your choice' : 'Use this') + '</button>' +
      (d.id === R.FALLBACK ? '' : '<button type="button" class="btn btn-ghost lp-btn" data-lp="try" data-id="' + esc(d.id) + '"' +
        (off || current || !here ? ' disabled' : '') + (!here ? ' title="Open Settings on that device to try it there"' : '') + '>Try it (' + PREVIEW_SECONDS + 's)</button>') +
      '</div>' +
      (phoneOnly && state.device === window.LayoutEngine.surface() && window.LayoutEngine.surface() === 'desktop' ? '<p class="lp-note">Made for phones. On a computer it only shows in a narrow window.</p>' : '') +
      '</article>';
    return h;
  }
  function adminHtml() {
    var p = prefs();
    var c = p.company;
    var opts = R.forSurface(state.device);
    var cur = c.defaultByDevice[state.device] || c.defaultLayout || '';
    var h = '<details class="lp-admin"' + (state.adminOpen ? ' open' : '') + '><summary>Company default and lock</summary>' +
      '<p class="lp-note">Applies to your whole team. A locked layout cannot be changed by anyone on the team.</p>' +
      '<label class="lp-row">Default for ' + esc(DEVICES.filter(function (d) { return d.id === state.device; })[0].label.toLowerCase()) +
      '<select id="lpCompanyDefault" class="lp-select"><option value="">Classic (no default)</option>' +
      opts.filter(function (d) { return d.id !== R.FALLBACK; }).map(function (d) {
        return '<option value="' + esc(d.id) + '"' + (cur === d.id ? ' selected' : '') + '>' + esc(d.name) + '</option>';
      }).join('') + '</select></label>' +
      '<fieldset class="lp-fs"><legend>Layouts your team may pick</legend>' +
      R.list().filter(function (d) { return d.id !== R.FALLBACK; }).map(function (d) {
        var on = !c.allowed || c.allowed.indexOf(d.id) !== -1;
        return '<label class="lp-chk"><input type="checkbox" data-lp-allow="' + esc(d.id) + '"' + (on ? ' checked' : '') + '> ' + esc(d.name) + '</label>';
      }).join('') + '</fieldset>' +
      '<label class="lp-chk"><input type="checkbox" id="lpCompanyLock"' + (c.locked ? ' checked' : '') + '> Lock the layout (the team cannot change it)</label>' +
      '<div class="lp-btns"><button type="button" class="btn btn-orange lp-btn" data-lp="save-company">Save company layout</button>' +
      '<span class="lp-status" id="lpCompanyStatus" aria-live="polite"></span></div></details>';
    return h;
  }
  function render() {
    // keep the admin <details> open/closed across repaints (layoutchange repaints it)
    var openNow = document.querySelector('#layoutsPanelBody .lp-admin');
    if (openNow) state.adminOpen = openNow.open;
    var lock = lockInfo();
    var eff = effectiveFor(state.device);
    var h = '<div class="lp-devices" role="group" aria-label="Choose layout for">' +
      DEVICES.map(function (d) {
        return '<button type="button" class="btn btn-ghost lp-dev' + (state.device === d.id ? ' lp-dev-on' : '') + '" data-lp="device" data-id="' + d.id + '" aria-pressed="' + (state.device === d.id) + '">' + d.label + '</button>';
      }).join('') + '</div>';
    if (lock) {
      h += '<p class="lp-lock" role="status">Your company has set the layout for this screen to <strong>' + esc(lock.name) + '</strong>. It cannot be changed here.</p>';
    }
    h += '<div class="lp-grid">' + R.forSurface(state.device).filter(function (d) { return companyAllows(d.id); })
      .map(function (d) { return cardHtml(d, eff, lock); }).join('') + '</div>';
    var u = prefs().user;
    if (mineFor(state.device) && !lock) {
      h += '<p><button type="button" class="btn btn-ghost lp-btn" data-lp="clear" data-id="' + esc(state.device) + '">Use my company\'s default</button></p>';
    }
    h += '<label class="lp-chk lp-glove"><input type="checkbox" id="lpGlove"' + (u.glove ? ' checked' : '') + '> Glove mode — bigger buttons (64px instead of 56px)</label>';
    if (state.device !== E.surface()) h += '<p class="lp-note">Try it previews on the screen you are using. To try a ' + esc(DEVICES.filter(function (d) { return d.id === state.device; })[0].label.toLowerCase()) + ' layout, open Settings on that device; Use this saves it for that device from here.</p>';
    h += '<p class="lp-note">Your theme and My Skin work with every layout.</p>';
    if (canAdmin()) h += adminHtml();
    var mount = mountEl();
    if (mount) mount.innerHTML = h;
  }

  // ── preview ──────────────────────────────────────────────────────────
  function barEl() { return document.getElementById('lpPreviewBar'); }
  function showBar() {
    var bar = barEl();
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'lpPreviewBar';
      bar.className = 'lp-bar';
      bar.setAttribute('role', 'status');
      document.body.appendChild(bar);
    }
    var d = state.preview && R.get(state.preview);
    bar.innerHTML = '<span class="lp-bar-msg">Previewing <strong>' + esc(d ? d.name : '') + '</strong> — ' + state.left + 's left</span>' +
      '<button type="button" class="btn btn-orange lp-btn" data-lp="keep">Keep</button>' +
      '<button type="button" class="btn btn-ghost lp-btn" data-lp="revert">Revert</button>';
  }
  function hideBar() { var b = barEl(); if (b && b.parentNode) b.parentNode.removeChild(b); }
  function stopTimer() { if (state.tick) clearInterval(state.tick); state.tick = null; }
  // The full-screen layouts (Mission, Crew, Focus, Inbox, Field) draw over Home
  // only, so a preview started from Settings showed nothing at all: the
  // preview opens Home, and ending it comes back to Settings.
  function activeView() { var v = document.querySelector('.view.active'); return v && v.id ? v.id.replace(/^view-/, '') : ''; }
  function goView(v) { if (v && typeof window.goTo === 'function') { try { window.goTo(v); } catch (e) {} } }
  function endPreview(keep) {
    var id = state.preview;
    stopTimer();
    state.preview = null;
    hideBar();
    var back = state.returnTo;
    state.returnTo = null;
    if (back && activeView() !== back) goView(back);
    if (!id) return Promise.resolve();
    if (keep) {
      state.busy = true; render();
      return E.saveUser({ id: id, device: state.device }).then(function (r) {
        state.busy = false; render();
        sayUserSave(r);
        // not kept (settings unknown): end the preview like Revert does
        if (r && r.blocked) return E.refresh().then(function () { render(); });
      });
    }
    return E.refresh().then(function () { render(); });
  }
  function startPreview(id) {
    if (lockInfo() || state.device !== E.surface()) return;
    if (state.preview) stopTimer();
    state.preview = id;
    state.left = PREVIEW_SECONDS;
    if (!state.returnTo) { var from = activeView(); state.returnTo = from && from !== 'home' ? from : null; }
    E.apply(id, { source: 'preview' }).then(function () { goView('home'); showBar(); });
    showBar();
    state.tick = setInterval(function () {
      state.left -= 1;
      if (state.left <= 0) { endPreview(false); return; }
      showBar();
    }, 1000);
  }

  // ── actions ──────────────────────────────────────────────────────────
  function saveCompany() {
    var st = document.getElementById('lpCompanyStatus');
    var sel = document.getElementById('lpCompanyDefault');
    var lock = document.getElementById('lpCompanyLock');
    var boxes = (mountEl() || document).querySelectorAll('[data-lp-allow]');
    var allowed = [R.FALLBACK];
    var all = true;
    Array.prototype.forEach.call(boxes, function (b) {
      if (b.checked) allowed.push(b.getAttribute('data-lp-allow')); else all = false;
    });
    var c = prefs().company;
    var by = Object.assign({}, c.defaultByDevice);
    var pick = sel ? sel.value : '';
    if (pick) by[state.device] = pick; else delete by[state.device];
    var patch = {
      defaultByDevice: by,
      // the desktop pick doubles as the all-devices default so one choice is enough for a simple team
      defaultLayout: by.desktop || null,
      allowed: all ? null : allowed,
      locked: !!(lock && lock.checked),
    };
    if (st) st.textContent = 'Saving…';
    state.adminOpen = true;
    E.saveCompany(patch).then(function (r) {
      if (st) st.textContent = '';
      toast(r && r.saved ? 'Company layout saved.' : 'Couldn\'t save the company layout. Only an owner or admin can.', r && r.saved ? 'success' : 'error');
      render();
    });
  }
  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-lp]') : null;
    if (!t || !t.closest('#layoutsPanelBody, #lpPreviewBar')) return;
    var a = t.getAttribute('data-lp'), id = t.getAttribute('data-id');
    if (a === 'device') { if (state.preview) endPreview(false); state.device = id; render(); return; }
    if (a === 'try') { startPreview(id); return; }
    if (a === 'keep') { endPreview(true); return; }
    if (a === 'revert') { endPreview(false); return; }
    // the admin's own save works while locked (it is how a lock gets lifted);
    // firestore.rules is what keeps everyone else out of it
    if (a === 'save-company') { saveCompany(); return; }
    if (lockInfo()) return;
    if (a === 'use') {
      state.busy = true; render();
      E.saveUser({ id: id, device: state.device }).then(function (r) {
        state.busy = false; render();
        sayUserSave(r);
      });
      return;
    }
    if (a === 'clear') {
      state.busy = true; render();
      E.saveUser({ id: null, device: id }).then(function () { state.busy = false; render(); });
      return;
    }
  }
  function onChange(ev) {
    var t = ev.target;
    if (t && t.id === 'lpGlove') {
      E.saveUser({ glove: !!t.checked }).then(function () { render(); });
    }
  }

  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('layoutchange', function () { if (!state.busy) render(); });
  // Re-paint when the Settings view is re-mounted and the panel is the empty placeholder again.
  try {
    var raf = null;
    new MutationObserver(function () {
      if (raf) return;
      raf = setTimeout(function () {
        raf = null;
        var m = mountEl();
        if (m && !m.querySelector('.lp-devices')) render();
      }, 100);
    }).observe(document.body, { childList: true, subtree: true });
  } catch (e) {}
  // settings arrive after boot: repaint when the engine hydrates
  var hyd = 0;
  (function wait() {
    if (E.prefs().hydrated || ++hyd > 40) { render(); return; }
    setTimeout(wait, 400);
  })();
  render();

  window.NBDLayoutPicker = { render: render, startPreview: startPreview, endPreview: endPreview, _state: state };
})();
