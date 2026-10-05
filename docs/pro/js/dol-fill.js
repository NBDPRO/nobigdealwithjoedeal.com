/**
 * dol-fill.js — "Fill dates of loss" (2026-10-02).
 *
 * The date of loss lives on the lead (lead.dateOfLoss — the lead form, the
 * claim panel, the paperwork) but was filled on 0 of 216 leads (vault
 * NEXT_SESSION-2026-09-24 §0), which left Theo's storm backtest location-only
 * and the claim paperwork asking every time. This turns the job into taps:
 *
 *   for each storm / insurance customer with no date of loss and a map pin,
 *   look up NWS storm reports near the house (the same /api/storm-report
 *   the public storm page and the D2D Storms layer use), keep hail and
 *   damaging wind within 3 mi in the 2 years BEFORE the lead came in, and
 *   suggest the likeliest — hail first, closest, biggest, latest.
 *
 * A suggestion is a lead to confirm with the homeowner / adjuster, never a
 * fact: a saved date is stamped dateOfLossSource 'storm_report_suggested'
 * so it reads as such, and Jo can type a different date on any row.
 * Query budget: leads are grouped by ~10 km cells (one endpoint call per
 * cell, cached server-side 24 h), spaced under the endpoint's 30/min limit.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const ENDPOINT = '/api/storm-report';
  const NEAR_MI = 3;
  const LOOKBACK_DAYS = 730;
  const CELL = 0.1; // ° — about 10 km; one storm query per cell
  const SPACING_MS = 2200;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  function ms(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    const t = Date.parse(v); return Number.isFinite(t) ? t : 0;
  }
  function haversineMi(la1, lo1, la2, lo2) {
    const R = 3958.8, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** Storm / insurance customers still missing a date of loss (pure). */
  function needsDol(lead) {
    if (!lead || lead.deleted === true || lead.e2eTestData) return false;
    if (isYmd(lead.dateOfLoss)) return false;
    const storm = /storm|hail|wind/i.test(String(lead.damageType || ''));
    const insurance = String(lead.jobType || '').toLowerCase() === 'insurance' || !!lead.insCarrier || !!lead.claimNumber || !!lead.claimStatus;
    return storm || insurance;
  }
  const hasPin = (l) => Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng)) && Number(l.lat) !== 0;

  /**
   * Rank storm reports as the likely loss for one lead (pure): hail or
   * damaging wind (≥ 58 mph), within NEAR_MI, between LOOKBACK_DAYS before
   * the lead came in and the day it came in. Hail beats wind; then closer,
   * bigger, and more recent.
   */
  function suggest(lead, events) {
    const created = ms(lead.createdAt) || Date.now();
    const lat = Number(lead.lat), lng = Number(lead.lng);
    return (events || []).map((e) => {
      const t = Date.parse(String(e.date || '').replace(' ', 'T'));
      const mi = haversineMi(lat, lng, Number(e.lat), Number(e.lon));
      return { e, t, mi };
    }).filter((x) => Number.isFinite(x.t) && x.t <= created + 86400000 && x.t >= created - LOOKBACK_DAYS * 86400000
      && x.mi <= NEAR_MI && (x.e.type === 'hail' || (x.e.type === 'wind' && Number(x.e.magnitude) >= 58) || x.e.type === 'tornado'))
      .map((x) => ({
        date: new Date(x.t).toISOString().slice(0, 10),
        type: x.e.type, magnitude: x.e.magnitude == null ? null : Number(x.e.magnitude),
        miles: Math.round(x.mi * 10) / 10, city: x.e.city || '',
        score: (x.e.type === 'hail' ? 1000 : x.e.type === 'tornado' ? 800 : 500) - x.mi * 60 + (x.e.type === 'hail' ? (Number(x.e.magnitude) || 0) * 40 : 0) + x.t / 1e11,
      }))
      .sort((a, b) => b.score - a.score)
      .filter((s, i, arr) => arr.findIndex((o) => o.date === s.date && o.type === s.type) === i)
      .slice(0, 3);
  }

  function label(s) {
    const what = s.type === 'hail' ? (s.magnitude ? s.magnitude + '" hail' : 'Hail') : s.type === 'wind' ? (s.magnitude ? s.magnitude + ' mph wind' : 'Wind') : 'Tornado';
    const d = new Date(s.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return what + ' · ' + d + ' · ' + s.miles + ' mi' + (s.city ? ' (' + s.city + ')' : '');
  }

  /** Group pinned leads into ~10 km cells → one storm query per cell (pure). */
  function cells(leads) {
    const out = {};
    leads.filter(hasPin).forEach((l) => {
      const k = (Math.round(Number(l.lat) / CELL) * CELL).toFixed(2) + ',' + (Math.round(Number(l.lng) / CELL) * CELL).toFixed(2);
      (out[k] = out[k] || []).push(l);
    });
    return out;
  }

  // ── modal ─────────────────────────────────────────────────────────────
  let _rows = [];
  const sleep = (n) => new Promise((r) => setTimeout(r, n));

  function rowHtml(r) {
    const l = r.lead;
    const name = ((((l.firstName || '') + ' ' + (l.lastName || '')).trim()) || l.address || 'Customer');
    const sug = r.suggestions || [];
    const id = esc(l.id);
    let body;
    if (r.state === 'saved') body = '<div class="dol-done">✓ Saved ' + esc(r.saved) + '</div>';
    else if (r.state === 'skipped') body = '<div class="dol-muted">Skipped</div>';
    else if (r.state === 'loading') body = '<div class="dol-muted">Checking storm reports…</div>';
    else {
      body = (sug.length
        ? sug.map((s, i) => '<button type="button" class="dol-pick' + (i === 0 ? ' is-top' : '') + '" data-dol-act="use" data-dol-id="' + id + '" data-dol-date="' + esc(s.date) + '">' + esc(label(s)) + '</button>').join('')
        : '<div class="dol-muted">' + (r.noPin ? 'No map pin on this customer — type the date.' : 'No hail or damaging wind reported within ' + NEAR_MI + ' mi in the 2 years before they called.') + '</div>') +
        '<div class="dol-own"><input type="date" class="dol-date" id="dolDate-' + id + '" aria-label="Date of loss for ' + esc(name) + '">' +
        '<button type="button" class="dol-btn" data-dol-act="own" data-dol-id="' + id + '">Save date</button>' +
        '<button type="button" class="dol-btn" data-dol-act="skip" data-dol-id="' + id + '">Skip</button></div>';
    }
    return '<div class="dol-row" id="dolRow-' + id + '"><div class="dol-name">' + esc(name) + '</div>' +
      '<div class="dol-meta">' + esc(l.address || '') + (l.damageType ? ' · ' + esc(l.damageType) : '') + (ms(l.createdAt) ? ' · came in ' + esc(new Date(ms(l.createdAt)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) : '') + '</div>' +
      body + '</div>';
  }

  function paint() {
    const list = document.getElementById('dolList');
    if (!list) return;
    const left = _rows.filter((r) => r.state !== 'saved' && r.state !== 'skipped').length;
    const head = document.getElementById('dolCount');
    if (head) head.textContent = _rows.length ? left + ' of ' + _rows.length + ' still need a date' : 'Every storm / insurance customer has a date of loss';
    list.innerHTML = _rows.map(rowHtml).join('') || '<div class="dol-muted">Nothing to fill.</div>';
  }

  async function open() {
    close();
    const leads = (Array.isArray(window._leads) ? window._leads : []).filter(needsDol)
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    _rows = leads.map((l) => ({ lead: l, state: hasPin(l) ? 'loading' : 'ready', noPin: !hasPin(l), suggestions: [] }));
    const ov = document.createElement('div');
    ov.className = 'dol-overlay'; ov.id = 'dolOverlay';
    ov.innerHTML = '<div class="dol-modal" role="dialog" aria-modal="true" aria-labelledby="dolTitle">' +
      '<div class="dol-head"><div><h2 class="dol-h" id="dolTitle">🌩 Fill dates of loss</h2><div class="dol-sub" id="dolCount"></div></div>' +
      '<button type="button" class="dol-close" data-dol-act="close" aria-label="Close">✕</button></div>' +
      '<p class="dol-note">Suggestions come from NWS storm reports near the house in the 2 years before the customer called. They are a starting point — confirm with the homeowner or adjuster. A picked suggestion is saved marked “suggested from storm reports”.</p>' +
      '<div id="dolList"></div></div>';
    document.body.appendChild(ov);
    paint();
    const groups = cells(leads);
    let first = true;
    for (const k of Object.keys(groups)) {
      if (!document.getElementById('dolOverlay')) return;
      if (!first) await sleep(SPACING_MS);
      first = false;
      const [lat, lon] = k.split(',');
      let events = [];
      try {
        const r = await fetch(ENDPOINT + '?lat=' + lat + '&lon=' + lon, { headers: { accept: 'application/json' } });
        const j = r.ok ? await r.json() : null;
        events = (j && Array.isArray(j.events)) ? j.events : [];
      } catch (e) { /* that cell answers "nothing found" */ }
      groups[k].forEach((l) => {
        const row = _rows.find((x) => x.lead.id === l.id);
        if (row && row.state === 'loading') { row.suggestions = suggest(l, events); row.state = 'ready'; }
      });
      paint();
    }
  }
  function close() { const o = document.getElementById('dolOverlay'); if (o) o.remove(); }

  /**
   * The lead update for an accepted date (pure). A date accepted FROM a storm
   * report names the storm, so the lead joins that storm's results in Reports
   * (stormId 'storm-YYYY-MM-DD' — the same id functions/storm-tag-logic.js
   * gives a lead that came in after the storm). A typed date is the
   * homeowner's / adjuster's word, not a storm report, so it does not tag; an
   * existing stormId is never replaced.
   */
  function savePatch(lead, date, source) {
    const patch = { dateOfLoss: date, dateOfLossSource: source };
    if (source === 'storm_report_suggested' && isYmd(date) && !(lead && lead.stormId)) {
      patch.stormId = 'storm-' + date;
      patch.stormDate = date;
      patch.stormTaggedBy = 'date_of_loss';
    }
    return patch;
  }

  async function save(id, date, source) {
    const row = _rows.find((r) => r.lead.id === id);
    if (!row || !isYmd(date)) { if (window.showToast) window.showToast('Pick or type a date first', 'error'); return; }
    try {
      const patch = savePatch(row.lead, date, source);
      await window.updateDoc(window.doc(window.db || window._db, 'leads', id), Object.assign({}, patch, { updatedAt: window.serverTimestamp() }));
      Object.assign(row.lead, patch);
      row.state = 'saved'; row.saved = date + (source === 'storm_report_suggested' ? ' (from storm reports — confirm)' : '');
      paint();
    } catch (e) {
      if (window.showToast) window.showToast('Could not save: ' + ((e && (e.code || e.message)) || 'error'), 'error');
    }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-dol-act]');
    if (!t) { if (ev.target && ev.target.id === 'dolOverlay') close(); return; }
    const act = t.dataset.dolAct, id = t.dataset.dolId;
    if (act === 'close') return close();
    if (act === 'use') return save(id, t.dataset.dolDate, 'storm_report_suggested');
    if (act === 'own') { const inp = document.getElementById('dolDate-' + id); return save(id, inp && inp.value, 'entered'); }
    if (act === 'skip') { const r = _rows.find((x) => x.lead.id === id); if (r) { r.state = 'skipped'; paint(); } }
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.getElementById('dolOverlay')) close(); });

  // Entry: the command palette ("Fill dates of loss").
  (function boot() {
    let tries = 0;
    const tick = () => {
      if (!(window.NBDCommand && typeof window.NBDCommand.registerAction === 'function' && window._user)) { if (++tries < 60) setTimeout(tick, 500); return; }
      window.NBDCommand.registerAction({ id: 'fill-dol', label: 'Fill dates of loss (storm jobs)', icon: '🌩', run: open, keywords: ['date of loss', 'dol', 'storm', 'hail', 'insurance', 'claim'], group: 'Tools' });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick); else tick();
  })();

  window.NBDDolFill = { open, close, needsDol, suggest, cells, label, savePatch, NEAR_MI, LOOKBACK_DAYS };
})();
