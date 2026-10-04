/**
 * production.js — the after-contract production flow in the CRM (2026-10-04).
 * Rules: js/production-logic.js (pure, tested). Server: functions/google-calendar.js
 * (CRM events + deliveries → NBD Jobs), functions/job-weather.js,
 * functions/push-functions.js (after-install push), functions/morning-brief.js.
 *
 *   Customer page (#productionPanel):
 *     - the production strip — Permit → Ordered → Delivery → Sub → Start —
 *       the main production UI; stage moves stay, but are optional;
 *     - the sub picker (the company's roster: companies/{tenant}/subs) with
 *       double-booking and expired-certificate warnings;
 *     - material orders (leads/{id}/jobs/{job}/orders), with the materials
 *       list from the estimate saved into the order (no prices) and Home
 *       Depot SKUs the price book has bought for this lead;
 *     - "Send to sub": the job sheet, sent from Jo's phone (share sheet);
 *     - after install: the "After photos + walkthrough" checklist.
 *   Dashboard:
 *     - Plan Jobs rows: sub picker, weather badge, "Rain day" push;
 *     - Schedule view: the 7-day busy strip and "Tomorrow's installs";
 *     - the Today screen (if present): "N signed jobs need a week";
 *     - the lead modal's sub picker (#lSubId; replaced the free-text Crew).
 *   Both pages: a soft warning when a job moves to Final Photos with no After
 *   photos, and the checklist task when it enters Install Done
 *   (stage-write.js commitStageChange → onStageChange).
 *
 * Nothing here sends anything: the job sheet and the homeowner reminders go
 * out from Jo's own phone (NBDPhoneShare / sms: / mailto:), and only when he
 * taps. Warnings warn; nothing is blocked (Jo, 2026-09-29).
 * Crews are independent subcontractors — never "employees" or "our team".
 * CSP: delegated listeners, no inline handlers, no style attributes.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDProduction) return;

  const P = () => window.NBDProductionLogic;
  const SW = () => window.NBDScheduleWindow;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, t) => { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); };
  const claims = () => window._userClaims || {};
  const uid = () => (window._user && window._user.uid) || (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null;
  const tenantKey = () => claims().companyId || uid();
  const canWrite = () => claims().role !== 'viewer';
  const isStaff = () => ['company_admin', 'manager', 'viewer', 'admin'].includes(claims().role || '') && !!claims().companyId;
  const todayYmd = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const ready = () => !!(window.db && window.doc && window.collection && window.getDocs && P() && SW());
  const jobIdOf = (lead) => (lead && typeof lead.activeJobId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(lead.activeJobId)) ? lead.activeJobId : 'j1';
  const nowIso = () => new Date().toISOString();
  const ts = () => (typeof window.serverTimestamp === 'function' ? window.serverTimestamp() : new Date());

  let _fsMod = null;
  async function fs() {
    if (!_fsMod) _fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    return _fsMod;
  }

  // ═══ the sub roster ══════════════════════════════════════════════════
  let _subs = null;
  let _subsP = null;
  function subs() { return (_subs || []).slice(); }
  function activeSubs() { return subs().filter((s) => s.active !== false); }
  function subById(id) { return id ? (_subs || []).find((s) => s.id === id) || null : null; }

  async function loadSubs(force) {
    if (!force && _subs) return _subs;
    if (!force && _subsP) return _subsP;
    const t = tenantKey();
    if (!ready() || !t) return [];
    _subsP = (async () => {
      try {
        const snap = await window.getDocs(window.collection(window.db, 'companies', t, 'subs'));
        const out = [];
        snap.forEach((d) => out.push(Object.assign({ id: d.id }, d.data())));
        out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        _subs = out;
      } catch (e) {
        console.warn('[production] subs load failed:', e && e.message);
        _subs = _subs || [];
      }
      _subsP = null;
      window.dispatchEvent(new CustomEvent('nbd:subs-changed'));
      return _subs;
    })();
    return _subsP;
  }

  async function saveSub(input, id) {
    const c = P().cleanSub(input);
    if (!c.ok) throw new Error(c.message);
    const t = tenantKey();
    if (!t) throw new Error('Not signed in yet.');
    const data = Object.assign({}, c.sub, { updatedAt: ts() });
    if (id) await window.setDoc(window.doc(window.db, 'companies', t, 'subs', id), data, { merge: true });
    else { data.createdAt = ts(); await window.addDoc(window.collection(window.db, 'companies', t, 'subs'), data); }
    await loadSubs(true);
  }

  // ── the sub <select> (lead modal #lSubId, Plan Jobs rows, the strip) ──
  function subOptionsHtml(selectedId, legacyCrew) {
    let h = '<option value="">— No sub yet —</option>';
    const list = activeSubs();
    const sel = selectedId && subById(selectedId);
    if (sel && sel.active === false) list.push(sel);
    for (const s of list) {
      const c = P().certStatus(s, todayYmd());
      h += '<option value="' + esc(s.id) + '"' + (s.id === selectedId ? ' selected' : '') + '>' + esc(s.name + (s.trade ? ' · ' + s.trade : '') + (c.state === 'expired' ? ' — cert expired' : c.state === 'none' ? ' — no cert' : '')) + '</option>';
    }
    // The old free-text Crew value (no roster sub behind it) stays selectable,
    // so opening and re-saving a lead never wipes it.
    if (!selectedId && legacyCrew) h += '<option value="legacy:' + esc(legacyCrew) + '" selected>' + esc(legacyCrew) + ' (not on the roster)</option>';
    return h;
  }

  function fillSubSelect(selectId, lead) {
    const el = $(selectId);
    if (!el) return;
    const l = lead || {};
    el.innerHTML = subOptionsHtml(l.subId || '', l.subId ? '' : String(l.crew || '').trim());
    el.dataset.prLoaded = '1';
    if (!_subs) loadSubs().then(() => { if ($(selectId) === el) el.innerHTML = subOptionsHtml(l.subId || '', l.subId ? '' : String(l.crew || '').trim()); });
  }

  /** The lead fields for a sub <select>'s value; {} when the select isn't there (never wipe on a stale page). */
  function subFieldsFromValue(v) {
    const val = String(v == null ? '' : v);
    if (val.indexOf('legacy:') === 0) return { subId: null, crew: val.slice(7).slice(0, 80) };
    if (!val) return P().subFieldsFor(null);
    const s = subById(val);
    return s ? P().subFieldsFor(s) : {};
  }
  function subFieldsFromSelect(selectId) {
    const el = $(selectId);
    if (!el || el.dataset.prLoaded !== '1') return {};
    return subFieldsFromValue(el.value);
  }

  // The sub's other jobs (double-booking): the dashboard has the lead book;
  // the customer page asks Firestore for this sub's jobs.
  async function jobsForSub(subId) {
    if (!subId) return [];
    if (Array.isArray(window._leads)) return window._leads.filter((l) => l && l.subId === subId);
    try {
      const w = window;
      const base = w.collection(w.db, 'leads');
      const q = isStaff()
        ? w.query(base, w.where('companyId', '==', claims().companyId), w.where('subId', '==', subId))
        : w.query(base, w.where('userId', '==', uid()), w.where('subId', '==', subId));
      const snap = await w.getDocs(q);
      const out = [];
      snap.forEach((d) => out.push(Object.assign({ id: d.id }, d.data())));
      return out;
    } catch (e) { return []; }
  }

  async function subWarningsHtml(subId, range, leadId) {
    const s = subById(subId);
    if (!s) return '';
    const others = await jobsForSub(subId);
    const w = P().subWarnings(s, range, others, leadId, todayYmd());
    return w.map((x) => '<div class="pr-warn">' + esc(x) + '</div>').join('');
  }

  // ═══ material orders ═════════════════════════════════════════════════
  async function loadOrders(leadId, lead) {
    try {
      const snap = await window.getDocs(window.collection(window.db, 'leads', leadId, 'jobs', jobIdOf(lead), 'orders'));
      const out = [];
      snap.forEach((d) => out.push(Object.assign({ id: d.id }, d.data())));
      out.sort((a, b) => String(a.deliveryDate || a.orderedDate || '').localeCompare(String(b.deliveryDate || b.orderedDate || '')));
      return out.filter((o) => !o.deleted);
    } catch (e) {
      console.warn('[production] orders load failed:', e && e.message);
      return [];
    }
  }

  let _tenantOrders = null, _tenantOrdersAt = 0;
  async function loadTenantOrders(force) {
    if (!force && _tenantOrders && Date.now() - _tenantOrdersAt < 120000) return _tenantOrders;
    try {
      const mod = await fs();
      const w = window;
      const q = isStaff()
        ? w.query(mod.collectionGroup(w.db, 'orders'), w.where('companyId', '==', claims().companyId))
        : w.query(mod.collectionGroup(w.db, 'orders'), w.where('userId', '==', uid()));
      const snap = await w.getDocs(q);
      const out = [];
      snap.forEach((d) => {
        const jobRef = d.ref.parent && d.ref.parent.parent;
        const leadId = jobRef && jobRef.parent && jobRef.parent.parent && jobRef.parent.parent.id;
        out.push(Object.assign({ id: d.id, leadId, jobId: jobRef && jobRef.id }, d.data()));
      });
      _tenantOrders = out.filter((o) => !o.deleted);
      _tenantOrdersAt = Date.now();
    } catch (e) {
      console.warn('[production] tenant orders load failed:', e && e.message);
      _tenantOrders = _tenantOrders || [];
    }
    return _tenantOrders;
  }

  // The materials list from the lead's primary estimate (materials-list.js),
  // quantities only — the order never stores a price.
  function materialsFromEstimate(lead) {
    const ests = Array.isArray(window._customerEstimates) ? window._customerEstimates : (Array.isArray(window._estimates) ? window._estimates.filter((e) => e && e.leadId === (lead && lead.id)) : []);
    const est = (lead && lead.primaryEstimateId && ests.find((e) => e && e.id === lead.primaryEstimateId)) || ests[0] || null;
    if (!est || !Array.isArray(est.rows) || !window.NBDMaterials || typeof window.NBDMaterials.buildList !== 'function') return [];
    return P().orderItemsFromList(window.NBDMaterials.buildList(est.rows));
  }

  async function hdSkus(leadId) {
    // The price book (priceBook/{tenant}, price-book.js) remembers each Home
    // Depot SKU bought for a lead from the Pro Xtra import. Only the SKU,
    // name, quantity and date come out — never what was paid.
    try {
      let items = null;
      if (window.NBDPriceBook && typeof window.NBDPriceBook.load === 'function') {
        const book = await window.NBDPriceBook.load();
        items = (book && book.items) || book || null;
      } else if (window.getDoc && tenantKey()) {
        const s = await window.getDoc(window.doc(window.db, 'priceBook', tenantKey()));
        items = s && s.exists() ? (s.data() || {}).items : null;
      }
      return P().hdSkusForLead(items || {}, leadId);
    } catch (e) { return []; }
  }

  async function saveOrder(leadId, lead, input, orderId) {
    const c = P().cleanOrder(input, lead);
    if (!c.ok) throw new Error(c.message);
    const data = Object.assign({}, c.order, { updatedAt: ts() });
    const col = window.collection(window.db, 'leads', leadId, 'jobs', jobIdOf(lead), 'orders');
    if (orderId) await window.setDoc(window.doc(col, orderId), data, { merge: true });
    else { data.createdAt = ts(); await window.addDoc(col, data); }
    _tenantOrders = null;
  }

  // ═══ weather (getJobWeather; owner only, like getBusyTimes) ══════════
  let _wx = null, _wxAt = 0, _wxP = null;
  const OWNER = window.__NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
  function ownerish() { const c = claims(); return uid() === OWNER || c.role === 'admin' || (c.companyId === OWNER && c.role === 'company_admin'); }
  async function callable(name, payload) {
    if (!window._httpsCallable) {
      const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      window._httpsCallable = mod.httpsCallable;
    }
    if (!window._functions) throw new Error('Functions SDK unavailable');
    const res = await window._httpsCallable(window._functions, name)(payload || {});
    return res && res.data;
  }
  async function loadWeather() {
    if (!ownerish()) return null;
    if (_wx && Date.now() - _wxAt < 30 * 60000) return _wx;
    if (_wxP) return _wxP;
    _wxP = callable('getJobWeather').then((r) => { _wx = (r && r.byLead) || {}; _wxAt = Date.now(); return _wx; })
      .catch(() => { _wx = _wx || {}; _wxAt = Date.now(); return _wx; })
      .finally(() => { _wxP = null; });
    return _wxP;
  }
  function weatherBadge(leadId, lead) {
    const by = _wx && _wx[leadId];
    const r = P().jobRange(lead);
    if (!by || !r) return '';
    let worst = null;
    for (let d = r.start, i = 0; d <= r.end && i < 14; d = SW().addDays(d, 1), i++) {
      const w = by[d];
      if (!w) continue;
      if (!worst || (w.level === 'warn') || (w.level === 'watch' && worst.level === 'ok')) worst = Object.assign({ date: d }, w);
    }
    if (!worst) return '';
    const icon = worst.level === 'warn' ? '🌧' : worst.level === 'watch' ? '🌦' : '☀';
    return '<span class="pr-wx pr-wx-' + esc(worst.level) + '" title="weather.gov forecast — warns only">' + icon + ' ' + esc(P().shortDate(worst.date) + ': ' + worst.label) + '</span>';
  }

  // ═══ the customer page: production strip ═════════════════════════════
  const _cp = { leadId: null, lead: null, orders: [], open: null, sending: false, loadedFor: null };

  function stripHtml(steps) {
    return '<ol class="pr-strip" aria-label="Production">' + steps.map((s) =>
      '<li class="pr-step' + (s.done ? ' pr-done' : '') + (s.warn ? ' pr-has-warn' : '') + (_cp.open === s.key ? ' pr-open' : '') + '">' +
        '<button type="button" class="pr-step-btn" data-pr-action="open" data-pr-step="' + esc(s.key) + '" aria-expanded="' + (_cp.open === s.key) + '">' +
          '<span class="pr-step-dot" aria-hidden="true">' + (s.done ? '✓' : '') + '</span>' +
          '<span class="pr-step-label">' + esc(s.label) + '</span>' +
          '<span class="pr-step-val">' + esc(s.value) + '</span>' +
        '</button>' +
        (s.warn ? '<div class="pr-step-warn">' + esc(s.warn) + '</div>' : '') +
      '</li>').join('') + '</ol>';
  }

  function permitEditor(l) {
    const st = P().permitState(l);
    const opt = (v, t) => '<label class="pr-radio"><input type="radio" name="prPermit" value="' + v + '"' + (st === v ? ' checked' : '') + '> ' + t + '</label>';
    return '<div class="pr-edit" data-pr-edit="permit">' +
      '<div class="pr-radios">' + opt('filed', 'Filed') + opt('none', 'Not required') + opt('todo', 'Still to do') + '</div>' +
      '<label class="pr-field">Permit #<input type="text" id="prPermitNo" maxlength="60" value="' + esc(l.permitNumber || '') + '"></label>' +
      '<label class="pr-field">City / county<input type="text" id="prPermitCity" maxlength="80" value="' + esc(l.permitCity || '') + '"></label>' +
      '<button type="button" class="btn btn-orange pr-save" data-pr-action="save-permit">Save permit</button></div>';
  }

  function orderForm(o) {
    const x = o || {};
    const stores = P().STORES.map((s) => '<option' + (s === x.store ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
    const st = P().ORDER_STATUS.map((s) => '<option value="' + s + '"' + (s === (x.status || 'ordered') ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>').join('');
    const items = Array.isArray(x.items) ? x.items.length : 0;
    return '<div class="pr-edit pr-order-form" data-pr-edit="order" data-pr-order="' + esc(x.id || '') + '">' +
      '<label class="pr-field">Store<select id="prOrdStore">' + stores + '</select></label>' +
      '<label class="pr-field">Order #<input type="text" id="prOrdNo" maxlength="40" value="' + esc(x.orderNumber || '') + '"></label>' +
      '<label class="pr-field">Ordered<input type="date" id="prOrdDate" value="' + esc(x.orderedDate || (x.id ? '' : todayYmd())) + '"></label>' +
      '<label class="pr-field">Delivery<input type="date" id="prOrdDeliv" value="' + esc(x.deliveryDate || '') + '"></label>' +
      '<label class="pr-field">Status<select id="prOrdStatus">' + st + '</select></label>' +
      '<label class="pr-check"><input type="checkbox" id="prOrdList"' + (items ? '' : ' checked') + '> ' + (items ? 'Replace the saved materials list (' + items + ' lines) with the estimate\'s' : 'Save the estimate\'s materials list into this order (quantities, no prices)') + '</label>' +
      '<div class="pr-delivwarn" id="prOrdWarn" aria-live="polite"></div>' +
      '<button type="button" class="btn btn-orange pr-save" data-pr-action="save-order">' + (x.id ? 'Save order' : 'Add order') + '</button></div>';
  }

  function ordersEditor(l) {
    const rows = _cp.orders.map((o) => {
      const warn = P().deliveryWarning(o, l);
      return '<div class="pr-order">' +
        '<div class="pr-order-main"><b>' + esc(o.store) + '</b>' + (o.orderNumber ? ' #' + esc(o.orderNumber) : '') +
          ' · ' + esc(o.status || '') + (o.orderedDate ? ' · ordered ' + esc(P().shortDate(o.orderedDate)) : '') +
          (o.deliveryDate ? ' · delivery ' + esc(P().shortDate(o.deliveryDate)) : '') +
          (Array.isArray(o.items) && o.items.length ? ' · ' + o.items.length + ' lines' : '') +
          (Array.isArray(o.hdSkus) && o.hdSkus.length ? ' · ' + o.hdSkus.length + ' Home Depot SKUs' : '') + '</div>' +
        (warn ? '<div class="pr-warn">' + esc(warn) + '</div>' : '') +
        '<button type="button" class="btn btn-ghost pr-small" data-pr-action="edit-order" data-pr-order="' + esc(o.id) + '">Edit</button>' +
        '</div>';
    }).join('');
    const editing = typeof _cp.open === 'string' && _cp.open.indexOf('order:') === 0 ? _cp.orders.find((o) => o.id === _cp.open.slice(6)) : null;
    return '<div class="pr-edit" data-pr-edit="orders">' + (rows || '<div class="pr-muted">No material orders yet.</div>') +
      (editing || _cp.open === 'order:new' ? orderForm(editing) : '<button type="button" class="btn btn-orange pr-save" data-pr-action="new-order">+ Add a material order</button>') + '</div>';
  }

  function subEditor(l) {
    return '<div class="pr-edit" data-pr-edit="sub">' +
      '<label class="pr-field">Sub on this job<select id="prSubSel">' + subOptionsHtml(l.subId || '', l.subId ? '' : String(l.crew || '').trim()) + '</select></label>' +
      '<div id="prSubWarn" aria-live="polite"></div>' +
      '<div class="pr-row"><button type="button" class="btn btn-orange pr-save" data-pr-action="save-sub">Save sub</button>' +
      '<button type="button" class="btn btn-ghost pr-small" data-pr-action="roster">Manage subs</button>' +
      '<button type="button" class="btn btn-ghost pr-small" data-pr-action="sheet">📤 Send to sub</button></div>' +
      '<div class="pr-muted">Subs are independent contractors who carry their own insurance.</div></div>';
  }

  function startEditor(l) {
    const v = window.NBDSchedulePlanner && typeof window.NBDSchedulePlanner.inputsOf === 'function' ? window.NBDSchedulePlanner.inputsOf(l) : { date: l.scheduledDate || '', start: l.scheduledStart || '', days: 1, week: '' };
    return '<div class="pr-edit" data-pr-edit="start">' +
      '<label class="pr-field">Week of<input type="date" id="prWeek" value="' + esc(v.week || '') + '"></label>' +
      '<label class="pr-field">Start day<input type="date" id="prDate" value="' + esc(v.date || '') + '"></label>' +
      '<label class="pr-field">Start time<input type="time" id="prTime" value="' + esc(v.start || '') + '"></label>' +
      '<label class="pr-field">Days<input type="number" id="prDays" min="1" max="14" inputmode="numeric" value="' + esc(v.days || 1) + '"></label>' +
      '<div class="gcal-conflict" id="prStartWarn" aria-live="polite"></div>' +
      '<button type="button" class="btn btn-orange pr-save" data-pr-action="save-start">Save start</button></div>';
  }

  function rosterEditor() {
    const list = subs();
    const mig = P().crewMigration(_cp.lead ? [_cp.lead] : (window._leads || []), list);
    return '<div class="pr-edit pr-roster" data-pr-edit="roster">' +
      '<div class="pr-h">Sub roster</div>' +
      (list.length ? list.map((s) => {
        const c = P().certStatus(s, todayYmd());
        return '<div class="pr-sub' + (s.active === false ? ' pr-archived' : '') + '"><b>' + esc(s.name) + '</b> · ' + esc(s.trade || '') + (s.phone ? ' · ' + esc(s.phone) : '') +
          '<div class="pr-cert pr-cert-' + esc(c.state) + '">' + esc(c.label) + '</div>' +
          '<button type="button" class="btn btn-ghost pr-small" data-pr-action="edit-sub" data-pr-sub="' + esc(s.id) + '">Edit</button></div>';
      }).join('') : '<div class="pr-muted">No subs yet. Add the crews you sub work to.</div>') +
      (mig.newNames.length ? '<div class="pr-muted">Old crew name' + (mig.newNames.length === 1 ? '' : 's') + ' not on the roster: ' + esc(mig.newNames.join(', ')) + '</div>' : '') +
      subForm(_cp.editSub ? subById(_cp.editSub) : null) + '</div>';
  }

  function subForm(s) {
    const x = s || {};
    const trades = P().TRADES.map((t) => '<option' + (t === (x.trade || 'Roofing') ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
    return '<div class="pr-subform" data-pr-subid="' + esc(x.id || '') + '">' +
      '<div class="pr-h">' + (x.id ? 'Edit ' + esc(x.name) : 'Add a sub') + '</div>' +
      '<label class="pr-field">Name<input type="text" id="prSubName" maxlength="80" value="' + esc(x.name || '') + '"></label>' +
      '<label class="pr-field">Phone<input type="tel" id="prSubPhone" maxlength="40" value="' + esc(x.phone || '') + '"></label>' +
      '<label class="pr-field">Trade<select id="prSubTrade">' + trades + '</select></label>' +
      '<label class="pr-field">Insurance certificate expires<input type="date" id="prSubExp" value="' + esc(x.insuranceExpiry || '') + '"></label>' +
      '<label class="pr-field">Notes<textarea id="prSubNotes" maxlength="1000" rows="2">' + esc(x.notes || '') + '</textarea></label>' +
      (x.id ? '<label class="pr-check"><input type="checkbox" id="prSubActive"' + (x.active === false ? '' : ' checked') + '> On the roster</label>' : '') +
      '<button type="button" class="btn btn-orange pr-save" data-pr-action="save-roster">' + (x.id ? 'Save' : 'Add sub') + '</button>' +
      '<div class="pr-msg" id="prRosterMsg" aria-live="polite"></div></div>';
  }

  function sheetEditor(l) {
    const sub = subById(l.subId);
    return '<div class="pr-edit" data-pr-edit="sheet">' +
      '<div class="pr-h">Send the job sheet' + (sub ? ' to ' + esc(sub.name) : '') + '</div>' +
      '<label class="pr-field">Access notes (gate code, dog, where to park, power…)<textarea id="prAccess" maxlength="1000" rows="3">' + esc(l.accessNotes || '') + '</textarea></label>' +
      '<pre class="pr-sheet" id="prSheetPreview">' + esc(P().jobSheet({ lead: l, orders: _cp.orders, sub })) + '</pre>' +
      '<div class="pr-row"><button type="button" class="btn btn-orange pr-save" data-pr-action="send-sheet">📤 Send from my phone</button></div>' +
      '<div class="pr-muted">No prices and no homeowner phone go in the sheet. It goes out from your phone — nothing is sent by the CRM.</div></div>';
  }

  function afterChecklistHtml(l) {
    if (!P().showAfterChecklist(l, todayYmd())) return '';
    const done = (l && l.afterChecklist) || {};
    const photos = (window._allPhotos || []).filter((p) => String((p && p.phase) || '').toLowerCase() === 'after').length;
    return '<div class="pr-after"><div class="pr-h">After photos + walkthrough</div>' +
      P().AFTER_CHECKLIST.map((c) => '<label class="pr-check"><input type="checkbox" data-pr-check="' + esc(c.id) + '"' + (done[c.id] ? ' checked' : '') + '> ' + esc(c.label) +
        (c.id === 'after_photos' ? ' <span class="pr-muted">(' + photos + ' After photo' + (photos === 1 ? '' : 's') + ')</span>' : '') + '</label>').join('') + '</div>';
  }

  function renderPanel() {
    const host = $('productionPanel');
    const l = _cp.lead;
    if (!host || !l) return;
    host.hidden = false;
    const sub = subById(l.subId);
    const steps = P().stripSteps(l, _cp.orders, sub, todayYmd());
    let ed = '';
    const o = _cp.open;
    if (o === 'permit') ed = permitEditor(l);
    else if (o === 'ordered' || o === 'delivery' || (typeof o === 'string' && o.indexOf('order:') === 0)) ed = ordersEditor(l);
    else if (o === 'sub') ed = subEditor(l);
    else if (o === 'start') ed = startEditor(l);
    else if (o === 'roster') ed = rosterEditor();
    else if (o === 'sheet') ed = sheetEditor(l);
    host.innerHTML = '<div class="panel-head pr-head"><div class="panel-title">Production</div>' +
      (canWrite() ? '<button type="button" class="btn btn-ghost pr-small" data-pr-action="sheet">📤 Send to sub</button>' : '') + '</div>' +
      stripHtml(steps) + (canWrite() ? ed : '') + '<div class="pr-msg" id="prMsg" aria-live="polite"></div>' + afterChecklistHtml(l);
    if (o === 'sub' && l.subId) subWarningsHtml(l.subId, P().jobRange(l), _cp.leadId).then((h) => { const w = $('prSubWarn'); if (w) w.innerHTML = h; });
  }

  async function refreshCustomer(force) {
    const id = window._customerId;
    const lead = window._leadDoc;
    if (!id || !lead || !ready() || !$('productionPanel')) return;
    _cp.leadId = id;
    _cp.lead = Object.assign({ id }, lead);
    if (force || _cp.loadedFor !== id) {
      _cp.loadedFor = id;
      await loadSubs();
      _cp.orders = await loadOrders(id, _cp.lead);
    }
    renderPanel();
  }

  function msg(t) { const m = $('prMsg') || $('prRosterMsg'); if (m) m.textContent = t || ''; }

  async function patchLead(patch) {
    if (!window.updateDoc) throw new Error('Not connected yet — try again in a moment.');
    await window.updateDoc(window.doc(window.db, 'leads', _cp.leadId), Object.assign({}, patch, { updatedAt: ts() }));
    Object.assign(_cp.lead, patch);
    if (window._leadDoc) Object.assign(window._leadDoc, patch);
    const ll = (window._leads || []).find((x) => x && x.id === _cp.leadId);
    if (ll) Object.assign(ll, patch);
  }

  async function onPanelAction(act, btn) {
    const l = _cp.lead;
    if (!l) return;
    try {
      if (act === 'open') { const k = btn.dataset.prStep; _cp.open = _cp.open === k ? null : k; _cp.editSub = null; renderPanel(); return; }
      if (act === 'roster') { _cp.open = 'roster'; _cp.editSub = null; renderPanel(); return; }
      if (act === 'edit-sub') { _cp.editSub = btn.dataset.prSub; renderPanel(); return; }
      if (act === 'sheet') { _cp.open = 'sheet'; renderPanel(); return; }
      if (act === 'new-order') { _cp.open = 'order:new'; renderPanel(); return; }
      if (act === 'edit-order') { _cp.open = 'order:' + btn.dataset.prOrder; renderPanel(); return; }
      if (!canWrite()) return;
      if (act === 'save-permit') {
        const st = (document.querySelector('input[name="prPermit"]:checked') || {}).value || 'todo';
        await patchLead(P().permitPatch({ state: st, number: $('prPermitNo').value, city: $('prPermitCity').value }, l, nowIso()));
        _cp.open = null; toast(st === 'none' ? 'Permit: not required ✓' : st === 'filed' ? 'Permit filed ✓' : 'Permit saved', 'success'); renderPanel();
        return;
      }
      if (act === 'save-order') {
        const form = btn.closest('.pr-order-form');
        const id = form && form.dataset.prOrder;
        const input = { store: $('prOrdStore').value, orderNumber: $('prOrdNo').value, orderedDate: $('prOrdDate').value, deliveryDate: $('prOrdDeliv').value, status: $('prOrdStatus').value };
        if ($('prOrdList') && $('prOrdList').checked) input.items = materialsFromEstimate(l);
        else { const prev = _cp.orders.find((o) => o.id === id); if (prev && Array.isArray(prev.items)) input.items = prev.items; }
        if (/home depot/i.test(input.store)) input.hdSkus = await hdSkus(_cp.leadId);
        btn.disabled = true;
        await saveOrder(_cp.leadId, l, input, id || null);
        _cp.orders = await loadOrders(_cp.leadId, l);
        _cp.open = 'ordered';
        const w = P().deliveryWarning(P().cleanOrder(input, l).order, l);
        toast((id ? 'Order saved' : 'Order added') + (input.deliveryDate ? ' — the delivery is on your Google Calendar shortly' : '') + ' ✓', 'success');
        renderPanel();
        if (w) msg(w);
        return;
      }
      if (act === 'save-sub') {
        const f = subFieldsFromValue($('prSubSel').value);
        await patchLead(f);
        toast(f.crew ? f.crew + ' is on this job ✓' : 'Sub cleared', 'success');
        renderPanel();
        return;
      }
      if (act === 'save-start') {
        const PL = window.NBDSchedulePlanner;
        if (!PL) throw new Error('Scheduling is still loading — try again.');
        const out = PL.fieldsFor({ date: $('prDate').value, start: $('prTime').value, days: $('prDays').value, week: $('prWeek').value });
        if (!out.ok) { msg(out.message); return; }
        await patchLead(out.fields);
        _cp.open = null; toast('Start saved ✓', 'success'); renderPanel();
        return;
      }
      if (act === 'save-roster') {
        const form = btn.closest('.pr-subform');
        const id = form && form.dataset.prSubid;
        await saveSub({ name: $('prSubName').value, phone: $('prSubPhone').value, trade: $('prSubTrade').value, insuranceExpiry: $('prSubExp').value, notes: $('prSubNotes').value,
          active: $('prSubActive') ? $('prSubActive').checked : true }, id || null);
        _cp.editSub = null; toast('Roster saved ✓', 'success'); renderPanel();
        return;
      }
      if (act === 'send-sheet') {
        const access = String(($('prAccess') || {}).value || '').trim().slice(0, 1000);
        if (access !== String(l.accessNotes || '')) await patchLead({ accessNotes: access });
        await sendJobSheet(_cp.lead, _cp.orders);
        return;
      }
    } catch (e) {
      msg((e && e.message) || 'Could not save.');
      if (btn) btn.disabled = false;
    }
  }

  /** The job sheet out of Jo's own phone (share sheet; sms: to the sub on a desktop). */
  async function sendJobSheet(lead, orders) {
    const sub = subById(lead && lead.subId);
    const text = P().jobSheet({ lead, orders: orders || [], sub });
    const share = window.NBDPhoneShare;
    if (share && typeof share.share === 'function') {
      const r = await share.share({ text, title: 'Job sheet — ' + ((lead && lead.address) || ''), phone: sub && sub.phone, subject: 'Job sheet — ' + ((lead && lead.address) || '') });
      if (r && r.shared) toast('Job sheet sent ✓', 'success');
      return r;
    }
    try { await navigator.clipboard.writeText(text); toast('Job sheet copied — paste it into a text to the sub', 'success'); } catch (_) { toast('Could not open the share sheet', 'error'); }
    return { shared: false };
  }

  // ═══ dashboard: Plan Jobs rows ═══════════════════════════════════════
  /** The extra controls a Plan Jobs row carries (sub picker, weather, rain day). */
  function rowExtrasHtml(r, kind) {
    const l = r.lead || {};
    // A sub picked but not saved yet survives a re-render (schedule-planner _drafts).
    const draft = typeof r.subDraft === 'string' ? r.subDraft : null;
    const selId = draft != null ? (draft.indexOf('legacy:') === 0 ? '' : draft) : (l.subId || '');
    const legacy = draft != null ? (draft.indexOf('legacy:') === 0 ? draft.slice(7) : '') : (l.subId ? '' : String(l.crew || '').trim());
    return '<div class="sp-prod">' +
      '<label class="sp-sublbl">Sub<select class="sp-sub-sel" data-pr-loaded="1">' + subOptionsHtml(selId, legacy) + '</select></label>' +
      weatherBadge(r.id, l) +
      (kind === 'scheduled' && P().jobRange(l) ? '<button type="button" class="btn btn-ghost sp-rain" data-sp-action="rain">🌧 Rain day…</button>' : '') +
      '</div><div class="sp-subwarn" aria-live="polite"></div>';
  }

  /** {} when the row's sub didn't change; else the lead fields. */
  function rowSubPatch(row, lead) {
    const sel = row && row.querySelector('.sp-sub-sel');
    if (!sel) return {};
    const f = subFieldsFromValue(sel.value);
    const l = lead || {};
    if (!('subId' in f)) return {};
    if ((f.subId || null) === (l.subId || null) && String(f.crew || '') === String(l.crew || '')) return {};
    return f;
  }

  async function onRowSubChange(row) {
    const sel = row.querySelector('.sp-sub-sel');
    const warn = row.querySelector('.sp-subwarn');
    if (!sel || !warn) return;
    const val = sel.value;
    if (!val || val.indexOf('legacy:') === 0) { warn.innerHTML = ''; return; }
    const date = (row.querySelector('.sp-date') || {}).value || '';
    const days = Math.max(1, parseInt((row.querySelector('.sp-days') || {}).value, 10) || 1);
    const range = /^\d{4}-\d{2}-\d{2}$/.test(date) ? { start: date, end: SW().addDays(date, days - 1) } : null;
    warn.innerHTML = await subWarningsHtml(val, range, row.dataset.id);
  }

  // ── rain-day push ──
  const _rain = { id: null, n: 1, plan: [], warn: {}, seq: 0 };
  function closeRain() { const o = $('prRainSheet'); if (o) o.remove(); _rain.id = null; }
  function rainHtml() {
    const rows = _rain.plan.map((p) => '<li class="pr-rain-row"><b>' + esc(p.name) + '</b> ' +
      esc(P().shortDate(p.from.start) + (p.from.end !== p.from.start ? '–' + P().shortDate(p.from.end) : '')) + ' → <b>' +
      esc(P().shortDate(p.to.start) + (p.to.end !== p.to.start ? '–' + P().shortDate(p.to.end) : '')) + '</b>' +
      '<div class="gcal-conflict">' + (_rain.warn[p.id] || '') + '</div></li>').join('');
    return '<div class="pr-sheet-card" role="dialog" aria-modal="true" aria-labelledby="prRainTitle">' +
      '<div class="pr-h" id="prRainTitle">Rain day — push this job and everything after it</div>' +
      '<label class="pr-field">By<select id="prRainN">' + [1, 2, 3, 4, 5].map((n) => '<option value="' + n + '"' + (n === _rain.n ? ' selected' : '') + '>' + n + ' working day' + (n === 1 ? '' : 's') + '</option>').join('') + '</select></label>' +
      (rows ? '<ol class="pr-rain-list">' + rows + '</ol>' : '<div class="pr-muted">Nothing to move.</div>') +
      '<div class="pr-muted">Weekends are skipped. Week-only plans and leads that are not signed work stay put. Conflicts warn; you can still save.</div>' +
      '<div class="pr-msg" id="prRainMsg" aria-live="polite"></div>' +
      '<div class="pr-row"><button type="button" class="btn btn-orange" data-pr-action="rain-save"' + (_rain.plan.length ? '' : ' disabled') + '>Move ' + _rain.plan.length + ' job' + (_rain.plan.length === 1 ? '' : 's') + '</button>' +
      '<button type="button" class="btn btn-ghost" data-pr-action="rain-close">Cancel</button></div></div>';
  }
  function paintRain() { const o = $('prRainSheet'); if (o) o.innerHTML = rainHtml(); }
  function planRain() {
    const norm = typeof window.normalizeStage === 'function' ? (s) => { try { return window.normalizeStage(s); } catch (_) { return String(s || '').toLowerCase(); } } : undefined;
    _rain.plan = P().rainPushPlan(window._leads || [], _rain.id, _rain.n, { normalize: norm });
    _rain.warn = {};
    const seq = ++_rain.seq;
    paintRain();
    // Preview conflicts with the same check Plan Jobs rows use (getBusyTimes).
    const G = window.NBDGoogleCalendarUI;
    if (!G || typeof G.checkRow !== 'function') return;
    _rain.plan.forEach((p) => {
      const days = SW().parseYmd(p.to.end).day - SW().parseYmd(p.to.start).day + 1;
      G.checkRow({ date: p.to.start, start: p.fields.scheduledStart || '', days }, p.id).then((html) => {
        if (seq !== _rain.seq) return;
        _rain.warn[p.id] = html || '';
        paintRain();
      }).catch(() => {});
    });
  }
  function openRainPush(leadId) {
    closeRain();
    _rain.id = leadId; _rain.n = 1;
    const ov = document.createElement('div');
    ov.className = 'pr-overlay'; ov.id = 'prRainSheet';
    document.body.appendChild(ov);
    planRain();
  }
  async function saveRain() {
    const m = $('prRainMsg');
    // Every move goes through NBDScheduleWindow.check BEFORE anything is
    // written: one bad window and nothing moves.
    for (const p of _rain.plan) {
      const c = SW().check(p.fields);
      if (!c.ok) { if (m) m.textContent = p.name + ': ' + ((SW().ERRORS && SW().ERRORS[c.error]) || 'check the dates') + ' — nothing was moved.'; return; }
    }
    if (!window.updateDoc) { if (m) m.textContent = 'Not connected yet.'; return; }
    let n = 0;
    for (const p of _rain.plan) {
      await window.updateDoc(window.doc(window.db, 'leads', p.id), Object.assign({}, p.fields, { updatedAt: ts() }));
      const l = (window._leads || []).find((x) => x && x.id === p.id);
      if (l) Object.assign(l, p.fields);
      n++;
    }
    closeRain();
    toast('Moved ' + n + ' job' + (n === 1 ? '' : 's') + ' ✓ — Google Calendar follows in a few seconds', 'success');
    if (window.NBDSchedulePlannerUI && typeof window.NBDSchedulePlannerUI.render === 'function') window.NBDSchedulePlannerUI.render();
    renderSchedExtras();
  }

  // ═══ dashboard: busy strip, tomorrow's installs, Today ═══════════════
  let _busy = null, _busyAt = 0;
  async function busyBlocks(today) {
    if (_busy && Date.now() - _busyAt < 5 * 60000) return _busy;
    const G = window.NBDGoogleCalendarUI;
    if (!G || typeof G.busyBetween !== 'function') return [];
    const from = SW().localToUtcMs(today, '00:00');
    const to = SW().localToUtcMs(SW().addDays(today, 7), '00:00');
    const r = await G.busyBetween(from, to);
    _busy = (r && r.configured && r.blocks) || [];
    _busyAt = Date.now();
    return _busy;
  }

  function stripDayHtml(d) {
    const cells = d.cells.map((c) => '<span class="bs-cell bs-' + c.kind + '" title="' + esc((c.hour % 12 || 12) + (c.hour < 12 ? ' am' : ' pm') + (c.titles.length ? ' · ' + c.titles.join(', ') : '')) + '"></span>').join('');
    const jobs = d.jobs.map((j) => esc(j.name)).join(', ');
    return '<div class="bs-day"><div class="bs-label">' + esc(d.label) + '</div><div class="bs-cells">' + cells + '</div>' +
      '<div class="bs-note">' + (jobs ? '🔨 ' + jobs : '') + (d.deliveries.length ? (jobs ? ' · ' : '') + '🚚 ' + d.deliveries.length : '') + '</div></div>';
  }

  async function renderSchedExtras() {
    const host = $('schedBusyStrip');
    const tom = $('schedTomorrow');
    if (!P() || !SW()) return;
    const today = todayYmd();
    const leads = (window._leads || []).filter((l) => l && !l.deleted);
    if (tom) {
      const rows = P().tomorrowInstalls(leads, today, reminderCtx());
      tom.hidden = !rows.length;
      tom.innerHTML = rows.length ? '<div class="pr-h">Tomorrow\'s installs</div>' + rows.map((r) =>
        '<div class="pr-tom" data-pr-lead="' + esc(r.id) + '"><div><b>' + esc(r.name) + '</b> · ' + esc(r.when) + (r.address ? ' · ' + esc(r.address) : '') + '</div>' +
        '<div class="pr-tom-text">' + esc(r.text) + '</div>' +
        '<div class="pr-row">' + (r.phone ? '<a class="btn btn-orange pr-small" href="' + esc(window.NBDPhoneShare ? window.NBDPhoneShare.smsHref(r.phone, r.text) : 'sms:' + r.phone) + '">💬 Text</a>' : '') +
        (r.email && window.NBDPhoneShare && window.NBDPhoneShare.mailtoHref(r.email, 'Tomorrow at ' + r.address, r.text) ? '<a class="btn btn-ghost pr-small" href="' + esc(window.NBDPhoneShare.mailtoHref(r.email, 'Tomorrow at ' + r.address, r.text)) + '">✉ Email</a>' : '') +
        '<button type="button" class="btn btn-ghost pr-small" data-pr-action="tom-share">📤 Share…</button></div></div>').join('') : '';
    }
    if (host) {
      const draw = (blocks, orders) => {
        const days = P().busyStrip({ today, days: 7, blocks, leads, orders });
        host.hidden = false;
        host.innerHTML = '<div class="pr-h">Next 7 days</div>' +
          '<div class="bs-legend"><span class="bs-cell bs-job"></span> CRM job <span class="bs-cell bs-busy"></span> Google busy <span class="bs-cell bs-deliv"></span> Delivery</div>' +
          '<div class="bs-hours"><span class="bs-label"></span><span class="bs-hrs"><span>7a</span><span>10a</span><span>1p</span><span>4p</span><span>7p</span></span></div>' +
          days.map(stripDayHtml).join('');
      };
      draw(_busy || [], _tenantOrders || []);
      const [blocks, orders] = await Promise.all([busyBlocks(today).catch(() => []), loadTenantOrders().catch(() => [])]);
      draw(blocks || [], orders || []);
    }
    renderTodaySection();
  }

  function reminderCtx() {
    let company = 'No Big Deal Home Solutions';
    try { const b = typeof window._brand === 'function' ? window._brand() : null; if (b && b.legalName) company = b.legalName; } catch (_) {}
    const u = window._user || {};
    const rep = String(u.displayName || '').trim().split(' ')[0] || '';
    return { repName: rep, companyName: company };
  }

  // "N signed jobs need a week" on the Today screen, when the Today screen
  // exists (#2137, feature-detected by its #todayPlan host).
  function renderTodaySection() {
    const plan = $('todayPlan');
    if (!plan || !P()) return;
    let el = $('prNeedsWeek');
    if (!el) {
      el = document.createElement('div');
      el.id = 'prNeedsWeek';
      el.className = 'pr-needs';
      plan.parentNode.insertBefore(el, plan.nextSibling);
    }
    const norm = typeof window.normalizeStage === 'function' ? (s) => { try { return window.normalizeStage(s); } catch (_) { return String(s || '').toLowerCase(); } } : undefined;
    const list = P().needsWeek(window._leads || [], { normalize: norm });
    el.hidden = !list.length;
    el.innerHTML = list.length ? '<a class="pr-needs-link" href="#/schedule"><b>' + list.length + ' signed job' + (list.length === 1 ? '' : 's') + ' need' + (list.length === 1 ? 's' : '') + ' a week</b> — ' +
      esc(list.slice(0, 3).map((l) => [l.firstName, l.lastName].filter(Boolean).join(' ') || l.address || 'Customer').join(', ')) + (list.length > 3 ? ' …' : '') + ' → Plan Jobs</a>' : '';
  }

  // ═══ stage moves (stage-write.js) ════════════════════════════════════
  async function afterPhotoCount(leadId) {
    if (window._customerId === leadId && Array.isArray(window._allPhotos)) return window._allPhotos.filter((p) => String((p && p.phase) || '').toLowerCase() === 'after').length;
    if (window._photoCache && Array.isArray(window._photoCache[leadId])) return window._photoCache[leadId].filter((p) => String((p && p.phase) || '').toLowerCase() === 'after').length;
    try {
      const w = window;
      const snap = await w.getDocs(w.query(w.collection(w.db, 'photos'), w.where('userId', '==', uid()), w.where('leadId', '==', leadId)));
      let n = 0;
      snap.forEach((d) => { if (String((d.data() || {}).phase || '').toLowerCase() === 'after') n++; });
      return n;
    } catch (e) { return -1; }   // unknown — say nothing rather than a false alarm
  }

  async function onStageChange(leadId, oldStage, newStage) {
    try {
      if (!leadId || !P()) return;
      if (newStage === 'final_photos') {
        const n = await afterPhotoCount(leadId);
        const w = n >= 0 ? P().finalPhotosWarning(newStage, n) : '';
        if (w) toast('📸 ' + w, 'warning');
      }
      if (newStage === 'install_complete' && window.setDoc && window.getDoc) {
        // The "After photos + walkthrough" checklist as a task (deterministic
        // id: re-entering the stage never duplicates or reopens it).
        const ref = window.doc(window.db, 'leads', leadId, 'tasks', 'stage-install_complete-after_walkthrough');
        const snap = await window.getDoc(ref);
        if (!snap.exists()) {
          await window.setDoc(ref, {
            leadId, userId: uid(), title: 'After photos + walkthrough', text: 'After photos + walkthrough',
            notes: P().AFTER_CHECKLIST.map((c) => '☐ ' + c.label).join('\n'), done: false, type: 'task',
            source: 'stage-checklist', dueDate: todayYmd(), createdAt: ts(),
          });
        }
      }
    } catch (e) { console.warn('[production] stage hook failed:', e && e.message); }
  }

  // ═══ listeners ═══════════════════════════════════════════════════════
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-pr-action]');
    if (t) {
      const act = t.dataset.prAction;
      if (act === 'rain-close') { closeRain(); return; }
      if (act === 'rain-save') { t.disabled = true; saveRain().catch((e) => { const m = $('prRainMsg'); if (m) m.textContent = 'Could not save: ' + ((e && e.message) || ''); t.disabled = false; }); return; }
      if (act === 'tom-share') {
        const id = t.closest('[data-pr-lead]') && t.closest('[data-pr-lead]').dataset.prLead;
        const row = P().tomorrowInstalls(window._leads || [], todayYmd(), reminderCtx()).find((r) => r.id === id);
        if (row && window.NBDPhoneShare) window.NBDPhoneShare.share({ text: row.text, phone: row.phone, email: row.email, subject: 'Tomorrow at ' + row.address });
        return;
      }
      if (t.closest('#productionPanel') || t.closest('#prRainSheet') === null) { onPanelAction(act, t); }
      return;
    }
    const sp = ev.target.closest && ev.target.closest('[data-sp-action="rain"]');
    if (sp) { const row = sp.closest('.sp-row'); if (row) openRainPush(row.dataset.id); return; }
    if (ev.target && ev.target.id === 'prRainSheet') closeRain();
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.id === 'prRainN') { _rain.n = parseInt(t.value, 10) || 1; planRain(); return; }
    if (t.classList && t.classList.contains('sp-sub-sel')) { const row = t.closest('.sp-row'); if (row) onRowSubChange(row); return; }
    if (t.id === 'prSubSel' && _cp.lead) {
      const v = t.value;
      const w = $('prSubWarn');
      if (w) { if (!v || v.indexOf('legacy:') === 0) w.innerHTML = ''; else subWarningsHtml(v, P().jobRange(_cp.lead), _cp.leadId).then((h) => { if ($('prSubWarn') === w) w.innerHTML = h; }); }
      return;
    }
    if ((t.id === 'prOrdDeliv' || t.id === 'prOrdStatus') && _cp.lead) {
      const w = $('prOrdWarn');
      if (w) w.textContent = P().deliveryWarning({ deliveryDate: ($('prOrdDeliv') || {}).value, status: ($('prOrdStatus') || {}).value }, _cp.lead);
      return;
    }
    if (t.dataset && t.dataset.prCheck && _cp.lead && canWrite()) {
      const cur = Object.assign({}, _cp.lead.afterChecklist || {});
      cur[t.dataset.prCheck] = !!t.checked;
      patchLead({ afterChecklist: cur }).catch((e) => toast('Could not save: ' + ((e && e.message) || ''), 'error'));
      return;
    }
    if (t.id === 'prAccess' && _cp.lead) {
      const pv = $('prSheetPreview');
      if (pv) pv.textContent = P().jobSheet({ lead: Object.assign({}, _cp.lead, { accessNotes: t.value }), orders: _cp.orders, sub: subById(_cp.lead.subId) });
    }
  });
  // The customer page's start editor asks Google the same double-booking
  // question as the other schedule pickers (warn, never block).
  let _startTimer = null;
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t || !['prDate', 'prTime', 'prDays'].includes(t.id)) return;
    clearTimeout(_startTimer);
    _startTimer = setTimeout(async () => {
      const G = window.NBDGoogleCalendarUI;
      const w = $('prStartWarn');
      if (!G || !w || typeof G.checkRow !== 'function') return;
      w.innerHTML = await G.checkRow({ date: ($('prDate') || {}).value, start: ($('prTime') || {}).value, days: ($('prDays') || {}).value }, _cp.leadId);
    }, 500);
  });

  // Boot: customer page waits for the lead; the dashboard paints the
  // Schedule view's extras when it is open.
  let _tries = 0;
  function bootCustomer() {
    if (!$('productionPanel')) return;
    if (window._customerId && window._leadDoc && ready() && uid()) { refreshCustomer(); return; }
    if (++_tries < 60) setTimeout(bootCustomer, 500);
  }
  let _schedTimer = null, _schedTries = 0;
  function bootSchedule() {
    clearTimeout(_schedTimer); _schedTries = 0;
    const tick = () => {
      const onSched = /schedule/.test(location.hash || '');
      if (onSched && $('schedBusyStrip') && Array.isArray(window._leads) && ready()) {
        Promise.all([loadSubs(), loadWeather()]).then(() => {
          renderSchedExtras();
          if (window.NBDSchedulePlannerUI && typeof window.NBDSchedulePlannerUI.render === 'function') window.NBDSchedulePlannerUI.render();
        });
        return;
      }
      if ($('todayPlan') && Array.isArray(window._leads)) renderTodaySection();
      if (++_schedTries < 40) _schedTimer = setTimeout(tick, 500);
    };
    _schedTimer = setTimeout(tick, 200);
  }
  // The lead modal's sub picker needs the roster before it is opened: load it
  // once signed in, and give a never-filled picker (a new lead) its options.
  let _subTries = 0;
  function bootSubs() {
    if (ready() && uid() && tenantKey()) { loadSubs(); return; }
    if (++_subTries < 60) setTimeout(bootSubs, 1000);
  }
  function fillBlankModalPicker() { const s = $('lSubId'); if (s && s.dataset.prLoaded !== '1') fillSubSelect('lSubId', {}); }
  window.addEventListener('nbd:subs-changed', fillBlankModalPicker);
  document.addEventListener('focusin', (ev) => { if (ev.target && ev.target.id === 'lSubId') fillBlankModalPicker(); });
  function boot() { bootCustomer(); bootSchedule(); if ($('lSubId')) bootSubs(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.addEventListener('hashchange', bootSchedule);
  window.addEventListener('nbd:data-refreshed', () => { bootSchedule(); if ($('productionPanel') && _cp.leadId) refreshCustomer(); });
  window.addEventListener('nbd:subs-changed', () => { if (_cp.lead && $('productionPanel')) renderPanel(); });

  window.NBDProduction = {
    loadSubs, subs, subById, saveSub, fillSubSelect, subFieldsFromSelect, subFieldsFromValue, subOptionsHtml,
    loadOrders, saveOrder, loadTenantOrders, rowExtrasHtml, rowSubPatch, weatherBadge, loadWeather,
    openRainPush, sendJobSheet, renderSchedExtras, renderTodaySection, onStageChange,
    _refreshCustomer: refreshCustomer, _state: _cp,
  };
})();
