/**
 * job-cost-audit.js — the Job cost auditor panel (2026-10-19).
 *
 * Jo: finished jobs read ~100% margin because the sub / labor cost of his
 * independent crews was never logged. This is the queue that finds those jobs
 * and the fast way to fill them in, from a phone.
 *
 *   1. QUEUE   — finished, in-production and paid-signed jobs, grouped by what
 *                looks wrong (no labor/sub cost, no materials, margin too high,
 *                too low, costs but no payment). Search, filter, sort.
 *   2. SHEET   — per job: who did it (the sub roster + past payees), cost-type
 *                chips, an amount box with a percent-of-collected slider, and
 *                suggestions from the company's OWN similar jobs (median / low /
 *                high). Fewer than 3 comparable jobs = no suggestion, empty box.
 *                "This is an estimate" saves estimated:true so reports can split
 *                estimated from real.
 *   3. ASK ME  — one question at a time; Skip / Not applicable / Unsure are
 *                remembered on the lead (costAudit.asked) so they are not asked
 *                again.
 *   4. CHECKER — "Is this real or a mistake?" cards from jobCostFlags
 *                (job-cost-audit-logic.js). "It's right" is remembered against
 *                the numbers it was judged on; a new cost re-opens it.
 *
 * NO NEW COST STORE. A cost is an /expenses doc exactly like the ones the
 * receipt importer and the cash payout log write (costType 'direct', category by
 * type, source 'cost_auditor') with an editLog entry (who, when,
 * source 'cost-auditor'). Every reader of job cost (job profit, the Expenses
 * by-job table, costs-missing, the agent job_profit tool) counts it. Voiding a
 * row sets deleted:true AND deletedAt and keeps the row for its note.
 *
 * Crews are independent subcontractors: nothing here says employee / payroll.
 * Money is integer cents. Flag `jobCostAuditor` (feature_flags/_default,
 * absent = off): off = no button, no panel, this file does nothing. A viewer or
 * a sales rep never sees it (they cannot write costs).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const FLAG = 'jobCostAuditor';
  const SOURCE = 'cost_auditor';
  const LOG_SOURCE = 'cost-auditor';
  const MAX_CENTS = 99999999;
  const MAX_LOG = 25;
  const FAR = 8.64e15;
  const WRITE_ROLES = ['', 'admin', 'company_admin', 'manager'];
  const ACTIVE_RE = /contract|install|material|schedul|production|permit|supplement/i;
  const WON = ['closed', 'install_complete', 'final_photos', 'final_payment', 'deductible_collected', 'collections', 'warranty_claim', 'Complete'];

  // The cost-type chips. category is the /expenses category the CRM already has;
  // kind is what the checker counts it as.
  const TYPES = [
    { key: 'sub_install', label: 'Sub labor: tear-off / install', short: 'Sub: install', category: 'subcontractor', kind: 'sub' },
    { key: 'sub_gutters', label: 'Sub labor: gutters', short: 'Sub: gutters', category: 'subcontractor', kind: 'sub' },
    { key: 'dumpster', label: 'Dumpster', short: 'Dumpster', category: 'equipment_dumpster', kind: 'dumpster' },
    { key: 'permit', label: 'Permit', short: 'Permit', category: 'permits_fees', kind: 'permit' },
    { key: 'disposal', label: 'Disposal', short: 'Disposal', category: 'disposal', kind: 'disposal' },
    { key: 'other', label: 'Other', short: 'Other', category: 'other_direct', kind: 'other' },
  ];
  const typeBy = (k) => TYPES.find((t) => t.key === k) || TYPES[0];
  const QTYPE = { sub: 'sub_install', dumpster: 'dumpster', permit: 'permit', disposal: 'disposal' };

  const LG = () => w.NBDJobCostAudit;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money0 = (c) => '$' + Math.round((Number(c) || 0) / 100).toLocaleString('en-US');
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };

  function enabled() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }
  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || null; }
  function tenant() { return claims().companyId || uid(); }
  function canWrite() { return !!uid() && WRITE_ROLES.indexOf(claims().role || '') !== -1; }
  function on() { return enabled() && canWrite() && !!LG(); }

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    if (typeof v.toDate === 'function') return v.toDate();
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function parseCents(input) {
    const s = String(input == null ? '' : input).replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return 0;
    return Math.round(parseFloat(s) * 100);
  }

  // ── leads → jobs ────────────────────────────────────────────────────────
  function stageKey(l) { return (l && (l._stageKey || l.stage)) || ''; }
  function roleOf(l) {
    let r = l && l._stageRole;
    if (!r && typeof w.stageRole === 'function') { try { r = w.stageRole(stageKey(l)); } catch (e) { r = null; } }
    return r || '';
  }
  function isWon(l) { const r = roleOf(l); return r ? r === 'won' : WON.indexOf(stageKey(l)) !== -1; }
  function isLost(l) { const r = roleOf(l); return r ? r === 'lost' : /lost|dead|declin/i.test(stageKey(l)); }
  function leadName(l) { return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || String(l.address || '').split(',')[0] || 'Untitled'; }
  // Stage role first, the stage key as the fallback; then the ONE phase rule the
  // agent tool also uses (job-cost-audit-logic.js phaseFor).
  function roleFor(l) {
    const r = roleOf(l);
    if (r) return r;
    if (isLost(l)) return 'lost';
    if (isWon(l)) return 'won';
    return ACTIVE_RE.test(stageKey(l)) ? 'job' : '';
  }
  function phaseOf(l, collectedCents) { return LG().phaseFor(roleFor(l), collectedCents); }
  const PHASE_LABEL = { finished: 'Finished', production: 'In production', signed: 'Signed' };

  function copyAudit(a) {
    const o = Object.assign({}, a || {});
    o.asked = Object.assign({}, o.asked || {});
    o.ack = Object.assign({}, o.ack || {});
    return o;
  }

  // ── state ───────────────────────────────────────────────────────────────
  let S = null;
  // { leads[], expenses[], collected{}, roster[], audit{}, f{group,phase,query,sort,done},
  //   view:'list'|'job'|'ask', jobId, entry{}, voidId, hi[], ask{ids[],i}, confirmId, busy }

  function list() { return (w.Expenses && typeof w.Expenses.list === 'function') ? w.Expenses.list() : []; }

  function costsByLead(expenses) {
    const m = {};
    (expenses || []).forEach((e) => { if (e && e.leadId) (m[e.leadId] = m[e.leadId] || []).push(e); });
    return m;
  }

  // Everything the logic needs, derived from state (cheap: ~hundreds of leads).
  function derive() {
    const L = LG();
    const by = costsByLead(S.expenses);
    const jobs = [], all = [];
    S.leads.forEach((l) => {
      const collectedCents = S.collected[l.id] || 0;
      const costs = by[l.id] || [];
      const trade = L.tradeKeyOf(l);
      const squares = L.squaresOf(l);
      const summary = L.summarize(collectedCents, costs);
      const phase = phaseOf(l, collectedCents);
      if (collectedCents > 0 || costs.length) all.push({ id: l.id, trade, squares, collectedCents, summary, phase, settled: (S.owed[l.id] || 0) === 0 });
      if (!phase) return;
      const created = toDate(l.createdAt);
      jobs.push({
        id: l.id, name: leadName(l), phase, trade, squares, collectedCents,
        createdMs: created ? created.getTime() : 0, audit: S.audit[l.id] || {},
      });
    });
    S.peers = L.buildPeers(all);
    S.by = by;
    S.jobs = jobs;
    S.jobById = {}; jobs.forEach((j) => { S.jobById[j.id] = j; });
    const all2 = L.auditQueue(jobs, by, S.peers);
    S.queue = all2;
    S.doneCount = jobs.filter((j) => isDone(j)).length;
  }

  async function loadRoster() {
    const out = [];
    try {
      if (w.db && w.getDocs && w.collection && tenant()) {
        const snap = await w.getDocs(w.collection(w.db, 'companies', tenant(), 'subs'));
        snap.forEach((d) => { const s = d.data() || {}; if (s.active !== false && s.name) out.push({ id: d.id, name: String(s.name), trade: String(s.trade || '') }); });
      }
    } catch (e) { console.warn('[job-cost-audit] sub roster not loaded', e && e.code); }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  // Names paid before (subcontractor rows), most recent first, minus roster names.
  function pastPayees(expenses, roster) {
    const seen = {}; roster.forEach((r) => { seen[r.name.toLowerCase().replace(/\s+/g, ' ')] = true; });
    const rows = (expenses || []).filter((e) => e && e.category === 'subcontractor' && e.deleted !== true && e.supplier)
      .sort((a, b) => ((toDate(b.date) || 0) - (toDate(a.date) || 0)));
    const out = [];
    rows.forEach((e) => {
      const n = String(e.supplier).trim(); const k = n.toLowerCase().replace(/\s+/g, ' ');
      if (!k || seen[k]) return; seen[k] = true; out.push(n);
    });
    return out.slice(0, 8);
  }

  async function load() {
    const R = w.NBDRevenue;
    if (!R || typeof R.loadInvoices !== 'function') { toast('Collected money is not loaded yet. Try again in a moment.', 'warn'); return false; }
    const invs = await R.loadInvoices();
    // loadInvoices resolves [] when it could not ask yet or the read failed. That is
    // NOT "nothing collected": every job would read "costs but no payment".
    if (typeof R.cached === 'function' && !R.cached()) { toast('Could not load the invoices, so collected money is unknown. Nothing was changed. Try again in a moment.', 'warn'); return false; }
    const owed = {};
    (invs || []).forEach((inv) => { if (inv && inv.leadId && typeof R.owedDollarsOf === 'function') owed[inv.leadId] = (owed[inv.leadId] || 0) + Math.round((Number(R.owedDollarsOf(inv)) || 0) * 100); });
    const dollars = R.collectedByLead(invs || [], 0, FAR);
    const collected = {};
    Object.keys(dollars).forEach((k) => { collected[k] = Math.round(dollars[k] * 100); });
    const leads = (w._leads || []).filter((l) => l && l.id && !l.deleted && !l.isProspect);
    const audit = {};
    leads.forEach((l) => { audit[l.id] = copyAudit(l.costAudit); });
    const expenses = list().slice();
    const roster = await loadRoster();
    S = {
      leads, expenses, collected, owed, roster, audit, payees: pastPayees(expenses, roster),
      f: { group: 'all', phase: 'all', query: '', sort: 'worst', done: false },
      view: 'list', jobId: null, entry: null, voidId: null, hi: [], ask: null, confirmId: null, busy: false,
    };
    derive();
    return true;
  }

  // Marked complete AND the numbers have not moved since.
  function isDone(j) { return LG().isComplete(j.audit, LG().summarize(j.collectedCents, (S.by && S.by[j.id]) || [])); }

  // ── rows ────────────────────────────────────────────────────────────────
  function marginClass(m) { return m == null ? '' : m < 0 ? ' jc-m-bad' : m > LG().CONFIG.highMarginPct ? ' jc-m-hi' : ''; }
  function kindChips(s) {
    const L = LG();
    const parts = L.KINDS.filter((k) => s.byKind[k] > 0).map((k) => '<span class="jc-kind"><i>' + esc(L.KIND_LABEL[k]) + '</i> ' + money0(s.byKind[k]) + '</span>');
    return parts.length ? parts.join('') : '<span class="jc-kind jc-none">Nothing logged</span>';
  }
  function numsHtml(s) {
    return '<div class="jc-nums"><span><i>Collected</i><b>' + money0(s.collectedCents) + '</b></span><span><i>Costs</i><b>' + money0(s.directCents) +
      '</b></span><span><i>Margin</i><b class="jc-m' + marginClass(s.marginPct) + '">' + (s.marginPct == null ? '-' : s.marginPct + '%') + '</b></span></div>';
  }

  function rowHtml(r) {
    const L = LG();
    const why = r.flags.slice(0, 2).map((f) => '<li class="jc-sev-' + f.severity + '">' + esc(f.reason) + '</li>').join('') ||
      (r.groups.indexOf('no_sub') !== -1 ? '<li>No sub or labor cost is logged for this job.</li>' : '<li>No materials are logged for this job.</li>');
    return '<article class="jc-card" data-jc-row="' + esc(r.id) + '"><div class="jc-card-top"><div class="jc-name">' + esc(r.name) + '</div>' +
      '<span class="jc-tag">' + esc(PHASE_LABEL[r.phase] || '') + '</span></div>' + numsHtml(r.summary) +
      '<div class="jc-kinds">' + kindChips(r.summary) + (r.estimatedOnly ? '<span class="jc-kind jc-est">Estimated only</span>' : '') + '</div>' +
      '<ul class="jc-why">' + why + '</ul>' +
      '<div class="jc-act"><button type="button" class="jc-btn jc-primary" data-jc-action="open" data-jc-id="' + esc(r.id) + '">Fix costs</button>' +
      '<button type="button" class="jc-btn" data-jc-action="complete" data-jc-id="' + esc(r.id) + '">' + (S.confirmId === r.id ? 'Yes, costs are complete' : 'Costs complete') + '</button></div></article>';
  }

  function rowsHtml() {
    const L = LG();
    if (S.f.done) {
      const done = S.jobs.filter((j) => isDone(j));
      return done.length ? done.map((j) => '<article class="jc-card"><div class="jc-card-top"><div class="jc-name">' + esc(j.name) + '</div><span class="jc-tag">Complete</span></div>' +
        numsHtml(L.summarize(j.collectedCents, S.by[j.id] || [])) +
        '<div class="jc-act"><button type="button" class="jc-btn" data-jc-action="reopen" data-jc-id="' + esc(j.id) + '">Reopen</button></div></article>').join('')
        : '<div class="jc-empty">No jobs are marked complete yet.</div>';
    }
    const rows = L.filterRows(S.queue.rows, { group: S.f.group, phase: S.f.phase, query: S.f.query, sort: S.f.sort });
    if (!rows.length) {
      return '<div class="jc-empty">' + (S.queue.total ? 'Nothing matches that search or filter.' : 'Every job is checked. Nothing looks wrong.') + '</div>';
    }
    if (S.f.group !== 'all') return rows.map(rowHtml).join('');
    let h = '';
    L.GROUPS.forEach((g) => {
      const part = rows.filter((r) => r.primary === g.key);
      if (part.length) h += '<h4 class="jc-gh">' + esc(g.label) + ' <span class="jc-gc">' + part.length + '</span></h4>' + part.map(rowHtml).join('');
    });
    return h;
  }

  function listHtml() {
    const L = LG();
    const q = S.queue;
    const chip = (key, label, n) => '<button type="button" class="jc-chip" data-jc-action="group" data-jc-g="' + key + '" aria-pressed="' + (S.f.group === key && !S.f.done) + '">' + esc(label) + ' <b>' + n + '</b></button>';
    let chips = chip('all', 'All', q.total);
    L.GROUPS.forEach((g) => { if (q.counts[g.key]) chips += chip(g.key, g.label, q.counts[g.key]); });
    const opt = (v, label, cur) => '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
    return '<div class="jc-head"><h3 class="jc-title">Job cost audit</h3><button type="button" class="jc-x" data-jc-action="close" aria-label="Close">✕</button></div>' +
      '<p class="jc-lede"><b>' + q.total + '</b> job' + (q.total === 1 ? '' : 's') + ' to check. Crews are independent subs, so their pay is a job cost. Log it here and the margin becomes real.</p>' +
      '<div class="jc-tools"><input class="jc-in" type="search" data-jc-f="query" placeholder="Search by customer" aria-label="Search by customer" autocomplete="off" value="' + esc(S.f.query) + '">' +
      '<div class="jc-selects"><select class="jc-in" data-jc-f="sort" aria-label="Sort">' + opt('worst', 'Worst first', S.f.sort) + opt('collected', 'Most collected', S.f.sort) + opt('margin', 'Highest margin', S.f.sort) + opt('name', 'Name', S.f.sort) + '</select>' +
      '<select class="jc-in" data-jc-f="phase" aria-label="Job status">' + opt('all', 'All jobs', S.f.phase) + opt('finished', 'Finished', S.f.phase) + opt('production', 'In production', S.f.phase) + opt('signed', 'Signed', S.f.phase) + '</select></div></div>' +
      '<div class="jc-chips">' + chips + '</div>' +
      '<div class="jc-bar"><button type="button" class="jc-btn jc-primary" data-jc-action="ask-start"' + (q.total ? '' : ' disabled') + '>Ask me, one at a time</button>' +
      '<button type="button" class="jc-btn" data-jc-action="toggle-done" aria-pressed="' + S.f.done + '">' + (S.f.done ? 'Back to the queue' : 'Marked complete (' + S.doneCount + ')') + '</button></div>' +
      '<div id="jcRows">' + rowsHtml() + '</div>';
  }

  // ── job sheet ───────────────────────────────────────────────────────────
  function newEntry(typeKey) {
    return { typeKey: typeKey || 'sub_install', who: '', amount: '', pct: 0, estimated: false, date: ymd(new Date()), note: '' };
  }
  function jobCtx(id) {
    const j = S.jobById[id];
    const costs = S.by[id] || [];
    const L = LG();
    const s = L.summarize(j.collectedCents, costs);
    const flags = L.applyAcks(L.jobCostFlags(j, costs, S.peers), j.audit, s);
    const t = typeBy(S.entry.typeKey);
    const sug = t.kind === 'sub' ? L.suggest(S.peers, j.trade, { id: j.id, collectedCents: j.collectedCents, squares: j.squares }) : null;
    return { j, costs, s, flags, t, sug };
  }

  function estPromptHtml(jobId) {
    const p = S.estPrompt;
    if (!p || p.leadId !== jobId) return '';
    const cents = (S.by[jobId] || []).filter((e) => p.ids.indexOf(e.id) !== -1 && LG().isLiveDirect(e)).reduce((a, e) => a + LG().centsOf(e), 0);
    if (!cents) return '';
    return '<div class="jc-warnbox" role="status">This job also carries an estimate of ' + money(cents) + ' for the same work. Void it now that the real cost is in, or the two add up.' +
      '<div class="jc-act"><button type="button" class="jc-btn jc-primary" data-jc-action="est-void">Void the estimate</button><button type="button" class="jc-btn" data-jc-action="est-keep">Keep both</button></div></div>';
  }

  function flagCardsHtml(c) {
    const real = c.flags.filter((f) => f.severity !== 'info' || f.code === 'costs_no_payment');
    if (!real.length) return '';
    return '<div class="jc-sec"><h4 class="jc-h">Is this real or a mistake?</h4>' + real.map((f) =>
      '<div class="jc-flag jc-sev-' + f.severity + '"><div class="jc-flag-t">' + esc(f.title) + '</div><div class="jc-flag-r">' + esc(f.reason) + '</div>' +
      '<div class="jc-flag-b"><button type="button" class="jc-btn" data-jc-action="ack" data-jc-code="' + esc(f.code) + '">It\'s right</button>' +
      '<button type="button" class="jc-btn" data-jc-action="fix" data-jc-code="' + esc(f.code) + '">Mistake - fix</button>' +
      '<button type="button" class="jc-btn jc-primary" data-jc-action="add-missing" data-jc-code="' + esc(f.code) + '">Add missing cost</button></div></div>').join('') + '</div>';
  }

  function costRowsHtml(c) {
    const rows = (c.costs || []).filter((e) => LG().isLiveDirect(e)).sort((a, b) => ((toDate(b.date) || 0) - (toDate(a.date) || 0)));
    if (!rows.length) return '<div class="jc-empty">No costs are logged on this job.</div>';
    const me = uid();
    return '<ul class="jc-costs">' + rows.map((e) => {
      const d = toDate(e.date);
      const k = LG().KIND_LABEL[LG().kindOf(e)];
      const mine = e.userId === me;
      const hi = S.hi.indexOf(e.id) !== -1;
      let h = '<li class="jc-cost' + (hi ? ' jc-hi' : '') + '"><div class="jc-cost-main"><div class="jc-cost-top"><b>' + esc(e.supplier || k) + '</b><b>' + money(LG().centsOf(e)) + '</b></div>' +
        '<div class="jc-cost-sub">' + esc(k) + ' · ' + esc(d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'no date') +
        (e.estimated === true ? ' · <span class="jc-est">estimate</span>' : '') + (e.source === SOURCE ? ' · logged here' : '') + '</div></div>' +
        (mine ? '<button type="button" class="jc-btn jc-sm" data-jc-action="void-ask" data-jc-cid="' + esc(e.id) + '">Void</button>' : '<span class="jc-sub jc-other">Logged by someone else: fix it in Expenses</span>') + '</li>';
      if (S.voidId === e.id) {
        h += '<li class="jc-void"><label class="jc-lab" for="jcVoidNote">Why void it? (required)</label><input id="jcVoidNote" class="jc-in" type="text" maxlength="300" autocomplete="off" data-jc-f="voidnote">' +
          '<div class="jc-act"><button type="button" class="jc-btn jc-primary" data-jc-action="void-go">Void this cost</button><button type="button" class="jc-btn" data-jc-action="void-cancel">Cancel</button></div></li>';
      }
      return h;
    }).join('') + '</ul>';
  }

  function entryHtml(c, ask) {
    const E = S.entry, t = c.t, s = c.s, sug = c.sug;
    const names = S.roster.map((r) => r.name);
    const chipsWho = S.roster.map((r) => '<button type="button" class="jc-chip" data-jc-action="who" data-jc-name="' + esc(r.name) + '" aria-pressed="' + (E.who === r.name) + '">' + esc(r.name) + (r.trade ? ' <i>' + esc(r.trade) + '</i>' : '') + '</button>').join('') +
      S.payees.filter((n) => names.indexOf(n) === -1).map((n) => '<button type="button" class="jc-chip" data-jc-action="who" data-jc-name="' + esc(n) + '" aria-pressed="' + (E.who === n) + '">' + esc(n) + '</button>').join('');
    let h = '';
    if (!ask) {
      h += '<div class="jc-lab">What kind of cost?</div><div class="jc-chips" role="group" aria-label="Cost type">' +
        TYPES.map((x) => '<button type="button" class="jc-chip" data-jc-action="type" data-jc-t="' + x.key + '" aria-pressed="' + (E.typeKey === x.key) + '">' + esc(x.short) + '</button>').join('') + '</div>';
    }
    h += '<div class="jc-lab">Who did it?</div>' + (chipsWho ? '<div class="jc-chips" role="group" aria-label="Who did it">' + chipsWho + '</div>' : '') +
      '<input id="jcWho" class="jc-in" type="text" maxlength="120" autocomplete="off" data-jc-f="who" placeholder="' + (t.kind === 'sub' ? 'Crew or sub name' : 'Vendor (optional)') + '" value="' + esc(E.who) + '">';
    if (sug) {
      h += '<div class="jc-sug' + (sug.ok ? '' : ' jc-sug-none') + '" role="status">';
      if (!sug.ok) h += esc(sug.message);
      else {
        h += '<div>' + esc(sug.text) + '</div>';
        if (sug.noBase) h += '<div class="jc-sub">Nothing is collected on this job yet, so a percent cannot be turned into dollars.</div>';
        else h += '<div class="jc-sugb"><button type="button" class="jc-btn jc-sm" data-jc-action="use" data-jc-p="low">Use low ' + money0(sug.low.cents) + '</button>' +
          '<button type="button" class="jc-btn jc-sm" data-jc-action="use" data-jc-p="median">Use median ' + money0(sug.median.cents) + '</button>' +
          '<button type="button" class="jc-btn jc-sm" data-jc-action="use" data-jc-p="high">Use high ' + money0(sug.high.cents) + '</button></div>';
        if (sug.perSquare) h += '<div class="jc-sub">' + esc(sug.perSquare.text) + '</div><div class="jc-sugb"><button type="button" class="jc-btn jc-sm" data-jc-action="use" data-jc-p="persq">Use ' + money0(sug.perSquare.atMedianCents) + ' for this job</button></div>';
      }
      h += '</div>';
    }
    h += '<label class="jc-lab" for="jcAmount">Amount paid</label><input id="jcAmount" class="jc-in jc-big" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" data-jc-f="amount" value="' + esc(E.amount) + '">';
    if (s.collectedCents > 0) {
      h += '<label class="jc-lab" for="jcPct">Percent of the ' + money0(s.collectedCents) + ' collected: <b id="jcPctOut">' + E.pct + '%</b></label>' +
        '<input id="jcPct" class="jc-range" type="range" min="0" max="100" step="1" value="' + E.pct + '" data-jc-f="pct" aria-label="Percent of collected">';
    }
    h += '<label class="jc-check"><input type="checkbox" data-jc-f="estimated"' + (E.estimated ? ' checked' : '') + '><span>This is an estimate, not a real payment</span></label>' +
      '<button type="button" class="jc-btn" data-jc-action="estimate">Cost unknown - estimate</button>';
    if (!ask) {
      h += '<label class="jc-lab" for="jcDate">Date</label><input id="jcDate" class="jc-in" type="date" data-jc-f="date" value="' + esc(E.date) + '">' +
        '<label class="jc-lab" for="jcNote">Note (optional)</label><input id="jcNote" class="jc-in" type="text" maxlength="300" autocomplete="off" data-jc-f="note" value="' + esc(E.note) + '">';
    }
    return h + '<div class="jc-err" id="jcErr" role="alert"></div>';
  }

  function jobHtml() {
    const c = jobCtx(S.jobId);
    const j = c.j;
    const needsConfirm = S.confirmId === j.id;
    return '<div class="jc-head"><button type="button" class="jc-x" data-jc-action="back" aria-label="Back to the list">←</button>' +
      '<h3 class="jc-title">' + esc(j.name) + '</h3><button type="button" class="jc-x" data-jc-action="close" aria-label="Close">✕</button></div>' +
      '<div class="jc-sub">' + esc(PHASE_LABEL[j.phase] || '') + ' · ' + esc(j.trade === 'general' ? 'no trade set' : j.trade.replace(/\+/g, ' + ')) + '</div>' + numsHtml(c.s) +
      '<div class="jc-kinds">' + kindChips(c.s) + '</div>' + estPromptHtml(j.id) + flagCardsHtml(c) +
      '<div class="jc-sec"><h4 class="jc-h">Costs on this job</h4>' + costRowsHtml(c) + '</div>' +
      '<div class="jc-sec" id="jcEntry"><h4 class="jc-h">Add a cost</h4>' + entryHtml(c, false) +
      '<button type="button" class="jc-btn jc-primary jc-wide" data-jc-action="save">Save cost</button></div>' +
      '<div class="jc-act"><button type="button" class="jc-btn" data-jc-action="complete" data-jc-id="' + esc(j.id) + '">' + (needsConfirm ? 'Yes, costs are complete' : 'Costs complete') + '</button>' +
      '<button type="button" class="jc-btn" data-jc-action="back">Done</button></div>' +
      (needsConfirm ? '<div class="jc-warnbox" role="status">This job still has things to check. Tap again to mark it complete anyway.</div>' : '');
  }

  // ── ask me ──────────────────────────────────────────────────────────────
  function askState() {
    // The next job (from the current position) that still has a question.
    const L = LG();
    while (S.ask.i < S.ask.ids.length) {
      const id = S.ask.ids[S.ask.i];
      const j = S.jobById[id];
      if (j && !isDone(j)) {
        const s = L.summarize(j.collectedCents, S.by[id] || []);
        const q = L.nextQuestion(s, j.audit);
        if (q) return { j, q, s };
      }
      S.ask.i++;
    }
    return null;
  }
  function askHtml() {
    const st = askState();
    if (!st) return null;
    const j = st.j, q = st.q;
    if (S.entry.forQ !== q.key + ':' + j.id) { S.entry = newEntry(QTYPE[q.key] || 'other'); S.entry.forQ = q.key + ':' + j.id; }
    const c = jobCtx(j.id);
    let h = '<div class="jc-head"><h3 class="jc-title">Ask me</h3><button type="button" class="jc-x" data-jc-action="ask-stop" aria-label="Stop asking">✕</button></div>' +
      '<div class="jc-sub">Job ' + (S.ask.i + 1) + ' of ' + S.ask.ids.length + ' · ' + esc(PHASE_LABEL[j.phase] || '') + '</div>' +
      '<div class="jc-qname">' + esc(j.name) + '</div>' + numsHtml(c.s) + '<div class="jc-q">' + esc(q.text) + '</div>';
    if (q.key !== 'materials') h += entryHtml(c, true) + '<button type="button" class="jc-btn jc-primary jc-wide" data-jc-action="ask-save">Save and next</button>';
    else h += '<p class="jc-sub">Receipts come in through the receipt sorter or Log Expense. If everything is in, say so and this stops asking.</p>';
    h += '<div class="jc-asks"><button type="button" class="jc-btn" data-jc-action="ask-answer" data-jc-a="skip">Skip</button>' +
      '<button type="button" class="jc-btn" data-jc-action="ask-answer" data-jc-a="na">' + (q.key === 'materials' ? 'Yes, all in' : 'Not applicable') + '</button>' +
      '<button type="button" class="jc-btn" data-jc-action="ask-answer" data-jc-a="unsure">Unsure</button></div>';
    return h;
  }

  // ── rendering ───────────────────────────────────────────────────────────
  function overlay() {
    let m = document.getElementById('jcOverlay');
    if (!m) {
      m = document.createElement('div'); m.id = 'jcOverlay'; m.className = 'jc-overlay';
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Job cost audit');
      document.body.appendChild(m);
    }
    return m;
  }
  function render() {
    if (!S) return;
    const m = overlay();
    let body;
    if (S.view === 'ask') {
      body = askHtml();
      if (body == null) { S.view = 'list'; S.ask = null; toast('That was the last question', 'ok'); body = listHtml(); }
    } else if (S.view === 'job' && S.jobById[S.jobId]) body = jobHtml();
    else { S.view = 'list'; body = listHtml(); }
    m.innerHTML = '<div class="jc-sheet">' + body + '</div>';
  }
  function close() {
    const m = document.getElementById('jcOverlay'); if (m) m.remove();
    const changed = S && S.changed;
    S = null;
    if (changed && w.Expenses && typeof w.Expenses.refresh === 'function') w.Expenses.refresh();
  }

  // ── writes ──────────────────────────────────────────────────────────────
  function setPath(obj, path, val) {
    const p = path.split('.'); let o = obj;
    for (let i = 0; i < p.length - 1; i++) { o[p[i]] = o[p[i]] && typeof o[p[i]] === 'object' ? o[p[i]] : {}; o = o[p[i]]; }
    o[p[p.length - 1]] = val;
  }
  async function setAudit(leadId, patch, localPatch) {
    if (!w.updateDoc || !w.doc || !w.db) { toast('Not connected. Try again.', 'error'); return false; }
    const data = {};
    Object.keys(patch).forEach((k) => { data['costAudit.' + k] = patch[k]; });
    data['costAudit.updatedBy'] = uid();
    data['costAudit.updatedAt'] = w.serverTimestamp ? w.serverTimestamp() : new Date();
    try { await w.updateDoc(w.doc(w.db, 'leads', leadId), data); }
    catch (e) { console.warn('[job-cost-audit] could not save the audit note', e && e.code); toast('Could not save that. Nothing changed.', 'error'); return false; }
    const mirror = Object.assign({}, patch, localPatch || {});
    const a = copyAudit(S ? S.audit[leadId] : ((w._leads || []).find((l) => l && l.id === leadId) || {}).costAudit);
    Object.keys(mirror).forEach((k) => setPath(a, k, mirror[k]));
    if (S) S.audit[leadId] = a;
    // The CRM keeps its lead objects for the session; keep the note there too so a
    // second open of this panel does not lose it.
    const lead = (w._leads || []).find((l) => l && l.id === leadId);
    if (lead) lead.costAudit = copyAudit(a);
    return true;
  }
  function logEntry(what, note) { return { at: Date.now(), by: uid(), what, source: LOG_SOURCE, note: String(note || '').slice(0, 300) }; }
  function appendLog(prev, entry) { const b = Array.isArray(prev) ? prev.slice() : []; b.push(entry); return b.slice(-MAX_LOG); }
  function jobIdFor(leadId) {
    const l = S.leads.find((x) => x.id === leadId);
    const j = l && l.activeJobId;
    return typeof j === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(j) ? j : null;
  }

  // The form -> an /expenses doc (no timestamps). { error } when it cannot be saved.
  function buildCost(entry, leadId, ctx) {
    const t = typeBy(entry.typeKey);
    const who = String(entry.who || '').trim().slice(0, 120);
    if (t.kind === 'sub' && !who) return { error: 'Who did it? Pick a crew or type a name.' };
    const cents = parseCents(entry.amount);
    if (cents <= 0) return { error: 'Enter an amount greater than $0' };
    if (cents > MAX_CENTS) return { error: 'That amount is too large' };
    const d = entry.date ? new Date(entry.date + 'T00:00:00') : new Date();
    if (isNaN(d.getTime())) return { error: 'Pick a valid date' };
    const rosterHit = (ctx.roster || []).find((r) => r.name.toLowerCase() === who.toLowerCase());
    const fields = {
      leadId: leadId, jobId: ctx.jobIdFor ? ctx.jobIdFor(leadId) : null,
      category: t.category, costType: 'direct', auditKind: t.kind, auditType: t.key,
      supplier: who || t.label, amountCents: cents, taxCents: 0, date: d,
      note: String(entry.note || '').trim().slice(0, 300), estimated: entry.estimated === true,
    };
    if (rosterHit) fields.subId = rosterHit.id;
    return { fields };
  }

  function readDom() {
    // The inputs keep S.entry current as they change (input handler); this is the
    // safety net for a value set by autofill without an event.
    if (!S || !S.entry) return;
    const v = (id) => { const el = document.getElementById(id); return el ? el.value : null; };
    const a = v('jcAmount'), who = v('jcWho'), d = v('jcDate'), n = v('jcNote');
    if (a != null) S.entry.amount = a; if (who != null) S.entry.who = who; if (d != null) S.entry.date = d; if (n != null) S.entry.note = n;
  }
  const showErr = (m) => { const el = document.getElementById('jcErr'); if (el) el.textContent = m; };

  async function saveCost(leadId, then) {
    if (S.busy) return false;
    readDom();
    const built = buildCost(S.entry, leadId, { roster: S.roster, jobIdFor });
    if (built.error) { showErr(built.error); return false; }
    if (!w.db || !w.addDoc || !w.collection || !w.serverTimestamp) { showErr('Not connected. Try again.'); return false; }
    const me = uid();
    const doc = Object.assign({}, built.fields, {
      userId: me, companyId: claims().companyId || me, source: SOURCE, needsReview: false,
      editLog: [logEntry('create', built.fields.estimated ? 'estimate' : '')],
      createdAt: w.serverTimestamp(), createdBy: me, updatedAt: w.serverTimestamp(),
    });
    const st = S;
    // Estimates of the same work already on this job (voided on request when a
    // REAL cost for it arrives).
    const L = LG();
    const estIds = built.fields.estimated !== true && L.kindOf(built.fields) === 'sub'
      ? S.expenses.filter((e) => e && e.leadId === leadId && e.estimated === true && L.isLiveDirect(e) && L.kindOf(e) === 'sub').map((e) => e.id) : [];
    S.busy = true;
    try {
      const ref = await w.addDoc(w.collection(w.db, 'expenses'), doc);
      if (S !== st) { if (w.Expenses && typeof w.Expenses.refresh === 'function') w.Expenses.refresh(); return true; }
      const local = Object.assign({}, built.fields, { id: ref && ref.id, userId: me, source: SOURCE, editLog: doc.editLog });
      S.expenses.push(local);
      S.estPrompt = estIds.length ? { leadId, ids: estIds } : null;
      S.changed = true;
      if (built.fields.category === 'subcontractor' && S.payees.indexOf(built.fields.supplier) === -1 && !S.roster.some((r) => r.name === built.fields.supplier)) S.payees.unshift(built.fields.supplier);
    } catch (e) {
      console.warn('[job-cost-audit] cost not saved', e && e.code);
      if (S === st) { S.busy = false; showErr('Could not save. Nothing changed.'); }
      return false;
    }
    S.busy = false;
    derive();
    toast(built.fields.estimated ? 'Estimate saved' : 'Cost saved', 'ok');
    if (then) then();
    return true;
  }

  // Void one of the user's own rows: deleted:true AND deletedAt, the row kept with its note.
  async function voidRow(row, note) {
    try {
      await w.updateDoc(w.doc(w.db, 'expenses', row.id), {
        deleted: true, deletedAt: w.serverTimestamp(),
        editLog: appendLog(row.editLog, logEntry('void', note)), updatedAt: w.serverTimestamp(),
      });
    } catch (e) { console.warn('[job-cost-audit] void failed', e && e.code); toast('Could not void that. Nothing changed.', 'error'); return false; }
    if (S) { S.expenses = S.expenses.filter((e) => e.id !== row.id); S.changed = true; }
    return true;
  }
  async function voidCost(id) {
    const row = S.expenses.find((e) => e && e.id === id);
    const note = String((document.getElementById('jcVoidNote') || {}).value || '').trim();
    if (!row || row.userId !== uid()) return;
    if (!note) { toast('Say why you are voiding it.', 'warn'); return; }
    if (!(await voidRow(row, note)) || !S) return;
    S.voidId = null;
    derive(); toast('Cost voided', 'ok'); render();
  }
  // A real sub cost arrived and the job still carries an estimate for the same
  // work: offer to void it, so the two do not add up.
  async function voidEstimates() {
    const p = S.estPrompt; S.estPrompt = null;
    if (!p) return;
    let n = 0, others = 0;
    for (const id of p.ids) {
      const row = S && S.expenses.find((e) => e && e.id === id);
      if (!row) continue;
      if (row.userId !== uid()) { others++; continue; }
      if (await voidRow(row, 'Replaced by the real cost')) n++;
    }
    if (!S) return;
    derive();
    toast(n ? 'Estimate voided' + (others ? '. ' + others + ' more were logged by someone else: fix them in Expenses.' : '') : 'The estimate was logged by someone else: fix it in Expenses.', n ? 'ok' : 'warn');
    render();
  }

  // ── actions ─────────────────────────────────────────────────────────────
  function openJob(id, typeKey) {
    if (!S.jobById[id]) return;
    S.view = 'job'; S.jobId = id; S.entry = newEntry(typeKey); S.voidId = null; S.hi = []; S.confirmId = null;
    render();
    const m = document.getElementById('jcOverlay'); if (m) m.scrollTop = 0;
  }
  function useSuggestion(which) {
    const c = jobCtx(S.jobId);
    const sug = c.sug; if (!sug || !sug.ok) return;
    let cents = 0;
    if (which === 'persq') cents = sug.perSquare ? sug.perSquare.atMedianCents : 0;
    else cents = sug[which] ? sug[which].cents : 0;
    if (cents > 0) setAmountCents(cents);
  }
  function setAmountCents(cents) {
    const j = currentJob();
    S.entry.amount = (cents / 100).toFixed(2);
    S.entry.pct = j && j.collectedCents > 0 ? Math.min(100, Math.round(cents / j.collectedCents * 100)) : 0;
    const a = document.getElementById('jcAmount'); if (a) a.value = S.entry.amount;
    const r = document.getElementById('jcPct'); if (r) r.value = S.entry.pct;
    const o = document.getElementById('jcPctOut'); if (o) o.textContent = S.entry.pct + '%';
  }
  function currentJob() { return S.view === 'ask' ? S.jobById[S.ask.ids[S.ask.i]] : S.jobById[S.jobId]; }

  async function complete(id) {
    const j = S.jobById[id]; if (!j) return;
    const row = LG().auditRow(Object.assign({}, j, { audit: Object.assign({}, j.audit, { complete: false }) }), S.by[id] || [], S.peers);
    if (row && S.confirmId !== id) { S.confirmId = id; render(); return; }
    const sig = LG().signature(LG().summarize(j.collectedCents, S.by[id] || []));
    if (!(await setAudit(id, { complete: true, completeBy: uid(), completeSig: sig, completeAt: w.serverTimestamp ? w.serverTimestamp() : new Date() }, { completeAt: Date.now() })) || !S) return;
    S.confirmId = null; S.changed = true;
    derive(); toast('Marked costs complete', 'ok');
    if (S.view === 'job') S.view = 'list';
    render();
  }

  async function answer(a) {
    const st = askState(); if (!st) return;
    if (!(await setAudit(st.j.id, { ['asked.' + st.q.key]: LG().askedValue(a, st.s) })) || !S) return;
    derive(); render();
  }

  function onClick(ev) {
    if (!S) return;
    const t = ev.target && ev.target.closest && ev.target.closest('[data-jc-action]');
    if (!t || t.disabled) return;
    const a = t.dataset.jcAction;
    const id = t.dataset.jcId;
    if (a === 'close') close();
    else if (a === 'back') { S.view = 'list'; S.confirmId = null; render(); }
    else if (a === 'open') openJob(id);
    else if (a === 'group') { S.f.group = t.dataset.jcG; S.f.done = false; render(); }
    else if (a === 'toggle-done') { S.f.done = !S.f.done; render(); }
    else if (a === 'complete') complete(id);
    else if (a === 'reopen') { setAudit(id, { complete: false }).then((ok) => { if (ok) { derive(); S.changed = true; render(); } }); }
    else if (a === 'type') { readDom(); S.entry.typeKey = t.dataset.jcT; render(); }
    else if (a === 'who') { readDom(); S.entry.who = t.dataset.jcName; render(); }
    else if (a === 'use') useSuggestion(t.dataset.jcP);
    else if (a === 'estimate') {
      readDom();
      S.entry.estimated = true;
      const c = jobCtx(currentJob().id);
      if (c.sug && c.sug.ok && !c.sug.noBase && !parseCents(S.entry.amount)) S.entry.amount = (c.sug.median.cents / 100).toFixed(2);
      render();
      const el = document.getElementById('jcAmount'); if (el && el.focus) el.focus();
    }
    else if (a === 'save') saveCost(S.jobId, () => { S.entry.amount = ''; S.entry.pct = 0; S.entry.note = ''; S.entry.estimated = false; render(); });
    else if (a === 'ack') {
      const c = jobCtx(S.jobId);
      setAudit(S.jobId, { ['ack.' + t.dataset.jcCode]: LG().signature(c.s) }).then((ok) => { if (ok) { derive(); render(); } });
    }
    else if (a === 'fix') {
      const c = jobCtx(S.jobId);
      const f = c.flags.find((x) => x.code === t.dataset.jcCode);
      S.hi = (f && f.ids) || [];
      render();
      toast('Tap Void on the wrong cost, then add the right one below.', 'info');
    }
    else if (a === 'add-missing') {
      const code = t.dataset.jcCode;
      const sub = ['high_margin_no_sub', 'margin_above_peers', 'sub_exceeds_collected', 'negative_margin'].indexOf(code) !== -1;
      S.entry = newEntry(sub ? 'sub_install' : 'other'); render();
      const e = document.getElementById('jcEntry'); if (e && e.scrollIntoView) e.scrollIntoView({ block: 'start' });
    }
    else if (a === 'est-void') voidEstimates();
    else if (a === 'est-keep') { S.estPrompt = null; render(); }
    else if (a === 'void-ask') { S.voidId = t.dataset.jcCid; render(); }
    else if (a === 'void-cancel') { S.voidId = null; render(); }
    else if (a === 'void-go') voidCost(S.voidId);
    else if (a === 'ask-start') {
      const rows = LG().filterRows(S.queue.rows, { group: S.f.group, phase: S.f.phase, query: S.f.query, sort: S.f.sort });
      S.ask = { ids: rows.map((r) => r.id), i: 0 }; S.view = 'ask'; S.entry = newEntry('sub_install'); render();
    }
    else if (a === 'ask-stop') { S.view = 'list'; S.ask = null; render(); }
    else if (a === 'ask-answer') answer(t.dataset.jcA);
    else if (a === 'ask-save') {
      const st = askState(); if (!st) return;
      saveCost(st.j.id, () => { S.entry = newEntry('sub_install'); render(); });
    }
  }

  function onInput(ev) {
    if (!S) return;
    const el = ev.target;
    const f = el && el.dataset && el.dataset.jcF;
    if (!f) return;
    if (f === 'query') { S.f.query = el.value; const r = document.getElementById('jcRows'); if (r) r.innerHTML = rowsHtml(); return; }
    if (f === 'sort' || f === 'phase') { S.f[f] = el.value; const r = document.getElementById('jcRows'); if (r) r.innerHTML = rowsHtml(); return; }
    if (!S.entry) return;
    if (f === 'amount') {
      S.entry.amount = el.value;
      const j = currentJob(); const cents = parseCents(el.value);
      S.entry.pct = j && j.collectedCents > 0 ? Math.min(100, Math.round(cents / j.collectedCents * 100)) : 0;
      const r = document.getElementById('jcPct'); if (r) r.value = S.entry.pct;
      const o = document.getElementById('jcPctOut'); if (o) o.textContent = S.entry.pct + '%';
    } else if (f === 'pct') {
      const j = currentJob(); S.entry.pct = Number(el.value) || 0;
      if (j && j.collectedCents > 0) setAmountCents(Math.round(j.collectedCents * S.entry.pct / 100));
    } else if (f === 'estimated') S.entry.estimated = !!el.checked;
    else if (f === 'who') S.entry.who = el.value;
    else if (f === 'date') S.entry.date = el.value;
    else if (f === 'note') S.entry.note = el.value;
  }

  if (typeof document !== 'undefined' && !w._NBD_JC_DELEGATE) {
    w._NBD_JC_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      const t = ev.target && ev.target.closest && ev.target.closest('[data-jc-open]');
      if (t) { open(); return; }
      onClick(ev);
    });
    document.addEventListener('input', onInput);
    document.addEventListener('change', (ev) => { const el = ev.target; if (el && el.dataset && el.dataset.jcF === 'estimated') onInput(ev); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.getElementById('jcOverlay')) close(); });
  }

  // The flags load a moment after boot. When they arrive and Expenses is already on
  // screen, draw it again so the button and card appear without a manual reload.
  if (typeof w.addEventListener === 'function' && !w._NBD_JC_FLAGS) {
    w._NBD_JC_FLAGS = true;
    w.addEventListener('nbd:flags-loaded', () => {
      if (!on() || !w.Expenses || typeof w.Expenses.render !== 'function' || typeof w.Expenses.list !== 'function') return;
      if (typeof document !== 'undefined' && document.getElementById('jcPanel')) return;
      if (w.Expenses.list().length) w.Expenses.render();
    });
  }

  async function open() {
    if (!on()) return;
    if (!(await load())) return;
    render();
  }

  // The Expenses-page card: a count when the invoices are already loaded, else
  // just the button. Never throws; renders nothing when off.
  function panelHtml() {
    if (!on()) return '';
    return '<div class="ui-card jc-panel" id="jcPanel"><div class="jc-head"><h3 class="jc-title">Job cost audit</h3>' +
      '<button type="button" class="btn btn-orange jc-open" data-jc-open="1">Check job costs</button></div>' +
      '<div class="jc-sub">Finds finished jobs with no sub or labor cost logged and margins that look too good, then helps you fill them in.</div></div>';
  }
  function buttonHtml() {
    if (!on()) return '';
    return '<button type="button" class="btn btn-ghost" data-jc-open="1" title="Find jobs with missing sub and labor costs">🔎 Job cost audit</button>';
  }

  w.NBDJobCostAuditor = { enabled, canWrite, open, panelHtml, buttonHtml, buildCost, parseCents, TYPES, SOURCE };
})();
