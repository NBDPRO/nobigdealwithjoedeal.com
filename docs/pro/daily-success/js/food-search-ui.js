/**
 * food-search-ui.js — the 🔎 Find a food card (tracker revamp Phase 2): type
 * a food or scan/type a barcode, see the macros per serving, tap Add and it
 * goes into a meal row like a favorite does. Rules: food-search-logic.js;
 * adding goes through window.NBDFoodLog.addToMeal (food-log-logic.js).
 *
 * Data is Open Food Facts. Only the typed words or the barcode number are
 * sent. Scanning uses the browser's BarcodeDetector (Chrome / Android); where
 * it is missing (iPhone Safari today) the card asks for the digits instead —
 * never a dead button. If the lookup fails, Jo can still type macros by hand.
 *
 * Classic script after food-log.js; delegated listeners; every value into
 * innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDFoodSearchUI) return;
  /* global pages, cur */
  const S = () => window.NBDFoodSearch;
  const F = () => window.NBDFoodLog;
  const MEAL_NAMES = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  const TIMEOUT_MS = 8000;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };

  let st = { q: '', results: null, status: '', busy: false, meal: null, servings: {}, codeBox: false, scanning: false };
  let stream = null, scanTimer = null;

  const mealIndex = () => (st.meal != null ? st.meal : F().mealForHour(new Date().getHours()));
  const canScan = () => 'BarcodeDetector' in window && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

  async function getJson(url) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      const r = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { if (timer) clearTimeout(timer); }
  }

  function resultHtml(f, i) {
    const n = st.servings[i] || 1;
    return '<li class="fs-item"><div class="fs-name">' + esc(f.name) + (f.brand ? ' <small>' + esc(f.brand) + '</small>' : '') + '</div>' +
      '<div class="fs-macros">per ' + esc(f.label) + ': <b>' + esc(f.p) + '</b>p · ' + esc(f.c) + 'c · ' + esc(f.f) + 'f · ' + esc(f.cal) + ' cal</div>' +
      '<div class="fl-row"><label class="fl-field">Servings<input class="fl-in fs-qty" inputmode="decimal" data-fs-qty="' + i + '" value="' + esc(n) + '"></label>' +
      '<button type="button" class="fl-btn fl-primary" data-fs-action="add" data-i="' + i + '">Add to ' + esc(MEAL_NAMES[mealIndex()]) + '</button></div></li>';
  }

  function cardHtml() {
    if (!S() || !F()) return '';
    const mi = mealIndex();
    const meals = MEAL_NAMES.map((n, i) => '<button type="button" class="fl-meal' + (i === mi ? ' on' : '') + '" data-fs-action="meal" data-i="' + i + '">' + n + '</button>').join('');
    const list = st.results && st.results.length ? '<ul class="fs-list">' + st.results.map(resultHtml).join('') + '</ul>' : '';
    const codeBox = st.codeBox
      ? '<div class="fl-row"><label class="fl-field">Barcode digits<input id="fsCode" class="fl-in" inputmode="numeric" maxlength="14" placeholder="e.g. 0123456789012"></label>' +
        '<button type="button" class="fl-btn fl-primary" data-fs-action="code-go">Look up</button></div>' : '';
    const video = st.scanning ? '<div class="fs-cam"><video id="fsVideo" playsinline muted></video><button type="button" class="fl-btn" data-fs-action="scan-stop">Stop scanning</button></div>' : '';
    return '<div class="wc-card fl-card fs-card" id="fsCard"><div class="wc-card-h">🔎 Find a food</div>' +
      '<div class="fl-row"><input id="fsQuery" class="fl-in fs-q" type="search" enterkeyhint="search" placeholder="Greek yogurt, chicken breast…" value="' + esc(st.q) + '" aria-label="Search foods">' +
      '<button type="button" class="fl-btn fl-primary" data-fs-action="search"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Searching…' : 'Search') + '</button>' +
      '<button type="button" class="fl-btn" data-fs-action="scan">▮▯▮ Scan</button></div>' +
      '<div class="fl-lbl">Add to</div><div class="fl-meals">' + meals + '</div>' +
      codeBox + video +
      (st.status ? '<div class="fl-note" role="status">' + esc(st.status) + '</div>' : '') + list +
      '<div class="fl-note">Food data: Open Food Facts. Check it against the label — community entries can be wrong.</div></div>';
  }
  function refresh() { const el = document.getElementById('fsCard'); if (el) { el.outerHTML = cardHtml(); } }

  async function search() {
    const q = ((document.getElementById('fsQuery') || {}).value || '').trim();
    st.q = q;
    if (q.length < 2) { st.status = 'Type at least two letters.'; refresh(); return; }
    st.busy = true; st.status = ''; st.results = null; st.servings = {}; refresh();
    try {
      const res = S().parseSearch(await getJson(S().searchUrl(q)));
      st.results = res;
      st.status = res.length ? '' : 'No foods with nutrition info found for "' + q + '". Try fewer words, or type the macros yourself.';
    } catch (_) {
      st.status = 'Could not reach the food database. You can still type the macros by hand below.';
    }
    st.busy = false; refresh();
  }

  async function lookupCode(code) {
    if (!S().validBarcode(code)) { st.status = 'That does not look like a valid barcode (8, 12, 13 or 14 digits). Check the numbers under the bars.'; refresh(); return; }
    st.busy = true; st.status = 'Looking up ' + code + '…'; st.results = null; st.servings = {}; refresh();
    try {
      const food = S().parseProduct(await getJson(S().barcodeUrl(code)));
      st.results = food ? [food] : [];
      st.status = food ? '' : 'Not in the food database (or no nutrition on it). Type the macros yourself, or search by name.';
    } catch (_) {
      st.status = 'Could not reach the food database. You can still type the macros by hand below.';
    }
    st.busy = false; st.codeBox = false; refresh();
  }

  // ── adding to a meal row (same path a favorite takes) ──────────────────
  function liveData() {
    const d = {};
    document.querySelectorAll('[data-k^="diet-m"]').forEach((el) => { d[el.dataset.k] = el.value || ''; });
    return d;
  }
  function addFood(i) {
    const food = st.results && st.results[i];
    if (!food) return;
    const m = mealIndex();
    const row = F().addToMeal(F().mealOf(liveData(), m), S().toFav(food, st.servings[i] || 1));
    if (!row) { toast('That food has no numbers to add'); return; }
    ['name'].concat(F().FIELDS).forEach((k) => {
      const el = document.querySelector('[data-k="diet-m' + m + '-' + k + '"]');
      if (el) el.value = row[k] == null ? '' : row[k];
    });
    if (typeof window.calcMacros === 'function') window.calcMacros();
    if (typeof window.markDirty === 'function') window.markDirty();
    if (typeof window.collectPage === 'function') window.collectPage(false);
    if (window.NBDFoodLogUI && typeof window.NBDFoodLogUI.refresh === 'function') window.NBDFoodLogUI.refresh();
    toast('Added ' + food.name + ' to ' + MEAL_NAMES[m]);
  }

  // ── camera scan (BarcodeDetector) ──────────────────────────────────────
  function stopScan() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (st.scanning) { st.scanning = false; refresh(); }
  }
  async function startScan() {
    if (!canScan()) { st.codeBox = true; st.status = 'Camera scanning is not available in this browser — type the digits under the barcode.'; refresh(); return; }
    st.scanning = true; st.status = ''; st.codeBox = false; refresh();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      const v = document.getElementById('fsVideo');
      if (!v) { stopScan(); return; }
      v.srcObject = stream; await v.play();
      const det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
      let busy = false;
      scanTimer = setInterval(async () => {
        if (busy) return; busy = true;
        try {
          const found = await det.detect(v);
          const hit = found && found.find((b) => S().validBarcode(b.rawValue));
          if (hit) { const code = hit.rawValue; stopScan(); lookupCode(code); }
        } catch (_) { /* keep trying */ }
        busy = false;
      }, 400);
    } catch (_) {
      stopScan();
      st.codeBox = true; st.status = 'Could not open the camera — allow camera access, or type the digits under the barcode.'; refresh();
    }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-fs-action]');
    if (!t) return;
    const a = t.dataset.fsAction;
    if (a === 'search') search();
    else if (a === 'meal') { st.meal = +t.dataset.i; refresh(); }
    else if (a === 'add') addFood(+t.dataset.i);
    else if (a === 'scan') startScan();
    else if (a === 'scan-stop') stopScan();
    else if (a === 'code-go') lookupCode(((document.getElementById('fsCode') || {}).value || '').replace(/\D/g, ''));
  });
  document.addEventListener('input', (ev) => {
    const i = ev.target && ev.target.dataset && ev.target.dataset.fsQty;
    if (i != null) { const n = parseFloat(ev.target.value); st.servings[i] = n > 0 ? Math.min(n, 20) : 1; }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'fsQuery') { ev.preventDefault(); search(); }
  });

  function hook() {
    const orig = window.buildDietSection;
    if (typeof orig !== 'function' || orig.__foodsearch) return;
    const wrapped = function () { stopScan(); st = { q: '', results: null, status: '', busy: false, meal: null, servings: {}, codeBox: false, scanning: false }; return cardHtml() + orig.apply(this, arguments); };
    Object.keys(orig).forEach((k) => { wrapped[k] = orig[k]; });
    wrapped.__foodsearch = true;
    window.buildDietSection = wrapped;
  }
  function boot() {
    if (!S() || !F()) return;
    hook();
    try { if (document.getElementById('diet-pb') && typeof window.renderPage === 'function') window.renderPage(); } catch (_) { /* renders without the card */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDFoodSearchUI = { cardHtml, refresh };
})();
