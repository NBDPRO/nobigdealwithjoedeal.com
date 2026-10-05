/**
 * draw-measure-check.js — the Instant Roofer measure beside what the rep
 * draws, as a cross-check (2026-10-04).
 *
 * The CRM now orders the Instant Roofer measure on its own when a lead gets
 * an appointment or reaches Inspected (functions/integrations/
 * measure-auto-order.js). This card puts that measure next to the Draw
 * tool's own totals for the same address:
 *
 *   Instant Roofer   3,483 sf roof · 34.8 sq · 5/12
 *   Your drawing     3,310 sf roof (−5%)          ✓ close
 *
 * plus the vendor's outline image when one was stored (owner-only Storage
 * path docs/{uid}/measurements/…). A gap over GAP_WARN_PCT says "check the
 * outline" — the drawing is not overridden; the rep decides.
 *
 * Also consumes the V3 estimate wizard's "Draw it" hand-off: the wizard
 * stores {address, leadId} in sessionStorage and opens the Draw view; this
 * file fills the address, centres the map and binds the card to that lead.
 *
 * Read-only: no writes, no spend. CSP-clean (external file, no inline
 * styles — classes in css/draw-measure-check.css).
 */
(function () {
  'use strict';
  if (window.NBDDrawMeasureCheck && window.NBDDrawMeasureCheck.__v === 1) return;

  const GAP_WARN_PCT = 10;
  const PREFILL_KEY = 'nbd_draw_prefill';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const norm = (a) => String(a || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  /** Same fuzzy rule as maps-routing.js saveDrawingToCustomer. Pure. */
  function matchLead(address, leads) {
    const a = norm(address);
    if (!a) return null;
    return (leads || []).find((l) => {
      const n = norm(l && l.address);
      return n && (n.includes(a.substring(0, 12)) || a.includes(n.substring(0, 12)));
    }) || null;
  }

  /** The vendor numbers off a lead (or a measurements doc). Pure. */
  function vendorNumbers(lead, measDoc) {
    const l = lead || {};
    const m = (measDoc && measDoc.measurements) || {};
    const roof = Number(l.measurementSqft) || Number(m.rawSqft) || 0;
    if (!roof) return null;
    const pitchRaw = l.measurementPitch || m.pitch || null;
    return {
      roofSqft: Math.round(roof),
      footprintSqft: Number(l.measurementFootprintSqft) || Number(m.footprintSqft) || null,
      squares: Number(l.measurementSquares) || Math.round((roof / 100) * 10) / 10,
      pitch: /^[0-9]{1,2}\/[0-9]{1,2}$/.test(String(pitchRaw || '')) ? pitchRaw : null,
      perimeterLf: Number(l.measurementPerimeterLf) || Number(m.perimeterLf) || null,
      outlinePath: (typeof l.measurementOutlinePath === 'string' && l.measurementOutlinePath) || (measDoc && measDoc.outlinePath) || null,
    };
  }

  /**
   * Compare the vendor roof area with the drawn PITCHED area (both without
   * waste). Pure. diffPct is drawn relative to vendor, rounded.
   */
  function crossCheck(vendor, totals) {
    if (!vendor || !vendor.roofSqft) return null;
    const c = totals && totals.combined;
    const drawn = c && Number(c.pitched) > 0 ? Number(c.pitched) : 0;
    if (!drawn) return { vendor, drawnSqft: 0, diffPct: null, verdict: 'nothing-drawn' };
    const diffPct = Math.round(((drawn - vendor.roofSqft) / vendor.roofSqft) * 100);
    return { vendor, drawnSqft: Math.round(drawn), diffPct, verdict: Math.abs(diffPct) <= GAP_WARN_PCT ? 'close' : 'check' };
  }

  // ── state ──
  let api = null;
  let boundLeadId = null;
  let measCache = {};
  let outlineCache = {};

  function leadById(id) {
    return (window._leads || []).find((l) => l && l.id === id) || null;
  }
  function currentLead() {
    if (boundLeadId) {
      const l = leadById(boundLeadId);
      if (l) return l;
    }
    const input = document.getElementById('drawSearch');
    return matchLead(input && input.value, window._leads);
  }

  async function measDocFor(lead) {
    if (!lead || !lead.measurementJobId || lead.measurementSqft) return null;
    const id = lead.measurementJobId;
    if (id in measCache) return measCache[id];
    measCache[id] = null;
    try {
      if (window.getDoc && window.doc && (window._db || window.db)) {
        const snap = await window.getDoc(window.doc(window._db || window.db, 'measurements', id));
        measCache[id] = snap && snap.exists() ? snap.data() : null;
      }
    } catch (_) { /* a teammate's measurement is owner-only — fine */ }
    return measCache[id];
  }

  async function outlineUrl(path) {
    if (!path) return null;
    if (path in outlineCache) return outlineCache[path];
    outlineCache[path] = null;
    try {
      const st = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js');
      const storage = window._storage || window.storage;
      if (storage) outlineCache[path] = await st.getDownloadURL(st.ref(storage, path));
    } catch (_) { /* owner-only object; a teammate sees the numbers only */ }
    return outlineCache[path];
  }

  function cardHost() {
    const view = document.getElementById('view-draw');
    const res = view && view.querySelector('.calc-result');
    if (!res) return null;
    let card = view.querySelector('.dmc-card');
    if (!card) {
      card = document.createElement('div');
      card.className = 'dmc-card';
      card.setAttribute('aria-live', 'polite');
      res.parentNode.insertBefore(card, res.nextSibling);
    }
    return card;
  }

  function renderCard(card, check, imgUrl) {
    if (!check) { card.hidden = true; card.innerHTML = ''; return; }
    const v = check.vendor;
    const vendorLine = v.roofSqft.toLocaleString('en-US') + ' sf roof · ' + v.squares.toFixed(1) + ' sq'
      + (v.pitch ? ' · ' + v.pitch : '');
    let drawnLine = 'Draw the outline to compare';
    let cls = 'dmc-wait';
    if (check.verdict !== 'nothing-drawn') {
      const sign = check.diffPct > 0 ? '+' : (check.diffPct < 0 ? '−' : '±');
      drawnLine = check.drawnSqft.toLocaleString('en-US') + ' sf roof (' + sign + Math.abs(check.diffPct) + '%)';
      cls = check.verdict === 'close' ? 'dmc-ok' : 'dmc-warn';
    }
    card.hidden = false;
    card.className = 'dmc-card ' + cls;
    card.innerHTML =
      '<div class="dmc-title">Instant Roofer cross-check</div>'
      + '<div class="dmc-row"><span class="dmc-key">Instant Roofer</span><span class="dmc-val">' + esc(vendorLine) + '</span></div>'
      + '<div class="dmc-row"><span class="dmc-key">Your drawing</span><span class="dmc-val">' + esc(drawnLine) + '</span></div>'
      + (cls === 'dmc-warn' ? '<div class="dmc-note">More than ' + GAP_WARN_PCT + '% apart — check the outline against the image before pricing.</div>' : '')
      + (cls === 'dmc-ok' ? '<div class="dmc-note">Within ' + GAP_WARN_PCT + '% ✓</div>' : '')
      + (imgUrl ? '<img class="dmc-img" alt="Instant Roofer outline of this roof" src="' + esc(imgUrl) + '">' : '');
  }

  let _seq = 0;
  async function refresh() {
    const card = cardHost();
    if (!card) return null;
    const seq = ++_seq;
    const lead = currentLead();
    const vendor = vendorNumbers(lead, await measDocFor(lead));
    const totals = api && typeof api.totals === 'function' ? api.totals() : null;
    const check = crossCheck(vendor, totals);
    const img = check && vendor.outlinePath ? await outlineUrl(vendor.outlinePath) : null;
    if (seq !== _seq) return check; // a newer refresh already painted
    renderCard(card, check, img);
    return check;
  }

  // ── V3 wizard "Draw it" hand-off ──
  function takePrefill() {
    let raw = null;
    try { raw = sessionStorage.getItem(PREFILL_KEY); sessionStorage.removeItem(PREFILL_KEY); } catch (_) {}
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }
  function applyPrefill(p) {
    if (!p) return false;
    if (typeof p.leadId === 'string' && p.leadId) boundLeadId = p.leadId;
    const input = document.getElementById('drawSearch');
    if (input && p.address) {
      input.value = String(p.address).slice(0, 300);
      if (typeof window.searchDraw === 'function') {
        try { window.searchDraw(); } catch (_) {}
      }
    }
    refresh();
    return true;
  }

  function bind(seam) {
    if (!seam || api === seam) return;
    api = seam;
    if (typeof api.on === 'function') api.on('change', () => { refresh(); });
    applyPrefill(takePrefill());
    refresh();
  }

  document.addEventListener('nbd:drawmap-ready', (e) => bind(e && e.detail && e.detail.api));
  // drawMap is maps-routing.js's bare sibling-scope `let` (see draw-reticle.js
  // findMap): the map may have finished init before this file ran.
  try {
    /* global drawMap */
    if (typeof drawMap !== 'undefined' && drawMap && drawMap.nbdDraw) bind(drawMap.nbdDraw);
  } catch (_) { /* not declared yet — the event will come */ }
  // The address box: a new address means a new lead.
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'drawSearch') { boundLeadId = null; refresh(); }
  });
  // Re-entering the Draw view after the wizard stored a hand-off.
  window.addEventListener('hashchange', () => {
    if (/#\/draw\b/.test(location.hash) && api) applyPrefill(takePrefill());
  });

  window.NBDDrawMeasureCheck = {
    __v: 1, GAP_WARN_PCT, PREFILL_KEY,
    matchLead, vendorNumbers, crossCheck, refresh, applyPrefill,
  };
})();
