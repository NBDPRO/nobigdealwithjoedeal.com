/**
 * sub-payments.js — the Sub payments sorter (flag `subPaymentsSorter`, 2026-10-19).
 *
 * Jo: 20 of 21 finished jobs read about 100% margin because the pay to his
 * independent subs never reached the CRM, and checks / Zelle / cash for subs sit
 * in the books with no job. Same idea as the receipt sorter, two flags:
 *
 *   A. "This JOB has no sub / labor cost"  — the job cost auditor's queue
 *      (job-cost-audit.js noSubQueue), with a one-thumb entry: pick the sub or
 *      add a new one right here, amount, date, how it was paid, what it was for,
 *      and a photo of the check / Zelle screenshot / receipt.
 *   B. "This PAYMENT has no job" — a queue of sub payments with no job; one tap
 *      picks the job (likely jobs suggested, never auto-assigned) or answers
 *      "Not a job cost" (remembered on the row).
 *   + a per-sub view: total paid, by job, by month, payments with no proof.
 *
 * NO NEW COST STORE. A payment is an /expenses doc exactly like the cash payout
 * log and the auditor write (category subcontractor, costType direct,
 * source 'sub_payments', subId, leadId / jobId, paymentMethod, note, editLog max
 * 25). Proof photos are EXIF-stripped copies stored under receipts/{uid}/
 * sub-proofs/ (the existing receipt rules: owner-only read, 25MB, image / PDF);
 * the doc keeps only the paths, never a URL.
 *
 * Crews are independent subcontractors: nothing here says employee or payroll.
 * Money is integer cents. Flag off = no button, no panel, this file does nothing.
 * Viewer: read only. Edit / void only your own rows (the expense rules).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const FLAG = 'subPaymentsSorter';
  const WRITE_ROLES = ['', 'admin', 'company_admin', 'manager'];
  const READ_ROLES = WRITE_ROLES.concat(['viewer']);
  const LG = () => w.NBDSubPaymentsLogic;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  function enabled() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)) && !!LG(); }
  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || null; }
  function tenant() { return claims().companyId || uid(); }
  function canWrite() { return !!uid() && WRITE_ROLES.indexOf(claims().role || '') !== -1; }
  function canRead() { return !!uid() && READ_ROLES.indexOf(claims().role || '') !== -1; }
  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    if (typeof v.toDate === 'function') return v.toDate();
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  const dateText = (v) => { const d = toDate(v); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'no date'; };
  function monthLabel(k) {
    const d = new Date(k + '-01T12:00:00');
    return isNaN(d.getTime()) ? 'Undated' : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }
  const METHOD_LABEL = { cash: 'Cash', check: 'Check', zelle: 'Zelle', other: 'Other' };

  let S = null;
  // { tab:'jobs'|'pay'|'subs', view:'main'|'log'|'sub', expenses[], roster[], leads[], noSub:{rows,hasSubByLead}|null, noSubErr,
  //   f:{scope,query,method,proof,sub,sort,subq}, pick:rowId|null, jobq:'', form:{}, subKey, dismissed{}, busy, changed }
  let noSubCount = null; // last known count, for the Expenses panel

  const list = () => (w.Expenses && typeof w.Expenses.list === 'function') ? w.Expenses.list() : [];
  const leadById = (id) => (w._leads || []).find((l) => l && l.id === id) || null;
  function jobIdFor(leadId) {
    const l = leadById(leadId);
    const j = l && l.activeJobId;
    return typeof j === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(j) ? j : null;
  }
  function jobText(leadId) { const l = leadById(leadId); return l ? ((l.customerId ? l.customerId + ' · ' : '') + LG().leadName(l)) : 'Job removed'; }

  async function loadRoster() {
    const out = [];
    try {
      if (w.db && w.getDocs && w.collection && tenant()) {
        const snap = await w.getDocs(w.collection(w.db, 'companies', tenant(), 'subs'));
        snap.forEach((d) => {
          const s = d.data() || {};
          if (s.active !== false && s.name) out.push({ id: d.id, name: String(s.name), trade: String(s.trade || ''), phone: String(s.phone || ''), aliases: Array.isArray(s.aliases) ? s.aliases.filter((a) => typeof a === 'string') : [] });
        });
      }
    } catch (e) { console.warn('[sub-payments] sub roster not loaded', e && e.code); }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function base() {
    const roster = await loadRoster();
    return {
      tab: 'jobs', view: 'main', expenses: list().filter((e) => e && e.deleted !== true), roster,
      leads: (w._leads || []).filter((l) => l && l.id && !l.deleted && !l.isProspect),
      noSub: null, noSubErr: '', f: { scope: 'nojob', query: '', method: 'all', proof: 'all', sub: 'all', sort: 'newest', subq: '' },
      pick: null, jobq: '', voidId: null, voidNote: '', form: null, subKey: null, dismissed: {}, busy: false, changed: false, editSub: null,
    };
  }

  async function loadNoSub() {
    const A = w.NBDJobCostAuditor;
    if (!A || typeof A.noSubQueue !== 'function') { S.noSubErr = 'The job cost auditor is not loaded.'; return; }
    try {
      const r = await A.noSubQueue();
      if (!S) return;
      if (!r) { S.noSub = null; S.noSubErr = 'Could not load the jobs list (the collected money did not load). Nothing was changed.'; return; }
      S.noSub = r; S.noSubErr = '';
      noSubCount = r.rows.length;
    } catch (e) { console.warn('[sub-payments] jobs list failed', e && e.code); if (S) S.noSubErr = 'Could not load the jobs list.'; }
  }

  async function open(tab, scope, proof) {
    if (!enabled() || !canRead()) return;
    S = await base();
    S.tab = tab || 'jobs';
    if (scope) S.f.scope = scope;
    if (proof) S.f.proof = proof;
    render();
    if (canWrite()) { await loadNoSub(); if (S) render(); }
  }

  // ── pieces ──────────────────────────────────────────────────────────────
  function logic() { return LG(); }
  function payments() { return logic().paymentsOf(S.expenses); }

  function proofLine(e) {
    const n = logic().proofCount(e);
    if (!n) return '<span class="sp-flag">No proof</span>';
    return n + ' proof' + (n === 1 ? '' : 's') + PP().thumbsHtml(proofPathsOf(e));
  }

  function cardHtml(e) {
    const mine = canWrite() && e.userId === uid();
    const needs = logic().needsJob(e);
    const overhead = e.notJobCost === true;
    let job;
    if (e.leadId) job = '<button type="button" class="sp-link" data-sp-action="job-money" data-sp-job="' + esc(e.leadId) + '">' + esc(jobText(e.leadId)) + '</button>';
    else if (overhead) job = '<span class="sp-tag">Not a job cost</span>';
    else job = '<span class="sp-flag">No job</span>';
    let acts = '';
    if (mine) {
      if (needs) acts += '<button type="button" class="sp-btn sp-primary" data-sp-action="pick" data-sp-id="' + esc(e.id) + '">Pick job</button><button type="button" class="sp-btn" data-sp-action="overhead" data-sp-id="' + esc(e.id) + '">Not a job cost</button>';
      else if (overhead) acts += '<button type="button" class="sp-btn" data-sp-action="undo-overhead" data-sp-id="' + esc(e.id) + '">Put back as a job cost</button>';
      else acts += '<button type="button" class="sp-btn" data-sp-action="pick" data-sp-id="' + esc(e.id) + '">Change job</button>';
      acts += '<button type="button" class="sp-btn" data-sp-action="add-proof" data-sp-id="' + esc(e.id) + '">Add photo</button>' +
        '<button type="button" class="sp-btn" data-sp-action="void-ask" data-sp-id="' + esc(e.id) + '">Void</button>';
    } else if (canWrite()) acts = '<span class="sp-sub">Logged by someone else: fix it in Expenses</span>';
    let h = '<article class="sp-card"><div class="sp-card-top"><b class="sp-payee">' + esc(e.supplier || 'Unknown') + '</b><b>' + money(logic().centsOf(e)) + '</b></div>' +
      '<div class="sp-card-sub">' + esc(dateText(e.date)) + ' · ' + esc(METHOD_LABEL[e.paymentMethod] || 'Cash') + ' · ' + job + '</div>' +
      (e.note ? '<div class="sp-note">' + esc(e.note) + '</div>' : '') +
      '<div class="sp-card-sub">' + proofLine(e) + '</div>' + (acts ? '<div class="sp-act">' + acts + '</div>' : '');
    if (S.pick === e.id) h += pickHtml(e);
    if (S.voidId === e.id) {
      h += '<div class="sp-pick"><label class="sp-lab" for="spVoidNote">Why void it? (required. The row is kept with your note.)</label>' +
        '<input id="spVoidNote" class="sp-in" maxlength="300" autocomplete="off" data-sp-f="voidnote" value="' + esc(S.voidNote) + '">' +
        '<div class="sp-err" id="spErr" role="alert"></div><div class="sp-act"><button type="button" class="sp-btn sp-primary" data-sp-action="void-go" data-sp-id="' + esc(e.id) + '">Void this payment</button>' +
        '<button type="button" class="sp-btn" data-sp-action="void-cancel">Cancel</button></div></div>';
    }
    return h + '</article>';
  }

  function pickHtml(e) {
    const L = logic();
    const sug = L.suggestJobs(e, S.leads, { roster: S.roster, payments: S.expenses, hasSubByLead: (S.noSub && S.noSub.hasSubByLead) || hasSubMap() });
    const btn = (id, name, sub) => '<button type="button" class="sp-job" data-sp-action="assign" data-sp-id="' + esc(e.id) + '" data-sp-job="' + esc(id) + '"><b>' + esc(name) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '') + '</button>';
    let h = '<div class="sp-pick"><div class="sp-lab">Likely jobs</div>' +
      (sug.length ? sug.map((s) => btn(s.leadId, s.name, s.reasons.join(' · '))).join('') : '<div class="sp-sub">No clear match by date or by this sub\'s past jobs. Search below.</div>') +
      '<label class="sp-lab" for="spJobQ">Search by customer or address</label>' +
      '<input id="spJobQ" class="sp-in" type="search" autocomplete="off" data-sp-f="jobq" value="' + esc(S.jobq) + '">' +
      '<div id="spJobRes">' + pickResHtml(e.id) + '</div>' +
      '<button type="button" class="sp-btn" data-sp-action="pick-close">Cancel</button></div>';
    return h;
  }
  function pickResHtml(rowId) {
    if (!S.jobq) return '';
    const res = logic().searchJobs(S.leads, S.jobq, 8);
    return res.length ? res.map((r) => '<button type="button" class="sp-job" data-sp-action="assign" data-sp-id="' + esc(rowId) + '" data-sp-job="' + esc(r.leadId) + '"><b>' + esc(r.name) + '</b><span>' + esc(r.address) + '</span></button>').join('') : '<div class="sp-sub">No job matches that.</div>';
  }
  function hasSubMap() {
    const m = {};
    payments().forEach((e) => { if (e.leadId) m[e.leadId] = true; });
    return m;
  }

  // ── tabs ────────────────────────────────────────────────────────────────
  function countersNow() { return logic().counters(S.expenses, S.noSub ? S.noSub.rows.length : noSubCount); }

  function tabsHtml() {
    const c = countersNow();
    const tab = (k, label, n) => '<button type="button" class="sp-chip" data-sp-action="tab" data-sp-tab="' + k + '" aria-pressed="' + (S.tab === k) + '">' + esc(label) + (n == null ? '' : ' <b>' + n + '</b>') + '</button>';
    return '<div class="sp-chips" role="group" aria-label="Sub payments views">' + (canWrite() ? tab('jobs', 'Jobs with no sub', c.jobsNoSub) : '') + tab('pay', 'Payments', c.paymentsNoJob) + tab('subs', 'By sub', null) + '</div>';
  }

  function jobsTabHtml() {
    if (!canWrite()) return '<div class="sp-empty">Only owners and managers can log sub payments.</div>';
    if (S.noSubErr) return '<div class="sp-warn" role="status">' + esc(S.noSubErr) + '</div>';
    if (!S.noSub) return '<div class="sp-empty">Checking your jobs…</div>';
    let h = '<p class="sp-lede"><b>' + S.noSub.rows.length + '</b> job' + (S.noSub.rows.length === 1 ? '' : 's') + ' with no sub or labor cost. Each of these reads a margin that is too good until the pay to the sub is logged.</p>' +
      '<input class="sp-in" type="search" placeholder="Search by customer" aria-label="Search jobs" autocomplete="off" data-sp-f="query" value="' + esc(S.f.query) + '">';
    return h + '<div id="spRows">' + jobsRowsHtml() + '</div>';
  }
  function jobsRowsHtml() {
    if (!S.noSub) return '';
    const q = S.f.query.trim().toLowerCase();
    const rows = S.noSub.rows.filter((r) => !q || String(r.name || '').toLowerCase().indexOf(q) !== -1).sort((a, b) => b.collectedCents - a.collectedCents);
    if (!rows.length) return '<div class="sp-empty">' + (S.noSub.rows.length ? 'No job matches that search.' : 'Every job has a sub cost, or you marked it not applicable.') + '</div>';
    return rows.map((r) => '<article class="sp-card"><div class="sp-card-top"><b class="sp-payee">' + esc(r.name) + '</b><span class="sp-tag">' + esc(({ finished: 'Finished', production: 'In production', signed: 'Signed' })[r.phase] || '') + '</span></div>' +
      '<div class="sp-nums"><span><i>Collected</i><b>' + money(r.collectedCents) + '</b></span><span><i>Costs</i><b>' + money(r.directCents) + '</b></span><span><i>Margin</i><b>' + (r.marginPct == null ? '-' : r.marginPct + '%') + '</b></span></div>' +
      '<div class="sp-act"><button type="button" class="sp-btn sp-primary" data-sp-action="log-for-job" data-sp-job="' + esc(r.id) + '">Log sub payment</button>' +
      '<button type="button" class="sp-btn" data-sp-action="job-money" data-sp-job="' + esc(r.id) + '">Job money</button></div></article>').join('');
  }

  function payTabHtml() {
    const L = logic();
    const f = S.f;
    const opt = (v, label, cur) => '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(label) + '</option>';
    const subs = L.perSub(S.expenses, S.roster);
    const c = countersNow();
    let h = '<div class="sp-chips"><button type="button" class="sp-chip" data-sp-action="scope" data-sp-scope="nojob" aria-pressed="' + (f.scope === 'nojob') + '">No job <b>' + c.paymentsNoJob + '</b></button>' +
      '<button type="button" class="sp-chip" data-sp-action="scope" data-sp-scope="all" aria-pressed="' + (f.scope === 'all') + '">All payments <b>' + c.total + '</b></button>' +
      '<button type="button" class="sp-chip" data-sp-action="noproof" aria-pressed="' + (f.proof === 'none') + '">No proof <b>' + c.paymentsNoProof + '</b></button></div>' +
      '<input class="sp-in" type="search" placeholder="Search payee, note or amount" aria-label="Search payments" autocomplete="off" data-sp-f="query" value="' + esc(f.query) + '">' +
      '<div class="sp-selects"><select class="sp-in" data-sp-f="method" aria-label="Payment method">' + opt('all', 'Any method', f.method) + L.METHODS.map((m) => opt(m.key, m.label, f.method)).join('') + '</select>' +
      '<select class="sp-in" data-sp-f="sub" aria-label="Sub">' + opt('all', 'Any sub', f.sub) + subs.filter((s) => s.count).map((s) => opt(s.key, s.name, f.sub)).join('') + '</select>' +
      '<select class="sp-in" data-sp-f="sort" aria-label="Sort">' + opt('newest', 'Newest first', f.sort) + opt('oldest', 'Oldest first', f.sort) + opt('amount', 'Biggest first', f.sort) + '</select></div>';
    if (canWrite()) h += '<button type="button" class="sp-btn sp-wide" data-sp-action="log">+ Log a sub payment</button>';
    if (c.paymentsNoJob && f.scope === 'nojob') h += '<div class="sp-warn" role="status"><b>' + money(c.noJobCents) + '</b> in ' + c.paymentsNoJob + ' payment' + (c.paymentsNoJob === 1 ? '' : 's') + ' reaches no job\'s profit until each one is tied to a job (or marked not a job cost).</div>';
    return h + '<div id="spRows">' + payRowsHtml() + '</div>';
  }
  function payRowsHtml() {
    const f = S.f;
    const rows = logic().filterPayments(S.expenses, S.roster, { scope: f.scope, query: f.query, method: f.method, proof: f.proof, sub: f.sub, sort: f.sort });
    return rows.length ? rows.map(cardHtml).join('') : '<div class="sp-empty">' + (f.scope === 'nojob' && f.proof !== 'none' && !f.query ? 'Every sub payment has a job.' : 'Nothing matches that.') + '</div>';
  }

  function subsTabHtml() {
    const L = logic();
    const sugg = L.mergeSuggestions(S.roster, S.expenses).filter((s) => !S.dismissed[sugKey(s)]);
    let h = '<input class="sp-in" type="search" placeholder="Search subs" aria-label="Search subs" autocomplete="off" data-sp-f="subq" value="' + esc(S.f.subq) + '">' +
      (canWrite() ? '<button type="button" class="sp-btn sp-wide" data-sp-action="new-sub">+ Add a sub</button>' : '');
    sugg.forEach((s) => { h += sugHtml(s); });
    return h + '<div id="spRows">' + subsRowsHtml() + '</div>';
  }
  function subsRowsHtml() {
    const q = S.f.subq.trim().toLowerCase();
    const groups = logic().perSub(S.expenses, S.roster).filter((g) => !q || g.name.toLowerCase().indexOf(q) !== -1);
    if (!groups.length) return '<div class="sp-empty">No subs yet. Add one, or log a payment and add the sub there.</div>';
    return groups.map((g) => '<article class="sp-card"><div class="sp-card-top"><b class="sp-payee">' + esc(g.name) + '</b><b>' + money(g.totalCents) + '</b></div>' +
      '<div class="sp-card-sub">' + (g.trade ? esc(g.trade) + ' · ' : '') + g.count + ' payment' + (g.count === 1 ? '' : 's') + (g.spellings.length > 1 ? ' · ' + g.spellings.length + ' spellings' : '') + '</div>' +
      '<div class="sp-card-sub">' + (g.noProof ? '<span class="sp-flag">' + g.noProof + ' without proof</span>' : '<span class="sp-ok">All have proof</span>') + (g.noJob ? ' · <span class="sp-flag">' + g.noJob + ' with no job</span>' : '') + '</div>' +
      '<div class="sp-act"><button type="button" class="sp-btn" data-sp-action="open-sub" data-sp-key="' + esc(g.key) + '">Open</button></div></article>').join('');
  }
  function sugKey(s) { return s.type + ':' + (s.a || s.name || s.key) + ':' + (s.b || s.subId || ''); }
  function sugHtml(s) {
    const k = esc(sugKey(s));
    let text, yes;
    if (s.type === 'roster_duplicate') { text = '<b>' + esc(s.aName) + '</b> and <b>' + esc(s.bName) + '</b> look like the same sub.'; yes = 'Same sub: combine'; }
    else if (s.type === 'alias') { text = 'Payments to <b>' + esc(s.name) + '</b> (' + s.count + ') look like <b>' + esc(s.subName) + '</b>.'; yes = 'Same sub'; }
    else { text = '<b>' + esc(s.names.join('</b> and <b>')) + '</b> look like one sub that is not on your list.'; yes = 'Add as one sub'; }
    return '<div class="sp-sug" role="status"><div>' + text + ' Nothing changes until you tap.</div><div class="sp-act">' +
      (canWrite() ? '<button type="button" class="sp-btn sp-primary" data-sp-action="merge" data-sp-sug="' + k + '">' + yes + '</button>' : '') +
      '<button type="button" class="sp-btn" data-sp-action="dismiss" data-sp-sug="' + k + '">Not the same</button></div></div>';
  }

  // ── job money: the customer's payments and the sub payments, side by side ──
  async function loadJobInvoices() {
    const R = w.NBDRevenue;
    if (!R || typeof R.loadInvoices !== 'function') return null;
    const list = await R.loadInvoices();
    if (typeof R.cached === 'function' && !R.cached()) return null;   // the read failed: NOT "no payments"
    return list || [];
  }
  function customerPaymentsOf(leadId) {
    const out = [];
    (S.invoices || []).forEach((inv) => {
      if (!inv || inv.deleted === true || inv.leadId !== leadId) return;
      (Array.isArray(inv.payments) ? inv.payments : []).forEach((p) => {
        const amt = parseFloat(p && p.amount);
        if (!(amt > 0)) return;
        const proofs = [];
        if (p.proofStoragePath) proofs.push(p.proofStoragePath);
        (Array.isArray(p.proofPaths) ? p.proofPaths : []).forEach((x) => proofs.push(x));
        out.push({ invoiceId: inv.id, cents: Math.round(amt * 100), at: p.at, method: p.method || '', ref: p.reference || '', note: p.note || '', backfilled: inv.source === 'backfill' || inv.backfilled === true, proofs: proofs, invoice: inv });
      });
    });
    return out.sort((a, b) => ((toDate(b.at) || 0) - (toDate(a.at) || 0)));
  }
  async function openJobMoney(leadId) {
    if (!enabled() || !canRead() || !leadId) return false;
    if (!S) { S = await base(); S.standalone = true; }
    S.view = 'job'; S.jobLeadId = leadId; S.invoices = null; S.jvVoid = null; S.jvNote = '';
    render();
    const inv = await loadJobInvoices();
    if (!S) return true;
    S.invoices = inv; S.invoicesFailed = inv == null;
    render();
    const m = document.getElementById('spOverlay'); if (m) m.scrollTop = 0;
    return true;
  }
  function jobMoneyHtml() {
    const L = logic(), id = S.jobLeadId;
    const subs = S.expenses.filter((e) => e && e.leadId === id && e.deleted !== true && L.isSubPayment(e) && e.costType === 'direct');
    const direct = S.expenses.filter((e) => e && e.leadId === id && e.deleted !== true && e.costType === 'direct' && L.centsOf(e) > 0);
    const costs = direct.reduce((t, e) => t + L.centsOf(e), 0);
    const subCents = subs.reduce((t, e) => t + L.centsOf(e), 0);
    const pays = S.invoices ? customerPaymentsOf(id) : [];
    const collected = pays.reduce((t, p) => t + p.cents, 0);
    const owner = !!(w.NBDPaymentBackfill && w.NBDPaymentBackfill.isOwner && w.NBDPaymentBackfill.isOwner());
    let h = '<div class="sp-head"><button type="button" class="sp-x" data-sp-action="back" aria-label="Back">←</button><h3 class="sp-title">' + esc(jobText(id)) + '</h3><button type="button" class="sp-x" data-sp-action="close" aria-label="Close">✕</button></div>' +
      '<div class="sp-sub">Job money: what the customer paid and what the subs were paid, with the photos.</div>';
    if (S.invoices === null && !S.invoicesFailed) return h + '<div class="sp-empty">Loading the customer payments…</div>';
    if (S.invoicesFailed) h += '<div class="sp-warn" role="status">The customer payments did not load, so collected and profit are not shown. Nothing was changed.</div>';
    else h += '<div class="sp-nums"><span><i>Collected</i><b>' + money(collected) + '</b></span><span><i>Job costs</i><b>' + money(costs) + '</b></span><span><i>Profit so far</i><b>' + money(collected - costs) + '</b></span></div>';
    const payCards = pays.length ? pays.map((p) => {
      let c = '<article class="sp-card"><div class="sp-card-top"><b>' + money(p.cents) + '</b><span class="sp-card-sub">' + esc(dateText(p.at)) + '</span></div>' +
        '<div class="sp-card-sub">' + esc(METHOD_LABEL[p.method] || p.method || 'Payment') + (p.ref ? ' #' + esc(p.ref) : '') + (p.backfilled ? ' · <span class="sp-tag">Backfilled</span>' : '') + '</div>' +
        (p.note ? '<div class="sp-note">' + esc(p.note) + '</div>' : '') +
        (p.proofs.length ? '<div class="sp-card-sub">' + p.proofs.length + ' photo' + (p.proofs.length === 1 ? '' : 's') + '</div>' + PP().thumbsHtml(p.proofs) : '<div class="sp-card-sub"><span class="sp-flag">No photo</span></div>');
      if (owner && p.backfilled) {
        c += S.jvVoid === p.invoiceId
          ? '<div class="sp-pick"><label class="sp-lab" for="spJvNote">Why void it? (required. It is kept with your note.)</label><input id="spJvNote" class="sp-in" maxlength="300" autocomplete="off" data-sp-f="jvnote" value="' + esc(S.jvNote) + '"><div class="sp-err" id="spErr" role="alert"></div>' +
            '<div class="sp-act"><button type="button" class="sp-btn sp-primary" data-sp-action="jv-void-go" data-sp-inv="' + esc(p.invoiceId) + '">Void this payment</button><button type="button" class="sp-btn" data-sp-action="jv-void-cancel">Cancel</button></div></div>'
          : '<div class="sp-act"><button type="button" class="sp-btn" data-sp-action="jv-void" data-sp-inv="' + esc(p.invoiceId) + '">Void backfilled payment</button></div>';
      }
      return c + '</article>';
    }).join('') : '<div class="sp-empty">' + (S.invoicesFailed ? 'Not loaded.' : 'No customer payments are recorded on this job.') + '</div>';
    const subCards = subs.length ? subs.sort((a, b) => ((toDate(b.date) || 0) - (toDate(a.date) || 0))).map((e) =>
      '<article class="sp-card"><div class="sp-card-top"><b class="sp-payee">' + esc(e.supplier || 'Unknown') + '</b><b>' + money(L.centsOf(e)) + '</b></div>' +
      '<div class="sp-card-sub">' + esc(dateText(e.date)) + ' · ' + esc(METHOD_LABEL[e.paymentMethod] || 'Cash') + '</div>' + (e.note ? '<div class="sp-note">' + esc(e.note) + '</div>' : '') +
      (L.proofCount(e) ? '<div class="sp-card-sub">' + L.proofCount(e) + ' photo' + (L.proofCount(e) === 1 ? '' : 's') + '</div>' + PP().thumbsHtml(proofPathsOf(e)) : '<div class="sp-card-sub"><span class="sp-flag">No proof</span></div>') + '</article>').join('')
      : '<div class="sp-empty">No sub payments are logged on this job.</div>';
    return h + '<div class="sp-cols"><div><div class="sp-lab">Customer payments (' + pays.length + ')</div>' + payCards + '</div>' +
      '<div><div class="sp-lab">Sub payments (' + subs.length + ', ' + money(subCents) + ')</div>' + subCards + '</div></div>' +
      (canWrite() ? '<button type="button" class="sp-btn sp-wide" data-sp-action="log-for-job" data-sp-job="' + esc(id) + '">Log a sub payment on this job</button>' : '');
  }
  async function voidBackfilledPayment(invId) {
    const inv = (S.invoices || []).find((i) => i && i.id === invId);
    const PB = w.NBDPaymentBackfillLogic;
    if (!inv || !PB || !(w.NBDPaymentBackfill && w.NBDPaymentBackfill.isOwner())) return;
    const built = PB.voidPatch(inv, S.jvNote, uid(), Date.now());
    if (built.error) { showErr(built.error); return; }
    try { await w.updateDoc(w.doc(w.db, 'invoices', invId), Object.assign({}, built.patch, { deletedAt: w.serverTimestamp(), updatedAt: w.serverTimestamp() })); }
    catch (e) { console.warn('[sub-payments] void backfilled payment failed', e && e.code); toast('Could not void that. Nothing changed.', 'error'); return; }
    Object.assign(inv, built.patch); S.changed = true; S.jvVoid = null; S.jvNote = '';
    toast('Payment voided (kept with your note)', 'ok'); render();
  }

  // ── sub detail ──────────────────────────────────────────────────────────
  function subViewHtml() {
    const L = logic();
    const g = L.perSub(S.expenses, S.roster).find((x) => x.key === S.subKey);
    if (!g) { S.view = 'main'; return mainHtml(); }
    const rows = L.filterPayments(S.expenses, S.roster, { scope: 'all', sub: g.key, sort: 'newest' });
    const r = g.subId ? S.roster.find((x) => x.id === g.subId) : null;
    let h = '<div class="sp-head"><button type="button" class="sp-x" data-sp-action="back" aria-label="Back">←</button><h3 class="sp-title">' + esc(g.name) + '</h3><button type="button" class="sp-x" data-sp-action="close" aria-label="Close">✕</button></div>' +
      '<div class="sp-sub">' + (g.trade ? esc(g.trade) + ' · ' : '') + 'Independent subcontractor</div>' +
      '<div class="sp-nums"><span><i>Total paid</i><b>' + money(g.totalCents) + '</b></span><span><i>Payments</i><b>' + g.count + '</b></span><span><i>No proof</i><b>' + g.noProof + '</b></span></div>';
    if (canWrite()) {
      h += '<div class="sp-act"><button type="button" class="sp-btn sp-primary" data-sp-action="log" data-sp-key="' + esc(g.key) + '">Log a payment</button>' +
        (r ? '<button type="button" class="sp-btn" data-sp-action="edit-sub">Edit sub</button>' : '<button type="button" class="sp-btn" data-sp-action="add-roster" data-sp-key="' + esc(g.key) + '">Add to my subs</button>') + '</div>';
      if (S.editSub && r) h += editSubHtml(r);
    }
    const jobs = Object.keys(g.byJob).map((id) => ({ id, c: g.byJob[id] })).sort((a, b) => b.c.cents - a.c.cents);
    h += '<div class="sp-cols"><div><div class="sp-lab">By job</div><ul class="sp-list">' + (jobs.length ? jobs.map((j) => '<li><span>' + esc(jobText(j.id)) + '</span><b>' + money(j.c.cents) + '</b></li>').join('') : '<li class="sp-sub">None tied to a job yet</li>') + '</ul></div>' +
      '<div><div class="sp-lab">By month</div><ul class="sp-list">' + g.byMonth.map((m) => '<li><span>' + esc(m.key === 'undated' ? 'Undated' : monthLabel(m.key)) + '</span><b>' + money(m.cents) + '</b></li>').join('') + '</ul></div></div>';
    if (g.spellings.length > 1) h += '<div class="sp-sub">Names on these payments: ' + g.spellings.map(esc).join(', ') + '</div>';
    h += '<div class="sp-lab">Payments, newest first</div>' + (rows.length ? rows.map(cardHtml).join('') : '<div class="sp-empty">No payments logged for this sub yet.</div>');
    return h;
  }
  function editSubHtml(r) {
    return '<div class="sp-sheetbox"><label class="sp-lab" for="spEsName">Name</label><input id="spEsName" class="sp-in" maxlength="80" autocomplete="off" data-sp-f="es-name" value="' + esc(S.editSub.name) + '">' +
      '<label class="sp-lab" for="spEsTrade">Trade</label><input id="spEsTrade" class="sp-in" maxlength="40" autocomplete="off" data-sp-f="es-trade" value="' + esc(S.editSub.trade) + '">' +
      '<label class="sp-lab" for="spEsPhone">Phone (optional, private: never on any page)</label><input id="spEsPhone" class="sp-in" type="tel" maxlength="40" autocomplete="off" data-sp-f="es-phone" value="' + esc(S.editSub.phone) + '">' +
      '<div class="sp-err" id="spErr" role="alert"></div><div class="sp-act"><button type="button" class="sp-btn sp-primary" data-sp-action="save-sub">Save sub</button><button type="button" class="sp-btn" data-sp-action="cancel-sub">Cancel</button></div></div>';
  }

  // ── log a payment (the one-thumb sheet) ─────────────────────────────────
  function newForm(leadId, who) {
    return { leadId: leadId || '', who: who || '', addNew: false, newName: '', newTrade: '', newPhone: '', amount: '', method: '', date: ymd(new Date()), note: '', files: [], jq: '' };
  }
  function formJobResHtml() {
    if (!S.form.jq) return '';
    const res = logic().searchJobs(S.leads, S.form.jq, 6);
    return res.length ? res.map((r) => '<button type="button" class="sp-job" data-sp-action="form-job" data-sp-job="' + esc(r.leadId) + '"><b>' + esc(r.name) + '</b><span>' + esc(r.address) + '</span></button>').join('') : '<div class="sp-sub">No job matches that.</div>';
  }
  function formHtml() {
    const F = S.form, L = logic();
    const known = {};
    S.roster.forEach((r) => { known[r.name.toLowerCase()] = true; });
    const pastNames = [];
    L.perSub(S.expenses, S.roster).forEach((g) => { if (!g.subId && g.count && !known[g.name.toLowerCase()]) pastNames.push(g.name); });
    const chip = (name, trade) => '<button type="button" class="sp-chip" data-sp-action="who" data-sp-name="' + esc(name) + '" aria-pressed="' + (!F.addNew && F.who === name) + '">' + esc(name) + (trade ? ' <i>' + esc(trade) + '</i>' : '') + '</button>';
    let h = '<div class="sp-head"><button type="button" class="sp-x" data-sp-action="back" aria-label="Back">←</button><h3 class="sp-title">Log a sub payment</h3><button type="button" class="sp-x" data-sp-action="close" aria-label="Close">✕</button></div>';
    // job
    if (F.leadId) {
      h += '<div class="sp-lab">Job</div><div class="sp-job-on"><b>' + esc(jobText(F.leadId)) + '</b>' + (F.lockJob ? '' : '<button type="button" class="sp-btn sp-sm" data-sp-action="clear-job">Change</button>') + '</div>';
    } else {
      h += '<label class="sp-lab" for="spFJob">Job (optional: leave empty and it waits in "Payments with no job")</label>' +
        '<input id="spFJob" class="sp-in" type="search" autocomplete="off" placeholder="Search by customer or address" data-sp-f="f-jq" value="' + esc(F.jq) + '">' +
        '<div id="spFJobRes">' + formJobResHtml() + '</div>';
    }
    // who
    h += '<div class="sp-lab">Who was paid?</div><div class="sp-chips" role="group" aria-label="Sub">' + S.roster.map((r) => chip(r.name, r.trade)).join('') + pastNames.map((n) => chip(n, '')).join('') +
      '<button type="button" class="sp-chip sp-chip-add" data-sp-action="add-new" aria-pressed="' + F.addNew + '">+ Add new sub</button></div>';
    if (F.addNew) {
      h += '<div class="sp-sheetbox"><label class="sp-lab" for="spNName">Sub name</label><input id="spNName" class="sp-in" maxlength="80" autocomplete="off" data-sp-f="f-newname" value="' + esc(F.newName) + '">' +
        '<label class="sp-lab" for="spNTrade">Trade (optional)</label><input id="spNTrade" class="sp-in" maxlength="40" autocomplete="off" placeholder="Roofing, gutters, siding…" data-sp-f="f-newtrade" value="' + esc(F.newTrade) + '">' +
        '<label class="sp-lab" for="spNPhone">Phone (optional, kept private)</label><input id="spNPhone" class="sp-in" type="tel" maxlength="40" autocomplete="off" data-sp-f="f-newphone" value="' + esc(F.newPhone) + '"></div>';
    } else {
      h += '<input id="spFWho" class="sp-in" maxlength="120" autocomplete="off" placeholder="Or type a name" data-sp-f="f-who" value="' + esc(F.who) + '">';
    }
    h += '<label class="sp-lab" for="spFAmt">Amount</label><input id="spFAmt" class="sp-in sp-big" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" data-sp-f="f-amount" value="' + esc(F.amount) + '">' +
      '<div class="sp-lab">How was it paid?</div><div class="sp-methods" role="radiogroup" aria-label="Payment method">' +
      L.METHODS.map((m) => '<label class="sp-method"><input type="radio" name="spMethod" value="' + m.key + '"' + (F.method === m.key ? ' checked' : '') + ' data-sp-f="f-method"><span>' + m.label + '</span></label>').join('') + '</div>' +
      '<label class="sp-lab" for="spFDate">Date paid</label><input id="spFDate" class="sp-in" type="date" data-sp-f="f-date" value="' + esc(F.date) + '">' +
      '<label class="sp-lab" for="spFNote">What was it for? (shingles, a part, tear-off labor…)</label><textarea id="spFNote" class="sp-in sp-ta" maxlength="500" rows="3" data-sp-f="f-note">' + esc(F.note) + '</textarea>' +
      '<div class="sp-lab">Proof (check photo, Zelle screenshot, receipt)</div>' +
      '<button type="button" class="sp-btn sp-wide" data-sp-action="pick-files">📷 Add photos or a PDF</button>' +
      (F.files.length ? '<ul class="sp-files">' + F.files.map((f, i) => '<li><span>' + esc(f.name || 'photo') + '</span><button type="button" class="sp-btn sp-sm" data-sp-action="drop-file" data-sp-i="' + i + '">Remove</button></li>').join('') + '</ul>' : '<div class="sp-sub">No photo yet. You can add one later from the Payments list.</div>') +
      '<div class="sp-err" id="spErr" role="alert"></div>' +
      '<div class="sp-act"><button type="button" class="sp-btn sp-primary" data-sp-action="save-payment"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Saving…' : 'Save payment') + '</button><button type="button" class="sp-btn" data-sp-action="back">Cancel</button></div>';
    return h;
  }

  // ── render ──────────────────────────────────────────────────────────────
  function mainHtml() {
    let body;
    if (S.tab === 'jobs' && canWrite()) body = jobsTabHtml();
    else if (S.tab === 'subs') body = subsTabHtml();
    else body = payTabHtml();
    return '<div class="sp-head"><h3 class="sp-title">Sub payments</h3><button type="button" class="sp-x" data-sp-action="close" aria-label="Close">✕</button></div>' +
      '<p class="sp-lede">Crews are independent subs, so what you pay them is a job cost. Match every payment to a job and keep a photo of the check or Zelle.</p>' +
      tabsHtml() + body;
  }
  function overlay() {
    let m = document.getElementById('spOverlay');
    if (!m) {
      m = document.createElement('div'); m.id = 'spOverlay'; m.className = 'sp-overlay';
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Sub payments');
      document.body.appendChild(m);
    }
    return m;
  }
  function render() {
    if (!S) return;
    let body;
    if (S.view === 'log' && S.form) body = formHtml();
    else if (S.view === 'sub') body = subViewHtml();
    else if (S.view === 'job' && S.jobLeadId) body = jobMoneyHtml();
    else body = mainHtml();
    const m = overlay();
    // Opened from the backfill screen ("Open job money"): sit above it.
    m.classList.toggle('sp-top', !!document.getElementById('pbOverlay'));
    m.innerHTML = '<div class="sp-sheet">' + body + '</div>';
    PP().hydrate(m);
  }
  function close() {
    const m = document.getElementById('spOverlay'); if (m) m.remove();
    const changed = S && S.changed;
    S = null;
    if (changed && w.Expenses && typeof w.Expenses.refresh === 'function') w.Expenses.refresh();
  }
  const showErr = (m) => { const el = document.getElementById('spErr'); if (el) el.textContent = m; };

  // ── proof photos (the shared component: proof-photos.js) ────────────────
  // Every image is re-drawn on a canvas (EXIF dropped), stored under the
  // receipts rules at receipts/{uid}/sub-proofs/; the doc keeps the path only.
  const PP = () => w.NBDProofPhotos;
  function prepareProof(file) { return PP().prepare(file); }
  async function uploadProofs(files) {
    const me = uid();
    const stamp = Date.now();
    const got = await PP().upload(files, (i, base, ext) => 'receipts/' + me + '/sub-proofs/' + stamp + '_' + i + '_' + base + '.' + ext);
    return got.map((g) => g.path);
  }
  const chooseFiles = (cb) => PP().choose(cb);
  function proofPathsOf(e) {
    const paths = (Array.isArray(e.proofPaths) ? e.proofPaths : []).filter((p) => logic().proofPathOk(p));
    if (typeof e.receiptStoragePath === 'string' && PP().pathOk(e.receiptStoragePath)) paths.push(e.receiptStoragePath);
    return paths;
  }

  // ── writes ──────────────────────────────────────────────────────────────
  async function updateRow(row, patch) {
    if (!w.updateDoc || !w.doc || !w.db) { toast('Not connected. Try again.', 'error'); return false; }
    if (row.userId !== uid() || !canWrite()) { toast('That payment was logged by someone else: fix it in Expenses.', 'warn'); return false; }
    try { await w.updateDoc(w.doc(w.db, 'expenses', row.id), Object.assign({}, patch, { updatedAt: w.serverTimestamp() })); }
    catch (e) { console.warn('[sub-payments] update failed', e && e.code); toast('Could not save that. Nothing changed.', 'error'); return false; }
    Object.assign(row, patch);
    S.changed = true;
    return true;
  }
  const rowById = (id) => S && S.expenses.find((e) => e && e.id === id);

  async function assign(id, leadId) {
    const row = rowById(id), lead = leadById(leadId);
    if (!row || !lead) return;
    if (await updateRow(row, logic().assignPatch(row, lead, jobIdFor(leadId), uid(), Date.now()))) {
      S.pick = null; S.jobq = '';
      toast('Tied to ' + logic().leadName(lead), 'ok');
      render();
      if (S.noSub) loadNoSub().then(() => S && render());
    }
  }
  async function markOverhead(id, undo) {
    const row = rowById(id); if (!row) return;
    const L = logic();
    if (await updateRow(row, undo ? L.undoOverheadPatch(row, uid(), Date.now()) : L.overheadPatch(row, uid(), Date.now()))) {
      toast(undo ? 'Put back as a job cost' : 'Marked not a job cost', 'ok'); render();
    }
  }
  async function voidRow(id) {
    const row = rowById(id); if (!row) return;
    const built = logic().voidPatch(row, S.voidNote, uid(), Date.now());
    if (built.error) { showErr(built.error); return; }
    const patch = Object.assign({}, built.patch, { deletedAt: w.serverTimestamp() });
    if (await updateRow(row, patch)) {
      S.expenses = S.expenses.filter((e) => e.id !== id); S.voidId = null; S.voidNote = '';
      toast('Payment voided', 'ok'); render();
    }
  }
  function addProof(id) {
    const row = rowById(id); if (!row || row.userId !== uid() || !canWrite()) return;
    chooseFiles(async (files) => {
      if (!S) return;
      try {
        toast('Uploading…', 'info');
        const paths = await uploadProofs(files.slice(0, logic().CONFIG.maxProofs));
        if (await updateRow(row, logic().proofPatch(row, paths, uid(), Date.now()))) { toast('Proof added', 'ok'); render(); }
      } catch (e) { console.warn('[sub-payments] proof upload failed', e && e.message); toast('Could not upload that photo. Try a screenshot or a PDF.', 'error'); }
    });
  }

  async function savePayment() {
    if (!S || S.busy || !S.form) return;
    const F = S.form, L = logic();
    if (!w.db || !w.addDoc || !w.collection || !w.serverTimestamp) { showErr('Not connected. Try again.'); return; }
    let who = F.addNew ? F.newName.trim() : F.who.trim();
    let roster = S.roster;
    let sub = L.resolveSub(who, null, roster);
    const built0 = L.buildPayment({ who: who, amount: F.amount, method: F.method, date: F.date, note: F.note, leadId: F.leadId, proofPaths: [], subId: sub && sub.id }, { roster, jobIdFor });
    if (built0.error) { showErr(built0.error); return; }
    S.busy = true; render();
    const me = uid();
    try {
      // 1. a new sub, unless the name is already on the list
      if (F.addNew && !sub) {
        const sdoc = { name: who.slice(0, 80), trade: F.newTrade.trim().slice(0, 40), active: true, aliases: [], createdAt: w.serverTimestamp(), updatedAt: w.serverTimestamp(), createdBy: me };
        if (F.newPhone.trim()) sdoc.phone = F.newPhone.trim().slice(0, 40);
        const ref = await w.addDoc(w.collection(w.db, 'companies', tenant(), 'subs'), sdoc);
        sub = { id: ref.id, name: sdoc.name, trade: sdoc.trade, phone: sdoc.phone || '', aliases: [] };
        S.roster = roster = S.roster.concat([sub]).sort((a, b) => a.name.localeCompare(b.name));
      }
      // 2. the proof photos
      let paths = [];
      if (F.files.length) {
        try { paths = await uploadProofs(F.files.slice(0, L.CONFIG.maxProofs)); }
        catch (e) {
          console.warn('[sub-payments] proof upload failed', e && e.message);
          S.busy = false; render(); showErr('A photo could not be uploaded (use a photo, screenshot or PDF under 25MB). Remove it or try again. Nothing was saved.');
          return;
        }
      }
      // 3. the payment
      const built = L.buildPayment({ who: who, amount: F.amount, method: F.method, date: F.date, note: F.note, leadId: F.leadId, proofPaths: paths, subId: sub && sub.id }, { roster, jobIdFor });
      const fields = built.fields;
      const doc = Object.assign({}, fields, {
        userId: me, companyId: claims().companyId || me, source: L.SOURCE, needsReview: false,
        editLog: [L.logEntry(me, 'create', F.leadId ? 'Logged against a job' : 'Logged with no job yet', Date.now())],
        createdAt: w.serverTimestamp(), createdBy: me, updatedAt: w.serverTimestamp(),
      });
      const ref = await w.addDoc(w.collection(w.db, 'expenses'), doc);
      const local = Object.assign({}, fields, { id: ref && ref.id, userId: me, source: L.SOURCE, editLog: doc.editLog });
      S.expenses.push(local); S.changed = true;
      try { w.dispatchEvent(new CustomEvent('nbd:sub-payment-saved', { detail: { row: local } })); } catch (e) { /* the auditor sheet refreshes on its own next open */ }
      toast(F.leadId ? 'Sub payment logged' : 'Logged. No job yet, so it waits in "Payments with no job".', F.leadId ? 'ok' : 'warn');
      if (F.leadId && noSubCount != null) { noSubCount = Math.max(0, noSubCount - 1); }
      S.busy = false;
      const back = S.returnTab;
      if (F.closeAfter) { close(); return; }
      S.view = 'main'; S.form = null; S.tab = back || (F.leadId ? 'jobs' : 'pay');
      if (S.tab === 'jobs') { S.noSub = null; loadNoSub().then(() => S && render()); }
      render();
    } catch (e) {
      console.warn('[sub-payments] payment not saved', e && e.code);
      if (S) { S.busy = false; render(); showErr('Could not save. Nothing was saved.'); }
    }
  }

  // sub roster edits
  async function saveSub() {
    const g = logic().perSub(S.expenses, S.roster).find((x) => x.key === S.subKey);
    const r = g && g.subId && S.roster.find((x) => x.id === g.subId);
    if (!r || !S.editSub) return;
    const name = S.editSub.name.trim();
    if (!name) { showErr('A sub needs a name.'); return; }
    const patch = { name: name.slice(0, 80), trade: S.editSub.trade.trim().slice(0, 40), phone: S.editSub.phone.trim().slice(0, 40), updatedAt: w.serverTimestamp() };
    // The old spelling stays resolvable.
    const aliases = r.aliases.slice();
    if (logic().payeeKey(r.name) !== logic().payeeKey(name) && aliases.indexOf(r.name) === -1) aliases.push(r.name);
    patch.aliases = aliases;
    try { await w.updateDoc(w.doc(w.db, 'companies', tenant(), 'subs', r.id), patch); }
    catch (e) { console.warn('[sub-payments] sub not saved', e && e.code); showErr('Could not save the sub.'); return; }
    Object.assign(r, { name: patch.name, trade: patch.trade, phone: patch.phone, aliases });
    S.roster.sort((a, b) => a.name.localeCompare(b.name));
    S.editSub = null; S.subKey = 'sub:' + r.id; S.changed = true;
    toast('Sub saved', 'ok'); render();
  }
  async function addRosterFromGroup(key) {
    const g = logic().perSub(S.expenses, S.roster).find((x) => x.key === key);
    if (!g || g.subId) return;
    await createRosterSub(g.name, g.spellings.filter((n) => n !== g.name));
  }
  async function createRosterSub(name, aliases) {
    const me = uid();
    try {
      const sdoc = { name: name.slice(0, 80), trade: '', active: true, aliases: (aliases || []).map((a) => a.slice(0, 120)), createdAt: w.serverTimestamp(), updatedAt: w.serverTimestamp(), createdBy: me };
      const ref = await w.addDoc(w.collection(w.db, 'companies', tenant(), 'subs'), sdoc);
      S.roster = S.roster.concat([{ id: ref.id, name: sdoc.name, trade: '', phone: '', aliases: sdoc.aliases }]).sort((a, b) => a.name.localeCompare(b.name));
      S.changed = true; toast('Added to your subs', 'ok'); return ref.id;
    } catch (e) { console.warn('[sub-payments] sub not added', e && e.code); toast('Could not add the sub. Nothing changed.', 'error'); return null; }
  }
  // Apply ONE suggestion the user tapped.
  async function mergeOne(key) {
    const s = logic().mergeSuggestions(S.roster, S.expenses).find((x) => sugKey(x) === key);
    if (!s || !canWrite()) return;
    try {
      if (s.type === 'alias') {
        const r = S.roster.find((x) => x.id === s.subId); if (!r) return;
        const aliases = r.aliases.concat([s.name]);
        await w.updateDoc(w.doc(w.db, 'companies', tenant(), 'subs', r.id), { aliases, updatedAt: w.serverTimestamp() });
        r.aliases = aliases;
      } else if (s.type === 'roster_duplicate') {
        const a = S.roster.find((x) => x.id === s.a), b = S.roster.find((x) => x.id === s.b); if (!a || !b) return;
        const aliases = a.aliases.concat([b.name], b.aliases).filter((n, i, arr) => arr.indexOf(n) === i);
        await w.updateDoc(w.doc(w.db, 'companies', tenant(), 'subs', a.id), { aliases, updatedAt: w.serverTimestamp() });
        await w.updateDoc(w.doc(w.db, 'companies', tenant(), 'subs', b.id), { active: false, updatedAt: w.serverTimestamp() });
        a.aliases = aliases; S.roster = S.roster.filter((x) => x.id !== b.id);
      } else {
        const name = s.names.slice().sort((x, y) => y.length - x.length)[0];
        await createRosterSub(name, s.names.filter((n) => n !== name));
      }
    } catch (e) { console.warn('[sub-payments] merge failed', e && e.code); toast('Could not combine those. Nothing changed.', 'error'); return; }
    S.changed = true; toast('Combined into one sub', 'ok'); render();
  }

  // ── events ──────────────────────────────────────────────────────────────
  function startLog(leadId, who, lockJob, closeAfter) {
    S.form = newForm(leadId, who); S.form.lockJob = !!lockJob; S.form.closeAfter = !!closeAfter;
    S.returnTab = S.tab; S.view = 'log'; render();
    const m = document.getElementById('spOverlay'); if (m) m.scrollTop = 0;
  }

  async function onClick(ev) {
    const t = ev.target && ev.target.closest && ev.target.closest('[data-sp-action]');
    if (!t || t.disabled) return;
    const a = t.dataset.spAction, id = t.dataset.spId;
    if (a === 'open') { open(t.dataset.spTab, t.dataset.spScope, t.dataset.spProof); return; }
    if (a === 'log-for-job') {
      if (!enabled() || !canWrite()) return;
      // From the auditor's job sheet there is no sorter open: build the state and close it after saving.
      const fromAuditor = !S;
      if (fromAuditor) { S = await base(); S.tab = 'jobs'; }
      startLog(t.dataset.spJob, '', true, fromAuditor);
      return;
    }
    if (!S) return;
    if (a === 'close') close();
    else if (a === 'back') { if (S.view === 'job' && S.standalone) { close(); return; } S.view = 'main'; S.form = null; S.editSub = null; render(); }
    else if (a === 'job-money') openJobMoney(t.dataset.spJob);
    else if (a === 'jv-void') { S.jvVoid = t.dataset.spInv; S.jvNote = ''; render(); }
    else if (a === 'jv-void-cancel') { S.jvVoid = null; render(); }
    else if (a === 'jv-void-go') voidBackfilledPayment(t.dataset.spInv);
    else if (a === 'tab') { S.tab = t.dataset.spTab; S.pick = null; render(); }
    else if (a === 'scope') { S.f.scope = t.dataset.spScope; S.pick = null; render(); }
    else if (a === 'noproof') { S.f.proof = S.f.proof === 'none' ? 'all' : 'none'; S.f.scope = 'all'; render(); }
    else if (a === 'log') { const g = t.dataset.spKey ? logic().perSub(S.expenses, S.roster).find((x) => x.key === t.dataset.spKey) : null; startLog('', g ? g.name : '', false, false); }
    else if (a === 'pick') { S.pick = S.pick === id ? null : id; S.jobq = ''; render(); }
    else if (a === 'pick-close') { S.pick = null; render(); }
    else if (a === 'assign') assign(id, t.dataset.spJob);
    else if (a === 'overhead') markOverhead(id, false);
    else if (a === 'undo-overhead') markOverhead(id, true);
    else if (a === 'add-proof') addProof(id);
    else if (a === 'void-ask') { S.voidId = id; S.voidNote = ''; S.pick = null; render(); }
    else if (a === 'void-cancel') { S.voidId = null; render(); }
    else if (a === 'void-go') voidRow(id);
    else if (a === 'open-sub') { S.view = 'sub'; S.subKey = t.dataset.spKey; S.editSub = null; render(); const m = document.getElementById('spOverlay'); if (m) m.scrollTop = 0; }
    else if (a === 'edit-sub') {
      const g = logic().perSub(S.expenses, S.roster).find((x) => x.key === S.subKey);
      const r = g && S.roster.find((x) => x.id === g.subId);
      if (r) { S.editSub = { name: r.name, trade: r.trade, phone: r.phone }; render(); }
    }
    else if (a === 'cancel-sub') { S.editSub = null; render(); }
    else if (a === 'save-sub') saveSub();
    else if (a === 'add-roster') addRosterFromGroup(t.dataset.spKey).then(() => S && render());
    else if (a === 'new-sub') { startLog('', '', false, false); S.form.addNew = true; render(); }
    else if (a === 'merge') mergeOne(t.dataset.spSug);
    else if (a === 'dismiss') { S.dismissed[t.dataset.spSug] = true; render(); }
    else if (S.form) {
      if (a === 'who') { S.form.who = t.dataset.spName; S.form.addNew = false; render(); }
      else if (a === 'add-new') { S.form.addNew = !S.form.addNew; render(); }
      else if (a === 'clear-job') { S.form.leadId = ''; render(); }
      else if (a === 'form-job') { S.form.leadId = t.dataset.spJob; S.form.jq = ''; render(); }
      else if (a === 'pick-files') chooseFiles((fs) => { if (S && S.form) { S.form.files = S.form.files.concat(fs).slice(0, logic().CONFIG.maxProofs); render(); } });
      else if (a === 'drop-file') { S.form.files.splice(Number(t.dataset.spI), 1); render(); }
      else if (a === 'save-payment') savePayment();
    }
  }

  function onInput(ev) {
    if (!S) return;
    const el = ev.target, f = el && el.dataset && el.dataset.spF;
    if (!f) return;
    const F = S.form;
    // Typing in a search box redraws only the result list, so the keyboard and the cursor stay put.
    const into = (id, html) => { const box = document.getElementById(id); if (box) { box.innerHTML = html; PP().hydrate(box); } };
    if (f === 'query' || f === 'subq') {
      S.f[f] = el.value;
      into('spRows', S.tab === 'jobs' ? jobsRowsHtml() : S.tab === 'subs' ? subsRowsHtml() : payRowsHtml());
      return;
    }
    if (f === 'method' || f === 'sub' || f === 'sort') { S.f[f] = el.value; into('spRows', payRowsHtml()); return; }
    if (f === 'jobq') { S.jobq = el.value; into('spJobRes', S.pick ? pickResHtml(S.pick) : ''); return; }
    if (f === 'voidnote') { S.voidNote = el.value; return; }
    if (f === 'jvnote') { S.jvNote = el.value; return; }
    if (f.indexOf('es-') === 0 && S.editSub) { S.editSub[f.slice(3)] = el.value; return; }
    if (!F) return;
    if (f === 'f-jq') { F.jq = el.value; into('spFJobRes', formJobResHtml()); return; }
    if (f === 'f-who') F.who = el.value;
    else if (f === 'f-amount') F.amount = el.value;
    else if (f === 'f-method') { if (el.checked) F.method = el.value; }
    else if (f === 'f-date') F.date = el.value;
    else if (f === 'f-note') F.note = el.value;
    else if (f === 'f-newname') F.newName = el.value;
    else if (f === 'f-newtrade') F.newTrade = el.value;
    else if (f === 'f-newphone') F.newPhone = el.value;
  }

  if (typeof document !== 'undefined' && !w._NBD_SP_DELEGATE) {
    w._NBD_SP_DELEGATE = true;
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onInput);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.getElementById('spOverlay')) close(); });
  }
  // Flags arrive a moment after boot: redraw an already-open Expenses page.
  if (typeof w.addEventListener === 'function' && !w._NBD_SP_FLAGS) {
    w._NBD_SP_FLAGS = true;
    w.addEventListener('nbd:flags-loaded', () => {
      if (!enabled() || !canRead() || !w.Expenses || typeof w.Expenses.render !== 'function' || typeof w.Expenses.list !== 'function') return;
      if (typeof document !== 'undefined' && document.getElementById('spPanel')) return;
      if (w.Expenses.list().length) w.Expenses.render();
    });
  }

  // ── Expenses page: the three counters ──────────────────────────────────
  let bgDone = false;
  function panelHtml(expenses) {
    if (!enabled() || !canRead()) return '';
    const L = logic();
    const c = L.counters((expenses || []).filter((e) => e && e.deleted !== true), noSubCount);
    // The jobs count needs the collected money; ask for it once, only when the
    // invoices are already loaded (no extra reads), and fill the tile in place.
    if (!bgDone && canWrite() && w.NBDRevenue && typeof w.NBDRevenue.cached === 'function' && w.NBDRevenue.cached() && w.NBDJobCostAuditor && typeof w.NBDJobCostAuditor.noSubQueue === 'function') {
      bgDone = true;
      w.NBDJobCostAuditor.noSubQueue().then((r) => {
        if (!r) return;
        noSubCount = r.rows.length;
        const el = document.getElementById('spCntJobs'); if (el) el.textContent = String(noSubCount);
      }).catch(() => { /* the tile stays a dash; the sorter reports it when opened */ });
    }
    const tile = (tab, scope, proof, id, n, label, warn) => '<button type="button" class="sp-tile' + (warn ? ' sp-tile-warn' : '') + '" data-sp-action="open" data-sp-tab="' + tab + '"' + (scope ? ' data-sp-scope="' + scope + '"' : '') + (proof ? ' data-sp-proof="' + proof + '"' : '') + '>' +
      '<b' + (id ? ' id="' + id + '"' : '') + '>' + (n == null ? '-' : n) + '</b><span>' + label + '</span></button>';
    return '<div class="ui-card sp-panel" id="spPanel"><div class="sp-head"><h3 class="sp-title">Sub payments</h3>' +
      '<button type="button" class="btn btn-orange sp-open" data-sp-action="open" data-sp-tab="' + (canWrite() ? 'jobs' : 'pay') + '">Match sub payments</button></div>' +
      '<div class="sp-tiles">' + (canWrite() ? tile('jobs', '', '', 'spCntJobs', c.jobsNoSub, 'jobs with no sub cost', c.jobsNoSub > 0) : '') +
      tile('pay', 'nojob', '', '', c.paymentsNoJob, 'payments with no job', c.paymentsNoJob > 0) +
      tile('pay', 'all', 'none', '', c.paymentsNoProof, 'payments with no proof', c.paymentsNoProof > 0) + '</div>' +
      '<div class="sp-sub">Every sub payment should have a job and a photo of the check or Zelle. Crews are independent subs: their pay is a job cost.</div></div>';
  }
  function buttonHtml() {
    if (!enabled() || !canRead()) return '';
    return '<button type="button" class="btn btn-ghost" data-sp-action="open" data-sp-tab="' + (canWrite() ? 'jobs' : 'pay') + '" title="Match sub and crew payments to jobs">🧾 Sub payments</button>';
  }

  w.NBDSubPayments = { enabled, canWrite, canRead, open, openJobMoney, panelHtml, buttonHtml, prepareProof, FLAG };
})();
