/**
 * layouts/island.js — L04 "Island Dock" (2026-10-12, roadmap lane island-dock).
 *
 * No sidebar. A floating pill nav bar sits at the top of the content, a
 * floating action dock (New lead / Filter / Sort) at the bottom, and the
 * content is a set of rounded glass "islands" over the rep's wallpaper (or a
 * soft --glow2 wash when there is none). It is an ARRANGEMENT of what the CRM
 * already has, not a copy:
 *
 *   pill      goTo() targets read from the real sidebar (#nav-<id>): an item
 *             the sidebar hides for this role is not in the pill, and "More"
 *             clones the sidebar's own entries so every page stays one tap away
 *   dock      New lead = openLeadModal (what the Pipeline's Add Lead runs);
 *             Filter / Sort click the Pipeline's own Filters and Hot-first
 *             buttons, so the two toolbars can never disagree
 *   Home      a giant "In play" headline = PROJECTED pipeline value (every
 *             open job's jobValue, the same rule as the Pipeline header's
 *             "$N pipeline"; it is NOT collected revenue and says so), then
 *             today's appointments as a timeline (NBDToday.compute())
 *   Pipeline  the board's columns become swipeable stage lanes (CSS scroll-snap)
 *             with a lane-tab strip above them
 *
 * The job view (customer.html) is a separate page: js/layouts/island-job.js
 * gives it the hero image of the house.
 *
 * Nothing here sends anything or writes to the CRM. Hero numbers are read from
 * window._leads / NBDJobs; photos are the thumbnails the CRM already holds
 * (window._photoCache, via NBDPipelineRich.pickThumb) — no URL is minted here.
 *
 * Mounted by layout-system.js via LayoutEngine.implement('island', ...).
 * Needs js/layouts/kit.js + css/layouts/kit.css (registry `needs`).
 * Classic script; the pure half is require()-able for tests.
 */
(function (root) {
  'use strict';
  var HOUR = 3600000;

  // ── pure ─────────────────────────────────────────────────────────────
  function moneyOf(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    return parseFloat(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')) || 0;
  }
  function group(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /** $126,043 — the headline number. Never negative, never NaN. */
  function fmtBig(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) v = 0;
    return '$' + group(v);
  }
  /** $126K / $1.2M for tight spots. */
  function fmtShort(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) v = 0;
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
    if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  }

  var CLOSED_RE = /^(lost|closed|complete|won)$/i;
  /** Still in play: not lost, not won, not a job in production. */
  function defaultIsOpen(stageKey, lead) {
    var role = lead && lead._stageRole;
    if (role === 'won' || role === 'lost' || role === 'job') return false;
    return !CLOSED_RE.test(String(stageKey || ''));
  }
  /**
   * PROJECTED pipeline value + count of open jobs.
   * env: { money(v), isOpen(stageKey, lead), records(leads) }. Same rule as
   * crm-pipeline.js's pipeVal: every JOB (records), not lost, not closed.
   */
  function inPlay(leads, env) {
    var e = env || {};
    var money = typeof e.money === 'function' ? e.money : moneyOf;
    var isOpen = typeof e.isOpen === 'function' ? e.isOpen : defaultIsOpen;
    var list = Array.isArray(leads) ? leads : [];
    if (typeof e.records === 'function') {
      try { var r = e.records(list); if (Array.isArray(r)) list = r; } catch (_) { /* fall back to the leads */ }
    }
    var out = { count: 0, value: 0 };
    list.forEach(function (l) {
      if (!l || l.deleted === true) return;
      var sk = l._stageKey || l.stage || 'new';
      if (!isOpen(sk, l)) return;
      out.count++;
      out.value += money(l.jobValue);
    });
    return out;
  }

  /**
   * Today's timeline: appointments in time order, each tagged
   * past | now | next | later (exactly one `now`-or-`next` marker: the first
   * thing that is not over).
   */
  function timeline(plan, nowMs) {
    var a = plan && Array.isArray(plan.appointments) ? plan.appointments.slice() : [];
    a.sort(function (x, y) { return (Number(x.sortMs) || 0) - (Number(y.sortMs) || 0); });
    var marked = false;
    var rows = a.map(function (x) {
      var start = Number(x.sortMs) || 0;
      var len = Number(x.durationMs) > 0 ? Number(x.durationMs) : HOUR;
      var state;
      if (nowMs >= start + len) state = 'past';
      else if (!marked) { state = nowMs >= start ? 'now' : 'next'; marked = true; }
      else state = 'later';
      return {
        key: x.key || ('appt:' + (x.leadId || '') + ':' + start), leadId: x.leadId || '',
        name: x.name || '', address: x.address || '', phone: x.phone || '',
        timeLabel: x.timeLabel || '', type: x.type || '', sortMs: start, state: state,
      };
    });
    return {
      rows: rows,
      left: rows.filter(function (r) { return r.state !== 'past'; }).length,
      done: rows.filter(function (r) { return r.state === 'past'; }).length,
    };
  }

  /** The pill's items. `has(id)` says whether the sidebar offers that page. */
  var PILL = [
    { id: 'home', label: 'Today', icon: 'today' },
    { id: 'crm', label: 'Pipeline', icon: 'leads' },
    { id: 'schedule', label: 'Schedule', icon: 'cal' },
    { id: 'est', label: 'Estimates', icon: 'doc' },
    { id: 'calls', label: 'Calls', icon: 'call' },
  ];
  function pillItems(has) {
    var ok = typeof has === 'function' ? has : function () { return true; };
    return PILL.filter(function (it) { return ok(it.id); });
  }
  // Record visit is the dock's primary action (Joe's phone, 2026-10-15: the
  // floating Record bar stacked on top of this dock, off-centre, over the
  // cards). One bar now; island.css hides the floating one.
  var DOCK = [
    { id: 'record', label: 'Record visit', icon: 'rec', primary: true, record: true },
    { id: 'recent', label: 'Recent visits', icon: 'clock', recent: true },
    { id: 'newlead', label: 'New lead', icon: 'plus' },
    { id: 'filter', label: 'Filter', icon: 'filter' },
    { id: 'sort', label: 'Sort', icon: 'sort' },
  ];

  var logic = {
    moneyOf: moneyOf, fmtBig: fmtBig, fmtShort: fmtShort, defaultIsOpen: defaultIsOpen,
    inPlay: inPlay, timeline: timeline, pillItems: pillItems, PILL: PILL, DOCK: DOCK,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = logic;
  if (!root) return;
  root.NBDIslandLogic = logic;

  // ── browser: the layout ──────────────────────────────────────────────
  var W = root, doc = root.document;
  var K = W.NBDLayoutKit, E = W.LayoutEngine;
  if (!K || !E) return;
  var esc = K.esc;

  // icons beyond the kit's set: same stroke style (currentColor, 24 grid)
  var EXTRA = {
    plus: 'M12 5v14M5 12h14',
    filter: 'M4 5h16l-6 7v6l-4 2v-8z',
    sort: 'M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3',
    cal: 'M4 5h16v15H4zM4 10h16M9 3v4M15 3v4',
    doc: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    rec: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
    clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  };
  function ic(name) {
    if (EXTRA[name]) {
      return '<svg class="lk-ic" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + EXTRA[name] + '"/></svg>';
    }
    return K.icon(name);
  }

  var pillEl = null, dockEl = null, moreEl = null, laneEl = null, heroEl = null;
  var unbind = [], observers = [], timers = [], listeners = [];
  var mountedOn = false;
  var S = { active: 'home', moreOpen: false, laneRaf: 0 };

  function toast(m, t) { if (typeof W.showToast === 'function') W.showToast(m, t || 'info'); }
  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function on(target, type, fn, opt) { target.addEventListener(type, fn, opt); listeners.push([target, type, fn, opt]); }
  function every(fn, ms) { var t = setInterval(fn, ms); timers.push(t); return t; }

  // ── the pill and the dock ────────────────────────────────────────────
  function hasNav(id) {
    var n = doc.getElementById('nav-' + id);
    if (!n) return id === 'home' || id === 'crm';     // the two that always exist
    return !n.classList.contains('dn') && !n.hasAttribute('hidden');
  }
  function item(it, cls, active) {
    return '<button type="button" class="isl-item' + (cls ? ' ' + cls : '') + (it.id === active ? ' isl-active' : '') +
      (it.primary ? ' isl-primary' : '') + '" data-lk-nav="' + esc(it.id) + '"' +
      (it.id === active ? ' aria-current="page"' : '') + '>' + ic(it.icon) + '<span class="isl-lbl">' + esc(it.label) + '</span></button>';
  }
  function pillHtml() {
    var html = '<div class="isl-pill-in">';
    pillItems(hasNav).forEach(function (it) { html += item(it, 'isl-nav', S.active); });
    html += '<button type="button" class="isl-item isl-nav isl-more-btn' + (S.active === 'more' ? ' isl-active' : '') +
      '" data-lk-nav="more" aria-haspopup="true" aria-expanded="' + (S.moreOpen ? 'true' : 'false') + '">' +
      ic('more') + '<span class="isl-lbl">More</span></button>';
    return html + '</div>';
  }
  function dockHtml() {
    var sortOn = ls('nbd_crm_sort_engagement') === '1';
    var html = '<div class="isl-dock-in">';
    DOCK.forEach(function (it) {
      if (it.record) {
        // Not a data-lk-nav item: visit-recorder-launcher.js delegates
        // [data-nbd-record-visit] on document and opens the recorder.
        html += '<button type="button" class="isl-item isl-act isl-primary isl-rec" data-nbd-record-visit="" data-source="island-dock">' +
          ic(it.icon) + '<span class="isl-lbl">' + esc(K.RECORD_LABEL || it.label) + '</span></button>';
        return;
      }
      if (it.recent) {
        // beside Record: the last 14 days of visits, through the launcher's lazy path
        html += '<button type="button" class="isl-item isl-act isl-recent" data-nbd-recent-visits="" data-source="island-dock" aria-label="' + esc(it.label) + '">' +
          ic(it.icon) + '<span class="isl-lbl">' + esc(it.label) + '</span></button>';
        return;
      }
      var h = item(it, 'isl-act' + (it.id === 'sort' && sortOn ? ' isl-on' : ''), '');
      if (it.id === 'sort') h = h.replace('<button ', '<button aria-pressed="' + (sortOn ? 'true' : 'false') + '" ');
      html += h;
    });
    return html + '</div>';
  }
  function paintChrome() {
    if (pillEl) pillEl.innerHTML = pillHtml();
    if (dockEl) dockEl.innerHTML = dockHtml();
  }

  // The view name currently shown (view-<name>).
  function activeView() {
    var v = doc.querySelector('.content .view.active') || doc.querySelector('.view.active');
    return v && v.id ? v.id.replace(/^view-/, '') : 'home';
  }
  function syncActive() {
    var v = activeView();
    var inPill = pillItems(hasNav).some(function (it) { return it.id === v; });
    var next = inPill ? v : 'more';
    doc.documentElement.setAttribute('data-isl-view', v);
    if (next === S.active) return;
    S.active = next;
    paintChrome();
    afterViewChange();
  }

  // "More": the sidebar's own entries, cloned (so a page the sidebar offers is
  // here, and its data-action keeps working through the app's one delegate).
  function buildMore() {
    var side = doc.querySelector('.sidebar');
    if (!side) return;
    moreEl.textContent = '';
    var group = null;
    Array.prototype.forEach.call(side.querySelectorAll('.nav-section-header, .ni'), function (src) {
      if (src.classList.contains('dn') || src.hasAttribute('hidden')) return;
      if (src.classList.contains('nav-section-header')) {
        group = doc.createElement('div');
        group.className = 'isl-more-h';
        var span = src.querySelector('span');
        group.textContent = (span ? span.textContent : src.textContent).trim();
        moreEl.appendChild(group);
        return;
      }
      var clone = src.cloneNode(true);
      clone.removeAttribute('id');
      Array.prototype.forEach.call(clone.querySelectorAll('[id]'), function (n) { n.removeAttribute('id'); });
      clone.classList.remove('ni', 'active');
      clone.classList.add('isl-more-item');
      moreEl.appendChild(clone);
    });
  }
  function setMore(open) {
    S.moreOpen = !!open;
    if (open) buildMore();
    if (open && pillEl) {
      var r = pillEl.querySelector('.isl-pill-in').getBoundingClientRect();
      moreEl.style.top = Math.round(r.bottom + 8) + 'px';
    }
    moreEl.hidden = !open;
    var b = pillEl && pillEl.querySelector('.isl-more-btn');
    if (b) b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function goto(id) {
    if (typeof W.goTo === 'function') { W.goTo(id); return; }
    var n = doc.getElementById('nav-' + id);
    if (n) n.click();
  }
  // Run a Pipeline toolbar button from anywhere: open the pipeline first when
  // the rep is elsewhere, then click the real button once it exists.
  function pipelineButton(btnId, after) {
    function click() {
      var b = doc.getElementById(btnId);
      if (!b) return false;
      b.click();
      if (after) setTimeout(after, 60);
      return true;
    }
    stopPipelineWait();
    if (activeView() === 'crm' && click()) return;
    goto('crm');
    var tries = 0;
    // one wait at a time, and unmount clears it (it used to outlive the layout)
    pipeTimer = setInterval(function () {
      if (click() || ++tries > 25) stopPipelineWait();
    }, 120);
  }
  var pipeTimer = null;
  function stopPipelineWait() { if (pipeTimer) { clearInterval(pipeTimer); pipeTimer = null; } }
  function onNav(id) {
    if (id === 'more') { setMore(!S.moreOpen); return; }
    if (S.moreOpen) setMore(false);
    if (id === 'newlead') {
      if (typeof W.openLeadModal === 'function') W.openLeadModal();
      else toast('The lead form is still loading. Try again in a moment.', 'info');
      return;
    }
    if (id === 'filter') { pipelineButton('crmFiltersBtn'); return; }
    if (id === 'sort') { pipelineButton('engagementSortBtn', paintChrome); return; }
    goto(id);
  }

  // ── Home: the "in play" headline and today's timeline ────────────────
  function recordsFor(leads) {
    var J = W.NBDJobs;
    return J && typeof J.recordsFor === 'function' ? J.recordsFor(leads) : leads;
  }
  function moneyReader(v) {
    var R = W.NBDCustomerEstimateRows;
    if (R && typeof R.moneyValue === 'function') return R.moneyValue(v);
    return moneyOf(v);
  }
  function isOpenReal(stageKey, lead) {
    var P = W.NBDPipelineRich && W.NBDPipelineRich._pure;
    var open = P && typeof P.isOpenStage === 'function' ? P.isOpenStage(stageKey) : defaultIsOpen(stageKey, lead);
    if (open && lead && (lead._stageRole === 'won' || lead._stageRole === 'lost' || lead._stageRole === 'job')) return false;
    return open;
  }
  function plan() {
    try { if (W.NBDToday && W.NBDToday.compute && W._leadsLoaded === true) return W.NBDToday.compute(); } catch (e) { /* not ready */ }
    return null;
  }
  function leadById(id) {
    var list = W._leads || [];
    for (var i = 0; i < list.length; i++) if (list[i] && String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function thumbFor(leadId) {
    var lead = leadById(leadId);
    var P = W.NBDPipelineRich && W.NBDPipelineRich._pure;
    if (!lead || !P || typeof P.pickThumb !== 'function') return '';
    try { return P.pickThumb(lead, (W._photoCache && W._photoCache[leadId]) || [], true) || ''; } catch (e) { return ''; }
  }

  function heroHtml() {
    var loaded = W._leadsLoaded === true;
    var r = inPlay(W._leads || [], { money: moneyReader, isOpen: isOpenReal, records: recordsFor });
    var body;
    if (!loaded) {
      body = '<div class="isl-hero-num isl-skel" role="status">Loading</div>';
    } else {
      body = '<div class="isl-hero-num" data-isl="in-play">' + esc(fmtBig(r.value)) + '</div>' +
        '<div class="isl-hero-sub">' + r.count + ' open job' + (r.count === 1 ? '' : 's') +
        ' &middot; projected value, not money collected</div>';
    }
    return '<div class="isl-hero-k">In play &middot; projected</div>' + body;
  }
  function timelineHtml() {
    var p = plan();
    if (!p) return K.widget({ id: 'isl-today', title: 'Today', size: '4x1', state: 'loading', loadingText: 'Loading today...' });
    var tl = timeline(p, Date.now());
    var aside = tl.rows.length ? (tl.left + ' left' + (tl.done ? ' &middot; ' + tl.done + ' done' : '')) : '';
    if (!tl.rows.length) {
      return K.widget({ id: 'isl-today', title: 'Today', size: '4x1', state: 'empty', emptyText: 'Nothing on the calendar today.' });
    }
    var rows = '<ol class="isl-tl">';
    tl.rows.forEach(function (r) {
      var lead = r.leadId ? leadById(r.leadId) : null;
      var it = K.fromLead(lead || { id: r.leadId }, { name: r.name, address: r.address, phone: r.phone, timeLabel: r.timeLabel });
      var thumb = r.leadId ? thumbFor(r.leadId) : '';
      rows += '<li class="isl-tl-item isl-tl-' + r.state + '"' + (thumb ? ' data-isl-thumb="' + esc(thumb) + '"' : '') + '>' +
        '<span class="isl-tl-dot" aria-hidden="true"></span>' +
        K.card(it, { density: 'row', current: r.state === 'now' || r.state === 'next', done: r.state === 'past' }) + '</li>';
    });
    rows += '</ol>';
    var w = K.widget({ id: 'isl-today', title: 'Today', size: '4x1', body: rows });
    return aside ? w.replace('<h3 class="lk-w-title">Today</h3>', '<h3 class="lk-w-title">Today</h3><span class="lk-w-aside">' + aside + '</span>') : w;
  }

  function homeScroll() { return doc.querySelector('#view-home .view-scroll'); }
  function paintHome() {
    var scroll = homeScroll();
    if (!scroll) return false;
    // Home leads with it: first child, ahead of the set-up checklist and the greeting.
    // Something else may prepend later; the observer below puts it back.
    if (heroEl && heroEl.isConnected && scroll.firstChild !== heroEl) scroll.insertBefore(heroEl, scroll.firstChild);
    if (!heroEl || !heroEl.isConnected) {
      heroEl = doc.createElement('section');
      heroEl.id = 'nbdIslandHome';
      heroEl.className = 'isl-home';
      heroEl.setAttribute('aria-label', 'In play and today');
      scroll.insertBefore(heroEl, scroll.firstChild);
    }
    heroEl.innerHTML = '<div class="isl-isle isl-hero">' + heroHtml() + '</div>' + '<div class="isl-isle isl-tl-wrap">' + timelineHtml() + '</div>';
    // thumbnails are CSS background images set by CSSOM (strict CSP: no style attrs)
    Array.prototype.forEach.call(heroEl.querySelectorAll('[data-isl-thumb]'), function (li) {
      var url = li.getAttribute('data-isl-thumb');
      var card = li.querySelector('.lk-card');
      if (url && /^https?:/i.test(url) && card) {
        card.classList.add('isl-has-thumb');
        card.style.setProperty('--isl-thumb', 'url("' + url.replace(/"/g, '%22') + '")');
      }
    });
    return true;
  }

  // ── Pipeline: stage-lane tabs over the snapping board ────────────────
  function boardEl() { return doc.getElementById('kanbanBoard'); }
  function paintLanes() {
    var board = boardEl();
    if (!board) return;
    if (!laneEl || !laneEl.isConnected) {
      laneEl = doc.createElement('div');
      laneEl.id = 'nbdIslandLanes';
      laneEl.className = 'isl-lanes';
      laneEl.setAttribute('role', 'tablist');
      laneEl.setAttribute('aria-label', 'Pipeline stages');
      board.parentNode.insertBefore(laneEl, board);
      on(laneEl, 'click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-isl-lane]') : null;
        if (!b) return;
        var col = doc.getElementById('kcol-' + b.getAttribute('data-isl-lane'));
        if (col && col.scrollIntoView) {
          var calm = doc.documentElement.getAttribute('data-motion') === 'reduce';
          try { col.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', inline: 'start', block: 'nearest' }); }
          catch (e) { col.scrollIntoView(); }
        }
      });
    }
    var cols = board.querySelectorAll('.kanban-col');
    var html = '';
    Array.prototype.forEach.call(cols, function (c) {
      var key = (c.id || '').replace(/^kcol-/, '');
      var lbl = c.querySelector('.kcol-label');
      var cnt = c.querySelector('.kcol-count');
      html += '<button type="button" class="isl-lane" role="tab" data-isl-lane="' + esc(key) + '">' +
        '<span class="isl-lane-n">' + esc(cnt ? cnt.textContent : '') + '</span> ' + esc(lbl ? lbl.textContent.trim() : key) + '</button>';
    });
    if (laneEl.getAttribute('data-sig') !== html) {
      laneEl.innerHTML = html;
      laneEl.setAttribute('data-sig', html);
    }
    markLane();
  }
  // The lane nearest the left edge is the selected tab.
  function markLane() {
    var board = boardEl();
    if (!board || !laneEl) return;
    var left = board.getBoundingClientRect().left;
    var best = null, bestD = 1e9;
    Array.prototype.forEach.call(board.querySelectorAll('.kanban-col'), function (c) {
      var d = Math.abs(c.getBoundingClientRect().left - left);
      if (d < bestD) { bestD = d; best = c; }
    });
    var key = best ? best.id.replace(/^kcol-/, '') : '';
    Array.prototype.forEach.call(laneEl.querySelectorAll('[data-isl-lane]'), function (b) {
      var is = b.getAttribute('data-isl-lane') === key;
      b.classList.toggle('isl-lane-on', is);
      b.setAttribute('aria-selected', is ? 'true' : 'false');
    });
  }
  function watchBoard() {
    var board = boardEl();
    if (!board || board.getAttribute('data-isl-watch')) return;
    board.setAttribute('data-isl-watch', '1');
    var t = null;
    var mo = new MutationObserver(function () { clearTimeout(t); t = setTimeout(paintLanes, 150); });
    mo.observe(board, { childList: true, subtree: true, characterData: true });
    observers.push(mo);
    on(board, 'scroll', function () {
      if (S.laneRaf) return;
      S.laneRaf = requestAnimationFrame(function () { S.laneRaf = 0; markLane(); });
    }, { passive: true });
    paintLanes();
  }

  function afterViewChange() {
    if (S.active === 'home') paintHome();
    if (S.active === 'crm') { watchBoard(); paintLanes(); }
  }

  // ── mount / unmount ──────────────────────────────────────────────────
  function mount() {
    if (mountedOn) return;
    mountedOn = true;
    var content = doc.querySelector('.content') || doc.body;

    pillEl = doc.createElement('div');
    pillEl.id = 'nbdIslandPill';
    pillEl.className = 'isl-pill';
    pillEl.setAttribute('role', 'navigation');
    pillEl.setAttribute('aria-label', 'Main');
    content.insertBefore(pillEl, content.firstChild);

    moreEl = doc.createElement('div');
    moreEl.id = 'nbdIslandMore';
    moreEl.className = 'isl-more';
    moreEl.hidden = true;
    moreEl.setAttribute('role', 'menu');
    moreEl.setAttribute('aria-label', 'All pages');
    doc.body.appendChild(moreEl);

    dockEl = doc.createElement('div');
    dockEl.id = 'nbdIslandDock';
    dockEl.className = 'isl-dock';
    dockEl.setAttribute('role', 'toolbar');
    dockEl.setAttribute('aria-label', 'Quick actions');
    doc.body.appendChild(dockEl);

    var v = activeView();
    S.active = pillItems(hasNav).some(function (it) { return it.id === v; }) ? v : 'more';
    doc.documentElement.setAttribute('data-isl-view', v);
    paintChrome();

    var handlers = { nav: onNav };
    unbind.push(K.bind(pillEl, handlers));
    unbind.push(K.bind(dockEl, handlers));
    // a click on a More entry runs the app's own delegate; just close the sheet
    on(moreEl, 'click', function (ev) { if (ev.target.closest && ev.target.closest('.isl-more-item')) setTimeout(function () { setMore(false); }, 0); });
    on(doc, 'keydown', function (ev) { if (ev.key === 'Escape' && S.moreOpen) setMore(false); });
    on(doc, 'click', function (ev) {
      if (S.moreOpen && ev.target.closest && !ev.target.closest('.isl-more, .isl-more-btn')) setMore(false);
    });

    // the sidebar still owns "which page is active"; follow it
    var side = doc.querySelector('.sidebar');
    if (side && typeof MutationObserver === 'function') {
      var mo = new MutationObserver(function () { syncActive(); });
      mo.observe(side, { attributes: true, attributeFilter: ['class'], subtree: true });
      observers.push(mo);
    }
    ['nbd:today-rendered', 'nbd:data-refreshed', 'nbd:photos-loaded'].forEach(function (n) {
      on(W, n, function () { if (S.active === 'home') paintHome(); });
    });
    on(doc, 'leadsChanged', function () { if (S.active === 'home') paintHome(); });
    // Home is a lazily hydrated template: wait for its scroll container
    if (typeof MutationObserver === 'function') {
      var wait = new MutationObserver(function () {
        var sc = homeScroll();
        if (S.active === 'home' && sc && (!heroEl || !heroEl.isConnected || sc.firstChild !== heroEl)) paintHome();
        if (S.active === 'crm') watchBoard();
      });
      wait.observe(content, { childList: true, subtree: true });
      observers.push(wait);
    }
    every(function () { if (S.active === 'home' && !doc.hidden) paintHome(); }, 60000);   // the clock moves "now"
    afterViewChange();
  }

  function unmount() {
    mountedOn = false;
    unbind.forEach(function (u) { try { u(); } catch (e) { /* ignore */ } });
    unbind = [];
    observers.forEach(function (o) { try { o.disconnect(); } catch (e) { /* ignore */ } });
    observers = [];
    timers.forEach(function (t) { clearInterval(t); });
    timers = [];
    stopPipelineWait();
    listeners.forEach(function (l) { try { l[0].removeEventListener(l[1], l[2], l[3]); } catch (e) { /* ignore */ } });
    listeners = [];
    [pillEl, dockEl, moreEl, laneEl, heroEl].forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
    pillEl = dockEl = moreEl = laneEl = heroEl = null;
    var b = boardEl();
    if (b) b.removeAttribute('data-isl-watch');
    doc.documentElement.removeAttribute('data-isl-view');
  }

  E.implement('island', { mount: mount, unmount: unmount });
})(typeof window !== 'undefined' ? window : null);
