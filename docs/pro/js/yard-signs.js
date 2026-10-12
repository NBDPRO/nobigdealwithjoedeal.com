/**
 * yard-signs.js — the Yard Signs view (#/signs), lazy 'signs' bundle.
 *
 * Jo (2026-09-29): see where every yard sign is, a photo of each, when it
 * went out, and get reminded to pick it up when the agreed 1–2 weeks are up.
 * Homeowners text Jo if he DOESN'T come on time, so the reminders to Jo are
 * what matter (a daily push from functions/yard-sign-reminder.js + the
 * Today's-pickups list here, in driving order).
 *
 * Signs live in yardSigns/{id} (firestore.rules): the rep's own, readable by
 * company staff. Photos go to Storage yard-signs/{uid}/…. Rules/maths are in
 * yard-signs-logic.js (window.NBDYardSignLogic).
 *
 * All yard signs share one QR code (the /inspect?utm_source=yard-sign page),
 * so a yard-sign lead is credited to the nearest sign that was out when it
 * came in — shown as "N leads" on each sign.
 */
(function () {
  'use strict';
  if (window.YardSigns && window.YardSigns.__v === 1) return;

  const COL = 'yardSigns';
  const LG = () => window.NBDYardSignLogic;
  let _signs = [];
  let _loaded = false;
  let _here = null;           // last known position (for pickup order)
  let _map = null, _layer = null;
  let _showHistory = false;
  const _photoUrl = {};       // storagePath → download URL

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => (window._user && window._user.uid) || null;
  const claims = () => window._userClaims || {};
  const role = () => claims().role || '';
  const isViewer = () => role() === 'viewer';
  const isStaff = () => ['company_admin', 'manager', 'viewer', 'admin'].includes(role()) && !!claims().companyId;
  const toast = (m, t) => { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); };
  const fmtDate = (t) => { const v = LG().ms(t); return v ? new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'; };
  const leads = () => (window._leads || []).filter((l) => l && !l.deleted);
  const leadById = (id) => leads().find((l) => l.id === id) || null;
  const leadName = (l) => l ? (((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || String(l.address || '').split(',')[0] || 'Customer') : '';

  function scroll() { return document.getElementById('signsScroll') || document.querySelector('#view-signs .view-scroll'); }

  // ── data ─────────────────────────────────────────────────────────────
  async function load() {
    const u = uid();
    if (!u || !window.db || !window.getDocs) return;
    try {
      const col = window.collection(window.db, COL);
      const q = isStaff()
        ? window.query(col, window.where('companyId', '==', claims().companyId))
        : window.query(col, window.where('userId', '==', u));
      const snap = await window.getDocs(q);
      _signs = [];
      snap.forEach((d) => { const x = d.data() || {}; if (!x.deleted) _signs.push(Object.assign({ id: d.id }, x)); });
      _loaded = true;
    } catch (e) {
      console.warn('[yard-signs] load failed', e && e.code);
      toast('Could not load yard signs', 'error');
    }
  }

  async function uploadPhoto(file) {
    const u = uid();
    if (!file || !u || !window.storage || !window.ref || !window.uploadBytes) return null;
    if (!/^image\//.test(file.type || '')) { toast('Sign photo must be an image', 'error'); return null; }
    const safe = String(file.name || 'sign.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
    const path = 'yard-signs/' + u + '/' + Date.now() + '_' + safe;
    await window.uploadBytes(window.ref(window.storage, path), file, { contentType: file.type || 'image/jpeg' });
    return path;
  }

  async function photoUrl(path) {
    if (!path) return null;
    if (_photoUrl[path]) return _photoUrl[path];
    try { _photoUrl[path] = await window.getDownloadURL(window.ref(window.storage, path)); } catch (e) { _photoUrl[path] = null; }
    return _photoUrl[path];
  }

  function locate() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        () => resolve(null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    });
  }

  // Yard-sign QR leads credited to the nearest sign out at the time.
  function leadsBySign() {
    const out = {};
    leads().filter((l) => LG().isYardSignSource(l)).forEach((l) => {
      const hit = LG().attributeLead(l, _signs);
      if (hit) (out[hit.signId] = out[hit.signId] || []).push(l);
    });
    return out;
  }

  // ── render ───────────────────────────────────────────────────────────
  function chip(label, n, color) {
    return '<div style="background:var(--s2,#1a1d23);border:1px solid var(--br,#2a2e37);border-left:3px solid ' + color + ';border-radius:10px;padding:10px 14px;min-width:110px;">' +
      '<div style="font-size:22px;font-weight:800;">' + n + '</div><div style="font-size:11px;color:var(--m);text-transform:uppercase;letter-spacing:.04em;">' + esc(label) + '</div></div>';
  }

  function signRow(s, credit) {
    const L = LG();
    const st = L.statusOf(s);
    const lead = leadById(s.leadId);
    const ro = isViewer();
    const nLeads = (credit[s.id] || []).length;
    const live = st !== 'picked_up' && st !== 'missing';
    return '<div class="ys-row" data-ys-id="' + esc(s.id) + '" style="display:flex;gap:12px;align-items:center;background:var(--s2,#1a1d23);border:1px solid var(--br,#2a2e37);border-left:4px solid ' + L.COLOR[st] + ';border-radius:10px;padding:10px 12px;margin-bottom:8px;">' +
      '<div data-ys-photo="' + esc(s.photoPath || '') + '" style="width:56px;height:56px;flex:none;border-radius:8px;background:var(--s,#12223D);display:flex;align-items:center;justify-content:center;font-size:22px;overflow:hidden;">🪧</div>' +
      '<div style="min-width:0;flex:1;">' +
        '<div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(s.address || leadName(lead) || 'Yard sign') + '</div>' +
        '<div style="font-size:12px;color:var(--m);">' + (lead ? esc((lead.customerId ? lead.customerId + ' · ' : '') + leadName(lead)) + ' · ' : '') + 'placed ' + esc(fmtDate(s.placedAt)) + ' · ' + esc(s.durationDays ? s.durationDays + ' days' : '') + '</div>' +
        '<div style="font-size:12px;font-weight:700;color:' + L.COLOR[st] + ';">' + esc(L.dueText(s)) + (live ? ' · ' + esc(fmtDate(s.dueAt)) : '') + (nLeads ? ' · <span style="color:var(--green,#16a34a);">🎯 ' + nLeads + ' lead' + (nLeads === 1 ? '' : 's') + '</span>' : '') + '</div>' +
        (s.note ? '<div style="font-size:11px;color:var(--m);">' + esc(s.note) + '</div>' : '') +
      '</div>' +
      (live && !ro ? '<div style="display:flex;flex-direction:column;gap:4px;flex:none;">' +
        '<button type="button" class="btn btn-orange btn-sm" data-ys-action="pickup" data-ys-id="' + esc(s.id) + '">✓ Picked up</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-ys-action="extend" data-ys-id="' + esc(s.id) + '">+1 week</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-ys-action="missing" data-ys-id="' + esc(s.id) + '" style="font-size:11px;">Missing</button>' +
      '</div>' : '') +
      '</div>';
  }

  function render() {
    const el = scroll();
    if (!el) return;
    const L = LG();
    if (!L) { el.innerHTML = '<div style="padding:20px;">Loading…</div>'; return; }
    const sum = L.summary(_signs);
    const credit = leadsBySign();
    const active = _signs.filter((s) => { const st = L.statusOf(s); return st !== 'picked_up' && st !== 'missing'; })
      .sort((a, b) => L.ms(a.dueAt) - L.ms(b.dueAt));
    const history = _signs.filter((s) => !active.includes(s)).sort((a, b) => L.ms(b.pickedUpAt || b.updatedAt) - L.ms(a.pickedUpAt || a.updatedAt));
    const today = L.pickupList(_signs, Date.now(), _here);
    const creditedTotal = Object.values(credit).reduce((a, x) => a + x.length, 0);
    el.innerHTML =
      '<div class="page-hdr" style="display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:10px;">' +
        '<div><div class="page-title">🪧 Yard Signs</div><div class="page-sub">Where every sign is, when it goes back, and which ones bring in leads.</div></div>' +
        (isViewer() ? '' : '<button type="button" class="btn btn-orange" data-ys-action="open-place">＋ Place sign</button>') +
      '</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:14px 0;">' +
        chip('Out now', sum.out, '#16a34a') + chip('Due today', sum.dueToday, '#ea580c') + chip('Overdue', sum.overdue, '#dc2626') +
        chip('Due soon', sum.dueSoon, '#d97706') + chip('Leads from signs', creditedTotal, '#3b82f6') +
      '</div>' +
      (today.length ? '<div style="background:color-mix(in srgb, #ea580c 10%, transparent);border:1px solid #ea580c;border-radius:10px;padding:12px 14px;margin-bottom:14px;">' +
        '<div style="font-weight:800;margin-bottom:6px;">🚚 Pick up today' + (_here ? ' — in driving order' : '') + '</div>' +
        today.map((s, i) => '<div style="font-size:13px;padding:2px 0;">' + (i + 1) + '. ' + esc(s.address || 'Sign') + ' <span style="color:' + L.COLOR[L.statusOf(s)] + ';font-weight:700;">· ' + esc(L.dueText(s)) + '</span>' +
          (isFinite(s.lat) ? ' · <a href="https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(s.lat + ',' + s.lng) + '" target="_blank" rel="noopener">Directions</a>' : '') + '</div>').join('') +
        (_here ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-ys-action="order-route" style="margin-top:6px;">📍 Order by where I am</button>') +
      '</div>' : '') +
      '<div id="ysMap" style="height:320px;border-radius:12px;border:1px solid var(--br,#2a2e37);margin-bottom:14px;"></div>' +
      '<h3 class="rr-h" style="font-size:13px;text-transform:uppercase;color:var(--m);margin:10px 0 8px;">Out now (' + active.length + ')</h3>' +
      (active.length ? active.map((s) => signRow(s, credit)).join('') : '<div style="padding:18px;border:1px dashed var(--br);border-radius:10px;color:var(--m);text-align:center;">No signs out. Tap <b>＋ Place sign</b> at the next yard — GPS, a photo, and the pickup date take about ten seconds.</div>') +
      (history.length ? '<button type="button" class="btn btn-ghost btn-sm" data-ys-action="toggle-history" style="margin-top:10px;">' + (_showHistory ? 'Hide' : 'Show') + ' history (' + history.length + ')</button>' +
        (_showHistory ? '<div style="margin-top:8px;opacity:.8;">' + history.map((s) => signRow(s, credit)).join('') + '</div>' : '') : '');
    drawMap(active.concat(_showHistory ? history : []));
    fillPhotos(el);
  }

  async function fillPhotos(el) {
    const boxes = el.querySelectorAll('[data-ys-photo]');
    for (const b of boxes) {
      const p = b.getAttribute('data-ys-photo');
      if (!p) continue;
      const url = await photoUrl(p);
      if (url && b.isConnected) {
        const img = document.createElement('img');
        img.src = url; img.alt = 'Yard sign'; img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
        b.textContent = ''; b.appendChild(img);
      }
    }
  }

  function drawMap(list) {
    const box = document.getElementById('ysMap');
    if (!box || !window.L) return;
    if (_map) { try { _map.remove(); } catch (_) {} _map = null; }
    const pts = list.filter((s) => isFinite(s.lat) && isFinite(s.lng));
    _map = window.L.map(box, { zoomControl: true, attributionControl: false });
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(_map);
    _layer = window.L.layerGroup().addTo(_map);
    const L = LG();
    pts.forEach((s) => {
      const st = L.statusOf(s);
      const m = window.L.circleMarker([s.lat, s.lng], { radius: 9, color: '#fff', weight: 2, fillColor: L.COLOR[st], fillOpacity: 0.95 });
      const div = document.createElement('div');
      const t = document.createElement('b'); t.textContent = s.address || 'Yard sign'; div.appendChild(t);
      const d = document.createElement('div'); d.textContent = L.LABEL[st] + ' · ' + L.dueText(s); div.appendChild(d);
      m.bindPopup(div);
      m.addTo(_layer);
    });
    if (pts.length) _map.fitBounds(window.L.latLngBounds(pts.map((s) => [s.lat, s.lng])).pad(0.25), { maxZoom: 15 });
    else _map.setView(_here ? [_here.lat, _here.lng] : [39.1, -84.5], _here ? 13 : 9);
    setTimeout(() => { try { _map.invalidateSize(); } catch (_) {} }, 150);
  }

  // ── place-sign form ──────────────────────────────────────────────────
  let _form = null; // { lat, lng, days, dueOverride }

  function openPlace() {
    if (isViewer()) return;
    _form = { lat: null, lng: null, days: 14, custom: '' };
    const opts = leads().slice().sort((a, b) => leadName(a).localeCompare(leadName(b)))
      .map((l) => '<option value="' + esc(l.id) + '">' + esc((l.customerId ? l.customerId + ' · ' : '') + leadName(l) + (l.address ? ' — ' + String(l.address).split(',')[0] : '')) + '</option>').join('');
    const ov = document.createElement('div');
    ov.id = 'ysPlaceModal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.7);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px;';
    ov.innerHTML = '<div style="background:var(--s,#12223D);border:1px solid var(--br);border-radius:12px;width:100%;max-width:460px;padding:18px;color:var(--t,#fff);">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;"><h3 style="margin:0;">🪧 Place a yard sign</h3><button type="button" class="modal-close" data-ys-action="close-place">✕</button></div>' +
      '<label style="display:block;font-size:12px;margin:12px 0 4px;">Customer / job</label>' +
      '<select id="ysLead" style="width:100%;"><option value="">— Choose the homeowner —</option>' + opts + '</select>' +
      '<label style="display:block;font-size:12px;margin:12px 0 4px;">Address</label>' +
      '<input id="ysAddr" type="text" maxlength="200" placeholder="Fills from the customer, or type it" style="width:100%;">' +
      '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;"><button type="button" class="btn btn-ghost btn-sm" data-ys-action="gps">📍 Use my location</button><span id="ysGps" style="font-size:11px;color:var(--m);">No location yet</span></div>' +
      '<label style="display:block;font-size:12px;margin:12px 0 4px;">Pick it up after</label>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
        '<button type="button" class="btn btn-sm" data-ys-days="7">1 week</button>' +
        '<button type="button" class="btn btn-sm btn-orange" data-ys-days="14">2 weeks</button>' +
        '<input id="ysCustom" type="date" title="Or a specific date" style="flex:1;min-width:140px;">' +
      '</div>' +
      '<div id="ysDue" style="font-size:12px;color:var(--m);margin-top:4px;"></div>' +
      '<label style="display:block;font-size:12px;margin:12px 0 4px;">Photo of the sign in the yard <span style="color:var(--gold,#eab308);">(recommended)</span></label>' +
      '<input id="ysPhoto" type="file" accept="image/*" capture="environment">' +
      '<label style="display:block;font-size:12px;margin:12px 0 4px;">Note (optional)</label>' +
      '<input id="ysNote" type="text" maxlength="200" placeholder="e.g. left of driveway, HOA ok\'d" style="width:100%;">' +
      '<button type="button" class="btn btn-orange" data-ys-action="save-place" style="width:100%;margin-top:16px;justify-content:center;">Save sign</button>' +
      '</div>';
    document.body.appendChild(ov);
    updateDue();
    // Grab GPS right away — Jo is standing in the yard.
    doGps();
  }
  function closePlace() { const m = document.getElementById('ysPlaceModal'); if (m) m.remove(); _form = null; }

  function updateDue() {
    const el = document.getElementById('ysDue');
    if (!el || !_form) return;
    const due = _form.custom ? new Date(_form.custom + 'T00:00:00').getTime() : LG().dueFrom(Date.now(), _form.days);
    el.textContent = 'Pickup reminder on ' + new Date(due).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    document.querySelectorAll('[data-ys-days]').forEach((b) => b.classList.toggle('btn-orange', !_form.custom && +b.dataset.ysDays === _form.days));
  }

  async function doGps() {
    const s = document.getElementById('ysGps');
    if (s) s.textContent = 'Finding you…';
    const p = await locate();
    if (!_form) return;
    if (p) {
      _form.lat = p.lat; _form.lng = p.lng; _here = p;
      if (s) s.textContent = '✓ Located (±' + Math.round(p.acc || 0) + ' m)';
    } else if (s) s.textContent = 'Location unavailable — the customer\'s address will be used';
  }

  async function savePlace(btn) {
    if (!_form || isViewer()) return;
    if (window.NBDRole && typeof window.NBDRole.guard === 'function' && !window.NBDRole.guard()) return;
    const u = uid();
    if (!u || !window.addDoc) { toast('Not signed in', 'error'); return; }
    const leadId = (document.getElementById('ysLead') || {}).value || '';
    const lead = leadById(leadId);
    let addr = ((document.getElementById('ysAddr') || {}).value || '').trim() || (lead && lead.address) || '';
    let lat = _form.lat, lng = _form.lng;
    if (!isFinite(lat) && lead && isFinite(lead.lat)) { lat = lead.lat; lng = lead.lng; }
    if (!addr && !isFinite(lat)) { toast('Add an address or use your location', 'error'); return; }
    btn.disabled = true;
    try {
      const file = (document.getElementById('ysPhoto') || {}).files;
      let photoPath = null;
      if (file && file[0]) {
        try { photoPath = await uploadPhoto(file[0]); } catch (e) { toast('Photo upload failed — saved without it', 'warn'); }
      }
      const now = Date.now();
      const dueAt = _form.custom ? new Date(_form.custom + 'T00:00:00').getTime() : LG().dueFrom(now, _form.days);
      const days = _form.custom ? Math.max(1, LG().daysBetween(now, dueAt)) : _form.days;
      const data = {
        userId: u,
        companyId: claims().companyId || u,
        leadId: leadId || null,
        address: String(addr).slice(0, 200),
        lat: isFinite(lat) ? lat : null,
        lng: isFinite(lng) ? lng : null,
        photoPath: photoPath,
        placedAt: new Date(now),
        dueAt: new Date(dueAt),
        durationDays: days,
        status: 'out',
        extensions: 0,
        note: ((document.getElementById('ysNote') || {}).value || '').trim().slice(0, 200),
        createdAt: window.serverTimestamp(),
        updatedAt: window.serverTimestamp(),
      };
      const ref = await window.addDoc(window.collection(window.db, COL), data);
      _signs.push(Object.assign({ id: ref.id }, data, { placedAt: now, dueAt }));
      closePlace();
      toast('Sign placed — pickup reminder ' + new Date(dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), 'ok');
      render();
    } catch (e) {
      console.warn('[yard-signs] save failed', e && e.code);
      toast('Could not save the sign — try again', 'error');
      btn.disabled = false;
    }
  }

  async function update(id, patch, msg) {
    if (isViewer()) return;
    const s = _signs.find((x) => x.id === id);
    if (!s || !window.updateDoc) return;
    try {
      await window.updateDoc(window.doc(window.db, COL, id), Object.assign({}, patch, { updatedAt: window.serverTimestamp() }));
      Object.keys(patch).forEach((k) => { s[k] = patch[k] instanceof Date ? patch[k].getTime() : patch[k]; });
      toast(msg, 'ok');
      render();
    } catch (e) {
      console.warn('[yard-signs] update failed', e && e.code);
      toast(/permission/i.test((e && (e.code || e.message)) || '') ? 'Only the person who placed this sign can change it' : 'Could not update the sign', 'error');
    }
  }

  function pickup(id) { return update(id, { status: 'picked_up', pickedUpAt: new Date() }, 'Sign picked up ✓'); }
  function extend(id) {
    const s = _signs.find((x) => x.id === id);
    if (!s) return;
    const due = LG().extendedDue(s, 7);
    return update(id, { dueAt: new Date(due), extensions: (s.extensions || 0) + 1, pickupReminderSentFor: null }, 'Extended — new pickup ' + new Date(due).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  }
  async function missing(id) {
    const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (!(await ask('Mark this sign as missing (not there when you went to get it)?'))) return;
    return update(id, { status: 'missing', pickedUpAt: new Date() }, 'Marked missing');
  }

  async function init() {
    if (!LG()) return;
    render();
    await load();
    render();
  }

  if (!window._NBD_YS_DELEGATE) {
    window._NBD_YS_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      const t = ev.target.closest && ev.target.closest('[data-ys-action],[data-ys-days]');
      if (!t) return;
      if (t.dataset.ysDays && _form) { _form.days = +t.dataset.ysDays; _form.custom = ''; const c = document.getElementById('ysCustom'); if (c) c.value = ''; updateDue(); return; }
      const a = t.dataset.ysAction, id = t.dataset.ysId;
      if (a === 'open-place') openPlace();
      else if (a === 'close-place') closePlace();
      else if (a === 'gps') doGps();
      else if (a === 'save-place') savePlace(t);
      else if (a === 'pickup') pickup(id);
      else if (a === 'extend') extend(id);
      else if (a === 'missing') missing(id);
      else if (a === 'toggle-history') { _showHistory = !_showHistory; render(); }
      else if (a === 'order-route') locate().then((p) => { if (p) { _here = p; render(); } else toast('Location unavailable', 'error'); });
    });
    document.addEventListener('change', (ev) => {
      const el = ev.target;
      if (!_form || !el) return;
      if (el.id === 'ysLead') {
        const l = leadById(el.value);
        const a = document.getElementById('ysAddr');
        if (l && a && !a.value) a.value = l.address || '';
      } else if (el.id === 'ysCustom') { _form.custom = el.value || ''; updateDue(); }
    });
  }

  window.YardSigns = { __v: 1, init, render, list: () => _signs.slice(), _setData: (x) => { _signs = x || []; _loaded = true; } };
})();
