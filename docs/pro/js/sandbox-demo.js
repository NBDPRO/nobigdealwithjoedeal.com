// sandbox-demo.js — /pro/sandbox.html interaction engine.
// Pure local state: no Firebase, no network, no persistence. CSP-safe
// (script-src 'self'): every interaction routes through data-action
// delegates — no inline handlers anywhere.
(function () {
  'use strict';

  // Stage sets mirror real pipeline stage names (subset of the 31 built-ins).
  const VIEWS = {
    insurance: ['New Lead', 'Inspected', 'Claim Filed', 'Adjuster Mtg', 'Contract Signed', 'Crew Scheduled'],
    cash: ['New Lead', 'Contacted', 'Est. Sent', 'Contract Signed', 'Installing', 'Final Payment'],
  };

  const LEADS = [
    { id: 1, name: 'Marcus Williams', addr: '1248 Oak Ave', trade: 'Roof', value: 14200, heat: 82, phone: '(555) 014-2210', ins: 2, cash: 1,
      notes: 'Hail hit 6/28. Carrier: State Ins. Adjuster meet pending.',
      comms: [['SMS · IN', '"Adjuster said Thursday works — does that work for you?"'], ['EMAIL · OUT', 'Claim packet + photo report sent'], ['CALL', 'Walked the roof, 14 hits marked on the north slope']] },
    { id: 2, name: 'Sandra Kim', addr: '77 Birchwood Ct', trade: 'Roof + Gutters', value: 18400, heat: 91, phone: '(555) 019-8837', ins: 3, cash: 2,
      notes: 'Full replacement + 6" gutters. Wants the Better tier.',
      comms: [['SMS · OUT', '"Tuesday works on my end, Sandra. I\'ll confirm the exact time Monday."'], ['PORTAL', 'Viewed estimate 3× yesterday'], ['EMAIL · OUT', 'Good/Better/Best estimate delivered']] },
    { id: 3, name: 'Dave Torres', addr: '410 Fernhill Dr', trade: 'Full Exterior', value: 23800, heat: 77, phone: '(555) 012-4471', ins: 4, cash: 3,
      notes: 'Approved! Materials ordered. Crew slot: week of the 28th.',
      comms: [['EMAIL · IN', 'Carrier approval letter received'], ['SMS · OUT', 'Deposit link sent — paid same day']] },
    { id: 4, name: 'Alicia Grant', addr: '9 Sycamore Ln', trade: 'Roof', value: 11600, heat: 64, phone: '(555) 016-3390', ins: 0, cash: 0,
      notes: 'Door knock — storm damage visible from the street.',
      comms: [['D2D', 'Knock logged: Interested. Photos of lifted shingles taken']] },
    { id: 5, name: 'Rob Chen', addr: '3302 Prairie Rd', trade: 'Siding', value: 9400, heat: 58, phone: '(555) 013-7726', ins: 1, cash: 1,
      notes: 'Wind damage on the west face. Inspection Friday 9am.',
      comms: [['SMS · OUT', 'Inspection confirmation + calendar link'], ['CALL', 'Prefers morning appointments']] },
    { id: 6, name: 'Maria Lopez', addr: '128 Harvest Way', trade: 'Roof', value: 15750, heat: 88, phone: '(555) 017-5518', ins: 3, cash: 2,
      notes: 'Supplement submitted for decking — carrier reviewing.',
      comms: [['EMAIL · OUT', 'Supplement w/ photo justification submitted'], ['PORTAL', 'Signed contract via phone — 40 seconds']] },
    { id: 7, name: 'James Porter', addr: '55 Keystone Blvd', trade: 'Roof + Skylights', value: 19900, heat: 71, phone: '(555) 018-9982', ins: 1, cash: 1,
      notes: 'Two skylights to replace with the roof. Waiting on claim #.',
      comms: [['SMS · IN', '"Filed the claim this morning, ref #H-88213"']] },
    { id: 8, name: 'Tina Brooks', addr: '806 Cedar Ridge', trade: 'Gutters', value: 4200, heat: 45, phone: '(555) 011-6604', ins: 5, cash: 4,
      notes: 'Gutter-only job. Scheduled behind the Torres install.',
      comms: [['EMAIL · OUT', 'Install date confirmation']] },
    { id: 9, name: 'Hank Foster', addr: '2117 Millbrook Rd', trade: 'Roof', value: 13100, heat: 69, phone: '(555) 015-2288', ins: 2, cash: 2,
      notes: 'Claim filed. Adjuster assigned — waiting on the meet date.',
      comms: [['CALL', 'Carrier confirmed coverage A'], ['SMS · OUT', 'What-to-expect-at-adjuster-meeting text']] },
    { id: 10, name: 'Priya Nair', addr: '64 Landing Ct', trade: 'Roof', value: 16800, heat: 85, phone: '(555) 010-4433', ins: 0, cash: 0,
      notes: 'Referral from Sandra Kim ($100 reward code tracked).',
      comms: [['SMS · IN', '"Sandra said you\'re the one to call — our roof is 19 years old"']] },
  ];

  const TIERS = {
    good: { label: 'Good', total: 8450 },
    better: { label: 'Better', total: 12300 },
    best: { label: 'Best', total: 15900 },
  };

  let view = 'insurance';
  let moves = 0;
  let dragId = null;

  const $ = (sel) => document.querySelector(sel);
  const money = (n) => '$' + n.toLocaleString('en-US');

  function stageOf(lead) { return view === 'insurance' ? lead.ins : lead.cash; }
  function setStage(lead, idx) { if (view === 'insurance') lead.ins = idx; else lead.cash = idx; }

  function render() {
    const stages = VIEWS[view];
    const board = $('#board');
    board.innerHTML = stages.map(function (stage, i) {
      const cards = LEADS.filter(function (l) { return stageOf(l) === i; });
      const total = cards.reduce(function (s, l) { return s + l.value; }, 0);
      return '<div class="sb-col" data-col="' + i + '">' +
        '<div class="sb-col-head"><div class="sb-col-title">' + stage + '</div>' +
        '<div class="sb-col-meta">' + cards.length + ' lead' + (cards.length === 1 ? '' : 's') + ' · ' + money(total) + '</div></div>' +
        '<div class="sb-col-cards" data-col="' + i + '">' +
        cards.map(function (l) {
          return '<div class="sb-card" draggable="true" data-lead="' + l.id + '">' +
            '<div class="sb-card-name">' + l.name + '</div>' +
            '<div class="sb-card-sub">' + l.trade + ' · ' + l.addr + '</div>' +
            '<div class="sb-card-row"><span class="sb-card-val">' + money(l.value) + '</span>' +
            '<span class="sb-heat">' + l.heat + '°</span>' +
            '<span class="sb-card-arrows">' +
            '<button type="button" class="sb-arrow" data-action="prev" data-lead="' + l.id + '" aria-label="Previous stage">‹</button>' +
            '<button type="button" class="sb-arrow" data-action="next" data-lead="' + l.id + '" aria-label="Next stage">›</button>' +
            '</span></div></div>';
        }).join('') +
        '</div></div>';
    }).join('');
    $('#moveCounter').textContent = moves ? moves + ' move' + (moves === 1 ? '' : 's') + ' made — nothing saved, promise' : '';
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }

  function move(leadId, delta) {
    const lead = LEADS.find(function (l) { return l.id === leadId; });
    if (!lead) return;
    const max = VIEWS[view].length - 1;
    const next = Math.min(max, Math.max(0, stageOf(lead) + delta));
    if (next === stageOf(lead)) return;
    setStage(lead, next);
    moves++;
    render();
    toast(lead.name.split(' ')[0] + ' → ' + VIEWS[view][next] + ' ✓');
  }

  function moveTo(leadId, col) {
    const lead = LEADS.find(function (l) { return l.id === leadId; });
    if (!lead || stageOf(lead) === col) return;
    setStage(lead, col);
    moves++;
    render();
    toast(lead.name.split(' ')[0] + ' → ' + VIEWS[view][col] + ' ✓');
  }

  function openDrawer(leadId) {
    const l = LEADS.find(function (x) { return x.id === leadId; });
    if (!l) return;
    $('#drawer').innerHTML =
      '<button type="button" class="sb-drawer-close" data-action="drawer-close" aria-label="Close">✕</button>' +
      '<h3>' + l.name + '</h3>' +
      '<div class="sub">' + l.trade + ' · ' + l.addr + '</div>' +
      '<div class="sb-kv"><span class="k">Stage</span><span>' + VIEWS[view][stageOf(l)] + '</span></div>' +
      '<div class="sb-kv"><span class="k">Job value</span><span>' + money(l.value) + '</span></div>' +
      '<div class="sb-kv"><span class="k">Heat score</span><span>' + l.heat + ' / 100</span></div>' +
      '<div class="sb-kv"><span class="k">Phone</span><span>' + l.phone + '</span></div>' +
      '<h5>Notes</h5><div class="sb-log">' + l.notes + '</div>' +
      '<h5>Communication log</h5>' +
      l.comms.map(function (c) { return '<div class="sb-log"><div class="who">' + c[0] + '</div>' + c[1] + '</div>'; }).join('') +
      '<h5>In the real product</h5><div class="sb-log">This drawer also holds tasks, photos, estimates, invoices, documents, and the AI texting draft queue for this lead.</div>';
    $('#drawerWrap').classList.add('open');
  }

  function selectTier(key) {
    const t = TIERS[key];
    document.querySelectorAll('.sb-tier').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-tier') === key);
    });
    // The deposit comes from the real rule (deposit-rule.js, loaded first on
    // sandbox.html) — this demo hard-coded "50% deposit", which only matched
    // because every sample tier is a cash job over the no-deposit threshold.
    const R = window.NBDDepositRule;
    const plan = R ? R.compute({ total: t.total, mode: 'cash' }) : null;
    const depText = plan ? (plan.label + ' ' + plan.valueText) : '';
    $('#estSummary').innerHTML = 'Selected: <strong>' + t.label + ' — ' + money(t.total) + '</strong>' + (depText ? ' · ' + depText : '') +
      ' · In the real builder this prices itself from measurements, pitch, and waste — and turns into a signed contract and an invoice without retyping anything.';
  }

  // ONE click delegate for everything (CSP-safe, mirrors app conventions).
  document.addEventListener('click', function (e) {
    const t = e.target.closest('[data-action]');
    if (t) {
      const action = t.getAttribute('data-action');
      if (action === 'theme') {
        document.documentElement.setAttribute('data-theme', t.getAttribute('data-theme'));
        document.querySelectorAll('.sb-theme-btn').forEach(function (b) { b.classList.toggle('active', b === t); });
        return;
      }
      if (action === 'view') {
        view = t.getAttribute('data-view');
        document.querySelectorAll('.sb-view-btn').forEach(function (b) { b.classList.toggle('active', b === t); });
        render();
        return;
      }
      if (action === 'prev') { move(Number(t.getAttribute('data-lead')), -1); return; }
      if (action === 'next') { move(Number(t.getAttribute('data-lead')), 1); return; }
      if (action === 'tier') { selectTier(t.getAttribute('data-tier')); return; }
      if (action === 'drawer-close') { $('#drawerWrap').classList.remove('open'); return; }
      if (action === 'drawer-dismiss' && e.target === t) { $('#drawerWrap').classList.remove('open'); return; }
    }
    const card = e.target.closest('.sb-card');
    if (card) openDrawer(Number(card.getAttribute('data-lead')));
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $('#drawerWrap').classList.remove('open');
    // Tier cards are focusable buttons-by-role; Enter/Space activates.
    if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute && e.target.getAttribute('data-action') === 'tier') {
      e.preventDefault();
      selectTier(e.target.getAttribute('data-tier'));
    }
  });

  // HTML5 drag & drop (desktop). Mobile users get the per-card arrows,
  // which is also how the real kanban offers one-tap moves.
  document.addEventListener('dragstart', function (e) {
    const card = e.target.closest('.sb-card');
    if (!card) return;
    dragId = Number(card.getAttribute('data-lead'));
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(dragId)); } catch (err) { /* IE-era quirk; harmless */ }
  });
  document.addEventListener('dragend', function () {
    dragId = null;
    document.querySelectorAll('.sb-card.dragging').forEach(function (c) { c.classList.remove('dragging'); });
    document.querySelectorAll('.sb-col.drag-over').forEach(function (c) { c.classList.remove('drag-over'); });
  });
  document.addEventListener('dragover', function (e) {
    const col = e.target.closest('.sb-col');
    if (!col || dragId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.sb-col.drag-over').forEach(function (c) { if (c !== col) c.classList.remove('drag-over'); });
    col.classList.add('drag-over');
  });
  document.addEventListener('drop', function (e) {
    const col = e.target.closest('.sb-col');
    if (!col || dragId === null) return;
    e.preventDefault();
    moveTo(dragId, Number(col.getAttribute('data-col')));
    dragId = null;
  });

  render();
  selectTier('better');
})();
