/**
 * customer-numbers.js — the customer page's "Numbers" panel (2026-10-04).
 *
 * The fields Reports and the Sunday review need, fixable on the job itself:
 *   - Sold package (soldTier) for a won / signed job — a manual pick for past
 *     jobs; the server records it at signing for new ones (job-spine.js).
 *   - Close date (closedAt) — flagged when it is really the created date,
 *     editable to the day the contract was signed.
 *   - Why it was lost — a lost job with no reason opens the required picker.
 *   - The storm it came in on (stormId), when tagged.
 * Hidden on an open lead with nothing to show. Mounts into #numbersPanel
 * (customer.html). Rules: numbers-logic.js. CSP-safe: delegated listeners,
 * classes only (css/numbers.css).
 *
 * numbers-logic.js loads on demand here (boot-weight lane, 2026-11-08): it was
 * an eager tag on every customer card, and an open lead (most cards) paints
 * nothing from it. mayShow() below is its sale / lost test, copied (the rules
 * are not loaded yet when the panel decides), and the rules are fetched
 * (ScriptLoader.load) only for a lead the panel shows. "Pick a reason" waits
 * for them before the picker (lost-reason-picker.js reads them). A failed
 * fetch says so in the panel; ScriptLoader drops the dead tag, so the next tap
 * fetches again. tests/lazy-customer-numbers-logic-2026-11-08.test.js keeps
 * the copy identical to numbers-logic.js.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDCustomerNumbers) return;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const N = () => window.NBDNumbers;
  function lead() { return window._currentLead || window._leadDoc || null; }
  function toast(m, t) { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); }

  // ── numbers-logic.js's sale / lost test, copied ─────────────────────────
  const WON_KEYS = ['closed', 'install_complete', 'final_photos', 'final_payment', 'deductible_collected', 'collections', 'warranty_claim'];
  const JOB_KEYS = ['job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered', 'crew_scheduled', 'install_in_progress'];
  const VALID_ROLES = ['new', 'active', 'job', 'won', 'lost'];
  const LEGACY = {
    'new': 'new', 'new lead': 'new', 'inspected': 'inspected', 'estimate sent': 'estimate_submitted',
    'approved': 'contract_signed', 'in progress': 'install_in_progress', 'complete': 'closed', 'lost': 'lost',
    'contacted': 'contacted', 'negotiating': 'negotiating', 'closed won': 'closed', 'closed lost': 'lost',
    'won': 'closed', 'closed_won': 'closed', 'closed-won': 'closed'
  };
  function canonStage(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return 'new';
    const lower = s.toLowerCase();
    if (LEGACY[lower]) return LEGACY[lower];
    return lower.replace(/[\s-]+/g, '_');
  }
  function stageKeyOf(l) { return l._stageKey ? canonStage(l._stageKey) : canonStage(l.stage); }
  function roleOf(l) {
    const p = l._stageRole || l.stageRole;
    if (typeof p === 'string' && VALID_ROLES.indexOf(p) !== -1) return p;
    const k = stageKeyOf(l);
    if (typeof window.stageRole === 'function') { try { const r = window.stageRole(k); if (VALID_ROLES.indexOf(r) !== -1) return r; } catch (_) { /* fall through */ } }
    if (WON_KEYS.indexOf(k) !== -1) return 'won';
    if (JOB_KEYS.indexOf(k) !== -1) return 'job';
    if (k === 'lost') return 'lost';
    return k === 'new' ? 'new' : 'active';
  }
  /** Does the panel show for this lead? isSale || isLostLead || stormId, without the rules. */
  function mayShow(l) {
    if (!l) return false;
    if (l.stormId) return true;
    const r = roleOf(l);
    return r === 'won' || r === 'job' || r === 'lost' || stageKeyOf(l) === 'contract_signed';
  }

  // Same file and ?v= as dashboard.html's tag, so one cache key.
  const RULES_SRC = 'js/numbers-logic.js?v=3';
  let rulesLoading = null;
  function canLoad() { return !!(window.ScriptLoader && typeof window.ScriptLoader.load === 'function'); }
  /** Load numbers-logic.js once. Resolves true when window.NBDNumbers is there; never rejects. */
  function ensureRules() {
    if (N()) return Promise.resolve(true);
    if (rulesLoading) return rulesLoading;
    if (!canLoad()) return Promise.resolve(false);
    let p;
    try { p = Promise.resolve(window.ScriptLoader.load(RULES_SRC)); } catch (_) { p = Promise.resolve(); }
    const done = () => { rulesLoading = null; return !!N(); };
    rulesLoading = p.then(done, done);
    return rulesLoading;
  }

  /** What the panel shows for a lead (pure). */
  function viewModel(l) {
    const Nn = N();
    if (!Nn || !l) return null;
    const sale = Nn.isSale(l);
    const lost = Nn.isLostLead(l);
    if (!sale && !lost && !l.stormId) return null;
    const closedMs = Nn.toMs(l.closedAt);
    return {
      sale, lost,
      soldTier: Nn.soldTierOf(l),
      closedYmd: closedMs ? Nn.ymd(closedMs) : '',
      closeSuspect: sale && Nn.needsCloseDate(l),
      lostKey: lost ? Nn.lostReasonKeyOf(l) : null,
      lostText: lost ? (l.lostReason || '') : '',
      storm: l.stormId ? { date: l.stormDate || String(l.stormId).replace(/^storm-/, ''), place: l.stormPlace || '' } : null,
    };
  }

  function render() {
    const host = document.getElementById('numbersPanel');
    if (!host) return;
    const Nn = N();
    const l = lead();
    if (!Nn) {
      // Rules not loaded: nothing to show (or no loader) → hidden, as before.
      if (!mayShow(l) || !canLoad()) { host.innerHTML = ''; host.classList.remove('panel'); return; }
      ensureRules().then((ready) => {
        if (ready) { render(); return; }
        host.classList.add('panel');
        host.innerHTML = '<div class="panel-title">Numbers</div>' +
          '<button type="button" class="cn-btn cn-btn-ghost" data-cn="retry">Could not load the numbers — check your connection and tap again</button>';
      });
      return;
    }
    const vm = viewModel(l);
    if (!vm) { host.innerHTML = ''; host.classList.remove('panel'); return; }
    host.classList.add('panel');
    let html = '<div class="panel-title">Numbers</div><div class="cn-grid">';
    if (vm.sale) {
      html += '<label class="cn-item"><span class="cn-label">Sold package</span>' +
        '<select class="cn-sel" data-cn="tier" aria-label="Sold package">' +
          '<option value="">' + (vm.soldTier ? '— clear —' : 'Not recorded — pick') + '</option>' +
          Nn.TIERS.map((t) => '<option value="' + t + '"' + (vm.soldTier === t ? ' selected' : '') + '>' + esc(Nn.TIER_LABELS[t]) + '</option>').join('') +
        '</select></label>';
      html += '<div class="cn-item"><span class="cn-label">Close date' + (vm.closeSuspect ? ' <span class="cn-flag">check — matches the created date</span>' : '') + '</span>' +
        '<span class="cn-row"><input type="date" class="cn-date" data-cn="close" aria-label="Close date" value="' + esc(vm.closedYmd) + '" max="' + Nn.ymd(Date.now()) + '">' +
        '<button type="button" class="cn-btn" data-cn="save-close">Save</button></span></div>';
    }
    if (vm.lost) {
      html += '<div class="cn-item"><span class="cn-label">Why it was lost</span>' +
        (vm.lostKey ? '<span class="cn-val">' + esc(vm.lostText || Nn.lostReasonLabel(vm.lostKey)) + '</span> <button type="button" class="cn-btn cn-btn-ghost" data-cn="lost">Change</button>'
          : '<button type="button" class="cn-btn cn-btn-warn" data-cn="lost">Pick a reason</button>') + '</div>';
    }
    if (vm.storm) {
      html += '<div class="cn-item"><span class="cn-label">Storm</span><span class="cn-val">⛈️ ' + esc(vm.storm.date) + (vm.storm.place ? ' · ' + esc(vm.storm.place) : '') + '</span></div>';
    }
    host.innerHTML = html + '</div>';
  }

  async function save(patch, okMsg) {
    const l = lead();
    if (!l || !window._customerId || !window.updateDoc || !window.doc) return false;
    if (window.NBDRole && !window.NBDRole.guard()) return false;
    try {
      await window.updateDoc(window.doc(window.db, 'leads', window._customerId), Object.assign({}, patch, { updatedAt: window.serverTimestamp() }));
      [window._currentLead, window._leadDoc].forEach((o) => { if (o) Object.assign(o, patch); });
      toast(okMsg, 'success');
      render();
      return true;
    } catch (e) {
      toast('Could not save: ' + ((e && (e.code || e.message)) || 'error'), 'error');
      return false;
    }
  }

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.closest || !t.closest('#numbersPanel') || t.dataset.cn !== 'tier') return;
    const v = t.value;
    save(v ? { soldTier: v, soldTierSource: 'manual', soldTierAt: new Date() } : { soldTier: null, soldTierSource: null }, v ? 'Package saved ✓' : 'Package cleared');
  });
  document.addEventListener('click', async (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#numbersPanel [data-cn]') : null;
    if (!b) return;
    if (b.dataset.cn === 'retry') { render(); return; }
    if (b.dataset.cn === 'save-close') {
      const inp = document.querySelector('#numbersPanel [data-cn="close"]');
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String((inp && inp.value) || ''));
      if (!m) { toast('Pick the date the contract was signed', 'error'); return; }
      const at = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
      if (at.getTime() > Date.now()) { toast('A close date cannot be in the future', 'error'); return; }
      save({ closedAt: at, closedAtSource: 'manual' }, 'Close date saved ✓');
    } else if (b.dataset.cn === 'lost') {
      if (!window.NBDLostReason) { toast('Reload the page and try again', 'error'); return; }
      // The picker reads the rules (reason list, validation): wait for them.
      if (!(await ensureRules())) { toast('Could not load the lost-reason picker — check your connection and tap again', 'error'); return; }
      const choice = await window.NBDLostReason.prompt(lead());
      if (choice) save(choice.fields, 'Reason saved ✓');
    }
  });
  window.addEventListener('nbd:data-refreshed', () => { try { render(); } catch (_) { /* next refresh */ } });
  // First paint: the lead loads before estimates fire nbd:data-refreshed.
  let tries = 0;
  const t = setInterval(() => { if (lead() || ++tries > 40) { clearInterval(t); render(); } }, 500);

  const api = { viewModel, render, mayShow };
  window.NBDCustomerNumbers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
