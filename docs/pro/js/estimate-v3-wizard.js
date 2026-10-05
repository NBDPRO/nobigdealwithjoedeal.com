/**
 * estimate-v3-wizard.js — Estimate Builder V3: the phone-first, one-thumb
 * step-by-step builder (Jo, 2026-10-02).
 *
 * V3 is a LAYER over the V2 builder modal, not a second builder. Every
 * control V3 shows is the real V2 control (same element, same delegated
 * handler, same state, same engine, same save/sign/deal-room paths), so
 * nothing V2 can do is lost and no pricing rule is re-implemented here.
 * V3 only decides which of those controls are on screen, one decision
 * per step, with a big Back / Next bar under the thumb.
 *
 *   Full roof: Customer → Measure → Roof lines → Roof details →
 *              Penetrations → Package → Shingle & add-ons → Insurance* →
 *              Photos → Review → Finish
 *   Repair:    Customer → Repair type → Repair size → Items → Insurance* →
 *              Photos → Review → Finish
 *   (* only on insurance jobs)
 *
 * V3 is what opens by default. "Full editor" in the header switches the
 * same open estimate to the V2 layout (V2 is shelved, not removed).
 *
 * Hooks: estimate-v2-ui.js calls EstimateV3.onOpen(opts) from open() and
 * EstimateV3.onRender() from render(). Prices for the Package cards come
 * from EstimateV2UI.tierTotals() — the same numbers the homeowner
 * presentation shows.
 */
(function () {
  'use strict';

  const STEP_TITLES = {
    job: 'Customer & job',
    measure: 'Measure',
    lines: 'Roof lines',
    details: 'Roof details',
    penetrations: 'Penetrations & flashing',
    package: 'Package',
    scope: 'Shingle & add-ons',
    repairType: 'Repair type',
    items: 'Items',
    insurance: 'Insurance claim',
    photos: 'Photos',
    review: 'Review',
    finish: 'Finish',
  };
  const ROOF_STEPS = ['job', 'measure', 'lines', 'details', 'penetrations', 'package', 'scope', 'insurance', 'photos', 'review', 'finish'];
  const REPAIR_STEPS = ['job', 'repairType', 'measure', 'items', 'insurance', 'photos', 'review', 'finish'];

  // Which step(s) each real V2 control belongs to. The tagged node is the
  // control's row: the direct child of its .v2-section-content wrapper.
  const TAGS = [
    ['#v2jobInsurance', 'job'],
    ['#v2custName', 'job'], ['#v2custEmail', 'job'], ['#v2custPhone', 'job'], ['#v2custAddress', 'job'],
    ['#v2county', 'job'],
    ['#v2measureBtn', 'measure'], ['#v2measureStatus', 'measure'],
    ['#v2rawSqft', 'measure'], ['#v2pitch', 'measure'],
    ['#v2eaveLf', 'lines'], ['#v2rakeLf', 'lines'], ['#v2ridgeLf', 'lines'], ['#v2hipLf', 'lines'], ['#v2valleyLf', 'lines'],
    ['#v2layers', 'details'], ['#v2stories', 'details'], ['#v2access', 'details'], ['#v2cutup', 'details'],
    ['#v2pipes', 'penetrations'], ['#v2chimneys', 'penetrations'], ['#v2skylights', 'penetrations'],
    ['#v2chimneyFlash', 'penetrations'], ['#v2skylightFlash', 'penetrations'],
    ['#v2modePerSq', 'package'], ['#v2modeHint', 'package'],
    ['.v2-preset-btns', 'scope repairType'],
    ['#v2valleyMetalLf', 'scope items'], ['#v2guttersLf', 'scope items'],
    ['#v2search', 'scope items'], ['#v2cats', 'scope items'], ['#v2items', 'scope items'],
    ['#v2scopeList', 'scope items review'],
    ['.v2-total-card', 'review'],
    ['.v2-export-btns', 'review finish', 'more'],
    ['#v2claimCarrier', 'insurance'], ['#v2claimNumber', 'insurance'], ['#v2claimAdjuster', 'insurance'],
    ['#v2claimDeductible', 'insurance'], ['#v2claimAcv', 'insurance'], ['#v2claimDateOfLoss', 'insurance'],
    ['#v2claimPolicyNumber', 'insurance'],
    ['#v2photosHint', 'photos'], ['#v2photosGrid', 'photos'],
    // Finish (2026-10-03): ONE primary — "Send to homeowner" (save → deal →
    // link → share sheet). It used to be four competing buttons (Create Deal
    // Room / Present / Save / Send for Signature) plus four exports; those now
    // sit under "More" (third column = 'more').
    ['[data-action="send-to-homeowner"]', 'finish'], ['#v2shareStatus', 'finish'], ['#v2shareBox', 'finish'],
    ['[data-action="present"]', 'finish', 'more'],
    ['#v2saveBtn', 'finish', 'more'], ['#v2saveStatus', 'finish', 'more'],
    ['#v2signPhoneBtn', 'finish', 'more'], ['#v2kyNote', 'finish', 'more'], ['#v2kyContractBtn', 'finish', 'more'],
    ['#v2signBtn', 'finish', 'more'], ['#v2signStatus', 'finish', 'more'],
    // In-house e-sign (2026-10-04): the optional co-owner rides with Send for Signature.
    ['#v2cosign', 'finish', 'more'],
  ];

  // Count fields get −/+ steppers; selects become tap chips.
  const STEPPERS = ['v2pipes', 'v2chimneys', 'v2skylights'];
  const CHIP_SELECTS = ['v2pitch', 'v2layers', 'v2stories', 'v2access'];

  // Presets that only make sense for one kind of job.
  const REPAIR_PRESETS = ['small-repair', 'shingle-patch'];

  const TIER_NOTES = {
    economy: 'Builder-grade shingle · 1-yr labor warranty',
    good: 'Architectural shingle',
    better: 'Upgraded system · most popular',
    best: 'Premium system',
    beyond: 'TAMKO HailGuard — locked · hail warranty',
  };

  const ui = {
    modal: null,
    on: true,          // V3 is the default every time the builder opens
    kind: 'roof',      // 'roof' | 'repair'
    step: 'job',
    inferKind: false,  // infer roof/repair once, after the open's state loads
    // Skip the Customer step once, after the open's state loads, when it came
    // prefilled from a lead (2026-10-03).
    skipJob: false,
    more: false,       // Finish's "More" section open
    built: false,
  };

  const $ = (sel) => (ui.modal ? ui.modal.querySelector(sel) : null);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const v2 = () => window.EstimateV2UI || null;
  const v2state = () => { const a = v2(); return (a && typeof a.getState === 'function') ? a.getState() : {}; };

  function steps() {
    const list = ui.kind === 'repair' ? REPAIR_STEPS : ROOF_STEPS;
    const st = v2state();
    return list.filter((s) => s !== 'insurance' || st.jobMode === 'insurance');
  }

  function fmtMoney(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  // ── one-time build ───────────────────────────────────────────────────
  function rowOf(el) {
    let n = el;
    while (n && n.parentElement && !n.parentElement.classList.contains('v2-section-content')) n = n.parentElement;
    return (n && n.parentElement) ? n : null;
  }

  function build() {
    const modal = document.getElementById('estV2Modal');
    if (!modal) return false;
    ui.modal = modal;
    if (ui.built) return true;

    TAGS.forEach(([sel, stepList, more]) => {
      const el = modal.querySelector(sel);
      const row = el && rowOf(el);
      if (!row) return;
      row.setAttribute('data-v3', stepList);
      if (more === 'more') row.setAttribute('data-v3-more', '1');
    });

    // Finish: the primary block leads the step, then the "More" toggle; the
    // secondary rows (DOM order) show only while More is open.
    const primary = modal.querySelector('[data-action="send-to-homeowner"]');
    const primaryWrap = primary && primary.closest('.v2-section-content');
    if (primaryWrap) {
      primaryWrap.classList.add('v3-finish-primary');
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'v3-more';
      moreBtn.dataset.v3Act = 'more';
      moreBtn.setAttribute('data-v3', 'finish');
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.textContent = 'More ▾';
      primaryWrap.appendChild(moreBtn);
    }

    // Presets lead the add-ons screen (in V2 they sit under Add-Ons).
    const presets = modal.querySelector('.v2-preset-btns');
    const presetsWrap = presets && presets.closest('.v2-section-content');
    if (presetsWrap) presetsWrap.classList.add('v3-first');

    STEPPERS.forEach((id) => {
      const input = document.getElementById(id);
      if (!input || input.dataset.v3Stepper) return;
      input.dataset.v3Stepper = '1';
      input.setAttribute('inputmode', 'numeric');
      const wrap = document.createElement('div');
      wrap.className = 'v3-stepper';
      input.parentNode.insertBefore(wrap, input);
      const minus = document.createElement('button');
      minus.type = 'button'; minus.className = 'v3-step-btn'; minus.textContent = '−';
      minus.dataset.v3Act = 'dec'; minus.dataset.v3For = id;
      minus.setAttribute('aria-label', 'Decrease');
      const plus = document.createElement('button');
      plus.type = 'button'; plus.className = 'v3-step-btn'; plus.textContent = '+';
      plus.dataset.v3Act = 'inc'; plus.dataset.v3For = id;
      plus.setAttribute('aria-label', 'Increase');
      wrap.appendChild(minus); wrap.appendChild(input); wrap.appendChild(plus);
    });
    ['v2rawSqft', 'v2eaveLf', 'v2rakeLf', 'v2ridgeLf', 'v2hipLf', 'v2valleyLf', 'v2valleyMetalLf', 'v2guttersLf'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.setAttribute('inputmode', 'decimal');
    });

    CHIP_SELECTS.forEach((id) => {
      const sel = document.getElementById(id);
      if (!sel || sel.dataset.v3Chips) return;
      sel.dataset.v3Chips = '1';
      sel.classList.add('v3-chip-src');
      const box = document.createElement('div');
      box.className = 'v3-chips';
      box.setAttribute('role', 'group');
      Array.from(sel.options).forEach((o) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'v3-chip';
        b.dataset.v3Act = 'chip'; b.dataset.v3For = id; b.dataset.v3Val = o.value;
        b.textContent = o.textContent;
        box.appendChild(b);
      });
      sel.parentNode.insertBefore(box, sel.nextSibling);
    });

    const body = modal.querySelector('.v2-body');
    const head = document.createElement('div');
    head.className = 'v3-head';
    head.innerHTML =
      '<button type="button" class="v3-jump" data-v3-act="jump-open" aria-haspopup="true">' +
        '<span class="v3-count"></span><span class="v3-title"></span><span class="v3-caret" aria-hidden="true">▾</span>' +
      '</button>' +
      '<div class="v3-dots" aria-hidden="true"></div>';
    const extra = document.createElement('div');
    extra.className = 'v3-extra';
    extra.innerHTML =
      '<div data-v3="job" class="v3-kind">' +
        '<div class="v3-label">What are we pricing?</div>' +
        '<div class="v3-kind-row">' +
          '<button type="button" class="v3-big" data-v3-act="kind" data-v3-val="roof">🏠 Full roof</button>' +
          '<button type="button" class="v3-big" data-v3-act="kind" data-v3-val="repair">🔧 Repair</button>' +
        '</div>' +
        '<div class="v3-label">Cash or insurance?</div>' +
      '</div>' +
      // "Draw it" (2026-10-04): the measure step's way into the Draw tool for
      // this address — the cross-check card there shows the Instant Roofer
      // measure beside the drawing. The estimate draft autosaves, so leaving
      // for the map loses nothing.
      '<div data-v3="measure" class="v3-draw-it">' +
        '<button type="button" class="v3-big v3-draw-btn" data-v3-act="draw-it">✏️ Draw it on the map</button>' +
        '<div class="v3-draw-msg" aria-live="polite"></div>' +
      '</div>' +
      '<div data-v3="package" class="v3-pkg"></div>' +
      '<div data-v3="scope repairType" class="v3-review-hint">Start from a preset — you can add or remove any item after.</div>' +
      // Photos are taken in the driveway, mid-estimate: shoot or pick them
      // here instead of leaving for the customer page (the step used to be a
      // dead end on a new customer). Uploads go to the linked customer
      // through PhotoEngine — the same path as the camera everywhere else.
      '<div data-v3="photos" class="v3-photo-add">' +
        '<button type="button" class="v3-big" data-v3-act="photo-add">📷 Add photos</button>' +
        '<input type="file" accept="image/*" multiple class="v3-photo-input" hidden>' +
        '<div class="v3-photo-msg" aria-live="polite"></div>' +
      '</div>' +
      '<div data-v3="review" class="v3-review-hint">Tap the step name at the top to jump back and change anything.</div>';
    body.insertBefore(extra, body.firstChild);
    body.insertBefore(head, body.firstChild);

    const bar = document.createElement('div');
    bar.className = 'v3-bar';
    bar.innerHTML =
      '<button type="button" class="v3-nav v3-back" data-v3-act="back">‹ Back</button>' +
      '<div class="v3-bar-total" aria-live="polite"><span class="v3-bar-lbl">Total</span><span class="v3-bar-val">$0</span></div>' +
      '<button type="button" class="v3-nav v3-next" data-v3-act="next">Next ›</button>';
    modal.appendChild(bar);

    const sheet = document.createElement('div');
    sheet.className = 'v3-sheet';
    sheet.hidden = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Jump to a step');
    modal.appendChild(sheet);

    const hdr = modal.querySelector('.v2-hdr');
    const closeBtn = modal.querySelector('.v2-close');
    if (hdr && closeBtn) {
      const t = document.createElement('button');
      t.type = 'button'; t.className = 'v3-toggle'; t.id = 'v3Toggle';
      t.dataset.v3Act = 'toggle';
      hdr.insertBefore(t, closeBtn);
    }

    injectCss();
    modal.addEventListener('click', onClick);
    modal.addEventListener('change', (ev) => {
      if (ev.target && ev.target.classList && ev.target.classList.contains('v3-photo-input')) addPhotos(ev.target);
    });
    ui.built = true;
    return true;
  }

  // ── events ───────────────────────────────────────────────────────────
  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

  function onClick(ev) {
    const t = ev.target.closest('[data-v3-act]');
    if (!t || !ui.modal.contains(t)) return;
    const act = t.dataset.v3Act;
    if (act === 'next') return go(+1);
    if (act === 'back') return go(-1);
    if (act === 'toggle') { ui.on = !ui.on; return paint(); }
    if (act === 'more') { ui.more = !ui.more; return paint(); }
    if (act === 'kind') { ui.kind = t.dataset.v3Val === 'repair' ? 'repair' : 'roof'; ui.inferKind = false; return paint(); }
    if (act === 'photo-add') {
      const input = $('.v3-photo-input');
      if (input) input.click();
      return;
    }
    if (act === 'draw-it') return drawIt();
    if (act === 'jump-open') return openSheet();
    if (act === 'jump') { closeSheet(); ui.step = t.dataset.v3Val; return paint(true); }
    if (act === 'sheet-close') return closeSheet();
    if (act === 'inc' || act === 'dec') {
      const input = document.getElementById(t.dataset.v3For);
      if (!input) return;
      const cur = Number(input.value) || 0;
      input.value = String(Math.max(0, cur + (act === 'inc' ? 1 : -1)));
      fire(input, 'input');
      return;
    }
    if (act === 'chip') {
      const sel = document.getElementById(t.dataset.v3For);
      if (!sel) return;
      sel.value = t.dataset.v3Val;
      fire(sel, 'change');
      paintChips();
      return;
    }
    if (act === 'preset') {
      // The real V2 preset button (clears + loads the scope, then render()
      // re-applies the tier's shingle lock).
      const btn = ui.modal.querySelector('.v2-preset-btns [data-arg="' + t.dataset.v3Val + '"]');
      if (btn) btn.click();
      paintPackage();
      return;
    }
    if (act === 'tier') {
      // The real V2 tier button — setTierChoice + the HailGuard / no-3-tab
      // shingle lock run exactly as they do in the full editor.
      const btn = document.getElementById('v2tier' + t.dataset.v3Val.charAt(0).toUpperCase() + t.dataset.v3Val.slice(1));
      if (btn) btn.click();
      paintPackage();
    }
  }

  // Hand the address (and lead) to the Draw tool. draw-measure-check.js
  // reads the hand-off from sessionStorage, fills the address and binds its
  // Instant Roofer cross-check card to this lead.
  const DRAW_PREFILL_KEY = 'nbd_draw_prefill';
  function drawIt() {
    const addrEl = document.getElementById('v2custAddress');
    const address = String((addrEl && addrEl.value) || '').trim();
    const msg = $('.v3-draw-msg');
    if (!address) {
      if (msg) msg.textContent = 'Add the address on the Customer step first.';
      return false;
    }
    const st = v2state();
    const leadId = st.leadId || (st.customer && st.customer.leadId) || null;
    try { sessionStorage.setItem(DRAW_PREFILL_KEY, JSON.stringify({ address: address.slice(0, 300), leadId: leadId })); } catch (_) {}
    if (typeof window.goTo === 'function' && document.getElementById('view-draw')) {
      const close = ui.modal && ui.modal.querySelector('.v2-close');
      if (close) close.click();
      window.goTo('draw');
    } else {
      window.location.href = '/pro/dashboard.html#/draw';
    }
    return true;
  }

  async function addPhotos(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    const msg = $('.v3-photo-msg');
    const btn = $('[data-v3-act="photo-add"]');
    const say = (t) => { if (msg) msg.textContent = t; };
    const st = v2state();
    const leadId = st.leadId || (st.customer && st.customer.leadId) || null;
    if (!leadId) { say('Pick the customer first (step 1) — photos are saved to their file.'); return; }
    if (btn) btn.disabled = true;
    try {
      // Before the photos bundle loads, dashboard-actions.js parks a
      // load-then-run stub on window.PhotoEngine whose uploadFromFile fires
      // the real upload later and returns nothing — so we'd never learn the
      // new photo's id. Treat the stub as "not loaded" and load the real one.
      const real = () => window.PhotoEngine && !window.PhotoEngine.__nbdLazyPhotosStub
        && typeof window.PhotoEngine.uploadFromFile === 'function';
      if (!real() && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
        await window.ScriptLoader.loadBundle('photos');
      }
      if (!real()) {
        say('Photos are not available right now — add them from the customer page.');
        return;
      }
      const done = [];
      let failed = 0;
      for (let i = 0; i < files.length; i++) {
        say('Uploading ' + (i + 1) + ' of ' + files.length + '…');
        try {
          const p = await window.PhotoEngine.uploadFromFile(leadId, files[i], [], '');
          if (p && p.id) done.push(p.id);
        } catch (e) {
          failed++;
          console.warn('[estimate-v3] photo upload failed:', e);
        }
      }
      const a = v2();
      if (a && typeof a.reloadLeadPhotos === 'function') await a.reloadLeadPhotos();
      if (a && typeof a.includePhoto === 'function') done.forEach((id) => a.includePhoto(id));
      say((done.length ? done.length + ' photo' + (done.length === 1 ? '' : 's') + ' added to this estimate.' : '') +
        (failed ? ' ' + failed + ' did not upload — try again with signal.' : ''));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function go(delta) {
    const list = steps();
    let i = list.indexOf(ui.step);
    if (i === -1) i = 0;
    const j = Math.min(list.length - 1, Math.max(0, i + delta));
    ui.step = list[j];
    paint(true);
  }

  function openSheet() {
    const sheet = $('.v3-sheet');
    if (!sheet) return;
    const list = steps();
    sheet.innerHTML =
      '<div class="v3-sheet-card">' +
        '<div class="v3-sheet-hd"><span>Jump to</span>' +
          '<button type="button" class="v3-sheet-x" data-v3-act="sheet-close" aria-label="Close">✕</button></div>' +
        list.map((s, i) =>
          '<button type="button" class="v3-sheet-row' + (s === ui.step ? ' cur' : '') + '" data-v3-act="jump" data-v3-val="' + esc(s) + '">' +
            '<span class="n">' + (i + 1) + '</span>' + esc(title(s)) + '</button>').join('') +
      '</div>';
    sheet.hidden = false;
  }
  function closeSheet() { const s = $('.v3-sheet'); if (s) s.hidden = true; }

  function title(s) {
    // A repair's measure step sizes the repair (the presets prefill it).
    if (s === 'measure' && ui.kind === 'repair') return 'Repair size';
    return STEP_TITLES[s] || s;
  }

  // ── paint ────────────────────────────────────────────────────────────
  function paint(scrollTop) {
    if (!ui.modal) return;
    const m = ui.modal;
    m.classList.toggle('v3-on', ui.on);
    m.classList.toggle('v3-kind-repair', ui.kind === 'repair');
    m.classList.toggle('v3-kind-roof', ui.kind !== 'repair');
    const tog = document.getElementById('v3Toggle');
    if (tog) tog.textContent = ui.on ? 'Full editor' : 'Step mode';
    const titles = m.querySelectorAll('.v2-hdr .v2-title');
    const name = titles[1];
    if (name) {
      if (!name.dataset.v2Text) name.dataset.v2Text = name.textContent;
      name.textContent = ui.on ? 'Estimate' : name.dataset.v2Text;
    }
    if (!ui.on) { closeSheet(); return; }

    const list = steps();
    if (list.indexOf(ui.step) === -1) ui.step = list[Math.min(list.length - 1, 0)];
    const idx = list.indexOf(ui.step);
    m.classList.toggle('v3-step-finish', ui.step === 'finish');
    m.classList.toggle('v3-more-open', !!ui.more);
    const moreBtn = $('.v3-more');
    if (moreBtn) {
      moreBtn.setAttribute('aria-expanded', ui.more ? 'true' : 'false');
      moreBtn.textContent = ui.more ? 'Less ▴' : 'More ▾';
    }

    m.querySelectorAll('[data-v3]').forEach((el) => {
      const on = el.getAttribute('data-v3').split(' ').indexOf(ui.step) !== -1;
      el.classList.toggle('v3-cur', on);
    });
    m.querySelectorAll('.v3-kind-row .v3-big').forEach((b) => b.classList.toggle('active', b.dataset.v3Val === ui.kind));

    const cnt = $('.v3-count'); if (cnt) cnt.textContent = (idx + 1) + ' / ' + list.length;
    const ttl = $('.v3-title'); if (ttl) ttl.textContent = title(ui.step);
    const dots = $('.v3-dots');
    if (dots) dots.innerHTML = list.map((s, i) => '<i class="' + (i < idx ? 'done' : i === idx ? 'cur' : '') + '"></i>').join('');
    const back = $('.v3-back'); if (back) back.disabled = idx === 0;
    const next = $('.v3-next');
    if (next) {
      next.hidden = idx === list.length - 1;
      next.textContent = (list[idx + 1] ? title(list[idx + 1]) : 'Next') + ' ›';
    }
    paintChips();
    if (ui.step === 'package') paintPackage();
    paintTotal();
    if (scrollTop) {
      const body = m.querySelector('.v2-body');
      if (body) body.scrollTop = 0;
    }
  }

  function paintChips() {
    CHIP_SELECTS.forEach((id) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const box = sel.nextSibling;
      if (!box || !box.classList || !box.classList.contains('v3-chips')) return;
      box.querySelectorAll('.v3-chip').forEach((b) => b.classList.toggle('active', b.dataset.v3Val === sel.value));
    });
  }

  function paintPackage() {
    const box = $('.v3-pkg');
    if (!box) return;
    const a = v2();
    const st = v2state();
    const cfg = window.NBD_ESTIMATE_CONFIG || {};
    // The tiers THIS company offers (2026-10-04): estimate-config tierOrder()
    // asks the company's business rules; NBD gets its five, as before.
    const tiers = (typeof cfg.tierOrder === 'function') ? cfg.tierOrder()
      : (Array.isArray(cfg.TIER_ORDER) ? cfg.TIER_ORDER : ['good', 'better', 'best']);
    let totals = {};
    try { totals = (a && typeof a.tierTotals === 'function') ? (a.tierTotals() || {}) : {}; } catch (_) { totals = {}; }
    const scope = Array.isArray(st.scope) ? st.scope : [];
    const empty = !scope.length;
    const label = (t) => (typeof cfg.tierLabel === 'function' ? cfg.tierLabel(t) : '') ||
      (cfg.TIER_DISPLAY && cfg.TIER_DISPLAY[t] && cfg.TIER_DISPLAY[t].label) || (t.charAt(0).toUpperCase() + t.slice(1));
    // The COMPANY's package prices (2026-10-04) — the same resolution the
    // engine prices with (EstimateBuilderV2.effectiveTierRates), not the
    // NBD config numbers this card used to print for every company.
    let rates = null;
    try { rates = (window.EstimateBuilderV2 && typeof window.EstimateBuilderV2.effectiveTierRates === 'function') ? window.EstimateBuilderV2.effectiveTierRates() : null; } catch (_) { rates = null; }
    rates = rates || cfg.TIER_RATES || {};
    const rate = (t) => (rates[t]) ? ('$' + rates[t] + '/SQ') : '';
    const TR = window.NBDTenantRules;
    const note = (t) => {
      const own = (TR && typeof TR.noteFor === 'function') ? TR.noteFor(t) : null;
      return own != null ? own : (TIER_NOTES[t] || '');
    };
    const starter = !!(TR && typeof TR.isPlatformTenant === 'function' && !TR.isPlatformTenant() && typeof TR.ratesSet === 'function' && !TR.ratesSet());
    // Line-item pricing (every insurance job, and cash jobs off Per-SQ) has
    // no side-by-side: tierTotals() collapses to the selected package when
    // the others can't be priced like-for-like. Those cards used to read
    // "—", which looks broken. Say what is true instead: tap a package and
    // its total shows (the real tier change re-prices the scope).
    const priced = tiers.filter((t) => typeof totals[t] === 'number').length;
    const oneAtATime = !empty && priced < 2;
    const price = (t) => (typeof totals[t] === 'number' || !oneAtATime)
      ? '<span class="v3-tier-price">' + esc(fmtMoney(totals[t])) + '</span>'
      : '<span class="v3-tier-price v3-tier-pending">Tap to price</span>';
    box.innerHTML = (empty
      ? '<div class="v3-pkg-empty"><div>Load the roof system to price the packages:</div>' +
          '<div class="v3-kind-row">' +
            '<button type="button" class="v3-big" data-v3-act="preset" data-v3-val="standard-reroof">Standard Reroof</button>' +
            '<button type="button" class="v3-big" data-v3-act="preset" data-v3-val="storm-claim">Storm Claim</button>' +
          '</div></div>'
      : '') +
      (oneAtATime
        ? '<div class="v3-review-hint v3-pkg-one">Line-item pricing totals the package you pick — tap one to see its price. Per-SQ pricing (cash jobs) shows every package side by side.</div>'
        : '') +
      (starter
        ? '<div class="v3-review-hint v3-pkg-starter" data-v3-starter-rates>These are starter prices. Set your own package prices in Settings → Estimates and every estimate uses them.</div>'
        : '') + tiers.map((t) =>
      '<button type="button" class="v3-tier' + (st.tier === t ? ' active' : '') + (t === 'beyond' ? ' beyond' : '') + '" data-v3-act="tier" data-v3-val="' + esc(t) + '" aria-pressed="' + (st.tier === t) + '">' +
        '<span class="v3-tier-top"><span class="v3-tier-name">' + esc(label(t)) + '</span>' +
          price(t) + '</span>' +
        '<span class="v3-tier-note">' + esc(t.charAt(0).toUpperCase() + t.slice(1)) + ' · ' + esc(note(t)) + (rate(t) && st.mode === 'per-sq' ? ' · ' + esc(rate(t)) : '') + '</span>' +
      '</button>').join('') +
      '<div class="v3-label">Pricing method</div>';
  }

  function paintTotal() {
    const src = document.getElementById('v2total');
    const out = $('.v3-bar-val');
    if (src && out) out.textContent = src.textContent || '$0';
  }

  // Roof or repair, decided once per open from what got loaded. The repair
  // presets set a minimum job charge and a small area (200 / 10 SF), so a
  // minimum charge, or a priced scope under 5 SQ, reads as a repair.
  // Anything else — including an empty estimate — starts as a full roof.
  const REPAIR_MAX_SQFT = 500;
  function inferKind() {
    const st = v2state();
    const area = Number(st.measurements && st.measurements.rawSqft) || 0;
    const scope = Array.isArray(st.scope) ? st.scope : [];
    if (Number(st.minJobCharge) > 0) ui.kind = 'repair';
    else if (scope.length && area > 0 && area < REPAIR_MAX_SQFT) ui.kind = 'repair';
    else ui.kind = 'roof';
  }

  // Started from a lead (2026-10-03): V2's open() calls onOpen BEFORE it
  // prefills the customer, so the wizard always opened on the Customer step.
  // On the first render after the open, a customer that arrived prefilled
  // (linked lead + name + address) skips that step. The lead's job type, when
  // it has one, sets Cash / Insurance through the real V2 toggle — that
  // choice lives on the skipped step.
  function customerPrefilled(st) {
    const c = (st && st.customer) || {};
    const leadId = st && (st.leadId || c.leadId);
    return !!(leadId && String(c.name || '').trim() && String(c.address || '').trim());
  }
  function leadJobMode(st) {
    const c = (st && st.customer) || {};
    const id = st && (st.leadId || c.leadId);
    if (!id) return '';
    let lead = null;
    try {
      const cur = window._leadDoc;
      lead = (cur && cur.id === id) ? cur
        : ((Array.isArray(window._leads) && window._leads.find((l) => l && l.id === id)) || null);
    } catch (_) { lead = null; }
    const jt = String((lead && lead.jobType) || '').trim().toLowerCase();
    return (jt === 'cash' || jt === 'insurance') ? jt : '';
  }
  function maybeSkipJob() {
    const st = v2state();
    if (ui.step !== 'job' || !customerPrefilled(st)) return false;
    const mode = leadJobMode(st);
    if (mode && st.jobMode !== mode) {
      const b = document.getElementById(mode === 'cash' ? 'v2jobCash' : 'v2jobInsurance');
      if (b) b.click(); // re-renders; skipJob is already cleared
    }
    const list = steps();
    const i = list.indexOf('job');
    if (i !== -1 && list[i + 1]) ui.step = list[i + 1];
    return true;
  }

  // ── hooks called by estimate-v2-ui.js ────────────────────────────────
  function onOpen(opts) {
    opts = opts || {};
    if (!build()) return;
    ui.on = true;
    ui.kind = 'roof';
    ui.inferKind = true;
    ui.skipJob = !opts.reopened;
    ui.more = false;
    ui.step = opts.reopened ? 'review' : 'job';
    closeSheet();
    paint(true);
  }

  function onRender() {
    if (!ui.modal || !ui.built) return;
    if (ui.skipJob) { ui.skipJob = false; if (maybeSkipJob()) ui.inferKind = true; }
    if (ui.inferKind) { ui.inferKind = false; inferKind(); paint(true); return; }
    // Full repaint: a Cash/Insurance switch adds or drops the claim step,
    // so the counter and the Next label must follow every render.
    if (ui.on) paint(false);
  }

  function injectCss() {
    if (document.getElementById('v3WizardCss')) return;
    const s = document.createElement('style');
    s.id = 'v3WizardCss';
    s.textContent = [
      '#estV2Modal .v3-head, #estV2Modal .v3-extra, #estV2Modal .v3-bar, #estV2Modal .v3-chips, #estV2Modal .v3-step-btn { display:none; }',
      '#estV2Modal .v3-stepper { display:contents; }',
      '#estV2Modal .v3-toggle { background:transparent; border:1px solid var(--br,#2a2f35); color:var(--t,#e8eaf0); border-radius:6px; min-height:44px; padding:0 14px; font:inherit; font-weight:700; font-size:13px; cursor:pointer; margin-left:auto; }',
      '#estV2Modal.v3-on .v2-mstep-bar, #estV2Modal.v3-on .v2-section { display:none !important; }',
      '#estV2Modal.v3-on .v2-body { display:block !important; overflow-y:auto !important; padding:12px 16px 24px !important; width:100%; max-width:560px; margin:0 auto; -webkit-overflow-scrolling:touch; }',
      '#estV2Modal.v3-on .v2-pane { display:block !important; overflow:visible !important; padding:0 !important; border:0 !important; background:transparent !important; max-height:none !important; }',
      '#estV2Modal.v3-on .v2-section-content { display:block !important; max-height:none !important; opacity:1 !important; pointer-events:auto !important; overflow:visible !important; margin:0 !important; }',
      '#estV2Modal.v3-on .v2-section-content > :not(.v3-cur), #estV2Modal.v3-on .v3-extra > :not(.v3-cur) { display:none !important; }',
      '#estV2Modal.v3-on .v3-head { display:block; position:sticky; top:-12px; z-index:2; background:var(--s,#111418); margin:-12px -16px 12px; padding:10px 16px 8px; border-bottom:1px solid var(--br,#2a2f35); }',
      '#estV2Modal.v3-on .v3-extra { display:block; }',
      '#estV2Modal .v3-jump { display:flex; align-items:center; gap:10px; width:100%; min-height:44px; background:transparent; border:0; color:var(--t,#e8eaf0); font:inherit; cursor:pointer; padding:0; text-align:left; }',
      '#estV2Modal .v3-count { font-size:12px; color:var(--m,#8b8e96); font-weight:700; letter-spacing:.06em; }',
      '#estV2Modal .v3-title { font-family:"Barlow Condensed",sans-serif; font-size:22px; font-weight:800; text-transform:uppercase; letter-spacing:.04em; flex:1; }',
      '#estV2Modal .v3-caret { color:var(--m,#8b8e96); }',
      '#estV2Modal .v3-dots { display:flex; gap:4px; margin-top:6px; }',
      '#estV2Modal .v3-dots i { flex:1; height:4px; border-radius:2px; background:var(--br,#2a2f35); }',
      '#estV2Modal .v3-dots i.done { background:var(--m,#8b8e96); }',
      '#estV2Modal .v3-dots i.cur { background:var(--orange,#BD5728); }',
      '#estV2Modal.v3-on .v3-bar { display:flex; align-items:stretch; gap:10px; flex-shrink:0; padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px)); background:var(--s,#111418); border-top:1px solid var(--br,#2a2f35); }',
      '#estV2Modal .v3-nav { min-height:56px; border-radius:10px; font:inherit; font-size:16px; font-weight:800; cursor:pointer; padding:0 16px; touch-action:manipulation; }',
      '#estV2Modal .v3-back { background:transparent; color:var(--t,#e8eaf0); border:1px solid var(--br,#2a2f35); }',
      '#estV2Modal .v3-back:disabled { opacity:.35; cursor:default; }',
      '#estV2Modal .v3-next { flex:1; background:var(--orange,#BD5728); color:var(--accent-fg,#fff); border:1px solid var(--orange,#BD5728); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
      '#estV2Modal .v3-next[hidden] { display:none; }',
      '#estV2Modal .v3-bar-total { display:flex; flex-direction:column; justify-content:center; align-items:flex-end; min-width:84px; color:var(--t,#e8eaf0); }',
      '#estV2Modal .v3-bar-lbl { font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--m,#8b8e96); }',
      '#estV2Modal .v3-bar-val { font-size:18px; font-weight:800; }',
      '#estV2Modal.v3-kind-repair .v3-bar-total { order:0; }',
      '#estV2Modal .v3-label { font-size:12px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--m,#8b8e96); margin:14px 0 8px; }',
      '#estV2Modal .v3-kind-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }',
      '#estV2Modal .v3-big { min-height:64px; border-radius:10px; border:1px solid var(--br,#2a2f35); background:var(--s2,#181c22); color:var(--t,#e8eaf0); font:inherit; font-size:16px; font-weight:800; cursor:pointer; }',
      '#estV2Modal .v3-big.active { border-color:var(--orange,#BD5728); box-shadow:inset 0 0 0 2px var(--orange,#BD5728); }',
      '#estV2Modal.v3-on .v2-tabs button { min-height:52px; font-size:15px; }',
      '#estV2Modal.v3-on .v2-field input, #estV2Modal.v3-on .v2-field select { min-height:52px; font-size:18px; }',
      '#estV2Modal.v3-on .v2-field > label { font-size:13px; }',
      '#estV2Modal.v3-on .v2-check { min-height:56px; font-size:15px; }',
      '#estV2Modal.v3-on .v3-stepper { display:flex; gap:8px; align-items:stretch; }',
      '#estV2Modal.v3-on .v3-stepper input { flex:1; text-align:center; }',
      '#estV2Modal.v3-on .v3-step-btn { display:block; width:64px; min-height:52px; border-radius:10px; border:1px solid var(--br,#2a2f35); background:var(--s2,#181c22); color:var(--t,#e8eaf0); font-size:26px; font-weight:800; cursor:pointer; touch-action:manipulation; }',
      '#estV2Modal.v3-on select.v3-chip-src { display:none !important; }',
      '#estV2Modal.v3-on .v3-chips { display:grid; grid-template-columns:repeat(auto-fill,minmax(96px,1fr)); gap:8px; }',
      '#estV2Modal .v3-chip { min-height:48px; border-radius:8px; border:1px solid var(--br,#2a2f35); background:var(--s2,#181c22); color:var(--t,#e8eaf0); font:inherit; font-size:14px; font-weight:700; cursor:pointer; padding:4px 6px; touch-action:manipulation; }',
      '#estV2Modal .v3-chip.active { border-color:var(--orange,#BD5728); background:var(--orange,#BD5728); color:var(--accent-fg,#fff); }',
      '#estV2Modal .v3-pkg { display:flex; flex-direction:column; gap:10px; }',
      '#estV2Modal .v3-tier { display:flex; flex-direction:column; gap:4px; min-height:72px; text-align:left; border-radius:12px; border:1px solid var(--br,#2a2f35); background:var(--s2,#181c22); color:var(--t,#e8eaf0); font:inherit; padding:12px 14px; cursor:pointer; touch-action:manipulation; }',
      '#estV2Modal .v3-tier.active { border-color:var(--orange,#BD5728); box-shadow:inset 0 0 0 2px var(--orange,#BD5728); }',
      '#estV2Modal .v3-tier-top { display:flex; justify-content:space-between; align-items:baseline; gap:10px; }',
      '#estV2Modal .v3-tier-name { font-size:18px; font-weight:800; text-transform:uppercase; letter-spacing:.04em; }',
      '#estV2Modal .v3-tier-price { font-size:20px; font-weight:800; }',
      '#estV2Modal .v3-photo-add { margin-bottom:14px; }',
      '#estV2Modal .v3-photo-add .v3-big { width:100%; }',
      '#estV2Modal .v3-photo-add .v3-big:disabled { opacity:.5; cursor:default; }',
      '#estV2Modal .v3-photo-msg { font-size:14px; color:var(--t,#e8eaf0); margin-top:8px; min-height:1em; }',
      '#estV2Modal .v3-draw-it { margin-bottom:14px; }',
      '#estV2Modal .v3-draw-it .v3-big { width:100%; }',
      '#estV2Modal .v3-draw-msg { font-size:14px; color:var(--t,#e8eaf0); margin-top:8px; min-height:1em; }',
      '#estV2Modal.v3-on #v2photosHint { font-size:14px !important; }',
      '#estV2Modal .v3-tier-price.v3-tier-pending { font-size:14px; font-weight:700; color:var(--m,#8b8e96); }',
      '#estV2Modal .v3-tier-note { font-size:13px; color:var(--m,#8b8e96); }',
      '#estV2Modal.v3-on .v2-preset-btns button { min-height:56px; font-size:14px; }',
      '#estV2Modal.v3-kind-roof.v3-on .v2-preset-btns [data-arg="small-repair"], #estV2Modal.v3-kind-roof.v3-on .v2-preset-btns [data-arg="shingle-patch"] { display:none; }',
      '#estV2Modal.v3-kind-repair.v3-on .v2-preset-btns button:not([data-arg="small-repair"]):not([data-arg="shingle-patch"]):not([data-action="open-job-templates"]) { display:none; }',
      '#estV2Modal.v3-on #v2items { max-height:none !important; }',
      '#estV2Modal.v3-on .v2-export-btns button, #estV2Modal.v3-on [data-v3~="finish"] .btn, #estV2Modal.v3-on #v2saveBtn, #estV2Modal.v3-on #v2signBtn { min-height:56px; font-size:15px; }',
      '#estV2Modal.v3-on .pane-setup { display:flex !important; flex-direction:column; }',
      '#estV2Modal.v3-on .pane-setup > .v3-first { order:-1; }',
      '#estV2Modal.v3-on #v2cats button { min-height:44px; padding:0 12px; font-size:13px; }',
      '#estV2Modal.v3-on #v2search { min-height:48px; font-size:16px; }',
      '#estV2Modal.v3-on #v2scopeList button { min-height:44px; min-width:44px; }',
      '#estV2Modal .v3-pkg-empty { font-size:14px; color:var(--t,#e8eaf0); margin-bottom:6px; }',
      '#estV2Modal .v3-pkg-empty .v3-kind-row { margin-top:8px; }',
      '#estV2Modal .v3-review-hint { font-size:13px; color:var(--m,#8b8e96); margin:0 0 10px; }',
      '#estV2Modal .v3-sheet { position:absolute; inset:0; z-index:5; background:rgba(0,0,0,.6); display:flex; align-items:flex-end; }',
      '#estV2Modal .v3-sheet[hidden] { display:none; }',
      '#estV2Modal .v3-sheet-card { width:100%; max-width:560px; margin:0 auto; max-height:80%; overflow-y:auto; background:var(--s,#111418); border-radius:16px 16px 0 0; padding:8px 16px calc(16px + env(safe-area-inset-bottom,0px)); }',
      '#estV2Modal .v3-sheet-hd { display:flex; justify-content:space-between; align-items:center; font-weight:800; color:var(--t,#e8eaf0); min-height:48px; }',
      '#estV2Modal .v3-sheet-x { min-width:44px; min-height:44px; background:transparent; border:0; color:var(--t,#e8eaf0); font-size:18px; cursor:pointer; }',
      '#estV2Modal .v3-sheet-row { display:flex; align-items:center; gap:12px; width:100%; min-height:52px; background:transparent; border:0; border-top:1px solid var(--br,#2a2f35); color:var(--t,#e8eaf0); font:inherit; font-size:16px; text-align:left; cursor:pointer; }',
      '#estV2Modal .v3-sheet-row .n { width:28px; height:28px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; background:var(--s2,#181c22); font-size:13px; font-weight:800; }',
      '#estV2Modal .v3-sheet-row.cur { color:var(--orange,#BD5728); font-weight:800; }',
      // Finish (2026-10-03): one primary, the rest under More.
      '#estV2Modal .v3-more { display:none; }',
      '#estV2Modal.v3-on .v3-more.v3-cur { display:flex; align-items:center; justify-content:center; width:100%; min-height:48px; margin:6px 0 10px; background:transparent; border:1px solid var(--br,#2a2f35); border-radius:10px; color:var(--t,#e8eaf0); font:inherit; font-size:15px; font-weight:700; cursor:pointer; }',
      '#estV2Modal.v3-on.v3-step-finish .pane-review { display:flex !important; flex-direction:column; }',
      '#estV2Modal.v3-on.v3-step-finish .pane-review > .v3-finish-primary { order:-1; }',
      '#estV2Modal.v3-on.v3-step-finish:not(.v3-more-open) [data-v3-more] { display:none !important; }',
      '#estV2Modal.v3-on [data-v3~="finish"] .v2-send-ho, #estV2Modal.v3-on .v2-send-ho { min-height:60px; font-size:17px; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  window.EstimateV3 = {
    onOpen,
    onRender,
    // Test seam.
    _test: { steps, get ui() { return ui; }, inferKind, ROOF_STEPS, REPAIR_STEPS, TAGS, customerPrefilled, maybeSkipJob, paintPackage, TIER_NOTES },
  };
})();
